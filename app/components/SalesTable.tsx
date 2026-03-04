'use client'

import { useState, useMemo, useCallback } from 'react'
import { format, parseISO, differenceInDays, addDays } from 'date-fns'
import { Sale, SaleWithDetails, Platform } from '@/lib/types'
import styles from './SalesTable.module.css'
import * as XLSX from 'xlsx'

interface SalesTableProps {
  sales: SaleWithDetails[]
  platforms: Platform[]
  onDelete: (saleId: string) => Promise<void>
  onEdit: (sale: SaleWithDetails) => void
  onUpdate?: (saleId: string, updates: Partial<Sale>) => Promise<void>
  onDuplicate?: (sale: SaleWithDetails) => void
  onBulkEdit?: (selectedSales: SaleWithDetails[]) => void
}

type EditingCell = { saleId: string; field: string } | null

export default function SalesTable({ sales, platforms, onDelete, onEdit, onUpdate, onDuplicate, onBulkEdit }: SalesTableProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [selectMode, setSelectMode] = useState(false)
  const [editingCell, setEditingCell] = useState<EditingCell>(null)
  const [editValue, setEditValue] = useState('')

  // Inline cell editing handlers
  const handleCellClick = useCallback((saleId: string, field: string, currentValue: string, e: React.MouseEvent) => {
    if (!onUpdate || selectMode) return
    e.stopPropagation()
    setEditingCell({ saleId, field })
    setEditValue(currentValue)
  }, [onUpdate, selectMode])

  const handleCellSave = useCallback(async () => {
    if (!editingCell || !onUpdate) return
    const { saleId, field } = editingCell
    const sale = sales.find(s => s.id === saleId)
    if (!sale) { setEditingCell(null); return }

    let updates: Partial<Sale> = {}

    if (field === 'discount_percentage') {
      const num = parseFloat(editValue)
      if (isNaN(num) || num < 0 || num > 100) { setEditingCell(null); return }
      if (num === (sale.discount_percentage || 0)) { setEditingCell(null); return }
      updates = { discount_percentage: num }
    } else if (field === 'sale_name') {
      if (editValue === (sale.sale_name || '')) { setEditingCell(null); return }
      updates = { sale_name: editValue }
    } else if (field === 'comment') {
      if (editValue === (sale.comment || sale.notes || '')) { setEditingCell(null); return }
      updates = { comment: editValue }
    } else if (field === 'start_date' || field === 'end_date') {
      if (!editValue) { setEditingCell(null); return }
      // Convert from dd/MM/yyyy input or yyyy-MM-dd input
      const isoDate = editValue // date inputs give yyyy-MM-dd
      if (isoDate === sale[field]) { setEditingCell(null); return }
      updates = { [field]: isoDate }
    }

    if (Object.keys(updates).length > 0) {
      await onUpdate(saleId, updates)
    }
    setEditingCell(null)
  }, [editingCell, editValue, onUpdate, sales])

  const handleCellKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleCellSave()
    } else if (e.key === 'Escape') {
      setEditingCell(null)
    }
  }, [handleCellSave])

  const handleToggleField = useCallback(async (saleId: string, field: 'is_campaign' | 'is_submitted' | 'is_confirmed', currentValue: boolean) => {
    if (!onUpdate) return
    await onUpdate(saleId, { [field]: !currentValue })
  }, [onUpdate])

  const isEditing = (saleId: string, field: string) =>
    editingCell?.saleId === saleId && editingCell?.field === field

  // Sort sales by start date
  const sortedSales = [...sales].sort((a, b) => 
    new Date(a.start_date).getTime() - new Date(b.start_date).getTime()
  )
  
  // Get unique games for group selection
  const uniqueGames = useMemo(() => {
    const gameMap = new Map<string, { id: string; name: string; clientName: string; saleCount: number }>()
    sales.forEach(sale => {
      const gameId = sale.product?.game_id
      const gameName = sale.product?.game?.name
      const clientName = sale.product?.game?.client?.name
      if (gameId && gameName) {
        const existing = gameMap.get(gameId)
        if (existing) {
          existing.saleCount++
        } else {
          gameMap.set(gameId, { id: gameId, name: gameName, clientName: clientName || '', saleCount: 1 })
        }
      }
    })
    return Array.from(gameMap.values())
  }, [sales])
  
  const calculateDays = (start: string, end: string): number => {
    return differenceInDays(parseISO(end), parseISO(start)) + 1
  }
  
  const calculateCooldownUntil = (endDate: string, platformId: string): string => {
    const platform = platforms.find(p => p.id === platformId)
    if (!platform || platform.cooldown_days === 0) return '-'
    
    const cooldownEnd = addDays(parseISO(endDate), platform.cooldown_days)
    return format(cooldownEnd, 'dd/MM/yyyy')
  }
  
  // Selection handlers
  const toggleSelectMode = () => {
    if (selectMode) {
      setSelectedIds(new Set())
    }
    setSelectMode(!selectMode)
  }
  
  const toggleSelect = (saleId: string) => {
    const newSelected = new Set(selectedIds)
    if (newSelected.has(saleId)) {
      newSelected.delete(saleId)
    } else {
      newSelected.add(saleId)
    }
    setSelectedIds(newSelected)
  }
  
  const selectAll = () => {
    if (selectedIds.size === sortedSales.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(sortedSales.map(s => s.id)))
    }
  }
  
  const selectByGame = (gameId: string) => {
    const gameSaleIds = sales
      .filter(s => s.product?.game_id === gameId)
      .map(s => s.id)
    
    // Check if all game sales are already selected
    const allSelected = gameSaleIds.every(id => selectedIds.has(id))
    
    const newSelected = new Set(selectedIds)
    if (allSelected) {
      // Deselect all from this game
      gameSaleIds.forEach(id => newSelected.delete(id))
    } else {
      // Select all from this game
      gameSaleIds.forEach(id => newSelected.add(id))
    }
    setSelectedIds(newSelected)
  }
  
  const handleBulkEdit = () => {
    if (onBulkEdit && selectedIds.size > 0) {
      const selectedSales = sales.filter(s => selectedIds.has(s.id))
      onBulkEdit(selectedSales)
    }
  }
  
  const exportToExcel = () => {
    // Prepare data for Excel - matching client's exact column structure
    const excelData = sortedSales.map(sale => {
      const platform = platforms.find(p => p.id === sale.platform_id)
      return {
        'Start date': format(parseISO(sale.start_date), 'dd/MM/yyyy'),
        'End date': format(parseISO(sale.end_date), 'dd/MM/yyyy'),
        'Days': calculateDays(sale.start_date, sale.end_date),
        'Platform': platform?.name || '',
        'Cooldown': platform?.cooldown_days || 0,
        'Sale Name': sale.sale_name || 'Custom',
        'Product': sale.product?.name || '',
        'Game': sale.product?.game?.name || '',
        'Client': sale.product?.game?.client?.name || '',
        'Campaign?': sale.is_campaign ? 'Yes' : '',
        'Goal': sale.goal_type || '',
        'Discount %': sale.discount_percentage ? `${sale.discount_percentage}%` : '',
        'Submitted?': sale.is_submitted ? 'Yes' : '',
        'Confirmed?': sale.is_confirmed ? 'Yes' : '',
        'Comment': sale.comment || sale.notes || '',
        'Cooldown Until': calculateCooldownUntil(sale.end_date, sale.platform_id),
        'Prev. Sale Stops Date': sale.prev_sale_end_date 
          ? format(parseISO(sale.prev_sale_end_date), 'dd/MM/yyyy') 
          : ''
      }
    })
    
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.json_to_sheet(excelData)
    
    ws['!cols'] = [
      { wch: 12 }, { wch: 12 }, { wch: 6 }, { wch: 15 }, { wch: 10 },
      { wch: 25 }, { wch: 25 }, { wch: 20 }, { wch: 15 }, { wch: 10 },
      { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 30 },
      { wch: 14 }, { wch: 18 },
    ]
    
    XLSX.utils.book_append_sheet(wb, ws, 'Sales Schedule')
    const filename = `sales_schedule_${format(new Date(), 'yyyy-MM-dd')}.xlsx`
    XLSX.writeFile(wb, filename)
  }
  
  const exportToCSV = () => {
    const headers = [
      'Start date', 'End date', 'Days', 'Platform', 'Cooldown', 'Sale Name',
      'Product', 'Game', 'Client', 'Campaign?', 'Goal', 'Discount %',
      'Submitted?', 'Confirmed?', 'Comment', 'Cooldown Until', 'Prev. Sale Stops Date'
    ]
    
    const rows = sortedSales.map(sale => {
      const platform = platforms.find(p => p.id === sale.platform_id)
      return [
        format(parseISO(sale.start_date), 'dd/MM/yyyy'),
        format(parseISO(sale.end_date), 'dd/MM/yyyy'),
        calculateDays(sale.start_date, sale.end_date),
        platform?.name || '',
        platform?.cooldown_days || 0,
        sale.sale_name || 'Custom',
        sale.product?.name || '',
        sale.product?.game?.name || '',
        sale.product?.game?.client?.name || '',
        sale.is_campaign ? 'Yes' : '',
        sale.goal_type || '',
        sale.discount_percentage ? `${sale.discount_percentage}%` : '',
        sale.is_submitted ? 'Yes' : '',
        sale.is_confirmed ? 'Yes' : '',
        sale.comment || sale.notes || '',
        calculateCooldownUntil(sale.end_date, sale.platform_id),
        sale.prev_sale_end_date 
          ? format(parseISO(sale.prev_sale_end_date), 'dd/MM/yyyy') 
          : ''
      ]
    })
    
    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n')
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const link = document.createElement('a')
    const url = URL.createObjectURL(blob)
    link.setAttribute('href', url)
    link.setAttribute('download', `sales_schedule_${format(new Date(), 'yyyy-MM-dd')}.csv`)
    link.style.visibility = 'hidden'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }
  
  const handleRowClick = (sale: SaleWithDetails, e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    if ((e.target as HTMLElement).closest('input[type="checkbox"]')) return
    
    if (selectMode) {
      toggleSelect(sale.id)
    } else {
      onEdit(sale)
    }
  }
  
  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.count}>{sales.length} sales scheduled</span>
          {onBulkEdit && (
            <button 
              className={`${styles.selectModeBtn} ${selectMode ? styles.active : ''}`}
              onClick={toggleSelectMode}
            >
              {selectMode ? '✕ Cancel' : '☑️ Select'}
            </button>
          )}
        </div>
        <div className={styles.exportButtons}>
          <button className={styles.exportBtn} onClick={exportToExcel} title="Export to Excel">
            📊 Export Excel
          </button>
          <button className={styles.exportBtnSecondary} onClick={exportToCSV} title="Export to CSV">
            📄 CSV
          </button>
        </div>
      </div>
      
      {/* Bulk Selection Controls */}
      {selectMode && (
        <div className={styles.bulkControls}>
          <div className={styles.bulkLeft}>
            <button 
              className={styles.selectAllBtn}
              onClick={selectAll}
            >
              {selectedIds.size === sortedSales.length ? 'Deselect All' : 'Select All'}
            </button>
            
            <div className={styles.gameFilters}>
              <span className={styles.filterLabel}>By Game:</span>
              {uniqueGames.map(game => {
                const gameSaleIds = sales.filter(s => s.product?.game_id === game.id).map(s => s.id)
                const selectedCount = gameSaleIds.filter(id => selectedIds.has(id)).length
                const isPartial = selectedCount > 0 && selectedCount < gameSaleIds.length
                const isAll = selectedCount === gameSaleIds.length
                
                return (
                  <button
                    key={game.id}
                    className={`${styles.gameFilterBtn} ${isAll ? styles.allSelected : ''} ${isPartial ? styles.partialSelected : ''}`}
                    onClick={() => selectByGame(game.id)}
                    title={`${game.clientName} - ${game.saleCount} sales`}
                  >
                    {game.name}
                    {selectedCount > 0 && <span className={styles.selectedBadge}>{selectedCount}</span>}
                  </button>
                )
              })}
            </div>
          </div>
          
          {selectedIds.size > 0 && (
            <div className={styles.bulkRight}>
              <span className={styles.selectedCount}>{selectedIds.size} selected</span>
              <button 
                className={styles.bulkEditBtn}
                onClick={handleBulkEdit}
              >
                ✏️ Bulk Edit
              </button>
            </div>
          )}
        </div>
      )}
      
      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr>
              {selectMode && (
                <th className={styles.checkboxCol}>
                  <input 
                    type="checkbox"
                    checked={selectedIds.size === sortedSales.length && sortedSales.length > 0}
                    onChange={selectAll}
                  />
                </th>
              )}
              <th>Start Date</th>
              <th>End Date</th>
              <th>Days</th>
              <th>Platform</th>
              <th>Sale Name</th>
              <th>Product</th>
              <th>Discount</th>
              <th>Campaign</th>
              <th>Goal</th>
              <th>Submitted</th>
              <th>Confirmed</th>
              <th>Cooldown Until</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedSales.length === 0 ? (
              <tr>
                <td colSpan={selectMode ? 14 : 13} className={styles.emptyRow}>
                  No sales scheduled. Click "+ Add Sale" to create one.
                </td>
              </tr>
            ) : (
              sortedSales.map(sale => {
                const platform = platforms.find(p => p.id === sale.platform_id)
                const days = calculateDays(sale.start_date, sale.end_date)
                const cooldownUntil = calculateCooldownUntil(sale.end_date, sale.platform_id)
                const isSelected = selectedIds.has(sale.id)
                
                return (
                  <tr 
                    key={sale.id} 
                    onClick={(e) => handleRowClick(sale, e)}
                    className={`${styles.clickableRow} ${isSelected ? styles.selectedRow : ''}`}
                    title={selectMode ? "Click to select" : "Click to edit"}
                  >
                    {selectMode && (
                      <td className={styles.checkboxCol}>
                        <input 
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(sale.id)}
                          onClick={e => e.stopPropagation()}
                        />
                      </td>
                    )}
                    <td
                      className={onUpdate && !selectMode ? styles.editableCell : ''}
                      onClick={(e) => handleCellClick(sale.id, 'start_date', sale.start_date, e)}
                    >
                      {isEditing(sale.id, 'start_date') ? (
                        <input
                          type="date"
                          className={styles.cellInput}
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={handleCellSave}
                          onKeyDown={handleCellKeyDown}
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : format(parseISO(sale.start_date), 'dd/MM/yyyy')}
                    </td>
                    <td
                      className={onUpdate && !selectMode ? styles.editableCell : ''}
                      onClick={(e) => handleCellClick(sale.id, 'end_date', sale.end_date, e)}
                    >
                      {isEditing(sale.id, 'end_date') ? (
                        <input
                          type="date"
                          className={styles.cellInput}
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={handleCellSave}
                          onKeyDown={handleCellKeyDown}
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : format(parseISO(sale.end_date), 'dd/MM/yyyy')}
                    </td>
                    <td>{days}</td>
                    <td>
                      <span 
                        className={styles.platformBadge}
                        style={{ backgroundColor: platform?.color_hex || '#666' }}
                      >
                        {platform?.name || 'Unknown'}
                      </span>
                    </td>
                    <td
                      className={onUpdate && !selectMode ? styles.editableCell : ''}
                      onClick={(e) => handleCellClick(sale.id, 'sale_name', sale.sale_name || '', e)}
                    >
                      {isEditing(sale.id, 'sale_name') ? (
                        <input
                          type="text"
                          className={styles.cellInput}
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={handleCellSave}
                          onKeyDown={handleCellKeyDown}
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (sale.sale_name || 'Custom')}
                    </td>
                    <td>
                      <div className={styles.productCell}>
                        <span className={styles.productName}>{sale.product?.name}</span>
                        <span className={styles.gameName}>{sale.product?.game?.name}</span>
                      </div>
                    </td>
                    <td
                      className={`${styles.discount} ${onUpdate && !selectMode ? styles.editableCell : ''}`}
                      onClick={(e) => handleCellClick(sale.id, 'discount_percentage', String(sale.discount_percentage || ''), e)}
                    >
                      {isEditing(sale.id, 'discount_percentage') ? (
                        <input
                          type="number"
                          className={styles.cellInput}
                          value={editValue}
                          min="0"
                          max="100"
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={handleCellSave}
                          onKeyDown={handleCellKeyDown}
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (sale.discount_percentage ? `-${sale.discount_percentage}%` : '-')}
                    </td>
                    <td
                      className={`${styles.checkCell} ${onUpdate && !selectMode ? styles.toggleCell : ''}`}
                      onClick={(e) => { e.stopPropagation(); if (onUpdate && !selectMode) handleToggleField(sale.id, 'is_campaign', !!sale.is_campaign) }}
                    >
                      {sale.is_campaign ? <span className={styles.checkMark}>✓</span> : (onUpdate && !selectMode ? <span className={styles.emptyCheck}>-</span> : null)}
                    </td>
                    <td>
                      {sale.goal_type && (
                        <span className={`${styles.goalBadge} ${styles[sale.goal_type]}`}>
                          {sale.goal_type}
                        </span>
                      )}
                    </td>
                    <td
                      className={`${styles.checkCell} ${onUpdate && !selectMode ? styles.toggleCell : ''}`}
                      onClick={(e) => { e.stopPropagation(); if (onUpdate && !selectMode) handleToggleField(sale.id, 'is_submitted', !!sale.is_submitted) }}
                    >
                      {sale.is_submitted ? <span className={styles.checkMark}>✓</span> : (onUpdate && !selectMode ? <span className={styles.emptyCheck}>-</span> : null)}
                    </td>
                    <td
                      className={`${styles.checkCell} ${onUpdate && !selectMode ? styles.toggleCell : ''}`}
                      onClick={(e) => { e.stopPropagation(); if (onUpdate && !selectMode) handleToggleField(sale.id, 'is_confirmed', !!sale.is_confirmed) }}
                    >
                      {sale.is_confirmed ? <span className={styles.checkMarkGreen}>✓</span> : (onUpdate && !selectMode ? <span className={styles.emptyCheck}>-</span> : null)}
                    </td>
                    <td>{cooldownUntil}</td>
                    <td className={styles.actionCell}>
                      <button 
                        className={styles.editBtn}
                        onClick={(e) => {
                          e.stopPropagation()
                          onEdit(sale)
                        }}
                        title="Edit sale"
                      >
                        ✏️
                      </button>
                      {onDuplicate && (
                        <button 
                          className={styles.duplicateBtn}
                          onClick={(e) => {
                            e.stopPropagation()
                            onDuplicate(sale)
                          }}
                          title="Duplicate sale"
                        >
                          📋
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
                        🗑
                      </button>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
