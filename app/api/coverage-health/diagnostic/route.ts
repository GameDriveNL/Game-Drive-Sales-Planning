/**
 * GET /api/coverage-health/diagnostic
 *
 * Read-only diagnostic endpoint. Exposes the state we need to verify the
 * scanner stack is healthy WITHOUT revealing any secrets. Safe to hit
 * unauthenticated (the middleware passes /api/coverage-health/* through).
 *
 * Returns:
 *   - which env vars are set (boolean only, never the values)
 *   - apify per-platform flag state
 *   - apify_remaining_usd (best-effort; if Apify key works, this shows the
 *     real number, which is the smoking gun for "is the quota issue resolved")
 *   - recent activity counts per source_type (last 24h)
 *   - last-run timestamp on each platform's per-game source row
 */

import { NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { checkApifyCredits } from '@/lib/apify-utils'
import { searchVideos } from '@/lib/youtube-data-api'
import { getGameByName, getAllVideos, getAllStreams, getAllClips } from '@/lib/twitch-helix'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  const supabase = getServerSupabase()

  // 1. Env presence (boolean only)
  const env = {
    YOUTUBE_DATA_API_KEY: !!process.env.YOUTUBE_DATA_API_KEY,
    TWITCH_CLIENT_ID: !!process.env.TWITCH_CLIENT_ID,
    TWITCH_CLIENT_SECRET: !!process.env.TWITCH_CLIENT_SECRET,
    TAVILY_API_KEY: !!process.env.TAVILY_API_KEY,
    GOOGLE_AI_API_KEY: !!process.env.GOOGLE_AI_API_KEY,
    CRON_SECRET: !!process.env.CRON_SECRET,
    NEXT_PUBLIC_SUPABASE_URL: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
  }

  // 2. Apify settings
  const { data: apifySettings } = await supabase
    .from('service_settings')
    .select('key, value')
    .like('key', 'apify%')
  const apify: Record<string, unknown> = {}
  for (const row of apifySettings || []) apify[row.key] = row.value

  // 2b. YouTube Data API live test — proves the key works without waiting
  // for the daily cron. One search.list call costs 100 units out of 10K/day.
  let youtubeLive: { works: boolean; sample_videos_found: number | null; error: string | null } | null = null
  if (process.env.YOUTUBE_DATA_API_KEY) {
    try {
      const sample = await searchVideos(process.env.YOUTUBE_DATA_API_KEY, {
        query: 'Dark Pals',
        maxResults: 5,
      })
      youtubeLive = {
        works: sample.items.length > 0,
        sample_videos_found: sample.items.length,
        error: sample.items.length === 0 ? 'Key call returned 0 results — could be a quota/perms issue' : null,
      }
    } catch (err) {
      youtubeLive = {
        works: false,
        sample_videos_found: null,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  } else {
    youtubeLive = { works: false, sample_videos_found: null, error: 'YOUTUBE_DATA_API_KEY not in env' }
  }

  // 2c. Twitch Helix live test — proves Client ID + Secret are valid and
  // returns results from real game-directory queries. Tests multiple param
  // combinations because Helix's behavior is inconsistent across sort/period
  // combos.
  let twitchLive: {
    works: boolean;
    sample_streamers_found: number | null;
    twitch_game_id_for_dark_pals: string | null;
    error: string | null;
    debug?: Record<string, number | string>;
  } | null = null
  if (process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET) {
    try {
      const game = await getGameByName(
        process.env.TWITCH_CLIENT_ID,
        process.env.TWITCH_CLIENT_SECRET,
        'Dark Pals: The 1st Floor'
      )
      if (game) {
        // Probe Helix endpoints across video/stream/clip + a known-popular
        // control game (Just Chatting = 509658) to distinguish auth issues
        // from Twitch's known game_id index gaps.
        const debug: Record<string, number | string> = {}
        const CID = process.env.TWITCH_CLIENT_ID
        const CS = process.env.TWITCH_CLIENT_SECRET

        // Dark Pals tests
        try {
          const s = await getAllStreams(CID, CS, game.id, 2)
          debug['darkpals_streams_live'] = s.length
        } catch (e) { debug['darkpals_streams_live'] = `ERR ${e instanceof Error ? e.message.substring(0,60) : ''}` }
        try {
          const c = await getAllClips(CID, CS, game.id, {
            startedAt: new Date(Date.now() - 30*86400000).toISOString(),
            endedAt: new Date().toISOString(),
            maxPages: 2,
          })
          debug['darkpals_clips_30d'] = c.length
        } catch (e) { debug['darkpals_clips_30d'] = `ERR ${e instanceof Error ? e.message.substring(0,60) : ''}` }
        try {
          const v = await getAllVideos(CID, CS, game.id, { sort: 'time', period: 'month', maxPages: 1 })
          debug['darkpals_videos_month_time'] = v.length
        } catch (e) { debug['darkpals_videos_month_time'] = `ERR ${e instanceof Error ? e.message.substring(0,60) : ''}` }

        // Control: Just Chatting (huge directory, should return tons)
        try {
          const s = await getAllStreams(CID, CS, '509658', 1)
          debug['justchatting_streams_live'] = s.length
        } catch (e) { debug['justchatting_streams_live'] = `ERR ${e instanceof Error ? e.message.substring(0,60) : ''}` }
        try {
          const v = await getAllVideos(CID, CS, '509658', { sort: 'time', period: 'day', maxPages: 1 })
          debug['justchatting_videos_day'] = v.length
        } catch (e) { debug['justchatting_videos_day'] = `ERR ${e instanceof Error ? e.message.substring(0,60) : ''}` }

        const total = Object.values(debug)
          .filter((v): v is number => typeof v === 'number')
          .reduce((s, v) => s + v, 0)
        twitchLive = {
          works: total > 0,
          sample_streamers_found: total,
          twitch_game_id_for_dark_pals: game.id,
          error: total === 0 ? 'No Helix endpoint returned data — auth or indexing issue' : null,
          debug,
        }
      } else {
        twitchLive = { works: false, sample_streamers_found: null, twitch_game_id_for_dark_pals: null, error: 'Twitch game lookup returned null' }
      }
    } catch (err) {
      twitchLive = {
        works: false,
        sample_streamers_found: null,
        twitch_game_id_for_dark_pals: null,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  } else {
    twitchLive = { works: false, sample_streamers_found: null, twitch_game_id_for_dark_pals: null, error: 'TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET not in env' }
  }

  // 3. Apify live credit check
  let apifyLive: { remaining_usd: number | null; has_credits: boolean; error: string | null } | null = null
  try {
    const { data: keyData } = await supabase
      .from('service_api_keys')
      .select('api_key')
      .eq('service_name', 'apify')
      .eq('is_active', true)
      .maybeSingle()
    if (keyData?.api_key) {
      const check = await checkApifyCredits(keyData.api_key, 0.01)
      apifyLive = {
        remaining_usd: check.remainingUsd,
        has_credits: check.hasCredits,
        error: check.error,
      }
    } else {
      apifyLive = { remaining_usd: null, has_credits: false, error: 'no API key in service_api_keys' }
    }
  } catch (err) {
    apifyLive = { remaining_usd: null, has_credits: false, error: err instanceof Error ? err.message : String(err) }
  }

  // 4. Last 24h ingest by source_type
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data: ingestRows } = await supabase
    .from('coverage_items')
    .select('source_type, source_metadata')
    .gte('discovered_at', since)
    .limit(20000)
  const ingest24h: Record<string, { total: number; via_subscanner: Record<string, number> }> = {}
  for (const r of ingestRows || []) {
    const st = r.source_type || '(null)'
    if (!ingest24h[st]) ingest24h[st] = { total: 0, via_subscanner: {} }
    ingest24h[st].total++
    const meta = r.source_metadata as Record<string, unknown> | null
    if (meta) {
      for (const flag of ['youtube_data_api', 'twitch_gql', 'reddit_public_api', 'manual_import', 'wayback', 'backfill', 'cross_game_seed']) {
        if (meta[flag] === true) {
          ingest24h[st].via_subscanner[flag] = (ingest24h[st].via_subscanner[flag] || 0) + 1
        }
      }
    }
  }

  // 5. Per-platform source health (last_run_at and recent statuses)
  const { data: sourceHealth } = await supabase
    .from('coverage_sources')
    .select('source_type, last_run_at, last_run_status, last_run_message')
    .in('source_type', ['tiktok', 'instagram', 'twitter', 'youtube', 'twitch', 'reddit', 'sullygnome', 'tavily', 'rss'])
    .eq('is_active', true)
  const sourcesByType: Record<string, {
    total_active: number;
    most_recent_run: string | null;
    recent_statuses: Record<string, number>;
  }> = {}
  for (const s of sourceHealth || []) {
    const st = s.source_type
    if (!sourcesByType[st]) sourcesByType[st] = { total_active: 0, most_recent_run: null, recent_statuses: {} }
    sourcesByType[st].total_active++
    if (s.last_run_at && (!sourcesByType[st].most_recent_run || s.last_run_at > sourcesByType[st].most_recent_run!)) {
      sourcesByType[st].most_recent_run = s.last_run_at
    }
    if (s.last_run_status) {
      sourcesByType[st].recent_statuses[s.last_run_status] = (sourcesByType[st].recent_statuses[s.last_run_status] || 0) + 1
    }
  }

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    env,
    apify_settings: apify,
    apify_live: apifyLive,
    youtube_live: youtubeLive,
    twitch_live: twitchLive,
    ingest_last_24h: ingest24h,
    source_health: sourcesByType,
  })
}
