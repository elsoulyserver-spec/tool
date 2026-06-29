'use client'

import { useState, useCallback } from 'react'
import type { Table } from '@tanstack/react-table'
import type { AnalyticsRow } from '../core/types'

export type ExportFormat = 'csv' | 'json'
export type ExportStatus = 'idle' | 'exporting' | 'done' | 'error'

export interface UseExportConfig<TRow extends AnalyticsRow> {
  table:     Table<TRow>
  filename?: string
  /** Max rows to export in client mode — prevents browser OOM */
  maxRows?:  number
}

export interface UseExportResult {
  status:    ExportStatus
  exportCsv: () => Promise<void>
  exportJson:() => Promise<void>
}

export function useExport<TRow extends AnalyticsRow>({
  table,
  filename = 'easytrac-export',
  maxRows  = 50_000,
}: UseExportConfig<TRow>): UseExportResult {
  const [status, setStatus] = useState<ExportStatus>('idle')

  const getRows = useCallback(() => {
    const allRows = table.getFilteredRowModel().rows
    if (allRows.length > maxRows) {
      console.warn(`[useExport] Capping export at ${maxRows} rows (${allRows.length} total)`)
    }
    return allRows.slice(0, maxRows)
  }, [table, maxRows])

  const getHeaders = useCallback(() => {
    return table.getVisibleLeafColumns().map(col => ({
      id:    col.id,
      label: (col.columnDef.meta?.analytics?.label) ?? col.id,
    }))
  }, [table])

  const exportCsv = useCallback(async () => {
    setStatus('exporting')
    try {
      const headers = getHeaders()
      const rows    = getRows()

      const escape = (v: unknown): string => {
        const str = String(v ?? '')
        // Prevent CSV injection — prefix dangerous chars
        const sanitized = str.replace(/^[=+\-@\t\r]/, "'$&")
        return sanitized.includes(',') || sanitized.includes('"') || sanitized.includes('\n')
          ? `"${sanitized.replace(/"/g, '""')}"`
          : sanitized
      }

      const csvRows: string[] = []
      csvRows.push(headers.map(h => escape(h.label)).join(','))
      for (const row of rows) {
        csvRows.push(headers.map(h => escape(row.getValue(h.id))).join(','))
      }

      const blob = new Blob(['﻿' + csvRows.join('\r\n')], { type: 'text/csv;charset=utf-8;' })
      triggerDownload(blob, `${filename}.csv`)
      setStatus('done')
    } catch (err) {
      console.error('[useExport] CSV export failed:', err)
      setStatus('error')
    }
  }, [getHeaders, getRows, filename])

  const exportJson = useCallback(async () => {
    setStatus('exporting')
    try {
      const headers = getHeaders()
      const rows    = getRows()

      const data = rows.map(row => {
        const obj: Record<string, unknown> = {}
        for (const h of headers) obj[h.id] = row.getValue(h.id)
        return obj
      })

      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      triggerDownload(blob, `${filename}.json`)
      setStatus('done')
    } catch (err) {
      console.error('[useExport] JSON export failed:', err)
      setStatus('error')
    }
  }, [getHeaders, getRows, filename])

  return { status, exportCsv, exportJson }
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a   = document.createElement('a')
  a.href     = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
