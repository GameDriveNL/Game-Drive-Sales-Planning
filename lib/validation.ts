import { Sale, Platform, ValidationResult } from './types'
import { addDays, isBefore, isAfter } from 'date-fns'
import { normalizeToLocalDate } from './dateUtils'

export function validateSale(
  newSale: {
    product_id: string
    platform_id: string
    start_date: string
    end_date: string
    sale_type?: 'custom' | 'seasonal' | 'festival' | 'special'
  },
  existingSales: Sale[],
  platform: Platform,
  excludeSaleId?: string // For editing existing sales
): ValidationResult {
  // B3/B4: normalize all dates to local-timezone midnight via normalizeToLocalDate.
  // Previously used parseISO which returns UTC midnight; mixing with normalizeToLocalDate
  // elsewhere (timeline display, gap analysis) could produce off-by-one cooldown windows
  // in non-UTC timezones (e.g. the "7PM CEST" symptom).
  const newStart = normalizeToLocalDate(newSale.start_date)
  const newEnd = normalizeToLocalDate(newSale.end_date)
  
  // Filter to same product + platform, excluding the sale being edited
  const relevantSales = existingSales.filter(sale => 
    sale.product_id === newSale.product_id &&
    sale.platform_id === newSale.platform_id &&
    sale.id !== excludeSaleId
  )
  
  const conflicts: Sale[] = []
  const cooldownDays = platform.cooldown_days || 0
  
  // Skip cooldown check for special sales if platform allows
  const skipCooldown = (newSale.sale_type === 'seasonal' || newSale.sale_type === 'special') && 
                        platform.special_sales_no_cooldown
  
  for (const existingSale of relevantSales) {
    const existingStart = normalizeToLocalDate(existingSale.start_date)
    const existingEnd = normalizeToLocalDate(existingSale.end_date)
    
    // Check 1: Direct overlap (sales can't run at the same time)
    if (doPeriodsOverlap(newStart, newEnd, existingStart, existingEnd)) {
      conflicts.push(existingSale)
      continue
    }
    
    if (skipCooldown) continue
    
    // Check 2: New sale starts during existing sale's cooldown
    // 10 AM rule: The cooldown end day IS valid for starting a new sale
    // So if cooldown is 30 days, new sale can start on day 30 (but not days 1-29)
    if (cooldownDays > 0) {
      // existingCooldownEnd = the first day a new sale CAN start after existing sale
      const existingCooldownEnd = addDays(existingEnd, cooldownDays)
      
      // If new sale starts after existing ends but before cooldown ends - CONFLICT
      if (isAfter(newStart, existingEnd) && isBefore(newStart, existingCooldownEnd)) {
        conflicts.push(existingSale)
        continue
      }
    }
    
    // Check 3: Existing sale starts during new sale's cooldown (reverse check)
    if (cooldownDays > 0) {
      const newCooldownEnd = addDays(newEnd, cooldownDays)
      
      // If existing sale starts after new sale ends but before new cooldown ends - CONFLICT
      if (isAfter(existingStart, newEnd) && isBefore(existingStart, newCooldownEnd)) {
        conflicts.push(existingSale)
        continue
      }
    }
  }
  
  const cooldownEnd = addDays(newEnd, cooldownDays)
  
  return {
    valid: conflicts.length === 0,
    conflicts,
    cooldownEnd: cooldownEnd.toISOString(),
    message: conflicts.length > 0 
      ? `Sale conflicts with ${conflicts.length} existing sale(s) or cooldown period(s)`
      : undefined
  }
}

function doPeriodsOverlap(start1: Date, end1: Date, start2: Date, end2: Date): boolean {
  return !(isAfter(start1, end2) || isAfter(start2, end1))
}

export function calculateCooldownPeriod(
  saleEndDate: string,
  cooldownDays: number
): { start: string; end: string } {
  const endDate = normalizeToLocalDate(saleEndDate)
  const cooldownStart = addDays(endDate, 1)
  const cooldownEnd = addDays(endDate, cooldownDays)

  // Use local date format directly — avoids the toISOString().split('T')[0]
  // pattern which can shift the date by one day in negative-UTC timezones
  const y = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return {
    start: y(cooldownStart),
    end: y(cooldownEnd)
  }
}
