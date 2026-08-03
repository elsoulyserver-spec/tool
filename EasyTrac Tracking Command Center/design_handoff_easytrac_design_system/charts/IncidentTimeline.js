/**
 * IncidentTimeline — Chart
 * ---------------------------------------------------------------
 * API: createIncidentTimeline(markers: {pct,type,color}[])
 * Variants: incident timeline, deployment timeline (same primitive, different marker sets)
 * States: n/a
 * Accessibility: Each marker needs an accessible label at call site (title attribute is a minimum, not sufficient alone)
 * Keyboard: Marker click-through handled at Pattern layer
 * RTL: Chronological axis not mirrored
 * Responsive: Scales to container width
 * Token dependencies: --timeline-*
 * Spec reference: Design System §23, §27; Interaction Spec §18, §19
 * ---------------------------------------------------------------
 */
export function createIncidentTimeline(markers) {
  // markers: [{ pct, type: 'deployment'|'incident'|'resolved', color }]
  const el = document.createElement('div'); el.style.cssText = 'position:relative;height:40px;';
  el.innerHTML = '<div style="position:absolute;top:18px;left:0;right:0;height:2px;background:var(--timeline-line-color);"></div>';
  markers.forEach(m => {
    const dot = document.createElement('div');
    dot.title = m.type;
    dot.style.cssText = `position:absolute;left:${m.pct}%;top:10px;width:var(--timeline-marker-size);height:var(--timeline-marker-size);border-radius:50%;background:${m.color};`;
    el.appendChild(dot);
  });
  return el;
}
