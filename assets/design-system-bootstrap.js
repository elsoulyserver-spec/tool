import {
  createAppShell,
  createPage,
  createPanel,
  createSection,
  createStatusChip,
  createEventTrace,
  createBreadcrumbs,
  createButton,
} from '../EasyTrac Tracking Command Center/design_handoff_easytrac_design_system/index.js';

/** Creates, but never mounts, the opt-in boundary for design-system components. */
function createDesignSystemScope({ density = 'medium' } = {}) {
  const scope = document.createElement('div');
  scope.className = 'et-design-system-scope';
  scope.dataset.density = density;
  return scope;
}

export {
  createAppShell,
  createPage,
  createPanel,
  createSection,
  createStatusChip,
  createEventTrace,
  createBreadcrumbs,
  createButton,
  createDesignSystemScope,
};
