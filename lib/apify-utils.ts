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
 * Master switch: is Apify enabled at all?
 *
 * Read from service_settings.apify_enabled (default false). When disabled,
 * every Apify-dependent cron returns an early skip without touching Apify.
 * This is the operational "work around Apify entirely" path — flip the
 * setting to true when/if the client tops up the monthly cap.
 *
 * Fails OPEN — if the setting can't be read, defaults to false (skip) so we
 * never accidentally burn quota during a Supabase outage.
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
    // Master kill-switch. When Game Drive has chosen to work around Apify
    // entirely, every Apify-dependent cron should skip without paying
    // anything. Surfacing it through the existing budget check means we
    // don't need to touch each cron's handler individually — they all
    // already short-circuit on a non-ok budget.
    const { data: enabledRow } = await supabase
      .from('service_settings')
      .select('value')
      .eq('key', 'apify_enabled')
      .maybeSingle()
    const enabled = enabledRow?.value === true || enabledRow?.value === 'true'
    if (!enabled) {
      return { ok: false, callsToday: 0, limit: 0, error: 'apify_enabled=false in service_settings — Apify scanners gated off' }
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
