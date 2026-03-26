import { NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import Parser from 'rss-parser'
import { domainToOutletName } from '@/lib/outlet-utils'
import { detectOutletCountry } from '@/lib/outlet-country'
import { classifyCoverageType } from '@/lib/coverage-utils'
import { inferTerritory } from '@/lib/territory'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

// ─── Language Variants ──────────────────────────────────────────────────────

interface LangVariant {
  label: string
  hl: string
  gl: string
  ceid: string
}

const ALL_LANGUAGES: LangVariant[] = [
  { label: 'English',        hl: 'en',    gl: 'US', ceid: 'US:en' },
  { label: 'Dutch',          hl: 'nl',    gl: 'NL', ceid: 'NL:nl' },
  { label: 'German',         hl: 'de',    gl: 'DE', ceid: 'DE:de' },
  { label: 'French',         hl: 'fr',    gl: 'FR', ceid: 'FR:fr' },
  { label: 'Spanish',        hl: 'es',    gl: 'ES', ceid: 'ES:es' },
  { label: 'Italian',        hl: 'it',    gl: 'IT', ceid: 'IT:it' },
  { label: 'Japanese',       hl: 'ja',    gl: 'JP', ceid: 'JP:ja' },
  { label: 'Portuguese (BR)',hl: 'pt-BR', gl: 'BR', ceid: 'BR:pt-419' },
]

// ─── Helpers ────────────────────────────────────────────────────────────────

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    // Strip UTM params and trailing slash
    u.searchParams.delete('utm_source')
    u.searchParams.delete('utm_medium')
    u.searchParams.delete('utm_campaign')
    u.searchParams.delete('utm_term')
    u.searchParams.delete('utm_content')
    let normalized = u.origin + u.pathname
    if (normalized.endsWith('/') && normalized.length > 1) {
      normalized = normalized.slice(0, -1)
    }
    // Keep non-UTM query params
    const remaining = u.searchParams.toString()
    if (remaining) normalized += '?' + remaining
    return normalized
  } catch {
    return url.trim()
  }
}

/** Build a Google News RSS search URL for a game name in a given language */
function buildGoogleNewsUrl(gameName: string, lang: LangVariant): string {
  const query = `"${gameName}" game`
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${lang.hl}&gl=${lang.gl}&ceid=${lang.ceid}`
}

/**
 * Attempt to resolve a Google News redirect URL to the actual article URL.
 * Google News RSS links are redirects — we follow them to get the real destination.
 */
async function resolveGoogleNewsUrl(googleUrl: string): Promise<string> {
  // If it's not a Google News URL, return as-is
  if (!googleUrl.includes('news.google.com')) return googleUrl

  try {
    const res = await fetch(googleUrl, {
      redirect: 'manual',
      headers: { 'User-Agent': 'GameDrive/1.0 Coverage Monitor' },
      signal: AbortSignal.timeout(5000),
    })

    const location = res.headers.get('location')
    if (location && !location.includes('news.google.com')) {
      return location
    }

    // Some Google News URLs use a different redirect pattern
    // Try following one more hop if we got another Google URL
    if (location && location.includes('news.google.com')) {
      const res2 = await fetch(location, {
        redirect: 'manual',
        headers: { 'User-Agent': 'GameDrive/1.0 Coverage Monitor' },
        signal: AbortSignal.timeout(5000),
      })
      const location2 = res2.headers.get('location')
      if (location2 && !location2.includes('news.google.com')) {
        return location2
      }
    }
  } catch {
    // If redirect resolution fails, fall through to return the original URL
  }

  return googleUrl
}

/** Blacklist keywords — items containing these are skipped */
const BLACKLIST_KEYWORDS = [
  'casino', 'gambling', 'slot machine', 'poker',
  'free robux', 'hack download', 'cheat engine',
  'job opening', 'hiring', 'careers',
]

function isBlacklisted(title: string, description: string): boolean {
  const text = `${title} ${description}`.toLowerCase()
  return BLACKLIST_KEYWORDS.some(kw => text.includes(kw))
}

/**
 * Pick which language variants to scan for this run.
 * Rotates through languages so we cover all of them across multiple runs.
 * Uses a simple hash of the current hour to rotate.
 */
function pickLanguages(maxPerRun: number): LangVariant[] {
  const hour = new Date().getUTCHours()
  // Always include English, then rotate through the rest
  const nonEnglish = ALL_LANGUAGES.slice(1)
  const startIdx = (hour * 2) % nonEnglish.length // shift every hour
  const picked: LangVariant[] = [ALL_LANGUAGES[0]] // English always included

  for (let i = 0; i < Math.min(maxPerRun - 1, nonEnglish.length); i++) {
    const idx = (startIdx + i) % nonEnglish.length
    picked.push(nonEnglish[idx])
  }

  return picked
}

// ─── Main Handler ───────────────────────────────────────────────────────────

export async function GET(request: Request) {
  const startTime = Date.now()
  const supabase = getServerSupabase()

  try {
    // Auth: allow Vercel cron or manual browser test
    const authHeader = request.headers.get('authorization')
    const expectedAuth = `Bearer ${process.env.CRON_SECRET}`
    const isManualTest = request.headers.get('user-agent')?.includes('Mozilla')

    if (!isManualTest && authHeader !== expectedAuth) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // 1. Fetch all games with PR tracking enabled (join with clients for client_id)
    const { data: games, error: gamesErr } = await supabase
      .from('games')
      .select('id, name, client_id, clients(id, name)')
      .eq('pr_tracking_enabled', true)

    if (gamesErr) {
      console.error('[Google News Scan] Failed to fetch games:', gamesErr)
      return NextResponse.json({ error: 'Failed to fetch games' }, { status: 500 })
    }

    if (!games || games.length === 0) {
      return NextResponse.json({
        message: 'No games with PR tracking enabled',
        stats: { games_scanned: 0 }
      })
    }

    // 2. Fetch existing URLs for deduplication (last 10000)
    const { data: existingItems } = await supabase
      .from('coverage_items')
      .select('url')
      .order('created_at', { ascending: false })
      .limit(10000)

    const existingUrls = new Set<string>()
    if (existingItems) {
      for (const item of existingItems) {
        existingUrls.add(normalizeUrl(item.url))
      }
    }

    // 3. Fetch blacklist keywords from coverage_keywords
    const { data: keywords } = await supabase
      .from('coverage_keywords')
      .select('keyword, keyword_type')
      .eq('keyword_type', 'blacklist')

    const extraBlacklist: string[] = (keywords || []).map(k => k.keyword.toLowerCase())

    // 4. Set up RSS parser
    const parser = new Parser({
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GameDrive/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml',
      },
      customFields: { item: [] },
    })

    // 5. Pick language variants for this run (max 3)
    const languages = pickLanguages(3)

    // Stats tracking
    const stats = {
      games_scanned: 0,
      feeds_parsed: 0,
      items_found: 0,
      items_inserted: 0,
      items_duplicate: 0,
      items_blacklisted: 0,
      items_resolve_failed: 0,
      errors: [] as string[],
    }

    // 6. Process games — max 5 per run to stay within timeout
    const gameBatch = games.slice(0, 5)

    for (const game of gameBatch) {
      // Time guard: stop if approaching 60s limit
      if (Date.now() - startTime > 50000) {
        console.log('[Google News Scan] Approaching time limit, stopping early')
        break
      }

      stats.games_scanned++
      const gameName = game.name
      const gameId = game.id
      const clientId = game.client_id

      for (const lang of languages) {
        // Time guard inside inner loop too
        if (Date.now() - startTime > 50000) break

        const feedUrl = buildGoogleNewsUrl(gameName, lang)

        try {
          const feed = await parser.parseURL(feedUrl)
          stats.feeds_parsed++

          const newItems: Array<Record<string, unknown>> = []

          for (const entry of (feed.items || [])) {
            if (!entry.link || !entry.title) continue
            stats.items_found++

            // Time guard: don't start processing new items if we're close to timeout
            if (Date.now() - startTime > 48000) break

            // Resolve the Google News redirect to get the real article URL
            let resolvedUrl: string
            try {
              resolvedUrl = await resolveGoogleNewsUrl(entry.link)
            } catch {
              stats.items_resolve_failed++
              resolvedUrl = entry.link
            }

            const normalizedUrl = normalizeUrl(resolvedUrl)

            // Skip Google News internal URLs that couldn't be resolved
            if (normalizedUrl.includes('news.google.com/rss/articles')) {
              stats.items_resolve_failed++
              continue
            }

            // Dedup check
            if (existingUrls.has(normalizedUrl)) {
              stats.items_duplicate++
              continue
            }

            const description = entry.contentSnippet || entry.content || entry.summary || ''

            // Blacklist check (built-in + DB keywords)
            if (isBlacklisted(entry.title, description)) {
              stats.items_blacklisted++
              continue
            }
            const textLower = `${entry.title} ${description}`.toLowerCase()
            if (extraBlacklist.some(bk => textLower.includes(bk))) {
              stats.items_blacklisted++
              continue
            }

            // Add to existing URLs set to prevent intra-batch duplicates
            existingUrls.add(normalizedUrl)

            // Auto-create or find outlet by domain
            let outletId: string | null = null
            let outletVisitors: number | null = null
            try {
              const articleDomain = new URL(normalizedUrl).hostname.replace('www.', '')

              const { data: outlet } = await supabase
                .from('outlets')
                .select('id, monthly_unique_visitors, is_blacklisted')
                .eq('domain', articleDomain)
                .single()

              if (outlet) {
                if (outlet.is_blacklisted) continue // Skip blacklisted outlets
                outletId = outlet.id
                outletVisitors = outlet.monthly_unique_visitors
              } else {
                // Auto-create outlet from domain
                const outletName = domainToOutletName(articleDomain)
                const { data: newOutlet } = await supabase
                  .from('outlets')
                  .insert({
                    name: outletName,
                    domain: articleDomain,
                    country: detectOutletCountry(articleDomain),
                    tier: null,
                  })
                  .select('id')
                  .single()
                if (newOutlet) outletId = newOutlet.id
              }
            } catch (outletErr) {
              console.warn(
                `[Google News Scan] Outlet lookup/creation error for ${normalizedUrl}:`,
                outletErr instanceof Error ? outletErr.message : String(outletErr)
              )
            }

            // Infer territory from article domain TLD + language variant
            let territory: string | null = null
            try {
              const articleDomain = new URL(normalizedUrl).hostname.replace('www.', '')
              territory = inferTerritory(articleDomain, null, lang.hl)
            } catch { /* ignore */ }

            newItems.push({
              client_id: clientId,
              game_id: gameId,
              outlet_id: outletId,
              title: entry.title.trim(),
              url: normalizedUrl,
              publish_date: entry.isoDate
                ? entry.isoDate.split('T')[0]
                : new Date().toISOString().split('T')[0],
              coverage_type: classifyCoverageType('news', normalizedUrl),
              territory,
              monthly_unique_visitors: outletVisitors,
              sentiment: null,
              relevance_score: null,
              relevance_reasoning: null,
              approval_status: 'pending_review',
              source_type: 'google_news',
              source_metadata: {
                feed_url: feedUrl,
                language: lang.label,
                language_code: lang.hl,
                google_news_link: entry.link,
                guid: entry.guid || entry.id || null,
                author: entry.creator || entry.author || null,
                categories: entry.categories || [],
                game_name: gameName,
              },
              discovered_at: new Date().toISOString(),
            })
          }

          // Batch insert new items
          if (newItems.length > 0) {
            const { error: insertErr, data: inserted } = await supabase
              .from('coverage_items')
              .upsert(newItems, { onConflict: 'url', ignoreDuplicates: true })
              .select('id')

            if (insertErr) {
              console.error(
                `[Google News Scan] Insert error for ${gameName} (${lang.label}):`,
                insertErr
              )
              stats.errors.push(`${gameName}/${lang.label}: insert error - ${insertErr.message}`)
            } else {
              stats.items_inserted += inserted?.length || 0
            }
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          stats.errors.push(`${gameName}/${lang.label}: ${errMsg}`)
          console.error(
            `[Google News Scan] Failed to parse feed for ${gameName} (${lang.label}):`,
            errMsg
          )
        }
      }
    }

    const duration = Date.now() - startTime
    console.log(`[Google News Scan] Completed in ${duration}ms:`, stats)

    return NextResponse.json({
      message: 'Google News scan complete',
      duration_ms: duration,
      languages_used: languages.map(l => l.label),
      stats: {
        total_pr_games: games.length,
        batch_size: gameBatch.length,
        ...stats,
      },
    })
  } catch (err) {
    console.error('[Google News Scan] Fatal error:', err)
    return NextResponse.json(
      {
        error: 'Google News scan failed',
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    )
  }
}
