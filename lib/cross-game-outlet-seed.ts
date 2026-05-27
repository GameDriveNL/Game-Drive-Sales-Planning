/**
 * Cross-game outlet seeding.
 *
 * When a scanner auto-creates a new outlet (e.g. tavily-scan picks up a
 * domain we didn't have in our outlets table), it's likely the outlet
 * covers more than the one game that triggered its discovery. A horror
 * blog that just covered Game A probably has coverage on Games B, C, and
 * D too — Game Drive's portfolio overlaps heavily by genre.
 *
 * This module immediately fans out: for each OTHER PR-tracked game, run
 * one cheap Tavily query restricted to the new outlet's domain. Any hit
 * gets inserted as a coverage item for that game.
 *
 * Cost: 1 Tavily query per (new_outlet × other_pr_game) pair. With 7
 * PR-tracked games and ~10 new outlets discovered per week, that's ~70
 * queries per week ≈ $1.40/week. Cheap relative to the recall lift.
 *
 * Must not throw — best effort. Called by scanners as fire-and-forget so
 * failures don't block the originating scan.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { tavily } from '@tavily/core'
import { classifyCoverageType, matchGameFromContent } from './coverage-utils'
import { inferTerritory } from './territory'

interface SeedResult {
  outlet_domain: string
  games_checked: number
  games_with_hits: number
  total_new_items: number
  errors: string[]
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    u.searchParams.delete('utm_source')
    u.searchParams.delete('utm_medium')
    u.searchParams.delete('utm_campaign')
    let n = u.origin + u.pathname
    if (n.endsWith('/') && n.length > 1) n = n.slice(0, -1)
    const rest = u.searchParams.toString()
    if (rest) n += '?' + rest
    return n
  } catch {
    return url
  }
}

/**
 * For an outlet that was just auto-created, check whether it has covered
 * other PR-tracked games. Skips the originating game (no point re-finding
 * what we already have).
 */
export async function seedOutletAcrossGames(
  supabase: SupabaseClient,
  outletId: string,
  outletDomain: string,
  originatingGameId: string | null,
  tavilyApiKey: string
): Promise<SeedResult> {
  const result: SeedResult = {
    outlet_domain: outletDomain,
    games_checked: 0,
    games_with_hits: 0,
    total_new_items: 0,
    errors: [],
  }

  const skipDomains = [
    'youtube.com', 'reddit.com', 'twitter.com', 'x.com', 'twitch.tv',
    'tiktok.com', 'instagram.com', 'facebook.com',
    'store.steampowered.com', 'steamcommunity.com', 'steamdb.info',
    'gamefaqs.gamespot.com', 'metacritic.com', 'imdb.com', 'igdb.com',
    'fandom.com',
  ]
  if (skipDomains.some(s => outletDomain === s || outletDomain.endsWith('.' + s))) {
    return result
  }

  const { data: games } = await supabase
    .from('games')
    .select('id, name, client_id')
    .eq('pr_tracking_enabled', true)
  if (!games || games.length === 0) return result

  const others = games.filter(g => g.id !== originatingGameId)
  if (others.length === 0) return result

  const tvly = tavily({ apiKey: tavilyApiKey })

  // Pull existing URLs for this outlet to dedupe insertions cheaply.
  const { data: existing } = await supabase
    .from('coverage_items')
    .select('url')
    .ilike('url', `%${outletDomain}%`)
    .limit(500)
  const existingUrls = new Set((existing || []).map((r: { url: string }) => normalizeUrl(r.url)))

  const allKeywordsQuery = await supabase
    .from('coverage_keywords')
    .select('keyword, client_id, game_id, keyword_type')
  const allKeywords = allKeywordsQuery.data || []

  for (const game of others) {
    result.games_checked++
    try {
      const query = `"${game.name}" site:${outletDomain}`
      const res = await tvly.search(query, { maxResults: 10, searchDepth: 'basic', includeAnswer: false })
      let inserted = 0
      for (const r of (res.results || [])) {
        if (!r.url || !r.title) continue
        const norm = normalizeUrl(r.url)
        if (existingUrls.has(norm)) continue

        // Sanity: title or content must mention the game (Tavily site: queries
        // sometimes return unrelated pages from the domain).
        const text = `${r.title} ${r.content || ''}`.toLowerCase()
        const gameNameLower = game.name.toLowerCase()
        const gameTokens = gameNameLower.split(/\s+/).filter((t: string) => t.length >= 4)
        const hasMention = text.includes(gameNameLower)
          || gameTokens.every((t: string) => text.includes(t))
        if (!hasMention) continue

        existingUrls.add(norm)

        // Game-match via existing helper for an extra safety net.
        const matchedGameId = matchGameFromContent(
          r.title,
          r.content || '',
          [game.name],
          allKeywords,
          [{ id: game.id, name: game.name, client_id: game.client_id }]
        ) || game.id

        let territory: string | null = null
        try { territory = inferTerritory(outletDomain) } catch { /* ignore */ }

        const { error } = await supabase.from('coverage_items').insert({
          client_id: game.client_id,
          game_id: matchedGameId,
          outlet_id: outletId,
          title: r.title.trim(),
          url: norm,
          publish_date: r.publishedDate ? r.publishedDate.split('T')[0] : null,
          coverage_type: classifyCoverageType('news', norm),
          territory,
          relevance_score: null, // Gemini enriches later
          approval_status: 'pending_review',
          source_type: 'tavily',
          source_metadata: {
            cross_game_seed: true,
            originating_outlet: outletDomain,
            search_query: query,
            tavily_score: r.score || null,
          },
          discovered_at: new Date().toISOString(),
        })
        if (!error) inserted++
      }
      if (inserted > 0) {
        result.games_with_hits++
        result.total_new_items += inserted
      }
    } catch (err) {
      result.errors.push(`${game.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (result.total_new_items > 0) {
    console.log(`[cross-game-seed] ${outletDomain} → ${result.total_new_items} items across ${result.games_with_hits}/${result.games_checked} games`)
  }
  return result
}
