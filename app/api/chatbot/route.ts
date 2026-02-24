import { NextRequest } from 'next/server'
import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs'
import { cookies } from 'next/headers'
import { GoogleGenAI } from '@google/genai'
import { getServerSupabase } from '@/lib/supabase'
import { getGeminiConfig } from '@/lib/gemini-config'
import { QUERY_PLANNER_PROMPT, buildAnswerPrompt } from '@/lib/chatbot-schema'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface QueryFilter {
  column: string
  op: string
  value: unknown
}

interface QuerySpec {
  table: string
  select: string
  filters?: QueryFilter[]
  order?: { column: string; ascending: boolean }
  limit?: number
  group_note?: string
}

interface QueryPlan {
  needs_data: boolean
  reasoning: string
  queries: QuerySpec[]
}

// POST /api/chatbot — Two-step AI chatbot with database context
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { message, history } = body as { message: string; history?: ChatMessage[] }

    if (!message?.trim()) {
      return new Response(JSON.stringify({ error: 'Message is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // 1. Get Gemini config via service role (API keys are not RLS-scoped)
    const serviceSupabase = getServerSupabase()
    const gemini = await getGeminiConfig(serviceSupabase)

    if (!gemini) {
      return new Response(JSON.stringify({ error: 'Gemini AI is not configured. Add your API key in Settings > System Keys.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // 2. Get authenticated user context (respects RLS)
    const userSupabase = createRouteHandlerClient({ cookies })
    const { data: { user } } = await userSupabase.auth.getUser()

    if (!user) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Get user's accessible clients for RLS context
    const { data: profile } = await serviceSupabase
      .from('user_profiles')
      .select('role, all_clients')
      .eq('id', user.id)
      .single()

    let clientContext = ''
    if (profile?.all_clients || profile?.role === 'superadmin') {
      clientContext = 'User has access to ALL clients.'
    } else {
      const { data: userClients } = await serviceSupabase
        .from('user_clients')
        .select('client_id, clients(name)')
        .eq('user_id', user.id)

      if (userClients && userClients.length > 0) {
        const names = userClients.map(uc => {
          const client = uc.clients as unknown as { name: string } | null
          return client?.name || 'Unknown'
        })
        clientContext = `User has access to these clients: ${names.join(', ')}. Only return data for these clients.`
      } else {
        clientContext = 'User has no client access configured.'
      }
    }

    const ai = new GoogleGenAI({ apiKey: gemini.apiKey })
    const modelId = gemini.chatbotModelId

    // 3. Step 1: Query Planning
    const recentHistory = (history || []).slice(-10)
    const historyContext = recentHistory.length > 0
      ? `\n\nCONVERSATION HISTORY:\n${recentHistory.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n')}`
      : ''

    const plannerInput = `${QUERY_PLANNER_PROMPT}

${clientContext}
${historyContext}

USER QUESTION: ${message}`

    const planResponse = await ai.models.generateContent({
      model: modelId,
      contents: plannerInput,
      config: { responseMimeType: 'application/json' },
    })

    let queryPlan: QueryPlan
    try {
      queryPlan = JSON.parse(planResponse.text || '{"needs_data":false,"reasoning":"Parse error","queries":[]}')
    } catch {
      queryPlan = { needs_data: false, reasoning: 'Could not parse query plan', queries: [] }
    }

    // 4. Step 2: Execute queries (using service role for simplicity, but filtered by client access)
    let dataContext = ''

    if (queryPlan.needs_data && queryPlan.queries.length > 0) {
      const queryResults: string[] = []

      for (const spec of queryPlan.queries.slice(0, 5)) {
        try {
          let query = serviceSupabase
            .from(spec.table)
            .select(spec.select)

          // Apply filters
          if (spec.filters) {
            for (const filter of spec.filters) {
              switch (filter.op) {
                case 'eq': query = query.eq(filter.column, filter.value); break
                case 'neq': query = query.neq(filter.column, filter.value); break
                case 'gt': query = query.gt(filter.column, filter.value); break
                case 'gte': query = query.gte(filter.column, filter.value); break
                case 'lt': query = query.lt(filter.column, filter.value); break
                case 'lte': query = query.lte(filter.column, filter.value); break
                case 'like': query = query.like(filter.column, String(filter.value)); break
                case 'ilike': query = query.ilike(filter.column, String(filter.value)); break
                case 'in': query = query.in(filter.column, filter.value as string[]); break
                case 'is':
                  if (filter.value === null) query = query.is(filter.column, null)
                  else if (filter.value === 'not.null') query = query.not(filter.column, 'is', null)
                  break
              }
            }
          }

          // Apply ordering
          if (spec.order) {
            query = query.order(spec.order.column, { ascending: spec.order.ascending })
          }

          // Apply limit (max 20 rows)
          const limit = Math.min(spec.limit || 20, 20)
          const { data, error } = await query.limit(limit)

          if (error) {
            queryResults.push(`Query on ${spec.table}: ERROR — ${error.message}`)
          } else if (data && data.length > 0) {
            let resultText = `Query on ${spec.table} (${data.length} rows):\n${JSON.stringify(data, null, 2)}`
            if (spec.group_note) {
              resultText += `\nAggregation note: ${spec.group_note}`
            }
            queryResults.push(resultText)
          } else {
            queryResults.push(`Query on ${spec.table}: No results found`)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Query execution error'
          queryResults.push(`Query on ${spec.table}: ERROR — ${msg}`)
        }
      }

      dataContext = queryResults.join('\n\n---\n\n')
    } else {
      dataContext = 'No database queries were needed for this question.\nQuery planner reasoning: ' + queryPlan.reasoning
    }

    // 5. Step 3: Generate answer with streaming
    const answerPrompt = buildAnswerPrompt(message, dataContext)

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const response = await ai.models.generateContentStream({
            model: modelId,
            contents: answerPrompt,
          })

          for await (const chunk of response) {
            const text = chunk.text || ''
            if (text) {
              const sseData = `data: ${JSON.stringify({ text })}\n\n`
              controller.enqueue(encoder.encode(sseData))
            }
          }

          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Stream error'
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        }
      }
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
