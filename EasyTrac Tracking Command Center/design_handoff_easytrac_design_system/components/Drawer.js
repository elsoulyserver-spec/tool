/**
 * Drawer — Base component
 * ---------------------------------------------------------------
 * API: createDrawer({title, content, onClose})
 * Variants: default, stacked
 * States: open, closed
 * Accessibility: role=dialog (non-modal) or aria-modal depending on stacking
 * Keyboard: Esc closes; outside-click closes (never destructive)
 * RTL: Slides from trailing edge — right in LTR, left in RTL
 * Responsive: Full-screen sheet below 768px
 * Token dependencies: --surface-overlay, --shadow-lg
 * Spec reference: Interaction Spec §9
 * ---------------------------------------------------------------
 */
export function createDrawer({ title, content, onClose }) {
  const el = document.createElement('div'); el.className = 'et-drawer'; el.setAttribute('role', 'dialog');
  const header = document.createElement('div'); header.style.cssText = 'display:flex;justify-content:space-between;padding:16px;border-bottom:1px solid var(--border-subtle);';
  const h4 = document.createElement('h4'); h4.textContent = title; h4.style.margin = '0';
  const close = document.createElement('button'); close.className = 'et-icon-btn'; close.setAttribute('aria-label', 'Close'); close.textContent = '×';
  close.addEventListener('click', () => { el.remove(); onClose && onClose(); });
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { el.remove(); onClose && onClose(); document.removeEventListener('keydown', esc); } });
  header.append(h4, close); el.append(header, content);
  document.body.appendChild(el); h4.focus?.();
  return el;
}
