import { t } from '/i18n.js';
import { createRetryState } from './components.js';
import {
  SETTINGS_LEAVES,
  filterSettingsDomains,
  findSettingsLeaf,
  settingsOverviewUrl,
} from './registry.js';

function createIcon(name, className) {
  const icon = document.createElement('i');
  icon.className = className;
  icon.dataset.lucide = name;
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

function hydrateIcons(container) {
  if (window.lucide) window.lucide.createIcons({ el: container });
}

function bindSpaNavigation(link, href) {
  link.addEventListener('click', (event) => {
    if (
      event.defaultPrevented
      || event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
      || !window.oikos?.navigate
    ) {
      return;
    }
    event.preventDefault();
    window.oikos.navigate(href);
  });
}

function createLink(href, className) {
  const link = document.createElement('a');
  link.href = href;
  link.className = className;
  bindSpaNavigation(link, href);
  return link;
}

function allowedLeavesForDomain(domainId, user) {
  return SETTINGS_LEAVES.filter((entry) => (
    entry.domainId === domainId
    && (!entry.adminOnly || user?.role === 'admin')
  ));
}

let navPanelIdCounter = 0;

// Setzt den Auf-/Zu-Zustand einer Domänen-Gruppe konsistent über alle Träger:
// CSS-Klasse (treibt die Höhen-Animation), aria-expanded am Trigger und `inert`
// am Panel (nimmt kollabierte Links aus Tab-Reihenfolge und A11y-Baum).
function setGroupExpanded(group, expanded) {
  group.classList.toggle('settings-shell__navigation-group--expanded', expanded);
  const toggle = group.querySelector('.settings-shell__navigation-toggle');
  const panel = group.querySelector('.settings-shell__navigation-panel');
  if (toggle) toggle.setAttribute('aria-expanded', String(expanded));
  if (panel) panel.inert = !expanded;
}

function collapseAllGroups(navigation) {
  for (const open of navigation.querySelectorAll('.settings-shell__navigation-group--expanded')) {
    setGroupExpanded(open, false);
  }
}

function createDomainToggle(domain, panelId, expanded) {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'settings-shell__navigation-toggle';
  toggle.setAttribute('aria-controls', panelId);
  toggle.setAttribute('aria-expanded', String(expanded));

  const label = document.createElement('span');
  label.className = 'settings-shell__navigation-domain-label';
  label.textContent = t(domain.labelKey);

  toggle.append(
    createIcon(domain.icon, 'settings-shell__navigation-domain-icon'),
    label,
    createIcon('chevron-down', 'settings-shell__navigation-chevron'),
  );
  return toggle;
}

function createNavigation(domains, user, activeLeaf) {
  const navigation = document.createElement('nav');
  navigation.className = 'settings-shell__navigation';
  navigation.setAttribute('aria-label', t('settings.navigationLabel'));

  // Eine einzelne Domäne (z. B. Familienmitglieder ohne Admin-Bereiche) braucht
  // kein Akkordeon — sie bleibt dauerhaft offen ohne Collapse-Affordance.
  const collapsible = domains.length > 1;
  navigation.classList.toggle('settings-shell__navigation--collapsible', collapsible);

  // Single-Open: genau die aktive Domäne ist offen. Ohne aktives Blatt (Desktop-
  // Übersicht) klappt die erste Domäne auf, damit nie alles zu ist.
  const expandedDomainId = activeLeaf?.domainId ?? domains[0]?.id ?? null;

  for (const domain of domains) {
    const group = document.createElement('section');
    group.className = 'settings-shell__navigation-group';
    group.dataset.domainId = domain.id;
    if (domain.id === activeLeaf?.domainId) {
      group.classList.add('settings-shell__navigation-group--active');
    }

    const list = document.createElement('ul');
    list.className = 'settings-shell__navigation-list';
    for (const entry of allowedLeavesForDomain(domain.id, user)) {
      const item = document.createElement('li');
      const link = createLink(entry.path, 'settings-shell__navigation-link');
      link.dataset.leafId = entry.id;
      link.append(
        createIcon(entry.icon, 'settings-shell__navigation-link-icon'),
        document.createTextNode(t(entry.labelKey)),
      );
      if (entry.id === activeLeaf?.id) {
        link.classList.add('settings-shell__navigation-link--active');
        link.setAttribute('aria-current', 'page');
      }
      item.appendChild(link);
      list.appendChild(item);
    }

    if (collapsible) {
      const expanded = domain.id === expandedDomainId;
      group.classList.toggle('settings-shell__navigation-group--expanded', expanded);

      const panelId = `settings-domain-panel-${++navPanelIdCounter}`;
      const heading = document.createElement('h2');
      heading.className = 'settings-shell__navigation-heading';
      const toggle = createDomainToggle(domain, panelId, expanded);
      heading.appendChild(toggle);

      const panel = document.createElement('div');
      panel.className = 'settings-shell__navigation-panel';
      panel.id = panelId;
      panel.inert = !expanded;
      panel.appendChild(list);

      toggle.addEventListener('click', () => {
        const willExpand = toggle.getAttribute('aria-expanded') !== 'true';
        if (willExpand) collapseAllGroups(navigation);
        setGroupExpanded(group, willExpand);
      });

      group.append(heading, panel);
    } else {
      const heading = document.createElement('h2');
      heading.className = 'settings-shell__navigation-heading';
      heading.append(
        createIcon(domain.icon, 'settings-shell__navigation-domain-icon'),
        document.createTextNode(t(domain.labelKey)),
      );
      group.append(heading, list);
    }

    navigation.appendChild(group);
  }

  return navigation;
}

// Aktualisiert nur den Aktivzustand der bestehenden Navigation, ohne die Links
// (und ihre Icons) neu aufzubauen — Grundlage für Soft-Navigation zwischen
// Settings-Blättern.
function updateNavigationActiveState(navigation, activeLeaf) {
  if (!navigation) return;

  const collapsible = navigation.classList.contains('settings-shell__navigation--collapsible');
  const activeDomainId = activeLeaf?.domainId ?? null;

  for (const group of navigation.querySelectorAll('.settings-shell__navigation-group')) {
    const isActiveDomain = group.dataset.domainId === activeDomainId;
    group.classList.toggle('settings-shell__navigation-group--active', isActiveDomain);
    // Single-Open: die aktive Domäne wird aufgeklappt, alle anderen schließen mit.
    // Ohne aktives Blatt (Übersicht) bleibt der manuelle Zustand unangetastet.
    if (collapsible && activeDomainId) {
      setGroupExpanded(group, isActiveDomain);
    }
  }

  for (const link of navigation.querySelectorAll('.settings-shell__navigation-link')) {
    const isActive = link.dataset.leafId === activeLeaf?.id;
    link.classList.toggle('settings-shell__navigation-link--active', isActive);
    if (isActive) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  }
}

function createOverviewLink({ href, icon, title, description }) {
  const link = createLink(href, 'settings-overview-link');
  link.appendChild(createIcon(icon, 'settings-overview-link__icon'));

  const copy = document.createElement('span');
  copy.className = 'settings-overview-link__copy';

  const label = document.createElement('span');
  label.className = 'settings-overview-link__title';
  label.textContent = title;
  copy.appendChild(label);

  if (description) {
    const detail = document.createElement('span');
    detail.className = 'settings-overview-link__description';
    detail.textContent = description;
    copy.appendChild(detail);
  }

  link.append(
    copy,
    createIcon('chevron-right', 'settings-overview-link__chevron'),
  );
  return link;
}

function createOverviewHeader(title, description = null) {
  const header = document.createElement('header');
  header.className = 'settings-mobile-overview__header';

  const heading = document.createElement('h2');
  heading.className = 'settings-mobile-overview__title';
  heading.textContent = title;
  header.appendChild(heading);

  if (description) {
    const detail = document.createElement('p');
    detail.className = 'settings-mobile-overview__description';
    detail.textContent = description;
    header.appendChild(detail);
  }

  return header;
}

function renderDomainsOverview(content, domains) {
  const overview = document.createElement('section');
  overview.className = 'settings-mobile-overview';

  const description = document.createElement('p');
  description.className = 'settings-mobile-overview__description';
  description.textContent = t('settings.mobileOverviewDescription');
  overview.appendChild(description);

  const links = document.createElement('div');
  links.className = 'settings-mobile-overview__links';
  for (const domain of domains) {
    links.appendChild(createOverviewLink({
      href: settingsOverviewUrl(domain.id),
      icon: domain.icon,
      title: t(domain.labelKey),
    }));
  }

  overview.appendChild(links);
  content.replaceChildren(overview);
}

function renderDomainOverview(content, domain, user) {
  const overview = document.createElement('section');
  overview.className = 'settings-mobile-overview settings-domain-overview';
  overview.appendChild(createOverviewHeader(
    t('settings.mobileDomainTitle', { domain: t(domain.labelKey) }),
  ));

  const backLink = createLink(settingsOverviewUrl(), 'settings-overview-back-link');
  backLink.append(
    createIcon('arrow-left', 'settings-overview-back-link__icon'),
    document.createTextNode(t('settings.backToSettings')),
  );
  overview.appendChild(backLink);

  const links = document.createElement('div');
  links.className = 'settings-mobile-overview__links';
  for (const entry of allowedLeavesForDomain(domain.id, user)) {
    links.appendChild(createOverviewLink({
      href: entry.path,
      icon: entry.icon,
      title: t(entry.labelKey),
      description: t(entry.descriptionKey),
    }));
  }

  overview.appendChild(links);
  content.replaceChildren(overview);
}

function createBreadcrumb(domain, leaf) {
  const breadcrumb = document.createElement('nav');
  breadcrumb.className = 'settings-breadcrumb';
  breadcrumb.setAttribute('aria-label', t('settings.breadcrumbLabel'));

  const list = document.createElement('ol');
  list.className = 'settings-breadcrumb__list';

  const settingsItem = document.createElement('li');
  settingsItem.className = 'settings-breadcrumb__item';
  const settingsLink = createLink(settingsOverviewUrl(), 'settings-breadcrumb__link');
  settingsLink.textContent = t('settings.title');
  settingsItem.appendChild(settingsLink);

  const domainItem = document.createElement('li');
  domainItem.className = 'settings-breadcrumb__item';
  const domainLink = createLink(
    settingsOverviewUrl(domain.id),
    'settings-breadcrumb__link',
  );
  domainLink.textContent = t(domain.labelKey);
  domainItem.appendChild(domainLink);

  const currentItem = document.createElement('li');
  currentItem.className = 'settings-breadcrumb__item settings-breadcrumb__item--current';
  currentItem.textContent = t(leaf.labelKey);
  currentItem.setAttribute('aria-current', 'page');

  for (const item of [settingsItem, domainItem, currentItem]) {
    if (list.childElementCount) {
      const separator = document.createElement('li');
      separator.className = 'settings-breadcrumb__separator';
      separator.textContent = '/';
      separator.setAttribute('aria-hidden', 'true');
      list.appendChild(separator);
    }
    list.appendChild(item);
  }

  breadcrumb.appendChild(list);
  return breadcrumb;
}

function createLeafHeader(leaf) {
  const header = document.createElement('header');
  header.className = 'settings-leaf-header';

  const heading = document.createElement('h1');
  heading.className = 'settings-leaf-header__title';
  heading.textContent = t(leaf.labelKey);

  const description = document.createElement('p');
  description.className = 'settings-leaf-header__description';
  description.textContent = t(leaf.descriptionKey);

  header.append(heading, description);
  return header;
}

async function renderLeafContent(content, leaf, domain, user, query) {
  const breadcrumb = createBreadcrumb(domain, leaf);
  const backLink = createLink(
    settingsOverviewUrl(domain.id),
    'settings-leaf-back-link',
  );
  backLink.append(
    createIcon('arrow-left', 'settings-leaf-back-link__icon'),
    document.createTextNode(t('settings.backToSettings')),
  );

  // Der Leaf-Header wird zentral aus der Registry gerendert (Prio 5/B1): die
  // Blätter liefern nur noch Content. Der Header liegt als Geschwister *über*
  // dem Content-Container, damit Leaf-interne Re-Renders (die `leafContainer`
  // per replaceChildren leeren) ihn nicht entfernen.
  const header = createLeafHeader(leaf);
  const heading = header.querySelector('.settings-leaf-header__title');

  const leafContainer = document.createElement('div');
  leafContainer.className = 'settings-leaf';
  content.replaceChildren(breadcrumb, backLink, header, leafContainer);

  const loadAndRender = async ({ focusRetry = false } = {}) => {
    leafContainer.replaceChildren();
    try {
      const module = await leaf.loader();
      if (typeof module.render !== 'function') throw new TypeError('Settings leaf must export render()');
      await module.render(leafContainer, { user, query });

      heading.tabIndex = -1;
      requestAnimationFrame(() => {
        heading.focus({ preventScroll: true });
      });
      hydrateIcons(content);
    } catch (error) {
      console.error(`[Settings] Failed to render ${leaf.id}:`, error);
      const retryState = createRetryState({
        message: t('settings.loadError'),
        onRetry: () => loadAndRender({ focusRetry: true }),
      });
      leafContainer.replaceChildren(retryState);
      hydrateIcons(content);

      if (focusRetry) {
        const retryButton = retryState.querySelector('.settings-retry-state__button');
        requestAnimationFrame(() => {
          if (retryButton?.isConnected && leafContainer.contains(retryButton)) {
            retryButton.focus({ preventScroll: true });
          }
        });
      }
    }
  };

  await loadAndRender();
}

export async function renderSettingsShell(container, {
  user,
  leaf = null,
  view = null,
  domainId = null,
  query = new URLSearchParams(),
  incremental = false,
}) {
  const domains = filterSettingsDomains(user);
  const activeLeaf = leaf?.path ? findSettingsLeaf(leaf.path, user) : null;

  // Inkrementell: Wenn bereits eine Shell montiert ist, bleiben Seitenkopf und
  // Sidebar stehen — wir tauschen nur den Aktivzustand und den Detailbereich.
  const existingShell = incremental ? container.querySelector('.settings-shell') : null;
  let shell;
  let content;

  if (existingShell) {
    shell = existingShell;
    content = shell.querySelector('.settings-shell__content');
    updateNavigationActiveState(
      shell.querySelector('.settings-shell__navigation'),
      activeLeaf,
    );
  } else {
    const page = document.createElement('div');
    page.className = 'page settings-page';

    const pageHeader = document.createElement('header');
    pageHeader.className = 'page__header settings-shell-header';
    const pageTitle = document.createElement('h1');
    pageTitle.className = 'page__title';
    pageTitle.textContent = t('settings.title');
    pageHeader.appendChild(pageTitle);

    shell = document.createElement('div');
    shell.className = 'settings-shell';
    const navigation = createNavigation(domains, user, activeLeaf);
    content = document.createElement('div');
    content.className = 'settings-shell__content';
    shell.append(navigation, content);
    page.append(pageHeader, shell);
    container.replaceChildren(page);
    // Sidebar-Icons einmalig bei der Montage hydrieren; die Detail-Icons werden
    // pro Render separat (nur im Content-Bereich) hydriert.
    hydrateIcons(navigation);
  }

  const page = shell.closest('.settings-page');
  page?.classList.toggle('settings-page--leaf', Boolean(activeLeaf));

  if (activeLeaf) {
    const domain = domains.find((entry) => entry.id === activeLeaf.domainId);
    if (!domain) {
      console.error(
        `[Settings] Cannot render ${activeLeaf.id}: domain "${activeLeaf.domainId}" is not available.`,
      );
      renderDomainsOverview(content, domains);
      hydrateIcons(content);
    } else {
      await renderLeafContent(content, activeLeaf, domain, user, query);
    }
  } else {
    const domain = view === 'domain'
      ? domains.find((entry) => entry.id === domainId)
      : null;
    if (domain) {
      renderDomainOverview(content, domain, user);
    } else {
      renderDomainsOverview(content, domains);
    }
    hydrateIcons(content);
  }
}
