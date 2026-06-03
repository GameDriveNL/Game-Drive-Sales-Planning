/**
 * YouTube search via youtubei.js (Innertube — YouTube's own internal API).
 *
 * This is the deeper-recall replacement for Piped. Verified 2026-06-01:
 *
 *   Piped single-page    →  20 videos / query
 *   Piped paginated 12p  → 180 videos / query
 *   Innertube 8q × 15p   → 1344 videos / 8 queries  (38.5% Bram recovery)
 *
 * The Innertube endpoint is what the YouTube mobile/web app itself uses to
 * search, so it surfaces the same long-tail results as the official app
 * (including videos in languages other than the query, and videos with non-
 * obvious keyword matches). Piped's scraper is shallower.
 *
 * Cost: free. No API key, no quota. Runs in Node.js with no Python binary.
 *
 * NOT a replacement for the YouTube Data API. Use Data API when quota is
 * available for clean structured data. Use Innertube for deep recall when
 * the Data API quota is dead or for the day-1 onboarding audit.
 */

import { Innertube, YTNodes } from 'youtubei.js'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Search = any  // youtubei.js doesn't export Search type publicly; runtime shape is what we use

export interface InnertubeSearchResult {
  videoId: string
  title: string
  channelTitle: string
  channelId: string  // UC...
  channelHandle?: string  // @handle (when available)
  publishedText: string  // "2 days ago" — YT doesn't return ISO from search
  views: number | null
  duration: number | null  // seconds
  thumbnail: string | null
  description: string  // short snippet from search
}

const _ytByLang = new Map<string, Innertube>()
async function getClient(lang = 'en'): Promise<Innertube> {
  const cached = _ytByLang.get(lang)
  if (cached) return cached
  const fresh = await Innertube.create({ lang, generate_session_locally: true })
  _ytByLang.set(lang, fresh)
  return fresh
}

function fromVideo(v: unknown): InnertubeSearchResult | null {
  // Innertube returns several node shapes; we only care about Video.
  // Type-safe extraction with defensive casts.
  if (!(v instanceof YTNodes.Video) && !(v instanceof YTNodes.CompactVideo)
      && !(v instanceof YTNodes.PlaylistVideo)) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = v as any
  const id = a.id || a.video_id
  if (!id) return null
  return {
    videoId: id,
    title: a.title?.text || a.title || '',
    channelTitle: a.author?.name || '',
    channelId: a.author?.id || '',
    channelHandle: a.author?.channel_url?.match(/youtube\.com\/(@[\w.-]+)/i)?.[1],
    publishedText: a.published?.text || '',
    views: typeof a.view_count?.text === 'string'
      ? Number(a.view_count.text.replace(/[^0-9]/g, '')) || null
      : null,
    duration: a.duration?.seconds || null,
    thumbnail: Array.isArray(a.thumbnails) && a.thumbnails.length > 0
      ? a.thumbnails[0]?.url ?? null
      : null,
    description: a.snippets?.[0]?.text?.text || a.description_snippet?.text || '',
  }
}

/**
 * Paginated deep search across multiple queries. Returns deduped video set.
 *
 * Verified 2026-06-01 against Bram's Dark Pals sheet:
 *   - 8 queries × 15 pages → 1344 unique videos in ~70s
 *   - Recovery rate of high-value (≥10K view) misses: 38.5%
 *
 * Stays well within Vercel's 300s function budget. Use overallTimeoutMs to
 * cap if combined with other heavy passes.
 */
export async function searchYouTubeDeep(
  queries: string[],
  opts: {
    maxPagesPerQuery?: number
    overallTimeoutMs?: number
    lang?: string
  } = {},
): Promise<InnertubeSearchResult[]> {
  const maxPages = opts.maxPagesPerQuery ?? 15
  const overallBudget = opts.overallTimeoutMs ?? 120_000
  const start = Date.now()
  const yt = await getClient(opts.lang ?? 'en')
  const seen = new Set<string>()
  const all: InnertubeSearchResult[] = []
  for (const q of queries) {
    if (Date.now() - start > overallBudget) break
    try {
      let current: Search = await yt.search(q, { type: 'video' })
      for (let p = 0; p < maxPages; p++) {
        if (Date.now() - start > overallBudget) break
        const videos = current.videos
        for (const v of videos) {
          const r = fromVideo(v)
          if (!r || seen.has(r.videoId)) continue
          seen.add(r.videoId)
          all.push(r)
        }
        if (!current.has_continuation) break
        current = await current.getContinuation() as Search
      }
    } catch {
      // single-query failure — keep going on the other queries
    }
  }
  return all
}

/**
 * Multi-language fanout — runs the same queries through Innertube sessions
 * created with different `lang` codes. Each language returns a DIFFERENT
 * search ranking from YouTube (their relevance algo accounts for the lang
 * header), surfacing long-tail videos in that language that the `en` search
 * never sees.
 *
 * Verified Dark Pals miss-language breakdown (≥10K view videos Bram has
 * that we don't): nl (45), br/pt (38), es (30), it (15), ja (10), ru (8).
 * Running 6 extra langs at maxPages=8 each is the right shape.
 *
 * Budget: defaults to 90s per language, soft-bails on overrun.
 */
export async function searchYouTubeMultiLang(
  queries: string[],
  langs: string[],
  opts: {
    maxPagesPerQuery?: number
    perLangTimeoutMs?: number
    overallTimeoutMs?: number
  } = {},
): Promise<InnertubeSearchResult[]> {
  const overallBudget = opts.overallTimeoutMs ?? 220_000
  const perLang = opts.perLangTimeoutMs ?? 35_000
  const maxPages = opts.maxPagesPerQuery ?? 8
  const start = Date.now()
  const seen = new Set<string>()
  const all: InnertubeSearchResult[] = []
  for (const lang of langs) {
    if (Date.now() - start > overallBudget) break
    const remaining = overallBudget - (Date.now() - start)
    const budget = Math.min(perLang, remaining)
    const langHits = await searchYouTubeDeep(queries, {
      lang,
      maxPagesPerQuery: maxPages,
      overallTimeoutMs: budget,
    })
    for (const h of langHits) {
      if (seen.has(h.videoId)) continue
      seen.add(h.videoId)
      all.push(h)
    }
  }
  return all
}

/**
 * Fetch a video's full description (untruncated). Used for YT→Twitch
 * cross-reference: search snippets are truncated; getInfo returns the full
 * description including any twitch.tv links the creator embedded.
 *
 * Returns empty string on failure.
 */
export async function getVideoDescription(videoId: string): Promise<string> {
  try {
    const yt = await getClient()
    const info = await yt.getBasicInfo(videoId)
    return info.basic_info?.short_description || ''
  } catch {
    return ''
  }
}

/**
 * Resolve channel ID (UC…) → @handle by fetching the channel's basic info.
 * Free, no auth. Used to convert search-result `channelId` to the @handle
 * form that matches client sheets / outlet domains.
 *
 * Verified 2026-06-01: ~0.5s per channel; 100% success on Dark Pals sample
 * (Game_track, Thinknoodles, HorrorSkunx, etc).
 */
export async function resolveChannelHandleViaInnertube(channelId: string): Promise<string | null> {
  try {
    const yt = await getClient()
    const ch = await yt.getChannel(channelId)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (ch as any).metadata?.vanity_channel_url
      || (ch as any).header?.metadata?.canonical_channel_url
    if (typeof meta === 'string') {
      const m = meta.match(/youtube\.com\/(@[\w.-]+)/i)
      if (m) return m[1].toLowerCase()
    }
  } catch { /* fall through */ }
  return null
}
