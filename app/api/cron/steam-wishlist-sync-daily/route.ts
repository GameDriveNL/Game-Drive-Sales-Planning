import { NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { runWishlistSync } from '@/lib/steam-wishlist-sync'

// GET /api/cron/steam-wishlist-sync-daily — Vercel cron entry point.
// Sweeps every client that has at least one game with a Steam App ID and pulls
// the last few days of wishlist data, so a newly added game (or a game whose
// client key just started/stopped working) doesn't need a human to remember to
// click "Sync from Steam API" on the Wishlists page.
export async function GET() {
  const supabase = getServerSupabase()

  try {
    const { data: games, error } = await supabase
      .from('games')
      .select('client_id')
      .not('steam_app_id', 'is', null)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const clientIds = Array.from(new Set((games || []).map(g => g.client_id).filter(Boolean))) as string[]

    // Short recent window — this runs daily, so a few days of overlap is enough
    // to catch up after a missed run without risking the Vercel function timeout.
    const dateTo = new Date().toISOString().split('T')[0]
    const dateFromDate = new Date()
    dateFromDate.setDate(dateFromDate.getDate() - 5)
    const dateFrom = dateFromDate.toISOString().split('T')[0]

    const results: { client_id: string; status: number; message?: string; error?: string }[] = []

    for (const clientId of clientIds) {
      try {
        const result = await runWishlistSync(supabase, { client_id: clientId, date_from: dateFrom, date_to: dateTo })
        results.push({
          client_id: clientId,
          status: result.status,
          message: result.body.message as string | undefined,
          error: result.body.error as string | undefined,
        })
      } catch (err) {
        results.push({
          client_id: clientId,
          status: 500,
          error: err instanceof Error ? err.message : 'Unknown error',
        })
      }
    }

    return NextResponse.json({
      success: true,
      clientsProcessed: clientIds.length,
      dateRange: { from: dateFrom, to: dateTo },
      results,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[Steam Wishlist Sync Daily] Error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
