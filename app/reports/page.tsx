'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import PptxGenJS from 'pptxgenjs'
import Link from 'next/link'
import { Sidebar } from '../components/Sidebar'

interface NameValue { name: string; value: number }
interface OutletSummary { name: string; count: number; tier: string; visitors: number }
interface Annotation { id: string; report_section: string; period_key: string; annotation_text: string; custom_fields: Record<string, unknown> }
interface DisplayMetric { label: string; value: number; is_primary_reach: boolean }
interface CoverageItem { id: string; title: string; url: string; publish_date: string; territory: string; coverage_type: string; source_type: string | null; monthly_unique_visitors: number; display_visitors: number | null; display_metrics: DisplayMetric[] | null; review_score: number | null; quotes: string | null; outlet: { name: string; tier: string } | null; game: { name: string } | null; campaign: { name: string } | null; campaign_section: string | null }

interface SalesData {
  total_rows: number; total_gross_revenue: number; total_net_revenue: number
  total_gross_units: number; total_net_units: number; avg_price: number
  platform_revenue: NameValue[]; platform_units: NameValue[]
  country_revenue: NameValue[]; product_revenue: NameValue[]; product_units: NameValue[]
  daily_revenue: { date: string; value: number }[]
}

interface CoverageData {
  total_pieces: number; total_audience_reach: number; estimated_views: number
  avg_review_score: number | null; tier_breakdown: NameValue[]
  type_breakdown: NameValue[]; territory_breakdown: NameValue[]
  top_outlets: OutletSummary[]; items: CoverageItem[]
}

interface SocialPlatformStats {
  platform: string; count: number; total_followers: number; total_views: number
  total_likes: number; total_comments: number; total_shares: number
  best_post: { title: string; url: string; engagement: number } | null
  worst_post: { title: string; url: string; engagement: number } | null
}

interface SocialPost {
  id: string; title: string; url: string; source_type: string; publish_date: string
  outlet_name: string; followers: number; views: number; likes: number
  comments: number; shares: number; engagement: number
}

interface SocialData {
  total_posts: number; total_reach: number; total_engagement: number
  engagement_rate: number; platform_breakdown: SocialPlatformStats[]
  sentiment_breakdown: NameValue[]; top_posts: SocialPost[]; worst_posts: SocialPost[]
}

interface ReportData {
  sales?: SalesData; coverage?: CoverageData; social?: SocialData
  annotations: Annotation[]; client: { id: string; name: string } | null
  game?: { id: string; name: string } | null
}

const DATE_PRESETS = [
  { label: 'Last 30 Days', value: 'last30' },
  { label: 'Last 90 Days', value: 'last90' },
  { label: 'This Month', value: 'thisMonth' },
  { label: 'Last Month', value: 'lastMonth' },
  { label: 'This Quarter', value: 'thisQuarter' },
  { label: 'Last Quarter', value: 'lastQuarter' },
  { label: 'YTD', value: 'ytd' },
  { label: 'Last Year', value: 'lastYear' },
  { label: 'All Time', value: 'all' },
  { label: 'Custom', value: 'custom' },
]

function getDateRange(preset: string): { from: string; to: string } {
  const now = new Date()
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate()
  const fmt = (dt: Date) => dt.toISOString().split('T')[0]
  switch (preset) {
    case 'last30': return { from: fmt(new Date(y, m, d - 30)), to: fmt(now) }
    case 'last90': return { from: fmt(new Date(y, m, d - 90)), to: fmt(now) }
    case 'thisMonth': return { from: fmt(new Date(y, m, 1)), to: fmt(now) }
    case 'lastMonth': return { from: fmt(new Date(y, m - 1, 1)), to: fmt(new Date(y, m, 0)) }
    case 'thisQuarter': { const qStart = new Date(y, Math.floor(m / 3) * 3, 1); return { from: fmt(qStart), to: fmt(now) } }
    case 'lastQuarter': { const qs = Math.floor(m / 3) * 3; return { from: fmt(new Date(y, qs - 3, 1)), to: fmt(new Date(y, qs, 0)) } }
    case 'ytd': return { from: fmt(new Date(y, 0, 1)), to: fmt(now) }
    case 'lastYear': return { from: fmt(new Date(y - 1, 0, 1)), to: fmt(new Date(y - 1, 11, 31)) }
    default: return { from: '', to: '' }
  }
}

function getPeriodKey(preset: string, dateFrom: string, dateTo: string): string {
  if (preset === 'custom') return `custom-${dateFrom}-${dateTo}`
  return preset
}

function formatCurrency(val: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(val)
}

function formatNumber(val: number): string {
  return new Intl.NumberFormat('en-US').format(val)
}

const TABS = ['Summary', 'Sales Report', 'PR Coverage', 'Social Media', 'Data Tables'] as const
type Tab = typeof TABS[number]

interface DataTableRow {
  [key: string]: unknown
  gross_revenue: number; net_revenue: number; gross_units: number; net_units: number
  chargebacks: number; vat: number; avg_price: number; refund_rate: number; row_count: number
}
interface DataTableResponse {
  rows: DataTableRow[]
  totals: Record<string, number>
  pagination: { page: number; page_size: number; total_rows: number; total_pages: number }
  filters: { products: string[]; platforms: string[]; countries: string[] }
  raw_row_count: number
}

export default function ReportsPage() {
  const supabase = createClientComponentClient()
  const [clients, setClients] = useState<{ id: string; name: string }[]>([])
  const [games, setGames] = useState<{ id: string; name: string }[]>([])
  const [selectedClient, setSelectedClient] = useState('')
  const [selectedGame, setSelectedGame] = useState('')
  const [datePreset, setDatePreset] = useState('last30')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [activeTab, setActiveTab] = useState<Tab>('Summary')
  const [loading, setLoading] = useState(false)
  const [reportData, setReportData] = useState<ReportData | null>(null)
  const [annotations, setAnnotations] = useState<Record<string, string>>({})
  const [savingAnnotation, setSavingAnnotation] = useState<string | null>(null)

  // Export modal state
  const [showExportModal, setShowExportModal] = useState(false)
  const [exportSections, setExportSections] = useState({ summary: true, sales: true, pr_coverage: true, social: true })
  const [exporting, setExporting] = useState(false)

  // Shareable link state
  const [generatingLink, setGeneratingLink] = useState(false)
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const [shareError, setShareError] = useState<string | null>(null)

  // Manual social stats (stored in annotations custom_fields)
  const [manualSocialStats, setManualSocialStats] = useState<Record<string, Record<string, string>>>({})

  // Data Tables state
  const [dtData, setDtData] = useState<DataTableResponse | null>(null)
  const [dtLoading, setDtLoading] = useState(false)
  const [dtDrill, setDtDrill] = useState<'game' | 'product' | 'platform' | 'country' | 'daily'>('product')
  const [dtFilterProduct, setDtFilterProduct] = useState('')
  const [dtFilterPlatform, setDtFilterPlatform] = useState('')
  const [dtFilterCountry, setDtFilterCountry] = useState('')
  const [dtSearch, setDtSearch] = useState('')
  const [dtSortBy, setDtSortBy] = useState('net_revenue')
  const [dtSortDir, setDtSortDir] = useState<'asc' | 'desc'>('desc')
  const [dtPage, setDtPage] = useState(1)
  const [dtPageSize] = useState(50)

  // Load clients
  useEffect(() => {
    supabase.from('clients').select('id, name').order('name').then(({ data }) => {
      if (data) setClients(data)
    })
  }, [supabase])

  // Load games when client changes
  useEffect(() => {
    if (!selectedClient) { setGames([]); return }
    supabase.from('games').select('id, name').eq('client_id', selectedClient).order('name').then(({ data }) => {
      if (data) setGames(data)
    })
  }, [selectedClient, supabase])

  const fetchReport = useCallback(async () => {
    if (!selectedClient) return
    setLoading(true)
    try {
      const range = datePreset === 'custom' ? { from: dateFrom, to: dateTo } : getDateRange(datePreset)
      const params = new URLSearchParams({ client_id: selectedClient })
      if (selectedGame) params.set('game_id', selectedGame)
      if (range.from) params.set('date_from', range.from)
      if (range.to) params.set('date_to', range.to)

      const res = await fetch(`/api/reports?${params}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      setReportData(data)
      // Populate annotations from fetched data
      const annMap: Record<string, string> = {}
      for (const ann of (data.annotations || [])) {
        annMap[ann.report_section] = ann.annotation_text || ''
        if (ann.report_section === 'social_manual' && ann.custom_fields) {
          setManualSocialStats(ann.custom_fields as Record<string, Record<string, string>>)
        }
      }
      setAnnotations(annMap)
    } catch (err) {
      console.error('Failed to fetch report:', err)
    } finally {
      setLoading(false)
    }
  }, [selectedClient, selectedGame, datePreset, dateFrom, dateTo])

  const generateShareLink = async () => {
    if (!selectedClient || !reportData) return
    setGeneratingLink(true)
    setShareError(null)
    setShareUrl(null)
    try {
      const range = datePreset === 'custom' ? { from: dateFrom, to: dateTo } : getDateRange(datePreset)
      const res = await fetch('/api/reports/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: selectedClient,
          game_id: selectedGame || null,
          date_from: range.from || null,
          date_to: range.to || null,
          sections: exportSections,
          expires_days: 30,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to generate link')
      setShareUrl(data.share_url)
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'Failed to generate share link')
    } finally {
      setGeneratingLink(false)
    }
  }

  const saveAnnotation = async (section: string) => {
    if (!selectedClient) return
    setSavingAnnotation(section)
    try {
      const range = datePreset === 'custom' ? { from: dateFrom, to: dateTo } : getDateRange(datePreset)
      const periodKey = getPeriodKey(datePreset, range.from, range.to)
      await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: selectedClient,
          game_id: selectedGame || null,
          report_section: section,
          period_key: periodKey,
          annotation_text: annotations[section] || '',
        }),
      })
    } catch (err) {
      console.error('Failed to save annotation:', err)
    } finally {
      setSavingAnnotation(null)
    }
  }

  const saveManualSocialStats = async () => {
    if (!selectedClient) return
    setSavingAnnotation('social_manual')
    try {
      const range = datePreset === 'custom' ? { from: dateFrom, to: dateTo } : getDateRange(datePreset)
      const periodKey = getPeriodKey(datePreset, range.from, range.to)
      await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: selectedClient,
          game_id: selectedGame || null,
          report_section: 'social_manual',
          period_key: periodKey,
          annotation_text: '',
          custom_fields: manualSocialStats,
        }),
      })
    } catch (err) {
      console.error('Failed to save manual social stats:', err)
    } finally {
      setSavingAnnotation(null)
    }
  }

  const fetchDataTable = useCallback(async (overridePage?: number) => {
    if (!selectedClient) return
    setDtLoading(true)
    try {
      const range = datePreset === 'custom' ? { from: dateFrom, to: dateTo } : getDateRange(datePreset)
      const params = new URLSearchParams({ client_id: selectedClient, drill: dtDrill, page: String(overridePage || dtPage), page_size: String(dtPageSize), sort_by: dtSortBy, sort_dir: dtSortDir })
      if (selectedGame) params.set('game_id', selectedGame)
      if (range.from) params.set('date_from', range.from)
      if (range.to) params.set('date_to', range.to)
      if (dtFilterProduct) params.set('product', dtFilterProduct)
      if (dtFilterPlatform) params.set('platform', dtFilterPlatform)
      if (dtFilterCountry) params.set('country', dtFilterCountry)
      if (dtSearch) params.set('search', dtSearch)

      const res = await fetch(`/api/reports/data-table?${params}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setDtData(data)
    } catch (err) {
      console.error('Failed to fetch data table:', err)
    } finally {
      setDtLoading(false)
    }
  }, [selectedClient, selectedGame, datePreset, dateFrom, dateTo, dtDrill, dtPage, dtPageSize, dtSortBy, dtSortDir, dtFilterProduct, dtFilterPlatform, dtFilterCountry, dtSearch])

  // Auto-fetch data table when tab switches or filters change
  useEffect(() => {
    if (activeTab === 'Data Tables' && selectedClient) {
      fetchDataTable()
    }
  }, [activeTab, fetchDataTable, selectedClient])

  const handleDtSort = (col: string) => {
    if (dtSortBy === col) {
      setDtSortDir(prev => prev === 'asc' ? 'desc' : 'asc')
    } else {
      setDtSortBy(col)
      setDtSortDir('desc')
    }
    setDtPage(1)
  }

  const exportCSV = () => {
    if (!dtData || dtData.rows.length === 0) return
    const drillCols = getDrillColumns(dtDrill)
    const headers = [...drillCols.map(c => c.label), 'Gross Revenue', 'Net Revenue', 'Gross Units', 'Net Units', 'Chargebacks', 'VAT', 'Avg Price', 'Refund Rate %']
    const csvRows = [headers.join(',')]
    for (const row of dtData.rows) {
      const vals = [
        ...drillCols.map(c => `"${String(row[c.key] || '').replace(/"/g, '""')}"`),
        row.gross_revenue.toFixed(2), row.net_revenue.toFixed(2),
        row.gross_units, row.net_units, row.chargebacks, row.vat.toFixed(2),
        row.avg_price.toFixed(2), row.refund_rate.toFixed(2),
      ]
      csvRows.push(vals.join(','))
    }
    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `data-table-${dtDrill}-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const getExportMeta = () => {
    const clientName = reportData?.client?.name || 'Client'
    const gameName = reportData?.game?.name || ''
    const range = datePreset === 'custom' ? { from: dateFrom, to: dateTo } : getDateRange(datePreset)
    const periodLabel = datePreset === 'custom' ? `${range.from} to ${range.to}` : DATE_PRESETS.find(p => p.value === datePreset)?.label || datePreset
    return { clientName, gameName, range, periodLabel }
  }

  const exportPDF = (sections = exportSections) => {
    if (!reportData) return
    const { clientName, gameName, periodLabel } = getExportMeta()

    const w = window.open('', '_blank')
    if (!w) return

    const sales = sections.sales ? reportData.sales : undefined
    const cov = sections.pr_coverage ? reportData.coverage : undefined
    const social = sections.social ? reportData.social : undefined

    w.document.write(`<!DOCTYPE html><html><head><title>${clientName} Report - ${periodLabel}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1a1a2e; background: #fff; padding: 40px; }
  .header { text-align: center; margin-bottom: 32px; padding-bottom: 24px; border-bottom: 3px solid #3b82f6; }
  .header h1 { font-size: 28px; color: #1e293b; margin-bottom: 4px; }
  .header .subtitle { font-size: 14px; color: #64748b; }
  .section { margin-bottom: 32px; page-break-inside: avoid; }
  .section h2 { font-size: 20px; color: #1e293b; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 2px solid #e2e8f0; }
  .section h3 { font-size: 16px; color: #334155; margin-bottom: 12px; }
  .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px; }
  .stat-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; text-align: center; }
  .stat-card .value { font-size: 24px; font-weight: 700; color: #1e293b; }
  .stat-card .label { font-size: 12px; color: #64748b; margin-top: 4px; }
  .breakdown-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 24px; }
  .breakdown-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; }
  .breakdown-card h4 { font-size: 14px; font-weight: 600; margin-bottom: 8px; color: #334155; }
  .breakdown-item { display: flex; justify-content: space-between; font-size: 13px; padding: 4px 0; border-bottom: 1px solid #f1f5f9; }
  .breakdown-item .name { color: #475569; } .breakdown-item .val { font-weight: 600; color: #1e293b; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 16px; }
  th { background: #f1f5f9; text-align: left; padding: 8px 12px; font-weight: 600; color: #475569; border-bottom: 2px solid #e2e8f0; }
  td { padding: 6px 12px; border-bottom: 1px solid #f1f5f9; color: #334155; }
  .tier-badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
  .tier-A { background: #dcfce7; color: #166534; } .tier-B { background: #dbeafe; color: #1e40af; }
  .tier-C { background: #fef3c7; color: #92400e; } .tier-D { background: #f3f4f6; color: #374151; }
  .annotation { background: #f8fafc; border-left: 4px solid #3b82f6; padding: 16px; margin: 16px 0; border-radius: 0 8px 8px 0; font-size: 14px; color: #334155; white-space: pre-wrap; }
  .footer { text-align: center; margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; }
  @media print { body { padding: 20px; } .stats-grid { grid-template-columns: repeat(4, 1fr); } }
</style></head><body>
<div class="header">
  <h1>${clientName}${gameName ? ' — ' + gameName : ''}</h1>
  <div class="subtitle">Performance Report | ${periodLabel} | Generated ${new Date().toLocaleDateString()}</div>
</div>

${sections.summary && annotations.summary ? `<div class="section"><h2>Executive Summary</h2><div class="annotation">${annotations.summary}</div></div>` : ''}

${sales ? `
<div class="section">
  <h2>Sales Performance</h2>
  <div class="stats-grid">
    <div class="stat-card"><div class="value">${formatCurrency(sales.total_net_revenue)}</div><div class="label">Net Revenue</div></div>
    <div class="stat-card"><div class="value">${formatNumber(sales.total_net_units)}</div><div class="label">Net Units Sold</div></div>
    <div class="stat-card"><div class="value">${formatCurrency(sales.avg_price)}</div><div class="label">Avg Price / Unit</div></div>
    <div class="stat-card"><div class="value">${sales.platform_revenue.length}</div><div class="label">Platforms</div></div>
  </div>
  <div class="breakdown-grid">
    <div class="breakdown-card"><h4>Revenue by Platform</h4>${sales.platform_revenue.map(p => `<div class="breakdown-item"><span class="name">${p.name}</span><span class="val">${formatCurrency(p.value)}</span></div>`).join('')}</div>
    <div class="breakdown-card"><h4>Revenue by Product</h4>${sales.product_revenue.slice(0, 10).map(p => `<div class="breakdown-item"><span class="name">${p.name}</span><span class="val">${formatCurrency(p.value)}</span></div>`).join('')}</div>
    <div class="breakdown-card"><h4>Top Countries</h4>${sales.country_revenue.slice(0, 10).map(p => `<div class="breakdown-item"><span class="name">${p.name}</span><span class="val">${formatCurrency(p.value)}</span></div>`).join('')}</div>
  </div>
  ${annotations.sales ? `<div class="annotation">${annotations.sales}</div>` : ''}
</div>` : ''}

${cov ? `
<div class="section">
  <h2>PR Coverage</h2>
  <div class="stats-grid">
    <div class="stat-card"><div class="value">${formatNumber(cov.total_pieces)}</div><div class="label">Total Pieces</div></div>
    <div class="stat-card"><div class="value">${formatNumber(cov.total_audience_reach)}</div><div class="label">Audience Reach</div></div>
    <div class="stat-card"><div class="value">${formatNumber(cov.estimated_views)}</div><div class="label">Est. Views</div></div>
    <div class="stat-card"><div class="value">${cov.avg_review_score ?? 'N/A'}</div><div class="label">Avg Review Score</div></div>
  </div>
  <div class="breakdown-grid">
    <div class="breakdown-card"><h4>By Tier</h4>${cov.tier_breakdown.map(t => `<div class="breakdown-item"><span class="name">Tier ${t.name}</span><span class="val">${t.value}</span></div>`).join('')}</div>
    <div class="breakdown-card"><h4>By Type</h4>${cov.type_breakdown.map(t => `<div class="breakdown-item"><span class="name">${t.name}</span><span class="val">${t.value}</span></div>`).join('')}</div>
    <div class="breakdown-card"><h4>By Territory</h4>${cov.territory_breakdown.slice(0, 8).map(t => `<div class="breakdown-item"><span class="name">${t.name}</span><span class="val">${t.value}</span></div>`).join('')}</div>
  </div>

  ${cov.top_outlets.length > 0 ? `<h3>Top Outlets</h3><table><thead><tr><th>Outlet</th><th>Tier</th><th>Pieces</th><th>Monthly Visitors / Views</th></tr></thead><tbody>
    ${cov.top_outlets.map(o => `<tr><td>${o.name}</td><td><span class="tier-badge tier-${o.tier}">${o.tier}</span></td><td>${o.count}</td><td>${formatNumber(o.visitors)}</td></tr>`).join('')}
  </tbody></table>` : ''}

  ${cov.items.length > 0 ? `<h3>Coverage Items</h3><table><thead><tr><th>Date</th><th>Outlet</th><th>Title</th><th>Territory</th><th>Type</th></tr></thead><tbody>
    ${cov.items.slice(0, 50).map(i => `<tr><td>${i.publish_date || ''}</td><td>${(i.outlet as unknown as Record<string, string>)?.name || ''}</td><td>${i.url ? `<a href="${i.url}" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:none">${i.title || ''}</a>` : (i.title || '')}</td><td>${i.territory || ''}</td><td>${i.coverage_type || ''}</td></tr>`).join('')}
  </tbody></table>` : ''}
  ${annotations.pr_coverage ? `<div class="annotation">${annotations.pr_coverage}</div>` : ''}
</div>` : ''}

${social && social.total_posts > 0 ? `
<div class="section">
  <h2>Social Media</h2>
  <div class="stats-grid">
    <div class="stat-card"><div class="value">${formatNumber(social.total_posts)}</div><div class="label">Total Posts</div></div>
    <div class="stat-card"><div class="value">${formatNumber(social.total_reach)}</div><div class="label">Combined Followers</div></div>
    <div class="stat-card"><div class="value">${formatNumber(social.total_engagement)}</div><div class="label">Total Engagement</div></div>
    <div class="stat-card"><div class="value">${social.engagement_rate.toFixed(2)}%</div><div class="label">Engagement Rate</div></div>
  </div>
  ${social.platform_breakdown.length > 0 ? `<h3>By Platform</h3><table><thead><tr><th>Platform</th><th>Posts</th><th style="text-align:right">Followers</th><th style="text-align:right">Views</th><th style="text-align:right">Likes</th><th style="text-align:right">Comments</th><th style="text-align:right">Shares</th></tr></thead><tbody>
    ${social.platform_breakdown.map(p => `<tr><td style="text-transform:capitalize">${p.platform}</td><td>${p.count}</td><td style="text-align:right">${formatNumber(p.total_followers)}</td><td style="text-align:right">${formatNumber(p.total_views)}</td><td style="text-align:right">${formatNumber(p.total_likes)}</td><td style="text-align:right">${formatNumber(p.total_comments)}</td><td style="text-align:right">${formatNumber(p.total_shares)}</td></tr>`).join('')}
  </tbody></table>` : ''}
  ${social.top_posts.length > 0 ? `<h3>Top Performing Posts</h3><table><thead><tr><th>Platform</th><th>Creator</th><th>Post</th><th style="text-align:right">Engagement</th></tr></thead><tbody>
    ${social.top_posts.slice(0, 10).map(p => `<tr><td style="text-transform:capitalize">${p.source_type}</td><td>${p.outlet_name || '-'}</td><td>${p.title.length > 60 ? p.title.substring(0, 60) + '...' : p.title}</td><td style="text-align:right">${formatNumber(p.engagement)}</td></tr>`).join('')}
  </tbody></table>` : ''}
  ${annotations.social ? `<div class="annotation">${annotations.social}</div>` : ''}
</div>` : ''}

<div class="footer">Generated by GameDrive | ${new Date().toLocaleString()}</div>
</body></html>`)
    w.document.close()
    setTimeout(() => w.print(), 500)
  }

  const exportPPTX = async (sections = exportSections) => {
    if (!reportData) return
    setExporting(true)
    try {
      const { clientName, gameName, periodLabel } = getExportMeta()
      const pptx = new PptxGenJS()
      pptx.layout = 'LAYOUT_16x9'
      pptx.author = 'GameDrive'
      pptx.subject = `${clientName} Performance Report`

      const DARK = '1A1A2E'
      const BLUE = '3B82F6'
      const GRAY = '64748B'
      const WHITE = 'FFFFFF'

      // --- Title slide ---
      const titleSlide = pptx.addSlide()
      titleSlide.background = { color: DARK }
      titleSlide.addText(`${clientName}${gameName ? ' — ' + gameName : ''}`, { x: 0.8, y: 2.0, w: 8.4, h: 1.2, fontSize: 32, bold: true, color: WHITE, fontFace: 'Arial' })
      titleSlide.addText('Performance Report', { x: 0.8, y: 3.0, w: 8.4, h: 0.6, fontSize: 20, color: BLUE, fontFace: 'Arial' })
      titleSlide.addText(periodLabel, { x: 0.8, y: 3.6, w: 8.4, h: 0.5, fontSize: 14, color: GRAY, fontFace: 'Arial' })
      titleSlide.addText(`Generated ${new Date().toLocaleDateString()}`, { x: 0.8, y: 4.5, w: 8.4, h: 0.4, fontSize: 11, color: GRAY, fontFace: 'Arial' })
      titleSlide.addText('Powered by GameDrive', { x: 0.8, y: 6.5, w: 8.4, h: 0.3, fontSize: 10, color: GRAY, fontFace: 'Arial' })

      // Helper: stat row for slides
      const addStatRow = (slide: PptxGenJS.Slide, stats: { label: string; value: string }[], yPos: number) => {
        const colW = 8.4 / stats.length
        stats.forEach((stat, i) => {
          slide.addText(stat.value, { x: 0.8 + i * colW, y: yPos, w: colW, h: 0.6, fontSize: 24, bold: true, color: DARK, align: 'center', fontFace: 'Arial' })
          slide.addText(stat.label, { x: 0.8 + i * colW, y: yPos + 0.55, w: colW, h: 0.3, fontSize: 10, color: GRAY, align: 'center', fontFace: 'Arial' })
        })
      }

      // --- Summary slide ---
      if (sections.summary) {
        const slide = pptx.addSlide()
        slide.addText('Executive Summary', { x: 0.8, y: 0.3, w: 8.4, h: 0.6, fontSize: 22, bold: true, color: DARK, fontFace: 'Arial' })

        const summaryStats: { label: string; value: string }[] = []
        if (reportData.sales) {
          summaryStats.push({ label: 'Net Revenue', value: formatCurrency(reportData.sales.total_net_revenue) })
          summaryStats.push({ label: 'Units Sold', value: formatNumber(reportData.sales.total_net_units) })
        }
        if (reportData.coverage) {
          summaryStats.push({ label: 'Coverage Pieces', value: formatNumber(reportData.coverage.total_pieces) })
          summaryStats.push({ label: 'Audience Reach', value: formatNumber(reportData.coverage.total_audience_reach) })
        }
        if (summaryStats.length > 0) addStatRow(slide, summaryStats.slice(0, 4), 1.2)

        if (annotations.summary) {
          slide.addText(annotations.summary.substring(0, 800), { x: 0.8, y: 2.6, w: 8.4, h: 3.5, fontSize: 12, color: '334155', fontFace: 'Arial', valign: 'top', paraSpaceAfter: 6 })
        }
      }

      // --- Sales slide ---
      if (sections.sales && reportData.sales) {
        const s = reportData.sales
        const slide = pptx.addSlide()
        slide.addText('Sales Performance', { x: 0.8, y: 0.3, w: 8.4, h: 0.6, fontSize: 22, bold: true, color: DARK, fontFace: 'Arial' })

        addStatRow(slide, [
          { label: 'Net Revenue', value: formatCurrency(s.total_net_revenue) },
          { label: 'Gross Units', value: formatNumber(s.total_gross_units) },
          { label: 'Net Units', value: formatNumber(s.total_net_units) },
          { label: 'Avg Price', value: formatCurrency(s.avg_price) },
        ], 1.2)

        // Platform breakdown table
        if (s.platform_revenue.length > 0) {
          slide.addText('Revenue by Platform', { x: 0.8, y: 2.6, w: 4, h: 0.4, fontSize: 14, bold: true, color: DARK, fontFace: 'Arial' })
          const platRows: PptxGenJS.TableRow[] = [
            [{ text: 'Platform', options: { bold: true, fontSize: 10, color: WHITE, fill: { color: '475569' } } }, { text: 'Revenue', options: { bold: true, fontSize: 10, color: WHITE, fill: { color: '475569' }, align: 'right' } }],
          ]
          for (const p of s.platform_revenue.slice(0, 8)) {
            platRows.push([{ text: p.name, options: { fontSize: 10 } }, { text: formatCurrency(p.value), options: { fontSize: 10, align: 'right' } }])
          }
          slide.addTable(platRows, { x: 0.8, y: 3.0, w: 4, colW: [2.5, 1.5], border: { type: 'solid', pt: 0.5, color: 'E2E8F0' }, rowH: 0.3 })

          // Country breakdown
          if (s.country_revenue.length > 0) {
            slide.addText('Top Countries', { x: 5.2, y: 2.6, w: 4, h: 0.4, fontSize: 14, bold: true, color: DARK, fontFace: 'Arial' })
            const countryRows: PptxGenJS.TableRow[] = [
              [{ text: 'Country', options: { bold: true, fontSize: 10, color: WHITE, fill: { color: '475569' } } }, { text: 'Revenue', options: { bold: true, fontSize: 10, color: WHITE, fill: { color: '475569' }, align: 'right' } }],
            ]
            for (const c of s.country_revenue.slice(0, 8)) {
              countryRows.push([{ text: c.name, options: { fontSize: 10 } }, { text: formatCurrency(c.value), options: { fontSize: 10, align: 'right' } }])
            }
            slide.addTable(countryRows, { x: 5.2, y: 3.0, w: 4, colW: [2.5, 1.5], border: { type: 'solid', pt: 0.5, color: 'E2E8F0' }, rowH: 0.3 })
          }
        }

        if (annotations.sales) {
          const noteSlide = pptx.addSlide()
          noteSlide.addText('Sales Analysis', { x: 0.8, y: 0.3, w: 8.4, h: 0.6, fontSize: 22, bold: true, color: DARK, fontFace: 'Arial' })
          noteSlide.addText(annotations.sales.substring(0, 1200), { x: 0.8, y: 1.2, w: 8.4, h: 5.0, fontSize: 12, color: '334155', fontFace: 'Arial', valign: 'top', paraSpaceAfter: 6 })
        }
      }

      // --- PR Coverage slide ---
      if (sections.pr_coverage && reportData.coverage) {
        const c = reportData.coverage
        const slide = pptx.addSlide()
        slide.addText('PR Coverage', { x: 0.8, y: 0.3, w: 8.4, h: 0.6, fontSize: 22, bold: true, color: DARK, fontFace: 'Arial' })

        addStatRow(slide, [
          { label: 'Total Pieces', value: formatNumber(c.total_pieces) },
          { label: 'Audience Reach', value: formatNumber(c.total_audience_reach) },
          { label: 'Est. Views', value: formatNumber(c.estimated_views) },
          { label: 'Avg Review Score', value: c.avg_review_score != null ? String(c.avg_review_score) : 'N/A' },
        ], 1.2)

        // Top outlets table
        if (c.top_outlets.length > 0) {
          slide.addText('Top Outlets', { x: 0.8, y: 2.6, w: 8.4, h: 0.4, fontSize: 14, bold: true, color: DARK, fontFace: 'Arial' })
          const outletRows: PptxGenJS.TableRow[] = [
            [
              { text: 'Outlet', options: { bold: true, fontSize: 10, color: WHITE, fill: { color: '475569' } } },
              { text: 'Tier', options: { bold: true, fontSize: 10, color: WHITE, fill: { color: '475569' }, align: 'center' } },
              { text: 'Pieces', options: { bold: true, fontSize: 10, color: WHITE, fill: { color: '475569' }, align: 'center' } },
              { text: 'Monthly Visitors / Views', options: { bold: true, fontSize: 10, color: WHITE, fill: { color: '475569' }, align: 'right' } },
            ],
          ]
          for (const o of c.top_outlets.slice(0, 10)) {
            outletRows.push([
              { text: o.name, options: { fontSize: 10 } },
              { text: o.tier, options: { fontSize: 10, align: 'center' } },
              { text: String(o.count), options: { fontSize: 10, align: 'center' } },
              { text: formatNumber(o.visitors), options: { fontSize: 10, align: 'right' } },
            ])
          }
          slide.addTable(outletRows, { x: 0.8, y: 3.0, w: 8.4, colW: [3.5, 1, 1, 2.9], border: { type: 'solid', pt: 0.5, color: 'E2E8F0' }, rowH: 0.3 })
        }

        if (annotations.pr_coverage) {
          const noteSlide = pptx.addSlide()
          noteSlide.addText('PR Coverage Analysis', { x: 0.8, y: 0.3, w: 8.4, h: 0.6, fontSize: 22, bold: true, color: DARK, fontFace: 'Arial' })
          noteSlide.addText(annotations.pr_coverage.substring(0, 1200), { x: 0.8, y: 1.2, w: 8.4, h: 5.0, fontSize: 12, color: '334155', fontFace: 'Arial', valign: 'top', paraSpaceAfter: 6 })
        }
      }

      // --- Social Media slide ---
      if (sections.social && reportData.social && reportData.social.total_posts > 0) {
        const soc = reportData.social
        const slide = pptx.addSlide()
        slide.addText('Social Media', { x: 0.8, y: 0.3, w: 8.4, h: 0.6, fontSize: 22, bold: true, color: DARK, fontFace: 'Arial' })

        addStatRow(slide, [
          { label: 'Total Posts', value: formatNumber(soc.total_posts) },
          { label: 'Combined Followers', value: formatNumber(soc.total_reach) },
          { label: 'Total Engagement', value: formatNumber(soc.total_engagement) },
          { label: 'Engagement Rate', value: soc.engagement_rate.toFixed(2) + '%' },
        ], 1.2)

        // Platform table
        if (soc.platform_breakdown.length > 0) {
          slide.addText('By Platform', { x: 0.8, y: 2.6, w: 8.4, h: 0.4, fontSize: 14, bold: true, color: DARK, fontFace: 'Arial' })
          const platRows: PptxGenJS.TableRow[] = [
            [
              { text: 'Platform', options: { bold: true, fontSize: 9, color: WHITE, fill: { color: '475569' } } },
              { text: 'Posts', options: { bold: true, fontSize: 9, color: WHITE, fill: { color: '475569' }, align: 'center' } },
              { text: 'Followers', options: { bold: true, fontSize: 9, color: WHITE, fill: { color: '475569' }, align: 'right' } },
              { text: 'Views', options: { bold: true, fontSize: 9, color: WHITE, fill: { color: '475569' }, align: 'right' } },
              { text: 'Likes', options: { bold: true, fontSize: 9, color: WHITE, fill: { color: '475569' }, align: 'right' } },
              { text: 'Comments', options: { bold: true, fontSize: 9, color: WHITE, fill: { color: '475569' }, align: 'right' } },
              { text: 'Shares', options: { bold: true, fontSize: 9, color: WHITE, fill: { color: '475569' }, align: 'right' } },
            ],
          ]
          for (const p of soc.platform_breakdown) {
            platRows.push([
              { text: p.platform.charAt(0).toUpperCase() + p.platform.slice(1), options: { fontSize: 9 } },
              { text: String(p.count), options: { fontSize: 9, align: 'center' } },
              { text: formatNumber(p.total_followers), options: { fontSize: 9, align: 'right' } },
              { text: formatNumber(p.total_views), options: { fontSize: 9, align: 'right' } },
              { text: formatNumber(p.total_likes), options: { fontSize: 9, align: 'right' } },
              { text: formatNumber(p.total_comments), options: { fontSize: 9, align: 'right' } },
              { text: formatNumber(p.total_shares), options: { fontSize: 9, align: 'right' } },
            ])
          }
          slide.addTable(platRows, { x: 0.8, y: 3.0, w: 8.4, colW: [1.5, 0.8, 1.3, 1.2, 1.0, 1.2, 1.0], border: { type: 'solid', pt: 0.5, color: 'E2E8F0' }, rowH: 0.28 })
        }

        if (annotations.social) {
          const noteSlide = pptx.addSlide()
          noteSlide.addText('Social Media Analysis', { x: 0.8, y: 0.3, w: 8.4, h: 0.6, fontSize: 22, bold: true, color: DARK, fontFace: 'Arial' })
          noteSlide.addText(annotations.social.substring(0, 1200), { x: 0.8, y: 1.2, w: 8.4, h: 5.0, fontSize: 12, color: '334155', fontFace: 'Arial', valign: 'top', paraSpaceAfter: 6 })
        }
      }

      // --- Thank you / closing slide ---
      const endSlide = pptx.addSlide()
      endSlide.background = { color: DARK }
      endSlide.addText('Thank You', { x: 0.8, y: 2.5, w: 8.4, h: 1.0, fontSize: 36, bold: true, color: WHITE, align: 'center', fontFace: 'Arial' })
      endSlide.addText('Powered by GameDrive', { x: 0.8, y: 3.8, w: 8.4, h: 0.5, fontSize: 14, color: GRAY, align: 'center', fontFace: 'Arial' })

      const fileName = `${clientName.replace(/\s+/g, '_')}_Report_${new Date().toISOString().split('T')[0]}.pptx`
      await pptx.writeFile({ fileName })
    } catch (err) {
      console.error('PPTX export error:', err)
    } finally {
      setExporting(false)
    }
  }

  function getDrillColumns(drill: string): { key: string; label: string }[] {
    switch (drill) {
      case 'game': return [{ key: 'product_name', label: 'Product' }]
      case 'product': return [{ key: 'product_name', label: 'Product' }, { key: 'platform', label: 'Platform' }]
      case 'platform': return [{ key: 'platform', label: 'Platform' }]
      case 'country': return [{ key: 'country_code', label: 'Code' }, { key: 'country', label: 'Country' }]
      case 'daily': return [{ key: 'date', label: 'Date' }]
      default: return [{ key: 'product_name', label: 'Product' }]
    }
  }

  // Styles
  const pageStyle: React.CSSProperties = { padding: '32px', maxWidth: '1400px', margin: '0 auto' }
  const headerStyle: React.CSSProperties = { marginBottom: '24px' }
  const h1Style: React.CSSProperties = { fontSize: '24px', fontWeight: 700, color: '#1e293b', marginBottom: '4px' }
  const subtitleStyle: React.CSSProperties = { fontSize: '14px', color: '#64748b' }
  const cardStyle: React.CSSProperties = { background: '#fff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '24px', marginBottom: '24px' }
  const filterRow: React.CSSProperties = { display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '16px' }
  const labelStyle: React.CSSProperties = { display: 'block', fontSize: '12px', fontWeight: 600, color: '#64748b', marginBottom: '4px' }
  const selectStyle: React.CSSProperties = { padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '14px', minWidth: '180px', background: '#fff' }
  const inputStyle: React.CSSProperties = { padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '14px' }
  const btnPrimary: React.CSSProperties = { padding: '8px 20px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }
  const btnOutline: React.CSSProperties = { padding: '8px 16px', background: '#fff', color: '#3b82f6', border: '1px solid #3b82f6', borderRadius: '8px', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }
  const tabBar: React.CSSProperties = { display: 'flex', borderBottom: '2px solid #e2e8f0', marginBottom: '24px' }
  const statGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px', marginBottom: '24px' }
  const statCard: React.CSSProperties = { background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '16px', textAlign: 'center' }
  const statValue: React.CSSProperties = { fontSize: '24px', fontWeight: 700, color: '#1e293b' }
  const statLabel: React.CSSProperties = { fontSize: '12px', color: '#64748b', marginTop: '4px' }
  const breakGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', marginBottom: '24px' }
  const breakCard: React.CSSProperties = { background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '16px' }
  const breakTitle: React.CSSProperties = { fontSize: '14px', fontWeight: 600, color: '#334155', marginBottom: '8px' }
  const breakItem: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #f1f5f9', fontSize: '13px' }
  const textareaStyle: React.CSSProperties = { width: '100%', minHeight: '100px', padding: '12px', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '14px', fontFamily: 'inherit', resize: 'vertical' }
  const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: '13px', marginBottom: '16px' }
  const thStyle: React.CSSProperties = { background: '#f1f5f9', textAlign: 'left' as const, padding: '8px 12px', fontWeight: 600, color: '#475569', borderBottom: '2px solid #e2e8f0' }
  const tdStyle: React.CSSProperties = { padding: '6px 12px', borderBottom: '1px solid #f1f5f9', color: '#334155' }
  const tierColors: Record<string, React.CSSProperties> = {
    A: { background: '#dcfce7', color: '#166534', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: 600, display: 'inline-block' },
    B: { background: '#dbeafe', color: '#1e40af', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: 600, display: 'inline-block' },
    C: { background: '#fef3c7', color: '#92400e', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: 600, display: 'inline-block' },
    D: { background: '#f3f4f6', color: '#374151', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: 600, display: 'inline-block' },
  }

  const sales = reportData?.sales
  const cov = reportData?.coverage

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar />
      <div style={{ flex: 1, overflow: 'auto' }}>
    <div style={pageStyle}>
      <div style={headerStyle}>
        <h1 style={h1Style}>Client Report Builder</h1>
        <p style={subtitleStyle}>Generate comprehensive performance reports combining sales data and PR coverage</p>
      </div>

      {/* Filters */}
      <div style={cardStyle}>
        <div style={filterRow}>
          <div>
            <label style={labelStyle}>Client</label>
            <select style={selectStyle} value={selectedClient} onChange={e => { setSelectedClient(e.target.value); setSelectedGame('') }}>
              <option value="">Select Client...</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Game (optional)</label>
            <select style={selectStyle} value={selectedGame} onChange={e => setSelectedGame(e.target.value)}>
              <option value="">All Games</option>
              {games.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Period</label>
            <select style={selectStyle} value={datePreset} onChange={e => setDatePreset(e.target.value)}>
              {DATE_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>
          {datePreset === 'custom' && (
            <>
              <div>
                <label style={labelStyle}>From</label>
                <input type="date" style={inputStyle} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>To</label>
                <input type="date" style={inputStyle} value={dateTo} onChange={e => setDateTo(e.target.value)} />
              </div>
            </>
          )}
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
            <button style={{ ...btnPrimary, opacity: loading || !selectedClient ? 0.6 : 1 }} onClick={fetchReport} disabled={loading || !selectedClient}>
              {loading ? 'Loading...' : 'Generate Report'}
            </button>
            {reportData && (
              <>
                <button style={btnOutline} onClick={() => setShowExportModal(true)}>Export Report</button>
                <button
                  style={{ ...btnOutline, backgroundColor: generatingLink ? '#f1f5f9' : undefined }}
                  onClick={generateShareLink}
                  disabled={generatingLink}
                >
                  {generatingLink ? 'Generating...' : 'Share Link'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Share link banner */}
      {shareUrl && (
        <div style={{ padding: '12px 16px', borderRadius: '10px', marginBottom: '12px', backgroundColor: '#f0fdf4', border: '1px solid #86efac', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '13px', color: '#166534', fontWeight: 600 }}>Shareable link created (expires in 30 days):</span>
          <input
            type="text"
            readOnly
            value={shareUrl}
            style={{ flex: 1, padding: '6px 10px', border: '1px solid #86efac', borderRadius: '6px', fontSize: '13px', backgroundColor: 'white', color: '#166534' }}
            onClick={e => (e.target as HTMLInputElement).select()}
          />
          <button
            style={{ padding: '6px 14px', backgroundColor: '#16a34a', color: 'white', border: 'none', borderRadius: '6px', fontSize: '13px', cursor: 'pointer', fontWeight: 500 }}
            onClick={() => { navigator.clipboard.writeText(shareUrl); }}
          >
            Copy
          </button>
          <button
            style={{ padding: '6px 10px', background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px', color: '#6b7280' }}
            onClick={() => setShareUrl(null)}
          >
            ×
          </button>
        </div>
      )}
      {shareError && (
        <div style={{ padding: '10px 14px', borderRadius: '8px', marginBottom: '12px', backgroundColor: '#fee2e2', color: '#dc2626', fontSize: '13px' }}>
          {shareError}
        </div>
      )}

      {/* Tabs */}
      {reportData && (
        <>
          <div style={tabBar}>
            {TABS.map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)} style={{
                padding: '10px 20px', background: 'none', border: 'none', borderBottom: activeTab === tab ? '2px solid #3b82f6' : '2px solid transparent',
                color: activeTab === tab ? '#3b82f6' : '#64748b', fontWeight: activeTab === tab ? 600 : 400, fontSize: '14px', cursor: 'pointer', marginBottom: '-2px',
              }}>{tab}</button>
            ))}
          </div>

          {/* SUMMARY TAB */}
          {activeTab === 'Summary' && (
            <div>
              <div style={cardStyle}>
                <h2 style={{ fontSize: '18px', fontWeight: 600, color: '#1e293b', marginBottom: '16px' }}>Executive Summary</h2>
                <textarea
                  style={textareaStyle}
                  placeholder="Write your executive summary here... This will be included in the exported report."
                  value={annotations.summary || ''}
                  onChange={e => setAnnotations(prev => ({ ...prev, summary: e.target.value }))}
                />
                <div style={{ marginTop: '8px', display: 'flex', justifyContent: 'flex-end' }}>
                  <button style={{ ...btnPrimary, fontSize: '13px', padding: '6px 16px' }} onClick={() => saveAnnotation('summary')} disabled={savingAnnotation === 'summary'}>
                    {savingAnnotation === 'summary' ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>

              {/* Key metrics overview */}
              <div style={statGrid}>
                <div style={statCard}>
                  <div style={statValue}>{sales ? formatCurrency(sales.total_net_revenue) : '$0'}</div>
                  <div style={statLabel}>Net Revenue</div>
                </div>
                <div style={statCard}>
                  <div style={statValue}>{sales ? formatNumber(sales.total_net_units) : '0'}</div>
                  <div style={statLabel}>Units Sold</div>
                </div>
                <div style={statCard}>
                  <div style={statValue}>{cov ? formatNumber(cov.total_pieces) : '0'}</div>
                  <div style={statLabel}>Coverage Pieces</div>
                </div>
                <div style={statCard}>
                  <div style={statValue}>{cov ? formatNumber(cov.total_audience_reach) : '0'}</div>
                  <div style={statLabel}>Audience Reach</div>
                </div>
              </div>

              {/* Quick breakdowns */}
              <div style={breakGrid}>
                {sales && sales.platform_revenue.length > 0 && (
                  <div style={breakCard}>
                    <div style={breakTitle}>Revenue by Platform</div>
                    {sales.platform_revenue.slice(0, 6).map(p => (
                      <div key={p.name} style={breakItem}>
                        <span style={{ color: '#475569' }}>{p.name}</span>
                        <span style={{ fontWeight: 600, color: '#1e293b' }}>{formatCurrency(p.value)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {cov && cov.tier_breakdown.length > 0 && (
                  <div style={breakCard}>
                    <div style={breakTitle}>Coverage by Tier</div>
                    {cov.tier_breakdown.map(t => (
                      <div key={t.name} style={breakItem}>
                        <span style={{ color: '#475569' }}>Tier {t.name}</span>
                        <span style={{ fontWeight: 600, color: '#1e293b' }}>{t.value}</span>
                      </div>
                    ))}
                  </div>
                )}
                {cov && cov.type_breakdown.length > 0 && (
                  <div style={breakCard}>
                    <div style={breakTitle}>Coverage by Type</div>
                    {cov.type_breakdown.map(t => (
                      <div key={t.name} style={breakItem}>
                        <span style={{ color: '#475569' }}>{t.name}</span>
                        <span style={{ fontWeight: 600, color: '#1e293b' }}>{t.value}</span>
                      </div>
                    ))}
                  </div>
                )}
                {reportData?.social && reportData.social.total_posts > 0 && (
                  <div style={breakCard}>
                    <div style={breakTitle}>Social Media</div>
                    <div style={breakItem}>
                      <span style={{ color: '#475569' }}>Posts</span>
                      <span style={{ fontWeight: 600, color: '#1e293b' }}>{formatNumber(reportData.social.total_posts)}</span>
                    </div>
                    <div style={breakItem}>
                      <span style={{ color: '#475569' }}>Total Engagement</span>
                      <span style={{ fontWeight: 600, color: '#1e293b' }}>{formatNumber(reportData.social.total_engagement)}</span>
                    </div>
                    <div style={breakItem}>
                      <span style={{ color: '#475569' }}>Engagement Rate</span>
                      <span style={{ fontWeight: 600, color: '#1e293b' }}>{reportData.social.engagement_rate.toFixed(2)}%</span>
                    </div>
                    {reportData.social.platform_breakdown.slice(0, 3).map(p => (
                      <div key={p.platform} style={breakItem}>
                        <span style={{ color: '#475569', textTransform: 'capitalize' }}>{p.platform}</span>
                        <span style={{ fontWeight: 600, color: '#1e293b' }}>{p.count} posts</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* SALES TAB */}
          {activeTab === 'Sales Report' && sales && (
            <div>
              <div style={cardStyle}>
                <h2 style={{ fontSize: '18px', fontWeight: 600, color: '#1e293b', marginBottom: '16px' }}>Sales Performance</h2>
                <div style={statGrid}>
                  <div style={statCard}>
                    <div style={statValue}>{formatCurrency(sales.total_net_revenue)}</div>
                    <div style={statLabel}>Net Revenue</div>
                  </div>
                  <div style={statCard}>
                    <div style={statValue}>{formatNumber(sales.total_gross_units)}</div>
                    <div style={statLabel}>Gross Units</div>
                  </div>
                  <div style={statCard}>
                    <div style={statValue}>{formatNumber(sales.total_net_units)}</div>
                    <div style={statLabel}>Net Units</div>
                  </div>
                  <div style={statCard}>
                    <div style={statValue}>{formatCurrency(sales.avg_price)}</div>
                    <div style={statLabel}>Avg Price / Unit</div>
                  </div>
                </div>
              </div>

              <div style={breakGrid}>
                <div style={breakCard}>
                  <div style={breakTitle}>Revenue by Platform</div>
                  {sales.platform_revenue.map(p => (
                    <div key={p.name} style={breakItem}>
                      <span style={{ color: '#475569' }}>{p.name}</span>
                      <span style={{ fontWeight: 600, color: '#1e293b' }}>{formatCurrency(p.value)}</span>
                    </div>
                  ))}
                </div>
                <div style={breakCard}>
                  <div style={breakTitle}>Revenue by Product</div>
                  {sales.product_revenue.slice(0, 10).map(p => (
                    <div key={p.name} style={breakItem}>
                      <span style={{ color: '#475569' }}>{p.name}</span>
                      <span style={{ fontWeight: 600, color: '#1e293b' }}>{formatCurrency(p.value)}</span>
                    </div>
                  ))}
                </div>
                <div style={breakCard}>
                  <div style={breakTitle}>Top Countries</div>
                  {sales.country_revenue.slice(0, 10).map(p => (
                    <div key={p.name} style={breakItem}>
                      <span style={{ color: '#475569' }}>{p.name}</span>
                      <span style={{ fontWeight: 600, color: '#1e293b' }}>{formatCurrency(p.value)}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Units by platform */}
              {sales.platform_units.length > 0 && (
                <div style={cardStyle}>
                  <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#334155', marginBottom: '12px' }}>Units by Platform</h3>
                  <table style={tableStyle}>
                    <thead>
                      <tr>
                        <th style={thStyle}>Platform</th>
                        <th style={thStyle}>Units Sold</th>
                        <th style={thStyle}>Revenue</th>
                        <th style={thStyle}>Rev / Unit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sales.platform_revenue.map(p => {
                        const units = sales.platform_units.find(u => u.name === p.name)?.value || 0
                        return (
                          <tr key={p.name}>
                            <td style={tdStyle}>{p.name}</td>
                            <td style={tdStyle}>{formatNumber(units)}</td>
                            <td style={tdStyle}>{formatCurrency(p.value)}</td>
                            <td style={tdStyle}>{units > 0 ? formatCurrency(p.value / units) : '-'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Sales analysis */}
              <div style={cardStyle}>
                <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#334155', marginBottom: '12px' }}>Sales Analysis</h3>
                <textarea
                  style={textareaStyle}
                  placeholder="Add your sales analysis commentary here..."
                  value={annotations.sales || ''}
                  onChange={e => setAnnotations(prev => ({ ...prev, sales: e.target.value }))}
                />
                <div style={{ marginTop: '8px', display: 'flex', justifyContent: 'flex-end' }}>
                  <button style={{ ...btnPrimary, fontSize: '13px', padding: '6px 16px' }} onClick={() => saveAnnotation('sales')} disabled={savingAnnotation === 'sales'}>
                    {savingAnnotation === 'sales' ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* PR COVERAGE TAB */}
          {activeTab === 'PR Coverage' && cov && (
            <div>
              <div style={cardStyle}>
                <h2 style={{ fontSize: '18px', fontWeight: 600, color: '#1e293b', marginBottom: '16px' }}>PR Coverage Report</h2>
                <div style={statGrid}>
                  <div style={statCard}>
                    <div style={statValue}>{formatNumber(cov.total_pieces)}</div>
                    <div style={statLabel}>Total Pieces</div>
                  </div>
                  <div style={statCard}>
                    <div style={statValue}>{formatNumber(cov.total_audience_reach)}</div>
                    <div style={statLabel}>Audience Reach</div>
                  </div>
                  <div style={statCard}>
                    <div style={statValue}>{formatNumber(cov.estimated_views)}</div>
                    <div style={statLabel}>Est. Views</div>
                  </div>
                  <div style={statCard}>
                    <div style={statValue}>{cov.avg_review_score ?? 'N/A'}</div>
                    <div style={statLabel}>Avg Review Score</div>
                  </div>
                </div>
              </div>

              <div style={breakGrid}>
                <div style={breakCard}>
                  <div style={breakTitle}>By Tier</div>
                  {cov.tier_breakdown.map(t => (
                    <div key={t.name} style={breakItem}>
                      <span style={tierColors[t.name] || { color: '#475569' }}>Tier {t.name}</span>
                      <span style={{ fontWeight: 600, color: '#1e293b' }}>{t.value}</span>
                    </div>
                  ))}
                </div>
                <div style={breakCard}>
                  <div style={breakTitle}>By Type</div>
                  {cov.type_breakdown.map(t => (
                    <div key={t.name} style={breakItem}>
                      <span style={{ color: '#475569' }}>{t.name}</span>
                      <span style={{ fontWeight: 600, color: '#1e293b' }}>{t.value}</span>
                    </div>
                  ))}
                </div>
                <div style={breakCard}>
                  <div style={breakTitle}>By Territory</div>
                  {cov.territory_breakdown.slice(0, 8).map(t => (
                    <div key={t.name} style={breakItem}>
                      <span style={{ color: '#475569' }}>{t.name}</span>
                      <span style={{ fontWeight: 600, color: '#1e293b' }}>{t.value}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Top outlets table */}
              {cov.top_outlets.length > 0 && (
                <div style={cardStyle}>
                  <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#334155', marginBottom: '12px' }}>Top Outlets</h3>
                  <table style={tableStyle}>
                    <thead>
                      <tr>
                        <th style={thStyle}>Outlet</th>
                        <th style={thStyle}>Tier</th>
                        <th style={thStyle}>Pieces</th>
                        <th style={thStyle}>Monthly Visitors / Views</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cov.top_outlets.map(o => (
                        <tr key={o.name}>
                          <td style={tdStyle}>{o.name}</td>
                          <td style={tdStyle}><span style={tierColors[o.tier] || {}}>{o.tier}</span></td>
                          <td style={tdStyle}>{o.count}</td>
                          <td style={tdStyle}>{formatNumber(o.visitors)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Coverage items table */}
              {cov.items.length > 0 && (
                <div style={cardStyle}>
                  <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#334155', marginBottom: '12px' }}>Coverage Items ({cov.items.length})</h3>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={tableStyle}>
                      <thead>
                        <tr>
                          <th style={thStyle}>Date</th>
                          <th style={thStyle}>Outlet</th>
                          <th style={thStyle}>Tier</th>
                          <th style={thStyle}>Title</th>
                          <th style={thStyle}>Territory</th>
                          <th style={thStyle}>Type</th>
                          <th style={thStyle}>Metrics</th>
                          <th style={thStyle}>Score</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cov.items.map(item => (
                          <tr key={item.id}>
                            <td style={tdStyle}>{item.publish_date || '-'}</td>
                            <td style={tdStyle}>{(item.outlet as unknown as Record<string, string>)?.name || '-'}</td>
                            <td style={tdStyle}>
                              <span style={tierColors[(item.outlet as unknown as Record<string, string>)?.tier] || {}}>
                                {(item.outlet as unknown as Record<string, string>)?.tier || '-'}
                              </span>
                            </td>
                            <td style={{ ...tdStyle, maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer" style={{ color: '#3b82f6', textDecoration: 'none' }}>{item.title || item.url}</a> : (item.title || '-')}
                            </td>
                            <td style={tdStyle}>{item.territory || '-'}</td>
                            <td style={tdStyle}>{item.coverage_type || '-'}</td>
                            <td style={{ ...tdStyle, minWidth: '140px' }}>
                              {item.display_metrics && item.display_metrics.length > 0 ? (
                                <div>
                                  <div style={{ fontWeight: 600, fontSize: '12px' }}>
                                    {item.display_metrics[0].value.toLocaleString()}
                                    <span style={{ fontWeight: 400, color: '#64748b', marginLeft: '3px' }}>{item.display_metrics[0].label.toLowerCase()}</span>
                                  </div>
                                  {item.display_metrics.length > 1 && (
                                    <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                                      {item.display_metrics.slice(1).map(m => `${m.value.toLocaleString()} ${m.label.toLowerCase()}`).join(' · ')}
                                    </div>
                                  )}
                                </div>
                              ) : item.display_visitors ? (
                                <div>
                                  <div style={{ fontWeight: 600, fontSize: '12px' }}>{item.display_visitors.toLocaleString()}</div>
                                  <div style={{ fontSize: '11px', color: '#94a3b8' }}>monthly visitors</div>
                                </div>
                              ) : '-'}
                            </td>
                            <td style={tdStyle}>{item.review_score ?? '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* PR analysis */}
              <div style={cardStyle}>
                <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#334155', marginBottom: '12px' }}>PR Coverage Analysis</h3>
                <textarea
                  style={textareaStyle}
                  placeholder="Add your PR coverage analysis commentary here..."
                  value={annotations.pr_coverage || ''}
                  onChange={e => setAnnotations(prev => ({ ...prev, pr_coverage: e.target.value }))}
                />
                <div style={{ marginTop: '8px', display: 'flex', justifyContent: 'flex-end' }}>
                  <button style={{ ...btnPrimary, fontSize: '13px', padding: '6px 16px' }} onClick={() => saveAnnotation('pr_coverage')} disabled={savingAnnotation === 'pr_coverage'}>
                    {savingAnnotation === 'pr_coverage' ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* SOCIAL MEDIA TAB */}
          {activeTab === 'Social Media' && (
            <div>
              {reportData?.social && reportData.social.total_posts > 0 ? (
                <>
                  {/* Summary stats */}
                  <div style={cardStyle}>
                    <h2 style={{ fontSize: '18px', fontWeight: 600, color: '#1e293b', marginBottom: '16px' }}>Social Media Overview</h2>
                    <div style={statGrid}>
                      <div style={statCard}>
                        <div style={statValue}>{formatNumber(reportData.social.total_posts)}</div>
                        <div style={statLabel}>Total Posts</div>
                      </div>
                      <div style={statCard}>
                        <div style={statValue}>{formatNumber(reportData.social.total_reach)}</div>
                        <div style={statLabel}>Combined Followers</div>
                      </div>
                      <div style={statCard}>
                        <div style={statValue}>{formatNumber(reportData.social.total_engagement)}</div>
                        <div style={statLabel}>Total Engagement</div>
                      </div>
                      <div style={statCard}>
                        <div style={statValue}>{reportData.social.engagement_rate.toFixed(2)}%</div>
                        <div style={statLabel}>Engagement Rate</div>
                      </div>
                    </div>
                  </div>

                  {/* Platform breakdown */}
                  <div style={cardStyle}>
                    <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#334155', marginBottom: '12px' }}>By Platform</h3>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={tableStyle}>
                        <thead>
                          <tr>
                            <th style={thStyle}>Platform</th>
                            <th style={thStyle}>Posts</th>
                            <th style={{ ...thStyle, textAlign: 'right' }}>Followers / Subs</th>
                            <th style={{ ...thStyle, textAlign: 'right' }}>Views / Plays</th>
                            <th style={{ ...thStyle, textAlign: 'right' }}>Likes / Upvotes</th>
                            <th style={{ ...thStyle, textAlign: 'right' }}>Comments</th>
                            <th style={{ ...thStyle, textAlign: 'right' }}>Shares / RTs</th>
                          </tr>
                        </thead>
                        <tbody>
                          {reportData.social.platform_breakdown.map(ps => {
                            // Platforms where follower data isn't available from our scraper
                            const noFollowers = ps.platform === 'instagram' || ps.platform === 'reddit'
                            // Platforms where view data isn't available
                            const noViews = ps.platform === 'instagram' || ps.platform === 'reddit'
                            // Platforms where shares aren't applicable
                            const noShares = ps.platform === 'youtube' || ps.platform === 'twitch' || ps.platform === 'reddit' || ps.platform === 'instagram'
                            return (
                              <tr key={ps.platform}>
                                <td style={{ ...tdStyle, fontWeight: 500, textTransform: 'capitalize' }}>{ps.platform}</td>
                                <td style={tdStyle}>{ps.count}</td>
                                <td style={{ ...tdStyle, textAlign: 'right', color: noFollowers ? '#94a3b8' : undefined }}>
                                  {noFollowers ? '—' : formatNumber(ps.total_followers)}
                                </td>
                                <td style={{ ...tdStyle, textAlign: 'right', color: noViews ? '#94a3b8' : undefined }}>
                                  {noViews ? '—' : formatNumber(ps.total_views)}
                                </td>
                                <td style={{ ...tdStyle, textAlign: 'right' }}>{formatNumber(ps.total_likes)}</td>
                                <td style={{ ...tdStyle, textAlign: 'right' }}>{formatNumber(ps.total_comments)}</td>
                                <td style={{ ...tdStyle, textAlign: 'right', color: noShares && ps.total_shares === 0 ? '#94a3b8' : undefined }}>
                                  {noShares && ps.total_shares === 0 ? '—' : formatNumber(ps.total_shares)}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Sentiment + Top/Worst posts */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', marginBottom: '24px' }}>
                    {/* Sentiment breakdown */}
                    {reportData.social.sentiment_breakdown.length > 0 && (
                      <div style={breakCard}>
                        <div style={breakTitle}>Sentiment</div>
                        {reportData.social.sentiment_breakdown.map(s => (
                          <div key={s.name} style={breakItem}>
                            <span style={{ color: '#475569', textTransform: 'capitalize' }}>{s.name}</span>
                            <span style={{ fontWeight: 600, color: s.name === 'positive' ? '#16a34a' : s.name === 'negative' ? '#dc2626' : '#1e293b' }}>{s.value}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Best performing posts */}
                    <div style={breakCard}>
                      <div style={breakTitle}>Best Performing Posts</div>
                      {reportData.social.top_posts.slice(0, 5).map(post => (
                        <div key={post.id} style={{ ...breakItem, flexDirection: 'column', gap: '2px' }}>
                          <a href={post.url} target="_blank" rel="noopener noreferrer" style={{ color: '#3b82f6', textDecoration: 'none', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%', display: 'block' }}>
                            {post.title.length > 60 ? post.title.substring(0, 60) + '...' : post.title}
                          </a>
                          <span style={{ fontSize: '11px', color: '#64748b' }}>
                            {post.source_type} | {formatNumber(post.engagement)} engagement | {formatNumber(post.views)} views
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Top posts table */}
                  <div style={cardStyle}>
                    <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#334155', marginBottom: '12px' }}>Top Social Posts</h3>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={tableStyle}>
                        <thead>
                          <tr>
                            <th style={thStyle}>Platform</th>
                            <th style={thStyle}>Creator</th>
                            <th style={thStyle}>Post</th>
                            <th style={{ ...thStyle, textAlign: 'right' }}>Followers</th>
                            <th style={{ ...thStyle, textAlign: 'right' }}>Views</th>
                            <th style={{ ...thStyle, textAlign: 'right' }}>Likes</th>
                            <th style={{ ...thStyle, textAlign: 'right' }}>Engagement</th>
                          </tr>
                        </thead>
                        <tbody>
                          {reportData.social.top_posts.map(post => (
                            <tr key={post.id}>
                              <td style={{ ...tdStyle, textTransform: 'capitalize' }}>{post.source_type}</td>
                              <td style={tdStyle}>{post.outlet_name || '-'}</td>
                              <td style={{ ...tdStyle, maxWidth: '250px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                <a href={post.url} target="_blank" rel="noopener noreferrer" style={{ color: '#3b82f6', textDecoration: 'none' }}>
                                  {post.title.length > 50 ? post.title.substring(0, 50) + '...' : post.title}
                                </a>
                              </td>
                              <td style={{ ...tdStyle, textAlign: 'right' }}>{formatNumber(post.followers)}</td>
                              <td style={{ ...tdStyle, textAlign: 'right' }}>{formatNumber(post.views)}</td>
                              <td style={{ ...tdStyle, textAlign: 'right' }}>{formatNumber(post.likes)}</td>
                              <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>{formatNumber(post.engagement)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              ) : (
                <div style={{ ...cardStyle, textAlign: 'center', color: '#64748b', padding: '32px' }}>
                  No social media coverage found for this period. You can add manual stats below.
                </div>
              )}

              {/* Manual stat entry */}
              <div style={cardStyle}>
                <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#334155', marginBottom: '12px' }}>Manual Social Stats</h3>
                <p style={{ fontSize: '13px', color: '#64748b', marginBottom: '16px' }}>
                  Enter platform-specific metrics not automatically collected. These are saved per reporting period.
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '16px' }}>
                  {['Instagram', 'TikTok', 'Twitter/X', 'YouTube', 'Facebook', 'LinkedIn'].map(platform => {
                    const key = platform.toLowerCase().replace(/[\s/]/g, '_')
                    const stats = manualSocialStats[key] || {}
                    const updateStat = (field: string, value: string) => {
                      setManualSocialStats(prev => ({
                        ...prev,
                        [key]: { ...(prev[key] || {}), [field]: value },
                      }))
                    }
                    return (
                      <div key={platform} style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '16px' }}>
                        <div style={{ fontSize: '14px', fontWeight: 600, color: '#334155', marginBottom: '8px' }}>{platform}</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                          <div>
                            <label style={{ ...labelStyle, fontSize: '11px' }}>Followers</label>
                            <input style={{ ...inputStyle, width: '100%', fontSize: '13px' }} placeholder="0" value={stats.followers || ''} onChange={e => updateStat('followers', e.target.value)} />
                          </div>
                          <div>
                            <label style={{ ...labelStyle, fontSize: '11px' }}>Impressions</label>
                            <input style={{ ...inputStyle, width: '100%', fontSize: '13px' }} placeholder="0" value={stats.impressions || ''} onChange={e => updateStat('impressions', e.target.value)} />
                          </div>
                          <div>
                            <label style={{ ...labelStyle, fontSize: '11px' }}>Engagement</label>
                            <input style={{ ...inputStyle, width: '100%', fontSize: '13px' }} placeholder="0" value={stats.engagement || ''} onChange={e => updateStat('engagement', e.target.value)} />
                          </div>
                          <div>
                            <label style={{ ...labelStyle, fontSize: '11px' }}>Notes</label>
                            <input style={{ ...inputStyle, width: '100%', fontSize: '13px' }} placeholder="..." value={stats.notes || ''} onChange={e => updateStat('notes', e.target.value)} />
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
                <div style={{ marginTop: '12px', display: 'flex', justifyContent: 'flex-end' }}>
                  <button style={{ ...btnPrimary, fontSize: '13px', padding: '6px 16px' }} onClick={saveManualSocialStats} disabled={savingAnnotation === 'social_manual'}>
                    {savingAnnotation === 'social_manual' ? 'Saving...' : 'Save Manual Stats'}
                  </button>
                </div>
              </div>

              {/* Social analysis annotation */}
              <div style={cardStyle}>
                <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#334155', marginBottom: '12px' }}>Social Media Analysis</h3>
                <textarea
                  style={textareaStyle}
                  placeholder="Add your social media analysis commentary here..."
                  value={annotations.social || ''}
                  onChange={e => setAnnotations(prev => ({ ...prev, social: e.target.value }))}
                />
                <div style={{ marginTop: '8px', display: 'flex', justifyContent: 'flex-end' }}>
                  <button style={{ ...btnPrimary, fontSize: '13px', padding: '6px 16px' }} onClick={() => saveAnnotation('social')} disabled={savingAnnotation === 'social'}>
                    {savingAnnotation === 'social' ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* DATA TABLES TAB */}
          {activeTab === 'Data Tables' && (
            <div>
              <div style={cardStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                  <h2 style={{ fontSize: '18px', fontWeight: 600, color: '#1e293b' }}>Analytical Data Tables</h2>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button style={{ ...btnOutline, fontSize: '13px', padding: '6px 14px' }} onClick={exportCSV} disabled={!dtData || dtData.rows.length === 0}>
                      Export CSV
                    </button>
                  </div>
                </div>

                {/* Drill level + filters */}
                <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '16px' }}>
                  <div>
                    <label style={labelStyle}>Drill Down</label>
                    <select style={{ ...selectStyle, minWidth: '140px' }} value={dtDrill} onChange={e => { setDtDrill(e.target.value as typeof dtDrill); setDtPage(1) }}>
                      <option value="product">By Product + Platform</option>
                      <option value="game">By Product</option>
                      <option value="platform">By Platform</option>
                      <option value="country">By Country</option>
                      <option value="daily">By Day</option>
                    </select>
                  </div>
                  {dtData && dtData.filters.products.length > 1 && (
                    <div>
                      <label style={labelStyle}>Product</label>
                      <select style={{ ...selectStyle, minWidth: '160px' }} value={dtFilterProduct} onChange={e => { setDtFilterProduct(e.target.value); setDtPage(1) }}>
                        <option value="">All Products</option>
                        {dtData.filters.products.map(p => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </div>
                  )}
                  {dtData && dtData.filters.platforms.length > 1 && (
                    <div>
                      <label style={labelStyle}>Platform</label>
                      <select style={{ ...selectStyle, minWidth: '140px' }} value={dtFilterPlatform} onChange={e => { setDtFilterPlatform(e.target.value); setDtPage(1) }}>
                        <option value="">All Platforms</option>
                        {dtData.filters.platforms.map(p => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </div>
                  )}
                  {dtData && dtData.filters.countries.length > 1 && dtDrill !== 'country' && (
                    <div>
                      <label style={labelStyle}>Country</label>
                      <select style={{ ...selectStyle, minWidth: '120px' }} value={dtFilterCountry} onChange={e => { setDtFilterCountry(e.target.value); setDtPage(1) }}>
                        <option value="">All Countries</option>
                        {dtData.filters.countries.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                  )}
                  <div>
                    <label style={labelStyle}>Search</label>
                    <input
                      type="text" placeholder="Search..." style={{ ...inputStyle, minWidth: '160px' }}
                      value={dtSearch} onChange={e => { setDtSearch(e.target.value); setDtPage(1) }}
                    />
                  </div>
                </div>

                {/* Loading */}
                {dtLoading && (
                  <div style={{ textAlign: 'center', padding: '32px', color: '#64748b' }}>Loading data...</div>
                )}

                {/* Data table */}
                {dtData && !dtLoading && (
                  <>
                    {/* Summary row */}
                    <div style={{ display: 'flex', gap: '16px', marginBottom: '16px', flexWrap: 'wrap' }}>
                      <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: '8px', padding: '10px 16px', fontSize: '13px' }}>
                        <span style={{ color: '#64748b' }}>Total Rows: </span>
                        <strong>{formatNumber(dtData.pagination.total_rows)}</strong>
                      </div>
                      <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '8px', padding: '10px 16px', fontSize: '13px' }}>
                        <span style={{ color: '#64748b' }}>Net Revenue: </span>
                        <strong>{formatCurrency(dtData.totals.net_revenue)}</strong>
                      </div>
                      <div style={{ background: '#fefce8', border: '1px solid #fde68a', borderRadius: '8px', padding: '10px 16px', fontSize: '13px' }}>
                        <span style={{ color: '#64748b' }}>Net Units: </span>
                        <strong>{formatNumber(dtData.totals.net_units)}</strong>
                      </div>
                      <div style={{ background: '#fdf2f8', border: '1px solid #fbcfe8', borderRadius: '8px', padding: '10px 16px', fontSize: '13px' }}>
                        <span style={{ color: '#64748b' }}>Raw Data Points: </span>
                        <strong>{formatNumber(dtData.raw_row_count)}</strong>
                      </div>
                    </div>

                    {dtData.rows.length === 0 ? (
                      <div style={{ textAlign: 'center', padding: '48px', color: '#64748b' }}>No data matches your filters.</div>
                    ) : (
                      <div style={{ overflowX: 'auto' }}>
                        <table style={tableStyle}>
                          <thead>
                            <tr>
                              {getDrillColumns(dtDrill).map(col => (
                                <th key={col.key} style={{ ...thStyle, cursor: 'pointer', userSelect: 'none' }} onClick={() => handleDtSort(col.key)}>
                                  {col.label} {dtSortBy === col.key ? (dtSortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                                </th>
                              ))}
                              {[
                                { key: 'gross_revenue', label: 'Gross Rev' },
                                { key: 'net_revenue', label: 'Net Rev' },
                                { key: 'gross_units', label: 'Gross Units' },
                                { key: 'net_units', label: 'Net Units' },
                                { key: 'chargebacks', label: 'Chargebacks' },
                                { key: 'vat', label: 'VAT' },
                                { key: 'avg_price', label: 'Avg Price' },
                                { key: 'refund_rate', label: 'Refund %' },
                              ].map(col => (
                                <th key={col.key} style={{ ...thStyle, cursor: 'pointer', userSelect: 'none', textAlign: 'right' as const }} onClick={() => handleDtSort(col.key)}>
                                  {col.label} {dtSortBy === col.key ? (dtSortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {dtData.rows.map((row, idx) => (
                              <tr key={idx} style={{ background: idx % 2 === 0 ? '#fff' : '#fafafa' }}>
                                {getDrillColumns(dtDrill).map(col => (
                                  <td key={col.key} style={{ ...tdStyle, fontWeight: 500 }}>
                                    {String(row[col.key] || '-')}
                                  </td>
                                ))}
                                <td style={{ ...tdStyle, textAlign: 'right' }}>{formatCurrency(row.gross_revenue)}</td>
                                <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>{formatCurrency(row.net_revenue)}</td>
                                <td style={{ ...tdStyle, textAlign: 'right' }}>{formatNumber(row.gross_units)}</td>
                                <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>{formatNumber(row.net_units)}</td>
                                <td style={{ ...tdStyle, textAlign: 'right', color: row.chargebacks > 0 ? '#dc2626' : '#334155' }}>{formatNumber(row.chargebacks)}</td>
                                <td style={{ ...tdStyle, textAlign: 'right' }}>{formatCurrency(row.vat)}</td>
                                <td style={{ ...tdStyle, textAlign: 'right' }}>{formatCurrency(row.avg_price)}</td>
                                <td style={{ ...tdStyle, textAlign: 'right', color: row.refund_rate > 5 ? '#dc2626' : '#334155' }}>{row.refund_rate.toFixed(1)}%</td>
                              </tr>
                            ))}
                            {/* Totals row */}
                            <tr style={{ background: '#f1f5f9', fontWeight: 700 }}>
                              {getDrillColumns(dtDrill).map((col, i) => (
                                <td key={col.key} style={{ ...tdStyle, fontWeight: 700 }}>{i === 0 ? 'TOTALS' : ''}</td>
                              ))}
                              <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>{formatCurrency(dtData.totals.gross_revenue)}</td>
                              <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>{formatCurrency(dtData.totals.net_revenue)}</td>
                              <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>{formatNumber(dtData.totals.gross_units)}</td>
                              <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>{formatNumber(dtData.totals.net_units)}</td>
                              <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>{formatNumber(dtData.totals.chargebacks)}</td>
                              <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>{formatCurrency(dtData.totals.vat)}</td>
                              <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>{formatCurrency(dtData.totals.avg_price || 0)}</td>
                              <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}></td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* Pagination */}
                    {dtData.pagination.total_pages > 1 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '16px' }}>
                        <span style={{ fontSize: '13px', color: '#64748b' }}>
                          Showing {((dtData.pagination.page - 1) * dtData.pagination.page_size) + 1}–{Math.min(dtData.pagination.page * dtData.pagination.page_size, dtData.pagination.total_rows)} of {formatNumber(dtData.pagination.total_rows)}
                        </span>
                        <div style={{ display: 'flex', gap: '4px' }}>
                          <button
                            style={{ ...btnOutline, fontSize: '12px', padding: '4px 12px', opacity: dtData.pagination.page <= 1 ? 0.5 : 1 }}
                            disabled={dtData.pagination.page <= 1}
                            onClick={() => { setDtPage(dtData!.pagination.page - 1); fetchDataTable(dtData!.pagination.page - 1) }}
                          >Prev</button>
                          <span style={{ padding: '4px 12px', fontSize: '13px', color: '#475569' }}>
                            Page {dtData.pagination.page} of {dtData.pagination.total_pages}
                          </span>
                          <button
                            style={{ ...btnOutline, fontSize: '12px', padding: '4px 12px', opacity: dtData.pagination.page >= dtData.pagination.total_pages ? 0.5 : 1 }}
                            disabled={dtData.pagination.page >= dtData.pagination.total_pages}
                            onClick={() => { setDtPage(dtData!.pagination.page + 1); fetchDataTable(dtData!.pagination.page + 1) }}
                          >Next</button>
                        </div>
                      </div>
                    )}
                  </>
                )}

                {/* No client selected */}
                {!selectedClient && (
                  <div style={{ textAlign: 'center', padding: '48px', color: '#64748b' }}>
                    Select a client and click Generate Report to load data tables.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* No data states */}
          {activeTab === 'Sales Report' && !sales && (
            <div style={{ ...cardStyle, textAlign: 'center', color: '#64748b', padding: '48px' }}>
              No sales data found for the selected filters.
            </div>
          )}
          {activeTab === 'PR Coverage' && !cov && (
            <div style={{ ...cardStyle, textAlign: 'center', color: '#64748b', padding: '48px' }}>
              No coverage data found for the selected filters.
            </div>
          )}
          {activeTab === 'Social Media' && !reportData?.social && (
            <div style={{ ...cardStyle, textAlign: 'center', color: '#64748b', padding: '48px' }}>
              No social media data found. Social monitoring data will appear here when scrapers are active.
            </div>
          )}
        </>
      )}

      {/* Empty state */}
      {!reportData && !loading && (
        <div style={{ ...cardStyle, textAlign: 'center', color: '#64748b', padding: '64px' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>&#128202;</div>
          <div style={{ fontSize: '18px', fontWeight: 600, color: '#334155', marginBottom: '8px' }}>Generate a Client Report</div>
          <div>Select a client and period above, then click Generate Report to build a comprehensive performance report.</div>
        </div>
      )}

      {/* Export Modal */}
      {showExportModal && reportData && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setShowExportModal(false)}>
          <div style={{ background: '#fff', borderRadius: '12px', padding: '32px', width: '480px', maxWidth: '90vw', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }} onClick={e => e.stopPropagation()}>
            <h2 style={{ fontSize: '20px', fontWeight: 700, color: '#1e293b', marginBottom: '4px' }}>Export Report</h2>
            <p style={{ fontSize: '13px', color: '#64748b', marginBottom: '24px' }}>
              {reportData.client?.name} | {datePreset === 'custom' ? `${dateFrom} to ${dateTo}` : DATE_PRESETS.find(p => p.value === datePreset)?.label}
            </p>

            <div style={{ marginBottom: '24px' }}>
              <div style={{ fontSize: '14px', fontWeight: 600, color: '#334155', marginBottom: '12px' }}>Include Sections</div>
              {[
                { key: 'summary' as const, label: 'Executive Summary', available: true },
                { key: 'sales' as const, label: 'Sales Performance', available: !!reportData.sales },
                { key: 'pr_coverage' as const, label: 'PR Coverage', available: !!reportData.coverage },
                { key: 'social' as const, label: 'Social Media', available: !!(reportData.social && reportData.social.total_posts > 0) },
              ].map(sec => (
                <label key={sec.key} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 0', cursor: sec.available ? 'pointer' : 'not-allowed', opacity: sec.available ? 1 : 0.4 }}>
                  <input
                    type="checkbox"
                    checked={exportSections[sec.key] && sec.available}
                    onChange={e => setExportSections(prev => ({ ...prev, [sec.key]: e.target.checked }))}
                    disabled={!sec.available}
                    style={{ width: '16px', height: '16px' }}
                  />
                  <span style={{ fontSize: '14px', color: '#334155' }}>{sec.label}</span>
                  {!sec.available && <span style={{ fontSize: '11px', color: '#94a3b8' }}>(no data)</span>}
                </label>
              ))}
            </div>

            <div style={{ marginBottom: '16px', fontSize: '14px', fontWeight: 600, color: '#334155' }}>Export Format</div>
            <div style={{ display: 'flex', gap: '12px', marginBottom: '24px' }}>
              <button
                style={{ ...btnPrimary, flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', opacity: exporting ? 0.6 : 1 }}
                disabled={exporting}
                onClick={() => { exportPDF(exportSections); setShowExportModal(false) }}
              >
                PDF (Print)
              </button>
              <button
                style={{ ...btnPrimary, flex: 1, background: '#7c3aed', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', opacity: exporting ? 0.6 : 1 }}
                disabled={exporting}
                onClick={async () => { await exportPPTX(exportSections); setShowExportModal(false) }}
              >
                {exporting ? 'Generating...' : 'PowerPoint'}
              </button>
            </div>

            <button style={{ ...btnOutline, width: '100%' }} onClick={() => setShowExportModal(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
      </div>
    </div>
  )
}
