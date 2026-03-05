import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { inferTerritory } from '@/lib/territory'

function getSupabase() {
  return getServerSupabase()
}

// Apify Twitter/X scraper actor — verified working
const APIFY_TWITTER_ACTOR = 'kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest'

// GET /api/cron/twitter-scan — Scan Twitter/X for game mentions via Apify
// Two modes:
//   1. Keyword search — catches mentions across all of Twitter
//   2. Targeted handle search — scans specific Twitter handles from coverage_sources config
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

    // Get Twitter sources with handle configs
    const { data: twitterSources } = await supabase
      .from('coverage_sources')
      .select('id, config, game_id')
      .eq('source_type', 'twitter')
      .eq('is_active', true)

    // Collect all configured handles across all sources
    const configuredHandles: Set<string> = new Set()
    if (twitterSources) {
      for (const source of twitterSources) {
        const cfg = source.config as Record<string, unknown> | null
        if (!cfg) continue
        if (cfg.handles && Array.isArray(cfg.handles)) {
          for (const handle of cfg.handles) configuredHandles.add(String(handle).toLowerCase().replace(/^@/, ''))
        }
        if (cfg.handle && typeof cfg.handle === 'string') {
          configuredHandles.add(cfg.handle.toLowerCase().replace(/^@/, ''))
        }
      }
    }

    let totalFound = 0
    let totalNew = 0

    for (const [, group] of Array.from(keywordGroups.entries())) {
      const queries = group.keywords.slice(0, 5) // Max 5 queries per group

      try {
        // Keyword search — search across all of Twitter
        const keywordResults = await callTwitterActor(apifyKey, queries, undefined)
        if (keywordResults) {
          const result = await processTwitterPosts(supabase, keywordResults, group.clientId, group.gameId)
          totalFound += result.found
          totalNew += result.newItems
        }

        // Handle search — search specific handles (one call per handle since
        // twitterHandles may not be additive with searchTerms)
        for (const handle of Array.from(configuredHandles)) {
          const handleResults = await callTwitterActor(apifyKey, undefined, [handle])
          if (handleResults) {
            const result = await processTwitterPosts(supabase, handleResults, group.clientId, group.gameId)
            totalFound += result.found
            totalNew += result.newItems
          }
        }
      } catch (err) {
        console.error(`Twitter Apify scan error for keywords [${queries.join(', ')}]:`, err)
      }
    }

    // Update source run metadata
    if (twitterSources) {
      for (const source of twitterSources) {
        await supabase
          .from('coverage_sources')
          .update({
            last_run_at: new Date().toISOString(),
            last_run_status: 'success',
            last_run_message: `Found ${totalFound} tweets, ${totalNew} new`,
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
      message: `Twitter scan complete: ${totalFound} found, ${totalNew} new`,
      found: totalFound,
      new_items: totalNew,
      handles_tracked: Array.from(configuredHandles),
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Twitter scan error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// Call the Apify Twitter actor
async function callTwitterActor(
  apifyKey: string,
  searchTerms: string[] | undefined,
  twitterHandles: string[] | undefined
): Promise<TwitterPost[] | null> {
  const body: Record<string, unknown> = {
    maxItems: 20,
    sort: 'Latest',
  }

  if (searchTerms && searchTerms.length > 0) {
    body.searchTerms = searchTerms
  }

  if (twitterHandles && twitterHandles.length > 0) {
    body.twitterHandles = twitterHandles
  }

  const actorRes = await fetch(
    `https://api.apify.com/v2/acts/${APIFY_TWITTER_ACTOR}/run-sync-get-dataset-items?token=${apifyKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  )

  if (!actorRes.ok) {
    console.error(`Apify Twitter actor error: ${actorRes.status}`)
    return null
  }

  const tweets = await actorRes.json()
  if (!Array.isArray(tweets)) return null
  return tweets as TwitterPost[]
}

interface TwitterAuthor {
  name?: string
  userName?: string
  followers?: number
  profilePicture?: string
  isBlueVerified?: boolean
  description?: string
}

interface TwitterPost {
  id?: string
  text?: string
  url?: string
  twitterUrl?: string
  createdAt?: string
  author?: TwitterAuthor
  likeCount?: number
  retweetCount?: number
  replyCount?: number
  quoteCount?: number
  viewCount?: number
  bookmarkCount?: number
  lang?: string
  isReply?: boolean
  type?: string
}

// Process Twitter posts into coverage items
async function processTwitterPosts(
  supabase: ReturnType<typeof getSupabase>,
  posts: TwitterPost[],
  clientId: string,
  gameId: string | null
): Promise<{ found: number; newItems: number }> {
  let newItems = 0

  for (const tweet of posts) {
    // Use url field (primary) or twitterUrl (fallback)
    const tweetUrl = tweet.url || tweet.twitterUrl
    if (!tweetUrl) continue

    // Skip replies to reduce noise (unless they have significant engagement)
    if (tweet.isReply && (tweet.likeCount || 0) < 10) continue

    // Check for existing item by URL
    const { data: existing } = await supabase
      .from('coverage_items')
      .select('id')
      .eq('url', tweetUrl)
      .eq('client_id', clientId)
      .limit(1)

    if (existing && existing.length > 0) continue

    const authorName = tweet.author?.name || 'Unknown'
    const authorHandle = tweet.author?.userName || ''
    const followers = Number(tweet.author?.followers || 0)
    const publishDate = tweet.createdAt
      ? new Date(tweet.createdAt).toISOString().split('T')[0]
      : null

    // Find or create outlet for author
    const authorDomain = `x.com/${authorHandle || authorName.toLowerCase().replace(/\s+/g, '')}`
    let outletId: string | null = null

    const { data: existingOutlet } = await supabase
      .from('outlets')
      .select('id, is_blacklisted')
      .eq('domain', authorDomain)
      .limit(1)

    if (existingOutlet && existingOutlet.length > 0) {
      if (existingOutlet[0].is_blacklisted) continue // Skip blacklisted outlets
      outletId = existingOutlet[0].id
    } else {
      const { data: newOutlet } = await supabase
        .from('outlets')
        .insert({
          name: authorName,
          domain: authorDomain,
          monthly_unique_visitors: followers,
          tier: followers >= 1000000 ? 'A' : followers >= 100000 ? 'B' : followers >= 10000 ? 'C' : 'D',
          is_active: true,
        })
        .select('id')
        .single()
      if (newOutlet) outletId = newOutlet.id
    }

    const tweetText = tweet.text || ''

    await supabase.from('coverage_items').insert({
      client_id: clientId,
      game_id: gameId,
      outlet_id: outletId,
      title: tweetText.length > 200 ? tweetText.substring(0, 200) + '...' : tweetText || 'Tweet',
      url: tweetUrl,
      publish_date: publishDate,
      coverage_type: 'mention',
      monthly_unique_visitors: followers,
      territory: inferTerritory(null, null, tweet.lang) || 'International',
      source_type: 'twitter',
      source_metadata: {
        tweet_id: tweet.id,
        author_name: authorName,
        author_handle: authorHandle,
        followers,
        is_verified: tweet.author?.isBlueVerified || false,
        retweets: tweet.retweetCount || 0,
        likes: tweet.likeCount || 0,
        replies: tweet.replyCount || 0,
        quotes: tweet.quoteCount || 0,
        views: tweet.viewCount || 0,
        bookmarks: tweet.bookmarkCount || 0,
        type: tweet.type || 'tweet',
      },
      approval_status: 'pending_review',
      discovered_at: new Date().toISOString(),
    })

    newItems++
  }

  return { found: posts.length, newItems }
}
