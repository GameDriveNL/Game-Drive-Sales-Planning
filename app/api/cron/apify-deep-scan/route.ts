/**
 * POST /api/cron/apify-deep-scan
 *
 * Retroactive deep scan across all Apify-based platforms for a single game.
 *
 * The daily scan crons use short dateFilter windows ('today'/'day') for cost
 * control — perfect for catching new coverage, useless for backfilling a game
 * whose launch already happened. This endpoint widens the dateFilter so we
 * recover historic YouTube/Reddit/Twitter/TikTok/Instagram coverage with a
 * single one-shot call per game.
 *
 * Designed to be invoked manually after Apify quota refreshes, or by the
 * autoEnroll flow the moment a game is first PR-tracked.
 *
 * Body (JSON):
 *   game_id: string         — required
 *   lookback: 'week'|'month'|'year' (default 'month')
 *   platforms?: string[]    — subset of ['youtube','reddit','twitter','tiktok','instagram']
 *                             default = all
 *   max_results?: number    — per-platform cap, default 30
 *   dry_run?: boolean       — return what would run without calling Apify
 *
 * Returns per-platform results: actor invocations made, items found, items
 * inserted, errors.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { verifyCronAuth } from '@/lib/cron-auth'
import { checkApifyCredits, checkApifyDailyBudget, logApifyRun } from '@/lib/apify-utils'
import { inferTerritory } from '@/lib/territory'
import { detectOutletCountry } from '@/lib/outlet-country'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

// Apify actor IDs — mirror those used by the daily scan crons.
const ACTORS = {
  youtube: 'streamers~youtube-scraper',
  reddit: 'trudax~reddit-scraper-lite',
  twitter: 'apidojo~twitter-scraper-lite',
  tiktok: 'clockworks~free-tiktok-scraper',
  instagram: 'apify~instagram-scraper',
}

type Platform = keyof typeof ACTORS
const ALL_PLATFORMS: Platform[] = ['youtube', 'reddit', 'twitter', 'tiktok', 'instagram']

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    return (u.origin + u.pathname).replace(/\/$/, '')
  } catch {
    return url
  }
}

interface ApifyCallResult {
  platform: Platform
  items_found: number
  items_inserted: number
  http_status: number | null
  error: string | null
}

interface DeepScanContext {
  apifyKey: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any
  game: { id: string; name: string; client_id: string }
  variants: string[]
  hashtags: string[]
  subreddits: string[]
  lookback: 'week' | 'month' | 'year'
  maxResults: number
  existingUrls: Set<string>
  dryRun: boolean
}

async function runActor(
  actorId: string,
  apifyKey: string,
  input: Record<string, unknown>
): Promise<{ ok: boolean; status: number | null; data: unknown[]; error: string | null }> {
  try {
    const res = await fetch(
      `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${apifyKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }
    )
    if (!res.ok) return { ok: false, status: res.status, data: [], error: `HTTP ${res.status}` }
    const data = await res.json()
    return { ok: Array.isArray(data), status: res.status, data: Array.isArray(data) ? data : [], error: null }
  } catch (err) {
    return { ok: false, status: null, data: [], error: err instanceof Error ? err.message : String(err) }
  }
}

async function findOrCreateOutlet(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  domain: string,
  name: string,
  tierFromAudience: number | null
): Promise<string | null> {
  const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').toLowerCase()
  const { data: existing } = await supabase
    .from('outlets')
    .select('id, is_blacklisted')
    .ilike('domain', `%${cleanDomain}%`)
    .limit(1)
  if (existing && existing.length > 0) {
    if (existing[0].is_blacklisted) return null
    return existing[0].id
  }
  const tier = tierFromAudience === null
    ? 'D'
    : tierFromAudience >= 1_000_000 ? 'A'
    : tierFromAudience >= 100_000 ? 'B'
    : tierFromAudience >= 10_000 ? 'C' : 'D'
  const { data: newOutlet } = await supabase
    .from('outlets')
    .insert({
      name,
      domain: cleanDomain,
      country: detectOutletCountry(cleanDomain),
      monthly_unique_visitors: tierFromAudience,
      tier,
      is_active: true,
    })
    .select('id').single()
  return newOutlet?.id || null
}

// ─── Platform handlers ──────────────────────────────────────────────────────

async function scanYouTube(ctx: DeepScanContext): Promise<ApifyCallResult> {
  const input = {
    searchQueries: ctx.variants.slice(0, 4),
    maxResults: ctx.maxResults,
    maxResultStreams: 0,
    maxResultsShorts: 0,
    sortVideosBy: 'RELEVANCE',
    dateFilter: ctx.lookback,
    downloadSubtitles: false,
  }
  if (ctx.dryRun) return { platform: 'youtube', items_found: 0, items_inserted: 0, http_status: null, error: 'dry_run' }
  const res = await runActor(ACTORS.youtube, ctx.apifyKey, input)
  await logApifyRun(ctx.supabase, { scanner: 'apify-deep-scan/youtube', actor_id: ACTORS.youtube, input, results_count: res.data.length, http_status: res.status, ok: res.ok, error: res.error })
  if (!res.ok) return { platform: 'youtube', items_found: 0, items_inserted: 0, http_status: res.status, error: res.error }

  let inserted = 0
  for (const v of res.data as Array<Record<string, unknown>>) {
    const url = (v.url as string) || (v.id ? `https://www.youtube.com/watch?v=${v.id}` : null)
    if (!url) continue
    const cleanUrl = url.split('&t=')[0]
    const norm = normalizeUrl(cleanUrl)
    if (ctx.existingUrls.has(norm)) continue
    ctx.existingUrls.add(norm)

    const channelName = (v.channelName as string) || 'Unknown Channel'
    const channelUrl = (v.channelUrl as string) || ''
    const subs = Number(v.numberOfSubscribers || 0)
    const channelDomain = channelUrl ? channelUrl.replace(/^https?:\/\//, '') : `youtube.com/@${(v.channelUsername as string) || channelName}`
    const outletId = await findOrCreateOutlet(ctx.supabase, channelDomain, channelName, subs)

    const { error } = await ctx.supabase.from('coverage_items').insert({
      client_id: ctx.game.client_id,
      game_id: ctx.game.id,
      outlet_id: outletId,
      title: (v.title as string) || 'Untitled Video',
      url: cleanUrl,
      publish_date: v.date ? new Date(v.date as string).toISOString().split('T')[0] : null,
      coverage_type: 'video',
      monthly_unique_visitors: v.viewCount || 0,
      territory: inferTerritory(null, null, (v.defaultLanguage as string) || null),
      source_type: 'youtube',
      source_metadata: { video_id: v.id, channel_name: channelName, channel_url: channelUrl, subscribers: subs, views: v.viewCount || 0, deep_scan: true },
      approval_status: 'pending_review',
      discovered_at: new Date().toISOString(),
    })
    if (!error) inserted++
  }
  return { platform: 'youtube', items_found: res.data.length, items_inserted: inserted, http_status: res.status, error: null }
}

async function scanReddit(ctx: DeepScanContext): Promise<ApifyCallResult> {
  // Reddit actor uses subreddits + queries; we use top subreddit list from source config
  const { data: redditSrc } = await ctx.supabase
    .from('coverage_sources')
    .select('config')
    .eq('game_id', ctx.game.id)
    .eq('source_type', 'reddit')
    .single()
  const subreddits = Array.isArray(redditSrc?.config?.subreddits)
    ? (redditSrc.config.subreddits as string[])
    : ['gaming', 'pcgaming', 'indiegaming']

  const input = {
    queries: ctx.variants.slice(0, 4),
    subreddits,
    maxPosts: ctx.maxResults,
    maxComments: 1,
    scrapeComments: false,
    includeNsfw: false,
    sort: 'relevance',
    timeframe: ctx.lookback,
  }
  if (ctx.dryRun) return { platform: 'reddit', items_found: 0, items_inserted: 0, http_status: null, error: 'dry_run' }
  const res = await runActor(ACTORS.reddit, ctx.apifyKey, input)
  await logApifyRun(ctx.supabase, { scanner: 'apify-deep-scan/reddit', actor_id: ACTORS.reddit, input, results_count: res.data.length, http_status: res.status, ok: res.ok, error: res.error })
  if (!res.ok) return { platform: 'reddit', items_found: 0, items_inserted: 0, http_status: res.status, error: res.error }

  let inserted = 0
  for (const p of res.data as Array<Record<string, unknown>>) {
    const url = (p.url as string) || ''
    if (!url) continue
    const norm = normalizeUrl(url)
    if (ctx.existingUrls.has(norm)) continue
    ctx.existingUrls.add(norm)
    const outletId = await findOrCreateOutlet(ctx.supabase, 'reddit.com', `r/${(p.subreddit as string) || 'unknown'}`, null)
    const { error } = await ctx.supabase.from('coverage_items').insert({
      client_id: ctx.game.client_id,
      game_id: ctx.game.id,
      outlet_id: outletId,
      title: (p.title as string) || 'Reddit post',
      url,
      publish_date: p.createdAt ? new Date(p.createdAt as string).toISOString().split('T')[0] : null,
      coverage_type: 'mention',
      source_type: 'reddit',
      source_metadata: { subreddit: p.subreddit, ups: p.upVotes, comments: p.numberOfComments, deep_scan: true },
      approval_status: 'pending_review',
      discovered_at: new Date().toISOString(),
    })
    if (!error) inserted++
  }
  return { platform: 'reddit', items_found: res.data.length, items_inserted: inserted, http_status: res.status, error: null }
}

async function scanGenericApify(
  ctx: DeepScanContext,
  platform: 'twitter' | 'tiktok' | 'instagram',
  buildInput: (variants: string[], hashtags: string[]) => Record<string, unknown>,
  coverageType: string
): Promise<ApifyCallResult> {
  const input = buildInput(ctx.variants.slice(0, 4), ctx.hashtags.slice(0, 4))
  if (ctx.dryRun) return { platform, items_found: 0, items_inserted: 0, http_status: null, error: 'dry_run' }
  const res = await runActor(ACTORS[platform], ctx.apifyKey, input)
  await logApifyRun(ctx.supabase, { scanner: `apify-deep-scan/${platform}`, actor_id: ACTORS[platform], input, results_count: res.data.length, http_status: res.status, ok: res.ok, error: res.error })
  if (!res.ok) return { platform, items_found: 0, items_inserted: 0, http_status: res.status, error: res.error }

  let inserted = 0
  for (const item of res.data as Array<Record<string, unknown>>) {
    const url = (item.url as string) || (item.webVideoUrl as string) || (item.videoUrl as string) || ''
    if (!url) continue
    const norm = normalizeUrl(url)
    if (ctx.existingUrls.has(norm)) continue
    ctx.existingUrls.add(norm)
    const platformDomain = { twitter: 'x.com', tiktok: 'tiktok.com', instagram: 'instagram.com' }[platform]
    const outletId = await findOrCreateOutlet(ctx.supabase, platformDomain, platform === 'twitter' ? 'X (Twitter)' : platform.charAt(0).toUpperCase() + platform.slice(1), null)
    const { error } = await ctx.supabase.from('coverage_items').insert({
      client_id: ctx.game.client_id,
      game_id: ctx.game.id,
      outlet_id: outletId,
      title: (item.text as string)?.substring(0, 200) || (item.caption as string)?.substring(0, 200) || `${platform} post`,
      url,
      publish_date: item.createdAt ? new Date(item.createdAt as string).toISOString().split('T')[0] : null,
      coverage_type: coverageType,
      source_type: platform,
      source_metadata: { deep_scan: true, platform_data: { likes: item.diggCount || item.likesCount || item.favoriteCount, comments: item.commentCount } },
      approval_status: 'pending_review',
      discovered_at: new Date().toISOString(),
    })
    if (!error) inserted++
  }
  return { platform, items_found: res.data.length, items_inserted: inserted, http_status: res.status, error: null }
}

// ─── Main handler ───────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const authError = verifyCronAuth(request)
  if (authError) return authError

  let body: { game_id?: string; lookback?: string; platforms?: string[]; max_results?: number; dry_run?: boolean } = {}
  try { body = await request.json() } catch { /* empty body ok */ }

  if (!body.game_id) {
    return NextResponse.json({ error: 'game_id is required' }, { status: 400 })
  }
  const lookback = (body.lookback || 'month') as 'week' | 'month' | 'year'
  if (!['week', 'month', 'year'].includes(lookback)) {
    return NextResponse.json({ error: 'lookback must be week, month, or year' }, { status: 400 })
  }
  const platforms = (body.platforms?.filter((p): p is Platform => ALL_PLATFORMS.includes(p as Platform))) ?? ALL_PLATFORMS
  const maxResults = Math.min(body.max_results ?? 30, 50)
  const dryRun = body.dry_run === true

  const supabase = getServerSupabase()

  // Resolve Apify key + sanity-check budget unless dry run
  const { data: keyData } = await supabase
    .from('service_api_keys')
    .select('api_key').eq('service_name', 'apify').eq('is_active', true).maybeSingle()
  const apifyKey = keyData?.api_key as string | undefined

  if (!dryRun) {
    if (!apifyKey) return NextResponse.json({ error: 'Apify API key not configured' }, { status: 400 })
    const credits = await checkApifyCredits(apifyKey)
    if (!credits.hasCredits) {
      return NextResponse.json({ error: 'Apify credits unavailable', remaining_usd: credits.remainingUsd, detail: credits.error }, { status: 503 })
    }
    const budget = await checkApifyDailyBudget(supabase)
    if (!budget.ok) {
      return NextResponse.json({ error: 'Apify daily budget exhausted', calls_today: budget.callsToday, limit: budget.limit }, { status: 503 })
    }
  }

  const { data: game } = await supabase
    .from('games').select('id, name, client_id').eq('id', body.game_id).single()
  if (!game) return NextResponse.json({ error: 'Game not found' }, { status: 404 })

  // Pull all whitelist variants for the game
  const { data: kws } = await supabase
    .from('coverage_keywords')
    .select('keyword')
    .eq('game_id', game.id)
    .eq('keyword_type', 'whitelist')
    .eq('is_active', true)
  const variants = (kws || []).map((k: { keyword: string }) => k.keyword).filter(Boolean)

  // Pull hashtags from any existing TikTok/Instagram config (they're the same set)
  const { data: igCfg } = await supabase
    .from('coverage_sources')
    .select('config').eq('game_id', game.id).eq('source_type', 'instagram').maybeSingle()
  const hashtags = Array.isArray(igCfg?.config?.hashtags) ? (igCfg.config.hashtags as string[]) : []

  // Same source for subreddits
  const { data: redditCfg } = await supabase
    .from('coverage_sources')
    .select('config').eq('game_id', game.id).eq('source_type', 'reddit').maybeSingle()
  const subreddits = Array.isArray(redditCfg?.config?.subreddits) ? (redditCfg.config.subreddits as string[]) : []

  // Existing URL set for dedup
  const { data: existing } = await supabase
    .from('coverage_items').select('url').eq('game_id', game.id).limit(5000)
  const existingUrls = new Set<string>()
  for (const e of (existing || [])) existingUrls.add(normalizeUrl(e.url))

  const ctx: DeepScanContext = {
    apifyKey: apifyKey || '',
    supabase, game, variants, hashtags, subreddits,
    lookback, maxResults, existingUrls, dryRun,
  }

  const results: ApifyCallResult[] = []
  for (const platform of platforms) {
    try {
      if (platform === 'youtube') results.push(await scanYouTube(ctx))
      else if (platform === 'reddit') results.push(await scanReddit(ctx))
      else if (platform === 'twitter') {
        // 'mention' — coverage_items CHECK only allows news/review/preview/
        // interview/trailer/trailer_repost/stream/video/guide/roundup/mention/
        // feature/informational. Twitter posts are short mentions.
        results.push(await scanGenericApify(ctx, 'twitter',
          (v) => ({ searchTerms: v, maxItems: ctx.maxResults, sort: 'Latest' }),
          'mention'))
      }
      else if (platform === 'tiktok') {
        // TikToks are short-form videos.
        results.push(await scanGenericApify(ctx, 'tiktok',
          (v, h) => ({ hashtags: h, searchQueries: v, resultsPerPage: ctx.maxResults, shouldDownloadVideos: false }),
          'video'))
      }
      else if (platform === 'instagram') {
        // Instagram Reels are videos; carousels/photos still fit 'video' best
        // among the allowed enum values.
        results.push(await scanGenericApify(ctx, 'instagram',
          (v, h) => ({ hashtags: h, search: v[0], resultsLimit: ctx.maxResults, addParentData: false }),
          'video'))
      }
    } catch (err) {
      results.push({ platform, items_found: 0, items_inserted: 0, http_status: null, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return NextResponse.json({
    message: dryRun ? 'Dry run — no Apify calls made' : `Deep scan complete for "${game.name}"`,
    game: game.name,
    lookback,
    variants_used: variants.length,
    hashtags_used: hashtags.length,
    subreddits_used: subreddits.length,
    results,
    total_items_inserted: results.reduce((s, r) => s + r.items_inserted, 0),
  })
}
