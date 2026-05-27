/**
 * Outlet enrichment pipeline.
 *
 * When any scanner auto-creates an outlet (tavily-scan, google-news-scan,
 * web-scrape, etc.), the system should consolidate post-creation work:
 *   - Auto-discover RSS feed
 *   - Cross-game seed (does this outlet cover other PR-tracked games?)
 *
 * Other enrichments that happen elsewhere (Hypestat traffic refresh,
 * AI scoring of items) are intentionally NOT done here — those have their
 * own crons and shouldn't slow down a real-time scan loop.
 *
 * Designed to be fire-and-forget: callers don't await this, so a slow
 * enrichment doesn't hold up the originating scan. All errors are caught
 * and logged.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { autoDiscoverAndCreateRssSource } from './rss-discovery'
import { seedOutletAcrossGames } from './cross-game-outlet-seed'

export interface OutletEnrichmentOpts {
  outletId: string
  outletDomain: string
  outletName: string
  /** game_id that triggered this outlet's creation, so cross-seed can skip it */
  originatingGameId?: string | null
  /** When true, run cross-game seed even if no Tavily key (no-op). Default true. */
  crossSeed?: boolean
  /** Time budget for the whole enrichment, in ms. Default 30s. */
  budgetMs?: number
}

export interface OutletEnrichmentResult {
  rss_found: boolean
  cross_seed_new_items: number
  errors: string[]
}

export async function enrichNewOutlet(
  supabase: SupabaseClient,
  opts: OutletEnrichmentOpts
): Promise<OutletEnrichmentResult> {
  const result: OutletEnrichmentResult = {
    rss_found: false,
    cross_seed_new_items: 0,
    errors: [],
  }
  const budgetMs = opts.budgetMs ?? 30000
  const start = Date.now()

  // 1. RSS auto-discovery
  try {
    const rss = await autoDiscoverAndCreateRssSource(
      opts.outletId, opts.outletDomain, opts.outletName, supabase
    )
    result.rss_found = rss.found
  } catch (err) {
    result.errors.push(`rss: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (Date.now() - start > budgetMs) return result

  // 2. Cross-game seed (only if Tavily key available)
  if (opts.crossSeed !== false) {
    const { data: tavilyKey } = await supabase
      .from('service_api_keys')
      .select('api_key')
      .eq('service_name', 'tavily')
      .eq('is_active', true)
      .maybeSingle()
    if (tavilyKey?.api_key) {
      try {
        const seedRes = await seedOutletAcrossGames(
          supabase,
          opts.outletId,
          opts.outletDomain,
          opts.originatingGameId ?? null,
          tavilyKey.api_key
        )
        result.cross_seed_new_items = seedRes.total_new_items
      } catch (err) {
        result.errors.push(`cross_seed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  return result
}
