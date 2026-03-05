import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { GoogleGenAI } from '@google/genai'
import { getGeminiConfig } from '@/lib/gemini-config'
import { inferTerritory } from '@/lib/territory'

function getSupabase() {
  return getServerSupabase()
}

const COVERAGE_TYPES = [
  'news', 'review', 'preview', 'interview', 'trailer', 'stream',
  'video', 'guide', 'round-up', 'mention', 'feature', 'article'
]

const SENTIMENT_VALUES = ['positive', 'negative', 'neutral', 'mixed']

interface EnrichmentResult {
  relevance_score: number
  relevance_reasoning: string
  suggested_type: string
  sentiment: string
  is_ai_generated: boolean
  territory: string | null
}

async function enrichItem(
  ai: GoogleGenAI,
  modelId: string,
  item: Record<string, unknown>,
  keywords: string[],
  gameDescription: string
): Promise<EnrichmentResult> {
  const outlet = item.outlet as Record<string, unknown> | null
  const title = String(item.title || '')
  const url = String(item.url || '')
  const quotes = String(item.quotes || '')
  const outletName = String(outlet?.name || outlet?.domain || 'Unknown')
  const territory = String(item.territory || 'Unknown')

  const prompt = `You are a PR coverage analyst for a video game publishing company. Analyze this media coverage item and provide structured assessment.

GAME CONTEXT:
- Keywords being tracked: ${keywords.join(', ')}
- Game description: ${gameDescription || 'Not provided'}

COVERAGE ITEM:
- Title: "${title}"
- URL: ${url}
- Outlet: ${outletName}
- Territory: ${territory}
- Quotes/Notes: ${quotes || 'None'}

TASKS:
1. RELEVANCE SCORE (0-100): How relevant is this coverage to the tracked game? 80+ = clearly about the game, 50-79 = likely related, <50 = probably not relevant or just a passing mention.
2. REASONING: Brief 1-sentence explanation of the relevance score.
3. COVERAGE TYPE: Classify as one of: ${COVERAGE_TYPES.join(', ')}
4. SENTIMENT: Classify as one of: ${SENTIMENT_VALUES.join(', ')}
5. AI-GENERATED DETECTION: Determine if this article appears to be AI-generated or AI-rewritten (not by a human journalist). Signs include: generic templated writing, no original insights/quotes, "AI Reporter" byline, known AI content farm domain, or content that just restates a press release. Set true only if fairly confident, otherwise false.
6. TERRITORY: Determine the territory/region based on outlet name, URL domain, and language. Use proper country names: "Netherlands", "Germany", "France", "United States", "Japan", etc. For English-language global outlets (IGN, GameSpot), use "International". If unknown, use null.

Respond with ONLY valid JSON in this exact format:
{"relevance_score": <number 0-100>, "relevance_reasoning": "<string>", "suggested_type": "<string>", "sentiment": "<string>", "is_ai_generated": <boolean>, "territory": "<string or null>"}`

  const response = await ai.models.generateContent({
    model: modelId,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
    },
  })

  const text = response.text || '{}'
  const parsed = JSON.parse(text)

  return {
    relevance_score: Math.max(0, Math.min(100, Number(parsed.relevance_score) || 0)),
    relevance_reasoning: String(parsed.relevance_reasoning || ''),
    suggested_type: COVERAGE_TYPES.includes(parsed.suggested_type) ? parsed.suggested_type : 'article',
    sentiment: SENTIMENT_VALUES.includes(parsed.sentiment) ? parsed.sentiment : 'neutral',
    is_ai_generated: parsed.is_ai_generated === true,
    territory: typeof parsed.territory === 'string' ? parsed.territory : null,
  }
}

// POST /api/coverage-enrich — Enrich a batch of coverage items
export async function POST(request: NextRequest) {
  const supabase = getSupabase()

  try {
    const body = await request.json()
    const { item_ids, limit: batchLimit } = body

    // Get Gemini config (API key + model)
    const gemini = await getGeminiConfig(supabase)

    if (!gemini) {
      return NextResponse.json({ error: 'Gemini API key not configured. Add it in Coverage > API Keys.' }, { status: 400 })
    }

    const ai = new GoogleGenAI({ apiKey: gemini.apiKey })

    // Fetch items to enrich
    let query = supabase
      .from('coverage_items')
      .select(`
        id, title, url, territory, coverage_type, quotes, sentiment,
        relevance_score, client_id, game_id,
        outlet:outlets(id, name, domain)
      `)
      .is('relevance_score', null)
      .order('discovered_at', { ascending: false })

    if (item_ids && Array.isArray(item_ids) && item_ids.length > 0) {
      query = query.in('id', item_ids)
    }

    const maxItems = Math.min(Number(batchLimit) || 20, 50)
    const { data: items, error: itemsError } = await query.limit(maxItems)

    if (itemsError) throw itemsError
    if (!items || items.length === 0) {
      return NextResponse.json({ message: 'No items to enrich', enriched: 0 })
    }

    // Get unique client+game combos to fetch keywords
    const clientGamePairs = new Set<string>()
    for (const item of items) {
      clientGamePairs.add(`${item.client_id}|${item.game_id || ''}`)
    }

    // Fetch keywords for all relevant clients/games
    const keywordMap: Record<string, string[]> = {}
    const gameDescMap: Record<string, string> = {}

    for (const pair of Array.from(clientGamePairs)) {
      const [clientId, gameId] = pair.split('|')

      let kwQuery = supabase
        .from('coverage_keywords')
        .select('keyword')
        .eq('client_id', clientId)
        .eq('is_active', true)

      if (gameId) kwQuery = kwQuery.eq('game_id', gameId)

      const { data: kwData } = await kwQuery
      keywordMap[pair] = (kwData || []).map(k => (k as Record<string, string>).keyword)

      if (gameId) {
        const { data: gameData } = await supabase
          .from('games')
          .select('name')
          .eq('id', gameId)
          .single()
        gameDescMap[pair] = (gameData as Record<string, string>)?.name || ''
      }
    }

    // Enrich each item
    let enriched = 0
    const errors: string[] = []

    for (const item of items) {
      try {
        const pair = `${item.client_id}|${item.game_id || ''}`
        const keywords = keywordMap[pair] || []
        const gameDesc = gameDescMap[pair] || ''

        const result = await enrichItem(ai, gemini.modelId, item as Record<string, unknown>, keywords, gameDesc)

        // Determine approval status based on score
        let approvalStatus: string
        if (result.relevance_score >= 80) {
          approvalStatus = 'auto_approved'
        } else if (result.relevance_score < 50) {
          approvalStatus = 'rejected'
        } else {
          approvalStatus = 'pending_review'
        }

        // Infer territory if AI didn't provide one
        let territory = result.territory
        if (!territory) {
          const outlet = item.outlet as unknown as Record<string, unknown> | null
          territory = inferTerritory(String(outlet?.domain || ''))
        }

        // Update the coverage item
        const updates: Record<string, unknown> = {
          relevance_score: result.relevance_score,
          relevance_reasoning: result.relevance_reasoning,
          sentiment: result.sentiment,
          is_ai_generated: result.is_ai_generated,
          updated_at: new Date().toISOString(),
        }

        // Set territory if item doesn't have one
        if (territory && !item.territory) {
          updates.territory = territory
        }

        // Only update coverage_type if not already set
        if (!item.coverage_type || item.coverage_type === 'article') {
          updates.coverage_type = result.suggested_type
        }

        // Only update approval_status if it's still pending
        if (!['auto_approved', 'manually_approved', 'rejected'].includes(String((item as Record<string, unknown>).approval_status))) {
          updates.approval_status = approvalStatus
          if (approvalStatus === 'auto_approved') {
            updates.approved_at = new Date().toISOString()
          }
        }

        await supabase
          .from('coverage_items')
          .update(updates)
          .eq('id', item.id)

        enriched++
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        errors.push(`Item ${item.id}: ${msg}`)
      }
    }

    return NextResponse.json({
      enriched,
      total: items.length,
      errors: errors.length > 0 ? errors : undefined,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
