/**
 * Auto-enroll a game into all PR coverage scrapers.
 *
 * Two modes:
 *   - mode: 'create-missing' — only insert rows for source_types not yet present
 *     (default behavior, used when a new game is added or pr_tracking is toggled on)
 *   - mode: 'refresh' — update existing rows' configs in place and insert any
 *     missing types. Used by the admin backfill endpoint to retrofit games that
 *     were enrolled before the variant generator existed.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { generateVariants, defaultSubredditsForGame } from './keyword-variants'
import { detectGenres, outletsForGenres } from './genre-outlet-bank'

export interface AutoEnrollResult {
  game_id: string
  game_name: string
  variants: string[]
  hashtags: string[]
  subreddits: string[]
  inserted_types: string[]
  refreshed_types: string[]
  new_keywords: number
  genres: string[]
  genre_outlets_subscribed: string[]
  trace: Array<{ value: string; kind: 'deterministic' | 'tavily' }>
}

/**
 * Upsert outlet + ensure RSS coverage_source for each entry in the genre bank.
 * Returns the domains we actually subscribed to (skipping any where the outlet
 * already had an RSS source).
 */
async function subscribeGenreOutlets(
  db: SupabaseClient,
  gameName: string,
  contextText: string | null
): Promise<{ genres: string[]; subscribed: string[] }> {
  const genres = detectGenres(`${gameName} ${contextText || ''}`)
  if (genres.length === 0) return { genres, subscribed: [] }

  const subscribed: string[] = []
  const outlets = outletsForGenres(genres)

  for (const entry of outlets) {
    // Upsert outlet by domain
    const { data: existing } = await db
      .from('outlets')
      .select('id, rss_feed_url')
      .eq('domain', entry.domain)
      .maybeSingle()

    let outletId: string | undefined = existing?.id
    if (!outletId) {
      const { data: inserted, error: insErr } = await db
        .from('outlets')
        .insert({
          name: entry.name,
          domain: entry.domain,
          country: entry.country,
          monthly_unique_visitors: entry.monthly_unique_visitors,
          tier: entry.tier,
          rss_feed_url: entry.rss_feed_url,
          is_active: true,
        })
        .select('id')
        .single()
      if (insErr) {
        console.error(`[genre-bank] Outlet upsert failed for ${entry.domain}:`, insErr.message)
        continue
      }
      outletId = inserted.id
    } else if (entry.rss_feed_url && !existing?.rss_feed_url) {
      // Backfill rss_feed_url if the outlet exists but is missing it.
      await db.from('outlets').update({ rss_feed_url: entry.rss_feed_url, updated_at: new Date().toISOString() }).eq('id', outletId)
    }

    if (!outletId || !entry.rss_feed_url) continue

    // Subscribe RSS coverage_source if not already present.
    const { data: existingSrc } = await db
      .from('coverage_sources')
      .select('id')
      .eq('outlet_id', outletId)
      .eq('source_type', 'rss')
      .maybeSingle()
    if (existingSrc) continue

    const { error: srcErr } = await db
      .from('coverage_sources')
      .insert({
        source_type: 'rss',
        name: `${entry.name} RSS`,
        config: { url: entry.rss_feed_url },
        outlet_id: outletId,
        scan_frequency: 'daily',
        is_active: true,
      })
    if (!srcErr) subscribed.push(entry.domain)
    else console.error(`[genre-bank] RSS source insert failed for ${entry.domain}:`, srcErr.message)
  }

  if (subscribed.length > 0) {
    console.log(`[genre-bank] Subscribed ${subscribed.length} genre outlets (${genres.join(',')}): ${subscribed.join(', ')}`)
  }
  return { genres, subscribed }
}

interface SourceSpec {
  source_type: string
  name: string
  scan_frequency: string
  config: Record<string, unknown>
}

function buildSourceSpecs(
  gameName: string,
  searchKeywords: string[],
  hashtags: string[],
  subreddits: string[]
): SourceSpec[] {
  const sgSlug = gameName.replace(/\s+/g, '_')
  return [
    {
      source_type: 'sullygnome',
      name: `SullyGnome – ${gameName}`,
      scan_frequency: 'weekly',
      config: { game_name: gameName, sullygnome_slug: sgSlug, default_time_range: '30d', min_avg_viewers: 10 },
    },
    {
      source_type: 'youtube',
      name: `YouTube – ${gameName}`,
      scan_frequency: 'daily',
      config: { keywords: searchKeywords, channel_name: '' },
    },
    {
      source_type: 'reddit',
      name: `Reddit – ${gameName}`,
      scan_frequency: 'daily',
      config: { subreddits, keywords: searchKeywords, min_upvotes: 5 },
    },
    {
      source_type: 'twitter',
      name: `Twitter – ${gameName}`,
      scan_frequency: 'daily',
      config: { keywords: searchKeywords, handles: [], min_followers: 100 },
    },
    {
      source_type: 'tiktok',
      name: `TikTok – ${gameName}`,
      scan_frequency: 'daily',
      config: { keywords: searchKeywords, hashtags, profiles: [], min_followers: 100 },
    },
    {
      source_type: 'instagram',
      name: `Instagram – ${gameName}`,
      scan_frequency: 'daily',
      config: { keywords: searchKeywords, hashtags, min_followers: 100 },
    },
    {
      source_type: 'tavily',
      name: `${gameName} - Web Search`,
      scan_frequency: 'daily',
      config: { keywords: searchKeywords, max_queries: 4 },
    },
  ]
}

export async function autoEnrollGameInScrapers(
  db: SupabaseClient,
  gameId: string,
  gameName: string,
  clientId: string,
  options: { mode?: 'create-missing' | 'refresh' } = {}
): Promise<AutoEnrollResult> {
  const mode = options.mode || 'create-missing'

  const { data: clientRow } = await db
    .from('clients')
    .select('name')
    .eq('id', clientId)
    .single()
  const studioName = clientRow?.name || null

  const { data: tavilyKey } = await db
    .from('service_api_keys')
    .select('api_key')
    .eq('service_name', 'tavily')
    .eq('is_active', true)
    .maybeSingle()

  const variantResult = await generateVariants(
    { gameName, studioName },
    tavilyKey?.api_key
  )
  const searchKeywords = variantResult.variants
  const hashtags = variantResult.hashtags
  const subreddits = Array.from(new Set([
    ...defaultSubredditsForGame(gameName),
    ...variantResult.subreddits,
  ]))

  const specs = buildSourceSpecs(gameName, searchKeywords, hashtags, subreddits)

  const { data: existingSources } = await db
    .from('coverage_sources')
    .select('id, source_type')
    .eq('game_id', gameId)

  const existingByType = new Map<string, string>()
  for (const s of existingSources || []) {
    existingByType.set(s.source_type, s.id)
  }

  const toInsert: Array<Record<string, unknown>> = []
  const refreshedTypes: string[] = []

  for (const spec of specs) {
    const existingId = existingByType.get(spec.source_type)
    if (existingId) {
      if (mode === 'refresh') {
        const { error: updErr } = await db
          .from('coverage_sources')
          .update({ config: spec.config, updated_at: new Date().toISOString() })
          .eq('id', existingId)
        if (!updErr) refreshedTypes.push(spec.source_type)
        else console.error(`[auto-enroll] Refresh failed for ${spec.source_type}:`, updErr.message)
      }
      // mode === 'create-missing': skip silently
    } else {
      toInsert.push({
        source_type: spec.source_type,
        name: spec.name,
        game_id: gameId,
        scan_frequency: spec.scan_frequency,
        is_active: true,
        config: spec.config,
      })
    }
  }

  const insertedTypes: string[] = []
  if (toInsert.length > 0) {
    const { data: inserted, error: srcErr } = await db
      .from('coverage_sources')
      .insert(toInsert)
      .select('source_type')
    if (srcErr) {
      console.error('[auto-enroll] Insert failed:', srcErr.message)
    } else if (inserted) {
      for (const row of inserted) insertedTypes.push(row.source_type)
    }
  }

  // Upsert whitelist keywords. We add new variants; we do NOT delete existing
  // ones — operators may have hand-curated additions we shouldn't clobber.
  let newKeywords = 0
  for (const kw of searchKeywords) {
    const { data: existing } = await db
      .from('coverage_keywords')
      .select('id')
      .eq('game_id', gameId)
      .eq('keyword', kw)
      .eq('keyword_type', 'whitelist')
      .limit(1)
    if (!existing || existing.length === 0) {
      const { error: kwErr } = await db.from('coverage_keywords').insert({
        client_id: clientId,
        game_id: gameId,
        keyword: kw,
        keyword_type: 'whitelist',
      })
      if (!kwErr) newKeywords++
      else console.error(`[auto-enroll] Keyword "${kw}" insert failed:`, kwErr.message)
    }
  }

  // Subscribe to genre-relevant outlets (e.g. Bloody Disgusting, Rely on
  // Horror for horror games). This pre-seeds outlets we know cover the
  // genre so we don't wait for organic discovery via Tavily — a major
  // shortcut to "what would a human do" thinking.
  const genreSub = await subscribeGenreOutlets(db, gameName, /* contextText */ null)

  console.log(
    `[auto-enroll] ${mode === 'refresh' ? 'Refreshed' : 'Enrolled'} "${gameName}": ` +
    `inserted ${insertedTypes.length}, refreshed ${refreshedTypes.length}, ` +
    `+${newKeywords} keywords from ${searchKeywords.length} variants, ` +
    `genre outlets +${genreSub.subscribed.length} (genres: ${genreSub.genres.join(',') || 'none'})`
  )

  return {
    game_id: gameId,
    game_name: gameName,
    variants: searchKeywords,
    hashtags,
    subreddits,
    inserted_types: insertedTypes,
    refreshed_types: refreshedTypes,
    new_keywords: newKeywords,
    genres: genreSub.genres,
    genre_outlets_subscribed: genreSub.subscribed,
    trace: variantResult.trace,
  }
}
