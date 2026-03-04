'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Sidebar } from '../../components/Sidebar'
import { useAuth } from '@/lib/auth-context'
import Link from 'next/link'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'

// ─── Types ──────────────────────────────────────────────────────────────────

interface CoverageItem {
  id: string
  client_id: string | null
  game_id: string | null
  outlet_id: string | null
  campaign_id: string | null
  title: string
  url: string
  publish_date: string | null
  territory: string | null
  coverage_type: string | null
  monthly_unique_visitors: number | null
  review_score: number | null
  quotes: string | null
  sentiment: string | null
  relevance_score: number | null
  relevance_reasoning: string | null
  approval_status: string
  source_type: string
  campaign_section: string | null
  duplicate_group_id: string | null
  is_original: boolean
  syndication_count: number
  discovered_at: string
  created_at: string
  outlet?: { id: string; name: string; domain: string | null; tier: string | null; monthly_unique_visitors: number | null } | null
  game?: { id: string; name: string } | null
  client?: { id: string; name: string } | null
  campaign?: { id: string; name: string } | null
}

interface GameOption { id: string; name: string; client_id: string }
interface ClientOption { id: string; name: string }
interface CampaignOption { id: string; name: string; client_id: string | null; game_id: string | null }

// ─── Constants ──────────────────────────────────────────────────────────────

const COVERAGE_TYPES = ['news', 'review', 'preview', 'interview', 'trailer', 'trailer_repost', 'stream', 'video', 'guide', 'roundup', 'mention', 'feature']
const SENTIMENTS = ['positive', 'neutral', 'negative', 'mixed']
const APPROVAL_STATUSES = ['auto_approved', 'pending_review', 'rejected', 'manually_approved']
const SOURCE_TYPES = ['rss', 'tavily', 'youtube', 'twitch', 'reddit', 'twitter', 'tiktok', 'instagram', 'manual']

const APPROVAL_COLORS: Record<string, { bg: string; text: string }> = {
  auto_approved: { bg: '#dcfce7', text: '#166534' },
  manually_approved: { bg: '#dcfce7', text: '#166534' },
  pending_review: { bg: '#fef9c3', text: '#854d0e' },
  rejected: { bg: '#fee2e2', text: '#dc2626' }
}

const SENTIMENT_COLORS: Record<string, { bg: string; text: string }> = {
  positive: { bg: '#dcfce7', text: '#166534' },
  neutral: { bg: '#f3f4f6', text: '#374151' },
  negative: { bg: '#fee2e2', text: '#dc2626' },
  mixed: { bg: '#fef9c3', text: '#854d0e' }
}

const TIER_COLORS: Record<string, { bg: string; text: string }> = {
  A: { bg: '#dcfce7', text: '#166534' },
  B: { bg: '#dbeafe', text: '#1e40af' },
  C: { bg: '#fef9c3', text: '#854d0e' },
  D: { bg: '#f3f4f6', text: '#374151' }
}

function formatNumber(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return n.toLocaleString()
}

function formatDate(d: string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function CoverageFeedPage() {
  const { hasAccess, loading: authLoading } = useAuth()
  const canView = hasAccess('pr_coverage', 'view')
  const canEdit = hasAccess('pr_coverage', 'edit')
  const supabase = createClientComponentClient()

  // Data
  const [items, setItems] = useState<CoverageItem[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [isLoading, setIsLoading] = useState(true)

  // Reference data
  const [clients, setClients] = useState<ClientOption[]>([])
  const [games, setGames] = useState<GameOption[]>([])
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([])

  // Filters
  const [clientFilter, setClientFilter] = useState('')
  const [gameFilter, setGameFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [sentimentFilter, setSentimentFilter] = useState('')
  const [approvalFilter, setApprovalFilter] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')
  const [tierFilter, setTierFilter] = useState('')
  const [territoryFilter, setTerritoryFilter] = useState('')
  const [campaignFilter, setCampaignFilter] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const searchTimeout = useRef<NodeJS.Timeout | null>(null)

  // Sort
  const [sortBy, setSortBy] = useState('monthly_unique_visitors')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  // View mode
  const [viewMode, setViewMode] = useState<'all' | 'pending'>('all')
  const [hideDuplicates, setHideDuplicates] = useState(false)

  // Selection
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // Debounced search
  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current)
    searchTimeout.current = setTimeout(() => setDebouncedSearch(search), 300)
    return () => { if (searchTimeout.current) clearTimeout(searchTimeout.current) }
  }, [search])

  // Fetch reference data
  useEffect(() => {
    if (!canView) return
    async function load() {
      const [clientsRes, gamesRes, campaignsRes] = await Promise.all([
        supabase.from('clients').select('id, name').order('name'),
        supabase.from('games').select('id, name, client_id').order('name'),
        supabase.from('coverage_campaigns').select('id, name, client_id, game_id').order('name')
      ])
      if (clientsRes.data) setClients(clientsRes.data)
      if (gamesRes.data) setGames(gamesRes.data)
      if (campaignsRes.data) setCampaigns(campaignsRes.data)
    }
    load()
  }, [canView, supabase])

  // Fetch coverage items
  const fetchItems = useCallback(async () => {
    setIsLoading(true)
    const params = new URLSearchParams()
    if (clientFilter) params.set('client_id', clientFilter)
    if (gameFilter) params.set('game_id', gameFilter)
    if (typeFilter) params.set('coverage_type', typeFilter)
    if (sentimentFilter) params.set('sentiment', sentimentFilter)
    if (viewMode === 'pending') params.set('approval_status', 'pending_review')
    else if (approvalFilter) params.set('approval_status', approvalFilter)
    if (sourceFilter) params.set('source_type', sourceFilter)
    if (tierFilter) params.set('tier', tierFilter)
    if (territoryFilter) params.set('territory', territoryFilter)
    if (campaignFilter) params.set('campaign_id', campaignFilter)
    if (dateFrom) params.set('date_from', dateFrom)
    if (dateTo) params.set('date_to', dateTo)
    if (debouncedSearch) params.set('search', debouncedSearch)
    if (hideDuplicates) params.set('hide_duplicates', 'true')
    params.set('sort_by', sortBy)
    params.set('sort_dir', sortDir)
    params.set('limit', '200')

    try {
      const res = await fetch(`/api/coverage-items?${params}`)
      if (res.ok) {
        const json = await res.json()
        setItems(json.data || [])
        setTotalCount(json.count || 0)
      }
    } catch (err) {
      console.error('Failed to fetch coverage items:', err)
    }
    setIsLoading(false)
  }, [clientFilter, gameFilter, typeFilter, sentimentFilter, approvalFilter, sourceFilter, tierFilter, territoryFilter, campaignFilter, dateFrom, dateTo, debouncedSearch, sortBy, sortDir, viewMode, hideDuplicates])

  useEffect(() => {
    if (canView) fetchItems()
  }, [canView, fetchItems])

  // Actions
  const handleApprove = async (id: string) => {
    await fetch('/api/coverage-items', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, approval_status: 'manually_approved' })
    })
    fetchItems()
  }

  const handleReject = async (id: string) => {
    await fetch('/api/coverage-items', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, approval_status: 'rejected' })
    })
    fetchItems()
  }

  const handleBulkAction = async (status: string) => {
    if (selected.size === 0) return
    await fetch('/api/coverage-items', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bulk_ids: Array.from(selected), approval_status: status })
    })
    setSelected(new Set())
    fetchItems()
  }

  const handleSort = (col: string) => {
    if (sortBy === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortBy(col)
      setSortDir(col === 'title' ? 'asc' : 'desc')
    }
  }

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selected.size === items.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(items.map(i => i.id)))
    }
  }

  const sortIcon = (col: string) => {
    if (sortBy !== col) return ' ↕'
    return sortDir === 'asc' ? ' ↑' : ' ↓'
  }

  // Filter games by selected client
  const filteredGames = clientFilter ? games.filter(g => g.client_id === clientFilter) : games
  const filteredCampaigns = clientFilter
    ? campaigns.filter(c => c.client_id === clientFilter)
    : campaigns

  // Stats
  const pendingCount = items.filter(i => i.approval_status === 'pending_review').length
  const approvedCount = items.filter(i => i.approval_status === 'manually_approved' || i.approval_status === 'auto_approved').length
  const rejectedCount = items.filter(i => i.approval_status === 'rejected').length

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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
            <div>
              <h1 style={{ fontSize: '28px', fontWeight: 700, color: '#1e293b', margin: 0 }}>Coverage Feed</h1>
              <p style={{ fontSize: '14px', color: '#64748b', margin: '4px 0 0 0' }}>
                Review, approve, and manage incoming media coverage
              </p>
            </div>
          </div>

          {/* Top nav */}
          <div style={{ display: 'flex', gap: '0', marginBottom: '24px', borderBottom: '2px solid #e2e8f0' }}>
            <Link href="/coverage" style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 500, color: '#64748b', textDecoration: 'none', marginBottom: '-2px' }}>
              Outlets
            </Link>
            <Link href="/coverage/keywords" style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 500, color: '#64748b', textDecoration: 'none', marginBottom: '-2px' }}>
              Keywords
            </Link>
            <Link href="/coverage/settings" style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 500, color: '#64748b', textDecoration: 'none', marginBottom: '-2px' }}>
              API Keys
            </Link>
            <Link href="/coverage/sources" style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 500, color: '#64748b', textDecoration: 'none', marginBottom: '-2px' }}>
              Sources
            </Link>
            <div style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 600, color: '#2563eb', borderBottom: '2px solid #2563eb', marginBottom: '-2px' }}>
              Feed
            </div>
            <Link href="/coverage/dashboard" style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 500, color: '#64748b', textDecoration: 'none', marginBottom: '-2px' }}>
              Dashboard
            </Link>
            <Link href="/coverage/timeline" style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 500, color: '#64748b', textDecoration: 'none', marginBottom: '-2px' }}>
              Timeline
            </Link>
            <Link href="/coverage/report" style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 500, color: '#64748b', textDecoration: 'none', marginBottom: '-2px' }}>
              Export
            </Link>
            <Link href="/coverage/clients" style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 500, color: '#64748b', textDecoration: 'none', marginBottom: '-2px' }}>
              Clients &amp; Games
            </Link>
            <Link href="/coverage/guide" style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 500, color: '#64748b', textDecoration: 'none', marginBottom: '-2px' }}>
              Guide
            </Link>
          </div>

          {/* View mode toggle + stats */}
          <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', alignItems: 'center' }}>
            <button
              onClick={() => setViewMode('all')}
              style={{
                padding: '8px 16px', borderRadius: '8px', fontSize: '13px', fontWeight: 500, cursor: 'pointer',
                backgroundColor: viewMode === 'all' ? '#2563eb' : 'white',
                color: viewMode === 'all' ? 'white' : '#475569',
                border: viewMode === 'all' ? '1px solid #2563eb' : '1px solid #e2e8f0'
              }}
            >
              All Coverage ({totalCount})
            </button>
            <button
              onClick={() => setViewMode('pending')}
              style={{
                padding: '8px 16px', borderRadius: '8px', fontSize: '13px', fontWeight: 500, cursor: 'pointer',
                backgroundColor: viewMode === 'pending' ? '#f59e0b' : 'white',
                color: viewMode === 'pending' ? 'white' : '#475569',
                border: viewMode === 'pending' ? '1px solid #f59e0b' : '1px solid #e2e8f0'
              }}
            >
              Review Queue ({pendingCount})
            </button>
            <button
              onClick={() => setHideDuplicates(!hideDuplicates)}
              style={{
                padding: '8px 16px', borderRadius: '8px', fontSize: '13px', fontWeight: 500, cursor: 'pointer',
                backgroundColor: hideDuplicates ? '#7c3aed' : 'white',
                color: hideDuplicates ? 'white' : '#475569',
                border: hideDuplicates ? '1px solid #7c3aed' : '1px solid #e2e8f0'
              }}
            >
              {hideDuplicates ? 'Showing Unique' : 'Collapse Duplicates'}
            </button>
            <div style={{ flex: 1 }} />
            <div style={{ display: 'flex', gap: '8px', fontSize: '13px' }}>
              <span style={{ padding: '4px 10px', borderRadius: '6px', backgroundColor: '#dcfce7', color: '#166534' }}>
                {approvedCount} approved
              </span>
              <span style={{ padding: '4px 10px', borderRadius: '6px', backgroundColor: '#fef9c3', color: '#854d0e' }}>
                {pendingCount} pending
              </span>
              <span style={{ padding: '4px 10px', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#dc2626' }}>
                {rejectedCount} rejected
              </span>
            </div>
          </div>

          {/* Filters */}
          <div style={{
            backgroundColor: 'white', padding: '16px', borderRadius: '10px',
            boxShadow: '0 1px 2px rgba(0,0,0,0.05)', marginBottom: '16px'
          }}>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <input
                type="text"
                placeholder="Search titles..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{ flex: '1 1 180px', padding: '7px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px' }}
              />
              <select value={clientFilter} onChange={e => { setClientFilter(e.target.value); setGameFilter(''); setCampaignFilter('') }}
                style={{ padding: '7px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px', backgroundColor: 'white' }}>
                <option value="">All Clients</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <select value={gameFilter} onChange={e => setGameFilter(e.target.value)}
                style={{ padding: '7px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px', backgroundColor: 'white' }}>
                <option value="">All Games</option>
                {filteredGames.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
              <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
                style={{ padding: '7px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px', backgroundColor: 'white' }}>
                <option value="">All Types</option>
                {COVERAGE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <select value={tierFilter} onChange={e => setTierFilter(e.target.value)}
                style={{ padding: '7px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px', backgroundColor: 'white' }}>
                <option value="">All Tiers</option>
                {['A', 'B', 'C', 'D'].map(t => <option key={t} value={t}>Tier {t}</option>)}
              </select>
              <select value={sentimentFilter} onChange={e => setSentimentFilter(e.target.value)}
                style={{ padding: '7px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px', backgroundColor: 'white' }}>
                <option value="">All Sentiments</option>
                {SENTIMENTS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              {viewMode !== 'pending' && (
                <select value={approvalFilter} onChange={e => setApprovalFilter(e.target.value)}
                  style={{ padding: '7px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px', backgroundColor: 'white' }}>
                  <option value="">All Statuses</option>
                  {APPROVAL_STATUSES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
                </select>
              )}
              <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}
                style={{ padding: '7px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px', backgroundColor: 'white' }}>
                <option value="">All Sources</option>
                {SOURCE_TYPES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: '10px', marginTop: '10px', alignItems: 'center' }}>
              <label style={{ fontSize: '12px', color: '#64748b' }}>Date:</label>
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px' }} />
              <span style={{ fontSize: '12px', color: '#94a3b8' }}>to</span>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px' }} />
              <select value={campaignFilter} onChange={e => setCampaignFilter(e.target.value)}
                style={{ padding: '7px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px', backgroundColor: 'white' }}>
                <option value="">All Campaigns</option>
                {filteredCampaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {(clientFilter || gameFilter || typeFilter || sentimentFilter || approvalFilter || sourceFilter || tierFilter || dateFrom || dateTo || search || campaignFilter) && (
                <button
                  onClick={() => {
                    setClientFilter(''); setGameFilter(''); setTypeFilter(''); setSentimentFilter('')
                    setApprovalFilter(''); setSourceFilter(''); setTierFilter(''); setTerritoryFilter('')
                    setDateFrom(''); setDateTo(''); setSearch(''); setCampaignFilter('')
                  }}
                  style={{ padding: '6px 12px', fontSize: '12px', color: '#ef4444', backgroundColor: 'white', border: '1px solid #fecaca', borderRadius: '6px', cursor: 'pointer' }}
                >
                  Clear Filters
                </button>
              )}
            </div>
          </div>

          {/* Bulk actions */}
          {canEdit && selected.size > 0 && (
            <div style={{
              backgroundColor: '#eff6ff', padding: '10px 16px', borderRadius: '8px',
              marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '12px',
              border: '1px solid #bfdbfe'
            }}>
              <span style={{ fontSize: '13px', fontWeight: 500, color: '#1e40af' }}>
                {selected.size} selected
              </span>
              <button
                onClick={() => handleBulkAction('manually_approved')}
                style={{ padding: '5px 12px', backgroundColor: '#16a34a', color: 'white', border: 'none', borderRadius: '6px', fontSize: '12px', cursor: 'pointer', fontWeight: 500 }}
              >
                Approve All
              </button>
              <button
                onClick={() => handleBulkAction('rejected')}
                style={{ padding: '5px 12px', backgroundColor: '#dc2626', color: 'white', border: 'none', borderRadius: '6px', fontSize: '12px', cursor: 'pointer', fontWeight: 500 }}
              >
                Reject All
              </button>
              <button
                onClick={() => setSelected(new Set())}
                style={{ padding: '5px 12px', backgroundColor: 'white', color: '#475569', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}
              >
                Deselect
              </button>
            </div>
          )}

          {/* Table */}
          <div style={{ backgroundColor: 'white', borderRadius: '10px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)', overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #e2e8f0', backgroundColor: '#f8fafc' }}>
                    {canEdit && (
                      <th style={{ padding: '10px 12px', width: '40px' }}>
                        <input type="checkbox" checked={selected.size === items.length && items.length > 0}
                          onChange={toggleSelectAll} style={{ width: '16px', height: '16px' }} />
                      </th>
                    )}
                    <th onClick={() => handleSort('publish_date')}
                      style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600, color: '#475569', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
                      Date{sortIcon('publish_date')}
                    </th>
                    <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600, color: '#475569' }}>
                      Outlet
                    </th>
                    <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600, color: '#475569' }}>
                      Type
                    </th>
                    <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600, color: '#475569', maxWidth: '300px' }}>
                      Title
                    </th>
                    <th onClick={() => handleSort('monthly_unique_visitors')}
                      style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 600, color: '#475569', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
                      Traffic{sortIcon('monthly_unique_visitors')}
                    </th>
                    <th style={{ textAlign: 'center', padding: '10px 12px', fontWeight: 600, color: '#475569' }}>
                      Tier
                    </th>
                    <th onClick={() => handleSort('review_score')}
                      style={{ textAlign: 'center', padding: '10px 12px', fontWeight: 600, color: '#475569', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
                      Score{sortIcon('review_score')}
                    </th>
                    <th style={{ textAlign: 'center', padding: '10px 12px', fontWeight: 600, color: '#475569' }}>
                      Sentiment
                    </th>
                    <th style={{ textAlign: 'center', padding: '10px 12px', fontWeight: 600, color: '#475569' }}>
                      Status
                    </th>
                    <th style={{ textAlign: 'center', padding: '10px 12px', fontWeight: 600, color: '#475569' }}>
                      Source
                    </th>
                    {canEdit && (
                      <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 600, color: '#475569' }}>
                        Actions
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 ? (
                    <tr>
                      <td colSpan={canEdit ? 12 : 10} style={{ padding: '60px 16px', textAlign: 'center', color: '#94a3b8' }}>
                        {viewMode === 'pending' ? 'No items pending review.' : 'No coverage items found.'}
                        {!debouncedSearch && !clientFilter && !gameFilter && viewMode === 'all' && (
                          <div style={{ marginTop: '8px', fontSize: '13px' }}>
                            Coverage items will appear here as scrapers discover them, or you can add items manually.
                          </div>
                        )}
                      </td>
                    </tr>
                  ) : (
                    items.map((item, i) => {
                      const tier = item.outlet?.tier
                      const tierColor = tier ? TIER_COLORS[tier] : null
                      const approvalColor = APPROVAL_COLORS[item.approval_status] || APPROVAL_COLORS.pending_review
                      const sentimentColor = item.sentiment ? SENTIMENT_COLORS[item.sentiment] : null

                      return (
                        <tr
                          key={item.id}
                          style={{
                            borderBottom: '1px solid #f1f5f9',
                            backgroundColor: selected.has(item.id) ? '#eff6ff' : i % 2 === 0 ? 'white' : '#fafbfc'
                          }}
                        >
                          {canEdit && (
                            <td style={{ padding: '8px 12px' }}>
                              <input type="checkbox" checked={selected.has(item.id)}
                                onChange={() => toggleSelect(item.id)} style={{ width: '16px', height: '16px' }} />
                            </td>
                          )}
                          <td style={{ padding: '8px 12px', color: '#64748b', whiteSpace: 'nowrap', fontSize: '12px' }}>
                            {formatDate(item.publish_date)}
                          </td>
                          <td style={{ padding: '8px 12px' }}>
                            <div style={{ fontWeight: 500, color: '#1e293b', fontSize: '13px' }}>
                              {item.outlet?.name || '—'}
                            </div>
                            {item.territory && (
                              <div style={{ fontSize: '11px', color: '#94a3b8' }}>{item.territory}</div>
                            )}
                          </td>
                          <td style={{ padding: '8px 12px' }}>
                            {item.coverage_type ? (
                              <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '9999px', backgroundColor: '#f1f5f9', color: '#475569' }}>
                                {item.coverage_type}
                              </span>
                            ) : <span style={{ color: '#d1d5db' }}>—</span>}
                          </td>
                          <td style={{ padding: '8px 12px', maxWidth: '350px' }}>
                            <a
                              href={item.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ color: '#2563eb', textDecoration: 'none', fontSize: '13px', lineHeight: '1.3', fontWeight: 500 }}
                              title={item.url}
                            >
                              {item.title}
                            </a>
                            {item.url && (
                              <a
                                href={item.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{
                                  display: 'block',
                                  fontSize: '11px',
                                  color: '#94a3b8',
                                  textDecoration: 'none',
                                  marginTop: '1px',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                  maxWidth: '320px',
                                }}
                                title={item.url}
                              >
                                {item.url.replace(/^https?:\/\/(www\.)?/, '').substring(0, 60)}{item.url.replace(/^https?:\/\/(www\.)?/, '').length > 60 ? '...' : ''}
                              </a>
                            )}
                            <div style={{ display: 'flex', gap: '4px', marginTop: '2px', alignItems: 'center' }}>
                              {item.game && (
                                <span style={{ fontSize: '11px', color: '#94a3b8' }}>
                                  {item.game.name}
                                </span>
                              )}
                              {item.syndication_count > 1 && (
                                <span style={{ fontSize: '10px', fontWeight: 600, padding: '1px 6px', borderRadius: '10px', background: '#ede9fe', color: '#7c3aed' }} title={`${item.syndication_count} syndicated versions`}>
                                  {item.syndication_count} syndications
                                </span>
                              )}
                              {item.is_original === false && (
                                <span style={{ fontSize: '10px', fontWeight: 600, padding: '1px 6px', borderRadius: '10px', background: '#f3f4f6', color: '#6b7280' }}>
                                  syndicated
                                </span>
                              )}
                            </div>
                          </td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#1e293b' }}>
                            {formatNumber(item.monthly_unique_visitors || item.outlet?.monthly_unique_visitors)}
                          </td>
                          <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                            {tier && tierColor ? (
                              <span style={{
                                display: 'inline-block', padding: '2px 8px', borderRadius: '9999px',
                                fontSize: '11px', fontWeight: 600, backgroundColor: tierColor.bg, color: tierColor.text
                              }}>
                                {tier}
                              </span>
                            ) : <span style={{ color: '#d1d5db' }}>—</span>}
                          </td>
                          <td style={{ padding: '8px 12px', textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
                            {item.review_score != null ? (
                              <span style={{ fontWeight: 600, color: item.review_score >= 80 ? '#16a34a' : item.review_score >= 60 ? '#ca8a04' : '#dc2626' }}>
                                {item.review_score}
                              </span>
                            ) : <span style={{ color: '#d1d5db' }}>—</span>}
                          </td>
                          <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                            {item.sentiment && sentimentColor ? (
                              <span style={{
                                fontSize: '11px', padding: '2px 8px', borderRadius: '9999px',
                                backgroundColor: sentimentColor.bg, color: sentimentColor.text
                              }}>
                                {item.sentiment}
                              </span>
                            ) : <span style={{ color: '#d1d5db' }}>—</span>}
                          </td>
                          <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                            <span style={{
                              fontSize: '11px', padding: '2px 8px', borderRadius: '9999px',
                              backgroundColor: approvalColor.bg, color: approvalColor.text
                            }}>
                              {item.approval_status.replace('_', ' ')}
                            </span>
                            {item.relevance_score != null && (
                              <div style={{ fontSize: '10px', color: '#94a3b8', marginTop: '2px' }}>
                                rel: {item.relevance_score}%
                              </div>
                            )}
                          </td>
                          <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                            <span style={{ fontSize: '11px', color: '#64748b' }}>
                              {item.source_type}
                            </span>
                          </td>
                          {canEdit && (
                            <td style={{ padding: '8px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                              {item.approval_status === 'pending_review' ? (
                                <div style={{ display: 'flex', gap: '4px', justifyContent: 'flex-end' }}>
                                  <button
                                    onClick={() => handleApprove(item.id)}
                                    style={{ padding: '3px 8px', backgroundColor: '#dcfce7', color: '#166534', border: '1px solid #86efac', borderRadius: '4px', fontSize: '11px', cursor: 'pointer', fontWeight: 500 }}
                                  >
                                    Approve
                                  </button>
                                  <button
                                    onClick={() => handleReject(item.id)}
                                    style={{ padding: '3px 8px', backgroundColor: '#fee2e2', color: '#dc2626', border: '1px solid #fecaca', borderRadius: '4px', fontSize: '11px', cursor: 'pointer', fontWeight: 500 }}
                                  >
                                    Reject
                                  </button>
                                </div>
                              ) : item.approval_status === 'rejected' ? (
                                <button
                                  onClick={() => handleApprove(item.id)}
                                  style={{ padding: '3px 8px', backgroundColor: 'white', color: '#475569', border: '1px solid #e2e8f0', borderRadius: '4px', fontSize: '11px', cursor: 'pointer' }}
                                >
                                  Restore
                                </button>
                              ) : (
                                <button
                                  onClick={() => handleReject(item.id)}
                                  style={{ padding: '3px 8px', backgroundColor: 'white', color: '#94a3b8', border: '1px solid #e2e8f0', borderRadius: '4px', fontSize: '11px', cursor: 'pointer' }}
                                >
                                  Reject
                                </button>
                              )}
                            </td>
                          )}
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
            <div style={{ padding: '12px 16px', borderTop: '1px solid #f1f5f9', fontSize: '13px', color: '#64748b' }}>
              Showing {items.length} of {totalCount} items
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
