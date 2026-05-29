/**
 * GET /api/cron/youtube-data-api-scan
 *
 * Free YouTube discovery via Google's YouTube Data API. Runs alongside the
 * Apify YouTube scanner: when Apify quota is exhausted (or for any games
 * whose Apify scan was skipped that day), this cron still finds videos.
 *
 * Cost: $0 — uses the free 10K units/day project quota. Each search.list
 * call costs 100 units. We scan ~28 searches/day (7 games × 4 variants),
 * leaving ~70 calls/day headroom.
 *
 * Auth: same Bearer CRON_SECRET as the other scanners.
 *
 * Requires YOUTUBE_DATA_API_KEY in env. If missing, returns a graceful skip.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { verifyCronAuth } from '@/lib/cron-auth'
import { searchVideos, getChannelStats, type YouTubeSearchResult } from '@/lib/youtube-data-api'
import { detectOutletCountry } from '@/lib/outlet-country'
import { inferTerritory } from '@/lib/territory'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

const MAX_QUERIES_PER_GAME = 4
const RESULTS_PER_QUERY = 50

// Language rotation: YouTube Data API supports relevanceLanguage to bias
// results toward a specific locale. Big international creators (MiawAug=ID,
// iTownGamePlay=ES, Iker Unzu=ES, Windah Basudara=ID, etc.) are completely
// invisible to English-default queries. Rotate through one language per
// day-of-week so over a week we cover every major gaming locale.
const LANGUAGE_ROTATION = ['', 'id', 'es', 'pt', 'de', 'fr', 'ja'] // index by day_of_week (Sun=0)

interface KeywordRow {
  keyword: string
  client_id: string
  game_id: string | null
}

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request)
  if (authError) return authError

  const supabase = getServerSupabase()

  const apiKey = process.env.YOUTUBE_DATA_API_KEY
  if (!apiKey) {
    return NextResponse.json({
      message: 'YOUTUBE_DATA_API_KEY not configured; YouTube Data API scan skipped',
    })
  }

  // Pull whitelist keywords grouped by game
  const { data: keywords } = await supabase
    .from('coverage_keywords')
    .select('keyword, client_id, game_id')
    .eq('keyword_type', 'whitelist')
    .eq('is_active', true)
  if (!keywords || keywords.length === 0) {
    return NextResponse.json({ message: 'No keywords configured' })
  }

  // Pull active PR-tracked games so we don't waste budget on disabled ones
  const { data: prGames } = await supabase
    .from('games')
    .select('id')
    .eq('pr_tracking_enabled', true)
  const allowed = new Set((prGames || []).map((g: { id: string }) => g.id))

  // Group keywords by client+game
  type Group = { client_id: string; game_id: string | null; variants: string[] }
  const groups = new Map<string, Group>()
  for (const k of (keywords as KeywordRow[])) {
    if (k.game_id && !allowed.has(k.game_id)) continue
    const key = `${k.client_id}|${k.game_id || ''}`
    if (!groups.has(key)) {
      groups.set(key, { client_id: k.client_id, game_id: k.game_id, variants: [] })
    }
    groups.get(key)!.variants.push(k.keyword)
  }

  // Dedupe existing URLs for cheap inserts
  const { data: existing } = await supabase
    .from('coverage_items')
    .select('url')
    .like('url', '%youtube.com%')
    .limit(20000)
  const existingUrls = new Set((existing || []).map((r: { url: string }) => r.url.split('&')[0]))

  // Scan window: last 24h (matches the Apify scanner's 'today' filter)
  const publishedAfter = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  // Pick today's relevance language for international creator discovery.
  // '' (empty) means default English — runs on Sunday so weekly cadence is
  // ['(en)', id, es, pt, de, fr, ja].
  const dayOfWeek = new Date().getUTCDay()  // 0=Sun, 6=Sat
  const relevanceLanguage = LANGUAGE_ROTATION[dayOfWeek] || ''

  let totalFound = 0
  let totalInserted = 0
  let totalSearches = 0
  const errors: string[] = []
  const newChannelIds = new Set<string>()
  const insertedItems: Array<{ id: string; channelId: string }> = []

  for (const [, group] of Array.from(groups.entries())) {
    const variants = group.variants.slice(0, MAX_QUERIES_PER_GAME)
    for (const variant of variants) {
      try {
        const results = await searchVideos(apiKey, {
          query: variant,
          maxResults: RESULTS_PER_QUERY,
          publishedAfter,
          ...(relevanceLanguage ? { relevanceLanguage } : {}),
        })
        totalSearches++
        totalFound += results.length
        for (const r of results) {
          const url = `https://www.youtube.com/watch?v=${r.videoId}`
          if (existingUrls.has(url)) continue
          existingUrls.add(url)

          // Insert outlet for the channel (auto-creates if new)
          const channelDomain = `youtube.com/channel/${r.channelId}`
          const { data: outlet } = await supabase
            .from('outlets')
            .select('id')
            .ilike('domain', `%${r.channelId}%`)
            .limit(1)
          let outletId: string | null = outlet?.[0]?.id || null
          if (!outletId) {
            const { data: newOutlet } = await supabase
              .from('outlets')
              .insert({
                name: r.channelTitle || 'Unknown YouTube Channel',
                domain: channelDomain,
                country: detectOutletCountry(channelDomain),
                tier: 'D',
                is_active: true,
              })
              .select('id').single()
            if (newOutlet) outletId = newOutlet.id
          }

          newChannelIds.add(r.channelId)

          const publishDate = r.publishedAt ? r.publishedAt.split('T')[0] : null
          const { data: insRow, error } = await supabase
            .from('coverage_items')
            .insert({
              client_id: group.client_id,
              game_id: group.game_id,
              outlet_id: outletId,
              title: r.title,
              url,
              publish_date: publishDate,
              coverage_type: 'video',
              territory: inferTerritory(null, null, null),
              source_type: 'youtube',
              source_metadata: {
                video_id: r.videoId,
                channel_id: r.channelId,
                channel_title: r.channelTitle,
                youtube_data_api: true,  // distinguish from Apify-discovered items
                search_query: variant,
              },
              approval_status: 'pending_review',
              discovered_at: new Date().toISOString(),
            })
            .select('id')
            .single()
          if (!error && insRow) {
            totalInserted++
            insertedItems.push({ id: insRow.id, channelId: r.channelId })
          }
        }
      } catch (err) {
        errors.push(`${variant}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // Enrich with channel subscriber counts (1 unit per 50 channels — cheap).
  // We use this to populate monthly_unique_visitors on the items we just
  // inserted (a rough proxy for "audience reach"), so the Coverage Feed UI
  // can sort/filter by it consistently with other sources.
  if (newChannelIds.size > 0 && insertedItems.length > 0) {
    try {
      const stats = await getChannelStats(apiKey, Array.from(newChannelIds))
      for (const it of insertedItems) {
        const s = stats.get(it.channelId)
        if (!s) continue
        await supabase
          .from('coverage_items')
          .update({ monthly_unique_visitors: s.subscribers })
          .eq('id', it.id)
      }
    } catch (err) {
      errors.push(`channel-stats: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return NextResponse.json({
    message: `YouTube Data API scan complete: ${totalInserted}/${totalFound} new items across ${totalSearches} searches${relevanceLanguage ? ` (lang=${relevanceLanguage})` : ' (lang=default)'}`,
    relevance_language: relevanceLanguage || 'default',
    found: totalFound,
    inserted: totalInserted,
    searches: totalSearches,
    estimated_units_used: totalSearches * 100 + Math.ceil(newChannelIds.size / 50),
    errors_count: errors.length,
    errors: errors.slice(0, 10),
  })
}
