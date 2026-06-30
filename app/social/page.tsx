'use client'

import { useState, useRef, useCallback } from 'react'
import { Sidebar } from '../components/Sidebar'

// ─── CSV Parsing ──────────────────────────────────────────────────────────────

interface CSVRow { [key: string]: string }

function parseYouTubeCSV(text: string): { meta: Record<string, string>; headers: string[]; rows: CSVRow[] } {
  const lines = text.split(/\r?\n/)
  const meta: Record<string, string> = {}
  let dataStart = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith('#')) {
      const rest = line.slice(1).trim()
      const colonIdx = rest.indexOf(':')
      if (colonIdx !== -1) {
        const key = rest.slice(0, colonIdx).trim()
        const val = rest.slice(colonIdx + 1).trim()
        meta[key] = val
      }
      dataStart = i + 1
    } else if (line && !line.startsWith('#')) {
      break
    }
  }

  const parseCSVLine = (line: string): string[] => {
    const result: string[] = []
    let current = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        inQuotes = !inQuotes
      } else if (ch === ',' && !inQuotes) {
        result.push(current.trim())
        current = ''
      } else {
        current += ch
      }
    }
    result.push(current.trim())
    return result
  }

  const nonEmpty = lines.slice(dataStart).filter(l => l.trim())
  if (!nonEmpty.length) return { meta, headers: [], rows: [] }

  const headers = parseCSVLine(nonEmpty[0])
  const rows: CSVRow[] = []
  for (let i = 1; i < nonEmpty.length; i++) {
    const vals = parseCSVLine(nonEmpty[i])
    const row: CSVRow = {}
    headers.forEach((h, idx) => { row[h] = vals[idx] || '' })
    rows.push(row)
  }

  return { meta, headers, rows }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface DataPoint { date: string; value: number }

interface ChannelData {
  id: string
  name: string
  meta: Record<string, string>
  headers: string[]
  metrics: Record<string, DataPoint[]>
  color: string
}

const CHANNEL_COLORS = ['#b8232f', '#2563eb', '#059669', '#d97706', '#7c3aed']

// ─── Metric normalization ─────────────────────────────────────────────────────

const METRIC_ALIASES: Record<string, string[]> = {
  'Views': ['Views', 'views'],
  'Watch time (hours)': ['Watch time (hours)', 'Watch time', 'watch_time_hours'],
  'Subscribers': ['Subscribers', 'Subscribers gained', 'subscribers'],
  'Impressions': ['Impressions', 'impressions'],
  'Revenue': ['Estimated revenue', 'Estimated revenue (EUR)', 'Estimated revenue (USD)', 'Revenue'],
  'CTR (%)': ['Impressions click-through rate (%)', 'Click-through rate', 'CTR'],
}

function resolveMetricKey(header: string): string {
  for (const [canonical, aliases] of Object.entries(METRIC_ALIASES)) {
    if (aliases.some(a => header.toLowerCase().includes(a.toLowerCase()))) return canonical
  }
  return header
}

function extractMetrics(headers: string[], rows: CSVRow[]): Record<string, DataPoint[]> {
  const dateCol = headers.find(h => h.toLowerCase() === 'date' || h.toLowerCase() === 'day') || headers[0]
  const result: Record<string, DataPoint[]> = {}

  for (const h of headers) {
    if (h === dateCol) continue
    const canonical = resolveMetricKey(h)
    const pts: DataPoint[] = []
    for (const row of rows) {
      const date = row[dateCol]
      const raw = row[h]?.replace(/,/g, '').replace(/%/g, '')
      const value = parseFloat(raw)
      if (date && !isNaN(value)) pts.push({ date, value })
    }
    if (pts.length) {
      if (!result[canonical]) result[canonical] = pts
    }
  }
  return result
}

// ─── Mini SVG Line Chart ──────────────────────────────────────────────────────

function LineChart({ channels, metric, width = 700, height = 260 }: {
  channels: ChannelData[]; metric: string; width?: number; height?: number
}) {
  const PAD = { top: 20, right: 20, bottom: 40, left: 56 }
  const W = width - PAD.left - PAD.right
  const H = height - PAD.top - PAD.bottom

  const allPoints = channels.flatMap(c => c.metrics[metric] || [])
  if (!allPoints.length) return <div style={{ color: '#94a3b8', fontSize: '13px', textAlign: 'center', padding: '40px' }}>No data for this metric</div>

  const allDates = Array.from(new Set(allPoints.map(p => p.date))).sort()
  const allValues = allPoints.map(p => p.value)
  const minVal = Math.min(...allValues)
  const maxVal = Math.max(...allValues)
  const range = maxVal - minVal || 1

  const xScale = (i: number) => (i / (allDates.length - 1)) * W
  const yScale = (v: number) => H - ((v - minVal) / range) * H

  const yTicks = 4
  const yStep = range / yTicks

  const formatValue = (v: number) => {
    if (metric.includes('time')) return `${v.toFixed(0)}h`
    if (metric.includes('%') || metric.includes('CTR')) return `${v.toFixed(1)}%`
    if (metric.includes('Revenue')) return `€${v.toFixed(0)}`
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
    if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`
    return v.toFixed(0)
  }

  const labelInterval = Math.max(1, Math.floor(allDates.length / 8))

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} style={{ overflow: 'visible' }}>
      <g transform={`translate(${PAD.left},${PAD.top})`}>
        {/* Grid lines + Y labels */}
        {Array.from({ length: yTicks + 1 }, (_, i) => {
          const v = minVal + i * yStep
          const y = yScale(v)
          return (
            <g key={i}>
              <line x1={0} y1={y} x2={W} y2={y} stroke="#e2e8f0" strokeWidth="1" />
              <text x={-6} y={y + 4} textAnchor="end" fontSize="10" fill="#94a3b8">{formatValue(v)}</text>
            </g>
          )
        })}

        {/* Lines per channel */}
        {channels.map(ch => {
          const pts = ch.metrics[metric]
          if (!pts?.length) return null
          const dateIndex = Object.fromEntries(allDates.map((d, i) => [d, i]))
          const polyPts = pts
            .filter(p => dateIndex[p.date] !== undefined)
            .map(p => `${xScale(dateIndex[p.date])},${yScale(p.value)}`)
            .join(' ')
          return (
            <polyline key={ch.id} points={polyPts} fill="none" stroke={ch.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          )
        })}

        {/* X labels */}
        {allDates.filter((_, i) => i % labelInterval === 0 || i === allDates.length - 1).map(d => {
          const i = allDates.indexOf(d)
          return (
            <text key={d} x={xScale(i)} y={H + 18} textAnchor="middle" fontSize="10" fill="#94a3b8" transform={`rotate(-20, ${xScale(i)}, ${H + 18})`}>
              {d.slice(0, 7)}
            </text>
          )
        })}
      </g>
    </svg>
  )
}

// ─── Growth Highlights ────────────────────────────────────────────────────────

function growthHighlights(points: DataPoint[], n = 5): { date: string; value: number; delta: number; pct: number }[] {
  if (points.length < 8) return []
  const window = 7
  const highlights: { date: string; value: number; delta: number; pct: number }[] = []
  for (let i = window; i < points.length; i++) {
    const prev = points.slice(i - window, i).reduce((s, p) => s + p.value, 0) / window
    const cur = points[i].value
    if (prev > 0) {
      const delta = cur - prev
      const pct = (delta / prev) * 100
      highlights.push({ date: points[i].date, value: cur, delta, pct })
    }
  }
  return highlights.sort((a, b) => b.pct - a.pct).slice(0, n)
}

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ backgroundColor: 'white', borderRadius: '10px', padding: '16px 20px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
      <div style={{ fontSize: '11px', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>{label}</div>
      <div style={{ fontSize: '22px', fontWeight: 800, color: '#1e293b' }}>{value}</div>
      {sub && <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>{sub}</div>}
    </div>
  )
}

function formatBig(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

// ─── Drop Zone ────────────────────────────────────────────────────────────────

function DropZone({ onFiles }: { onFiles: (files: FileList) => void }) {
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLInputElement>(null)

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => { e.preventDefault(); setDragging(false); onFiles(e.dataTransfer.files) }}
      onClick={() => ref.current?.click()}
      style={{
        border: `2px dashed ${dragging ? '#b8232f' : '#cbd5e1'}`,
        borderRadius: '12px', padding: '40px 20px', textAlign: 'center', cursor: 'pointer',
        backgroundColor: dragging ? '#fef2f2' : '#f8fafc', transition: 'all 0.15s',
      }}
    >
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke={dragging ? '#b8232f' : '#94a3b8'} strokeWidth="1.5" style={{ margin: '0 auto 12px', display: 'block' }}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
      <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569', marginBottom: '6px' }}>Drop YouTube Studio CSV files here</div>
      <div style={{ fontSize: '12px', color: '#94a3b8' }}>or click to browse — supports multiple files for comparison</div>
      <div style={{ marginTop: '16px', fontSize: '11px', color: '#cbd5e1' }}>
        Export from YouTube Studio → Analytics → Advanced mode → Export current view
      </div>
      <input ref={ref} type="file" accept=".csv,text/csv" multiple style={{ display: 'none' }}
        onChange={e => { if (e.target.files?.length) onFiles(e.target.files); e.target.value = '' }} />
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const METRICS_ORDER = ['Views', 'Subscribers', 'Watch time (hours)', 'Impressions', 'CTR (%)', 'Revenue']

export default function SocialPage() {
  const [channels, setChannels] = useState<ChannelData[]>([])
  const [activeMetric, setActiveMetric] = useState('Views')
  const [error, setError] = useState('')

  const handleFiles = useCallback(async (files: FileList) => {
    setError('')
    const newChannels: ChannelData[] = []
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      try {
        const text = await file.text()
        const { meta, headers, rows } = parseYouTubeCSV(text)
        if (!headers.length || !rows.length) { setError(`Could not parse ${file.name} — check it's a YouTube Studio CSV export`); continue }
        const metrics = extractMetrics(headers, rows)
        const channelName = meta['Channel name'] || meta['Report name'] || file.name.replace(/\.csv$/i, '')
        const id = `ch_${Date.now()}_${i}`
        const colorIdx = (channels.length + newChannels.length) % CHANNEL_COLORS.length
        newChannels.push({ id, name: channelName, meta, headers, metrics, color: CHANNEL_COLORS[colorIdx] })
      } catch {
        setError(`Failed to read ${file.name}`)
      }
    }
    if (newChannels.length) setChannels(prev => [...prev, ...newChannels])
  }, [channels.length])

  const removeChannel = (id: string) => setChannels(prev => prev.filter(c => c.id !== id))

  const availableMetrics = METRICS_ORDER.filter(m => channels.some(c => c.metrics[m]?.length))

  // Stats for the primary channel on the active metric
  const primaryChannel = channels[0]
  const primaryPts = primaryChannel?.metrics[activeMetric] || []
  const totalViews = primaryChannel?.metrics['Views']?.reduce((s, p) => s + p.value, 0) || 0
  const totalSubs = primaryChannel?.metrics['Subscribers']?.reduce((s, p) => s + p.value, 0) || 0
  const peakDay = primaryPts.reduce((best, p) => p.value > (best?.value || 0) ? p : best, primaryPts[0])
  const avgDaily = primaryPts.length > 0 ? primaryPts.reduce((s, p) => s + p.value, 0) / primaryPts.length : 0

  const highlights = primaryPts.length > 0 ? growthHighlights(primaryPts) : []

  const formatMetricValue = (v: number) => {
    if (activeMetric.includes('time')) return `${v.toFixed(0)}h`
    if (activeMetric.includes('%') || activeMetric.includes('CTR')) return `${v.toFixed(1)}%`
    if (activeMetric.includes('Revenue')) return `€${v.toFixed(0)}`
    return formatBig(v)
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
      <Sidebar />
      <div style={{ flex: 1, padding: '32px', minWidth: 0 }}>

        <div style={{ marginBottom: '28px' }}>
          <h1 style={{ fontSize: '22px', fontWeight: 700, color: '#1e293b', margin: '0 0 4px' }}>Social Media Baseline</h1>
          <p style={{ fontSize: '13px', color: '#64748b', margin: 0 }}>Upload YouTube Studio CSV exports to visualize channel growth and identify what drove performance.</p>
        </div>

        {!channels.length && (
          <DropZone onFiles={handleFiles} />
        )}

        {error && (
          <div style={{ marginTop: '12px', padding: '12px 16px', backgroundColor: '#fef2f2', color: '#dc2626', borderRadius: '8px', fontSize: '13px' }}>{error}</div>
        )}

        {channels.length > 0 && (
          <>
            {/* Channel chips + add more */}
            <div style={{ display: 'flex', gap: '8px', marginBottom: '24px', flexWrap: 'wrap', alignItems: 'center' }}>
              {channels.map(ch => (
                <div key={ch.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px', backgroundColor: 'white', border: `2px solid ${ch.color}`, borderRadius: '20px' }}>
                  <div style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: ch.color }} />
                  <span style={{ fontSize: '13px', fontWeight: 500, color: '#1e293b' }}>{ch.name}</span>
                  <button onClick={() => removeChannel(ch.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: '16px', lineHeight: 1, padding: '0 0 1px' }}>&times;</button>
                </div>
              ))}
              <label style={{ cursor: 'pointer' }}>
                <div style={{ padding: '6px 14px', backgroundColor: '#f1f5f9', border: '1px dashed #cbd5e1', borderRadius: '20px', fontSize: '12px', color: '#64748b', fontWeight: 500 }}>
                  + Add channel CSV
                </div>
                <input type="file" accept=".csv,text/csv" multiple style={{ display: 'none' }} onChange={e => { if (e.target.files?.length) handleFiles(e.target.files); e.target.value = '' }} />
              </label>
            </div>

            {/* Stats row (primary channel) */}
            {primaryChannel && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px', marginBottom: '24px' }}>
                <StatCard label="Total views" value={formatBig(totalViews)} sub={`${primaryChannel.meta['Start date'] || ''} – ${primaryChannel.meta['End date'] || ''}`} />
                <StatCard label="Subscribers gained" value={totalSubs >= 0 ? `+${formatBig(totalSubs)}` : formatBig(totalSubs)} />
                <StatCard label="Peak day" value={peakDay ? formatMetricValue(peakDay.value) : '—'} sub={peakDay?.date || ''} />
                <StatCard label={`Avg daily ${activeMetric.toLowerCase()}`} value={formatMetricValue(avgDaily)} sub={`over ${primaryPts.length} days`} />
              </div>
            )}

            {/* Metric tabs */}
            {availableMetrics.length > 1 && (
              <div style={{ display: 'flex', gap: '0', borderBottom: '2px solid #e2e8f0', marginBottom: '20px' }}>
                {availableMetrics.map(m => {
                  const active = m === activeMetric
                  return (
                    <button key={m} onClick={() => setActiveMetric(m)} style={{
                      padding: '8px 16px', border: 'none', backgroundColor: 'transparent', cursor: 'pointer',
                      fontSize: '13px', fontWeight: active ? 600 : 400,
                      color: active ? '#b8232f' : '#64748b',
                      borderBottom: active ? '2px solid #b8232f' : '2px solid transparent',
                      marginBottom: '-2px', whiteSpace: 'nowrap',
                    }}>
                      {m}
                    </button>
                  )
                })}
              </div>
            )}

            {/* Line chart */}
            <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', marginBottom: '24px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <h2 style={{ fontSize: '15px', fontWeight: 600, color: '#1e293b', margin: 0 }}>{activeMetric} over time</h2>
                {channels.length > 1 && (
                  <div style={{ display: 'flex', gap: '12px' }}>
                    {channels.map(ch => (
                      <div key={ch.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#64748b' }}>
                        <div style={{ width: '20px', height: '2px', backgroundColor: ch.color }} />
                        {ch.name}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <LineChart channels={channels} metric={activeMetric} />
            </div>

            {/* Growth highlights */}
            {highlights.length > 0 && (
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', marginBottom: '24px' }}>
                <h2 style={{ fontSize: '15px', fontWeight: 600, color: '#1e293b', margin: '0 0 16px' }}>Top growth days — {activeMetric}</h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                  {highlights.map((h, i) => (
                    <div key={h.date} style={{
                      display: 'flex', alignItems: 'center', gap: '16px', padding: '12px 0',
                      borderBottom: i < highlights.length - 1 ? '1px solid #f1f5f9' : 'none'
                    }}>
                      <div style={{ width: '24px', textAlign: 'right', fontSize: '12px', color: '#94a3b8', fontWeight: 600 }}>{i + 1}</div>
                      <div style={{ fontSize: '13px', fontWeight: 500, color: '#1e293b', minWidth: '90px' }}>{h.date}</div>
                      <div style={{ flex: 1, fontSize: '13px', color: '#475569' }}>
                        {formatMetricValue(h.value)} <span style={{ color: '#94a3b8' }}>on this day</span>
                      </div>
                      <div style={{
                        padding: '3px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: 700,
                        backgroundColor: h.pct > 0 ? '#f0fdf4' : '#fef2f2',
                        color: h.pct > 0 ? '#16a34a' : '#dc2626'
                      }}>
                        {h.pct > 0 ? '+' : ''}{h.pct.toFixed(0)}% vs 7-day avg
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: '12px', fontSize: '11px', color: '#94a3b8' }}>
                  Based on 7-day rolling average. Upload additional data (trailers, press, social posts) to correlate spikes with events.
                </div>
              </div>
            )}

            {/* Export hint */}
            <div style={{ padding: '14px 18px', backgroundColor: '#eff6ff', borderRadius: '10px', fontSize: '12px', color: '#3b82f6', lineHeight: 1.6 }}>
              <strong>How to export:</strong> YouTube Studio → Analytics → Advanced mode → set date range → Export (↓) → Download current view as CSV.
              Upload multiple channel CSVs to compare performance across games or clients.
            </div>
          </>
        )}
      </div>
    </div>
  )
}
