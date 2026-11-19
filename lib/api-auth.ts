/**
 * Server side authorization for API route handlers.
 *
 * The middleware only proves that SOME user is signed in. Roles and feature
 * permissions used to be enforced in the browser only, so any signed in
 * account could call a route directly. These helpers make a route check who
 * is calling, using the same rules as the UI (lib/auth.ts resolveAccess).
 *
 * Usage:
 *   const auth = await requireFeature('api_settings', 'edit')
 *   if (auth instanceof NextResponse) return auth
 *
 * For routes that machines call as well as people (a server to server fetch
 * or a cron), use requireCronOr...(request, ...) which also accepts
 * `Authorization: Bearer <CRON_SECRET>`.
 */
import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { getServerSupabase } from '@/lib/supabase'
import { getAal, isMfaEnforced } from '@/lib/mfa'
import {
  hasAccess,
  type FeatureKey,
  type UserPermission,
  type UserProfile,
} from '@/lib/auth'

export interface Caller {
  userId: string
  profile: UserProfile
  permissions: UserPermission[]
}

type HeaderSource = { headers: { get: (name: string) => string | null } }

const unauthorized = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
const forbidden = () => NextResponse.json({ error: 'Forbidden' }, { status: 403 })

/** Resolves the signed in, active, two-factor verified user, or null. */
export async function getCaller(): Promise<Caller | null> {
  const supabase = createRouteHandlerClient({ cookies })
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  // A password only session never counts once two-factor is on
  if (isMfaEnforced()) {
    const { data: { session } } = await supabase.auth.getSession()
    if (getAal(session?.access_token) !== 'aal2') return null
  }

  const admin = getServerSupabase()
  const [profileRes, permsRes] = await Promise.all([
    admin.from('user_profiles').select('*').eq('id', user.id).single(),
    admin.from('user_permissions').select('*').eq('user_id', user.id),
  ])
  const profile = profileRes.data as UserProfile | null
  if (!profile || !profile.is_active) return null

  return {
    userId: user.id,
    profile,
    permissions: (permsRes.data as UserPermission[]) || [],
  }
}

/** True when the request carries `Authorization: Bearer <CRON_SECRET>`. */
export function hasValidCronSecret(request: HeaderSource): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const header = request.headers.get('authorization') || ''
  const expected = `Bearer ${secret}`
  const a = Buffer.from(header)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Any active, two-factor verified user. */
export async function requireUser(): Promise<Caller | NextResponse> {
  const caller = await getCaller()
  return caller ?? unauthorized()
}

/** Superadmins only. */
export async function requireSuperAdmin(): Promise<Caller | NextResponse> {
  const caller = await getCaller()
  if (!caller) return unauthorized()
  return caller.profile.role === 'superadmin' ? caller : forbidden()
}

/** A user who holds at least `level` on `feature` (same rules as the UI). */
export async function requireFeature(
  feature: FeatureKey,
  level: 'view' | 'edit'
): Promise<Caller | NextResponse> {
  const caller = await getCaller()
  if (!caller) return unauthorized()
  return hasAccess(caller.profile, caller.permissions, feature, level) ? caller : forbidden()
}

/** Cron secret, or any active user. Returns null when the caller is the cron. */
export async function requireCronOrUser(
  request: HeaderSource
): Promise<Caller | NextResponse | null> {
  if (hasValidCronSecret(request)) return null
  return requireUser()
}

/** Cron secret, or a superadmin. Returns null when the caller is the cron. */
export async function requireCronOrSuperAdmin(
  request: HeaderSource
): Promise<Caller | NextResponse | null> {
  if (hasValidCronSecret(request)) return null
  return requireSuperAdmin()
}

/** Cron secret, or a user with the feature. Returns null for the cron. */
export async function requireCronOrFeature(
  request: HeaderSource,
  feature: FeatureKey,
  level: 'view' | 'edit'
): Promise<Caller | NextResponse | null> {
  if (hasValidCronSecret(request)) return null
  return requireFeature(feature, level)
}

/** Headers for server to server calls into routes guarded by the cron secret. */
export function cronAuthHeaders(): Record<string, string> {
  const secret = process.env.CRON_SECRET
  return secret ? { Authorization: `Bearer ${secret}` } : {}
}
