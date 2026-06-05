/**
 * POST /api/coverage-health/noise-backfill
 *
 * One-shot retro-classify every coverage_item with the new noise patterns.
 * Updates noise_flags column in-place. Runs in batches of 500.
 *
 * Body (JSON, optional):
 *   game_id?: string — restrict to a single game (otherwise all PR-tracked)
 *   limit?: number   — cap items processed per request (default 5000)
 *
 * Safe to re-run. Skips items whose noise_flags are already set unless
 * `force:true` is passed.
 *
 * Whitelisted in middleware.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { detectNoise } from '@/lib/noise-detector'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

export async function POST(request: NextRequest) {
  const supabase = getServerSupabase()
  const t0 = Date.now()

  let body: { game_id?: string; limit?: number; force?: boolean } = {}
  try { body = await request.json() } catch { /* empty body ok */ }
  const cap = Math.min(body.limit ?? 5000, 25_000)
  const force = body.force === true

  // Pull items that need classification — either noise_flags = {} (unprocessed)
  // OR force = true (re-process everything).
  let qb = supabase
    .from('coverage_items')
    .select('id, title, source_metadata, source_type, monthly_unique_visitors, noise_flags')
    .order('discovered_at', { ascending: false })
    .limit(cap)
  if (body.game_id) qb = qb.eq('game_id', body.game_id)
  if (!force) qb = qb.eq('noise_flags', '{}')

  const { data: items, error } = await qb
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!items || items.length === 0) {
    return NextResponse.json({ message: 'No items to backfill', processed: 0 })
  }

  const byFlag: Record<string, number> = {}
  let processed = 0
  let updated = 0
  let signal = 0
  let noise = 0

  // Update in batches of 100 to avoid huge IN clauses
  const updates: Array<{ id: string; noise_flags: string[] }> = []
  for (const it of items) {
    if (Date.now() - t0 > 260_000) break
    const md = (it.source_metadata ?? {}) as Record<string, unknown>
    const result = detectNoise({
      title: (it.title as string) || '',
      description: (md.description_snippet as string) || (md.bio as string) || '',
      audienceFollowers: (md.followers as number) ?? (md.subscribers as number) ?? null,
      audienceViews: (md.views as number) ?? (it.monthly_unique_visitors as number) ?? null,
      sourceType: it.source_type as string,
    })
    processed++
    if (result.flags.length === 0) signal++
    else {
      noise++
      for (const f of result.flags) byFlag[f] = (byFlag[f] ?? 0) + 1
    }
    // Only push update if state changed
    const before = (it.noise_flags as string[] | null) ?? []
    const after = result.flags as string[]
    if (before.length !== after.length || before.some(x => !after.includes(x as never))) {
      updates.push({ id: it.id as string, noise_flags: after })
    }
  }

  // Batch-write updates (upsert-style)
  for (let i = 0; i < updates.length; i += 100) {
    const batch = updates.slice(i, i + 100)
    await Promise.all(batch.map(u =>
      supabase.from('coverage_items').update({ noise_flags: u.noise_flags }).eq('id', u.id)
    ))
    updated += batch.length
  }

  return NextResponse.json({
    message: `Backfilled ${processed} items: ${signal} signal, ${noise} noise (${updated} rows updated)`,
    processed, signal, noise, updated,
    by_flag: byFlag,
    elapsed_ms: Date.now() - t0,
  })
}
