/**
 * GET /api/cron/creator-graph-expand
 *
 * The forward-discovery graph grows when we INGEST a new creator's coverage.
 * This cron actively EXPANDS the graph by cross-referencing the platforms
 * known creators link to each other.
 *
 * Runs every 4 hours. For each PR-tracked game:
 *   1. Pick up to 100 recent YouTube videos (high MUV first, then by recency)
 *   2. Fetch each video's FULL description via Innertube getVideoDescription
 *   3. Regex out twitch.tv/<login>, tiktok.com/@<handle>, x.com/<handle>
 *   4. For any handle we haven't seen, insert a placeholder coverage_item so
 *      downstream pollers (twitch-streams-poll, tiktok-profile-poll) pick it
 *      up in their next cycle
 *
 * This is the "I found a small creator we missed" pipeline — the kind of
 * coverage Bram's tool catches because his manual review notices the
 * link-tree-of-creators effect. We automate it.
 *
 * Cost: $0. Innertube + regex.
 *
 * Auth: Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { verifyCronAuth } from '@/lib/cron-auth'
import { detectOutletCountry } from '@/lib/outlet-country'
import { getVideoDescription } from '@/lib/youtube-innertube'
import { extractTwitchLogins } from '@/lib/piped-youtube'
import { extractTikTokHandles, stalkTikTokUser, classifyTier } from '@/lib/tiktok-stalk'
import { recordScannerError } from '@/lib/scanner-errors'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

// Reserved twitter handles we don't want to record as creators
const TWITTER_RESERVED = new Set(['home', 'explore', 'i', 'login', 'signup', 'about', 'jobs'])

function extractTwitterHandles(text: string): string[] {
  const out = new Set<string>()
  const re = /(?:x\.com|twitter\.com)\/([a-z0-9_]{2,15})\b/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const h = m[1].toLowerCase()
    if (TWITTER_RESERVED.has(h)) continue
    out.add(h)
  }
  return Array.from(out)
}

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request)
  if (authError) return authError

  const supabase = getServerSupabase()
  const t0 = Date.now()

  const { data: games } = await supabase
    .from('games').select('id, name, client_id').eq('pr_tracking_enabled', true)
  if (!games || games.length === 0) {
    return NextResponse.json({ message: 'No PR-tracked games' })
  }

  let totalVideosScanned = 0
  let twitchHandlesAdded = 0
  let tiktokHandlesAdded = 0
  let twitterHandlesAdded = 0
  const errors: string[] = []
  const perGame: Array<{
    game: string; videos: number; tw: number; tt: number; tw_x: number
  }> = []

  for (const game of games) {
    if (Date.now() - t0 > 270_000) {
      errors.push('global time budget reached')
      break
    }

    // Existing handles per game for dedup
    const { data: existing } = await supabase
      .from('coverage_items')
      .select('url, source_metadata, source_type')
      .eq('game_id', game.id)
      .limit(50000)
    const existingTwitch = new Set<string>()
    const existingTiktok = new Set<string>()
    const existingTwitter = new Set<string>()
    for (const r of (existing || []) as Array<{ url: string; source_metadata: { handle?: string; channel_login?: string } | null; source_type: string }>) {
      if (r.source_type === 'twitch') {
        const m = r.url.match(/twitch\.tv\/([a-z0-9_]+)/i)
        if (m) existingTwitch.add(m[1].toLowerCase())
        if (r.source_metadata?.channel_login) existingTwitch.add(r.source_metadata.channel_login.toLowerCase())
      } else if (r.source_type === 'tiktok') {
        const m = r.url.match(/tiktok\.com\/@([\w.-]+)/i)
        if (m) existingTiktok.add(m[1].toLowerCase())
        if (r.source_metadata?.handle) existingTiktok.add(r.source_metadata.handle.toLowerCase())
      } else if (r.source_type === 'twitter') {
        const m = r.url.match(/(?:x\.com|twitter\.com)\/([a-z0-9_]+)/i)
        if (m) existingTwitter.add(m[1].toLowerCase())
      }
    }

    // Pick up to 100 YouTube videos to mine — prioritise by view count
    // (high-MUV creators are likeliest to maintain real cross-platform
    // link trees) then by recency.
    const { data: ytItems } = await supabase
      .from('coverage_items')
      .select('source_metadata, monthly_unique_visitors')
      .eq('game_id', game.id)
      .eq('source_type', 'youtube')
      .order('monthly_unique_visitors', { ascending: false, nullsFirst: false })
      .limit(150)
    const videoIds: string[] = (ytItems || [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map(it => (it.source_metadata as any)?.video_id)
      .filter((id): id is string => typeof id === 'string')
      .slice(0, 100)

    if (videoIds.length === 0) {
      perGame.push({ game: game.name, videos: 0, tw: 0, tt: 0, tw_x: 0 })
      continue
    }

    const twNew = new Set<string>()
    const ttNew = new Set<string>()
    const twxNew = new Set<string>()
    let videosScanned = 0

    for (let i = 0; i < videoIds.length; i += 10) {
      if (Date.now() - t0 > 250_000) break
      const batch = videoIds.slice(i, i + 10)
      const descs = await Promise.all(batch.map(async (id) => {
        try {
          return await getVideoDescription(id)
        } catch (err) {
          await recordScannerError(supabase, {
            scanner: 'creator-graph-expand',
            target: `youtube:${id}`,
            game_id: game.id,
            category: 'fetch_error',
            message: err instanceof Error ? err.message : String(err),
          })
          return ''
        }
      }))
      for (const desc of descs) {
        if (!desc) continue
        videosScanned++
        for (const h of extractTwitchLogins(desc)) {
          if (!existingTwitch.has(h)) twNew.add(h)
        }
        for (const h of extractTikTokHandles(desc)) {
          if (!existingTiktok.has(h)) ttNew.add(h)
        }
        for (const h of extractTwitterHandles(desc)) {
          if (!existingTwitter.has(h)) twxNew.add(h)
        }
      }
    }
    totalVideosScanned += videosScanned

    // Outlet helper — caches per-domain
    const outletCache = new Map<string, string | null>()
    const ensureOutlet = async (domain: string, name: string, muv: number | null, tier: string): Promise<string | null> => {
      const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').toLowerCase()
      if (outletCache.has(cleanDomain)) return outletCache.get(cleanDomain)!
      const { data: o } = await supabase.from('outlets').select('id').eq('domain', cleanDomain).maybeSingle()
      if (o?.id) { outletCache.set(cleanDomain, o.id); return o.id }
      const { data: newO } = await supabase.from('outlets').insert({
        name, domain: cleanDomain,
        country: detectOutletCountry(cleanDomain),
        monthly_unique_visitors: muv, tier, is_active: true,
      }).select('id').single()
      const id = newO?.id ?? null
      outletCache.set(cleanDomain, id)
      return id
    }

    // Insert placeholder coverage_item per new Twitch handle so downstream
    // twitch-streams-poll picks it up via channel_login dedup-set on its next
    // cycle. Marked WEAK (pending_review) because we only have indirect proof.
    for (const login of Array.from(twNew)) {
      const url = `https://www.twitch.tv/${login}`
      const oid = await ensureOutlet(`twitch.tv/${login}`, login, null, 'D')
      const { error } = await supabase.from('coverage_items').insert({
        client_id: game.client_id, game_id: game.id, outlet_id: oid,
        title: `${login} — discovered via YouTube description cross-reference`,
        url,
        publish_date: null,
        coverage_type: 'stream', source_type: 'twitch',
        source_metadata: {
          discovery: 'creator_graph_expand',
          via_yt_description_xref: true,
          channel_login: login,
          confidence_tier: 'WEAK',
          confidence_reason: 'discovered indirectly via creator description xref',
          match_location: 'description',
        },
        approval_status: 'pending_review',
        discovered_at: new Date().toISOString(),
      })
      if (!error) twitchHandlesAdded++
    }
    // Same for TikTok. We stalk-verify each handle so we get follower
    // count + tier classification before insert (StalkUser is free).
    for (const handle of Array.from(ttNew)) {
      const stalk = await stalkTikTokUser(handle).catch(() => null)
      if (!stalk) continue
      const tier = classifyTier(stalk.followerCount)
      const oid = await ensureOutlet(`tiktok.com/@${handle}`, stalk.displayName, stalk.followerCount, tier)
      const { error } = await supabase.from('coverage_items').insert({
        client_id: game.client_id, game_id: game.id, outlet_id: oid,
        title: `${stalk.displayName} — discovered via YouTube cross-reference`,
        url: `https://www.tiktok.com/@${handle}`,
        publish_date: null,
        coverage_type: 'video', source_type: 'tiktok',
        monthly_unique_visitors: stalk.followerCount,
        source_metadata: {
          discovery: 'creator_graph_expand',
          via_yt_description_xref: true,
          handle,
          followers_at_discovery: stalk.followerCount,
          is_verified: stalk.isVerified,
          confidence_tier: 'WEAK',
          confidence_reason: 'discovered indirectly via creator description xref',
          match_location: 'description',
        },
        approval_status: 'pending_review',
        discovered_at: new Date().toISOString(),
      })
      if (!error) tiktokHandlesAdded++
    }
    // Twitter handles — insert as placeholder; we don't have a Twitter
    // verification scraper yet (paid X API), but record for future use.
    for (const handle of Array.from(twxNew)) {
      const oid = await ensureOutlet(`x.com/${handle}`, handle, null, 'D')
      const { error } = await supabase.from('coverage_items').insert({
        client_id: game.client_id, game_id: game.id, outlet_id: oid,
        title: `${handle} — discovered via YouTube cross-reference`,
        url: `https://x.com/${handle}`,
        publish_date: null,
        coverage_type: 'mention', source_type: 'twitter',
        source_metadata: {
          discovery: 'creator_graph_expand',
          via_yt_description_xref: true,
          handle,
          confidence_tier: 'WEAK',
          confidence_reason: 'discovered indirectly via creator description xref',
          match_location: 'description',
        },
        approval_status: 'pending_review',
        discovered_at: new Date().toISOString(),
      })
      if (!error) twitterHandlesAdded++
    }

    perGame.push({
      game: game.name,
      videos: videosScanned,
      tw: twNew.size, tt: ttNew.size, tw_x: twxNew.size,
    })
  }

  return NextResponse.json({
    message: `Creator-graph expand: scanned ${totalVideosScanned} descriptions, +${twitchHandlesAdded} Twitch / +${tiktokHandlesAdded} TikTok / +${twitterHandlesAdded} Twitter handles`,
    total_videos_scanned: totalVideosScanned,
    twitch_handles_added: twitchHandlesAdded,
    tiktok_handles_added: tiktokHandlesAdded,
    twitter_handles_added: twitterHandlesAdded,
    per_game: perGame,
    ms: Date.now() - t0,
    errors,
  })
}
