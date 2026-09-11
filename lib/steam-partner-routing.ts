/**
 * Route Steam financial rows to clients by Steam partner ID.
 *
 * Every row from IPartnerFinancialsService carries `partnerid` — the Steamworks
 * partner (publisher account) the sale belongs to. Normally that is the client
 * whose key we are using. But when a client shares its apps with Game Drive's
 * own Steamworks partner account (Application Management Sharing with
 * "financial view rights"), Game Drive's single Financial key returns the
 * client's rows too, provided we pass include_view_grants=1. Those rows must
 * land under the right client, which is what `clients.steam_partner_id` is for.
 *
 * Rows whose partnerid is unknown fall back to the key owner's client, and the
 * caller is told which partner IDs were unmapped so they can be assigned in
 * Settings → Clients.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export type PartnerClientMap = Map<string, string> // partnerid -> client uuid

export async function loadPartnerClientMap(supabase: SupabaseClient): Promise<PartnerClientMap> {
  const map: PartnerClientMap = new Map()
  const { data } = await supabase
    .from('clients')
    .select('id, steam_partner_id')
    .not('steam_partner_id', 'is', null)
  for (const c of data || []) {
    if (c.steam_partner_id) map.set(String(c.steam_partner_id), c.id)
  }
  return map
}

export function clientForPartner(
  partnerid: string | number | null | undefined,
  map: PartnerClientMap,
  fallbackClientId: string
): { clientId: string; mapped: boolean } {
  if (partnerid === null || partnerid === undefined || partnerid === '') {
    return { clientId: fallbackClientId, mapped: true }
  }
  const hit = map.get(String(partnerid))
  return hit ? { clientId: hit, mapped: true } : { clientId: fallbackClientId, mapped: false }
}

/**
 * Split rows by the client they belong to. Returns the groups plus the set of
 * partner IDs that had to fall back because nobody claims them.
 */
export function partitionRowsByClient<T extends { partnerid?: string | number | null }>(
  rows: T[],
  map: PartnerClientMap,
  fallbackClientId: string
): { groups: Map<string, T[]>; unmappedPartnerIds: Set<string> } {
  const groups = new Map<string, T[]>()
  const unmappedPartnerIds = new Set<string>()
  for (const row of rows) {
    const { clientId, mapped } = clientForPartner(row.partnerid, map, fallbackClientId)
    if (!mapped && row.partnerid !== null && row.partnerid !== undefined) {
      unmappedPartnerIds.add(String(row.partnerid))
    }
    if (!groups.has(clientId)) groups.set(clientId, [])
    groups.get(clientId)!.push(row)
  }
  return { groups, unmappedPartnerIds }
}

/**
 * When a client's OWN key returns rows, the partnerid on rows that were not
 * view-granted is that client's partner ID. Record it once so that a later
 * switch to view grants routes automatically. Never overwrites an existing
 * value and never steals an ID already assigned to another client.
 */
export async function learnOwnPartnerId(
  supabase: SupabaseClient,
  clientId: string,
  rows: Array<{ partnerid?: string | number | null; view_grant_partnerid?: string | number | null }>,
  map: PartnerClientMap
): Promise<string | null> {
  const own = new Set<string>()
  for (const r of rows) {
    if (r.partnerid === null || r.partnerid === undefined) continue
    if (r.view_grant_partnerid) continue // came through a grant — not ours
    own.add(String(r.partnerid))
  }
  if (own.size !== 1) return null
  const partnerId = Array.from(own)[0]
  if (map.has(partnerId)) return map.get(partnerId) === clientId ? partnerId : null

  const { data: client } = await supabase
    .from('clients')
    .select('steam_partner_id')
    .eq('id', clientId)
    .single()
  if (client?.steam_partner_id) return null

  const { error } = await supabase
    .from('clients')
    .update({ steam_partner_id: partnerId })
    .eq('id', clientId)
  if (error) {
    console.warn(`[Steam] Could not record partner id ${partnerId} for client ${clientId}: ${error.message}`)
    return null
  }
  map.set(partnerId, clientId)
  console.log(`[Steam] Learned Steam partner id ${partnerId} for client ${clientId}`)
  return partnerId
}
