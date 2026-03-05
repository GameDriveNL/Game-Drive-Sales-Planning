'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import Link from 'next/link'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import { Sidebar } from '../../components/Sidebar'
import { useAuth } from '@/lib/auth-context'
import { CoverageKeyword, KeywordType, Client, Game } from '@/lib/types'

export default function KeywordsPage() {
  const { hasAccess, loading: authLoading } = useAuth()
  const canView = hasAccess('pr_coverage', 'view')
  const canEdit = hasAccess('pr_coverage', 'edit')

  // Data
  const [keywords, setKeywords] = useState<CoverageKeyword[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [games, setGames] = useState<Game[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // Filters
  const [selectedClientId, setSelectedClientId] = useState('')
  const [selectedGameId, setSelectedGameId] = useState('')
  const [typeFilter, setTypeFilter] = useState<'' | KeywordType>('')

  // Add keyword form
  const [newKeyword, setNewKeyword] = useState('')
  const [newType, setNewType] = useState<KeywordType>('whitelist')
  const [adding, setAdding] = useState(false)

  // Bulk import
  const [showImport, setShowImport] = useState(false)
  const [importText, setImportText] = useState('')
  const [importType, setImportType] = useState<KeywordType>('whitelist')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<string | null>(null)

  // Editing
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  const supabase = createClientComponentClient()

  // Fetch clients and games
  useEffect(() => {
    async function fetchMeta() {
      try {
        const [clientsRes, gamesRes] = await Promise.all([
          supabase.from('clients').select('*').order('name'),
          supabase.from('games').select('*').order('name')
        ])
        if (clientsRes.data) {
          setClients(clientsRes.data)
          if (clientsRes.data.length > 0 && !selectedClientId) {
            setSelectedClientId(clientsRes.data[0].id)
          }
        }
        if (gamesRes.data) {
          setGames(gamesRes.data)
        }
      } catch (err) {
        console.error('Failed to fetch clients/games:', err)
      }
    }
    if (canView) fetchMeta()
  }, [canView])

  // Filter games for selected client
  const filteredGames = useMemo(() => {
    if (!selectedClientId) return games
    return games.filter(g => g.client_id === selectedClientId)
  }, [games, selectedClientId])

  // Auto-select first game when client changes
  useEffect(() => {
    if (filteredGames.length > 0) {
      setSelectedGameId(filteredGames[0].id)
    } else {
      setSelectedGameId('')
    }
  }, [selectedClientId, filteredGames])

  // Fetch keywords when filters change
  const fetchKeywords = useCallback(async () => {
    if (!selectedClientId || !selectedGameId) {
      setKeywords([])
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    try {
      const params = new URLSearchParams({
        client_id: selectedClientId,
        game_id: selectedGameId
      })
      if (typeFilter) params.set('keyword_type', typeFilter)

      const res = await fetch(`/api/coverage-keywords?${params}`)
      if (res.ok) {
        const data = await res.json()
        setKeywords(data)
      }
    } catch (err) {
      console.error('Failed to fetch keywords:', err)
    }
    setIsLoading(false)
  }, [selectedClientId, selectedGameId, typeFilter])

  useEffect(() => {
    if (canView) fetchKeywords()
  }, [canView, fetchKeywords])

  // Counts
  const whitelistCount = keywords.filter(k => k.keyword_type === 'whitelist').length
  const blacklistCount = keywords.filter(k => k.keyword_type === 'blacklist').length

  // Add a single keyword
  const handleAdd = async () => {
    if (!newKeyword.trim() || !selectedClientId || !selectedGameId) return
    setAdding(true)
    try {
      const res = await fetch('/api/coverage-keywords', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: selectedClientId,
          game_id: selectedGameId,
          keyword: newKeyword.trim(),
          keyword_type: newType
        })
      })
      if (res.ok) {
        setNewKeyword('')
        fetchKeywords()
      }
    } catch (err) {
      console.error('Add keyword failed:', err)
    }
    setAdding(false)
  }

  // Toggle keyword type
  const handleToggleType = async (kw: CoverageKeyword) => {
    const newKwType = kw.keyword_type === 'whitelist' ? 'blacklist' : 'whitelist'
    try {
      await fetch('/api/coverage-keywords', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: kw.id, keyword_type: newKwType })
      })
      fetchKeywords()
    } catch (err) {
      console.error('Toggle type failed:', err)
    }
  }

  // Edit keyword text
  const handleSaveEdit = async (id: string) => {
    if (!editValue.trim()) return
    try {
      await fetch('/api/coverage-keywords', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, keyword: editValue.trim() })
      })
      setEditingId(null)
      fetchKeywords()
    } catch (err) {
      console.error('Edit keyword failed:', err)
    }
  }

  // Delete keyword
  const handleDelete = async (id: string) => {
    try {
      await fetch(`/api/coverage-keywords?id=${id}`, { method: 'DELETE' })
      fetchKeywords()
    } catch (err) {
      console.error('Delete keyword failed:', err)
    }
  }

  // Bulk import
  const handleBulkImport = async () => {
    if (!importText.trim() || !selectedClientId || !selectedGameId) return
    setImporting(true)
    setImportResult(null)

    const lines = importText.trim().split('\n')
    const keywords = lines
      .map(line => line.trim())
      .filter(Boolean)
      .map(keyword => ({
        client_id: selectedClientId,
        game_id: selectedGameId,
        keyword,
        keyword_type: importType
      }))

    try {
      const res = await fetch('/api/coverage-keywords', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(keywords)
      })
      const json = await res.json()
      if (res.ok) {
        setImportResult(`Imported ${json.imported || keywords.length} keywords.`)
        setImportText('')
        setShowImport(false)
        fetchKeywords()
      } else {
        setImportResult(`Error: ${json.error}`)
      }
    } catch {
      setImportResult('Network error during import')
    }
    setImporting(false)
  }

  // Export keywords as text
  const handleExport = () => {
    const text = keywords.map(k => `${k.keyword}\t${k.keyword_type}`).join('\n')
    navigator.clipboard.writeText(text)
    alert(`Copied ${keywords.length} keywords to clipboard (tab-separated with type).`)
  }

  if (authLoading) {
    return (
      <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
        <Sidebar />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p>Loading...</p>
        </div>
      </div>
    )
  }

  if (!canView) {
    return (
      <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
        <Sidebar />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1rem' }}>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 600, color: '#1f2937' }}>Access Denied</h2>
          <p style={{ color: '#6b7280' }}>You don&apos;t have permission to view PR Coverage.</p>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
      <Sidebar />

      <div style={{ flex: 1, padding: '32px', overflow: 'auto' }}>
        <div style={{ maxWidth: '1000px', margin: '0 auto' }}>
          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
            <div>
              <h1 style={{ fontSize: '28px', fontWeight: 700, color: '#1e293b', margin: 0 }}>PR Coverage</h1>
              <p style={{ fontSize: '14px', color: '#64748b', margin: '4px 0 0 0' }}>
                Manage keyword whitelists and blacklists for coverage discovery
              </p>
            </div>
            {canEdit && (
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={handleExport}
                  disabled={keywords.length === 0}
                  style={{
                    padding: '10px 16px', backgroundColor: 'white', color: '#475569',
                    border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '14px',
                    cursor: keywords.length === 0 ? 'not-allowed' : 'pointer', fontWeight: 500,
                    opacity: keywords.length === 0 ? 0.5 : 1
                  }}
                >
                  Export
                </button>
                <button
                  onClick={() => { setShowImport(true); setImportResult(null) }}
                  disabled={!selectedClientId || !selectedGameId}
                  style={{
                    padding: '10px 16px', backgroundColor: 'white', color: '#475569',
                    border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '14px',
                    cursor: !selectedClientId || !selectedGameId ? 'not-allowed' : 'pointer', fontWeight: 500,
                    opacity: !selectedClientId || !selectedGameId ? 0.5 : 1
                  }}
                >
                  Bulk Import
                </button>
              </div>
            )}
          </div>

          {/* Sub-navigation tabs */}
          <div style={{ display: 'flex', gap: '0', marginBottom: '24px', borderBottom: '2px solid #e2e8f0' }}>
            <Link href="/coverage" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              Outlets
            </Link>
            <div style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 600, cursor: 'pointer',
              color: '#2563eb', borderBottom: '2px solid #2563eb', marginBottom: '-2px'
            }}>
              Keywords
            </div>
            <Link href="/coverage/settings" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              API Keys
            </Link>
            <Link href="/coverage/sources" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              Sources
            </Link>
            <Link href="/coverage/feed" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              Feed
            </Link>
            <Link href="/coverage/dashboard" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              Dashboard
            </Link>
            <Link href="/coverage/timeline" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              Timeline
            </Link>
            <Link href="/coverage/report" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              Export
            </Link>
            <Link href="/coverage/clients" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              Clients &amp; Games
            </Link>
            <Link href="/coverage/campaign-report" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              Campaign Report
            </Link>
            <Link href="/coverage/guide" style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              Guide
            </Link>
          </div>

          {/* Client/Game selector */}
          <div style={{
            display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap',
            backgroundColor: 'white', padding: '16px', borderRadius: '10px',
            boxShadow: '0 1px 2px rgba(0,0,0,0.05)', alignItems: 'flex-end'
          }}>
            <div style={{ flex: '1 1 200px' }}>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#475569', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Client
              </label>
              <select
                value={selectedClientId}
                onChange={e => setSelectedClientId(e.target.value)}
                style={{ width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', backgroundColor: 'white' }}
              >
                <option value="">Select a client</option>
                {clients.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: '1 1 200px' }}>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#475569', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Game
              </label>
              <select
                value={selectedGameId}
                onChange={e => setSelectedGameId(e.target.value)}
                disabled={!selectedClientId}
                style={{ width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', backgroundColor: 'white' }}
              >
                <option value="">Select a game</option>
                {filteredGames.map(g => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#475569', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Type
              </label>
              <select
                value={typeFilter}
                onChange={e => setTypeFilter(e.target.value as '' | KeywordType)}
                style={{ padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', backgroundColor: 'white' }}
              >
                <option value="">All Types</option>
                <option value="whitelist">Whitelist</option>
                <option value="blacklist">Blacklist</option>
              </select>
            </div>
          </div>

          {/* Import result notification */}
          {importResult && (
            <div style={{
              padding: '12px 16px',
              backgroundColor: importResult.startsWith('Error') ? '#fee2e2' : '#dcfce7',
              color: importResult.startsWith('Error') ? '#dc2626' : '#166534',
              borderRadius: '8px', marginBottom: '16px', fontSize: '14px'
            }}>
              {importResult}
            </div>
          )}

          {!selectedClientId || !selectedGameId ? (
            <div style={{
              backgroundColor: 'white', borderRadius: '10px', padding: '60px 16px',
              textAlign: 'center', color: '#94a3b8',
              boxShadow: '0 1px 2px rgba(0,0,0,0.05)'
            }}>
              Select a client and game to manage keywords
            </div>
          ) : (
            <>
              {/* Keyword counts */}
              <div style={{ display: 'flex', gap: '12px', marginBottom: '16px' }}>
                <div style={{
                  backgroundColor: '#dcfce7', borderRadius: '8px', padding: '12px 20px',
                  border: '1px solid #86efac', flex: 1
                }}>
                  <div style={{ fontSize: '20px', fontWeight: 700, color: '#166534' }}>{whitelistCount}</div>
                  <div style={{ fontSize: '12px', color: '#166534', opacity: 0.8 }}>Whitelist Keywords</div>
                </div>
                <div style={{
                  backgroundColor: '#fee2e2', borderRadius: '8px', padding: '12px 20px',
                  border: '1px solid #fecaca', flex: 1
                }}>
                  <div style={{ fontSize: '20px', fontWeight: 700, color: '#dc2626' }}>{blacklistCount}</div>
                  <div style={{ fontSize: '12px', color: '#dc2626', opacity: 0.8 }}>Blacklist Keywords</div>
                </div>
              </div>

              {/* Quick-add form */}
              {canEdit && (
                <div style={{
                  backgroundColor: 'white', borderRadius: '10px', padding: '16px',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.05)', marginBottom: '16px',
                  display: 'flex', gap: '10px', alignItems: 'flex-end'
                }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>
                      Add Keyword
                    </label>
                    <input
                      type="text"
                      value={newKeyword}
                      onChange={e => setNewKeyword(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
                      placeholder='e.g. "Game Title", "Developer Name"'
                      style={{ width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box' }}
                    />
                  </div>
                  <select
                    value={newType}
                    onChange={e => setNewType(e.target.value as KeywordType)}
                    style={{ padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', backgroundColor: 'white' }}
                  >
                    <option value="whitelist">Whitelist</option>
                    <option value="blacklist">Blacklist</option>
                  </select>
                  <button
                    onClick={handleAdd}
                    disabled={adding || !newKeyword.trim()}
                    style={{
                      padding: '8px 20px', backgroundColor: '#2563eb', color: 'white',
                      border: 'none', borderRadius: '6px', fontSize: '14px', fontWeight: 500,
                      cursor: adding || !newKeyword.trim() ? 'not-allowed' : 'pointer',
                      opacity: adding || !newKeyword.trim() ? 0.7 : 1, whiteSpace: 'nowrap'
                    }}
                  >
                    {adding ? 'Adding...' : 'Add'}
                  </button>
                </div>
              )}

              {/* Keywords list */}
              <div style={{ backgroundColor: 'white', borderRadius: '10px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)', overflow: 'hidden' }}>
                {isLoading ? (
                  <div style={{ padding: '40px 16px', textAlign: 'center', color: '#94a3b8' }}>Loading keywords...</div>
                ) : keywords.length === 0 ? (
                  <div style={{ padding: '40px 16px', textAlign: 'center', color: '#94a3b8' }}>
                    No keywords yet. Add your first keyword above or use Bulk Import.
                  </div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #e2e8f0', backgroundColor: '#f8fafc' }}>
                        <th style={{ textAlign: 'left', padding: '12px 16px', fontWeight: 600, color: '#475569' }}>Keyword</th>
                        <th style={{ textAlign: 'center', padding: '12px 16px', fontWeight: 600, color: '#475569', width: '120px' }}>Type</th>
                        {canEdit && (
                          <th style={{ textAlign: 'right', padding: '12px 16px', fontWeight: 600, color: '#475569', width: '140px' }}>Actions</th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {keywords.map((kw, i) => (
                        <tr key={kw.id} style={{ borderBottom: '1px solid #f1f5f9', backgroundColor: i % 2 === 0 ? 'white' : '#fafbfc' }}>
                          <td style={{ padding: '10px 16px', color: '#1e293b' }}>
                            {editingId === kw.id ? (
                              <div style={{ display: 'flex', gap: '6px' }}>
                                <input
                                  type="text"
                                  value={editValue}
                                  onChange={e => setEditValue(e.target.value)}
                                  onKeyDown={e => { if (e.key === 'Enter') handleSaveEdit(kw.id); if (e.key === 'Escape') setEditingId(null) }}
                                  autoFocus
                                  style={{ flex: 1, padding: '4px 8px', border: '1px solid #93c5fd', borderRadius: '4px', fontSize: '14px' }}
                                />
                                <button
                                  onClick={() => handleSaveEdit(kw.id)}
                                  style={{ padding: '4px 10px', backgroundColor: '#2563eb', color: 'white', border: 'none', borderRadius: '4px', fontSize: '12px', cursor: 'pointer' }}
                                >
                                  Save
                                </button>
                                <button
                                  onClick={() => setEditingId(null)}
                                  style={{ padding: '4px 10px', backgroundColor: 'white', color: '#475569', border: '1px solid #e2e8f0', borderRadius: '4px', fontSize: '12px', cursor: 'pointer' }}
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <span style={{ fontWeight: 500 }}>{kw.keyword}</span>
                            )}
                          </td>
                          <td style={{ padding: '10px 16px', textAlign: 'center' }}>
                            <button
                              onClick={() => canEdit && handleToggleType(kw)}
                              disabled={!canEdit}
                              style={{
                                display: 'inline-block', padding: '2px 10px', borderRadius: '9999px',
                                fontSize: '12px', fontWeight: 600, border: 'none', cursor: canEdit ? 'pointer' : 'default',
                                backgroundColor: kw.keyword_type === 'whitelist' ? '#dcfce7' : '#fee2e2',
                                color: kw.keyword_type === 'whitelist' ? '#166534' : '#dc2626'
                              }}
                              title={canEdit ? 'Click to toggle type' : ''}
                            >
                              {kw.keyword_type}
                            </button>
                          </td>
                          {canEdit && (
                            <td style={{ padding: '10px 16px', textAlign: 'right' }}>
                              <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                                <button
                                  onClick={() => { setEditingId(kw.id); setEditValue(kw.keyword) }}
                                  style={{
                                    padding: '4px 10px', backgroundColor: 'white', color: '#475569',
                                    border: '1px solid #e2e8f0', borderRadius: '4px', fontSize: '12px', cursor: 'pointer'
                                  }}
                                >
                                  Edit
                                </button>
                                <button
                                  onClick={() => handleDelete(kw.id)}
                                  style={{
                                    padding: '4px 10px', backgroundColor: 'white', color: '#ef4444',
                                    border: '1px solid #fecaca', borderRadius: '4px', fontSize: '12px', cursor: 'pointer'
                                  }}
                                >
                                  Delete
                                </button>
                              </div>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div style={{ padding: '12px 16px', borderTop: '1px solid #f1f5f9', fontSize: '13px', color: '#64748b' }}>
                  {keywords.length} keyword{keywords.length !== 1 ? 's' : ''} total
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Bulk Import Modal */}
      {showImport && (
        <div style={{
          position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50
        }}>
          <div style={{
            backgroundColor: 'white', borderRadius: '16px', padding: '32px',
            width: '500px', maxHeight: '90vh', overflow: 'auto',
            boxShadow: '0 25px 50px rgba(0,0,0,0.25)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h2 style={{ fontSize: '20px', fontWeight: 700, color: '#1e293b', margin: 0 }}>Bulk Import Keywords</h2>
              <button
                onClick={() => setShowImport(false)}
                style={{ background: 'none', border: 'none', fontSize: '24px', color: '#94a3b8', cursor: 'pointer' }}
              >
                ×
              </button>
            </div>

            <p style={{ fontSize: '13px', color: '#64748b', marginBottom: '12px' }}>
              Paste one keyword per line. All will be added as the selected type.
            </p>

            <div style={{ marginBottom: '12px' }}>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>
                Import as:
              </label>
              <select
                value={importType}
                onChange={e => setImportType(e.target.value as KeywordType)}
                style={{ padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', backgroundColor: 'white' }}
              >
                <option value="whitelist">Whitelist</option>
                <option value="blacklist">Blacklist</option>
              </select>
            </div>

            <textarea
              value={importText}
              onChange={e => setImportText(e.target.value)}
              placeholder={`Sprint City\nGame Drive\nEscape Simulator 2\nPine Studio`}
              style={{
                width: '100%', height: '200px', padding: '12px', border: '1px solid #e2e8f0',
                borderRadius: '8px', fontSize: '13px', fontFamily: 'monospace',
                resize: 'vertical', boxSizing: 'border-box'
              }}
            />

            {importResult && (
              <div style={{
                padding: '10px 14px', marginTop: '12px',
                backgroundColor: importResult.startsWith('Error') ? '#fee2e2' : '#dcfce7',
                color: importResult.startsWith('Error') ? '#dc2626' : '#166534',
                borderRadius: '6px', fontSize: '13px'
              }}>
                {importResult}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
              <button
                onClick={() => setShowImport(false)}
                style={{ padding: '8px 20px', backgroundColor: 'white', color: '#475569', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={handleBulkImport}
                disabled={importing || !importText.trim()}
                style={{
                  padding: '8px 24px', backgroundColor: '#2563eb', color: 'white', border: 'none',
                  borderRadius: '6px', fontSize: '14px', fontWeight: 500,
                  cursor: importing || !importText.trim() ? 'not-allowed' : 'pointer',
                  opacity: importing || !importText.trim() ? 0.7 : 1
                }}
              >
                {importing ? 'Importing...' : 'Import'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
