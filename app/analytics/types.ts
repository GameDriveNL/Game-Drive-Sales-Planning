// Analytics page types

export interface PerformanceData {
  id: string
  client_id: string
  date: string
  bundle_name: string | null
  product_name: string
  product_type: string | null
  game: string | null
  platform: string
  country_code: string | null
  country: string | null
  region: string | null
  gross_units_sold: number | string
  chargebacks_returns: number | string
  net_units_sold: number | string
  base_price_usd: number | string | null
  sale_price_usd: number | string | null
  gross_steam_sales_usd: number | string
  chargeback_returns_usd: number | string
  vat_tax_usd: number | string
  net_steam_sales_usd: number | string
}

export interface SummaryStats {
  totalRevenue: number
  totalUnits: number
  avgDailyRevenue: number
  avgDailyUnits: number
  refundRate: number
  totalDays: number
}

export interface DateRange {
  start: Date | null
  end: Date | null
}

export interface DailyData {
  date: string
  revenue: number
  units: number
  isSale: boolean
}

export interface RegionData {
  region: string
  revenue: number
  units: number
  percentage: number
}

export interface CountryData {
  country: string
  revenue: number
  units: number
  percentage: number
  avgPrice: number
}

export interface GrowthData {
  currentRevenue: number
  currentUnits: number
  previousRevenue: number
  previousUnits: number
  revenueGrowth: number
  unitsGrowth: number
  avgPriceCurrent: number
  avgPricePrevious: number
}

export interface PeriodData {
  name: string
  startDate: string
  endDate: string
  days: number
  totalRevenue: number
  totalUnits: number
  avgDailyRevenue: number
  avgDailyUnits: number
  isSale: boolean
  discountPct: number | null
  saleName: string | null
  saleType: string | null
  plannedDiscount: number | null
  source: 'price-detected' | 'committed' | 'both'
}

export interface CurrentPeriodState {
  dates: string[]
  revenue: number
  units: number
  isSale: boolean
  discountPct: number | null
  saleName: string | null
  saleType: string | null
  plannedDiscount: number | null
  source: 'price-detected' | 'committed' | 'both'
}

export interface CommittedSaleSnapshot {
  product_id: string
  platform_id: string
  start_date: string
  end_date: string
  discount_percentage: number | null
  sale_name: string | null
  sale_type: string
  status: string
  notes: string | null
  product_name?: string
  platform_name?: string
}

export interface CommittedVersion {
  id: string
  name: string
  sales_snapshot: CommittedSaleSnapshot[]
  committed_at: string
}

// Widget Types for editable dashboard
export interface DashboardWidget {
  id: string
  type: 'stat' | 'chart' | 'table' | 'region' | 'countries' | 'growth' | 'growth-line' | 'avg-price' | 'pie' | 'world-map' | 'heatmap' | 'sale-comparison' | 'wishlist'
  title: string
  config: {
    statKey?: string
    chartType?: 'bar' | 'line' | 'pie' | 'area' | 'donut' | 'choropleth' | 'stacked-bar' | 'horizontal-bar'

    mapType?: string
    // Filter options
    filterProduct?: string
    filterClient?: string
    filterRegion?: string
    filterPlatform?: string
    // Display options
    showLegend?: boolean
    showGrid?: boolean
    colorScheme?: 'blue' | 'green' | 'purple' | 'multi'
    // Aggregation options
    aggregateBy?: 'sum' | 'avg' | 'min' | 'max'
    groupBy?: 'day' | 'week' | 'month' | 'quarter' | 'year'
  }
  position: { x: number; y: number }
  size: { w: number; h: number }
}
