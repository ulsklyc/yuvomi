/**
 * Modul: Client-Side Router
 * Zweck: SPA-Routing über History API ohne Framework, Auth-Guard, Seiten-Übergänge
 * Abhängigkeiten: api.js
 */

import { api, auth } from '/api.js';
import { initI18n, getLocale, t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { init as initReminders, stop as stopReminders } from '/reminders.js';
import { isKitchenRoute, getLastKitchenRoute } from '/utils/kitchen-tabs.js';

// --------------------------------------------------------
// Routen-Definitionen
// Jede Route hat: path, page (dynamisch geladen), requiresAuth, module (für theme-color)
// --------------------------------------------------------
const ROUTES = [
  { path: '/login',    page: '/pages/login.js',    requiresAuth: false, module: null        },
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
  { path: '/settings', page: '/pages/settings.js',  requiresAuth: true, module: 'settings'  },
];

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

function loadPageStyle(moduleName) {
  if (!moduleName) return { ready: Promise.resolve(), cleanup: () => {} };
  const href = `/styles/${moduleName}.css`;
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
// Globaler App-State
// --------------------------------------------------------
let currentUser = null;
let currentPath = null;
let isNavigating = false;
let _preferencesLoaded = false;
let _disabledModules = new Set();
// Gesetzt wenn auth:expired waehrend einer laufenden Navigation feuert.
// Die Weiterleitung zu /login wird nach Abschluss der Navigation nachgeholt.
let _pendingLoginRedirect = false;

// --------------------------------------------------------
// Router
// --------------------------------------------------------

const ROUTE_ORDER = ['/', '/calendar', '/tasks', '/meals', '/recipes', '/shopping',
                     '/birthdays', '/notes', '/contacts', '/budget', '/documents', '/housekeeping', '/settings'];

const PRIMARY_NAV = 4;

const DEFAULT_APP_NAME = 'Oikos';
const APP_NAME_STORAGE_KEY = 'oikos-app-name';
const APP_VERSION_STORAGE_KEY = 'oikos-app-version';

function getDirection(fromPath, toPath) {
  const fromIdx = ROUTE_ORDER.indexOf(fromPath ?? '/');
  const toIdx   = ROUTE_ORDER.indexOf(toPath);
  if (fromIdx === -1 || toIdx === -1 || fromPath === toPath) return 'right';
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
    '/settings': t('nav.settings'),
  };
  return map[path] || getAppName();
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
  if (path === '/login' && loginTitle) loginTitle.textContent = appName;

  document.title = path === '/login'
    ? appName
    : `${routeTitle(path || '/')} · ${appName}`;

  document.querySelectorAll('meta[name="apple-mobile-web-app-title"]').forEach((meta) => {
    meta.setAttribute('content', appName);
  });
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

  try {
    // Überlastung: navigate(path, user) nach Login vs navigate(path, false) beim Init
    if (typeof userOrPushState === 'object' && userOrPushState !== null) {
      currentUser = userOrPushState;
      await syncPreferencesOnce();
      if (currentUser.access_scope !== 'split_guest') {
        loadReminderStyles();
        initReminders();
      }
    } else {
      pushState = userOrPushState;
    }

    // Alten Pfad merken, bevor currentPath aktualisiert wird - für Richtungsberechnung
    const previousPath = currentPath;
    const basePath = path.split('?')[0];
    currentPath = basePath;

    let route = ROUTES.find((r) => r.path === basePath) ?? ROUTES.find((r) => r.path === '/');

    if (currentUser?.access_scope === 'split_guest' && route.path !== '/budget') {
      currentPath = null;
      isNavigating = false;
      navigate('/budget');
      return;
    }

    // Modul-Guard: deaktivierte Module leiten auf Dashboard um.
    if (route.module && _disabledModules.has(route.module) && route.path !== '/') {
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
        if (currentUser.access_scope !== 'split_guest') {
          loadReminderStyles();
          initReminders();
        }
      } catch {
        currentPath = null; // Reset damit navigate('/login') nicht geblockt wird
        isNavigating = false;
        // _pendingLoginRedirect leeren: der catch ruft navigate('/login') direkt auf,
        // der finally soll keinen zweiten Aufruf starten (würde isNavigating=true setzen,
        // während die Login-Seite rendert, und so post-login navigate blockieren).
        _pendingLoginRedirect = false;
        navigate('/login');
        return;
      }
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

    const accent = route?.module ? getCSSToken(`--module-${route.module}`) : '';
    document.documentElement.style.setProperty('--active-module-accent', accent);

    await renderPage(route, previousPath);
    updateNav(basePath);
    updateThemeColorForRoute(route);
    updateBranding(basePath);
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
      localStorage.setItem('oikos-date-format', dateFormat);
    }
    const timeFormat = res?.data?.time_format;
    if (timeFormat) {
      localStorage.setItem('oikos-time-format', timeFormat);
    }
    if (res?.data?.app_name) {
      setAppName(res.data.app_name);
      updateBranding();
    }
    if (Array.isArray(res?.data?.disabled_modules)) {
      _disabledModules = new Set(res.data.disabled_modules);
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
    const style = loadPageStyle(route.module);
    const [module] = await Promise.all([
      importPage(route.page),
      style.ready,
    ]);

    if (typeof module.render !== 'function') {
      throw new Error(`Seite ${route.page} exportiert keine render()-Funktion.`);
    }

    // App-Shell einmalig aufbauen BEVOR render() aufgerufen wird -
    // main-content muss im DOM existieren damit document.getElementById()
    // in Seiten-Modulen funktioniert.
    if (!document.querySelector('.nav-bottom') && currentUser) {
      renderAppShell(app);
    }

    const content = document.getElementById('main-content') || app;

    // Richtung bestimmen (previousPath ist der alte Pfad vor der Navigation)
    const direction = getDirection(previousPath, route.path);
    const inClass   = direction === 'right' ? 'page-transition--in-right' : 'page-transition--in-left';

    // Performance: backdrop-filter während Übergang deaktivieren (Android-Optimierung).
    // glass.css setzt alle backdrop-filter im app-content auf none solange diese Klasse aktiv ist.
    document.documentElement.classList.add('navigating');

    // Alter Inhalt ist jetzt weg - altes Stylesheet kann entfernt werden
    const pageWrapper = document.createElement('div');
    pageWrapper.className = 'page-transition';
    pageWrapper.style.opacity = '0';
    content.replaceChildren(pageWrapper);
    style.cleanup();

    await module.render(pageWrapper, { user: currentUser });

    // FAB Long Loop: Einstiegsanimation nach FAB_SEEN_MAX Views deaktivieren
    if (pageWrapper.querySelector('.page-fab')) {
      let fabCount = parseInt(localStorage.getItem(FAB_SEEN_KEY) ?? '0', 10);
      if (fabCount < FAB_SEEN_MAX) {
        fabCount++;
        localStorage.setItem(FAB_SEEN_KEY, String(fabCount));
      }
      document.documentElement.classList.toggle('fab-anim-done', fabCount >= FAB_SEEN_MAX);
    }

    // Route-Announcer: Screenreader über Seitenwechsel informieren (gezielt, nicht gesamter Inhalt)
    const announcer = document.getElementById('route-announcer');
    if (announcer) {
      const pageLabel = navItems().find((n) => n.path === route.path)?.label ?? route.path;
      announcer.textContent = '';
      setTimeout(() => { announcer.textContent = pageLabel; }, 50);
    }

    // Erst nach render() + CSS sichtbar machen und Animation starten
    pageWrapper.style.opacity = '';
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

  } catch (err) {
    document.documentElement.classList.remove('navigating');
    console.error('[Router] Seiten-Render-Fehler:', err);
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
  const gradId = `oikos-logo-bg-${Math.random().toString(36).slice(2, 7)}`;
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
  const housePath = document.createElementNS(SVG_NS, 'path');
  housePath.setAttribute('d', 'M80 36L36 72V120C36 122.2 37.8 124 40 124H68V96H92V124H120C122.2 124 124 122.2 124 120V72L80 36Z');
  housePath.setAttribute('fill', 'white');
  logoSvg.appendChild(housePath);
  const chimney = document.createElementNS(SVG_NS, 'rect');
  chimney.setAttribute('x', '100'); chimney.setAttribute('y', '46');
  chimney.setAttribute('width', '12'); chimney.setAttribute('height', '22');
  chimney.setAttribute('rx', '2'); chimney.setAttribute('fill', 'white');
  logoSvg.appendChild(chimney);
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
  const sidebarItems = document.createElement('div');
  sidebarItems.className = 'nav-sidebar__items';
  sidebarItems.setAttribute('role', 'list');
  navItems()
    .filter((item) => !item.kitchenGroup)
    .forEach((item) => {
      sidebarItems.appendChild(navItemEl(item));
      if (item.path === '/calendar') sidebarItems.appendChild(sidebarKitchenEl());
    });
  if (window.lucide) window.lucide.createIcons({ el: sidebarItems });
  sidebar.appendChild(sidebarLogo);
  sidebar.appendChild(sidebarItems);

  const main = document.createElement('main');
  main.className = 'app-content';
  main.id = 'main-content';

  const bottomNav = document.createElement('nav');
  bottomNav.className = 'nav-bottom';
  bottomNav.setAttribute('aria-label', t('nav.navigation'));
  const bottomItems = document.createElement('div');
  bottomItems.className = 'nav-bottom__items';
  navItems().slice(0, PRIMARY_NAV).forEach((item) => bottomItems.appendChild(navItemEl(item)));

  let backdrop, moreSheet;

  if (!isGuest) {
    const kitchenBtn = document.createElement('button');
    kitchenBtn.className = 'nav-item nav-item--kitchen';
    kitchenBtn.id = 'kitchen-btn';
    kitchenBtn.type = 'button';
    kitchenBtn.setAttribute('aria-label', t('nav.kitchen'));
    kitchenBtn.setAttribute('title', t('nav.kitchen'));
    const kitchenBtnIcon = document.createElement('i');
    kitchenBtnIcon.dataset.lucide = 'utensils';
    kitchenBtnIcon.className = 'nav-item__icon';
    kitchenBtnIcon.setAttribute('aria-hidden', 'true');
    const kitchenBtnLabel = document.createElement('span');
    kitchenBtnLabel.className = 'nav-item__label';
    kitchenBtnLabel.textContent = t('nav.kitchen');
    kitchenBtn.appendChild(kitchenBtnIcon);
    kitchenBtn.appendChild(kitchenBtnLabel);
    kitchenBtn.addEventListener('click', () => navigate(getLastKitchenRoute()));
    bottomItems.appendChild(kitchenBtn);

    const moreBtn = document.createElement('button');
    moreBtn.className = 'nav-item nav-item--more';
    moreBtn.id = 'more-btn';
    moreBtn.setAttribute('aria-label', t('nav.more'));
    moreBtn.setAttribute('aria-expanded', 'false');
    const moreBtnIcon = document.createElement('i');
    moreBtnIcon.dataset.lucide = 'ellipsis';
    moreBtnIcon.className = 'nav-item__icon';
    moreBtnIcon.setAttribute('aria-hidden', 'true');
    const moreBtnLabel = document.createElement('span');
    moreBtnLabel.className = 'nav-item__label';
    moreBtnLabel.textContent = t('nav.more');
    moreBtn.appendChild(moreBtnIcon);
    moreBtn.appendChild(moreBtnLabel);
    bottomItems.appendChild(moreBtn);

    backdrop = document.createElement('div');
    backdrop.className = 'more-backdrop';
    backdrop.id = 'more-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');

    moreSheet = document.createElement('div');
    moreSheet.className = 'more-sheet';
    moreSheet.id = 'more-sheet';
    moreSheet.setAttribute('role', 'dialog');
    moreSheet.setAttribute('aria-label', t('nav.more'));
    moreSheet.setAttribute('aria-hidden', 'true');
    const dragHandle = document.createElement('div');
    dragHandle.className = 'more-sheet__handle';
    dragHandle.setAttribute('aria-hidden', 'true');
    moreSheet.insertAdjacentElement('afterbegin', dragHandle);

    const moreSearchBar = document.createElement('div');
    moreSearchBar.className = 'more-sheet__search';
    moreSearchBar.id = 'more-sheet-search';
    moreSearchBar.setAttribute('role', 'button');
    moreSearchBar.setAttribute('tabindex', '0');
    moreSearchBar.setAttribute('aria-label', t('search.placeholder'));
    const moreSearchIcon = document.createElement('i');
    moreSearchIcon.dataset.lucide = 'search';
    moreSearchIcon.className = 'more-sheet__search-icon';
    moreSearchIcon.setAttribute('aria-hidden', 'true');
    const moreSearchPlaceholder = document.createElement('span');
    moreSearchPlaceholder.className = 'more-sheet__search-placeholder';
    moreSearchPlaceholder.textContent = t('search.placeholder');
    const moreSearchKbd = document.createElement('kbd');
    moreSearchKbd.className = 'more-sheet__search-kbd';
    moreSearchKbd.textContent = '/';
    moreSearchKbd.setAttribute('aria-hidden', 'true');
    moreSearchBar.appendChild(moreSearchIcon);
    moreSearchBar.appendChild(moreSearchPlaceholder);
    moreSearchBar.appendChild(moreSearchKbd);
    moreSheet.appendChild(moreSearchBar);

    navItems().filter((i) => !i.kitchenGroup).slice(PRIMARY_NAV).forEach((item) => moreSheet.appendChild(moreItemEl(item)));
  }

  bottomNav.appendChild(bottomItems);

  const searchOverlay = document.createElement('div');
  searchOverlay.className = 'search-overlay';
  searchOverlay.id = 'search-overlay';
  searchOverlay.setAttribute('aria-hidden', 'true');
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

  const shellNodes = [skipLink, sidebar, main, bottomNav];
  if (backdrop)   shellNodes.push(backdrop);
  if (moreSheet)  shellNodes.push(moreSheet);
  shellNodes.push(searchOverlay, toastContainerPolite, toastContainerAssertive, routeAnnouncer);
  container.replaceChildren(...shellNodes);
  updateBranding(currentPath || '/');

  // Klick-Handler für alle Nav-Links
  container.querySelectorAll('[data-route]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(el.dataset.route);
    });
  });

  const openSearch = initSearch(container);
  initMoreSheet(container, openSearch);
  initNavHideOnScroll(container);
  initOfflineBanner();
  initKeyboardShortcuts();
  if (localStorage.getItem(SEARCH_KBD_KEY)) {
    document.documentElement.classList.add('search-kbd-done');
  }
}

const FAB_SEEN_KEY = 'oikos:fabSeenCount';
const FAB_SEEN_MAX = 5;
const SEARCH_KBD_KEY = 'oikos:searchKbdUsed';

const SHORTCUTS = [
  { key: '/',   description: () => t('shortcuts.search'),  action: () => {
    if (!localStorage.getItem(SEARCH_KBD_KEY)) {
      localStorage.setItem(SEARCH_KBD_KEY, '1');
      document.documentElement.classList.add('search-kbd-done');
    }
    document.getElementById('more-sheet-search')?.click();
  } },
  { key: 'n',   description: () => t('shortcuts.new'),     action: () => document.querySelector('.page-fab')?.click() },
  { key: '?',   description: () => t('shortcuts.help'),    action: () => showShortcutsModal() },
  { key: 'g d', description: () => t('shortcuts.goDash'),  action: () => navigate('/') },
  { key: 'g t', description: () => t('shortcuts.goTasks'), action: () => navigate('/tasks') },
  { key: 'g c', description: () => t('shortcuts.goCal'),   action: () => navigate('/calendar') },
  { key: 'g s', description: () => t('shortcuts.goShop'),  action: () => navigate('/shopping') },
  { key: 'g n', description: () => t('shortcuts.goNotes'),   action: () => navigate('/notes')              },
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

function showShortcutsModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  const panel = document.createElement('div');
  panel.className = 'modal-panel modal-panel--sm';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('shortcuts.help'));

  const rows = SHORTCUTS.map((s) => `
    <div class="shortcuts-row">
      <kbd class="shortcut-kbd">${esc(s.key)}</kbd>
      <span class="shortcut-desc">${esc(s.description())}</span>
    </div>
  `).join('');

  panel.insertAdjacentHTML('beforeend', `
    <div class="modal-panel__header">
      <span class="modal-panel__title">${esc(t('shortcuts.help'))}</span>
      <button class="modal-panel__close btn--ghost" aria-label="${esc(t('common.close'))}">
        <i data-lucide="x" style="width:16px;height:16px;" aria-hidden="true"></i>
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
  }
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

/**
 * Versteckt die Bottom-Nav beim Runterscrollen, zeigt sie beim Hochscrollen.
 * Nur auf Mobile aktiv (< 1024px), da auf Desktop die Sidebar fest sichtbar ist.
 */
function initNavHideOnScroll(container) {
  const content = container.querySelector('#main-content');
  const nav = container.querySelector('.nav-bottom');
  if (!content || !nav) return;

  let lastY = 0;

  const setNavHidden = (hidden) => {
    nav.classList.toggle('nav-bottom--hidden', hidden);
    document.documentElement.classList.toggle('nav-bottom--hidden', hidden);
  };

  content.addEventListener('scroll', () => {
    if (window.innerWidth >= 1024) {
      setNavHidden(false);
      return;
    }

    const y = content.scrollTop;
    if (y < 10) {
      setNavHidden(false);
    } else if (y > lastY + 4) {
      setNavHidden(true);
    } else if (y < lastY - 4) {
      setNavHidden(false);
    }
    lastY = y;
  }, { passive: true });
}

/**
 * Öffnet/schließt das More-Sheet und die Backdrop.
 */
function initMoreSheet(container, openSearch) {
  const moreBtn  = container.querySelector('#more-btn');
  const backdrop = container.querySelector('#more-backdrop');
  const sheet    = container.querySelector('#more-sheet');
  if (!moreBtn || !backdrop || !sheet) return;

  function openSheet() {
    sheet.setAttribute('aria-hidden', 'false');
    backdrop.classList.add('more-backdrop--visible');
    moreBtn.setAttribute('aria-expanded', 'true');
    if (window.lucide) window.lucide.createIcons();
  }

  function closeSheet() {
    sheet.setAttribute('aria-hidden', 'true');
    backdrop.classList.remove('more-backdrop--visible');
    moreBtn.setAttribute('aria-expanded', 'false');
  }

  moreBtn.addEventListener('click', () => {
    const isOpen = sheet.getAttribute('aria-hidden') === 'false';
    isOpen ? closeSheet() : openSheet();
  });

  backdrop.addEventListener('click', closeSheet);

  let _touchStartY = 0;
  sheet.addEventListener('touchstart', (e) => {
    _touchStartY = e.touches[0].clientY;
  }, { passive: true });
  sheet.addEventListener('touchend', (e) => {
    if (e.changedTouches[0].clientY - _touchStartY > 60) closeSheet();
  }, { passive: true });

  sheet.querySelectorAll('[data-route]').forEach((el) => {
    el.addEventListener('click', () => closeSheet());
  });

  const moreSearchBar = sheet.querySelector('#more-sheet-search');
  if (moreSearchBar && openSearch) {
    const triggerSearch = () => {
      // Sheet sofort (ohne Slide-Animation) schließen, damit nur eine Animation abläuft
      sheet.style.transition = 'none';
      closeSheet();
      requestAnimationFrame(() => { sheet.style.transition = ''; });
      openSearch();
    };
    moreSearchBar.addEventListener('click', triggerSearch);
    moreSearchBar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); triggerSearch(); }
    });
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

  function openSearch() {
    if (window._closeMoreSheet) window._closeMoreSheet();
    overlay.setAttribute('aria-hidden', 'false');
    overlay.classList.add('search-overlay--visible');
    setTimeout(() => input.focus(), 50);
    if (window.lucide) window.lucide.createIcons();

    const FOCUSABLE = 'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])';
    _searchTrapHandler = (e) => {
      if (e.key !== 'Tab') return;
      const focusable = Array.from(overlay.querySelectorAll(FOCUSABLE));
      if (!focusable.length) return;
      const first = focusable[0];
      const last  = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    };
    overlay.addEventListener('keydown', _searchTrapHandler);
  }

  function closeSearch() {
    overlay.setAttribute('aria-hidden', 'true');
    overlay.classList.remove('search-overlay--visible');
    if (_searchTrapHandler) {
      overlay.removeEventListener('keydown', _searchTrapHandler);
      _searchTrapHandler = null;
    }
    input.value = '';
    results.replaceChildren();
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
        // Fehler still ignorieren - kein Overlay-Crash
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
  const { tasks = [], events = [], notes = [], contacts = [], items = [] } = data;
  const total = tasks.length + events.length + notes.length + contacts.length + items.length;

  if (total === 0) {
    const empty = document.createElement('p');
    empty.className = 'search-overlay__empty';
    empty.textContent = t('search.noResults');
    container.appendChild(empty);
    return;
  }

  function makeSection(labelKey, items, routeFn) {
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
      title.textContent = item.title;
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
}

function navItems() {
  if (currentUser?.access_scope === 'split_guest') {
    return [
      { path: '/budget', label: t('splitExpenses.tabLabel'), icon: 'receipt-text', module: 'budget' },
    ];
  }
  const all = [
    { path: '/',          label: t('nav.dashboard'), icon: 'layout-dashboard', module: 'dashboard' },
    { path: '/calendar',  label: t('nav.calendar'),  icon: 'calendar',         module: 'calendar'  },
    { path: '/tasks',     label: t('nav.tasks'),     icon: 'check-square',     module: 'tasks'     },
    { path: '/notes',     label: t('nav.notes'),     icon: 'sticky-note',      module: 'notes'     },
    // More-Sheet Items:
    { path: '/birthdays', label: t('nav.birthdays'), icon: 'cake',             module: 'birthdays' },
    { path: '/contacts',  label: t('nav.contacts'),  icon: 'book-user',        module: 'contacts'  },
    { path: '/budget',    label: t('nav.budget'),    icon: 'wallet',           module: 'budget'    },
    { path: '/documents', label: t('nav.documents'), icon: 'folder-lock',      module: 'documents' },
    { path: '/housekeeping', label: t('nav.housekeeping'), icon: 'paintbrush', module: 'housekeeping' },
    { path: '/settings',  label: t('nav.settings'),  icon: 'settings',         module: 'settings'  },
    // Kitchen-Gruppe: via Küche-Nav-Button (Bottom-Nav + Sidebar) + kitchen-tabs-bar erreichbar
    { path: '/meals',     label: t('nav.meals'),     icon: 'utensils',      module: 'meals',    kitchenGroup: true },
    { path: '/recipes',   label: t('nav.recipes'),   icon: 'book-text',     module: 'recipes',  kitchenGroup: true },
    { path: '/shopping',  label: t('nav.shopping'),  icon: 'shopping-cart', module: 'shopping', kitchenGroup: true },
  ];
  return all.filter((item) => !_disabledModules.has(item.module));
}

function isModuleDisabled(moduleName) {
  return _disabledModules.has(moduleName);
}

function setDisabledModules(modules) {
  _disabledModules = new Set(Array.isArray(modules) ? modules : []);
  rebuildNavigation();
}

function navItemEl({ path, label, icon }) {
  const a = document.createElement('a');
  a.href = path;
  a.dataset.route = path;
  a.className = 'nav-item';
  a.setAttribute('aria-label', label);
  a.setAttribute('title', label);
  const i = document.createElement('i');
  i.dataset.lucide = icon;
  i.className = 'nav-item__icon';
  i.setAttribute('aria-hidden', 'true');
  const span = document.createElement('span');
  span.className = 'nav-item__label';
  span.textContent = label;
  a.appendChild(i);
  a.appendChild(span);
  return a;
}

function sidebarKitchenEl() {
  const a = document.createElement('a');
  a.href = '/meals';
  a.id = 'sidebar-kitchen-nav';
  a.className = 'nav-item';
  a.setAttribute('aria-label', t('nav.kitchen'));
  a.setAttribute('title', t('nav.kitchen'));
  const icon = document.createElement('i');
  icon.dataset.lucide = 'utensils';
  icon.className = 'nav-item__icon';
  icon.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'nav-item__label';
  label.textContent = t('nav.kitchen');
  a.appendChild(icon);
  a.appendChild(label);
  a.addEventListener('click', (e) => {
    e.preventDefault();
    navigate(getLastKitchenRoute());
  });
  return a;
}

function moreItemEl({ path, label, icon }) {
  const a = document.createElement('a');
  a.href = path;
  a.dataset.route = path;
  a.className = 'more-item';
  const i = document.createElement('i');
  i.dataset.lucide = icon;
  i.className = 'more-item__icon';
  i.setAttribute('aria-hidden', 'true');
  const span = document.createElement('span');
  span.className = 'more-item__label';
  span.textContent = label;
  a.appendChild(i);
  a.appendChild(span);
  return a;
}

/**
 * Aktiven Nav-Link hervorheben und More-Button als aktiv markieren
 * wenn die aktive Route im More-Sheet liegt.
 */
function updateNav(path) {
  document.querySelectorAll('[data-route]').forEach((el) => {
    el.removeAttribute('aria-current');
    if (el.dataset.route === path) {
      el.setAttribute('aria-current', 'page');
    }
  });

  const kitchenNavBtn = document.querySelector('#kitchen-btn');
  if (kitchenNavBtn) {
    const isKitchen = isKitchenRoute(path);
    kitchenNavBtn.classList.toggle('nav-item--active', isKitchen);
    kitchenNavBtn.toggleAttribute('aria-current', isKitchen);
  }

  const sidebarKitchenNav = document.querySelector('#sidebar-kitchen-nav');
  if (sidebarKitchenNav) {
    if (isKitchenRoute(path)) {
      sidebarKitchenNav.setAttribute('aria-current', 'page');
    } else {
      sidebarKitchenNav.removeAttribute('aria-current');
    }
  }

  const moreBtn = document.querySelector('#more-btn');
  if (moreBtn) {
    const secondaryItems = navItems().filter((i) => !i.kitchenGroup).slice(PRIMARY_NAV);
    const activeSecondary = secondaryItems.find((n) => n.path === path);
    const inMoreSheet = !!activeSecondary;

    moreBtn.classList.toggle('nav-item--active', inMoreSheet);
    moreBtn.toggleAttribute('aria-current', inMoreSheet);

    const moreBtnLabel = moreBtn.querySelector('.nav-item__label');
    const moreBtnIcon  = moreBtn.querySelector('.nav-item__icon');

    if (moreBtnLabel) {
      moreBtnLabel.textContent = activeSecondary ? activeSecondary.label : t('nav.more');
    }
    if (moreBtnIcon) {
      moreBtnIcon.dataset.lucide = activeSecondary ? activeSecondary.icon : 'grid-2x2';
    }
  }

  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function renderError(container, err) {
  const state = document.createElement('div');
  state.className = 'empty-state';
  const title = document.createElement('div');
  title.className = 'empty-state__title';
  title.textContent = t('common.errorOccurred');
  const desc = document.createElement('div');
  desc.className = 'empty-state__description';
  desc.textContent = err.message;
  const btn = document.createElement('button');
  btn.className = 'btn btn--primary';
  btn.id = 'error-reload-btn';
  btn.textContent = t('common.reload');
  btn.addEventListener('click', () => location.reload());
  state.append(title, desc, btn);
  container.replaceChildren(state);
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
const TOAST_SUCCESS_KEY = 'oikos:toastSuccessCount';
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
  if (!navigator.onLine) return t('common.errorOffline');
  const status = err?.status ?? err?.response?.status;
  if (status === 403) return t('common.errorForbidden');
  if (status === 404) return t('common.errorNotFound');
  if (status >= 500) return t('common.errorServer');
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return t('common.errorTimeout');
  return err?.data?.error || err?.message || t('common.errorGeneric');
}

// --------------------------------------------------------
// Globale Fehler-Handler (Error Boundary)
// --------------------------------------------------------

window.addEventListener('error', (e) => {
  // Ressource-Ladefehler (z.B. fehlgeschlagenes Bild): ignorieren
  if (e.target && e.target !== window) return;
  console.error('[Oikos] Unbehandelter Fehler:', e.error ?? e.message);
  showToast(t('common.unexpectedError'), 'danger');
});

window.addEventListener('unhandledrejection', (e) => {
  // Auth-Fehler werden bereits von auth:expired behandelt
  if (e.reason?.status === 401) return;
  console.error('[Oikos] Unbehandeltes Promise-Rejection:', e.reason);
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
  stopReminders();
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

  const kitchenVisible = ['meals', 'recipes', 'shopping'].some((m) => !_disabledModules.has(m));

  if (navSidebarItems) {
    const sidebarEls = [];
    navItems()
      .filter((item) => !item.kitchenGroup)
      .forEach((item) => {
        sidebarEls.push(navItemEl(item));
        if (item.path === '/calendar' && kitchenVisible) sidebarEls.push(sidebarKitchenEl());
      });
    navSidebarItems.replaceChildren(...sidebarEls);
    if (window.lucide) window.lucide.createIcons({ el: navSidebarItems });
  }
  if (bottomItems) {
    const kitchenBtnEl = bottomItems.querySelector('#kitchen-btn');
    const moreBtn      = bottomItems.querySelector('#more-btn');
    if (kitchenBtnEl) {
      kitchenBtnEl.querySelector('.nav-item__label').textContent = t('nav.kitchen');
      kitchenBtnEl.hidden = !kitchenVisible;
    }
    const newItems = navItems().slice(0, PRIMARY_NAV).map(navItemEl);
    const tail = [kitchenBtnEl, moreBtn].filter(Boolean);
    bottomItems.replaceChildren(...newItems, ...tail);
  }
  if (moreSheet) {
    const handle = moreSheet.querySelector('.more-sheet__handle');
    const searchBar = moreSheet.querySelector('#more-sheet-search');
    if (searchBar) {
      const placeholder = searchBar.querySelector('.more-sheet__search-placeholder');
      if (placeholder) placeholder.textContent = t('search.placeholder');
      searchBar.setAttribute('aria-label', t('search.placeholder'));
    }
    const newMoreItems = navItems().filter((i) => !i.kitchenGroup).slice(PRIMARY_NAV).map(moreItemEl);
    moreSheet.replaceChildren(handle, ...(searchBar ? [searchBar] : []), ...newMoreItems);
  }

  document.querySelectorAll('[data-route]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(el.dataset.route);
    });
  });

  updateNav(currentPath);
  updateBranding(currentPath || '/');
}

// Sprache geändert: Navigation neu rendern damit Labels aktualisiert werden
window.addEventListener('locale-changed', () => rebuildNavigation());

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
    // Vorab-Theme-Anwendung ohne Abhängigkeit von window.oikos
    const stored = localStorage.getItem('oikos-theme');
    if (stored === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else if (stored === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    
    await initI18n();
    navigate(location.pathname, false);
  } catch (err) {
    console.error('[Router] Initialisierung fehlgeschlagen:', err);
    const loading = document.getElementById('app-loading');
    if (loading) loading.hidden = true;
    renderError(document.getElementById('app'), err);
  }
})();

// Globale Exporte
window.oikos = {
  navigate,
  showToast,
  friendlyError,
  setThemeColor,
  setDisabledModules,
  isModuleDisabled,
  applyTheme: (value) => {
    localStorage.setItem('oikos-theme', value);
    if (value === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else if (value === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  },
  restoreThemeColor: () => {
    const route = ROUTES.find((r) => r.path === currentPath);
    updateThemeColorForRoute(route);
  },
};
