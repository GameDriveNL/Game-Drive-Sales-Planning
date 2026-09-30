import { NextRequest, NextResponse } from 'next/server';
import { serverSupabase as supabase } from '@/lib/supabase';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const clientId = searchParams.get('client_id');

  if (!clientId) {
    return NextResponse.json({ error: 'client_id is required' }, { status: 400 });
  }

  try {

    // Get auto-sync status for this API key
    const { data, error } = await supabase
      .from('steam_api_keys')
      .select('auto_sync_enabled, sync_start_date, sync_frequency_hours, last_auto_sync, next_sync_due')
      .eq('client_id', clientId)
      .single();

    if (error) throw error;

    return NextResponse.json({
      success: true,
      autoSync: {
        enabled: data.auto_sync_enabled || false,
        startDate: data.sync_start_date,
        frequencyHours: data.sync_frequency_hours || 24,
        lastSync: data.last_auto_sync,
        nextSyncDue: data.next_sync_due
      }
    });
  } catch (error) {
    console.error('Error fetching auto-sync status:', error);
    return NextResponse.json(
      { error: 'Failed to fetch auto-sync status', details: String(error) },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { client_id, action, start_date, frequency_hours } = body;

    if (!client_id || !action) {
      return NextResponse.json(
        { error: 'client_id and action are required' },
        { status: 400 }
      );
    }

    if (action === 'enable') {
      // Validate inputs
      if (!start_date) {
        return NextResponse.json(
          { error: 'start_date is required to enable auto-sync' },
          { status: 400 }
        );
      }

      const freq = frequency_hours || 24;
      if (freq < 1 || freq > 168) {
        return NextResponse.json(
          { error: 'frequency_hours must be between 1 and 168' },
          { status: 400 }
        );
      }

      // Calculate next sync time
      const nextSyncDue = new Date();
      nextSyncDue.setHours(nextSyncDue.getHours() + freq);

      // Enable auto-sync
      const { error } = await supabase
        .from('steam_api_keys')
        .update({
          auto_sync_enabled: true,
          sync_start_date: start_date,
          sync_frequency_hours: freq,
          next_sync_due: nextSyncDue.toISOString()
        })
        .eq('client_id', client_id);

      if (error) throw error;

      return NextResponse.json({
        success: true,
        message: 'Auto-sync enabled successfully',
        nextSyncDue: nextSyncDue.toISOString()
      });
    } else if (action === 'disable') {
      // Disable auto-sync
      const { error } = await supabase
        .from('steam_api_keys')
        .update({
          auto_sync_enabled: false,
          next_sync_due: null
        })
        .eq('client_id', client_id);

      if (error) throw error;

      // Cancel any pending auto-sync jobs
      await supabase
        .from('sync_jobs')
        .update({ status: 'cancelled' })
        .eq('client_id', client_id)
        .eq('is_auto_sync', true)
        .in('status', ['pending', 'running']);

      return NextResponse.json({
        success: true,
        message: 'Auto-sync disabled successfully'
      });
    } else if (action === 'trigger') {
      // Trigger an immediate manual sync
      const { data: apiKey } = await supabase
        .from('steam_api_keys')
        .select('auto_sync_enabled')
        .eq('client_id', client_id)
        .single();

      if (!apiKey?.auto_sync_enabled) {
        return NextResponse.json(
          { error: 'Auto-sync must be enabled to trigger manual syncs' },
          { status: 400 }
        );
      }

      // Same rolling window as the daily job. Full history is a one-time backfill
      // queued by schedule_steam_history_backfills(), not something to redo on demand.
      const today = new Date().toISOString().split('T')[0];
      const rollingStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      const { data: job, error: jobError } = await supabase
        .from('sync_jobs')
        .insert({
          client_id,
          job_type: 'steam_sync',
          status: 'pending',
          start_date: rollingStart,
          end_date: today,
          force_full_sync: false,
          is_auto_sync: false // This is a manual trigger
        })
        .select()
        .single();

      if (jobError) throw jobError;

      return NextResponse.json({
        success: true,
        message: 'Manual sync triggered successfully',
        jobId: job.id
      });
    } else {
      return NextResponse.json(
        { error: 'Invalid action. Must be "enable", "disable", or "trigger"' },
        { status: 400 }
      );
    }
  } catch (error) {
    console.error('Error managing auto-sync:', error);
    return NextResponse.json(
      { error: 'Failed to manage auto-sync', details: String(error) },
      { status: 500 }
    );
  }
}
