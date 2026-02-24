'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '@/lib/auth-context'
import { GEMINI_MODELS, type GeminiModelId } from '@/lib/gemini-config'

interface ServiceKey {
  id: string
  service_name: string
  display_name: string
  api_key: string | null
  client_id_value: string | null
  client_secret: string | null
  refresh_token: string | null
  model_id: string | null
  chatbot_model_id: string | null
  is_configured: boolean
  is_active: boolean
  last_tested_at: string | null
  last_test_status: 'success' | 'failed' | 'error' | 'untested' | null
  last_test_message: string | null
  quota_used: number | null
  quota_limit: number | null
  credits_remaining: number | null
  has_api_key: boolean
  has_client_id: boolean
  has_client_secret: boolean
  has_refresh_token: boolean
}

// Which fields each service needs
const SERVICE_FIELDS: Record<string, { fields: string[]; labels: Record<string, string>; description: string; docsUrl: string }> = {
  tavily: {
    fields: ['api_key'],
    labels: { api_key: 'API Key' },
    description: 'Web search beyond RSS feeds. Paid service.',
    docsUrl: 'https://tavily.com'
  },
  apify: {
    fields: ['api_key'],
    labels: { api_key: 'API Token' },
    description: 'Scraper platform for YouTube, Twitch, Reddit, Twitter, TikTok, Instagram. Paid service.',
    docsUrl: 'https://apify.com'
  },
  gemini: {
    fields: ['api_key'],
    labels: { api_key: 'API Key' },
    description: 'Google Gemini AI for relevance scoring, type classification & sentiment. Free tier available.',
    docsUrl: 'https://aistudio.google.com/apikey'
  },
  resend: {
    fields: ['api_key'],
    labels: { api_key: 'API Key' },
    description: 'Email delivery for coverage digests. Free tier: 100 emails/day.',
    docsUrl: 'https://resend.com'
  }
}

const SERVICE_ICONS: Record<string, string> = {
  tavily: '🔍',
  apify: '🤖',
  gemini: '✨',
  resend: '📧'
}

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  success: { bg: '#dcfce7', text: '#166534', label: 'Connected' },
  failed: { bg: '#fee2e2', text: '#dc2626', label: 'Failed' },
  error: { bg: '#fef3c7', text: '#92400e', label: 'Error' },
  untested: { bg: '#f3f4f6', text: '#6b7280', label: 'Not Tested' }
}

export default function SystemKeysPage() {
  const { hasAccess, loading: authLoading } = useAuth()
  const canView = hasAccess('api_settings', 'view')
  const canEdit = hasAccess('api_settings', 'edit')

  const [services, setServices] = useState<ServiceKey[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [editingService, setEditingService] = useState<string | null>(null)
  const [formValues, setFormValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [saveMessage, setSaveMessage] = useState<{ service: string; type: 'success' | 'error'; text: string } | null>(null)

  const fetchServices = async () => {
    setIsLoading(true)
    try {
      const res = await fetch('/api/service-api-keys')
      if (res.ok) {
        const data = await res.json()
        setServices(data)
      }
    } catch (err) {
      console.error('Failed to fetch services:', err)
    }
    setIsLoading(false)
  }

  useEffect(() => {
    if (canView) fetchServices()
  }, [canView])

  const handleEdit = (service: ServiceKey) => {
    setEditingService(service.service_name)
    // Initialize form with empty values (user enters new keys)
    const fields = SERVICE_FIELDS[service.service_name]?.fields || []
    const values: Record<string, string> = {}
    fields.forEach(f => { values[f] = '' })
    setFormValues(values)
    setSaveMessage(null)
  }

  const handleSave = async (serviceName: string) => {
    setSaving(true)
    setSaveMessage(null)
    try {
      const payload: Record<string, string | undefined> = { service_name: serviceName }
      const fields = SERVICE_FIELDS[serviceName]?.fields || []
      fields.forEach(f => {
        if (formValues[f]) payload[f] = formValues[f]
      })

      const res = await fetch('/api/service-api-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (res.ok) {
        setSaveMessage({ service: serviceName, type: 'success', text: 'Keys saved successfully' })
        setEditingService(null)
        fetchServices()
      } else {
        const json = await res.json()
        setSaveMessage({ service: serviceName, type: 'error', text: json.error || 'Save failed' })
      }
    } catch {
      setSaveMessage({ service: serviceName, type: 'error', text: 'Network error' })
    }
    setSaving(false)
  }

  const handleTest = async (serviceName: string) => {
    setTesting(serviceName)
    setSaveMessage(null)
    try {
      const res = await fetch('/api/service-api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service_name: serviceName })
      })
      const json = await res.json()
      setSaveMessage({
        service: serviceName,
        type: json.status === 'success' ? 'success' : 'error',
        text: json.message || 'Test completed'
      })
      fetchServices()
    } catch {
      setSaveMessage({ service: serviceName, type: 'error', text: 'Test request failed' })
    }
    setTesting(null)
  }

  const handleModelChange = async (serviceName: string, field: 'model_id' | 'chatbot_model_id', value: string) => {
    setSaveMessage(null)
    try {
      const res = await fetch('/api/service-api-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service_name: serviceName, [field]: value || null })
      })
      if (res.ok) {
        setSaveMessage({ service: serviceName, type: 'success', text: 'Model updated' })
        fetchServices()
        // Auto-dismiss success message after 2s
        setTimeout(() => setSaveMessage(prev => prev?.service === serviceName && prev.type === 'success' ? null : prev), 2000)
      } else {
        const json = await res.json()
        setSaveMessage({ service: serviceName, type: 'error', text: json.error || 'Failed to update model' })
      }
    } catch {
      setSaveMessage({ service: serviceName, type: 'error', text: 'Network error' })
    }
  }

  const formatDate = (date: string | null) => {
    if (!date) return 'Never'
    return new Date(date).toLocaleString()
  }

  if (authLoading) {
    return (
      <div style={{ textAlign: 'center', padding: '60px', color: '#64748b' }}>Loading...</div>
    )
  }

  if (!canView) {
    return (
      <div style={{ textAlign: 'center', padding: '60px' }}>
        <h2 style={{ fontSize: '1.5rem', fontWeight: 600, color: '#1f2937' }}>Access Denied</h2>
        <p style={{ color: '#6b7280' }}>You don&apos;t have permission to view API settings.</p>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: '900px', margin: '0 auto' }}>
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '60px', color: '#64748b' }}>Loading services...</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {services.map(service => {
            const config = SERVICE_FIELDS[service.service_name]
            const icon = SERVICE_ICONS[service.service_name] || '🔑'
            const statusStyle = STATUS_STYLES[service.last_test_status || 'untested']
            const isEditing = editingService === service.service_name
            const isTesting = testing === service.service_name
            const msg = saveMessage?.service === service.service_name ? saveMessage : null

            return (
              <div
                key={service.id}
                style={{
                  backgroundColor: 'white',
                  borderRadius: '12px',
                  padding: '24px',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
                  borderLeft: `4px solid ${service.is_configured ? '#22c55e' : '#d1d5db'}`
                }}
              >
                {/* Service header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span style={{ fontSize: '28px' }}>{icon}</span>
                    <div>
                      <h3 style={{ fontSize: '18px', fontWeight: 600, color: '#1e293b', margin: 0 }}>
                        {service.display_name}
                      </h3>
                      <p style={{ fontSize: '13px', color: '#64748b', margin: '2px 0 0 0' }}>
                        {config?.description || ''}
                      </p>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {/* Status badge */}
                    <span style={{
                      padding: '4px 10px', borderRadius: '9999px', fontSize: '12px', fontWeight: 600,
                      backgroundColor: statusStyle.bg, color: statusStyle.text
                    }}>
                      {statusStyle.label}
                    </span>
                  </div>
                </div>

                {/* Key status & actions */}
                <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: '13px', color: '#64748b' }}>
                    {config?.fields.map(field => {
                      const hasKey = service[`has_${field.replace('_value', '')}` as keyof ServiceKey] as boolean
                      return (
                        <span key={field} style={{ marginRight: '16px' }}>
                          {config.labels[field]}:{' '}
                          <span style={{ color: hasKey ? '#16a34a' : '#dc2626', fontWeight: 500 }}>
                            {hasKey ? 'Set' : 'Not set'}
                          </span>
                        </span>
                      )
                    })}
                    {service.last_tested_at && (
                      <span style={{ display: 'block', marginTop: '4px', fontSize: '12px', color: '#94a3b8' }}>
                        Last tested: {formatDate(service.last_tested_at)}
                        {service.last_test_message && ` — ${service.last_test_message}`}
                      </span>
                    )}
                  </div>

                  {canEdit && (
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        onClick={() => handleTest(service.service_name)}
                        disabled={!service.is_configured || isTesting}
                        style={{
                          padding: '6px 14px', fontSize: '13px', borderRadius: '6px',
                          backgroundColor: 'white', color: '#475569', border: '1px solid #e2e8f0',
                          cursor: !service.is_configured || isTesting ? 'not-allowed' : 'pointer',
                          opacity: !service.is_configured || isTesting ? 0.5 : 1
                        }}
                      >
                        {isTesting ? 'Testing...' : 'Test Connection'}
                      </button>
                      <button
                        onClick={() => isEditing ? setEditingService(null) : handleEdit(service)}
                        style={{
                          padding: '6px 14px', fontSize: '13px', borderRadius: '6px',
                          backgroundColor: isEditing ? '#f1f5f9' : 'white',
                          color: '#475569', border: '1px solid #e2e8f0', cursor: 'pointer'
                        }}
                      >
                        {isEditing ? 'Cancel' : service.is_configured ? 'Update Keys' : 'Configure'}
                      </button>
                    </div>
                  )}
                </div>

                {/* Quota/credits info for paid services */}
                {service.service_name === 'apify' && service.credits_remaining !== null && (
                  <div style={{
                    marginTop: '12px', padding: '8px 12px', borderRadius: '6px',
                    backgroundColor: service.credits_remaining < 1 ? '#fef3c7' : '#f0fdf4',
                    fontSize: '13px', color: service.credits_remaining < 1 ? '#92400e' : '#166534'
                  }}>
                    Credits remaining: ${service.credits_remaining?.toFixed(2)}
                    {service.quota_limit && ` / $${service.quota_limit}`}
                    {service.credits_remaining < 1 && ' — Low balance!'}
                  </div>
                )}

                {/* Message */}
                {msg && (
                  <div style={{
                    marginTop: '12px', padding: '8px 12px', borderRadius: '6px',
                    backgroundColor: msg.type === 'success' ? '#dcfce7' : '#fee2e2',
                    color: msg.type === 'success' ? '#166534' : '#dc2626',
                    fontSize: '13px'
                  }}>
                    {msg.text}
                  </div>
                )}

                {/* Edit form */}
                {isEditing && config && (
                  <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid #f1f5f9' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: config.fields.length > 2 ? 'repeat(3, 1fr)' : config.fields.length === 2 ? 'repeat(2, 1fr)' : '1fr', gap: '12px' }}>
                      {config.fields.map(field => (
                        <div key={field}>
                          <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>
                            {config.labels[field]}
                          </label>
                          <input
                            type="password"
                            value={formValues[field] || ''}
                            onChange={e => setFormValues(v => ({ ...v, [field]: e.target.value }))}
                            placeholder={`Enter ${config.labels[field].toLowerCase()}`}
                            style={{
                              width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0',
                              borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box'
                            }}
                          />
                        </div>
                      ))}
                    </div>
                    <div style={{ marginTop: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <a
                        href={config.docsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ fontSize: '12px', color: '#2563eb', textDecoration: 'none' }}
                      >
                        Get API key →
                      </a>
                      <button
                        onClick={() => handleSave(service.service_name)}
                        disabled={saving}
                        style={{
                          padding: '8px 20px', backgroundColor: '#2563eb', color: 'white',
                          border: 'none', borderRadius: '6px', fontSize: '14px', fontWeight: 500,
                          cursor: saving ? 'not-allowed' : 'pointer',
                          opacity: saving ? 0.7 : 1
                        }}
                      >
                        {saving ? 'Saving...' : 'Save Keys'}
                      </button>
                    </div>
                  </div>
                )}

                {/* Gemini Model Settings */}
                {service.service_name === 'gemini' && service.is_configured && !isEditing && canEdit && (
                  <div style={{
                    marginTop: '16px', paddingTop: '16px', borderTop: '1px solid #f1f5f9'
                  }}>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: '#475569', marginBottom: '10px' }}>
                      Model Settings
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                      <div>
                        <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: '#64748b', marginBottom: '4px' }}>
                          Predictions & Enrichment Model
                        </label>
                        <select
                          value={service.model_id || 'gemini-2.5-flash-lite'}
                          onChange={e => handleModelChange('gemini', 'model_id', e.target.value as GeminiModelId)}
                          style={{
                            width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0',
                            borderRadius: '6px', fontSize: '14px', backgroundColor: 'white',
                            color: '#1e293b', cursor: 'pointer', boxSizing: 'border-box'
                          }}
                        >
                          {GEMINI_MODELS.map(m => (
                            <option key={m.id} value={m.id}>
                              {m.label} {m.tier === 'free' ? '(free tier)' : ''}
                            </option>
                          ))}
                        </select>
                        <p style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>
                          Used for revenue predictions, coverage scoring & enrichment
                        </p>
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: '#64748b', marginBottom: '4px' }}>
                          Chatbot Model
                        </label>
                        <select
                          value={service.chatbot_model_id || service.model_id || 'gemini-2.5-flash-lite'}
                          onChange={e => handleModelChange('gemini', 'chatbot_model_id', e.target.value as GeminiModelId)}
                          style={{
                            width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0',
                            borderRadius: '6px', fontSize: '14px', backgroundColor: 'white',
                            color: '#1e293b', cursor: 'pointer', boxSizing: 'border-box'
                          }}
                        >
                          {GEMINI_MODELS.map(m => (
                            <option key={m.id} value={m.id}>
                              {m.label} {m.tier === 'free' ? '(free tier)' : ''}
                            </option>
                          ))}
                        </select>
                        <p style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>
                          Used for the AI assistant chatbot
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
