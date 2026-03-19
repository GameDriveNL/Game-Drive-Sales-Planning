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
      config: { keywords: [gameName], channel_name: '' },
    })
  }

  if (!existingTypes.has('reddit')) {
    sourcesToCreate.push({
      source_type: 'reddit',
      name: `Reddit – ${gameName}`,
      game_id: gameId,
      scan_frequency: 'daily',
      is_active: true,
      config: { subreddits: ['gaming', 'pcgaming', 'indiegaming'], keywords: [gameName], min_upvotes: 5 },
    })
  }

  if (!existingTypes.has('twitter')) {
    sourcesToCreate.push({
      source_type: 'twitter',
      name: `Twitter – ${gameName}`,
      game_id: gameId,
      scan_frequency: 'daily',
      is_active: true,
      config: { keywords: [gameName], handles: [], min_followers: 500 },
    })
  }

  if (!existingTypes.has('tiktok')) {
    sourcesToCreate.push({
      source_type: 'tiktok',
      name: `TikTok – ${gameName}`,
      game_id: gameId,
      scan_frequency: 'daily',
      is_active: true,
      config: { keywords: [gameName], hashtags: [gameName.replace(/\s+/g, '').toLowerCase()], profiles: [], min_followers: 500 },
    })
  }

  if (!existingTypes.has('instagram')) {
    sourcesToCreate.push({
      source_type: 'instagram',
      name: `Instagram – ${gameName}`,
      game_id: gameId,
      scan_frequency: 'daily',
      is_active: true,
      config: { keywords: [gameName], hashtags: [gameName.replace(/\s+/g, '').toLowerCase()], min_followers: 500 },
    })
  }

  // Bulk insert sources
  if (sourcesToCreate.length > 0) {
    const { error: srcErr } = await db.from('coverage_sources').insert(sourcesToCreate)
    if (srcErr) console.error('Auto-enroll sources failed:', srcErr.message)
  }

  // Auto-create default whitelist keyword for the game name
  const { data: existingKw } = await db
    .from('coverage_keywords')
    .select('id')
    .eq('game_id', gameId)
    .eq('keyword', gameName)
    .eq('keyword_type', 'whitelist')
    .limit(1)

  if (!existingKw || existingKw.length === 0) {
    const { error: kwErr } = await db
      .from('coverage_keywords')
      .insert({
        client_id: clientId,
        game_id: gameId,
        keyword: gameName,
        keyword_type: 'whitelist',
      })
    if (kwErr) console.error('Auto-create keyword failed:', kwErr.message)
  }

  console.log(`[Auto-enroll] Enrolled "${gameName}" in ${sourcesToCreate.length} scrapers`)
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
    const { name, client_id, steam_app_id, pr_tracking_enabled } = body

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
        pr_tracking_enabled: pr_tracking_enabled ?? false
      })
      .select('*, client:clients(id, name)')
      .single()

    if (error) throw error

    // Auto-enroll game in all scrapers when PR tracking is enabled
    if (data?.id && data?.name && data?.pr_tracking_enabled) {
      await autoEnrollGameInScrapers(supabase, data.id, data.name, data.client_id)
    }

    return NextResponse.json(data)
  } catch (error) {
    console.error('Error creating game:', error)
    return NextResponse.json({ error: 'Failed to create game' }, { status: 500 })
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
