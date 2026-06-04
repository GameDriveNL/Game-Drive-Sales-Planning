/**
 * GET /api/coverage-health/scanner-health
 *
 * Read-only operational snapshot for the Scanner Health panel on the
 * coverage dashboard. Returns per-scanner status + recent error rate +
 * insertion velocity. Drives the collapsible "Scanner Health" section.
 *
 * Public (no auth). Returns only aggregate counts — no secrets, no
 * coverage_item details.
 */

import { NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface ScannerStat {
  scanner: string                 // 'twitch-streams-poll', 'youtube-rss-poll', ...
  schedule: string                // human-readable cron expression
  items_24h: number               // coverage_items inserted in last 24h
  items_1h: number                // last hour
  errors_24h: number              // scanner_errors logged in last 24h
  errors_1h: number               // last hour
  error_rate_24h: number          // errors / (items + errors)
  status: 'healthy' | 'warn' | 'critical' | 'idle'
  status_reason: string
}

// Maps a metadata flag to the cron name + schedule. The query below uses
// these flags to count items per scanner.
const SCANNERS: Array<{ flag: string; scanner: string; schedule: string; idleHrs: number }> = [
  { flag: 'twitch_streams_poll',   scanner: 'twitch-streams-poll',   schedule: '*/2 min',  idleHrs: 1 },
  { flag: 'youtube_rss_poll',      scanner: 'youtube-rss-poll',      schedule: '*/30 min', idleHrs: 2 },
  { flag: 'tiktok_profile_poll',   scanner: 'tiktok-profile-poll',   schedule: 'daily 03:00 UTC', idleHrs: 30 },
  { flag: 'audit_youtube_pass',    scanner: 'audit-youtube',         schedule: 'on demand / cron',  idleHrs: 24 * 14 },
  { flag: 'audit_tiktok_pass',     scanner: 'audit-tiktok',          schedule: 'on demand / cron',  idleHrs: 24 * 14 },
]

const CREATOR_GRAPH_FLAG = 'creator_graph_expand'

export async function GET() {
  const supabase = getServerSupabase()
  const now = new Date()
  const since24 = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const since1 = new Date(now.getTime() - 60 * 60 * 1000).toISOString()

  // Per-scanner item counts via source_metadata flag
  const out: ScannerStat[] = []
  for (const def of SCANNERS) {
    const [{ count: items_24h }, { count: items_1h }] = await Promise.all([
      supabase.from('coverage_items')
        .select('id', { count: 'exact', head: true })
        .gte('discovered_at', since24)
        .filter(`source_metadata->>${def.flag}`, 'eq', 'true'),
      supabase.from('coverage_items')
        .select('id', { count: 'exact', head: true })
        .gte('discovered_at', since1)
        .filter(`source_metadata->>${def.flag}`, 'eq', 'true'),
    ])
    const [{ count: errors_24h }, { count: errors_1h }, { data: lastErr }] = await Promise.all([
      supabase.from('scanner_errors')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', since24)
        .eq('scanner', def.scanner),
      supabase.from('scanner_errors')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', since1)
        .eq('scanner', def.scanner),
      supabase.from('coverage_items')
        .select('discovered_at')
        .filter(`source_metadata->>${def.flag}`, 'eq', 'true')
        .order('discovered_at', { ascending: false })
        .limit(1),
    ])
    const lastDiscoveredAt = lastErr?.[0]?.discovered_at ? new Date(lastErr[0].discovered_at) : null
    const hoursSinceLast = lastDiscoveredAt
      ? (now.getTime() - lastDiscoveredAt.getTime()) / (60 * 60 * 1000)
      : Infinity
    const idle = hoursSinceLast > def.idleHrs
    const errorRate = (items_24h ?? 0) + (errors_24h ?? 0) > 0
      ? (errors_24h ?? 0) / ((items_24h ?? 0) + (errors_24h ?? 0))
      : 0

    let status: ScannerStat['status'] = 'healthy'
    let reason = `${items_24h ?? 0} items in 24h`
    if (idle) { status = 'idle'; reason = `no items for ${hoursSinceLast === Infinity ? 'ever' : hoursSinceLast.toFixed(0) + 'h'}` }
    else if (errorRate >= 0.5) { status = 'critical'; reason = `${(errorRate * 100).toFixed(0)}% error rate in 24h` }
    else if (errorRate >= 0.1) { status = 'warn'; reason = `${(errorRate * 100).toFixed(0)}% error rate in 24h` }
    out.push({
      scanner: def.scanner,
      schedule: def.schedule,
      items_24h: items_24h ?? 0,
      items_1h: items_1h ?? 0,
      errors_24h: errors_24h ?? 0,
      errors_1h: errors_1h ?? 0,
      error_rate_24h: Math.round(errorRate * 1000) / 1000,
      status, status_reason: reason,
    })
  }

  // Creator-graph-expand reports the discovery field rather than a flag
  const [{ count: cgItems24 }, { count: cgItems1 }, { count: cgErr24 }, { data: cgLast }] = await Promise.all([
    supabase.from('coverage_items')
      .select('id', { count: 'exact', head: true })
      .gte('discovered_at', since24)
      .filter('source_metadata->>discovery', 'eq', CREATOR_GRAPH_FLAG),
    supabase.from('coverage_items')
      .select('id', { count: 'exact', head: true })
      .gte('discovered_at', since1)
      .filter('source_metadata->>discovery', 'eq', CREATOR_GRAPH_FLAG),
    supabase.from('scanner_errors')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', since24)
      .eq('scanner', 'creator-graph-expand'),
    supabase.from('coverage_items')
      .select('discovered_at')
      .filter('source_metadata->>discovery', 'eq', CREATOR_GRAPH_FLAG)
      .order('discovered_at', { ascending: false })
      .limit(1),
  ])
  const cgLastIso = cgLast?.[0]?.discovered_at
  const cgHours = cgLastIso ? (now.getTime() - new Date(cgLastIso).getTime()) / 3_600_000 : Infinity
  const cgIdle = cgHours > 8
  out.push({
    scanner: 'creator-graph-expand',
    schedule: 'every 4h',
    items_24h: cgItems24 ?? 0,
    items_1h: cgItems1 ?? 0,
    errors_24h: cgErr24 ?? 0,
    errors_1h: 0,
    error_rate_24h: 0,
    status: cgIdle ? 'idle' : 'healthy',
    status_reason: cgIdle ? `last fired ${cgHours.toFixed(0)}h ago` : `${cgItems24 ?? 0} cross-platform handles added 24h`,
  })

  // Pending review queue depth
  const { count: pendingTotal } = await supabase
    .from('coverage_items')
    .select('id', { count: 'exact', head: true })
    .eq('approval_status', 'pending_review')
  const { count: autoApproved24 } = await supabase
    .from('coverage_items')
    .select('id', { count: 'exact', head: true })
    .eq('approval_status', 'auto_approved')
    .gte('discovered_at', since24)

  // Overall rollup
  const anyCritical = out.some(s => s.status === 'critical')
  const anyWarn = out.some(s => s.status === 'warn')
  const anyIdle = out.some(s => s.status === 'idle')
  const overall: 'healthy' | 'warn' | 'critical' = anyCritical ? 'critical' : (anyWarn || anyIdle) ? 'warn' : 'healthy'

  return NextResponse.json({
    overall,
    generated_at: now.toISOString(),
    scanners: out,
    queue: {
      pending_review_total: pendingTotal ?? 0,
      auto_approved_24h: autoApproved24 ?? 0,
    },
  })
}
