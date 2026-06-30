import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const supabase = getServerSupabase()
  const { searchParams } = new URL(request.url)
  const gameId = searchParams.get('game_id')
  const clientId = searchParams.get('client_id')

  let query = supabase
    .from('creator_watch')
    .select('*, game:games(id, name), client:clients(id, name)')
    .order('created_at', { ascending: false })

  if (gameId) query = query.eq('game_id', gameId)
  if (clientId) query = query.eq('client_id', clientId)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data || [])
}

export async function POST(request: NextRequest) {
  const supabase = getServerSupabase()
  const body = await request.json()
  const { channel_url, channel_name, channel_handle, game_id, client_id, days_lookback, notes, enabled } = body

  if (!channel_url || !channel_name) {
    return NextResponse.json({ error: 'channel_url and channel_name are required' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('creator_watch')
    .insert({
      channel_url: channel_url.trim(),
      channel_name: channel_name.trim(),
      channel_handle: channel_handle?.trim() || null,
      game_id: game_id || null,
      client_id: client_id || null,
      days_lookback: days_lookback || 30,
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

  const allowed = ['channel_url', 'channel_name', 'channel_handle', 'game_id', 'client_id', 'days_lookback', 'notes', 'enabled']
  const patch: Record<string, unknown> = {}
  for (const k of allowed) {
    if (k in updates) patch[k] = updates[k]
  }

  const { data, error } = await supabase
    .from('creator_watch')
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

  const { error } = await supabase.from('creator_watch').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
