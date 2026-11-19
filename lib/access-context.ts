/**
 * Loads what a signed in user may do, and enforces lib/access-policy.ts.
 * Runs in the middleware (Edge runtime), so it only uses fetch.
 *
 * Reads user_profiles, user_permissions and user_clients through the
 * Supabase REST API with the service role key, and caches the answer for a
 * minute per user so requests do not each pay a round trip. Role changes
 * therefore take effect within about 60 seconds.
 */
import { NextRequest, NextResponse } from 'next/server'
import { hasAccess, type UserPermission, type UserProfile } from '@/lib/auth'
import { findPolicy, type PolicyFeature } from '@/lib/access-policy'

interface AccessContext {
  profile: Pick<UserProfile, 'role' | 'is_active' | 'all_clients'> | null
  permissions: UserPermission[]
  clientIds: Set<string>
}

const CONTEXT_TTL_MS = 60_000
const GAME_TTL_MS = 5 * 60_000
const contextCache = new Map<string, { at: number; value: AccessContext }>()
const gameClientCache = new Map<string, { at: number; clientId: string | null }>()

const MAX_BODY_BYTES = 1_000_000

async function rest<T>(path: string): Promise<T> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase service role not configured')
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`Supabase REST ${res.status}`)
  return res.json() as Promise<T>
}

async function loadContext(userId: string): Promise<AccessContext> {
  const hit = contextCache.get(userId)
  if (hit && Date.now() - hit.at < CONTEXT_TTL_MS) return hit.value

  const id = encodeURIComponent(userId)
  const [profiles, permissions, clients] = await Promise.all([
    rest<AccessContext['profile'][]>(`user_profiles?id=eq.${id}&select=role,is_active,all_clients`),
    rest<UserPermission[]>(`user_permissions?user_id=eq.${id}&select=feature,access_level`),
    rest<{ client_id: string }[]>(`user_clients?user_id=eq.${id}&select=client_id`),
  ])

  const value: AccessContext = {
    profile: profiles[0] ?? null,
    permissions,
    clientIds: new Set(clients.map((c) => c.client_id)),
  }
  if (contextCache.size > 500) contextCache.clear()
  contextCache.set(userId, { at: Date.now(), value })
  return value
}

async function clientIdForGame(gameId: string): Promise<string | null> {
  const hit = gameClientCache.get(gameId)
  if (hit && Date.now() - hit.at < GAME_TTL_MS) return hit.clientId
  const rows = await rest<{ client_id: string }[]>(
    `games?id=eq.${encodeURIComponent(gameId)}&select=client_id`
  )
  const clientId = rows[0]?.client_id ?? null
  if (gameClientCache.size > 2000) gameClientCache.clear()
  gameClientCache.set(gameId, { at: Date.now(), clientId })
  return clientId
}

const deny = (status: number, error: string, code: string) =>
  NextResponse.json({ error, code }, { status })

function featureAllowed(
  ctx: AccessContext,
  feature: PolicyFeature,
  level: 'view' | 'edit'
): boolean {
  if (!ctx.profile) return false
  if (feature === 'superadmin') return ctx.profile.role === 'superadmin'
  if (feature === 'any') return true
  return hasAccess(ctx.profile as UserProfile, ctx.permissions, feature, level)
}

function collectIds(source: unknown, clients: Set<string>, games: Set<string>) {
  if (!source || typeof source !== 'object') return
  const obj = source as Record<string, unknown>
  const add = (set: Set<string>, v: unknown) => {
    if (typeof v === 'string' && v) set.add(v)
    else if (Array.isArray(v)) v.forEach((x) => typeof x === 'string' && x && set.add(x))
  }
  for (const k of ['client_id', 'clientId', 'client_ids']) add(clients, obj[k])
  for (const k of ['game_id', 'gameId', 'game_ids']) add(games, obj[k])
}

/**
 * Returns a response to stop the request, or null to let it through.
 * Call only for signed in, two-factor verified users on /api paths.
 */
export async function enforceApiAccess(
  req: NextRequest,
  userId: string
): Promise<NextResponse | null> {
  const policy = findPolicy(req.nextUrl.pathname)

  let ctx: AccessContext
  try {
    ctx = await loadContext(userId)
  } catch (err) {
    console.error('[access] could not load user access:', err)
    return deny(503, 'Access check unavailable', 'access_unavailable')
  }

  if (!ctx.profile || !ctx.profile.is_active) {
    return deny(403, 'Account is not active', 'inactive')
  }
  // Superadmins manage users and clients, so they are never client restricted
  if (ctx.profile.role === 'superadmin') return null

  // Not listed: superadmin only until someone adds it to access-policy.ts
  if (!policy) {
    return deny(403, 'This route is not in the access policy', 'no_policy')
  }

  const method = req.method.toUpperCase()
  const isRead =
    method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ||
    (policy.readPost === true && method === 'POST')
  const feature = isRead ? policy.read : policy.write
  if (!featureAllowed(ctx, feature, isRead ? 'view' : 'edit')) {
    return deny(403, 'You do not have access to this', 'forbidden')
  }

  // Client restrictions only apply to users without all_clients
  if (ctx.profile.all_clients) return null

  const scope = policy.scope
  if (scope === 'shared') return null
  if (scope === 'unrestricted') {
    return deny(403, 'Not available for client restricted accounts', 'client_restricted')
  }
  if (scope === 'filtered' && (method === 'GET' || method === 'HEAD')) return null

  // scope is `client` (or `filtered` with a write): the request must name
  // clients or games the user may access.
  const clientIds = new Set<string>()
  const gameIds = new Set<string>()
  collectIds(Object.fromEntries(req.nextUrl.searchParams), clientIds, gameIds)

  if (method !== 'GET' && method !== 'HEAD') {
    const type = req.headers.get('content-type') || ''
    const length = Number(req.headers.get('content-length') || 0)
    if (type.includes('application/json')) {
      if (length > MAX_BODY_BYTES) {
        return deny(413, 'Request too large to check', 'too_large')
      }
      try {
        collectIds(await req.clone().json(), clientIds, gameIds)
      } catch {
        // No readable body: only the query string names ids
      }
    }
  }

  try {
    for (const gameId of Array.from(gameIds)) {
      const clientId = await clientIdForGame(gameId)
      if (!clientId) return deny(404, 'Game not found', 'not_found')
      clientIds.add(clientId)
    }
  } catch (err) {
    console.error('[access] could not resolve game:', err)
    return deny(503, 'Access check unavailable', 'access_unavailable')
  }

  if (clientIds.size === 0) {
    return deny(403, 'A client_id or game_id you can access is required', 'client_required')
  }
  for (const id of Array.from(clientIds)) {
    if (!ctx.clientIds.has(id)) {
      return deny(403, 'You do not have access to this client', 'client_forbidden')
    }
  }
  return null
}
