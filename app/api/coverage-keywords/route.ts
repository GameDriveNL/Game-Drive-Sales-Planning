import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getSupabase() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing Supabase environment variables')
  }

  return createClient(supabaseUrl, supabaseKey)
}

// GET - Fetch keywords for a client/game
export async function GET(request: NextRequest) {
  try {
    const supabase = getSupabase()
    const { searchParams } = new URL(request.url)

    const clientId = searchParams.get('client_id')
    const gameId = searchParams.get('game_id')
    const keywordType = searchParams.get('keyword_type')
    // Q3: support fetching globally-scoped keywords (client_id IS NULL, game_id IS NULL)
    // for surfacing the default blacklist defaults
    const globalOnly = searchParams.get('global') === 'true'

    let query = supabase
      .from('coverage_keywords')
      .select('*')
      .order('keyword_type', { ascending: true })
      .order('keyword', { ascending: true })

    if (globalOnly) {
      query = query.is('client_id', null).is('game_id', null)
    } else {
      if (clientId) query = query.eq('client_id', clientId)
      if (gameId) query = query.eq('game_id', gameId)
    }
    if (keywordType) query = query.eq('keyword_type', keywordType)

    const { data, error } = await query

    if (error) {
      console.error('Error fetching keywords:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('Coverage keywords GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// POST - Create keyword(s)
export async function POST(request: NextRequest) {
  try {
    const supabase = getSupabase()
    const body = await request.json()

    // Handle bulk import (array of keywords)
    if (Array.isArray(body)) {
      const keywords = body
        .filter(item => item.keyword?.trim() && item.client_id && item.game_id)
        .map(item => ({
          client_id: item.client_id,
          game_id: item.game_id,
          keyword: item.keyword.trim(),
          keyword_type: item.keyword_type || 'whitelist'
        }))

      if (keywords.length === 0) {
        return NextResponse.json({ error: 'No valid keywords provided' }, { status: 400 })
      }

      const { data, error } = await supabase
        .from('coverage_keywords')
        .insert(keywords)
        .select()

      if (error) {
        console.error('Error bulk creating keywords:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      return NextResponse.json({ data, imported: keywords.length })
    }

    // Single keyword creation
    const { client_id, game_id, keyword, keyword_type } = body

    if (!client_id || !game_id || !keyword?.trim()) {
      return NextResponse.json({ error: 'client_id, game_id, and keyword are required' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('coverage_keywords')
      .insert([{
        client_id,
        game_id,
        keyword: keyword.trim(),
        keyword_type: keyword_type || 'whitelist'
      }])
      .select()
      .single()

    if (error) {
      console.error('Error creating keyword:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('Coverage keywords POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// PUT - Update a keyword
export async function PUT(request: NextRequest) {
  try {
    const supabase = getSupabase()
    const body = await request.json()
    const { id, keyword, keyword_type } = body

    if (!id) {
      return NextResponse.json({ error: 'Keyword ID is required' }, { status: 400 })
    }

    const updates: Record<string, unknown> = {}
    if (keyword !== undefined) updates.keyword = keyword.trim()
    if (keyword_type !== undefined) updates.keyword_type = keyword_type

    const { data, error } = await supabase
      .from('coverage_keywords')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      console.error('Error updating keyword:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('Coverage keywords PUT error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// DELETE - Delete a keyword
export async function DELETE(request: NextRequest) {
  try {
    const supabase = getSupabase()
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')

    if (!id) {
      return NextResponse.json({ error: 'Keyword ID is required' }, { status: 400 })
    }

    const { error } = await supabase
      .from('coverage_keywords')
      .delete()
      .eq('id', id)

    if (error) {
      console.error('Error deleting keyword:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Coverage keywords DELETE error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
