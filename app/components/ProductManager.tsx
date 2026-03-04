'use client'

import { useState } from 'react'
import { format } from 'date-fns'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import { Client, Game, Platform, Product } from '@/lib/types'
import styles from './ProductManager.module.css'

interface ProductManagerProps {
  clients: Client[]
  games: (Game & { client: Client })[]
  products: (Product & { game: Game & { client: Client } })[]
  platforms: Platform[]
  onClientCreate: (client: Omit<Client, 'id' | 'created_at'>) => Promise<void>
  onGameCreate: (game: Omit<Game, 'id' | 'created_at'>) => Promise<(Game & { client: Client }) | void>
  onProductCreate: (product: Omit<Product, 'id' | 'created_at'>, platformIds?: string[]) => Promise<Product | void>
  onClientDelete?: (id: string) => Promise<void>
  onGameDelete?: (id: string) => Promise<void>
  onProductDelete?: (id: string) => Promise<void>
  onClientUpdate?: (id: string, updates: Partial<Client>) => Promise<void>
  onGameUpdate?: (id: string, updates: Partial<Game>) => Promise<void>
  onProductUpdate?: (id: string, updates: Partial<Product>, platformIds?: string[]) => Promise<void>
  onGenerateCalendar?: (productId: string, productName: string, launchDate?: string, platformIds?: string[]) => void
  onClose: () => void
}

type Tab = 'clients' | 'games' | 'products'

interface EditingState {
  type: 'client' | 'game' | 'product'
  id: string
  data: any
}

export default function ProductManager({
  clients,
  games,
  products,
  platforms,
  onClientCreate,
  onGameCreate,
  onProductCreate,
  onClientDelete,
  onGameDelete,
  onProductDelete,
  onClientUpdate,
  onGameUpdate,
  onProductUpdate,
  onGenerateCalendar,
  onClose
}: ProductManagerProps) {
  const supabase = createClientComponentClient()
  const [activeTab, setActiveTab] = useState<Tab>('clients')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: string; id: string; name: string } | null>(null)
  const [editing, setEditing] = useState<EditingState | null>(null)
  const [editPlatformIds, setEditPlatformIds] = useState<string[]>([])
  
  // Client form
  const [clientName, setClientName] = useState('')
  const [clientEmail, setClientEmail] = useState('')
  
  // Game form
  const [gameName, setGameName] = useState('')
  const [gameClientId, setGameClientId] = useState('')
  const [steamAppId, setSteamAppId] = useState('')
  const [autoCreateBaseProduct, setAutoCreateBaseProduct] = useState(true)
  const [baseLaunchDate, setBaseLaunchDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  
  // Product form
  const [productName, setProductName] = useState('')
  const [productGameId, setProductGameId] = useState('')
  const [productType, setProductType] = useState<'base' | 'edition' | 'dlc' | 'soundtrack'>('base')
  const [steamProductId, setSteamProductId] = useState('')
  const [launchDate, setLaunchDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [autoGenerateCalendar, setAutoGenerateCalendar] = useState(true)
  // Selected platforms for the product (default: all platforms)
  const [selectedPlatformIds, setSelectedPlatformIds] = useState<string[]>([])
  // Game form selected platforms for auto-created base product
  const [baseProductPlatformIds, setBaseProductPlatformIds] = useState<string[]>([])

  const handleCreateClient = async () => {
    if (!clientName.trim()) {
      setError('Client name is required')
      return
    }
    
    setLoading(true)
    setError(null)
    
    try {
      await onClientCreate({
        name: clientName.trim(),
        email: clientEmail.trim() || undefined,
        steam_api_key: undefined
      })
      setClientName('')
      setClientEmail('')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleCreateGame = async () => {
    if (!gameName.trim() || !gameClientId) {
      setError('Game name and client are required')
      return
    }

    setLoading(true)
    setError(null)

    const gameNameTrimmed = gameName.trim()
    const steamAppIdTrimmed = steamAppId.trim() || undefined
    const shouldAutoCreate = autoCreateBaseProduct
    const launchDateToUse = baseLaunchDate

    try {
      // Create the game and get the returned data
      const createdGame = await onGameCreate({
        name: gameNameTrimmed,
        client_id: gameClientId,
        steam_app_id: steamAppIdTrimmed,
        pr_tracking_enabled: false
      })

      // If auto-create base product is enabled and we got the game back
      if (shouldAutoCreate && createdGame) {
        // Use selected platforms, or all platforms if none selected
        const platformsToUse = baseProductPlatformIds.length > 0 ? baseProductPlatformIds : platforms.map(p => p.id)

        try {
          const createdProduct = await onProductCreate({
            name: gameNameTrimmed, // Same name as game
            game_id: createdGame.id,
            product_type: 'base',
            steam_product_id: steamAppIdTrimmed,
            launch_date: launchDateToUse
          }, platformsToUse)

          // Optionally auto-generate calendar for the base product
          if (createdProduct && onGenerateCalendar && autoGenerateCalendar) {
            onGenerateCalendar(createdProduct.id, createdProduct.name, launchDateToUse, platformsToUse)
          }
        } catch (productErr: any) {
          console.error('Failed to auto-create base product:', productErr)
          // Show error but don't block - game was created successfully
          setError(`Game created, but base product failed: ${productErr.message}`)
        }
      }

      setGameName('')
      setSteamAppId('')
      setBaseLaunchDate(format(new Date(), 'yyyy-MM-dd'))
      setBaseProductPlatformIds([])
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleCreateProduct = async () => {
    if (!productName.trim() || !productGameId) {
      setError('Product name and game are required')
      return
    }
    
    setLoading(true)
    setError(null)
    
    const nameToCreate = productName.trim()
    const launchDateToUse = launchDate
    // Use selected platforms, or all platforms if none selected
    const platformsToUse = selectedPlatformIds.length > 0 ? selectedPlatformIds : platforms.map(p => p.id)

    try {
      const createdProduct = await onProductCreate({
        name: nameToCreate,
        game_id: productGameId,
        product_type: productType,
        steam_product_id: steamProductId.trim() || undefined,
        launch_date: launchDateToUse
      }, platformsToUse)

      if (autoGenerateCalendar && createdProduct && onGenerateCalendar) {
        // Pass platform IDs to calendar generator so it only generates for selected platforms
        onGenerateCalendar(createdProduct.id, createdProduct.name, launchDateToUse, platformsToUse)
      }

      setProductName('')
      setSteamProductId('')
      setLaunchDate(format(new Date(), 'yyyy-MM-dd'))
      setSelectedPlatformIds([])
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteConfirm) return
    
    setLoading(true)
    setError(null)
    
    try {
      if (deleteConfirm.type === 'client' && onClientDelete) {
        await onClientDelete(deleteConfirm.id)
      } else if (deleteConfirm.type === 'game' && onGameDelete) {
        await onGameDelete(deleteConfirm.id)
      } else if (deleteConfirm.type === 'product' && onProductDelete) {
        await onProductDelete(deleteConfirm.id)
      }
      setDeleteConfirm(null)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // Start editing
  const startEditClient = (client: Client) => {
    setEditing({
      type: 'client',
      id: client.id,
      data: { name: client.name, email: client.email || '' }
    })
  }

  const startEditGame = (game: Game & { client: Client }) => {
    setEditing({
      type: 'game',
      id: game.id,
      data: { name: game.name, client_id: game.client_id, steam_app_id: game.steam_app_id || '' }
    })
  }

  const startEditProduct = async (product: Product & { game: Game & { client: Client } }) => {
    setEditing({
      type: 'product',
      id: product.id,
      data: {
        name: product.name,
        game_id: product.game_id,
        product_type: product.product_type,
        steam_product_id: product.steam_product_id || '',
        launch_date: product.launch_date || format(new Date(), 'yyyy-MM-dd')
      }
    })
    // Fetch existing platform assignments
    const { data } = await supabase
      .from('product_platforms')
      .select('platform_id')
      .eq('product_id', product.id)
    setEditPlatformIds(data ? data.map((pp: { platform_id: string }) => pp.platform_id) : [])
  }

  // Save edits
  const handleSaveEdit = async () => {
    if (!editing) return
    
    setLoading(true)
    setError(null)
    
    try {
      if (editing.type === 'client' && onClientUpdate) {
        await onClientUpdate(editing.id, {
          name: editing.data.name.trim(),
          email: editing.data.email.trim() || undefined
        })
      } else if (editing.type === 'game' && onGameUpdate) {
        await onGameUpdate(editing.id, {
          name: editing.data.name.trim(),
          client_id: editing.data.client_id,
          steam_app_id: editing.data.steam_app_id.trim() || undefined
        })
      } else if (editing.type === 'product' && onProductUpdate) {
        await onProductUpdate(editing.id, {
          name: editing.data.name.trim(),
          game_id: editing.data.game_id,
          product_type: editing.data.product_type,
          steam_product_id: editing.data.steam_product_id.trim() || undefined,
          launch_date: editing.data.launch_date
        }, editPlatformIds.length > 0 ? editPlatformIds : undefined)
      }
      setEditing(null)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const updateEditData = (field: string, value: any) => {
    if (!editing) return
    setEditing({
      ...editing,
      data: { ...editing.data, [field]: value }
    })
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <h2>Manage Products</h2>
          <button className={styles.closeBtn} onClick={onClose}>×</button>
        </div>

        {error && (
          <div className={styles.error}>
            {error}
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {deleteConfirm && (
          <div className={styles.confirmDelete}>
            <p>Delete <strong>{deleteConfirm.name}</strong>?</p>
            <p className={styles.warning}>This will also delete all related data (games, products, sales).</p>
            <div className={styles.confirmActions}>
              <button className={styles.cancelBtn} onClick={() => setDeleteConfirm(null)}>Cancel</button>
              <button className={styles.deleteConfirmBtn} onClick={handleDelete} disabled={loading}>
                {loading ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        )}

        <div className={styles.tabs}>
          <button 
            className={`${styles.tab} ${activeTab === 'clients' ? styles.active : ''}`}
            onClick={() => setActiveTab('clients')}
          >
            Clients ({clients.length})
          </button>
          <button 
            className={`${styles.tab} ${activeTab === 'games' ? styles.active : ''}`}
            onClick={() => setActiveTab('games')}
          >
            Games ({games.length})
          </button>
          <button 
            className={`${styles.tab} ${activeTab === 'products' ? styles.active : ''}`}
            onClick={() => setActiveTab('products')}
          >
            Products ({products.length})
          </button>
        </div>

        <div className={styles.content}>
          {activeTab === 'clients' && (
            <div className={styles.section}>
              <h3>Add New Client</h3>
              <p className={styles.hint}>Clients are the game publishers you work with (e.g., TMG, tobspr)</p>
              
              <div className={styles.form}>
                <div className={styles.field}>
                  <label>Client Name *</label>
                  <input
                    type="text"
                    value={clientName}
                    onChange={(e) => setClientName(e.target.value)}
                    placeholder="e.g., tobspr Games"
                  />
                </div>
                <div className={styles.field}>
                  <label>Email</label>
                  <input
                    type="email"
                    value={clientEmail}
                    onChange={(e) => setClientEmail(e.target.value)}
                    placeholder="contact@example.com"
                  />
                </div>
                <button 
                  className={styles.addBtn}
                  onClick={handleCreateClient}
                  disabled={loading}
                >
                  {loading ? 'Adding...' : '+ Add Client'}
                </button>
              </div>

              <div className={styles.list}>
                <h4>Existing Clients</h4>
                {clients.length === 0 ? (
                  <p className={styles.empty}>No clients yet. Add your first client above.</p>
                ) : (
                  <ul>
                    {clients.map(client => (
                      <li key={client.id} className={editing?.type === 'client' && editing?.id === client.id ? styles.editing : ''}>
                        {editing?.type === 'client' && editing?.id === client.id ? (
                          <div className={styles.editForm}>
                            <input
                              type="text"
                              value={editing.data.name}
                              onChange={(e) => updateEditData('name', e.target.value)}
                              placeholder="Client Name"
                            />
                            <input
                              type="email"
                              value={editing.data.email}
                              onChange={(e) => updateEditData('email', e.target.value)}
                              placeholder="Email"
                            />
                            <div className={styles.editActions}>
                              <button className={styles.saveBtn} onClick={handleSaveEdit} disabled={loading}>
                                {loading ? '...' : '✓'}
                              </button>
                              <button className={styles.cancelEditBtn} onClick={() => setEditing(null)}>✕</button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className={styles.itemInfo}>
                              <strong>{client.name}</strong>
                              {client.email && <span> - {client.email}</span>}
                            </div>
                            <div className={styles.itemActions}>
                              {onClientUpdate && (
                                <button 
                                  className={styles.editBtn}
                                  onClick={() => startEditClient(client)}
                                  title="Edit client"
                                >
                                  ✏️
                                </button>
                              )}
                              {onClientDelete && (
                                <button 
                                  className={styles.deleteBtn}
                                  onClick={() => setDeleteConfirm({ type: 'client', id: client.id, name: client.name })}
                                  title="Delete client"
                                >
                                  🗑️
                                </button>
                              )}
                            </div>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {activeTab === 'games' && (
            <div className={styles.section}>
              <h3>Add New Game</h3>
              <p className={styles.hint}>Games belong to clients. Add the client first if needed.</p>
              
              {clients.length === 0 ? (
                <div className={styles.warningBox}>
                  Please add a client first before adding games.
                </div>
              ) : (
                <div className={styles.form}>
                  <div className={styles.field}>
                    <label>Client *</label>
                    <select
                      value={gameClientId}
                      onChange={(e) => setGameClientId(e.target.value)}
                    >
                      <option value="">Select client...</option>
                      {clients.map(client => (
                        <option key={client.id} value={client.id}>{client.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className={styles.field}>
                    <label>Game Name *</label>
                    <input
                      type="text"
                      value={gameName}
                      onChange={(e) => setGameName(e.target.value)}
                      placeholder="e.g., shapez 2"
                    />
                  </div>
                  <div className={styles.field}>
                    <label>Steam App ID</label>
                    <input
                      type="text"
                      value={steamAppId}
                      onChange={(e) => setSteamAppId(e.target.value)}
                      placeholder="e.g., 1234567"
                    />
                  </div>

                  {/* Auto-create base product checkbox */}
                  <div className={styles.checkboxField}>
                    <label className={styles.checkboxLabel}>
                      <input
                        type="checkbox"
                        checked={autoCreateBaseProduct}
                        onChange={(e) => setAutoCreateBaseProduct(e.target.checked)}
                      />
                      <span className={styles.checkboxText}>
                        🎮 Auto-create base game product
                      </span>
                    </label>
                    <p className={styles.checkboxHint}>
                      Automatically create a &quot;base game&quot; product with the same name
                    </p>
                  </div>

                  {autoCreateBaseProduct && (
                    <>
                      <div className={styles.field}>
                        <label>Base Game Launch Date *</label>
                        <input
                          type="date"
                          value={baseLaunchDate}
                          onChange={(e) => setBaseLaunchDate(e.target.value)}
                        />
                        <p className={styles.fieldHint}>Launch date for the base product</p>
                      </div>

                      {onGenerateCalendar && (
                        <div className={styles.checkboxField}>
                          <label className={styles.checkboxLabel}>
                            <input
                              type="checkbox"
                              checked={autoGenerateCalendar}
                              onChange={(e) => setAutoGenerateCalendar(e.target.checked)}
                            />
                            <span className={styles.checkboxText}>
                              🗓️ Auto-generate sales calendar
                            </span>
                          </label>
                          <p className={styles.checkboxHint}>
                            Create a 12-month sales plan from launch date
                          </p>
                        </div>
                      )}

                      {/* Platform Selection for auto-created base product */}
                      <div className={styles.field}>
                        <label>Available Platforms</label>
                        <p className={styles.fieldHint}>
                          Select which platforms the base product is available on. Leave empty for all platforms.
                        </p>
                        <div className={styles.platformCheckboxes}>
                          {platforms.map(platform => (
                            <label key={platform.id} className={styles.platformCheckbox}>
                              <input
                                type="checkbox"
                                checked={baseProductPlatformIds.includes(platform.id)}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setBaseProductPlatformIds(prev => [...prev, platform.id])
                                  } else {
                                    setBaseProductPlatformIds(prev => prev.filter(id => id !== platform.id))
                                  }
                                }}
                              />
                              <span
                                className={styles.platformColorDot}
                                style={{ backgroundColor: platform.color_hex }}
                              />
                              <span>{platform.name}</span>
                            </label>
                          ))}
                        </div>
                        {baseProductPlatformIds.length > 0 && (
                          <p className={styles.selectedCount}>
                            {baseProductPlatformIds.length} platform{baseProductPlatformIds.length === 1 ? '' : 's'} selected
                          </p>
                        )}
                      </div>
                    </>
                  )}

                  <button
                    className={styles.addBtn}
                    onClick={handleCreateGame}
                    disabled={loading}
                  >
                    {loading ? 'Adding...' : autoCreateBaseProduct ? '+ Add Game & Base Product' : '+ Add Game'}
                  </button>
                </div>
              )}

              <div className={styles.list}>
                <h4>Existing Games</h4>
                {games.length === 0 ? (
                  <p className={styles.empty}>No games yet.</p>
                ) : (
                  <ul>
                    {games.map(game => (
                      <li key={game.id} className={editing?.type === 'game' && editing?.id === game.id ? styles.editing : ''}>
                        {editing?.type === 'game' && editing?.id === game.id ? (
                          <div className={styles.editForm}>
                            <select
                              value={editing.data.client_id}
                              onChange={(e) => updateEditData('client_id', e.target.value)}
                            >
                              {clients.map(client => (
                                <option key={client.id} value={client.id}>{client.name}</option>
                              ))}
                            </select>
                            <input
                              type="text"
                              value={editing.data.name}
                              onChange={(e) => updateEditData('name', e.target.value)}
                              placeholder="Game Name"
                            />
                            <input
                              type="text"
                              value={editing.data.steam_app_id}
                              onChange={(e) => updateEditData('steam_app_id', e.target.value)}
                              placeholder="Steam App ID"
                            />
                            <div className={styles.editActions}>
                              <button className={styles.saveBtn} onClick={handleSaveEdit} disabled={loading}>
                                {loading ? '...' : '✓'}
                              </button>
                              <button className={styles.cancelEditBtn} onClick={() => setEditing(null)}>✕</button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className={styles.itemInfo}>
                              <strong>{game.name}</strong>
                              <span className={styles.meta}> ({game.client?.name})</span>
                              {game.steam_app_id && <span className={styles.meta}> - Steam: {game.steam_app_id}</span>}
                              {game.pr_tracking_enabled ? (
                                <span className={styles.prBadgeOn}>PR On</span>
                              ) : (
                                <span className={styles.prBadgeOff}>PR Off</span>
                              )}
                            </div>
                            <div className={styles.itemActions}>
                              {onGameUpdate && (
                                <button
                                  className={styles.prToggle}
                                  onClick={() => onGameUpdate(game.id, { pr_tracking_enabled: !game.pr_tracking_enabled })}
                                  title={game.pr_tracking_enabled ? 'Disable PR tracking' : 'Enable PR tracking'}
                                >
                                  {game.pr_tracking_enabled ? 'Disable PR' : 'Enable PR'}
                                </button>
                              )}
                              {onGameUpdate && (
                                <button
                                  className={styles.editBtn}
                                  onClick={() => startEditGame(game)}
                                  title="Edit game"
                                >
                                  ✏️
                                </button>
                              )}
                              {onGameDelete && (
                                <button
                                  className={styles.deleteBtn}
                                  onClick={() => setDeleteConfirm({ type: 'game', id: game.id, name: game.name })}
                                  title="Delete game"
                                >
                                  🗑️
                                </button>
                              )}
                            </div>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {activeTab === 'products' && (
            <div className={styles.section}>
              <h3>Add New Product</h3>
              <p className={styles.hint}>Products are specific SKUs: base game, DLCs, soundtracks, editions.</p>
              
              {games.length === 0 ? (
                <div className={styles.warningBox}>
                  Please add a game first before adding products.
                </div>
              ) : (
                <div className={styles.form}>
                  <div className={styles.field}>
                    <label>Game *</label>
                    <select
                      value={productGameId}
                      onChange={(e) => setProductGameId(e.target.value)}
                    >
                      <option value="">Select game...</option>
                      {games.map(game => (
                        <option key={game.id} value={game.id}>
                          {game.name} ({game.client?.name})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className={styles.field}>
                    <label>Product Name *</label>
                    <input
                      type="text"
                      value={productName}
                      onChange={(e) => setProductName(e.target.value)}
                      placeholder="e.g., shapez 2, shapez 2 Soundtrack"
                    />
                  </div>
                  <div className={styles.field}>
                    <label>Product Type *</label>
                    <select
                      value={productType}
                      onChange={(e) => setProductType(e.target.value as any)}
                    >
                      <option value="base">Base Game</option>
                      <option value="dlc">DLC</option>
                      <option value="edition">Edition/Bundle</option>
                      <option value="soundtrack">Soundtrack</option>
                    </select>
                  </div>
                  <div className={styles.field}>
                    <label>Launch Date *</label>
                    <input
                      type="date"
                      value={launchDate}
                      onChange={(e) => setLaunchDate(e.target.value)}
                    />
                    <p className={styles.fieldHint}>Sales calendar will be generated for 12 months from this date</p>
                  </div>
                  <div className={styles.field}>
                    <label>Steam Product ID</label>
                    <input
                      type="text"
                      value={steamProductId}
                      onChange={(e) => setSteamProductId(e.target.value)}
                      placeholder="e.g., 1234567"
                    />
                  </div>
                  
                  {onGenerateCalendar && (
                    <div className={styles.checkboxField}>
                      <label className={styles.checkboxLabel}>
                        <input
                          type="checkbox"
                          checked={autoGenerateCalendar}
                          onChange={(e) => setAutoGenerateCalendar(e.target.checked)}
                        />
                        <span className={styles.checkboxText}>
                          🗓️ Auto-generate sales calendar
                        </span>
                      </label>
                      <p className={styles.checkboxHint}>
                        Automatically create a 12-month sales plan from launch date
                      </p>
                    </div>
                  )}

                  {/* Platform Selection */}
                  <div className={styles.field}>
                    <label>Available Platforms</label>
                    <p className={styles.fieldHint}>
                      Select which platforms this product is available on. Leave empty for all platforms.
                    </p>
                    <div className={styles.platformCheckboxes}>
                      {platforms.map(platform => (
                        <label key={platform.id} className={styles.platformCheckbox}>
                          <input
                            type="checkbox"
                            checked={selectedPlatformIds.includes(platform.id)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedPlatformIds(prev => [...prev, platform.id])
                              } else {
                                setSelectedPlatformIds(prev => prev.filter(id => id !== platform.id))
                              }
                            }}
                          />
                          <span
                            className={styles.platformColorDot}
                            style={{ backgroundColor: platform.color_hex }}
                          />
                          <span>{platform.name}</span>
                        </label>
                      ))}
                    </div>
                    {selectedPlatformIds.length > 0 && (
                      <p className={styles.selectedCount}>
                        {selectedPlatformIds.length} platform{selectedPlatformIds.length === 1 ? '' : 's'} selected
                      </p>
                    )}
                  </div>

                  <button
                    className={styles.addBtn}
                    onClick={handleCreateProduct}
                    disabled={loading}
                  >
                    {loading ? 'Adding...' : '+ Add Product'}
                  </button>
                </div>
              )}

              <div className={styles.list}>
                <h4>Existing Products</h4>
                {products.length === 0 ? (
                  <p className={styles.empty}>No products yet.</p>
                ) : (
                  <ul>
                    {products.map(product => (
                      <li key={product.id} className={editing?.type === 'product' && editing?.id === product.id ? styles.editing : ''}>
                        {editing?.type === 'product' && editing?.id === product.id ? (
                          <div className={styles.editForm}>
                            <select
                              value={editing.data.game_id}
                              onChange={(e) => updateEditData('game_id', e.target.value)}
                            >
                              {games.map(game => (
                                <option key={game.id} value={game.id}>
                                  {game.name} ({game.client?.name})
                                </option>
                              ))}
                            </select>
                            <input
                              type="text"
                              value={editing.data.name}
                              onChange={(e) => updateEditData('name', e.target.value)}
                              placeholder="Product Name"
                            />
                            <select
                              value={editing.data.product_type}
                              onChange={(e) => updateEditData('product_type', e.target.value)}
                            >
                              <option value="base">Base Game</option>
                              <option value="dlc">DLC</option>
                              <option value="edition">Edition/Bundle</option>
                              <option value="soundtrack">Soundtrack</option>
                            </select>
                            <input
                              type="date"
                              value={editing.data.launch_date}
                              onChange={(e) => updateEditData('launch_date', e.target.value)}
                            />
                            <input
                              type="text"
                              value={editing.data.steam_product_id}
                              onChange={(e) => updateEditData('steam_product_id', e.target.value)}
                              placeholder="Steam Product ID"
                            />
                            <div className={styles.platformCheckboxes}>
                              {platforms.map(platform => (
                                <label key={platform.id} className={styles.platformCheckbox}>
                                  <input
                                    type="checkbox"
                                    checked={editPlatformIds.includes(platform.id)}
                                    onChange={(e) => {
                                      if (e.target.checked) {
                                        setEditPlatformIds(prev => [...prev, platform.id])
                                      } else {
                                        setEditPlatformIds(prev => prev.filter(id => id !== platform.id))
                                      }
                                    }}
                                  />
                                  <span className={styles.platformColorDot} style={{ backgroundColor: platform.color_hex }} />
                                  <span>{platform.name}</span>
                                </label>
                              ))}
                            </div>
                            <div className={styles.editActions}>
                              <button className={styles.saveBtn} onClick={handleSaveEdit} disabled={loading}>
                                {loading ? '...' : '✓'}
                              </button>
                              <button className={styles.cancelEditBtn} onClick={() => setEditing(null)}>✕</button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className={styles.itemInfo}>
                              <strong>{product.name}</strong>
                              <span className={styles.badge}>{product.product_type}</span>
                              {product.launch_date && (
                                <span className={styles.launchBadge}>
                                  🚀 {format(new Date(product.launch_date), 'MMM d, yyyy')}
                                </span>
                              )}
                              <span className={styles.meta}> - {product.game?.name} ({product.game?.client?.name})</span>
                            </div>
                            <div className={styles.itemActions}>
                              {onProductUpdate && (
                                <button 
                                  className={styles.editBtn}
                                  onClick={() => startEditProduct(product)}
                                  title="Edit product"
                                >
                                  ✏️
                                </button>
                              )}
                              {onProductDelete && (
                                <button 
                                  className={styles.deleteBtn}
                                  onClick={() => setDeleteConfirm({ type: 'product', id: product.id, name: product.name })}
                                  title="Delete product"
                                >
                                  🗑️
                                </button>
                              )}
                            </div>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>

        <div className={styles.footer}>
          <button className={styles.doneBtn} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
