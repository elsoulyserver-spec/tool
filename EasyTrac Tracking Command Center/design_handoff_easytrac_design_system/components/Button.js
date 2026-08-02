/**
 * Button — Base component
 * ---------------------------------------------------------------
 * API: createButton(label, {variant, onClick, disabled, loading})
 * Variants: primary, secondary, danger, icon-only
 * States: default, hover, focus, pressed, disabled, loading
 * Accessibility: aria-disabled mirrors disabled; aria-busy when loading
 * Keyboard: Tab focuses; Enter/Space activates
 * RTL: Icon-only buttons keep icon direction-agnostic unless directional (chevrons mirror)
 * Responsive: Full-width on mobile in stacked forms
 * Token dependencies: --button-* (component-tokens.css)
 * Spec reference: Interaction Spec §1, §7
 * ---------------------------------------------------------------
 */
export function createButton(label, { variant = 'primary', onClick, disabled = false, loading = false } = {}) {
  const el = document.createElement('button');
  el.className = `et-btn et-btn--${variant}`;
  el.textContent = loading ? '' : label;
  el.disabled = disabled || loading;
  el.setAttribute('aria-busy', String(loading));
  if (loading) {
    const spinner = document.createElement('span');
    spinner.style.cssText = 'width:13px;height:13px;border:2px solid rgba(255,255,255,.4);border-top-color:currentColor;border-radius:50%;display:inline-block;margin-right:8px;animation:et-spin .7s linear infinite;';
    el.prepend(spinner);
    el.append(label);
  }
  if (onClick) el.addEventListener('click', onClick);
  return el;
}
