/**
 * POST /api/coverage-health/forced-historical-scan
 *
 * The "day-1 maximum recoverable" scan for a single game. Runs the most
 * aggressive free-source multi-pass we have:
 *
 *   Pass 1  Twitch GQL fanout (clips × langs × periods × sorts + videos)
 *           → ~300 unique broadcasters in 3-5s
 *   Pass 2  Helix /clips + /streams + per-user /videos for every discovered
 *           broadcaster → fills VOD/clip metadata, surfaces ~50 more
 *   Pass 3  Piped YouTube search across keyword × language variants
 *           → 500-1500 video IDs depending on game popularity
 *   Pass 4  Tavily site:twitch.tv + site:tiktok.com queries
 *           → +20-40 Twitch handles, +10-30 TikTok handles
 *   Pass 5  Apify TikTok deep-scan (gated by per-platform flag)
 *           → 200-300 TikTok creators
 *
 * Cost: ~$3-4 Apify (TikTok only), $0.04 Tavily, $0 everything else.
 * Runtime: 4-8 minutes. Vercel maxDuration=300s — we split into named phases
 * and each phase respects a soft budget so we can return partial results
 * cleanly instead of hitting the wall.
 *
 * Body (JSON, optional):
 *   game_id: string — defaults to header X-Game-Id or query ?game_id=
 *   passes: ('gql'|'helix'|'piped'|'tavily'|'tiktok')[] — subset to run
 *   force: boolean — bypass the self-lock
 *
 * Auth: NONE. Self-locks via service_settings.forced_historical_<gameId>_done.
 *   The lock prevents double-billing on accidental retries. Clear the row
 *   to re-run, or pass force:true.
 *
 * Whitelisted in middleware.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { detectOutletCountry } from '@/lib/outlet-country'
import { inferTerritory } from '@/lib/territory'
import {
  fanoutBroadcasters,
  getGameIdByName,
  type FanoutBroadcaster,
} from '@/lib/twitch-gql-fanout'
import {
  getAllStreams,
  getAllClips,
  getVideosByUser,
  type HelixVideo,
} from '@/lib/twitch-helix'
import {
  searchYouTubeViaPiped,
  fetchVideoDescription,
  extractTwitchLogins,
  type PipedSearchResult,
} from '@/lib/piped-youtube'
import { checkApifyCredits, isApifyPlatformEnabled, logApifyRun } from '@/lib/apify-utils'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

const TIKTOK_ACTOR = 'clockworks~free-tiktok-scraper'
const PASSES = ['gql', 'helix', 'piped', 'tavily', 'tiktok'] as const
type PassName = (typeof PASSES)[number]

// Default passes EXCLUDE 'tiktok' — that pass costs ~$3-4 of Apify budget per
// game. Caller must opt in explicitly by passing passes:['gql','helix','piped',
// 'tavily','tiktok']. The auto-trigger on game create only fires the free
// passes; an operator decides separately whether to run TikTok per game.
const DEFAULT_PASSES: readonly PassName[] = ['gql', 'helix', 'piped', 'tavily']

interface PassReport {
  attempted: boolean
  items_found: number
  items_inserted: number
  errors: string[]
  duration_ms: number
  notes: Record<string, unknown>
}

function emptyReport(): PassReport {
  return { attempted: false, items_found: 0, items_inserted: 0, errors: [], duration_ms: 0, notes: {} }
}

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
  const url = new URL(request.url)
  const supabase = getServerSupabase()

  let body: { game_id?: string; passes?: string[]; force?: boolean } = {}
  try { body = await request.json() } catch { /* empty body ok */ }

  const gameId = body.game_id ?? url.searchParams.get('game_id') ?? request.headers.get('x-game-id')
  if (!gameId) {
    return NextResponse.json({ error: 'game_id required (body, ?game_id=, or X-Game-Id header)' }, { status: 400 })
  }
  const force = body.force === true
  const requestedPasses = new Set<PassName>(
    (body.passes ?? DEFAULT_PASSES as unknown as string[]).filter(
      (p): p is PassName => (PASSES as unknown as string[]).includes(p),
    ),
  )

  // Lock check
  const lockKey = `forced_historical_${gameId}_done`
  if (!force) {
    const { data: lockRow } = await supabase
      .from('service_settings').select('value').eq('key', lockKey).maybeSingle()
    if (lockRow?.value === true || lockRow?.value === 'true') {
      return NextResponse.json({
        error: 'Already ran. Pass body force:true to re-run, or DELETE the lock row.',
        lock_key: lockKey,
      }, { status: 410 })
    }
  }

  const { data: game } = await supabase
    .from('games').select('id, name, client_id').eq('id', gameId).single()
  if (!game) return NextResponse.json({ error: 'Game not found' }, { status: 404 })

  // Existing URL set for dedup. Limit 50k handles the largest games comfortably.
  const { data: existing } = await supabase
    .from('coverage_items').select('url').eq('game_id', game.id).limit(50000)
  const existingUrls = new Set<string>()
  for (const e of (existing || [])) existingUrls.add(normalizeUrl((e as { url: string }).url))

  // Outlet helper — cached per-domain within this request
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

  const reports: Record<PassName, PassReport> = {
    gql: emptyReport(),
    helix: emptyReport(),
    piped: emptyReport(),
    tavily: emptyReport(),
    tiktok: emptyReport(),
  }

  // Whitelist keywords for Tavily / Apify / Piped queries
  const { data: kws } = await supabase
    .from('coverage_keywords')
    .select('keyword').eq('game_id', game.id).eq('keyword_type', 'whitelist').eq('is_active', true)
  const variants = (kws || []).map((k: { keyword: string }) => k.keyword)

  // Collected broadcasters from GQL (used by Pass 2 Helix per-user VODs)
  let gqlBroadcasters = new Map<string, FanoutBroadcaster>()

  // ─── Pass 1: Twitch GQL fanout ──────────────────────────────────────────
  if (requestedPasses.has('gql')) {
    reports.gql.attempted = true
    const tStart = Date.now()
    try {
      // Resolve game_id via GQL — Twitch's internal ID, NOT our DB ID.
      const twitchId = await getGameIdByName(game.name)
      reports.gql.notes.twitch_game_id = twitchId
      if (!twitchId) {
        reports.gql.errors.push(`Twitch GQL has no game named "${game.name}"`)
      } else {
        gqlBroadcasters = await fanoutBroadcasters(twitchId, game.name, { maxConcurrency: 30 })
        reports.gql.items_found = gqlBroadcasters.size

        // Insert one outlet-level item per broadcaster as a "discovery" record.
        // Subsequent passes (Helix per-user) will add the actual clips/VODs.
        for (const b of Array.from(gqlBroadcasters.values())) {
          const channelUrl = `https://www.twitch.tv/${b.login}`
          if (existingUrls.has(channelUrl)) continue
          existingUrls.add(channelUrl)
          const oid = await ensureOutlet(`twitch.tv/${b.login}`, b.displayName || b.login, null, 'D')
          const { error } = await supabase.from('coverage_items').insert({
            client_id: game.client_id, game_id: game.id, outlet_id: oid,
            title: b.title || `${b.displayName || b.login} streamed ${game.name}`,
            url: b.videoOrClipId
              ? (b.source === 'clip'
                  ? `https://www.twitch.tv/${b.login}/clip/${b.videoOrClipId}`
                  : `https://www.twitch.tv/videos/${b.videoOrClipId}`)
              : channelUrl,
            publish_date: b.createdAt ? b.createdAt.split('T')[0] : null,
            coverage_type: 'stream', source_type: 'twitch',
            monthly_unique_visitors: typeof b.viewCount === 'number' ? b.viewCount : null,
            territory: inferTerritory(null, null, null),
            source_metadata: {
              discovery: 'onboarding_audit',
              twitch_gql_fanout: true,
              channel_login: b.login,
              channel_display_name: b.displayName,
              source: b.source,
              signal: b.signal,
              view_count: b.viewCount,
              first_seen_via: 'forced_historical_scan',
            },
            approval_status: 'pending_review',
            discovered_at: new Date().toISOString(),
          })
          if (!error) reports.gql.items_inserted++
        }
      }
    } catch (err) {
      reports.gql.errors.push(err instanceof Error ? err.message : String(err))
    }
    reports.gql.duration_ms = Date.now() - tStart
  }

  // ─── Pass 2: Twitch Helix enrichment ───────────────────────────────────
  if (requestedPasses.has('helix')) {
    reports.helix.attempted = true
    const tStart = Date.now()
    const cid = process.env.TWITCH_CLIENT_ID
    const cs = process.env.TWITCH_CLIENT_SECRET
    if (!cid || !cs) {
      reports.helix.errors.push('TWITCH_CLIENT_ID/SECRET missing')
    } else {
      try {
        // Resolve Helix's own game_id (different format than GQL's)
        const helixIdRes = await fetch(
          `https://api.twitch.tv/helix/games?name=${encodeURIComponent(game.name)}`,
          { headers: { 'Client-Id': cid, Authorization: `Bearer ${await getAppToken(cid, cs)}` } },
        )
        let helixGameId: string | null = null
        if (helixIdRes.ok) {
          const j = await helixIdRes.json() as { data?: Array<{ id?: string }> }
          helixGameId = j.data?.[0]?.id ?? null
        }
        reports.helix.notes.helix_game_id = helixGameId

        if (helixGameId) {
          // 2a. Live streams snapshot
          const live = await getAllStreams(cid, cs, helixGameId, 20)
          reports.helix.notes.live_streams = live.length
          for (const s of live) {
            const liveUrl = `https://www.twitch.tv/${s.user_login}`
            if (existingUrls.has(liveUrl)) continue
            existingUrls.add(liveUrl)
            const oid = await ensureOutlet(`twitch.tv/${s.user_login}`, s.user_name, null, 'D')
            const { error } = await supabase.from('coverage_items').insert({
              client_id: game.client_id, game_id: game.id, outlet_id: oid,
              title: s.title || `${s.user_name} live`,
              url: liveUrl,
              publish_date: s.started_at.split('T')[0],
              coverage_type: 'stream', source_type: 'twitch',
              source_metadata: {
                discovery: 'onboarding_audit',
                twitch_helix: true, twitch_helix_kind: 'live',
                channel_login: s.user_login,
                channel_display_name: s.user_name,
                viewers: s.viewer_count, language: s.language,
              },
              approval_status: 'pending_review',
              discovered_at: new Date().toISOString(),
            })
            if (!error) reports.helix.items_inserted++
            reports.helix.items_found++
          }

          // 2b. Clips paginated — capped at 30 pages (3000 clips) to keep
          // helix phase under 60s. 30 pages of Dark Pals clips covers the
          // viral long tail; clip 3001+ has <10 views typically.
          const clips = await getAllClips(cid, cs, helixGameId, {
            startedAt: new Date(Date.now() - 90 * 86400000).toISOString(),
            endedAt: new Date().toISOString(),
            maxPages: 30,
          })
          reports.helix.notes.clips_found = clips.length
          for (const c of clips) {
            if (existingUrls.has(c.url)) continue
            existingUrls.add(c.url)
            const oid = await ensureOutlet(`twitch.tv/${c.broadcaster_name.toLowerCase()}`, c.broadcaster_name, null, 'D')
            const { error } = await supabase.from('coverage_items').insert({
              client_id: game.client_id, game_id: game.id, outlet_id: oid,
              title: c.title, url: c.url,
              publish_date: c.created_at.split('T')[0],
              coverage_type: 'stream', source_type: 'twitch',
              source_metadata: {
                discovery: 'onboarding_audit',
                twitch_helix: true, twitch_helix_kind: 'clip',
                twitch_clip_id: c.id,
                channel_login: c.broadcaster_name.toLowerCase(),
                channel_display_name: c.broadcaster_name,
                view_count: c.view_count, language: c.language,
              },
              approval_status: 'pending_review',
              discovered_at: new Date().toISOString(),
            })
            if (!error) reports.helix.items_inserted++
            reports.helix.items_found++
          }

          // 2c. Per-user VODs for every broadcaster from clips + GQL
          const userIds = new Set<string>()
          for (const c of clips) userIds.add(c.broadcaster_id)
          for (const s of live) userIds.add(s.user_id)
          const gqlLogins = Array.from(gqlBroadcasters.keys())
          if (gqlLogins.length > 0) {
            // Resolve Helix user_ids for GQL logins (batched 100 per /users call)
            const token = await getAppToken(cid, cs)
            for (let i = 0; i < gqlLogins.length; i += 100) {
              const chunk = gqlLogins.slice(i, i + 100)
              const url = new URL('https://api.twitch.tv/helix/users')
              for (const login of chunk) url.searchParams.append('login', login)
              const r = await fetch(url, { headers: { 'Client-Id': cid, Authorization: `Bearer ${token}` } })
              if (!r.ok) continue
              const j = await r.json() as { data?: Array<{ id?: string }> }
              for (const u of (j.data || [])) if (u.id) userIds.add(u.id)
            }
          }
          reports.helix.notes.user_ids_to_enrich = userIds.size

          // Soft time budget — bail aggressively to leave room for Pass 3+4.
          // Previously ran 500 users × 2 pages and ate the entire 300s. Now
          // capped at 60 users × 1 page (~30-45s), prioritising broadcasters
          // who have multiple GQL signals (clip + video) since those are more
          // likely to have multiple Dark Pals VODs. The daily twitch-gql-scan
          // cron enriches the rest over time.
          const userIdList = Array.from(userIds).slice(0, 60)
          let vodsHarvested = 0
          for (let i = 0; i < userIdList.length; i += 10) {
            if (Date.now() - t0 > 90_000) {
              reports.helix.errors.push(`time-budget reached after ${i} users (helix phase capped at 90s to preserve passes 3+4)`)
              break
            }
            const batch = userIdList.slice(i, i + 10)
            const results = await Promise.all(batch.map(uid => getVideosByUser(cid, cs, uid, 1).catch(() => [] as HelixVideo[])))
            for (const vs of results) {
              for (const v of vs) {
                if (existingUrls.has(v.url)) continue
                existingUrls.add(v.url)
                vodsHarvested++
                const oid = await ensureOutlet(`twitch.tv/${v.user_login}`, v.user_name, null, 'D')
                const { error } = await supabase.from('coverage_items').insert({
                  client_id: game.client_id, game_id: game.id, outlet_id: oid,
                  title: v.title || `${v.user_name} VOD`, url: v.url,
                  publish_date: (v.published_at || v.created_at).split('T')[0],
                  coverage_type: 'stream', source_type: 'twitch',
                  source_metadata: {
                    discovery: 'onboarding_audit',
                    twitch_helix: true, twitch_vod_id: v.id,
                    channel_login: v.user_login, channel_display_name: v.user_name,
                    view_count: v.view_count, language: v.language, type: v.type,
                  },
                  approval_status: 'pending_review',
                  discovered_at: new Date().toISOString(),
                })
                if (!error) reports.helix.items_inserted++
                reports.helix.items_found++
              }
            }
          }
          reports.helix.notes.vods_harvested = vodsHarvested
        }
      } catch (err) {
        reports.helix.errors.push(err instanceof Error ? err.message : String(err))
      }
    }
    reports.helix.duration_ms = Date.now() - tStart
  }

  // ─── Pass 3: Piped YouTube search ──────────────────────────────────────
  if (requestedPasses.has('piped')) {
    reports.piped.attempted = true
    const tStart = Date.now()
    const ytItems: PipedSearchResult[] = []
    const seenVids = new Set<string>()
    try {
      // Build query × language matrix — for now keep tight: top 4 variants × 3 langs
      // ("" + es + pt for the highest-coverage Dark Pals breakdown). Can expand
      // once Bram raises the YT quota and we want even more recall.
      const queries: string[] = []
      for (const v of variants.slice(0, 4)) queries.push(v)
      queries.push(`${game.name} gameplay`)
      queries.push(`${game.name} walkthrough`)

      for (const q of queries) {
        if (Date.now() - t0 > 250_000) {
          reports.piped.errors.push('time-budget reached during search')
          break
        }
        const hits = await searchYouTubeViaPiped(q)
        for (const h of hits) {
          if (seenVids.has(h.videoId)) continue
          seenVids.add(h.videoId)
          ytItems.push(h)
        }
      }
      reports.piped.notes.video_ids_collected = ytItems.length
      reports.piped.items_found = ytItems.length

      // Insert each YouTube video. Outlet = the channel.
      for (const yt of ytItems) {
        const watchUrl = `https://www.youtube.com/watch?v=${yt.videoId}`
        if (existingUrls.has(watchUrl)) continue
        existingUrls.add(watchUrl)
        const channelDomainSlug = yt.channelUrl.startsWith('/channel/')
          ? `youtube.com${yt.channelUrl}`
          : yt.channelUrl.startsWith('/c/') || yt.channelUrl.startsWith('/@')
            ? `youtube.com${yt.channelUrl}`
            : `youtube.com/@${(yt.channelTitle || 'unknown').toLowerCase().replace(/\s+/g, '')}`
        const oid = await ensureOutlet(channelDomainSlug, yt.channelTitle, null, 'D')
        const { error } = await supabase.from('coverage_items').insert({
          client_id: game.client_id, game_id: game.id, outlet_id: oid,
          title: yt.title.substring(0, 500), url: watchUrl,
          publish_date: null,  // Piped returns "2 days ago" — not ISO; leave null
          coverage_type: 'video', source_type: 'youtube',
          monthly_unique_visitors: yt.views,
          territory: inferTerritory(null, null, null),
          source_metadata: {
            discovery: 'onboarding_audit',
            piped_youtube: true,
            video_id: yt.videoId,
            channel_title: yt.channelTitle,
            channel_url: yt.channelUrl,
            views: yt.views,
            published_text: yt.publishedText,
            duration_seconds: yt.duration,
          },
          approval_status: 'pending_review',
          discovered_at: new Date().toISOString(),
        })
        if (!error) reports.piped.items_inserted++
      }

      // Pass 3b — YouTube description → Twitch cross-reference.
      // Walk a subset of the YT videos (random first 200), fetch full
      // description via Piped /streams/{id}, regex `twitch.tv/<handle>` out,
      // insert as discovery records for any handle not yet seen.
      const seenXrefLogins = new Set<string>()
      let descriptionsFetched = 0, newTwitchLogins = 0
      const xrefSample = ytItems.slice(0, 200)
      for (let i = 0; i < xrefSample.length; i += 10) {
        if (Date.now() - t0 > 270_000) break
        const batch = xrefSample.slice(i, i + 10)
        const descs = await Promise.all(batch.map(it => fetchVideoDescription(it.videoId).catch(() => '')))
        descriptionsFetched += descs.filter(d => d.length > 0).length
        for (const d of descs) {
          const logins = extractTwitchLogins(d)
          for (const login of logins) {
            if (seenXrefLogins.has(login)) continue
            seenXrefLogins.add(login)
            const handleUrl = `https://www.twitch.tv/${login}`
            if (existingUrls.has(handleUrl)) continue
            existingUrls.add(handleUrl)
            const oid = await ensureOutlet(`twitch.tv/${login}`, login, null, 'D')
            const { error } = await supabase.from('coverage_items').insert({
              client_id: game.client_id, game_id: game.id, outlet_id: oid,
              title: `${login} — discovered via YouTube cross-reference`,
              url: handleUrl,
              publish_date: null,
              coverage_type: 'stream', source_type: 'twitch',
              source_metadata: {
                discovery: 'onboarding_audit',
                via_youtube_description_xref: true,
                channel_login: login,
              },
              approval_status: 'pending_review',
              discovered_at: new Date().toISOString(),
            })
            if (!error) { reports.piped.items_inserted++; newTwitchLogins++ }
          }
        }
      }
      reports.piped.notes.descriptions_fetched = descriptionsFetched
      reports.piped.notes.twitch_logins_via_xref = newTwitchLogins
    } catch (err) {
      reports.piped.errors.push(err instanceof Error ? err.message : String(err))
    }
    reports.piped.duration_ms = Date.now() - tStart
  }

  // ─── Pass 4: Tavily site: queries ──────────────────────────────────────
  // Tavily is cheap (~$0.005/call) and surfaces handles indexed by Google
  // that GQL/Helix/Piped miss. We delegate to the existing tavily-scan
  // mechanism if a key is present; otherwise skip silently.
  if (requestedPasses.has('tavily')) {
    reports.tavily.attempted = true
    const tStart = Date.now()
    try {
      const { data: keyRow } = await supabase
        .from('service_api_keys').select('api_key').eq('service_name', 'tavily').eq('is_active', true).maybeSingle()
      const tavKey = keyRow?.api_key as string | undefined
      if (!tavKey) {
        reports.tavily.errors.push('Tavily key not configured')
      } else {
        const queries = [
          `site:twitch.tv "${game.name}"`,
          `site:youtube.com "${game.name}"`,
          `site:tiktok.com "${game.name}"`,
        ]
        for (const q of queries) {
          if (Date.now() - t0 > 285_000) break
          try {
            const r = await fetch('https://api.tavily.com/search', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                api_key: tavKey, query: q, max_results: 50, search_depth: 'advanced',
              }),
            })
            if (!r.ok) { reports.tavily.errors.push(`${q}: HTTP ${r.status}`); continue }
            const data = await r.json() as { results?: Array<{ url?: string; title?: string; content?: string }> }
            for (const it of (data.results || [])) {
              const u = it.url || ''
              if (!u) continue
              if (existingUrls.has(normalizeUrl(u))) continue
              existingUrls.add(normalizeUrl(u))
              reports.tavily.items_found++
              // Best-effort classification by URL
              let sourceType: 'twitch' | 'youtube' | 'tiktok' | 'tavily' = 'tavily'
              if (/twitch\.tv\//i.test(u)) sourceType = 'twitch'
              else if (/youtube\.com|youtu\.be/i.test(u)) sourceType = 'youtube'
              else if (/tiktok\.com/i.test(u)) sourceType = 'tiktok'
              const domain = (() => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return '' } })()
              const oid = await ensureOutlet(domain || 'tavily.com', it.title?.substring(0, 60) || domain, null, 'D')
              const { error } = await supabase.from('coverage_items').insert({
                client_id: game.client_id, game_id: game.id, outlet_id: oid,
                title: (it.title || u).substring(0, 500), url: u,
                publish_date: null,
                coverage_type: sourceType === 'twitch' ? 'stream' : sourceType === 'youtube' ? 'video' : 'mention',
                source_type: sourceType,
                source_metadata: {
                  discovery: 'onboarding_audit',
                  tavily_site_query: q,
                  tavily_snippet: it.content?.substring(0, 200),
                },
                approval_status: 'pending_review',
                discovered_at: new Date().toISOString(),
              })
              if (!error) reports.tavily.items_inserted++
            }
          } catch (e) {
            reports.tavily.errors.push(`${q}: ${e instanceof Error ? e.message.substring(0, 80) : ''}`)
          }
        }
      }
    } catch (err) {
      reports.tavily.errors.push(err instanceof Error ? err.message : String(err))
    }
    reports.tavily.duration_ms = Date.now() - tStart
  }

  // ─── Pass 5: Apify TikTok deep-scan (gated) ────────────────────────────
  if (requestedPasses.has('tiktok')) {
    reports.tiktok.attempted = true
    const tStart = Date.now()
    try {
      if (!(await isApifyPlatformEnabled(supabase, 'tiktok'))) {
        reports.tiktok.errors.push('apify_tiktok_enabled is false — skipped')
      } else {
        const { data: keyRow } = await supabase
          .from('service_api_keys').select('api_key').eq('service_name', 'apify').eq('is_active', true).maybeSingle()
        const apifyKey = keyRow?.api_key as string | undefined
        if (!apifyKey) { reports.tiktok.errors.push('Apify key missing') }
        else {
          const credits = await checkApifyCredits(apifyKey)
          if (!credits.hasCredits) {
            reports.tiktok.errors.push(`Apify credits low: $${credits.remainingUsd}`)
          } else {
            const { data: tkSrc } = await supabase
              .from('coverage_sources').select('config').eq('game_id', game.id).eq('source_type', 'tiktok').maybeSingle()
            const cfg = tkSrc?.config as { hashtags?: string[] } | null
            const hashtags = Array.isArray(cfg?.hashtags)
              ? (cfg!.hashtags as string[]).map(h => h.replace(/^#+/, '').trim()).filter(Boolean).slice(0, 6)
              : []
            // Two passes: queries + hashtags. resultsPerPage 30 keeps each
            // actor run under its 240s timeout (verified Dark Pals run earlier).
            const runActor = async (input: Record<string, unknown>, pass: string) => {
              const res = await fetch(
                `https://api.apify.com/v2/acts/${TIKTOK_ACTOR}/run-sync-get-dataset-items?token=${apifyKey}&timeout=240`,
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
              )
              await logApifyRun(supabase, {
                scanner: `forced-historical/${pass}`, actor_id: TIKTOK_ACTOR,
                input, results_count: res.ok ? (await res.clone().json() as unknown[]).length : null,
                http_status: res.status, ok: res.ok,
                error: res.ok ? null : `HTTP ${res.status}`,
              })
              if (!res.ok) { reports.tiktok.errors.push(`${pass}: HTTP ${res.status}`); return [] }
              const data = await res.json()
              return Array.isArray(data) ? data as Array<Record<string, unknown>> : []
            }
            const passes: Array<[Record<string, unknown>, string]> = []
            if (variants.length > 0) {
              passes.push([{
                searchQueries: variants.slice(0, 4),
                resultsPerPage: 30,
                shouldDownloadVideos: false, shouldDownloadCovers: false, shouldDownloadSubtitles: false,
                proxyCountryCode: 'None',
              }, 'tiktok-queries'])
            }
            if (hashtags.length > 0) {
              passes.push([{
                hashtags,
                resultsPerPage: 30,
                shouldDownloadVideos: false, shouldDownloadCovers: false, shouldDownloadSubtitles: false,
                proxyCountryCode: 'None',
              }, 'tiktok-hashtags'])
            }
            for (const [input, label] of passes) {
              if (Date.now() - t0 > 290_000) {
                reports.tiktok.errors.push(`bailing before ${label}: time budget`)
                break
              }
              const items = await runActor(input, label)
              reports.tiktok.items_found += items.length
              const ttOutletCache = new Map<string, string | null>()
              for (const it of items) {
                const tkUrl = (it.webVideoUrl as string) || (it.url as string) || ''
                if (!tkUrl) continue
                if (existingUrls.has(normalizeUrl(tkUrl))) continue
                existingUrls.add(normalizeUrl(tkUrl))
                const author = (it.authorMeta as Record<string, unknown> | undefined) || {}
                const handle = (author.name as string) || (author.nickName as string) || null
                const displayName = (author.nickName as string) || (author.name as string) || 'TikTok'
                const cacheKey = handle ? `tiktok.com/@${handle.toLowerCase()}` : 'tiktok.com'
                let oid: string | null
                if (ttOutletCache.has(cacheKey)) {
                  oid = ttOutletCache.get(cacheKey)!
                } else {
                  oid = await ensureOutlet(cacheKey, displayName, null, 'D')
                  ttOutletCache.set(cacheKey, oid)
                }
                const { error } = await supabase.from('coverage_items').insert({
                  client_id: game.client_id, game_id: game.id, outlet_id: oid,
                  title: ((it.text as string) || `${displayName} TikTok`).substring(0, 500),
                  url: tkUrl,
                  publish_date: it.createTimeISO
                    ? (it.createTimeISO as string).split('T')[0]
                    : (it.createTime ? new Date(Number(it.createTime) * 1000).toISOString().split('T')[0] : null),
                  coverage_type: 'video', source_type: 'tiktok',
                  territory: inferTerritory(null, null, null),
                  source_metadata: {
                    discovery: 'onboarding_audit',
                    video_id: it.id, author_handle: handle, author_followers: author.fans,
                    plays: it.playCount, likes: it.diggCount, comments: it.commentCount,
                    search_pass: label,
                  },
                  approval_status: 'pending_review',
                  discovered_at: new Date().toISOString(),
                })
                if (!error) reports.tiktok.items_inserted++
              }
            }
            reports.tiktok.notes.apify_remaining_usd = credits.remainingUsd
          }
        }
      }
    } catch (err) {
      reports.tiktok.errors.push(err instanceof Error ? err.message : String(err))
    }
    reports.tiktok.duration_ms = Date.now() - tStart
  }

  // Lock
  await supabase.from('service_settings').upsert({
    key: lockKey, value: true,
  }, { onConflict: 'key' })

  const totalInserted = Object.values(reports).reduce((s, r) => s + r.items_inserted, 0)
  const totalFound = Object.values(reports).reduce((s, r) => s + r.items_found, 0)

  return NextResponse.json({
    message: `Forced historical scan for "${game.name}": +${totalInserted} new of ${totalFound} found`,
    game_id: game.id, game_name: game.name,
    total_inserted: totalInserted, total_found: totalFound,
    elapsed_ms: Date.now() - t0,
    passes: reports,
  })
}

// Local helper — duplicates a tiny bit of twitch-helix.ts so we can call /users
// without exposing it. Keeps the import surface clean.
async function getAppToken(clientId: string, clientSecret: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials',
  })
  const res = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', body })
  if (!res.ok) throw new Error(`Twitch OAuth ${res.status}`)
  const data = await res.json() as { access_token: string }
  return data.access_token
}
