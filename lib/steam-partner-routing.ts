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

/**
 * Identify unmapped partner ids from our own game catalog instead of asking a
 * human to type them into Settings → Clients. Every financial row carries an
 * app id alongside its partner id; if that app id is already recorded on
 * exactly one client's game, that client must own the partner id. Learns at
 * most once per partner id per call, never overwrites an existing
 * `steam_partner_id`, and never assigns a partner id to a client whose
 * catalog matches ambiguously (rows for that partner id stay unmapped and
 * keep surfacing in the "unmapped partner id" warning until resolved).
 */
export async function learnPartnerIdsFromCatalog(
  supabase: SupabaseClient,
  rows: Array<{
    partnerid?: string | number | null
    appid?: string | number | null
    primary_appid?: string | number | null
  }>,
  map: PartnerClientMap
): Promise<string[]> {
  const candidatesByPartner = new Map<string, Set<string>>()
  for (const r of rows) {
    if (r.partnerid === null || r.partnerid === undefined) continue
    const partnerId = String(r.partnerid)
    if (map.has(partnerId)) continue
    const appId = r.primary_appid ?? r.appid
    if (appId === null || appId === undefined) continue
    if (!candidatesByPartner.has(partnerId)) candidatesByPartner.set(partnerId, new Set())
    candidatesByPartner.get(partnerId)!.add(String(appId))
  }
  if (candidatesByPartner.size === 0) return []

  const allAppIds = Array.from(new Set(Array.from(candidatesByPartner.values()).flatMap(s => Array.from(s))))
  const { data: games } = await supabase
    .from('games')
    .select('client_id, steam_app_id')
    .in('steam_app_id', allAppIds)
  const clientByAppId = new Map<string, string>()
  for (const g of games || []) {
    if (g.steam_app_id) clientByAppId.set(String(g.steam_app_id), g.client_id)
  }

  const mappedClientIds = new Set(map.values())
  const learned: string[] = []
  for (const [partnerId, appIds] of Array.from(candidatesByPartner.entries())) {
    const matchedClients = new Set<string>()
    for (const appId of Array.from(appIds)) {
      const clientId = clientByAppId.get(appId)
      if (clientId) matchedClients.add(clientId)
    }
    if (matchedClients.size !== 1) continue // no catalog match, or the app id is ambiguous
    const clientId = Array.from(matchedClients)[0]
    if (mappedClientIds.has(clientId)) continue // client already owns a different partner id — don't double-assign

    const { data: client } = await supabase
      .from('clients')
      .select('steam_partner_id')
      .eq('id', clientId)
      .single()
    if (client?.steam_partner_id) continue // set since the map was loaded — don't overwrite

    const { error } = await supabase
      .from('clients')
      .update({ steam_partner_id: partnerId })
      .eq('id', clientId)
    if (error) {
      console.warn(`[Steam] Could not record partner id ${partnerId} for client ${clientId}: ${error.message}`)
      continue
    }
    map.set(partnerId, clientId)
    mappedClientIds.add(clientId)
    learned.push(partnerId)
    console.log(`[Steam] Learned Steam partner id ${partnerId} for client ${clientId} from game catalog match`)
  }
  return learned
}
