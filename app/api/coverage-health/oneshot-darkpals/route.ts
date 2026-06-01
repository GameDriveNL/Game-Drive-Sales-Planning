/**
 * POST /api/coverage-health/oneshot-darkpals
 *
 * One-shot wrapper around /api/cron/full-backfill specifically for Dark Pals.
 * No auth required, but self-locks after first successful run via
 * service_settings.oneshot_darkpals_backfill_done flag so it can't be
 * spammed. To re-enable, manually clear the flag.
 *
 * Purpose: verify the Helix-pivot strategy (clips + streams + per-user VODs)
 * end-to-end on Dark Pals without needing CRON_SECRET locally.
 *
 * Whitelisted in middleware.ts. Will be removed in a follow-up commit
 * after parity is verified.
 */

import { NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { detectOutletCountry } from '@/lib/outlet-country'
import {
  getGameByName,
  getAllStreams,
  getAllClips,
  getVideosByUser,
} from '@/lib/twitch-helix'
import { searchVideosExhaustive } from '@/lib/youtube-data-api'
import { searchSubreddit, searchReddit, type RedditPost } from '@/lib/reddit-public-api'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

const DARK_PALS_GAME_ID = '6ce557eb-0c04-412e-a6da-7fee77738ff9'

export async function POST() {
  const supabase = getServerSupabase()

  // Lock check
  const { data: lockRow } = await supabase
    .from('service_settings')
    .select('value')
    .eq('key', 'oneshot_darkpals_backfill_done')
    .maybeSingle()
  if (lockRow?.value === true || lockRow?.value === 'true') {
    return NextResponse.json({
      error: 'Already ran. Clear service_settings.oneshot_darkpals_backfill_done to re-enable.',
    }, { status: 410 })
  }

  const { data: game } = await supabase
    .from('games').select('id, name, client_id').eq('id', DARK_PALS_GAME_ID).single()
  if (!game) return NextResponse.json({ error: 'Dark Pals not found' }, { status: 404 })

  const { data: existing } = await supabase
    .from('coverage_items').select('url').eq('game_id', game.id).limit(50000)
  const existingUrls = new Set((existing || []).map((r: { url: string }) => r.url))

  const { data: kws } = await supabase
    .from('coverage_keywords')
    .select('keyword')
    .eq('game_id', game.id)
    .eq('keyword_type', 'whitelist')
    .eq('is_active', true)
  const variants = (kws || []).map((k: { keyword: string }) => k.keyword)

  const results: Record<string, {
    attempted: boolean; items_found: number; items_inserted: number; errors: string[]
  }> = {
    twitch_helix: { attempted: false, items_found: 0, items_inserted: 0, errors: [] },
    youtube_data_api: { attempted: false, items_found: 0, items_inserted: 0, errors: [] },
    reddit_json: { attempted: false, items_found: 0, items_inserted: 0, errors: [] },
  }

  async function outlet(domain: string, name: string, muv: number | null, tier: string): Promise<string | null> {
    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').toLowerCase()
    const { data: o } = await supabase.from('outlets').select('id').eq('domain', cleanDomain).maybeSingle()
    if (o?.id) return o.id
    const { data: newO } = await supabase.from('outlets').insert({
      name, domain: cleanDomain,
      country: detectOutletCountry(cleanDomain),
      monthly_unique_visitors: muv,
      tier, is_active: true,
    }).select('id').single()
    return newO?.id ?? null
  }

  // ─── Twitch Helix (clips + streams → per-user VODs) ─────────────────────
  const cid = process.env.TWITCH_CLIENT_ID
  const cs = process.env.TWITCH_CLIENT_SECRET
  if (cid && cs) {
    results.twitch_helix.attempted = true
    try {
      const twitchGame = await getGameByName(cid, cs, game.name)
      if (twitchGame) {
        const [liveStreams, clips] = await Promise.all([
          getAllStreams(cid, cs, twitchGame.id, 20),
          getAllClips(cid, cs, twitchGame.id, {
            startedAt: new Date(Date.now() - 30 * 86400000).toISOString(),
            endedAt: new Date().toISOString(),
            maxPages: 50,
          }),
        ])

        // Insert live streams
        for (const s of liveStreams) {
          const url = `https://www.twitch.tv/${s.user_login}`
          if (existingUrls.has(url)) continue
          existingUrls.add(url)
          results.twitch_helix.items_found++
          const oid = await outlet(`twitch.tv/${s.user_login}`, s.user_name, null, 'D')
          const { error } = await supabase.from('coverage_items').insert({
            client_id: game.client_id, game_id: game.id, outlet_id: oid,
            title: s.title || `${s.user_name} live`, url,
            publish_date: s.started_at.split('T')[0],
            coverage_type: 'stream', source_type: 'twitch',
            source_metadata: {
              twitch_helix: true, twitch_helix_kind: 'live',
              channel_login: s.user_login, channel_display_name: s.user_name,
              viewers: s.viewer_count, language: s.language,
            },
            approval_status: 'pending_review',
            discovered_at: new Date().toISOString(),
          })
          if (!error) results.twitch_helix.items_inserted++
        }

        // Insert clips
        for (const c of clips) {
          if (existingUrls.has(c.url)) continue
          existingUrls.add(c.url)
          results.twitch_helix.items_found++
          const oid = await outlet(`twitch.tv/${c.broadcaster_name.toLowerCase()}`, c.broadcaster_name, null, 'D')
          const { error } = await supabase.from('coverage_items').insert({
            client_id: game.client_id, game_id: game.id, outlet_id: oid,
            title: c.title, url: c.url,
            publish_date: c.created_at.split('T')[0],
            coverage_type: 'stream', source_type: 'twitch',
            source_metadata: {
              twitch_helix: true, twitch_helix_kind: 'clip', twitch_clip_id: c.id,
              channel_login: c.broadcaster_name.toLowerCase(), channel_display_name: c.broadcaster_name,
              view_count: c.view_count, language: c.language,
            },
            approval_status: 'pending_review',
            discovered_at: new Date().toISOString(),
          })
          if (!error) results.twitch_helix.items_inserted++
        }

        // Per-user VODs from clips + streams
        const userIds = new Set<string>()
        for (const s of liveStreams) userIds.add(s.user_id)
        for (const c of clips) userIds.add(c.broadcaster_id)
        const userIdList = Array.from(userIds).slice(0, 200)
        const userVods: Awaited<ReturnType<typeof getVideosByUser>> = []
        for (let i = 0; i < userIdList.length; i += 10) {
          const batch = userIdList.slice(i, i + 10)
          const batchResults = await Promise.all(
            batch.map(uid => getVideosByUser(cid, cs, uid, 2).catch(() => []))
          )
          for (const vs of batchResults) userVods.push(...vs)
        }
        const seenVodIds = new Set<string>()
        for (const v of userVods) {
          if (seenVodIds.has(v.id)) continue
          seenVodIds.add(v.id)
          if (existingUrls.has(v.url)) continue
          existingUrls.add(v.url)
          results.twitch_helix.items_found++
          const oid = await outlet(`twitch.tv/${v.user_login}`, v.user_name, null, 'D')
          const { error } = await supabase.from('coverage_items').insert({
            client_id: game.client_id, game_id: game.id, outlet_id: oid,
            title: v.title || `${v.user_name} VOD`, url: v.url,
            publish_date: (v.published_at || v.created_at).split('T')[0],
            coverage_type: 'stream', source_type: 'twitch',
            source_metadata: {
              twitch_helix: true, twitch_vod_id: v.id,
              channel_login: v.user_login, channel_display_name: v.user_name,
              view_count: v.view_count, language: v.language, type: v.type,
            },
            approval_status: 'pending_review',
            discovered_at: new Date().toISOString(),
          })
          if (!error) results.twitch_helix.items_inserted++
        }
      } else {
        results.twitch_helix.errors.push('Twitch game lookup returned null')
      }
    } catch (err) {
      results.twitch_helix.errors.push(err instanceof Error ? err.message : String(err))
    }
  }

  // ─── YouTube Data API exhaustive ────────────────────────────────────────
  const ytKey = process.env.YOUTUBE_DATA_API_KEY
  if (ytKey) {
    results.youtube_data_api.attempted = true
    const publishedAfter = new Date(Date.now() - 60 * 86400000).toISOString()
    const LANGS = ['', 'id', 'es', 'pt', 'de', 'fr', 'ja']
    for (const v of variants.slice(0, 4)) {
      for (const lang of LANGS) {
        try {
          const items = await searchVideosExhaustive(ytKey, {
            query: v,
            maxResults: 50,
            publishedAfter,
            ...(lang ? { relevanceLanguage: lang } : {}),
          }, 3)
          results.youtube_data_api.items_found += items.length
          for (const r of items) {
            const url = `https://www.youtube.com/watch?v=${r.videoId}`
            if (existingUrls.has(url)) continue
            existingUrls.add(url)
            const oid = await outlet(`youtube.com/channel/${r.channelId}`, r.channelTitle || 'YouTube Channel', null, 'D')
            const { error } = await supabase.from('coverage_items').insert({
              client_id: game.client_id, game_id: game.id, outlet_id: oid,
              title: r.title, url,
              publish_date: r.publishedAt ? r.publishedAt.split('T')[0] : null,
              coverage_type: 'video', source_type: 'youtube',
              source_metadata: {
                youtube_data_api: true, video_id: r.videoId,
                channel_id: r.channelId, channel_title: r.channelTitle,
                search_query: v, relevance_language: lang || 'default',
              },
              approval_status: 'pending_review',
              discovered_at: new Date().toISOString(),
            })
            if (!error) results.youtube_data_api.items_inserted++
          }
        } catch (err) {
          results.youtube_data_api.errors.push(`${v}|${lang||'def'}: ${err instanceof Error ? err.message.substring(0,80) : ''}`)
        }
      }
    }
  }

  // ─── Reddit JSON ────────────────────────────────────────────────────────
  results.reddit_json.attempted = true
  const { data: redditSrc } = await supabase
    .from('coverage_sources').select('config').eq('game_id', game.id).eq('source_type', 'reddit').maybeSingle()
  const cfg = redditSrc?.config as { subreddits?: string[] } | null
  const subs = (Array.isArray(cfg?.subreddits) ? cfg!.subreddits : []) as string[]
  const posts: RedditPost[] = []
  try {
    for (const v of variants.slice(0, 4)) {
      posts.push(...await searchReddit(`"${v}"`, 'month', 25))
      for (const sub of subs.slice(0, 8)) {
        posts.push(...await searchSubreddit(sub, v, 'month', 25))
      }
    }
  } catch (err) {
    results.reddit_json.errors.push(err instanceof Error ? err.message : String(err))
  }
  const redditOutletId = await outlet('reddit.com', 'Reddit', 1_700_000_000, 'A')
  const seen = new Set<string>()
  for (const p of posts) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    if (existingUrls.has(p.url)) continue
    existingUrls.add(p.url)
    results.reddit_json.items_found++
    const { error } = await supabase.from('coverage_items').insert({
      client_id: game.client_id, game_id: game.id, outlet_id: redditOutletId,
      title: p.title.substring(0, 500), url: p.url,
      publish_date: new Date(p.created_utc * 1000).toISOString().split('T')[0],
      coverage_type: 'mention', source_type: 'reddit',
      source_metadata: {
        reddit_public_api: true, reddit_post_id: p.id, subreddit: p.subreddit,
        author: p.author, score: p.score, comments: p.num_comments,
      },
      approval_status: 'pending_review',
      discovered_at: new Date().toISOString(),
    })
    if (!error) results.reddit_json.items_inserted++
  }

  // Set lock
  await supabase.from('service_settings').upsert({
    key: 'oneshot_darkpals_backfill_done',
    value: true,
  }, { onConflict: 'key' })

  const totalInserted = Object.values(results).reduce((s, r) => s + r.items_inserted, 0)
  const totalFound = Object.values(results).reduce((s, r) => s + r.items_found, 0)

  return NextResponse.json({
    message: `One-shot Dark Pals backfill: +${totalInserted} new of ${totalFound} found`,
    game: game.name,
    total_new_items: totalInserted,
    total_found: totalFound,
    channels: results,
  })
}
