import { NextResponse } from 'next/server';
import { serverSupabase as supabase } from '@/lib/supabase';
import { loadAgencyFallback } from '@/lib/steam-partner-routing';

// POST - Trigger a background Steam sync job
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { client_id, start_date, end_date, force_full_sync } = body;

    if (!client_id) {
      return NextResponse.json(
        { error: 'Client ID is required' },
        { status: 400 }
      );
    }

    // Verify client exists and has API key
    const { data: keyData, error: keyError } = await supabase
      .from('steam_api_keys')
      .select('api_key, publisher_key')
      .eq('client_id', client_id)
      .eq('is_active', true)
      .single();

    // No key of its own is fine when the client shares its apps with Game Drive's Steamworks account.
    if ((keyError || !keyData) && !(await loadAgencyFallback(supabase, client_id))) {
      return NextResponse.json(
        { error: 'No active Steam API key found for this client' },
        { status: 404 }
      );
    }

    // Create a new sync job
    const { data: job, error: jobError } = await supabase
      .from('sync_jobs')
      .insert({
        client_id,
        job_type: 'steam_sync',
        status: 'pending',
        start_date,
        end_date,
        force_full_sync: force_full_sync || false
      })
      .select()
      .single();

    if (jobError) {
      console.error('Error creating sync job:', jobError);
      return NextResponse.json(
        { error: 'Failed to create sync job' },
        { status: 500 }
      );
    }

    console.log(`[Sync Job] Created job ${job.id} for client ${client_id}`);

    return NextResponse.json({
      success: true,
      message: 'Sync job created. Processing will begin shortly.',
      jobId: job.id,
      status: 'pending'
    });

  } catch (error) {
    console.error('Error triggering sync job:', error);
    return NextResponse.json(
      { error: 'Failed to trigger sync job' },
      { status: 500 }
    );
  }
}
