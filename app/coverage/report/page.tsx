'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import { Sidebar } from '../../components/Sidebar'
import { useAuth } from '@/lib/auth-context'
import Link from 'next/link'
import * as XLSX from 'xlsx'

interface CoverageItem {
  id: string
  title: string
  url: string
  publish_date: string | null
  territory: string | null
  coverage_type: string | null
  monthly_unique_visitors: number | null
  review_score: number | null
  quotes: string | null
  sentiment: string | null
  campaign_section: string | null
  outlet: { id: string; name: string; domain: string | null; tier: string | null; monthly_unique_visitors: number | null; country: string | null } | null
  game: { id: string; name: string } | null
  client: { id: string; name: string } | null
  campaign: { id: string; name: string } | null
}

interface ExportSummary {
  total_pieces: number
  total_audience_reach: number
  estimated_views: number
  avg_review_score: number | null
  review_count: number
  tier_breakdown: Record<string, number>
  type_breakdown: Record<string, number>
  territory_breakdown: Record<string, number>
  reach_by_tier: Record<string, number>
  review_distribution: {
    count: number
    avg: number | null
    min: number | null
    max: number | null
    ranges: Record<string, number>
  }
  ave_estimate: { total: number; by_tier: Record<string, number> }
  youtube_metrics: { total_videos: number; total_views: number; total_likes: number; total_comments: number }
  sentiment_summary: { counts: Record<string, number>; top_quotes: Array<{ quote: string; outlet: string; sentiment: string }> }
  data_quality: {
    missing_outlet: number
    missing_territory: number
    missing_sentiment: number
    missing_publish_date: number
    untiered_outlets: number
    outlets_without_traffic: number
    total_items: number
    completeness_pct: number
  }
}

interface Campaign {
  id: string
  name: string
  start_date: string | null
  end_date: string | null
}

function formatNumber(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return n.toLocaleString()
}

function formatFullNumber(n: number | null | undefined): string {
  if (n == null) return ''
  return n.toLocaleString()
}

const TIER_COLORS: Record<string, { bg: string; text: string }> = {
  A: { bg: '#dcfce7', text: '#166534' },
  B: { bg: '#dbeafe', text: '#1e40af' },
  C: { bg: '#fef9c3', text: '#854d0e' },
  D: { bg: '#f3f4f6', text: '#374151' }
}

export default function CoverageReportPage() {
  const supabase = createClientComponentClient()
  const { hasAccess, loading: authLoading } = useAuth()
  const canView = hasAccess('pr_coverage', 'view')

  // Filter state
  const [clients, setClients] = useState<{ id: string; name: string }[]>([])
  const [games, setGames] = useState<{ id: string; name: string; client_id: string; slug: string | null; public_feed_enabled: boolean | null; public_feed_password: string | null }[]>([])
  const [selectedClient, setSelectedClient] = useState('')
  const [selectedGame, setSelectedGame] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [datePreset, setDatePreset] = useState('all')
  const [includeAllStatus, setIncludeAllStatus] = useState(false)

  // Data state
  const [items, setItems] = useState<CoverageItem[]>([])
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [summary, setSummary] = useState<ExportSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)

  // Export state
  const [exporting, setExporting] = useState(false)

  // Live feed link state
  const [feedLinkLoading, setFeedLinkLoading] = useState(false)
  const [feedLink, setFeedLink] = useState<string | null>(null)
  const [feedLinkCopied, setFeedLinkCopied] = useState(false)

  // PDF ref
  const reportRef = useRef<HTMLDivElement>(null)

  // Fetch clients and games on mount
  useEffect(() => {
    if (!canView) return
    const fetchLists = async () => {
      const { data: c } = await supabase.from('clients').select('id, name').order('name')
      const { data: g } = await supabase.from('games').select('id, name, client_id, slug, public_feed_enabled, public_feed_password').order('name')
      if (c) setClients(c)
      if (g) setGames(g)
    }
    fetchLists()
  }, [canView, supabase])

  // Apply date preset
  const applyDatePreset = (preset: string) => {
    setDatePreset(preset)
    const now = new Date()
    switch (preset) {
      case 'last_30':
        setDateFrom(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30).toISOString().split('T')[0])
        setDateTo(now.toISOString().split('T')[0])
        break
      case 'last_90':
        setDateFrom(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 90).toISOString().split('T')[0])
        setDateTo(now.toISOString().split('T')[0])
        break
      case 'this_month':
        setDateFrom(new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0])
        setDateTo(now.toISOString().split('T')[0])
        break
      case 'last_month': {
        const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
        setDateFrom(lastMonth.toISOString().split('T')[0])
        setDateTo(new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split('T')[0])
        break
      }
      case 'this_quarter': {
        const qStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1)
        setDateFrom(qStart.toISOString().split('T')[0])
        setDateTo(now.toISOString().split('T')[0])
        break
      }
      case 'ytd':
        setDateFrom(new Date(now.getFullYear(), 0, 1).toISOString().split('T')[0])
        setDateTo(now.toISOString().split('T')[0])
        break
      default:
        setDateFrom('')
        setDateTo('')
    }
  }

  const fetchReport = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (selectedClient) params.set('client_id', selectedClient)
    if (selectedGame) params.set('game_id', selectedGame)
    if (dateFrom) params.set('date_from', dateFrom)
    if (dateTo) params.set('date_to', dateTo)
    if (includeAllStatus) params.set('approval_status', 'all')

    try {
      const res = await fetch(`/api/coverage-export?${params}`)
      const json = await res.json()
      if (res.ok) {
        setItems(json.items || [])
        setCampaigns(json.campaigns || [])
        setSummary(json.summary || null)
        setLoaded(true)
      }
    } catch (err) {
      console.error('Failed to fetch report data:', err)
    }
    setLoading(false)
  }, [selectedClient, selectedGame, dateFrom, dateTo, includeAllStatus])

  // Group items by campaign section
  const groupedItems = (() => {
    const groups: Record<string, CoverageItem[]> = {}
    for (const item of items) {
      const section = item.campaign_section || item.campaign?.name || 'General Coverage'
      if (!groups[section]) groups[section] = []
      groups[section].push(item)
    }
    // Sort sections, with General Coverage last
    const sortedKeys = Object.keys(groups).sort((a, b) => {
      if (a === 'General Coverage') return 1
      if (b === 'General Coverage') return -1
      return a.localeCompare(b)
    })
    return sortedKeys.map(key => ({ section: key, items: groups[key] }))
  })()

  // Format date as DD.MM.YYYY (European/Dutch format)
  function formatDateEU(dateStr: string | null): string {
    if (!dateStr) return ''
    const d = new Date(dateStr + 'T00:00:00')
    if (isNaN(d.getTime())) return dateStr
    const day = String(d.getDate()).padStart(2, '0')
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const year = d.getFullYear()
    return `${day}.${month}.${year}`
  }

  // Get visitors value for an item (prefer outlet, fallback to item)
  function getVisitors(item: CoverageItem): number {
    return item.outlet?.monthly_unique_visitors || item.monthly_unique_visitors || 0
  }

  // Excel export — Full report with summary + grouped coverage
  const handleExcelExport = () => {
    setExporting(true)
    try {
      const wb = XLSX.utils.book_new()

      // Summary sheet
      const summaryData = [
        ['PR Coverage Report'],
        [],
        ['Client', selectedClient ? clients.find(c => c.id === selectedClient)?.name || '' : 'All Clients'],
        ['Game', selectedGame ? games.find(g => g.id === selectedGame)?.name || '' : 'All Games'],
        ['Date Range', dateFrom && dateTo ? `${formatDateEU(dateFrom)} - ${formatDateEU(dateTo)}` : dateFrom ? `From ${formatDateEU(dateFrom)}` : dateTo ? `Until ${formatDateEU(dateTo)}` : 'All Time'],
        ['Generated', formatDateEU(new Date().toISOString().split('T')[0])],
        [],
        ['Summary Statistics'],
        ['Total Pieces of Coverage', summary?.total_pieces || 0],
        ['Total Audience Reach', summary?.total_audience_reach || 0],
        ['Estimated Views', summary?.estimated_views || 0],
        ['Average Review Score', summary?.avg_review_score ? summary.avg_review_score.toFixed(1) : 'N/A'],
        ['Reviews Counted', summary?.review_count || 0],
        [],
        ['Tier Breakdown'],
        ['Tier A (10M+ visitors)', summary?.tier_breakdown?.A || 0],
        ['Tier B (1M-10M visitors)', summary?.tier_breakdown?.B || 0],
        ['Tier C (100K-1M visitors)', summary?.tier_breakdown?.C || 0],
        ['Tier D (<100K visitors)', summary?.tier_breakdown?.D || 0],
        ['Untiered', summary?.tier_breakdown?.untiered || 0],
        [],
        ['Coverage Type Breakdown'],
        ...Object.entries(summary?.type_breakdown || {}).map(([type, count]) => [type, count]),
        [],
        ['Reach by Tier'],
        ...Object.entries(summary?.reach_by_tier || {}).filter(([, v]) => v > 0).map(([tier, reach]) => [
          tier === 'untiered' ? 'Untiered' : `Tier ${tier}`,
          reach,
          summary?.total_audience_reach ? `${Math.round((reach as number / summary.total_audience_reach) * 100)}%` : ''
        ]),
        [],
        ['Review Score Distribution'],
        ['Reviews Count', summary?.review_distribution?.count || 0],
        ['Average', summary?.review_distribution?.avg?.toFixed(1) || 'N/A'],
        ['Highest', summary?.review_distribution?.max || 'N/A'],
        ['Lowest', summary?.review_distribution?.min || 'N/A'],
        ...Object.entries(summary?.review_distribution?.ranges || {}).filter(([, v]) => v > 0).map(([range, count]) => [
          range === 'below_60' ? 'Below 60' : range, count
        ]),
        [],
        ['Estimated Media Value (AVE)'],
        ['Total AVE', `€${(summary?.ave_estimate?.total || 0).toLocaleString()}`],
        ...Object.entries(summary?.ave_estimate?.by_tier || {}).filter(([, v]) => v > 0).map(([tier, ave]) => [
          tier === 'untiered' ? 'Untiered' : `Tier ${tier}`, `€${(ave as number).toLocaleString()}`
        ]),
        [],
        ['Sentiment Analysis'],
        ...Object.entries(summary?.sentiment_summary?.counts || {}).filter(([, v]) => v > 0).map(([s, count]) => [s, count]),
        [],
        ['Data Quality'],
        ['Completeness', `${summary?.data_quality?.completeness_pct || 0}%`],
        ['Missing Outlet', summary?.data_quality?.missing_outlet || 0],
        ['Missing Territory', summary?.data_quality?.missing_territory || 0],
        ['Missing Sentiment', summary?.data_quality?.missing_sentiment || 0],
        ['Missing Publish Date', summary?.data_quality?.missing_publish_date || 0],
      ]
      const summaryWs = XLSX.utils.aoa_to_sheet(summaryData)
      summaryWs['!cols'] = [{ wch: 30 }, { wch: 20 }]
      XLSX.utils.book_append_sheet(wb, summaryWs, 'Summary')

      // Coverage items sheet — sorted by visitors desc within each campaign group
      const headerRow = ['Date', 'Territory', 'Media Outlet', 'Tier', 'Type', 'Title', 'URL', 'Monthly Unique Visitors', 'Review Score', 'Quotes/Notes', 'Campaign Section']
      const rows: unknown[][] = [headerRow]

      for (const group of groupedItems) {
        rows.push([])
        rows.push([group.section, '', '', '', '', '', '', '', '', '', ''])

        // Sort within group by visitors descending
        const sorted = [...group.items].sort((a, b) => getVisitors(b) - getVisitors(a))

        for (const item of sorted) {
          rows.push([
            formatDateEU(item.publish_date),
            item.territory || item.outlet?.country || '',
            item.outlet?.name || '',
            item.outlet?.tier || '',
            item.coverage_type || '',
            item.title,
            item.url,
            getVisitors(item) || '',
            item.review_score || '',
            item.quotes || '',
            item.campaign_section || item.campaign?.name || ''
          ])
        }
      }

      const itemsWs = XLSX.utils.aoa_to_sheet(rows)
      itemsWs['!cols'] = [
        { wch: 12 }, // Date
        { wch: 12 }, // Territory
        { wch: 25 }, // Outlet
        { wch: 6 },  // Tier
        { wch: 10 }, // Type
        { wch: 50 }, // Title
        { wch: 40 }, // URL
        { wch: 20 }, // Visitors
        { wch: 12 }, // Score
        { wch: 40 }, // Notes
        { wch: 20 }, // Section
      ]
      XLSX.utils.book_append_sheet(wb, itemsWs, 'Coverage')

      const clientName = selectedClient ? clients.find(c => c.id === selectedClient)?.name || 'coverage' : 'all-clients'
      const fileName = `coverage-report-${clientName.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().split('T')[0]}.xlsx`
      XLSX.writeFile(wb, fileName)
    } catch (err) {
      console.error('Excel export failed:', err)
    }
    setExporting(false)
  }

  // CSV export — Exact match of Bram's PR report spreadsheet format
  const handleCSVExport = () => {
    setExporting(true)
    try {
      // Sort all items by visitors descending (flat, no grouping)
      const sorted = [...items].sort((a, b) => getVisitors(b) - getVisitors(a))

      // Build title row: "Game Name - Campaign Name" or "Game Name" or "PR Report"
      const gameName = selectedGame ? games.find(g => g.id === selectedGame)?.name || '' : ''
      const campaignName = campaigns.length === 1 ? campaigns[0].name : ''
      const titleText = gameName && campaignName ? `${gameName} - ${campaignName}` : gameName || 'PR Report'

      // Bram's exact column structure
      const csvRows: string[] = [
        // Title row with empty trailing columns
        `"${titleText.replace(/"/g, '""')}",,,,,`,
        // Header row matching Bram's exact column names
        'Date,Territory,Outlet Name,Type of Media,Link,Unique Monthly Visitors / Followers / Subscribers'
      ]

      for (const item of sorted) {
        const visitors = getVisitors(item)
        // Format visitors with commas (English style like Bram's "65,402,710") or "N/A"
        const visitorsStr = visitors ? `"${visitors.toLocaleString('en-US')}"` : 'N/A'
        const row = [
          formatDateEU(item.publish_date),
          item.territory || item.outlet?.country || '',
          `"${(item.outlet?.name || '').replace(/"/g, '""')}"`,
          item.coverage_type || '',
          `"${(item.url || '').replace(/"/g, '""')}"`,
          visitorsStr
        ]
        csvRows.push(row.join(','))
      }

      const csvContent = csvRows.join('\n')
      const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')

      // Filename: "PR Report {Game Series} - {Game} - {Campaign}.csv" matching Bram's naming
      const clientName = selectedClient ? clients.find(c => c.id === selectedClient)?.name || '' : ''
      const fileTitle = [clientName, gameName, campaignName].filter(Boolean).join(' - ') || 'PR Report'
      link.href = url
      link.download = `PR Report ${fileTitle}.csv`
      link.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('CSV export failed:', err)
    }
    setExporting(false)
  }

  // PDF export via browser print
  const handlePDFExport = () => {
    if (!reportRef.current) return
    const printWindow = window.open('', '_blank')
    if (!printWindow) return

    const clientName = selectedClient ? clients.find(c => c.id === selectedClient)?.name || '' : 'All Clients'
    const gameName = selectedGame ? games.find(g => g.id === selectedGame)?.name || '' : ''
    const dateRange = dateFrom && dateTo ? `${dateFrom} to ${dateTo}` : dateFrom || dateTo || 'All Time'

    printWindow.document.write(`<!DOCTYPE html>
<html>
<head>
<title>Coverage Report - ${clientName}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1e293b; font-size: 11px; }
  .page { padding: 40px; max-width: 1100px; margin: 0 auto; }
  .header { text-align: center; margin-bottom: 30px; padding-bottom: 20px; border-bottom: 3px solid #2563eb; }
  .header h1 { font-size: 24px; color: #1e293b; margin-bottom: 4px; }
  .header .subtitle { font-size: 14px; color: #64748b; }
  .header .meta { font-size: 11px; color: #94a3b8; margin-top: 8px; }
  .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .stat-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; text-align: center; }
  .stat-value { font-size: 22px; font-weight: 700; color: #1e293b; }
  .stat-label { font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
  .section-title { font-size: 16px; font-weight: 700; color: #1e293b; margin: 24px 0 12px 0; padding-bottom: 6px; border-bottom: 2px solid #e2e8f0; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 10px; }
  th { background: #f1f5f9; padding: 8px 10px; text-align: left; font-weight: 600; color: #475569; border-bottom: 2px solid #e2e8f0; }
  td { padding: 6px 10px; border-bottom: 1px solid #f1f5f9; }
  tr:nth-child(even) { background: #fafbfc; }
  .tier-badge { display: inline-block; padding: 1px 8px; border-radius: 99px; font-size: 9px; font-weight: 600; }
  .tier-A { background: #dcfce7; color: #166534; }
  .tier-B { background: #dbeafe; color: #1e40af; }
  .tier-C { background: #fef9c3; color: #854d0e; }
  .tier-D { background: #f3f4f6; color: #374151; }
  .breakdown-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
  .breakdown-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; }
  .breakdown-title { font-size: 12px; font-weight: 600; color: #475569; margin-bottom: 8px; }
  .breakdown-item { display: flex; justify-content: space-between; padding: 3px 0; font-size: 11px; }
  .breakdown-value { font-weight: 600; }
  .footer { text-align: center; color: #94a3b8; font-size: 10px; margin-top: 30px; padding-top: 16px; border-top: 1px solid #e2e8f0; }
  .section-header { background: #f1f5f9; padding: 8px 12px; font-weight: 700; font-size: 13px; color: #1e293b; margin-top: 20px; border-radius: 6px; }
  @media print {
    .page { padding: 20px; }
    .section-header { break-inside: avoid; }
    table { break-inside: auto; }
    tr { break-inside: avoid; }
  }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <h1>PR Coverage Report</h1>
    <div class="subtitle">${clientName}${gameName ? ` — ${gameName}` : ''}</div>
    <div class="meta">${dateRange} | Generated ${new Date().toLocaleDateString()}</div>
  </div>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-value">${summary?.total_pieces || 0}</div>
      <div class="stat-label">Total Pieces</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${formatNumber(summary?.total_audience_reach)}</div>
      <div class="stat-label">Audience Reach</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${formatNumber(summary?.estimated_views)}</div>
      <div class="stat-label">Est. Views</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${summary?.avg_review_score ? summary.avg_review_score.toFixed(1) : 'N/A'}</div>
      <div class="stat-label">Avg Review (${summary?.review_count || 0})</div>
    </div>
  </div>

  <div class="breakdown-grid">
    <div class="breakdown-card">
      <div class="breakdown-title">Tier Breakdown</div>
      ${Object.entries(summary?.tier_breakdown || {}).filter(([, v]) => v > 0).map(([tier, count]) =>
        `<div class="breakdown-item"><span>Tier ${tier}</span><span class="breakdown-value">${count}</span></div>`
      ).join('')}
    </div>
    <div class="breakdown-card">
      <div class="breakdown-title">Coverage Type</div>
      ${Object.entries(summary?.type_breakdown || {}).sort((a, b) => b[1] - a[1]).map(([type, count]) =>
        `<div class="breakdown-item"><span>${type}</span><span class="breakdown-value">${count}</span></div>`
      ).join('')}
    </div>
  </div>

  <div class="breakdown-grid">
    <div class="breakdown-card">
      <div class="breakdown-title">Estimated Media Value (AVE)</div>
      <div style="font-size:20px;font-weight:700;color:#16a34a;margin-bottom:8px">€${(summary?.ave_estimate?.total || 0).toLocaleString()}</div>
      ${Object.entries(summary?.ave_estimate?.by_tier || {}).filter(([, v]) => v > 0).map(([tier, ave]) =>
        `<div class="breakdown-item"><span>${tier === 'untiered' ? 'Untiered' : 'Tier ' + tier}</span><span class="breakdown-value">€${(ave as number).toLocaleString()}</span></div>`
      ).join('')}
    </div>
    <div class="breakdown-card">
      <div class="breakdown-title">Sentiment Analysis</div>
      ${Object.entries(summary?.sentiment_summary?.counts || {}).filter(([, v]) => v > 0).map(([s, count]) =>
        `<div class="breakdown-item"><span style="text-transform:capitalize">${s}</span><span class="breakdown-value">${count}</span></div>`
      ).join('')}
    </div>
  </div>

  ${summary?.review_distribution && summary.review_distribution.count > 0 ? `
  <div class="breakdown-grid">
    <div class="breakdown-card">
      <div class="breakdown-title">Review Scores</div>
      <div class="breakdown-item"><span>Count</span><span class="breakdown-value">${summary.review_distribution.count}</span></div>
      <div class="breakdown-item"><span>Average</span><span class="breakdown-value">${summary.review_distribution.avg?.toFixed(1) ?? '—'}</span></div>
      <div class="breakdown-item"><span>Highest</span><span class="breakdown-value">${summary.review_distribution.max ?? '—'}</span></div>
      <div class="breakdown-item"><span>Lowest</span><span class="breakdown-value">${summary.review_distribution.min ?? '—'}</span></div>
    </div>
    <div class="breakdown-card">
      <div class="breakdown-title">Data Quality — ${summary?.data_quality?.completeness_pct || 0}% Complete</div>
      ${[
        { label: 'Missing outlet', value: summary?.data_quality?.missing_outlet || 0 },
        { label: 'Missing territory', value: summary?.data_quality?.missing_territory || 0 },
        { label: 'Missing sentiment', value: summary?.data_quality?.missing_sentiment || 0 },
        { label: 'Missing date', value: summary?.data_quality?.missing_publish_date || 0 },
      ].filter(f => f.value > 0).map(f =>
        `<div class="breakdown-item"><span>${f.label}</span><span class="breakdown-value">${f.value}</span></div>`
      ).join('')}
    </div>
  </div>
  ` : ''}

  ${groupedItems.map(group => `
    <div class="section-header">${group.section} (${group.items.length})</div>
    <table>
      <thead>
        <tr>
          <th style="width:70px">Date</th>
          <th style="width:60px">Territory</th>
          <th>Media Outlet</th>
          <th style="width:40px">Tier</th>
          <th style="width:60px">Type</th>
          <th>Title</th>
          <th style="width:90px">Monthly Visitors</th>
          ${group.items.some(i => i.review_score) ? '<th style="width:50px">Score</th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${group.items.map(item => `
          <tr>
            <td>${item.publish_date || '—'}</td>
            <td>${item.territory || item.outlet?.country || '—'}</td>
            <td>${item.outlet?.name || '—'}</td>
            <td>${item.outlet?.tier ? `<span class="tier-badge tier-${item.outlet.tier}">${item.outlet.tier}</span>` : '—'}</td>
            <td>${item.coverage_type || '—'}</td>
            <td>${item.url ? `<a href="${item.url}" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:none">${item.title}</a>` : item.title}</td>
            <td style="text-align:right">${formatFullNumber(item.outlet?.monthly_unique_visitors || item.monthly_unique_visitors)}</td>
            ${group.items.some(i => i.review_score) ? `<td style="text-align:center">${item.review_score || '—'}</td>` : ''}
          </tr>
        `).join('')}
      </tbody>
    </table>
  `).join('')}

  <div class="footer">
    Generated by GameDrive Coverage Tracker | ${new Date().toLocaleDateString()} | gamedrive.nl
  </div>
</div>
</body>
</html>`)
    printWindow.document.close()
    setTimeout(() => { printWindow.print() }, 500)
  }

  // Generate live feed link
  const handleGenerateFeedLink = async () => {
    if (!selectedGame) return
    setFeedLinkLoading(true)
    setFeedLink(null)
    setFeedLinkCopied(false)

    try {
      const game = games.find(g => g.id === selectedGame)
      if (!game) throw new Error('Game not found')

      let slug = game.slug

      // Auto-generate slug if not set
      if (!slug) {
        slug = game.name
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, '')
          .replace(/\s+/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '')
        if (!slug) slug = game.id.slice(0, 8)
      }

      // Enable public feed if not already
      if (!game.public_feed_enabled || game.slug !== slug) {
        const { error } = await supabase
          .from('games')
          .update({
            slug,
            public_feed_enabled: true,
            updated_at: new Date().toISOString()
          })
          .eq('id', game.id)

        if (error) throw error

        // Update local state
        setGames(prev => prev.map(g =>
          g.id === game.id ? { ...g, slug, public_feed_enabled: true } : g
        ))
      }

      // Build the feed URL with date params if set
      const baseUrl = `${window.location.origin}/feed/${slug}`
      const params = new URLSearchParams()
      if (dateFrom) params.set('date_from', dateFrom)
      if (dateTo) params.set('date_to', dateTo)
      const fullUrl = params.toString() ? `${baseUrl}?${params}` : baseUrl

      setFeedLink(fullUrl)
    } catch (err) {
      console.error('Failed to generate feed link:', err)
      alert('Failed to generate feed link. Please try again.')
    }
    setFeedLinkLoading(false)
  }

  const handleCopyFeedLink = async () => {
    if (!feedLink) return
    try {
      await navigator.clipboard.writeText(feedLink)
      setFeedLinkCopied(true)
      setTimeout(() => setFeedLinkCopied(false), 2000)
    } catch {
      // Fallback for clipboard API failure
      const input = document.createElement('input')
      input.value = feedLink
      document.body.appendChild(input)
      input.select()
      document.execCommand('copy')
      document.body.removeChild(input)
      setFeedLinkCopied(true)
      setTimeout(() => setFeedLinkCopied(false), 2000)
    }
  }

  const filteredGames = selectedClient
    ? games.filter(g => g.client_id === selectedClient)
    : games

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

  return (
    <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
      <Sidebar />

      <div style={{ flex: 1, padding: '32px', overflow: 'auto' }}>
        <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
            <div>
              <h1 style={{ fontSize: '28px', fontWeight: 700, color: '#1e293b', margin: 0 }}>PR Coverage</h1>
              <p style={{ fontSize: '14px', color: '#64748b', margin: '4px 0 0 0' }}>
                Generate client-ready coverage reports
              </p>
            </div>
          </div>

          {/* Sub-navigation tabs */}
          <div style={{ display: 'flex', gap: '0', marginBottom: '24px', borderBottom: '2px solid #e2e8f0' }}>
            <Link href="/coverage" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              Outlets
            </Link>
            <Link href="/coverage/keywords" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              Keywords
            </Link>
            <Link href="/coverage/settings" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              API Keys
            </Link>
            <Link href="/coverage/sources" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              Sources
            </Link>
            <Link href="/coverage/feed" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              Feed
            </Link>
            <Link href="/coverage/dashboard" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              Dashboard
            </Link>
            <Link href="/coverage/timeline" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              Timeline
            </Link>
            <div style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 600, cursor: 'pointer',
              color: '#2563eb', borderBottom: '2px solid #2563eb', marginBottom: '-2px'
            }}>
              Export
            </div>
            <Link href="/coverage/clients" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              Clients &amp; Games
            </Link>
            <Link href="/coverage/campaign-report" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              Campaign Report
            </Link>
            <Link href="/coverage/guide" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              Guide
            </Link>
          </div>

          {/* Filter Controls */}
          <div style={{
            backgroundColor: 'white', borderRadius: '10px', padding: '20px',
            boxShadow: '0 1px 2px rgba(0,0,0,0.05)', marginBottom: '20px'
          }}>
            <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#1e293b', marginBottom: '16px' }}>Report Filters</h3>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginBottom: '12px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: '#64748b', marginBottom: '4px' }}>Client</label>
                <select
                  value={selectedClient}
                  onChange={e => { setSelectedClient(e.target.value); setSelectedGame('') }}
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', backgroundColor: 'white' }}
                >
                  <option value="">All Clients</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: '#64748b', marginBottom: '4px' }}>Game</label>
                <select
                  value={selectedGame}
                  onChange={e => setSelectedGame(e.target.value)}
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', backgroundColor: 'white' }}
                >
                  <option value="">All Games</option>
                  {filteredGames.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: '#64748b', marginBottom: '4px' }}>Date Preset</label>
                <select
                  value={datePreset}
                  onChange={e => applyDatePreset(e.target.value)}
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', backgroundColor: 'white' }}
                >
                  <option value="all">All Time</option>
                  <option value="last_30">Last 30 Days</option>
                  <option value="last_90">Last 90 Days</option>
                  <option value="this_month">This Month</option>
                  <option value="last_month">Last Month</option>
                  <option value="this_quarter">This Quarter</option>
                  <option value="ytd">Year to Date</option>
                  <option value="custom">Custom Range</option>
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                <button
                  onClick={fetchReport}
                  disabled={loading}
                  style={{
                    width: '100%', padding: '8px 16px',
                    backgroundColor: loading ? '#93c5fd' : '#2563eb',
                    color: 'white', border: 'none', borderRadius: '6px',
                    fontSize: '14px', fontWeight: 500,
                    cursor: loading ? 'not-allowed' : 'pointer'
                  }}
                >
                  {loading ? 'Loading...' : 'Generate Report'}
                </button>
              </div>
            </div>

            {datePreset === 'custom' && (
              <div style={{ display: 'flex', gap: '12px', marginBottom: '12px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: '#64748b', marginBottom: '4px' }}>From</label>
                  <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                    style={{ padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: '#64748b', marginBottom: '4px' }}>To</label>
                  <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                    style={{ padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px' }} />
                </div>
              </div>
            )}

            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
              <input type="checkbox" checked={includeAllStatus} onChange={e => setIncludeAllStatus(e.target.checked)}
                style={{ width: '16px', height: '16px' }} />
              <span style={{ fontSize: '13px', color: '#64748b' }}>Include non-approved items (pending review, rejected)</span>
            </label>
          </div>

          {/* Report Content */}
          {loaded && summary && (
            <div ref={reportRef}>
              {/* Export Buttons */}
              <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
                <button
                  onClick={handleExcelExport}
                  disabled={exporting || items.length === 0}
                  style={{
                    padding: '10px 20px', backgroundColor: '#16a34a', color: 'white',
                    border: 'none', borderRadius: '8px', fontSize: '14px', fontWeight: 500,
                    cursor: items.length === 0 ? 'not-allowed' : 'pointer',
                    opacity: items.length === 0 ? 0.5 : 1
                  }}
                >
                  Export Excel (.xlsx)
                </button>
                <button
                  onClick={handleCSVExport}
                  disabled={exporting || items.length === 0}
                  style={{
                    padding: '10px 20px', backgroundColor: '#0d9488', color: 'white',
                    border: 'none', borderRadius: '8px', fontSize: '14px', fontWeight: 500,
                    cursor: items.length === 0 ? 'not-allowed' : 'pointer',
                    opacity: items.length === 0 ? 0.5 : 1
                  }}
                >
                  Export CSV (flat)
                </button>
                <button
                  onClick={handlePDFExport}
                  disabled={items.length === 0}
                  style={{
                    padding: '10px 20px', backgroundColor: '#dc2626', color: 'white',
                    border: 'none', borderRadius: '8px', fontSize: '14px', fontWeight: 500,
                    cursor: items.length === 0 ? 'not-allowed' : 'pointer',
                    opacity: items.length === 0 ? 0.5 : 1
                  }}
                >
                  Export PDF
                </button>

                <div style={{ borderLeft: '1px solid #e2e8f0', height: '36px', alignSelf: 'center' }} />

                <button
                  onClick={handleGenerateFeedLink}
                  disabled={!selectedGame || items.length === 0 || feedLinkLoading}
                  title={!selectedGame ? 'Select a specific game to generate a live feed link' : ''}
                  style={{
                    padding: '10px 20px',
                    backgroundColor: !selectedGame || items.length === 0 ? '#94a3b8' : feedLinkLoading ? '#7c3aed' : '#7c3aed',
                    color: 'white', border: 'none', borderRadius: '8px',
                    fontSize: '14px', fontWeight: 500,
                    cursor: !selectedGame || items.length === 0 ? 'not-allowed' : 'pointer',
                    opacity: !selectedGame || items.length === 0 ? 0.5 : 1,
                    display: 'flex', alignItems: 'center', gap: '6px'
                  }}
                >
                  {feedLinkLoading ? 'Generating...' : '🔗 Live Feed Link'}
                </button>

                <span style={{ fontSize: '13px', color: '#64748b', alignSelf: 'center' }}>
                  {items.length} coverage items
                </span>
              </div>

              {/* Live Feed Link Panel */}
              {feedLink && (
                <div style={{
                  backgroundColor: '#f5f3ff', border: '1px solid #c4b5fd', borderRadius: '10px',
                  padding: '16px 20px', marginBottom: '20px',
                  display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap'
                }}>
                  <div style={{ flex: 1, minWidth: '200px' }}>
                    <div style={{ fontSize: '12px', fontWeight: 600, color: '#6d28d9', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                      Live Feed Link
                    </div>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: '8px',
                      backgroundColor: 'white', border: '1px solid #ddd6fe', borderRadius: '6px',
                      padding: '8px 12px', fontSize: '13px', color: '#1e293b',
                      fontFamily: 'monospace', wordBreak: 'break-all'
                    }}>
                      <span style={{ flex: 1 }}>{feedLink}</span>
                      <button
                        onClick={handleCopyFeedLink}
                        style={{
                          padding: '4px 12px', backgroundColor: feedLinkCopied ? '#16a34a' : '#7c3aed',
                          color: 'white', border: 'none', borderRadius: '4px',
                          fontSize: '12px', fontWeight: 500, cursor: 'pointer',
                          whiteSpace: 'nowrap', transition: 'background-color 0.2s'
                        }}
                      >
                        {feedLinkCopied ? '✓ Copied!' : 'Copy'}
                      </button>
                    </div>
                    <p style={{ fontSize: '11px', color: '#7c3aed', marginTop: '6px' }}>
                      Share this link with your client. It shows only approved coverage items and updates automatically as new coverage is discovered.
                    </p>
                  </div>
                  <a
                    href={feedLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      padding: '8px 16px', backgroundColor: 'white', color: '#7c3aed',
                      border: '1px solid #c4b5fd', borderRadius: '6px',
                      fontSize: '13px', fontWeight: 500, textDecoration: 'none',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    Open Preview ↗
                  </a>
                  <button
                    onClick={() => { setFeedLink(null); setFeedLinkCopied(false) }}
                    style={{
                      padding: '4px 8px', backgroundColor: 'transparent', color: '#a78bfa',
                      border: 'none', cursor: 'pointer', fontSize: '18px', lineHeight: 1
                    }}
                    title="Dismiss"
                  >
                    ×
                  </button>
                </div>
              )}

              {/* Summary Stats */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginBottom: '20px' }}>
                <div style={{ backgroundColor: 'white', borderRadius: '10px', padding: '20px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)', textAlign: 'center' }}>
                  <div style={{ fontSize: '28px', fontWeight: 700, color: '#1e293b' }}>{summary.total_pieces}</div>
                  <div style={{ fontSize: '12px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Total Pieces</div>
                </div>
                <div style={{ backgroundColor: 'white', borderRadius: '10px', padding: '20px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)', textAlign: 'center' }}>
                  <div style={{ fontSize: '28px', fontWeight: 700, color: '#1e293b' }}>{formatNumber(summary.total_audience_reach)}</div>
                  <div style={{ fontSize: '12px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Audience Reach</div>
                </div>
                <div style={{ backgroundColor: 'white', borderRadius: '10px', padding: '20px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)', textAlign: 'center' }}>
                  <div style={{ fontSize: '28px', fontWeight: 700, color: '#1e293b' }}>{formatNumber(summary.estimated_views)}</div>
                  <div style={{ fontSize: '12px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Est. Views</div>
                </div>
                <div style={{ backgroundColor: 'white', borderRadius: '10px', padding: '20px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)', textAlign: 'center' }}>
                  <div style={{ fontSize: '28px', fontWeight: 700, color: '#1e293b' }}>
                    {summary.avg_review_score ? summary.avg_review_score.toFixed(1) : 'N/A'}
                  </div>
                  <div style={{ fontSize: '12px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    Avg Review ({summary.review_count})
                  </div>
                </div>
              </div>

              {/* Breakdowns */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px', marginBottom: '20px' }}>
                {/* Tier Breakdown */}
                <div style={{ backgroundColor: 'white', borderRadius: '10px', padding: '16px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
                  <h4 style={{ fontSize: '13px', fontWeight: 600, color: '#475569', marginBottom: '10px' }}>Tier Breakdown</h4>
                  {Object.entries(summary.tier_breakdown).filter(([, v]) => v > 0).map(([tier, count]) => (
                    <div key={tier} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}>
                      <span style={{ fontSize: '13px', color: '#64748b' }}>
                        {tier === 'untiered' ? 'Untiered' : (
                          <span style={{
                            padding: '1px 8px', borderRadius: '99px', fontSize: '11px', fontWeight: 600,
                            backgroundColor: TIER_COLORS[tier]?.bg || '#f3f4f6',
                            color: TIER_COLORS[tier]?.text || '#374151'
                          }}>Tier {tier}</span>
                        )}
                      </span>
                      <span style={{ fontSize: '14px', fontWeight: 600, color: '#1e293b' }}>{count}</span>
                    </div>
                  ))}
                </div>

                {/* Type Breakdown */}
                <div style={{ backgroundColor: 'white', borderRadius: '10px', padding: '16px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
                  <h4 style={{ fontSize: '13px', fontWeight: 600, color: '#475569', marginBottom: '10px' }}>Coverage Type</h4>
                  {Object.entries(summary.type_breakdown).sort((a, b) => b[1] - a[1]).map(([type, count]) => (
                    <div key={type} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                      <span style={{ fontSize: '13px', color: '#64748b', textTransform: 'capitalize' }}>{type}</span>
                      <span style={{ fontSize: '14px', fontWeight: 600, color: '#1e293b' }}>{count}</span>
                    </div>
                  ))}
                </div>

                {/* Territory Breakdown */}
                <div style={{ backgroundColor: 'white', borderRadius: '10px', padding: '16px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
                  <h4 style={{ fontSize: '13px', fontWeight: 600, color: '#475569', marginBottom: '10px' }}>Territory</h4>
                  {Object.entries(summary.territory_breakdown).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([territory, count]) => (
                    <div key={territory} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                      <span style={{ fontSize: '13px', color: '#64748b' }}>{territory}</span>
                      <span style={{ fontSize: '14px', fontWeight: 600, color: '#1e293b' }}>{count}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Reach by Tier + Review Scores */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '20px' }}>
                {/* Reach by Tier */}
                <div style={{ backgroundColor: 'white', borderRadius: '10px', padding: '16px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
                  <h4 style={{ fontSize: '13px', fontWeight: 600, color: '#475569', marginBottom: '10px' }}>Audience Reach by Tier</h4>
                  {summary.reach_by_tier && Object.entries(summary.reach_by_tier).filter(([, v]) => v > 0).map(([tier, reach]) => {
                    const pct = summary.total_audience_reach > 0 ? Math.round((reach / summary.total_audience_reach) * 100) : 0
                    return (
                      <div key={tier} style={{ marginBottom: '6px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
                          <span style={{ fontSize: '13px', color: '#64748b' }}>
                            {tier === 'untiered' ? 'Untiered' : (
                              <span style={{
                                padding: '1px 8px', borderRadius: '99px', fontSize: '11px', fontWeight: 600,
                                backgroundColor: TIER_COLORS[tier]?.bg || '#f3f4f6',
                                color: TIER_COLORS[tier]?.text || '#374151'
                              }}>Tier {tier}</span>
                            )}
                          </span>
                          <span style={{ fontSize: '13px', fontWeight: 600, color: '#1e293b' }}>{formatNumber(reach)} ({pct}%)</span>
                        </div>
                        <div style={{ height: '4px', backgroundColor: '#f1f5f9', borderRadius: '2px', overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${pct}%`, backgroundColor: TIER_COLORS[tier]?.text || '#94a3b8', borderRadius: '2px' }} />
                        </div>
                      </div>
                    )
                  })}
                </div>

                {/* Review Score Distribution */}
                <div style={{ backgroundColor: 'white', borderRadius: '10px', padding: '16px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
                  <h4 style={{ fontSize: '13px', fontWeight: 600, color: '#475569', marginBottom: '10px' }}>Review Score Distribution</h4>
                  {summary.review_distribution && summary.review_distribution.count > 0 ? (
                    <>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', marginBottom: '12px' }}>
                        <div style={{ textAlign: 'center', padding: '8px', backgroundColor: '#f8fafc', borderRadius: '6px' }}>
                          <div style={{ fontSize: '18px', fontWeight: 700, color: '#1e293b' }}>{summary.review_distribution.count}</div>
                          <div style={{ fontSize: '10px', color: '#64748b' }}>Reviews</div>
                        </div>
                        <div style={{ textAlign: 'center', padding: '8px', backgroundColor: '#f8fafc', borderRadius: '6px' }}>
                          <div style={{ fontSize: '18px', fontWeight: 700, color: '#1e293b' }}>{summary.review_distribution.avg?.toFixed(1) ?? '—'}</div>
                          <div style={{ fontSize: '10px', color: '#64748b' }}>Average</div>
                        </div>
                        <div style={{ textAlign: 'center', padding: '8px', backgroundColor: '#f8fafc', borderRadius: '6px' }}>
                          <div style={{ fontSize: '18px', fontWeight: 700, color: '#16a34a' }}>{summary.review_distribution.max ?? '—'}</div>
                          <div style={{ fontSize: '10px', color: '#64748b' }}>Highest</div>
                        </div>
                        <div style={{ textAlign: 'center', padding: '8px', backgroundColor: '#f8fafc', borderRadius: '6px' }}>
                          <div style={{ fontSize: '18px', fontWeight: 700, color: '#dc2626' }}>{summary.review_distribution.min ?? '—'}</div>
                          <div style={{ fontSize: '10px', color: '#64748b' }}>Lowest</div>
                        </div>
                      </div>
                      {Object.entries(summary.review_distribution.ranges || {}).filter(([, v]) => v > 0).map(([range, count]) => (
                        <div key={range} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: '13px' }}>
                          <span style={{ color: '#64748b' }}>{range === 'below_60' ? 'Below 60' : range}</span>
                          <span style={{ fontWeight: 600, color: '#1e293b' }}>{count}</span>
                        </div>
                      ))}
                    </>
                  ) : (
                    <p style={{ fontSize: '13px', color: '#94a3b8' }}>No review scores available</p>
                  )}
                </div>
              </div>

              {/* AVE + YouTube Metrics */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '20px' }}>
                {/* Media Value Estimation (AVE) */}
                <div style={{ backgroundColor: 'white', borderRadius: '10px', padding: '16px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
                  <h4 style={{ fontSize: '13px', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>Estimated Media Value (AVE)</h4>
                  <p style={{ fontSize: '10px', color: '#94a3b8', marginBottom: '10px' }}>Based on tier CPM rates with 3x PR multiplier</p>
                  {summary.ave_estimate && (
                    <>
                      <div style={{ fontSize: '28px', fontWeight: 700, color: '#16a34a', marginBottom: '12px' }}>
                        &euro;{summary.ave_estimate.total.toLocaleString()}
                      </div>
                      {Object.entries(summary.ave_estimate.by_tier || {}).filter(([, v]) => v > 0).map(([tier, ave]) => (
                        <div key={tier} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: '13px' }}>
                          <span style={{ color: '#64748b' }}>{tier === 'untiered' ? 'Untiered' : `Tier ${tier}`}</span>
                          <span style={{ fontWeight: 600, color: '#1e293b' }}>&euro;{ave.toLocaleString()}</span>
                        </div>
                      ))}
                    </>
                  )}
                </div>

                {/* YouTube / Video Metrics */}
                <div style={{ backgroundColor: 'white', borderRadius: '10px', padding: '16px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
                  <h4 style={{ fontSize: '13px', fontWeight: 600, color: '#475569', marginBottom: '10px' }}>Video / YouTube Metrics</h4>
                  {summary.youtube_metrics && summary.youtube_metrics.total_videos > 0 ? (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px' }}>
                      <div style={{ textAlign: 'center', padding: '12px', backgroundColor: '#fef2f2', borderRadius: '8px' }}>
                        <div style={{ fontSize: '22px', fontWeight: 700, color: '#dc2626' }}>{summary.youtube_metrics.total_videos}</div>
                        <div style={{ fontSize: '10px', color: '#64748b' }}>Videos</div>
                      </div>
                      <div style={{ textAlign: 'center', padding: '12px', backgroundColor: '#fef2f2', borderRadius: '8px' }}>
                        <div style={{ fontSize: '22px', fontWeight: 700, color: '#dc2626' }}>{formatNumber(summary.youtube_metrics.total_views)}</div>
                        <div style={{ fontSize: '10px', color: '#64748b' }}>Total Views</div>
                      </div>
                      <div style={{ textAlign: 'center', padding: '12px', backgroundColor: '#f8fafc', borderRadius: '8px' }}>
                        <div style={{ fontSize: '22px', fontWeight: 700, color: '#1e293b' }}>{formatNumber(summary.youtube_metrics.total_likes)}</div>
                        <div style={{ fontSize: '10px', color: '#64748b' }}>Likes</div>
                      </div>
                      <div style={{ textAlign: 'center', padding: '12px', backgroundColor: '#f8fafc', borderRadius: '8px' }}>
                        <div style={{ fontSize: '22px', fontWeight: 700, color: '#1e293b' }}>{formatNumber(summary.youtube_metrics.total_comments)}</div>
                        <div style={{ fontSize: '10px', color: '#64748b' }}>Comments</div>
                      </div>
                    </div>
                  ) : (
                    <p style={{ fontSize: '13px', color: '#94a3b8' }}>No video coverage tracked yet</p>
                  )}
                </div>
              </div>

              {/* Sentiment + Data Quality */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '20px' }}>
                {/* Sentiment Analysis */}
                <div style={{ backgroundColor: 'white', borderRadius: '10px', padding: '16px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
                  <h4 style={{ fontSize: '13px', fontWeight: 600, color: '#475569', marginBottom: '10px' }}>Sentiment Analysis</h4>
                  {summary.sentiment_summary && (
                    <>
                      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                        {[
                          { key: 'positive', label: 'Positive', color: '#16a34a', bg: '#dcfce7' },
                          { key: 'neutral', label: 'Neutral', color: '#64748b', bg: '#f1f5f9' },
                          { key: 'negative', label: 'Negative', color: '#dc2626', bg: '#fef2f2' },
                          { key: 'mixed', label: 'Mixed', color: '#d97706', bg: '#fef9c3' },
                        ].filter(s => (summary.sentiment_summary?.counts?.[s.key] || 0) > 0).map(s => (
                          <div key={s.key} style={{ flex: 1, textAlign: 'center', padding: '8px', backgroundColor: s.bg, borderRadius: '6px' }}>
                            <div style={{ fontSize: '18px', fontWeight: 700, color: s.color }}>{summary.sentiment_summary?.counts?.[s.key] || 0}</div>
                            <div style={{ fontSize: '10px', color: s.color }}>{s.label}</div>
                          </div>
                        ))}
                      </div>
                      {summary.sentiment_summary.top_quotes?.length > 0 && (
                        <div>
                          <div style={{ fontSize: '11px', fontWeight: 600, color: '#475569', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Key Quotes</div>
                          {summary.sentiment_summary.top_quotes.slice(0, 3).map((q, i) => (
                            <div key={i} style={{
                              padding: '8px 10px', backgroundColor: '#f8fafc', borderRadius: '6px',
                              marginBottom: '6px', borderLeft: `3px solid ${q.sentiment === 'positive' ? '#16a34a' : q.sentiment === 'negative' ? '#dc2626' : '#94a3b8'}`
                            }}>
                              <div style={{ fontSize: '12px', color: '#1e293b', fontStyle: 'italic' }}>&ldquo;{q.quote}&rdquo;</div>
                              <div style={{ fontSize: '10px', color: '#64748b', marginTop: '2px' }}>— {q.outlet}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* Data Quality */}
                <div style={{ backgroundColor: 'white', borderRadius: '10px', padding: '16px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
                  <h4 style={{ fontSize: '13px', fontWeight: 600, color: '#475569', marginBottom: '10px' }}>Data Quality</h4>
                  {summary.data_quality && (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
                        <div style={{
                          width: '56px', height: '56px', borderRadius: '50%',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          backgroundColor: summary.data_quality.completeness_pct >= 80 ? '#dcfce7' : summary.data_quality.completeness_pct >= 50 ? '#fef9c3' : '#fef2f2',
                          fontSize: '18px', fontWeight: 700,
                          color: summary.data_quality.completeness_pct >= 80 ? '#16a34a' : summary.data_quality.completeness_pct >= 50 ? '#d97706' : '#dc2626'
                        }}>
                          {summary.data_quality.completeness_pct}%
                        </div>
                        <div>
                          <div style={{ fontSize: '14px', fontWeight: 600, color: '#1e293b' }}>Data Completeness</div>
                          <div style={{ fontSize: '11px', color: '#64748b' }}>{summary.data_quality.total_items} items checked</div>
                        </div>
                      </div>
                      {[
                        { label: 'Missing outlet match', value: summary.data_quality.missing_outlet, warn: true },
                        { label: 'Missing territory', value: summary.data_quality.missing_territory, warn: true },
                        { label: 'Missing sentiment', value: summary.data_quality.missing_sentiment, warn: false },
                        { label: 'Missing publish date', value: summary.data_quality.missing_publish_date, warn: true },
                        { label: 'Untiered outlets', value: summary.data_quality.untiered_outlets, warn: false },
                        { label: 'Outlets without traffic data', value: summary.data_quality.outlets_without_traffic, warn: false },
                      ].filter(f => f.value > 0).map(f => (
                        <div key={f.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: '13px' }}>
                          <span style={{ color: '#64748b' }}>{f.label}</span>
                          <span style={{ fontWeight: 600, color: f.warn && f.value > 5 ? '#d97706' : '#1e293b' }}>{f.value}</span>
                        </div>
                      ))}
                      {summary.data_quality.completeness_pct >= 90 && (
                        <div style={{ marginTop: '8px', padding: '6px 10px', backgroundColor: '#dcfce7', borderRadius: '6px', fontSize: '12px', color: '#166534' }}>
                          Excellent data quality — report is reliable
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Coverage Items by Section */}
              {groupedItems.map(group => (
                <div key={group.section} style={{ marginBottom: '24px' }}>
                  <div style={{
                    backgroundColor: '#f1f5f9', padding: '10px 16px', borderRadius: '8px 8px 0 0',
                    fontWeight: 700, fontSize: '15px', color: '#1e293b',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                  }}>
                    <span>{group.section}</span>
                    <span style={{ fontSize: '13px', fontWeight: 500, color: '#64748b' }}>{group.items.length} items</span>
                  </div>
                  <div style={{ backgroundColor: 'white', borderRadius: '0 0 10px 10px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)', overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                      <thead>
                        <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
                          <th style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 600, color: '#475569', width: '80px' }}>Date</th>
                          <th style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 600, color: '#475569' }}>Outlet</th>
                          <th style={{ textAlign: 'center', padding: '8px 12px', fontWeight: 600, color: '#475569', width: '40px' }}>Tier</th>
                          <th style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 600, color: '#475569', width: '70px' }}>Type</th>
                          <th style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 600, color: '#475569' }}>Title</th>
                          <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 600, color: '#475569', width: '90px' }}>Visitors</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.items.map((item, i) => {
                          const tier = item.outlet?.tier
                          return (
                            <tr key={item.id} style={{ borderBottom: '1px solid #f1f5f9', backgroundColor: i % 2 === 0 ? 'white' : '#fafbfc' }}>
                              <td style={{ padding: '6px 12px', color: '#64748b', fontSize: '12px' }}>{item.publish_date || '—'}</td>
                              <td style={{ padding: '6px 12px', fontWeight: 500 }}>{item.outlet?.name || '—'}</td>
                              <td style={{ padding: '6px 12px', textAlign: 'center' }}>
                                {tier ? (
                                  <span style={{
                                    padding: '1px 8px', borderRadius: '99px', fontSize: '11px', fontWeight: 600,
                                    backgroundColor: TIER_COLORS[tier]?.bg || '#f3f4f6',
                                    color: TIER_COLORS[tier]?.text || '#374151'
                                  }}>{tier}</span>
                                ) : '—'}
                              </td>
                              <td style={{ padding: '6px 12px', color: '#64748b', fontSize: '12px', textTransform: 'capitalize' }}>{item.coverage_type || '—'}</td>
                              <td style={{ padding: '6px 12px' }}>
                                <a href={item.url} target="_blank" rel="noopener noreferrer" style={{ color: '#2563eb', textDecoration: 'none' }}>
                                  {item.title}
                                </a>
                              </td>
                              <td style={{ padding: '6px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                                {formatNumber(item.outlet?.monthly_unique_visitors || item.monthly_unique_visitors)}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Empty state */}
          {!loaded && (
            <div style={{
              backgroundColor: 'white', borderRadius: '10px', padding: '60px 20px',
              textAlign: 'center', boxShadow: '0 1px 2px rgba(0,0,0,0.05)'
            }}>
              <div style={{ fontSize: '40px', marginBottom: '16px' }}>&#128196;</div>
              <h3 style={{ fontSize: '18px', fontWeight: 600, color: '#1e293b', marginBottom: '8px' }}>
                Generate a Coverage Report
              </h3>
              <p style={{ fontSize: '14px', color: '#64748b', maxWidth: '400px', margin: '0 auto' }}>
                Select your filters above and click &quot;Generate Report&quot; to preview your coverage data. Then export to Excel or PDF.
              </p>
            </div>
          )}

          {loaded && items.length === 0 && (
            <div style={{
              backgroundColor: 'white', borderRadius: '10px', padding: '40px 20px',
              textAlign: 'center', boxShadow: '0 1px 2px rgba(0,0,0,0.05)'
            }}>
              <p style={{ fontSize: '14px', color: '#94a3b8' }}>
                No coverage items found for the selected filters. Try adjusting your date range or client selection.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
