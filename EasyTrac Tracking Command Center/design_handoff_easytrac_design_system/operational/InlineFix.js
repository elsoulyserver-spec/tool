/**
 * InlineFix — Operational component
 * ---------------------------------------------------------------
 * API: createInlineFix(label, onClick)
 * Variants: reconnect, retry, remap (label-driven)
 * States: default, hover, disabled
 * Accessibility: Label always states the specific fix, never generic "Fix"
 * Keyboard: Tab + Enter/Space
 * RTL: Standard button mirroring
 * Responsive: Full-width on mobile action bars
 * Token dependencies: --button-danger-*
 * Spec reference: Design System §11; Interaction Spec §7
 * ---------------------------------------------------------------
 */
export function createInlineFix(label, onClick) {
  const btn = document.createElement('button'); btn.className = 'et-btn et-btn--danger'; btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}
