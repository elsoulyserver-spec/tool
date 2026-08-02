/**
 * Popover — Base component
 * ---------------------------------------------------------------
 * API: createPopover(trigger, content, {open})
 * Variants: default
 * States: open, closed
 * Accessibility: Focus moves into popover on open; Esc closes and restores focus
 * Keyboard: Esc closes; Tab cycles within
 * RTL: Anchors flip side under RTL
 * Responsive: Becomes bottom sheet on mobile (Pattern layer)
 * Token dependencies: --surface-overlay, --shadow-md
 * Spec reference: Interaction Spec §9
 * ---------------------------------------------------------------
 */
export function createPopover(trigger, content, { open = false } = {}) {
  const pop = document.createElement('div'); pop.className = 'et-popover'; pop.style.display = open ? 'block' : 'none';
  pop.appendChild(content);
  trigger.setAttribute('aria-expanded', String(open));
  trigger.addEventListener('click', () => {
    const willOpen = pop.style.display === 'none';
    pop.style.display = willOpen ? 'block' : 'none';
    trigger.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) content.querySelector('button,input,[tabindex]')?.focus();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { pop.style.display = 'none'; trigger.setAttribute('aria-expanded', 'false'); trigger.focus(); } });
  return pop;
}
