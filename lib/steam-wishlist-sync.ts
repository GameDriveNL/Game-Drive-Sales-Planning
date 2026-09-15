/**
 * Shared Steam wishlist sync logic — used by the manual sync endpoint
 * (app/api/cron/steam-wishlist-sync) and the daily cron that runs it for every
 * client automatically (app/api/cron/steam-wishlist-sync-daily), so a new game
 * gets wishlist data without anyone having to remember to click "Sync".
 */
import type { SupabaseClient } from '@supabase/supabase-js'

const STEAM_PARTNER_API = 'https://partner.steam-api.com'

// Game Drive's own Steamworks partner account (see lib/steam-partner-routing.ts).
// Clients can share "financial view rights" with this account so wishlist data can
// be pulled without ever needing (or trusting) the client's own key.
export const AGENCY_STEAM_PARTNER_ID = '352871'

export async function resolveAgencyApiKey(supabase: SupabaseClient): Promise<string | null> {
  const { data: agencyClient } = await supabase
    .from('clients')
    .select('id')
    .eq('steam_partner_id', AGENCY_STEAM_PARTNER_ID)
    .maybeSingle()
  if (!agencyClient) return null

  const { data: agencyKeyData } = await supabase
    .from('steam_api_keys')
    .select('api_key, publisher_key')
    .eq('client_id', agencyClient.id)
    .eq('is_active', true)
    .single()
  if (!agencyKeyData) return null

  return agencyKeyData.publisher_key || agencyKeyData.api_key || null
}

interface WishlistReportResponse {
  response: {
    appid: number
    date: string
    wishlist_summary: {
      wishlist_adds: number
      wishlist_deletes: number
      wishlist_purchases: number
      wishlist_gifts: number
    }
    app_min_date?: string
  }
}

export interface WishlistSyncResult {
  status: number
  body: Record<string, unknown>
}

export async function runWishlistSync(
  supabase: SupabaseClient,
  params: { client_id: string; game_id?: string; date_from?: string; date_to?: string }
): Promise<WishlistSyncResult> {
  const { client_id, game_id, date_from, date_to } = params

  // Get the client's own Steam Financial API key, if any — no longer fatal if
  // missing or broken, since we can fall back to Game Drive's agency key below.
  const { data: keyData } = await supabase
    .from('steam_api_keys')
    .select('api_key, publisher_key')
    .eq('client_id', client_id)
    .eq('is_active', true)
    .single()

  const ownApiKey = keyData ? (keyData.publisher_key || keyData.api_key || null) : null
  const agencyApiKey = await resolveAgencyApiKey(supabase)

  if (!ownApiKey && !agencyApiKey) {
    return {
      status: 404,
      body: {
        error: 'No active Steam API key found for this client, and no Game Drive agency key is configured as a fallback. Configure one in Settings > Steam API, or have the client share Steamworks financial view rights with Game Drive’s partner account.',
      },
    }
  }

  // Prefer the client's own key; GetAppWishlistReporting is queried per app id
  // (not partner-wide), so it falls back to the agency key transparently on a 403
  // below without needing clients.steam_partner_id to be set at all.
  let apiKey = ownApiKey || agencyApiKey!

  // Get games to sync — either a specific game or all games for this client with steam_app_id
  let gamesToSync: { id: string; name: string; steam_app_id: string }[] = []

  if (game_id) {
    const { data: game } = await supabase
      .from('games')
      .select('id, name, steam_app_id')
      .eq('id', game_id)
      .not('steam_app_id', 'is', null)
      .single()

    if (game && game.steam_app_id) {
      gamesToSync = [game as { id: string; name: string; steam_app_id: string }]
    }
  } else {
    const { data: games } = await supabase
      .from('games')
      .select('id, name, steam_app_id')
      .eq('client_id', client_id)
      .not('steam_app_id', 'is', null)

    gamesToSync = (games || []).filter(g => g.steam_app_id) as { id: string; name: string; steam_app_id: string }[]
  }

  if (gamesToSync.length === 0) {
    return {
      status: 400,
      body: { error: 'No games with Steam App ID found. Add a Steam App ID to your games first.' },
    }
  }

  // Build date range — default to last 90 days
  const endDate = date_to || new Date().toISOString().split('T')[0]
  const defaultStart = new Date()
  defaultStart.setDate(defaultStart.getDate() - 90)
  const startDate = date_from || defaultStart.toISOString().split('T')[0]

  // Generate date list
  const dates: string[] = []
  const current = new Date(startDate)
  const end = new Date(endDate)
  while (current <= end) {
    dates.push(current.toISOString().split('T')[0])
    current.setDate(current.getDate() + 1)
  }

  // Limit to avoid Vercel timeout — process max 30 dates per game
  const MAX_DATES = 30
  const truncatedDates = dates.length > MAX_DATES
  const datesToSync = truncatedDates ? dates.slice(dates.length - MAX_DATES) : dates

  let totalImported = 0
  let totalSkipped = 0
  const errors: string[] = []
  const gameResults: { game: string; imported: number; error?: string }[] = []

  // Look up current store_page_live_date sources so we know which games to auto-update
  const { data: gameMeta } = await supabase
    .from('games')
    .select('id, store_page_live_date, store_page_live_date_source')
    .in('id', gamesToSync.map(g => g.id))
  const metaById = new Map<string, { live: string | null; source: string | null }>()
  for (const g of gameMeta || []) {
    metaById.set(g.id, { live: g.store_page_live_date, source: g.store_page_live_date_source })
  }

  for (const game of gamesToSync) {
    let gameImported = 0
    let earliestAppMinDate: string | null = null

    for (const date of datesToSync) {
      try {
        const fetchWishlist = (key: string) =>
          fetch(`${STEAM_PARTNER_API}/IPartnerFinancialsService/GetAppWishlistReporting/v001/?key=${key}&date=${date}&appid=${game.steam_app_id}`)

        let response = await fetchWishlist(apiKey)
        let data: WishlistReportResponse | null = response.ok ? await response.json() : null
        // Steam doesn't 403 an app the key can't see on this endpoint — it returns
        // 200 with an empty `{"response":{}}` body instead. Treat that as "no
        // access" too, or a permission gap silently looks like "no wishlist data".
        let noAccess = response.status === 403 || (response.ok && !data?.response?.appid)

        if (noAccess && agencyApiKey && apiKey !== agencyApiKey) {
          // The active key can't see this app (broken, revoked, no financial group,
          // no shared view rights, etc). Switch to Game Drive's agency key for the
          // rest of this sync — it sees any app the client has shared Steamworks
          // financial view rights with.
          apiKey = agencyApiKey
          response = await fetchWishlist(apiKey)
          data = response.ok ? await response.json() : null
          noAccess = response.status === 403 || (response.ok && !data?.response?.appid)
        }

        if (noAccess) {
          errors.push(`${game.name}: No wishlist access, even via Game Drive's agency key (status ${response.status}). The client needs to share Steamworks financial view rights with Game Drive's partner account (${AGENCY_STEAM_PARTNER_ID}).`)
          break // No point trying more dates for this game
        }

        if (!response.ok || !data) {
          // Skip individual date errors silently (e.g. no data for that date)
          continue
        }

        const summary = data.response?.wishlist_summary

        // Capture app_min_date — the earliest date Steam has wishlist data for this app.
        // This is functionally equivalent to "store page live date" because you can only
        // wishlist a game once its store page exists.
        const appMinDate = data.response?.app_min_date
        if (appMinDate) {
          const normalized = appMinDate.replace(/\//g, '-')
          if (!earliestAppMinDate || normalized < earliestAppMinDate) {
            earliestAppMinDate = normalized
          }
        }

        if (!summary) continue

        const row = {
          game_id: game.id,
          client_id,
          date: data.response.date.replace(/\//g, '-'),
          additions: summary.wishlist_adds || 0,
          deletions: summary.wishlist_deletes || 0,
          purchases_and_activations: summary.wishlist_purchases || 0,
          gifts: summary.wishlist_gifts || 0,
          source: 'steam_api',
        }

        const { error: upsertError } = await supabase
          .from('steam_wishlists')
          .upsert([row], { onConflict: 'game_id,date' })

        if (upsertError) {
          totalSkipped++
          errors.push(`${game.name} (${date}): ${upsertError.message}`)
        } else {
          gameImported++
          totalImported++
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`${game.name} (${date}): ${msg}`)
        totalSkipped++
      }
    }

    // Update store_page_live_date from app_min_date if we have one and the current
    // value is either empty or was previously auto-set. Manual overrides are preserved.
    if (earliestAppMinDate) {
      const meta = metaById.get(game.id)
      const shouldUpdate = !meta?.source || meta.source === 'auto'
      if (shouldUpdate && meta?.live !== earliestAppMinDate) {
        const { error: updErr } = await supabase
          .from('games')
          .update({
            store_page_live_date: earliestAppMinDate,
            store_page_live_date_source: 'auto',
          })
          .eq('id', game.id)
        if (updErr) {
          console.error(`[Wishlist Sync] Failed to update store_page_live_date for ${game.name}:`, updErr.message)
        }
      }
    }

    gameResults.push({
      game: game.name,
      imported: gameImported,
      error: errors.find(e => e.startsWith(game.name)),
    })
  }

  return {
    status: 200,
    body: {
      success: true,
      message: `Synced wishlist data for ${gamesToSync.length} game(s). ${totalImported} rows imported.`,
      totalImported,
      totalSkipped,
      dateRange: { from: datesToSync[0], to: datesToSync[datesToSync.length - 1] },
      hasMoreDates: truncatedDates,
      remainingDates: truncatedDates ? dates.length - MAX_DATES : 0,
      games: gameResults,
      errors: errors.length > 0 ? errors : undefined,
    },
  }
}
