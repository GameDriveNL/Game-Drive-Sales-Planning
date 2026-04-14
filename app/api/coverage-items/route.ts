import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { classifyCoverageType } from '@/lib/coverage-utils'

function getSupabase() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing Supabase environment variables')
  }

  return createClient(supabaseUrl, supabaseKey)
}

// GET - Fetch coverage items with filters, sorting, pagination
export async function GET(request: NextRequest) {
  try {
    const supabase = getSupabase()
    const { searchParams } = new URL(request.url)

    const clientId = searchParams.get('client_id')
    const gameId = searchParams.get('game_id')
    const outletId = searchParams.get('outlet_id')
    const campaignId = searchParams.get('campaign_id')
    const coverageType = searchParams.get('coverage_type')
    const sentiment = searchParams.get('sentiment')
    const approvalStatus = searchParams.get('approval_status')
    const sourceType = searchParams.get('source_type')
    const territory = searchParams.get('territory')
    const tier = searchParams.get('tier')
    const isAiGenerated = searchParams.get('is_ai_generated')
    const search = searchParams.get('search')
    const dateFrom = searchParams.get('date_from')
    const dateTo = searchParams.get('date_to')
    const sortBy = searchParams.get('sort_by') || 'monthly_unique_visitors'
    const sortDir = (searchParams.get('sort_dir') || 'desc') as 'asc' | 'desc'
    const limit = parseInt(searchParams.get('limit') || '100')
    const offset = parseInt(searchParams.get('offset') || '0')

    let query = supabase
      .from('coverage_items')
      .select('*, outlet:outlets(id, name, domain, tier, monthly_unique_visitors), game:games(id, name), client:clients(id, name), campaign:coverage_campaigns(id, name)', { count: 'exact' })
      .order(sortBy, { ascending: sortDir === 'asc' })
      .range(offset, offset + limit - 1)

    if (clientId) query = query.eq('client_id', clientId)
    if (gameId) {
      // Also catch items scraped via keyword that weren't linked to a game_id —
      // fetch the game name and match on title as a fallback
      const { data: gameRow } = await supabase.from('games').select('name').eq('id', gameId).single()
      if (gameRow?.name) {
        const escapedName = gameRow.name.replace(/[%_]/g, '\\$&')
        query = query.or(`game_id.eq.${gameId},and(game_id.is.null,title.ilike.%${escapedName}%)`)
      } else {
        query = query.eq('game_id', gameId)
      }
    }
    if (outletId) query = query.eq('outlet_id', outletId)
    if (campaignId) query = query.eq('campaign_id', campaignId)
    if (coverageType) query = query.eq('coverage_type', coverageType)
    if (sentiment) query = query.eq('sentiment', sentiment)
    if (approvalStatus) query = query.eq('approval_status', approvalStatus)
    if (sourceType) query = query.eq('source_type', sourceType)
    if (territory) query = query.eq('territory', territory)
    if (isAiGenerated === 'true') query = query.eq('is_ai_generated', true)
    else if (isAiGenerated === 'false') query = query.or('is_ai_generated.is.null,is_ai_generated.eq.false')
    if (search) query = query.ilike('title', `%${search}%`)
    if (dateFrom) query = query.gte('publish_date', dateFrom)
    if (dateTo) query = query.lte('publish_date', dateTo)
    if (tier) query = query.not('outlet_id', 'is', null)

    // Hide duplicates: only show originals (collapse syndications)
    const hideDuplicates = searchParams.get('hide_duplicates') === 'true'
    if (hideDuplicates) {
      query = query.or('is_original.eq.true,duplicate_group_id.is.null')
    }

    const { data, error, count } = await query

    if (error) {
      console.error('Error fetching coverage items:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Filter by tier client-side since it's a joined field
    let filtered = data || []
    if (tier) {
      filtered = filtered.filter((item: Record<string, unknown>) => {
        const outlet = item.outlet as { tier?: string } | null
        return outlet?.tier === tier
      })
    }

    // Apply keyword blacklist filtering
    // Fetch blacklist keywords for the client/game and hide matching items
    const applyBlacklist = searchParams.get('apply_blacklist') !== 'false' // default: on
    if (applyBlacklist && filtered.length > 0) {
      let blQuery = supabase
        .from('coverage_keywords')
        .select('keyword, game_id')
        .eq('keyword_type', 'blacklist')

      if (clientId) blQuery = blQuery.eq('client_id', clientId)

      const { data: blKeywords } = await blQuery
      if (blKeywords && blKeywords.length > 0) {
        const blacklistTerms = blKeywords.map(k => ({
          term: k.keyword.toLowerCase(),
          gameId: k.game_id,
        }))

        filtered = filtered.filter((item: Record<string, unknown>) => {
          const title = String(item.title || '').toLowerCase()
          const itemGameId = item.game_id as string | null
          for (const bl of blacklistTerms) {
            // If blacklist keyword is game-scoped, only apply to that game's items
            if (bl.gameId && bl.gameId !== itemGameId) continue
            if (title.includes(bl.term)) return false
          }
          return true
        })
      }
    }

    // For each item with a duplicate_group_id, count syndications
    const groupIds = new Set<string>()
    for (const item of filtered) {
      const i = item as Record<string, unknown>
      if (i.duplicate_group_id) groupIds.add(String(i.duplicate_group_id))
    }

    let syndicationCounts: Record<string, number> = {}
    if (groupIds.size > 0) {
      const { data: countData } = await supabase
        .from('coverage_items')
        .select('duplicate_group_id')
        .in('duplicate_group_id', Array.from(groupIds))

      if (countData) {
        for (const row of countData) {
          const gid = String((row as Record<string, unknown>).duplicate_group_id)
          syndicationCounts[gid] = (syndicationCounts[gid] || 0) + 1
        }
      }
    }

    // Attach syndication_count to each item
    const enriched = filtered.map((item: Record<string, unknown>) => {
      const gid = item.duplicate_group_id ? String(item.duplicate_group_id) : null
      return {
        ...item,
        syndication_count: gid ? (syndicationCounts[gid] || 1) : 1,
      }
    })

    return NextResponse.json({ data: enriched, count: tier ? filtered.length : count })
  } catch (err) {
    console.error('Coverage items GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// POST - Create coverage item(s)
export async function POST(request: NextRequest) {
  try {
    const supabase = getSupabase()
    const body = await request.json()

    if (Array.isArray(body)) {
      const items = body
        .filter(item => item.title?.trim() && item.url?.trim())
        .map(item => ({
          client_id: item.client_id || null,
          game_id: item.game_id || null,
          outlet_id: item.outlet_id || null,
          campaign_id: item.campaign_id || null,
          title: item.title.trim(),
          url: item.url.trim(),
          publish_date: item.publish_date || null,
          territory: item.territory || null,
          coverage_type: classifyCoverageType(item.coverage_type, item.url.trim()),
          monthly_unique_visitors: item.monthly_unique_visitors || null,
          review_score: item.review_score || null,
          quotes: item.quotes || null,
          sentiment: item.sentiment || null,
          relevance_score: item.relevance_score || null,
          relevance_reasoning: item.relevance_reasoning || null,
          approval_status: item.approval_status || 'pending_review',
          source_type: item.source_type || 'manual',
          source_metadata: item.source_metadata || {},
          campaign_section: item.campaign_section || null
        }))

      if (items.length === 0) {
        return NextResponse.json({ error: 'No valid items provided' }, { status: 400 })
      }

      const { data, error } = await supabase
        .from('coverage_items')
        .insert(items)
        .select()

      if (error) {
        console.error('Error bulk creating coverage items:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      return NextResponse.json({ data, imported: items.length })
    }

    // Single item
    const { title, url, outlet_name, ...rest } = body
    if (!title?.trim() || !url?.trim()) {
      return NextResponse.json({ error: 'title and url are required' }, { status: 400 })
    }

    // Resolve outlet by name if outlet_name provided and no outlet_id
    if (outlet_name && !rest.outlet_id) {
      // Try to find existing outlet by name (case-insensitive)
      const { data: existingOutlet } = await supabase
        .from('outlets')
        .select('id')
        .ilike('name', outlet_name.trim())
        .limit(1)
        .single()

      if (existingOutlet) {
        rest.outlet_id = existingOutlet.id
      } else {
        // Extract domain from URL for the new outlet
        let domain: string | null = null
        try { domain = new URL(url.trim()).hostname.replace(/^www\./, '') } catch { /* ignore */ }

        const { data: newOutlet } = await supabase
          .from('outlets')
          .insert([{ name: outlet_name.trim(), domain, country: rest.territory || null }])
          .select('id')
          .single()

        if (newOutlet) rest.outlet_id = newOutlet.id
      }
    }

    // Auto-classify informational URLs (Wikipedia, Steam Store, SteamDB, etc.)
    if (!rest.coverage_type || rest.coverage_type === 'news') {
      rest.coverage_type = classifyCoverageType(rest.coverage_type, url.trim())
    }

    const { data, error } = await supabase
      .from('coverage_items')
      .insert([{ title: title.trim(), url: url.trim(), ...rest }])
      .select('*, outlet:outlets(id, name, domain, tier, monthly_unique_visitors), game:games(id, name), client:clients(id, name), campaign:coverage_campaigns(id, name)')
      .single()

    if (error) {
      console.error('Error creating coverage item:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('Coverage items POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// PUT - Update a coverage item (approve/reject/annotate/edit)
export async function PUT(request: NextRequest) {
  try {
    const supabase = getSupabase()
    const body = await request.json()

    // Handle bulk approval/rejection
    if (body.bulk_ids && body.approval_status) {
      const updates: Record<string, unknown> = {
        approval_status: body.approval_status,
        updated_at: new Date().toISOString()
      }
      if (body.approval_status === 'manually_approved') {
        updates.approved_at = new Date().toISOString()
      }

      const { data, error } = await supabase
        .from('coverage_items')
        .update(updates)
        .in('id', body.bulk_ids)
        .select()

      if (error) {
        console.error('Error bulk updating coverage items:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      return NextResponse.json({ data, updated: data?.length || 0 })
    }

    // Single item update
    const { id, ...updates } = body
    if (!id) {
      return NextResponse.json({ error: 'Item ID is required' }, { status: 400 })
    }

    const cleanUpdates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    const allowedFields = [
      'title', 'url', 'publish_date', 'territory', 'coverage_type',
      'monthly_unique_visitors', 'review_score', 'quotes', 'sentiment',
      'relevance_score', 'approval_status', 'campaign_id', 'campaign_section',
      'outlet_id', 'game_id', 'client_id', 'source_type'
    ]

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        cleanUpdates[field] = updates[field]
      }
    }

    // Set approval metadata
    if (updates.approval_status === 'manually_approved') {
      cleanUpdates.approved_at = new Date().toISOString()
    }

    const { data, error } = await supabase
      .from('coverage_items')
      .update(cleanUpdates)
      .eq('id', id)
      .select('*, outlet:outlets(id, name, domain, tier, monthly_unique_visitors), game:games(id, name), client:clients(id, name), campaign:coverage_campaigns(id, name)')
      .single()

    if (error) {
      console.error('Error updating coverage item:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('Coverage items PUT error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// DELETE - Delete coverage item(s) — single via ?id= or bulk via request body { bulk_ids: [...] }
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
            .from('coverage_items')
            .delete()
            .in('id', body.bulk_ids)

          if (error) {
            console.error('Error bulk deleting coverage items:', error)
            return NextResponse.json({ error: error.message }, { status: 500 })
          }

          return NextResponse.json({ success: true, deleted: body.bulk_ids.length })
        }
      } catch {
        // No body or invalid JSON — fall through to error
      }
      return NextResponse.json({ error: 'Item ID or bulk_ids required' }, { status: 400 })
    }

    // Single delete via query param
    const { error } = await supabase
      .from('coverage_items')
      .delete()
      .eq('id', id)

    if (error) {
      console.error('Error deleting coverage item:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Coverage items DELETE error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
