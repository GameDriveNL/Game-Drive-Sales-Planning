/**
 * YouTube Data API v3 wrapper.
 *
 * Free quota: 10,000 units/day per project. A search.list call costs 100
 * units, so we get ~100 keyword searches/day across all games. With 7
 * PR-tracked games × 4 keyword variants = 28 searches/day, well within
 * budget — leaves headroom to expand to twice-daily or higher result caps.
 *
 * Why this exists alongside the Apify YouTube scanner:
 *   - When Apify monthly cap hits zero, the Apify scanner skips (correctly,
 *     to avoid cost overrun) but recall drops to zero. This API keeps
 *     YouTube discovery running for free.
 *   - We can pass `relevanceLanguage` to bias toward localized results
 *     (e.g. French/German/Japanese) per region — something the Apify scraper
 *     doesn't do natively.
 *
 * Reference: https://developers.google.com/youtube/v3/docs/search/list
 */

export interface YouTubeSearchResult {
  videoId: string
  title: string
  description: string
  channelTitle: string
  channelId: string
  publishedAt: string  // ISO 8601
  thumbnail: string | null
}

export interface YouTubeSearchOpts {
  query: string
  maxResults?: number      // 1-50 (default 25)
  publishedAfter?: string  // ISO 8601 (e.g. '2026-05-01T00:00:00Z')
  publishedBefore?: string // ISO 8601
  relevanceLanguage?: string  // ISO 639-1 (e.g. 'fr', 'de', 'ja')
  regionCode?: string         // ISO 3166-1 alpha-2 (e.g. 'NL', 'JP')
}

const ENDPOINT = 'https://www.googleapis.com/youtube/v3/search'

/**
 * Run a search.list call. Returns parsed results or empty array on error.
 * Never throws — caller can treat empty as "nothing found this run".
 */
export async function searchVideos(
  apiKey: string,
  opts: YouTubeSearchOpts
): Promise<YouTubeSearchResult[]> {
  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    q: opts.query,
    maxResults: String(opts.maxResults ?? 25),
    order: 'date',
    key: apiKey,
  })
  if (opts.publishedAfter) params.set('publishedAfter', opts.publishedAfter)
  if (opts.publishedBefore) params.set('publishedBefore', opts.publishedBefore)
  if (opts.relevanceLanguage) params.set('relevanceLanguage', opts.relevanceLanguage)
  if (opts.regionCode) params.set('regionCode', opts.regionCode)

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    const res = await fetch(`${ENDPOINT}?${params}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) {
      const txt = await res.text()
      console.warn(`[yt-data-api] HTTP ${res.status} for "${opts.query}":`, txt.substring(0, 200))
      return []
    }
    const data = await res.json() as {
      items?: Array<{
        id?: { videoId?: string }
        snippet?: {
          publishedAt?: string
          title?: string
          description?: string
          channelTitle?: string
          channelId?: string
          thumbnails?: { high?: { url?: string }; default?: { url?: string } }
        }
      }>
    }
    if (!Array.isArray(data.items)) return []
    return data.items
      .filter(it => it.id?.videoId && it.snippet)
      .map(it => ({
        videoId: it.id!.videoId!,
        title: it.snippet!.title || '',
        description: it.snippet!.description || '',
        channelTitle: it.snippet!.channelTitle || '',
        channelId: it.snippet!.channelId || '',
        publishedAt: it.snippet!.publishedAt || '',
        thumbnail: it.snippet!.thumbnails?.high?.url || it.snippet!.thumbnails?.default?.url || null,
      }))
  } catch (err) {
    console.warn(`[yt-data-api] search failed for "${opts.query}":`,
      err instanceof Error ? err.message : String(err))
    return []
  }
}

/**
 * Fetch channel subscriber counts for a list of channel IDs.
 * Channels.list with part=statistics costs 1 unit per call (returns up to
 * 50 channels per call). Used to enrich the MUV / tier classification.
 */
export async function getChannelStats(
  apiKey: string,
  channelIds: string[]
): Promise<Map<string, { subscribers: number; views: number }>> {
  const result = new Map<string, { subscribers: number; views: number }>()
  if (channelIds.length === 0) return result

  // Chunk to 50 IDs per call (API limit)
  for (let i = 0; i < channelIds.length; i += 50) {
    const chunk = channelIds.slice(i, i + 50)
    const params = new URLSearchParams({
      part: 'statistics',
      id: chunk.join(','),
      key: apiKey,
    })
    try {
      const res = await fetch(`https://www.googleapis.com/youtube/v3/channels?${params}`)
      if (!res.ok) continue
      const data = await res.json() as {
        items?: Array<{ id?: string; statistics?: { subscriberCount?: string; viewCount?: string } }>
      }
      for (const it of (data.items || [])) {
        if (!it.id) continue
        result.set(it.id, {
          subscribers: Number(it.statistics?.subscriberCount || 0),
          views: Number(it.statistics?.viewCount || 0),
        })
      }
    } catch { /* skip chunk */ }
  }
  return result
}
