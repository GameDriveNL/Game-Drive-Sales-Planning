/**
 * Genre-based outlet bank.
 *
 * Pre-populated outlet lists per genre, used to proactively subscribe new
 * games to outlets that historically cover that genre. Mirrors the existing
 * defaultSubredditsForGame() pattern at the outlet level — when a horror
 * game is enrolled, we immediately know to monitor Bloody Disgusting, Rely
 * on Horror, Dread Central, etc. without waiting for organic discovery
 * via Tavily.
 *
 * Each entry is structured so that, on enrollment:
 *   1. Outlet row is upserted into outlets table (so future scans recognize it)
 *   2. RSS feed is registered if known
 *   3. The outlet is flagged as priority=true for genre matches
 *
 * Curated from real outlets that consistently cover these genres. New
 * entries should be added as we learn (e.g. from cross-game seeding finding
 * an outlet that covers 3+ of our games — that's a candidate for the bank).
 */

export interface GenreOutletEntry {
  name: string
  domain: string
  country: string
  rss_feed_url: string | null
  monthly_unique_visitors: number | null
  tier: 'A' | 'B' | 'C' | 'D'
}

export const GENRE_OUTLET_BANK: Record<string, GenreOutletEntry[]> = {
  horror: [
    { name: 'Bloody Disgusting', domain: 'bloody-disgusting.com', country: 'US', rss_feed_url: 'https://bloody-disgusting.com/feed/', monthly_unique_visitors: 2_100_000, tier: 'A' },
    { name: 'Rely on Horror', domain: 'relyonhorror.com', country: 'US', rss_feed_url: 'https://relyonhorror.com/feed/', monthly_unique_visitors: 150_000, tier: 'B' },
    { name: 'Dread Central', domain: 'dreadcentral.com', country: 'US', rss_feed_url: 'https://dreadcentral.com/feed/', monthly_unique_visitors: 800_000, tier: 'B' },
    { name: 'Fangoria', domain: 'fangoria.com', country: 'US', rss_feed_url: 'https://fangoria.com/feed/', monthly_unique_visitors: 400_000, tier: 'B' },
    { name: 'iHorror', domain: 'ihorror.com', country: 'US', rss_feed_url: 'https://ihorror.com/feed/', monthly_unique_visitors: 250_000, tier: 'B' },
    { name: 'Alpha Beta Gamer', domain: 'alphabetagamer.com', country: 'UK', rss_feed_url: 'https://www.alphabetagamer.com/feed/', monthly_unique_visitors: 205_000, tier: 'B' },
    { name: 'Indie Game Lover', domain: 'indiegamelover.com', country: 'US', rss_feed_url: 'https://indiegamelover.com/feed/', monthly_unique_visitors: 50_000, tier: 'C' },
    { name: 'Indie Horror', domain: 'indiehorror.tv', country: 'US', rss_feed_url: null, monthly_unique_visitors: 30_000, tier: 'C' },
  ],
  indie: [
    { name: 'Indie Game Lover', domain: 'indiegamelover.com', country: 'US', rss_feed_url: 'https://indiegamelover.com/feed/', monthly_unique_visitors: 50_000, tier: 'C' },
    { name: 'Indie Game Reviewer', domain: 'indiegamereviewer.com', country: 'US', rss_feed_url: 'https://www.indiegamereviewer.com/feed/', monthly_unique_visitors: 100_000, tier: 'B' },
    { name: 'Rock Paper Shotgun', domain: 'rockpapershotgun.com', country: 'UK', rss_feed_url: 'https://www.rockpapershotgun.com/feed', monthly_unique_visitors: 3_000_000, tier: 'A' },
    { name: 'PC Gamer', domain: 'pcgamer.com', country: 'US', rss_feed_url: 'https://www.pcgamer.com/rss/', monthly_unique_visitors: 12_000_000, tier: 'A' },
    { name: 'Alpha Beta Gamer', domain: 'alphabetagamer.com', country: 'UK', rss_feed_url: 'https://www.alphabetagamer.com/feed/', monthly_unique_visitors: 205_000, tier: 'B' },
  ],
  rpg: [
    { name: 'RPG Site', domain: 'rpgsite.net', country: 'US', rss_feed_url: 'https://www.rpgsite.net/rss.xml', monthly_unique_visitors: 500_000, tier: 'B' },
    { name: 'RPGFan', domain: 'rpgfan.com', country: 'US', rss_feed_url: 'https://www.rpgfan.com/feed/', monthly_unique_visitors: 200_000, tier: 'B' },
    { name: 'TouchArcade', domain: 'toucharcade.com', country: 'US', rss_feed_url: 'https://toucharcade.com/feed/', monthly_unique_visitors: 600_000, tier: 'B' },
  ],
  roguelike: [
    { name: 'Rogueliker', domain: 'rogueliker.com', country: 'US', rss_feed_url: null, monthly_unique_visitors: 20_000, tier: 'D' },
    { name: 'Indie Game Reviewer', domain: 'indiegamereviewer.com', country: 'US', rss_feed_url: 'https://www.indiegamereviewer.com/feed/', monthly_unique_visitors: 100_000, tier: 'B' },
  ],
  strategy: [
    { name: 'Strategy Gamer', domain: 'strategygamer.com', country: 'UK', rss_feed_url: 'https://www.strategygamer.com/feed/', monthly_unique_visitors: 100_000, tier: 'B' },
    { name: 'Wargamer', domain: 'wargamer.com', country: 'UK', rss_feed_url: 'https://www.wargamer.com/feed', monthly_unique_visitors: 300_000, tier: 'B' },
    { name: 'Rock Paper Shotgun', domain: 'rockpapershotgun.com', country: 'UK', rss_feed_url: 'https://www.rockpapershotgun.com/feed', monthly_unique_visitors: 3_000_000, tier: 'A' },
  ],
  simulation: [
    { name: 'Rock Paper Shotgun', domain: 'rockpapershotgun.com', country: 'UK', rss_feed_url: 'https://www.rockpapershotgun.com/feed', monthly_unique_visitors: 3_000_000, tier: 'A' },
    { name: 'PC Gamer', domain: 'pcgamer.com', country: 'US', rss_feed_url: 'https://www.pcgamer.com/rss/', monthly_unique_visitors: 12_000_000, tier: 'A' },
  ],
  puzzle: [
    { name: 'Indie Game Lover', domain: 'indiegamelover.com', country: 'US', rss_feed_url: 'https://indiegamelover.com/feed/', monthly_unique_visitors: 50_000, tier: 'C' },
  ],
  racing: [
    { name: 'Traxion', domain: 'traxion.gg', country: 'UK', rss_feed_url: 'https://traxion.gg/feed/', monthly_unique_visitors: 200_000, tier: 'B' },
    { name: 'GTPlanet', domain: 'gtplanet.net', country: 'US', rss_feed_url: 'https://www.gtplanet.net/feed/', monthly_unique_visitors: 500_000, tier: 'B' },
  ],
}

/**
 * Map free-text genre keywords to bank category. e.g. 'mascot horror' → 'horror',
 * 'extraction shooter roguelike' → ['shooter', 'roguelike'].
 */
export function detectGenres(text: string): string[] {
  const lower = text.toLowerCase()
  const matched = new Set<string>()
  const keywords: Record<string, string[]> = {
    horror: ['horror', 'mascot horror', 'psychological horror', 'survival horror'],
    indie: ['indie'],
    rpg: ['rpg', 'role-playing', 'jrpg', 'crpg'],
    roguelike: ['roguelike', 'roguelite'],
    strategy: ['strategy', '4x', 'rts', 'turn-based'],
    simulation: ['simulation', 'sim ', 'tycoon', 'management'],
    puzzle: ['puzzle'],
    racing: ['racing', 'racer', 'driving sim'],
  }
  for (const [genre, hints] of Object.entries(keywords)) {
    if (hints.some(h => lower.includes(h))) matched.add(genre)
  }
  return Array.from(matched)
}

/**
 * Resolve the union of outlet entries across the detected genres. Dedupes
 * by domain so an outlet listed under multiple genres only appears once.
 */
export function outletsForGenres(genres: string[]): GenreOutletEntry[] {
  const byDomain = new Map<string, GenreOutletEntry>()
  for (const g of genres) {
    const entries = GENRE_OUTLET_BANK[g] || []
    for (const e of entries) {
      if (!byDomain.has(e.domain)) byDomain.set(e.domain, e)
    }
  }
  return Array.from(byDomain.values())
}
