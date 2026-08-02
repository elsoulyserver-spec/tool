/**
 * statusMap.js — the single source of truth mapping the 14 approved states
 * (Design System §2) onto the 5 visual classes and their component tokens.
 * No component may import status colors from anywhere else.
 */
const CLASS_BY_STATE = {
  Healthy: 'positive',
  Connected: 'progress', Syncing: 'progress', Provisioning: 'progress', Deploying: 'progress',
  Publishing: 'progress', 'Awaiting Verification': 'progress',
  Warning: 'caution', Degraded: 'caution',
  Error: 'critical', 'Offline / Disconnected': 'critical', Suspended: 'critical',
  'Needs Action': 'blocked', 'Pending DNS': 'blocked', Paused: 'blocked', 'Expired Trial': 'blocked',
};
export function statusClass(state) {
  const cls = CLASS_BY_STATE[state];
  if (!cls) throw new Error(`Unknown state "${state}" — only the 14 approved states are valid (Design System §2).`);
  return cls;
}
export function statusColors(cls) {
  return { fg: `var(--status-${cls}-fg)`, bg: `var(--status-${cls}-bg)`, border: `var(--status-${cls}-border)` };
}
