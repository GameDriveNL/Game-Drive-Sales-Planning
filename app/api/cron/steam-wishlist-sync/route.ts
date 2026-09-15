import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { runWishlistSync, resolveAgencyApiKey } from '@/lib/steam-wishlist-sync'

const STEAM_PARTNER_API = 'https://partner.steam-api.com'

// POST /api/cron/steam-wishlist-sync — Sync wishlist data from Steam Partner API
// for one client (manual "Sync from Steam API" button on the Wishlists page).
export async function POST(request: NextRequest) {
  const supabase = getServerSupabase()

  try {
    const body = await request.json()
    const { client_id, game_id, date_from, date_to } = body

    if (!client_id) {
      return NextResponse.json({ error: 'client_id is required' }, { status: 400 })
    }

    const result = await runWishlistSync(supabase, { client_id, game_id, date_from, date_to })
    return NextResponse.json(result.body, { status: result.status })
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

    const agencyApiKey = await resolveAgencyApiKey(supabase)
    let apiKey = (keyData && (keyData.publisher_key || keyData.api_key)) || agencyApiKey
    if (!apiKey) {
      return NextResponse.json({ available: false, reason: 'No Financial Web API Key configured, and no Game Drive agency key available as a fallback' })
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

    const testUrl = (key: string) =>
      `${STEAM_PARTNER_API}/IPartnerFinancialsService/GetAppWishlistReporting/v001/?key=${key}&date=${testDate}&appid=${games[0].steam_app_id}`
    let response = await fetch(testUrl(apiKey))

    if (response.status === 403 && agencyApiKey && apiKey !== agencyApiKey) {
      apiKey = agencyApiKey
      response = await fetch(testUrl(apiKey))
    }

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
