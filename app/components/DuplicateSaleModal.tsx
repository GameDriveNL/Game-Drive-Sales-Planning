'use client'

import { useState, useMemo } from 'react'
import { format, addDays, parseISO, differenceInDays } from 'date-fns'
import { Sale, Platform, Product, Game, Client, SaleWithDetails } from '@/lib/types'
import { validateSale } from '@/lib/validation'
import { useModalClose } from '@/lib/hooks/useModalClose'
import styles from './DuplicateSaleModal.module.css'

interface DuplicateSaleModalProps {
  sale: SaleWithDetails
  products: (Product & { game: Game & { client: Client } })[]
  platforms: Platform[]
  existingSales: SaleWithDetails[]
  onDuplicate: (sales: Omit<Sale, 'id' | 'created_at'>[]) => Promise<void>
  onClose: () => void
}

type DuplicateMode = 'date' | 'platforms' | 'products' | 'both'

export default function DuplicateSaleModal({
  sale,
  products,
  platforms,
  existingSales,
  onDuplicate,
  onClose
}: DuplicateSaleModalProps) {
  const [mode, setMode] = useState<DuplicateMode>('date')
  const [newStartDate, setNewStartDate] = useState(
    format(addDays(parseISO(sale.end_date), (platforms.find(p => p.id === sale.platform_id)?.cooldown_days || 30) + 1), 'yyyy-MM-dd')
  )
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([])
  const [selectedProducts, setSelectedProducts] = useState<string[]>([])
  const [duplicating, setDuplicating] = useState(false)
  const [keepSameDate, setKeepSameDate] = useState(true)
  const { overlayProps, modalProps, formProps, handleClose } = useModalClose(onClose)
  
  const saleDuration = differenceInDays(parseISO(sale.end_date), parseISO(sale.start_date)) + 1
  
  // Calculate new end date based on start date
  const newEndDate = useMemo(() => {
    if (!newStartDate) return ''
    return format(addDays(parseISO(newStartDate), saleDuration - 1), 'yyyy-MM-dd')
  }, [newStartDate, saleDuration])
  
  // Get available platforms (excluding current)
  const availablePlatforms = platforms.filter(p => p.id !== sale.platform_id)

  // Get available products (excluding current product) — B5: cross-product duplication
  const availableProducts = products.filter(p => p.id !== sale.product_id)

  // Validate per-product duplicates
  const productValidations = useMemo(() => {
    const results: Record<string, { valid: boolean; message?: string }> = {}
    const dateToUse = (mode === 'products' && keepSameDate) ? sale.start_date : newStartDate
    const endDateToUse = (mode === 'products' && keepSameDate) ? sale.end_date : newEndDate
    const platform = platforms.find(p => p.id === sale.platform_id)
    if (!platform) return results
    for (const productId of selectedProducts) {
      results[productId] = validateSale(
        {
          product_id: productId,
          platform_id: sale.platform_id,
          start_date: dateToUse,
          end_date: endDateToUse,
          sale_type: sale.sale_type
        },
        existingSales,
        platform
      )
    }
    return results
  }, [mode, keepSameDate, newStartDate, newEndDate, selectedProducts, sale, existingSales, platforms])
  
  // Validate date duplicate
  const dateValidation = useMemo(() => {
    if (mode === 'platforms' && keepSameDate) return { valid: true }
    
    const platform = platforms.find(p => p.id === sale.platform_id)
    if (!platform || !newStartDate) return { valid: false, message: 'Select a date' }
    
    return validateSale(
      {
        product_id: sale.product_id,
        platform_id: sale.platform_id,
        start_date: newStartDate,
        end_date: newEndDate,
        sale_type: sale.sale_type
      },
      existingSales,
      platform
    )
  }, [mode, keepSameDate, newStartDate, newEndDate, sale, existingSales, platforms])
  
  // Validate platform duplicates
  const platformValidations = useMemo(() => {
    const results: Record<string, { valid: boolean; message?: string }> = {}
    
    const dateToUse = (mode === 'platforms' && keepSameDate) ? sale.start_date : newStartDate
    const endDateToUse = (mode === 'platforms' && keepSameDate) ? sale.end_date : newEndDate
    
    for (const platformId of selectedPlatforms) {
      const platform = platforms.find(p => p.id === platformId)
      if (!platform) continue
      
      results[platformId] = validateSale(
        {
          product_id: sale.product_id,
          platform_id: platformId,
          start_date: dateToUse,
          end_date: endDateToUse,
          sale_type: sale.sale_type
        },
        existingSales,
        platform
      )
    }
    
    return results
  }, [mode, keepSameDate, newStartDate, newEndDate, selectedPlatforms, sale, existingSales, platforms])
  
  // Count valid duplicates
  const validCount = useMemo(() => {
    let count = 0

    if (mode === 'date' || mode === 'both') {
      if (dateValidation.valid) count++
    }

    if (mode === 'platforms' || mode === 'both') {
      count += Object.values(platformValidations).filter(v => v.valid).length
    }

    if (mode === 'products') {
      count += Object.values(productValidations).filter(v => v.valid).length
    }

    return count
  }, [mode, dateValidation, platformValidations, productValidations])
  
  const handlePlatformToggle = (platformId: string) => {
    setSelectedPlatforms(prev => 
      prev.includes(platformId)
        ? prev.filter(id => id !== platformId)
        : [...prev, platformId]
    )
  }
  
  const handleSelectAllPlatforms = () => {
    if (selectedPlatforms.length === availablePlatforms.length) {
      setSelectedPlatforms([])
    } else {
      setSelectedPlatforms(availablePlatforms.map(p => p.id))
    }
  }

  const handleProductToggle = (productId: string) => {
    setSelectedProducts(prev => prev.includes(productId) ? prev.filter(id => id !== productId) : [...prev, productId])
  }
  const handleSelectAllProducts = () => {
    if (selectedProducts.length === availableProducts.length) setSelectedProducts([])
    else setSelectedProducts(availableProducts.map(p => p.id))
  }
  
  const handleDuplicate = async () => {
    setDuplicating(true)
    
    try {
      const salesToCreate: Omit<Sale, 'id' | 'created_at'>[] = []
      
      const baseSale = {
        product_id: sale.product_id,
        discount_percentage: sale.discount_percentage,
        sale_name: sale.sale_name,
        sale_type: sale.sale_type,
        status: 'planned' as const, // Reset status for duplicates
        goal_type: sale.goal_type,
        notes: sale.notes ? `Duplicated from ${format(parseISO(sale.start_date), 'MMM d, yyyy')}` : undefined,
        is_campaign: sale.is_campaign,
        comment: sale.comment
      }
      
      // Add date duplicate
      if ((mode === 'date' || mode === 'both') && dateValidation.valid) {
        salesToCreate.push({
          ...baseSale,
          platform_id: sale.platform_id,
          start_date: newStartDate,
          end_date: newEndDate
        })
      }
      
      // Add platform duplicates
      if (mode === 'platforms' || mode === 'both') {
        const dateToUse = keepSameDate ? sale.start_date : newStartDate
        const endDateToUse = keepSameDate ? sale.end_date : newEndDate

        for (const platformId of selectedPlatforms) {
          if (platformValidations[platformId]?.valid) {
            salesToCreate.push({
              ...baseSale,
              platform_id: platformId,
              start_date: dateToUse,
              end_date: endDateToUse
            })
          }
        }
      }

      // B5: Add cross-product duplicates (same platform, selected target products)
      if (mode === 'products') {
        const dateToUse = keepSameDate ? sale.start_date : newStartDate
        const endDateToUse = keepSameDate ? sale.end_date : newEndDate
        for (const productId of selectedProducts) {
          if (productValidations[productId]?.valid) {
            salesToCreate.push({
              ...baseSale,
              product_id: productId,
              platform_id: sale.platform_id,
              start_date: dateToUse,
              end_date: endDateToUse
            })
          }
        }
      }
      
      if (salesToCreate.length > 0) {
        await onDuplicate(salesToCreate)
      }
      
      onClose()
    } catch (err) {
      console.error('Error duplicating sale:', err)
    } finally {
      setDuplicating(false)
    }
  }
  
  // Quick offset buttons
  const quickOffsets = [
    { label: '+30 days', days: 30 },
    { label: '+60 days', days: 60 },
    { label: '+90 days', days: 90 },
    { label: 'After cooldown', days: (platforms.find(p => p.id === sale.platform_id)?.cooldown_days || 30) + 1 }
  ]
  
  return (
    <div className={styles.overlay} {...overlayProps}>
      <div className={styles.modal} {...modalProps}>
        <div className={styles.header}>
          <h2>📋 Duplicate Sale</h2>
          <button className={styles.closeBtn} onClick={handleClose}>×</button>
        </div>

        <div className={styles.content} {...formProps}>
          {/* Original sale info */}
          <div className={styles.originalSale}>
            <h3>Original Sale</h3>
            <div className={styles.saleInfo}>
              <span className={styles.productName}>{sale.product?.name}</span>
              <span 
                className={styles.platformBadge}
                style={{ backgroundColor: sale.platform?.color_hex || '#666' }}
              >
                {sale.platform?.name}
              </span>
              <span className={styles.dates}>
                {format(parseISO(sale.start_date), 'MMM d')} - {format(parseISO(sale.end_date), 'MMM d, yyyy')}
              </span>
              <span className={styles.discount}>{sale.discount_percentage}% off</span>
            </div>
          </div>
          
          {/* Mode selector */}
          <div className={styles.modeSelector}>
            <button 
              className={`${styles.modeBtn} ${mode === 'date' ? styles.active : ''}`}
              onClick={() => setMode('date')}
            >
              📅 New Date
            </button>
            <button 
              className={`${styles.modeBtn} ${mode === 'platforms' ? styles.active : ''}`}
              onClick={() => setMode('platforms')}
            >
              🎮 Other Platforms
            </button>
            <button
              className={`${styles.modeBtn} ${mode === 'both' ? styles.active : ''}`}
              onClick={() => setMode('both')}
            >
              📅🎮 Both
            </button>
            <button
              className={`${styles.modeBtn} ${mode === 'products' ? styles.active : ''}`}
              onClick={() => setMode('products')}
              title="Duplicate to other products on the same platform"
            >
              📦 Other Products
            </button>
          </div>
          
          {/* Date section */}
          {(mode === 'date' || mode === 'both') && (
            <div className={styles.section}>
              <h3>New Date</h3>
              
              <div className={styles.quickButtons}>
                {quickOffsets.map(offset => (
                  <button
                    key={offset.label}
                    className={styles.quickBtn}
                    onClick={() => setNewStartDate(
                      format(addDays(parseISO(sale.end_date), offset.days), 'yyyy-MM-dd')
                    )}
                  >
                    {offset.label}
                  </button>
                ))}
              </div>
              
              <div className={styles.dateInputs}>
                <div className={styles.field}>
                  <label>Start Date</label>
                  <input
                    type="date"
                    value={newStartDate}
                    onChange={e => setNewStartDate(e.target.value)}
                  />
                </div>
                <div className={styles.field}>
                  <label>End Date</label>
                  <input
                    type="date"
                    value={newEndDate}
                    disabled
                    className={styles.disabled}
                  />
                </div>
                <div className={styles.field}>
                  <label>Duration</label>
                  <input
                    type="text"
                    value={`${saleDuration} days`}
                    disabled
                    className={styles.disabled}
                  />
                </div>
              </div>
              
              {!dateValidation.valid && (
                <div className={styles.validationError}>
                  ⚠️ {dateValidation.message}
                </div>
              )}
              {dateValidation.valid && (
                <div className={styles.validationSuccess}>
                  ✓ Valid - no conflicts
                </div>
              )}
            </div>
          )}
          
          {/* Platforms section */}
          {(mode === 'platforms' || mode === 'both') && (
            <div className={styles.section}>
              <h3>
                Select Platforms
                <button 
                  className={styles.selectAllBtn}
                  onClick={handleSelectAllPlatforms}
                >
                  {selectedPlatforms.length === availablePlatforms.length ? 'Deselect All' : 'Select All'}
                </button>
              </h3>
              
              {mode === 'platforms' && (
                <label className={styles.keepDateLabel}>
                  <input
                    type="checkbox"
                    checked={keepSameDate}
                    onChange={e => setKeepSameDate(e.target.checked)}
                  />
                  Keep same date ({format(parseISO(sale.start_date), 'MMM d')} - {format(parseISO(sale.end_date), 'MMM d')})
                </label>
              )}
              
              <div className={styles.platformGrid}>
                {availablePlatforms.map(platform => {
                  const isSelected = selectedPlatforms.includes(platform.id)
                  const validation = platformValidations[platform.id]
                  
                  return (
                    <div 
                      key={platform.id}
                      className={`${styles.platformCard} ${isSelected ? styles.selected : ''}`}
                      onClick={() => handlePlatformToggle(platform.id)}
                    >
                      <div 
                        className={styles.platformColor}
                        style={{ backgroundColor: platform.color_hex }}
                      />
                      <div className={styles.platformInfo}>
                        <span className={styles.platformName}>{platform.name}</span>
                        <span className={styles.platformCooldown}>{platform.cooldown_days}d cooldown</span>
                      </div>
                      <div className={styles.platformStatus}>
                        {isSelected && (
                          validation?.valid 
                            ? <span className={styles.valid}>✓</span>
                            : <span className={styles.invalid} title={validation?.message}>⚠️</span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
              
              {selectedPlatforms.length > 0 && (
                <div className={styles.platformSummary}>
                  {Object.entries(platformValidations).map(([platformId, validation]) => {
                    const platform = platforms.find(p => p.id === platformId)
                    if (!platform) return null
                    
                    return (
                      <div 
                        key={platformId}
                        className={`${styles.summaryItem} ${validation.valid ? styles.valid : styles.invalid}`}
                      >
                        <span>{platform.name}</span>
                        <span>{validation.valid ? '✓ Valid' : validation.message}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* Products section — B5: cross-product duplication */}
          {mode === 'products' && (
            <div className={styles.section}>
              <h3>
                Select Target Products
                <button className={styles.selectAllBtn} onClick={handleSelectAllProducts}>
                  {selectedProducts.length === availableProducts.length ? 'Deselect All' : 'Select All'}
                </button>
              </h3>
              <label className={styles.keepDateLabel}>
                <input
                  type="checkbox"
                  checked={keepSameDate}
                  onChange={e => setKeepSameDate(e.target.checked)}
                />
                Keep same date ({format(parseISO(sale.start_date), 'MMM d')} - {format(parseISO(sale.end_date), 'MMM d')})
              </label>
              {!keepSameDate && (
                <div className={styles.dateInputs}>
                  <div className={styles.field}>
                    <label>Start Date</label>
                    <input type="date" value={newStartDate} onChange={e => setNewStartDate(e.target.value)} />
                  </div>
                  <div className={styles.field}>
                    <label>End Date</label>
                    <input type="date" value={newEndDate} disabled className={styles.disabled} />
                  </div>
                </div>
              )}
              <div className={styles.platformGrid}>
                {availableProducts.map(product => {
                  const isSelected = selectedProducts.includes(product.id)
                  const validation = productValidations[product.id]
                  return (
                    <div
                      key={product.id}
                      className={`${styles.platformCard} ${isSelected ? styles.selected : ''}`}
                      onClick={() => handleProductToggle(product.id)}
                    >
                      <div className={styles.platformInfo}>
                        <span className={styles.platformName}>{product.name}</span>
                        <span className={styles.platformCooldown}>{product.game?.name || ''}</span>
                      </div>
                      <div className={styles.platformStatus}>
                        {isSelected && (
                          validation?.valid
                            ? <span className={styles.valid}>✓</span>
                            : <span className={styles.invalid} title={validation?.message}>⚠️</span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        <div className={styles.footer}>
          <div className={styles.summary}>
            {validCount > 0 ? (
              <span className={styles.validSummary}>
                ✓ {validCount} sale{validCount !== 1 ? 's' : ''} will be created
              </span>
            ) : (
              <span className={styles.invalidSummary}>
                No valid duplicates selected
              </span>
            )}
          </div>
          
          <div className={styles.actions}>
            <button className={styles.cancelBtn} onClick={handleClose}>
              Cancel
            </button>
            <button 
              className={styles.duplicateBtn}
              onClick={handleDuplicate}
              disabled={duplicating || validCount === 0}
            >
              {duplicating ? 'Creating...' : `Create ${validCount} Sale${validCount !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
