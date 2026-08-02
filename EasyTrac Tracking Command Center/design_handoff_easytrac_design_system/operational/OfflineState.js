/**
 * OfflineState — Operational component
 * ---------------------------------------------------------------
 * API: createOfflineState(lastDataTime)
 * Variants: default
 * States: n/a
 * Accessibility: Distinct from Critical styling — connectivity, not tracking, is the issue
 * Keyboard: n/a
 * RTL: Text-align flips
 * Responsive: More common on mobile; full parity
 * Token dependencies: --surface-2, --border-default
 * Spec reference: Design System §2 (Blocked/neutral class); Interaction Spec §11, §16, §33
 * ---------------------------------------------------------------
 */
export function createOfflineState(lastDataTime) {
  const el = document.createElement('div');
  el.style.cssText = 'background:var(--surface-2);border:1px solid var(--border-default);border-radius:8px;padding:14px;font-size:12.5px;color:var(--text-secondary);';
  el.textContent = `You're offline — showing the last data we have (${lastDataTime}).`;
  return el;
}
