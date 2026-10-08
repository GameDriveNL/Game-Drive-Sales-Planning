// Helpers for Supabase TOTP two-factor authentication.
// Edge-safe (used by middleware.ts): no Node-only APIs.

/** Reads the `aal` (authenticator assurance level) claim from an access token. */
export function getAal(accessToken: string | undefined | null): 'aal1' | 'aal2' | null {
  if (!accessToken) return null
  try {
    const payload = accessToken.split('.')[1]
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const aal = JSON.parse(json).aal
    return aal === 'aal1' || aal === 'aal2' ? aal : null
  } catch {
    return null
  }
}

/**
 * Two-factor is on for every account. Emergency switch: set
 * MFA_ENFORCEMENT_DISABLED=true in the environment to turn the redirect
 * off (e.g. if the auth provider's MFA endpoints are down).
 */
export function isMfaEnforced(): boolean {
  return process.env.MFA_ENFORCEMENT_DISABLED !== 'true'
}
