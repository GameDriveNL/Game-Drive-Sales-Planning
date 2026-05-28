import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { inferTerritory } from '@/lib/territory'
import { detectOutletCountry } from '@/lib/outlet-country'
import { checkApifyCredits, notifyLowCredits, checkApifyDailyBudget, logApifyRun, apifyCronGate } from '@/lib/apify-utils'
import { verifyCronAuth } from '@/lib/cron-auth'

function getSupabase() {
  return getServerSupabase()
}

// Apify Twitch scraper actor
const APIFY_TWITCH_ACTOR = 'epctex/twitch-scraper'

// GET /api/cron/twitch-scan — Scan Twitch for game streams and VODs via Apify
export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request)
  if (authError) return authError

  const supabase = getSupabase()

  try {
    // Per-platform gate. Apify Twitch is OFF by default — the free
    // /api/cron/twitch-gql-scan covers this channel comprehensively.
    const gate = await apifyCronGate(supabase, 'twitch')
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

    // Rotation: only process the target game this run
    const enabledGameIds = new Set<string>([targetGameId])
    const { data: games } = await supabase
      .from('games')
      .select('id, name, client_id')
      .in('id', Array.from(enabledGameIds))

    if (!games || games.length === 0) {
      return NextResponse.json({ message: 'No matching games for active Twitch sources' })
    }

    let totalFound = 0
    let totalNew = 0

    for (const game of games) {
      const midBudget = await checkApifyDailyBudget(supabase)
      if (!midBudget.ok) { console.warn(`Twitch scan stopping: daily cap reached`); break }

      try {
        // Run Apify Twitch scraper actor synchronously
        const input = {
          searchTerms: [game.name],
          maxItems: 20,
          type: 'videos',
        }
        const actorRes = await fetch(
          `https://api.apify.com/v2/acts/${APIFY_TWITCH_ACTOR}/run-sync-get-dataset-items?token=${apifyKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
          }
        )

        if (!actorRes.ok) {
          console.error(`Apify Twitch actor error for "${game.name}": ${actorRes.status}`)
          await logApifyRun(supabase, {
            scanner: 'twitch-scan', actor_id: APIFY_TWITCH_ACTOR, input,
            results_count: null, http_status: actorRes.status, ok: false, error: `HTTP ${actorRes.status}`,
          })
          continue
        }

        const vods = await actorRes.json()
        const isArr = Array.isArray(vods)
        await logApifyRun(supabase, {
          scanner: 'twitch-scan', actor_id: APIFY_TWITCH_ACTOR, input,
          results_count: isArr ? vods.length : null, http_status: actorRes.status, ok: isArr, error: null,
        })
        if (!isArr) continue

        totalFound += vods.length

        for (const vod of vods) {
          const url = vod.url || vod.videoUrl || null
          if (!url) continue

          // Check for existing
          const { data: existing } = await supabase
            .from('coverage_items')
            .select('id')
            .eq('url', url)
            .eq('client_id', game.client_id)
            .limit(1)

          if (existing && existing.length > 0) continue

          const streamerName = vod.userName || vod.channelName || vod.user_name || 'Unknown'
          const streamerLogin = vod.userLogin || vod.user_login || streamerName.toLowerCase()
          const followers = Number(vod.followers || vod.followerCount || 0)
          const viewCount = Number(vod.viewCount || vod.views || 0)
          const publishDate = vod.createdAt || vod.created_at
            ? new Date(vod.createdAt || vod.created_at).toISOString().split('T')[0]
            : null

          // Find or create outlet for streamer
          const streamerDomain = `twitch.tv/${streamerLogin}`
          let outletId: string | null = null

          const { data: existingOutlet } = await supabase
            .from('outlets')
            .select('id, is_blacklisted')
            .eq('domain', streamerDomain)
            .limit(1)

          if (existingOutlet && existingOutlet.length > 0) {
            if (existingOutlet[0].is_blacklisted) continue // Skip blacklisted outlets
            outletId = existingOutlet[0].id
          } else {
            const { data: newOutlet } = await supabase
              .from('outlets')
              .insert({
                name: streamerName,
                domain: streamerDomain,
                country: detectOutletCountry(streamerDomain),
                monthly_unique_visitors: followers,
                tier: followers >= 100000 ? 'A' : followers >= 10000 ? 'B' : followers >= 1000 ? 'C' : 'D',
                is_active: true,
              })
              .select('id')
              .single()
            if (newOutlet) outletId = newOutlet.id
          }

          await supabase.from('coverage_items').insert({
            client_id: game.client_id,
            game_id: game.id,
            outlet_id: outletId,
            title: vod.title || 'Untitled Stream',
            url,
            publish_date: publishDate,
            coverage_type: 'stream',
            monthly_unique_visitors: viewCount,
            territory: inferTerritory(null, null, vod.language) || 'International',
            source_type: 'twitch',
            source_metadata: {
              video_id: vod.id, user_name: streamerName,
              view_count: viewCount, duration: vod.duration, followers,
            },
            approval_status: 'pending_review',
            discovered_at: new Date().toISOString(),
          })

          totalNew++
        }
      } catch (err) {
        console.error(`Twitch Apify scan error for "${game.name}":`, err)
      }
    }

    return NextResponse.json({
      message: `Twitch scan complete: ${totalFound} found, ${totalNew} new`,
      found: totalFound,
      new_items: totalNew,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Twitch scan error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
