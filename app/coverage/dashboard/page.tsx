'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Sidebar } from '../../components/Sidebar'
import { useAuth } from '@/lib/auth-context'
import { CoverageNav } from '../components/CoverageNav'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'

// ─── Types ──────────────────────────────────────────────────────────────────

interface CoverageItem {
  id: string
  publish_date: string | null
  territory: string | null
  coverage_type: string | null
  monthly_unique_visitors: number | null
  review_score: number | null
  sentiment: string | null
  approval_status: string
  source_type: string
  outlet?: { id: string; name: string; tier: string | null; monthly_unique_visitors: number | null } | null
  game?: { id: string; name: string } | null
}

interface ClientOption { id: string; name: string }
interface GameOption { id: string; name: string; client_id: string }

// ─── Constants ──────────────────────────────────────────────────────────────

const TIER_COLORS: Record<string, string> = { A: '#16a34a', B: '#2563eb', C: '#ca8a04', D: '#6b7280' }
const SENTIMENT_COLORS: Record<string, string> = { positive: '#16a34a', neutral: '#6b7280', negative: '#dc2626', mixed: '#ca8a04' }
const COVERAGE_TYPE_COLORS: Record<string, string> = {
  news: '#2563eb', review: '#7c3aed', preview: '#0891b2', interview: '#059669',
  trailer: '#dc2626', stream: '#9333ea', video: '#ea580c', guide: '#65a30d',
  roundup: '#0284c7', mention: '#94a3b8', feature: '#d946ef', trailer_repost: '#f97316'
}
const SOURCE_COLORS: Record<string, string> = {
  rss: '#f97316', tavily: '#2563eb', youtube: '#dc2626', twitch: '#9333ea',
  reddit: '#ea580c', twitter: '#1e293b', tiktok: '#000', instagram: '#e11d48', manual: '#6b7280'
}

function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return n.toLocaleString()
}

function getDateRange(period: string): { from: string; to: string } {
  const now = new Date()
  const to = now.toISOString().split('T')[0]
  let from: Date
  switch (period) {
    case '7d': from = new Date(now.getTime() - 7 * 86400000); break
    case '30d': from = new Date(now.getTime() - 30 * 86400000); break
    case '90d': from = new Date(now.getTime() - 90 * 86400000); break
    case 'ytd': from = new Date(now.getFullYear(), 0, 1); break
    default: from = new Date(now.getTime() - 30 * 86400000)
  }
  return { from: from.toISOString().split('T')[0], to }
}

// ─── Bar Chart Component ────────────────────────────────────────────────────

function BarChart({ data, colorMap, title }: { data: Record<string, number>; colorMap?: Record<string, string>; title: string }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1])
  const max = Math.max(...entries.map(e => e[1]), 1)

  return (
    <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
      <h3 style={{ fontSize: '14px', fontWeight: 600, color: '#1e293b', marginBottom: '16px' }}>{title}</h3>
      {entries.length === 0 ? (
        <div style={{ color: '#94a3b8', fontSize: '13px', textAlign: 'center', padding: '20px' }}>No data</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {entries.map(([label, count]) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '100px', fontSize: '12px', color: '#475569', textAlign: 'right', flexShrink: 0 }}>
                {label}
              </div>
              <div style={{ flex: 1, height: '22px', backgroundColor: '#f1f5f9', borderRadius: '4px', overflow: 'hidden', position: 'relative' }}>
                <div style={{
                  width: `${(count / max) * 100}%`,
                  height: '100%',
                  backgroundColor: colorMap?.[label] || '#2563eb',
                  borderRadius: '4px',
                  transition: 'width 0.3s ease',
                  minWidth: count > 0 ? '2px' : '0'
                }} />
                <span style={{
                  position: 'absolute', right: '6px', top: '50%', transform: 'translateY(-50%)',
                  fontSize: '11px', fontWeight: 500, color: '#475569'
                }}>
                  {count}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { hasAccess, loading: authLoading } = useAuth()
  const canView = hasAccess('pr_coverage', 'view')
  const supabase = createClientComponentClient()

  const [items, setItems] = useState<CoverageItem[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // Reference data
  const [clients, setClients] = useState<ClientOption[]>([])
  const [games, setGames] = useState<GameOption[]>([])

  // Filters
  const [clientFilter, setClientFilter] = useState('')
  const [gameFilter, setGameFilter] = useState('')
  const [period, setPeriod] = useState('30d')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')

  // Fetch reference data
  useEffect(() => {
    if (!canView) return
    async function load() {
      const [clientsRes, gamesRes] = await Promise.all([
        supabase.from('clients').select('id, name').order('name'),
        supabase.from('games').select('id, name, client_id').order('name')
      ])
      if (clientsRes.data) setClients(clientsRes.data)
      if (gamesRes.data) setGames(gamesRes.data)
    }
    load()
  }, [canView, supabase])

  // Fetch coverage items
  const fetchItems = useCallback(async () => {
    setIsLoading(true)
    const params = new URLSearchParams()
    if (clientFilter) params.set('client_id', clientFilter)
    if (gameFilter) params.set('game_id', gameFilter)

    // Date range
    const dateRange = period === 'custom'
      ? { from: customFrom, to: customTo }
      : getDateRange(period)
    if (dateRange.from) params.set('date_from', dateRange.from)
    if (dateRange.to) params.set('date_to', dateRange.to)
    params.set('limit', '5000')
    // Only approved items for dashboard stats
    // (include all for comprehensive view)

    try {
      const res = await fetch(`/api/coverage-items?${params}`)
      if (res.ok) {
        const json = await res.json()
        setItems(json.data || [])
      }
    } catch (err) {
      console.error('Failed to fetch coverage items:', err)
    }
    setIsLoading(false)
  }, [clientFilter, gameFilter, period, customFrom, customTo])

  useEffect(() => {
    if (canView) fetchItems()
  }, [canView, fetchItems])

  // Filter games by client
  const filteredGames = clientFilter ? games.filter(g => g.client_id === clientFilter) : games

  // Only approved items for main metrics
  const approved = useMemo(() => items.filter(i =>
    i.approval_status === 'auto_approved' || i.approval_status === 'manually_approved'
  ), [items])

  // ─── Compute stats ──────────────────────────────────────────────────────

  const totalCoverage = approved.length
  const totalAudienceReach = useMemo(() =>
    approved.reduce((sum, item) => sum + (item.monthly_unique_visitors || item.outlet?.monthly_unique_visitors || 0), 0),
    [approved]
  )
  const estimatedViews = Math.round(totalAudienceReach * 0.03) // ~3% industry standard multiplier
  const uniqueOutlets = useMemo(() => {
    const set = new Set<string>()
    approved.forEach(i => { if (i.outlet?.id) set.add(i.outlet.id) })
    return set.size
  }, [approved])

  const averageTier = useMemo(() => {
    const tiers = approved.map(i => i.outlet?.tier).filter(Boolean) as string[]
    if (tiers.length === 0) return '—'
    const scores: Record<string, number> = { A: 4, B: 3, C: 2, D: 1 }
    const avg = tiers.reduce((sum, t) => sum + (scores[t] || 0), 0) / tiers.length
    if (avg >= 3.5) return 'A'
    if (avg >= 2.5) return 'B'
    if (avg >= 1.5) return 'C'
    return 'D'
  }, [approved])

  // Breakdowns
  const byTier = useMemo(() => {
    const map: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 }
    approved.forEach(i => { const t = i.outlet?.tier; if (t && t in map) map[t]++ })
    return map
  }, [approved])

  const byTerritory = useMemo(() => {
    const map: Record<string, number> = {}
    approved.forEach(i => {
      const t = i.territory || 'Unknown'
      map[t] = (map[t] || 0) + 1
    })
    return map
  }, [approved])

  const byType = useMemo(() => {
    const map: Record<string, number> = {}
    approved.forEach(i => {
      const t = i.coverage_type || 'unknown'
      map[t] = (map[t] || 0) + 1
    })
    return map
  }, [approved])

  const bySource = useMemo(() => {
    const map: Record<string, number> = {}
    approved.forEach(i => {
      map[i.source_type] = (map[i.source_type] || 0) + 1
    })
    return map
  }, [approved])

  const bySentiment = useMemo(() => {
    const map: Record<string, number> = {}
    approved.forEach(i => {
      const s = i.sentiment || 'unknown'
      map[s] = (map[s] || 0) + 1
    })
    return map
  }, [approved])

  // Timeline (coverage over time by week)
  const byWeek = useMemo(() => {
    const map: Record<string, number> = {}
    approved.forEach(i => {
      if (!i.publish_date) return
      const d = new Date(i.publish_date)
      const weekStart = new Date(d)
      weekStart.setDate(d.getDate() - d.getDay())
      const key = weekStart.toISOString().split('T')[0]
      map[key] = (map[key] || 0) + 1
    })
    return map
  }, [approved])

  // Period comparison
  const previousPeriodItems = useMemo(() => {
    const dateRange = period === 'custom'
      ? { from: customFrom, to: customTo }
      : getDateRange(period)
    if (!dateRange.from || !dateRange.to) return []
    const periodMs = new Date(dateRange.to).getTime() - new Date(dateRange.from).getTime()
    const prevFrom = new Date(new Date(dateRange.from).getTime() - periodMs).toISOString().split('T')[0]
    const prevTo = dateRange.from
    // Filter from ALL items (not just approved) for comparison
    return items.filter(i => {
      if (!i.publish_date) return false
      if (i.approval_status !== 'auto_approved' && i.approval_status !== 'manually_approved') return false
      return i.publish_date >= prevFrom && i.publish_date < prevTo
    })
  }, [items, period, customFrom, customTo])

  const prevCoverage = previousPeriodItems.length
  const prevReach = previousPeriodItems.reduce((sum, i) => sum + (i.monthly_unique_visitors || i.outlet?.monthly_unique_visitors || 0), 0)
  const delta = (current: number, prev: number) => {
    if (prev === 0) return current > 0 ? '+∞' : '0'
    const pct = ((current - prev) / prev) * 100
    return `${pct > 0 ? '+' : ''}${pct.toFixed(0)}%`
  }

  // ─── Loading / Auth ─────────────────────────────────────────────────────

  if (authLoading || isLoading) {
    return (
      <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
        <Sidebar />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p>Loading...</p>
        </div>
      </div>
    )
  }

  if (!canView) {
    return (
      <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
        <Sidebar />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1rem' }}>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 600, color: '#1f2937' }}>Access Denied</h2>
          <p style={{ color: '#6b7280' }}>You don&apos;t have permission to view PR Coverage.</p>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
      <Sidebar />

      <div style={{ flex: 1, padding: '32px', overflow: 'auto' }}>
        <div style={{ maxWidth: '1400px', margin: '0 auto' }}>
          {/* Header */}
          <div style={{ marginBottom: '16px' }}>
            <h1 style={{ fontSize: '28px', fontWeight: 700, color: '#1e293b', margin: 0 }}>Coverage Dashboard</h1>
            <p style={{ fontSize: '14px', color: '#64748b', margin: '4px 0 0 0' }}>
              PR performance summary and analytics
            </p>
          </div>

          <CoverageNav />

          {/* Filters */}
          <div style={{
            display: 'flex', gap: '10px', marginBottom: '24px', flexWrap: 'wrap', alignItems: 'center',
            backgroundColor: 'white', padding: '12px 16px', borderRadius: '10px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)'
          }}>
            <select value={clientFilter} onChange={e => { setClientFilter(e.target.value); setGameFilter('') }}
              style={{ padding: '7px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px', backgroundColor: 'white' }}>
              <option value="">All Clients</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select value={gameFilter} onChange={e => setGameFilter(e.target.value)}
              style={{ padding: '7px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px', backgroundColor: 'white' }}>
              <option value="">All Games</option>
              {filteredGames.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
            <div style={{ flex: 1 }} />
            {['7d', '30d', '90d', 'ytd', 'custom'].map(p => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                style={{
                  padding: '6px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 500, cursor: 'pointer',
                  backgroundColor: period === p ? '#2563eb' : 'white',
                  color: period === p ? 'white' : '#475569',
                  border: period === p ? '1px solid #2563eb' : '1px solid #e2e8f0'
                }}
              >
                {p === '7d' ? '7 Days' : p === '30d' ? '30 Days' : p === '90d' ? '90 Days' : p === 'ytd' ? 'YTD' : 'Custom'}
              </button>
            ))}
            {period === 'custom' && (
              <>
                <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
                  style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '12px' }} />
                <span style={{ color: '#94a3b8', fontSize: '12px' }}>to</span>
                <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
                  style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '12px' }} />
              </>
            )}
          </div>

          {/* Summary stat cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '12px', marginBottom: '24px' }}>
            {[
              { label: 'Total Coverage', value: totalCoverage, prev: prevCoverage, icon: '📰' },
              { label: 'Audience Reach', value: totalAudienceReach, prev: prevReach, icon: '👥', format: true },
              { label: 'Est. Views', value: estimatedViews, prev: Math.round(prevReach * 0.03), icon: '👁', format: true },
              { label: 'Unique Outlets', value: uniqueOutlets, prev: null, icon: '🏢' },
              { label: 'Avg Tier', value: averageTier, prev: null, icon: '⭐', isText: true }
            ].map((stat, i) => (
              <div key={i} style={{
                backgroundColor: 'white', borderRadius: '12px', padding: '20px',
                boxShadow: '0 1px 3px rgba(0,0,0,0.06)'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '4px' }}>{stat.label}</div>
                    <div style={{ fontSize: '28px', fontWeight: 700, color: '#1e293b' }}>
                      {stat.isText ? stat.value : (stat.format ? formatNumber(stat.value as number) : (stat.value as number).toLocaleString())}
                    </div>
                  </div>
                  <span style={{ fontSize: '24px' }}>{stat.icon}</span>
                </div>
                {stat.prev !== null && stat.prev !== undefined && (
                  <div style={{
                    marginTop: '8px', fontSize: '12px',
                    color: (stat.value as number) >= stat.prev ? '#16a34a' : '#dc2626'
                  }}>
                    {delta(stat.value as number, stat.prev)} vs previous period
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Charts grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
            <BarChart data={byTier} colorMap={TIER_COLORS} title="Coverage by Tier" />
            <BarChart data={byType} colorMap={COVERAGE_TYPE_COLORS} title="Coverage by Type" />
            <BarChart data={bySentiment} colorMap={SENTIMENT_COLORS} title="Coverage by Sentiment" />
            <BarChart data={bySource} colorMap={SOURCE_COLORS} title="Coverage by Source" />
          </div>

          {/* Territory breakdown (full width) */}
          <div style={{ marginBottom: '24px' }}>
            <BarChart data={byTerritory} title="Coverage by Territory" />
          </div>

          {/* Timeline (coverage over time) */}
          <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
            <h3 style={{ fontSize: '14px', fontWeight: 600, color: '#1e293b', marginBottom: '16px' }}>Coverage Over Time (Weekly)</h3>
            {Object.keys(byWeek).length === 0 ? (
              <div style={{ color: '#94a3b8', fontSize: '13px', textAlign: 'center', padding: '20px' }}>No timeline data</div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: '4px', height: '120px' }}>
                {Object.entries(byWeek).sort((a, b) => a[0].localeCompare(b[0])).map(([week, count]) => {
                  const max = Math.max(...Object.values(byWeek), 1)
                  const height = (count / max) * 100
                  return (
                    <div key={week} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <div style={{ fontSize: '10px', color: '#475569', marginBottom: '2px' }}>{count}</div>
                      <div style={{
                        width: '100%', maxWidth: '40px',
                        height: `${height}%`, minHeight: count > 0 ? '4px' : '0',
                        backgroundColor: '#2563eb',
                        borderRadius: '4px 4px 0 0'
                      }} />
                      <div style={{ fontSize: '9px', color: '#94a3b8', marginTop: '4px', whiteSpace: 'nowrap' }}>
                        {new Date(week).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
