/**
 * DeploymentProgress — Pattern (composition)
 * ---------------------------------------------------------------
 * API: createDeploymentProgress({steps, currentMessage})
 * Variants: n/a
 * States: each step done/active/todo; currentMessage updates live
 * Accessibility: aria-live=polite wraps currentMessage for screen readers
 * Keyboard: Not interactive (progress display only)
 * RTL: inherits ProgressTrace
 * Responsive: inherits ProgressTrace
 * Token dependencies: inherits ProgressTrace + LoadingState tokens
 * Spec reference: Interaction Spec §19; Screen Spec §7, §8
 * ---------------------------------------------------------------
 */
import { createProgressTrace } from '../operational/ProgressTrace.js';
import { createLoadingState } from '../operational/LoadingState.js';

/** Real step-by-step deployment progress, never a bare spinner (Interaction Spec §19). */
export function createDeploymentProgress({ steps, currentMessage }) {
  const wrap = document.createElement('div');
  wrap.append(createProgressTrace(steps), createLoadingState(currentMessage));
  return wrap;
}
