import { NextResponse } from 'next/server';
import { serverSupabase as supabase } from '@/lib/supabase';

const STEAM_PARTNER_API = 'https://partner.steam-api.com';
const DOMO_AUTH_URL = 'https://api.domo.com/oauth/token';
const DOMO_DATASETS_URL = 'https://api.domo.com/v1/datasets';
const DOMO_EXPORT_URL = 'https://api.domo.com/v1/datasets/{datasetId}/data';
const DOMO_QUERY_URL = 'https://api.domo.com/v1/datasets/query/execute/{datasetId}';
const MAX_DATES_PER_RUN = 10; // Process 10 dates per cron execution (runs every minute)
const LARGE_DATASET_THRESHOLD = 50000; // Datasets above this use SQL query API with date chunking
const DATES_PER_PS_RUN = 15; // Process 15 dates per cron run for large datasets

// Force dynamic rendering - required for accessing request headers
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// This endpoint will be called by Vercel Cron
// It processes one pending job at a time
export async function GET(request: Request) {
  try {
    // Verify this is a cron request (Vercel adds this header)
    const authHeader = request.headers.get('authorization');
    const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;

    // Log for debugging
    console.log('[Cron] Auth check:', {
      hasAuthHeader: !!authHeader,
      hasCronSecret: !!process.env.CRON_SECRET,
      authMatches: authHeader === expectedAuth
    });

    // Temporarily allow manual testing - REMOVE THIS LATER
    const isManualTest = request.headers.get('user-agent')?.includes('Mozilla');

    if (!isManualTest && authHeader !== expectedAuth) {
      return NextResponse.json({
        error: 'Unauthorized',
        debug: {
          hasAuthHeader: !!authHeader,
          hasCronSecret: !!process.env.CRON_SECRET
        }
      }, { status: 401 });
    }

    console.log('[Cron] Starting sync job processor');

    // Reset stuck jobs (running for > 10 minutes)
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: stuckJobs } = await supabase
      .from('sync_jobs')
      .select('id')
      .eq('status', 'running')
      .lt('started_at', tenMinutesAgo);

    if (stuckJobs && stuckJobs.length > 0) {
      console.log(`[Cron] Resetting ${stuckJobs.length} stuck jobs`);
      await supabase
        .from('sync_jobs')
        .update({ status: 'pending', started_at: null })
        .in('id', stuckJobs.map(j => j.id));
    }

    // Get one pending job PER CLIENT (oldest per client) — clients process in parallel
    const { data: pendingJobs, error: jobError } = await supabase
      .from('sync_jobs')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(20);

    if (jobError || !pendingJobs || pendingJobs.length === 0) {
      console.log('[Cron] No pending jobs found');
      return NextResponse.json({ message: 'No pending jobs' });
    }

    // Deduplicate: pick the oldest pending job per client_id
    const jobsByClient = new Map<string, typeof pendingJobs[0]>();
    for (const job of pendingJobs) {
      if (!jobsByClient.has(job.client_id)) {
        jobsByClient.set(job.client_id, job);
      }
    }

    const jobsToProcess = Array.from(jobsByClient.values());
    console.log(`[Cron] Processing ${jobsToProcess.length} jobs in parallel (${pendingJobs.length} total pending)`);

    // Mark all selected jobs as running
    await supabase
      .from('sync_jobs')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .in('id', jobsToProcess.map(j => j.id));

    // Process all client jobs in parallel
    const results = await Promise.allSettled(
      jobsToProcess.map(job => processSingleJob(job))
    );

    // Collect results
    const summary = results.map((result, i) => {
      const job = jobsToProcess[i];
      if (result.status === 'fulfilled') {
        return { jobId: job.id, clientId: job.client_id, ...result.value };
      } else {
        return { jobId: job.id, clientId: job.client_id, error: String(result.reason) };
      }
    });

    return NextResponse.json({
      message: `Processed ${jobsToProcess.length} jobs in parallel`,
      jobs: summary
    });

  } catch (error) {
    console.error('[Cron] Error processing jobs:', error);
    return NextResponse.json(
      { error: 'Failed to process jobs' },
      { status: 500 }
    );
  }
}

// Process a single sync job (called in parallel per client)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processSingleJob(job: any): Promise<Record<string, unknown>> {
  try {
    // Route PlayStation jobs to their handler
    if (job.job_type === 'playstation_sync') {
      // PlayStation jobs return a NextResponse — extract the result
      const psResult = await processPlayStationJob(job);
      const psBody = await psResult.json();
      return { type: 'playstation', ...psBody };
    }

    // Default: Steam sync
    const { data: keyData, error: keyError } = await supabase
      .from('steam_api_keys')
      .select('*')
      .eq('client_id', job.client_id)
      .eq('is_active', true)
      .single();

    if (keyError || !keyData) {
      await supabase
        .from('sync_jobs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: 'No active Steam API key found'
        })
        .eq('id', job.id);
      return { error: 'No API key found' };
    }

    const financialApiKey = keyData.publisher_key || keyData.api_key;
    const useHighwatermark = job.force_full_sync ? '0' : (keyData.highwatermark || '0');

    const changedDates = await getChangedDatesForPartner(financialApiKey, useHighwatermark);

    if (!changedDates.success) {
      await supabase
        .from('sync_jobs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: changedDates.error || 'Failed to get dates from Steam'
        })
        .eq('id', job.id);
      return { error: changedDates.error };
    }

    // Filter dates to requested range
    let datesToSync = changedDates.dates || [];
    if (job.start_date || job.end_date) {
      datesToSync = datesToSync.filter((date: string) => {
        const d = date.replace(/\//g, '-');
        if (job.start_date && d < job.start_date) return false;
        if (job.end_date && d > job.end_date) return false;
        return true;
      });
    }

    // Update total dates if first run
    if (job.total_dates === 0) {
      await supabase
        .from('sync_jobs')
        .update({ total_dates: datesToSync.length })
        .eq('id', job.id);
    }

    // Get dates we haven't processed yet
    const alreadyProcessed = job.dates_processed || 0;
    const remainingDates = datesToSync.slice(alreadyProcessed);
    const datesToProcess = remainingDates.slice(0, MAX_DATES_PER_RUN);

    console.log(`[Cron] Job ${job.id}: Processing ${datesToProcess.length} dates (${alreadyProcessed} done, ${remainingDates.length} remaining)`);

    if (datesToProcess.length === 0) {
      await supabase
        .from('sync_jobs')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('id', job.id);
      return { message: 'Job completed', datesProcessed: alreadyProcessed };
    }

    // Process the dates
    let totalImported = job.rows_imported || 0;
    let totalSkipped = job.rows_skipped || 0;
    const errors: string[] = [];

    for (const dateStr of datesToProcess) {
      try {
        const result = await processSingleDate(financialApiKey, dateStr, job.client_id);
        totalImported += result.imported;
        totalSkipped += result.skipped;
      } catch (error) {
        const errorMsg = `Error processing ${dateStr}: ${error instanceof Error ? error.message : String(error)}`;
        console.error(`[Cron] ${errorMsg}`);
        errors.push(errorMsg);
      }
    }

    const newDatesProcessed = alreadyProcessed + datesToProcess.length;
    const isComplete = newDatesProcessed >= datesToSync.length;

    await supabase
      .from('sync_jobs')
      .update({
        status: isComplete ? 'completed' : 'running',
        dates_processed: newDatesProcessed,
        rows_imported: totalImported,
        rows_skipped: totalSkipped,
        completed_at: isComplete ? new Date().toISOString() : null,
        error_message: errors.length > 0 ? errors.join('; ') : null
      })
      .eq('id', job.id);

    if (changedDates.highwatermark) {
      await supabase
        .from('steam_api_keys')
        .update({ highwatermark: changedDates.highwatermark })
        .eq('client_id', job.client_id);
    }

    // If not complete, requeue for next cron run
    if (!isComplete) {
      await supabase
        .from('sync_jobs')
        .update({ status: 'pending' })
        .eq('id', job.id);
    }

    return {
      message: isComplete ? 'Job completed' : 'Batch processed',
      datesProcessed: newDatesProcessed,
      totalDates: datesToSync.length,
      rowsImported: totalImported,
      rowsSkipped: totalSkipped,
      isComplete
    };
  } catch (error) {
    // Mark job as failed so it doesn't block the queue
    await supabase
      .from('sync_jobs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`
      })
      .eq('id', job.id);
    throw error;
  }
}

// Helper function to get changed dates from Steam API
async function getChangedDatesForPartner(
  apiKey: string,
  highwatermark: string
): Promise<{ success: boolean; dates?: string[]; highwatermark?: string; error?: string }> {
  try {
    const url = `${STEAM_PARTNER_API}/IPartnerFinancialsService/GetChangedDatesForPartner/v001/?key=${apiKey}&highwatermark=${highwatermark}`;
    const response = await fetch(url);

    if (!response.ok) {
      return {
        success: false,
        error: `Steam API returned status ${response.status}`
      };
    }

    const data = await response.json();
    return {
      success: true,
      dates: data.response?.dates || [],
      highwatermark: data.response?.highwatermark
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to connect to Steam API: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

// Helper function to process a single date
async function processSingleDate(
  apiKey: string,
  dateStr: string,
  clientId: string
): Promise<{ imported: number; skipped: number }> {
  // Use GetDetailedSales endpoint (same as the working sync route)
  const url = `${STEAM_PARTNER_API}/IPartnerFinancialsService/GetDetailedSales/v001/?key=${apiKey}&date=${dateStr}&highwatermark_id=0`;
  console.log(`[Cron] Fetching data for date: ${dateStr}`);
  console.log(`[Cron] API URL: ${url.replace(apiKey, 'REDACTED')}`);
  const response = await fetch(url);

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[Cron] Steam API error for ${dateStr}: ${response.status}`);
    console.error(`[Cron] Error body: ${errorText}`);
    throw new Error(`Steam API returned status ${response.status} for date ${dateStr}`);
  }

  const data = await response.json();
  const results = data.response?.results || [];
  console.log(`[Cron] Date ${dateStr}: Found ${results.length} sales records`);

  // Create metadata maps from response
  const packages = new Map();
  const apps = new Map();
  data.response?.package_info?.forEach((p: any) => packages.set(p.packageid, p.package_name));
  data.response?.app_info?.forEach((a: any) => apps.set(a.appid, a.app_name));

  // Batch process all records at once instead of individual upserts
  const salesDataMap = new Map<string, any>();

  results.forEach((result: any) => {
    const productName = result.packageid
      ? packages.get(result.packageid)
      : result.appid
        ? apps.get(result.appid)
        : 'Unknown';

    const salesData = {
      client_id: clientId,
      sale_date: result.date.replace(/\//g, '-'),
      app_id: (result.primary_appid || result.appid)?.toString() || null,
      app_name: productName || null,
      product_type: result.packageid ? 'package' : 'app',
      country_code: result.country_code || null,
      units_sold: result.net_units_sold || 0,
      gross_revenue: parseFloat(result.gross_sales_usd || '0'),
      net_revenue: parseFloat(result.net_sales_usd || '0')
    };

    // Create unique key from constraint fields to deduplicate
    const key = `${salesData.client_id}|${salesData.sale_date}|${salesData.app_id}|${salesData.product_type}|${salesData.country_code}`;

    // If duplicate, sum the values
    if (salesDataMap.has(key)) {
      const existing = salesDataMap.get(key);
      existing.units_sold += salesData.units_sold;
      existing.gross_revenue += salesData.gross_revenue;
      existing.net_revenue += salesData.net_revenue;
    } else {
      salesDataMap.set(key, salesData);
    }
  });

  const salesDataBatch = Array.from(salesDataMap.values());
  console.log(`[Cron] Deduplicated ${results.length} records to ${salesDataBatch.length} unique rows`);

  // Single batch upsert for all records
  const { error, count } = await supabase
    .from('steam_sales')
    .upsert(salesDataBatch, {
      onConflict: 'client_id,sale_date,app_id,product_type,country_code',
      ignoreDuplicates: false,
      count: 'exact'
    });

  if (error) {
    console.error(`[Cron] Error batch upserting:`, error);
    return { imported: 0, skipped: results.length };
  }

  return { imported: count || salesDataBatch.length, skipped: 0 };
}

// ============================================================
// PlayStation (Domo) Sync Processing
// ============================================================

interface SyncJob {
  id: string;
  client_id: string;
  job_type: string;
  status: string;
  start_date: string | null;
  end_date: string | null;
  force_full_sync: boolean;
  is_auto_sync: boolean;
  total_dates: number;
  dates_processed: number;
  rows_imported: number;
  rows_skipped: number;
  result_data: PSJobState | null;
  [key: string]: unknown;
}

// Tracks PlayStation sync progress across multiple cron runs
// Mirrors Steam's date-chunking pattern: process a bit each run, requeue
interface PSJobState {
  // List of dataset IDs + metadata to process
  datasets: Array<{
    id: string;
    name: string;
    rows: number;
    completed: boolean;
    // For large datasets: track date-level chunking (like Steam's date-per-run)
    dates?: string[];        // All distinct dates in the dataset
    datesProcessed?: number; // How many dates have been processed
  }>;
  currentDatasetIndex: number;
}

async function processPlayStationJob(job: SyncJob) {
  try {
    console.log(`[Cron/PS] Processing PlayStation sync job ${job.id}`);

    // Get the client's PlayStation API credentials
    const { data: keyData, error: keyError } = await supabase
      .from('playstation_api_keys')
      .select('ps_client_id, client_secret, scope')
      .eq('client_id', job.client_id)
      .eq('is_active', true)
      .single();

    if (keyError || !keyData) {
      await supabase
        .from('sync_jobs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: 'No active PlayStation API credentials found'
        })
        .eq('id', job.id);

      return NextResponse.json({ error: 'No PlayStation API key found' }, { status: 404 });
    }

    // Step 1: Authenticate with Domo API
    const authResult = await getDomoAccessToken(keyData.ps_client_id, keyData.client_secret, keyData.scope);

    if (!authResult.success || !authResult.token) {
      await supabase
        .from('sync_jobs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: authResult.error || 'Failed to authenticate with Domo API'
        })
        .eq('id', job.id);

      return NextResponse.json({ error: authResult.error }, { status: 500 });
    }

    console.log('[Cron/PS] Authenticated with Domo API');

    // Step 2: Initialize or restore job state
    // Mirrors Steam pattern: track progress in result_data, process a chunk per run, requeue
    let state: PSJobState = (job.result_data as PSJobState) || { datasets: [], currentDatasetIndex: 0 };

    // First run: discover datasets and build the processing plan
    if (state.datasets.length === 0) {
      const datasetsResult = await listDomoDatasets(authResult.token);

      if (!datasetsResult.success || !datasetsResult.datasets?.length) {
        await supabase
          .from('sync_jobs')
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_message: 'No datasets available from Domo API'
          })
          .eq('id', job.id);

        return NextResponse.json({ error: 'No datasets found' }, { status: 404 });
      }

      console.log(`[Cron/PS] Found ${datasetsResult.datasets.length} total datasets`);

      // Focus on the Daily Sales dataset — it's the only one with revenue/units columns
      // Other datasets (vouchers, PS Plus, hourly) have different schemas and import as $0
      const dailySalesDatasets = datasetsResult.datasets.filter(d => {
        const name = d.name.toLowerCase();
        return name.includes('daily sales') && d.rows > 0;
      });

      // Fallback: if no daily sales found, try broader sales filter
      const SALES_KEYWORDS = ['sales', 'monetisation', 'dlc'];
      const salesDatasets = dailySalesDatasets.length > 0
        ? dailySalesDatasets
        : datasetsResult.datasets.filter(d => {
            const name = d.name.toLowerCase();
            return SALES_KEYWORDS.some(kw => name.includes(kw)) && d.rows > 0;
          });

      const sorted = salesDatasets.length > 0
        ? salesDatasets.sort((a, b) => a.rows - b.rows)
        : datasetsResult.datasets.filter(d => d.rows > 0).sort((a, b) => a.rows - b.rows);

      state = {
        datasets: sorted.map(d => ({
          id: d.id,
          name: d.name,
          rows: d.rows,
          completed: false,
        })),
        currentDatasetIndex: 0,
      };

      // Calculate total processing steps for progress tracking
      // Small datasets = 1 step each, large datasets will add date steps later
      const totalSteps = sorted.length;
      await supabase
        .from('sync_jobs')
        .update({ total_dates: totalSteps, result_data: state })
        .eq('id', job.id);

      console.log(`[Cron/PS] ${salesDatasets.length} sales datasets, ${sorted.length} total to process`);
    }

    // Step 3: Process the current dataset (one per cron run, like Steam's date-per-run)
    let totalImported = job.rows_imported || 0;
    let totalSkipped = job.rows_skipped || 0;
    const errors: string[] = [];

    const currentDS = state.datasets[state.currentDatasetIndex];
    if (!currentDS || currentDS.completed) {
      // Find next incomplete dataset
      const nextIdx = state.datasets.findIndex(d => !d.completed);
      if (nextIdx === -1) {
        // All datasets complete!
        return await completePlayStationJob(job, totalImported, totalSkipped, state);
      }
      state.currentDatasetIndex = nextIdx;
    }

    const dataset = state.datasets[state.currentDatasetIndex];
    const isLargeDataset = dataset.rows > LARGE_DATASET_THRESHOLD;

    if (isLargeDataset) {
      // === LARGE DATASET: SQL query API with date chunking (mirrors Steam pattern) ===
      console.log(`[Cron/PS] Large dataset: ${dataset.name} (${dataset.rows} rows) — using SQL date chunking`);

      // First time on this dataset: discover distinct dates
      if (!dataset.dates || dataset.dates.length === 0) {
        console.log(`[Cron/PS] Discovering dates for ${dataset.name}...`);
        const datesResult = await queryDomoDatasetDates(authResult.token, dataset.id);

        if (!datesResult.success || !datesResult.dates?.length) {
          console.error(`[Cron/PS] Failed to get dates for ${dataset.name}: ${datesResult.error}`);
          dataset.completed = true;
          errors.push(`No dates found for ${dataset.name}: ${datesResult.error}`);
        } else {
          dataset.dates = datesResult.dates;
          dataset.datesProcessed = 0;
          // Update total_dates to reflect the actual work (original count + this dataset's dates)
          const additionalSteps = datesResult.dates.length - 1; // -1 because the dataset was already counted as 1 step
          await supabase
            .from('sync_jobs')
            .update({ total_dates: (job.total_dates || 0) + additionalSteps })
            .eq('id', job.id);
          console.log(`[Cron/PS] Found ${datesResult.dates.length} distinct dates in ${dataset.name}`);
        }
      }

      // Process a batch of dates for this dataset
      if (dataset.dates && dataset.dates.length > 0 && !dataset.completed) {
        const alreadyDone = dataset.datesProcessed || 0;
        const remaining = dataset.dates.slice(alreadyDone);
        const batch = remaining.slice(0, DATES_PER_PS_RUN);

        if (batch.length === 0) {
          dataset.completed = true;
        } else {
          for (const dateStr of batch) {
            try {
              console.log(`[Cron/PS] Querying ${dataset.name} for date ${dateStr}`);
              const result = await queryDomoDatasetByDate(
                authResult.token, dataset.id, dateStr, job.client_id
              );
              totalImported += result.imported;
              totalSkipped += result.skipped;
              console.log(`[Cron/PS] ${dataset.name} date ${dateStr}: imported=${result.imported}, skipped=${result.skipped}`);
            } catch (error) {
              const errorMsg = `Error querying ${dataset.name} date ${dateStr}: ${error instanceof Error ? error.message : String(error)}`;
              console.error(`[Cron/PS] ${errorMsg}`);
              errors.push(errorMsg);
            }
          }

          dataset.datesProcessed = alreadyDone + batch.length;
          if (dataset.datesProcessed >= dataset.dates.length) {
            dataset.completed = true;
            console.log(`[Cron/PS] Completed large dataset: ${dataset.name}`);
          }
        }
      }
    } else {
      // === SMALL DATASET: CSV export (already works fine) ===
      try {
        console.log(`[Cron/PS] Exporting dataset: ${dataset.name} (${dataset.id}, ${dataset.rows} rows)`);
        const result = await exportDomoDataset(authResult.token, dataset.id, job.client_id, job.start_date, job.end_date);
        totalImported += result.imported;
        totalSkipped += result.skipped;
        console.log(`[Cron/PS] Dataset ${dataset.name}: imported=${result.imported}, skipped=${result.skipped}`);
        dataset.completed = true;
      } catch (error) {
        const errorMsg = `Error processing dataset ${dataset.name}: ${error instanceof Error ? error.message : String(error)}`;
        console.error(`[Cron/PS] ${errorMsg}`);
        errors.push(errorMsg);
        dataset.completed = true; // Move on even if failed
      }
    }

    // Move to next dataset if current one is complete
    if (dataset.completed) {
      state.currentDatasetIndex++;
    }

    // Calculate progress
    let totalProcessed = 0;
    for (const ds of state.datasets) {
      if (ds.completed) {
        totalProcessed += ds.dates ? ds.dates.length : 1;
      } else if (ds.datesProcessed) {
        totalProcessed += ds.datesProcessed;
      }
    }

    const allComplete = state.datasets.every(d => d.completed);

    // Save state and progress
    await supabase
      .from('sync_jobs')
      .update({
        status: allComplete ? 'completed' : 'running',
        dates_processed: totalProcessed,
        rows_imported: totalImported,
        rows_skipped: totalSkipped,
        completed_at: allComplete ? new Date().toISOString() : null,
        error_message: errors.length > 0 ? errors.join('; ') : null,
        result_data: state,
      })
      .eq('id', job.id);

    if (allComplete) {
      return await completePlayStationJob(job, totalImported, totalSkipped, state);
    } else {
      // Requeue for next cron run (same pattern as Steam)
      await supabase
        .from('sync_jobs')
        .update({ status: 'pending' })
        .eq('id', job.id);
    }

    return NextResponse.json({
      message: allComplete ? 'PlayStation sync completed' : 'PlayStation batch processed, more pending',
      jobId: job.id,
      datesProcessed: totalProcessed,
      rowsImported: totalImported,
      rowsSkipped: totalSkipped,
      isComplete: allComplete,
    });

  } catch (error) {
    console.error('[Cron/PS] Error:', error);
    await supabase
      .from('sync_jobs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: `PlayStation sync error: ${error instanceof Error ? error.message : String(error)}`
      })
      .eq('id', job.id);

    return NextResponse.json({ error: 'PlayStation sync failed' }, { status: 500 });
  }
}

// Mark PlayStation job as complete and update sync timestamps
async function completePlayStationJob(
  job: SyncJob, totalImported: number, totalSkipped: number, state: PSJobState
) {
  await supabase
    .from('sync_jobs')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      rows_imported: totalImported,
      rows_skipped: totalSkipped,
      result_data: state,
    })
    .eq('id', job.id);

  // Update last sync timestamps
  await supabase
    .from('playstation_api_keys')
    .update({
      last_auto_sync: new Date().toISOString(),
      last_sync_date: new Date().toISOString().split('T')[0]
    })
    .eq('client_id', job.client_id);

  // Schedule next sync if auto-sync is enabled
  const { data: psKey } = await supabase
    .from('playstation_api_keys')
    .select('auto_sync_enabled, sync_frequency_hours')
    .eq('client_id', job.client_id)
    .single();

  if (psKey?.auto_sync_enabled && job.is_auto_sync) {
    const nextDue = new Date();
    nextDue.setHours(nextDue.getHours() + (psKey.sync_frequency_hours || 24));
    await supabase
      .from('playstation_api_keys')
      .update({ next_sync_due: nextDue.toISOString() })
      .eq('client_id', job.client_id);
  }

  return NextResponse.json({
    message: 'PlayStation sync completed',
    jobId: job.id,
    rowsImported: totalImported,
    rowsSkipped: totalSkipped,
  });
}

// Get Domo OAuth access token
async function getDomoAccessToken(
  clientId: string,
  clientSecret: string,
  scope?: string
): Promise<{ success: boolean; token?: string; error?: string }> {
  try {
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const effectiveScope = scope || 'data';
    const authUrl = `${DOMO_AUTH_URL}?grant_type=client_credentials&scope=${encodeURIComponent(effectiveScope)}`;

    const response = await fetch(authUrl, {
      method: 'GET',
      headers: { 'Authorization': `Basic ${basicAuth}` }
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `Domo auth failed: ${response.status} ${errorText}` };
    }

    const data = await response.json();
    if (!data.access_token) {
      return { success: false, error: 'No access token received from Domo' };
    }

    return { success: true, token: data.access_token };
  } catch (error) {
    return { success: false, error: `Domo connection error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// List Domo datasets
async function listDomoDatasets(
  accessToken: string
): Promise<{ success: boolean; datasets?: Array<{ id: string; name: string; rows: number }>; error?: string }> {
  try {
    const response = await fetch(`${DOMO_DATASETS_URL}?limit=50&offset=0`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      return { success: false, error: `Failed to list datasets: ${response.status}` };
    }

    const data = await response.json();
    const datasets = Array.isArray(data)
      ? data.map((d: { id?: string; name?: string; datasetId?: string; displayName?: string; rows?: number }) => ({
        id: d.id || d.datasetId || '',
        name: d.name || d.displayName || d.id || 'Unknown',
        rows: d.rows || 0
      })).filter(d => d.id)
      : [];

    return { success: true, datasets };
  } catch (error) {
    return { success: false, error: `Failed to fetch datasets: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// Export a Domo dataset and store records
async function exportDomoDataset(
  accessToken: string,
  datasetId: string,
  clientId: string,
  startDate: string | null,
  endDate: string | null
): Promise<{ imported: number; skipped: number }> {
  const url = DOMO_EXPORT_URL.replace('{datasetId}', datasetId) + '?includeHeader=true';

  // 45s timeout to leave room for DB operations within the 60s cron window
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'text/csv'
    },
    signal: controller.signal
  });

  clearTimeout(timeout);

  if (!response.ok) {
    throw new Error(`Domo export failed: ${response.status}`);
  }

  const csvText = await response.text();
  const allRecords = parseCSVToRecords(csvText);

  // Log the first record's keys to help debug column mapping
  if (allRecords.length > 0) {
    console.log(`[Cron/PS] CSV columns found: ${Object.keys(allRecords[0]).join(', ')}`);
  }

  console.log(`[Cron/PS] Parsed ${allRecords.length} records from dataset ${datasetId}`);

  // Cap at 20K records per cron run to stay within time limits
  // Take the LAST records (most recent) since Domo typically sorts chronologically
  const MAX_RECORDS = 20000;
  const records = allRecords.length > MAX_RECORDS
    ? allRecords.slice(allRecords.length - MAX_RECORDS)
    : allRecords;
  if (allRecords.length > MAX_RECORDS) {
    console.log(`[Cron/PS] Capped to last ${MAX_RECORDS} records (from ${allRecords.length})`);
  }

  // Filter by date range if specified
  const filteredRecords = records.filter(record => {
    // Try multiple date column names from the Domo CSV
    const date = (record.date || record.month_start_date || record.week_start_date || '') as string;
    if (!date) return false;
    const dateStr = date.split('T')[0]; // normalize
    if (startDate && dateStr < startDate) return false;
    if (endDate && dateStr > endDate) return false;
    return true;
  });

  console.log(`[Cron/PS] ${filteredRecords.length} records after date filter`);

  if (filteredRecords.length === 0) {
    return { imported: 0, skipped: 0 };
  }

  // Use shared upsert logic
  return await upsertPSNRecords(filteredRecords, clientId);
}

// ============================================================
// Domo SQL Query API — Date-chunked import for large datasets
// Mirrors Steam's "1 date per cron run" pattern
// ============================================================

// Get distinct dates from a large Domo dataset via SQL query
async function queryDomoDatasetDates(
  accessToken: string,
  datasetId: string
): Promise<{ success: boolean; dates?: string[]; error?: string }> {
  try {
    const url = DOMO_QUERY_URL.replace('{datasetId}', datasetId);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        sql: 'SELECT DISTINCT `Date` FROM table ORDER BY `Date` DESC',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `Domo SQL query failed: ${response.status} ${errorText}` };
    }

    const data = await response.json();
    // Domo returns { columns: [...], rows: [[val], [val], ...], numRows: N, numColumns: N }
    const rows = data.rows || [];
    const dates = rows
      .map((row: string[]) => {
        const val = row[0];
        if (!val) return null;
        return val.split('T')[0]; // Normalize to YYYY-MM-DD
      })
      .filter((d: string | null): d is string => !!d);

    console.log(`[Cron/PS] SQL query returned ${dates.length} distinct dates`);
    return { success: true, dates };
  } catch (error) {
    return {
      success: false,
      error: `Domo SQL query error: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

// Query a specific date's data from a large Domo dataset and upsert to performance_metrics
async function queryDomoDatasetByDate(
  accessToken: string,
  datasetId: string,
  dateStr: string,
  clientId: string
): Promise<{ imported: number; skipped: number }> {
  const url = DOMO_QUERY_URL.replace('{datasetId}', datasetId);

  // 40s timeout to leave room for DB operations within the 60s cron window
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 40000);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      sql: `SELECT * FROM table WHERE \`Date\` = '${dateStr}'`,
    }),
    signal: controller.signal,
  });

  clearTimeout(timeout);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Domo SQL query failed for date ${dateStr}: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const columns: string[] = data.columns || [];
  const rows: string[][] = data.rows || [];

  console.log(`[Cron/PS] SQL query for ${dateStr}: ${rows.length} rows, columns: ${columns.join(', ')}`);

  // Log first row raw data for debugging column mapping
  if (rows.length > 0) {
    const sampleRow: Record<string, string> = {};
    columns.forEach((col, idx) => { sampleRow[col] = rows[0][idx]; });
    console.log(`[Cron/PS] Sample raw row: ${JSON.stringify(sampleRow)}`);
  }

  if (rows.length === 0) {
    return { imported: 0, skipped: 0 };
  }

  // Convert SQL result rows to PSNRecord objects (same format as CSV parser output)
  const records: PSNRecord[] = rows.map(row => {
    const record: PSNRecord = { date: '' };
    columns.forEach((col, idx) => {
      const normalizedKey = col.toLowerCase().replace(/\s+/g, '_');
      record[normalizedKey] = row[idx] || '';
    });
    if (!record.date) {
      record.date = (record.transaction_date || record.sale_date || '') as string;
    }
    return record;
  });

  // Log first mapped record for debugging
  if (records.length > 0) {
    const r = records[0];
    console.log(`[Cron/PS] Sample normalized keys: ${Object.keys(r).join(', ')}`);
    console.log(`[Cron/PS] Revenue fields: sales_incl_tax_$=${r['sales_incl_tax_$']}, sales_exc_tax_$=${r['sales_exc_tax_$']}, sales_quantity=${r.sales_quantity}`);
  }

  // Reuse the same upsert logic as CSV export
  return await upsertPSNRecords(records, clientId);
}

// Shared upsert logic for PSN records (used by both CSV export and SQL query paths)
function mapPSNRecordToMetric(record: PSNRecord, clientId: string) {
  // Map actual Domo/PlayStation columns to our schema
  // Domo columns: Date, Title Name, Product Name, Platform, Country Code,
  // Country/Region, SIE Region, Sales Quantity, Sales Incl Tax $, Sales Exc Tax $,
  // Local Currency, Transaction Type
  const date = (record.date || record.month_start_date || record.week_start_date || '') as string;
  const productName = (record.product_name || record.title_name || record.concept || record.title || record.sku || 'Unknown') as string;
  // Normalize platform to "PlayStation" to match the connected-platforms filter
  const platform = 'PlayStation';
  const countryCode = (record.country_code || record['country/region'] || record.country || 'Unknown') as string;
  const region = (record.sie_region || record['country/region'] || record.region || 'Unknown') as string;
  // Sales data columns from PlayStation Domo CSV
  const unitsSold = Number(record.sales_quantity || record.units_sold || record.quantity || 0);
  const grossRevenue = Number(record['sales_incl_tax_$'] || record.sales_incl_tax_usd || record.gross_revenue || record.revenue || 0);
  const netRevenue = Number(record['sales_exc_tax_$'] || record.sales_exc_tax_usd || record.net_revenue || record.revenue || 0);
  const currency = (record.local_currency || record.currency || 'USD') as string;

  return {
    client_id: clientId,
    date: date.toString().split('T')[0],
    product_name: productName,
    platform,
    country_code: countryCode,
    region,
    gross_units_sold: unitsSold,
    net_units_sold: unitsSold,
    gross_revenue_usd: grossRevenue,
    net_revenue_usd: netRevenue,
    currency,
    updated_at: new Date().toISOString(),
  };
}

async function upsertPSNRecords(
  records: PSNRecord[],
  clientId: string
): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;

  // Batch upsert in chunks of 100
  const chunkSize = 100;
  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize).map(record =>
      mapPSNRecordToMetric(record, clientId)
    );

    const { error, count } = await supabase
      .from('performance_metrics')
      .upsert(chunk, {
        onConflict: 'client_id,date,product_name,platform,country_code',
        ignoreDuplicates: false,
        count: 'exact',
      });

    if (error) {
      console.error(`[Cron/PS] Batch upsert error:`, error);
      skipped += chunk.length;
    } else {
      imported += count || chunk.length;
    }
  }

  return { imported, skipped };
}

// Parse CSV text to records (shared utility)
interface PSNRecord {
  date: string;
  product_name?: string;
  title_name?: string;
  title?: string;
  sku?: string;
  region?: string;
  country?: string;
  units_sold?: number;
  quantity?: number;
  gross_revenue?: number;
  net_revenue?: number;
  revenue?: number;
  currency?: string;
  [key: string]: unknown;
}

function parseCSVToRecords(csvText: string): PSNRecord[] {
  const lines = csvText.split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]);
  const records: PSNRecord[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const record: PSNRecord = { date: '' };

    headers.forEach((header, idx) => {
      const normalizedKey = header.toLowerCase().replace(/\s+/g, '_');
      record[normalizedKey] = values[idx] || '';
    });

    if (!record.date) {
      record.date = (record.transaction_date || record.sale_date || '') as string;
    }

    records.push(record);
  }

  return records;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}
