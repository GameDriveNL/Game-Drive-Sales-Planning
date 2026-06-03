/**
 * GET /api/cron/tiktok-profile-poll
 *
 * TikTok creator-graph forward poll. Runs daily at 03:00 UTC.
 *
 * For every known TikTok @handle (from past discovery via audit-tiktok), we:
 *   1. Stalk the profile via @tobyg74/tiktok-api-dl → up-to-date follower
 *      count and "videoCount" stat (telling us if there are new uploads)
 *   2. If `videoCount > stored_last_videoCount`, scrape the profile page's
 *      embedded SIGI_STATE JSON for the latest few video IDs + captions
 *   3. Filter for game-keyword match in caption
 *   4. Insert any new ones, scoring via the shared confidence helper
 *
 * This is the same mechanism Bram's tool uses — TikTok doesn't have RSS,
 * but the profile HTML carries enough JSON for forward discovery without
 * any paid API.
 *
 * Cost: $0. No Apify, no key. StalkUser confirmed working 2026-06-03 for
 * 4/4 test handles.
 *
 * Auth: Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { verifyCronAuth } from '@/lib/cron-auth'
import { detectOutletCountry } from '@/lib/outlet-country'
import { stalkTikTokUser, classifyTier } from '@/lib/tiktok-stalk'
import { scoreConfidence } from '@/lib/coverage-confidence'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

// Cap per-run — keeps each invocation under 300s. Handles are processed
// oldest-first by rotation so every handle gets visited at least every
// (HANDLES_PER_RUN × 24h / total_handles) interval.
const HANDLES_PER_RUN = 200
const CONCURRENCY = 5

interface TikTokScrapeResult {
  videoId: string
  description: string
  createTimeISO: string | null
  playCount: number | null
  diggCount: number | null
}

/**
 * Scrape a TikTok profile page for its most-recent video list. We pull the
 * HTML and look for the SIGI_STATE embedded JSON, which contains the user's
 * recent posts. This is brittle (TikTok's HTML structure changes) but free
 * and works for the common case.
 *
 * Returns up to ~20 most-recent videos. Caller filters for game matches.
 */
async function scrapeRecentVideos(handle: string): Promise<TikTokScrapeResult[]> {
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 15_000)
    const r = await fetch(`https://www.tiktok.com/@${handle}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'text/html',
      },
      signal: ctl.signal,
    })
    clearTimeout(timer)
    if (!r.ok) return []
    const html = await r.text()
    // Look for the universal data script: <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"
    const dataMatch = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/)
    if (!dataMatch) return []
    let data: unknown
    try { data = JSON.parse(dataMatch[1]) } catch { return [] }
    // Walk the structure to find ItemList or webapp.user-detail
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const root = data as any
    const scope = root?.__DEFAULT_SCOPE__
    const userDetail = scope?.['webapp.user-detail'] || scope?.UserDetail
    const itemList = userDetail?.itemList || userDetail?.userInfo?.itemList || scope?.ItemList
    let items: unknown[] = []
    if (Array.isArray(itemList)) items = itemList
    else if (itemList && typeof itemList === 'object') items = Object.values(itemList).flat()
    return items
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((it: any) => ({
        videoId: it?.id || '',
        description: it?.desc || '',
        createTimeISO: it?.createTime ? new Date(Number(it.createTime) * 1000).toISOString() : null,
        playCount: typeof it?.stats?.playCount === 'number' ? it.stats.playCount : null,
        diggCount: typeof it?.stats?.diggCount === 'number' ? it.stats.diggCount : null,
      }))
      .filter(v => v.videoId)
  } catch {
    return []
  }
}

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request)
  if (authError) return authError

  const supabase = getServerSupabase()
  const t0 = Date.now()

  // PR-tracked games + keywords for confidence scoring
  const { data: games } = await supabase
    .from('games').select('id, name, client_id').eq('pr_tracking_enabled', true)
  if (!games || games.length === 0) {
    return NextResponse.json({ message: 'No PR-tracked games' })
  }
  const { data: kws } = await supabase
    .from('coverage_keywords')
    .select('game_id, keyword')
    .eq('keyword_type', 'whitelist').eq('is_active', true)
    .in('game_id', games.map(g => g.id))
  const keywordsByGame = new Map<string, string[]>()
  for (const k of (kws || []) as Array<{ game_id: string; keyword: string }>) {
    if (!keywordsByGame.has(k.game_id)) keywordsByGame.set(k.game_id, [])
    keywordsByGame.get(k.game_id)!.push(k.keyword)
  }

  // Collect all known TikTok handles in our coverage_items, grouped by which
  // games we've seen them cover.
  const { data: ttRows } = await supabase
    .from('coverage_items')
    .select('source_metadata, game_id')
    .eq('source_type', 'tiktok')
    .in('game_id', games.map(g => g.id))
    .limit(50000)
  type Meta = { handle: string; gameIds: Set<string> }
  const handles = new Map<string, Meta>()
  for (const r of (ttRows || []) as Array<{ source_metadata: { handle?: string; author_handle?: string } | null; game_id: string }>) {
    const h = (r.source_metadata?.handle || r.source_metadata?.author_handle || '').replace(/^@+/, '').toLowerCase()
    if (!h) continue
    if (!handles.has(h)) handles.set(h, { handle: h, gameIds: new Set() })
    handles.get(h)!.gameIds.add(r.game_id)
  }

  // Rotation by slot (every 24h all handles get visited at least once
  // given HANDLES_PER_RUN ≥ total_handles).
  const allHandles = Array.from(handles.keys()).sort()
  const slot = Math.floor(Date.now() / (24 * 60 * 60 * 1000))
  const offset = (slot * 137) % Math.max(1, allHandles.length)
  const rotated = [...allHandles.slice(offset), ...allHandles.slice(0, offset)]
  const toPoll = rotated.slice(0, HANDLES_PER_RUN)

  // Existing dedup
  const { data: existing } = await supabase
    .from('coverage_items')
    .select('url, game_id')
    .eq('source_type', 'tiktok')
    .in('game_id', games.map(g => g.id))
    .limit(50000)
  const existingByGame = new Map<string, Set<string>>()
  for (const r of (existing || []) as Array<{ url: string; game_id: string }>) {
    if (!existingByGame.has(r.game_id)) existingByGame.set(r.game_id, new Set())
    existingByGame.get(r.game_id)!.add(r.url)
  }

  const outletCache = new Map<string, string | null>()
  async function ensureOutlet(handle: string, displayName: string, followers: number | null, tier: string): Promise<string | null> {
    const domain = `tiktok.com/@${handle}`
    if (outletCache.has(domain)) return outletCache.get(domain)!
    const { data: o } = await supabase.from('outlets').select('id').eq('domain', domain).maybeSingle()
    if (o?.id) { outletCache.set(domain, o.id); return o.id }
    const { data: newO } = await supabase.from('outlets').insert({
      name: displayName || handle, domain,
      country: detectOutletCountry(domain),
      monthly_unique_visitors: followers, tier, is_active: true,
    }).select('id').single()
    const id = newO?.id ?? null
    outletCache.set(domain, id)
    return id
  }

  let polled = 0, scraped = 0, inserted = 0, autoApproved = 0, pending = 0
  const errors: string[] = []

  for (let i = 0; i < toPoll.length; i += CONCURRENCY) {
    if (Date.now() - t0 > 270_000) {
      errors.push(`time-budget reached after ${i} handles`)
      break
    }
    const batch = toPoll.slice(i, i + CONCURRENCY)
    const results = await Promise.all(batch.map(async (h) => {
      polled++
      const stalk = await stalkTikTokUser(h)
      if (!stalk) return { h, stalk: null, videos: [] as TikTokScrapeResult[] }
      const videos = await scrapeRecentVideos(h)
      if (videos.length > 0) scraped++
      return { h, stalk, videos }
    }))

    for (const { h, stalk, videos } of results) {
      if (!stalk) continue
      const meta = handles.get(h)
      if (!meta) continue
      for (const v of videos) {
        const tikUrl = `https://www.tiktok.com/@${h}/video/${v.videoId}`
        for (const gameId of Array.from(meta.gameIds)) {
          const existingSet = existingByGame.get(gameId) ?? new Set<string>()
          if (existingSet.has(tikUrl)) continue
          const game = games.find(g => g.id === gameId)!
          const conf = scoreConfidence({
            title: v.description,
            description: v.description,  // TikTok has no title; the caption serves both roles
            primaryGameName: game.name,
            aliasKeywords: keywordsByGame.get(gameId) ?? [],
          })
          if (conf.tier === 'NOISE' || conf.tier === 'WEAK') continue  // TikTok descs are usually full; weak = unrelated post by known creator
          existingSet.add(tikUrl)
          const tier = classifyTier(stalk.followerCount)
          const oid = await ensureOutlet(h, stalk.displayName, stalk.followerCount, tier)
          const { error } = await supabase.from('coverage_items').insert({
            client_id: game.client_id, game_id: gameId, outlet_id: oid,
            title: (v.description || `${stalk.displayName} TikTok`).substring(0, 500),
            url: tikUrl,
            publish_date: v.createTimeISO ? v.createTimeISO.split('T')[0] : null,
            coverage_type: 'video', source_type: 'tiktok',
            monthly_unique_visitors: stalk.followerCount,
            source_metadata: {
              discovery: 'forward_poll',
              tiktok_profile_poll: true,
              handle: h,
              video_id: v.videoId,
              followers_at_discovery: stalk.followerCount,
              plays: v.playCount,
              likes: v.diggCount,
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
      }
    }
  }

  return NextResponse.json({
    message: `TikTok profile poll: polled ${polled}, scraped ${scraped}, +${inserted} new (auto ${autoApproved} / pending ${pending})`,
    total_handles_known: allHandles.length,
    polled, scraped, inserted, auto_approved: autoApproved, pending_review: pending,
    rotation_slot: slot, offset, ms: Date.now() - t0,
    errors,
  })
}
