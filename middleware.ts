import { createMiddlewareClient } from '@supabase/auth-helpers-nextjs'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export async function middleware(req: NextRequest) {
  const res = NextResponse.next()

  // If Supabase env vars are missing, pass through without auth checks
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return res
  }

  const supabase = createMiddlewareClient({ req, res })

  // Refresh the session (this handles token refresh via cookies)
  const { data: { session } } = await supabase.auth.getSession()

  const pathname = req.nextUrl.pathname

  // Allow cron endpoints through (they use Bearer token auth)
  if (pathname.startsWith('/api/cron')) {
    return res
  }

  // Allow setup page through (invite link flow)
  if (pathname === '/setup') {
    return res
  }

  // Allow password-reset landing through (recovery link flow)
  if (pathname === '/auth/reset') {
    return res
  }

  // Allow public feed pages and API through (no auth required)
  if (pathname.startsWith('/feed/') || pathname.startsWith('/api/public-feed/')) {
    return res
  }

  // Allow backfill endpoint through (uses service role key internally)
  if (pathname.startsWith('/api/coverage-backfill')) {
    return res
  }

  // Allow public diagnostic endpoint — read-only, no secrets, returns scanner
  // stack state so we can verify config changes without needing CRON_SECRET.
  if (pathname === '/api/coverage-health/diagnostic') {
    return res
  }

  // Allow one-shot Dark Pals backfill — self-locks after first run via
  // service_settings.oneshot_darkpals_backfill_done. Will be removed after
  // we verify parity.
  if (pathname === '/api/coverage-health/oneshot-darkpals') {
    return res
  }

  // Sibling oneshots for the YouTube/Reddit and TikTok phases that didn't
  // complete inside the original 300s Vercel timeout. Each self-locks via
  // its own service_settings flag.
  if (pathname === '/api/coverage-health/oneshot-darkpals-yt') {
    return res
  }
  if (pathname === '/api/coverage-health/oneshot-darkpals-tiktok') {
    return res
  }

  // Raw YouTube Data API debug — returns Google's verbatim error response
  // so we can see why the key returns 0 items even for popular queries.
  if (pathname === '/api/coverage-health/yt-raw') {
    return res
  }

  // Allow SullyGnome collect webhook (called by Apify, no auth)
  if (pathname.startsWith('/api/sullygnome-collect')) {
    return res
  }

  // If no session and not on login page, redirect to login
  if (!session && pathname !== '/login') {
    const loginUrl = req.nextUrl.clone()
    loginUrl.pathname = '/login'
    return NextResponse.redirect(loginUrl)
  }

  // If session exists and on login page, redirect to dashboard
  if (session && pathname === '/login') {
    const dashboardUrl = req.nextUrl.clone()
    dashboardUrl.pathname = '/'
    return NextResponse.redirect(dashboardUrl)
  }

  return res
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     * - public assets (svg, png, jpg, etc.)
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}
