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

// Tier auto-suggestion based on traffic thresholds
function suggestTier(monthlyVisitors: number | null): string | null {
  if (!monthlyVisitors) return null
  if (monthlyVisitors >= 10_000_000) return 'A'
  if (monthlyVisitors >= 1_000_000) return 'B'
  if (monthlyVisitors >= 100_000) return 'C'
  return 'D'
}

// GET - Fetch all outlets with search/filter/sort
export async function GET(request: NextRequest) {
  try {
    const supabase = getSupabase()
    const { searchParams } = new URL(request.url)

    const search = searchParams.get('search') || ''
    const tier = searchParams.get('tier') || ''
    const country = searchParams.get('country') || ''
    const metacritic = searchParams.get('metacritic') || ''
    const sortBy = searchParams.get('sortBy') || 'monthly_unique_visitors'
    const sortDir = searchParams.get('sortDir') || 'desc'
    const limit = parseInt(searchParams.get('limit') || '100')
    const offset = parseInt(searchParams.get('offset') || '0')

    let query = supabase
      .from('outlets')
      .select('*', { count: 'exact' })

    if (search) {
      query = query.or(`name.ilike.%${search}%,domain.ilike.%${search}%`)
    }
    if (tier) {
      query = query.eq('tier', tier)
    }
    if (country) {
      query = query.ilike('country', `%${country}%`)
    }
    if (metacritic === 'true') {
      query = query.eq('metacritic_status', true)
    } else if (metacritic === 'false') {
      query = query.eq('metacritic_status', false)
    }

    const ascending = sortDir === 'asc'
    query = query.order(sortBy, { ascending, nullsFirst: false })
    query = query.range(offset, offset + limit - 1)

    const { data, error, count } = await query

    if (error) {
      console.error('Error fetching outlets:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data, count })
  } catch (err) {
    console.error('Outlets GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// POST - Create a new outlet
export async function POST(request: NextRequest) {
  try {
    const supabase = getSupabase()
    const body = await request.json()

    // Handle bulk import
    if (Array.isArray(body)) {
      const outlets = body.map(item => ({
        name: item.name?.trim(),
        domain: item.domain?.trim() || null,
        country: item.country?.trim() || null,
        monthly_unique_visitors: item.monthly_unique_visitors ? parseInt(item.monthly_unique_visitors) : null,
        tier: item.tier || suggestTier(item.monthly_unique_visitors ? parseInt(item.monthly_unique_visitors) : null),
        metacritic_status: item.metacritic_status === true || item.metacritic_status === 'true',
        custom_tags: item.custom_tags || [],
        rss_feed_url: item.rss_feed_url?.trim() || null,
        scan_frequency: item.scan_frequency || 'daily',
        is_active: true
      })).filter(o => o.name)

      const { data, error } = await supabase
        .from('outlets')
        .upsert(outlets, { onConflict: 'domain', ignoreDuplicates: true })
        .select()

      if (error) {
        console.error('Error bulk creating outlets:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      return NextResponse.json({ data, imported: outlets.length })
    }

    // Single outlet creation
    const { name, domain, country, monthly_unique_visitors, tier, metacritic_status, custom_tags, rss_feed_url, scan_frequency } = body

    if (!name || typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'Outlet name is required' }, { status: 400 })
    }

    const autoTier = tier || suggestTier(monthly_unique_visitors || null)

    const { data, error } = await supabase
      .from('outlets')
      .insert([{
        name: name.trim(),
        domain: domain?.trim() || null,
        country: country?.trim() || null,
        monthly_unique_visitors: monthly_unique_visitors || null,
        tier: autoTier,
        metacritic_status: metacritic_status || false,
        custom_tags: custom_tags || [],
        rss_feed_url: rss_feed_url?.trim() || null,
        scan_frequency: scan_frequency || 'daily',
        is_active: true
      }])
      .select()
      .single()

    if (error) {
      console.error('Error creating outlet:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('Outlets POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// PUT - Update an outlet
export async function PUT(request: NextRequest) {
  try {
    const supabase = getSupabase()
    const body = await request.json()
    const { id, ...updates } = body

    if (!id) {
      return NextResponse.json({ error: 'Outlet ID is required' }, { status: 400 })
    }

    const allowedFields = [
      'name', 'domain', 'country', 'monthly_unique_visitors', 'tier',
      'metacritic_status', 'custom_tags', 'rss_feed_url', 'scan_frequency', 'is_active',
      'is_blacklisted'
    ]

    const filteredUpdates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    for (const field of allowedFields) {
      if (field in updates) {
        filteredUpdates[field] = updates[field]
      }
    }

    // Auto-suggest tier if traffic changed and tier not explicitly set
    if ('monthly_unique_visitors' in updates && !('tier' in updates)) {
      filteredUpdates.tier = suggestTier(updates.monthly_unique_visitors)
    }

    const { data, error } = await supabase
      .from('outlets')
      .update(filteredUpdates)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      console.error('Error updating outlet:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('Outlets PUT error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// DELETE - Delete an outlet
export async function DELETE(request: NextRequest) {
  try {
    const supabase = getSupabase()
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')

    if (!id) {
      return NextResponse.json({ error: 'Outlet ID is required' }, { status: 400 })
    }

    const { error } = await supabase
      .from('outlets')
      .delete()
      .eq('id', id)

    if (error) {
      console.error('Error deleting outlet:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Outlets DELETE error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
