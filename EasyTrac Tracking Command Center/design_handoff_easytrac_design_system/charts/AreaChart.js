/**
 * AreaChart — Chart
 * ---------------------------------------------------------------
 * API: createAreaChart(points, expected, {color})
 * Variants: n/a (always paired with expected-volume band per Design System §23)
 * States: n/a
 * Accessibility: role=img + aria-label naming both series
 * Keyboard: n/a
 * RTL: Not mirrored (chronological convention)
 * Responsive: Scales via viewBox
 * Token dependencies: --status-progress-*, --border-strong
 * Spec reference: Design System §23
 * ---------------------------------------------------------------
 */
export function createAreaChart(points, expected, { color = 'var(--status-progress-fg)' } = {}) {
  const w = 600, hgt = 80;
  const max = Math.max(...points, ...expected), min = 0;
  const y = (v) => hgt - ((v - min) / (max - min || 1)) * hgt;
  const actualPts = points.map((p, i) => `${(i / (points.length - 1)) * w},${y(p)}`).join(' ');
  const expectedPts = expected.map((p, i) => `${(i / (expected.length - 1)) * w},${y(p)}`).join(' ');
  const areaPath = 'M' + points.map((p, i) => `${(i / (points.length - 1)) * w},${y(p)}`).join(' L') + ` L${w},${hgt} L0,${hgt} Z`;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`); svg.setAttribute('width', '100%'); svg.setAttribute('height', hgt); svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Event throughput vs expected volume');
  svg.innerHTML = `<polyline points="${expectedPts}" fill="none" stroke="var(--border-strong)" stroke-width="1" stroke-dasharray="4,4"/><path d="${areaPath}" fill="${color.replace('fg','bg')}" stroke="${color}" stroke-width="2"/>`;
  return svg;
}
