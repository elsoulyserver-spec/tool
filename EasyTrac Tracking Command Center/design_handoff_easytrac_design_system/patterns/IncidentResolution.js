/**
 * IncidentResolution — Pattern (composition)
 * ---------------------------------------------------------------
 * API: openIncidentResolution(incident)
 * Variants: n/a
 * States: open/closed via Drawer
 * Accessibility: inherits Drawer focus trap + EventTrace step semantics
 * Keyboard: inherits Drawer (Esc closes, focus returns to trigger)
 * RTL: inherits Drawer slide-from-trailing-edge
 * Responsive: Drawer becomes full-screen sheet below 768px
 * Token dependencies: inherits Drawer + EventTrace tokens
 * Spec reference: Screen Spec Screen Relationship Map — Troubleshooting flow
 * ---------------------------------------------------------------
 */
import { createIncidentCard } from '../operational/IncidentCard.js';
import { createEventTrace } from '../operational/EventTrace.js';
import { createDrawer } from '../components/Drawer.js';

/** The troubleshooting-flow pattern: IncidentCard → drawer with EventTrace → InlineFix, per Screen Spec's Screen Relationship Map. */
export function openIncidentResolution(incident) {
  const trace = createEventTrace(incident.traceSteps);
  return createDrawer({ title: incident.title, content: trace, onClose: incident.onClose });
}
export { createIncidentCard };
