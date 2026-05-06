/**
 * Cron endpoint authentication.
 *
 * FAILS CLOSED. The previous pattern was:
 *
 *   const cronSecret = process.env.CRON_SECRET
 *   if (cronSecret && authHeader !== `Bearer ${cronSecret}`) { return 401 }
 *
 * — which silently skipped the entire auth check when CRON_SECRET was unset.
 * Combined with CRON_SECRET being missing from .env.vercel in May 2026, every
 * cron scanner endpoint was publicly accessible. An attacker hitting the URL
 * could trigger Apify scans on demand and burn credits. That contributed to
 * the cost-overrun blast radius.
 */
import { NextResponse } from 'next/server'

// Accepts either NextRequest or the web-standard Request — both have
// .headers.get(), which is all this function needs.
export function verifyCronAuth(request: { headers: { get: (n: string) => string | null } }): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.error('[cron-auth] CRON_SECRET env var not configured — failing closed')
    return NextResponse.json(
      { error: 'Server not configured' },
      { status: 500 }
    )
  }
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}
