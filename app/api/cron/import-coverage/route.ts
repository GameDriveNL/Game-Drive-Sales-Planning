/**
 * POST /api/cron/import-coverage
 *
 * Manual coverage ingest endpoint. The escape hatch for when the PR team
 * finds coverage URLs (via their own analytics tool, a manual search, a
 * client tip-off, etc.) and wants to put them in the system without waiting
 * for a scanner to discover them.
 *
 * Accepts JSON body:
 *   game_id:  string (required) — the game this coverage belongs to
 *   urls:     string[] | string  — one or more URLs to ingest
 *   source_type?: string         — defaults to inferred from URL (youtube,
 *                                   twitch, tiktok, instagram, reddit, etc.)
 *   coverage_type?: string       — defaults to inferred
 *   territory?: string
 *   imported_by?: string         — operator handle for audit
 *   notes?: string               — free-text note stored in source_metadata
 *
 * Each URL is normalized + deduped against existing coverage_items. The
 * outlet is auto-resolved or auto-created. AI relevance scoring happens
 * on the next coverage-enrich cron tick — same path as scanner-discovered
 * items.
 *
 * Auth: Bearer CRON_SECRET (so Game Drive can wire it into Slack/Zapier
 * or hit it from a TamperMonkey script).
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { verifyCronAuth } from '@/lib/cron-auth'
import { detectOutletCountry } from '@/lib/outlet-country'
import { domainToOutletName } from '@/lib/outlet-utils'
import { classifyCoverageType } from '@/lib/coverage-utils'
import { inferTerritory } from '@/lib/territory'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    u.searchParams.delete('utm_source'); u.searchParams.delete('utm_medium')
    u.searchParams.delete('utm_campaign'); u.searchParams.delete('utm_term')
    u.searchParams.delete('utm_content'); u.searchParams.delete('fbclid')
    let n = u.origin + u.pathname
    if (n.endsWith('/') && n.length > 1) n = n.slice(0, -1)
    const rest = u.searchParams.toString()
    if (rest) n += '?' + rest
    return n
  } catch { return url.trim() }
}

function inferSourceType(url: string): string {
  const lower = url.toLowerCase()
  if (lower.includes('youtube.com') || lower.includes('youtu.be')) return 'youtube'
  if (lower.includes('twitch.tv')) return 'twitch'
  if (lower.includes('reddit.com')) return 'reddit'
  if (lower.includes('twitter.com') || lower.includes('x.com')) return 'twitter'
  if (lower.includes('tiktok.com')) return 'tiktok'
  if (lower.includes('instagram.com')) return 'instagram'
  return 'manual'  // editorial / other web articles
}

interface ImportResult {
  url: string
  status: 'inserted' | 'duplicate' | 'invalid_url' | 'error'
  coverage_item_id?: string
  reason?: string
}

export async function POST(request: NextRequest) {
  const authError = verifyCronAuth(request)
  if (authError) return authError

  let body: {
    game_id?: string
    urls?: string | string[]
    source_type?: string
    coverage_type?: string
    territory?: string
    imported_by?: string
    notes?: string
  } = {}
  try { body = await request.json() } catch { /* empty ok */ }

  if (!body.game_id) {
    return NextResponse.json({ error: 'game_id is required' }, { status: 400 })
  }
  const rawUrls = Array.isArray(body.urls) ? body.urls : (body.urls ? [body.urls] : [])
  if (rawUrls.length === 0) {
    return NextResponse.json({ error: 'urls (string or string[]) is required' }, { status: 400 })
  }

  const supabase = getServerSupabase()
  const { data: game } = await supabase
    .from('games')
    .select('id, name, client_id')
    .eq('id', body.game_id)
    .single()
  if (!game) return NextResponse.json({ error: 'Game not found' }, { status: 404 })

  // Pre-load existing URL set for the game's client (dedup at client scope is
  // safest — same URL claimed by two games is unusual)
  const { data: existing } = await supabase
    .from('coverage_items')
    .select('url')
    .eq('client_id', game.client_id)
    .limit(20000)
  const existingUrls = new Set((existing || []).map((r: { url: string }) => normalizeUrl(r.url)))

  const results: ImportResult[] = []

  for (const raw of rawUrls) {
    const trimmed = String(raw || '').trim()
    if (!trimmed) {
      results.push({ url: trimmed, status: 'invalid_url', reason: 'empty' })
      continue
    }
    let parsed: URL
    try { parsed = new URL(trimmed) } catch {
      results.push({ url: trimmed, status: 'invalid_url', reason: 'unparseable' })
      continue
    }
    const url = normalizeUrl(trimmed)
    if (existingUrls.has(url)) {
      results.push({ url, status: 'duplicate' })
      continue
    }
    existingUrls.add(url)

    const sourceType = body.source_type || inferSourceType(url)
    const coverageType = body.coverage_type || classifyCoverageType('news', url)

    // Resolve outlet from URL hostname
    const domain = parsed.hostname.replace(/^www\./, '').toLowerCase()
    let outletId: string | null = null
    try {
      const { data: outlet } = await supabase
        .from('outlets')
        .select('id, is_blacklisted')
        .eq('domain', domain)
        .maybeSingle()
      if (outlet) {
        if (outlet.is_blacklisted) {
          results.push({ url, status: 'error', reason: 'outlet blacklisted' })
          continue
        }
        outletId = outlet.id
      } else {
        const { data: newOutlet } = await supabase
          .from('outlets')
          .insert({
            name: domainToOutletName(domain),
            domain,
            country: detectOutletCountry(domain),
            tier: 'C',
            is_active: true,
          })
          .select('id').single()
        if (newOutlet) outletId = newOutlet.id
      }
    } catch (err) {
      console.warn(`[import] outlet resolve failed for ${url}:`, err)
    }

    let territory: string | null = body.territory ?? null
    if (!territory) {
      try { territory = inferTerritory(domain) } catch { /* ignore */ }
    }

    const { data: inserted, error } = await supabase
      .from('coverage_items')
      .insert({
        client_id: game.client_id,
        game_id: game.id,
        outlet_id: outletId,
        title: `[Manual import] ${domain}`,  // AI enrichment will replace this with real page title
        url,
        publish_date: null,  // AI enrichment may fill this from fetched page
        coverage_type: coverageType,
        territory,
        source_type: sourceType,
        source_metadata: {
          manual_import: true,
          imported_by: body.imported_by || 'unknown',
          notes: body.notes || null,
          imported_at: new Date().toISOString(),
        },
        approval_status: 'pending_review',
        discovered_at: new Date().toISOString(),
      })
      .select('id').single()
    if (error) {
      results.push({ url, status: 'error', reason: error.message })
    } else {
      results.push({ url, status: 'inserted', coverage_item_id: inserted?.id })
    }
  }

  const inserted = results.filter(r => r.status === 'inserted').length
  const dup = results.filter(r => r.status === 'duplicate').length
  const errs = results.filter(r => r.status === 'error' || r.status === 'invalid_url').length

  return NextResponse.json({
    message: `Imported ${inserted} new, ${dup} duplicates, ${errs} errored for "${game.name}"`,
    game: game.name,
    summary: { inserted, duplicate: dup, errors: errs, total: results.length },
    results,
  })
}
