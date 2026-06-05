/**
 * GET /api/cron/twitch-streams-poll
 *
 * High-frequency Twitch /streams polling — the forward-parity backbone.
 *
 * Runs every 5 minutes. For each PR-tracked game with a known twitch_game_id,
 * hits Helix `/streams?game_id=X&first=100` and persists every broadcaster
 * who's currently live for that game. Over 30 days, accumulates a complete
 * roster of every streamer who ever went live for the game (assuming each
 * goes live for ≥5 min, which is true for ~99% of streams).
 *
 * Why this matters: Twitch deletes Affiliate VODs after 14 days. By the time
 * a daily scan catches a stream, the VOD is often gone. 5-min polling catches
 * the stream at the moment it's live — same mechanism SullyGnome/Streams
 * Charts use to build their historical databases. Free, uses the existing
 * Twitch keys.
 *
 * Rate budget: 7 games × 1 call each = 7 calls per 5 min = 84/hour = 2,016/day.
 * Helix gives us 800 points/minute (each call = 1 point), so we're at 0.087
 * points/min — vast headroom.
 *
 * Auth: Bearer CRON_SECRET.
 * Cost: $0.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { verifyCronAuth } from '@/lib/cron-auth'
import { detectOutletCountry } from '@/lib/outlet-country'
import { resolveGameId as resolveTwitchGameId } from '@/lib/twitch-gql'
import { detectNoise } from '@/lib/noise-detector'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

interface HelixStream {
  id: string
  user_id: string
  user_login: string
  user_name: string
  game_id: string
  type: string
  title: string
  viewer_count: number
  started_at: string
  language: string
}

// Token cache (process-local — survives between cron invocations within
// the same Vercel function container; fine to re-fetch if cold).
let cachedToken: { token: string; expiresAt: number } | null = null
async function getAppToken(cid: string, cs: string): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: cid, client_secret: cs, grant_type: 'client_credentials',
    }),
  })
  if (!res.ok) throw new Error(`Twitch OAuth ${res.status}`)
  const data = await res.json() as { access_token: string; expires_in: number }
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
  }
  return data.access_token
}

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request)
  if (authError) return authError

  const cid = process.env.TWITCH_CLIENT_ID
  const cs = process.env.TWITCH_CLIENT_SECRET
  if (!cid || !cs) {
    return NextResponse.json({ error: 'TWITCH_CLIENT_ID/SECRET missing' }, { status: 500 })
  }

  const supabase = getServerSupabase()

  // PR-tracked games with their cached twitch_game_id (resolved by other crons)
  const { data: games } = await supabase
    .from('games')
    .select('id, name, client_id')
    .eq('pr_tracking_enabled', true)
  if (!games || games.length === 0) {
    return NextResponse.json({ message: 'No PR-tracked games' })
  }

  // Get cached twitch_game_id from each game's twitch coverage_source.config
  const { data: srcRows } = await supabase
    .from('coverage_sources')
    .select('game_id, config')
    .eq('source_type', 'twitch')
    .in('game_id', games.map(g => g.id))
  const gameIdToTwitchId = new Map<string, string>()
  for (const row of (srcRows || []) as Array<{ game_id: string; config: { twitch_game_id?: string } }>) {
    if (row.config?.twitch_game_id) gameIdToTwitchId.set(row.game_id, row.config.twitch_game_id)
  }

  // Existing twitch.tv/<login> URLs per game for dedup. One round-trip rather
  // than per-broadcaster lookup.
  const { data: existing } = await supabase
    .from('coverage_items')
    .select('url, game_id')
    .like('url', '%twitch.tv/%')
    .in('game_id', games.map(g => g.id))
    .limit(50000)
  const existingByGame = new Map<string, Set<string>>()
  for (const r of (existing || []) as Array<{ url: string; game_id: string }>) {
    if (!existingByGame.has(r.game_id)) existingByGame.set(r.game_id, new Set())
    existingByGame.get(r.game_id)!.add(r.url)
  }

  const token = await getAppToken(cid, cs)
  const results: Array<{
    game: string
    twitch_game_id: string | null
    live: number
    inserted: number
    error?: string
  }> = []

  // Outlet helper — caches across all games in this run
  const outletCache = new Map<string, string | null>()
  async function ensureChannelOutlet(login: string, displayName: string, viewers: number | null): Promise<string | null> {
    const domain = `twitch.tv/${login}`
    if (outletCache.has(domain)) return outletCache.get(domain)!
    const { data: o } = await supabase.from('outlets').select('id').eq('domain', domain).maybeSingle()
    if (o?.id) { outletCache.set(domain, o.id); return o.id }
    const { data: newO } = await supabase.from('outlets').insert({
      name: displayName || login,
      domain,
      country: detectOutletCountry(domain),
      monthly_unique_visitors: null,  // Followers unknown from /streams; let downstream scanners enrich
      tier: viewers && viewers >= 10000 ? 'C' : 'D',  // Best-effort initial tier from current viewers
      is_active: true,
    }).select('id').single()
    const id = newO?.id ?? null
    outletCache.set(domain, id)
    return id
  }

  for (const game of games as Array<{ id: string; name: string; client_id: string }>) {
    let twitchGameId = gameIdToTwitchId.get(game.id) || null
    // Fallback: resolve via GQL. Twitch often categorises games by the FULL
    // marketing title (e.g. "We Were Here Tomorrow"), while our DB stores
    // shorthand ("WWH Tomorrow"). Try each whitelist keyword as a candidate
    // game name — the first hit wins. Caches the result to coverage_sources
    // so subsequent runs skip the lookup.
    if (!twitchGameId) {
      const { data: kwRows } = await supabase
        .from('coverage_keywords')
        .select('keyword')
        .eq('game_id', game.id)
        .eq('keyword_type', 'whitelist')
        .eq('is_active', true)
      const candidateNames = Array.from(new Set([
        game.name,
        ...(kwRows || []).map((k: { keyword: string }) => k.keyword),
      ]))
      for (const candidate of candidateNames) {
        try {
          const id = await resolveTwitchGameId(candidate)
          if (id) { twitchGameId = id; break }
        } catch { /* try next */ }
      }
      if (twitchGameId) {
        // Upsert coverage_sources row to cache the lookup
        const { data: existingSrc } = await supabase
          .from('coverage_sources')
          .select('id, config')
          .eq('game_id', game.id)
          .eq('source_type', 'twitch')
          .maybeSingle()
        if (existingSrc?.id) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const config = { ...(existingSrc.config as any || {}), twitch_game_id: twitchGameId }
          await supabase.from('coverage_sources')
            .update({ config, updated_at: new Date().toISOString() })
            .eq('id', existingSrc.id)
        } else {
          await supabase.from('coverage_sources').insert({
            game_id: game.id,
            source_type: 'twitch',
            name: `Twitch — ${game.name}`,
            config: { twitch_game_id: twitchGameId },
            scan_frequency: 'every_6h',
            is_active: true,
          })
        }
      } else {
        // Game probably not in Twitch's catalog (small/new indies). Mark and skip.
        results.push({ game: game.name, twitch_game_id: null, live: 0, inserted: 0, error: 'Twitch GQL has no game with that name' })
        continue
      }
    }

    try {
      const r = await fetch(
        `https://api.twitch.tv/helix/streams?game_id=${twitchGameId}&first=100`,
        { headers: { 'Client-Id': cid, Authorization: `Bearer ${token}` } },
      )
      if (!r.ok) {
        results.push({ game: game.name, twitch_game_id: twitchGameId, live: 0, inserted: 0, error: `Helix ${r.status}` })
        continue
      }
      const j = await r.json() as { data?: HelixStream[] }
      const live = j.data || []
      const existingSet = existingByGame.get(game.id) ?? new Set<string>()
      let inserted = 0

      for (const s of live) {
        const channelUrl = `https://www.twitch.tv/${s.user_login}`
        if (existingSet.has(channelUrl)) continue
        existingSet.add(channelUrl)
        const noise = detectNoise({
          title: s.title || '',
          description: '',
          audienceViews: s.viewer_count,
          sourceType: 'twitch',
        })
        const oid = await ensureChannelOutlet(s.user_login, s.user_name, s.viewer_count)
        const { error } = await supabase.from('coverage_items').insert({
          client_id: game.client_id,
          game_id: game.id,
          outlet_id: oid,
          title: s.title || `${s.user_name} live`,
          url: channelUrl,
          publish_date: s.started_at.split('T')[0],
          coverage_type: 'stream',
          source_type: 'twitch',
          monthly_unique_visitors: s.viewer_count,
          source_metadata: {
            discovery: 'forward_poll',
            twitch_streams_poll: true,
            channel_login: s.user_login,
            channel_display_name: s.user_name,
            channel_id: s.user_id,
            viewers_at_discovery: s.viewer_count,
            stream_id: s.id,
            stream_type: s.type,
            language: s.language,
            started_at: s.started_at,
            discovered_at_iso: new Date().toISOString(),
          },
          approval_status: 'pending_review',
          discovered_at: new Date().toISOString(),
          noise_flags: noise.flags,
          noise_classified_at: new Date().toISOString(),
        })
        if (!error) inserted++
      }
      results.push({ game: game.name, twitch_game_id: twitchGameId, live: live.length, inserted })
    } catch (err) {
      results.push({
        game: game.name, twitch_game_id: twitchGameId, live: 0, inserted: 0,
        error: err instanceof Error ? err.message.substring(0, 100) : String(err).substring(0, 100),
      })
    }
  }

  const totalInserted = results.reduce((s, r) => s + r.inserted, 0)
  const totalLive = results.reduce((s, r) => s + r.live, 0)
  return NextResponse.json({
    message: `Twitch streams poll: +${totalInserted} new of ${totalLive} live across ${results.length} games`,
    total_inserted: totalInserted,
    total_live: totalLive,
    results,
  })
}
