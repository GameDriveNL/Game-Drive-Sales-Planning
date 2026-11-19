import { NextResponse } from 'next/server';
import { serverSupabase as supabase } from '@/lib/supabase';
import { requireUser, getAllowedClientIds } from '@/lib/api-auth';

// GET - Fetch all clients (with optional nested games/products)
export async function GET(request: Request) {
  const caller = await requireUser();
  if (caller instanceof NextResponse) return caller;
  // Client restricted accounts only see their own clients
  const allowed = await getAllowedClientIds(caller);

  try {
    const { searchParams } = new URL(request.url);
    const include = searchParams.get('include');

    let selectQuery = 'id, name, email, contact_person, steam_partner_id, sales_planning_enabled, pr_tracking_enabled, created_at';
    if (include === 'nested') {
      // Include product_platforms so the settings page can show each product's
      // assigned platforms — without this nested join it always renders
      // "No platforms assigned" even when platforms are set.
      selectQuery = '*, games(*, products(*, product_platforms(id, product_id, platform_id, platform:platforms(id, name, color_hex))))';
    }

    let query = supabase
      .from('clients')
      .select(selectQuery)
      .order('name', { ascending: true });
    if (allowed) query = query.in('id', allowed);

    const { data, error } = await query;

    if (error) throw error;

    // The raw Steam key lives in steam_api_keys (masked there); never send the
    // legacy clients.steam_api_key column to the browser.
    const rows = (data || []).map((row: unknown) => {
      const { steam_api_key: _legacyKey, ...rest } = row as Record<string, unknown>;
      return rest;
    });
    return NextResponse.json(rows);
  } catch (error) {
    console.error('Error fetching clients:', error);
    return NextResponse.json(
      { error: 'Failed to fetch clients' },
      { status: 500 }
    );
  }
}

// POST - Create a new client
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, email, contact_person, steam_partner_id, sales_planning_enabled, pr_tracking_enabled } = body;

    if (!name) {
      return NextResponse.json(
        { error: 'Client name is required' },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from('clients')
      .insert({
        name,
        email: email || null,
        contact_person: contact_person || null,
        steam_partner_id: steam_partner_id ? String(steam_partner_id).trim() : null,
        sales_planning_enabled: sales_planning_enabled ?? true,
        pr_tracking_enabled: pr_tracking_enabled ?? false
      })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json(data);
  } catch (error) {
    console.error('Error creating client:', error);
    return NextResponse.json(
      { error: 'Failed to create client' },
      { status: 500 }
    );
  }
}

// PUT - Update a client
export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { id, ...updates } = body;

    if (!id) {
      return NextResponse.json({ error: 'Client id is required' }, { status: 400 });
    }

    if ('steam_partner_id' in updates) {
      const v = updates.steam_partner_id;
      updates.steam_partner_id = v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim();
    }

    const { data, error } = await supabase
      .from('clients')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json(data);
  } catch (error) {
    console.error('Error updating client:', error);
    return NextResponse.json({ error: 'Failed to update client' }, { status: 500 });
  }
}

// DELETE - Delete a client (cascades to games, products, sales, coverage)
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'Client id is required' }, { status: 400 });
    }

    const { error } = await supabase
      .from('clients')
      .delete()
      .eq('id', id);

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting client:', error);
    return NextResponse.json({ error: 'Failed to delete client' }, { status: 500 });
  }
}
