/**
 * Piped public-instance YouTube search wrapper.
 *
 * Why this exists alongside YouTube Data API:
 *   - YouTube Data API daily quota is 10K units = ~100 search calls. Across
 *     7 PR-tracked games × 4 variants × 7 langs we need ~200 calls/day.
 *     Until Bram raises the quota in Google Cloud Console, Data API is
 *     effectively dead.
 *   - Piped is a privacy-respecting YouTube frontend with a JSON HTTP API.
 *     It scrapes YouTube on the server side and proxies results back —
 *     functionally equivalent to yt-dlp but runs in any Node.js function
 *     without a Python binary.
 *
 * Instance reliability: ~40-60% of public instances are healthy at any
 * given time. We rotate across a known-good shortlist and treat 5xx/timeout
 * as a "try next instance" signal.
 *
 * Tested 2026-06-01: `api.piped.private.coffee` returned 50+ Dark Pals
 * results with full uploader, view_count, uploadedDate, video_id.
 */

export interface PipedSearchResult {
  videoId: string
  title: string
  channelTitle: string
  channelUrl: string  // /channel/UC… (Piped path; convert if needed)
  publishedText: string  // "2 days ago" — Piped does not return ISO timestamps
  views: number | null
  duration: number | null  // seconds
  thumbnail: string | null
  description: string  // short description from search snippet
}

// Maintained list of Piped instances. Health checked at runtime.
const PIPED_INSTANCES = [
  'https://api.piped.private.coffee',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.kavin.rocks',
  'https://api.piped.yt',
]

interface PipedRawHit {
  url?: string
  title?: string
  uploaderName?: string
  uploaderUrl?: string
  uploadedDate?: string
  views?: number
  duration?: number
  thumbnail?: string
  shortDescription?: string
  type?: string
}

function pickVideoId(url: string): string {
  // Piped returns /watch?v=ID
  const m = url.match(/[?&]v=([\w-]{11})/)
  return m ? m[1] : ''
}

async function searchOnInstance(
  base: string,
  query: string,
  signal: AbortSignal,
  nextpage?: string,
): Promise<{ hits: PipedSearchResult[]; nextpage: string | null } | null> {
  try {
    const url = nextpage
      ? `${base}/nextpage/search?q=${encodeURIComponent(query)}&filter=videos&nextpage=${encodeURIComponent(nextpage)}`
      : `${base}/search?q=${encodeURIComponent(query)}&filter=videos`
    const res = await fetch(url, { signal, headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    const data = await res.json() as { items?: PipedRawHit[]; nextpage?: string }
    const hits = (data.items || [])
      .filter(it => it.type === 'stream' || !it.type)
      .filter(it => it.url && pickVideoId(it.url))
      .map(it => ({
        videoId: pickVideoId(it.url!),
        title: it.title || '',
        channelTitle: it.uploaderName || '',
        channelUrl: it.uploaderUrl || '',
        publishedText: it.uploadedDate || '',
        views: typeof it.views === 'number' ? it.views : null,
        duration: typeof it.duration === 'number' ? it.duration : null,
        thumbnail: it.thumbnail || null,
        description: it.shortDescription || '',
      }))
    return { hits, nextpage: data.nextpage ?? null }
  } catch {
    return null
  }
}

/**
 * Search YouTube via Piped, rotating instances on failure. Single page only —
 * returns first successful response.
 *
 * Prefer `searchYouTubeViaPipedDeep` for any real recall work — single page
 * only returns 20 items (verified 2026-06-01).
 */
export async function searchYouTubeViaPiped(
  query: string,
  opts: { timeoutMs?: number; instances?: string[] } = {},
): Promise<PipedSearchResult[]> {
  const timeout = opts.timeoutMs ?? 12_000
  const instances = opts.instances ?? PIPED_INSTANCES
  for (const inst of instances) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeout)
    try {
      const page = await searchOnInstance(inst, query, ctl.signal)
      clearTimeout(timer)
      if (page && page.hits.length > 0) return page.hits
    } catch {
      clearTimeout(timer)
    }
  }
  return []
}

/**
 * Paginated search across nextpage cursors. Returns deduped results.
 *
 * Verified 2026-06-01: api.piped.private.coffee paginates to ~190 unique
 * results per query in ~12 seconds across 11 pages before nextpage starts
 * returning 0 items. Stays on a single instance for cursor consistency
 * (cursors are instance-specific), only rotates on hard failure.
 *
 * 12 pages × ~17 unique-per-page = ~200 video ceiling per query. With 4
 * queries that's ~750 unique videos — vs 80 with single-page.
 */
export async function searchYouTubeViaPipedDeep(
  query: string,
  opts: {
    maxPages?: number
    timeoutMsPerPage?: number
    overallTimeoutMs?: number
    instances?: string[]
  } = {},
): Promise<PipedSearchResult[]> {
  const maxPages = opts.maxPages ?? 12
  const pageTimeout = opts.timeoutMsPerPage ?? 12_000
  const overallBudget = opts.overallTimeoutMs ?? 60_000
  const instances = opts.instances ?? PIPED_INSTANCES
  const seen = new Set<string>()
  const all: PipedSearchResult[] = []
  const start = Date.now()

  for (const inst of instances) {
    let cursor: string | null = null
    let pagesOnThisInstance = 0
    while (pagesOnThisInstance < maxPages && Date.now() - start < overallBudget) {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), pageTimeout)
      let page: { hits: PipedSearchResult[]; nextpage: string | null } | null = null
      try {
        page = await searchOnInstance(inst, query, ctl.signal, cursor ?? undefined)
      } catch { /* fall through */ }
      clearTimeout(timer)
      if (!page) break  // try next instance
      let newAdds = 0
      for (const h of page.hits) {
        if (seen.has(h.videoId)) continue
        seen.add(h.videoId)
        all.push(h)
        newAdds++
      }
      pagesOnThisInstance++
      if (!page.nextpage || newAdds === 0) return all  // exhausted
      cursor = page.nextpage
    }
    if (all.length > 0) return all  // we got some — don't try the next instance
  }
  return all
}

/**
 * Fetch full video description (untruncated) from a Piped instance.
 * Used for the YouTube → Twitch cross-reference pipeline: search results
 * only return a short description, but `/streams/{id}` returns the full one.
 * Returns empty string on failure (callers should tolerate).
 */
export async function fetchVideoDescription(
  videoId: string,
  opts: { timeoutMs?: number; instances?: string[] } = {},
): Promise<string> {
  const timeout = opts.timeoutMs ?? 10_000
  const instances = opts.instances ?? PIPED_INSTANCES
  for (const inst of instances) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeout)
    try {
      const res = await fetch(`${inst}/streams/${videoId}`, {
        signal: ctl.signal,
        headers: { Accept: 'application/json' },
      })
      clearTimeout(timer)
      if (!res.ok) continue
      const data = await res.json() as { description?: string }
      if (data.description) return data.description
    } catch {
      clearTimeout(timer)
    }
  }
  return ''
}

/**
 * Resolve a YouTube channel ID (UC…) to its public @handle by scraping the
 * channel page. Verified 2026-06-01: youtube.com/channel/UC… returns HTML
 * embedding `"vanityChannelUrl":"http://www.youtube.com/@handle"`. 100%
 * accuracy in 5/5 Dark Pals sample (Thinknoodles, HorrorSkunx, Game_track,
 * PressStartToLaugh, HollowPoiint).
 *
 * Returns null on any failure — caller treats as "skip this channel".
 * Cost: 1 HTTP fetch per channel, ~0.5s sequential. With Promise.all batched
 * 10 at a time, ~9s per 200 channels.
 */
export async function resolveChannelHandle(channelId: string, timeoutMs = 8000): Promise<string | null> {
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    const res = await fetch(`https://www.youtube.com/channel/${channelId}`, {
      signal: ctl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        Accept: 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })
    clearTimeout(timer)
    if (!res.ok) return null
    const html = await res.text()
    // YouTube channel HTML embeds the @handle in vanityChannelUrl. Fallback
    // patterns: canonicalBaseUrl, and the og:url meta tag.
    const m =
      html.match(/"vanityChannelUrl":"http:\/\/www\.youtube\.com\/(@[\w.\-]+)"/)
      ?? html.match(/"canonicalBaseUrl":"\/(@[\w.\-]+)"/)
      ?? html.match(/<link\s+rel="canonical"\s+href="https?:\/\/www\.youtube\.com\/(@[\w.\-]+)"/)
    return m ? m[1].toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * Extract twitch.tv/@handle handles from a freeform text blob (typically a
 * YouTube video description). Returns lowercased logins, deduped.
 *
 * Pattern matches: twitch.tv/<login>, www.twitch.tv/<login>, t.co/...?u=...twitch.tv/<login>
 * Login rules per Twitch: 4-25 chars, [a-z0-9_].
 */
export function extractTwitchLogins(text: string): string[] {
  const out = new Set<string>()
  const re = /twitch\.tv\/([a-z0-9_]{2,25})\b/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const login = m[1].toLowerCase()
    // Filter common false positives — Twitch reserved/system paths
    if (['videos', 'directory', 'p', 'subscribe', 'login', 'signup',
         'about', 'jobs', 'press', 'blog', 'security', 'broadcast', 'live',
         'turbo', 'prime', 'partners', 'developers'].includes(login)) continue
    out.add(login)
  }
  return Array.from(out)
}
