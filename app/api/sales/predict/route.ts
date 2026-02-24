import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { computePrediction } from '@/lib/prediction-engine'
import { getGeminiConfig } from '@/lib/gemini-config'

// POST /api/sales/predict — AI-powered revenue prediction for a planned sale
export async function POST(request: NextRequest) {
  const supabase = getServerSupabase()

  try {
    const body = await request.json()
    const { product_id, platform_id, client_id, discount_percentage, duration_days, start_date, goal_type } = body

    if (!product_id || !platform_id || !client_id) {
      return NextResponse.json({ error: 'product_id, platform_id, and client_id are required' }, { status: 400 })
    }

    // Get Gemini config (API key + model)
    const gemini = await getGeminiConfig(supabase)

    const result = await computePrediction(
      { product_id, platform_id, client_id, discount_percentage, duration_days, start_date, goal_type },
      supabase,
      gemini?.apiKey,
      gemini?.modelId
    )

    return NextResponse.json(result)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
