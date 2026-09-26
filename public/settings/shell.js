import { t } from '/i18n.js';
import { moduleAccentVar } from '/utils/module-accent.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { renderPageSearch, wirePageSearch } from '/utils/page-search.js';
import { createRetryState } from './components.js';
import { clearLeafEdits, confirmLeafExit, watchLeafForms } from './dirty-guard.js';
import { resetPreferencesCache } from './preferences-cache.js';
import {
  SETTINGS_LEAVES,
  filterSettingsDomains,
  findSettingsLeaf,
  settingsOverviewUrl,
} from './registry.js';

// Unter dieser Schwelle ist ein Blatt gefuehlt sofort da; ein Skelett waere
// dort nur ein Aufblitzen.
const SKELETON_DELAY_MS = 120;

function createIcon(name, className) {
  const icon = document.createElement('i');
  icon.className = className;
  icon.dataset.lucide = name;
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

/**
 * Das Zeichen eines Blattes in seiner Marke.
 *
 * WER EIN MODUL NENNT, TRAEGT SEINEN TON - die anderen bleiben neutral. Das ist
 * die Vollton-Regel (DESIGN.md, Colors) auf einer Flaeche, die vorher gar keine
 * Farbe hatte: neunundzwanzig Blaetter, neunundzwanzig graue Zeichen, obwohl
 * elf davon von einem Modul handeln, dessen Ton drei Klicks weiter in der
 * Seitenleiste als Legende steht. Die Gegenrichtung ist genauso Teil der Regel
 * und der Grund, warum hier nicht alles bunt wird: „Konto", „Darstellung" oder
 * „Backup" nennen kein Modul, also nennen sie auch keine Farbe.
 *
 * Die Zuordnung steht im `module`-Feld der Registry, nicht hier - sonst waere
 * es die zwoelfte Liste, die mit der Modulliste driften kann.
 *
 * @param {object} entry     Blatt aus SETTINGS_LEAVES
 * @param {string} className Klasse der Marke in ihrem Umfeld (Geometrie)
 * @returns {HTMLElement}
 */
function createLeafMark(entry, className) {
  const mark = document.createElement('span');
  mark.className = entry.module ? `${className} vivid-mark` : className;
  if (entry.module) mark.style.setProperty('--seal-accent', moduleAccentVar(entry.module));
  mark.setAttribute('aria-hidden', 'true');
  mark.appendChild(createIcon(entry.icon, `${className}-glyph`));
  return mark;
}

function hydrateIcons(container) {
  if (window.lucide) window.lucide.createIcons({ el: container });
}

function bindSpaNavigation(link, href) {
  link.addEventListener('click', async (event) => {
    if (
      event.defaultPrevented
      || event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
      || !window.yuvomi?.navigate
    ) {
      return;
    }
    event.preventDefault();
    // Alle Wege aus einem Blatt heraus laufen ueber diese Links: Seitenleiste,
    // Suchtreffer, Breadcrumb und der Zurueck-Link.
    if (!(await confirmLeafExit())) return;
    window.yuvomi.navigate(href);
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

// Vergleichsform für die Blatt-Suche: Diakritika weg, damit "wetter" auch
// "Wetter" findet und "prazdniny" auch "prázdniny".
function searchNormalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

function createNavigationLink(entry, activeLeaf) {
  const link = createLink(entry.path, 'settings-shell__navigation-link');
  link.dataset.leafId = entry.id;
  link.append(
    createLeafMark(entry, 'settings-shell__navigation-link-icon'),
    document.createTextNode(t(entry.labelKey)),
  );
  if (entry.id === activeLeaf?.id) {
    link.classList.add('settings-shell__navigation-link--active');
    link.setAttribute('aria-current', 'page');
  }
  return link;
}

/**
 * Suchfeld über alle sichtbaren Blätter. Bei 23 Blättern in vier Domänen ist
 * die Taxonomie sonst der einzige Weg zu einer Einstellung, deren Domäne man
 * nicht kennt (Critique 2026-07-27). Gefiltert wird über Label UND Beschreibung,
 * damit "Zeitzone" auch ein Blatt findet, das anders heisst.
 */
function createNavigationSearch(navigation, domains, user, activeLeaf) {
  const leaves = domains.flatMap((domain) => allowedLeavesForDomain(domain.id, user)
    .map((entry) => ({
      entry,
      domainLabel: t(domain.labelKey),
      haystack: searchNormalize(`${t(entry.labelKey)} ${t(entry.descriptionKey)} ${t(domain.labelKey)}`),
    })));

  const field = document.createElement('div');
  field.className = 'settings-shell__navigation-search';
  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'form-input settings-shell__navigation-search-input';
  input.placeholder = t('settings.searchLabel');
  input.setAttribute('aria-label', t('settings.searchLabel'));
  field.appendChild(input);

  const results = document.createElement('ul');
  results.className = 'settings-shell__navigation-list settings-shell__navigation-results';
  results.hidden = true;

  const status = document.createElement('p');
  status.className = 'settings-shell__navigation-status';
  status.setAttribute('role', 'status');
  status.hidden = true;

  const groups = () => navigation.querySelectorAll('.settings-shell__navigation-group');

  const applyFilter = () => {
    const query = searchNormalize(input.value.trim());
    const searching = query.length > 0;

    for (const group of groups()) group.hidden = searching;
    results.hidden = !searching;
    status.hidden = !searching;

    if (!searching) {
      results.replaceChildren();
      status.textContent = '';
      return;
    }

    const hits = leaves.filter((leaf) => leaf.haystack.includes(query));
    results.replaceChildren(...hits.map(({ entry, domainLabel }) => {
      const item = document.createElement('li');
      const link = createLink(entry.path, 'settings-shell__navigation-link settings-shell__navigation-result');
      link.dataset.leafId = entry.id;
      if (entry.id === activeLeaf?.id) {
        link.classList.add('settings-shell__navigation-link--active');
        link.setAttribute('aria-current', 'page');
      }

      // Ohne die Gruppen fehlt der Ort: die Domäne wandert unter den Treffer.
      // Label und Domäne stehen zusammen in einer Spalte neben dem Icon, damit
      // ein langer Name nicht das Icon in eine eigene Zeile drängt.
      const text = document.createElement('span');
      text.className = 'settings-shell__navigation-result-text';
      const label = document.createElement('span');
      label.textContent = t(entry.labelKey);
      const domainHint = document.createElement('span');
      domainHint.className = 'settings-shell__navigation-result-domain';
      domainHint.textContent = domainLabel;
      text.append(label, domainHint);

      link.append(createLeafMark(entry, 'settings-shell__navigation-link-icon'), text);
      item.appendChild(link);
      return item;
    }));
    hydrateIcons(results);

    status.textContent = hits.length
      ? t('settings.searchResults', { count: hits.length })
      : t('search.noResults');
  };

  input.addEventListener('input', applyFilter);
  input.addEventListener('search', applyFilter);

  navigation.prepend(field, status, results);
}

function createNavigation(domains, user, activeLeaf) {
  const navigation = document.createElement('nav');
  navigation.className = 'settings-shell__navigation';
  navigation.setAttribute('aria-label', t('settings.navigationLabel'));

  // Eine einzelne Domäne (z. B. Familienmitglieder ohne Admin-Bereiche) braucht
  // kein Akkordeon — sie bleibt dauerhaft offen ohne Collapse-Affordance.
  const collapsible = domains.length > 1;
  navigation.classList.toggle('settings-shell__navigation--collapsible', collapsible);

  // Single-Open: genau die aktive Domäne ist offen. Ohne aktives Blatt bleibt
  // die Root eine echte Übersicht; die lokale Navigation zeigt nur Domänen.
  const expandedDomainId = activeLeaf?.domainId ?? null;

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
      item.appendChild(createNavigationLink(entry, activeLeaf));
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

  createNavigationSearch(navigation, domains, user, activeLeaf);
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
    // Single-Open: die aktive Domäne wird aufgeklappt, alle anderen schließen
    // mit. Ohne aktives Blatt schliessen alle - sonst stand links die Domäne
    // des zuletzt besuchten Blatts offen, während rechts die Übersicht begann
    // (Critique 2026-07-27). Ein Navigationszustand, der dem Inhalt
    // widerspricht, kostet mehr Vertrauen als er Wege spart.
    if (collapsible) {
      setGroupExpanded(group, Boolean(activeDomainId) && isActiveDomain);
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

/**
 * EINE gruppierte Liste aller Blaetter - die Wurzel der Einstellungen in jeder
 * Breite (Kopfregel mobil, 2026-09-26; Critique A7 P1).
 *
 * Mobil gab es drei Ebenen: vier Bereichszeilen, dann die Bereichsseite mit
 * 88px hohen Zeilen und einem Zurueck-Link, dann das Blatt. Inhalt begann bei
 * y=198, sichtbar waren 5,5 Zeilen. Apples Einstellungen zeigen EINE Liste mit
 * Abschnitten, und der Desktop zeigte sie hier schon - nur mobil fehlte sie.
 * Jetzt rendert die Wurzel ueberall dieselbe Liste; was mobil anders ist
 * (Zeilenhoehe, Markengroesse, keine Beschreibung), entscheidet settings.css.
 *
 * DIE BEREICHSEBENE GIBT ES NICHT MEHR. Ein Deep-Link `?view=domain&domain=x`
 * (Breadcrumb, Rueckweg aus dem Blatt, alte Lesezeichen) landet auf derselben
 * Liste, gescrollt auf den Abschnitt - der Ort bleibt, die Zwischenseite geht.
 */
function createOverviewRow(entry, domainLabel) {
  const link = createLink(entry.path, 'settings-overview__row');
  link.dataset.leafId = entry.id;
  // Suchgrund der Zeile: Label, Beschreibung und Bereich - dieselbe Menge, die
  // die Blatt-Suche der Seitenleiste durchsucht.
  link.dataset.search = searchNormalize(`${t(entry.labelKey)} ${t(entry.descriptionKey)} ${domainLabel}`);
  link.appendChild(createLeafMark(entry, 'settings-overview__row-mark'));

  const copy = document.createElement('span');
  copy.className = 'settings-overview__row-copy';

  const label = document.createElement('span');
  label.className = 'settings-overview__row-title';
  label.textContent = t(entry.labelKey);

  const description = document.createElement('span');
  description.className = 'settings-overview__row-description';
  description.textContent = t(entry.descriptionKey);

  copy.append(label, description);
  link.append(
    copy,
    createIcon('chevron-right', 'settings-overview__row-chevron'),
  );
  return link;
}

/** Id des Abschnitts eines Bereichs - Sprungziel der Deep-Links. */
function overviewSectionId(domainId) {
  return `settings-domain-${domainId}`;
}

function renderOverview(content, domains, user) {
  const overview = document.createElement('section');
  overview.className = 'settings-overview';
  overview.setAttribute('aria-label', t('settings.navigationLabel'));

  // Trefferzahl der Kopf-Suche (Live-Region). Leer und versteckt, solange
  // nicht gesucht wird.
  const status = document.createElement('p');
  status.className = 'settings-overview__status';
  status.setAttribute('role', 'status');
  status.hidden = true;
  overview.appendChild(status);

  for (const domain of domains) {
    const leaves = allowedLeavesForDomain(domain.id, user);
    if (!leaves.length) continue;

    const domainLabel = t(domain.labelKey);
    const section = document.createElement('section');
    section.className = 'settings-overview__section';
    section.id = overviewSectionId(domain.id);
    section.dataset.domainId = domain.id;

    const heading = document.createElement('h2');
    heading.className = 'settings-overview__heading';
    heading.id = `${section.id}-heading`;
    heading.append(
      createIcon(domain.icon, 'settings-overview__heading-icon'),
      document.createTextNode(domainLabel),
    );
    section.setAttribute('aria-labelledby', heading.id);

    const list = document.createElement('div');
    list.className = 'settings-overview__list';
    for (const entry of leaves) list.appendChild(createOverviewRow(entry, domainLabel));

    section.append(heading, list);
    overview.appendChild(section);
  }

  content.replaceChildren(overview);
  return overview;
}

/**
 * Filtert die Liste der Wurzel nach der Kopf-Suche. Ein Abschnitt ohne Treffer
 * faellt mit weg, damit keine leeren Ueberschriften stehen bleiben; die Zahl
 * geht in die Live-Region, ein leeres Ergebnis nennt der geteilte Leerzustand.
 */
function filterOverview(content, value) {
  const overview = content.querySelector('.settings-overview');
  if (!overview) return;
  const query = searchNormalize(String(value ?? '').trim());
  const status = overview.querySelector('.settings-overview__status');
  let hits = 0;
  for (const section of overview.querySelectorAll('.settings-overview__section')) {
    let visible = 0;
    for (const row of section.querySelectorAll('.settings-overview__row')) {
      const match = !query || row.dataset.search.includes(query);
      row.hidden = !match;
      if (match) visible += 1;
    }
    section.hidden = visible === 0;
    hits += visible;
  }
  if (!status) return;
  status.hidden = !query;
  status.textContent = !query
    ? ''
    : (hits ? t('settings.searchResults', { count: hits }) : t('search.noResults'));
}

/**
 * Scrollt die Wurzel auf den Abschnitt eines Bereichs (Deep-Link).
 *
 * NACH DEM ROUTER, NICHT IM RENDER: der Router setzt den Scrollport nach einer
 * Soft-Navigation erst NACH `update()` zurueck (router.js, Soft-Update) - ein
 * Sprung im Render waere sofort wieder kassiert. Der Abstand zum klebenden
 * Kopf steht als `scroll-margin` am Abschnitt (settings.css).
 */
function revealOverviewSection(content, domainId) {
  if (!domainId) return;
  setTimeout(() => {
    const section = content.querySelector(`#${overviewSectionId(domainId)}`);
    if (section?.isConnected) section.scrollIntoView({ block: 'start' });
  }, 0);
}

/**
 * Der Seitenkopf der Einstellungen ist der geteilte Modulkopf (`.page-toolbar`,
 * vom Router verdrahtet: Siegel, Large Title, Andocken) - bis 2026-09-26 war er
 * ein eigener `settings-shell-header` ohne Siegel und ohne Suche (Critique A7,
 * Konsistenz). Er kennt zwei Zustaende:
 *
 *   WURZEL: Titel + Suche. Die Suche war nur im Desktop-Blatt erreichbar
 *     (Seitenleiste, unter 1024px ausgeblendet); jetzt steht sie mobil als
 *     Such-Icon im Kopf, das zum Feld aufgeht (Kopfregel mobil, Regel 4).
 *   BLATT: nur der Rueckweg. Er lag als Textlink IM Inhalt und scrollte auf
 *     einem 1950px langen Blatt mit weg (A7, Casey). Im klebenden Kopf bleibt
 *     er stehen - Apples Navigationsleiste mit „< Einstellungen". Ab 768px
 *     traegt der Breadcrumb den Rueckweg; dort blendet settings.css den Kopf
 *     auf Blaettern aus.
 *
 * Neu gebaut wird nur beim Zustandswechsel: eine getippte Suche ueberlebt den
 * Deep-Link-Sprung innerhalb der Wurzel.
 */
function renderToolbar(toolbar, content, { activeLeaf, domain }) {
  if (activeLeaf && domain) {
    const back = createLink(settingsOverviewUrl(domain.id), 'settings-toolbar__back');
    back.setAttribute('aria-label', t('settings.backToSettings'));
    const label = document.createElement('span');
    label.className = 'settings-toolbar__back-label';
    label.textContent = t('settings.title');
    back.append(createIcon('chevron-left', 'settings-toolbar__back-icon'), label);
    toolbar.dataset.mode = 'leaf';
    toolbar.replaceChildren(back);
    hydrateIcons(toolbar);
    return;
  }

  if (toolbar.dataset.mode === 'root') {
    filterOverview(content, toolbar.querySelector('#settings-search')?.value);
    return;
  }

  const title = document.createElement('h1');
  title.className = 'page-toolbar__title';
  title.textContent = t('settings.title');
  toolbar.dataset.mode = 'root';
  toolbar.replaceChildren(title);
  toolbar.insertAdjacentHTML('beforeend', renderPageSearch({
    id: 'settings-search',
    label: t('settings.searchLabel'),
    clearLabel: t('common.searchClear'),
    className: 'settings-toolbar__search page-toolbar__center',
  }));
  wirePageSearch(toolbar, {
    id: 'settings-search',
    delay: 0,
    onQuery: (value) => filterOverview(content, value),
  });
  hydrateIcons(toolbar);
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
  // Der mobile Rueckweg steht nicht mehr hier, sondern im klebenden Kopf
  // (renderToolbar): als Textlink im Inhalt scrollte er mit weg.
  const breadcrumb = createBreadcrumb(domain, leaf);

  // Der Leaf-Header wird zentral aus der Registry gerendert (Prio 5/B1): die
  // Blätter liefern nur noch Content. Der Header liegt als Geschwister *über*
  // dem Content-Container, damit Leaf-interne Re-Renders (die `leafContainer`
  // per replaceChildren leeren) ihn nicht entfernen.
  const header = createLeafHeader(leaf);
  const heading = header.querySelector('.settings-leaf-header__title');

  const leafContainer = document.createElement('div');
  leafContainer.className = 'settings-leaf';
  content.replaceChildren(breadcrumb, header, leafContainer);

  const loadAndRender = async ({ focusRetry = false } = {}) => {
    leafContainer.replaceChildren();
    // Der Blattwechsel laedt ein Modul und danach dessen Daten. Bis dahin stand
    // hier ein leerer Kasten (Critique 2026-07-27). aria-busy gilt sofort; das
    // Skelett kommt erst nach einer kurzen Frist, damit ein Blatt aus dem
    // Modul-Cache nicht kurz aufblitzt.
    leafContainer.setAttribute('aria-busy', 'true');
    const skeletonTimer = setTimeout(() => {
      if (leafContainer.isConnected && !leafContainer.firstChild) {
        leafContainer.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 3, lines: 3 }));
      }
    }, SKELETON_DELAY_MS);

    try {
      const module = await leaf.loader();
      if (typeof module.render !== 'function') throw new TypeError('Settings leaf must export render()');
      clearTimeout(skeletonTimer);
      leafContainer.replaceChildren();
      await module.render(leafContainer, { user, query });
      leafContainer.removeAttribute('aria-busy');
      watchLeafForms(leafContainer);

      heading.tabIndex = -1;
      requestAnimationFrame(() => {
        heading.focus({ preventScroll: true });
      });
      hydrateIcons(content);
    } catch (error) {
      console.error(`[Settings] Failed to render ${leaf.id}:`, error);
      clearTimeout(skeletonTimer);
      leafContainer.removeAttribute('aria-busy');
      clearLeafEdits();
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
    // Frische Shell: der geteilte Preferences-Cache gilt genau für einen
    // Settings-Besuch. Alles, was zwischenzeitlich ausserhalb geschrieben
    // wurde (z. B. die Widget-Konfiguration im Dashboard), ist damit weg.
    resetPreferencesCache();

    // Kopf und Koerper sind Geschwister: der Kopf ist full-bleed und polstert
    // sich ueber --page-inline-pad selbst (#577), der Koerper traegt dieselbe
    // Kante. Die Seite selbst polstert nichts - sonst addierten sich die Raender.
    const page = document.createElement('div');
    page.className = 'settings-page';

    const toolbar = document.createElement('div');
    toolbar.className = 'page-toolbar settings-shell-header';

    const body = document.createElement('div');
    body.className = 'settings-page__body';

    shell = document.createElement('div');
    shell.className = 'settings-shell';
    const navigation = createNavigation(domains, user, activeLeaf);
    content = document.createElement('div');
    content.className = 'settings-shell__content';
    shell.append(navigation, content);
    body.appendChild(shell);
    page.append(toolbar, body);
    container.replaceChildren(page);
    // Sidebar-Icons einmalig bei der Montage hydrieren; die Detail-Icons werden
    // pro Render separat (nur im Content-Bereich) hydriert.
    hydrateIcons(navigation);
  }

  const page = shell.closest('.settings-page');
  page?.classList.toggle('settings-page--leaf', Boolean(activeLeaf));
  const toolbar = page?.querySelector(':scope > .page-toolbar');

  const leafDomain = activeLeaf
    ? domains.find((entry) => entry.id === activeLeaf.domainId)
    : null;
  if (activeLeaf && !leafDomain) {
    console.error(
      `[Settings] Cannot render ${activeLeaf.id}: domain "${activeLeaf.domainId}" is not available.`,
    );
  }

  if (activeLeaf && leafDomain) {
    // Kopf zuerst: der Rueckweg steht, bevor das Blatt geladen ist.
    if (toolbar) renderToolbar(toolbar, content, { activeLeaf, domain: leafDomain });
    await renderLeafContent(content, activeLeaf, leafDomain, user, query);
    return;
  }

  renderOverview(content, domains, user);
  hydrateIcons(content);
  if (toolbar) renderToolbar(toolbar, content, {});
  const focusDomain = view === 'domain'
    ? domains.find((entry) => entry.id === domainId)
    : null;
  revealOverviewSection(content, focusDomain?.id);
}
