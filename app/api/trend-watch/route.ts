/**
 * POST /api/trend-watch
 * Searches Tavily for trending gaming topics. Returns articles grouped by topic cluster.
 * Body: { query, days_back?, max_results? }
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { tavily } from '@tavily/core'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 30

export async function POST(request: NextRequest) {
  const supabase = getServerSupabase()
  const body = await request.json()
  const { query, days_back = 7, max_results = 15 } = body

  if (!query) return NextResponse.json({ error: 'query is required' }, { status: 400 })

  const { data: keyData } = await supabase
    .from('service_api_keys')
    .select('api_key')
    .eq('service_name', 'tavily')
    .eq('is_active', true)
    .maybeSingle()

  if (!keyData?.api_key) return NextResponse.json({ error: 'Tavily key not configured' }, { status: 400 })

  const tvly = tavily({ apiKey: keyData.api_key })

  try {
    const result = await tvly.search(query, {
      searchDepth: 'basic',
      maxResults: Math.min(max_results, 20),
      days: days_back,
      includeAnswer: true,
    })

    return NextResponse.json({
      results: result.results || [],
      answer: result.answer || null,
      query,
      cost_estimate_usd: (result.results || []).length * 0.01,
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Tavily error' }, { status: 500 })
  }
}
