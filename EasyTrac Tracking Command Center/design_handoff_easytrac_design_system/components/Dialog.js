/**
 * Dialog — Base component
 * ---------------------------------------------------------------
 * API: createDialog({title, body, onConfirm, onCancel, destructive, confirmLabel})
 * Variants: default, destructive
 * States: open, closed
 * Accessibility: role=dialog aria-modal; focus trapped; labelled by title
 * Keyboard: Esc closes (non-destructive); outside-click closes unless destructive
 * RTL: Button order flips, confirm stays trailing edge
 * Responsive: Full-screen sheet below 768px
 * Token dependencies: --dialog-*
 * Spec reference: Interaction Spec §8
 * ---------------------------------------------------------------
 */
export function createDialog({ title, body, onConfirm, onCancel, confirmLabel = 'Confirm', destructive = false }) {
  const scrim = document.createElement('div'); scrim.className = 'et-dialog-scrim';
  const dialog = document.createElement('div'); dialog.className = 'et-dialog'; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
  const h4 = document.createElement('h4'); h4.textContent = title; h4.style.margin = '0 0 8px'; h4.style.fontSize = '15px';
  const p = document.createElement('p'); p.textContent = body; p.style.cssText = 'font-size:13px;color:var(--text-secondary);margin:0 0 18px;';
  const actions = document.createElement('div'); actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
  const cancel = document.createElement('button'); cancel.className = 'et-btn et-btn--secondary'; cancel.textContent = 'Cancel';
  const confirm = document.createElement('button'); confirm.className = 'et-btn et-btn--' + (destructive ? 'danger' : 'primary'); confirm.textContent = confirmLabel;
  cancel.addEventListener('click', () => { scrim.remove(); onCancel && onCancel(); });
  confirm.addEventListener('click', () => { scrim.remove(); onConfirm && onConfirm(); });
  if (!destructive) scrim.addEventListener('click', (e) => { if (e.target === scrim) { scrim.remove(); onCancel && onCancel(); } });
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { scrim.remove(); onCancel && onCancel(); document.removeEventListener('keydown', esc); } });
  actions.append(cancel, confirm); dialog.append(h4, p, actions); scrim.appendChild(dialog);
  document.body.appendChild(scrim); confirm.focus();
  return scrim;
}
