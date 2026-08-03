/**
 * Status icons — the five fixed semantic glyph shapes (Design System §22).
 * 24px grid, 1.5px stroke. Never used for anything other than status communication.
 * Sizes: 16 / 20 / 24px only — scale via the "size" param, no intermediate sizes.
 */
export const STATUS_ICON_PATHS = {
  positive: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9"/>',
  progress: '<path d="M12 3a9 9 0 1 1-6.36 2.64"/>',
  caution: '<path d="M12 4l9 15H3z"/><circle cx="12" cy="15" r="0.8" fill="currentColor"/>',
  critical: '<path d="M12 3l9 9-9 9-9-9z"/><path d="M12 9v4"/><circle cx="12" cy="16" r="0.6" fill="currentColor"/>',
  blocked: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 12h6"/>',
};
export function createStatusIcon(cls, { size = 20 } = {}) {
  if (![16, 20, 24].includes(size)) throw new Error('Icon size must be 16, 20, or 24 (Design System §22).');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', size); svg.setAttribute('height', size); svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', `var(--status-${cls}-fg)`); svg.setAttribute('stroke-width', '1.5');
  svg.innerHTML = STATUS_ICON_PATHS[cls];
  return svg;
}
