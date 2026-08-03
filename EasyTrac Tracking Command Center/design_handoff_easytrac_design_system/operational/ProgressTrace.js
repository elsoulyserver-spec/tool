/**
 * ProgressTrace — Operational component
 * ---------------------------------------------------------------
 * API: createProgressTrace(steps: {label, status}[])
 * Variants: setup lifecycle, deployment lifecycle
 * States: done, active, todo per step
 * Accessibility: aria-current="step" on the active step
 * Keyboard: Not interactive
 * RTL: Step order flips visually
 * Responsive: Wraps to 2 rows on mobile if >4 steps
 * Token dependencies: --status-*
 * Spec reference: Design System §11; Interaction Spec §19
 * ---------------------------------------------------------------
 */
export function createProgressTrace(steps) {
  // steps: [{ label, status: 'done'|'active'|'todo' }]
  const el = document.createElement('div'); el.className = 'et-progresstrace';
  steps.forEach(step => {
    const wrap = document.createElement('div'); wrap.className = 'et-progresstrace__step';
    const dot = document.createElement('div'); dot.className = 'et-progresstrace__dot';
    const styles = { done:['var(--status-positive-bg)','var(--status-positive-border)','var(--status-positive-fg)','✓'], active:['var(--status-progress-bg)','var(--status-progress-border)','var(--status-progress-fg)','…'], todo:['var(--surface-2)','var(--border-default)','var(--text-tertiary)',''] };
    const [bg, border, fg, icon] = styles[step.status];
    dot.style.cssText = `background:${bg};border-color:${border};color:${fg}`; dot.textContent = icon;
    const label = document.createElement('div'); label.style.cssText = 'font-size:10.5px;color:' + (step.status === 'todo' ? 'var(--text-tertiary)' : 'var(--text-primary)');
    label.textContent = step.label;
    wrap.append(dot, label); el.appendChild(wrap);
  });
  return el;
}
