/**
 * Shared Creator Watch scan logic — polls tracked YouTube channels directly
 * (channelId search, no keyword filter on fetch) so videos from a known
 * creator get captured even when the title never mentions the game. This is
 * the mechanism for the "Bram's influencer tool" gap (feedback card f148f4fb):
 * regular keyword search (Tavily, YouTube search.list by query) structurally
 * cannot find a video that never mentions the game in indexed text — polling
 * the channel's own upload feed sidesteps that entirely.
 *
 * Used by both the manual "Scan" button (app/api/coverage-health/creator-watch/route.ts)
 * and the cron (app/api/cron/creator-watch-scan/route.ts) so both entry points
 * stay in sync.
 */
import { getServerSupabase } from '@/lib/supabase'
import { detectOutletCountry } from '@/lib/outlet-country'
import { inferTerritory } from '@/lib/territory'
import { searchVideos, getChannelStats, resolveChannelId } from '@/lib/youtube-data-api'

const MAX_CREATORS_PER_CALL = 5
const MAX_VIDEOS_PER_CREATOR = 25

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    return (u.origin + u.pathname).replace(/\/$/, '')
  } catch {
    return url
  }
}

export interface CreatorWatchScanParams {
  game_id?: string
  creator_id?: string
  days_lookback?: number
}

export interface CreatorWatchScanResult {
  message: string
  scanned: number
  total_inserted: number
  elapsed_ms: number
  results: Array<{
    creator: string
    channel_url: string
    videos_found: number
    inserted: number
    skipped: number
    error: string | null
  }>
}

export async function runCreatorWatchScan(params: CreatorWatchScanParams): Promise<CreatorWatchScanResult | { error: string }> {
  const supabase = getServerSupabase()
  const { game_id, creator_id, days_lookback: overrideDays } = params

  const ytApiKey: string | undefined =
    process.env.YOUTUBE_DATA_API_KEY ||
    (await supabase
      .from('service_api_keys')
      .select('api_key')
      .eq('service_name', 'youtube_data_api')
      .eq('is_active', true)
      .maybeSingle()
      .then(({ data }) => data?.api_key as string | undefined))

  if (!ytApiKey) {
    return { error: 'YouTube Data API key not configured (YOUTUBE_DATA_API_KEY)' }
  }

  let creatorsQuery = supabase
    .from('creator_watch')
    .select('id, channel_url, channel_name, channel_handle, game_id, client_id, days_lookback')
    .eq('enabled', true)

  if (creator_id) {
    creatorsQuery = creatorsQuery.eq('id', creator_id)
  } else if (game_id) {
    creatorsQuery = creatorsQuery.eq('game_id', game_id)
  } else {
    creatorsQuery = creatorsQuery
      .order('last_checked_at', { ascending: true, nullsFirst: true })
      .limit(MAX_CREATORS_PER_CALL)
  }

  const { data: creators } = await creatorsQuery
  if (!creators || creators.length === 0) {
    return { message: 'No creators to scan', scanned: 0, total_inserted: 0, elapsed_ms: 0, results: [] }
  }

  const t0 = Date.now()
  const results: CreatorWatchScanResult['results'] = []

  for (const creator of creators) {
    if (Date.now() - t0 > 250_000) break // Vercel timeout guard

    const lookback = overrideDays ?? creator.days_lookback ?? 30

    const channelId = await resolveChannelId(ytApiKey, creator.channel_url)
    if (!channelId) {
      results.push({
        creator: creator.channel_name,
        channel_url: creator.channel_url,
        videos_found: 0,
        inserted: 0,
        skipped: 0,
        error: `Could not resolve channel ID from URL: ${creator.channel_url}`,
      })
      await supabase.from('creator_watch').update({ last_checked_at: new Date().toISOString() }).eq('id', creator.id)
      continue
    }

    let keywords: string[] = []
    if (creator.game_id) {
      const { data: kws } = await supabase
        .from('coverage_keywords')
        .select('keyword')
        .eq('game_id', creator.game_id)
        .eq('keyword_type', 'whitelist')
        .eq('is_active', true)
      keywords = (kws || []).map((k: { keyword: string }) => k.keyword.toLowerCase())
    }

    const { data: existing } = await supabase
      .from('coverage_items')
      .select('url')
      .eq('game_id', creator.game_id || '')
      .limit(50000)
    const existingUrls = new Set<string>((existing || []).map((e: { url: string }) => normalizeUrl(e.url)))

    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - lookback)
    const publishedAfter = cutoff.toISOString()

    const { items: videos } = await searchVideos(ytApiKey, {
      query: '',
      channelId,
      maxResults: MAX_VIDEOS_PER_CREATOR,
      publishedAfter,
    })

    const statsMap = await getChannelStats(ytApiKey, [channelId])
    const subs = statsMap.get(channelId)?.subscribers ?? null

    const rawHandle = creator.channel_handle || creator.channel_name
    const cleanDomain = `youtube.com/${rawHandle.startsWith('@') ? rawHandle : `@${rawHandle}`}`.toLowerCase()
    const { data: existingOutlet } = await supabase.from('outlets').select('id').eq('domain', cleanDomain).maybeSingle()
    let outletId: string | null = existingOutlet?.id ?? null
    if (!outletId) {
      const tier = subs === null ? 'D'
        : subs >= 1_000_000 ? 'A'
        : subs >= 100_000 ? 'B'
        : subs >= 10_000 ? 'C' : 'D'
      const { data: newO } = await supabase.from('outlets').insert({
        name: creator.channel_name,
        domain: cleanDomain,
        country: detectOutletCountry(cleanDomain),
        monthly_unique_visitors: subs,
        tier,
        is_active: true,
      }).select('id').single()
      outletId = newO?.id ?? null
    }

    let inserted = 0
    let skipped = 0

    for (const v of videos) {
      const url = `https://www.youtube.com/watch?v=${v.videoId}`
      const cleanUrl = url.split('&t=')[0]
      const norm = normalizeUrl(cleanUrl)
      if (existingUrls.has(norm)) { skipped++; continue }
      existingUrls.add(norm)

      const title = (v.title || 'Untitled Video').substring(0, 500)
      const titleLower = title.toLowerCase()
      const descLower = (v.description || '').toLowerCase()
      const keywordMatch = keywords.length === 0 || keywords.some(k => titleLower.includes(k) || descLower.includes(k))

      const { error } = await supabase.from('coverage_items').insert({
        client_id: creator.client_id,
        game_id: creator.game_id,
        outlet_id: outletId,
        title,
        url: cleanUrl,
        publish_date: v.publishedAt ? new Date(v.publishedAt).toISOString().split('T')[0] : null,
        coverage_type: 'video',
        monthly_unique_visitors: subs,
        territory: inferTerritory(null, null, null),
        source_type: 'youtube',
        source_metadata: {
          creator_watch: true,
          creator_id: creator.id,
          channel_name: creator.channel_name,
          channel_url: creator.channel_url,
          channel_id: channelId,
          subscribers: subs,
          keyword_match: keywordMatch,
          // D11: without this, coverage-enrich's Gemini relevance pass has
          // nothing but the title to judge a video by — exactly the case
          // (big creator, no game name in title) this feature exists to catch.
          content_snippet: (v.description || '').substring(0, 500) || null,
        },
        approval_status: 'pending_review',
        discovered_at: new Date().toISOString(),
      })
      if (!error) inserted++
      else skipped++
    }

    if (inserted > 0) {
      const { data: cw } = await supabase.from('creator_watch').select('total_matches').eq('id', creator.id).single()
      await supabase.from('creator_watch').update({
        total_matches: (cw?.total_matches || 0) + inserted,
        last_checked_at: new Date().toISOString(),
      }).eq('id', creator.id)
    } else {
      await supabase.from('creator_watch').update({ last_checked_at: new Date().toISOString() }).eq('id', creator.id)
    }

    results.push({
      creator: creator.channel_name,
      channel_url: creator.channel_url,
      videos_found: videos.length,
      inserted,
      skipped,
      error: null,
    })
  }

  const totalInserted = results.reduce((s, r) => s + r.inserted, 0)
  return {
    message: `Creator Watch scan complete: ${totalInserted} new videos found across ${results.length} creator(s)`,
    scanned: results.length,
    total_inserted: totalInserted,
    elapsed_ms: Date.now() - t0,
    results,
  }
}
