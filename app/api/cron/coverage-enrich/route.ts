import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { GoogleGenAI } from '@google/genai'
import { sendDiscordNotification } from '@/lib/discord'
import { getGeminiConfig } from '@/lib/gemini-config'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

function getSupabase() {
  return getServerSupabase()
}

const COVERAGE_TYPES = [
  'news', 'review', 'preview', 'interview', 'trailer', 'stream',
  'video', 'guide', 'round-up', 'mention', 'feature', 'article'
]

const SENTIMENT_VALUES = ['positive', 'negative', 'neutral', 'mixed']

// GET /api/cron/coverage-enrich — Process unscored coverage items
export async function GET(request: NextRequest) {
  // Verify cron secret (allow manual browser testing)
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  const isManualTest = request.headers.get('user-agent')?.includes('Mozilla')

  if (!isManualTest && cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabase()

  try {
    // Get Gemini config (API key + model)
    const gemini = await getGeminiConfig(supabase)

    if (!gemini) {
      return NextResponse.json({ message: 'Gemini API key not configured, skipping enrichment' })
    }

    const ai = new GoogleGenAI({ apiKey: gemini.apiKey })

    // Fetch unscored items (max 10 per cron run — Gemini free tier = 15 RPM,
    // with 4.5s delay between calls, 10 items ≈ 45s, leaving headroom for the 60s function timeout)
    const { data: items, error } = await supabase
      .from('coverage_items')
      .select(`
        id, title, url, territory, coverage_type, quotes, sentiment,
        relevance_score, review_score, monthly_unique_visitors,
        client_id, game_id, approval_status, source_metadata,
        outlet:outlets(id, name, domain, tier, monthly_unique_visitors)
      `)
      .is('relevance_score', null)
      .order('discovered_at', { ascending: false })
      .limit(10)

    if (error) throw error
    if (!items || items.length === 0) {
      return NextResponse.json({ message: 'No items to enrich', enriched: 0 })
    }

    // Collect keyword context per client/game
    const clientGamePairs = new Set<string>()
    for (const item of items) {
      clientGamePairs.add(`${item.client_id}|${item.game_id || ''}`)
    }

    const keywordMap: Record<string, string[]> = {}
    const gameNameMap: Record<string, string> = {}

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
        gameNameMap[pair] = (gameData as Record<string, string>)?.name || ''
      }
    }

    // Process items
    let enriched = 0
    let errors = 0
    const errorDetails: string[] = []

    for (let i = 0; i < items.length; i++) {
      const item = items[i]

      // Rate limit: wait 4.5s between Gemini calls (free tier = 15 RPM)
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 4500))
      }

      try {
        const pair = `${item.client_id}|${item.game_id || ''}`
        const keywords = keywordMap[pair] || []
        const gameName = gameNameMap[pair] || ''
        const outlet = item.outlet as unknown as Record<string, unknown> | null
        const outletName = String(outlet?.name || outlet?.domain || 'Unknown')

        // Get keyword match context and content snippet from source metadata
        const sourceMeta = (item.source_metadata || {}) as Record<string, unknown>
        const keywordScore = sourceMeta.keyword_score as number | undefined
        const matchedKeywords = (sourceMeta.matched_keywords || []) as string[]
        const contentSnippet = sourceMeta.content_snippet as string | undefined

        const prompt = `You are a PR coverage analyst for a video game PR & marketing agency called Game Drive. Your job is to determine whether a news article is ACTUALLY about one of our client's games.

CRITICAL: Be strict. Many articles match keywords but are NOT about our game. Common false positives:
- Game name appears in a "best of" list but isn't the focus of the article
- A keyword like "Forever" or common word matches unrelated content
- The article mentions the game only in passing (1 line in a long article)
- The game name matches a common English word or phrase

GAME CONTEXT:
- Game: ${gameName || 'Not specified'}
- Client Keywords: ${keywords.length > 0 ? keywords.join(', ') : 'None configured'}
- RSS Keyword Matches: ${matchedKeywords.length > 0 ? matchedKeywords.join(', ') : 'None'}
- RSS Keyword Score: ${keywordScore ?? 'N/A'}

ARTICLE:
- Title: "${item.title || ''}"
- URL: ${item.url || ''}
- Outlet: ${outletName}${contentSnippet ? `\n- Content Preview: "${contentSnippet}"` : ''}

SCORING GUIDE:
- 90-100: Article is primarily/entirely about this specific game (review, preview, interview, dedicated article)
- 70-89: Article significantly covers this game (featured in round-up, multi-game article with substantial mention)
- 50-69: Game is mentioned but not a main focus (brief mention in list, tangential reference)
- 20-49: Weak connection — keyword match but article isn't really about this game
- 0-19: False positive — keyword matched but content is unrelated

COVERAGE TYPE — Choose the most specific type that fits. One of: ${COVERAGE_TYPES.join(', ')}
- "review" = scored review of a game
- "preview" = hands-on or first-look before release
- "interview" = Q&A with developers or publishers
- "guide" = how-to, tips, walkthrough, tutorial
- "trailer" = article about a trailer or gameplay reveal
- "feature" = in-depth editorial or analysis piece
- "round-up" = list article featuring multiple games
- "mention" = brief mention in a larger article
- "news" = general news announcement (default if unsure)

SENTIMENT: One of: ${SENTIMENT_VALUES.join(', ')}

Respond with ONLY valid JSON:
{"relevance_score": <number>, "relevance_reasoning": "<string>", "suggested_type": "<string>", "sentiment": "<string>"}`

        const response = await ai.models.generateContent({
          model: gemini.modelId,
          contents: prompt,
          config: { responseMimeType: 'application/json' },
        })

        const parsed = JSON.parse(response.text || '{}')
        const score = Math.max(0, Math.min(100, Number(parsed.relevance_score) || 0))
        const suggestedType = COVERAGE_TYPES.includes(parsed.suggested_type) ? parsed.suggested_type : 'article'
        const sentiment = SENTIMENT_VALUES.includes(parsed.sentiment) ? parsed.sentiment : 'neutral'

        // Determine approval
        let approvalStatus: string | undefined
        if (!['auto_approved', 'manually_approved', 'rejected'].includes(String(item.approval_status))) {
          if (score >= 80) approvalStatus = 'auto_approved'
          else if (score < 50) approvalStatus = 'rejected'
          else approvalStatus = 'pending_review'
        }

        const updates: Record<string, unknown> = {
          relevance_score: score,
          relevance_reasoning: String(parsed.relevance_reasoning || ''),
          sentiment,
          updated_at: new Date().toISOString(),
        }

        // Always update coverage_type with AI suggestion unless manually set
        // Items from RSS/Tavily are inserted as 'news' by default
        if (!item.coverage_type || item.coverage_type === 'article' || item.coverage_type === 'news') {
          updates.coverage_type = suggestedType
        }

        if (approvalStatus) {
          updates.approval_status = approvalStatus
          if (approvalStatus === 'auto_approved') {
            updates.approved_at = new Date().toISOString()
          }
        }

        await supabase.from('coverage_items').update(updates).eq('id', item.id)

        // Send Discord notification for newly auto-approved items
        if (approvalStatus === 'auto_approved') {
          try {
            await sendDiscordNotification({
              id: item.id,
              title: item.title || '',
              url: item.url || '',
              territory: item.territory || '',
              coverage_type: (updates.coverage_type as string) || item.coverage_type || 'article',
              review_score: item.review_score as number | null,
              monthly_unique_visitors: Number(outlet?.monthly_unique_visitors || 0),
              outlet_name: outletName,
              outlet_tier: String(outlet?.tier || 'untiered'),
              game_name: gameName,
              client_id: item.client_id,
              game_id: item.game_id,
            })
          } catch (discordErr) {
            console.error(`Discord notification error for item ${item.id}:`, discordErr)
          }
        }

        enriched++
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error(`Enrichment error for item ${item.id}:`, errMsg)
        errorDetails.push(`${String(item.title || '').substring(0, 50)}: ${errMsg.substring(0, 200)}`)
        errors++
      }
    }

    return NextResponse.json({
      message: `Enrichment complete: ${enriched} scored, ${errors} errors`,
      enriched,
      errors,
      total: items.length,
      ...(errorDetails.length > 0 ? { error_details: errorDetails.slice(0, 5) } : {}),
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Coverage enrich cron error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
