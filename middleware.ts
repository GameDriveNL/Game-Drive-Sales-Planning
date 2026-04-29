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
