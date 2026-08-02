/**
 * Radio — Base component
 * ---------------------------------------------------------------
 * API: createRadio(name, {checked, onChange, label})
 * Variants: default
 * States: checked, unchecked, disabled
 * Accessibility: Native radio group, shared name
 * Keyboard: Arrow keys move within group (native)
 * RTL: Same as Checkbox
 * Responsive: 44px hit target
 * Token dependencies: --brand
 * Spec reference: Interaction Spec §7
 * ---------------------------------------------------------------
 */
export function createRadio(name, { checked = false, onChange, label = '' } = {}) {
  const wrapper = document.createElement('label');
  wrapper.style.cssText = 'display:flex;align-items:center;gap:7px;font-size:13px;';
  const input = document.createElement('input');
  input.type = 'radio'; input.name = name; input.className = 'et-radio'; input.checked = checked;
  if (onChange) input.addEventListener('change', (e) => onChange(e.target.checked));
  wrapper.appendChild(input); wrapper.append(label);
  return wrapper;
}
