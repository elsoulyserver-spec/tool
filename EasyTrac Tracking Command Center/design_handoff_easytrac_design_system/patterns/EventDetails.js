/**
 * EventDetails — Pattern (composition)
 * ---------------------------------------------------------------
 * API: createEventDetails({ breadcrumb, event, traceSteps, payloadFields, relatedEvents, onCopyPayload })
 *   - breadcrumb: Breadcrumbs path array, e.g. [{label:'acme-store.sa'}, {label:'Events'}, {label: event.name}]
 *   - event: { name, destination, state } — state must be one of the 14 approved states (statusMap.js)
 *   - traceSteps: EventTrace steps — { title, detail, state, timestamp?, responseCode? }[]
 *   - payloadFields: { key, value, masked?, maskable, revealed?, onToggleReveal? }[] — caller owns reveal state
 *   - relatedEvents: { name, destination, state, time, onJump? }[]
 *   - onCopyPayload: click handler for the header's Copy payload button
 * Variants: n/a
 * States: payload fields toggle revealed/masked independently (caller-managed, re-render on toggle)
 * Accessibility: Section headings (h2) precede each block; payload table is a real <table> with scoped <th>; reveal buttons and related-event rows are native, focusable controls
 * Keyboard: Copy button, per-row reveal toggles, and related-event rows are all Tab-reachable in visual order
 * RTL: inherits Breadcrumbs/EventTrace/StatusChip RTL behavior; table columns mirror
 * Responsive: Payload table scrolls horizontally below 640px inside its .et-panel; related events stay a stacked list at all breakpoints
 * Token dependencies: inherits Breadcrumbs + StatusChip + EventTrace tokens, plus --table-*, --card-*
 * Spec reference: Screen Specifications — Event Details; Design System §11, §27
 * ---------------------------------------------------------------
 */
import { createBreadcrumbs } from '../components/Breadcrumbs.js';
import { createButton } from '../components/Button.js';
import { createEventTrace } from '../operational/EventTrace.js';
import { createStatusChip } from '../operational/StatusChip.js';

function createPayloadTable(fields) {
  const wrap = document.createElement('div'); wrap.className = 'et-panel'; wrap.style.cssText = 'padding:0; overflow-x:auto;';
  const table = document.createElement('table'); table.className = 'et-table';

  const thead = document.createElement('thead'); const headRow = document.createElement('tr');
  ['Field', 'Value', ''].forEach(label => { const th = document.createElement('th'); th.textContent = label; headRow.appendChild(th); });
  thead.appendChild(headRow); table.appendChild(thead);

  const tbody = document.createElement('tbody');
  fields.forEach(f => {
    const tr = document.createElement('tr');

    const keyTd = document.createElement('td');
    keyTd.style.cssText = 'font-family:var(--p-font-mono); color:var(--text-secondary);';
    keyTd.textContent = f.key;

    const valTd = document.createElement('td');
    valTd.style.fontFamily = 'var(--p-font-mono)';
    valTd.textContent = f.maskable && !f.revealed ? f.masked : f.value;

    const actionTd = document.createElement('td'); actionTd.style.textAlign = 'right';
    if (f.maskable) {
      const btn = document.createElement('button');
      btn.textContent = f.revealed ? 'Hide' : 'Reveal';
      btn.style.cssText = 'background:none; border:none; color:var(--brand); font-size:11.5px; cursor:pointer;';
      btn.addEventListener('click', () => f.onToggleReveal && f.onToggleReveal());
      actionTd.appendChild(btn);
    }

    tr.append(keyTd, valTd, actionTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function createRelatedEventRow(r) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background:var(--surface-1); border:1px solid var(--border-subtle); border-radius:8px; padding:10px 14px; cursor:pointer;';
  row.tabIndex = 0;
  row.addEventListener('mouseenter', () => { row.style.background = 'var(--surface-2)'; });
  row.addEventListener('mouseleave', () => { row.style.background = 'var(--surface-1)'; });
  row.addEventListener('click', () => r.onJump && r.onJump());

  const left = document.createElement('div'); left.style.cssText = 'display:flex; align-items:center; gap:9px;';
  left.appendChild(createStatusChip(r.state));
  const name = document.createElement('span'); name.style.fontSize = '12.5px'; name.textContent = `${r.name} → ${r.destination}`;
  left.appendChild(name);

  const time = document.createElement('span');
  time.style.cssText = 'font-family:var(--p-font-mono); font-variant-numeric:tabular-nums; font-size:11.5px; color:var(--text-tertiary);';
  time.textContent = r.time;

  row.append(left, time);
  return row;
}

function createSectionHeading(text) {
  const h2 = document.createElement('h2');
  h2.textContent = text;
  return h2;
}

/** The Event Details screen: breadcrumb → header (title, status, copy) → EventTrace → Payload table → related events, per Screen Specifications. */
export function createEventDetails({ breadcrumb, event, traceSteps, payloadFields, relatedEvents, onCopyPayload }) {
  const el = document.createElement('div'); el.className = 'et-eventdetails';

  el.appendChild(createBreadcrumbs(breadcrumb));

  const header = document.createElement('div'); header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-top:14px;';
  const titleWrap = document.createElement('div'); titleWrap.style.cssText = 'display:flex; align-items:center; gap:12px;';
  const h1 = document.createElement('h1'); h1.style.cssText = 'font-size:22px; margin:0; font-weight:700;'; h1.textContent = `${event.name} → ${event.destination}`;
  titleWrap.append(h1, createStatusChip(event.state));
  header.appendChild(titleWrap);
  header.appendChild(createButton('Copy payload', { variant: 'secondary', onClick: onCopyPayload }));
  el.appendChild(header);

  const traceSection = document.createElement('div'); traceSection.className = 'et-section';
  traceSection.appendChild(createSectionHeading('Event Trace'));
  const tracePanel = document.createElement('div'); tracePanel.className = 'et-panel';
  tracePanel.appendChild(createEventTrace(traceSteps));
  traceSection.appendChild(tracePanel);
  el.appendChild(traceSection);

  const payloadSection = document.createElement('div'); payloadSection.className = 'et-section';
  payloadSection.appendChild(createSectionHeading('Payload'));
  payloadSection.appendChild(createPayloadTable(payloadFields));
  el.appendChild(payloadSection);

  const relatedSection = document.createElement('div'); relatedSection.className = 'et-section';
  relatedSection.appendChild(createSectionHeading('Related Events (same order)'));
  const relatedList = document.createElement('div'); relatedList.style.cssText = 'display:flex; flex-direction:column; gap:8px;';
  relatedEvents.forEach(r => relatedList.appendChild(createRelatedEventRow(r)));
  relatedSection.appendChild(relatedList);
  el.appendChild(relatedSection);

  return el;
}
