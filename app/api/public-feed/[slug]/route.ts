import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'

function getSupabase() {
  return getServerSupabase()
}

// GET /api/public-feed/[slug] — Public coverage feed data for a game
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const supabase = getSupabase()
  const { slug } = await params
  const { searchParams } = new URL(request.url)

  const password = searchParams.get('password')
  const coverageType = searchParams.get('type')
  const dateFrom = searchParams.get('date_from')
  const dateTo = searchParams.get('date_to')

  try {
    // Look up game by slug
    const { data: game, error: gameError } = await supabase
      .from('games')
      .select('id, name, client_id, public_feed_enabled, public_feed_password, slug, steam_store_url, release_date')
      .eq('slug', slug)
      .single()

    if (gameError || !game) {
      return NextResponse.json({ error: 'Game not found' }, { status: 404 })
    }

    if (!game.public_feed_enabled) {
      return NextResponse.json({ error: 'Public feed not enabled for this game' }, { status: 403 })
    }

    // Check password if set
    if (game.public_feed_password && game.public_feed_password !== password) {
      return NextResponse.json({ error: 'Password required', needs_password: true }, { status: 401 })
    }

    // Get client info
    const { data: client } = await supabase
      .from('clients')
      .select('id, name')
      .eq('id', game.client_id)
      .single()

    // Get approved coverage items
    let query = supabase
      .from('coverage_items')
      .select(`
        id, title, url, publish_date, territory, coverage_type,
        monthly_unique_visitors, review_score, quotes, sentiment,
        campaign_section,
        outlet:outlets(id, name, domain, tier, monthly_unique_visitors, country),
        campaign:coverage_campaigns(id, name)
      `)
      // Also include items with null game_id whose title contains the game name —
      // these are auto-discovered items that got ingested via keyword scan before
      // the game_id linkage was corrected
      .or(`game_id.eq.${game.id},and(game_id.is.null,title.ilike.%${game.name.replace(/[%_]/g, '\\$&')}%)`)
      .in('approval_status', ['auto_approved', 'manually_approved'])
      .order('publish_date', { ascending: false })

    if (coverageType) query = query.eq('coverage_type', coverageType)
    if (dateFrom) query = query.gte('publish_date', dateFrom)
    if (dateTo) query = query.lte('publish_date', dateTo)

    const { data: items, error: itemsError } = await query.limit(500)

    if (itemsError) throw itemsError

    const coverageItems = items || []

    // Compute summary stats
    let totalReach = 0
    let totalScoreSum = 0
    let scoredCount = 0
    const tierBreakdown: Record<string, number> = {}
    const typeBreakdown: Record<string, number> = {}
    const territoryBreakdown: Record<string, number> = {}

    for (const item of coverageItems) {
      const i = item as Record<string, unknown>
      const outlet = i.outlet as Record<string, unknown> | null
      const visitors = Number(outlet?.monthly_unique_visitors || i.monthly_unique_visitors || 0)
      totalReach += visitors

      if (i.review_score) {
        totalScoreSum += Number(i.review_score)
        scoredCount++
      }

      const tier = String(outlet?.tier || 'untiered')
      tierBreakdown[tier] = (tierBreakdown[tier] || 0) + 1

      const covType = String(i.coverage_type || 'article')
      typeBreakdown[covType] = (typeBreakdown[covType] || 0) + 1

      const territory = String(i.territory || 'Unknown')
      territoryBreakdown[territory] = (territoryBreakdown[territory] || 0) + 1
    }

    // Get campaign sections for grouping
    const campaigns = new Set<string>()
    for (const item of coverageItems) {
      if ((item as Record<string, unknown>).campaign_section) {
        campaigns.add(String((item as Record<string, unknown>).campaign_section))
      }
    }

    // Date range
    const dates = coverageItems
      .map(i => (i as Record<string, unknown>).publish_date)
      .filter(Boolean)
      .sort()
    const dateRange = {
      from: dates.length > 0 ? String(dates[0]) : null,
      to: dates.length > 0 ? String(dates[dates.length - 1]) : null,
    }

    return NextResponse.json({
      game: { name: game.name, slug: game.slug, steam_store_url: game.steam_store_url, release_date: game.release_date },
      client: { name: client?.name || '' },
      summary: {
        total_pieces: coverageItems.length,
        total_audience_reach: totalReach,
        estimated_views: Math.round(totalReach * 0.02),
        avg_review_score: scoredCount > 0 ? Math.round((totalScoreSum / scoredCount) * 10) / 10 : null,
        tier_breakdown: Object.entries(tierBreakdown).sort((a, b) => b[1] - a[1]),
        type_breakdown: Object.entries(typeBreakdown).sort((a, b) => b[1] - a[1]),
        territory_breakdown: Object.entries(territoryBreakdown).sort((a, b) => b[1] - a[1]),
        date_range: dateRange,
      },
      campaign_sections: Array.from(campaigns),
      items: coverageItems,
      coverage_types: Object.keys(typeBreakdown).sort(),
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
