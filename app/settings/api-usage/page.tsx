'use client'

import { useEffect, useState } from 'react'
import { Sidebar } from '../../components/Sidebar'

interface ApifyByScanner {
  runs: number
  ok: number
  failed: number
  items: number
}

interface UsageResponse {
  period_start: string
  period_end: string
  apify: {
    total_runs: number
    by_scanner: Record<string, ApifyByScanner>
    billing_dashboard: string
  }
  tavily: {
    items_discovered: number
    note: string
    billing_dashboard: string
  }
  gemini: {
    items_classified: number
    note: string
    billing_dashboard: string
  }
}

// Q6: API spend tracker — month-to-date usage per provider.
// Apify usage is precise (tracked in apify_runs). Tavily and Gemini show
// items-discovered as a proxy with a clear link to each provider's billing
// dashboard for actual dollar amounts.

export default function APIUsagePage() {
  const [usage, setUsage] = useState<UsageResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/usage')
      .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then(setUsage)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [])

  const fmtNumber = (n: number) => n.toLocaleString()
  const monthLabel = usage ? new Date(usage.period_start).toLocaleString('en-US', { month: 'long', year: 'numeric' }) : ''

  return (
    <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
      <Sidebar />
      <div style={{ flex: 1, padding: '24px 32px', maxWidth: 1200, fontFamily: 'system-ui' }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, color: '#1e293b', marginBottom: 6 }}>API Usage & Spend</h1>
        <p style={{ color: '#64748b', marginBottom: 24 }}>
          Month-to-date ({monthLabel}). For exact dollar amounts, visit each provider&apos;s billing dashboard.
        </p>

        {loading && <p style={{ color: '#94a3b8' }}>Loading…</p>}
        {error && <p style={{ color: '#dc2626' }}>Failed to load: {error}</p>}

        {usage && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 16 }}>
            {/* Apify card */}
            <Card title="🤖 Apify" subtitle="YouTube · Twitch · Reddit · X · TikTok · Instagram" billingUrl={usage.apify.billing_dashboard}>
              <Stat label="Total runs this month" value={fmtNumber(usage.apify.total_runs)} />
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 12, color: '#64748b', fontWeight: 600, marginBottom: 6 }}>BY SCANNER</div>
                {Object.entries(usage.apify.by_scanner).length === 0 ? (
                  <p style={{ color: '#94a3b8', fontSize: 13 }}>No Apify runs yet this month</p>
                ) : (
                  <table style={{ width: '100%', fontSize: 13 }}>
                    <thead>
                      <tr style={{ color: '#64748b', textAlign: 'left' }}>
                        <th style={{ padding: '4px 6px' }}>Scanner</th>
                        <th style={{ padding: '4px 6px', textAlign: 'right' }}>Runs</th>
                        <th style={{ padding: '4px 6px', textAlign: 'right' }}>OK / Fail</th>
                        <th style={{ padding: '4px 6px', textAlign: 'right' }}>Items</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(usage.apify.by_scanner).map(([k, v]) => (
                        <tr key={k} style={{ borderTop: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '4px 6px', fontWeight: 500 }}>{k}</td>
                          <td style={{ padding: '4px 6px', textAlign: 'right' }}>{fmtNumber(v.runs)}</td>
                          <td style={{ padding: '4px 6px', textAlign: 'right' }}>
                            <span style={{ color: '#16a34a' }}>{v.ok}</span>
                            {v.failed > 0 && <span style={{ color: '#dc2626' }}> / {v.failed}</span>}
                          </td>
                          <td style={{ padding: '4px 6px', textAlign: 'right' }}>{fmtNumber(v.items)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </Card>

            {/* Tavily card */}
            <Card title="🔍 Tavily" subtitle="Web search for coverage discovery" billingUrl={usage.tavily.billing_dashboard}>
              <Stat label="Items discovered this month" value={fmtNumber(usage.tavily.items_discovered)} />
              <p style={{ marginTop: 12, fontSize: 12, color: '#64748b', lineHeight: 1.5 }}>{usage.tavily.note}</p>
            </Card>

            {/* Gemini card */}
            <Card title="🧠 Gemini" subtitle="AI relevance scoring" billingUrl={usage.gemini.billing_dashboard}>
              <Stat label="Items classified this month" value={fmtNumber(usage.gemini.items_classified)} />
              <p style={{ marginTop: 12, fontSize: 12, color: '#64748b', lineHeight: 1.5 }}>{usage.gemini.note}</p>
            </Card>
          </div>
        )}

        <div style={{ marginTop: 32, padding: 16, backgroundColor: '#fef9c3', border: '1px solid #fde68a', borderRadius: 8, fontSize: 13, color: '#854d0e' }}>
          <strong>Note on precision:</strong> Apify counts are precise (every run is logged). Tavily and Gemini counts are <em>proxies</em> based on items discovered — actual dollar spend is best read from each provider&apos;s billing dashboard via the &quot;View billing&quot; links above.
        </div>
      </div>
    </div>
  )
}

function Card({ title, subtitle, billingUrl, children }: { title: string; subtitle: string; billingUrl: string; children: React.ReactNode }) {
  return (
    <div style={{ backgroundColor: 'white', borderRadius: 10, padding: 20, boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
      <div style={{ marginBottom: 12 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: '#1e293b', margin: 0 }}>{title}</h3>
        <p style={{ fontSize: 12, color: '#94a3b8', margin: '2px 0 0 0' }}>{subtitle}</p>
      </div>
      {children}
      <a href={billingUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-block', marginTop: 12, fontSize: 12, color: '#b8232f', textDecoration: 'none', fontWeight: 500 }}>
        View billing dashboard ↗
      </a>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: '#64748b', fontWeight: 600 }}>{label.toUpperCase()}</div>
      <div style={{ fontSize: 32, fontWeight: 700, color: '#1e293b' }}>{value}</div>
    </div>
  )
}
