'use client'

import { useState, useEffect, useCallback } from 'react'
import { format } from 'date-fns'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import { useAuth } from '@/lib/auth-context'
import styles from './page.module.css'

interface Platform {
  id: string
  name: string
  color_hex: string
}

interface ProductPlatform {
  platform_id: string
  platform?: Platform
}

interface Product {
  id: string
  game_id: string
  name: string
  product_type: string
  steam_product_id?: string
  launch_date?: string | null
  product_aliases?: string[]
  product_platforms?: ProductPlatform[]
}

interface Game {
  id: string
  client_id: string
  name: string
  steam_app_id?: string
  pr_tracking_enabled: boolean
  sales_planning_enabled: boolean
  products?: Product[]
  keyword_count?: number
}

interface Client {
  id: string
  name: string
  email: string | null
  contact_person?: string | null
  steam_api_key: string | null
  sales_planning_enabled: boolean
  pr_tracking_enabled: boolean
  created_at: string
  games?: Game[]
}

type ModalType = 'addClient' | 'editClient' | 'addGame' | 'editGame' | 'addProduct' | 'editProduct' | null

export default function SettingsClientsPage() {
  const supabase = createClientComponentClient()
  const { hasAccess, loading: authLoading } = useAuth()
  const canView = hasAccess('client_management', 'view')
  const canEdit = hasAccess('client_management', 'edit')

  const [clients, setClients] = useState<Client[]>([])
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [expandedClients, setExpandedClients] = useState<Set<string>>(new Set())
  const [expandedGames, setExpandedGames] = useState<Set<string>>(new Set())

  // Modal state
  const [modalType, setModalType] = useState<ModalType>(null)
  const [modalTarget, setModalTarget] = useState<{ clientId?: string; gameId?: string; productId?: string }>({})
  const [saving, setSaving] = useState(false)
  const [actionMessage, setActionMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null)

  // Client form
  const [clientForm, setClientForm] = useState({ name: '', email: '', contact_person: '', sales_planning_enabled: true, pr_tracking_enabled: false })

  // Game form
  const [gameForm, setGameForm] = useState({ name: '', steam_app_id: '', client_id: '', sales_planning_enabled: true, pr_tracking_enabled: false, auto_base_product: true, launch_date: format(new Date(), 'yyyy-MM-dd'), auto_calendar: true })
  const [baseProductPlatformIds, setBaseProductPlatformIds] = useState<string[]>([])

  // Product form
  const [productForm, setProductForm] = useState({ name: '', game_id: '', product_type: 'base' as string, steam_product_id: '', launch_date: format(new Date(), 'yyyy-MM-dd'), product_aliases: '', auto_calendar: true })
  const [productPlatformIds, setProductPlatformIds] = useState<string[]>([])

  // Fetch all data
  const fetchData = useCallback(async () => {
    setIsLoading(true)
    const [clientsRes, platformsRes, kwRes] = await Promise.all([
      supabase
        .from('clients')
        .select(`
          *,
          games(
            *,
            products(
              *,
              product_platforms(platform_id, platform:platforms(id, name, color_hex))
            )
          )
        `)
        .order('name'),
      supabase.from('platforms').select('id, name, color_hex').order('name'),
      supabase.from('coverage_keywords').select('game_id')
    ])

    if (platformsRes.data) setPlatforms(platformsRes.data)

    // Build keyword counts
    const kwCounts: Record<string, number> = {}
    if (kwRes.data) {
      for (const kw of kwRes.data) {
        kwCounts[kw.game_id] = (kwCounts[kw.game_id] || 0) + 1
      }
    }

    if (clientsRes.data) {
      setClients(clientsRes.data.map((c: Client) => ({
        ...c,
        games: c.games?.map(g => ({ ...g, keyword_count: kwCounts[g.id] || 0 }))
      })))
    }
    setIsLoading(false)
  }, [supabase])

  useEffect(() => { fetchData() }, [fetchData])

  useEffect(() => {
    if (actionMessage) {
      const t = setTimeout(() => setActionMessage(null), 4000)
      return () => clearTimeout(t)
    }
  }, [actionMessage])

  // ── Client CRUD ──────────────────────────────────────────────

  const openAddClient = () => {
    setClientForm({ name: '', email: '', contact_person: '', sales_planning_enabled: true, pr_tracking_enabled: false })
    setModalType('addClient')
  }

  const openEditClient = (client: Client) => {
    setClientForm({
      name: client.name,
      email: client.email || '',
      contact_person: client.contact_person || '',
      sales_planning_enabled: client.sales_planning_enabled,
      pr_tracking_enabled: client.pr_tracking_enabled
    })
    setModalTarget({ clientId: client.id })
    setModalType('editClient')
  }

  const handleSaveClient = async () => {
    if (!clientForm.name.trim()) return
    setSaving(true)
    try {
      if (modalType === 'addClient') {
        const res = await fetch('/api/clients', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: clientForm.name.trim(),
            email: clientForm.email.trim() || null,
            contact_person: clientForm.contact_person.trim() || null,
            sales_planning_enabled: clientForm.sales_planning_enabled,
            pr_tracking_enabled: clientForm.pr_tracking_enabled
          })
        })
        if (!res.ok) throw new Error('Failed to create client')
        setActionMessage({ text: 'Client created', type: 'success' })
      } else {
        const res = await fetch('/api/clients', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: modalTarget.clientId,
            name: clientForm.name.trim(),
            email: clientForm.email.trim() || null,
            contact_person: clientForm.contact_person.trim() || null,
            sales_planning_enabled: clientForm.sales_planning_enabled,
            pr_tracking_enabled: clientForm.pr_tracking_enabled
          })
        })
        if (!res.ok) throw new Error('Failed to update client')
        setActionMessage({ text: 'Client updated', type: 'success' })
      }
      setModalType(null)
      fetchData()
    } catch {
      setActionMessage({ text: 'Failed to save client', type: 'error' })
    }
    setSaving(false)
  }

  const handleDeleteClient = async (id: string, name: string) => {
    if (!confirm(`Delete "${name}"? This will also delete all associated games, products, and sales.`)) return
    try {
      const res = await fetch(`/api/clients?id=${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed')
      setActionMessage({ text: 'Client deleted', type: 'success' })
      fetchData()
    } catch {
      setActionMessage({ text: 'Failed to delete client', type: 'error' })
    }
  }

  const handleToggleClientFlag = async (clientId: string, field: 'sales_planning_enabled' | 'pr_tracking_enabled', currentValue: boolean) => {
    // Optimistic update
    setClients(prev => prev.map(c => c.id === clientId ? { ...c, [field]: !currentValue } : c))
    try {
      const res = await fetch('/api/clients', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: clientId, [field]: !currentValue })
      })
      if (!res.ok) throw new Error('Failed')
    } catch {
      // Rollback
      setClients(prev => prev.map(c => c.id === clientId ? { ...c, [field]: currentValue } : c))
      setActionMessage({ text: 'Failed to update toggle', type: 'error' })
    }
  }

  // ── Game CRUD ──────────────────────────────────────────────

  const openAddGame = (clientId: string) => {
    const client = clients.find(c => c.id === clientId)
    setGameForm({
      name: '', steam_app_id: '', client_id: clientId,
      sales_planning_enabled: true,
      pr_tracking_enabled: client?.pr_tracking_enabled ?? false,
      auto_base_product: true,
      launch_date: format(new Date(), 'yyyy-MM-dd'),
      auto_calendar: true
    })
    setBaseProductPlatformIds([])
    setModalType('addGame')
  }

  const openEditGame = (game: Game) => {
    setGameForm({
      name: game.name, steam_app_id: game.steam_app_id || '', client_id: game.client_id,
      sales_planning_enabled: game.sales_planning_enabled,
      pr_tracking_enabled: game.pr_tracking_enabled,
      auto_base_product: false, launch_date: format(new Date(), 'yyyy-MM-dd'), auto_calendar: false
    })
    setModalTarget({ gameId: game.id })
    setModalType('editGame')
  }

  const handleSaveGame = async () => {
    if (!gameForm.name.trim() || !gameForm.client_id) return
    setSaving(true)
    try {
      if (modalType === 'addGame') {
        const res = await fetch('/api/games', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: gameForm.name.trim(),
            client_id: gameForm.client_id,
            steam_app_id: gameForm.steam_app_id.trim() || null,
            sales_planning_enabled: gameForm.sales_planning_enabled,
            pr_tracking_enabled: gameForm.pr_tracking_enabled
          })
        })
        if (!res.ok) throw new Error('Failed to create game')
        const game = await res.json()

        // Auto-create base product if checked
        if (gameForm.auto_base_product) {
          const platformsToUse = baseProductPlatformIds.length > 0 ? baseProductPlatformIds : platforms.map(p => p.id)
          try {
            const productRes = await fetch('/api/products', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: gameForm.name.trim(),
                game_id: game.id,
                product_type: 'base',
                steam_product_id: gameForm.steam_app_id.trim() || null,
                launch_date: gameForm.launch_date,
                platform_ids: platformsToUse
              })
            })
            if (productRes.ok && gameForm.auto_calendar) {
              const product = await productRes.json()
              // Auto-generate calendar
              await fetch('/api/generate-calendar', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  product_id: product.id,
                  product_name: product.name,
                  launch_date: gameForm.launch_date,
                  platform_ids: platformsToUse
                })
              }).catch(() => {})
            }
          } catch (err) {
            console.error('Failed to auto-create base product:', err)
          }
        }

        // Auto-create PR keyword if PR tracking enabled
        if (gameForm.pr_tracking_enabled) {
          await autoCreateKeywords(gameForm.client_id, game.id, gameForm.name.trim())
          triggerBackfill(game.id)
        }

        setActionMessage({ text: `Game created${gameForm.pr_tracking_enabled ? ' with PR tracking' : ''}`, type: 'success' })
      } else {
        // Editing existing game
        const currentGame = clients.flatMap(c => c.games || []).find(g => g.id === modalTarget.gameId)
        const wasDisabled = currentGame && !currentGame.pr_tracking_enabled
        const nowEnabled = gameForm.pr_tracking_enabled

        const res = await fetch('/api/games', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: modalTarget.gameId,
            name: gameForm.name.trim(),
            steam_app_id: gameForm.steam_app_id.trim() || null,
            sales_planning_enabled: gameForm.sales_planning_enabled,
            pr_tracking_enabled: gameForm.pr_tracking_enabled
          })
        })
        if (!res.ok) throw new Error('Failed to update game')

        // If PR tracking was just enabled, auto-create keyword + backfill
        if (wasDisabled && nowEnabled && currentGame) {
          const kwCount = currentGame.keyword_count || 0
          if (kwCount === 0) {
            await autoCreateKeywords(currentGame.client_id, currentGame.id, gameForm.name.trim())
          }
          triggerBackfill(currentGame.id)
        }

        setActionMessage({ text: 'Game updated', type: 'success' })
      }
      setModalType(null)
      fetchData()
    } catch {
      setActionMessage({ text: 'Failed to save game', type: 'error' })
    }
    setSaving(false)
  }

  const handleDeleteGame = async (id: string, name: string) => {
    if (!confirm(`Delete game "${name}"? This will also delete all products, sales, and coverage data.`)) return
    try {
      const res = await fetch(`/api/games?id=${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed')
      setActionMessage({ text: 'Game deleted', type: 'success' })
      fetchData()
    } catch {
      setActionMessage({ text: 'Failed to delete game', type: 'error' })
    }
  }

  const handleToggleGameFlag = async (gameId: string, field: 'sales_planning_enabled' | 'pr_tracking_enabled', currentValue: boolean) => {
    // Optimistic update
    setClients(prev => prev.map(c => ({
      ...c,
      games: c.games?.map(g => g.id === gameId ? { ...g, [field]: !currentValue } : g)
    })))

    try {
      const res = await fetch('/api/games', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: gameId, [field]: !currentValue })
      })
      if (!res.ok) throw new Error('Failed')

      // If enabling PR tracking, auto-create keyword + backfill
      if (field === 'pr_tracking_enabled' && !currentValue) {
        const game = clients.flatMap(c => c.games || []).find(g => g.id === gameId)
        if (game) {
          if (!game.keyword_count || game.keyword_count === 0) {
            await autoCreateKeywords(game.client_id, gameId, game.name)
          }
          triggerBackfill(gameId)
          setActionMessage({ text: `PR tracking enabled for ${game.name} — backfill started`, type: 'success' })
        }
      }
    } catch {
      // Rollback
      setClients(prev => prev.map(c => ({
        ...c,
        games: c.games?.map(g => g.id === gameId ? { ...g, [field]: currentValue } : g)
      })))
      setActionMessage({ text: 'Failed to update toggle', type: 'error' })
    }
  }

  // ── Product CRUD ──────────────────────────────────────────────

  const openAddProduct = (gameId: string) => {
    setProductForm({
      name: '', game_id: gameId, product_type: 'base', steam_product_id: '',
      launch_date: format(new Date(), 'yyyy-MM-dd'), product_aliases: '', auto_calendar: true
    })
    setProductPlatformIds([])
    setModalType('addProduct')
  }

  const openEditProduct = async (product: Product) => {
    setProductForm({
      name: product.name,
      game_id: product.game_id,
      product_type: product.product_type,
      steam_product_id: product.steam_product_id || '',
      launch_date: product.launch_date || format(new Date(), 'yyyy-MM-dd'),
      product_aliases: (product.product_aliases || []).join(', '),
      auto_calendar: false
    })
    setModalTarget({ productId: product.id })
    const { data } = await supabase.from('product_platforms').select('platform_id').eq('product_id', product.id)
    setProductPlatformIds(data ? data.map((pp: { platform_id: string }) => pp.platform_id) : [])
    setModalType('editProduct')
  }

  const handleSaveProduct = async () => {
    if (!productForm.name.trim() || !productForm.game_id) return
    setSaving(true)
    try {
      const aliases = productForm.product_aliases
        ? productForm.product_aliases.split(',').map(a => a.trim()).filter(Boolean)
        : []
      const platformsToUse = productPlatformIds.length > 0 ? productPlatformIds : platforms.map(p => p.id)

      if (modalType === 'addProduct') {
        const res = await fetch('/api/products', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: productForm.name.trim(),
            game_id: productForm.game_id,
            product_type: productForm.product_type,
            steam_product_id: productForm.steam_product_id.trim() || null,
            launch_date: productForm.launch_date,
            product_aliases: aliases.length > 0 ? aliases : undefined,
            platform_ids: platformsToUse
          })
        })
        if (!res.ok) throw new Error('Failed to create product')

        if (productForm.auto_calendar) {
          const product = await res.json()
          await fetch('/api/generate-calendar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              product_id: product.id,
              product_name: product.name,
              launch_date: productForm.launch_date,
              platform_ids: platformsToUse
            })
          }).catch(() => {})
        }

        setActionMessage({ text: 'Product created', type: 'success' })
      } else {
        const res = await fetch('/api/products', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: modalTarget.productId,
            name: productForm.name.trim(),
            product_type: productForm.product_type,
            steam_product_id: productForm.steam_product_id.trim() || null,
            launch_date: productForm.launch_date,
            product_aliases: aliases.length > 0 ? aliases : [],
            platform_ids: productPlatformIds.length > 0 ? productPlatformIds : undefined
          })
        })
        if (!res.ok) throw new Error('Failed to update product')
        setActionMessage({ text: 'Product updated', type: 'success' })
      }
      setModalType(null)
      fetchData()
    } catch {
      setActionMessage({ text: 'Failed to save product', type: 'error' })
    }
    setSaving(false)
  }

  const handleDeleteProduct = async (id: string, name: string) => {
    if (!confirm(`Delete product "${name}"? This will also delete all associated sales.`)) return
    try {
      const res = await fetch(`/api/products?id=${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed')
      setActionMessage({ text: 'Product deleted', type: 'success' })
      fetchData()
    } catch {
      setActionMessage({ text: 'Failed to delete product', type: 'error' })
    }
  }

  // ── PR Tracking helpers ──────────────────────────────────────

  const autoCreateKeywords = async (clientId: string, gameId: string, gameName: string) => {
    try {
      await fetch('/api/coverage-keywords', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, game_id: gameId, keyword: gameName, keyword_type: 'whitelist' })
      })
    } catch (err) {
      console.error('Failed to auto-create keyword:', err)
    }
  }

  const triggerBackfill = (gameId: string) => {
    fetch('/api/coverage-backfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game_id: gameId, max_queries: 20 })
    }).catch(err => console.error('Backfill trigger failed:', err))
  }

  // ── UI helpers ──────────────────────────────────────────────

  const toggleExpanded = (clientId: string) => {
    setExpandedClients(prev => {
      const next = new Set(prev)
      if (next.has(clientId)) next.delete(clientId)
      else next.add(clientId)
      return next
    })
  }

  const toggleGameExpanded = (gameId: string) => {
    setExpandedGames(prev => {
      const next = new Set(prev)
      if (next.has(gameId)) next.delete(gameId)
      else next.add(gameId)
      return next
    })
  }

  const totalGames = (client: Client) => client.games?.length || 0
  const totalProducts = (client: Client) =>
    client.games?.reduce((sum, g) => sum + (g.products?.length || 0), 0) || 0

  // ── Render ──────────────────────────────────────────────────

  if (authLoading || isLoading) {
    return <div style={{ textAlign: 'center', padding: '60px', color: '#64748b' }}>Loading...</div>
  }

  if (!canView) {
    return (
      <div style={{ textAlign: 'center', padding: '60px' }}>
        <h2 style={{ fontSize: '1.5rem', fontWeight: 600, color: '#1f2937' }}>Access Denied</h2>
        <p style={{ color: '#6b7280' }}>You don&apos;t have permission to view Client Management.</p>
      </div>
    )
  }

  return (
    <>
      <div className={styles.container}>
        <div className={styles.topBar}>
          <h1>Clients & Games</h1>
          {canEdit && (
            <div className={styles.topBarActions}>
              <button className={styles.addBtn} onClick={openAddClient}>+ Add Client</button>
            </div>
          )}
        </div>

        {actionMessage && (
          <div className={`${styles.actionMessage} ${actionMessage.type === 'success' ? styles.actionSuccess : styles.actionError}`}>
            {actionMessage.text}
          </div>
        )}

        {clients.length === 0 ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>
              <svg width="40" height="40" fill="none" stroke="#94a3b8" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <h3>No Clients Yet</h3>
            <p>Add your first game publisher client to get started.</p>
            {canEdit && <button className={styles.addBtn} onClick={openAddClient}>Add Your First Client</button>}
          </div>
        ) : (
          <div className={styles.clientList}>
            {clients.map(client => {
              const isExpanded = expandedClients.has(client.id)
              return (
                <div key={client.id} className={styles.clientCard}>
                  <div className={styles.cardHeader} onClick={() => toggleExpanded(client.id)}>
                    <div className={styles.cardTitle}>
                      <span className={styles.expandIcon}>{isExpanded ? '▾' : '▸'}</span>
                      <h3>{client.name}</h3>
                      {client.email && <span className={styles.email}>{client.email}</span>}
                    </div>
                    <div className={styles.cardMeta}>
                      <span className={styles.countBadge}>{totalGames(client)} game{totalGames(client) !== 1 ? 's' : ''}</span>
                      <span className={styles.countBadge}>{totalProducts(client)} product{totalProducts(client) !== 1 ? 's' : ''}</span>
                      {client.sales_planning_enabled && (
                        <span className={`${styles.featureBadge} ${styles.featureOn}`}>Sales</span>
                      )}
                      {client.pr_tracking_enabled && (
                        <span className={`${styles.featureBadge} ${styles.prOn}`}>PR</span>
                      )}
                      {canEdit && (
                        <>
                          <button
                            className={styles.editBtn}
                            onClick={(e) => { e.stopPropagation(); openEditClient(client) }}
                            title="Edit client"
                          >
                            ✎
                          </button>
                          <button
                            className={styles.deleteBtn}
                            onClick={(e) => { e.stopPropagation(); handleDeleteClient(client.id, client.name) }}
                            title="Delete client"
                          >
                            ✕
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {isExpanded && (
                    <div className={styles.cardBody}>
                      {/* Client-level toggles */}
                      {canEdit && (
                        <div className={styles.clientToggles}>
                          <label className={styles.toggleLabel} onClick={e => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={client.sales_planning_enabled}
                              onChange={() => handleToggleClientFlag(client.id, 'sales_planning_enabled', client.sales_planning_enabled)}
                            />
                            Sales Planning
                          </label>
                          <label className={styles.toggleLabel} onClick={e => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={client.pr_tracking_enabled}
                              onChange={() => handleToggleClientFlag(client.id, 'pr_tracking_enabled', client.pr_tracking_enabled)}
                            />
                            PR Coverage
                          </label>
                        </div>
                      )}

                      {/* Games list */}
                      {(!client.games || client.games.length === 0) ? (
                        <p className={styles.noItems}>No games added yet.</p>
                      ) : (
                        client.games.map(game => {
                          const gameExpanded = expandedGames.has(game.id)
                          return (
                            <div key={game.id} className={styles.gameSection}>
                              <div className={styles.gameHeader}>
                                <span
                                  className={styles.expandIcon}
                                  style={{ cursor: 'pointer' }}
                                  onClick={() => toggleGameExpanded(game.id)}
                                >
                                  {gameExpanded ? '▾' : '▸'}
                                </span>
                                <strong onClick={() => toggleGameExpanded(game.id)} style={{ cursor: 'pointer' }}>
                                  {game.name}
                                </strong>
                                {game.steam_app_id && <span className={styles.steamId}>Steam: {game.steam_app_id}</span>}
                                {game.keyword_count !== undefined && game.keyword_count > 0 && (
                                  <span className={styles.kwCount}>{game.keyword_count} kw</span>
                                )}

                                <div className={styles.gameToggles}>
                                  {canEdit ? (
                                    <>
                                      <label className={styles.miniToggle} onClick={e => e.stopPropagation()}>
                                        <input
                                          type="checkbox"
                                          checked={game.sales_planning_enabled}
                                          onChange={() => handleToggleGameFlag(game.id, 'sales_planning_enabled', game.sales_planning_enabled)}
                                        />
                                        Sales
                                      </label>
                                      <label className={styles.miniToggle} onClick={e => e.stopPropagation()}>
                                        <input
                                          type="checkbox"
                                          checked={game.pr_tracking_enabled}
                                          onChange={() => handleToggleGameFlag(game.id, 'pr_tracking_enabled', game.pr_tracking_enabled)}
                                        />
                                        PR
                                      </label>
                                    </>
                                  ) : (
                                    <>
                                      {game.sales_planning_enabled && <span className={`${styles.featureBadge} ${styles.featureOn}`}>Sales</span>}
                                      {game.pr_tracking_enabled && <span className={`${styles.featureBadge} ${styles.prOn}`}>PR</span>}
                                    </>
                                  )}
                                  {canEdit && (
                                    <div className={styles.gameActions}>
                                      <button className={styles.editBtn} onClick={() => openEditGame(game)} title="Edit game">✎</button>
                                      <button className={styles.deleteBtn} onClick={() => handleDeleteGame(game.id, game.name)} title="Delete game">✕</button>
                                    </div>
                                  )}
                                </div>
                              </div>

                              {/* Products under game */}
                              {gameExpanded && (
                                <>
                                  {game.products && game.products.length > 0 ? (
                                    <div className={styles.productList}>
                                      {game.products.map(product => (
                                        <div key={product.id} className={styles.productRow}>
                                          <span className={styles.productName}>{product.name}</span>
                                          <span className={styles.typeBadge}>{product.product_type}</span>
                                          {product.launch_date && (
                                            <span className={styles.launchBadge}>
                                              {format(new Date(product.launch_date), 'MMM d, yyyy')}
                                            </span>
                                          )}
                                          {product.product_aliases && product.product_aliases.length > 0 && (
                                            <span className={styles.aliasesBadge} title={product.product_aliases.join(', ')}>
                                              aka {product.product_aliases[0]}{product.product_aliases.length > 1 ? ` +${product.product_aliases.length - 1}` : ''}
                                            </span>
                                          )}
                                          <div className={styles.platformDots}>
                                            {product.product_platforms?.map(pp => (
                                              <span
                                                key={pp.platform_id}
                                                className={styles.platformDot}
                                                style={{ backgroundColor: pp.platform?.color_hex || '#94a3b8' }}
                                                title={pp.platform?.name || 'Unknown'}
                                              />
                                            ))}
                                            {(!product.product_platforms || product.product_platforms.length === 0) && (
                                              <span className={styles.noPlatforms}>No platforms</span>
                                            )}
                                          </div>
                                          {canEdit && (
                                            <div className={styles.productActions}>
                                              <button className={styles.editBtn} onClick={() => openEditProduct(product)} title="Edit product">✎</button>
                                              <button className={styles.deleteBtn} onClick={() => handleDeleteProduct(product.id, product.name)} title="Delete product">✕</button>
                                            </div>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <p className={styles.noItems} style={{ marginLeft: '16px' }}>No products yet</p>
                                  )}
                                  {canEdit && (
                                    <button className={styles.addProductBtn} onClick={() => openAddProduct(game.id)} style={{ marginLeft: '16px' }}>
                                      + Add Product
                                    </button>
                                  )}
                                </>
                              )}
                            </div>
                          )
                        })
                      )}
                      {canEdit && (
                        <button className={styles.addGameBtn} onClick={() => openAddGame(client.id)}>
                          + Add Game
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Client Modal ── */}
      {(modalType === 'addClient' || modalType === 'editClient') && (
        <div className={styles.overlay}>
          <div className={styles.modal}>
            <div className={styles.modalHeader}>
              <h2>{modalType === 'addClient' ? 'Add Client' : 'Edit Client'}</h2>
              <button className={styles.closeBtn} onClick={() => setModalType(null)}>x</button>
            </div>
            <div className={styles.formField}>
              <label>Client Name *</label>
              <input type="text" value={clientForm.name} onChange={e => setClientForm({ ...clientForm, name: e.target.value })} placeholder="e.g., tobspr Games" autoFocus />
            </div>
            <div className={styles.formField}>
              <label>Email (optional)</label>
              <input type="email" value={clientForm.email} onChange={e => setClientForm({ ...clientForm, email: e.target.value })} placeholder="contact@example.com" />
            </div>
            <div className={styles.formField}>
              <label>Contact Person (optional)</label>
              <input type="text" value={clientForm.contact_person} onChange={e => setClientForm({ ...clientForm, contact_person: e.target.value })} placeholder="John Doe" />
            </div>
            <div className={styles.checkboxField}>
              <label className={styles.checkboxLabel}>
                <input type="checkbox" checked={clientForm.sales_planning_enabled} onChange={e => setClientForm({ ...clientForm, sales_planning_enabled: e.target.checked })} />
                Enable Sales Planning
              </label>
              <p className={styles.checkboxHint}>Show this client&apos;s games in the Sales Timeline</p>
            </div>
            <div className={styles.checkboxField}>
              <label className={styles.checkboxLabel}>
                <input type="checkbox" checked={clientForm.pr_tracking_enabled} onChange={e => setClientForm({ ...clientForm, pr_tracking_enabled: e.target.checked })} />
                Enable PR Coverage
              </label>
              <p className={styles.checkboxHint}>Enable PR coverage tracking for this client&apos;s games</p>
            </div>
            <div className={styles.modalActions}>
              <button className={styles.cancelBtn} onClick={() => setModalType(null)}>Cancel</button>
              <button className={styles.addBtn} onClick={handleSaveClient} disabled={saving || !clientForm.name.trim()}>
                {saving ? 'Saving...' : modalType === 'addClient' ? 'Create Client' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Game Modal ── */}
      {(modalType === 'addGame' || modalType === 'editGame') && (
        <div className={styles.overlay}>
          <div className={styles.modal}>
            <div className={styles.modalHeader}>
              <h2>{modalType === 'addGame' ? 'Add Game' : 'Edit Game'}</h2>
              <button className={styles.closeBtn} onClick={() => setModalType(null)}>x</button>
            </div>
            <div className={styles.formField}>
              <label>Game Name *</label>
              <input type="text" value={gameForm.name} onChange={e => setGameForm({ ...gameForm, name: e.target.value })} placeholder="e.g., shapez 2" autoFocus />
            </div>
            <div className={styles.formField}>
              <label>Steam App ID (optional)</label>
              <input type="text" value={gameForm.steam_app_id} onChange={e => setGameForm({ ...gameForm, steam_app_id: e.target.value })} placeholder="e.g., 1234567" />
            </div>
            <div className={styles.checkboxField}>
              <label className={styles.checkboxLabel}>
                <input type="checkbox" checked={gameForm.sales_planning_enabled} onChange={e => setGameForm({ ...gameForm, sales_planning_enabled: e.target.checked })} />
                Enable Sales Planning
              </label>
              <p className={styles.checkboxHint}>Show in the Sales Timeline</p>
            </div>
            <div className={styles.checkboxField}>
              <label className={styles.checkboxLabel}>
                <input type="checkbox" checked={gameForm.pr_tracking_enabled} onChange={e => setGameForm({ ...gameForm, pr_tracking_enabled: e.target.checked })} />
                Enable PR Coverage
              </label>
              <p className={styles.checkboxHint}>Adds game name as keyword for coverage discovery</p>
            </div>

            {modalType === 'addGame' && (
              <>
                <div className={styles.checkboxField}>
                  <label className={styles.checkboxLabel}>
                    <input type="checkbox" checked={gameForm.auto_base_product} onChange={e => setGameForm({ ...gameForm, auto_base_product: e.target.checked })} />
                    Auto-create base game product
                  </label>
                  <p className={styles.checkboxHint}>Creates a base product with the same name</p>
                </div>

                {gameForm.auto_base_product && (
                  <>
                    <div className={styles.formField}>
                      <label>Launch Date</label>
                      <input type="date" value={gameForm.launch_date} onChange={e => setGameForm({ ...gameForm, launch_date: e.target.value })} />
                    </div>
                    <div className={styles.checkboxField}>
                      <label className={styles.checkboxLabel}>
                        <input type="checkbox" checked={gameForm.auto_calendar} onChange={e => setGameForm({ ...gameForm, auto_calendar: e.target.checked })} />
                        Auto-generate sales calendar
                      </label>
                      <p className={styles.checkboxHint}>Create a 12-month sales plan from launch date</p>
                    </div>
                    <div className={styles.formField}>
                      <label>Platforms</label>
                      <p className={styles.fieldHint}>Leave empty for all platforms</p>
                      <div className={styles.platformCheckboxes}>
                        {platforms.map(p => (
                          <label key={p.id} className={styles.platformCheckbox}>
                            <input type="checkbox" checked={baseProductPlatformIds.includes(p.id)} onChange={e => {
                              if (e.target.checked) setBaseProductPlatformIds(prev => [...prev, p.id])
                              else setBaseProductPlatformIds(prev => prev.filter(id => id !== p.id))
                            }} />
                            <span className={styles.platformColorDot} style={{ backgroundColor: p.color_hex }} />
                            {p.name}
                          </label>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </>
            )}

            <div className={styles.modalActions}>
              <button className={styles.cancelBtn} onClick={() => setModalType(null)}>Cancel</button>
              <button className={styles.addBtn} onClick={handleSaveGame} disabled={saving || !gameForm.name.trim()}>
                {saving ? 'Saving...' : modalType === 'addGame' ? 'Create Game' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Product Modal ── */}
      {(modalType === 'addProduct' || modalType === 'editProduct') && (
        <div className={styles.overlay}>
          <div className={styles.modal}>
            <div className={styles.modalHeader}>
              <h2>{modalType === 'addProduct' ? 'Add Product' : 'Edit Product'}</h2>
              <button className={styles.closeBtn} onClick={() => setModalType(null)}>x</button>
            </div>
            <div className={styles.formField}>
              <label>Product Name *</label>
              <input type="text" value={productForm.name} onChange={e => setProductForm({ ...productForm, name: e.target.value })} placeholder="e.g., shapez 2 Soundtrack" autoFocus />
            </div>
            <div className={styles.formField}>
              <label>Product Type</label>
              <select value={productForm.product_type} onChange={e => setProductForm({ ...productForm, product_type: e.target.value })}>
                <option value="base">Base Game</option>
                <option value="dlc">DLC</option>
                <option value="edition">Edition/Bundle</option>
                <option value="soundtrack">Soundtrack</option>
                <option value="bundle">Bundle</option>
              </select>
            </div>
            <div className={styles.formField}>
              <label>Launch Date</label>
              <input type="date" value={productForm.launch_date} onChange={e => setProductForm({ ...productForm, launch_date: e.target.value })} />
            </div>
            <div className={styles.formField}>
              <label>Steam Product ID (optional)</label>
              <input type="text" value={productForm.steam_product_id} onChange={e => setProductForm({ ...productForm, steam_product_id: e.target.value })} placeholder="e.g., 1234567" />
            </div>
            <div className={styles.formField}>
              <label>Import Aliases (optional)</label>
              <input type="text" value={productForm.product_aliases} onChange={e => setProductForm({ ...productForm, product_aliases: e.target.value })} placeholder="Comma-separated, e.g., Tomorrow, WWH Tomorrow" />
              <p className={styles.fieldHint}>Alternate names for CSV import matching</p>
            </div>

            {modalType === 'addProduct' && (
              <div className={styles.checkboxField}>
                <label className={styles.checkboxLabel}>
                  <input type="checkbox" checked={productForm.auto_calendar} onChange={e => setProductForm({ ...productForm, auto_calendar: e.target.checked })} />
                  Auto-generate sales calendar
                </label>
                <p className={styles.checkboxHint}>Create a 12-month sales plan from launch date</p>
              </div>
            )}

            <div className={styles.formField}>
              <label>Platforms</label>
              <p className={styles.fieldHint}>Leave empty for all platforms</p>
              <div className={styles.platformCheckboxes}>
                {platforms.map(p => (
                  <label key={p.id} className={styles.platformCheckbox}>
                    <input type="checkbox" checked={productPlatformIds.includes(p.id)} onChange={e => {
                      if (e.target.checked) setProductPlatformIds(prev => [...prev, p.id])
                      else setProductPlatformIds(prev => prev.filter(id => id !== p.id))
                    }} />
                    <span className={styles.platformColorDot} style={{ backgroundColor: p.color_hex }} />
                    {p.name}
                  </label>
                ))}
              </div>
              {productPlatformIds.length > 0 && (
                <p className={styles.selectedCount}>{productPlatformIds.length} platform{productPlatformIds.length === 1 ? '' : 's'} selected</p>
              )}
            </div>

            <div className={styles.modalActions}>
              <button className={styles.cancelBtn} onClick={() => setModalType(null)}>Cancel</button>
              <button className={styles.addBtn} onClick={handleSaveProduct} disabled={saving || !productForm.name.trim()}>
                {saving ? 'Saving...' : modalType === 'addProduct' ? 'Create Product' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
