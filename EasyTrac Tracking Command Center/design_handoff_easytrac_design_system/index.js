/**
 * index.js — the system's public entry point. Import from here (or directly
 * from a category folder) — never reach into a component's internals.
 *
 * Load order for the CSS layer (plain <link> tags, no bundler required):
 *   1. tokens/primitives.css
 *   2. tokens/semantic.dark.css   (+ tokens/semantic.light.css if you support both themes)
 *   3. tokens/density.css
 *   4. tokens/component-tokens.css
 *   5. tokens/motion.css
 *   6. layout/layout.css
 *   7. components/components.css
 *   8. operational/operational.css
 *
 * Then set <html data-theme="dark" data-density="medium" dir="ltr"> (or your
 * app's equivalents) before any component renders.
 */

// Layout primitives
export * from './layout/AppShell.js';
export * from './layout/Page.js';
export * from './layout/Workspace.js';
export * from './layout/Panel.js';
export * from './layout/Section.js';
export * from './layout/Inspector.js';
export * from './layout/SplitView.js';
export * from './layout/Toolbar.js';

// Base components
export * from './components/Button.js';
export * from './components/IconButton.js';
export * from './components/Input.js';
export * from './components/Select.js';
export * from './components/Checkbox.js';
export * from './components/Radio.js';
export * from './components/Toggle.js';
export * from './components/Search.js';
export * from './components/FilterChip.js';
export * from './components/Tabs.js';
export * from './components/Tooltip.js';
export * from './components/Popover.js';
export * from './components/Dialog.js';
export * from './components/Drawer.js';
export * from './components/Toast.js';
export * from './components/Pagination.js';
export * from './components/Breadcrumbs.js';
export * from './components/Sidebar.js';
export * from './components/StoreSwitcher.js';
export * from './components/CommandPalette.js';
export * from './components/DataTable.js';

// Operational components
export * from './operational/statusMap.js';
export * from './operational/HealthScore.js';
export * from './operational/StatusChip.js';
export * from './operational/StatusBanner.js';
export * from './operational/ProgressTrace.js';
export * from './operational/EventTrace.js';
export * from './operational/IncidentCard.js';
export * from './operational/InlineFix.js';
export * from './operational/ResumeAction.js';
export * from './operational/SetupStepper.js';
export * from './operational/CredentialField.js';
export * from './operational/DestinationRow.js';
export * from './operational/NotificationItem.js';
export * from './operational/EmptyState.js';
export * from './operational/LoadingState.js';
export * from './operational/PermissionDeniedState.js';
export * from './operational/OfflineState.js';

// Charts
export * from './charts/Sparkline.js';
export * from './charts/LineChart.js';
export * from './charts/AreaChart.js';
export * from './charts/ComparisonBar.js';
export * from './charts/StackedBar.js';
export * from './charts/IncidentTimeline.js';

// Icons
export * from './icons/statusIcons.js';

// Patterns (compositions — import directly from patterns/* in real usage;
// re-exported here only for discoverability)
export * from './patterns/SearchFilterTable.js';
export * from './patterns/IncidentResolution.js';
export * from './patterns/DeploymentProgress.js';
export * from './patterns/DestinationSetup.js';
export * from './patterns/CredentialEntry.js';
export * from './patterns/SettingsForm.js';
export * from './patterns/Wizard.js';
export * from './patterns/HealthDashboard.js';
export * from './patterns/EventDetails.js';
