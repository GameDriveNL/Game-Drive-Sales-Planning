import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const supabase = getServerSupabase()
  const { searchParams } = new URL(request.url)
  const clientId = searchParams.get('client_id')
  const year = parseInt(searchParams.get('year') || String(new Date().getFullYear()))

  if (!clientId) {
    return NextResponse.json({ error: 'client_id is required' }, { status: 400 })
  }

  const yearStart = `${year}-01-01`
  const yearEnd = `${year}-12-31`

  const { data, error } = await supabase
    .from('planning_items')
    .select('*')
    .eq('client_id', clientId)
    .or(`start_date.lte.${yearEnd},end_date.gte.${yearStart}`)
    .order('category')
    .order('start_date')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data || [])
}

export async function POST(request: NextRequest) {
  const supabase = getServerSupabase()
  const body = await request.json()
  const { client_id, title, category, start_date, end_date, color, notes } = body

  if (!client_id || !title || !start_date) {
    return NextResponse.json({ error: 'client_id, title, and start_date are required' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('planning_items')
    .insert({ client_id, title: title.trim(), category: category || 'general', start_date, end_date: end_date || start_date, color: color || null, notes: notes?.trim() || null })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function PUT(request: NextRequest) {
  const supabase = getServerSupabase()
  const body = await request.json()
  const { id, title, category, start_date, end_date, color, notes } = body

  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (title !== undefined) update.title = title.trim()
  if (category !== undefined) update.category = category
  if (start_date !== undefined) update.start_date = start_date
  if (end_date !== undefined) update.end_date = end_date || start_date
  if (color !== undefined) update.color = color || null
  if (notes !== undefined) update.notes = notes?.trim() || null

  const { data, error } = await supabase
    .from('planning_items')
    .update(update)
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

  const { error } = await supabase.from('planning_items').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
