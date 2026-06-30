import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const supabase = getServerSupabase()
  const { searchParams } = new URL(request.url)
  const gameId = searchParams.get('game_id')
  const clientId = searchParams.get('client_id')

  if (!clientId) return NextResponse.json({ error: 'client_id is required' }, { status: 400 })

  // Wishlist history
  let wlQuery = supabase
    .from('steam_wishlists')
    .select('date, total_wishlists, additions, deletions, purchases_and_activations, gifts')
    .eq('client_id', clientId)
    .order('date', { ascending: true })

  if (gameId) wlQuery = wlQuery.eq('game_id', gameId)

  const { data: wishlistData, error: wlError } = await wlQuery
  if (wlError) return NextResponse.json({ error: wlError.message }, { status: 500 })

  // Actual sales (for overlay)
  let salesQuery = supabase
    .from('steam_sales')
    .select('sale_date, units_sold, net_revenue, app_name')
    .eq('client_id', clientId)
    .order('sale_date', { ascending: true })

  if (gameId) salesQuery = salesQuery.eq('game_id', gameId)

  const { data: salesData } = await salesQuery

  // Daily actual sales aggregated
  const salesByDate: Record<string, { units: number; revenue: number }> = {}
  for (const s of (salesData || [])) {
    const d = s.sale_date
    if (!salesByDate[d]) salesByDate[d] = { units: 0, revenue: 0 }
    salesByDate[d].units += Number(s.units_sold) || 0
    salesByDate[d].revenue += Number(s.net_revenue) || 0
  }

  const latestWishlist = wishlistData?.at(-1) || null
  const earliestWishlist = wishlistData?.[0] || null

  // Compute 30-day avg additions/deletions for growth rate
  const recent30 = (wishlistData || []).slice(-30)
  const avgAdditions = recent30.length > 0
    ? recent30.reduce((s, r) => s + (r.additions || 0), 0) / recent30.length
    : 0
  const avgConversions = recent30.length > 0
    ? recent30.reduce((s, r) => s + (r.purchases_and_activations || 0), 0) / recent30.length
    : 0

  return NextResponse.json({
    wishlist_history: (wishlistData || []).map(r => ({
      date: r.date,
      total: r.total_wishlists,
      additions: r.additions || 0,
      deletions: r.deletions || 0,
      conversions: r.purchases_and_activations || 0,
    })),
    current_wishlists: latestWishlist?.total_wishlists || 0,
    latest_date: latestWishlist?.date || null,
    earliest_date: earliestWishlist?.date || null,
    avg_daily_additions: Math.round(avgAdditions * 10) / 10,
    avg_daily_conversions: Math.round(avgConversions * 10) / 10,
    actual_sales: Object.entries(salesByDate).map(([date, v]) => ({ date, units: v.units, revenue: v.revenue })),
  })
}
