import { NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import Parser from 'rss-parser'
import { inferTerritory } from '@/lib/territory'
import { domainToOutletName } from '@/lib/outlet-utils'
import { detectOutletCountry } from '@/lib/outlet-country'
import { matchGameFromContent, classifyCoverageType } from '@/lib/coverage-utils'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

// ─── Types ──────────────────────────────────────────────────────────────────

interface CoverageSource {
  id: string
  source_type: string
  name: string
  config: { url?: string; [key: string]: unknown }
  outlet_id: string | null
  game_id: string | null
  scan_frequency: string
  is_active: boolean
  last_run_at: string | null
  consecutive_failures: number
  outlet?: { id: string; tier: string | null; monthly_unique_visitors: number | null } | null
}

interface Keyword {
  keyword: string
  keyword_type: 'whitelist' | 'blacklist'
  client_id: string
  game_id: string | null
}

// Aliases matching coverage-utils function signatures
type GameInfo = { id: string; name: string; client_id: string }
type KeywordMeta = { keyword: string; client_id: string; game_id: string | null }

// ─── Helpers ────────────────────────────────────────────────────────────────

function shouldScanNow(source: CoverageSource): boolean {
  if (!source.last_run_at) return true

  const lastRun = new Date(source.last_run_at).getTime()
  const now = Date.now()
  const hoursSince = (now - lastRun) / (1000 * 60 * 60)

  switch (source.scan_frequency) {
    case 'hourly': return hoursSince >= 0.9
    case 'every_6h': return hoursSince >= 5.5
    case 'daily': return hoursSince >= 23
    case 'weekly': return hoursSince >= 167
    default: return hoursSince >= 23
  }
}

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

function matchesKeywords(
  title: string,
  description: string,
  whitelistKeywords: string[],
  blacklistKeywords: string[]
): { matched: boolean; score: number; matchedTerms: string[] } {
  const text = `${title} ${description}`.toLowerCase()
  const matchedTerms: string[] = []

  // Check blacklist first — if any blacklist keyword matches, reject
  for (const kw of blacklistKeywords) {
    if (text.includes(kw.toLowerCase())) {
      return { matched: false, score: 0, matchedTerms: [] }
    }
  }

  // If no whitelist keywords, match everything (broad scan)
  if (whitelistKeywords.length === 0) {
    return { matched: true, score: 50, matchedTerms: [] }
  }

  // Check whitelist — need at least one match
  let score = 0
  for (const kw of whitelistKeywords) {
    const kwLower = kw.toLowerCase()
    if (text.includes(kwLower)) {
      matchedTerms.push(kw)
      // Exact title match scores higher
      if (title.toLowerCase().includes(kwLower)) score += 30
      else score += 15
    }
  }

  if (matchedTerms.length === 0) {
    return { matched: false, score: 0, matchedTerms: [] }
  }

  // Cap at 100
  score = Math.min(score, 100)

  return { matched: true, score, matchedTerms }
}

// Pre-process XML to fix common issues before parsing
function sanitizeXml(xml: string): string {
  // Fix unescaped ampersands (common in RSS feeds): & not followed by #, a valid entity name, and ;
  let sanitized = xml.replace(/&(?!(?:#[0-9]+|#x[0-9a-fA-F]+|amp|lt|gt|quot|apos);)/g, '&amp;')
  // Fix unquoted attribute values like <tag attr=value> → <tag attr="value">
  sanitized = sanitized.replace(/<([a-zA-Z][a-zA-Z0-9]*)\s+([^>]*?)>/g, (_match, tag: string, attrs: string) => {
    const fixedAttrs = attrs.replace(/(\w+)\s*=\s*([^"'\s>][^\s>]*)/g, '$1="$2"')
    return `<${tag} ${fixedAttrs}>`
  })
  return sanitized
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

    // 1. Fetch all active RSS sources with their linked outlets
    const { data: sources, error: srcErr } = await supabase
      .from('coverage_sources')
      .select('*, outlet:outlets(id, tier, monthly_unique_visitors)')
      .eq('source_type', 'rss')
      .eq('is_active', true)

    if (srcErr) {
      console.error('[RSS Scan] Failed to fetch sources:', srcErr)
      return NextResponse.json({ error: 'Failed to fetch sources' }, { status: 500 })
    }

    if (!sources || sources.length === 0) {
      return NextResponse.json({ message: 'No active RSS sources', stats: { scanned: 0, found: 0, inserted: 0 } })
    }

    // Filter sources that need scanning now
    const dueForScan = (sources as CoverageSource[]).filter(shouldScanNow)

    if (dueForScan.length === 0) {
      return NextResponse.json({
        message: 'No sources due for scanning',
        stats: { total_sources: sources.length, due_for_scan: 0 }
      })
    }

    // 2. Fetch all keywords for matching
    const { data: keywords } = await supabase
      .from('coverage_keywords')
      .select('keyword, keyword_type, client_id, game_id')

    const allKeywords = (keywords || []) as Keyword[]

    // Build keyword maps per client/game
    const whitelistByClient = new Map<string, string[]>()
    const blacklistGlobal: string[] = []

    for (const kw of allKeywords) {
      if (kw.keyword_type === 'blacklist') {
        blacklistGlobal.push(kw.keyword)
      } else {
        const key = kw.client_id
        if (!whitelistByClient.has(key)) whitelistByClient.set(key, [])
        whitelistByClient.get(key)!.push(kw.keyword)
      }
    }

    // 3. Fetch all clients + games for matching
    const { data: clients } = await supabase.from('clients').select('id, name')
    const { data: games } = await supabase.from('games').select('id, name, client_id')

    // Build a combined whitelist if no specific client keywords exist
    const allWhitelistTerms: string[] = []
    Array.from(whitelistByClient.values()).forEach(terms => allWhitelistTerms.push(...terms))

    // 4. Fetch existing URLs for deduplication
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

    // 5. Process each RSS source
    // Use lenient XML parsing to handle malformed feeds (unescaped entities, bad attributes)
    const parser = new Parser({
      timeout: 15000,
      headers: {
        'User-Agent': 'GameDrive/1.0 Coverage Monitor',
        'Accept': 'application/rss+xml, application/xml, text/xml, application/atom+xml'
      },
      customFields: { item: [] }
    })

    const stats = {
      sources_scanned: 0,
      sources_failed: 0,
      items_found: 0,
      items_matched: 0,
      items_inserted: 0,
      items_duplicate: 0,
      items_no_game: 0,
      errors: [] as string[]
    }

    // Limit to 10 sources per cron run to stay within 60s
    const batch = dueForScan.slice(0, 10)

    for (const source of batch) {
      const feedUrl = source.config?.url
      if (!feedUrl || typeof feedUrl !== 'string') {
        await supabase.from('coverage_sources').update({
          last_run_at: new Date().toISOString(),
          last_run_status: 'error',
          last_run_message: 'No feed URL configured',
          consecutive_failures: source.consecutive_failures + 1
        }).eq('id', source.id)
        stats.sources_failed++
        continue
      }

      // Time guard: stop if we're approaching the 60s limit
      if (Date.now() - startTime > 50000) {
        console.log('[RSS Scan] Approaching time limit, stopping early')
        break
      }

      try {
        // Fetch raw XML, sanitize, then parse — handles malformed feeds
        let feed
        try {
          feed = await parser.parseURL(feedUrl)
        } catch (directErr) {
          // If direct parse fails, try fetch + sanitize
          console.log(`[RSS Scan] Direct parse failed for ${source.name}, trying sanitized fetch...`)
          const res = await fetch(feedUrl, {
            headers: {
              'User-Agent': 'GameDrive/1.0 Coverage Monitor',
              'Accept': 'application/rss+xml, application/xml, text/xml, application/atom+xml'
            },
            redirect: 'follow',
            signal: AbortSignal.timeout(15000)
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
          const rawXml = await res.text()
          const cleanXml = sanitizeXml(rawXml)
          feed = await parser.parseString(cleanXml)
        }
        stats.sources_scanned++

        const newItems: Array<Record<string, unknown>> = []

        for (const entry of (feed.items || [])) {
          if (!entry.link || !entry.title) continue
          stats.items_found++

          const normalizedUrl = normalizeUrl(entry.link)

          // Dedup check
          if (existingUrls.has(normalizedUrl)) {
            stats.items_duplicate++
            continue
          }

          // Keyword matching — try source-linked game's client first, then all keywords
          let bestMatch = { matched: false, score: 0, matchedTerms: [] as string[] }
          let matchedClientId: string | null = null
          let matchedGameId: string | null = source.game_id

          const description = entry.contentSnippet || entry.content || entry.summary || ''

          if (source.game_id && games) {
            // Source is linked to a specific game
            const game = games.find(g => g.id === source.game_id)
            if (game) {
              matchedClientId = game.client_id
              const clientKeywords = whitelistByClient.get(game.client_id) || []
              // For game-specific sources, also include the game name as a keyword
              const combinedKeywords = [...clientKeywords, game.name]
              bestMatch = matchesKeywords(entry.title, description, combinedKeywords, blacklistGlobal)
            }
          }

          if (!bestMatch.matched) {
            // Try matching against all client keyword sets
            for (const [clientId, keywords] of Array.from(whitelistByClient.entries())) {
              const match = matchesKeywords(entry.title, description, keywords, blacklistGlobal)
              if (match.matched && match.score > bestMatch.score) {
                bestMatch = match
                matchedClientId = clientId
              }
            }
          }

          if (!bestMatch.matched) continue

          // Game matching: every item must be linked to a specific game
          if (!matchedGameId && matchedClientId && games) {
            const clientGames = games.filter(g => g.client_id === matchedClientId) as GameInfo[]
            matchedGameId = matchGameFromContent(
              entry.title,
              description,
              bestMatch.matchedTerms,
              allKeywords as KeywordMeta[],
              clientGames
            )
          }

          // Skip items that can't be linked to a game — avoids "Ungrouped" coverage
          if (!matchedGameId) {
            stats.items_no_game = (stats.items_no_game || 0) + 1
            continue
          }

          stats.items_matched++

          // Add to existing URLs to prevent intra-batch duplicates
          existingUrls.add(normalizedUrl)

          // Try to match outlet by domain, auto-create if not found
          let outletId = source.outlet_id
          let outletVisitors = source.outlet?.monthly_unique_visitors || null
          try {
            const articleDomain = new URL(normalizedUrl).hostname.replace('www.', '')
            if (!outletId) {
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
                    tier: null
                  })
                  .select('id')
                  .single()
                if (newOutlet) outletId = newOutlet.id
              }
            }
          } catch (outletErr) {
            console.warn(`[RSS Scan] Outlet lookup/creation error for ${normalizedUrl}:`, outletErr instanceof Error ? outletErr.message : String(outletErr))
          }

          // Infer territory from article domain TLD
          let territory: string | null = null
          try {
            const articleDomainForTerritory = new URL(normalizedUrl).hostname.replace('www.', '')
            territory = inferTerritory(articleDomainForTerritory)
          } catch { /* ignore */ }

          // Don't set relevance_score here — leave null so coverage-enrich cron
          // picks it up for AI scoring with Gemini. Store keyword match info in metadata.
          newItems.push({
            client_id: matchedClientId,
            game_id: matchedGameId,
            outlet_id: outletId,
            title: entry.title.trim(),
            url: normalizedUrl,
            publish_date: entry.isoDate ? entry.isoDate.split('T')[0] : new Date().toISOString().split('T')[0],
            coverage_type: classifyCoverageType('news', normalizedUrl),
            territory,
            monthly_unique_visitors: outletVisitors,
            sentiment: null,
            relevance_score: null, // Left null for AI enrichment
            relevance_reasoning: null, // AI will fill this in
            approval_status: 'pending_review', // AI will upgrade or reject
            source_type: 'rss',
            source_metadata: {
              feed_url: feedUrl,
              feed_title: feed.title || source.name,
              source_id: source.id,
              guid: entry.guid || entry.id || null,
              author: entry.creator || entry.author || null,
              categories: entry.categories || [],
              keyword_score: bestMatch.score,
              matched_keywords: bestMatch.matchedTerms
            },
            discovered_at: new Date().toISOString()
          })
        }

        // Batch insert new items
        if (newItems.length > 0) {
          const { error: insertErr, data: inserted } = await supabase
            .from('coverage_items')
            .upsert(newItems, { onConflict: 'url', ignoreDuplicates: true })
            .select('id')

          if (insertErr) {
            console.error(`[RSS Scan] Insert error for ${source.name}:`, insertErr)
            stats.errors.push(`${source.name}: insert error - ${insertErr.message}`)
          } else {
            stats.items_inserted += inserted?.length || 0
          }
        }

        // Update source status
        await supabase.from('coverage_sources').update({
          last_run_at: new Date().toISOString(),
          last_run_status: 'success',
          last_run_message: `Found ${newItems.length} new items from ${feed.items?.length || 0} feed entries`,
          items_found_last_run: newItems.length,
          total_items_found: (source as CoverageSource & { total_items_found: number }).total_items_found + newItems.length,
          consecutive_failures: 0
        }).eq('id', source.id)

      } catch (err) {
        stats.sources_failed++
        const errMsg = err instanceof Error ? err.message : String(err)
        stats.errors.push(`${source.name}: ${errMsg}`)
        console.error(`[RSS Scan] Failed to parse ${source.name} (${feedUrl}):`, errMsg)

        // Update source with failure
        const newFailures = source.consecutive_failures + 1
        await supabase.from('coverage_sources').update({
          last_run_at: new Date().toISOString(),
          last_run_status: newFailures >= 5 ? 'error' : 'failed',
          last_run_message: errMsg.substring(0, 500),
          last_error_at: new Date().toISOString(),
          consecutive_failures: newFailures,
          // Auto-deactivate after 10 consecutive failures
          ...(newFailures >= 10 ? { is_active: false } : {})
        }).eq('id', source.id)
      }
    }

    const duration = Date.now() - startTime
    console.log(`[RSS Scan] Completed in ${duration}ms:`, stats)

    return NextResponse.json({
      message: 'RSS scan complete',
      duration_ms: duration,
      stats: {
        total_active_sources: sources.length,
        due_for_scan: dueForScan.length,
        batch_size: batch.length,
        ...stats
      }
    })

  } catch (err) {
    console.error('[RSS Scan] Fatal error:', err)
    return NextResponse.json(
      { error: 'RSS scan failed', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
