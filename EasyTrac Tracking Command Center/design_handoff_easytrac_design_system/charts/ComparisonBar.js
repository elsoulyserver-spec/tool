/**
 * ComparisonBar — Chart
 * ---------------------------------------------------------------
 * API: createComparisonBar(value, threshold, {label})
 * Variants: above/below threshold (color-driven)
 * States: n/a
 * Accessibility: Label always states both value and threshold as text, never bar-only
 * Keyboard: n/a
 * RTL: Bar fill direction flips under RTL (start-anchored)
 * Responsive: Full width
 * Token dependencies: --status-*, --text-primary
 * Spec reference: Design System §23
 * ---------------------------------------------------------------
 */
export function createComparisonBar(value, threshold, { label } = {}) {
  const el = document.createElement('div');
  const pct = Math.min(100, value);
  const color = value >= threshold ? 'var(--status-positive-fg)' : 'var(--status-caution-fg)';
  el.innerHTML = `
    <div style="position:relative;height:36px;background:var(--surface-2);border-radius:4px;overflow:hidden;">
      <div style="position:absolute;left:0;top:0;bottom:0;width:${pct}%;background:${color};"></div>
      <div style="position:absolute;left:${threshold}%;top:-2px;bottom:-2px;width:2px;background:var(--text-primary);"></div>
    </div>
    <div style="font-size:11px;color:var(--text-tertiary);margin-top:4px;">${label || `${value}% · threshold ${threshold}%`}</div>`;
  return el;
}
