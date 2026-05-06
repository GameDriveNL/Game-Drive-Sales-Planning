import { NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { domainToOutletName } from '@/lib/outlet-utils'
import { detectOutletCountry } from '@/lib/outlet-country'
import { matchGameFromContent, classifyCoverageType } from '@/lib/coverage-utils'
import { inferTerritory } from '@/lib/territory'
import { verifyCronAuth } from '@/lib/cron-auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * Web Scrape Scanner — Free HTTP-based coverage discovery
 *
 * This is the second tier of the coverage waterfall:
 * 1. RSS feeds (free, most reliable)
 * 2. ** Web scraping (free, this scanner) **
 * 3. Tavily search (paid, only for top-tier outlets)
 *
 * For outlets that don't have RSS feeds, we fetch their homepage/news page
 * directly, extract article links, and check if any match our game keywords.
 * Zero API cost — just HTTP fetches.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

interface ScrapableOutlet {
  id: string
  name: string
  domain: string
  tier: string | null
  monthly_unique_visitors: number | null
  is_blacklisted: boolean
}

interface Keyword {
  keyword: string
  keyword_type: 'whitelist' | 'blacklist'
  client_id: string
  game_id: string | null
}

type GameInfo = { id: string; name: string; client_id: string }
type KeywordMeta = { keyword: string; client_id: string; game_id: string | null }

// ─── Helpers ────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT = 12000
const USER_AGENT = 'Mozilla/5.0 (compatible; GameDrive/1.0; +https://gamedrivesalesplanning.vercel.app)'

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    u.searchParams.delete('utm_source')
    u.searchParams.delete('utm_medium')
    u.searchParams.delete('utm_campaign')
    u.searchParams.delete('utm_term')
    u.searchParams.delete('utm_content')
    let normalized = u.origin + u.pathname
    if (normalized.endsWith('/') && normalized.length > 1) {
      normalized = normalized.slice(0, -1)
    }
    const remaining = u.searchParams.toString()
    if (remaining) normalized += '?' + remaining
    return normalized
  } catch {
    return url.trim()
  }
}

/**
 * Extract article links and titles from HTML
 * Looks for <a> tags with href pointing to article-like URLs on the same domain
 */
function extractArticleLinks(html: string, baseDomain: string): Array<{ url: string; title: string }> {
  const articles: Array<{ url: string; title: string }> = []
  const seen = new Set<string>()

  // Match <a> tags with href attributes
  const linkRegex = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match

  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1]
    const innerHtml = match[2]

    // Extract clean text from inner HTML (strip tags)
    const title = innerHtml.replace(/<[^>]+>/g, '').trim()
    if (!title || title.length < 10 || title.length > 300) continue

    // Resolve relative URLs
    let fullUrl: string
    try {
      fullUrl = new URL(href, `https://${baseDomain}`).toString()
    } catch {
      continue
    }

    // Only keep links on the same domain
    try {
      const linkDomain = new URL(fullUrl).hostname.replace(/^www\./, '')
      if (!linkDomain.includes(baseDomain.replace(/^www\./, '')) &&
          !baseDomain.replace(/^www\./, '').includes(linkDomain)) continue
    } catch {
      continue
    }

    // Filter out non-article URLs
    const path = new URL(fullUrl).pathname.toLowerCase()
    if (
      path === '/' ||
      path === '/feed' ||
      path === '/rss' ||
      path.match(/^\/(about|contact|privacy|terms|login|register|search|tag|category|author|page\/\d+)\/?$/) ||
      path.match(/\.(jpg|jpeg|png|gif|svg|css|js|pdf|zip)$/) ||
      path.split('/').filter(Boolean).length < 1
    ) continue

    // Article-like URLs usually have a slug in the path
    const hasSlug = path.split('/').some(segment =>
      segment.length > 10 && segment.includes('-')
    )
    // Or at least have a meaningful path depth
    const hasDepth = path.split('/').filter(Boolean).length >= 2

    if (!hasSlug && !hasDepth) continue

    const normalized = normalizeUrl(fullUrl)
    if (seen.has(normalized)) continue
    seen.add(normalized)

    articles.push({ url: normalized, title })
  }

  return articles
}

function matchesKeywords(
  title: string,
  whitelistKeywords: string[],
  blacklistKeywords: string[]
): { matched: boolean; score: number; matchedTerms: string[] } {
  const text = title.toLowerCase()
  const matchedTerms: string[] = []

  for (const kw of blacklistKeywords) {
    if (text.includes(kw.toLowerCase())) {
      return { matched: false, score: 0, matchedTerms: [] }
    }
  }

  if (whitelistKeywords.length === 0) {
    return { matched: false, score: 0, matchedTerms: [] }
  }

  let score = 0
  for (const kw of whitelistKeywords) {
    if (text.includes(kw.toLowerCase())) {
      matchedTerms.push(kw)
      score += 25
    }
  }

  if (matchedTerms.length === 0) {
    return { matched: false, score: 0, matchedTerms: [] }
  }

  return { matched: true, score: Math.min(score, 100), matchedTerms }
}

// ─── Main Handler ───────────────────────────────────────────────────────────

export async function GET(request: Request) {
  const startTime = Date.now()
  const supabase = getServerSupabase()

  try {
    // Auth — fails closed (was a Mozilla User-Agent bypass; trivially spoofed).
    const authError = verifyCronAuth(request)
    if (authError) return authError

    // 1. Fetch outlets that DON'T have RSS feeds and are worth scraping
    //    Focus on Tier A/B outlets without RSS — these are the gap
    const { data: outlets, error: outletErr } = await supabase
      .from('outlets')
      .select('id, name, domain, tier, monthly_unique_visitors, is_blacklisted')
      .is('rss_feed_url', null)
      .eq('is_blacklisted', false)
      .in('tier', ['A', 'B'])
      .not('domain', 'like', 'reddit.com%')
      .not('domain', 'like', 'www.youtube.com%')
      .not('domain', 'like', 'tiktok.com%')
      .not('domain', 'like', 'x.com%')
      .not('domain', 'like', 'twitter.com%')
      .not('domain', 'like', 'instagram.com%')
      .order('monthly_unique_visitors', { ascending: false })
      .limit(50)

    if (outletErr) {
      console.error('[Web Scrape] Failed to fetch outlets:', outletErr)
      return NextResponse.json({ error: 'Failed to fetch outlets' }, { status: 500 })
    }

    // Filter out storefronts, platforms, and non-news sites
    const skipDomains = [
      'store.steampowered.com', 'steamcommunity.com', 'store.playstation.com',
      'store.epicgames.com', 'metacritic.com', 'opencritic.com', 'howlongtobeat.com',
      'steamdb.info', 'en.wikipedia.org', 'dekudeals.com', 'instant-gaming.com',
      'keylol.com', 'gamefaqs.gamespot.com', 'aol.com', 'threads.com',
      'dailymotion.com', 'vgchartz.com', 'xbox.com', 'playstation.com',
      'nintendo.com', 'epicgames.com', 'itch.io', 'steamspy.com',
      'gettyimages.com', 'releases.com',
    ]
    const scrapableOutlets = (outlets || []).filter((o: ScrapableOutlet) =>
      !skipDomains.includes(o.domain) &&
      !o.domain.startsWith('www.youtube.com') &&
      !o.domain.startsWith('reddit.com')
    )

    if (scrapableOutlets.length === 0) {
      return NextResponse.json({ message: 'No outlets to scrape', stats: { scanned: 0 } })
    }

    // 2. Fetch keywords and games
    const { data: keywords } = await supabase
      .from('coverage_keywords')
      .select('keyword, keyword_type, client_id, game_id')

    const allKeywords = (keywords || []) as Keyword[]
    const whitelistByClient = new Map<string, string[]>()
    const blacklistGlobal: string[] = []

    for (const kw of allKeywords) {
      if (kw.keyword_type === 'blacklist') {
        blacklistGlobal.push(kw.keyword)
      } else {
        if (!whitelistByClient.has(kw.client_id)) whitelistByClient.set(kw.client_id, [])
        whitelistByClient.get(kw.client_id)!.push(kw.keyword)
      }
    }

    const { data: games } = await supabase.from('games').select('id, name, client_id')

    // Add game names as implicit whitelist keywords
    if (games) {
      for (const game of games) {
        if (!whitelistByClient.has(game.client_id)) whitelistByClient.set(game.client_id, [])
        const clientKws = whitelistByClient.get(game.client_id)!
        if (!clientKws.some(k => k.toLowerCase() === game.name.toLowerCase())) {
          clientKws.push(game.name)
        }
      }
    }

    // Combine all whitelist terms for broad matching
    const allWhitelistTerms: string[] = []
    Array.from(whitelistByClient.values()).forEach(terms => allWhitelistTerms.push(...terms))

    // 3. Fetch existing URLs for dedup
    const { data: existingItems } = await supabase
      .from('coverage_items')
      .select('url')
      .order('created_at', { ascending: false })
      .limit(10000)

    const existingUrls = new Set<string>()
    if (existingItems) {
      for (const item of existingItems) existingUrls.add(normalizeUrl(item.url))
    }

    // 4. Track last scrape times — use a simple approach via coverage_sources
    //    We'll check/create a "web_scrape" source per outlet to track timing
    const { data: scrapeSources } = await supabase
      .from('coverage_sources')
      .select('id, outlet_id, last_run_at')
      .eq('source_type', 'web_scrape')

    const lastScrapeByOutlet = new Map<string, string>()
    const sourceIdByOutlet = new Map<string, string>()
    if (scrapeSources) {
      for (const s of scrapeSources) {
        if (s.outlet_id) {
          lastScrapeByOutlet.set(s.outlet_id, s.last_run_at || '')
          sourceIdByOutlet.set(s.outlet_id, s.id)
        }
      }
    }

    // Filter to outlets due for scraping (daily frequency)
    const now = Date.now()
    const dueOutlets = scrapableOutlets.filter((o: ScrapableOutlet) => {
      const lastRun = lastScrapeByOutlet.get(o.id)
      if (!lastRun) return true
      const hoursSince = (now - new Date(lastRun).getTime()) / (1000 * 60 * 60)
      return hoursSince >= 23
    })

    if (dueOutlets.length === 0) {
      return NextResponse.json({
        message: 'No outlets due for scraping',
        stats: { total_scrapable: scrapableOutlets.length, due: 0 }
      })
    }

    // 5. Scrape outlets (limit to 6 per run for time budget)
    const stats = {
      outlets_scraped: 0,
      outlets_failed: 0,
      links_extracted: 0,
      items_matched: 0,
      items_inserted: 0,
      items_duplicate: 0,
      items_no_game: 0,
      errors: [] as string[]
    }

    const batch = dueOutlets.slice(0, 6) as ScrapableOutlet[]

    for (const outlet of batch) {
      if (Date.now() - startTime > 45000) {
        console.log('[Web Scrape] Approaching time limit, stopping')
        break
      }

      try {
        // Fetch the homepage
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT)

        const res = await fetch(`https://${outlet.domain}`, {
          headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'text/html',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          redirect: 'follow',
          signal: controller.signal,
        })

        clearTimeout(timeout)

        if (!res.ok) {
          // Try www variant
          const wwwRes = await fetch(`https://www.${outlet.domain}`, {
            headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' },
            redirect: 'follow',
            signal: AbortSignal.timeout(FETCH_TIMEOUT),
          }).catch(() => null)

          if (!wwwRes || !wwwRes.ok) {
            stats.outlets_failed++
            stats.errors.push(`${outlet.domain}: HTTP ${res.status}`)
            continue
          }
        }

        const html = await (res.ok ? res : await fetch(`https://www.${outlet.domain}`, {
          headers: { 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(FETCH_TIMEOUT),
        })).text()

        stats.outlets_scraped++

        // Extract article links
        const articles = extractArticleLinks(html, outlet.domain)
        stats.links_extracted += articles.length

        const newItems: Array<Record<string, unknown>> = []

        for (const article of articles) {
          // Dedup
          if (existingUrls.has(article.url)) {
            stats.items_duplicate++
            continue
          }

          // Match against keywords
          let bestMatch = { matched: false, score: 0, matchedTerms: [] as string[] }
          let matchedClientId: string | null = null

          for (const [clientId, clientKeywords] of Array.from(whitelistByClient.entries())) {
            const match = matchesKeywords(article.title, clientKeywords, blacklistGlobal)
            if (match.matched && match.score > bestMatch.score) {
              bestMatch = match
              matchedClientId = clientId
            }
          }

          if (!bestMatch.matched) continue
          stats.items_matched++

          // Game matching
          let matchedGameId: string | null = null
          if (matchedClientId && games) {
            const clientGames = games.filter(g => g.client_id === matchedClientId) as GameInfo[]
            matchedGameId = matchGameFromContent(
              article.title,
              '',
              bestMatch.matchedTerms,
              allKeywords as KeywordMeta[],
              clientGames
            )
          }

          if (!matchedGameId) {
            stats.items_no_game++
            continue
          }

          existingUrls.add(article.url)

          const territory = inferTerritory(outlet.domain)

          newItems.push({
            client_id: matchedClientId,
            game_id: matchedGameId,
            outlet_id: outlet.id,
            title: article.title,
            url: article.url,
            publish_date: new Date().toISOString().split('T')[0],
            coverage_type: classifyCoverageType('news', article.url),
            territory,
            monthly_unique_visitors: outlet.monthly_unique_visitors,
            sentiment: null,
            relevance_score: null,
            relevance_reasoning: null,
            approval_status: 'pending_review',
            source_type: 'web_scrape',
            source_metadata: {
              scraped_from: outlet.domain,
              outlet_name: outlet.name,
              keyword_score: bestMatch.score,
              matched_keywords: bestMatch.matchedTerms,
            },
            discovered_at: new Date().toISOString(),
          })
        }

        // Batch insert
        if (newItems.length > 0) {
          const { error: insertErr, data: inserted } = await supabase
            .from('coverage_items')
            .upsert(newItems, { onConflict: 'url', ignoreDuplicates: true })
            .select('id')

          if (insertErr) {
            stats.errors.push(`${outlet.domain}: insert error - ${insertErr.message}`)
          } else {
            stats.items_inserted += inserted?.length || 0
          }
        }

        // Update/create scrape source tracking
        const sourceId = sourceIdByOutlet.get(outlet.id)
        if (sourceId) {
          await supabase.from('coverage_sources').update({
            last_run_at: new Date().toISOString(),
            last_run_status: 'success',
            last_run_message: `Extracted ${articles.length} links, matched ${newItems.length} items`,
            items_found_last_run: newItems.length,
          }).eq('id', sourceId)
        } else {
          await supabase.from('coverage_sources').insert({
            source_type: 'web_scrape',
            name: `${outlet.name} Web Scrape`,
            config: { domain: outlet.domain },
            outlet_id: outlet.id,
            scan_frequency: 'daily',
            is_active: true,
            last_run_at: new Date().toISOString(),
            last_run_status: 'success',
            last_run_message: `Extracted ${articles.length} links, matched ${newItems.length} items`,
            items_found_last_run: newItems.length,
          })
        }

      } catch (err) {
        stats.outlets_failed++
        const errMsg = err instanceof Error ? err.message : String(err)
        stats.errors.push(`${outlet.domain}: ${errMsg}`)
        console.error(`[Web Scrape] Failed for ${outlet.domain}:`, errMsg)
      }
    }

    const duration = Date.now() - startTime
    console.log(`[Web Scrape] Completed in ${duration}ms:`, stats)

    return NextResponse.json({
      message: 'Web scrape complete',
      duration_ms: duration,
      stats: {
        total_scrapable: scrapableOutlets.length,
        due_for_scrape: dueOutlets.length,
        batch_size: batch.length,
        ...stats
      }
    })

  } catch (err) {
    console.error('[Web Scrape] Fatal error:', err)
    return NextResponse.json(
      { error: 'Web scrape failed', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
