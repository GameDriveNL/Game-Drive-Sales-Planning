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

// GET - List PR annotations with filters
export async function GET(request: NextRequest) {
  try {
    const supabase = getSupabase()
    const { searchParams } = new URL(request.url)

    const gameId = searchParams.get('game_id')
    const clientId = searchParams.get('client_id')
    const eventType = searchParams.get('event_type')
    const dateFrom = searchParams.get('date_from')
    const dateTo = searchParams.get('date_to')
    const confidence = searchParams.get('confidence')
    const limit = parseInt(searchParams.get('limit') || '100')
    const offset = parseInt(searchParams.get('offset') || '0')

    let query = supabase
      .from('pr_annotations')
      .select('*, game:games(id, name), client:clients(id, name)', { count: 'exact' })
      .order('event_date', { ascending: false })
      .range(offset, offset + limit - 1)

    if (gameId) query = query.eq('game_id', gameId)
    if (clientId) query = query.eq('client_id', clientId)
    if (eventType) query = query.eq('event_type', eventType)
    if (dateFrom) query = query.gte('event_date', dateFrom)
    if (dateTo) query = query.lte('event_date', dateTo)
    if (confidence) query = query.eq('confidence', confidence)

    const { data, error, count } = await query

    if (error) {
      console.error('Error fetching pr_annotations:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data, count })
  } catch (err) {
    console.error('PR annotations GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// POST - Create a PR annotation
export async function POST(request: NextRequest) {
  try {
    const supabase = getSupabase()
    const body = await request.json()

    const requiredFields = ['game_id', 'client_id', 'event_type', 'event_date', 'observed_effect', 'direction', 'confidence']
    for (const field of requiredFields) {
      if (!body[field]) {
        return NextResponse.json({ error: `${field} is required` }, { status: 400 })
      }
    }

    const record: Record<string, unknown> = {
      game_id: body.game_id,
      client_id: body.client_id,
      event_type: body.event_type,
      event_date: body.event_date,
      observed_effect: body.observed_effect,
      direction: body.direction,
      confidence: body.confidence,
      outlet_or_source: body.outlet_or_source || null,
      coverage_item_id: body.coverage_item_id || null,
      notes: body.notes || null,
      is_auto_detected: body.is_auto_detected || false,
      metrics_snapshot: body.metrics_snapshot || null,
    }

    const { data, error } = await supabase
      .from('pr_annotations')
      .insert([record])
      .select('*, game:games(id, name), client:clients(id, name)')
      .single()

    if (error) {
      console.error('Error creating pr_annotation:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('PR annotations POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// PUT - Update a PR annotation
export async function PUT(request: NextRequest) {
  try {
    const supabase = getSupabase()
    const body = await request.json()

    const { id, ...updates } = body
    if (!id) {
      return NextResponse.json({ error: 'Annotation ID is required' }, { status: 400 })
    }

    const allowedFields = [
      'event_type', 'event_date', 'observed_effect', 'direction', 'confidence',
      'outlet_or_source', 'coverage_item_id', 'notes', 'is_auto_detected', 'metrics_snapshot',
      'game_id', 'client_id'
    ]

    const cleanUpdates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        cleanUpdates[field] = updates[field]
      }
    }

    const { data, error } = await supabase
      .from('pr_annotations')
      .update(cleanUpdates)
      .eq('id', id)
      .select('*, game:games(id, name), client:clients(id, name)')
      .single()

    if (error) {
      console.error('Error updating pr_annotation:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('PR annotations PUT error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// DELETE - Delete annotation(s) by id or bulk_ids
export async function DELETE(request: NextRequest) {
  try {
    const supabase = getSupabase()
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')

    // Bulk delete via request body
    if (!id) {
      try {
        const body = await request.json()
        if (body.bulk_ids && Array.isArray(body.bulk_ids) && body.bulk_ids.length > 0) {
          const { error } = await supabase
            .from('pr_annotations')
            .delete()
            .in('id', body.bulk_ids)

          if (error) {
            console.error('Error bulk deleting pr_annotations:', error)
            return NextResponse.json({ error: error.message }, { status: 500 })
          }

          return NextResponse.json({ success: true, deleted: body.bulk_ids.length })
        }
      } catch {
        // No body or invalid JSON — fall through to error
      }
      return NextResponse.json({ error: 'Annotation ID or bulk_ids required' }, { status: 400 })
    }

    // Single delete via query param
    const { error } = await supabase
      .from('pr_annotations')
      .delete()
      .eq('id', id)

    if (error) {
      console.error('Error deleting pr_annotation:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('PR annotations DELETE error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
