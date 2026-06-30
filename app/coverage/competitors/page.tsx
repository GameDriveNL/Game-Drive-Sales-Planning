'use client'

import { useState, useEffect, useCallback } from 'react'
import { Sidebar } from '../../components/Sidebar'
import { useAuth } from '@/lib/auth-context'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import { CoverageNav } from '../components/CoverageNav'

// ─── Types ───────────────────────────────────────────────────────────────────

interface Client { id: string; name: string }
interface Game { id: string; name: string; client_id: string }

interface CompetitorGame {
  id: string
  client_id: string
  own_game_id: string | null
  name: string
  studio: string | null
  platforms: string[] | null
  steam_url: string | null
  notes: string | null
  enabled: boolean
  created_at: string
  own_game?: { id: string; name: string } | null
}

interface CompetitorCoverage {
  id: string
  competitor_game_id: string
  title: string | null
  url: string
  source_domain: string | null
  snippet: string | null
  publish_date: string | null
  sentiment: 'positive' | 'negative' | 'neutral' | 'mixed' | null
  estimated_reach: number | null
  relevance_score: number | null
  created_at: string
}

interface CompetitorStats {
  total: number
  positive: number
  negative: number
  neutral: number
  mixed: number
  eWOM: number
  avgScore: number
  recentCount: number // last 30d
}

// ─── eWOM formula ────────────────────────────────────────────────────────────
// eWOM = (positive×1 + mixed×0.3 + neutral×0.5 - negative×1) / total × 100 + 50
// Clamps to [0, 100]. Own game normalized to 100 as baseline index.

function calcEWOM(stats: Pick<CompetitorStats, 'total' | 'positive' | 'negative' | 'neutral' | 'mixed'>): number {
  if (stats.total === 0) return 50
  const raw = (stats.positive * 1 + stats.mixed * 0.3 + stats.neutral * 0.5 - stats.negative * 1) / stats.total
  return Math.round(Math.max(0, Math.min(100, raw * 50 + 50)))
}

function getStats(items: CompetitorCoverage[]): CompetitorStats {
  const counts = { positive: 0, negative: 0, neutral: 0, mixed: 0 }
  for (const item of items) {
    const s = item.sentiment || 'neutral'
    if (s in counts) counts[s as keyof typeof counts]++
  }
  const total = items.length
  const avgScore = total > 0
    ? items.reduce((s, i) => s + (i.relevance_score || 0), 0) / total
    : 0
  const recentCutoff = new Date()
  recentCutoff.setDate(recentCutoff.getDate() - 30)
  const recentCount = items.filter(i => i.publish_date && new Date(i.publish_date) >= recentCutoff).length
  return {
    total,
    ...counts,
    eWOM: calcEWOM({ total, ...counts }),
    avgScore: Math.round(avgScore * 100) / 100,
    recentCount,
  }
}

const SENTIMENT_COLORS: Record<string, string> = {
  positive: '#059669',
  neutral: '#94a3b8',
  mixed: '#d97706',
  negative: '#dc2626',
}

const EWOM_COLOR = (score: number) =>
  score >= 65 ? '#059669' : score >= 45 ? '#d97706' : '#dc2626'

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

// ─── Component ───────────────────────────────────────────────────────────────

export default function CompetitorsPage() {
  const { hasAccess, loading: authLoading } = useAuth()
  const canView = hasAccess('pr_coverage', 'view')
  const canEdit = hasAccess('pr_coverage', 'edit')
  const supabase = createClientComponentClient()

  const [clients, setClients] = useState<Client[]>([])
  const [games, setGames] = useState<Game[]>([])
  const [selectedClientId, setSelectedClientId] = useState('')
  const [competitors, setCompetitors] = useState<CompetitorGame[]>([])
  const [coverageMap, setCoverageMap] = useState<Record<string, CompetitorCoverage[]>>({})
  const [isLoading, setIsLoading] = useState(false)

  // Form
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [fName, setFName] = useState('')
  const [fStudio, setFStudio] = useState('')
  const [fOwnGameId, setFOwnGameId] = useState('')
  const [fSteamUrl, setFSteamUrl] = useState('')
  const [fNotes, setFNotes] = useState('')
  const [fEnabled, setFEnabled] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Scan
  const [scanningId, setScanningId] = useState<string | null>(null)
  const [scanResults, setScanResults] = useState<Record<string, string>>({})
  const [daysBack, setDaysBack] = useState(90)

  // Expanded detail view
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // ─── Data loading ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!canView) return
    supabase.from('clients').select('id, name').order('name').then(({ data }) => {
      if (data) setClients(data)
    })
    supabase.from('games').select('id, name, client_id').order('name').then(({ data }) => {
      if (data) setGames(data)
    })
  }, [canView, supabase])

  const fetchCompetitors = useCallback(async (clientId: string) => {
    if (!clientId) return
    setIsLoading(true)
    try {
      const res = await fetch(`/api/competitor-games?client_id=${clientId}`)
      if (res.ok) {
        const data: CompetitorGame[] = await res.json()
        setCompetitors(data)
        // Load coverage for each competitor
        const coverageEntries = await Promise.all(
          data.map(async c => {
            const { data: cov } = await supabase
              .from('competitor_coverage')
              .select('*')
              .eq('competitor_game_id', c.id)
              .order('publish_date', { ascending: false })
              .limit(200)
            return [c.id, cov || []] as [string, CompetitorCoverage[]]
          })
        )
        setCoverageMap(Object.fromEntries(coverageEntries))
      }
    } catch (err) {
      console.error('Failed to fetch competitors:', err)
    }
    setIsLoading(false)
  }, [supabase])

  useEffect(() => {
    if (selectedClientId) fetchCompetitors(selectedClientId)
    else { setCompetitors([]); setCoverageMap({}) }
  }, [selectedClientId, fetchCompetitors])

  // ─── Form ─────────────────────────────────────────────────────────────────

  const resetForm = () => {
    setEditId(null)
    setFName('')
    setFStudio('')
    setFOwnGameId('')
    setFSteamUrl('')
    setFNotes('')
    setFEnabled(true)
    setSaveError(null)
  }

  const openEdit = (c: CompetitorGame) => {
    resetForm()
    setEditId(c.id)
    setFName(c.name)
    setFStudio(c.studio || '')
    setFOwnGameId(c.own_game_id || '')
    setFSteamUrl(c.steam_url || '')
    setFNotes(c.notes || '')
    setFEnabled(c.enabled)
    setShowForm(true)
  }

  const handleSave = async () => {
    if (!fName.trim() || !selectedClientId) { setSaveError('Game name is required'); return }
    setSaving(true)
    setSaveError(null)
    const payload = {
      client_id: selectedClientId,
      own_game_id: fOwnGameId || null,
      name: fName.trim(),
      studio: fStudio.trim() || null,
      steam_url: fSteamUrl.trim() || null,
      notes: fNotes.trim() || null,
      enabled: fEnabled,
      ...(editId ? { id: editId } : {}),
    }
    try {
      const res = await fetch('/api/competitor-games', {
        method: editId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      if (!res.ok) setSaveError(json.error || 'Failed to save')
      else { setShowForm(false); resetForm(); fetchCompetitors(selectedClientId) }
    } catch { setSaveError('Network error') }
    setSaving(false)
  }

  const handleDelete = async (id: string) => {
    await fetch(`/api/competitor-games?id=${id}`, { method: 'DELETE' })
    fetchCompetitors(selectedClientId)
  }

  // ─── Scan ─────────────────────────────────────────────────────────────────

  const handleScan = async (competitorId: string, name: string) => {
    setScanningId(competitorId)
    setScanResults(r => ({ ...r, [competitorId]: '' }))
    try {
      const res = await fetch('/api/competitor-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ competitor_game_id: competitorId, days_back: daysBack }),
      })
      const json = await res.json()
      if (res.ok) {
        setScanResults(r => ({ ...r, [competitorId]: `+${json.inserted} new (${json.results_found} found, ~$${json.cost_estimate_usd?.toFixed(3)})` }))
        fetchCompetitors(selectedClientId)
      } else {
        setScanResults(r => ({ ...r, [competitorId]: `Error: ${json.error}` }))
      }
    } catch {
      setScanResults(r => ({ ...r, [competitorId]: 'Network error' }))
    }
    setScanningId(null)
  }

  const handleScanAll = async () => {
    for (const c of competitors.filter(c => c.enabled)) {
      await handleScan(c.id, c.name)
    }
  }

  // ─── Auth guard ───────────────────────────────────────────────────────────

  if (authLoading) {
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

  // ─── Stats for own game (coverage_items) ──────────────────────────────────
  // We pick one own game from competitors[0].own_game_id for context
  // This is a simple eWOM comparison — full own-game stats from /reception

  const clientGames = games.filter(g => g.client_id === selectedClientId)

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
      <Sidebar />

      <div style={{ flex: 1, padding: '32px', overflow: 'auto' }}>
        <div style={{ maxWidth: '1200px', margin: '0 auto' }}>

          {/* Header */}
          <div style={{ marginBottom: '16px' }}>
            <h1 style={{ fontSize: '28px', fontWeight: 700, color: '#1e293b', margin: 0 }}>Competitor Tracking</h1>
            <p style={{ fontSize: '14px', color: '#64748b', margin: '4px 0 0 0' }}>
              Monitor competitor games&apos; media coverage and eWOM compared to your own titles
            </p>
          </div>

          <CoverageNav />

          {/* Client selector + actions */}
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap' }}>
            <select
              value={selectedClientId}
              onChange={e => setSelectedClientId(e.target.value)}
              style={{ padding: '9px 12px', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '14px', backgroundColor: 'white', minWidth: '200px' }}
            >
              <option value="">Select client...</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>

            {selectedClientId && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <label style={{ fontSize: '13px', color: '#64748b' }}>Look back:</label>
                  <select
                    value={daysBack}
                    onChange={e => setDaysBack(Number(e.target.value))}
                    style={{ padding: '7px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px', backgroundColor: 'white' }}
                  >
                    <option value={30}>30 days</option>
                    <option value={60}>60 days</option>
                    <option value={90}>90 days</option>
                    <option value={180}>180 days</option>
                    <option value={365}>1 year</option>
                  </select>
                </div>
                {canEdit && (
                  <>
                    <button
                      onClick={handleScanAll}
                      disabled={scanningId !== null || competitors.filter(c => c.enabled).length === 0}
                      style={{
                        padding: '8px 14px', backgroundColor: scanningId !== null ? '#f1f5f9' : '#059669',
                        color: scanningId !== null ? '#64748b' : 'white', border: 'none', borderRadius: '6px',
                        fontSize: '13px', cursor: scanningId !== null ? 'not-allowed' : 'pointer', fontWeight: 500,
                        opacity: scanningId !== null ? 0.7 : 1,
                      }}
                    >
                      {scanningId !== null ? 'Scanning...' : `Scan All (${competitors.filter(c => c.enabled).length})`}
                    </button>
                    <button
                      onClick={() => { resetForm(); setShowForm(true) }}
                      style={{ padding: '8px 14px', backgroundColor: '#b8232f', color: 'white', border: 'none', borderRadius: '6px', fontSize: '13px', cursor: 'pointer', fontWeight: 500 }}
                    >
                      + Add Competitor
                    </button>
                  </>
                )}
              </>
            )}
          </div>

          {/* Add/Edit form */}
          {showForm && (
            <div style={{
              padding: '20px', borderRadius: '10px', marginBottom: '20px',
              backgroundColor: '#f8fafc', border: '1px solid #e2e8f0',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                <strong style={{ fontSize: '15px', color: '#1e293b' }}>{editId ? 'Edit Competitor' : 'Add Competitor'}</strong>
                <button onClick={() => { setShowForm(false); resetForm() }} style={{ background: 'none', border: 'none', fontSize: '20px', color: '#94a3b8', cursor: 'pointer' }}>×</button>
              </div>
              {saveError && (
                <div style={{ padding: '8px 12px', backgroundColor: '#fee2e2', color: '#dc2626', borderRadius: '6px', fontSize: '13px', marginBottom: '12px' }}>
                  {saveError}
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: '#374151', marginBottom: '3px' }}>Game Name *</label>
                  <input type="text" value={fName} onChange={e => setFName(e.target.value)} placeholder="e.g. Manor Lords" style={{ width: '100%', padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px', boxSizing: 'border-box' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: '#374151', marginBottom: '3px' }}>Developer / Studio</label>
                  <input type="text" value={fStudio} onChange={e => setFStudio(e.target.value)} placeholder="e.g. Slavic Magic" style={{ width: '100%', padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px', boxSizing: 'border-box' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: '#374151', marginBottom: '3px' }}>Compare with own game</label>
                  <select value={fOwnGameId} onChange={e => setFOwnGameId(e.target.value)} style={{ width: '100%', padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px', backgroundColor: 'white', boxSizing: 'border-box' }}>
                    <option value="">None</option>
                    {clientGames.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: '#374151', marginBottom: '3px' }}>Steam URL (optional)</label>
                  <input type="url" value={fSteamUrl} onChange={e => setFSteamUrl(e.target.value)} placeholder="https://store.steampowered.com/app/..." style={{ width: '100%', padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px', boxSizing: 'border-box' }} />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: '#374151', marginBottom: '3px' }}>Notes</label>
                  <input type="text" value={fNotes} onChange={e => setFNotes(e.target.value)} placeholder="Why track this competitor?" style={{ width: '100%', padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px', boxSizing: 'border-box' }} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <input type="checkbox" checked={fEnabled} onChange={e => setFEnabled(e.target.checked)} style={{ width: '16px', height: '16px' }} />
                  <span style={{ fontSize: '13px', color: '#374151' }}>Active</span>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
                <button onClick={() => { setShowForm(false); resetForm() }} style={{ padding: '7px 16px', backgroundColor: 'white', color: '#475569', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px', cursor: 'pointer' }}>Cancel</button>
                <button onClick={handleSave} disabled={saving} style={{ padding: '7px 20px', backgroundColor: '#b8232f', color: 'white', border: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: 500, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
                  {saving ? 'Saving...' : editId ? 'Save' : 'Add'}
                </button>
              </div>
            </div>
          )}

          {/* Empty state */}
          {!selectedClientId && (
            <div style={{ padding: '60px', textAlign: 'center', color: '#94a3b8', backgroundColor: 'white', borderRadius: '12px', border: '1px solid #e2e8f0' }}>
              <div style={{ fontSize: '40px', marginBottom: '12px' }}>🎯</div>
              <div style={{ fontSize: '16px', fontWeight: 600, marginBottom: '6px', color: '#64748b' }}>Select a client to view competitor tracking</div>
              <div style={{ fontSize: '13px' }}>Add competitor games and run scans to compare media coverage and eWOM scores.</div>
            </div>
          )}

          {selectedClientId && isLoading && (
            <div style={{ padding: '40px', textAlign: 'center', color: '#94a3b8' }}>Loading...</div>
          )}

          {selectedClientId && !isLoading && competitors.length === 0 && (
            <div style={{ padding: '60px', textAlign: 'center', color: '#94a3b8', backgroundColor: 'white', borderRadius: '12px', border: '1px solid #e2e8f0' }}>
              <div style={{ fontSize: '36px', marginBottom: '12px' }}>🎯</div>
              <div style={{ fontSize: '16px', fontWeight: 600, marginBottom: '6px', color: '#64748b' }}>No competitors tracked yet</div>
              <div style={{ fontSize: '13px', marginBottom: '16px' }}>Add competitor games to start monitoring their media coverage.</div>
              {canEdit && (
                <button onClick={() => { resetForm(); setShowForm(true) }} style={{ padding: '9px 20px', backgroundColor: '#b8232f', color: 'white', border: 'none', borderRadius: '6px', fontSize: '14px', cursor: 'pointer', fontWeight: 500 }}>
                  + Add First Competitor
                </button>
              )}
            </div>
          )}

          {/* Competitor cards */}
          {!isLoading && competitors.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {competitors.map(c => {
                const coverage = coverageMap[c.id] || []
                const stats = getStats(coverage)
                const scanMsg = scanResults[c.id]
                const isExpanded = expandedId === c.id

                return (
                  <div
                    key={c.id}
                    style={{
                      backgroundColor: 'white',
                      borderRadius: '12px',
                      border: c.enabled ? '1px solid #e2e8f0' : '1px solid #fecaca',
                      overflow: 'hidden',
                      opacity: c.enabled ? 1 : 0.7,
                    }}
                  >
                    {/* Card header */}
                    <div style={{ padding: '18px 20px', display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                      <div style={{ flex: 1, minWidth: '200px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <span style={{ fontSize: '20px' }}>🎯</span>
                          <div>
                            <div style={{ fontWeight: 700, fontSize: '16px', color: '#1e293b' }}>{c.name}</div>
                            {c.studio && <div style={{ fontSize: '12px', color: '#94a3b8' }}>{c.studio}</div>}
                            {c.own_game && <div style={{ fontSize: '11px', color: '#64748b', marginTop: '2px' }}>vs. {c.own_game.name}</div>}
                          </div>
                        </div>
                      </div>

                      {/* eWOM score */}
                      <div style={{ textAlign: 'center', minWidth: '80px' }}>
                        <div style={{ fontSize: '28px', fontWeight: 700, color: EWOM_COLOR(stats.eWOM) }}>{stats.eWOM}</div>
                        <div style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 500 }}>eWOM</div>
                      </div>

                      {/* Coverage count */}
                      <div style={{ textAlign: 'center', minWidth: '70px' }}>
                        <div style={{ fontSize: '22px', fontWeight: 700, color: '#1e293b' }}>{stats.total}</div>
                        <div style={{ fontSize: '11px', color: '#94a3b8' }}>total</div>
                      </div>
                      <div style={{ textAlign: 'center', minWidth: '60px' }}>
                        <div style={{ fontSize: '22px', fontWeight: 700, color: '#475569' }}>{stats.recentCount}</div>
                        <div style={{ fontSize: '11px', color: '#94a3b8' }}>last 30d</div>
                      </div>

                      {/* Sentiment mini-bar */}
                      {stats.total > 0 && (
                        <div style={{ minWidth: '120px' }}>
                          <div style={{ display: 'flex', height: '8px', borderRadius: '4px', overflow: 'hidden', marginBottom: '4px' }}>
                            {(['positive', 'neutral', 'mixed', 'negative'] as const).map(s => {
                              const pct = (stats[s] / stats.total) * 100
                              return pct > 0 ? (
                                <div key={s} style={{ width: `${pct}%`, backgroundColor: SENTIMENT_COLORS[s] }} title={`${s}: ${stats[s]}`} />
                              ) : null
                            })}
                          </div>
                          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                            {(['positive', 'neutral', 'mixed', 'negative'] as const).map(s => stats[s] > 0 ? (
                              <span key={s} style={{ fontSize: '10px', color: SENTIMENT_COLORS[s], fontWeight: 500 }}>
                                {stats[s]} {s.slice(0, 3)}
                              </span>
                            ) : null)}
                          </div>
                        </div>
                      )}

                      {/* Actions */}
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
                        {canEdit && (
                          <button
                            onClick={() => handleScan(c.id, c.name)}
                            disabled={scanningId !== null}
                            style={{
                              padding: '6px 12px', backgroundColor: scanningId === c.id ? '#f1f5f9' : '#3b82f6',
                              color: scanningId === c.id ? '#64748b' : 'white', border: 'none', borderRadius: '6px',
                              fontSize: '12px', cursor: scanningId !== null ? 'not-allowed' : 'pointer', fontWeight: 500,
                              opacity: scanningId !== null && scanningId !== c.id ? 0.6 : 1,
                            }}
                          >
                            {scanningId === c.id ? 'Scanning...' : 'Scan'}
                          </button>
                        )}
                        <button
                          onClick={() => setExpandedId(isExpanded ? null : c.id)}
                          style={{ padding: '6px 10px', backgroundColor: 'white', color: '#475569', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}
                        >
                          {isExpanded ? '▲ Hide' : '▼ Coverage'}
                        </button>
                        {canEdit && (
                          <>
                            <button onClick={() => openEdit(c)} style={{ padding: '6px 10px', backgroundColor: 'white', color: '#475569', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>Edit</button>
                            <button onClick={() => handleDelete(c.id)} style={{ padding: '6px 10px', backgroundColor: 'white', color: '#ef4444', border: '1px solid #fecaca', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>Delete</button>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Scan result */}
                    {scanMsg && (
                      <div style={{
                        margin: '0 20px 10px', padding: '6px 12px', borderRadius: '6px', fontSize: '12px',
                        backgroundColor: scanMsg.startsWith('Error') ? '#fee2e2' : '#f0fdf4',
                        color: scanMsg.startsWith('Error') ? '#991b1b' : '#166534',
                      }}>
                        {scanMsg}
                      </div>
                    )}

                    {/* Notes */}
                    {c.notes && (
                      <div style={{ margin: '0 20px 10px', fontSize: '12px', color: '#64748b', fontStyle: 'italic' }}>{c.notes}</div>
                    )}

                    {/* Expanded coverage list */}
                    {isExpanded && (
                      <div style={{ borderTop: '1px solid #f1f5f9', maxHeight: '400px', overflowY: 'auto' }}>
                        {coverage.length === 0 ? (
                          <div style={{ padding: '24px', textAlign: 'center', color: '#94a3b8', fontSize: '13px' }}>
                            No coverage yet — click Scan to fetch coverage from Tavily.
                          </div>
                        ) : (
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                            <thead>
                              <tr style={{ backgroundColor: '#f8fafc', position: 'sticky', top: 0 }}>
                                <th style={{ padding: '8px 16px', textAlign: 'left', color: '#64748b', fontWeight: 600 }}>Title / Source</th>
                                <th style={{ padding: '8px 12px', textAlign: 'left', color: '#64748b', fontWeight: 600 }}>Date</th>
                                <th style={{ padding: '8px 12px', textAlign: 'center', color: '#64748b', fontWeight: 600 }}>Sentiment</th>
                                <th style={{ padding: '8px 12px', textAlign: 'center', color: '#64748b', fontWeight: 600 }}>Score</th>
                              </tr>
                            </thead>
                            <tbody>
                              {coverage.slice(0, 50).map(item => (
                                <tr key={item.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                                  <td style={{ padding: '8px 16px' }}>
                                    <a href={item.url} target="_blank" rel="noopener noreferrer" style={{ color: '#1e293b', textDecoration: 'none', fontWeight: 500 }}>
                                      {item.title || item.url.substring(0, 80)}
                                    </a>
                                    {item.source_domain && (
                                      <div style={{ color: '#94a3b8', fontSize: '11px', marginTop: '2px' }}>{item.source_domain}</div>
                                    )}
                                    {item.snippet && (
                                      <div style={{ color: '#64748b', fontSize: '11px', marginTop: '2px', fontStyle: 'italic' }}>
                                        {item.snippet.substring(0, 120)}...
                                      </div>
                                    )}
                                  </td>
                                  <td style={{ padding: '8px 12px', color: '#64748b', whiteSpace: 'nowrap' }}>
                                    {item.publish_date || timeAgo(item.created_at)}
                                  </td>
                                  <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                                    {item.sentiment && (
                                      <span style={{
                                        padding: '2px 8px', borderRadius: '9999px', fontSize: '10px', fontWeight: 500,
                                        backgroundColor: `${SENTIMENT_COLORS[item.sentiment]}22`,
                                        color: SENTIMENT_COLORS[item.sentiment],
                                      }}>
                                        {item.sentiment}
                                      </span>
                                    )}
                                  </td>
                                  <td style={{ padding: '8px 12px', textAlign: 'center', color: '#64748b' }}>
                                    {item.relevance_score != null ? item.relevance_score.toFixed(2) : '—'}
                                  </td>
                                </tr>
                              ))}
                              {coverage.length > 50 && (
                                <tr>
                                  <td colSpan={4} style={{ padding: '8px 16px', textAlign: 'center', color: '#94a3b8', fontSize: '11px' }}>
                                    Showing 50 of {coverage.length} items
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* eWOM explanation */}
          {competitors.length > 0 && (
            <div style={{ marginTop: '24px', padding: '14px 18px', borderRadius: '8px', backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', fontSize: '12px', color: '#64748b' }}>
              <strong style={{ color: '#475569' }}>eWOM score</strong> — Electronic Word of Mouth index (0–100).
              Calculated from coverage sentiment: positive × 1.0 + neutral × 0.5 + mixed × 0.3 − negative × 1.0, normalized to a 0–100 scale (50 = fully neutral).
              Scores above 65 are green (positive-leaning), below 45 are red (negative-leaning).
              Coverage is fetched via Tavily web search and uses keyword inference for sentiment.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
