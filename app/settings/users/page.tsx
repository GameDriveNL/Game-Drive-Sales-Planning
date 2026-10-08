'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/lib/auth-context'
import { FEATURES, type Role, type AccessLevel } from '@/lib/auth'

interface UserProfile {
  id: string
  email: string
  display_name: string | null
  role: Role
  is_active: boolean
  all_clients: boolean
  created_at: string
}

interface UserPermission {
  user_id: string
  feature: string
  access_level: AccessLevel
}

interface ClientInfo {
  id: string
  name: string
}

interface UserClient {
  user_id: string
  client_id: string
}

export default function UsersSettingsPage() {
  const { isSuperAdmin, loading: authLoading } = useAuth()
  const router = useRouter()

  const [users, setUsers] = useState<UserProfile[]>([])
  const [permissions, setPermissions] = useState<UserPermission[]>([])
  const [clients, setClients] = useState<ClientInfo[]>([])
  const [userClients, setUserClients] = useState<UserClient[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Create user form
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [newRole, setNewRole] = useState<Role>('viewer')
  const [newAllClients, setNewAllClients] = useState(false)
  const [newClientIds, setNewClientIds] = useState<string[]>([])
  const [newPermissions, setNewPermissions] = useState<Record<string, AccessLevel>>({})
  const [creating, setCreating] = useState(false)
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Edit user modal
  const [editingUser, setEditingUser] = useState<UserProfile | null>(null)
  const [editRole, setEditRole] = useState<Role>('viewer')
  const [editDisplayName, setEditDisplayName] = useState('')
  const [editAllClients, setEditAllClients] = useState(false)
  const [editPermissions, setEditPermissions] = useState<Record<string, AccessLevel>>({})
  const [editClientIds, setEditClientIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  // Delete user
  const [deletingUser, setDeletingUser] = useState<UserProfile | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [mfaUserIds, setMfaUserIds] = useState<string[]>([])

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/users')
      if (!res.ok) throw new Error('Failed to load users')
      const data = await res.json()
      setUsers(data.users)
      setMfaUserIds(data.mfaUserIds ?? [])
      setPermissions(data.permissions)
      setClients(data.clients)
      setUserClients(data.userClients)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!authLoading && !isSuperAdmin) {
      router.push('/')
      return
    }
    if (!authLoading && isSuperAdmin) {
      fetchData()
    }
  }, [authLoading, isSuperAdmin, router, fetchData])

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault()
    setCreating(true)
    setError(null)

    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: newEmail,
          role: newRole,
          allClients: newRole !== 'superadmin' ? newAllClients : true,
          clientIds: newRole !== 'superadmin' && !newAllClients ? newClientIds : [],
          permissions: newRole !== 'superadmin'
            ? Object.entries(newPermissions)
                .filter(([, level]) => level !== 'none')
                .map(([feature, access_level]) => ({ feature, access_level }))
            : [],
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      setInviteUrl(data.inviteUrl)
      await fetchData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user')
    } finally {
      setCreating(false)
    }
  }

  const handleCloseInvite = () => {
    setInviteUrl(null)
    setCopied(false)
    setNewEmail('')
    setNewRole('viewer')
    setNewAllClients(false)
    setNewClientIds([])
    setNewPermissions({})
    setShowCreateForm(false)
  }

  const handleCopyInvite = async () => {
    if (inviteUrl) {
      await navigator.clipboard.writeText(inviteUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const openEditModal = (user: UserProfile) => {
    setEditingUser(user)
    setEditRole(user.role)
    setEditDisplayName(user.display_name || '')
    setEditAllClients(user.all_clients || false)

    // Load current permissions
    const userPerms: Record<string, AccessLevel> = {}
    permissions
      .filter((p) => p.user_id === user.id)
      .forEach((p) => { userPerms[p.feature] = p.access_level })
    setEditPermissions(userPerms)

    // Load current client assignments
    setEditClientIds(
      userClients.filter((uc) => uc.user_id === user.id).map((uc) => uc.client_id)
    )
  }

  const handleSaveUser = async () => {
    if (!editingUser) return
    setSaving(true)
    setError(null)

    try {
      // Update profile
      await fetch('/api/admin/users', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: editingUser.id,
          action: 'update_profile',
          role: editRole,
          display_name: editDisplayName || null,
          all_clients: editRole !== 'superadmin' ? editAllClients : true,
        }),
      })

      // Update permissions
      const permArray = Object.entries(editPermissions)
        .filter(([, level]) => level !== 'none')
        .map(([feature, access_level]) => ({ feature, access_level }))

      await fetch('/api/admin/users', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: editingUser.id,
          action: 'set_permissions',
          permissions: permArray,
        }),
      })

      // Update client assignments
      await fetch('/api/admin/users', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: editingUser.id,
          action: 'set_clients',
          clientIds: editAllClients ? [] : editClientIds,
        }),
      })

      setEditingUser(null)
      await fetchData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleToggleActive = async (user: UserProfile) => {
    await fetch('/api/admin/users', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: user.id,
        action: 'update_profile',
        is_active: !user.is_active,
      }),
    })
    await fetchData()
  }

  const handleResetMfa = async (user: UserProfile) => {
    const name = user.display_name || user.email
    if (!window.confirm(`Reset two-factor for ${name}? They will set up a new authenticator app at their next sign-in.`)) return
    setError(null)
    const res = await fetch('/api/admin/users', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: user.id, action: 'reset_mfa' }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(data.error || 'Failed to reset two-factor')
    }
    await fetchData()
  }

  const handleDeleteUser = async () => {
    if (!deletingUser) return
    setDeleting(true)
    setError(null)

    try {
      const res = await fetch(`/api/admin/users?userId=${deletingUser.id}`, {
        method: 'DELETE',
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      setDeletingUser(null)
      await fetchData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete user')
    } finally {
      setDeleting(false)
    }
  }

  if (authLoading || loading) {
    return (
      <div style={{ textAlign: 'center', padding: '60px', color: '#64748b' }}>Loading...</div>
    )
  }

  if (!isSuperAdmin) {
    return (
      <div style={{ textAlign: 'center', padding: '60px' }}>
        <h2 style={{ fontSize: '1.5rem', fontWeight: 600, color: '#1f2937' }}>Access Denied</h2>
        <p style={{ color: '#6b7280' }}>Only superadmins can manage users.</p>
      </div>
    )
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div>
          <p style={{ fontSize: '14px', color: 'var(--color-text-muted)', margin: '4px 0 0 0' }}>
            Manage team members, roles, and access permissions
          </p>
        </div>
        <button
          onClick={() => setShowCreateForm(true)}
          style={{
            padding: '8px 16px', fontSize: '14px', fontWeight: 600,
            color: '#fff', background: 'var(--color-primary)',
            border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer',
          }}
        >
          + Add User
        </button>
      </div>

      {error && (
        <div style={{
          padding: '10px 12px', marginBottom: '16px', fontSize: '13px',
          color: 'var(--color-danger)', background: '#fef2f2',
          border: '1px solid #fecaca', borderRadius: 'var(--radius-md)',
        }}>
          {error}
          <button onClick={() => setError(null)} style={{ float: 'right', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-danger)' }}>x</button>
        </div>
      )}

      {/* Users Table */}
      <div style={{
        background: 'var(--color-surface)', borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--color-border)', overflow: 'hidden',
      }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
          <thead>
            <tr style={{ background: 'var(--color-bg-alt)', borderBottom: '1px solid var(--color-border)' }}>
              <th style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: 'var(--color-text)' }}>User</th>
              <th style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: 'var(--color-text)' }}>Role</th>
              <th style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: 'var(--color-text)' }}>Clients</th>
              <th style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: 'var(--color-text)' }}>Status</th>
              <th style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: 'var(--color-text)' }}>2FA</th>
              <th style={{ padding: '10px 16px', textAlign: 'right', fontWeight: 600, color: 'var(--color-text)' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const userClientList = userClients
                .filter((uc) => uc.user_id === user.id)
                .map((uc) => clients.find((c) => c.id === uc.client_id)?.name)
                .filter(Boolean)

              return (
                <tr key={user.id} style={{ borderBottom: '1px solid var(--color-border-light)' }}>
                  <td style={{ padding: '12px 16px' }}>
                    <div style={{ fontWeight: 500, color: 'var(--color-text)' }}>
                      {user.display_name || user.email}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--color-text-light)' }}>
                      {user.email}
                    </div>
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <span style={{
                      display: 'inline-block', padding: '2px 8px', fontSize: '12px', fontWeight: 500,
                      borderRadius: '999px', textTransform: 'capitalize',
                      background: user.role === 'superadmin' ? '#dbeafe' : user.role === 'editor' ? '#dcfce7' : '#f3f4f6',
                      color: user.role === 'superadmin' ? '#1d4ed8' : user.role === 'editor' ? '#166534' : '#374151',
                    }}>
                      {user.role}
                    </span>
                  </td>
                  <td style={{ padding: '12px 16px', fontSize: '13px', color: 'var(--color-text-muted)' }}>
                    {user.role === 'superadmin' || user.all_clients
                      ? <span style={{ color: '#1d4ed8', fontWeight: 500 }}>All Clients</span>
                      : userClientList.length > 0 ? userClientList.join(', ') : 'None'}
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <span style={{
                      display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%',
                      background: user.is_active ? 'var(--color-success)' : 'var(--color-text-light)',
                      marginRight: '6px',
                    }} />
                    <span style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>
                      {user.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td style={{ padding: '12px 16px', fontSize: '13px', color: 'var(--color-text-muted)' }}>
                    {mfaUserIds.includes(user.id) ? (
                      <>
                        <span style={{ color: 'var(--color-success)', fontWeight: 500 }}>On</span>
                        <button
                          onClick={() => handleResetMfa(user)}
                          style={{
                            marginLeft: '8px', padding: 0, fontSize: '12px',
                            color: 'var(--color-text-muted)', background: 'none',
                            border: 'none', textDecoration: 'underline', cursor: 'pointer',
                          }}
                        >
                          Reset
                        </button>
                      </>
                    ) : (
                      <span>Not set up</span>
                    )}
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                    <button
                      onClick={() => openEditModal(user)}
                      style={{
                        padding: '4px 12px', fontSize: '13px', fontWeight: 500,
                        color: 'var(--color-primary)', background: 'var(--color-bg)',
                        border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)',
                        cursor: 'pointer', marginRight: '8px',
                      }}
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleToggleActive(user)}
                      style={{
                        padding: '4px 12px', fontSize: '13px', fontWeight: 500,
                        color: user.is_active ? 'var(--color-danger)' : 'var(--color-success)',
                        background: 'var(--color-bg)',
                        border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)',
                        cursor: 'pointer', marginRight: '8px',
                      }}
                    >
                      {user.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button
                      onClick={() => setDeletingUser(user)}
                      style={{
                        padding: '4px 12px', fontSize: '13px', fontWeight: 500,
                        color: 'var(--color-danger)',
                        background: 'var(--color-bg)',
                        border: '1px solid var(--color-danger)', borderRadius: 'var(--radius-md)',
                        cursor: 'pointer',
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Create User Modal */}
      {showCreateForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--color-surface)', borderRadius: 'var(--radius-lg)', padding: '24px', width: '560px', maxHeight: '90vh', overflow: 'auto' }}>
            {inviteUrl ? (
              <>
                <h2 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--color-text)', margin: '0 0 8px 0' }}>Invite Link Created</h2>
                <p style={{ fontSize: '13px', color: 'var(--color-text-muted)', margin: '0 0 16px 0' }}>
                  Share this link with <strong>{newEmail}</strong> to let them set up their account.
                </p>
                <div style={{
                  padding: '12px', background: 'var(--color-bg)', border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)', fontSize: '13px', wordBreak: 'break-all',
                  color: 'var(--color-text)', marginBottom: '16px', fontFamily: 'monospace',
                }}>
                  {inviteUrl}
                </div>
                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                  <button onClick={handleCloseInvite}
                    style={{ padding: '8px 16px', fontSize: '14px', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}>
                    Done
                  </button>
                  <button onClick={handleCopyInvite}
                    style={{ padding: '8px 16px', fontSize: '14px', fontWeight: 600, color: '#fff', background: copied ? 'var(--color-success)' : 'var(--color-primary)', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}>
                    {copied ? 'Copied!' : 'Copy Link'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--color-text)', margin: '0 0 20px 0' }}>Invite New User</h2>
                <form onSubmit={handleCreateUser}>
                  <div style={{ marginBottom: '12px' }}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: 'var(--color-text)', marginBottom: '4px' }}>Email *</label>
                    <input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} required
                      style={{ width: '100%', padding: '8px 12px', fontSize: '14px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', boxSizing: 'border-box', background: 'var(--color-bg)', color: 'var(--color-text)' }} />
                  </div>
                  <div style={{ marginBottom: '20px' }}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: 'var(--color-text)', marginBottom: '4px' }}>Role</label>
                    <select value={newRole} onChange={(e) => setNewRole(e.target.value as Role)}
                      style={{ width: '100%', padding: '8px 12px', fontSize: '14px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', boxSizing: 'border-box', background: 'var(--color-bg)', color: 'var(--color-text)' }}>
                      <option value="viewer">Viewer</option>
                      <option value="editor">Editor</option>
                      <option value="superadmin">Super Admin</option>
                    </select>
                  </div>

                  {/* Client Access (only for non-superadmin) */}
                  {newRole !== 'superadmin' && (
                    <div style={{ marginBottom: '20px' }}>
                      <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--color-text)', margin: '0 0 8px 0' }}>
                        Client Access
                      </h3>
                      <p style={{ fontSize: '12px', color: 'var(--color-text-light)', margin: '0 0 12px 0' }}>
                        Select which clients this user can see data for.
                      </p>
                      <div style={{ display: 'grid', gap: '6px' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px', background: newAllClients ? '#dbeafe' : 'var(--color-bg)', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: '13px', fontWeight: 500 }}>
                          <input
                            type="checkbox"
                            checked={newAllClients}
                            onChange={(e) => {
                              setNewAllClients(e.target.checked)
                              if (e.target.checked) {
                                setNewClientIds([])
                              }
                            }}
                          />
                          All Clients (including future)
                        </label>
                        {clients.map((client) => (
                          <label key={client.id} style={{
                            display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px 6px 28px',
                            background: 'var(--color-bg)', borderRadius: 'var(--radius-md)',
                            cursor: newAllClients ? 'not-allowed' : 'pointer', fontSize: '13px',
                            opacity: newAllClients ? 0.5 : 1,
                          }}>
                            <input
                              type="checkbox"
                              checked={newAllClients || newClientIds.includes(client.id)}
                              disabled={newAllClients}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setNewClientIds((prev) => [...prev, client.id])
                                } else {
                                  setNewClientIds((prev) => prev.filter((id) => id !== client.id))
                                }
                              }}
                            />
                            {client.name}
                          </label>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Feature Permissions (only for non-superadmin) */}
                  {newRole !== 'superadmin' && (
                    <div style={{ marginBottom: '20px' }}>
                      <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--color-text)', margin: '0 0 8px 0' }}>
                        Feature Permissions
                      </h3>
                      <p style={{ fontSize: '12px', color: 'var(--color-text-light)', margin: '0 0 12px 0' }}>
                        Override the base role for specific features. Leave as &ldquo;Use default&rdquo; to inherit from the base role.
                      </p>
                      <div style={{ display: 'grid', gap: '8px' }}>
                        {FEATURES.map((feature) => (
                          <div key={feature.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--color-bg)', borderRadius: 'var(--radius-md)' }}>
                            <div>
                              <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--color-text)' }}>{feature.label}</div>
                              <div style={{ fontSize: '11px', color: 'var(--color-text-light)' }}>{feature.description}</div>
                            </div>
                            <select
                              value={newPermissions[feature.key] || ''}
                              onChange={(e) => {
                                const val = e.target.value
                                setNewPermissions((prev) => {
                                  const next = { ...prev }
                                  if (val === '') {
                                    delete next[feature.key]
                                  } else {
                                    next[feature.key] = val as AccessLevel
                                  }
                                  return next
                                })
                              }}
                              style={{ padding: '4px 8px', fontSize: '13px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', minWidth: '130px' }}
                            >
                              <option value="">Use default ({newRole === 'editor' ? 'edit' : 'view'})</option>
                              <option value="edit">Edit</option>
                              <option value="view">View only</option>
                              <option value="none">No access</option>
                            </select>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <p style={{ fontSize: '12px', color: 'var(--color-text-light)', margin: '0 0 16px 0' }}>
                    An invite link will be generated. The user will set their own password and display name.
                  </p>
                  <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                    <button type="button" onClick={() => { setShowCreateForm(false); setNewEmail(''); setNewRole('viewer'); setNewAllClients(false); setNewClientIds([]); setNewPermissions({}) }}
                      style={{ padding: '8px 16px', fontSize: '14px', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', cursor: 'pointer', color: 'var(--color-text)' }}>
                      Cancel
                    </button>
                    <button type="submit" disabled={creating}
                      style={{ padding: '8px 16px', fontSize: '14px', fontWeight: 600, color: '#fff', background: 'var(--color-primary)', border: 'none', borderRadius: 'var(--radius-md)', cursor: creating ? 'not-allowed' : 'pointer' }}>
                      {creating ? 'Creating...' : 'Generate Invite Link'}
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>
        </div>
      )}

      {/* Edit User Modal */}
      {editingUser && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--color-surface)', borderRadius: 'var(--radius-lg)', padding: '24px', width: '560px', maxHeight: '90vh', overflow: 'auto' }}>
            <h2 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--color-text)', margin: '0 0 4px 0' }}>
              Edit User
            </h2>
            <p style={{ fontSize: '13px', color: 'var(--color-text-muted)', margin: '0 0 20px 0' }}>
              {editingUser.email}
            </p>

            {/* Profile section */}
            <div style={{ marginBottom: '20px' }}>
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: 'var(--color-text)', marginBottom: '4px' }}>Display Name</label>
                <input type="text" value={editDisplayName} onChange={(e) => setEditDisplayName(e.target.value)}
                  style={{ width: '100%', padding: '8px 12px', fontSize: '14px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', boxSizing: 'border-box' }} />
              </div>
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: 'var(--color-text)', marginBottom: '4px' }}>Base Role</label>
                <select value={editRole} onChange={(e) => setEditRole(e.target.value as Role)}
                  style={{ width: '100%', padding: '8px 12px', fontSize: '14px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', boxSizing: 'border-box' }}>
                  <option value="viewer">Viewer (read-only by default)</option>
                  <option value="editor">Editor (read+write by default)</option>
                  <option value="superadmin">Super Admin (full access)</option>
                </select>
              </div>
            </div>

            {/* Feature permissions (only for non-superadmin) */}
            {editRole !== 'superadmin' && (
              <div style={{ marginBottom: '20px' }}>
                <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--color-text)', margin: '0 0 8px 0' }}>
                  Feature Permissions
                </h3>
                <p style={{ fontSize: '12px', color: 'var(--color-text-light)', margin: '0 0 12px 0' }}>
                  Override the base role for specific features. Leave as &ldquo;Use default&rdquo; to inherit from the base role.
                </p>
                <div style={{ display: 'grid', gap: '8px' }}>
                  {FEATURES.map((feature) => (
                    <div key={feature.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--color-bg)', borderRadius: 'var(--radius-md)' }}>
                      <div>
                        <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--color-text)' }}>{feature.label}</div>
                        <div style={{ fontSize: '11px', color: 'var(--color-text-light)' }}>{feature.description}</div>
                      </div>
                      <select
                        value={editPermissions[feature.key] || ''}
                        onChange={(e) => {
                          const val = e.target.value
                          setEditPermissions((prev) => {
                            const next = { ...prev }
                            if (val === '') {
                              delete next[feature.key]
                            } else {
                              next[feature.key] = val as AccessLevel
                            }
                            return next
                          })
                        }}
                        style={{ padding: '4px 8px', fontSize: '13px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', minWidth: '130px' }}
                      >
                        <option value="">Use default ({editRole === 'editor' ? 'edit' : 'view'})</option>
                        <option value="edit">Edit</option>
                        <option value="view">View only</option>
                        <option value="none">No access</option>
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Client assignments (only for non-superadmin) */}
            {editRole !== 'superadmin' && (
              <div style={{ marginBottom: '20px' }}>
                <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--color-text)', margin: '0 0 8px 0' }}>
                  Client Access
                </h3>
                <p style={{ fontSize: '12px', color: 'var(--color-text-light)', margin: '0 0 12px 0' }}>
                  Select which clients this user can see data for.
                </p>
                <div style={{ display: 'grid', gap: '6px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px', background: editAllClients ? '#dbeafe' : 'var(--color-bg)', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: '13px', fontWeight: 500 }}>
                    <input
                      type="checkbox"
                      checked={editAllClients}
                      onChange={(e) => {
                        setEditAllClients(e.target.checked)
                        if (e.target.checked) {
                          setEditClientIds([])
                        }
                      }}
                    />
                    All Clients (including future)
                  </label>
                  {clients.map((client) => (
                    <label key={client.id} style={{
                      display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px 6px 28px',
                      background: 'var(--color-bg)', borderRadius: 'var(--radius-md)',
                      cursor: editAllClients ? 'not-allowed' : 'pointer', fontSize: '13px',
                      opacity: editAllClients ? 0.5 : 1,
                    }}>
                      <input
                        type="checkbox"
                        checked={editAllClients || editClientIds.includes(client.id)}
                        disabled={editAllClients}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setEditClientIds((prev) => [...prev, client.id])
                          } else {
                            setEditClientIds((prev) => prev.filter((id) => id !== client.id))
                          }
                        }}
                      />
                      {client.name}
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', borderTop: '1px solid var(--color-border)', paddingTop: '16px' }}>
              <button onClick={() => setEditingUser(null)}
                style={{ padding: '8px 16px', fontSize: '14px', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={handleSaveUser} disabled={saving}
                style={{ padding: '8px 16px', fontSize: '14px', fontWeight: 600, color: '#fff', background: 'var(--color-primary)', border: 'none', borderRadius: 'var(--radius-md)', cursor: saving ? 'not-allowed' : 'pointer' }}>
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deletingUser && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--color-surface)', borderRadius: 'var(--radius-lg)', padding: '24px', width: '440px', textAlign: 'center' }}>
            <h2 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--color-text)', margin: '0 0 12px 0' }}>
              Delete User
            </h2>
            <p style={{ fontSize: '14px', color: 'var(--color-text-muted)', margin: '0 0 8px 0' }}>
              Are you sure you want to permanently delete <strong>{deletingUser.display_name || deletingUser.email}</strong>?
            </p>
            <div style={{
              margin: '16px 0', padding: '12px', background: '#fef2f2',
              borderRadius: 'var(--radius-md)', fontSize: '13px', color: 'var(--color-danger)',
            }}>
              This action cannot be undone. The user will be removed from the system entirely, including their auth account, permissions, and client access.
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', marginTop: '20px' }}>
              <button onClick={() => setDeletingUser(null)}
                style={{ padding: '8px 16px', fontSize: '14px', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', cursor: 'pointer', color: 'var(--color-text)' }}>
                Cancel
              </button>
              <button onClick={handleDeleteUser} disabled={deleting}
                style={{ padding: '8px 16px', fontSize: '14px', fontWeight: 600, color: '#fff', background: 'var(--color-danger)', border: 'none', borderRadius: 'var(--radius-md)', cursor: deleting ? 'not-allowed' : 'pointer' }}>
                {deleting ? 'Deleting...' : 'Delete User'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
