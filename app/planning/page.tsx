'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import { Sidebar } from '../components/Sidebar'
import { useAuth } from '@/lib/auth-context'

// ─── Types ──────────────────────────────────────────────────────────────────

type Category = 'pr' | 'sales' | 'events' | 'content' | 'social' | 'general'

interface PlanningItem {
  id: string
  client_id: string
  title: string
  category: Category
  start_date: string
  end_date: string
  color: string | null
  notes: string | null
  created_at: string
}

interface Client {
  id: string
  name: string
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CATEGORIES: { key: Category; label: string; color: string; bg: string }[] = [
  { key: 'pr',      label: 'PR & Media',  color: '#2563eb', bg: '#dbeafe' },
  { key: 'sales',   label: 'Sales',       color: '#b8232f', bg: '#fee2e2' },
  { key: 'events',  label: 'Events',      color: '#d97706', bg: '#fef3c7' },
  { key: 'content', label: 'Content',     color: '#059669', bg: '#d1fae5' },
  { key: 'social',  label: 'Social',      color: '#7c3aed', bg: '#ede9fe' },
  { key: 'general', label: 'General',     color: '#475569', bg: '#f1f5f9' },
]

const CAT_MAP = Object.fromEntries(CATEGORIES.map(c => [c.key, c]))

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function isLeapYear(y: number) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
}

function yearDays(y: number) {
  return isLeapYear(y) ? 366 : 365
}

function dayOfYear(dateStr: string, year: number): number {
  const d = new Date(dateStr)
  const start = new Date(year, 0, 1)
  const diff = Math.round((d.getTime() - start.getTime()) / 86400000)
  return Math.max(0, Math.min(diff, yearDays(year) - 1))
}

function pct(day: number, year: number): number {
  return (day / yearDays(year)) * 100
}

// ─── Component ──────────────────────────────────────────────────────────────

const EMPTY_FORM = {
  title: '',
  category: 'pr' as Category,
  start_date: '',
  end_date: '',
  color: '',
  notes: '',
}

export default function PlanningPage() {
  const { hasAccess, loading: authLoading } = useAuth()
  const canView = hasAccess('sales_timeline', 'view')
  const canEdit = hasAccess('sales_timeline', 'edit')
  const supabase = createClientComponentClient()

  const [clients, setClients] = useState<Client[]>([])
  const [selectedClient, setSelectedClient] = useState<string>('')
  const [year, setYear] = useState(new Date().getFullYear())
  const [items, setItems] = useState<PlanningItem[]>([])
  const [loading, setLoading] = useState(false)
  const [filterCat, setFilterCat] = useState<Category | 'all'>('all')

  // Modal state
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Today marker
  const todayPct = (() => {
    const now = new Date()
    if (now.getFullYear() !== year) return null
    const start = new Date(year, 0, 1)
    const day = Math.round((now.getTime() - start.getTime()) / 86400000)
    return pct(day, year)
  })()

  // Fetch clients
  useEffect(() => {
    if (!canView) return
    supabase.from('clients').select('id, name').order('name').then(({ data }) => {
      if (data) {
        setClients(data)
        if (data.length > 0 && !selectedClient) setSelectedClient(data[0].id)
      }
    })
  }, [canView]) // eslint-disable-line

  // Fetch items
  const fetchItems = useCallback(async () => {
    if (!selectedClient) return
    setLoading(true)
    try {
      const res = await fetch(`/api/planning?client_id=${selectedClient}&year=${year}`)
      if (res.ok) setItems(await res.json())
    } catch { /* ignore */ }
    setLoading(false)
  }, [selectedClient, year])

  useEffect(() => { fetchItems() }, [fetchItems])

  // Grouped items by category
  const grouped = CATEGORIES.map(cat => ({
    ...cat,
    items: items.filter(i => i.category === cat.key && (filterCat === 'all' || filterCat === cat.key)),
  })).filter(g => filterCat === 'all' || g.key === filterCat)

  const visibleCategories = grouped.filter(g => g.items.length > 0 || filterCat === 'all')

  // ─── Modal helpers ──────────────────────────────────────────────────────

  const openAdd = (cat?: Category) => {
    setEditingId(null)
    setForm({ ...EMPTY_FORM, category: cat || 'pr', start_date: `${year}-01-01`, end_date: `${year}-01-07` })
    setSaveError(null)
    setShowModal(true)
  }

  const openEdit = (item: PlanningItem) => {
    setEditingId(item.id)
    setForm({
      title: item.title,
      category: item.category,
      start_date: item.start_date,
      end_date: item.end_date,
      color: item.color || '',
      notes: item.notes || '',
    })
    setSaveError(null)
    setShowModal(true)
  }

  const handleSave = async () => {
    if (!form.title.trim() || !form.start_date) {
      setSaveError('Title and start date are required')
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const payload = {
        ...(editingId ? { id: editingId } : { client_id: selectedClient }),
        title: form.title,
        category: form.category,
        start_date: form.start_date,
        end_date: form.end_date || form.start_date,
        color: form.color || null,
        notes: form.notes || null,
      }
      const res = await fetch('/api/planning', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const j = await res.json()
        setSaveError(j.error || 'Save failed')
      } else {
        setShowModal(false)
        fetchItems()
      }
    } catch {
      setSaveError('Network error')
    }
    setSaving(false)
  }

  const handleDelete = async (id: string) => {
    setSaving(true)
    try {
      await fetch(`/api/planning?id=${id}`, { method: 'DELETE' })
      setShowModal(false)
      fetchItems()
    } catch { /* ignore */ }
    setSaving(false)
  }

  // ─── Month header widths ────────────────────────────────────────────────

  const monthDaysForYear = MONTH_DAYS.map((d, i) => i === 1 && isLeapYear(year) ? 29 : d)
  const totalDays = yearDays(year)

  // ─── Loading / Auth ─────────────────────────────────────────────────────

  if (authLoading) {
    return (
      <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
        <Sidebar />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><p>Loading...</p></div>
      </div>
    )
  }

  if (!canView) {
    return (
      <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
        <Sidebar />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ color: '#64748b' }}>Access denied</p>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
      <Sidebar />

      <div style={{ flex: 1, padding: '28px 32px', overflow: 'auto', minWidth: 0 }}>
        <div style={{ maxWidth: '1400px', margin: '0 auto' }}>

          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px' }}>
            <div>
              <h1 style={{ fontSize: '26px', fontWeight: 700, color: '#1e293b', margin: 0 }}>Campaign Planning</h1>
              <p style={{ fontSize: '14px', color: '#64748b', margin: '4px 0 0 0' }}>
                Overarching project & campaign timeline — replaces the Planning spreadsheet
              </p>
            </div>
            {canEdit && (
              <button
                onClick={() => openAdd()}
                style={{ padding: '10px 18px', backgroundColor: '#b8232f', color: 'white', border: 'none', borderRadius: '8px', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}
              >
                + Add Item
              </button>
            )}
          </div>

          {/* Filters bar */}
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap' }}>
            {/* Client selector */}
            <select
              value={selectedClient}
              onChange={e => setSelectedClient(e.target.value)}
              style={{ padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', backgroundColor: 'white', color: '#1e293b' }}
            >
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>

            {/* Year navigator */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <button
                onClick={() => setYear(y => y - 1)}
                style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', backgroundColor: 'white', cursor: 'pointer', fontSize: '14px', color: '#475569' }}
              >
                ‹
              </button>
              <span style={{ padding: '6px 16px', backgroundColor: 'white', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', fontWeight: 600, color: '#1e293b', minWidth: '70px', textAlign: 'center' }}>
                {year}
              </span>
              <button
                onClick={() => setYear(y => y + 1)}
                style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', backgroundColor: 'white', cursor: 'pointer', fontSize: '14px', color: '#475569' }}
              >
                ›
              </button>
            </div>

            {/* Category filter */}
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <button
                onClick={() => setFilterCat('all')}
                style={{
                  padding: '5px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: 500, cursor: 'pointer', border: 'none',
                  backgroundColor: filterCat === 'all' ? '#1e293b' : '#f1f5f9',
                  color: filterCat === 'all' ? 'white' : '#475569',
                }}
              >
                All
              </button>
              {CATEGORIES.map(cat => (
                <button
                  key={cat.key}
                  onClick={() => setFilterCat(filterCat === cat.key ? 'all' : cat.key)}
                  style={{
                    padding: '5px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: 500, cursor: 'pointer', border: 'none',
                    backgroundColor: filterCat === cat.key ? cat.color : cat.bg,
                    color: filterCat === cat.key ? 'white' : cat.color,
                  }}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          </div>

          {/* Gantt chart */}
          <div style={{ backgroundColor: 'white', borderRadius: '12px', border: '1px solid #e2e8f0', overflow: 'hidden' }}>

            {/* Month header */}
            <div style={{ display: 'flex', borderBottom: '2px solid #e2e8f0' }}>
              {/* Row label column */}
              <div style={{ width: '180px', flexShrink: 0, borderRight: '1px solid #e2e8f0', padding: '10px 14px', backgroundColor: '#f8fafc' }}>
                <span style={{ fontSize: '12px', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Category / Item</span>
              </div>
              {/* Month cells */}
              <div style={{ flex: 1, display: 'flex', position: 'relative', overflow: 'hidden' }}>
                {MONTHS.map((m, i) => {
                  const widthPct = (monthDaysForYear[i] / totalDays) * 100
                  return (
                    <div
                      key={m}
                      style={{
                        width: `${widthPct}%`, flexShrink: 0, padding: '10px 0',
                        textAlign: 'center', fontSize: '12px', fontWeight: 600, color: '#475569',
                        borderRight: i < 11 ? '1px solid #f1f5f9' : 'none',
                        backgroundColor: '#f8fafc'
                      }}
                    >
                      {m}
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Category rows */}
            {loading ? (
              <div style={{ padding: '40px', textAlign: 'center', color: '#94a3b8', fontSize: '14px' }}>
                Loading...
              </div>
            ) : !selectedClient ? (
              <div style={{ padding: '40px', textAlign: 'center', color: '#94a3b8', fontSize: '14px' }}>
                Select a client to view their planning timeline
              </div>
            ) : visibleCategories.length === 0 || (visibleCategories.every(g => g.items.length === 0)) ? (
              <div style={{ padding: '60px', textAlign: 'center', color: '#94a3b8' }}>
                <div style={{ fontSize: '32px', marginBottom: '12px' }}>📅</div>
                <div style={{ fontSize: '16px', fontWeight: 600, color: '#475569', marginBottom: '6px' }}>No items planned yet</div>
                <div style={{ fontSize: '14px', marginBottom: '16px' }}>Add your first campaign item to get started</div>
                {canEdit && (
                  <button
                    onClick={() => openAdd()}
                    style={{ padding: '10px 20px', backgroundColor: '#b8232f', color: 'white', border: 'none', borderRadius: '8px', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}
                  >
                    + Add First Item
                  </button>
                )}
              </div>
            ) : (
              <>
                {visibleCategories.map((cat, ci) => (
                  <div key={cat.key}>
                    {/* Category header */}
                    <div style={{ display: 'flex', backgroundColor: '#fafafa', borderTop: ci > 0 ? '2px solid #e2e8f0' : undefined }}>
                      <div style={{
                        width: '180px', flexShrink: 0, padding: '8px 14px',
                        borderRight: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between'
                      }}>
                        <span style={{
                          fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px',
                          color: cat.color
                        }}>
                          {cat.label}
                        </span>
                        {canEdit && (
                          <button
                            onClick={() => openAdd(cat.key as Category)}
                            title={`Add ${cat.label} item`}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: cat.color, fontSize: '16px', padding: '0 2px', lineHeight: 1 }}
                          >
                            +
                          </button>
                        )}
                      </div>
                      <div style={{ flex: 1, position: 'relative', minHeight: '28px' }}>
                        {/* Month dividers */}
                        {MONTHS.map((m, i) => {
                          const leftPct = (monthDaysForYear.slice(0, i).reduce((a, b) => a + b, 0) / totalDays) * 100
                          return i > 0 ? (
                            <div key={m} style={{ position: 'absolute', left: `${leftPct}%`, top: 0, bottom: 0, borderLeft: '1px solid #f1f5f9' }} />
                          ) : null
                        })}
                        {/* Today marker */}
                        {todayPct !== null && (
                          <div style={{ position: 'absolute', left: `${todayPct}%`, top: 0, bottom: 0, borderLeft: '2px dashed #94a3b8', zIndex: 2 }} />
                        )}
                      </div>
                    </div>

                    {/* Items in this category */}
                    {cat.items.length === 0 ? (
                      <div style={{ display: 'flex', borderTop: '1px solid #f1f5f9', minHeight: '36px' }}>
                        <div style={{ width: '180px', flexShrink: 0, padding: '8px 14px', borderRight: '1px solid #e2e8f0' }}>
                          <span style={{ fontSize: '12px', color: '#94a3b8', fontStyle: 'italic' }}>No items</span>
                        </div>
                        <div style={{ flex: 1, position: 'relative' }}>
                          {MONTHS.map((m, i) => {
                            const leftPct = (monthDaysForYear.slice(0, i).reduce((a, b) => a + b, 0) / totalDays) * 100
                            return i > 0 ? (
                              <div key={m} style={{ position: 'absolute', left: `${leftPct}%`, top: 0, bottom: 0, borderLeft: '1px solid #f1f5f9' }} />
                            ) : null
                          })}
                        </div>
                      </div>
                    ) : cat.items.map(item => {
                      const startDay = dayOfYear(item.start_date, year)
                      const endDay = dayOfYear(item.end_date, year)
                      const leftP = pct(startDay, year)
                      const widthP = Math.max(pct(endDay - startDay + 1, year), 0.5)
                      const itemColor = item.color || cat.color

                      return (
                        <div key={item.id} style={{ display: 'flex', borderTop: '1px solid #f1f5f9', minHeight: '40px' }}>
                          {/* Label */}
                          <div style={{
                            width: '180px', flexShrink: 0, padding: '8px 14px', borderRight: '1px solid #e2e8f0',
                            display: 'flex', alignItems: 'center', gap: '6px'
                          }}>
                            <span style={{ fontSize: '13px', color: '#1e293b', fontWeight: 500, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.title}>
                              {item.title}
                            </span>
                          </div>
                          {/* Timeline row */}
                          <div style={{ flex: 1, position: 'relative' }}>
                            {/* Month dividers */}
                            {MONTHS.map((m, i) => {
                              const leftPct = (monthDaysForYear.slice(0, i).reduce((a, b) => a + b, 0) / totalDays) * 100
                              return i > 0 ? (
                                <div key={m} style={{ position: 'absolute', left: `${leftPct}%`, top: 0, bottom: 0, borderLeft: '1px solid #f1f5f9' }} />
                              ) : null
                            })}
                            {/* Today marker */}
                            {todayPct !== null && (
                              <div style={{ position: 'absolute', left: `${todayPct}%`, top: 0, bottom: 0, borderLeft: '2px dashed #94a3b8', zIndex: 2 }} />
                            )}
                            {/* Item bar */}
                            <div
                              onClick={() => canEdit && openEdit(item)}
                              title={`${item.title}\n${item.start_date} → ${item.end_date}${item.notes ? '\n' + item.notes : ''}`}
                              style={{
                                position: 'absolute',
                                left: `calc(${leftP}% + 2px)`,
                                width: `calc(${widthP}% - 4px)`,
                                top: '6px', bottom: '6px',
                                backgroundColor: itemColor,
                                borderRadius: '4px',
                                cursor: canEdit ? 'pointer' : 'default',
                                display: 'flex', alignItems: 'center', padding: '0 6px',
                                zIndex: 3,
                                boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
                                transition: 'filter 0.1s',
                                minWidth: '4px',
                              }}
                              onMouseEnter={e => { if (canEdit) (e.currentTarget as HTMLDivElement).style.filter = 'brightness(1.1)' }}
                              onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.filter = 'none' }}
                            >
                              <span style={{ fontSize: '11px', color: 'white', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.95 }}>
                                {item.title}
                              </span>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ))}

                {/* Today legend */}
                {todayPct !== null && (
                  <div style={{ padding: '8px 14px', borderTop: '1px solid #f1f5f9', display: 'flex', gap: '12px', alignItems: 'center' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: '#64748b' }}>
                      <span style={{ display: 'inline-block', width: '16px', height: '2px', borderTop: '2px dashed #94a3b8' }} /> Today
                    </span>
                    <span style={{ fontSize: '11px', color: '#94a3b8' }}>
                      {new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                    </span>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Item count */}
          {items.length > 0 && (
            <p style={{ fontSize: '12px', color: '#94a3b8', margin: '8px 0 0 0' }}>
              {items.length} item{items.length !== 1 ? 's' : ''} planned for {year}
            </p>
          )}
        </div>
      </div>

      {/* Add/Edit Modal */}
      {showModal && (
        <div
          style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}
          onClick={() => setShowModal(false)}
        >
          <div
            style={{ backgroundColor: 'white', borderRadius: '14px', padding: '28px', width: '500px', maxHeight: '90vh', overflow: 'auto', boxShadow: '0 20px 50px rgba(0,0,0,0.25)' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#1e293b', margin: 0 }}>
                {editingId ? 'Edit Item' : 'Add Planning Item'}
              </h2>
              <button onClick={() => setShowModal(false)} style={{ background: 'none', border: 'none', fontSize: '22px', color: '#94a3b8', cursor: 'pointer' }}>×</button>
            </div>

            {saveError && (
              <div style={{ padding: '10px 14px', backgroundColor: '#fee2e2', color: '#dc2626', borderRadius: '6px', marginBottom: '14px', fontSize: '13px' }}>
                {saveError}
              </div>
            )}

            <div style={{ display: 'grid', gap: '14px' }}>
              {/* Title */}
              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>Title *</label>
                <input
                  type="text"
                  value={form.title}
                  onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                  placeholder="e.g. Press release — launch announcement"
                  autoFocus
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box' }}
                />
              </div>

              {/* Category */}
              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '6px' }}>Category</label>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {CATEGORIES.map(cat => (
                    <button
                      key={cat.key}
                      type="button"
                      onClick={() => setForm(f => ({ ...f, category: cat.key }))}
                      style={{
                        padding: '5px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: 500, cursor: 'pointer', border: 'none',
                        backgroundColor: form.category === cat.key ? cat.color : cat.bg,
                        color: form.category === cat.key ? 'white' : cat.color,
                      }}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Dates */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>Start Date *</label>
                  <input
                    type="date"
                    value={form.start_date}
                    onChange={e => setForm(f => ({ ...f, start_date: e.target.value, end_date: f.end_date < e.target.value ? e.target.value : f.end_date }))}
                    style={{ width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>End Date</label>
                  <input
                    type="date"
                    value={form.end_date}
                    min={form.start_date}
                    onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))}
                    style={{ width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box' }}
                  />
                </div>
              </div>

              {/* Color override */}
              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>
                  Color override
                  <span style={{ fontSize: '11px', color: '#94a3b8', marginLeft: '6px' }}>optional — defaults to category color</span>
                </label>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  {['#b8232f', '#2563eb', '#059669', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#ea580c'].map(c => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setForm(f => ({ ...f, color: f.color === c ? '' : c }))}
                      style={{
                        width: '24px', height: '24px', borderRadius: '50%', backgroundColor: c, border: 'none', cursor: 'pointer',
                        outline: form.color === c ? `2px solid ${c}` : 'none',
                        outlineOffset: '2px',
                      }}
                    />
                  ))}
                  {form.color && (
                    <button type="button" onClick={() => setForm(f => ({ ...f, color: '' }))} style={{ fontSize: '12px', color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer' }}>
                      ✕ clear
                    </button>
                  )}
                </div>
              </div>

              {/* Notes */}
              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>Notes</label>
                <textarea
                  value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="Additional details, links, contacts..."
                  rows={3}
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px', boxSizing: 'border-box', resize: 'vertical' }}
                />
              </div>
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '20px', paddingTop: '16px', borderTop: '1px solid #f1f5f9' }}>
              <div>
                {editingId && (
                  <button
                    onClick={() => handleDelete(editingId)}
                    disabled={saving}
                    style={{ padding: '8px 14px', backgroundColor: 'white', color: '#dc2626', border: '1px solid #fecaca', borderRadius: '6px', fontSize: '13px', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}
                  >
                    Delete
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  onClick={() => setShowModal(false)}
                  style={{ padding: '8px 18px', backgroundColor: 'white', color: '#475569', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', cursor: 'pointer' }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  style={{ padding: '8px 22px', backgroundColor: '#b8232f', color: 'white', border: 'none', borderRadius: '6px', fontSize: '14px', fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}
                >
                  {saving ? 'Saving...' : editingId ? 'Save Changes' : 'Add Item'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
