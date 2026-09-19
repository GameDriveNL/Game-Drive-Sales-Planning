/**
 * GET /api/cron/creator-watch-scan
 *
 * Creator Watch (lib/creator-watch-scan.ts) existed only as a manual "Scan"
 * button — nothing ran it automatically, so tracked creators only got
 * checked when someone remembered to click it. This cron closes that gap.
 *
 * Each run scans the 5 most-overdue enabled creators (oldest last_checked_at
 * first), so repeated runs naturally rotate through the full list. See
 * feedback card f148f4fb.
 *
 * Auth: same Bearer CRON_SECRET as the other scanners.
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyCronAuth } from '@/lib/cron-auth'
import { runCreatorWatchScan } from '@/lib/creator-watch-scan'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request)
  if (authError) return authError

  const result = await runCreatorWatchScan({})

  if ('error' in result) {
    console.error('[creator-watch-scan] ' + result.error)
    return NextResponse.json(result, { status: 400 })
  }
  return NextResponse.json(result)
}
