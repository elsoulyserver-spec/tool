/**
 * LineChart — Chart
 * ---------------------------------------------------------------
 * API: createLineChart(points, {bands})
 * Variants: with/without reference bands
 * States: n/a
 * Accessibility: role=img + aria-label; consider an adjacent data table for full AT access
 * Keyboard: n/a
 * RTL: Chronological axis not mirrored under RTL
 * Responsive: Scales via viewBox
 * Token dependencies: --status-*, --text-primary
 * Spec reference: Design System §23
 * ---------------------------------------------------------------
 */
export function createLineChart(points, { bands } = {}) {
  // bands: [{ from, to, color }] rendered as reference zones — thresholds must always be visible (Design System §23)
  const w = 600, hgt = 90;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`); svg.setAttribute('width', '100%'); svg.setAttribute('height', hgt); svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Health trend with threshold bands');
  let bandRects = '';
  (bands || []).forEach(b => { bandRects += `<rect x="0" y="${b.from}" width="${w}" height="${b.to - b.from}" fill="${b.color}"/>`; });
  const max = Math.max(...points), min = Math.min(...points);
  const norm = points.map((p, i) => `${(i / (points.length - 1)) * w},${hgt - ((p - min) / (max - min || 1)) * hgt}`).join(' ');
  svg.innerHTML = bandRects + `<polyline points="${norm}" fill="none" stroke="var(--text-primary)" stroke-width="2"/>`;
  return svg;
}
