import { NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

/**
 * Q6: month-to-date API usage tracker.
 * Aggregates what we currently log into a per-provider summary.
 *
 * Apify: full data — counted from apify_runs table grouped by scanner
 * Tavily / Gemini: not yet tracked locally — the response includes a flag
 *   pointing the user to each provider's own billing dashboard
 */
export async function GET() {
  const supabase = getServerSupabase()

  // Calculate start of current month in UTC
  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()

  // Apify usage from apify_runs
  const { data: apifyRuns } = await supabase
    .from('apify_runs')
    .select('scanner, ok, results_count')
    .gte('created_at', monthStart)

  const apifyByScanner: Record<string, { runs: number; ok: number; failed: number; items: number }> = {}
  for (const run of apifyRuns || []) {
    const key = (run.scanner as string) || 'unknown'
    if (!apifyByScanner[key]) apifyByScanner[key] = { runs: 0, ok: 0, failed: 0, items: 0 }
    apifyByScanner[key].runs++
    if (run.ok) apifyByScanner[key].ok++
    else apifyByScanner[key].failed++
    apifyByScanner[key].items += run.results_count || 0
  }

  // Tavily: count coverage_items by source_type='tavily' for current month (proxy for usage)
  const { count: tavilyItemsThisMonth } = await supabase
    .from('coverage_items')
    .select('id', { count: 'exact', head: true })
    .eq('source_type', 'tavily')
    .gte('discovered_at', monthStart)

  // Gemini: count of items where is_ai_generated proxy or relevance_score is set this month
  // (most items get a Gemini classify call during enrichment)
  const { count: geminiClassifiedThisMonth } = await supabase
    .from('coverage_items')
    .select('id', { count: 'exact', head: true })
    .not('relevance_score', 'is', null)
    .gte('discovered_at', monthStart)

  return NextResponse.json({
    period_start: monthStart,
    period_end: new Date().toISOString(),
    apify: {
      total_runs: (apifyRuns || []).length,
      by_scanner: apifyByScanner,
      billing_dashboard: 'https://console.apify.com/billing',
    },
    tavily: {
      items_discovered: tavilyItemsThisMonth ?? 0,
      note: 'Each Tavily search costs ~$0.005-0.02 depending on depth. Items discovered != API calls (Tavily can return multiple items per call).',
      billing_dashboard: 'https://app.tavily.com/account/billing',
    },
    gemini: {
      items_classified: geminiClassifiedThisMonth ?? 0,
      note: 'Each coverage item gets one Gemini classify call during enrichment. Free tier covers ~15K calls/month.',
      billing_dashboard: 'https://aistudio.google.com/app/usage',
    },
  })
}
