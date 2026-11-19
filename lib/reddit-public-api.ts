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

// ─── Health tracking ────────────────────────────────────────────────────────
// Reddit blocks many datacenter IPs (403) and rate limits (429). Previously a
// non-OK response only hit console.warn, so every scan reported "success, +0
// items" for months. Callers read this to tell "nothing new" from "blocked".
export interface RedditHealth {
  requests: number
  ok: number
  statuses: Record<string, number>   // HTTP status (or 'error') -> count
  usingOAuth: boolean
}

let health: RedditHealth = { requests: 0, ok: 0, statuses: {}, usingOAuth: false }

export function resetRedditHealth(): void {
  health = { requests: 0, ok: 0, statuses: {}, usingOAuth: false }
}

export function getRedditHealth(): RedditHealth {
  return { ...health, statuses: { ...health.statuses } }
}

function record(status: number | 'error'): void {
  health.requests++
  const key = String(status)
  health.statuses[key] = (health.statuses[key] || 0) + 1
  if (status !== 'error' && status >= 200 && status < 300) health.ok++
}

// ─── Optional OAuth ─────────────────────────────────────────────────────────
// Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET (a free "script" or "web app"
// at reddit.com/prefs/apps) to use oauth.reddit.com, which is not IP blocked.
// Without them the public JSON endpoints are used.
let cachedToken: { value: string; expiresAt: number } | null = null

async function getOAuthToken(): Promise<string | null> {
  const id = process.env.REDDIT_CLIENT_ID
  const secret = process.env.REDDIT_CLIENT_SECRET
  if (!id || !secret) return null
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value
  try {
    const res = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Authorization': `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    })
    if (!res.ok) {
      console.warn(`[reddit-api] OAuth token request failed: HTTP ${res.status}`)
      record(res.status)
      return null
    }
    const json = await res.json() as { access_token?: string; expires_in?: number }
    if (!json.access_token) return null
    cachedToken = { value: json.access_token, expiresAt: Date.now() + (json.expires_in || 3600) * 1000 }
    return cachedToken.value
  } catch (err) {
    console.warn('[reddit-api] OAuth token request threw:', err instanceof Error ? err.message : String(err))
    return null
  }
}

async function fetchJson(url: string): Promise<RedditListingResponse | null> {
  try {
    const token = await getOAuthToken()
    const headers: Record<string, string> = { 'User-Agent': UA, 'Accept': 'application/json' }
    let target = url
    if (token) {
      target = url.replace('https://www.reddit.com', 'https://oauth.reddit.com')
      headers['Authorization'] = `Bearer ${token}`
      health.usingOAuth = true
    }
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 12000)
    const res = await fetch(target, { headers, signal: ctrl.signal })
    clearTimeout(t)
    record(res.status)
    if (!res.ok) {
      console.warn(`[reddit-api] HTTP ${res.status} for ${url}`)
      return null
    }
    return await res.json() as RedditListingResponse
  } catch (err) {
    record('error')
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
