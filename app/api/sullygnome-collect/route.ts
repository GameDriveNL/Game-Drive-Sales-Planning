import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import {
  parseApifyRow,
  processSullyGnomeRows,
} from '@/lib/sullygnome'
import { verifyCollectSig, isValidDatasetId } from '@/lib/webhook-sig'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

// ─── Types ──────────────────────────────────────────────────────────────────

interface ApifyWebhookPayload {
  eventType: string
  eventData: {
    actorId?: string
    actorRunId?: string
    status?: string
  }
  resource?: {
    id?: string
    defaultDatasetId?: string
    status?: string
  }
}

// ─── POST /api/sullygnome-collect — Apify webhook callback ─────────────────
// Called by Apify when an actor run completes. Fetches dataset items,
// processes them through the SullyGnome pipeline, and updates the source.

export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const sourceId = searchParams.get('source_id')

  if (!sourceId) {
    return NextResponse.json({ error: 'source_id is required' }, { status: 400 })
  }

  // Apify calls this with no session. The registered URL carries a signature
  // of the source id; anything without a valid one is rejected.
  if (!verifyCollectSig(sourceId, searchParams.get('sig'))) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const supabase = getServerSupabase()

  try {
    // Parse webhook payload
    let payload: ApifyWebhookPayload | null = null
    try {
      payload = await request.json()
    } catch {
      // May be called manually without payload — that's ok
    }

    // Check if the run failed
    const eventType = payload?.eventType || ''
    if (eventType.includes('FAILED') || eventType.includes('ABORTED') || eventType.includes('TIMED_OUT')) {
      const status = payload?.resource?.status || eventType
      await supabase
        .from('coverage_sources')
        .update({
          last_run_status: 'failed',
          last_run_message: `Apify run ${status}`,
        })
        .eq('id', sourceId)
      return NextResponse.json({ message: `Run ${status}, source marked as failed` })
    }

    // 1. Get the source with game info
    const { data: source, error: srcErr } = await supabase
      .from('coverage_sources')
      .select('*, game:games(id, name, client_id)')
      .eq('id', sourceId)
      .single()

    if (srcErr || !source) {
      return NextResponse.json({ error: 'Source not found' }, { status: 404 })
    }

    const config = (source.config || {}) as Record<string, unknown>
    const game = source.game as { id: string; name: string; client_id: string } | null

    if (!game?.client_id) {
      return NextResponse.json({ error: 'Source has no linked game' }, { status: 400 })
    }

    // 2. Get dataset ID — from webhook payload or from source config
    const datasetId = payload?.resource?.defaultDatasetId
      || config._apify_dataset_id as string
      || null

    if (datasetId && !isValidDatasetId(datasetId)) {
      return NextResponse.json({ error: 'Invalid dataset id' }, { status: 400 })
    }

    if (!datasetId) {
      await supabase
        .from('coverage_sources')
        .update({
          last_run_status: 'failed',
          last_run_message: 'No dataset ID available — cannot fetch results',
        })
        .eq('id', sourceId)
      return NextResponse.json({ error: 'No dataset ID' }, { status: 400 })
    }

    // 3. Get Apify API key
    const { data: keyData } = await supabase
      .from('service_api_keys')
      .select('api_key')
      .eq('service_name', 'apify')
      .eq('is_active', true)
      .single()

    if (!keyData?.api_key) {
      return NextResponse.json({ error: 'Apify API key not configured' }, { status: 500 })
    }

    // 4. Fetch dataset items from Apify
    const datasetRes = await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items?token=${keyData.api_key}&format=json`,
    )

    if (!datasetRes.ok) {
      const errText = await datasetRes.text().catch(() => 'Unknown')
      throw new Error(`Failed to fetch dataset: ${datasetRes.status} ${errText.slice(0, 200)}`)
    }

    const rawResults = await datasetRes.json()

    // 5. Flatten results — web scraper returns pageFunction results
    // Apify web scraper can return data in multiple formats:
    //   a) Array of arrays (direct pageFunction return): [[cells], [cells], ...]
    //   b) Objects with numeric keys (Apify auto-converts arrays): {"0": "val", "1": "val", ...}
    //   c) Nested arrays wrapped in pageFunction results
    let allRows: string[][] = []
    if (Array.isArray(rawResults)) {
      for (const item of rawResults) {
        if (Array.isArray(item)) {
          // Direct array — could be a single row or nested rows
          if (item.length > 0 && Array.isArray(item[0])) {
            allRows = allRows.concat(item)
          } else if (item.length > 0 && typeof item[0] === 'string') {
            allRows.push(item)
          }
        } else if (item && typeof item === 'object' && !item['#error']) {
          // Object with numeric keys — convert to array
          // Apify web scraper auto-converts arrays to {"0": v, "1": v, ...}
          const numericKeys = Object.keys(item)
            .filter(k => !k.startsWith('#') && !k.startsWith('_'))
            .filter(k => /^\d+$/.test(k))
            .sort((a, b) => Number(a) - Number(b))
          if (numericKeys.length >= 8) {
            const cells = numericKeys.map(k => String(item[k] ?? ''))
            allRows.push(cells)
          }
        }
      }
    }

    // 6. Parse rows into SullyGnomeRow objects
    const parsedRows = allRows
      .map(cells => parseApifyRow(cells))
      .filter((r): r is NonNullable<typeof r> => r !== null)

    // 7. Process through shared pipeline
    const slug = (config.sullygnome_slug as string) || ''
    const gameName = (config.game_name as string) || game.name
    const timeRange = (config.default_time_range as string) || '30d'
    const minAvgViewers = Number(config.min_avg_viewers || 10)

    const result = await processSullyGnomeRows(supabase, parsedRows, {
      clientId: game.client_id,
      gameId: game.id,
      gameName,
      gameSlug: slug,
      timeRange,
      minAvgViewers,
    })

    // 8. Update source tracking — clean up temp config fields
    const cleanConfig = { ...config }
    delete cleanConfig._apify_run_id
    delete cleanConfig._apify_dataset_id

    await supabase
      .from('coverage_sources')
      .update({
        last_run_status: 'success',
        last_run_message: `${result.new_items} new, ${result.enriched} enriched, ${result.skipped} skipped`,
        items_found_last_run: result.new_items + result.enriched,
        total_items_found: (source.total_items_found || 0) + result.new_items,
        consecutive_failures: 0,
        config: cleanConfig,
      })
      .eq('id', sourceId)

    return NextResponse.json({
      message: 'SullyGnome results collected',
      source_id: sourceId,
      rows_found: parsedRows.length,
      new_items: result.new_items,
      enriched: result.enriched,
      skipped: result.skipped,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('SullyGnome collect error:', message)

    // Update source with error
    try {
      await supabase
        .from('coverage_sources')
        .update({
          last_run_status: 'failed',
          last_run_message: message.slice(0, 500),
        })
        .eq('id', sourceId)
    } catch { /* best effort */ }

    return NextResponse.json({ error: message }, { status: 500 })
  }
}
