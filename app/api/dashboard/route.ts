import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'

function getSupabase() {
  return getServerSupabase()
}

// GET /api/dashboard — Dashboard metrics for a client
export async function GET(request: NextRequest) {
  const supabase = getSupabase()
  const { searchParams } = new URL(request.url)
  const clientId = searchParams.get('client_id')

  if (!clientId) {
    return NextResponse.json({ error: 'client_id is required' }, { status: 400 })
  }

  try {
    const now = new Date()
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000)
    const fmt = (d: Date) => d.toISOString().split('T')[0]

    // --- Sales metrics (last 30 days vs prior 30 days) ---
    // Used to run two separate while(true)+.range() loops against
    // unified_performance_view and sum in JS — same anti-pattern as the
    // Reports/Analytics pages (see add_sales_report_summary_rpc.sql etc.),
    // just bounded to a fixed 60-day window so it never hung, only ran
    // slower than a landing page should (1.5-6s live-tested). This computes
    // both windows in one query instead of up to ~10-20 round trips.
    const { data: dashSales, error: dashSalesError } = await supabase.rpc('get_dashboard_sales_summary', {
      p_client_id: clientId,
      p_current_from: fmt(thirtyDaysAgo),
      p_current_to: fmt(now),
      p_prior_from: fmt(sixtyDaysAgo),
      p_prior_to: fmt(thirtyDaysAgo),
    })
    if (dashSalesError) throw dashSalesError

    const salesSummary = (dashSales || {}) as {
      current_revenue?: number
      current_units?: number
      prior_revenue?: number
      prior_units?: number
      top_products?: { name: string; value: number }[]
      platform_breakdown?: { name: string; value: number }[]
      revenue_trend?: { date: string; value: number }[]
    }

    const current = {
      revenue: Number(salesSummary.current_revenue || 0),
      units: Number(salesSummary.current_units || 0),
    }
    const prior = {
      revenue: Number(salesSummary.prior_revenue || 0),
      units: Number(salesSummary.prior_units || 0),
    }
    const revenueTrend = salesSummary.revenue_trend || []
    const topProducts = salesSummary.top_products || []
    const platformBreakdown = salesSummary.platform_breakdown || []

    // --- Coverage metrics ---
    const { data: covItems } = await supabase
      .from('coverage_items')
      .select('id, title, url, publish_date, coverage_type, monthly_unique_visitors, review_score, outlet:outlets(name, tier)')
      .eq('client_id', clientId)
      .in('approval_status', ['auto_approved', 'manually_approved'])
      .gte('publish_date', fmt(thirtyDaysAgo))
      .order('publish_date', { ascending: false })
      .limit(200)

    const coverage = covItems || []
    let covReach = 0
    let covReviewSum = 0
    let covReviewCount = 0
    const covByTier: Record<string, number> = {}

    for (const item of coverage) {
      const i = item as Record<string, unknown>
      covReach += Number(i.monthly_unique_visitors || 0)
      if (i.review_score) { covReviewSum += Number(i.review_score); covReviewCount++ }
      const outlet = i.outlet as Record<string, unknown> | null
      const tier = String(outlet?.tier || 'D')
      covByTier[tier] = (covByTier[tier] || 0) + 1
    }

    // --- Games count ---
    const { data: gamesData } = await supabase
      .from('games')
      .select('id, name')
      .eq('client_id', clientId)

    // --- Client info ---
    const { data: clientData } = await supabase
      .from('clients')
      .select('id, name')
      .eq('id', clientId)
      .single()

    return NextResponse.json({
      client: clientData,
      games: gamesData || [],
      sales: {
        current_revenue: current.revenue,
        prior_revenue: prior.revenue,
        revenue_change: prior.revenue > 0 ? ((current.revenue - prior.revenue) / prior.revenue * 100) : 0,
        current_units: current.units,
        prior_units: prior.units,
        units_change: prior.units > 0 ? ((current.units - prior.units) / prior.units * 100) : 0,
        top_products: topProducts,
        platform_breakdown: platformBreakdown,
        revenue_trend: revenueTrend,
      },
      coverage: {
        total_pieces: coverage.length,
        audience_reach: covReach,
        avg_review_score: covReviewCount > 0 ? Math.round((covReviewSum / covReviewCount) * 10) / 10 : null,
        tier_breakdown: Object.entries(covByTier).sort((a, b) => a[0].localeCompare(b[0])).map(([name, value]) => ({ name, value })),
        recent_items: coverage.slice(0, 5),
      },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
