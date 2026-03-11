/**
 * Outlet name utilities — extract clean, human-readable outlet names from URLs/domains
 */

// Well-known domain → display name mappings
const KNOWN_OUTLETS: Record<string, string> = {
  // Major gaming outlets
  'ign.com': 'IGN',
  'gamespot.com': 'GameSpot',
  'kotaku.com': 'Kotaku',
  'polygon.com': 'Polygon',
  'pcgamer.com': 'PC Gamer',
  'rockpapershotgun.com': 'Rock Paper Shotgun',
  'eurogamer.net': 'Eurogamer',
  'destructoid.com': 'Destructoid',
  'gamesradar.com': 'GamesRadar+',
  'thegamer.com': 'TheGamer',
  'gamerant.com': 'Game Rant',
  'gameinformer.com': 'Game Informer',
  'pushsquare.com': 'Push Square',
  'nintendolife.com': 'Nintendo Life',
  'purexbox.com': 'Pure Xbox',
  'dualshockers.com': 'DualShockers',
  'siliconera.com': 'Siliconera',
  'toucharcade.com': 'TouchArcade',
  'pocketgamer.com': 'Pocket Gamer',
  'hardcoregamer.com': 'Hardcore Gamer',
  'rpgsite.net': 'RPG Site',
  'noisypixel.net': 'Noisy Pixel',
  'gamingbolt.com': 'GamingBolt',
  'mp1st.com': 'MP1st',
  'twinfinite.net': 'Twinfinite',
  'screenrant.com': 'Screen Rant',
  'comicbook.com': 'ComicBook.com',
  'cbr.com': 'CBR',
  'vg247.com': 'VG247',
  'videogameschronicle.com': 'VGC',
  'wccftech.com': 'WCCFTech',
  'dexerto.com': 'Dexerto',
  'pcgamesn.com': 'PCGamesN',
  'shacknews.com': 'Shacknews',
  'escapistmagazine.com': 'The Escapist',
  'metacritic.com': 'Metacritic',
  'opencritic.com': 'OpenCritic',
  'howlongtobeat.com': 'HowLongToBeat',
  'savingcontent.com': 'Saving Content',
  'gamingdebugged.com': 'Gaming Debugged',
  'games.gg': 'GAMES.GG',
  'gamerbraves.com': 'GamerBraves',

  // Dutch outlets
  'gamer.nl': 'Gamer.nl',
  'tweakers.net': 'Tweakers',
  'insidegamer.nl': 'InsideGamer',
  'power-unlimited.nl': 'Power Unlimited',
  'gamekings.tv': 'Gamekings',
  'dailynintendo.nl': 'Daily Nintendo',

  // German outlets
  'gamestar.de': 'GameStar',
  'pcgames.de': 'PC Games',
  'spieletipps.de': 'Spieletipps',
  '4players.de': '4Players',
  'gamepro.de': 'GamePro',
  'golem.de': 'Golem',

  // French outlets
  'jeuxvideo.com': 'JeuxVideo.com',
  'gamekult.com': 'Gamekult',
  'jvfrance.com': 'JV France',

  // Spanish outlets
  'vandal.elespanol.com': 'Vandal',
  '3djuegos.com': '3DJuegos',
  'zonammmorpg.com': 'ZonaMMORpg',
  'zonammorpg.com': 'ZonaMMORpg',

  // Italian outlets
  'everyeye.it': 'Everyeye',
  'multiplayer.it': 'Multiplayer.it',

  // Japanese outlets
  'famitsu.com': 'Famitsu',
  '4gamer.net': '4Gamer',
  'gamespark.jp': 'Game Spark',
  'gamewith.jp': 'GameWith',
  'denfaminicogamer.jp': 'Denfaminicogamer',

  // Latin American outlets
  'latam.ign.com': 'IGN Latinoamérica',

  // Southeast Asian outlets
  'sea.ign.com': 'IGN Southeast Asia',

  // Platforms / storefronts
  'store.steampowered.com': 'Steam Store',
  'store.playstation.com': 'PlayStation Store',
  'xbox.com': 'Xbox',
  'playstation.com': 'PlayStation',
  'nintendo.com': 'Nintendo',
  'epicgames.com': 'Epic Games Store',

  // Social / video platforms
  'youtube.com': 'YouTube',
  'reddit.com': 'Reddit',
  'twitter.com': 'Twitter/X',
  'x.com': 'X (Twitter)',
  'twitch.tv': 'Twitch',
  'tiktok.com': 'TikTok',
  'instagram.com': 'Instagram',
  'facebook.com': 'Facebook',
  'dailymotion.com': 'Dailymotion',

  // Tech / general
  'theverge.com': 'The Verge',
  'techradar.com': 'TechRadar',
  'engadget.com': 'Engadget',
  'wired.com': 'Wired',
  'arstechnica.com': 'Ars Technica',

  // Nintendo-specific
  'gonintendo.com': 'GoNintendo',
  'nintendoeverything.com': 'Nintendo Everything',
  'nintendobserver.com': 'Nintendo Observer',

  // PlayStation-specific
  'playstationlifestyle.net': 'PlayStation Lifestyle',
  'psu.com': 'PlayStation Universe',

  // Total Mayhem Games specific
  'totalmayehemgames.com': 'Total Mayhem Games',
  'totalmayemgames.com': 'Total Mayhem Games',
  'totalmayhem.com': 'Total Mayhem Games',
  'totalmayheemgames.com': 'Total Mayhem Games',
  'totalmayhamgames.com': 'Total Mayhem Games',
  'totalmayhmgames.com': 'Total Mayhem Games',
}

/**
 * Extract a clean domain from a URL
 */
export function extractDomain(url: string): string | null {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '')
    return hostname || null
  } catch {
    return null
  }
}

/**
 * Derive a clean, human-readable outlet name from a URL or domain
 *
 * Priority:
 * 1. Check known outlet mappings (exact domain match)
 * 2. Check known outlet mappings (subdomain match, e.g. latam.ign.com → IGN Latinoamérica)
 * 3. Generate a clean name from the domain
 */
export function domainToOutletName(domainOrUrl: string): string {
  let domain: string
  try {
    // If it looks like a URL, extract domain
    if (domainOrUrl.includes('://') || domainOrUrl.includes('/')) {
      domain = new URL(domainOrUrl.startsWith('http') ? domainOrUrl : `https://${domainOrUrl}`).hostname.replace(/^www\./, '')
    } else {
      domain = domainOrUrl.replace(/^www\./, '')
    }
  } catch {
    domain = domainOrUrl.replace(/^www\./, '')
  }

  const domainLower = domain.toLowerCase()

  // 1. Exact match in known outlets
  if (KNOWN_OUTLETS[domainLower]) {
    return KNOWN_OUTLETS[domainLower]
  }

  // 2. Check with subdomain preserved (e.g., latam.ign.com)
  for (const [knownDomain, name] of Object.entries(KNOWN_OUTLETS)) {
    if (domainLower === knownDomain || domainLower.endsWith('.' + knownDomain)) {
      return name
    }
  }

  // 3. Check parent domain (e.g., news.denfaminicogamer.jp → check denfaminicogamer.jp)
  const parts = domainLower.split('.')
  if (parts.length > 2) {
    const parentDomain = parts.slice(1).join('.')
    if (KNOWN_OUTLETS[parentDomain]) {
      return KNOWN_OUTLETS[parentDomain]
    }
  }

  // 4. Generate a clean name from domain
  // Remove TLD(s) and split into words
  const cleaned = domain
    .replace(/\.(com|net|org|co\.uk|co\.jp|com\.br|com\.au|io|gg|tv|info|me|cc|dev|app|news|games)$/i, '')
    .replace(/\./g, ' ')

  // Capitalize each word
  return cleaned
    .split(/[\s\-_]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Get the best available outlet name for a coverage item
 * Falls back through: outlet.name → domain lookup → URL extraction → "Unknown"
 */
export function getOutletDisplayName(
  outlet: { name?: string; domain?: string | null } | null,
  url?: string | null
): string {
  // 1. Outlet has a name that isn't just a raw domain
  if (outlet?.name && outlet.name !== 'Unknown') {
    return outlet.name
  }

  // 2. Use outlet domain to look up known name
  if (outlet?.domain) {
    return domainToOutletName(outlet.domain)
  }

  // 3. Extract domain from URL
  if (url) {
    const domain = extractDomain(url)
    if (domain) {
      return domainToOutletName(domain)
    }
  }

  return 'Unknown'
}
