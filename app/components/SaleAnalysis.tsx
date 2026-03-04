'use client'

import { useMemo } from 'react'
import { format, parseISO, differenceInDays } from 'date-fns'
import { SaleWithDetails, Platform } from '@/lib/types'
import SaleComparison from './SaleComparison'
import styles from './SaleAnalysis.module.css'

interface SaleAnalysisProps {
  sales: SaleWithDetails[]
  platforms: Platform[]
}

export default function SaleAnalysis({ sales, platforms }: SaleAnalysisProps) {
  const stats = useMemo(() => {
    if (sales.length === 0) return null

    // Duration stats
    const durations = sales.map(s => differenceInDays(parseISO(s.end_date), parseISO(s.start_date)) + 1)
    const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length
    const minDuration = Math.min(...durations)
    const maxDuration = Math.max(...durations)

    // Discount stats
    const discounts = sales.filter(s => s.discount_percentage).map(s => Number(s.discount_percentage))
    const avgDiscount = discounts.length > 0 ? discounts.reduce((a, b) => a + b, 0) / discounts.length : 0

    // Discount distribution buckets
    const discountBuckets = { '0-20%': 0, '21-40%': 0, '41-60%': 0, '61-80%': 0, '81-100%': 0 }
    discounts.forEach(d => {
      if (d <= 20) discountBuckets['0-20%']++
      else if (d <= 40) discountBuckets['21-40%']++
      else if (d <= 60) discountBuckets['41-60%']++
      else if (d <= 80) discountBuckets['61-80%']++
      else discountBuckets['81-100%']++
    })

    // Platform breakdown
    const platformCounts = new Map<string, { name: string; color: string; count: number }>()
    sales.forEach(s => {
      const plat = platforms.find(p => p.id === s.platform_id)
      const name = plat?.name || 'Unknown'
      const existing = platformCounts.get(name)
      if (existing) existing.count++
      else platformCounts.set(name, { name, color: plat?.color_hex || '#94a3b8', count: 1 })
    })

    // Game breakdown
    const gameCounts = new Map<string, { name: string; client: string; count: number }>()
    sales.forEach(s => {
      const gameName = s.product?.game?.name || 'Unknown'
      const clientName = s.product?.game?.client?.name || ''
      const existing = gameCounts.get(gameName)
      if (existing) existing.count++
      else gameCounts.set(gameName, { name: gameName, client: clientName, count: 1 })
    })

    // Status rates
    const campaignCount = sales.filter(s => s.is_campaign).length
    const submittedCount = sales.filter(s => s.is_submitted).length
    const confirmedCount = sales.filter(s => s.is_confirmed).length

    // Date range
    const sortedByStart = [...sales].sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime())
    const earliest = sortedByStart[0].start_date
    const sortedByEnd = [...sales].sort((a, b) => new Date(b.end_date).getTime() - new Date(a.end_date).getTime())
    const latest = sortedByEnd[0].end_date

    // Goal type breakdown
    const goalCounts = new Map<string, number>()
    sales.forEach(s => {
      const goal = s.goal_type || 'none'
      goalCounts.set(goal, (goalCounts.get(goal) || 0) + 1)
    })

    return {
      total: sales.length,
      avgDuration: Math.round(avgDuration * 10) / 10,
      minDuration,
      maxDuration,
      avgDiscount: Math.round(avgDiscount * 10) / 10,
      discountBuckets,
      platformBreakdown: Array.from(platformCounts.values()).sort((a, b) => b.count - a.count),
      gameBreakdown: Array.from(gameCounts.values()).sort((a, b) => b.count - a.count),
      campaignCount,
      submittedCount,
      confirmedCount,
      campaignRate: Math.round((campaignCount / sales.length) * 100),
      submittedRate: Math.round((submittedCount / sales.length) * 100),
      confirmedRate: Math.round((confirmedCount / sales.length) * 100),
      earliest,
      latest,
      goalBreakdown: Array.from(goalCounts.entries())
        .map(([goal, count]) => ({ goal, count }))
        .sort((a, b) => b.count - a.count),
    }
  }, [sales, platforms])

  if (!stats) {
    return (
      <div className={styles.container}>
        <div className={styles.empty}>No sales data to analyze. Add sales to see analysis.</div>
      </div>
    )
  }

  const maxPlatformCount = Math.max(...stats.platformBreakdown.map(p => p.count))
  const maxGameCount = Math.max(...stats.gameBreakdown.map(g => g.count))
  const maxDiscountBucket = Math.max(...Object.values(stats.discountBuckets))

  return (
    <div className={styles.container}>
      {/* Key Metrics Row */}
      <div className={styles.metricsRow}>
        <div className={styles.metricCard}>
          <div className={styles.metricValue}>{stats.total}</div>
          <div className={styles.metricLabel}>Total Sales</div>
        </div>
        <div className={styles.metricCard}>
          <div className={styles.metricValue}>{stats.avgDuration}d</div>
          <div className={styles.metricLabel}>Avg Duration</div>
          <div className={styles.metricSub}>{stats.minDuration}–{stats.maxDuration} day range</div>
        </div>
        <div className={styles.metricCard}>
          <div className={styles.metricValue}>{stats.avgDiscount}%</div>
          <div className={styles.metricLabel}>Avg Discount</div>
        </div>
        <div className={styles.metricCard}>
          <div className={styles.metricValue}>{stats.confirmedRate}%</div>
          <div className={styles.metricLabel}>Confirmed</div>
          <div className={styles.metricSub}>{stats.confirmedCount} of {stats.total}</div>
        </div>
        <div className={styles.metricCard}>
          <div className={styles.metricValue}>{stats.submittedRate}%</div>
          <div className={styles.metricLabel}>Submitted</div>
          <div className={styles.metricSub}>{stats.submittedCount} of {stats.total}</div>
        </div>
      </div>

      <div className={styles.dateRange}>
        Covering {format(parseISO(stats.earliest), 'dd MMM yyyy')} — {format(parseISO(stats.latest), 'dd MMM yyyy')}
      </div>

      {/* Detail Panels */}
      <div className={styles.panelsGrid}>
        {/* Platform Breakdown */}
        <div className={styles.panel}>
          <h4 className={styles.panelTitle}>By Platform</h4>
          <div className={styles.barList}>
            {stats.platformBreakdown.map(p => (
              <div key={p.name} className={styles.barItem}>
                <div className={styles.barLabel}>
                  <span className={styles.platformDot} style={{ backgroundColor: p.color }} />
                  {p.name}
                </div>
                <div className={styles.barTrack}>
                  <div
                    className={styles.barFill}
                    style={{
                      width: `${(p.count / maxPlatformCount) * 100}%`,
                      backgroundColor: p.color,
                    }}
                  />
                </div>
                <span className={styles.barCount}>{p.count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Game Breakdown */}
        <div className={styles.panel}>
          <h4 className={styles.panelTitle}>By Game</h4>
          <div className={styles.barList}>
            {stats.gameBreakdown.map(g => (
              <div key={g.name} className={styles.barItem}>
                <div className={styles.barLabel}>
                  <span className={styles.gameLabelText}>{g.name}</span>
                  {g.client && <span className={styles.clientTag}>{g.client}</span>}
                </div>
                <div className={styles.barTrack}>
                  <div
                    className={styles.barFill}
                    style={{
                      width: `${(g.count / maxGameCount) * 100}%`,
                      backgroundColor: '#6366f1',
                    }}
                  />
                </div>
                <span className={styles.barCount}>{g.count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Discount Distribution */}
        <div className={styles.panel}>
          <h4 className={styles.panelTitle}>Discount Distribution</h4>
          <div className={styles.barList}>
            {Object.entries(stats.discountBuckets).map(([bucket, count]) => (
              <div key={bucket} className={styles.barItem}>
                <div className={styles.barLabel}>{bucket}</div>
                <div className={styles.barTrack}>
                  <div
                    className={styles.barFill}
                    style={{
                      width: maxDiscountBucket > 0 ? `${(count / maxDiscountBucket) * 100}%` : '0%',
                      backgroundColor: '#f59e0b',
                    }}
                  />
                </div>
                <span className={styles.barCount}>{count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Status & Goals */}
        <div className={styles.panel}>
          <h4 className={styles.panelTitle}>Status & Goals</h4>
          <div className={styles.statusGrid}>
            <div className={styles.statusItem}>
              <div className={styles.statusBar}>
                <div className={styles.statusFill} style={{ width: `${stats.campaignRate}%`, backgroundColor: '#3b82f6' }} />
              </div>
              <span className={styles.statusLabel}>Campaign: {stats.campaignCount} ({stats.campaignRate}%)</span>
            </div>
            <div className={styles.statusItem}>
              <div className={styles.statusBar}>
                <div className={styles.statusFill} style={{ width: `${stats.submittedRate}%`, backgroundColor: '#f59e0b' }} />
              </div>
              <span className={styles.statusLabel}>Submitted: {stats.submittedCount} ({stats.submittedRate}%)</span>
            </div>
            <div className={styles.statusItem}>
              <div className={styles.statusBar}>
                <div className={styles.statusFill} style={{ width: `${stats.confirmedRate}%`, backgroundColor: '#10b981' }} />
              </div>
              <span className={styles.statusLabel}>Confirmed: {stats.confirmedCount} ({stats.confirmedRate}%)</span>
            </div>
          </div>
          {stats.goalBreakdown.length > 0 && (
            <>
              <h4 className={styles.panelSubtitle}>Goal Types</h4>
              <div className={styles.goalList}>
                {stats.goalBreakdown.map(g => (
                  <div key={g.goal} className={styles.goalItem}>
                    <span className={`${styles.goalBadge} ${g.goal !== 'none' ? styles[g.goal] : ''}`}>
                      {g.goal === 'none' ? 'No goal' : g.goal}
                    </span>
                    <span className={styles.goalCount}>{g.count}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Sale-over-Sale Comparison */}
      <div className={styles.comparisonSection}>
        <SaleComparison sales={sales} platforms={platforms} />
      </div>
    </div>
  )
}
