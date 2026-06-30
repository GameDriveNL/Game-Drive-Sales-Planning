import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const supabase = getServerSupabase()
  const { searchParams } = new URL(request.url)
  const clientId = searchParams.get('client_id')
  const ownGameId = searchParams.get('own_game_id')

  let query = supabase
    .from('competitor_games')
    .select('*, own_game:games(id, name)')
    .order('created_at', { ascending: false })

  if (clientId) query = query.eq('client_id', clientId)
  if (ownGameId) query = query.eq('own_game_id', ownGameId)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data || [])
}

export async function POST(request: NextRequest) {
  const supabase = getServerSupabase()
  const body = await request.json()
  const { client_id, own_game_id, name, studio, platforms, steam_url, notes, enabled } = body

  if (!client_id || !name) {
    return NextResponse.json({ error: 'client_id and name are required' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('competitor_games')
    .insert({
      client_id,
      own_game_id: own_game_id || null,
      name: name.trim(),
      studio: studio?.trim() || null,
      platforms: platforms || null,
      steam_url: steam_url?.trim() || null,
      notes: notes?.trim() || null,
      enabled: enabled !== false,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}

export async function PUT(request: NextRequest) {
  const supabase = getServerSupabase()
  const body = await request.json()
  const { id, ...updates } = body

  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const allowed = ['own_game_id', 'name', 'studio', 'platforms', 'steam_url', 'notes', 'enabled']
  const patch: Record<string, unknown> = {}
  for (const k of allowed) {
    if (k in updates) patch[k] = updates[k]
  }

  const { data, error } = await supabase
    .from('competitor_games')
    .update(patch)
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function DELETE(request: NextRequest) {
  const supabase = getServerSupabase()
  const { searchParams } = new URL(request.url)
  const id = searchParams.get('id')

  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const { error } = await supabase.from('competitor_games').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
