/**
 * POST /api/coverage-health/oneshot-darkpals-tiktok
 *
 * TikTok deep-scan oneshot for Dark Pals. Uses the same Apify
 * clockworks/free-tiktok-scraper actor as the daily cron, but raises
 * resultsPerPage to 200 and runs across multiple variant + hashtag passes.
 *
 * Apify cost: TikTok scraper bills per result returned. At ~$1 / 1000 results,
 * 2000 results ≈ $2. We have ~$28.96 of the monthly $29 STARTER budget left,
 * so this is safe.
 *
 * Self-locks via service_settings.oneshot_darkpals_tiktok_done. Whitelisted
 * in middleware. Will be removed after parity check.
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
const TIKTOK_ACTOR = 'clockworks~free-tiktok-scraper'

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
      `https://api.apify.com/v2/acts/${TIKTOK_ACTOR}/run-sync-get-dataset-items?token=${apifyKey}&timeout=240`,
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

  // Lock check
  const { data: lockRow } = await supabase
    .from('service_settings')
    .select('value')
    .eq('key', 'oneshot_darkpals_tiktok_done')
    .maybeSingle()
  if (lockRow?.value === true || lockRow?.value === 'true') {
    return NextResponse.json({
      error: 'Already ran. Clear service_settings.oneshot_darkpals_tiktok_done to re-enable.',
    }, { status: 410 })
  }

  const { data: game } = await supabase
    .from('games').select('id, name, client_id').eq('id', DARK_PALS_GAME_ID).single()
  if (!game) return NextResponse.json({ error: 'Dark Pals not found' }, { status: 404 })

  // Apify key + sanity
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

  const { data: igCfg } = await supabase
    .from('coverage_sources')
    .select('config').eq('game_id', game.id).eq('source_type', 'tiktok').maybeSingle()
  const hashtagsRaw = Array.isArray(igCfg?.config?.hashtags) ? (igCfg.config.hashtags as string[]) : []
  // TikTok hashtags must not include leading '#'
  const hashtags = hashtagsRaw.map(h => h.replace(/^#+/, '').trim()).filter(Boolean)

  const { data: existing } = await supabase
    .from('coverage_items').select('url').eq('game_id', game.id).limit(50000)
  const existingUrls = new Set<string>()
  for (const e of (existing || [])) existingUrls.add(normalizeUrl((e as { url: string }).url))

  async function findOrCreateOutlet(name: string, handle: string | null): Promise<string | null> {
    const domain = handle ? `tiktok.com/@${handle.replace(/^@/, '').toLowerCase()}` : 'tiktok.com'
    const { data: o } = await supabase.from('outlets').select('id').eq('domain', domain).maybeSingle()
    if (o?.id) return o.id
    const { data: newO } = await supabase.from('outlets').insert({
      name: name || 'TikTok',
      domain,
      country: detectOutletCountry(domain),
      tier: 'D',
      is_active: true,
    }).select('id').single()
    return newO?.id ?? null
  }

  const callResults: Array<{
    pass: string; items_found: number; items_inserted: number; http_status: number | null; error: string | null
  }> = []
  let totalInserted = 0

  // Pass 1: top 4 variants combined as searchQueries.
  // Capped at resultsPerPage 30 — the previous run at 200 hit Apify's actor
  // timeout (TIMED-OUT at 240s). 4 queries × 30 results ≈ 60-90s per call.
  if (variants.length > 0) {
    const input = {
      searchQueries: variants.slice(0, 4),
      resultsPerPage: 30,
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
      shouldDownloadSubtitles: false,
      proxyCountryCode: 'None',
    }
    const res = await runActor(apifyKey, input)
    await logApifyRun(supabase, {
      scanner: 'oneshot-darkpals-tiktok/queries', actor_id: TIKTOK_ACTOR,
      input, results_count: res.data.length, http_status: res.status, ok: res.ok, error: res.error,
    })
    let inserted = 0
    if (res.ok) {
      for (const item of res.data) {
        const url = (item.webVideoUrl as string) || (item.url as string) || ''
        if (!url) continue
        const norm = normalizeUrl(url)
        if (existingUrls.has(norm)) continue
        existingUrls.add(norm)
        const author = (item.authorMeta as Record<string, unknown> | undefined) || {}
        const handle = (author.name as string) || (author.nickName as string) || null
        const displayName = (author.nickName as string) || (author.name as string) || 'TikTok'
        const outletId = await findOrCreateOutlet(displayName, handle)
        const { error } = await supabase.from('coverage_items').insert({
          client_id: game.client_id, game_id: game.id, outlet_id: outletId,
          title: ((item.text as string) || `${displayName} TikTok`).substring(0, 500),
          url,
          publish_date: item.createTimeISO
            ? (item.createTimeISO as string).split('T')[0]
            : (item.createTime ? new Date(Number(item.createTime) * 1000).toISOString().split('T')[0] : null),
          coverage_type: 'social', source_type: 'tiktok',
          territory: inferTerritory(null, null, null),
          source_metadata: {
            oneshot: true, deep_scan: true,
            video_id: item.id, author_handle: handle, author_followers: author.fans,
            plays: item.playCount, likes: item.diggCount, comments: item.commentCount, shares: item.shareCount,
            search_pass: 'variants',
          },
          approval_status: 'pending_review',
          discovered_at: new Date().toISOString(),
        })
        if (!error) inserted++
      }
    }
    totalInserted += inserted
    callResults.push({
      pass: 'variants', items_found: res.data.length, items_inserted: inserted,
      http_status: res.status, error: res.error,
    })
  }

  // Pass 2: hashtags — same scope reduction as Pass 1.
  if (hashtags.length > 0) {
    const input = {
      hashtags: hashtags.slice(0, 6),
      resultsPerPage: 30,
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
      shouldDownloadSubtitles: false,
      proxyCountryCode: 'None',
    }
    const res = await runActor(apifyKey, input)
    await logApifyRun(supabase, {
      scanner: 'oneshot-darkpals-tiktok/hashtags', actor_id: TIKTOK_ACTOR,
      input, results_count: res.data.length, http_status: res.status, ok: res.ok, error: res.error,
    })
    let inserted = 0
    if (res.ok) {
      for (const item of res.data) {
        const url = (item.webVideoUrl as string) || (item.url as string) || ''
        if (!url) continue
        const norm = normalizeUrl(url)
        if (existingUrls.has(norm)) continue
        existingUrls.add(norm)
        const author = (item.authorMeta as Record<string, unknown> | undefined) || {}
        const handle = (author.name as string) || (author.nickName as string) || null
        const displayName = (author.nickName as string) || (author.name as string) || 'TikTok'
        const outletId = await findOrCreateOutlet(displayName, handle)
        const { error } = await supabase.from('coverage_items').insert({
          client_id: game.client_id, game_id: game.id, outlet_id: outletId,
          title: ((item.text as string) || `${displayName} TikTok`).substring(0, 500),
          url,
          publish_date: item.createTimeISO
            ? (item.createTimeISO as string).split('T')[0]
            : (item.createTime ? new Date(Number(item.createTime) * 1000).toISOString().split('T')[0] : null),
          coverage_type: 'social', source_type: 'tiktok',
          territory: inferTerritory(null, null, null),
          source_metadata: {
            oneshot: true, deep_scan: true,
            video_id: item.id, author_handle: handle, author_followers: author.fans,
            plays: item.playCount, likes: item.diggCount, comments: item.commentCount, shares: item.shareCount,
            search_pass: 'hashtags',
          },
          approval_status: 'pending_review',
          discovered_at: new Date().toISOString(),
        })
        if (!error) inserted++
      }
    }
    totalInserted += inserted
    callResults.push({
      pass: 'hashtags', items_found: res.data.length, items_inserted: inserted,
      http_status: res.status, error: res.error,
    })
  }

  await supabase.from('service_settings').upsert({
    key: 'oneshot_darkpals_tiktok_done', value: true,
  }, { onConflict: 'key' })

  const totalFound = callResults.reduce((s, r) => s + r.items_found, 0)
  return NextResponse.json({
    message: `One-shot Dark Pals TikTok deep-scan: +${totalInserted} new of ${totalFound} found`,
    game: game.name,
    total_new_items: totalInserted,
    total_found: totalFound,
    variants_used: variants.slice(0, 4).length,
    hashtags_used: hashtags.slice(0, 8).length,
    apify_remaining_usd: credits.remainingUsd,
    calls: callResults,
  })
}
