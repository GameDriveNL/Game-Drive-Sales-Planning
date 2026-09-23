'use client'

import { useState } from 'react'
import { format, parseISO, differenceInDays, startOfMonth, endOfMonth, addMonths, getMonth, getYear, isBefore, isAfter } from 'date-fns'
import PptxGenJS from 'pptxgenjs'
import { SaleWithDetails, Platform, Product, Game, Client } from '@/lib/types'
import { CalendarVariation } from '@/lib/sale-calendar-generator'
import styles from './TimelineExportModal.module.css'

interface TimelineExportModalProps {
  isOpen: boolean
  onClose: () => void
  sales: SaleWithDetails[]
  products: (Product & { game: Game & { client: Client } })[]
  platforms: Platform[]
  timelineStart: Date
  monthCount: number
  // Optional: calendar variations from auto-generate
  calendarVariations?: CalendarVariation[]
}

type ViewMode = 'table' | 'timeline'

interface VariationSelection {
  current: boolean
  maximizeSales: boolean
  eventsOnly: boolean
}

export default function TimelineExportModal({
  isOpen,
  onClose,
  sales,
  products,
  platforms,
  timelineStart,
  monthCount,
  calendarVariations = []
}: TimelineExportModalProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('table')
  const [isExporting, setIsExporting] = useState(false)
  const [selectedVariations, setSelectedVariations] = useState<VariationSelection>({
    current: true,
    maximizeSales: false,
    eventsOnly: false
  })
  
  if (!isOpen) return null
  
  const periodStart = startOfMonth(timelineStart)
  const periodEnd = addMonths(periodStart, monthCount)
  
  // Generate months for the timeline
  const months: Date[] = []
  let current = periodStart
  while (current < periodEnd) {
    months.push(current)
    current = addMonths(current, 1)
  }
  
  // Find variations (may or may not exist)
  const maximizeSalesVariation = calendarVariations.find(v => v.name === 'Maximize Sales')
  const eventsOnlyVariation = calendarVariations.find(v => v.name === 'Events Only')
  
  // Get selected datasets
  const getSelectedDatasets = () => {
    const datasets: { name: string; sales: SaleWithDetails[] | CalendarVariation['sales'] }[] = []
    
    if (selectedVariations.current) {
      datasets.push({ name: 'Current Calendar', sales })
    }
    if (selectedVariations.maximizeSales && maximizeSalesVariation) {
      datasets.push({ name: 'Maximize Sales', sales: maximizeSalesVariation.sales as unknown as SaleWithDetails[] })
    }
    if (selectedVariations.eventsOnly && eventsOnlyVariation) {
      datasets.push({ name: 'Events Only', sales: eventsOnlyVariation.sales as unknown as SaleWithDetails[] })
    }
    
    return datasets
  }
  
  // Get platform name and color from sale
  const getPlatformInfo = (sale: SaleWithDetails | CalendarVariation['sales'][0]) => {
    if ('platform' in sale && sale.platform) {
      return { id: sale.platform_id, name: sale.platform.name, color: sale.platform.color_hex }
    }
    if ('platform_name' in sale) {
      return { id: sale.platform_id, name: sale.platform_name, color: sale.platform_color }
    }
    const platform = platforms.find(p => p.id === sale.platform_id)
    return { id: sale.platform_id, name: platform?.name || 'Unknown', color: platform?.color_hex || '#666666' }
  }
  
  // Get product name from sale
  const getProductName = (sale: SaleWithDetails | CalendarVariation['sales'][0]) => {
    if ('product' in sale && sale.product) {
      return sale.product.name
    }
    const product = products.find(p => p.id === sale.product_id)
    return product?.name || 'Unknown'
  }
  
  const handleExportPPTX = async () => {
    const datasets = getSelectedDatasets()
    if (datasets.length === 0) {
      alert('Please select at least one calendar variation to export')
      return
    }

    // Guard: warn if all selected variations have 0 sales
    const totalSalesCount = datasets.reduce((sum, d) => sum + d.sales.length, 0)
    if (totalSalesCount === 0) {
      alert('The selected calendar variation(s) have 0 sales. Add some sales first, or select a different variation.')
      return
    }

    setIsExporting(true)
    
    try {
      const pptx = new PptxGenJS()
      pptx.layout = 'LAYOUT_16x9'
      pptx.title = `Game Drive Sales Calendar ${format(periodStart, 'yyyy')}`
      pptx.author = 'Game Drive Sales Planning Tool'
      
      // Define colors
      const primaryColor = '1f2937'
      const headerBg = '3b82f6'
      const lightGray = 'f9fafb'
      const borderColor = 'e5e7eb'
      
      for (const dataset of datasets) {
        // Title slide for this variation
        const titleSlide = pptx.addSlide()
        titleSlide.addText('Game Drive', {
          x: 0.5, y: 0.3, w: 3, h: 0.5,
          fontSize: 18, fontFace: 'Arial', color: primaryColor, bold: true
        })
        titleSlide.addText('SALES PLANNING', {
          x: 0.5, y: 0.7, w: 3, h: 0.3,
          fontSize: 9, fontFace: 'Arial', color: '6b7280', charSpacing: 2
        })
        titleSlide.addText(`Sales Calendar ${format(periodStart, 'yyyy')}`, {
          x: 0.5, y: 2.2, w: 9, h: 0.8,
          fontSize: 36, fontFace: 'Arial', color: primaryColor, bold: true
        })
        titleSlide.addText(dataset.name, {
          x: 0.5, y: 3.0, w: 9, h: 0.5,
          fontSize: 24, fontFace: 'Arial', color: headerBg
        })
        titleSlide.addText(`${format(periodStart, 'MMMM yyyy')} — ${format(addMonths(periodEnd, -1), 'MMMM yyyy')}`, {
          x: 0.5, y: 3.5, w: 9, h: 0.4,
          fontSize: 14, fontFace: 'Arial', color: '6b7280'
        })
        titleSlide.addText(`Generated ${format(new Date(), 'MMM d, yyyy')}`, {
          x: 7.5, y: 4.8, w: 2, h: 0.3,
          fontSize: 10, fontFace: 'Arial', color: '9ca3af', align: 'right'
        })
        
        // Generate slides for each month
        for (const month of months) {
          const monthStart = startOfMonth(month)
          const monthEnd = endOfMonth(month)
          
          // Get sales that OVERLAP with this month (not just start in it)
          const monthSales = (dataset.sales as (SaleWithDetails | CalendarVariation['sales'][0])[]).filter(s => {
            const saleStart = parseISO(s.start_date)
            const saleEnd = parseISO(s.end_date)
            // Sale overlaps with month if: sale starts before month ends AND sale ends after month starts
            return !isAfter(saleStart, monthEnd) && !isBefore(saleEnd, monthStart)
          }).sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime())
          
          if (monthSales.length === 0) continue
          
          const slide = pptx.addSlide()
          
          // Header
          slide.addText('Game Drive', {
            x: 0.3, y: 0.2, w: 2, h: 0.3,
            fontSize: 11, fontFace: 'Arial', color: primaryColor, bold: true
          })
          slide.addText(dataset.name, {
            x: 7, y: 0.2, w: 2.5, h: 0.3,
            fontSize: 10, fontFace: 'Arial', color: '6b7280', align: 'right'
          })
          
          // Month title
          slide.addText(format(month, 'MMMM yyyy'), {
            x: 0.3, y: 0.6, w: 6, h: 0.5,
            fontSize: 24, fontFace: 'Arial', color: primaryColor, bold: true
          })
          slide.addText(`${monthSales.length} sales`, {
            x: 6.5, y: 0.7, w: 3, h: 0.3,
            fontSize: 12, fontFace: 'Arial', color: '6b7280', align: 'right'
          })
          
          // Divider line
          slide.addShape('rect', {
            x: 0.3, y: 1.15, w: 9.2, h: 0.03, fill: { color: headerBg }
          })
          
          if (viewMode === 'table') {
            // TABLE VIEW
            const tableData: PptxGenJS.TableRow[] = [
              // Header row
              [
                { text: 'Product', options: { fill: { color: headerBg }, color: 'ffffff', bold: true, fontSize: 10, fontFace: 'Arial' } },
                { text: 'Platform', options: { fill: { color: headerBg }, color: 'ffffff', bold: true, fontSize: 10, fontFace: 'Arial' } },
                { text: 'Start', options: { fill: { color: headerBg }, color: 'ffffff', bold: true, fontSize: 10, fontFace: 'Arial' } },
                { text: 'End', options: { fill: { color: headerBg }, color: 'ffffff', bold: true, fontSize: 10, fontFace: 'Arial' } },
                { text: 'Days', options: { fill: { color: headerBg }, color: 'ffffff', bold: true, fontSize: 10, fontFace: 'Arial', align: 'center' } },
                { text: 'Discount', options: { fill: { color: headerBg }, color: 'ffffff', bold: true, fontSize: 10, fontFace: 'Arial', align: 'center' } }
              ]
            ]
            
            // Data rows (max 12 per slide to avoid overflow)
            const maxRowsPerSlide = 12
            const salesToShow = monthSales.slice(0, maxRowsPerSlide)
            
            for (const sale of salesToShow) {
              // end_date is start_date + duration (feedback card 3deb3317), not
              // duration - 1, so the nominal day count is the raw difference.
              const days = differenceInDays(parseISO(sale.end_date), parseISO(sale.start_date))
              const platformInfo = getPlatformInfo(sale)
              const productName = getProductName(sale)
              
              tableData.push([
                { text: productName, options: { fontSize: 9, fontFace: 'Arial', color: primaryColor } },
                { text: platformInfo.name, options: { fontSize: 9, fontFace: 'Arial', color: platformInfo.color.replace('#', ''), bold: true } },
                { text: format(parseISO(sale.start_date), 'MMM d'), options: { fontSize: 9, fontFace: 'Arial', color: '4b5563' } },
                { text: format(parseISO(sale.end_date), 'MMM d'), options: { fontSize: 9, fontFace: 'Arial', color: '4b5563' } },
                { text: String(days), options: { fontSize: 9, fontFace: 'Arial', color: primaryColor, align: 'center' } },
                { text: `${sale.discount_percentage}%`, options: { fontSize: 10, fontFace: 'Arial', color: '059669', bold: true, align: 'center' } }
              ])
            }
            
            slide.addTable(tableData, {
              x: 0.3, y: 1.3, w: 9.2,
              colW: [2.8, 1.8, 1.1, 1.1, 0.7, 0.9],
              border: { pt: 0.5, color: borderColor },
              fontFace: 'Arial',
              autoPage: false
            })
            
            if (monthSales.length > maxRowsPerSlide) {
              slide.addText(`+ ${monthSales.length - maxRowsPerSlide} more sales`, {
                x: 0.3, y: 4.8, w: 9.2, h: 0.3,
                fontSize: 10, fontFace: 'Arial', color: '6b7280', italic: true
              })
            }
          } else {
            // TIMELINE VIEW - Group by Product + Platform (separate rows)
            const daysInMonth = new Date(getYear(month), getMonth(month) + 1, 0).getDate()
            const timelineWidth = 9.2
            const labelWidth = 2.2
            const chartWidth = timelineWidth - labelWidth
            const dayWidth = chartWidth / daysInMonth
            const timelineX = 0.3
            const chartX = timelineX + labelWidth
            const timelineY = 1.4
            
            // Day headers
            for (let day = 1; day <= daysInMonth; day += 3) {
              slide.addText(String(day), {
                x: chartX + (day - 1) * dayWidth,
                y: timelineY - 0.25,
                w: dayWidth * 3,
                h: 0.2,
                fontSize: 7,
                fontFace: 'Arial',
                color: '9ca3af',
                align: 'left'
              })
            }
            
            // Group sales by product+platform combination for separate rows
            const salesByRow: { [key: string]: { productName: string; platformInfo: { name: string; color: string }; sales: typeof monthSales } } = {}
            for (const sale of monthSales) {
              const productName = getProductName(sale)
              const platformInfo = getPlatformInfo(sale)
              const rowKey = `${sale.product_id}_${sale.platform_id}`
              
              if (!salesByRow[rowKey]) {
                salesByRow[rowKey] = {
                  productName,
                  platformInfo: { name: platformInfo.name, color: platformInfo.color },
                  sales: []
                }
              }
              salesByRow[rowKey].sales.push(sale)
            }
            
            const rowHeight = 0.32
            const maxRows = 10
            const rows = Object.values(salesByRow)
            const rowsToShow = rows.slice(0, maxRows)
            const gridHeight = rowsToShow.length * rowHeight
            
            // Timeline grid background
            slide.addShape('rect', {
              x: chartX, y: timelineY, w: chartWidth, h: gridHeight,
              fill: { color: lightGray },
              line: { color: borderColor, pt: 0.5 }
            })
            
            // Week dividers
            for (let day = 7; day < daysInMonth; day += 7) {
              slide.addShape('rect', {
                x: chartX + day * dayWidth, y: timelineY, w: 0.01, h: gridHeight,
                fill: { color: 'cccccc' }
              })
            }
            
            // Draw rows
            let rowIndex = 0
            for (const row of rowsToShow) {
              const rowY = timelineY + rowIndex * rowHeight
              
              // Row background (alternating)
              if (rowIndex % 2 === 1) {
                slide.addShape('rect', {
                  x: chartX, y: rowY, w: chartWidth, h: rowHeight,
                  fill: { color: 'f3f4f6' }
                })
              }
              
              // Product + Platform label
              const labelText = `${row.productName.substring(0, 12)}${row.productName.length > 12 ? '…' : ''}`
              slide.addText(labelText, {
                x: timelineX, y: rowY, w: labelWidth - 0.6, h: rowHeight,
                fontSize: 7, fontFace: 'Arial', color: primaryColor, valign: 'middle'
              })
              
              // Platform badge
              slide.addShape('roundRect', {
                x: timelineX + labelWidth - 0.55, y: rowY + 0.06, w: 0.5, h: rowHeight - 0.12,
                fill: { color: row.platformInfo.color.replace('#', '') },
                rectRadius: 0.02
              })
              slide.addText(row.platformInfo.name.substring(0, 2).toUpperCase(), {
                x: timelineX + labelWidth - 0.55, y: rowY + 0.06, w: 0.5, h: rowHeight - 0.12,
                fontSize: 6, fontFace: 'Arial', color: 'ffffff', bold: true,
                align: 'center', valign: 'middle'
              })
              
              // Sale blocks for this row
              for (const sale of row.sales) {
                const saleStart = parseISO(sale.start_date)
                const saleEnd = parseISO(sale.end_date)
                
                // Clip sale to month boundaries
                const visibleStart = isBefore(saleStart, monthStart) ? monthStart : saleStart
                const visibleEnd = isAfter(saleEnd, monthEnd) ? monthEnd : saleEnd
                
                const startDay = visibleStart.getDate()
                const endDay = visibleEnd.getDate()
                const visibleDays = endDay - startDay + 1
                
                // Skip very small slivers (less than 2 days visible)
                if (visibleDays < 2) continue
                
                const blockX = chartX + (startDay - 1) * dayWidth
                const blockW = visibleDays * dayWidth
                const blockY = rowY + 0.04
                const blockH = rowHeight - 0.08
                
                // Sale block with rounded corners
                slide.addShape('roundRect', {
                  x: blockX, y: blockY, w: Math.max(blockW, 0.1), h: blockH,
                  fill: { color: row.platformInfo.color.replace('#', '') },
                  rectRadius: 0.02
                })
                
                // Discount label on block (if wide enough)
                if (blockW > 0.4) {
                  slide.addText(`${sale.discount_percentage}%`, {
                    x: blockX, y: blockY, w: blockW, h: blockH,
                    fontSize: 6, fontFace: 'Arial', color: 'ffffff', bold: true,
                    align: 'center', valign: 'middle'
                  })
                }
              }
              
              rowIndex++
            }
            
            if (rows.length > maxRows) {
              slide.addText(`+ ${rows.length - maxRows} more rows`, {
                x: 0.3, y: timelineY + gridHeight + 0.1, w: 9.2, h: 0.3,
                fontSize: 9, fontFace: 'Arial', color: '6b7280', italic: true
              })
            }
          }
          
          // Footer
          slide.addText('Generated by Game Drive Sales Planning Tool', {
            x: 0.3, y: 5.0, w: 6, h: 0.2,
            fontSize: 8, fontFace: 'Arial', color: '9ca3af', italic: true
          })
        }
      }
      
      // Save the file
      const fileName = `GameDrive_Sales_Calendar_${format(new Date(), 'yyyy-MM-dd_HH-mm')}.pptx`
      await pptx.writeFile({ fileName })
      
    } catch (err) {
      console.error('Export failed:', err)
      alert('Export failed. Please try again.')
    } finally {
      setIsExporting(false)
    }
  }
  
  const selectedCount = Object.values(selectedVariations).filter(Boolean).length
  const selectedDatasets = getSelectedDatasets()
  const totalSelectedSales = selectedDatasets.reduce((sum, d) => sum + d.sales.length, 0)

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <h2>Export to PowerPoint</h2>
          <button className={styles.closeBtn} onClick={onClose}>×</button>
        </div>
        
        <div className={styles.exportOptions}>
          {/* View Mode Selection */}
          <div className={styles.optionGroup}>
            <label className={styles.optionLabel}>View Mode</label>
            <div className={styles.viewToggle}>
              <button 
                className={`${styles.viewBtn} ${viewMode === 'table' ? styles.viewBtnActive : ''}`}
                onClick={() => setViewMode('table')}
              >
                📊 Table View
              </button>
              <button 
                className={`${styles.viewBtn} ${viewMode === 'timeline' ? styles.viewBtnActive : ''}`}
                onClick={() => setViewMode('timeline')}
              >
                📅 Timeline View
              </button>
            </div>
            <p className={styles.optionHint}>
              {viewMode === 'table' 
                ? 'Clean table with Product, Platform, Dates, and Discount columns'
                : 'Visual Gantt-style timeline with colored sale blocks'
              }
            </p>
          </div>
          
          {/* Calendar Variation Selection */}
          <div className={styles.optionGroup}>
            <label className={styles.optionLabel}>Calendar Variations to Export</label>
            <div className={styles.checkboxGroup}>
              {/* Current Calendar - always available */}
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  checked={selectedVariations.current}
                  onChange={(e) => setSelectedVariations(prev => ({ ...prev, current: e.target.checked }))}
                />
                <span className={styles.checkboxLabel}>
                  <strong>Current Calendar</strong>
                  <span className={styles.checkboxMeta}>{sales.length} sales</span>
                </span>
              </label>

              {/* Maximize Sales */}
              <label className={`${styles.checkbox} ${!maximizeSalesVariation ? styles.checkboxDisabled : ''}`}>
                <input
                  type="checkbox"
                  checked={selectedVariations.maximizeSales}
                  disabled={!maximizeSalesVariation}
                  onChange={(e) => setSelectedVariations(prev => ({ ...prev, maximizeSales: e.target.checked }))}
                />
                <span className={styles.checkboxLabel}>
                  <strong>Maximize Sales</strong>
                  <span className={styles.checkboxMeta}>
                    {maximizeSalesVariation
                      ? `${maximizeSalesVariation.stats.totalSales} sales • ${maximizeSalesVariation.stats.percentageOnSale}% on sale`
                      : 'Generate calendar first'
                    }
                  </span>
                </span>
              </label>

              {/* Events Only */}
              <label className={`${styles.checkbox} ${!eventsOnlyVariation ? styles.checkboxDisabled : ''}`}>
                <input
                  type="checkbox"
                  checked={selectedVariations.eventsOnly}
                  disabled={!eventsOnlyVariation}
                  onChange={(e) => setSelectedVariations(prev => ({ ...prev, eventsOnly: e.target.checked }))}
                />
                <span className={styles.checkboxLabel}>
                  <strong>Events Only</strong>
                  <span className={styles.checkboxMeta}>
                    {eventsOnlyVariation
                      ? `${eventsOnlyVariation.stats.totalSales} sales • ${eventsOnlyVariation.stats.percentageOnSale}% on sale`
                      : 'Generate calendar first'
                    }
                  </span>
                </span>
              </label>
            </div>
          </div>
          
          {/* Export Info */}
          <div className={styles.exportInfo}>
            <div className={styles.infoItem}>
              <span className={styles.infoIcon}>📄</span>
              <span>One slide per month with sales</span>
            </div>
            <div className={styles.infoItem}>
              <span className={styles.infoIcon}>📊</span>
              <span>{selectedCount} variation{selectedCount !== 1 ? 's' : ''} selected</span>
            </div>
            <div className={styles.infoItem}>
              <span className={styles.infoIcon}>📅</span>
              <span>{monthCount} months ({format(periodStart, 'MMM yyyy')} - {format(addMonths(periodEnd, -1), 'MMM yyyy')})</span>
            </div>
          </div>

          {/* Empty sales warning */}
          {selectedCount > 0 && totalSelectedSales === 0 && (
            <div style={{ padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '6px', color: '#dc2626', fontSize: '13px', marginTop: '12px' }}>
              The selected variation(s) contain <strong>0 sales</strong>. The export will only contain title slides. Add sales to your calendar first.
            </div>
          )}
        </div>
        
        <div className={styles.footer}>
          <button className={styles.cancelBtn} onClick={onClose}>
            Cancel
          </button>
          <button 
            className={styles.exportBtn}
            onClick={handleExportPPTX}
            disabled={isExporting || selectedCount === 0}
          >
            {isExporting ? '⏳ Generating...' : '📥 Export PowerPoint'}
          </button>
        </div>
      </div>
    </div>
  )
}
