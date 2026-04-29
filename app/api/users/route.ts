import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase';
import { createClient } from '@supabase/supabase-js';

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error('Missing Supabase env vars');
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

// GET - Fetch all users with profiles, client access, and permissions
export async function GET() {
  try {
    const supabase = getServerSupabase();

    // Fetch user profiles
    const { data: profiles, error: profilesError } = await supabase
      .from('user_profiles')
      .select('*')
      .order('role', { ascending: true })
      .order('email', { ascending: true });

    if (profilesError) throw profilesError;

    // Fetch user_clients with client names
    const { data: userClients, error: clientsError } = await supabase
      .from('user_clients')
      .select('user_id, client_id, clients(id, name)');

    if (clientsError) throw clientsError;

    // Fetch user_permissions
    const { data: permissions, error: permsError } = await supabase
      .from('user_permissions')
      .select('*');

    if (permsError) throw permsError;

    // Fetch all clients for reference
    const { data: allClients, error: allClientsError } = await supabase
      .from('clients')
      .select('id, name')
      .order('name');

    if (allClientsError) throw allClientsError;

    // Merge data
    const users = (profiles || []).map((profile) => {
      const uc = (userClients || []).filter((c) => c.user_id === profile.id);
      const clientList = uc
        .map((c) => {
          const client = c.clients as unknown as { id: string; name: string } | null;
          return client ? { id: client.id, name: client.name } : null;
        })
        .filter(Boolean);

      return {
        ...profile,
        client_ids: clientList.map((c) => c!.id),
        clients: clientList,
        permissions: (permissions || []).filter((p) => p.user_id === profile.id),
      };
    });

    return NextResponse.json({ users, allClients: allClients || [] });
  } catch (error) {
    console.error('Error fetching users:', error);
    return NextResponse.json({ error: 'Failed to fetch users' }, { status: 500 });
  }
}

// POST - Create/invite a new user
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { email, role, all_clients, client_ids, permissions } = body;

    if (!email) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 });
    }

    const admin = getAdminClient();

    // Create the auth user with a random password (they'll set their own via invite link)
    const { data: authData, error: authError } = await admin.auth.admin.createUser({
      email,
      email_confirm: false,
      user_metadata: { role },
    });

    if (authError) throw authError;

    const userId = authData.user.id;
    const supabase = getServerSupabase();

    // Create user profile
    const { error: profileError } = await supabase
      .from('user_profiles')
      .insert({
        id: userId,
        email,
        role: role || 'viewer',
        all_clients: all_clients || false,
        is_active: true,
      });

    if (profileError) throw profileError;

    // Create client access entries (unless all_clients is true)
    if (!all_clients && client_ids && client_ids.length > 0) {
      const clientRows = client_ids.map((clientId: string) => ({
        user_id: userId,
        client_id: clientId,
      }));
      const { error: clientsError } = await supabase
        .from('user_clients')
        .insert(clientRows);

      if (clientsError) throw clientsError;
    }

    // Create feature permissions if provided
    if (permissions && permissions.length > 0) {
      const permRows = permissions
        .filter((p: { feature: string; access_level: string }) => p.access_level !== 'default')
        .map((p: { feature: string; access_level: string }) => ({
          user_id: userId,
          feature: p.feature,
          access_level: p.access_level,
        }));

      if (permRows.length > 0) {
        const { error: permsError } = await supabase
          .from('user_permissions')
          .insert(permRows);

        if (permsError) throw permsError;
      }
    }

    // Generate invite link
    const { data: inviteData, error: inviteError } = await admin.auth.admin.generateLink({
      type: 'invite',
      email,
    });

    let inviteLink = null;
    if (!inviteError && inviteData) {
      // Build the invite URL using the hashed_token
      const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL?.replace('.supabase.co', '.vercel.app') || '';
      const token = inviteData.properties?.hashed_token;
      if (token) {
        // Invite-claim flow lives at /setup (see middleware.ts whitelist + app/setup/page.tsx)
        inviteLink = `${siteUrl}/setup?token_hash=${token}&type=invite`;
      }
    }

    return NextResponse.json({
      success: true,
      user_id: userId,
      invite_link: inviteLink,
    });
  } catch (error: unknown) {
    console.error('Error creating user:', error);
    const message = error instanceof Error ? error.message : 'Failed to create user';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// PUT - Update user role, client access, permissions
export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { user_id, role, all_clients, client_ids, permissions, display_name } = body;

    if (!user_id) {
      return NextResponse.json({ error: 'user_id is required' }, { status: 400 });
    }

    const supabase = getServerSupabase();

    // Update profile
    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (role !== undefined) updateData.role = role;
    if (all_clients !== undefined) updateData.all_clients = all_clients;
    if (display_name !== undefined) updateData.display_name = display_name;

    const { error: profileError } = await supabase
      .from('user_profiles')
      .update(updateData)
      .eq('id', user_id);

    if (profileError) throw profileError;

    // Update client access
    if (client_ids !== undefined) {
      // Remove existing
      const { error: deleteError } = await supabase
        .from('user_clients')
        .delete()
        .eq('user_id', user_id);

      if (deleteError) throw deleteError;

      // Add new (unless all_clients)
      if (!all_clients && client_ids.length > 0) {
        const clientRows = client_ids.map((clientId: string) => ({
          user_id,
          client_id: clientId,
        }));
        const { error: insertError } = await supabase
          .from('user_clients')
          .insert(clientRows);

        if (insertError) throw insertError;
      }
    }

    // Update permissions
    if (permissions !== undefined) {
      // Remove existing
      const { error: deletePermsError } = await supabase
        .from('user_permissions')
        .delete()
        .eq('user_id', user_id);

      if (deletePermsError) throw deletePermsError;

      // Add new
      const permRows = permissions
        .filter((p: { feature: string; access_level: string }) => p.access_level !== 'default')
        .map((p: { feature: string; access_level: string }) => ({
          user_id,
          feature: p.feature,
          access_level: p.access_level,
        }));

      if (permRows.length > 0) {
        const { error: insertPermsError } = await supabase
          .from('user_permissions')
          .insert(permRows);

        if (insertPermsError) throw insertPermsError;
      }
    }

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error('Error updating user:', error);
    const message = error instanceof Error ? error.message : 'Failed to update user';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// DELETE - Remove a user completely
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('user_id');

    if (!userId) {
      return NextResponse.json({ error: 'user_id is required' }, { status: 400 });
    }

    const supabase = getServerSupabase();

    // Delete in order: permissions -> client access -> profile -> auth user
    await supabase.from('user_permissions').delete().eq('user_id', userId);
    await supabase.from('user_clients').delete().eq('user_id', userId);
    await supabase.from('user_profiles').delete().eq('id', userId);

    // Delete auth user
    const admin = getAdminClient();
    const { error: authError } = await admin.auth.admin.deleteUser(userId);
    if (authError) throw authError;

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error('Error deleting user:', error);
    const message = error instanceof Error ? error.message : 'Failed to delete user';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
