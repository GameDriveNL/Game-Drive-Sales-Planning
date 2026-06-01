/**
 * GET /api/coverage-health/yt-raw
 *
 * Exposes the raw YouTube Data API response for the query "Dark Pals" with
 * no filters, so we can see whether the key is being blocked, rate-limited,
 * or genuinely returning zero results.
 *
 * Whitelisted in middleware. Will be removed after we fix the YT silent-zero
 * issue.
 */

import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  const key = process.env.YOUTUBE_DATA_API_KEY
  if (!key) return NextResponse.json({ error: 'YOUTUBE_DATA_API_KEY not set' }, { status: 500 })

  const queries = [
    'Dark Pals',
    'Dark Pals: The 1st Floor',
    'Skunx Entertainment',
    'Pokemon',  // sanity check
  ]
  const results: Record<string, unknown> = {}
  for (const q of queries) {
    const params = new URLSearchParams({
      part: 'snippet',
      type: 'video',
      q,
      maxResults: '5',
      order: 'date',
      key,
    })
    try {
      const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`)
      const text = await res.text()
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { parsed = text.substring(0, 400) }
      const itemCount = (parsed as { items?: unknown[] })?.items?.length ?? null
      results[q] = {
        http_status: res.status,
        items_count: itemCount,
        // If error, expose the error message verbatim — Google returns
        // structured { error: { message, errors: [...] } } on quota/perm fails
        error: (parsed as { error?: unknown })?.error ?? null,
        first_item_title: itemCount && itemCount > 0
          ? (parsed as { items: Array<{ snippet?: { title?: string } }> }).items[0]?.snippet?.title
          : null,
      }
    } catch (err) {
      results[q] = { error: err instanceof Error ? err.message : String(err) }
    }
  }

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    key_length: key.length,
    key_prefix: key.substring(0, 6) + '…',
    queries: results,
  })
}
