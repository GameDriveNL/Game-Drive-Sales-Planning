import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getOutletDisplayName, extractDomain } from '@/lib/outlet-utils'

function getSupabase() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseKey) throw new Error('Missing Supabase environment variables')
  return createClient(supabaseUrl, supabaseKey)
}

// GET - Fetch all coverage data for export (no pagination limit)
export async function GET(request: NextRequest) {
  try {
    const supabase = getSupabase()
    const { searchParams } = new URL(request.url)

    const clientId = searchParams.get('client_id')
    const gameId = searchParams.get('game_id')
    const dateFrom = searchParams.get('date_from')
    const dateTo = searchParams.get('date_to')
    const approvalStatus = searchParams.get('approval_status')
    const campaignId = searchParams.get('campaign_id')

    let query = supabase
      .from('coverage_items')
      .select('*, outlet:outlets(id, name, domain, tier, monthly_unique_visitors, country), game:games(id, name), client:clients(id, name), campaign:coverage_campaigns(id, name)')
      .order('publish_date', { ascending: false })
      .limit(5000)

    // Only show approved items by default for client reports
    if (approvalStatus) {
      if (approvalStatus === 'approved') {
        query = query.in('approval_status', ['auto_approved', 'manually_approved'])
      } else {
        query = query.eq('approval_status', approvalStatus)
      }
    } else {
      query = query.in('approval_status', ['auto_approved', 'manually_approved'])
    }

    if (clientId) query = query.eq('client_id', clientId)
    if (gameId) query = query.eq('game_id', gameId)
    if (dateFrom) query = query.gte('publish_date', dateFrom)
    if (dateTo) query = query.lte('publish_date', dateTo)
    if (campaignId) query = query.eq('campaign_id', campaignId)

    const { data, error } = await query

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Also fetch campaigns for this client/game
    let campaignQuery = supabase
      .from('coverage_campaigns')
      .select('id, name, start_date, end_date')
      .order('start_date', { ascending: false })

    if (clientId) campaignQuery = campaignQuery.eq('client_id', clientId)
    if (gameId) campaignQuery = campaignQuery.eq('game_id', gameId)

    const { data: campaigns } = await campaignQuery

    // Enrich items with computed display fields
    const rawItems = data || []
    const items: Record<string, unknown>[] = rawItems.map((item: Record<string, unknown>) => {
      const outlet = item.outlet as { id?: string; name?: string; domain?: string | null; tier?: string; monthly_unique_visitors?: number | null; country?: string | null } | null
      const url = item.url as string | null

      // Compute display outlet name: outlet.name → domain lookup → URL extraction
      const outlet_display_name = getOutletDisplayName(outlet, url)

      // Compute display date: publish_date → discovered_at → created_at
      let display_date = item.publish_date as string | null
      if (!display_date) {
        const discovered = item.discovered_at as string | null
        const created = item.created_at as string | null
        const fallback = discovered || created
        if (fallback) {
          display_date = fallback.split('T')[0]
        }
      }

      // Compute display visitors: outlet.monthly_unique_visitors → item.monthly_unique_visitors
      const display_visitors = outlet?.monthly_unique_visitors || (item.monthly_unique_visitors as number | null) || null

      // Compute display domain
      const display_domain = outlet?.domain || (url ? extractDomain(url) : null)

      return {
        ...item,
        outlet_display_name,
        display_date,
        display_visitors,
        display_domain,
      }
    })

    // Compute summary stats
    const totalPieces = items.length
    const totalReach = items.reduce((sum: number, item: Record<string, unknown>) => {
      const outlet = item.outlet as { monthly_unique_visitors?: number | null } | null
      return sum + (outlet?.monthly_unique_visitors || (item.monthly_unique_visitors as number) || 0)
    }, 0)
    const reviewItems = items.filter((item: Record<string, unknown>) => item.coverage_type === 'review' && item.review_score)
    const avgReviewScore = reviewItems.length > 0
      ? reviewItems.reduce((sum: number, item: Record<string, unknown>) => sum + Number(item.review_score), 0) / reviewItems.length
      : null

    // Tier breakdown (count) + Reach by tier (MUV sum)
    const tierBreakdown: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, untiered: 0 }
    const reachByTier: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, untiered: 0 }
    for (const item of items) {
      const outlet = item.outlet as { tier?: string; monthly_unique_visitors?: number | null } | null
      const tier = outlet?.tier
      const muv = outlet?.monthly_unique_visitors || (item.monthly_unique_visitors as number) || 0
      if (tier && tier in tierBreakdown) {
        tierBreakdown[tier]++
        reachByTier[tier] += muv
      } else {
        tierBreakdown.untiered++
        reachByTier.untiered += muv
      }
    }

    // Type breakdown
    const typeBreakdown: Record<string, number> = {}
    for (const item of items) {
      const type = (item.coverage_type as string) || 'unknown'
      typeBreakdown[type] = (typeBreakdown[type] || 0) + 1
    }

    // Territory breakdown
    const territoryBreakdown: Record<string, number> = {}
    for (const item of items) {
      const territory = (item.territory as string) || 'Unknown'
      territoryBreakdown[territory] = (territoryBreakdown[territory] || 0) + 1
    }

    // Review score distribution
    const reviewScores = items
      .filter((i: Record<string, unknown>) => i.review_score != null)
      .map((i: Record<string, unknown>) => Number(i.review_score))
    const reviewDistribution = {
      count: reviewScores.length,
      avg: reviewScores.length > 0 ? reviewScores.reduce((a, b) => a + b, 0) / reviewScores.length : null,
      min: reviewScores.length > 0 ? Math.min(...reviewScores) : null,
      max: reviewScores.length > 0 ? Math.max(...reviewScores) : null,
      ranges: {
        '90-100': reviewScores.filter(s => s >= 90).length,
        '80-89': reviewScores.filter(s => s >= 80 && s < 90).length,
        '70-79': reviewScores.filter(s => s >= 70 && s < 80).length,
        '60-69': reviewScores.filter(s => s >= 60 && s < 70).length,
        'below_60': reviewScores.filter(s => s < 60).length
      }
    }

    // AVE (Advertising Value Equivalent) — industry-standard PR metric
    const AVE_CPM: Record<string, number> = { A: 50, B: 30, C: 15, D: 5, untiered: 3 }
    const PR_MULTIPLIER = 3
    let totalAVE = 0
    const aveByTier: Record<string, number> = {}
    for (const [tier, reach] of Object.entries(reachByTier)) {
      const cpm = AVE_CPM[tier] || 3
      const ave = (reach * cpm / 1000) * PR_MULTIPLIER
      aveByTier[tier] = Math.round(ave)
      totalAVE += ave
    }

    // YouTube / video metrics from source_metadata
    let ytVideos = 0, ytViews = 0, ytLikes = 0, ytComments = 0
    for (const item of items) {
      const meta = item.source_metadata as Record<string, unknown> | null
      if (meta?.platform === 'youtube' || (item.coverage_type as string) === 'video') {
        ytVideos++
        if (meta?.views) ytViews += Number(meta.views) || 0
        if (meta?.likes) ytLikes += Number(meta.likes) || 0
        if (meta?.comments) ytComments += Number(meta.comments) || 0
      }
    }

    // Sentiment summary
    const sentimentCounts: Record<string, number> = { positive: 0, neutral: 0, negative: 0, mixed: 0, unknown: 0 }
    const topQuotes: Array<{ quote: string; outlet: string; sentiment: string }> = []
    for (const item of items) {
      const sentiment = ((item.sentiment as string) || 'unknown').toLowerCase()
      if (sentiment in sentimentCounts) {
        sentimentCounts[sentiment]++
      } else {
        sentimentCounts.unknown++
      }
      if (item.quotes && (item.quotes as string).trim()) {
        const outletName = (item.outlet as { name?: string } | null)?.name || 'Unknown'
        topQuotes.push({ quote: (item.quotes as string).trim().substring(0, 200), outlet: outletName, sentiment })
      }
    }
    topQuotes.sort((a, b) => {
      const order: Record<string, number> = { positive: 0, mixed: 1, neutral: 2, negative: 3, unknown: 4 }
      return (order[a.sentiment] ?? 4) - (order[b.sentiment] ?? 4)
    })

    // Data quality flags
    const missingOutlet = items.filter(i => !(i.outlet as Record<string, unknown> | null)).length
    const missingTerritory = items.filter(i => !i.territory).length
    const missingSentiment = items.filter(i => !i.sentiment || (i.sentiment as string).toLowerCase() === 'unknown').length
    const missingDate = items.filter(i => !i.publish_date).length
    const untieredOutlets = items.filter(i => {
      const outlet = i.outlet as { tier?: string; id?: string } | null
      return outlet?.id && !outlet?.tier
    }).length
    const noTrafficOutlets = items.filter(i => {
      const outlet = i.outlet as { monthly_unique_visitors?: number | null; id?: string } | null
      return outlet?.id && !outlet?.monthly_unique_visitors
    }).length
    const filledFields = (totalPieces * 4) - missingOutlet - missingTerritory - missingSentiment - missingDate

    return NextResponse.json({
      items,
      campaigns: campaigns || [],
      summary: {
        total_pieces: totalPieces,
        total_audience_reach: totalReach,
        estimated_views: Math.round(totalReach * 0.02),
        avg_review_score: avgReviewScore,
        review_count: reviewItems.length,
        tier_breakdown: tierBreakdown,
        type_breakdown: typeBreakdown,
        territory_breakdown: territoryBreakdown,
        reach_by_tier: reachByTier,
        review_distribution: reviewDistribution,
        ave_estimate: { total: Math.round(totalAVE), by_tier: aveByTier },
        youtube_metrics: { total_videos: ytVideos, total_views: ytViews, total_likes: ytLikes, total_comments: ytComments },
        sentiment_summary: { counts: sentimentCounts, top_quotes: topQuotes.slice(0, 5) },
        data_quality: {
          missing_outlet: missingOutlet,
          missing_territory: missingTerritory,
          missing_sentiment: missingSentiment,
          missing_publish_date: missingDate,
          untiered_outlets: untieredOutlets,
          outlets_without_traffic: noTrafficOutlets,
          total_items: totalPieces,
          completeness_pct: totalPieces > 0 ? Math.round((filledFields / (totalPieces * 4)) * 100) : 0
        }
      }
    })
  } catch (err) {
    return NextResponse.json({ error: 'Export data fetch failed', details: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
