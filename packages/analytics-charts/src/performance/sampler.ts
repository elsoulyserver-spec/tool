/**
 * PART 12 — Performance: Data Sampling + Aggregation
 *
 * Algorithm: LTTB (Largest Triangle Three Buckets)
 * — Visually optimal downsampling; preserves peaks and shape.
 * — O(n) output, O(n) input, runs in O(n) time.
 *
 * Thresholds:
 *   < 1,000 points   → no sampling, SVG rendering
 *   1,000–5,000      → LTTB to 1,000 points, SVG
 *   5,000–50,000     → LTTB to 2,000 points, SVG
 *   50,000–1,000,000 → LTTB to 3,000 points, canvas
 *   > 1,000,000      → server-side aggregation required
 *
 * Performance budgets:
 *   100 points    → <1ms render, no sampling
 *   1,000 points  → <5ms render
 *   10,000 points → <16ms (1 frame) with LTTB → 1K
 *   100,000 points→ <50ms with LTTB → 2K + canvas
 *   1,000,000 pts → server aggregate + stream
 */

import type { DataPoint, RenderingBackend } from '../core/types'
import { CHART_PERF } from '../core/types'

// ── LTTB Algorithm ────────────────────────────────────────────────────────────

/**
 * Largest Triangle Three Buckets downsampling.
 * Preserves visual shape of data better than uniform sampling.
 *
 * @param data   Input data — must be sorted by x
 * @param target Output size (number of points to keep)
 */
export function lttb(data: DataPoint[], target: number): DataPoint[] {
  if (data.length <= target || target <= 2) return data

  const sampled: DataPoint[] = []
  const bucketSize = (data.length - 2) / (target - 2)

  let a = 0
  sampled.push(data[0])

  for (let i = 0; i < target - 2; i++) {
    // Next bucket boundaries
    const nextBucketStart = Math.floor((i + 1) * bucketSize) + 1
    const nextBucketEnd   = Math.min(Math.floor((i + 2) * bucketSize) + 1, data.length)

    // Average point of next bucket (used as C)
    let avgX = 0
    let avgY = 0
    const nextBucketLen = nextBucketEnd - nextBucketStart
    for (let j = nextBucketStart; j < nextBucketEnd; j++) {
      avgX += Number(data[j].x)
      avgY += data[j].y
    }
    avgX /= nextBucketLen
    avgY /= nextBucketLen

    // Current bucket boundaries
    const bucketStart = Math.floor(i * bucketSize) + 1
    const bucketEnd   = Math.floor((i + 1) * bucketSize) + 1

    const pointA = data[a]
    let maxArea  = -1
    let nextA    = bucketStart

    for (let j = bucketStart; j < bucketEnd; j++) {
      // Triangle area
      const area = Math.abs(
        (Number(pointA.x) - avgX) * (data[j].y - pointA.y) -
        (Number(pointA.x) - Number(data[j].x)) * (avgY - pointA.y),
      ) * 0.5

      if (area > maxArea) {
        maxArea = area
        nextA   = j
      }
    }

    sampled.push(data[nextA])
    a = nextA
  }

  sampled.push(data[data.length - 1])
  return sampled
}

// ── Multi-series LTTB ─────────────────────────────────────────────────────────

/**
 * Samples all series in a MultiSeriesPoint dataset consistently
 * so that x values align across series after sampling.
 */
export function lttbMultiSeries<T extends { x: string | number; [key: string]: unknown }>(
  data:   T[],
  key:    string,
  target: number,
): T[] {
  if (data.length <= target) return data

  const singleSeries: DataPoint[] = data.map(d => ({
    x: d.x,
    y: Number(d[key]) || 0,
  }))

  const sampledPoints = lttb(singleSeries, target)
  const keptIndices   = new Set(sampledPoints.map(p => p.x))

  return data.filter(d => keptIndices.has(d.x))
}

// ── Aggregation ───────────────────────────────────────────────────────────────

export type AggFn = 'sum' | 'avg' | 'max' | 'min' | 'count' | 'last'

/**
 * Time-bucket aggregation for time series data.
 * Groups points into buckets of `bucketMs` milliseconds.
 */
export function aggregateTimeSeries(
  data:     DataPoint[],
  bucketMs: number,
  fn:       AggFn = 'sum',
): DataPoint[] {
  if (!data.length) return data

  const buckets = new Map<number, number[]>()

  for (const point of data) {
    const ts     = typeof point.x === 'string' ? new Date(point.x).getTime() : Number(point.x)
    const bucket = Math.floor(ts / bucketMs) * bucketMs
    const existing = buckets.get(bucket) ?? []
    existing.push(point.y)
    buckets.set(bucket, existing)
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([ts, values]) => ({
      x: new Date(ts).toISOString(),
      y: aggregate(values, fn),
    }))
}

function aggregate(values: number[], fn: AggFn): number {
  if (!values.length) return 0
  switch (fn) {
    case 'sum':   return values.reduce((a, b) => a + b, 0)
    case 'avg':   return values.reduce((a, b) => a + b, 0) / values.length
    case 'max':   return Math.max(...values)
    case 'min':   return Math.min(...values)
    case 'count': return values.length
    case 'last':  return values[values.length - 1]
  }
}

// ── Rendering backend selector ────────────────────────────────────────────────

export function selectRenderingBackend(pointCount: number): RenderingBackend {
  return pointCount > CHART_PERF.pointThreshold ? 'canvas' : 'svg'
}

// ── Auto-sample decision ──────────────────────────────────────────────────────

export interface SamplingDecision {
  shouldSample:  boolean
  targetPoints:  number
  backend:       RenderingBackend
  willUseWorker: boolean
}

export function getSamplingDecision(rawPointCount: number): SamplingDecision {
  const backend       = selectRenderingBackend(rawPointCount)
  const willUseWorker = rawPointCount > CHART_PERF.workerThreshold

  if (rawPointCount <= CHART_PERF.samplingThreshold) {
    return { shouldSample: false, targetPoints: rawPointCount, backend, willUseWorker }
  }

  // Scale target: more points → smaller sample to stay within perf budget
  const targetPoints =
    rawPointCount < 50_000   ? 1_000 :
    rawPointCount < 200_000  ? 2_000 :
    rawPointCount < 1_000_000? 3_000 :
                               5_000

  return { shouldSample: true, targetPoints, backend, willUseWorker }
}

// ── Web Worker interface ──────────────────────────────────────────────────────
// Worker is defined in workers/chart-worker.ts — not inline to keep bundle clean

export type ChartWorkerMessage =
  | { type: 'SAMPLE';    data: DataPoint[];  target: number }
  | { type: 'AGGREGATE'; data: DataPoint[];  bucketMs: number; fn: AggFn }

export type ChartWorkerResult =
  | { type: 'SAMPLE_DONE';    data: DataPoint[] }
  | { type: 'AGGREGATE_DONE'; data: DataPoint[] }
  | { type: 'ERROR';           error: string }

/**
 * Spawns a web worker for heavy sampling. Caller is responsible for cleanup.
 * Falls back to synchronous lttb() if Worker is not available (SSR / Safari <15).
 */
export async function sampleInWorker(
  data:   DataPoint[],
  target: number,
): Promise<DataPoint[]> {
  if (typeof Worker === 'undefined') return lttb(data, target)

  return new Promise((resolve, reject) => {
    try {
      const worker = new Worker(
        new URL('../workers/chart-worker.ts', import.meta.url),
        { type: 'module' },
      )
      worker.postMessage({ type: 'SAMPLE', data, target } satisfies ChartWorkerMessage)
      worker.onmessage = (e: MessageEvent<ChartWorkerResult>) => {
        worker.terminate()
        if (e.data.type === 'SAMPLE_DONE') resolve(e.data.data)
        else reject(new Error((e.data as { error: string }).error))
      }
      worker.onerror = (err) => {
        worker.terminate()
        // Fall back to synchronous
        resolve(lttb(data, target))
      }
    } catch {
      resolve(lttb(data, target))
    }
  })
}

// ── Performance budget assertions (dev only) ──────────────────────────────────

export function assertPerformanceBudget(
  chartType: string,
  pointCount: number,
  renderMs:  number,
): void {
  if (process.env.NODE_ENV !== 'development') return

  const budget =
    pointCount < 1_000  ? 5  :
    pointCount < 10_000 ? 16 :
    pointCount < 100_000? 50 :
                          200

  if (renderMs > budget) {
    console.warn(
      `[ChartPerf] ${chartType}: ${pointCount} points rendered in ${renderMs.toFixed(1)}ms ` +
      `(budget: ${budget}ms). Consider enabling sampling.`,
    )
  }
}
