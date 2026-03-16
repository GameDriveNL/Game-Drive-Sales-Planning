'use client'

import { useState, useEffect, useCallback } from 'react'
import { Sidebar } from '../../components/Sidebar'
import { useAuth } from '@/lib/auth-context'
import Link from 'next/link'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import { CoverageNav } from '../components/CoverageNav'

// ─── Types ──────────────────────────────────────────────────────────────────

type SourceType = 'rss' | 'tavily' | 'youtube' | 'twitch' | 'reddit' | 'twitter' | 'tiktok' | 'instagram' | 'sullygnome' | 'semrush'
type ScanFrequency = 'hourly' | 'every_6h' | 'daily' | 'weekly'

interface CoverageSource {
  id: string
  source_type: SourceType
  name: string
  description: string | null
  config: Record<string, unknown>
  outlet_id: string | null
  game_id: string | null
  scan_frequency: ScanFrequency
  is_active: boolean
  last_run_at: string | null
  last_run_status: string | null
  last_run_message: string | null
  items_found_last_run: number
  total_items_found: number
  consecutive_failures: number
  created_at: string
  outlet?: { id: string; name: string; domain: string | null; tier: string | null } | null
  game?: { id: string; name: string } | null
}

interface OutletOption { id: string; name: string; domain: string | null; rss_feed_url: string | null }
interface GameOption { id: string; name: string; client_id: string }

// ─── Constants ──────────────────────────────────────────────────────────────

const TAB_KEYS = ['rss', 'web', 'apify'] as const
type TabKey = typeof TAB_KEYS[number]

const TAB_LABELS: Record<TabKey, string> = {
  rss: 'RSS Feeds',
  web: 'Web Monitoring',
  apify: 'Apify Integrations'
}

const TAB_SOURCE_TYPES: Record<TabKey, SourceType[]> = {
  rss: ['rss'],
  web: ['tavily'],
  apify: ['youtube', 'twitch', 'reddit', 'twitter', 'tiktok', 'instagram', 'sullygnome', 'semrush']
}

const SOURCE_LABELS: Record<SourceType, string> = {
  rss: 'RSS Feed',
  tavily: 'Tavily Web Search',
  youtube: 'YouTube',
  twitch: 'Twitch',
  reddit: 'Reddit',
  twitter: 'Twitter/X',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  sullygnome: 'SullyGnome',
  semrush: 'SEMRush'
}

const SOURCE_ICONS: Record<SourceType, string> = {
  rss: '📡',
  tavily: '🔍',
  youtube: '▶️',
  twitch: '🎮',
  reddit: '💬',
  twitter: '𝕏',
  tiktok: '🎵',
  instagram: '📷',
  sullygnome: '📊',
  semrush: '📈'
}

const FREQ_OPTIONS: { value: ScanFrequency; label: string }[] = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'every_6h', label: 'Every 6 hours' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' }
]

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  success: { bg: '#dcfce7', text: '#166534' },
  failed: { bg: '#fee2e2', text: '#dc2626' },
  error: { bg: '#fee2e2', text: '#dc2626' },
  running: { bg: '#dbeafe', text: '#1e40af' },
  never: { bg: '#f3f4f6', text: '#6b7280' }
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'Never'
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function SourcesPage() {
  const { hasAccess, loading: authLoading } = useAuth()
  const canView = hasAccess('pr_coverage', 'view')
  const canEdit = hasAccess('pr_coverage', 'edit')
  const supabase = createClientComponentClient()

  const [activeTab, setActiveTab] = useState<TabKey>('rss')
  const [sources, setSources] = useState<CoverageSource[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // Reference data
  const [outlets, setOutlets] = useState<OutletOption[]>([])
  const [games, setGames] = useState<GameOption[]>([])

  // Form state
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formType, setFormType] = useState<SourceType>('rss')
  const [formName, setFormName] = useState('')
  const [formDesc, setFormDesc] = useState('')
  const [formFreq, setFormFreq] = useState<ScanFrequency>('daily')
  const [formActive, setFormActive] = useState(true)
  const [formOutletId, setFormOutletId] = useState('')
  const [formGameId, setFormGameId] = useState('')
  const [formConfig, setFormConfig] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Bulk import
  const [showBulk, setShowBulk] = useState(false)
  const [bulkText, setBulkText] = useState('')
  const [bulkImporting, setBulkImporting] = useState(false)
  const [bulkResult, setBulkResult] = useState<string | null>(null)

  // API key status
  const [apiKeyStatus, setApiKeyStatus] = useState<Record<string, { configured: boolean; credits?: number }>>({})

  // Global keyword scan stats (platforms that run via cron off keywords, not coverage_sources)
  const [platformStats, setPlatformStats] = useState<Record<string, { total: number; lastSeen: string | null }>>({})

  // Scan state
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState<string | null>(null)
  const [scanningTavily, setScanningTavily] = useState(false)
  const [tavilyScanResult, setTavilyScanResult] = useState<string | null>(null)
  const [scanningSullyGnome, setScanningSullyGnome] = useState(false)
  const [sullyGnomeScanResult, setSullyGnomeScanResult] = useState<string | null>(null)
  const [showSullyGnomeUpload, setShowSullyGnomeUpload] = useState(false)
  const [sullyGnomeUploading, setSullyGnomeUploading] = useState(false)
  const [sullyGnomeUploadResult, setSullyGnomeUploadResult] = useState<string | null>(null)

  // ─── Data fetching ────────────────────────────────────────────────────────

  const fetchSources = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await fetch('/api/coverage-sources')
      if (res.ok) {
        const data = await res.json()
        setSources(data)
      }
    } catch (err) {
      console.error('Failed to fetch sources:', err)
    }
    setIsLoading(false)
  }, [])

  const fetchReferenceData = useCallback(async () => {
    try {
      const [outletsRes, gamesRes] = await Promise.all([
        fetch('/api/outlets?limit=500&sortBy=name&sortDir=asc'),
        supabase.from('games').select('id, name, client_id').order('name')
      ])
      if (outletsRes.ok) {
        const json = await outletsRes.json()
        setOutlets(json.data || [])
      }
      if (gamesRes.data) {
        setGames(gamesRes.data)
      }
    } catch (err) {
      console.error('Failed to fetch reference data:', err)
    }
  }, [supabase])

  const fetchPlatformStats = useCallback(async () => {
    try {
      const res = await fetch('/api/coverage-platform-stats')
      if (res.ok) setPlatformStats(await res.json())
    } catch (err) {
      console.error('Failed to fetch platform stats:', err)
    }
  }, [])

  const fetchApiKeyStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/service-api-keys')
      if (res.ok) {
        const data = await res.json()
        const statusMap: Record<string, { configured: boolean; credits?: number }> = {}
        for (const svc of data) {
          statusMap[svc.service_name] = {
            configured: svc.is_configured,
            credits: svc.credits_remaining ? parseFloat(svc.credits_remaining) : undefined
          }
        }
        setApiKeyStatus(statusMap)
      }
    } catch (err) {
      console.error('Failed to fetch API key status:', err)
    }
  }, [])

  useEffect(() => {
    if (canView) {
      fetchSources()
      fetchReferenceData()
      fetchApiKeyStatus()
      fetchPlatformStats()
    }
  }, [canView, fetchSources, fetchReferenceData, fetchApiKeyStatus, fetchPlatformStats])

  // ─── Filtered sources ─────────────────────────────────────────────────────

  const tabSources = sources.filter(s => TAB_SOURCE_TYPES[activeTab].includes(s.source_type))
  const activeCount = (types: SourceType[]) => sources.filter(s => types.includes(s.source_type) && s.is_active).length
  const totalCount = (types: SourceType[]) => sources.filter(s => types.includes(s.source_type)).length

  // ─── Form logic ───────────────────────────────────────────────────────────

  const resetForm = () => {
    setEditingId(null)
    setFormName('')
    setFormDesc('')
    setFormFreq('daily')
    setFormActive(true)
    setFormOutletId('')
    setFormGameId('')
    setFormConfig({})
    setSaveError(null)
  }

  const openAddForm = (type: SourceType) => {
    resetForm()
    setFormType(type)
    // Default frequencies by type
    if (type === 'rss') setFormFreq('hourly')
    else if (type === 'tavily') setFormFreq('daily')
    else if (['youtube', 'twitch', 'reddit'].includes(type)) setFormFreq('every_6h')
    else setFormFreq('daily')
    setShowForm(true)
  }

  const openEditForm = (source: CoverageSource) => {
    resetForm()
    setEditingId(source.id)
    setFormType(source.source_type)
    setFormName(source.name)
    setFormDesc(source.description || '')
    setFormFreq(source.scan_frequency)
    setFormActive(source.is_active)
    setFormOutletId(source.outlet_id || '')
    setFormGameId(source.game_id || '')
    // Flatten config to string values for form
    const cfg: Record<string, string> = {}
    for (const [k, v] of Object.entries(source.config || {})) {
      cfg[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '')
    }
    setFormConfig(cfg)
    setShowForm(true)
  }

  const buildConfig = (): Record<string, unknown> => {
    const cfg: Record<string, unknown> = {}
    switch (formType) {
      case 'rss':
        if (formConfig.url) cfg.url = formConfig.url.trim()
        break
      case 'tavily':
        if (formConfig.domain) cfg.domain = formConfig.domain.trim()
        if (formConfig.keywords) cfg.keywords = formConfig.keywords.split(',').map(k => k.trim()).filter(Boolean)
        break
      case 'youtube':
        if (formConfig.channel_id) cfg.channel_id = formConfig.channel_id.trim()
        if (formConfig.channel_name) cfg.channel_name = formConfig.channel_name.trim()
        if (formConfig.keywords) cfg.keywords = formConfig.keywords.split(',').map(k => k.trim()).filter(Boolean)
        break
      case 'twitch':
        if (formConfig.game_name) cfg.game_name = formConfig.game_name.trim()
        if (formConfig.twitch_game_id) cfg.twitch_game_id = formConfig.twitch_game_id.trim()
        break
      case 'reddit':
        if (formConfig.subreddits) cfg.subreddits = formConfig.subreddits.split(',').map((s: string) => s.trim().replace(/^\/?(r\/)?/, '')).filter(Boolean)
        if (formConfig.keywords) cfg.keywords = formConfig.keywords.split(',').map((k: string) => k.trim()).filter(Boolean)
        if (formConfig.min_upvotes) cfg.min_upvotes = parseInt(formConfig.min_upvotes) || 0
        break
      case 'twitter':
        if (formConfig.handles) cfg.handles = formConfig.handles.split(',').map((h: string) => h.trim().replace(/^@/, '')).filter(Boolean)
        if (formConfig.keywords) cfg.keywords = formConfig.keywords.split(',').map((k: string) => k.trim()).filter(Boolean)
        if (formConfig.min_followers) cfg.min_followers = parseInt(formConfig.min_followers) || 0
        break
      case 'tiktok':
        if (formConfig.profiles) cfg.profiles = formConfig.profiles.split(',').map((p: string) => p.trim().replace(/^@/, '')).filter(Boolean)
        if (formConfig.hashtags) cfg.hashtags = formConfig.hashtags.split(',').map((h: string) => h.trim().replace(/^#/, '')).filter(Boolean)
        if (formConfig.keywords) cfg.keywords = formConfig.keywords.split(',').map((k: string) => k.trim()).filter(Boolean)
        if (formConfig.min_followers) cfg.min_followers = parseInt(formConfig.min_followers) || 0
        break
      case 'instagram':
        if (formConfig.hashtags) cfg.hashtags = formConfig.hashtags.split(',').map((h: string) => h.trim().replace(/^#/, '')).filter(Boolean)
        if (formConfig.keywords) cfg.keywords = formConfig.keywords.split(',').map((k: string) => k.trim()).filter(Boolean)
        if (formConfig.min_followers) cfg.min_followers = parseInt(formConfig.min_followers) || 0
        break
      case 'sullygnome':
        if (formConfig.game_name) cfg.game_name = formConfig.game_name.trim()
        if (formConfig.sullygnome_slug) cfg.sullygnome_slug = formConfig.sullygnome_slug.trim()
        if (formConfig.default_time_range) cfg.default_time_range = formConfig.default_time_range
        cfg.min_avg_viewers = parseInt(formConfig.min_avg_viewers) || 10
        break
      case 'semrush':
        if (formConfig.domain) cfg.domain = formConfig.domain.trim()
        if (formConfig.actor_id) cfg.actor_id = formConfig.actor_id.trim()
        break
    }
    return cfg
  }

  const handleSave = async () => {
    if (!formName.trim()) {
      setSaveError('Name is required')
      return
    }
    setSaving(true)
    setSaveError(null)

    const payload: Record<string, unknown> = {
      source_type: formType,
      name: formName.trim(),
      description: formDesc.trim() || null,
      config: buildConfig(),
      outlet_id: formOutletId || null,
      game_id: formGameId || null,
      scan_frequency: formFreq,
      is_active: formActive
    }

    if (editingId) payload.id = editingId

    try {
      const res = await fetch('/api/coverage-sources', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const json = await res.json()
      if (!res.ok) {
        setSaveError(json.error || 'Failed to save')
      } else {
        setShowForm(false)
        fetchSources()
      }
    } catch {
      setSaveError('Network error')
    }
    setSaving(false)
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this source? This cannot be undone.')) return
    try {
      await fetch(`/api/coverage-sources?id=${id}`, { method: 'DELETE' })
      fetchSources()
    } catch (err) {
      console.error('Delete failed:', err)
    }
  }

  const handleToggleActive = async (source: CoverageSource) => {
    try {
      await fetch('/api/coverage-sources', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: source.id, is_active: !source.is_active })
      })
      fetchSources()
    } catch (err) {
      console.error('Toggle failed:', err)
    }
  }

  // ─── Bulk RSS import ──────────────────────────────────────────────────────

  const handleBulkImport = async () => {
    if (!bulkText.trim()) return
    setBulkImporting(true)
    setBulkResult(null)

    const lines = bulkText.trim().split('\n').filter(l => l.trim())
    const sources = lines.map(line => {
      const parts = line.split(',').map(p => p.trim())
      const url = parts[0]
      // Try to find matching outlet by domain
      let outletId = null
      try {
        const domain = new URL(url).hostname.replace('www.', '')
        const match = outlets.find(o => o.domain === domain || o.rss_feed_url === url)
        if (match) outletId = match.id
      } catch { /* ignore */ }

      return {
        source_type: 'rss',
        name: parts[1] || url,
        config: { url },
        outlet_id: outletId,
        scan_frequency: 'daily',
        is_active: true
      }
    }).filter(s => s.config.url)

    try {
      const res = await fetch('/api/coverage-sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sources)
      })
      const json = await res.json()
      if (res.ok) {
        setBulkResult(`Imported ${json.imported || sources.length} RSS feeds.`)
        setBulkText('')
        setShowBulk(false)
        fetchSources()
      } else {
        setBulkResult(`Error: ${json.error}`)
      }
    } catch {
      setBulkResult('Network error during import')
    }
    setBulkImporting(false)
  }

  // ─── RSS Scan ───────────────────────────────────────────────────────────

  const handleRunScan = async (sourceId?: string) => {
    setScanning(true)
    setScanResult(null)
    try {
      const res = await fetch('/api/rss-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sourceId ? { source_id: sourceId } : { scan_all: true })
      })
      const json = await res.json()
      if (res.ok) {
        const results = json.results || []
        const totalInserted = results.reduce((sum: number, r: { inserted: number }) => sum + r.inserted, 0)
        const totalMatched = results.reduce((sum: number, r: { matched: number }) => sum + r.matched, 0)
        setScanResult(`Scanned ${results.length} feeds: ${totalMatched} matched, ${totalInserted} new items added`)
        fetchSources()
      } else {
        setScanResult(`Error: ${json.error || 'Scan failed'}`)
      }
    } catch {
      setScanResult('Network error during scan')
    }
    setScanning(false)
  }

  const handleRunTavilyScan = async (sourceId?: string) => {
    setScanningTavily(true)
    setTavilyScanResult(null)
    try {
      const res = await fetch('/api/tavily-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sourceId ? { source_id: sourceId } : { scan_all: true })
      })
      const json = await res.json()
      if (res.ok) {
        const results = json.results || []
        const totalInserted = results.reduce((sum: number, r: { inserted: number }) => sum + r.inserted, 0)
        const totalCost = results.reduce((sum: number, r: { cost_estimate: number }) => sum + (r.cost_estimate || 0), 0)
        setTavilyScanResult(`Scanned ${results.length} sources: ${totalInserted} new items (~$${totalCost.toFixed(3)} cost)`)
        fetchSources()
      } else {
        setTavilyScanResult(`Error: ${json.error || 'Scan failed'}`)
      }
    } catch {
      setTavilyScanResult('Network error during scan')
    }
    setScanningTavily(false)
  }

  const handleRunSullyGnomeScan = async (sourceId?: string) => {
    setScanningSullyGnome(true)
    setSullyGnomeScanResult(null)
    try {
      const url = sourceId
        ? `/api/cron/sullygnome-scan?source_id=${sourceId}`
        : '/api/cron/sullygnome-scan'
      const res = await fetch(url, { method: 'POST' })
      const json = await res.json()
      if (res.ok) {
        const started = json.sources_started || 0
        setSullyGnomeScanResult(
          started > 0
            ? `✅ ${started} Apify run${started > 1 ? 's' : ''} started — results will appear in the feed within a few minutes`
            : json.message || 'No sources to scan'
        )
        fetchSources()
      } else {
        setSullyGnomeScanResult(`Error: ${json.error || 'Scan failed'}`)
      }
    } catch {
      setSullyGnomeScanResult('Network error during scan')
    }
    setScanningSullyGnome(false)
  }

  const handleSullyGnomeUpload = async (file: File, sourceId?: string) => {
    setSullyGnomeUploading(true)
    setSullyGnomeUploadResult(null)

    // Find the source to get config
    const source = sources.find(s => s.id === sourceId)
    if (!source?.game_id || !source?.config) {
      setSullyGnomeUploadResult('Error: Source must be linked to a game')
      setSullyGnomeUploading(false)
      return
    }

    // Look up client_id from game
    const game = games.find(g => g.id === source.game_id)
    if (!game?.client_id) {
      setSullyGnomeUploadResult('Error: Could not determine client from game')
      setSullyGnomeUploading(false)
      return
    }

    const formData = new FormData()
    formData.append('file', file)
    formData.append('game_id', source.game_id)
    formData.append('client_id', game.client_id)
    formData.append('game_slug', String(source.config.sullygnome_slug || ''))
    formData.append('time_range', String(source.config.default_time_range || '30d'))
    formData.append('min_avg_viewers', String(source.config.min_avg_viewers || '10'))
    if (sourceId) formData.append('source_id', sourceId)

    try {
      const res = await fetch('/api/sullygnome-import', { method: 'POST', body: formData })
      const json = await res.json()
      if (res.ok) {
        setSullyGnomeUploadResult(
          `Imported ${json.total_rows} rows: ${json.new_items} new, ${json.enriched} enriched, ${json.skipped} skipped`
        )
        fetchSources()
      } else {
        setSullyGnomeUploadResult(`Error: ${json.error || 'Import failed'}`)
      }
    } catch {
      setSullyGnomeUploadResult('Network error during import')
    }
    setSullyGnomeUploading(false)
    setShowSullyGnomeUpload(false)
  }

  // ─── Config form fields per source type ───────────────────────────────────

  const renderConfigFields = () => {
    const field = (key: string, label: string, placeholder: string, type: string = 'text') => (
      <div key={key}>
        <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>
          {label}
        </label>
        <input
          type={type}
          value={formConfig[key] || ''}
          onChange={e => setFormConfig(c => ({ ...c, [key]: e.target.value }))}
          placeholder={placeholder}
          style={{ width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box' }}
        />
      </div>
    )

    switch (formType) {
      case 'rss':
        return <>{field('url', 'Feed URL *', 'https://www.ign.com/rss/articles')}</>
      case 'tavily':
        return (
          <>
            {field('domain', 'Domain to Monitor', 'pcgamer.com')}
            {field('keywords', 'Keywords (comma-separated)', 'game name, studio name')}
          </>
        )
      case 'youtube':
        return (
          <>
            {field('channel_id', 'Channel ID', 'UCxxxxxxxx')}
            {field('channel_name', 'Channel Name', 'IGN')}
            {field('keywords', 'Search Keywords (comma-separated)', 'game name, trailer')}
          </>
        )
      case 'twitch':
        return (
          <>
            {field('game_name', 'Game Name', 'My Awesome Game')}
            {field('twitch_game_id', 'Twitch Game ID (optional)', '12345')}
          </>
        )
      case 'reddit':
        return (
          <>
            {field('subreddits', 'Subreddits (comma-separated)', 'gaming, pcgaming, indiegaming, NintendoSwitch')}
            {field('keywords', 'Keywords (comma-separated)', 'game name, studio')}
            {field('min_upvotes', 'Minimum Upvotes', '10', 'number')}
          </>
        )
      case 'twitter':
        return (
          <>
            {field('handles', 'Handles to Track (comma-separated)', '@IGN, @PCGamer, @GameSpot')}
            {field('keywords', 'Keywords (comma-separated)', 'game name, studio name')}
            {field('min_followers', 'Min Followers', '1000', 'number')}
          </>
        )
      case 'tiktok':
        return (
          <>
            {field('profiles', 'Profiles to Track (comma-separated)', '@IGN, @gamespot, @nintendo')}
            {field('hashtags', 'Hashtags (comma-separated)', 'indiegame, gaming, steamgame')}
            {field('keywords', 'Keywords (comma-separated)', 'game name, studio name')}
            {field('min_followers', 'Min Followers', '1000', 'number')}
          </>
        )
      case 'instagram':
        return (
          <>
            {field('hashtags', 'Hashtags (comma-separated)', 'indiegame, gaming, pcgaming')}
            {field('keywords', 'Keywords (comma-separated)', 'game name, studio name')}
            {field('min_followers', 'Min Followers', '1000', 'number')}
          </>
        )
      case 'sullygnome':
        return (
          <>
            {field('game_name', 'Game Name (on SullyGnome)', 'Stardew Valley')}
            {field('sullygnome_slug', 'SullyGnome URL Slug', 'Stardew_Valley')}
            <div>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>
                Time Range
              </label>
              <select
                value={formConfig.default_time_range || '30d'}
                onChange={(e) => setFormConfig({ ...formConfig, default_time_range: e.target.value })}
                style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '13px', backgroundColor: 'white' }}
              >
                <option value="3d">3 Days</option>
                <option value="7d">7 Days</option>
                <option value="14d">14 Days</option>
                <option value="30d">30 Days</option>
                <option value="90d">90 Days</option>
                <option value="180d">180 Days</option>
                <option value="365d">365 Days</option>
              </select>
            </div>
            {field('min_avg_viewers', 'Min Average Viewers', '10', 'number')}
          </>
        )
      case 'semrush':
        return (
          <>
            {field('domain', 'Domain to Analyze', 'ign.com')}
            {field('actor_id', 'Apify Actor ID', 'radeance/semrush-scraper')}
          </>
        )
      default:
        return null
    }
  }

  // ─── Source card renderer ─────────────────────────────────────────────────

  const renderSourceCard = (source: CoverageSource) => {
    const statusColor = STATUS_COLORS[source.last_run_status || 'never'] || STATUS_COLORS.never
    return (
      <div
        key={source.id}
        style={{
          backgroundColor: 'white',
          borderRadius: '10px',
          padding: '16px',
          boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
          border: source.is_active ? '1px solid #e2e8f0' : '1px solid #fecaca',
          opacity: source.is_active ? 1 : 0.7
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '18px' }}>{SOURCE_ICONS[source.source_type]}</span>
            <div>
              <div style={{ fontWeight: 600, fontSize: '14px', color: '#1e293b' }}>{source.name}</div>
              {source.description && (
                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>{source.description}</div>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <span style={{
              padding: '2px 8px',
              borderRadius: '9999px',
              fontSize: '11px',
              fontWeight: 500,
              backgroundColor: statusColor.bg,
              color: statusColor.text
            }}>
              {source.last_run_status || 'never'}
            </span>
            {canEdit && (
              <button
                onClick={() => handleToggleActive(source)}
                style={{
                  padding: '2px 8px',
                  borderRadius: '9999px',
                  fontSize: '11px',
                  fontWeight: 500,
                  border: 'none',
                  cursor: 'pointer',
                  backgroundColor: source.is_active ? '#dcfce7' : '#f3f4f6',
                  color: source.is_active ? '#166534' : '#6b7280'
                }}
              >
                {source.is_active ? 'Active' : 'Inactive'}
              </button>
            )}
          </div>
        </div>

        {/* Config summary */}
        <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '8px' }}>
          {source.source_type === 'rss' && source.config?.url ? (
            <span style={{ fontFamily: 'monospace', fontSize: '11px' }}>{String(source.config.url)}</span>
          ) : null}
          {source.source_type === 'tavily' && source.config?.domain ? (
            <span>Domain: <strong>{String(source.config.domain)}</strong></span>
          ) : null}
          {source.source_type === 'youtube' && source.config?.channel_name ? (
            <span>Channel: <strong>{String(source.config.channel_name)}</strong></span>
          ) : null}
          {source.source_type === 'twitch' && source.config?.game_name ? (
            <span>Game: <strong>{String(source.config.game_name)}</strong></span>
          ) : null}
          {source.source_type === 'sullygnome' && source.config?.sullygnome_slug ? (
            <span>
              Slug: <strong>{String(source.config.sullygnome_slug)}</strong>
              {source.config?.default_time_range ? ` · ${String(source.config.default_time_range)}` : ' · 30d'}
              {source.config?.min_avg_viewers ? ` · Min ${String(source.config.min_avg_viewers)} avg` : ''}
              <a
                href={`https://sullygnome.com/game/${String(source.config.sullygnome_slug)}/30/watched`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ marginLeft: '6px', fontSize: '11px', color: '#6366f1', textDecoration: 'none' }}
              >
                ↗ View on SullyGnome
              </a>
            </span>
          ) : null}
          {source.source_type === 'reddit' && (source.config?.subreddits || source.config?.subreddit) ? (
            <span>{Array.isArray(source.config.subreddits)
              ? (source.config.subreddits as string[]).map((s: string) => `r/${s}`).join(', ')
              : `r/${String(source.config.subreddit)}`
            }</span>
          ) : null}
          {source.source_type === 'twitter' && (source.config?.handles || source.config?.handle) ? (
            <span>{Array.isArray(source.config.handles)
              ? (source.config.handles as string[]).map((h: string) => `@${h}`).join(', ')
              : `@${String(source.config.handle)}`
            }</span>
          ) : null}
          {source.source_type === 'tiktok' && Array.isArray(source.config?.profiles) && (source.config.profiles as string[]).length > 0 ? (
            <span>{(source.config.profiles as string[]).map((p: string) => `@${p}`).join(', ')}</span>
          ) : null}
          {['tiktok', 'instagram'].includes(source.source_type) && Array.isArray(source.config?.hashtags) && (source.config.hashtags as string[]).length > 0 ? (
            <span>{source.source_type === 'tiktok' && Array.isArray(source.config?.profiles) && (source.config.profiles as string[]).length > 0 ? ' · ' : ''}#{(source.config.hashtags as string[]).join(', #')}</span>
          ) : null}
          {['twitter', 'tiktok', 'instagram'].includes(source.source_type) && Array.isArray(source.config?.keywords) ? (
            <span>{(source.source_type === 'twitter' && (source.config?.handles || source.config?.handle)) || (source.source_type === 'tiktok' && (Array.isArray(source.config?.profiles) || Array.isArray(source.config?.hashtags))) || (source.source_type === 'instagram' && Array.isArray(source.config?.hashtags)) ? ' · ' : ''}Keywords: {(source.config.keywords as string[]).join(', ')}</span>
          ) : null}
          {source.outlet ? (
            <span style={{ marginLeft: '8px' }}>
              → <strong>{source.outlet.name}</strong>
              {source.outlet.tier ? <span style={{ marginLeft: '4px', fontSize: '10px', color: '#94a3b8' }}>Tier {source.outlet.tier}</span> : null}
            </span>
          ) : null}
          {source.game ? (
            <span style={{ marginLeft: '8px' }}>
              🎮 {source.game.name}
            </span>
          ) : null}
        </div>

        {/* Stats row */}
        <div style={{ display: 'flex', gap: '16px', fontSize: '12px', color: '#94a3b8', borderTop: '1px solid #f1f5f9', paddingTop: '8px' }}>
          <span>Freq: <strong style={{ color: '#475569' }}>{source.scan_frequency}</strong></span>
          <span>Last run: <strong style={{ color: '#475569' }}>{timeAgo(source.last_run_at)}</strong></span>
          <span>Found: <strong style={{ color: '#475569' }}>{source.items_found_last_run}</strong> last / <strong style={{ color: '#475569' }}>{source.total_items_found}</strong> total</span>
          {source.consecutive_failures > 0 && (
            <span style={{ color: '#ef4444' }}>⚠ {source.consecutive_failures} failures</span>
          )}
        </div>

        {/* Actions */}
        {canEdit && (
          <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
            <button
              onClick={() => openEditForm(source)}
              style={{ padding: '4px 10px', backgroundColor: 'white', color: '#475569', border: '1px solid #e2e8f0', borderRadius: '4px', fontSize: '12px', cursor: 'pointer' }}
            >
              Edit
            </button>
            <button
              onClick={() => handleDelete(source.id)}
              style={{ padding: '4px 10px', backgroundColor: 'white', color: '#ef4444', border: '1px solid #fecaca', borderRadius: '4px', fontSize: '12px', cursor: 'pointer' }}
            >
              Delete
            </button>
          </div>
        )}
      </div>
    )
  }

  // ─── Tab content renderers ────────────────────────────────────────────────

  const renderRSSTab = () => {
    const rssSources = tabSources
    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div>
            <span style={{ fontSize: '14px', color: '#64748b' }}>
              {rssSources.filter(s => s.is_active).length} active feeds / {rssSources.length} total
            </span>
            <span style={{ fontSize: '12px', color: '#94a3b8', marginLeft: '12px' }}>
              100% free — no API cost
            </span>
          </div>
          {canEdit && (
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => handleRunScan()}
                disabled={scanning || rssSources.length === 0}
                style={{
                  padding: '8px 14px', backgroundColor: scanning ? '#f1f5f9' : '#059669',
                  color: scanning ? '#64748b' : 'white', border: 'none', borderRadius: '6px',
                  fontSize: '13px', cursor: scanning || rssSources.length === 0 ? 'not-allowed' : 'pointer',
                  fontWeight: 500, opacity: scanning || rssSources.length === 0 ? 0.7 : 1
                }}
              >
                {scanning ? 'Scanning...' : 'Run Scan Now'}
              </button>
              <button
                onClick={() => { setShowBulk(true); setBulkResult(null) }}
                style={{ padding: '8px 14px', backgroundColor: 'white', color: '#475569', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px', cursor: 'pointer' }}
              >
                Bulk Import
              </button>
              <button
                onClick={() => openAddForm('rss')}
                style={{ padding: '8px 14px', backgroundColor: '#2563eb', color: 'white', border: 'none', borderRadius: '6px', fontSize: '13px', cursor: 'pointer', fontWeight: 500 }}
              >
                + Add RSS Feed
              </button>
            </div>
          )}
        </div>
        {scanResult && (
          <div style={{
            padding: '10px 14px', marginBottom: '12px', borderRadius: '8px', fontSize: '13px',
            backgroundColor: scanResult.startsWith('Error') ? '#fee2e2' : '#dcfce7',
            color: scanResult.startsWith('Error') ? '#dc2626' : '#166534'
          }}>
            {scanResult}
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))', gap: '12px' }}>
          {rssSources.length === 0 ? (
            <div style={{ gridColumn: '1 / -1', padding: '40px', textAlign: 'center', color: '#94a3b8', backgroundColor: 'white', borderRadius: '10px' }}>
              No RSS feeds configured yet. Add feeds from your outlets to start monitoring.
            </div>
          ) : (
            rssSources.map(renderSourceCard)
          )}
        </div>
      </div>
    )
  }

  const renderWebTab = () => {
    const webSources = tabSources
    const tavilyStatus = apiKeyStatus.tavily
    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontSize: '14px', color: '#64748b' }}>
              {webSources.filter(s => s.is_active).length} active monitors / {webSources.length} total
            </span>
            {tavilyStatus && (
              <span style={{
                padding: '4px 10px', borderRadius: '6px', fontSize: '12px',
                backgroundColor: tavilyStatus.configured ? '#dcfce7' : '#fee2e2',
                color: tavilyStatus.configured ? '#166534' : '#dc2626'
              }}>
                Tavily: {tavilyStatus.configured ? 'Configured' : 'Not configured'}
              </span>
            )}
            <span style={{ fontSize: '12px', color: '#94a3b8' }}>
              ~$0.01-0.02 per search
            </span>
          </div>
          {canEdit && (
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => handleRunTavilyScan()}
                disabled={scanningTavily || webSources.length === 0}
                style={{
                  padding: '8px 14px', backgroundColor: scanningTavily ? '#f1f5f9' : '#059669',
                  color: scanningTavily ? '#64748b' : 'white', border: 'none', borderRadius: '6px',
                  fontSize: '13px', cursor: scanningTavily || webSources.length === 0 ? 'not-allowed' : 'pointer',
                  fontWeight: 500, opacity: scanningTavily || webSources.length === 0 ? 0.7 : 1
                }}
              >
                {scanningTavily ? 'Scanning...' : 'Run Scan Now'}
              </button>
              <button
                onClick={() => openAddForm('tavily')}
                style={{ padding: '8px 14px', backgroundColor: '#2563eb', color: 'white', border: 'none', borderRadius: '6px', fontSize: '13px', cursor: 'pointer', fontWeight: 500 }}
              >
                + Add Domain Monitor
              </button>
            </div>
          )}
        </div>
        {tavilyScanResult && (
          <div style={{
            padding: '10px 14px', marginTop: '12px', marginBottom: '12px', borderRadius: '8px', fontSize: '13px',
            backgroundColor: tavilyScanResult.startsWith('Error') ? '#fee2e2' : '#dcfce7',
            color: tavilyScanResult.startsWith('Error') ? '#dc2626' : '#166534'
          }}>
            {tavilyScanResult}
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))', gap: '12px' }}>
          {webSources.length === 0 ? (
            <div style={{ gridColumn: '1 / -1', padding: '40px', textAlign: 'center', color: '#94a3b8', backgroundColor: 'white', borderRadius: '10px' }}>
              No web monitors configured yet. Add domains to monitor for coverage mentions.
            </div>
          ) : (
            webSources.map(renderSourceCard)
          )}
        </div>
      </div>
    )
  }

  const renderApifyTab = () => {
    const ytSources = sources.filter(s => s.source_type === 'youtube')
    const tcSources = sources.filter(s => s.source_type === 'twitch')
    const rdSources = sources.filter(s => s.source_type === 'reddit')
    const twSources = sources.filter(s => s.source_type === 'twitter')
    const tkSources = sources.filter(s => s.source_type === 'tiktok')
    const igSources = sources.filter(s => s.source_type === 'instagram')
    const sgSources = sources.filter(s => s.source_type === 'sullygnome')
    const smSources = sources.filter(s => s.source_type === 'semrush')

    const apifyCredits = apiKeyStatus.apify?.credits
    const hasApifyKey = apiKeyStatus.apify?.configured

    const renderSection = (type: SourceType, label: string, description: string, items: CoverageSource[]) => {
      const stats = platformStats[type]
      const isGlobalKeywordPlatform = ['youtube', 'twitch', 'reddit', 'twitter', 'tiktok', 'instagram'].includes(type)
      return (
        <div style={{ marginBottom: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <div>
              <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#1e293b', margin: 0 }}>
                {SOURCE_ICONS[type]} {label}
              </h3>
              <p style={{ fontSize: '12px', color: '#94a3b8', margin: '2px 0 0 0' }}>{description}</p>
            </div>
            {canEdit && (
              <button
                onClick={() => openAddForm(type)}
                style={{ padding: '6px 12px', backgroundColor: '#2563eb', color: 'white', border: 'none', borderRadius: '6px', fontSize: '12px', cursor: 'pointer', fontWeight: 500 }}
              >
                + Add
              </button>
            )}
          </div>
          {isGlobalKeywordPlatform && stats && stats.total > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '10px',
              padding: '10px 14px', marginBottom: '8px', borderRadius: '8px',
              backgroundColor: '#f0fdf4', border: '1px solid #86efac', fontSize: '13px'
            }}>
              <span style={{ color: '#16a34a', fontWeight: 600 }}>● Active</span>
              <span style={{ color: '#15803d' }}>
                Scanning via global keywords — <strong>{stats.total.toLocaleString()} items</strong> collected
                {stats.lastSeen && <span style={{ color: '#86efac', marginLeft: '6px' }}>· last {timeAgo(stats.lastSeen)}</span>}
              </span>
            </div>
          )}
          {items.length === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', color: '#94a3b8', backgroundColor: 'white', borderRadius: '10px', fontSize: '13px' }}>
              {isGlobalKeywordPlatform && stats && stats.total > 0
                ? `No targeted ${label.toLowerCase()} sources — running on global keyword scan`
                : `No ${label.toLowerCase()} sources configured`}
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))', gap: '10px' }}>
              {items.map(renderSourceCard)}
            </div>
          )}
        </div>
      )
    }

    return (
      <div>
        {/* Apify credit banner */}
        <div style={{
          padding: '14px 18px', borderRadius: '10px', marginBottom: '16px',
          backgroundColor: !hasApifyKey ? '#fee2e2' : (apifyCredits !== undefined && apifyCredits < 1) ? '#fef9c3' : '#dbeafe',
          border: `1px solid ${!hasApifyKey ? '#fecaca' : (apifyCredits !== undefined && apifyCredits < 1) ? '#fde047' : '#93c5fd'}`
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <span style={{ fontWeight: 600, fontSize: '14px', color: '#1e293b' }}>
                Apify Platform
              </span>
              <span style={{ fontSize: '13px', color: '#64748b', marginLeft: '8px' }}>
                {hasApifyKey ? 'Connected' : 'Not configured'}
                {apifyCredits !== undefined && ` — $${apifyCredits.toFixed(2)} credits remaining`}
              </span>
            </div>
            {!hasApifyKey && (
              <Link href="/settings/system-keys" style={{ fontSize: '13px', color: '#2563eb', textDecoration: 'none', fontWeight: 500 }}>
                Configure API Key →
              </Link>
            )}
            {hasApifyKey && apifyCredits !== undefined && apifyCredits < 1 && (
              <span style={{ fontSize: '12px', color: '#dc2626', fontWeight: 500 }}>
                ⚠ Low credits — purchase more at apify.com
              </span>
            )}
          </div>
        </div>

        {renderSection('youtube', 'YouTube', 'Video search by keywords via Apify YouTube scraper', ytSources)}
        {renderSection('reddit', 'Reddit', 'Subreddit keyword search via Apify Reddit scraper', rdSources)}
        {renderSection('twitter', 'Twitter/X', 'Keyword/hashtag monitoring via Apify actors', twSources)}
        {renderSection('tiktok', 'TikTok', 'Hashtag & keyword monitoring — min 1,000 followers default', tkSources)}
        {renderSection('instagram', 'Instagram', 'Hashtag & keyword monitoring — min 1,000 followers default', igSources)}
        {/* SullyGnome — custom section with scan + upload */}
        <div style={{ marginBottom: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <div>
              <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#1e293b', margin: 0 }}>
                📊 SullyGnome (Twitch Enrichment)
              </h3>
              <p style={{ fontSize: '12px', color: '#94a3b8', margin: '2px 0 0 0' }}>
                Historical Twitch data — avg viewers, peak viewers, hours watched per streamer
              </p>
            </div>
            {canEdit && (
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  onClick={() => handleRunSullyGnomeScan()}
                  disabled={scanningSullyGnome || sgSources.length === 0}
                  style={{
                    padding: '6px 12px', backgroundColor: scanningSullyGnome ? '#f1f5f9' : '#7c3aed',
                    color: scanningSullyGnome ? '#64748b' : 'white', border: 'none', borderRadius: '6px',
                    fontSize: '12px', cursor: scanningSullyGnome || sgSources.length === 0 ? 'not-allowed' : 'pointer',
                    fontWeight: 500, opacity: scanningSullyGnome || sgSources.length === 0 ? 0.7 : 1
                  }}
                >
                  {scanningSullyGnome ? 'Scanning...' : '🔍 Scan Now'}
                </button>
                <button
                  onClick={() => { setShowSullyGnomeUpload(true); setSullyGnomeUploadResult(null) }}
                  disabled={sgSources.length === 0}
                  style={{
                    padding: '6px 12px', backgroundColor: 'white', color: '#475569',
                    border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '12px',
                    cursor: sgSources.length === 0 ? 'not-allowed' : 'pointer',
                    opacity: sgSources.length === 0 ? 0.7 : 1
                  }}
                >
                  📤 Upload CSV
                </button>
                <button
                  onClick={() => openAddForm('sullygnome')}
                  style={{ padding: '6px 12px', backgroundColor: '#2563eb', color: 'white', border: 'none', borderRadius: '6px', fontSize: '12px', cursor: 'pointer', fontWeight: 500 }}
                >
                  + Add
                </button>
              </div>
            )}
          </div>

          {/* Scan result */}
          {sullyGnomeScanResult && (
            <div style={{
              padding: '8px 12px', borderRadius: '6px', fontSize: '12px', marginBottom: '10px',
              backgroundColor: sullyGnomeScanResult.startsWith('Error') ? '#fee2e2' : '#f0fdf4',
              color: sullyGnomeScanResult.startsWith('Error') ? '#991b1b' : '#166534'
            }}>
              {sullyGnomeScanResult}
            </div>
          )}

          {/* Upload result */}
          {sullyGnomeUploadResult && (
            <div style={{
              padding: '8px 12px', borderRadius: '6px', fontSize: '12px', marginBottom: '10px',
              backgroundColor: sullyGnomeUploadResult.startsWith('Error') ? '#fee2e2' : '#f0fdf4',
              color: sullyGnomeUploadResult.startsWith('Error') ? '#991b1b' : '#166534'
            }}>
              {sullyGnomeUploadResult}
            </div>
          )}

          {/* Upload modal */}
          {showSullyGnomeUpload && (
            <div style={{
              padding: '16px', borderRadius: '10px', marginBottom: '10px',
              backgroundColor: '#faf5ff', border: '1px solid #e9d5ff'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                <strong style={{ fontSize: '14px', color: '#5b21b6' }}>Upload SullyGnome CSV</strong>
                <button onClick={() => setShowSullyGnomeUpload(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px' }}>×</button>
              </div>
              <p style={{ fontSize: '12px', color: '#6b7280', margin: '0 0 10px 0' }}>
                Download the CSV from SullyGnome (game page → Most Watched → Export), then upload it here.
                The CSV will be processed using the linked source&apos;s config (slug, time range, min viewers).
              </p>
              {sgSources.map(s => (
                <div key={s.id} style={{
                  display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px',
                  backgroundColor: 'white', borderRadius: '6px', border: '1px solid #e2e8f0', marginBottom: '6px'
                }}>
                  <span style={{ fontSize: '13px', fontWeight: 500, flex: 1 }}>
                    {s.name}
                    {s.config?.sullygnome_slug ? ` (${String(s.config.sullygnome_slug)})` : ''}
                  </span>
                  <label style={{
                    padding: '4px 12px', backgroundColor: sullyGnomeUploading ? '#f1f5f9' : '#7c3aed',
                    color: sullyGnomeUploading ? '#64748b' : 'white', borderRadius: '4px',
                    fontSize: '12px', cursor: sullyGnomeUploading ? 'not-allowed' : 'pointer', fontWeight: 500
                  }}>
                    {sullyGnomeUploading ? 'Importing...' : 'Choose CSV'}
                    <input
                      type="file"
                      accept=".csv"
                      style={{ display: 'none' }}
                      disabled={sullyGnomeUploading}
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) handleSullyGnomeUpload(file, s.id)
                        e.target.value = ''
                      }}
                    />
                  </label>
                </div>
              ))}
            </div>
          )}

          {sgSources.length === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', color: '#94a3b8', backgroundColor: 'white', borderRadius: '10px', fontSize: '13px' }}>
              No SullyGnome sources configured
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))', gap: '10px' }}>
              {sgSources.map(renderSourceCard)}
            </div>
          )}
        </div>

        {renderSection('semrush', 'SEMRush', 'Domain SEO/traffic analysis — supplements outlet traffic data', smSources)}
      </div>
    )
  }

  // ─── Loading / Auth ───────────────────────────────────────────────────────

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

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
      <Sidebar />

      <div style={{ flex: 1, padding: '32px', overflow: 'auto' }}>
        <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
          {/* Header */}
          <div style={{ marginBottom: '16px' }}>
            <h1 style={{ fontSize: '28px', fontWeight: 700, color: '#1e293b', margin: 0 }}>Source Management</h1>
            <p style={{ fontSize: '14px', color: '#64748b', margin: '4px 0 0 0' }}>
              Configure data sources feeding into the PR coverage system
            </p>
          </div>

          <CoverageNav />

          {/* Source Type Stats */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginBottom: '24px' }}>
            {TAB_KEYS.map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  backgroundColor: activeTab === tab ? '#2563eb' : 'white',
                  color: activeTab === tab ? 'white' : '#1e293b',
                  borderRadius: '10px',
                  padding: '16px',
                  border: activeTab === tab ? '1px solid #2563eb' : '1px solid #e2e8f0',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                  cursor: 'pointer',
                  textAlign: 'left'
                }}
              >
                <div style={{ fontSize: '20px', fontWeight: 700 }}>
                  {activeCount(TAB_SOURCE_TYPES[tab])}
                  <span style={{ fontSize: '14px', fontWeight: 400, opacity: 0.7 }}> / {totalCount(TAB_SOURCE_TYPES[tab])}</span>
                </div>
                <div style={{ fontSize: '13px', marginTop: '2px', opacity: 0.8 }}>{TAB_LABELS[tab]}</div>
              </button>
            ))}
          </div>

          {/* Tab content */}
          {activeTab === 'rss' && renderRSSTab()}
          {activeTab === 'web' && renderWebTab()}
          {activeTab === 'apify' && renderApifyTab()}
        </div>
      </div>

      {/* Add/Edit Source Modal */}
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
                {editingId ? 'Edit' : 'Add'} {SOURCE_LABELS[formType]}
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

            <div style={{ display: 'grid', gap: '16px' }}>
              {/* Name */}
              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>
                  Name *
                </label>
                <input
                  type="text"
                  value={formName}
                  onChange={e => setFormName(e.target.value)}
                  placeholder={formType === 'rss' ? 'e.g. IGN RSS Feed' : 'e.g. Monitor PCGamer'}
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box' }}
                />
              </div>

              {/* Description */}
              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>
                  Description
                </label>
                <input
                  type="text"
                  value={formDesc}
                  onChange={e => setFormDesc(e.target.value)}
                  placeholder="Optional description"
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box' }}
                />
              </div>

              {/* Source-type-specific config fields */}
              {renderConfigFields()}

              {/* Linked Outlet (RSS/Tavily) */}
              {['rss', 'tavily', 'semrush'].includes(formType) && (
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>
                    Linked Outlet
                  </label>
                  <select
                    value={formOutletId}
                    onChange={e => setFormOutletId(e.target.value)}
                    style={{ width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', backgroundColor: 'white', boxSizing: 'border-box' }}
                  >
                    <option value="">None</option>
                    {outlets.map(o => (
                      <option key={o.id} value={o.id}>{o.name}{o.domain ? ` (${o.domain})` : ''}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Linked Game (for game-specific sources) */}
              {['tavily', 'youtube', 'twitch', 'reddit', 'twitter', 'tiktok', 'instagram', 'sullygnome'].includes(formType) && (
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>
                    Linked Game
                  </label>
                  <select
                    value={formGameId}
                    onChange={e => setFormGameId(e.target.value)}
                    style={{ width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', backgroundColor: 'white', boxSizing: 'border-box' }}
                  >
                    <option value="">All Games</option>
                    {games.map(g => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Scan Frequency */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>
                    Scan Frequency
                  </label>
                  <select
                    value={formFreq}
                    onChange={e => setFormFreq(e.target.value as ScanFrequency)}
                    style={{ width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', backgroundColor: 'white', boxSizing: 'border-box' }}
                  >
                    {FREQ_OPTIONS.map(f => (
                      <option key={f.value} value={f.value}>{f.label}</option>
                    ))}
                  </select>
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: '4px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={formActive}
                      onChange={e => setFormActive(e.target.checked)}
                      style={{ width: '18px', height: '18px' }}
                    />
                    <span style={{ fontSize: '14px', color: '#374151' }}>Active</span>
                  </label>
                </div>
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
                {saving ? 'Saving...' : editingId ? 'Save Changes' : 'Add Source'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk RSS Import Modal */}
      {showBulk && (
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
              <h2 style={{ fontSize: '20px', fontWeight: 700, color: '#1e293b', margin: 0 }}>Bulk Import RSS Feeds</h2>
              <button
                onClick={() => setShowBulk(false)}
                style={{ background: 'none', border: 'none', fontSize: '24px', color: '#94a3b8', cursor: 'pointer' }}
              >
                ×
              </button>
            </div>

            <p style={{ fontSize: '13px', color: '#64748b', marginBottom: '12px' }}>
              Paste one feed URL per line. Optionally add a name after a comma.
            </p>
            <p style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '16px' }}>
              Feeds will auto-link to matching outlets by domain.
            </p>

            <textarea
              value={bulkText}
              onChange={e => setBulkText(e.target.value)}
              placeholder={`https://www.ign.com/rss/articles, IGN Articles\nhttps://www.pcgamer.com/rss/, PC Gamer\nhttps://feeds.feedburner.com/RockPaperShotgun`}
              style={{
                width: '100%', height: '200px', padding: '12px', border: '1px solid #e2e8f0',
                borderRadius: '8px', fontSize: '13px', fontFamily: 'monospace',
                resize: 'vertical', boxSizing: 'border-box'
              }}
            />

            {bulkResult && (
              <div style={{
                padding: '10px 14px', marginTop: '12px',
                backgroundColor: bulkResult.startsWith('Error') ? '#fee2e2' : '#dcfce7',
                color: bulkResult.startsWith('Error') ? '#dc2626' : '#166534',
                borderRadius: '6px', fontSize: '13px'
              }}>
                {bulkResult}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
              <button
                onClick={() => setShowBulk(false)}
                style={{ padding: '8px 20px', backgroundColor: 'white', color: '#475569', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={handleBulkImport}
                disabled={bulkImporting || !bulkText.trim()}
                style={{
                  padding: '8px 24px', backgroundColor: '#2563eb', color: 'white', border: 'none',
                  borderRadius: '6px', fontSize: '14px', fontWeight: 500,
                  cursor: bulkImporting || !bulkText.trim() ? 'not-allowed' : 'pointer',
                  opacity: bulkImporting || !bulkText.trim() ? 0.7 : 1
                }}
              >
                {bulkImporting ? 'Importing...' : 'Import'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
