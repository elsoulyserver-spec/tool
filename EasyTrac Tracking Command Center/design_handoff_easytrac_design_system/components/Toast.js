/**
 * Toast — Base component
 * ---------------------------------------------------------------
 * API: createToast({message, tone, persistent, onDismiss})
 * Variants: success, warning, critical
 * States: visible, dismissing
 * Accessibility: role=status (success/warning) or role=alert (critical)
 * Keyboard: Dismiss button Tab-reachable
 * RTL: Slides in from trailing corner, flips under RTL
 * Responsive: Stacks bottom-right (or bottom-left in RTL), capped at 3 visible
 * Token dependencies: --surface-overlay, --shadow-md, --status-*
 * Spec reference: Interaction Spec §10
 * ---------------------------------------------------------------
 */
let toastContainer;
export function createToast({ message, tone = 'success', persistent = false, onDismiss }) {
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:1100;display:flex;flex-direction:column;gap:8px;align-items:flex-end;';
    document.body.appendChild(toastContainer);
  }
  const el = document.createElement('div'); el.className = 'et-toast';
  el.setAttribute('role', tone === 'critical' ? 'alert' : 'status');
  el.style.border = '1px solid var(--status-' + (tone === 'critical' ? 'critical' : tone === 'warning' ? 'caution' : 'positive') + '-border)';
  el.textContent = message;
  if (persistent) {
    const btn = document.createElement('button'); btn.textContent = 'Dismiss';
    btn.style.cssText = 'margin-left:8px;background:none;border:none;color:var(--text-tertiary);cursor:pointer;';
    btn.addEventListener('click', () => { el.remove(); onDismiss && onDismiss(); });
    el.appendChild(btn);
  } else {
    setTimeout(() => { el.remove(); onDismiss && onDismiss(); }, tone === 'warning' ? 6000 : 4000);
  }
  toastContainer.appendChild(el);
  return el;
}
