'use client'

import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import { useRouter, usePathname } from 'next/navigation'
import {
  type UserProfile,
  type UserPermission,
  type FeatureKey,
  type AccessLevel,
  resolveAccess,
  hasAccess,
  isSuperAdmin,
  getUserAuth,
} from './auth'

interface AuthContextType {
  profile: UserProfile | null
  permissions: UserPermission[]
  loading: boolean
  isSuperAdmin: boolean
  resolveAccess: (feature: FeatureKey) => AccessLevel
  hasAccess: (feature: FeatureKey, requiredLevel: 'view' | 'edit') => boolean
  signOut: () => Promise<void>
  refreshAuth: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [permissions, setPermissions] = useState<UserPermission[]>([])
  const [loading, setLoading] = useState(true)
  const supabase = createClientComponentClient()
  const router = useRouter()
  const pathname = usePathname()

  const loadAuth = useCallback(async () => {
    try {
      const { profile, permissions } = await getUserAuth(supabase)
      setProfile(profile)
      setPermissions(permissions)
    } catch (err) {
      console.error('Failed to load auth:', err)
      setProfile(null)
      setPermissions([])
    } finally {
      setLoading(false)
    }
  }, [supabase])

  useEffect(() => {
    // Skip loading auth on the login and two-factor pages
    if (pathname === '/login' || pathname === '/auth/mfa') {
      setLoading(false)
      return
    }

    loadAuth()

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event) => {
        if (event === 'SIGNED_IN') {
          loadAuth()
        } else if (event === 'SIGNED_OUT') {
          setProfile(null)
          setPermissions([])
        }
      }
    )

    return () => subscription.unsubscribe()
  }, [loadAuth, supabase, pathname])

  const signOut = async () => {
    await supabase.auth.signOut()
    setProfile(null)
    setPermissions([])
    router.push('/login')
    router.refresh()
  }

  const value: AuthContextType = {
    profile,
    permissions,
    loading,
    isSuperAdmin: isSuperAdmin(profile),
    resolveAccess: (feature: FeatureKey) =>
      resolveAccess(profile, permissions, feature),
    hasAccess: (feature: FeatureKey, requiredLevel: 'view' | 'edit') =>
      hasAccess(profile, permissions, feature, requiredLevel),
    signOut,
    refreshAuth: loadAuth,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
