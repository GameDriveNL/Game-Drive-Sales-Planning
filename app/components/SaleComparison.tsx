'use client'

import { useState, useEffect, useMemo } from 'react'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import { format, parseISO } from 'date-fns'
import { SaleWithDetails, Platform } from '@/lib/types'
import * as XLSX from 'xlsx'
import styles from './SaleComparison.module.css'

interface SalePerformance {
  sale: SaleWithDetails
  revenue: number
  units: number
  revenueDelta: number | null // % change vs previous
  unitsDelta: number | null
}

interface SaleComparisonProps {
  sales: SaleWithDetails[]
  platforms: Platform[]
}

export default function SaleComparison({ sales, platforms }: SaleComparisonProps) {
  const supabase = createClientComponentClient()
  const [performanceData, setPerformanceData] = useState<Map<string, { revenue: number; units: number }>>(new Map())
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)

  // Group sales by product for comparison
  const salesByProduct = useMemo(() => {
    const grouped = new Map<string, SaleWithDetails[]>()
    const sorted = [...sales].sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime())
    sorted.forEach(sale => {
      const key = sale.product_id
      const existing = grouped.get(key) || []
      existing.push(sale)
      grouped.set(key, existing)
    })
    return grouped
  }, [sales])

  // Fetch actual performance data for sale periods
  const fetchPerformanceData = async () => {
    if (sales.length === 0) return
    setLoading(true)

    const perfMap = new Map<string, { revenue: number; units: number }>()

    for (const sale of sales) {
      const gameName = sale.product?.game?.name || sale.product?.name || ''
      if (!gameName) continue

      // Query analytics_data_view for this sale period
      const { data } = await supabase
        .from('analytics_data_view')
        .select('net_steam_sales_usd, net_units_sold')
        .ilike('product_name', `%${gameName}%`)
        .gte('date', sale.start_date)
        .lte('date', sale.end_date)

      if (data && data.length > 0) {
        const totalRevenue = data.reduce((sum, d) => sum + (Number(d.net_steam_sales_usd) || 0), 0)
        const totalUnits = data.reduce((sum, d) => sum + (Number(d.net_units_sold) || 0), 0)
        perfMap.set(sale.id, { revenue: totalRevenue, units: totalUnits })
      } else {
        perfMap.set(sale.id, { revenue: 0, units: 0 })
      }
    }

    setPerformanceData(perfMap)
    setLoaded(true)
    setLoading(false)
  }

  // Build comparison rows per product
  const comparisons = useMemo(() => {
    const results: { productName: string; gameName: string; clientName: string; platformName: string; rows: SalePerformance[] }[] = []

    salesByProduct.forEach((productSales, productId) => {
      const first = productSales[0]
      const platform = platforms.find(p => p.id === first.platform_id)
      const rows: SalePerformance[] = []

      productSales.forEach((sale, index) => {
        const perf = performanceData.get(sale.id) || { revenue: 0, units: 0 }
        let revenueDelta: number | null = null
        let unitsDelta: number | null = null

        if (index > 0) {
          const prevPerf = performanceData.get(productSales[index - 1].id) || { revenue: 0, units: 0 }
          if (prevPerf.revenue > 0) {
            revenueDelta = ((perf.revenue - prevPerf.revenue) / prevPerf.revenue) * 100
          }
          if (prevPerf.units > 0) {
            unitsDelta = ((perf.units - prevPerf.units) / prevPerf.units) * 100
          }
        }

        rows.push({ sale, revenue: perf.revenue, units: perf.units, revenueDelta, unitsDelta })
      })

      results.push({
        productName: first.product?.name || 'Unknown',
        gameName: first.product?.game?.name || '',
        clientName: first.product?.game?.client?.name || '',
        platformName: platform?.name || '',
        rows: rows.reverse(), // newest first
      })
    })

    return results.sort((a, b) => a.gameName.localeCompare(b.gameName))
  }, [salesByProduct, performanceData, platforms])

  const formatCurrency = (val: number) =>
    val === 0 ? '-' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }).format(val)

  const formatUnits = (val: number) =>
    val === 0 ? '-' : new Intl.NumberFormat('en-US').format(val)

  const exportToExcel = () => {
    const rows: Record<string, string | number>[] = []
    comparisons.forEach(group => {
      group.rows.forEach((row, idx) => {
        rows.push({
          'Game': group.gameName,
          'Product': group.productName,
          'Client': group.clientName,
          'Platform': group.platformName,
          'Sale Name': row.sale.sale_name || 'Custom',
          'Start Date': format(parseISO(row.sale.start_date), 'dd/MM/yyyy'),
          'End Date': format(parseISO(row.sale.end_date), 'dd/MM/yyyy'),
          'Discount %': row.sale.discount_percentage || 0,
          'Revenue': row.revenue,
          'Units Sold': row.units,
          'Revenue Change %': row.revenueDelta !== null ? Math.round(row.revenueDelta * 10) / 10 : '',
          'Units Change %': row.unitsDelta !== null ? Math.round(row.unitsDelta * 10) / 10 : '',
        })
      })
    })

    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.json_to_sheet(rows)
    ws['!cols'] = [
      { wch: 20 }, { wch: 20 }, { wch: 15 }, { wch: 12 }, { wch: 25 },
      { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 10 },
      { wch: 14 }, { wch: 14 },
    ]
    XLSX.utils.book_append_sheet(wb, ws, 'Sale Comparisons')
    XLSX.writeFile(wb, `sale_comparison_${format(new Date(), 'yyyy-MM-dd')}.xlsx`)
  }

  if (sales.length === 0) {
    return (
      <div className={styles.container}>
        <div className={styles.empty}>No sales to compare. Add sales to the timeline first.</div>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h3 className={styles.title}>Sale-over-Sale Comparison</h3>
          <p className={styles.subtitle}>
            Compare performance across sale periods for each product
          </p>
        </div>
        <div className={styles.actions}>
          {!loaded && (
            <button className={styles.loadBtn} onClick={fetchPerformanceData} disabled={loading}>
              {loading ? 'Loading...' : 'Load Performance Data'}
            </button>
          )}
          {loaded && (
            <button className={styles.exportBtn} onClick={exportToExcel}>
              Export Excel
            </button>
          )}
        </div>
      </div>

      {comparisons.map((group, gi) => (
        <div key={gi} className={styles.groupCard}>
          <div className={styles.groupHeader}>
            <div>
              <span className={styles.groupGame}>{group.gameName}</span>
              <span className={styles.groupProduct}>{group.productName}</span>
              {group.clientName && <span className={styles.groupClient}>{group.clientName}</span>}
            </div>
            <span className={styles.groupPlatform}>{group.platformName}</span>
          </div>

          <table className={styles.table}>
            <thead>
              <tr>
                <th>Sale / Period</th>
                <th>Dates</th>
                <th>Discount</th>
                <th>Revenue</th>
                <th>Units</th>
                <th>Rev vs Prev</th>
                <th>Units vs Prev</th>
              </tr>
            </thead>
            <tbody>
              {group.rows.map((row, ri) => {
                const isBaseline = ri === group.rows.length - 1
                return (
                  <tr key={row.sale.id}>
                    <td className={styles.saleName}>{row.sale.sale_name || 'Custom'}</td>
                    <td className={styles.dates}>
                      {format(parseISO(row.sale.start_date), 'dd/MM/yy')} — {format(parseISO(row.sale.end_date), 'dd/MM/yy')}
                    </td>
                    <td className={styles.discount}>
                      {row.sale.discount_percentage ? `${row.sale.discount_percentage}%` : '-'}
                    </td>
                    <td className={styles.revenue}>{formatCurrency(row.revenue)}</td>
                    <td className={styles.units}>{formatUnits(row.units)}</td>
                    <td>
                      {isBaseline ? (
                        <span className={styles.baseline}>baseline</span>
                      ) : row.revenueDelta !== null ? (
                        <span className={row.revenueDelta >= 0 ? styles.deltaPositive : styles.deltaNegative}>
                          {row.revenueDelta >= 0 ? '+' : ''}{Math.round(row.revenueDelta * 10) / 10}%
                        </span>
                      ) : (
                        <span className={styles.noData}>-</span>
                      )}
                    </td>
                    <td>
                      {isBaseline ? (
                        <span className={styles.baseline}>baseline</span>
                      ) : row.unitsDelta !== null ? (
                        <span className={row.unitsDelta >= 0 ? styles.deltaPositive : styles.deltaNegative}>
                          {row.unitsDelta >= 0 ? '+' : ''}{Math.round(row.unitsDelta * 10) / 10}%
                        </span>
                      ) : (
                        <span className={styles.noData}>-</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}

      {!loaded && (
        <div className={styles.hint}>
          Click &quot;Load Performance Data&quot; to fetch actual revenue and units from Steam/PlayStation analytics.
          Sale periods are already grouped and sorted by product for comparison.
        </div>
      )}
    </div>
  )
}
