/**
 * CredentialEntry — Pattern (composition)
 * ---------------------------------------------------------------
 * API: createCredentialEntry(fields: Array<InputProps|CredentialFieldProps>)
 * Variants: n/a
 * States: inherits Input + CredentialField
 * Accessibility: inherits both children
 * Keyboard: Tab order follows field order
 * RTL: inherits Input/CredentialField
 * Responsive: Full-width single column always
 * Token dependencies: inherits Input + CredentialField tokens
 * Spec reference: Interaction Spec §23; Screen Spec §12
 * ---------------------------------------------------------------
 */
import { createCredentialField } from '../operational/CredentialField.js';
import { createInput } from '../components/Input.js';

/** A full credential-entry form block, combining plain fields with masked CredentialFields. */
export function createCredentialEntry(fields) {
  const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;flex-direction:column;gap:14px;max-width:360px;';
  fields.forEach(f => wrap.appendChild(f.masked ? createCredentialField(f) : createInput(f)));
  return wrap;
}
