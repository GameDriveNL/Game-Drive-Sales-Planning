import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { buildSullyGnomeUrl } from '@/lib/sullygnome'
import { checkApifyCredits, notifyLowCredits, checkApifyDailyBudget, logApifyRun } from '@/lib/apify-utils'
import { verifyCronAuth } from '@/lib/cron-auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

// Apify generic web scraper — headless Chrome, works with Cloudflare
const APIFY_ACTOR = 'apify~web-scraper'

// ─── Types ──────────────────────────────────────────────────────────────────

interface CoverageSource {
  id: string
  source_type: string
  name: string
  config: {
    game_name?: string
    sullygnome_slug?: string
    default_time_range?: string
    min_avg_viewers?: number
    [key: string]: unknown
  }
  outlet_id: string | null
  game_id: string | null
  scan_frequency: string
  is_active: boolean
  last_run_at: string | null
  consecutive_failures: number
  total_items_found: number
  game?: { id: string; name: string; client_id: string } | null
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function shouldScanNow(source: CoverageSource): boolean {
  if (!source.last_run_at) return true
  const lastRun = new Date(source.last_run_at).getTime()
  const hoursSince = (Date.now() - lastRun) / (1000 * 60 * 60)
  switch (source.scan_frequency) {
    case 'hourly': return hoursSince >= 0.9
    case 'every_6h': return hoursSince >= 5.5
    case 'daily': return hoursSince >= 23
    case 'weekly': return hoursSince >= 167
    default: return hoursSince >= 167
  }
}

/**
 * Build the Apify pageFunction that extracts streamer table rows from SullyGnome.
 * Runs inside headless Chrome with jQuery available.
 */
function buildPageFunction(): string {
  return `
async function pageFunction(context) {
  const { jQuery, log } = context;

  // Wait for the table to render (JS-rendered page)
  await new Promise(resolve => {
    let checks = 0;
    const interval = setInterval(() => {
      checks++;
      if (jQuery('table tbody tr').length > 0 || checks > 30) {
        clearInterval(interval);
        resolve();
      }
    }, 1000);
  });

  const rows = [];
  jQuery('table tbody tr').each(function() {
    const cells = [];
    jQuery(this).find('td').each(function() {
      cells.push(jQuery(this).text().trim());
    });
    if (cells.length >= 8) {
      rows.push(cells);
    }
  });

  log.info('Extracted ' + rows.length + ' rows from SullyGnome table');
  return rows;
}
`
}

// ─── Main Handler ───────────────────────────────────────────────────────────

// POST — Manual trigger from Sources UI (no auth)
export async function POST(request: NextRequest) {
  return handleScan(request)
}

// GET — Cron trigger (auth required)
export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request)
  if (authError) return authError
  return handleScan(request)
}

/**
 * Async 2-step approach to avoid Vercel function timeout:
 * 1. This handler kicks off Apify actor runs (fast, <5s per source)
 * 2. Each run is started with a webhookUrl pointing to /api/sullygnome-collect
 *    which Apify calls when the actor finishes — that endpoint processes results
 *
 * If no webhook URL is available (local dev), falls back to marking sources
 * as "running" so the collect endpoint can poll for them.
 */
async function handleScan(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const forceSourceId = searchParams.get('source_id')

  const supabase = getServerSupabase()

  try {
    // 1. Get Apify API key
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

    // Daily call budget — also gates the manual POST trigger from the Sources UI.
    const budget = await checkApifyDailyBudget(supabase)
    if (!budget.ok) {
      return NextResponse.json({
        message: `Daily Apify call cap reached (${budget.callsToday}/${budget.limit}), skipping scan`,
        calls_today: budget.callsToday,
      })
    }

    // 2. Get active SullyGnome sources
    let sourceQuery = supabase
      .from('coverage_sources')
      .select('*, game:games(id, name, client_id)')
      .eq('source_type', 'sullygnome')
      .eq('is_active', true)

    if (forceSourceId) {
      sourceQuery = sourceQuery.eq('id', forceSourceId)
    }

    const { data: sources, error: srcError } = await sourceQuery

    if (srcError) {
      console.error('Error fetching SullyGnome sources:', srcError)
      return NextResponse.json({ error: srcError.message }, { status: 500 })
    }

    if (!sources || sources.length === 0) {
      return NextResponse.json({ message: 'No active SullyGnome sources configured' })
    }

    // Build the webhook URL for Apify to call when done
    const origin = request.headers.get('host')
    const proto = request.headers.get('x-forwarded-proto') || 'https'
    const baseUrl = `${proto}://${origin}`

    // 3. Kick off Apify runs for each due source
    const results: Array<{
      source_id: string
      name: string
      status: string
      run_id?: string
      error?: string
    }> = []

    for (const source of sources as CoverageSource[]) {
      // Skip if not due (unless forced)
      if (!forceSourceId && !shouldScanNow(source)) {
        results.push({ source_id: source.id, name: source.name, status: 'skipped_not_due' })
        continue
      }

      const slug = source.config?.sullygnome_slug
      const timeRange = source.config?.default_time_range || '30d'

      if (!slug) {
        await supabase
          .from('coverage_sources')
          .update({
            last_run_at: new Date().toISOString(),
            last_run_status: 'error',
            last_run_message: 'Missing sullygnome_slug in config',
            consecutive_failures: (source.consecutive_failures || 0) + 1,
          })
          .eq('id', source.id)
        results.push({ source_id: source.id, name: source.name, status: 'error', error: 'Missing slug' })
        continue
      }

      if (!source.game?.client_id) {
        await supabase
          .from('coverage_sources')
          .update({
            last_run_at: new Date().toISOString(),
            last_run_status: 'error',
            last_run_message: 'Source must be linked to a game (with client)',
            consecutive_failures: (source.consecutive_failures || 0) + 1,
          })
          .eq('id', source.id)
        results.push({ source_id: source.id, name: source.name, status: 'error', error: 'No linked game' })
        continue
      }

      try {
        const midBudget = await checkApifyDailyBudget(supabase)
        if (!midBudget.ok) { console.warn(`SullyGnome scan stopping: daily cap reached`); break }

        // Build SullyGnome URL
        const targetUrl = buildSullyGnomeUrl(slug, timeRange)

        // Webhook URL includes source_id so the collect endpoint knows which source it's for
        const webhookUrl = `${baseUrl}/api/sullygnome-collect?source_id=${source.id}`

        // Start Apify actor run ASYNC (returns immediately with run ID)
        const input = {
          startUrls: [{ url: targetUrl }],
          pageFunction: buildPageFunction(),
          maxPagesPerCrawl: 1,
          proxyConfiguration: {
            useApifyProxy: true,
            apifyProxyGroups: ['RESIDENTIAL'],
          },
          pageFunctionTimeoutSecs: 60,
          maxConcurrency: 1,
        }
        const actorRes = await fetch(
          `https://api.apify.com/v2/acts/${APIFY_ACTOR}/runs?token=${apifyKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
          }
        )

        if (!actorRes.ok) {
          const errText = await actorRes.text().catch(() => 'Unknown error')
          await logApifyRun(supabase, {
            scanner: 'sullygnome-scan', actor_id: APIFY_ACTOR,
            input: { source_id: source.id, targetUrl },
            results_count: null, http_status: actorRes.status, ok: false,
            error: `HTTP ${actorRes.status}: ${errText.slice(0, 200)}`,
          })
          throw new Error(`Apify returned ${actorRes.status}: ${errText.slice(0, 200)}`)
        }

        await logApifyRun(supabase, {
          scanner: 'sullygnome-scan', actor_id: APIFY_ACTOR,
          input: { source_id: source.id, targetUrl },
          // Async actor — results count comes in via the webhook callback later.
          results_count: null, http_status: actorRes.status, ok: true, error: null,
        })

        const runData = await actorRes.json() as { data?: { id?: string; defaultDatasetId?: string } }
        const runId = runData?.data?.id
        const datasetId = runData?.data?.defaultDatasetId

        // Register webhook for this run so Apify calls us when done
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
            }
          ).catch(err => console.error('Webhook registration failed:', err))
        }

        // Mark source as running
        await supabase
          .from('coverage_sources')
          .update({
            last_run_at: new Date().toISOString(),
            last_run_status: 'running',
            last_run_message: `Apify run started: ${runId || 'unknown'}`,
            config: {
              ...source.config,
              _apify_run_id: runId,
              _apify_dataset_id: datasetId,
            },
          })
          .eq('id', source.id)

        results.push({ source_id: source.id, name: source.name, status: 'started', run_id: runId })
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Unknown error'
        console.error(`SullyGnome scan error for "${source.name}":`, errMsg)

        await supabase
          .from('coverage_sources')
          .update({
            last_run_at: new Date().toISOString(),
            last_run_status: 'failed',
            last_run_message: errMsg.slice(0, 500),
            consecutive_failures: (source.consecutive_failures || 0) + 1,
          })
          .eq('id', source.id)

        results.push({ source_id: source.id, name: source.name, status: 'error', error: errMsg })
      }
    }

    const startedCount = results.filter(r => r.status === 'started').length

    return NextResponse.json({
      message: `SullyGnome: ${startedCount} Apify runs started (results arrive via webhook)`,
      sources_started: startedCount,
      sources_total: results.length,
      details: results,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('SullyGnome scan error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
