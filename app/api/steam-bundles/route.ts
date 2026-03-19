import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'

function getSupabase() {
  return getServerSupabase()
}

// GET /api/steam-bundles?game_id=xxx&client_id=xxx
export async function GET(request: NextRequest) {
  const supabase = getSupabase()
  const { searchParams } = new URL(request.url)
  const gameId = searchParams.get('game_id')
  const clientId = searchParams.get('client_id')
  const dateFrom = searchParams.get('date_from')
  const dateTo = searchParams.get('date_to')

  try {
    let query = supabase
      .from('steam_bundles')
      .select('*, game:games(id, name)')
      .order('date', { ascending: false })

    if (gameId) query = query.eq('game_id', gameId)
    if (clientId) query = query.eq('client_id', clientId)
    if (dateFrom) query = query.gte('date', dateFrom)
    if (dateTo) query = query.lte('date', dateTo)

    const { data, error } = await query.limit(1000)
    if (error) throw error

    const rows = data || []

    // Summary
    const bundleNames = Array.from(new Set(rows.map(r => r.bundle_name)))
    const summary = {
      total_bundles: bundleNames.length,
      total_rows: rows.length,
      total_gross_units: rows.reduce((s, r) => s + (r.gross_units || 0), 0),
      total_net_units: rows.reduce((s, r) => s + (r.net_units || 0), 0),
      total_gross_revenue: rows.reduce((s, r) => s + Number(r.gross_revenue_usd || 0), 0),
      total_net_revenue: rows.reduce((s, r) => s + Number(r.net_revenue_usd || 0), 0),
      bundle_names: bundleNames,
      api_limitation: 'Steam bundle data is only visible to the bundle creator. If this game participates in bundles created by others, data must be imported via CSV.',
    }

    return NextResponse.json({ data: rows, summary })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// POST /api/steam-bundles — Single or bulk upsert (manual or CSV import)
export async function POST(request: NextRequest) {
  const supabase = getSupabase()

  try {
    const contentType = request.headers.get('content-type') || ''

    // Handle CSV upload
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData()
      const file = formData.get('file') as File
      const gameId = formData.get('game_id') as string
      const clientId = formData.get('client_id') as string

      if (!file || !gameId || !clientId) {
        return NextResponse.json({ error: 'file, game_id, and client_id are required' }, { status: 400 })
      }

      const text = await file.text()
      const lines = text.trim().split('\n')
      if (lines.length < 2) {
        return NextResponse.json({ error: 'CSV has no data rows' }, { status: 400 })
      }

      // Parse CSV — expect: Date, Bundle Name, Bundle ID, Gross Units, Net Units, Gross Revenue, Net Revenue
      const header = lines[0].toLowerCase()
      const hasHeader = header.includes('date') || header.includes('bundle')

      const rows: Record<string, unknown>[] = []
      for (let i = hasHeader ? 1 : 0; i < lines.length; i++) {
        const cols = lines[i].split(',').map(c => c.trim().replace(/"/g, ''))
        if (cols.length < 3) continue

        const dateStr = cols[0]
        const date = new Date(dateStr)
        if (isNaN(date.getTime())) continue

        rows.push({
          game_id: gameId,
          client_id: clientId,
          date: date.toISOString().split('T')[0],
          bundle_name: cols[1] || 'Unknown Bundle',
          bundle_id: cols[2] || null,
          gross_units: parseInt(cols[3]) || 0,
          net_units: parseInt(cols[4]) || 0,
          gross_revenue_usd: parseFloat(cols[5]) || 0,
          net_revenue_usd: parseFloat(cols[6]) || 0,
          source: 'csv_import',
        })
      }

      if (rows.length === 0) {
        return NextResponse.json({ error: 'No valid rows found in CSV' }, { status: 400 })
      }

      const { error } = await supabase
        .from('steam_bundles')
        .upsert(rows, { onConflict: 'game_id,bundle_name,date' })

      if (error) throw error

      return NextResponse.json({ imported: rows.length })
    }

    // JSON body
    const body = await request.json()
    const items = Array.isArray(body) ? body : [body]

    for (const item of items) {
      if (!item.game_id || !item.client_id || !item.date || !item.bundle_name) {
        return NextResponse.json({ error: 'game_id, client_id, date, and bundle_name are required' }, { status: 400 })
      }
    }

    const { data, error } = await supabase
      .from('steam_bundles')
      .upsert(items.map(item => ({
        ...item,
        source: item.source || 'manual',
      })), { onConflict: 'game_id,bundle_name,date' })
      .select()

    if (error) throw error

    return NextResponse.json(data)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// DELETE /api/steam-bundles?id=xxx
export async function DELETE(request: NextRequest) {
  const supabase = getSupabase()
  const { searchParams } = new URL(request.url)
  const id = searchParams.get('id')

  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }

  const { error } = await supabase.from('steam_bundles').delete().eq('id', id)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
