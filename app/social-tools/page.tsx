'use client'

import { useState, useEffect, useCallback } from 'react'
import { Sidebar } from '../components/Sidebar'
import { useAuth } from '@/lib/auth-context'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'

// ─── Reddit subreddit database ───────────────────────────────────────────────

interface SubredditEntry {
  name: string
  subscribers: number
  focus: string
  genres: string[]
  type: 'general' | 'platform' | 'genre' | 'dev' | 'community'
  postingTips: string
  restrictive: boolean
}

const SUBREDDITS: SubredditEntry[] = [
  { name: 'r/gaming', subscribers: 38000000, focus: 'General gaming news and discussion', genres: ['all'], type: 'general', postingTips: 'High traffic, upvotes go to viral content. Devs need to engage in comments.', restrictive: false },
  { name: 'r/Games', subscribers: 3200000, focus: 'In-depth gaming discussion and news', genres: ['all'], type: 'general', postingTips: 'Quality-focused community. Self-promotion banned on most days except weekends.', restrictive: true },
  { name: 'r/pcgaming', subscribers: 2100000, focus: 'PC gaming news, hardware, and games', genres: ['all'], type: 'platform', postingTips: 'Devs can post in weekly threads. Trailers welcome if marked clearly.', restrictive: false },
  { name: 'r/indiegaming', subscribers: 270000, focus: 'Indie game news and discovery', genres: ['indie'], type: 'genre', postingTips: 'Very indie-friendly. GIFs and trailers welcome. Engage in comments.', restrictive: false },
  { name: 'r/IndieDev', subscribers: 180000, focus: 'Indie development progress and showcase', genres: ['indie'], type: 'dev', postingTips: 'Weekly showcase threads. Dev logs and dev progress posts very welcome.', restrictive: false },
  { name: 'r/gamedev', subscribers: 520000, focus: 'Game development discussion', genres: ['indie'], type: 'dev', postingTips: 'Saturdays only for showcase. No marketing, only dev content.', restrictive: true },
  { name: 'r/SteamDeals', subscribers: 1800000, focus: 'Steam sales and deals', genres: ['all'], type: 'platform', postingTips: 'Post when your game goes on sale. Link directly to Steam page.', restrictive: false },
  { name: 'r/patientgamers', subscribers: 1200000, focus: 'Gamers who play older or discounted games', genres: ['all'], type: 'general', postingTips: 'Good for "now affordable" announcements. Discuss depth over hype.', restrictive: false },
  { name: 'r/roguelikes', subscribers: 320000, focus: 'Roguelike games and discussion', genres: ['roguelike', 'roguelite'], type: 'genre', postingTips: 'Thursdays are dev showcase day. Community loves discussing mechanics.', restrictive: false },
  { name: 'r/roguelites', subscribers: 150000, focus: 'Roguelite games with permadeath elements', genres: ['roguelike', 'roguelite'], type: 'genre', postingTips: 'Show your run variety and meta progression.', restrictive: false },
  { name: 'r/indiegames', subscribers: 210000, focus: 'Indie game showcase and discovery', genres: ['indie'], type: 'genre', postingTips: 'Screenshots and trailers welcome. Add price/platform info.', restrictive: false },
  { name: 'r/SteamOnSale', subscribers: 1100000, focus: 'Steam sale announcements', genres: ['all'], type: 'platform', postingTips: 'Post during Steam sales. Include discount percentage.', restrictive: false },
  { name: 'r/NintendoSwitch', subscribers: 4200000, focus: 'Nintendo Switch games and news', genres: ['all'], type: 'platform', postingTips: 'If game is on Switch, post release date and trailers here.', restrictive: false },
  { name: 'r/XboxOne', subscribers: 2000000, focus: 'Xbox gaming discussion', genres: ['all'], type: 'platform', postingTips: 'Trailers and announcements welcome if tagged correctly.', restrictive: false },
  { name: 'r/PS5', subscribers: 900000, focus: 'PlayStation 5 gaming', genres: ['all'], type: 'platform', postingTips: 'PS5 releases get good traction here.', restrictive: false },
  { name: 'r/StrategyGames', subscribers: 170000, focus: 'Strategy game discussion', genres: ['strategy', 'rts', 'turn-based'], type: 'genre', postingTips: 'Depth and complexity posts do well. Discuss design choices.', restrictive: false },
  { name: 'r/4Xgaming', subscribers: 65000, focus: 'eXplore, eXpand, eXploit, eXterminate games', genres: ['strategy', '4x'], type: 'genre', postingTips: 'Niche but engaged. Show grand scale and depth.', restrictive: false },
  { name: 'r/truegaming', subscribers: 890000, focus: 'Thoughtful gaming analysis', genres: ['all'], type: 'general', postingTips: 'Discussion posts only. No self-promotion. But can inspire organic coverage.', restrictive: true },
  { name: 'r/HorrorGaming', subscribers: 360000, focus: 'Horror games discussion', genres: ['horror'], type: 'genre', postingTips: 'Atmosphere and tension gifs do very well. Highlight scares.', restrictive: false },
  { name: 'r/SurvivalGames', subscribers: 240000, focus: 'Survival game news and discussion', genres: ['survival', 'crafting'], type: 'genre', postingTips: 'Show base building and progression. Multiplayer a plus.', restrictive: false },
  { name: 'r/CityBuilders', subscribers: 140000, focus: 'City building games', genres: ['city-builder', 'strategy'], type: 'genre', postingTips: 'Show city growth screenshots and time-lapse builds.', restrictive: false },
  { name: 'r/ManagementGames', subscribers: 48000, focus: 'Management and sim games', genres: ['management', 'simulation'], type: 'genre', postingTips: 'Very welcoming to new titles in the genre.', restrictive: false },
  { name: 'r/PuzzleGames', subscribers: 90000, focus: 'Puzzle game discussion and recommendations', genres: ['puzzle'], type: 'genre', postingTips: 'Show off one clever mechanic rather than full trailer.', restrictive: false },
  { name: 'r/Metroidvania', subscribers: 200000, focus: 'Metroidvania games', genres: ['metroidvania', 'action'], type: 'genre', postingTips: 'Show map scope and abilities. Community passionate about the genre.', restrictive: false },
  { name: 'r/rpg', subscribers: 1200000, focus: 'RPG games discussion', genres: ['rpg', 'jrpg', 'action-rpg'], type: 'genre', postingTips: 'Lore and character depth posts work well.', restrictive: false },
  { name: 'r/JRPG', subscribers: 480000, focus: 'Japanese RPG games', genres: ['jrpg', 'rpg'], type: 'genre', postingTips: 'Pixel art and anime art styles very welcome.', restrictive: false },
  { name: 'r/SimRacing', subscribers: 380000, focus: 'Sim racing games and hardware', genres: ['racing', 'simulation'], type: 'genre', postingTips: 'Physics and realism discussion important to this audience.', restrictive: false },
  { name: 'r/sportsball', subscribers: 12000, focus: 'Sports management games', genres: ['sports', 'management'], type: 'genre', postingTips: 'Niche community, very receptive to new sports sims.', restrictive: false },
  { name: 'r/GrandStrategy', subscribers: 140000, focus: 'Grand strategy games (Paradox style)', genres: ['strategy', 'grand-strategy'], type: 'genre', postingTips: 'Show map, nations, and diplomatic complexity.', restrictive: false },
  { name: 'r/VisualNovels', subscribers: 290000, focus: 'Visual novel games', genres: ['visual-novel'], type: 'genre', postingTips: 'Art style and character design drive interest here.', restrictive: false },
  { name: 'r/VRGaming', subscribers: 350000, focus: 'Virtual reality gaming', genres: ['vr'], type: 'platform', postingTips: 'VR exclusives or strong VR support posts perform well.', restrictive: false },
  { name: 'r/gametrailers', subscribers: 180000, focus: 'Game trailer showcases', genres: ['all'], type: 'general', postingTips: 'Good place to post trailers directly. Quality threshold applies.', restrictive: false },
  { name: 'r/indiegameswap', subscribers: 62000, focus: 'Indie game deals and keys', genres: ['indie'], type: 'community', postingTips: 'Great for key giveaways and review code offers.', restrictive: false },
  { name: 'r/Fighters', subscribers: 360000, focus: 'Fighting games discussion', genres: ['fighting'], type: 'genre', postingTips: 'Combo system and netcode are top concerns for this audience.', restrictive: false },
  { name: 'r/shooters', subscribers: 55000, focus: 'Shooter games', genres: ['shooter', 'fps'], type: 'genre', postingTips: 'Feel, gunplay gifs, and multiplayer focus important.', restrictive: false },
  { name: 'r/platformer', subscribers: 90000, focus: 'Platformer games', genres: ['platformer'], type: 'genre', postingTips: 'Movement feel and level design screenshots work well.', restrictive: false },
  { name: 'r/CozyGamers', subscribers: 410000, focus: 'Relaxing, cozy games', genres: ['cozy', 'casual', 'simulation'], type: 'community', postingTips: 'Aesthetics, farming, and wholesome gameplay resonate here.', restrictive: false },
  { name: 'r/lostarkgame', subscribers: 390000, focus: 'Lost Ark MMORPG', genres: ['mmorpg'], type: 'community', postingTips: 'Only relevant for MMORPGs with similar content.', restrictive: true },
  { name: 'r/devblogs', subscribers: 36000, focus: 'Developer blog posts and updates', genres: ['indie', 'all'], type: 'dev', postingTips: 'Share dev diaries and behind-the-scenes here.', restrictive: false },
  { name: 'r/gamedesign', subscribers: 360000, focus: 'Game design discussion', genres: ['all'], type: 'dev', postingTips: 'Design explainer posts (not promotion) can organically build awareness.', restrictive: true },
]

const GENRE_OPTIONS = [
  'all', 'indie', 'roguelike', 'roguelite', 'strategy', 'rts', 'turn-based', '4x', 'grand-strategy',
  'horror', 'survival', 'crafting', 'city-builder', 'management', 'simulation', 'puzzle', 'metroidvania',
  'action', 'rpg', 'jrpg', 'action-rpg', 'visual-novel', 'platformer', 'shooter', 'fps', 'fighting',
  'racing', 'sports', 'cozy', 'casual', 'vr', 'mmorpg',
]

// ─── Types ───────────────────────────────────────────────────────────────────

interface TrendResult {
  url: string
  title: string
  content: string
  score: number
  published_date?: string
}

interface Caption {
  text: string
  angle: string
  char_count: number
}

interface Game { id: string; name: string; client_id: string }
interface Keyword { id: string; keyword: string; keyword_type: string; game_id: string | null; game?: { name: string } | null }

// ─── Tabs ────────────────────────────────────────────────────────────────────

const TABS = ['trend', 'captions', 'reddit', 'keywords'] as const
type Tab = typeof TABS[number]

const TAB_LABELS: Record<Tab, string> = {
  trend: 'Trend Watch',
  captions: 'Caption Advisor',
  reddit: 'Reddit Finder',
  keywords: 'Keyword Explorer',
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function SocialToolsPage() {
  const { hasAccess, loading: authLoading } = useAuth()
  const canView = hasAccess('analytics', 'view')
  const supabase = createClientComponentClient()

  const [activeTab, setActiveTab] = useState<Tab>('trend')

  // ─── Trend Watch state ────────────────────────────────────────────────────
  const [trendQuery, setTrendQuery] = useState('')
  const [trendDays, setTrendDays] = useState(7)
  const [trendResults, setTrendResults] = useState<TrendResult[]>([])
  const [trendAnswer, setTrendAnswer] = useState<string | null>(null)
  const [trendLoading, setTrendLoading] = useState(false)
  const [trendError, setTrendError] = useState<string | null>(null)

  const PRESET_QUERIES = [
    'trending indie games this week',
    'viral gaming news',
    'new game announcements this week',
    'Steam trending games',
    'most talked about games right now',
  ]

  const handleTrendSearch = async (q?: string) => {
    const query = q || trendQuery
    if (!query.trim()) return
    setTrendLoading(true)
    setTrendError(null)
    setTrendResults([])
    setTrendAnswer(null)
    try {
      const res = await fetch('/api/trend-watch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, days_back: trendDays }),
      })
      const json = await res.json()
      if (res.ok) {
        setTrendResults(json.results || [])
        setTrendAnswer(json.answer || null)
      } else {
        setTrendError(json.error || 'Search failed')
      }
    } catch {
      setTrendError('Network error')
    }
    setTrendLoading(false)
  }

  // ─── Caption Advisor state ────────────────────────────────────────────────
  const [capGame, setCapGame] = useState('')
  const [capPlatform, setCapPlatform] = useState('twitter')
  const [capObjective, setCapObjective] = useState('launch')
  const [capTone, setCapTone] = useState('engaging')
  const [capContext, setCapContext] = useState('')
  const [captions, setCaptions] = useState<Caption[]>([])
  const [capBestTime, setCapBestTime] = useState<string | null>(null)
  const [capHashtagTip, setCapHashtagTip] = useState<string | null>(null)
  const [capLoading, setCapLoading] = useState(false)
  const [capError, setCapError] = useState<string | null>(null)
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)

  const [games, setGames] = useState<Game[]>([])
  useEffect(() => {
    if (canView) {
      supabase.from('games').select('id, name, client_id').order('name').then(({ data }) => {
        if (data) setGames(data)
      })
    }
  }, [canView, supabase])

  const handleGenerateCaptions = async () => {
    if (!capGame.trim()) { setCapError('Enter a game name'); return }
    setCapLoading(true)
    setCapError(null)
    setCaptions([])
    try {
      const res = await fetch('/api/social-caption', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          game_name: capGame,
          platform: capPlatform,
          objective: capObjective,
          tone: capTone,
          extra_context: capContext || undefined,
        }),
      })
      const json = await res.json()
      if (res.ok) {
        setCaptions(json.captions || [])
        setCapBestTime(json.best_time || null)
        setCapHashtagTip(json.hashtag_tip || null)
      } else {
        setCapError(json.error || 'Generation failed')
      }
    } catch {
      setCapError('Network error')
    }
    setCapLoading(false)
  }

  const copyCaption = (text: string, idx: number) => {
    navigator.clipboard.writeText(text)
    setCopiedIdx(idx)
    setTimeout(() => setCopiedIdx(null), 2000)
  }

  // ─── Reddit Finder state ──────────────────────────────────────────────────
  const [selectedGenres, setSelectedGenres] = useState<string[]>([])
  const [showRestrictive, setShowRestrictive] = useState(false)
  const [redditMinSubs, setRedditMinSubs] = useState(0)

  const toggleGenre = (g: string) => {
    setSelectedGenres(prev =>
      prev.includes(g) ? prev.filter(x => x !== g) : [...prev, g]
    )
  }

  const filteredSubreddits = SUBREDDITS
    .filter(s => {
      if (!showRestrictive && s.restrictive) return false
      if (redditMinSubs > 0 && s.subscribers < redditMinSubs) return false
      if (selectedGenres.length === 0) return true
      return selectedGenres.some(g => s.genres.includes(g) || s.genres.includes('all'))
    })
    .sort((a, b) => b.subscribers - a.subscribers)

  // ─── Keyword Explorer state ───────────────────────────────────────────────
  const [keywords, setKeywords] = useState<Keyword[]>([])
  const [kwStats, setKwStats] = useState<Record<string, number>>({})
  const [kwFilter, setKwFilter] = useState('')
  const [kwGameFilter, setKwGameFilter] = useState('')
  const [kwLoading, setKwLoading] = useState(false)

  const fetchKeywords = useCallback(async () => {
    if (!canView) return
    setKwLoading(true)
    try {
      const { data } = await supabase
        .from('coverage_keywords')
        .select('*, game:games(name)')
        .order('keyword')
      if (data) setKeywords(data)

      // Count coverage items per keyword (approximate via source_metadata)
      const { data: stats } = await supabase
        .from('coverage_items')
        .select('source_metadata')
        .limit(5000)

      const counts: Record<string, number> = {}
      for (const row of (stats || [])) {
        const meta = row.source_metadata as Record<string, unknown> | null
        const kw = meta?.matched_keyword as string | undefined
        if (kw) counts[kw] = (counts[kw] || 0) + 1
      }
      setKwStats(counts)
    } catch (err) {
      console.error('Failed to fetch keywords:', err)
    }
    setKwLoading(false)
  }, [canView, supabase])

  useEffect(() => {
    if (activeTab === 'keywords') fetchKeywords()
  }, [activeTab, fetchKeywords])

  const filteredKeywords = keywords.filter(k => {
    if (kwFilter && !k.keyword.toLowerCase().includes(kwFilter.toLowerCase())) return false
    if (kwGameFilter && k.game_id !== kwGameFilter) return false
    return true
  })

  // ─── Auth ─────────────────────────────────────────────────────────────────

  if (authLoading) {
    return (
      <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
        <Sidebar />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p>Loading...</p>
        </div>
      </div>
    )
  }

  if (!canView) {
    return (
      <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
        <Sidebar />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1rem' }}>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 600, color: '#1f2937' }}>Access Denied</h2>
        </div>
      </div>
    )
  }

  // ─── Tab content ──────────────────────────────────────────────────────────

  const renderTrendTab = () => (
    <div>
      <div style={{ marginBottom: '20px' }}>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
          <input
            type="text"
            value={trendQuery}
            onChange={e => setTrendQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleTrendSearch()}
            placeholder="e.g. trending indie games, city builder news, steam next fest..."
            style={{ flex: 1, padding: '10px 14px', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '14px' }}
          />
          <select
            value={trendDays}
            onChange={e => setTrendDays(Number(e.target.value))}
            style={{ padding: '10px 12px', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '14px', backgroundColor: 'white' }}
          >
            <option value={1}>Last 24h</option>
            <option value={3}>Last 3 days</option>
            <option value={7}>Last week</option>
            <option value={14}>Last 2 weeks</option>
            <option value={30}>Last month</option>
          </select>
          <button
            onClick={() => handleTrendSearch()}
            disabled={trendLoading || !trendQuery.trim()}
            style={{
              padding: '10px 20px', backgroundColor: trendLoading ? '#f1f5f9' : '#b8232f',
              color: trendLoading ? '#64748b' : 'white', border: 'none', borderRadius: '8px',
              fontSize: '14px', fontWeight: 500, cursor: trendLoading || !trendQuery.trim() ? 'not-allowed' : 'pointer',
              opacity: trendLoading || !trendQuery.trim() ? 0.7 : 1,
            }}
          >
            {trendLoading ? 'Searching...' : 'Search'}
          </button>
        </div>

        {/* Preset queries */}
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {PRESET_QUERIES.map(q => (
            <button
              key={q}
              onClick={() => { setTrendQuery(q); handleTrendSearch(q) }}
              style={{
                padding: '5px 12px', backgroundColor: 'white', color: '#475569',
                border: '1px solid #e2e8f0', borderRadius: '20px', fontSize: '12px',
                cursor: 'pointer',
              }}
            >
              {q}
            </button>
          ))}
        </div>
      </div>

      {trendError && (
        <div style={{ padding: '10px 14px', backgroundColor: '#fee2e2', color: '#dc2626', borderRadius: '8px', marginBottom: '16px', fontSize: '13px' }}>
          {trendError}
        </div>
      )}

      {trendAnswer && (
        <div style={{ padding: '14px 18px', backgroundColor: '#f0fdf4', border: '1px solid #86efac', borderRadius: '10px', marginBottom: '16px', fontSize: '14px', color: '#15803d', lineHeight: 1.6 }}>
          <strong style={{ display: 'block', marginBottom: '4px', color: '#166534' }}>AI Summary</strong>
          {trendAnswer}
        </div>
      )}

      {trendResults.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {trendResults.map((r, i) => (
            <div key={i} style={{ backgroundColor: 'white', borderRadius: '10px', padding: '14px 16px', border: '1px solid #e2e8f0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
                <div style={{ flex: 1 }}>
                  <a href={r.url} target="_blank" rel="noopener noreferrer" style={{ fontWeight: 600, fontSize: '14px', color: '#1e293b', textDecoration: 'none' }}>
                    {r.title || r.url}
                  </a>
                  <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>
                    {new URL(r.url).hostname.replace('www.', '')}
                    {r.published_date && ` · ${r.published_date.split('T')[0]}`}
                  </div>
                  {r.content && (
                    <div style={{ fontSize: '13px', color: '#64748b', marginTop: '6px', lineHeight: 1.5 }}>
                      {r.content.substring(0, 250)}{r.content.length > 250 ? '...' : ''}
                    </div>
                  )}
                </div>
                <div style={{
                  fontSize: '12px', fontWeight: 600, padding: '2px 8px', borderRadius: '6px',
                  backgroundColor: r.score > 0.7 ? '#dcfce7' : r.score > 0.4 ? '#fef9c3' : '#f3f4f6',
                  color: r.score > 0.7 ? '#166534' : r.score > 0.4 ? '#92400e' : '#64748b',
                  flexShrink: 0,
                }}>
                  {(r.score * 100).toFixed(0)}%
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {!trendLoading && trendResults.length === 0 && !trendError && trendQuery && (
        <div style={{ padding: '40px', textAlign: 'center', color: '#94a3b8' }}>No results found.</div>
      )}

      {!trendQuery && trendResults.length === 0 && (
        <div style={{ padding: '60px', textAlign: 'center', color: '#94a3b8' }}>
          <div style={{ fontSize: '36px', marginBottom: '12px' }}>📡</div>
          <div style={{ fontWeight: 600, fontSize: '16px', marginBottom: '6px', color: '#64748b' }}>Search for gaming trends</div>
          <div style={{ fontSize: '13px' }}>Use Tavily to find what&apos;s trending in gaming right now. Try a preset or enter your own query.</div>
        </div>
      )}
    </div>
  )

  const renderCaptionsTab = () => (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' }}>
        <div>
          <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>Game Name *</label>
          <input
            type="text"
            value={capGame}
            onChange={e => setCapGame(e.target.value)}
            placeholder="e.g. Dark Pals"
            list="game-list"
            style={{ width: '100%', padding: '9px 12px', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '14px', boxSizing: 'border-box' }}
          />
          <datalist id="game-list">
            {games.map(g => <option key={g.id} value={g.name} />)}
          </datalist>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>Platform</label>
          <select value={capPlatform} onChange={e => setCapPlatform(e.target.value)} style={{ width: '100%', padding: '9px 12px', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '14px', backgroundColor: 'white', boxSizing: 'border-box' }}>
            <option value="twitter">Twitter/X</option>
            <option value="instagram">Instagram</option>
            <option value="tiktok">TikTok</option>
            <option value="reddit">Reddit</option>
            <option value="facebook">Facebook</option>
            <option value="linkedin">LinkedIn</option>
          </select>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>Objective</label>
          <select value={capObjective} onChange={e => setCapObjective(e.target.value)} style={{ width: '100%', padding: '9px 12px', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '14px', backgroundColor: 'white', boxSizing: 'border-box' }}>
            <option value="launch">Game launch</option>
            <option value="sale">Sale / discount</option>
            <option value="update">Update / patch</option>
            <option value="announcement">Announcement / reveal</option>
            <option value="wishlist">Wishlist campaign</option>
            <option value="review">Celebrating reviews</option>
            <option value="demo">Demo release</option>
            <option value="dlc">DLC / expansion</option>
          </select>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>Tone</label>
          <select value={capTone} onChange={e => setCapTone(e.target.value)} style={{ width: '100%', padding: '9px 12px', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '14px', backgroundColor: 'white', boxSizing: 'border-box' }}>
            <option value="engaging">Engaging & authentic</option>
            <option value="hype">Hype & excitement</option>
            <option value="warm">Warm & community-focused</option>
            <option value="professional">Professional</option>
            <option value="playful">Playful & fun</option>
            <option value="mysterious">Mysterious / teaser</option>
          </select>
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>Extra context (optional)</label>
          <input
            type="text"
            value={capContext}
            onChange={e => setCapContext(e.target.value)}
            placeholder="e.g. roguelite dungeon crawler, 40% off, just hit 10k wishlists..."
            style={{ width: '100%', padding: '9px 12px', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '14px', boxSizing: 'border-box' }}
          />
        </div>
      </div>

      <button
        onClick={handleGenerateCaptions}
        disabled={capLoading || !capGame.trim()}
        style={{
          padding: '10px 24px', backgroundColor: capLoading ? '#f1f5f9' : '#b8232f',
          color: capLoading ? '#64748b' : 'white', border: 'none', borderRadius: '8px',
          fontSize: '14px', fontWeight: 500, cursor: capLoading || !capGame.trim() ? 'not-allowed' : 'pointer',
          opacity: capLoading || !capGame.trim() ? 0.7 : 1, marginBottom: '16px',
        }}
      >
        {capLoading ? 'Generating...' : 'Generate Captions'}
      </button>

      {capError && (
        <div style={{ padding: '10px 14px', backgroundColor: '#fee2e2', color: '#dc2626', borderRadius: '8px', marginBottom: '16px', fontSize: '13px' }}>
          {capError}
        </div>
      )}

      {captions.length > 0 && (
        <>
          {(capBestTime || capHashtagTip) && (
            <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap' }}>
              {capBestTime && (
                <div style={{ padding: '8px 14px', backgroundColor: '#f0fdf4', border: '1px solid #86efac', borderRadius: '8px', fontSize: '13px', color: '#15803d' }}>
                  🕐 <strong>Best time:</strong> {capBestTime}
                </div>
              )}
              {capHashtagTip && (
                <div style={{ padding: '8px 14px', backgroundColor: '#eff6ff', border: '1px solid #93c5fd', borderRadius: '8px', fontSize: '13px', color: '#1e40af' }}>
                  # <strong>Hashtag tip:</strong> {capHashtagTip}
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {captions.map((cap, i) => (
              <div key={i} style={{ backgroundColor: 'white', borderRadius: '10px', padding: '16px', border: '1px solid #e2e8f0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
                  <div style={{ fontSize: '12px', color: '#64748b', fontWeight: 500 }}>
                    Variation {i + 1} — <span style={{ color: '#94a3b8' }}>{cap.angle}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '11px', color: cap.char_count > (capPlatform === 'twitter' ? 280 : 2200) ? '#dc2626' : '#94a3b8' }}>
                      {cap.char_count ?? cap.text?.length ?? 0} chars
                    </span>
                    <button
                      onClick={() => copyCaption(cap.text, i)}
                      style={{
                        padding: '4px 10px', backgroundColor: copiedIdx === i ? '#dcfce7' : 'white',
                        color: copiedIdx === i ? '#166534' : '#475569',
                        border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '12px', cursor: 'pointer',
                      }}
                    >
                      {copiedIdx === i ? '✓ Copied' : 'Copy'}
                    </button>
                  </div>
                </div>
                <div style={{ fontSize: '14px', color: '#1e293b', whiteSpace: 'pre-wrap', lineHeight: 1.6, fontFamily: 'inherit' }}>
                  {cap.text}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {!capLoading && captions.length === 0 && !capError && (
        <div style={{ padding: '60px', textAlign: 'center', color: '#94a3b8' }}>
          <div style={{ fontSize: '36px', marginBottom: '12px' }}>✍️</div>
          <div style={{ fontWeight: 600, fontSize: '16px', marginBottom: '6px', color: '#64748b' }}>AI Caption Generator</div>
          <div style={{ fontSize: '13px' }}>Generate platform-optimized social media captions for your game using Gemini AI. Includes timing and hashtag recommendations.</div>
        </div>
      )}
    </div>
  )

  const renderRedditTab = () => (
    <div>
      {/* Filters */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
        <div>
          <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: '#374151', marginBottom: '3px' }}>Min subscribers</label>
          <select
            value={redditMinSubs}
            onChange={e => setRedditMinSubs(Number(e.target.value))}
            style={{ padding: '7px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px', backgroundColor: 'white' }}
          >
            <option value={0}>Any size</option>
            <option value={10000}>10K+</option>
            <option value={50000}>50K+</option>
            <option value={100000}>100K+</option>
            <option value={500000}>500K+</option>
            <option value={1000000}>1M+</option>
          </select>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '13px', color: '#374151', marginTop: '16px' }}>
          <input type="checkbox" checked={showRestrictive} onChange={e => setShowRestrictive(e.target.checked)} />
          Include restrictive subs (self-promo rules)
        </label>
        <div style={{ marginLeft: 'auto', marginTop: '14px', fontSize: '13px', color: '#94a3b8' }}>
          {filteredSubreddits.length} subreddits matched
        </div>
      </div>

      {/* Genre filter chips */}
      <div style={{ marginBottom: '16px' }}>
        <div style={{ fontSize: '12px', fontWeight: 500, color: '#374151', marginBottom: '6px' }}>Filter by genre:</div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {GENRE_OPTIONS.map(g => (
            <button
              key={g}
              onClick={() => toggleGenre(g)}
              style={{
                padding: '4px 10px', borderRadius: '20px', fontSize: '12px', cursor: 'pointer', fontWeight: 500,
                backgroundColor: selectedGenres.includes(g) ? '#b8232f' : 'white',
                color: selectedGenres.includes(g) ? 'white' : '#475569',
                border: selectedGenres.includes(g) ? '1px solid #b8232f' : '1px solid #e2e8f0',
              }}
            >
              {g}
            </button>
          ))}
        </div>
        {selectedGenres.length > 0 && (
          <button onClick={() => setSelectedGenres([])} style={{ marginTop: '6px', fontSize: '12px', color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer' }}>
            Clear filter
          </button>
        )}
      </div>

      {/* Results */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {filteredSubreddits.map(s => (
          <div key={s.name} style={{ backgroundColor: 'white', borderRadius: '10px', padding: '14px 16px', border: '1px solid #e2e8f0', display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
                <a href={`https://reddit.com/${s.name}`} target="_blank" rel="noopener noreferrer" style={{ fontWeight: 700, fontSize: '15px', color: '#ff4500', textDecoration: 'none' }}>
                  {s.name}
                </a>
                {s.restrictive && (
                  <span style={{ padding: '2px 6px', backgroundColor: '#fef9c3', color: '#92400e', borderRadius: '4px', fontSize: '10px', fontWeight: 500 }}>
                    self-promo rules
                  </span>
                )}
                <span style={{
                  padding: '2px 6px', borderRadius: '4px', fontSize: '10px', fontWeight: 500,
                  backgroundColor: s.type === 'genre' ? '#eff6ff' : s.type === 'dev' ? '#f0fdf4' : s.type === 'platform' ? '#faf5ff' : '#f8fafc',
                  color: s.type === 'genre' ? '#1e40af' : s.type === 'dev' ? '#166534' : s.type === 'platform' ? '#6b21a8' : '#475569',
                }}>
                  {s.type}
                </span>
              </div>
              <div style={{ fontSize: '13px', color: '#475569', marginBottom: '4px' }}>{s.focus}</div>
              <div style={{ fontSize: '12px', color: '#64748b', fontStyle: 'italic' }}>
                💡 {s.postingTips}
              </div>
              <div style={{ display: 'flex', gap: '8px', marginTop: '4px', flexWrap: 'wrap' }}>
                {s.genres.slice(0, 5).map(g => (
                  <span key={g} style={{ fontSize: '10px', color: '#94a3b8', padding: '1px 6px', backgroundColor: '#f8fafc', borderRadius: '4px', border: '1px solid #e2e8f0' }}>
                    {g}
                  </span>
                ))}
              </div>
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <div style={{ fontSize: '16px', fontWeight: 700, color: '#1e293b' }}>
                {s.subscribers >= 1000000 ? `${(s.subscribers / 1000000).toFixed(1)}M` : s.subscribers >= 1000 ? `${(s.subscribers / 1000).toFixed(0)}K` : s.subscribers}
              </div>
              <div style={{ fontSize: '11px', color: '#94a3b8' }}>members</div>
            </div>
          </div>
        ))}
        {filteredSubreddits.length === 0 && (
          <div style={{ padding: '40px', textAlign: 'center', color: '#94a3b8' }}>No subreddits match your filters.</div>
        )}
      </div>
    </div>
  )

  const renderKeywordsTab = () => (
    <div>
      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <input
          type="text"
          value={kwFilter}
          onChange={e => setKwFilter(e.target.value)}
          placeholder="Search keywords..."
          style={{ padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '14px', width: '240px' }}
        />
        <select
          value={kwGameFilter}
          onChange={e => setKwGameFilter(e.target.value)}
          style={{ padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '14px', backgroundColor: 'white' }}
        >
          <option value="">All games</option>
          {games.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <button onClick={fetchKeywords} disabled={kwLoading} style={{ padding: '8px 14px', backgroundColor: 'white', color: '#475569', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '13px', cursor: 'pointer' }}>
          {kwLoading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      <div style={{ backgroundColor: 'white', borderRadius: '12px', border: '1px solid #e2e8f0', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ backgroundColor: '#f8fafc' }}>
              <th style={{ padding: '10px 16px', textAlign: 'left', color: '#64748b', fontWeight: 600 }}>Keyword</th>
              <th style={{ padding: '10px 12px', textAlign: 'left', color: '#64748b', fontWeight: 600 }}>Type</th>
              <th style={{ padding: '10px 12px', textAlign: 'left', color: '#64748b', fontWeight: 600 }}>Game</th>
              <th style={{ padding: '10px 12px', textAlign: 'center', color: '#64748b', fontWeight: 600 }}>Coverage Hits</th>
            </tr>
          </thead>
          <tbody>
            {filteredKeywords.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ padding: '32px', textAlign: 'center', color: '#94a3b8' }}>
                  {kwLoading ? 'Loading keywords...' : 'No keywords found'}
                </td>
              </tr>
            ) : (
              filteredKeywords.map(k => {
                const hits = kwStats[k.keyword] || 0
                return (
                  <tr key={k.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '10px 16px', fontWeight: 500, color: '#1e293b' }}>{k.keyword}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <span style={{
                        padding: '2px 8px', borderRadius: '9999px', fontSize: '11px', fontWeight: 500,
                        backgroundColor: k.keyword_type === 'whitelist' ? '#dcfce7' : '#fee2e2',
                        color: k.keyword_type === 'whitelist' ? '#166534' : '#dc2626',
                      }}>
                        {k.keyword_type}
                      </span>
                    </td>
                    <td style={{ padding: '10px 12px', color: '#64748b', fontSize: '12px' }}>
                      {(k.game as { name?: string } | null)?.name || '—'}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                        <div style={{ width: '60px', height: '6px', backgroundColor: '#f1f5f9', borderRadius: '3px', overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${Math.min(100, hits * 5)}%`, backgroundColor: hits > 10 ? '#059669' : hits > 3 ? '#d97706' : '#94a3b8', borderRadius: '3px' }} />
                        </div>
                        <span style={{ fontSize: '12px', fontWeight: 600, color: hits > 0 ? '#1e293b' : '#94a3b8', minWidth: '20px' }}>
                          {hits || '—'}
                        </span>
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: '12px', fontSize: '12px', color: '#94a3b8' }}>
        Coverage hits are estimated from matched_keyword metadata on coverage_items. Exact counts may be higher if metadata is not set.
      </div>
    </div>
  )

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
      <Sidebar />

      <div style={{ flex: 1, padding: '32px', overflow: 'auto' }}>
        <div style={{ maxWidth: '1100px', margin: '0 auto' }}>

          {/* Header */}
          <div style={{ marginBottom: '24px' }}>
            <h1 style={{ fontSize: '28px', fontWeight: 700, color: '#1e293b', margin: 0 }}>Social Tools</h1>
            <p style={{ fontSize: '14px', color: '#64748b', margin: '4px 0 0 0' }}>
              Trend monitoring, caption generation, Reddit discovery, and keyword analysis
            </p>
          </div>

          {/* Tab bar */}
          <div style={{ display: 'flex', gap: '0', marginBottom: '24px', borderBottom: '2px solid #e2e8f0' }}>
            {TABS.map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: '10px 20px', fontSize: '14px', fontWeight: activeTab === tab ? 600 : 500,
                  color: activeTab === tab ? '#b8232f' : '#64748b',
                  borderBottom: activeTab === tab ? '2px solid #b8232f' : '2px solid transparent',
                  marginBottom: '-2px', background: 'none', border: 'none',
                  borderBottomStyle: 'solid',
                  cursor: 'pointer',
                }}
              >
                {TAB_LABELS[tab]}
              </button>
            ))}
          </div>

          {activeTab === 'trend' && renderTrendTab()}
          {activeTab === 'captions' && renderCaptionsTab()}
          {activeTab === 'reddit' && renderRedditTab()}
          {activeTab === 'keywords' && renderKeywordsTab()}
        </div>
      </div>
    </div>
  )
}
