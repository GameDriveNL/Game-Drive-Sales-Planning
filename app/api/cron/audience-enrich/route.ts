/**
 * GET /api/cron/audience-enrich
 *
 * Fills in audience signals on coverage_items where we know the
 * creator/channel/handle but lack a subscriber/follower count. Without
 * this number the noise_detector can't fire the `low_audience` flag — and
 * that's the biggest noise category (96% of Bram's tier-E filler).
 *
 * Strategy per source_type:
 *   youtube → Innertube getChannel(channel_id) → subscriber_count
 *   twitch  → Helix /users + /channels/followers → total followers
 *   tiktok  → already stalk-fetched at insert; skip
 *
 * Updates source_metadata.subscribers + monthly_unique_visitors atomically.
 * Then triggers re-classification by clearing noise_classified_at so the
 * noise-backfill cron re-evaluates the row's noise_flags on its next pass.
 *
 * Cost: $0. Innertube + Helix are free.
 *
 * Auth: Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { verifyCronAuth } from '@/lib/cron-auth'
import { Innertube } from 'youtubei.js'
import { recordScannerError } from '@/lib/scanner-errors'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

// Per-run cap. With 600 channels at ~0.5s each = 300s. Run frequency
// (every 4h) gives 6 runs/day = 3,600 channels/day enrichment capacity,
// enough to clear ~10K channels in ~3 days.
const CHANNELS_PER_RUN = 400
const HELIX_USERS_PER_RUN = 200

interface ChannelStats { subs: number | null }

let _yt: Innertube | null = null
async function getYT(): Promise<Innertube> {
  if (_yt) return _yt
  _yt = await Innertube.create({ lang: 'en', generate_session_locally: true })
  return _yt
}

async function fetchYTSubs(channelId: string): Promise<ChannelStats> {
  try {
    const yt = await getYT()
    const ch = await yt.getChannel(channelId)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const md = (ch as any).metadata || {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hdr = (ch as any).header || {}
    const subText = hdr?.subscriber_count?.text || md?.subscriber_count?.text || ''
    return { subs: parseSubText(subText) }
  } catch {
    return { subs: null }
  }
}

function parseSubText(t: string): number | null {
  if (!t) return null
  // Examples: "1.2M subscribers", "523K subscribers", "8,250 subscribers"
  const m = t.match(/([\d.,]+)\s*([KMB])?/i)
  if (!m) return null
  let n = Number(m[1].replace(/,/g, ''))
  if (isNaN(n)) return null
  const suffix = (m[2] || '').toUpperCase()
  if (suffix === 'K') n *= 1_000
  else if (suffix === 'M') n *= 1_000_000
  else if (suffix === 'B') n *= 1_000_000_000
  return Math.round(n)
}

// Token cache for Helix
let _tt: { token: string; expiresAt: number } | null = null
async function helixToken(cid: string, cs: string): Promise<string> {
  if (_tt && _tt.expiresAt > Date.now() + 60_000) return _tt.token
  const r = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: cid, client_secret: cs, grant_type: 'client_credentials' }),
  })
  if (!r.ok) throw new Error(`Twitch OAuth ${r.status}`)
  const d = await r.json() as { access_token: string; expires_in: number }
  _tt = { token: d.access_token, expiresAt: Date.now() + d.expires_in * 1000 }
  return d.access_token
}

async function fetchTwitchUserFollowers(cid: string, cs: string, login: string): Promise<number | null> {
  try {
    const token = await helixToken(cid, cs)
    // Step 1: login → user_id
    const u = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`, {
      headers: { 'Client-Id': cid, Authorization: `Bearer ${token}` },
    })
    if (!u.ok) return null
    const uj = await u.json() as { data?: Array<{ id?: string }> }
    const uid = uj.data?.[0]?.id
    if (!uid) return null
    // Step 2: user_id → follower total
    const f = await fetch(`https://api.twitch.tv/helix/channels/followers?broadcaster_id=${uid}&first=1`, {
      headers: { 'Client-Id': cid, Authorization: `Bearer ${token}` },
    })
    if (!f.ok) return null
    const fj = await f.json() as { total?: number }
    return typeof fj.total === 'number' ? fj.total : null
  } catch {
    return null
  }
}

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request)
  if (authError) return authError

  const supabase = getServerSupabase()
  const t0 = Date.now()

  let ytEnriched = 0, ytFailed = 0
  let twEnriched = 0, twFailed = 0

  // ─── YouTube: distinct channel_ids missing audience ────────────────────
  const { data: ytRows } = await supabase
    .from('coverage_items')
    .select('source_metadata')
    .eq('source_type', 'youtube')
    .or('monthly_unique_visitors.is.null,monthly_unique_visitors.eq.0')
    .limit(20_000)
  const ytChannels = new Set<string>()
  for (const r of (ytRows || []) as Array<{ source_metadata: { channel_id?: string } | null }>) {
    const cid = r.source_metadata?.channel_id
    if (cid && cid.startsWith('UC')) ytChannels.add(cid)
  }
  const ytChannelList = Array.from(ytChannels).slice(0, CHANNELS_PER_RUN)
  // Batch concurrent fetches
  for (let i = 0; i < ytChannelList.length; i += 8) {
    if (Date.now() - t0 > 150_000) break
    const batch = ytChannelList.slice(i, i + 8)
    const results = await Promise.all(batch.map(async (cid) => ({ cid, stats: await fetchYTSubs(cid) })))
    for (const { cid, stats } of results) {
      if (stats.subs === null) { ytFailed++; continue }
      ytEnriched++
      // Update every coverage_item with this channel_id. Use raw SQL update
      // via supabase: filter by source_metadata->>channel_id then patch.
      const { error } = await supabase.rpc('update_yt_channel_audience', {
        p_channel_id: cid, p_subs: stats.subs,
      }).single()
      // Fallback if RPC not present: do via .update() with .filter()
      if (error) {
        await supabase
          .from('coverage_items')
          .update({
            monthly_unique_visitors: stats.subs,
            noise_classified_at: null,  // trigger re-classification
          })
          .eq('source_type', 'youtube')
          .filter('source_metadata->>channel_id', 'eq', cid)
      }
    }
  }

  // ─── Twitch: distinct logins missing follower count ────────────────────
  const cid = process.env.TWITCH_CLIENT_ID
  const cs = process.env.TWITCH_CLIENT_SECRET
  if (cid && cs) {
    const { data: twRows } = await supabase
      .from('coverage_items')
      .select('source_metadata')
      .eq('source_type', 'twitch')
      .or('monthly_unique_visitors.is.null,monthly_unique_visitors.eq.0')
      .limit(20_000)
    const twLogins = new Set<string>()
    for (const r of (twRows || []) as Array<{ source_metadata: { channel_login?: string } | null }>) {
      const login = r.source_metadata?.channel_login
      if (login) twLogins.add(login.toLowerCase())
    }
    const twLoginList = Array.from(twLogins).slice(0, HELIX_USERS_PER_RUN)
    for (let i = 0; i < twLoginList.length; i += 5) {
      if (Date.now() - t0 > 280_000) break
      const batch = twLoginList.slice(i, i + 5)
      const results = await Promise.all(batch.map(async (login) => ({
        login, followers: await fetchTwitchUserFollowers(cid, cs, login),
      })))
      for (const { login, followers } of results) {
        if (followers === null) {
          twFailed++
          await recordScannerError(supabase, {
            scanner: 'audience-enrich',
            target: `twitch:${login}`,
            category: 'fetch_error',
            message: 'Helix follower lookup returned null',
          })
          continue
        }
        twEnriched++
        await supabase
          .from('coverage_items')
          .update({
            monthly_unique_visitors: followers,
            noise_classified_at: null,
          })
          .eq('source_type', 'twitch')
          .filter('source_metadata->>channel_login', 'eq', login)
      }
    }
  }

  return NextResponse.json({
    message: `Audience enrich: +${ytEnriched} YT channels (${ytFailed} failed), +${twEnriched} Twitch logins (${twFailed} failed)`,
    youtube: { enriched: ytEnriched, failed: ytFailed, channels_remaining: Math.max(0, ytChannels.size - ytChannelList.length) },
    twitch:  { enriched: twEnriched, failed: twFailed },
    ms: Date.now() - t0,
  })
}
