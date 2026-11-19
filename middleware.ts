import { createMiddlewareClient } from '@supabase/auth-helpers-nextjs'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getAal, isMfaEnforced } from '@/lib/mfa'
import { enforceApiAccess } from '@/lib/access-context'

// The auth cookie is readable by the browser, so a cookie alone proves
// nothing. Confirm the access token with the auth server, and remember
// the answer briefly so every request does not pay a round trip.
const TOKEN_TTL_MS = 60_000
const validTokens = new Map<string, number>()

async function isValidToken(
  supabase: ReturnType<typeof createMiddlewareClient>,
  token: string
): Promise<boolean> {
  const now = Date.now()
  const until = validTokens.get(token)
  if (until && until > now) return true

  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return false

  if (validTokens.size > 500) validTokens.clear()
  validTokens.set(token, now + TOKEN_TTL_MS)
  return true
}

export async function middleware(req: NextRequest) {
  const res = NextResponse.next()

  // If Supabase env vars are missing, pass through without auth checks
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return res
  }

  const supabase = createMiddlewareClient({ req, res })

  // Refresh the session (this handles token refresh via cookies)
  const { data: { session: cookieSession } } = await supabase.auth.getSession()

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

  // These two are called server to server (game creation, onboarding cron)
  // without a browser session, so the middleware lets them through. Each
  // route checks for itself: `Authorization: Bearer CRON_SECRET` or a signed
  // in user (see lib/api-auth.ts requireCronOrUser).
  if (
    pathname.startsWith('/api/coverage-backfill') ||
    pathname === '/api/coverage-health/forced-historical-scan'
  ) {
    return res
  }

  // Allow SullyGnome collect webhook (called by Apify). The route verifies a
  // signature in the URL (lib/webhook-sig.ts), so it needs no session.
  if (pathname.startsWith('/api/sullygnome-collect')) {
    return res
  }

  const session =
    cookieSession && (await isValidToken(supabase, cookieSession.access_token))
      ? cookieSession
      : null

  // Signed in with a password only: everything except the login and
  // two-factor pages is closed until the second factor is verified.
  if (session && isMfaEnforced() && getAal(session.access_token) !== 'aal2') {
    if (pathname === '/auth/mfa' || pathname === '/login') {
      return res
    }
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: 'Two-factor authentication required', code: 'mfa_required' },
        { status: 401 }
      )
    }
    const mfaUrl = req.nextUrl.clone()
    mfaUrl.pathname = '/auth/mfa'
    mfaUrl.search = ''
    return NextResponse.redirect(mfaUrl)
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

  // API routes: a session only proves someone is signed in. Check what this
  // user may do (feature access, read versus write, client restrictions).
  // The policy lives in lib/access-policy.ts.
  if (session && pathname.startsWith('/api/')) {
    const blocked = await enforceApiAccess(req, session.user.id)
    if (blocked) return blocked
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
