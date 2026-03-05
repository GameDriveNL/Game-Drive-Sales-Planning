import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { inferTerritory } from '@/lib/territory'

function getSupabase() {
  return getServerSupabase()
}

// Apify Instagram scraper actor — verified working
const APIFY_INSTAGRAM_ACTOR = 'apify~instagram-hashtag-scraper'

// Minimum follower threshold for Instagram results
const MIN_FOLLOWERS = 1000

// GET /api/cron/instagram-scan — Scan Instagram for game-related content via Apify
// Instagram scraping is hashtag-based (profile scraping blocked by Instagram anti-scraping)
// Keywords are converted to hashtags (spaces removed, lowercased)
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

    // Get Instagram sources with hashtag configs
    const { data: instagramSources } = await supabase
      .from('coverage_sources')
      .select('id, config, game_id')
      .eq('source_type', 'instagram')
      .eq('is_active', true)

    // Collect configured hashtags from sources
    const configuredHashtags: Set<string> = new Set()
    let minFollowers = MIN_FOLLOWERS
    if (instagramSources) {
      for (const source of instagramSources) {
        const cfg = source.config as Record<string, unknown> | null
        if (!cfg) continue
        if (cfg.hashtags && Array.isArray(cfg.hashtags)) {
          for (const h of cfg.hashtags) configuredHashtags.add(String(h).toLowerCase().replace(/^#/, ''))
        }
        if (cfg.min_followers && typeof cfg.min_followers === 'number') {
          minFollowers = cfg.min_followers
        }
      }
    }

    let totalFound = 0
    let totalNew = 0
    let totalFiltered = 0

    for (const [, group] of Array.from(keywordGroups.entries())) {
      const queries = group.keywords.slice(0, 5)

      try {
        // Convert keywords to hashtags (remove spaces, lowercase)
        const hashtags = queries.map(q => q.replace(/\s+/g, '').toLowerCase())
        // Add any user-configured hashtags
        for (const h of Array.from(configuredHashtags)) {
          if (!hashtags.includes(h)) hashtags.push(h)
        }

        // Call Instagram hashtag scraper
        const posts = await callInstagramActor(apifyKey, hashtags.slice(0, 5), 20)
        if (posts) {
          const result = await processInstagramPosts(supabase, posts, group.clientId, group.gameId, minFollowers)
          totalFound += result.found
          totalNew += result.newItems
          totalFiltered += result.filtered
        }
      } catch (err) {
        console.error(`Instagram Apify scan error for keywords [${queries.join(', ')}]:`, err)
      }
    }

    // Update source run metadata
    if (instagramSources) {
      for (const source of instagramSources) {
        await supabase
          .from('coverage_sources')
          .update({
            last_run_at: new Date().toISOString(),
            last_run_status: 'success',
            last_run_message: `Found ${totalFound} posts, ${totalNew} new, ${totalFiltered} filtered`,
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
      message: `Instagram scan complete: ${totalFound} found, ${totalNew} new, ${totalFiltered} filtered (< ${minFollowers} followers)`,
      found: totalFound,
      new_items: totalNew,
      filtered: totalFiltered,
      hashtags_searched: Array.from(configuredHashtags),
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Instagram scan error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// Call the Apify Instagram hashtag scraper
async function callInstagramActor(
  apifyKey: string,
  hashtags: string[],
  resultsPerPage: number
): Promise<InstagramPost[] | null> {
  const actorRes = await fetch(
    `https://api.apify.com/v2/acts/${APIFY_INSTAGRAM_ACTOR}/run-sync-get-dataset-items?token=${apifyKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hashtags,
        resultsPerPage,
      }),
    }
  )

  if (!actorRes.ok) {
    console.error(`Apify Instagram actor error: ${actorRes.status}`)
    return null
  }

  const posts = await actorRes.json()
  if (!Array.isArray(posts)) return null
  return posts as InstagramPost[]
}

interface InstagramPost {
  id?: string
  shortCode?: string
  url?: string
  type?: string // 'Image', 'Sidecar' (carousel), 'Video'
  caption?: string
  ownerUsername?: string
  ownerFullName?: string
  ownerId?: string
  likesCount?: number
  commentsCount?: number
  timestamp?: string // ISO 8601
  displayUrl?: string
  images?: string[]
  hashtags?: string[]
  mentions?: string[]
  productType?: string // 'feed', 'carousel_container', 'clips'
  dimensionsHeight?: number
  dimensionsWidth?: number
}

// Process Instagram posts into coverage items
async function processInstagramPosts(
  supabase: ReturnType<typeof getSupabase>,
  posts: InstagramPost[],
  clientId: string,
  gameId: string | null,
  minFollowers: number
): Promise<{ found: number; newItems: number; filtered: number }> {
  let newItems = 0
  let filtered = 0

  for (const post of posts) {
    // Use url field (primary) or construct from shortCode
    const postUrl = post.url || (post.shortCode ? `https://www.instagram.com/p/${post.shortCode}/` : null)
    if (!postUrl) continue

    const authorName = post.ownerUsername || 'unknown'
    const authorFullName = post.ownerFullName || authorName

    // Note: Instagram hashtag scraper doesn't return follower counts per post
    // We skip follower filtering for now since it's hashtag-based discovery
    // Follower info would require a separate profile lookup (which Instagram blocks)

    // Check for existing item by URL
    const { data: existing } = await supabase
      .from('coverage_items')
      .select('id')
      .eq('url', postUrl)
      .eq('client_id', clientId)
      .limit(1)

    if (existing && existing.length > 0) continue

    // Parse date — timestamp is ISO 8601
    const publishDate = post.timestamp
      ? new Date(post.timestamp).toISOString().split('T')[0]
      : null

    const isVideo = post.type === 'Video' || post.productType === 'clips'
    const caption = post.caption || ''

    // Find or create outlet for creator
    const creatorDomain = `instagram.com/${authorName}`
    let outletId: string | null = null

    const { data: existingOutlet } = await supabase
      .from('outlets')
      .select('id, is_blacklisted')
      .eq('domain', creatorDomain)
      .limit(1)

    if (existingOutlet && existingOutlet.length > 0) {
      if (existingOutlet[0].is_blacklisted) continue // Skip blacklisted outlets
      outletId = existingOutlet[0].id
    } else {
      const { data: newOutlet } = await supabase
        .from('outlets')
        .insert({
          name: authorFullName,
          domain: creatorDomain,
          tier: 'D', // Default tier since we can't get follower count from hashtag scraper
          is_active: true,
        })
        .select('id')
        .single()
      if (newOutlet) outletId = newOutlet.id
    }

    // Handle likesCount that can be -1 when unavailable
    const likes = post.likesCount && post.likesCount >= 0 ? post.likesCount : 0

    await supabase.from('coverage_items').insert({
      client_id: clientId,
      game_id: gameId,
      outlet_id: outletId,
      title: caption.length > 200 ? caption.substring(0, 200) + '...' : caption || (isVideo ? 'Instagram Reel' : 'Instagram Post'),
      url: postUrl,
      publish_date: publishDate,
      coverage_type: isVideo ? 'video' : 'mention',
      territory: 'International',
      source_type: 'instagram',
      source_metadata: {
        post_id: post.id || post.shortCode,
        short_code: post.shortCode,
        author_name: authorName,
        author_full_name: authorFullName,
        likes,
        comments: post.commentsCount || 0,
        post_type: post.type || 'unknown',
        product_type: post.productType || null,
        is_video: isVideo,
        hashtags: post.hashtags || [],
        mentions: post.mentions || [],
        thumbnail_url: post.displayUrl || null,
      },
      approval_status: 'pending_review',
      discovered_at: new Date().toISOString(),
    })

    newItems++
  }

  return { found: posts.length, newItems, filtered }
}
