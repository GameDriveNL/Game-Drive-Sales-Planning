/**
 * Twitch GQL "language × period × sort" fanout.
 *
 * The official Twitch GraphQL endpoint at gql.twitch.tv requires a per-page
 * integrity token for cursor pagination. We bypass that constraint by NOT
 * paginating — instead we enumerate every combination of (language × period
 * × sort) which returns a distinct page-1. Each combination returns up to
 * 100 broadcasters; the union across ~150 calls yields ~300 unique
 * broadcasters per game (verified against Dark Pals: 302).
 *
 * Anonymous Client-ID `kimne78kx3ncx6brgo4mv6wki5h1ko` is the one shipped
 * inside twitch.tv's own JS bundle — community-stable for 5+ years (cited
 * by streamlink, twitch-dl, twitch-tools).
 *
 * Rate limits: unmetered for anonymous read queries in our tests
 * (30 parallel calls succeeded with zero errors).
 *
 * IMPORTANT: clips enum vs videos enum differ:
 *   clips.languages: uppercase enum (EN, DE, ES, FR, RU, …)
 *   videos.languages: lowercase string ("en", "de", …)
 *   clips.sort:      VIEWS_DESC | TRENDING
 *   videos.sort:     TIME | VIEWS
 *   clips.period:    ALL_TIME | LAST_MONTH | LAST_WEEK | LAST_DAY
 */

const GQL_ENDPOINT = 'https://gql.twitch.tv/gql'
const ANON_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'

// Languages with measurable Twitch streaming activity. Tested for Dark Pals:
// EN, DE, ES, FR, RU contributed the most unique broadcasters; PT, JA, KO,
// IT, PL, TR, ZH, NL added long-tail. Adding 22 langs across both clips and
// videos endpoints maximises recall without runaway cost.
export const CLIP_LANG_ENUM = [
  'EN', 'ES', 'PT', 'DE', 'FR', 'RU', 'JA', 'KO', 'IT', 'PL', 'TR',
  'ZH', 'NL', 'TH', 'ID',
] as const
export const VIDEO_LANG_STR = [
  'en', 'es', 'pt', 'de', 'fr', 'ru', 'ja', 'ko', 'it', 'pl', 'tr',
  'zh', 'nl', 'th', 'id', 'ar', 'vi', 'cs', 'hu', 'fi', 'sv', 'da',
] as const

export const CLIP_PERIODS = ['ALL_TIME', 'LAST_MONTH', 'LAST_WEEK', 'LAST_DAY'] as const
export const CLIP_SORTS = ['VIEWS_DESC', 'TRENDING'] as const
export const VIDEO_SORTS = ['TIME', 'VIEWS'] as const

export interface FanoutBroadcaster {
  login: string
  displayName?: string
  source: 'clip' | 'video' | 'searchFor'
  signal: string  // e.g. "clip:EN:ALL_TIME:VIEWS_DESC"
  viewCount?: number
  createdAt?: string
  title?: string
  videoOrClipId?: string
}

interface ClipNode {
  id?: string
  title?: string
  viewCount?: number
  createdAt?: string
  broadcaster?: { login?: string; displayName?: string }
}
interface VideoNode {
  id?: string
  title?: string
  viewCount?: number
  createdAt?: string
  owner?: { login?: string; displayName?: string }
}

async function gqlPost(query: string): Promise<unknown> {
  try {
    const res = await fetch(GQL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Client-ID': ANON_CLIENT_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Resolve game by name → numeric game_id. Result is stable; cache it on
 * coverage_sources.config so we don't re-resolve every run.
 */
export async function getGameIdByName(name: string): Promise<string | null> {
  const q = `query { game(name: ${JSON.stringify(name)}) { id } }`
  const r = await gqlPost(q) as { data?: { game?: { id?: string } } } | null
  return r?.data?.game?.id ?? null
}

/**
 * Single clip-page query for one (lang, period, sort) combination.
 */
async function clipPage(gameId: string, lang: string, period: string, sort: string): Promise<ClipNode[]> {
  const q = `query { game(id:"${gameId}") {
    clips(first:100, criteria:{period:${period},sort:${sort},languages:[${lang}]}) {
      edges { node { id title viewCount createdAt broadcaster { login displayName } } }
    }
  }}`
  const r = await gqlPost(q) as { data?: { game?: { clips?: { edges?: Array<{ node?: ClipNode }> } } } } | null
  return (r?.data?.game?.clips?.edges ?? []).map(e => e.node).filter((n): n is ClipNode => !!n)
}

/**
 * Single video-page query for one (lang, sort) combination.
 */
async function videoPage(gameId: string, lang: string, sort: string): Promise<VideoNode[]> {
  const q = `query { game(id:"${gameId}") {
    videos(first:100, languages:["${lang}"], sort:${sort}) {
      edges { node { id title viewCount createdAt owner { login displayName } } }
    }
  }}`
  const r = await gqlPost(q) as { data?: { game?: { videos?: { edges?: Array<{ node?: VideoNode }> } } } } | null
  return (r?.data?.game?.videos?.edges ?? []).map(e => e.node).filter((n): n is VideoNode => !!n)
}

/**
 * "searchFor" picks up broadcasters whose channel description/title contains
 * the game name. Different surface than the clip/video catalog.
 */
async function searchForBroadcasters(query: string): Promise<Array<{ login: string; displayName?: string }>> {
  const q = `query { searchFor(userQuery: ${JSON.stringify(query)}, platform: "web") {
    channels { edges { item { login displayName } } }
  }}`
  const r = await gqlPost(q) as {
    data?: { searchFor?: { channels?: { edges?: Array<{ item?: { login?: string; displayName?: string } }> } } }
  } | null
  return (r?.data?.searchFor?.channels?.edges ?? [])
    .map(e => e.item)
    .filter((it): it is { login: string; displayName?: string } => !!it?.login)
}

/**
 * Run the full fanout for a game. Concurrent execution batched in groups of 30
 * — Twitch GQL accepted 30 parallel requests in our smoke test without rate
 * limiting. Total fanout = ~150 calls completing in ~3 seconds.
 *
 * Returns a Map keyed by broadcaster login (lowercased) so callers can union
 * with other sources by login.
 */
export async function fanoutBroadcasters(
  gameId: string,
  gameName: string,
  opts: { maxConcurrency?: number } = {},
): Promise<Map<string, FanoutBroadcaster>> {
  const all = new Map<string, FanoutBroadcaster>()
  const conc = opts.maxConcurrency ?? 30

  // Build the call list
  type Task = () => Promise<void>
  const tasks: Task[] = []

  for (const lang of CLIP_LANG_ENUM) {
    for (const period of CLIP_PERIODS) {
      for (const sort of CLIP_SORTS) {
        tasks.push(async () => {
          const clips = await clipPage(gameId, lang, period, sort)
          for (const c of clips) {
            const login = c.broadcaster?.login?.toLowerCase()
            if (!login || all.has(login)) continue
            all.set(login, {
              login,
              displayName: c.broadcaster?.displayName,
              source: 'clip',
              signal: `clip:${lang}:${period}:${sort}`,
              viewCount: c.viewCount,
              createdAt: c.createdAt,
              title: c.title,
              videoOrClipId: c.id,
            })
          }
        })
      }
    }
  }

  for (const lang of VIDEO_LANG_STR) {
    for (const sort of VIDEO_SORTS) {
      tasks.push(async () => {
        const videos = await videoPage(gameId, lang, sort)
        for (const v of videos) {
          const login = v.owner?.login?.toLowerCase()
          if (!login || all.has(login)) continue
          all.set(login, {
            login,
            displayName: v.owner?.displayName,
            source: 'video',
            signal: `video:${lang}:${sort}`,
            viewCount: v.viewCount,
            createdAt: v.createdAt,
            title: v.title,
            videoOrClipId: v.id,
          })
        }
      })
    }
  }

  tasks.push(async () => {
    const channels = await searchForBroadcasters(gameName)
    for (const ch of channels) {
      const login = ch.login.toLowerCase()
      if (all.has(login)) continue
      all.set(login, {
        login,
        displayName: ch.displayName,
        source: 'searchFor',
        signal: 'searchFor',
      })
    }
  })

  // Concurrency-limited execution
  for (let i = 0; i < tasks.length; i += conc) {
    await Promise.all(tasks.slice(i, i + conc).map(t => t()))
  }

  return all
}
