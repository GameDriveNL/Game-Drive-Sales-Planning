/**
 * Twitch GraphQL (unauthenticated) wrapper.
 *
 * Twitch's web client uses a public Client-Id ("kimne78kx3ncx6brgo4mv6wki5h1ko")
 * with their GQL endpoint. Anonymous queries against gql.twitch.tv work for
 * read-only resources like game directories, channel info, VODs, and clips.
 * No OAuth, no API key.
 *
 * This is what Twitch's own web app uses for unauthenticated browsers, so
 * it's stable in practice — but it's not a documented public API, and Twitch
 * could change access patterns. Treat as best-effort with graceful fallback
 * to the Apify scraper.
 *
 * We use it to:
 *   - Resolve a game name → Twitch game ID (some games have weird canonical
 *     names)
 *   - List recently-broadcasted VODs for a game
 *   - List currently-live channels for a game
 *   - List clips for a game within a time window
 *
 * Rate limit: Twitch tolerates ~30 requests/second from an IP without auth
 * before rate-limiting. We stay well under that.
 */

// Public client ID used by Twitch's own browser client. Stable for years.
const PUBLIC_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'
const ENDPOINT = 'https://gql.twitch.tv/gql'

export interface TwitchVOD {
  id: string
  title: string
  url: string
  createdAt: string
  publishedAt: string | null
  lengthSeconds: number
  viewCount: number
  channel: {
    id: string
    login: string
    displayName: string
    followers: number | null
  }
}

export interface TwitchLiveStream {
  channelLogin: string
  channelDisplayName: string
  channelId: string
  title: string
  viewers: number
  startedAt: string
}

export interface TwitchClip {
  slug: string
  title: string
  url: string
  viewCount: number
  createdAt: string
  durationSeconds: number
  broadcaster: { login: string; displayName: string }
}

interface GqlResponse<T> {
  data?: T
  errors?: Array<{ message: string }>
}

async function gqlQuery<T>(operationName: string, query: string, variables: Record<string, unknown>): Promise<T | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Client-Id': PUBLIC_CLIENT_ID,
        'Content-Type': 'application/json',
        // Twitch's anonymous GQL responds without an auth header but they look
        // at the user-agent for abuse heuristics; impersonate the canonical
        // browser client to avoid quiet blocks.
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
      signal: controller.signal,
      body: JSON.stringify([{ operationName, query, variables }]),
    })
    clearTimeout(timer)
    if (!res.ok) {
      console.warn(`[twitch-gql] ${operationName} HTTP ${res.status}`)
      return null
    }
    const arr = await res.json() as GqlResponse<T>[]
    const first = Array.isArray(arr) ? arr[0] : (arr as unknown as GqlResponse<T>)
    if (first.errors && first.errors.length > 0) {
      console.warn(`[twitch-gql] ${operationName} errors:`, first.errors.map(e => e.message).join(', '))
      return null
    }
    return first.data ?? null
  } catch (err) {
    console.warn(`[twitch-gql] ${operationName} threw:`, err instanceof Error ? err.message : String(err))
    return null
  }
}

/**
 * Resolve a game name to Twitch's canonical game ID.
 * Returns null if not found.
 */
export async function resolveGameId(gameName: string): Promise<string | null> {
  const query = `
    query GameByName($name: String!) {
      game(name: $name) { id name }
    }
  `
  const data = await gqlQuery<{ game?: { id: string; name: string } | null }>(
    'GameByName', query, { name: gameName }
  )
  return data?.game?.id ?? null
}

/**
 * List recently-broadcasted VODs (past streams) for a game. Twitch retains
 * VODs for 14-60 days depending on tier, so this is your window for
 * recently-active streamers.
 */
export async function getRecentVODs(gameId: string, first = 50): Promise<TwitchVOD[]> {
  // Note: Twitch removed the `options` argument from Game.videos sometime in
  // 2024; the current schema accepts sort/type at the top level.
  const query = `
    query DirectoryVideos_Game($id: ID!, $first: Int!) {
      game(id: $id) {
        videos(first: $first, sort: TIME) {
          edges {
            node {
              id
              title
              createdAt
              publishedAt
              lengthSeconds
              viewCount
              owner {
                id
                login
                displayName
                followers { totalCount }
              }
            }
          }
        }
      }
    }
  `
  const data = await gqlQuery<{
    game?: { videos?: { edges?: Array<{ node: {
      id: string; title: string; createdAt: string; publishedAt: string | null;
      lengthSeconds: number; viewCount: number;
      owner: { id: string; login: string; displayName: string; followers?: { totalCount?: number } | null }
    } }> } }
  }>('DirectoryVideos_Game', query, { id: gameId, first })

  const edges = data?.game?.videos?.edges || []
  return edges.map(e => ({
    id: e.node.id,
    title: e.node.title,
    url: `https://www.twitch.tv/videos/${e.node.id}`,
    createdAt: e.node.createdAt,
    publishedAt: e.node.publishedAt,
    lengthSeconds: e.node.lengthSeconds,
    viewCount: e.node.viewCount,
    channel: {
      id: e.node.owner.id,
      login: e.node.owner.login,
      displayName: e.node.owner.displayName,
      followers: e.node.owner.followers?.totalCount ?? null,
    },
  }))
}

/**
 * List currently-live streams for a game.
 */
export async function getLiveStreams(gameId: string, first = 50): Promise<TwitchLiveStream[]> {
  const query = `
    query DirectoryPage_Game($id: ID!, $first: Int!) {
      game(id: $id) {
        streams(first: $first, options: { sort: VIEWER_COUNT }) {
          edges {
            node {
              id
              title
              viewersCount
              createdAt
              broadcaster { id login displayName }
            }
          }
        }
      }
    }
  `
  const data = await gqlQuery<{
    game?: { streams?: { edges?: Array<{ node: {
      id: string; title: string; viewersCount: number; createdAt: string;
      broadcaster: { id: string; login: string; displayName: string }
    } }> } }
  }>('DirectoryPage_Game', query, { id: gameId, first })

  const edges = data?.game?.streams?.edges || []
  return edges.map(e => ({
    channelLogin: e.node.broadcaster.login,
    channelDisplayName: e.node.broadcaster.displayName,
    channelId: e.node.broadcaster.id,
    title: e.node.title,
    viewers: e.node.viewersCount,
    startedAt: e.node.createdAt,
  }))
}

/**
 * List top clips for a game within a time window.
 */
export async function getTopClips(gameId: string, periodDays: number, first = 50): Promise<TwitchClip[]> {
  // Twitch GQL ClipsFilter accepts LAST_DAY, LAST_WEEK, LAST_MONTH, ALL_TIME
  const period = periodDays <= 1 ? 'LAST_DAY'
    : periodDays <= 7 ? 'LAST_WEEK'
    : periodDays <= 30 ? 'LAST_MONTH'
    : 'ALL_TIME'
  const query = `
    query ClipsCards__Game($id: ID!, $first: Int!, $filter: ClipsPeriod!) {
      game(id: $id) {
        clips(first: $first, criteria: { period: $filter, sort: VIEWS_DESC }) {
          edges {
            node {
              slug
              title
              url
              viewCount
              createdAt
              durationSeconds
              broadcaster { login displayName }
            }
          }
        }
      }
    }
  `
  const data = await gqlQuery<{
    game?: { clips?: { edges?: Array<{ node: {
      slug: string; title: string; url: string; viewCount: number;
      createdAt: string; durationSeconds: number;
      broadcaster: { login: string; displayName: string }
    } }> } }
  }>('ClipsCards__Game', query, { id: gameId, first, filter: period })

  const edges = data?.game?.clips?.edges || []
  return edges.map(e => ({
    slug: e.node.slug,
    title: e.node.title,
    url: e.node.url,
    viewCount: e.node.viewCount,
    createdAt: e.node.createdAt,
    durationSeconds: e.node.durationSeconds,
    broadcaster: { login: e.node.broadcaster.login, displayName: e.node.broadcaster.displayName },
  }))
}
