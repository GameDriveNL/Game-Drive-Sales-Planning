'use client'

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Sidebar } from '../components/Sidebar'
import { useAuth } from '@/lib/auth-context'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Outlet, OutletTier, ScanFrequency } from '@/lib/types'

const TIER_LABELS: Record<OutletTier, string> = {
  A: '10M+ visitors',
  B: '1M–10M visitors',
  C: '100K–1M visitors',
  D: '<100K visitors'
}

const TIER_COLORS: Record<OutletTier, { bg: string; text: string; border: string }> = {
  A: { bg: '#dcfce7', text: '#166534', border: '#86efac' },
  B: { bg: '#dbeafe', text: '#1e40af', border: '#93c5fd' },
  C: { bg: '#fef9c3', text: '#854d0e', border: '#fde047' },
  D: { bg: '#f3f4f6', text: '#374151', border: '#d1d5db' }
}

const SCAN_FREQUENCIES: { value: ScanFrequency; label: string }[] = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'every_6h', label: 'Every 6 hours' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' }
]

function suggestTier(visitors: number | null): OutletTier | null {
  if (!visitors) return null
  if (visitors >= 10_000_000) return 'A'
  if (visitors >= 1_000_000) return 'B'
  if (visitors >= 100_000) return 'C'
  return 'D'
}

function formatNumber(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return n.toLocaleString()
}

interface OutletFormData {
  name: string
  domain: string
  country: string
  monthly_unique_visitors: string
  tier: OutletTier | ''
  metacritic_status: boolean
  custom_tags: string
  rss_feed_url: string
  scan_frequency: ScanFrequency
}

const emptyForm: OutletFormData = {
  name: '',
  domain: '',
  country: '',
  monthly_unique_visitors: '',
  tier: '',
  metacritic_status: false,
  custom_tags: '',
  rss_feed_url: '',
  scan_frequency: 'daily'
}

export default function CoveragePage() {
  const { hasAccess, loading: authLoading } = useAuth()
  const canView = hasAccess('pr_coverage', 'view')
  const canEdit = hasAccess('pr_coverage', 'edit')

  // Outlet data
  const [outlets, setOutlets] = useState<Outlet[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [isLoading, setIsLoading] = useState(true)

  // Filters
  const [search, setSearch] = useState('')
  const [tierFilter, setTierFilter] = useState('')
  const [countryFilter, setCountryFilter] = useState('')
  const [metacriticFilter, setMetacriticFilter] = useState('')
  const [sortBy, setSortBy] = useState('monthly_unique_visitors')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  // Form state
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<OutletFormData>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // CSV import
  const [showImport, setShowImport] = useState(false)
  const [csvText, setCsvText] = useState('')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<string | null>(null)

  // Traffic refresh
  const [refreshingTraffic, setRefreshingTraffic] = useState<Set<string>>(new Set())
  const [refreshAllTraffic, setRefreshAllTraffic] = useState(false)
  const [trafficMessage, setTrafficMessage] = useState<string | null>(null)

  // Debounced search
  const searchTimeout = useRef<NodeJS.Timeout | null>(null)
  const [debouncedSearch, setDebouncedSearch] = useState('')

  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current)
    searchTimeout.current = setTimeout(() => setDebouncedSearch(search), 300)
    return () => { if (searchTimeout.current) clearTimeout(searchTimeout.current) }
  }, [search])

  const fetchOutlets = useCallback(async () => {
    setIsLoading(true)
    const params = new URLSearchParams()
    if (debouncedSearch) params.set('search', debouncedSearch)
    if (tierFilter) params.set('tier', tierFilter)
    if (countryFilter) params.set('country', countryFilter)
    if (metacriticFilter) params.set('metacritic', metacriticFilter)
    params.set('sortBy', sortBy)
    params.set('sortDir', sortDir)
    params.set('limit', '200')

    try {
      const res = await fetch(`/api/outlets?${params}`)
      const json = await res.json()
      if (res.ok) {
        setOutlets(json.data || [])
        setTotalCount(json.count || 0)
      }
    } catch (err) {
      console.error('Failed to fetch outlets:', err)
    }
    setIsLoading(false)
  }, [debouncedSearch, tierFilter, countryFilter, metacriticFilter, sortBy, sortDir])

  useEffect(() => {
    if (canView) fetchOutlets()
  }, [canView, fetchOutlets])

  // Unique countries for filter dropdown
  const countries = useMemo(() => {
    const set = new Set<string>()
    outlets.forEach(o => { if (o.country) set.add(o.country) })
    return Array.from(set).sort()
  }, [outlets])

  const handleSort = (column: string) => {
    if (sortBy === column) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortBy(column)
      setSortDir(column === 'name' ? 'asc' : 'desc')
    }
  }

  const openAddForm = () => {
    setEditingId(null)
    setForm(emptyForm)
    setSaveError(null)
    setShowForm(true)
  }

  const openEditForm = (outlet: Outlet) => {
    setEditingId(outlet.id)
    setForm({
      name: outlet.name,
      domain: outlet.domain || '',
      country: outlet.country || '',
      monthly_unique_visitors: outlet.monthly_unique_visitors?.toString() || '',
      tier: (outlet.tier as OutletTier) || '',
      metacritic_status: outlet.metacritic_status,
      custom_tags: Array.isArray(outlet.custom_tags) ? outlet.custom_tags.join(', ') : '',
      rss_feed_url: outlet.rss_feed_url || '',
      scan_frequency: (outlet.scan_frequency as ScanFrequency) || 'daily'
    })
    setSaveError(null)
    setShowForm(true)
  }

  const handleSave = async () => {
    if (!form.name.trim()) {
      setSaveError('Outlet name is required')
      return
    }
    setSaving(true)
    setSaveError(null)

    const visitors = form.monthly_unique_visitors ? parseInt(form.monthly_unique_visitors) : null
    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      domain: form.domain.trim() || null,
      country: form.country.trim() || null,
      monthly_unique_visitors: visitors,
      tier: form.tier || suggestTier(visitors),
      metacritic_status: form.metacritic_status,
      custom_tags: form.custom_tags ? form.custom_tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      rss_feed_url: form.rss_feed_url.trim() || null,
      scan_frequency: form.scan_frequency
    }

    if (editingId) payload.id = editingId

    try {
      const res = await fetch('/api/outlets', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const json = await res.json()
      if (!res.ok) {
        setSaveError(json.error || 'Failed to save')
      } else {
        setShowForm(false)
        fetchOutlets()
      }
    } catch {
      setSaveError('Network error')
    }
    setSaving(false)
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this outlet? This cannot be undone.')) return
    try {
      await fetch(`/api/outlets?id=${id}`, { method: 'DELETE' })
      fetchOutlets()
    } catch (err) {
      console.error('Delete failed:', err)
    }
  }

  const handleToggleBlacklist = async (outlet: Outlet) => {
    const newVal = !outlet.is_blacklisted
    // Optimistic update
    setOutlets(prev => prev.map(o => o.id === outlet.id ? { ...o, is_blacklisted: newVal } : o))
    try {
      await fetch('/api/outlets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: outlet.id, is_blacklisted: newVal })
      })
    } catch {
      // Rollback on error
      setOutlets(prev => prev.map(o => o.id === outlet.id ? { ...o, is_blacklisted: outlet.is_blacklisted } : o))
    }
  }

  const handleCSVImport = async () => {
    if (!csvText.trim()) return
    setImporting(true)
    setImportResult(null)

    // Parse CSV: name, domain, country, monthly_unique_visitors, tier, metacritic_status
    const lines = csvText.trim().split('\n')
    const headerLine = lines[0].toLowerCase()
    const hasHeader = headerLine.includes('name') || headerLine.includes('domain')
    const dataLines = hasHeader ? lines.slice(1) : lines

    const outlets = dataLines.map(line => {
      const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''))
      return {
        name: cols[0] || '',
        domain: cols[1] || null,
        country: cols[2] || null,
        monthly_unique_visitors: cols[3] ? parseInt(cols[3].replace(/[^0-9]/g, '')) : null,
        tier: cols[4] || null,
        metacritic_status: cols[5]?.toLowerCase() === 'true' || cols[5] === '1'
      }
    }).filter(o => o.name)

    try {
      const res = await fetch('/api/outlets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(outlets)
      })
      const json = await res.json()
      if (res.ok) {
        setImportResult(`Imported ${json.imported || outlets.length} outlets successfully.`)
        setCsvText('')
        setShowImport(false)
        fetchOutlets()
      } else {
        setImportResult(`Error: ${json.error}`)
      }
    } catch {
      setImportResult('Network error during import')
    }
    setImporting(false)
  }

  const handleRefreshTraffic = async (outletId: string, domain: string) => {
    setRefreshingTraffic(prev => new Set(prev).add(outletId))
    setTrafficMessage(null)

    try {
      const res = await fetch('/api/hypestat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outlet_id: outletId, domain })
      })
      const json = await res.json()
      if (res.ok && json.monthly_unique_visitors) {
        setTrafficMessage(`${domain}: ${json.monthly_unique_visitors.toLocaleString()} visitors (Tier ${json.suggested_tier}) via ${json.method}`)
        fetchOutlets()
      } else {
        setTrafficMessage(`${domain}: ${json.error || 'No traffic data found'}`)
      }
    } catch {
      setTrafficMessage(`${domain}: Network error`)
    }

    setRefreshingTraffic(prev => {
      const next = new Set(prev)
      next.delete(outletId)
      return next
    })
  }

  const handleRefreshAllTraffic = async () => {
    setRefreshAllTraffic(true)
    setTrafficMessage(null)

    try {
      const res = await fetch('/api/cron/traffic-refresh', {
        headers: { 'User-Agent': 'Mozilla/5.0 (manual trigger)' }
      })
      const json = await res.json()
      if (res.ok) {
        setTrafficMessage(`Batch refresh: ${json.stats.updated} updated, ${json.stats.failed} failed out of ${json.stats.processed} checked (${json.duration_ms}ms)`)
        fetchOutlets()
      } else {
        setTrafficMessage(`Batch refresh failed: ${json.error}`)
      }
    } catch {
      setTrafficMessage('Batch refresh: Network error')
    }

    setRefreshAllTraffic(false)
  }

  // Auto-suggest tier when visitors change in the form
  const handleVisitorsChange = (value: string) => {
    setForm(f => {
      const visitors = value ? parseInt(value) : null
      const suggested = suggestTier(visitors)
      return {
        ...f,
        monthly_unique_visitors: value,
        tier: suggested || f.tier
      }
    })
  }

  const sortIcon = (col: string) => {
    if (sortBy !== col) return ' ↕'
    return sortDir === 'asc' ? ' ↑' : ' ↓'
  }

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
        <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
            <div>
              <h1 style={{ fontSize: '28px', fontWeight: 700, color: '#1e293b', margin: 0 }}>PR Coverage</h1>
              <p style={{ fontSize: '14px', color: '#64748b', margin: '4px 0 0 0' }}>
                Manage media outlets, tier rankings, and coverage tracking
              </p>
            </div>
            {canEdit && (
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={handleRefreshAllTraffic}
                  disabled={refreshAllTraffic}
                  style={{
                    padding: '10px 16px',
                    backgroundColor: refreshAllTraffic ? '#86efac' : '#dcfce7',
                    color: '#166534',
                    border: '1px solid #86efac',
                    borderRadius: '8px',
                    fontSize: '14px',
                    cursor: refreshAllTraffic ? 'not-allowed' : 'pointer',
                    fontWeight: 500
                  }}
                >
                  {refreshAllTraffic ? 'Refreshing...' : 'Refresh All Traffic'}
                </button>
                <button
                  onClick={() => { setShowImport(true); setImportResult(null) }}
                  style={{
                    padding: '10px 16px',
                    backgroundColor: 'white',
                    color: '#475569',
                    border: '1px solid #e2e8f0',
                    borderRadius: '8px',
                    fontSize: '14px',
                    cursor: 'pointer',
                    fontWeight: 500
                  }}
                >
                  Import CSV
                </button>
                <button
                  onClick={openAddForm}
                  style={{
                    padding: '10px 20px',
                    backgroundColor: '#2563eb',
                    color: 'white',
                    border: 'none',
                    borderRadius: '8px',
                    fontSize: '14px',
                    cursor: 'pointer',
                    fontWeight: 500
                  }}
                >
                  + Add Outlet
                </button>
              </div>
            )}
          </div>

          {/* Sub-navigation tabs */}
          <div style={{ display: 'flex', gap: '0', marginBottom: '24px', borderBottom: '2px solid #e2e8f0' }}>
            <div style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 600, cursor: 'pointer',
              color: '#2563eb', borderBottom: '2px solid #2563eb', marginBottom: '-2px'
            }}>
              Outlets
            </div>
            <Link href="/coverage/keywords" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              Keywords
            </Link>
            <Link href="/coverage/settings" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              API Keys
            </Link>
            <Link href="/coverage/sources" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              Sources
            </Link>
            <Link href="/coverage/feed" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              Feed
            </Link>
            <Link href="/coverage/dashboard" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              Dashboard
            </Link>
            <Link href="/coverage/timeline" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              Timeline
            </Link>
            <Link href="/coverage/report" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              Export
            </Link>
            <Link href="/coverage/clients" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              Clients &amp; Games
            </Link>
            <Link href="/coverage/campaign-report" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              Campaign Report
            </Link>
            <Link href="/coverage/guide" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              Guide
            </Link>
          </div>

          {/* Stats summary */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '12px', marginBottom: '24px' }}>
            <div style={{ backgroundColor: 'white', borderRadius: '10px', padding: '16px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
              <div style={{ fontSize: '24px', fontWeight: 700, color: '#1e293b' }}>{totalCount}</div>
              <div style={{ fontSize: '12px', color: '#64748b' }}>Total Outlets</div>
            </div>
            {(['A', 'B', 'C', 'D'] as OutletTier[]).map(tier => {
              const count = outlets.filter(o => o.tier === tier).length
              const colors = TIER_COLORS[tier]
              return (
                <div key={tier} style={{
                  backgroundColor: colors.bg,
                  borderRadius: '10px',
                  padding: '16px',
                  border: `1px solid ${colors.border}`
                }}>
                  <div style={{ fontSize: '24px', fontWeight: 700, color: colors.text }}>{count}</div>
                  <div style={{ fontSize: '12px', color: colors.text, opacity: 0.8 }}>Tier {tier} — {TIER_LABELS[tier]}</div>
                </div>
              )
            })}
            {(() => {
              const blockedCount = outlets.filter(o => o.is_blacklisted).length
              return blockedCount > 0 ? (
                <div style={{
                  backgroundColor: '#fef2f2',
                  borderRadius: '10px',
                  padding: '16px',
                  border: '1px solid #fecaca'
                }}>
                  <div style={{ fontSize: '24px', fontWeight: 700, color: '#991b1b' }}>{blockedCount}</div>
                  <div style={{ fontSize: '12px', color: '#991b1b', opacity: 0.8 }}>Blocked</div>
                </div>
              ) : null
            })()}
          </div>

          {/* Filters */}
          <div style={{
            display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap',
            backgroundColor: 'white', padding: '16px', borderRadius: '10px',
            boxShadow: '0 1px 2px rgba(0,0,0,0.05)'
          }}>
            <input
              type="text"
              placeholder="Search outlets..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{
                flex: '1 1 200px',
                padding: '8px 12px',
                border: '1px solid #e2e8f0',
                borderRadius: '6px',
                fontSize: '14px'
              }}
            />
            <select
              value={tierFilter}
              onChange={e => setTierFilter(e.target.value)}
              style={{ padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', backgroundColor: 'white' }}
            >
              <option value="">All Tiers</option>
              {(['A', 'B', 'C', 'D'] as OutletTier[]).map(t => (
                <option key={t} value={t}>Tier {t}</option>
              ))}
            </select>
            <select
              value={countryFilter}
              onChange={e => setCountryFilter(e.target.value)}
              style={{ padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', backgroundColor: 'white' }}
            >
              <option value="">All Countries</option>
              {countries.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <select
              value={metacriticFilter}
              onChange={e => setMetacriticFilter(e.target.value)}
              style={{ padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', backgroundColor: 'white' }}
            >
              <option value="">Metacritic: All</option>
              <option value="true">Metacritic Only</option>
              <option value="false">Non-Metacritic</option>
            </select>
          </div>

          {/* Import Result */}
          {importResult && (
            <div style={{
              padding: '12px 16px',
              backgroundColor: importResult.startsWith('Error') ? '#fee2e2' : '#dcfce7',
              color: importResult.startsWith('Error') ? '#dc2626' : '#166534',
              borderRadius: '8px',
              marginBottom: '16px',
              fontSize: '14px'
            }}>
              {importResult}
            </div>
          )}

          {/* Traffic Refresh Result */}
          {trafficMessage && (
            <div style={{
              padding: '12px 16px',
              backgroundColor: trafficMessage.includes('error') || trafficMessage.includes('failed') || trafficMessage.includes('No traffic') ? '#fef3c7' : '#dcfce7',
              color: trafficMessage.includes('error') || trafficMessage.includes('failed') || trafficMessage.includes('No traffic') ? '#92400e' : '#166534',
              borderRadius: '8px',
              marginBottom: '16px',
              fontSize: '14px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <span>{trafficMessage}</span>
              <button
                onClick={() => setTrafficMessage(null)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px', opacity: 0.6 }}
              >
                x
              </button>
            </div>
          )}

          {/* Outlets Table */}
          <div style={{ backgroundColor: 'white', borderRadius: '10px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)', overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #e2e8f0', backgroundColor: '#f8fafc' }}>
                  <th
                    onClick={() => handleSort('name')}
                    style={{ textAlign: 'left', padding: '12px 16px', fontWeight: 600, color: '#475569', cursor: 'pointer', userSelect: 'none' }}
                  >
                    Outlet{sortIcon('name')}
                  </th>
                  <th style={{ textAlign: 'left', padding: '12px 16px', fontWeight: 600, color: '#475569' }}>
                    Domain
                  </th>
                  <th
                    onClick={() => handleSort('country')}
                    style={{ textAlign: 'left', padding: '12px 16px', fontWeight: 600, color: '#475569', cursor: 'pointer', userSelect: 'none' }}
                  >
                    Country{sortIcon('country')}
                  </th>
                  <th
                    onClick={() => handleSort('monthly_unique_visitors')}
                    style={{ textAlign: 'right', padding: '12px 16px', fontWeight: 600, color: '#475569', cursor: 'pointer', userSelect: 'none' }}
                  >
                    Traffic{sortIcon('monthly_unique_visitors')}
                  </th>
                  <th
                    onClick={() => handleSort('tier')}
                    style={{ textAlign: 'center', padding: '12px 16px', fontWeight: 600, color: '#475569', cursor: 'pointer', userSelect: 'none' }}
                  >
                    Tier{sortIcon('tier')}
                  </th>
                  <th style={{ textAlign: 'center', padding: '12px 16px', fontWeight: 600, color: '#475569' }}>
                    MC
                  </th>
                  <th style={{ textAlign: 'left', padding: '12px 16px', fontWeight: 600, color: '#475569' }}>
                    Tags
                  </th>
                  {canEdit && (
                    <th style={{ textAlign: 'right', padding: '12px 16px', fontWeight: 600, color: '#475569' }}>
                      Actions
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {outlets.length === 0 ? (
                  <tr>
                    <td colSpan={canEdit ? 8 : 7} style={{ padding: '40px 16px', textAlign: 'center', color: '#94a3b8' }}>
                      {debouncedSearch || tierFilter || countryFilter || metacriticFilter
                        ? 'No outlets match your filters'
                        : 'No outlets yet. Add your first outlet to get started.'}
                    </td>
                  </tr>
                ) : (
                  outlets.map((outlet, i) => {
                    const tier = outlet.tier as OutletTier | null
                    const tierColor = tier ? TIER_COLORS[tier] : null
                    const tags = Array.isArray(outlet.custom_tags) ? outlet.custom_tags : []
                    return (
                      <tr
                        key={outlet.id}
                        style={{
                          borderBottom: '1px solid #f1f5f9',
                          backgroundColor: outlet.is_blacklisted ? '#fef2f2' : (i % 2 === 0 ? 'white' : '#fafbfc'),
                          opacity: outlet.is_blacklisted ? 0.7 : 1
                        }}
                      >
                        <td style={{ padding: '10px 16px', fontWeight: 500, color: outlet.is_blacklisted ? '#991b1b' : '#1e293b' }}>
                          {outlet.is_blacklisted && (
                            <span style={{ marginRight: '6px', fontSize: '11px', color: '#dc2626' }} title="Blocked — scanner will skip this outlet">
                              BLOCKED
                            </span>
                          )}
                          {outlet.name}
                          {outlet.rss_feed_url && (
                            <span style={{ marginLeft: '6px', fontSize: '11px', color: '#f97316' }} title="RSS feed configured">
                              RSS
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '10px 16px' }}>
                          {outlet.domain ? (
                            <a
                              href={`https://${outlet.domain}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ color: '#2563eb', textDecoration: 'none', fontSize: '14px' }}
                              title={`Open https://${outlet.domain}`}
                            >
                              {outlet.domain}
                            </a>
                          ) : (
                            <span style={{ color: '#d1d5db' }}>—</span>
                          )}
                        </td>
                        <td style={{ padding: '10px 16px', color: '#64748b' }}>
                          {outlet.country || '—'}
                        </td>
                        <td style={{ padding: '10px 16px', textAlign: 'right', color: '#1e293b', fontVariantNumeric: 'tabular-nums' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '6px' }}>
                            <span>{formatNumber(outlet.monthly_unique_visitors)}</span>
                            {canEdit && outlet.domain && (
                              <button
                                onClick={() => handleRefreshTraffic(outlet.id, outlet.domain!)}
                                disabled={refreshingTraffic.has(outlet.id)}
                                title={`Refresh traffic from Hypestat for ${outlet.domain}`}
                                style={{
                                  padding: '2px 6px',
                                  backgroundColor: refreshingTraffic.has(outlet.id) ? '#e2e8f0' : 'transparent',
                                  color: refreshingTraffic.has(outlet.id) ? '#94a3b8' : '#64748b',
                                  border: '1px solid #e2e8f0',
                                  borderRadius: '4px',
                                  fontSize: '11px',
                                  cursor: refreshingTraffic.has(outlet.id) ? 'not-allowed' : 'pointer',
                                  lineHeight: 1
                                }}
                              >
                                {refreshingTraffic.has(outlet.id) ? '...' : '↻'}
                              </button>
                            )}
                          </div>
                        </td>
                        <td style={{ padding: '10px 16px', textAlign: 'center' }}>
                          {tier && tierColor ? (
                            <span style={{
                              display: 'inline-block',
                              padding: '2px 10px',
                              borderRadius: '9999px',
                              fontSize: '12px',
                              fontWeight: 600,
                              backgroundColor: tierColor.bg,
                              color: tierColor.text,
                              border: `1px solid ${tierColor.border}`
                            }}>
                              {tier}
                            </span>
                          ) : (
                            <span style={{ color: '#94a3b8' }}>—</span>
                          )}
                        </td>
                        <td style={{ padding: '10px 16px', textAlign: 'center' }}>
                          {outlet.metacritic_status ? (
                            <span style={{ color: '#16a34a', fontWeight: 600 }} title="Metacritic outlet">MC</span>
                          ) : (
                            <span style={{ color: '#d1d5db' }}>—</span>
                          )}
                        </td>
                        <td style={{ padding: '10px 16px' }}>
                          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                            {tags.slice(0, 3).map((tag: string, j: number) => (
                              <span key={j} style={{
                                padding: '1px 8px',
                                backgroundColor: '#f1f5f9',
                                borderRadius: '9999px',
                                fontSize: '11px',
                                color: '#475569'
                              }}>
                                {tag}
                              </span>
                            ))}
                            {tags.length > 3 && (
                              <span style={{ fontSize: '11px', color: '#94a3b8' }}>+{tags.length - 3}</span>
                            )}
                          </div>
                        </td>
                        {canEdit && (
                          <td style={{ padding: '10px 16px', textAlign: 'right' }}>
                            <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                              <button
                                onClick={() => handleToggleBlacklist(outlet)}
                                title={outlet.is_blacklisted ? 'Unblock this outlet — scanners will include it again' : 'Block this outlet — scanners will skip it'}
                                style={{
                                  padding: '4px 10px',
                                  backgroundColor: outlet.is_blacklisted ? '#fef2f2' : 'white',
                                  color: outlet.is_blacklisted ? '#16a34a' : '#dc2626',
                                  border: `1px solid ${outlet.is_blacklisted ? '#bbf7d0' : '#fecaca'}`,
                                  borderRadius: '4px',
                                  fontSize: '12px',
                                  cursor: 'pointer'
                                }}
                              >
                                {outlet.is_blacklisted ? 'Unblock' : 'Block'}
                              </button>
                              <button
                                onClick={() => openEditForm(outlet)}
                                style={{
                                  padding: '4px 10px',
                                  backgroundColor: 'white',
                                  color: '#475569',
                                  border: '1px solid #e2e8f0',
                                  borderRadius: '4px',
                                  fontSize: '12px',
                                  cursor: 'pointer'
                                }}
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => handleDelete(outlet.id)}
                                style={{
                                  padding: '4px 10px',
                                  backgroundColor: 'white',
                                  color: '#ef4444',
                                  border: '1px solid #fecaca',
                                  borderRadius: '4px',
                                  fontSize: '12px',
                                  cursor: 'pointer'
                                }}
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
            <div style={{ padding: '12px 16px', borderTop: '1px solid #f1f5f9', fontSize: '13px', color: '#64748b' }}>
              Showing {outlets.length} of {totalCount} outlets
            </div>
          </div>
        </div>
      </div>

      {/* Add/Edit Outlet Modal */}
      {showForm && (
        <div style={{
          position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50
        }}>
          <div style={{
            backgroundColor: 'white', borderRadius: '16px', padding: '32px',
            width: '560px', maxHeight: '90vh', overflow: 'auto',
            boxShadow: '0 25px 50px rgba(0,0,0,0.25)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
              <h2 style={{ fontSize: '20px', fontWeight: 700, color: '#1e293b', margin: 0 }}>
                {editingId ? 'Edit Outlet' : 'Add Outlet'}
              </h2>
              <button
                onClick={() => setShowForm(false)}
                style={{ background: 'none', border: 'none', fontSize: '24px', color: '#94a3b8', cursor: 'pointer' }}
              >
                ×
              </button>
            </div>

            {saveError && (
              <div style={{ padding: '10px 14px', backgroundColor: '#fee2e2', color: '#dc2626', borderRadius: '6px', marginBottom: '16px', fontSize: '13px' }}>
                {saveError}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>
                  Name *
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. IGN, PC Gamer"
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>
                  Domain
                </label>
                <input
                  type="text"
                  value={form.domain}
                  onChange={e => setForm(f => ({ ...f, domain: e.target.value }))}
                  placeholder="e.g. ign.com"
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>
                  Country
                </label>
                <input
                  type="text"
                  value={form.country}
                  onChange={e => setForm(f => ({ ...f, country: e.target.value }))}
                  placeholder="e.g. US, UK, Global"
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>
                  Monthly Unique Visitors
                </label>
                <input
                  type="number"
                  value={form.monthly_unique_visitors}
                  onChange={e => handleVisitorsChange(e.target.value)}
                  placeholder="e.g. 50000000"
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>
                  Tier {form.tier && <span style={{ fontWeight: 400, color: '#64748b' }}>— {TIER_LABELS[form.tier as OutletTier]}</span>}
                </label>
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <select
                    value={form.tier}
                    onChange={e => setForm(f => ({ ...f, tier: e.target.value as OutletTier | '' }))}
                    style={{ flex: 1, padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', backgroundColor: 'white' }}
                  >
                    <option value="">Auto-detect</option>
                    {(['A', 'B', 'C', 'D'] as OutletTier[]).map(t => (
                      <option key={t} value={t}>Tier {t}</option>
                    ))}
                  </select>
                  {form.monthly_unique_visitors && form.tier && (
                    <span style={{
                      padding: '4px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 600,
                      backgroundColor: TIER_COLORS[form.tier as OutletTier]?.bg,
                      color: TIER_COLORS[form.tier as OutletTier]?.text
                    }}>
                      Suggested
                    </span>
                  )}
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>
                  RSS Feed URL
                </label>
                <input
                  type="url"
                  value={form.rss_feed_url}
                  onChange={e => setForm(f => ({ ...f, rss_feed_url: e.target.value }))}
                  placeholder="https://..."
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>
                  Scan Frequency
                </label>
                <select
                  value={form.scan_frequency}
                  onChange={e => setForm(f => ({ ...f, scan_frequency: e.target.value as ScanFrequency }))}
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', backgroundColor: 'white', boxSizing: 'border-box' }}
                >
                  {SCAN_FREQUENCIES.map(f => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                </select>
              </div>

              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>
                  Custom Tags (comma-separated)
                </label>
                <input
                  type="text"
                  value={form.custom_tags}
                  onChange={e => setForm(f => ({ ...f, custom_tags: e.target.value }))}
                  placeholder="e.g. indie-friendly, AAA, mobile"
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box' }}
                />
              </div>

              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={form.metacritic_status}
                    onChange={e => setForm(f => ({ ...f, metacritic_status: e.target.checked }))}
                    style={{ width: '18px', height: '18px' }}
                  />
                  <span style={{ fontSize: '14px', color: '#374151' }}>Metacritic Outlet</span>
                  <span style={{ fontSize: '12px', color: '#94a3b8' }}>— review scores carry more weight</span>
                </label>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '24px', paddingTop: '16px', borderTop: '1px solid #f1f5f9' }}>
              <button
                onClick={() => setShowForm(false)}
                style={{ padding: '8px 20px', backgroundColor: 'white', color: '#475569', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                style={{
                  padding: '8px 24px', backgroundColor: '#2563eb', color: 'white', border: 'none',
                  borderRadius: '6px', fontSize: '14px', fontWeight: 500, cursor: saving ? 'not-allowed' : 'pointer',
                  opacity: saving ? 0.7 : 1
                }}
              >
                {saving ? 'Saving...' : editingId ? 'Save Changes' : 'Add Outlet'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CSV Import Modal */}
      {showImport && (
        <div style={{
          position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50
        }}>
          <div style={{
            backgroundColor: 'white', borderRadius: '16px', padding: '32px',
            width: '560px', maxHeight: '90vh', overflow: 'auto',
            boxShadow: '0 25px 50px rgba(0,0,0,0.25)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h2 style={{ fontSize: '20px', fontWeight: 700, color: '#1e293b', margin: 0 }}>Import Outlets from CSV</h2>
              <button
                onClick={() => setShowImport(false)}
                style={{ background: 'none', border: 'none', fontSize: '24px', color: '#94a3b8', cursor: 'pointer' }}
              >
                ×
              </button>
            </div>

            <p style={{ fontSize: '13px', color: '#64748b', marginBottom: '12px' }}>
              Paste CSV data with columns: <strong>name, domain, country, monthly_unique_visitors, tier, metacritic_status</strong>
            </p>
            <p style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '16px' }}>
              Header row is optional. Tier will be auto-detected from traffic if not provided. Duplicate domains are skipped.
            </p>

            <div style={{ marginBottom: '8px' }}>
              <label
                style={{
                  display: 'inline-block', padding: '6px 14px', backgroundColor: '#f1f5f9',
                  color: '#475569', border: '1px solid #e2e8f0', borderRadius: '6px',
                  fontSize: '12px', cursor: 'pointer', fontWeight: 500
                }}
              >
                Choose CSV File
                <input
                  type="file"
                  accept=".csv,.txt"
                  style={{ display: 'none' }}
                  onChange={e => {
                    const file = e.target.files?.[0]
                    if (!file) return
                    const reader = new FileReader()
                    reader.onload = ev => {
                      const text = ev.target?.result
                      if (typeof text === 'string') setCsvText(text)
                    }
                    reader.readAsText(file)
                    e.target.value = ''
                  }}
                />
              </label>
              <span style={{ fontSize: '12px', color: '#94a3b8', marginLeft: '8px' }}>or paste below</span>
            </div>

            <textarea
              value={csvText}
              onChange={e => setCsvText(e.target.value)}
              placeholder={`IGN,ign.com,US,50000000,A,true\nPC Gamer,pcgamer.com,US,12000000,A,true\nRock Paper Shotgun,rockpapershotgun.com,UK,3500000,B,false`}
              style={{
                width: '100%', height: '200px', padding: '12px', border: '1px solid #e2e8f0',
                borderRadius: '8px', fontSize: '13px', fontFamily: 'monospace',
                resize: 'vertical', boxSizing: 'border-box'
              }}
            />

            {importResult && (
              <div style={{
                padding: '10px 14px', marginTop: '12px',
                backgroundColor: importResult.startsWith('Error') ? '#fee2e2' : '#dcfce7',
                color: importResult.startsWith('Error') ? '#dc2626' : '#166534',
                borderRadius: '6px', fontSize: '13px'
              }}>
                {importResult}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
              <button
                onClick={() => setShowImport(false)}
                style={{ padding: '8px 20px', backgroundColor: 'white', color: '#475569', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={handleCSVImport}
                disabled={importing || !csvText.trim()}
                style={{
                  padding: '8px 24px', backgroundColor: '#2563eb', color: 'white', border: 'none',
                  borderRadius: '6px', fontSize: '14px', fontWeight: 500,
                  cursor: importing || !csvText.trim() ? 'not-allowed' : 'pointer',
                  opacity: importing || !csvText.trim() ? 0.7 : 1
                }}
              >
                {importing ? 'Importing...' : 'Import'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
