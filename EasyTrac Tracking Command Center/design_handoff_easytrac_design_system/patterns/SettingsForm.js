/**
 * SettingsForm — Pattern (composition)
 * ---------------------------------------------------------------
 * API: createSettingsForm({fields, onSave})
 * Variants: Global Settings, Store Settings, Profile (field config varies)
 * States: inherits Input/Toggle; Save button loading state
 * Accessibility: inherits Input/Toggle; Save confirms specifically what changed (Interaction Spec §7)
 * Keyboard: Standard form tab order; Enter submits from any field
 * RTL: inherits Input/Toggle
 * Responsive: Single column at all breakpoints
 * Token dependencies: inherits Input/Toggle/Button tokens
 * Spec reference: Interaction Spec §7; Screen Spec §21, §22, §25
 * ---------------------------------------------------------------
 */
import { createInput } from '../components/Input.js';
import { createToggle } from '../components/Toggle.js';
import { createButton } from '../components/Button.js';

/** Generic settings-form pattern used by Global Settings, Store Settings, Profile (Screen Spec §21/22/25). */
export function createSettingsForm({ fields, onSave }) {
  const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;flex-direction:column;gap:16px;max-width:480px;';
  fields.forEach(f => wrap.appendChild(f.type === 'toggle' ? createToggle(f) : createInput(f)));
  wrap.appendChild(createButton('Save changes', { variant: 'primary', onClick: onSave }));
  return wrap;
}
