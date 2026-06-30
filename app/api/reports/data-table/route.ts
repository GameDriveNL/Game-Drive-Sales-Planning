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

    // Fetch all matching rows
    const columns = 'date,product_name,product_type,platform,country_code,country,region,gross_units_sold,chargebacks_returns,net_units_sold,base_price_usd,sale_price_usd,gross_steam_sales_usd,net_steam_sales_usd,vat_tax_usd'

    let allRows: Record<string, unknown>[] = []
    let offset = 0
    const batchSize = 1000

    while (true) {
      let query = supabase
        .from('unified_performance_view')
        .select(columns)
        .eq('client_id', clientId)
        .range(offset, offset + batchSize - 1)

      if (dateFrom) query = query.gte('date', dateFrom)
      if (dateTo) query = query.lte('date', dateTo)
      if (gameNameFilter) query = query.eq('product_name', gameNameFilter)
      if (filterProduct) query = query.eq('product_name', filterProduct)
      if (filterPlatform) query = query.eq('platform', filterPlatform)
      if (filterCountry) query = query.eq('country_code', filterCountry)

      const { data, error } = await query
      if (error) throw error
      if (!data || data.length === 0) break

      allRows = allRows.concat(data)
      if (data.length < batchSize) break
      offset += batchSize
    }

    // Collect filter options
    const productSet = new Set<string>()
    const platformSet = new Set<string>()
    const countrySet = new Set<string>()

    for (const r of allRows) {
      const row = r as Record<string, unknown>
      if (row.product_name) productSet.add(String(row.product_name))
      if (row.platform) platformSet.add(String(row.platform))
      if (row.country_code) countrySet.add(String(row.country_code))
    }

    // Aggregate based on drill level
    interface AggRow {
      [key: string]: unknown
      gross_revenue: number
      net_revenue: number
      gross_units: number
      net_units: number
      chargebacks: number
      vat: number
      row_count: number
    }

    const aggregated: Record<string, AggRow> = {}

    for (const r of allRows) {
      const row = r as Record<string, unknown>
      let key = ''

      switch (drillLevel) {
        case 'game':
          key = String(row.product_name || 'Unknown')
          break
        case 'product':
          key = `${row.product_name || 'Unknown'}|${row.platform || 'Unknown'}`
          break
        case 'platform':
          key = String(row.platform || 'Unknown')
          break
        case 'country':
          key = `${row.country_code || 'Unknown'}|${row.country || 'Unknown'}`
          break
        case 'daily':
          key = String(row.date || 'Unknown')
          break
        default:
          key = `${row.product_name || 'Unknown'}|${row.platform || 'Unknown'}`
      }

      if (!aggregated[key]) {
        const parts = key.split('|')
        const base: AggRow = {
          gross_revenue: 0, net_revenue: 0, gross_units: 0, net_units: 0,
          chargebacks: 0, vat: 0, row_count: 0,
        }

        switch (drillLevel) {
          case 'game':
            base.product_name = parts[0]
            base.product_type = row.product_type || null
            break
          case 'product':
            base.product_name = parts[0]
            base.platform = parts[1]
            base.product_type = row.product_type || null
            break
          case 'platform':
            base.platform = parts[0]
            break
          case 'country':
            base.country_code = parts[0]
            base.country = parts[1]
            break
          case 'daily':
            base.date = parts[0]
            break
        }

        aggregated[key] = base
      }

      const agg = aggregated[key]
      agg.gross_revenue += Number(row.gross_steam_sales_usd || 0)
      agg.net_revenue += Number(row.net_steam_sales_usd || 0)
      agg.gross_units += Number(row.gross_units_sold || 0)
      agg.net_units += Number(row.net_units_sold || 0)
      agg.chargebacks += Number(row.chargebacks_returns || 0)
      agg.vat += Number(row.vat_tax_usd || 0)
      agg.row_count++
    }

    let rows = Object.values(aggregated)

    // Compute avg price for each row
    for (const row of rows) {
      row.avg_price = row.net_units > 0 ? row.net_revenue / row.net_units : 0
      row.refund_rate = row.gross_units > 0 ? (row.chargebacks / row.gross_units * 100) : 0
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
      raw_row_count: allRows.length,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
