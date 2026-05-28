/**
 * Reddit public JSON API wrapper.
 *
 * Reddit serves a JSON variant of almost any URL just by appending `.json`.
 * No OAuth, no API key, no quota. Free up to ~60 req/min per User-Agent
 * (Reddit's published soft limit) — we use ~14 req/scan, comfortably under.
 *
 * Three query patterns we use:
 *   1. /r/<sub>/search.json?q=...&restrict_sr=on  — keyword search within a sub
 *   2. /search.json?q=...                          — global search across Reddit
 *   3. /r/<sub>/new.json                           — newest posts in a sub (firehose)
 *
 * Reddit insists on a descriptive User-Agent; generic curl/python-requests
 * UAs get blocked. We send "GameDrive/1.0 (PR coverage tracker)".
 *
 * Reddit API docs: https://www.reddit.com/dev/api
 */

export interface RedditPost {
  id: string
  subreddit: string
  title: string
  selftext: string
  permalink: string         // /r/sub/comments/<id>/<slug>
  url: string                // permalink prepended with reddit.com
  author: string
  created_utc: number        // epoch seconds
  score: number
  num_comments: number
  is_self: boolean
}

const UA = 'GameDrive/1.0 (PR coverage tracker)'
const ENDPOINT = 'https://www.reddit.com'

interface RedditListingResponse {
  data?: {
    children?: Array<{
      kind: string
      data: {
        id: string
        subreddit: string
        title: string
        selftext?: string
        permalink: string
        author: string
        created_utc: number
        score: number
        num_comments: number
        is_self: boolean
      }
    }>
  }
}

async function fetchJson(url: string): Promise<RedditListingResponse | null> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 12000)
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: ctrl.signal,
    })
    clearTimeout(t)
    if (!res.ok) {
      console.warn(`[reddit-api] HTTP ${res.status} for ${url}`)
      return null
    }
    return await res.json() as RedditListingResponse
  } catch (err) {
    console.warn(`[reddit-api] fetch threw for ${url}:`,
      err instanceof Error ? err.message : String(err))
    return null
  }
}

interface RedditChild {
  data: {
    id: string
    subreddit: string
    title: string
    selftext?: string
    permalink: string
    author: string
    created_utc: number
    score: number
    num_comments: number
    is_self: boolean
  }
}

function toPost(child: RedditChild): RedditPost {
  const d = child.data
  return {
    id: d.id,
    subreddit: d.subreddit,
    title: d.title,
    selftext: d.selftext || '',
    permalink: d.permalink,
    url: `https://www.reddit.com${d.permalink}`,
    author: d.author,
    created_utc: d.created_utc,
    score: d.score,
    num_comments: d.num_comments,
    is_self: d.is_self,
  }
}

/**
 * Search a single subreddit for a query. `time` accepts hour/day/week/month/year/all.
 */
export async function searchSubreddit(
  subreddit: string,
  query: string,
  time: 'hour'|'day'|'week'|'month'|'year'|'all' = 'week',
  limit = 25
): Promise<RedditPost[]> {
  const u = new URL(`${ENDPOINT}/r/${encodeURIComponent(subreddit)}/search.json`)
  u.searchParams.set('q', query)
  u.searchParams.set('restrict_sr', 'on')
  u.searchParams.set('sort', 'new')
  u.searchParams.set('t', time)
  u.searchParams.set('limit', String(limit))
  const data = await fetchJson(u.toString())
  return (data?.data?.children || []).map(toPost)
}

/**
 * Global Reddit search. Useful for catching mentions in subreddits we
 * haven't subscribed to.
 */
export async function searchReddit(
  query: string,
  time: 'hour'|'day'|'week'|'month'|'year'|'all' = 'week',
  limit = 25
): Promise<RedditPost[]> {
  const u = new URL(`${ENDPOINT}/search.json`)
  u.searchParams.set('q', query)
  u.searchParams.set('sort', 'new')
  u.searchParams.set('t', time)
  u.searchParams.set('limit', String(limit))
  const data = await fetchJson(u.toString())
  return (data?.data?.children || []).map(toPost)
}

/**
 * Firehose: newest posts in a subreddit, regardless of keyword. Useful when
 * a sub is specifically about our game's niche (e.g., r/HorrorGaming).
 */
export async function getSubredditNew(
  subreddit: string,
  limit = 50
): Promise<RedditPost[]> {
  const u = new URL(`${ENDPOINT}/r/${encodeURIComponent(subreddit)}/new.json`)
  u.searchParams.set('limit', String(limit))
  const data = await fetchJson(u.toString())
  return (data?.data?.children || []).map(toPost)
}

/**
 * Helper: does a post mention any of the given keyword variants?
 * Case-insensitive substring match in title + selftext.
 */
export function postMentions(post: RedditPost, keywords: string[]): boolean {
  const text = `${post.title} ${post.selftext}`.toLowerCase()
  return keywords.some(k => text.includes(k.toLowerCase()))
}
