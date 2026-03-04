import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Create supabase client lazily inside handlers to avoid build-time errors
function getSupabase() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing Supabase environment variables')
  }
  
  return createClient(supabaseUrl, supabaseKey)
}

// GET - Fetch all platform events (optionally filtered by date range)
export async function GET(request: NextRequest) {
  try {
    const supabase = getSupabase()
    const { searchParams } = new URL(request.url)
    const startDate = searchParams.get('start_date')
    const endDate = searchParams.get('end_date')
    const platformId = searchParams.get('platform_id')
    
    let query = supabase
      .from('platform_events')
      .select(`
        *,
        platform:platforms(*)
      `)
      .order('start_date', { ascending: false })
    
    // Filter by date range if provided
    if (startDate) {
      query = query.gte('end_date', startDate)
    }
    if (endDate) {
      query = query.lte('start_date', endDate)
    }
    if (platformId) {
      query = query.eq('platform_id', platformId)
    }
    
    const { data, error } = await query
    
    if (error) {
      console.error('Error fetching platform events:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    
    return NextResponse.json(data)
  } catch (err) {
    console.error('Platform events GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// POST - Create a new platform event
export async function POST(request: NextRequest) {
  try {
    const supabase = getSupabase()
    const body = await request.json()
    
    const { data, error } = await supabase
      .from('platform_events')
      .insert([{
        platform_id: body.platform_id,
        name: body.name,
        start_date: body.start_date,
        end_date: body.end_date,
        event_type: body.event_type || 'seasonal',
        region: body.region || null,
        requires_cooldown: body.requires_cooldown ?? true,
        is_recurring: body.is_recurring ?? false,
        notes: body.notes || null
      }])
      .select(`
        *,
        platform:platforms(*)
      `)
      .single()
    
    if (error) {
      console.error('Error creating platform event:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    
    return NextResponse.json(data, { status: 201 })
  } catch (err) {
    console.error('Platform events POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// PUT - Update a platform event
export async function PUT(request: NextRequest) {
  try {
    const supabase = getSupabase()
    const body = await request.json()
    const { id, ...updates } = body
    
    if (!id) {
      return NextResponse.json({ error: 'Event ID is required' }, { status: 400 })
    }
    
    const { data, error } = await supabase
      .from('platform_events')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select(`
        *,
        platform:platforms(*)
      `)
      .single()
    
    if (error) {
      console.error('Error updating platform event:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    
    return NextResponse.json(data)
  } catch (err) {
    console.error('Platform events PUT error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// DELETE - Delete a platform event
export async function DELETE(request: NextRequest) {
  try {
    const supabase = getSupabase()
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    
    if (!id) {
      return NextResponse.json({ error: 'Event ID is required' }, { status: 400 })
    }
    
    const { error } = await supabase
      .from('platform_events')
      .delete()
      .eq('id', id)
    
    if (error) {
      console.error('Error deleting platform event:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Platform events DELETE error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
