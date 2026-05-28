/**
 * GET /api/cron/reddit-public-scan
 *
 * Apify-free Reddit discovery via Reddit's public JSON API. Runs alongside
 * (or replaces) the existing Apify reddit-scan when Apify quota is
 * unavailable.
 *
 * Per game, for each subreddit in the game's reddit coverage_source config:
 *   1. For each keyword variant, run an in-sub search (catches keyword
 *      mentions in that sub specifically)
 *   2. Pull the sub's /new firehose, filter to posts mentioning any variant
 *      (catches keyword mentions we'd miss if Reddit's search index lags)
 *
 * Plus one global Reddit search per keyword variant (catches mentions in
 * subreddits we don't yet subscribe to — those become candidates for the
 * subreddit list).
 *
 * Cost: $0. Quota: ~14 requests per game per run, way under Reddit's soft
 * limit.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { verifyCronAuth } from '@/lib/cron-auth'
import { searchSubreddit, searchReddit, getSubredditNew, postMentions, type RedditPost } from '@/lib/reddit-public-api'
import { detectOutletCountry } from '@/lib/outlet-country'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

const VARIANTS_PER_GAME = 3
const SUBS_PER_GAME = 6
const RESULTS_PER_QUERY = 20

interface GameRow { id: string; name: string; client_id: string }

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request)
  if (authError) return authError

  const supabase = getServerSupabase()

  const { data: games } = await supabase
    .from('games')
    .select('id, name, client_id')
    .eq('pr_tracking_enabled', true)
  if (!games || games.length === 0) {
    return NextResponse.json({ message: 'No PR-tracked games' })
  }

  // Pull existing Reddit URLs for cheap dedup
  const { data: existing } = await supabase
    .from('coverage_items')
    .select('url')
    .like('url', '%reddit.com%')
    .limit(10000)
  const existingUrls = new Set((existing || []).map((r: { url: string }) => r.url))

  // Resolve Reddit outlet ID (we always credit Reddit as the outlet — outlet_id
  // is constant). Auto-create if missing.
  async function getRedditOutletId(): Promise<string | null> {
    const { data } = await supabase.from('outlets').select('id').eq('domain', 'reddit.com').maybeSingle()
    if (data?.id) return data.id
    const { data: created } = await supabase.from('outlets').insert({
      name: 'Reddit',
      domain: 'reddit.com',
      country: 'US',
      tier: 'A',
      monthly_unique_visitors: 1_700_000_000,
      is_active: true,
    }).select('id').single()
    return created?.id ?? null
  }
  const redditOutletId = await getRedditOutletId()

  const results: Array<{
    game: string; queries_made: number;
    candidates_found: number; new_inserted: number;
    discovered_subreddits: string[];
    errors: string[];
  }> = []

  for (const game of games as GameRow[]) {
    const r: typeof results[number] = {
      game: game.name, queries_made: 0,
      candidates_found: 0, new_inserted: 0,
      discovered_subreddits: [],
      errors: [],
    }

    // Resolve this game's reddit config + whitelist keyword variants
    const { data: redditSrc } = await supabase
      .from('coverage_sources')
      .select('config')
      .eq('game_id', game.id)
      .eq('source_type', 'reddit')
      .maybeSingle()
    const cfg = redditSrc?.config as { subreddits?: unknown; min_upvotes?: number } | null
    const subreddits = (Array.isArray(cfg?.subreddits) ? cfg!.subreddits : []).slice(0, SUBS_PER_GAME) as string[]
    const minUpvotes = typeof cfg?.min_upvotes === 'number' ? cfg!.min_upvotes : 0

    const { data: kws } = await supabase
      .from('coverage_keywords')
      .select('keyword')
      .eq('game_id', game.id)
      .eq('keyword_type', 'whitelist')
      .eq('is_active', true)
    const variants = (kws || []).map((k: { keyword: string }) => k.keyword)
    if (variants.length === 0) {
      results.push(r)
      continue
    }
    const topVariants = variants.slice(0, VARIANTS_PER_GAME)

    // Phase 1: per-subreddit keyword search
    const candidates: RedditPost[] = []
    try {
      for (const sub of subreddits) {
        for (const v of topVariants) {
          const posts = await searchSubreddit(sub, v, 'month', RESULTS_PER_QUERY)
          r.queries_made++
          candidates.push(...posts)
        }
        // Also pull firehose, filter locally — catches recent posts where
        // Reddit's search index hasn't indexed yet.
        const fresh = await getSubredditNew(sub, RESULTS_PER_QUERY)
        r.queries_made++
        for (const p of fresh) {
          if (postMentions(p, variants)) candidates.push(p)
        }
      }
    } catch (err) {
      r.errors.push(`sub-search: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Phase 2: global Reddit search (catches subs we don't subscribe to)
    try {
      for (const v of topVariants) {
        const posts = await searchReddit(`"${v}"`, 'week', RESULTS_PER_QUERY)
        r.queries_made++
        for (const p of posts) {
          candidates.push(p)
          // Track subs we don't currently subscribe to as discovery hints
          if (!subreddits.includes(p.subreddit) && !r.discovered_subreddits.includes(p.subreddit)) {
            r.discovered_subreddits.push(p.subreddit)
          }
        }
      }
    } catch (err) {
      r.errors.push(`global-search: ${err instanceof Error ? err.message : String(err)}`)
    }

    r.candidates_found = candidates.length

    // Dedupe + insert
    const seen = new Set<string>()
    for (const p of candidates) {
      if (seen.has(p.id)) continue
      seen.add(p.id)
      if (existingUrls.has(p.url)) continue
      existingUrls.add(p.url)
      if (p.score < minUpvotes) continue

      const publishDate = new Date(p.created_utc * 1000).toISOString().split('T')[0]
      const { error } = await supabase.from('coverage_items').insert({
        client_id: game.client_id,
        game_id: game.id,
        outlet_id: redditOutletId,
        title: p.title.substring(0, 500),
        url: p.url,
        publish_date: publishDate,
        coverage_type: 'mention',
        source_type: 'reddit',
        source_metadata: {
          reddit_post_id: p.id,
          subreddit: p.subreddit,
          author: p.author,
          score: p.score,
          comments: p.num_comments,
          reddit_public_api: true,  // distinguish from Apify-discovered
        },
        approval_status: 'pending_review',
        discovered_at: new Date().toISOString(),
      })
      if (!error) r.new_inserted++
    }

    // Refresh the reddit source's run metadata
    if (redditSrc) {
      await supabase.from('coverage_sources').update({
        last_run_at: new Date().toISOString(),
        last_run_status: 'success',
        last_run_message: `Reddit JSON API: +${r.new_inserted} items from ${r.queries_made} queries`,
        items_found_last_run: r.new_inserted,
      }).eq('game_id', game.id).eq('source_type', 'reddit')
    }

    results.push(r)
  }

  // Auto-detection: if a sub appears in discovered_subreddits across 3+ games,
  // surface it as a high-value sub to consider subscribing to.
  const subCounts = new Map<string, number>()
  for (const r of results) for (const s of r.discovered_subreddits) {
    subCounts.set(s, (subCounts.get(s) || 0) + 1)
  }
  const recommendedSubs = Array.from(subCounts.entries())
    .filter(([, c]) => c >= 3)
    .map(([s]) => s)
    .filter(s => !['gaming', 'pcgaming', 'indiegaming'].includes(s))

  const totalInserted = results.reduce((s, r) => s + r.new_inserted, 0)
  return NextResponse.json({
    message: `Reddit public API scan: +${totalInserted} items across ${results.length} games`,
    games_scanned: results.length,
    total_new: totalInserted,
    cost_usd: 0,
    recommended_subreddits_to_subscribe: recommendedSubs,
    results,
  })
}
