'use client'

import { useState, useEffect, useMemo } from 'react'
import { Platform, PlatformEvent } from '@/lib/types'
import { format, parseISO } from 'date-fns'
import styles from './PlatformSettings.module.css'

interface PlatformSettingsProps {
  isOpen: boolean
  onClose: () => void
  onEventsChange?: () => void
}

type Tab = 'events' | 'rules'

const EVENT_TYPES = [
  { value: 'seasonal', label: 'Seasonal Sale' },
  { value: 'thirdparty', label: '3rd Party Event' },
  { value: 'invitational', label: 'Invitational' },
  { value: 'festival', label: 'Festival' },
  { value: 'custom', label: 'Custom' }
]

// Preset colors for quick selection
const PRESET_COLORS = [
  { hex: '#1b2838', name: 'Steam Dark' },
  { hex: '#66c0f4', name: 'Steam Blue' },
  { hex: '#003791', name: 'PlayStation Blue' },
  { hex: '#107c10', name: 'Xbox Green' },
  { hex: '#e60012', name: 'Nintendo Red' },
  { hex: '#2f2f2f', name: 'Epic Dark' },
  { hex: '#6441a5', name: 'GOG Purple' },
  { hex: '#cc3333', name: 'Humble Red' },
  { hex: '#ff6600', name: 'Fanatical Orange' },
  { hex: '#00adef', name: 'Cyan' },
  { hex: '#f59e0b', name: 'Amber' },
  { hex: '#8b5cf6', name: 'Violet' },
  { hex: '#ec4899', name: 'Pink' },
  { hex: '#14b8a6', name: 'Teal' },
  { hex: '#84cc16', name: 'Lime' },
  { hex: '#f97316', name: 'Orange' },
]

// Check if two colors are too similar (simple luminance comparison)
function getColorLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  return 0.299 * r + 0.587 * g + 0.114 * b
}

function colorDistance(hex1: string, hex2: string): number {
  const r1 = parseInt(hex1.slice(1, 3), 16)
  const g1 = parseInt(hex1.slice(3, 5), 16)
  const b1 = parseInt(hex1.slice(5, 7), 16)
  const r2 = parseInt(hex2.slice(1, 3), 16)
  const g2 = parseInt(hex2.slice(3, 5), 16)
  const b2 = parseInt(hex2.slice(5, 7), 16)
  return Math.sqrt(Math.pow(r1 - r2, 2) + Math.pow(g1 - g2, 2) + Math.pow(b1 - b2, 2))
}

export default function PlatformSettings({ isOpen, onClose, onEventsChange }: PlatformSettingsProps) {
  const [activeTab, setActiveTab] = useState<Tab>('events')
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [events, setEvents] = useState<PlatformEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  
  // Event form state
  const [editingEvent, setEditingEvent] = useState<PlatformEvent | null>(null)
  const [showEventForm, setShowEventForm] = useState(false)
  const [eventForm, setEventForm] = useState({
    platform_id: '',
    name: '',
    start_date: '',
    end_date: '',
    event_type: 'custom' as PlatformEvent['event_type'],
    region: '',
    requires_cooldown: true,
    is_recurring: false,
    notes: ''
  })
  
  // Platform editing state
  const [editingPlatform, setEditingPlatform] = useState<Platform | null>(null)
  const [hexInput, setHexInput] = useState('')
  
  useEffect(() => {
    if (isOpen) {
      fetchData()
    }
  }, [isOpen])
  
  // Sync hex input when editing platform changes
  useEffect(() => {
    if (editingPlatform) {
      setHexInput(editingPlatform.color_hex.toUpperCase())
    }
  }, [editingPlatform?.id])
  
  // Check for similar colors
  const similarColors = useMemo(() => {
    if (!editingPlatform) return []
    const otherPlatforms = platforms.filter(p => p.id !== editingPlatform.id)
    return otherPlatforms.filter(p => {
      const distance = colorDistance(editingPlatform.color_hex, p.color_hex)
      return distance < 80 // Threshold for "similar" colors
    })
  }, [editingPlatform?.color_hex, platforms])
  
  const fetchData = async () => {
    setLoading(true)
    try {
      const [platformsRes, eventsRes] = await Promise.all([
        fetch('/api/platforms'),
        fetch('/api/platform-events')
      ])
      
      if (platformsRes.ok) {
        const platformData = await platformsRes.json()
        setPlatforms(platformData)
      }
      
      if (eventsRes.ok) {
        const eventData = await eventsRes.json()
        setEvents(eventData)
      }
    } catch (err) {
      setError('Failed to load data')
    } finally {
      setLoading(false)
    }
  }
  
  const handleSaveEvent = async () => {
    setSaving(true)
    setError(null)
    
    try {
      const url = '/api/platform-events'
      const method = editingEvent ? 'PUT' : 'POST'
      const body = editingEvent 
        ? { id: editingEvent.id, ...eventForm }
        : eventForm
      
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to save event')
      }
      
      await fetchData()
      setShowEventForm(false)
      setEditingEvent(null)
      resetEventForm()
      onEventsChange?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save event')
    } finally {
      setSaving(false)
    }
  }
  
  const handleDeleteEvent = async (eventId: string) => {
    if (!confirm('Are you sure you want to delete this event?')) return
    
    setSaving(true)
    try {
      const res = await fetch(`/api/platform-events?id=${eventId}`, {
        method: 'DELETE'
      })
      
      if (!res.ok) throw new Error('Failed to delete event')
      
      await fetchData()
      onEventsChange?.()
    } catch (err) {
      setError('Failed to delete event')
    } finally {
      setSaving(false)
    }
  }
  
  const handleEditEvent = (event: PlatformEvent) => {
    setEditingEvent(event)
    setEventForm({
      platform_id: event.platform_id,
      name: event.name,
      start_date: event.start_date,
      end_date: event.end_date,
      event_type: event.event_type,
      region: event.region || '',
      requires_cooldown: event.requires_cooldown,
      is_recurring: event.is_recurring,
      notes: event.notes || ''
    })
    setShowEventForm(true)
  }
  
  const resetEventForm = () => {
    setEventForm({
      platform_id: '',
      name: '',
      start_date: '',
      end_date: '',
      event_type: 'custom',
      region: '',
      requires_cooldown: true,
      is_recurring: false,
      notes: ''
    })
  }

  const handleColorChange = (newColor: string) => {
    if (!editingPlatform) return
    setEditingPlatform({ ...editingPlatform, color_hex: newColor })
    setHexInput(newColor.toUpperCase())
  }
  
  const handleHexInputChange = (value: string) => {
    setHexInput(value.toUpperCase())
    // Validate and apply if it's a valid hex color
    if (/^#[0-9A-F]{6}$/i.test(value)) {
      if (editingPlatform) {
        setEditingPlatform({ ...editingPlatform, color_hex: value })
      }
    }
  }
  
  const handleSavePlatform = async () => {
    if (!editingPlatform) return
    
    setSaving(true)
    setError(null)
    
    try {
      const res = await fetch('/api/platforms', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingPlatform)
      })
      
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to save platform')
      }
      
      await fetchData()
      setEditingPlatform(null)
      onEventsChange?.() // Refresh parent to update colors
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save platform')
    } finally {
      setSaving(false)
    }
  }
  
  if (!isOpen) return null
  
  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <h2>Platform Settings</h2>
          <button className={styles.closeButton} onClick={onClose}>×</button>
        </div>
        
        <div className={styles.tabs}>
          <button 
            className={`${styles.tab} ${activeTab === 'events' ? styles.activeTab : ''}`}
            onClick={() => setActiveTab('events')}
          >
            📅 Platform Events
          </button>
          <button 
            className={`${styles.tab} ${activeTab === 'rules' ? styles.activeTab : ''}`}
            onClick={() => setActiveTab('rules')}
          >
            ⚙️ Platform Rules
          </button>
        </div>
        
        {error && <div className={styles.error}>{error}</div>}
        
        <div className={styles.content}>
          {loading ? (
            <div className={styles.loading}>Loading...</div>
          ) : activeTab === 'events' ? (
            <div className={styles.eventsTab}>
              <div className={styles.sectionHeader}>
                <h3>Upcoming Platform Events</h3>
                <p className={styles.subtitle}>
                  Add seasonal sales, festivals, and platform-specific events that will appear on the timeline.
                </p>
                <button 
                  className={styles.addButton}
                  onClick={() => {
                    setEditingEvent(null)
                    resetEventForm()
                    setShowEventForm(true)
                  }}
                >
                  + Add Event
                </button>
              </div>
              
              {showEventForm && (
                <div className={styles.eventForm}>
                  <h4>{editingEvent ? 'Edit Event' : 'New Event'}</h4>
                  
                  <div className={styles.formGrid}>
                    <div className={styles.formGroup}>
                      <label>Platform</label>
                      <select
                        value={eventForm.platform_id}
                        onChange={e => setEventForm(prev => ({ ...prev, platform_id: e.target.value }))}
                      >
                        <option value="">Select platform...</option>
                        {platforms.map(p => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </div>
                    
                    <div className={styles.formGroup}>
                      <label>Event Type</label>
                      <select
                        value={eventForm.event_type}
                        onChange={e => setEventForm(prev => ({ ...prev, event_type: e.target.value as PlatformEvent['event_type'] }))}
                      >
                        {EVENT_TYPES.map(t => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </select>
                    </div>
                    
                    <div className={styles.formGroup} style={{ gridColumn: '1 / -1' }}>
                      <label>Event Name</label>
                      <input
                        type="text"
                        value={eventForm.name}
                        onChange={e => setEventForm(prev => ({ ...prev, name: e.target.value }))}
                        placeholder="e.g., Steam Winter Sale, Detective Fest"
                      />
                    </div>
                    
                    <div className={styles.formGroup}>
                      <label>Start Date</label>
                      <input
                        type="date"
                        value={eventForm.start_date}
                        onChange={e => setEventForm(prev => ({ ...prev, start_date: e.target.value }))}
                      />
                    </div>
                    
                    <div className={styles.formGroup}>
                      <label>End Date</label>
                      <input
                        type="date"
                        value={eventForm.end_date}
                        onChange={e => setEventForm(prev => ({ ...prev, end_date: e.target.value }))}
                      />
                    </div>
                    
                    <div className={styles.formGroup}>
                      <label>Region (optional)</label>
                      <input
                        type="text"
                        value={eventForm.region}
                        onChange={e => setEventForm(prev => ({ ...prev, region: e.target.value }))}
                        placeholder="e.g., NOE, NOA, Asia"
                      />
                    </div>
                    
                    <div className={styles.formGroup}>
                      <label className={styles.checkboxLabel}>
                        <input
                          type="checkbox"
                          checked={eventForm.requires_cooldown}
                          onChange={e => setEventForm(prev => ({ ...prev, requires_cooldown: e.target.checked }))}
                        />
                        Requires cooldown after
                      </label>
                    </div>
                    
                    <div className={styles.formGroup} style={{ gridColumn: '1 / -1' }}>
                      <label>Notes</label>
                      <textarea
                        value={eventForm.notes}
                        onChange={e => setEventForm(prev => ({ ...prev, notes: e.target.value }))}
                        placeholder="Additional details about this event..."
                        rows={2}
                      />
                    </div>
                  </div>
                  
                  <div className={styles.formActions}>
                    <button 
                      className={styles.cancelButton}
                      onClick={() => {
                        setShowEventForm(false)
                        setEditingEvent(null)
                      }}
                    >
                      Cancel
                    </button>
                    <button 
                      className={styles.saveButton}
                      onClick={handleSaveEvent}
                      disabled={saving || !eventForm.platform_id || !eventForm.name || !eventForm.start_date || !eventForm.end_date}
                    >
                      {saving ? 'Saving...' : editingEvent ? 'Update Event' : 'Add Event'}
                    </button>
                  </div>
                </div>
              )}
              
              <div className={styles.eventsList}>
                {events.length === 0 ? (
                  <p className={styles.emptyState}>No events added yet. Add platform events to see them on the timeline.</p>
                ) : (
                  events.map(event => (
                    <div key={event.id} className={styles.eventCard}>
                      <div 
                        className={styles.eventColor}
                        style={{ backgroundColor: event.platform?.color_hex || '#666' }}
                      />
                      <div className={styles.eventInfo}>
                        <div className={styles.eventName}>{event.name}</div>
                        <div className={styles.eventMeta}>
                          <span className={styles.eventPlatform}>{event.platform?.name}</span>
                          <span className={styles.eventDates}>
                            {format(parseISO(event.start_date), 'MMM d')} - {format(parseISO(event.end_date), 'MMM d, yyyy')}
                          </span>
                          <span className={styles.eventType}>{event.event_type}</span>
                          {event.region && <span className={styles.eventRegion}>{event.region}</span>}
                          {!event.requires_cooldown && <span className={styles.noCooldown}>No cooldown</span>}
                        </div>
                      </div>
                      <div className={styles.eventActions}>
                        <button onClick={() => handleEditEvent(event)}>Edit</button>
                        <button className={styles.deleteBtn} onClick={() => handleDeleteEvent(event.id)}>Delete</button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : (
            <div className={styles.rulesTab}>
              <div className={styles.sectionHeader}>
                <h3>Platform Rules Configuration</h3>
                <p className={styles.subtitle}>
                  Edit cooldown periods, max sale days, colors, and other platform-specific rules. Changes affect validation for all clients.
                </p>
              </div>
              
              {editingPlatform ? (
                <div className={styles.platformEditForm}>
                  <h4>
                    <span 
                      className={styles.platformColorDot}
                      style={{ backgroundColor: editingPlatform.color_hex }}
                    />
                    Editing: {editingPlatform.name}
                  </h4>
                  
                  <div className={styles.formGrid}>
                    <div className={styles.formGroup}>
                      <label>Cooldown Days</label>
                      <input
                        type="number"
                        value={editingPlatform.cooldown_days}
                        onChange={e => setEditingPlatform(prev => prev ? { ...prev, cooldown_days: parseInt(e.target.value) || 0 } : null)}
                        min="0"
                      />
                    </div>
                    
                    <div className={styles.formGroup}>
                      <label>Max Sale Days</label>
                      <input
                        type="number"
                        value={editingPlatform.max_sale_days}
                        onChange={e => setEditingPlatform(prev => prev ? { ...prev, max_sale_days: parseInt(e.target.value) || 14 } : null)}
                        min="1"
                      />
                    </div>
                    
                    <div className={styles.formGroup}>
                      <label>Typical Start Day</label>
                      <select
                        value={editingPlatform.typical_start_day || ''}
                        onChange={e => setEditingPlatform(prev => prev ? { ...prev, typical_start_day: e.target.value || null } : null)}
                      >
                        <option value="">Any day</option>
                        <option value="Monday">Monday</option>
                        <option value="Tuesday">Tuesday</option>
                        <option value="Wednesday">Wednesday</option>
                        <option value="Thursday">Thursday</option>
                        <option value="Friday">Friday</option>
                      </select>
                    </div>
                    
                    <div className={styles.formGroup}>
                      <label>Submission Lead Days</label>
                      <input
                        type="number"
                        value={editingPlatform.submission_lead_days || 14}
                        onChange={e => setEditingPlatform(prev => prev ? { ...prev, submission_lead_days: parseInt(e.target.value) || 14 } : null)}
                        min="1"
                      />
                    </div>
                    
                    {/* Enhanced Color Picker */}
                    <div className={styles.formGroup} style={{ gridColumn: '1 / -1' }}>
                      <label>Platform Color</label>
                      <div className={styles.colorPickerSection}>
                        <div className={styles.colorPickerMain}>
                          <div className={styles.colorInputGroup}>
                            <input
                              type="color"
                              value={editingPlatform.color_hex}
                              onChange={e => handleColorChange(e.target.value)}
                              className={styles.colorInput}
                            />
                            <div 
                              className={styles.colorPreview}
                              style={{ backgroundColor: editingPlatform.color_hex }}
                            >
                              <span className={styles.colorPreviewText} style={{
                                color: getColorLuminance(editingPlatform.color_hex) > 0.5 ? '#000' : '#fff'
                              }}>
                                {editingPlatform.name}
                              </span>
                            </div>
                          </div>
                          <div className={styles.hexInputGroup}>
                            <label>Hex Code:</label>
                            <input
                              type="text"
                              value={hexInput}
                              onChange={e => handleHexInputChange(e.target.value)}
                              placeholder="#000000"
                              className={styles.hexTextInput}
                              maxLength={7}
                            />
                          </div>
                        </div>
                        
                        {/* Preset Colors */}
                        <div className={styles.presetColors}>
                          <label>Quick Select:</label>
                          <div className={styles.presetGrid}>
                            {PRESET_COLORS.map(color => (
                              <button
                                key={color.hex}
                                className={`${styles.presetColor} ${editingPlatform.color_hex === color.hex ? styles.presetColorActive : ''}`}
                                style={{ backgroundColor: color.hex }}
                                onClick={() => handleColorChange(color.hex)}
                                title={color.name}
                              />
                            ))}
                          </div>
                        </div>
                        
                        {/* Similar Colors Warning */}
                        {similarColors.length > 0 && (
                          <div className={styles.colorWarning}>
                            <span className={styles.warningIcon}>⚠️</span>
                            <span>
                              This color is similar to: {similarColors.map(p => p.name).join(', ')}. 
                              Consider choosing a more distinct color for better visibility.
                            </span>
                          </div>
                        )}
                        
                        {/* Color Comparison */}
                        <div className={styles.colorComparison}>
                          <label>Compare with other platforms:</label>
                          <div className={styles.comparisonGrid}>
                            {platforms.filter(p => p.id !== editingPlatform.id).map(p => (
                              <div key={p.id} className={styles.comparisonItem}>
                                <span 
                                  className={styles.comparisonColor}
                                  style={{ backgroundColor: p.color_hex }}
                                />
                                <span className={styles.comparisonName}>{p.name}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                    
                    <div className={styles.formGroup}>
                      <label className={styles.checkboxLabel}>
                        <input
                          type="checkbox"
                          checked={editingPlatform.approval_required}
                          onChange={e => setEditingPlatform(prev => prev ? { ...prev, approval_required: e.target.checked } : null)}
                        />
                        Requires approval
                      </label>
                    </div>
                    
                    <div className={styles.formGroup}>
                      <label className={styles.checkboxLabel}>
                        <input
                          type="checkbox"
                          checked={editingPlatform.special_sales_no_cooldown}
                          onChange={e => setEditingPlatform(prev => prev ? { ...prev, special_sales_no_cooldown: e.target.checked } : null)}
                        />
                        Special/Seasonal sales skip cooldown
                      </label>
                    </div>
                    
                    <div className={styles.formGroup} style={{ gridColumn: '1 / -1' }}>
                      <label>Notes / Rules Documentation</label>
                      <textarea
                        value={editingPlatform.notes || ''}
                        onChange={e => setEditingPlatform(prev => prev ? { ...prev, notes: e.target.value } : null)}
                        placeholder="Document platform-specific rules, quirks, and requirements..."
                        rows={4}
                      />
                    </div>
                  </div>
                  
                  <div className={styles.formActions}>
                    <button 
                      className={styles.cancelButton}
                      onClick={() => setEditingPlatform(null)}
                    >
                      Cancel
                    </button>
                    <button 
                      className={styles.saveButton}
                      onClick={handleSavePlatform}
                      disabled={saving}
                    >
                      {saving ? 'Saving...' : 'Save Changes'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className={styles.platformsList}>
                  {platforms.map(platform => (
                    <div key={platform.id} className={styles.platformCard}>
                      <div 
                        className={styles.platformColorBar}
                        style={{ backgroundColor: platform.color_hex }}
                      />
                      <div className={styles.platformInfo}>
                        <div className={styles.platformName}>{platform.name}</div>
                        <div className={styles.platformRules}>
                          <span>Cooldown: <strong>{platform.cooldown_days} days</strong></span>
                          <span>Max sale: <strong>{platform.max_sale_days} days</strong></span>
                          {platform.typical_start_day && (
                            <span>Starts: <strong>{platform.typical_start_day}</strong></span>
                          )}
                          {platform.approval_required && <span className={styles.approvalBadge}>Approval required</span>}
                          {platform.special_sales_no_cooldown && <span className={styles.noCooldownBadge}>Seasonal skip cooldown</span>}
                        </div>
                        {platform.notes && (
                          <div className={styles.platformNotes}>{platform.notes}</div>
                        )}
                      </div>
                      <button 
                        className={styles.editButton}
                        onClick={() => setEditingPlatform(platform)}
                      >
                        Edit
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
