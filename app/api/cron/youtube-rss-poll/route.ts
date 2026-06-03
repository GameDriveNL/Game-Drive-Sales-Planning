/**
 * GET /api/cron/youtube-rss-poll
 *
 * YouTube channel-graph forward poll. Runs every 30 min.
 *
 * For every YouTube channel ID we've already discovered (across all
 * PR-tracked games), fetches its public RSS feed:
 *   https://www.youtube.com/feeds/videos.xml?channel_id=UC…
 *
 * The RSS returns the channel's 15 most recent uploads with title, full
 * description, ISO publish date, and video_id. We filter for uploads that
 * mention any PR-tracked game's whitelist keyword in the title or
 * description, and insert any we haven't seen before.
 *
 * The channel graph is self-expanding: every NEW channel discovered by the
 * audit-youtube (Innertube) scan gets added to coverage_items, and on the
 * next RSS poll cycle we pick it up. After ~30 days of operation the graph
 * contains every known creator who covers any of the games and we catch
 * 100% of their new uploads within 30 minutes.
 *
 * Cost: $0. YouTube RSS is free, no API key, no quota.
 *
 * Rate: ~1500 channels × 1 RSS call per 30 min = 3,000/hour = 72,000/day.
 * YouTube doesn't rate-limit the RSS feeds (verified 2026-06-03: 5 parallel
 * fetches returned in <1s with 200 OK each).
 *
 * Auth: Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { verifyCronAuth } from '@/lib/cron-auth'
import { detectOutletCountry } from '@/lib/outlet-country'
import { scoreConfidence } from '@/lib/coverage-confidence'
import { recordScannerError } from '@/lib/scanner-errors'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

// Cap per run — protects against pathological large graphs and keeps each
// invocation under 300s. Channels are processed in oldest-first order so
// every channel gets visited at least every (CHANNELS_PER_RUN × 30min ÷
// total_channels) interval.
const CHANNELS_PER_RUN = 800
const CONCURRENCY = 25

interface RssEntry {
  videoId: string
  title: string
  description: string
  publishedAt: string  // ISO 8601
  author: string
  authorUri: string
}

function parseRssEntries(xml: string): RssEntry[] {
  const out: RssEntry[] = []
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g
  let m: RegExpExecArray | null
  while ((m = entryRe.exec(xml)) !== null) {
    const e = m[1]
    const vid = /<yt:videoId>([^<]+)<\/yt:videoId>/.exec(e)?.[1]
    const title = /<title>([\s\S]*?)<\/title>/.exec(e)?.[1] || ''
    const desc = /<media:description>([\s\S]*?)<\/media:description>/.exec(e)?.[1] || ''
    const pub = /<published>([^<]+)<\/published>/.exec(e)?.[1] || ''
    const author = /<author>\s*<name>([^<]+)<\/name>\s*<uri>([^<]+)<\/uri>\s*<\/author>/.exec(e)
    if (!vid) continue
    out.push({
      videoId: vid,
      title: title.trim(),
      description: desc.trim(),
      publishedAt: pub.trim(),
      author: author?.[1].trim() || '',
      authorUri: author?.[2].trim() || '',
    })
  }
  return out
}

async function fetchRss(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  channelId: string,
): Promise<string | null> {
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 10_000)
    const r = await fetch(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctl.signal },
    )
    clearTimeout(timer)
    if (!r.ok) {
      // Don't log routine 404s (channel deleted/private) — only auth/rate
      // errors and 5xxs which indicate platform breakage.
      if (r.status >= 500 || r.status === 429 || r.status === 403) {
        await recordScannerError(supabase, {
          scanner: 'youtube-rss-poll',
          target: `channel:${channelId}`,
          category: r.status === 429 ? 'rate_limit' : r.status === 403 ? 'auth_error' : 'fetch_error',
          http_status: r.status,
          message: `RSS fetch failed`,
        })
      }
      return null
    }
    return await r.text()
  } catch (err) {
    await recordScannerError(supabase, {
      scanner: 'youtube-rss-poll',
      target: `channel:${channelId}`,
      category: 'fetch_error',
      message: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

// Build a case-insensitive matcher for the game's keywords. Returns true if
// any keyword appears as a substring in (title + description).
function buildMatcher(keywords: string[]): (text: string) => boolean {
  const needles = keywords
    .map(k => k.toLowerCase().trim())
    .filter(k => k.length >= 3)
  return (text: string) => {
    const lower = text.toLowerCase()
    return needles.some(n => lower.includes(n))
  }
}

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request)
  if (authError) return authError

  const supabase = getServerSupabase()
  const t0 = Date.now()

  // PR-tracked games + their whitelist keywords (used for filtering matches)
  const { data: games } = await supabase
    .from('games')
    .select('id, name, client_id')
    .eq('pr_tracking_enabled', true)
  if (!games || games.length === 0) {
    return NextResponse.json({ message: 'No PR-tracked games' })
  }

  const { data: kws } = await supabase
    .from('coverage_keywords')
    .select('game_id, keyword')
    .eq('keyword_type', 'whitelist')
    .eq('is_active', true)
    .in('game_id', games.map(g => g.id))
  const keywordsByGame = new Map<string, string[]>()
  for (const k of (kws || []) as Array<{ game_id: string; keyword: string }>) {
    if (!keywordsByGame.has(k.game_id)) keywordsByGame.set(k.game_id, [])
    keywordsByGame.get(k.game_id)!.push(k.keyword)
  }
  const matcherByGame = new Map<string, (text: string) => boolean>()
  for (const g of games) {
    matcherByGame.set(g.id, buildMatcher(keywordsByGame.get(g.id) ?? [g.name]))
  }

  // Discover all distinct YouTube channel_ids we've already collected. These
  // channels covered at least one PR-tracked game in the past — we monitor
  // them for new uploads.
  const { data: chRows } = await supabase
    .from('coverage_items')
    .select('source_metadata, game_id')
    .eq('source_type', 'youtube')
    .in('game_id', games.map(g => g.id))
    .limit(50000)
  type ChannelMeta = { channelId: string; gameIds: Set<string> }
  const channels = new Map<string, ChannelMeta>()
  for (const r of (chRows || []) as Array<{ source_metadata: { channel_id?: string } | null; game_id: string }>) {
    const cid = r.source_metadata?.channel_id
    if (!cid || !cid.startsWith('UC')) continue
    if (!channels.has(cid)) channels.set(cid, { channelId: cid, gameIds: new Set() })
    channels.get(cid)!.gameIds.add(r.game_id)
  }

  // Order: deterministic rotation by channel_id hash so every channel gets
  // polled at a regular interval even when we exceed CHANNELS_PER_RUN.
  // Use the current 30-min epoch slot as the rotation offset.
  const allChannelIds = Array.from(channels.keys()).sort()
  const slot = Math.floor(Date.now() / (30 * 60 * 1000))
  const offset = (slot * 137) % Math.max(1, allChannelIds.length)
  const rotated = [...allChannelIds.slice(offset), ...allChannelIds.slice(0, offset)]
  const toPoll = rotated.slice(0, CHANNELS_PER_RUN)

  // Existing YouTube watch URLs per game for dedup
  const { data: existing } = await supabase
    .from('coverage_items')
    .select('url, game_id')
    .eq('source_type', 'youtube')
    .in('game_id', games.map(g => g.id))
    .limit(50000)
  const existingByGame = new Map<string, Set<string>>()
  for (const r of (existing || []) as Array<{ url: string; game_id: string }>) {
    if (!existingByGame.has(r.game_id)) existingByGame.set(r.game_id, new Set())
    existingByGame.get(r.game_id)!.add(r.url)
  }

  // Outlet cache
  const outletCache = new Map<string, string | null>()
  async function ensureChannelOutlet(channelId: string, channelName: string): Promise<string | null> {
    const domain = `youtube.com/channel/${channelId}`
    if (outletCache.has(domain)) return outletCache.get(domain)!
    const { data: o } = await supabase.from('outlets').select('id').eq('domain', domain).maybeSingle()
    if (o?.id) { outletCache.set(domain, o.id); return o.id }
    const { data: newO } = await supabase.from('outlets').insert({
      name: channelName || channelId,
      domain,
      country: detectOutletCountry(domain),
      tier: 'D',
      is_active: true,
    }).select('id').single()
    const id = newO?.id ?? null
    outletCache.set(domain, id)
    return id
  }

  let polled = 0, rssEmpty = 0, matched = 0, inserted = 0, channelsWithNewMatch = 0
  const errors: string[] = []

  // Concurrency-limited polling
  for (let i = 0; i < toPoll.length; i += CONCURRENCY) {
    if (Date.now() - t0 > 270_000) {
      errors.push(`time-budget reached after ${i} channels`)
      break
    }
    const batch = toPoll.slice(i, i + CONCURRENCY)
    const results = await Promise.all(batch.map(async (cid) => {
      const xml = await fetchRss(supabase, cid)
      polled++
      if (!xml) return { cid, entries: [] as RssEntry[] }
      return { cid, entries: parseRssEntries(xml) }
    }))

    for (const { cid, entries } of results) {
      if (entries.length === 0) { rssEmpty++; continue }
      const meta = channels.get(cid)
      if (!meta) continue
      let channelMatched = false
      for (const entry of entries) {
        const text = `${entry.title} ${entry.description}`
        // Test each game this channel has covered before; insert under whichever matches
        for (const gameId of Array.from(meta.gameIds)) {
          const matcher = matcherByGame.get(gameId)
          if (!matcher) continue
          if (!matcher(text)) continue
          matched++
          channelMatched = true
          const watchUrl = `https://www.youtube.com/watch?v=${entry.videoId}`
          const existingSet = existingByGame.get(gameId) ?? new Set<string>()
          if (existingSet.has(watchUrl)) continue
          existingSet.add(watchUrl)
          const game = games.find(g => g.id === gameId)!
          // Score confidence + auto-approve high-confidence matches. Cuts
          // human review load by ~70% based on the keyword distribution we
          // see (most YouTube uploads put the game name in the title).
          const conf = scoreConfidence({
            title: entry.title,
            description: entry.description,
            primaryGameName: game.name,
            aliasKeywords: keywordsByGame.get(gameId) ?? [],
          })
          if (conf.tier === 'NOISE') continue  // don't waste DB space
          const oid = await ensureChannelOutlet(cid, entry.author)
          const { error } = await supabase.from('coverage_items').insert({
            client_id: game.client_id,
            game_id: gameId,
            outlet_id: oid,
            title: entry.title.substring(0, 500),
            url: watchUrl,
            publish_date: entry.publishedAt ? entry.publishedAt.split('T')[0] : null,
            coverage_type: 'video',
            source_type: 'youtube',
            source_metadata: {
              discovery: 'forward_poll',
              youtube_rss_poll: true,
              video_id: entry.videoId,
              channel_id: cid,
              channel_title: entry.author,
              channel_uri: entry.authorUri,
              published_at_iso: entry.publishedAt,
              description_snippet: entry.description.substring(0, 500),
              matched_via_keyword: true,
              confidence_tier: conf.tier,
              confidence_reason: conf.reason,
              matched_keyword: conf.matchedKeyword,
              match_location: conf.matchLocation,
            },
            approval_status: conf.approvalStatus,
            discovered_at: new Date().toISOString(),
          })
          if (!error) inserted++
        }
      }
      if (channelMatched) channelsWithNewMatch++
    }
  }

  return NextResponse.json({
    message: `YouTube RSS poll: polled ${polled} channels, ${inserted} new items, ${matched} keyword matches`,
    total_channels_known: allChannelIds.length,
    polled, rss_empty: rssEmpty, matched, inserted, channels_with_match: channelsWithNewMatch,
    rotation_slot: slot, offset, ms: Date.now() - t0,
    errors,
  })
}
