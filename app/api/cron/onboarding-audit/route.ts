/**
 * GET /api/cron/onboarding-audit
 *
 * Fires the forced-historical-scan endpoint for any PR-tracked game that
 * doesn't yet have its `forced_historical_<gameId>_done` lock set.
 *
 * Acts as the autonomous "new game just got added → run the deep baseline
 * scan once" hook. Detached from the games table so we don't have to wire
 * directly into the game-create flow; this cron just polls every hour and
 * fires what's missing. New games get their baseline within an hour of
 * being marked PR-tracked.
 *
 * Cost: $0.04 Tavily per game in the queue. The free passes (gql/helix/
 * piped/tavily) are always run; the optional Apify TikTok pass is NOT
 * triggered here — operators decide that separately per game so we don't
 * surprise-burn the monthly budget.
 *
 * Auth: Bearer CRON_SECRET.
 *
 * Schedule: hourly (set in vercel.json).
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { verifyCronAuth } from '@/lib/cron-auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60  // we only kick off, we don't wait

// Cap how many games we fire per run to avoid surprise Tavily / Helix bills.
// At 1/hour cadence, 3 games per run keeps onboarding latency under an hour
// for any reasonable client-add velocity.
const MAX_FIRES_PER_RUN = 3

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request)
  if (authError) return authError

  const supabase = getServerSupabase()

  // PR-tracked games
  const { data: games } = await supabase
    .from('games')
    .select('id, name')
    .eq('pr_tracking_enabled', true)
  if (!games || games.length === 0) {
    return NextResponse.json({ message: 'No PR-tracked games' })
  }

  // Existing locks
  const { data: locks } = await supabase
    .from('service_settings')
    .select('key, value')
    .like('key', 'forced_historical_%_done')
  const lockedGameIds = new Set<string>()
  for (const row of (locks || []) as Array<{ key: string; value: unknown }>) {
    const m = row.key.match(/^forced_historical_(.+)_done$/)
    if (m && (row.value === true || row.value === 'true')) lockedGameIds.add(m[1])
  }

  // Games without a baseline
  const pending = (games as Array<{ id: string; name: string }>)
    .filter(g => !lockedGameIds.has(g.id))
    .slice(0, MAX_FIRES_PER_RUN)

  if (pending.length === 0) {
    return NextResponse.json({
      message: 'All PR-tracked games already have a forced-historical baseline.',
      total_tracked: games.length,
      locked: lockedGameIds.size,
    })
  }

  // Fire each via a self-call to the public forced-historical endpoint.
  // We do NOT await — Vercel functions are independent invocations, and the
  // scanner's 300s maxDuration would block this cron forever if we did.
  // Fire-and-forget pattern: the lock prevents double-firing if this cron
  // runs again before the scan finishes.
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'https://platform.game-drive.nl'

  const fired: Array<{ id: string; name: string; ok: boolean; status?: number; error?: string }> = []
  for (const g of pending) {
    try {
      // Best-effort fire. We don't wait for the response — we initiate the
      // request, give it 2 seconds to confirm the Vercel function started,
      // then move on. The scanner will run to completion in its own ~5min
      // invocation regardless.
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 2_000)
      const res = await fetch(`${baseUrl}/api/coverage-health/forced-historical-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game_id: g.id }),
        signal: ctl.signal,
      }).catch(err => {
        // AbortError is expected — we intentionally abort after 2s
        if (err instanceof Error && err.name === 'AbortError') return null
        throw err
      })
      clearTimeout(timer)
      fired.push({ id: g.id, name: g.name, ok: true, status: res?.status ?? null as unknown as number })
    } catch (err) {
      fired.push({
        id: g.id, name: g.name, ok: false,
        error: err instanceof Error ? err.message.substring(0, 120) : String(err).substring(0, 120),
      })
    }
  }

  return NextResponse.json({
    message: `Fired forced-historical-scan for ${fired.length} games`,
    total_tracked: games.length,
    already_locked: lockedGameIds.size,
    pending_after_this_run: Math.max(0, games.length - lockedGameIds.size - fired.length),
    fired,
  })
}
