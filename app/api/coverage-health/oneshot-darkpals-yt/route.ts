/**
 * POST /api/coverage-health/oneshot-darkpals-yt
 *
 * Sibling to /oneshot-darkpals — this one runs ONLY the YouTube Data API
 * and Reddit JSON phases, which got cut off when the Helix-heavy first
 * oneshot ate the Vercel 300s timeout on Twitch clip inserts.
 *
 * Hot path: exhaustive YouTube searches across 4 keyword variants × 7
 * relevance languages × up to 5 pages each, then Reddit subreddit + global
 * sweeps. No Twitch at all — that already inserted 1308 items via the
 * first oneshot.
 *
 * Self-locks via service_settings.oneshot_darkpals_yt_done. Whitelisted in
 * middleware. Will be removed after parity check confirms YouTube/Reddit
 * jumped.
 */

import { NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { detectOutletCountry } from '@/lib/outlet-country'
import { searchVideosExhaustive } from '@/lib/youtube-data-api'
import { searchSubreddit, searchReddit, type RedditPost } from '@/lib/reddit-public-api'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

const DARK_PALS_GAME_ID = '6ce557eb-0c04-412e-a6da-7fee77738ff9'

export async function POST() {
  const supabase = getServerSupabase()

  const { data: lockRow } = await supabase
    .from('service_settings')
    .select('value')
    .eq('key', 'oneshot_darkpals_yt_done')
    .maybeSingle()
  if (lockRow?.value === true || lockRow?.value === 'true') {
    return NextResponse.json({
      error: 'Already ran. Clear service_settings.oneshot_darkpals_yt_done to re-enable.',
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
    attempted: boolean; items_found: number; items_inserted: number;
    errors: string[]; duration_ms: number
  }> = {
    youtube_data_api: { attempted: false, items_found: 0, items_inserted: 0, errors: [], duration_ms: 0 },
    reddit_json: { attempted: false, items_found: 0, items_inserted: 0, errors: [], duration_ms: 0 },
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

  // ─── YouTube Data API exhaustive ────────────────────────────────────────
  const ytKey = process.env.YOUTUBE_DATA_API_KEY
  if (ytKey) {
    results.youtube_data_api.attempted = true
    const t0 = Date.now()
    // Look back 90 days — Bram's sheet spans about 60 days of coverage
    const publishedAfter = new Date(Date.now() - 90 * 86400000).toISOString()
    // Restrict to top 4 variants × 7 languages × up to 3 pages of 50 = max ~4200
    // results, but each search.list page = 100 quota units → max 8400 units
    // (under the 10K daily quota with room for other crons).
    const LANGS = ['', 'id', 'es', 'pt', 'de', 'fr', 'ja']
    const v4 = variants.slice(0, 4)
    outer: for (const v of v4) {
      for (const lang of LANGS) {
        // Bail early if we're approaching Vercel timeout
        if (Date.now() - t0 > 220_000) {
          results.youtube_data_api.errors.push(`time-budget-exhausted after ${Math.round((Date.now()-t0)/1000)}s`)
          break outer
        }
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
            const oid = await outlet(
              `youtube.com/channel/${r.channelId}`,
              r.channelTitle || 'YouTube Channel',
              null, 'D'
            )
            const { error } = await supabase.from('coverage_items').insert({
              client_id: game.client_id, game_id: game.id, outlet_id: oid,
              title: r.title, url,
              publish_date: r.publishedAt ? r.publishedAt.split('T')[0] : null,
              coverage_type: 'video', source_type: 'youtube',
              source_metadata: {
                youtube_data_api: true, video_id: r.videoId,
                channel_id: r.channelId, channel_title: r.channelTitle,
                search_query: v, relevance_language: lang || 'default',
                oneshot: true,
              },
              approval_status: 'pending_review',
              discovered_at: new Date().toISOString(),
            })
            if (!error) results.youtube_data_api.items_inserted++
          }
        } catch (err) {
          results.youtube_data_api.errors.push(
            `${v}|${lang || 'def'}: ${err instanceof Error ? err.message.substring(0, 80) : ''}`
          )
        }
      }
    }
    results.youtube_data_api.duration_ms = Date.now() - t0
  } else {
    results.youtube_data_api.errors.push('YOUTUBE_DATA_API_KEY missing')
  }

  // ─── Reddit JSON ────────────────────────────────────────────────────────
  results.reddit_json.attempted = true
  const tR = Date.now()
  const { data: redditSrc } = await supabase
    .from('coverage_sources').select('config').eq('game_id', game.id).eq('source_type', 'reddit').maybeSingle()
  const cfg = redditSrc?.config as { subreddits?: string[] } | null
  const subs = (Array.isArray(cfg?.subreddits) ? cfg!.subreddits : []) as string[]
  const posts: RedditPost[] = []
  try {
    for (const v of variants.slice(0, 4)) {
      if (Date.now() - tR > 60_000) break
      posts.push(...await searchReddit(`"${v}"`, 'month', 25))
      for (const sub of subs.slice(0, 12)) {
        if (Date.now() - tR > 60_000) break
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
        author: p.author, score: p.score, comments: p.num_comments, oneshot: true,
      },
      approval_status: 'pending_review',
      discovered_at: new Date().toISOString(),
    })
    if (!error) results.reddit_json.items_inserted++
  }
  results.reddit_json.duration_ms = Date.now() - tR

  await supabase.from('service_settings').upsert({
    key: 'oneshot_darkpals_yt_done',
    value: true,
  }, { onConflict: 'key' })

  const totalInserted = Object.values(results).reduce((s, r) => s + r.items_inserted, 0)
  const totalFound = Object.values(results).reduce((s, r) => s + r.items_found, 0)

  return NextResponse.json({
    message: `One-shot Dark Pals YT+Reddit backfill: +${totalInserted} new of ${totalFound} found`,
    game: game.name,
    total_new_items: totalInserted,
    total_found: totalFound,
    channels: results,
  })
}
