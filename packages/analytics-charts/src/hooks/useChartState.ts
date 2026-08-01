'use client'

/**
 * PART 7 — Chart State Machine
 *
 * Implements a minimal finite state machine for chart data lifecycle.
 * No xstate dependency — pure useReducer.
 *
 * Valid transitions:
 *
 *   idle       → loading
 *   loading    → loaded | error | empty | permission-denied
 *   loaded     → loading | stale | partial | degraded
 *   stale      → loading | error
 *   partial    → loading | loaded
 *   degraded   → loading | error
 *   error      → retrying | idle
 *   retrying   → loading | error
 *   offline    → loading
 *   empty      → loading
 *   permission-denied → idle (after role change)
 *   skeleton   → loading | loaded
 */

import { useReducer, useEffect, useRef, useCallback } from 'react'
import type { ChartDataState, ChartStateContext } from '../core/types'

// ── Actions ───────────────────────────────────────────────────────────────────

type ChartStateAction =
  | { type: 'FETCH_START' }
  | { type: 'FETCH_SUCCESS'; isEmpty?: boolean; isPartial?: boolean }
  | { type: 'FETCH_ERROR'; error: string }
  | { type: 'FETCH_EMPTY' }
  | { type: 'MARK_STALE' }
  | { type: 'MARK_DEGRADED' }
  | { type: 'PERMISSION_DENIED' }
  | { type: 'OFFLINE' }
  | { type: 'RETRY' }
  | { type: 'RESET' }
  | { type: 'SHOW_SKELETON' }
  | { type: 'ONLINE' }

const MAX_RETRIES = 3

// ── Transition table ──────────────────────────────────────────────────────────

const VALID_TRANSITIONS: Partial<Record<ChartDataState, ChartStateAction['type'][]>> = {
  idle:               ['FETCH_START', 'SHOW_SKELETON'],
  skeleton:           ['FETCH_START', 'FETCH_SUCCESS'],
  loading:            ['FETCH_SUCCESS', 'FETCH_ERROR', 'FETCH_EMPTY', 'PERMISSION_DENIED', 'OFFLINE'],
  loaded:             ['FETCH_START', 'MARK_STALE', 'MARK_DEGRADED', 'OFFLINE'],
  empty:              ['FETCH_START', 'OFFLINE'],
  stale:              ['FETCH_START', 'FETCH_ERROR', 'OFFLINE'],
  partial:            ['FETCH_START', 'FETCH_SUCCESS'],
  degraded:           ['FETCH_START', 'FETCH_ERROR'],
  error:              ['RETRY', 'RESET', 'ONLINE'],
  retrying:           ['FETCH_START', 'FETCH_ERROR'],
  offline:            ['ONLINE'],
  'permission-denied':['RESET'],
}

function canTransition(from: ChartDataState, action: ChartStateAction['type']): boolean {
  return VALID_TRANSITIONS[from]?.includes(action) ?? false
}

// ── Reducer ───────────────────────────────────────────────────────────────────

function chartStateReducer(
  ctx:    ChartStateContext,
  action: ChartStateAction,
): ChartStateContext {
  if (!canTransition(ctx.state, action.type)) return ctx

  switch (action.type) {
    case 'SHOW_SKELETON':
      return { ...ctx, state: 'skeleton' }

    case 'FETCH_START':
      return { ...ctx, state: 'loading', error: undefined }

    case 'FETCH_SUCCESS':
      if (action.isEmpty)   return { ...ctx, state: 'empty',   error: undefined }
      if (action.isPartial) return { ...ctx, state: 'partial', error: undefined }
      return { ...ctx, state: 'loaded', retryCount: 0, error: undefined }

    case 'FETCH_EMPTY':
      return { ...ctx, state: 'empty', error: undefined }

    case 'FETCH_ERROR':
      return { ...ctx, state: 'error', error: action.error }

    case 'MARK_STALE':
      return { ...ctx, state: 'stale', staleSince: Date.now() }

    case 'MARK_DEGRADED':
      return { ...ctx, state: 'degraded' }

    case 'PERMISSION_DENIED':
      return { ...ctx, state: 'permission-denied' }

    case 'OFFLINE':
      return { ...ctx, state: 'offline' }

    case 'ONLINE':
      return { ...ctx, state: 'idle', error: undefined }

    case 'RETRY':
      if (ctx.retryCount >= ctx.maxRetries) {
        return { ...ctx, state: 'error', error: 'Max retries exceeded' }
      }
      return { ...ctx, state: 'retrying', retryCount: ctx.retryCount + 1, error: undefined }

    case 'RESET':
      return { state: 'idle', retryCount: 0, maxRetries: ctx.maxRetries }
  }
}

// ── Public hook ───────────────────────────────────────────────────────────────

export interface UseChartStateConfig {
  /** Auto-detect browser offline state */
  watchOffline?: boolean
  /** Mark data stale after N milliseconds */
  staleAfterMs?: number
  maxRetries?:   number
}

export interface UseChartStateResult {
  chartState: ChartDataState
  error?:     string
  retryCount: number
  staleSince?:number
  /** Call before initiating a fetch */
  startLoad:  () => void
  /** Call when fetch resolves with data */
  setLoaded:  (opts?: { isEmpty?: boolean; isPartial?: boolean }) => void
  /** Call when fetch rejects */
  setError:   (message: string) => void
  /** Call to initiate a retry (increments retry counter) */
  retry:      () => void
  reset:      () => void
  showSkeleton:() => void
  markStale:  () => void
}

export function useChartState({
  watchOffline = true,
  staleAfterMs,
  maxRetries   = MAX_RETRIES,
}: UseChartStateConfig = {}): UseChartStateResult {

  const [ctx, dispatch] = useReducer(chartStateReducer, {
    state:      'idle',
    retryCount: 0,
    maxRetries,
  })

  // ── Offline detection ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!watchOffline || typeof window === 'undefined') return

    const goOffline = () => dispatch({ type: 'OFFLINE' })
    const goOnline  = () => dispatch({ type: 'ONLINE' })

    if (!navigator.onLine) goOffline()

    window.addEventListener('offline', goOffline)
    window.addEventListener('online',  goOnline)
    return () => {
      window.removeEventListener('offline', goOffline)
      window.removeEventListener('online',  goOnline)
    }
  }, [watchOffline])

  // ── Stale timer ────────────────────────────────────────────────────────────
  const staleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!staleAfterMs || ctx.state !== 'loaded') return
    staleTimer.current = setTimeout(() => dispatch({ type: 'MARK_STALE' }), staleAfterMs)
    return () => { if (staleTimer.current) clearTimeout(staleTimer.current) }
  }, [ctx.state, staleAfterMs])

  // ── Stable callbacks ───────────────────────────────────────────────────────
  const startLoad   = useCallback(() => dispatch({ type: 'FETCH_START' }),       [])
  const setLoaded   = useCallback((opts?: { isEmpty?: boolean; isPartial?: boolean }) =>
                        dispatch({ type: 'FETCH_SUCCESS', ...opts }),             [])
  const setError    = useCallback((message: string) =>
                        dispatch({ type: 'FETCH_ERROR', error: message }),        [])
  const retry       = useCallback(() => dispatch({ type: 'RETRY' }),              [])
  const reset       = useCallback(() => dispatch({ type: 'RESET' }),              [])
  const showSkeleton= useCallback(() => dispatch({ type: 'SHOW_SKELETON' }),      [])
  const markStale   = useCallback(() => dispatch({ type: 'MARK_STALE' }),         [])

  return {
    chartState:  ctx.state,
    error:       ctx.error,
    retryCount:  ctx.retryCount,
    staleSince:  ctx.staleSince,
    startLoad, setLoaded, setError, retry, reset, showSkeleton, markStale,
  }
}
