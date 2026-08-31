'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import { Sidebar } from '../components/Sidebar'
import { supabase } from '@/lib/supabase'
import styles from './feedback.module.css'
import {
  FeedbackItem, FeedbackType, FeedbackStatus, FeedbackPriority,
  STATUS_COLUMNS, TYPE_META, PRIORITY_META, AREA_TAGS, tagColor, tagLabel, refCode,
} from './types'

// ─── Image attachments (Supabase Storage) ───────────────────────────────────

async function uploadFeedbackImage(file: File): Promise<string> {
  const ext = file.name.split('.').pop() || 'png'
  const path = `${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from('feedback-images').upload(path, file, { upsert: false })
  if (error) throw error
  return supabase.storage.from('feedback-images').getPublicUrl(path).data.publicUrl
}

function feedbackImagePath(url: string): string | null {
  const marker = '/feedback-images/'
  const idx = url.indexOf(marker)
  return idx === -1 ? null : url.slice(idx + marker.length)
}

async function deleteFeedbackImage(url: string) {
  const path = feedbackImagePath(url)
  if (!path) return
  await supabase.storage.from('feedback-images').remove([path])
}

type View = 'board' | 'wishlist' | 'questions' | 'archive'

const VIEWS: { key: View; label: string }[] = [
  { key: 'board', label: 'Board' },
  { key: 'wishlist', label: 'Wishlist' },
  { key: 'questions', label: 'Questions' },
  { key: 'archive', label: 'Archive' },
]

function fmtDate(s: string): string {
  return new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function FeedbackPage() {
  const [items, setItems] = useState<FeedbackItem[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<View>('board')

  // Filters
  const [typeFilter, setTypeFilter] = useState<'all' | FeedbackType>('all')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [priorityFilter, setPriorityFilter] = useState<'all' | FeedbackPriority>('all')
  const [search, setSearch] = useState('')

  // Modals
  const [showNew, setShowNew] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dragOverCol, setDragOverCol] = useState<FeedbackStatus | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/feedback')
      const data = await res.json()
      if (Array.isArray(data)) setItems(data)
    } catch (err) {
      console.error('Failed to load feedback', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // ─── Mutations (optimistic) ──────────────────────────────────────────────
  const patchItem = useCallback(async (id: string, updates: Partial<FeedbackItem>) => {
    setItems(prev => prev.map(it => (it.id === id ? { ...it, ...updates } : it)))
    try {
      const res = await fetch('/api/feedback', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...updates }),
      })
      if (!res.ok) throw new Error('patch failed')
      const updated = await res.json()
      setItems(prev => prev.map(it => (it.id === id ? updated : it)))
    } catch (err) {
      console.error('Update failed, reloading', err)
      load()
    }
  }, [load])

  const deleteItem = useCallback(async (id: string) => {
    setItems(prev => prev.filter(it => it.id !== id))
    setDetailId(null)
    try {
      await fetch(`/api/feedback?id=${id}`, { method: 'DELETE' })
    } catch (err) {
      console.error('Delete failed', err)
      load()
    }
  }, [load])

  const createItem = useCallback(async (payload: Partial<FeedbackItem>) => {
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error('create failed')
      const created = await res.json()
      setItems(prev => [...prev, created])
      setShowNew(false)
    } catch (err) {
      console.error('Create failed', err)
      alert('Could not create item. Please try again.')
    }
  }, [])

  const addComment = useCallback(async (itemId: string, body: string, author: string) => {
    try {
      const res = await fetch('/api/feedback/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id: itemId, body, author }),
      })
      if (!res.ok) throw new Error('comment failed')
      const comment = await res.json()
      setItems(prev => prev.map(it =>
        it.id === itemId ? { ...it, comments: [...(it.comments || []), comment] } : it
      ))
    } catch (err) {
      console.error('Comment failed', err)
    }
  }, [])

  // ─── Filtering ───────────────────────────────────────────────────────────
  const matchesFilters = useCallback((it: FeedbackItem) => {
    if (typeFilter !== 'all' && it.item_type !== typeFilter) return false
    if (tagFilter && !it.tags.includes(tagFilter)) return false
    if (priorityFilter !== 'all' && it.priority !== priorityFilter) return false
    if (search.trim()) {
      const q = search.toLowerCase()
      const hay = `${it.title} ${it.description || ''} ${it.tags.join(' ')}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  }, [typeFilter, tagFilter, priorityFilter, search])

  const detailItem = items.find(it => it.id === detailId) || null

  // Counts for the view tabs
  const counts = useMemo(() => ({
    board: items.filter(i => !i.archived && (i.item_type === 'bug' || i.item_type === 'feature')).length,
    wishlist: items.filter(i => i.item_type === 'wishlist' && !i.archived).length,
    questions: items.filter(i => i.item_type === 'question' && !i.archived).length,
    archive: items.filter(i => i.archived).length,
  }), [items])

  // Board: bug/feature, not archived, grouped by status
  const boardItems = useMemo(
    () => items.filter(i =>
      !i.archived && (i.item_type === 'bug' || i.item_type === 'feature') && matchesFilters(i)
    ),
    [items, matchesFilters]
  )

  // Wishlist: same Kanban shape, just wishlist-typed items
  const wishlistBoardItems = useMemo(
    () => items.filter(i => !i.archived && i.item_type === 'wishlist' && matchesFilters(i)),
    [items, matchesFilters]
  )

  return (
    <div className={styles.layout}>
      <Sidebar />
      <main className={styles.main}>
        {/* Header */}
        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>Feedback Board</h1>
            <p className={styles.subtitle}>
              Report bugs, request features, ask questions. Anyone can add an item.
            </p>
          </div>
          <button className={styles.newBtn} onClick={() => setShowNew(true)}>
            + New Item
          </button>
        </header>

        {/* View tabs */}
        <div className={styles.tabs}>
          {VIEWS.map(v => (
            <button
              key={v.key}
              className={view === v.key ? styles.tabActive : styles.tab}
              onClick={() => setView(v.key)}
            >
              {v.label}
              <span className={styles.tabCount}>{counts[v.key]}</span>
            </button>
          ))}
        </div>

        {/* Filter bar */}
        <div className={styles.filterBar}>
          <input
            className={styles.search}
            placeholder="Search…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {view === 'board' && (
            <select className={styles.select} value={typeFilter} onChange={e => setTypeFilter(e.target.value as 'all' | FeedbackType)}>
              <option value="all">All types</option>
              <option value="bug">🐞 Bugs</option>
              <option value="feature">✨ Features</option>
            </select>
          )}
          <select className={styles.select} value={priorityFilter} onChange={e => setPriorityFilter(e.target.value as 'all' | FeedbackPriority)}>
            <option value="all">All priorities</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <div className={styles.tagFilters}>
            <button
              className={tagFilter === null ? styles.tagChipActive : styles.tagChip}
              onClick={() => setTagFilter(null)}
            >All areas</button>
            {AREA_TAGS.map(t => (
              <button
                key={t.key}
                className={tagFilter === t.key ? styles.tagChipActive : styles.tagChip}
                style={tagFilter === t.key ? { background: t.color, borderColor: t.color, color: '#fff' } : { borderColor: t.color, color: t.color }}
                onClick={() => setTagFilter(tagFilter === t.key ? null : t.key)}
              >{t.label}</button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className={styles.empty}>Loading…</div>
        ) : view === 'board' ? (
          <KanbanBoard
            items={boardItems}
            draggedId={draggedId}
            setDraggedId={setDraggedId}
            dragOverCol={dragOverCol}
            setDragOverCol={setDragOverCol}
            onOpen={setDetailId}
            onPatch={patchItem}
          />
        ) : view === 'questions' ? (
          <QuestionList
            items={items.filter(i => i.item_type === 'question' && !i.archived && matchesFilters(i))}
            onOpen={setDetailId}
          />
        ) : view === 'wishlist' ? (
          <>
            <p className={styles.viewNote}>🌟 Wishlist ideas — tracked the same way as bugs/features, just kept off the main board.</p>
            <KanbanBoard
              items={wishlistBoardItems}
              draggedId={draggedId}
              setDraggedId={setDraggedId}
              dragOverCol={dragOverCol}
              setDragOverCol={setDragOverCol}
              onOpen={setDetailId}
              onPatch={patchItem}
            />
          </>
        ) : (
          <ArchiveList
            items={items.filter(i => i.archived && matchesFilters(i))}
            onOpen={setDetailId}
            onRestore={id => patchItem(id, { archived: false })}
          />
        )}
      </main>

      {showNew && <NewItemModal onClose={() => setShowNew(false)} onCreate={createItem} defaultType={view === 'wishlist' ? 'wishlist' : view === 'questions' ? 'question' : 'bug'} />}
      {detailItem && (
        <DetailModal
          item={detailItem}
          onClose={() => setDetailId(null)}
          onPatch={patchItem}
          onDelete={deleteItem}
          onComment={addComment}
        />
      )}
    </div>
  )
}

// ─── Card ───────────────────────────────────────────────────────────────────
function Card({ item, onClick, onDragStart, onArchive }: {
  item: FeedbackItem
  onClick: () => void
  onDragStart: () => void
  onArchive?: () => void
}) {
  const tm = TYPE_META[item.item_type]
  const pm = PRIORITY_META[item.priority]
  return (
    <div
      className={styles.card}
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      style={{ borderLeftColor: tm.color }}
    >
      <div className={styles.cardTop}>
        <span className={styles.refCode}>{refCode(item.seq)}</span>
        <span className={styles.cardType}>{tm.icon} {tm.label}</span>
        <span className={styles.priorityDot} style={{ background: pm.color }} title={pm.label} />
      </div>
      <div className={styles.cardTitle}>{item.title}</div>
      {item.needs_clarification && (
        <div className={styles.clarifyBadge}>⚑ Clarification needed</div>
      )}
      {item.tags.length > 0 && (
        <div className={styles.cardTags}>
          {item.tags.map(t => (
            <span key={t} className={styles.miniTag} style={{ background: tagColor(t) }}>{tagLabel(t)}</span>
          ))}
        </div>
      )}
      <div className={styles.cardFoot}>
        {item.reporter && <span className={styles.reporter}>{item.reporter}</span>}
        {item.image_url && <span className={styles.commentCount} title="Has a screenshot">🖼️</span>}
        {(item.comments?.length ?? 0) > 0 && <span className={styles.commentCount}>💬 {item.comments!.length}</span>}
        {onArchive && (
          <button
            className={styles.archiveBtn}
            onClick={e => { e.stopPropagation(); onArchive() }}
            title="Archive (lift off board)"
          >Archive</button>
        )}
      </div>
    </div>
  )
}

// ─── Questions view ──────────────────────────────────────────────────────────
function QuestionList({ items, onOpen }: { items: FeedbackItem[]; onOpen: (id: string) => void }) {
  if (items.length === 0) return <div className={styles.empty}>No open questions.</div>
  return (
    <div className={styles.qList}>
      {items.map(q => (
        <div key={q.id} className={styles.qItem} onClick={() => onOpen(q.id)}>
          <div className={styles.qHead}>
            <span className={styles.refCode}>{refCode(q.seq)}</span>
            <span className={q.answered ? styles.qAnswered : styles.qOpen}>
              {q.answered ? '✓ Answered' : '○ Open'}
            </span>
            <span className={styles.qTitle}>{q.title}</span>
            {q.needs_clarification && <span className={styles.clarifyPill}>⚑ Clarification</span>}
          </div>
          {q.answer
            ? <div className={styles.qAnswer}>{q.answer}</div>
            : <div className={styles.qNoAnswer}>No answer yet — click to respond.</div>}
        </div>
      ))}
    </div>
  )
}

// ─── Kanban board (used by both the Board view and the Wishlist view) ───────
function KanbanBoard({ items, draggedId, setDraggedId, dragOverCol, setDragOverCol, onOpen, onPatch }: {
  items: FeedbackItem[]
  draggedId: string | null
  setDraggedId: (id: string | null) => void
  dragOverCol: FeedbackStatus | null
  setDragOverCol: (s: FeedbackStatus | null) => void
  onOpen: (id: string) => void
  onPatch: (id: string, u: Partial<FeedbackItem>) => void
}) {
  return (
    <div className={styles.board}>
      {STATUS_COLUMNS.map(col => {
        const colItems = items
          .filter(i => i.status === col.key)
          .sort((a, b) => a.sort_order - b.sort_order)
        return (
          <div
            key={col.key}
            className={dragOverCol === col.key ? styles.columnDragOver : styles.column}
            onDragOver={e => { e.preventDefault(); setDragOverCol(col.key) }}
            onDragLeave={() => setDragOverCol(null)}
            onDrop={() => {
              if (draggedId) onPatch(draggedId, { status: col.key })
              setDraggedId(null)
              setDragOverCol(null)
            }}
          >
            <div className={styles.columnHead}>
              <span className={styles.columnLabel}>{col.label}</span>
              <span className={styles.columnCount}>{colItems.length}</span>
            </div>
            <div className={styles.columnHint}>{col.hint}</div>
            <div className={styles.cards}>
              {colItems.map(it => (
                <Card
                  key={it.id}
                  item={it}
                  onClick={() => onOpen(it.id)}
                  onDragStart={() => setDraggedId(it.id)}
                  onArchive={col.key === 'fix_verified' ? () => onPatch(it.id, { archived: true }) : undefined}
                />
              ))}
              {colItems.length === 0 && <div className={styles.colEmpty}>Drop items here</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Archive view ─────────────────────────────────────────────────────────────
function ArchiveList({ items, onOpen, onRestore }: {
  items: FeedbackItem[]; onOpen: (id: string) => void; onRestore: (id: string) => void
}) {
  if (items.length === 0) return <div className={styles.empty}>Nothing archived yet.</div>
  return (
    <div className={styles.archList}>
      {items.map(it => (
        <div key={it.id} className={styles.archItem}>
          <div className={styles.archMain} onClick={() => onOpen(it.id)}>
            <span className={styles.refCode}>{refCode(it.seq)}</span>
            <span className={styles.archCheck}>✓</span>
            <span className={styles.archTitle}>{it.title}</span>
            <span className={styles.archType}>{TYPE_META[it.item_type].icon}</span>
            {it.tags.map(t => <span key={t} className={styles.miniTag} style={{ background: tagColor(t) }}>{tagLabel(t)}</span>)}
          </div>
          <button className={styles.restoreBtn} onClick={() => onRestore(it.id)}>Restore</button>
        </div>
      ))}
    </div>
  )
}

// ─── New item modal ───────────────────────────────────────────────────────────
function NewItemModal({ onClose, onCreate, defaultType }: {
  onClose: () => void
  onCreate: (p: Partial<FeedbackItem>) => void
  defaultType: FeedbackType
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [itemType, setItemType] = useState<FeedbackType>(defaultType)
  const [priority, setPriority] = useState<FeedbackPriority>('medium')
  const [tags, setTags] = useState<string[]>([])
  const [reporter, setReporter] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const toggleTag = (t: string) => setTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])

  const pickImage = (file: File | null) => {
    setImageFile(file)
    setImagePreviewUrl(prev => {
      if (prev) URL.revokeObjectURL(prev)
      return file ? URL.createObjectURL(file) : null
    })
  }

  const handleCreate = async () => {
    setCreating(true)
    try {
      const image_url = imageFile ? await uploadFeedbackImage(imageFile) : undefined
      onCreate({ title, description, item_type: itemType, priority, tags, reporter, ...(image_url ? { image_url } : {}) })
    } catch {
      alert('Image upload failed — creating the item without it.')
      onCreate({ title, description, item_type: itemType, priority, tags, reporter })
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <h2 className={styles.modalTitle}>New Item</h2>
        <label className={styles.label}>Title *</label>
        <input className={styles.input} value={title} onChange={e => setTitle(e.target.value)} placeholder="Short summary" autoFocus />

        <label className={styles.label}>Details</label>
        <textarea className={styles.textarea} value={description} onChange={e => setDescription(e.target.value)} placeholder="What happened? Steps to reproduce, expected vs actual…" rows={4} />

        <div className={styles.row}>
          <div className={styles.field}>
            <label className={styles.label}>Type</label>
            <select className={styles.input} value={itemType} onChange={e => setItemType(e.target.value as FeedbackType)}>
              <option value="bug">🐞 Bug</option>
              <option value="feature">✨ Feature</option>
              <option value="question">❓ Question</option>
              <option value="wishlist">🌟 Wishlist</option>
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Priority</label>
            <select className={styles.input} value={priority} onChange={e => setPriority(e.target.value as FeedbackPriority)}>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>
        </div>

        <label className={styles.label}>Area tags</label>
        <div className={styles.tagPicker}>
          {AREA_TAGS.map(t => (
            <button
              key={t.key}
              type="button"
              className={tags.includes(t.key) ? styles.tagChipActive : styles.tagChip}
              style={tags.includes(t.key) ? { background: t.color, borderColor: t.color, color: '#fff' } : { borderColor: t.color, color: t.color }}
              onClick={() => toggleTag(t.key)}
            >{t.label}</button>
          ))}
        </div>

        <label className={styles.label}>Your name (optional)</label>
        <input className={styles.input} value={reporter} onChange={e => setReporter(e.target.value)} placeholder="e.g. Alisa" />

        <label className={styles.label}>Screenshot (optional)</label>
        {imagePreviewUrl ? (
          <div className={styles.imagePreviewWrap}>
            <img src={imagePreviewUrl} alt="Attached screenshot" className={styles.imagePreview} />
            <button type="button" className={styles.imageRemoveBtn} onClick={() => pickImage(null)}>Remove</button>
          </div>
        ) : (
          <input type="file" accept="image/*" className={styles.input} onChange={e => pickImage(e.target.files?.[0] || null)} />
        )}

        <div className={styles.modalActions}>
          <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button
            className={styles.saveBtn}
            disabled={!title.trim() || creating}
            onClick={handleCreate}
          >{creating ? 'Uploading…' : 'Create'}</button>
        </div>
      </div>
    </div>
  )
}

// ─── Detail modal ─────────────────────────────────────────────────────────────
function DetailModal({ item, onClose, onPatch, onDelete, onComment }: {
  item: FeedbackItem
  onClose: () => void
  onPatch: (id: string, u: Partial<FeedbackItem>) => void
  onDelete: (id: string) => void
  onComment: (id: string, body: string, author: string) => void
}) {
  const [answer, setAnswer] = useState(item.answer || '')
  const [comment, setComment] = useState('')
  const [author, setAuthor] = useState('')
  const [uploadingImage, setUploadingImage] = useState(false)
  const tm = TYPE_META[item.item_type]

  const handleImagePick = async (file: File | null) => {
    if (!file) return
    setUploadingImage(true)
    try {
      const image_url = await uploadFeedbackImage(file)
      onPatch(item.id, { image_url })
    } catch {
      alert('Image upload failed.')
    } finally {
      setUploadingImage(false)
    }
  }

  const handleImageRemove = async () => {
    if (item.image_url) await deleteFeedbackImage(item.image_url)
    onPatch(item.id, { image_url: null })
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modalWide} onClick={e => e.stopPropagation()}>
        <div className={styles.detailHead}>
          <span className={styles.detailRefCode}>{refCode(item.seq)}</span>
          <span className={styles.cardType} style={{ color: tm.color }}>{tm.icon} {tm.label}</span>
          <button
            className={item.needs_clarification ? styles.clarifyToggleOn : styles.clarifyToggle}
            onClick={() => onPatch(item.id, { needs_clarification: !item.needs_clarification })}
            title="Flag for the client: not a confirmed code defect — needs an answer or confirmation"
          >⚑ {item.needs_clarification ? 'Clarification needed' : 'Flag clarification'}</button>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <h2 className={styles.detailTitle}>{item.title}</h2>
        {item.description && <p className={styles.detailDesc}>{item.description}</p>}
        {item.code_refs && <div className={styles.codeRefs}><strong>Code:</strong> {item.code_refs}</div>}

        <label className={styles.label}>Screenshot</label>
        {item.image_url ? (
          <div className={styles.imagePreviewWrap}>
            <a href={item.image_url} target="_blank" rel="noreferrer">
              <img src={item.image_url} alt="Attached screenshot" className={styles.imagePreview} />
            </a>
            <button type="button" className={styles.imageRemoveBtn} onClick={handleImageRemove}>Remove</button>
          </div>
        ) : (
          <input type="file" accept="image/*" className={styles.input} disabled={uploadingImage} onChange={e => handleImagePick(e.target.files?.[0] || null)} />
        )}

        <div className={styles.detailMeta}>
          {/* Status mover (Kanban-tracked types only — not questions) */}
          {(item.item_type === 'bug' || item.item_type === 'feature' || item.item_type === 'wishlist') && (
            <div className={styles.field}>
              <label className={styles.label}>Status</label>
              <select className={styles.input} value={item.status} onChange={e => onPatch(item.id, { status: e.target.value as FeedbackStatus })}>
                {STATUS_COLUMNS.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </div>
          )}
          <div className={styles.field}>
            <label className={styles.label}>Priority</label>
            <select className={styles.input} value={item.priority} onChange={e => onPatch(item.id, { priority: e.target.value as FeedbackPriority })}>
              {Object.entries(PRIORITY_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Type</label>
            <select className={styles.input} value={item.item_type} onChange={e => onPatch(item.id, { item_type: e.target.value as FeedbackType })}>
              {Object.entries(TYPE_META).map(([k, v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
            </select>
          </div>
        </div>

        <label className={styles.label}>Area tags</label>
        <div className={styles.tagPicker}>
          {AREA_TAGS.map(t => {
            const on = item.tags.includes(t.key)
            return (
              <button key={t.key} type="button"
                className={on ? styles.tagChipActive : styles.tagChip}
                style={on ? { background: t.color, borderColor: t.color, color: '#fff' } : { borderColor: t.color, color: t.color }}
                onClick={() => onPatch(item.id, { tags: on ? item.tags.filter(x => x !== t.key) : [...item.tags, t.key] })}
              >{t.label}</button>
            )
          })}
        </div>

        {/* Answer box for questions */}
        {item.item_type === 'question' && (
          <div className={styles.answerBox}>
            <label className={styles.label}>Answer</label>
            <textarea className={styles.textarea} value={answer} onChange={e => setAnswer(e.target.value)} rows={3} placeholder="Type the answer…" />
            <div className={styles.answerActions}>
              <label className={styles.checkLabel}>
                <input type="checkbox" checked={item.answered} onChange={e => onPatch(item.id, { answered: e.target.checked })} />
                Mark answered
              </label>
              <button className={styles.saveBtn} onClick={() => onPatch(item.id, { answer })}>Save answer</button>
            </div>
          </div>
        )}

        {/* Comments */}
        <div className={styles.comments}>
          <label className={styles.label}>Discussion</label>
          {(item.comments || []).map(c => (
            <div key={c.id} className={styles.comment}>
              <div className={styles.commentMeta}>{c.author || 'Anonymous'} · {fmtDate(c.created_at)}</div>
              <div className={styles.commentBody}>{c.body}</div>
            </div>
          ))}
          {(item.comments?.length ?? 0) === 0 && <div className={styles.noComments}>No comments yet.</div>}
          <div className={styles.commentForm}>
            <input className={styles.commentAuthor} placeholder="Name" value={author} onChange={e => setAuthor(e.target.value)} />
            <input
              className={styles.commentInput}
              placeholder="Add a comment…"
              value={comment}
              onChange={e => setComment(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && comment.trim()) { onComment(item.id, comment, author); setComment('') } }}
            />
            <button className={styles.saveBtn} disabled={!comment.trim()} onClick={() => { onComment(item.id, comment, author); setComment('') }}>Post</button>
          </div>
        </div>

        <div className={styles.detailFooter}>
          <span className={styles.detailDate}>Filed {fmtDate(item.created_at)}{item.reporter ? ` by ${item.reporter}` : ''}</span>
          <div className={styles.detailFooterActions}>
            {!item.archived
              ? <button className={styles.archiveBtn} onClick={() => onPatch(item.id, { archived: true })}>Archive</button>
              : <button className={styles.archiveBtn} onClick={() => onPatch(item.id, { archived: false })}>Restore</button>}
            <button className={styles.deleteBtn} onClick={() => { if (confirm('Delete this item permanently?')) onDelete(item.id) }}>Delete</button>
          </div>
        </div>
      </div>
    </div>
  )
}
