/**
 * Modul: Client-Side Router
 * Zweck: SPA-Routing über History API ohne Framework, Auth-Guard, Seiten-Übergänge
 * Abhängigkeiten: api.js
 */

import { api, auth } from '/api.js';
import { canAccessNavModule, navModuleAccess } from '/permissions.js';
import { clearApiCache } from '/sw-register.js';
import { initI18n, getLocale, t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { init as initReminders, stop as stopReminders } from '/reminders.js';
import { initPush, stopPush } from '/push.js';
import { isKitchenRoute, getLastKitchenRoute } from '/utils/kitchen-tabs.js';
import { getLastHealthRoute, HEALTH_ROUTES } from '/utils/health-tabs.js';
import { activityType } from '/utils/health-activity.js';
import { buildHelpRows } from '/utils/help.js';
import { openModal, confirmModal } from '/components/modal.js';
import '/components/datepicker.js';
import { NAV_ICONS } from '/nav-icons.js';
import { SETTINGS_LEAVES } from '/settings/registry.js';
import {
  NAV_SECTION,
  resolveMobileNavOrder,
  sortNavigationItems,
} from '/settings/module-order.js';

// --------------------------------------------------------
// Routen-Definitionen
// Jede Route hat: path, page (dynamisch geladen), requiresAuth, module (für theme-color)
// --------------------------------------------------------
const ROUTES = [
  { path: '/login',    page: '/pages/login.js',    requiresAuth: false, module: null        },
  { path: '/setup',    page: '/pages/setup.js',    requiresAuth: false, module: null        },
  { path: '/forgot-password', page: '/pages/forgot-password.js', requiresAuth: false, module: null },
  { path: '/reset-password',  page: '/pages/reset-password.js',  requiresAuth: false, module: null },
  { path: '/',         page: '/pages/dashboard.js', requiresAuth: true, module: 'dashboard' },
  { path: '/tasks',    page: '/pages/tasks.js',     requiresAuth: true, module: 'tasks'     },
  { path: '/shopping', page: '/pages/shopping.js',  requiresAuth: true, module: 'shopping'  },
  { path: '/meals',    page: '/pages/meals.js',     requiresAuth: true, module: 'meals'     },
  { path: '/calendar', page: '/pages/calendar.js',  requiresAuth: true, module: 'calendar'  },
  { path: '/birthdays', page: '/pages/birthdays.js', requiresAuth: true, module: 'birthdays' },
  { path: '/notes',    page: '/pages/notes.js',     requiresAuth: true, module: 'notes'     },
  { path: '/recipes',  page: '/pages/recipes.js',   requiresAuth: true, module: 'recipes'   },
  { path: '/contacts', page: '/pages/contacts.js',  requiresAuth: true, module: 'contacts'  },
  { path: '/budget',   page: '/pages/budget.js',    requiresAuth: true, module: 'budget'    },
  { path: '/documents', page: '/pages/documents.js', requiresAuth: true, module: 'documents' },
  { path: '/housekeeping', page: '/pages/housekeeping.js', requiresAuth: true, module: 'housekeeping' },
  { path: '/rewards',  page: '/pages/rewards.js',    requiresAuth: true, module: 'rewards'   },
];

// Settings ist eine Sektion mit einer Wurzel und je einer exakten Route pro
// Blatt (Leaf). Die Routen werden aus der Registry abgeleitet, damit es keine
// doppelten Pfad-Definitionen gibt.
const SETTINGS_ROUTES = [
  { path: '/settings', page: '/pages/settings.js', requiresAuth: true, module: 'settings' },
  ...SETTINGS_LEAVES.map(({ path }) => ({ path, page: '/pages/settings.js', requiresAuth: true, module: 'settings' })),
];

ROUTES.push(...SETTINGS_ROUTES);

// Gesundheit ist — wie Settings — eine Sektion mit einer Wurzel (/health) und je
// einer exakten Route pro Sub-Tab. Alle Routen laden dasselbe Seitenmodul; die
// Soft-Navigation zwischen den Tabs läuft über dessen update()-Funktion.
const HEALTH_PAGE_ROUTES = HEALTH_ROUTES.map((path) => ({
  path, page: '/pages/health.js', requiresAuth: true, module: 'health',
}));

ROUTES.push(...HEALTH_PAGE_ROUTES);

// --------------------------------------------------------
// Standalone-Modus: Dynamische theme-color Anpassung
// Statusbar-Farbe spiegelt aktuelle Seite / Modal-State wider
// --------------------------------------------------------
const isStandalone = window.matchMedia('(display-mode: standalone)').matches
  || navigator.standalone === true;

/**
 * Setzt die theme-color Meta-Tags (Light + Dark Variante).
 * @param {string} lightColor
 * @param {string} [darkColor] - Falls nicht angegeben, wird lightColor für beide gesetzt
 */
function setThemeColor(lightColor, darkColor) {
  if (!isStandalone) return;
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  if (metas.length >= 2) {
    metas[0].setAttribute('content', lightColor);
    metas[1].setAttribute('content', darkColor || lightColor);
  } else if (metas.length === 1) {
    metas[0].setAttribute('content', lightColor);
  }
}

/** Liest eine CSS Custom Property vom :root */
function getCSSToken(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Setzt theme-color passend zum aktuellen Modul */
function updateThemeColorForRoute(route) {
  if (route?.thirdPartyModule?.accent) {
    setThemeColor(route.thirdPartyModule.accent, route.thirdPartyModule.accent);
    return;
  }
  if (!route?.module) {
    setThemeColor('#007AFF', '#1C1C1E');
    return;
  }
  const color = getCSSToken(`--module-${route.module}`);
  if (color) {
    setThemeColor(color, color);
  }
}

// --------------------------------------------------------
// Dynamisches Stylesheet-Loading pro Seitenmodul
// --------------------------------------------------------
let activePageStyle = null;

function loadPageStyle(moduleName, routeStyle = null) {
  if (!moduleName && !routeStyle) return { ready: Promise.resolve(), cleanup: () => {} };
  const href = routeStyle || `/styles/${moduleName}.css`;
  if (activePageStyle?.getAttribute('href') === href) {
    return { ready: Promise.resolve(), cleanup: () => {} };
  }

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;

  const oldLink = activePageStyle;

  const ready = new Promise((resolve) => {
    link.onload = resolve;
    link.onerror = resolve;
  });

  document.head.appendChild(link);
  activePageStyle = link;

  return {
    ready,
    cleanup: () => { if (oldLink) oldLink.remove(); },
  };
}

// --------------------------------------------------------
// Modul-Cache: verhindert redundante dynamic imports bei Navigation
// --------------------------------------------------------
const moduleCache = new Map();

async function importPage(pagePath) {
  if (!moduleCache.has(pagePath)) {
    moduleCache.set(pagePath, await import(pagePath));
  }
  return moduleCache.get(pagePath);
}

// --------------------------------------------------------
// Prefetch: Seitenmodul + CSS auf Absicht (Hover/Touch) und im Leerlauf
// vorwärmen. Ohne Bundler löst jeder navigate() erst beim Klick den ES-Modul-
// Import-Wasserfall (Seite + transitive Imports) und einen frischen CSS-Fetch
// aus — der spürbare Verzug vor dem Skeleton. `modulepreload` lädt und parst
// den kompletten Modulgraphen vorab (ein späteres import() löst dann sofort aus
// dem Cache auf), `prefetch` wärmt das Stylesheet ohne es anzuwenden.
// Reine Resource-Hints: kein Modul wird vorzeitig ausgeführt.
// --------------------------------------------------------
const _prefetchedPages = new Set();
const _prefetchedStyles = new Set();

function prefetchRoute(path) {
  if (!path) return;
  const route = allRoutes().find((r) => r.path === path);
  if (!route) return;

  if (route.page && !moduleCache.has(route.page) && !_prefetchedPages.has(route.page)) {
    _prefetchedPages.add(route.page);
    const link = document.createElement('link');
    link.rel = 'modulepreload';
    link.href = route.page;
    document.head.appendChild(link);
  }

  const cssHref = route.style || (route.module && !route.thirdPartyModule ? `/styles/${route.module}.css` : null);
  if (cssHref && !_prefetchedStyles.has(cssHref)) {
    _prefetchedStyles.add(cssHref);
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.as = 'style';
    link.href = cssHref;
    document.head.appendChild(link);
  }
}

// Nach dem Mount die sichtbaren Hauptnavigations-Ziele im Leerlauf vorwärmen,
// damit schon die erste Navigation ohne Kaltstart-Wasserfall auskommt.
// saveData respektiert Datensparmodus; das Dashboard (currentPath) wird
// übersprungen, da bereits geladen.
function warmPrimaryRoutes() {
  if (navigator.connection?.saveData) return;
  const run = () => {
    try {
      navItems().forEach((item) => {
        if (item.path && item.path !== currentPath) prefetchRoute(item.path);
      });
    } catch { /* Prefetch ist rein spekulativ — Fehler nie eskalieren. */ }
  };
  if ('requestIdleCallback' in window) {
    requestIdleCallback(run, { timeout: 2500 });
  } else {
    setTimeout(run, 1200);
  }
}

// --------------------------------------------------------
// Globaler App-State
// --------------------------------------------------------
let currentUser = null;
// Für welchen Nutzer wurde die Nav zuletzt gebaut? Bei Nutzerwechsel (Logout →
// Login als anderes Konto im selben Tab) bleibt die alte Shell im DOM; die Nav
// muss dann mit den Rechten des neuen Nutzers neu gefiltert werden (#467).
let _navBuiltForUserId = null;
let currentPath = null;
let isNavigating = false;
// Zuletzt erfolgreich gerendertes Seiten-Modul. Erlaubt Soft-Navigation
// innerhalb desselben Moduls (z. B. Settings-Blatt → Blatt): Statt das Modul
// komplett neu zu rendern (Teardown + Slide-Transition), tauscht das Modul über
// seine optionale update()-Funktion nur den betroffenen Detailbereich aus.
let _renderedModule = null;
let _renderedModuleName = null;
let _preferencesLoaded = false;
let _disabledModules = new Set();
let _thirdPartyModules = [];
let _moduleOrder = [];
let _mobileNavOrder = [];
let _moduleRefreshTimer = null;
// Gesetzt wenn auth:expired waehrend einer laufenden Navigation feuert.
// Die Weiterleitung zu /login wird nach Abschluss der Navigation nachgeholt.
let _pendingLoginRedirect = false;
// First-Run: true wenn noch kein Account existiert (aus /version beim Boot).
let _setupRequired = false;

// --------------------------------------------------------
// Router
// --------------------------------------------------------

const ROUTE_ORDER = ['/', '/calendar', '/tasks', '/meals', '/recipes', '/shopping',
                     '/birthdays', '/notes', '/contacts', '/budget', '/documents', '/housekeeping', '/health', '/settings'];

const MOBILE_FAVORITE_COUNT = 3;

// Domänen-Gruppierung der Haupt-Navigation. Die Reihenfolge bestimmt die
// Sortierung der Sektionen (Overview → Plan → Home); die Label-Keys werden in
// der Sidebar via t() aufgelöst.
const NAV_SECTION_LABEL_KEYS = Object.freeze({
  [NAV_SECTION.overview]: 'nav.sectionOverview',
  [NAV_SECTION.plan]: 'nav.sectionPlan',
  [NAV_SECTION.home]: 'nav.sectionHome',
  [NAV_SECTION.customModules]: 'nav.sectionCustomModules',
});

const DEFAULT_APP_NAME = 'Yuvomi';
const APP_NAME_STORAGE_KEY = 'yuvomi-app-name';
const APP_VERSION_STORAGE_KEY = 'yuvomi-app-version';

// Reduziert einen (Sub-)Pfad auf seine Top-Level-Sektion. /settings/* Blätter
// teilen sich dadurch eine Sektion: ein Wechsel zwischen zwei Settings-Blättern
// gilt als gleiche Sektion (keine seitliche Seitentransition).
function topLevelSection(path) {
  if (typeof path === 'string' && path.startsWith('/settings')) return '/settings';
  // /health/* Sub-Tabs teilen sich eine Sektion (Soft-Nav zwischen Tabs, keine
  // seitliche Seitentransition) — analog zu den Settings-Blättern.
  if (typeof path === 'string' && path.startsWith('/health')) return '/health';
  return path ?? '/';
}

function getDirection(fromPath, toPath) {
  const fromSection = topLevelSection(fromPath ?? '/');
  const toSection   = topLevelSection(toPath);
  const fromIdx = ROUTE_ORDER.indexOf(fromSection);
  const toIdx   = ROUTE_ORDER.indexOf(toSection);
  if (fromIdx === -1 || toIdx === -1 || fromSection === toSection) return 'right';
  return toIdx > fromIdx ? 'right' : 'left';
}

function getAppName() {
  return localStorage.getItem(APP_NAME_STORAGE_KEY) || DEFAULT_APP_NAME;
}

function getAppVersion() {
  return localStorage.getItem(APP_VERSION_STORAGE_KEY) || '';
}

function setAppName(name) {
  const next = String(name || '').trim();
  if (next) {
    localStorage.setItem(APP_NAME_STORAGE_KEY, next);
  } else {
    localStorage.removeItem(APP_NAME_STORAGE_KEY);
  }
}

function setAppVersion(version) {
  const next = String(version || '').trim();
  if (next) {
    localStorage.setItem(APP_VERSION_STORAGE_KEY, next);
  } else {
    localStorage.removeItem(APP_VERSION_STORAGE_KEY);
  }
}

function routeTitle(path) {
  if (typeof path === 'string' && path.startsWith('/settings')) return t('nav.settings');
  if (typeof path === 'string' && path.startsWith('/health')) return t('nav.health');
  const map = {
    '/': t('dashboard.title'),
    '/tasks': t('nav.tasks'),
    '/calendar': t('nav.calendar'),
    '/birthdays': t('nav.birthdays'),
    '/meals': t('nav.meals'),
    '/recipes': t('nav.recipes'),
    '/shopping': t('nav.shopping'),
    '/notes': t('nav.notes'),
    '/contacts': t('nav.contacts'),
    '/budget': t('nav.budget'),
    '/documents': t('nav.documents'),
    '/housekeeping': t('nav.housekeeping'),
    '/rewards': t('nav.rewards'),
  };
  return map[path] || _thirdPartyModules.find((module) => module.route?.path === path)?.menu?.label || getAppName();
}

function updateBranding(path = currentPath) {
  const appName = getAppName();
  const sidebarLogoName = document.querySelector('.nav-sidebar__brand-name');
  if (sidebarLogoName) sidebarLogoName.textContent = appName;
  const sidebarVersion = document.querySelector('.nav-sidebar__version');
  if (sidebarVersion) {
    const version = getAppVersion();
    sidebarVersion.textContent = version ? t('login.version', { version }) : '';
    sidebarVersion.hidden = !version;
  }

  const loginTitle = document.querySelector('.login-hero__title');
  if ((path === '/login' || path === '/setup') && loginTitle) loginTitle.textContent = appName;

  document.title = (path === '/login' || path === '/setup')
    ? appName
    : `${routeTitle(path || '/')} · ${appName}`;

  document.querySelectorAll('meta[name="apple-mobile-web-app-title"]').forEach((meta) => {
    meta.setAttribute('content', appName);
  });
}

function setOverlayInteractive(el, interactive) {
  if (!el) return;
  el.inert = !interactive;
  el.setAttribute('aria-hidden', String(!interactive));
}

function returnFocus(target) {
  if (target && typeof target.focus === 'function') {
    setTimeout(() => target.focus(), 0);
  }
}

function focusMainContentAfterNavigation(path) {
  if (path === '/login' || path === '/setup') return;
  const main = document.getElementById('main-content');
  if (!main || typeof main.focus !== 'function') return;
  requestAnimationFrame(() => {
    main.focus({ preventScroll: true });
  });
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function visibleFocusable(container) {
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR))
    .filter((el) => !el.hidden && !el.closest('[hidden]') && !el.inert);
}

function createFocusTrap(container) {
  return (e) => {
    if (e.key !== 'Tab') return;
    const focusable = visibleFocusable(container);
    if (!focusable.length) {
      e.preventDefault();
      container.focus?.();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
}

/**
 * Navigiert zu einem Pfad und rendert die entsprechende Seite.
 * @param {string} path
 * @param {Object|boolean} userOrPushState - Direkt ein User-Objekt nach Login,
 *   oder boolean (pushState) für interne Navigation
 * @param {boolean} pushState - false beim initialen Load und popstate
 */
async function navigate(path, userOrPushState = true, pushState = true) {
  if (isNavigating) return;
  isNavigating = true;

  // Offenes „Mehr“-Sheet beim Navigieren immer schließen — robust und
  // unabhängig vom Klick-Bubbling (das reißt, wenn die Navigation
  // zwischendurch rebuildNavigation() auslöst, z. B. beim Settings-Ziel).
  if (window._closeMoreSheet) window._closeMoreSheet({ restoreFocus: false });

  try {
    // Überlastung: navigate(path, user) nach Login vs navigate(path, false) beim Init
    if (typeof userOrPushState === 'object' && userOrPushState !== null) {
      currentUser = userOrPushState;
      _setupRequired = false;
      await syncPreferencesOnce();
      startThirdPartyModulePolling();
      // currentUser kann während des await oben auf null gesetzt worden sein
      // (auth:expired bei 401 von /preferences), daher Guard gegen null.
      if (currentUser && currentUser.access_scope !== 'split_guest') {
        loadReminderStyles();
        initReminders();
        initPush();
      }
    } else {
      pushState = userOrPushState;
    }

    // Alten Pfad merken, bevor currentPath aktualisiert wird - für Richtungsberechnung
    const previousPath = currentPath;
    const basePath = path.split('?')[0];
    currentPath = basePath;

    // First-Run-Weiche: Solange kein Account existiert und niemand eingeloggt ist,
    // alle Routen außer /setup auf /setup umleiten.
    if (_setupRequired && !currentUser && basePath !== '/setup') {
      currentPath = null;
      isNavigating = false;
      navigate('/setup');
      return;
    }
    // Setup bereits erledigt -> /setup ist nicht mehr erreichbar.
    if (!_setupRequired && basePath === '/setup') {
      currentPath = null;
      isNavigating = false;
      navigate('/login');
      return;
    }

    let route = allRoutes().find((r) => r.path === basePath) ?? ROUTES.find((r) => r.path === '/');

    // Split-Guest-Weiche: Gäste einer Ausgabenteilung sehen nur das Budget-Modul.
    // ABER: hat der Nutzer zusätzlich eine Familienrolle OHNE Budget-Recht, würde
    // ein bedingungsloses navigate('/budget') vom Modul-Guard (canAccessNavModule)
    // sofort wieder auf '/' geworfen — und '/' schickt zurück auf '/budget':
    // Endlosschleife bis Stack-Overflow (#480). Daher nur umleiten, wenn Budget
    // tatsächlich zugänglich ist; sonst greift der reguläre Rechte-Guard und der
    // Nutzer landet auf einer für ihn erlaubten Seite.
    if (currentUser?.access_scope === 'split_guest'
        && route.path !== '/budget'
        && canAccessNavModule('budget')) {
      currentPath = null;
      isNavigating = false;
      navigate('/budget');
      return;
    }

    // Modul-Guard: deaktivierte ODER per Rechte gesperrte Module leiten auf das
    // Dashboard um (Rechte-Guard #467; die verbindliche 403-Sperre liegt am Server).
    if (route.module
        && route.path !== '/'
        && (_disabledModules.has(route.module) || !canAccessNavModule(route.module))) {
      currentPath = null;
      isNavigating = false;
      navigate('/');
      return;
    }

    // Auth-Guard
    if (route.requiresAuth && !currentUser) {
      try {
        const result = await auth.me();
        currentUser = result.user;
        await syncPreferencesOnce();
        startThirdPartyModulePolling();
        // currentUser kann während des await oben auf null gesetzt worden sein
        // (auth:expired bei 401 von /preferences), daher Guard gegen null.
        if (currentUser && currentUser.access_scope !== 'split_guest') {
          loadReminderStyles();
          initReminders();
          initPush();
        }
      } catch {
        currentPath = null; // Reset damit navigate('/login') nicht geblockt wird
        isNavigating = false;
        // _pendingLoginRedirect leeren: der catch ruft navigate('/login') direkt auf,
        // der finally soll keinen zweiten Aufruf starten (würde isNavigating=true setzen,
        // während die Login-Seite rendert, und so post-login navigate blockieren).
        _pendingLoginRedirect = false;
        navigate(_setupRequired ? '/setup' : '/login');
        return;
      }
    }

    route = allRoutes().find((r) => r.path === basePath) ?? route;

    // Split-Guest-Weiche: Gäste einer Ausgabenteilung sehen nur das Budget-Modul.
    // ABER: hat der Nutzer zusätzlich eine Familienrolle OHNE Budget-Recht, würde
    // ein bedingungsloses navigate('/budget') vom Modul-Guard (canAccessNavModule)
    // sofort wieder auf '/' geworfen — und '/' schickt zurück auf '/budget':
    // Endlosschleife bis Stack-Overflow (#480). Daher nur umleiten, wenn Budget
    // tatsächlich zugänglich ist; sonst greift der reguläre Rechte-Guard und der
    // Nutzer landet auf einer für ihn erlaubten Seite.
    if (currentUser?.access_scope === 'split_guest'
        && route.path !== '/budget'
        && canAccessNavModule('budget')) {
      currentPath = null;
      isNavigating = false;
      navigate('/budget');
      return;
    }

    // Rechte-Guard nach frisch geladenen Rechten (Deep-Link auf ein für diese
    // Rolle/dieses Mitglied gesperrtes Modul → Dashboard). #467
    if (route.module && route.path !== '/' && !canAccessNavModule(route.module)) {
      currentPath = null;
      isNavigating = false;
      navigate('/');
      return;
    }

    if (!route.requiresAuth && currentUser && path === '/login') {
      currentPath = null;
      isNavigating = false;
      navigate('/');
      return;
    }

    if (pushState) {
      history.pushState({ path }, '', path);
    }

    // Soft-Navigation innerhalb desselben Moduls (z. B. Settings-Blatt → Blatt
    // oder Browser-Zurück innerhalb der Einstellungen): Das bereits gerenderte
    // Modul tauscht nur seinen Detailbereich aus — keine App-Shell-Teardown,
    // keine Slide-Transition, kein erneuter Auth-Refresh. Gibt update() false
    // zurück (z. B. Redirect nötig), fällt die Navigation auf das volle Rendern
    // zurück.
    if (
      route.module
      && route.module === _renderedModuleName
      && typeof _renderedModule?.update === 'function'
    ) {
      let handled = false;
      try {
        handled = await _renderedModule.update({
          user: currentUser,
          path: basePath,
          query: new URLSearchParams(path.split('?')[1] ?? ''),
        });
      } catch (error) {
        console.error('[Router] Soft-Update fehlgeschlagen, vollständiges Rendern folgt:', error);
        handled = false;
      }
      if (handled) {
        updateNav(topLevelSection(basePath));
        return;
      }
    }

    const accent = route?.thirdPartyModule?.accent || (route?.module ? getCSSToken(`--module-${route.module}`) : '');
    document.documentElement.style.setProperty('--active-module-accent', accent);

    // Optimistisches Chrome-Feedback: aktive Nav-Markierung + Indikator-Pille und
    // Statusbar-Farbe schon VOR dem Modul-Render setzen, sobald die Shell existiert.
    // So quittiert der Tap sofort (Pille gleitet, Akzent wechselt), während Modul-
    // CSS und -Daten noch laden — statt erst nach Abschluss des Renders. Beim aller-
    // ersten Laden wird die Shell erst in renderPage gebaut; dann greift allein die
    // autoritative Aktualisierung danach.
    if (document.querySelector('.nav-bottom')) {
      updateNav(topLevelSection(basePath));
      updateThemeColorForRoute(route);
    }

    await renderPage(route, previousPath);
    // Autoritative Aktualisierung nach dem Render: deckt den Erstlade-Fall ab und
    // markiert ggf. seiten-interne [data-route]-Links (idempotent).
    // Settings-Blätter teilen sich den /settings Nav-Eintrag (aria-current).
    updateNav(topLevelSection(basePath));
    updateThemeColorForRoute(route);
    updateBranding(basePath);
    focusMainContentAfterNavigation(basePath);
  } finally {
    isNavigating = false;
    // auth:expired kann waehrend einer Navigation gefeuert haben (z.B. wenn ein
    // paralleler API-Call 401 zurueckgab). Jetzt wo die Navigation abgeschlossen
    // ist, holen wir die Login-Weiterleitung nach.
    if (_pendingLoginRedirect) {
      _pendingLoginRedirect = false;
      navigate('/login');
    }
  }
}

async function syncPreferencesOnce() {
  if (_preferencesLoaded) return;
  _preferencesLoaded = true;
  try {
    const res = await api.get('/preferences');
    const dateFormat = res?.data?.date_format;
    if (dateFormat) {
      localStorage.setItem('yuvomi-date-format', dateFormat);
    }
    const timeFormat = res?.data?.time_format;
    if (timeFormat) {
      localStorage.setItem('yuvomi-time-format', timeFormat);
    }
    if (res?.data?.app_name) {
      setAppName(res.data.app_name);
      updateBranding();
    }
    if (Array.isArray(res?.data?.disabled_modules)) {
      _disabledModules = new Set(res.data.disabled_modules);
    }
    if (Array.isArray(res?.data?.module_order)) {
      _moduleOrder = res.data.module_order;
    }
    if (Array.isArray(res?.data?.mobile_nav_order)) {
      _mobileNavOrder = res.data.mobile_nav_order;
    }
  } catch {
    // Non-critical. The settings page can refresh this later.
  }
  try {
    const res = await api.get('/version');
    if (res?.version) setAppVersion(res.version);
    if (res?.app_name) setAppName(res.app_name);
    updateBranding();
  } catch {
    // Non-critical. The login page and settings page can refresh branding later.
  }
  await syncThirdPartyModules();
}

async function syncThirdPartyModules() {
  try {
    const res = await api.get('/modules');
    _thirdPartyModules = Array.isArray(res?.data) ? res.data : [];
  } catch {
    _thirdPartyModules = [];
  }
}

function moduleSnapshot() {
  return JSON.stringify(_thirdPartyModules.map((module) => ({
    id: module.id,
    enabled: module.enabled,
    status: module.status,
    path: module.route?.path,
    label: module.menu?.label,
  })));
}

function startThirdPartyModulePolling() {
  if (_moduleRefreshTimer || currentUser?.access_scope === 'split_guest') return;
  _moduleRefreshTimer = setInterval(async () => {
    const before = moduleSnapshot();
    await syncThirdPartyModules();
    if (before !== moduleSnapshot()) rebuildNavigation();
  }, 30_000);
}

function stopThirdPartyModulePolling() {
  if (!_moduleRefreshTimer) return;
  clearInterval(_moduleRefreshTimer);
  _moduleRefreshTimer = null;
}

function allRoutes() {
  const moduleRoutes = _thirdPartyModules
    .filter((module) => module.enabled && module.status === 'enabled' && module.route?.path && module.route?.entry)
    .map((module) => ({
      path: module.route.path,
      page: module.route.entry,
      style: module.route.style,
      requiresAuth: true,
      module: `third-party-${module.id}`,
      thirdPartyModule: module,
    }));
  return [...ROUTES, ...moduleRoutes];
}

// Bestätigter Logout, überall aus der Navigation erreichbar (Sidebar-Footer +
// Mehr-Sheet). Teilt den Server-Logout mit den Einstellungen; das finally räumt
// die lokale Session auch bei Netzfehler, damit man nie „eingeloggt festhängt"
// (siehe clearSession/#478). Danger-Confirm schützt vor versehentlichem Klick.
async function confirmAndLogout() {
  // Kein danger/Rot: Abmelden ist reversibel (wieder einloggen), nicht
  // destruktiv — Rot bleibt echten Löschaktionen vorbehalten. Der Confirm-
  // Schritt selbst ist die Absicherung gegen den Fehlklick.
  const confirmed = await confirmModal(t('settings.logoutConfirm'), {
    confirmLabel: t('settings.logout'),
  });
  if (!confirmed) return false;
  try {
    await auth.logout();
  } finally {
    window.yuvomi?.clearSession?.();
    navigate('/login');
  }
  return true;
}

function sidebarActionEl({ labelKey, icon, className, onClick }) {
  const label = t(labelKey);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `nav-item ${className}`;
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
  button.addEventListener('click', onClick);

  const wrap = document.createElement('div');
  wrap.className = 'nav-item__icon-wrap';
  const well = document.createElement('div');
  well.className = 'nav-item__icon-well';
  const iconEl = document.createElement('i');
  iconEl.dataset.lucide = icon;
  iconEl.className = 'nav-item__icon';
  iconEl.setAttribute('aria-hidden', 'true');
  well.appendChild(iconEl);
  wrap.appendChild(well);

  const labelEl = document.createElement('span');
  labelEl.className = 'nav-item__label';
  labelEl.textContent = label;
  button.append(wrap, labelEl);
  return button;
}

// System-/Utility-Zeilen unter dem App-Launcher-Grid: Einstellungen (Route),
// Hilfe und Änderungen (Overlays). Vollbreite Listenzeilen — der ruhige,
// monochrome System-Cluster, klar abgesetzt vom farbigen Modul-Grid.
// `route` → navigierender <a> (aria-current-fähig); sonst Overlay-<button>.
function moreActionEl({ labelKey, icon, className = '', onClick, route, navHref }) {
  const label = t(labelKey);
  const el = document.createElement(route ? 'a' : 'button');
  if (route) {
    el.href = navHref || route;
    el.dataset.route = route;
    if (navHref) el.dataset.navHref = navHref;
  } else {
    el.type = 'button';
  }
  el.className = `more-action ${className}`.trim();
  el.setAttribute('aria-label', label);
  if (onClick) el.addEventListener('click', onClick);

  const iconEl = document.createElement('i');
  iconEl.dataset.lucide = icon;
  iconEl.className = 'more-action__icon';
  iconEl.setAttribute('aria-hidden', 'true');

  const labelEl = document.createElement('span');
  labelEl.className = 'more-action__label';
  labelEl.textContent = label;
  el.append(iconEl, labelEl);
  return el;
}

/**
 * Baut den dynamischen Body des „Mehr“-Sheets: Katalog-Hinweis, farbiges
 * App-Launcher-Grid (Module) und den monochromen System-Cluster
 * (Einstellungen · Hilfe · Änderungen) als 1×3-Reihe.
 *
 * EINE Quelle der Wahrheit für renderAppShell() UND rebuildNavigation() —
 * beide Pfade müssen dieselbe Struktur erzeugen, sonst zerstört ein
 * Sprachwechsel / Modul-Toggle / Settings-Besuch das Layout.
 * Handle + Suchleiste bleiben davon unberührt (sie tragen Event-Wiring).
 */
function buildMoreSheetBody() {
  const nodes = [];

  // Der Katalog-Hinweis („Alle Module … in den Einstellungen") lebt jetzt in
  // der Hilfe (buildHelpRows), nicht mehr als Dauer-Zeile über dem Grid — das
  // hält das Sheet ruhig und kompakt.

  // Einstellungen ist ein System-Ziel, kein Inhalts-Modul — es wandert aus dem
  // farbigen Grid in den System-Cluster, damit das Grid sauber aufgeht (2×4).
  const secondary = secondaryMobileItems();
  const settingsItem = secondary.find((item) => item.module === 'settings');

  const grid = document.createElement('div');
  grid.className = 'more-sheet__grid';
  secondary
    .filter((item) => item.module !== 'settings')
    .forEach((item) => grid.appendChild(moreItemEl(item)));
  nodes.push(grid);

  const divider = document.createElement('div');
  divider.className = 'more-sheet__divider';
  divider.setAttribute('aria-hidden', 'true');
  nodes.push(divider);

  // System-Cluster als kompakte 1×3-Reihe (Icon-über-Label, monochrom).
  const system = document.createElement('div');
  system.className = 'more-sheet__system';
  if (settingsItem) {
    system.appendChild(moreActionEl({
      labelKey: 'nav.settings',
      icon: settingsItem.icon || 'settings',
      route: settingsItem.path,
      navHref: settingsItem.navHref,
    }));
  }
  system.appendChild(moreActionEl({
    labelKey: 'nav.help',
    icon: 'circle-help',
    className: 'more-item--help',
    onClick: () => {
      if (window._closeMoreSheet) window._closeMoreSheet({ restoreFocus: false });
      showHelpModal();
    },
  }));
  system.appendChild(moreActionEl({
    labelKey: 'nav.changelog',
    icon: 'history',
    className: 'more-item--changelog',
    onClick: () => {
      if (window._closeMoreSheet) window._closeMoreSheet({ restoreFocus: false });
      showChangelogModal();
    },
  }));
  system.appendChild(moreActionEl({
    labelKey: 'settings.logout',
    icon: 'log-out',
    className: 'more-item--logout',
    onClick: () => {
      if (window._closeMoreSheet) window._closeMoreSheet({ restoreFocus: false });
      // #more-btn synchron fokussieren, BEVOR das Modal öffnet: openModal
      // erfasst document.activeElement als previouslyFocused. Sonst landet der
      // Fokus nach „Abbrechen" auf <body> (das Sheet-Item ist dann inert).
      document.getElementById('more-btn')?.focus();
      confirmAndLogout();
    },
  }));
  nodes.push(system);

  return nodes;
}

/**
 * Lädt und rendert eine Seite dynamisch.
 * @param {{ path: string, page: string }} route
 * @param {string|null} previousPath - Pfad vor der Navigation (für Richtungsberechnung)
 */
async function renderPage(route, previousPath = null) {
  const app = document.getElementById('app');
  const loading = document.getElementById('app-loading');

  // Loading verstecken
  if (loading) loading.hidden = true;

  try {
    const style = loadPageStyle(route.thirdPartyModule ? null : route.module, route.style);
    const [module] = await Promise.all([
      importPage(route.page),
      style.ready,
    ]);

    if (typeof module.render !== 'function') {
      throw new Error(`Seite ${route.page} exportiert keine render()-Funktion.`);
    }

    // Vollflächige Auth-Seiten (Login, Setup, Passwort-vergessen/-zurücksetzen)
    // rendern ohne App-Shell. Nach einem Logout kann noch eine Shell aus der
    // vorigen Sitzung im DOM stehen — sie muss entfernt werden, sonst bleibt die
    // Navigationsleiste neben dem Login-Formular sichtbar (#478).
    if (!route.requiresAuth) {
      if (document.querySelector('.nav-bottom')) {
        app.replaceChildren();
        _navBuiltForUserId = null;
      }
    }
    // App-Shell einmalig aufbauen BEVOR render() aufgerufen wird -
    // main-content muss im DOM existieren damit document.getElementById()
    // in Seiten-Modulen funktioniert.
    else if (!document.querySelector('.nav-bottom') && currentUser) {
      renderAppShell(app);
      _navBuiltForUserId = currentUser.id;
    } else if (currentUser && _navBuiltForUserId !== currentUser.id) {
      // Shell besteht bereits, aber der Nutzer hat gewechselt → Nav mit den
      // Modul-Rechten des aktuellen Nutzers neu aufbauen (#467).
      rebuildNavigation();
      _navBuiltForUserId = currentUser.id;
    }

    const content = document.getElementById('main-content') || app;

    // Richtung bestimmen (previousPath ist der alte Pfad vor der Navigation)
    const direction = getDirection(previousPath, route.path);
    const inClass   = direction === 'right' ? 'page-transition--in-right' : 'page-transition--in-left';
    const shouldAnimate = Boolean(previousPath);

    // Performance: backdrop-filter während Übergang deaktivieren (Android-Optimierung).
    // glass.css setzt alle backdrop-filter im app-content auf none solange diese Klasse aktiv ist.
    if (shouldAnimate) document.documentElement.classList.add('navigating');

    // Alter Inhalt ist jetzt weg - altes Stylesheet kann entfernt werden
    const pageWrapper = document.createElement('div');
    pageWrapper.className = 'page-transition';
    pageWrapper.style.opacity = '0';
    content.replaceChildren(pageWrapper);
    style.cleanup();

    // Teardown abgeschlossen: ein evtl. gemerktes Soft-Update-Ziel ist jetzt
    // ungültig, bis das neue Modul erfolgreich gerendert hat.
    _renderedModule = null;
    _renderedModuleName = null;

    // render() synchron starten: Der synchrone Teil (Grundgerüst + Lade-Skeleton)
    // ist danach bereits im DOM. Den Wrapper SOFORT einblenden — so wird das
    // Skeleton während des Daten-await des Moduls sichtbar (statt leerer Fläche;
    // der Wrapper war zuvor bis zur vollständigen Auflösung von render() opak-0,
    // wodurch jedes vor dem Daten-await geseedete Skeleton beim Erstladen nie
    // erschien). Der Rest von render() (Daten + Verdrahtung) wird danach abgewartet.
    const renderPromise = module.render(pageWrapper, { user: currentUser });

    // Sichtbar machen und Einblend-Animation starten (Skeleton/Grundgerüst).
    pageWrapper.style.opacity = shouldAnimate ? '' : '1';
    if (shouldAnimate) {
      pageWrapper.classList.add(inClass);

      // navigating-Klasse nach Ende der Einblend-Animation entfernen.
      // Fallback-Timeout falls animationend nicht feuert (z.B. prefers-reduced-motion).
      const navEndTimeout = setTimeout(() => {
        document.documentElement.classList.remove('navigating');
      }, 300);
      pageWrapper.addEventListener('animationend', () => {
        clearTimeout(navEndTimeout);
        document.documentElement.classList.remove('navigating');
      }, { once: true });
    } else {
      document.documentElement.classList.remove('navigating');
    }

    await renderPromise;

    // Ab hier kann das Modul Soft-Navigationen bedienen (sofern es update() bietet).
    _renderedModule = module;
    _renderedModuleName = route.module;

    // FAB Long Loop: Einstiegsanimation nach FAB_SEEN_MAX Views pro Modul deaktivieren
    if (pageWrapper.querySelector('.page-fab')) {
      const fabKey = FAB_SEEN_KEY(route.module);
      let fabCount = parseInt(localStorage.getItem(fabKey) ?? '0', 10);
      if (fabCount < FAB_SEEN_MAX) {
        fabCount++;
        localStorage.setItem(fabKey, String(fabCount));
      }
      document.documentElement.classList.toggle('fab-anim-done', fabCount >= FAB_SEEN_MAX);
    }

    // Read-only-Modus (#467): Bei „Nur lesen"-Modulen die Anlege-Affordance (FAB)
    // ausblenden und einen erklärenden Hinweis einblenden — sonst führt jeder
    // Anlege-/Speicherversuch nur in einen 403. Die verbindliche Sperre bleibt
    // serverseitig; dies ist die ehrliche UI-Entsprechung.
    applyModuleReadonly(route.module, pageWrapper);

    // Route-Announcer: Screenreader über Seitenwechsel informieren (gezielt, nicht gesamter Inhalt)
    const announcer = document.getElementById('route-announcer');
    if (announcer) {
      const pageLabel = navItems().find((n) => n.path === route.path)?.label ?? route.path;
      announcer.textContent = '';
      setTimeout(() => { announcer.textContent = pageLabel; }, 50);
    }

  } catch (err) {
    document.documentElement.classList.remove('navigating');
    console.error('[Router] Seiten-Render-Fehler:', err);
    if (route.thirdPartyModule?.id) {
      await disableFailedThirdPartyModule(route.thirdPartyModule.id);
    }
    renderError(app, err);
  }
}

/**
 * App-Shell mit Navigation einmalig aufbauen (nach erstem Login).
 */
function renderAppShell(container) {
  const isGuest = currentUser?.access_scope === 'split_guest';
  const skipLink = document.createElement('a');
  skipLink.href = '#main-content';
  skipLink.className = 'sr-only';
  skipLink.textContent = t('common.skipToContent');

  const sidebar = document.createElement('nav');
  sidebar.className = 'nav-sidebar';
  sidebar.setAttribute('aria-label', t('nav.main'));
  const sidebarLogo = document.createElement('div');
  sidebarLogo.className = 'nav-sidebar__logo';

  // SVG-Logomark aus docs/logo.svg — Gradient via CSS-Tokens
  const logomark = document.createElement('div');
  logomark.className = 'nav-sidebar__logomark';
  logomark.setAttribute('aria-hidden', 'true');
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const logoSvg = document.createElementNS(SVG_NS, 'svg');
  logoSvg.setAttribute('viewBox', '0 0 160 160');
  logoSvg.setAttribute('fill', 'none');
  const defs = document.createElementNS(SVG_NS, 'defs');
  const grad = document.createElementNS(SVG_NS, 'linearGradient');
  const gradId = `yuvomi-logo-bg-${Math.random().toString(36).slice(2, 7)}`;
  grad.setAttribute('id', gradId);
  grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '160'); grad.setAttribute('y2', '160');
  grad.setAttribute('gradientUnits', 'userSpaceOnUse');
  const stop0 = document.createElementNS(SVG_NS, 'stop');
  stop0.setAttribute('offset', '0%');
  stop0.style.stopColor = 'var(--color-accent)';
  const stop1 = document.createElementNS(SVG_NS, 'stop');
  stop1.setAttribute('offset', '100%');
  stop1.style.stopColor = 'var(--color-accent-secondary)';
  grad.appendChild(stop0); grad.appendChild(stop1);
  defs.appendChild(grad);
  logoSvg.appendChild(defs);
  const bgRect = document.createElementNS(SVG_NS, 'rect');
  bgRect.setAttribute('width', '160'); bgRect.setAttribute('height', '160');
  bgRect.setAttribute('rx', '36'); bgRect.setAttribute('fill', `url(#${gradId})`);
  logoSvg.appendChild(bgRect);
  // Drei transluzente, ineinander übergehende Kreise (Familie); kein Sheen in der Sidebar
  const marks = document.createElementNS(SVG_NS, 'g');
  marks.setAttribute('fill', 'white');
  marks.setAttribute('fill-opacity', '0.82');
  for (const [cx, cy, r] of [[64, 72, 27], [100, 78, 25], [80, 106, 24]]) {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', String(cx)); c.setAttribute('cy', String(cy)); c.setAttribute('r', String(r));
    marks.appendChild(c);
  }
  logoSvg.appendChild(marks);
  logomark.appendChild(logoSvg);
  sidebarLogo.appendChild(logomark);

  const sidebarBrandText = document.createElement('div');
  sidebarBrandText.className = 'nav-sidebar__brand-text';
  const sidebarLogoSpan = document.createElement('span');
  sidebarLogoSpan.className = 'nav-sidebar__brand-name';
  sidebarLogoSpan.textContent = getAppName();
  const sidebarVersion = document.createElement('small');
  sidebarVersion.className = 'nav-sidebar__version';
  const cachedVersion = getAppVersion();
  sidebarVersion.textContent = cachedVersion ? t('login.version', { version: cachedVersion }) : '';
  sidebarVersion.hidden = !cachedVersion;
  sidebarBrandText.append(sidebarLogoSpan, sidebarVersion);
  sidebarLogo.appendChild(sidebarBrandText);

  const sidebarToggle = document.createElement('button');
  sidebarToggle.type = 'button';
  sidebarToggle.className = 'nav-sidebar__toggle';
  const _sidebarInitCollapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  sidebarToggle.setAttribute('aria-label', _sidebarInitCollapsed ? t('nav.sidebarExpand') : t('nav.sidebarCollapse'));
  sidebarToggle.setAttribute('title', _sidebarInitCollapsed ? t('nav.sidebarExpand') : t('nav.sidebarCollapse'));
  const _toggleIcon = document.createElement('i');
  _toggleIcon.dataset.lucide = _sidebarInitCollapsed ? 'panel-left-open' : 'panel-left-close';
  _toggleIcon.setAttribute('aria-hidden', 'true');
  sidebarToggle.appendChild(_toggleIcon);
  sidebarToggle.addEventListener('click', (event) => {
    const nowCollapsed = !document.documentElement.classList.contains('sidebar-collapsed');
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, nowCollapsed ? '1' : '0');
    applySidebarCollapsed(nowCollapsed);
    if (event.detail > 0) {
      document.documentElement.classList.toggle('sidebar-collapse-pointer-lock', nowCollapsed);
    }
    // Pointer clicks leave the toggle focused, which immediately re-expands the
    // collapsed rail via .nav-sidebar:focus-within. Blur only for pointer-driven
    // activation so keyboard users keep the expected focus behavior.
    if (nowCollapsed && event.detail > 0) {
      requestAnimationFrame(() => sidebarToggle.blur());
    }
    const lbl = nowCollapsed ? t('nav.sidebarExpand') : t('nav.sidebarCollapse');
    sidebarToggle.setAttribute('aria-label', lbl);
    sidebarToggle.setAttribute('title', lbl);
    replaceLucideIcon(sidebarToggle, 'i[data-lucide]', nowCollapsed ? 'panel-left-open' : 'panel-left-close');
  });

  const sidebarItems = document.createElement('div');
  sidebarItems.className = 'nav-sidebar__items nav-sidebar__items--liquid';
  sidebarItems.setAttribute('role', 'list');
  sidebarNavItems().forEach((item) => sidebarItems.appendChild(item));

  // Indikator-Pille zeigt Vorschau, wohin sie gleiten würde — für Maus (hover)
  // UND Tastatur (focus). Ohne Fokus-Parität wäre der Signature-Moment
  // maus-exklusiv und Keyboard-Nutzer sähen nur den Outline.
  const previewIndicator = (item) => {
    const ind = sidebarItems.querySelector('.nav-sidebar__indicator');
    if (!ind) return;
    const cr = sidebarItems.getBoundingClientRect();
    const ir = item.getBoundingClientRect();
    // Pille (44px) vertikal im Item (48px) zentrieren — aus realen Höhen, token-unabhängig
    const centerOffset = (ir.height - ind.getBoundingClientRect().height) / 2;
    ind.style.transform = `translateY(${ir.top - cr.top + sidebarItems.scrollTop + centerOffset}px)`;
    ind.style.opacity = '0.5';
  };
  sidebarItems.addEventListener('mouseover', (ev) => {
    const item = ev.target.closest('.nav-item');
    if (item) previewIndicator(item);
  });
  sidebarItems.addEventListener('mouseleave', () => positionSidebarIndicator());
  // Tastatur-Fokus treibt dieselbe Gleit-Vorschau; verlässt der Fokus die Liste
  // ganz, kehrt die Pille zum aktiven Item zurück.
  sidebarItems.addEventListener('focusin', (ev) => {
    const item = ev.target.closest('.nav-item');
    if (item) previewIndicator(item);
  });
  sidebarItems.addEventListener('focusout', (ev) => {
    if (!sidebarItems.contains(ev.relatedTarget)) positionSidebarIndicator();
  });

  const syncSidebarIndicator = () => {
    requestAnimationFrame(() => positionSidebarIndicator());
  };
  // In collapsed mode the section headers are hidden. Expanding the rail on
  // hover/focus puts them back into layout, which shifts the nav items down.
  // Re-sync the active pill after those layout changes.
  sidebar.addEventListener('mouseenter', syncSidebarIndicator);
  sidebar.addEventListener('mouseleave', syncSidebarIndicator);
  sidebar.addEventListener('focusin', syncSidebarIndicator);
  sidebar.addEventListener('focusout', syncSidebarIndicator);
  sidebar.addEventListener('mouseleave', () => {
    document.documentElement.classList.remove('sidebar-collapse-pointer-lock');
  });

  sidebar.appendChild(sidebarLogo);
  sidebar.appendChild(sidebarToggle);
  sidebar.appendChild(sidebarItems);

  // Footer-Aktionen (keine Routen → kein data-route, damit Delegation/Indikator
  // sie ignorieren): Hilfe und Live-Changelog.
  const sidebarFooter = document.createElement('div');
  sidebarFooter.className = 'nav-sidebar__footer-actions';
  sidebarFooter.append(
    sidebarActionEl({
      labelKey: 'nav.help',
      icon: 'circle-help',
      className: 'nav-item--help',
      onClick: () => showHelpModal(),
    }),
    sidebarActionEl({
      labelKey: 'nav.changelog',
      icon: 'history',
      className: 'nav-item--changelog',
      onClick: () => showChangelogModal(),
    }),
    // Abmelden als terminale Aktion: bricht in eine eigene, volle Zeile unter
    // Hilfe/Änderungen (CSS: flex-wrap + border-top). Monochrom wie die
    // Geschwister — Danger-Rot erscheint erst im Confirm.
    sidebarActionEl({
      labelKey: 'settings.logout',
      icon: 'log-out',
      className: 'nav-item--logout',
      onClick: () => confirmAndLogout(),
    }),
  );
  sidebar.appendChild(sidebarFooter);

  if (window.lucide) window.lucide.createIcons({ el: sidebar });

  const main = document.createElement('main');
  main.className = 'app-content';
  main.id = 'main-content';
  main.tabIndex = -1;

  const bottomNav = document.createElement('nav');
  bottomNav.className = 'nav-bottom';
  bottomNav.setAttribute('aria-label', t('nav.navigation'));
  const bottomItems = document.createElement('div');
  bottomItems.className = 'nav-bottom__items';
  if (isGuest) {
    navItems().forEach((item) => bottomItems.appendChild(navItemEl(item)));
  }

  let backdrop, moreSheet;

  if (!isGuest) {
    bottomItems.replaceChildren(...buildBottomNavItems());

    backdrop = document.createElement('div');
    backdrop.className = 'more-backdrop';
    backdrop.id = 'more-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');

    moreSheet = document.createElement('div');
    moreSheet.className = 'more-sheet';
    moreSheet.id = 'more-sheet';
    moreSheet.setAttribute('role', 'dialog');
    moreSheet.setAttribute('aria-modal', 'true');
    moreSheet.setAttribute('aria-label', t('nav.more'));
    setOverlayInteractive(moreSheet, false);
    const dragHandle = document.createElement('div');
    dragHandle.className = 'more-sheet__handle';
    dragHandle.setAttribute('aria-hidden', 'true');
    moreSheet.insertAdjacentElement('afterbegin', dragHandle);

    const moreSearchBar = document.createElement('button');
    moreSearchBar.type = 'button';
    moreSearchBar.className = 'more-sheet__search';
    moreSearchBar.id = 'more-sheet-search';
    moreSearchBar.setAttribute('aria-label', t('search.placeholder'));
    const moreSearchIcon = document.createElement('i');
    moreSearchIcon.dataset.lucide = 'search';
    moreSearchIcon.className = 'more-sheet__search-icon';
    moreSearchIcon.setAttribute('aria-hidden', 'true');
    const moreSearchPlaceholder = document.createElement('span');
    moreSearchPlaceholder.className = 'more-sheet__search-placeholder';
    moreSearchPlaceholder.textContent = t('search.placeholder');
    moreSearchBar.appendChild(moreSearchIcon);
    moreSearchBar.appendChild(moreSearchPlaceholder);
    moreSheet.appendChild(moreSearchBar);

    // Hinweis + App-Launcher-Grid + System-Cluster. Geteilte Logik mit
    // rebuildNavigation() (Sprachwechsel / Modul-Toggle) — sonst driften die
    // zwei Render-Pfade auseinander.
    moreSheet.append(...buildMoreSheetBody());
  }

  bottomNav.appendChild(bottomItems);

  // Gleitender Tab-Indikator — Geschwister von bottomItems, überlebt replaceChildren auf items
  if (!isGuest) {
    const tabIndicator = document.createElement('div');
    tabIndicator.className = 'nav-bottom__indicator';
    tabIndicator.setAttribute('aria-hidden', 'true');
    bottomNav.appendChild(tabIndicator);
  }

  const searchOverlay = document.createElement('div');
  searchOverlay.className = 'search-overlay';
  searchOverlay.id = 'search-overlay';
  searchOverlay.setAttribute('role', 'dialog');
  searchOverlay.setAttribute('aria-modal', 'true');
  searchOverlay.setAttribute('aria-label', t('search.title'));
  setOverlayInteractive(searchOverlay, false);
  const searchHeader = document.createElement('div');
  searchHeader.className = 'search-overlay__header';
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'search-overlay__input';
  searchInput.id = 'search-input';
  searchInput.placeholder = t('search.placeholder');
  searchInput.setAttribute('aria-label', t('search.title'));
  const searchClose = document.createElement('button');
  searchClose.className = 'search-overlay__close';
  searchClose.id = 'search-close';
  searchClose.type = 'button';
  searchClose.setAttribute('aria-label', t('common.close'));
  const closeIcon = document.createElement('i');
  closeIcon.dataset.lucide = 'x';
  closeIcon.className = 'search-overlay__close-icon';
  closeIcon.setAttribute('aria-hidden', 'true');
  searchClose.appendChild(closeIcon);
  searchHeader.appendChild(searchInput);
  searchHeader.appendChild(searchClose);
  const searchResults = document.createElement('div');
  searchResults.className = 'search-overlay__results';
  searchResults.id = 'search-results';
  searchOverlay.appendChild(searchHeader);
  searchOverlay.appendChild(searchResults);

  const toastContainerPolite = document.createElement('div');
  toastContainerPolite.className = 'toast-container';
  toastContainerPolite.id = 'toast-container-polite';
  toastContainerPolite.setAttribute('aria-live', 'polite');

  const toastContainerAssertive = document.createElement('div');
  toastContainerAssertive.className = 'toast-container';
  toastContainerAssertive.id = 'toast-container-assertive';
  toastContainerAssertive.setAttribute('aria-live', 'assertive');

  const routeAnnouncer = document.createElement('div');
  routeAnnouncer.id = 'route-announcer';
  routeAnnouncer.className = 'sr-only';
  routeAnnouncer.setAttribute('aria-live', 'polite');
  routeAnnouncer.setAttribute('aria-atomic', 'true');

  // Lebender Backdrop — driftende, getönte Blobs (Liquid Glass).
  // Erstes Shell-Kind: liegt via z-index: -1 (glass.css Section 40) hinter
  // dem transluzenten Content, aber über dem app-shell-Basis-Gradient.
  // Blob 1 folgt --active-module-accent → rekoloriert pro Sektion.
  const lgBackdrop = document.createElement('div');
  lgBackdrop.className = 'lg-backdrop';
  lgBackdrop.setAttribute('aria-hidden', 'true');
  for (let i = 1; i <= 4; i++) {
    const blob = document.createElement('div');
    blob.className = `lg-blob lg-blob--${i}`;
    lgBackdrop.appendChild(blob);
  }

  const shellNodes = [skipLink, lgBackdrop, sidebar, main, bottomNav];
  if (backdrop)   shellNodes.push(backdrop);
  if (moreSheet)  shellNodes.push(moreSheet);
  shellNodes.push(searchOverlay, toastContainerPolite, toastContainerAssertive, routeAnnouncer);
  container.replaceChildren(...shellNodes);
  applySidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1');
  updateBranding(currentPath || '/');

  // Klick-Handler für alle Nav-Links
  container.querySelectorAll('[data-route]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(el.dataset.navHref ?? el.dataset.route);
    });
  });

  // Prefetch auf Absicht: Hover (Desktop) und Pointer-Press (feuert vor dem
  // Klick, deckt Touch ab) wärmen Modul + CSS des Ziels vor. Delegation über
  // bubblende Events (mouseover/pointerdown) — pointerenter würde nicht bubbeln.
  const prefetchFromEvent = (e) => {
    const el = e.target.closest?.('[data-route]');
    if (el) prefetchRoute(el.dataset.navHref?.split('?')[0] ?? el.dataset.route);
  };
  container.addEventListener('mouseover', prefetchFromEvent);
  container.addEventListener('pointerdown', prefetchFromEvent);

  const openSearch = initSearch(container);
  initMoreSheet(container, openSearch);
  initOfflineBanner();
  initKeyboardShortcuts();

  // Hauptnavigation im Leerlauf vorwärmen — die erste Modulnavigation soll
  // ohne Kaltstart-Wasserfall auskommen.
  warmPrimaryRoutes();
}

const FAB_SEEN_KEY = (module) => `yuvomi:fabSeen:${module}`;
const FAB_SEEN_MAX = 5;
const SIDEBAR_COLLAPSED_KEY = 'yuvomi.sidebar.collapsed';

const SHORTCUTS = [
  { key: '/',   description: () => t('shortcuts.search'),  action: () => {
    document.getElementById('more-sheet-search')?.click();
  } },
  { key: 'n',   description: () => t('shortcuts.new'),     action: () => document.querySelector('.page-fab')?.click() },
  { key: 'f',   description: () => t('shortcuts.searchCalendar'), action: () => {
    if (location.pathname === '/calendar') document.querySelector('#cal-search')?.click();
  } },
  { key: '?',   description: () => t('shortcuts.help'),    action: () => showHelpModal() },
  { key: 'g d', description: () => t('shortcuts.goDash'),  action: () => navigate('/') },
  { key: 'g t', description: () => t('shortcuts.goTasks'), action: () => navigate('/tasks') },
  { key: 'g c', description: () => t('shortcuts.goCal'),   action: () => navigate('/calendar') },
  { key: 'g s', description: () => t('shortcuts.goShop'),  action: () => navigate('/shopping') },
  { key: 'g n', description: () => t('shortcuts.goNotes'),   action: () => navigate('/notes')              },
  { key: 'g h', description: () => t('shortcuts.goHealth'),  action: () => navigate(getLastHealthRoute())  },
  { key: 'g k',   description: () => t('shortcuts.goKitchen'), action: () => navigate(getLastKitchenRoute()) },
  { key: 'g k m', description: () => t('shortcuts.goKitchen'), action: () => navigate('/meals')             },
  { key: 'g k r', description: () => t('shortcuts.goKitchen'), action: () => navigate('/recipes')           },
  { key: 'g k s', description: () => t('shortcuts.goKitchen'), action: () => navigate('/shopping')          },
];

let _pendingKey = null;
let _pendingTimer = null;

function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (document.activeElement?.isContentEditable) return;
    if (document.querySelector('.modal-overlay') && e.key !== 'Escape') return;
    // Modifikatoren durchlassen: Cmd/Ctrl/Alt-Kombis (z. B. Cmd+F „Im Browser
    // suchen", Cmd+N) gehören dem Browser/OS, nicht den Bare-Key-Shortcuts.
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const key = e.key.toLowerCase();

    // 3-Tasten-Chord: g k {m|r|s}
    if (_pendingKey === 'g k') {
      clearTimeout(_pendingTimer);
      _pendingKey = null;
      const chord3 = `g k ${key}`;
      const s3 = SHORTCUTS.find((s) => s.key === chord3);
      if (s3) { e.preventDefault(); s3.action(); return; }
      // Kein 3-Chord-Match → g k selbst ausführen
      const gk = SHORTCUTS.find((s) => s.key === 'g k');
      if (gk) { e.preventDefault(); gk.action(); }
      return;
    }

    // 2-Tasten-Chord: g {d|t|c|s|n|k}
    if (_pendingKey === 'g' && key !== 'g') {
      clearTimeout(_pendingTimer);
      if (key === 'k') {
        // k ist Präfix für 3-Chord — auf dritten Tastendruck warten
        _pendingKey = 'g k';
        _pendingTimer = setTimeout(() => {
          _pendingKey = null;
          const gk = SHORTCUTS.find((s) => s.key === 'g k');
          if (gk) gk.action();
        }, 1000);
        return;
      }
      _pendingKey = null;
      const combo = `g ${key}`;
      const shortcut = SHORTCUTS.find((s) => s.key === combo);
      if (shortcut) { e.preventDefault(); shortcut.action(); }
      return;
    }

    if (key === 'g') {
      _pendingKey = 'g';
      _pendingTimer = setTimeout(() => { _pendingKey = null; }, 1000);
      return;
    }

    const shortcut = SHORTCUTS.find((s) => s.key === key && !s.key.includes(' '));
    if (shortcut) { e.preventDefault(); shortcut.action(); }
  });
}

function showHelpModal() {
  // Mirrors the CSS sidebar↔bottom-nav breakpoint (sidebar is min-width:1024px):
  // without a keyboard, shortcut rows are useless — show a plain-language guide.
  const coarsePointer = window.matchMedia('(max-width: 1023px)').matches;
  const helpRows = buildHelpRows({ coarsePointer, shortcuts: SHORTCUTS, t });

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  const panel = document.createElement('div');
  panel.className = 'modal-panel modal-panel--sm';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('help.title'));

  const rows = helpRows.map((r) => r.key
    ? `<div class="help-row">
         <kbd class="shortcut-kbd">${esc(r.key)}</kbd>
         <span class="shortcut-desc">${esc(r.desc)}</span>
       </div>`
    : `<div class="help-row">
         <i data-lucide="${esc(r.icon)}" class="help-row__icon icon-md" aria-hidden="true"></i>
         <span class="shortcut-desc">${esc(r.desc)}</span>
       </div>`
  ).join('');

  panel.insertAdjacentHTML('beforeend', `
    <div class="modal-panel__header">
      <span class="modal-panel__title">${esc(t('help.title'))}</span>
      <button class="modal-panel__close btn--ghost" aria-label="${esc(t('common.close'))}">
        <i data-lucide="x" class="icon-md" aria-hidden="true"></i>
      </button>
    </div>
    <div class="modal-panel__body">
      <div class="shortcuts-list">${rows}</div>
    </div>
  `);

  panel.querySelector('.modal-panel__close').addEventListener('click', () => overlay.remove());
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onEsc); }
  });

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  if (window.lucide) window.lucide.createIcons({ el: panel });
}

function versionText(value) {
  return String(value || '').trim() || t('changelog.unknownVersion');
}

function versionKey(value) {
  return String(value || '').trim().replace(/^v/i, '').toLowerCase();
}

function renderChangelogStatus(panel, message, tone = 'muted') {
  const status = panel.querySelector('#changelog-status');
  if (!status) return;
  status.hidden = false;
  status.className = `changelog-status changelog-status--${tone}`;
  status.textContent = message;
}

function appendReleaseSection(parent, section) {
  const block = document.createElement('section');
  block.className = 'changelog-section';

  const title = document.createElement('h4');
  title.className = 'changelog-section__title';
  title.textContent = section.title || t('changelog.changes');
  block.appendChild(title);

  const list = document.createElement('ul');
  list.className = 'changelog-section__list';
  for (const item of Array.isArray(section.items) ? section.items : []) {
    const li = document.createElement('li');
    li.textContent = String(item || '');
    list.appendChild(li);
  }
  block.appendChild(list);
  parent.appendChild(block);
}

function appendReleaseCard(parent, release, currentVersion) {
  const isCurrent = Boolean(versionKey(release.version))
    && versionKey(release.version) === versionKey(currentVersion);
  const card = document.createElement('article');
  card.className = `changelog-release${isCurrent ? ' changelog-release--current' : ''}`;

  const header = document.createElement('div');
  header.className = 'changelog-release__header';
  const title = document.createElement('h3');
  title.className = 'changelog-release__version';
  title.textContent = versionText(release.version);
  header.appendChild(title);

  if (isCurrent) {
    const badge = document.createElement('span');
    badge.className = 'changelog-release__badge';
    badge.textContent = t('changelog.currentBadge');
    header.appendChild(badge);
  }
  card.appendChild(header);

  const sections = Array.isArray(release.sections) ? release.sections : [];
  if (sections.length) {
    for (const section of sections) appendReleaseSection(card, section);
  } else {
    const empty = document.createElement('p');
    empty.className = 'changelog-release__empty';
    empty.textContent = t('changelog.noReleaseNotes');
    card.appendChild(empty);
  }
  parent.appendChild(card);
}

function renderChangelog(panel, payload) {
  const data = payload?.data ?? {};
  const currentVersion = data.current_version;
  const latestVersion = data.latest_version;
  const releases = Array.isArray(data.releases) ? data.releases : [];

  panel.querySelector('#changelog-current-version').textContent = versionText(currentVersion);
  panel.querySelector('#changelog-latest-version').textContent = versionText(latestVersion);

  const note = panel.querySelector('#changelog-version-note');
  note.textContent = data.current_in_releases
    ? t('changelog.currentFound')
    : t('changelog.currentMissing');
  note.classList.toggle('changelog-version-note--warning', !data.current_in_releases);

  const status = panel.querySelector('#changelog-status');
  if (status) status.hidden = true;

  const list = panel.querySelector('#changelog-list');
  list.replaceChildren();
  if (!releases.length) {
    renderChangelogStatus(panel, t('changelog.empty'), 'muted');
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const release of releases) appendReleaseCard(fragment, release, currentVersion);
  list.appendChild(fragment);
}

function showChangelogModal() {
  openModal({
    title: t('changelog.title'),
    size: 'xl',
    content: `
      <div class="changelog-modal">
        <div class="changelog-summary" aria-live="polite">
          <div class="changelog-summary__item">
            <span>${esc(t('changelog.currentVersion'))}</span>
            <strong id="changelog-current-version">${esc(t('changelog.loadingShort'))}</strong>
          </div>
          <div class="changelog-summary__item">
            <span>${esc(t('changelog.latestVersion'))}</span>
            <strong id="changelog-latest-version">${esc(t('changelog.loadingShort'))}</strong>
          </div>
        </div>
        <p class="changelog-version-note" id="changelog-version-note"></p>
        <div class="changelog-status changelog-status--muted" id="changelog-status" role="status">
          ${esc(t('changelog.loading'))}
        </div>
        <div class="changelog-list" id="changelog-list"></div>
      </div>
    `,
    onSave(panel) {
      api.get('/changelog')
        .then((payload) => renderChangelog(panel, payload))
        .catch(() => {
          panel.querySelector('#changelog-list')?.replaceChildren();
          renderChangelogStatus(panel, t('changelog.loadError'), 'error');
        });
    },
  });
}

function loadReminderStyles() {
  if (document.querySelector('link[href="/styles/reminders.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/styles/reminders.css';
  document.head.appendChild(link);
}

function initOfflineBanner() {
  const banner = document.getElementById('offline-banner');
  if (!banner) return;
  const i18nSpan = banner.querySelector('[data-i18n]');
  function update() {
    banner.hidden = navigator.onLine;
    if (i18nSpan) i18nSpan.textContent = t('offline.banner');
    document.documentElement.style.setProperty(
      '--offline-banner-height', navigator.onLine ? '0px' : `${banner.offsetHeight || 40}px`
    );
  }
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

/**
 * Öffnet/schließt das More-Sheet und die Backdrop.
 */
function initMoreSheet(container, openSearch) {
  const moreBtn  = container.querySelector('#more-btn');
  const backdrop = container.querySelector('#more-backdrop');
  const sheet    = container.querySelector('#more-sheet');
  if (!moreBtn || !backdrop || !sheet) return;
  let lastFocusedBeforeSheet = null;
  const moreSheetTrap = createFocusTrap(sheet);
  const currentMoreBtn = () => container.querySelector('#more-btn') || moreBtn;

  function openSheet() {
    lastFocusedBeforeSheet = document.activeElement;
    setOverlayInteractive(sheet, true);
    sheet.addEventListener('keydown', moreSheetTrap);
    backdrop.classList.add('more-backdrop--visible');
    currentMoreBtn().setAttribute('aria-expanded', 'true');
    sheet.querySelector('#more-sheet-search, [data-route]')?.focus();
    if (window.lucide) window.lucide.createIcons({ el: sheet });
  }

  function closeSheet({ restoreFocus = true } = {}) {
    if (sheet.getAttribute('aria-hidden') === 'true') return;
    setOverlayInteractive(sheet, false);
    sheet.removeEventListener('keydown', moreSheetTrap);
    backdrop.classList.remove('more-backdrop--visible');
    currentMoreBtn().setAttribute('aria-expanded', 'false');
    if (restoreFocus) returnFocus(lastFocusedBeforeSheet || currentMoreBtn());
  }

  container.addEventListener('click', (e) => {
    if (!e.target.closest('#more-btn')) return;
    e.preventDefault();
    const isOpen = sheet.getAttribute('aria-hidden') === 'false';
    isOpen ? closeSheet() : openSheet();
  });

  backdrop.addEventListener('click', () => closeSheet());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheet.getAttribute('aria-hidden') === 'false') {
      closeSheet();
    }
  });

  let _touchStartY = 0;
  sheet.addEventListener('touchstart', (e) => {
    _touchStartY = e.touches[0].clientY;
  }, { passive: true });
  sheet.addEventListener('touchend', (e) => {
    if (e.changedTouches[0].clientY - _touchStartY > 60) closeSheet();
  }, { passive: true });

  sheet.addEventListener('click', (e) => {
    if (e.target.closest('[data-route]')) closeSheet({ restoreFocus: false });
  });

  const moreSearchBar = sheet.querySelector('#more-sheet-search');
  if (moreSearchBar && openSearch) {
    const triggerSearch = () => {
      // Sheet sofort (ohne Slide-Animation) schließen, damit nur eine Animation abläuft
      sheet.style.transition = 'none';
      closeSheet({ restoreFocus: false });
      requestAnimationFrame(() => {
        openSearch();
        sheet.style.transition = '';
      });
    };
    moreSearchBar.addEventListener('click', triggerSearch);
  }

  window._closeMoreSheet = closeSheet;
}

/**
 * Initialisiert die Suchfunktion (Overlay + API-Calls).
 */
function initSearch(container) {
  const searchClose = container.querySelector('#search-close');
  const overlay      = container.querySelector('#search-overlay');
  const input        = container.querySelector('#search-input');
  const results      = container.querySelector('#search-results');
  if (!overlay || !input || !results) return null;

  // Leichtgewichtiger Focus Trap für das Search Overlay.
  // Eigenständig (kein modal.js), da modul-globale Variablen in modal.js
  // bei gleichzeitig offenem Modal überschrieben würden.
  let _searchTrapHandler = null;
  let lastFocusedBeforeSearch = null;

  function openSearch() {
    if (window._closeMoreSheet) window._closeMoreSheet({ restoreFocus: false });
    lastFocusedBeforeSearch = document.activeElement;
    setOverlayInteractive(overlay, true);
    overlay.classList.add('search-overlay--visible');
    setTimeout(() => input.focus(), 50);
    if (window.lucide) window.lucide.createIcons({ el: overlay });

    _searchTrapHandler = createFocusTrap(overlay);
    overlay.addEventListener('keydown', _searchTrapHandler);
  }

  function closeSearch({ restoreFocus = true } = {}) {
    setOverlayInteractive(overlay, false);
    overlay.classList.remove('search-overlay--visible');
    if (_searchTrapHandler) {
      overlay.removeEventListener('keydown', _searchTrapHandler);
      _searchTrapHandler = null;
    }
    input.value = '';
    results.replaceChildren();
    if (restoreFocus) returnFocus(lastFocusedBeforeSearch);
  }

  if (searchClose) searchClose.addEventListener('click', closeSearch);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('search-overlay--visible')) {
      closeSearch();
    }
  });

  let searchTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (q.length < 2) {
      results.replaceChildren();
      return;
    }
    searchTimer = setTimeout(async () => {
      try {
        const data = await api.get(`/search?q=${encodeURIComponent(q)}`);
        renderSearchResults(results, data, closeSearch);
      } catch {
        // Fehler nicht verschlucken: sichtbare Meldung statt „wirkt wie 0 Treffer".
        results.replaceChildren();
        const err = document.createElement('p');
        err.className = 'search-overlay__empty';
        err.setAttribute('role', 'status');
        err.textContent = t('search.error');
        results.appendChild(err);
      }
    }, 300);
  });

  return openSearch;
}

/**
 * Rendert Suchergebnisse in den Ergebnis-Container.
 */
function renderSearchResults(container, data, onClose) {
  container.replaceChildren();
  const { tasks = [], events = [], notes = [], contacts = [], items = [], meds = [], activities = [] } = data;
  const total = tasks.length + events.length + notes.length + contacts.length + items.length
    + meds.length + activities.length;

  if (total === 0) {
    const empty = document.createElement('p');
    empty.className = 'search-overlay__empty';
    empty.textContent = t('search.noResults');
    container.appendChild(empty);
    return;
  }

  // Aktivitätstyp lokalisieren (Preset via labelKey, Freitext unverändert).
  const activityLabel = (item) => {
    const preset = activityType(item.title);
    return preset ? t(preset.labelKey) : item.title;
  };

  function makeSection(labelKey, items, routeFn, labelFn) {
    if (!items.length) return;
    const section = document.createElement('div');
    section.className = 'search-section';
    const heading = document.createElement('h3');
    heading.className = 'search-section__heading';
    heading.textContent = t(labelKey);
    section.appendChild(heading);
    items.forEach((item) => {
      const btn = document.createElement('button');
      btn.className = 'search-result';
      const title = document.createElement('span');
      title.className = 'search-result__title';
      title.textContent = labelFn ? labelFn(item) : item.title;
      btn.appendChild(title);
      btn.addEventListener('click', () => {
        onClose();
        navigate(routeFn(item));
      });
      section.appendChild(btn);
    });
    container.appendChild(section);
  }

  makeSection('nav.tasks',    tasks,    (i) => `/tasks?open=${i.id}`);
  makeSection('nav.calendar', events,   (i) => `/calendar?open=${i.id}`);
  makeSection('nav.notes',    notes,    (i) => `/notes?open=${i.id}`);
  makeSection('nav.contacts', contacts, (i) => `/contacts?open=${i.id}`);
  makeSection('nav.shopping', items,    (i) => `/shopping?list=${i.list_id}&highlight=${i.id}`);
  makeSection('health.tabs.meds',     meds,       () => '/health/meds');
  makeSection('health.tabs.activity', activities, () => '/health/activity', activityLabel);
}

// Read-only-Modus für ein Modul anwenden (#467): FAB via <html data-module-readonly>
// ausblenden (CSS) und einen erklärenden Banner oben in die Seite einfügen.
// navModuleAccess liefert 'write' für nicht-gateable Module (Dashboard, Settings,
// Third-Party), sodass diese nie fälschlich als read-only markiert werden.
function applyModuleReadonly(moduleName, pageWrapper) {
  const readOnly = navModuleAccess(moduleName) === 'read';
  document.documentElement.toggleAttribute('data-module-readonly', readOnly);
  if (!readOnly || !pageWrapper || pageWrapper.querySelector('.module-readonly-banner')) return;
  const banner = document.createElement('div');
  banner.className = 'module-readonly-banner';
  banner.setAttribute('role', 'status');
  banner.insertAdjacentHTML(
    'afterbegin',
    `<i data-lucide="eye" aria-hidden="true"></i><span>${esc(t('settings.permReadOnlyBanner'))}</span>`,
  );
  pageWrapper.insertBefore(banner, pageWrapper.firstChild);
  window.lucide?.createIcons({ el: banner });
}

function navItems() {
  if (currentUser?.access_scope === 'split_guest') {
    return [
      { path: '/budget', label: t('splitExpenses.tabLabel'), icon: 'receipt-text', module: 'budget' },
    ];
  }
  const baseItems = [
    // Overview
    { path: '/',          label: t('nav.dashboard'), icon: 'layout-dashboard', module: 'dashboard', section: NAV_SECTION.overview },
    // Plan
    { path: '/calendar',  label: t('nav.calendar'),  icon: 'calendar',         module: 'calendar',  section: NAV_SECTION.plan },
    { path: '/tasks',     label: t('nav.tasks'),     icon: 'check-square',     module: 'tasks',     section: NAV_SECTION.plan },
    { path: '/notes',     label: t('nav.notes'),     icon: 'sticky-note',      module: 'notes',     section: NAV_SECTION.plan },
    // Home — Kitchen-Gruppe zuerst, dann die übrigen Haushalts-Module
    { path: '/meals',     label: t('nav.meals'),     icon: 'utensils',      module: 'meals',    section: NAV_SECTION.home, kitchenGroup: true },
    { path: '/recipes',   label: t('nav.recipes'),   icon: 'book-text',     module: 'recipes',  section: NAV_SECTION.home, kitchenGroup: true },
    { path: '/shopping',  label: t('nav.shopping'),  icon: 'shopping-cart', module: 'shopping', section: NAV_SECTION.home, kitchenGroup: true },
    { path: '/contacts',  label: t('nav.contacts'),  icon: 'book-user',        module: 'contacts',    section: NAV_SECTION.home },
    { path: '/birthdays', label: t('nav.birthdays'), icon: 'cake',             module: 'birthdays',   section: NAV_SECTION.home },
    { path: '/budget',    label: t('nav.budget'),    icon: 'wallet',           module: 'budget',      section: NAV_SECTION.home },
    { path: '/documents', label: t('nav.documents'), icon: 'folder-lock',      module: 'documents',   section: NAV_SECTION.home },
    { path: '/housekeeping', label: t('nav.housekeeping'), icon: 'paintbrush', module: 'housekeeping', section: NAV_SECTION.home },
    { path: '/rewards',   label: t('nav.rewards'),   icon: 'award',            module: 'rewards',     section: NAV_SECTION.home },
    { path: '/health',    label: t('nav.health'),    icon: 'heart-pulse',      module: 'health',      section: NAV_SECTION.home },
    // Settings ist am Ende gepinnt (siehe unten).
    { path: '/settings',  navHref: '/settings?view=domains', label: t('nav.settings'),  icon: 'settings',         module: 'settings',    section: NAV_SECTION.home },
  ];
  const thirdPartyItems = _thirdPartyModules
    .filter((module) => module.enabled && module.status === 'enabled' && module.menu?.show && module.route?.path)
    .map((module) => ({
      path: module.route.path,
      label: module.menu.label || module.name,
      icon: module.menu.icon || module.icon || 'box',
      module: `third-party-${module.id}`,
      accent: module.accent,
      order: module.menu.order ?? 1000,
      orderId: `third-party-${module.id}`,
      section: NAV_SECTION.customModules,
    }))
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  const settings = baseItems.find((item) => item.module === 'settings');
  const sortable = [
    ...baseItems.filter((item) =>
      item.module !== 'settings'
      && !_disabledModules.has(item.module)
      && canAccessNavModule(item.module)),
    ...thirdPartyItems,
  ];
  const ordered = sortNavigationItems(sortable, _moduleOrder);
  return settings ? [...ordered, settings] : ordered;
}

function currentKitchenDestination() {
  const kitchenItems = navItems().filter((item) => item.kitchenGroup);
  return kitchenItems.find((item) => item.path === getLastKitchenRoute()) ?? kitchenItems[0] ?? null;
}

function mobileNavigationCandidates() {
  const candidates = [];
  let kitchenAdded = false;

  for (const item of navItems()) {
    if (item.module === 'dashboard' || item.module === 'settings') continue;
    if (item.kitchenGroup) {
      if (!kitchenAdded) {
        const kitchen = currentKitchenDestination();
        if (kitchen) {
          candidates.push({
            ...kitchen,
            label: t('nav.kitchen'),
            icon: 'utensils',
            navId: 'kitchen',
          });
        }
        kitchenAdded = true;
      }
      continue;
    }
    candidates.push({ ...item, navId: item.module });
  }

  return candidates;
}

function mobileFavoriteItems() {
  const candidates = mobileNavigationCandidates();
  const byId = new Map(candidates.map((item) => [item.navId, item]));
  const selectedIds = resolveMobileNavOrder(_mobileNavOrder, [...byId.keys()])
    .slice(0, MOBILE_FAVORITE_COUNT);
  return selectedIds.map((id) => byId.get(id)).filter(Boolean);
}

function secondaryMobileItems() {
  const favoriteIds = new Set(mobileFavoriteItems().map((item) => item.navId));
  const settings = navItems().find((item) => item.module === 'settings');
  return [
    ...mobileNavigationCandidates().filter((item) => !favoriteIds.has(item.navId)),
    ...(settings ? [{ ...settings, navId: settings.module }] : []),
  ];
}

function sidebarNavItems() {
  const elements = [];
  // Morphende Indikator-Pille — wird als erstes Kind eingefügt damit
  // z-index: 0 es hinter den nav-items (z-index: 1) hält.
  const indicator = document.createElement('div');
  indicator.className = 'nav-sidebar__indicator';
  indicator.setAttribute('aria-hidden', 'true');
  elements.push(indicator);

  let kitchenAdded = false;
  let currentSection = null;

  const pushSectionLabel = (section) => {
    if (section === currentSection) return;
    currentSection = section;
    const labelKey = NAV_SECTION_LABEL_KEYS[section];
    if (!labelKey) return;
    const label = document.createElement('div');
    label.className = 'nav-section-label';
    label.textContent = t(labelKey);
    elements.push(label);
  };

  navItems().forEach((item) => {
    // Settings ist gepinnt und gehört zu keiner sichtbaren Sektionsgruppe.
    if (item.module !== 'settings') pushSectionLabel(item.section);

    if (item.kitchenGroup) {
      if (!kitchenAdded) {
        elements.push(sidebarKitchenEl());
        kitchenAdded = true;
      }
      return;
    }
    const el = navItemEl(item);
    // Settings ans Sidebar-Ende pinnen — über eine explizite Klasse statt
    // ":last-child a": ein Third-Party-Modul, das als letztes <a> rendert,
    // würde sonst fälschlich nach unten gedrückt.
    if (item.module === 'settings') el.classList.add('nav-item--pinned-end');
    elements.push(el);
  });
  return elements;
}

function isModuleDisabled(moduleName) {
  return _disabledModules.has(moduleName);
}

function applySidebarCollapsed(collapsed) {
  document.documentElement.classList.toggle('sidebar-collapsed', collapsed);
  if (!collapsed) {
    document.documentElement.classList.remove('sidebar-collapse-pointer-lock');
  }
}

function setDisabledModules(modules) {
  _disabledModules = new Set(Array.isArray(modules) ? modules : []);
  rebuildNavigation();
}

function setModuleOrder(order) {
  _moduleOrder = Array.isArray(order) ? order : [];
  rebuildNavigation();
}

function setMobileNavOrder(order) {
  _mobileNavOrder = Array.isArray(order) ? order : [];
  rebuildNavigation();
}

async function refreshThirdPartyModules() {
  await syncThirdPartyModules();
  rebuildNavigation();
}

async function disableFailedThirdPartyModule(moduleId) {
  if (!moduleId) return;
  try {
    await api.patch(`/modules/${encodeURIComponent(moduleId)}`, { enabled: false });
    // Only remove locally if admin successfully disabled it
    _thirdPartyModules = _thirdPartyModules.filter((module) => module.id !== moduleId);
    rebuildNavigation();
  } catch (err) {
    // Non-admins cannot disable modules; keep module visible
    // For actual failures (not 403), still remove from local state to avoid broken UI
    if (err?.status !== 403) {
      _thirdPartyModules = _thirdPartyModules.filter((module) => module.id !== moduleId);
      rebuildNavigation();
    }
  }
}

function navItemEl({ path, navHref, label, icon, module: mod, accent, navId }) {
  const a = document.createElement('a');
  a.href = navHref ?? path;
  a.dataset.route = path;
  a.dataset.navId = navId ?? mod;
  if (navHref) a.dataset.navHref = navHref;
  a.className = 'nav-item';
  a.setAttribute('aria-label', label);
  a.setAttribute('title', label);
  if (accent) a.style.setProperty('--item-module-accent', accent);
  else if (mod) a.style.setProperty('--item-module-accent', `var(--module-${mod})`);
  const iconWrap = document.createElement('div');
  iconWrap.className = 'nav-item__icon-wrap';
  const well = document.createElement('div');
  well.className = 'nav-item__icon-well';
  const iconFactory = NAV_ICONS[icon];
  if (iconFactory) {
    const svg = iconFactory();
    svg.classList.add('nav-item__icon');
    well.appendChild(svg);
  } else {
    const i = document.createElement('i');
    i.dataset.lucide = icon;
    i.className = 'nav-item__icon';
    i.setAttribute('aria-hidden', 'true');
    well.appendChild(i);
  }
  iconWrap.appendChild(well);
  const span = document.createElement('span');
  span.className = 'nav-item__label';
  span.textContent = label;
  a.appendChild(iconWrap);
  a.appendChild(span);
  return a;
}

function kitchenNavButtonEl(item) {
  const kitchenBtn = document.createElement('button');
  kitchenBtn.className = 'nav-item nav-item--kitchen';
  kitchenBtn.id = 'kitchen-btn';
  kitchenBtn.type = 'button';
  kitchenBtn.dataset.navId = 'kitchen';
  kitchenBtn.style.setProperty('--item-module-accent', `var(--module-${item.module || 'meals'})`);
  kitchenBtn.setAttribute('aria-label', t('nav.kitchen'));
  kitchenBtn.setAttribute('title', t('nav.kitchen'));

  const iconWrap = document.createElement('div');
  iconWrap.className = 'nav-item__icon-wrap';
  const well = document.createElement('div');
  well.className = 'nav-item__icon-well';
  const iconFactory = NAV_ICONS.utensils;
  if (iconFactory) {
    const svg = iconFactory();
    svg.classList.add('nav-item__icon');
    well.appendChild(svg);
  } else {
    const icon = document.createElement('i');
    icon.dataset.lucide = 'utensils';
    icon.className = 'nav-item__icon';
    icon.setAttribute('aria-hidden', 'true');
    well.appendChild(icon);
  }
  iconWrap.appendChild(well);

  const label = document.createElement('span');
  label.className = 'nav-item__label';
  label.textContent = t('nav.kitchen');
  kitchenBtn.append(iconWrap, label);
  kitchenBtn.addEventListener('click', () => {
    const destination = currentKitchenDestination();
    if (destination) navigate(destination.path);
  });
  return kitchenBtn;
}

function moreNavButtonEl() {
  const moreBtn = document.createElement('button');
  moreBtn.className = 'nav-item nav-item--more';
  moreBtn.id = 'more-btn';
  moreBtn.type = 'button';
  moreBtn.style.setProperty('--item-module-accent', 'var(--color-accent)');
  moreBtn.setAttribute('aria-label', t('nav.more'));
  moreBtn.setAttribute('title', t('nav.more'));
  moreBtn.setAttribute('aria-expanded', 'false');
  moreBtn.setAttribute('aria-controls', 'more-sheet');

  const iconWrap = document.createElement('div');
  iconWrap.className = 'nav-item__icon-wrap';
  const well = document.createElement('div');
  well.className = 'nav-item__icon-well';
  const iconFactory = NAV_ICONS['more-horizontal'];
  if (iconFactory) {
    const svg = iconFactory();
    svg.classList.add('nav-item__icon');
    well.appendChild(svg);
  } else {
    const icon = document.createElement('i');
    icon.dataset.lucide = 'more-horizontal';
    icon.className = 'nav-item__icon';
    icon.setAttribute('aria-hidden', 'true');
    well.appendChild(icon);
  }
  iconWrap.appendChild(well);

  const label = document.createElement('span');
  label.className = 'nav-item__label';
  label.textContent = t('nav.more');
  moreBtn.append(iconWrap, label);
  return moreBtn;
}

function mobileDestinationEl(item) {
  return item.navId === 'kitchen' ? kitchenNavButtonEl(item) : navItemEl(item);
}

function buildBottomNavItems(moreBtn = moreNavButtonEl()) {
  const dashboard = navItems().find((item) => item.module === 'dashboard');
  return [
    ...(dashboard ? [navItemEl({ ...dashboard, navId: 'dashboard' })] : []),
    ...mobileFavoriteItems().map(mobileDestinationEl),
    moreBtn,
  ];
}

function replaceLucideIcon(container, selector, iconName) {
  const current = container.querySelector(selector);
  if (!current) return;
  const next = document.createElement('i');
  next.dataset.lucide = iconName;
  const classes = (current.getAttribute('class') || '')
    .split(/\s+/)
    .filter((className) => className && className !== 'lucide' && !className.startsWith('lucide-'));
  next.className = classes.join(' ') || 'nav-item__icon';
  next.setAttribute('aria-hidden', 'true');
  current.replaceWith(next);
  if (window.lucide) window.lucide.createIcons({ el: container });
}

/**
 * Ersetzt ein Nav-Icon (Custom SVG bevorzugt, Lucide als Fallback).
 * Funktioniert sowohl mit <svg>- als auch <i data-lucide>-Elementen.
 */
function replaceNavIcon(container, selector, lucideIconName) {
  const current = container.querySelector(selector);
  if (!current) return;
  const iconFactory = NAV_ICONS[lucideIconName];
  if (iconFactory) {
    const classes = (current.getAttribute('class') || '')
      .split(/\s+/)
      .filter((cls) => cls && cls !== 'lucide' && !cls.startsWith('lucide-'));
    const svg = iconFactory();
    svg.className.baseVal = classes.join(' ') || 'nav-item__icon';
    current.replaceWith(svg);
  } else {
    replaceLucideIcon(container, selector, lucideIconName);
  }
}

/**
 * Positioniert den morphenden Indikator in der Sidebar auf dem aktiven Nav-Item.
 */
function positionSidebarIndicator() {
  const container = document.querySelector('.nav-sidebar__items');
  const indicator = container?.querySelector('.nav-sidebar__indicator');
  if (!indicator) return;
  const active = container.querySelector('.nav-item[aria-current="page"]');
  if (!active) {
    indicator.style.opacity = '0';
    return;
  }
  const cr = container.getBoundingClientRect();
  const ar = active.getBoundingClientRect();
  // Pille (44px) vertikal im Item (48px) zentrieren — aus realen Höhen, token-unabhängig
  const centerOffset = (ar.height - indicator.getBoundingClientRect().height) / 2;
  indicator.style.transform = `translateY(${ar.top - cr.top + container.scrollTop + centerOffset}px)`;
  indicator.style.opacity = '';
}

/**
 * Positioniert den gleitenden Indikator in der mobilen Tab-Bar.
 */
function positionTabIndicator() {
  const nav = document.querySelector('.nav-bottom');
  const indicator = nav?.querySelector('.nav-bottom__indicator');
  if (!indicator || !nav) return;
  const active = document.querySelector(
    '.nav-bottom__items .nav-item[aria-current="page"], .nav-bottom__items .nav-item--active',
  );
  if (!active) {
    indicator.style.opacity = '0';
    return;
  }
  const nr = nav.getBoundingClientRect();
  const ar = active.getBoundingClientRect();
  indicator.style.width = `${ar.width}px`;
  indicator.style.transform = `translateX(${ar.left - nr.left}px)`;
  indicator.style.opacity = '';
}

function sidebarKitchenEl() {
  const item = {
    path: getLastKitchenRoute(),
    label: t('nav.kitchen'),
    icon: 'utensils',
    module: navItems().find((n) => n.path === getLastKitchenRoute())?.module || 'meals',
    navId: 'kitchen',
  };
  const a = navItemEl(item);
  a.id = 'sidebar-kitchen-nav';
  a.setAttribute('aria-label', kitchenNavAriaLabel(currentPath));
  a.setAttribute('title', t('nav.kitchen'));
  return a;
}

function moreItemEl({ path, navHref, label, icon, module: mod, accent, navId }) {
  const a = document.createElement('a');
  a.href = navHref ?? path;
  a.dataset.route = path;
  a.dataset.navId = navId ?? mod;
  if (navHref) a.dataset.navHref = navHref;
  a.className = 'more-item';
  if (accent) a.style.setProperty('--item-module-accent', accent);
  else if (mod) a.style.setProperty('--item-module-accent', `var(--module-${mod})`);
  const well = document.createElement('div');
  well.className = 'more-item__icon-well';
  const iconFactory = NAV_ICONS[icon];
  if (iconFactory) {
    const svg = iconFactory();
    svg.classList.add('more-item__icon');
    well.appendChild(svg);
  } else {
    const i = document.createElement('i');
    i.dataset.lucide = icon;
    i.className = 'more-item__icon';
    i.setAttribute('aria-hidden', 'true');
    well.appendChild(i);
  }
  const span = document.createElement('span');
  span.className = 'more-item__label';
  span.textContent = label;
  a.appendChild(well);
  a.appendChild(span);
  return a;
}

function kitchenSectionLabel(path) {
  const kitchenItems = navItems().filter((i) => i.kitchenGroup);
  const targetRoute = isKitchenRoute(path) ? path : getLastKitchenRoute();
  return kitchenItems.find((i) => i.path === targetRoute)?.label ?? t('nav.meals');
}

function kitchenNavAriaLabel(path) {
  if (isKitchenRoute(path)) {
    return t('nav.kitchenActiveLabel', { section: kitchenSectionLabel(path) });
  }
  // Inaktiv das Ziel offenlegen: der Küche-Tab führt zur zuletzt besuchten
  // Sektion (Meals/Recipes/Shopping). Ohne diese Ansage ist für Screenreader-
  // und Tastatur-Nutzer nicht vorhersagbar, wohin der Tab navigiert.
  return t('nav.kitchenGoLabel', { section: kitchenSectionLabel(path) });
}

/**
 * Aktiven Nav-Link hervorheben und More-Button als aktiv markieren
 * wenn die aktive Route im More-Sheet liegt.
 */
function setMoreButtonState(moreBtn, activeSecondary) {
  const inMoreSheet = !!activeSecondary;
  const moreLabel = activeSecondary
    ? t('nav.moreActiveLabel', { section: activeSecondary.label })
    : t('nav.more');

  moreBtn.classList.toggle('nav-item--active', inMoreSheet);
  if (inMoreSheet) {
    moreBtn.setAttribute('aria-current', 'page');
    if (activeSecondary.accent) {
      moreBtn.style.setProperty('--item-module-accent', activeSecondary.accent);
    } else if (activeSecondary.module) {
      moreBtn.style.setProperty('--item-module-accent', `var(--module-${activeSecondary.module})`);
    }
  } else {
    moreBtn.removeAttribute('aria-current');
    moreBtn.style.setProperty('--item-module-accent', 'var(--color-accent)');
  }

  moreBtn.setAttribute('aria-label', moreLabel);
  moreBtn.setAttribute('title', t('nav.more'));

  const moreBtnLabel = moreBtn.querySelector('.nav-item__label');
  if (moreBtnLabel) moreBtnLabel.textContent = t('nav.more');
  replaceNavIcon(moreBtn, '.nav-item__icon', 'more-horizontal');
}

function updateNav(path) {
  const kitchenDestination = currentKitchenDestination();
  document.querySelectorAll('[data-route]').forEach((el) => {
    if (el.dataset.navId === 'kitchen' && kitchenDestination) {
      el.dataset.route = kitchenDestination.path;
      if (el.tagName === 'A') el.href = kitchenDestination.path;
    }
    el.removeAttribute('aria-current');
    const isActiveKitchenDestination = el.dataset.navId === 'kitchen' && isKitchenRoute(path);
    if (el.dataset.route === path || isActiveKitchenDestination) {
      el.setAttribute('aria-current', 'page');
    }
  });

  const kitchenNavBtn = document.querySelector('#kitchen-btn');
  if (kitchenNavBtn) {
    const isKitchen = isKitchenRoute(path);
    kitchenNavBtn.classList.toggle('nav-item--active', isKitchen);
    if (isKitchen) {
      kitchenNavBtn.setAttribute('aria-current', 'page');
      const kitchenMod = navItems().find((n) => n.path === getLastKitchenRoute())?.module;
      if (kitchenMod) kitchenNavBtn.style.setProperty('--item-module-accent', `var(--module-${kitchenMod})`);
    } else {
      kitchenNavBtn.removeAttribute('aria-current');
      const kitchenMod = navItems().find((n) => n.path === getLastKitchenRoute())?.module;
      kitchenNavBtn.style.setProperty('--item-module-accent', `var(--module-${kitchenMod || 'meals'})`);
    }

    const kitchenBtnLabel = kitchenNavBtn.querySelector('.nav-item__label');
    if (kitchenBtnLabel) kitchenBtnLabel.textContent = t('nav.kitchen');
    kitchenNavBtn.setAttribute('aria-label', kitchenNavAriaLabel(path));
    kitchenNavBtn.setAttribute('title', t('nav.kitchen'));
  }

  const sidebarKitchenNav = document.querySelector('#sidebar-kitchen-nav');
  if (sidebarKitchenNav) {
    const isKitchen = isKitchenRoute(path);
    if (isKitchen) {
      sidebarKitchenNav.setAttribute('aria-current', 'page');
      const kitchenMod = navItems().find((n) => n.path === getLastKitchenRoute())?.module;
      if (kitchenMod) sidebarKitchenNav.style.setProperty('--item-module-accent', `var(--module-${kitchenMod})`);
    } else {
      sidebarKitchenNav.removeAttribute('aria-current');
    }
    sidebarKitchenNav.setAttribute('aria-label', kitchenNavAriaLabel(path));
    sidebarKitchenNav.setAttribute('title', t('nav.kitchen'));
  }

  const moreBtn = document.querySelector('#more-btn');
  if (moreBtn) {
    const activeSecondary = secondaryMobileItems().find((item) => (
      item.navId === 'kitchen' ? isKitchenRoute(path) : item.path === path
    ));
    setMoreButtonState(moreBtn, activeSecondary);
  }

  if (window.lucide) {
    const navRoot = document.getElementById('app');
    window.lucide.createIcons(navRoot ? { el: navRoot } : undefined);
  }

  requestAnimationFrame(() => {
    positionSidebarIndicator();
    positionTabIndicator();
  });
}

function renderError(container, err) {
  const state = document.createElement('div');
  state.className = 'empty-state';
  state.tabIndex = -1;
  state.setAttribute('role', 'alert');
  const title = document.createElement('div');
  title.className = 'empty-state__title';
  title.textContent = t('common.errorOccurred');
  const desc = document.createElement('div');
  desc.className = 'empty-state__description';
  desc.textContent = friendlyError(err);
  const btn = document.createElement('button');
  btn.className = 'btn btn--primary';
  btn.id = 'error-reload-btn';
  btn.textContent = t('common.reload');
  btn.addEventListener('click', () => location.reload());
  state.append(title, desc, btn);
  container.replaceChildren(state);
  state.focus({ preventScroll: true });
}

// --------------------------------------------------------
// Toast-Benachrichtigungen (global)
// --------------------------------------------------------

/**
 * Zeigt eine Toast-Benachrichtigung an.
 * @param {string} message
 * @param {'default'|'success'|'danger'|'warning'} type
 * @param {number} duration - ms
 */
const TOAST_SUCCESS_KEY = 'yuvomi:toastSuccessCount';
const TOAST_SUCCESS_MAX = 50;

function _toastSvg(children) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'toast__icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.5');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of children) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  return svg;
}

const TOAST_ICONS = {
  success: () => _toastSvg([['polyline', { points: '20 6 9 17 4 12' }]]),
  danger:  () => _toastSvg([
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['line',   { x1: '12', y1: '8',  x2: '12',   y2: '12' }],
    ['line',   { x1: '12', y1: '16', x2: '12.01', y2: '16' }],
  ]),
  warning: () => _toastSvg([
    ['path', { d: 'M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z' }],
    ['line', { x1: '12', y1: '9',  x2: '12',   y2: '13' }],
    ['line', { x1: '12', y1: '17', x2: '12.01', y2: '17' }],
  ]),
};

function showToast(message, type = 'default', duration = 3000, onUndo = null) {
  const containerId = (type === 'danger' || type === 'warning')
    ? 'toast-container-assertive'
    : 'toast-container-polite';
  const container = document.getElementById(containerId);
  if (!container) return;

  // Long Loop: Success-Toasts nach TOAST_SUCCESS_MAX Aufrufen unterdrücken
  if (type === 'success' && typeof onUndo !== 'function') {
    const successCount = parseInt(localStorage.getItem(TOAST_SUCCESS_KEY) ?? '0', 10) + 1;
    localStorage.setItem(TOAST_SUCCESS_KEY, String(successCount));
    if (successCount > TOAST_SUCCESS_MAX) return;
  }

  // Max. 3 gleichzeitige Toasts (global): ältesten entfernen falls Limit erreicht
  const existing = document.querySelectorAll('.toast-container .toast');
  if (existing.length >= 3) existing[0].remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type !== 'default' ? `toast--${type}` : ''}`;
  toast.setAttribute('role', 'alert');

  const iconEl = TOAST_ICONS[type]?.();
  if (iconEl) toast.appendChild(iconEl);
  const span = document.createElement('span');
  span.textContent = message;
  toast.appendChild(span);

  if (typeof onUndo === 'function') {
    const undoBtn = document.createElement('button');
    undoBtn.className = 'toast__undo';
    undoBtn.textContent = t('common.undo');
    undoBtn.addEventListener('click', () => {
      clearTimeout(dismissTimer);
      toast.remove();
      onUndo();
    });
    toast.appendChild(undoBtn);
  }

  container.appendChild(toast);
  const dismissTimer = setTimeout(() => {
    toast.classList.add('toast--out');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, duration);

  let startX = 0;
  toast.addEventListener('pointerdown', (e) => { startX = e.clientX; toast.setPointerCapture(e.pointerId); });
  toast.addEventListener('pointermove', (e) => {
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 10) {
      toast.style.transform = `translateX(${dx}px)`;
      toast.style.opacity = String(Math.max(0, 1 - Math.abs(dx) / 120));
    }
  });
  toast.addEventListener('pointerup', (e) => {
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 40) {
      clearTimeout(dismissTimer);
      toast.classList.add('toast--out');
      toast.addEventListener('animationend', () => toast.remove(), { once: true });
    } else {
      toast.style.transform = '';
      toast.style.opacity = '';
    }
  });
}

// --------------------------------------------------------
// Event-Listener
// --------------------------------------------------------

// --------------------------------------------------------
// Fehler-Hilfsfunktion
// --------------------------------------------------------

function friendlyError(err) {
  // Offline-Mutation (ApiError status 0): spezifische Meldung — auch wenn
  // navigator.onLine fälschlich true meldet (Netz weg, aber kein offline-Event).
  if (err?.status === 0) return t('common.errorOfflineMutation');
  if (!navigator.onLine) return t('common.errorOffline');
  const status = err?.status ?? err?.response?.status;
  if (status === 403) return t('common.errorForbidden');
  if (status === 404) return t('common.errorNotFound');
  if (status >= 500) return t('common.errorServer');
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return t('common.errorTimeout');
  if (/Failed to fetch|NetworkError|Load failed/i.test(err?.message || '')) return t('common.errorServer');
  if (err?.name === 'TypeError') return t('common.unexpectedError');
  return err?.data?.error || err?.message || t('common.errorGeneric');
}

// --------------------------------------------------------
// Globale Fehler-Handler (Error Boundary)
// --------------------------------------------------------

window.addEventListener('error', (e) => {
  // Ressource-Ladefehler (z.B. fehlgeschlagenes Bild): ignorieren
  if (e.target && e.target !== window) return;
  console.error('[Yuvomi] Unbehandelter Fehler:', e.error ?? e.message);
  showToast(t('common.unexpectedError'), 'danger');
});

window.addEventListener('unhandledrejection', (e) => {
  // Auth-Fehler werden bereits von auth:expired behandelt
  if (e.reason?.status === 401) return;
  console.error('[Yuvomi] Unbehandeltes Promise-Rejection:', e.reason);
  showToast(friendlyError(e.reason), 'danger');
  e.preventDefault(); // Konsolenfehler unterdrücken (bereits geloggt)
});

// SW-Update: neue Version im Hintergrund installiert → Toast anzeigen
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'SW_UPDATED') {
      // Modul-Cache leeren damit nächste Navigation frische Module lädt
      moduleCache.clear();
      showToast(t('common.updateAvailable'), 'default', 8000);
      setTimeout(() => location.reload(), 8000);
    }
  });
}

// Browser zurück/vor
window.addEventListener('popstate', (e) => {
  navigate(e.state?.path || location.pathname, false);
});

// Session abgelaufen
window.addEventListener('auth:expired', () => {
  currentUser = null;
  // Offline-API-Cache leeren: Session-Ende → keine gecachten Daten zurücklassen,
  // die der nächste Nutzer am selben Gerät offline sehen könnte.
  clearApiCache();
  stopThirdPartyModulePolling();
  stopReminders();
  stopPush();
  if (isNavigating) {
    // navigate('/login') kann nicht sofort aufgerufen werden - wird im finally-Block
    // der laufenden Navigation nachgeholt.
    _pendingLoginRedirect = true;
  } else {
    navigate('/login');
  }
});

// Navigation komplett neu rendern (z.B. nach Sprach- oder Modul-Toggle-Änderung).
// Behält Bottom-Bar-Buttons (Kitchen, More) und More-Sheet-Handle/Suche bei.
function rebuildNavigation({ updateLabels = true } = {}) {
  const skipLink     = document.querySelector('.sr-only[href="#main-content"]');
  const navSidebar   = document.querySelector('.nav-sidebar');
  const navSidebarItems = document.querySelector('.nav-sidebar__items');
  const navBottom    = document.querySelector('.nav-bottom');
  const bottomItems  = document.querySelector('.nav-bottom__items');
  const moreSheet    = document.querySelector('#more-sheet');
  const moreBtnLabel = document.querySelector('#more-btn .nav-item__label');

  if (updateLabels) {
    if (skipLink)     skipLink.textContent = t('common.skipToContent');
    if (navSidebar)   navSidebar.setAttribute('aria-label', t('nav.main'));
    if (navBottom)    navBottom.setAttribute('aria-label', t('nav.navigation'));
    if (moreBtnLabel) moreBtnLabel.textContent = t('nav.more');
  }

  if (navSidebarItems) {
    const sidebarEls = sidebarNavItems();
    navSidebarItems.replaceChildren(...sidebarEls);
    if (window.lucide) window.lucide.createIcons({ el: navSidebarItems });
    requestAnimationFrame(() => positionSidebarIndicator());
  }
  if (bottomItems) {
    const moreBtn = bottomItems.querySelector('#more-btn') ?? moreNavButtonEl();
    bottomItems.replaceChildren(...buildBottomNavItems(moreBtn));
    requestAnimationFrame(() => positionTabIndicator());
  }
  if (moreSheet) {
    const handle = moreSheet.querySelector('.more-sheet__handle');
    const searchBar = moreSheet.querySelector('#more-sheet-search');
    if (searchBar) {
      const placeholder = searchBar.querySelector('.more-sheet__search-placeholder');
      if (placeholder) placeholder.textContent = t('search.placeholder');
      searchBar.setAttribute('aria-label', t('search.placeholder'));
    }
    // Handle + Suchleiste bewahren (Event-Wiring); Body über die geteilte
    // Funktion neu bauen — identisch zu renderAppShell().
    moreSheet.replaceChildren(handle, ...(searchBar ? [searchBar] : []), ...buildMoreSheetBody());
    if (window.lucide) window.lucide.createIcons({ el: moreSheet });
  }

  document.querySelectorAll('[data-route]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(el.dataset.navHref ?? el.dataset.route);
    });
  });

  updateNav(currentPath);
  updateBranding(currentPath || '/');
}

// Sprache geändert: Navigation und aktuelle Seite gemeinsam neu rendern.
window.addEventListener('locale-changed', () => {
  rebuildNavigation();
  refreshCurrentRoute();
});

window.addEventListener('app-name-changed', () => {
  updateBranding(currentPath || '/');
});

function refreshCurrentRoute() {
  if (!currentPath) return;
  setTimeout(() => {
    if (!currentPath) return;
    navigate(currentPath, false);
  }, 0);
}

window.addEventListener('date-format-changed', refreshCurrentRoute);
window.addEventListener('time-format-changed', refreshCurrentRoute);

window.addEventListener('resize', () => {
  positionSidebarIndicator();
  positionTabIndicator();
}, { passive: true });

// --------------------------------------------------------
// Virtuelle Tastatur: FAB ausblenden wenn Keyboard offen
// Erkennung via visualViewport - Höhe < 75% des Fensters = Keyboard aktiv.
// Nur auf Mobilgeräten relevant (< 1024px), Desktop hat keine virtuelle Tastatur.
// --------------------------------------------------------
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    const keyboardVisible = window.visualViewport.height < window.innerHeight * 0.75;
    document.body.classList.toggle('keyboard-visible', keyboardVisible);
  });
}

// --------------------------------------------------------
// iOS PWA: Viewport-Zoom bei Tastatur-Erscheinen verhindern.
// iOS Safari/WKWebView zoomt ins Layout wenn ein Formularfeld fokussiert wird
// und stellt den Zoom nach Tastatur-Schliessen im Standalone-Modus nicht
// automatisch zurück → Menüpunkte verschwinden aus dem sichtbaren Bereich.
//
// Fix: maximum-scale=1 während des Focus setzt (verhindert Zoom),
// danach original Wert wiederherstellen (erhält manuelle Zoom-Möglichkeit
// für Barrierefreiheit). Nur auf iOS-Geräten aktiv.
// --------------------------------------------------------
if (/iPhone|iPad|iPod/.test(navigator.userAgent)) {
  const metaViewport = document.querySelector('meta[name="viewport"]');
  if (metaViewport) {
    const originalContent = metaViewport.getAttribute('content');
    const noZoomContent = originalContent.replace(/maximum-scale=\d+/, 'maximum-scale=1');

    document.addEventListener('focusin', ({ target }) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
        metaViewport.setAttribute('content', noZoomContent);
      }
    });

    document.addEventListener('focusout', ({ target }) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
        // Kurze Verzögerung: iOS braucht ~150ms um Layout nach Tastatur-
        // Schliessen wiederherzustellen, bevor scale zurückgesetzt wird.
        setTimeout(() => metaViewport.setAttribute('content', originalContent), 150);
      }
    });
  }
}

// --------------------------------------------------------
// Initialisierung
// --------------------------------------------------------
(async () => {
  try {
    // Vorab-Theme-Anwendung ohne Abhängigkeit von window.yuvomi
    const stored = localStorage.getItem('yuvomi-theme');
    if (stored === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else if (stored === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    
    await initI18n();
    try {
      const v = await api.get('/version');
      _setupRequired = v?.setup_required === true;
      if (v?.version) setAppVersion(v.version);
      if (v?.app_name) setAppName(v.app_name);
    } catch {
      _setupRequired = false; // Fail-safe: kein Setup erzwingen
    }
    navigate(location.pathname, false);
  } catch (err) {
    console.error('[Router] Initialisierung fehlgeschlagen:', err);
    const loading = document.getElementById('app-loading');
    if (loading) loading.hidden = true;
    renderError(document.getElementById('app'), err);
  }
})();

// Globale Exporte
window.yuvomi = {
  navigate,
  showToast,
  friendlyError,
  setThemeColor,
  setDisabledModules,
  setModuleOrder,
  setMobileNavOrder,
  refreshThirdPartyModules,
  isModuleDisabled,
  applyTheme: (value) => {
    localStorage.setItem('yuvomi-theme', value);
    if (value === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else if (value === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  },
  restoreThemeColor: () => {
    const route = allRoutes().find((r) => r.path === currentPath);
    updateThemeColorForRoute(route);
  },
  // Client-seitigen Sitzungszustand nach einem bewussten Logout zurücksetzen,
  // damit die anschließende navigate('/login') nicht am currentUser-Guard
  // hängenbleibt und kurz das Dashboard zeigt (#478). Der Server-Logout läuft
  // separat über auth.logout().
  clearSession: () => {
    currentUser = null;
    _navBuiltForUserId = null;
    stopThirdPartyModulePolling();
    stopReminders();
    stopPush();
  },
};

// Legacy-Alias: Drittanbieter-Module unter modules/ wurden ggf. gegen die alte
// globale API `window.oikos` geschrieben. Ohne diesen Alias würfen ihre Aufrufe
// (window.oikos.navigate/showToast …) nach dem Rename, und der Router würde das
// Modul als fehlerhaft deaktivieren. Der Alias hält den Upgrade-Pfad nahtlos.
window.oikos = window.yuvomi;
