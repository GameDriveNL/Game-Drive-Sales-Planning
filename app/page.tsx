'use client'

// Cache invalidation: 2026-02-11T12:00:00Z - Replaced PageToggle with global Sidebar

import { useState, useEffect, useMemo, useCallback } from 'react'
import { parseISO, format, addDays } from 'date-fns'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import GanttChart, { CoverageDayData } from './components/GanttChart'
import SalesTable from './components/SalesTable'
import SaleAnalysis from './components/SaleAnalysis'
import AddSaleModal from './components/AddSaleModal'
import EditSaleModal from './components/EditSaleModal'
import PlatformSettings from './components/PlatformSettings'
import SaleCalendarPreviewModal from './components/SaleCalendarPreviewModal'
import ClearSalesModal from './components/ClearSalesModal'
import TimelineExportModal from './components/TimelineExportModal'
import EditLaunchDateModal from './components/EditLaunchDateModal'
import GapAnalysis from './components/GapAnalysis'
import CoverageCorrelation from './components/CoverageCorrelation'
import ImportSalesModal from './components/ImportSalesModal'
import VersionManager from './components/VersionManager'
import DuplicateSaleModal from './components/DuplicateSaleModal'
import BulkEditSalesModal from './components/BulkEditSalesModal'
import StatCard from './components/StatCard'
import { Sidebar } from './components/Sidebar'
import { GeneratedSale, CalendarVariation, generatedSaleToCreateFormat } from '@/lib/sale-calendar-generator'
import { useUndo } from '@/lib/undo-context'
import { useAuth } from '@/lib/auth-context'
import { normalizeToLocalDate } from '@/lib/dateUtils'
import styles from './page.module.css'
import { Sale, Platform, Product, Game, Client, SaleWithDetails, PlatformEvent, SaleSnapshot } from '@/lib/types'

interface SalePrefill { productId: string; platformId: string; startDate: string; endDate: string; directCreate?: boolean; saleName?: string; discountPercentage?: number; saleType?: string }
// Convert version snapshot to SaleWithDetails format for display
interface VersionSaleDisplay extends SaleWithDetails {
  _isSnapshot?: boolean  // Flag to identify snapshot sales in the display
}
interface CalendarGenerationState { productId: string; productName: string; launchDate: string; platformIds?: string[]; clientId?: string }
interface ClearSalesState { productId: string; productName: string }
interface EditLaunchDateState { productId: string; productName: string; currentLaunchDate: string; currentLaunchSaleDuration?: number }
type SaleStatus = 'planned' | 'submitted' | 'confirmed' | 'live' | 'ended'
interface ConflictInfo { productName: string; eventName: string; overlapDays: number }

export default function GameDriveDashboard() {
  const supabase = createClientComponentClient()
  const { hasAccess, loading: authLoading, resolveAccess } = useAuth()
  const canEdit = hasAccess('sales_timeline', 'edit')
  const canView = hasAccess('sales_timeline', 'view')
  const [sales, setSales] = useState<SaleWithDetails[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [games, setGames] = useState<(Game & { client: Client })[]>([])
  const [products, setProducts] = useState<(Product & { game: Game & { client: Client } })[]>([])
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [platformEvents, setPlatformEvents] = useState<PlatformEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const [showPlatformSettings, setShowPlatformSettings] = useState(false)
  const [showExportModal, setShowExportModal] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)
  const [showVersionManager, setShowVersionManager] = useState(false)
  const [editingSale, setEditingSale] = useState<SaleWithDetails | null>(null)
  const [duplicatingSale, setDuplicatingSale] = useState<SaleWithDetails | null>(null)
  const [viewMode, setViewMode] = useState<'gantt' | 'table' | 'analysis'>('gantt')
  const [showEvents, setShowEvents] = useState(true)
  const [showCoverage, setShowCoverage] = useState(false)
  const [coverageByDate, setCoverageByDate] = useState<Record<string, CoverageDayData>>({})
  const [salePrefill, setSalePrefill] = useState<SalePrefill | null>(null)
  const [bulkEditSales, setBulkEditSales] = useState<SaleWithDetails[]>([])
  const [calendarGeneration, setCalendarGeneration] = useState<CalendarGenerationState | null>(null)
  const [isApplyingCalendar, setIsApplyingCalendar] = useState(false)
  const [lastGeneratedVariations, setLastGeneratedVariations] = useState<CalendarVariation[]>([])
  const [clearSalesState, setClearSalesState] = useState<ClearSalesState | null>(null)
  const [editLaunchDateState, setEditLaunchDateState] = useState<EditLaunchDateState | null>(null)
  const [filterClientId, setFilterClientId] = useState<string>('')
  const [filterGameId, setFilterGameId] = useState<string>('')
  const [filterProductId, setFilterProductId] = useState<string>('')  // For version management
  const [activeVersionId, setActiveVersionId] = useState<string | null>(null)  // null = working draft
  const [activeVersionSnapshot, setActiveVersionSnapshot] = useState<SaleSnapshot[] | null>(null)  // Snapshot data when viewing a version
  const [versionSnapshotModified, setVersionSnapshotModified] = useState(false)  // Track unsaved changes to version
  const [savingVersion, setSavingVersion] = useState(false)  // Track saving state
  const { pushAction, setHandlers } = useUndo()

  useEffect(() => {
    setHandlers({
      onCreateSale: async (data) => { const { data: newSale, error } = await supabase.from('sales').insert([data]).select().single(); if (error) throw error; return newSale.id },
      onUpdateSale: async (id, data) => { const { error } = await supabase.from('sales').update(data).eq('id', id); if (error) throw error },
      onDeleteSale: async (id) => { const { error } = await supabase.from('sales').delete().eq('id', id); if (error) throw error },
      onRefresh: async () => { await fetchSales() }
    })
  }, [setHandlers])

  useEffect(() => { fetchData() }, [])

  useEffect(() => { if (showCoverage) fetchCoverageData() }, [showCoverage, filterClientId, filterGameId])

  async function fetchSales() {
    const { data: salesData, error: salesError } = await supabase.from('sales').select(`*, product:products(*, game:games(*, client:clients(*))), platform:platforms(*)`).order('start_date')
    if (salesError) throw salesError
    setSales(salesData || [])
  }

  async function fetchData() {
    setLoading(true); setError(null)
    try {
      const { data: platformsData, error: platformsError } = await supabase.from('platforms').select('*').order('name')
      if (platformsError) throw platformsError; setPlatforms(platformsData || [])
      const { data: eventsData, error: eventsError } = await supabase.from('platform_events').select(`*, platform:platforms(*)`).order('start_date', { ascending: false })
      if (eventsError) throw eventsError; setPlatformEvents(eventsData || [])
      const { data: clientsData, error: clientsError } = await supabase.from('clients').select('*').order('name')
      if (clientsError) throw clientsError; setClients(clientsData || [])
      const { data: gamesData, error: gamesError } = await supabase.from('games').select(`*, client:clients(*)`).order('name')
      if (gamesError) throw gamesError; setGames(gamesData || [])
      const { data: productsData, error: productsError } = await supabase.from('products').select(`*, game:games(*, client:clients(*))`).order('name')
      if (productsError) throw productsError; setProducts(productsData || [])
      await fetchSales()
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : 'Failed to load data'; console.error('Error fetching data:', err); setError(errorMessage) }
    finally { setLoading(false) }
  }

  async function fetchPlatformEvents() {
    try {
      const { data: eventsData, error: eventsError } = await supabase.from('platform_events').select(`*, platform:platforms(*)`).order('start_date', { ascending: false })
      if (eventsError) throw eventsError; setPlatformEvents(eventsData || [])
    } catch (err) { console.error('Error fetching platform events:', err) }
  }

  async function fetchCoverageData() {
    try {
      const params = new URLSearchParams()
      if (filterClientId) params.set('client_id', filterClientId)
      if (filterGameId) params.set('game_id', filterGameId)
      const res = await fetch(`/api/coverage-timeline?${params.toString()}`)
      if (!res.ok) return
      const data = await res.json()
      const byDate: Record<string, CoverageDayData> = {}
      for (const item of (data.coverage || [])) {
        const dateKey = item.publish_date?.slice(0, 10)
        if (!dateKey) continue
        if (!byDate[dateKey]) byDate[dateKey] = { count: 0, topTier: '', totalReach: 0, items: [] }
        byDate[dateKey].count++
        const tier = item.outlet?.tier || 'D'
        const tierRank = { A: 4, B: 3, C: 2, D: 1 } as Record<string, number>
        if ((tierRank[tier] || 0) > (tierRank[byDate[dateKey].topTier] || 0)) byDate[dateKey].topTier = tier
        byDate[dateKey].totalReach += item.outlet?.monthly_unique_visitors || item.monthly_unique_visitors || 0
        byDate[dateKey].items.push({ title: item.title || '', outlet: item.outlet?.name || 'Unknown', tier, type: item.coverage_type || '' })
      }
      setCoverageByDate(byDate)
    } catch (err) { console.error('Error fetching coverage data:', err) }
  }

  async function handleSaleUpdate(saleId: string, updates: Partial<Sale>) {
    const currentSale = sales.find(s => s.id === saleId); if (!currentSale) return
    const previousData: Record<string, unknown> = {}; const newData: Record<string, unknown> = {}
    for (const key of Object.keys(updates)) { previousData[key] = currentSale[key as keyof SaleWithDetails]; newData[key] = updates[key as keyof typeof updates] }
    setSales(prev => prev.map(sale => sale.id === saleId ? { ...sale, ...updates } as SaleWithDetails : sale))
    try {
      const { error } = await supabase.from('sales').update(updates).eq('id', saleId); if (error) throw error
      pushAction({ type: 'UPDATE_SALE', saleId, previousData, newData })
      const { data: updatedSale } = await supabase.from('sales').select(`*, product:products(*, game:games(*, client:clients(*))), platform:platforms(*)`).eq('id', saleId).single()
      if (updatedSale) { setSales(prev => prev.map(sale => sale.id === saleId ? updatedSale : sale)) }
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : 'Failed to update sale'; console.error('Error updating sale:', err); setError(errorMessage); await fetchData() }
  }

  async function handleSaleDelete(saleId: string) {
    if (!confirm('Are you sure you want to delete this sale?')) return
    const saleToDelete = sales.find(s => s.id === saleId); if (!saleToDelete) return
    const saleData: Record<string, unknown> = { product_id: saleToDelete.product_id, platform_id: saleToDelete.platform_id, start_date: saleToDelete.start_date, end_date: saleToDelete.end_date, discount_percentage: saleToDelete.discount_percentage, sale_name: saleToDelete.sale_name, sale_type: saleToDelete.sale_type, status: saleToDelete.status, notes: saleToDelete.notes }
    const previousSales = sales; setSales(prev => prev.filter(sale => sale.id !== saleId))
    try { const { error } = await supabase.from('sales').delete().eq('id', saleId); if (error) throw error; pushAction({ type: 'DELETE_SALE', saleId, saleData }) }
    catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : 'Failed to delete sale'; console.error('Error deleting sale:', err); setError(errorMessage); setSales(previousSales) }
  }

  async function handleSaleCreate(sale: Omit<Sale, 'id' | 'created_at'>) {
    try {
      const { data, error } = await supabase.from('sales').insert([sale]).select(`*, product:products(*, game:games(*, client:clients(*))), platform:platforms(*)`).single()
      if (error) throw error
      if (data) { setSales(prev => [...prev, data].sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime())); pushAction({ type: 'CREATE_SALE', saleId: data.id, saleData: sale as Record<string, unknown> }) }
      setShowAddModal(false); setSalePrefill(null); return data
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : 'Failed to create sale'; console.error('Error creating sale:', err); setError(errorMessage); return null }
  }

  async function handleSaleCreateAndContinue(sale: Omit<Sale, 'id' | 'created_at'>) {
    try {
      const { data, error } = await supabase.from('sales').insert([sale]).select(`*, product:products(*, game:games(*, client:clients(*))), platform:platforms(*)`).single()
      if (error) throw error
      if (data) { setSales(prev => [...prev, data].sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime())); pushAction({ type: 'CREATE_SALE', saleId: data.id, saleData: sale as Record<string, unknown> }) }
      return data
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : 'Failed to create sale'; console.error('Error creating sale:', err); setError(errorMessage); throw err }
  }

  const handleBulkEdit = useCallback((selectedSales: SaleWithDetails[]) => { setBulkEditSales(selectedSales) }, [])

  const handleBulkUpdate = useCallback(async (saleIds: string[], updates: Partial<{ discount_percentage: number | null; platform_id: string; sale_name: string | undefined; status: string; dateShiftDays: number }>) => {
    if (updates.dateShiftDays !== undefined) {
      const daysDiff = updates.dateShiftDays
      setSales(prev => prev.map(sale => { if (!saleIds.includes(sale.id)) return sale; const newStartDate = addDays(parseISO(sale.start_date), daysDiff); const newEndDate = addDays(parseISO(sale.end_date), daysDiff); return { ...sale, start_date: format(newStartDate, 'yyyy-MM-dd'), end_date: format(newEndDate, 'yyyy-MM-dd') } }))
      try { for (const saleId of saleIds) { const sale = sales.find(s => s.id === saleId); if (!sale) continue; const newStartDate = format(addDays(parseISO(sale.start_date), daysDiff), 'yyyy-MM-dd'); const newEndDate = format(addDays(parseISO(sale.end_date), daysDiff), 'yyyy-MM-dd'); const { error } = await supabase.from('sales').update({ start_date: newStartDate, end_date: newEndDate }).eq('id', saleId); if (error) throw error } }
      catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : 'Failed to update sales'; console.error('Error bulk updating sales:', err); setError(errorMessage); await fetchSales() }
      return
    }
    const dbUpdates: Partial<Sale> = {}
    if (updates.discount_percentage !== undefined) { dbUpdates.discount_percentage = updates.discount_percentage === null ? undefined : updates.discount_percentage }
    if (updates.platform_id !== undefined) dbUpdates.platform_id = updates.platform_id
    if (updates.sale_name !== undefined) dbUpdates.sale_name = updates.sale_name || undefined
    if (updates.status !== undefined) dbUpdates.status = updates.status as SaleStatus
    setSales(prev => prev.map(sale => { if (!saleIds.includes(sale.id)) return sale; return { ...sale, ...dbUpdates } as SaleWithDetails }))
    try { for (const saleId of saleIds) { const { error } = await supabase.from('sales').update(dbUpdates).eq('id', saleId); if (error) throw error }; if (updates.platform_id) { await fetchSales() } }
    catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : 'Failed to update sales'; console.error('Error bulk updating sales:', err); setError(errorMessage); await fetchSales() }
  }, [sales])

  const handleBulkDelete = useCallback(async (saleIds: string[]) => {
    setSales(prev => prev.filter(sale => !saleIds.includes(sale.id)))
    try { for (const saleId of saleIds) { const { error } = await supabase.from('sales').delete().eq('id', saleId); if (error) throw error } }
    catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : 'Failed to delete sales'; console.error('Error bulk deleting sales:', err); setError(errorMessage); await fetchSales() }
  }, [])

  const handleBulkImport = useCallback(async (salesToCreate: Omit<Sale, 'id' | 'created_at'>[]) => {
    try {
      const { data, error } = await supabase.from('sales').insert(salesToCreate).select(`*, product:products(*, game:games(*, client:clients(*))), platform:platforms(*)`)
      if (error) throw error
      if (data && data.length > 0) { setSales(prev => [...prev, ...data].sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime())); pushAction({ type: 'BATCH_CREATE_SALES', sales: data.map(s => ({ id: s.id, data: salesToCreate.find(sc => sc.product_id === s.product_id && sc.start_date === s.start_date && sc.platform_id === s.platform_id) as Record<string, unknown> })) }) }
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : 'Failed to import sales'; console.error('Error importing sales:', err); throw new Error(errorMessage) }
  }, [pushAction])

  const handleDuplicateSales = useCallback(async (salesToCreate: Omit<Sale, 'id' | 'created_at'>[]) => {
    try {
      const { data, error } = await supabase.from('sales').insert(salesToCreate).select(`*, product:products(*, game:games(*, client:clients(*))), platform:platforms(*)`)
      if (error) throw error
      if (data && data.length > 0) { setSales(prev => [...prev, ...data].sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime())); pushAction({ type: 'BATCH_CREATE_SALES', sales: data.map(s => ({ id: s.id, data: salesToCreate.find(sc => sc.product_id === s.product_id && sc.start_date === s.start_date && sc.platform_id === s.platform_id) as Record<string, unknown> })) }) }
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : 'Failed to duplicate sales'; console.error('Error duplicating sales:', err); throw new Error(errorMessage) }
  }, [pushAction])

  // Activate a version to display (no data deletion - just switches view)
  const handleActivateVersion = useCallback(async (versionId: string | null, snapshot?: SaleSnapshot[] | null) => {
    setActiveVersionId(versionId)
    // Store snapshot data for display when viewing a saved version
    setActiveVersionSnapshot(snapshot || null)
    setVersionSnapshotModified(false)  // Reset modified state
    // No need to re-fetch sales - we display from snapshot when version is active
  }, [])

  // Update a sale in the version snapshot (for editing versions)
  const handleVersionSnapshotUpdate = useCallback((snapshotIndex: number, updates: Partial<SaleSnapshot>) => {
    if (!activeVersionSnapshot) return
    setActiveVersionSnapshot(prev => {
      if (!prev) return prev
      return prev.map((snap, idx) => idx === snapshotIndex ? { ...snap, ...updates } : snap)
    })
    setVersionSnapshotModified(true)
  }, [activeVersionSnapshot])

  // Delete a sale from the version snapshot
  const handleVersionSnapshotDelete = useCallback((snapshotIndex: number) => {
    if (!activeVersionSnapshot) return
    if (!confirm('Are you sure you want to delete this sale from the version?')) return
    setActiveVersionSnapshot(prev => {
      if (!prev) return prev
      return prev.filter((_, idx) => idx !== snapshotIndex)
    })
    setVersionSnapshotModified(true)
  }, [activeVersionSnapshot])

  // Add a new sale to the version snapshot
  const handleVersionSnapshotCreate = useCallback((sale: Omit<Sale, 'id' | 'created_at'>) => {
    if (!activeVersionSnapshot) return null
    const product = products.find(p => p.id === sale.product_id)
    const platform = platforms.find(p => p.id === sale.platform_id)
    const newSnapshotSale: SaleSnapshot = {
      product_id: sale.product_id,
      platform_id: sale.platform_id,
      start_date: sale.start_date,
      end_date: sale.end_date,
      discount_percentage: sale.discount_percentage || null,
      sale_name: sale.sale_name || null,
      sale_type: sale.sale_type,
      status: sale.status,
      notes: sale.notes || null,
      product_name: product?.name,
      platform_name: platform?.name
    }
    setActiveVersionSnapshot(prev => {
      if (!prev) return [newSnapshotSale]
      return [...prev, newSnapshotSale].sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime())
    })
    setVersionSnapshotModified(true)
    setShowAddModal(false)
    setSalePrefill(null)
    return { id: `snapshot-new-${Date.now()}` } as Sale  // Return fake sale for UI
  }, [activeVersionSnapshot, products, platforms])

  // Save the modified version snapshot back to the database
  const handleSaveVersionSnapshot = useCallback(async () => {
    if (!activeVersionId || !activeVersionSnapshot) return
    setSavingVersion(true)
    try {
      // Calculate updated metadata
      const productIds = new Set(activeVersionSnapshot.map(s => s.product_id))
      const platformSummary: Record<string, number> = {}
      activeVersionSnapshot.forEach(sale => {
        const platformName = sale.platform_name || platforms.find(p => p.id === sale.platform_id)?.name || 'Unknown'
        platformSummary[platformName] = (platformSummary[platformName] || 0) + 1
      })
      const dates = activeVersionSnapshot.map(s => s.start_date).concat(activeVersionSnapshot.map(s => s.end_date))
      const sortedDates = dates.sort()

      const { error } = await supabase
        .from('calendar_versions')
        .update({
          sales_snapshot: activeVersionSnapshot,
          product_count: productIds.size,
          sale_count: activeVersionSnapshot.length,
          platform_summary: platformSummary,
          date_range_start: sortedDates[0] || null,
          date_range_end: sortedDates[sortedDates.length - 1] || null,
          updated_at: new Date().toISOString()
        })
        .eq('id', activeVersionId)

      if (error) throw error
      setVersionSnapshotModified(false)
    } catch (err) {
      console.error('Error saving version:', err)
      setError(err instanceof Error ? err.message : 'Failed to save version')
    } finally {
      setSavingVersion(false)
    }
  }, [activeVersionId, activeVersionSnapshot, platforms, supabase])

  const handleSaleEdit = useCallback((sale: SaleWithDetails) => { setEditingSale(sale) }, [])
  const handleSaleDuplicate = useCallback((sale: SaleWithDetails) => { setDuplicatingSale(sale) }, [])

  // Wrapper for sale update - routes to version snapshot or live sales
  const handleSaleUpdateWrapper = useCallback(async (saleId: string, updates: Partial<Sale>) => {
    if (activeVersionId && activeVersionSnapshot && saleId.startsWith('snapshot-')) {
      // Extract index from synthetic ID (e.g., "snapshot-5" -> 5)
      const indexMatch = saleId.match(/^snapshot-(\d+)$/)
      if (indexMatch) {
        const idx = parseInt(indexMatch[1], 10)
        handleVersionSnapshotUpdate(idx, updates as Partial<SaleSnapshot>)
      }
      return
    }
    // Normal mode: update live sales
    await handleSaleUpdate(saleId, updates)
  }, [activeVersionId, activeVersionSnapshot, handleVersionSnapshotUpdate, handleSaleUpdate])

  // Wrapper for sale delete - routes to version snapshot or live sales
  const handleSaleDeleteWrapper = useCallback(async (saleId: string) => {
    if (activeVersionId && activeVersionSnapshot && saleId.startsWith('snapshot-')) {
      const indexMatch = saleId.match(/^snapshot-(\d+)$/)
      if (indexMatch) {
        const idx = parseInt(indexMatch[1], 10)
        handleVersionSnapshotDelete(idx)
      }
      return
    }
    // Normal mode: delete from live sales
    await handleSaleDelete(saleId)
  }, [activeVersionId, activeVersionSnapshot, handleVersionSnapshotDelete, handleSaleDelete])

  // Wrapper for sale create - routes to version snapshot or live sales
  const handleSaleCreateWrapper = useCallback(async (sale: Omit<Sale, 'id' | 'created_at'>) => {
    if (activeVersionId && activeVersionSnapshot) {
      return handleVersionSnapshotCreate(sale)
    }
    // Normal mode: create in live sales
    return handleSaleCreate(sale)
  }, [activeVersionId, activeVersionSnapshot, handleVersionSnapshotCreate, handleSaleCreate])

  const handleTimelineCreate = useCallback(async (prefill: SalePrefill) => {
    if (prefill.directCreate) { const newSale: Omit<Sale, 'id' | 'created_at'> = { product_id: prefill.productId, platform_id: prefill.platformId, start_date: prefill.startDate, end_date: prefill.endDate, sale_name: prefill.saleName, discount_percentage: prefill.discountPercentage, sale_type: (prefill.saleType || 'custom') as Sale['sale_type'], status: 'planned' }; await handleSaleCreate(newSale); return }
    setSalePrefill(prefill); setShowAddModal(true)
  }, [])

  const handleCloseAddModal = useCallback(() => { setShowAddModal(false); setSalePrefill(null) }, [])
  const handleGenerateCalendar = useCallback((productId: string, productName: string, launchDate?: string, platformIds?: string[]) => { const effectiveLaunchDate = launchDate || format(new Date(), 'yyyy-MM-dd'); const product = products.find(p => p.id === productId); const clientId = product?.game?.client_id || ''; setCalendarGeneration({ productId, productName, launchDate: effectiveLaunchDate, platformIds, clientId }) }, [products])

  const handleApplyCalendar = useCallback(async (generatedSales: GeneratedSale[]) => {
    setIsApplyingCalendar(true); setError(null)
    try {
      const salesToCreate = generatedSales.map(sale => generatedSaleToCreateFormat(sale))
      const { data, error } = await supabase.from('sales').insert(salesToCreate).select(`*, product:products(*, game:games(*, client:clients(*))), platform:platforms(*)`)
      if (error) throw error
      if (data && data.length > 0) { setSales(prev => [...prev, ...data].sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime())); pushAction({ type: 'BATCH_CREATE_SALES', sales: data.map(s => ({ id: s.id, data: salesToCreate.find(sc => sc.product_id === s.product_id && sc.start_date === s.start_date) as Record<string, unknown> })) }) }
      setCalendarGeneration(null)
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : 'Failed to create sales'; console.error('Error creating calendar sales:', err); setError(errorMessage) }
    finally { setIsApplyingCalendar(false) }
  }, [pushAction])

  const handleClearSales = useCallback((productId: string, productName: string) => { setClearSalesState({ productId, productName }) }, [])

  const handleConfirmClearSales = useCallback(async (productId: string, platformId: string | null) => {
    const salesToDelete = sales.filter(s => s.product_id === productId && (platformId === null || s.platform_id === platformId))
    if (salesToDelete.length === 0) { setClearSalesState(null); return }
    const saleDataList = salesToDelete.map(s => ({ id: s.id, data: { product_id: s.product_id, platform_id: s.platform_id, start_date: s.start_date, end_date: s.end_date, discount_percentage: s.discount_percentage, sale_name: s.sale_name, sale_type: s.sale_type, status: s.status, notes: s.notes } as Record<string, unknown> }))
    setSales(prev => prev.filter(s => !(s.product_id === productId && (platformId === null || s.platform_id === platformId))))
    try { for (const sale of salesToDelete) { const { error } = await supabase.from('sales').delete().eq('id', sale.id); if (error) throw error }; pushAction({ type: 'BATCH_DELETE_SALES', sales: saleDataList }); setClearSalesState(null) }
    catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : 'Failed to delete sales'; console.error('Error clearing sales:', err); setError(errorMessage); await fetchSales() }
  }, [sales, pushAction])

  const handleLaunchDateChange = useCallback(async (productId: string, newLaunchDate: string) => {
    const product = products.find(p => p.id === productId); if (!product) return
    const oldLaunchDate = product.launch_date; if (!oldLaunchDate || oldLaunchDate === newLaunchDate) return
    const oldDate = parseISO(oldLaunchDate); const newDate = parseISO(newLaunchDate); const daysDiff = Math.round((newDate.getTime() - oldDate.getTime()) / (1000 * 60 * 60 * 24)); if (daysDiff === 0) return
    const productSales = sales.filter(s => s.product_id === productId)
    setProducts(prev => prev.map(p => p.id === productId ? { ...p, launch_date: newLaunchDate } : p))
    const updatedSales = productSales.map(sale => { const newStartDate = new Date(parseISO(sale.start_date).getTime() + daysDiff * 24 * 60 * 60 * 1000); const newEndDate = new Date(parseISO(sale.end_date).getTime() + daysDiff * 24 * 60 * 60 * 1000); return { ...sale, start_date: format(newStartDate, 'yyyy-MM-dd'), end_date: format(newEndDate, 'yyyy-MM-dd') } })
    setSales(prev => prev.map(sale => { const updated = updatedSales.find(u => u.id === sale.id); return updated || sale }))
    try { const { error: productError } = await supabase.from('products').update({ launch_date: newLaunchDate }).eq('id', productId); if (productError) throw productError; for (const sale of updatedSales) { const { error: saleError } = await supabase.from('sales').update({ start_date: sale.start_date, end_date: sale.end_date }).eq('id', sale.id); if (saleError) throw saleError } }
    catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : 'Failed to update launch date'; console.error('Error updating launch date:', err); setError(errorMessage); await fetchData() }
  }, [products, sales])

  const handleEditLaunchDate = useCallback((productId: string, productName: string, currentLaunchDate: string, currentLaunchSaleDuration?: number) => { setEditLaunchDateState({ productId, productName, currentLaunchDate, currentLaunchSaleDuration }) }, [])

  const handleLaunchSaleDurationChange = useCallback(async (productId: string, newDuration: number) => {
    const product = products.find(p => p.id === productId); if (!product) return
    setProducts(prev => prev.map(p => p.id === productId ? { ...p, launch_sale_duration: newDuration } : p))
    try { const { error } = await supabase.from('products').update({ launch_sale_duration: newDuration }).eq('id', productId); if (error) throw error }
    catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : 'Failed to update launch sale duration'; console.error('Error updating launch sale duration:', err); setError(errorMessage); await fetchData() }
  }, [products])

  const handleSaveLaunchDate = useCallback(async (productId: string, newLaunchDate: string, launchSaleDuration: number, shiftSales: boolean) => {
    const product = products.find(p => p.id === productId); if (!product) return
    const productUpdate: { launch_date: string; launch_sale_duration?: number } = { launch_date: newLaunchDate }
    if (launchSaleDuration !== (product.launch_sale_duration || 7)) { productUpdate.launch_sale_duration = launchSaleDuration }
    if (shiftSales) {
      const oldLaunchDate = product.launch_date
      if (oldLaunchDate && oldLaunchDate !== newLaunchDate) {
        const oldDate = parseISO(oldLaunchDate); const newDate = parseISO(newLaunchDate); const daysDiff = Math.round((newDate.getTime() - oldDate.getTime()) / (1000 * 60 * 60 * 24))
        if (daysDiff !== 0) {
          const productSales = sales.filter(s => s.product_id === productId)
          setProducts(prev => prev.map(p => p.id === productId ? { ...p, ...productUpdate } : p))
          const updatedSales = productSales.map(sale => { const newStartDate = new Date(parseISO(sale.start_date).getTime() + daysDiff * 24 * 60 * 60 * 1000); const newEndDate = new Date(parseISO(sale.end_date).getTime() + daysDiff * 24 * 60 * 60 * 1000); return { ...sale, start_date: format(newStartDate, 'yyyy-MM-dd'), end_date: format(newEndDate, 'yyyy-MM-dd') } })
          setSales(prev => prev.map(sale => { const updated = updatedSales.find(u => u.id === sale.id); return updated || sale }))
          try { const { error: productError } = await supabase.from('products').update(productUpdate).eq('id', productId); if (productError) throw productError; for (const sale of updatedSales) { const { error: saleError } = await supabase.from('sales').update({ start_date: sale.start_date, end_date: sale.end_date }).eq('id', sale.id); if (saleError) throw saleError } }
          catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : 'Failed to update launch date'; console.error('Error updating launch date:', err); setError(errorMessage); await fetchData() }
        }
      }
    } else {
      setProducts(prev => prev.map(p => p.id === productId ? { ...p, ...productUpdate } : p))
      try { const { error } = await supabase.from('products').update(productUpdate).eq('id', productId); if (error) throw error }
      catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : 'Failed to update launch date'; console.error('Error updating launch date:', err); setError(errorMessage); await fetchData() }
    }
    setEditLaunchDateState(null)
  }, [products, sales])

  async function handleClientCreate(client: Omit<Client, 'id' | 'created_at'>) { try { const { data, error } = await supabase.from('clients').insert([client]).select().single(); if (error) throw error; if (data) setClients(prev => [...prev, data].sort((a, b) => a.name.localeCompare(b.name))) } catch (err: unknown) { console.error('Error creating client:', err); throw err } }
  async function handleGameCreate(game: Omit<Game, 'id' | 'created_at'>): Promise<(Game & { client: Client }) | undefined> { try { const { data, error } = await supabase.from('games').insert([game]).select(`*, client:clients(*)`).single(); if (error) throw error; if (data) { setGames(prev => [...prev, data].sort((a, b) => a.name.localeCompare(b.name))); return data } } catch (err: unknown) { console.error('Error creating game:', err); throw err } }
  async function handleProductCreate(product: Omit<Product, 'id' | 'created_at'>, platformIds?: string[]): Promise<Product | undefined> {
    try {
      const { data, error } = await supabase.from('products').insert([product]).select(`*, game:games(*, client:clients(*))`).single()
      if (error) throw error
      if (data) {
        // If platform IDs provided, create product_platforms entries
        if (platformIds && platformIds.length > 0) {
          const productPlatforms = platformIds.map(platformId => ({
            product_id: data.id,
            platform_id: platformId
          }))
          const { error: ppError } = await supabase.from('product_platforms').insert(productPlatforms)
          if (ppError) console.error('Error creating product_platforms:', ppError)
        }
        setProducts(prev => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)))
        return data
      }
    } catch (err: unknown) {
      console.error('Error creating product:', err)
      throw err
    }
  }

  async function handlePlatformCreate(platform: { name: string }): Promise<Platform | undefined> {
    try {
      const res = await fetch('/api/platforms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(platform)
      })
      if (!res.ok) throw new Error('Failed to create platform')
      const data = await res.json()
      setPlatforms(prev => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)))
      return data
    } catch (err) {
      console.error('Error creating platform:', err)
      throw err
    }
  }

  async function handleClientUpdate(clientId: string, updates: Partial<Client>) { try { const { error } = await supabase.from('clients').update(updates).eq('id', clientId); if (error) throw error; setClients(prev => prev.map(c => c.id === clientId ? { ...c, ...updates } : c).sort((a, b) => a.name.localeCompare(b.name))); if (updates.name) { setGames(prev => prev.map(g => g.client_id === clientId ? { ...g, client: { ...g.client, ...updates } } : g)); setProducts(prev => prev.map(p => p.game?.client_id === clientId ? { ...p, game: { ...p.game, client: { ...p.game.client, ...updates } } } : p)) } } catch (err: unknown) { console.error('Error updating client:', err); throw err } }
  async function handleGameUpdate(gameId: string, updates: Partial<Game>) { try { const { data, error } = await supabase.from('games').update(updates).eq('id', gameId).select(`*, client:clients(*)`).single(); if (error) throw error; if (data) { setGames(prev => prev.map(g => g.id === gameId ? data : g).sort((a, b) => a.name.localeCompare(b.name))); setProducts(prev => prev.map(p => p.game_id === gameId ? { ...p, game: data } : p)); if (updates.pr_tracking_enabled === true) { try { await fetch('/api/coverage-keywords', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: data.client_id, game_id: gameId, keyword: data.name, keyword_type: 'whitelist' }) }); } catch (kwErr) { console.error('Failed to auto-create keyword:', kwErr) } } } } catch (err: unknown) { console.error('Error updating game:', err); throw err } }
  async function handleProductUpdate(productId: string, updates: Partial<Product>, platformIds?: string[]) { try { const { data, error } = await supabase.from('products').update(updates).eq('id', productId).select(`*, game:games(*, client:clients(*))`).single(); if (error) throw error; if (data) { if (platformIds) { await supabase.from('product_platforms').delete().eq('product_id', productId); if (platformIds.length > 0) { const pp = platformIds.map(pid => ({ product_id: productId, platform_id: pid })); await supabase.from('product_platforms').insert(pp) } } setProducts(prev => prev.map(p => p.id === productId ? data : p).sort((a, b) => a.name.localeCompare(b.name))) } } catch (err: unknown) { console.error('Error updating product:', err); throw err } }

  async function handleClientDelete(clientId: string) {
    try {
      // Delete children first to avoid FK constraint timeouts
      const gameIds = games.filter(g => g.client_id === clientId).map(g => g.id)
      const productIds = products.filter(p => gameIds.includes(p.game_id)).map(p => p.id)
      if (productIds.length > 0) {
        const { error: salesErr } = await supabase.from('sales').delete().in('product_id', productIds)
        if (salesErr) throw salesErr
        const { error: prodErr } = await supabase.from('products').delete().in('id', productIds)
        if (prodErr) throw prodErr
      }
      if (gameIds.length > 0) {
        const { error: gameErr } = await supabase.from('games').delete().in('id', gameIds)
        if (gameErr) throw gameErr
      }
      const { error } = await supabase.from('clients').delete().eq('id', clientId)
      if (error) throw error
      if (filterClientId === clientId) setFilterClientId('')
      setClients(prev => prev.filter(c => c.id !== clientId))
      setGames(prev => prev.filter(g => g.client_id !== clientId))
      setProducts(prev => prev.filter(p => !gameIds.includes(p.game_id)))
      setSales(prev => prev.filter(s => !gameIds.includes(s.product?.game_id || '')))
    } catch (err: unknown) { console.error('Error deleting client:', err); throw err }
  }
  async function handleGameDelete(gameId: string) {
    try {
      const productIds = products.filter(p => p.game_id === gameId).map(p => p.id)
      if (productIds.length > 0) {
        const { error: salesErr } = await supabase.from('sales').delete().in('product_id', productIds)
        if (salesErr) throw salesErr
        const { error: prodErr } = await supabase.from('products').delete().in('id', productIds)
        if (prodErr) throw prodErr
      }
      const { error } = await supabase.from('games').delete().eq('id', gameId)
      if (error) throw error
      if (filterGameId === gameId) setFilterGameId('')
      setGames(prev => prev.filter(g => g.id !== gameId))
      setProducts(prev => prev.filter(p => p.game_id !== gameId))
      setSales(prev => prev.filter(s => !productIds.includes(s.product_id)))
    } catch (err: unknown) { console.error('Error deleting game:', err); throw err }
  }
  async function handleProductDelete(productId: string) {
    try {
      const { error: salesErr } = await supabase.from('sales').delete().eq('product_id', productId)
      if (salesErr) throw salesErr
      const { error } = await supabase.from('products').delete().eq('id', productId)
      if (error) throw error
      setProducts(prev => prev.filter(p => p.id !== productId))
      setSales(prev => prev.filter(s => s.product_id !== productId))
    } catch (err: unknown) { console.error('Error deleting product:', err); throw err }
  }

  const filteredGames = useMemo(() => { let result = games.filter(g => g.sales_planning_enabled !== false); if (filterClientId) { result = result.filter(g => g.client_id === filterClientId) }; return result }, [games, filterClientId])
  const filteredProducts = useMemo(() => { let result = products.filter(p => p.game?.sales_planning_enabled !== false && p.game?.client?.sales_planning_enabled !== false); if (filterProductId) { result = result.filter(p => p.id === filterProductId) } else if (filterGameId) { result = result.filter(p => p.game_id === filterGameId) } else if (filterClientId) { result = result.filter(p => p.game?.client_id === filterClientId) }; return result }, [products, filterClientId, filterGameId, filterProductId])

  // When a version is active, convert its snapshot to SaleWithDetails format for display
  const filteredSales = useMemo(() => {
    // If we're viewing a saved version, show its snapshot data
    if (activeVersionId && activeVersionSnapshot) {
      const snapshotSales: SaleWithDetails[] = activeVersionSnapshot.map((snap, idx) => {
        const product = products.find(p => p.id === snap.product_id)
        const platform = platforms.find(p => p.id === snap.platform_id)
        return {
          id: `snapshot-${idx}`,  // Synthetic ID for display
          product_id: snap.product_id,
          platform_id: snap.platform_id,
          start_date: snap.start_date,
          end_date: snap.end_date,
          discount_percentage: snap.discount_percentage ?? undefined,
          sale_name: snap.sale_name ?? undefined,
          sale_type: snap.sale_type as Sale['sale_type'],
          status: snap.status as Sale['status'],
          notes: snap.notes ?? undefined,
          created_at: new Date().toISOString(),
          product: product || { id: snap.product_id, game_id: '', name: snap.product_name || 'Unknown', product_type: 'base' as const, created_at: '', game: { id: '', client_id: '', name: '', sales_planning_enabled: true, pr_tracking_enabled: false, created_at: '', client: { id: '', name: '', sales_planning_enabled: true, pr_tracking_enabled: false, created_at: '' } } },
          platform: platform || { id: snap.platform_id, name: snap.platform_name || 'Unknown', cooldown_days: 0, approval_required: false, color_hex: '#666', max_sale_days: 14, special_sales_no_cooldown: false }
        }
      })
      // Apply filters to snapshot data
      let result = snapshotSales
      if (filterProductId) { result = result.filter(s => s.product_id === filterProductId) }
      else if (filterGameId) { result = result.filter(s => s.product?.game_id === filterGameId) }
      else if (filterClientId) { result = result.filter(s => s.product?.game?.client_id === filterClientId) }
      return result
    }

    // Normal mode: show live sales
    let result = sales
    if (filterProductId) { result = result.filter(s => s.product_id === filterProductId) }
    else if (filterGameId) { result = result.filter(s => s.product?.game_id === filterGameId) }
    else if (filterClientId) { result = result.filter(s => s.product?.game?.client_id === filterClientId) }
    return result
  }, [sales, filterClientId, filterGameId, filterProductId, activeVersionId, activeVersionSnapshot, products, platforms])

  const { conflicts, conflictDetails } = useMemo(() => {
    const conflictList: ConflictInfo[] = []
    const steamPlatformIds = platforms.filter(p => p.name.toLowerCase().includes('steam')).map(p => p.id)
    if (steamPlatformIds.length === 0) { return { conflicts: 0, conflictDetails: [] } }
    const steamSeasonalEvents = platformEvents.filter(e => steamPlatformIds.includes(e.platform_id) && e.event_type === 'seasonal')
    for (const product of filteredProducts) {
      if (!product.launch_date) continue
      const duration = product.launch_sale_duration || 7; const launchStart = normalizeToLocalDate(product.launch_date); const launchEnd = addDays(launchStart, duration - 1)
      for (const event of steamSeasonalEvents) {
        const eventStart = normalizeToLocalDate(event.start_date); const eventEnd = normalizeToLocalDate(event.end_date)
        if (launchStart <= eventEnd && launchEnd >= eventStart) { const overlapStart = launchStart > eventStart ? launchStart : eventStart; const overlapEnd = launchEnd < eventEnd ? launchEnd : eventEnd; const overlapDays = Math.round((overlapEnd.getTime() - overlapStart.getTime()) / (1000 * 60 * 60 * 24)) + 1; conflictList.push({ productName: product.name, eventName: event.name, overlapDays }) }
      }
    }
    return { conflicts: conflictList.length, conflictDetails: conflictList }
  }, [filteredProducts, platforms, platformEvents])

  const { upcomingEventsCount, upcomingEventDetails } = useMemo(() => {
    const now = new Date(); const upcoming = platformEvents.filter(e => new Date(e.start_date) > now)
    const details = upcoming.sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime()).map(e => { const platform = platforms.find(p => p.id === e.platform_id); return { label: e.name, sublabel: format(normalizeToLocalDate(e.start_date), 'MMM d, yyyy'), color: platform?.color_hex || '#8b5cf6' } })
    return { upcomingEventsCount: upcoming.length, upcomingEventDetails: details }
  }, [platformEvents, platforms])

  // Sales breakdown by platform for interactive stat card
  const salesByPlatformDetails = useMemo(() => {
    const counts = new Map<string, { count: number; color: string }>()
    for (const sale of filteredSales) {
      const name = sale.platform?.name || 'Unknown'
      const color = sale.platform?.color_hex || '#666'
      const existing = counts.get(name) || { count: 0, color }
      counts.set(name, { count: existing.count + 1, color })
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .map(([name, data]) => ({ label: `${name}: ${data.count}`, color: data.color }))
  }, [filteredSales])

  // Upcoming sales (next 30 days)
  const upcomingSalesDetails = useMemo(() => {
    const now = new Date()
    const thirtyDaysOut = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
    return filteredSales
      .filter(s => { const start = new Date(s.start_date); return start > now && start <= thirtyDaysOut })
      .sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime())
      .map(s => ({
        label: s.product?.name || 'Unknown',
        sublabel: `${s.platform?.name} | ${format(normalizeToLocalDate(s.start_date), 'MMM d')} - ${format(normalizeToLocalDate(s.end_date), 'MMM d')}${s.discount_percentage ? ` (${s.discount_percentage}% off)` : ''}`,
        color: s.platform?.color_hex || '#666'
      }))
  }, [filteredSales])

  // Products breakdown by type for interactive stat card
  const productsByTypeDetails = useMemo(() => {
    const typeLabels: Record<string, string> = { base: 'Base Games', edition: 'Editions', dlc: 'DLC', soundtrack: 'Soundtracks', bundle: 'Bundles' }
    const counts = new Map<string, number>()
    for (const product of filteredProducts) {
      const type = product.product_type || 'base'
      counts.set(type, (counts.get(type) || 0) + 1)
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ label: `${typeLabels[type] || type}: ${count}` }))
  }, [filteredProducts])

  const now = new Date(); const timelineStart = new Date(now.getFullYear(), now.getMonth(), 1); const monthCount = 12

  useEffect(() => {
    // Clear game filter if it doesn't belong to selected client
    if (filterClientId && filterGameId) { const game = games.find(g => g.id === filterGameId); if (game && game.client_id !== filterClientId) { setFilterGameId(''); setFilterProductId('') } }
    // Clear product filter if it doesn't belong to selected game
    if (filterGameId && filterProductId) { const product = products.find(p => p.id === filterProductId); if (product && product.game_id !== filterGameId) { setFilterProductId('') } }
    // Also clear version state when no scope filter is active (need either product or client filter for versions)
    if (!filterProductId && !filterClientId && activeVersionId) { setActiveVersionId(null); setActiveVersionSnapshot(null) }
  }, [filterClientId, filterGameId, filterProductId, games, products, activeVersionId])

  if (authLoading || loading) { return (<div style={{ display: 'flex', minHeight: '100vh' }}><Sidebar /><div style={{ flex: 1, overflow: 'auto' }}><div className={styles.container}><div className={styles.loading}><div className={styles.spinner}></div><p>Loading sales data...</p></div></div></div></div>) }

  if (!canView) { return (<div style={{ display: 'flex', minHeight: '100vh' }}><Sidebar /><div style={{ flex: 1, overflow: 'auto' }}><div className={styles.container}><div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '50vh', gap: '1rem' }}><h2 style={{ fontSize: '1.5rem', fontWeight: 600, color: '#1f2937' }}>Access Denied</h2><p style={{ color: '#6b7280' }}>You don&apos;t have permission to view the Sales Timeline.</p></div></div></div></div>) }

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar />
      <div style={{ flex: 1, overflow: 'auto' }}>
    <div className={styles.container}>
      <header className={styles.header}><h1>GameDrive Sales Planning</h1><p>Interactive sales timeline with drag-and-drop scheduling</p></header>

      {error && (<div className={styles.errorBanner}><span>Warning: {error}</span><button onClick={() => setError(null)}>×</button></div>)}

      <div className={styles.statsGrid}>
        <StatCard icon="📊" iconColor="#10b981" title="TOTAL SALES" value={filteredSales.length} subtitle={upcomingSalesDetails.length > 0 ? `${upcomingSalesDetails.length} upcoming in 30 days` : 'Across all platforms'} tooltipTitle="Sales by Platform" tooltipItems={salesByPlatformDetails} tooltipEmptyMessage="No sales scheduled" />
        <StatCard icon="🎮" iconColor="#3b82f6" title="PRODUCTS" value={filteredProducts.length} subtitle="Games and DLCs" tooltipTitle="Products by Type" tooltipItems={productsByTypeDetails} tooltipEmptyMessage="No products configured" />
        <StatCard icon="📅" iconColor="#8b5cf6" title="PLATFORM EVENTS" value={upcomingEventsCount} subtitle="Upcoming sales events" tooltipTitle="Upcoming Platform Events" tooltipItems={upcomingEventDetails} tooltipEmptyMessage="No upcoming platform events" />
        <StatCard icon={conflicts > 0 ? '⚠️' : '✅'} iconColor={conflicts > 0 ? '#ef4444' : '#22c55e'} title="CONFLICTS" value={conflicts} subtitle={conflicts === 0 ? 'All platforms clear' : 'Needs attention'} warning={conflicts > 0} tooltipTitle="Launch Sale Conflicts" tooltipItems={conflictDetails.map(c => ({ label: c.productName, sublabel: `${c.eventName} (${c.overlapDays}d overlap)`, warning: true }))} tooltipEmptyMessage="No conflicts detected" />
      </div>

      <GapAnalysis sales={filteredSales} products={filteredProducts} platforms={platforms} timelineStart={timelineStart} monthCount={monthCount} />

      <div className={styles.filters}>
        <div className={styles.filterGroup}><label>Client:</label><select value={filterClientId} onChange={(e) => { setFilterClientId(e.target.value); setFilterGameId(''); setFilterProductId('') }}><option value="">All Clients</option>{clients.filter(c => c.sales_planning_enabled !== false).map(client => (<option key={client.id} value={client.id}>{client.name}</option>))}</select></div>
        <div className={styles.filterGroup}><label>Game:</label><select value={filterGameId} onChange={(e) => { setFilterGameId(e.target.value); setFilterProductId('') }}><option value="">All Games</option>{filteredGames.map(game => (<option key={game.id} value={game.id}>{game.name}</option>))}</select></div>
        <div className={styles.filterGroup}><label>Product:</label><select value={filterProductId} onChange={(e) => setFilterProductId(e.target.value)}><option value="">All Products</option>{filteredProducts.map(product => (<option key={product.id} value={product.id}>{product.name}</option>))}</select></div>
        <div className={styles.filterGroup}><label className={styles.checkboxLabel}><input type="checkbox" checked={showEvents} onChange={(e) => setShowEvents(e.target.checked)} />Show Platform Events</label></div>
        <div className={styles.filterGroup}><label className={styles.checkboxLabel}><input type="checkbox" checked={showCoverage} onChange={(e) => setShowCoverage(e.target.checked)} />Show Coverage</label></div>
        {(filterClientId || filterGameId || filterProductId) && (<button className={styles.clearFilters} onClick={() => { setFilterClientId(''); setFilterGameId(''); setFilterProductId(''); setActiveVersionId(null); setActiveVersionSnapshot(null) }}>Clear Filters</button>)}
      </div>

      {/* Version viewing banner */}
      {activeVersionId && (
        <div className={`${styles.versionBanner} ${versionSnapshotModified ? styles.versionBannerModified : ''}`}>
          <span>
            {versionSnapshotModified
              ? '📋 Editing version - unsaved changes'
              : '📋 Viewing saved version - edits will modify this version'}
          </span>
          <div className={styles.versionBannerActions}>
            {versionSnapshotModified && (
              <button
                className={styles.saveVersionBtn}
                onClick={handleSaveVersionSnapshot}
                disabled={savingVersion}
              >
                {savingVersion ? 'Saving...' : '💾 Save Version'}
              </button>
            )}
            <button onClick={() => {
              if (versionSnapshotModified && !confirm('You have unsaved changes. Discard them?')) return
              setActiveVersionId(null)
              setActiveVersionSnapshot(null)
              setVersionSnapshotModified(false)
            }}>✏️ Return to Working Draft</button>
          </div>
        </div>
      )}

      <div className={styles.toolbar}>
        <div className={styles.viewToggle}><button className={`${styles.toggleBtn} ${viewMode === 'gantt' ? styles.active : ''}`} onClick={() => setViewMode('gantt')}>Timeline</button><button className={`${styles.toggleBtn} ${viewMode === 'table' ? styles.active : ''}`} onClick={() => setViewMode('table')}>Table</button><button className={`${styles.toggleBtn} ${viewMode === 'analysis' ? styles.active : ''}`} onClick={() => setViewMode('analysis')}>Analysis</button></div>
        <div className={styles.actions}><button className={styles.primaryBtn} onClick={() => setShowAddModal(true)}>+ Add Sale</button>{!activeVersionId && <button className={styles.secondaryBtn} onClick={() => setShowImportModal(true)}>Import CSV</button>}<button className={styles.secondaryBtn} onClick={() => setShowVersionManager(true)}>📚 Versions</button>{!activeVersionId && <button className={styles.secondaryBtn} onClick={() => window.location.href = '/settings/clients'}>Manage Clients</button>}{!activeVersionId && <button className={styles.secondaryBtn} onClick={() => setShowPlatformSettings(true)}>Platform Settings</button>}<button className={styles.secondaryBtn} onClick={() => setShowExportModal(true)}>Export</button>{!activeVersionId && <button className={styles.secondaryBtn} onClick={fetchData}>Refresh</button>}</div>
      </div>

      <div className={styles.mainContent}>
        {viewMode === 'gantt' ? (<GanttChart sales={filteredSales} products={filteredProducts} platforms={platforms} platformEvents={platformEvents} timelineStart={timelineStart} monthCount={monthCount} onSaleUpdate={handleSaleUpdateWrapper} onSaleDelete={handleSaleDeleteWrapper} onSaleEdit={handleSaleEdit} onSaleDuplicate={handleSaleDuplicate} onCreateSale={handleTimelineCreate} onGenerateCalendar={handleGenerateCalendar} onClearSales={handleClearSales} onLaunchDateChange={handleLaunchDateChange} onEditLaunchDate={handleEditLaunchDate} onLaunchSaleDurationChange={handleLaunchSaleDurationChange} allSales={activeVersionId ? [] : sales} showEvents={showEvents} coverageByDate={coverageByDate} showCoverage={showCoverage} />) : viewMode === 'table' ? (<SalesTable sales={filteredSales} platforms={platforms} onDelete={handleSaleDeleteWrapper} onEdit={handleSaleEdit} onUpdate={handleSaleUpdateWrapper} onDuplicate={handleSaleDuplicate} onBulkEdit={handleBulkEdit} />) : (<SaleAnalysis sales={filteredSales} platforms={platforms} />)}
      </div>

      {showCoverage && Object.keys(coverageByDate).length > 0 && (
        <CoverageCorrelation coverageByDate={coverageByDate} sales={filteredSales} timelineStart={timelineStart} monthCount={monthCount} clientId={filterClientId || undefined} gameId={filterGameId || undefined} />
      )}

      {showAddModal && (<AddSaleModal products={products} platforms={platforms} existingSales={activeVersionId ? [] : sales} onSave={handleSaleCreateWrapper} onSaveAndContinue={handleSaleCreateAndContinue} onClose={handleCloseAddModal} initialDate={salePrefill ? parseISO(salePrefill.startDate) : undefined} initialEndDate={salePrefill ? parseISO(salePrefill.endDate) : undefined} initialProductId={salePrefill?.productId} initialPlatformId={salePrefill?.platformId} initialSaleName={salePrefill?.saleName} initialDiscountPercentage={salePrefill?.discountPercentage} initialSaleType={salePrefill?.saleType} />)}
      {editingSale && (<EditSaleModal sale={editingSale} products={products} platforms={platforms} existingSales={activeVersionId ? [] : sales} onSave={handleSaleUpdateWrapper} onDelete={handleSaleDeleteWrapper} onDuplicate={handleSaleDuplicate} onClose={() => setEditingSale(null)} />)}
      {duplicatingSale && (<DuplicateSaleModal sale={duplicatingSale} products={products} platforms={platforms} existingSales={sales} onDuplicate={handleDuplicateSales} onClose={() => setDuplicatingSale(null)} />)}
      <BulkEditSalesModal isOpen={bulkEditSales.length > 0} onClose={() => setBulkEditSales([])} selectedSales={bulkEditSales} platforms={platforms} onBulkUpdate={handleBulkUpdate} onBulkDelete={handleBulkDelete} />
      <ImportSalesModal isOpen={showImportModal} onClose={() => setShowImportModal(false)} products={products} platforms={platforms} existingSales={sales} onImport={handleBulkImport} clients={clients} games={games} onProductCreate={handleProductCreate} onGameCreate={handleGameCreate} onPlatformCreate={handlePlatformCreate} />
      <VersionManager isOpen={showVersionManager} onClose={() => setShowVersionManager(false)} currentSales={sales} platforms={platforms} onActivateVersion={handleActivateVersion} activeVersionId={activeVersionId} productId={filterProductId || null} productName={products.find(p => p.id === filterProductId)?.name || null} clientId={filterClientId || null} clientName={clients.find(c => c.id === filterClientId)?.name || null} hasUnsavedChanges={versionSnapshotModified} onSaveVersion={handleSaveVersionSnapshot} />
      <PlatformSettings isOpen={showPlatformSettings} onClose={() => setShowPlatformSettings(false)} onEventsChange={() => { fetchPlatformEvents(); fetchData() }} />
      {calendarGeneration && (<SaleCalendarPreviewModal isOpen={true} onClose={() => setCalendarGeneration(null)} productId={calendarGeneration.productId} productName={calendarGeneration.productName} launchDate={calendarGeneration.launchDate} platforms={platforms} platformEvents={platformEvents} existingSales={sales} onApply={handleApplyCalendar} isApplying={isApplyingCalendar} initialPlatformIds={calendarGeneration.platformIds} clientId={calendarGeneration.clientId} />)}
      {clearSalesState && (<ClearSalesModal isOpen={true} onClose={() => setClearSalesState(null)} productId={clearSalesState.productId} productName={clearSalesState.productName} platforms={platforms} sales={sales} onConfirm={handleConfirmClearSales} />)}
      {editLaunchDateState && (<EditLaunchDateModal isOpen={true} onClose={() => setEditLaunchDateState(null)} productId={editLaunchDateState.productId} productName={editLaunchDateState.productName} currentLaunchDate={editLaunchDateState.currentLaunchDate} currentLaunchSaleDuration={editLaunchDateState.currentLaunchSaleDuration || 7} onSave={handleSaveLaunchDate} salesCount={sales.filter(s => s.product_id === editLaunchDateState.productId).length} platforms={platforms} platformEvents={platformEvents} />)}
      <TimelineExportModal isOpen={showExportModal} onClose={() => setShowExportModal(false)} sales={filteredSales} products={filteredProducts} platforms={platforms} timelineStart={timelineStart} monthCount={monthCount} calendarVariations={lastGeneratedVariations} />
    </div>
      </div>
    </div>
  )
}
