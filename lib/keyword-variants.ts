/**
 * Keyword variant generator for PR coverage scraping.
 *
 * Combines deterministic morphology (no-space form, slug, studio name) with
 * Tavily-discovered patterns from how the world actually refers to the game.
 *
 * The deterministic layer always works (no network). The Tavily layer adds
 * variants we'd never guess — short forms, creator-channel names, recurring
 * descriptors ("mascot horror"). Tavily failures degrade gracefully to the
 * deterministic-only set.
 */

import { tavily } from '@tavily/core'

export interface VariantInput {
  gameName: string
  studioName?: string | null
  /** Steam game blurb or any extra hint text to seed n-gram extraction. */
  contextText?: string | null
}

export interface VariantResult {
  variants: string[]
  hashtags: string[]
  /** Subreddit candidates harvested from result URLs (e.g. r/HorrorGaming). */
  subreddits: string[]
  /** Source breakdown for debugging — { kind: 'deterministic' | 'tavily' }[] */
  trace: Array<{ value: string; kind: 'deterministic' | 'tavily' }>
}

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'for', 'with', 'of', 'in', 'on', 'at',
  'to', 'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'will',
  'this', 'that', 'it', 'its', 'as', 'by', 'from', 'new', 'now', 'official',
  'video', 'trailer', 'gameplay', 'review', 'preview', 'demo', 'walkthrough',
  'episode', 'part', 'play', 'playing', 'first', 'last', 'best', 'full', 'free',
  'watch', 'youtube', 'twitch', 'steam', 'pc', 'game', 'games', 'gaming',
  'release', 'announcement', 'announces', 'reveals', 'reveal', 'launch', 'launches',
])

/**
 * Phrases that recur on storefront/aggregator pages but have zero discriminating
 * power. Without this filter, Steam's "All Reviews / Very Positive" UI strings
 * and IGN's "Official Trailer" boilerplate get scored as high-frequency n-grams
 * and added as keyword variants — they'd match every Steam page on the web.
 */
const NOISE_PHRASES = new Set([
  'all reviews',
  'very positive',
  'mostly positive',
  'mostly negative',
  'mixed reviews',
  'overwhelmingly positive',
  'official trailer',
  'official gameplay',
  'official reveal',
  'release date',
  'steam store',
  'steam community',
  'steam news',
  'steam next fest',
  'add to wishlist',
  'add to cart',
  'youtube channel',
  'video games',
  'pc gaming',
  'play online',
  'free demo',
  'coming soon',
  'available now',
  'early access',
])

const GENERIC_TITLE_FRAGMENTS = [
  /– IGN.*$/i,
  /- IGN.*$/i,
  /\| IGN.*$/i,
  /- YouTube.*$/i,
  /- Reddit.*$/i,
  /- Steam.*$/i,
  / on Steam.*$/i,
  / on YouTube.*$/i,
  / on Reddit.*$/i,
  / - Bloody Disgusting.*$/i,
  / - COGconnected.*$/i,
  / - GameFAQs.*$/i,
  / - SteamDB.*$/i,
  / - Games Press.*$/i,
  /^Steam Community :: /i,
  /^Steam-samfunn :: /i,
]

function deterministic(input: VariantInput): string[] {
  const out = new Set<string>()
  const name = input.gameName.trim()
  out.add(name)

  // No-space, alphanumeric only (catches DarkPalsThe1stFloor and similar hashtag-style forms)
  const noSpace = name.replace(/[^a-zA-Z0-9]/g, '')
  if (noSpace.length >= 4 && noSpace.toLowerCase() !== name.toLowerCase()) {
    out.add(noSpace)
  }

  // Slug (catches hyphenated SEO forms commonly used by news outlets)
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  if (slug.length >= 4 && slug !== name.toLowerCase()) {
    out.add(slug)
  }

  // Short form: everything before the first colon or dash
  // "Dark Pals: The 1st Floor" -> "Dark Pals". Highly useful — most informal
  // coverage uses the short form.
  const shortMatch = name.match(/^([^:–-]+)[:–-]/)
  if (shortMatch) {
    const short = shortMatch[1].trim()
    if (short.length >= 4 && short.toLowerCase() !== name.toLowerCase()) {
      out.add(short)
    }
  }

  if (input.studioName) {
    const studio = input.studioName.trim()
    if (studio && studio.toLowerCase() !== name.toLowerCase()) {
      out.add(studio)
    }
  }

  return Array.from(out)
}

function cleanTitle(title: string): string {
  let cleaned = title
  for (const re of GENERIC_TITLE_FRAGMENTS) cleaned = cleaned.replace(re, '')
  return cleaned.replace(/\s+/g, ' ').trim()
}

/**
 * Extract capitalized n-grams (2-3 words) that frequently co-occur with the
 * game name. Catches things like "Horror Skunx" or "Mascot Horror" that point
 * to the dev's channel or the game's genre — useful supplementary keywords.
 */
function extractNgrams(texts: string[], gameName: string): Map<string, number> {
  const ngrams = new Map<string, number>()
  const nameLower = gameName.toLowerCase()
  // Strip the game name from each text first so we don't extract sub-spans of it.
  const stripped = texts.map(t =>
    t.replace(new RegExp(gameName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '')
  )

  const capPhraseRe = /\b([A-Z][a-zA-Z0-9]*(?:\s+[A-Z][a-zA-Z0-9]*){1,2})\b/g

  for (const text of stripped) {
    if (!text) continue
    let match: RegExpExecArray | null
    while ((match = capPhraseRe.exec(text)) !== null) {
      const phrase = match[1].trim()
      const lower = phrase.toLowerCase()
      // Skip if it's the game name or a substring of it
      if (nameLower.includes(lower) || lower.includes(nameLower)) continue
      // Skip if all words are stop words
      const words = lower.split(/\s+/)
      if (words.every(w => STOP_WORDS.has(w))) continue
      // Skip if too short overall
      if (lower.length < 6) continue
      // Skip pure generic descriptors
      if (/^(official|new|the|a|an)\s/.test(lower)) continue
      // Skip storefront/aggregator boilerplate that's common but useless.
      if (NOISE_PHRASES.has(lower)) continue
      ngrams.set(phrase, (ngrams.get(phrase) || 0) + 1)
    }
  }

  return ngrams
}

/**
 * Discover subreddits where the game is being discussed, from URLs in
 * Tavily's results. Returns subreddit names without the 'r/' prefix.
 */
function extractSubreddits(urls: string[]): string[] {
  const subs = new Set<string>()
  for (const url of urls) {
    const m = url.match(/reddit\.com\/r\/([A-Za-z0-9_]+)/)
    if (m) subs.add(m[1].toLowerCase())
  }
  return Array.from(subs)
}

/**
 * Generate hashtag variants from keyword variants. Strips ALL non-alphanumerics
 * (including the colon that the old code missed), then deduplicates.
 *
 * Multiple variants per game catches: full title (#darkpalsthe1stfloor),
 * short form (#darkpals), and the slug (already alphanumeric).
 */
export function variantsToHashtags(variants: string[]): string[] {
  const tags = new Set<string>()
  for (const v of variants) {
    const tag = v.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
    if (tag.length >= 4 && tag.length <= 30) tags.add(tag)
  }
  return Array.from(tags)
}

/**
 * Generate keyword variants for a game by combining deterministic morphology
 * with Tavily-discovered patterns.
 *
 * If tavilyApiKey is omitted or Tavily fails, returns deterministic-only.
 */
export async function generateVariants(
  input: VariantInput,
  tavilyApiKey?: string | null
): Promise<VariantResult> {
  const det = deterministic(input)
  const trace: VariantResult['trace'] = det.map(v => ({ value: v, kind: 'deterministic' as const }))

  let tavilyVariants: string[] = []
  let subredditCandidates: string[] = []

  if (tavilyApiKey) {
    try {
      const tvly = tavily({ apiKey: tavilyApiKey })
      const queryParts = [input.gameName]
      if (input.studioName) queryParts.push(input.studioName)
      const query = queryParts.join(' ')

      const response = await tvly.search(query, {
        maxResults: 20,
        searchDepth: 'basic',
        includeAnswer: false,
      })

      const titles: string[] = []
      const urls: string[] = []
      for (const r of response.results || []) {
        if (r.title) titles.push(cleanTitle(r.title))
        if (r.content) titles.push(r.content)
        if (r.url) urls.push(r.url)
      }
      if (input.contextText) titles.push(input.contextText)

      const ngrams = extractNgrams(titles, input.gameName)

      // Only keep ngrams that share a meaningful token with the game name or
      // studio name. Without this, frequent co-occurring genre terms ("Mascot
      // Horror Game", "Psychological Horror Game") and competing games ("Poppy
      // Playtime") get promoted to search queries — wasting Apify/Tavily budget
      // on broad searches that return unrelated coverage.
      const gameTokens = new Set(
        input.gameName.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 4 && !STOP_WORDS.has(t))
      )
      const studioTokens = new Set(
        (input.studioName || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 4 && !STOP_WORDS.has(t))
      )
      const allTokens = new Set([...Array.from(gameTokens), ...Array.from(studioTokens)])
      const sharesToken = (phrase: string) =>
        phrase.toLowerCase().split(/[^a-z0-9]+/).some(t => allTokens.has(t))

      // Take ngrams seen ≥2 times AND sharing a token with the game/studio.
      const repeated = Array.from(ngrams.entries())
        .filter(([phrase, count]) => count >= 2 && sharesToken(phrase))
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([phrase]) => phrase)

      tavilyVariants = repeated
      subredditCandidates = extractSubreddits(urls)

      for (const v of tavilyVariants) trace.push({ value: v, kind: 'tavily' })
    } catch (err) {
      // Degrade gracefully — deterministic set is still useful.
      console.warn('[keyword-variants] Tavily lookup failed, using deterministic only:', err)
    }
  }

  // Merge + dedupe (case-insensitive). Deterministic variants come first because
  // they're guaranteed-safe; Tavily-discovered ones come after as bonuses.
  const seen = new Set<string>()
  const variants: string[] = []
  for (const v of [...det, ...tavilyVariants]) {
    const key = v.toLowerCase().trim()
    if (key.length < 3) continue
    if (seen.has(key)) continue
    seen.add(key)
    variants.push(v)
  }

  const hashtags = variantsToHashtags(variants)

  return { variants, hashtags, subreddits: subredditCandidates, trace }
}

/**
 * Generate language-aware Tavily query candidates for a game.
 *
 * Empirical finding: Tavily returns mostly English-language results for plain
 * English queries. Adding TLD filters or localized noun hints unlocks editorial
 * coverage on NL/JP/DE/BR/FR/AR/UK outlets that the system otherwise misses.
 *
 * For Dark Pals specifically, probing surfaced 6 of 14 missed localized
 * editorial URLs through these queries that were unreachable through any
 * variant-only query.
 *
 * Returns a small ordered list — caller should rotate or sample so the cost
 * stays bounded while coverage rotates across territories over time.
 */
export function generateLanguageQueries(gameName: string): string[] {
  const exact = `"${gameName}"`
  return [
    `${exact} site:.nl`,
    `${exact} site:.jp`,
    `${exact} site:.de`,
    `${exact} site:.fr`,
    `${exact} site:.br`,
    `${exact} site:.es`,
    `${exact} site:.uk`,
    `${gameName} jeu horror`,           // FR
    `${gameName} Spiel horror`,         // DE
    `${gameName} jogo horror`,          // PT-BR
    `${gameName} juego horror`,         // ES
    `${gameName} ホラー`,                // JP (horror)
    `${gameName} Nederlandse`,          // NL ("Dutch" — picks up local press)
  ]
}

/**
 * Subreddit defaults by inferred genre. Used when no organically-discovered
 * subreddits are available. The base list (gaming/pcgaming/indiegaming) is
 * always included; genre additions stack on top.
 */
export function defaultSubredditsForGame(gameName: string, contextText?: string | null): string[] {
  const base = ['gaming', 'pcgaming', 'indiegaming']
  const text = `${gameName} ${contextText || ''}`.toLowerCase()

  const genreSubs: Record<string, string[]> = {
    horror: ['HorrorGaming', 'horrorgames', 'indiehorror', 'ScarySigns'],
    mascot: ['HorrorGaming', 'mascothorror', 'indiehorror'],
    survival: ['survivalgaming', 'survivalhorror'],
    rpg: ['rpg', 'JRPG', 'IndieRPGs'],
    roguelike: ['roguelikes', 'roguelites'],
    metroidvania: ['metroidvania'],
    platformer: ['Platformer'],
    puzzle: ['puzzles', 'puzzlevideogames'],
    visualnovel: ['visualnovels'],
    'visual novel': ['visualnovels'],
    strategy: ['gamingsuggestions', '4Xgaming'],
    racing: ['simracing'],
    shooter: ['FPS', 'shooters'],
    fighting: ['Fighters'],
  }

  const out = new Set<string>(base)
  for (const [genre, subs] of Object.entries(genreSubs)) {
    if (text.includes(genre)) {
      for (const s of subs) out.add(s)
    }
  }
  // Always include 'PromoteGamingVideos' — long-tail creator coverage shows up here
  out.add('PromoteGamingVideos')
  return Array.from(out)
}
