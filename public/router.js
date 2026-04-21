/**
 * Modul: Client-Side Router
 * Zweck: SPA-Routing über History API ohne Framework, Auth-Guard, Seiten-Übergänge
 * Abhängigkeiten: api.js
 */

import { api, auth } from '/api.js';
import { initI18n, getLocale, t } from '/i18n.js';
import { init as initReminders, stop as stopReminders } from '/reminders.js';

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
  { path: '/notes',    page: '/pages/notes.js',     requiresAuth: true, module: 'notes'     },
  { path: '/recipes',  page: '/pages/recipes.js',   requiresAuth: true, module: 'recipes'   },
  { path: '/contacts', page: '/pages/contacts.js',  requiresAuth: true, module: 'contacts'  },
  { path: '/budget',   page: '/pages/budget.js',    requiresAuth: true, module: 'budget'    },
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
// Gesetzt wenn auth:expired waehrend einer laufenden Navigation feuert.
// Die Weiterleitung zu /login wird nach Abschluss der Navigation nachgeholt.
let _pendingLoginRedirect = false;

// --------------------------------------------------------
// Router
// --------------------------------------------------------

const ROUTE_ORDER = ['/', '/tasks', '/calendar', '/meals', '/recipes', '/shopping',
                     '/notes', '/contacts', '/budget', '/settings'];

const PRIMARY_NAV = 4;

function getDirection(fromPath, toPath) {
  const fromIdx = ROUTE_ORDER.indexOf(fromPath ?? '/');
  const toIdx   = ROUTE_ORDER.indexOf(toPath);
  if (fromIdx === -1 || toIdx === -1 || fromPath === toPath) return 'right';
  return toIdx > fromIdx ? 'right' : 'left';
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
      initReminders();
    } else {
      pushState = userOrPushState;
    }

    // Alten Pfad merken, bevor currentPath aktualisiert wird - für Richtungsberechnung
    const previousPath = currentPath;
    const basePath = path.split('?')[0];
    currentPath = basePath;

    const route = ROUTES.find((r) => r.path === basePath) ?? ROUTES.find((r) => r.path === '/');

    // Auth-Guard
    if (route.requiresAuth && !currentUser) {
      try {
        const result = await auth.me();
        currentUser = result.user;
        initReminders();
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
    const outClass  = direction === 'right' ? 'page-transition--out-left' : 'page-transition--out-right';
    const inClass   = direction === 'right' ? 'page-transition--in-right' : 'page-transition--in-left';

    // Performance: backdrop-filter während Übergang deaktivieren (Android-Optimierung).
    // glass.css setzt alle backdrop-filter im app-content auf none solange diese Klasse aktiv ist.
    document.documentElement.classList.add('navigating');

    // Alte Seite kurz ausfaden, falls vorhanden
    const oldPage = content.querySelector('.page-transition');
    if (oldPage) {
      oldPage.classList.add(outClass);
      await new Promise(r => setTimeout(r, 120));
    }

    // Alter Inhalt ist jetzt weg - altes Stylesheet kann entfernt werden
    const pageWrapper = document.createElement('div');
    pageWrapper.className = 'page-transition';
    pageWrapper.style.opacity = '0';
    content.replaceChildren(pageWrapper);
    style.cleanup();

    await module.render(pageWrapper, { user: currentUser });

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
  const skipLink = document.createElement('a');
  skipLink.href = '#main-content';
  skipLink.className = 'sr-only';
  skipLink.textContent = t('common.skipToContent');

  const sidebar = document.createElement('nav');
  sidebar.className = 'nav-sidebar';
  sidebar.setAttribute('aria-label', t('nav.main'));
  const sidebarLogo = document.createElement('div');
  sidebarLogo.className = 'nav-sidebar__logo';
  const sidebarLogoSpan = document.createElement('span');
  sidebarLogoSpan.textContent = 'Oikos';
  sidebarLogo.appendChild(sidebarLogoSpan);
  const sidebarItems = document.createElement('div');
  sidebarItems.className = 'nav-sidebar__items';
  sidebarItems.setAttribute('role', 'list');
  navItems().forEach((item) => sidebarItems.appendChild(navItemEl(item)));
  sidebar.appendChild(sidebarLogo);
  sidebar.appendChild(sidebarItems);

  const main = document.createElement('main');
  main.className = 'app-content';
  main.id = 'main-content';
  main.setAttribute('aria-live', 'polite');

  const bottomNav = document.createElement('nav');
  bottomNav.className = 'nav-bottom';
  bottomNav.setAttribute('aria-label', t('nav.navigation'));
  const bottomItems = document.createElement('div');
  bottomItems.className = 'nav-bottom__items';
  navItems().slice(0, PRIMARY_NAV).forEach((item) => bottomItems.appendChild(navItemEl(item)));
  const moreBtn = document.createElement('button');
  moreBtn.className = 'nav-item nav-item--more';
  moreBtn.id = 'more-btn';
  moreBtn.setAttribute('aria-label', t('nav.more'));
  moreBtn.setAttribute('aria-expanded', 'false');
  const moreBtnIcon = document.createElement('i');
  moreBtnIcon.dataset.lucide = 'grid-2x2';
  moreBtnIcon.className = 'nav-item__icon';
  moreBtnIcon.setAttribute('aria-hidden', 'true');
  const moreBtnLabel = document.createElement('span');
  moreBtnLabel.className = 'nav-item__label';
  moreBtnLabel.textContent = t('nav.more');
  moreBtn.appendChild(moreBtnIcon);
  moreBtn.appendChild(moreBtnLabel);
  bottomItems.appendChild(moreBtn);
  bottomNav.appendChild(bottomItems);

  const backdrop = document.createElement('div');
  backdrop.className = 'more-backdrop';
  backdrop.id = 'more-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');

  const moreSheet = document.createElement('div');
  moreSheet.className = 'more-sheet';
  moreSheet.id = 'more-sheet';
  moreSheet.setAttribute('role', 'dialog');
  moreSheet.setAttribute('aria-label', t('nav.more'));
  moreSheet.setAttribute('aria-hidden', 'true');
  const searchBtn = document.createElement('button');
  searchBtn.className = 'more-item';
  searchBtn.id = 'search-btn';
  const searchIcon = document.createElement('i');
  searchIcon.dataset.lucide = 'search';
  searchIcon.className = 'more-item__icon';
  searchIcon.setAttribute('aria-hidden', 'true');
  const searchLabel = document.createElement('span');
  searchLabel.className = 'more-item__label';
  searchLabel.textContent = t('search.title');
  searchBtn.appendChild(searchIcon);
  searchBtn.appendChild(searchLabel);
  moreSheet.appendChild(searchBtn);
  navItems().slice(PRIMARY_NAV).forEach((item) => moreSheet.appendChild(moreItemEl(item)));

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

  const toastContainer = document.createElement('div');
  toastContainer.className = 'toast-container';
  toastContainer.id = 'toast-container';
  toastContainer.setAttribute('aria-live', 'assertive');

  container.replaceChildren(skipLink, sidebar, main, bottomNav, backdrop, moreSheet, searchOverlay, toastContainer);

  // Klick-Handler für alle Nav-Links
  container.querySelectorAll('[data-route]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(el.dataset.route);
    });
  });

  initMoreSheet(container);
  initNavHideOnScroll(container);
  initSearch(container);
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

  content.addEventListener('scroll', () => {
    if (window.innerWidth >= 1024) return;

    const y = content.scrollTop;
    if (y < 10) {
      nav.classList.remove('nav-bottom--hidden');
    } else if (y > lastY + 4) {
      nav.classList.add('nav-bottom--hidden');
    } else if (y < lastY - 4) {
      nav.classList.remove('nav-bottom--hidden');
    }
    lastY = y;
  }, { passive: true });
}

/**
 * Öffnet/schließt das More-Sheet und die Backdrop.
 */
function initMoreSheet(container) {
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

  sheet.querySelectorAll('[data-route]').forEach((el) => {
    el.addEventListener('click', () => closeSheet());
  });

  window._closeMoreSheet = closeSheet;
}

/**
 * Initialisiert die Suchfunktion (Overlay + API-Calls).
 */
function initSearch(container) {
  const searchBtn    = container.querySelector('#search-btn');
  const searchClose  = container.querySelector('#search-close');
  const overlay      = container.querySelector('#search-overlay');
  const input        = container.querySelector('#search-input');
  const results      = container.querySelector('#search-results');
  if (!searchBtn || !overlay || !input || !results) return;

  function openSearch() {
    if (window._closeMoreSheet) window._closeMoreSheet();
    overlay.setAttribute('aria-hidden', 'false');
    overlay.classList.add('search-overlay--visible');
    setTimeout(() => input.focus(), 50);
    if (window.lucide) window.lucide.createIcons();
  }

  function closeSearch() {
    overlay.setAttribute('aria-hidden', 'true');
    overlay.classList.remove('search-overlay--visible');
    input.value = '';
    results.replaceChildren();
  }

  searchBtn.addEventListener('click', openSearch);
  searchClose.addEventListener('click', closeSearch);

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
}

/**
 * Rendert Suchergebnisse in den Ergebnis-Container.
 */
function renderSearchResults(container, data, onClose) {
  container.replaceChildren();
  const { tasks = [], events = [], notes = [] } = data;
  const total = tasks.length + events.length + notes.length;

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

  makeSection('nav.tasks',    tasks,  (i) => `/tasks?open=${i.id}`);
  makeSection('nav.calendar', events, ()  => '/calendar');
  makeSection('nav.notes',    notes,  (i) => `/notes?open=${i.id}`);
}

function navItems() {
  return [
    { path: '/',         label: t('nav.dashboard'), icon: 'layout-dashboard' },
    { path: '/tasks',    label: t('nav.tasks'),     icon: 'check-square'     },
    { path: '/calendar', label: t('nav.calendar'),  icon: 'calendar'         },
    { path: '/meals',    label: t('nav.meals'),     icon: 'utensils'         },
    { path: '/recipes',  label: t('nav.recipes'),   icon: 'book-open-text'   },
    { path: '/shopping', label: t('nav.shopping'),  icon: 'shopping-cart'    },
    { path: '/notes',    label: t('nav.notes'),     icon: 'sticky-note'      },
    { path: '/contacts', label: t('nav.contacts'),  icon: 'book-user'        },
    { path: '/budget',   label: t('nav.budget'),    icon: 'wallet'           },
    { path: '/settings', label: t('nav.settings'),  icon: 'settings'         },
  ];
}

function navItemEl({ path, label, icon }) {
  const a = document.createElement('a');
  a.href = path;
  a.dataset.route = path;
  a.className = 'nav-item';
  a.setAttribute('role', 'listitem');
  a.setAttribute('aria-label', label);
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

  const moreBtn = document.querySelector('#more-btn');
  if (moreBtn) {
    const inMoreSheet = navItems().slice(PRIMARY_NAV).some((n) => n.path === path);
    moreBtn.classList.toggle('nav-item--active', inMoreSheet);
    moreBtn.toggleAttribute('aria-current', inMoreSheet);
  }

  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function renderError(container, err) {
  container.innerHTML = `
    <div class="empty-state">
      <div class="empty-state__title">${t('common.errorOccurred')}</div>
      <div class="empty-state__description">${err.message}</div>
      <button class="btn btn--primary" id="error-reload-btn">${t('common.reload')}</button>
    </div>
  `;
  container.querySelector('#error-reload-btn')?.addEventListener('click', () => location.reload());
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
const TOAST_ICONS = {
  success: '<svg class="toast__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
  danger:  '<svg class="toast__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  warning: '<svg class="toast__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
};

function showToast(message, type = 'default', duration = 3000, onUndo = null) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  // Max. 3 gleichzeitige Toasts: ältesten entfernen falls Limit erreicht
  const existing = container.querySelectorAll('.toast');
  if (existing.length >= 3) existing[0].remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type !== 'default' ? `toast--${type}` : ''}`;
  toast.setAttribute('role', 'alert');

  // Icon: statische SVGs aus TOAST_ICONS (kein User-Input, kein XSS-Risiko)
  const icon = TOAST_ICONS[type] || '';
  const span = document.createElement('span');
  span.textContent = message;
  toast.innerHTML = icon; // eslint-disable-line no-unsanitized/property -- static SVG only
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
}

// --------------------------------------------------------
// Event-Listener
// --------------------------------------------------------

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
  const msg = e.reason?.message || t('common.errorGeneric');
  showToast(msg, 'danger');
  e.preventDefault(); // Konsolenfehler unterdrücken (bereits geloggt)
});

// SW-Update: neue Version im Hintergrund installiert → Toast anzeigen
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'SW_UPDATED') {
      // Modul-Cache leeren damit nächste Navigation frische Module lädt
      moduleCache.clear();
      showToast(t('common.updateAvailable'), 'default', 8000);
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

// Sprache geändert: Navigation neu rendern damit Labels aktualisiert werden
window.addEventListener('locale-changed', () => {
  const skipLink     = document.querySelector('.sr-only[href="#main-content"]');
  const navSidebar   = document.querySelector('.nav-sidebar');
  const navSidebarItems = document.querySelector('.nav-sidebar__items');
  const navBottom    = document.querySelector('.nav-bottom');
  const bottomItems  = document.querySelector('.nav-bottom__items');
  const moreSheet    = document.querySelector('#more-sheet');
  const moreBtnLabel = document.querySelector('#more-btn .nav-item__label');

  if (skipLink)     skipLink.textContent = t('common.skipToContent');
  if (navSidebar)   navSidebar.setAttribute('aria-label', t('nav.main'));
  if (navBottom)    navBottom.setAttribute('aria-label', t('nav.navigation'));
  if (moreBtnLabel) moreBtnLabel.textContent = t('nav.more');

  if (navSidebarItems) {
    navSidebarItems.replaceChildren(...navItems().map(navItemEl));
  }
  if (bottomItems) {
    const moreBtn = bottomItems.querySelector('#more-btn');
    const newItems = navItems().slice(0, PRIMARY_NAV).map(navItemEl);
    bottomItems.replaceChildren(...newItems, moreBtn);
  }
  if (moreSheet) {
    const searchBtn = moreSheet.querySelector('#search-btn');
    const searchLbl = searchBtn?.querySelector('.more-item__label');
    if (searchLbl) searchLbl.textContent = t('search.title');
    const newMoreItems = navItems().slice(PRIMARY_NAV).map(moreItemEl);
    moreSheet.replaceChildren(searchBtn, ...newMoreItems);
  }

  document.querySelectorAll('[data-route]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(el.dataset.route);
    });
  });

  updateNav(currentPath);
});

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
  await initI18n();
  navigate(location.pathname, false);
})();

// Globale Exporte
window.oikos = {
  navigate,
  showToast,
  setThemeColor,
  restoreThemeColor: () => {
    const route = ROUTES.find((r) => r.path === currentPath);
    updateThemeColorForRoute(route);
  },
};
