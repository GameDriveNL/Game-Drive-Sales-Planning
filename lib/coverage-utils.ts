/**
 * Coverage utility functions — domain classification, URL helpers, game matching
 */

// ── Game matching ──────────────────────────────────────────────────────

interface GameInfo {
  id: string
  name: string
  client_id: string
}

interface KeywordInfo {
  keyword: string
  client_id: string
  game_id: string | null
}

/**
 * Try to match article text to a specific game. Returns the game_id or null.
 *
 * Strategy (in order):
 * 1. Check if the matched keyword has a game_id → use that game
 * 2. Check if any game name appears in the title or description (case-insensitive)
 * 3. Check if any game-specific keyword appears in the title (case-insensitive)
 *
 * If no game can be determined, returns null.
 */
export function matchGameFromContent(
  title: string,
  description: string,
  matchedKeywords: string[],
  allKeywords: KeywordInfo[],
  clientGames: GameInfo[]
): string | null {
  const titleLower = title.toLowerCase()
  const descLower = description.toLowerCase()
  const combinedLower = `${titleLower} ${descLower}`

  // Strategy 1: Check if matched keywords have a game_id
  for (const mk of matchedKeywords) {
    const kwInfo = allKeywords.find(
      k => k.keyword.toLowerCase() === mk.toLowerCase() && k.game_id
    )
    if (kwInfo?.game_id) return kwInfo.game_id
  }

  // Strategy 2: Check if any game name appears in title or description
  // Sort by name length descending so "We Were Here Forever" matches before "We Were Here"
  const sortedGames = [...clientGames].sort((a, b) => b.name.length - a.name.length)
  for (const game of sortedGames) {
    if (combinedLower.includes(game.name.toLowerCase())) {
      return game.id
    }
  }

  // Strategy 3: Check game-specific keywords against title
  for (const game of sortedGames) {
    const gameKeywords = allKeywords.filter(
      k => k.game_id === game.id && k.keyword.toLowerCase() !== game.name.toLowerCase()
    )
    for (const gk of gameKeywords) {
      if (titleLower.includes(gk.keyword.toLowerCase())) {
        return game.id
      }
    }
  }

  return null
}

/** Domains that should be auto-classified as 'informational' coverage type.
 *  These are non-press pages (game storefronts, wikis, databases) that
 *  inflate UMV numbers and aren't real press coverage. */
const INFORMATIONAL_DOMAINS = [
  'wikipedia.org',
  'store.steampowered.com',
  'steamcommunity.com',
  'steamdb.info',
]

/**
 * Returns true if the given URL belongs to an informational (non-press) domain.
 * Matches exact domain or any subdomain (e.g. en.wikipedia.org).
 */
export function isInformationalUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return INFORMATIONAL_DOMAINS.some(
      d => hostname === d || hostname.endsWith('.' + d)
    )
  } catch {
    return false
  }
}

/**
 * Given a coverage_type value (which may be null/undefined) and a URL,
 * returns the appropriate coverage_type. If the URL is informational and
 * no explicit type was provided (or it was 'news'), overrides to 'informational'.
 */
export function classifyCoverageType(
  coverageType: string | null | undefined,
  url: string
): string | null {
  if (isInformationalUrl(url)) {
    return 'informational'
  }
  return coverageType || null
}
