/**
 * Territory inference utility
 * Maps domain TLDs, outlet countries, and language codes to human-readable territory labels
 */

// Country-code TLDs → territory labels
const TLD_TO_TERRITORY: Record<string, string> = {
  // Europe
  nl: 'Netherlands', de: 'Germany', fr: 'France', it: 'Italy', es: 'Spain',
  pt: 'Portugal', be: 'Belgium', at: 'Austria', ch: 'Switzerland',
  uk: 'United Kingdom', ie: 'Ireland', se: 'Sweden', no: 'Norway',
  dk: 'Denmark', fi: 'Finland', pl: 'Poland', cz: 'Czech Republic',
  hu: 'Hungary', ro: 'Romania', bg: 'Bulgaria', hr: 'Croatia',
  gr: 'Greece', sk: 'Slovakia', si: 'Slovenia', lt: 'Lithuania',
  lv: 'Latvia', ee: 'Estonia',
  // Americas
  us: 'United States', ca: 'Canada', mx: 'Mexico', br: 'Brazil',
  ar: 'Argentina', cl: 'Chile', co: 'Colombia',
  // Asia-Pacific
  jp: 'Japan', kr: 'South Korea', cn: 'China', tw: 'Taiwan',
  hk: 'Hong Kong', sg: 'Singapore', au: 'Australia', nz: 'New Zealand',
  in: 'India', th: 'Thailand', ph: 'Philippines', id: 'Indonesia',
  my: 'Malaysia', vn: 'Vietnam',
  // Middle East
  tr: 'Turkey', il: 'Israel', ae: 'UAE', sa: 'Saudi Arabia',
  // Russia
  ru: 'Russia', ua: 'Ukraine',
}

// Language codes → territory labels (for social media scanners)
const LANG_TO_TERRITORY: Record<string, string> = {
  en: 'International', nl: 'Netherlands', de: 'Germany', fr: 'France',
  it: 'Italy', es: 'Spain', pt: 'Portugal', 'pt-br': 'Brazil',
  ja: 'Japan', ko: 'South Korea', zh: 'China', 'zh-tw': 'Taiwan',
  ru: 'Russia', pl: 'Poland', cs: 'Czech Republic', hu: 'Hungary',
  ro: 'Romania', bg: 'Bulgaria', hr: 'Croatia', el: 'Greece',
  sv: 'Sweden', no: 'Norway', da: 'Denmark', fi: 'Finland',
  tr: 'Turkey', ar: 'Arabic', hi: 'India', th: 'Thailand',
  vi: 'Vietnam', id: 'Indonesia', ms: 'Malaysia',
}

// Known international/English-language domains (no specific territory)
const INTERNATIONAL_DOMAINS = new Set([
  'ign.com', 'gamespot.com', 'kotaku.com', 'polygon.com', 'pcgamer.com',
  'rockpapershotgun.com', 'eurogamer.net', 'destructoid.com', 'gamesradar.com',
  'theverge.com', 'techradar.com', 'engadget.com', 'wired.com',
  'youtube.com', 'reddit.com', 'twitter.com', 'x.com', 'twitch.tv',
  'tiktok.com', 'instagram.com', 'facebook.com',
  'store.steampowered.com', 'epicgames.com', 'xbox.com', 'playstation.com',
  'nintendo.com', 'metacritic.com', 'opencritic.com',
])

// Known regional outlet domains → territory
const REGIONAL_DOMAINS: Record<string, string> = {
  // Dutch
  'gamer.nl': 'Netherlands', 'tweakers.net': 'Netherlands', 'insidegamer.nl': 'Netherlands',
  'power-unlimited.nl': 'Netherlands', 'gamekings.tv': 'Netherlands',
  // German
  'gamestar.de': 'Germany', 'pcgames.de': 'Germany', 'spieletipps.de': 'Germany',
  '4players.de': 'Germany', 'gamepro.de': 'Germany', 'golem.de': 'Germany',
  // French
  'jeuxvideo.com': 'France', 'gamekult.com': 'France', 'jeuxactu.com': 'France',
  'gameblog.fr': 'France',
  // Italian
  'everyeye.it': 'Italy', 'multiplayer.it': 'Italy', 'spaziogames.it': 'Italy',
  // Spanish
  'vandal.elespanol.com': 'Spain', '3djuegos.com': 'Spain', 'meristation.com': 'Spain',
  // Brazilian
  'theenemy.com.br': 'Brazil', 'tecmundo.com.br': 'Brazil',
  // Japanese
  '4gamer.net': 'Japan', 'famitsu.com': 'Japan', 'dengekionline.com': 'Japan',
  // Russian
  'stopgame.ru': 'Russia', 'igromania.ru': 'Russia',
  // UK-specific
  'eurogamer.net': 'International', // Eurogamer is international
  // Regional Eurogamer
  'eurogamer.de': 'Germany', 'eurogamer.nl': 'Netherlands', 'eurogamer.it': 'Italy',
  'eurogamer.es': 'Spain', 'eurogamer.pt': 'Portugal', 'eurogamer.cz': 'Czech Republic',
}

/**
 * Infer territory from available signals (domain, outlet country, language code).
 * Returns a human-readable territory string or null if unknown.
 *
 * Priority: regional domain match > TLD match > outlet country > language code
 */
export function inferTerritory(
  domain?: string | null,
  outletCountry?: string | null,
  languageCode?: string | null,
): string | null {
  // 1. Check known regional domains first (most accurate)
  if (domain) {
    const cleanDomain = domain.replace('www.', '').toLowerCase()

    // Known regional domain?
    if (REGIONAL_DOMAINS[cleanDomain]) {
      return REGIONAL_DOMAINS[cleanDomain]
    }

    // Known international domain?
    if (INTERNATIONAL_DOMAINS.has(cleanDomain)) {
      return 'International'
    }

    // Extract TLD and check
    const tld = extractTld(cleanDomain)
    if (tld && TLD_TO_TERRITORY[tld]) {
      return TLD_TO_TERRITORY[tld]
    }

    // Generic TLDs (.com, .net, .org, .io, .gg) = International for English-looking domains
    if (['com', 'net', 'org', 'io', 'gg', 'tv'].includes(tld || '')) {
      return 'International'
    }
  }

  // 2. Outlet country field
  if (outletCountry) {
    // Already a proper name? Return as-is
    if (outletCountry.length > 2) return outletCountry
    // 2-letter code? Map it
    const mapped = TLD_TO_TERRITORY[outletCountry.toLowerCase()]
    if (mapped) return mapped
  }

  // 3. Language code from social media
  if (languageCode) {
    const code = languageCode.toLowerCase().trim()
    if (LANG_TO_TERRITORY[code]) return LANG_TO_TERRITORY[code]
    // Try just the first 2 chars (e.g., "en-US" → "en")
    const short = code.split('-')[0]
    if (LANG_TO_TERRITORY[short]) return LANG_TO_TERRITORY[short]
  }

  return null
}

/**
 * Extract the country-code TLD from a domain.
 * Handles compound TLDs like .co.uk
 */
function extractTld(domain: string): string | null {
  const parts = domain.split('.')
  if (parts.length < 2) return null

  // Check for compound TLDs: .co.uk, .com.br, .com.au etc.
  if (parts.length >= 3) {
    const last2 = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`
    if (['co.uk', 'com.br', 'com.au', 'co.jp', 'co.kr', 'com.tw', 'co.nz'].includes(last2)) {
      return parts[parts.length - 1]
    }
  }

  return parts[parts.length - 1]
}

/**
 * Normalize a raw language code to a proper territory label.
 * Use this to clean up existing territory values that are just lang codes.
 */
export function normalizeTerritory(raw: string | null | undefined): string | null {
  if (!raw) return null
  // Already a proper territory name (longer than 2 chars, not a code)?
  if (raw.length > 3 && !raw.includes('-')) return raw
  // Try mapping as language code
  return LANG_TO_TERRITORY[raw.toLowerCase()] || raw
}
