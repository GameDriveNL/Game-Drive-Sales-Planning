/**
 * POST /api/admin/backfill-keywords
 *
 * Re-runs autoEnrollGameInScrapers in 'refresh' mode against every PR-tracked
 * game. Used to retrofit games created before the Tavily-driven variant
 * generator existed (e.g. Dark Pals, Verdun, Tannenberg) so their source
 * configs and coverage_keywords get the richer variant set.
 *
 * Auth: same Bearer CRON_SECRET as the cron endpoints. This is a manual admin
 * operation, not a scheduled cron, but the auth model matches.
 *
 * Body (optional JSON):
 *   { game_id?: string }   — backfill a single game instead of all PR-tracked
 *   { dry_run?: boolean }  — log what would change without writing
 */

import { NextRequest, NextResponse } from 'next/server'
import { serverSupabase as supabase } from '@/lib/supabase'
import { autoEnrollGameInScrapers } from '@/lib/auto-enroll'
import { verifyCronAuth } from '@/lib/cron-auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

export async function POST(request: NextRequest) {
  const authError = verifyCronAuth(request)
  if (authError) return authError

  let body: { game_id?: string; dry_run?: boolean } = {}
  try {
    body = await request.json()
  } catch { /* empty body is fine */ }

  const targetGameId = body.game_id || null
  const dryRun = body.dry_run === true

  let query = supabase
    .from('games')
    .select('id, name, client_id')
    .eq('pr_tracking_enabled', true)

  if (targetGameId) query = query.eq('id', targetGameId)

  const { data: games, error: gamesErr } = await query

  if (gamesErr) {
    return NextResponse.json({ error: gamesErr.message }, { status: 500 })
  }

  if (!games || games.length === 0) {
    return NextResponse.json({
      message: targetGameId
        ? `No PR-tracked game with id ${targetGameId}`
        : 'No PR-tracked games found',
      processed: 0,
    })
  }

  if (dryRun) {
    return NextResponse.json({
      message: `Dry run — would refresh ${games.length} games`,
      games: games.map(g => ({ id: g.id, name: g.name })),
    })
  }

  const results: unknown[] = []
  const errors: Array<{ game: string; error: string }> = []

  for (const game of games) {
    try {
      const result = await autoEnrollGameInScrapers(
        supabase,
        game.id,
        game.name,
        game.client_id,
        { mode: 'refresh' }
      )
      results.push({
        game_id: result.game_id,
        game_name: result.game_name,
        variants_count: result.variants.length,
        variants: result.variants,
        hashtags: result.hashtags,
        subreddits_count: result.subreddits.length,
        inserted_types: result.inserted_types,
        refreshed_types: result.refreshed_types,
        new_keywords: result.new_keywords,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push({ game: game.name, error: msg })
      console.error(`[backfill-keywords] ${game.name} failed:`, msg)
    }
  }

  return NextResponse.json({
    message: `Backfill complete: ${results.length}/${games.length} games`,
    processed: results.length,
    errors_count: errors.length,
    results,
    errors,
  })
}
