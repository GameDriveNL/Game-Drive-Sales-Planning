import { NextResponse } from 'next/server'
import { checkSteamFinancialKey } from '@/lib/steam-key-check'

// POST { publisher_key } — classify a Steam key BEFORE it is saved.
// Distinguishes "Steam doesn't know this key" from "known key, no Financial permission".
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const check = await checkSteamFinancialKey(body?.publisher_key)
    return NextResponse.json(check)
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to validate key: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    )
  }
}
