/**
 * Easy Track Analytics Table — Analytics Column Factories
 *
 * Factory functions that produce fully-configured TanStack ColumnDef objects
 * for every analytics column type. Callers compose these to build table presets.
 *
 * Naming convention: col<Type>(accessor, options?) → ColumnDef<TRow>
 */

import { type ColumnDef } from '@tanstack/react-table'
import type { AnalyticsRow, AnalyticsColumnMeta, ColumnFormatOptions } from '../core/types'
import type { SupportedLocale } from '@easytrac/design-tokens'

type ColOptions<TRow extends AnalyticsRow, TValue = unknown> = {
  id?:         string
  header?:     string
  headerAr?:   string
  size?:        number
  minSize?:     number
  maxSize?:     number
  enableSort?:  boolean
  enableFilter?:boolean
  pin?:         'left' | 'right' | false
  locale?:      SupportedLocale
  format?:      ColumnFormatOptions
  group?:       string
  groupAr?:     string
  description?: string
}

// ── Helper: build column meta ─────────────────────────────────────────────────

function makeMeta(
  partial: Omit<AnalyticsColumnMeta, 'label'> & { label: string },
): { analytics: AnalyticsColumnMeta } {
  return { analytics: partial }
}

// ── Primitive column factories ─────────────────────────────────────────────────

/** Plain localised text column */
export function colText<TRow extends AnalyticsRow>(
  accessor: keyof TRow & string,
  label:    string,
  opts:     ColOptions<TRow> = {},
): ColumnDef<TRow> {
  return {
    id:           opts.id ?? accessor,
    accessorKey:  accessor,
    header:       opts.header ?? label,
    size:         opts.size    ?? 160,
    minSize:      opts.minSize ?? 80,
    maxSize:      opts.maxSize ?? 400,
    enableSorting:opts.enableSort  ?? true,
    enableColumnFilter: opts.enableFilter ?? true,
    meta: makeMeta({
      label,
      labelAr:   opts.headerAr,
      valueType: 'text',
      align:     'start',
      locale:    opts.locale,
      group:     opts.group,
      groupAr:   opts.groupAr,
      description: opts.description,
      hideable:  true,
      defaultPin:opts.pin ?? false,
      wrap:      false,
    }),
  }
}

/** Integer or decimal number column */
export function colNumber<TRow extends AnalyticsRow>(
  accessor:  keyof TRow & string,
  label:     string,
  opts:      ColOptions<TRow> & { decimals?: number; compact?: boolean } = {},
): ColumnDef<TRow> {
  return {
    id:           opts.id ?? accessor,
    accessorKey:  accessor,
    header:       opts.header ?? label,
    size:         opts.size    ?? 100,
    minSize:      opts.minSize ?? 70,
    maxSize:      opts.maxSize ?? 200,
    enableSorting:opts.enableSort ?? true,
    enableColumnFilter: opts.enableFilter ?? true,
    filterFn:     'numeric' as any,
    sortingFn:    'basic',
    meta: makeMeta({
      label,
      labelAr:   opts.headerAr,
      valueType: 'number',
      align:     'end',
      cellDir:   'ltr',
      locale:    opts.locale,
      group:     opts.group,
      groupAr:   opts.groupAr,
      hideable:  true,
      defaultPin:opts.pin ?? false,
      format:    { decimals: opts.format?.decimals ?? opts.decimals ?? 0, compact: opts.compact, ...opts.format },
    }),
  }
}

/** Currency column — always SAR / GCC amounts */
export function colCurrency<TRow extends AnalyticsRow>(
  accessor:  keyof TRow & string,
  label:     string,
  opts:      ColOptions<TRow> & { currency?: string; vat?: 'inclusive' | 'exclusive' | 'none' } = {},
): ColumnDef<TRow> {
  return {
    id:           opts.id ?? accessor,
    accessorKey:  accessor,
    header:       opts.header ?? label,
    size:         opts.size    ?? 130,
    minSize:      opts.minSize ?? 100,
    maxSize:      opts.maxSize ?? 220,
    enableSorting:opts.enableSort ?? true,
    enableColumnFilter: opts.enableFilter ?? true,
    filterFn:     'numeric' as any,
    sortingFn:    'basic',
    meta: makeMeta({
      label,
      labelAr:   opts.headerAr,
      valueType: 'currency',
      align:     'end',
      cellDir:   'ltr',
      locale:    opts.locale ?? 'en-SA',
      group:     opts.group,
      groupAr:   opts.groupAr,
      hideable:  true,
      defaultPin:opts.pin ?? false,
      format:    { currency: opts.currency ?? 'SAR', decimals: 0, ...opts.format },
    }),
  }
}

/** Percentage column — input can be decimal (0–1) or percent (0–100) */
export function colPercent<TRow extends AnalyticsRow>(
  accessor:  keyof TRow & string,
  label:     string,
  opts:      ColOptions<TRow> & {
    asDecimal?:      boolean
    decimals?:       number
    colorCode?:      boolean
    positiveIsGood?: boolean
    showSign?:       boolean
  } = {},
): ColumnDef<TRow> {
  return {
    id:           opts.id ?? accessor,
    accessorKey:  accessor,
    header:       opts.header ?? label,
    size:         opts.size    ?? 90,
    minSize:      opts.minSize ?? 70,
    maxSize:      opts.maxSize ?? 140,
    enableSorting:opts.enableSort ?? true,
    filterFn:     'numeric' as any,
    sortingFn:    'basic',
    meta: makeMeta({
      label,
      labelAr:   opts.headerAr,
      valueType: 'percentage',
      align:     'end',
      cellDir:   'ltr',
      locale:    opts.locale,
      group:     opts.group,
      groupAr:   opts.groupAr,
      hideable:  true,
      defaultPin:opts.pin ?? false,
      format: {
        asDecimal:      opts.asDecimal      ?? true,
        decimals:       opts.decimals       ?? 2,
        colorCode:      opts.colorCode      ?? false,
        positiveIsGood: opts.positiveIsGood ?? true,
        showSign:       opts.showSign       ?? false,
        ...opts.format,
      },
    }),
  }
}

/** ROAS column — renders as "4.78x" */
export function colROAS<TRow extends AnalyticsRow>(
  accessor:  keyof TRow & string,
  opts:      ColOptions<TRow> & { decimals?: number } = {},
): ColumnDef<TRow> {
  return {
    id:           opts.id ?? accessor,
    accessorKey:  accessor,
    header:       opts.header ?? 'ROAS',
    size:         opts.size    ?? 80,
    minSize:      opts.minSize ?? 60,
    maxSize:      opts.maxSize ?? 120,
    enableSorting:opts.enableSort ?? true,
    filterFn:     'numeric' as any,
    sortingFn:    'basic',
    meta: makeMeta({
      label:     opts.header ?? 'ROAS',
      labelAr:   opts.headerAr ?? 'عائد الإنفاق',
      valueType: 'roas',
      align:     'end',
      cellDir:   'ltr',
      locale:    opts.locale,
      group:     opts.group ?? 'performance',
      groupAr:   opts.groupAr ?? 'الأداء',
      hideable:  true,
      defaultPin:opts.pin ?? false,
      format:    { decimals: opts.decimals ?? 2 },
    }),
  }
}

/** Delta column — signed percentage change */
export function colDelta<TRow extends AnalyticsRow>(
  accessor:  keyof TRow & string,
  label:     string,
  opts:      ColOptions<TRow> & { positiveIsGood?: boolean } = {},
): ColumnDef<TRow> {
  return {
    id:           opts.id ?? accessor,
    accessorKey:  accessor,
    header:       opts.header ?? label,
    size:         opts.size    ?? 90,
    minSize:      opts.minSize ?? 70,
    maxSize:      opts.maxSize ?? 130,
    enableSorting:opts.enableSort ?? true,
    filterFn:     'numeric' as any,
    sortingFn:    'basic',
    meta: makeMeta({
      label,
      labelAr:   opts.headerAr,
      valueType: 'delta',
      align:     'end',
      cellDir:   'ltr',
      locale:    opts.locale,
      hideable:  true,
      defaultPin:opts.pin ?? false,
      format:    { positiveIsGood: opts.positiveIsGood ?? true, showSign: true, colorCode: true, ...opts.format },
    }),
  }
}

/** Platform event name column — always Inter LTR */
export function colEventName<TRow extends AnalyticsRow>(
  accessor:  keyof TRow & string,
  opts:      ColOptions<TRow> & { maxLength?: number } = {},
): ColumnDef<TRow> {
  return {
    id:           opts.id ?? accessor,
    accessorKey:  accessor,
    header:       opts.header ?? 'Event',
    size:         opts.size    ?? 200,
    minSize:      opts.minSize ?? 120,
    maxSize:      opts.maxSize ?? 360,
    enableSorting:opts.enableSort  ?? true,
    enableColumnFilter: opts.enableFilter ?? true,
    filterFn:     'textSearch' as any,
    meta: makeMeta({
      label:     opts.header ?? 'Event',
      labelAr:   opts.headerAr ?? 'الحدث',
      valueType: 'event-name',
      align:     'start',
      cellDir:   'ltr',
      hideable:  true,
      defaultPin:opts.pin ?? 'left',
      wrap:      false,
      format:    { maxLength: opts.maxLength ?? 40, showBadge: true },
    }),
  }
}

/** Platform badge column */
export function colPlatform<TRow extends AnalyticsRow>(
  accessor:  keyof TRow & string,
  opts:      ColOptions<TRow> = {},
): ColumnDef<TRow> {
  return {
    id:           opts.id ?? accessor,
    accessorKey:  accessor,
    header:       opts.header ?? 'Platform',
    size:         opts.size    ?? 90,
    minSize:      opts.minSize ?? 70,
    maxSize:      opts.maxSize ?? 120,
    enableSorting:opts.enableSort  ?? true,
    enableColumnFilter: opts.enableFilter ?? true,
    filterFn:     'multiSelect' as any,
    meta: makeMeta({
      label:     opts.header ?? 'Platform',
      labelAr:   opts.headerAr ?? 'المنصة',
      valueType: 'platform',
      align:     'start',
      cellDir:   'ltr',
      hideable:  true,
      defaultPin:opts.pin ?? false,
      filterable:true,
    }),
  }
}

/** Timestamp column — ISO 8601 → formatted date/time */
export function colTimestamp<TRow extends AnalyticsRow>(
  accessor:  keyof TRow & string,
  label:     string,
  opts:      ColOptions<TRow> & {
    showRelative?: boolean
    dateStyle?:    Intl.DateTimeFormatOptions['dateStyle']
    timeStyle?:    Intl.DateTimeFormatOptions['timeStyle']
  } = {},
): ColumnDef<TRow> {
  return {
    id:           opts.id ?? accessor,
    accessorKey:  accessor,
    header:       opts.header ?? label,
    size:         opts.size    ?? 140,
    minSize:      opts.minSize ?? 100,
    maxSize:      opts.maxSize ?? 200,
    enableSorting:opts.enableSort ?? true,
    filterFn:     'dateRange' as any,
    sortingFn:    'datetime',
    meta: makeMeta({
      label,
      labelAr:   opts.headerAr,
      valueType: opts.showRelative ? 'relative-time' : 'timestamp',
      align:     'end',
      cellDir:   'ltr',
      locale:    opts.locale,
      hideable:  true,
      defaultPin:opts.pin ?? false,
      format:    {
        dateStyle: opts.dateStyle ?? 'medium',
        timeStyle: opts.timeStyle,
        ...opts.format,
      },
    }),
  }
}

/** Status column — renders colored badge */
export function colStatus<TRow extends AnalyticsRow>(
  accessor:  keyof TRow & string,
  label:     string,
  opts:      ColOptions<TRow> = {},
): ColumnDef<TRow> {
  return {
    id:           opts.id ?? accessor,
    accessorKey:  accessor,
    header:       opts.header ?? label,
    size:         opts.size    ?? 100,
    minSize:      opts.minSize ?? 80,
    maxSize:      opts.maxSize ?? 140,
    enableSorting:opts.enableSort  ?? true,
    enableColumnFilter: opts.enableFilter ?? true,
    filterFn:     'multiSelect' as any,
    meta: makeMeta({
      label,
      labelAr:   opts.headerAr,
      valueType: 'status',
      align:     'start',
      hideable:  true,
      filterable:true,
      defaultPin:opts.pin ?? false,
    }),
  }
}

/** Health score — 0–100 rendered as progress bar */
export function colHealth<TRow extends AnalyticsRow>(
  accessor:  keyof TRow & string,
  label:     string,
  opts:      ColOptions<TRow> = {},
): ColumnDef<TRow> {
  return {
    id:           opts.id ?? accessor,
    accessorKey:  accessor,
    header:       opts.header ?? label,
    size:         opts.size    ?? 110,
    minSize:      opts.minSize ?? 80,
    maxSize:      opts.maxSize ?? 160,
    enableSorting:opts.enableSort ?? true,
    filterFn:     'numeric' as any,
    meta: makeMeta({
      label,
      labelAr:   opts.headerAr,
      valueType: 'health',
      align:     'end',
      cellDir:   'ltr',
      hideable:  true,
      defaultPin:opts.pin ?? false,
    }),
  }
}

/** Sparkline column — mini trend chart */
export function colSparkline<TRow extends AnalyticsRow>(
  accessor:     keyof TRow & string,
  label:        string,
  opts:         ColOptions<TRow> = {},
): ColumnDef<TRow> {
  return {
    id:             opts.id ?? accessor,
    accessorKey:    accessor,
    header:         opts.header ?? label,
    size:           opts.size    ?? 100,
    minSize:        opts.minSize ?? 80,
    maxSize:        opts.maxSize ?? 160,
    enableSorting:  false,    // sparklines are not sortable
    enableColumnFilter: false,
    meta: makeMeta({
      label,
      labelAr:   opts.headerAr,
      valueType: 'sparkline',
      align:     'center',
      hideable:  true,
      defaultPin:opts.pin ?? false,
    }),
  }
}

/** Technical ID column — monospace, always LTR */
export function colId<TRow extends AnalyticsRow>(
  accessor:  keyof TRow & string,
  label:     string,
  opts:      ColOptions<TRow> & { maxLength?: number } = {},
): ColumnDef<TRow> {
  return {
    id:           opts.id ?? accessor,
    accessorKey:  accessor,
    header:       opts.header ?? label,
    size:         opts.size    ?? 140,
    minSize:      opts.minSize ?? 80,
    maxSize:      opts.maxSize ?? 240,
    enableSorting:opts.enableSort  ?? false,
    enableColumnFilter: opts.enableFilter ?? true,
    filterFn:     'textSearch' as any,
    meta: makeMeta({
      label,
      labelAr:   opts.headerAr,
      valueType: 'id',
      align:     'start',
      cellDir:   'ltr',
      hideable:  true,
      defaultPin:opts.pin ?? false,
      wrap:      false,
      format:    { maxLength: opts.maxLength ?? 30 },
    }),
  }
}

/** Attribution breakdown column */
export function colAttribution<TRow extends AnalyticsRow>(
  accessor:  keyof TRow & string,
  label:     string,
  opts:      ColOptions<TRow> = {},
): ColumnDef<TRow> {
  return {
    id:           opts.id ?? accessor,
    accessorKey:  accessor,
    header:       opts.header ?? label,
    size:         opts.size    ?? 160,
    minSize:      opts.minSize ?? 120,
    enableSorting:false,
    enableColumnFilter: false,
    meta: makeMeta({
      label,
      labelAr:   opts.headerAr,
      valueType: 'attribution',
      align:     'start',
      hideable:  true,
      defaultPin:opts.pin ?? false,
    }),
  }
}

// ── Table presets ─────────────────────────────────────────────────────────────
// Pre-assembled column sets for specific analytics views.
// Callers can destructure and modify individual columns.

export type EventsTableRow = AnalyticsRow & {
  eventName:      string
  platform:       string
  labelAr?:       string
  conversions:    number
  revenue:        number
  roas:           number
  conversionRate: number
  costPerResult:  number
  deltaRevenue:   number
  deltaConversions:number
  timestamp?:     string
  status?:        string
}

export function eventsTableColumns<TRow extends EventsTableRow>(
  locale: SupportedLocale = 'en-SA',
): ColumnDef<TRow>[] {
  return [
    colEventName<TRow>('eventName',      { locale, pin: 'left' }),
    colPlatform<TRow>('platform',        { locale }),
    colNumber<TRow>('conversions', 'Conversions', { locale, headerAr: 'التحويلات', group: 'volume', groupAr: 'الحجم' }),
    colCurrency<TRow>('revenue', 'Revenue',       { locale, headerAr: 'الإيرادات',  group: 'revenue', groupAr: 'الإيرادات' }),
    colROAS<TRow>('roas',                { locale }),
    colPercent<TRow>('conversionRate', 'CVR',      { locale, headerAr: 'معدل التحويل', asDecimal: true, colorCode: false }),
    colCurrency<TRow>('costPerResult', 'Cost/Result', { locale, headerAr: 'التكلفة/نتيجة', group: 'cost', groupAr: 'التكلفة', format: { decimals: 2 } }),
    colDelta<TRow>('deltaRevenue', 'Revenue Δ',   { locale, headerAr: 'تغيير الإيرادات' }),
    colDelta<TRow>('deltaConversions', 'Conv. Δ', { locale, headerAr: 'تغيير التحويلات' }),
    colTimestamp<TRow>('timestamp', 'Last Seen',  { locale, headerAr: 'آخر ظهور', showRelative: true }),
    colStatus<TRow>('status', 'Status',           { locale, headerAr: 'الحالة' }),
  ]
}

export type AttributionTableRow = AnalyticsRow & {
  channel:         string
  platform:        string
  model:           string
  touchpoints:     number
  assistedRevenue: number
  directRevenue:   number
  totalRevenue:    number
  weightedCredit:  number
  attribution:     import('../core/types').AttributionBreakdown
}

export function attributionTableColumns<TRow extends AttributionTableRow>(
  locale: SupportedLocale = 'en-SA',
): ColumnDef<TRow>[] {
  return [
    colText<TRow>('channel',       'Channel',          { locale, headerAr: 'القناة',          pin: 'left', size: 140 }),
    colPlatform<TRow>('platform',                      { locale }),
    colText<TRow>('model',         'Model',            { locale, headerAr: 'النموذج' }),
    colNumber<TRow>('touchpoints', 'Touchpoints',      { locale, headerAr: 'نقاط التفاعل' }),
    colCurrency<TRow>('assistedRevenue', 'Assisted Revenue', { locale, headerAr: 'الإيرادات المساعدة' }),
    colCurrency<TRow>('directRevenue',   'Direct Revenue',   { locale, headerAr: 'الإيرادات المباشرة' }),
    colCurrency<TRow>('totalRevenue',    'Total Revenue',    { locale, headerAr: 'إجمالي الإيرادات' }),
    colPercent<TRow>('weightedCredit',   'Credit Weight',    { locale, headerAr: 'وزن الائتمان', asDecimal: true }),
    colAttribution<TRow>('attribution',  'Attribution',      { locale, headerAr: 'الإسناد' }),
  ]
}

export type AuditTableRow = AnalyticsRow & {
  action:     string
  entityType: string
  entityId:   string
  userId:     string
  ip:         string
  severity:   string
  timestamp:  string
  payload?:   unknown
}

export function auditTableColumns<TRow extends AuditTableRow>(
  locale: SupportedLocale = 'en-SA',
): ColumnDef<TRow>[] {
  return [
    colTimestamp<TRow>('timestamp', 'Time',       { locale, headerAr: 'الوقت', pin: 'left', size: 160 }),
    colText<TRow>('action',        'Action',      { locale, headerAr: 'الإجراء', size: 180 }),
    colText<TRow>('entityType',    'Entity',      { locale, headerAr: 'النوع' }),
    colId<TRow>('entityId',        'Entity ID',   { locale }),
    colId<TRow>('userId',          'User ID',     { locale }),
    colStatus<TRow>('severity',    'Severity',    { locale, headerAr: 'الخطورة' }),
    colText<TRow>('ip',            'IP Address',  { locale, headerAr: 'عنوان IP' }),
  ]
}
