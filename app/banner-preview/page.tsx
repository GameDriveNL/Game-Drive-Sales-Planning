'use client'

import { useState, useRef, useCallback } from 'react'
import { Sidebar } from '../components/Sidebar'

// ─── Platform definitions ─────────────────────────────────────────────────────

const PLATFORMS = [
  { id: 'steam', label: 'Steam' },
  { id: 'playstation', label: 'PlayStation' },
  { id: 'xbox', label: 'Xbox' },
  { id: 'nintendo', label: 'Nintendo' },
] as const

type PlatformId = typeof PLATFORMS[number]['id']

// ─── Steam Mockup ─────────────────────────────────────────────────────────────

function SteamMockup({ imgSrc }: { imgSrc: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>

      {/* Store page header */}
      <div>
        <h3 style={{ fontSize: '13px', fontWeight: 600, color: '#64748b', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Steam Store Page — Header Capsule (460×215)
        </h3>
        <div style={{ backgroundColor: '#1b2838', borderRadius: '8px', padding: '20px', display: 'flex', gap: '20px', alignItems: 'flex-start' }}>
          <div style={{ width: '292px', flexShrink: 0 }}>
            <img src={imgSrc} alt="Game capsule" style={{ width: '292px', height: '136px', objectFit: 'cover', borderRadius: '3px', display: 'block' }} />
            <div style={{ marginTop: '8px', fontSize: '11px', color: '#66c0f4', fontFamily: 'Arial, sans-serif' }}>Your Game Title</div>
            <div style={{ marginTop: '4px', fontSize: '10px', color: '#c6d4df', fontFamily: 'Arial, sans-serif' }}>Early Access · Action, RPG</div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '20px', fontWeight: 700, color: '#c6d4df', fontFamily: 'Arial, sans-serif', marginBottom: '8px' }}>Your Game Title</div>
            <div style={{ fontSize: '11px', color: '#8f98a0', fontFamily: 'Arial, sans-serif', lineHeight: 1.6, marginBottom: '12px' }}>
              An epic adventure spanning three continents. Fight monsters, solve puzzles, and uncover the mystery of the ancient realm.
            </div>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
              {['Action', 'RPG', 'Open World'].map(tag => (
                <span key={tag} style={{ fontSize: '10px', color: '#66c0f4', border: '1px solid #2a475e', borderRadius: '2px', padding: '2px 6px', fontFamily: 'Arial, sans-serif' }}>{tag}</span>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div style={{ fontSize: '20px', fontWeight: 700, color: '#beee11', fontFamily: 'Arial, sans-serif' }}>€24.99</div>
              <div style={{ backgroundColor: '#4c6b22', color: '#a4d007', fontSize: '14px', fontWeight: 700, padding: '4px 8px', borderRadius: '2px', fontFamily: 'Arial, sans-serif' }}>-40%</div>
            </div>
          </div>
        </div>
      </div>

      {/* Search result capsule */}
      <div>
        <h3 style={{ fontSize: '13px', fontWeight: 600, color: '#64748b', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Steam Search Result Capsule (231×87)
        </h3>
        <div style={{ backgroundColor: '#1b2838', borderRadius: '8px', padding: '20px' }}>
          {[1, 2, 3].map(i => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '6px 0', borderBottom: '1px solid #2a475e', opacity: i === 1 ? 1 : 0.4 }}>
              <img src={i === 1 ? imgSrc : undefined} alt="" style={{ width: '231px', height: '87px', objectFit: 'cover', borderRadius: '2px', flexShrink: 0, backgroundColor: i !== 1 ? '#2a475e' : undefined }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '13px', color: i === 1 ? '#c6d4df' : '#8f98a0', fontFamily: 'Arial, sans-serif', marginBottom: '4px' }}>
                  {i === 1 ? 'Your Game Title' : `Other Game ${i}`}
                </div>
                <div style={{ display: 'flex', gap: '6px' }}>
                  {['Action', 'RPG'].map(t => <span key={t} style={{ fontSize: '9px', color: '#66c0f4', border: '1px solid #2a475e', borderRadius: '2px', padding: '1px 4px', fontFamily: 'Arial, sans-serif' }}>{t}</span>)}
                </div>
              </div>
              <div style={{ fontSize: '13px', fontWeight: 700, color: i === 1 ? '#beee11' : '#8f98a0', fontFamily: 'Arial, sans-serif', flexShrink: 0 }}>
                {i === 1 ? '€24.99' : '—'}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Library */}
      <div>
        <h3 style={{ fontSize: '13px', fontWeight: 600, color: '#64748b', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Steam Library Header (920×430)
        </h3>
        <div style={{ backgroundColor: '#1b2838', borderRadius: '8px', overflow: 'hidden' }}>
          <img src={imgSrc} alt="Library header" style={{ width: '100%', height: '200px', objectFit: 'cover', display: 'block' }} />
          <div style={{ padding: '12px 20px', display: 'flex', gap: '12px', alignItems: 'center' }}>
            <div style={{ fontSize: '22px', fontWeight: 700, color: '#c6d4df', fontFamily: 'Arial, sans-serif', flex: 1 }}>Your Game Title</div>
            <div style={{ backgroundColor: '#4c6b22', color: '#a4d007', fontSize: '11px', fontWeight: 700, padding: '6px 16px', borderRadius: '2px', fontFamily: 'Arial, sans-serif', cursor: 'pointer' }}>PLAY</div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── PlayStation Mockup ───────────────────────────────────────────────────────

function PlayStationMockup({ imgSrc }: { imgSrc: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
      <div>
        <h3 style={{ fontSize: '13px', fontWeight: 600, color: '#64748b', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          PlayStation Store — Featured Banner
        </h3>
        <div style={{ backgroundColor: '#00169b', borderRadius: '8px', overflow: 'hidden' }}>
          <div style={{ position: 'relative' }}>
            <img src={imgSrc} alt="PS Store banner" style={{ width: '100%', height: '220px', objectFit: 'cover', display: 'block', opacity: 0.85 }} />
            <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'linear-gradient(transparent, rgba(0,0,0,0.7))', padding: '24px 24px 20px' }}>
              <div style={{ fontSize: '24px', fontWeight: 700, color: 'white', fontFamily: 'Arial, sans-serif', textShadow: '0 1px 4px rgba(0,0,0,0.5)' }}>Your Game Title</div>
              <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.8)', fontFamily: 'Arial, sans-serif', marginTop: '4px' }}>PS5 · PS4 · From €24.99</div>
            </div>
          </div>
          <div style={{ padding: '12px 20px', display: 'flex', gap: '10px' }}>
            {['Featured', 'New Releases', 'Coming Soon', 'Deals'].map(t => (
              <span key={t} style={{ fontSize: '11px', color: t === 'Featured' ? 'white' : '#8892a4', fontFamily: 'Arial, sans-serif', padding: '4px 12px', borderBottom: t === 'Featured' ? '2px solid #0070cc' : 'none', cursor: 'pointer' }}>{t}</span>
            ))}
          </div>
        </div>
      </div>

      <div>
        <h3 style={{ fontSize: '13px', fontWeight: 600, color: '#64748b', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          PlayStation Store — Game Tile (2:3 portrait)
        </h3>
        <div style={{ backgroundColor: '#00169b', borderRadius: '8px', padding: '20px', display: 'flex', gap: '16px' }}>
          {[{ active: true }, { active: false }, { active: false }].map(({ active }, i) => (
            <div key={i} style={{ width: '140px', flexShrink: 0, opacity: active ? 1 : 0.4 }}>
              <div style={{ position: 'relative' }}>
                {active ? (
                  <img src={imgSrc} alt="" style={{ width: '140px', height: '175px', objectFit: 'cover', borderRadius: '6px', display: 'block', border: active ? '2px solid #0070cc' : 'none' }} />
                ) : (
                  <div style={{ width: '140px', height: '175px', backgroundColor: '#1c2a5e', borderRadius: '6px' }} />
                )}
                {active && <div style={{ position: 'absolute', top: '6px', right: '6px', width: '14px', height: '14px', borderRadius: '50%', backgroundColor: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ fontSize: '8px', color: '#003087', fontWeight: 900 }}>PS</span>
                </div>}
              </div>
              <div style={{ marginTop: '8px', fontSize: '11px', color: active ? 'white' : '#8892a4', fontFamily: 'Arial, sans-serif' }}>
                {active ? 'Your Game Title' : `Other Game ${i + 1}`}
              </div>
              <div style={{ fontSize: '11px', color: active ? '#0070cc' : '#556', fontFamily: 'Arial, sans-serif', marginTop: '2px' }}>
                {active ? '€24.99' : '€19.99'}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Xbox Mockup ──────────────────────────────────────────────────────────────

function XboxMockup({ imgSrc }: { imgSrc: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
      <div>
        <h3 style={{ fontSize: '13px', fontWeight: 600, color: '#64748b', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Microsoft Store — Hero Art (16:9)
        </h3>
        <div style={{ backgroundColor: '#0e0e0e', borderRadius: '8px', overflow: 'hidden' }}>
          <div style={{ position: 'relative' }}>
            <img src={imgSrc} alt="Xbox hero" style={{ width: '100%', height: '230px', objectFit: 'cover', display: 'block' }} />
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg, rgba(0,0,0,0.75) 0%, transparent 60%)' }} />
            <div style={{ position: 'absolute', bottom: '24px', left: '24px' }}>
              <div style={{ fontSize: '28px', fontWeight: 700, color: 'white', fontFamily: '"Segoe UI", Arial, sans-serif', textShadow: '0 2px 6px rgba(0,0,0,0.6)' }}>Your Game Title</div>
              <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.8)', fontFamily: '"Segoe UI", Arial, sans-serif', marginTop: '4px' }}>Xbox Series X|S · Xbox One · PC</div>
              <div style={{ marginTop: '12px', display: 'flex', gap: '8px' }}>
                <div style={{ backgroundColor: '#107c10', color: 'white', fontSize: '12px', fontWeight: 600, padding: '6px 16px', borderRadius: '4px', fontFamily: '"Segoe UI", Arial, sans-serif' }}>Get with Game Pass</div>
                <div style={{ backgroundColor: 'white', color: '#0e0e0e', fontSize: '12px', fontWeight: 600, padding: '6px 16px', borderRadius: '4px', fontFamily: '"Segoe UI", Arial, sans-serif' }}>€24.99 Buy</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div>
        <h3 style={{ fontSize: '13px', fontWeight: 600, color: '#64748b', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Microsoft Store — Game Tile (2:3 portrait)
        </h3>
        <div style={{ backgroundColor: '#0e0e0e', borderRadius: '8px', padding: '20px', display: 'flex', gap: '12px' }}>
          {[true, false, false, false].map((active, i) => (
            <div key={i} style={{ width: '130px', flexShrink: 0, opacity: active ? 1 : 0.35 }}>
              {active ? (
                <img src={imgSrc} alt="" style={{ width: '130px', height: '173px', objectFit: 'cover', borderRadius: '4px', display: 'block' }} />
              ) : (
                <div style={{ width: '130px', height: '173px', backgroundColor: '#1a1a1a', borderRadius: '4px' }} />
              )}
              <div style={{ marginTop: '6px', fontSize: '11px', color: active ? 'white' : '#555', fontFamily: '"Segoe UI", Arial, sans-serif' }}>
                {active ? 'Your Game Title' : `Title ${i + 1}`}
              </div>
              <div style={{ fontSize: '11px', color: active ? '#107c10' : '#444', fontFamily: '"Segoe UI", Arial, sans-serif', marginTop: '2px' }}>
                {active ? 'Included with Game Pass' : '—'}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Nintendo Mockup ──────────────────────────────────────────────────────────

function NintendoMockup({ imgSrc }: { imgSrc: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
      <div>
        <h3 style={{ fontSize: '13px', fontWeight: 600, color: '#64748b', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Nintendo eShop — Featured Banner
        </h3>
        <div style={{ backgroundColor: '#e60012', borderRadius: '8px', overflow: 'hidden' }}>
          <div style={{ display: 'flex', gap: 0, overflow: 'hidden' }}>
            <div style={{ flex: 1, position: 'relative', height: '200px' }}>
              <img src={imgSrc} alt="eShop banner" style={{ width: '100%', height: '200px', objectFit: 'cover', display: 'block' }} />
            </div>
            <div style={{ width: '220px', padding: '20px', display: 'flex', flexDirection: 'column', justifyContent: 'center', backgroundColor: 'white', flexShrink: 0 }}>
              <div style={{ fontSize: '16px', fontWeight: 700, color: '#1a1a1a', fontFamily: 'Arial, sans-serif', marginBottom: '8px' }}>Your Game Title</div>
              <div style={{ fontSize: '11px', color: '#666', fontFamily: 'Arial, sans-serif', marginBottom: '12px' }}>Nintendo Switch · Up to 4 players</div>
              <div style={{ fontSize: '20px', fontWeight: 700, color: '#e60012', fontFamily: 'Arial, sans-serif', marginBottom: '12px' }}>€24.99</div>
              <div style={{ backgroundColor: '#e60012', color: 'white', fontSize: '12px', fontWeight: 700, padding: '8px 0', borderRadius: '20px', textAlign: 'center', fontFamily: 'Arial, sans-serif' }}>Buy Now</div>
            </div>
          </div>
        </div>
      </div>

      <div>
        <h3 style={{ fontSize: '13px', fontWeight: 600, color: '#64748b', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Nintendo eShop — Game Card (2:3 portrait)
        </h3>
        <div style={{ backgroundColor: '#f2f2f2', borderRadius: '8px', padding: '20px', display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
          {[true, false, false, false, false].map((active, i) => (
            <div key={i} style={{ width: '120px', flexShrink: 0, opacity: active ? 1 : 0.35 }}>
              {active ? (
                <img src={imgSrc} alt="" style={{ width: '120px', height: '160px', objectFit: 'cover', borderRadius: '6px', display: 'block', boxShadow: '0 3px 10px rgba(0,0,0,0.2)' }} />
              ) : (
                <div style={{ width: '120px', height: '160px', backgroundColor: '#d0d0d0', borderRadius: '6px' }} />
              )}
              <div style={{ marginTop: '6px', fontSize: '10px', color: active ? '#1a1a1a' : '#888', fontFamily: 'Arial, sans-serif', fontWeight: active ? 600 : 400 }}>
                {active ? 'Your Game Title' : `Game ${i + 1}`}
              </div>
              <div style={{ fontSize: '10px', color: active ? '#e60012' : '#aaa', fontFamily: 'Arial, sans-serif', marginTop: '2px' }}>
                {active ? '€24.99' : '—'}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function BannerPreviewPage() {
  const [imgSrc, setImgSrc] = useState('')
  const [urlInput, setUrlInput] = useState('')
  const [activePlatform, setActivePlatform] = useState<PlatformId>('steam')
  const [imgError, setImgError] = useState(false)
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = e => {
      const result = e.target?.result as string
      setImgSrc(result)
      setImgError(false)
      setUrlInput('')
    }
    reader.readAsDataURL(file)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  const handleUrlSubmit = () => {
    if (!urlInput.trim()) return
    setImgSrc(urlInput.trim())
    setImgError(false)
  }

  const PLACEHOLDER = 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="920" height="430" viewBox="0 0 920 430"><rect width="920" height="430" fill="#334155"/><text x="460" y="200" font-family="Arial" font-size="24" fill="#94a3b8" text-anchor="middle">Upload your banner image</text><text x="460" y="240" font-family="Arial" font-size="16" fill="#64748b" text-anchor="middle">to see how it looks on each platform</text></svg>`)

  const displaySrc = imgSrc || PLACEHOLDER

  return (
    <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
      <Sidebar />
      <div style={{ flex: 1, padding: '32px', minWidth: 0 }}>

        <div style={{ marginBottom: '28px' }}>
          <h1 style={{ fontSize: '22px', fontWeight: 700, color: '#1e293b', margin: '0 0 4px' }}>Banner Preview</h1>
          <p style={{ fontSize: '13px', color: '#64748b', margin: 0 }}>See how your game art looks in each storefront. Upload an image or paste a URL.</p>
        </div>

        {/* Upload area */}
        <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', marginBottom: '28px' }}>
          <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start', flexWrap: 'wrap' }}>

            {/* Drop zone */}
            <div
              onDragOver={e => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              style={{
                width: '200px', height: '100px', border: `2px dashed ${dragging ? '#b8232f' : '#cbd5e1'}`,
                borderRadius: '10px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', backgroundColor: dragging ? '#fef2f2' : '#f8fafc', transition: 'all 0.15s', flexShrink: 0
              }}
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={dragging ? '#b8232f' : '#94a3b8'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" />
              </svg>
              <div style={{ fontSize: '12px', color: '#64748b', marginTop: '6px', textAlign: 'center', lineHeight: 1.4 }}>
                Drop image here<br />or click to upload
              </div>
              <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', color: '#94a3b8', fontSize: '13px', paddingTop: '36px' }}>or</div>

            {/* URL input */}
            <div style={{ flex: 1, minWidth: '280px' }}>
              <label style={{ fontSize: '12px', fontWeight: 600, color: '#475569', display: 'block', marginBottom: '6px' }}>Image URL</label>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  type="url"
                  placeholder="https://example.com/banner.png"
                  value={urlInput}
                  onChange={e => setUrlInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleUrlSubmit()}
                  style={{ flex: 1, padding: '9px 12px', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '13px', color: '#1e293b', outline: 'none' }}
                />
                <button
                  onClick={handleUrlSubmit}
                  style={{ padding: '9px 18px', backgroundColor: '#b8232f', color: 'white', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}
                >
                  Preview
                </button>
              </div>
              {imgError && <div style={{ fontSize: '12px', color: '#dc2626', marginTop: '6px' }}>Could not load image. Check the URL or upload a file instead.</div>}
            </div>

            {/* Current thumbnail */}
            {imgSrc && !imgError && (
              <div style={{ flexShrink: 0 }}>
                <label style={{ fontSize: '12px', fontWeight: 600, color: '#475569', display: 'block', marginBottom: '6px' }}>Loaded image</label>
                <div style={{ position: 'relative' }}>
                  <img src={imgSrc} alt="Loaded banner" onError={() => setImgError(true)}
                    style={{ width: '160px', height: '75px', objectFit: 'cover', borderRadius: '8px', border: '2px solid #e2e8f0', display: 'block' }} />
                  <button
                    onClick={() => { setImgSrc(''); setUrlInput(''); setImgError(false) }}
                    style={{ position: 'absolute', top: '-6px', right: '-6px', width: '20px', height: '20px', borderRadius: '50%', backgroundColor: '#1e293b', color: 'white', border: 'none', cursor: 'pointer', fontSize: '12px', lineHeight: '20px', textAlign: 'center' }}
                  >
                    ×
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Platform tabs */}
        <div style={{ display: 'flex', gap: '0', marginBottom: '24px', borderBottom: '2px solid #e2e8f0' }}>
          {PLATFORMS.map(p => {
            const active = p.id === activePlatform
            return (
              <button
                key={p.id}
                onClick={() => setActivePlatform(p.id)}
                style={{
                  padding: '10px 20px', border: 'none', backgroundColor: 'transparent', cursor: 'pointer',
                  fontSize: '14px', fontWeight: active ? 600 : 500,
                  color: active ? '#b8232f' : '#64748b',
                  borderBottom: active ? '2px solid #b8232f' : '2px solid transparent',
                  marginBottom: '-2px',
                }}
              >
                {p.label}
              </button>
            )
          })}
        </div>

        {/* Mockup area */}
        <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '28px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
          {activePlatform === 'steam' && <SteamMockup imgSrc={displaySrc} />}
          {activePlatform === 'playstation' && <PlayStationMockup imgSrc={displaySrc} />}
          {activePlatform === 'xbox' && <XboxMockup imgSrc={displaySrc} />}
          {activePlatform === 'nintendo' && <NintendoMockup imgSrc={displaySrc} />}
        </div>

        {/* Tips */}
        <div style={{ marginTop: '20px', padding: '16px 20px', backgroundColor: '#eff6ff', borderRadius: '10px', fontSize: '12px', color: '#3b82f6', lineHeight: 1.6 }}>
          <strong>Recommended sizes:</strong> Steam capsule 460×215px · Steam library 920×430px · PlayStation cover 2:3 portrait ·
          Xbox box art 600×900px (portrait) · Nintendo eShop 2:3 portrait. For best results use a landscape image (at least 1920×1080) — it will be cropped to each format automatically.
        </div>
      </div>
    </div>
  )
}
