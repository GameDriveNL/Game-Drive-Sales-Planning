import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { verifyCronAuth } from '@/lib/cron-auth'

function getSupabase() {
  return getServerSupabase()
}

/**
 * Normalize a URL for comparison: strip protocol, www, trailing slashes, UTM params, fragments.
 */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    // Remove common tracking params
    const stripParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'source', 'fbclid', 'gclid']
    for (const p of stripParams) u.searchParams.delete(p)
    // Normalize: no hash, no trailing slash, lowercase host
    let normalized = `${u.host.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`.toLowerCase()
    const params = u.searchParams.toString()
    if (params) normalized += `?${params}`
    return normalized
  } catch {
    return url.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '')
  }
}

/**
 * Normalize a title for comparison: lowercase, strip non-alphanumeric, collapse whitespace.
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Levenshtein distance between two strings.
 */
function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  // Optimization: if lengths differ too much, can't be similar
  if (Math.abs(a.length - b.length) > Math.max(a.length, b.length) * 0.3) {
    return Math.max(a.length, b.length)
  }

  const matrix: number[][] = []
  for (let i = 0; i <= b.length; i++) matrix[i] = [i]
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b[i - 1] === a[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1]
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        )
      }
    }
  }

  return matrix[b.length][a.length]
}

/**
 * Title similarity: 0 = different, 1 = identical
 */
function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a)
  const nb = normalizeTitle(b)
  if (na === nb) return 1
  if (na.length === 0 || nb.length === 0) return 0
  const dist = levenshtein(na, nb)
  const maxLen = Math.max(na.length, nb.length)
  return 1 - (dist / maxLen)
}

// Title similarity threshold for considering articles duplicates
const TITLE_SIMILARITY_THRESHOLD = 0.85

// GET /api/cron/coverage-dedup — Detect and group duplicate/syndicated coverage items
export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request)
  if (authError) return authError

  const supabase = getSupabase()

  try {
    // Fetch recent approved items without a duplicate group (unprocessed)
    const { data: items, error } = await supabase
      .from('coverage_items')
      .select('id, title, url, publish_date, client_id, game_id, outlet_id, monthly_unique_visitors')
      .is('duplicate_group_id', null)
      .in('approval_status', ['auto_approved', 'manually_approved', 'pending_review'])
      .order('publish_date', { ascending: false })
      .limit(200)

    if (error) throw error
    if (!items || items.length === 0) {
      return NextResponse.json({ message: 'No unprocessed items to check' })
    }

    // Also fetch items that already have groups (to match against)
    const { data: groupedItems } = await supabase
      .from('coverage_items')
      .select('id, title, url, publish_date, client_id, duplicate_group_id, is_original, monthly_unique_visitors')
      .not('duplicate_group_id', 'is', null)
      .order('publish_date', { ascending: true })
      .limit(2000)

    const existingGrouped = groupedItems || []

    // Build URL map for fast lookup
    const urlMap: Record<string, { id: string; title: string; clientId: string; groupId: string | null; publishDate: string }[]> = {}

    for (const item of existingGrouped) {
      const i = item as Record<string, unknown>
      const normUrl = normalizeUrl(String(i.url || ''))
      if (!urlMap[normUrl]) urlMap[normUrl] = []
      urlMap[normUrl].push({
        id: String(i.id),
        title: String(i.title || ''),
        clientId: String(i.client_id),
        groupId: i.duplicate_group_id ? String(i.duplicate_group_id) : null,
        publishDate: String(i.publish_date || ''),
      })
    }

    let newGroups = 0
    let duplicatesFound = 0

    // Process each unprocessed item
    for (const item of items) {
      const i = item as Record<string, unknown>
      const itemId = String(i.id)
      const itemUrl = String(i.url || '')
      const itemTitle = String(i.title || '')
      const itemClientId = String(i.client_id)
      const normUrl = normalizeUrl(itemUrl)

      // Step 1: Check URL match
      let matchedGroupId: string | null = null

      if (urlMap[normUrl]) {
        // Same normalized URL exists — find group
        for (const existing of urlMap[normUrl]) {
          if (existing.clientId === itemClientId && existing.groupId) {
            matchedGroupId = existing.groupId
            break
          }
        }
      }

      // Step 2: Check title similarity against recent grouped items
      if (!matchedGroupId && itemTitle.length > 10) {
        for (const existing of existingGrouped) {
          const e = existing as Record<string, unknown>
          if (String(e.client_id) !== itemClientId) continue

          const sim = titleSimilarity(itemTitle, String(e.title || ''))
          if (sim >= TITLE_SIMILARITY_THRESHOLD) {
            matchedGroupId = e.duplicate_group_id ? String(e.duplicate_group_id) : null
            break
          }
        }
      }

      // Step 3: Check title similarity against other unprocessed items in this batch
      if (!matchedGroupId && itemTitle.length > 10) {
        for (const other of items) {
          const o = other as Record<string, unknown>
          if (String(o.id) === itemId) continue
          if (String(o.client_id) !== itemClientId) continue

          const sim = titleSimilarity(itemTitle, String(o.title || ''))
          if (sim >= TITLE_SIMILARITY_THRESHOLD) {
            // Check if the other item was already assigned a group
            const otherNormUrl = normalizeUrl(String(o.url || ''))
            if (urlMap[otherNormUrl]) {
              for (const match of urlMap[otherNormUrl]) {
                if (match.groupId) { matchedGroupId = match.groupId; break }
              }
            }
            break
          }
        }
      }

      if (matchedGroupId) {
        // Add to existing group as non-original
        await supabase
          .from('coverage_items')
          .update({ duplicate_group_id: matchedGroupId, is_original: false })
          .eq('id', itemId)

        duplicatesFound++
      } else {
        // Create a new group with this item as the original
        // Use the item's own ID as the group ID (UUID)
        await supabase
          .from('coverage_items')
          .update({ duplicate_group_id: itemId, is_original: true })
          .eq('id', itemId)

        newGroups++

        // Add to urlMap for future matching in this batch
        if (!urlMap[normUrl]) urlMap[normUrl] = []
        urlMap[normUrl].push({
          id: itemId,
          title: itemTitle,
          clientId: itemClientId,
          groupId: itemId,
          publishDate: String(i.publish_date || ''),
        })

        // Add to existingGrouped for title matching
        existingGrouped.push({
          id: itemId,
          title: itemTitle,
          url: itemUrl,
          publish_date: String(i.publish_date || ''),
          client_id: itemClientId,
          duplicate_group_id: itemId,
          is_original: true,
          monthly_unique_visitors: i.monthly_unique_visitors,
        } as typeof existingGrouped[0])
      }
    }

    return NextResponse.json({
      message: `Dedup complete: ${items.length} processed, ${newGroups} new groups, ${duplicatesFound} duplicates found`,
      processed: items.length,
      new_groups: newGroups,
      duplicates_found: duplicatesFound,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Coverage dedup error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
