/**
 * ResumeAction — Operational component
 * ---------------------------------------------------------------
 * API: createResumeAction(label, onClick)
 * Variants: resume, upgrade
 * States: default, hover
 * Accessibility: Visually and semantically distinct from InlineFix — never conflated
 * Keyboard: Tab + Enter/Space
 * RTL: Standard button mirroring
 * Responsive: Full-width on mobile
 * Token dependencies: --brand
 * Spec reference: Design System §11
 * ---------------------------------------------------------------
 */
export function createResumeAction(label, onClick) {
  const btn = document.createElement('button'); btn.textContent = label;
  btn.style.cssText = 'background:var(--surface-2);border:1px solid var(--brand);color:var(--brand);border-radius:var(--button-radius);padding:8px 14px;font-size:12.5px;font-weight:600;cursor:pointer;';
  btn.addEventListener('click', onClick);
  return btn;
}
