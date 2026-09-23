'use client'

import { useDraggable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { format, parseISO, addDays, differenceInDays } from 'date-fns'
import { useState, useCallback, useRef, useEffect } from 'react'
import { SaleWithDetails } from '@/lib/types'
import { computeSaleTemporalStatus, getTemporalStatusLabel, getTemporalStatusColor } from '@/lib/dateUtils'
import styles from './SaleBlock.module.css'

interface SaleBlockProps {
  sale: SaleWithDetails
  left: number
  width: number
  dayWidth: number
  isDragging?: boolean
  optimisticLeft?: number
  onEdit: (sale: SaleWithDetails) => void
  onDelete: (saleId: string) => Promise<void>
  onDuplicate?: (sale: SaleWithDetails) => void
  onResize?: (saleId: string, newStart: string, newEnd: string) => Promise<void>
  onSelect?: (sale: SaleWithDetails) => void
  onCopy?: (sale: SaleWithDetails) => void
  isSelected?: boolean
}

export default function SaleBlock({ 
  sale, 
  left, 
  width, 
  dayWidth = 28,
  isDragging: externalDragging,
  optimisticLeft,
  onEdit,
  onDelete,
  onDuplicate,
  onResize,
  onSelect,
  onCopy,
  isSelected = false
}: SaleBlockProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: sale.id,
    data: { sale }
  })
  
  const [isResizing, setIsResizing] = useState<'left' | 'right' | null>(null)
  const [resizeOffset, setResizeOffset] = useState(0)
  const [showContextMenu, setShowContextMenu] = useState(false)
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 })
  const resizeRef = useRef<{
    startX: number
    initialStart: string
    initialEnd: string
    edge: 'left' | 'right'
  } | null>(null)
  
  // Use optimistic position if provided, otherwise use actual position
  const displayLeft = optimisticLeft !== undefined ? optimisticLeft : left
  
  // Calculate display values based on resize offset
  const displayWidth = isResizing 
    ? (isResizing === 'right' ? width + resizeOffset : width - resizeOffset)
    : width
  const displayLeftPos = isResizing === 'left' 
    ? displayLeft + resizeOffset 
    : displayLeft
  
  const style = {
    left: displayLeftPos,
    width: Math.max(dayWidth, displayWidth), // Minimum 1 day width
    backgroundColor: sale.platform?.color_hex || '#3b82f6',
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.7 : 1,
    zIndex: isDragging || isResizing ? 100 : isSelected ? 10 : 5,
    cursor: isDragging ? 'grabbing' : isResizing ? 'ew-resize' : 'grab',
    boxShadow: isSelected ? `0 0 0 2px white, 0 0 0 4px ${sale.platform?.color_hex || '#3b82f6'}` : undefined,
  }
  
  const startDate = parseISO(sale.start_date)
  const endDate = parseISO(sale.end_date)

  const displayName = sale.sale_name || 'Custom Sale'
  const discountText = sale.discount_percentage ? `-${sale.discount_percentage}%` : ''

  // D10: flag sales dragged/resized longer than the platform's recommended max —
  // previously this warning only surfaced inside the Edit modal, so a resize
  // done straight on the timeline could exceed it with no visible sign.
  // exclusiveDays matches the "Excel-style" count used in Add/Edit Sale's own check.
  // inclusiveDays is the nominal duration: end_date is start_date + duration
  // (card 3deb3317), not duration - 1, so no +1 is needed here.
  const inclusiveDays = differenceInDays(endDate, startDate)
  const exclusiveDays = inclusiveDays - 1
  const exceedsMaxDays = !!sale.platform?.max_sale_days && exclusiveDays > sale.platform.max_sale_days

  // Compute temporal status based on current date (not stored status)
  const temporalStatus = computeSaleTemporalStatus(sale.start_date, sale.end_date)
  const temporalStatusLabel = getTemporalStatusLabel(temporalStatus)
  const temporalStatusColor = getTemporalStatusColor(temporalStatus)

  // Workflow status colors (for stored status like planned, submitted, confirmed)
  const workflowStatusColors: Record<string, string> = {
    planned: '#94a3b8',
    submitted: '#f59e0b',
    confirmed: '#22c55e',
    live: '#ef4444',
    ended: '#6b7280'
  }

  const handleClick = (e: React.MouseEvent) => {
    // Only trigger if not dragging/resizing and click target is not a button or handle
    if (!isDragging && !isResizing && !(e.target as HTMLElement).closest('button') && !(e.target as HTMLElement).closest(`.${styles.resizeHandle}`)) {
      // If clicking with modifier key, select instead of edit
      if (e.ctrlKey || e.metaKey) {
        if (onSelect) {
          e.preventDefault()
          e.stopPropagation()
          onSelect(sale)
        }
      } else {
        onEdit(sale)
      }
    }
  }

  // Right-click context menu
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    
    // Select the sale on right-click
    if (onSelect) {
      onSelect(sale)
    }
    
    setContextMenuPos({ x: e.clientX, y: e.clientY })
    setShowContextMenu(true)
  }

  // Close context menu when clicking outside
  useEffect(() => {
    if (!showContextMenu) return
    
    const handleClickOutside = () => {
      setShowContextMenu(false)
    }
    
    document.addEventListener('click', handleClickOutside)
    document.addEventListener('contextmenu', handleClickOutside)
    
    return () => {
      document.removeEventListener('click', handleClickOutside)
      document.removeEventListener('contextmenu', handleClickOutside)
    }
  }, [showContextMenu])

  const handleResizeStart = useCallback((edge: 'left' | 'right', e: React.MouseEvent) => {
    if (!onResize) return
    e.preventDefault()
    e.stopPropagation()
    
    resizeRef.current = {
      startX: e.clientX,
      initialStart: sale.start_date,
      initialEnd: sale.end_date,
      edge
    }
    setIsResizing(edge)
    setResizeOffset(0)
  }, [onResize, sale.start_date, sale.end_date])

  const handleResizeMove = useCallback((e: MouseEvent) => {
    if (!resizeRef.current || !isResizing) return
    
    const deltaX = e.clientX - resizeRef.current.startX
    // Snap to day increments
    const daysDelta = Math.round(deltaX / dayWidth)
    const pixelOffset = daysDelta * dayWidth
    
    // Prevent making sale shorter than 1 day. end_date is start_date +
    // duration (card 3deb3317), not duration - 1, so no +1 is needed here.
    const currentDays = differenceInDays(parseISO(sale.end_date), parseISO(sale.start_date))
    
    if (isResizing === 'left') {
      // Left edge: positive delta shrinks sale, negative extends it
      const newDays = currentDays - daysDelta
      if (newDays >= 1) {
        setResizeOffset(pixelOffset)
      }
    } else {
      // Right edge: positive delta extends sale, negative shrinks it
      const newDays = currentDays + daysDelta
      if (newDays >= 1) {
        setResizeOffset(pixelOffset)
      }
    }
  }, [isResizing, dayWidth, sale.start_date, sale.end_date])

  const handleResizeEnd = useCallback(async () => {
    if (!resizeRef.current || !isResizing || !onResize) {
      resizeRef.current = null
      setIsResizing(null)
      setResizeOffset(0)
      return
    }
    
    const daysDelta = Math.round(resizeOffset / dayWidth)
    
    if (daysDelta === 0) {
      resizeRef.current = null
      setIsResizing(null)
      setResizeOffset(0)
      return
    }
    
    const originalStart = parseISO(resizeRef.current.initialStart)
    const originalEnd = parseISO(resizeRef.current.initialEnd)
    
    let newStart: Date, newEnd: Date
    
    if (isResizing === 'left') {
      newStart = addDays(originalStart, daysDelta)
      newEnd = originalEnd
    } else {
      newStart = originalStart
      newEnd = addDays(originalEnd, daysDelta)
    }
    
    const newStartStr = format(newStart, 'yyyy-MM-dd')
    const newEndStr = format(newEnd, 'yyyy-MM-dd')
    
    resizeRef.current = null
    setIsResizing(null)
    setResizeOffset(0)
    
    try {
      await onResize(sale.id, newStartStr, newEndStr)
    } catch (err) {
      console.error('Error resizing sale:', err)
    }
  }, [isResizing, resizeOffset, dayWidth, onResize, sale.id])

  // Global mouse event listeners for resize
  useEffect(() => {
    if (!isResizing) return
    
    const handleMouseMove = (e: MouseEvent) => {
      handleResizeMove(e)
    }
    
    const handleMouseUp = () => {
      handleResizeEnd()
    }
    
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing, handleResizeMove, handleResizeEnd])

  return (
    <>
      <div
        ref={setNodeRef}
        className={`${styles.saleBlock} ${isDragging ? styles.dragging : ''} ${isResizing ? styles.resizing : ''} ${isSelected ? styles.selected : ''} ${exceedsMaxDays ? styles.exceedsMaxDays : ''}`}
        style={style}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title={`${displayName}\n${format(startDate, 'MMM d')} - ${format(endDate, 'MMM d, yyyy')}\n${sale.platform?.name || 'Unknown Platform'}\n${discountText}${exceedsMaxDays ? `\n⚠️ Exceeds ${sale.platform?.name}'s recommended max of ${sale.platform?.max_sale_days} days (${exclusiveDays} days)` : ''}\nClick to edit • Ctrl/⌘+Click to select • Right-click for menu`}
      >
        {/* Left resize handle */}
        {onResize && (
          <div
            className={`${styles.resizeHandle} ${styles.resizeHandleLeft}`}
            onMouseDown={(e) => handleResizeStart('left', e)}
          />
        )}
        
        <div 
          className={styles.dragHandle}
          {...listeners}
          {...attributes}
        >
          <span className={styles.saleName}>
            {exceedsMaxDays && <span className={styles.maxDaysWarningIcon}>⚠️</span>}
            {displayName} {discountText}
          </span>
          
          {/* Show computed temporal status (Upcoming/Live/Ended) based on dates */}
          <span
            className={styles.statusBadge}
            style={{ backgroundColor: temporalStatusColor }}
            title={`Sale dates: ${sale.start_date} to ${sale.end_date}`}
          >
            {temporalStatusLabel}
          </span>
        </div>
        
        <div className={styles.actions}>
          {onCopy && (
            <button
              className={styles.copyBtn}
              onClick={(e) => {
                e.stopPropagation()
                onCopy(sale)
              }}
              title="Copy sale (⌘C)"
            >
              📋
            </button>
          )}
          {onDuplicate && (
            <button
              className={styles.duplicateBtn}
              onClick={(e) => {
                e.stopPropagation()
                onDuplicate(sale)
              }}
              title="Duplicate sale"
            >
              ⧉
            </button>
          )}
          <button
            className={styles.deleteBtn}
            onClick={(e) => {
              e.stopPropagation()
              onDelete(sale.id)
            }}
            title="Delete sale"
          >
            ×
          </button>
        </div>
        
        {/* Right resize handle */}
        {onResize && (
          <div
            className={`${styles.resizeHandle} ${styles.resizeHandleRight}`}
            onMouseDown={(e) => handleResizeStart('right', e)}
          />
        )}
      </div>
      
      {/* Context Menu */}
      {showContextMenu && (
        <div 
          className={styles.contextMenu}
          style={{ left: contextMenuPos.x, top: contextMenuPos.y }}
        >
          <button onClick={() => { onEdit(sale); setShowContextMenu(false); }}>
            ✏️ Edit Sale
          </button>
          {onCopy && (
            <button onClick={() => { onCopy(sale); setShowContextMenu(false); }}>
              📋 Copy (⌘C)
            </button>
          )}
          {onDuplicate && (
            <button onClick={() => { onDuplicate(sale); setShowContextMenu(false); }}>
              ⧉ Duplicate
            </button>
          )}
          <hr />
          <button 
            className={styles.deleteMenuItem}
            onClick={() => { onDelete(sale.id); setShowContextMenu(false); }}
          >
            🗑️ Delete
          </button>
        </div>
      )}
    </>
  )
}
