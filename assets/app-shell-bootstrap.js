const SHELL_FLAG_KEY = 'et_shell_v2';
const SHELL_FLAG_VALUE = 'on';

let shellEnabled = localStorage.getItem(SHELL_FLAG_KEY) === SHELL_FLAG_VALUE;
const activationUrl = new URL(window.location.href);

if (activationUrl.searchParams.get('shell') === 'v2') {
  localStorage.setItem(SHELL_FLAG_KEY, SHELL_FLAG_VALUE);
  activationUrl.searchParams.delete('shell');
  history.replaceState(history.state, '', activationUrl.href);
  shellEnabled = true;
}

async function init() {
  if (window.__etShellV2 && window.__etShellV2.initialized) return;

  window.__etShellV2 = {
    initialized: true,
    init,
    rollback: "Clear localStorage key 'et_shell_v2', then reload the page. Live rollback is intentionally unsupported."
  };

  const mountPoint = document.getElementById('appShellV2Root');
  const sidebar = document.getElementById('et-sidebar');
  const main = document.querySelector('.app > .main');
  const userBar = document.getElementById('userBar');

  if (!mountPoint || !sidebar || !main || !userBar) {
    window.__etShellV2.error = 'required-dom-anchor-missing';
    console.error('EasyTrac App Shell v2 could not find its required DOM anchors.');
    return;
  }

  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = '/assets/app-shell-token-bridge.css';
  stylesheet.dataset.etShellV2Styles = 'true';
  document.head.appendChild(stylesheet);

  const designSystemRoot = '../EasyTrac Tracking Command Center/design_handoff_easytrac_design_system';
  const [
    { createAppShell },
    { createSidebar },
    { createPage },
    { createPanel },
    { createSection },
    { createToolbar },
    { createStoreSwitcher },
    { createDestinationRow },
    { createDataTable },
    { createSelect },
    { createEmptyState },
    { createLoadingState },
    { createSparkline },
    { createEventTrace }
  ] = await Promise.all([
    import(`${designSystemRoot}/layout/AppShell.js`),
    import(`${designSystemRoot}/components/Sidebar.js`),
    import(`${designSystemRoot}/layout/Page.js`),
    import(`${designSystemRoot}/layout/Panel.js`),
    import(`${designSystemRoot}/layout/Section.js`),
    import(`${designSystemRoot}/layout/Toolbar.js`),
    import(`${designSystemRoot}/components/StoreSwitcher.js`),
    import(`${designSystemRoot}/operational/DestinationRow.js`),
    import(`${designSystemRoot}/components/DataTable.js`),
    import(`${designSystemRoot}/components/Select.js`),
    import(`${designSystemRoot}/operational/EmptyState.js`),
    import(`${designSystemRoot}/operational/LoadingState.js`),
    import(`${designSystemRoot}/charts/Sparkline.js`),
    import(`${designSystemRoot}/operational/EventTrace.js`)
  ]);

  const storeSwitcher = createStoreSwitcher(
    [{ name: 'EasyTrac Store', statusClass: 'positive' }],
    { current: { name: 'EasyTrac Store', statusClass: 'positive' }, onSwitch() {} }
  );
  storeSwitcher.classList.add('et-shell-v2-store-switcher');

  const sidebarChrome = createSidebar([], {});
  sidebarChrome.classList.add('et-shell-v2-sidebar-chrome');
  sidebarChrome.appendChild(storeSwitcher);
  sidebarChrome.appendChild(sidebar);

  const toolbarChrome = createToolbar({
    className: 'et-shell-v2-toolbar-chrome',
    children: userBar
  });
  const workspaceSection = createSection({
    className: 'et-shell-v2-workspace-section',
    children: main
  });
  const workspacePanel = createPanel({
    className: 'et-shell-v2-workspace-panel',
    children: workspaceSection
  });
  const pageChrome = createPage({
    className: 'et-shell-v2-page-chrome',
    children: [toolbarChrome, workspacePanel]
  });
  const appShell = createAppShell({
    dir: document.documentElement.dir || 'rtl',
    className: 'et-shell-v2-appshell',
    children: [sidebarChrome, pageChrome]
  });

  mountPoint.classList.add('et-design-system-scope');
  mountPoint.appendChild(appShell);

  const destinationsSection = buildDestinationsSection(createDestinationRow);
  const pixelsAnchor = document.getElementById('overviewPixels');
  if (destinationsSection && pixelsAnchor && pixelsAnchor.parentNode) {
    pixelsAnchor.insertAdjacentElement('afterend', destinationsSection);
  }

  const eventDetails = mountEventDetails({
    createDataTable, createEmptyState, createLoadingState, createEventTrace,
    createPanel, createSection, createToolbar
  });
  const eventsExplorer = mountEventsExplorer({
    createDataTable, createSelect, createEmptyState, createLoadingState, createSparkline,
    openSample: eventDetails && eventDetails.openSample
  });
  const trackingContinuity = mountTrackingContinuity({ createSparkline });

  Object.assign(window.__etShellV2, {
    mountPoint,
    appShell,
    sidebar,
    main,
    userBar,
    destinationsSection,
    eventsExplorer,
    eventDetails,
    trackingContinuity
  });
}

/**
 * Destinations — real-data-only list built from the existing pixel-config
 * state (window.S, populated by the existing setup wizard / refreshOverview()
 * in tool.html). No invented match rates, delivery rates, health scores, or
 * incidents — only fields the app already knows: configured/not, masked
 * pixel ID (same truncation rule refreshOverview() already uses), selected
 * event count, CMS platform, and overall setup completeness (same formula
 * refreshOverview() already computes). "Reconnect" is intentionally never
 * offered — these are pixel-ID destinations, not OAuth connections, so no
 * real connection state exists to reconnect.
 */
function buildDestinationsSection(createDestinationRow) {
  const S = window.S || { platforms: [], pixelIds: {}, events: [], cms: null };
  if (window.__etShellV2 && window.__etShellV2.destinationsSection) {
    return null; // idempotency guard: never build a second copy
  }

  const PLATFORM_LABELS = {
    meta: 'Meta Pixel', snapchat: 'Snap Pixel', tiktok: 'TikTok Pixel',
    google: 'Google Ads', ga4: 'GA4', twitter: 'X / Twitter'
  };
  const CMS_LABELS = {
    salla: 'سلة', zid: 'زد', woocommerce: 'WooCommerce', shopify: 'Shopify', custom: 'Custom Site'
  };

  const section = document.createElement('div');
  section.className = 'et-shell-v2-destinations';

  const heading = document.createElement('div');
  heading.className = 'et-shell-v2-destinations-heading';
  const platforms = S.platforms || [];
  const configuredCount = platforms.filter(function (p) {
    const raw = (typeof S.pixelIds[p] === 'object' ? S.pixelIds[p].id : S.pixelIds[p]) || '';
    return !!String(raw).trim(); // real value present
  }).length;
  const completeness = platforms.length
    ? Math.round((configuredCount / platforms.length) * 100) + '%'
    : '—';
  heading.textContent = 'Destinations · Setup completeness: ' + completeness;
  section.appendChild(heading);

  const list = document.createElement('div');
  list.className = 'et-shell-v2-destinations-list';

  if (!platforms.length) {
    const empty = document.createElement('div');
    empty.className = 'et-shell-v2-destinations-empty';
    empty.textContent = 'No destinations configured yet.';
    list.appendChild(empty);
  }

  platforms.forEach(function (p) {
    const rawId = (typeof S.pixelIds[p] === 'object' ? S.pixelIds[p].id : S.pixelIds[p]) || '';
    const configured = !!(rawId && String(rawId).trim());
    const maskedId = configured
      ? (rawId.length > 10 ? rawId.substring(0, 10) + '...' : rawId)
      : '—';
    const name = PLATFORM_LABELS[p] || p;
    const cmsLabel = S.cms ? (CMS_LABELS[S.cms] || S.cms) : '—';
    const eventCount = (S.events || []).length;

    const row = createDestinationRow({
      name: name,
      state: configured ? 'Connected' : 'Needs Action',
      metric: eventCount + ' event' + (eventCount === 1 ? '' : 's') + ' selected',
      actionLabel: configured ? 'Edit' : 'Configure',
      onAction: function () {
        if (typeof window.switchAppView === 'function') {
          window.switchAppView('pixels', document.getElementById('sbPixels'));
        }
      }
    });

    const detail = document.createElement('div');
    detail.className = 'et-shell-v2-destination-detail';
    detail.textContent = 'ID: ' + maskedId + ' · Store: ' + cmsLabel;

    const card = document.createElement('div');
    card.className = 'et-shell-v2-destination-card';
    card.append(row, detail);
    list.appendChild(card);
  });

  section.appendChild(list);
  return section;
}

/**
 * Events Explorer V1 — real container-ingestion telemetry only.
 *
 * Data source: GET /api/v1/clients/:id/events/summary (owner-scoped,
 * firestore-service.js queryEventSummary() over event_agg_daily +
 * event_agg_shards, committed 4b1a427). This measures events ACCEPTED BY
 * THE EASYTRAC SERVER CONTAINER — it does not confirm GA4 accepted or
 * delivered the event, and the backend has no failure-sample producer
 * (see docs/product/event-observability-v1-implementation-plan.md).
 * Accordingly this view never renders delivery/rejection/match-rate/
 * response-code language — only "Received by EasyTrac" / "Container
 * ingestions" / "Last observed" terminology, and intentionally never reads
 * the `failed`/`validationFailed` counters (always 0 today; showing them
 * would imply a destination-side outcome this data cannot support).
 *
 * Scope: GA4 + purchase only, matching the backend's own rollout allowlist.
 */
const EVENTS_EXPLORER_RANGE_OPTIONS = [
  { value: '7', label: '7 days' },
  { value: '14', label: '14 days' },
  { value: '30', label: '30 days' }
];
const EVENTS_EXPLORER_DEFAULT_RANGE = '14';

function eventScope() {
  const clientId = typeof window._opsClientId === 'function' ? window._opsClientId() : null;
  return clientId ? { clientId, label: 'Client ' + clientId } : null;
}

function eventTimestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const seconds = Number(value._seconds ?? value.seconds);
  if (Number.isFinite(seconds)) {
    const nanos = Number(value._nanoseconds ?? value.nanoseconds) || 0;
    return seconds * 1000 + Math.floor(nanos / 1000000);
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function utcDayKey(value) {
  const millis = eventTimestampMillis(value);
  return millis ? new Date(millis).toISOString().slice(0, 10) : '';
}

function buildContinuityModel(result, rangeDays) {
  const days = Math.min(Math.max(parseInt(rangeDays, 10) || 14, 1), 400);
  const daily = new Map();
  const dimensions = new Map();
  let lastObservedMs = 0;

  (result.rows || []).forEach(function (row) {
    const key = [row.eventName || 'Unknown', row.destination || 'Unknown'].join('|');
    const dimension = dimensions.get(key) || {
      eventName: row.eventName || 'Unknown',
      destination: row.destination || 'Unknown',
      count: 0,
      lastObservedMs: 0
    };
    const count = Number.isFinite(Number(row.accepted)) ? Number(row.accepted) : 0;
    const observed = eventTimestampMillis(row.updatedAt);
    dimension.count += count;
    dimension.lastObservedMs = Math.max(dimension.lastObservedMs, observed);
    dimensions.set(key, dimension);
    lastObservedMs = Math.max(lastObservedMs, observed);

    const dayKey = utcDayKey(row.dayStart);
    if (dayKey) daily.set(dayKey, (daily.get(dayKey) || 0) + count);
  });

  // Fine buckets improve last-observed precision only. They are not added to
  // totals because the backend atomically increments the daily document too.
  (result.live || []).forEach(function (row) {
    const key = [row.eventName || 'Unknown', row.destination || 'Unknown'].join('|');
    const dimension = dimensions.get(key) || {
      eventName: row.eventName || 'Unknown',
      destination: row.destination || 'Unknown',
      count: 0,
      lastObservedMs: 0
    };
    const observed = eventTimestampMillis(row.bucketStart);
    dimension.lastObservedMs = Math.max(dimension.lastObservedMs, observed);
    dimensions.set(key, dimension);
    lastObservedMs = Math.max(lastObservedMs, observed);
  });

  const trend = [];
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const key = new Date(todayUtc - offset * 86400000).toISOString().slice(0, 10);
    trend.push({ day: key, count: daily.get(key) || 0 });
  }

  return {
    dimensions: Array.from(dimensions.values()),
    trend,
    daysWithEvents: trend.filter(function (day) { return day.count > 0; }).length,
    daysWithoutEvents: trend.filter(function (day) { return day.count === 0; }).length,
    lastObservedMs,
    total: trend.reduce(function (sum, day) { return sum + day.count; }, 0)
  };
}

async function fetchEventContinuity(rangeDays) {
  const scope = eventScope();
  if (!scope) return { kind: 'error', message: 'Sign in to view store telemetry.' };

  let token;
  try {
    const user = window.firebase && window.firebase.auth().currentUser;
    if (!user) return { kind: 'error', message: 'Sign in to view store telemetry.' };
    token = await user.getIdToken();
  } catch (_) {
    return { kind: 'error', message: 'Could not verify your session.' };
  }

  let response;
  try {
    response = await fetch('/api/v1/clients/' + encodeURIComponent(scope.clientId) +
      '/events/summary?eventName=purchase&destination=ga4&range=' + encodeURIComponent(rangeDays), {
        headers: { Authorization: 'Bearer ' + token }
      });
  } catch (_) {
    return { kind: 'error', message: 'Could not reach the telemetry service.' };
  }

  if (response.status === 503) return { kind: 'disabled', scope };
  if (!response.ok) return { kind: 'error', message: 'Telemetry request failed (HTTP ' + response.status + ').', scope };

  let data;
  try { data = await response.json(); }
  catch (_) { return { kind: 'error', message: 'Telemetry returned an unreadable response.', scope }; }

  const rows = Array.isArray(data.rows) ? data.rows : [];
  const live = Array.isArray(data.live) ? data.live : [];
  const telemetryEnabled = data.telemetryEnabled === true;
  if (!rows.length && !live.length) return { kind: 'empty', scope, telemetryEnabled };
  return { kind: 'ok', scope, telemetryEnabled, rows, live, model: buildContinuityModel({ rows, live }, rangeDays) };
}

function statusBlock(title, message, kind) {
  const block = document.createElement('div');
  block.className = 'et-continuity-state et-continuity-state-' + kind;
  const heading = document.createElement('strong');
  heading.textContent = title;
  const detail = document.createElement('span');
  detail.textContent = message;
  block.append(heading, detail);
  return block;
}

function mountTrackingContinuity({ createSparkline }) {
  const overview = document.getElementById('view-overview');
  if (!overview || document.getElementById('trackingContinuity')) return null;
  const section = document.createElement('section');
  section.id = 'trackingContinuity';
  section.className = 'et-tracking-continuity';
  section.setAttribute('aria-live', 'polite');
  overview.appendChild(section);

  async function render() {
    section.replaceChildren(statusBlock('Tracking Continuity', 'Loading aggregate container telemetry…', 'loading'));
    const result = await fetchEventContinuity(EVENTS_EXPLORER_DEFAULT_RANGE);
    section.replaceChildren();

    const heading = document.createElement('div');
    heading.className = 'et-continuity-heading';
    const title = document.createElement('h2');
    title.textContent = 'Tracking Continuity';
    const evidence = document.createElement('p');
    evidence.textContent = 'Aggregate ingestion observed by EasyTrac. This does not confirm destination delivery.';
    heading.append(title, evidence);
    section.appendChild(heading);

    if (result.kind === 'disabled') {
      section.appendChild(statusBlock('Telemetry disabled', result.scope.label + ' · No ingestion data is being shown.', 'disabled'));
      return;
    }
    if (result.kind === 'error') {
      section.appendChild(statusBlock('Telemetry unavailable', result.message, 'error'));
      return;
    }
    if (result.kind === 'empty') {
      const telemetryLabel = result.telemetryEnabled ? 'Telemetry enabled' : 'Telemetry disabled';
      section.appendChild(statusBlock('No events observed', result.scope.label + ' · ' + telemetryLabel + ' · No container ingestions in the last 14 days.', 'empty'));
      return;
    }

    const model = result.model;
    const metrics = document.createElement('div');
    metrics.className = 'et-continuity-metrics';
    [
      ['Container ingestions', String(model.total)],
      ['Days with events', String(model.daysWithEvents)],
      ['Days without events', String(model.daysWithoutEvents)],
      ['Last observed', model.lastObservedMs && typeof window._opsTimeAgo === 'function'
        ? window._opsTimeAgo(new Date(model.lastObservedMs)) : '—']
    ].forEach(function (metric) {
      const card = document.createElement('div');
      const label = document.createElement('span'); label.textContent = metric[0];
      const value = document.createElement('strong'); value.textContent = metric[1];
      card.append(label, value); metrics.appendChild(card);
    });
    section.appendChild(metrics);

    const meta = document.createElement('p');
    meta.className = 'et-continuity-meta';
    meta.textContent = result.scope.label + ' · ' + (result.telemetryEnabled ? 'Telemetry enabled' : 'Telemetry disabled') +
      ' · Intended destination: GA4 · 14 days';
    section.appendChild(meta);
    const chart = createSparkline(model.trend.map(function (day) { return day.count; }), { color: 'var(--brand)' });
    chart.setAttribute('aria-label', 'Daily EasyTrac container ingestions for the last 14 days');
    section.appendChild(chart);
  }

  render();
  try {
    const auth = window.firebase && window.firebase.auth();
    if (auth && typeof auth.onAuthStateChanged === 'function') auth.onAuthStateChanged(function () { render(); });
  } catch (_) {}
  return { section, render };
}

const DEBUG_REQUIRED_FIELDS = ['transaction_id', 'currency', 'value', 'items'];
const DEBUG_OPTIONAL_FIELDS = [
  'tax', 'shipping', 'coupon', 'affiliation', 'content_ids', 'content_name',
  'content_type', 'items_count', 'num_items', 'search_string', 'event_time',
  'device_type', 'language'
];
const DEBUG_SAFE_FIELDS = new Set(DEBUG_REQUIRED_FIELDS.concat(DEBUG_OPTIONAL_FIELDS));
const EVENT_DETAILS_NOTICE = 'This screen describes what EasyTrac received inside the server container.\n\n' +
  'It does not confirm whether any advertising or analytics platform accepted the event.';

function debugSafeText(value, max) {
  return typeof value === 'string' && value.length <= max ? value : '';
}

function debugSafeFieldNames(value) {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter(function (name) { return DEBUG_SAFE_FIELDS.has(name); }))).sort()
    : [];
}

function eventDetailsTime(value) {
  const millis = eventTimestampMillis(value);
  return millis ? new Date(millis).toLocaleString() : '';
}

function buildEventDetailsModel(sample) {
  if (!sample || typeof sample !== 'object') return null;
  const validation = sample.validation && typeof sample.validation === 'object' ? sample.validation : null;
  const missingRequired = validation ? debugSafeFieldNames(validation.missingRequiredFields) : [];
  const optionalPresent = validation ? debugSafeFieldNames(validation.optionalFieldsPresent) : [];
  const invalidFields = validation ? debugSafeFieldNames(validation.invalidFieldNames) : [];
  const metadata = sample.metadata && typeof sample.metadata === 'object' ? sample.metadata : {};
  const receivedTime = eventDetailsTime(sample.receivedAt);
  const containerVersion = debugSafeText(sample.containerVersion, 64);
  const schemaVersion = debugSafeText(sample.schemaVersion, 32);
  const model = {
    header: [
      ['Event Name', debugSafeText(sample.eventName, 100)],
      ['Intended Destination', debugSafeText(sample.intendedDestination, 100)],
      ['Received Time', receivedTime],
      ['Container Version', containerVersion],
      ['Sample ID', /^[a-f0-9]{32}$/.test(sample.sampleId || '') ? sample.sampleId : '']
    ].filter(function (row) { return !!row[1]; }),
    timeline: [],
    validation: [],
    metadata: [
      ['Container Version', containerVersion],
      ['Schema Version', schemaVersion],
      ['Processing Time', Number.isSafeInteger(sample.processingTimeMs) && sample.processingTimeMs >= 0
        ? sample.processingTimeMs + ' ms' : ''],
      ['CMS', debugSafeText(metadata.cms, 32)],
      ['Environment', debugSafeText(metadata.environment, 32)],
      ['Platform', debugSafeText(metadata.platform, 32)]
    ].filter(function (row) { return !!row[1]; })
  };

  if (sample.receivedAt) {
    model.timeline.push({ title: '✓ Received', detail: 'Observed inside the EasyTrac server container.', state: 'Healthy', timestamp: receivedTime });
  }
  if (validation) {
    model.timeline.push({ title: '✓ Validated', detail: 'Schema validation completed.', state: 'Healthy' });
  }
  if (sample.ingestionAccepted === true) {
    model.timeline.push({ title: '✓ Accepted by EasyTrac', detail: 'EasyTrac ingestion accepted the event.', state: 'Healthy' });
  }
  model.timeline.push({ title: '✓ Stored as Debug Sample', detail: 'A privacy-safe debug sample was stored.', state: 'Healthy' });

  if (validation) {
    DEBUG_REQUIRED_FIELDS.forEach(function (name) {
      model.validation.push({ group: 'Required Fields', field: name, state: missingRequired.includes(name) ? 'Missing' : '✓ Present' });
    });
    optionalPresent.forEach(function (name) {
      model.validation.push({ group: 'Optional Fields Present', field: name, state: '✓ Present' });
    });
    invalidFields.forEach(function (name) {
      model.validation.push({ group: 'Invalid Fields', field: name, state: 'Invalid' });
    });
  }
  return model;
}

async function fetchDebugSamples(sampleId) {
  const scope = eventScope();
  if (!scope) return { kind: 'unauthorized' };
  if (sampleId && !/^[a-f0-9]{32}$/.test(sampleId)) return { kind: 'not-found', scope };

  let token;
  try {
    const user = window.firebase && window.firebase.auth().currentUser;
    if (!user) return { kind: 'unauthorized', scope };
    token = await user.getIdToken();
  } catch (_) {
    return { kind: 'unauthorized', scope };
  }

  let response;
  const base = '/api/v1/clients/' + encodeURIComponent(scope.clientId) + '/events/debug-samples';
  try {
    response = await fetch(sampleId ? base + '/' + encodeURIComponent(sampleId) : base + '?range=7&limit=50', {
      headers: { Authorization: 'Bearer ' + token }
    });
  } catch (_) {
    return { kind: 'error', scope };
  }
  if (response.status === 503) return { kind: 'disabled', scope };
  if (response.status === 401 || response.status === 403) return { kind: 'unauthorized', scope };
  if (response.status === 404) return { kind: 'not-found', scope };
  if (!response.ok) return { kind: 'error', scope };

  let data;
  try { data = await response.json(); }
  catch (_) { return { kind: 'error', scope }; }
  if (sampleId) return data && data.sample ? { kind: 'ok', scope, sample: data.sample } : { kind: 'not-found', scope };
  const rows = Array.isArray(data && data.rows) ? data.rows : [];
  return rows.length ? { kind: 'ok', scope, rows } : { kind: 'empty', scope };
}

function mountEventDetails({
  createDataTable, createEmptyState, createLoadingState, createEventTrace,
  createPanel, createSection, createToolbar
}) {
  if (window.__etShellV2 && window.__etShellV2.eventDetails) return null;
  const main = document.querySelector('.app > .main') || document.querySelector('.main');
  if (!main) return null;
  const view = document.createElement('div');
  view.className = 'app-view et-event-details';
  view.id = 'view-event-details';
  view.setAttribute('aria-live', 'polite');
  main.appendChild(view);
  window.APP_VIEWS = window.APP_VIEWS || {};
  window.APP_VIEWS.eventDetails = 'view-event-details';

  function frame() {
    view.replaceChildren();
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'btn btn-secondary';
    back.textContent = '← Events Explorer';
    back.addEventListener('click', function () {
      const eventsButton = document.getElementById('sbEvents');
      if (typeof window.switchAppView === 'function') window.switchAppView('events', eventsButton);
    });
    const title = document.createElement('h1');
    title.textContent = 'Event Details';
    view.appendChild(createToolbar({ className: 'et-event-details-toolbar', children: [back, title] }));
    const notice = document.createElement('aside');
    notice.className = 'et-event-details-notice';
    notice.textContent = EVENT_DETAILS_NOTICE;
    view.appendChild(notice);
  }

  function state(kind) {
    const messages = {
      disabled: 'Debug sampling telemetry is disabled.',
      unauthorized: 'You are not authorized to view this debug sample.',
      empty: 'No debug sample is available.',
      'not-found': 'Sample not found.',
      error: 'Unexpected error while loading the debug sample.'
    };
    view.appendChild(createEmptyState(messages[kind] || messages.error));
  }

  function renderSample(sample) {
    const model = buildEventDetailsModel(sample);
    if (!model) { state('empty'); return; }

    const header = createDataTable(
      [{ key: 'label', label: 'Field' }, { key: 'value', label: 'Observed' }],
      model.header.map(function (row) { return { label: row[0], value: row[1] }; }),
      { selectable: false }
    );
    view.appendChild(createPanel({ className: 'et-event-details-card', children: header }));

    const timelineTitle = document.createElement('h2'); timelineTitle.textContent = 'Timeline';
    view.appendChild(createSection({ className: 'et-event-details-section', children: [timelineTitle, createEventTrace(model.timeline)] }));

    const validationTitle = document.createElement('h2'); validationTitle.textContent = 'Validation';
    const validation = model.validation.length
      ? createDataTable(
        [{ key: 'group', label: 'Field Group' }, { key: 'field', label: 'Field Name' }, { key: 'state', label: 'Validation' }],
        model.validation, { selectable: false }
      )
      : createEmptyState('No validation summary is stored for this debug sample.');
    view.appendChild(createSection({ className: 'et-event-details-section', children: [validationTitle, validation] }));

    const metadataTitle = document.createElement('h2'); metadataTitle.textContent = 'Metadata';
    const metadata = model.metadata.length
      ? createDataTable(
        [{ key: 'label', label: 'Metadata' }, { key: 'value', label: 'Observed' }],
        model.metadata.map(function (row) { return { label: row[0], value: row[1] }; }),
        { selectable: false }
      )
      : createEmptyState('No diagnostic metadata is stored for this debug sample.');
    view.appendChild(createSection({ className: 'et-event-details-section', children: [metadataTitle, metadata] }));
  }

  async function openSample(sampleId) {
    if (typeof window.switchAppView === 'function') {
      window.switchAppView('eventDetails', document.getElementById('sbEvents'));
    }
    frame();
    view.appendChild(createLoadingState('Loading debug sample…'));
    const result = await fetchDebugSamples(sampleId);
    frame();
    if (result.kind !== 'ok') { state(result.kind); return; }
    renderSample(result.sample);
  }

  return { view, openSample, renderSample };
}

function mountEventsExplorer({ createDataTable, createSelect, createEmptyState, createLoadingState, createSparkline, openSample }) {
  if (window.__etShellV2 && window.__etShellV2.eventsExplorer) {
    return null; // idempotency guard: never build a second copy
  }

  const opsSection = document.querySelector('#et-sidebar .sb-nav-section');
  const nav = document.querySelector('#et-sidebar .sb-nav');
  const pixelsButton = document.getElementById('sbPixels');
  if (!nav) return null;

  const view = document.createElement('div');
  view.className = 'app-view';
  view.id = 'view-events';
  const main = document.querySelector('.app > .main') || document.querySelector('.main');
  if (main) main.appendChild(view);

  window.APP_VIEWS = window.APP_VIEWS || {};
  window.APP_VIEWS.events = 'view-events';

  const btn = document.createElement('button');
  btn.className = 'sb-link';
  btn.id = 'sbEvents';
  btn.type = 'button';
  btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px;">query_stats</span><span>Events</span>';
  btn.addEventListener('click', function () {
    if (typeof window.switchAppView === 'function') window.switchAppView('events', btn);
    renderEventsExplorer(currentRange);
  });
  if (pixelsButton && pixelsButton.parentNode === nav) pixelsButton.insertAdjacentElement('afterend', btn);
  else if (opsSection) opsSection.insertAdjacentElement('beforebegin', btn);
  else nav.appendChild(btn);

  let currentRange = EVENTS_EXPLORER_DEFAULT_RANGE;

  function renderResult(result) {
    view.innerHTML = '';

    const header = document.createElement('header');
    header.className = 'et-events-header';
    const title = document.createElement('h1'); title.textContent = 'Events Explorer';
    const subtitle = document.createElement('p');
    subtitle.textContent = 'Aggregate container ingestions only. Intended destinations are labels, not delivery confirmation.';
    header.append(title, subtitle);
    view.appendChild(header);

    if (result.kind === 'disabled') {
      view.appendChild(createEmptyState('Telemetry disabled · ' + result.scope.label + ' · No aggregate ingestion data is available.'));
      return;
    }
    if (result.kind === 'error') {
      view.appendChild(createEmptyState('Could not load aggregate telemetry — try again. ' + result.message));
      return;
    }
    if (result.kind === 'empty') {
      view.appendChild(createEmptyState('No events observed · ' + result.scope.label + ' · ' +
        (result.telemetryEnabled ? 'Telemetry enabled.' : 'Telemetry disabled. Historical aggregates may still be retained.')));
      return;
    }

    const model = result.model;

    const toolbarRow = document.createElement('div');
    toolbarRow.className = 'et-events-toolbar';
    const scope = document.createElement('span');
    scope.textContent = result.scope.label + ' · ' + (result.telemetryEnabled ? 'Telemetry enabled' : 'Telemetry disabled');
    const select = createSelect(EVENTS_EXPLORER_RANGE_OPTIONS, {
      value: currentRange,
      onChange: function (value) {
        currentRange = value;
        renderEventsExplorer(currentRange);
      }
    });
    toolbarRow.append(scope, select);
    view.appendChild(toolbarRow);

    const table = createDataTable(
      [
        { key: 'eventName', label: 'Event name' },
        { key: 'destination', label: 'Intended destination' },
        { key: 'count', label: 'Container ingestions' },
        { key: 'lastObserved', label: 'Last observed' }
      ],
      model.dimensions.map(function (dimension) {
        return {
          eventName: dimension.eventName,
          destination: String(dimension.destination).toUpperCase(),
          count: dimension.count,
          lastObserved: dimension.lastObservedMs && typeof window._opsTimeAgo === 'function'
            ? window._opsTimeAgo(new Date(dimension.lastObservedMs)) : '—'
        };
      }),
      { selectable: false }
    );
    view.appendChild(table);

    const trendWrap = document.createElement('div');
    trendWrap.className = 'et-events-trend';
    const caption = document.createElement('div');
    caption.textContent = 'Daily container ingestions · ' + model.daysWithEvents + ' days with events · ' +
      model.daysWithoutEvents + ' days without events';
    trendWrap.appendChild(caption);
    const chart = createSparkline(model.trend.map(function (day) { return day.count; }), { color: 'var(--text-secondary)' });
    chart.setAttribute('aria-label', 'Daily EasyTrac container ingestions, including zero-event days');
    trendWrap.appendChild(chart);
    view.appendChild(trendWrap);
  }

  async function renderDebugSampleList() {
    const section = document.createElement('section');
    section.className = 'et-debug-samples';
    const heading = document.createElement('h2');
    heading.textContent = 'Debug Samples';
    const description = document.createElement('p');
    description.textContent = 'Privacy-safe diagnostic samples received inside the EasyTrac server container.';
    const body = document.createElement('div');
    body.appendChild(createLoadingState('Loading debug samples…'));
    section.append(heading, description, body);
    view.appendChild(section);

    const result = await fetchDebugSamples();
    if (!section.isConnected) return;
    body.replaceChildren();
    if (result.kind === 'disabled') {
      body.appendChild(createEmptyState('Debug sampling telemetry is disabled.'));
      return;
    }
    if (result.kind === 'unauthorized') {
      body.appendChild(createEmptyState('You are not authorized to view debug samples for this store.'));
      return;
    }
    if (result.kind === 'empty') {
      body.appendChild(createEmptyState('No debug samples are available for this store.'));
      return;
    }
    if (result.kind !== 'ok') {
      body.appendChild(createEmptyState('Unexpected error while loading debug samples.'));
      return;
    }

    const rows = result.rows.map(function (sample) {
      return {
        sampleId: /^[a-f0-9]{32}$/.test(sample.sampleId || '') ? sample.sampleId : '',
        eventName: debugSafeText(sample.eventName, 100),
        intendedDestination: debugSafeText(sample.intendedDestination, 100),
        receivedTime: eventDetailsTime(sample.receivedAt)
      };
    }).filter(function (sample) { return !!sample.sampleId; });
    if (!rows.length) {
      body.appendChild(createEmptyState('No debug samples are available for this store.'));
      return;
    }
    const table = createDataTable(
      [
        { key: 'sampleId', label: 'Sample ID' },
        { key: 'eventName', label: 'Event Name' },
        { key: 'intendedDestination', label: 'Intended Destination' },
        { key: 'receivedTime', label: 'Received Time' }
      ],
      rows,
      { selectable: false }
    );
    Array.from(table.querySelectorAll('tbody tr')).forEach(function (row, index) {
      row.classList.add('et-debug-sample-row');
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', 'Open debug sample ' + rows[index].sampleId);
      const activate = function () { if (typeof openSample === 'function') openSample(rows[index].sampleId); };
      row.addEventListener('click', activate);
      row.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
      });
    });
    body.appendChild(table);
  }

  async function renderEventsExplorer(rangeDays) {
    view.innerHTML = '';
    view.appendChild(createLoadingState('Loading telemetry…'));
    const result = await fetchEventContinuity(rangeDays);
    renderResult(result);
    await renderDebugSampleList();
  }

  return { view, button: btn, render: renderEventsExplorer };
}

if (shellEnabled) init().catch((error) => {
  window.__etShellV2.error = error;
  console.error('EasyTrac App Shell v2 failed to initialize.', error);
});
