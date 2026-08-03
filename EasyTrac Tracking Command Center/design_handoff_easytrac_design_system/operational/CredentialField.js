/**
 * CredentialField — Operational component
 * ---------------------------------------------------------------
 * API: createCredentialField({label, maskedValue, verified, verifiedAt, onReplace})
 * Variants: default
 * States: verified, unverified
 * Accessibility: Secret never rendered in full plaintext; monospace for scan-ability, not disclosure
 * Keyboard: Replace button Tab-reachable
 * RTL: Label/input/button order flips
 * Responsive: Stacks Replace button below input on mobile
 * Token dependencies: --input-*, --status-*
 * Spec reference: Design System §11; Interaction Spec §23
 * ---------------------------------------------------------------
 */
export function createCredentialField({ label, maskedValue, verified, verifiedAt, onReplace }) {
  const wrap = document.createElement('div'); wrap.className = 'et-credentialfield';
  const l = document.createElement('label'); l.style.cssText = 'font-size:12.5px;color:var(--text-secondary);'; l.textContent = label;
  const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;margin-top:4px;';
  const input = document.createElement('input'); input.value = maskedValue; input.readOnly = true; input.className = 'et-input';
  const btn = document.createElement('button'); btn.className = 'et-btn et-btn--secondary'; btn.textContent = 'Replace'; btn.addEventListener('click', onReplace);
  row.append(input, btn);
  const status = document.createElement('div'); status.style.cssText = 'display:flex;align-items:center;gap:5px;margin-top:6px;font-size:11.5px;color:' + (verified ? 'var(--status-positive-fg)' : 'var(--status-critical-fg)');
  status.innerHTML = `<span style="width:6px;height:6px;border-radius:50%;background:currentColor;"></span>${verified ? 'Verified ' + verifiedAt : 'Not verified'}`;
  wrap.append(l, row, status);
  return wrap;
}
