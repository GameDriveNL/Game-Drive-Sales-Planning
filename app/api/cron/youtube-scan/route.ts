import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { inferTerritory } from '@/lib/territory'
import { detectOutletCountry } from '@/lib/outlet-country'
import { checkApifyCredits, notifyLowCredits, checkApifyDailyBudget, logApifyRun, apifyCronGate } from '@/lib/apify-utils'
import { verifyCronAuth } from '@/lib/cron-auth'

function getSupabase() {
  return getServerSupabase()
}

// Apify YouTube scraper actor — verified working
const APIFY_YOUTUBE_ACTOR = 'streamers~youtube-scraper'

// GET /api/cron/youtube-scan — Scan YouTube for game coverage videos via Apify
export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request)
  if (authError) return authError

  const supabase = getSupabase()

  try {
    // Per-platform gate + rotation. Apify YouTube is OFF by default —
    // the free YouTube Data API scanner covers this channel. The gate
    // here means this cron is a clean no-op until flipped on.
    const gate = await apifyCronGate(supabase, 'youtube')
    if (gate.skip) return NextResponse.json(gate.data)
    const targetGameId = gate.targetGameId

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

    // Get YouTube coverage_sources (for per-source status tracking)
    const { data: ytSources } = await supabase
      .from('coverage_sources')
      .select('id, game_id, config, consecutive_failures')
      .eq('source_type', 'youtube')
      .eq('is_active', true)

    // Get whitelist keywords for all clients/games
    const { data: keywords } = await supabase
      .from('coverage_keywords')
      .select('keyword, client_id, game_id')
      .eq('keyword_type', 'whitelist')

    if (!keywords || keywords.length === 0) {
      return NextResponse.json({ message: 'No keywords configured' })
    }

    // Group ALL keyword variants per client+game. The Apify YouTube actor accepts
    // searchQueries as an array — passing multiple variants in one run is roughly
    // the same Apify cost as one run with maxResults×N but yields much higher
    // recall because creator vids title in many ways (full title, short form,
    // genre tag, creator handle). The first-keyword-wins logic that was here
    // previously is the single biggest reason YouTube recall lags Reddit/Twitter
    // (which already iterate `keywordGroups.keywords.slice(0, 5)`).
    const searchTerms: Map<string, { queries: string[]; clientId: string; gameId: string | null }> = new Map()
    for (const kw of keywords) {
      if (kw.game_id !== targetGameId) continue  // rotation: this run targets one game
      const key = `${kw.client_id}|${kw.game_id || ''}`
      if (!searchTerms.has(key)) {
        searchTerms.set(key, { queries: [], clientId: kw.client_id, gameId: kw.game_id })
      }
      searchTerms.get(key)!.queries.push(kw.keyword)
    }

    let totalFound = 0
    let totalNew = 0

    for (const [, term] of Array.from(searchTerms.entries())) {
      try {
        // Re-check daily budget mid-loop in case earlier scanners burned through it.
        const midBudget = await checkApifyDailyBudget(supabase)
        if (!midBudget.ok) {
          console.warn(`YouTube scan stopping mid-loop: daily cap reached (${midBudget.callsToday}/${midBudget.limit})`)
          break
        }

        // Run Apify YouTube scraper actor synchronously
        // Uses verified input schema from streamers~youtube-scraper.
        // Cap variants at 4 — past that the marginal recall is low and Apify
        // call cost scales linearly per searchQueries entry.
        const queries = term.queries.slice(0, 4)
        const input = {
          searchQueries: queries,
          maxResults: 10,
          maxResultStreams: 0,
          maxResultsShorts: 0,
          sortVideosBy: 'NEWEST',
          // 'today' = last 24h. Dedup handles overlap with yesterday's run.
          // Was 'month' — caused us to re-pay for the same 30 days every day.
          dateFilter: 'today',
          downloadSubtitles: false,
        }
        const actorRes = await fetch(
          `https://api.apify.com/v2/acts/${APIFY_YOUTUBE_ACTOR}/run-sync-get-dataset-items?token=${apifyKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
          }
        )

        if (!actorRes.ok) {
          console.error(`Apify YouTube actor error for [${queries.join(', ')}]: ${actorRes.status}`)
          await logApifyRun(supabase, {
            scanner: 'youtube-scan', actor_id: APIFY_YOUTUBE_ACTOR, input,
            results_count: null, http_status: actorRes.status, ok: false, error: `HTTP ${actorRes.status}`,
          })
          continue
        }

        const videos = await actorRes.json()
        const isArr = Array.isArray(videos)
        await logApifyRun(supabase, {
          scanner: 'youtube-scan', actor_id: APIFY_YOUTUBE_ACTOR, input,
          results_count: isArr ? videos.length : null, http_status: actorRes.status, ok: isArr, error: null,
        })
        if (!isArr) continue

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
          const publishDate = video.date ? new Date(video.date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]

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
                country: detectOutletCountry(channelDomain),
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
            monthly_unique_visitors: video.viewCount || 0,
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
        // Update matching coverage_source status on success
        if (ytSources) {
          const matchingSrc = ytSources.find(s => s.game_id === term.gameId)
          if (matchingSrc) {
            await supabase.from('coverage_sources').update({
              last_run_at: new Date().toISOString(),
              last_run_status: 'success',
              last_run_message: `Found ${videos.length} videos, ${totalNew} new items`,
              items_found_last_run: videos.length,
              consecutive_failures: 0
            }).eq('id', matchingSrc.id)
          }
        }
      } catch (err) {
        console.error(`YouTube Apify scan error for game ${term.gameId}:`, err)
        // Update matching coverage_source with failure status
        if (ytSources) {
          const matchingSrc = ytSources.find(s => s.game_id === term.gameId)
          if (matchingSrc) {
            const errMsg = err instanceof Error ? err.message : String(err)
            const newFailures = (matchingSrc.consecutive_failures || 0) + 1
            await supabase.from('coverage_sources').update({
              last_run_at: new Date().toISOString(),
              last_run_status: newFailures >= 5 ? 'error' : 'failed',
              last_run_message: errMsg.substring(0, 500),
              consecutive_failures: newFailures,
              ...(newFailures >= 10 ? { is_active: false } : {})
            }).eq('id', matchingSrc.id)
          }
        }
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
