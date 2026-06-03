/**
 * Centralized scanner error visibility.
 *
 * The system was swallowing errors silently in many places (try/catch → null,
 * if (!res.ok) continue, etc.). When a 3rd-party API breaks (TikTok HTML
 * structure changes, YouTube RSS region blocks, etc.) we'd miss coverage
 * for days without knowing.
 *
 * This wrapper writes every scanner failure to a single audit log so we can
 * spot rate-of-failure drift before it costs us coverage.
 *
 * Best-effort: a failure to log a failure must never throw — that would
 * cause a cascading outage. All `recordScannerError` calls swallow their
 * own exceptions.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface ScannerErrorEvent {
  scanner: string          // e.g. 'youtube-rss-poll', 'tiktok-profile-poll'
  target?: string          // resource that failed (channel_id, handle, URL)
  game_id?: string | null
  category: 'fetch_error' | 'parse_error' | 'rate_limit' | 'auth_error' | 'unknown'
  http_status?: number | null
  message: string          // first 200 chars
  context?: Record<string, unknown>
}

let _checkedTable = false

async function ensureTable(supabase: SupabaseClient): Promise<void> {
  if (_checkedTable) return
  _checkedTable = true
  // Defensive — if scanner_errors doesn't exist, log and noop. We don't
  // try to create the table here (migrations are explicit). Operator
  // should run the migration in supabase/migrations.
  const { error } = await supabase.from('scanner_errors').select('id').limit(1)
  if (error) {
    console.warn('[scanner-errors] scanner_errors table not present — events will be skipped:', error.message)
  }
}

export async function recordScannerError(
  supabase: SupabaseClient,
  event: ScannerErrorEvent,
): Promise<void> {
  try {
    await ensureTable(supabase)
    await supabase.from('scanner_errors').insert({
      scanner: event.scanner,
      target: event.target ?? null,
      game_id: event.game_id ?? null,
      category: event.category,
      http_status: event.http_status ?? null,
      message: event.message.substring(0, 200),
      context: event.context ?? {},
      created_at: new Date().toISOString(),
    })
  } catch { /* never throw from the error logger */ }
}
