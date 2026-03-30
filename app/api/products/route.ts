import { NextResponse } from 'next/server'
import { serverSupabase as supabase } from '@/lib/supabase'

// ─── GET — list products, optionally filtered by game_id ────────────────────

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const gameId = searchParams.get('game_id')

    let query = supabase
      .from('products')
      .select('*, game:games(id, name, client_id), product_platforms(id, product_id, platform_id, platform:platforms(id, name, color_hex))')
      .order('created_at', { ascending: true })

    if (gameId) {
      query = query.eq('game_id', gameId)
    }

    const { data, error } = await query

    if (error) {
      console.error('[Products API] GET error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data || [])
  } catch (err) {
    console.error('[Products API] GET fatal:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ─── POST — create a product ────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { name, game_id, product_type, steam_product_id, launch_date, product_aliases, platform_ids } = body

    if (!name || !game_id) {
      return NextResponse.json({ error: 'name and game_id are required' }, { status: 400 })
    }

    // Insert the product
    const { data: product, error: insertErr } = await supabase
      .from('products')
      .insert({
        name: name.trim(),
        game_id,
        product_type: product_type || 'base',
        steam_product_id: steam_product_id || null,
        launch_date: launch_date || null,
        product_aliases: Array.isArray(product_aliases) ? product_aliases : [],
      })
      .select('*')
      .single()

    if (insertErr || !product) {
      console.error('[Products API] POST insert error:', insertErr)
      return NextResponse.json({ error: insertErr?.message || 'Failed to create product' }, { status: 500 })
    }

    // Insert product_platforms if provided
    if (Array.isArray(platform_ids) && platform_ids.length > 0) {
      const platformRows = platform_ids.map((pid: string) => ({
        product_id: product.id,
        platform_id: pid,
      }))

      const { error: platErr } = await supabase
        .from('product_platforms')
        .insert(platformRows)

      if (platErr) {
        console.error('[Products API] POST platform insert error:', platErr)
        // Don't fail the whole request — product was created
      }
    }

    return NextResponse.json(product)
  } catch (err) {
    console.error('[Products API] POST fatal:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ─── PUT — update a product ─────────────────────────────────────────────────

export async function PUT(request: Request) {
  try {
    const body = await request.json()
    const { id, name, product_type, steam_product_id, launch_date, product_aliases, platform_ids } = body

    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 })
    }

    // Build update object with only provided fields
    const updates: Record<string, unknown> = {}
    if (name !== undefined) updates.name = name.trim()
    if (product_type !== undefined) updates.product_type = product_type
    if (steam_product_id !== undefined) updates.steam_product_id = steam_product_id || null
    if (launch_date !== undefined) updates.launch_date = launch_date || null
    if (product_aliases !== undefined) {
      updates.product_aliases = Array.isArray(product_aliases) ? product_aliases : []
    }

    const { data: product, error: updateErr } = await supabase
      .from('products')
      .update(updates)
      .eq('id', id)
      .select('*')
      .single()

    if (updateErr || !product) {
      console.error('[Products API] PUT update error:', updateErr)
      return NextResponse.json({ error: updateErr?.message || 'Failed to update product' }, { status: 500 })
    }

    // Sync product_platforms if platform_ids provided
    if (Array.isArray(platform_ids)) {
      // Delete existing platforms
      await supabase
        .from('product_platforms')
        .delete()
        .eq('product_id', id)

      // Insert new platforms
      if (platform_ids.length > 0) {
        const platformRows = platform_ids.map((pid: string) => ({
          product_id: id,
          platform_id: pid,
        }))

        const { error: platErr } = await supabase
          .from('product_platforms')
          .insert(platformRows)

        if (platErr) {
          console.error('[Products API] PUT platform sync error:', platErr)
        }
      }
    }

    return NextResponse.json(product)
  } catch (err) {
    console.error('[Products API] PUT fatal:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ─── DELETE — delete a product ──────────────────────────────────────────────

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')

    if (!id) {
      return NextResponse.json({ error: 'id query param is required' }, { status: 400 })
    }

    // Delete product_platforms first (in case no cascade)
    await supabase
      .from('product_platforms')
      .delete()
      .eq('product_id', id)

    const { error: deleteErr } = await supabase
      .from('products')
      .delete()
      .eq('id', id)

    if (deleteErr) {
      console.error('[Products API] DELETE error:', deleteErr)
      return NextResponse.json({ error: deleteErr.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[Products API] DELETE fatal:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
