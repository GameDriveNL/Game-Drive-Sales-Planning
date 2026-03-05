import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { inferTerritory } from '@/lib/territory'

function getSupabase() {
  return getServerSupabase()
}

// Apify TikTok scraper actor — verified working
const APIFY_TIKTOK_ACTOR = 'clockworks~free-tiktok-scraper'

// Minimum follower threshold for TikTok results
const MIN_FOLLOWERS = 1000

// GET /api/cron/tiktok-scan — Scan TikTok for game-related content via Apify
// Three modes:
//   1. Hashtag search — converts keywords to hashtags
//   2. Keyword search — full-text search queries
//   3. Profile search — scans specific TikTok profiles from coverage_sources config
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

    // Get TikTok sources with profile configs
    const { data: tiktokSources } = await supabase
      .from('coverage_sources')
      .select('id, config, game_id')
      .eq('source_type', 'tiktok')
      .eq('is_active', true)

    // Collect configured profiles and hashtags from sources
    const configuredProfiles: Set<string> = new Set()
    const configuredHashtags: Set<string> = new Set()
    let minFollowers = MIN_FOLLOWERS
    if (tiktokSources) {
      for (const source of tiktokSources) {
        const cfg = source.config as Record<string, unknown> | null
        if (!cfg) continue
        if (cfg.profiles && Array.isArray(cfg.profiles)) {
          for (const p of cfg.profiles) configuredProfiles.add(String(p).toLowerCase().replace(/^@/, ''))
        }
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

        // Hashtag search
        const hashtagResults = await callTikTokActor(apifyKey, {
          hashtags: hashtags.slice(0, 5),
          resultsPerPage: 10,
        })
        if (hashtagResults) {
          const result = await processTikTokPosts(supabase, hashtagResults, group.clientId, group.gameId, minFollowers)
          totalFound += result.found
          totalNew += result.newItems
          totalFiltered += result.filtered
        }

        // Keyword search (for multi-word queries that don't work as hashtags)
        const multiWordQueries = queries.filter(q => q.includes(' '))
        if (multiWordQueries.length > 0) {
          const keywordResults = await callTikTokActor(apifyKey, {
            searchQueries: multiWordQueries.slice(0, 3),
            resultsPerPage: 10,
          })
          if (keywordResults) {
            const result = await processTikTokPosts(supabase, keywordResults, group.clientId, group.gameId, minFollowers)
            totalFound += result.found
            totalNew += result.newItems
            totalFiltered += result.filtered
          }
        }

        // Profile search — scan specific TikTok creators
        if (configuredProfiles.size > 0) {
          const profileResults = await callTikTokActor(apifyKey, {
            profiles: Array.from(configuredProfiles),
            resultsPerPage: 10,
          })
          if (profileResults) {
            const result = await processTikTokPosts(supabase, profileResults, group.clientId, group.gameId, 0) // No follower filter for targeted profiles
            totalFound += result.found
            totalNew += result.newItems
            totalFiltered += result.filtered
          }
        }
      } catch (err) {
        console.error(`TikTok Apify scan error for keywords [${queries.join(', ')}]:`, err)
      }
    }

    // Update source run metadata
    if (tiktokSources) {
      for (const source of tiktokSources) {
        await supabase
          .from('coverage_sources')
          .update({
            last_run_at: new Date().toISOString(),
            last_run_status: 'success',
            last_run_message: `Found ${totalFound} videos, ${totalNew} new, ${totalFiltered} filtered`,
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
      message: `TikTok scan complete: ${totalFound} found, ${totalNew} new, ${totalFiltered} filtered (< ${minFollowers} followers)`,
      found: totalFound,
      new_items: totalNew,
      filtered: totalFiltered,
      profiles_tracked: Array.from(configuredProfiles),
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('TikTok scan error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// Call the Apify TikTok actor
async function callTikTokActor(
  apifyKey: string,
  body: Record<string, unknown>
): Promise<TikTokPost[] | null> {
  const actorRes = await fetch(
    `https://api.apify.com/v2/acts/${APIFY_TIKTOK_ACTOR}/run-sync-get-dataset-items?token=${apifyKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  )

  if (!actorRes.ok) {
    console.error(`Apify TikTok actor error: ${actorRes.status}`)
    return null
  }

  const videos = await actorRes.json()
  if (!Array.isArray(videos)) return null
  return videos as TikTokPost[]
}

interface TikTokAuthorMeta {
  name?: string
  nickName?: string
  fans?: number
  heart?: number
  video?: number
  verified?: boolean
  profileUrl?: string
  avatar?: string
  signature?: string
}

interface TikTokVideoMeta {
  duration?: number
  height?: number
  width?: number
  definition?: string
  coverUrl?: string
}

interface TikTokPost {
  id?: string
  text?: string
  webVideoUrl?: string
  createTime?: number
  createTimeISO?: string
  authorMeta?: TikTokAuthorMeta
  videoMeta?: TikTokVideoMeta
  playCount?: number
  diggCount?: number
  commentCount?: number
  shareCount?: number
  collectCount?: number
  hashtags?: { name: string }[]
  mentions?: string[]
  isAd?: boolean
  isSponsored?: boolean
  textLanguage?: string
  input?: string
}

// Process TikTok posts into coverage items
async function processTikTokPosts(
  supabase: ReturnType<typeof getSupabase>,
  posts: TikTokPost[],
  clientId: string,
  gameId: string | null,
  minFollowers: number
): Promise<{ found: number; newItems: number; filtered: number }> {
  let newItems = 0
  let filtered = 0

  for (const video of posts) {
    const videoUrl = video.webVideoUrl
    if (!videoUrl) continue

    // Skip ads/sponsored content
    if (video.isAd || video.isSponsored) continue

    const authorName = video.authorMeta?.name || 'unknown'
    const authorNickname = video.authorMeta?.nickName || authorName
    const followers = Number(video.authorMeta?.fans || 0)

    // Filter by minimum followers
    if (minFollowers > 0 && followers < minFollowers) {
      filtered++
      continue
    }

    // Check for existing item by URL
    const { data: existing } = await supabase
      .from('coverage_items')
      .select('id')
      .eq('url', videoUrl)
      .eq('client_id', clientId)
      .limit(1)

    if (existing && existing.length > 0) continue

    // Parse date — createTimeISO is preferred, createTime is unix timestamp
    const publishDate = video.createTimeISO
      ? new Date(video.createTimeISO).toISOString().split('T')[0]
      : video.createTime
        ? new Date(video.createTime * 1000).toISOString().split('T')[0]
        : null

    // Find or create outlet for creator
    const creatorDomain = `tiktok.com/@${authorName}`
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
          name: authorNickname,
          domain: creatorDomain,
          monthly_unique_visitors: followers,
          tier: followers >= 1000000 ? 'A' : followers >= 100000 ? 'B' : followers >= 10000 ? 'C' : 'D',
          is_active: true,
        })
        .select('id')
        .single()
      if (newOutlet) outletId = newOutlet.id
    }

    const description = video.text || ''
    const hashtagNames = (video.hashtags || []).map(h => h.name)

    await supabase.from('coverage_items').insert({
      client_id: clientId,
      game_id: gameId,
      outlet_id: outletId,
      title: description.length > 200 ? description.substring(0, 200) + '...' : description || 'TikTok Video',
      url: videoUrl,
      publish_date: publishDate,
      coverage_type: 'video',
      monthly_unique_visitors: followers,
      territory: inferTerritory(null, null, video.textLanguage) || 'International',
      source_type: 'tiktok',
      source_metadata: {
        video_id: video.id,
        author_name: authorName,
        author_nickname: authorNickname,
        author_verified: video.authorMeta?.verified || false,
        followers,
        views: video.playCount || 0,
        likes: video.diggCount || 0,
        comments: video.commentCount || 0,
        shares: video.shareCount || 0,
        saves: video.collectCount || 0,
        duration: video.videoMeta?.duration || 0,
        hashtags: hashtagNames,
        mentions: video.mentions || [],
      },
      approval_status: 'pending_review',
      discovered_at: new Date().toISOString(),
    })

    newItems++
  }

  return { found: posts.length, newItems, filtered }
}
