/**
 * POST /api/competitor-scan
 *
 * Runs Tavily web search for a competitor game name, stores results in
 * competitor_coverage. Deduplicates by URL. Uses simple keyword-based
 * sentiment inference from title/snippet.
 *
 * Body: { competitor_game_id: string, days_back?: number, max_results?: number }
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { tavily } from '@tavily/core'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

const POSITIVE_WORDS = ['great', 'amazing', 'excellent', 'outstanding', 'masterpiece', 'recommended', 'loved', 'perfect', 'must-play', 'award', 'winner', 'best', 'incredible', 'fantastic', 'superb', 'brilliant', 'polished']
const NEGATIVE_WORDS = ['terrible', 'awful', 'worst', 'disappointing', 'broken', 'bugs', 'buggy', 'fails', 'poor', 'bad', 'mediocre', 'frustrating', 'boring', 'weak', 'shallow', 'repetitive', 'avoid']

function inferSentiment(text: string): 'positive' | 'negative' | 'neutral' | 'mixed' {
  const lower = text.toLowerCase()
  const posHits = POSITIVE_WORDS.filter(w => lower.includes(w)).length
  const negHits = NEGATIVE_WORDS.filter(w => lower.includes(w)).length
  if (posHits > 0 && negHits > 0) return 'mixed'
  if (posHits >= 2) return 'positive'
  if (negHits >= 2) return 'negative'
  if (posHits === 1) return 'positive'
  if (negHits === 1) return 'negative'
  return 'neutral'
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '')
  } catch {
    return url
  }
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    u.searchParams.delete('utm_source')
    u.searchParams.delete('utm_medium')
    u.searchParams.delete('utm_campaign')
    let n = u.origin + u.pathname
    if (n.endsWith('/') && n.length > 1) n = n.slice(0, -1)
    return n
  } catch {
    return url.trim()
  }
}

export async function POST(request: NextRequest) {
  const supabase = getServerSupabase()
  const body = await request.json()
  const { competitor_game_id, days_back = 90, max_results = 20 } = body

  if (!competitor_game_id) {
    return NextResponse.json({ error: 'competitor_game_id is required' }, { status: 400 })
  }

  // Fetch competitor info
  const { data: competitor } = await supabase
    .from('competitor_games')
    .select('id, name, studio')
    .eq('id', competitor_game_id)
    .single()

  if (!competitor) return NextResponse.json({ error: 'Competitor not found' }, { status: 404 })

  // Fetch Tavily key
  const { data: keyData } = await supabase
    .from('service_api_keys')
    .select('api_key')
    .eq('service_name', 'tavily')
    .eq('is_active', true)
    .maybeSingle()

  if (!keyData?.api_key) {
    return NextResponse.json({ error: 'Tavily API key not configured' }, { status: 400 })
  }

  // Build search query: game name + optional studio
  const queryTerms = [competitor.name]
  if (competitor.studio) queryTerms.push(`"${competitor.studio}"`)
  const searchQuery = queryTerms.join(' ')

  // Existing URLs for dedup
  const { data: existing } = await supabase
    .from('competitor_coverage')
    .select('url')
    .eq('competitor_game_id', competitor_game_id)
  const existingUrls = new Set<string>((existing || []).map((r: { url: string }) => normalizeUrl(r.url)))

  // Run Tavily search
  const tvly = tavily({ apiKey: keyData.api_key })
  let tavilyResults: Array<{ url: string; title?: string; content?: string; score?: number; published_date?: string }> = []
  let costEstimate = 0

  try {
    const result = await tvly.search(searchQuery, {
      searchDepth: 'basic',
      maxResults: Math.min(max_results, 20),
      days: days_back,
      includeAnswer: false,
    })
    tavilyResults = result.results || []
    costEstimate = tavilyResults.length * 0.01
  } catch (err) {
    return NextResponse.json({ error: `Tavily search failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 })
  }

  let inserted = 0
  let skipped = 0

  for (const r of tavilyResults) {
    const norm = normalizeUrl(r.url)
    if (existingUrls.has(norm)) { skipped++; continue }
    existingUrls.add(norm)

    const text = `${r.title || ''} ${r.content || ''}`
    const sentiment = inferSentiment(text)
    const domain = extractDomain(r.url)

    // Parse publish date from Tavily's published_date field
    let publishDate: string | null = null
    if (r.published_date) {
      try {
        publishDate = new Date(r.published_date).toISOString().split('T')[0]
      } catch { /* ignore */ }
    }

    const { error } = await supabase.from('competitor_coverage').insert({
      competitor_game_id,
      title: (r.title || '').substring(0, 500) || null,
      url: r.url,
      source_domain: domain,
      snippet: (r.content || '').substring(0, 500) || null,
      publish_date: publishDate,
      sentiment,
      estimated_reach: null, // could enrich with Hypestat later
      relevance_score: r.score ? Math.round(r.score * 100) / 100 : null,
      raw_data: { score: r.score, content: r.content },
    })

    if (!error) inserted++
    else skipped++
  }

  return NextResponse.json({
    message: `Scanned "${competitor.name}": ${inserted} new items of ${tavilyResults.length} found`,
    competitor: competitor.name,
    results_found: tavilyResults.length,
    inserted,
    skipped,
    cost_estimate_usd: costEstimate,
  })
}
