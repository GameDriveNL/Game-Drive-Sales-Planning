'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import { useAuth } from '@/lib/auth-context'
import type { FeatureKey } from '@/lib/auth'
import styles from './Sidebar.module.css'

const STORAGE_KEY = 'gamedrive-sidebar-collapsed'

interface PlatformData {
  name: string
  color_hex: string
  cooldown_days: number
}

export function Sidebar() {
  const pathname = usePathname()
  const { profile, loading, isSuperAdmin, hasAccess, signOut } = useAuth()
  const [collapsed, setCollapsed] = useState(false)
  const [platformsData, setPlatformsData] = useState<PlatformData[]>([])

  // Hydrate collapsed state from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored === 'true') setCollapsed(true)
    } catch {}
  }, [])

  // Fetch platforms from database instead of hardcoding
  useEffect(() => {
    const supabase = createClientComponentClient()
    supabase
      .from('platforms')
      .select('name, color_hex, cooldown_days')
      .order('name')
      .then(({ data }) => {
        if (data) setPlatformsData(data)
      })
  }, [])

  const toggleCollapse = () => {
    const next = !collapsed
    setCollapsed(next)
    try { localStorage.setItem(STORAGE_KEY, String(next)) } catch {}
  }

  const navItems: { name: string; href: string; icon: React.ReactNode; description: string; feature: FeatureKey }[] = [
    {
      name: 'Dashboard',
      href: '/dashboard',
      feature: 'analytics',
      icon: (
        <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
        </svg>
      ),
      description: 'Client overview'
    },
    {
      name: 'Sales Timeline',
      href: '/',
      feature: 'sales_timeline',
      icon: (
        <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
      ),
      description: 'Interactive Gantt chart'
    },
    {
      name: 'Analytics',
      href: '/analytics',
      feature: 'analytics',
      icon: (
        <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 8v8m-4-5v5m-4-2v2m-2 4h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      ),
      description: 'Performance metrics'
    },
    {
      name: 'PR Coverage',
      href: '/coverage/feed',
      feature: 'pr_coverage',
      icon: (
        <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z" />
        </svg>
      ),
      description: 'Media coverage tracking'
    },
    {
      name: 'Reports',
      href: '/reports',
      feature: 'analytics',
      icon: (
        <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      ),
      description: 'Client report builder'
    },
  ]

  const visibleNavItems = navItems.filter((item) =>
    hasAccess(item.feature, 'view')
  )

  const canSeeSettings =
    hasAccess('api_settings', 'view') ||
    hasAccess('client_management', 'view') ||
    hasAccess('platform_settings', 'view') ||
    isSuperAdmin

  const isSettingsActive = pathname.startsWith('/settings')

  const platforms = platformsData.map(p => ({
    name: p.name,
    color: p.color_hex,
    cooldown: `${p.cooldown_days}d`
  }))

  const userInitial = profile
    ? (profile.display_name || profile.email || '?').charAt(0).toUpperCase()
    : '?'

  return (
    <div className={collapsed ? styles.sidebarWrapperCollapsed : styles.sidebarWrapper}>
      <div className={collapsed ? styles.sidebarCollapsed : styles.sidebar}>
        {/* Collapse toggle */}
        <button
          onClick={toggleCollapse}
          className={collapsed ? styles.collapseButton : styles.collapseButtonExpanded}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
            <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
            </svg>
          ) : (
            <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M11 19l-7-7 7-7M19 19l-7-7 7-7" />
            </svg>
          )}
        </button>

        {/* Main navigation */}
        <nav className={collapsed ? styles.navCollapsed : styles.nav}>
          {visibleNavItems.map((item) => {
            // For coverage, match all /coverage/* routes
            const matchPath = item.href === '/coverage/feed' ? '/coverage' : item.href
            const isActive = matchPath === '/'
              ? pathname === '/'
              : pathname.startsWith(matchPath)

            if (collapsed) {
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={isActive ? styles.navItemCollapsedActive : styles.navItemCollapsed}
                  title={item.name}
                >
                  <div className={styles.navIconCollapsed}>
                    {item.icon}
                  </div>
                  <span className={styles.tooltip}>{item.name}</span>
                </Link>
              )
            }

            return (
              <Link
                key={item.name}
                href={item.href}
                className={isActive ? styles.navItemActive : styles.navItem}
              >
                <div className={styles.navIcon}>
                  {item.icon}
                </div>
                <div className={styles.navText}>
                  <div className={styles.navLabel}>{item.name}</div>
                  <div className={styles.navDescription}>
                    {item.description}
                  </div>
                </div>
              </Link>
            )
          })}
        </nav>

        {/* Settings — bottom pinned */}
        {canSeeSettings && (
          <div className={collapsed ? styles.settingsSectionCollapsed : styles.settingsSection}>
            {collapsed ? (
              <Link
                href="/settings"
                className={isSettingsActive ? styles.navItemCollapsedActive : styles.navItemCollapsed}
                title="Settings"
              >
                <div className={styles.navIconCollapsed}>
                  <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </div>
                <span className={styles.tooltip}>Settings</span>
              </Link>
            ) : (
              <Link
                href="/settings"
                className={isSettingsActive ? styles.navItemActive : styles.navItem}
              >
                <div className={styles.navIcon}>
                  <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </div>
                <div className={styles.navText}>
                  <div className={styles.navLabel}>Settings</div>
                  <div className={styles.navDescription}>Configuration</div>
                </div>
              </Link>
            )}
          </div>
        )}

        {/* Active platforms */}
        {collapsed ? (
          <div className={styles.platformsSectionCollapsed}>
            <div className={styles.platformDotsRow}>
              {platforms.map((platform) => (
                <div
                  key={platform.name}
                  className={styles.platformDotCollapsed}
                  style={{ backgroundColor: platform.color }}
                  title={`${platform.name} (${platform.cooldown})`}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className={styles.platformsSection}>
            <div className={styles.platformsLabel}>Active Platforms</div>
            <div className={styles.platformsList}>
              {platforms.map((platform) => (
                <div key={platform.name} className={styles.platformRow}>
                  <div className={styles.platformName}>
                    <div
                      className={styles.platformDot}
                      style={{ backgroundColor: platform.color }}
                    />
                    <span className={styles.platformNameText}>{platform.name}</span>
                  </div>
                  <span className={styles.platformCooldown}>{platform.cooldown}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* User info & sign out */}
        {profile && (
          collapsed ? (
            <div className={styles.userSectionCollapsed}>
              <div className={styles.userAvatar} title={profile.display_name || profile.email}>
                {userInitial}
              </div>
              <button
                onClick={signOut}
                className={styles.signOutButtonCollapsed}
                title="Sign out"
              >
                <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
              </button>
            </div>
          ) : (
            <div className={styles.userSection}>
              <div className={styles.userRow}>
                <div className={styles.userInfo}>
                  <div className={styles.userName}>
                    {profile.display_name || profile.email}
                  </div>
                  <div className={styles.userRole}>{profile.role}</div>
                </div>
                <button
                  onClick={signOut}
                  className={styles.signOutButton}
                  title="Sign out"
                >
                  <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                  </svg>
                </button>
              </div>
            </div>
          )
        )}
      </div>
    </div>
  )
}

export default Sidebar
