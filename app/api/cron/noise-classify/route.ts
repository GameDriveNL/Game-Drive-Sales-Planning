/**
 * GET /api/cron/noise-classify
 *
 * Classifies coverage items that have no noise_classified_at yet, a slice per
 * run, so the noise filter in client reports covers every item. About 76% of
 * rows were unclassified because the only thing that classified them was a
 * manual one-shot (/api/coverage-health/noise-backfill) that nothing
 * scheduled, and audit-enrich resets the flag expecting a cron to re-run it.
 *
 * Cheap when there is nothing to do: the partial index
 * idx_coverage_items_unclassified (discovered_at DESC WHERE
 * noise_classified_at IS NULL) answers the lookup directly.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { verifyCronAuth } from '@/lib/cron-auth'
import { detectNoise } from '@/lib/noise-detector'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 120

const PER_RUN = 600
const WRITE_CONCURRENCY = 40
const TIME_BUDGET_MS = 100_000

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request)
  if (authError) return authError

  const supabase = getServerSupabase()
  const t0 = Date.now()

  const { data: items, error } = await supabase
    .from('coverage_items')
    .select('id, title, source_metadata, source_type, monthly_unique_visitors')
    .is('noise_classified_at', null)
    .order('discovered_at', { ascending: false })
    .limit(PER_RUN)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!items || items.length === 0) {
    return NextResponse.json({ message: 'Nothing to classify', processed: 0 })
  }

  const nowIso = new Date().toISOString()
  let signal = 0
  let noise = 0
  let failed = 0
  const rows: Array<{ id: string; flags: string[] }> = []

  for (const it of items) {
    const md = (it.source_metadata ?? {}) as Record<string, unknown>
    const result = detectNoise({
      title: (it.title as string) || '',
      description: (md.description_snippet as string) || (md.bio as string) || '',
      audienceFollowers: (md.followers as number) ?? (md.subscribers as number) ?? null,
      audienceViews: (md.views as number) ?? (it.monthly_unique_visitors as number) ?? null,
      sourceType: it.source_type as string,
    })
    if (result.flags.length === 0) signal++
    else noise++
    rows.push({ id: it.id as string, flags: result.flags as string[] })
  }

  let written = 0
  for (let i = 0; i < rows.length; i += WRITE_CONCURRENCY) {
    if (Date.now() - t0 > TIME_BUDGET_MS) break
    const slice = rows.slice(i, i + WRITE_CONCURRENCY)
    const results = await Promise.all(
      slice.map(r =>
        supabase
          .from('coverage_items')
          .update({ noise_flags: r.flags, noise_classified_at: nowIso })
          .eq('id', r.id)
      )
    )
    for (const res of results) {
      if (res.error) failed++
      else written++
    }
  }

  return NextResponse.json({
    message: `Classified ${written} items (${signal} signal, ${noise} noise)`,
    processed: items.length,
    written,
    failed,
    elapsed_ms: Date.now() - t0,
  })
}
