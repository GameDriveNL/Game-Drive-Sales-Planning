/**
 * GET /api/cron/apify-deep-scan-orchestrator
 *
 * Daily cron that rotates one PR-tracked game per day through a historical
 * Apify deep-scan. Closes the recall gap that exists because:
 *   - daily scans use dateFilter='today' (last 24h), which is cost-efficient
 *     for new coverage but useless for backfilling already-launched games
 *   - the launch / announcement window can hold dozens of high-MUV YouTube
 *     videos and Twitch streams that never get rediscovered otherwise
 *
 * Logic:
 *   1. Bail early if Apify credits unavailable (lets quota cycle recover
 *      organically without burning every cron slot trying)
 *   2. Pick the most-overdue game: never deep-scanned OR last deep-scan
 *      older than DEEP_SCAN_INTERVAL_DAYS
 *   3. Decide lookback: 'year' for first-ever deep-scan (one-shot recovery),
 *      'month' for periodic refresh
 *   4. Invoke apify-deep-scan handler internally — same code path the manual
 *      curl trigger uses, so behavior + cost is identical
 *
 * "Last deep-scan" is read from the apify_runs audit table (rows where
 * scanner LIKE 'apify-deep-scan/%'). No new schema needed.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { verifyCronAuth } from '@/lib/cron-auth'
import { checkApifyCredits, checkApifyDailyBudget, isApifyPlatformEnabled, type ApifyPlatform } from '@/lib/apify-utils'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

const DEEP_SCAN_INTERVAL_DAYS = 30
const FIRST_TIME_LOOKBACK: 'year' = 'year'
const REFRESH_LOOKBACK: 'month' = 'month'

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request)
  if (authError) return authError

  const supabase = getServerSupabase()

  // 1. Gate on Apify credit + budget availability. Fail-friendly: when
  // quota is exhausted, return a 200 with a skip message — Vercel cron
  // doesn't retry on success, which is what we want (next day will try again).
  const { data: keyData } = await supabase
    .from('service_api_keys')
    .select('api_key')
    .eq('service_name', 'apify')
    .eq('is_active', true)
    .maybeSingle()
  if (!keyData?.api_key) {
    return NextResponse.json({ message: 'Apify key not configured, skipping' })
  }
  const credits = await checkApifyCredits(keyData.api_key, 5.0)
  if (!credits.hasCredits) {
    return NextResponse.json({
      message: `Apify credits low ($${credits.remainingUsd?.toFixed(2) ?? '?'}); orchestrator skipping`,
      remaining_usd: credits.remainingUsd,
    })
  }
  const budget = await checkApifyDailyBudget(supabase)
  if (!budget.ok) {
    return NextResponse.json({
      message: `Apify daily call cap (${budget.callsToday}/${budget.limit}); orchestrator skipping`,
    })
  }

  // 2. Pull all PR-tracked games + their last deep-scan timestamp.
  // The audit table apify_runs has scanner='apify-deep-scan/<platform>'
  // rows for each platform invocation. We aggregate by extracting game_id
  // from the input column (the input includes a game_id metadata field).
  const { data: games } = await supabase
    .from('games')
    .select('id, name, client_id')
    .eq('pr_tracking_enabled', true)
  if (!games || games.length === 0) {
    return NextResponse.json({ message: 'No PR-tracked games to scan' })
  }

  // Fetch deep-scan history per game. We can't trivially extract game_id
  // from apify_runs.input (JSON shape varies per platform), so instead use
  // a dedicated tracking column. Game-level last_deep_scan_at lives in a
  // jsonb column on games (added if missing); easier than parsing audit
  // rows and works regardless of how many platforms ran in a given scan.
  type GameWithLastScan = { id: string; name: string; client_id: string; last_deep_scan_at: string | null }
  const enriched: GameWithLastScan[] = []
  for (const g of games) {
    // Look up last deep-scan timestamp from coverage_items source_metadata where deep_scan=true.
    // Most-recent discovered_at among deep-scan items = "last deep scan" approximation.
    const { data: lastItem } = await supabase
      .from('coverage_items')
      .select('discovered_at')
      .eq('game_id', g.id)
      .eq('source_metadata->>deep_scan', 'true')
      .order('discovered_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    enriched.push({ ...g, last_deep_scan_at: lastItem?.discovered_at || null })
  }

  // 3. Pick the most-overdue game.
  const now = Date.now()
  const overdue = enriched
    .map(g => {
      const ageDays = g.last_deep_scan_at
        ? (now - new Date(g.last_deep_scan_at).getTime()) / 86400000
        : Infinity
      return { ...g, age_days: ageDays }
    })
    .filter(g => g.age_days >= DEEP_SCAN_INTERVAL_DAYS)
    .sort((a, b) => b.age_days - a.age_days)

  if (overdue.length === 0) {
    return NextResponse.json({
      message: `All ${enriched.length} PR-tracked games scanned within last ${DEEP_SCAN_INTERVAL_DAYS} days`,
    })
  }

  const target = overdue[0]
  const isFirstTime = target.age_days === Infinity
  const lookback = isFirstTime ? FIRST_TIME_LOOKBACK : REFRESH_LOOKBACK

  // Respect per-platform Apify flags. The free scanners (YouTube Data API,
  // Twitch GQL, Reddit JSON) cover their channels — for those platforms,
  // skipping deep-scan saves Apify spend with no recall loss. Only run
  // deep-scan on platforms where Apify is the only path.
  const allPlatforms: ApifyPlatform[] = ['youtube', 'reddit', 'twitter', 'tiktok', 'instagram']
  const enabledPlatforms: string[] = []
  for (const p of allPlatforms) {
    if (await isApifyPlatformEnabled(supabase, p)) enabledPlatforms.push(p)
  }
  if (enabledPlatforms.length === 0) {
    return NextResponse.json({
      message: 'No Apify platforms enabled for deep-scan; free scanners cover all channels',
    })
  }

  // 4. Call the deep-scan handler. We can't import its module here because
  // route handlers in app router aren't directly importable, so issue an
  // internal HTTP fetch back to ourselves. CRON_SECRET is the same for
  // both endpoints — pass it through.
  const base = process.env.NEXT_PUBLIC_APP_URL
    || (request.headers.get('host') ? `https://${request.headers.get('host')}` : null)
    || 'https://platform.game-drive.nl'

  const deepScanRes = await fetch(`${base}/api/cron/apify-deep-scan`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': request.headers.get('authorization') || '',
    },
    body: JSON.stringify({
      game_id: target.id,
      lookback,
      max_results: isFirstTime ? 50 : 30,
      platforms: enabledPlatforms,  // only the platforms still gated to Apify
    }),
  })

  if (!deepScanRes.ok) {
    const errBody = await deepScanRes.text()
    return NextResponse.json({
      message: `Deep-scan invocation failed for ${target.name}: HTTP ${deepScanRes.status}`,
      error: errBody.substring(0, 500),
    }, { status: 500 })
  }

  const deepScanResult = await deepScanRes.json()
  return NextResponse.json({
    message: `Deep-scan complete for ${target.name} (lookback=${lookback}, first_time=${isFirstTime})`,
    selected_game: { id: target.id, name: target.name, age_days: target.age_days === Infinity ? 'never' : Math.round(target.age_days) },
    remaining_overdue: overdue.length - 1,
    deep_scan_result: deepScanResult,
  })
}
