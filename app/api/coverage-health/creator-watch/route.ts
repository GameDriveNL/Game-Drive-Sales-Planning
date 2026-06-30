/**
 * POST /api/coverage-health/creator-watch
 *
 * Scans YouTube channels in the creator_watch table for recent videos that
 * mention any of the game's keywords. This solves the "creator doesn't put
 * the game name in the title" gap: once a known creator is added to the watch
 * list, ALL their recent uploads are surfaced for review — not just the ones
 * that happen to use searchable keywords.
 *
 * Body (JSON):
 *   { game_id?: string, creator_id?: string, days_lookback?: number }
 *
 * - game_id only: scan all enabled creators for that game
 * - creator_id only: scan a specific creator
 * - no params: scan all enabled creators (max 5 per call to avoid Vercel timeout)
 *
 * Uses Apify streamers/youtube-scraper actor with startUrls (channel URL) to
 * fetch recent videos. Any video within days_lookback is inserted as
 * pending_review into coverage_items.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { detectOutletCountry } from '@/lib/outlet-country'
import { checkApifyCredits, logApifyRun } from '@/lib/apify-utils'
import { inferTerritory } from '@/lib/territory'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

const YT_ACTOR = 'streamers~youtube-scraper'
const MAX_CREATORS_PER_CALL = 5
const MAX_VIDEOS_PER_CREATOR = 25

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    return (u.origin + u.pathname).replace(/\/$/, '')
  } catch {
    return url
  }
}

async function runCreatorScan(
  apifyKey: string,
  channelUrl: string,
  daysLookback: number,
): Promise<{ ok: boolean; data: Array<Record<string, unknown>>; error: string | null }> {
  try {
    const input = {
      startUrls: [{ url: channelUrl }],
      maxResults: MAX_VIDEOS_PER_CREATOR,
      maxResultStreams: 0,
      maxResultsShorts: 0,
      downloadSubtitles: false,
    }
    const res = await fetch(
      `https://api.apify.com/v2/acts/${YT_ACTOR}/run-sync-get-dataset-items?token=${apifyKey}&timeout=240`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
    )
    if (!res.ok) {
      return { ok: false, data: [], error: `HTTP ${res.status}: ${(await res.text()).substring(0, 200)}` }
    }
    const data = await res.json()
    if (!Array.isArray(data)) {
      return { ok: false, data: [], error: 'Unexpected response format from Apify' }
    }
    // Filter to videos within the lookback window
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - daysLookback)
    const recent = data.filter(v => {
      if (!v.date) return true // no date = include
      const published = new Date(v.date as string)
      return published >= cutoff
    })
    return { ok: true, data: recent, error: null }
  } catch (err) {
    return { ok: false, data: [], error: err instanceof Error ? err.message : String(err) }
  }
}

export async function POST(request: NextRequest) {
  const supabase = getServerSupabase()
  const body = await request.json().catch(() => ({}))
  const { game_id, creator_id, days_lookback: overrideDays } = body

  // Fetch Apify key
  const { data: keyData } = await supabase
    .from('service_api_keys').select('api_key').eq('service_name', 'apify').eq('is_active', true).maybeSingle()
  const apifyKey = keyData?.api_key as string | undefined
  if (!apifyKey) return NextResponse.json({ error: 'Apify API key not configured' }, { status: 400 })

  const credits = await checkApifyCredits(apifyKey)
  if (!credits.hasCredits) {
    return NextResponse.json({ error: 'Apify credits insufficient', remaining_usd: credits.remainingUsd }, { status: 503 })
  }

  // Fetch target creators
  let creatorsQuery = supabase
    .from('creator_watch')
    .select('id, channel_url, channel_name, channel_handle, game_id, client_id, days_lookback')
    .eq('enabled', true)

  if (creator_id) {
    creatorsQuery = creatorsQuery.eq('id', creator_id)
  } else if (game_id) {
    creatorsQuery = creatorsQuery.eq('game_id', game_id)
  } else {
    creatorsQuery = creatorsQuery
      .order('last_checked_at', { ascending: true, nullsFirst: true })
      .limit(MAX_CREATORS_PER_CALL)
  }

  const { data: creators } = await creatorsQuery
  if (!creators || creators.length === 0) {
    return NextResponse.json({ message: 'No creators to scan', scanned: 0 })
  }

  const t0 = Date.now()
  const results: Array<{
    creator: string
    channel_url: string
    videos_found: number
    inserted: number
    skipped: number
    error: string | null
  }> = []

  for (const creator of creators) {
    if (Date.now() - t0 > 250_000) break // Vercel timeout guard

    const lookback = overrideDays ?? creator.days_lookback ?? 30

    // Fetch game keywords if game_id set
    let keywords: string[] = []
    if (creator.game_id) {
      const { data: kws } = await supabase
        .from('coverage_keywords')
        .select('keyword')
        .eq('game_id', creator.game_id)
        .eq('keyword_type', 'whitelist')
        .eq('is_active', true)
      keywords = (kws || []).map((k: { keyword: string }) => k.keyword.toLowerCase())
    }

    // Existing URLs to deduplicate
    const { data: existing } = await supabase
      .from('coverage_items')
      .select('url')
      .eq('game_id', creator.game_id || '')
      .limit(50000)
    const existingUrls = new Set<string>((existing || []).map((e: { url: string }) => normalizeUrl(e.url)))

    const scan = await runCreatorScan(apifyKey, creator.channel_url, lookback)
    await logApifyRun(supabase, {
      scanner: `creator-watch/${creator.channel_name.substring(0, 30)}`,
      actor_id: YT_ACTOR,
      input: { channelUrl: creator.channel_url, lookback },
      results_count: scan.data.length,
      http_status: scan.ok ? 200 : null,
      ok: scan.ok,
      error: scan.error,
    })

    if (!scan.ok) {
      results.push({ creator: creator.channel_name, channel_url: creator.channel_url, videos_found: 0, inserted: 0, skipped: 0, error: scan.error })
      continue
    }

    let inserted = 0
    let skipped = 0

    const subs = scan.data.length > 0 ? (Number(scan.data[0].numberOfSubscribers || 0) || null) : null
    const rawHandle = creator.channel_handle || creator.channel_name
    const cleanDomain = `youtube.com/${rawHandle.startsWith('@') ? rawHandle : `@${rawHandle}`}`.toLowerCase()
    const { data: existingOutlet } = await supabase.from('outlets').select('id').eq('domain', cleanDomain).maybeSingle()
    let outletId: string | null = existingOutlet?.id ?? null
    if (!outletId) {
      const tier = subs === null ? 'D'
        : subs >= 1_000_000 ? 'A'
        : subs >= 100_000 ? 'B'
        : subs >= 10_000 ? 'C' : 'D'
      const { data: newO } = await supabase.from('outlets').insert({
        name: creator.channel_name,
        domain: cleanDomain,
        country: detectOutletCountry(cleanDomain),
        monthly_unique_visitors: subs,
        tier,
        is_active: true,
      }).select('id').single()
      outletId = newO?.id ?? null
    }

    for (const v of scan.data) {
      const url = (v.url as string) || (v.id ? `https://www.youtube.com/watch?v=${v.id}` : '')
      if (!url) { skipped++; continue }
      const cleanUrl = url.split('&t=')[0]
      const norm = normalizeUrl(cleanUrl)
      if (existingUrls.has(norm)) { skipped++; continue }
      existingUrls.add(norm)

      const title = ((v.title as string) || 'Untitled Video').substring(0, 500)

      // Keyword relevance check: if we have keywords and the title matches, mark higher confidence
      const titleLower = title.toLowerCase()
      const descLower = ((v.description as string) || '').toLowerCase()
      const keywordMatch = keywords.length === 0 || keywords.some(k => titleLower.includes(k) || descLower.includes(k))
      // Still ingest even if no keyword match — user added this creator specifically
      // but set source_metadata.keyword_match so the feed can surface confidence

      const { error } = await supabase.from('coverage_items').insert({
        client_id: creator.client_id,
        game_id: creator.game_id,
        outlet_id: outletId,
        title,
        url: cleanUrl,
        publish_date: v.date ? new Date(v.date as string).toISOString().split('T')[0] : null,
        coverage_type: 'video',
        monthly_unique_visitors: typeof v.viewCount === 'number' ? v.viewCount : null,
        territory: inferTerritory(null, null, (v.defaultLanguage as string) || null),
        source_type: 'youtube',
        source_metadata: {
          creator_watch: true,
          creator_id: creator.id,
          channel_name: creator.channel_name,
          channel_url: creator.channel_url,
          subscribers: subs,
          views: v.viewCount || 0,
          keyword_match: keywordMatch,
        },
        approval_status: 'pending_review',
        discovered_at: new Date().toISOString(),
      })
      if (!error) inserted++
      else skipped++
    }

    // Update last_checked_at and increment total_matches
    if (inserted > 0) {
      const { data: cw } = await supabase.from('creator_watch').select('total_matches').eq('id', creator.id).single()
      await supabase.from('creator_watch').update({
        total_matches: (cw?.total_matches || 0) + inserted,
        last_checked_at: new Date().toISOString(),
      }).eq('id', creator.id)
    } else {
      await supabase.from('creator_watch').update({ last_checked_at: new Date().toISOString() }).eq('id', creator.id)
    }

    results.push({ creator: creator.channel_name, channel_url: creator.channel_url, videos_found: scan.data.length, inserted, skipped, error: null })
  }

  const totalInserted = results.reduce((s, r) => s + r.inserted, 0)
  return NextResponse.json({
    message: `Creator Watch scan complete: ${totalInserted} new videos found across ${results.length} creator(s)`,
    scanned: results.length,
    total_inserted: totalInserted,
    apify_remaining_usd: credits.remainingUsd,
    elapsed_ms: Date.now() - t0,
    results,
  })
}
