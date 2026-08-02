/**
 * DestinationSetup — Pattern (composition)
 * ---------------------------------------------------------------
 * API: createDestinationSetup({steps, credentialProps})
 * Variants: per-destination (Meta, GA4, TikTok…)
 * States: inherits SetupStepper + CredentialField
 * Accessibility: inherits both children
 * Keyboard: inherits both children
 * RTL: inherits both children
 * Responsive: Stacks vertically at all breakpoints
 * Token dependencies: inherits SetupStepper + CredentialField tokens
 * Spec reference: Screen Spec §12, §28
 * ---------------------------------------------------------------
 */
import { createSetupStepper } from '../operational/SetupStepper.js';
import { createCredentialField } from '../operational/CredentialField.js';

/** The Setup Wizard screen composition (Screen Spec §28): stepper + credential entry per destination. */
export function createDestinationSetup({ steps, credentialProps }) {
  const wrap = document.createElement('div');
  wrap.append(createSetupStepper(steps), createCredentialField(credentialProps));
  return wrap;
}
