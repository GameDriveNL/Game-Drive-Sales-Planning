import { NextResponse } from 'next/server'
import { serverSupabase as supabase } from '@/lib/supabase'

/**
 * Returns sync health status per client — used to show warnings
 * on the API keys settings page when syncs are failing.
 */
export async function GET() {
  try {
    // Get the most recent sync jobs per client (last 10 per client)
    const { data: recentJobs, error } = await supabase
      .from('sync_jobs')
      .select('client_id, status, error_message, completed_at, dates_processed, total_dates')
      .in('status', ['failed', 'completed'])
      .order('completed_at', { ascending: false })
      .limit(200)

    if (error) {
      return NextResponse.json({}, { status: 500 })
    }

    // Group by client and compute health
    const healthByClient: Record<string, {
      status: string
      error: string | null
      failCount: number
      lastFailure: string | null
    }> = {}

    // Track jobs per client (most recent first)
    const jobsByClient = new Map<string, typeof recentJobs>()
    for (const job of (recentJobs || [])) {
      if (!jobsByClient.has(job.client_id)) {
        jobsByClient.set(job.client_id, [])
      }
      const clientJobs = jobsByClient.get(job.client_id)!
      if (clientJobs.length < 10) {
        clientJobs.push(job)
      }
    }

    for (const [clientId, jobs] of Array.from(jobsByClient.entries())) {
      // Count consecutive recent failures (from most recent)
      let consecutiveFailures = 0
      let lastError: string | null = null
      let lastFailureTime: string | null = null

      for (const job of jobs) {
        if (job.status === 'failed') {
          consecutiveFailures++
          if (!lastError) lastError = job.error_message
          if (!lastFailureTime) lastFailureTime = job.completed_at
        } else {
          break // Stop counting at the first success
        }
      }

      // Also flag "completed but empty" — key works but returns no data
      const mostRecent = jobs[0]
      if (mostRecent && mostRecent.status === 'completed' && mostRecent.total_dates === 0 && mostRecent.dates_processed === 0) {
        // Check if we have ANY data for this client
        const { count } = await supabase
          .from('steam_sales')
          .select('id', { count: 'exact', head: true })
          .eq('client_id', clientId)

        if (count === 0) {
          healthByClient[clientId] = {
            status: 'empty',
            error: 'Sync completed but Steam returned 0 financial dates — your API key may not have financial reporting permissions.',
            failCount: 1,
            lastFailure: mostRecent.completed_at,
          }
          continue
        }
      }

      if (consecutiveFailures > 0) {
        healthByClient[clientId] = {
          status: 'failing',
          error: lastError,
          failCount: consecutiveFailures,
          lastFailure: lastFailureTime,
        }
      }
    }

    return NextResponse.json(healthByClient)
  } catch (err) {
    console.error('[Sync Health] Error:', err)
    return NextResponse.json({}, { status: 500 })
  }
}
