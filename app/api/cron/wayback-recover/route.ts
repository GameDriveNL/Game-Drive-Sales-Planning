/**
 * POST /api/cron/wayback-recover
 *
 * One-shot historical recovery for a game using the Internet Archive's
 * CDX search API. Useful when:
 *   - A game is newly enrolled but had a launch/campaign before the system
 *     was tracking it (articles aged out of RSS, may not be in Tavily's
 *     current index either)
 *   - We see a manual sheet with historical coverage we want to recover
 *
 * Body (JSON):
 *   game_id: string         — required
 *   from?: 'YYYY-MM-DD'     — start of archive range (default 90d ago)
 *   to?: 'YYYY-MM-DD'       — end of archive range (default today)
 *   dry_run?: boolean
 *
 * Lives under /api/cron because that prefix bypasses the auth middleware
 * and uses Bearer CRON_SECRET — same auth model as other admin scripts.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { verifyCronAuth } from '@/lib/cron-auth'
import { recoverGameFromWayback } from '@/lib/wayback-recovery'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

export async function POST(request: NextRequest) {
  const authError = verifyCronAuth(request)
  if (authError) return authError

  let body: { game_id?: string; from?: string; to?: string; dry_run?: boolean } = {}
  try { body = await request.json() } catch { /* empty ok */ }

  if (!body.game_id) {
    return NextResponse.json({ error: 'game_id is required' }, { status: 400 })
  }

  const supabase = getServerSupabase()
  const { data: game } = await supabase
    .from('games')
    .select('id, name, client_id')
    .eq('id', body.game_id)
    .single()
  if (!game) return NextResponse.json({ error: 'Game not found' }, { status: 404 })

  if (body.dry_run) {
    return NextResponse.json({
      message: 'Dry run — would query Wayback Machine for archives of subscribed outlets',
      game: game.name,
      from: body.from || '90 days ago',
      to: body.to || 'today',
    })
  }

  const result = await recoverGameFromWayback(
    supabase,
    game.id,
    game.name,
    game.client_id,
    body.from,
    body.to
  )
  return NextResponse.json({
    message: `Wayback recovery complete for ${game.name}`,
    ...result,
  })
}
