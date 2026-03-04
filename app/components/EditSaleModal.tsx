'use client'

import { useState, useEffect } from 'react'
import { format, addDays, parseISO, differenceInDays } from 'date-fns'
import { Sale, Platform, Product, Game, Client, SaleWithDetails } from '@/lib/types'
import { validateSale } from '@/lib/validation'
import SalePredictionPanel from './SalePredictionPanel'
import styles from './AddSaleModal.module.css'

interface EditSaleModalProps {
  sale: SaleWithDetails
  products: (Product & { game: Game & { client: Client } })[]
  platforms: Platform[]
  existingSales: SaleWithDetails[]
  onSave: (saleId: string, updates: Partial<Sale>) => Promise<void>
  onDelete: (saleId: string) => Promise<void>
  onDuplicate?: (sale: SaleWithDetails) => void
  onClose: () => void
}

type SaleType = 'custom' | 'seasonal' | 'festival' | 'special'
type SaleStatus = 'planned' | 'submitted' | 'confirmed' | 'live' | 'ended'

export default function EditSaleModal({
  sale,
  products,
  platforms,
  existingSales,
  onSave,
  onDelete,
  onDuplicate,
  onClose
}: EditSaleModalProps) {
  const [productId, setProductId] = useState(sale.product_id)
  const [platformId, setPlatformId] = useState(sale.platform_id)
  const [startDate, setStartDate] = useState(sale.start_date)
  const [duration, setDuration] = useState(
    differenceInDays(parseISO(sale.end_date), parseISO(sale.start_date)) + 1
  )
  const [endDate, setEndDate] = useState(sale.end_date)
  const [discountPercentage, setDiscountPercentage] = useState(sale.discount_percentage || 50)
  const [saleName, setSaleName] = useState(sale.sale_name || '')
  const [saleType, setSaleType] = useState<SaleType>(sale.sale_type || 'custom')
  const [status, setStatus] = useState<SaleStatus>(sale.status || 'planned')
  const [goalType, setGoalType] = useState<'acquisition' | 'visibility' | 'event' | 'revenue' | ''>(
    sale.goal_type || ''
  )
  const [notes, setNotes] = useState(sale.notes || '')
  // New fields matching client's Excel workflow
  const [isCampaign, setIsCampaign] = useState(sale.is_campaign || false)
  const [isSubmitted, setIsSubmitted] = useState(sale.is_submitted || false)
  const [isConfirmed, setIsConfirmed] = useState(sale.is_confirmed || false)
  const [comment, setComment] = useState(sale.comment || '')
  
  const [saving, setSaving] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [durationWarning, setDurationWarning] = useState<string | null>(null)
  const [discountWarning, setDiscountWarning] = useState<string | null>(null)

  const selectedPlatform = platforms.find(p => p.id === platformId)
  
  // Calculate cooldown end date
  const cooldownEndDate = endDate && selectedPlatform
    ? format(addDays(parseISO(endDate), selectedPlatform.cooldown_days), 'yyyy-MM-dd')
    : ''

  // Find previous sale end date for this product/platform
  const prevSaleEndDate = (() => {
    if (!productId || !platformId || !startDate) return sale.prev_sale_end_date || null
    const relevantSales = existingSales.filter(s => 
      s.product_id === productId && 
      s.platform_id === platformId &&
      s.end_date < startDate &&
      s.id !== sale.id
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

    // Historical max discount for this product+platform (exclude current sale)
    if (productId && platformId) {
      const historicalSales = existingSales.filter(s =>
        s.product_id === productId &&
        s.platform_id === platformId &&
        s.id !== sale.id &&
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
  }, [productId, platformId, discountPercentage, existingSales, selectedPlatform, sale.id])

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
      platform,
      sale.id // Exclude current sale from validation
    )
    
    setValidationError(validation.valid ? null : validation.message || 'Conflicts with existing sale or cooldown')
  }, [productId, platformId, startDate, endDate, saleType, existingSales, platforms, sale.id])
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (validationError) return
    if (!productId || !platformId || !startDate) return
    
    setSaving(true)
    
    try {
      await onSave(sale.id, {
        product_id: productId,
        platform_id: platformId,
        start_date: startDate,
        end_date: endDate,
        discount_percentage: discountPercentage,
        sale_name: saleName || 'Custom Sale',
        sale_type: saleType,
        status: status,
        goal_type: goalType || undefined,
        notes: notes || undefined,
        is_campaign: isCampaign,
        is_submitted: isSubmitted,
        is_confirmed: isConfirmed,
        comment: comment || undefined,
        prev_sale_end_date: prevSaleEndDate || undefined
      })
      onClose()
    } catch (err) {
      console.error('Error saving sale:', err)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to delete this sale?')) return
    
    try {
      await onDelete(sale.id)
      onClose()
    } catch (err) {
      console.error('Error deleting sale:', err)
    }
  }

  const handleDuplicate = () => {
    if (onDuplicate) {
      onClose()
      onDuplicate(sale)
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
          <h2>Edit Sale</h2>
          <button className={styles.closeBtn} onClick={onClose}>×</button>
        </div>
        
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
                placeholder="Custom Sale"
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
          {productId && platformId && (
            <SalePredictionPanel
              productId={productId}
              platformId={platformId}
              clientId={sale.product?.game?.client?.id || ''}
              discountPercentage={discountPercentage}
              durationDays={duration}
              startDate={startDate}
              goalType={goalType || undefined}
            />
          )}

          <div className={styles.row}>
            <div className={styles.field}>
              <label>Status</label>
              <select
                value={status}
                onChange={e => setStatus(e.target.value as SaleStatus)}
              >
                <option value="planned">Planned</option>
                <option value="submitted">Submitted</option>
                <option value="confirmed">Confirmed</option>
                <option value="live">Live</option>
                <option value="ended">Ended</option>
              </select>
            </div>

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
          </div>

          <div className={styles.row}>
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
            <button 
              type="button" 
              className={styles.deleteBtn} 
              onClick={handleDelete}
            >
              Delete
            </button>
            {onDuplicate && (
              <button 
                type="button" 
                className={styles.duplicateBtn} 
                onClick={handleDuplicate}
              >
                Duplicate
              </button>
            )}
            <button type="button" className={styles.cancelBtn} onClick={onClose}>
              Cancel
            </button>
            <button 
              type="submit" 
              className={styles.saveBtn}
              disabled={saving || !!validationError || !productId || !platformId}
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
