/**
 * POST /api/coverage-health/creator-watch
 *
 * Scans YouTube channels in the creator_watch table for recent videos that
 * mention any of the game's keywords. Uses the free YouTube Data API v3
 * (search.list with channelId filter) — 100 units per creator scan.
 *
 * Body (JSON):
 *   { game_id?: string, creator_id?: string, days_lookback?: number }
 *
 * - game_id only: scan all enabled creators for that game
 * - creator_id only: scan a specific creator
 * - no params: scan all enabled creators (max 5 per call to avoid Vercel timeout)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { detectOutletCountry } from '@/lib/outlet-country'
import { inferTerritory } from '@/lib/territory'
import { searchVideos, getChannelStats, resolveChannelId } from '@/lib/youtube-data-api'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

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

export async function POST(request: NextRequest) {
  const supabase = getServerSupabase()
  const body = await request.json().catch(() => ({}))
  const { game_id, creator_id, days_lookback: overrideDays } = body

  // Resolve YouTube Data API key — env var first, then DB
  const ytApiKey: string | undefined =
    process.env.YOUTUBE_DATA_API_KEY ||
    (await supabase
      .from('service_api_keys')
      .select('api_key')
      .eq('service_name', 'youtube_data_api')
      .eq('is_active', true)
      .maybeSingle()
      .then(({ data }) => data?.api_key as string | undefined))

  if (!ytApiKey) {
    return NextResponse.json({ error: 'YouTube Data API key not configured (YOUTUBE_DATA_API_KEY)' }, { status: 400 })
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

    // Resolve channel ID from the stored URL
    const channelId = await resolveChannelId(ytApiKey, creator.channel_url)
    if (!channelId) {
      results.push({
        creator: creator.channel_name,
        channel_url: creator.channel_url,
        videos_found: 0,
        inserted: 0,
        skipped: 0,
        error: `Could not resolve channel ID from URL: ${creator.channel_url}`,
      })
      await supabase.from('creator_watch').update({ last_checked_at: new Date().toISOString() }).eq('id', creator.id)
      continue
    }

    // Fetch game keywords for relevance scoring
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

    // Compute publishedAfter cutoff
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - lookback)
    const publishedAfter = cutoff.toISOString()

    // Fetch recent videos from the channel via YouTube Data API (100 units)
    const { items: videos } = await searchVideos(ytApiKey, {
      query: '',
      channelId,
      maxResults: MAX_VIDEOS_PER_CREATOR,
      publishedAfter,
    })

    // Fetch subscriber count (channels.list = 1 unit)
    const statsMap = await getChannelStats(ytApiKey, [channelId])
    const subs = statsMap.get(channelId)?.subscribers ?? null

    // Find or create outlet
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

    let inserted = 0
    let skipped = 0

    for (const v of videos) {
      const url = `https://www.youtube.com/watch?v=${v.videoId}`
      const cleanUrl = url.split('&t=')[0]
      const norm = normalizeUrl(cleanUrl)
      if (existingUrls.has(norm)) { skipped++; continue }
      existingUrls.add(norm)

      const title = (v.title || 'Untitled Video').substring(0, 500)
      const titleLower = title.toLowerCase()
      const descLower = (v.description || '').toLowerCase()
      const keywordMatch = keywords.length === 0 || keywords.some(k => titleLower.includes(k) || descLower.includes(k))

      const { error } = await supabase.from('coverage_items').insert({
        client_id: creator.client_id,
        game_id: creator.game_id,
        outlet_id: outletId,
        title,
        url: cleanUrl,
        publish_date: v.publishedAt ? new Date(v.publishedAt).toISOString().split('T')[0] : null,
        coverage_type: 'video',
        monthly_unique_visitors: subs,
        territory: inferTerritory(null, null, null),
        source_type: 'youtube',
        source_metadata: {
          creator_watch: true,
          creator_id: creator.id,
          channel_name: creator.channel_name,
          channel_url: creator.channel_url,
          channel_id: channelId,
          subscribers: subs,
          keyword_match: keywordMatch,
        },
        approval_status: 'pending_review',
        discovered_at: new Date().toISOString(),
      })
      if (!error) inserted++
      else skipped++
    }

    // Update last_checked_at and total_matches
    if (inserted > 0) {
      const { data: cw } = await supabase.from('creator_watch').select('total_matches').eq('id', creator.id).single()
      await supabase.from('creator_watch').update({
        total_matches: (cw?.total_matches || 0) + inserted,
        last_checked_at: new Date().toISOString(),
      }).eq('id', creator.id)
    } else {
      await supabase.from('creator_watch').update({ last_checked_at: new Date().toISOString() }).eq('id', creator.id)
    }

    results.push({
      creator: creator.channel_name,
      channel_url: creator.channel_url,
      videos_found: videos.length,
      inserted,
      skipped,
      error: null,
    })
  }

  const totalInserted = results.reduce((s, r) => s + r.inserted, 0)
  return NextResponse.json({
    message: `Creator Watch scan complete: ${totalInserted} new videos found across ${results.length} creator(s)`,
    scanned: results.length,
    total_inserted: totalInserted,
    elapsed_ms: Date.now() - t0,
    results,
  })
}
