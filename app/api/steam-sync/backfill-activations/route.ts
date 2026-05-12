import { NextResponse } from 'next/server'
import { serverSupabase as supabase } from '@/lib/supabase'

// Steam returns demo installs + retail-key redemptions as `gross_units_activated` on
// GetDetailedSales rows. Until 2026-05-12 the sync discarded this field, so every
// performance_metrics row in the database has `gross_units_activated = 0` regardless of
// what Steam actually reported. This endpoint re-fetches historical dates and updates
// just that column on existing rows — leaving everything else (financial data,
// highwatermark) untouched.
//
// Idempotent: re-running the same date range is safe; rows already populated stay the same.
// Paginates 30 dates per call to stay under Vercel timeouts.

const STEAM_PARTNER_API = 'https://partner.steam-api.com'
const MAX_DATES_PER_REQUEST = 30

interface DetailedSalesRow {
  date: string
  packageid?: number
  appid?: number
  primary_appid?: number
  platform?: string
  country_code: string
  gross_units_activated?: number
}

interface DetailedSalesResponse {
  response: {
    results?: DetailedSalesRow[]
    package_info?: Array<{ packageid: number; package_name: string }>
    app_info?: Array<{ appid: number; app_name: string }>
    max_id?: string
  }
}

interface ChangedDatesResponse {
  response: { dates?: string[]; result_highwatermark?: string }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { client_id, start_date } = body

    if (!client_id) {
      return NextResponse.json({ error: 'client_id is required' }, { status: 400 })
    }

    const { data: keyData, error: keyErr } = await supabase
      .from('steam_api_keys')
      .select('publisher_key, api_key')
      .eq('client_id', client_id)
      .eq('is_active', true)
      .single()

    if (keyErr || !keyData) {
      return NextResponse.json({ error: 'No active Steam API key found for this client.' }, { status: 404 })
    }
    const apiKey = keyData.publisher_key || keyData.api_key
    if (!apiKey) {
      return NextResponse.json({ error: 'No Financial Web API Key configured for this client.' }, { status: 400 })
    }

    // Get the full list of dates with data from Steam (highwatermark=0 returns everything)
    const datesRes = await fetch(`${STEAM_PARTNER_API}/IPartnerFinancialsService/GetChangedDatesForPartner/v001/?key=${apiKey}&highwatermark=0`)
    if (!datesRes.ok) {
      const t = await datesRes.text()
      return NextResponse.json({ error: `Steam API ${datesRes.status}: ${t.substring(0, 200)}` }, { status: 502 })
    }
    const datesJson = (await datesRes.json()) as ChangedDatesResponse
    let allDates = (datesJson.response?.dates || []).map(d => d.replace(/\//g, '-'))
    // Process most-recent dates first so the first click produces immediately useful
    // numbers (typical demos and recent fests are in the last ~90 days). Resume cursor
    // moves backwards in time.
    allDates.sort((a, b) => b.localeCompare(a))

    // Resume from `start_date` (cursor moves into the past)
    if (start_date) {
      allDates = allDates.filter(d => d <= start_date)
    }

    const totalRemaining = allDates.length
    const datesToProcess = allDates.slice(0, MAX_DATES_PER_REQUEST)
    const hasMore = totalRemaining > MAX_DATES_PER_REQUEST
    const nextStartDate = hasMore ? allDates[MAX_DATES_PER_REQUEST] : null

    let totalRowsUpdated = 0
    const errors: string[] = []

    for (const date of datesToProcess) {
      try {
        // Pull every page of this date
        let hwm = '0'
        let pages = 0
        const allRows: DetailedSalesRow[] = []
        const packageNames = new Map<number, string>()
        const appNames = new Map<number, string>()

        while (pages < 20) {
          const url = `${STEAM_PARTNER_API}/IPartnerFinancialsService/GetDetailedSales/v001/?key=${apiKey}&date=${date}&highwatermark_id=${hwm}`
          const resp = await fetch(url)
          if (!resp.ok) {
            errors.push(`${date}: Steam ${resp.status}`)
            break
          }
          const json = (await resp.json()) as DetailedSalesResponse
          const r = json.response
          if (r.results) allRows.push(...r.results)
          r.package_info?.forEach(p => packageNames.set(p.packageid, p.package_name))
          r.app_info?.forEach(a => appNames.set(a.appid, a.app_name))
          const nextHwm = r.max_id
          if (!nextHwm || nextHwm === hwm) break
          hwm = nextHwm
          pages++
        }

        // Only rows with non-zero activations need an UPDATE
        const activationRows = allRows.filter(r => Number(r.gross_units_activated || 0) > 0)
        if (activationRows.length === 0) continue

        for (const row of activationRows) {
          const productName = row.packageid
            ? packageNames.get(row.packageid)
            : row.appid
              ? appNames.get(row.appid)
              : 'Unknown'
          if (!productName) continue

          // UPDATE the existing performance_metrics row — never insert.
          // The original sync code already inserted rows for every Steam result with
          // gross_units_activated=0; we're just filling in the value now.
          // Upsert: matches the original sync's onConflict key. For clients whose data
          // lives in steam_sales (legacy CSV imports), no performance_metrics row exists yet,
          // so we have to INSERT. For clients on the new sync, the row already exists and
          // we UPDATE just the activation field. Either way the conflict key handles it.
          const { error: upErr } = await supabase
            .from('performance_metrics')
            .upsert({
              client_id,
              date,
              product_name: productName,
              platform: row.platform || 'Steam',
              country_code: row.country_code,
              gross_units_activated: row.gross_units_activated,
              gross_units_sold: 0,
              net_units_sold: 0,
              gross_revenue_usd: 0,
              net_revenue_usd: 0,
            }, { onConflict: 'client_id,date,product_name,platform,country_code' })
          if (upErr) {
            errors.push(`${date}/${productName}/${row.country_code}: ${upErr.message}`)
          } else {
            totalRowsUpdated += 1
          }
        }
      } catch (e) {
        errors.push(`${date}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    return NextResponse.json({
      success: true,
      dates_processed: datesToProcess.length,
      rows_updated: totalRowsUpdated,
      has_more: hasMore,
      next_start_date: nextStartDate,
      remaining_dates: hasMore ? totalRemaining - datesToProcess.length : 0,
      errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 })
  }
}
