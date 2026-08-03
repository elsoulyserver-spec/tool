/**
 * Wizard — Pattern (composition)
 * ---------------------------------------------------------------
 * API: createWizard({steps, currentIndex, renderStepContent, onNext, onBack})
 * Variants: Setup Wizard, Onboarding
 * States: per-step done/active/todo via ProgressTrace
 * Accessibility: Step content region gets aria-live=polite on step change
 * Keyboard: Back/Continue Tab-reachable; Enter on last field advances
 * RTL: Back/Continue swap visual order (Continue stays trailing edge)
 * Responsive: Trace may abbreviate to "Step n of m" below 768px
 * Token dependencies: inherits ProgressTrace + Button tokens
 * Spec reference: Screen Spec §27, §28
 * ---------------------------------------------------------------
 */
import { createProgressTrace } from '../operational/ProgressTrace.js';
import { createButton } from '../components/Button.js';

/** Generic multi-step wizard shell (Setup Wizard, Onboarding) — one step's content visible at a time. */
export function createWizard({ steps, currentIndex, renderStepContent, onNext, onBack }) {
  const wrap = document.createElement('div');
  const trace = createProgressTrace(steps.map((s, i) => ({ label: s.label, status: i < currentIndex ? 'done' : i === currentIndex ? 'active' : 'todo' })));
  const content = renderStepContent(currentIndex);
  const nav = document.createElement('div'); nav.style.cssText = 'display:flex;justify-content:space-between;margin-top:20px;';
  const back = createButton('Back', { variant: 'secondary', onClick: onBack, disabled: currentIndex === 0 });
  const next = createButton(currentIndex === steps.length - 1 ? 'Finish' : 'Continue', { variant: 'primary', onClick: onNext });
  nav.append(back, next);
  wrap.append(trace, content, nav);
  return wrap;
}
