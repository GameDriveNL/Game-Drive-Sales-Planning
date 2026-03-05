import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { inferTerritory } from '@/lib/territory'

function getSupabase() {
  return getServerSupabase()
}

// Apify Reddit scraper actor — verified working
const APIFY_REDDIT_ACTOR = 'fatihtahta~reddit-scraper-search-fast'

// GET /api/cron/reddit-scan — Scan Reddit for game mentions via Apify
// Two modes:
//   1. General keyword search (no subreddit filter) — catches mentions across all of Reddit
//   2. Targeted subreddit search — scans specific subreddits from coverage_sources config
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabase()

  try {
    // Get Apify API key
    const { data: keyData } = await supabase
      .from('service_api_keys')
      .select('api_key')
      .eq('service_name', 'apify')
      .eq('is_active', true)
      .single()

    if (!keyData?.api_key) {
      return NextResponse.json({ message: 'Apify API key not configured, skipping' })
    }

    const apifyKey = keyData.api_key

    // Get whitelist keywords grouped by client+game
    const { data: keywords } = await supabase
      .from('coverage_keywords')
      .select('keyword, client_id, game_id')
      .eq('keyword_type', 'whitelist')

    if (!keywords || keywords.length === 0) {
      return NextResponse.json({ message: 'No keywords configured' })
    }

    // Group keywords by client+game
    const keywordGroups: Map<string, { keywords: string[]; clientId: string; gameId: string | null }> = new Map()
    for (const kw of keywords) {
      const key = `${kw.client_id}|${kw.game_id || ''}`
      if (!keywordGroups.has(key)) {
        keywordGroups.set(key, { keywords: [], clientId: kw.client_id, gameId: kw.game_id })
      }
      keywordGroups.get(key)!.keywords.push(kw.keyword)
    }

    // Get Reddit sources with subreddit configs
    const { data: redditSources } = await supabase
      .from('coverage_sources')
      .select('id, config, game_id')
      .eq('source_type', 'reddit')
      .eq('is_active', true)

    // Collect all configured subreddits across all sources
    const configuredSubreddits: Set<string> = new Set()
    if (redditSources) {
      for (const source of redditSources) {
        const cfg = source.config as Record<string, unknown> | null
        if (!cfg) continue
        // Support both singular and plural config fields
        if (cfg.subreddits && Array.isArray(cfg.subreddits)) {
          for (const sub of cfg.subreddits) configuredSubreddits.add(String(sub).toLowerCase())
        }
        if (cfg.subreddit && typeof cfg.subreddit === 'string') {
          configuredSubreddits.add(cfg.subreddit.toLowerCase())
        }
      }
    }

    let totalFound = 0
    let totalNew = 0

    for (const [, group] of Array.from(keywordGroups.entries())) {
      // Use all keywords as search queries
      const queries = group.keywords.slice(0, 5) // Max 5 queries per group to limit cost

      try {
        // subredditName is ADDITIVE — each call always includes general Reddit results
        // plus results from the specified subreddit. So to save credits:
        // - If user configured subreddits: make ONE call with the first subreddit
        //   (this gets general results + that subreddit's results in a single call)
        // - If no subreddits configured: make ONE general call (no subredditName)
        // Dedup by URL prevents duplicate inserts across calls.

        const subredditList = Array.from(configuredSubreddits)

        if (subredditList.length === 0) {
          // No subreddits configured — just do a general search
          const res = await callRedditActor(apifyKey, queries, undefined)
          if (res) {
            const result = await processRedditPosts(supabase, res, group.clientId, group.gameId)
            totalFound += result.found
            totalNew += result.newItems
          }
        } else {
          // Each call is additive (general + subreddit), so one call per subreddit.
          // The general results overlap across calls but dedup handles it.
          for (const subreddit of subredditList) {
            const res = await callRedditActor(apifyKey, queries, subreddit)
            if (res) {
              const result = await processRedditPosts(supabase, res, group.clientId, group.gameId)
              totalFound += result.found
              totalNew += result.newItems
            }
          }
        }
      } catch (err) {
        console.error(`Reddit Apify scan error for keywords [${queries.join(', ')}]:`, err)
      }
    }

    // Update source run metadata
    if (redditSources) {
      for (const source of redditSources) {
        await supabase
          .from('coverage_sources')
          .update({
            last_run_at: new Date().toISOString(),
            last_run_status: 'success',
            last_run_message: `Found ${totalFound} posts, ${totalNew} new`,
            items_found_last_run: totalNew,
            total_items_found: (source as unknown as Record<string, number>).total_items_found
              ? ((source as unknown as Record<string, number>).total_items_found || 0) + totalNew
              : totalNew,
            consecutive_failures: 0,
            updated_at: new Date().toISOString(),
          })
          .eq('id', source.id)
      }
    }

    return NextResponse.json({
      message: `Reddit scan complete: ${totalFound} found, ${totalNew} new`,
      found: totalFound,
      new_items: totalNew,
      subreddits_tracked: Array.from(configuredSubreddits),
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Reddit scan error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// Call the Apify Reddit actor
async function callRedditActor(
  apifyKey: string,
  queries: string[],
  subredditName: string | undefined
): Promise<RedditPost[] | null> {
  const body: Record<string, unknown> = {
    queries,
    maxPosts: 10,
    maxComments: 1,
    scrapeComments: false,
    includeNsfw: false,
    sort: 'new',
    timeframe: 'month',
  }

  // Only add subredditName if targeting a specific subreddit
  if (subredditName) {
    body.subredditName = subredditName
  }

  const actorRes = await fetch(
    `https://api.apify.com/v2/acts/${APIFY_REDDIT_ACTOR}/run-sync-get-dataset-items?token=${apifyKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  )

  if (!actorRes.ok) {
    console.error(`Apify Reddit actor error: ${actorRes.status}`)
    return null
  }

  const posts = await actorRes.json()
  if (!Array.isArray(posts)) return null
  return posts as RedditPost[]
}

interface RedditPost {
  kind?: string
  id?: string
  title?: string
  body?: string
  author?: string
  score?: number
  upvote_ratio?: number
  num_comments?: number
  subreddit?: string
  created_utc?: string
  url?: string
  flair?: string
  over_18?: boolean
  is_video?: boolean
  domain?: string
  is_self?: boolean
}

// Process Reddit posts into coverage items
async function processRedditPosts(
  supabase: ReturnType<typeof getSupabase>,
  posts: RedditPost[],
  clientId: string,
  gameId: string | null
): Promise<{ found: number; newItems: number }> {
  let newItems = 0

  for (const post of posts) {
    if (!post.url) continue

    // Skip NSFW
    if (post.over_18) continue

    const url = post.url

    // Check for existing item by URL
    const { data: existing } = await supabase
      .from('coverage_items')
      .select('id')
      .eq('url', url)
      .eq('client_id', clientId)
      .limit(1)

    if (existing && existing.length > 0) continue

    const publishDate = post.created_utc
      ? new Date(post.created_utc).toISOString().split('T')[0]
      : null

    const subreddit = post.subreddit || 'unknown'
    const subredditDomain = `reddit.com/r/${subreddit}`

    // Find or create outlet for subreddit
    let outletId: string | null = null

    const { data: existingOutlet } = await supabase
      .from('outlets')
      .select('id, is_blacklisted')
      .eq('domain', subredditDomain)
      .limit(1)

    if (existingOutlet && existingOutlet.length > 0) {
      if (existingOutlet[0].is_blacklisted) continue // Skip blacklisted outlets
      outletId = existingOutlet[0].id
    } else {
      const { data: newOutlet } = await supabase
        .from('outlets')
        .insert({
          name: `r/${subreddit}`,
          domain: subredditDomain,
          tier: 'C',
          is_active: true,
        })
        .select('id')
        .single()
      if (newOutlet) outletId = newOutlet.id
    }

    // Determine coverage type based on content
    const coverageType = post.is_video ? 'video'
      : post.is_self ? 'mention'
      : post.domain && !post.domain.startsWith('self.') ? 'news'
      : 'mention'

    await supabase.from('coverage_items').insert({
      client_id: clientId,
      game_id: gameId,
      outlet_id: outletId,
      title: post.title || 'Untitled Post',
      url,
      publish_date: publishDate,
      coverage_type: coverageType,
      territory: 'International',
      source_type: 'reddit',
      source_metadata: {
        post_id: post.id,
        subreddit,
        author: post.author,
        score: post.score || 0,
        num_comments: post.num_comments || 0,
        upvote_ratio: post.upvote_ratio || 0,
        flair: post.flair || null,
        is_video: post.is_video || false,
        domain: post.domain || null,
      },
      approval_status: 'pending_review',
      discovered_at: new Date().toISOString(),
    })

    newItems++
  }

  return { found: posts.length, newItems }
}
