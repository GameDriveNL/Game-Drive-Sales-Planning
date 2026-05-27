/**
 * Internet Archive (Wayback Machine) historical recovery.
 *
 * The Wayback Machine's CDX search API returns archived URLs from any given
 * domain within a time range. We use it as a recall safety net for articles
 * that aged out of both Tavily's current index AND RSS feed retention.
 *
 * Cost: free (rate-limit ~10 req/sec from a single IP).
 *
 * Usage pattern: when a game is first enrolled, iterate the subscribed
 * outlets, query CDX for each with the game's name keywords as URL filter,
 * insert any hits we don't already have.
 *
 * Note: archive.org snapshots URLs, so the timestamp is when the snapshot
 * was taken, not when the article was published — usually within a few days
 * of publication for outlets the archiver is configured to crawl.
 */

export interface WaybackHit {
  url: string
  archive_url: string
  timestamp: string
  status_code: string
}

interface CdxQueryOpts {
  /** Domain to search, e.g. 'automaton-media.com' */
  domain: string
  /** URL substring filter (regex-friendly). e.g. 'dark-pals' */
  urlFilter: string
  /** ISO date or YYYYMMDD. Default: 90 days ago. */
  from?: string
  /** ISO date or YYYYMMDD. Default: today. */
  to?: string
  /** Cap returned snapshots. Default 50. */
  limit?: number
}

function toCdxDate(input: string | undefined, fallbackDaysAgo: number): string {
  if (input) return input.replace(/[-T:.Z]/g, '').slice(0, 14)
  const d = new Date(Date.now() - fallbackDaysAgo * 86400000)
  return d.toISOString().replace(/[-T:.Z]/g, '').slice(0, 14)
}

/**
 * Query Wayback Machine CDX API for snapshots of a domain matching a URL
 * filter, within a date range.
 *
 * The CDX endpoint returns JSON arrays like:
 *   [["original", "timestamp", "statuscode"], ["http://...", "20260214233000", "200"], ...]
 */
export async function cdxSearch(opts: CdxQueryOpts): Promise<WaybackHit[]> {
  const url = new URL('https://web.archive.org/cdx/search/cdx')
  url.searchParams.set('url', `*.${opts.domain}/*`)
  url.searchParams.set('matchType', 'domain')
  url.searchParams.set('output', 'json')
  url.searchParams.set('fl', 'original,timestamp,statuscode')
  url.searchParams.set('collapse', 'urlkey')
  url.searchParams.set('filter', `statuscode:200`)
  url.searchParams.set('filter', `urlkey:.*${opts.urlFilter.toLowerCase()}.*`)
  url.searchParams.set('from', toCdxDate(opts.from, 90))
  url.searchParams.set('to', toCdxDate(opts.to, 0))
  url.searchParams.set('limit', String(opts.limit ?? 50))

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': 'GameDrive/1.0 Coverage Recovery' },
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return []
    const data = await res.json() as string[][]
    if (!Array.isArray(data) || data.length <= 1) return []
    // First row is the header (['original', 'timestamp', 'statuscode'])
    return data.slice(1).map(row => ({
      url: row[0],
      timestamp: row[1],
      status_code: row[2],
      archive_url: `https://web.archive.org/web/${row[1]}/${row[0]}`,
    }))
  } catch (err) {
    clearTimeout(timer)
    console.warn(`[wayback] CDX search failed for ${opts.domain}:`, err instanceof Error ? err.message : String(err))
    return []
  }
}

/**
 * Run Wayback recovery for a single game: iterate its subscribed outlets,
 * search CDX for archived URLs matching the game name, insert hits as
 * coverage_items.
 *
 * Returns { hits_found, items_inserted } stats.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { classifyCoverageType } from './coverage-utils'
import { inferTerritory } from './territory'

export interface WaybackRecoveryResult {
  game_name: string
  outlets_checked: number
  total_archive_hits: number
  items_inserted: number
  errors: string[]
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    return (u.origin + u.pathname).replace(/\/$/, '')
  } catch {
    return url
  }
}

/**
 * Build a URL-substring filter from the game name. Lowercase, replace
 * spaces and punctuation with '.' (CDX URL keys are alpha-numeric with
 * separators). e.g. "Dark Pals: The 1st Floor" → "dark.pals"
 */
function gameNameToCdxFilter(gameName: string): string {
  return gameName.toLowerCase()
    .split(/\s+|:/)
    .filter(t => t.length >= 4 && !/^(the|and|of|in|on|for)$/.test(t))
    .slice(0, 2)
    .join('.')
}

export async function recoverGameFromWayback(
  supabase: SupabaseClient,
  gameId: string,
  gameName: string,
  clientId: string,
  fromDate?: string,
  toDate?: string
): Promise<WaybackRecoveryResult> {
  const result: WaybackRecoveryResult = {
    game_name: gameName,
    outlets_checked: 0,
    total_archive_hits: 0,
    items_inserted: 0,
    errors: [],
  }

  // Build dedup set
  const { data: existing } = await supabase
    .from('coverage_items')
    .select('url')
    .eq('game_id', gameId)
    .limit(5000)
  const existingUrls = new Set((existing || []).map((r: { url: string }) => normalizeUrl(r.url)))

  // Get outlets we currently monitor (have RSS coverage_source rows)
  const { data: outletRows } = await supabase
    .from('outlets')
    .select('id, domain, name, country')
    .eq('is_active', true)
    .eq('is_blacklisted', false)
    .not('rss_feed_url', 'is', null)
    .limit(200) // cap
  if (!outletRows || outletRows.length === 0) return result

  const cdxFilter = gameNameToCdxFilter(gameName)
  if (!cdxFilter) {
    result.errors.push('game name too generic to build CDX filter')
    return result
  }

  for (const outlet of outletRows) {
    result.outlets_checked++
    try {
      const hits = await cdxSearch({
        domain: outlet.domain,
        urlFilter: cdxFilter,
        from: fromDate,
        to: toDate,
        limit: 20,
      })
      result.total_archive_hits += hits.length
      for (const h of hits) {
        const norm = normalizeUrl(h.url)
        if (existingUrls.has(norm)) continue
        existingUrls.add(norm)

        // Date from CDX timestamp (YYYYMMDDhhmmss)
        let publishDate: string | null = null
        if (h.timestamp && h.timestamp.length >= 8) {
          publishDate = `${h.timestamp.slice(0, 4)}-${h.timestamp.slice(4, 6)}-${h.timestamp.slice(6, 8)}`
        }
        let territory: string | null = null
        try { territory = inferTerritory(outlet.domain) } catch { /* ignore */ }

        const { error } = await supabase.from('coverage_items').insert({
          client_id: clientId,
          game_id: gameId,
          outlet_id: outlet.id,
          title: `${outlet.name} archived article`,  // will be enriched later when AI scoring fetches the page
          url: h.url,
          publish_date: publishDate,
          coverage_type: classifyCoverageType('news', norm),
          territory,
          relevance_score: null,
          approval_status: 'pending_review',
          source_type: 'wayback',
          source_metadata: {
            wayback: true,
            archive_url: h.archive_url,
            wayback_timestamp: h.timestamp,
            cdx_filter: cdxFilter,
          },
          discovered_at: new Date().toISOString(),
        })
        if (!error) result.items_inserted++
      }
      // Be polite to archive.org: small delay between domains.
      await new Promise(r => setTimeout(r, 250))
    } catch (err) {
      result.errors.push(`${outlet.domain}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log(`[wayback] ${gameName}: ${result.items_inserted} new items from ${result.total_archive_hits} archive hits across ${result.outlets_checked} outlets`)
  return result
}
