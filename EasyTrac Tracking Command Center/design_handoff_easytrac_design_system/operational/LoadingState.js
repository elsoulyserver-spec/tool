/**
 * LoadingState — Operational component
 * ---------------------------------------------------------------
 * API: createLoadingState(message)
 * Variants: default
 * States: n/a
 * Accessibility: aria-live=polite recommended at mount site
 * Keyboard: n/a
 * RTL: Spinner position flips to trailing edge
 * Responsive: Full parity
 * Token dependencies: --brand, --border-strong
 * Spec reference: Design System §15; Interaction Spec §11
 * ---------------------------------------------------------------
 */
export function createLoadingState(message) {
  const el = document.createElement('div');
  el.style.cssText = 'background:var(--surface-1);border:1px solid var(--border-subtle);border-radius:8px;padding:14px;display:flex;gap:10px;align-items:center;';
  el.innerHTML = `<span style="width:16px;height:16px;border:2px solid var(--border-strong);border-top-color:var(--brand);border-radius:50%;animation:et-spin .7s linear infinite;"></span><span style="font-size:12.5px;color:var(--text-secondary);">${message}</span>`;
  return el;
}
