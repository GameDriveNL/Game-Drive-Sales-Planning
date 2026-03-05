import { NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { tavily } from '@tavily/core'
import { inferTerritory } from '@/lib/territory'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300 // 5 minutes for historical backfill

// ─── Helpers ────────────────────────────────────────────────────────────────

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

function determineApprovalStatus(score: number): string {
  if (score >= 80) return 'auto_approved'
  if (score >= 50) return 'pending_review'
  return 'rejected'
}

// Generate comprehensive search queries for historical backfill
function generateBackfillQueries(gameName: string, extraKeywords: string[]): string[] {
  const queries: string[] = []

  // Core game name queries
  queries.push(gameName)
  queries.push(`"${gameName}"`) // exact match
  queries.push(`${gameName} announcement`)
  queries.push(`${gameName} reveal`)
  queries.push(`${gameName} trailer`)
  queries.push(`${gameName} release date`)
  queries.push(`${gameName} preview`)
  queries.push(`${gameName} review`)
  queries.push(`${gameName} news`)
  queries.push(`${gameName} game`)

  // Platform-specific queries
  queries.push(`${gameName} Steam`)
  queries.push(`${gameName} PlayStation`)
  queries.push(`${gameName} Xbox`)
  queries.push(`${gameName} Nintendo Switch`)

  // Event-specific queries
  queries.push(`${gameName} showcase`)
  queries.push(`${gameName} demo`)
  queries.push(`${gameName} gameplay`)

  // Extra keywords from source config or game aliases
  for (const kw of extraKeywords) {
    if (kw.toLowerCase() !== gameName.toLowerCase()) {
      queries.push(kw)
      queries.push(`"${kw}"`)
    }
  }

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
        const response = await tvly.search(searchQuery, {
          maxResults: 20,
          searchDepth: 'advanced' as const,
          includeAnswer: false
        })
        queriesMade++

        let newForQuery = 0
        for (const result of (response.results || [])) {
          if (!result.url || !result.title) continue

          const normalizedUrl = normalizeUrl(result.url)
          if (existingUrls.has(normalizedUrl)) continue

          const text = `${result.title} ${result.content || ''}`.toLowerCase()
          if (blacklistGlobal.some((bk: string) => text.includes(bk))) continue

          // Scoring: higher bar for backfill since game name should appear
          let score = 50
          const titleLower = result.title.toLowerCase()
          const gameLower = game.name.toLowerCase()

          if (titleLower.includes(gameLower)) {
            score += 30
          } else if (text.includes(gameLower)) {
            score += 15
          }

          // Check for series mentions
          if (titleLower.includes('we were here') || text.includes('we were here')) {
            score += 10
          }

          if (result.score && result.score > 0.7) score += 10
          if (result.score && result.score > 0.9) score += 5
          score = Math.min(score, 100)

          existingUrls.add(normalizedUrl)

          // Try to match outlet + infer territory
          let outletId: string | null = null
          let territory: string | null = null
          try {
            const resultDomain = new URL(result.url).hostname.replace('www.', '')
            territory = inferTerritory(resultDomain)
            const { data: outlet } = await supabase
              .from('outlets')
              .select('id')
              .eq('domain', resultDomain)
              .single()
            if (outlet) outletId = outlet.id
          } catch { /* ignore */ }

          newItems.push({
            client_id: game.client_id,
            game_id: gameId,
            outlet_id: outletId,
            title: result.title.trim(),
            url: normalizedUrl,
            publish_date: result.publishedDate ? result.publishedDate.split('T')[0] : null,
            coverage_type: 'news',
            territory,
            relevance_score: score,
            relevance_reasoning: `Historical backfill: "${searchQuery}"`,
            approval_status: determineApprovalStatus(score),
            source_type: 'tavily',
            source_metadata: {
              search_query: searchQuery,
              backfill: true,
              tavily_score: result.score || null,
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
      approval_breakdown: {
        auto_approved: newItems.filter(i => i.approval_status === 'auto_approved').length,
        pending_review: newItems.filter(i => i.approval_status === 'pending_review').length,
        rejected: newItems.filter(i => i.approval_status === 'rejected').length
      },
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
