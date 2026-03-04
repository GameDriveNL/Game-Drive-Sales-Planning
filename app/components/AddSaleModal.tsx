'use client'

import { useState, useEffect } from 'react'
import { format, addDays, parseISO, differenceInDays } from 'date-fns'
import { Sale, Platform, Product, Game, Client, SaleWithDetails } from '@/lib/types'
import { validateSale } from '@/lib/validation'
import SalePredictionPanel from './SalePredictionPanel'
import styles from './AddSaleModal.module.css'

interface AddSaleModalProps {
  products: (Product & { game: Game & { client: Client } })[]
  platforms: Platform[]
  existingSales: SaleWithDetails[]
  onSave: (sale: Omit<Sale, 'id' | 'created_at'>) => Promise<void>
  onClose: () => void
  initialDate?: Date
  initialProductId?: string
  initialPlatformId?: string
  initialEndDate?: Date
  initialSaleName?: string
  initialDiscountPercentage?: number
  initialSaleType?: string
}

// Database constraint: 'custom' | 'seasonal' | 'festival' | 'special'
type SaleType = 'custom' | 'seasonal' | 'festival' | 'special'

export default function AddSaleModal({
  products,
  platforms,
  existingSales,
  onSave,
  onClose,
  initialDate,
  initialProductId,
  initialPlatformId,
  initialEndDate,
  initialSaleName,
  initialDiscountPercentage,
  initialSaleType
}: AddSaleModalProps) {
  // Calculate initial duration from start and end dates
  const initialDuration = initialDate && initialEndDate
    ? differenceInDays(initialEndDate, initialDate) + 1
    : 7

  const [productId, setProductId] = useState(initialProductId || '')
  const [platformId, setPlatformId] = useState(initialPlatformId || '')
  const [startDate, setStartDate] = useState(
    initialDate ? format(initialDate, 'yyyy-MM-dd') : format(new Date(), 'yyyy-MM-dd')
  )
  const [duration, setDuration] = useState(initialDuration)
  const [endDate, setEndDate] = useState(
    initialEndDate ? format(initialEndDate, 'yyyy-MM-dd') :
    initialDate ? format(addDays(initialDate, initialDuration - 1), 'yyyy-MM-dd') :
    format(addDays(new Date(), 6), 'yyyy-MM-dd')
  )
  const [discountPercentage, setDiscountPercentage] = useState(initialDiscountPercentage ?? 50)
  const [saleName, setSaleName] = useState(initialSaleName || '')
  const [saleType, setSaleType] = useState<SaleType>((initialSaleType as SaleType) || 'custom')
  const [goalType, setGoalType] = useState<'acquisition' | 'visibility' | 'event' | 'revenue' | ''>('')
  const [notes, setNotes] = useState('')
  // New fields matching client's Excel workflow
  const [isCampaign, setIsCampaign] = useState(false)
  const [isSubmitted, setIsSubmitted] = useState(false)
  const [isConfirmed, setIsConfirmed] = useState(false)
  const [comment, setComment] = useState('')
  
  const [saving, setSaving] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [durationWarning, setDurationWarning] = useState<string | null>(null)
  const [discountWarning, setDiscountWarning] = useState<string | null>(null)

  const selectedPlatform = platforms.find(p => p.id === platformId)
  const selectedProduct = products.find(p => p.id === productId)
  
  // Calculate cooldown end date
  const cooldownEndDate = endDate && selectedPlatform
    ? format(addDays(parseISO(endDate), selectedPlatform.cooldown_days), 'yyyy-MM-dd')
    : ''

  // Find previous sale end date for this product/platform
  const prevSaleEndDate = (() => {
    if (!productId || !platformId || !startDate) return null
    const relevantSales = existingSales.filter(s => 
      s.product_id === productId && 
      s.platform_id === platformId &&
      s.end_date < startDate
    ).sort((a, b) => new Date(b.end_date).getTime() - new Date(a.end_date).getTime())
    return relevantSales.length > 0 ? relevantSales[0].end_date : null
  })()

  // Handle start date change - keep duration, update end date
  const handleStartDateChange = (newStartDate: string) => {
    setStartDate(newStartDate)
    if (newStartDate) {
      const newEndDate = format(addDays(parseISO(newStartDate), duration - 1), 'yyyy-MM-dd')
      setEndDate(newEndDate)
    }
  }

  // Handle duration change - update end date
  const handleDurationChange = (newDuration: number) => {
    const clampedDuration = Math.max(1, newDuration)
    setDuration(clampedDuration)
    if (startDate) {
      const newEndDate = format(addDays(parseISO(startDate), clampedDuration - 1), 'yyyy-MM-dd')
      setEndDate(newEndDate)
    }
  }

  // Handle end date change - update duration
  const handleEndDateChange = (newEndDate: string) => {
    setEndDate(newEndDate)
    if (startDate && newEndDate) {
      const newDuration = differenceInDays(parseISO(newEndDate), parseISO(startDate)) + 1
      setDuration(Math.max(1, newDuration))
    }
  }

  // Check duration warning (soft limit)
  // Compare using exclusive day count (matching Excel DAYS formula / platform conventions)
  useEffect(() => {
    const exclusiveDays = duration - 1
    if (selectedPlatform && exclusiveDays > selectedPlatform.max_sale_days) {
      setDurationWarning(`Exceeds platform recommendation of ${selectedPlatform.max_sale_days} days`)
    } else {
      setDurationWarning(null)
    }
  }, [selectedPlatform, duration])
  
  // Check discount warnings (historical max + platform bounds)
  useEffect(() => {
    const warnings: string[] = []

    // Historical max discount for this product+platform
    if (productId && platformId) {
      const historicalSales = existingSales.filter(s =>
        s.product_id === productId &&
        s.platform_id === platformId &&
        s.discount_percentage != null
      )
      if (historicalSales.length > 0) {
        const maxHistorical = Math.max(...historicalSales.map(s => s.discount_percentage || 0))
        if (discountPercentage > maxHistorical) {
          warnings.push(`Highest discount ever for this product/platform was ${maxHistorical}%`)
        }
      }
    }

    // Platform min/max discount bounds
    if (selectedPlatform) {
      if (selectedPlatform.min_discount_percent && discountPercentage < selectedPlatform.min_discount_percent) {
        warnings.push(`Below ${selectedPlatform.name} minimum of ${selectedPlatform.min_discount_percent}%`)
      }
      if (selectedPlatform.max_discount_percent && discountPercentage > selectedPlatform.max_discount_percent) {
        warnings.push(`Exceeds ${selectedPlatform.name} maximum of ${selectedPlatform.max_discount_percent}%`)
      }
    }

    setDiscountWarning(warnings.length > 0 ? warnings.join(' · ') : null)
  }, [productId, platformId, discountPercentage, existingSales, selectedPlatform])

  // Validate on change
  useEffect(() => {
    if (!productId || !platformId || !startDate || !endDate) {
      setValidationError(null)
      return
    }
    
    const platform = platforms.find(p => p.id === platformId)
    if (!platform) return
    
    const validation = validateSale(
      {
        product_id: productId,
        platform_id: platformId,
        start_date: startDate,
        end_date: endDate,
        sale_type: saleType
      },
      existingSales,
      platform
    )
    
    setValidationError(validation.valid ? null : validation.message || 'Conflicts with existing sale or cooldown')
  }, [productId, platformId, startDate, endDate, saleType, existingSales, platforms])
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (validationError) return
    if (!productId || !platformId || !startDate) return
    
    setSaving(true)
    
    try {
      await onSave({
        product_id: productId,
        platform_id: platformId,
        start_date: startDate,
        end_date: endDate,
        discount_percentage: discountPercentage,
        sale_name: saleName || 'Custom Sale',
        sale_type: saleType,
        status: 'planned',
        goal_type: goalType || undefined,
        notes: notes || undefined,
        is_campaign: isCampaign,
        is_submitted: isSubmitted,
        is_confirmed: isConfirmed,
        comment: comment || undefined,
        prev_sale_end_date: prevSaleEndDate || undefined
      })
    } catch (err) {
      console.error('Error saving sale:', err)
    } finally {
      setSaving(false)
    }
  }
  
  // Group products by game for easier selection
  const groupedProducts = products.reduce((acc, product) => {
    const gameName = product.game?.name || 'Unknown Game'
    if (!acc[gameName]) {
      acc[gameName] = []
    }
    acc[gameName].push(product)
    return acc
  }, {} as Record<string, typeof products>)
  
  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <h2>Add New Sale</h2>
          <button className={styles.closeBtn} onClick={onClose}>×</button>
        </div>
        
        {/* Pre-filled indicator */}
        {(initialProductId || initialPlatformId) && (
          <div className={styles.prefillNotice}>
            {selectedProduct && selectedPlatform ? (
              <>Creating sale for <strong>{selectedProduct.name}</strong> on <strong>{selectedPlatform.name}</strong></>
            ) : selectedProduct ? (
              <>Creating sale for <strong>{selectedProduct.name}</strong></>
            ) : (
              <>Creating sale from timeline selection</>
            )}
          </div>
        )}
        
        <form onSubmit={handleSubmit} className={styles.form}>
          {validationError && (
            <div className={styles.error}>
              <span>⚠️ {validationError}</span>
            </div>
          )}
          
          {durationWarning && (
            <div className={styles.warning}>
              <span>⚠️ {durationWarning}</span>
            </div>
          )}
          
          <div className={styles.row}>
            <div className={styles.field}>
              <label>Product *</label>
              <select 
                value={productId} 
                onChange={e => setProductId(e.target.value)}
                required
              >
                <option value="">Select a product...</option>
                {Object.entries(groupedProducts).map(([gameName, prods]) => (
                  <optgroup key={gameName} label={gameName}>
                    {prods.map(product => (
                      <option key={product.id} value={product.id}>
                        {product.name} ({product.product_type})
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            
            <div className={styles.field}>
              <label>Platform *</label>
              <select 
                value={platformId} 
                onChange={e => setPlatformId(e.target.value)}
                required
              >
                <option value="">Select a platform...</option>
                {platforms.map(platform => (
                  <option key={platform.id} value={platform.id}>
                    {platform.name} ({platform.cooldown_days}d cooldown)
                  </option>
                ))}
              </select>
            </div>
          </div>
          
          <div className={styles.row}>
            <div className={styles.field}>
              <label>Start Date *</label>
              <input 
                type="date" 
                value={startDate}
                onChange={e => handleStartDateChange(e.target.value)}
                required
              />
            </div>
            
            <div className={styles.field}>
              <label>Duration (days)</label>
              <input 
                type="number" 
                value={duration}
                onChange={e => handleDurationChange(parseInt(e.target.value) || 1)}
                min={1}
              />
              {selectedPlatform && (
                <span className={styles.hint}>Recommended: {selectedPlatform.max_sale_days} days max</span>
              )}
            </div>
            
            <div className={styles.field}>
              <label>End Date *</label>
              <input 
                type="date" 
                value={endDate}
                onChange={e => handleEndDateChange(e.target.value)}
                min={startDate}
                required
              />
            </div>
          </div>
          
          <div className={styles.row}>
            <div className={styles.field}>
              <label>Discount % *</label>
              <input 
                type="number" 
                value={discountPercentage}
                onChange={e => setDiscountPercentage(Math.max(5, Math.min(parseInt(e.target.value) || 5, 95)))}
                min={5}
                max={95}
                required
              />
              <span className={styles.hint}>5% - 95%</span>
              {discountWarning && (
                <span className={styles.hint} style={{ color: '#b45309', fontWeight: 600 }}>⚠️ {discountWarning}</span>
              )}
            </div>

            <div className={styles.field}>
              <label>Sale Name</label>
              <input 
                type="text" 
                value={saleName}
                onChange={e => setSaleName(e.target.value)}
                placeholder="e.g., Winter Sale, Daily Deal"
              />
            </div>
            
            <div className={styles.field}>
              <label>Sale Type</label>
              <select 
                value={saleType} 
                onChange={e => setSaleType(e.target.value as SaleType)}
              >
                <option value="custom">Custom / Regular</option>
                <option value="seasonal">Seasonal (Steam)</option>
                <option value="festival">Festival</option>
                <option value="special">Special Event</option>
              </select>
              {(saleType === 'seasonal' || saleType === 'special') && selectedPlatform?.special_sales_no_cooldown && (
                <span className={styles.hint}>✓ No cooldown for this sale type</span>
              )}
            </div>
          </div>
          
          {/* AI Prediction Panel */}
          {productId && platformId && selectedProduct && (
            <SalePredictionPanel
              productId={productId}
              platformId={platformId}
              clientId={selectedProduct.game?.client?.id || ''}
              discountPercentage={discountPercentage}
              durationDays={duration}
              startDate={startDate}
              goalType={goalType || undefined}
            />
          )}

          <div className={styles.row}>
            <div className={styles.field}>
              <label>Goal</label>
              <select
                value={goalType}
                onChange={e => setGoalType(e.target.value as typeof goalType)}
              >
                <option value="">Select goal...</option>
                <option value="acquisition">Acquisition</option>
                <option value="visibility">Visibility</option>
                <option value="event">Event</option>
                <option value="revenue">Revenue</option>
              </select>
            </div>

            <div className={styles.field}>
              <label>Cooldown Until</label>
              <input 
                type="text" 
                value={cooldownEndDate ? format(parseISO(cooldownEndDate), 'dd/MM/yyyy') : '-'}
                disabled
                className={styles.disabled}
              />
            </div>
            
            <div className={styles.field}>
              <label>Prev. Sale Ends</label>
              <input 
                type="text" 
                value={prevSaleEndDate ? format(parseISO(prevSaleEndDate), 'dd/MM/yyyy') : '-'}
                disabled
                className={styles.disabled}
              />
            </div>
          </div>

          {/* Checkboxes row */}
          <div className={styles.checkboxRow}>
            <label className={styles.checkboxLabel}>
              <input 
                type="checkbox" 
                checked={isCampaign}
                onChange={e => setIsCampaign(e.target.checked)}
              />
              <span>Campaign?</span>
            </label>
            
            <label className={styles.checkboxLabel}>
              <input 
                type="checkbox" 
                checked={isSubmitted}
                onChange={e => setIsSubmitted(e.target.checked)}
              />
              <span>Submitted?</span>
            </label>
            
            <label className={styles.checkboxLabel}>
              <input 
                type="checkbox" 
                checked={isConfirmed}
                onChange={e => setIsConfirmed(e.target.checked)}
              />
              <span>Confirmed?</span>
            </label>
          </div>
          
          <div className={styles.field + ' ' + styles.fullWidth}>
            <label>Comment</label>
            <textarea 
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder="Any comments about this sale..."
              rows={2}
            />
          </div>

          <div className={styles.field + ' ' + styles.fullWidth}>
            <label>Internal Notes</label>
            <textarea 
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Internal notes (not exported)..."
              rows={2}
            />
          </div>
          
          <div className={styles.actions}>
            <button type="button" className={styles.cancelBtn} onClick={onClose}>
              Cancel
            </button>
            <button 
              type="submit" 
              className={styles.saveBtn}
              disabled={saving || !!validationError || !productId || !platformId}
            >
              {saving ? 'Saving...' : 'Add Sale'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
