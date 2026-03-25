'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Sidebar } from '../../components/Sidebar'
import { useAuth } from '@/lib/auth-context'
import { CoverageNav } from '../components/CoverageNav'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'

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

interface Annotation {
  id: string; game_id: string; client_id: string; event_type: string; event_date: string;
  outlet_or_source: string | null; observed_effect: string; direction: string; confidence: string;
  notes: string | null; game?: { name: string }; client?: { name: string }
}

// ─── Constants ──────────────────────────────────────────────────────────────

const SIDEBAR_WIDTH = 200
const ROW_HEIGHT = 48
const HEADER_HEIGHT = 56
const ZOOM_LEVELS = [
  { label: '1W', days: 7 },
  { label: '2W', days: 14 },
  { label: '1M', days: 30 },
  { label: '3M', days: 90 },
  { label: '6M', days: 180 },
  { label: '1Y', days: 365 },
]

const TIER_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  A: { bg: '#dcfce7', text: '#166534', border: '#86efac' },
  B: { bg: '#dbeafe', text: '#1e40af', border: '#93c5fd' },
  C: { bg: '#ffedd5', text: '#9a3412', border: '#fdba74' },
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

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0]
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000)
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function TimelinePage() {
  const { hasAccess, loading: authLoading } = useAuth()
  const canView = hasAccess('pr_coverage', 'view')
  const supabase = createClientComponentClient()
  const scrollRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // ─── Data ─────────────────────────────────────────────────────────────────
  const [coverageItems, setCoverageItems] = useState<TimelineCoverageItem[]>([])
  const [salesEvents, setSalesEvents] = useState<SaleEvent[]>([])
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // ─── Filters ──────────────────────────────────────────────────────────────
  const [clients, setClients] = useState<{ id: string; name: string }[]>([])
  const [games, setGames] = useState<{ id: string; name: string; client_id: string }[]>([])
  const [clientFilter, setClientFilter] = useState('')
  const [gameFilter, setGameFilter] = useState('')

  // Timeline range — default to last 90 days
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 90)
    return d.toISOString().split('T')[0]
  })
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().split('T')[0])

  // ─── View mode ────────────────────────────────────────────────────────────
  const [viewMode, setViewMode] = useState<'timeline' | 'heatmap' | 'table'>('timeline')
  const [timelineGroupBy, setTimelineGroupBy] = useState<'game' | 'outlet'>('game')
  const [zoomIndex, setZoomIndex] = useState(3) // default 3M
  const [colorBy, setColorBy] = useState<'tier' | 'type' | 'sentiment'>('tier')
  const [manualDayWidth, setManualDayWidth] = useState<number | null>(null) // null = auto-fit

  // ─── Overlays ─────────────────────────────────────────────────────────────
  const [showSales, setShowSales] = useState(true)
  const [showCampaigns, setShowCampaigns] = useState(true)
  const [showAnnotations, setShowAnnotations] = useState(true)

  // ─── Selection ────────────────────────────────────────────────────────────
  const [selectedItem, setSelectedItem] = useState<TimelineCoverageItem | null>(null)

  // ─── Annotations ──────────────────────────────────────────────────────────
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [annotationPopover, setAnnotationPopover] = useState<{
    day: string; x: number; y: number; gameId?: string; outletName?: string
  } | null>(null)
  const [annotationForm, setAnnotationForm] = useState({
    event_type: 'pr_mention', outlet_or_source: '', observed_effect: 'unknown',
    confidence: 'suspected', notes: '', event_date: '',
  })
  const [annotationSaving, setAnnotationSaving] = useState(false)
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null)
  const [expandedAnnotationDay, setExpandedAnnotationDay] = useState<string | null>(null)
  const [pendingAnnotationMarker, setPendingAnnotationMarker] = useState<{ day: string; rowId: string } | null>(null)

  // ─── Table sort ───────────────────────────────────────────────────────────
  const [tableSort, setTableSort] = useState<{ field: string; dir: 'asc' | 'desc' }>({ field: 'publish_date', dir: 'desc' })


  // ─── Container dimensions ───────────────────────────────────────────────
  const timelineCardRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(1200)
  useEffect(() => {
    // Observe the timeline card width (or fallback to outer container)
    const el = timelineCardRef.current || containerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [viewMode]) // re-observe when view mode changes (card may mount/unmount)


  // ─── Data fetching ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!canView) return
    Promise.all([
      supabase.from('clients').select('id, name').order('name'),
      supabase.from('games').select('id, name, client_id').order('name'),
    ]).then(([c, g]) => {
      if (c.data) setClients(c.data)
      if (g.data) setGames(g.data)
    })
  }, [canView, supabase])

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
    } catch (err) { console.error('Timeline fetch error:', err) }
    setIsLoading(false)
  }, [clientFilter, gameFilter, dateFrom, dateTo])

  useEffect(() => { if (canView) fetchData() }, [canView, fetchData])

  const fetchAnnotations = useCallback(async () => {
    const params = new URLSearchParams()
    if (clientFilter) params.set('client_id', clientFilter)
    if (gameFilter) params.set('game_id', gameFilter)
    if (dateFrom) params.set('date_from', dateFrom)
    if (dateTo) params.set('date_to', dateTo)
    try {
      const res = await fetch(`/api/pr-annotations?${params}`)
      if (res.ok) { const json = await res.json(); setAnnotations(json.data || []) }
    } catch (err) { console.error('Annotations fetch:', err) }
  }, [clientFilter, gameFilter, dateFrom, dateTo])

  useEffect(() => { if (canView) fetchAnnotations() }, [canView, fetchAnnotations])

  const filteredGames = clientFilter ? games.filter(g => g.client_id === clientFilter) : games

  // ─── Computed: timeline data ──────────────────────────────────────────────

  const allDays = useMemo(() => {
    const days: string[] = []
    const d = new Date(dateFrom)
    const end = new Date(dateTo)
    while (d <= end) { days.push(formatDate(d)); d.setDate(d.getDate() + 1) }
    return days
  }, [dateFrom, dateTo])

  const autoFitDayWidth = useMemo(() => {
    const availableWidth = containerWidth - SIDEBAR_WIDTH
    return Math.max(4, availableWidth / allDays.length)
  }, [containerWidth, allDays.length])

  const dayWidth = manualDayWidth !== null ? manualDayWidth : autoFitDayWidth
  const totalWidth = Math.max(containerWidth, SIDEBAR_WIDTH + allDays.length * dayWidth)

  const annotationsByDate = useMemo(() => {
    const map: Record<string, Annotation[]> = {}
    for (const a of annotations) {
      if (!map[a.event_date]) map[a.event_date] = []
      map[a.event_date].push(a)
    }
    return map
  }, [annotations])

  // Group coverage items into timeline rows
  const timelineRows = useMemo(() => {
    const groups: Record<string, { label: string; sublabel: string; items: TimelineCoverageItem[]; gameId?: string; outletId?: string }> = {}

    for (const item of coverageItems) {
      let key: string, label: string, sublabel = ''
      if (timelineGroupBy === 'game') {
        key = item.game?.id || '_ungrouped'
        label = item.game?.name || 'Ungrouped'
        const game = games.find(g => g.id === item.game?.id)
        if (game) {
          const client = clients.find(c => c.id === game.client_id)
          sublabel = client?.name || ''
        }
      } else {
        key = item.outlet?.id || '_unknown'
        label = item.outlet?.name || 'Unknown Outlet'
        sublabel = item.outlet?.tier ? `Tier ${item.outlet.tier}` : ''
      }
      if (!groups[key]) groups[key] = { label, sublabel, items: [], gameId: item.game?.id || undefined, outletId: item.outlet?.id || undefined }
      groups[key].items.push(item)
    }

    return Object.entries(groups)
      .sort((a, b) => b[1].items.length - a[1].items.length)
      .map(([id, g]) => ({ id, ...g }))
  }, [coverageItems, timelineGroupBy, games, clients])

  const visibleSales = useMemo(() => {
    return salesEvents.filter(s => s.end_date >= dateFrom && s.start_date <= dateTo)
  }, [salesEvents, dateFrom, dateTo])

  const visibleCampaigns = useMemo(() => {
    return campaigns.filter(c => c.start_date && c.end_date && c.end_date! >= dateFrom && c.start_date! <= dateTo)
  }, [campaigns, dateFrom, dateTo])

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function getDayIndex(day: string): number {
    return daysBetween(dateFrom, day)
  }

  function getBarColor(item: TimelineCoverageItem): string {
    if (colorBy === 'tier') {
      const tier = item.outlet?.tier
      if (tier && TIER_COLORS[tier]) return TIER_COLORS[tier].bg
      return '#f3f4f6'
    }
    if (colorBy === 'type') return TYPE_COLORS[item.coverage_type || ''] || '#e2e8f0'
    if (colorBy === 'sentiment') {
      if (item.sentiment === 'positive') return '#dcfce7'
      if (item.sentiment === 'negative') return '#fee2e2'
      if (item.sentiment === 'mixed') return '#fef3c7'
      return '#f3f4f6'
    }
    return '#e2e8f0'
  }

  function getBarBorderColor(item: TimelineCoverageItem): string {
    if (colorBy === 'tier') {
      const tier = item.outlet?.tier
      if (tier && TIER_COLORS[tier]) return TIER_COLORS[tier].border
      return '#d1d5db'
    }
    if (colorBy === 'type') return TYPE_COLORS[item.coverage_type || ''] || '#94a3b8'
    if (colorBy === 'sentiment') {
      if (item.sentiment === 'positive') return '#86efac'
      if (item.sentiment === 'negative') return '#fca5a5'
      if (item.sentiment === 'mixed') return '#fde047'
      return '#d1d5db'
    }
    return '#d1d5db'
  }

  // ─── Annotation handlers ──────────────────────────────────────────────────

  const openAnnotationAt = useCallback((day: string, x: number, y: number, gameId?: string, outletName?: string) => {
    setAnnotationPopover({ day, x, y, gameId, outletName })
    setAnnotationForm({ event_type: 'pr_mention', outlet_or_source: outletName || '', observed_effect: 'unknown', confidence: 'suspected', notes: '', event_date: day })
    setEditingAnnotationId(null)
  }, [])

  const openEditAnnotation = useCallback((ann: Annotation, x: number, y: number) => {
    setAnnotationPopover({ day: ann.event_date, x, y })
    setAnnotationForm({
      event_type: ann.event_type,
      outlet_or_source: ann.outlet_or_source || '',
      observed_effect: ann.observed_effect,
      confidence: ann.confidence,
      notes: ann.notes || '',
      event_date: ann.event_date,
    })
    setEditingAnnotationId(ann.id)
  }, [])

  const saveAnnotation = useCallback(async () => {
    if (!annotationPopover) return
    setAnnotationSaving(true)
    try {
      const payload = {
        game_id: annotationPopover.gameId || gameFilter || null,
        client_id: clientFilter || null,
        event_type: annotationForm.event_type,
        event_date: annotationForm.event_date || annotationPopover.day,
        outlet_or_source: annotationForm.outlet_or_source || null,
        observed_effect: annotationForm.observed_effect,
        direction: 'pr_to_sales',
        confidence: annotationForm.confidence,
        notes: annotationForm.notes || null,
        is_auto_detected: false,
        updated_at: new Date().toISOString(),
      }
      if (editingAnnotationId) {
        await fetch('/api/pr-annotations', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: editingAnnotationId, ...payload }) })
      } else {
        await fetch('/api/pr-annotations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      }
      setAnnotationPopover(null)
      setEditingAnnotationId(null)
      setPendingAnnotationMarker(null)
      fetchAnnotations()
    } catch (err) { console.error('Save annotation failed:', err) }
    finally { setAnnotationSaving(false) }
  }, [annotationPopover, annotationForm, editingAnnotationId, gameFilter, clientFilter, fetchAnnotations])

  const deleteAnnotation = useCallback(async (id: string) => {
    try {
      await fetch('/api/pr-annotations', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
      setAnnotationPopover(null)
      setEditingAnnotationId(null)
      setPendingAnnotationMarker(null)
      fetchAnnotations()
    } catch (err) { console.error('Delete annotation failed:', err) }
  }, [fetchAnnotations])

  // Close popover on outside click / Esc
  useEffect(() => {
    if (!annotationPopover) return
    const handleClick = (e: MouseEvent) => {
      const el = document.getElementById('ann-popover')
      if (el && !el.contains(e.target as Node)) { setAnnotationPopover(null); setEditingAnnotationId(null); setPendingAnnotationMarker(null) }
    }
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setAnnotationPopover(null); setEditingAnnotationId(null); setPendingAnnotationMarker(null) }
    }
    setTimeout(() => { document.addEventListener('mousedown', handleClick); document.addEventListener('keydown', handleEsc) }, 50)
    return () => { document.removeEventListener('mousedown', handleClick); document.removeEventListener('keydown', handleEsc) }
  }, [annotationPopover])

  // Handle click on timeline row to add annotation
  const handleTimelineRowClick = useCallback((e: React.MouseEvent<HTMLDivElement>, row: typeof timelineRows[0]) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const relativeX = e.clientX - rect.left
    const dayIndex = Math.floor(relativeX / dayWidth)
    if (dayIndex < 0 || dayIndex >= allDays.length) return
    const day = allDays[dayIndex]
    setPendingAnnotationMarker({ day, rowId: row.gameId || row.label })
    openAnnotationAt(
      day, e.clientX, e.clientY,
      timelineGroupBy === 'game' ? row.gameId : undefined,
      timelineGroupBy === 'outlet' ? row.label : undefined,
    )
  }, [dayWidth, allDays, openAnnotationAt, timelineGroupBy])

  // Scroll to today
  const scrollToToday = useCallback(() => {
    if (!scrollRef.current) return
    const todayIdx = getDayIndex(formatDate(new Date()))
    const scrollPos = todayIdx * dayWidth - containerWidth / 2 + SIDEBAR_WIDTH
    scrollRef.current.scrollLeft = Math.max(0, scrollPos)
  }, [dayWidth, containerWidth])

  // ─── Zoom helpers ─────────────────────────────────────────────────────────

  const applyZoom = useCallback((idx: number) => {
    const level = ZOOM_LEVELS[idx]
    const today = new Date()
    const half = Math.floor(level.days / 2)
    const from = new Date(today); from.setDate(from.getDate() - half)
    const to = new Date(today); to.setDate(to.getDate() + half)
    setDateFrom(formatDate(from))
    setDateTo(formatDate(to))
    setZoomIndex(idx)
  }, [])

  // ─── Scroll-wheel zoom ───────────────────────────────────────────────────
  // Ctrl+scroll or pinch-to-zoom on the timeline area
  useEffect(() => {
    const el = scrollRef.current
    if (!el || viewMode !== 'timeline') return

    const handleWheel = (e: WheelEvent) => {
      // Only zoom on Ctrl+scroll (or pinch on trackpad which sends ctrlKey)
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()

      const currentDW = manualDayWidth !== null ? manualDayWidth : autoFitDayWidth
      const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15
      const newDW = Math.min(120, Math.max(2, currentDW * zoomFactor))

      // Zoom centered on cursor position
      const rect = el.getBoundingClientRect()
      const cursorX = e.clientX - rect.left // cursor position in scroll viewport
      const scrollLeft = el.scrollLeft
      const cursorDayPos = (scrollLeft + cursorX - SIDEBAR_WIDTH) / currentDW
      const newScrollLeft = cursorDayPos * newDW - cursorX + SIDEBAR_WIDTH

      setManualDayWidth(newDW)
      // Use requestAnimationFrame to apply scroll after render
      requestAnimationFrame(() => {
        el.scrollLeft = Math.max(0, newScrollLeft)
      })
    }

    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [viewMode, manualDayWidth, autoFitDayWidth])

  // Reset manual zoom when date range changes (from zoom buttons)
  const applyZoomAndReset = useCallback((idx: number) => {
    setManualDayWidth(null) // reset to auto-fit for new range
    applyZoom(idx)
  }, [applyZoom])

  // ─── Loading / Auth ───────────────────────────────────────────────────────

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

  // ─── Month headers computation ────────────────────────────────────────────

  const monthHeaders: { label: string; days: number; startIdx: number }[] = []
  if (allDays.length > 0) {
    let currentMonth = ''
    let startIdx = 0
    let count = 0
    for (let i = 0; i < allDays.length; i++) {
      const d = new Date(allDays[i])
      const month = d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
      if (month !== currentMonth) {
        if (currentMonth) monthHeaders.push({ label: currentMonth, days: count, startIdx })
        currentMonth = month
        startIdx = i
        count = 1
      } else {
        count++
      }
    }
    if (currentMonth) monthHeaders.push({ label: currentMonth, days: count, startIdx })
  }

  const todayStr = formatDate(new Date())
  const todayIdx = allDays.indexOf(todayStr)

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', height: '100vh', backgroundColor: '#f8fafc' }}>
      <Sidebar />

      <div ref={containerRef} style={{ flex: 1, padding: '24px 32px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          {/* Header */}
          <div style={{ marginBottom: '16px' }}>
            <h1 style={{ fontSize: '28px', fontWeight: 700, color: '#1e293b', margin: 0 }}>Coverage Timeline</h1>
            <p style={{ fontSize: '14px', color: '#64748b', margin: '4px 0 0 0' }}>
              PR coverage mapped across time with sales &amp; campaign overlays
            </p>
          </div>

          <CoverageNav />

          {/* Filter bar */}
          <div style={{
            display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center',
            backgroundColor: 'white', padding: '10px 14px', borderRadius: '10px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
          }}>
            {/* View mode tabs */}
            <div style={{ display: 'flex', borderRadius: '8px', overflow: 'hidden', border: '1px solid #e2e8f0' }}>
              {(['timeline', 'heatmap', 'table'] as const).map(mode => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  style={{
                    padding: '5px 14px', fontSize: '12px', fontWeight: 600, cursor: 'pointer', border: 'none',
                    backgroundColor: viewMode === mode ? '#1e293b' : 'white',
                    color: viewMode === mode ? 'white' : '#64748b',
                  }}
                >
                  {mode === 'timeline' ? 'Timeline' : mode === 'heatmap' ? 'Heatmap' : 'Table'}
                </button>
              ))}
            </div>

            <div style={{ width: '1px', height: '24px', backgroundColor: '#e2e8f0' }} />

            <select value={clientFilter} onChange={e => { setClientFilter(e.target.value); setGameFilter('') }}
              style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '12px', backgroundColor: 'white' }}>
              <option value="">All Clients</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select value={gameFilter} onChange={e => setGameFilter(e.target.value)}
              style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '12px', backgroundColor: 'white' }}>
              <option value="">All Games</option>
              {filteredGames.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>

            <div style={{ width: '1px', height: '24px', backgroundColor: '#e2e8f0' }} />

            <label style={{ fontSize: '11px', color: '#64748b' }}>From</label>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              style={{ padding: '5px 8px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '11px' }} />
            <label style={{ fontSize: '11px', color: '#64748b' }}>To</label>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              style={{ padding: '5px 8px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '11px' }} />

            <div style={{ flex: 1 }} />

            {viewMode === 'timeline' && (
              <select value={timelineGroupBy} onChange={e => setTimelineGroupBy(e.target.value as 'game' | 'outlet')}
                style={{ padding: '5px 8px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '11px', backgroundColor: 'white' }}>
                <option value="game">Group by Game</option>
                <option value="outlet">Group by Outlet</option>
              </select>
            )}

            <select value={colorBy} onChange={e => setColorBy(e.target.value as 'tier' | 'type' | 'sentiment')}
              style={{ padding: '5px 8px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '11px', backgroundColor: 'white' }}>
              <option value="tier">Color: Tier</option>
              <option value="type">Color: Type</option>
              <option value="sentiment">Color: Sentiment</option>
            </select>

            {['Sales', 'Campaigns', 'Annotations'].map((label, i) => {
              const states = [showSales, showCampaigns, showAnnotations]
              const setters = [setShowSales, setShowCampaigns, setShowAnnotations]
              const colors = [
                { active: '#dbeafe', text: '#1e40af', border: '#93c5fd' },
                { active: '#f3e8ff', text: '#7c3aed', border: '#c4b5fd' },
                { active: '#fef3c7', text: '#92400e', border: '#fde68a' },
              ]
              return (
                <button key={label} onClick={() => setters[i](!states[i])}
                  style={{
                    padding: '5px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 500, cursor: 'pointer',
                    backgroundColor: states[i] ? colors[i].active : 'white',
                    color: states[i] ? colors[i].text : '#64748b',
                    border: `1px solid ${states[i] ? colors[i].border : '#e2e8f0'}`,
                  }}
                >{label}</button>
              )
            })}
          </div>

          {/* Summary stats */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px', marginBottom: '16px' }}>
            {[
              { value: coverageItems.length, label: 'Coverage Items' },
              { value: new Set(coverageItems.map(i => i.publish_date?.split('T')[0]).filter(Boolean)).size, label: 'Days with Coverage' },
              { value: visibleSales.length, label: 'Overlapping Sales' },
              { value: formatNumber(coverageItems.reduce((s, i) => s + (i.monthly_unique_visitors || i.outlet?.monthly_unique_visitors || 0), 0)), label: 'Total Reach' },
            ].map((stat, i) => (
              <div key={i} style={{ backgroundColor: 'white', borderRadius: '10px', padding: '14px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                <div style={{ fontSize: '22px', fontWeight: 700, color: '#1e293b' }}>{stat.value}</div>
                <div style={{ fontSize: '11px', color: '#64748b' }}>{stat.label}</div>
              </div>
            ))}
          </div>

          {/* ═══════════════════════════════════════════════════════════════════
              TIMELINE VIEW (Gantt-style)
              ═══════════════════════════════════════════════════════════════════ */}
          {viewMode === 'timeline' && (
            <div ref={timelineCardRef} style={{ backgroundColor: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', overflow: 'hidden', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              {/* Zoom controls */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 16px',
                borderBottom: '1px solid #e2e8f0', fontSize: '12px',
              }}>
                <span style={{ color: '#64748b', fontWeight: 500 }}>Range:</span>
                <div style={{ display: 'flex', gap: '2px' }}>
                  {ZOOM_LEVELS.map((level, i) => (
                    <button key={level.label} onClick={() => applyZoomAndReset(i)}
                      style={{
                        padding: '3px 10px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, cursor: 'pointer',
                        backgroundColor: zoomIndex === i && manualDayWidth === null ? '#1e293b' : '#f1f5f9',
                        color: zoomIndex === i && manualDayWidth === null ? 'white' : '#64748b',
                        border: 'none',
                      }}
                    >{level.label}</button>
                  ))}
                </div>

                <div style={{ width: '1px', height: '18px', backgroundColor: '#e2e8f0' }} />

                <span style={{ color: '#64748b', fontWeight: 500 }}>Zoom:</span>
                <button onClick={() => {
                  const curr = manualDayWidth ?? autoFitDayWidth
                  setManualDayWidth(Math.min(120, curr * 1.3))
                }} style={{
                  padding: '2px 8px', borderRadius: '4px', fontSize: '13px', fontWeight: 700,
                  backgroundColor: '#f1f5f9', color: '#475569', border: 'none', cursor: 'pointer',
                }}>+</button>
                <button onClick={() => {
                  const curr = manualDayWidth ?? autoFitDayWidth
                  setManualDayWidth(Math.max(2, curr / 1.3))
                }} style={{
                  padding: '2px 8px', borderRadius: '4px', fontSize: '13px', fontWeight: 700,
                  backgroundColor: '#f1f5f9', color: '#475569', border: 'none', cursor: 'pointer',
                }}>−</button>
                <button onClick={() => setManualDayWidth(null)} style={{
                  padding: '3px 10px', borderRadius: '4px', fontSize: '11px', fontWeight: 500,
                  backgroundColor: manualDayWidth === null ? '#dbeafe' : '#f1f5f9',
                  color: manualDayWidth === null ? '#1e40af' : '#64748b',
                  border: 'none', cursor: 'pointer',
                }}>Fit</button>

                <div style={{ width: '1px', height: '18px', backgroundColor: '#e2e8f0' }} />

                <button onClick={scrollToToday} style={{
                  padding: '3px 10px', borderRadius: '4px', fontSize: '11px', fontWeight: 500,
                  backgroundColor: '#f1f5f9', color: '#64748b', border: 'none', cursor: 'pointer',
                }}>
                  Today
                </button>
                <div style={{ flex: 1 }} />
                <span style={{ color: '#94a3b8', fontSize: '11px' }}>
                  {coverageItems.length} items · {timelineRows.length} rows · Ctrl+scroll to zoom
                </span>
              </div>

              {/* Scrollable timeline area */}
              <div ref={scrollRef} style={{
                overflowX: 'auto', overflowY: 'auto',
                flex: 1, minHeight: 0,
              }}>
                <div style={{ width: manualDayWidth !== null ? totalWidth : '100%', minWidth: manualDayWidth !== null ? totalWidth : '100%', minHeight: '100%', position: 'relative', display: 'flex', flexDirection: 'column' }}>

                  {/* Month headers */}
                  <div style={{
                    display: 'flex', position: 'sticky', top: 0, zIndex: 20, backgroundColor: '#f8fafc',
                    borderBottom: '1px solid #e2e8f0',
                  }}>
                    <div style={{ minWidth: SIDEBAR_WIDTH, maxWidth: SIDEBAR_WIDTH, backgroundColor: '#f8fafc' }} />
                    {monthHeaders.map((m, i) => (
                      <div key={i} style={{
                        width: m.days * dayWidth, textAlign: 'center', padding: '6px 0',
                        fontSize: '11px', fontWeight: 600, color: '#475569',
                        borderRight: '1px solid #e2e8f0', backgroundColor: '#f8fafc',
                      }}>
                        {m.label}
                      </div>
                    ))}
                  </div>

                  {/* Day headers */}
                  {dayWidth >= 20 && (
                    <div style={{
                      display: 'flex', position: 'sticky', top: 28, zIndex: 20, backgroundColor: '#fafbfc',
                      borderBottom: '1px solid #e2e8f0',
                    }}>
                      <div style={{ minWidth: SIDEBAR_WIDTH, maxWidth: SIDEBAR_WIDTH, backgroundColor: '#fafbfc' }} />
                      {allDays.map((day, idx) => {
                        const d = new Date(day)
                        const isWeekend = d.getDay() === 0 || d.getDay() === 6
                        const isToday = day === todayStr
                        return (
                          <div key={idx} style={{
                            width: dayWidth, textAlign: 'center', padding: '3px 0',
                            fontSize: '9px', color: isToday ? '#f97316' : isWeekend ? '#94a3b8' : '#64748b',
                            fontWeight: isToday ? 700 : 400,
                            backgroundColor: isToday ? '#fff7ed' : isWeekend ? '#f8fafc' : '#fafbfc',
                            borderRight: '1px solid #f1f5f9',
                          }}>
                            {d.getDate()}
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {/* Campaign overlay lane */}
                  {showCampaigns && visibleCampaigns.length > 0 && (
                    <div style={{ display: 'flex', borderBottom: '1px solid #e9d5ff', backgroundColor: '#faf5ff' }}>
                      <div style={{
                        minWidth: SIDEBAR_WIDTH, maxWidth: SIDEBAR_WIDTH, padding: '4px 12px',
                        fontSize: '10px', fontWeight: 600, color: '#7c3aed', backgroundColor: '#faf5ff',
                        position: 'sticky', left: 0, zIndex: 10, display: 'flex', alignItems: 'center',
                      }}>
                        Campaigns
                      </div>
                      <div style={{ position: 'relative', height: `${Math.max(1, visibleCampaigns.length) * 22 + 4}px`, flex: 1 }}>
                        {visibleCampaigns.map((camp, i) => {
                          const leftIdx = Math.max(0, getDayIndex(camp.start_date!))
                          const endIdx = Math.min(allDays.length - 1, getDayIndex(camp.end_date!))
                          const left = leftIdx * dayWidth
                          const width = Math.max(dayWidth, (endIdx - leftIdx + 1) * dayWidth)
                          return (
                            <div key={camp.id} title={camp.name} style={{
                              position: 'absolute', left, width, top: i * 22 + 2, height: '18px',
                              backgroundColor: '#c4b5fd', borderRadius: '3px', fontSize: '9px', fontWeight: 500,
                              color: '#4c1d95', padding: '2px 6px', overflow: 'hidden', whiteSpace: 'nowrap',
                              textOverflow: 'ellipsis', border: '1px solid #a78bfa',
                            }}>
                              {dayWidth > 6 ? camp.name : ''}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Annotation lane */}
                  {showAnnotations && annotations.length > 0 && (
                    <div style={{ display: 'flex', borderBottom: '1px solid #fde68a', backgroundColor: '#fffbeb' }}>
                      <div style={{
                        minWidth: SIDEBAR_WIDTH, maxWidth: SIDEBAR_WIDTH, padding: '4px 12px',
                        fontSize: '10px', fontWeight: 600, color: '#92400e', backgroundColor: '#fffbeb',
                        position: 'sticky', left: 0, zIndex: 10, display: 'flex', alignItems: 'center',
                      }}>
                        Annotations
                      </div>
                      <div style={{ position: 'relative', height: '28px', flex: 1 }}>
                        {allDays.map((day, idx) => {
                          const anns = annotationsByDate[day]
                          if (!anns || anns.length === 0) return null
                          const isExpanded = expandedAnnotationDay === day
                          return (
                            <div
                              key={day}
                              style={{ position: 'absolute', left: idx * dayWidth + dayWidth / 2 - 8, top: 2, zIndex: isExpanded ? 30 : 20 }}
                            >
                              {/* Bookmark icon */}
                              <div
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setExpandedAnnotationDay(isExpanded ? null : day)
                                }}
                                onDoubleClick={(e) => { e.stopPropagation(); openEditAnnotation(anns[0], e.clientX, e.clientY) }}
                                style={{
                                  width: '16px', height: '20px', cursor: 'pointer',
                                  position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                }}
                                title={`${anns.length} annotation(s) — click to expand, double-click to edit`}
                              >
                                <svg width="16" height="20" viewBox="0 0 16 20" fill="none">
                                  <path d="M1 1h14v16.5L8 14l-7 3.5V1z" fill="#eab308" stroke="#ca8a04" strokeWidth="1.5" />
                                  {anns.length > 1 && (
                                    <text x="8" y="11" textAnchor="middle" fontSize="8" fontWeight="bold" fill="#713f12">
                                      {anns.length}
                                    </text>
                                  )}
                                </svg>
                              </div>
                              {/* Expanded popover */}
                              {isExpanded && (
                                <div
                                  onClick={(e) => e.stopPropagation()}
                                  style={{
                                    position: 'absolute', top: '22px', left: '50%', transform: 'translateX(-50%)',
                                    backgroundColor: '#fffef5', border: '1px solid #eab308', borderRadius: '6px',
                                    padding: '8px 10px', minWidth: '180px', maxWidth: '260px',
                                    boxShadow: '0 4px 12px rgba(0,0,0,0.12)', zIndex: 50,
                                  }}
                                >
                                  {anns.map((ann, i) => (
                                    <div
                                      key={ann.id}
                                      onClick={() => openEditAnnotation(ann, 0, 0)}
                                      style={{
                                        cursor: 'pointer', padding: '4px 0',
                                        borderBottom: i < anns.length - 1 ? '1px solid #fde68a' : 'none',
                                      }}
                                    >
                                      <div style={{ fontSize: '11px', fontWeight: 600, color: '#92400e' }}>
                                        {ann.event_type.replace(/_/g, ' ')}
                                      </div>
                                      {ann.notes && (
                                        <div style={{ fontSize: '10px', color: '#78716c', marginTop: '2px', lineHeight: 1.3 }}>
                                          {ann.notes.length > 80 ? ann.notes.slice(0, 80) + '…' : ann.notes}
                                        </div>
                                      )}
                                      {ann.outlet_or_source && (
                                        <div style={{ fontSize: '9px', color: '#a8a29e', marginTop: '1px' }}>
                                          {ann.outlet_or_source}
                                        </div>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Today line */}
                  {todayIdx >= 0 && (
                    <div style={{
                      position: 'absolute', left: SIDEBAR_WIDTH + todayIdx * dayWidth + dayWidth / 2,
                      top: 0, bottom: 0, width: '2px', backgroundColor: '#f97316', zIndex: 15,
                      pointerEvents: 'none', opacity: 0.6,
                    }} />
                  )}

                  {/* Timeline rows — flex container fills remaining space */}
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                  {timelineRows.map((row, rowIdx) => {
                    // Group items by day for stacking
                    const itemsByDay: Record<string, TimelineCoverageItem[]> = {}
                    for (const item of row.items) {
                      if (!item.publish_date) continue
                      const day = item.publish_date.split('T')[0]
                      if (!itemsByDay[day]) itemsByDay[day] = []
                      itemsByDay[day].push(item)
                    }
                    const maxStack = Math.max(1, ...Object.values(itemsByDay).map(arr => arr.length))
                    const rowH = Math.max(ROW_HEIGHT, Math.min(maxStack, 4) * 12 + 12)

                    // Sales for this row (match by game if grouped by game)
                    const rowSales = showSales ? visibleSales.filter(s => {
                      if (timelineGroupBy === 'game' && row.gameId) {
                        return s.product?.game?.id === row.gameId
                      }
                      return true // show all sales if grouped by outlet
                    }) : []

                    return (
                      <div key={row.id} style={{ display: 'flex', borderBottom: '1px solid #f1f5f9', flex: 1, minHeight: rowH }}>
                        {/* Row label (sticky) */}
                        <div style={{
                          minWidth: SIDEBAR_WIDTH, maxWidth: SIDEBAR_WIDTH, padding: '6px 12px',
                          position: 'sticky', left: 0, zIndex: 10, backgroundColor: 'white',
                          borderRight: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column',
                          justifyContent: 'center',
                        }}>
                          <div style={{ fontSize: '12px', fontWeight: 600, color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {row.label}
                          </div>
                          <div style={{ fontSize: '10px', color: '#94a3b8' }}>
                            {row.sublabel} · {row.items.length} items
                          </div>
                        </div>

                        {/* Row timeline area */}
                        <div
                          onClick={(e) => handleTimelineRowClick(e, row)}
                          style={{
                            position: 'relative', flex: 1, cursor: 'crosshair',
                            minWidth: allDays.length * dayWidth, minHeight: rowH,
                          }}
                        >
                          {/* Day cell backgrounds */}
                          {allDays.map((day, idx) => {
                            const d = new Date(day)
                            const isWeekend = d.getDay() === 0 || d.getDay() === 6
                            return (
                              <div key={idx} style={{
                                position: 'absolute', left: idx * dayWidth, top: 0, width: dayWidth, height: '100%',
                                backgroundColor: isWeekend ? '#fafbfc' : 'transparent',
                                borderRight: '1px solid #f8fafc',
                              }} />
                            )
                          })}

                          {/* Sale overlays */}
                          {rowSales.map(sale => {
                            const leftIdx = Math.max(0, getDayIndex(sale.start_date))
                            const endIdx = Math.min(allDays.length - 1, getDayIndex(sale.end_date))
                            const left = leftIdx * dayWidth
                            const width = Math.max(dayWidth, (endIdx - leftIdx + 1) * dayWidth)
                            return (
                              <div key={sale.id} title={`${sale.sale_name || sale.sale_type} — ${sale.product?.name || ''}`}
                                style={{
                                  position: 'absolute', left, width, top: 0, height: '100%',
                                  backgroundColor: '#3b82f6', opacity: 0.08, borderRadius: '2px',
                                  zIndex: 1,
                                }}
                              />
                            )
                          })}

                          {/* Coverage item bars */}
                          {Object.entries(itemsByDay).map(([day, items]) => {
                            const dayIdx = getDayIndex(day)
                            if (dayIdx < 0 || dayIdx >= allDays.length) return null
                            const left = dayIdx * dayWidth
                            const barWidth = Math.max(dayWidth - 1, 6)
                            return items.slice(0, 4).map((item, si) => (
                              <div
                                key={item.id}
                                onClick={(e) => { e.stopPropagation(); setSelectedItem(item) }}
                                title={`${item.title}\n${item.outlet?.name || ''} · ${item.coverage_type || ''}`}
                                style={{
                                  position: 'absolute', left: left + 1, width: barWidth,
                                  top: 4 + si * 11, height: Math.max(10, rowH - 8 - (Math.min(items.length, 4) - 1) * 11),
                                  backgroundColor: getBarColor(item),
                                  border: `1px solid ${getBarBorderColor(item)}`,
                                  borderRadius: '3px', cursor: 'pointer', zIndex: 3 + si,
                                  overflow: 'hidden', display: 'flex', alignItems: 'center', padding: '0 3px',
                                }}
                              >
                                {barWidth > 50 && (
                                  <span style={{ fontSize: '9px', fontWeight: 500, color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {item.outlet?.name || item.title.slice(0, 20)}
                                  </span>
                                )}
                              </div>
                            ))
                          })}

                          {/* Per-row annotation bookmark markers */}
                          {showAnnotations && allDays.map((day, idx) => {
                            const anns = annotationsByDate[day]
                            if (!anns) return null
                            // Filter annotations to this row
                            const rowAnns = anns.filter(a => {
                              if (timelineGroupBy === 'game' && row.gameId) return a.game_id === row.gameId
                              return true
                            })
                            if (rowAnns.length === 0) return null
                            const rowAnnKey = `${row.gameId || row.label}-${day}`
                            const isExpanded = expandedAnnotationDay === rowAnnKey
                            return (
                              <div
                                key={`ann-${day}`}
                                style={{
                                  position: 'absolute', left: idx * dayWidth + dayWidth / 2 - 7,
                                  bottom: 1, zIndex: isExpanded ? 30 : 5,
                                }}
                              >
                                <div
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setExpandedAnnotationDay(isExpanded ? null : rowAnnKey)
                                  }}
                                  onDoubleClick={(e) => { e.stopPropagation(); openEditAnnotation(rowAnns[0], e.clientX, e.clientY) }}
                                  style={{ cursor: 'pointer' }}
                                  title={`${rowAnns.length} annotation(s) — click to expand, double-click to edit`}
                                >
                                  <svg width="14" height="18" viewBox="0 0 16 20" fill="none">
                                    <path d="M1 1h14v16.5L8 14l-7 3.5V1z" fill="#eab308" stroke="#ca8a04" strokeWidth="1.5" />
                                    {rowAnns.length > 1 && (
                                      <text x="8" y="11" textAnchor="middle" fontSize="8" fontWeight="bold" fill="#713f12">
                                        {rowAnns.length}
                                      </text>
                                    )}
                                  </svg>
                                </div>
                                {isExpanded && (
                                  <div
                                    onClick={(e) => e.stopPropagation()}
                                    style={{
                                      position: 'absolute', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
                                      backgroundColor: '#fffef5', border: '1px solid #eab308', borderRadius: '6px',
                                      padding: '8px 10px', minWidth: '180px', maxWidth: '260px',
                                      boxShadow: '0 4px 12px rgba(0,0,0,0.12)', zIndex: 50,
                                    }}
                                  >
                                    {rowAnns.map((ann, i) => (
                                      <div
                                        key={ann.id}
                                        onClick={() => openEditAnnotation(ann, 0, 0)}
                                        style={{
                                          cursor: 'pointer', padding: '4px 0',
                                          borderBottom: i < rowAnns.length - 1 ? '1px solid #fde68a' : 'none',
                                        }}
                                      >
                                        <div style={{ fontSize: '11px', fontWeight: 600, color: '#92400e' }}>
                                          {ann.event_type.replace(/_/g, ' ')}
                                        </div>
                                        {ann.notes && (
                                          <div style={{ fontSize: '10px', color: '#78716c', marginTop: '2px', lineHeight: 1.3 }}>
                                            {ann.notes.length > 80 ? ann.notes.slice(0, 80) + '…' : ann.notes}
                                          </div>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )
                          })}

                          {/* Pending annotation bookmark (shown while creating) */}
                          {pendingAnnotationMarker && pendingAnnotationMarker.rowId === (row.gameId || row.label) && (() => {
                            const pendingIdx = allDays.indexOf(pendingAnnotationMarker.day)
                            if (pendingIdx < 0) return null
                            return (
                              <div
                                style={{
                                  position: 'absolute', left: pendingIdx * dayWidth + dayWidth / 2 - 8,
                                  top: '50%', transform: 'translateY(-50%)', zIndex: 25,
                                  animation: 'pulse 1.5s ease-in-out infinite',
                                }}
                              >
                                <svg width="16" height="20" viewBox="0 0 16 20" fill="none">
                                  <path d="M1 1h14v16.5L8 14l-7 3.5V1z" fill="#eab308" stroke="#ca8a04" strokeWidth="1.5" />
                                  <text x="8" y="12" textAnchor="middle" fontSize="10" fontWeight="bold" fill="#713f12">+</text>
                                </svg>
                              </div>
                            )
                          })()}
                        </div>
                      </div>
                    )
                  })}

                  {/* Empty state */}
                  {timelineRows.length === 0 && (
                    <div style={{ padding: '60px 20px', textAlign: 'center', color: '#94a3b8', flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      No coverage items found for this date range and filters.
                    </div>
                  )}
                  </div>{/* close rows flex wrapper */}
                </div>
              </div>

              {/* Legend */}
              <div style={{ display: 'flex', gap: '16px', padding: '10px 16px', borderTop: '1px solid #e2e8f0', fontSize: '10px', color: '#64748b', flexWrap: 'wrap' }}>
                {colorBy === 'tier' && Object.entries(TIER_COLORS).map(([tier, c]) => (
                  <div key={tier} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <div style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: c.bg, border: `1px solid ${c.border}` }} />
                    <span>Tier {tier}</span>
                  </div>
                ))}
                {colorBy === 'type' && Object.entries(TYPE_COLORS).slice(0, 8).map(([type, color]) => (
                  <div key={type} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <div style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: color, opacity: 0.6 }} />
                    <span>{type}</span>
                  </div>
                ))}
                {colorBy === 'sentiment' && [['positive', '#dcfce7'], ['neutral', '#f3f4f6'], ['negative', '#fee2e2'], ['mixed', '#fef3c7']].map(([l, c]) => (
                  <div key={l} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <div style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: c }} />
                    <span>{l}</span>
                  </div>
                ))}
                {showSales && <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><div style={{ width: '14px', height: '10px', backgroundColor: '#3b82f6', opacity: 0.15, borderRadius: '2px' }} /><span>Sale period</span></div>}
                {showAnnotations && <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><div style={{ width: '8px', height: '8px', backgroundColor: '#f59e0b', borderRadius: '50%' }} /><span>Annotation</span></div>}
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><div style={{ width: '2px', height: '10px', backgroundColor: '#f97316' }} /><span>Today</span></div>
              </div>

            </div>
          )}

          {/* ═══════════════════════════════════════════════════════════════════
              HEATMAP VIEW (calendar grid)
              ═══════════════════════════════════════════════════════════════════ */}
          {viewMode === 'heatmap' && (() => {
            const itemsByDate: Record<string, TimelineCoverageItem[]> = {}
            for (const item of coverageItems) {
              if (!item.publish_date) continue
              const day = item.publish_date.split('T')[0]
              if (!itemsByDate[day]) itemsByDate[day] = []
              itemsByDate[day].push(item)
            }
            const maxCount = Math.max(1, ...Object.values(itemsByDate).map(a => a.length))
            const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

            // Build weeks
            const weeks: string[][] = []
            let currentWeek: string[] = []
            if (allDays.length > 0) {
              const firstDow = new Date(allDays[0]).getDay() || 7
              for (let i = 1; i < firstDow; i++) currentWeek.push('')
              for (const day of allDays) {
                currentWeek.push(day)
                if (currentWeek.length === 7) { weeks.push(currentWeek); currentWeek = [] }
              }
              if (currentWeek.length > 0) {
                while (currentWeek.length < 7) currentWeek.push('')
                weeks.push(currentWeek)
              }
            }

            return (
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', flex: 1, overflow: 'auto' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#1e293b', marginBottom: '16px' }}>
                  Coverage Density — {coverageItems.length} items across {allDays.length} days
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px', marginBottom: '4px' }}>
                  {DAY_NAMES.map(d => (
                    <div key={d} style={{ fontSize: '10px', color: '#94a3b8', textAlign: 'center', fontWeight: 500 }}>{d}</div>
                  ))}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  {weeks.map((week, wi) => {
                    const firstOfMonth = week.find(d => d && d.endsWith('-01'))
                    return (
                      <div key={wi}>
                        {firstOfMonth && (
                          <div style={{ fontSize: '11px', fontWeight: 600, color: '#64748b', marginTop: wi > 0 ? '8px' : '0', marginBottom: '4px' }}>
                            {new Date(firstOfMonth).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                          </div>
                        )}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px' }}>
                          {week.map((day, di) => {
                            if (!day) return <div key={di} />
                            const items = itemsByDate[day] || []
                            const count = items.length
                            const intensity = count > 0 ? Math.min(1, count / maxCount) : 0
                            const isToday = day === todayStr
                            const anns = annotationsByDate[day]
                            const hasAnns = showAnnotations && anns && anns.length > 0
                            return (
                              <div key={di}
                                onDoubleClick={(e) => { e.preventDefault(); openAnnotationAt(day, e.clientX, e.clientY) }}
                                title={`${day}: ${count} item${count !== 1 ? 's' : ''}${hasAnns ? ` · ${anns!.length} annotation(s)` : ''}`}
                                style={{
                                  aspectRatio: '1', borderRadius: '4px', cursor: 'pointer', position: 'relative',
                                  backgroundColor: count > 0 ? `rgba(37, 99, 235, ${0.15 + intensity * 0.85})` : '#f8fafc',
                                  border: isToday ? '2px solid #f97316' : hasAnns ? '2px solid #f59e0b' : '1px solid #e2e8f0',
                                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                                  minHeight: '36px',
                                }}
                              >
                                <div style={{ fontSize: '10px', color: count > 0 ? '#1e293b' : '#94a3b8', fontWeight: isToday ? 700 : 400 }}>
                                  {new Date(day).getDate()}
                                </div>
                                {count > 0 && <div style={{ fontSize: '9px', fontWeight: 700, color: '#1e293b' }}>{count}</div>}
                                {hasAnns && (
                                  <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '3px', borderRadius: '0 0 3px 3px', backgroundColor: '#f59e0b' }} />
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>
                <div style={{ marginTop: '12px', fontSize: '10px', color: '#94a3b8', fontStyle: 'italic' }}>
                  Double-click any day to add annotation
                </div>
              </div>
            )
          })()}

          {/* ═══════════════════════════════════════════════════════════════════
              TABLE VIEW
              ═══════════════════════════════════════════════════════════════════ */}
          {viewMode === 'table' && (() => {
            const sorted = [...coverageItems].sort((a, b) => {
              const dir = tableSort.dir === 'asc' ? 1 : -1
              switch (tableSort.field) {
                case 'publish_date': return dir * ((a.publish_date || '').localeCompare(b.publish_date || ''))
                case 'outlet': return dir * ((a.outlet?.name || '').localeCompare(b.outlet?.name || ''))
                case 'type': return dir * ((a.coverage_type || '').localeCompare(b.coverage_type || ''))
                case 'reach': return dir * ((a.monthly_unique_visitors || 0) - (b.monthly_unique_visitors || 0))
                case 'sentiment': return dir * ((a.sentiment || '').localeCompare(b.sentiment || ''))
                case 'game': return dir * ((a.game?.name || '').localeCompare(b.game?.name || ''))
                default: return 0
              }
            })

            const toggleSort = (field: string) => {
              setTableSort(prev => ({ field, dir: prev.field === field && prev.dir === 'desc' ? 'asc' : 'desc' }))
            }

            const headerStyle = (field: string): React.CSSProperties => ({
              padding: '8px 12px', textAlign: 'left' as const, fontSize: '11px', fontWeight: 600,
              color: tableSort.field === field ? '#1e293b' : '#64748b',
              cursor: 'pointer', whiteSpace: 'nowrap' as const, borderBottom: '2px solid #e2e8f0',
              backgroundColor: '#f8fafc', position: 'sticky' as const, top: 0,
            })

            return (
              <div style={{ backgroundColor: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', overflow: 'hidden', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div style={{ overflowX: 'auto', flex: 1, minHeight: 0, overflowY: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '900px' }}>
                    <thead>
                      <tr>
                        <th style={headerStyle('publish_date')} onClick={() => toggleSort('publish_date')}>
                          Date {tableSort.field === 'publish_date' ? (tableSort.dir === 'asc' ? '↑' : '↓') : ''}
                        </th>
                        <th style={headerStyle('outlet')} onClick={() => toggleSort('outlet')}>
                          Outlet {tableSort.field === 'outlet' ? (tableSort.dir === 'asc' ? '↑' : '↓') : ''}
                        </th>
                        <th style={{ ...headerStyle(''), cursor: 'default' }}>Title</th>
                        <th style={headerStyle('type')} onClick={() => toggleSort('type')}>
                          Type {tableSort.field === 'type' ? (tableSort.dir === 'asc' ? '↑' : '↓') : ''}
                        </th>
                        <th style={headerStyle('game')} onClick={() => toggleSort('game')}>
                          Game {tableSort.field === 'game' ? (tableSort.dir === 'asc' ? '↑' : '↓') : ''}
                        </th>
                        <th style={headerStyle('sentiment')} onClick={() => toggleSort('sentiment')}>
                          Sentiment {tableSort.field === 'sentiment' ? (tableSort.dir === 'asc' ? '↑' : '↓') : ''}
                        </th>
                        <th style={headerStyle('reach')} onClick={() => toggleSort('reach')}>
                          Reach {tableSort.field === 'reach' ? (tableSort.dir === 'asc' ? '↑' : '↓') : ''}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.map(item => (
                        <tr key={item.id} style={{ borderBottom: '1px solid #f1f5f9', cursor: 'pointer' }}
                          onClick={() => setSelectedItem(item)}
                          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '#f8fafc' }}
                          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}
                        >
                          <td style={{ padding: '8px 12px', fontSize: '12px', color: '#64748b', whiteSpace: 'nowrap' }}>
                            {item.publish_date?.split('T')[0] || '—'}
                          </td>
                          <td style={{ padding: '8px 12px', fontSize: '12px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                              {item.outlet?.tier && (
                                <span style={{
                                  padding: '1px 5px', borderRadius: '6px', fontSize: '9px', fontWeight: 600,
                                  backgroundColor: TIER_COLORS[item.outlet.tier]?.bg, color: TIER_COLORS[item.outlet.tier]?.text,
                                }}>{item.outlet.tier}</span>
                              )}
                              <span style={{ fontWeight: 500, color: '#1e293b' }}>{item.outlet?.name || '—'}</span>
                            </div>
                          </td>
                          <td style={{ padding: '8px 12px', fontSize: '12px', color: '#1e293b', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            <a href={item.url} target="_blank" rel="noopener noreferrer" style={{ color: '#2563eb', textDecoration: 'none' }}>
                              {item.title}
                            </a>
                          </td>
                          <td style={{ padding: '8px 12px', fontSize: '11px' }}>
                            {item.coverage_type && (
                              <span style={{
                                padding: '2px 8px', borderRadius: '8px', fontWeight: 500,
                                backgroundColor: `${TYPE_COLORS[item.coverage_type] || '#e2e8f0'}20`,
                                color: TYPE_COLORS[item.coverage_type] || '#475569',
                              }}>{item.coverage_type}</span>
                            )}
                          </td>
                          <td style={{ padding: '8px 12px', fontSize: '12px', color: '#475569' }}>
                            {item.game?.name || '—'}
                          </td>
                          <td style={{ padding: '8px 12px', fontSize: '12px', color: SENTIMENT_COLORS[item.sentiment || ''] || '#64748b', fontWeight: 500 }}>
                            {item.sentiment || '—'}
                          </td>
                          <td style={{ padding: '8px 12px', fontSize: '12px', color: '#475569', textAlign: 'right' }}>
                            {formatNumber(item.monthly_unique_visitors || item.outlet?.monthly_unique_visitors || 0)}
                          </td>
                        </tr>
                      ))}
                      {sorted.length === 0 && (
                        <tr><td colSpan={7} style={{ padding: '40px', textAlign: 'center', color: '#94a3b8' }}>No coverage items found.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })()}
        </div>

        {/* ═══════════════════════════════════════════════════════════════════
            SELECTED ITEM DETAIL PANEL (floating)
            ═══════════════════════════════════════════════════════════════════ */}
        {selectedItem && (
          <div style={{
            position: 'fixed', top: '80px', right: '32px', width: '360px', maxHeight: 'calc(100vh - 120px)',
            overflow: 'auto', backgroundColor: 'white', borderRadius: '12px',
            boxShadow: '0 20px 60px rgba(0,0,0,0.15)', zIndex: 50, padding: '20px',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
              <a href={selectedItem.url} target="_blank" rel="noopener noreferrer"
                style={{ fontSize: '15px', fontWeight: 600, color: '#2563eb', textDecoration: 'none', flex: 1 }}>
                {selectedItem.title}
              </a>
              <button onClick={() => setSelectedItem(null)}
                style={{ background: 'none', border: 'none', fontSize: '18px', color: '#94a3b8', cursor: 'pointer', marginLeft: '8px' }}>
                ×
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px' }}>
              {selectedItem.outlet && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#64748b' }}>Outlet</span>
                  <span style={{ fontWeight: 500 }}>
                    {selectedItem.outlet.name}
                    {selectedItem.outlet.tier && (
                      <span style={{ marginLeft: '6px', padding: '1px 6px', borderRadius: '8px', fontSize: '10px', fontWeight: 600, backgroundColor: TIER_COLORS[selectedItem.outlet.tier]?.bg, color: TIER_COLORS[selectedItem.outlet.tier]?.text }}>
                        {selectedItem.outlet.tier}
                      </span>
                    )}
                  </span>
                </div>
              )}
              {selectedItem.publish_date && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#64748b' }}>Date</span>
                  <span style={{ fontWeight: 500 }}>{selectedItem.publish_date.split('T')[0]}</span>
                </div>
              )}
              {selectedItem.coverage_type && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#64748b' }}>Type</span>
                  <span style={{ padding: '1px 8px', borderRadius: '8px', fontSize: '11px', fontWeight: 500, backgroundColor: `${TYPE_COLORS[selectedItem.coverage_type] || '#e2e8f0'}20`, color: TYPE_COLORS[selectedItem.coverage_type] || '#475569' }}>
                    {selectedItem.coverage_type}
                  </span>
                </div>
              )}
              {selectedItem.sentiment && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#64748b' }}>Sentiment</span>
                  <span style={{ color: SENTIMENT_COLORS[selectedItem.sentiment] || '#64748b', fontWeight: 500 }}>{selectedItem.sentiment}</span>
                </div>
              )}
              {selectedItem.review_score && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#64748b' }}>Score</span>
                  <span style={{ fontWeight: 600, color: selectedItem.review_score >= 80 ? '#16a34a' : selectedItem.review_score >= 60 ? '#ca8a04' : '#dc2626' }}>{selectedItem.review_score}/100</span>
                </div>
              )}
              {(selectedItem.monthly_unique_visitors || selectedItem.outlet?.monthly_unique_visitors) && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#64748b' }}>Reach</span>
                  <span style={{ fontWeight: 500 }}>{formatNumber(selectedItem.monthly_unique_visitors || selectedItem.outlet?.monthly_unique_visitors || 0)}</span>
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
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════
            ANNOTATION POPOVER
            ═══════════════════════════════════════════════════════════════════ */}
        {annotationPopover && (
          <div id="ann-popover" style={{
            position: 'fixed',
            left: Math.min(annotationPopover.x, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 340),
            ...((typeof window !== 'undefined' && annotationPopover.y > window.innerHeight - 500)
              ? { bottom: Math.max(8, window.innerHeight - annotationPopover.y) }
              : { top: annotationPopover.y }),
            width: '320px', maxHeight: 'calc(100vh - 16px)', backgroundColor: 'white', borderRadius: '12px',
            boxShadow: '0 20px 60px rgba(0,0,0,0.2), 0 0 0 1px rgba(0,0,0,0.05)', zIndex: 1000,
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}>
            <div style={{ padding: '10px 16px', backgroundColor: '#fffbeb', borderBottom: '1px solid #fde68a', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 600, color: '#92400e' }}>{editingAnnotationId ? 'Edit Annotation' : 'Add Annotation'}</div>
                <div style={{ fontSize: '11px', color: '#b45309' }}>
                  {new Date((annotationForm.event_date || annotationPopover.day) + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                </div>
              </div>
              <button onClick={() => { setAnnotationPopover(null); setEditingAnnotationId(null); setPendingAnnotationMarker(null) }}
                style={{ background: 'none', border: 'none', fontSize: '18px', color: '#92400e', cursor: 'pointer' }}>×</button>
            </div>

            <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '10px', overflowY: 'auto', flex: 1 }}>
              <div>
                <label style={{ fontSize: '11px', fontWeight: 600, color: '#64748b', display: 'block', marginBottom: '3px' }}>Date</label>
                <input type="date" value={annotationForm.event_date} onChange={e => setAnnotationForm(f => ({ ...f, event_date: e.target.value }))}
                  style={{ width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid #e2e8f0', fontSize: '12px', boxSizing: 'border-box' }} />
              </div>

              <div>
                <label style={{ fontSize: '11px', fontWeight: 600, color: '#64748b', display: 'block', marginBottom: '3px' }}>Event Type</label>
                <select value={annotationForm.event_type} onChange={e => setAnnotationForm(f => ({ ...f, event_type: e.target.value }))}
                  style={{ width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid #e2e8f0', fontSize: '12px', backgroundColor: 'white' }}>
                  <option value="pr_mention">PR Mention</option>
                  <option value="influencer_play">Influencer Play</option>
                  <option value="steam_sale">Steam Sale</option>
                  <option value="steam_event">Steam Event</option>
                  <option value="bundle">Bundle</option>
                  <option value="epic_free">Epic Free</option>
                  <option value="press_interview">Press Interview</option>
                  <option value="other">Other</option>
                </select>
              </div>

              <div>
                <label style={{ fontSize: '11px', fontWeight: 600, color: '#64748b', display: 'block', marginBottom: '3px' }}>Outlet / Source</label>
                <input type="text" value={annotationForm.outlet_or_source} onChange={e => setAnnotationForm(f => ({ ...f, outlet_or_source: e.target.value }))}
                  placeholder='e.g. "IGN", "Steam Puzzle Fest"'
                  style={{ width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid #e2e8f0', fontSize: '12px', boxSizing: 'border-box' }} />
              </div>

              <div>
                <label style={{ fontSize: '11px', fontWeight: 600, color: '#64748b', display: 'block', marginBottom: '3px' }}>Observed Effect</label>
                <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                  {[
                    { value: 'sales_spike', label: 'Sales Spike', color: '#16a34a', bg: '#dcfce7' },
                    { value: 'wishlist_spike', label: 'Wishlists', color: '#2563eb', bg: '#dbeafe' },
                    { value: 'pr_pickup', label: 'PR Pickup', color: '#7c3aed', bg: '#ede9fe' },
                    { value: 'none', label: 'No Effect', color: '#64748b', bg: '#f1f5f9' },
                    { value: 'unknown', label: 'Unknown', color: '#94a3b8', bg: '#f8fafc' },
                  ].map(eff => (
                    <button key={eff.value} onClick={() => setAnnotationForm(f => ({ ...f, observed_effect: eff.value }))}
                      style={{
                        padding: '3px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: 500, cursor: 'pointer',
                        backgroundColor: annotationForm.observed_effect === eff.value ? eff.bg : 'white',
                        color: annotationForm.observed_effect === eff.value ? eff.color : '#94a3b8',
                        border: `1px solid ${annotationForm.observed_effect === eff.value ? eff.color + '40' : '#e2e8f0'}`,
                      }}>{eff.label}</button>
                  ))}
                </div>
              </div>

              <div>
                <label style={{ fontSize: '11px', fontWeight: 600, color: '#64748b', display: 'block', marginBottom: '3px' }}>Confidence</label>
                <div style={{ display: 'flex', gap: '4px' }}>
                  {[
                    { value: 'confirmed', label: 'Confirmed', color: '#166534', bg: '#dcfce7' },
                    { value: 'suspected', label: 'Suspected', color: '#854d0e', bg: '#fef9c3' },
                    { value: 'ruled_out', label: 'Ruled Out', color: '#991b1b', bg: '#fee2e2' },
                  ].map(conf => (
                    <button key={conf.value} onClick={() => setAnnotationForm(f => ({ ...f, confidence: conf.value }))}
                      style={{
                        flex: 1, padding: '4px 8px', borderRadius: '6px', fontSize: '11px', fontWeight: 500, cursor: 'pointer',
                        backgroundColor: annotationForm.confidence === conf.value ? conf.bg : 'white',
                        color: annotationForm.confidence === conf.value ? conf.color : '#94a3b8',
                        border: `1px solid ${annotationForm.confidence === conf.value ? conf.color + '40' : '#e2e8f0'}`,
                      }}>{conf.label}</button>
                  ))}
                </div>
              </div>

              <div>
                <label style={{ fontSize: '11px', fontWeight: 600, color: '#64748b', display: 'block', marginBottom: '3px' }}>Notes (optional)</label>
                <textarea value={annotationForm.notes} onChange={e => setAnnotationForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="Quick note about this insight..." rows={2}
                  style={{ width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid #e2e8f0', fontSize: '12px', resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit' }} />
              </div>
            </div>

            <div style={{ padding: '10px 16px', borderTop: '1px solid #f1f5f9', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
              {editingAnnotationId ? (
                <button onClick={() => deleteAnnotation(editingAnnotationId)}
                  style={{ padding: '6px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 500, cursor: 'pointer', backgroundColor: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca' }}>
                  Delete
                </button>
              ) : <div />}
              <div style={{ display: 'flex', gap: '6px' }}>
                <button onClick={() => { setAnnotationPopover(null); setEditingAnnotationId(null); setPendingAnnotationMarker(null) }}
                  style={{ padding: '6px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 500, cursor: 'pointer', backgroundColor: 'white', color: '#64748b', border: '1px solid #e2e8f0' }}>
                  Cancel
                </button>
                <button onClick={saveAnnotation} disabled={annotationSaving}
                  style={{
                    padding: '6px 16px', borderRadius: '6px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                    backgroundColor: '#f59e0b', color: 'white', border: '1px solid #f59e0b',
                    opacity: annotationSaving ? 0.6 : 1,
                  }}>
                  {annotationSaving ? 'Saving...' : editingAnnotationId ? 'Update' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
