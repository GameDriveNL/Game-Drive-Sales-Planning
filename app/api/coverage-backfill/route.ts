import { NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { tavily } from '@tavily/core'
import { inferTerritory } from '@/lib/territory'
import { classifyCoverageType, INFORMATIONAL_DOMAINS } from '@/lib/coverage-utils'
import { generateLanguageQueries } from '@/lib/keyword-variants'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300 // 5 minutes for historical backfill

// ─── Helpers ────────────────────────────────────────────────────────────────

// Strips ALL query params, not just utm_*. Storefront/CDN links carry locale
// and referral params (Steam's `l=`, `snr=`, `curator_clanid=`, `sender_campaign=`...)
// that vary per hit on the exact same page, so keeping any of them let the same
// article/page get inserted repeatedly as "new" — 130 "new" backfill results for
// shapez 2 turned out to be ~20 real pages hit under different query strings.
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    let normalized = u.origin + u.pathname
    if (normalized.endsWith('/') && normalized.length > 1) {
      normalized = normalized.slice(0, -1)
    }
    return normalized
  } catch {
    return url.trim()
  }
}

// Generate comprehensive search queries for historical backfill.
//
// Ordering matters because max_queries caps at 30. High-value queries (the
// game name, all variants, language-aware TLD filters) go first; the
// hand-rolled platform/event hints that mostly return duplicates of what
// the base queries already found go last.
function generateBackfillQueries(gameName: string, extraKeywords: string[]): string[] {
  const queries: string[] = []

  // 1. Core identifier — always
  queries.push(gameName)
  queries.push(`"${gameName}"`) // exact match

  // 2. Keyword variants (each variant gets one query — the quoted form rarely
  // adds new results once Tavily has the unquoted one).
  for (const kw of extraKeywords) {
    if (kw.toLowerCase() !== gameName.toLowerCase()) {
      queries.push(kw)
    }
  }

  // 3. Language-aware queries — empirically these unlocked +52 new items for
  // Dark Pals in one production run (.nl=14, .jp=19, .de=19). Run BEFORE the
  // hand-rolled augments below because their delta-per-query is much higher.
  for (const lq of generateLanguageQueries(gameName)) queries.push(lq)

  // 4. Editorial-style augments — useful but high overlap with #1, so they
  // come last and absorb whatever query budget remains.
  queries.push(`${gameName} review`)
  queries.push(`${gameName} demo`)
  queries.push(`${gameName} announcement`)
  queries.push(`${gameName} reveal`)
  queries.push(`${gameName} trailer`)
  queries.push(`${gameName} release date`)
  queries.push(`${gameName} preview`)
  queries.push(`${gameName} news`)
  queries.push(`${gameName} gameplay`)
  queries.push(`${gameName} showcase`)
  queries.push(`${gameName} Steam`)
  queries.push(`${gameName} PlayStation`)
  queries.push(`${gameName} Xbox`)
  queries.push(`${gameName} Nintendo Switch`)

  // Deduplicate
  const seen = new Set<string>()
  return queries.filter(q => {
    const lower = q.toLowerCase()
    if (seen.has(lower)) return false
    seen.add(lower)
    return true
  })
}

// ─── POST: Historical backfill scan ─────────────────────────────────────────

export async function POST(request: Request) {
  const startTime = Date.now()
  const supabase = getServerSupabase()

  try {
    const body = await request.json()
    const gameId = body.game_id as string | undefined
    const maxQueries = Math.min(body.max_queries || 20, 30) // cap at 30 queries
    const dryRun = body.dry_run as boolean | undefined
    const dateFrom = body.date_from as string | undefined
    const dateTo = body.date_to as string | undefined

    if (!gameId) {
      return NextResponse.json({ error: 'game_id is required' }, { status: 400 })
    }

    // Get Tavily API key
    const { data: keyData } = await supabase
      .from('service_api_keys')
      .select('api_key')
      .eq('service_name', 'tavily')
      .single()

    if (!keyData?.api_key) {
      return NextResponse.json({ error: 'Tavily API key not configured' }, { status: 400 })
    }

    const tvly = tavily({ apiKey: keyData.api_key })

    // Fetch game info
    const { data: game } = await supabase
      .from('games')
      .select('id, name, client_id')
      .eq('id', gameId)
      .single()

    if (!game) {
      return NextResponse.json({ error: 'Game not found' }, { status: 404 })
    }

    // Fetch source config for extra keywords
    const { data: sources } = await supabase
      .from('coverage_sources')
      .select('config')
      .eq('game_id', gameId)
      .eq('source_type', 'tavily')
      .eq('is_active', true)

    const extraKeywords: string[] = []
    for (const s of (sources || [])) {
      if (Array.isArray(s.config?.keywords)) {
        extraKeywords.push(...(s.config.keywords as string[]))
      }
    }

    // Fetch blacklist keywords
    const { data: keywords } = await supabase
      .from('coverage_keywords')
      .select('keyword, keyword_type')

    const blacklistGlobal = (keywords || [])
      .filter((k: { keyword_type: string }) => k.keyword_type === 'blacklist')
      .map((k: { keyword: string }) => k.keyword.toLowerCase())

    // Fetch existing URLs for dedup
    const { data: existingItems } = await supabase
      .from('coverage_items')
      .select('url')
      .order('created_at', { ascending: false })
      .limit(10000)

    const existingUrls = new Set<string>()
    if (existingItems) {
      for (const item of existingItems) existingUrls.add(normalizeUrl(item.url))
    }

    // Generate queries
    const allQueries = generateBackfillQueries(game.name, extraKeywords)
    const queriesToRun = allQueries.slice(0, maxQueries)

    const newItems: Array<Record<string, unknown>> = []
    let queriesMade = 0
    const queryResults: Array<{ query: string; results_found: number; new_items: number }> = []

    for (const searchQuery of queriesToRun) {
      // Time guard: stop if approaching 4.5 min
      if (Date.now() - startTime > 270000) break

      try {
        // topic: 'news' — general web search returns storefronts/wikis/forums
        // and rarely a publishedDate; news search is tuned for actual press
        // coverage and is the only mode that reliably populates it.
        // startDate/endDate are the real Tavily SDK field names — the previous
        // publishedAfterDate/publishedBeforeDate aren't real options, so the
        // date range picked in the UI was silently doing nothing.
        const searchOpts: Record<string, unknown> = {
          maxResults: 20,
          searchDepth: 'advanced',
          includeAnswer: false,
          topic: 'news',
          excludeDomains: INFORMATIONAL_DOMAINS,
        }
        if (dateFrom) searchOpts.startDate = dateFrom
        if (dateTo) searchOpts.endDate = dateTo

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const response = await tvly.search(searchQuery, searchOpts as any)
        queriesMade++

        let newForQuery = 0
        for (const result of (response.results || [])) {
          if (!result.url || !result.title) continue

          const normalizedUrl = normalizeUrl(result.url)
          if (existingUrls.has(normalizedUrl)) continue

          const text = `${result.title} ${result.content || ''}`.toLowerCase()
          if (blacklistGlobal.some((bk: string) => text.includes(bk))) continue

          // Hard relevance floor: the game name must appear somewhere, or this
          // result isn't about the game at all (query drift). This is a filter,
          // not a scoring decision — actual approval is left to AI review below,
          // same as the daily Tavily scan cron. Self-approving off a crude
          // "title contains game name" heuristic was exactly why storefront and
          // CD-key-reseller pages (which always contain the game name) sailed
          // through as auto_approved with zero review.
          const titleLower = result.title.toLowerCase()
          const gameLower = game.name.toLowerCase()
          const nameMatches = titleLower.includes(gameLower) || text.includes(gameLower)
            || titleLower.includes('we were here') || text.includes('we were here')
          if (!nameMatches) continue

          // Kept for source_metadata/diagnostics only — not used for approval.
          let keywordScore = titleLower.includes(gameLower) ? 80 : 65
          if (result.score && result.score > 0.7) keywordScore += 10
          keywordScore = Math.min(keywordScore, 100)

          existingUrls.add(normalizedUrl)

          // Try to match outlet + infer territory
          let outletId: string | null = null
          let territory: string | null = null
          try {
            const resultDomain = new URL(result.url).hostname.replace('www.', '')
            territory = inferTerritory(resultDomain)
            const { data: outlet } = await supabase
              .from('outlets')
              .select('id, is_blacklisted')
              .eq('domain', resultDomain)
              .single()
            if (outlet) {
              if (outlet.is_blacklisted) continue
              outletId = outlet.id
            }
          } catch { /* ignore */ }

          newItems.push({
            client_id: game.client_id,
            game_id: gameId,
            outlet_id: outletId,
            title: result.title.trim(),
            url: normalizedUrl,
            publish_date: result.publishedDate ? result.publishedDate.split('T')[0] : null,
            coverage_type: classifyCoverageType('news', normalizedUrl),
            territory,
            // Left null for AI enrichment (coverage-enrich cron), same as the
            // daily Tavily scan — don't self-approve off a keyword heuristic.
            relevance_score: null,
            relevance_reasoning: null,
            approval_status: 'pending_review',
            source_type: 'tavily',
            source_metadata: {
              search_query: searchQuery,
              backfill: true,
              tavily_score: result.score || null,
              keyword_score: keywordScore,
              content_snippet: result.content?.substring(0, 300) || null
            },
            discovered_at: new Date().toISOString()
          })
          newForQuery++
        }

        queryResults.push({
          query: searchQuery,
          results_found: response.results?.length || 0,
          new_items: newForQuery
        })

        // Brief delay between queries to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500))

      } catch (err) {
        queryResults.push({
          query: searchQuery,
          results_found: 0,
          new_items: 0
        })
        console.error(`Backfill query failed: "${searchQuery}"`, err)
      }
    }

    // Insert results (unless dry run)
    let insertedCount = 0
    if (!dryRun && newItems.length > 0) {
      // Insert in batches of 50
      for (let i = 0; i < newItems.length; i += 50) {
        const batch = newItems.slice(i, i + 50)
        const { data: inserted, error: insertErr } = await supabase
          .from('coverage_items')
          .upsert(batch, { onConflict: 'url', ignoreDuplicates: true })
          .select('id')

        if (!insertErr && inserted) {
          insertedCount += inserted.length
        } else if (insertErr) {
          console.error('Batch insert error:', insertErr)
        }
      }
    }

    return NextResponse.json({
      message: dryRun ? 'Dry run complete (nothing inserted)' : 'Historical backfill complete',
      game: game.name,
      duration_ms: Date.now() - startTime,
      queries_planned: queriesToRun.length,
      queries_executed: queriesMade,
      total_new_items: newItems.length,
      inserted: insertedCount,
      cost_estimate_usd: queriesMade * 0.02, // advanced search costs ~2x
      // All inserted items land as pending_review for AI enrichment (coverage-enrich
      // cron) to score — see the nameMatches/keywordScore comment above.
      pending_review: newItems.length,
      query_details: queryResults,
      ...(dryRun ? { items_preview: newItems.slice(0, 10).map(i => ({ title: i.title, url: i.url, score: i.relevance_score, status: i.approval_status })) } : {})
    })

  } catch (err) {
    return NextResponse.json(
      { error: 'Backfill failed', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
