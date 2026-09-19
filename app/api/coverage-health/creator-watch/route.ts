/**
 * POST /api/coverage-health/creator-watch
 *
 * Scans YouTube channels in the creator_watch table for recent videos that
 * mention any of the game's keywords. Uses the free YouTube Data API v3
 * (search.list with channelId filter) — 100 units per creator scan.
 *
 * Body (JSON):
 *   { game_id?: string, creator_id?: string, days_lookback?: number }
 *
 * - game_id only: scan all enabled creators for that game
 * - creator_id only: scan a specific creator
 * - no params: scan all enabled creators (max 5 per call to avoid Vercel timeout)
 *
 * Scan logic lives in lib/creator-watch-scan.ts, shared with the cron at
 * app/api/cron/creator-watch-scan/route.ts so both entry points stay in sync.
 */

import { NextRequest, NextResponse } from 'next/server'
import { runCreatorWatchScan } from '@/lib/creator-watch-scan'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}))
  const result = await runCreatorWatchScan(body)

  if ('error' in result) {
    return NextResponse.json(result, { status: 400 })
  }
  return NextResponse.json(result)
}
