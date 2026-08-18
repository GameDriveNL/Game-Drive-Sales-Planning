'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import Link from 'next/link'
import { Sidebar } from '../components/Sidebar'

interface NameValue { name: string; value: number }
interface CoverageHighlight { id: string; title: string; url: string; publish_date: string; coverage_type: string; monthly_unique_visitors: number; review_score: number | null; outlet: { name: string; tier: string } | null }

interface DashboardData {
  client: { id: string; name: string } | null
  games: { id: string; name: string }[]
  sales: {
    current_revenue: number; prior_revenue: number; revenue_change: number
    current_units: number; prior_units: number; units_change: number
    top_products: NameValue[]; platform_breakdown: NameValue[]
    revenue_trend: { date: string; value: number }[]
  }
  coverage: {
    total_pieces: number; audience_reach: number; avg_review_score: number | null
    tier_breakdown: NameValue[]; recent_items: CoverageHighlight[]
  }
}

function formatCurrency(val: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(val)
}

function formatNumber(val: number): string {
  return new Intl.NumberFormat('en-US').format(val)
}

function formatCompact(val: number): string {
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}K`
  return String(val)
}

export default function DashboardPage() {
  const supabase = createClientComponentClient()
  const [clients, setClients] = useState<{ id: string; name: string }[]>([])
  const [selectedClient, setSelectedClient] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('gd-dashboard-client') || ''
    }
    return ''
  })
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<DashboardData | null>(null)

  useEffect(() => {
    supabase.from('clients').select('id, name').order('name').then(({ data }) => {
      if (data) {
        setClients(data)
        if (data.length === 1) setSelectedClient(data[0].id)
      }
    })
  }, [supabase])

  // Remember the last selected client across visits to the dashboard
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (selectedClient) localStorage.setItem('gd-dashboard-client', selectedClient)
    else localStorage.removeItem('gd-dashboard-client')
  }, [selectedClient])

  const fetchDashboard = useCallback(async () => {
    if (!selectedClient) return
    setLoading(true)
    try {
      const res = await fetch(`/api/dashboard?client_id=${selectedClient}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setData(json)
    } catch (err) {
      console.error('Dashboard fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [selectedClient])

  useEffect(() => {
    if (selectedClient) fetchDashboard()
  }, [selectedClient, fetchDashboard])

  // Styles
  const pageStyle: React.CSSProperties = { padding: '32px', maxWidth: '1400px', margin: '0 auto' }
  const headerStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }
  const h1Style: React.CSSProperties = { fontSize: '24px', fontWeight: 700, color: '#1e293b' }
  const selectStyle: React.CSSProperties = { padding: '8px 16px', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '14px', minWidth: '220px', background: '#fff' }
  const cardStyle: React.CSSProperties = { background: '#fff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '20px', marginBottom: '16px' }
  const metricGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px', marginBottom: '24px' }
  const metricCard: React.CSSProperties = { background: '#fff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '20px' }
  const metricValue: React.CSSProperties = { fontSize: '28px', fontWeight: 700, color: '#1e293b', lineHeight: 1.2 }
  const metricLabel: React.CSSProperties = { fontSize: '13px', color: '#64748b', marginTop: '4px' }
  const changeBadge = (pct: number): React.CSSProperties => ({
    display: 'inline-block', fontSize: '12px', fontWeight: 600, padding: '2px 8px', borderRadius: '12px', marginLeft: '8px',
    background: pct >= 0 ? '#dcfce7' : '#fee2e2', color: pct >= 0 ? '#166534' : '#991b1b',
  })
  const sectionTitle: React.CSSProperties = { fontSize: '16px', fontWeight: 600, color: '#334155', marginBottom: '12px' }
  const twoCol: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }
  const listItem: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f1f5f9', fontSize: '14px' }
  const tierColors: Record<string, React.CSSProperties> = {
    A: { background: '#dcfce7', color: '#166534', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: 600, display: 'inline-block' },
    B: { background: '#dbeafe', color: '#1e40af', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: 600, display: 'inline-block' },
    C: { background: '#fef3c7', color: '#92400e', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: 600, display: 'inline-block' },
    D: { background: '#f3f4f6', color: '#374151', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: 600, display: 'inline-block' },
  }
  const quickLink: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 16px',
    background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px',
    textDecoration: 'none', color: '#334155', fontSize: '14px', fontWeight: 500,
    transition: 'background 0.15s',
  }
  const barBg: React.CSSProperties = { height: '8px', background: '#e2e8f0', borderRadius: '4px', overflow: 'hidden', flex: 1, marginLeft: '12px' }

  const s = data?.sales
  const c = data?.coverage

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar />
      <div style={{ flex: 1, overflow: 'auto' }}>
    <div style={pageStyle}>
      <div style={headerStyle}>
        <div>
          <h1 style={h1Style}>{data?.client?.name ? `${data.client.name} Dashboard` : 'Client Dashboard'}</h1>
          <p style={{ fontSize: '14px', color: '#64748b', marginTop: '2px' }}>Last 30 days performance overview</p>
        </div>
        <select style={selectStyle} value={selectedClient} onChange={e => setSelectedClient(e.target.value)}>
          <option value="">Select Client...</option>
          {clients.map(cl => <option key={cl.id} value={cl.id}>{cl.name}</option>)}
        </select>
      </div>

      {loading && (
        <div style={{ textAlign: 'center', padding: '64px', color: '#64748b' }}>Loading dashboard...</div>
      )}

      {!loading && !data && !selectedClient && (
        <div style={{ ...cardStyle, textAlign: 'center', padding: '64px', color: '#64748b' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>&#128200;</div>
          <div style={{ fontSize: '18px', fontWeight: 600, color: '#334155', marginBottom: '8px' }}>Select a Client</div>
          <div>Choose a client from the dropdown to view their performance dashboard.</div>
        </div>
      )}

      {data && !loading && (
        <>
          {/* Key Metrics */}
          <div style={metricGrid}>
            <div style={metricCard}>
              <div style={metricValue}>
                {formatCurrency(s?.current_revenue || 0)}
                {s && s.revenue_change !== 0 && (
                  <span style={changeBadge(s.revenue_change)}>{s.revenue_change > 0 ? '+' : ''}{s.revenue_change.toFixed(1)}%</span>
                )}
              </div>
              <div style={metricLabel}>Revenue (30d)</div>
            </div>
            <div style={metricCard}>
              <div style={metricValue}>
                {formatNumber(s?.current_units || 0)}
                {s && s.units_change !== 0 && (
                  <span style={changeBadge(s.units_change)}>{s.units_change > 0 ? '+' : ''}{s.units_change.toFixed(1)}%</span>
                )}
              </div>
              <div style={metricLabel}>Units Sold (30d)</div>
            </div>
            <div style={metricCard}>
              <div style={metricValue}>{c ? formatNumber(c.total_pieces) : '0'}</div>
              <div style={metricLabel}>Coverage Pieces (30d)</div>
            </div>
            <div style={metricCard}>
              <div style={metricValue}>{c ? formatCompact(c.audience_reach) : '0'}</div>
              <div style={metricLabel}>Audience Reach (30d)</div>
            </div>
          </div>

          {/* Two column: Top Products + Revenue by Platform */}
          <div style={twoCol}>
            <div style={cardStyle}>
              <div style={sectionTitle}>Top Products by Revenue</div>
              {s && s.top_products.length > 0 ? (
                s.top_products.map(p => {
                  const maxVal = s.top_products[0]?.value || 1
                  const pct = maxVal > 0 ? (p.value / maxVal) * 100 : 0
                  return (
                    <div key={p.name} style={listItem}>
                      <span style={{ color: '#475569', flex: 1 }}>{p.name}</span>
                      <div style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
                        <div style={barBg}>
                          <div style={{ height: '100%', width: `${pct}%`, background: '#d22939', borderRadius: '4px' }} />
                        </div>
                        <span style={{ fontWeight: 600, color: '#1e293b', marginLeft: '12px', minWidth: '80px', textAlign: 'right' }}>{formatCurrency(p.value)}</span>
                      </div>
                    </div>
                  )
                })
              ) : (
                <div style={{ color: '#94a3b8', fontSize: '14px', padding: '16px 0' }}>No sales data available</div>
              )}
            </div>

            <div style={cardStyle}>
              <div style={sectionTitle}>Revenue by Platform</div>
              {s && s.platform_breakdown.length > 0 ? (
                s.platform_breakdown.map(p => {
                  const total = s.platform_breakdown.reduce((acc, x) => acc + x.value, 0)
                  const pct = total > 0 ? (p.value / total) * 100 : 0
                  return (
                    <div key={p.name} style={listItem}>
                      <span style={{ color: '#475569' }}>{p.name}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontSize: '12px', color: '#94a3b8' }}>{pct.toFixed(1)}%</span>
                        <span style={{ fontWeight: 600, color: '#1e293b' }}>{formatCurrency(p.value)}</span>
                      </div>
                    </div>
                  )
                })
              ) : (
                <div style={{ color: '#94a3b8', fontSize: '14px', padding: '16px 0' }}>No sales data available</div>
              )}
            </div>
          </div>

          {/* Two column: Coverage Highlights + Coverage by Tier */}
          <div style={twoCol}>
            <div style={cardStyle}>
              <div style={sectionTitle}>Recent Coverage Highlights</div>
              {c && c.recent_items.length > 0 ? (
                c.recent_items.map((item) => {
                  const i = item as unknown as CoverageHighlight
                  const outlet = i.outlet as Record<string, string> | null
                  return (
                    <div key={i.id} style={{ padding: '10px 0', borderBottom: '1px solid #f1f5f9' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                        {outlet?.tier && <span style={tierColors[outlet.tier] || {}}>{outlet.tier}</span>}
                        <span style={{ fontSize: '12px', color: '#94a3b8' }}>{outlet?.name || ''}</span>
                        <span style={{ fontSize: '12px', color: '#cbd5e1' }}>&#183;</span>
                        <span style={{ fontSize: '12px', color: '#94a3b8' }}>{i.publish_date || ''}</span>
                      </div>
                      <a href={i.url} target="_blank" rel="noopener noreferrer" style={{ color: '#d22939', textDecoration: 'none', fontSize: '14px', fontWeight: 500 }}>
                        {i.title || i.url}
                      </a>
                    </div>
                  )
                })
              ) : (
                <div style={{ color: '#94a3b8', fontSize: '14px', padding: '16px 0' }}>No recent coverage</div>
              )}
            </div>

            <div style={cardStyle}>
              <div style={sectionTitle}>Coverage by Tier</div>
              {c && c.tier_breakdown.length > 0 ? (
                <>
                  {c.tier_breakdown.map(t => {
                    const total = c.tier_breakdown.reduce((acc, x) => acc + x.value, 0)
                    const pct = total > 0 ? (t.value / total) * 100 : 0
                    return (
                      <div key={t.name} style={listItem}>
                        <span style={tierColors[t.name] || { color: '#475569' }}>Tier {t.name}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <div style={barBg}>
                            <div style={{ height: '100%', width: `${pct}%`, background: t.name === 'A' ? '#22c55e' : t.name === 'B' ? '#3b82f6' : t.name === 'C' ? '#f59e0b' : '#9ca3af', borderRadius: '4px' }} />
                          </div>
                          <span style={{ fontWeight: 600, color: '#1e293b', minWidth: '40px', textAlign: 'right' }}>{t.value}</span>
                        </div>
                      </div>
                    )
                  })}
                  <div style={{ marginTop: '12px', padding: '12px', background: '#f8fafc', borderRadius: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                      <span style={{ color: '#64748b' }}>Avg Review Score</span>
                      <strong>{c.avg_review_score ?? 'N/A'}</strong>
                    </div>
                  </div>
                </>
              ) : (
                <div style={{ color: '#94a3b8', fontSize: '14px', padding: '16px 0' }}>No coverage data</div>
              )}
            </div>
          </div>

          {/* Quick Navigation */}
          <div style={cardStyle}>
            <div style={sectionTitle}>Quick Navigation</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
              <Link href={selectedClient ? `/?client=${selectedClient}` : '/'} style={quickLink}>
                <span>&#128197;</span> Sales Timeline
              </Link>
              <Link href={selectedClient ? `/analytics?client=${selectedClient}` : '/analytics'} style={quickLink}>
                <span>&#128202;</span> Analytics
              </Link>
              <Link href={selectedClient ? `/coverage/dashboard?client=${selectedClient}` : '/coverage/dashboard'} style={quickLink}>
                <span>&#128240;</span> PR Coverage
              </Link>
              <Link href={selectedClient ? `/reports?client=${selectedClient}` : '/reports'} style={quickLink}>
                <span>&#128203;</span> Report Builder
              </Link>
            </div>
          </div>

          {/* Games list */}
          {data.games.length > 0 && (
            <div style={cardStyle}>
              <div style={sectionTitle}>Games ({data.games.length})</div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {data.games.map(g => (
                  <span key={g.id} style={{ padding: '6px 14px', background: '#f1f5f9', borderRadius: '20px', fontSize: '13px', color: '#475569', fontWeight: 500 }}>
                    {g.name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
      </div>
    </div>
  )
}
