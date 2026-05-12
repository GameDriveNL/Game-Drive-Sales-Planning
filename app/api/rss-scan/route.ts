import { NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import Parser from 'rss-parser'
import { matchesWord } from '@/lib/coverage-utils'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

// ─── Types ──────────────────────────────────────────────────────────────────

interface CoverageSource {
  id: string
  source_type: string
  name: string
  config: { url?: string; [key: string]: unknown }
  outlet_id: string | null
  game_id: string | null
  scan_frequency: string
  is_active: boolean
  consecutive_failures: number
  total_items_found: number
  outlet?: { id: string; tier: string | null; monthly_unique_visitors: number | null } | null
}

interface Keyword {
  keyword: string
  keyword_type: 'whitelist' | 'blacklist'
  client_id: string
  game_id: string | null
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    u.searchParams.delete('utm_source')
    u.searchParams.delete('utm_medium')
    u.searchParams.delete('utm_campaign')
    u.searchParams.delete('utm_term')
    u.searchParams.delete('utm_content')
    let normalized = u.origin + u.pathname
    if (normalized.endsWith('/') && normalized.length > 1) {
      normalized = normalized.slice(0, -1)
    }
    const remaining = u.searchParams.toString()
    if (remaining) normalized += '?' + remaining
    return normalized
  } catch {
    return url.trim()
  }
}

function matchesKeywords(
  title: string,
  description: string,
  whitelistKeywords: string[],
  blacklistKeywords: string[]
): { matched: boolean; score: number; matchedTerms: string[] } {
  const text = `${title} ${description}`.toLowerCase()
  const titleLower = title.toLowerCase()
  const matchedTerms: string[] = []

  for (const kw of blacklistKeywords) {
    if (matchesWord(text, kw)) {
      return { matched: false, score: 0, matchedTerms: [] }
    }
  }

  if (whitelistKeywords.length === 0) {
    return { matched: true, score: 50, matchedTerms: [] }
  }

  let score = 0
  for (const kw of whitelistKeywords) {
    if (matchesWord(text, kw)) {
      matchedTerms.push(kw)
      if (matchesWord(titleLower, kw)) score += 30
      else score += 15
    }
  }

  if (matchedTerms.length === 0) {
    return { matched: false, score: 0, matchedTerms: [] }
  }

  return { matched: true, score: Math.min(score, 100), matchedTerms }
}

function determineApprovalStatus(relevanceScore: number): string {
  if (relevanceScore >= 80) return 'auto_approved'
  if (relevanceScore >= 50) return 'pending_review'
  return 'rejected'
}

// ─── POST: Manually trigger scan for specific source(s) ────────────────────

export async function POST(request: Request) {
  const startTime = Date.now()
  const supabase = getServerSupabase()

  try {
    const body = await request.json()
    const sourceId = body.source_id as string | undefined
    const scanAll = body.scan_all as boolean | undefined

    if (!sourceId && !scanAll) {
      return NextResponse.json({ error: 'Provide source_id or scan_all: true' }, { status: 400 })
    }

    // Fetch source(s)
    let query = supabase
      .from('coverage_sources')
      .select('*, outlet:outlets(id, tier, monthly_unique_visitors)')
      .eq('source_type', 'rss')
      .eq('is_active', true)

    if (sourceId) {
      query = query.eq('id', sourceId)
    }

    const { data: sources, error: srcErr } = await query

    if (srcErr || !sources || sources.length === 0) {
      return NextResponse.json({ error: 'No matching RSS sources found' }, { status: 404 })
    }

    // Fetch keywords
    const { data: keywords } = await supabase
      .from('coverage_keywords')
      .select('keyword, keyword_type, client_id, game_id')

    const allKeywords = (keywords || []) as Keyword[]
    const whitelistByClient = new Map<string, string[]>()
    const blacklistGlobal: string[] = []

    for (const kw of allKeywords) {
      if (kw.keyword_type === 'blacklist') {
        blacklistGlobal.push(kw.keyword)
      } else {
        if (!whitelistByClient.has(kw.client_id)) whitelistByClient.set(kw.client_id, [])
        whitelistByClient.get(kw.client_id)!.push(kw.keyword)
      }
    }

    const { data: games } = await supabase.from('games').select('id, name, client_id')

    // Fetch existing URLs for dedup
    const { data: existingItems } = await supabase
      .from('coverage_items')
      .select('url')
      .order('created_at', { ascending: false })
      .limit(10000)

    const existingUrls = new Set<string>()
    if (existingItems) {
      for (const item of existingItems) {
        existingUrls.add(normalizeUrl(item.url))
      }
    }

    const parser = new Parser({
      timeout: 15000,
      headers: {
        'User-Agent': 'GameDrive/1.0 Coverage Monitor',
        'Accept': 'application/rss+xml, application/xml, text/xml, application/atom+xml'
      }
    })

    const results: Array<{
      source: string
      status: string
      feed_entries: number
      matched: number
      inserted: number
      error?: string
    }> = []

    for (const source of (sources as CoverageSource[])) {
      const feedUrl = source.config?.url
      if (!feedUrl || typeof feedUrl !== 'string') {
        results.push({ source: source.name, status: 'error', feed_entries: 0, matched: 0, inserted: 0, error: 'No feed URL' })
        continue
      }

      if (Date.now() - startTime > 50000) break

      try {
        const feed = await parser.parseURL(feedUrl)
        const newItems: Array<Record<string, unknown>> = []

        for (const entry of (feed.items || [])) {
          if (!entry.link || !entry.title) continue

          const normalizedUrl = normalizeUrl(entry.link)
          if (existingUrls.has(normalizedUrl)) continue

          const description = entry.contentSnippet || entry.content || entry.summary || ''
          let bestMatch = { matched: false, score: 0, matchedTerms: [] as string[] }
          let matchedClientId: string | null = null
          let matchedGameId: string | null = source.game_id

          if (source.game_id && games) {
            const game = games.find(g => g.id === source.game_id)
            if (game) {
              matchedClientId = game.client_id
              const clientKeywords = whitelistByClient.get(game.client_id) || []
              bestMatch = matchesKeywords(entry.title, description, [...clientKeywords, game.name], blacklistGlobal)
            }
          }

          if (!bestMatch.matched) {
            for (const [clientId, kws] of Array.from(whitelistByClient.entries())) {
              const match = matchesKeywords(entry.title, description, kws, blacklistGlobal)
              if (match.matched && match.score > bestMatch.score) {
                bestMatch = match
                matchedClientId = clientId
                if (games) {
                  for (const game of games.filter(g => g.client_id === clientId)) {
                    if (entry.title.toLowerCase().includes(game.name.toLowerCase()) ||
                        description.toLowerCase().includes(game.name.toLowerCase())) {
                      matchedGameId = game.id
                      break
                    }
                  }
                }
              }
            }
          }

          if (!bestMatch.matched) continue

          existingUrls.add(normalizedUrl)

          newItems.push({
            client_id: matchedClientId,
            game_id: matchedGameId,
            outlet_id: source.outlet_id,
            title: entry.title.trim(),
            url: normalizedUrl,
            publish_date: entry.isoDate ? entry.isoDate.split('T')[0] : null,
            coverage_type: 'news',
            monthly_unique_visitors: source.outlet?.monthly_unique_visitors || null,
            relevance_score: bestMatch.score,
            relevance_reasoning: bestMatch.matchedTerms.length > 0
              ? `Matched keywords: ${bestMatch.matchedTerms.join(', ')}`
              : 'Broad match',
            approval_status: determineApprovalStatus(bestMatch.score),
            source_type: 'rss',
            source_metadata: {
              feed_url: feedUrl,
              feed_title: feed.title || source.name,
              source_id: source.id,
              guid: entry.guid || entry.id || null,
              author: entry.creator || entry.author || null,
              categories: entry.categories || []
            },
            discovered_at: new Date().toISOString()
          })
        }

        let insertedCount = 0
        if (newItems.length > 0) {
          const { data: inserted, error: insertErr } = await supabase
            .from('coverage_items')
            .upsert(newItems, { onConflict: 'url', ignoreDuplicates: true })
            .select('id')

          if (insertErr) {
            results.push({
              source: source.name, status: 'partial',
              feed_entries: feed.items?.length || 0, matched: newItems.length,
              inserted: 0, error: insertErr.message
            })
          } else {
            insertedCount = inserted?.length || 0
          }
        }

        // Update source
        await supabase.from('coverage_sources').update({
          last_run_at: new Date().toISOString(),
          last_run_status: 'success',
          last_run_message: `Found ${newItems.length} new items from ${feed.items?.length || 0} entries`,
          items_found_last_run: newItems.length,
          total_items_found: source.total_items_found + newItems.length,
          consecutive_failures: 0
        }).eq('id', source.id)

        results.push({
          source: source.name, status: 'success',
          feed_entries: feed.items?.length || 0, matched: newItems.length,
          inserted: insertedCount
        })

      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        const newFailures = source.consecutive_failures + 1
        await supabase.from('coverage_sources').update({
          last_run_at: new Date().toISOString(),
          last_run_status: 'failed',
          last_run_message: errMsg.substring(0, 500),
          last_error_at: new Date().toISOString(),
          consecutive_failures: newFailures
        }).eq('id', source.id)

        results.push({
          source: source.name, status: 'failed',
          feed_entries: 0, matched: 0, inserted: 0, error: errMsg
        })
      }
    }

    return NextResponse.json({
      message: 'Manual RSS scan complete',
      duration_ms: Date.now() - startTime,
      results
    })

  } catch (err) {
    return NextResponse.json(
      { error: 'RSS scan failed', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
