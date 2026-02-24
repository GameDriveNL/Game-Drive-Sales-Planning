import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================
// GEMINI MODEL CONFIGURATION
// Single source of truth for all Gemini usage
// ============================================

export const GEMINI_MODELS = [
  { id: 'gemini-2.5-flash-lite', label: 'Flash Lite (cheapest)', tier: 'free' },
  { id: 'gemini-2.5-flash', label: 'Flash (balanced)', tier: 'paid' },
  { id: 'gemini-2.5-pro', label: 'Pro (most capable)', tier: 'paid' },
] as const

export type GeminiModelId = typeof GEMINI_MODELS[number]['id']

export const DEFAULT_MODEL: GeminiModelId = 'gemini-2.5-flash-lite'

export interface GeminiConfig {
  apiKey: string
  modelId: GeminiModelId
  chatbotModelId: GeminiModelId
}

/**
 * Fetch Gemini API key + model settings from service_api_keys.
 * Returns null if gemini is not configured or inactive.
 */
export async function getGeminiConfig(supabase: SupabaseClient): Promise<GeminiConfig | null> {
  const { data } = await supabase
    .from('service_api_keys')
    .select('api_key, model_id, chatbot_model_id')
    .eq('service_name', 'gemini')
    .eq('is_active', true)
    .single()

  if (!data?.api_key) return null

  return {
    apiKey: data.api_key,
    modelId: (data.model_id as GeminiModelId) || DEFAULT_MODEL,
    chatbotModelId: (data.chatbot_model_id as GeminiModelId) || (data.model_id as GeminiModelId) || DEFAULT_MODEL,
  }
}
