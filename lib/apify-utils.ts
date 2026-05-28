/**
 * Apify utilities — credit checking, budget management, audit logging
 */

import type { SupabaseClient } from '@supabase/supabase-js'

interface ApifyUsageInfo {
  hasCredits: boolean
  remainingUsd: number | null
  error: string | null
}

interface DailyBudgetInfo {
  ok: boolean
  callsToday: number
  limit: number
  error: string | null
}

const DEFAULT_DAILY_CALL_LIMIT = 200

/**
 * Check if the Apify account has sufficient credits remaining.
 * Returns usage info including whether we should proceed with scanning.
 *
 * Threshold: $2.00 remaining — if below, skip the scan.
 */
/**
 * Apify platforms we route through. Each can be independently enabled or
 * disabled in service_settings.apify_<platform>_enabled.
 *
 * Strategy: Game Drive has a $30/month Apify budget. To stretch that we
 * disable Apify for the platforms where we have free direct-API scrapers
 * (YouTube Data API, Twitch GQL, Reddit JSON) and use Apify only for the
 * channels with no free alternative (TikTok, Instagram, Twitter).
 *
 * SullyGnome is also off by default — Twitch GQL surfaces VODs + clips
 * more comprehensively than SullyGnome's leaderboard scrape.
 */
export type ApifyPlatform =
  | 'youtube' | 'twitch' | 'reddit' | 'sullygnome'
  | 'tiktok' | 'instagram' | 'twitter' | 'deep_scan'

/**
 * Master switch: is Apify enabled at all? When false, ALL platforms are
 * gated off regardless of their individual setting. Acts as a panic button.
 *
 * Fails CLOSED — Supabase outage defaults to "off" so we never burn quota
 * during an incident.
 */
export async function isApifyEnabled(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any
): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('service_settings')
      .select('value')
      .eq('key', 'apify_enabled')
      .maybeSingle()
    if (data?.value === true || data?.value === 'true') return true
    return false
  } catch {
    return false
  }
}

/**
 * Pick the one most-overdue game for a platform — the game whose Apify
 * source row hasn't been touched in the longest time. Used for rotation:
 * each daily cron processes exactly one game so $30/mo Apify budget covers
 * ~5 calls/day total (rotation gets every game scanned every ~7 days per
 * platform).
 *
 * Returns null if no active per-game source exists for this platform.
 */
export async function pickMostOverdueGameForPlatform(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  platform: ApifyPlatform
): Promise<{ game_id: string; last_run_at: string | null } | null> {
  try {
    const { data } = await supabase
      .from('coverage_sources')
      .select('game_id, last_run_at')
      .eq('source_type', platform === 'deep_scan' ? 'tiktok' : platform)
      .eq('is_active', true)
      .not('game_id', 'is', null)
      .order('last_run_at', { ascending: true, nullsFirst: true })
      .limit(1)
    if (!data || data.length === 0) return null
    return { game_id: data[0].game_id, last_run_at: data[0].last_run_at }
  } catch {
    return null
  }
}

/**
 * Single-call gate helper for use at the top of each Apify cron handler.
 * Returns either { skip: true, response } that the handler can return
 * directly, or { skip: false, targetGameId } telling the handler which
 * single game to scan this run.
 */
export async function apifyCronGate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  platform: ApifyPlatform
): Promise<
  | { skip: true; reason: string; data: Record<string, unknown> }
  | { skip: false; targetGameId: string }
> {
  const platformOn = await isApifyPlatformEnabled(supabase, platform)
  if (!platformOn) {
    return {
      skip: true,
      reason: `apify_${platform}_enabled=false`,
      data: { message: `Apify ${platform} disabled — free scanner covers this channel or platform is gated off` },
    }
  }
  const rotation = await pickMostOverdueGameForPlatform(supabase, platform)
  if (!rotation) {
    return {
      skip: true,
      reason: 'no_eligible_game',
      data: { message: `No active per-game ${platform} sources to rotate through` },
    }
  }
  return { skip: false, targetGameId: rotation.game_id }
}

/**
 * Per-platform check. Returns true only when BOTH the master switch and
 * the platform-specific flag are on.
 *
 * Setting key shape: apify_<platform>_enabled (e.g. apify_tiktok_enabled).
 * Missing setting defaults to false (gated off) — same fail-closed model
 * as the master switch.
 */
export async function isApifyPlatformEnabled(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  platform: ApifyPlatform
): Promise<boolean> {
  try {
    const master = await isApifyEnabled(supabase)
    if (!master) return false
    const { data } = await supabase
      .from('service_settings')
      .select('value')
      .eq('key', `apify_${platform}_enabled`)
      .maybeSingle()
    return data?.value === true || data?.value === 'true'
  } catch {
    return false
  }
}

export async function checkApifyCredits(apiKey: string, threshold = 2.0): Promise<ApifyUsageInfo> {
  try {
    const res = await fetch(`https://api.apify.com/v2/users/me?token=${apiKey}`)
    if (!res.ok) {
      return { hasCredits: false, remainingUsd: null, error: `Apify API returned ${res.status}` }
    }
    const data = await res.json()
    // Apify wraps the user payload in `data` — handle both shapes.
    const user = data?.data ?? data
    const plan = user?.plan
    const usage = user?.usage

    // Try to determine remaining credits
    // Apify's /users/me response includes plan limits and current usage
    if (plan?.monthlyUsageLimitUsd && usage?.monthlyUsageUsd !== undefined) {
      const remaining = plan.monthlyUsageLimitUsd - usage.monthlyUsageUsd
      return {
        hasCredits: remaining > threshold,
        remainingUsd: Math.round(remaining * 100) / 100,
        error: null
      }
    }

    // FAIL CLOSED. Previously returned hasCredits: true here, which let the
    // scanners run unchecked when the API response shape changed — that bypassed
    // the budget gate and was a contributor to the May 2026 cost overrun.
    return { hasCredits: false, remainingUsd: null, error: 'Could not determine Apify usage from /users/me response' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // FAIL CLOSED on network errors too.
    return { hasCredits: false, remainingUsd: null, error: msg }
  }
}

/**
 * Check whether today's Apify call count is under the daily cap.
 *
 * This is the backstop that catches bugs we haven't thought of yet — even if
 * a future scanner has a multiplication bug, the daily cap prevents runaway
 * spend. Counts are deterministic (cost estimates are fuzzy across actors), so
 * we gate on call count rather than dollars.
 *
 * Fails CLOSED on errors, like checkApifyCredits.
 */
export async function checkApifyDailyBudget(
  supabase: SupabaseClient
): Promise<DailyBudgetInfo> {
  try {
    // Master kill-switch. When apify_enabled=false, ALL platforms are gated
    // regardless of per-platform flags. Per-platform crons should also call
    // isApifyPlatformEnabled() for fine-grained control before reaching this
    // budget check.
    const { data: enabledRow } = await supabase
      .from('service_settings')
      .select('value')
      .eq('key', 'apify_enabled')
      .maybeSingle()
    const enabled = enabledRow?.value === true || enabledRow?.value === 'true'
    if (!enabled) {
      return { ok: false, callsToday: 0, limit: 0, error: 'apify_enabled=false in service_settings — Apify gated off' }
    }

    // Read configured limit (defaults to DEFAULT_DAILY_CALL_LIMIT if missing).
    const { data: setting } = await supabase
      .from('service_settings')
      .select('value')
      .eq('key', 'apify_daily_call_limit')
      .maybeSingle()

    const limit = Number(setting?.value ?? DEFAULT_DAILY_CALL_LIMIT)

    // Count rows from the last 24h.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { count, error } = await supabase
      .from('apify_runs')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', since)

    if (error) {
      return { ok: false, callsToday: 0, limit, error: error.message }
    }

    const callsToday = count ?? 0
    return { ok: callsToday < limit, callsToday, limit, error: null }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, callsToday: 0, limit: DEFAULT_DAILY_CALL_LIMIT, error: msg }
  }
}

/**
 * Audit one Apify actor invocation. Best-effort — never throws, never blocks
 * the caller. The whole point is observability when something goes wrong.
 */
export async function logApifyRun(
  supabase: SupabaseClient,
  args: {
    scanner: string
    actor_id: string
    input: unknown
    results_count: number | null
    http_status: number | null
    ok: boolean
    error: string | null
  }
): Promise<void> {
  try {
    await supabase.from('apify_runs').insert({
      scanner: args.scanner,
      actor_id: args.actor_id,
      input: args.input as object,
      results_count: args.results_count,
      http_status: args.http_status,
      ok: args.ok,
      error: args.error,
    })
  } catch { /* best effort — never block scans on audit-log writes */ }
}

/**
 * Send a Discord notification about low Apify credits.
 */
export async function notifyLowCredits(remainingUsd: number): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL
  if (!webhookUrl) return

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: 'Apify Credits Low',
          description: `Only **$${remainingUsd.toFixed(2)}** remaining on the Apify account. Social media scanners (YouTube, Reddit, Twitter, TikTok, Instagram, Twitch, SullyGnome) will pause when credits run out.`,
          color: 0xff9900, // orange
          timestamp: new Date().toISOString()
        }]
      })
    })
  } catch { /* best effort */ }
}
