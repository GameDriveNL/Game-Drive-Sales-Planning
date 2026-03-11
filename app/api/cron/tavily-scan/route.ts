import { NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { tavily } from '@tavily/core'
import { inferTerritory } from '@/lib/territory'
import { domainToOutletName } from '@/lib/outlet-utils'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

// ─── Types ──────────────────────────────────────────────────────────────────

interface CoverageSource {
  id: string
  source_type: string
  name: string
  config: { domain?: string; keywords?: string[]; [key: string]: unknown }
  outlet_id: string | null
  game_id: string | null
  scan_frequency: string
  is_active: boolean
  last_run_at: string | null
  consecutive_failures: number
  total_items_found: number
  outlet?: { id: string; tier: string | null; monthly_unique_visitors: number | null } | null
}

interface Keyword {
  keyword: string
  keyword_type: 'whitelist' | 'blacklist'
  client_id: string
  game_id: string | null
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function shouldScanNow(source: CoverageSource): boolean {
  if (!source.last_run_at) return true
  const lastRun = new Date(source.last_run_at).getTime()
  const hoursSince = (Date.now() - lastRun) / (1000 * 60 * 60)
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

// ─── Main Handler ───────────────────────────────────────────────────────────

export async function GET(request: Request) {
  const startTime = Date.now()
  const supabase = getServerSupabase()

  try {
    // Auth
    const authHeader = request.headers.get('authorization')
    const expectedAuth = `Bearer ${process.env.CRON_SECRET}`
    const isManualTest = request.headers.get('user-agent')?.includes('Mozilla')

    if (!isManualTest && authHeader !== expectedAuth) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // 1. Get Tavily API key from service_api_keys
    const { data: keyData } = await supabase
      .from('service_api_keys')
      .select('api_key')
      .eq('service_name', 'tavily')
      .single()

    if (!keyData?.api_key) {
      return NextResponse.json({ message: 'Tavily API key not configured', stats: { scanned: 0 } })
    }

    const tvly = tavily({ apiKey: keyData.api_key })

    // 2. Fetch active Tavily sources
    const { data: sources, error: srcErr } = await supabase
      .from('coverage_sources')
      .select('*, outlet:outlets(id, tier, monthly_unique_visitors)')
      .eq('source_type', 'tavily')
      .eq('is_active', true)

    if (srcErr || !sources || sources.length === 0) {
      return NextResponse.json({ message: 'No active Tavily sources', stats: { scanned: 0 } })
    }

    const dueForScan = (sources as CoverageSource[]).filter(shouldScanNow)

    if (dueForScan.length === 0) {
      return NextResponse.json({
        message: 'No Tavily sources due for scanning',
        stats: { total_sources: sources.length, due_for_scan: 0 }
      })
    }

    // 3. Fetch keywords for matching
    const { data: keywords } = await supabase
      .from('coverage_keywords')
      .select('keyword, keyword_type, client_id, game_id')

    const allKeywords = (keywords || []) as Keyword[]
    const blacklistGlobal = allKeywords.filter(k => k.keyword_type === 'blacklist').map(k => k.keyword.toLowerCase())

    // 4. Fetch games for matching
    const { data: games } = await supabase.from('games').select('id, name, client_id')

    // 5. Fetch existing URLs for dedup
    const { data: existingItems } = await supabase
      .from('coverage_items')
      .select('url')
      .order('created_at', { ascending: false })
      .limit(10000)

    const existingUrls = new Set<string>()
    if (existingItems) {
      for (const item of existingItems) existingUrls.add(normalizeUrl(item.url))
    }

    // 6. Process each Tavily source
    const stats = {
      sources_scanned: 0,
      sources_failed: 0,
      searches_made: 0,
      items_found: 0,
      items_inserted: 0,
      items_duplicate: 0,
      estimated_cost: 0,
      errors: [] as string[]
    }

    // Limit to 5 sources per cron run to manage costs and time
    const batch = dueForScan.slice(0, 5)

    for (const source of batch) {
      // Time guard
      if (Date.now() - startTime > 45000) {
        console.log('[Tavily Scan] Approaching time limit, stopping early')
        break
      }

      try {
        // Build search queries from source config + game keywords
        const searchQueries: string[] = []
        const domain = source.config?.domain
        const sourceKeywords = Array.isArray(source.config?.keywords) ? source.config.keywords as string[] : []

        // Get game-specific keywords if linked to a game
        let matchedClientId: string | null = null
        let matchedGameId: string | null = source.game_id

        if (source.game_id && games) {
          const game = games.find(g => g.id === source.game_id)
          if (game) {
            matchedClientId = game.client_id
            // Build queries: game name + each source keyword
            if (sourceKeywords.length > 0) {
              for (const kw of sourceKeywords) {
                searchQueries.push(`${game.name} ${kw}`)
              }
            } else {
              searchQueries.push(game.name)
            }
          }
        } else if (sourceKeywords.length > 0) {
          // No game linked — use keywords directly
          for (const kw of sourceKeywords) {
            searchQueries.push(kw)
          }
        } else if (domain) {
          // Domain-only monitoring: search for recent articles on this domain
          searchQueries.push(`site:${domain} gaming news`)
        }

        if (searchQueries.length === 0) {
          await supabase.from('coverage_sources').update({
            last_run_at: new Date().toISOString(),
            last_run_status: 'error',
            last_run_message: 'No search queries generated — configure keywords or link a game'
          }).eq('id', source.id)
          continue
        }

        const newItems: Array<Record<string, unknown>> = []

        // Execute searches (limit 2 queries per source per run to manage costs)
        for (const query of searchQueries.slice(0, 2)) {
          if (Date.now() - startTime > 45000) break

          try {
            const searchOptions: Record<string, unknown> = {
              maxResults: 10,
              searchDepth: 'basic' as const,
              includeAnswer: false
            }

            // If source has a domain, restrict search to that domain
            if (domain) {
              searchOptions.includeDomains = [domain]
            }

            const response = await tvly.search(query, searchOptions)
            stats.searches_made++
            stats.estimated_cost += 0.01 // ~$0.01 per search

            for (const result of (response.results || [])) {
              if (!result.url || !result.title) continue
              stats.items_found++

              const normalizedUrl = normalizeUrl(result.url)
              if (existingUrls.has(normalizedUrl)) {
                stats.items_duplicate++
                continue
              }

              // Check blacklist
              const text = `${result.title} ${result.content || ''}`.toLowerCase()
              const isBlacklisted = blacklistGlobal.some(bk => text.includes(bk))
              if (isBlacklisted) continue

              // Compute a keyword score for metadata (but don't set relevance_score — let Gemini do it)
              let keywordScore = 60 // Base score for Tavily results (they're already search-relevant)
              const matchedTerms: string[] = []
              if (source.game_id && games) {
                const game = games.find(g => g.id === source.game_id)
                if (game && result.title.toLowerCase().includes(game.name.toLowerCase())) {
                  keywordScore += 25
                  matchedTerms.push(game.name)
                }
              }
              if (result.score && result.score > 0.7) keywordScore += 10
              keywordScore = Math.min(keywordScore, 100)

              existingUrls.add(normalizedUrl)

              // Try to match outlet by domain, auto-create if not found
              let outletId = source.outlet_id
              try {
                const resultDomain = new URL(result.url).hostname.replace('www.', '')
                if (!outletId) {
                  const { data: outlet } = await supabase
                    .from('outlets')
                    .select('id, monthly_unique_visitors, is_blacklisted')
                    .eq('domain', resultDomain)
                    .single()
                  if (outlet) {
                    if (outlet.is_blacklisted) continue // Skip blacklisted outlets
                    outletId = outlet.id
                  } else {
                    // Auto-create outlet from domain
                    const outletName = domainToOutletName(resultDomain)
                    const { data: newOutlet } = await supabase
                      .from('outlets')
                      .insert({
                        name: outletName,
                        domain: resultDomain,
                        tier: null
                      })
                      .select('id')
                      .single()
                    if (newOutlet) outletId = newOutlet.id
                  }
                }
              } catch { /* ignore outlet lookup errors */ }

              // Use publish date from Tavily, fall back to today
              const publishDate = result.publishedDate
                ? result.publishedDate.split('T')[0]
                : new Date().toISOString().split('T')[0]

              // Infer territory from domain TLD
              let territory: string | null = null
              try {
                const resultDomainForTerritory = new URL(result.url).hostname.replace('www.', '')
                territory = inferTerritory(resultDomainForTerritory)
              } catch { /* ignore */ }

              // Don't set relevance_score — leave null so coverage-enrich cron
              // picks it up for AI scoring with Gemini
              newItems.push({
                client_id: matchedClientId,
                game_id: matchedGameId,
                outlet_id: outletId,
                title: result.title.trim(),
                url: normalizedUrl,
                publish_date: publishDate,
                coverage_type: 'news', // Gemini will refine this
                territory,
                relevance_score: null, // Left null for AI enrichment
                relevance_reasoning: null, // AI will fill this
                approval_status: 'pending_review', // AI will upgrade or reject
                source_type: 'tavily',
                source_metadata: {
                  search_query: query,
                  source_id: source.id,
                  tavily_score: result.score || null,
                  content_snippet: result.content?.substring(0, 300) || null,
                  search_domain: domain || null,
                  keyword_score: keywordScore,
                  matched_keywords: matchedTerms
                },
                discovered_at: new Date().toISOString()
              })
            }
          } catch (searchErr) {
            const msg = searchErr instanceof Error ? searchErr.message : String(searchErr)
            stats.errors.push(`${source.name} query "${query}": ${msg}`)
            console.error(`[Tavily Scan] Search error for ${source.name}:`, msg)
          }
        }

        // Insert new items
        if (newItems.length > 0) {
          const { data: inserted, error: insertErr } = await supabase
            .from('coverage_items')
            .upsert(newItems, { onConflict: 'url', ignoreDuplicates: true })
            .select('id')

          if (insertErr) {
            stats.errors.push(`${source.name}: insert error - ${insertErr.message}`)
          } else {
            stats.items_inserted += inserted?.length || 0
          }
        }

        stats.sources_scanned++

        // Update source status
        await supabase.from('coverage_sources').update({
          last_run_at: new Date().toISOString(),
          last_run_status: 'success',
          last_run_message: `Searched ${Math.min(searchQueries.length, 2)} queries, found ${newItems.length} new items`,
          items_found_last_run: newItems.length,
          total_items_found: source.total_items_found + newItems.length,
          consecutive_failures: 0
        }).eq('id', source.id)

      } catch (err) {
        stats.sources_failed++
        const errMsg = err instanceof Error ? err.message : String(err)
        stats.errors.push(`${source.name}: ${errMsg}`)

        const newFailures = source.consecutive_failures + 1
        await supabase.from('coverage_sources').update({
          last_run_at: new Date().toISOString(),
          last_run_status: newFailures >= 5 ? 'error' : 'failed',
          last_run_message: errMsg.substring(0, 500),
          last_error_at: new Date().toISOString(),
          consecutive_failures: newFailures,
          ...(newFailures >= 10 ? { is_active: false } : {})
        }).eq('id', source.id)
      }
    }

    // 7. Log cost estimate
    if (stats.estimated_cost > 0) {
      console.log(`[Tavily Scan] Estimated cost: $${stats.estimated_cost.toFixed(3)}`)
    }

    const duration = Date.now() - startTime
    return NextResponse.json({
      message: 'Tavily scan complete',
      duration_ms: duration,
      stats: {
        total_active_sources: sources.length,
        due_for_scan: dueForScan.length,
        batch_size: batch.length,
        ...stats
      }
    })

  } catch (err) {
    console.error('[Tavily Scan] Fatal error:', err)
    return NextResponse.json(
      { error: 'Tavily scan failed', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
