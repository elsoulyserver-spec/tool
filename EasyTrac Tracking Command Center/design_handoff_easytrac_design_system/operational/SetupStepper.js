/**
 * SetupStepper — Operational component
 * ---------------------------------------------------------------
 * API: createSetupStepper(steps)
 * Variants: n/a — thin alias over ProgressTrace
 * States: inherits ProgressTrace states
 * Accessibility: inherits ProgressTrace
 * Keyboard: inherits ProgressTrace
 * RTL: inherits ProgressTrace
 * Responsive: inherits ProgressTrace
 * Token dependencies: inherits ProgressTrace tokens
 * Spec reference: Design System §11, §28
 * ---------------------------------------------------------------
 */
import { createProgressTrace } from './ProgressTrace.js';
export function createSetupStepper(steps) { return createProgressTrace(steps); } // Setup lifecycle is a ProgressTrace instance (Design System §11)
