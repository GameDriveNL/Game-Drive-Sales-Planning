import { addDays, addMonths, differenceInDays, parseISO, format, isAfter, isBefore } from 'date-fns'
import { Platform, PlatformEvent, SaleWithDetails } from '@/lib/types'

export interface GeneratedSale {
  id: string // temporary ID for preview
  product_id: string
  platform_id: string
  platform_name: string
  platform_color: string
  start_date: string
  end_date: string
  discount_percentage: number
  sale_name: string
  sale_type: 'custom' | 'seasonal' | 'festival' | 'special'
  is_event: boolean // Whether this is tied to a platform event
  event_name?: string
  cooldown_days: number // The cooldown that applies AFTER this sale
  // AI prediction fields (populated after generation)
  ai_prediction?: {
    predicted_revenue: number
    predicted_units: number
    confidence: 'low' | 'medium' | 'high'
    optimal_discount: number
    optimal_duration: number
    reasoning: string
    statistical_revenue: number
    sale_multiplier: number
  } | null
  use_ai_discount?: boolean // user toggle: accept AI discount or keep original
}

export interface CalendarVariation {
  name: string
  description: string
  sales: GeneratedSale[]
  stats: {
    totalSales: number
    totalDaysOnSale: number
    percentageOnSale: number
    eventSales: number
    customSales: number
  }
  // AI prediction fields (populated after predictions complete)
  is_ai_optimized?: boolean
  revenue_forecast?: {
    total_predicted_revenue: number
    total_predicted_units: number
    predictions_loaded: number
    predictions_total: number
  }
}

export interface GenerateCalendarParams {
  productId: string
  platforms: Platform[]
  platformEvents: PlatformEvent[]
  launchDate: string // ISO date string - start of calendar period
  defaultDiscount?: number
  existingSales?: SaleWithDetails[] // Existing sales to check against
  selectedPlatformIds?: string[] // Optional: Only generate for these platforms
  // Custom timeframe options (mutually exclusive, monthCount takes precedence)
  monthCount?: number // Number of months from launch date (default: 12)
  endDate?: string // ISO date string - custom end date for the period
  preferredStartDay?: number // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu(default), 5=Fri, 6=Sat
}

// Convert existing sale to GeneratedSale format for conflict checking
function existingSaleToGenerated(sale: SaleWithDetails): GeneratedSale {
  return {
    id: sale.id,
    product_id: sale.product_id,
    platform_id: sale.platform_id,
    platform_name: sale.platform?.name || '',
    platform_color: sale.platform?.color_hex || '#000',
    start_date: sale.start_date,
    end_date: sale.end_date,
    discount_percentage: sale.discount_percentage || 0,
    sale_name: sale.sale_name || '',
    sale_type: (sale.sale_type as 'custom' | 'seasonal' | 'festival' | 'special') || 'custom',
    is_event: false,
    cooldown_days: sale.platform?.cooldown_days || 0
  }
}

// Get platform events for a specific platform within a date range
function getEventsForPlatform(
  platformId: string,
  platformEvents: PlatformEvent[],
  periodStart: Date,
  periodEnd: Date
): PlatformEvent[] {
  return platformEvents.filter(event => {
    if (event.platform_id !== platformId) return false
    const eventStart = parseISO(event.start_date)
    const eventEnd = parseISO(event.end_date)
    // Check if event overlaps with the period
    return eventStart <= periodEnd && eventEnd >= periodStart
  }).sort((a, b) => parseISO(a.start_date).getTime() - parseISO(b.start_date).getTime())
}

// Check if a proposed sale conflicts with existing sales on SAME platform
// Uses the "10 AM rule" - last day of cooldown is a valid start day for new sale
function hasConflict(
  startDate: Date,
  endDate: Date,
  newSaleCooldownDays: number,
  existingSales: GeneratedSale[],
  platformId: string
): boolean {
  // Only check against sales on the SAME platform
  const samePlatformSales = existingSales.filter(s => s.platform_id === platformId)

  for (const existingSale of samePlatformSales) {
    const saleStart = parseISO(existingSale.start_date)
    const saleEnd = parseISO(existingSale.end_date)
    const saleCooldownDays = existingSale.cooldown_days || 0

    // Check 1: Direct overlap - new sale overlaps with existing sale period
    if (startDate <= saleEnd && endDate >= saleStart) {
      return true
    }

    // Check 2: New sale starts during existing sale's cooldown
    // 10 AM rule: Last day of cooldown IS valid for new sale to start
    // So we use < not <= for the cooldown check
    if (saleCooldownDays > 0) {
      const saleCooldownEnd = addDays(saleEnd, saleCooldownDays)
      // startDate must be AFTER saleEnd but BEFORE cooldownEnd (exclusive)
      if (isAfter(startDate, saleEnd) && isBefore(startDate, saleCooldownEnd)) {
        return true
      }
    }

    // Check 3: Existing sale starts during new sale's cooldown
    // Same 10 AM rule applies
    if (newSaleCooldownDays > 0) {
      const newSaleCooldownEnd = addDays(endDate, newSaleCooldownDays)
      // existingStart must be AFTER newEnd but BEFORE newCooldownEnd (exclusive)
      if (isAfter(saleStart, endDate) && isBefore(saleStart, newSaleCooldownEnd)) {
        return true
      }
    }
  }

  return false
}

// Snap a date forward to the next occurrence of the preferred day-of-week
// If the date is already on the preferred day, return it unchanged
function snapToPreferredDay(date: Date, preferredDay: number): Date {
  const currentDay = date.getDay() // 0=Sun ... 6=Sat
  if (currentDay === preferredDay) return date
  const daysToAdd = (preferredDay - currentDay + 7) % 7
  return addDays(date, daysToAdd)
}

// Find the next available date that won't cause any conflicts
function findNextAvailableDate(
  afterDate: Date,
  existingSales: GeneratedSale[],
  newSaleCooldownDays: number,
  periodEnd: Date,
  saleDuration: number,
  platformId: string,
  preferredStartDay?: number
): Date | null {
  let candidate = addDays(afterDate, 1)
  let iterations = 0
  const maxIterations = 500

  // Only consider sales on the same platform
  const samePlatformSales = existingSales.filter(s => s.platform_id === platformId)

  while (candidate <= periodEnd && iterations < maxIterations) {
    iterations++

    const potentialEnd = addDays(candidate, saleDuration - 1)
    const actualEnd = potentialEnd > periodEnd ? periodEnd : potentialEnd

    const conflict = hasConflict(candidate, actualEnd, newSaleCooldownDays, existingSales, platformId)

    if (!conflict) {
      // Snap to preferred day-of-week if specified
      if (preferredStartDay !== undefined) {
        const snapped = snapToPreferredDay(candidate, preferredStartDay)
        if (snapped > periodEnd) return null
        const snappedEnd = addDays(snapped, saleDuration - 1)
        const snappedActualEnd = snappedEnd > periodEnd ? periodEnd : snappedEnd
        if (!hasConflict(snapped, snappedActualEnd, newSaleCooldownDays, existingSales, platformId)) {
          return snapped
        }
        // If snapped position conflicts, continue searching from day after snapped
        candidate = addDays(snapped, 1)
        continue
      }
      return candidate
    }

    // Jump past blocking sales' cooldowns
    let nextPossible = addDays(candidate, 1)

    for (const sale of samePlatformSales) {
      const saleEnd = parseISO(sale.end_date)
      const saleCooldownDays = sale.cooldown_days || 0
      const saleCooldownEnd = addDays(saleEnd, saleCooldownDays)

      if (candidate <= saleCooldownEnd) {
        // Jump to the cooldown end day (which IS valid to start a new sale)
        const jumpTo = saleCooldownEnd
        if (isAfter(jumpTo, nextPossible)) {
          nextPossible = jumpTo
        }
      }
    }

    candidate = nextPossible
  }

  return null
}

// Generate sales for a single platform
function generatePlatformSales(
  productId: string,
  platform: Platform,
  platformEvents: PlatformEvent[],
  periodStart: Date,
  periodEnd: Date,
  defaultDiscount: number,
  variation: 'aggressive' | 'conservative',
  existingSales: GeneratedSale[],
  preferredStartDay?: number
): GeneratedSale[] {
  const newSales: GeneratedSale[] = []
  // Use platform max_sale_days as a default suggestion, but don't enforce it as a hard limit
  // This allows the auto-generator to create longer sales if needed
  const suggestedMaxDays = platform.max_sale_days || 14
  const platformCooldownDays = platform.cooldown_days || 0

  // Combine existing sales with new sales for conflict checking
  const allSales = [...existingSales]

  // Get events for this platform
  const events = getEventsForPlatform(platform.id, platformEvents, periodStart, periodEnd)

  // First, add all seasonal/special events
  for (const event of events) {
    const eventStart = parseISO(event.start_date)
    const eventEnd = parseISO(event.end_date)

    const saleStart = eventStart < periodStart ? periodStart : eventStart
    const saleEnd = eventEnd > periodEnd ? periodEnd : eventEnd

    // For event sales, use the full event duration - don't truncate based on max_sale_days
    // The max_sale_days is now a recommendation, not a hard limit
    const actualEnd = saleEnd

    const eventCooldownDays = event.requires_cooldown === false ? 0 : platformCooldownDays

    // Check against ALL sales (existing + newly generated)
    if (!hasConflict(saleStart, actualEnd, eventCooldownDays, allSales, platform.id)) {
      const newSale: GeneratedSale = {
        id: `gen-${productId}-${platform.id}-event-${event.id}`,
        product_id: productId,
        platform_id: platform.id,
        platform_name: platform.name,
        platform_color: platform.color_hex,
        start_date: format(saleStart, 'yyyy-MM-dd'),
        end_date: format(actualEnd, 'yyyy-MM-dd'),
        discount_percentage: defaultDiscount,
        sale_name: event.name,
        sale_type: 'seasonal',
        is_event: true,
        event_name: event.name,
        cooldown_days: eventCooldownDays
      }
      newSales.push(newSale)
      allSales.push(newSale)
    }
  }

  // For conservative: if no new event sales added, add at least one custom sale
  if (variation === 'conservative') {
    if (newSales.length === 0) {
      // Use a sensible default of 7 days for the launch sale, respecting platform suggestion
      const saleDuration = Math.min(suggestedMaxDays, 7)
      // Snap launch sale to preferred day if specified
      let launchStart = periodStart
      if (preferredStartDay !== undefined) {
        launchStart = snapToPreferredDay(periodStart, preferredStartDay)
        if (launchStart > periodEnd) return newSales
      }
      const saleEnd = addDays(launchStart, saleDuration - 1)

      if (!hasConflict(launchStart, saleEnd, platformCooldownDays, allSales, platform.id)) {
        newSales.push({
          id: `gen-${productId}-${platform.id}-custom-0`,
          product_id: productId,
          platform_id: platform.id,
          platform_name: platform.name,
          platform_color: platform.color_hex,
          start_date: format(launchStart, 'yyyy-MM-dd'),
          end_date: format(saleEnd, 'yyyy-MM-dd'),
          discount_percentage: defaultDiscount,
          sale_name: `${platform.name} Launch Sale`,
          sale_type: 'custom',
          is_event: false,
          cooldown_days: platformCooldownDays
        })
      }
    }
    return newSales
  }

  // For aggressive, fill gaps with custom sales back-to-back after cooldowns
  let customSaleCount = 0
  const maxCustomSales = 50
  const saleDuration = suggestedMaxDays

  let searchStart = addDays(periodStart, -1)

  while (customSaleCount < maxCustomSales) {
    const availableDate = findNextAvailableDate(
      searchStart,
      allSales,
      platformCooldownDays,
      periodEnd,
      saleDuration,
      platform.id,
      preferredStartDay
    )

    if (!availableDate || availableDate > periodEnd) break

    const potentialEnd = addDays(availableDate, saleDuration - 1)
    const actualEnd = potentialEnd > periodEnd ? periodEnd : potentialEnd

    if (!hasConflict(availableDate, actualEnd, platformCooldownDays, allSales, platform.id)) {
      const customSale: GeneratedSale = {
        id: `gen-${productId}-${platform.id}-custom-${customSaleCount}`,
        product_id: productId,
        platform_id: platform.id,
        platform_name: platform.name,
        platform_color: platform.color_hex,
        start_date: format(availableDate, 'yyyy-MM-dd'),
        end_date: format(actualEnd, 'yyyy-MM-dd'),
        discount_percentage: defaultDiscount,
        sale_name: customSaleCount === 0 && newSales.length === 0
          ? `${platform.name} Launch Sale`
          : `Custom Sale ${customSaleCount + 1}`,
        sale_type: 'custom',
        is_event: false,
        cooldown_days: platformCooldownDays
      }

      newSales.push(customSale)
      allSales.push(customSale)
      customSaleCount++

      // Start searching from the cooldown end of this sale
      searchStart = addDays(actualEnd, platformCooldownDays - 1)
    } else {
      searchStart = addDays(availableDate, 1)
    }
  }

  return newSales
}

// Calculate stats for a variation
function calculateStats(sales: GeneratedSale[], periodStart: Date, periodEnd: Date): CalendarVariation['stats'] {
  const totalDaysInPeriod = differenceInDays(periodEnd, periodStart) + 1
  let totalDaysOnSale = 0
  let eventSales = 0
  let customSales = 0

  for (const sale of sales) {
    const start = parseISO(sale.start_date)
    const end = parseISO(sale.end_date)
    totalDaysOnSale += differenceInDays(end, start) + 1

    if (sale.is_event) {
      eventSales++
    } else {
      customSales++
    }
  }

  return {
    totalSales: sales.length,
    totalDaysOnSale,
    percentageOnSale: Math.round((totalDaysOnSale / totalDaysInPeriod) * 100),
    eventSales,
    customSales
  }
}

// Main function to generate both variations (Maximize Sales + Events Only)
export function generateSaleCalendar(params: GenerateCalendarParams): CalendarVariation[] {
  const {
    productId,
    platforms,
    platformEvents,
    launchDate,
    defaultDiscount = 50,
    existingSales = [],
    selectedPlatformIds,
    monthCount,
    endDate,
    preferredStartDay
  } = params

  const periodStart = parseISO(launchDate)
  // Calculate period end: custom endDate > monthCount > default 12 months
  let periodEnd: Date
  if (endDate) {
    periodEnd = parseISO(endDate)
  } else {
    const months = monthCount || 12
    periodEnd = addDays(addMonths(periodStart, months), -1)
  }

  // Convert existing sales for this product to GeneratedSale format
  const existingForProduct = existingSales
    .filter(s => s.product_id === productId)
    .map(existingSaleToGenerated)

  // Filter platforms if selectedPlatformIds is provided
  const allPlatforms = selectedPlatformIds
    ? platforms.filter(p => selectedPlatformIds.includes(p.id))
    : platforms

  const variations: CalendarVariation[] = []

  const variationConfigs: { key: 'aggressive' | 'conservative'; name: string; description: string }[] = [
    {
      key: 'aggressive',
      name: 'Maximize Sales',
      description: 'Maximize days on sale with full-length sales chained back-to-back after cooldowns'
    },
    {
      key: 'conservative',
      name: 'Events Only',
      description: 'Participate only in platform seasonal events (plus one launch sale per platform without events)'
    }
  ]

  for (const config of variationConfigs) {
    const newSales: GeneratedSale[] = []

    for (const platform of allPlatforms) {
      const platformSales = generatePlatformSales(
        productId,
        platform,
        platformEvents,
        periodStart,
        periodEnd,
        defaultDiscount,
        config.key,
        [...existingForProduct, ...newSales],
        preferredStartDay
      )
      newSales.push(...platformSales)
    }

    // Sort all new sales by date
    newSales.sort((a, b) =>
      parseISO(a.start_date).getTime() - parseISO(b.start_date).getTime()
    )

    variations.push({
      name: config.name,
      description: config.description,
      sales: newSales, // Only return NEW sales, not existing ones
      stats: calculateStats(newSales, periodStart, periodEnd)
    })
  }

  return variations
}

// Helper to get default selected platforms (exclude 0-day cooldown)
export function getDefaultSelectedPlatforms(platforms: Platform[]): string[] {
  return platforms
    .filter(p => p.cooldown_days > 0)
    .map(p => p.id)
}

// Export utility to convert generated sales to actual sale creation format
export function generatedSaleToCreateFormat(sale: GeneratedSale) {
  return {
    product_id: sale.product_id,
    platform_id: sale.platform_id,
    start_date: sale.start_date,
    end_date: sale.end_date,
    discount_percentage: sale.discount_percentage,
    sale_name: sale.sale_name,
    sale_type: sale.sale_type,
    status: 'planned' as const
  }
}
