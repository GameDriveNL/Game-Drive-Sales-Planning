import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'

const STEAM_PARTNER_API = 'https://partner.steam-api.com'

interface WishlistReportResponse {
  response: {
    appid: number
    date: string
    wishlist_summary: {
      wishlist_adds: number
      wishlist_deletes: number
      wishlist_purchases: number
      wishlist_gifts: number
      wishlist_adds_windows: number
      wishlist_adds_mac: number
      wishlist_adds_linux: number
    }
    country_summary?: Array<{
      country_code: string
      country_name: string
      region: string
      summary_actions: {
        wishlist_adds: number
        wishlist_deletes: number
        wishlist_purchases: number
        wishlist_gifts: number
      }
    }>
    time_generated?: string
    app_min_date?: string
  }
}

// POST /api/cron/steam-wishlist-sync — Sync wishlist data from Steam Partner API
export async function POST(request: NextRequest) {
  const supabase = getServerSupabase()

  try {
    const body = await request.json()
    const { client_id, game_id, date_from, date_to } = body

    if (!client_id) {
      return NextResponse.json({ error: 'client_id is required' }, { status: 400 })
    }

    // Get the client's Steam Financial API key
    const { data: keyData, error: keyError } = await supabase
      .from('steam_api_keys')
      .select('api_key, publisher_key')
      .eq('client_id', client_id)
      .eq('is_active', true)
      .single()

    if (keyError || !keyData) {
      return NextResponse.json({
        error: 'No active Steam API key found for this client. Configure one in Settings > Steam API.',
      }, { status: 404 })
    }

    const apiKey = keyData.publisher_key || keyData.api_key
    if (!apiKey) {
      return NextResponse.json({
        error: 'No Financial Web API Key configured. This is needed for wishlist data.',
      }, { status: 400 })
    }

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
      return NextResponse.json({
        error: 'No games with Steam App ID found. Add a Steam App ID to your games first.',
      }, { status: 400 })
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

    for (const game of gamesToSync) {
      let gameImported = 0

      for (const date of datesToSync) {
        try {
          const url = `${STEAM_PARTNER_API}/IPartnerFinancialsService/GetAppWishlistReporting/v001/?key=${apiKey}&date=${date}&appid=${game.steam_app_id}`

          const response = await fetch(url)

          if (!response.ok) {
            if (response.status === 403) {
              errors.push(`${game.name}: Access denied (403). Financial API key may not have wishlist access.`)
              break // No point trying more dates for this game
            }
            // Skip individual date errors silently (e.g. no data for that date)
            continue
          }

          const data: WishlistReportResponse = await response.json()
          const summary = data.response?.wishlist_summary

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

      gameResults.push({
        game: game.name,
        imported: gameImported,
        error: errors.find(e => e.startsWith(game.name)),
      })
    }

    return NextResponse.json({
      success: true,
      message: `Synced wishlist data for ${gamesToSync.length} game(s). ${totalImported} rows imported.`,
      totalImported,
      totalSkipped,
      dateRange: { from: datesToSync[0], to: datesToSync[datesToSync.length - 1] },
      hasMoreDates: truncatedDates,
      remainingDates: truncatedDates ? dates.length - MAX_DATES : 0,
      games: gameResults,
      errors: errors.length > 0 ? errors : undefined,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[Steam Wishlist Sync] Error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// GET — Test if wishlist API is accessible for a client
export async function GET(request: NextRequest) {
  const supabase = getServerSupabase()
  const { searchParams } = new URL(request.url)
  const clientId = searchParams.get('client_id')

  if (!clientId) {
    return NextResponse.json({ error: 'client_id required' }, { status: 400 })
  }

  try {
    const { data: keyData } = await supabase
      .from('steam_api_keys')
      .select('api_key, publisher_key')
      .eq('client_id', clientId)
      .eq('is_active', true)
      .single()

    if (!keyData) {
      return NextResponse.json({ available: false, reason: 'No Steam API key configured' })
    }

    const apiKey = keyData.publisher_key || keyData.api_key
    if (!apiKey) {
      return NextResponse.json({ available: false, reason: 'No Financial Web API Key configured' })
    }

    // Get a game with steam_app_id to test
    const { data: games } = await supabase
      .from('games')
      .select('steam_app_id')
      .eq('client_id', clientId)
      .not('steam_app_id', 'is', null)
      .limit(1)

    if (!games || games.length === 0) {
      return NextResponse.json({ available: false, reason: 'No games with Steam App ID found' })
    }

    // Test the endpoint with yesterday's date
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const testDate = yesterday.toISOString().split('T')[0]

    const url = `${STEAM_PARTNER_API}/IPartnerFinancialsService/GetAppWishlistReporting/v001/?key=${apiKey}&date=${testDate}&appid=${games[0].steam_app_id}`
    const response = await fetch(url)

    if (response.ok) {
      return NextResponse.json({ available: true, message: 'Wishlist API is accessible' })
    } else if (response.status === 403) {
      return NextResponse.json({ available: false, reason: 'API key does not have access to wishlist reporting (403)' })
    } else {
      return NextResponse.json({ available: false, reason: `Steam API returned status ${response.status}` })
    }
  } catch (err) {
    return NextResponse.json({ available: false, reason: err instanceof Error ? err.message : 'Unknown error' })
  }
}
