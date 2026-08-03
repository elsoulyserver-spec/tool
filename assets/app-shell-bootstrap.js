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
    { createDestinationRow }
  ] = await Promise.all([
    import(`${designSystemRoot}/layout/AppShell.js`),
    import(`${designSystemRoot}/components/Sidebar.js`),
    import(`${designSystemRoot}/layout/Page.js`),
    import(`${designSystemRoot}/layout/Panel.js`),
    import(`${designSystemRoot}/layout/Section.js`),
    import(`${designSystemRoot}/layout/Toolbar.js`),
    import(`${designSystemRoot}/components/StoreSwitcher.js`),
    import(`${designSystemRoot}/operational/DestinationRow.js`)
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

  Object.assign(window.__etShellV2, {
    mountPoint,
    appShell,
    sidebar,
    main,
    userBar,
    destinationsSection
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

if (shellEnabled) init().catch((error) => {
  window.__etShellV2.error = error;
  console.error('EasyTrac App Shell v2 failed to initialize.', error);
});
