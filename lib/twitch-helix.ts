/**
 * Twitch Helix REST API wrapper — the official paginated path.
 *
 * The anonymous GQL endpoint (kimne78kx3ncx6brgo4mv6wki5h1ko) we use as a
 * fallback gets rejected with "failed integrity check" on page 2 of any
 * paginated query. Helix is the official supported way to enumerate every
 * video, stream, and clip for a game directory.
 *
 * Setup (~2 minutes, free):
 *   1. Go to https://dev.twitch.tv/console/apps
 *   2. Register Application → name="GameDrive PR Tracker", redirect=https://localhost,
 *      category="Application Integration", confidential=Server-to-Server
 *   3. Copy the Client ID
 *   4. Click "New Secret" → copy the Client Secret
 *   5. Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in Vercel env
 *
 * Rate limit: 800 points/minute per Client ID — generous, our scans use ~50.
 *
 * Pagination: every paginated endpoint returns a cursor in `pagination.cursor`.
 * Pass it as `after` to get the next page. Empty cursor = end of stream.
 *
 * Token lifecycle: client_credentials grant returns a token good for ~60 days.
 * We cache it in-memory (process-local) and refresh on 401.
 */

const HELIX_BASE = 'https://api.twitch.tv/helix'
const OAUTH_URL = 'https://id.twitch.tv/oauth2/token'

interface TokenCache {
  token: string
  expiresAt: number  // epoch ms
}
let cachedToken: TokenCache | null = null

async function getAppToken(clientId: string, clientSecret: string): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
  })
  const res = await fetch(OAUTH_URL, { method: 'POST', body })
  if (!res.ok) {
    throw new Error(`Twitch OAuth ${res.status}: ${await res.text()}`)
  }
  const data = await res.json() as { access_token: string; expires_in: number }
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
  }
  return data.access_token
}

interface HelixPage<T> {
  data: T[]
  pagination?: { cursor?: string }
}

async function helixGet<T>(
  clientId: string,
  clientSecret: string,
  path: string,
  params: Record<string, string | number | undefined>
): Promise<HelixPage<T>> {
  const token = await getAppToken(clientId, clientSecret)
  const url = new URL(`${HELIX_BASE}${path}`)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v))
  }
  const res = await fetch(url, {
    headers: { 'Client-Id': clientId, 'Authorization': `Bearer ${token}` },
  })
  if (res.status === 401) {
    // Token expired or invalidated — clear cache and retry once
    cachedToken = null
    const fresh = await getAppToken(clientId, clientSecret)
    const retry = await fetch(url, {
      headers: { 'Client-Id': clientId, 'Authorization': `Bearer ${fresh}` },
    })
    if (!retry.ok) throw new Error(`Helix ${path} ${retry.status}: ${await retry.text()}`)
    return await retry.json() as HelixPage<T>
  }
  if (!res.ok) throw new Error(`Helix ${path} ${res.status}: ${await res.text()}`)
  return await res.json() as HelixPage<T>
}

// ── Public types ────────────────────────────────────────────────────────────

export interface HelixVideo {
  id: string
  user_id: string
  user_login: string
  user_name: string
  title: string
  description: string
  created_at: string
  published_at: string
  url: string
  thumbnail_url: string
  viewable: string
  view_count: number
  language: string
  type: 'upload' | 'archive' | 'highlight'
  duration: string
}

export interface HelixStream {
  id: string
  user_id: string
  user_login: string
  user_name: string
  game_id: string
  game_name: string
  type: string
  title: string
  viewer_count: number
  started_at: string
  language: string
  thumbnail_url: string
  tags: string[]
}

export interface HelixClip {
  id: string
  url: string
  embed_url: string
  broadcaster_id: string
  broadcaster_name: string
  creator_id: string
  creator_name: string
  video_id: string
  game_id: string
  language: string
  title: string
  view_count: number
  created_at: string
  thumbnail_url: string
  duration: number
  vod_offset: number | null
}

export interface HelixUser {
  id: string
  login: string
  display_name: string
  type: string
  broadcaster_type: string
  description: string
  profile_image_url: string
  view_count: number
  created_at: string
}

// ── Resolve game name → game_id ─────────────────────────────────────────────

export async function getGameByName(
  clientId: string,
  clientSecret: string,
  name: string
): Promise<{ id: string; name: string } | null> {
  const page = await helixGet<{ id: string; name: string; box_art_url: string }>(
    clientId, clientSecret, '/games', { name }
  )
  return page.data[0] ?? null
}

// ── Paginated fetchers ──────────────────────────────────────────────────────

/**
 * Fetch ALL videos for a game (paginated to exhaustion).
 *
 * Helix /videos accepts game_id + type + sort + period. Defaults below match
 * "every archived broadcast in the past month".
 *
 * type: 'all' | 'upload' | 'archive' | 'highlight'  (default 'archive' = VODs)
 * sort: 'time' | 'trending' | 'views'              (default 'time')
 * period: 'all' | 'day' | 'week' | 'month'          (default 'month')
 */
export async function getAllVideos(
  clientId: string,
  clientSecret: string,
  gameId: string,
  opts: {
    type?: 'all' | 'upload' | 'archive' | 'highlight'
    sort?: 'time' | 'trending' | 'views'
    period?: 'all' | 'day' | 'week' | 'month'
    maxPages?: number
  } = {}
): Promise<HelixVideo[]> {
  const out: HelixVideo[] = []
  let cursor: string | undefined = undefined
  let pages = 0
  const maxPages = opts.maxPages ?? 50  // 50 × 100 = 5000 cap
  do {
    const page: HelixPage<HelixVideo> = await helixGet<HelixVideo>(
      clientId,
      clientSecret,
      '/videos',
      {
        game_id: gameId,
        type: opts.type ?? 'archive',
        sort: opts.sort ?? 'time',
        period: opts.period ?? 'month',
        first: 100,
        after: cursor,
      }
    )
    out.push(...page.data)
    cursor = page.pagination?.cursor
    pages++
    if (!cursor || page.data.length === 0) break
  } while (pages < maxPages)
  return out
}

/**
 * Fetch all currently-live streams for a game (paginated).
 */
export async function getAllStreams(
  clientId: string,
  clientSecret: string,
  gameId: string,
  maxPages = 20
): Promise<HelixStream[]> {
  const out: HelixStream[] = []
  let cursor: string | undefined = undefined
  let pages = 0
  do {
    const page: HelixPage<HelixStream> = await helixGet<HelixStream>(
      clientId,
      clientSecret,
      '/streams',
      { game_id: gameId, type: 'live', first: 100, after: cursor }
    )
    out.push(...page.data)
    cursor = page.pagination?.cursor
    pages++
    if (!cursor || page.data.length === 0) break
  } while (pages < maxPages)
  return out
}

/**
 * Fetch top clips for a game in a time window.
 * started_at / ended_at must be RFC3339.
 */
export async function getAllClips(
  clientId: string,
  clientSecret: string,
  gameId: string,
  opts: {
    startedAt?: string  // RFC3339 e.g. '2026-05-01T00:00:00Z'
    endedAt?: string
    maxPages?: number
  } = {}
): Promise<HelixClip[]> {
  const out: HelixClip[] = []
  let cursor: string | undefined = undefined
  let pages = 0
  const maxPages = opts.maxPages ?? 50
  do {
    const page: HelixPage<HelixClip> = await helixGet<HelixClip>(
      clientId,
      clientSecret,
      '/clips',
      {
        game_id: gameId,
        started_at: opts.startedAt,
        ended_at: opts.endedAt,
        first: 100,
        after: cursor,
      }
    )
    out.push(...page.data)
    cursor = page.pagination?.cursor
    pages++
    if (!cursor || page.data.length === 0) break
  } while (pages < maxPages)
  return out
}

/**
 * Enrich a list of user_ids with channel follower counts. /channels/followers
 * is per-channel, but we only need totals — /users covers id/login/display_name.
 * For followers we need /channels/followers?broadcaster_id=ID per channel.
 * Batched 100 IDs/call.
 */
export async function getUsersByIds(
  clientId: string,
  clientSecret: string,
  ids: string[]
): Promise<Map<string, HelixUser>> {
  const result = new Map<string, HelixUser>()
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const params: Record<string, string> = {}
    // Helix /users takes id as repeated param; URLSearchParams handles it.
    const url = new URL(`${HELIX_BASE}/users`)
    for (const id of chunk) url.searchParams.append('id', id)
    const token = await getAppToken(clientId, clientSecret)
    const res = await fetch(url, {
      headers: { 'Client-Id': clientId, 'Authorization': `Bearer ${token}` },
    })
    if (!res.ok) continue
    const data = await res.json() as { data: HelixUser[] }
    for (const u of data.data) result.set(u.id, u)
    void params  // silence unused warning
  }
  return result
}
