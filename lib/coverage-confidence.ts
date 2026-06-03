/**
 * Coverage-item confidence scoring + auto-approval policy.
 *
 * Forward-poll pipelines (twitch-streams-poll, youtube-rss-poll,
 * tiktok-profile-poll) discover new items continuously. Manually reviewing
 * every one is the bottleneck — the PR agency staff was drowning in
 * pending_review items.
 *
 * The fix: score each item's confidence based on signal quality, and
 * auto-approve high-confidence ones. Manual review only kicks in for items
 * with ambiguous matches.
 *
 * Tiers:
 *   STRONG  → auto_approved   exact game-title in title, OR title+desc match
 *   GOOD    → auto_approved   primary game name in title only
 *   WEAK    → pending_review  description-only match, or alias (studio,
 *                              cross-promo) match
 *   NOISE   → reject silently (don't insert)
 *
 * Tuning: STRONG/GOOD covers the common case — most YouTube videos titled
 * "Dark Pals 100% walkthrough" match exactly and are obviously legitimate.
 * Description-only matches are the false-positive source (e.g. "Big Willie
 * Radio" had "Pine Studio" in description). Those go to manual review.
 */

export type ConfidenceTier = 'STRONG' | 'GOOD' | 'WEAK' | 'NOISE'

export interface ConfidenceInput {
  title: string
  description: string
  primaryGameName: string  // The DB game.name — most authoritative match
  aliasKeywords: string[]  // Other whitelist keywords for the game
}

export interface ConfidenceResult {
  tier: ConfidenceTier
  approvalStatus: 'auto_approved' | 'pending_review'
  reason: string
  matchedKeyword?: string
  matchLocation: 'title' | 'description' | 'title+description' | 'none'
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
}

function containsWord(haystack: string, needle: string): boolean {
  if (needle.length < 3) return false
  const h = normalize(haystack)
  const n = normalize(needle)
  if (n.length === 0) return false
  // Word-boundary-ish: match needle if surrounded by space or start/end
  return new RegExp(`(^| )${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(h)
}

export function scoreConfidence(input: ConfidenceInput): ConfidenceResult {
  const { title, description, primaryGameName, aliasKeywords } = input
  const titleHasPrimary = containsWord(title, primaryGameName)
  const descHasPrimary = containsWord(description, primaryGameName)

  if (titleHasPrimary && descHasPrimary) {
    return {
      tier: 'STRONG',
      approvalStatus: 'auto_approved',
      reason: 'primary game name in both title and description',
      matchedKeyword: primaryGameName,
      matchLocation: 'title+description',
    }
  }
  if (titleHasPrimary) {
    return {
      tier: 'GOOD',
      approvalStatus: 'auto_approved',
      reason: 'primary game name in title',
      matchedKeyword: primaryGameName,
      matchLocation: 'title',
    }
  }

  // Title-aliased? (Some games have a shorthand or compound title — accept
  // as GOOD if any alias appears in the title.)
  for (const alias of aliasKeywords) {
    if (alias === primaryGameName) continue
    if (containsWord(title, alias)) {
      return {
        tier: 'GOOD',
        approvalStatus: 'auto_approved',
        reason: 'game alias in title',
        matchedKeyword: alias,
        matchLocation: 'title',
      }
    }
  }

  if (descHasPrimary) {
    return {
      tier: 'WEAK',
      approvalStatus: 'pending_review',
      reason: 'primary game name in description only — confirm manually',
      matchedKeyword: primaryGameName,
      matchLocation: 'description',
    }
  }

  // Alias-only in description (developer/studio name etc.) — weak signal
  for (const alias of aliasKeywords) {
    if (alias === primaryGameName) continue
    if (containsWord(description, alias)) {
      return {
        tier: 'WEAK',
        approvalStatus: 'pending_review',
        reason: `alias "${alias}" in description only`,
        matchedKeyword: alias,
        matchLocation: 'description',
      }
    }
  }

  return {
    tier: 'NOISE',
    approvalStatus: 'pending_review',
    reason: 'no clear match — should not have been inserted',
    matchLocation: 'none',
  }
}
