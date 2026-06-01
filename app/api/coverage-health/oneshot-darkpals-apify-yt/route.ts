/**
 * POST /api/coverage-health/oneshot-darkpals-apify-yt
 *
 * YouTube backfill via the Apify streamers/youtube-scraper actor — needed
 * because the YouTube Data API project (#774832916528) is on the default
 * 10K-units/day quota, which is 100 search.list calls/day, already burned
 * by the daily youtube-data-api-scan cron + earlier diagnostic + oneshot.
 *
 * Apify YouTube scraper bills by output volume (~$1 per 1000 items), so
 * targeting 4 variants × 60 results each = ~240 items ≈ $0.25 — trivial
 * against our $28.96/$29 monthly STARTER budget.
 *
 * Self-locks via service_settings.oneshot_darkpals_apify_yt_done.
 * Whitelisted in middleware. Will be removed after parity check.
 */

import { NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { detectOutletCountry } from '@/lib/outlet-country'
import { checkApifyCredits, logApifyRun } from '@/lib/apify-utils'
import { inferTerritory } from '@/lib/territory'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

const DARK_PALS_GAME_ID = '6ce557eb-0c04-412e-a6da-7fee77738ff9'
const YT_ACTOR = 'streamers~youtube-scraper'

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    return (u.origin + u.pathname).replace(/\/$/, '')
  } catch {
    return url
  }
}

async function runActor(
  apifyKey: string,
  input: Record<string, unknown>,
): Promise<{ ok: boolean; status: number | null; data: Array<Record<string, unknown>>; error: string | null }> {
  try {
    const res = await fetch(
      `https://api.apify.com/v2/acts/${YT_ACTOR}/run-sync-get-dataset-items?token=${apifyKey}&timeout=260`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
    )
    if (!res.ok) return { ok: false, status: res.status, data: [], error: `HTTP ${res.status}: ${(await res.text()).substring(0, 200)}` }
    const data = await res.json()
    return { ok: Array.isArray(data), status: res.status, data: Array.isArray(data) ? data : [], error: null }
  } catch (err) {
    return { ok: false, status: null, data: [], error: err instanceof Error ? err.message : String(err) }
  }
}

export async function POST() {
  const supabase = getServerSupabase()

  const { data: lockRow } = await supabase
    .from('service_settings')
    .select('value')
    .eq('key', 'oneshot_darkpals_apify_yt_done')
    .maybeSingle()
  if (lockRow?.value === true || lockRow?.value === 'true') {
    return NextResponse.json({
      error: 'Already ran. Clear service_settings.oneshot_darkpals_apify_yt_done to re-enable.',
    }, { status: 410 })
  }

  const { data: game } = await supabase
    .from('games').select('id, name, client_id').eq('id', DARK_PALS_GAME_ID).single()
  if (!game) return NextResponse.json({ error: 'Dark Pals not found' }, { status: 404 })

  const { data: keyData } = await supabase
    .from('service_api_keys').select('api_key').eq('service_name', 'apify').eq('is_active', true).maybeSingle()
  const apifyKey = keyData?.api_key as string | undefined
  if (!apifyKey) return NextResponse.json({ error: 'Apify key missing' }, { status: 400 })
  const credits = await checkApifyCredits(apifyKey)
  if (!credits.hasCredits) {
    return NextResponse.json({
      error: 'Apify credits unavailable',
      remaining_usd: credits.remainingUsd, detail: credits.error,
    }, { status: 503 })
  }

  const { data: kws } = await supabase
    .from('coverage_keywords')
    .select('keyword').eq('game_id', game.id).eq('keyword_type', 'whitelist').eq('is_active', true)
  const variants = (kws || []).map((k: { keyword: string }) => k.keyword)

  const { data: existing } = await supabase
    .from('coverage_items').select('url').eq('game_id', game.id).limit(50000)
  const existingUrls = new Set<string>()
  for (const e of (existing || [])) existingUrls.add(normalizeUrl((e as { url: string }).url))

  async function findOrCreateOutlet(
    domain: string, name: string, subs: number | null,
  ): Promise<string | null> {
    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').toLowerCase()
    const { data: o } = await supabase.from('outlets').select('id').eq('domain', cleanDomain).maybeSingle()
    if (o?.id) return o.id
    const tier = subs === null ? 'D'
      : subs >= 1_000_000 ? 'A'
      : subs >= 100_000 ? 'B'
      : subs >= 10_000 ? 'C' : 'D'
    const { data: newO } = await supabase.from('outlets').insert({
      name, domain: cleanDomain,
      country: detectOutletCountry(cleanDomain),
      monthly_unique_visitors: subs, tier, is_active: true,
    }).select('id').single()
    return newO?.id ?? null
  }

  // Single deep-scan call: 4 queries × maxResults 100 each (~400 items)
  // Most channels won't be unique, but it covers global discovery cheaply.
  const input = {
    searchQueries: variants.slice(0, 4),
    maxResults: 100,
    maxResultStreams: 0,
    maxResultsShorts: 0,
    sortVideosBy: 'RELEVANCE',
    dateFilter: 'month',
    downloadSubtitles: false,
  }
  const res = await runActor(apifyKey, input)
  await logApifyRun(supabase, {
    scanner: 'oneshot-darkpals-apify-yt', actor_id: YT_ACTOR,
    input, results_count: res.data.length, http_status: res.status, ok: res.ok, error: res.error,
  })

  let inserted = 0
  if (res.ok) {
    for (const v of res.data) {
      const url = (v.url as string) || (v.id ? `https://www.youtube.com/watch?v=${v.id}` : '')
      if (!url) continue
      const cleanUrl = url.split('&t=')[0]
      const norm = normalizeUrl(cleanUrl)
      if (existingUrls.has(norm)) continue
      existingUrls.add(norm)
      const channelName = (v.channelName as string) || 'Unknown Channel'
      const channelUrl = (v.channelUrl as string) || ''
      const subs = Number(v.numberOfSubscribers || 0) || null
      const channelDomain = channelUrl
        ? channelUrl.replace(/^https?:\/\//, '')
        : `youtube.com/@${(v.channelUsername as string) || channelName}`
      const outletId = await findOrCreateOutlet(channelDomain, channelName, subs)
      const { error } = await supabase.from('coverage_items').insert({
        client_id: game.client_id, game_id: game.id, outlet_id: outletId,
        title: ((v.title as string) || 'Untitled Video').substring(0, 500),
        url: cleanUrl,
        publish_date: v.date ? new Date(v.date as string).toISOString().split('T')[0] : null,
        coverage_type: 'video',
        monthly_unique_visitors: typeof v.viewCount === 'number' ? v.viewCount : null,
        territory: inferTerritory(null, null, (v.defaultLanguage as string) || null),
        source_type: 'youtube',
        source_metadata: {
          oneshot: true, apify_yt: true,
          video_id: v.id, channel_name: channelName, channel_url: channelUrl,
          subscribers: subs, views: v.viewCount || 0,
        },
        approval_status: 'pending_review',
        discovered_at: new Date().toISOString(),
      })
      if (!error) inserted++
    }
  }

  await supabase.from('service_settings').upsert({
    key: 'oneshot_darkpals_apify_yt_done', value: true,
  }, { onConflict: 'key' })

  return NextResponse.json({
    message: `One-shot Dark Pals Apify YT: +${inserted} new of ${res.data.length} found`,
    game: game.name,
    items_found: res.data.length,
    items_inserted: inserted,
    apify_remaining_usd: credits.remainingUsd,
    http_status: res.status,
    error: res.error,
    variants_used: variants.slice(0, 4).length,
  })
}
