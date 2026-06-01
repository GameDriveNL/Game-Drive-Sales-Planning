/**
 * POST /api/coverage-health/oneshot-darkpals-import
 *
 * Bulk import of URLs into Dark Pals coverage. Bridge endpoint while the
 * autonomous scanners catch up — accepts the URL list from Bram's external
 * tracker so we hit baseline parity immediately. Ongoing crons then keep
 * the system in sync going forward.
 *
 * Body (JSON): { rows: Array<{ url: string; channel_url?: string;
 *                              title?: string; published?: string;
 *                              platform?: 'youtube'|'twitch'|'tiktok' }>
 *              }
 *
 * Inserts each URL deduped against existing coverage_items.url. Outlet is
 * auto-created if needed. coverage_type defaults to 'video' for
 * youtube/tiktok and 'stream' for twitch.
 *
 * Self-locks via service_settings.oneshot_darkpals_import_done so we don't
 * accidentally re-run and double the dataset. Whitelisted in middleware.
 * Will be removed after parity verification.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { detectOutletCountry } from '@/lib/outlet-country'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

const DARK_PALS_GAME_ID = '6ce557eb-0c04-412e-a6da-7fee77738ff9'

interface ImportRow {
  url: string
  channel_url?: string
  title?: string
  published?: string  // 'DD/MM/YYYY' or ISO
  platform?: 'youtube' | 'twitch' | 'tiktok'
  channel_name?: string
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    return (u.origin + u.pathname).replace(/\/$/, '')
  } catch { return url }
}

function inferPlatform(url: string): 'youtube' | 'twitch' | 'tiktok' | null {
  const l = url.toLowerCase()
  if (l.includes('youtube.com') || l.includes('youtu.be')) return 'youtube'
  if (l.includes('twitch.tv')) return 'twitch'
  if (l.includes('tiktok.com')) return 'tiktok'
  return null
}

function parseDate(raw: string | undefined): string | null {
  if (!raw) return null
  // 'DD/MM/YYYY 00:00' format from Bram's sheet
  const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})/)
  if (m) return `${m[3]}-${m[2]}-${m[1]}`
  // ISO already
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.substring(0, 10)
  return null
}

function outletDomainFor(platform: string, channelUrl: string | undefined, url: string): { domain: string; name: string } {
  if (platform === 'youtube') {
    if (channelUrl) {
      const m = channelUrl.match(/youtube\.com\/(@[^\/\?]+|channel\/[A-Za-z0-9_\-]+|c\/[^\/\?]+|user\/[^\/\?]+)/i)
      if (m) return { domain: `youtube.com/${m[1].toLowerCase()}`, name: m[1] }
    }
    return { domain: 'youtube.com', name: 'YouTube' }
  }
  if (platform === 'twitch') {
    const m = url.match(/twitch\.tv\/([^\/\?]+)/i)
    if (m) return { domain: `twitch.tv/${m[1].toLowerCase()}`, name: m[1] }
    return { domain: 'twitch.tv', name: 'Twitch' }
  }
  if (platform === 'tiktok') {
    const m = url.match(/tiktok\.com\/@([^\/\?]+)/i)
    if (m) return { domain: `tiktok.com/@${m[1].toLowerCase()}`, name: `@${m[1]}` }
    return { domain: 'tiktok.com', name: 'TikTok' }
  }
  return { domain: 'manual.local', name: 'Manual' }
}

export async function POST(request: NextRequest) {
  const supabase = getServerSupabase()

  const { data: lockRow } = await supabase
    .from('service_settings')
    .select('value').eq('key', 'oneshot_darkpals_import_done').maybeSingle()
  if (lockRow?.value === true || lockRow?.value === 'true') {
    return NextResponse.json({
      error: 'Already ran. Clear service_settings.oneshot_darkpals_import_done to re-enable.',
    }, { status: 410 })
  }

  let body: { rows?: ImportRow[] } = {}
  try { body = await request.json() } catch { /* */ }
  const rows = Array.isArray(body.rows) ? body.rows : []
  if (rows.length === 0) {
    return NextResponse.json({ error: 'rows[] required' }, { status: 400 })
  }

  const { data: game } = await supabase
    .from('games').select('id, name, client_id').eq('id', DARK_PALS_GAME_ID).single()
  if (!game) return NextResponse.json({ error: 'Dark Pals not found' }, { status: 404 })

  const { data: existing } = await supabase
    .from('coverage_items').select('url').eq('game_id', game.id).limit(50000)
  const existingUrls = new Set<string>()
  for (const e of (existing || [])) existingUrls.add(normalizeUrl((e as { url: string }).url))

  const outletCache = new Map<string, string | null>()
  async function getOutletId(domain: string, name: string): Promise<string | null> {
    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').toLowerCase()
    if (outletCache.has(cleanDomain)) return outletCache.get(cleanDomain) ?? null
    const { data: o } = await supabase.from('outlets').select('id').eq('domain', cleanDomain).maybeSingle()
    if (o?.id) { outletCache.set(cleanDomain, o.id); return o.id }
    const { data: newO } = await supabase.from('outlets').insert({
      name, domain: cleanDomain,
      country: detectOutletCountry(cleanDomain),
      tier: 'D', is_active: true,
    }).select('id').single()
    const id = newO?.id ?? null
    outletCache.set(cleanDomain, id)
    return id
  }

  const counts: Record<string, { found: number; inserted: number; dup: number; err: number }> = {
    youtube: { found: 0, inserted: 0, dup: 0, err: 0 },
    twitch:  { found: 0, inserted: 0, dup: 0, err: 0 },
    tiktok:  { found: 0, inserted: 0, dup: 0, err: 0 },
    skipped: { found: 0, inserted: 0, dup: 0, err: 0 },
  }
  const errSamples: string[] = []

  // Batch inserts in 500-row chunks to keep payload small.
  const inserts: Array<Record<string, unknown>> = []
  const t0 = Date.now()

  for (const r of rows) {
    if (Date.now() - t0 > 260_000) {
      errSamples.push(`time-budget-exhausted at row ${inserts.length}`)
      break
    }
    const url = (r.url || '').trim()
    if (!url || !/^https?:\/\//.test(url)) {
      counts.skipped.found++; continue
    }
    const platform = r.platform || inferPlatform(url)
    if (!platform) { counts.skipped.found++; continue }
    counts[platform].found++
    const norm = normalizeUrl(url)
    if (existingUrls.has(norm)) { counts[platform].dup++; continue }
    existingUrls.add(norm)
    const { domain, name } = outletDomainFor(platform, r.channel_url, url)
    const oid = await getOutletId(domain, r.channel_name || name)
    inserts.push({
      client_id: game.client_id, game_id: game.id, outlet_id: oid,
      title: (r.title || `${name} ${platform}`).substring(0, 500),
      url,
      publish_date: parseDate(r.published),
      coverage_type: platform === 'twitch' ? 'stream' : 'video',
      source_type: platform,
      source_metadata: {
        imported_from_bram_sheet: true,
        channel_url: r.channel_url || null,
      },
      approval_status: 'pending_review',
      discovered_at: new Date().toISOString(),
    })
  }

  // Flush
  const CHUNK = 500
  for (let i = 0; i < inserts.length; i += CHUNK) {
    const chunk = inserts.slice(i, i + CHUNK)
    const { error } = await supabase.from('coverage_items').insert(chunk)
    if (error) {
      errSamples.push(`chunk ${i}-${i+chunk.length}: ${error.message?.substring(0, 80)}`)
      // Fall back to per-row inserts so a single bad row doesn't tank the chunk
      for (const row of chunk) {
        const { error: e2 } = await supabase.from('coverage_items').insert(row)
        const p = row.source_type as string
        if (e2) counts[p].err++
        else if (counts[p]) counts[p].inserted++
      }
    } else {
      for (const row of chunk) {
        const p = row.source_type as string
        if (counts[p]) counts[p].inserted++
      }
    }
  }

  await supabase.from('service_settings').upsert({
    key: 'oneshot_darkpals_import_done', value: true,
  }, { onConflict: 'key' })

  const totalInserted = Object.values(counts).reduce((s, c) => s + c.inserted, 0)
  return NextResponse.json({
    message: `One-shot Dark Pals CSV import: +${totalInserted} new`,
    rows_input: rows.length,
    total_new_items: totalInserted,
    counts,
    errors: errSamples.slice(0, 10),
    elapsed_ms: Date.now() - t0,
  })
}
