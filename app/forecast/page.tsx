'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Sidebar } from '../components/Sidebar'
import { useAuth } from '@/lib/auth-context'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'

// ─── Types ────────────────────────────────────────────────────────────────────

interface WishlistPoint { date: string; total: number; additions: number; deletions: number; conversions: number }
interface ActualSale { date: string; units: number; revenue: number }

interface ForecastData {
  wishlist_history: WishlistPoint[]
  current_wishlists: number
  latest_date: string | null
  earliest_date: string | null
  avg_daily_additions: number
  avg_daily_conversions: number
  actual_sales: ActualSale[]
}

interface ClientOption { id: string; name: string }
interface GameOption { id: string; name: string; client_id: string }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatMoney(v: number, cur = '€'): string {
  if (v >= 1_000_000) return `${cur}${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `${cur}${(v / 1_000).toFixed(1)}K`
  return `${cur}${v.toFixed(0)}`
}
function formatNum(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`
  return v.toFixed(0)
}

// Industry standard decay curve: day-1 = full, then taper
function buildLaunchCurve(day1Units: number, days = 90): number[] {
  const curve: number[] = []
  for (let d = 1; d <= days; d++) {
    let multiplier: number
    if (d === 1) multiplier = 1
    else if (d <= 3) multiplier = 0.35
    else if (d <= 7) multiplier = 0.12
    else if (d <= 14) multiplier = 0.06
    else if (d <= 30) multiplier = 0.025
    else multiplier = 0.008
    curve.push(Math.round(day1Units * multiplier))
  }
  return curve
}

function buildSaleImpactCurve(baseUnits: number, discount: number, dayOffset: number, duration: number, days: number): number[] {
  const curve = new Array(days).fill(0)
  // Sale boost: discount 30% → 3x, 50% → 6x, 75% → 12x (rough)
  const boostFactor = Math.pow(discount / 10, 1.4) * 0.4 + 1
  for (let d = dayOffset; d < dayOffset + duration && d < days; d++) {
    curve[d] = Math.round(baseUnits * boostFactor * (d === dayOffset ? 2.5 : 1.2))
  }
  return curve
}

// ─── Mini SVG Chart ───────────────────────────────────────────────────────────

function ForecastChart({ base, best, worst, actual, saleImpact, dayOffset, days = 90 }: {
  base: number[]; best: number[]; worst: number[]; actual: ActualSale[];
  saleImpact?: number[]; dayOffset: number; days?: number
}) {
  const W = 700; const H = 200; const PAD = { top: 12, right: 16, bottom: 36, left: 54 }
  const cW = W - PAD.left - PAD.right
  const cH = H - PAD.top - PAD.bottom

  const actualMax = actual.reduce((m, s) => Math.max(m, s.units), 0)
  const allMax = Math.max(...base, ...best, actualMax, 1)

  const xS = (i: number) => (i / (days - 1)) * cW
  const yS = (v: number) => cH - (v / allMax) * cH

  const toPoly = (vals: number[]) => vals.map((v, i) => `${xS(i)},${yS(v)}`).join(' ')

  const actualStartIdx = dayOffset
  const actualEndIdx = Math.min(dayOffset + actual.length, days)
  const actualSortedUnits = actual.slice(0, days - dayOffset).map(s => s.units)

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`}>
      <g transform={`translate(${PAD.left},${PAD.top})`}>
        {[0, 0.25, 0.5, 0.75, 1].map(p => {
          const y = yS(allMax * p)
          return (
            <g key={p}>
              <line x1={0} y1={y} x2={cW} y2={y} stroke="#f1f5f9" strokeWidth="1" />
              <text x={-4} y={y + 4} textAnchor="end" fontSize="9" fill="#94a3b8">{formatNum(allMax * p)}</text>
            </g>
          )
        })}

        {/* Sale shading */}
        {saleImpact && saleImpact.some(v => v > 0) && (
          <rect
            x={xS(saleImpact.findIndex(v => v > 0))}
            width={xS(saleImpact.lastIndexOf(Math.max(...saleImpact.filter(v => v > 0))) + 1) - xS(saleImpact.findIndex(v => v > 0))}
            y={0} height={cH} fill="#fef9c3" opacity="0.5"
          />
        )}

        {/* Worst/best band */}
        <polygon
          points={[...worst.map((v, i) => `${xS(i)},${yS(v)}`), ...[...best].reverse().map((v, i) => `${xS(days - 1 - i)},${yS(v)}`)].join(' ')}
          fill="#e2e8f0" opacity="0.4"
        />

        {/* Base line */}
        <polyline points={toPoly(base)} fill="none" stroke="#2563eb" strokeWidth="2" />
        {/* Worst */}
        <polyline points={toPoly(worst)} fill="none" stroke="#94a3b8" strokeWidth="1" strokeDasharray="3,3" />
        {/* Best */}
        <polyline points={toPoly(best)} fill="none" stroke="#059669" strokeWidth="1" strokeDasharray="3,3" />

        {/* Sale impact overlay */}
        {saleImpact && <polyline points={toPoly(saleImpact.map((v, i) => v > 0 ? v : base[i]))} fill="none" stroke="#d97706" strokeWidth="2" strokeDasharray="5,2" />}

        {/* Actual sales dots */}
        {actualSortedUnits.map((u, i) => (
          <circle key={i} cx={xS(actualStartIdx + i)} cy={yS(u)} r="3" fill="#b8232f" opacity="0.8" />
        ))}

        {/* Day labels */}
        {[0, 6, 13, 29, 59, 89].filter(d => d < days).map(d => (
          <text key={d} x={xS(d)} y={cH + 16} textAnchor="middle" fontSize="9" fill="#94a3b8">
            {d === 0 ? 'Launch' : `D+${d + 1}`}
          </text>
        ))}

        {/* Today marker (day 0 vertical) */}
        <line x1={xS(0)} y1={0} x2={xS(0)} y2={cH} stroke="#2563eb" strokeWidth="1" strokeDasharray="2,2" />
      </g>
    </svg>
  )
}

// ─── Wishlist History Chart ───────────────────────────────────────────────────

function WishlistChart({ data }: { data: WishlistPoint[] }) {
  if (!data.length) return null
  const W = 700; const H = 140; const PAD = { top: 10, right: 16, bottom: 28, left: 54 }
  const cW = W - PAD.left - PAD.right; const cH = H - PAD.top - PAD.bottom
  const maxTotal = Math.max(...data.map(d => d.total), 1)
  const xS = (i: number) => (i / (data.length - 1 || 1)) * cW
  const yS = (v: number) => cH - (v / maxTotal) * cH
  const pts = data.map((d, i) => `${xS(i)},${yS(d.total)}`).join(' ')
  const labelStep = Math.max(1, Math.floor(data.length / 6))

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`}>
      <g transform={`translate(${PAD.left},${PAD.top})`}>
        {[0, 0.5, 1].map(p => {
          const y = yS(maxTotal * p)
          return (
            <g key={p}>
              <line x1={0} y1={y} x2={cW} y2={y} stroke="#f1f5f9" strokeWidth="1" />
              <text x={-4} y={y + 4} textAnchor="end" fontSize="9" fill="#94a3b8">{formatNum(maxTotal * p)}</text>
            </g>
          )
        })}
        {/* Area fill */}
        <polygon points={`${xS(0)},${cH} ${pts} ${xS(data.length - 1)},${cH}`} fill="#dbeafe" opacity="0.5" />
        <polyline points={pts} fill="none" stroke="#2563eb" strokeWidth="2" />
        {data.filter((_, i) => i % labelStep === 0).map((d, _, arr) => {
          const idx = data.indexOf(d)
          return (
            <text key={d.date} x={xS(idx)} y={cH + 16} textAnchor="middle" fontSize="9" fill="#94a3b8">
              {d.date.slice(2, 7)}
            </text>
          )
        })}
      </g>
    </svg>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ForecastPage() {
  const { loading: authLoading } = useAuth()
  const supabase = createClientComponentClient()

  const [clients, setClients] = useState<ClientOption[]>([])
  const [games, setGames] = useState<GameOption[]>([])
  const [selectedClient, setSelectedClient] = useState('')
  const [selectedGame, setSelectedGame] = useState('')

  const [forecastData, setForecastData] = useState<ForecastData | null>(null)
  const [loading, setLoading] = useState(false)

  // Forecast inputs
  const [wishlistOverride, setWishlistOverride] = useState<string>('')
  const [price, setPrice] = useState('14.99')
  const [conversionRate, setConversionRate] = useState(12)  // %
  const [steamCut, setSteamCut] = useState(30)  // %
  const [includeSale, setIncludeSale] = useState(false)
  const [saleDay, setSaleDay] = useState(30)
  const [saleDuration, setSaleDuration] = useState(7)
  const [saleDiscount, setSaleDiscount] = useState(33)

  useEffect(() => {
    if (authLoading) return
    supabase.from('clients').select('id, name').order('name').then(({ data }) => {
      if (data) { setClients(data); if (data.length) setSelectedClient(data[0].id) }
    })
  }, [authLoading, supabase])

  useEffect(() => {
    if (!selectedClient) return
    supabase.from('games').select('id, name, client_id').eq('client_id', selectedClient).order('name').then(({ data }) => {
      setGames(data || [])
      setSelectedGame(data?.[0]?.id || '')
    })
  }, [selectedClient, supabase])

  const fetchData = useCallback(async () => {
    if (!selectedClient) return
    setLoading(true)
    const params = new URLSearchParams({ client_id: selectedClient })
    if (selectedGame) params.set('game_id', selectedGame)
    const res = await fetch(`/api/forecast?${params}`)
    if (res.ok) {
      const d: ForecastData = await res.json()
      setForecastData(d)
      if (d.current_wishlists > 0 && !wishlistOverride) {
        setWishlistOverride('')  // use live data
      }
    }
    setLoading(false)
  }, [selectedClient, selectedGame, wishlistOverride])

  useEffect(() => { fetchData() }, [fetchData])

  const wishlists = parseInt(wishlistOverride) || forecastData?.current_wishlists || 0
  const priceNum = parseFloat(price) || 0

  const day1Base = Math.round(wishlists * conversionRate / 100)
  const day1Best = Math.round(wishlists * Math.min(conversionRate * 1.8, 35) / 100)
  const day1Worst = Math.round(wishlists * Math.max(conversionRate * 0.4, 2) / 100)

  const baseCurve = useMemo(() => buildLaunchCurve(day1Base), [day1Base])
  const bestCurve = useMemo(() => buildLaunchCurve(day1Best), [day1Best])
  const worstCurve = useMemo(() => buildLaunchCurve(day1Worst), [day1Worst])

  const saleImpactCurve = useMemo(() => {
    if (!includeSale) return undefined
    const base = buildLaunchCurve(day1Base)
    const impact = buildSaleImpactCurve(base[Math.min(saleDay, 89)], saleDiscount, saleDay, saleDuration, 90)
    return base.map((v, i) => impact[i] > 0 ? impact[i] : v)
  }, [includeSale, day1Base, saleDay, saleDuration, saleDiscount])

  const steamMultiplier = (100 - steamCut) / 100
  const week1Units = baseCurve.slice(0, 7).reduce((s, v) => s + v, 0)
  const month1Units = baseCurve.slice(0, 30).reduce((s, v) => s + v, 0)
  const week1Rev = week1Units * priceNum * steamMultiplier
  const month1Rev = month1Units * priceNum * steamMultiplier
  const day1Rev = day1Base * priceNum * steamMultiplier

  const saleWeek1Units = saleImpactCurve ? saleImpactCurve.slice(saleDay, saleDay + saleDuration).reduce((s, v) => s + v, 0) : 0
  const saleWeek1Rev = saleWeek1Units * priceNum * (1 - saleDiscount / 100) * steamMultiplier

  const clientGames = games.filter(g => g.client_id === selectedClient)

  return (
    <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
      <Sidebar />
      <div style={{ flex: 1, padding: '32px', minWidth: 0 }}>

        <div style={{ marginBottom: '24px' }}>
          <h1 style={{ fontSize: '22px', fontWeight: 700, color: '#1e293b', margin: '0 0 4px' }}>Forecast Tool</h1>
          <p style={{ fontSize: '13px', color: '#64748b', margin: 0 }}>Estimate launch sales from Steam wishlists. Based on the wishlists-to-sales model (Simon Carless / GDC). Actual results vary widely.</p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: '24px', alignItems: 'start' }}>

          {/* Left: inputs */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

            {/* Game select */}
            <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
              <div style={{ fontSize: '13px', fontWeight: 600, color: '#1e293b', marginBottom: '12px' }}>Game</div>
              <select value={selectedClient} onChange={e => setSelectedClient(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '12px', marginBottom: '8px' }}>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {clientGames.length > 0 && (
                <select value={selectedGame} onChange={e => setSelectedGame(e.target.value)}
                  style={{ width: '100%', padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '12px' }}>
                  {clientGames.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              )}
              {forecastData && (
                <div style={{ marginTop: '10px', fontSize: '11px', color: '#64748b', lineHeight: 1.5 }}>
                  Live wishlists: <strong>{forecastData.current_wishlists.toLocaleString()}</strong>{forecastData.latest_date ? ` (as of ${forecastData.latest_date})` : ''}<br />
                  Daily additions: ~{forecastData.avg_daily_additions}/day
                </div>
              )}
            </div>

            {/* Inputs */}
            <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
              <div style={{ fontSize: '13px', fontWeight: 600, color: '#1e293b', marginBottom: '14px' }}>Inputs</div>

              <label style={{ fontSize: '11px', fontWeight: 600, color: '#475569', display: 'block', marginBottom: '4px' }}>Wishlist count (override)</label>
              <input type="number" placeholder={`${forecastData?.current_wishlists?.toLocaleString() || '—'} (live)`}
                value={wishlistOverride} onChange={e => setWishlistOverride(e.target.value)}
                style={{ width: '100%', padding: '7px 10px', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '12px', marginBottom: '12px', boxSizing: 'border-box' }} />

              <label style={{ fontSize: '11px', fontWeight: 600, color: '#475569', display: 'block', marginBottom: '4px' }}>Launch price (€)</label>
              <input type="number" step="0.01" value={price} onChange={e => setPrice(e.target.value)}
                style={{ width: '100%', padding: '7px 10px', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '12px', marginBottom: '12px', boxSizing: 'border-box' }} />

              <label style={{ fontSize: '11px', fontWeight: 600, color: '#475569', display: 'block', marginBottom: '4px' }}>
                Wishlist conversion rate: <strong>{conversionRate}%</strong>
              </label>
              <input type="range" min={2} max={30} step={1} value={conversionRate} onChange={e => setConversionRate(+e.target.value)}
                style={{ width: '100%', marginBottom: '4px' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#94a3b8', marginBottom: '12px' }}>
                <span>2% (weak launch)</span><span>12% (typical)</span><span>30% (hit)</span>
              </div>

              <label style={{ fontSize: '11px', fontWeight: 600, color: '#475569', display: 'block', marginBottom: '4px' }}>Steam cut</label>
              <div style={{ display: 'flex', gap: '6px', marginBottom: '16px' }}>
                {[30, 25, 20].map(c => (
                  <button key={c} onClick={() => setSteamCut(c)}
                    style={{ flex: 1, padding: '6px 0', border: `1px solid ${steamCut === c ? '#2563eb' : '#e2e8f0'}`, borderRadius: '6px', fontSize: '12px', fontWeight: steamCut === c ? 700 : 400, color: steamCut === c ? '#2563eb' : '#64748b', backgroundColor: steamCut === c ? '#eff6ff' : 'white', cursor: 'pointer' }}>
                    {c}%
                  </button>
                ))}
              </div>

              {/* Sale impact toggle */}
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', marginBottom: includeSale ? '12px' : '0' }}>
                <input type="checkbox" checked={includeSale} onChange={e => setIncludeSale(e.target.checked)} />
                <span style={{ fontSize: '12px', fontWeight: 600, color: '#1e293b' }}>Model a sale</span>
              </label>

              {includeSale && (
                <div style={{ paddingLeft: '8px', borderLeft: '2px solid #fde68a', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div>
                    <label style={{ fontSize: '11px', color: '#475569', display: 'block', marginBottom: '2px' }}>Sale starts on day +{saleDay}</label>
                    <input type="range" min={7} max={80} step={1} value={saleDay} onChange={e => setSaleDay(+e.target.value)} style={{ width: '100%' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: '11px', color: '#475569', display: 'block', marginBottom: '2px' }}>Duration: {saleDuration} days</label>
                    <input type="range" min={2} max={14} step={1} value={saleDuration} onChange={e => setSaleDuration(+e.target.value)} style={{ width: '100%' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: '11px', color: '#475569', display: 'block', marginBottom: '2px' }}>Discount: {saleDiscount}%</label>
                    <input type="range" min={10} max={85} step={5} value={saleDiscount} onChange={e => setSaleDiscount(+e.target.value)} style={{ width: '100%' }} />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Right: results */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

            {/* Stat cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
              {[
                { label: 'Day-1 sales', value: formatNum(day1Base), sub: `${formatMoney(day1Rev)} net rev`, color: '#2563eb' },
                { label: 'Week-1 sales', value: formatNum(week1Units), sub: `${formatMoney(week1Rev)} net rev`, color: '#059669' },
                { label: 'Month-1 sales', value: formatNum(month1Units), sub: `${formatMoney(month1Rev)} net rev`, color: '#b8232f' },
              ].map(s => (
                <div key={s.label} style={{ backgroundColor: 'white', borderRadius: '12px', padding: '16px 20px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                  <div style={{ fontSize: '11px', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>{s.label}</div>
                  <div style={{ fontSize: '26px', fontWeight: 800, color: s.color }}>{s.value}</div>
                  <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>{s.sub}</div>
                </div>
              ))}
            </div>

            {/* Scenario band */}
            <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '16px 20px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
              <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '2px' }}>Worst case</div>
                  <div style={{ fontSize: '16px', fontWeight: 700, color: '#dc2626' }}>{formatNum(day1Worst)} day-1</div>
                  <div style={{ fontSize: '11px', color: '#94a3b8' }}>~{Math.max(2, Math.round(conversionRate * 0.4))}% conversion</div>
                </div>
                <div>
                  <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '2px' }}>Base case</div>
                  <div style={{ fontSize: '16px', fontWeight: 700, color: '#2563eb' }}>{formatNum(day1Base)} day-1</div>
                  <div style={{ fontSize: '11px', color: '#94a3b8' }}>{conversionRate}% conversion</div>
                </div>
                <div>
                  <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '2px' }}>Best case</div>
                  <div style={{ fontSize: '16px', fontWeight: 700, color: '#059669' }}>{formatNum(day1Best)} day-1</div>
                  <div style={{ fontSize: '11px', color: '#94a3b8' }}>~{Math.min(35, Math.round(conversionRate * 1.8))}% conversion</div>
                </div>
                {includeSale && (
                  <div>
                    <div style={{ fontSize: '11px', color: '#d97706', marginBottom: '2px' }}>Sale D+{saleDay} ({saleDiscount}% off)</div>
                    <div style={{ fontSize: '16px', fontWeight: 700, color: '#d97706' }}>{formatNum(saleWeek1Units)} units</div>
                    <div style={{ fontSize: '11px', color: '#94a3b8' }}>{formatMoney(saleWeek1Rev)} net rev</div>
                  </div>
                )}
              </div>
            </div>

            {/* Forecast chart */}
            <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 600, color: '#1e293b' }}>90-day sales projection</div>
                  <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>Shaded band = worst → best case. Dots = actual sales (if available).</div>
                </div>
                <div style={{ display: 'flex', gap: '12px', fontSize: '11px', color: '#64748b', flexWrap: 'wrap' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><span style={{ display: 'inline-block', width: '16px', height: '2px', backgroundColor: '#2563eb' }} />Base</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><span style={{ display: 'inline-block', width: '16px', height: '2px', backgroundColor: '#059669' }} />Best</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><span style={{ display: 'inline-block', width: '16px', height: '2px', backgroundColor: '#94a3b8' }} />Worst</span>
                  {includeSale && <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><span style={{ display: 'inline-block', width: '16px', height: '2px', backgroundColor: '#d97706', borderTop: '2px dashed #d97706' }} />Sale</span>}
                  {(forecastData?.actual_sales?.length || 0) > 0 && <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#b8232f' }} />Actual</span>}
                </div>
              </div>
              <ForecastChart
                base={baseCurve} best={bestCurve} worst={worstCurve}
                actual={forecastData?.actual_sales || []}
                saleImpact={saleImpactCurve}
                dayOffset={0}
              />
            </div>

            {/* Wishlist history */}
            {(forecastData?.wishlist_history?.length || 0) > 0 && (
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#1e293b', marginBottom: '4px' }}>Wishlist growth history</div>
                <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '12px' }}>
                  {forecastData!.earliest_date} → {forecastData!.latest_date} · Avg +{forecastData!.avg_daily_additions}/day
                </div>
                <WishlistChart data={forecastData!.wishlist_history} />
              </div>
            )}

            <div style={{ padding: '14px 18px', backgroundColor: '#f8fafc', borderRadius: '10px', fontSize: '11px', color: '#64748b', lineHeight: 1.6 }}>
              <strong>Model:</strong> Day-1 = Wishlists × conversion%. Week-1 decay: day 2-3 ≈ 35%, days 4-7 ≈ 12%, weeks 2-4 ≈ 6%. Based on Simon Carless / Game Discovery research. Actual performance varies 10× from these estimates. Cross-check with <strong>plus.gamediscover.co</strong> for genre-specific benchmarks.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
