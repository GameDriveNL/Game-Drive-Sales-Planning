import { NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { verifyCronAuth } from '@/lib/cron-auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

// ─── Helpers ────────────────────────────────────────────────────────────────

function suggestTier(monthlyVisitors: number | null): string | null {
  if (!monthlyVisitors) return null
  if (monthlyVisitors >= 10_000_000) return 'A'
  if (monthlyVisitors >= 1_000_000) return 'B'
  if (monthlyVisitors >= 100_000) return 'C'
  return 'D'
}

function parseTrafficFromHtml(html: string): number | null {
  // Hypestat HTML structure: <dt...>Monthly Visits:</dt><dd>8,472,032</dd>
  // Only use the exact Hypestat <dt>/<dd> structure to avoid false positives
  // from ad affiliate IDs (e.g. SEMRush "/display-ad/13053")

  // Primary: Monthly Visits from the stats table
  const monthlyMatch = html.match(/Monthly Visits:<\/dt><dd>([\d,]+)<\/dd>/i)
  if (monthlyMatch) {
    const num = parseInt(monthlyMatch[1].replace(/,/g, ''))
    if (!isNaN(num) && num > 0) return num
  }

  // Fallback: Daily Unique Visitors × 30
  const dailyMatch = html.match(/Daily Unique Visitors:<\/dt><dd>([\d,]+)<\/dd>/i)
  if (dailyMatch) {
    const num = parseInt(dailyMatch[1].replace(/,/g, ''))
    if (!isNaN(num) && num > 0) return num * 30
  }

  // No generic/loose patterns — they match ad IDs and produce garbage data
  return null
}

async function fetchHypestatTraffic(domain: string, tavilyApiKey: string | null): Promise<{ visitors: number | null; method: string; debug?: string }> {
  // Method 1: Direct HTML fetch
  try {
    const url = `https://hypestat.com/info/${domain}`
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: AbortSignal.timeout(10000)
    })

    if (response.ok) {
      const html = await response.text()
      const visitors = parseTrafficFromHtml(html)
      if (visitors) return { visitors, method: 'hypestat_html' }
      // Debug: check if the expected pattern exists at all
      const hasMonthlyDt = html.includes('Monthly Visits:</dt>')
      const hasDailyDt = html.includes('Daily Unique Visitors:</dt>')
      return { visitors: null, method: 'none', debug: `html_size=${html.length} has_monthly_dt=${hasMonthlyDt} has_daily_dt=${hasDailyDt}` }
    }
  } catch { /* continue to fallback */ }

  // Method 2: Tavily Extract fallback
  if (tavilyApiKey) {
    try {
      const { tavily } = await import('@tavily/core')
      const tvly = tavily({ apiKey: tavilyApiKey })
      const result = await tvly.extract([`https://hypestat.com/info/${domain}`])

      if (result.results && result.results.length > 0) {
        const content = result.results[0].rawContent || ''
        const visitors = parseTrafficFromHtml(content)
        if (visitors) return { visitors, method: 'tavily_extract' }
      }
    } catch { /* continue */ }
  }

  return { visitors: null, method: 'none' }
}

// ─── Main Handler: Weekly traffic refresh ───────────────────────────────────

export async function GET(request: Request) {
  const startTime = Date.now()
  const supabase = getServerSupabase()

  try {
    // Auth — fails closed (was a Mozilla User-Agent bypass; trivially spoofed).
    const authError = verifyCronAuth(request)
    if (authError) return authError

    // Get Tavily API key for fallback
    const { data: keyData } = await supabase
      .from('service_api_keys')
      .select('api_key')
      .eq('service_name', 'tavily')
      .single()

    const tavilyApiKey = keyData?.api_key || null

    // Find outlets with stale or missing traffic data
    // Stale = traffic_last_updated older than 30 days or null
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

    const { data: staleOutlets, error: fetchErr } = await supabase
      .from('outlets')
      .select('id, name, domain, monthly_unique_visitors, tier, traffic_last_updated')
      .not('domain', 'is', null)
      .neq('domain', '')
      .or(`traffic_last_updated.is.null,traffic_last_updated.lt.${thirtyDaysAgo.toISOString()}`)
      .order('traffic_last_updated', { ascending: true, nullsFirst: true })
      .limit(50)

    if (fetchErr) {
      console.error('[Traffic Refresh] Failed to fetch stale outlets:', fetchErr)
      return NextResponse.json({ error: 'Failed to fetch outlets' }, { status: 500 })
    }

    if (!staleOutlets || staleOutlets.length === 0) {
      return NextResponse.json({
        message: 'No outlets need traffic refresh',
        stats: { checked: 0, updated: 0, failed: 0 }
      })
    }

    const stats = {
      total_stale: staleOutlets.length,
      processed: 0,
      updated: 0,
      failed: 0,
      skipped: 0,
      errors: [] as string[]
    }

    // Process outlets (limit to 20 per run to stay within time limit)
    const batch = staleOutlets.slice(0, 20)

    for (const outlet of batch) {
      // Time guard
      if (Date.now() - startTime > 50000) {
        console.log('[Traffic Refresh] Approaching time limit, stopping early')
        break
      }

      const domain = outlet.domain!.replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/.*$/, '').trim()

      if (!domain) {
        stats.skipped++
        continue
      }

      try {
        const result = await fetchHypestatTraffic(domain, tavilyApiKey)
        stats.processed++

        if (result.visitors) {
          const newTier = suggestTier(result.visitors)
          await supabase
            .from('outlets')
            .update({
              monthly_unique_visitors: result.visitors,
              tier: newTier,
              traffic_last_updated: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .eq('id', outlet.id)

          stats.updated++
          console.log(`[Traffic Refresh] ${outlet.name} (${domain}): ${result.visitors.toLocaleString()} visitors via ${result.method}`)
        } else {
          // Mark as checked even if no data found, to avoid re-checking every run
          await supabase
            .from('outlets')
            .update({
              traffic_last_updated: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .eq('id', outlet.id)

          stats.failed++
          stats.errors.push(`${outlet.name} (${domain}): no data found [${result.debug || 'no debug'}]`)
        }
      } catch (err) {
        stats.failed++
        const errMsg = err instanceof Error ? err.message : String(err)
        stats.errors.push(`${outlet.name} (${domain}): ${errMsg}`)
        console.error(`[Traffic Refresh] Error for ${outlet.name}:`, errMsg)
      }
    }

    const duration = Date.now() - startTime
    console.log(`[Traffic Refresh] Completed in ${duration}ms:`, stats)

    return NextResponse.json({
      message: 'Traffic refresh complete',
      duration_ms: duration,
      stats
    })

  } catch (err) {
    console.error('[Traffic Refresh] Fatal error:', err)
    return NextResponse.json(
      { error: 'Traffic refresh failed', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
