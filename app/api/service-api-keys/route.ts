import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getSupabase() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing Supabase environment variables')
  }

  return createClient(supabaseUrl, supabaseKey)
}

// Mask a key for display (show first 4 and last 4 chars)
function maskKey(key: string | null): string | null {
  if (!key) return null
  if (key.length <= 8) return '••••••••'
  return `${key.slice(0, 4)}${'•'.repeat(Math.min(key.length - 8, 20))}${key.slice(-4)}`
}

// GET - Fetch all service API keys (with masked values)
export async function GET() {
  try {
    const supabase = getSupabase()

    const { data, error } = await supabase
      .from('service_api_keys')
      .select('*')
      .order('display_name', { ascending: true })

    if (error) {
      console.error('Error fetching service API keys:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Mask all key values before returning
    const masked = (data || []).map(row => ({
      ...row,
      api_key: maskKey(row.api_key),
      client_id_value: maskKey(row.client_id_value),
      client_secret: maskKey(row.client_secret),
      refresh_token: maskKey(row.refresh_token),
      // Flag whether keys are actually set
      has_api_key: !!row.api_key,
      has_client_id: !!row.client_id_value,
      has_client_secret: !!row.client_secret,
      has_refresh_token: !!row.refresh_token
    }))

    return NextResponse.json(masked)
  } catch (err) {
    console.error('Service API keys GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// PUT - Update API key(s) for a service
export async function PUT(request: NextRequest) {
  try {
    const supabase = getSupabase()
    const body = await request.json()
    const { service_name, api_key, client_id_value, client_secret, refresh_token, model_id, chatbot_model_id } = body

    if (!service_name) {
      return NextResponse.json({ error: 'service_name is required' }, { status: 400 })
    }

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString()
    }

    // Only update fields that are explicitly provided (not undefined)
    if (api_key !== undefined) updates.api_key = api_key || null
    if (client_id_value !== undefined) updates.client_id_value = client_id_value || null
    if (client_secret !== undefined) updates.client_secret = client_secret || null
    if (refresh_token !== undefined) updates.refresh_token = refresh_token || null
    if (model_id !== undefined) updates.model_id = model_id || null
    if (chatbot_model_id !== undefined) updates.chatbot_model_id = chatbot_model_id || null

    // Check if at least one key is now configured
    const hasAnyKey = !!(api_key || client_id_value || client_secret)
    updates.is_configured = hasAnyKey

    const { data, error } = await supabase
      .from('service_api_keys')
      .update(updates)
      .eq('service_name', service_name)
      .select()
      .single()

    if (error) {
      console.error('Error updating service API key:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Return masked version
    return NextResponse.json({
      ...data,
      api_key: maskKey(data.api_key),
      client_id_value: maskKey(data.client_id_value),
      client_secret: maskKey(data.client_secret),
      refresh_token: maskKey(data.refresh_token),
      has_api_key: !!data.api_key,
      has_client_id: !!data.client_id_value,
      has_client_secret: !!data.client_secret,
      has_refresh_token: !!data.refresh_token
    })
  } catch (err) {
    console.error('Service API keys PUT error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// POST - Test connection for a service
export async function POST(request: NextRequest) {
  try {
    const supabase = getSupabase()
    const body = await request.json()
    const { service_name } = body

    if (!service_name) {
      return NextResponse.json({ error: 'service_name is required' }, { status: 400 })
    }

    // Fetch the actual key from DB
    const { data: keyData, error: keyError } = await supabase
      .from('service_api_keys')
      .select('*')
      .eq('service_name', service_name)
      .single()

    if (keyError || !keyData) {
      return NextResponse.json({ error: 'Service not found' }, { status: 404 })
    }

    let status: 'success' | 'failed' | 'error' = 'error'
    let message = ''

    try {
      switch (service_name) {
        case 'tavily': {
          if (!keyData.api_key) {
            status = 'failed'
            message = 'No API key configured'
            break
          }
          const res = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api_key: keyData.api_key,
              query: 'test connection',
              max_results: 1
            })
          })
          if (res.ok) {
            status = 'success'
            message = 'Connected successfully'
          } else {
            const errData = await res.json().catch(() => ({}))
            status = 'failed'
            message = (errData as Record<string, string>).detail || `HTTP ${res.status}`
          }
          break
        }

        case 'apify': {
          if (!keyData.api_key) {
            status = 'failed'
            message = 'No API token configured'
            break
          }
          const res = await fetch('https://api.apify.com/v2/users/me', {
            headers: { Authorization: `Bearer ${keyData.api_key}` }
          })
          if (res.ok) {
            const userData = await res.json() as Record<string, unknown>
            const data = userData.data as Record<string, unknown> | undefined
            const plan = data?.plan as Record<string, unknown> | undefined
            status = 'success'
            message = `Connected as ${data?.username || 'unknown'}`
            // Update credits info
            if (plan) {
              await supabase
                .from('service_api_keys')
                .update({
                  credits_remaining: plan.usageCreditsRemainingUsd as number || null,
                  quota_limit: plan.monthlyUsageCreditsUsd as number || null
                })
                .eq('service_name', 'apify')
            }
          } else {
            status = 'failed'
            message = `HTTP ${res.status} - Invalid token`
          }
          break
        }

        case 'youtube': {
          if (!keyData.api_key) {
            status = 'failed'
            message = 'No API key configured'
            break
          }
          const res = await fetch(
            `https://www.googleapis.com/youtube/v3/search?part=snippet&q=test&maxResults=1&key=${keyData.api_key}`
          )
          if (res.ok) {
            status = 'success'
            message = 'Connected successfully'
          } else {
            const errData = await res.json().catch(() => ({})) as Record<string, Record<string, string>>
            status = 'failed'
            message = errData?.error?.message || `HTTP ${res.status}`
          }
          break
        }

        case 'twitch': {
          if (!keyData.client_id_value || !keyData.client_secret) {
            status = 'failed'
            message = 'Client ID and Client Secret required'
            break
          }
          const tokenRes = await fetch(
            `https://id.twitch.tv/oauth2/token?client_id=${keyData.client_id_value}&client_secret=${keyData.client_secret}&grant_type=client_credentials`,
            { method: 'POST' }
          )
          if (tokenRes.ok) {
            status = 'success'
            message = 'Connected successfully - OAuth token acquired'
          } else {
            status = 'failed'
            message = `HTTP ${tokenRes.status} - Invalid credentials`
          }
          break
        }

        case 'reddit': {
          if (!keyData.client_id_value || !keyData.client_secret) {
            status = 'failed'
            message = 'Client ID and Client Secret required'
            break
          }
          const auth = Buffer.from(`${keyData.client_id_value}:${keyData.client_secret}`).toString('base64')
          const tokenRes = await fetch('https://www.reddit.com/api/v1/access_token', {
            method: 'POST',
            headers: {
              Authorization: `Basic ${auth}`,
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': 'GameDrive/1.0'
            },
            body: keyData.refresh_token
              ? `grant_type=refresh_token&refresh_token=${keyData.refresh_token}`
              : 'grant_type=client_credentials'
          })
          if (tokenRes.ok) {
            status = 'success'
            message = 'Connected successfully'
          } else {
            status = 'failed'
            message = `HTTP ${tokenRes.status} - Invalid credentials`
          }
          break
        }

        case 'gemini': {
          if (!keyData.api_key) {
            status = 'failed'
            message = 'No API key configured'
            break
          }
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${keyData.api_key}`
          )
          if (res.ok) {
            status = 'success'
            message = 'Connected successfully'
          } else {
            const errData = await res.json().catch(() => ({})) as Record<string, Record<string, string>>
            status = 'failed'
            message = errData?.error?.message || `HTTP ${res.status}`
          }
          break
        }

        default:
          status = 'error'
          message = `Unknown service: ${service_name}`
      }
    } catch (testErr) {
      status = 'error'
      message = testErr instanceof Error ? testErr.message : 'Connection test failed'
    }

    // Update test status in DB
    await supabase
      .from('service_api_keys')
      .update({
        last_tested_at: new Date().toISOString(),
        last_test_status: status,
        last_test_message: message,
        updated_at: new Date().toISOString()
      })
      .eq('service_name', service_name)

    return NextResponse.json({ status, message })
  } catch (err) {
    console.error('Service API keys test error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
