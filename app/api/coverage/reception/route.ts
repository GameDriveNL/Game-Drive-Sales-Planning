import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const supabase = getServerSupabase()
  const { searchParams } = new URL(request.url)
  const clientId = searchParams.get('client_id')
  const gameId = searchParams.get('game_id')
  const from = searchParams.get('from')
  const to = searchParams.get('to')

  if (!clientId) {
    return NextResponse.json({ error: 'client_id is required' }, { status: 400 })
  }

  let query = supabase
    .from('coverage_items')
    .select(`
      id, title, url, publish_date, coverage_type, sentiment,
      monthly_unique_visitors, review_score, quotes, source_type,
      outlet:outlets(id, name, tier),
      game:games(id, name)
    `)
    .eq('client_id', clientId)
    .eq('approval_status', 'approved')

  if (gameId) query = query.eq('game_id', gameId)
  if (from) query = query.gte('publish_date', from)
  if (to) query = query.lte('publish_date', to)

  query = query.order('publish_date', { ascending: true })

  const { data: items, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = (items || []) as unknown as Array<{
    id: string; title: string | null; url: string; publish_date: string | null;
    coverage_type: string | null; sentiment: string | null;
    monthly_unique_visitors: number | null; review_score: number | null;
    quotes: string | null; source_type: string;
    outlet: { id: string; name: string; tier: string | null } | null;
    game: { id: string; name: string } | null;
  }>

  // Aggregate monthly data
  const monthMap: Record<string, { positive: number; neutral: number; negative: number; mixed: number; unknown: number; reach: number; review_sum: number; review_count: number }> = {}

  let totalReach = 0
  let reviewSum = 0; let reviewCount = 0
  const sentimentTotals = { positive: 0, neutral: 0, negative: 0, mixed: 0, unknown: 0 }
  const coverageTypes: Record<string, number> = {}

  for (const item of rows) {
    const month = item.publish_date ? item.publish_date.slice(0, 7) : 'unknown'
    if (!monthMap[month]) monthMap[month] = { positive: 0, neutral: 0, negative: 0, mixed: 0, unknown: 0, reach: 0, review_sum: 0, review_count: 0 }

    const s = (item.sentiment || 'unknown') as keyof typeof sentimentTotals
    if (s in sentimentTotals) {
      monthMap[month][s]++
      sentimentTotals[s]++
    } else {
      monthMap[month].unknown++
      sentimentTotals.unknown++
    }

    const reach = item.monthly_unique_visitors || 0
    monthMap[month].reach += reach
    totalReach += reach

    if (item.review_score !== null) {
      monthMap[month].review_sum += Number(item.review_score)
      monthMap[month].review_count++
      reviewSum += Number(item.review_score)
      reviewCount++
    }

    const ct = item.coverage_type || 'other'
    coverageTypes[ct] = (coverageTypes[ct] || 0) + 1
  }

  const monthlyData = Object.entries(monthMap)
    .filter(([m]) => m !== 'unknown')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, d]) => ({
      month,
      positive: d.positive,
      neutral: d.neutral,
      negative: d.negative,
      mixed: d.mixed,
      unknown: d.unknown,
      reach: d.reach,
      review_avg: d.review_count > 0 ? Math.round((d.review_sum / d.review_count) * 10) / 10 : null,
    }))

  // Top coverage by reach (with quotes only for items that have them)
  const topCoverage = [...rows]
    .sort((a, b) => (b.monthly_unique_visitors || 0) - (a.monthly_unique_visitors || 0))
    .slice(0, 12)
    .map(item => ({
      id: item.id,
      title: item.title,
      url: item.url,
      publish_date: item.publish_date,
      coverage_type: item.coverage_type,
      sentiment: item.sentiment,
      review_score: item.review_score,
      monthly_unique_visitors: item.monthly_unique_visitors,
      quotes: item.quotes,
      outlet_name: item.outlet?.name || null,
      outlet_tier: item.outlet?.tier || null,
      game_name: item.game?.name || null,
      source_type: item.source_type,
    }))

  // Notable quotes (items with non-null quotes)
  const quotedItems = rows
    .filter(item => item.quotes && item.quotes.trim())
    .sort((a, b) => (b.monthly_unique_visitors || 0) - (a.monthly_unique_visitors || 0))
    .slice(0, 6)
    .map(item => ({
      quotes: item.quotes,
      outlet_name: item.outlet?.name || null,
      title: item.title,
      url: item.url,
      sentiment: item.sentiment,
      publish_date: item.publish_date,
    }))

  // Sentiment score: weighted score from -100 to +100
  const total = rows.length
  const sentimentScore = total > 0
    ? Math.round(((sentimentTotals.positive * 1 + sentimentTotals.mixed * 0.25 - sentimentTotals.negative * 1) / total) * 100)
    : 0

  return NextResponse.json({
    total_pieces: total,
    total_reach: totalReach,
    avg_review_score: reviewCount > 0 ? Math.round((reviewSum / reviewCount) * 10) / 10 : null,
    sentiment_score: sentimentScore,
    sentiment_breakdown: sentimentTotals,
    coverage_types: coverageTypes,
    monthly_data: monthlyData,
    top_coverage: topCoverage,
    quoted_items: quotedItems,
  })
}
