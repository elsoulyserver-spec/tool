/**
 * Sparkline — Chart
 * ---------------------------------------------------------------
 * API: createSparkline(points: number[], {color})
 * Variants: positive/critical/neutral via color param
 * States: n/a (static render)
 * Accessibility: role=img + aria-label describing the trend
 * Keyboard: n/a
 * RTL: Point order stays chronological left-to-right even under RTL (data convention, not mirrored)
 * Responsive: Scales via viewBox + 100% width
 * Token dependencies: --status-*
 * Spec reference: Design System §23
 * ---------------------------------------------------------------
 */
export function createSparkline(points, { color = 'var(--status-positive-fg)' } = {}) {
  const w = 200, hgt = 36;
  const max = Math.max(...points), min = Math.min(...points);
  const norm = points.map((p, i) => `${(i / (points.length - 1)) * w},${hgt - ((p - min) / (max - min || 1)) * hgt}`).join(' ');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`); svg.setAttribute('width', '100%'); svg.setAttribute('height', hgt); svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Trend sparkline');
  svg.innerHTML = `<polyline points="${norm}" fill="none" stroke="${color}" stroke-width="2"/>`;
  return svg;
}
