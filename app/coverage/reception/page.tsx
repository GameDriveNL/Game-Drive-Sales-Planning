'use client'

import { useState, useEffect, useCallback } from 'react'
import { Sidebar } from '../../components/Sidebar'
import { useAuth } from '@/lib/auth-context'
import { CoverageNav } from '../components/CoverageNav'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'

// ─── Types ───────────────────────────────────────────────────────────────────

interface MonthlyPoint {
  month: string
  positive: number
  neutral: number
  negative: number
  mixed: number
  unknown: number
  reach: number
  review_avg: number | null
}

interface TopCoverage {
  id: string
  title: string | null
  url: string
  publish_date: string | null
  coverage_type: string | null
  sentiment: string | null
  review_score: number | null
  monthly_unique_visitors: number | null
  quotes: string | null
  outlet_name: string | null
  outlet_tier: string | null
  game_name: string | null
  source_type: string
}

interface QuotedItem {
  quotes: string | null
  outlet_name: string | null
  title: string | null
  url: string
  sentiment: string | null
  publish_date: string | null
}

interface ReceptionData {
  total_pieces: number
  total_reach: number
  avg_review_score: number | null
  sentiment_score: number
  sentiment_breakdown: Record<string, number>
  coverage_types: Record<string, number>
  monthly_data: MonthlyPoint[]
  top_coverage: TopCoverage[]
  quoted_items: QuotedItem[]
}

interface ClientOption { id: string; name: string }
interface GameOption { id: string; name: string; client_id: string }

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
    case '30d': from = new Date(now.getTime() - 30 * 86400000); break
    case '90d': from = new Date(now.getTime() - 90 * 86400000); break
    case '6m': from = new Date(now.getTime() - 182 * 86400000); break
    case '12m': from = new Date(now.getTime() - 365 * 86400000); break
    case 'all': return { from: '2020-01-01', to }
    default: from = new Date(now.getTime() - 90 * 86400000)
  }
  return { from: from.toISOString().split('T')[0], to }
}

function formatMonth(m: string): string {
  const [y, mo] = m.split('-')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[parseInt(mo) - 1]} '${y.slice(2)}`
}

const SENTIMENT_COLORS: Record<string, string> = {
  positive: '#16a34a', neutral: '#94a3b8', negative: '#dc2626', mixed: '#d97706', unknown: '#e2e8f0'
}

const TYPE_COLORS: Record<string, string> = {
  review: '#7c3aed', news: '#2563eb', preview: '#0891b2', interview: '#059669',
  stream: '#9333ea', video: '#ea580c', guide: '#65a30d', feature: '#d946ef',
  mention: '#94a3b8', roundup: '#0284c7', trailer: '#dc2626', other: '#64748b'
}

const TIER_COLORS: Record<string, string> = { A: '#16a34a', B: '#2563eb', C: '#ca8a04', D: '#6b7280' }

// ─── Sentiment Score Badge ────────────────────────────────────────────────────

function SentimentScoreBadge({ score }: { score: number }) {
  const clampedScore = Math.max(-100, Math.min(100, score))
  const pct = (clampedScore + 100) / 200
  const color = clampedScore >= 40 ? '#16a34a' : clampedScore >= 0 ? '#ca8a04' : '#dc2626'
  const label = clampedScore >= 60 ? 'Very positive' : clampedScore >= 20 ? 'Positive' : clampedScore >= -20 ? 'Mixed' : clampedScore >= -60 ? 'Negative' : 'Very negative'

  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: '36px', fontWeight: 800, color, lineHeight: 1 }}>{clampedScore > 0 ? '+' : ''}{clampedScore}</div>
      <div style={{ fontSize: '12px', color, fontWeight: 600, marginTop: '4px' }}>{label}</div>
      <div style={{ marginTop: '8px', height: '6px', backgroundColor: '#e2e8f0', borderRadius: '3px', position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${pct * 100}%`, backgroundColor: color, borderRadius: '3px' }} />
      </div>
    </div>
  )
}

// ─── Monthly Sentiment Chart ──────────────────────────────────────────────────

function MonthlySentimentChart({ data }: { data: MonthlyPoint[] }) {
  if (!data.length) return <div style={{ color: '#94a3b8', fontSize: '13px', textAlign: 'center', padding: '32px' }}>No data for selected period</div>

  const maxTotal = Math.max(...data.map(d => d.positive + d.neutral + d.negative + d.mixed + d.unknown), 1)
  const CHART_H = 180
  const BAR_W = Math.max(20, Math.min(48, Math.floor(600 / data.length) - 6))

  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '6px', minHeight: `${CHART_H + 40}px`, padding: '8px 0', minWidth: `${data.length * (BAR_W + 6)}px` }}>
        {data.map(point => {
          const total = point.positive + point.neutral + point.negative + point.mixed + point.unknown || 1
          const scale = CHART_H / maxTotal
          const segments = [
            { key: 'positive', value: point.positive, color: SENTIMENT_COLORS.positive },
            { key: 'neutral', value: point.neutral, color: SENTIMENT_COLORS.neutral },
            { key: 'mixed', value: point.mixed, color: SENTIMENT_COLORS.mixed },
            { key: 'negative', value: point.negative, color: SENTIMENT_COLORS.negative },
          ].filter(s => s.value > 0)

          return (
            <div key={point.month} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
              <div style={{ display: 'flex', flexDirection: 'column-reverse', width: `${BAR_W}px`, height: `${CHART_H}px`, justifyContent: 'flex-start', position: 'relative' }}>
                {segments.map(seg => (
                  <div
                    key={seg.key}
                    title={`${seg.key}: ${seg.value}`}
                    style={{
                      width: '100%',
                      height: `${seg.value * scale}px`,
                      backgroundColor: seg.color,
                      minHeight: seg.value > 0 ? '2px' : 0,
                    }}
                  />
                ))}
                <div style={{ position: 'absolute', top: '-20px', width: '100%', textAlign: 'center', fontSize: '11px', fontWeight: 600, color: '#475569' }}>
                  {total > 0 ? total : ''}
                </div>
              </div>
              <div style={{ fontSize: '10px', color: '#94a3b8', textAlign: 'center', transform: 'rotate(-30deg)', whiteSpace: 'nowrap', marginTop: '4px' }}>
                {formatMonth(point.month)}
              </div>
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: '12px', marginTop: '12px', flexWrap: 'wrap' }}>
        {Object.entries(SENTIMENT_COLORS).filter(([k]) => k !== 'unknown').map(([key, color]) => (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#64748b' }}>
            <div style={{ width: '10px', height: '10px', backgroundColor: color, borderRadius: '2px' }} />
            <span style={{ textTransform: 'capitalize' }}>{key}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Coverage Type Donut ──────────────────────────────────────────────────────

function CoverageTypeBreakdown({ types }: { types: Record<string, number> }) {
  const sorted = Object.entries(types).sort((a, b) => b[1] - a[1])
  const total = sorted.reduce((s, [, v]) => s + v, 0)
  if (!total) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {sorted.map(([type, count]) => (
        <div key={type} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: TYPE_COLORS[type] || '#94a3b8', flexShrink: 0 }} />
          <div style={{ flex: 1, fontSize: '13px', color: '#475569', textTransform: 'capitalize' }}>{type}</div>
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#1e293b' }}>{count}</div>
          <div style={{ width: '80px', height: '6px', backgroundColor: '#f1f5f9', borderRadius: '3px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${(count / total) * 100}%`, backgroundColor: TYPE_COLORS[type] || '#94a3b8' }} />
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ReceptionPage() {
  const { loading: authLoading } = useAuth()
  const supabase = createClientComponentClient()

  const [clients, setClients] = useState<ClientOption[]>([])
  const [games, setGames] = useState<GameOption[]>([])
  const [selectedClient, setSelectedClient] = useState('')
  const [selectedGame, setSelectedGame] = useState('')
  const [period, setPeriod] = useState('90d')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [useCustom, setUseCustom] = useState(false)

  const [data, setData] = useState<ReceptionData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (authLoading) return
    supabase.from('clients').select('id, name').order('name').then(({ data }) => {
      if (data) {
        setClients(data)
        if (data.length > 0) setSelectedClient(data[0].id)
      }
    })
  }, [authLoading, supabase])

  useEffect(() => {
    if (!selectedClient) return
    supabase.from('games').select('id, name, client_id').eq('client_id', selectedClient).order('name').then(({ data }) => {
      setGames(data || [])
      setSelectedGame('')
    })
  }, [selectedClient, supabase])

  const fetchData = useCallback(async () => {
    if (!selectedClient) return
    setLoading(true)
    setError('')
    const range = useCustom && customFrom && customTo ? { from: customFrom, to: customTo } : getDateRange(period)
    const params = new URLSearchParams({ client_id: selectedClient, ...range })
    if (selectedGame) params.set('game_id', selectedGame)
    const res = await fetch(`/api/coverage/reception?${params}`)
    if (!res.ok) { setError('Failed to load reception data'); setLoading(false); return }
    setData(await res.json())
    setLoading(false)
  }, [selectedClient, selectedGame, period, useCustom, customFrom, customTo])

  useEffect(() => { fetchData() }, [fetchData])

  const clientGames = games.filter(g => g.client_id === selectedClient)
  const range = useCustom && customFrom && customTo ? { from: customFrom, to: customTo } : getDateRange(period)

  return (
    <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
      <Sidebar />
      <div style={{ flex: 1, padding: '32px', minWidth: 0 }}>
        <CoverageNav />

        {/* Header + filters */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px', flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: '22px', fontWeight: 700, color: '#1e293b', margin: 0, flex: '0 0 auto' }}>Player Reception</h1>

          <select
            value={selectedClient}
            onChange={e => setSelectedClient(e.target.value)}
            style={{ padding: '7px 12px', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '13px', color: '#1e293b', backgroundColor: 'white' }}
          >
            <option value="">— Client —</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>

          {clientGames.length > 0 && (
            <select
              value={selectedGame}
              onChange={e => setSelectedGame(e.target.value)}
              style={{ padding: '7px 12px', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '13px', color: '#1e293b', backgroundColor: 'white' }}
            >
              <option value="">All games</option>
              {clientGames.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          )}

          <div style={{ display: 'flex', gap: '4px', backgroundColor: 'white', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '3px' }}>
            {['30d', '90d', '6m', '12m', 'all'].map(p => (
              <button
                key={p}
                onClick={() => { setPeriod(p); setUseCustom(false) }}
                style={{
                  padding: '4px 10px', border: 'none', borderRadius: '6px', fontSize: '12px', fontWeight: 500, cursor: 'pointer',
                  backgroundColor: !useCustom && period === p ? '#b8232f' : 'transparent',
                  color: !useCustom && period === p ? 'white' : '#64748b',
                }}
              >
                {p === 'all' ? 'All time' : p}
              </button>
            ))}
            <button
              onClick={() => setUseCustom(true)}
              style={{
                padding: '4px 10px', border: 'none', borderRadius: '6px', fontSize: '12px', fontWeight: 500, cursor: 'pointer',
                backgroundColor: useCustom ? '#b8232f' : 'transparent',
                color: useCustom ? 'white' : '#64748b',
              }}
            >
              Custom
            </button>
          </div>

          {useCustom && (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
                style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '13px' }} />
              <span style={{ color: '#94a3b8', fontSize: '13px' }}>to</span>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
                style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '13px' }} />
            </div>
          )}

          <div style={{ marginLeft: 'auto', fontSize: '12px', color: '#94a3b8' }}>
            {range.from} — {range.to}
          </div>
        </div>

        {error && <div style={{ padding: '12px 16px', backgroundColor: '#fef2f2', color: '#dc2626', borderRadius: '8px', marginBottom: '20px', fontSize: '13px' }}>{error}</div>}

        {loading && (
          <div style={{ textAlign: 'center', padding: '60px', color: '#94a3b8', fontSize: '14px' }}>Loading reception data…</div>
        )}

        {!loading && !data && !error && (
          <div style={{ textAlign: 'center', padding: '60px', color: '#94a3b8', fontSize: '14px' }}>Select a client to view reception data</div>
        )}

        {!loading && data && (
          <>
            {/* Stats row */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '16px', marginBottom: '24px' }}>
              {[
                { label: 'Coverage pieces', value: data.total_pieces.toLocaleString(), color: '#2563eb' },
                { label: 'Total reach', value: formatNumber(data.total_reach), color: '#059669' },
                { label: 'Avg review score', value: data.avg_review_score !== null ? `${data.avg_review_score}/10` : '—', color: '#d97706' },
              ].map(stat => (
                <div key={stat.label} style={{ backgroundColor: 'white', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                  <div style={{ fontSize: '12px', color: '#64748b', fontWeight: 500, marginBottom: '4px' }}>{stat.label}</div>
                  <div style={{ fontSize: '26px', fontWeight: 800, color: stat.color }}>{stat.value}</div>
                </div>
              ))}

              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                <div style={{ fontSize: '12px', color: '#64748b', fontWeight: 500, marginBottom: '8px' }}>Sentiment score</div>
                <SentimentScoreBadge score={data.sentiment_score} />
              </div>
            </div>

            {/* Sentiment breakdown pills */}
            {data.total_pieces > 0 && (
              <div style={{ display: 'flex', gap: '8px', marginBottom: '24px', flexWrap: 'wrap' }}>
                {Object.entries(data.sentiment_breakdown).filter(([, v]) => v > 0).map(([sentiment, count]) => (
                  <div key={sentiment} style={{
                    display: 'flex', alignItems: 'center', gap: '6px',
                    padding: '6px 12px', borderRadius: '20px', fontSize: '13px', fontWeight: 500,
                    backgroundColor: `${SENTIMENT_COLORS[sentiment]}18`,
                    color: SENTIMENT_COLORS[sentiment] || '#64748b',
                    border: `1px solid ${SENTIMENT_COLORS[sentiment]}40`,
                  }}>
                    <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: SENTIMENT_COLORS[sentiment] }} />
                    <span style={{ textTransform: 'capitalize' }}>{sentiment}</span>
                    <span style={{ fontWeight: 700 }}>{count}</span>
                    <span style={{ color: '#94a3b8', fontSize: '11px' }}>({Math.round((count / data.total_pieces) * 100)}%)</span>
                  </div>
                ))}
              </div>
            )}

            {/* Monthly chart + type breakdown */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 260px', gap: '20px', marginBottom: '24px' }}>
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                <h2 style={{ fontSize: '15px', fontWeight: 600, color: '#1e293b', margin: '0 0 20px' }}>Monthly coverage sentiment</h2>
                <MonthlySentimentChart data={data.monthly_data} />
              </div>

              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                <h2 style={{ fontSize: '15px', fontWeight: 600, color: '#1e293b', margin: '0 0 16px' }}>Coverage by type</h2>
                <CoverageTypeBreakdown types={data.coverage_types} />
              </div>
            </div>

            {/* Notable quotes */}
            {data.quoted_items.length > 0 && (
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', marginBottom: '24px' }}>
                <h2 style={{ fontSize: '15px', fontWeight: 600, color: '#1e293b', margin: '0 0 16px' }}>Notable quotes</h2>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '16px' }}>
                  {data.quoted_items.map((item, i) => (
                    <div key={i} style={{
                      padding: '16px', borderRadius: '10px', backgroundColor: '#f8fafc',
                      borderLeft: `3px solid ${SENTIMENT_COLORS[item.sentiment || 'unknown'] || '#e2e8f0'}`,
                    }}>
                      <div style={{ fontSize: '13px', color: '#475569', fontStyle: 'italic', lineHeight: 1.5, marginBottom: '10px' }}>
                        &ldquo;{item.quotes}&rdquo;
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {item.sentiment && (
                          <span style={{ fontSize: '11px', fontWeight: 600, color: SENTIMENT_COLORS[item.sentiment] || '#64748b', textTransform: 'capitalize' }}>
                            {item.sentiment}
                          </span>
                        )}
                        {item.outlet_name && (
                          <a href={item.url} target="_blank" rel="noopener noreferrer"
                            style={{ fontSize: '11px', color: '#2563eb', textDecoration: 'none', fontWeight: 500 }}>
                            {item.outlet_name}
                          </a>
                        )}
                        {item.publish_date && (
                          <span style={{ fontSize: '11px', color: '#94a3b8' }}>{item.publish_date}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Top coverage */}
            {data.top_coverage.length > 0 && (
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                <h2 style={{ fontSize: '15px', fontWeight: 600, color: '#1e293b', margin: '0 0 16px' }}>Top coverage by reach</h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                  {data.top_coverage.map((item, i) => (
                    <div key={item.id} style={{
                      display: 'flex', alignItems: 'center', gap: '12px',
                      padding: '12px 0', borderBottom: i < data.top_coverage.length - 1 ? '1px solid #f1f5f9' : 'none'
                    }}>
                      <div style={{ width: '24px', textAlign: 'right', fontSize: '12px', color: '#94a3b8', fontWeight: 600, flexShrink: 0 }}>
                        {i + 1}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <a href={item.url} target="_blank" rel="noopener noreferrer"
                          style={{ fontSize: '13px', color: '#1e293b', fontWeight: 500, textDecoration: 'none', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          title={item.title || undefined}>
                          {item.title || item.url}
                        </a>
                        <div style={{ display: 'flex', gap: '8px', marginTop: '4px', flexWrap: 'wrap', alignItems: 'center' }}>
                          {item.outlet_name && (
                            <span style={{ fontSize: '11px', color: '#475569' }}>{item.outlet_name}</span>
                          )}
                          {item.outlet_tier && (
                            <span style={{ fontSize: '10px', fontWeight: 700, color: TIER_COLORS[item.outlet_tier] || '#64748b', backgroundColor: `${TIER_COLORS[item.outlet_tier]}18`, padding: '1px 5px', borderRadius: '4px' }}>
                              Tier {item.outlet_tier}
                            </span>
                          )}
                          {item.publish_date && (
                            <span style={{ fontSize: '11px', color: '#94a3b8' }}>{item.publish_date}</span>
                          )}
                          {item.coverage_type && (
                            <span style={{ fontSize: '10px', textTransform: 'capitalize', color: TYPE_COLORS[item.coverage_type] || '#64748b', fontWeight: 500 }}>
                              {item.coverage_type}
                            </span>
                          )}
                        </div>
                      </div>
                      <div style={{ flexShrink: 0, display: 'flex', gap: '8px', alignItems: 'center' }}>
                        {item.review_score !== null && (
                          <div style={{ padding: '3px 8px', backgroundColor: '#7c3aed18', color: '#7c3aed', borderRadius: '6px', fontSize: '12px', fontWeight: 700 }}>
                            {Number(item.review_score).toFixed(1)}/10
                          </div>
                        )}
                        {item.sentiment && (
                          <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: SENTIMENT_COLORS[item.sentiment] || '#94a3b8' }} title={item.sentiment} />
                        )}
                        {item.monthly_unique_visitors !== null && (
                          <div style={{ fontSize: '12px', fontWeight: 600, color: '#059669', minWidth: '48px', textAlign: 'right' }}>
                            {formatNumber(item.monthly_unique_visitors)}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {data.total_pieces === 0 && (
              <div style={{ textAlign: 'center', padding: '60px', color: '#94a3b8', fontSize: '14px' }}>
                No approved coverage found for this period. Make sure coverage items have been approved in the Feed.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
