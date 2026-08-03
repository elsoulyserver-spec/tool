/**
 * PermissionDeniedState — Operational component
 * ---------------------------------------------------------------
 * API: createPermissionDeniedState(message)
 * Variants: default
 * States: n/a
 * Accessibility: Message always names who can grant access, per Interaction Spec §12
 * Keyboard: n/a (action composed at call site)
 * RTL: Text-align flips
 * Responsive: Full parity
 * Token dependencies: --status-blocked-*
 * Spec reference: Screen Spec §32; Interaction Spec §12
 * ---------------------------------------------------------------
 */
export function createPermissionDeniedState(message) {
  const el = document.createElement('div');
  el.style.cssText = 'background:var(--status-blocked-bg);border:1px solid var(--status-blocked-border);border-radius:8px;padding:14px;font-size:12.5px;color:var(--text-secondary);';
  el.textContent = message;
  return el;
}
