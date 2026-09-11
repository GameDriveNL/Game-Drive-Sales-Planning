/**
 * Steam Web API key diagnostics.
 *
 * A bare "403" from partner.steam-api.com hides two very different problems.
 * We run two probes so the UI and sync jobs can say exactly which one it is:
 *
 *  1. ISteamApps/GetPartnerAppListForWebAPIKey — succeeds for ANY live
 *     publisher key (including Financial API Group keys, which return an
 *     empty app list). A 403 here means Steam does not recognise the key
 *     from this caller at all: it was regenerated/deleted, it was copied
 *     wrong, or the key's "Allowed IP addresses" list is non-empty.
 *
 *  2. IPartnerFinancialsService/GetChangedDatesForPartner — needs a key
 *     from a Financial API Group. A 403 here while probe 1 succeeds means
 *     the key is real but was created in a normal publisher group, not a
 *     Financial API Group.
 *
 * Verified 2026-09-11: tobspr's Financial key returns 200 on both probes;
 * TMG's stored Financial key returns 403 on both; TMG's secondary key
 * returns 200 on probe 1 and 403 on probe 2 — from a residential IP as
 * well as from Vercel, so egress IP is not the variable.
 */

export const STEAM_PARTNER_API = 'https://partner.steam-api.com'

export type SteamKeyStatus =
  | 'ok'                      // Financial API reachable
  | 'unknown_key'             // Steam rejects the key outright (403 on basic probe)
  | 'no_financial_permission' // Key is live but not a Financial API Group key
  | 'malformed'               // Not a 32-char hex string
  | 'network_error'           // Could not reach Steam

export interface SteamKeyCheck {
  status: SteamKeyStatus
  ok: boolean
  /** Short human explanation, safe to show to non-technical users. */
  message: string
  /** Concrete next step for whoever manages the Steamworks account. */
  fix: string
  /** First/last 4 chars so a user can compare against Steamworks without exposing the key. */
  fingerprint: string
  /** How many financial dates Steam reports (only when status === 'ok'). */
  dateCount?: number
  /** Latest highwatermark from Steam (only when status === 'ok'). */
  highwatermark?: string
  debug: {
    basicProbeStatus?: number
    financialProbeStatus?: number
    financialBody?: string
  }
}

/** Trim, strip internal whitespace/zero-width chars, upper-case. Steam keys are 32 hex chars. */
export function normalizeSteamKey(raw: string | null | undefined): string {
  return (raw || '').replace(/[\s​-‍﻿]/g, '').toUpperCase()
}

export function isWellFormedSteamKey(key: string): boolean {
  return /^[0-9A-F]{32}$/.test(key)
}

export function fingerprintKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return key
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

async function probe(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { cache: 'no-store' })
  const body = await res.text()
  return { status: res.status, body }
}

/**
 * Classify a key. Never throws.
 */
export async function checkSteamFinancialKey(rawKey: string | null | undefined): Promise<SteamKeyCheck> {
  const key = normalizeSteamKey(rawKey)
  const fingerprint = fingerprintKey(key)

  if (!isWellFormedSteamKey(key)) {
    return {
      status: 'malformed',
      ok: false,
      fingerprint,
      message: 'This is not a valid Steam Web API key format (expected 32 hex characters).',
      fix: 'Re-copy the key from Steamworks. Make sure nothing was cut off or added while pasting.',
      debug: {},
    }
  }

  let financial: { status: number; body: string }
  try {
    financial = await probe(
      `${STEAM_PARTNER_API}/IPartnerFinancialsService/GetChangedDatesForPartner/v001/?key=${key}&highwatermark=0`
    )
  } catch (err) {
    return {
      status: 'network_error',
      ok: false,
      fingerprint,
      message: `Could not reach the Steam Partner API: ${err instanceof Error ? err.message : String(err)}`,
      fix: 'Retry in a minute. If it keeps failing, Steam may be having an outage.',
      debug: {},
    }
  }

  if (financial.status === 200) {
    let dateCount: number | undefined
    let highwatermark: string | undefined
    try {
      const data = JSON.parse(financial.body)
      dateCount = Array.isArray(data?.response?.dates) ? data.response.dates.length : 0
      highwatermark = data?.response?.result_highwatermark
    } catch {
      // 200 with a non-JSON body is still "reachable"; leave counts undefined
    }
    return {
      status: 'ok',
      ok: true,
      fingerprint,
      message: `Financial API connected. ${dateCount ?? '?'} date(s) with sales data available.`,
      fix: '',
      dateCount,
      highwatermark,
      debug: { financialProbeStatus: 200 },
    }
  }

  if (financial.status !== 403) {
    return {
      status: 'network_error',
      ok: false,
      fingerprint,
      message: `Steam returned an unexpected status ${financial.status}.`,
      fix: 'Retry in a minute. If it keeps failing, Steam may be having an outage.',
      debug: { financialProbeStatus: financial.status, financialBody: financial.body.slice(0, 300) },
    }
  }

  // 403 on the financial endpoint — figure out which kind.
  let basic: { status: number; body: string }
  try {
    basic = await probe(
      `${STEAM_PARTNER_API}/ISteamApps/GetPartnerAppListForWebAPIKey/v2/?type_filter=all&key=${key}`
    )
  } catch {
    basic = { status: 0, body: '' }
  }

  if (basic.status === 200) {
    return {
      status: 'no_financial_permission',
      ok: false,
      fingerprint,
      message:
        `Steam recognises key ${fingerprint}, but it is not a Financial API Group key, so it cannot read sales data.`,
      fix:
        'In Steamworks go to Users & Permissions → Manage Groups. Open (or create) the group named "Financial API Group" — ' +
        'it is a special group with no users and no apps — and copy the Web API key shown on THAT group\'s page. ' +
        'Keys from ordinary publisher groups do not work even with "Sales Data" permission ticked.',
      debug: { basicProbeStatus: 200, financialProbeStatus: 403, financialBody: financial.body.slice(0, 300) },
    }
  }

  return {
    status: 'unknown_key',
    ok: false,
    fingerprint,
    message:
      `Steam does not recognise key ${fingerprint} at all — it fails even the most basic key check, from every network we have tried.`,
    fix:
      'Open the Financial API Group page in Steamworks (Users & Permissions → Manage Groups) and compare the key shown there ' +
      `with ${fingerprint}. If they differ, the key was regenerated or mis-copied — paste the current one. ` +
      'If they match, look at "Allowed IP addresses" under Manage WebAPI Key on that page and remove EVERY entry: any entry ' +
      'at all locks the key to those addresses, and our servers do not have a fixed address. Then click Test again here.',
    debug: { basicProbeStatus: basic.status, financialProbeStatus: 403, financialBody: financial.body.slice(0, 300) },
  }
}

/**
 * One-line summary for sync_jobs.error_message / logs.
 */
export function describeKeyFailure(check: SteamKeyCheck): string {
  switch (check.status) {
    case 'unknown_key':
      return `Steam API returned status 403 — Steam does not recognise key ${check.fingerprint} (regenerated, mis-copied, or IP-locked in Steamworks). ${check.fix}`
    case 'no_financial_permission':
      return `Steam API returned status 403 — key ${check.fingerprint} is valid but is not a Financial API Group key. ${check.fix}`
    case 'malformed':
      return `Stored key ${check.fingerprint} is malformed. ${check.fix}`
    case 'network_error':
      return check.message
    default:
      return check.message
  }
}
