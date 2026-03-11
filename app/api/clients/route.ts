import { NextResponse } from 'next/server';
import { serverSupabase as supabase } from '@/lib/supabase';

// GET - Fetch all clients
export async function GET() {
  try {
    const { data, error } = await supabase
      .from('clients')
      .select('id, name, email, contact_person, steam_api_key, sales_planning_enabled, pr_tracking_enabled, created_at')
      .order('name', { ascending: true });

    if (error) throw error;

    return NextResponse.json(data || []);
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
    const { name, email, contact_person, sales_planning_enabled, pr_tracking_enabled } = body;

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
