'use client'

import { useState, useMemo, useRef, useCallback, useEffect } from 'react'
import { DndContext, DragEndEvent, DragStartEvent, useSensor, useSensors, PointerSensor, DragOverlay } from '@dnd-kit/core'
import { format, addDays, differenceInDays, parseISO, startOfMonth, endOfMonth, eachDayOfInterval, isToday, startOfQuarter, endOfQuarter, eachQuarterOfInterval, addMonths, subMonths } from 'date-fns'
import { Sale, Platform, Product, Game, Client, SaleWithDetails, PlatformEvent, LaunchConflict } from '@/lib/types'
import { validateSale } from '@/lib/validation'
import { normalizeToLocalDate } from '@/lib/dateUtils'
import SaleBlock from './SaleBlock'
import styles from './GanttChart.module.css'

// Extended prefill type for direct paste support
interface SalePrefill {
  productId: string
  platformId: string
  startDate: string
  endDate: string
  // Optional fields for direct paste (skip modal)
  directCreate?: boolean
  saleName?: string
  discountPercentage?: number
  saleType?: string
}

export interface CoverageDayData {
  count: number
  topTier: string  // 'A' | 'B' | 'C' | 'D' | ''
  totalReach: number
  items: { title: string; outlet: string; tier: string; type: string }[]
}

interface GanttChartProps {
  sales: SaleWithDetails[]
  products: (Product & { game: Game & { client: Client } })[]
  platforms: Platform[]
  platformEvents: PlatformEvent[]
  timelineStart: Date
  monthCount: number
  onSaleUpdate: (saleId: string, updates: Partial<Sale>) => Promise<void>
  onSaleDelete: (saleId: string) => Promise<void>
  onSaleEdit: (sale: SaleWithDetails) => void
  onSaleDuplicate?: (sale: SaleWithDetails) => void
  onCreateSale?: (prefill: SalePrefill) => void
  onGenerateCalendar?: (productId: string, productName: string, launchDate?: string) => void
  onClearSales?: (productId: string, productName: string) => void
  onLaunchDateChange?: (productId: string, newLaunchDate: string) => Promise<void>
  onEditLaunchDate?: (productId: string, productName: string, currentLaunchDate: string, currentDuration: number) => void
  onLaunchSaleDurationChange?: (productId: string, newDuration: number) => Promise<void>
  allSales: SaleWithDetails[]
  showEvents?: boolean
  coverageByDate?: Record<string, CoverageDayData>
  showCoverage?: boolean
}

interface SelectionState {
  productId: string
  platformId: string
  startDayIndex: number
  endDayIndex: number
}

interface LaunchDateDragState {
  productId: string
  originalDate: string
  currentDayIndex: number
}

interface LaunchSaleResizeState {
  productId: string
  originalDuration: number
  currentDuration: number
  edge: 'right'
}

interface CascadeShift {
  saleId: string
  newStart: string
  newEnd: string
}

interface PlatformGapInfo {
  quarter: string
  availableDays: number
  longestGap: number
}

// Clipboard sale data for copy/paste
interface ClipboardSale {
  saleName: string | null
  discountPercentage: number | null
  duration: number
  saleType: string
  platformId: string
  platformName: string
}

// Context menu state for right-click paste
interface ContextMenuState {
  visible: boolean
  x: number
  y: number
  productId: string
  platformId: string
  dayIndex: number
}

const ZOOM_LEVELS = [
  { name: 'Year', monthsVisible: 12, label: 'Y' },
  { name: 'Half Year', monthsVisible: 6, label: 'H' },
  { name: 'Quarter', monthsVisible: 3, label: 'Q' },
  { name: 'Month', monthsVisible: 1.5, label: 'M' },
  { name: '2 Weeks', monthsVisible: 0.5, label: '2W' },
]

const DEFAULT_ZOOM_INDEX = 1
const SIDEBAR_WIDTH = 220
const ROW_HEIGHT = 40
const HEADER_HEIGHT = 60
const SCROLL_THRESHOLD = 300
const MONTHS_TO_LOAD = 3

const DAY_STATUS = {
  AVAILABLE: 0,
  IN_SALE: 1,
  IN_COOLDOWN: 2
} as const

const MIN_LAUNCH_SALE_DAYS = 1
const MAX_LAUNCH_SALE_DAYS = 30

export default function GanttChart(props: GanttChartProps) {
  const {
    sales,
    products,
    platforms,
    platformEvents,
    timelineStart: initialTimelineStart,
    monthCount: initialMonthCount,
    onSaleUpdate,
    onSaleDelete,
    onSaleEdit,
    onSaleDuplicate,
    onCreateSale,
    onGenerateCalendar,
    onClearSales,
    onLaunchDateChange,
    onEditLaunchDate,
    onLaunchSaleDurationChange,
    allSales,
    showEvents = true,
    coverageByDate,
    showCoverage = false
  } = props
  
  const [timelineStart, setTimelineStart] = useState(() => {
    return subMonths(initialTimelineStart, 3)
  })
  const [monthCount, setMonthCount] = useState(initialMonthCount + 6)
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX)
  const [containerWidth, setContainerWidth] = useState(1200)
  const [hasReceivedMeasurement, setHasReceivedMeasurement] = useState(false)
  const [hasInitialScrolled, setHasInitialScrolled] = useState(false)
  
  // Legend collapse state
  const [isLegendCollapsed, setIsLegendCollapsed] = useState(false)
  
  // Copy/paste state
  const [selectedSaleId, setSelectedSaleId] = useState<string | null>(null)
  const [clipboardSale, setClipboardSale] = useState<ClipboardSale | null>(null)
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null)
  
  // Context menu state for right-click paste
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    productId: '',
    platformId: '',
    dayIndex: 0
  })
  
  const dayWidth = useMemo(() => {
    const monthsVisible = ZOOM_LEVELS[zoomIndex].monthsVisible
    const daysVisible = monthsVisible * 30.44
    const availableWidth = containerWidth - SIDEBAR_WIDTH
    const calculated = availableWidth / daysVisible
    return Math.max(4, calculated)
  }, [zoomIndex, containerWidth])
  
  const [draggedSale, setDraggedSale] = useState<SaleWithDetails | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [optimisticUpdates, setOptimisticUpdates] = useState<Record<string, { startDate: string; endDate: string }>>({})
  const [selection, setSelection] = useState<SelectionState | null>(null)
  const [launchDateDrag, setLaunchDateDrag] = useState<LaunchDateDragState | null>(null)
  const [launchSaleResize, setLaunchSaleResize] = useState<LaunchSaleResizeState | null>(null)
  const [isGrabbing, setIsGrabbing] = useState(false)
  const [scrollProgress, setScrollProgress] = useState(0)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const scrollTrackRef = useRef<HTMLDivElement>(null)
  
  const selectionRef = useRef<{
    data: SelectionState
    callback: typeof onCreateSale
    days: Date[]
  } | null>(null)
  
  const launchDragRef = useRef<{
    productId: string
    originalDate: string
    startX: number
    hasMoved: boolean
  } | null>(null)
  
  const launchSaleResizeRef = useRef<{
    productId: string
    originalDuration: number
    startX: number
    launchDate: string
  } | null>(null)
  
  const scrollGrabRef = useRef<{
    startX: number
    startScrollLeft: number
    isThumbDrag: boolean
  } | null>(null)
  
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width
        if (width > 0) {
          setContainerWidth(width)
          setHasReceivedMeasurement(true)
        }
      }
    })
    
    resizeObserver.observe(container)
    const initialWidth = container.clientWidth
    if (initialWidth > 0) {
      setContainerWidth(initialWidth)
      setHasReceivedMeasurement(true)
    }
    
    return () => resizeObserver.disconnect()
  }, [])
  
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  )
  
  const { months, days, totalDays, todayIndex } = useMemo(() => {
    const monthsArr: { date: Date; days: number }[] = []
    const daysArr: Date[] = []
    
    for (let i = 0; i < monthCount; i++) {
      const monthDate = new Date(timelineStart.getFullYear(), timelineStart.getMonth() + i, 1)
      const monthDays = eachDayOfInterval({
        start: startOfMonth(monthDate),
        end: endOfMonth(monthDate)
      })
      monthsArr.push({ date: monthDate, days: monthDays.length })
      daysArr.push(...monthDays)
    }
    
    const todayIdx = daysArr.findIndex(day => isToday(day))
    
    return { months: monthsArr, days: daysArr, totalDays: daysArr.length, todayIndex: todayIdx }
  }, [timelineStart, monthCount])

  const timelineEnd = useMemo(() => {
    const end = new Date(timelineStart)
    end.setMonth(end.getMonth() + monthCount)
    return end
  }, [timelineStart, monthCount])

  const quarters = useMemo(() => {
    return eachQuarterOfInterval({
      start: timelineStart,
      end: timelineEnd
    })
  }, [timelineStart, timelineEnd])

  const visibleDateRange = useMemo(() => {
    if (!scrollContainerRef.current) return null
    const scrollLeft = scrollContainerRef.current.scrollLeft
    const visibleWidth = containerWidth - SIDEBAR_WIDTH
    const startDayIndex = Math.floor(scrollLeft / dayWidth)
    const endDayIndex = Math.min(Math.floor((scrollLeft + visibleWidth) / dayWidth), days.length - 1)
    
    if (startDayIndex >= 0 && startDayIndex < days.length && endDayIndex >= 0) {
      return {
        start: days[startDayIndex],
        end: days[endDayIndex]
      }
    }
    return null
  }, [days, dayWidth, scrollProgress, containerWidth])

  const steamPlatformIds = useMemo(() => {
    return platforms
      .filter(p => p.name.toLowerCase().includes('steam'))
      .map(p => p.id)
  }, [platforms])

  const steamSeasonalEvents = useMemo(() => {
    if (steamPlatformIds.length === 0) return []
    return platformEvents.filter(e => 
      steamPlatformIds.includes(e.platform_id) && 
      e.event_type === 'seasonal'
    )
  }, [platformEvents, steamPlatformIds])

  const getLaunchSaleConflicts = useCallback((launchDate: string, duration: number): LaunchConflict[] => {
    if (steamPlatformIds.length === 0 || steamSeasonalEvents.length === 0) return []

    const launchStart = normalizeToLocalDate(launchDate)
    const launchEnd = addDays(launchStart, duration - 1)

    const conflicts: LaunchConflict[] = []

    for (const event of steamSeasonalEvents) {
      const eventStart = normalizeToLocalDate(event.start_date)
      const eventEnd = normalizeToLocalDate(event.end_date)

      if (launchStart <= eventEnd && launchEnd >= eventStart) {
        const overlapStart = launchStart > eventStart ? launchStart : eventStart
        const overlapEnd = launchEnd < eventEnd ? launchEnd : eventEnd
        const overlapDays = differenceInDays(overlapEnd, overlapStart) + 1

        conflicts.push({
          eventName: event.name,
          eventStart,
          eventEnd,
          overlapStart,
          overlapEnd,
          overlapDays
        })
      }
    }

    return conflicts
  }, [steamPlatformIds, steamSeasonalEvents])

  const platformGaps = useMemo(() => {
    const gapMap = new Map<string, PlatformGapInfo[]>()

    for (const product of products) {
      for (const platform of platforms) {
        const key = `${product.id}-${platform.id}`
        const cooldownDays = platform.cooldown_days || 28

        const productSales = sales
          .filter(s => s.product_id === product.id && s.platform_id === platform.id)
          .map(s => ({
            start: normalizeToLocalDate(s.start_date),
            end: normalizeToLocalDate(s.end_date),
            saleType: s.sale_type
          }))
          .sort((a, b) => a.start.getTime() - b.start.getTime())

        const quarterGaps: PlatformGapInfo[] = []

        for (const quarterStart of quarters) {
          const quarterEnd = endOfQuarter(quarterStart)
          const quarterLabel = `Q${Math.floor(quarterStart.getMonth() / 3) + 1}`
          
          const daysInQuarter = differenceInDays(quarterEnd, quarterStart) + 1
          const dayStatus = new Array(daysInQuarter).fill(DAY_STATUS.AVAILABLE)
          
          for (const sale of productSales) {
            if (sale.end >= quarterStart && sale.start <= quarterEnd) {
              const overlapStart = sale.start < quarterStart ? quarterStart : sale.start
              const overlapEnd = sale.end > quarterEnd ? quarterEnd : sale.end
              
              const startIdx = differenceInDays(overlapStart, quarterStart)
              const endIdx = differenceInDays(overlapEnd, quarterStart)
              
              for (let i = startIdx; i <= endIdx && i < daysInQuarter; i++) {
                if (i >= 0) dayStatus[i] = DAY_STATUS.IN_SALE
              }
            }
          }
          
          for (const sale of productSales) {
            if (sale.saleType === 'special') continue
            
            const cooldownStart = addDays(sale.end, 1)
            const cooldownEnd = addDays(sale.end, cooldownDays)
            
            if (cooldownEnd >= quarterStart && cooldownStart <= quarterEnd) {
              const overlapStart = cooldownStart < quarterStart ? quarterStart : cooldownStart
              const overlapEnd = cooldownEnd > quarterEnd ? quarterEnd : cooldownEnd
              
              const startIdx = differenceInDays(overlapStart, quarterStart)
              const endIdx = differenceInDays(overlapEnd, quarterStart)
              
              for (let i = startIdx; i <= endIdx && i < daysInQuarter; i++) {
                if (i >= 0 && dayStatus[i] !== DAY_STATUS.IN_SALE) {
                  dayStatus[i] = DAY_STATUS.IN_COOLDOWN
                }
              }
            }
          }

          const availableDays = dayStatus.filter(s => s === DAY_STATUS.AVAILABLE).length

          let longestGap = 0
          let currentGap = 0

          for (let i = 0; i < daysInQuarter; i++) {
            if (dayStatus[i] === DAY_STATUS.AVAILABLE) {
              currentGap++
            } else {
              if (currentGap > longestGap) longestGap = currentGap
              currentGap = 0
            }
          }
          if (currentGap > longestGap) longestGap = currentGap

          if (availableDays >= 7) {
            quarterGaps.push({
              quarter: quarterLabel,
              availableDays,
              longestGap
            })
          }
        }

        if (quarterGaps.length > 0) {
          gapMap.set(key, quarterGaps)
        }
      }
    }

    return gapMap
  }, [products, platforms, sales, quarters])

  const getGapIndicator = useCallback((productId: string, platformId: string): { text: string; isWarning: boolean } | null => {
    const key = `${productId}-${platformId}`
    const gaps = platformGaps.get(key)
    
    if (!gaps || gaps.length === 0) return null

    const now = new Date()
    const currentQuarter = `Q${Math.floor(now.getMonth() / 3) + 1}`

    const currentGap = gaps.find(g => g.quarter === currentQuarter)
    if (currentGap && currentGap.availableDays >= 7) {
      return {
        text: `${currentGap.availableDays}d gap ${currentGap.quarter}`,
        isWarning: currentGap.availableDays >= 30
      }
    }

    const sortedGaps = [...gaps].sort((a, b) => b.availableDays - a.availableDays)
    const largestGap = sortedGaps[0]
    
    if (largestGap && largestGap.availableDays >= 14) {
      return {
        text: `${largestGap.availableDays}d gap ${largestGap.quarter}`,
        isWarning: largestGap.availableDays >= 30
      }
    }

    return null
  }, [platformGaps])
  
  const handleInfiniteScroll = useCallback(() => {
    if (!scrollContainerRef.current || isLoadingMore) return
    
    const { scrollLeft, scrollWidth, clientWidth } = scrollContainerRef.current
    const maxScroll = scrollWidth - clientWidth
    
    if (scrollLeft < SCROLL_THRESHOLD) {
      setIsLoadingMore(true)
      
      const daysToAdd = MONTHS_TO_LOAD * 30
      const pixelsToAdd = daysToAdd * dayWidth
      
      setTimelineStart(prev => subMonths(prev, MONTHS_TO_LOAD))
      setMonthCount(prev => prev + MONTHS_TO_LOAD)
      
      requestAnimationFrame(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollLeft = scrollLeft + pixelsToAdd
        }
        setIsLoadingMore(false)
      })
    }
    
    if (scrollLeft > maxScroll - SCROLL_THRESHOLD) {
      setIsLoadingMore(true)
      setMonthCount(prev => prev + MONTHS_TO_LOAD)
      
      requestAnimationFrame(() => {
        setIsLoadingMore(false)
      })
    }
  }, [isLoadingMore, dayWidth])
  
  const scrollToToday = useCallback(() => {
    if (todayIndex === -1 || !scrollContainerRef.current) return
    
    const todayPosition = todayIndex * dayWidth
    const visibleWidth = containerWidth - SIDEBAR_WIDTH
    const scrollTarget = todayPosition - (visibleWidth / 2) + (dayWidth / 2)
    
    scrollContainerRef.current.scrollTo({
      left: Math.max(0, scrollTarget),
      behavior: 'smooth'
    })
  }, [todayIndex, dayWidth, containerWidth])
  
  const handleZoomIn = useCallback(() => {
    if (zoomIndex < ZOOM_LEVELS.length - 1) {
      const scrollContainer = scrollContainerRef.current
      if (scrollContainer) {
        const visibleWidth = containerWidth - SIDEBAR_WIDTH
        const centerX = scrollContainer.scrollLeft + visibleWidth / 2
        const centerDayIndex = centerX / dayWidth
        
        setZoomIndex(prev => prev + 1)
        
        requestAnimationFrame(() => {
          const newMonthsVisible = ZOOM_LEVELS[zoomIndex + 1].monthsVisible
          const newDaysVisible = newMonthsVisible * 30.44
          const newDayWidth = Math.max(4, (containerWidth - SIDEBAR_WIDTH) / newDaysVisible)
          const newScrollLeft = centerDayIndex * newDayWidth - visibleWidth / 2
          scrollContainer.scrollLeft = Math.max(0, newScrollLeft)
        })
      } else {
        setZoomIndex(prev => prev + 1)
      }
    }
  }, [zoomIndex, dayWidth, containerWidth])
  
  const handleZoomOut = useCallback(() => {
    if (zoomIndex > 0) {
      const scrollContainer = scrollContainerRef.current
      if (scrollContainer) {
        const visibleWidth = containerWidth - SIDEBAR_WIDTH
        const centerX = scrollContainer.scrollLeft + visibleWidth / 2
        const centerDayIndex = centerX / dayWidth
        
        setZoomIndex(prev => prev - 1)
        
        requestAnimationFrame(() => {
          const newMonthsVisible = ZOOM_LEVELS[zoomIndex - 1].monthsVisible
          const newDaysVisible = newMonthsVisible * 30.44
          const newDayWidth = Math.max(4, (containerWidth - SIDEBAR_WIDTH) / newDaysVisible)
          const newScrollLeft = centerDayIndex * newDayWidth - visibleWidth / 2
          scrollContainer.scrollLeft = Math.max(0, newScrollLeft)
        })
      } else {
        setZoomIndex(prev => prev - 1)
      }
    }
  }, [zoomIndex, dayWidth, containerWidth])
  
  const handleZoomPreset = useCallback((index: number) => {
    if (index >= 0 && index < ZOOM_LEVELS.length && index !== zoomIndex) {
      const scrollContainer = scrollContainerRef.current
      if (scrollContainer) {
        const visibleWidth = containerWidth - SIDEBAR_WIDTH
        const centerX = scrollContainer.scrollLeft + visibleWidth / 2
        const centerDayIndex = centerX / dayWidth
        
        setZoomIndex(index)
        
        requestAnimationFrame(() => {
          const newMonthsVisible = ZOOM_LEVELS[index].monthsVisible
          const newDaysVisible = newMonthsVisible * 30.44
          const newDayWidth = Math.max(4, (containerWidth - SIDEBAR_WIDTH) / newDaysVisible)
          const newScrollLeft = centerDayIndex * newDayWidth - visibleWidth / 2
          scrollContainer.scrollLeft = Math.max(0, newScrollLeft)
        })
      } else {
        setZoomIndex(index)
      }
    }
  }, [zoomIndex, dayWidth, containerWidth])
  
  // Handle copy sale to clipboard
  const handleCopySale = useCallback((sale: SaleWithDetails) => {
    const startDate = normalizeToLocalDate(sale.start_date)
    const endDate = normalizeToLocalDate(sale.end_date)
    const duration = differenceInDays(endDate, startDate) + 1
    
    setClipboardSale({
      saleName: sale.sale_name ?? null,
      discountPercentage: sale.discount_percentage ?? null,
      duration,
      saleType: sale.sale_type || 'custom',
      platformId: sale.platform_id,
      platformName: sale.platform?.name || 'Unknown'
    })
    setSelectedSaleId(sale.id)
    
    setCopyFeedback(`Copied: ${sale.sale_name || 'Sale'} (${duration}d, ${sale.discount_percentage}%)`)
    setTimeout(() => setCopyFeedback(null), 2000)
  }, [])
  
  // Handle select sale
  const handleSelectSale = useCallback((sale: SaleWithDetails) => {
    setSelectedSaleId(prev => prev === sale.id ? null : sale.id)
  }, [])
  
  // Handle right-click context menu on timeline
  const handleTimelineContextMenu = useCallback((e: React.MouseEvent, productId: string, platformId: string, dayIndex: number) => {
    // Prevent default browser context menu
    e.preventDefault()
    e.stopPropagation()
    
    // Show context menu at click position
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      productId,
      platformId,
      dayIndex
    })
  }, [])
  
  // Handle paste from context menu - open AddSaleModal with prefilled data so user can review dates
  const handlePasteFromContextMenu = useCallback(() => {
    if (!clipboardSale || !onCreateSale || !contextMenu.visible) return

    const startDate = format(days[contextMenu.dayIndex], 'yyyy-MM-dd')
    const endDate = format(addDays(days[contextMenu.dayIndex], clipboardSale.duration - 1), 'yyyy-MM-dd')

    // Open AddSaleModal with prefilled data (no directCreate) so user can verify dates & validation runs
    onCreateSale({
      productId: contextMenu.productId,
      platformId: contextMenu.platformId,
      startDate,
      endDate,
      saleName: clipboardSale.saleName ?? undefined,
      discountPercentage: clipboardSale.discountPercentage ?? undefined,
      saleType: clipboardSale.saleType
    })

    setCopyFeedback(`Pasting: ${clipboardSale.saleName || 'Sale'} at ${format(days[contextMenu.dayIndex], 'MMM d')}`)
    setTimeout(() => setCopyFeedback(null), 2000)

    // Close context menu
    setContextMenu(prev => ({ ...prev, visible: false }))
  }, [clipboardSale, onCreateSale, contextMenu, days])
  
  // Close context menu when clicking outside
  useEffect(() => {
    if (!contextMenu.visible) return
    
    const handleClickOutside = () => {
      setContextMenu(prev => ({ ...prev, visible: false }))
    }
    
    // Small delay to prevent immediate close on right-click
    const timeoutId = setTimeout(() => {
      document.addEventListener('click', handleClickOutside)
      document.addEventListener('contextmenu', handleClickOutside)
    }, 10)
    
    return () => {
      clearTimeout(timeoutId)
      document.removeEventListener('click', handleClickOutside)
      document.removeEventListener('contextmenu', handleClickOutside)
    }
  }, [contextMenu.visible])
  
  // Keyboard shortcuts for zoom and copy/paste
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Zoom shortcuts
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        handleZoomIn()
      } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault()
        handleZoomOut()
      }
      // Copy shortcut (Cmd/Ctrl+C)
      else if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        if (selectedSaleId) {
          const sale = sales.find(s => s.id === selectedSaleId)
          if (sale) {
            e.preventDefault()
            handleCopySale(sale)
          }
        }
      }
      // Paste shortcut (Cmd/Ctrl+V)
      else if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        if (clipboardSale && onCreateSale) {
          e.preventDefault()
          // Show feedback that paste requires clicking on timeline
          setCopyFeedback('Right-click on timeline to paste sale')
          setTimeout(() => setCopyFeedback(null), 3000)
        }
      }
      // Escape to deselect
      else if (e.key === 'Escape') {
        setSelectedSaleId(null)
        setContextMenu(prev => ({ ...prev, visible: false }))
      }
    }
    
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleZoomIn, handleZoomOut, selectedSaleId, sales, handleCopySale, clipboardSale, onCreateSale])
  
  const groupedProducts = useMemo(() => {
    const groups: { game: Game & { client: Client }; products: (Product & { game: Game & { client: Client } })[] }[] = []
    const gameMap = new Map<string, (Product & { game: Game & { client: Client } })[]>()
    
    for (const product of products) {
      if (!product.game) continue
      const gameId = product.game.id
      if (!gameMap.has(gameId)) {
        gameMap.set(gameId, [])
      }
      gameMap.get(gameId)!.push(product)
    }
    
    Array.from(gameMap.entries()).forEach(([gameId, prods]) => {
      if (prods.length > 0 && prods[0].game) {
        groups.push({ game: prods[0].game, products: prods })
      }
    })
    
    return groups.sort((a, b) => a.game.name.localeCompare(b.game.name))
  }, [products])
  
  const eventsByPlatform = useMemo(() => {
    const map = new Map<string, PlatformEvent[]>()
    if (!showEvents) return map
    
    const timelineEndDay = days[days.length - 1]
    
    for (const event of platformEvents) {
      const eventStart = normalizeToLocalDate(event.start_date)
      const eventEnd = normalizeToLocalDate(event.end_date)
      
      if (eventEnd >= days[0] && eventStart <= timelineEndDay) {
        const platformId = event.platform_id
        if (!map.has(platformId)) {
          map.set(platformId, [])
        }
        map.get(platformId)!.push(event)
      }
    }
    
    return map
  }, [platformEvents, days, showEvents])
  
  const platformsWithEventsArray = useMemo(() => {
    return Array.from(eventsByPlatform.keys())
  }, [eventsByPlatform])
  
  const getPositionForDate = useCallback((date: Date | string): number => {
    const d = typeof date === 'string' ? normalizeToLocalDate(date) : date
    const daysDiff = differenceInDays(d, days[0])
    return daysDiff * dayWidth
  }, [days, dayWidth])
  
  const getWidthForRange = useCallback((start: Date | string, end: Date | string): number => {
    const s = typeof start === 'string' ? normalizeToLocalDate(start) : start
    const e = typeof end === 'string' ? normalizeToLocalDate(end) : end
    const daysDiff = differenceInDays(e, s) + 1
    return daysDiff * dayWidth
  }, [dayWidth])
  
  const getDayIndexForDate = useCallback((date: Date | string): number => {
    const d = typeof date === 'string' ? normalizeToLocalDate(date) : date
    return differenceInDays(d, days[0])
  }, [days])
  
  const getEventsForPlatform = useCallback((platformId: string) => {
    const events = eventsByPlatform.get(platformId) || []
    return events.map(event => {
      const eventStart = normalizeToLocalDate(event.start_date)
      const eventEnd = normalizeToLocalDate(event.end_date)
      const displayStart = eventStart < days[0] ? days[0] : eventStart
      const displayEnd = eventEnd > days[days.length - 1] ? days[days.length - 1] : eventEnd
      const left = getPositionForDate(displayStart)
      const width = getWidthForRange(displayStart, displayEnd)
      
      return {
        ...event,
        displayStart,
        displayEnd,
        left,
        width
      }
    })
  }, [eventsByPlatform, days, getPositionForDate, getWidthForRange])
  
  const getSalesForProduct = useCallback((productId: string) => {
    return sales
      .filter(sale => sale.product_id === productId)
      .map(sale => {
        const optimistic = optimisticUpdates[sale.id]
        if (optimistic) {
          return {
            ...sale,
            start_date: optimistic.startDate,
            end_date: optimistic.endDate
          }
        }
        return sale
      })
  }, [sales, optimisticUpdates])
  
  const getPlatformsForProduct = useCallback((productId: string) => {
    const productSales = getSalesForProduct(productId)
    const platformIdsWithSales = productSales.map(s => s.platform_id)
    
    const allPlatformIdsSet = new Set([
      ...platformIdsWithSales,
      ...(showEvents ? platformsWithEventsArray : [])
    ])
    
    return Array.from(allPlatformIdsSet)
      .map(id => platforms.find(p => p.id === id))
      .filter((p): p is Platform => p !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [getSalesForProduct, platforms, platformsWithEventsArray, showEvents])
  
  const getSalesForProductPlatform = useCallback((productId: string, platformId: string) => {
    return getSalesForProduct(productId).filter(sale => sale.platform_id === platformId)
  }, [getSalesForProduct])
  
  const getCooldownForSale = useCallback((sale: SaleWithDetails) => {
    if (!sale.platform) return null
    
    if ((sale.sale_type === 'seasonal' || sale.sale_type === 'special') && sale.platform.special_sales_no_cooldown) {
      return null
    }
    
    const cooldownDays = sale.platform.cooldown_days
    if (cooldownDays === 0) return null
    
    const saleEnd = normalizeToLocalDate(sale.end_date)
    const cooldownStart = addDays(saleEnd, 1)
    const cooldownEnd = addDays(saleEnd, cooldownDays)
    
    return {
      start: cooldownStart,
      end: cooldownEnd,
      left: getPositionForDate(cooldownStart),
      width: getWidthForRange(cooldownStart, cooldownEnd)
    }
  }, [getPositionForDate, getWidthForRange])
  
  const calculateCascadeShifts = useCallback((
    movedSaleId: string,
    newStart: Date,
    newEnd: Date,
    productId: string,
    platformId: string,
    cooldownDays: number
  ): CascadeShift[] => {
    const shifts: CascadeShift[] = []
    
    const otherSales = allSales
      .filter(s => s.product_id === productId && s.platform_id === platformId && s.id !== movedSaleId)
      .sort((a, b) => normalizeToLocalDate(a.start_date).getTime() - normalizeToLocalDate(b.start_date).getTime())
    
    if (otherSales.length === 0) return shifts
    
    let currentCooldownEnd = addDays(newEnd, cooldownDays)
    
    for (const sale of otherSales) {
      const saleStart = normalizeToLocalDate(sale.start_date)
      const saleEnd = normalizeToLocalDate(sale.end_date)
      const saleDuration = differenceInDays(saleEnd, saleStart)
      
      if (saleStart <= newEnd) continue
      
      if (saleStart < currentCooldownEnd) {
        const shiftAmount = differenceInDays(currentCooldownEnd, saleStart) + 1
        const newSaleStart = addDays(saleStart, shiftAmount)
        const newSaleEnd = addDays(newSaleStart, saleDuration)
        
        shifts.push({
          saleId: sale.id,
          newStart: format(newSaleStart, 'yyyy-MM-dd'),
          newEnd: format(newSaleEnd, 'yyyy-MM-dd')
        })
        
        currentCooldownEnd = addDays(newSaleEnd, cooldownDays)
      } else {
        currentCooldownEnd = addDays(saleEnd, cooldownDays)
      }
    }
    
    const salesBeforeMoved = otherSales.filter(s => normalizeToLocalDate(s.end_date) < newStart)
    
    for (const sale of salesBeforeMoved) {
      if (shifts.some(s => s.saleId === sale.id)) continue
      
      const saleStart = normalizeToLocalDate(sale.start_date)
      const saleEnd = normalizeToLocalDate(sale.end_date)
      const saleDuration = differenceInDays(saleEnd, saleStart)
      const saleCooldownEnd = addDays(saleEnd, cooldownDays)
      
      if (saleCooldownEnd > newStart) {
        const overlapDays = differenceInDays(saleCooldownEnd, newStart) + 1
        const newSaleStart = addDays(saleStart, -overlapDays)
        const newSaleEnd = addDays(newSaleStart, saleDuration)
        
        if (newSaleStart >= days[0]) {
          shifts.push({
            saleId: sale.id,
            newStart: format(newSaleStart, 'yyyy-MM-dd'),
            newEnd: format(newSaleEnd, 'yyyy-MM-dd')
          })
        }
      }
    }
    
    return shifts
  }, [allSales, days])
  
  const completeSelection = useCallback((endDayIndex: number) => {
    if (!selectionRef.current) return
    
    const { data, callback, days: capturedDays } = selectionRef.current
    
    selectionRef.current = null
    setSelection(null)
    
    if (!callback || capturedDays.length === 0) {
      return
    }
    
    const startIdx = Math.min(data.startDayIndex, endDayIndex)
    const endIdx = Math.max(data.startDayIndex, endDayIndex)
    
    const safeStartIdx = Math.max(0, Math.min(startIdx, capturedDays.length - 1))
    const safeEndIdx = Math.max(0, Math.min(endIdx, capturedDays.length - 1))
    
    const startDate = format(capturedDays[safeStartIdx], 'yyyy-MM-dd')
    const endDate = format(capturedDays[safeEndIdx], 'yyyy-MM-dd')
    
    // Normal selection creates sale via modal (no directCreate flag)
    callback({
      productId: data.productId,
      platformId: data.platformId,
      startDate,
      endDate
    })
  }, [])
  
  const handleSelectionStart = useCallback((productId: string, platformId: string, dayIndex: number, e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-sale-block]') || (e.target as HTMLElement).closest('[data-launch-marker]') || (e.target as HTMLElement).closest('[data-launch-sale-block]')) {
      return
    }
    
    if (e.button !== 0) return
    
    e.preventDefault()
    e.stopPropagation()
    
    const newSelection = {
      productId,
      platformId,
      startDayIndex: dayIndex,
      endDayIndex: dayIndex
    }
    
    selectionRef.current = {
      data: newSelection,
      callback: props.onCreateSale,
      days: days
    }
    
    setSelection(newSelection)
  }, [props.onCreateSale, days])
  
  const handleSelectionMove = useCallback((dayIndex: number) => {
    if (!selectionRef.current) return
    
    const newSelection = {
      ...selectionRef.current.data,
      endDayIndex: dayIndex
    }
    
    selectionRef.current.data = newSelection
    setSelection(newSelection)
  }, [])
  
  const handleLaunchDragStart = useCallback((productId: string, launchDate: string, e: React.MouseEvent) => {
    if (e.button !== 0) return
    if (!onLaunchDateChange) return
    
    e.preventDefault()
    e.stopPropagation()
    
    launchDragRef.current = {
      productId,
      originalDate: launchDate,
      startX: e.clientX,
      hasMoved: false
    }
    
    setLaunchDateDrag({
      productId,
      originalDate: launchDate,
      currentDayIndex: getDayIndexForDate(launchDate)
    })
  }, [onLaunchDateChange, getDayIndexForDate])
  
  const handleLaunchDragMove = useCallback((e: MouseEvent) => {
    if (!launchDragRef.current || !launchDateDrag) return
    
    const deltaX = e.clientX - launchDragRef.current.startX
    
    if (Math.abs(deltaX) > 5) {
      launchDragRef.current.hasMoved = true
    }
    
    const daysDelta = Math.round(deltaX / dayWidth)
    const originalDayIndex = getDayIndexForDate(launchDragRef.current.originalDate)
    const newDayIndex = Math.max(0, Math.min(originalDayIndex + daysDelta, days.length - 1))
    
    setLaunchDateDrag(prev => prev ? { ...prev, currentDayIndex: newDayIndex } : null)
  }, [launchDateDrag, getDayIndexForDate, days.length, dayWidth])
  
  const handleLaunchDragEnd = useCallback(async () => {
    if (!launchDragRef.current || !launchDateDrag) {
      launchDragRef.current = null
      setLaunchDateDrag(null)
      return
    }
    
    const { productId, originalDate, hasMoved } = launchDragRef.current
    const newDate = format(days[launchDateDrag.currentDayIndex], 'yyyy-MM-dd')
    
    launchDragRef.current = null
    setLaunchDateDrag(null)
    
    if (!hasMoved && onEditLaunchDate) {
      const product = products.find(p => p.id === productId)
      if (product) {
        onEditLaunchDate(productId, product.name, originalDate, product.launch_sale_duration || 7)
      }
      return
    }
    
    if (newDate !== originalDate && onLaunchDateChange) {
      await onLaunchDateChange(productId, newDate)
    }
  }, [launchDateDrag, onLaunchDateChange, onEditLaunchDate, days, products])
  
  const handleLaunchSaleResizeStart = useCallback((productId: string, launchDate: string, currentDuration: number, e: React.MouseEvent) => {
    if (e.button !== 0) return
    if (!onLaunchSaleDurationChange) return
    
    e.preventDefault()
    e.stopPropagation()
    
    launchSaleResizeRef.current = {
      productId,
      originalDuration: currentDuration,
      startX: e.clientX,
      launchDate
    }
    
    setLaunchSaleResize({
      productId,
      originalDuration: currentDuration,
      currentDuration: currentDuration,
      edge: 'right'
    })
  }, [onLaunchSaleDurationChange])
  
  const handleLaunchSaleResizeMove = useCallback((e: MouseEvent) => {
    if (!launchSaleResizeRef.current || !launchSaleResize) return
    
    const deltaX = e.clientX - launchSaleResizeRef.current.startX
    const daysDelta = Math.round(deltaX / dayWidth)
    
    const newDuration = Math.max(MIN_LAUNCH_SALE_DAYS, Math.min(MAX_LAUNCH_SALE_DAYS, launchSaleResizeRef.current.originalDuration + daysDelta))
    
    setLaunchSaleResize(prev => prev ? { ...prev, currentDuration: newDuration } : null)
  }, [launchSaleResize, dayWidth])
  
  const handleLaunchSaleResizeEnd = useCallback(async () => {
    if (!launchSaleResizeRef.current || !launchSaleResize) {
      launchSaleResizeRef.current = null
      setLaunchSaleResize(null)
      return
    }
    
    const { productId, originalDuration } = launchSaleResizeRef.current
    const { currentDuration } = launchSaleResize
    
    launchSaleResizeRef.current = null
    setLaunchSaleResize(null)
    
    if (currentDuration !== originalDuration && onLaunchSaleDurationChange) {
      await onLaunchSaleDurationChange(productId, currentDuration)
    }
  }, [launchSaleResize, onLaunchSaleDurationChange])
  
  const updateScrollFromPosition = useCallback((clientX: number, isThumbDrag: boolean) => {
    if (!scrollContainerRef.current || !scrollTrackRef.current) return
    
    const trackRect = scrollTrackRef.current.getBoundingClientRect()
    const { scrollWidth, clientWidth } = scrollContainerRef.current
    const maxScroll = scrollWidth - clientWidth
    
    if (isThumbDrag && scrollGrabRef.current) {
      const deltaX = clientX - scrollGrabRef.current.startX
      const trackWidth = trackRect.width
      const scrollDelta = (deltaX / trackWidth) * maxScroll
      const newScrollLeft = Math.max(0, Math.min(scrollGrabRef.current.startScrollLeft + scrollDelta, maxScroll))
      scrollContainerRef.current.scrollLeft = newScrollLeft
    } else {
      const clickX = clientX - trackRect.left
      const trackWidth = trackRect.width
      const progress = clickX / trackWidth
      const newScrollLeft = Math.max(0, Math.min(progress * maxScroll, maxScroll))
      scrollContainerRef.current.scrollLeft = newScrollLeft
    }
  }, [])
  
  const handleScrollThumbStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    if (!scrollContainerRef.current) return
    
    e.preventDefault()
    e.stopPropagation()
    
    scrollGrabRef.current = {
      startX: e.clientX,
      startScrollLeft: scrollContainerRef.current.scrollLeft,
      isThumbDrag: true
    }
    setIsGrabbing(true)
  }, [])
  
  const handleScrollTrackClick = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).classList.contains(styles.scrollGrabThumb)) return
    
    e.preventDefault()
    
    updateScrollFromPosition(e.clientX, false)
    
    if (scrollContainerRef.current) {
      scrollGrabRef.current = {
        startX: e.clientX,
        startScrollLeft: scrollContainerRef.current.scrollLeft,
        isThumbDrag: false
      }
      setIsGrabbing(true)
    }
  }, [updateScrollFromPosition])
  
  const handleScrollGrabMove = useCallback((e: MouseEvent) => {
    if (!scrollGrabRef.current) return
    updateScrollFromPosition(e.clientX, scrollGrabRef.current.isThumbDrag)
  }, [updateScrollFromPosition])
  
  const handleScrollGrabEnd = useCallback(() => {
    scrollGrabRef.current = null
    setIsGrabbing(false)
  }, [])
  
  const handleScroll = useCallback(() => {
    if (!scrollContainerRef.current) return
    const { scrollLeft, scrollWidth, clientWidth } = scrollContainerRef.current
    const maxScroll = scrollWidth - clientWidth
    const progress = maxScroll > 0 ? scrollLeft / maxScroll : 0
    setScrollProgress(progress)
    
    handleInfiniteScroll()
  }, [handleInfiniteScroll])
  
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer) return
    
    scrollContainer.addEventListener('scroll', handleScroll)
    handleScroll()
    
    return () => {
      scrollContainer.removeEventListener('scroll', handleScroll)
    }
  }, [handleScroll])
  
  // Scroll to today on initial load - FIXED: wait for actual measurement and data
  useEffect(() => {
    if (hasInitialScrolled) return
    if (todayIndex === -1) return
    if (!scrollContainerRef.current) return
    if (!hasReceivedMeasurement) return // Wait for actual measurement, not default 1200
    if (products.length === 0) return // Wait for products to load
    
    // Add a small delay to ensure everything is rendered
    const timeoutId = setTimeout(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!scrollContainerRef.current) return
          
          const todayPosition = todayIndex * dayWidth
          const visibleWidth = containerWidth - SIDEBAR_WIDTH
          const scrollTarget = todayPosition - (visibleWidth / 2) + (dayWidth / 2)
          
          scrollContainerRef.current.scrollLeft = Math.max(0, scrollTarget)
          setHasInitialScrolled(true)
        })
      })
    }, 100)
    
    return () => clearTimeout(timeoutId)
  }, [todayIndex, dayWidth, containerWidth, hasInitialScrolled, hasReceivedMeasurement, products.length])
  
  useEffect(() => {
    const handleWindowMouseMove = (e: MouseEvent) => {
      if (scrollGrabRef.current) {
        handleScrollGrabMove(e)
        return
      }
      if (launchSaleResizeRef.current) {
        handleLaunchSaleResizeMove(e)
        return
      }
      if (launchDragRef.current) {
        handleLaunchDragMove(e)
      }
    }
    
    const handleWindowMouseUp = () => {
      if (scrollGrabRef.current) {
        handleScrollGrabEnd()
        return
      }
      
      if (launchSaleResizeRef.current) {
        handleLaunchSaleResizeEnd()
        return
      }
      
      if (launchDragRef.current) {
        handleLaunchDragEnd()
        return
      }
      
      if (!selectionRef.current) return
      
      const endDayIndex = selectionRef.current.data.endDayIndex
      completeSelection(endDayIndex)
    }
    
    window.addEventListener('mousemove', handleWindowMouseMove)
    window.addEventListener('mouseup', handleWindowMouseUp, { capture: true })
    
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove)
      window.removeEventListener('mouseup', handleWindowMouseUp, { capture: true })
    }
  }, [completeSelection, handleLaunchDragMove, handleLaunchDragEnd, handleLaunchSaleResizeMove, handleLaunchSaleResizeEnd, handleScrollGrabMove, handleScrollGrabEnd])
  
  const getSelectionStyle = useCallback((productId: string, platformId: string) => {
    if (!selection || selection.productId !== productId || selection.platformId !== platformId) {
      return null
    }
    
    const startIdx = Math.min(selection.startDayIndex, selection.endDayIndex)
    const endIdx = Math.max(selection.startDayIndex, selection.endDayIndex)
    const left = startIdx * dayWidth
    const width = (endIdx - startIdx + 1) * dayWidth
    
    const platform = platforms.find(p => p.id === platformId)
    
    return {
      left,
      width,
      backgroundColor: platform ? `${platform.color_hex}40` : 'rgba(59, 130, 246, 0.25)',
      borderColor: platform?.color_hex || '#3b82f6'
    }
  }, [selection, platforms, dayWidth])
  
  const getLaunchDatePosition = useCallback((product: Product) => {
    if (!product.launch_date) return null
    
    if (launchDateDrag && launchDateDrag.productId === product.id) {
      const left = launchDateDrag.currentDayIndex * dayWidth
      const date = days[launchDateDrag.currentDayIndex]
      return { left, date, isDragging: true }
    }
    
    const dayIndex = getDayIndexForDate(product.launch_date)
    if (dayIndex < 0 || dayIndex >= days.length) return null
    
    const left = dayIndex * dayWidth
    return { left, date: normalizeToLocalDate(product.launch_date), isDragging: false }
  }, [launchDateDrag, getDayIndexForDate, days, dayWidth])

  const getLaunchSaleBlock = useCallback((product: Product) => {
    if (!product.launch_date) return null

    const duration = (launchSaleResize && launchSaleResize.productId === product.id)
      ? launchSaleResize.currentDuration
      : (product.launch_sale_duration || 7)
    
    const launchStart = normalizeToLocalDate(product.launch_date)
    const launchEnd = addDays(launchStart, duration - 1)

    const startDayIndex = getDayIndexForDate(launchStart)
    const endDayIndex = getDayIndexForDate(launchEnd)

    if (endDayIndex < 0 || startDayIndex >= days.length) return null

    const visibleStartIdx = Math.max(0, startDayIndex)
    const visibleEndIdx = Math.min(days.length - 1, endDayIndex)

    const left = visibleStartIdx * dayWidth
    const width = (visibleEndIdx - visibleStartIdx + 1) * dayWidth

    const conflicts = getLaunchSaleConflicts(product.launch_date, duration)

    const isResizing = launchSaleResize && launchSaleResize.productId === product.id

    return {
      left,
      width,
      duration,
      hasConflict: conflicts.length > 0,
      conflicts,
      startDate: launchStart,
      endDate: launchEnd,
      isResizing
    }
  }, [getDayIndexForDate, days, dayWidth, getLaunchSaleConflicts, launchSaleResize])
  
  const scrollThumbStyle = useMemo(() => {
    const totalWidth = totalDays * dayWidth
    const visibleWidth = containerWidth - SIDEBAR_WIDTH
    const thumbWidthPercent = Math.max(10, Math.min(100, (visibleWidth / totalWidth) * 100))
    const maxLeftPercent = 100 - thumbWidthPercent
    const leftPercent = scrollProgress * maxLeftPercent
    
    return { 
      width: `${thumbWidthPercent}%`,
      left: `${leftPercent}%`
    }
  }, [totalDays, scrollProgress, dayWidth, containerWidth])
  
  const handleDragStart = (event: DragStartEvent) => {
    const saleId = event.active.id as string
    const sale = sales.find(s => s.id === saleId)
    if (sale) {
      setDraggedSale(sale)
      setValidationError(null)
    }
  }
  
  const handleDragEnd = async (event: DragEndEvent) => {
    if (!draggedSale) {
      setDraggedSale(null)
      return
    }
    
    const { delta } = event
    const daysMoved = Math.round(delta.x / dayWidth)
    
    if (daysMoved === 0) {
      setDraggedSale(null)
      return
    }
    
    const currentStart = normalizeToLocalDate(draggedSale.start_date)
    const currentEnd = normalizeToLocalDate(draggedSale.end_date)
    const newStart = addDays(currentStart, daysMoved)
    const newEnd = addDays(currentEnd, daysMoved)
    const newStartStr = format(newStart, 'yyyy-MM-dd')
    const newEndStr = format(newEnd, 'yyyy-MM-dd')
    
    const platform = platforms.find(p => p.id === draggedSale.platform_id)
    if (!platform) {
      setValidationError('Platform not found')
      setDraggedSale(null)
      return
    }
    
    const cascadeShifts = calculateCascadeShifts(
      draggedSale.id,
      newStart,
      newEnd,
      draggedSale.product_id,
      draggedSale.platform_id,
      platform.cooldown_days
    )
    
    const cascadeIds = new Set(cascadeShifts.map(s => s.saleId))
    const salesForValidation = allSales.filter(s => !cascadeIds.has(s.id))
    
    const validation = validateSale(
      {
        product_id: draggedSale.product_id,
        platform_id: draggedSale.platform_id,
        start_date: newStartStr,
        end_date: newEndStr,
        sale_type: draggedSale.sale_type
      },
      salesForValidation,
      platform,
      draggedSale.id
    )
    
    if (!validation.valid) {
      setValidationError(validation.message || 'Invalid sale position - conflicts with cooldown')
      setTimeout(() => setValidationError(null), 3000)
      setDraggedSale(null)
      return
    }
    
    if (cascadeShifts.length > 0) {
      setValidationError(`Auto-shifted ${cascadeShifts.length} sale(s) to maintain cooldowns`)
      setTimeout(() => setValidationError(null), 3000)
    }
    
    const newOptimistic: Record<string, { startDate: string; endDate: string }> = {
      [draggedSale.id]: { startDate: newStartStr, endDate: newEndStr }
    }
    for (const shift of cascadeShifts) {
      newOptimistic[shift.saleId] = { startDate: shift.newStart, endDate: shift.newEnd }
    }
    setOptimisticUpdates(prev => ({ ...prev, ...newOptimistic }))
    
    setDraggedSale(null)
    
    try {
      await onSaleUpdate(draggedSale.id, {
        start_date: newStartStr,
        end_date: newEndStr
      })
      
      for (const shift of cascadeShifts) {
        await onSaleUpdate(shift.saleId, {
          start_date: shift.newStart,
          end_date: shift.newEnd
        })
      }
    } catch (err) {
      setOptimisticUpdates(prev => {
        const updated = { ...prev }
        delete updated[draggedSale.id]
        for (const shift of cascadeShifts) {
          delete updated[shift.saleId]
        }
        return updated
      })
      setValidationError('Failed to save - position reverted')
      setTimeout(() => setValidationError(null), 3000)
    }
    
    setTimeout(() => {
      setOptimisticUpdates(prev => {
        const updated = { ...prev }
        delete updated[draggedSale.id]
        for (const shift of cascadeShifts) {
          delete updated[shift.saleId]
        }
        return updated
      })
    }, 500)
  }
  
  const handleSaleResize = useCallback(async (saleId: string, newStartDate: string, newEndDate: string) => {
    const sale = sales.find(s => s.id === saleId)
    if (!sale) return
    
    const platform = platforms.find(p => p.id === sale.platform_id)
    if (!platform) {
      setValidationError('Platform not found')
      return
    }
    
    const validation = validateSale(
      {
        product_id: sale.product_id,
        platform_id: sale.platform_id,
        start_date: newStartDate,
        end_date: newEndDate,
        sale_type: sale.sale_type
      },
      allSales,
      platform,
      saleId
    )
    
    if (!validation.valid) {
      setValidationError(validation.message || 'Invalid resize - conflicts with cooldown')
      setTimeout(() => setValidationError(null), 3000)
      return
    }
    
    setOptimisticUpdates(prev => ({
      ...prev,
      [saleId]: { startDate: newStartDate, endDate: newEndDate }
    }))
    
    try {
      await onSaleUpdate(saleId, {
        start_date: newStartDate,
        end_date: newEndDate
      })
    } catch (err) {
      setOptimisticUpdates(prev => {
        const updated = { ...prev }
        delete updated[saleId]
        return updated
      })
      setValidationError('Failed to resize - reverted')
      setTimeout(() => setValidationError(null), 3000)
    }
    
    setTimeout(() => {
      setOptimisticUpdates(prev => {
        const updated = { ...prev }
        delete updated[saleId]
        return updated
      })
    }, 500)
  }, [sales, platforms, allSales, onSaleUpdate])
  
  const handleMouseLeave = useCallback(() => {
    if (selectionRef.current) {
      selectionRef.current = null
      setSelection(null)
    }
  }, [])
  
  const getSaleCount = useCallback((productId: string) => {
    return sales.filter(s => s.product_id === productId).length
  }, [sales])
  
  const totalWidth = totalDays * dayWidth
  
  return (
    <div 
      className={`${styles.container} ${draggedSale ? styles.dragging : ''}`}
      onMouseLeave={handleMouseLeave}
      ref={containerRef}
    >
      {validationError && (
        <div className={`${styles.validationError} ${validationError.includes('Auto-shifted') ? styles.infoMessage : ''}`}>
          <span>{validationError.includes('Auto-shifted') ? 'ℹ️' : '⚠️'} {validationError}</span>
        </div>
      )}
      
      {copyFeedback && (
        <div className={styles.copyFeedback}>
          {copyFeedback}
        </div>
      )}
      
      {/* Timeline Context Menu for Paste */}
      {contextMenu.visible && (
        <div 
          className={styles.timelineContextMenu}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {clipboardSale ? (
            <>
              <div className={styles.contextMenuHeader}>
                📋 Clipboard: {clipboardSale.saleName || 'Sale'} ({clipboardSale.duration}d)
              </div>
              <button 
                className={styles.contextMenuPaste}
                onClick={handlePasteFromContextMenu}
              >
                📥 Paste Sale Here
              </button>
              <div className={styles.contextMenuInfo}>
                {format(days[contextMenu.dayIndex], 'MMM d, yyyy')}
              </div>
            </>
          ) : (
            <div className={styles.contextMenuEmpty}>
              No sale copied. Select a sale and press ⌘C to copy.
            </div>
          )}
        </div>
      )}
      
      <div className={`${styles.legend} ${isLegendCollapsed ? styles.legendCollapsed : ''}`}>
        <button 
          className={styles.legendToggle}
          onClick={() => setIsLegendCollapsed(!isLegendCollapsed)}
          title={isLegendCollapsed ? 'Show platforms legend' : 'Hide platforms legend'}
        >
          {isLegendCollapsed ? '▶' : '▼'} PLATFORMS
        </button>
        {isLegendCollapsed && (
          <span className={styles.legendCollapsedHint}>Click to expand</span>
        )}
        {!isLegendCollapsed && (
          <>
            {platforms.map(platform => (
              <div key={platform.id} className={styles.legendItem}>
                <span 
                  className={styles.legendColor}
                  style={{ backgroundColor: platform.color_hex }}
                />
                <span>{platform.name}</span>
                <span className={styles.legendCooldown}>({platform.cooldown_days}d cooldown)</span>
              </div>
            ))}
            <div className={styles.legendLaunchSale}>
              <span className={styles.legendLaunchColor} />
              <span>Launch Sale Period (drag edge to resize)</span>
            </div>
          </>
        )}
      </div>
      
      <div className={styles.zoomControls}>
        <span className={styles.zoomLabel}>View:</span>
        <div className={styles.zoomButtons}>
          <button 
            className={styles.zoomBtn}
            onClick={handleZoomOut}
            disabled={zoomIndex === 0}
            title="Zoom out (Ctrl+-)"
          >
            −
          </button>
          {ZOOM_LEVELS.map((level, idx) => (
            <button
              key={level.name}
              className={`${styles.zoomPreset} ${idx === zoomIndex ? styles.zoomActive : ''}`}
              onClick={() => handleZoomPreset(idx)}
              title={`${level.name} view (${level.monthsVisible} months)`}
            >
              {level.label}
            </button>
          ))}
          <button 
            className={styles.zoomBtn}
            onClick={handleZoomIn}
            disabled={zoomIndex === ZOOM_LEVELS.length - 1}
            title="Zoom in (Ctrl++)"
          >
            +
          </button>
        </div>
        <span className={styles.zoomInfo}>
          {ZOOM_LEVELS[zoomIndex].name} ({Math.round(ZOOM_LEVELS[zoomIndex].monthsVisible * 30)} days)
        </span>
        {clipboardSale && (
          <span className={styles.clipboardIndicator}>
            📋 {clipboardSale.saleName || 'Sale'} ({clipboardSale.duration}d)
          </span>
        )}
        {visibleDateRange && (
          <span className={styles.dateRange}>
            {format(visibleDateRange.start, 'MMM d')} - {format(visibleDateRange.end, 'MMM d, yyyy')}
          </span>
        )}
        {isLoadingMore && (
          <span className={styles.loadingIndicator}>Loading...</span>
        )}
      </div>
      
      <div 
        className={`${styles.scrollGrabBar} ${isGrabbing ? styles.grabbing : ''}`}
      >
        <button
          className={styles.todayButton}
          onClick={scrollToToday}
          disabled={todayIndex === -1}
          title={todayIndex === -1 ? 'Today is not in the current timeline' : 'Jump to today'}
        >
          Today
        </button>
        <div 
          className={styles.scrollGrabTrack}
          ref={scrollTrackRef}
          onMouseDown={handleScrollTrackClick}
        >
          <div 
            className={styles.scrollGrabThumb} 
            style={scrollThumbStyle}
            onMouseDown={handleScrollThumbStart}
          >
            <span className={styles.scrollGrabIcon}>⟷</span>
          </div>
        </div>
        <span className={styles.scrollGrabHint}>
          {isGrabbing ? 'Dragging...' : 'Drag to navigate • Right-click to paste sales'}
        </span>
      </div>
      
      <div className={styles.scrollContainer} ref={scrollContainerRef}>
        <DndContext
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className={styles.timeline} style={{ width: totalWidth }}>
            <div className={styles.monthHeaders}>
              {months.map(({ date, days: daysInMonth }, idx) => (
                <div 
                  key={idx}
                  className={styles.monthHeader}
                  style={{ width: daysInMonth * dayWidth }}
                >
                  {format(date, 'MMMM yyyy')}
                </div>
              ))}
            </div>
            
            <div className={styles.dayHeaders}>
              {days.map((day, idx) => {
                const isWeekend = day.getDay() === 0 || day.getDay() === 6
                const isFirstOfMonth = day.getDate() === 1
                const isTodayDate = idx === todayIndex
                const showDayNumber = dayWidth >= 14
                const dateKey = format(day, 'yyyy-MM-dd')
                const covData = showCoverage && coverageByDate ? coverageByDate[dateKey] : undefined
                return (
                  <div
                    key={idx}
                    className={`${styles.dayHeader} ${isWeekend ? styles.weekend : ''} ${isFirstOfMonth ? styles.monthStart : ''} ${isTodayDate ? styles.todayHeader : ''}`}
                    style={{ width: dayWidth }}
                    title={covData ? `${covData.count} article${covData.count !== 1 ? 's' : ''} on ${format(day, 'MMM d')}\nTop tier: ${covData.topTier || 'N/A'}\nReach: ${covData.totalReach.toLocaleString()}\n${covData.items.slice(0, 3).map(i => `• ${i.outlet}: ${i.title}`).join('\n')}${covData.items.length > 3 ? `\n+${covData.items.length - 3} more` : ''}` : undefined}
                  >
                    {showDayNumber ? day.getDate() : ''}
                    {covData && (
                      <div className={styles.coverageDot} style={{
                        backgroundColor: covData.topTier === 'A' ? '#ef4444' : covData.topTier === 'B' ? '#f59e0b' : covData.topTier === 'C' ? '#3b82f6' : '#94a3b8',
                        width: Math.min(6 + covData.count * 2, 12),
                        height: Math.min(6 + covData.count * 2, 12),
                      }} />
                    )}
                  </div>
                )
              })}
            </div>
            
            {todayIndex !== -1 && (
              <div 
                className={styles.todayIndicator}
                style={{ left: todayIndex * dayWidth + dayWidth / 2 + SIDEBAR_WIDTH }}
              />
            )}
            
            <div className={styles.productRows}>
              {groupedProducts.map(({ game, products: gameProducts }) => (
                <div key={game.id} className={styles.gameGroup}>
                  <div className={styles.gameHeader}>
                    <div className={styles.productLabel}>
                      <span className={styles.gameName}>{game.name}</span>
                      <span className={styles.clientName}>{game.client?.name}</span>
                    </div>
                  </div>
                  
                  {gameProducts.map(product => {
                    const productPlatforms = getPlatformsForProduct(product.id)
                    const saleCount = getSaleCount(product.id)
                    const launchPosition = getLaunchDatePosition(product)
                    const launchSaleBlock = getLaunchSaleBlock(product)
                    
                    return (
                      <div key={product.id} className={styles.productGroup}>
                        <div className={styles.productRow}>
                          <div className={styles.productLabel}>
                            <div className={styles.productLabelContent}>
                              <span className={styles.productName}>{product.name}</span>
                              <span className={styles.productType}>{product.product_type}</span>
                              {product.launch_date && (
                                <span 
                                  className={`${styles.launchDateBadge} ${onEditLaunchDate ? styles.clickable : ''}`}
                                  onClick={() => onEditLaunchDate && product.launch_date && onEditLaunchDate(product.id, product.name, product.launch_date, product.launch_sale_duration || 7)}
                                  title="Click to edit launch date"
                                >
                                  🚀 {format(normalizeToLocalDate(product.launch_date), 'MMM d')}
                                </span>
                              )}
                            </div>
                            <div className={styles.productActions}>
                              {onGenerateCalendar && (
                                <button
                                  className={styles.generateButton}
                                  onClick={() => onGenerateCalendar(product.id, product.name, product.launch_date || undefined)}
                                  title="Auto-generate sale calendar for this product"
                                >
                                  🗓️
                                </button>
                              )}
                              {onClearSales && saleCount > 0 && (
                                <button
                                  className={styles.clearButton}
                                  onClick={() => onClearSales(product.id, product.name)}
                                  title={`Clear sales for this product (${saleCount})`}
                                >
                                  🗑️
                                </button>
                              )}
                            </div>
                          </div>
                          
                          <div className={styles.timelineRow} style={{ width: totalWidth }}>
                            {days.map((day, idx) => {
                              const isWeekend = day.getDay() === 0 || day.getDay() === 6
                              return (
                                <div
                                  key={idx}
                                  className={`${styles.dayCell} ${isWeekend ? styles.weekendCell : ''}`}
                                  style={{ left: idx * dayWidth, width: dayWidth }}
                                />
                              )
                            })}
                            
                            {launchSaleBlock && (
                              <div
                                data-launch-sale-block
                                className={`${styles.launchSaleBlock} ${launchSaleBlock.hasConflict ? styles.hasConflict : ''} ${onLaunchSaleDurationChange ? styles.resizable : ''} ${launchSaleBlock.isResizing ? styles.resizing : ''}`}
                                style={{ 
                                  left: launchSaleBlock.left, 
                                  width: launchSaleBlock.width,
                                  transition: launchSaleBlock.isResizing ? 'none' : undefined
                                }}
                                title={launchSaleBlock.hasConflict 
                                  ? `⚠️ Launch Sale (${launchSaleBlock.duration}d) - CONFLICTS WITH:\n${launchSaleBlock.conflicts.map(c => `• ${c.eventName} (${c.overlapDays}d overlap)`).join('\n')}`
                                  : `Launch Sale: ${format(launchSaleBlock.startDate, 'MMM d')} - ${format(launchSaleBlock.endDate, 'MMM d')} (${launchSaleBlock.duration} days)\nDrag right edge to resize`
                                }
                              >
                                <div className={styles.launchSaleBlockContent}>
                                  <span className={styles.launchSaleIcon}>
                                    {launchSaleBlock.hasConflict ? '⚠️' : '🚀'}
                                  </span>
                                  <span className={styles.launchSaleLabel}>
                                    Launch {launchSaleBlock.duration}d
                                  </span>
                                </div>
                                
                                {onLaunchSaleDurationChange && product.launch_date && (
                                  <div
                                    className={`${styles.launchSaleResizeHandle} ${styles.launchSaleResizeHandleRight}`}
                                    onMouseDown={(e) => handleLaunchSaleResizeStart(product.id, product.launch_date!, launchSaleBlock.duration, e)}
                                  />
                                )}
                              </div>
                            )}
                            
                            {launchPosition && (onLaunchDateChange || onEditLaunchDate) && (
                              <div
                                data-launch-marker
                                className={`${styles.launchMarker} ${launchPosition.isDragging ? styles.launchMarkerDragging : ''}`}
                                style={{ left: launchPosition.left }}
                                onMouseDown={(e) => onLaunchDateChange && handleLaunchDragStart(product.id, product.launch_date!, e)}
                                title={`Launch Date: ${format(launchPosition.date, 'MMM d, yyyy')}\n${onLaunchDateChange ? 'Drag to shift all sales, or click to edit' : 'Click to edit'}`}
                              >
                                <div className={styles.launchMarkerLine} />
                                <div className={styles.launchMarkerFlag}>
                                  🚀
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                        
                        {productPlatforms.map(platform => {
                          const platformSales = getSalesForProductPlatform(product.id, platform.id)
                          const platformEventsForRow = getEventsForPlatform(platform.id)
                          const selectionStyle = getSelectionStyle(product.id, platform.id)
                          const gapIndicator = getGapIndicator(product.id, platform.id)
                          
                          return (
                            <div key={`${product.id}-${platform.id}`} className={styles.platformRow}>
                              <div className={styles.platformLabel}>
                                <span 
                                  className={styles.platformIndicator}
                                  style={{ backgroundColor: platform.color_hex }}
                                />
                                <span className={styles.platformName}>{platform.name}</span>
                                {gapIndicator && (
                                  <span 
                                    className={`${styles.gapBadge} ${gapIndicator.isWarning ? styles.gapWarning : ''}`}
                                    title={`${gapIndicator.text} - Available days where you could run a sale (excludes cooldowns)`}
                                  >
                                    {gapIndicator.text}
                                  </span>
                                )}
                              </div>
                              
                              <div 
                                className={`${styles.timelineRow} ${styles.clickableTimeline}`}
                                style={{ width: totalWidth }}
                              >
                                {days.map((day, idx) => {
                                  const isWeekend = day.getDay() === 0 || day.getDay() === 6
                                  return (
                                    <div
                                      key={idx}
                                      className={`${styles.dayCell} ${isWeekend ? styles.weekendCell : ''}`}
                                      style={{ left: idx * dayWidth, width: dayWidth }}
                                      onMouseDown={(e) => handleSelectionStart(product.id, platform.id, idx, e)}
                                      onMouseEnter={() => handleSelectionMove(idx)}
                                      onContextMenu={(e) => handleTimelineContextMenu(e, product.id, platform.id, idx)}
                                    />
                                  )
                                })}
                                
                                {launchPosition && (
                                  <div
                                    className={styles.launchMarkerLineExtension}
                                    style={{ left: launchPosition.left + dayWidth / 2 - 1 }}
                                  />
                                )}
                                
                                {selectionStyle && (
                                  <div
                                    className={styles.selectionPreview}
                                    style={{
                                      left: selectionStyle.left,
                                      width: selectionStyle.width,
                                      backgroundColor: selectionStyle.backgroundColor,
                                      borderColor: selectionStyle.borderColor,
                                      pointerEvents: 'none',
                                    }}
                                  >
                                    <span className={styles.selectionLabel}>
                                      {format(days[Math.min(selection!.startDayIndex, selection!.endDayIndex)], 'MMM d')} - {format(days[Math.max(selection!.startDayIndex, selection!.endDayIndex)], 'MMM d')}
                                    </span>
                                  </div>
                                )}
                                
                                {showEvents && platformEventsForRow.map(event => (
                                  <div
                                    key={`event-${event.id}`}
                                    className={styles.platformEventShade}
                                    style={{
                                      left: event.left,
                                      width: event.width,
                                      backgroundColor: `${platform.color_hex}25`,
                                      borderColor: platform.color_hex,
                                    }}
                                    title={`${event.name}\n${format(event.displayStart, 'MMM d')} - ${format(event.displayEnd, 'MMM d, yyyy')}${!event.requires_cooldown ? '\n★ No cooldown required' : ''}`}
                                  >
                                    <span className={styles.platformEventLabel}>
                                      {event.name}
                                      {!event.requires_cooldown && <span className={styles.noCooldownStar}>★</span>}
                                    </span>
                                  </div>
                                ))}
                                
                                {platformSales.map(sale => {
                                  const left = getPositionForDate(sale.start_date)
                                  const width = getWidthForRange(sale.start_date, sale.end_date)
                                  const cooldown = getCooldownForSale(sale)
                                  
                                  return (
                                    <div key={sale.id} data-sale-block>
                                      {cooldown && (
                                        <div
                                          className={styles.cooldownBlock}
                                          style={{
                                            left: cooldown.left,
                                            width: cooldown.width
                                          }}
                                          title={`Cooldown until ${format(cooldown.end, 'MMM d, yyyy')}`}
                                        >
                                          <span>COOLDOWN</span>
                                        </div>
                                      )}
                                      
                                      <SaleBlock
                                        sale={sale}
                                        left={left}
                                        width={width}
                                        dayWidth={dayWidth}
                                        onEdit={onSaleEdit}
                                        onDelete={onSaleDelete}
                                        onDuplicate={onSaleDuplicate}
                                        onResize={handleSaleResize}
                                        onSelect={handleSelectSale}
                                        onCopy={handleCopySale}
                                        isSelected={selectedSaleId === sale.id}
                                      />
                                    </div>
                                  )
                                })}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )
                  })}
                </div>
              ))}
              
              {groupedProducts.length === 0 && (
                <div className={styles.emptyState}>
                  <p>No products found. Add products to start planning sales.</p>
                </div>
              )}
            </div>
          </div>
          
          <DragOverlay>
            {draggedSale && (
              <div 
                className={styles.dragOverlay}
                style={{ 
                  backgroundColor: draggedSale.platform?.color_hex || '#3b82f6',
                  width: getWidthForRange(draggedSale.start_date, draggedSale.end_date)
                }}
              >
                {draggedSale.sale_name || 'Sale'} -{draggedSale.discount_percentage}%
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </div>
    </div>
  )
}
