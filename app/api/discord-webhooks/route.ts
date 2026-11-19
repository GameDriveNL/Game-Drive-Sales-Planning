import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { requireFeature } from '@/lib/api-auth'

// The server later POSTs to whatever URL is stored here, so only real Discord
// webhook URLs are accepted. Anything else could point the server at internal
// services (server side request forgery).
function isDiscordWebhookUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    const u = new URL(value)
    return (
      u.protocol === 'https:' &&
      ['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com'].includes(u.hostname) &&
      u.pathname.startsWith('/api/webhooks/')
    )
  } catch {
    return false
  }
}

function getSupabase() {
  return getServerSupabase()
}

// GET /api/discord-webhooks — List webhooks for a client
export async function GET(request: NextRequest) {
  const denied = await requireFeature('pr_coverage', 'view')
  if (denied instanceof NextResponse) return denied

  const supabase = getSupabase()
  const { searchParams } = new URL(request.url)
  const clientId = searchParams.get('client_id')

  let query = supabase
    .from('discord_webhooks')
    .select('*, game:games(id, name)')
    .order('created_at', { ascending: false })

  if (clientId) query = query.eq('client_id', clientId)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Mask webhook URLs for display
  // The full URL is a secret (anyone holding it can post to the channel), so it
  // is not returned, only the masked display form.
  const masked = (data || []).map(({ webhook_url: _secret, ...row }) => ({
    ...row,
    webhook_url_display: _secret
      ? `${_secret.slice(0, 40)}...${_secret.slice(-10)}`
      : '',
  }))

  return NextResponse.json(masked)
}

// POST /api/discord-webhooks — Create or update a webhook
export async function POST(request: NextRequest) {
  const denied = await requireFeature('pr_coverage', 'edit')
  if (denied instanceof NextResponse) return denied

  const supabase = getSupabase()
  const body = await request.json()
  const { id, client_id, game_id, webhook_url, label, min_tier, coverage_types, is_active } = body

  if (!client_id || !webhook_url) {
    return NextResponse.json({ error: 'client_id and webhook_url are required' }, { status: 400 })
  }

  if (!isDiscordWebhookUrl(webhook_url)) {
    return NextResponse.json({ error: 'webhook_url must be a https://discord.com/api/webhooks/... URL' }, { status: 400 })
  }

  const record = {
    client_id,
    game_id: game_id || null,
    webhook_url,
    label: label || null,
    min_tier: min_tier || 'B',
    coverage_types: coverage_types || [],
    is_active: is_active !== false,
    updated_at: new Date().toISOString(),
  }

  if (id) {
    const { data, error } = await supabase
      .from('discord_webhooks')
      .update(record)
      .eq('id', id)
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data)
  } else {
    const { data, error } = await supabase
      .from('discord_webhooks')
      .insert(record)
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data)
  }
}

// DELETE /api/discord-webhooks — Delete a webhook
export async function DELETE(request: NextRequest) {
  const supabase = getSupabase()
  const { searchParams } = new URL(request.url)
  const id = searchParams.get('id')

  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const { error } = await supabase.from('discord_webhooks').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
