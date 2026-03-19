import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'

function getSupabase() {
  return getServerSupabase()
}

// GET /api/steam-wishlists?game_id=xxx&date_from=&date_to=
export async function GET(request: NextRequest) {
  const supabase = getSupabase()
  const { searchParams } = new URL(request.url)
  const gameId = searchParams.get('game_id')
  const clientId = searchParams.get('client_id')
  const dateFrom = searchParams.get('date_from')
  const dateTo = searchParams.get('date_to')

  try {
    let query = supabase
      .from('steam_wishlists')
      .select('*, game:games(id, name)')
      .order('date', { ascending: false })

    if (gameId) query = query.eq('game_id', gameId)
    if (clientId) query = query.eq('client_id', clientId)
    if (dateFrom) query = query.gte('date', dateFrom)
    if (dateTo) query = query.lte('date', dateTo)

    const { data, error } = await query.limit(1000)
    if (error) throw error

    // Compute summary
    const rows = data || []
    const latest = rows[0]
    const summary = {
      total_wishlists: latest?.total_wishlists || 0,
      total_rows: rows.length,
      date_range: rows.length > 0 ? { from: rows[rows.length - 1].date, to: rows[0].date } : null,
      total_additions: rows.reduce((sum, r) => sum + (r.additions || 0), 0),
      total_deletions: rows.reduce((sum, r) => sum + (r.deletions || 0), 0),
      total_purchases: rows.reduce((sum, r) => sum + (r.purchases_and_activations || 0), 0),
    }

    return NextResponse.json({ data: rows, summary })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// POST /api/steam-wishlists — Single or bulk upsert (manual or CSV import)
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

      // Parse CSV — expect: Date, Additions, Deletions, Purchases & Activations, Gifts, Total
      const header = lines[0].toLowerCase()
      const hasHeader = header.includes('date') || header.includes('wishlist')

      const rows: Record<string, unknown>[] = []
      for (let i = hasHeader ? 1 : 0; i < lines.length; i++) {
        const cols = lines[i].split(',').map(c => c.trim().replace(/"/g, ''))
        if (cols.length < 2) continue

        const dateStr = cols[0]
        // Try parsing date
        const date = new Date(dateStr)
        if (isNaN(date.getTime())) continue

        rows.push({
          game_id: gameId,
          client_id: clientId,
          date: date.toISOString().split('T')[0],
          additions: parseInt(cols[1]) || 0,
          deletions: parseInt(cols[2]) || 0,
          purchases_and_activations: parseInt(cols[3]) || 0,
          gifts: parseInt(cols[4]) || 0,
          total_wishlists: parseInt(cols[5]) || null,
          source: 'csv_import',
        })
      }

      if (rows.length === 0) {
        return NextResponse.json({ error: 'No valid rows found in CSV' }, { status: 400 })
      }

      const { error } = await supabase
        .from('steam_wishlists')
        .upsert(rows, { onConflict: 'game_id,date' })

      if (error) throw error

      return NextResponse.json({ imported: rows.length })
    }

    // JSON body — single or bulk
    const body = await request.json()
    const items = Array.isArray(body) ? body : [body]

    for (const item of items) {
      if (!item.game_id || !item.client_id || !item.date) {
        return NextResponse.json({ error: 'game_id, client_id, and date are required' }, { status: 400 })
      }
    }

    const { data, error } = await supabase
      .from('steam_wishlists')
      .upsert(items.map(item => ({
        ...item,
        source: item.source || 'manual',
      })), { onConflict: 'game_id,date' })
      .select()

    if (error) throw error

    return NextResponse.json(data)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// DELETE /api/steam-wishlists?id=xxx
export async function DELETE(request: NextRequest) {
  const supabase = getSupabase()
  const { searchParams } = new URL(request.url)
  const id = searchParams.get('id')

  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }

  const { error } = await supabase.from('steam_wishlists').delete().eq('id', id)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
