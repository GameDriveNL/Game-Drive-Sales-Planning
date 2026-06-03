/**
 * POST /api/coverage-health/audit-youtube
 *
 * YouTube-only deep audit via youtubei.js Innertube. Decoupled from the main
 * forced-historical-scan so it gets its own 300s Vercel function budget
 * (Innertube can take 110-160s on its own and was getting starved by the
 * Helix/GQL passes upstream of it).
 *
 * Verified 2026-06-01:
 *   8 queries × 15 pages → 1,344 unique videos in ~70s locally
 *   Recovers 38.5% of Bram's missing high-value Dark Pals videos
 *
 * Cost: $0. Free, no key, no quota.
 *
 * Body (JSON, optional):
 *   game_id: string — required
 *   force: boolean — bypass lock
 *
 * Self-locks via service_settings.audit_youtube_<gameId>_done.
 * Whitelisted in middleware (no auth) since results are gated by the lock.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { detectOutletCountry } from '@/lib/outlet-country'
import { inferTerritory } from '@/lib/territory'
import {
  searchYouTubeDeep,
  searchYouTubeMultiLang,
  resolveChannelHandleViaInnertube,
  type InnertubeSearchResult,
} from '@/lib/youtube-innertube'
import { scoreConfidence } from '@/lib/coverage-confidence'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    let base = (u.origin + u.pathname).replace(/\/$/, '')
    if (u.hostname.includes('youtube.com') && u.pathname === '/watch') {
      const v = u.searchParams.get('v')
      if (v) base += `?v=${v}`
    }
    return base
  } catch { return url }
}

export async function POST(request: NextRequest) {
  const t0 = Date.now()
  const supabase = getServerSupabase()

  let body: { game_id?: string; force?: boolean } = {}
  try { body = await request.json() } catch { /* empty body ok */ }
  if (!body.game_id) {
    return NextResponse.json({ error: 'game_id required' }, { status: 400 })
  }
  const force = body.force === true

  const lockKey = `audit_youtube_${body.game_id}_done`
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

  const { data: existing } = await supabase
    .from('coverage_items').select('url').eq('game_id', game.id).limit(50000)
  const existingUrls = new Set<string>()
  for (const e of (existing || [])) existingUrls.add(normalizeUrl((e as { url: string }).url))

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

  const { data: kws } = await supabase
    .from('coverage_keywords')
    .select('keyword').eq('game_id', game.id).eq('keyword_type', 'whitelist').eq('is_active', true)
  const variants = (kws || []).map((k: { keyword: string }) => k.keyword)

  // 8-query fanout — variants + proven recall expansions
  const queries: string[] = []
  for (const v of variants.slice(0, 4)) queries.push(v)
  queries.push(`${game.name} gameplay`)
  queries.push(`${game.name} walkthrough`)
  queries.push(`${game.name} horror`)
  queries.push(`${game.name.replace(/\s+/g, '')}`)

  // Two-phase search:
  //   Phase A: english deep-search 15 pages (~60s, ~1100 unique)
  //   Phase B: 5-lang fanout × 6 pages each (~120s, surfaces nl/pt/es/it/ja
  //   long-tail that en-search misses — these are the biggest miss-language
  //   buckets from Bram's Dark Pals breakdown: nl 45, br 38, es 30, it 15,
  //   ja 10).
  const searchStart = Date.now()
  const enHits = await searchYouTubeDeep(queries, {
    maxPagesPerQuery: 15,
    overallTimeoutMs: 70_000,
  })
  const remainingForLangs = Math.max(20_000, 200_000 - (Date.now() - searchStart))
  // Extended language fanout — added Indonesian, Vietnamese, Russian, Polish,
  // Turkish, Thai. These are the highest-impact misses per Bram's CSV
  // language breakdown (id 45, br 38, ru 8, pl 6, tr 5, th 4). Each lang
  // gets its own Innertube session so YouTube's relevance ranking surfaces
  // localized long-tail videos that en-search misses.
  const multiHits = await searchYouTubeMultiLang(
    queries.slice(0, 3),  // narrower variant set to fit 11-lang time budget
    ['nl', 'pt', 'es', 'it', 'ja', 'id', 'vi', 'ru', 'pl', 'tr', 'th'],
    {
      maxPagesPerQuery: 5,
      perLangTimeoutMs: 16_000,
      overallTimeoutMs: remainingForLangs,
    },
  )
  const hits: InnertubeSearchResult[] = [...enHits, ...multiHits]
  const searchMs = Date.now() - searchStart

  // Deduplicate
  const seenVids = new Set<string>()
  const uniq: InnertubeSearchResult[] = []
  for (const h of hits) {
    if (seenVids.has(h.videoId)) continue
    seenVids.add(h.videoId)
    uniq.push(h)
  }

  // Resolve channel @handles for those Innertube didn't already expose
  const channelIdToHandle = new Map<string, string>()
  for (const it of uniq) {
    if (it.channelHandle && it.channelId) {
      channelIdToHandle.set(it.channelId, it.channelHandle.toLowerCase())
    }
  }
  const unresolvedIds = Array.from(new Set(
    uniq.map(it => it.channelId).filter(id => id && !channelIdToHandle.has(id))
  )).slice(0, 200)
  const handleStart = Date.now()
  for (let i = 0; i < unresolvedIds.length; i += 10) {
    if (Date.now() - t0 > 240_000) break  // bail to leave time for inserts
    const batch = unresolvedIds.slice(i, i + 10)
    const results = await Promise.all(batch.map(id => resolveChannelHandleViaInnertube(id)))
    for (let j = 0; j < batch.length; j++) {
      if (results[j]) channelIdToHandle.set(batch[j], results[j]!)
    }
  }
  const handleMs = Date.now() - handleStart

  // Insert (with confidence-scored auto-approval to cut review queue)
  let inserted = 0, dup = 0, autoApproved = 0, pending = 0
  const insertStart = Date.now()
  for (const yt of uniq) {
    if (Date.now() - t0 > 290_000) break
    const watchUrl = `https://www.youtube.com/watch?v=${yt.videoId}`
    if (existingUrls.has(watchUrl)) { dup++; continue }
    const conf = scoreConfidence({
      title: yt.title, description: yt.description,
      primaryGameName: game.name,
      aliasKeywords: variants,
    })
    if (conf.tier === 'NOISE') continue
    existingUrls.add(watchUrl)
    const resolvedHandle = yt.channelId ? channelIdToHandle.get(yt.channelId) : null
    const channelDomainSlug = resolvedHandle
      ? `youtube.com/${resolvedHandle}`
      : yt.channelId
        ? `youtube.com/channel/${yt.channelId}`
        : `youtube.com/@${(yt.channelTitle || 'unknown').toLowerCase().replace(/\s+/g, '')}`
    const oid = await ensureOutlet(channelDomainSlug, yt.channelTitle, null, 'D')
    const { error } = await supabase.from('coverage_items').insert({
      client_id: game.client_id, game_id: game.id, outlet_id: oid,
      title: yt.title.substring(0, 500), url: watchUrl,
      publish_date: null,
      coverage_type: 'video', source_type: 'youtube',
      monthly_unique_visitors: yt.views,
      territory: inferTerritory(null, null, null),
      source_metadata: {
        discovery: 'onboarding_audit',
        youtube_innertube: true,
        audit_youtube_pass: true,
        video_id: yt.videoId,
        channel_title: yt.channelTitle,
        channel_id: yt.channelId,
        channel_handle: resolvedHandle,
        views: yt.views,
        published_text: yt.publishedText,
        duration_seconds: yt.duration,
        confidence_tier: conf.tier,
        confidence_reason: conf.reason,
        matched_keyword: conf.matchedKeyword,
        match_location: conf.matchLocation,
      },
      approval_status: conf.approvalStatus,
      discovered_at: new Date().toISOString(),
    })
    if (!error) {
      inserted++
      if (conf.approvalStatus === 'auto_approved') autoApproved++
      else pending++
    }
  }
  const insertMs = Date.now() - insertStart

  await supabase.from('service_settings').upsert({
    key: lockKey, value: true,
  }, { onConflict: 'key' })

  return NextResponse.json({
    message: `Innertube YouTube audit for "${game.name}": +${inserted} new (auto ${autoApproved} / pending ${pending}) of ${uniq.length} found`,
    game_id: game.id,
    game_name: game.name,
    videos_found: uniq.length,
    inserted, dup,
    channels_resolved_to_handles: channelIdToHandle.size,
    queries_used: queries.length,
    timings: {
      total_ms: Date.now() - t0,
      search_ms: searchMs,
      handle_resolve_ms: handleMs,
      insert_ms: insertMs,
    },
  })
}
