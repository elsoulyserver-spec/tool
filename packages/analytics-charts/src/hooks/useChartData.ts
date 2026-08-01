'use client'

/**
 * useChartData — data processing hook
 *
 * Handles:
 *  - LTTB sampling (synchronous for <50K, worker for >50K)
 *  - Rendering backend selection
 *  - RTL data reversal (for bar charts in rtl-aware mode)
 *  - Locale-aware label formatting
 */

import { useState, useEffect, useMemo } from 'react'
import type { DataPoint, ChartSeries, ChartType } from '../core/types'
import {
  getSamplingDecision,
  sampleInWorker,
  lttb,
  type SamplingDecision,
} from '../performance/sampler'
import { chartDirectionPolicy, getChartRtlConfig } from '../themes/direction-policy'
import { useChartContext } from '../core/context'

export interface UseChartDataResult<T> {
  data:       T[]
  decision:   SamplingDecision
  isProcessing: boolean
}

/**
 * Generic hook — accepts any data array and returns sampled version.
 * For MultiSeriesPoint data use useMultiSeriesData below.
 */
export function useChartData<T extends { x: string | number; y: number }>(
  raw:       T[],
  chartType: ChartType,
): UseChartDataResult<T> {
  const { direction } = useChartContext()
  const decision      = useMemo(() => getSamplingDecision(raw.length), [raw.length])
  const [processed, setProcessed] = useState<T[]>(raw)
  const [isProcessing, setIsProcessing] = useState(false)

  useEffect(() => {
    if (!decision.shouldSample) {
      setProcessed(raw)
      return
    }

    if (decision.willUseWorker) {
      setIsProcessing(true)
      const points: DataPoint[] = raw.map(d => ({ x: d.x, y: d.y }))
      sampleInWorker(points, decision.targetPoints).then(sampled => {
        const xs = new Set(sampled.map(p => p.x))
        setProcessed(raw.filter(d => xs.has(d.x)))
        setIsProcessing(false)
      }).catch(() => {
        // Worker failed — fall back to sync LTTB
        const points2 = raw.map(d => ({ x: d.x, y: d.y }))
        const sampled  = lttb(points2, decision.targetPoints)
        const xs = new Set(sampled.map(p => p.x))
        setProcessed(raw.filter(d => xs.has(d.x)))
        setIsProcessing(false)
      })
    } else {
      const points = raw.map(d => ({ x: d.x, y: d.y }))
      const sampled = lttb(points, decision.targetPoints)
      const xs      = new Set(sampled.map(p => p.x))
      setProcessed(raw.filter(d => xs.has(d.x)))
    }
  }, [raw, decision])

  // RTL: some charts reverse the data order for RTL-aware rendering
  const { mirrorAxes } = getChartRtlConfig(chartType, direction)
  const finalData = useMemo(() => {
    // Only reverse categorical/bar charts — not time series (time always L→R)
    if (mirrorAxes && (chartType === 'bar' || chartType === 'stacked-bar')) {
      return [...processed].reverse()
    }
    return processed
  }, [processed, mirrorAxes, chartType])

  return { data: finalData, decision, isProcessing }
}

/**
 * Processes ChartSeries[] — samples each series independently.
 */
export function useSeriesData(
  series:    ChartSeries[],
  chartType: ChartType,
): { series: ChartSeries[]; isProcessing: boolean } {
  const maxPoints = useMemo(
    () => Math.max(...series.map(s => s.data.length), 0),
    [series],
  )
  const decision = useMemo(() => getSamplingDecision(maxPoints), [maxPoints])
  const [processed, setProcessed] = useState<ChartSeries[]>(series)
  const [isProcessing, setIsProcessing] = useState(false)

  useEffect(() => {
    if (!decision.shouldSample) { setProcessed(series); return }

    setIsProcessing(true)
    Promise.all(
      series.map(async s => ({
        ...s,
        data: decision.willUseWorker
          ? await sampleInWorker(s.data, decision.targetPoints)
          : lttb(s.data, decision.targetPoints),
      })),
    ).then(result => {
      setProcessed(result)
      setIsProcessing(false)
    }).catch(() => {
      setProcessed(series.map(s => ({
        ...s,
        data: lttb(s.data, decision.targetPoints),
      })))
      setIsProcessing(false)
    })
  }, [series, decision])

  return { series: processed, isProcessing }
}
