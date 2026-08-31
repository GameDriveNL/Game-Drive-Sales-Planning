import { SupabaseClient } from '@supabase/supabase-js'

// --- Types ---

export type Role = 'superadmin' | 'editor' | 'viewer'
export type AccessLevel = 'none' | 'view' | 'edit'

export type FeatureKey =
  | 'sales_timeline'
  | 'analytics'
  | 'client_management'
  | 'platform_settings'
  | 'export'
  | 'api_settings'
  | 'pr_coverage'

export interface UserProfile {
  id: string
  email: string
  display_name: string | null
  role: Role
  is_active: boolean
  all_clients: boolean
  created_at: string
  updated_at: string
}

export interface UserPermission {
  id: string
  user_id: string
  feature: string
  access_level: AccessLevel
}

export interface AuthState {
  profile: UserProfile | null
  permissions: UserPermission[]
  loading: boolean
}

// --- Feature metadata (for admin UI) ---

export const FEATURES: { key: FeatureKey; label: string; description: string }[] = [
  { key: 'sales_timeline', label: 'Sales Timeline', description: 'Gantt chart and sales management' },
  { key: 'analytics', label: 'Analytics', description: 'Performance metrics and dashboards' },
  { key: 'client_management', label: 'Client Management', description: 'Manage game clients' },
  { key: 'platform_settings', label: 'Platform Settings', description: 'Configure platform rules' },
  { key: 'export', label: 'Excel Export', description: 'Download reports' },
  { key: 'api_settings', label: 'API Settings', description: 'Steam API keys and sync' },
  { key: 'pr_coverage', label: 'PR Coverage', description: 'Media outlet tracking and coverage' },
]

// --- Helpers ---

export function isSuperAdmin(profile: UserProfile | null): boolean {
  return profile?.role === 'superadmin'
}

/**
 * Resolve the effective access level for a feature.
 * Priority: superadmin override > specific permission > base role fallback
 */
export function resolveAccess(
  profile: UserProfile | null,
  permissions: UserPermission[],
  feature: FeatureKey
): AccessLevel {
  if (!profile || !profile.is_active) return 'none'

  // Superadmins always have full access
  if (profile.role === 'superadmin') return 'edit'

  // Check for specific feature permission
  const perm = permissions.find((p) => p.feature === feature)
  if (perm) return perm.access_level

  // Fall back to base role
  if (profile.role === 'editor') return 'edit'
  if (profile.role === 'viewer') return 'view'

  return 'none'
}

/**
 * Check if user has at least the required access level for a feature.
 */
export function hasAccess(
  profile: UserProfile | null,
  permissions: UserPermission[],
  feature: FeatureKey,
  requiredLevel: 'view' | 'edit'
): boolean {
  const level = resolveAccess(profile, permissions, feature)
  if (requiredLevel === 'view') return level === 'view' || level === 'edit'
  if (requiredLevel === 'edit') return level === 'edit'
  return false
}

/**
 * Fetch the current user's profile and permissions from Supabase.
 */
export async function getUserAuth(supabase: SupabaseClient): Promise<{
  profile: UserProfile | null
  permissions: UserPermission[]
}> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { profile: null, permissions: [] }

  const [profileRes, permissionsRes] = await Promise.all([
    supabase.from('user_profiles').select('*').eq('id', user.id).single(),
    supabase.from('user_permissions').select('*').eq('user_id', user.id),
  ])

  return {
    profile: profileRes.data as UserProfile | null,
    permissions: (permissionsRes.data as UserPermission[]) || [],
  }
}

/**
 * Map route paths to feature keys for sidebar visibility.
 */
export const ROUTE_FEATURE_MAP: Record<string, FeatureKey> = {
  '/': 'analytics',
  '/timeline': 'sales_timeline',
  '/planning': 'sales_timeline',
  '/analytics': 'analytics',
  '/coverage': 'pr_coverage',
  '/coverage/keywords': 'pr_coverage',
  '/coverage/sources': 'pr_coverage',
  '/coverage/feed': 'pr_coverage',
  '/coverage/dashboard': 'pr_coverage',
  '/coverage/report': 'pr_coverage',
  '/coverage/timeline': 'pr_coverage',
  '/reports': 'analytics',
  // Settings sub-routes
  '/settings': 'api_settings',
  '/settings/client-keys': 'api_settings',
  '/settings/system-keys': 'api_settings',
  '/settings/clients': 'client_management',
  '/settings/platforms': 'platform_settings',
  // Note: /settings/users is superadmin-only, not feature-gated
}
