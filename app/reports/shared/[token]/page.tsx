'use client'

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'

interface NameValue { name: string; value: number }
interface OutletSummary { name: string; count: number; tier: string; visitors: number }

function formatCurrency(val: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(val)
}

function formatNumber(val: number): string {
  return new Intl.NumberFormat('en-US').format(val)
}

const TIER_COLORS: Record<string, { bg: string; text: string }> = {
  A: { bg: '#dcfce7', text: '#166534' },
  B: { bg: '#dbeafe', text: '#1e40af' },
  C: { bg: '#fef3c7', text: '#92400e' },
  D: { bg: '#f3f4f6', text: '#374151' },
}

export default function SharedReportPage() {
  const { token } = useParams()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<Record<string, unknown> | null>(null)
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null)

  useEffect(() => {
    if (!token) return
    async function fetchReport() {
      try {
        const res = await fetch(`/api/reports/share?token=${token}`)
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.error || `Error ${res.status}`)
        }
        const data = await res.json()
        setReport(data.report)
        setMeta(data.meta)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load report')
      } finally {
        setLoading(false)
      }
    }
    fetchReport()
  }, [token])

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '24px', fontWeight: 700, color: '#1e293b', marginBottom: '8px' }}>Loading Report...</div>
          <div style={{ fontSize: '14px', color: '#64748b' }}>Preparing your performance report</div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
        <div style={{ textAlign: 'center', maxWidth: '400px' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>📊</div>
          <div style={{ fontSize: '20px', fontWeight: 600, color: '#1e293b', marginBottom: '8px' }}>Report Unavailable</div>
          <div style={{ fontSize: '14px', color: '#64748b' }}>{error}</div>
        </div>
      </div>
    )
  }

  if (!report || !meta) return null

  const sales = report.sales as Record<string, unknown> | undefined
  const coverage = report.coverage as Record<string, unknown> | undefined
  const social = report.social as Record<string, unknown> | undefined

  const clientName = String(meta.client_name || 'Client')
  const gameName = meta.game_name ? String(meta.game_name) : null
  const dateFrom = meta.date_from ? String(meta.date_from) : null
  const dateTo = meta.date_to ? String(meta.date_to) : null
  const periodLabel = dateFrom && dateTo ? `${dateFrom} to ${dateTo}` : 'All Time'

  const cardStyle: React.CSSProperties = { backgroundColor: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: '20px' }
  const statCard: React.CSSProperties = { backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '20px', textAlign: 'center' }

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#f1f5f9', padding: '40px 20px' }}>
      <div style={{ maxWidth: '1000px', margin: '0 auto' }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <h1 style={{ fontSize: '28px', fontWeight: 700, color: '#1e293b', margin: '0 0 4px 0' }}>
            {clientName}{gameName ? ` — ${gameName}` : ''}
          </h1>
          <p style={{ fontSize: '14px', color: '#64748b', margin: 0 }}>
            Performance Report | {periodLabel}
          </p>
          <p style={{ fontSize: '12px', color: '#94a3b8', margin: '8px 0 0 0' }}>
            Powered by GameDrive
          </p>
        </div>

        {/* Sales */}
        {sales && (
          <div style={cardStyle}>
            <h2 style={{ fontSize: '20px', fontWeight: 600, color: '#1e293b', marginBottom: '16px' }}>Sales Performance</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px', marginBottom: '20px' }}>
              <div style={statCard}>
                <div style={{ fontSize: '24px', fontWeight: 700, color: '#1e293b' }}>{formatCurrency(Number(sales.total_net_revenue))}</div>
                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>Net Revenue</div>
              </div>
              <div style={statCard}>
                <div style={{ fontSize: '24px', fontWeight: 700, color: '#1e293b' }}>{formatNumber(Number(sales.total_net_units))}</div>
                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>Net Units</div>
              </div>
              <div style={statCard}>
                <div style={{ fontSize: '24px', fontWeight: 700, color: '#1e293b' }}>{formatCurrency(Number(sales.avg_price))}</div>
                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>Avg Price</div>
              </div>
              <div style={statCard}>
                <div style={{ fontSize: '24px', fontWeight: 700, color: '#1e293b' }}>{(sales.platform_revenue as NameValue[])?.length || 0}</div>
                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>Platforms</div>
              </div>
            </div>
            {(sales.platform_revenue as NameValue[])?.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                <div>
                  <h3 style={{ fontSize: '14px', fontWeight: 600, color: '#334155', marginBottom: '8px' }}>Revenue by Platform</h3>
                  {(sales.platform_revenue as NameValue[]).map(p => (
                    <div key={p.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '13px', borderBottom: '1px solid #f1f5f9' }}>
                      <span style={{ color: '#475569' }}>{p.name}</span>
                      <span style={{ fontWeight: 600 }}>{formatCurrency(p.value)}</span>
                    </div>
                  ))}
                </div>
                <div>
                  <h3 style={{ fontSize: '14px', fontWeight: 600, color: '#334155', marginBottom: '8px' }}>Top Countries</h3>
                  {(sales.country_revenue as NameValue[])?.slice(0, 10).map(c => (
                    <div key={c.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '13px', borderBottom: '1px solid #f1f5f9' }}>
                      <span style={{ color: '#475569' }}>{c.name}</span>
                      <span style={{ fontWeight: 600 }}>{formatCurrency(c.value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Coverage */}
        {coverage && (
          <div style={cardStyle}>
            <h2 style={{ fontSize: '20px', fontWeight: 600, color: '#1e293b', marginBottom: '16px' }}>PR Coverage</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px', marginBottom: '20px' }}>
              <div style={statCard}>
                <div style={{ fontSize: '24px', fontWeight: 700, color: '#1e293b' }}>{formatNumber(Number(coverage.total_pieces))}</div>
                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>Total Pieces</div>
              </div>
              <div style={statCard}>
                <div style={{ fontSize: '24px', fontWeight: 700, color: '#1e293b' }}>{formatNumber(Number(coverage.total_audience_reach))}</div>
                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>Audience Reach</div>
              </div>
              <div style={statCard}>
                <div style={{ fontSize: '24px', fontWeight: 700, color: '#1e293b' }}>{formatNumber(Number(coverage.estimated_views))}</div>
                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>Est. Views</div>
              </div>
              <div style={statCard}>
                <div style={{ fontSize: '24px', fontWeight: 700, color: '#1e293b' }}>{String(coverage.avg_review_score ?? 'N/A')}</div>
                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>Avg Review</div>
              </div>
            </div>
            {(coverage.top_outlets as OutletSummary[])?.length > 0 && (
              <div>
                <h3 style={{ fontSize: '14px', fontWeight: 600, color: '#334155', marginBottom: '8px' }}>Top Outlets</h3>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '8px', borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>Outlet</th>
                      <th style={{ textAlign: 'center', padding: '8px', borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>Tier</th>
                      <th style={{ textAlign: 'right', padding: '8px', borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>Pieces</th>
                      <th style={{ textAlign: 'right', padding: '8px', borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>Audience</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(coverage.top_outlets as OutletSummary[]).map(o => {
                      const tc = TIER_COLORS[o.tier] || TIER_COLORS.D
                      return (
                        <tr key={o.name}>
                          <td style={{ padding: '6px 8px', borderBottom: '1px solid #f1f5f9' }}>{o.name}</td>
                          <td style={{ padding: '6px 8px', borderBottom: '1px solid #f1f5f9', textAlign: 'center' }}>
                            <span style={{ padding: '2px 8px', borderRadius: '9999px', fontSize: '11px', fontWeight: 600, backgroundColor: tc.bg, color: tc.text }}>
                              {o.tier}
                            </span>
                          </td>
                          <td style={{ padding: '6px 8px', borderBottom: '1px solid #f1f5f9', textAlign: 'right' }}>{o.count}</td>
                          <td style={{ padding: '6px 8px', borderBottom: '1px solid #f1f5f9', textAlign: 'right' }}>{formatNumber(o.visitors)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Social */}
        {social && Number((social as Record<string, unknown>).total_posts) > 0 && (
          <div style={cardStyle}>
            <h2 style={{ fontSize: '20px', fontWeight: 600, color: '#1e293b', marginBottom: '16px' }}>Social Media</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>
              <div style={statCard}>
                <div style={{ fontSize: '24px', fontWeight: 700, color: '#1e293b' }}>{formatNumber(Number((social as Record<string, unknown>).total_posts))}</div>
                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>Total Posts</div>
              </div>
              <div style={statCard}>
                <div style={{ fontSize: '24px', fontWeight: 700, color: '#1e293b' }}>{formatNumber(Number((social as Record<string, unknown>).total_reach))}</div>
                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>Combined Followers</div>
              </div>
              <div style={statCard}>
                <div style={{ fontSize: '24px', fontWeight: 700, color: '#1e293b' }}>{formatNumber(Number((social as Record<string, unknown>).total_engagement))}</div>
                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>Total Engagement</div>
              </div>
              <div style={statCard}>
                <div style={{ fontSize: '24px', fontWeight: 700, color: '#1e293b' }}>{Number((social as Record<string, unknown>).engagement_rate).toFixed(2)}%</div>
                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>Engagement Rate</div>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div style={{ textAlign: 'center', padding: '20px 0', color: '#94a3b8', fontSize: '12px' }}>
          Generated by GameDrive | {new Date().toLocaleDateString()}
        </div>
      </div>
    </div>
  )
}
