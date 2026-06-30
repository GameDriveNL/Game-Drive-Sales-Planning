/**
 * POST /api/social-caption
 *
 * Generates social media captions for a game using Gemini Flash.
 * Body: { game_name, platform, objective, tone, extra_context? }
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 30

const GEMINI_MODEL = 'gemini-1.5-flash'

const PLATFORM_LIMITS: Record<string, number> = {
  twitter: 280,
  instagram: 2200,
  tiktok: 2200,
  reddit: 10000,
  facebook: 500,
  linkedin: 700,
}

const PLATFORM_HASHTAG_TIPS: Record<string, string> = {
  twitter: '2-3 hashtags max',
  instagram: '5-10 hashtags, mix niche + broad',
  tiktok: '3-5 hashtags, trending + niche',
  reddit: 'No hashtags — use markdown links',
  facebook: '1-2 hashtags optional',
  linkedin: '3-5 professional hashtags',
}

const BEST_TIMES: Record<string, string> = {
  twitter: 'Tue/Wed/Thu 9-11am or 7-9pm',
  instagram: 'Mon/Wed/Fri 11am-1pm or 7-9pm',
  tiktok: 'Tue/Thu/Fri 7-9pm, Sat 11am-1pm',
  reddit: 'Mon-Fri 8-10am or 12-2pm',
  facebook: 'Wed 11am-1pm, Thu-Fri 1-4pm',
  linkedin: 'Tue-Thu 8-10am',
}

export async function POST(request: NextRequest) {
  const supabase = getServerSupabase()
  const body = await request.json()
  const { game_name, platform, objective, tone, extra_context } = body

  if (!game_name || !platform || !objective) {
    return NextResponse.json({ error: 'game_name, platform, and objective are required' }, { status: 400 })
  }

  const { data: keyData } = await supabase
    .from('service_api_keys')
    .select('api_key')
    .eq('service_name', 'gemini')
    .eq('is_active', true)
    .maybeSingle()

  const apiKey = keyData?.api_key || process.env.GOOGLE_AI_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'Gemini API key not configured' }, { status: 400 })
  }

  const charLimit = PLATFORM_LIMITS[platform] || 500
  const hashtagTip = PLATFORM_HASHTAG_TIPS[platform] || '3-5 hashtags'
  const bestTime = BEST_TIMES[platform] || 'varies'

  const prompt = `You are a social media expert for indie game marketing. Write 3 distinct caption variations for the following game and platform.

Game: ${game_name}
Platform: ${platform}
Objective: ${objective}
Tone: ${tone || 'engaging and authentic'}
Character limit: ${charLimit}
Hashtag guidance: ${hashtagTip}
${extra_context ? `Additional context: ${extra_context}` : ''}

For each variation, provide:
1. The caption text (under ${charLimit} chars, include appropriate hashtags for ${platform})
2. A one-line explanation of the angle/approach

Format your response as JSON with this structure:
{
  "captions": [
    { "text": "...", "angle": "...", "char_count": 123 },
    { "text": "...", "angle": "...", "char_count": 456 },
    { "text": "...", "angle": "...", "char_count": 789 }
  ]
}`

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.8, maxOutputTokens: 1024, responseMimeType: 'application/json' },
        }),
      }
    )

    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: `Gemini error: ${err.substring(0, 200)}` }, { status: 500 })
    }

    const data = await res.json()
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}'
    let parsed: { captions: Array<{ text: string; angle: string; char_count: number }> }
    try {
      parsed = JSON.parse(text)
    } catch {
      return NextResponse.json({ error: 'Failed to parse Gemini response' }, { status: 500 })
    }

    return NextResponse.json({
      captions: parsed.captions || [],
      best_time: bestTime,
      hashtag_tip: hashtagTip,
      char_limit: charLimit,
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 })
  }
}
