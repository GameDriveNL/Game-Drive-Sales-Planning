import { NextResponse } from 'next/server'
import { serverSupabase as supabase } from '@/lib/supabase'

// ─── GET — list feedback items (with comments) ──────────────────────────────
// Optional filters: ?type=bug&archived=false&tag=pr-coverage

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const type = searchParams.get('type')
    const archived = searchParams.get('archived')
    const tag = searchParams.get('tag')

    let query = supabase
      .from('feedback_items')
      .select('*, comments:feedback_comments(*)')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })

    if (type) query = query.eq('item_type', type)
    if (archived === 'true') query = query.eq('archived', true)
    if (archived === 'false') query = query.eq('archived', false)
    if (tag) query = query.contains('tags', [tag])

    const { data, error } = await query

    if (error) {
      console.error('[Feedback API] GET error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Sort nested comments oldest-first for thread display.
    const items = (data || []).map((it: { comments?: { created_at: string }[] }) => ({
      ...it,
      comments: (it.comments || []).sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      ),
    }))

    return NextResponse.json(items)
  } catch (err) {
    console.error('[Feedback API] GET fatal:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ─── POST — create an item ──────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { title, description, item_type, status, priority, tags, reporter, code_refs } = body

    if (!title || !title.trim()) {
      return NextResponse.json({ error: 'title is required' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('feedback_items')
      .insert({
        title: title.trim(),
        description: description?.trim() || null,
        item_type: item_type || 'bug',
        status: status || 'backlogged',
        priority: priority || 'medium',
        tags: Array.isArray(tags) ? tags : [],
        reporter: reporter?.trim() || null,
        code_refs: code_refs?.trim() || null,
        source: 'in-app',
      })
      .select('*, comments:feedback_comments(*)')
      .single()

    if (error || !data) {
      console.error('[Feedback API] POST error:', error)
      return NextResponse.json({ error: error?.message || 'Failed to create item' }, { status: 500 })
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('[Feedback API] POST fatal:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ─── PATCH — update an item (status moves, edits, answers, archive) ──────────

export async function PATCH(request: Request) {
  try {
    const body = await request.json()
    const { id } = body
    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 })
    }

    const allowed = [
      'title', 'description', 'item_type', 'status', 'priority',
      'tags', 'archived', 'answer', 'answered', 'reporter', 'code_refs', 'sort_order',
      'needs_clarification',
    ]
    const updates: Record<string, unknown> = {}
    for (const key of allowed) {
      if (body[key] !== undefined) updates[key] = body[key]
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'no fields to update' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('feedback_items')
      .update(updates)
      .eq('id', id)
      .select('*, comments:feedback_comments(*)')
      .single()

    if (error || !data) {
      console.error('[Feedback API] PATCH error:', error)
      return NextResponse.json({ error: error?.message || 'Failed to update item' }, { status: 500 })
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('[Feedback API] PATCH fatal:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ─── DELETE — remove an item ────────────────────────────────────────────────

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    if (!id) {
      return NextResponse.json({ error: 'id query param is required' }, { status: 400 })
    }

    const { error } = await supabase.from('feedback_items').delete().eq('id', id)

    if (error) {
      console.error('[Feedback API] DELETE error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[Feedback API] DELETE fatal:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
