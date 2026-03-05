'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import { Sidebar } from '../../components/Sidebar'
import { useAuth } from '@/lib/auth-context'
import type { Client, Game } from '@/lib/types'

interface GameWithClient extends Game {
  client: Client
  keyword_count?: number
}

export default function CoverageClientsPage() {
  const { hasAccess, loading: authLoading } = useAuth()
  const canView = hasAccess('pr_coverage', 'view')
  const canEdit = hasAccess('pr_coverage', 'edit')
  const supabase = createClientComponentClient()

  // Data
  const [clients, setClients] = useState<Client[]>([])
  const [games, setGames] = useState<GameWithClient[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // Filters
  const [selectedClientId, setSelectedClientId] = useState('')
  const [showOnlyPREnabled, setShowOnlyPREnabled] = useState(false)

  // Add client form
  const [showAddClient, setShowAddClient] = useState(false)
  const [newClientName, setNewClientName] = useState('')
  const [newClientEmail, setNewClientEmail] = useState('')

  // Add game form
  const [showAddGame, setShowAddGame] = useState(false)
  const [newGameName, setNewGameName] = useState('')
  const [newGameClientId, setNewGameClientId] = useState('')
  const [newGameSteamAppId, setNewGameSteamAppId] = useState('')
  const [newGamePREnabled, setNewGamePREnabled] = useState(true)

  // Edit state
  const [editingGameId, setEditingGameId] = useState<string | null>(null)
  const [editGameName, setEditGameName] = useState('')

  // Status messages
  const [actionMessage, setActionMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null)
  const [saving, setSaving] = useState(false)

  // Fetch data
  const fetchData = useCallback(async () => {
    setIsLoading(true)
    try {
      const [clientsRes, gamesRes] = await Promise.all([
        supabase.from('clients').select('*').order('name'),
        supabase.from('games').select('*, client:clients(id, name)').order('name')
      ])

      if (clientsRes.data) setClients(clientsRes.data)

      if (gamesRes.data) {
        // Fetch keyword counts per game
        const { data: kwData } = await supabase
          .from('coverage_keywords')
          .select('game_id')

        const kwCounts: Record<string, number> = {}
        if (kwData) {
          for (const kw of kwData) {
            kwCounts[kw.game_id] = (kwCounts[kw.game_id] || 0) + 1
          }
        }

        setGames(gamesRes.data.map((g: GameWithClient) => ({
          ...g,
          keyword_count: kwCounts[g.id] || 0
        })))
      }
    } catch (err) {
      console.error('Failed to fetch data:', err)
    }
    setIsLoading(false)
  }, [supabase])

  useEffect(() => {
    if (canView) fetchData()
  }, [canView, fetchData])

  // Clear action message after 3s
  useEffect(() => {
    if (actionMessage) {
      const t = setTimeout(() => setActionMessage(null), 3000)
      return () => clearTimeout(t)
    }
  }, [actionMessage])

  // Filter games
  const filteredGames = games.filter(g => {
    if (selectedClientId && g.client_id !== selectedClientId) return false
    if (showOnlyPREnabled && !g.pr_tracking_enabled) return false
    return true
  })

  const prEnabledCount = games.filter(g => g.pr_tracking_enabled).length

  // ─── Actions ──────────────────────────────────────────────────────────

  const handleAddClient = async () => {
    if (!newClientName.trim()) return
    setSaving(true)
    try {
      const res = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newClientName.trim(), email: newClientEmail.trim() || undefined })
      })
      if (!res.ok) throw new Error('Failed to create client')
      setNewClientName('')
      setNewClientEmail('')
      setShowAddClient(false)
      setActionMessage({ text: 'Client created', type: 'success' })
      fetchData()
    } catch {
      setActionMessage({ text: 'Failed to create client', type: 'error' })
    }
    setSaving(false)
  }

  const handleAddGame = async () => {
    if (!newGameName.trim() || !newGameClientId) return
    setSaving(true)
    try {
      const res = await fetch('/api/games', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newGameName.trim(),
          client_id: newGameClientId,
          steam_app_id: newGameSteamAppId.trim() || undefined,
          pr_tracking_enabled: newGamePREnabled
        })
      })
      if (!res.ok) throw new Error('Failed to create game')
      const game = await res.json()

      // If PR tracking is enabled, auto-create the game name as a keyword + trigger backfill
      if (newGamePREnabled) {
        await autoCreateKeywords(newGameClientId, game.id, newGameName.trim())
        triggerBackfill(game.id)
      }

      setNewGameName('')
      setNewGameSteamAppId('')
      setShowAddGame(false)
      setActionMessage({ text: `Game created${newGamePREnabled ? ' with PR tracking — backfill started' : ''}`, type: 'success' })
      fetchData()
    } catch {
      setActionMessage({ text: 'Failed to create game', type: 'error' })
    }
    setSaving(false)
  }

  const autoCreateKeywords = async (clientId: string, gameId: string, gameName: string) => {
    try {
      await fetch('/api/coverage-keywords', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          game_id: gameId,
          keyword: gameName,
          keyword_type: 'whitelist'
        })
      })
    } catch (err) {
      console.error('Failed to auto-create keyword:', err)
    }
  }

  // Fire-and-forget historical backfill when PR tracking is first enabled
  const triggerBackfill = (gameId: string) => {
    fetch('/api/coverage-backfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game_id: gameId, max_queries: 20 })
    }).catch(err => console.error('Backfill trigger failed:', err))
  }

  const handleTogglePR = async (game: GameWithClient) => {
    const newValue = !game.pr_tracking_enabled
    try {
      const res = await fetch('/api/games', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: game.id, pr_tracking_enabled: newValue })
      })
      if (!res.ok) throw new Error('Failed to update game')

      // If enabling PR and no keywords exist, auto-create game name keyword + backfill
      if (newValue && (!game.keyword_count || game.keyword_count === 0)) {
        await autoCreateKeywords(game.client_id, game.id, game.name)
        triggerBackfill(game.id)
        setActionMessage({ text: `PR tracking enabled for ${game.name} — keyword added, backfill started`, type: 'success' })
      } else if (newValue) {
        triggerBackfill(game.id)
        setActionMessage({ text: `PR tracking enabled for ${game.name} — backfill started`, type: 'success' })
      } else {
        setActionMessage({ text: `PR tracking disabled for ${game.name}`, type: 'success' })
      }

      fetchData()
    } catch {
      setActionMessage({ text: 'Failed to update PR tracking', type: 'error' })
    }
  }

  const handleSaveGameEdit = async (gameId: string) => {
    if (!editGameName.trim()) return
    try {
      const res = await fetch('/api/games', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: gameId, name: editGameName.trim() })
      })
      if (!res.ok) throw new Error('Failed to update game')
      setEditingGameId(null)
      setActionMessage({ text: 'Game updated', type: 'success' })
      fetchData()
    } catch {
      setActionMessage({ text: 'Failed to update game', type: 'error' })
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────

  if (authLoading || isLoading) {
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
              <h1 style={{ fontSize: '28px', fontWeight: 700, color: '#1e293b', margin: 0 }}>Clients & Games</h1>
              <p style={{ fontSize: '14px', color: '#64748b', margin: '4px 0 0 0' }}>
                Manage clients and games, toggle PR tracking per game
              </p>
            </div>
            {canEdit && (
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => setShowAddClient(true)}
                  style={{
                    padding: '10px 16px', backgroundColor: 'white', color: '#475569',
                    border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '14px',
                    cursor: 'pointer', fontWeight: 500
                  }}
                >
                  + Client
                </button>
                <button
                  onClick={() => { setShowAddGame(true); if (clients.length > 0 && !newGameClientId) setNewGameClientId(clients[0].id) }}
                  style={{
                    padding: '10px 16px', backgroundColor: '#2563eb', color: 'white',
                    border: 'none', borderRadius: '8px', fontSize: '14px',
                    cursor: 'pointer', fontWeight: 500
                  }}
                >
                  + Game
                </button>
              </div>
            )}
          </div>

          {/* Sub-navigation tabs */}
          <div style={{ display: 'flex', gap: '0', marginBottom: '24px', borderBottom: '2px solid #e2e8f0' }}>
            <Link href="/coverage" style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 500, color: '#64748b', textDecoration: 'none', marginBottom: '-2px' }}>Outlets</Link>
            <Link href="/coverage/keywords" style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 500, color: '#64748b', textDecoration: 'none', marginBottom: '-2px' }}>Keywords</Link>
            <Link href="/coverage/settings" style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 500, color: '#64748b', textDecoration: 'none', marginBottom: '-2px' }}>API Keys</Link>
            <Link href="/coverage/sources" style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 500, color: '#64748b', textDecoration: 'none', marginBottom: '-2px' }}>Sources</Link>
            <Link href="/coverage/feed" style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 500, color: '#64748b', textDecoration: 'none', marginBottom: '-2px' }}>Feed</Link>
            <Link href="/coverage/dashboard" style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 500, color: '#64748b', textDecoration: 'none', marginBottom: '-2px' }}>Dashboard</Link>
            <Link href="/coverage/timeline" style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 500, color: '#64748b', textDecoration: 'none', marginBottom: '-2px' }}>Timeline</Link>
            <div style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 600, color: '#2563eb', borderBottom: '2px solid #2563eb', marginBottom: '-2px' }}>Clients & Games</div>
            <Link href="/coverage/report" style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 500, color: '#64748b', textDecoration: 'none', marginBottom: '-2px' }}>Export</Link>
            <Link href="/coverage/campaign-report" style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 500, color: '#64748b', textDecoration: 'none', marginBottom: '-2px' }}>Campaign Report</Link>
            <Link href="/coverage/guide" style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 500, color: '#64748b', textDecoration: 'none', marginBottom: '-2px' }}>Guide</Link>
          </div>

          {/* Action message */}
          {actionMessage && (
            <div style={{
              padding: '12px 16px', borderRadius: '8px', marginBottom: '16px', fontSize: '14px',
              backgroundColor: actionMessage.type === 'success' ? '#dcfce7' : '#fee2e2',
              color: actionMessage.type === 'success' ? '#166534' : '#dc2626',
              border: `1px solid ${actionMessage.type === 'success' ? '#86efac' : '#fecaca'}`
            }}>
              {actionMessage.text}
            </div>
          )}

          {/* Stats */}
          <div style={{ display: 'flex', gap: '12px', marginBottom: '16px' }}>
            <div style={{ backgroundColor: 'white', borderRadius: '8px', padding: '12px 20px', border: '1px solid #e2e8f0', flex: 1 }}>
              <div style={{ fontSize: '20px', fontWeight: 700, color: '#1e293b' }}>{clients.length}</div>
              <div style={{ fontSize: '12px', color: '#64748b' }}>Clients</div>
            </div>
            <div style={{ backgroundColor: 'white', borderRadius: '8px', padding: '12px 20px', border: '1px solid #e2e8f0', flex: 1 }}>
              <div style={{ fontSize: '20px', fontWeight: 700, color: '#1e293b' }}>{games.length}</div>
              <div style={{ fontSize: '12px', color: '#64748b' }}>Total Games</div>
            </div>
            <div style={{ backgroundColor: '#dbeafe', borderRadius: '8px', padding: '12px 20px', border: '1px solid #93c5fd', flex: 1 }}>
              <div style={{ fontSize: '20px', fontWeight: 700, color: '#1e40af' }}>{prEnabledCount}</div>
              <div style={{ fontSize: '12px', color: '#1e40af' }}>PR Tracking On</div>
            </div>
          </div>

          {/* Filters */}
          <div style={{
            backgroundColor: 'white', padding: '16px', borderRadius: '10px',
            boxShadow: '0 1px 2px rgba(0,0,0,0.05)', marginBottom: '16px',
            display: 'flex', gap: '12px', alignItems: 'center'
          }}>
            <select
              value={selectedClientId}
              onChange={e => setSelectedClientId(e.target.value)}
              style={{ padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', backgroundColor: 'white' }}
            >
              <option value="">All Clients</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button
              onClick={() => setShowOnlyPREnabled(!showOnlyPREnabled)}
              style={{
                padding: '8px 16px', borderRadius: '8px', fontSize: '13px', fontWeight: 500, cursor: 'pointer',
                backgroundColor: showOnlyPREnabled ? '#2563eb' : 'white',
                color: showOnlyPREnabled ? 'white' : '#475569',
                border: showOnlyPREnabled ? '1px solid #2563eb' : '1px solid #e2e8f0'
              }}
            >
              {showOnlyPREnabled ? 'Showing PR-Tracked Only' : 'Show All Games'}
            </button>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: '13px', color: '#64748b' }}>
              {filteredGames.length} game{filteredGames.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Games table */}
          <div style={{ backgroundColor: 'white', borderRadius: '10px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)', overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #e2e8f0', backgroundColor: '#f8fafc' }}>
                  <th style={{ textAlign: 'left', padding: '12px 16px', fontWeight: 600, color: '#475569' }}>Game</th>
                  <th style={{ textAlign: 'left', padding: '12px 16px', fontWeight: 600, color: '#475569' }}>Client</th>
                  <th style={{ textAlign: 'center', padding: '12px 16px', fontWeight: 600, color: '#475569', width: '100px' }}>Keywords</th>
                  <th style={{ textAlign: 'center', padding: '12px 16px', fontWeight: 600, color: '#475569', width: '140px' }}>PR Tracking</th>
                  {canEdit && (
                    <th style={{ textAlign: 'right', padding: '12px 16px', fontWeight: 600, color: '#475569', width: '120px' }}>Actions</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {filteredGames.length === 0 ? (
                  <tr>
                    <td colSpan={canEdit ? 5 : 4} style={{ padding: '60px 16px', textAlign: 'center', color: '#94a3b8' }}>
                      {games.length === 0
                        ? 'No games yet. Add your first game above.'
                        : 'No games match the current filters.'}
                    </td>
                  </tr>
                ) : (
                  filteredGames.map((game, i) => (
                    <tr key={game.id} style={{ borderBottom: '1px solid #f1f5f9', backgroundColor: i % 2 === 0 ? 'white' : '#fafbfc' }}>
                      <td style={{ padding: '12px 16px' }}>
                        {editingGameId === game.id ? (
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <input
                              type="text"
                              value={editGameName}
                              onChange={e => setEditGameName(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') handleSaveGameEdit(game.id); if (e.key === 'Escape') setEditingGameId(null) }}
                              autoFocus
                              style={{ flex: 1, padding: '4px 8px', border: '1px solid #93c5fd', borderRadius: '4px', fontSize: '14px' }}
                            />
                            <button onClick={() => handleSaveGameEdit(game.id)}
                              style={{ padding: '4px 10px', backgroundColor: '#2563eb', color: 'white', border: 'none', borderRadius: '4px', fontSize: '12px', cursor: 'pointer' }}>
                              Save
                            </button>
                            <button onClick={() => setEditingGameId(null)}
                              style={{ padding: '4px 10px', backgroundColor: 'white', color: '#475569', border: '1px solid #e2e8f0', borderRadius: '4px', fontSize: '12px', cursor: 'pointer' }}>
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div>
                            <span style={{ fontWeight: 500, color: '#1e293b' }}>{game.name}</span>
                            {game.steam_app_id && (
                              <span style={{ fontSize: '12px', color: '#94a3b8', marginLeft: '8px' }}>Steam: {game.steam_app_id}</span>
                            )}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '12px 16px', color: '#64748b' }}>
                        {game.client?.name || '—'}
                      </td>
                      <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                        {game.keyword_count && game.keyword_count > 0 ? (
                          <Link
                            href={`/coverage/keywords`}
                            style={{ color: '#2563eb', textDecoration: 'none', fontWeight: 500 }}
                          >
                            {game.keyword_count}
                          </Link>
                        ) : (
                          <span style={{ color: '#d1d5db' }}>0</span>
                        )}
                      </td>
                      <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                        {canEdit ? (
                          <button
                            onClick={() => handleTogglePR(game)}
                            style={{
                              padding: '4px 14px', borderRadius: '9999px', fontSize: '12px', fontWeight: 600,
                              border: 'none', cursor: 'pointer', transition: 'all 0.2s',
                              backgroundColor: game.pr_tracking_enabled ? '#dbeafe' : '#f3f4f6',
                              color: game.pr_tracking_enabled ? '#1e40af' : '#9ca3af'
                            }}
                          >
                            {game.pr_tracking_enabled ? 'On' : 'Off'}
                          </button>
                        ) : (
                          <span style={{
                            padding: '4px 14px', borderRadius: '9999px', fontSize: '12px', fontWeight: 600,
                            backgroundColor: game.pr_tracking_enabled ? '#dbeafe' : '#f3f4f6',
                            color: game.pr_tracking_enabled ? '#1e40af' : '#9ca3af'
                          }}>
                            {game.pr_tracking_enabled ? 'On' : 'Off'}
                          </span>
                        )}
                      </td>
                      {canEdit && (
                        <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                          <button
                            onClick={() => { setEditingGameId(game.id); setEditGameName(game.name) }}
                            style={{ padding: '4px 10px', backgroundColor: 'white', color: '#475569', border: '1px solid #e2e8f0', borderRadius: '4px', fontSize: '12px', cursor: 'pointer', marginRight: '4px' }}
                          >
                            Edit
                          </button>
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            <div style={{ padding: '12px 16px', borderTop: '1px solid #f1f5f9', fontSize: '13px', color: '#64748b' }}>
              {filteredGames.length} game{filteredGames.length !== 1 ? 's' : ''} shown
            </div>
          </div>
        </div>
      </div>

      {/* Add Client Modal */}
      {showAddClient && (
        <div style={{
          position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50
        }}>
          <div style={{
            backgroundColor: 'white', borderRadius: '16px', padding: '32px',
            width: '440px', boxShadow: '0 25px 50px rgba(0,0,0,0.25)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ fontSize: '20px', fontWeight: 700, color: '#1e293b', margin: 0 }}>Add Client</h2>
              <button onClick={() => setShowAddClient(false)}
                style={{ background: 'none', border: 'none', fontSize: '24px', color: '#94a3b8', cursor: 'pointer' }}>
                x
              </button>
            </div>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>Client Name *</label>
              <input
                type="text" value={newClientName} onChange={e => setNewClientName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAddClient() }}
                placeholder="e.g., tobspr Games" autoFocus
                style={{ width: '100%', padding: '10px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ marginBottom: '24px' }}>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>Email (optional)</label>
              <input
                type="email" value={newClientEmail} onChange={e => setNewClientEmail(e.target.value)}
                placeholder="contact@example.com"
                style={{ width: '100%', padding: '10px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button onClick={() => setShowAddClient(false)}
                style={{ padding: '10px 20px', backgroundColor: 'white', color: '#475569', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={handleAddClient} disabled={saving || !newClientName.trim()}
                style={{
                  padding: '10px 24px', backgroundColor: '#2563eb', color: 'white', border: 'none',
                  borderRadius: '6px', fontSize: '14px', fontWeight: 500,
                  cursor: saving || !newClientName.trim() ? 'not-allowed' : 'pointer',
                  opacity: saving || !newClientName.trim() ? 0.7 : 1
                }}>
                {saving ? 'Creating...' : 'Create Client'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Game Modal */}
      {showAddGame && (
        <div style={{
          position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50
        }}>
          <div style={{
            backgroundColor: 'white', borderRadius: '16px', padding: '32px',
            width: '480px', boxShadow: '0 25px 50px rgba(0,0,0,0.25)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ fontSize: '20px', fontWeight: 700, color: '#1e293b', margin: 0 }}>Add Game</h2>
              <button onClick={() => setShowAddGame(false)}
                style={{ background: 'none', border: 'none', fontSize: '24px', color: '#94a3b8', cursor: 'pointer' }}>
                x
              </button>
            </div>

            {clients.length === 0 ? (
              <div style={{ padding: '20px', backgroundColor: '#fef3c7', borderRadius: '8px', color: '#92400e', fontSize: '14px', marginBottom: '16px' }}>
                No clients yet. Please add a client first.
              </div>
            ) : (
              <>
                <div style={{ marginBottom: '16px' }}>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>Client *</label>
                  <select value={newGameClientId} onChange={e => setNewGameClientId(e.target.value)}
                    style={{ width: '100%', padding: '10px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', backgroundColor: 'white', boxSizing: 'border-box' }}>
                    {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div style={{ marginBottom: '16px' }}>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>Game Name *</label>
                  <input type="text" value={newGameName} onChange={e => setNewGameName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleAddGame() }}
                    placeholder="e.g., shapez 2" autoFocus
                    style={{ width: '100%', padding: '10px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box' }} />
                </div>
                <div style={{ marginBottom: '16px' }}>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>Steam App ID (optional)</label>
                  <input type="text" value={newGameSteamAppId} onChange={e => setNewGameSteamAppId(e.target.value)}
                    placeholder="e.g., 1234567"
                    style={{ width: '100%', padding: '10px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box' }} />
                </div>
                <div style={{
                  padding: '16px', marginBottom: '24px', borderRadius: '8px',
                  background: 'linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%)',
                  border: '1px solid #bae6fd'
                }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', fontSize: '14px', fontWeight: 500, color: '#1e40af' }}>
                    <input type="checkbox" checked={newGamePREnabled} onChange={e => setNewGamePREnabled(e.target.checked)}
                      style={{ width: '18px', height: '18px', accentColor: '#2563eb' }} />
                    Enable PR Tracking
                  </label>
                  <p style={{ margin: '8px 0 0 28px', fontSize: '13px', color: '#64748b' }}>
                    Automatically adds the game name as a keyword for coverage discovery
                  </p>
                </div>
              </>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button onClick={() => setShowAddGame(false)}
                style={{ padding: '10px 20px', backgroundColor: 'white', color: '#475569', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={handleAddGame} disabled={saving || !newGameName.trim() || !newGameClientId}
                style={{
                  padding: '10px 24px', backgroundColor: '#2563eb', color: 'white', border: 'none',
                  borderRadius: '6px', fontSize: '14px', fontWeight: 500,
                  cursor: saving || !newGameName.trim() || !newGameClientId ? 'not-allowed' : 'pointer',
                  opacity: saving || !newGameName.trim() || !newGameClientId ? 0.7 : 1
                }}>
                {saving ? 'Creating...' : 'Create Game'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
