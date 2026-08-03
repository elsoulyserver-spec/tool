/**
 * EmptyState — Operational component
 * ---------------------------------------------------------------
 * API: createEmptyState(message)
 * Variants: not-yet-set-up, healthy-empty, filtered-empty, search-empty, failure (message-driven)
 * States: n/a
 * Accessibility: Plain text, always paired with an action at call site (never a dead end)
 * Keyboard: n/a (message only; actions composed at call site)
 * RTL: Text-align flips
 * Responsive: Full parity
 * Token dependencies: --surface-1, --border-default
 * Spec reference: Design System §13; Interaction Spec §21
 * ---------------------------------------------------------------
 */
export function createEmptyState(message) {
  const el = document.createElement('div');
  el.style.cssText = 'background:var(--surface-1);border:1px dashed var(--border-default);border-radius:8px;padding:24px;text-align:center;color:var(--text-tertiary);font-size:12.5px;';
  el.textContent = message;
  return el;
}
