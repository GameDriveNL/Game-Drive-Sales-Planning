import type { DashboardWidget } from './types'

// ============================================
// UTILITY FUNCTIONS FOR SAFE NUMBER CONVERSION
// ============================================

export function toNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0
  if (typeof value === 'number') return isNaN(value) ? 0 : value
  const parsed = parseFloat(String(value).replace(/[$,]/g, ''))
  return isNaN(parsed) ? 0 : parsed
}

export function safeDivide(numerator: number, denominator: number): number {
  if (denominator === 0 || isNaN(denominator)) return 0
  const result = numerator / denominator
  return isNaN(result) ? 0 : result
}

export function isSalePrice(basePrice: number | string | null | undefined, salePrice: number | string | null | undefined): boolean {
  const base = toNumber(basePrice)
  const sale = toNumber(salePrice)
  return base > 0 && sale > 0 && sale < base
}

export function calculateDiscountPct(basePrice: number | string | null | undefined, salePrice: number | string | null | undefined): number | null {
  const base = toNumber(basePrice)
  const sale = toNumber(salePrice)
  if (base <= 0 || sale <= 0 || sale >= base) return null
  return Math.round((1 - sale / base) * 100)
}

// Default dashboard layout - comprehensive view
export const DEFAULT_WIDGETS: DashboardWidget[] = [
  // Top stats row - 5 compact cards
  { id: 'stat-revenue', type: 'stat', title: 'Total Revenue', config: { statKey: 'totalRevenue' }, position: { x: 0, y: 0 }, size: { w: 1, h: 1 } },
  { id: 'stat-units', type: 'stat', title: 'Total Units', config: { statKey: 'totalUnits' }, position: { x: 1, y: 0 }, size: { w: 1, h: 1 } },
  { id: 'stat-avg-rev', type: 'stat', title: 'Avg Daily Revenue', config: { statKey: 'avgDailyRevenue' }, position: { x: 2, y: 0 }, size: { w: 1, h: 1 } },
  { id: 'stat-avg-units', type: 'stat', title: 'Avg Daily Units', config: { statKey: 'avgDailyUnits' }, position: { x: 3, y: 0 }, size: { w: 1, h: 1 } },
  { id: 'stat-refund', type: 'stat', title: 'Refund Rate', config: { statKey: 'refundRate' }, position: { x: 4, y: 0 }, size: { w: 1, h: 1 } },
  // Charts row - Revenue Per Unit as pie chart, Revenue Over Time as line chart
  { id: 'revenue-pie-chart', type: 'pie', title: 'Revenue Per Unit', config: { chartType: 'pie' }, position: { x: 0, y: 1 }, size: { w: 1, h: 1 } },
  { id: 'chart-revenue', type: 'chart', title: 'Revenue Over Time', config: { chartType: 'line' }, position: { x: 1, y: 1 }, size: { w: 1, h: 1 } },
  // World map - full width
  { id: 'world-map', type: 'world-map', title: 'Revenue by Country', config: { mapType: 'choropleth' }, position: { x: 0, y: 2 }, size: { w: 2, h: 1 } },
  // Sale Performance comparison - full width
  { id: 'sale-performance', type: 'sale-comparison', title: 'Sale Performance Analysis', config: { chartType: 'stacked-bar' }, position: { x: 0, y: 3 }, size: { w: 2, h: 1 } },
  // Wishlist & Bundles widget - full width
  { id: 'wishlist-overview', type: 'wishlist', title: 'Steam Wishlists & Bundles', config: {}, position: { x: 0, y: 4 }, size: { w: 2, h: 1 } },
]
