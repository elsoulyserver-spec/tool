/**
 * Input — Base component
 * ---------------------------------------------------------------
 * API: createInput({value, placeholder, error, onChange, type})
 * Variants: text, error
 * States: default, focus, error, disabled
 * Accessibility: aria-invalid + aria-describedby link error text
 * Keyboard: Standard text field behavior
 * RTL: Text direction follows dir; label stays at start
 * Responsive: Full-width; native mobile keyboard per type
 * Token dependencies: --input-*
 * Spec reference: Interaction Spec §7
 * ---------------------------------------------------------------
 */
export function createInput({ value = '', placeholder = '', error = '', onChange, type = 'text' } = {}) {
  const wrap = document.createElement('div');
  const input = document.createElement('input');
  input.type = type; input.value = value; input.placeholder = placeholder;
  input.className = 'et-input' + (error ? ' et-input--error' : '');
  if (error) input.setAttribute('aria-invalid', 'true');
  if (onChange) input.addEventListener('input', (e) => onChange(e.target.value));
  wrap.appendChild(input);
  if (error) {
    const err = document.createElement('div');
    err.style.cssText = 'font-size:11.5px;color:var(--status-critical-fg);margin-top:4px;';
    err.textContent = error;
    const id = 'err-' + Math.random().toString(36).slice(2);
    err.id = id; input.setAttribute('aria-describedby', id);
    wrap.appendChild(err);
  }
  return wrap;
}
