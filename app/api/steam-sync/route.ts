import { NextResponse } from 'next/server';
import { serverSupabase as supabase } from '@/lib/supabase';
import { matchProducts, ExternalProduct } from '@/lib/product-matching';

// Steam Partner API endpoint for financial data
const STEAM_PARTNER_API = 'https://partner.steam-api.com';

interface SteamDetailedSalesResult {
  partnerid: string;
  date: string;
  line_item_type: string;
  packageid?: number;
  bundleid?: number;
  appid?: number;
  game_item_id?: number;
  package_sale_type?: string;
  platform?: string;
  country_code: string;
  base_price?: string;
  sale_price?: string;
  currency?: string;
  gross_units_sold?: number;
  gross_units_returned?: number;
  gross_sales_usd?: string;
  gross_returns_usd?: string;
  net_tax_usd?: string;
  gross_units_activated?: number;
  net_units_sold?: number;
  net_sales_usd?: string;
  primary_appid?: number;
  combined_discount_id?: number;
  total_discount_percentage?: number;
}

interface SteamSalesResponse {
  response: {
    results?: SteamDetailedSalesResult[];
    package_info?: Array<{ packageid: number; package_name: string }>;
    app_info?: Array<{ appid: number; app_name: string }>;
    country_info?: Array<{ country_code: string; country_name: string; region: string }>;
    max_id?: string;
  };
}

interface ChangedDatesResponse {
  response: {
    dates?: string[];
    result_highwatermark?: string;
  };
}

// POST - Sync financial data from Steam using IPartnerFinancialsService
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { client_id, start_date, end_date, app_id, force_full_sync } = body;

    if (!client_id) {
      return NextResponse.json(
        { error: 'Client ID is required' },
        { status: 400 }
      );
    }

    // Get the client's Steam API keys
    const { data: keyData, error: keyError } = await supabase
      .from('steam_api_keys')
      .select('api_key, publisher_key, app_ids, highwatermark')
      .eq('client_id', client_id)
      .eq('is_active', true)
      .single();

    if (keyError || !keyData) {
      return NextResponse.json(
        { error: 'No active Steam API key found for this client' },
        { status: 404 }
      );
    }

    // Financial API requires the publisher key (Financial Web API Key)
    const financialApiKey = keyData.publisher_key || keyData.api_key;
    
    if (!financialApiKey) {
      return NextResponse.json(
        { error: 'No Financial Web API Key configured. Create one in Steamworks under Manage Groups > Financial API Group.' },
        { status: 400 }
      );
    }

    // Get client name for logging
    const { data: clientData } = await supabase
      .from('clients')
      .select('name')
      .eq('id', client_id)
      .single();

    // Use highwatermark 0 to get ALL dates (for debugging/full sync)
    // In production, you'd use the stored highwatermark for incremental sync
    const useHighwatermark = force_full_sync ? '0' : (keyData.highwatermark || '0');
    
    console.log(`[Steam Sync] Starting sync for ${clientData?.name}`);
    console.log(`[Steam Sync] Using highwatermark: ${useHighwatermark}`);
    console.log(`[Steam Sync] API Key (masked): ${financialApiKey.substring(0, 8)}...`);

    // Step 1: Get changed dates from Steam
    const changedDates = await getChangedDatesForPartner(financialApiKey, useHighwatermark);

    console.log(`[Steam Sync] GetChangedDatesForPartner result:`, {
      success: changedDates.success,
      datesCount: changedDates.dates?.length || 0,
      error: changedDates.error,
      rawResponse: changedDates.rawResponse
    });

    if (!changedDates.success) {
      return NextResponse.json({
        success: false,
        message: changedDates.error || 'Failed to get changed dates from Steam',
        debug: {
          apiCalled: true,
          endpoint: 'GetChangedDatesForPartner',
          highwatermarkUsed: useHighwatermark,
          rawResponse: changedDates.rawResponse
        },
        rowsImported: 0,
        rowsSkipped: 0,
        clientName: clientData?.name
      });
    }

    // Filter dates to requested range if provided
    let datesToSync = changedDates.dates || [];
    const totalDatesFromApi = datesToSync.length;
    
    if (start_date || end_date) {
      datesToSync = datesToSync.filter(date => {
        const d = date.replace(/\//g, '-');
        if (start_date && d < start_date) return false;
        if (end_date && d > end_date) return false;
        return true;
      });
    }

    // IMPORTANT: Limit to 30 dates per request to avoid Vercel timeout (10 second limit on free plan)
    // Process older dates first, so we can resume from where we left off
    const MAX_DATES_PER_REQUEST = 30;
    let hasMoreDates = false;
    if (datesToSync.length > MAX_DATES_PER_REQUEST) {
      console.log(`[Steam Sync] Found ${datesToSync.length} dates to sync. Processing first ${MAX_DATES_PER_REQUEST} to avoid timeout.`);
      hasMoreDates = true;
      datesToSync = datesToSync.slice(0, MAX_DATES_PER_REQUEST);
    }

    console.log(`[Steam Sync] Dates from API: ${totalDatesFromApi}, After filter: ${datesToSync.length}`);

    if (datesToSync.length === 0) {
      return NextResponse.json({
        success: true,
        message: totalDatesFromApi === 0 
          ? 'Steam API returned no dates with financial data. This could mean: (1) No sales data exists for this partner account, (2) The API key doesn\'t have access to financial data, or (3) All data was already synced.'
          : `Steam returned ${totalDatesFromApi} date(s), but none matched your date filter (${start_date} to ${end_date}).`,
        debug: {
          apiCalled: true,
          endpoint: 'GetChangedDatesForPartner',
          highwatermarkUsed: useHighwatermark,
          totalDatesFromApi,
          datesAfterFilter: datesToSync.length,
          sampleDates: changedDates.dates?.slice(0, 5),
          newHighwatermark: changedDates.highwatermark
        },
        rowsImported: 0,
        rowsSkipped: 0,
        datesProcessed: 0,
        clientName: clientData?.name
      });
    }

    // Step 2: Get detailed sales for each date
    let totalImported = 0;
    let totalSkipped = 0;
    const errors: string[] = [];

    for (const date of datesToSync) {
      const salesResult = await getDetailedSalesForDate(financialApiKey, date, app_id);
      
      if (salesResult.success && salesResult.results) {
        // Store the sales data in our database
        const storeResult = await storeSalesData(client_id, salesResult.results, salesResult.metadata);
        totalImported += storeResult.imported;
        totalSkipped += storeResult.skipped;
        // Also extract and store any bundle line items into steam_bundles
        await storeBundleData(client_id, salesResult.results, salesResult.metadata);
      } else if (salesResult.error) {
        errors.push(`${date}: ${salesResult.error}`);
      }
    }

    // Run product matching on synced data
    let newUnmatched = 0;
    try {
      // Collect unique product names from performance_metrics that don't have a product_id yet
      const { data: unmatchedRows } = await supabase
        .from('performance_metrics')
        .select('product_name, steam_package_id, steam_app_id')
        .eq('client_id', client_id)
        .is('product_id', null)
        .not('product_name', 'eq', 'Unknown');

      if (unmatchedRows && unmatchedRows.length > 0) {
        // Deduplicate by product_name
        const seen = new Set<string>();
        const externalProducts: ExternalProduct[] = [];
        for (const row of unmatchedRows) {
          if (!seen.has(row.product_name)) {
            seen.add(row.product_name);
            externalProducts.push({
              platform: 'steam',
              external_product_name: row.product_name,
              steam_package_id: row.steam_package_id || undefined,
              steam_app_id: row.steam_app_id || undefined,
              client_id,
            });
          }
        }

        const matchResults = await matchProducts(supabase, externalProducts);
        newUnmatched = matchResults.filter(r => r.match_type === 'no_match' && r.is_new).length;

        // For auto-confirmed matches, backfill the rows we just inserted
        for (const result of matchResults) {
          if (result.matched_product_id && result.match_type !== 'no_match') {
            await supabase
              .from('performance_metrics')
              .update({ product_id: result.matched_product_id, game_id: result.matched_game_id })
              .eq('client_id', client_id)
              .eq('product_name', result.external_product.external_product_name)
              .is('product_id', null);
          }
        }
      }
    } catch (matchError) {
      console.error('[Steam Sync] Product matching error (non-fatal):', matchError);
    }

    // Update highwatermark for next sync
    if (changedDates.highwatermark) {
      await supabase
        .from('steam_api_keys')
        .update({ 
          highwatermark: changedDates.highwatermark,
          last_sync_date: new Date().toISOString().split('T')[0]
        })
        .eq('client_id', client_id);
    }

    // Log import history
    await supabase
      .from('performance_import_history')
      .insert({
        client_id,
        import_type: 'steam_api_sync',
        date_range_start: start_date || datesToSync[0]?.replace(/\//g, '-'),
        date_range_end: end_date || datesToSync[datesToSync.length - 1]?.replace(/\//g, '-'),
        rows_imported: totalImported,
        rows_skipped: totalSkipped,
        status: errors.length === 0 ? 'completed' : 'partial',
        error_message: errors.length > 0 ? errors.join('; ') : null
      });

    return NextResponse.json({
      success: true,
      message: hasMoreDates
        ? `Synced ${datesToSync.length} date(s) from Steam Financial API. ${totalDatesFromApi - datesToSync.length} more dates available - click "Start Sync" again to continue.`
        : `Synced ${datesToSync.length} date(s) from Steam Financial API.`,
      rowsImported: totalImported,
      rowsSkipped: totalSkipped,
      datesProcessed: datesToSync.length,
      hasMoreDates,
      remainingDates: hasMoreDates ? totalDatesFromApi - datesToSync.length : 0,
      newUnmatched,
      errors: errors.length > 0 ? errors : undefined,
      clientName: clientData?.name,
      debug: {
        apiCalled: true,
        totalDatesFromApi,
        datesProcessed: datesToSync.length
      }
    });

  } catch (error) {
    console.error('Error syncing Steam data:', error);
    return NextResponse.json(
      { error: `Failed to sync Steam data: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}

// GET - Test API key validity with actual Financial API
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const clientId = searchParams.get('client_id');

    if (!clientId) {
      return NextResponse.json(
        { error: 'Client ID is required' },
        { status: 400 }
      );
    }

    const { data: keyData, error } = await supabase
      .from('steam_api_keys')
      .select('api_key, publisher_key, last_sync_date, highwatermark')
      .eq('client_id', clientId)
      .eq('is_active', true)
      .single();

    if (error || !keyData) {
      return NextResponse.json({
        valid: false,
        message: 'No API key configured for this client'
      });
    }

    // Test the Financial API key
    const financialApiKey = keyData.publisher_key || keyData.api_key;
    const testResult = await testFinancialApiKey(financialApiKey);

    return NextResponse.json({
      valid: testResult.valid,
      message: testResult.message,
      lastSync: keyData.last_sync_date,
      hasFinancialKey: !!keyData.publisher_key,
      debug: testResult.debug
    });

  } catch (error) {
    console.error('Error testing Steam API key:', error);
    return NextResponse.json(
      { error: 'Failed to test API key' },
      { status: 500 }
    );
  }
}

// Get changed dates from IPartnerFinancialsService
async function getChangedDatesForPartner(
  apiKey: string,
  highwatermark: string
): Promise<{ success: boolean; dates?: string[]; highwatermark?: string; error?: string; rawResponse?: unknown }> {
  try {
    const url = `${STEAM_PARTNER_API}/IPartnerFinancialsService/GetChangedDatesForPartner/v001/?key=${apiKey}&highwatermark=${highwatermark}`;

    console.log(`[Steam API] Calling: ${url.replace(apiKey, 'REDACTED')}`);

    const response = await fetch(url);
    const responseText = await response.text();
    const contentType = response.headers.get('content-type');

    console.log(`[Steam API] Response status: ${response.status}`);
    console.log(`[Steam API] Content-Type: ${contentType}`);
    console.log(`[Steam API] Response body: ${responseText.substring(0, 500)}`);

    if (!response.ok) {
      if (response.status === 403) {
        return {
          success: false,
          error: 'Access denied (403). Make sure you are using a Financial Web API Key from a Financial API Group in Steamworks.',
          rawResponse: responseText
        };
      }
      return {
        success: false,
        error: `Steam API returned status ${response.status}: ${responseText.substring(0, 200)}`,
        rawResponse: responseText
      };
    }

    // Check if response is actually JSON
    if (!contentType?.includes('application/json') && !responseText.trim().startsWith('{')) {
      console.error('[Steam API] Response is not JSON:', responseText.substring(0, 200));
      return {
        success: false,
        error: `Steam API returned non-JSON response: ${responseText.substring(0, 200)}`,
        rawResponse: responseText
      };
    }

    let data: ChangedDatesResponse;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      console.error('[Steam API] JSON Parse Error:', e);
      return {
        success: false,
        error: `Steam API returned invalid JSON. Response: ${responseText.substring(0, 200)}`,
        rawResponse: responseText
      };
    }

    return {
      success: true,
      dates: data.response?.dates || [],
      highwatermark: data.response?.result_highwatermark,
      rawResponse: data
    };
  } catch (error) {
    console.error('[Steam API] Fetch Error:', error);
    return {
      success: false,
      error: `Failed to connect to Steam API: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

// Get detailed sales for a specific date
async function getDetailedSalesForDate(
  apiKey: string, 
  date: string,
  appIdFilter?: string
): Promise<{ 
  success: boolean; 
  results?: SteamDetailedSalesResult[]; 
  metadata?: {
    packages: Map<number, string>;
    apps: Map<number, string>;
    countries: Map<string, { name: string; region: string }>;
  };
  error?: string 
}> {
  try {
    const allResults: SteamDetailedSalesResult[] = [];
    const packages = new Map<number, string>();
    const apps = new Map<number, string>();
    const countries = new Map<string, { name: string; region: string }>();
    
    let highwatermarkId = '0';
    let hasMoreData = true;

    // Paginate through all results for this date
    while (hasMoreData) {
      const url = `${STEAM_PARTNER_API}/IPartnerFinancialsService/GetDetailedSales/v001/?key=${apiKey}&date=${date}&highwatermark_id=${highwatermarkId}`;
      
      const response = await fetch(url);
      
      if (!response.ok) {
        return { 
          success: false, 
          error: `Steam API returned status ${response.status}` 
        };
      }

      const data: SteamSalesResponse = await response.json();
      
      // Add results
      if (data.response.results) {
        // Filter by app ID if specified
        const filtered = appIdFilter 
          ? data.response.results.filter(r => 
              r.primary_appid?.toString() === appIdFilter || 
              r.appid?.toString() === appIdFilter
            )
          : data.response.results;
        allResults.push(...filtered);
      }

      // Collect metadata
      data.response.package_info?.forEach(p => packages.set(p.packageid, p.package_name));
      data.response.app_info?.forEach(a => apps.set(a.appid, a.app_name));
      data.response.country_info?.forEach(c => countries.set(c.country_code, { 
        name: c.country_name, 
        region: c.region 
      }));

      // Check if there's more data
      const maxId = data.response.max_id;
      if (!maxId || maxId === highwatermarkId) {
        hasMoreData = false;
      } else {
        highwatermarkId = maxId;
      }
    }

    return {
      success: true,
      results: allResults,
      metadata: { packages, apps, countries }
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to get sales data: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

// Store sales data in our database
async function storeSalesData(
  clientId: string,
  results: SteamDetailedSalesResult[],
  metadata?: {
    packages: Map<number, string>;
    apps: Map<number, string>;
    countries: Map<string, { name: string; region: string }>;
  }
): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;

  for (const result of results) {
    try {
      // Convert date format from YYYY/MM/DD to YYYY-MM-DD
      const date = result.date.replace(/\//g, '-');
      
      // Get product name from metadata
      const productName = result.packageid 
        ? metadata?.packages.get(result.packageid) 
        : result.appid 
          ? metadata?.apps.get(result.appid)
          : 'Unknown';

      // Get country info
      const countryInfo = metadata?.countries.get(result.country_code);

      // Upsert into performance_metrics table
      const { error } = await supabase
        .from('performance_metrics')
        .upsert({
          client_id: clientId,
          date: date,
          product_name: productName || 'Unknown',
          platform: result.platform || 'Steam',
          country_code: result.country_code,
          region: countryInfo?.region || 'Unknown',
          gross_units_sold: result.gross_units_sold || 0,
          // Steam reports demo installs + retail-key redemptions here; sales rows leave it at 0.
          // Without this, demo activations are silently discarded.
          gross_units_activated: ((result as unknown as { gross_units_activated?: number | string }).gross_units_activated as number) || 0,
          net_units_sold: result.net_units_sold || 0,
          gross_revenue_usd: parseFloat(result.gross_sales_usd || '0'),
          net_revenue_usd: parseFloat(result.net_sales_usd || '0'),
          base_price: result.base_price ? parseFloat(result.base_price) / 100 : null,
          sale_price: result.sale_price ? parseFloat(result.sale_price) / 100 : null,
          currency: result.currency,
          discount_percentage: result.total_discount_percentage,
          steam_package_id: result.packageid?.toString(),
          steam_app_id: result.primary_appid?.toString() || result.appid?.toString(),
          line_item_type: result.line_item_type,
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'client_id,date,product_name,platform,country_code'
        });

      if (error) {
        console.error('Error storing sales data:', error);
        skipped++;
      } else {
        imported++;
      }
    } catch (error) {
      console.error('Error processing sales result:', error);
      skipped++;
    }
  }

  return { imported, skipped };
}

// Extract bundle line items from Steam financial data and upsert into steam_bundles.
// Steam returns one row per country per bundle per day — we aggregate to a daily total.
async function storeBundleData(
  clientId: string,
  results: SteamDetailedSalesResult[],
  metadata?: { packages: Map<number, string>; apps: Map<number, string> }
): Promise<void> {
  // Only process rows that have a bundleid
  const bundleRows = results.filter(r => r.bundleid)
  if (bundleRows.length === 0) return

  // Build a lookup: Steam app_id string → game UUID
  const appIds = Array.from(new Set(
    bundleRows.map(r => r.primary_appid?.toString() || r.appid?.toString()).filter(Boolean)
  )) as string[]

  const gameIdByAppId = new Map<string, string>()
  if (appIds.length > 0) {
    const { data: games } = await supabase
      .from('games')
      .select('id, steam_app_id')
      .in('steam_app_id', appIds)
      .eq('client_id', clientId)
    if (games) {
      for (const g of games) {
        if (g.steam_app_id) gameIdByAppId.set(g.steam_app_id, g.id)
      }
    }
  }

  // Aggregate by bundleid + date + primary_appid
  const agg = new Map<string, {
    bundleId: number; bundleName: string; date: string
    gameId: string | null; grossUnits: number; netUnits: number
    grossRevenue: number; netRevenue: number
  }>()

  for (const r of bundleRows) {
    const date = r.date.replace(/\//g, '-')
    const appIdStr = r.primary_appid?.toString() || r.appid?.toString() || ''
    const key = `${r.bundleid}|${date}|${appIdStr}`
    const bundleName = r.bundleid && metadata?.packages.get(r.bundleid)
      ? metadata.packages.get(r.bundleid)!
      : `Bundle #${r.bundleid}`

    if (!agg.has(key)) {
      agg.set(key, {
        bundleId: r.bundleid!,
        bundleName,
        date,
        gameId: gameIdByAppId.get(appIdStr) || null,
        grossUnits: 0, netUnits: 0, grossRevenue: 0, netRevenue: 0,
      })
    }
    const row = agg.get(key)!
    row.grossUnits += r.gross_units_sold || 0
    row.netUnits += r.net_units_sold || 0
    row.grossRevenue += parseFloat(r.gross_sales_usd || '0')
    row.netRevenue += parseFloat(r.net_sales_usd || '0')
  }

  const upsertRows = Array.from(agg.values()).map(r => ({
    client_id: clientId,
    game_id: r.gameId,
    bundle_name: r.bundleName,
    bundle_id: r.bundleId.toString(),
    date: r.date,
    gross_units: r.grossUnits,
    net_units: r.netUnits,
    gross_revenue_usd: r.grossRevenue,
    net_revenue_usd: r.netRevenue,
    source: 'steam_api',
  }))

  if (upsertRows.length > 0) {
    await supabase.from('steam_bundles').upsert(upsertRows, { onConflict: 'game_id,bundle_name,date' })
  }
}

// Test if the Financial API key is valid
async function testFinancialApiKey(apiKey: string): Promise<{ valid: boolean; message: string; debug?: unknown }> {
  try {
    // Try to get changed dates with highwatermark 0 - this will confirm API access
    const url = `${STEAM_PARTNER_API}/IPartnerFinancialsService/GetChangedDatesForPartner/v001/?key=${apiKey}&highwatermark=0`;
    
    console.log(`[Steam API Test] Calling: ${url.replace(apiKey, 'REDACTED')}`);
    
    const response = await fetch(url);
    const responseText = await response.text();
    
    console.log(`[Steam API Test] Status: ${response.status}, Body: ${responseText.substring(0, 200)}`);
    
    if (response.ok) {
      let data: ChangedDatesResponse;
      try {
        data = JSON.parse(responseText);
      } catch (e) {
        return {
          valid: false,
          message: `Steam API returned invalid JSON: ${responseText.substring(0, 100)}`,
          debug: { status: response.status, body: responseText }
        };
      }
      
      const dateCount = data.response?.dates?.length || 0;
      return {
        valid: true,
        message: `Financial API connected! ${dateCount} date(s) with sales data available.`,
        debug: {
          status: response.status,
          dateCount,
          sampleDates: data.response?.dates?.slice(0, 3),
          highwatermark: data.response?.result_highwatermark
        }
      };
    } else if (response.status === 403) {
      return {
        valid: false,
        message: 'Access denied (403). This key may not have Financial API access. Create a Financial API Group in Steamworks and use that key.',
        debug: { status: response.status, body: responseText }
      };
    } else {
      return {
        valid: false,
        message: `Steam API returned status ${response.status}`,
        debug: { status: response.status, body: responseText }
      };
    }
  } catch (error) {
    return {
      valid: false,
      message: `Could not connect to Steam Partner API: ${error instanceof Error ? error.message : String(error)}`,
      debug: { error: String(error) }
    };
  }
}
