import { NextResponse } from 'next/server';
import { serverSupabase as supabase } from '@/lib/supabase';
import { checkSteamFinancialKey, normalizeSteamKey } from '@/lib/steam-key-check';

// GET - Fetch all Steam API keys with client info
export async function GET() {
  try {
    const { data, error } = await supabase
      .from('steam_api_keys')
      .select(`
        *,
        clients (
          id,
          name
        )
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return NextResponse.json(data || []);
  } catch (error) {
    console.error('Error fetching Steam API keys:', error);
    return NextResponse.json(
      { error: 'Failed to fetch Steam API keys' },
      { status: 500 }
    );
  }
}

// POST - Create or update Steam API key for a client
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { client_id, app_ids, force } = body;
    // Strip stray whitespace / zero-width chars that come along with copy-paste.
    const publisher_key = normalizeSteamKey(body.publisher_key) || null;
    const api_key = normalizeSteamKey(body.api_key) || null;

    if (!client_id || !publisher_key) {
      return NextResponse.json(
        { error: 'Client ID and Financial Web API key are required' },
        { status: 400 }
      );
    }

    // Validate against Steam before storing. A key that fails here will fail
    // every sync, so refuse it with a precise reason instead of letting the
    // user discover a bare "403" hours later in a cron job.
    const check = await checkSteamFinancialKey(publisher_key);
    const hardFailure = check.status === 'unknown_key' || check.status === 'no_financial_permission' || check.status === 'malformed';
    if (hardFailure && !force) {
      return NextResponse.json(
        { error: check.message, fix: check.fix, check },
        { status: 422 }
      );
    }

    // Check if key exists for this client
    const { data: existing } = await supabase
      .from('steam_api_keys')
      .select('id')
      .eq('client_id', client_id)
      .single();

    let result;
    if (existing) {
      // Update existing
      const { data, error } = await supabase
        .from('steam_api_keys')
        .update({
          api_key: api_key || null,
          publisher_key: publisher_key || null,
          app_ids: app_ids || [],
          updated_at: new Date().toISOString()
        })
        .eq('client_id', client_id)
        .select()
        .single();

      if (error) throw error;
      result = data;
    } else {
      // Create new
      const { data, error } = await supabase
        .from('steam_api_keys')
        .insert({
          client_id,
          api_key: api_key || null,
          publisher_key: publisher_key || null,
          app_ids: app_ids || [],
          is_active: true
        })
        .select()
        .single();

      if (error) throw error;
      result = data;
    }

    return NextResponse.json({ ...result, check });
  } catch (error) {
    console.error('Error saving Steam API key:', error);
    return NextResponse.json(
      { error: 'Failed to save Steam API key' },
      { status: 500 }
    );
  }
}

// DELETE - Remove Steam API key
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json(
        { error: 'Key ID is required' },
        { status: 400 }
      );
    }

    const { error } = await supabase
      .from('steam_api_keys')
      .delete()
      .eq('id', id);

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting Steam API key:', error);
    return NextResponse.json(
      { error: 'Failed to delete Steam API key' },
      { status: 500 }
    );
  }
}
