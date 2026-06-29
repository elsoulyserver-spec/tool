/**
 * PART 2 — ChartRegistry
 *
 * Central registry for chart types. Allows runtime chart registration
 * (tenant plugins, white-label custom charts) without modifying core.
 *
 * Usage:
 *   chartRegistry.register('custom-funnel', CustomFunnelChart)
 *   const Component = chartRegistry.resolve('custom-funnel')
 */

import type { ComponentType } from 'react'
import type { ChartType, BaseChartProps } from './types'

type ChartComponent = ComponentType<BaseChartProps & Record<string, unknown>>

interface ChartRegistryEntry {
  component:   ChartComponent
  displayName: string
  /** Minimum data points required for meaningful rendering */
  minPoints:   number
  /** Whether this chart supports compare mode */
  supportsCompare: boolean
  /** Whether this chart type requires a time-series x-axis */
  requiresTimeSeries: boolean
}

class ChartRegistry {
  private entries = new Map<string, ChartRegistryEntry>()

  register(type: ChartType | string, entry: ChartRegistryEntry): void {
    if (this.entries.has(type)) {
      console.warn(`[ChartRegistry] Overwriting existing registration for "${type}"`)
    }
    this.entries.set(type, entry)
  }

  resolve(type: ChartType | string): ChartComponent | null {
    return this.entries.get(type)?.component ?? null
  }

  getMeta(type: ChartType | string): Omit<ChartRegistryEntry, 'component'> | null {
    const entry = this.entries.get(type)
    if (!entry) return null
    const { component: _, ...meta } = entry
    return meta
  }

  list(): string[] {
    return [...this.entries.keys()]
  }

  has(type: string): boolean {
    return this.entries.has(type)
  }
}

// Singleton — one registry per application
export const chartRegistry = new ChartRegistry()
