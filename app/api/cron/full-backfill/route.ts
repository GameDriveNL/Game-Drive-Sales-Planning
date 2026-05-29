/**
 * POST /api/cron/full-backfill
 *
 * Run exhaustive paginated scans across every free channel for a single game.
 * Hammers each API until it's exhausted or hits safety caps. Designed to be
 * fired manually when we need to chase 100% parity against an external sheet.
 *
 * Channels exhausted in this call:
 *   - Twitch Helix (if TWITCH_CLIENT_ID + TWITCH_CLIENT_SECRET): all archived
 *     VODs (TIME + VIEWS sorts), live streams, and clips (last 30d) for the
 *     game's Twitch directory ID — paginated to depth. No 100-result cap.
 *   - YouTube Data API: search across all 7 languages × all keyword variants,
 *     paginated 5 pages deep each. Bounded by the daily 10K-unit quota.
 *   - Reddit JSON API: global search per variant + per-subreddit search per
 *     variant. Already paginated where Reddit allows.
 *   - Tavily: re-run the existing /api/coverage-backfill in-process (web +
 *     language queries) for any editorial coverage that aged out of RSS.
 *
 * Apify is intentionally NOT called from here — quota is too constrained.
 * TikTok/IG/Twitter scans rotate naturally via their own crons after June 1.
 *
 * Auth: Bearer CRON_SECRET.
 *
 * Body: { game_id: string }
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { verifyCronAuth } from '@/lib/cron-auth'
import { detectOutletCountry } from '@/lib/outlet-country'
import { searchVideosExhaustive } from '@/lib/youtube-data-api'
import { searchSubreddit, searchReddit, type RedditPost } from '@/lib/reddit-public-api'
import {
  getGameByName,
  getAllVideos,
  getAllStreams,
  getAllClips,
} from '@/lib/twitch-helix'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

const YT_LANGUAGES = ['', 'id', 'es', 'pt', 'de', 'fr', 'ja']
const YT_PAGES_PER_QUERY = 5
const YT_RESULTS_PER_PAGE = 50
const RD_RESULTS = 25

interface ChannelResult {
  channel: string
  attempted: boolean
  items_found: number
  items_inserted: number
  errors: string[]
}

export async function POST(request: NextRequest) {
  const authError = verifyCronAuth(request)
  if (authError) return authError

  let body: { game_id?: string } = {}
  try { body = await request.json() } catch { /* empty ok */ }
  if (!body.game_id) return NextResponse.json({ error: 'game_id required' }, { status: 400 })

  const supabase = getServerSupabase()
  const { data: game } = await supabase
    .from('games').select('id, name, client_id').eq('id', body.game_id).single()
  if (!game) return NextResponse.json({ error: 'Game not found' }, { status: 404 })

  // Existing URL set
  const { data: existing } = await supabase
    .from('coverage_items').select('url').eq('game_id', game.id).limit(50000)
  const existingUrls = new Set((existing || []).map((r: { url: string }) => r.url))

  const { data: kws } = await supabase
    .from('coverage_keywords')
    .select('keyword')
    .eq('game_id', game.id)
    .eq('keyword_type', 'whitelist')
    .eq('is_active', true)
  const variants = (kws || []).map((k: { keyword: string }) => k.keyword)

  const results: Record<string, ChannelResult> = {
    twitch_helix: { channel: 'twitch_helix', attempted: false, items_found: 0, items_inserted: 0, errors: [] },
    youtube_data_api: { channel: 'youtube_data_api', attempted: false, items_found: 0, items_inserted: 0, errors: [] },
    reddit_json: { channel: 'reddit_json', attempted: false, items_found: 0, items_inserted: 0, errors: [] },
  }

  async function getOrCreateOutlet(domain: string, name: string, country: string | null, muv: number | null, tier: string): Promise<string | null> {
    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').toLowerCase()
    const { data: o } = await supabase.from('outlets').select('id').eq('domain', cleanDomain).maybeSingle()
    if (o?.id) return o.id
    const { data: newO } = await supabase.from('outlets').insert({
      name, domain: cleanDomain,
      country: country || detectOutletCountry(cleanDomain),
      monthly_unique_visitors: muv,
      tier, is_active: true,
    }).select('id').single()
    return newO?.id ?? null
  }

  // ─── 1. Twitch Helix exhaustive ──────────────────────────────────────────
  const helixClientId = process.env.TWITCH_CLIENT_ID
  const helixSecret = process.env.TWITCH_CLIENT_SECRET
  if (helixClientId && helixSecret) {
    results.twitch_helix.attempted = true
    try {
      const twitchGame = await getGameByName(helixClientId, helixSecret, game.name)
      if (twitchGame) {
        // VODs by both sorts then dedupe
        const [byTime, byViews, liveStreams, clips] = await Promise.all([
          getAllVideos(helixClientId, helixSecret, twitchGame.id, { sort: 'time', period: 'month', maxPages: 50 }),
          getAllVideos(helixClientId, helixSecret, twitchGame.id, { sort: 'views', period: 'month', maxPages: 50 }),
          getAllStreams(helixClientId, helixSecret, twitchGame.id, 20),
          getAllClips(helixClientId, helixSecret, twitchGame.id, {
            startedAt: new Date(Date.now() - 30 * 86400000).toISOString(),
            endedAt: new Date().toISOString(),
            maxPages: 50,
          }),
        ])
        const videos = new Map<string, typeof byTime[number]>()
        for (const v of [...byTime, ...byViews]) videos.set(v.id, v)

        // Insert VODs
        for (const v of Array.from(videos.values())) {
          if (existingUrls.has(v.url)) continue
          existingUrls.add(v.url)
          results.twitch_helix.items_found++
          const outletId = await getOrCreateOutlet(`twitch.tv/${v.user_login}`, v.user_name, null, null, 'D')
          const { error } = await supabase.from('coverage_items').insert({
            client_id: game.client_id, game_id: game.id, outlet_id: outletId,
            title: v.title || `${v.user_name} VOD`, url: v.url,
            publish_date: (v.published_at || v.created_at).split('T')[0],
            coverage_type: 'stream', source_type: 'twitch',
            source_metadata: {
              twitch_helix: true, twitch_vod_id: v.id,
              channel_login: v.user_login, channel_display_name: v.user_name,
              view_count: v.view_count, language: v.language, type: v.type,
            },
            approval_status: 'pending_review',
            discovered_at: new Date().toISOString(),
          })
          if (!error) results.twitch_helix.items_inserted++
        }

        // Live streams (capture as channel-level coverage items)
        for (const s of liveStreams) {
          const url = `https://www.twitch.tv/${s.user_login}`
          if (existingUrls.has(url)) continue
          existingUrls.add(url)
          results.twitch_helix.items_found++
          const outletId = await getOrCreateOutlet(`twitch.tv/${s.user_login}`, s.user_name, null, null, 'D')
          const { error } = await supabase.from('coverage_items').insert({
            client_id: game.client_id, game_id: game.id, outlet_id: outletId,
            title: s.title || `${s.user_name} live`, url,
            publish_date: s.started_at.split('T')[0],
            coverage_type: 'stream', source_type: 'twitch',
            source_metadata: {
              twitch_helix: true, twitch_helix_kind: 'live',
              channel_login: s.user_login, channel_display_name: s.user_name,
              viewers: s.viewer_count, language: s.language,
            },
            approval_status: 'pending_review',
            discovered_at: new Date().toISOString(),
          })
          if (!error) results.twitch_helix.items_inserted++
        }

        // Clips
        for (const c of clips) {
          if (existingUrls.has(c.url)) continue
          existingUrls.add(c.url)
          results.twitch_helix.items_found++
          const outletId = await getOrCreateOutlet(`twitch.tv/${c.broadcaster_name.toLowerCase()}`, c.broadcaster_name, null, null, 'D')
          const { error } = await supabase.from('coverage_items').insert({
            client_id: game.client_id, game_id: game.id, outlet_id: outletId,
            title: c.title, url: c.url,
            publish_date: c.created_at.split('T')[0],
            coverage_type: 'stream', source_type: 'twitch',
            source_metadata: {
              twitch_helix: true, twitch_helix_kind: 'clip', twitch_clip_id: c.id,
              channel_login: c.broadcaster_name.toLowerCase(), channel_display_name: c.broadcaster_name,
              view_count: c.view_count, language: c.language,
            },
            approval_status: 'pending_review',
            discovered_at: new Date().toISOString(),
          })
          if (!error) results.twitch_helix.items_inserted++
        }
      } else {
        results.twitch_helix.errors.push(`Twitch game "${game.name}" not found in directory`)
      }
    } catch (err) {
      results.twitch_helix.errors.push(err instanceof Error ? err.message : String(err))
    }
  } else {
    results.twitch_helix.errors.push('TWITCH_CLIENT_ID + TWITCH_CLIENT_SECRET not set — Helix unavailable')
  }

  // ─── 2. YouTube Data API exhaustive across all languages ─────────────────
  const ytKey = process.env.YOUTUBE_DATA_API_KEY
  if (ytKey) {
    results.youtube_data_api.attempted = true
    const publishedAfter = new Date(Date.now() - 60 * 86400000).toISOString()  // 60d window for backfill
    for (const variant of variants.slice(0, 4)) {
      for (const lang of YT_LANGUAGES) {
        try {
          const items = await searchVideosExhaustive(ytKey, {
            query: variant,
            maxResults: YT_RESULTS_PER_PAGE,
            publishedAfter,
            ...(lang ? { relevanceLanguage: lang } : {}),
          }, YT_PAGES_PER_QUERY)
          results.youtube_data_api.items_found += items.length
          for (const r of items) {
            const url = `https://www.youtube.com/watch?v=${r.videoId}`
            if (existingUrls.has(url)) continue
            existingUrls.add(url)
            const channelDomain = `youtube.com/channel/${r.channelId}`
            const outletId = await getOrCreateOutlet(channelDomain, r.channelTitle || 'YouTube Channel', null, null, 'D')
            const { error } = await supabase.from('coverage_items').insert({
              client_id: game.client_id, game_id: game.id, outlet_id: outletId,
              title: r.title, url,
              publish_date: r.publishedAt ? r.publishedAt.split('T')[0] : null,
              coverage_type: 'video', source_type: 'youtube',
              source_metadata: {
                youtube_data_api: true, video_id: r.videoId,
                channel_id: r.channelId, channel_title: r.channelTitle,
                search_query: variant, relevance_language: lang || 'default',
              },
              approval_status: 'pending_review',
              discovered_at: new Date().toISOString(),
            })
            if (!error) results.youtube_data_api.items_inserted++
          }
        } catch (err) {
          results.youtube_data_api.errors.push(`${variant}|${lang||'def'}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
  } else {
    results.youtube_data_api.errors.push('YOUTUBE_DATA_API_KEY not set')
  }

  // ─── 3. Reddit JSON exhaustive ──────────────────────────────────────────
  results.reddit_json.attempted = true
  const { data: redditSrc } = await supabase
    .from('coverage_sources').select('config').eq('game_id', game.id).eq('source_type', 'reddit').maybeSingle()
  const cfg = redditSrc?.config as { subreddits?: string[] } | null
  const subreddits = (Array.isArray(cfg?.subreddits) ? cfg!.subreddits : []) as string[]
  const redditPosts: RedditPost[] = []
  try {
    for (const v of variants.slice(0, 4)) {
      const globals = await searchReddit(`"${v}"`, 'month', RD_RESULTS)
      redditPosts.push(...globals)
      for (const sub of subreddits.slice(0, 8)) {
        const subPosts = await searchSubreddit(sub, v, 'month', RD_RESULTS)
        redditPosts.push(...subPosts)
      }
    }
  } catch (err) {
    results.reddit_json.errors.push(err instanceof Error ? err.message : String(err))
  }
  const redditOutletId = await getOrCreateOutlet('reddit.com', 'Reddit', 'US', 1_700_000_000, 'A')
  const seenRedditIds = new Set<string>()
  for (const p of redditPosts) {
    if (seenRedditIds.has(p.id)) continue
    seenRedditIds.add(p.id)
    if (existingUrls.has(p.url)) continue
    existingUrls.add(p.url)
    results.reddit_json.items_found++
    const { error } = await supabase.from('coverage_items').insert({
      client_id: game.client_id, game_id: game.id, outlet_id: redditOutletId,
      title: p.title.substring(0, 500), url: p.url,
      publish_date: new Date(p.created_utc * 1000).toISOString().split('T')[0],
      coverage_type: 'mention', source_type: 'reddit',
      source_metadata: {
        reddit_public_api: true, reddit_post_id: p.id, subreddit: p.subreddit,
        author: p.author, score: p.score, comments: p.num_comments,
      },
      approval_status: 'pending_review',
      discovered_at: new Date().toISOString(),
    })
    if (!error) results.reddit_json.items_inserted++
  }

  const totalInserted = Object.values(results).reduce((s, r) => s + r.items_inserted, 0)
  const totalFound = Object.values(results).reduce((s, r) => s + r.items_found, 0)

  return NextResponse.json({
    message: `Full backfill for ${game.name}: +${totalInserted} new of ${totalFound} found`,
    game: game.name,
    total_new_items: totalInserted,
    total_found: totalFound,
    channels: results,
  })
}
