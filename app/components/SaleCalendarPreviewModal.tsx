'use client'

import { useState, useMemo, useEffect, useCallback } from 'react'
import { format, parseISO, addMonths, addDays, differenceInDays } from 'date-fns'
import { CalendarVariation, GeneratedSale, generateSaleCalendar, getDefaultSelectedPlatforms } from '@/lib/sale-calendar-generator'
import { Platform, PlatformEvent, SaleWithDetails } from '@/lib/types'
import { useCalendarPredictions } from '@/lib/hooks/useCalendarPredictions'
import type { BatchPredictionResult } from '@/app/api/sales/predict-batch/route'
import CalendarExport from './CalendarExport'
import styles from './SaleCalendarPreviewModal.module.css'

interface SaleCalendarPreviewModalProps {
  isOpen: boolean
  onClose: () => void
  productId: string
  productName: string
  launchDate: string
  platforms: Platform[]
  platformEvents: PlatformEvent[]
  existingSales: SaleWithDetails[]
  onApply: (sales: GeneratedSale[]) => Promise<void>
  isApplying: boolean
  // Optional: Pre-selected platform IDs (from product's available platforms)
  initialPlatformIds?: string[]
  // Client ID for AI predictions
  clientId?: string
}

export default function SaleCalendarPreviewModal({
  isOpen,
  onClose,
  productId,
  productName,
  launchDate,
  platforms,
  platformEvents,
  existingSales,
  onApply,
  isApplying,
  initialPlatformIds,
  clientId
}: SaleCalendarPreviewModalProps) {
  // Two-step flow: config → preview
  const [step, setStep] = useState<'config' | 'preview'>('config')

  const [selectedPlatformIds, setSelectedPlatformIds] = useState<string[]>([])
  const [variations, setVariations] = useState<CalendarVariation[]>([])
  const [selectedVariation, setSelectedVariation] = useState(0) // Default to "Maximize Sales"
  const [selectedPlatform, setSelectedPlatform] = useState<string | 'all'>('all')
  const [showExport, setShowExport] = useState(false)

  // Strategy pre-selection (which variation to default to on preview)
  const [preSelectedStrategy, setPreSelectedStrategy] = useState(0) // 0 = Maximize, 1 = Events Only

  // Preferred start day (0=Sun, 1=Mon, ... 4=Thu, 6=Sat)
  const [preferredStartDay, setPreferredStartDay] = useState(4) // Default: Thursday

  // Timeframe options
  type TimeframeMode = 'months' | 'custom'
  const [timeframeMode, setTimeframeMode] = useState<TimeframeMode>('months')
  const [monthCount, setMonthCount] = useState(12) // Default: 12 months
  const [customEndDate, setCustomEndDate] = useState('')

  // AI Predictions
  const [aiEnabled, setAiEnabled] = useState(false)
  const {
    predictions,
    loadingIds,
    errors: predictionErrors,
    progress,
    isRunning: isPredicting,
    totalPredictedRevenue,
    totalPredictedUnits,
    startPredictions,
    cancelPredictions,
  } = useCalendarPredictions()

  // Initialize selected platforms
  useEffect(() => {
    if (isOpen && platforms.length > 0) {
      if (initialPlatformIds && initialPlatformIds.length > 0) {
        setSelectedPlatformIds(initialPlatformIds)
      } else {
        setSelectedPlatformIds(getDefaultSelectedPlatforms(platforms))
      }
      setStep('config')
      setVariations([])
      setPreSelectedStrategy(0)
      setPreferredStartDay(4) // Reset to Thursday
      setTimeframeMode('months')
      setMonthCount(12)
      setCustomEndDate('')
      setAiEnabled(false)
    }
  }, [isOpen, platforms, initialPlatformIds])

  // Cleanup on close
  useEffect(() => {
    if (!isOpen) {
      cancelPredictions()
    }
  }, [isOpen, cancelPredictions])

  const currentVariation = variations[selectedVariation]

  // Calculate period end based on selected timeframe
  const periodEndDate = useMemo(() => {
    if (timeframeMode === 'custom' && customEndDate) {
      return parseISO(customEndDate)
    }
    return addDays(addMonths(parseISO(launchDate), monthCount), -1)
  }, [launchDate, timeframeMode, monthCount, customEndDate])

  const periodEnd = useMemo(() => {
    return format(periodEndDate, 'MMM d, yyyy')
  }, [periodEndDate])

  // Build AI-Optimized 3rd variation from predictions
  const aiOptimizedVariation = useMemo((): CalendarVariation | null => {
    if (!aiEnabled || predictions.size === 0 || variations.length === 0) return null

    // Use the first variation (Maximize Sales) as the base
    const baseSales = variations[0].sales
    const optimizedSales: GeneratedSale[] = baseSales.map(sale => {
      const pred = predictions.get(sale.id)
      if (!pred) return { ...sale }

      const useAi = sale.use_ai_discount !== false // default to accepting AI
      const optimizedDiscount = useAi ? pred.optimal_discount : sale.discount_percentage

      return {
        ...sale,
        discount_percentage: optimizedDiscount,
        ai_prediction: {
          predicted_revenue: pred.predicted_revenue,
          predicted_units: pred.predicted_units,
          confidence: pred.confidence,
          optimal_discount: pred.optimal_discount,
          optimal_duration: pred.optimal_duration,
          reasoning: pred.reasoning,
          statistical_revenue: pred.statistical_revenue,
          sale_multiplier: pred.sale_multiplier,
        },
        use_ai_discount: useAi,
      }
    })

    const periodStart = parseISO(launchDate)
    const totalDaysInPeriod = differenceInDays(periodEndDate, periodStart) + 1
    let totalDaysOnSale = 0
    let eventSales = 0
    let customSales = 0
    for (const sale of optimizedSales) {
      totalDaysOnSale += differenceInDays(parseISO(sale.end_date), parseISO(sale.start_date)) + 1
      if (sale.is_event) eventSales++
      else customSales++
    }

    return {
      name: 'AI-Optimized',
      description: 'AI-recommended discounts per platform for maximum revenue',
      sales: optimizedSales,
      stats: {
        totalSales: optimizedSales.length,
        totalDaysOnSale,
        percentageOnSale: Math.round((totalDaysOnSale / totalDaysInPeriod) * 100),
        eventSales,
        customSales,
      },
      is_ai_optimized: true,
      revenue_forecast: {
        total_predicted_revenue: totalPredictedRevenue,
        total_predicted_units: totalPredictedUnits,
        predictions_loaded: progress.loaded,
        predictions_total: progress.total,
      },
    }
  }, [aiEnabled, predictions, variations, launchDate, periodEndDate, totalPredictedRevenue, totalPredictedUnits, progress])

  // All variations including AI-Optimized
  const allVariations = useMemo(() => {
    if (aiOptimizedVariation) {
      return [...variations, aiOptimizedVariation]
    }
    return variations
  }, [variations, aiOptimizedVariation])

  const displayVariation = allVariations[selectedVariation] || null

  // Get unique platforms from the sales for filtering
  const variationPlatforms = useMemo(() => {
    if (!displayVariation) return []
    const platformMap = new Map<string, { id: string; name: string; color: string }>()
    for (const sale of displayVariation.sales) {
      if (!platformMap.has(sale.platform_id)) {
        platformMap.set(sale.platform_id, {
          id: sale.platform_id,
          name: sale.platform_name,
          color: sale.platform_color
        })
      }
    }
    return Array.from(platformMap.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [displayVariation])

  // Filter sales by selected platform
  const filteredSales = useMemo(() => {
    if (!displayVariation) return []
    if (selectedPlatform === 'all') return displayVariation.sales
    return displayVariation.sales.filter(s => s.platform_id === selectedPlatform)
  }, [displayVariation, selectedPlatform])

  // Group sales by month for display
  const salesByMonth = useMemo(() => {
    const groups: { [month: string]: GeneratedSale[] } = {}
    for (const sale of filteredSales) {
      const monthKey = format(parseISO(sale.start_date), 'MMMM yyyy')
      if (!groups[monthKey]) {
        groups[monthKey] = []
      }
      groups[monthKey].push(sale)
    }
    return groups
  }, [filteredSales])

  // Toggle platform selection
  const togglePlatform = (platformId: string) => {
    setSelectedPlatformIds(prev =>
      prev.includes(platformId)
        ? prev.filter(id => id !== platformId)
        : [...prev, platformId]
    )
  }

  // Select all / deselect all
  const selectAllPlatforms = () => {
    setSelectedPlatformIds(platforms.map(p => p.id))
  }

  const deselectAllPlatforms = () => {
    setSelectedPlatformIds([])
  }

  // Toggle AI discount acceptance for a sale in the AI variation
  const toggleAiDiscount = useCallback((saleId: string) => {
    setVariations(prev => {
      // We modify the base variations so the AI variation recomputes
      return prev.map(v => ({
        ...v,
        sales: v.sales.map(s => {
          if (s.id === saleId) {
            return { ...s, use_ai_discount: s.use_ai_discount === false ? true : false }
          }
          return s
        })
      }))
    })
  }, [])

  // Generate calendar with selected options
  const handleGenerate = () => {
    if (selectedPlatformIds.length === 0) return

    const params: Parameters<typeof generateSaleCalendar>[0] = {
      productId,
      platforms,
      platformEvents,
      launchDate,
      defaultDiscount: 50,
      existingSales,
      selectedPlatformIds,
      preferredStartDay
    }

    // Add timeframe parameters based on mode
    if (timeframeMode === 'custom' && customEndDate) {
      params.endDate = customEndDate
    } else if (monthCount !== 12) {
      params.monthCount = monthCount
    }

    const newVariations = generateSaleCalendar(params)

    setVariations(newVariations)
    setSelectedVariation(preSelectedStrategy) // Use pre-selected strategy
    setSelectedPlatform('all')
    setStep('preview')

    // If AI is enabled, start predictions
    if (aiEnabled && clientId) {
      // Use the "Maximize Sales" variation (index 0) as the base for predictions
      const salesForPrediction = newVariations[0]?.sales || []
      if (salesForPrediction.length > 0) {
        startPredictions(
          salesForPrediction.map(s => ({
            id: s.id,
            product_id: s.product_id,
            platform_id: s.platform_id,
            discount_percentage: s.discount_percentage,
            start_date: s.start_date,
            end_date: s.end_date,
          })),
          clientId
        )
      }
    }
  }

  if (!isOpen) return null

  const handleApply = async () => {
    if (displayVariation) {
      await onApply(displayVariation.sales)
    }
  }

  // Icons and colors for variations (2 base + optional AI)
  const variationIcons = ['🚀', '🎯', '🤖']
  const variationColors = ['#ef4444', '#22c55e', '#7c3aed']

  // Sort platforms: with cooldown first, then 0-day cooldown
  const sortedPlatforms = useMemo(() => {
    return [...platforms].sort((a, b) => {
      if (a.cooldown_days > 0 && b.cooldown_days === 0) return -1
      if (a.cooldown_days === 0 && b.cooldown_days > 0) return 1
      return a.name.localeCompare(b.name)
    })
  }, [platforms])

  const selectedCount = selectedPlatformIds.length
  const zeroCooldownCount = platforms.filter(p => p.cooldown_days === 0).length

  // Day names for the dropdown
  const dayNames = [
    { value: 1, label: 'Monday' },
    { value: 2, label: 'Tuesday' },
    { value: 3, label: 'Wednesday' },
    { value: 4, label: 'Thursday' },
    { value: 5, label: 'Friday' },
    { value: 6, label: 'Saturday' },
    { value: 0, label: 'Sunday' }
  ]

  // Format currency
  const formatCurrency = (val: number) => {
    if (val >= 1000) return `$${(val / 1000).toFixed(1)}k`
    return `$${val.toFixed(0)}`
  }

  return (
    <>
      <div className={styles.overlay} onClick={onClose}>
        <div className={styles.modal} onClick={e => e.stopPropagation()}>
          <div className={styles.header}>
            <h2>🗓️ Auto-Generate Sale Calendar</h2>
            <p className={styles.subtitle}>for <strong>{productName}</strong></p>
            <div className={styles.launchInfo}>
              <span className={styles.launchBadge}>🚀 Launch: {format(parseISO(launchDate), 'MMM d, yyyy')}</span>
              <span className={styles.periodBadge}>📅 Planning through {periodEnd}</span>
            </div>
            {step === 'preview' && allVariations.length > 0 && (
              <div className={styles.headerActions}>
                <button
                  className={styles.exportPngButton}
                  onClick={() => setShowExport(true)}
                  title="Export all variations as PNG for client proposals"
                >
                  📸 Export PNG
                </button>
              </div>
            )}
            <button className={styles.closeButton} onClick={onClose}>×</button>
          </div>

          {/* Config Screen */}
          {step === 'config' && (
            <div className={styles.configScreen}>
              {/* AI Revenue Predictions Toggle */}
              {clientId && (
                <div className={styles.aiSection}>
                  <h3>🤖 AI Revenue Predictions</h3>
                  <p className={styles.aiSectionDesc}>
                    Uses historical sales data and AI to predict revenue per sale and recommend optimal discounts per platform.
                  </p>
                  <label className={styles.aiToggle}>
                    <input
                      type="checkbox"
                      checked={aiEnabled}
                      onChange={(e) => setAiEnabled(e.target.checked)}
                    />
                    <span className={styles.aiToggleLabel}>
                      Enable AI Predictions
                      <span className={styles.aiToggleHint}> — adds a 3rd &quot;AI-Optimized&quot; variation</span>
                    </span>
                  </label>
                </div>
              )}

              {/* Strategy Selection */}
              <div className={styles.strategySection}>
                <h3>Strategy</h3>
                <div className={styles.strategyToggle}>
                  <button
                    className={`${styles.strategyOption} ${preSelectedStrategy === 0 ? styles.strategySelected : ''}`}
                    onClick={() => setPreSelectedStrategy(0)}
                  >
                    <span className={styles.strategyIcon}>🚀</span>
                    <span className={styles.strategyName}>Maximize Sales</span>
                    <span className={styles.strategyDesc}>Back-to-back sales after cooldowns for maximum coverage</span>
                  </button>
                  <button
                    className={`${styles.strategyOption} ${preSelectedStrategy === 1 ? styles.strategySelected : ''}`}
                    onClick={() => setPreSelectedStrategy(1)}
                  >
                    <span className={styles.strategyIcon}>🎯</span>
                    <span className={styles.strategyName}>Events Only</span>
                    <span className={styles.strategyDesc}>Only platform seasonal events (plus launch sale if no events)</span>
                  </button>
                </div>
              </div>

              {/* Preferred Start Day */}
              <div className={styles.startDaySection}>
                <h3>Preferred Start Day</h3>
                <p className={styles.startDayHint}>
                  Custom sales will start on this day of the week. Event sales keep their fixed dates.
                </p>
                <select
                  value={preferredStartDay}
                  onChange={(e) => setPreferredStartDay(Number(e.target.value))}
                  className={styles.startDaySelect}
                >
                  {dayNames.map(day => (
                    <option key={day.value} value={day.value}>{day.label}</option>
                  ))}
                </select>
              </div>

              {/* Platform Selection */}
              <div className={styles.platformHeader}>
                <h3>Platforms</h3>
                <p className={styles.platformSubtext}>
                  Platforms with 0-day cooldown are excluded by default (no scheduling constraints)
                </p>
                <div className={styles.platformActions}>
                  <button
                    className={styles.selectAllBtn}
                    onClick={selectAllPlatforms}
                  >
                    Select All
                  </button>
                  <button
                    className={styles.deselectAllBtn}
                    onClick={deselectAllPlatforms}
                  >
                    Deselect All
                  </button>
                </div>
              </div>

              <div className={styles.platformGrid}>
                {sortedPlatforms.map(platform => {
                  const isSelected = selectedPlatformIds.includes(platform.id)
                  const isZeroCooldown = platform.cooldown_days === 0

                  return (
                    <label
                      key={platform.id}
                      className={`${styles.platformCheckbox} ${isSelected ? styles.platformSelected : ''} ${isZeroCooldown ? styles.zeroCooldown : ''}`}
                      style={{ '--platform-color': platform.color_hex } as React.CSSProperties}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => togglePlatform(platform.id)}
                      />
                      <span
                        className={styles.platformColor}
                        style={{ backgroundColor: platform.color_hex }}
                      />
                      <span className={styles.platformInfo}>
                        <span className={styles.platformName}>{platform.name}</span>
                        <span className={styles.platformCooldown}>
                          {platform.cooldown_days > 0
                            ? `${platform.cooldown_days}-day cooldown`
                            : '0-day cooldown (no limit)'}
                        </span>
                      </span>
                      {isZeroCooldown && (
                        <span className={styles.zeroCooldownBadge}>No Limit</span>
                      )}
                    </label>
                  )
                })}
              </div>

              <div className={styles.platformSummary}>
                <span className={styles.summaryText}>
                  {selectedCount} of {platforms.length} platforms selected
                  {zeroCooldownCount > 0 && selectedPlatformIds.filter(id =>
                    platforms.find(p => p.id === id)?.cooldown_days === 0
                  ).length > 0 && (
                    <span className={styles.warningText}>
                      (includes {selectedPlatformIds.filter(id =>
                        platforms.find(p => p.id === id)?.cooldown_days === 0
                      ).length} with no cooldown)
                    </span>
                  )}
                </span>
              </div>

              {/* Timeframe Selection */}
              <div className={styles.timeframeSection}>
                <h3>Planning Timeframe</h3>
                <p className={styles.timeframeSubtext}>
                  How far ahead should we plan sales?
                </p>

                <div className={styles.timeframeModes}>
                  <label className={`${styles.timeframeOption} ${timeframeMode === 'months' ? styles.timeframeSelected : ''}`}>
                    <input
                      type="radio"
                      name="timeframeMode"
                      checked={timeframeMode === 'months'}
                      onChange={() => setTimeframeMode('months')}
                    />
                    <span className={styles.timeframeOptionContent}>
                      <span className={styles.timeframeOptionTitle}>📅 Month Duration</span>
                      <span className={styles.timeframeOptionDesc}>Plan for a set number of months</span>
                    </span>
                  </label>

                  <label className={`${styles.timeframeOption} ${timeframeMode === 'custom' ? styles.timeframeSelected : ''}`}>
                    <input
                      type="radio"
                      name="timeframeMode"
                      checked={timeframeMode === 'custom'}
                      onChange={() => setTimeframeMode('custom')}
                    />
                    <span className={styles.timeframeOptionContent}>
                      <span className={styles.timeframeOptionTitle}>🎯 Custom End Date</span>
                      <span className={styles.timeframeOptionDesc}>Specify exact end date</span>
                    </span>
                  </label>
                </div>

                {/* Month Count Selector */}
                {timeframeMode === 'months' && (
                  <div className={styles.monthSelector}>
                    <label htmlFor="monthCount">Duration:</label>
                    <select
                      id="monthCount"
                      value={monthCount}
                      onChange={(e) => setMonthCount(Number(e.target.value))}
                      className={styles.monthSelect}
                    >
                      <option value={3}>3 months</option>
                      <option value={6}>6 months</option>
                      <option value={9}>9 months</option>
                      <option value={12}>12 months (default)</option>
                      <option value={18}>18 months</option>
                      <option value={24}>24 months (2 years)</option>
                      <option value={36}>36 months (3 years)</option>
                    </select>
                    <span className={styles.datePreview}>
                      Through {format(addDays(addMonths(parseISO(launchDate), monthCount), -1), 'MMM d, yyyy')}
                    </span>
                  </div>
                )}

                {/* Custom End Date Picker */}
                {timeframeMode === 'custom' && (
                  <div className={styles.customDatePicker}>
                    <label htmlFor="customEndDate">End Date:</label>
                    <input
                      type="date"
                      id="customEndDate"
                      value={customEndDate}
                      onChange={(e) => setCustomEndDate(e.target.value)}
                      min={format(addMonths(parseISO(launchDate), 1), 'yyyy-MM-dd')}
                      className={styles.dateInput}
                    />
                    {customEndDate && (
                      <span className={styles.datePreview}>
                        {Math.ceil((parseISO(customEndDate).getTime() - parseISO(launchDate).getTime()) / (1000 * 60 * 60 * 24 * 30))} months of planning
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Preview Screen */}
          {step === 'preview' && (
            <>
              {/* Strategy Comparison Cards */}
              <div className={styles.variationSelector}>
                <h3 className={styles.selectorTitle}>Compare Strategies</h3>
                <div className={`${styles.variationCards} ${allVariations.length === 3 ? styles.threeCards : ''}`}>
                  {allVariations.map((variation, idx) => {
                    const isAiVariation = variation.is_ai_optimized === true
                    return (
                      <button
                        key={idx}
                        className={`${styles.variationCard} ${selectedVariation === idx ? styles.selectedCard : ''} ${isAiVariation ? styles.aiCard : ''}`}
                        onClick={() => setSelectedVariation(idx)}
                        style={{
                          '--card-color': variationColors[idx] || '#7c3aed',
                          borderColor: selectedVariation === idx ? (variationColors[idx] || '#7c3aed') : 'transparent'
                        } as React.CSSProperties}
                      >
                        <span className={styles.cardIcon}>{variationIcons[idx] || '🤖'}</span>
                        <span className={styles.cardName}>{variation.name}</span>
                        <span className={styles.cardDescription}>{variation.description}</span>
                        <div className={styles.cardStats}>
                          <span className={styles.cardStatMain}>{variation.stats.totalSales} sales</span>
                          <span className={styles.cardStatSub}>
                            {variation.stats.percentageOnSale}% coverage
                            {isAiVariation && variation.revenue_forecast && variation.revenue_forecast.total_predicted_revenue > 0 && (
                              <> · {formatCurrency(variation.revenue_forecast.total_predicted_revenue)} est.</>
                            )}
                          </span>
                        </div>
                        {selectedVariation === idx && (
                          <span className={styles.selectedBadge}>✓ Selected</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>

              {displayVariation && (
                <>
                  {/* Quick Stats Bar */}
                  <div className={styles.quickStats}>
                    <div className={styles.quickStat}>
                      <span className={styles.quickStatValue}>{displayVariation.stats.totalSales}</span>
                      <span className={styles.quickStatLabel}>Total</span>
                    </div>
                    <div className={styles.quickStatDivider} />
                    <div className={styles.quickStat}>
                      <span className={styles.quickStatValue}>{displayVariation.stats.totalDaysOnSale}</span>
                      <span className={styles.quickStatLabel}>Days</span>
                    </div>
                    <div className={styles.quickStatDivider} />
                    <div className={styles.quickStat}>
                      <span className={styles.quickStatValue}>{displayVariation.stats.eventSales}</span>
                      <span className={styles.quickStatLabel}>Events</span>
                    </div>
                    <div className={styles.quickStatDivider} />
                    <div className={styles.quickStat}>
                      <span className={styles.quickStatValue}>{displayVariation.stats.customSales}</span>
                      <span className={styles.quickStatLabel}>Custom</span>
                    </div>
                    <div className={styles.quickStatDivider} />
                    <div className={styles.quickStat}>
                      <span className={styles.quickStatValue}>{variationPlatforms.length}</span>
                      <span className={styles.quickStatLabel}>Platforms</span>
                    </div>
                  </div>

                  {/* Revenue Forecast Bar (only when AI is enabled) */}
                  {aiEnabled && (predictions.size > 0 || isPredicting) && (
                    <div className={styles.revenueForecast}>
                      <div className={styles.forecastHeader}>
                        <span className={styles.forecastTitle}>
                          🤖 AI Revenue Forecast
                        </span>
                        <span className={styles.forecastProgress}>
                          {isPredicting
                            ? `Analyzing ${progress.loaded}/${progress.total}...`
                            : `${progress.loaded}/${progress.total} predictions complete`}
                        </span>
                      </div>
                      <div className={styles.forecastCards}>
                        <div className={styles.forecastCard}>
                          <span className={styles.forecastValue}>
                            {totalPredictedRevenue > 0 ? formatCurrency(totalPredictedRevenue) : '—'}
                          </span>
                          <span className={styles.forecastLabel}>Est. Revenue</span>
                        </div>
                        <div className={styles.forecastCard}>
                          <span className={styles.forecastValue}>
                            {totalPredictedUnits > 0 ? totalPredictedUnits.toLocaleString() : '—'}
                          </span>
                          <span className={styles.forecastLabel}>Est. Units</span>
                        </div>
                        <div className={styles.forecastCard}>
                          <span className={styles.forecastValue}>
                            {predictions.size > 0 && predictionErrors.size === 0 ? '✅' : isPredicting ? '⏳' : '⚠️'}
                          </span>
                          <span className={styles.forecastLabel}>
                            {predictionErrors.size > 0 ? `${predictionErrors.size} errors` : 'Status'}
                          </span>
                        </div>
                      </div>
                      {isPredicting && (
                        <div className={styles.forecastProgressBar}>
                          <div
                            className={styles.forecastProgressFill}
                            style={{ width: `${progress.total > 0 ? (progress.loaded / progress.total) * 100 : 0}%` }}
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {/* Platform Filter */}
                  <div className={styles.filterBar}>
                    <label>Preview by Platform:</label>
                    <div className={styles.platformTabs}>
                      <button
                        className={`${styles.platformTab} ${selectedPlatform === 'all' ? styles.activePlatformTab : ''}`}
                        onClick={() => setSelectedPlatform('all')}
                      >
                        All ({displayVariation.sales.length})
                      </button>
                      {variationPlatforms.map(platform => {
                        const count = displayVariation.sales.filter(s => s.platform_id === platform.id).length
                        return (
                          <button
                            key={platform.id}
                            className={`${styles.platformTab} ${selectedPlatform === platform.id ? styles.activePlatformTab : ''}`}
                            onClick={() => setSelectedPlatform(platform.id)}
                            style={{
                              '--platform-color': platform.color,
                              backgroundColor: selectedPlatform === platform.id ? platform.color : undefined
                            } as React.CSSProperties}
                          >
                            {platform.name} ({count})
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  {/* Sales List */}
                  <div className={styles.salesList}>
                    {Object.entries(salesByMonth).map(([month, monthSales]) => (
                      <div key={month} className={styles.monthGroup}>
                        <h3 className={styles.monthHeader}>{month}</h3>
                        <div className={styles.salesGrid}>
                          {monthSales.map(sale => {
                            const pred = predictions.get(sale.id)
                            const isLoading = loadingIds.has(sale.id)
                            const predError = predictionErrors.get(sale.id)
                            const isAiVariation = displayVariation.is_ai_optimized === true

                            return (
                              <div
                                key={sale.id}
                                className={`${styles.saleCard} ${sale.is_event ? styles.eventSale : ''}`}
                                style={{ borderLeftColor: sale.platform_color }}
                              >
                                <div className={styles.saleHeader}>
                                  <span
                                    className={styles.platformBadge}
                                    style={{ backgroundColor: sale.platform_color }}
                                  >
                                    {sale.platform_name}
                                  </span>
                                  {sale.is_event && (
                                    <span className={styles.eventBadge}>★ Event</span>
                                  )}
                                </div>
                                <div className={styles.saleName}>{sale.sale_name}</div>
                                <div className={styles.saleDates}>
                                  {format(parseISO(sale.start_date), 'MMM d')} - {format(parseISO(sale.end_date), 'MMM d, yyyy')}
                                </div>
                                <div className={styles.saleDiscount}>-{sale.discount_percentage}%</div>

                                {/* AI Prediction Row */}
                                {aiEnabled && (
                                  <>
                                    {isLoading && (
                                      <div className={styles.aiSpinner}>
                                        <span className={styles.aiSpinnerDot} />
                                        Analyzing...
                                      </div>
                                    )}
                                    {predError && (
                                      <div className={styles.aiError}>
                                        ⚠️ {predError}
                                      </div>
                                    )}
                                    {pred && !isLoading && (
                                      <div className={styles.aiPredictionRow}>
                                        {pred.optimal_discount !== sale.discount_percentage && (
                                          <span className={`${styles.aiDiscountBadge} ${sale.use_ai_discount !== false ? styles.accepted : ''}`}>
                                            🤖 {pred.optimal_discount}%
                                          </span>
                                        )}
                                        <span className={styles.aiRevenue}>
                                          {formatCurrency(pred.predicted_revenue)}
                                        </span>
                                        <span className={`${styles.aiConfidence} ${styles[`confidence_${pred.confidence}`]}`}>
                                          {pred.confidence}
                                        </span>
                                        {isAiVariation && pred.optimal_discount !== 50 && (
                                          <label className={styles.aiAcceptToggle} onClick={e => e.stopPropagation()}>
                                            <input
                                              type="checkbox"
                                              checked={sale.use_ai_discount !== false}
                                              onChange={() => toggleAiDiscount(sale.id)}
                                            />
                                            Use AI
                                          </label>
                                        )}
                                      </div>
                                    )}
                                  </>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    ))}

                    {filteredSales.length === 0 && (
                      <div className={styles.emptySales}>
                        <p>No sales generated for this selection.</p>
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          )}

          {/* Footer Actions */}
          <div className={styles.footer}>
            {step === 'config' && (
              <>
                <button className={styles.cancelButton} onClick={onClose}>
                  Cancel
                </button>
                <button
                  className={styles.generateButton}
                  onClick={handleGenerate}
                  disabled={selectedPlatformIds.length === 0}
                >
                  {aiEnabled ? '🤖 Generate with AI →' : 'Generate Calendar →'}
                </button>
              </>
            )}

            {step === 'preview' && (
              <>
                <button className={styles.backButton} onClick={() => { setStep('config'); setVariations([]); cancelPredictions() }}>
                  ← Back to Options
                </button>
                <div className={styles.footerRight}>
                  <button className={styles.cancelButton} onClick={onClose} disabled={isApplying}>
                    Cancel
                  </button>
                  <button
                    className={styles.applyButton}
                    onClick={handleApply}
                    disabled={isApplying || !displayVariation || displayVariation.sales.length === 0}
                  >
                    {isApplying ? 'Creating Sales...' : `Apply ${displayVariation?.stats.totalSales || 0} Sales`}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* PNG Export Modal */}
      <CalendarExport
        isOpen={showExport}
        onClose={() => setShowExport(false)}
        productName={productName}
        launchDate={launchDate}
        endDate={format(periodEndDate, 'yyyy-MM-dd')}
        variations={allVariations}
        predictions={predictions}
      />
    </>
  )
}
