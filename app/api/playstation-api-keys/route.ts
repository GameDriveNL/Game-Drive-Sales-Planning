import { NextResponse } from 'next/server';
import { requireFeature } from '@/lib/api-auth';
import { serverSupabase as supabase } from '@/lib/supabase';

// Domo-powered analytics API (PlayStation Partners uses Domo under the hood)
const PSN_AUTH_URL = 'https://api.domo.com/oauth/token';

// Show only the first and last 4 characters. The Settings page masks keys the
// same way, so nothing it displays changes, but full secrets no longer travel
// to the browser.
function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null
  if (value.length <= 8) return '••••••••'
  return `${value.slice(0, 4)}${'•'.repeat(Math.min(value.length - 8, 20))}${value.slice(-4)}`
}

// GET - Fetch all PlayStation API credentials with client info
export async function GET() {
  const denied = await requireFeature('api_settings', 'view');
  if (denied instanceof NextResponse) return denied;

  try {
    const { data, error } = await supabase
      .from('playstation_api_keys')
      .select(`
        *,
        clients (
          id,
          name
        )
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const masked = (data || []).map(row => ({
      ...row,
      ps_client_id: maskSecret(row.ps_client_id),
      client_secret: maskSecret(row.client_secret),
    }));
    return NextResponse.json(masked);
  } catch (error) {
    console.error('Error fetching PlayStation API keys:', error);
    return NextResponse.json(
      { error: 'Failed to fetch PlayStation API credentials' },
      { status: 500 }
    );
  }
}

// POST - Create or update PlayStation API credentials for a client
export async function POST(request: Request) {
  const denied = await requireFeature('api_settings', 'edit');
  if (denied instanceof NextResponse) return denied;

  try {
    const body = await request.json();
    const { client_id, ps_client_id, client_secret, scope } = body;

    if (!client_id || !ps_client_id || !client_secret) {
      return NextResponse.json(
        { error: 'Client ID, PlayStation Client ID, and Client Secret are required' },
        { status: 400 }
      );
    }

    // Validate credentials by attempting to get an access token
    const validationResult = await validatePlayStationCredentials(ps_client_id, client_secret, scope);

    if (!validationResult.valid) {
      return NextResponse.json(
        {
          error: `Invalid credentials: ${validationResult.message}`,
          debug: validationResult.debug
        },
        { status: 400 }
      );
    }

    // Upsert credentials - insert or update if client already has a row
    const { data: result, error } = await supabase
      .from('playstation_api_keys')
      .upsert({
        client_id,
        ps_client_id,
        client_secret,
        scope: scope || 'data',
        is_active: true,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'client_id'
      })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({
      ...result,
      validation: validationResult
    });
  } catch (error) {
    console.error('Error saving PlayStation API credentials:', error);
    return NextResponse.json(
      { error: 'Failed to save PlayStation API credentials' },
      { status: 500 }
    );
  }
}

// DELETE - Remove PlayStation API credentials
export async function DELETE(request: Request) {
  const denied = await requireFeature('api_settings', 'edit');
  if (denied instanceof NextResponse) return denied;

  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json(
        { error: 'Credentials ID is required' },
        { status: 400 }
      );
    }

    const { error } = await supabase
      .from('playstation_api_keys')
      .delete()
      .eq('id', id);

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting PlayStation API credentials:', error);
    return NextResponse.json(
      { error: 'Failed to delete PlayStation API credentials' },
      { status: 500 }
    );
  }
}

// Validate PlayStation credentials by attempting to get an access token
async function validatePlayStationCredentials(
  clientId: string,
  clientSecret: string,
  scope?: string
): Promise<{ valid: boolean; message: string; datasets?: string[]; debug?: unknown }> {
  try {
    // Create Basic auth header from client_id:client_secret
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    // Default to 'data' scope - use space-separated values for multiple scopes (e.g., "data dashboard")
    const effectiveScope = scope || 'data';

    // Domo API expects grant_type and scope as URL query parameters with a GET request
    const authUrl = `${PSN_AUTH_URL}?grant_type=client_credentials&scope=${encodeURIComponent(effectiveScope)}`;

    console.log('[PlayStation API] Attempting auth to:', authUrl);
    console.log('[PlayStation API] Using scope:', effectiveScope);
    console.log('[PlayStation API] Client ID length:', clientId.length);

    const response = await fetch(authUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${basicAuth}`
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[PlayStation API] Auth failed:', response.status, errorText);
      console.error('[PlayStation API] Response headers:', Object.fromEntries(response.headers.entries()));

      if (response.status === 401) {
        return {
          valid: false,
          message: 'Invalid Client ID or Client Secret. Check your credentials in PlayStation Partners.',
          debug: { status: 401, error: errorText, url: PSN_AUTH_URL, scope: effectiveScope }
        };
      }

      if (response.status === 403) {
        return {
          valid: false,
          message: `Access forbidden (403). This usually means: 1) Your credentials haven't been provisioned for API access yet, 2) The scope "${effectiveScope}" is not authorized, or 3) Your IP may need to be whitelisted. Contact PlayStation Partners support.`,
          debug: { status: 403, error: errorText, url: PSN_AUTH_URL, scope: effectiveScope }
        };
      }

      return {
        valid: false,
        message: `Authentication failed with status ${response.status}: ${errorText}`,
        debug: { status: response.status, error: errorText, url: PSN_AUTH_URL, scope: effectiveScope }
      };
    }

    const tokenData = await response.json();

    if (!tokenData.access_token) {
      return {
        valid: false,
        message: 'No access token received'
      };
    }

    // Try to list available datasets to confirm API access
    const datasetsResult = await listDatasets(tokenData.access_token);

    return {
      valid: true,
      message: `Successfully authenticated! ${datasetsResult.datasets?.length || 0} dataset(s) available.`,
      datasets: datasetsResult.datasets
    };
  } catch (error) {
    console.error('[PlayStation API] Validation error:', error);
    return {
      valid: false,
      message: `Connection failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

// List available datasets using the access token
async function listDatasets(accessToken: string): Promise<{ datasets?: string[]; error?: string }> {
  try {
    const response = await fetch('https://api.domo.com/v1/datasets', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      return { error: `Failed to list datasets: ${response.status}` };
    }

    const data = await response.json();

    // Extract dataset IDs from response
    const datasets: string[] = Array.isArray(data)
      ? data.map((d: { id?: string; name?: string }) => d.id || d.name).filter((x): x is string => Boolean(x))
      : [];

    return { datasets };
  } catch (error) {
    return { error: String(error) };
  }
}
