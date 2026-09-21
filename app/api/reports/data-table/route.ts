import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'

function getSupabase() {
  return getServerSupabase()
}

// GET /api/reports/data-table — Paginated, filterable sales data for analytical tables
export async function GET(request: NextRequest) {
  const supabase = getSupabase()
  const { searchParams } = new URL(request.url)

  const clientId = searchParams.get('client_id')
  const gameId = searchParams.get('game_id')
  const dateFrom = searchParams.get('date_from')
  const dateTo = searchParams.get('date_to')
  const drillLevel = searchParams.get('drill') || 'product' // 'game' | 'product' | 'platform' | 'country' | 'daily'
  const filterProduct = searchParams.get('product')
  const filterPlatform = searchParams.get('platform')
  const filterCountry = searchParams.get('country')
  const sortBy = searchParams.get('sort_by') || 'net_revenue'
  const sortDir = searchParams.get('sort_dir') || 'desc'
  const search = searchParams.get('search') || ''
  const page = Math.max(1, Number(searchParams.get('page') || 1))
  const pageSize = Math.min(500, Math.max(10, Number(searchParams.get('page_size') || 50)))

  if (!clientId) {
    return NextResponse.json({ error: 'client_id is required' }, { status: 400 })
  }

  try {
    // Resolve game_id → game name so we can filter by product_name in the view
    let gameNameFilter: string | null = null
    if (gameId) {
      const { data: gameRow } = await supabase.from('games').select('name').eq('id', gameId).single()
      if (gameRow?.name) gameNameFilter = gameRow.name
    }

    // Used to paginate unified_performance_view via sequential OFFSET and
    // aggregate every raw row in JS — the same anti-pattern fixed in
    // get_sales_report_summary (see add_sales_report_summary_rpc.sql):
    // OFFSET cost grows with offset, so a client with hundreds of thousands
    // of rows (e.g. 138k+ for tobspr Games) never finished for "All Time".
    // get_sales_data_table (add_sales_data_table_rpc.sql) does the same
    // GROUP BY in one pass in Postgres instead.
    const { data: tableData, error: tableError } = await supabase.rpc('get_sales_data_table', {
      p_client_id: clientId,
      p_date_from: dateFrom || null,
      p_date_to: dateTo || null,
      // gameNameFilter and filterProduct both narrow to a single product_name
      // in the original query (`.eq('product_name', ...)` applied twice when
      // both were set, which is just a redundant equal-value filter) — the
      // RPC only takes one product_name param, so prefer whichever is set.
      p_product_name: gameNameFilter || filterProduct || null,
      p_platform: filterPlatform || null,
      p_country_code: filterCountry || null,
      p_drill: drillLevel,
    })
    if (tableError) throw tableError

    const summary = (tableData || {}) as {
      rows?: Record<string, unknown>[]
      products?: string[]
      platforms?: string[]
      countries?: string[]
      raw_row_count?: number
    }

    const productSet = new Set(summary.products || [])
    const platformSet = new Set(summary.platforms || [])
    const countrySet = new Set(summary.countries || [])

    interface AggRow {
      [key: string]: unknown
      gross_revenue: number
      net_revenue: number
      gross_units: number
      net_units: number
      chargebacks: number
      vat: number
      row_count: number
      // D12: weighted sum of base_price_usd * net_units, used to derive a
      // discount-adjusted "margin" figure (net_revenue as a % of what full
      // price would have earned). See feedback card 3f279c46.
      full_price_revenue: number
    }

    let rows: AggRow[] = (summary.rows || []).map(r => ({
      ...r,
      gross_revenue: Number(r.gross_revenue || 0),
      net_revenue: Number(r.net_revenue || 0),
      gross_units: Number(r.gross_units || 0),
      net_units: Number(r.net_units || 0),
      chargebacks: Number(r.chargebacks || 0),
      vat: Number(r.vat || 0),
      full_price_revenue: Number(r.full_price_revenue || 0),
      row_count: Number(r.row_count || 0),
    }))

    // Compute avg price for each row
    for (const row of rows) {
      row.avg_price = row.net_units > 0 ? row.net_revenue / row.net_units : 0
      row.refund_rate = row.gross_units > 0 ? (row.chargebacks / row.gross_units * 100) : 0
      // % of full-price value actually captured — 100% means no discounting,
      // lower means discounts ate into revenue. null when we have no base
      // price to compare against (avoids a misleading 0%).
      row.margin_pct = row.full_price_revenue > 0 ? (row.net_revenue / row.full_price_revenue * 100) : null
    }

    // Apply search filter
    if (search) {
      const s = search.toLowerCase()
      rows = rows.filter(r => {
        const vals = Object.values(r).map(v => String(v || '').toLowerCase())
        return vals.some(v => v.includes(s))
      })
    }

    // Sort
    const dir = sortDir === 'asc' ? 1 : -1
    rows.sort((a, b) => {
      const aVal = a[sortBy]
      const bVal = b[sortBy]
      if (typeof aVal === 'number' && typeof bVal === 'number') return (aVal - bVal) * dir
      return String(aVal || '').localeCompare(String(bVal || '')) * dir
    })

    // Paginate
    const totalRows = rows.length
    const totalPages = Math.ceil(totalRows / pageSize)
    const startIdx = (page - 1) * pageSize
    const pagedRows = rows.slice(startIdx, startIdx + pageSize)

    // Totals row
    const totals: Record<string, number> = {
      gross_revenue: 0, net_revenue: 0, gross_units: 0, net_units: 0,
      chargebacks: 0, vat: 0,
    }
    for (const r of rows) {
      totals.gross_revenue += r.gross_revenue
      totals.net_revenue += r.net_revenue
      totals.gross_units += r.gross_units
      totals.net_units += r.net_units
      totals.chargebacks += r.chargebacks
      totals.vat += r.vat
    }
    totals.avg_price = totals.net_units > 0 ? totals.net_revenue / totals.net_units : 0

    return NextResponse.json({
      rows: pagedRows,
      totals,
      pagination: { page, page_size: pageSize, total_rows: totalRows, total_pages: totalPages },
      filters: {
        products: Array.from(productSet).sort(),
        platforms: Array.from(platformSet).sort(),
        countries: Array.from(countrySet).sort(),
      },
      raw_row_count: Number(summary.raw_row_count || 0),
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
