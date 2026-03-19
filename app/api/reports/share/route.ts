import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import crypto from 'crypto'

function getSupabase() {
  return getServerSupabase()
}

// POST /api/reports/share — Generate a shareable report link
export async function POST(request: NextRequest) {
  const supabase = getSupabase()

  try {
    const body = await request.json()
    const { client_id, game_id, date_from, date_to, sections, expires_days } = body

    if (!client_id) {
      return NextResponse.json({ error: 'client_id is required' }, { status: 400 })
    }

    // Generate a secure random token
    const token = crypto.randomBytes(32).toString('hex')

    // Calculate expiry (default 30 days)
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + (expires_days || 30))

    const { data, error } = await supabase
      .from('report_share_tokens')
      .insert({
        client_id,
        game_id: game_id || null,
        token,
        date_from: date_from || null,
        date_to: date_to || null,
        sections: sections || { summary: true, sales: true, pr_coverage: true, social: true },
        expires_at: expiresAt.toISOString(),
        is_active: true,
      })
      .select()
      .single()

    if (error) throw error

    // Build the shareable URL
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3003'
    const shareUrl = `${baseUrl}/reports/shared/${token}`

    return NextResponse.json({ ...data, share_url: shareUrl })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Error creating share token:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// GET /api/reports/share?token=xxx — Fetch report data for a share token
export async function GET(request: NextRequest) {
  const supabase = getSupabase()
  const { searchParams } = new URL(request.url)
  const token = searchParams.get('token')

  if (!token) {
    return NextResponse.json({ error: 'token is required' }, { status: 400 })
  }

  try {
    // Look up the token
    const { data: tokenData, error: tokenErr } = await supabase
      .from('report_share_tokens')
      .select('*')
      .eq('token', token)
      .eq('is_active', true)
      .single()

    if (tokenErr || !tokenData) {
      return NextResponse.json({ error: 'Invalid or expired share link' }, { status: 404 })
    }

    // Check expiry
    if (tokenData.expires_at && new Date(tokenData.expires_at) < new Date()) {
      return NextResponse.json({ error: 'This share link has expired' }, { status: 410 })
    }

    // Increment view count
    await supabase
      .from('report_share_tokens')
      .update({
        view_count: (tokenData.view_count || 0) + 1,
        last_viewed_at: new Date().toISOString(),
      })
      .eq('id', tokenData.id)

    // Fetch the report data using the same logic as /api/reports
    const params = new URLSearchParams({ client_id: tokenData.client_id })
    if (tokenData.game_id) params.set('game_id', tokenData.game_id)
    if (tokenData.date_from) params.set('date_from', tokenData.date_from)
    if (tokenData.date_to) params.set('date_to', tokenData.date_to)

    // Fetch report data internally
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3003}`
    const reportRes = await fetch(`${baseUrl}/api/reports?${params}`, {
      headers: { 'Content-Type': 'application/json' },
    })

    if (!reportRes.ok) {
      const errData = await reportRes.json().catch(() => ({}))
      throw new Error(errData.error || 'Failed to fetch report data')
    }

    const reportData = await reportRes.json()

    // Filter sections based on token permissions
    const sections = tokenData.sections || {}
    if (!sections.sales) delete reportData.sales
    if (!sections.pr_coverage) delete reportData.coverage
    if (!sections.social) delete reportData.social

    return NextResponse.json({
      report: reportData,
      meta: {
        client_name: reportData.client?.name,
        game_name: reportData.game?.name,
        date_from: tokenData.date_from,
        date_to: tokenData.date_to,
        sections: tokenData.sections,
        created_at: tokenData.created_at,
      },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Error fetching shared report:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
