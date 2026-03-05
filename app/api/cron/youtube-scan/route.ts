import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { inferTerritory } from '@/lib/territory'

function getSupabase() {
  return getServerSupabase()
}

// Apify YouTube scraper actor — verified working
const APIFY_YOUTUBE_ACTOR = 'streamers~youtube-scraper'

// GET /api/cron/youtube-scan — Scan YouTube for game coverage videos via Apify
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

    // Get whitelist keywords for all clients/games
    const { data: keywords } = await supabase
      .from('coverage_keywords')
      .select('keyword, client_id, game_id')
      .eq('keyword_type', 'whitelist')

    if (!keywords || keywords.length === 0) {
      return NextResponse.json({ message: 'No keywords configured' })
    }

    // Group keywords by client+game — combine into single search query
    const searchTerms: Map<string, { query: string; clientId: string; gameId: string | null }> = new Map()
    for (const kw of keywords) {
      const key = `${kw.client_id}|${kw.game_id || ''}`
      if (!searchTerms.has(key)) {
        searchTerms.set(key, { query: kw.keyword, clientId: kw.client_id, gameId: kw.game_id })
      }
    }

    let totalFound = 0
    let totalNew = 0

    for (const [, term] of Array.from(searchTerms.entries())) {
      try {
        // Run Apify YouTube scraper actor synchronously
        // Uses verified input schema from streamers~youtube-scraper
        const actorRes = await fetch(
          `https://api.apify.com/v2/acts/${APIFY_YOUTUBE_ACTOR}/run-sync-get-dataset-items?token=${apifyKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              searchQueries: [term.query],
              maxResults: 10,
              maxResultStreams: 0,
              maxResultsShorts: 0,
              sortVideosBy: 'NEWEST',
              dateFilter: 'month',
              downloadSubtitles: false,
            }),
          }
        )

        if (!actorRes.ok) {
          console.error(`Apify YouTube actor error for "${term.query}": ${actorRes.status}`)
          continue
        }

        const videos = await actorRes.json()
        if (!Array.isArray(videos)) continue

        totalFound += videos.length

        for (const video of videos) {
          // Real response fields: url, id, title, channelName, channelUrl,
          // channelUsername, numberOfSubscribers, date, viewCount, likes,
          // commentsCount, duration, text (description), hashtags
          const videoUrl = video.url || (video.id ? `https://www.youtube.com/watch?v=${video.id}` : null)
          if (!videoUrl) continue

          // Clean URL — remove &t= timestamp params that some results include
          const cleanUrl = videoUrl.split('&t=')[0]

          const channelName = video.channelName || 'Unknown Channel'
          const channelUrl = video.channelUrl || ''
          const subscribers = Number(video.numberOfSubscribers || 0)
          const publishDate = video.date ? new Date(video.date).toISOString().split('T')[0] : null

          // Check for existing item by URL
          const { data: existing } = await supabase
            .from('coverage_items')
            .select('id')
            .eq('url', cleanUrl)
            .eq('client_id', term.clientId)
            .limit(1)

          if (existing && existing.length > 0) continue

          // Find or create outlet for the channel
          const channelDomain = channelUrl
            ? channelUrl.replace('https://', '').replace('http://', '')
            : `youtube.com/@${video.channelUsername || channelName}`
          let outletId: string | null = null
          let outletCountry: string | null = null

          const { data: existingOutlet } = await supabase
            .from('outlets')
            .select('id, is_blacklisted, country')
            .ilike('domain', `%${channelDomain}%`)
            .limit(1)

          if (existingOutlet && existingOutlet.length > 0) {
            if (existingOutlet[0].is_blacklisted) continue // Skip blacklisted outlets
            outletId = existingOutlet[0].id
            outletCountry = existingOutlet[0].country
          } else {
            const { data: newOutlet } = await supabase
              .from('outlets')
              .insert({
                name: channelName,
                domain: channelDomain,
                monthly_unique_visitors: subscribers,
                tier: subscribers >= 1000000 ? 'A' : subscribers >= 100000 ? 'B' : subscribers >= 10000 ? 'C' : 'D',
                is_active: true,
              })
              .select('id')
              .single()
            if (newOutlet) outletId = newOutlet.id
          }

          // Infer territory from video language, outlet country, or channel metadata
          const videoLang = video.defaultLanguage || video.language || null
          const territory = inferTerritory(null, outletCountry, videoLang)

          await supabase.from('coverage_items').insert({
            client_id: term.clientId,
            game_id: term.gameId,
            outlet_id: outletId,
            title: video.title || 'Untitled Video',
            url: cleanUrl,
            publish_date: publishDate,
            coverage_type: 'video',
            monthly_unique_visitors: subscribers,
            territory,
            source_type: 'youtube',
            source_metadata: {
              video_id: video.id,
              channel_name: channelName,
              channel_url: channelUrl,
              channel_username: video.channelUsername || null,
              subscribers,
              views: video.viewCount || 0,
              likes: video.likes || 0,
              comments: video.commentsCount || 0,
              duration: video.duration || null,
              hashtags: video.hashtags || [],
              language: videoLang,
            },
            approval_status: 'pending_review',
            discovered_at: new Date().toISOString(),
          })

          totalNew++
        }
      } catch (err) {
        console.error(`YouTube Apify scan error for "${term.query}":`, err)
      }
    }

    return NextResponse.json({
      message: `YouTube scan complete: ${totalFound} found, ${totalNew} new`,
      found: totalFound,
      new_items: totalNew,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('YouTube scan error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
