/**
 * StackedBar — Chart
 * ---------------------------------------------------------------
 * API: createStackedBar(segments: {pct,color}[])
 * Variants: up to 6 segments + "other" bucket per Design System §23
 * States: n/a
 * Accessibility: Must be paired with a legend/table listing segment labels — color alone is insufficient
 * Keyboard: n/a
 * RTL: Segment order flips under RTL
 * Responsive: Full width
 * Token dependencies: --p-brand-500 and related primitives (chart series colors, not status colors)
 * Spec reference: Design System §23
 * ---------------------------------------------------------------
 */
export function createStackedBar(segments) {
  // segments: [{ pct, color }]
  const el = document.createElement('div'); el.style.cssText = 'display:flex;height:28px;border-radius:4px;overflow:hidden;';
  segments.forEach(seg => { const d = document.createElement('div'); d.style.cssText = `width:${seg.pct}%;background:${seg.color};`; el.appendChild(d); });
  return el;
}
