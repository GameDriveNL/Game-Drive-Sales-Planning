import { NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { tavily } from '@tavily/core'
import { inferTerritory } from '@/lib/territory'
import { domainToOutletName } from '@/lib/outlet-utils'
import { detectOutletCountry } from '@/lib/outlet-country'
import { matchGameFromContent, classifyCoverageType } from '@/lib/coverage-utils'
import { autoDiscoverAndCreateRssSource } from '@/lib/rss-discovery'
import { verifyCronAuth } from '@/lib/cron-auth'
import { generateLanguageQueries } from '@/lib/keyword-variants'
import { seedOutletAcrossGames } from '@/lib/cross-game-outlet-seed'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300 // Recall boost: was 60, now 5min so the more aggressive 4-queries-per-source x 25-results can complete

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

// Aliases matching coverage-utils function signatures
type GameInfo = { id: string; name: string; client_id: string }
type KeywordMeta = { keyword: string; client_id: string; game_id: string | null }

// ─── Helpers ────────────────────────────────────────────────────────────────

function shouldScanNow(source: CoverageSource): boolean {
  if (!source.last_run_at) return true
  const lastRun = new Date(source.last_run_at).getTime()
  const hoursSince = (Date.now() - lastRun) / (1000 * 60 * 60)
  switch (source.scan_frequency) {
    case 'hourly': return hoursSince >= 0.9
    case 'every_6h': return hoursSince >= 5.5
    case 'every_12h': return hoursSince >= 11
    case 'daily': return hoursSince >= 11 // Allow 2x daily runs (vercel cron at 6AM + 6PM)
    case 'weekly': return hoursSince >= 167
    default: return hoursSince >= 11
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
    // Auth — fails closed (was a Mozilla User-Agent bypass; trivially spoofed).
    const authError = verifyCronAuth(request)
    if (authError) return authError

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
    let { data: sources, error: srcErr } = await supabase
      .from('coverage_sources')
      .select('*, outlet:outlets(id, tier, monthly_unique_visitors)')
      .eq('source_type', 'tavily')
      .eq('is_active', true)

    if (srcErr) {
      return NextResponse.json({ message: 'Failed to fetch sources', stats: { scanned: 0 } })
    }

    // 3. Fetch keywords and games early (needed for auto-provisioning + matching)
    const { data: keywords } = await supabase
      .from('coverage_keywords')
      .select('keyword, keyword_type, client_id, game_id')

    const allKeywords = (keywords || []) as Keyword[]
    const blacklistGlobal = allKeywords.filter(k => k.keyword_type === 'blacklist').map(k => k.keyword.toLowerCase())

    const { data: games } = await supabase.from('games').select('id, name, client_id')

    // Auto-provision: create Tavily sources for games that don't have one
    let autoProvisioned = 0
    if (games && games.length > 0) {
      const gamesWithSources = new Set(
        ((sources || []) as CoverageSource[])
          .filter(s => s.game_id)
          .map(s => s.game_id)
      )

      for (const game of games) {
        if (!gamesWithSources.has(game.id)) {
          // Get game-specific keywords to enhance search queries
          const gameKeywords = allKeywords
            .filter(k => k.game_id === game.id && k.keyword_type === 'whitelist')
            .map(k => k.keyword)

          const { error: provisionErr } = await supabase
            .from('coverage_sources')
            .insert({
              source_type: 'tavily',
              name: `${game.name} - Web Search`,
              config: { keywords: [game.name, ...gameKeywords.slice(0, 3)] },
              game_id: game.id,
              scan_frequency: 'daily',
              is_active: true,
              consecutive_failures: 0,
              total_items_found: 0
            })

          if (!provisionErr) {
            autoProvisioned++
            console.log(`[Tavily Scan] Auto-provisioned source for game: ${game.name}`)
          }
        }
      }

      // Re-fetch sources if we added new ones
      if (autoProvisioned > 0) {
        const { data: refreshedSources } = await supabase
          .from('coverage_sources')
          .select('*, outlet:outlets(id, tier, monthly_unique_visitors)')
          .eq('source_type', 'tavily')
          .eq('is_active', true)
        if (refreshedSources) {
          sources = refreshedSources
        }
      }
    }

    if (!sources || sources.length === 0) {
      return NextResponse.json({ message: 'No active Tavily sources', stats: { scanned: 0, auto_provisioned: autoProvisioned } })
    }

    // Sort least-recently-scanned first (NULL last_run_at = never scanned, highest priority).
    // Without this, slice(0, 8) below deterministically picked the same 8 oldest sources every
    // run, starving newer ones — 11 of 26 active Tavily sources had last_run_at: null because
    // they always lost the batch race to longer-tenured rows.
    const dueForScan = (sources as CoverageSource[])
      .filter(shouldScanNow)
      .sort((a, b) => {
        if (!a.last_run_at && !b.last_run_at) return 0
        if (!a.last_run_at) return -1
        if (!b.last_run_at) return 1
        return new Date(a.last_run_at).getTime() - new Date(b.last_run_at).getTime()
      })

    if (dueForScan.length === 0) {
      return NextResponse.json({
        message: 'No Tavily sources due for scanning',
        stats: { total_sources: sources.length, due_for_scan: 0, auto_provisioned: autoProvisioned }
      })
    }

    // 4. Fetch existing URLs for dedup
    const { data: existingItems } = await supabase
      .from('coverage_items')
      .select('url')
      .order('created_at', { ascending: false })
      .limit(10000)

    const existingUrls = new Set<string>()
    if (existingItems) {
      for (const item of existingItems) existingUrls.add(normalizeUrl(item.url))
    }

    // ─── Coverage Waterfall Strategy ─────────────────────────────────────────
    // Tavily is the PAID tier of the coverage waterfall — use sparingly:
    //   1. RSS feeds (free) — covers ~88 outlets automatically
    //   2. Web scraping (free) — covers Tier A/B outlets without RSS
    //   3. Tavily search (paid, HERE) — broad game-name search for remaining gaps
    // Daily budget target: ~$1-2/day across all games
    // ──────────────────────────────────────────────────────────────────────────

    // Daily cost cap: stop if we've already spent too much today
    const DAILY_COST_CAP = 2.00 // $2/day max
    const { data: todayRuns } = await supabase
      .from('coverage_sources')
      .select('last_run_at, items_found_last_run')
      .eq('source_type', 'tavily')
      .gte('last_run_at', new Date(new Date().setHours(0, 0, 0, 0)).toISOString())

    // Rough estimate: each run costs ~$0.02-0.03
    const todayRunCount = todayRuns?.length || 0
    const estimatedTodayCost = todayRunCount * 0.025
    if (estimatedTodayCost >= DAILY_COST_CAP) {
      return NextResponse.json({
        message: `Tavily daily cost cap reached (~$${estimatedTodayCost.toFixed(2)} spent today from ${todayRunCount} runs)`,
        stats: { scanned: 0, cost_cap_hit: true, estimated_today_cost: estimatedTodayCost }
      })
    }

    // 6. Process each Tavily source
    const stats = {
      sources_scanned: 0,
      sources_failed: 0,
      searches_made: 0,
      items_found: 0,
      items_inserted: 0,
      items_duplicate: 0,
      items_no_game: 0,
      estimated_cost: 0,
      rss_discovered: 0,
      errors: [] as string[]
    }

    // Track newly created outlets for RSS discovery + cross-game seeding at the end.
    // originatingGameId tells the cross-seeder which game already covered this outlet
    // so it doesn't waste a query re-finding it.
    const newOutlets: Array<{ id: string; domain: string; name: string; originatingGameId: string | null }> = []

    // Process up to 8 sources per cron run
    const batch = dueForScan.slice(0, 8)

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

            // Recall boost: pull ALL whitelist keyword variants for this game
            // from coverage_keywords. The seed keyword + studio name + slugs
            // we just added all become standalone queries — catches translated
            // or oblique press that doesn't use the exact game name.
            const { data: whitelistKws } = await supabase
              .from('coverage_keywords')
              .select('keyword')
              .eq('game_id', game.id)
              .eq('keyword_type', 'whitelist')
              .eq('is_active', true)

            const queryTerms = new Set<string>([game.name])
            for (const kw of (whitelistKws || [])) {
              if (kw.keyword && kw.keyword.length >= 3) queryTerms.add(kw.keyword)
            }
            // Also include source.config keywords if provided (e.g. operator-curated phrases)
            for (const kw of sourceKeywords) {
              if (kw && kw.length >= 3) queryTerms.add(kw)
            }
            // Each term as its own search query — Tavily handles synonym/related-term retrieval per query
            Array.from(queryTerms).forEach(term => searchQueries.push(term))

            // Recall boost: add one language-aware query per run, rotating
            // across TLD/language candidates by day-of-year so editorial
            // coverage on non-English outlets (NL/JP/DE/BR/FR/AR) gets
            // surfaced over the course of ~2 weeks without busting the
            // 4-queries-per-source budget. Empirically these queries
            // unlocked 6/14 missed editorial URLs for Dark Pals.
            const langQueries = generateLanguageQueries(game.name)
            const dayOfYear = Math.floor(
              (Date.now() - new Date(new Date().getUTCFullYear(), 0, 0).getTime()) / 86400000
            )
            const rotatedLangQuery = langQueries[dayOfYear % langQueries.length]
            searchQueries.push(rotatedLangQuery)
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

        // Recall boost: was 2 queries / 45s budget. Now 4 queries / 90s and
        // EVERY query gets `advanced` depth + 25 results. Cost roughly doubles
        // per run but recall should ~2x toward the 33% → 60-70% range
        // Stephanie is asking for.
        const queriesToRun = searchQueries.slice(0, 4)
        const sourceStart = Date.now()
        for (let qi = 0; qi < queriesToRun.length; qi++) {
          const query = queriesToRun[qi]
          // Per-source time budget: 20s per source so the cron can still cycle
          // through multiple sources within its overall 300s maxDuration.
          if (Date.now() - sourceStart > 20000) break
          if (Date.now() - startTime > 270000) break // leave 30s for cleanup

          try {
            const searchOptions: Record<string, unknown> = {
              maxResults: 25,
              searchDepth: 'advanced',
              includeAnswer: false
            }

            // If source has a domain, restrict search to that domain
            if (domain) {
              searchOptions.includeDomains = [domain]
            }

            const response = await tvly.search(query, searchOptions)
            stats.searches_made++
            // All queries now run at advanced depth — ~$0.02 each
            stats.estimated_cost += 0.02

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

              // Game matching: every item must be linked to a specific game
              if (!matchedGameId && matchedClientId && games) {
                const clientGames = games.filter(g => g.client_id === matchedClientId) as GameInfo[]
                matchedGameId = matchGameFromContent(
                  result.title,
                  result.content || '',
                  matchedTerms,
                  allKeywords as KeywordMeta[],
                  clientGames
                )
              }

              // Skip items that can't be linked to a game — avoids "Ungrouped" coverage
              if (!matchedGameId) {
                stats.items_no_game = (stats.items_no_game || 0) + 1
                continue
              }

              existingUrls.add(normalizedUrl)

              // Try to match outlet by domain, auto-create if not found
              let outletId = source.outlet_id
              let outletTraffic: number | null = null
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
                    outletTraffic = outlet.monthly_unique_visitors
                  } else {
                    // Auto-create outlet from domain
                    const outletName = domainToOutletName(resultDomain)
                    const { data: newOutlet } = await supabase
                      .from('outlets')
                      .insert({
                        name: outletName,
                        domain: resultDomain,
                        country: detectOutletCountry(resultDomain),
                        tier: 'C'
                      })
                      .select('id')
                      .single()
                    if (newOutlet) {
                      outletId = newOutlet.id
                      // Track for RSS auto-discovery + cross-game seeding at end of scan
                      if (!newOutlets.some(o => o.domain === resultDomain)) {
                        newOutlets.push({
                          id: newOutlet.id,
                          domain: resultDomain,
                          name: outletName,
                          originatingGameId: source.game_id,
                        })
                      }
                    }
                  }
                }
              } catch (outletErr) {
                console.warn(`[Tavily Scan] Outlet lookup error for ${result.url}:`, outletErr)
              }

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
                coverage_type: classifyCoverageType('news', normalizedUrl),
                territory,
                monthly_unique_visitors: outletTraffic, // Propagate from outlet
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

    // 8. Auto-discover RSS feeds for newly created outlets (non-blocking)
    // Run in background — don't hold up the response
    let crossSeedNewItems = 0
    if (newOutlets.length > 0) {
      const rssPromises = newOutlets.slice(0, 5).map(async (outlet) => {
        try {
          const result = await autoDiscoverAndCreateRssSource(
            outlet.id, outlet.domain, outlet.name, supabase
          )
          if (result.found) stats.rss_discovered++
        } catch (err) {
          console.warn(`[Tavily Scan] RSS discovery failed for ${outlet.domain}:`, err)
        }
      })
      // Wait up to 10s for RSS discovery, then move on
      await Promise.race([
        Promise.allSettled(rssPromises),
        new Promise(resolve => setTimeout(resolve, 10000))
      ])
      if (stats.rss_discovered > 0) {
        console.log(`[Tavily Scan] Auto-discovered ${stats.rss_discovered} RSS feeds from ${newOutlets.length} new outlets`)
      }

      // 9. Cross-game outlet seeding: each newly-discovered outlet might cover
      // other PR-tracked games too. Run one targeted Tavily site: query per
      // (outlet × other_game) pair so a single discovery multiplies across
      // the portfolio. Cap to top 3 outlets per scan to bound cost.
      if (keyData?.api_key && (Date.now() - startTime) < 240000) {
        const seedPromises = newOutlets.slice(0, 3).map(o =>
          seedOutletAcrossGames(supabase, o.id, o.domain, o.originatingGameId, keyData.api_key)
            .catch(err => {
              console.warn(`[Tavily Scan] Cross-game seed failed for ${o.domain}:`, err)
              return { total_new_items: 0 }
            })
        )
        const seedResults = await Promise.race([
          Promise.all(seedPromises),
          new Promise<Array<{ total_new_items: number }>>(resolve => setTimeout(() => resolve([]), 60000))
        ])
        for (const r of (seedResults as Array<{ total_new_items: number }>)) {
          crossSeedNewItems += r.total_new_items || 0
        }
        if (crossSeedNewItems > 0) {
          console.log(`[Tavily Scan] Cross-game seeding: +${crossSeedNewItems} items across other PR-tracked games`)
        }
      }
    }
    stats.items_inserted += crossSeedNewItems

    const duration = Date.now() - startTime
    return NextResponse.json({
      message: 'Tavily scan complete',
      duration_ms: duration,
      stats: {
        total_active_sources: sources.length,
        due_for_scan: dueForScan.length,
        batch_size: batch.length,
        auto_provisioned: autoProvisioned,
        new_outlets: newOutlets.length,
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
