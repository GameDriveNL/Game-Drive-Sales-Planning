'use client'

import { useState, useMemo } from 'react'
import { Sidebar } from '../components/Sidebar'

// ─── Tag data ─────────────────────────────────────────────────────────────────
// Source: games-stats.com/steam/tags — approximate game counts (thousands)

interface SteamTag {
  name: string
  category: string
  gameCount: number  // approximate thousands of games
  notes?: string
}

const TAGS: SteamTag[] = [
  // Genre - Core
  { name: 'Action', category: 'Genre', gameCount: 90 },
  { name: 'Adventure', category: 'Genre', gameCount: 80 },
  { name: 'RPG', category: 'Genre', gameCount: 55 },
  { name: 'Strategy', category: 'Genre', gameCount: 40 },
  { name: 'Simulation', category: 'Genre', gameCount: 38 },
  { name: 'Puzzle', category: 'Genre', gameCount: 35 },
  { name: 'Platformer', category: 'Genre', gameCount: 30 },
  { name: 'Shooter', category: 'Genre', gameCount: 28 },
  { name: 'Horror', category: 'Genre', gameCount: 25 },
  { name: 'Racing', category: 'Genre', gameCount: 15 },
  { name: 'Sports', category: 'Genre', gameCount: 14 },
  { name: 'Fighting', category: 'Genre', gameCount: 12 },
  { name: 'Stealth', category: 'Genre', gameCount: 10 },
  { name: 'Tower Defense', category: 'Genre', gameCount: 9 },
  { name: 'Survival', category: 'Genre', gameCount: 22 },
  { name: 'Management', category: 'Genre', gameCount: 16 },
  { name: 'Card Game', category: 'Genre', gameCount: 10 },
  { name: 'Visual Novel', category: 'Genre', gameCount: 18 },
  { name: 'Point & Click', category: 'Genre', gameCount: 8 },
  { name: 'Metroidvania', category: 'Genre', gameCount: 12 },
  { name: 'Rogue-like', category: 'Genre', gameCount: 18 },
  { name: 'Rogue-lite', category: 'Genre', gameCount: 12 },
  { name: 'Turn-Based', category: 'Genre', gameCount: 20 },
  { name: 'Real Time with Pause', category: 'Genre', gameCount: 8 },
  { name: 'MOBA', category: 'Genre', gameCount: 4 },
  { name: 'Battle Royale', category: 'Genre', gameCount: 3 },
  { name: 'Hack and Slash', category: 'Genre', gameCount: 11 },
  { name: 'Beat \'em up', category: 'Genre', gameCount: 6 },
  { name: 'Bullet Hell', category: 'Genre', gameCount: 7 },
  { name: 'Rhythm', category: 'Genre', gameCount: 6 },
  // Multiplayer
  { name: 'Singleplayer', category: 'Multiplayer', gameCount: 130, notes: 'Most common tag overall' },
  { name: 'Multiplayer', category: 'Multiplayer', gameCount: 38 },
  { name: 'Co-op', category: 'Multiplayer', gameCount: 30 },
  { name: 'Online Co-Op', category: 'Multiplayer', gameCount: 18 },
  { name: 'Local Co-Op', category: 'Multiplayer', gameCount: 14 },
  { name: 'PvP', category: 'Multiplayer', gameCount: 14 },
  { name: 'Online PvP', category: 'Multiplayer', gameCount: 10 },
  { name: 'Massively Multiplayer', category: 'Multiplayer', gameCount: 5 },
  { name: 'Local Multiplayer', category: 'Multiplayer', gameCount: 12 },
  { name: 'Asynchronous Multiplayer', category: 'Multiplayer', gameCount: 4 },
  // Gameplay Mechanics
  { name: 'Open World', category: 'Mechanics', gameCount: 22 },
  { name: 'Exploration', category: 'Mechanics', gameCount: 40 },
  { name: 'Crafting', category: 'Mechanics', gameCount: 22 },
  { name: 'Building', category: 'Mechanics', gameCount: 16 },
  { name: 'Procedural Generation', category: 'Mechanics', gameCount: 20 },
  { name: 'Permadeath', category: 'Mechanics', gameCount: 14 },
  { name: 'Base Building', category: 'Mechanics', gameCount: 10 },
  { name: 'Resource Management', category: 'Mechanics', gameCount: 15 },
  { name: 'Stealth', category: 'Mechanics', gameCount: 10 },
  { name: 'Puzzle-Platformer', category: 'Mechanics', gameCount: 10 },
  { name: 'Physics', category: 'Mechanics', gameCount: 18 },
  { name: 'Time Manipulation', category: 'Mechanics', gameCount: 6 },
  { name: 'Farming Sim', category: 'Mechanics', gameCount: 8 },
  { name: 'City Builder', category: 'Mechanics', gameCount: 7 },
  { name: 'Colony Sim', category: 'Mechanics', gameCount: 5 },
  { name: 'Automation', category: 'Mechanics', gameCount: 5 },
  { name: 'Combat', category: 'Mechanics', gameCount: 30 },
  { name: 'Choices Matter', category: 'Mechanics', gameCount: 12 },
  { name: 'Narration', category: 'Mechanics', gameCount: 10 },
  { name: 'Character Customization', category: 'Mechanics', gameCount: 20 },
  { name: 'Inventory Management', category: 'Mechanics', gameCount: 9 },
  { name: 'Loot', category: 'Mechanics', gameCount: 15 },
  { name: 'Level Editor', category: 'Mechanics', gameCount: 9 },
  // Art Style
  { name: '2D', category: 'Art Style', gameCount: 65 },
  { name: '3D', category: 'Art Style', gameCount: 38 },
  { name: 'Pixel Art', category: 'Art Style', gameCount: 30 },
  { name: 'Cartoon', category: 'Art Style', gameCount: 22 },
  { name: 'Hand-drawn', category: 'Art Style', gameCount: 10 },
  { name: 'Anime', category: 'Art Style', gameCount: 18 },
  { name: 'Stylized', category: 'Art Style', gameCount: 22 },
  { name: 'Low Poly', category: 'Art Style', gameCount: 10 },
  { name: 'Colorful', category: 'Art Style', gameCount: 30 },
  { name: 'Dark', category: 'Art Style', gameCount: 22 },
  { name: 'Atmospheric', category: 'Art Style', gameCount: 30 },
  { name: 'Realistic', category: 'Art Style', gameCount: 12 },
  { name: 'Isometric', category: 'Art Style', gameCount: 10 },
  { name: 'Top-Down', category: 'Art Style', gameCount: 16 },
  { name: 'First-Person', category: 'Art Style', gameCount: 20 },
  { name: 'Third Person', category: 'Art Style', gameCount: 18 },
  { name: 'Side Scroller', category: 'Art Style', gameCount: 20 },
  // Theme / Setting
  { name: 'Fantasy', category: 'Theme', gameCount: 38 },
  { name: 'Sci-fi', category: 'Theme', gameCount: 28 },
  { name: 'Post-apocalyptic', category: 'Theme', gameCount: 14 },
  { name: 'Cyberpunk', category: 'Theme', gameCount: 8 },
  { name: 'Medieval', category: 'Theme', gameCount: 16 },
  { name: 'Space', category: 'Theme', gameCount: 20 },
  { name: 'Dystopian', category: 'Theme', gameCount: 8 },
  { name: 'Psychological Horror', category: 'Theme', gameCount: 6 },
  { name: 'Survival Horror', category: 'Theme', gameCount: 5 },
  { name: 'Steampunk', category: 'Theme', gameCount: 6 },
  { name: 'Western', category: 'Theme', gameCount: 4 },
  { name: 'Historical', category: 'Theme', gameCount: 12 },
  { name: 'War', category: 'Theme', gameCount: 12 },
  { name: 'Supernatural', category: 'Theme', gameCount: 10 },
  { name: 'Lovecraftian', category: 'Theme', gameCount: 4 },
  { name: 'Comedy', category: 'Theme', gameCount: 14 },
  { name: 'Mystery', category: 'Theme', gameCount: 12 },
  { name: 'Thriller', category: 'Theme', gameCount: 5 },
  { name: 'Cute', category: 'Theme', gameCount: 16 },
  { name: 'Dark Fantasy', category: 'Theme', gameCount: 8 },
  { name: 'Nature', category: 'Theme', gameCount: 10 },
  // Quality / Appeal
  { name: 'Great Soundtrack', category: 'Quality', gameCount: 18 },
  { name: 'Story Rich', category: 'Quality', gameCount: 25 },
  { name: 'Relaxing', category: 'Quality', gameCount: 18 },
  { name: 'Difficult', category: 'Quality', gameCount: 20 },
  { name: 'Casual', category: 'Quality', gameCount: 30 },
  { name: 'Indie', category: 'Quality', gameCount: 75, notes: 'Very common — expected for indie games' },
  { name: 'Moody', category: 'Quality', gameCount: 8 },
  { name: 'Family Friendly', category: 'Quality', gameCount: 10 },
  { name: 'Short', category: 'Quality', gameCount: 12 },
  { name: 'Replayability', category: 'Quality', gameCount: 12 },
  { name: 'Highly Replayable', category: 'Quality', gameCount: 10 },
  { name: 'Emotional', category: 'Quality', gameCount: 10 },
  { name: 'Immersive Sim', category: 'Quality', gameCount: 4 },
  { name: 'Controller', category: 'Quality', gameCount: 22 },
  { name: 'Keyboard & Mouse', category: 'Quality', gameCount: 10 },
]

// Common combos by genre
const GENRE_PRESETS: Record<string, { tags: string[]; advice: string }> = {
  'Indie Action-Adventure': {
    tags: ['Action', 'Adventure', 'Indie', 'Singleplayer', '3D', 'Exploration', 'Atmospheric', 'Story Rich'],
    advice: 'Core set for most indie 3D action-adventure games. Add your art style (Pixel Art, Stylized) and theme (Fantasy, Sci-fi) for better discoverability.'
  },
  '2D Platformer': {
    tags: ['Platformer', '2D', 'Indie', 'Singleplayer', 'Side Scroller', 'Colorful', 'Pixel Art'],
    advice: 'Consider adding "Cute", "Difficult", or "Casual" to signal tone. "Metroidvania" if exploration is key. "Local Co-Op" if it has couch co-op.'
  },
  'Rogue-lite / Rogue-like': {
    tags: ['Rogue-like', 'Roguelite', 'Procedural Generation', 'Permadeath', 'Indie', 'Singleplayer', 'Replayability', 'Action'],
    advice: 'Roguelite vs. Rogue-like distinction matters to players. Add primary genre (Shooter, Hack and Slash, Deck Building) on top.'
  },
  'Strategy / Management': {
    tags: ['Strategy', 'Management', 'Indie', 'Singleplayer', 'Resource Management', 'Turn-Based', 'Isometric'],
    advice: 'Specify subtype: City Builder, Colony Sim, Tower Defense, Real-Time Strategy, or Turn-Based Strategy. "Casual" vs "Difficult" sets player expectations.'
  },
  'Horror': {
    tags: ['Horror', 'Atmospheric', 'Dark', 'Singleplayer', 'Indie', 'Survival Horror', 'Psychological Horror'],
    advice: 'Horror subtype (Survival vs Psychological) dramatically affects your audience. "Jump Scares" is searchable but divisive — use only if accurate.'
  },
  'RPG': {
    tags: ['RPG', 'Story Rich', 'Singleplayer', 'Exploration', 'Loot', 'Character Customization', 'Fantasy'],
    advice: 'Most RPGs succeed with strong Story Rich + Fantasy/Sci-fi combo. Add "Turn-Based" or "Action RPG" subtype. "Open World" if applicable.'
  },
  'Multiplayer / Co-op': {
    tags: ['Multiplayer', 'Co-op', 'Online Co-Op', 'Local Co-Op', 'PvP', 'Action', 'Indie'],
    advice: 'Always list all multiplayer modes supported. Local Co-Op is rare and highly valued. Specify game mode (Battle Royale, MOBA, etc.)'
  },
  'Puzzle': {
    tags: ['Puzzle', 'Singleplayer', 'Relaxing', 'Casual', 'Indie', '2D', 'Colorful'],
    advice: 'Puzzle + Casual + Relaxing captures the cozy-game audience. Difficult Puzzles should add "Difficult". "Logic" or "Physics" if applicable.'
  },
  'Visual Novel / Narrative': {
    tags: ['Visual Novel', 'Story Rich', 'Choices Matter', 'Singleplayer', 'Anime', 'Narration', 'Emotional'],
    advice: 'Choices Matter is essential if the game has branching paths. "Romance" or "Mystery" add strong niche audience pull.'
  },
  'Survival': {
    tags: ['Survival', 'Open World', 'Crafting', 'Base Building', 'Singleplayer', 'Multiplayer', 'Exploration'],
    advice: 'Survival games perform well with crafting + open world combination. Specify co-op support clearly — it drives wish-lists significantly.'
  },
}

const CATEGORIES = ['Genre', 'Multiplayer', 'Mechanics', 'Art Style', 'Theme', 'Quality']
const CAT_COLORS: Record<string, string> = {
  'Genre': '#2563eb', 'Multiplayer': '#059669', 'Mechanics': '#d97706',
  'Art Style': '#7c3aed', 'Theme': '#b8232f', 'Quality': '#475569'
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SteamTagsPage() {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState<string>('All')
  const [activePreset, setActivePreset] = useState<string>('')

  const toggleTag = (name: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else if (next.size < 20) next.add(name)  // Steam max is 20 tags
      return next
    })
  }

  const applyPreset = (presetKey: string) => {
    const preset = GENRE_PRESETS[presetKey]
    if (!preset) return
    setSelected(new Set(preset.tags))
    setActivePreset(presetKey)
  }

  const filtered = useMemo(() => {
    return TAGS.filter(t => {
      const matchCat = activeCategory === 'All' || t.category === activeCategory
      const matchSearch = !search || t.name.toLowerCase().includes(search.toLowerCase())
      return matchCat && matchSearch
    }).sort((a, b) => b.gameCount - a.gameCount)
  }, [activeCategory, search])

  const selectedTags = TAGS.filter(t => selected.has(t.name)).sort((a, b) => b.gameCount - a.gameCount)

  const overUsedWarnings = selectedTags.filter(t => t.gameCount > 50)
  const underUsedWarnings = selectedTags.filter(t => t.gameCount < 4)
  const hasCoreGenre = selectedTags.some(t => t.category === 'Genre')
  const hasPlayerMode = selectedTags.some(t => t.category === 'Multiplayer')

  return (
    <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
      <Sidebar />
      <div style={{ flex: 1, padding: '32px', minWidth: 0 }}>

        <div style={{ marginBottom: '24px' }}>
          <h1 style={{ fontSize: '22px', fontWeight: 700, color: '#1e293b', margin: '0 0 4px' }}>Steam Tag Optimizer</h1>
          <p style={{ fontSize: '13px', color: '#64748b', margin: 0 }}>Pick up to 20 tags. Data from games-stats.com/steam/tags — game counts are approximate.</p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: '24px', alignItems: 'start' }}>

          {/* Left: tag browser */}
          <div>
            {/* Genre presets */}
            <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', marginBottom: '20px' }}>
              <div style={{ fontSize: '13px', fontWeight: 600, color: '#1e293b', marginBottom: '12px' }}>Quick start — apply a genre preset</div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {Object.keys(GENRE_PRESETS).map(k => (
                  <button
                    key={k}
                    onClick={() => applyPreset(k)}
                    style={{
                      padding: '5px 12px', borderRadius: '20px', border: '1px solid',
                      fontSize: '12px', fontWeight: 500, cursor: 'pointer',
                      backgroundColor: activePreset === k ? '#b8232f' : 'white',
                      color: activePreset === k ? 'white' : '#475569',
                      borderColor: activePreset === k ? '#b8232f' : '#e2e8f0',
                    }}
                  >
                    {k}
                  </button>
                ))}
                {activePreset && (
                  <button onClick={() => { setSelected(new Set()); setActivePreset('') }}
                    style={{ padding: '5px 12px', borderRadius: '20px', border: '1px solid #f1f5f9', fontSize: '12px', color: '#94a3b8', cursor: 'pointer', backgroundColor: 'transparent' }}>
                    Clear preset
                  </button>
                )}
              </div>
              {activePreset && GENRE_PRESETS[activePreset] && (
                <div style={{ marginTop: '12px', fontSize: '12px', color: '#475569', backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '8px', lineHeight: 1.5 }}>
                  {GENRE_PRESETS[activePreset].advice}
                </div>
              )}
            </div>

            {/* Search + category filter */}
            <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', alignItems: 'center' }}>
              <input
                type="text"
                placeholder="Search tags…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{ flex: 1, padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '13px', color: '#1e293b' }}
              />
              <div style={{ display: 'flex', gap: '4px', backgroundColor: 'white', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '3px' }}>
                {['All', ...CATEGORIES].map(cat => (
                  <button
                    key={cat}
                    onClick={() => setActiveCategory(cat)}
                    style={{
                      padding: '4px 10px', border: 'none', borderRadius: '6px', fontSize: '12px', fontWeight: 500, cursor: 'pointer',
                      backgroundColor: activeCategory === cat ? (CAT_COLORS[cat] || '#475569') : 'transparent',
                      color: activeCategory === cat ? 'white' : '#64748b',
                    }}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>

            {/* Tag grid */}
            <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {filtered.map(tag => {
                  const isSelected = selected.has(tag.name)
                  const catColor = CAT_COLORS[tag.category] || '#475569'
                  return (
                    <button
                      key={tag.name}
                      onClick={() => toggleTag(tag.name)}
                      title={`${tag.notes || ''} ~${tag.gameCount}K games`}
                      style={{
                        padding: '5px 10px', borderRadius: '6px', border: `1px solid ${isSelected ? catColor : '#e2e8f0'}`,
                        fontSize: '12px', fontWeight: isSelected ? 600 : 400, cursor: 'pointer',
                        backgroundColor: isSelected ? catColor : 'white',
                        color: isSelected ? 'white' : '#475569',
                        transition: 'all 0.1s',
                      }}
                    >
                      {tag.name}
                      <span style={{ marginLeft: '4px', fontSize: '10px', opacity: 0.7 }}>~{tag.gameCount}K</span>
                    </button>
                  )
                })}
                {filtered.length === 0 && (
                  <div style={{ color: '#94a3b8', fontSize: '13px', padding: '20px' }}>No tags match your search</div>
                )}
              </div>
            </div>
          </div>

          {/* Right: selected tags + analysis */}
          <div style={{ position: 'sticky', top: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#1e293b' }}>Selected tags ({selected.size}/20)</div>
                {selected.size > 0 && (
                  <button onClick={() => { setSelected(new Set()); setActivePreset('') }}
                    style={{ fontSize: '11px', color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer' }}>
                    Clear all
                  </button>
                )}
              </div>

              {selected.size === 0 ? (
                <div style={{ color: '#94a3b8', fontSize: '12px', textAlign: 'center', padding: '20px 0' }}>
                  Click tags to add them, or use a genre preset above
                </div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '16px' }}>
                  {selectedTags.map(tag => (
                    <button
                      key={tag.name}
                      onClick={() => toggleTag(tag.name)}
                      style={{
                        padding: '4px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: 500, cursor: 'pointer',
                        backgroundColor: CAT_COLORS[tag.category] || '#475569', color: 'white', border: 'none',
                        display: 'flex', alignItems: 'center', gap: '4px'
                      }}
                    >
                      {tag.name} <span style={{ opacity: 0.7 }}>×</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Slot bar */}
              <div style={{ height: '6px', backgroundColor: '#f1f5f9', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${(selected.size / 20) * 100}%`, backgroundColor: selected.size >= 18 ? '#dc2626' : selected.size >= 12 ? '#d97706' : '#059669', transition: 'width 0.2s, background-color 0.2s' }} />
              </div>
              <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>
                {selected.size < 10 ? 'Add more tags to improve discoverability' : selected.size < 20 ? `${20 - selected.size} slot${20 - selected.size === 1 ? '' : 's'} remaining` : 'Tag limit reached'}
              </div>
            </div>

            {/* Quality checks */}
            {selected.size > 0 && (
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: '#1e293b', marginBottom: '12px' }}>Quality checks</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <Check ok={hasCoreGenre} label="Has a core genre tag" hint="(Action, RPG, Strategy, etc.)" />
                  <Check ok={hasPlayerMode} label="Has player mode tag" hint="(Singleplayer, Multiplayer, Co-op)" />
                  <Check ok={selected.size >= 10} label="At least 10 tags" hint="more = broader discovery surface" />
                  <Check ok={overUsedWarnings.length === 0} label="No overly generic tags" hint={overUsedWarnings.length ? `Consider: ${overUsedWarnings.slice(0,2).map(t => t.name).join(', ')} are very common` : ''} />
                  <Check ok={underUsedWarnings.length === 0} label="No ultra-niche tags only" hint={underUsedWarnings.length ? `${underUsedWarnings.slice(0,2).map(t => t.name).join(', ')} have very few games` : ''} />
                </div>
              </div>
            )}

            {/* Category balance */}
            {selected.size > 0 && (
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: '#1e293b', marginBottom: '12px' }}>Category balance</div>
                {CATEGORIES.map(cat => {
                  const count = selectedTags.filter(t => t.category === cat).length
                  if (count === 0) return null
                  return (
                    <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                      <div style={{ width: '8px', height: '8px', borderRadius: '2px', backgroundColor: CAT_COLORS[cat], flexShrink: 0 }} />
                      <div style={{ flex: 1, fontSize: '12px', color: '#475569' }}>{cat}</div>
                      <div style={{ fontSize: '12px', fontWeight: 600, color: '#1e293b' }}>{count}</div>
                      <div style={{ width: '60px', height: '5px', backgroundColor: '#f1f5f9', borderRadius: '3px', overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${(count / selected.size) * 100}%`, backgroundColor: CAT_COLORS[cat] }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            <div style={{ padding: '12px 16px', backgroundColor: '#eff6ff', borderRadius: '10px', fontSize: '11px', color: '#3b82f6', lineHeight: 1.6 }}>
              <strong>Tip:</strong> Steam prioritizes tags that appear on similar successful games. Aim for 12–15 accurate tags rather than stuffing all 20. Data source: games-stats.com/steam/tags
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Check({ ok, label, hint }: { ok: boolean; label: string; hint?: string }) {
  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
      <div style={{
        width: '16px', height: '16px', borderRadius: '50%', flexShrink: 0, marginTop: '1px',
        backgroundColor: ok ? '#dcfce7' : '#fef2f2',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px',
        color: ok ? '#16a34a' : '#dc2626',
      }}>
        {ok ? '✓' : '!'}
      </div>
      <div>
        <div style={{ fontSize: '12px', color: ok ? '#1e293b' : '#dc2626', fontWeight: ok ? 400 : 500 }}>{label}</div>
        {hint && <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '1px' }}>{hint}</div>}
      </div>
    </div>
  )
}
