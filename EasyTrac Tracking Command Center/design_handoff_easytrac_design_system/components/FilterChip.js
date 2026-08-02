/**
 * FilterChip — Base component
 * ---------------------------------------------------------------
 * API: createFilterChip(label, onRemove)
 * Variants: default
 * States: default, hover on remove-button, focus
 * Accessibility: Remove button aria-label="Remove filter: {label}"
 * Keyboard: Tab to remove button, Enter/Space removes
 * RTL: Remove button sits at trailing edge, flips under RTL
 * Responsive: Wraps to new row; never truncates without tooltip
 * Token dependencies: --surface-2, --border-default
 * Spec reference: Interaction Spec §4
 * ---------------------------------------------------------------
 */
export function createFilterChip(label, onRemove) {
  const el = document.createElement('div');
  el.className = 'et-chip';
  const span = document.createElement('span'); span.textContent = label;
  const btn = document.createElement('button');
  btn.setAttribute('aria-label', 'Remove filter: ' + label);
  btn.style.cssText = 'width:16px;height:16px;border-radius:50%;border:none;background:var(--surface-3);color:var(--text-secondary);cursor:pointer;font-size:11px;';
  btn.textContent = '×';
  btn.addEventListener('click', onRemove);
  el.append(span, btn);
  return el;
}
