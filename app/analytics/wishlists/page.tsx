'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import { Sidebar } from '../../components/Sidebar'
import { useAuth } from '@/lib/auth-context'

interface WishlistRow {
  id: string
  game_id: string
  client_id: string
  date: string
  total_wishlists: number | null
  additions: number | null
  deletions: number | null
  purchases_and_activations: number | null
  gifts: number | null
  source: string
  game?: { id: string; name: string } | null
}

interface BundleRow {
  id: string
  game_id: string
  client_id: string
  bundle_id: string | null
  bundle_name: string
  date: string
  gross_units: number
  net_units: number
  gross_revenue_usd: number
  net_revenue_usd: number
  source: string
  api_unavailable_reason: string | null
  game?: { id: string; name: string } | null
}

interface WishlistSummary {
  total_wishlists: number
  total_rows: number
  total_additions: number
  total_deletions: number
  total_purchases: number
}

interface BundleSummary {
  total_bundles: number
  total_rows: number
  total_gross_units: number
  total_net_units: number
  total_gross_revenue: number
  total_net_revenue: number
  bundle_names: string[]
  api_limitation: string
}

function formatNumber(n: number | null | undefined): string {
  if (n == null) return '—'
  return n.toLocaleString()
}

function formatCurrency(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(n)
}

function WishlistChart({ data, storePageLiveDate }: { data: WishlistRow[]; storePageLiveDate?: string | null }) {
  if (data.length < 2) return null

  // Sort by date ascending for the chart
  const sorted = [...data].sort((a, b) => a.date.localeCompare(b.date))
  const W = 1100
  const H = 280
  const PAD = { top: 20, right: 20, bottom: 50, left: 60 }
  const chartW = W - PAD.left - PAD.right
  const chartH = H - PAD.top - PAD.bottom

  // X-axis is anchored to store_page_live_date if it exists and falls before the first
  // wishlist data row — that way pre-release wishlist growth shows the full timeline.
  const firstDataDate = sorted[0].date
  const lastDataDate = sorted[sorted.length - 1].date
  const anchorBeforeData = !!(storePageLiveDate && storePageLiveDate < firstDataDate)
  const xMinDate = anchorBeforeData ? storePageLiveDate! : firstDataDate
  const xMaxDate = lastDataDate
  // Convert dates to ms for linear positioning when we have an anchor that's outside data range
  const dateToMs = (d: string) => new Date(d + 'T00:00:00').getTime()
  const xMinMs = dateToMs(xMinDate)
  const xMaxMs = dateToMs(xMaxDate)
  const xRangeMs = Math.max(1, xMaxMs - xMinMs)
  const dateToX = (d: string) => PAD.left + ((dateToMs(d) - xMinMs) / xRangeMs) * chartW

  const maxAdds = Math.max(...sorted.map(r => r.additions || 0), 1)
  const maxDel = Math.max(...sorted.map(r => r.deletions || 0), 1)
  const maxPurch = Math.max(...sorted.map(r => r.purchases_and_activations || 0), 1)
  const maxVal = Math.max(maxAdds, maxDel, maxPurch)

  // Round up to a nice number
  const niceMax = Math.ceil(maxVal / 100) * 100

  const yScale = (v: number) => PAD.top + chartH - (v / niceMax) * chartH

  const makePath = (key: 'additions' | 'deletions' | 'purchases_and_activations') => {
    return sorted.map((r, i) => {
      const x = dateToX(r.date)
      const y = yScale((r[key] as number) || 0)
      return `${i === 0 ? 'M' : 'L'}${x},${y}`
    }).join(' ')
  }

  const makeArea = (key: 'additions' | 'deletions' | 'purchases_and_activations') => {
    const line = sorted.map((r, i) => {
      const x = dateToX(r.date)
      const y = yScale((r[key] as number) || 0)
      return `${i === 0 ? 'M' : 'L'}${x},${y}`
    }).join(' ')
    const lastX = dateToX(sorted[sorted.length - 1].date)
    const firstX = dateToX(sorted[0].date)
    return `${line} L${lastX},${PAD.top + chartH} L${firstX},${PAD.top + chartH} Z`
  }

  // Y-axis labels
  const yTicks = 5
  const yLabels = Array.from({ length: yTicks + 1 }, (_, i) => Math.round(niceMax * (i / yTicks)))

  // X-axis labels — show ~8 evenly spaced dates
  const xLabelCount = Math.min(8, sorted.length)
  const xLabelStep = Math.max(1, Math.floor(sorted.length / xLabelCount))

  return (
    <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: '16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <h3 style={{ fontSize: '15px', fontWeight: 600, color: '#1e293b', margin: 0 }}>Wishlist Activity Over Time</h3>
        <div style={{ display: 'flex', gap: '16px', fontSize: '12px' }}>
          <span><span style={{ display: 'inline-block', width: 12, height: 3, backgroundColor: '#16a34a', borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }}></span>Additions</span>
          <span><span style={{ display: 'inline-block', width: 12, height: 3, backgroundColor: '#dc2626', borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }}></span>Deletions</span>
          <span><span style={{ display: 'inline-block', width: 12, height: 3, backgroundColor: '#2563eb', borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }}></span>Purchases</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxHeight: '300px' }}>
        {/* Grid lines */}
        {yLabels.map((v, i) => {
          const y = yScale(v)
          return (
            <g key={i}>
              <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} stroke="#f1f5f9" strokeWidth={1} />
              <text x={PAD.left - 8} y={y + 4} textAnchor="end" fontSize={10} fill="#94a3b8">{v >= 1000 ? `${(v/1000).toFixed(v >= 10000 ? 0 : 1)}k` : v}</text>
            </g>
          )
        })}

        {/* Area fills */}
        <path d={makeArea('additions')} fill="#16a34a" opacity={0.08} />
        <path d={makeArea('purchases_and_activations')} fill="#2563eb" opacity={0.08} />

        {/* Lines */}
        <path d={makePath('additions')} fill="none" stroke="#16a34a" strokeWidth={2} />
        <path d={makePath('deletions')} fill="none" stroke="#dc2626" strokeWidth={1.5} strokeDasharray="4 2" />
        <path d={makePath('purchases_and_activations')} fill="none" stroke="#2563eb" strokeWidth={2} />

        {/* X-axis labels */}
        {sorted.map((r, i) => {
          if (i % xLabelStep !== 0 && i !== sorted.length - 1) return null
          const x = dateToX(r.date)
          const d = new Date(r.date + 'T00:00:00')
          const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          return (
            <text key={i} x={x} y={H - 10} textAnchor="middle" fontSize={10} fill="#94a3b8">{label}</text>
          )
        })}

        {/* Store-page-live anchor marker */}
        {anchorBeforeData && storePageLiveDate && (
          <g>
            <line
              x1={dateToX(storePageLiveDate)}
              y1={PAD.top}
              x2={dateToX(storePageLiveDate)}
              y2={PAD.top + chartH}
              stroke="#7c3aed"
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
            <text
              x={dateToX(storePageLiveDate) + 4}
              y={PAD.top + 12}
              fontSize={10}
              fill="#7c3aed"
              fontWeight={600}
            >
              Store page live
            </text>
          </g>
        )}
      </svg>
    </div>
  )
}

const TABS = ['Wishlists', 'Bundles', 'Demo'] as const
type Tab = typeof TABS[number]

interface GameMeta {
  id: string
  name: string
  client_id: string
  steam_app_id: string | null
  release_date: string | null
  store_page_live_date: string | null
  store_page_live_date_source: 'manual' | 'auto' | null
}

interface DemoProduct {
  id: string
  name: string
  steam_product_id: string | null
  launch_date: string | null
}

interface DemoDailyPoint {
  date: string
  downloads: number
  wishlist_adds: number
}

export default function WishlistsPage() {
  const supabase = createClientComponentClient()
  const { hasAccess, loading: authLoading } = useAuth()
  const canView = hasAccess('analytics', 'view')
  const canEdit = hasAccess('analytics', 'edit')

  const [activeTab, setActiveTab] = useState<Tab>('Wishlists')
  const [clients, setClients] = useState<{ id: string; name: string }[]>([])
  const [games, setGames] = useState<GameMeta[]>([])
  const [selectedClient, setSelectedClient] = useState('')
  const [selectedGame, setSelectedGame] = useState('')

  // Store-page-live-date editor state
  const [editingStoreDate, setEditingStoreDate] = useState(false)
  const [storeDateInput, setStoreDateInput] = useState('')
  const [storeDateSaving, setStoreDateSaving] = useState(false)

  // Demo tab state
  const [demoProducts, setDemoProducts] = useState<DemoProduct[]>([])
  const [selectedDemoId, setSelectedDemoId] = useState('')
  const [demoSeries, setDemoSeries] = useState<DemoDailyPoint[]>([])
  const [demoLoading, setDemoLoading] = useState(false)
  const [demoCoverageCount, setDemoCoverageCount] = useState<number | null>(null)
  // Demo window: smart-defaults to [demo.launch_date, MIN(game.release_date, today)] but
  // users can override either end. Stored as YYYY-MM-DD strings; '' = use default.
  const [demoWindowStart, setDemoWindowStart] = useState('')
  const [demoWindowEnd, setDemoWindowEnd] = useState('')

  // Historical activation backfill — until 2026-05-12 the Steam sync threw away
  // gross_units_activated, so every existing row has 0. This calls a server endpoint
  // that re-fetches Steam data and UPDATEs the column on existing rows.
  const [backfillRunning, setBackfillRunning] = useState(false)
  const [backfillProgress, setBackfillProgress] = useState<string | null>(null)
  const [backfillStartDate, setBackfillStartDate] = useState<string | null>(null)

  // Wishlist state
  const [wishlistData, setWishlistData] = useState<WishlistRow[]>([])
  const [wishlistSummary, setWishlistSummary] = useState<WishlistSummary | null>(null)
  const [wlLoading, setWlLoading] = useState(false)
  const [wlUploading, setWlUploading] = useState(false)
  const [wlUploadResult, setWlUploadResult] = useState<string | null>(null)

  // Steam API sync
  const [wlSyncing, setWlSyncing] = useState(false)
  const [wlSyncResult, setWlSyncResult] = useState<string | null>(null)
  const [steamApiAvailable, setSteamApiAvailable] = useState<boolean | null>(null)

  // Manual add
  const [showAddWl, setShowAddWl] = useState(false)
  const [addWlDate, setAddWlDate] = useState('')
  const [addWlTotal, setAddWlTotal] = useState('')
  const [addWlAdditions, setAddWlAdditions] = useState('')
  const [addWlDeletions, setAddWlDeletions] = useState('')
  const [addWlPurchases, setAddWlPurchases] = useState('')

  // Bundle state
  const [bundleData, setBundleData] = useState<BundleRow[]>([])
  const [bundleSummary, setBundleSummary] = useState<BundleSummary | null>(null)
  const [blLoading, setBlLoading] = useState(false)
  const [blUploading, setBlUploading] = useState(false)
  const [blUploadResult, setBlUploadResult] = useState<string | null>(null)

  // Manual add bundle
  const [showAddBl, setShowAddBl] = useState(false)
  const [addBlDate, setAddBlDate] = useState('')
  const [addBlName, setAddBlName] = useState('')
  const [addBlGrossUnits, setAddBlGrossUnits] = useState('')
  const [addBlNetUnits, setAddBlNetUnits] = useState('')
  const [addBlGrossRev, setAddBlGrossRev] = useState('')
  const [addBlNetRev, setAddBlNetRev] = useState('')

  // Load clients and games
  useEffect(() => {
    supabase.from('clients').select('id, name').order('name').then(({ data }) => {
      if (data) setClients(data)
    })
  }, [supabase])

  useEffect(() => {
    if (!selectedClient) { setGames([]); return }
    supabase
      .from('games')
      .select('id, name, client_id, steam_app_id, release_date, store_page_live_date, store_page_live_date_source')
      .eq('client_id', selectedClient)
      .order('name')
      .then(({ data }) => {
        if (data) setGames(data as GameMeta[])
      })
  }, [selectedClient, supabase])

  const selectedGameMeta: GameMeta | null = games.find(g => g.id === selectedGame) || null

  // Reset store-date editor whenever the selected game changes
  useEffect(() => {
    setEditingStoreDate(false)
    setStoreDateInput(selectedGameMeta?.store_page_live_date || '')
  }, [selectedGame, selectedGameMeta?.store_page_live_date])

  const refreshSelectedGame = useCallback(async () => {
    if (!selectedGame) return
    const { data } = await supabase
      .from('games')
      .select('id, name, client_id, steam_app_id, release_date, store_page_live_date, store_page_live_date_source')
      .eq('id', selectedGame)
      .single()
    if (data) {
      setGames(prev => prev.map(g => g.id === data.id ? (data as GameMeta) : g))
    }
  }, [selectedGame, supabase])

  const runBackfillBatch = useCallback(async () => {
    if (!selectedClient || backfillRunning) return
    setBackfillRunning(true)
    setBackfillProgress('Fetching from Steam…')
    try {
      const res = await fetch('/api/steam-sync/backfill-activations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: selectedClient,
          start_date: backfillStartDate,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setBackfillProgress(`Error: ${json.error || 'unknown'}`)
      } else {
        const msg = `Backfilled ${json.dates_processed} dates (${json.rows_updated} rows updated).` +
          (json.has_more ? ` ${json.remaining_dates} dates remain — click again to continue.` : ' Backfill complete.')
        setBackfillProgress(msg)
        if (json.has_more && json.next_start_date) {
          setBackfillStartDate(json.next_start_date)
        } else {
          setBackfillStartDate(null)
          // Refetch the demo widget's data so the new numbers show up
          if (activeTab === 'Demo') {
            // touch the demo refresh by toggling state
            setSelectedDemoId(prev => prev)
          }
        }
      }
    } catch (err) {
      setBackfillProgress(`Network error: ${err instanceof Error ? err.message : String(err)}`)
    }
    setBackfillRunning(false)
  }, [selectedClient, backfillStartDate, backfillRunning, activeTab])

  const handleSaveStoreDate = async () => {
    if (!selectedGame) return
    setStoreDateSaving(true)
    try {
      const res = await fetch('/api/games', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: selectedGame, store_page_live_date: storeDateInput || null }),
      })
      if (res.ok) {
        await refreshSelectedGame()
        setEditingStoreDate(false)
      }
    } catch (err) {
      console.error('Failed to save store_page_live_date:', err)
    }
    setStoreDateSaving(false)
  }

  const fetchWishlists = useCallback(async () => {
    if (!selectedGame) return
    setWlLoading(true)
    try {
      const params = new URLSearchParams({ game_id: selectedGame })
      const res = await fetch(`/api/steam-wishlists?${params}`)
      if (res.ok) {
        const json = await res.json()
        setWishlistData(json.data || [])
        setWishlistSummary(json.summary)
      }
    } catch (err) {
      console.error('Failed to fetch wishlists:', err)
    }
    setWlLoading(false)
  }, [selectedGame])

  const fetchBundles = useCallback(async () => {
    if (!selectedGame) return
    setBlLoading(true)
    try {
      const params = new URLSearchParams({ game_id: selectedGame })
      const res = await fetch(`/api/steam-bundles?${params}`)
      if (res.ok) {
        const json = await res.json()
        setBundleData(json.data || [])
        setBundleSummary(json.summary)
      }
    } catch (err) {
      console.error('Failed to fetch bundles:', err)
    }
    setBlLoading(false)
  }, [selectedGame])

  // Check if Steam wishlist API is available for this client
  useEffect(() => {
    if (!selectedClient) { setSteamApiAvailable(null); return }
    fetch(`/api/cron/steam-wishlist-sync?client_id=${selectedClient}`)
      .then(r => r.json())
      .then(json => setSteamApiAvailable(json.available === true))
      .catch(() => setSteamApiAvailable(false))
  }, [selectedClient])

  const handleSteamSync = async () => {
    if (!selectedClient || wlSyncing) return
    setWlSyncing(true)
    setWlSyncResult(null)
    try {
      const payload: Record<string, string> = { client_id: selectedClient }
      if (selectedGame) payload.game_id = selectedGame
      const res = await fetch('/api/cron/steam-wishlist-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      if (res.ok) {
        setWlSyncResult(json.message || `Imported ${json.totalImported} rows`)
        if (selectedGame) fetchWishlists()
      } else {
        setWlSyncResult(`Error: ${json.error}`)
      }
    } catch { setWlSyncResult('Network error during sync') }
    setWlSyncing(false)
  }

  useEffect(() => {
    if (selectedGame && activeTab === 'Wishlists') fetchWishlists()
    if (selectedGame && activeTab === 'Bundles') fetchBundles()
  }, [selectedGame, activeTab, fetchWishlists, fetchBundles])

  // Load demo products for the selected game whenever the game changes
  useEffect(() => {
    if (!selectedGame) { setDemoProducts([]); setSelectedDemoId(''); return }
    fetch(`/api/products?game_id=${selectedGame}`)
      .then(r => r.json())
      .then((products: Array<{ id: string; name: string; product_type: string; steam_product_id: string | null; launch_date: string | null }>) => {
        const demos = products
          .filter(p => p.product_type === 'demo')
          .map(p => ({ id: p.id, name: p.name, steam_product_id: p.steam_product_id, launch_date: p.launch_date }))
        setDemoProducts(demos)
        setSelectedDemoId(prev => demos.find(d => d.id === prev) ? prev : (demos[0]?.id || ''))
      })
      .catch(err => console.error('Failed to load demo products:', err))
  }, [selectedGame])

  const selectedDemo = demoProducts.find(d => d.id === selectedDemoId) || null

  // Demo window defaults: [demo.launch_date, MIN(game.release_date, today)]. User overrides
  // win. Both ends are inclusive and clamped to YYYY-MM-DD.
  const today = new Date().toISOString().split('T')[0]
  const defaultDemoWindowStart = selectedDemo?.launch_date || ''
  const defaultDemoWindowEnd = (() => {
    const release = selectedGameMeta?.release_date
    // If the game is released and that date is in the past, that's the window end.
    // Otherwise the demo is still arguably driving wishlists, so use today.
    if (release && release <= today) return release
    return today
  })()
  const effectiveDemoWindowStart = demoWindowStart || defaultDemoWindowStart
  const effectiveDemoWindowEnd = demoWindowEnd || defaultDemoWindowEnd

  // Reset window when demo product changes
  useEffect(() => {
    setDemoWindowStart('')
    setDemoWindowEnd('')
  }, [selectedDemoId])

  // Build the Demo widget's data series from existing sources:
  //   - activations = sum(gross_units_activated) per day from analytics_data_view filtered to
  //     the demo product's name. Steam reports free-demo installs in this field, not in
  //     gross_units_sold (which is zero for free products).
  //   - wishlist_adds = additions on the parent game during the same window
  //   - coverage count = coverage_items rows for the game published during the same window
  const fetchDemo = useCallback(async () => {
    if (!selectedGame || !selectedDemoId) {
      setDemoSeries([])
      setDemoCoverageCount(null)
      return
    }
    const demo = demoProducts.find(d => d.id === selectedDemoId)
    if (!demo) return
    setDemoLoading(true)
    try {
      // Demo activations (Steam reports free-demo installs as gross_units_activated).
      // Query performance_metrics directly — going through analytics_data_view (a UNION ALL
      // with steam_sales) hits the statement timeout when filtering by product_name.
      let actQuery = supabase
        .from('performance_metrics')
        .select('date, gross_units_activated')
        .eq('product_name', demo.name)
        .eq('platform', 'Steam')
      if (effectiveDemoWindowStart) actQuery = actQuery.gte('date', effectiveDemoWindowStart)
      if (effectiveDemoWindowEnd) actQuery = actQuery.lte('date', effectiveDemoWindowEnd)
      const { data: actRows } = await actQuery

      // Wishlist adds for the PARENT game in the same window
      let wlQuery = supabase
        .from('steam_wishlists')
        .select('date, additions')
        .eq('game_id', selectedGame)
      if (effectiveDemoWindowStart) wlQuery = wlQuery.gte('date', effectiveDemoWindowStart)
      if (effectiveDemoWindowEnd) wlQuery = wlQuery.lte('date', effectiveDemoWindowEnd)
      const { data: wlRows } = await wlQuery

      // Aggregate by date
      const byDate = new Map<string, DemoDailyPoint>()
      for (const r of actRows || []) {
        const key = String(r.date)
        const pt = byDate.get(key) || { date: key, downloads: 0, wishlist_adds: 0 }
        pt.downloads += Number(r.gross_units_activated || 0)
        byDate.set(key, pt)
      }
      for (const r of wlRows || []) {
        const key = String(r.date)
        const pt = byDate.get(key) || { date: key, downloads: 0, wishlist_adds: 0 }
        pt.wishlist_adds += Number(r.additions || 0)
        byDate.set(key, pt)
      }
      const series = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date))
      setDemoSeries(series)

      // Coverage count for this game during the same window
      let covQuery = supabase
        .from('coverage_items')
        .select('id', { count: 'exact', head: true })
        .eq('game_id', selectedGame)
      if (effectiveDemoWindowStart) covQuery = covQuery.gte('publish_date', effectiveDemoWindowStart)
      if (effectiveDemoWindowEnd) covQuery = covQuery.lte('publish_date', effectiveDemoWindowEnd)
      const { count } = await covQuery
      setDemoCoverageCount(count || 0)
    } catch (err) {
      console.error('Failed to fetch demo data:', err)
    }
    setDemoLoading(false)
  }, [selectedGame, selectedDemoId, demoProducts, supabase, effectiveDemoWindowStart, effectiveDemoWindowEnd])

  useEffect(() => {
    if (selectedGame && activeTab === 'Demo') fetchDemo()
  }, [selectedGame, activeTab, fetchDemo])

  const handleWlUpload = async (file: File) => {
    if (!selectedGame || !selectedClient) return
    setWlUploading(true)
    setWlUploadResult(null)
    const formData = new FormData()
    formData.append('file', file)
    formData.append('game_id', selectedGame)
    formData.append('client_id', selectedClient)
    try {
      const res = await fetch('/api/steam-wishlists', { method: 'POST', body: formData })
      const json = await res.json()
      if (res.ok) {
        setWlUploadResult(`Imported ${json.imported} wishlist rows`)
        fetchWishlists()
      } else {
        setWlUploadResult(`Error: ${json.error}`)
      }
    } catch { setWlUploadResult('Network error') }
    setWlUploading(false)
  }

  const handleBlUpload = async (file: File) => {
    if (!selectedGame || !selectedClient) return
    setBlUploading(true)
    setBlUploadResult(null)
    const formData = new FormData()
    formData.append('file', file)
    formData.append('game_id', selectedGame)
    formData.append('client_id', selectedClient)
    try {
      const res = await fetch('/api/steam-bundles', { method: 'POST', body: formData })
      const json = await res.json()
      if (res.ok) {
        setBlUploadResult(`Imported ${json.imported} bundle rows`)
        fetchBundles()
      } else {
        setBlUploadResult(`Error: ${json.error}`)
      }
    } catch { setBlUploadResult('Network error') }
    setBlUploading(false)
  }

  const handleAddWishlist = async () => {
    if (!addWlDate || !selectedGame || !selectedClient) return
    try {
      const res = await fetch('/api/steam-wishlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          game_id: selectedGame, client_id: selectedClient, date: addWlDate,
          total_wishlists: addWlTotal ? parseInt(addWlTotal) : null,
          additions: addWlAdditions ? parseInt(addWlAdditions) : null,
          deletions: addWlDeletions ? parseInt(addWlDeletions) : null,
          purchases_and_activations: addWlPurchases ? parseInt(addWlPurchases) : null,
        }),
      })
      if (res.ok) {
        setShowAddWl(false)
        setAddWlDate(''); setAddWlTotal(''); setAddWlAdditions(''); setAddWlDeletions(''); setAddWlPurchases('')
        fetchWishlists()
      }
    } catch (err) { console.error(err) }
  }

  const handleAddBundle = async () => {
    if (!addBlDate || !addBlName || !selectedGame || !selectedClient) return
    try {
      const res = await fetch('/api/steam-bundles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          game_id: selectedGame, client_id: selectedClient, date: addBlDate,
          bundle_name: addBlName,
          gross_units: addBlGrossUnits ? parseInt(addBlGrossUnits) : 0,
          net_units: addBlNetUnits ? parseInt(addBlNetUnits) : 0,
          gross_revenue_usd: addBlGrossRev ? parseFloat(addBlGrossRev) : 0,
          net_revenue_usd: addBlNetRev ? parseFloat(addBlNetRev) : 0,
        }),
      })
      if (res.ok) {
        setShowAddBl(false)
        setAddBlDate(''); setAddBlName(''); setAddBlGrossUnits(''); setAddBlNetUnits(''); setAddBlGrossRev(''); setAddBlNetRev('')
        fetchBundles()
      }
    } catch (err) { console.error(err) }
  }

  if (authLoading) return <div style={{ display: 'flex', minHeight: '100vh' }}><Sidebar /><div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Loading...</div></div>
  if (!canView) return <div style={{ display: 'flex', minHeight: '100vh' }}><Sidebar /><div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Access Denied</div></div>

  const cardStyle: React.CSSProperties = { backgroundColor: 'white', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: '16px' }
  const statCard: React.CSSProperties = { backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '16px', textAlign: 'center' }
  const inputStyle: React.CSSProperties = { padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', width: '100%', boxSizing: 'border-box' }
  const btnPrimary: React.CSSProperties = { padding: '8px 16px', backgroundColor: '#2563eb', color: 'white', border: 'none', borderRadius: '6px', fontSize: '13px', cursor: 'pointer', fontWeight: 500 }
  const selectStyle: React.CSSProperties = { ...inputStyle, backgroundColor: 'white' }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
      <Sidebar />
      <div style={{ flex: 1, padding: '32px', overflow: 'auto' }}>
        <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
          <h1 style={{ fontSize: '28px', fontWeight: 700, color: '#1e293b', marginBottom: '4px' }}>Steam Wishlists & Bundles</h1>
          <p style={{ fontSize: '14px', color: '#64748b', marginBottom: '24px' }}>
            Track wishlist data and bundle performance. Wishlists can sync automatically from the Steam Partner API, or be imported via CSV.
          </p>

          {/* Filters */}
          <div style={cardStyle}>
            <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>Client</label>
                <select style={selectStyle} value={selectedClient} onChange={e => { setSelectedClient(e.target.value); setSelectedGame('') }}>
                  <option value="">Select Client...</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>Game</label>
                <select style={selectStyle} value={selectedGame} onChange={e => setSelectedGame(e.target.value)}>
                  <option value="">Select Game...</option>
                  {games.map(g => <option key={g.id} value={g.id}>{g.name}{g.steam_app_id ? ` (${g.steam_app_id})` : ''}</option>)}
                </select>
              </div>
            </div>

            {selectedGameMeta && (
              <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '13px', color: '#475569', fontWeight: 500 }}>Store page live date:</span>
                {!editingStoreDate ? (
                  <>
                    <span style={{ fontSize: '13px', color: selectedGameMeta.store_page_live_date ? '#1e293b' : '#94a3b8' }}>
                      {selectedGameMeta.store_page_live_date || '— not set —'}
                    </span>
                    {selectedGameMeta.store_page_live_date_source === 'auto' && (
                      <span style={{ fontSize: '11px', padding: '2px 6px', borderRadius: '4px', backgroundColor: '#ede9fe', color: '#6b21a8' }}>
                        Auto from Steam
                      </span>
                    )}
                    {selectedGameMeta.store_page_live_date_source === 'manual' && (
                      <span style={{ fontSize: '11px', padding: '2px 6px', borderRadius: '4px', backgroundColor: '#dcfce7', color: '#166534' }}>
                        Manual override
                      </span>
                    )}
                    {canEdit && (
                      <button
                        style={{ fontSize: '12px', padding: '4px 10px', backgroundColor: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: '4px', cursor: 'pointer' }}
                        onClick={() => setEditingStoreDate(true)}
                      >
                        {selectedGameMeta.store_page_live_date ? 'Override' : 'Set'}
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <input
                      type="date"
                      value={storeDateInput}
                      onChange={e => setStoreDateInput(e.target.value)}
                      style={{ padding: '4px 8px', border: '1px solid #e2e8f0', borderRadius: '4px', fontSize: '13px' }}
                    />
                    <button
                      style={{ fontSize: '12px', padding: '4px 10px', backgroundColor: '#2563eb', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', opacity: storeDateSaving ? 0.6 : 1 }}
                      onClick={handleSaveStoreDate}
                      disabled={storeDateSaving}
                    >
                      {storeDateSaving ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      style={{ fontSize: '12px', padding: '4px 10px', backgroundColor: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: '4px', cursor: 'pointer' }}
                      onClick={() => { setEditingStoreDate(false); setStoreDateInput(selectedGameMeta?.store_page_live_date || '') }}
                    >
                      Cancel
                    </button>
                  </>
                )}
                <span style={{ fontSize: '11px', color: '#94a3b8', marginLeft: 'auto' }}>
                  Wishlist charts for unreleased games anchor to this date.
                </span>
              </div>
            )}
          </div>

          {!selectedGame && (
            <div style={{ ...cardStyle, textAlign: 'center', padding: '60px 20px', color: '#94a3b8' }}>
              Select a client and game above to view wishlist & bundle data.
            </div>
          )}

          {selectedGame && (
            <>
              {/* Tabs */}
              <div style={{ display: 'flex', gap: '0', borderBottom: '2px solid #e2e8f0', marginBottom: '16px' }}>
                {TABS.map(tab => (
                  <button key={tab} onClick={() => setActiveTab(tab)} style={{
                    padding: '10px 24px', background: 'none', border: 'none',
                    borderBottom: activeTab === tab ? '2px solid #2563eb' : '2px solid transparent',
                    color: activeTab === tab ? '#2563eb' : '#64748b',
                    fontWeight: activeTab === tab ? 600 : 400, fontSize: '14px', cursor: 'pointer', marginBottom: '-2px',
                  }}>{tab}</button>
                ))}
              </div>

              {/* Wishlists Tab */}
              {activeTab === 'Wishlists' && (
                <div>
                  {/* Summary */}
                  {wishlistSummary && wishlistSummary.total_rows > 0 && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '12px', marginBottom: '16px' }}>
                      <div style={statCard}>
                        <div style={{ fontSize: '22px', fontWeight: 700, color: '#1e293b' }}>{formatNumber(wishlistSummary.total_wishlists)}</div>
                        <div style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>Current Total</div>
                      </div>
                      <div style={statCard}>
                        <div style={{ fontSize: '22px', fontWeight: 700, color: '#16a34a' }}>+{formatNumber(wishlistSummary.total_additions)}</div>
                        <div style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>Additions</div>
                      </div>
                      <div style={statCard}>
                        <div style={{ fontSize: '22px', fontWeight: 700, color: '#dc2626' }}>-{formatNumber(wishlistSummary.total_deletions)}</div>
                        <div style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>Deletions</div>
                      </div>
                      <div style={statCard}>
                        <div style={{ fontSize: '22px', fontWeight: 700, color: '#2563eb' }}>{formatNumber(wishlistSummary.total_purchases)}</div>
                        <div style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>Purchases</div>
                      </div>
                      <div style={statCard}>
                        <div style={{ fontSize: '22px', fontWeight: 700, color: wishlistSummary.total_additions - wishlistSummary.total_deletions >= 0 ? '#16a34a' : '#dc2626' }}>
                          {wishlistSummary.total_additions - wishlistSummary.total_deletions >= 0 ? '+' : ''}{formatNumber(wishlistSummary.total_additions - wishlistSummary.total_deletions)}
                        </div>
                        <div style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>Net Change</div>
                      </div>
                    </div>
                  )}

                  {/* Chart */}
                  {wishlistData.length >= 2 && (
                    <WishlistChart
                      data={wishlistData}
                      storePageLiveDate={selectedGameMeta?.store_page_live_date || null}
                    />
                  )}

                  {/* Actions */}
                  {canEdit && (
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', alignItems: 'center' }}>
                      {steamApiAvailable && (
                        <button
                          style={{ ...btnPrimary, backgroundColor: '#7c3aed', opacity: wlSyncing ? 0.6 : 1, cursor: wlSyncing ? 'not-allowed' : 'pointer' }}
                          onClick={handleSteamSync}
                          disabled={wlSyncing}
                        >
                          {wlSyncing ? 'Syncing...' : 'Sync from Steam API'}
                        </button>
                      )}
                      <label style={{ ...btnPrimary, display: 'inline-flex', alignItems: 'center', gap: '6px', opacity: wlUploading ? 0.6 : 1, cursor: wlUploading ? 'not-allowed' : 'pointer' }}>
                        {wlUploading ? 'Importing...' : 'Import CSV'}
                        <input type="file" accept=".csv" style={{ display: 'none' }} disabled={wlUploading} onChange={e => { const f = e.target.files?.[0]; if (f) handleWlUpload(f); e.target.value = '' }} />
                      </label>
                      <button style={{ ...btnPrimary, backgroundColor: '#059669' }} onClick={() => setShowAddWl(true)}>+ Add Entry</button>
                    </div>
                  )}

                  {(wlUploadResult || wlSyncResult) && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
                      {wlSyncResult && (
                        <div style={{ padding: '8px 12px', borderRadius: '6px', fontSize: '13px', backgroundColor: wlSyncResult.startsWith('Error') ? '#fee2e2' : '#f3e8ff', color: wlSyncResult.startsWith('Error') ? '#dc2626' : '#6b21a8' }}>
                          {wlSyncResult}
                        </div>
                      )}
                      {wlUploadResult && (
                        <div style={{ padding: '8px 12px', borderRadius: '6px', fontSize: '13px', backgroundColor: wlUploadResult.startsWith('Error') ? '#fee2e2' : '#dcfce7', color: wlUploadResult.startsWith('Error') ? '#dc2626' : '#166534' }}>
                          {wlUploadResult}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Add form */}
                  {showAddWl && (
                    <div style={{ ...cardStyle, backgroundColor: '#f0f9ff', border: '1px solid #bae6fd' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '10px', marginBottom: '10px' }}>
                        <div><label style={{ fontSize: '12px', color: '#374151' }}>Date *</label><input type="date" style={inputStyle} value={addWlDate} onChange={e => setAddWlDate(e.target.value)} /></div>
                        <div><label style={{ fontSize: '12px', color: '#374151' }}>Total Wishlists</label><input type="number" style={inputStyle} value={addWlTotal} onChange={e => setAddWlTotal(e.target.value)} placeholder="12000" /></div>
                        <div><label style={{ fontSize: '12px', color: '#374151' }}>Additions</label><input type="number" style={inputStyle} value={addWlAdditions} onChange={e => setAddWlAdditions(e.target.value)} placeholder="150" /></div>
                        <div><label style={{ fontSize: '12px', color: '#374151' }}>Deletions</label><input type="number" style={inputStyle} value={addWlDeletions} onChange={e => setAddWlDeletions(e.target.value)} placeholder="30" /></div>
                        <div><label style={{ fontSize: '12px', color: '#374151' }}>Purchases</label><input type="number" style={inputStyle} value={addWlPurchases} onChange={e => setAddWlPurchases(e.target.value)} placeholder="20" /></div>
                      </div>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button style={btnPrimary} onClick={handleAddWishlist}>Save</button>
                        <button style={{ ...btnPrimary, backgroundColor: '#6b7280' }} onClick={() => setShowAddWl(false)}>Cancel</button>
                      </div>
                    </div>
                  )}

                  {/* Data table */}
                  {wlLoading ? (
                    <div style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>Loading...</div>
                  ) : wishlistData.length === 0 ? (
                    <div style={{ ...cardStyle, textAlign: 'center', padding: '40px', color: '#94a3b8' }}>
                      <p style={{ fontSize: '16px', fontWeight: 500, marginBottom: '8px' }}>No wishlist data yet</p>
                      <p style={{ fontSize: '13px' }}>
                        {steamApiAvailable
                          ? 'Click "Sync from Steam API" to pull wishlist data automatically, or import a CSV.'
                          : 'Import a CSV from Steamworks or add entries manually. Configure a Steam Financial API key to enable auto-sync.'}
                      </p>
                    </div>
                  ) : (
                    <div style={cardStyle}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                        <thead>
                          <tr>
                            <th style={{ textAlign: 'left', padding: '8px', borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>Date</th>
                            <th style={{ textAlign: 'right', padding: '8px', borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>Total</th>
                            <th style={{ textAlign: 'right', padding: '8px', borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>Additions</th>
                            <th style={{ textAlign: 'right', padding: '8px', borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>Deletions</th>
                            <th style={{ textAlign: 'right', padding: '8px', borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>Purchases</th>
                            <th style={{ textAlign: 'center', padding: '8px', borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>Source</th>
                          </tr>
                        </thead>
                        <tbody>
                          {wishlistData.map(row => (
                            <tr key={row.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                              <td style={{ padding: '6px 8px', color: '#475569' }}>{new Date(row.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                              <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600 }}>{formatNumber(row.total_wishlists)}</td>
                              <td style={{ padding: '6px 8px', textAlign: 'right', color: '#16a34a', fontWeight: 500 }}>{row.additions ? `+${formatNumber(row.additions)}` : '—'}</td>
                              <td style={{ padding: '6px 8px', textAlign: 'right', color: '#dc2626' }}>{row.deletions ? `-${formatNumber(row.deletions)}` : '—'}</td>
                              <td style={{ padding: '6px 8px', textAlign: 'right', color: '#2563eb' }}>{formatNumber(row.purchases_and_activations)}</td>
                              <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                                <span style={{ fontSize: '11px', padding: '2px 6px', borderRadius: '4px', backgroundColor: '#f3f4f6', color: '#475569' }}>{row.source}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* Demo Tab */}
              {activeTab === 'Demo' && (
                <div>
                  {demoProducts.length === 0 ? (
                    <div style={{ ...cardStyle, textAlign: 'center', padding: '40px', color: '#94a3b8' }}>
                      <p style={{ fontSize: '16px', fontWeight: 500, marginBottom: '8px' }}>No demo products for this game</p>
                      <p style={{ fontSize: '13px' }}>
                        Add a product with type <strong>Demo</strong> from the Manage menu. Use the demo&apos;s separate Steam App ID as the product&apos;s Steam Product ID.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div style={{ ...cardStyle }}>
                        <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-end', marginBottom: '12px' }}>
                          <div style={{ flex: 1 }}>
                            <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>Demo Product</label>
                            <select style={selectStyle} value={selectedDemoId} onChange={e => setSelectedDemoId(e.target.value)}>
                              {demoProducts.map(d => (
                                <option key={d.id} value={d.id}>
                                  {d.name}{d.launch_date ? ` (live since ${d.launch_date})` : ''}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end', paddingTop: '12px', borderTop: '1px solid #f1f5f9' }}>
                          <div>
                            <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>Window start</label>
                            <input
                              type="date"
                              style={{ ...inputStyle, width: 'auto' }}
                              value={effectiveDemoWindowStart}
                              onChange={e => setDemoWindowStart(e.target.value)}
                            />
                          </div>
                          <div>
                            <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>Window end</label>
                            <input
                              type="date"
                              style={{ ...inputStyle, width: 'auto' }}
                              value={effectiveDemoWindowEnd}
                              onChange={e => setDemoWindowEnd(e.target.value)}
                            />
                          </div>
                          {(demoWindowStart || demoWindowEnd) && (
                            <button
                              onClick={() => { setDemoWindowStart(''); setDemoWindowEnd('') }}
                              style={{ fontSize: '12px', padding: '6px 12px', backgroundColor: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: '4px', cursor: 'pointer' }}
                            >
                              Reset to default
                            </button>
                          )}
                          <span style={{ fontSize: '11px', color: '#94a3b8', marginLeft: 'auto', maxWidth: '380px', textAlign: 'right' }}>
                            Default: demo launch → {selectedGameMeta?.release_date && selectedGameMeta.release_date <= today ? `game release (${selectedGameMeta.release_date})` : 'today'}.
                            Narrow this for event demos (e.g. one Next Fest week).
                          </span>
                        </div>

                        {canEdit && (
                          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', paddingTop: '12px', marginTop: '12px', borderTop: '1px solid #f1f5f9' }}>
                            <button
                              onClick={runBackfillBatch}
                              disabled={backfillRunning}
                              style={{
                                fontSize: '13px', padding: '8px 14px',
                                backgroundColor: backfillRunning ? '#94a3b8' : '#7c3aed', color: 'white',
                                border: 'none', borderRadius: '6px',
                                cursor: backfillRunning ? 'not-allowed' : 'pointer', fontWeight: 500,
                              }}
                            >
                              {backfillRunning
                                ? 'Backfilling…'
                                : backfillStartDate
                                  ? `Continue backfill (from ${backfillStartDate})`
                                  : 'Backfill historical activations from Steam'}
                            </button>
                            <span style={{ fontSize: '11px', color: '#64748b', flex: 1 }}>
                              {backfillProgress || 'Re-fetches GetDetailedSales for past dates and writes gross_units_activated. Processes 30 dates per click.'}
                            </span>
                          </div>
                        )}
                      </div>

                      {demoLoading ? (
                        <div style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>Loading…</div>
                      ) : (
                        <>
                          {(() => {
                            const totalDownloads = demoSeries.reduce((s, p) => s + p.downloads, 0)
                            const totalAdds = demoSeries.reduce((s, p) => s + p.wishlist_adds, 0)
                            const conversionPct = totalDownloads > 0 ? (totalAdds / totalDownloads) * 100 : null
                            return (
                              <>
                                {/* Conversion-rate hero tile — the metric Stephanie actually asked for */}
                                <div style={{ ...cardStyle, background: 'linear-gradient(135deg, #ede9fe 0%, #f3e8ff 100%)', border: '1px solid #ddd6fe' }}>
                                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '16px' }}>
                                    <div>
                                      <div style={{ fontSize: '11px', color: '#6b21a8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Demo → Wishlist Conversion</div>
                                      <div style={{ fontSize: '36px', fontWeight: 700, color: '#5b21b6', lineHeight: 1 }}>
                                        {conversionPct == null ? '—' : `${conversionPct.toFixed(1)}%`}
                                      </div>
                                      <div style={{ fontSize: '12px', color: '#6b21a8', marginTop: '4px' }}>
                                        {totalDownloads === 0
                                          ? 'No demo activations recorded in this window yet.'
                                          : `${formatNumber(totalAdds)} new wishlists ÷ ${formatNumber(totalDownloads)} demo activations`}
                                      </div>
                                    </div>
                                  </div>
                                </div>

                                {/* Three breakdown tiles */}
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginBottom: '16px' }}>
                                  <div style={statCard}>
                                    <div style={{ fontSize: '22px', fontWeight: 700, color: '#1e293b' }}>
                                      {formatNumber(totalDownloads)}
                                    </div>
                                    <div style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>Demo activations in window</div>
                                  </div>
                                  <div style={statCard}>
                                    <div style={{ fontSize: '22px', fontWeight: 700, color: '#16a34a' }}>
                                      +{formatNumber(totalAdds)}
                                    </div>
                                    <div style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>Parent-game wishlist adds in window</div>
                                  </div>
                                  <div style={statCard}>
                                    <div style={{ fontSize: '22px', fontWeight: 700, color: '#7c3aed' }}>
                                      {demoCoverageCount == null ? '—' : formatNumber(demoCoverageCount)}
                                    </div>
                                    <div style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>Press coverage items in window</div>
                                  </div>
                                </div>

                                {/* Daily breakdown table */}
                                {demoSeries.length === 0 ? (
                                  <div style={{ ...cardStyle, textAlign: 'center', padding: '40px', color: '#94a3b8' }}>
                                    <p style={{ fontSize: '14px', marginBottom: '8px' }}>No demo data in this window yet.</p>
                                    <p style={{ fontSize: '12px' }}>
                                      Demo activations come from Steam financial sync (uses gross_units_activated, which only populates after a sync runs since 2026-05-12). Wishlist adds need a wishlist sync.
                                    </p>
                                  </div>
                                ) : (
                                  <div style={cardStyle}>
                                    <h3 style={{ fontSize: '15px', fontWeight: 600, color: '#1e293b', margin: '0 0 12px 0' }}>Daily breakdown</h3>
                                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                                      <thead>
                                        <tr>
                                          <th style={{ textAlign: 'left', padding: '8px', borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>Date</th>
                                          <th style={{ textAlign: 'right', padding: '8px', borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>Demo activations</th>
                                          <th style={{ textAlign: 'right', padding: '8px', borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>Wishlist adds (parent)</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {demoSeries.slice().reverse().map(p => (
                                          <tr key={p.date} style={{ borderBottom: '1px solid #f1f5f9' }}>
                                            <td style={{ padding: '6px 8px', color: '#475569' }}>{p.date}</td>
                                            <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600 }}>{formatNumber(p.downloads)}</td>
                                            <td style={{ padding: '6px 8px', textAlign: 'right', color: '#16a34a', fontWeight: 500 }}>{p.wishlist_adds ? `+${formatNumber(p.wishlist_adds)}` : '—'}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
                              </>
                            )
                          })()}
                        </>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* Bundles Tab */}
              {activeTab === 'Bundles' && (
                <div>
                  {/* API limitation notice */}
                  <div style={{ padding: '12px 16px', borderRadius: '8px', marginBottom: '16px', backgroundColor: '#fffbeb', border: '1px solid #fde68a', fontSize: '13px', color: '#92400e' }}>
                    <strong>Steam API limitation:</strong> Bundle data is only visible to the bundle creator. If this game participates in bundles hosted by others, data must be imported via CSV from Steamworks.
                  </div>

                  {/* Summary */}
                  {bundleSummary && bundleSummary.total_rows > 0 && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginBottom: '16px' }}>
                      <div style={statCard}>
                        <div style={{ fontSize: '22px', fontWeight: 700, color: '#1e293b' }}>{bundleSummary.total_bundles}</div>
                        <div style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>Bundles</div>
                      </div>
                      <div style={statCard}>
                        <div style={{ fontSize: '22px', fontWeight: 700, color: '#1e293b' }}>{formatNumber(bundleSummary.total_net_units)}</div>
                        <div style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>Net Units</div>
                      </div>
                      <div style={statCard}>
                        <div style={{ fontSize: '22px', fontWeight: 700, color: '#16a34a' }}>{formatCurrency(bundleSummary.total_net_revenue)}</div>
                        <div style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>Net Revenue</div>
                      </div>
                      <div style={statCard}>
                        <div style={{ fontSize: '22px', fontWeight: 700, color: '#475569' }}>{bundleSummary.total_rows}</div>
                        <div style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>Data Points</div>
                      </div>
                    </div>
                  )}

                  {/* Actions */}
                  {canEdit && (
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                      <label style={{ ...btnPrimary, display: 'inline-flex', alignItems: 'center', gap: '6px', opacity: blUploading ? 0.6 : 1, cursor: blUploading ? 'not-allowed' : 'pointer' }}>
                        {blUploading ? 'Importing...' : 'Import CSV'}
                        <input type="file" accept=".csv" style={{ display: 'none' }} disabled={blUploading} onChange={e => { const f = e.target.files?.[0]; if (f) handleBlUpload(f); e.target.value = '' }} />
                      </label>
                      <button style={{ ...btnPrimary, backgroundColor: '#059669' }} onClick={() => setShowAddBl(true)}>+ Add Entry</button>
                    </div>
                  )}

                  {blUploadResult && (
                    <div style={{ padding: '8px 12px', borderRadius: '6px', fontSize: '13px', marginBottom: '12px', backgroundColor: blUploadResult.startsWith('Error') ? '#fee2e2' : '#dcfce7', color: blUploadResult.startsWith('Error') ? '#dc2626' : '#166534' }}>
                      {blUploadResult}
                    </div>
                  )}

                  {/* Add form */}
                  {showAddBl && (
                    <div style={{ ...cardStyle, backgroundColor: '#f0f9ff', border: '1px solid #bae6fd' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '10px' }}>
                        <div><label style={{ fontSize: '12px', color: '#374151' }}>Date *</label><input type="date" style={inputStyle} value={addBlDate} onChange={e => setAddBlDate(e.target.value)} /></div>
                        <div><label style={{ fontSize: '12px', color: '#374151' }}>Bundle Name *</label><input style={inputStyle} value={addBlName} onChange={e => setAddBlName(e.target.value)} placeholder="Indie Gems Bundle" /></div>
                        <div><label style={{ fontSize: '12px', color: '#374151' }}>Gross Units</label><input type="number" style={inputStyle} value={addBlGrossUnits} onChange={e => setAddBlGrossUnits(e.target.value)} /></div>
                        <div><label style={{ fontSize: '12px', color: '#374151' }}>Net Units</label><input type="number" style={inputStyle} value={addBlNetUnits} onChange={e => setAddBlNetUnits(e.target.value)} /></div>
                        <div><label style={{ fontSize: '12px', color: '#374151' }}>Gross Revenue ($)</label><input type="number" step="0.01" style={inputStyle} value={addBlGrossRev} onChange={e => setAddBlGrossRev(e.target.value)} /></div>
                        <div><label style={{ fontSize: '12px', color: '#374151' }}>Net Revenue ($)</label><input type="number" step="0.01" style={inputStyle} value={addBlNetRev} onChange={e => setAddBlNetRev(e.target.value)} /></div>
                      </div>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button style={btnPrimary} onClick={handleAddBundle}>Save</button>
                        <button style={{ ...btnPrimary, backgroundColor: '#6b7280' }} onClick={() => setShowAddBl(false)}>Cancel</button>
                      </div>
                    </div>
                  )}

                  {/* Data table */}
                  {blLoading ? (
                    <div style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>Loading...</div>
                  ) : bundleData.length === 0 ? (
                    <div style={{ ...cardStyle, textAlign: 'center', padding: '40px', color: '#94a3b8' }}>
                      <p style={{ fontSize: '16px', fontWeight: 500, marginBottom: '8px' }}>No bundle data yet</p>
                      <p style={{ fontSize: '13px' }}>Import a CSV from Steamworks or add entries manually.</p>
                    </div>
                  ) : (
                    <div style={cardStyle}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                        <thead>
                          <tr>
                            <th style={{ textAlign: 'left', padding: '8px', borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>Date</th>
                            <th style={{ textAlign: 'left', padding: '8px', borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>Bundle</th>
                            <th style={{ textAlign: 'right', padding: '8px', borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>Gross Units</th>
                            <th style={{ textAlign: 'right', padding: '8px', borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>Net Units</th>
                            <th style={{ textAlign: 'right', padding: '8px', borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>Gross Rev</th>
                            <th style={{ textAlign: 'right', padding: '8px', borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>Net Rev</th>
                            <th style={{ textAlign: 'center', padding: '8px', borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>Source</th>
                          </tr>
                        </thead>
                        <tbody>
                          {bundleData.map(row => (
                            <tr key={row.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                              <td style={{ padding: '6px 8px' }}>{row.date}</td>
                              <td style={{ padding: '6px 8px', fontWeight: 500 }}>{row.bundle_name}</td>
                              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{formatNumber(row.gross_units)}</td>
                              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{formatNumber(row.net_units)}</td>
                              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{formatCurrency(Number(row.gross_revenue_usd))}</td>
                              <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600, color: '#16a34a' }}>{formatCurrency(Number(row.net_revenue_usd))}</td>
                              <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                                <span style={{ fontSize: '11px', padding: '2px 6px', borderRadius: '4px', backgroundColor: '#f3f4f6', color: '#475569' }}>{row.source}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
