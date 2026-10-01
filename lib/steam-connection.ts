/**
 * How each client's Steam sales data actually reaches us, for the Client Keys page.
 *
 *  own              the client's own Financial API key works
 *  game_drive       the client shares its apps with Game Drive's Steamworks
 *                   account and we read its data through that (view grant).
 *                   Their own key, if one is stored, is not used.
 *  needs_attention  neither route works
 *
 * "game_drive" is decided from facts, not hope: the own key is rejected (or
 * absent), the client has a Steam partner id, Game Drive's agency key is
 * configured, and rows for the client landed within the last few days — which,
 * with the own key rejected, can only have come through the agency account.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { AGENCY_STEAM_PARTNER_ID } from './steam-partner-routing'
import { checkSteamFinancialKey, fingerprintKey, normalizeSteamKey } from './steam-key-check'

export type SteamConnectionMode = 'own' | 'game_drive' | 'needs_attention'

export interface SteamConnection {
  client_id: string
  client_name: string
  mode: SteamConnectionMode
  /** id of the stored key row, or null when the client has no key of its own. */
  key_id: string | null
  /** First/last 4 chars of the stored key, for display next to a rejected key. */
  own_key_fingerprint: string | null
  /** Why the stored key is not being used (only set when it failed). */
  own_key_message: string | null
  /** Newest sale_date we hold for this client, YYYY-MM-DD. */
  last_data_date: string | null
}

/** Rows newer than this count as "data is flowing". The daily sync covers 30 days, so 4 is generous. */
const RECENT_DATA_DAYS = 4

function isRecent(dateStr: string | null): boolean {
  if (!dateStr) return false
  const ageMs = Date.now() - new Date(`${dateStr}T00:00:00Z`).getTime()
  return ageMs <= RECENT_DATA_DAYS * 24 * 60 * 60 * 1000
}

export async function getSteamConnections(supabase: SupabaseClient, onlyClientId?: string): Promise<SteamConnection[]> {
  const [{ data: clients }, { data: keys }] = await Promise.all([
    supabase.from('clients').select('id, name, steam_partner_id'),
    supabase.from('steam_api_keys').select('id, client_id, api_key, publisher_key').eq('is_active', true),
  ])

  const keyByClient = new Map<string, { id: string; key: string }>()
  let agencyReady = false
  for (const k of keys || []) {
    const key = normalizeSteamKey(k.publisher_key || k.api_key)
    if (key) keyByClient.set(k.client_id, { id: k.id, key })
  }
  for (const c of clients || []) {
    if (String(c.steam_partner_id) === AGENCY_STEAM_PARTNER_ID && keyByClient.has(c.id)) agencyReady = true
  }

  // A client belongs on the page if it has a key row, or has a partner id (shared via Game Drive).
  const candidates = (clients || []).filter(c =>
    (keyByClient.has(c.id) || c.steam_partner_id) && (!onlyClientId || c.id === onlyClientId)
  )

  const results = await Promise.all(candidates.map(async (c): Promise<SteamConnection | null> => {
    const stored = keyByClient.get(c.id) || null
    const [check, lastRow] = await Promise.all([
      stored ? checkSteamFinancialKey(stored.key) : Promise.resolve(null),
      supabase.from('steam_sales').select('sale_date').eq('client_id', c.id).order('sale_date', { ascending: false }).limit(1),
    ])
    const lastDataDate: string | null = lastRow.data?.[0]?.sale_date ?? null
    const base = {
      client_id: c.id,
      client_name: c.name,
      key_id: stored?.id ?? null,
      own_key_fingerprint: stored ? fingerprintKey(stored.key) : null,
      last_data_date: lastDataDate,
    }

    if (check?.ok) return { ...base, mode: 'own', own_key_message: null }

    const viaGameDrive =
      !!c.steam_partner_id &&
      String(c.steam_partner_id) !== AGENCY_STEAM_PARTNER_ID &&
      agencyReady &&
      isRecent(lastDataDate)
    if (viaGameDrive) return { ...base, mode: 'game_drive', own_key_message: check ? check.message : null }

    if (stored) return { ...base, mode: 'needs_attention', own_key_message: check ? check.message : null }
    return null // no key and nothing flowing: nothing to show
  }))

  return results.filter((r): r is SteamConnection => r !== null)
}
