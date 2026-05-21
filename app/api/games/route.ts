import { NextResponse } from 'next/server'
import { serverSupabase as supabase } from '@/lib/supabase'
import type { SupabaseClient } from '@supabase/supabase-js'

// Auto-enroll a game into all relevant scrapers and create default keyword
async function autoEnrollGameInScrapers(
  db: SupabaseClient,
  gameId: string,
  gameName: string,
  clientId: string
) {
  const sgSlug = gameName.replace(/\s+/g, '_')

  // B29 / recall boost: build a richer keyword set per game to catch coverage
  // that uses common name variants. Stephanie reports ~33% recall against
  // manual finding — much of that gap is keyword variants the scrapers never
  // try. We auto-generate: game name, no-space form, dash-slug, and (later
  // in this function) the client/studio name.
  const baseKeywords = new Set<string>([gameName])
  const noSpace = gameName.replace(/\s+/g, '')
  if (noSpace !== gameName) baseKeywords.add(noSpace)
  const slug = gameName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
  if (slug.length >= 4 && slug !== gameName.toLowerCase()) baseKeywords.add(slug)

  // Fetch client/studio name to add as a co-keyword
  const { data: clientRow } = await db
    .from('clients')
    .select('name')
    .eq('id', clientId)
    .single()
  const studioName = clientRow?.name
  if (studioName) baseKeywords.add(studioName)

  const searchKeywords = Array.from(baseKeywords)

  // Check which sources already exist for this game to avoid duplicates
  const { data: existingSources } = await db
    .from('coverage_sources')
    .select('source_type')
    .eq('game_id', gameId)

  const existingTypes = new Set((existingSources || []).map(s => s.source_type))

  const sourcesToCreate: Record<string, unknown>[] = []

  if (!existingTypes.has('sullygnome')) {
    sourcesToCreate.push({
      source_type: 'sullygnome',
      name: `SullyGnome – ${gameName}`,
      game_id: gameId,
      scan_frequency: 'weekly',
      is_active: true,
      config: { game_name: gameName, sullygnome_slug: sgSlug, default_time_range: '30d', min_avg_viewers: 10 },
    })
  }

  if (!existingTypes.has('youtube')) {
    sourcesToCreate.push({
      source_type: 'youtube',
      name: `YouTube – ${gameName}`,
      game_id: gameId,
      scan_frequency: 'daily',
      is_active: true,
      config: { keywords: searchKeywords, channel_name: '' },
    })
  }

  if (!existingTypes.has('reddit')) {
    sourcesToCreate.push({
      source_type: 'reddit',
      name: `Reddit – ${gameName}`,
      game_id: gameId,
      scan_frequency: 'daily',
      is_active: true,
      config: { subreddits: ['gaming', 'pcgaming', 'indiegaming'], keywords: searchKeywords, min_upvotes: 5 },
    })
  }

  if (!existingTypes.has('twitter')) {
    sourcesToCreate.push({
      source_type: 'twitter',
      name: `Twitter – ${gameName}`,
      game_id: gameId,
      scan_frequency: 'daily',
      is_active: true,
      config: { keywords: searchKeywords, handles: [], min_followers: 500 },
    })
  }

  if (!existingTypes.has('tiktok')) {
    sourcesToCreate.push({
      source_type: 'tiktok',
      name: `TikTok – ${gameName}`,
      game_id: gameId,
      scan_frequency: 'daily',
      is_active: true,
      config: { keywords: searchKeywords, hashtags: [gameName.replace(/\s+/g, '').toLowerCase()], profiles: [], min_followers: 500 },
    })
  }

  if (!existingTypes.has('instagram')) {
    sourcesToCreate.push({
      source_type: 'instagram',
      name: `Instagram – ${gameName}`,
      game_id: gameId,
      scan_frequency: 'daily',
      is_active: true,
      config: { keywords: searchKeywords, hashtags: [gameName.replace(/\s+/g, '').toLowerCase()], min_followers: 500 },
    })
  }

  // Recall boost: Tavily source — was previously missing from autoEnroll!
  if (!existingTypes.has('tavily')) {
    sourcesToCreate.push({
      source_type: 'tavily',
      name: `Tavily – ${gameName}`,
      game_id: gameId,
      scan_frequency: 'daily',
      is_active: true,
      config: { keywords: searchKeywords, max_queries: 4 },
    })
  }

  // Bulk insert sources
  if (sourcesToCreate.length > 0) {
    const { error: srcErr } = await db.from('coverage_sources').insert(sourcesToCreate)
    if (srcErr) console.error('Auto-enroll sources failed:', srcErr.message)
  }

  // Recall boost: write ALL keyword variants (not just the game name) to
  // coverage_keywords as whitelist entries. This ensures keyword-based
  // post-filtering across all scrapers accepts items mentioning any variant.
  for (const kw of searchKeywords) {
    const { data: existing } = await db
      .from('coverage_keywords')
      .select('id')
      .eq('game_id', gameId)
      .eq('keyword', kw)
      .eq('keyword_type', 'whitelist')
      .limit(1)
    if (!existing || existing.length === 0) {
      const { error: kwErr } = await db.from('coverage_keywords').insert({
        client_id: clientId,
        game_id: gameId,
        keyword: kw,
        keyword_type: 'whitelist',
      })
      if (kwErr) console.error(`Auto-create keyword "${kw}" failed:`, kwErr.message)
    }
  }

  console.log(`[Auto-enroll] Enrolled "${gameName}" in ${sourcesToCreate.length} scrapers with ${searchKeywords.length} keyword variants`)
}

// GET - Fetch all games with client info
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const clientId = searchParams.get('client_id')

    let query = supabase
      .from('games')
      .select('*, client:clients(id, name)')
      .order('name', { ascending: true })

    if (clientId) {
      query = query.eq('client_id', clientId)
    }

    const { data, error } = await query
    if (error) throw error

    return NextResponse.json(data || [])
  } catch (error) {
    console.error('Error fetching games:', error)
    return NextResponse.json({ error: 'Failed to fetch games' }, { status: 500 })
  }
}

// POST - Create a new game
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { name, client_id, steam_app_id, pr_tracking_enabled, pr_coverage_until } = body

    if (!name || !client_id) {
      return NextResponse.json(
        { error: 'Game name and client_id are required' },
        { status: 400 }
      )
    }

    const { data, error } = await supabase
      .from('games')
      .insert({
        name,
        client_id,
        steam_app_id: steam_app_id || null,
        pr_tracking_enabled: pr_tracking_enabled ?? false,
        pr_coverage_until: pr_coverage_until || null
      })
      .select('*, client:clients(id, name)')
      .single()

    if (error) throw error

    // Auto-enroll game in all scrapers when PR tracking is enabled
    if (data?.id && data?.name && data?.pr_tracking_enabled) {
      await autoEnrollGameInScrapers(supabase, data.id, data.name, data.client_id)
      // B25: fire retroactive Tavily backfill (~90 days) — fire-and-forget
      triggerRetroactiveBackfill(data.id).catch(err => console.error('B25 backfill trigger failed:', err))
    }

    return NextResponse.json(data)
  } catch (error) {
    console.error('Error creating game:', error)
    return NextResponse.json({ error: 'Failed to create game' }, { status: 500 })
  }
}

// B25: trigger a retroactive PR coverage backfill (90-day lookback)
// when a game is first enabled for PR tracking. Fires the existing
// /api/coverage-backfill endpoint asynchronously — don't block the caller.
async function triggerRetroactiveBackfill(gameId: string) {
  const base = process.env.NEXT_PUBLIC_APP_URL || 'https://platform.game-drive.nl'
  try {
    await fetch(`${base}/api/coverage-backfill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game_id: gameId, max_queries: 20 })
    })
  } catch (e) {
    console.error('B25 retroactive backfill failed to start:', e)
  }
}

// PUT - Update a game
export async function PUT(request: Request) {
  try {
    const body = await request.json()
    const { id, ...updates } = body

    if (!id) {
      return NextResponse.json({ error: 'Game id is required' }, { status: 400 })
    }

    // If the caller is setting store_page_live_date, treat it as a manual override
    // unless they explicitly passed a source (e.g. the cron sync writing 'auto').
    if (Object.prototype.hasOwnProperty.call(updates, 'store_page_live_date')
        && !Object.prototype.hasOwnProperty.call(updates, 'store_page_live_date_source')) {
      updates.store_page_live_date_source = 'manual'
    }

    const { data, error } = await supabase
      .from('games')
      .update(updates)
      .eq('id', id)
      .select('*, client:clients(id, name)')
      .single()

    if (error) throw error

    // Auto-enroll when PR tracking is toggled on
    if (data && updates.pr_tracking_enabled === true) {
      await autoEnrollGameInScrapers(supabase, data.id, data.name, data.client_id)
      // B25: also trigger retroactive backfill so the user immediately has
      // ~90 days of historical coverage rather than waiting for daily crons
      triggerRetroactiveBackfill(data.id).catch(err => console.error('B25 backfill trigger failed:', err))
    }

    // B22: when PR tracking is toggled OFF for a game, deactivate its
    // coverage_sources so scrapers stop polling for it — keeps cost and
    // noise down. Sources are reactivated on re-enable via autoEnroll.
    if (data && updates.pr_tracking_enabled === false) {
      await supabase
        .from('coverage_sources')
        .update({ is_active: false })
        .eq('game_id', data.id)
    }

    return NextResponse.json(data)
  } catch (error) {
    console.error('Error updating game:', error)
    return NextResponse.json({ error: 'Failed to update game' }, { status: 500 })
  }
}

// DELETE - Delete a game (cascades to products, sales, coverage)
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')

    if (!id) {
      return NextResponse.json({ error: 'Game id is required' }, { status: 400 })
    }

    const { error } = await supabase
      .from('games')
      .delete()
      .eq('id', id)

    if (error) throw error

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error deleting game:', error)
    return NextResponse.json({ error: 'Failed to delete game' }, { status: 500 })
  }
}
