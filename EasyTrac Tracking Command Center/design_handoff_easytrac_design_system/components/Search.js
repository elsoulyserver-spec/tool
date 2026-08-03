/**
 * Search — Base component
 * ---------------------------------------------------------------
 * API: createSearch({value, placeholder, onChange})
 * Variants: global, scoped (via prop)
 * States: default, focus, with-results
 * Accessibility: role=search on wrapper; results in aria-live region (Pattern layer)
 * Keyboard: "/" focuses from anywhere (bound at app level)
 * RTL: Icon stays at leading edge, flips under RTL
 * Responsive: Full-screen takeover pattern at Pattern layer
 * Token dependencies: --input-*
 * Spec reference: Interaction Spec §3, §13
 * ---------------------------------------------------------------
 */
export function createSearch({ value = '', placeholder = 'Search…', onChange } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'et-search'; wrap.setAttribute('role', 'search');
  wrap.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" stroke-width="1.6"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>';
  const input = document.createElement('input');
  input.value = value; input.placeholder = placeholder;
  if (onChange) input.addEventListener('input', (e) => onChange(e.target.value));
  wrap.appendChild(input);
  return wrap;
}
