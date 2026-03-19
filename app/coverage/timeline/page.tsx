'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Sidebar } from '../../components/Sidebar'
import { useAuth } from '@/lib/auth-context'
import { CoverageNav } from '../components/CoverageNav'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import AnnotationSidebar, { AnnotationPrefill } from '@/app/components/AnnotationSidebar'

// ─── Types ──────────────────────────────────────────────────────────────────

interface TimelineCoverageItem {
  id: string
  title: string
  url: string
  publish_date: string | null
  coverage_type: string | null
  sentiment: string | null
  monthly_unique_visitors: number | null
  review_score: number | null
  campaign_section: string | null
  campaign_id: string | null
  is_original: boolean | null
  duplicate_group_id: string | null
  outlet: { id: string; name: string; tier: string | null; monthly_unique_visitors: number | null } | null
  game: { id: string; name: string } | null
  campaign: { id: string; name: string } | null
}

interface SaleEvent {
  id: string
  start_date: string
  end_date: string
  sale_name: string | null
  sale_type: string
  status: string
  discount_percentage: number | null
  product: { id: string; name: string; game: { id: string; name: string; client_id: string } | null } | null
  platform: { id: string; name: string } | null
}

interface Campaign {
  id: string
  name: string
  start_date: string | null
  end_date: string | null
  client_id: string | null
  game_id: string | null
}

// ─── Constants ──────────────────────────────────────────────────────────────

const TIER_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  A: { bg: '#dcfce7', text: '#166534', border: '#86efac' },
  B: { bg: '#dbeafe', text: '#1e40af', border: '#93c5fd' },
  C: { bg: '#fef9c3', text: '#854d0e', border: '#fde047' },
  D: { bg: '#f3f4f6', text: '#374151', border: '#d1d5db' },
}

const TYPE_COLORS: Record<string, string> = {
  news: '#2563eb', review: '#7c3aed', preview: '#0891b2', interview: '#059669',
  trailer: '#dc2626', stream: '#9333ea', video: '#ea580c', guide: '#65a30d',
  roundup: '#0284c7', mention: '#94a3b8', feature: '#d946ef', trailer_repost: '#f97316',
}

const SENTIMENT_COLORS: Record<string, string> = {
  positive: '#16a34a', neutral: '#6b7280', negative: '#dc2626', mixed: '#ca8a04',
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return n.toLocaleString()
}

function getMonday(d: Date): Date {
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  return new Date(d.getFullYear(), d.getMonth(), diff)
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function TimelinePage() {
  const { hasAccess, loading: authLoading } = useAuth()
  const canView = hasAccess('pr_coverage', 'view')
  const supabase = createClientComponentClient()

  const [coverageItems, setCoverageItems] = useState<TimelineCoverageItem[]>([])
  const [salesEvents, setSalesEvents] = useState<SaleEvent[]>([])
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // Filters
  const [clients, setClients] = useState<{ id: string; name: string }[]>([])
  const [games, setGames] = useState<{ id: string; name: string; client_id: string }[]>([])
  const [clientFilter, setClientFilter] = useState('')
  const [gameFilter, setGameFilter] = useState('')
  const [showSales, setShowSales] = useState(true)
  const [showCampaigns, setShowCampaigns] = useState(true)
  const [colorBy, setColorBy] = useState<'tier' | 'type' | 'sentiment'>('tier')
  const [groupBy, setGroupBy] = useState<'none' | 'campaign' | 'section'>('none')

  // Timeline range — default to last 90 days
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 90)
    return d.toISOString().split('T')[0]
  })
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().split('T')[0])

  // Detail panel
  const [selectedItem, setSelectedItem] = useState<TimelineCoverageItem | null>(null)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)

  // Annotations
  const [annotations, setAnnotations] = useState<Array<{
    id: string; game_id: string; client_id: string; event_type: string; event_date: string;
    outlet_or_source: string | null; observed_effect: string; direction: string; confidence: string;
    notes: string | null; game?: { name: string }; client?: { name: string }
  }>>([])
  const [showAnnotationSidebar, setShowAnnotationSidebar] = useState(false)
  const [annotationPrefill, setAnnotationPrefill] = useState<AnnotationPrefill | undefined>()
  const [showAnnotations, setShowAnnotations] = useState(true)

  // Load reference data
  useEffect(() => {
    if (!canView) return
    Promise.all([
      supabase.from('clients').select('id, name').order('name'),
      supabase.from('games').select('id, name, client_id').order('name'),
    ]).then(([clientsRes, gamesRes]) => {
      if (clientsRes.data) setClients(clientsRes.data)
      if (gamesRes.data) setGames(gamesRes.data)
    })
  }, [canView, supabase])

  // Fetch timeline data
  const fetchData = useCallback(async () => {
    setIsLoading(true)
    const params = new URLSearchParams()
    if (clientFilter) params.set('client_id', clientFilter)
    if (gameFilter) params.set('game_id', gameFilter)
    if (dateFrom) params.set('date_from', dateFrom)
    if (dateTo) params.set('date_to', dateTo)

    try {
      const res = await fetch(`/api/coverage-timeline?${params}`)
      if (res.ok) {
        const json = await res.json()
        setCoverageItems(json.coverage || [])
        setSalesEvents(json.sales || [])
        setCampaigns(json.campaigns || [])
      }
    } catch (err) {
      console.error('Timeline fetch error:', err)
    }
    setIsLoading(false)
  }, [clientFilter, gameFilter, dateFrom, dateTo])

  useEffect(() => {
    if (canView) fetchData()
  }, [canView, fetchData])

  const fetchAnnotations = useCallback(async () => {
    const params = new URLSearchParams()
    if (clientFilter) params.set('client_id', clientFilter)
    if (gameFilter) params.set('game_id', gameFilter)
    if (dateFrom) params.set('date_from', dateFrom)
    if (dateTo) params.set('date_to', dateTo)
    try {
      const res = await fetch(`/api/pr-annotations?${params}`)
      if (res.ok) {
        const json = await res.json()
        setAnnotations(json.data || [])
      }
    } catch (err) {
      console.error('Annotations fetch error:', err)
    }
  }, [clientFilter, gameFilter, dateFrom, dateTo])

  useEffect(() => {
    if (canView) fetchAnnotations()
  }, [canView, fetchAnnotations])

  const filteredGames = clientFilter ? games.filter(g => g.client_id === clientFilter) : games

  // ─── Compute calendar data ────────────────────────────────────────────────

  // Group items by date
  const itemsByDate = useMemo(() => {
    const map: Record<string, TimelineCoverageItem[]> = {}
    for (const item of coverageItems) {
      if (!item.publish_date) continue
      const day = item.publish_date.split('T')[0]
      if (!map[day]) map[day] = []
      map[day].push(item)
    }
    return map
  }, [coverageItems])

  const annotationsByDate = useMemo(() => {
    const map: Record<string, typeof annotations> = {}
    for (const a of annotations) {
      const day = a.event_date
      if (!map[day]) map[day] = []
      map[day].push(a)
    }
    return map
  }, [annotations])

  // Generate all days in range
  const allDays = useMemo(() => {
    const days: string[] = []
    const start = new Date(dateFrom)
    const end = new Date(dateTo)
    const d = new Date(start)
    while (d <= end) {
      days.push(d.toISOString().split('T')[0])
      d.setDate(d.getDate() + 1)
    }
    return days
  }, [dateFrom, dateTo])

  // Generate weeks for calendar grid
  const weeks = useMemo(() => {
    if (allDays.length === 0) return []
    const result: string[][] = []
    let currentWeek: string[] = []
    const firstDate = new Date(allDays[0])
    const firstDow = firstDate.getDay() || 7 // Mon=1..Sun=7
    // Pad start
    for (let i = 1; i < firstDow; i++) currentWeek.push('')
    for (const day of allDays) {
      currentWeek.push(day)
      if (currentWeek.length === 7) {
        result.push(currentWeek)
        currentWeek = []
      }
    }
    if (currentWeek.length > 0) {
      while (currentWeek.length < 7) currentWeek.push('')
      result.push(currentWeek)
    }
    return result
  }, [allDays])

  // Heatmap density
  const maxDailyCount = useMemo(() => {
    let max = 0
    for (const items of Object.values(itemsByDate)) {
      if (items.length > max) max = items.length
    }
    return max || 1
  }, [itemsByDate])

  // Items for selected day
  const dayItems = useMemo(() => {
    if (!selectedDay) return []
    return itemsByDate[selectedDay] || []
  }, [selectedDay, itemsByDate])

  // Grouped items (for grouped timeline view)
  const groupedItems = useMemo(() => {
    if (groupBy === 'none') return null
    const groups: Record<string, TimelineCoverageItem[]> = {}
    for (const item of coverageItems) {
      let key: string
      if (groupBy === 'campaign') {
        key = item.campaign?.name || 'Uncategorized'
      } else {
        key = item.campaign_section || 'General Coverage'
      }
      if (!groups[key]) groups[key] = []
      groups[key].push(item)
    }
    return groups
  }, [coverageItems, groupBy])

  // Sale events that overlap the visible timeline
  const visibleSales = useMemo(() => {
    if (!showSales) return []
    return salesEvents.filter(s => s.end_date >= dateFrom && s.start_date <= dateTo)
  }, [salesEvents, showSales, dateFrom, dateTo])

  // Campaign spans that overlap the visible timeline
  const visibleCampaigns = useMemo(() => {
    if (!showCampaigns) return []
    return campaigns.filter(c => {
      if (!c.start_date || !c.end_date) return false
      return c.end_date >= dateFrom && c.start_date <= dateTo
    })
  }, [campaigns, showCampaigns, dateFrom, dateTo])

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function getCellColor(items: TimelineCoverageItem[]): string {
    if (items.length === 0) return '#f1f5f9'
    if (colorBy === 'tier') {
      const tiers = items.map(i => i.outlet?.tier).filter(Boolean) as string[]
      if (tiers.includes('A')) return TIER_COLORS.A.bg
      if (tiers.includes('B')) return TIER_COLORS.B.bg
      if (tiers.includes('C')) return TIER_COLORS.C.bg
      return TIER_COLORS.D.bg
    }
    if (colorBy === 'type') {
      const types = items.map(i => i.coverage_type).filter(Boolean) as string[]
      if (types.length > 0) return TYPE_COLORS[types[0]] || '#e2e8f0'
      return '#e2e8f0'
    }
    if (colorBy === 'sentiment') {
      const sents = items.map(i => i.sentiment).filter(Boolean) as string[]
      if (sents.includes('positive')) return '#dcfce7'
      if (sents.includes('negative')) return '#fee2e2'
      if (sents.includes('mixed')) return '#fef3c7'
      return '#f3f4f6'
    }
    return '#e2e8f0'
  }

  function getHeatIntensity(count: number): number {
    if (count === 0) return 0
    return Math.min(1, count / maxDailyCount)
  }

  function getDayPosition(day: string): number {
    const start = new Date(dateFrom).getTime()
    const end = new Date(dateTo).getTime()
    const d = new Date(day).getTime()
    return ((d - start) / (end - start)) * 100
  }

  function getSpanWidth(startDay: string, endDay: string): number {
    const start = new Date(dateFrom).getTime()
    const end = new Date(dateTo).getTime()
    const s = Math.max(new Date(startDay).getTime(), start)
    const e = Math.min(new Date(endDay).getTime(), end)
    return ((e - s) / (end - start)) * 100
  }

  // ─── Loading / Auth ─────────────────────────────────────────────────────

  if (authLoading || isLoading) {
    return (
      <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
        <Sidebar />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p>Loading timeline...</p>
        </div>
      </div>
    )
  }

  if (!canView) {
    return (
      <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
        <Sidebar />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1rem' }}>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 600 }}>Access Denied</h2>
        </div>
      </div>
    )
  }

  const cardStyle: React.CSSProperties = { backgroundColor: 'white', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }
  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

  return (
    <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
      <Sidebar />

      <div style={{ flex: 1, padding: '32px', overflow: 'auto' }}>
        <div style={{ maxWidth: '1400px', margin: '0 auto' }}>
          {/* Header */}
          <div style={{ marginBottom: '16px' }}>
            <h1 style={{ fontSize: '28px', fontWeight: 700, color: '#1e293b', margin: 0 }}>Coverage Timeline</h1>
            <p style={{ fontSize: '14px', color: '#64748b', margin: '4px 0 0 0' }}>
              Calendar view of coverage events with sales overlay
            </p>
          </div>

          <CoverageNav />

          {/* Filters bar */}
          <div style={{
            display: 'flex', gap: '10px', marginBottom: '20px', flexWrap: 'wrap', alignItems: 'center',
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

            <div style={{ width: '1px', height: '24px', backgroundColor: '#e2e8f0' }} />

            <label style={{ fontSize: '12px', color: '#64748b' }}>From</label>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '12px' }} />
            <label style={{ fontSize: '12px', color: '#64748b' }}>To</label>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '12px' }} />

            <div style={{ flex: 1 }} />

            <select value={colorBy} onChange={e => setColorBy(e.target.value as 'tier' | 'type' | 'sentiment')}
              style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '12px', backgroundColor: 'white' }}>
              <option value="tier">Color by Tier</option>
              <option value="type">Color by Type</option>
              <option value="sentiment">Color by Sentiment</option>
            </select>

            <select value={groupBy} onChange={e => setGroupBy(e.target.value as 'none' | 'campaign' | 'section')}
              style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '12px', backgroundColor: 'white' }}>
              <option value="none">No Grouping</option>
              <option value="campaign">Group by Campaign</option>
              <option value="section">Group by Section</option>
            </select>

            <button
              onClick={() => setShowSales(!showSales)}
              style={{
                padding: '6px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 500, cursor: 'pointer',
                backgroundColor: showSales ? '#dbeafe' : 'white',
                color: showSales ? '#1e40af' : '#64748b',
                border: showSales ? '1px solid #93c5fd' : '1px solid #e2e8f0',
              }}
            >
              Sales Overlay
            </button>

            <button
              onClick={() => setShowCampaigns(!showCampaigns)}
              style={{
                padding: '6px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 500, cursor: 'pointer',
                backgroundColor: showCampaigns ? '#f3e8ff' : 'white',
                color: showCampaigns ? '#7c3aed' : '#64748b',
                border: showCampaigns ? '1px solid #c4b5fd' : '1px solid #e2e8f0',
              }}
            >
              Campaigns
            </button>

            <button
              onClick={() => setShowAnnotations(!showAnnotations)}
              style={{
                padding: '6px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 500, cursor: 'pointer',
                backgroundColor: showAnnotations ? '#fef3c7' : 'white',
                color: showAnnotations ? '#92400e' : '#64748b',
                border: showAnnotations ? '1px solid #fde68a' : '1px solid #e2e8f0',
              }}
            >
              Annotations
            </button>

            <button
              onClick={() => {
                setAnnotationPrefill({
                  game_id: gameFilter || undefined,
                  client_id: clientFilter || undefined,
                  event_date: selectedDay || new Date().toISOString().split('T')[0],
                })
                setShowAnnotationSidebar(true)
              }}
              style={{
                padding: '6px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                backgroundColor: '#2563eb', color: 'white', border: '1px solid #2563eb',
              }}
            >
              + Log PR Insight
            </button>
          </div>

          {/* Summary stats */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginBottom: '20px' }}>
            <div style={{ ...cardStyle, padding: '16px' }}>
              <div style={{ fontSize: '24px', fontWeight: 700, color: '#1e293b' }}>{coverageItems.length}</div>
              <div style={{ fontSize: '12px', color: '#64748b' }}>Coverage Items</div>
            </div>
            <div style={{ ...cardStyle, padding: '16px' }}>
              <div style={{ fontSize: '24px', fontWeight: 700, color: '#1e293b' }}>{Object.keys(itemsByDate).length}</div>
              <div style={{ fontSize: '12px', color: '#64748b' }}>Days with Coverage</div>
            </div>
            <div style={{ ...cardStyle, padding: '16px' }}>
              <div style={{ fontSize: '24px', fontWeight: 700, color: '#1e293b' }}>{visibleSales.length}</div>
              <div style={{ fontSize: '12px', color: '#64748b' }}>Overlapping Sales</div>
            </div>
            <div style={{ ...cardStyle, padding: '16px' }}>
              <div style={{ fontSize: '24px', fontWeight: 700, color: '#1e293b' }}>
                {formatNumber(coverageItems.reduce((s, i) => s + (i.monthly_unique_visitors || i.outlet?.monthly_unique_visitors || 0), 0))}
              </div>
              <div style={{ fontSize: '12px', color: '#64748b' }}>Total Reach</div>
            </div>
          </div>

          {/* Sales overlay bar (horizontal Gantt-like) */}
          {showSales && visibleSales.length > 0 && (
            <div style={{ ...cardStyle, marginBottom: '20px', padding: '16px' }}>
              <div style={{ fontSize: '13px', fontWeight: 600, color: '#1e293b', marginBottom: '10px' }}>Sales Events</div>
              <div style={{ position: 'relative', height: `${Math.max(1, visibleSales.length) * 28 + 24}px` }}>
                {/* Month labels */}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#94a3b8', marginBottom: '8px' }}>
                  {(() => {
                    const months: string[] = []
                    const d = new Date(dateFrom)
                    const end = new Date(dateTo)
                    while (d <= end) {
                      months.push(d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }))
                      d.setMonth(d.getMonth() + 1)
                      d.setDate(1)
                    }
                    return months.map((m, i) => <span key={i}>{m}</span>)
                  })()}
                </div>
                <div style={{ position: 'relative', height: `${visibleSales.length * 28}px`, backgroundColor: '#f8fafc', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                  {visibleSales.map((sale, i) => {
                    const left = getDayPosition(sale.start_date)
                    const width = getSpanWidth(sale.start_date, sale.end_date)
                    const statusColors: Record<string, string> = {
                      planned: '#93c5fd', submitted: '#fde047', confirmed: '#86efac', live: '#4ade80', ended: '#d1d5db',
                    }
                    return (
                      <div
                        key={sale.id}
                        title={`${sale.sale_name || sale.sale_type} — ${sale.product?.name || ''} (${sale.platform?.name || ''}) ${sale.discount_percentage ? sale.discount_percentage + '% off' : ''}`}
                        style={{
                          position: 'absolute',
                          left: `${Math.max(0, left)}%`,
                          width: `${Math.max(1, width)}%`,
                          top: `${i * 28 + 2}px`,
                          height: '22px',
                          backgroundColor: statusColors[sale.status] || '#93c5fd',
                          borderRadius: '4px',
                          fontSize: '10px',
                          fontWeight: 500,
                          color: '#1e293b',
                          padding: '3px 6px',
                          overflow: 'hidden',
                          whiteSpace: 'nowrap',
                          textOverflow: 'ellipsis',
                          cursor: 'default',
                          border: '1px solid rgba(0,0,0,0.08)',
                        }}
                      >
                        {sale.sale_name || sale.sale_type} — {sale.product?.name || ''} ({sale.platform?.name || ''})
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Campaign spans */}
          {showCampaigns && visibleCampaigns.length > 0 && (
            <div style={{ ...cardStyle, marginBottom: '20px', padding: '16px' }}>
              <div style={{ fontSize: '13px', fontWeight: 600, color: '#1e293b', marginBottom: '10px' }}>Campaign Periods</div>
              <div style={{ position: 'relative', height: `${visibleCampaigns.length * 28 + 4}px`, backgroundColor: '#faf5ff', borderRadius: '6px', border: '1px solid #e9d5ff' }}>
                {visibleCampaigns.map((camp, i) => {
                  const left = getDayPosition(camp.start_date!)
                  const width = getSpanWidth(camp.start_date!, camp.end_date!)
                  return (
                    <div
                      key={camp.id}
                      title={camp.name}
                      style={{
                        position: 'absolute',
                        left: `${Math.max(0, left)}%`,
                        width: `${Math.max(1, width)}%`,
                        top: `${i * 28 + 2}px`,
                        height: '22px',
                        backgroundColor: '#c4b5fd',
                        borderRadius: '4px',
                        fontSize: '10px',
                        fontWeight: 500,
                        color: '#4c1d95',
                        padding: '3px 6px',
                        overflow: 'hidden',
                        whiteSpace: 'nowrap',
                        textOverflow: 'ellipsis',
                        border: '1px solid #a78bfa',
                      }}
                    >
                      {camp.name}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Main content: Calendar heatmap + detail panel */}
          <div style={{ display: 'grid', gridTemplateColumns: selectedDay || selectedItem ? '1fr 380px' : '1fr', gap: '20px' }}>
            {/* Calendar heatmap */}
            <div style={cardStyle}>
              <div style={{ fontSize: '14px', fontWeight: 600, color: '#1e293b', marginBottom: '16px' }}>
                Coverage Density — {coverageItems.length} items across {allDays.length} days
              </div>

              {groupBy !== 'none' && groupedItems ? (
                /* Grouped timeline */
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  {Object.entries(groupedItems).sort((a, b) => b[1].length - a[1].length).map(([group, items]) => {
                    const groupByDate: Record<string, TimelineCoverageItem[]> = {}
                    for (const item of items) {
                      if (!item.publish_date) continue
                      const day = item.publish_date.split('T')[0]
                      if (!groupByDate[day]) groupByDate[day] = []
                      groupByDate[day].push(item)
                    }
                    const groupMax = Math.max(...Object.values(groupByDate).map(g => g.length), 1)

                    return (
                      <div key={group}>
                        <div style={{ fontSize: '13px', fontWeight: 600, color: '#475569', marginBottom: '8px' }}>
                          {group} <span style={{ fontWeight: 400, color: '#94a3b8' }}>({items.length})</span>
                        </div>
                        <div style={{ display: 'flex', gap: '2px', flexWrap: 'wrap' }}>
                          {allDays.map(day => {
                            const dayItems = groupByDate[day] || []
                            const intensity = dayItems.length > 0 ? Math.min(1, dayItems.length / groupMax) : 0
                            return (
                              <div
                                key={day}
                                onClick={() => { setSelectedDay(day); setSelectedItem(null) }}
                                title={`${day}: ${dayItems.length} items`}
                                style={{
                                  width: '12px',
                                  height: '12px',
                                  borderRadius: '2px',
                                  cursor: 'pointer',
                                  backgroundColor: dayItems.length > 0
                                    ? `rgba(37, 99, 235, ${0.15 + intensity * 0.85})`
                                    : '#f1f5f9',
                                  border: selectedDay === day ? '2px solid #2563eb' : '1px solid transparent',
                                }}
                              />
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                /* Calendar grid (standard view) */
                <div>
                  {/* Day headers */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px', marginBottom: '4px' }}>
                    {DAY_NAMES.map(d => (
                      <div key={d} style={{ fontSize: '10px', color: '#94a3b8', textAlign: 'center', fontWeight: 500 }}>{d}</div>
                    ))}
                  </div>

                  {/* Weeks */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    {weeks.map((week, wi) => {
                      // Show month label on first day of month
                      const firstDayOfMonth = week.find(d => d && d.endsWith('-01'))
                      return (
                        <div key={wi}>
                          {firstDayOfMonth && (
                            <div style={{ fontSize: '11px', fontWeight: 600, color: '#64748b', marginTop: wi > 0 ? '8px' : '0', marginBottom: '4px' }}>
                              {new Date(firstDayOfMonth).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                            </div>
                          )}
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px' }}>
                            {week.map((day, di) => {
                              if (!day) return <div key={di} />
                              const items = itemsByDate[day] || []
                              const count = items.length
                              const intensity = getHeatIntensity(count)
                              const isToday = day === new Date().toISOString().split('T')[0]
                              const isSelected = selectedDay === day

                              // Check if any sale is active on this day
                              const hasSale = showSales && visibleSales.some(s => s.start_date <= day && s.end_date >= day)

                              return (
                                <div
                                  key={di}
                                  onClick={() => { setSelectedDay(day); setSelectedItem(null) }}
                                  title={`${day}: ${count} item${count !== 1 ? 's' : ''}`}
                                  style={{
                                    aspectRatio: '1',
                                    borderRadius: '4px',
                                    cursor: 'pointer',
                                    position: 'relative',
                                    backgroundColor: count > 0
                                      ? getCellColor(items)
                                      : (hasSale ? '#eff6ff' : '#f8fafc'),
                                    border: isSelected
                                      ? '2px solid #2563eb'
                                      : isToday
                                        ? '2px solid #f97316'
                                        : '1px solid #e2e8f0',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    minHeight: '36px',
                                    opacity: count > 0 ? 0.4 + intensity * 0.6 : 1,
                                    transition: 'transform 0.1s',
                                  }}
                                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.transform = 'scale(1.05)' }}
                                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = 'scale(1)' }}
                                >
                                  <div style={{ fontSize: '10px', color: count > 0 ? '#1e293b' : '#94a3b8', fontWeight: isToday ? 700 : 400 }}>
                                    {new Date(day).getDate()}
                                  </div>
                                  {count > 0 && (
                                    <div style={{ fontSize: '9px', fontWeight: 700, color: '#1e293b' }}>{count}</div>
                                  )}
                                  {hasSale && (
                                    <div style={{
                                      position: 'absolute', bottom: '1px', left: '50%', transform: 'translateX(-50%)',
                                      width: '4px', height: '4px', borderRadius: '50%', backgroundColor: '#3b82f6',
                                    }} />
                                  )}
                                  {showAnnotations && annotationsByDate[day] && annotationsByDate[day].length > 0 && (
                                    <div style={{
                                      position: 'absolute', top: '1px', right: '1px',
                                      width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#f59e0b',
                                    }} title={`${annotationsByDate[day].length} annotation(s)`} />
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  {/* Legend */}
                  <div style={{ display: 'flex', gap: '16px', marginTop: '16px', fontSize: '11px', color: '#64748b', flexWrap: 'wrap' }}>
                    {colorBy === 'tier' && (
                      <>
                        {Object.entries(TIER_COLORS).map(([tier, colors]) => (
                          <div key={tier} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <div style={{ width: '12px', height: '12px', borderRadius: '2px', backgroundColor: colors.bg, border: `1px solid ${colors.border}` }} />
                            <span>Tier {tier}</span>
                          </div>
                        ))}
                      </>
                    )}
                    {colorBy === 'type' && (
                      <>
                        {Object.entries(TYPE_COLORS).slice(0, 8).map(([type, color]) => (
                          <div key={type} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <div style={{ width: '12px', height: '12px', borderRadius: '2px', backgroundColor: color, opacity: 0.6 }} />
                            <span>{type}</span>
                          </div>
                        ))}
                      </>
                    )}
                    {colorBy === 'sentiment' && (
                      <>
                        {[['positive', '#dcfce7'], ['neutral', '#f3f4f6'], ['negative', '#fee2e2'], ['mixed', '#fef3c7']].map(([label, color]) => (
                          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <div style={{ width: '12px', height: '12px', borderRadius: '2px', backgroundColor: color }} />
                            <span>{label}</span>
                          </div>
                        ))}
                      </>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <div style={{ width: '12px', height: '12px', borderRadius: '2px', border: '2px solid #f97316' }} />
                      <span>Today</span>
                    </div>
                    {showSales && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <div style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#3b82f6' }} />
                        <span>Sale active</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Detail panel */}
            {(selectedDay || selectedItem) && (
              <div style={{ ...cardStyle, maxHeight: 'calc(100vh - 200px)', overflow: 'auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: '#1e293b' }}>
                      {selectedItem ? 'Coverage Details' : (
                        selectedDay ? new Date(selectedDay + 'T12:00:00').toLocaleDateString('en-US', {
                          weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
                        }) : ''
                      )}
                    </div>
                    {selectedDay && !selectedItem && (
                      <div style={{ fontSize: '12px', color: '#64748b' }}>{dayItems.length} item{dayItems.length !== 1 ? 's' : ''}</div>
                    )}
                  </div>
                  <button
                    onClick={() => { setSelectedDay(null); setSelectedItem(null) }}
                    style={{ background: 'none', border: 'none', fontSize: '18px', color: '#94a3b8', cursor: 'pointer' }}
                  >
                    x
                  </button>
                </div>

                {/* Single item detail */}
                {selectedItem && (
                  <div>
                    <a href={selectedItem.url} target="_blank" rel="noopener noreferrer"
                      style={{ fontSize: '15px', fontWeight: 600, color: '#2563eb', textDecoration: 'none', display: 'block', marginBottom: '12px' }}>
                      {selectedItem.title}
                    </a>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px' }}>
                      {selectedItem.outlet && (
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: '#64748b' }}>Outlet</span>
                          <span style={{ fontWeight: 500 }}>
                            {selectedItem.outlet.name}
                            {selectedItem.outlet.tier && (
                              <span style={{
                                marginLeft: '6px', padding: '1px 6px', borderRadius: '8px', fontSize: '11px', fontWeight: 600,
                                backgroundColor: TIER_COLORS[selectedItem.outlet.tier]?.bg,
                                color: TIER_COLORS[selectedItem.outlet.tier]?.text,
                              }}>
                                {selectedItem.outlet.tier}
                              </span>
                            )}
                          </span>
                        </div>
                      )}
                      {selectedItem.coverage_type && (
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: '#64748b' }}>Type</span>
                          <span style={{
                            padding: '1px 8px', borderRadius: '8px', fontSize: '11px', fontWeight: 500,
                            backgroundColor: `${TYPE_COLORS[selectedItem.coverage_type] || '#e2e8f0'}20`,
                            color: TYPE_COLORS[selectedItem.coverage_type] || '#475569',
                          }}>
                            {selectedItem.coverage_type}
                          </span>
                        </div>
                      )}
                      {selectedItem.sentiment && (
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: '#64748b' }}>Sentiment</span>
                          <span style={{ color: SENTIMENT_COLORS[selectedItem.sentiment] || '#64748b', fontWeight: 500 }}>
                            {selectedItem.sentiment}
                          </span>
                        </div>
                      )}
                      {selectedItem.review_score && (
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: '#64748b' }}>Review Score</span>
                          <span style={{ fontWeight: 600, color: selectedItem.review_score >= 80 ? '#16a34a' : selectedItem.review_score >= 60 ? '#ca8a04' : '#dc2626' }}>
                            {selectedItem.review_score}/100
                          </span>
                        </div>
                      )}
                      {(selectedItem.monthly_unique_visitors || selectedItem.outlet?.monthly_unique_visitors) && (
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: '#64748b' }}>Audience Reach</span>
                          <span style={{ fontWeight: 500 }}>
                            {formatNumber(selectedItem.monthly_unique_visitors || selectedItem.outlet?.monthly_unique_visitors || 0)}
                          </span>
                        </div>
                      )}
                      {selectedItem.game && (
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: '#64748b' }}>Game</span>
                          <span style={{ fontWeight: 500 }}>{selectedItem.game.name}</span>
                        </div>
                      )}
                      {selectedItem.campaign && (
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: '#64748b' }}>Campaign</span>
                          <span style={{ fontWeight: 500 }}>{selectedItem.campaign.name}</span>
                        </div>
                      )}
                      {selectedItem.campaign_section && (
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: '#64748b' }}>Section</span>
                          <span style={{ fontWeight: 500 }}>{selectedItem.campaign_section}</span>
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => setSelectedItem(null)}
                      style={{
                        marginTop: '16px', padding: '6px 12px', fontSize: '12px', color: '#64748b',
                        backgroundColor: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: '6px', cursor: 'pointer',
                      }}
                    >
                      Back to day view
                    </button>
                  </div>
                )}

                {/* Day items list */}
                {selectedDay && !selectedItem && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {/* Sales on this day */}
                    {showSales && visibleSales.filter(s => s.start_date <= selectedDay && s.end_date >= selectedDay).length > 0 && (
                      <div style={{ padding: '8px 12px', backgroundColor: '#eff6ff', borderRadius: '8px', border: '1px solid #bfdbfe', marginBottom: '4px' }}>
                        <div style={{ fontSize: '11px', fontWeight: 600, color: '#1e40af', marginBottom: '4px' }}>Active Sales</div>
                        {visibleSales.filter(s => s.start_date <= selectedDay && s.end_date >= selectedDay).map(sale => (
                          <div key={sale.id} style={{ fontSize: '12px', color: '#1e40af' }}>
                            {sale.sale_name || sale.sale_type} — {sale.product?.name} ({sale.platform?.name})
                            {sale.discount_percentage ? ` ${sale.discount_percentage}% off` : ''}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Annotations for this day */}
                    {showAnnotations && selectedDay && annotationsByDate[selectedDay] && annotationsByDate[selectedDay].length > 0 && (
                      <div style={{ padding: '8px 12px', backgroundColor: '#fffbeb', borderRadius: '8px', border: '1px solid #fde68a', marginBottom: '4px' }}>
                        <div style={{ fontSize: '11px', fontWeight: 600, color: '#92400e', marginBottom: '4px' }}>PR Annotations</div>
                        {annotationsByDate[selectedDay].map(a => (
                          <div key={a.id} style={{ fontSize: '12px', color: '#78350f', marginBottom: '2px' }}>
                            <span style={{ fontWeight: 500 }}>{a.event_type.replace(/_/g, ' ')}</span>
                            {a.outlet_or_source && <span> — {a.outlet_or_source}</span>}
                            <span style={{
                              marginLeft: '6px', fontSize: '10px', padding: '1px 6px', borderRadius: '4px',
                              backgroundColor: a.confidence === 'confirmed' ? '#dcfce7' : a.confidence === 'suspected' ? '#fef9c3' : '#fee2e2',
                              color: a.confidence === 'confirmed' ? '#166534' : a.confidence === 'suspected' ? '#854d0e' : '#991b1b',
                            }}>
                              {a.confidence}
                            </span>
                            {a.observed_effect !== 'unknown' && (
                              <span style={{ marginLeft: '4px', fontSize: '10px', color: '#64748b' }}>→ {a.observed_effect.replace(/_/g, ' ')}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {dayItems.length === 0 ? (
                      <div style={{ color: '#94a3b8', fontSize: '13px', textAlign: 'center', padding: '20px' }}>
                        No coverage items on this day
                      </div>
                    ) : (
                      dayItems.map(item => (
                        <div
                          key={item.id}
                          onClick={() => setSelectedItem(item)}
                          style={{
                            padding: '10px 12px', backgroundColor: '#f8fafc', borderRadius: '8px',
                            border: '1px solid #e2e8f0', cursor: 'pointer', transition: 'background 0.1s',
                          }}
                          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '#f1f5f9' }}
                          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '#f8fafc' }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                            {item.outlet?.tier && (
                              <span style={{
                                padding: '1px 6px', borderRadius: '8px', fontSize: '10px', fontWeight: 600,
                                backgroundColor: TIER_COLORS[item.outlet.tier]?.bg,
                                color: TIER_COLORS[item.outlet.tier]?.text,
                              }}>
                                {item.outlet.tier}
                              </span>
                            )}
                            <span style={{ fontSize: '11px', color: '#64748b' }}>{item.outlet?.name || ''}</span>
                            {item.coverage_type && (
                              <span style={{
                                padding: '1px 6px', borderRadius: '8px', fontSize: '10px',
                                backgroundColor: `${TYPE_COLORS[item.coverage_type] || '#e2e8f0'}20`,
                                color: TYPE_COLORS[item.coverage_type] || '#475569',
                              }}>
                                {item.coverage_type}
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: '13px', fontWeight: 500, color: '#1e293b' }}>
                            {item.title}
                          </div>
                          {(item.monthly_unique_visitors || item.outlet?.monthly_unique_visitors) && (
                            <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>
                              {formatNumber(item.monthly_unique_visitors || item.outlet?.monthly_unique_visitors || 0)} reach
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Correlation view — Coverage spikes vs sales */}
          {showSales && visibleSales.length > 0 && coverageItems.length > 0 && (
            <div style={{ ...cardStyle, marginTop: '20px' }}>
              <div style={{ fontSize: '14px', fontWeight: 600, color: '#1e293b', marginBottom: '12px' }}>
                Coverage ↔ Sales Correlation
              </div>
              <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '16px' }}>
                Days where coverage clusters align with active sales periods
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {visibleSales.map(sale => {
                  // Count coverage items during this sale period
                  let coverageDuringSale = 0
                  let reachDuringSale = 0
                  for (const [day, items] of Object.entries(itemsByDate)) {
                    if (day >= sale.start_date && day <= sale.end_date) {
                      coverageDuringSale += items.length
                      reachDuringSale += items.reduce((s, i) => s + (i.monthly_unique_visitors || i.outlet?.monthly_unique_visitors || 0), 0)
                    }
                  }
                  if (coverageDuringSale === 0) return null

                  return (
                    <div key={sale.id} style={{
                      display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 14px',
                      backgroundColor: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0',
                    }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: '13px', fontWeight: 500, color: '#1e293b' }}>
                          {sale.sale_name || sale.sale_type} — {sale.product?.name}
                        </div>
                        <div style={{ fontSize: '11px', color: '#64748b' }}>
                          {sale.start_date} to {sale.end_date} ({sale.platform?.name})
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '16px', fontWeight: 700, color: '#2563eb' }}>{coverageDuringSale}</div>
                        <div style={{ fontSize: '10px', color: '#64748b' }}>articles</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '16px', fontWeight: 700, color: '#059669' }}>{formatNumber(reachDuringSale)}</div>
                        <div style={{ fontSize: '10px', color: '#64748b' }}>reach</div>
                      </div>
                      <div style={{
                        padding: '4px 10px', borderRadius: '12px', fontSize: '11px', fontWeight: 600,
                        backgroundColor: coverageDuringSale >= 5 ? '#dcfce7' : coverageDuringSale >= 2 ? '#fef3c7' : '#fee2e2',
                        color: coverageDuringSale >= 5 ? '#166534' : coverageDuringSale >= 2 ? '#854d0e' : '#991b1b',
                      }}>
                        {coverageDuringSale >= 5 ? 'Strong' : coverageDuringSale >= 2 ? 'Moderate' : 'Weak'}
                      </div>
                    </div>
                  )
                }).filter(Boolean)}
              </div>
            </div>
          )}
        </div>

        {/* Annotation Sidebar */}
        <AnnotationSidebar
          isOpen={showAnnotationSidebar}
          onClose={() => setShowAnnotationSidebar(false)}
          onSaved={() => { setShowAnnotationSidebar(false); fetchAnnotations() }}
          prefill={annotationPrefill}
        />
      </div>
    </div>
  )
}
