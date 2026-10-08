import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { getAal, isMfaEnforced } from '@/lib/mfa'

// Verify the caller is a superadmin
async function verifySuperAdmin() {
  const supabase = createRouteHandlerClient({ cookies })
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return false

  // Password-only sessions never count as admin once two-factor is on
  if (isMfaEnforced()) {
    const { data: { session } } = await supabase.auth.getSession()
    if (getAal(session?.access_token) !== 'aal2') return false
  }

  const serverSupabase = getServerSupabase()
  const { data: profile } = await serverSupabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  return profile?.role === 'superadmin'
}

// GET - List all users with their profiles, permissions, and client assignments
export async function GET() {
  if (!(await verifySuperAdmin())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const serverSupabase = getServerSupabase()

  const [profilesRes, permissionsRes, clientsRes, userClientsRes] = await Promise.all([
    serverSupabase.from('user_profiles').select('*').order('created_at', { ascending: true }),
    serverSupabase.from('user_permissions').select('*'),
    serverSupabase.from('clients').select('id, name'),
    serverSupabase.from('user_clients').select('*'),
  ])

  // Which users have a verified authenticator app
  const mfaUserIds: string[] = []
  await Promise.all(
    (profilesRes.data || []).map(async (p: { id: string }) => {
      const { data } = await serverSupabase.auth.admin.mfa.listFactors({ userId: p.id })
      if (data?.factors?.some((f) => f.status === 'verified')) mfaUserIds.push(p.id)
    })
  )

  return NextResponse.json({
    users: profilesRes.data || [],
    mfaUserIds,
    permissions: permissionsRes.data || [],
    clients: clientsRes.data || [],
    userClients: userClientsRes.data || [],
  })
}

// POST - Create a new user via invite link
export async function POST(request: Request) {
  if (!(await verifySuperAdmin())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const body = await request.json()
  const { email, role, clientIds, permissions, allClients } = body

  if (!email) {
    return NextResponse.json({ error: 'Email is required' }, { status: 400 })
  }

  const serverSupabase = getServerSupabase()

  // Generate an invite link (creates the user in auth + returns link properties)
  const { data: linkData, error: linkError } = await serverSupabase.auth.admin.generateLink({
    type: 'invite',
    email,
  })

  if (linkError) {
    return NextResponse.json({ error: linkError.message }, { status: 400 })
  }

  // Update the profile with role (trigger created it with defaults)
  if (linkData.user) {
    const userId = linkData.user.id

    await serverSupabase
      .from('user_profiles')
      .update({
        role: role || 'viewer',
        all_clients: allClients || false,
      })
      .eq('id', userId)

    // Set client assignments if provided (skip if all_clients is true)
    if (!allClients && clientIds && clientIds.length > 0) {
      const clientRows = clientIds.map((clientId: string) => ({
        user_id: userId,
        client_id: clientId,
      }))
      await serverSupabase.from('user_clients').insert(clientRows)
    }

    // Set feature permissions if provided
    if (permissions && permissions.length > 0) {
      const permRows = permissions
        .filter((p: { access_level: string }) => p.access_level !== 'none')
        .map((p: { feature: string; access_level: string }) => ({
          user_id: userId,
          feature: p.feature,
          access_level: p.access_level,
        }))
      if (permRows.length > 0) {
        await serverSupabase.from('user_permissions').insert(permRows)
      }
    }
  }

  // Build a custom setup URL using the token hash from the generated link
  const origin = request.headers.get('origin')
    || process.env.NEXT_PUBLIC_SITE_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
  const setupUrl = `${origin}/setup?token_hash=${linkData.properties.hashed_token}&type=invite`

  return NextResponse.json({ user: linkData.user, inviteUrl: setupUrl })
}

// PUT - Update a user's profile, permissions, or client assignments
export async function PUT(request: Request) {
  if (!(await verifySuperAdmin())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const body = await request.json()
  const { userId, action, ...data } = body

  if (!userId || !action) {
    return NextResponse.json({ error: 'userId and action are required' }, { status: 400 })
  }

  const serverSupabase = getServerSupabase()

  switch (action) {
    case 'update_profile': {
      const { role, display_name, is_active, all_clients } = data
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (role !== undefined) updates.role = role
      if (display_name !== undefined) updates.display_name = display_name
      if (is_active !== undefined) updates.is_active = is_active
      if (all_clients !== undefined) updates.all_clients = all_clients

      const { error } = await serverSupabase
        .from('user_profiles')
        .update(updates)
        .eq('id', userId)

      if (error) return NextResponse.json({ error: error.message }, { status: 400 })

      // Deactivating also blocks sign-in and session refresh at the auth
      // provider, since is_active alone is only checked in the UI.
      if (is_active !== undefined) {
        const { error: banError } = await serverSupabase.auth.admin.updateUserById(userId, {
          ban_duration: is_active ? 'none' : '876000h',
        })
        if (banError) return NextResponse.json({ error: banError.message }, { status: 400 })
      }
      return NextResponse.json({ success: true })
    }

    case 'reset_mfa': {
      // Removes the user's authenticator app so they set up a new one at next sign-in
      const { data, error } = await serverSupabase.auth.admin.mfa.listFactors({ userId })
      if (error) return NextResponse.json({ error: error.message }, { status: 400 })

      for (const factor of data?.factors ?? []) {
        const { error: delError } = await serverSupabase.auth.admin.mfa.deleteFactor({
          userId,
          id: factor.id,
        })
        if (delError) return NextResponse.json({ error: delError.message }, { status: 400 })
      }
      return NextResponse.json({ success: true, removed: data?.factors?.length ?? 0 })
    }

    case 'set_permissions': {
      const { permissions } = data as { permissions: { feature: string; access_level: string }[] }

      // Delete existing permissions for this user
      await serverSupabase
        .from('user_permissions')
        .delete()
        .eq('user_id', userId)

      // Insert new permissions (only non-default ones)
      if (permissions && permissions.length > 0) {
        const rows = permissions
          .filter((p) => p.access_level !== 'none')
          .map((p) => ({
            user_id: userId,
            feature: p.feature,
            access_level: p.access_level,
          }))

        if (rows.length > 0) {
          const { error } = await serverSupabase
            .from('user_permissions')
            .insert(rows)

          if (error) return NextResponse.json({ error: error.message }, { status: 400 })
        }
      }

      return NextResponse.json({ success: true })
    }

    case 'set_clients': {
      const { clientIds } = data as { clientIds: string[] }

      // Delete existing client assignments
      await serverSupabase
        .from('user_clients')
        .delete()
        .eq('user_id', userId)

      // Insert new assignments
      if (clientIds && clientIds.length > 0) {
        const rows = clientIds.map((clientId: string) => ({
          user_id: userId,
          client_id: clientId,
        }))

        const { error } = await serverSupabase
          .from('user_clients')
          .insert(rows)

        if (error) return NextResponse.json({ error: error.message }, { status: 400 })
      }

      return NextResponse.json({ success: true })
    }

    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
  }
}

// DELETE - Permanently remove a user
export async function DELETE(request: Request) {
  if (!(await verifySuperAdmin())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const userId = searchParams.get('userId')

  if (!userId) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 })
  }

  const serverSupabase = getServerSupabase()

  // Delete in order: permissions -> client access -> profile -> auth user
  await serverSupabase.from('user_permissions').delete().eq('user_id', userId)
  await serverSupabase.from('user_clients').delete().eq('user_id', userId)
  await serverSupabase.from('user_profiles').delete().eq('id', userId)

  // Delete auth user
  const { error: authError } = await serverSupabase.auth.admin.deleteUser(userId)
  if (authError) {
    return NextResponse.json({ error: authError.message }, { status: 400 })
  }

  return NextResponse.json({ success: true })
}
