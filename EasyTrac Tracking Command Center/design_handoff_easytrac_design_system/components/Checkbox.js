/**
 * Checkbox — Base component
 * ---------------------------------------------------------------
 * API: createCheckbox({checked, indeterminate, onChange, label})
 * Variants: default, indeterminate
 * States: checked, unchecked, indeterminate, disabled
 * Accessibility: Native checkbox + associated label
 * Keyboard: Space toggles
 * RTL: Label sits after checkbox, flips in RTL
 * Responsive: 44px hit target on touch
 * Token dependencies: --brand (accent-color)
 * Spec reference: Interaction Spec §7
 * ---------------------------------------------------------------
 */
export function createCheckbox({ checked = false, indeterminate = false, onChange, label = '' } = {}) {
  const wrapper = document.createElement('label');
  wrapper.style.cssText = 'display:flex;align-items:center;gap:7px;font-size:13px;';
  const input = document.createElement('input');
  input.type = 'checkbox'; input.className = 'et-checkbox'; input.checked = checked; input.indeterminate = indeterminate;
  if (onChange) input.addEventListener('change', (e) => onChange(e.target.checked));
  wrapper.appendChild(input); wrapper.append(label);
  return wrapper;
}
