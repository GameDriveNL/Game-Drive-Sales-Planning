'use client'

/**
 * Collapsible "Scanner Health" panel for the coverage dashboard.
 *
 * Polls /api/coverage-health/scanner-health every 60s. Default collapsed.
 * Shows green/yellow/red dot per scanner + a one-line summary. When
 * expanded, shows per-scanner item rate, error rate, and last-fired
 * heuristic.
 *
 * Intentionally minimal — this is ops monitoring, not analytics. If you
 * need historical trends, look at the BarChart panels above.
 */

import { useEffect, useState } from 'react'

interface ScannerStat {
  scanner: string
  schedule: string
  items_24h: number
  items_1h: number
  errors_24h: number
  errors_1h: number
  error_rate_24h: number
  status: 'healthy' | 'warn' | 'critical' | 'idle'
  status_reason: string
}

interface ScannerHealth {
  overall: 'healthy' | 'warn' | 'critical'
  generated_at: string
  scanners: ScannerStat[]
  queue: {
    pending_review_total: number
    auto_approved_24h: number
  }
}

const DOT: Record<ScannerStat['status'], { color: string; label: string }> = {
  healthy:  { color: '#16a34a', label: '🟢' },
  warn:     { color: '#ca8a04', label: '🟡' },
  critical: { color: '#dc2626', label: '🔴' },
  idle:     { color: '#94a3b8', label: '⚪' },
}

export default function ScannerHealthPanel() {
  const [data, setData] = useState<ScannerHealth | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const r = await fetch('/api/coverage-health/scanner-health', { cache: 'no-store' })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const json = await r.json() as ScannerHealth
        if (!cancelled) { setData(json); setLoading(false) }
      } catch {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const id = setInterval(load, 60_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  const overall = data?.overall ?? 'healthy'
  const headerDot = DOT[overall === 'critical' ? 'critical' : overall === 'warn' ? 'warn' : 'healthy']
  const items24Total = data?.scanners.reduce((s, x) => s + x.items_24h, 0) ?? 0
  const errors24Total = data?.scanners.reduce((s, x) => s + x.errors_24h, 0) ?? 0

  return (
    <div style={{
      backgroundColor: 'white', borderRadius: '12px', padding: '16px 20px',
      boxShadow: '0 1px 3px rgba(0,0,0,0.06)', marginTop: '24px',
      border: `1px solid ${headerDot.color}33`,
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          all: 'unset', cursor: 'pointer', width: '100%',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '16px' }}>{headerDot.label}</span>
          <h3 style={{ fontSize: '14px', fontWeight: 600, color: '#1e293b', margin: 0 }}>
            Scanner Health
          </h3>
          {loading ? (
            <span style={{ fontSize: '12px', color: '#94a3b8' }}>loading…</span>
          ) : (
            <span style={{ fontSize: '12px', color: '#64748b' }}>
              {items24Total} items in 24h · {errors24Total} errors · {data?.queue.pending_review_total ?? 0} pending review
            </span>
          )}
        </div>
        <span style={{ fontSize: '13px', color: '#64748b' }}>{open ? '▾' : '▸'}</span>
      </button>

      {open && data && (
        <div style={{ marginTop: '14px' }}>
          <table style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: '#64748b', textAlign: 'left' }}>
                <th style={{ padding: '6px 8px' }}>Scanner</th>
                <th style={{ padding: '6px 8px' }}>Schedule</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Items 24h</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Items 1h</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Errors 24h</th>
                <th style={{ padding: '6px 8px' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.scanners.map(s => (
                <tr key={s.scanner} style={{ borderTop: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '6px 8px', fontFamily: 'ui-monospace, monospace' }}>{s.scanner}</td>
                  <td style={{ padding: '6px 8px', color: '#64748b' }}>{s.schedule}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>{s.items_24h}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', color: s.items_1h > 0 ? '#16a34a' : '#94a3b8' }}>{s.items_1h}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', color: s.errors_24h > 0 ? '#dc2626' : '#94a3b8' }}>{s.errors_24h}</td>
                  <td style={{ padding: '6px 8px' }}>
                    <span style={{
                      fontSize: '11px', color: DOT[s.status].color, fontWeight: 500,
                    }}>
                      {DOT[s.status].label} {s.status_reason}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: '12px', fontSize: '11px', color: '#94a3b8' }}>
            Updated {new Date(data.generated_at).toLocaleTimeString()} ·
            Auto-approved last 24h: {data.queue.auto_approved_24h} ·
            Refreshes every 60s
          </div>
        </div>
      )}
    </div>
  )
}
