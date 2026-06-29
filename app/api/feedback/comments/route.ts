import { NextResponse } from 'next/server'
import { serverSupabase as supabase } from '@/lib/supabase'

// ─── POST — add a comment to a feedback item ────────────────────────────────

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { item_id, body: text, author } = body

    if (!item_id || !text || !text.trim()) {
      return NextResponse.json({ error: 'item_id and body are required' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('feedback_comments')
      .insert({
        item_id,
        body: text.trim(),
        author: author?.trim() || null,
      })
      .select('*')
      .single()

    if (error || !data) {
      console.error('[Feedback Comments API] POST error:', error)
      return NextResponse.json({ error: error?.message || 'Failed to add comment' }, { status: 500 })
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('[Feedback Comments API] POST fatal:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ─── DELETE — remove a comment ──────────────────────────────────────────────

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    if (!id) {
      return NextResponse.json({ error: 'id query param is required' }, { status: 400 })
    }

    const { error } = await supabase.from('feedback_comments').delete().eq('id', id)

    if (error) {
      console.error('[Feedback Comments API] DELETE error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[Feedback Comments API] DELETE fatal:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
