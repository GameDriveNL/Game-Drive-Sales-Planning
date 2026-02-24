'use client'

import { useState, useRef, useCallback, useMemo } from 'react'
import { differenceInDays, parseISO } from 'date-fns'
import type { BatchPredictionResult } from '@/app/api/sales/predict-batch/route'

interface SaleInput {
  id: string
  product_id: string
  platform_id: string
  discount_percentage: number
  start_date: string
  end_date: string
}

export interface CalendarPredictionsReturn {
  predictions: Map<string, BatchPredictionResult>
  loadingIds: Set<string>
  errors: Map<string, string>
  progress: { loaded: number; total: number }
  isRunning: boolean
  totalPredictedRevenue: number
  totalPredictedUnits: number
  startPredictions: (sales: SaleInput[], clientId: string) => void
  cancelPredictions: () => void
}

export function useCalendarPredictions(): CalendarPredictionsReturn {
  const [predictions, setPredictions] = useState<Map<string, BatchPredictionResult>>(new Map())
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Map<string, string>>(new Map())
  const [progress, setProgress] = useState({ loaded: 0, total: 0 })
  const [isRunning, setIsRunning] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const startPredictions = useCallback((sales: SaleInput[], clientId: string) => {
    // Abort any existing run
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    // Reset state
    const allIds = new Set(sales.map(s => s.id))
    setPredictions(new Map())
    setErrors(new Map())
    setLoadingIds(allIds)
    setProgress({ loaded: 0, total: sales.length })
    setIsRunning(true)

    // Build request
    const requestBody = {
      product_id: sales[0].product_id,
      client_id: clientId,
      sales: sales.map(s => ({
        sale_id: s.id,
        platform_id: s.platform_id,
        discount_percentage: s.discount_percentage,
        duration_days: differenceInDays(parseISO(s.end_date), parseISO(s.start_date)) + 1,
        start_date: s.start_date,
      }))
    }

    // Start streaming fetch
    fetch('/api/sales/predict-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Batch prediction failed: ${response.status}`)
        }

        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let loadedCount = 0

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || '' // keep incomplete line in buffer

          for (const line of lines) {
            if (!line.trim()) continue
            try {
              const data = JSON.parse(line)
              if (data.done) break

              if (data.prediction) {
                setPredictions(prev => {
                  const next = new Map(prev)
                  next.set(data.sale_id, data.prediction)
                  return next
                })
                loadedCount++
              }
              if (data.error) {
                setErrors(prev => {
                  const next = new Map(prev)
                  next.set(data.sale_id, data.error)
                  return next
                })
                loadedCount++
              }

              setLoadingIds(prev => {
                const next = new Set(prev)
                next.delete(data.sale_id)
                return next
              })
              setProgress({ loaded: loadedCount, total: sales.length })
            } catch {
              // Skip malformed lines
            }
          }
        }
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          console.error('Batch prediction stream error:', err)
        }
      })
      .finally(() => {
        setIsRunning(false)
        setLoadingIds(new Set())
      })
  }, [])

  const cancelPredictions = useCallback(() => {
    abortRef.current?.abort()
    setIsRunning(false)
    setLoadingIds(new Set())
  }, [])

  const totalPredictedRevenue = useMemo(() => {
    let sum = 0
    predictions.forEach(p => { sum += p.predicted_revenue || 0 })
    return Math.round(sum * 100) / 100
  }, [predictions])

  const totalPredictedUnits = useMemo(() => {
    let sum = 0
    predictions.forEach(p => { sum += p.predicted_units || 0 })
    return Math.round(sum)
  }, [predictions])

  return {
    predictions,
    loadingIds,
    errors,
    progress,
    isRunning,
    totalPredictedRevenue,
    totalPredictedUnits,
    startPredictions,
    cancelPredictions,
  }
}
