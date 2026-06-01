/**
 * POST /api/coverage-health/oneshot-darkpals-sullygnome
 *
 * Kicks off the REAL SullyGnome scanner for Dark Pals — same code path
 * as /api/cron/sullygnome-scan, just bypassing CRON_SECRET via a
 * service_settings self-lock.
 *
 * The Apify actor takes ~60-90s to scrape the SullyGnome game page. When
 * done, Apify webhooks /api/sullygnome-collect which inserts items into
 * coverage_items. So this endpoint returns immediately with the run ID;
 * you have to wait ~2 minutes and re-query coverage_items to see results.
 *
 * Self-locks via service_settings.oneshot_darkpals_sullygnome_done.
 * Whitelisted in middleware. Will be removed after parity verification.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { buildSullyGnomeUrl } from '@/lib/sullygnome'
import { checkApifyCredits, logApifyRun } from '@/lib/apify-utils'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

const DARK_PALS_GAME_ID = '6ce557eb-0c04-412e-a6da-7fee77738ff9'
const APIFY_ACTOR = 'apify~web-scraper'

function buildPageFunction(): string {
  return `
async function pageFunction(context) {
  const { jQuery } = context;
  await new Promise(resolve => {
    let checks = 0;
    const interval = setInterval(() => {
      checks++;
      if (jQuery('table tbody tr').length > 0 || checks > 30) {
        clearInterval(interval); resolve();
      }
    }, 1000);
  });
  const rows = [];
  jQuery('table tbody tr').each(function() {
    const cells = [];
    jQuery(this).find('td').each(function() {
      cells.push(jQuery(this).text().trim());
    });
    if (cells.length >= 8) rows.push(cells);
  });
  return { url: context.request.url, rows };
}`
}

export async function POST(request: NextRequest) {
  const supabase = getServerSupabase()

  const { data: lockRow } = await supabase
    .from('service_settings').select('value')
    .eq('key', 'oneshot_darkpals_sullygnome_done').maybeSingle()
  if (lockRow?.value === true || lockRow?.value === 'true') {
    return NextResponse.json({
      error: 'Already ran. Clear service_settings.oneshot_darkpals_sullygnome_done to re-enable.',
    }, { status: 410 })
  }

  const { data: source } = await supabase
    .from('coverage_sources')
    .select('id, name, config, game:games(id, name, client_id)')
    .eq('game_id', DARK_PALS_GAME_ID)
    .eq('source_type', 'sullygnome')
    .maybeSingle()
  if (!source) {
    return NextResponse.json({ error: 'No sullygnome source for Dark Pals' }, { status: 404 })
  }
  const cfg = (source.config || {}) as { sullygnome_slug?: string; default_time_range?: string }
  const slug = cfg.sullygnome_slug
  const timeRange = cfg.default_time_range || '30d'
  if (!slug) {
    return NextResponse.json({ error: 'Missing sullygnome_slug' }, { status: 400 })
  }

  const { data: keyData } = await supabase
    .from('service_api_keys').select('api_key').eq('service_name', 'apify').eq('is_active', true).maybeSingle()
  const apifyKey = (keyData?.api_key as string | undefined)
  if (!apifyKey) return NextResponse.json({ error: 'Apify key missing' }, { status: 400 })

  const credits = await checkApifyCredits(apifyKey)
  if (!credits.hasCredits) {
    return NextResponse.json({
      error: 'Apify credits unavailable', remaining_usd: credits.remainingUsd, detail: credits.error,
    }, { status: 503 })
  }

  const origin = request.headers.get('host')
  const proto = request.headers.get('x-forwarded-proto') || 'https'
  const baseUrl = `${proto}://${origin}`
  const webhookUrl = `${baseUrl}/api/sullygnome-collect?source_id=${source.id}`

  const targetUrl = buildSullyGnomeUrl(slug, timeRange)
  const input = {
    startUrls: [{ url: targetUrl }],
    pageFunction: buildPageFunction(),
    maxPagesPerCrawl: 1,
    proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
    pageFunctionTimeoutSecs: 60,
    maxConcurrency: 1,
  }
  const actorRes = await fetch(
    `https://api.apify.com/v2/acts/${APIFY_ACTOR}/runs?token=${apifyKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  )
  if (!actorRes.ok) {
    const txt = await actorRes.text().catch(() => 'no body')
    await logApifyRun(supabase, {
      scanner: 'oneshot-darkpals-sullygnome', actor_id: APIFY_ACTOR,
      input: { targetUrl }, results_count: null, http_status: actorRes.status,
      ok: false, error: `HTTP ${actorRes.status}: ${txt.slice(0,200)}`,
    })
    return NextResponse.json({ error: `Apify ${actorRes.status}: ${txt.slice(0,200)}` }, { status: 502 })
  }
  await logApifyRun(supabase, {
    scanner: 'oneshot-darkpals-sullygnome', actor_id: APIFY_ACTOR,
    input: { targetUrl }, results_count: null, http_status: actorRes.status,
    ok: true, error: null,
  })

  const runData = await actorRes.json() as { data?: { id?: string; defaultDatasetId?: string } }
  const runId = runData?.data?.id
  const datasetId = runData?.data?.defaultDatasetId

  // Register webhook so Apify calls our collect endpoint
  if (runId) {
    await fetch(
      `https://api.apify.com/v2/webhooks?token=${apifyKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestUrl: webhookUrl,
          eventTypes: ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED', 'ACTOR.RUN.ABORTED', 'ACTOR.RUN.TIMED_OUT'],
          condition: { actorRunId: runId },
          isAdHoc: true,
        }),
      },
    ).catch(err => console.error('Webhook registration failed:', err))
  }

  await supabase.from('coverage_sources').update({
    last_run_at: new Date().toISOString(),
    last_run_status: 'running',
    last_run_message: `Oneshot started Apify run ${runId || 'unknown'}`,
    config: { ...(source.config as object), _apify_run_id: runId, _apify_dataset_id: datasetId },
  }).eq('id', source.id)

  await supabase.from('service_settings').upsert({
    key: 'oneshot_darkpals_sullygnome_done', value: true,
  }, { onConflict: 'key' })

  return NextResponse.json({
    message: 'SullyGnome Apify run kicked off — webhook will populate coverage_items in ~60-120s',
    apify_run_id: runId,
    apify_dataset_id: datasetId,
    target_url: targetUrl,
    webhook_url: webhookUrl,
    sullygnome_slug: slug,
    apify_remaining_usd: credits.remainingUsd,
  })
}
