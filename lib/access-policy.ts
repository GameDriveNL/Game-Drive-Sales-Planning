/**
 * API access policy: which feature each /api route belongs to, who may read
 * or write it, and how client restrictions apply.
 *
 * Enforced centrally in middleware.ts (see lib/access-context.ts), so a new
 * route cannot ship open by accident: a route that is not listed here is
 * superadmin only until someone adds it.
 *
 * Edge safe: no Node APIs.
 */
import type { FeatureKey } from '@/lib/auth'

/** 'any' = every active user. 'superadmin' = superadmins only. */
export type PolicyFeature = FeatureKey | 'any' | 'superadmin'

/**
 * How client restrictions (user_clients) apply to users who do not have
 * all_clients:
 *  - client:       must name a client_id or game_id they may access
 *  - shared:       not client specific data, allowed
 *  - filtered:     the route filters its own list (reads); writes act as `client`
 *  - unrestricted: cross client data, denied to restricted users
 */
export type PolicyScope = 'client' | 'shared' | 'filtered' | 'unrestricted'

export interface RoutePolicy {
  /** Needed for GET and HEAD (at least view access). */
  read: PolicyFeature
  /** Needed for every other method (edit access). */
  write: PolicyFeature
  scope: PolicyScope
  /** POST routes that only compute or generate (no stored changes): read access is enough. */
  readPost?: boolean
}

const p = (
  read: PolicyFeature,
  write: PolicyFeature,
  scope: PolicyScope,
  readPost = false
): RoutePolicy => ({ read, write, scope, readPost })

// Keys are paths after /api/. The longest matching prefix wins.
export const ROUTE_POLICIES: Record<string, RoutePolicy> = {
  // People and settings
  'admin/users': p('superadmin', 'superadmin', 'unrestricted'), // route also checks itself
  'clients': p('any', 'client_management', 'filtered'),
  'games': p('any', 'client_management', 'filtered'),
  'products': p('any', 'client_management', 'client'),
  'platforms': p('any', 'platform_settings', 'shared'),
  'platform-events': p('sales_timeline', 'sales_timeline', 'shared'),
  'steam-api-keys/validate': p('api_settings', 'api_settings', 'shared', true),
  'steam-api-keys': p('api_settings', 'api_settings', 'unrestricted'),
  'playstation-api-keys': p('api_settings', 'api_settings', 'unrestricted'),
  'service-api-keys': p('any', 'api_settings', 'shared'),
  'steam-connections': p('api_settings', 'api_settings', 'unrestricted'),
  'sync-health': p('api_settings', 'api_settings', 'unrestricted'),
  'usage': p('api_settings', 'api_settings', 'unrestricted'),
  'steam-sync': p('api_settings', 'api_settings', 'client'),
  'playstation-sync': p('api_settings', 'api_settings', 'client'),
  'product-matching': p('api_settings', 'api_settings', 'client'),

  // Sales and analytics
  'planning': p('sales_timeline', 'sales_timeline', 'client'),
  'sales/predict-batch': p('sales_timeline', 'sales_timeline', 'client', true),
  'sales/predict': p('sales_timeline', 'sales_timeline', 'client', true),
  'sales/validate': p('sales_timeline', 'sales_timeline', 'shared', true),
  'dashboard': p('analytics', 'analytics', 'client'),
  'forecast': p('analytics', 'analytics', 'client'),
  'reports': p('analytics', 'analytics', 'client'),
  'steam-wishlists': p('analytics', 'analytics', 'client'),
  'steam-bundles': p('analytics', 'analytics', 'client'),

  // PR coverage
  'backfill': p('pr_coverage', 'pr_coverage', 'unrestricted'),
  'campaign-attributions': p('pr_coverage', 'pr_coverage', 'client'),
  'competitor-games': p('pr_coverage', 'pr_coverage', 'client'),
  'competitor-scan': p('pr_coverage', 'pr_coverage', 'client'),
  'correlation-candidates': p('pr_coverage', 'pr_coverage', 'client'),
  'coverage-digest': p('pr_coverage', 'pr_coverage', 'client'),
  'coverage-enrich': p('pr_coverage', 'pr_coverage', 'client'),
  'coverage-export': p('pr_coverage', 'pr_coverage', 'client'),
  'coverage-items': p('pr_coverage', 'pr_coverage', 'client'),
  'coverage-keywords': p('pr_coverage', 'pr_coverage', 'client'),
  'coverage-sources': p('pr_coverage', 'pr_coverage', 'client'),
  'coverage-timeline': p('pr_coverage', 'pr_coverage', 'client'),
  'coverage-platform-stats': p('pr_coverage', 'pr_coverage', 'unrestricted'),
  'coverage/reception': p('pr_coverage', 'pr_coverage', 'client'),
  'coverage-health/scanner-health': p('pr_coverage', 'pr_coverage', 'shared'),
  'coverage-health/creator-watch': p('pr_coverage', 'pr_coverage', 'client'),
  'coverage-health/diagnostic': p('superadmin', 'superadmin', 'unrestricted'),
  'coverage-health/audit-youtube': p('superadmin', 'superadmin', 'unrestricted'),
  'coverage-health/audit-tiktok': p('superadmin', 'superadmin', 'unrestricted'),
  'coverage-health/noise-backfill': p('superadmin', 'superadmin', 'unrestricted'),
  'coverage-health': p('pr_coverage', 'pr_coverage', 'unrestricted'),
  'creator-watch': p('pr_coverage', 'pr_coverage', 'client'),
  'discord-webhooks': p('pr_coverage', 'pr_coverage', 'client'),
  'hypestat': p('pr_coverage', 'pr_coverage', 'shared'),
  'outlets': p('pr_coverage', 'pr_coverage', 'shared'),
  'pr-annotations': p('pr_coverage', 'pr_coverage', 'client'),
  'pr-insights': p('pr_coverage', 'pr_coverage', 'client'),
  'rss-scan': p('pr_coverage', 'pr_coverage', 'client'),
  'tavily-scan': p('pr_coverage', 'pr_coverage', 'client'),
  'sullygnome-import': p('pr_coverage', 'pr_coverage', 'client'),

  // Open to every signed in user
  'chatbot': p('any', 'any', 'shared', true),
  'feedback': p('any', 'any', 'shared'),
  'social-caption': p('any', 'any', 'shared', true),
  'trend-watch': p('any', 'any', 'shared', true),
}

/** Longest matching policy for a path like `/api/coverage-items`, or null. */
export function findPolicy(pathname: string): RoutePolicy | null {
  const rel = pathname.replace(/^\/api\//, '').replace(/\/+$/, '')
  let best: string | null = null
  for (const key of Object.keys(ROUTE_POLICIES)) {
    if ((rel === key || rel.startsWith(key + '/')) && (!best || key.length > best.length)) {
      best = key
    }
  }
  return best ? ROUTE_POLICIES[best] : null
}
