'use client'

import { useState, useEffect, useCallback } from 'react'

interface PredictionData {
  product: { name: string; base_price: number; type: string }
  platform: { name: string }
  planned: { discount_percentage: number; duration_days: number; sale_price: number }
  historical: {
    total_sales: number
    max_discount: number | null
    avg_discount: number | null
    total_performance_days: number
    total_historical_revenue: number
    total_historical_units: number
  }
  statistical_prediction: {
    estimated_daily_revenue: number
    estimated_total_revenue: number
    estimated_daily_units: number
    estimated_total_units: number
    sale_multiplier: number
    avg_daily_revenue_during_sales: number
    avg_daily_revenue_non_sale: number
  }
  ai_prediction: {
    predicted_revenue: number
    predicted_units: number
    confidence: string
    optimal_discount: number
    optimal_duration: number
    reasoning: string
    risk_factors: string[]
    opportunities: string[]
  } | null
  has_sufficient_data: boolean
}

interface SalePredictionPanelProps {
  productId: string
  platformId: string
  clientId: string
  discountPercentage: number
  durationDays: number
  startDate?: string
  goalType?: string
}

function formatCurrency(n: number): string {
  if (n >= 1000000) return `$${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}K`
  return `$${n.toFixed(0)}`
}

export default function SalePredictionPanel({
  productId,
  platformId,
  clientId,
  discountPercentage,
  durationDays,
  startDate,
  goalType,
}: SalePredictionPanelProps) {
  const [prediction, setPrediction] = useState<PredictionData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  const fetchPrediction = useCallback(async () => {
    if (!productId || !platformId || !clientId) return

    setLoading(true)
    setError(null)

    try {
      const res = await fetch('/api/sales/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_id: productId,
          platform_id: platformId,
          client_id: clientId,
          discount_percentage: discountPercentage,
          duration_days: durationDays,
          start_date: startDate,
          goal_type: goalType,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to get prediction')
      }

      const data: PredictionData = await res.json()
      setPrediction(data)
      setExpanded(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Prediction failed')
    } finally {
      setLoading(false)
    }
  }, [productId, platformId, clientId, discountPercentage, durationDays, startDate, goalType])

  // Reset when product/platform changes
  useEffect(() => {
    setPrediction(null)
    setExpanded(false)
  }, [productId, platformId])

  if (!productId || !platformId) return null

  const stat = prediction?.statistical_prediction
  const ai = prediction?.ai_prediction

  const boxStyle: React.CSSProperties = {
    margin: '12px 0',
    border: '1px solid #e2e8f0',
    borderRadius: '8px',
    overflow: 'hidden',
    fontSize: '13px',
  }

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 14px',
    background: '#f0f4ff',
    cursor: 'pointer',
    userSelect: 'none',
  }

  const bodyStyle: React.CSSProperties = {
    padding: expanded ? '12px 14px' : '0 14px',
    maxHeight: expanded ? '400px' : '0',
    overflow: 'auto',
    transition: 'max-height 0.2s ease, padding 0.2s ease',
  }

  const statCardStyle: React.CSSProperties = {
    display: 'inline-block',
    background: '#f8fafc',
    border: '1px solid #e2e8f0',
    borderRadius: '6px',
    padding: '8px 12px',
    margin: '0 8px 8px 0',
    textAlign: 'center',
    minWidth: '100px',
  }

  const confidenceColor = (c: string) =>
    c === 'high' ? '#16a34a' : c === 'medium' ? '#ca8a04' : '#dc2626'

  return (
    <div style={boxStyle}>
      <div style={headerStyle} onClick={() => {
        if (!prediction && !loading) {
          fetchPrediction()
        } else {
          setExpanded(!expanded)
        }
      }}>
        <span style={{ fontWeight: 600, color: '#1e40af' }}>
          AI Revenue Prediction
        </span>
        <span style={{ fontSize: '12px', color: '#64748b' }}>
          {loading ? 'Analyzing...' : prediction ? (expanded ? '▲' : '▼') : 'Click to analyze'}
        </span>
      </div>

      <div style={bodyStyle}>
        {loading && (
          <div style={{ padding: '16px', textAlign: 'center', color: '#64748b' }}>
            Analyzing historical data and generating prediction...
          </div>
        )}

        {error && (
          <div style={{ padding: '8px', color: '#dc2626', fontSize: '13px' }}>
            {error}
          </div>
        )}

        {prediction && !loading && (
          <>
            {!prediction.has_sufficient_data && (
              <div style={{ padding: '8px 10px', background: '#fffbeb', borderRadius: '4px', color: '#b45309', fontSize: '12px', marginBottom: '8px', borderLeft: '3px solid #f59e0b' }}>
                <strong>Needs imported Steam performance data.</strong> Predictions use at least 14 days of actual Steam revenue/units for this product+platform — planned sales alone don&apos;t count. Import the product&apos;s Steam history (Analytics → Import CSV) to improve accuracy.
              </div>
            )}

            {/* Statistical prediction */}
            <div style={{ marginBottom: '10px' }}>
              <div style={{ fontWeight: 600, fontSize: '12px', color: '#475569', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Statistical Estimate
              </div>
              <div>
                <div style={statCardStyle}>
                  <div style={{ fontSize: '18px', fontWeight: 700, color: '#16a34a' }}>
                    {formatCurrency(stat?.estimated_total_revenue || 0)}
                  </div>
                  <div style={{ fontSize: '11px', color: '#64748b' }}>Est. Revenue</div>
                </div>
                <div style={statCardStyle}>
                  <div style={{ fontSize: '18px', fontWeight: 700, color: '#b8232f' }}>
                    {stat?.estimated_total_units?.toLocaleString() || '0'}
                  </div>
                  <div style={{ fontSize: '11px', color: '#64748b' }}>Est. Units</div>
                </div>
                <div style={statCardStyle}>
                  <div style={{ fontSize: '18px', fontWeight: 700, color: '#7c3aed' }}>
                    {stat?.sale_multiplier || '0'}x
                  </div>
                  <div style={{ fontSize: '11px', color: '#64748b' }}>Sale Multiplier</div>
                </div>
              </div>
              <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>
                {prediction.historical.total_performance_days < 1
                  ? `No imported Steam performance data yet — based on ${prediction.historical.total_sales} recorded sale(s) only`
                  : `Based on ${prediction.historical.total_performance_days} days of imported Steam data, ${prediction.historical.total_sales} past sales`}
              </div>
            </div>

            {/* AI prediction */}
            {ai && (
              <div style={{ marginBottom: '10px' }}>
                <div style={{ fontWeight: 600, fontSize: '12px', color: '#475569', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  AI Analysis
                  <span style={{ marginLeft: '8px', fontSize: '11px', color: confidenceColor(ai.confidence), fontWeight: 700, textTransform: 'capitalize' }}>
                    {ai.confidence} confidence
                  </span>
                </div>
                <div>
                  <div style={statCardStyle}>
                    <div style={{ fontSize: '18px', fontWeight: 700, color: '#16a34a' }}>
                      {formatCurrency(ai.predicted_revenue)}
                    </div>
                    <div style={{ fontSize: '11px', color: '#64748b' }}>AI Revenue</div>
                  </div>
                  <div style={statCardStyle}>
                    <div style={{ fontSize: '18px', fontWeight: 700, color: '#ea580c' }}>
                      {ai.optimal_discount}%
                    </div>
                    <div style={{ fontSize: '11px', color: '#64748b' }}>Optimal Discount</div>
                  </div>
                  <div style={statCardStyle}>
                    <div style={{ fontSize: '18px', fontWeight: 700, color: '#0891b2' }}>
                      {ai.optimal_duration}d
                    </div>
                    <div style={{ fontSize: '11px', color: '#64748b' }}>Optimal Duration</div>
                  </div>
                </div>
                <div style={{ fontSize: '12px', color: '#334155', lineHeight: 1.5, margin: '6px 0' }}>
                  {ai.reasoning}
                </div>
                {ai.risk_factors && ai.risk_factors.length > 0 && (
                  <div style={{ fontSize: '11px', color: '#dc2626', marginTop: '4px' }}>
                    Risks: {ai.risk_factors.join(' · ')}
                  </div>
                )}
                {ai.opportunities && ai.opportunities.length > 0 && (
                  <div style={{ fontSize: '11px', color: '#16a34a', marginTop: '2px' }}>
                    Opportunities: {ai.opportunities.join(' · ')}
                  </div>
                )}
              </div>
            )}

            {/* Refresh button */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); fetchPrediction() }}
              style={{
                fontSize: '12px',
                color: '#b8232f',
                background: 'none',
                border: '1px solid #b8232f',
                borderRadius: '4px',
                padding: '4px 10px',
                cursor: 'pointer',
                marginTop: '4px',
              }}
            >
              Refresh Prediction
            </button>
          </>
        )}
      </div>
    </div>
  )
}
