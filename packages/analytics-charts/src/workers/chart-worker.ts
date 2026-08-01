/**
 * Chart Web Worker — offloads heavy sampling/aggregation from main thread.
 * Spawned by sampler.ts#sampleInWorker().
 */
import { lttb, aggregateTimeSeries } from '../performance/sampler'
import type { ChartWorkerMessage, ChartWorkerResult } from '../performance/sampler'

self.onmessage = (event: MessageEvent<ChartWorkerMessage>) => {
  const msg = event.data
  try {
    if (msg.type === 'SAMPLE') {
      const data = lttb(msg.data, msg.target)
      self.postMessage({ type: 'SAMPLE_DONE', data } satisfies ChartWorkerResult)
    } else if (msg.type === 'AGGREGATE') {
      const data = aggregateTimeSeries(msg.data, msg.bucketMs, msg.fn)
      self.postMessage({ type: 'AGGREGATE_DONE', data } satisfies ChartWorkerResult)
    }
  } catch (e) {
    self.postMessage({ type: 'ERROR', error: String(e) } satisfies ChartWorkerResult)
  }
}
