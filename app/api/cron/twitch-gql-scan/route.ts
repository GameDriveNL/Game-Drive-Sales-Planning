/**
 * GET /api/cron/twitch-gql-scan
 *
 * Free Twitch coverage discovery via Twitch's unauthenticated GraphQL endpoint.
 * Runs alongside the SullyGnome-via-Apify scanner. Three queries per game:
 *   - resolveGameId by name (cached in game's coverage_sources twitch config
 *     after first run so we don't repeat it)
 *   - getRecentVODs (recently-streamed sessions, past 14-60 days)
 *   - getTopClips (most-viewed clips this week)
 *
 * Cost: $0. Free, no Apify, no quota.
 *
 * Auth: Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { verifyCronAuth } from '@/lib/cron-auth'
import { resolveGameId, getVODs, getTopClips, getLiveStreams } from '@/lib/twitch-gql'
import { fanoutBroadcasters } from '@/lib/twitch-gql-fanout'
import { detectOutletCountry } from '@/lib/outlet-country'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

// Two passes per game per run:
//   - TIME pass catches the long-tail of small streamers (their VODs are
//     pushed off Twitch's TIME-sorted list within hours by newer streamers)
//   - VIEWS pass catches the headline streamers (ironmouse, Shoto, etc.)
//     whose VODs would never make the TIME cut today but are still relevant
// Empirically: TIME alone hit only 3/31 of Bram's ≥100K-follower streamers.
const VODS_BY_TIME_PER_GAME = 100
const VODS_BY_VIEWS_PER_GAME = 100
const CLIPS_PER_GAME = 50

interface GameRow {
  id: string
  name: string
  client_id: string
}

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request)
  if (authError) return authError

  const supabase = getServerSupabase()

  const { data: games } = await supabase
    .from('games')
    .select('id, name, client_id')
    .eq('pr_tracking_enabled', true)
  if (!games || games.length === 0) {
    return NextResponse.json({ message: 'No PR-tracked games' })
  }

  // Existing URL set for dedup (channel-level we use twitch.tv/<login> keys;
  // VOD URLs are twitch.tv/videos/<id>; clip URLs are channel/clip/<slug>)
  const { data: existing } = await supabase
    .from('coverage_items')
    .select('url')
    .like('url', '%twitch.tv%')
    .limit(10000)
  const existingUrls = new Set((existing || []).map((r: { url: string }) => r.url))

  const results: Array<{
    game: string; twitch_game_id: string | null;
    vods_found: number; vods_inserted: number;
    clips_found: number; clips_inserted: number;
    live_found: number; live_inserted: number;
    errors: string[];
  }> = []

  for (const game of games as GameRow[]) {
    const r: typeof results[number] = {
      game: game.name, twitch_game_id: null,
      vods_found: 0, vods_inserted: 0,
      clips_found: 0, clips_inserted: 0,
      live_found: 0, live_inserted: 0,
      errors: [],
    }

    // Look up cached twitch game ID on the game's twitch coverage_source config
    const { data: twitchSrc } = await supabase
      .from('coverage_sources')
      .select('id, config')
      .eq('game_id', game.id)
      .eq('source_type', 'twitch')
      .maybeSingle()
    let twitchGameId: string | null = twitchSrc?.config?.twitch_game_id ?? null

    if (!twitchGameId) {
      try {
        // Try DB game.name first, then each whitelist keyword as alias —
        // games like "WWH Tomorrow" are listed on Twitch as
        // "We Were Here Tomorrow", and the keyword set already has both.
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
          twitchGameId = await resolveGameId(candidate)
          if (twitchGameId) break
        }
        // Cache it back to the source config so we don't pay this lookup again.
        if (twitchGameId && twitchSrc?.id) {
          await supabase
            .from('coverage_sources')
            .update({
              config: { ...(twitchSrc.config || {}), twitch_game_id: twitchGameId },
              updated_at: new Date().toISOString(),
            })
            .eq('id', twitchSrc.id)
        }
      } catch (err) {
        r.errors.push(`resolveGameId: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    r.twitch_game_id = twitchGameId
    if (!twitchGameId) {
      results.push(r)
      continue
    }

    // Twitch outlet (one per streamer channel). Look up/create as we go.
    const findOrCreateChannelOutlet = async (login: string, displayName: string, followers: number | null): Promise<string | null> => {
      const domain = `twitch.tv/${login}`
      const { data: o } = await supabase.from('outlets').select('id').eq('domain', domain).maybeSingle()
      if (o?.id) return o.id
      const { data: newO } = await supabase.from('outlets').insert({
        name: displayName || login,
        domain,
        country: detectOutletCountry(domain),
        monthly_unique_visitors: followers || null,
        tier: followers && followers >= 100000 ? 'B' : followers && followers >= 10000 ? 'C' : 'D',
        is_active: true,
      }).select('id').single()
      return newO?.id ?? null
    }

    // VODs — two passes: newest by TIME (long-tail) + most-viewed by VIEWS (top streamers)
    try {
      const [byTime, byViews] = await Promise.all([
        getVODs(twitchGameId, VODS_BY_TIME_PER_GAME, 'TIME'),
        getVODs(twitchGameId, VODS_BY_VIEWS_PER_GAME, 'VIEWS'),
      ])
      const byId = new Map<string, typeof byTime[number]>()
      for (const v of [...byTime, ...byViews]) byId.set(v.id, v)
      const vods = Array.from(byId.values())
      r.vods_found = vods.length
      for (const v of vods) {
        if (existingUrls.has(v.url)) continue
        existingUrls.add(v.url)
        const outletId = await findOrCreateChannelOutlet(v.channel.login, v.channel.displayName, v.channel.followers)
        const publishDate = v.publishedAt || v.createdAt
        const { error } = await supabase.from('coverage_items').insert({
          client_id: game.client_id,
          game_id: game.id,
          outlet_id: outletId,
          title: v.title,
          url: v.url,
          publish_date: publishDate ? publishDate.split('T')[0] : null,
          coverage_type: 'stream',
          monthly_unique_visitors: v.channel.followers,
          source_type: 'twitch',
          source_metadata: {
            twitch_vod_id: v.id,
            channel_login: v.channel.login,
            channel_display_name: v.channel.displayName,
            channel_followers: v.channel.followers,
            view_count: v.viewCount,
            length_seconds: v.lengthSeconds,
            twitch_gql: true,
          },
          approval_status: 'pending_review',
          discovered_at: new Date().toISOString(),
        })
        if (!error) r.vods_inserted++
      }
    } catch (err) {
      r.errors.push(`vods: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Live streams — catches big streamers as they're broadcasting NOW.
    // Without this we miss any streamer whose VOD is deleted or whose
    // game-page view count doesn't make the VIEWS-sorted top-100 cut.
    // Same captures as snapshot: the channel as a coverage_item.
    try {
      const live = await getLiveStreams(twitchGameId, 100)
      r.live_found = live.length
      for (const s of live) {
        const channelUrl = `https://www.twitch.tv/${s.channelLogin}`
        if (existingUrls.has(channelUrl)) continue
        existingUrls.add(channelUrl)
        const outletId = await findOrCreateChannelOutlet(s.channelLogin, s.channelDisplayName, null)
        const { error } = await supabase.from('coverage_items').insert({
          client_id: game.client_id,
          game_id: game.id,
          outlet_id: outletId,
          title: s.title || `${s.channelDisplayName} streaming ${game.name}`,
          url: channelUrl,
          publish_date: s.startedAt ? s.startedAt.split('T')[0] : null,
          coverage_type: 'stream',
          source_type: 'twitch',
          source_metadata: {
            channel_login: s.channelLogin,
            channel_display_name: s.channelDisplayName,
            channel_id: s.channelId,
            viewers: s.viewers,
            started_at: s.startedAt,
            twitch_gql: true,
            twitch_gql_kind: 'live',
          },
          approval_status: 'pending_review',
          discovered_at: new Date().toISOString(),
        })
        if (!error) r.live_inserted++
      }
    } catch (err) {
      r.errors.push(`live: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Fanout — language × period × sort enumeration via gql-fanout lib.
    // The integrity check only fires on page 2+; by enumerating distinct
    // page-1s across ~150 combos we surface long-tail broadcasters the
    // TIME/VIEWS sort misses. Runs ~3s, free. New 2026-06-01.
    try {
      const fan = await fanoutBroadcasters(twitchGameId, game.name, { maxConcurrency: 30 })
      for (const b of Array.from(fan.values())) {
        const channelUrl = `https://www.twitch.tv/${b.login}`
        if (existingUrls.has(channelUrl)) continue
        existingUrls.add(channelUrl)
        const outletId = await findOrCreateChannelOutlet(b.login, b.displayName || b.login, null)
        const itemUrl = b.videoOrClipId
          ? (b.source === 'clip'
              ? `https://www.twitch.tv/${b.login}/clip/${b.videoOrClipId}`
              : `https://www.twitch.tv/videos/${b.videoOrClipId}`)
          : channelUrl
        if (existingUrls.has(itemUrl)) continue
        existingUrls.add(itemUrl)
        const { error } = await supabase.from('coverage_items').insert({
          client_id: game.client_id,
          game_id: game.id,
          outlet_id: outletId,
          title: b.title || `${b.displayName || b.login} streamed ${game.name}`,
          url: itemUrl,
          publish_date: b.createdAt ? b.createdAt.split('T')[0] : null,
          coverage_type: 'stream',
          monthly_unique_visitors: typeof b.viewCount === 'number' ? b.viewCount : null,
          source_type: 'twitch',
          source_metadata: {
            twitch_gql: true,
            twitch_gql_kind: 'fanout',
            channel_login: b.login,
            channel_display_name: b.displayName,
            fanout_source: b.source,
            fanout_signal: b.signal,
            view_count: b.viewCount,
          },
          approval_status: 'pending_review',
          discovered_at: new Date().toISOString(),
        })
        if (!error) {
          // Count as a clip insert for reporting purposes — keeps the existing
          // schema unchanged. They're functionally similar (channel-level).
          r.clips_inserted++
          r.clips_found++
        }
      }
    } catch (err) {
      r.errors.push(`fanout: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Clips (existing TopClips query — kept as the curated "popular this week" pass)
    try {
      const clips = await getTopClips(twitchGameId, 7, CLIPS_PER_GAME)
      r.clips_found = clips.length
      for (const c of clips) {
        if (existingUrls.has(c.url)) continue
        existingUrls.add(c.url)
        const outletId = await findOrCreateChannelOutlet(c.broadcaster.login, c.broadcaster.displayName, null)
        const { error } = await supabase.from('coverage_items').insert({
          client_id: game.client_id,
          game_id: game.id,
          outlet_id: outletId,
          title: c.title,
          url: c.url,
          publish_date: c.createdAt ? c.createdAt.split('T')[0] : null,
          coverage_type: 'stream',
          source_type: 'twitch',
          source_metadata: {
            twitch_clip_slug: c.slug,
            channel_login: c.broadcaster.login,
            channel_display_name: c.broadcaster.displayName,
            view_count: c.viewCount,
            duration_seconds: c.durationSeconds,
            twitch_gql: true,
            twitch_gql_kind: 'clip',
          },
          approval_status: 'pending_review',
          discovered_at: new Date().toISOString(),
        })
        if (!error) r.clips_inserted++
      }
    } catch (err) {
      r.errors.push(`clips: ${err instanceof Error ? err.message : String(err)}`)
    }

    results.push(r)
  }

  const totalInserted = results.reduce((s, r) => s + r.vods_inserted + r.clips_inserted + r.live_inserted, 0)
  return NextResponse.json({
    message: `Twitch GQL scan complete: +${totalInserted} new items across ${results.length} games`,
    games_scanned: results.length,
    total_new: totalInserted,
    results,
  })
}
