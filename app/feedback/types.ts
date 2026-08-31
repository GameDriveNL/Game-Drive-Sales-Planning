// Shared types for the in-app feedback / Kanban board.

export type FeedbackType = 'bug' | 'feature' | 'question' | 'wishlist'

export type FeedbackStatus =
  | 'backlogged'
  | 'clarification_needed'
  | 'in_development'
  | 'tested_pending_review'
  | 'fix_verified'

export type FeedbackPriority = 'low' | 'medium' | 'high' | 'critical'

export interface FeedbackComment {
  id: string
  item_id: string
  author: string | null
  body: string
  created_at: string
}

export interface FeedbackItem {
  id: string
  seq: number
  needs_clarification: boolean
  title: string
  description: string | null
  item_type: FeedbackType
  status: FeedbackStatus
  priority: FeedbackPriority
  tags: string[]
  archived: boolean
  answer: string | null
  answered: boolean
  reporter: string | null
  source: string
  code_refs: string | null
  image_url: string | null
  sort_order: number
  created_at: string
  updated_at: string
  comments?: FeedbackComment[]
}

// The five Kanban columns, in flow order. fix_verified is the terminal column;
// from there an item can be archived (lifted off the board).
export const STATUS_COLUMNS: { key: FeedbackStatus; label: string; hint: string }[] = [
  { key: 'backlogged', label: 'Backlogged', hint: 'Reported, not started' },
  { key: 'clarification_needed', label: 'Clarification Needed', hint: 'Blocked on a decision or answer from you' },
  { key: 'in_development', label: 'In Development', hint: 'Being worked on' },
  { key: 'tested_pending_review', label: 'Tested — Pending Review', hint: 'Fixed, awaiting your check' },
  { key: 'fix_verified', label: 'Fix Verified', hint: 'Confirmed working' },
]

export const TYPE_META: Record<FeedbackType, { label: string; icon: string; color: string }> = {
  bug: { label: 'Bug', icon: '🐞', color: '#ef4444' },
  feature: { label: 'Feature', icon: '✨', color: '#8b5cf6' },
  question: { label: 'Question', icon: '❓', color: '#f59e0b' },
  wishlist: { label: 'Wishlist', icon: '🌟', color: '#0ea5e9' },
}

export const PRIORITY_META: Record<FeedbackPriority, { label: string; color: string }> = {
  critical: { label: 'Critical', color: '#dc2626' },
  high: { label: 'High', color: '#f97316' },
  medium: { label: 'Medium', color: '#3b82f6' },
  low: { label: 'Low', color: '#94a3b8' },
}

// Area tags used for filtering. Anyone can also free-type new tags on an item.
export const AREA_TAGS: { key: string; label: string; color: string }[] = [
  { key: 'sales-timeline', label: 'Sales Timeline', color: '#6366f1' },
  { key: 'sales-analysis', label: 'Sales Analysis', color: '#0891b2' },
  { key: 'analytics', label: 'Analytics', color: '#0d9488' },
  { key: 'pr-coverage', label: 'PR Coverage', color: '#db2777' },
  { key: 'reports', label: 'Reports', color: '#7c3aed' },
  { key: 'data-entry', label: 'Data Entry', color: '#ca8a04' },
  { key: 'calendar-generation', label: 'Calendar Generation', color: '#ea580c' },
  { key: 'dashboard', label: 'Dashboard', color: '#2563eb' },
  { key: 'general', label: 'General', color: '#64748b' },
]

// Human-friendly reference code, e.g. GD-007 — used to reference items beyond their title.
export function refCode(seq: number | null | undefined): string {
  if (!seq && seq !== 0) return 'GD-—'
  return 'GD-' + String(seq).padStart(3, '0')
}

export function tagColor(tag: string): string {
  return AREA_TAGS.find(t => t.key === tag)?.color || '#64748b'
}

export function tagLabel(tag: string): string {
  return AREA_TAGS.find(t => t.key === tag)?.label || tag
}
