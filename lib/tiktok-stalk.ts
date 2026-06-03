/**
 * TikTok creator profile fetcher via @tobyg74/tiktok-api-dl StalkUser.
 *
 * Why this exists:
 *   - The Apify TikTok scraper costs ~$3-4 per game and burns monthly budget.
 *   - The Apify monthly cap is $29, shared across TikTok/Twitter/Instagram.
 *   - StalkUser hits TikTok's web profile endpoint directly — free, no key,
 *     gets follower count + bio + verified status for any handle.
 *
 * What it doesn't do:
 *   - GetUserPosts (per-creator video list) requires a session cookie that
 *     rotates frequently. Don't try it; it errors with "Empty response".
 *   - Search/hashtag endpoints similar — gated.
 *
 * What it does very well:
 *   - Confirms a handle exists, returns its real follower count for tier
 *     classification (PR cares about ≥10K creators for reports).
 *   - 100% success rate on test sample (chasingskyler, mrquantumgames,
 *     fujigamingreal, lollolacustre — all returned correctly).
 *
 * Cost: $0. Free, no key.
 */

import Tiktok from '@tobyg74/tiktok-api-dl'

export interface TikTokCreator {
  handle: string  // without leading @
  displayName: string
  followerCount: number
  followingCount: number
  videoCount: number
  bio: string
  isVerified: boolean
  avatarUrl: string
}

/**
 * Stalk a TikTok handle — returns null on failure (handle doesn't exist,
 * banned, private, network err). Verified 2026-06-01: 4/4 sample handles
 * returned correctly with full stats.
 */
export async function stalkTikTokUser(handle: string): Promise<TikTokCreator | null> {
  const clean = handle.replace(/^@+/, '').trim()
  if (!clean) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = await Tiktok.StalkUser(clean)
    if (r?.status !== 'success' || !r?.result) return null
    const u = r.result.user || {}
    const s = r.result.stats || {}
    return {
      handle: clean.toLowerCase(),
      displayName: u.nickname || u.uniqueId || clean,
      followerCount: Number(s.followerCount ?? s.followerCount ?? 0) || 0,
      followingCount: Number(s.followingCount ?? 0) || 0,
      videoCount: Number(s.videoCount ?? 0) || 0,
      bio: u.signature || '',
      isVerified: !!u.verified,
      avatarUrl: u.avatarLarger || u.avatarMedium || u.avatarThumb || '',
    }
  } catch {
    return null
  }
}

/**
 * Extract TikTok @handles from arbitrary text (typically a YouTube video
 * description or Tavily snippet). Lowercased, deduped, common
 * reserved/false-positive paths filtered.
 */
export function extractTikTokHandles(text: string): string[] {
  const out = new Set<string>()
  const re = /tiktok\.com\/@([\w.\-]{2,24})\b/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const handle = m[1].toLowerCase()
    if (['login', 'discover', 'foryou', 'following', 'live', 'about',
         'feedback', 'careers', 'safety', 'creators', 'business'].includes(handle)) continue
    out.add(handle)
  }
  return Array.from(out)
}

/**
 * Tier classification by follower count — matches PR-report standard.
 * Returns the outlet tier code used elsewhere in the system.
 */
export function classifyTier(followers: number): 'A' | 'B' | 'C' | 'D' {
  if (followers >= 1_000_000) return 'A'
  if (followers >= 100_000) return 'B'
  if (followers >= 10_000) return 'C'
  return 'D'
}
