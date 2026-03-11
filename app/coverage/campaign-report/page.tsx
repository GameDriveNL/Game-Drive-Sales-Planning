'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import { Sidebar } from '../../components/Sidebar'
import { useAuth } from '@/lib/auth-context'
import Link from 'next/link'
import * as XLSX from 'xlsx'
import styles from './page.module.css'

interface CoverageRow {
  id: string
  title: string
  url: string
  publish_date: string | null
  coverage_type: string | null
  territory: string | null
  monthly_unique_visitors: number | null
  discovered_at: string | null
  created_at: string | null
  outlet: {
    id: string
    name: string
    tier: string | null
    domain: string | null
    monthly_unique_visitors: number | null
  } | null
  // Computed fields from API
  outlet_display_name: string
  display_date: string | null
  display_visitors: number | null
  display_domain: string | null
}

function formatDateEU(dateStr: string | null): string {
  if (!dateStr) return '-'
  try {
    const [y, m, d] = dateStr.split('-')
    return `${d}.${m}.${y}`
  } catch {
    return dateStr
  }
}

function formatVisitors(n: number | null | undefined): string {
  if (!n) return '-'
  return n.toLocaleString('en-US')
}

export default function CampaignReportPage() {
  const supabase = createClientComponentClient()
  const { hasAccess, loading: authLoading } = useAuth()
  const canView = hasAccess('pr_coverage', 'view')

  const [clients, setClients] = useState<{ id: string; name: string }[]>([])
  const [games, setGames] = useState<{ id: string; name: string; client_id: string }[]>([])
  const [selectedClient, setSelectedClient] = useState('')
  const [selectedGame, setSelectedGame] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [items, setItems] = useState<CoverageRow[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [enriching, setEnriching] = useState(false)
  const [enrichStatus, setEnrichStatus] = useState('')

  const reportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!canView) return
    const fetchLists = async () => {
      const { data: c } = await supabase.from('clients').select('id, name').order('name')
      const { data: g } = await supabase.from('games').select('id, name, client_id').order('name')
      if (c) setClients(c)
      if (g) setGames(g)
    }
    fetchLists()
  }, [canView, supabase])

  const filteredGames = selectedClient
    ? games.filter(g => g.client_id === selectedClient)
    : games

  const fetchCoverage = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (selectedClient) params.set('client_id', selectedClient)
    if (selectedGame) params.set('game_id', selectedGame)
    if (dateFrom) params.set('date_from', dateFrom)
    if (dateTo) params.set('date_to', dateTo)

    try {
      const res = await fetch(`/api/coverage-export?${params}`)
      const json = await res.json()
      if (res.ok) {
        setItems(json.items || [])
        setLoaded(true)
      }
    } catch (err) {
      console.error('Failed to fetch campaign coverage:', err)
    }
    setLoading(false)
  }, [selectedClient, selectedGame, dateFrom, dateTo])

  // Batch enrich outlets missing traffic data via HypeStat
  const handleEnrichTraffic = async () => {
    // Find outlets missing MUV data
    const outletsMissingTraffic = new Map<string, string>()
    for (const item of items) {
      if (item.outlet?.id && !item.outlet.monthly_unique_visitors && item.display_domain) {
        outletsMissingTraffic.set(item.outlet.id, item.display_domain)
      }
    }

    if (outletsMissingTraffic.size === 0) {
      setEnrichStatus('All outlets already have traffic data.')
      setTimeout(() => setEnrichStatus(''), 3000)
      return
    }

    setEnriching(true)
    setEnrichStatus(`Enriching ${outletsMissingTraffic.size} outlets via HypeStat...`)

    let enriched = 0
    let failed = 0

    for (const [outletId, domain] of Array.from(outletsMissingTraffic.entries())) {
      try {
        const res = await fetch('/api/hypestat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ outlet_id: outletId, domain })
        })
        const result = await res.json()
        if (result.monthly_unique_visitors) {
          enriched++
        } else {
          failed++
        }
      } catch {
        failed++
      }
      setEnrichStatus(`Enriching outlets... ${enriched + failed}/${outletsMissingTraffic.size}`)
    }

    setEnriching(false)
    setEnrichStatus(`Done: ${enriched} enriched, ${failed} no data found.`)

    // Reload data to show updated MUV
    if (enriched > 0) {
      await fetchCoverage()
    }

    setTimeout(() => setEnrichStatus(''), 5000)
  }

  const clientName = clients.find(c => c.id === selectedClient)?.name || 'All Clients'
  const gameName = games.find(g => g.id === selectedGame)?.name || 'All Games'
  const dateLabel = dateFrom && dateTo
    ? `${dateFrom} to ${dateTo}`
    : dateFrom
      ? `From ${dateFrom}`
      : dateTo
        ? `Until ${dateTo}`
        : 'All dates'

  // Count how many outlets are missing traffic data
  const missingTrafficCount = items.filter(item => !item.display_visitors && item.display_domain).length

  const handleExcelExport = () => {
    const rows = items.map(item => ({
      'Date': formatDateEU(item.display_date),
      'Territory': item.territory || '-',
      'Outlet': item.outlet_display_name || 'Unknown',
      'Tier': item.outlet?.tier || '-',
      'Type': item.coverage_type || '-',
      'Title': item.title,
      'URL': item.url,
      'Monthly Unique Visitors': item.display_visitors || '',
    }))

    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.json_to_sheet(rows)
    ws['!cols'] = [
      { wch: 12 },  // Date
      { wch: 18 },  // Territory
      { wch: 25 },  // Outlet
      { wch: 6 },   // Tier
      { wch: 12 },  // Type
      { wch: 50 },  // Title
      { wch: 60 },  // URL
      { wch: 22 },  // Monthly Unique Visitors
    ]
    XLSX.utils.book_append_sheet(wb, ws, 'Campaign Coverage')
    XLSX.writeFile(wb, `campaign-report-${clientName.replace(/\s+/g, '-').toLowerCase()}-${dateFrom || 'all'}.xlsx`)
  }

  // CSV export matching Bram's exact PR Report format
  const handleCSVExport = () => {
    const gameLbl = games.find(g => g.id === selectedGame)?.name || gameName
    const titleRow = `${gameLbl}`

    const header = 'Date,Territory,Outlet Name,Type of Media,Link,Unique Monthly Visitors / Followers / Subscribers'

    const dataRows = items.map(item => {
      const date = formatDateEU(item.display_date)
      const territory = (item.territory || '').replace(/,/g, '')
      const outlet = (item.outlet_display_name || 'Unknown').replace(/,/g, '')
      const type = (item.coverage_type || '-').replace(/,/g, '')
      const url = item.url
      const visitors = item.display_visitors ? item.display_visitors.toLocaleString('en-US') : ''
      return `${date},${territory},${outlet},${type},${url},${visitors}`
    })

    const csv = [titleRow, header, ...dataRows].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `PR Report ${clientName} - ${gameLbl}.csv`
    link.click()
    URL.revokeObjectURL(link.href)
  }

  const handlePDFExport = () => {
    const printWindow = window.open('', '_blank')
    if (!printWindow) return

    const tableRows = items.map(item => `
      <tr>
        <td>${formatDateEU(item.display_date)}</td>
        <td>${item.territory || '-'}</td>
        <td>${item.outlet_display_name || 'Unknown'}</td>
        <td>${item.outlet?.tier || '-'}</td>
        <td>${item.coverage_type || '-'}</td>
        <td><a href="${item.url}" target="_blank">${item.url}</a></td>
        <td style="text-align:right">${formatVisitors(item.display_visitors)}</td>
      </tr>
    `).join('')

    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Campaign Report — ${gameName}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 40px; color: #1e293b; }
          h1 { font-size: 22px; margin: 0 0 4px; }
          .meta { font-size: 13px; color: #64748b; margin-bottom: 24px; }
          .count { font-size: 14px; font-weight: 600; margin-bottom: 16px; }
          table { width: 100%; border-collapse: collapse; font-size: 11px; }
          th { text-align: left; padding: 8px 10px; background: #f8fafc; border-bottom: 2px solid #e2e8f0; font-weight: 600; color: #475569; }
          td { padding: 8px 10px; border-bottom: 1px solid #f1f5f9; }
          a { color: #3b82f6; text-decoration: none; word-break: break-all; }
          @media print {
            body { margin: 20px; }
            a { color: #1e293b; }
            @page { margin: 1cm; }
          }
        </style>
      </head>
      <body>
        <h1>Campaign Coverage Report</h1>
        <div class="meta">${clientName} — ${gameName} | ${dateLabel}</div>
        <div class="count">${items.length} coverage item${items.length !== 1 ? 's' : ''}</div>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Territory</th>
              <th>Outlet</th>
              <th>Tier</th>
              <th>Type</th>
              <th>URL</th>
              <th style="text-align:right">Monthly Visitors</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
      </body>
      </html>
    `)
    printWindow.document.close()
    setTimeout(() => printWindow.print(), 500)
  }

  if (authLoading) return null

  if (!canView) {
    return (
      <div style={{ display: 'flex', minHeight: '100vh' }}>
        <Sidebar />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ color: '#94a3b8' }}>You do not have access to PR Coverage.</p>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar />
      <div style={{ flex: 1, overflow: 'auto' }}>
        <div className={styles.container}>
          {/* Top nav */}
          <div style={{ display: 'flex', gap: '0', marginBottom: '24px', borderBottom: '2px solid #e2e8f0', flexWrap: 'wrap' }}>
            <Link href="/coverage" style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 500, color: '#64748b', textDecoration: 'none', marginBottom: '-2px' }}>Outlets</Link>
            <Link href="/coverage/keywords" style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 500, color: '#64748b', textDecoration: 'none', marginBottom: '-2px' }}>Keywords</Link>
            <Link href="/coverage/settings" style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 500, color: '#64748b', textDecoration: 'none', marginBottom: '-2px' }}>API Keys</Link>
            <Link href="/coverage/sources" style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 500, color: '#64748b', textDecoration: 'none', marginBottom: '-2px' }}>Sources</Link>
            <Link href="/coverage/feed" style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 500, color: '#64748b', textDecoration: 'none', marginBottom: '-2px' }}>Feed</Link>
            <Link href="/coverage/dashboard" style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 500, color: '#64748b', textDecoration: 'none', marginBottom: '-2px' }}>Dashboard</Link>
            <Link href="/coverage/timeline" style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 500, color: '#64748b', textDecoration: 'none', marginBottom: '-2px' }}>Timeline</Link>
            <Link href="/coverage/report" style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 500, color: '#64748b', textDecoration: 'none', marginBottom: '-2px' }}>Export</Link>
            <div style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 600, color: '#2563eb', borderBottom: '2px solid #2563eb', marginBottom: '-2px' }}>Campaign Report</div>
            <Link href="/coverage/guide" style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 500, color: '#64748b', textDecoration: 'none', marginBottom: '-2px' }}>Guide</Link>
          </div>

          <div className={styles.header}>
            <h1 className={styles.title}>Campaign Coverage Report</h1>
            <p className={styles.subtitle}>
              Generate a clean outlet + link list for a specific campaign period.
            </p>
          </div>

          {/* Filters */}
          <div className={styles.filters}>
            <div className={styles.filterGroup}>
              <label className={styles.filterLabel}>Client</label>
              <select
                className={styles.select}
                value={selectedClient}
                onChange={e => { setSelectedClient(e.target.value); setSelectedGame(''); setLoaded(false) }}
              >
                <option value="">All Clients</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className={styles.filterGroup}>
              <label className={styles.filterLabel}>Game</label>
              <select
                className={styles.select}
                value={selectedGame}
                onChange={e => { setSelectedGame(e.target.value); setLoaded(false) }}
              >
                <option value="">All Games</option>
                {filteredGames.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
            <div className={styles.filterGroup}>
              <label className={styles.filterLabel}>From</label>
              <input
                type="date"
                className={styles.dateInput}
                value={dateFrom}
                onChange={e => { setDateFrom(e.target.value); setLoaded(false) }}
              />
            </div>
            <div className={styles.filterGroup}>
              <label className={styles.filterLabel}>To</label>
              <input
                type="date"
                className={styles.dateInput}
                value={dateTo}
                onChange={e => { setDateTo(e.target.value); setLoaded(false) }}
              />
            </div>
            <button className={styles.generateBtn} onClick={fetchCoverage} disabled={loading}>
              {loading ? 'Loading...' : 'Generate'}
            </button>
          </div>

          {/* Results */}
          {loaded && (
            <div ref={reportRef}>
              <div className={styles.resultHeader}>
                <div className={styles.resultCount}>
                  {items.length} coverage item{items.length !== 1 ? 's' : ''}
                  {missingTrafficCount > 0 && (
                    <span style={{ color: '#f59e0b', fontSize: '12px', marginLeft: '12px' }}>
                      ({missingTrafficCount} missing traffic data)
                    </span>
                  )}
                </div>
                {items.length > 0 && (
                  <div className={styles.exportBtns}>
                    {missingTrafficCount > 0 && (
                      <button
                        className={styles.enrichBtn}
                        onClick={handleEnrichTraffic}
                        disabled={enriching}
                        title="Fetch monthly visitors from HypeStat for outlets missing traffic data"
                      >
                        {enriching ? 'Enriching...' : `Enrich Traffic (${missingTrafficCount})`}
                      </button>
                    )}
                    <button className={styles.excelBtn} onClick={handleExcelExport}>Export Excel</button>
                    <button className={styles.csvBtn} onClick={handleCSVExport}>Export CSV (PR Report)</button>
                    <button className={styles.pdfBtn} onClick={handlePDFExport}>Export PDF</button>
                  </div>
                )}
              </div>

              {enrichStatus && (
                <div style={{ padding: '8px 12px', marginBottom: '12px', fontSize: '13px', color: '#475569', background: '#f0f9ff', borderRadius: '6px', border: '1px solid #bae6fd' }}>
                  {enrichStatus}
                </div>
              )}

              {items.length === 0 ? (
                <div className={styles.empty}>
                  No approved coverage found for this selection. Try adjusting the date range or filters.
                </div>
              ) : (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Territory</th>
                      <th>Outlet</th>
                      <th>Tier</th>
                      <th>Type</th>
                      <th>Title</th>
                      <th>Link</th>
                      <th style={{ textAlign: 'right' }}>Monthly Visitors</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map(item => (
                      <tr key={item.id}>
                        <td className={styles.dateCell}>{formatDateEU(item.display_date)}</td>
                        <td className={styles.territoryCell}>{item.territory || '-'}</td>
                        <td className={styles.outletCell}>{item.outlet_display_name || 'Unknown'}</td>
                        <td>
                          {item.outlet?.tier ? (
                            <span className={`${styles.tierBadge} ${styles['tier' + item.outlet.tier]}`}>
                              {item.outlet.tier}
                            </span>
                          ) : '-'}
                        </td>
                        <td className={styles.typeCell}>{item.coverage_type || '-'}</td>
                        <td className={styles.titleCell}>{item.title}</td>
                        <td className={styles.linkCell}>
                          <a href={item.url} target="_blank" rel="noopener noreferrer">{item.url}</a>
                        </td>
                        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                          {formatVisitors(item.display_visitors)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
