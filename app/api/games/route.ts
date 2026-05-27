import { NextResponse } from 'next/server'
import { serverSupabase as supabase } from '@/lib/supabase'
import { autoEnrollGameInScrapers } from '@/lib/auto-enroll'

// GET - Fetch all games with client info
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const clientId = searchParams.get('client_id')

    let query = supabase
      .from('games')
      .select('*, client:clients(id, name)')
      .order('name', { ascending: true })

    if (clientId) {
      query = query.eq('client_id', clientId)
    }

    const { data, error } = await query
    if (error) throw error

    return NextResponse.json(data || [])
  } catch (error) {
    console.error('Error fetching games:', error)
    return NextResponse.json({ error: 'Failed to fetch games' }, { status: 500 })
  }
}

// POST - Create a new game
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { name, client_id, steam_app_id, pr_tracking_enabled, pr_coverage_until } = body

    if (!name || !client_id) {
      return NextResponse.json(
        { error: 'Game name and client_id are required' },
        { status: 400 }
      )
    }

    const { data, error } = await supabase
      .from('games')
      .insert({
        name,
        client_id,
        steam_app_id: steam_app_id || null,
        pr_tracking_enabled: pr_tracking_enabled ?? false,
        pr_coverage_until: pr_coverage_until || null
      })
      .select('*, client:clients(id, name)')
      .single()

    if (error) throw error

    // Auto-enroll game in all scrapers when PR tracking is enabled
    if (data?.id && data?.name && data?.pr_tracking_enabled) {
      await autoEnrollGameInScrapers(supabase, data.id, data.name, data.client_id)
      // B25: fire retroactive Tavily backfill (~90 days) — fire-and-forget
      triggerRetroactiveBackfill(data.id).catch(err => console.error('B25 backfill trigger failed:', err))
    }

    return NextResponse.json(data)
  } catch (error) {
    console.error('Error creating game:', error)
    return NextResponse.json({ error: 'Failed to create game' }, { status: 500 })
  }
}

// B25: trigger a retroactive PR coverage backfill (90-day lookback)
// when a game is first enabled for PR tracking. Fires the existing
// /api/coverage-backfill endpoint asynchronously — don't block the caller.
async function triggerRetroactiveBackfill(gameId: string) {
  const base = process.env.NEXT_PUBLIC_APP_URL || 'https://platform.game-drive.nl'
  try {
    await fetch(`${base}/api/coverage-backfill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game_id: gameId, max_queries: 20 })
    })
  } catch (e) {
    console.error('B25 retroactive backfill failed to start:', e)
  }
}

// PUT - Update a game
export async function PUT(request: Request) {
  try {
    const body = await request.json()
    const { id, ...updates } = body

    if (!id) {
      return NextResponse.json({ error: 'Game id is required' }, { status: 400 })
    }

    // If the caller is setting store_page_live_date, treat it as a manual override
    // unless they explicitly passed a source (e.g. the cron sync writing 'auto').
    if (Object.prototype.hasOwnProperty.call(updates, 'store_page_live_date')
        && !Object.prototype.hasOwnProperty.call(updates, 'store_page_live_date_source')) {
      updates.store_page_live_date_source = 'manual'
    }

    const { data, error } = await supabase
      .from('games')
      .update(updates)
      .eq('id', id)
      .select('*, client:clients(id, name)')
      .single()

    if (error) throw error

    // Auto-enroll when PR tracking is toggled on
    if (data && updates.pr_tracking_enabled === true) {
      await autoEnrollGameInScrapers(supabase, data.id, data.name, data.client_id)
      // B25: also trigger retroactive backfill so the user immediately has
      // ~90 days of historical coverage rather than waiting for daily crons
      triggerRetroactiveBackfill(data.id).catch(err => console.error('B25 backfill trigger failed:', err))
    }

    // B22: when PR tracking is toggled OFF for a game, deactivate its
    // coverage_sources so scrapers stop polling for it — keeps cost and
    // noise down. Sources are reactivated on re-enable via autoEnroll.
    if (data && updates.pr_tracking_enabled === false) {
      await supabase
        .from('coverage_sources')
        .update({ is_active: false })
        .eq('game_id', data.id)
    }

    return NextResponse.json(data)
  } catch (error) {
    console.error('Error updating game:', error)
    return NextResponse.json({ error: 'Failed to update game' }, { status: 500 })
  }
}

// DELETE - Delete a game (cascades to products, sales, coverage)
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')

    if (!id) {
      return NextResponse.json({ error: 'Game id is required' }, { status: 400 })
    }

    const { error } = await supabase
      .from('games')
      .delete()
      .eq('id', id)

    if (error) throw error

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error deleting game:', error)
    return NextResponse.json({ error: 'Failed to delete game' }, { status: 500 })
  }
}
