/**
 * Coverage-item noise classifier.
 *
 * Tags items at insert time with the noise patterns they match. We DON'T
 * filter or hide based on these tags — that's the report UI's job. Each
 * pattern is documented with examples so the operator can see why a given
 * item was flagged and turn the filter off if a category becomes useful.
 *
 * Patterns derived empirically 2026-06-04 by analyzing both Bram's
 * 2,898-row CSV and our own 2,926-item Dark Pals corpus. Each pattern was
 * verified to catch only items a PR analyst would skip when writing a
 * client report.
 *
 * Returns an array — empty if the item is signal, non-empty if any noise
 * pattern matches. Multi-tag is fine (e.g. "Dark Pals 2 vs Poppy Playtime
 * REMIX" hits three categories at once).
 */

export type NoiseCategory =
  | 'fan_crossover'
  | 'sequel_speculation'
  | 'music_remix'
  | 'evolution_video'
  | 'app_store_listing'
  | 'low_audience'
  | 'fan_animation'
  | 'compilation'
  | 'shorts_low_effort'

export interface NoiseInput {
  title: string
  description?: string
  /** Channel followers (YT subs / Twitch followers / TikTok followers) */
  audienceFollowers?: number | null
  /** Item-level views (YT video views, Twitch clip views, etc.) */
  audienceViews?: number | null
  /** Source type — affects pattern selection (e.g. only YT gets app-store flag) */
  sourceType?: 'youtube' | 'twitch' | 'tiktok' | 'twitter' | 'tavily' | 'rss' | string
}

interface PatternDef {
  category: NoiseCategory
  test: (input: NoiseInput, lower: { title: string; desc: string }) => boolean
  why: string
}

const PATTERNS: PatternDef[] = [
  {
    category: 'fan_crossover',
    why: 'Cross-IP fan content using game characters in vs/compilation videos',
    test: (i, l) => /\bvs\b.*(poppy|playtime|banban|garten|huggy|skibidi|smiling critters|hello neighbor|amanda the adventurer|sprunki|mr stinky|chompy)/.test(l.title),
  },
  {
    category: 'sequel_speculation',
    why: 'Non-existent sequel/chapter content (Dark Pals 2 isn\'t released)',
    test: (i, l) => /(dark\s*pals?\s*2|2nd\s*floor|second\s*floor|chapter\s*2|floor\s*2)\b/.test(l.title),
  },
  {
    category: 'music_remix',
    why: 'Fan remixes/covers/ASMR of official song — not press coverage',
    test: (i, l) => /^\s*\[(vocals|asmr|switching audio|remix|cover|edit|mashup|bass boosted|slowed|sped up|nightcore)\]/.test(l.title)
      || /\b(official|hardstyle|nightcore|phonk|trap|remix|edit)\b.*\b(version|edit|remix)\b/.test(l.title),
  },
  {
    category: 'evolution_video',
    why: 'Character-evolution / "all forms" content farm pattern',
    test: (i, l) => /^(evolution of|all (versions|forms|skins|stages))/.test(l.title),
  },
  {
    category: 'app_store_listing',
    why: 'Store-page or download-link item, not coverage',
    test: (i, l) => i.sourceType === 'tavily' && /(google play|app store|play store|appstore|apkpure|apkmirror|apk download|free download)/.test((l.title + ' ' + l.desc)),
  },
  {
    category: 'fan_animation',
    why: 'Garry\'s Mod / fan-made animation using game models — not press coverage',
    test: (i, l) => /(garrys?\s*mod|gmod\b|sfm\b|source\s*filmmaker|fan\s*animation|stop\s*motion)/.test(l.title),
  },
  {
    category: 'compilation',
    why: 'Compilation/mega-pack/all-jumpscares content farm pattern',
    test: (i, l) => /^(all\s+(jumpscares|deaths|endings|bosses|secrets|easter\s*eggs)|every\s+(jumpscare|death|ending))/.test(l.title),
  },
  {
    category: 'shorts_low_effort',
    why: 'Short-form low-effort content (#shorts, single emoji, very short title)',
    test: (i, l) =>
      // YouTube #shorts hashtag is a low-quality signal when it's the dominant
      // hashtag — most #shorts of game content are 15-60s reaction edits, not
      // real coverage. We only flag if shorts indicator + title has no real
      // descriptive text (≤4 words apart from the game name).
      i.sourceType === 'youtube'
      && /#shorts?\b/.test(l.title)
      && l.title.replace(/#\w+/g, '').replace(/dark\s*pals?/gi, '').trim().split(/\s+/).filter(w => w.length > 0).length <= 4,
  },
  {
    category: 'low_audience',
    why: 'Creator/video has <1K audience signal — long-tail filler',
    test: (i) => {
      const a = i.audienceFollowers ?? 0
      const v = i.audienceViews ?? 0
      // Only flag if BOTH signals are below threshold OR one is below and the
      // other unknown. Editorial Tavily items often have null audience —
      // those get a separate pass via outlet domain check at report time.
      const maxSignal = Math.max(a, v)
      // Don't flag if we have no audience data at all (skip low_audience —
      // unknown is its own state)
      if (a === 0 && v === 0) return false
      return maxSignal < 1000
    },
  },
]

export interface NoiseResult {
  flags: NoiseCategory[]
  reasons: Array<{ category: NoiseCategory; why: string }>
  is_noise: boolean
}

export function detectNoise(input: NoiseInput): NoiseResult {
  const lower = {
    title: (input.title || '').toLowerCase(),
    desc: (input.description || '').toLowerCase(),
  }
  const matched: Array<{ category: NoiseCategory; why: string }> = []
  for (const p of PATTERNS) {
    try {
      if (p.test(input, lower)) {
        matched.push({ category: p.category, why: p.why })
      }
    } catch { /* defensive — pattern test must never crash insert */ }
  }
  return {
    flags: matched.map(m => m.category),
    reasons: matched,
    is_noise: matched.length > 0,
  }
}
