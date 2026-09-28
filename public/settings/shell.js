import { t } from '/i18n.js';
import { moduleAccentVar } from '/utils/module-accent.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { renderPageSearch, wirePageSearch } from '/utils/page-search.js';
import { createRetryState } from './components.js';
import { watchLeafForms } from './dirty-guard.js';
import { KITCHEN_CHILD_IDS } from './module-order.js';
import { resetPreferencesCache } from './preferences-cache.js';
import {
  filterSettingsDomains,
  findSettingsLeaf,
  firstSettingsSheet,
  searchSettings,
  settingsOptionUrl,
  settingsOverviewUrl,
  settingsSectionUrl,
  settingsSheetSections,
  settingsSheetsForDomain,
} from './registry.js';

// Unter dieser Schwelle ist ein Blatt gefuehlt sofort da; ein Skelett waere
// dort nur ein Aufblitzen.
const SKELETON_DELAY_MS = 120;
/**
 * So lange wartet die Shell hoechstens auf die Abschnitte eines Blatts, bevor
 * sie zurueckkehrt. Der Router haelt waehrend eines Soft-Updates seine
 * Navigationssperre, bis renderSettingsShell aufloest: ein haengender Abschnitt
 * (Push ohne Service Worker, Re-Critique 2026-09-28, A7 P1-2) nahm damit JEDER
 * weiteren Navigation den Weg. Das Blatt wird trotzdem fertig, nur im
 * Hintergrund.
 */
const SECTION_WAIT_MS = 4000;

/**
 * Wartet auf alle Abschnitte, aber hoechstens SECTION_WAIT_MS. `onSettled`
 * laeuft genau einmal, sobald ALLE stehen - ohne Haenger also noch vor der
 * Rueckkehr, wie bisher.
 * @param {Promise<unknown>[]} pending
 * @param {() => void} onSettled
 * @returns {Promise<void>}
 */
function awaitSections(pending, onSettled) {
  const settled = Promise.allSettled(pending).then(() => onSettled());
  let timer;
  const cap = new Promise((resolve) => { timer = setTimeout(resolve, SECTION_WAIT_MS); });
  return Promise.race([settled, cap]).finally(() => clearTimeout(timer));
}

// Der eine Ort, an dem ein Modul an- und ausgeht (registry.js, modules-active).
const ACTIVE_MODULES_PATH = '/settings/modules/active';

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
 * die Vollton-Regel (DESIGN.md, Colors): „Konto", „Darstellung" oder „Backup"
 * nennen kein Modul, also nennen sie auch keine Farbe.
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
  link.addEventListener('click', (event) => {
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
    // Seitenleiste, Suchtreffer, Breadcrumb, Statuszeile und der Zurueck-Link
    // enden in navigate() - und dort fragt der Verlassen-Schutz, bei dem sich
    // der Blatt-Guard anmeldet, solange etwas offen ist (dirty-guard.js). EINE
    // Stelle fuer alle Wege, auch Browser-Zurueck und Befehlspalette, die an
    // diesen Links nie vorbeikamen (R15 A7 P1-1).
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
 * Ein Treffer der Seitenleisten-Suche: Zeichen des Blatts, der Name und darunter
 * der Ort. Fuer ein Blatt ist der Ort sein Bereich, fuer einen Abschnitt oder
 * eine Option ihr Blatt - ohne die Gruppen fehlt sonst, WO der Treffer liegt.
 */
function createNavigationResult({ entry, href, label, context, activeLeaf, exact = true }) {
  const item = document.createElement('li');
  const link = createLink(href, 'settings-shell__navigation-link settings-shell__navigation-result');
  link.dataset.leafId = entry.id;
  if (exact && entry.id === activeLeaf?.id) {
    link.classList.add('settings-shell__navigation-link--active');
    link.setAttribute('aria-current', 'page');
  }
  const text = document.createElement('span');
  text.className = 'settings-shell__navigation-result-text';
  const name = document.createElement('span');
  name.textContent = label;
  const hint = document.createElement('span');
  hint.className = 'settings-shell__navigation-result-domain';
  hint.textContent = context;
  text.append(name, hint);
  link.append(createLeafMark(entry, 'settings-shell__navigation-link-icon'), text);
  item.appendChild(link);
  return item;
}

/**
 * Suchfeld der Seitenleiste - AN DER LISTENKANTE (S3): am Desktop ist die
 * Seitenleiste die Liste der Liste-+-Detail-Form, und ihre Suche filtert
 * genau diese Liste. Seit 2026-09-26 findet sie auch die EINZELNE Option
 * (registry.js `options`, searchSettings) und seit R10 die frueheren Blaetter,
 * die heute Abschnitte sind ("Feed-Abos"). Dieselbe Suche wie in der Wurzel,
 * in anderer Anordnung; das geteilte Suchfeld der Shell (renderPageSearch).
 */
function createNavigationSearch(navigation, domains, user, activeLeaf) {
  const domainLabels = new Map(domains.map((domain) => [domain.id, t(domain.labelKey)]));

  navigation.insertAdjacentHTML('afterbegin', renderPageSearch({
    id: 'settings-navigation-search',
    label: t('settings.searchLabel'),
    placeholder: t('search.placeholder'),
    clearLabel: t('common.searchClear'),
    className: 'settings-shell__navigation-search',
  }));
  const field = navigation.firstElementChild;

  const results = document.createElement('ul');
  results.className = 'settings-shell__navigation-list settings-shell__navigation-results';
  results.hidden = true;

  const status = document.createElement('p');
  status.className = 'settings-shell__navigation-status';
  status.setAttribute('role', 'status');
  status.hidden = true;

  const groups = () => navigation.querySelectorAll('.settings-shell__navigation-group');

  const applyFilter = (value) => {
    const query = String(value ?? '').trim();
    const searching = query.length > 0;

    for (const group of groups()) group.hidden = searching;
    results.hidden = !searching;
    status.hidden = !searching;

    if (!searching) {
      results.replaceChildren();
      status.textContent = '';
      return;
    }

    const hits = searchSettings(query, { user, translate: t });
    results.replaceChildren(
      ...hits.leaves.map((entry) => createNavigationResult({
        entry,
        href: entry.path,
        label: t(entry.labelKey),
        context: domainLabels.get(entry.domainId) ?? '',
        activeLeaf,
      })),
      ...hits.sections.map(({ leaf, section, label }) => createNavigationResult({
        entry: leaf,
        href: settingsSectionUrl(leaf, section.id),
        label,
        context: t(leaf.labelKey),
        activeLeaf,
        exact: false,
      })),
      ...hits.options.map(({ leaf, key, label }) => createNavigationResult({
        entry: leaf,
        href: settingsOptionUrl(leaf, key),
        label,
        context: t(leaf.labelKey),
        activeLeaf,
        exact: false,
      })),
    );
    hydrateIcons(results);

    const count = hits.leaves.length + hits.sections.length + hits.options.length;
    status.textContent = count ? t('settings.searchResults', { count }) : t('search.noResults');
  };

  field.after(status, results);
  wirePageSearch(navigation, { id: 'settings-navigation-search', delay: 0, onQuery: applyFilter });
}

/**
 * DIE LISTE DER LISTE-+-DETAIL-FORM (S3): alle Blaetter, nach Bereichen
 * gruppiert, ohne Akkordeon. Bis R10 war die Seitenleiste ein Akkordeon mit
 * genau einem offenen Bereich - bei drei Bereichen und 26 Blaettern ist die
 * ganze Liste kuerzer als die Suche nach dem richtigen Aufklapper (Apples
 * Systemeinstellungen zeigen sie ebenso offen).
 */
function createNavigation(domains, user, activeLeaf) {
  const navigation = document.createElement('nav');
  navigation.className = 'settings-shell__navigation';
  navigation.setAttribute('aria-label', t('settings.navigationLabel'));

  for (const domain of domains) {
    const group = document.createElement('section');
    group.className = 'settings-shell__navigation-group';
    group.dataset.domainId = domain.id;
    if (domain.id === activeLeaf?.domainId) {
      group.classList.add('settings-shell__navigation-group--active');
    }

    const heading = document.createElement('h2');
    heading.className = 'settings-shell__navigation-heading';
    heading.id = `settings-navigation-${domain.id}`;
    heading.textContent = t(domain.labelKey);
    group.setAttribute('aria-labelledby', heading.id);

    const list = document.createElement('ul');
    list.className = 'settings-shell__navigation-list';
    for (const entry of settingsSheetsForDomain(domain.id, user)) {
      const item = document.createElement('li');
      item.appendChild(createNavigationLink(entry, activeLeaf));
      list.appendChild(item);
    }

    group.append(heading, list);
    navigation.appendChild(group);
  }

  createNavigationSearch(navigation, domains, user, activeLeaf);
  return navigation;
}

/**
 * Die Seitenleiste scrollt fuer sich (settings.css): das aktive Blatt muss in
 * ihr sichtbar sein, sonst zeigte ein Deep-Link auf "Gesundheit" rechts das
 * Blatt und links nur Konto und Haushalt. Nur die Leiste scrollt, nie die
 * Seite - `scrollIntoView` zoege den ganzen Port mit.
 */
function revealActiveNavigationLink(navigation) {
  const link = navigation?.querySelector('.settings-shell__navigation-link--active');
  if (!link || navigation.scrollHeight <= navigation.clientHeight) return;
  // Die klebende Leiste ist positioniert und damit der offsetParent der Links.
  const top = link.offsetParent === navigation ? link.offsetTop : link.offsetTop - navigation.offsetTop;
  const bottom = top + link.offsetHeight;
  if (top < navigation.scrollTop) navigation.scrollTop = top;
  else if (bottom > navigation.scrollTop + navigation.clientHeight) {
    navigation.scrollTop = bottom - navigation.clientHeight;
  }
}

// Aktualisiert nur den Aktivzustand der bestehenden Navigation, ohne die Links
// (und ihre Icons) neu aufzubauen - Grundlage fuer Soft-Navigation zwischen
// Settings-Blaettern.
function updateNavigationActiveState(navigation, activeLeaf) {
  if (!navigation) return;
  const activeDomainId = activeLeaf?.domainId ?? null;

  for (const group of navigation.querySelectorAll('.settings-shell__navigation-group')) {
    group.classList.toggle('settings-shell__navigation-group--active', group.dataset.domainId === activeDomainId);
  }

  for (const link of navigation.querySelectorAll('.settings-shell__navigation-link')) {
    const isActive = link.dataset.leafId === activeLeaf?.id && !link.classList.contains('settings-shell__navigation-result');
    link.classList.toggle('settings-shell__navigation-link--active', isActive);
    if (isActive) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  }
  revealActiveNavigationLink(navigation);
}

/**
 * EINE gruppierte Liste aller Blaetter - die Wurzel der Einstellungen UNTER der
 * Split-Schwelle (Kopfregel mobil, 2026-09-26; Critique A7 P1). Darueber ist
 * dieselbe Liste die Seitenleiste, und rechts steht ein Blatt (S3).
 *
 * DIE BEREICHSEBENE GIBT ES NICHT MEHR. Ein Deep-Link `?view=domain&domain=x`
 * (Breadcrumb, Rueckweg aus dem Blatt, alte Lesezeichen) landet auf derselben
 * Liste, gescrollt auf den Abschnitt - am Desktop auf dem ersten Blatt des
 * Bereichs.
 */
function createOverviewRow(entry) {
  const link = createLink(entry.path, 'settings-overview__row');
  link.dataset.leafId = entry.id;
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
    const leaves = settingsSheetsForDomain(domain.id, user);
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
    for (const entry of leaves) list.appendChild(createOverviewRow(entry));

    section.append(heading, list);
    overview.appendChild(section);
  }

  // Treffer auf fruehere Blaetter (heute Abschnitte) und EINZELNE Optionen. Ein
  // eigener Abschnitt unter den Blaettern, gefuellt nur waehrend der Suche: die
  // Zeile nennt den Treffer und darunter sein Blatt, der Sprung landet an der
  // Stelle.
  const optionsSection = document.createElement('section');
  optionsSection.className = 'settings-overview__section settings-overview__section--options';
  optionsSection.hidden = true;
  const optionsHeading = document.createElement('h2');
  optionsHeading.className = 'settings-overview__heading';
  optionsHeading.id = 'settings-overview-options-heading';
  optionsHeading.append(
    createIcon('sliders-horizontal', 'settings-overview__heading-icon'),
    document.createTextNode(t('settings.searchOptionsHeading')),
  );
  optionsSection.setAttribute('aria-labelledby', optionsHeading.id);
  const optionsList = document.createElement('div');
  optionsList.className = 'settings-overview__list';
  optionsSection.append(optionsHeading, optionsList);
  overview.appendChild(optionsSection);

  overviewUsers.set(overview, user);
  content.replaceChildren(overview);
  return overview;
}

/** Nutzer der gerenderten Wurzel - die Suche filtert nach seinen Rechten. */
const overviewUsers = new WeakMap();

/** Treffer auf einen Abschnitt oder eine Option: die Beschriftung, darunter ihr Blatt. */
function createOptionRow({ leaf, href, label }) {
  const link = createLink(href, 'settings-overview__row settings-overview__row--option');
  link.dataset.leafId = leaf.id;
  link.appendChild(createLeafMark(leaf, 'settings-overview__row-mark'));
  const copy = document.createElement('span');
  copy.className = 'settings-overview__row-copy';
  const title = document.createElement('span');
  title.className = 'settings-overview__row-title';
  title.textContent = label;
  const context = document.createElement('span');
  context.className = 'settings-overview__row-context';
  context.textContent = t(leaf.labelKey);
  copy.append(title, context);
  link.append(copy, createIcon('chevron-right', 'settings-overview__row-chevron'));
  return link;
}

/**
 * Filtert die Liste der Wurzel nach der Kopf-Suche. Ein Abschnitt ohne Treffer
 * faellt mit weg, damit keine leeren Ueberschriften stehen bleiben; die Zahl
 * geht in die Live-Region, ein leeres Ergebnis nennt der geteilte Leerzustand.
 * Gesucht wird ueber dieselbe Funktion wie in der Seitenleiste (searchSettings).
 */
function filterOverview(content, value) {
  const overview = content.querySelector('.settings-overview');
  if (!overview) return;
  const query = String(value ?? '').trim();
  const hits = searchSettings(query, { user: overviewUsers.get(overview), translate: t });
  const leafIds = new Set(hits.leaves.map((leaf) => leaf.id));
  const status = overview.querySelector('.settings-overview__status');
  for (const section of overview.querySelectorAll('.settings-overview__section:not(.settings-overview__section--options)')) {
    let visible = 0;
    for (const row of section.querySelectorAll('.settings-overview__row')) {
      const match = !query || leafIds.has(row.dataset.leafId);
      row.hidden = !match;
      if (match) visible += 1;
    }
    section.hidden = visible === 0;
  }

  const optionsSection = overview.querySelector('.settings-overview__section--options');
  const extra = [
    ...hits.sections.map(({ leaf, section, label }) => ({ leaf, label, href: settingsSectionUrl(leaf, section.id) })),
    ...hits.options.map(({ leaf, key, label }) => ({ leaf, label, href: settingsOptionUrl(leaf, key) })),
  ];
  if (optionsSection) {
    const list = optionsSection.querySelector('.settings-overview__list');
    list.replaceChildren(...extra.map(createOptionRow));
    optionsSection.hidden = extra.length === 0;
    hydrateIcons(list);
  }

  if (!status) return;
  const count = hits.leaves.length + extra.length;
  status.hidden = !query;
  status.textContent = !query
    ? ''
    : (count ? t('settings.searchResults', { count }) : t('search.noResults'));
}

/**
 * Scrollt die Wurzel auf den Abschnitt eines Bereichs (Deep-Link).
 *
 * NACH DEM ROUTER, NICHT IM RENDER: der Router setzt den Scrollport nach einer
 * Soft-Navigation erst NACH `update()` zurueck (router.js, Soft-Update) - ein
 * Sprung im Render waere sofort wieder kassiert.
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
 * vom Router verdrahtet). Er kennt zwei Zustaende:
 *
 *   WURZEL: Titel + Suche (mobil als Such-Icon, Kopfregel mobil Regel 4).
 *   BLATT: nur der Rueckweg - Apples Navigationsleiste mit „< Einstellungen".
 *     Ab 768px traegt der Breadcrumb den Rueckweg, ab der Split-Schwelle die
 *     Seitenleiste; dort blendet settings.css den Kopf auf Blaettern aus.
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

/**
 * Ist das Modul des Blatts fuer den Haushalt an? Die Kueche fasst vier Module
 * zusammen und ist an, solange eines davon es ist (wie in Aktive Module).
 * Ohne Router-Zustand (Tests, Frueh-Render) gilt es als an.
 */
function moduleEnabled(moduleId) {
  const disabled = (id) => Boolean(window.yuvomi?.isModuleDisabled?.(id));
  if (moduleId === 'kitchen') return KITCHEN_CHILD_IDS.some((id) => !disabled(id));
  return !disabled(moduleId);
}

/**
 * DIE STATUSZEILE EINES MODULBLATTS (S1). Ob ein Modul fuer den Haushalt an
 * ist, entscheidet NUR Aktive Module - bis R10 stand der Schalter fuer
 * Belohnungen ein zweites Mal im Belohnungsblatt. Hier steht der Zustand als
 * Zeichen fuer alle (Nur-lesen-Regel: der Zustand bleibt, die Handlung geht),
 * der Weg zum Schalter nur fuer Admins, die ihn bedienen duerfen.
 * Uebersicht und Einstellungen sind gesperrt (nie aus) und bekommen keine Zeile.
 */
function createModuleStatus(leaf, user) {
  if (!leaf.module || leaf.module === 'dashboard') return null;
  const enabled = moduleEnabled(leaf.module);
  const row = document.createElement('div');
  row.className = `settings-sheet-status settings-sheet-status--${enabled ? 'on' : 'off'}`;

  const state = document.createElement('p');
  state.className = 'settings-sheet-status__state';
  state.append(
    createIcon(enabled ? 'circle-check' : 'circle-off', 'settings-sheet-status__icon'),
    document.createTextNode(t(enabled ? 'settings.moduleStatusOn' : 'settings.moduleStatusOff', { module: t(leaf.labelKey) })),
  );
  row.appendChild(state);

  if (user?.role === 'admin') {
    const link = createLink(ACTIVE_MODULES_PATH, 'settings-sheet-status__link');
    link.append(
      document.createTextNode(t('settings.pageActiveModules')),
      createIcon('chevron-right', 'settings-sheet-status__link-icon'),
    );
    row.appendChild(link);
  }
  return row;
}

// Wie lange die angesprungene Option markiert bleibt, und wie lange ihre
// Markierung ausblendet (--transition-slow, settings.css).
const OPTION_MARK_MS = 2000;
const OPTION_FADE_MS = 400;
// Solange darf ein Blatt brauchen, um die gesuchte Option nachzuladen (Konten,
// Kanaele und Abos kommen erst nach einer zweiten Anfrage ins Blatt).
const OPTION_WAIT_MS = 3000;

const collapseText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/** Das Element, das die Beschriftung einer Option traegt - oder null. */
function findOptionLabel(root, text) {
  const wanted = collapseText(text);
  if (!wanted) return null;
  const candidates = root.querySelectorAll(
    'h2, h3, h4, legend, label, .toggle-row__label, .form-label, .settings-card__title, strong, span, summary, button',
  );
  for (const el of candidates) {
    // Eigener Text zaehlt vor dem ganzen: ein Label mit Pflicht-Sternchen
    // (`Kontoname<span> *</span>`) traegt die Beschriftung nur als Textknoten.
    const own = collapseText([...el.childNodes]
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent)
      .join(' '));
    if (own === wanted || collapseText(el.textContent) === wanted) return el;
  }
  return null;
}

function markTarget(target) {
  target.classList.add('settings-search-target');
  setTimeout(() => target.classList.add('settings-search-target--fading'), OPTION_MARK_MS);
  setTimeout(() => target.classList.remove('settings-search-target', 'settings-search-target--fading'), OPTION_MARK_MS + OPTION_FADE_MS);
}

/**
 * Zeigt die Option, auf die ein Suchtreffer zeigt (`?option=<key>`, registry.js
 * `options`): scrollt sie in die Mitte, markiert ihren Traeger kurz und legt
 * den Fokus auf ihr Bedienelement - fuer Sam soll der Sprung dort enden, wo
 * die Einstellung IST, nicht an der Blatt-Ueberschrift.
 *
 * Gesucht wird die SICHTBARE Beschriftung (t(key)) im gerenderten Blatt: kein
 * Blatt muss dafuer Anker pflegen, und test:settings-copy haelt, dass die
 * Beschriftung in ihrem Abschnitt vorkommt. Laedt ein Abschnitt einen Teil
 * nach, wartet die Suche bis OPTION_WAIT_MS; findet sie nichts, bleibt es bei
 * der Ueberschrift - der Sprung ist dann ein Sprung aufs Blatt, kein Fehler.
 *
 * NACH DEM ROUTER, NICHT IM RENDER: derselbe Grund wie bei
 * revealOverviewSection - ein Soft-Update setzt den Scrollport erst danach
 * zurueck.
 *
 * @returns {boolean} true, wenn die Option sofort gefunden wurde
 */
function revealSettingsOption(leafContainer, key) {
  // ERST der Schluessel, DANN t(): fast jeder Blattaufruf kommt ohne
  // `?option=`, und t(null) wirft in i18n.js (resolveExtensionTranslation) -
  // gemessen riss das JEDES Blatt ohne Suchtreffer in den Fehlerzustand.
  if (typeof key !== 'string' || !key) return false;
  const text = t(key);
  if (text === key) return false;

  const reveal = (label) => {
    const heading = label.matches('h2, h3, h4, legend, .settings-card__title');
    const target = heading
      ? (label.closest('fieldset, .settings-card, .settings-section') ?? label)
      : (label.closest('.toggle-row, .form-group, .form-field, .settings-setting-row, fieldset, .settings-card') ?? label);
    setTimeout(() => {
      if (!target.isConnected) return;
      const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({ block: 'center', behavior: calm ? 'auto' : 'smooth' });
      const control = heading
        ? null
        : target.querySelector('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])');
      // Ein Textfeld bekommt den Fokus NICHT: am Telefon oeffnete das die
      // Tastatur ueber genau der Stelle, die der Sprung zeigen soll. Dann traegt
      // die Beschriftung den Fokus, der naechste Tab-Schritt ist das Feld.
      const typing = control?.matches('textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="color"]):not([type="range"])');
      const focusTarget = (typing ? null : control) ?? label;
      if (focusTarget === label && label.tabIndex < 0 && !label.hasAttribute('tabindex')) label.tabIndex = -1;
      focusTarget.focus({ preventScroll: true });
      markTarget(target);
    }, 0);
  };

  const found = findOptionLabel(leafContainer, text);
  if (found) {
    reveal(found);
    return true;
  }
  const observer = new MutationObserver(() => {
    const late = findOptionLabel(leafContainer, text);
    if (!late) return;
    observer.disconnect();
    reveal(late);
  });
  observer.observe(leafContainer, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), OPTION_WAIT_MS);
  return false;
}

/** Id des Traegers eines Abschnitts im Blatt - Sprungziel von `?section=`. */
function sheetSectionId(sectionId) {
  return `settings-section-${sectionId}`;
}

/**
 * Springt an einen Abschnitt (`?section=<id>`): Ziel der Umleitungen von den
 * Adressen vor R10 (`/settings/sync/calendar` -> Kalender, Abschnitt
 * Kalender-Synchronisation) und der Suchtreffer auf fruehere Blaetter. Der
 * Fokus geht auf die erste Ueberschrift des Abschnitts, damit Tastatur und
 * Screenreader dort weiterlesen, wo das Auge landet.
 *
 * @returns {boolean} true, wenn es den Abschnitt in diesem Blatt gibt
 */
function revealSheetSection(leafContainer, sectionId) {
  if (typeof sectionId !== 'string' || !sectionId) return false;
  const host = leafContainer.querySelector(`#${CSS.escape(sheetSectionId(sectionId))}`);
  if (!host) return false;
  setTimeout(() => {
    if (!host.isConnected) return;
    host.scrollIntoView({ block: 'start' });
    const heading = host.querySelector('h2, h3, legend') ?? host;
    if (heading.tabIndex < 0 && !heading.hasAttribute('tabindex')) heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
    markTarget(host);
  }, 0);
  return true;
}

/**
 * Rendert EINEN Abschnitt in seinen Traeger. Ein Fehler bleibt im Abschnitt:
 * scheitert die Kalender-Synchronisation, stehen die Termin-Vorgaben darueber
 * trotzdem (vorher war ein Blatt ein Abschnitt, und der Fehler nahm das Blatt).
 */
async function renderSheetSection(host, section, user, query) {
  const loadAndRender = async ({ focusRetry = false } = {}) => {
    try {
      const module = await section.loader();
      if (typeof module.render !== 'function') throw new TypeError('Settings leaf must export render()');
      host.replaceChildren();
      await module.render(host, { user, query });
      hydrateIcons(host);
    } catch (error) {
      console.error(`[Settings] Failed to render ${section.id}:`, error);
      const retryState = createRetryState({
        message: t('settings.loadError'),
        onRetry: () => loadAndRender({ focusRetry: true }),
      });
      host.replaceChildren(retryState);
      hydrateIcons(host);
      if (focusRetry) {
        const retryButton = retryState.querySelector('.settings-retry-state__button');
        requestAnimationFrame(() => {
          if (retryButton?.isConnected && host.contains(retryButton)) {
            retryButton.focus({ preventScroll: true });
          }
        });
      }
    }
  };
  await loadAndRender();
}

/**
 * EIN BLATT JE MODUL (S1): Statuszeile, dann die Abschnitte "Fuer mich", dann
 * "Fuer den Haushalt". Jeder Abschnitt ist ein frueheres Blatt mit seinem
 * eigenen Loader und rendert in seinen eigenen Traeger - dieselben Endpunkte,
 * dieselben Schluessel, nur ein anderer Ort. Die Reichweiten-Ueberschriften
 * stehen nur auf Modulblaettern: im Konto ist alles meins, im Haushalt alles
 * des Haushalts, und die Ueberschrift saegte dort nur Platz ab.
 */
async function renderLeafContent(content, leaf, domain, user, query) {
  // Den Fokus nur nachziehen, wenn er schon in den Einstellungen lag (Klick in
  // der Seitenleiste, Breadcrumb, Suchtreffer, Vor/Zurueck). Eine Vorwahl ohne
  // Geste (S3) nimmt ihn niemandem weg.
  const page = content.closest('.settings-page');
  const quiet = !page?.contains(document.activeElement);
  // Der mobile Rueckweg steht nicht hier, sondern im klebenden Kopf
  // (renderToolbar): als Textlink im Inhalt scrollte er mit weg.
  const breadcrumb = createBreadcrumb(domain, leaf);

  // Der Leaf-Header wird zentral aus der Registry gerendert (Prio 5/B1): die
  // Abschnitte liefern nur noch Content.
  const header = createLeafHeader(leaf);
  const heading = header.querySelector('.settings-leaf-header__title');

  const leafContainer = document.createElement('div');
  leafContainer.className = 'settings-leaf';
  // DER BLATTWECHSEL BLENDET (R14, A7 P3): er schnitt hart, waehrend jeder
  // andere Wechsel der App ueberblendet. Nur ein WECHSEL - der erste Aufbau
  // kommt schon mit der Seitenblende des Routers. Die neuen Knoten tragen die
  // Klasse, also laeuft die Animation je Wechsel neu (settings.css).
  const swapping = Boolean(content.querySelector(':scope > .settings-leaf'));
  content.replaceChildren(breadcrumb, header, leafContainer);
  if (swapping) {
    for (const node of [header, leafContainer]) node.classList.add('settings-sheet-enter');
  }

  const sections = settingsSheetSections(leaf, user);
  const scoped = Boolean(leaf.module);
  const status = createModuleStatus(leaf, user);
  if (status) leafContainer.appendChild(status);

  const hosts = [];
  for (const scope of ['mine', 'household']) {
    const inScope = sections.filter((section) => section.scope === scope);
    if (!inScope.length) continue;
    let parent = leafContainer;
    if (scoped) {
      const group = document.createElement('section');
      group.className = `settings-scope settings-scope--${scope}`;
      const title = document.createElement('h2');
      title.className = 'settings-scope__title';
      title.id = `settings-scope-${leaf.id}-${scope}`;
      title.textContent = t(scope === 'mine' ? 'settings.scopeMine' : 'settings.scopeHousehold');
      group.setAttribute('aria-labelledby', title.id);
      group.appendChild(title);
      leafContainer.appendChild(group);
      parent = group;
    }
    for (const section of inScope) {
      const host = document.createElement('div');
      host.className = 'settings-sheet-section';
      host.id = sheetSectionId(section.id);
      host.dataset.sectionId = section.id;
      if (section.props?.part) host.dataset.part = section.props.part;
      parent.appendChild(host);
      hosts.push([host, section]);
    }
  }

  // Der Blattwechsel laedt Module und danach deren Daten. aria-busy gilt
  // sofort; das Skelett kommt erst nach einer kurzen Frist, damit ein Blatt aus
  // dem Modul-Cache nicht kurz aufblitzt.
  leafContainer.setAttribute('aria-busy', 'true');
  const skeletonTimer = setTimeout(() => {
    for (const [host] of hosts) {
      if (host.isConnected && !host.firstChild) {
        host.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 2, lines: 3 }));
      }
    }
  }, SKELETON_DELAY_MS);

  const finishLeaf = () => {
    clearTimeout(skeletonTimer);
    // Kam das Blatt erst nach einem Wechsel zu Ende, steht schon ein anderes:
    // dann weder Fokus noch Formularwache fuer ein abgehaengtes Blatt.
    if (!leafContainer.isConnected) return;
    leafContainer.removeAttribute('aria-busy');
    watchLeafForms(leafContainer);
    hydrateIcons(content);

    // Ein Suchtreffer endet an der Option, eine Umleitung am Abschnitt, sonst die
    // Ueberschrift des Blatts - ausser das Blatt wurde vorgewaehlt (S3): dann
    // bleibt der Fokus, wo er war, wie bei jeder Vorwahl ohne Geste.
    heading.tabIndex = -1;
    if (revealSettingsOption(leafContainer, query?.get?.('option'))) return;
    if (revealSheetSection(leafContainer, query?.get?.('section'))) return;
    if (quiet) return;
    requestAnimationFrame(() => {
      if (!leafContainer.contains(document.activeElement)) heading.focus({ preventScroll: true });
    });
  };
  // Nicht blockierend: ein haengender Abschnitt haelt weder die Shell noch die
  // Navigationssperre des Routers (siehe SECTION_WAIT_MS).
  await awaitSections(
    hosts.map(([host, section]) => renderSheetSection(host, section, user, query)),
    finishLeaf,
  );
}

/**
 * LISTE + DETAIL AB DER SPLIT-SCHWELLE (S3). Ob die Seitenleiste steht,
 * entscheidet das CSS (settings.css, `@container settings-surface`), nicht
 * diese Datei - wie beim Baustein (utils/master-detail.js): `matchMedia`
 * kennt keine Container Queries, und eine zweite Schwelle hier liefe der im
 * Stylesheet davon. Gefragt wird die gerechnete Darstellung der Seitenleiste.
 */
function isSplit(shell) {
  const navigation = shell?.querySelector(':scope > .settings-shell__navigation');
  return Boolean(navigation?.isConnected) && getComputedStyle(navigation).display !== 'none';
}

let splitObserver = null;

/**
 * DAS ERSTE BLATT VORWAEHLEN (S3, L2): am Desktop gibt es keine Wurzel-Liste
 * neben der Seitenleiste - die WAERE dieselbe Liste zweimal. Ohne Blatt in der
 * Adresse zeigt die rechte Spalte deshalb das erste Blatt (des Bereichs aus
 * `?view=domain&domain=x`, sonst Konto). `replaceState`, kein neuer
 * History-Eintrag, kein Fokuswechsel; mobil nie - dort IST die Liste die Seite.
 */
function preselectSheet(container, { user, domainId }) {
  const sheet = firstSettingsSheet(user, domainId);
  if (!sheet) return false;
  history.replaceState({ ...(history.state ?? {}), path: sheet.path }, '', sheet.path);
  renderSettingsShell(container, { user, leaf: sheet, incremental: true })
    .catch((error) => console.error('[Settings] Preselect failed:', error));
  return true;
}

/**
 * Wird das Fenster breiter, waehrend die Wurzel-Liste steht, rutscht sie in
 * die Seitenleiste - und rechts gehoert ein Blatt hin. Umgekehrt bleibt das
 * Blatt stehen: mobil ist ein Blatt mit Zurueck genau die Push-Navigation.
 */
function watchSplit(container, page, { user, domainId }) {
  splitObserver?.disconnect();
  splitObserver = null;
  if (typeof ResizeObserver !== 'function') return;
  splitObserver = new ResizeObserver(() => {
    if (!page.isConnected) {
      splitObserver?.disconnect();
      splitObserver = null;
      return;
    }
    if (page.classList.contains('settings-page--leaf')) return;
    if (isSplit(page.querySelector('.settings-shell'))) preselectSheet(container, { user, domainId });
  });
  splitObserver.observe(page);
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
  // Sidebar stehen - wir tauschen nur den Aktivzustand und den Detailbereich.
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
    // Frische Shell: der geteilte Preferences-Cache gilt genau fuer einen
    // Settings-Besuch.
    resetPreferencesCache();

    // Kopf und Koerper sind Geschwister: der Kopf ist full-bleed und polstert
    // sich ueber --page-inline-pad selbst (#577), der Koerper traegt dieselbe
    // Kante. Die Seite ist der Container, an dem die Split-Schwelle misst.
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
    requestAnimationFrame(() => revealActiveNavigationLink(navigation));
  }

  const page = shell.closest('.settings-page');
  page?.classList.toggle('settings-page--leaf', Boolean(activeLeaf));
  const toolbar = page?.querySelector(':scope > .page-toolbar');

  const focusDomain = view === 'domain'
    ? domains.find((entry) => entry.id === domainId)
    : null;
  // Die Wurzel am Desktop: erstes Blatt statt einer zweiten Liste (S3).
  if (!activeLeaf && page && isSplit(shell) && preselectSheet(container, { user, domainId: focusDomain?.id ?? null })) return;

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
  revealOverviewSection(content, focusDomain?.id);
  if (page) watchSplit(container, page, { user, domainId: focusDomain?.id ?? null });
}

/** Nur fuer Tests (test-settings-navigation.js). */
export const __test = { awaitSections, SECTION_WAIT_MS };
