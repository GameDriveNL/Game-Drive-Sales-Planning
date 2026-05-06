import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { verifyCronAuth } from '@/lib/cron-auth'

function getSupabase() {
  return getServerSupabase()
}

interface CoverageItem {
  id: string
  title: string
  url: string
  publish_date: string | null
  coverage_type: string
  source_type: string
  monthly_unique_visitors: number | null
  review_score: number | null
  sentiment: string | null
  outlets?: { name: string; domain: string; tier: string | null } | null
  games?: { name: string } | null
}

interface DigestConfig {
  id: string
  client_id: string
  frequency: string
  recipients: string[]
  min_items_threshold: number
  last_sent_at: string | null
  clients?: { name: string } | null
}

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`
  return String(n)
}

function buildDigestHtml(clientName: string, items: CoverageItem[], dateRange: string): string {
  const totalReach = items.reduce((sum, i) => sum + (Number(i.monthly_unique_visitors) || 0), 0)
  const reviews = items.filter(i => i.review_score != null)
  const avgScore = reviews.length > 0 ? reviews.reduce((sum, i) => sum + Number(i.review_score || 0), 0) / reviews.length : null

  // Sort by outlet traffic (highest first)
  const sorted = [...items].sort((a, b) => (Number(b.monthly_unique_visitors) || 0) - (Number(a.monthly_unique_visitors) || 0))
  const top = sorted.slice(0, 20)

  const itemRows = top.map(item => {
    const outlet = item.outlets?.name || 'Unknown'
    const tier = item.outlets?.tier || '—'
    const reach = item.monthly_unique_visitors ? formatNumber(Number(item.monthly_unique_visitors)) : '—'
    const score = item.review_score != null ? `${item.review_score}/10` : ''
    const type = item.coverage_type || item.source_type || '—'

    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">
        <a href="${item.url}" style="color:#2563eb;text-decoration:none;">${escapeHtml(item.title.length > 80 ? item.title.substring(0, 80) + '...' : item.title)}</a>
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(outlet)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">${tier}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">${escapeHtml(type)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${reach}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">${score}</td>
    </tr>`
  }).join('\n')

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a2e;background:#f8f9fa;padding:20px;">
  <div style="max-width:700px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <div style="background:#1a1a2e;color:#fff;padding:24px 32px;">
      <h1 style="margin:0;font-size:20px;">Coverage Digest — ${escapeHtml(clientName)}</h1>
      <p style="margin:8px 0 0;opacity:0.8;font-size:14px;">${escapeHtml(dateRange)}</p>
    </div>
    <div style="padding:24px 32px;">
      <div style="display:flex;gap:24px;margin-bottom:24px;">
        <div style="flex:1;background:#f0f4ff;border-radius:6px;padding:16px;text-align:center;">
          <div style="font-size:28px;font-weight:700;color:#2563eb;">${items.length}</div>
          <div style="font-size:12px;color:#666;margin-top:4px;">New Coverage</div>
        </div>
        <div style="flex:1;background:#f0fdf4;border-radius:6px;padding:16px;text-align:center;">
          <div style="font-size:28px;font-weight:700;color:#16a34a;">${formatNumber(totalReach)}</div>
          <div style="font-size:12px;color:#666;margin-top:4px;">Total Reach</div>
        </div>
        ${avgScore != null ? `<div style="flex:1;background:#fefce8;border-radius:6px;padding:16px;text-align:center;">
          <div style="font-size:28px;font-weight:700;color:#ca8a04;">${avgScore.toFixed(1)}</div>
          <div style="font-size:12px;color:#666;margin-top:4px;">Avg Review Score</div>
        </div>` : ''}
      </div>
      <h2 style="font-size:16px;margin:0 0 12px;color:#1a1a2e;">Top Coverage${items.length > 20 ? ' (showing top 20 by reach)' : ''}</h2>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:#f8f9fa;">
            <th style="padding:8px 12px;text-align:left;font-weight:600;">Title</th>
            <th style="padding:8px 12px;text-align:left;font-weight:600;">Outlet</th>
            <th style="padding:8px 12px;text-align:center;font-weight:600;">Tier</th>
            <th style="padding:8px 12px;text-align:center;font-weight:600;">Type</th>
            <th style="padding:8px 12px;text-align:right;font-weight:600;">Reach</th>
            <th style="padding:8px 12px;text-align:center;font-weight:600;">Score</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
      </table>
    </div>
    <div style="background:#f8f9fa;padding:16px 32px;font-size:12px;color:#888;text-align:center;">
      Powered by GameDrive Coverage Tracker
    </div>
  </div>
</body>
</html>`
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// GET /api/cron/coverage-digest — Send scheduled coverage digest emails
export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request)
  if (authError) return authError

  const supabase = getSupabase()

  try {
    // Get Resend API key
    const { data: keyData } = await supabase
      .from('service_api_keys')
      .select('api_key')
      .eq('service_name', 'resend')
      .eq('is_active', true)
      .single()

    if (!keyData?.api_key) {
      return NextResponse.json({ message: 'Resend API key not configured, skipping digest' })
    }

    const resendKey = keyData.api_key

    // Get all active digest configs
    const { data: configs } = await supabase
      .from('coverage_digest_config')
      .select('*, clients(name)')
      .neq('frequency', 'disabled')

    if (!configs || configs.length === 0) {
      return NextResponse.json({ message: 'No digest configs active' })
    }

    const now = new Date()
    let totalSent = 0
    let totalSkipped = 0

    for (const config of configs as DigestConfig[]) {
      try {
        if (!config.recipients || config.recipients.length === 0) continue

        // Determine if this digest is due
        const lastSent = config.last_sent_at ? new Date(config.last_sent_at) : null
        const hoursSinceLast = lastSent ? (now.getTime() - lastSent.getTime()) / (1000 * 60 * 60) : Infinity

        if (config.frequency === 'daily' && hoursSinceLast < 20) continue
        if (config.frequency === 'weekly' && hoursSinceLast < 144) continue // ~6 days

        // Get new coverage since last sent (or last 24h for daily, 7d for weekly)
        const lookbackHours = config.frequency === 'daily' ? 24 : 168
        const sinceDate = lastSent || new Date(now.getTime() - lookbackHours * 60 * 60 * 1000)

        const { data: items } = await supabase
          .from('coverage_items')
          .select('id, title, url, publish_date, coverage_type, source_type, monthly_unique_visitors, review_score, sentiment, outlets(name, domain, tier), games(name)')
          .eq('client_id', config.client_id)
          .in('approval_status', ['auto_approved', 'manually_approved', 'pending_review'])
          .gte('discovered_at', sinceDate.toISOString())
          .order('monthly_unique_visitors', { ascending: false, nullsFirst: false })

        if (!items || items.length < config.min_items_threshold) {
          totalSkipped++
          continue
        }

        // Build email
        const clientName = config.clients?.name || 'Client'
        const dateRange = config.frequency === 'daily'
          ? `Daily Digest — ${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`
          : `Weekly Digest — Week of ${sinceDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} to ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`

        const html = buildDigestHtml(clientName, items as unknown as CoverageItem[], dateRange)
        const subject = `[GameDrive] ${clientName} Coverage Digest — ${items.length} new piece${items.length !== 1 ? 's' : ''}`

        // Send via Resend
        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${resendKey}`,
          },
          body: JSON.stringify({
            from: 'GameDrive Coverage <coverage@updates.game-drive.nl>',
            to: config.recipients,
            subject,
            html,
          }),
        })

        if (!emailRes.ok) {
          const errBody = await emailRes.text()
          console.error(`Resend error for client ${clientName}:`, errBody)
          continue
        }

        // Update last_sent_at
        await supabase
          .from('coverage_digest_config')
          .update({ last_sent_at: now.toISOString(), updated_at: now.toISOString() })
          .eq('id', config.id)

        totalSent++
      } catch (err) {
        console.error(`Digest error for config ${config.id}:`, err)
      }
    }

    return NextResponse.json({
      message: `Digest run complete: ${totalSent} sent, ${totalSkipped} skipped (below threshold)`,
      sent: totalSent,
      skipped: totalSkipped,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Coverage digest error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
