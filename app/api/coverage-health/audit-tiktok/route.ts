/**
 * POST /api/coverage-health/audit-tiktok
 *
 * TikTok creator handle enumeration via free sources (no Apify).
 *
 * Strategy (proven 2026-06-01 in local manual test):
 *   1. Tavily site:tiktok.com queries → extract @handles from result URLs
 *   2. YouTube video descriptions (via existing youtube items + Innertube
 *      getVideoDescription) → many YouTubers cross-promote their TikTok
 *   3. For each unique handle, StalkUser to verify it exists and pull
 *      follower count for tier classification
 *
 * Cost: $0 (Tavily already budgeted at ~$0.02/scan, StalkUser is free).
 *
 * Self-locks via service_settings.audit_tiktok_<gameId>_done.
 * Whitelisted in middleware.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { detectOutletCountry } from '@/lib/outlet-country'
import { inferTerritory } from '@/lib/territory'
import {
  stalkTikTokUser,
  extractTikTokHandles,
  classifyTier,
} from '@/lib/tiktok-stalk'
import { getVideoDescription } from '@/lib/youtube-innertube'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

export async function POST(request: NextRequest) {
  const t0 = Date.now()
  const supabase = getServerSupabase()

  let body: { game_id?: string; force?: boolean; max_handles?: number } = {}
  try { body = await request.json() } catch { /* empty body ok */ }
  if (!body.game_id) {
    return NextResponse.json({ error: 'game_id required' }, { status: 400 })
  }
  const force = body.force === true
  const maxHandles = Math.min(body.max_handles ?? 200, 500)

  const lockKey = `audit_tiktok_${body.game_id}_done`
  if (!force) {
    const { data: lockRow } = await supabase
      .from('service_settings').select('value').eq('key', lockKey).maybeSingle()
    if (lockRow?.value === true || lockRow?.value === 'true') {
      return NextResponse.json({
        error: 'Already ran. Pass force:true to re-run.',
        lock_key: lockKey,
      }, { status: 410 })
    }
  }

  const { data: game } = await supabase
    .from('games').select('id, name, client_id').eq('id', body.game_id).single()
  if (!game) return NextResponse.json({ error: 'Game not found' }, { status: 404 })

  const candidateHandles = new Set<string>()
  const sourceSignals = new Map<string, string[]>()
  function addCandidate(handle: string, source: string) {
    const clean = handle.replace(/^@+/, '').toLowerCase()
    if (!clean || clean.length < 2) return
    candidateHandles.add(clean)
    const arr = sourceSignals.get(clean) || []
    arr.push(source)
    sourceSignals.set(clean, arr)
  }

  // ─── Source 1: Tavily site:tiktok.com queries ─────────────────────────
  const { data: tavRow } = await supabase
    .from('service_api_keys').select('api_key').eq('service_name', 'tavily').eq('is_active', true).maybeSingle()
  const tavKey = tavRow?.api_key as string | undefined

  const { data: kws } = await supabase
    .from('coverage_keywords')
    .select('keyword').eq('game_id', game.id).eq('keyword_type', 'whitelist').eq('is_active', true)
  const variants = (kws || []).map((k: { keyword: string }) => k.keyword)

  const tavQueries = [
    `site:tiktok.com "${game.name}"`,
    `site:tiktok.com "${variants[0] || game.name}"`,
    `site:tiktok.com "${game.name}" gameplay`,
  ]
  const tavilyStart = Date.now()
  let tavilyResults = 0
  if (tavKey) {
    for (const q of tavQueries) {
      if (Date.now() - t0 > 60_000) break
      try {
        const r = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: tavKey, query: q, max_results: 50, search_depth: 'advanced',
          }),
        })
        if (!r.ok) continue
        const data = await r.json() as { results?: Array<{ url?: string; content?: string }> }
        for (const it of (data.results || [])) {
          tavilyResults++
          if (it.url) for (const h of extractTikTokHandles(it.url)) addCandidate(h, `tavily:${q.substring(0, 30)}`)
          if (it.content) for (const h of extractTikTokHandles(it.content)) addCandidate(h, `tavily-content`)
        }
      } catch { /* skip */ }
    }
  }
  const tavilyMs = Date.now() - tavilyStart

  // ─── Source 2: YouTube video descriptions (existing items) ────────────
  // Pull YouTube video IDs from this game's coverage_items, then fetch
  // descriptions from a sample of high-view-count ones.
  const { data: ytItems } = await supabase
    .from('coverage_items')
    .select('source_metadata, monthly_unique_visitors')
    .eq('game_id', game.id)
    .eq('source_type', 'youtube')
    .order('monthly_unique_visitors', { ascending: false, nullsFirst: false })
    .limit(150)
  const videoIds: string[] = (ytItems || [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map(it => (it.source_metadata as any)?.video_id)
    .filter((id): id is string => typeof id === 'string')
  const xrefStart = Date.now()
  let descsFetched = 0
  for (let i = 0; i < videoIds.length; i += 10) {
    if (Date.now() - t0 > 130_000) break
    const batch = videoIds.slice(i, i + 10)
    const descs = await Promise.all(batch.map(id => getVideoDescription(id)))
    for (const d of descs) {
      if (d.length > 0) {
        descsFetched++
        for (const h of extractTikTokHandles(d)) addCandidate(h, 'yt-desc-xref')
      }
    }
  }
  const xrefMs = Date.now() - xrefStart

  // ─── Source 3: existing TikTok handles we've seen for any game ─────────
  // (so we re-verify creators that appear across the network — useful for
  // PR-meaningful tier classification regardless of which game found them
  // first)
  // Disabled by default to keep this scan game-specific. Re-enable later if
  // we want network-wide TikTok creator hygiene.

  // ─── Verify each candidate via StalkUser ──────────────────────────────
  const stalkStart = Date.now()
  const candidates = Array.from(candidateHandles).slice(0, maxHandles)
  const verified: Array<{ handle: string; followers: number; displayName: string; bio: string; verified: boolean }> = []
  for (let i = 0; i < candidates.length; i += 5) {
    if (Date.now() - t0 > 260_000) break
    const batch = candidates.slice(i, i + 5)
    const results = await Promise.all(batch.map(h => stalkTikTokUser(h)))
    for (let j = 0; j < batch.length; j++) {
      const r = results[j]
      if (!r) continue
      verified.push({
        handle: r.handle,
        followers: r.followerCount,
        displayName: r.displayName,
        bio: r.bio,
        verified: r.isVerified,
      })
    }
  }
  const stalkMs = Date.now() - stalkStart

  // ─── Dedup vs existing tiktok items ───────────────────────────────────
  const { data: existing } = await supabase
    .from('coverage_items').select('url').eq('game_id', game.id)
    .like('url', '%tiktok.com/@%')
  const existingHandles = new Set<string>()
  for (const e of (existing || [])) {
    const m = (e as { url: string }).url.match(/tiktok\.com\/@([\w.\-]+)/i)
    if (m) existingHandles.add(m[1].toLowerCase())
  }

  // ─── Insert ────────────────────────────────────────────────────────────
  let inserted = 0
  const outletCache = new Map<string, string | null>()
  async function ensureOutlet(domain: string, name: string, muv: number | null, tier: string): Promise<string | null> {
    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').toLowerCase()
    if (outletCache.has(cleanDomain)) return outletCache.get(cleanDomain)!
    const { data: o } = await supabase.from('outlets').select('id').eq('domain', cleanDomain).maybeSingle()
    if (o?.id) { outletCache.set(cleanDomain, o.id); return o.id }
    const { data: newO } = await supabase.from('outlets').insert({
      name, domain: cleanDomain,
      country: detectOutletCountry(cleanDomain),
      monthly_unique_visitors: muv,
      tier, is_active: true,
    }).select('id').single()
    const id = newO?.id ?? null
    outletCache.set(cleanDomain, id)
    return id
  }

  for (const v of verified) {
    if (existingHandles.has(v.handle)) continue
    existingHandles.add(v.handle)
    const profileUrl = `https://www.tiktok.com/@${v.handle}`
    const tier = classifyTier(v.followers)
    const oid = await ensureOutlet(
      `tiktok.com/@${v.handle}`,
      v.displayName,
      v.followers || null,
      tier,
    )
    const { error } = await supabase.from('coverage_items').insert({
      client_id: game.client_id, game_id: game.id, outlet_id: oid,
      title: `${v.displayName} — TikTok creator covering ${game.name}`,
      url: profileUrl,
      publish_date: null,
      coverage_type: 'video', source_type: 'tiktok',
      monthly_unique_visitors: v.followers || null,
      territory: inferTerritory(null, null, null),
      source_metadata: {
        discovery: 'onboarding_audit',
        audit_tiktok_pass: true,
        handle: v.handle,
        followers: v.followers,
        is_verified: v.verified,
        bio: v.bio.substring(0, 200),
        sources_signaled: sourceSignals.get(v.handle) || [],
      },
      approval_status: 'pending_review',
      discovered_at: new Date().toISOString(),
    })
    if (!error) inserted++
  }

  await supabase.from('service_settings').upsert({
    key: lockKey, value: true,
  }, { onConflict: 'key' })

  return NextResponse.json({
    message: `TikTok audit for "${game.name}": +${inserted} verified creators`,
    game_id: game.id, game_name: game.name,
    candidates_collected: candidates.length,
    candidates_total_from_sources: candidateHandles.size,
    verified_count: verified.length,
    inserted,
    tavily: { results: tavilyResults, queries: tavQueries.length, ms: tavilyMs },
    yt_description_xref: { descriptions_fetched: descsFetched, video_id_sample: videoIds.length, ms: xrefMs },
    stalk: { attempted: candidates.length, ok: verified.length, ms: stalkMs },
    total_ms: Date.now() - t0,
  })
}
