import { NextRequest } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { computePrediction, predictionDeduplicationKey, type PredictionInput, type AIPrediction, type StatisticalPrediction } from '@/lib/prediction-engine'
import { getGeminiConfig } from '@/lib/gemini-config'

// POST /api/sales/predict-batch — Streaming batch predictions for auto-generated calendars
// Returns NDJSON (newline-delimited JSON) for progressive rendering

interface BatchSaleRequest {
  sale_id: string
  platform_id: string
  discount_percentage: number
  duration_days: number
  start_date: string
}

interface BatchRequest {
  product_id: string
  client_id: string
  sales: BatchSaleRequest[]
}

export interface BatchPredictionResult {
  predicted_revenue: number
  predicted_units: number
  confidence: 'low' | 'medium' | 'high'
  optimal_discount: number
  optimal_duration: number
  reasoning: string
  statistical_revenue: number
  sale_multiplier: number
}

// Process predictions in batches of 3 to respect Gemini rate limits
const BATCH_SIZE = 3
const BATCH_DELAY_MS = 2000

export async function POST(request: NextRequest) {
  const supabase = getServerSupabase()

  try {
    const body: BatchRequest = await request.json()
    const { product_id, client_id, sales } = body

    if (!product_id || !client_id || !sales?.length) {
      return new Response(JSON.stringify({ error: 'product_id, client_id, and sales array are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Get Gemini config (API key + model) once for all predictions
    const gemini = await getGeminiConfig(supabase)

    // Deduplicate: group sales by (product_id, platform_id, discount, duration)
    const dedupGroups = new Map<string, { input: PredictionInput; saleIds: string[] }>()

    for (const sale of sales) {
      const key = predictionDeduplicationKey({
        product_id,
        platform_id: sale.platform_id,
        discount_percentage: sale.discount_percentage,
        duration_days: sale.duration_days,
      })

      if (dedupGroups.has(key)) {
        dedupGroups.get(key)!.saleIds.push(sale.sale_id)
      } else {
        dedupGroups.set(key, {
          input: {
            product_id,
            platform_id: sale.platform_id,
            client_id,
            discount_percentage: sale.discount_percentage,
            duration_days: sale.duration_days,
            start_date: sale.start_date,
          },
          saleIds: [sale.sale_id],
        })
      }
    }

    const groups = Array.from(dedupGroups.values())

    // Stream NDJSON responses
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        let processedGroups = 0

        // Process in batches
        for (let i = 0; i < groups.length; i += BATCH_SIZE) {
          const batch = groups.slice(i, i + BATCH_SIZE)

          // Run batch concurrently
          const results = await Promise.allSettled(
            batch.map(async (group) => {
              const result = await computePrediction(group.input, supabase, gemini?.apiKey, gemini?.modelId)

              // Build compact result for each sale in the group
              const prediction: BatchPredictionResult = {
                predicted_revenue: result.ai_prediction?.predicted_revenue ?? result.statistical_prediction.estimated_total_revenue,
                predicted_units: result.ai_prediction?.predicted_units ?? result.statistical_prediction.estimated_total_units,
                confidence: result.ai_prediction?.confidence ?? (result.has_sufficient_data ? 'medium' : 'low'),
                optimal_discount: result.ai_prediction?.optimal_discount ?? group.input.discount_percentage,
                optimal_duration: result.ai_prediction?.optimal_duration ?? group.input.duration_days,
                reasoning: result.ai_prediction?.reasoning ?? 'Based on statistical analysis of historical data',
                statistical_revenue: result.statistical_prediction.estimated_total_revenue,
                sale_multiplier: result.statistical_prediction.sale_multiplier,
              }

              return { saleIds: group.saleIds, prediction }
            })
          )

          // Stream each result
          for (const result of results) {
            if (result.status === 'fulfilled') {
              const { saleIds, prediction } = result.value
              for (const saleId of saleIds) {
                const line = JSON.stringify({ sale_id: saleId, prediction }) + '\n'
                controller.enqueue(encoder.encode(line))
              }
            } else {
              // Find which group failed
              const failedIdx = results.indexOf(result)
              const failedGroup = batch[failedIdx]
              if (failedGroup) {
                for (const saleId of failedGroup.saleIds) {
                  const line = JSON.stringify({ sale_id: saleId, error: 'Prediction failed' }) + '\n'
                  controller.enqueue(encoder.encode(line))
                }
              }
            }
          }

          processedGroups += batch.length

          // Delay between batches (except for the last batch)
          if (i + BATCH_SIZE < groups.length) {
            await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS))
          }
        }

        // Final message
        const done = JSON.stringify({
          done: true,
          stats: {
            total_requested: sales.length,
            unique_predictions: groups.length,
            groups_processed: processedGroups,
          }
        }) + '\n'
        controller.enqueue(encoder.encode(done))
        controller.close()
      }
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
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
