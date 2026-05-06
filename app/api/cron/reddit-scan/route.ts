import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { inferTerritory } from '@/lib/territory'
import { detectOutletCountry } from '@/lib/outlet-country'
import { checkApifyCredits, notifyLowCredits, checkApifyDailyBudget, logApifyRun } from '@/lib/apify-utils'

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

    // Check Apify credits before proceeding
    const creditCheck = await checkApifyCredits(apifyKey)
    if (!creditCheck.hasCredits) {
      if (creditCheck.remainingUsd !== null) {
        await notifyLowCredits(creditCheck.remainingUsd)
      }
      return NextResponse.json({
        message: `Apify credits low ($${creditCheck.remainingUsd?.toFixed(2) ?? 'unknown'} remaining), skipping scan`,
        credits_remaining: creditCheck.remainingUsd
      })
    }

    // Daily call budget — backstop against runaway spend.
    const budget = await checkApifyDailyBudget(supabase)
    if (!budget.ok) {
      return NextResponse.json({
        message: `Daily Apify call cap reached (${budget.callsToday}/${budget.limit}), skipping scan`,
        calls_today: budget.callsToday,
      })
    }

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

    // Get Reddit sources with subreddit configs (each source is scoped to one game)
    const { data: redditSources } = await supabase
      .from('coverage_sources')
      .select('id, config, game_id')
      .eq('source_type', 'reddit')
      .eq('is_active', true)

    let totalFound = 0
    let totalNew = 0

    // Per-source scan: each source's subreddits run ONLY against that source's game's
    // keywords. Was previously a global cross-product (every game's keywords against
    // every source's subreddits = N_groups × N_subreddits calls/day).
    if (redditSources) {
      for (const source of redditSources) {
        const cfg = source.config as Record<string, unknown> | null
        if (!cfg) continue

        // Find the matching keyword group for this source's game.
        const matchingGroup = Array.from(keywordGroups.values()).find(g => g.gameId === source.game_id)
        if (!matchingGroup) continue

        const queries = matchingGroup.keywords.slice(0, 5)

        // Collect subreddits for THIS source only.
        const subreddits: string[] = []
        if (Array.isArray(cfg.subreddits)) {
          for (const sub of cfg.subreddits) subreddits.push(String(sub).toLowerCase())
        }
        if (typeof cfg.subreddit === 'string') {
          subreddits.push(cfg.subreddit.toLowerCase())
        }
        if (subreddits.length === 0) continue

        try {
          for (const subreddit of subreddits) {
            // Re-check daily budget mid-loop.
            const midBudget = await checkApifyDailyBudget(supabase)
            if (!midBudget.ok) {
              console.warn(`Reddit scan stopping mid-loop: daily cap reached (${midBudget.callsToday}/${midBudget.limit})`)
              break
            }
            const res = await callRedditActor(supabase, apifyKey, queries, subreddit)
            if (res) {
              const result = await processRedditPosts(supabase, res, matchingGroup.clientId, matchingGroup.gameId)
              totalFound += result.found
              totalNew += result.newItems
            }
          }
        } catch (err) {
          console.error(`Reddit Apify scan error for source ${source.id}:`, err)
        }
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
      sources_scanned: redditSources?.length ?? 0,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Reddit scan error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// Call the Apify Reddit actor
async function callRedditActor(
  supabase: ReturnType<typeof getSupabase>,
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
    // 'day' = last 24h. Was 'month' — caused us to re-pay for 30 days of posts every day.
    timeframe: 'day',
  }

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
    await logApifyRun(supabase, {
      scanner: 'reddit-scan', actor_id: APIFY_REDDIT_ACTOR, input: body,
      results_count: null, http_status: actorRes.status, ok: false, error: `HTTP ${actorRes.status}`,
    })
    return null
  }

  const posts = await actorRes.json()
  const isArr = Array.isArray(posts)
  await logApifyRun(supabase, {
    scanner: 'reddit-scan', actor_id: APIFY_REDDIT_ACTOR, input: body,
    results_count: isArr ? posts.length : null, http_status: actorRes.status, ok: isArr, error: null,
  })
  if (!isArr) return null
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
          country: detectOutletCountry(subredditDomain),
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
