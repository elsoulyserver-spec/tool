/**
 * Select — Base component
 * ---------------------------------------------------------------
 * API: createSelect(options, {value, onChange})
 * Variants: default
 * States: default, focus, disabled
 * Accessibility: Native <select> for full AT support
 * Keyboard: Arrow keys native; Enter selects
 * RTL: Native browser RTL handling
 * Responsive: Full-width
 * Token dependencies: --input-*
 * Spec reference: Interaction Spec §7
 * ---------------------------------------------------------------
 */
export function createSelect(options, { value, onChange } = {}) {
  const el = document.createElement('select');
  el.className = 'et-select';
  options.forEach(opt => {
    const o = document.createElement('option');
    o.value = opt.value ?? opt; o.textContent = opt.label ?? opt;
    if (o.value === value) o.selected = true;
    el.appendChild(o);
  });
  if (onChange) el.addEventListener('change', (e) => onChange(e.target.value));
  return el;
}
