/**
 * Modul: Client-Side Router
 * Zweck: SPA-Routing über History API ohne Framework, Auth-Guard, Seiten-Übergänge
 * Abhängigkeiten: api.js
 */

import { api, auth } from '/api.js';
import { canAccessNavModule, navModuleAccess, setExtensionNavMap } from '/permissions.js';
import { setExtensionModules, selectThirdPartyModuleList } from '/utils/extension-widgets.js';
import { initExtensionI18n, moduleDisplayLabel, reloadExtensionLocales } from '/utils/extension-i18n.js';
import { clearApiCache } from '/sw-register.js';
import { forgetLayoutHint } from '/utils/dashboard-layout-hint.js';
import { initI18n, getLocale, t, formatDate, formatTime } from '/i18n.js';
import { esc } from '/utils/html.js';
import { emptyHintEl, emptyStateEl } from '/utils/empty-state.js';
import { wireScrollFade, wireCollapsingHeader, wireSwipeToDismiss } from '/utils/ux.js';
import { TOAST_SURFACES, toastSurface } from '/utils/toast-surface.js';
import { BULK_PILL_LAYER, clearBulkPill } from '/utils/bulk-pill.js';
import { COMPOSITION_MODES } from '/utils/page-layout.js';
import { init as initReminders, stop as stopReminders } from '/reminders.js';
import { initPush, stopPush } from '/push.js';
import { numberLocaleFor } from '/settings/region-presets.js';
import { setDisplayTimeZone } from '/utils/timezone.js';
import { isKitchenRoute, getLastKitchenRoute } from '/utils/kitchen-tabs.js';
import { moduleAccentToken, moduleAccentVar } from '/utils/module-accent.js';
import { getLastHealthRoute, HEALTH_ROUTES } from '/utils/health-tabs.js';
import { activityType } from '/utils/health-activity.js';
import { buildHelpRows } from '/utils/help.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import {
  handleBackNavigation, closeAllOverlays, consumeOverlayMarker,
  pushOverlay, dropOverlay, attachOverlay,
} from '/utils/overlay-history.js';
import {
  applyNavBadges, setNavBadge, resetNavBadges, navBadgeRoutes,
  moduleCountsFrom, navBadgeCountsFrom,
} from '/utils/nav-badges.js';
import { isNewerVersion, displayVersion, releasesNewForMe } from '/utils/version.js';
import { setMaxUploadBytes } from '/utils/upload-limit.js';
import { syncWallMode } from '/utils/wall-mode.js';
import {
  rememberScrollPosition,
  scrollPositionFor,
  forgetScrollPositions,
} from '/utils/scroll-restore.js';
import { openModal, confirmModal } from '/components/modal.js';
import '/components/datepicker.js';
import { NAV_ICONS, MODULE_ICON, moduleIconEl } from '/nav-icons.js';
import { RENAMED_SETTINGS_SOURCE_PATHS, SETTINGS_LEAVES } from '/settings/registry.js';
import {
  NAV_SECTION,
  resolveMobileNavOrder,
  sortNavigationItems,
} from '/settings/module-order.js';

// --------------------------------------------------------
// Routen-Definitionen
// Jede Route hat: path, page (dynamisch geladen), requiresAuth, module (für theme-color),
// titleKey (Locale-Key für den Dokumenttitel).
//
// WARUM DER TITEL HIER STEHT UND NICHT IN EINER ZWEITEN LISTE: er stand einmal
// daneben, in einer Map in routeTitle(). Die Liste wuchs, die Map nicht, und
// /forgot-password, /reset-password und /join lieferten „Yuvomi · Yuvomi" -
// WCAG 2.4.2 ist Level A, und es traf ausgerechnet die drei Wege, über die ein
// neues Familienmitglied hereinkommt (Audit 2026-08-08, P1-2). Eine Route ohne
// Titel soll auffallen, nicht still auf den App-Namen fallen; der Guard in
// test-frontend-audit.js prüft die Vollständigkeit gegen genau diese Tabelle.
//
// `titleKey: null` ist eine ERKLÄRTE Entscheidung, kein Loch: auf dem Anmelde-
// und dem Einrichtungsbildschirm IST der App-Name der Titel (siehe
// updateBranding) - dort steht noch keine Seite, auf die er sich beziehen könnte.
// --------------------------------------------------------
const ROUTES = [
  { path: '/login',    page: '/pages/login.js',    requiresAuth: false, module: null,        titleKey: null },
  { path: '/setup',    page: '/pages/setup.js',    requiresAuth: false, module: null,        titleKey: null },
  { path: '/forgot-password', page: '/pages/forgot-password.js', requiresAuth: false, module: null, titleKey: 'forgotPassword.title' },
  { path: '/reset-password',  page: '/pages/reset-password.js',  requiresAuth: false, module: null, titleKey: 'resetPassword.title' },
  { path: '/join',     page: '/pages/join.js',     requiresAuth: false, module: null,        titleKey: 'join.title' },
  { path: '/',         page: '/pages/dashboard.js', requiresAuth: true, module: 'dashboard', titleKey: 'dashboard.title' },
  { path: '/tasks',    page: '/pages/tasks.js',     requiresAuth: true, module: 'tasks',     titleKey: 'nav.tasks' },
  { path: '/shopping', page: '/pages/shopping.js',  requiresAuth: true, module: 'shopping',  titleKey: 'nav.shopping' },
  { path: '/meals',    page: '/pages/meals.js',     requiresAuth: true, module: 'meals',     titleKey: 'nav.meals' },
  { path: '/calendar', page: '/pages/calendar.js',  requiresAuth: true, module: 'calendar',  titleKey: 'nav.calendar' },
  { path: '/birthdays', page: '/pages/birthdays.js', requiresAuth: true, module: 'birthdays', titleKey: 'nav.birthdays' },
  { path: '/notes',    page: '/pages/notes.js',     requiresAuth: true, module: 'notes',     titleKey: 'nav.notes' },
  { path: '/recipes',  page: '/pages/recipes.js',   requiresAuth: true, module: 'recipes',   titleKey: 'nav.recipes' },
  { path: '/pantry',   page: '/pages/pantry.js',    requiresAuth: true, module: 'pantry',    titleKey: 'nav.pantry' },
  { path: '/inventory', page: '/pages/inventory.js', requiresAuth: true, module: 'inventory', titleKey: 'nav.inventory' },
  { path: '/schedule', page: '/pages/schedule.js', requiresAuth: true, module: 'schedule', titleKey: 'nav.schedule' },
  { path: '/contacts', page: '/pages/contacts.js',  requiresAuth: true, module: 'contacts',  titleKey: 'nav.contacts' },
  { path: '/budget',   page: '/pages/budget.js',    requiresAuth: true, module: 'budget',    titleKey: 'nav.budget' },
  { path: '/documents', page: '/pages/documents.js', requiresAuth: true, module: 'documents', titleKey: 'nav.documents' },
  { path: '/housekeeping', page: '/pages/housekeeping.js', requiresAuth: true, module: 'housekeeping', titleKey: 'nav.housekeeping' },
  { path: '/waste', page: '/pages/waste.js', requiresAuth: true, module: 'waste', titleKey: 'nav.waste' },
  { path: '/rewards',  page: '/pages/rewards.js',    requiresAuth: true, module: 'rewards',   titleKey: 'nav.rewards' },
];

// Settings ist eine Sektion mit einer Wurzel und je einer exakten Route pro
// Blatt (Leaf). Die Routen werden aus der Registry abgeleitet, damit es keine
// doppelten Pfad-Definitionen gibt.
// Beide Sektionen führen EINEN Titel über alle Blätter: das Blatt ist eine
// Sicht innerhalb der Sektion, kein eigener Ort - dieselbe Begründung, aus der
// beide auch nur einen `module:`-Wert tragen.
const SETTINGS_ROUTES = [
  { path: '/settings', page: '/pages/settings.js', requiresAuth: true, module: 'settings', titleKey: 'nav.settings' },
  ...SETTINGS_LEAVES.map(({ path }) => ({ path, page: '/pages/settings.js', requiresAuth: true, module: 'settings', titleKey: 'nav.settings' })),
  // Vom IA-Umbau verschobene Blätter: als Route registriert, damit ein alter
  // Bookmark überhaupt matcht. settings.js leitet dann auf den neuen Pfad um.
  ...RENAMED_SETTINGS_SOURCE_PATHS.map((path) => ({ path, page: '/pages/settings.js', requiresAuth: true, module: 'settings', titleKey: 'nav.settings' })),
];

ROUTES.push(...SETTINGS_ROUTES);

// Gesundheit ist — wie Settings — eine Sektion mit einer Wurzel (/health) und je
// einer exakten Route pro Sub-Tab. Alle Routen laden dasselbe Seitenmodul; die
// Soft-Navigation zwischen den Tabs läuft über dessen update()-Funktion.
const HEALTH_PAGE_ROUTES = HEALTH_ROUTES.map((path) => ({
  path, page: '/pages/health.js', requiresAuth: true, module: 'health', titleKey: 'nav.health',
}));

ROUTES.push(...HEALTH_PAGE_ROUTES);

// --------------------------------------------------------
// Standalone-Modus: Dynamische theme-color Anpassung
// Statusbar-Farbe spiegelt aktuelle Seite / Modal-State wider
// --------------------------------------------------------
const isStandalone = window.matchMedia('(display-mode: standalone)').matches
  || navigator.standalone === true;

/**
 * System-Farbschema als langlebige MediaQueryList. Bewusst ein Modul-Binding
 * und kein `window.matchMedia(...).addEventListener(...)` in einem Rutsch: ohne
 * gehaltene Referenz darf die Engine die Liste einsammeln, und der Listener
 * verstummt irgendwann still. Genutzt vom Auto-Modus-Nachzug des Modul-Akzents.
 */
const darkSchemeQuery = window.matchMedia?.('(prefers-color-scheme: dark)') ?? null;

/**
 * Setzt die theme-color Meta-Tags (Light + Dark Variante).
 * @param {string} lightColor
 * @param {string} [darkColor] - Falls nicht angegeben, wird lightColor für beide gesetzt
 */
function setThemeColor(lightColor, darkColor) {
  if (!isStandalone) return;
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  const dark = darkColor || lightColor;

  // DIE METAS FOLGEN DEM SYSTEM, DIE APP FOLGT DER WAHL DES NUTZERS.
  //
  // Die beiden `<meta name="theme-color">` in index.html tragen ein
  // `media="(prefers-color-scheme: …)"`; welche davon gilt, entscheidet also das
  // BETRIEBSSYSTEM. Die App entscheidet es ueber `data-theme` auf <html>. Wer in
  // der installierten PWA auf einem hellen System ausdruecklich Dunkel waehlt,
  // bekam deshalb eine helle Statusbar ueber einer dunklen Seite - und
  // umgekehrt. Ein erneuter Aufruf half nicht: er schrieb dasselbe Paar noch
  // einmal, und die Auswahl davon blieb dieselbe.
  //
  // Bei ausdruecklicher Wahl tragen deshalb BEIDE Metas die aktive Farbe; dann
  // ist gleichgueltig, welche der Browser nimmt. Nur im Automatik-Modus (kein
  // `data-theme`) bleibt das Paar ein Paar - dort ist das System die richtige
  // Quelle.
  const forced = document.documentElement.getAttribute('data-theme');
  const [first, second] = forced === 'dark' ? [dark, dark]
    : forced === 'light' ? [lightColor, lightColor]
      : [lightColor, dark];

  if (metas.length >= 2) {
    metas[0].setAttribute('content', first);
    metas[1].setAttribute('content', second);
  } else if (metas.length === 1) {
    metas[0].setAttribute('content', first);
  }
}

/** Liest eine CSS Custom Property vom :root */
function getCSSToken(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Setzt den Modul-Akzent der Route als Inline-Custom-Property auf <html>.
 *
 * Der Wert ist die AUFGELÖSTE Farbe, keine `var(--module-*)`-Kette: Dritt-
 * anbieter-Module liefern einen literalen Hex-Wert, und ein nicht existierendes
 * `--module-<name>` würde als var()-Kette „invalid at computed-value time"
 * enden statt in den CSS-Fallback `var(--color-accent)` zu laufen.
 *
 * Preis dieser Auflösung: der Inline-Wert ist eine Momentaufnahme des aktuellen
 * Themes. `--module-tasks` wechselt im Dark-Theme von #15803D auf #4ADE80 - die
 * Momentaufnahme tut das nicht. Deshalb MUSS jeder Theme-Wechsel diese Funktion
 * erneut aufrufen (applyTheme + der prefers-color-scheme-Listener für den
 * Auto-Modus), sonst behält die ganze Shell den Akzent des alten Themes und
 * Text darauf fiel im Dunkelmodus auf 2.71:1 statt 7.81:1 - unter WCAG AA.
 */
function applyModuleAccentForRoute(route) {
  const accentToken = moduleAccentToken(route?.module);
  const accent = route?.thirdPartyModule?.accent || (accentToken ? getCSSToken(accentToken) : '');
  document.documentElement.style.setProperty('--active-module-accent', accent);
}

/**
 * Setzt theme-color - app-weit auf den Seitengrund, NICHT pro Modul.
 *
 * Bis zum HIG-Rollout trug die Statusbar der installierten PWA den vollen
 * Modul-Tint. In der neuen Welt ist das Chrome direkt darunter neutral
 * (--color-bg, Toolbar ohne Akzentstreifen), der satte Ton darüber war damit
 * eine sichtbare Naht und der lauteste Ton im Bild. Entscheidung von Ulas am
 * 2026-08-06: vereinheitlichen. Die Modul-Identität tragen weiter Nav-Icons,
 * Segmente, Chips und der FAB.
 *
 * Dieselben Werte wie die statischen theme-color-Metas in index.html und
 * offline.html, und dieselben wie `--color-bg` in tokens.css; sie gelten auch
 * für den modullosen Fall (Login, Setup, Join). Fremdmodule mit eigenem Akzent
 * behalten ihre Farbe - ihre Seiten sind nicht Teil dieser Welt.
 *
 * Der Kommentar hat das schon einmal behauptet, ohne dass es stimmte: dunkel
 * stand hier #0C0C0E gegen ein --color-bg von #191816. Seither hält der Guard
 * "the status bar colour is the page background" alle drei Kopien am Token.
 */
function updateThemeColorForRoute(route) {
  if (route?.thirdPartyModule?.accent) {
    setThemeColor(route.thirdPartyModule.accent, route.thirdPartyModule.accent);
    return;
  }
  setThemeColor('#F5F3ED', '#191816');
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

// --------------------------------------------------------
// Veraltete Shell nach SW-Update (#616)
//
// Der Browser führt pro Dokument genau eine Modul-Map. Ist ein geteiltes Modul
// (z. B. /utils/empty-state.js) einmal geladen, wird jeder spätere Import
// dagegen gebunden - auch der eines Seitenmoduls, das der neue Service Worker
// frisch vom Netz geholt hat. Nach einem Update im laufenden Tab trifft dann
// neues Seitenmodul auf alte Abhängigkeit, und ein in der neuen Version
// hinzugekommener Export fliegt als SyntaxError auf. Die Modul-Map lässt sich
// nicht leeren; nur ein Reload des Dokuments verwirft sie.
//
// Sobald ein Update angekündigt ist, wird deshalb kein Seitenmodul mehr
// nachgeladen: importPage() löst die Navigation stattdessen in einen Reload
// auf. Das Promise bleibt bewusst offen, damit renderPage() nicht mit einem
// Fehlerbildschirm weiterläuft, den der Reload eine Sekunde später wegwirft.
// --------------------------------------------------------
let shellStale = false;

// Reload-Schleifen-Bremse: ein durch einen Modulfehler ausgelöster Reload darf
// sich nicht wiederholen, wenn der Fehler nach dem Reload fortbesteht (echter
// Bug statt Versions-Mischzustand). Zeitbasiert statt einmalig, damit ein
// späteres, echtes Update wieder reloaden darf.
const RELOAD_GUARD_KEY = 'yuvomi-stale-shell-reload';
const RELOAD_GUARD_MS  = 30000;

function reloadOnce() {
  try {
    const last = parseInt(sessionStorage.getItem(RELOAD_GUARD_KEY) || '0', 10);
    if (Date.now() - last < RELOAD_GUARD_MS) return false;
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  } catch { /* sessionStorage gesperrt (Private Mode) → Reload trotzdem wagen */ }
  location.reload();
  return true;
}

/**
 * Erkennt Fehler, die ein Reload heilt: ein gegen eine alte Abhängigkeit
 * gebundenes Modul (SyntaxError) oder ein Modul, das gar nicht erst geladen
 * werden konnte (TypeError). Offline ist Letzteres normal und kein Grund für
 * einen Reload - dann greift die reguläre Fehlerbehandlung.
 */
function isStaleModuleError(err) {
  if (err instanceof SyntaxError) return true;
  return err instanceof TypeError && navigator.onLine;
}

async function importPage(pagePath) {
  // Nur wenn der Reload wirklich angestoßen wurde, bleibt das Promise offen.
  // Greift die Schleifen-Bremse, wird regulär importiert: ein hängendes
  // Promise ohne folgenden Reload ließe die Seite dauerhaft im Skelett stehen.
  if (shellStale && reloadOnce()) {
    return new Promise(() => {});
  }
  if (!moduleCache.has(pagePath)) {
    try {
      moduleCache.set(pagePath, await import(pagePath));
    } catch (err) {
      moduleCache.delete(pagePath);
      // Zweiter Rettungsanker: das Update kam ohne Vorankündigung durch (der
      // Service Worker kann den Tab zwischen zwei Fetches übernehmen). Reload
      // statt Fehlerbildschirm - beim zweiten Mal fällt der Fehler durch.
      if (isStaleModuleError(err) && reloadOnce()) {
        return new Promise(() => {});
      }
      throw err;
    }
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
  // Nach angekündigtem Update nichts mehr vorwärmen: ein modulepreload zieht den
  // kompletten Modulgraph in die Modul-Map und würde neue Seitenmodule gegen die
  // alten geteilten Module binden, bevor der Reload greift (#616).
  if (shellStale) return;
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
/** AbortController des laufenden Seitenaufbaus; abgebrochen, sobald die Route ersetzt wird (#976). */
let _pageController = null;
let _renderedModuleName = null;
let _preferencesLoaded = false;
let _disabledModules = new Set();
// Persoenlich ausgeblendete Module (#673). Bewusst eine ZWEITE Menge neben
// `_disabledModules` und nicht mit ihr vereinigt: die haushaltweite Abschaltung
// wirkt auch im Routen-Guard weiter unten, diese hier NUR in der Navigation.
// Ein ausgeblendetes Modul bleibt erreichbar - ueber einen Deep-Link aus einer
// Benachrichtigung, ein Dashboard-Widget oder die Suche. Wer entziehen will,
// nimmt die Rechte (#467); wer aufraeumen will, blendet aus.
let _hiddenModules = new Set();
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

const ROUTE_ORDER = ['/', '/calendar', '/schedule', '/tasks', '/meals', '/recipes', '/shopping', '/pantry',
                     '/birthdays', '/notes', '/contacts', '/budget', '/inventory', '/documents', '/housekeeping', '/waste', '/health', '/settings'];

const MOBILE_FAVORITE_COUNT = 3;

// Domänen-Gruppierung der Haupt-Navigation. Die Reihenfolge bestimmt die
// Sortierung der Sektionen (Overview → Plan → Home); die Label-Keys werden in
// der Sidebar via t() aufgelöst.
const NAV_SECTION_LABEL_KEYS = Object.freeze({
  [NAV_SECTION.overview]: 'nav.sectionOverview',
  [NAV_SECTION.plan]: 'nav.sectionPlan',
  [NAV_SECTION.household]: 'nav.sectionHousehold',
  [NAV_SECTION.people]: 'nav.sectionPeople',
  [NAV_SECTION.finance]: 'nav.sectionFinance',
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

/**
 * Dokumenttitel einer Route - die einzige Ansage, die ein Screenreader beim
 * Seitenwechsel in einer SPA bekommt (WCAG 2.4.2, Level A). Zugleich Tab-Text,
 * Verlaufseintrag und Lesezeichen.
 *
 * Die Titel kommen aus ROUTES, nicht aus einer zweiten Liste daneben - siehe
 * die Begründung am Kopf der Routentabelle.
 */
function routeTitle(path) {
  const titleKey = ROUTES.find((route) => route.path === path)?.titleKey;
  if (titleKey) return t(titleKey);

  // Dritt-Module bringen ihren Titel im eigenen Manifest mit; sie stehen nicht
  // in ROUTES, sondern kommen zur Laufzeit dazu.
  const thirdParty = _thirdPartyModules.find((module) => module.route?.path === path);
  if (thirdParty) return moduleDisplayLabel(thirdParty);

  // Unbekannter Pfad oder eine der beiden erklärt titellosen Routen
  // (/login, /setup): der App-Name ist dort der Titel.
  return getAppName();
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

  const loginTitle = document.querySelector('.auth-hero__title');
  if ((path === '/login' || path === '/setup') && loginTitle) loginTitle.textContent = appName;

  // Eine Route mit `titleKey: null` erklärt, dass der App-Name IHR Titel ist
  // (Anmelden, Ersteinrichtung - dort steht noch keine Seite, auf die er sich
  // beziehen könnte). Alles andere bekommt „Seite · App". Die Bedingung liest
  // die Routentabelle, statt zwei Pfade ein zweites Mal aufzuzählen: sonst
  // steht die Entscheidung an zwei Stellen und driftet an einer davon.
  const declaresOwnTitle = ROUTES.find((route) => route.path === path)?.titleKey === null;
  document.title = declaresOwnTitle
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

    // Scrollstand der Seite festhalten, die gerade verlassen wird - er ist die
    // Antwort auf ein späteres Browser-Zurück. Bewusst vor den Guards: was hier
    // sichtbar ist, gilt unabhängig davon, ob die Navigation gleich umgeleitet
    // wird. Der Scrollport ist #main-content selbst (== .app-content).
    if (previousPath) {
      rememberScrollPosition(previousPath, document.getElementById('main-content')?.scrollTop ?? 0);
    }
    // Vorwärts heißt oben anfangen, Zurück/Vor heißt weitermachen. Details und
    // die Begründung gegen getDirection() in utils/scroll-restore.js.
    const scrollTarget = scrollPositionFor(basePath, { restore: !pushState });

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
      /* EIN DIALOG UEBERLEBT KEINE NAVIGATION (#871). Er stuende sonst ueber
       * der falschen Seite - genau der gemeldete Zustand, nur andersherum
       * erreicht. `consumeOverlayMarker()` schliesst deshalb, was noch offen
       * ist, und meldet zurueck, ob der aktuelle History-Eintrag unser
       * Platzhalter war.
       *
       * WAR ER ES, TRITT DIE NEUE SEITE AN SEINE STELLE. Laege sie darueber,
       * zeigte der Rueckweg zuerst auf einen Eintrag mit derselben Adresse -
       * eine Geste, die sichtbar nichts tut. */
      if (consumeOverlayMarker()) history.replaceState({ path }, '', path);
      else history.pushState({ path }, '', path);
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
        // Auch die Soft-Navigation wechselt den Inhalt (Settings-Blatt, Health-Tab)
        // und muss den Scrollport nachziehen - hier zwangsläufig NACH dem Render,
        // weil kein Teardown existiert, an den man sich hängen könnte.
        const main = document.getElementById('main-content');
        if (main) main.scrollTop = scrollTarget;
        // Ein Tabwechsel kann einen neuen FAB anlegen (Health-Tabs) - der muss
        // denselben Weg aus dem Scrollport nehmen wie beim vollen Rendern.
        adoptPageFab();
        updateNav(topLevelSection(basePath));
        return;
      }
    }

    // Der Wand-Modus ist ein Zustand DES DASHBOARDS, kein eigener Eintrag in
    // dieser Tabelle - er muss die Route also von hier erfahren. Vor dem
    // Modul-Akzent, weil er nachts das Theme auf dunkel zwingt und der Akzent
    // als aufgeloeste Farbe im Inline-Style landet: umgekehrt truege die Shell
    // den Hellmodus-Wert in eine dunkle Nacht (dieselbe Reihenfolge-Falle wie
    // bei applyTheme).
    syncWallMode(basePath);

    // Küchen-Routen lösen auf --module-kitchen auf, nicht auf ihr eigenes
    // --module-*: die Küche ist im Routing vier Module, in Navigation, Akzent
    // und Statusbar eines (kitchenGroup). Sonst wechselte der 3px-Streifen der
    // Tab-Leiste und der FAB beim Tabwechsel die Farbe - dieselbe Botschaft wie
    // ein echter Modulwechsel (Critique 2026-07-29). Begründung am Token in
    // tokens.css, Wortlaut bei moduleAccentToken().
    applyModuleAccentForRoute(route);

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

    await renderPage(route, previousPath, scrollTarget);
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
    // Die Haushaltszone in die Anzeige spiegeln (#829 Teil 3). Bewusst
    // `timezone` und nicht `timezone_effective`: letzteres ist nie leer und
    // traegt ohne Einstellung die `TZ` des Containers - ein Compose-Schalter,
    // der nichts darueber aussagt, wo dieser Haushalt lebt. Ohne getroffene
    // Wahl bleibt die Anzeige also beim Browser, so wie bisher.
    setDisplayTimeZone(res?.data?.timezone ?? null);
    // Region als Formatier-Locale für Zahlen/Währung spiegeln (z. B. de-CH →
    // 123'456.78). getFormatLocale() in i18n.js liest diesen Wert.
    const numberLocale = numberLocaleFor({
      region: res?.data?.region,
      currency: res?.data?.currency,
      date_format: res?.data?.date_format,
      time_format: res?.data?.time_format,
    });
    if (numberLocale) {
      localStorage.setItem('yuvomi-number-locale', numberLocale);
    } else {
      localStorage.removeItem('yuvomi-number-locale');
    }
    if (res?.data?.app_name) {
      setAppName(res.data.app_name);
      updateBranding();
    }
    if (Array.isArray(res?.data?.disabled_modules)) {
      _disabledModules = new Set(res.data.disabled_modules);
    }
    if (Array.isArray(res?.data?.hidden_modules)) {
      _hiddenModules = new Set(res.data.hidden_modules);
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
    // Die Upload-Grenze kommt vom Server, damit Hinweis und Pruefung im Browser
    // dieselbe Zahl nennen wie er (#806).
    setMaxUploadBytes(res?.max_upload_bytes);
    updateBranding();
  } catch {
    // Non-critical. The login page and settings page can refresh branding later.
  }
  await syncThirdPartyModules();
}

async function syncThirdPartyModules() {
  try {
    const res = await api.get('/modules');
    _thirdPartyModules = selectThirdPartyModuleList(_thirdPartyModules, { ok: true, data: res?.data });
  } catch {
    _thirdPartyModules = selectThirdPartyModuleList(_thirdPartyModules, { ok: false });
  }
  setExtensionModules(_thirdPartyModules);
  setExtensionNavMap(_thirdPartyModules);
  await reloadExtensionLocales(_thirdPartyModules);
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

/**
 * Die Route der gerade dargestellten Seite. Nötig für alles, was Chrome-Farben
 * ausserhalb einer Navigation nachzieht (Theme-Wechsel, Rückkehr aus einem
 * Overlay) - dort gibt es kein `route`-Objekt aus navigate() mehr.
 */
function currentRoute() {
  return allRoutes().find((r) => r.path === currentPath);
}

/**
 * Zieht die Statusbar-Farbe auf das jetzt gültige Theme nach.
 *
 * Der Modul-Akzent ist nicht die einzige eingefrorene Momentaufnahme:
 * `updateThemeColorForRoute` löst `--module-<name>` über denselben `getCSSToken`
 * auf und schreibt das Ergebnis in beide `<meta name="theme-color">`. Ein
 * Attribut nimmt an keiner Kaskade teil, also behielt die Statusbar nach
 * hell↔dunkel die Modulfarbe des alten Themes, während die Shell darunter längst
 * umgeschaltet hatte - dieselbe Regel wie bei applyModuleAccentForRoute, nur für
 * die zweite Momentaufnahme.
 *
 * Sichtbar nur in der installierten PWA: `setThemeColor` steigt außerhalb des
 * Standalone-Modus früh aus. Deshalb fiel es neben dem Akzent-Befund nicht auf.
 */
function refreshThemeColorForTheme() {
  // Liegt ein Modal über der Seite, gehört die Statusbar ihm: modal.js dunkelt
  // sie beim Öffnen ab und stellt sie über restoreThemeColor selbst wieder her.
  // Ein Nachziehen der Routenfarbe höbe die Abdunklung mitten im offenen Modal
  // auf - der Fall tritt im Auto-Modus ein, wenn das System selbst umschaltet.
  if (document.getElementById('shared-modal-overlay')) return;
  updateThemeColorForRoute(currentRoute());
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

/* Zählstände der Modulkacheln im „Mehr"-Sheet.
 *
 * Sie kommen aus EINEM späteren /dashboard-Abruf beim ersten Öffnen des
 * Sheets, nicht aus einem eigenen Endpunkt und nicht aus zehn Modul-Requests:
 * die Nutzlast liegt fertig da, sie beantwortet die Sichtbarkeitsfrage je
 * Modul bereits korrekt, und in den meisten Sitzungen ist sie ohnehin warm.
 * Ohne Antwort bleiben die Kacheln einfach ohne Badge - das ist der Normalfall
 * beim allerersten Öffnen und kein kaputter Zustand.
 *
 * WAS WARTET, NICHT WAS EXISTIERT. Deshalb steht hier weder die Zahl der
 * Geburtstage noch die der Notizen: sie zählen Bestand. Ein Badge, das immer
 * leuchtet, ist keine Nachricht mehr. */
let _moduleCounts = {};
let _moduleCountsAt = 0;
// Generation der Sitzung: steigt bei jedem Zuruecksetzen, damit eine noch
// laufende Abfrage ihr Ergebnis nicht in die neue Sitzung traegt.
let _moduleCountsGen = 0;
const MODULE_COUNTS_TTL = 60_000;


/**
 * Die Zaehlstaende gehoeren der SITZUNG, nicht dem Geraet.
 *
 * `_moduleCounts` und sein Zeitstempel sind Modulzustand und ueberlebten einen
 * Kontowechsel: meldet sich innerhalb der 60s-TTL ein anderes Familienmitglied
 * an, baut die neue Shell ihre Badges aus den Zahlen des vorigen - offene
 * Aufgaben, Einkauf, Belohnungen, Dosen -, und das Oeffnen des Mehr-Blattes
 * ueberspringt den Abruf, bis die alte TTL ablaeuft (Codex-Review zu PR #754).
 * Dieselbe Ueberlegung, aus der `auth:expired` schon den API-Cache und die
 * Scrollstaende vergisst.
 */
function resetModuleCounts() {
  _moduleCounts = {};
  _moduleCountsAt = 0;
  // Und der Generationszähler steigt: eine Antwort, die noch unterwegs ist,
  // gehört der alten Sitzung und darf den Speicher nicht wieder füllen.
  _moduleCountsGen += 1;
}

/**
 * DIE ZAHLEN AM NAV-ZIEL, BEVOR DAS MODUL GELADEN WURDE (#868).
 *
 * Gemeldet war: nach dem Anmelden fehlt das Badge mit den ueberfaelligen
 * Aufgaben, es erscheint erst nach einem Besuch der Aufgaben. Der Grund lag
 * nicht in der Anzeige, sondern in der Quelle - die Zahl kam aus dem Zustand
 * eines Moduls, das noch gar nicht gerendert war.
 *
 * SIE STAND DIE GANZE ZEIT IM PAYLOAD. `/dashboard` liefert
 * `overdueTaskCount` seit jeher (es ist die Zweitzeile der Aufgaben-Kachel),
 * und die Geburtstagsliste traegt ihr `days_until` mit. Es brauchte also
 * keinen neuen Endpunkt, sondern nur, dass jemand hinsieht.
 *
 * UND ZWAR HIER, weil dieselbe Antwort schon fuer die Kachel-Zaehlstaende
 * geholt wird - ein zweiter Abruf fuer dieselben Zahlen waere die zweite
 * Wahrheit UND der zweite Request.
 *
 * WAS HIER (NOCH) FEHLT, ausgesprochen statt verschwiegen: das INVENTAR. Seine
 * Zahl ist „wie viele Gegenstaende haben eine ablaufende Frist", und die
 * beantwortet `/dashboard` nicht - das Modul hat dort keinen Block. Sein Badge
 * erscheint deshalb weiterhin erst nach dem ersten Besuch; es ueberlebt seit
 * diesem Fix immerhin einen Neuaufbau der Navigation. Der saubere Weg dorthin
 * ist ein Zaehler in der Nutzlast, nicht eine zweite Rechnung im Browser.
 */
function primeNavBadges(data) {
  const counts = navBadgeCountsFrom(data);
  setNavBadge('/tasks', counts['/tasks'],
    (count) => (count > 0 ? t('tasks.navLabelOverdue', { count }) : t('tasks.title')));
  // Ein anstehender Geburtstag ist eine Nachricht, kein Alarm (Valenz siehe
  // nav-badges.js).
  setNavBadge('/birthdays', counts['/birthdays'], undefined, 'accent');
}

/**
 * Ein Modul hat etwas geaendert, das gezaehlt wird.
 *
 * DIE ZAHL GEHOERT DEM SERVER, und deshalb steht hier eine Entwertung und
 * keine Rechnung. Das Aufgabenmodul koennte sie gar nicht selbst fuehren:
 * `state.tasks` ist eine GEFILTERTE Liste (der Standardfilter zeigt nur
 * offene, das Kanban laesst den Statusfilter ganz weg), waehrend
 * `overdueTaskCount` haushaltweit und ungefiltert zaehlt. Beide in denselben
 * Badge-Slot zu schreiben liess die Zahl beim blossen Wechsel zwischen Liste
 * und Kanban springen - die zweite Wahrheit, die dieser Fix eigentlich
 * abschaffen sollte, eine Ebene tiefer.
 *
 * Nebenbei erledigt das die Zeitzonenfrage: `overdueTaskCount` rechnet mit der
 * Haushaltszone, eine Client-Rechnung mit `todayKey()` im Automatikmodus mit
 * der des Browsers. Zwei Zonen, zwei Tage, zwei Zahlen.
 *
 * GEBUENDELT, weil Mutationen in Serien kommen (Mehrfachauswahl, schnelles
 * Abhaken): sonst loeste jeder Haken einen eigenen Abruf aus.
 */
let _moduleCountsRefreshTimer = null;
function invalidateModuleCounts() {
  _moduleCountsAt = 0;
  /* DIE GENERATION MUSS MIT, sonst frisst eine noch laufende Antwort die
   * Entwertung. Sie stammt von VOR der Aenderung, kaeme aber danach an, setzte
   * ihren alten Stand in den Speicher und stempelte `_moduleCountsAt` neu -
   * der entprellte Abruf 300 ms spaeter liefe dann in die TTL-Sperre, und die
   * Zahl bliebe bis zu einer Minute auf dem Stand vor der Aenderung stehen.
   * Also genau in der Serie schneller Haken, fuer die diese Funktion da ist.
   * `resetModuleCounts()` direkt darueber tut aus demselben Grund dasselbe. */
  _moduleCountsGen += 1;
  if (_moduleCountsRefreshTimer) clearTimeout(_moduleCountsRefreshTimer);
  _moduleCountsRefreshTimer = setTimeout(() => {
    _moduleCountsRefreshTimer = null;
    refreshModuleCounts();
  }, 300);
}

/**
 * Die Uebersichtsseite hat ihre `/dashboard`-Antwort schon - der Speicher
 * nimmt sie, statt sie ein zweites Mal zu holen.
 *
 * Beim Anmelden faellt der Weg auf `/`, und dort holten bis dahin ZWEI Stellen
 * dieselbe teure Aggregation: der Shell-Aufbau fuer die Zahlen und die Seite
 * fuer ihre Kacheln. Der Server rechnet dabei ein Dutzend Abfragen doppelt.
 *
 * Die Seite fragt gefiltert (`layoutHintQuery`), die Zahlen brauchen das nicht
 * - sie zaehlen, was wartet, nicht was die Kachel zeigt. Fuer `openTaskCount`
 * und `overdueTaskCount` macht die Widget-Einschraenkung sehr wohl einen
 * Unterschied (`test:task-scope` haelt genau das fest), und deshalb gilt: nur
 * eine UNGEFILTERTE Antwort darf den Speicher fuellen. Kommt sie gefiltert,
 * bleibt es beim eigenen Abruf.
 */
function primeModuleCountsFrom(data, { filtered = false } = {}) {
  if (filtered || !data) return;
  _moduleCounts = moduleCountsFrom(data, {
    isAdmin: currentUser?.role === 'admin',
    shoppingVisible: navItems().some((item) => item.module === 'shopping'),
  });
  _moduleCountsAt = Date.now();
  primeNavBadges(data);
}

/**
 * Auf der Uebersicht holt die SEITE dieselbe Antwort - der Shell-Aufbau tritt
 * ihr zurueck.
 *
 * Beide starteten sonst gleichzeitig, und der Server rechnete ein Dutzend
 * Abfragen zweimal. Ein Aufschub waere ein Rennen; die Route ist die Antwort,
 * denn nur `/` traegt die Uebersichtsseite.
 *
 * DER RUECKFALL BLEIBT, weil zwei Faelle die Seite nicht liefern lassen: eine
 * gefilterte Abfrage (gesetzte Widget-Optionen - eine eingeschraenkte Zahl ist
 * eine andere Zahl) und ein Fehlschlag ihrer Anfrage. Beide erkennt man
 * daran, dass der Speicher danach immer noch leer ist.
 */
function refreshModuleCountsUnlessPageProvides(path) {
  if (path !== '/') { refreshModuleCounts(); return; }
  setTimeout(() => { if (!_moduleCountsAt) refreshModuleCounts(); }, 1500);
}

async function refreshModuleCounts() {
  if (Date.now() - _moduleCountsAt < MODULE_COUNTS_TTL) return false;
  /* EINE LAUFENDE ANFRAGE UEBERLEBT DAS ZURUECKSETZEN SONST.
   * Wer das Mehr-Blatt oeffnet und sich abmeldet, waehrend `/dashboard` noch
   * unterwegs ist, bekam die Antwort der ALTEN Sitzung nach `clearSession()`
   * in den Speicher gelegt - die naechste Anmeldung innerhalb der TTL baute
   * ihre Badges daraus und uebersprang den Abruf (Codex-Review zu PR #754,
   * zweite Runde: der Befund entstand erst durch den Reset-Fix davor).
   * Der Zaehler ist billiger als ein AbortController: die Anfrage darf
   * zuende laufen, ihr Ergebnis wird nur nicht mehr angenommen. */
  const gen = _moduleCountsGen;
  try {
    const res = await api.get('/dashboard');
    if (gen !== _moduleCountsGen) return false;
    _moduleCounts = moduleCountsFrom(res, {
      isAdmin: currentUser?.role === 'admin',
      // `navItems()` ist bereits nach Zugang gefiltert und damit die richtige
      // Quelle fuer die Frage, ob der Einkauf diesem Mitglied offensteht.
      shoppingVisible: navItems().some((item) => item.module === 'shopping'),
    });
    _moduleCountsAt = Date.now();
    primeNavBadges(res);
    return true;
  } catch (err) {
    /* Kein Netz, keine Sitzung, Serverfehler: das Sheet bleibt ohne Badges
     * benutzbar. Ein Fehler an dieser Stelle darf die Navigation nicht stören.
     *
     * ABER ER DARF AUCH NICHT SPURLOS SEIN. Dieser Block schluckte bis #868
     * einen ReferenceError mit: `moduleCountsFrom()` rief ein `isAdmin()`, das
     * es in dieser Datei nie gab (es lebt modul-lokal in pages/rewards.js).
     * Der Aufruf warf also bei JEDEM Durchlauf, seit die Zeile 2026 dazukam -
     * die Zaehlstaende der Modulkacheln waren nie da, und niemand sah es, weil
     * ein leeres Sheet genauso aussieht wie eines ohne wartende Arbeit.
     * Ein Programmierfehler ist keine Netzstoerung; er gehoert in die Konsole. */
    console.error('[Router] Zählstände konnten nicht geladen werden:', err);
    return false;
  }
}

/** Zieht die Badges am offenen Sheet nach, ohne es neu zu bauen. */
function paintMoreSheetBadges(sheet) {
  if (!sheet) return;
  sheet.querySelectorAll('.more-item[data-nav-id]').forEach((item) => {
    const count = _moduleCounts[item.dataset.navId] ?? 0;
    const existing = item.querySelector('.more-item__badge');
    if (count > 0) {
      if (existing) existing.replaceWith(moreBadgeEl(count));
      else item.appendChild(moreBadgeEl(count));
      // Ansage am Link, nicht am Badge - siehe moreBadgeEl.
      const labelText = item.querySelector('.more-item__label')?.textContent;
      if (labelText) item.setAttribute('aria-label', `${labelText}, ${t('nav.moreBadge', { count })}`);
    } else {
      existing?.remove();
      item.removeAttribute('aria-label');
    }
  });
}

/**
 * Baut den dynamischen Body des „Mehr“-Sheets: EIN vierspaltiges Modul-Raster
 * und darunter, im selben Raster, die monochrome System-Reihe (Einstellungen ·
 * Hilfe · Änderungen · Abmelden).
 *
 * Gibt EINEN Knoten in einem Array zurück (`.more-sheet__body`, der Scroller);
 * beide Aufrufer spreizen das Ergebnis und bleiben davon unberührt.
 *
 * EIN RASTER, KEINE ÜBERSCHRIFTEN. Die Bereichsköpfe (Planen · Haushalt ·
 * Menschen · Finanzen) sind hier ersatzlos weg, und die Reihenfolge verliert
 * dabei nichts: `secondaryMobileItems()` liefert bereits nach Sektion sortiert
 * (sortNavigationItems), die Gruppen standen also nur noch als Beschriftung
 * über einer Ordnung, die das Raster ohnehin hat. Was sie dafür kosteten, war
 * Höhe: vier Köpfe plus vier Gruppenabstände sind auf einem 390er-Schirm rund
 * 150px - mehr als eine ganze Kachelreihe, für eine Auskunft, die man an den
 * Nachbarn ablesen kann. Das Blatt ist ein Sprungbrett, kein Verzeichnis; es
 * soll so wenig Bild nehmen wie möglich.
 *
 * VIER SPALTEN, UND DIE SYSTEM-REIHE IST DIE LETZTE DAVON. Abmelden stand
 * zuletzt als eigene volle Zeile darunter, weil es in der DREIspaltigen
 * Systemreihe unter genau dem Pixel lag, an dem der Daumen „Mehr" getippt
 * hatte. Diese Ursache ist strukturell erledigt: das Blatt endet seit
 * derselben Runde ÜBER der Tab-Leiste (`bottom: --nav-bottom-height`), der Ort
 * des Mehr-Knopfs gehört wieder ihm allein. Damit ist die eigene Zeile nur
 * noch Höhe ohne Auftrag, und die vier System-Ziele füllen die Reihe exakt.
 * Monochrom bleiben sie trotzdem - das ist der Unterschied zu den farbig
 * besiegelten Modulen darüber, und der trägt die Trennung jetzt allein.
 *
 * EINE Quelle der Wahrheit für renderAppShell() UND rebuildNavigation() —
 * beide Pfade müssen dieselbe Struktur erzeugen, sonst zerstört ein
 * Sprachwechsel / Modul-Toggle / Settings-Besuch das Layout.
 * Handle + Suchleiste bleiben davon unberührt (sie tragen Event-Wiring).
 */
function buildMoreSheetBody() {
  /* EIN scrollender Körper zwischen Griff und Suche und dem Blattrand.
   *
   * Das Blatt ist `position: fixed; bottom: 0` und hatte weder Obergrenze noch
   * Scroller: es wuchs nach OBEN aus dem Schirm. Gemessen bei 320x568 lag seine
   * Oberkante bei -142,6px, das Suchfeld komplett ausserhalb (-105,6 bis -67,0)
   * - fokussierbar per Tab, aber nicht ins Bild zu holen (Critique
   * 2026-08-13, P0). Der Deckel gehoert ans Blatt, das Scrollen an den Koerper:
   * so bleiben Griff und Suche stehen, wo die Hand sie sucht, und nur die
   * Gruppen wandern. Ein Sticky-Kopf haette dieselbe Wirkung, aber zwei
   * Hintergruende mehr zu verwalten. */
  const body = document.createElement('div');
  body.className = 'more-sheet__body';
  const nodes = [];

  // Der Katalog-Hinweis („Alle Module … in den Einstellungen") lebt jetzt in
  // der Hilfe (buildHelpRows), nicht mehr als Dauer-Zeile über dem Grid — das
  // hält das Sheet ruhig und kompakt.

  // Einstellungen ist ein System-Ziel, kein Inhalts-Modul — es wandert aus dem
  // farbigen Grid in den System-Cluster, damit das Grid sauber aufgeht.
  const secondary = secondaryMobileItems();
  const settingsItem = secondary.find((item) => item.module === 'settings');

  // Ein flaches Raster in der Reihenfolge der Sidebar. Die Sortierung nach
  // Sektion steckt schon in secondaryMobileItems(); hier wird sie nur nicht
  // mehr mit Überschriften nachgezeichnet.
  const modules = secondary.filter((item) => item.module !== 'settings');
  const grid = document.createElement('div');
  grid.className = 'more-sheet__grid';
  modules.forEach((item) => grid.appendChild(moreItemEl(item)));
  nodes.push(grid);

  const divider = document.createElement('div');
  divider.className = 'more-sheet__divider';
  divider.setAttribute('aria-hidden', 'true');
  nodes.push(divider);

  // System-Reihe im selben Vierer-Raster (Icon-über-Label, monochrom).
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
  /* Abmelden ist das vierte Ziel der Reihe, nicht mehr eine Zeile darunter.
   *
   * DER ANLASS FUER DIE EIGENE ZEILE IST WEG, NICHT NUR ALT. Gemessen bei
   * 390x844 lag der Mehr-Knopf bei x 266,6-329,0 / y 776,9-835,0, und
   * `elementFromPoint` lieferte an seinem MITTELPUNKT nach dem Oeffnen
   * `.more-item--logout` - derselbe Pixel oeffnete das Blatt und beendete die
   * Sitzung (Critique 2026-08-13, P0). Behoben hat das die Unterkante des
   * Blattes: seit `bottom: --nav-bottom-height` (layout.css) liegt ueber der
   * Leiste ueberhaupt kein Bedienelement des Blattes mehr. Die eigene Zeile war
   * die zweite Naht ueber derselben Wunde und kostet 60px Hoehe fuer eine
   * Ueberlappung, die es geometrisch nicht mehr geben kann.
   *
   * Es bleibt das LETZTE Ziel der Reihe, und das ist kein Zufall: es ist die
   * terminale Aktion, sie steht am Ende der Leserichtung, und der
   * Bestaetigungsdialog bleibt davor. */
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

  // Die Spaltenzahl folgt der Besetzung: ohne Einstellungen (Modul abgeschaltet)
  // sind es drei Ziele, und drei Ziele in vier Spalten lassen eine Lücke, die
  // wie ein fehlendes Element aussieht.
  system.style.setProperty('--more-system-cols', String(system.children.length || 1));
  nodes.push(system);

  body.append(...nodes);
  return [body];
}

/**
 * Lädt und rendert eine Seite dynamisch.
 * @param {{ path: string, page: string }} route
 * @param {string|null} previousPath - Pfad vor der Navigation (für Richtungsberechnung)
 * @param {number} scrollTarget - Scrollstand der Zielseite (0 vorwärts, gemerkt bei popstate)
 */
async function renderPage(route, previousPath = null, scrollTarget = 0) {
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
      // Nebenläufig und still: der Hinweis darf das erste Rendern nicht aufhalten.
      checkForUpdate();
      /* Und die Zahlen an den Nav-Zielen (#868).
       *
       * ERST AUS DEM SPEICHER, dann nachziehen - aus demselben Grund wie beim
       * Mehr-Blatt: `refreshModuleCounts()` kehrt innerhalb seiner TTL sofort
       * zurueck, ohne zu zeichnen. Die Shell wird aber auch INNERHALB dieser
       * Minute neu gebaut - `/reset-password`, `/forgot-password` und `/join`
       * sind ohne Auth erreichbar und raeumen sie ab, auch wenn man angemeldet
       * ist. Ohne diese Zeile kaeme die Navigation danach ohne Badges zurueck:
       * der gemeldete Fehler, nur ueber einen schmaleren Weg.
       *
       * Das Nachziehen bleibt still: ohne Antwort bleibt die Navigation ohne
       * Badges - das war bis hierher der Normalfall. */
      applyNavBadges();
      refreshModuleCountsUnlessPageProvides(route.path);
    } else if (currentUser && _navBuiltForUserId !== currentUser.id) {
      // Shell besteht bereits, aber der Nutzer hat gewechselt → Nav mit den
      // Modul-Rechten des aktuellen Nutzers neu aufbauen (#467).
      rebuildNavigation();
      _navBuiltForUserId = currentUser.id;
      // Die Zahlen gehoeren dem Mitglied, nicht dem Geraet: `forgetSessionState`
      // hat sie geleert, hier kommen die des neuen Mitglieds (#868).
      applyNavBadges();
      refreshModuleCountsUnlessPageProvides(route.path);
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
    // Scrollport auf Anfang, solange er leer ist. `content` IST der Scrollport
    // (#main-content == .app-content) und überlebt die Navigation; ohne diese
    // Zeile öffnet die Zielseite auf dem Scrollstand der Vorseite.
    //
    // HIER, NICHT NACH DEM RENDER: Module scrollen beim Aufbau selbst - die
    // Tagesansicht des Kalenders zur aktuellen Stunde, der Essensplan zum
    // heutigen Tag. Ein Reset danach würde genau das wieder einkassieren. Die
    // Wiederherstellung bei popstate darf und soll das dagegen überschreiben,
    // sie steht deshalb unten hinter dem await.
    content.scrollTop = 0;
    // Der FAB der alten Seite lebt in der Shell und fiele sonst nicht mit ihrem
    // Inhalt weg - er bliebe über der neuen Seite stehen, bis diese adoptiert.
    // Hier und nicht eine Zeile höher: der Scroll-Reset gehört unmittelbar an
    // den Inhaltstausch (Guard in test-mobile-scroll-layout.js).
    clearPageFab();
    // Dieselbe Begründung, dieselbe Schicht: die Sammelaktions-Pille gehört zur
    // Teilmenge EINER Liste und darf nicht über der nächsten Seite stehen
    // bleiben. Sie hat kein Gegenstück zu adoptPageFab() - wer sie braucht,
    // setzt sie beim Rendern.
    clearBulkPill();
    style.cleanup();
    // Lebenszyklus-Vertrag (#976): der Router besitzt EIN AbortController je
    // Seitenaufbau und bricht ihn hier ab, wo die Route ersetzt wird. Die
    // Seite bekommt das Signal als `context.signal` und haengt Timer und
    // Listener daran (Bruecke: utils/page-lifecycle.js). Bis dahin gab es
    // keinen Teardown fuer Seiten - das Dashboard brach seinen Controller nur
    // zu Beginn des NAECHSTEN eigenen render() ab, also nie beim Verlassen:
    // Uhr, stiller Refresh, Wetter- und Wandtimer liefen gegen einen
    // abgehaengten Container weiter und starteten Anfragen hinter der
    // naechsten Seite.
    _pageController?.abort();
    _pageController = new AbortController();

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
    //
    // Ein Erweiterungsmodul rendert nicht in den nackten Wrapper, sondern in
    // die Seitenwurzel seines im Manifest erklaerten Modus (`page.composition`,
    // `page.width`; docs/PAGE-COMPOSITION.md). Angewandt wird die Erklaerung
    // HIER, sonst waere sie ein Feld ohne Wirkung: der Server prueft sie, die
    // Admin-Liste zeigt sie, und die Seite saehe trotzdem aus wie ohne.
    const target = route.thirdPartyModule
      ? mountExtensionPage(pageWrapper, route.thirdPartyModule)
      : pageWrapper;
    const context = route.thirdPartyModule
      ? { user: currentUser, page: { ...route.thirdPartyModule.page }, signal: _pageController.signal }
      : { user: currentUser, signal: _pageController.signal };
    const renderPromise = module.render(target, context);

    // Schon jetzt umziehen, nicht erst nach den Daten: die meisten Seiten legen
    // ihren FAB im synchronen Teil an, und er soll gar nicht erst im Scrollport
    // erscheinen. Der zweite Aufruf unten holt die Nachzügler.
    adoptPageFab();
    wirePageToolbars();

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

    // Browser-Zurück/-Vor: gemerkten Stand wiederherstellen, jetzt wo der Inhalt
    // seine volle Höhe hat. Best effort - ist die Seite kürzer als beim Verlassen
    // (gefilterte Liste, gelöschter Eintrag), klemmt der Browser auf sein Maximum.
    if (scrollTarget > 0) content.scrollTop = scrollTarget;

    // Ab hier kann das Modul Soft-Navigationen bedienen (sofern es update() bietet).
    _renderedModule = module;
    _renderedModuleName = route.module;

    wirePageToolbars();

    // FAB Long Loop: Einstiegsanimation nach FAB_SEEN_MAX Views pro Modul deaktivieren
    const pageFab = adoptPageFab();
    if (pageFab) {
      // Shortcut-Discoverability (Audit P3): der 'n'-Chord öffnet den FAB — als
      // Tooltip-Titel + aria-keyshortcuts sichtbar bzw. vorlesbar machen.
      markFabShortcut(pageFab);

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
      const pageLabel = navCatalog().find((n) => n.path === route.path)?.label ?? route.path;
      announcer.textContent = '';
      setTimeout(() => { announcer.textContent = pageLabel; }, 50);
    }

  } catch (err) {
    document.documentElement.classList.remove('navigating');
    console.error('[Router] Seiten-Render-Fehler:', err);
    if (route.thirdPartyModule?.id) {
      await disableFailedThirdPartyModule(route.thirdPartyModule.id);
    }
    // Fehler NUR in den Inhaltsbereich rendern. #app enthält auch die App-Shell
    // (Sidebar, Bottom-Nav, Suche); ein replaceChildren() darauf löscht die
    // gesamte Navigation und die Fehlerkarte dehnt sich über die Nav-Spalte -
    // die Seite ist dann nur noch per Reload verlassbar. Erst wenn noch keine
    // Shell steht (Auth-Seiten, früher Fehler), ist #app der richtige Ort.
    renderError(document.getElementById('main-content') ?? app, err);
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
  // Kein role="list": die Kinder sind Sektions-Gruppen (role="group") + das
  // gepinnte Settings-Item, keine listitems. Die <nav>-Hülle trägt die
  // Navigations-Semantik, die Gruppen die Sektions-Struktur.
  // DER GEPINNTE EINTRAG STEHT AUSSERHALB DES SCROLLERS (Critique 2026-08-10).
  //
  // Die Absicht gab es schon: `nav-item--pinned-end` plus `margin-top: auto`.
  // Nur braucht ein Auto-Rand FREIEN RAUM - er wirkt also genau dann nicht,
  // wenn er gebraucht wird. Gemessen auf 1280x720: scrollHeight 666 in
  // clientHeight 448, und die Einstellungen lagen 218px unter der Falz,
  // zusammen mit dem Budget - beides Module, die PRODUCT.md ausdruecklich als
  // Desktop-Sitzung nennt. Eine Regel, die nur im unkritischen Fall greift, ist
  // dieselbe stille Zusicherung wie eine Fade-Maske, die zeigt, dass es
  // weitergeht, ohne dass man hinkaeme.
  //
  // Als Geschwister der Liste sitzt er immer am Fuss, ohne Auto-Rand: die
  // Sidebar ist eine Flex-Spalte, und was nicht im Scroller liegt, scrollt
  // nicht weg. Strukturell ist das ohnehin der richtige Ort - die Einstellungen
  // sind Systemebene, kein Modul unter Modulen.
  const pinnedSidebarItems = [];
  sidebarNavItems().forEach((item) => {
    if (item.classList?.contains('nav-item--pinned-end')) pinnedSidebarItems.push(item);
    else sidebarItems.appendChild(item);
  });

  // Scroll-Affordanz (Audit F-01): weiche Fade-Anrisse oben/unten, sobald die
  // Liste überläuft — der Scrollbalken ist bewusst versteckt, ohne Anriss waren
  // Einträge unterhalb der Falte (Budget/Gesundheit/Einstellungen) unsichtbar.
  wireScrollFade(sidebarItems, { axis: 'y' });

  // Einmal je Shell: das Andocken des FABs nimmt einen Wechsel der
  // 1024px-Grenze auch ohne Navigation zur Kenntnis (Rotation).
  wireFabDockingBoundary();

  // Zarte Hover-Vorschau — bewegt das separate `__hover`-Element (NICHT die
  // Aktiv-Pille) für Maus (hover) UND Tastatur (focus). Auf dem aktiven Item
  // wird nichts gezeigt: die Aktiv-Pille steht dort bereits.
  const previewHover = (item) => {
    const hov = sidebarItems.querySelector('.nav-sidebar__hover');
    if (!hov) return;
    if (item.getAttribute('aria-current') === 'page') { hov.style.opacity = '0'; return; }
    const cr = sidebarItems.getBoundingClientRect();
    const ir = item.getBoundingClientRect();
    // Vorschau (44px) vertikal im Item zentrieren — aus realen Höhen, token-unabhängig
    const centerOffset = (ir.height - hov.getBoundingClientRect().height) / 2;
    hov.style.transform = `translateY(${ir.top - cr.top + sidebarItems.scrollTop + centerOffset}px)`;
    hov.style.opacity = '1';
  };
  const hideHover = () => {
    const hov = sidebarItems.querySelector('.nav-sidebar__hover');
    if (hov) hov.style.opacity = '0';
  };
  sidebarItems.addEventListener('mouseover', (ev) => {
    const item = ev.target.closest('.nav-item');
    if (item) previewHover(item);
  });
  sidebarItems.addEventListener('mouseleave', hideHover);
  // Tastatur-Fokus treibt dieselbe Vorschau; verlässt der Fokus die Liste, wird
  // sie ausgeblendet. Die Aktiv-Pille bleibt die ganze Zeit am aktiven Item.
  sidebarItems.addEventListener('focusin', (ev) => {
    const item = ev.target.closest('.nav-item');
    if (item) previewHover(item);
  });
  sidebarItems.addEventListener('focusout', (ev) => {
    if (!sidebarItems.contains(ev.relatedTarget)) hideHover();
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

  // Sichtbarer Desktop-Einstieg in die globale Suche (Audit R2, A1-01): vor den
  // Modul-Items, bleibt im eingeklappten Modus als Lupe erreichbar. Kein
  // data-route, damit Delegation/Indikator das Item ignorieren.
  const sidebarSearch = sidebarActionEl({
    labelKey: 'nav.search',
    icon: 'search',
    className: 'nav-item--search',
    onClick: () => _openSearch?.(),
  });
  sidebarSearch.setAttribute('aria-keyshortcuts', '/');
  sidebarSearch.setAttribute('title', `${t('nav.search')} (/)`);
  sidebar.appendChild(sidebarSearch);

  sidebar.appendChild(sidebarItems);

  // Der gepinnte Eintrag steht zwischen Liste und Fuss-Aktionen: er IST eine
  // Route (data-route, Aktiv-Pille) und gehoert damit nicht zu den Aktionen
  // darunter, aber auch nicht mehr in den Scroller darueber.
  pinnedSidebarItems.forEach((el) => sidebar.appendChild(el));

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

  // Wohnort des Page-FAB, außerhalb des Scrollports (#634). Der Knopf gehört
  // inhaltlich zur Seite, aber nicht in den scrollenden Container - Begründung
  // an `.fab-layer` in layout.css und an adoptPageFab().
  const fabLayer = document.createElement('div');
  fabLayer.className = 'fab-layer';
  fabLayer.id = 'fab-layer';

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
  const searchResults = document.createElement('div');
  searchResults.className = 'search-overlay__results';
  searchResults.id = 'search-results';
  // Panel-Wrapper: auf Mobile transparent + bildschirmfüllend (Sheet bleibt
  // unverändert), am Desktop die zentrierte Command-Palette (~640px, Glas-Karte
  // über geblurtem Scrim). Das Overlay selbst ist nur noch die Scrim-Ebene.
  const searchPanel = document.createElement('div');
  searchPanel.className = 'search-overlay__panel';
  searchPanel.appendChild(searchHeader);
  searchPanel.appendChild(searchResults);
  // Sr-only Live-Region: sagt „Suche läuft…" und die Trefferzahl an, damit der
  // debounced Fetch für Screenreader nicht als Stille verpufft (Critique P1).
  // Die sichtbaren Skeletons tragen aria-hidden; die Semantik lebt hier.
  const searchStatus = document.createElement('p');
  searchStatus.className = 'sr-only';
  searchStatus.id = 'search-status';
  searchStatus.setAttribute('role', 'status');
  searchStatus.setAttribute('aria-live', 'polite');
  searchPanel.appendChild(searchStatus);
  // Schließen NACH den Treffern im DOM (visuell absolut oben rechts): Tab aus
  // dem Suchfeld erreicht so direkt das erste Ergebnis statt erst den
  // Schließen-Button (Audit A1-14); Esc bleibt der schnelle Ausstieg.
  searchPanel.appendChild(searchClose);
  searchOverlay.appendChild(searchPanel);

  // Die Namen kommen aus utils/toast-surface.js - derselbe Ort, an dem sie
  // gesucht werden. Die Begründung steht dort.
  const toastContainerPolite = document.createElement('div');
  toastContainerPolite.className = 'toast-container';
  toastContainerPolite.id = TOAST_SURFACES.polite;
  toastContainerPolite.setAttribute('aria-live', 'polite');

  const toastContainerAssertive = document.createElement('div');
  toastContainerAssertive.className = 'toast-container';
  toastContainerAssertive.id = TOAST_SURFACES.assertive;
  toastContainerAssertive.setAttribute('aria-live', 'assertive');

  // Wohnort der Sammelaktions-Pille (utils/bulk-pill.js). Sie steht ZUERST im
  // Stapel und damit über den Toasts: die Spalte ist unten verankert, also
  // bleibt der Toast an seinem Platz und die Pille weicht ihm nach oben aus.
  // Der mit der Frist bewegt sich nicht.
  const bulkPillLayerEl = document.createElement('div');
  bulkPillLayerEl.className = 'bulk-pill-layer';
  bulkPillLayerEl.id = BULK_PILL_LAYER;

  // DIE UNTERE SHELL-ZONE IST EIN STAPEL, KEIN ÜBEREINANDER. Beide
  // Toast-Container standen bis hierher einzeln auf demselben `bottom` und
  // hätten sich gegenseitig verdeckt, sobald eine höfliche und eine bestimmte
  // Meldung zusammentrafen; die Pille wäre die dritte auf derselben Stelle
  // gewesen. Als Kinder einer Spalte stapeln sie sich stattdessen.
  const bottomStack = document.createElement('div');
  bottomStack.className = 'shell-bottom-stack';
  bottomStack.append(bulkPillLayerEl, toastContainerPolite, toastContainerAssertive);

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
  // Zwei Knoten je Blob: die Hülle driftet, die Farbwolke darin steht still und
  // trägt den Blur. Solange beides auf EINEM Element sass, rasterte der Browser
  // den blur(90px) pro Frame neu - im Leerlauf 60 → 20 fps (Issue #716). Die
  // Begründung samt Messung steht bei .lg-blob in glass.css.
  for (let i = 1; i <= 4; i++) {
    const blob = document.createElement('div');
    blob.className = `lg-blob lg-blob--${i}`;
    const ink = document.createElement('div');
    ink.className = 'lg-blob__ink';
    blob.appendChild(ink);
    lgBackdrop.appendChild(blob);
  }

  // `bottomStack` steht VOR der Nav und nicht am Ende der Shell (Critique
  // 2026-08-13). Die Pille darin ist eine Bedienung für die Liste, die gerade
  // darüber steht - in der Tabfolge lag sie aber hinter der Liste, hinter dem
  // FAB, hinter der Nav und hinter dem unsichtbaren Suchfeld: gemessen Station
  // 47 von 49 auf /contacts. Wer eine Zeile abhakt und die Aktion mit der
  // Tastatur erreichen will, tabbte durch die ganze Seite. Jetzt ist es 27.
  //
  // NICHT weiter nach vorn, obwohl die Pille inhaltlich zur Liste gehört: die
  // FAB-Schicht muss laut #634 unmittelbar zwischen Scrollport und Nav hängen,
  // und ein Guard prüft genau diese Nachbarschaft. Zwischen FAB und Nav ist der
  // erste Platz, der beide Zusagen hält.
  //
  // Sichtbar ändert das nichts: der Stapel ist `position: fixed` und trägt
  // `--z-toast`, seine Lage kommt aus der Regel, nicht aus der Reihenfolge.
  const shellNodes = [skipLink, lgBackdrop, sidebar, main, fabLayer, bottomStack, bottomNav];
  if (backdrop)   shellNodes.push(backdrop);
  if (moreSheet)  shellNodes.push(moreSheet);
  shellNodes.push(searchOverlay, routeAnnouncer);
  container.replaceChildren(...shellNodes);
  // Die Kapsel ist ein NEUER Knoten; der Beobachter des Tab-Indikators haengt
  // sonst am verworfenen (siehe observeNavCapsule weiter unten).
  observeNavCapsule();
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
  _openSearch = openSearch;
  initMoreSheet(container, openSearch);
  initOfflineBanner();
  initKeyboardShortcuts();

  // Hauptnavigation im Leerlauf vorwärmen — die erste Modulnavigation soll
  // ohne Kaltstart-Wasserfall auskommen.
  warmPrimaryRoutes();
}

/**
 * Den Page-FAB der aktuellen Seite in die App-Shell heben (#634).
 *
 * WARUM AUS DEM SCROLLPORT HERAUS. Der FAB ist `position: fixed`, hing aber im
 * Modul-Root und damit INNERHALB von `.app-content` - dem Container, der auf
 * den meisten Routen scrollt. Auf iOS bekommt ein solcher Scroller einen
 * eigenen Compositor-Layer, und ein fixiertes Kind darin ist dort nicht
 * verlässlich viewport-fest: es wird gegen den gescrollten Inhalt statt gegen
 * den Viewport aufgelöst, wandert beim Laden mit der wachsenden Liste nach
 * unten aus dem Bild und kommt ohne Repaint nicht zurück. Genau das
 * beschreibt der Melder in #634 - erst mittig rechts, dann weg, und zwar in
 * den Modulen, in denen .app-content wirklich scrollt (Aufgaben, Vorrat),
 * während er anderswo nach dem Laden an seinen Platz springt.
 *
 * Dieselbe Falle hatte die Bottom-Nav schon einmal: sie ist deshalb längst
 * `position: relative` und ein Flex-Kind der Shell (Begründung an `.nav-bottom`
 * in layout.css). Der FAB war das letzte fixierte Element im Scrollport.
 *
 * Der Modulakzent geht dabei nicht verloren: die Layer liest ihn aus
 * `--active-module-accent`, das applyModuleAccentForRoute() ohnehin bei jeder
 * Navigation (und bei jedem Theme-Wechsel) auf <html> setzt.
 *
 * Idempotent: Der Aufruf sucht einen FAB im Inhalt und zieht ihn um; ist
 * keiner da, bleibt der bereits umgezogene stehen. Ein DOM-Umzug behält
 * Event-Listener, Referenzen (health/housekeeping/rewards halten ihren FAB)
 * bleiben gültig.
 */
function adoptPageFab() {
  const layer = document.getElementById('fab-layer');
  if (!layer) return null;
  const fresh = document.querySelector('#main-content .page-fab');
  if (fresh && dockFabIntoToolbar(fresh)) return null;
  // Umgezogen wird die GRUPPE, wenn es eine gibt: das Speed-Dial des Dashboards
  // ist ein FAB plus Aktionsliste plus Backdrop, und beide sind fixiert. Zöge
  // nur der Knopf um, bliebe die Mechanik im Scrollport zurück - der halbe
  // Umzug wäre schlimmer als keiner, weil er nach Erledigung aussieht.
  if (fresh) layer.replaceChildren(fresh.closest('.page-fab-group') ?? fresh);
  return layer.querySelector('.page-fab');
}

/**
 * Auf dem Desktop wird aus dem schwebenden Knopf ein BESCHRIFTETER Knopf in der
 * Werkzeugleiste. Gibt true zurück, wenn er dort gelandet ist.
 *
 * WARUM IN DER SHELL UND NICHT IN DREIZEHN SEITEN: der FAB zieht ohnehin durch
 * genau diese eine Funktion um (#634), und `.page-toolbar__actions` ist der
 * Aktions-Slot, den die Modulköpfe schon teilen. Ein Opt-in, das jedes Modul
 * selbst setzen müsste, fehlt beim vierzehnten.
 *
 * DER SICHTBARE TEXT IST NICHT DAS `aria-label`. Ein aria-label beschreibt
 * eine Handlung („Geburtstag hinzufügen"), ein Toolbar-Knopf benennt seine
 * Sache („Geburtstag") und lässt das Verb dem Plus-Zeichen. Als das Label hier
 * noch aus `aria-label` kam, standen an derselben Stelle drei Schreibweisen
 * nebeneinander - gemessen am 12.08.: „Neue Aufgabe" (150px, handgeschrieben),
 * „Geburtstag hinzufügen" (216px, geerbt) und zweimal gar nichts. Der kurze
 * Text steht deshalb als `data-dock-label` am Knopf, das ausführliche
 * `aria-label` bleibt unangetastet. Doppelt vorgelesen wird nichts: `aria-label`
 * überschreibt den Inhalt für Hilfstechnik ohnehin.
 *
 * Ohne `data-dock-label` dockt der Knopf STUMM NICHT AN, statt auf das
 * aria-label zurückzufallen: ein Rückfall wäre genau der lange Satz, den diese
 * Regel abgeschafft hat, und er fiele niemandem auf. So bleibt der schwebende
 * Knopf stehen - sichtbar falsch statt unsichtbar uneinheitlich. Ein Guard in
 * test-frontend-audit hält dazu, dass jeder `.page-fab` das Attribut trägt.
 *
 * DREI SACHEN DOCKEN NICHT AN, jede aus ihrem eigenen Grund:
 *   - eine .page-fab-group (das Speed-Dial der Übersicht): sie ist ein Menü,
 *     kein Knopf, und ihre Aktionsliste ist fixiert. Ein halber Umzug wäre
 *     schlimmer als keiner.
 *   - Module, die ihren eigenen .toolbar-new-btn mitbringen: sonst stünden
 *     zwei Primärknöpfe nebeneinander.
 *   - Module ohne Aktions-Slot im Kopf: dort bleibt der schwebende Knopf, bis
 *     ihr Kopf einen bekommt. Lieber ein Modul mit dem alten Weg als eines
 *     ohne Primäraktion.
 */
function dockFabIntoToolbar(fab) {
  if (!isDesktopViewport()) return false;
  if (fab.closest('.page-fab-group')) return false;
  const main = document.getElementById('main-content');
  if (main?.querySelector('.toolbar-new-btn')) return false;
  const slot = main?.querySelector('.page-toolbar__actions');
  if (!slot) return false;
  const label = fab.dataset.dockLabel;
  if (!label) return false;

  // `.page-fab` BLEIBT am Element. Zwei Module rufen ihre Primäraktion über
  // `document.querySelector('.page-fab').click()` auf (Rezepte, Einkauf); wer
  // die Klasse hier abzöge, machte deren Tastenkürzel und Tab-FAB still tot.
  // Die schwebende Geometrie hebt `.page-fab--docked` in layout.css auf.
  fab.classList.add('btn', 'btn--primary', 'page-fab--docked');
  if (!fab.querySelector('.toolbar-new-btn__label')) {
    const span = document.createElement('span');
    span.className = 'toolbar-new-btn__label';
    span.textContent = label;
    fab.appendChild(span);
  }
  slot.appendChild(fab);
  /* DAS TASTENKUERZEL WIRD HIER MITGESETZT, nicht nur beim schwebenden Knopf.
   * `adoptPageFab()` gibt beim Andocken `null` zurueck, damit die
   * Einstiegsanimation des schwebenden FABs nicht mitlaeuft - der Aufrufer
   * ueberspringt damit aber auch `aria-keyshortcuts` und den Titel mit "(n)".
   * Die Auffindbarkeit fiel also ausgerechnet am ZEIGERGERAET weg, wo ein
   * Tastenkuerzel ueberhaupt erst zaehlt (PR-Review #754). Der Chord selbst hat
   * immer funktioniert, die Klasse `.page-fab` bleibt ja am Element. */
  markFabShortcut(fab);
  return true;
}

/** Macht den 'n'-Chord am FAB sichtbar bzw. vorlesbar - schwebend wie angedockt. */
function markFabShortcut(fab) {
  fab.setAttribute('aria-keyshortcuts', 'n');
  const fabLabel = fab.getAttribute('aria-label');
  if (fabLabel && !/\(n\)$/.test(fab.getAttribute('title') || '')) {
    fab.setAttribute('title', `${fabLabel} (n)`);
  }
}

/** Spiegelt die Sidebar-Grenze aus layout.css - siehe die Notiz bei updateNav(). */
function isDesktopViewport() {
  return window.matchMedia('(min-width: 1024px)').matches;
}

/**
 * Nimmt das Andocken zurueck: aus dem Werkzeugleisten-Knopf wird wieder der
 * schwebende FAB in seiner Shell-Ebene.
 */
function undockFabFromToolbar(fab) {
  const layer = document.getElementById('fab-layer');
  if (!layer) return false;
  fab.classList.remove('btn', 'btn--primary', 'page-fab--docked');
  fab.querySelector('.toolbar-new-btn__label')?.remove();
  layer.replaceChildren(fab.closest('.page-fab-group') ?? fab);
  return true;
}

/**
 * DIE ENTSCHEIDUNG UEBERLEBT DIE GRENZE, AUCH OHNE NAVIGATION.
 *
 * `dockFabIntoToolbar()` fragt `isDesktopViewport()` genau einmal je
 * Seitenaufbau. Wer die 1024px-Grenze ohne Routenwechsel ueberquert - ein iPad,
 * das aus der Landschaft ins Hochformat kippt: 1024 -> 768 -, behielt den Knoten
 * in `.page-toolbar__actions`, verlor aber seine Geometrie: `.page-fab--docked`
 * steht ausschliesslich in `@media (min-width: 1024px)`, der Knopf fiel also auf
 * `.page-fab` zurueck (quadratisch, `--fab-size`) und trug den
 * `.toolbar-new-btn__label`-Span darin weiter, fuer den es unterhalb 1024px
 * keine einzige Regel gibt (PR-Review #754).
 *
 * Der Listener haengt EINMAL an der Shell und ruft dieselben zwei Funktionen,
 * die auch der Seitenaufbau ruft - keine zweite Fassung derselben Entscheidung.
 */
function wireFabDockingBoundary() {
  const query = window.matchMedia?.('(min-width: 1024px)');
  if (!query?.addEventListener) return;
  query.addEventListener('change', () => {
    const docked = document.querySelector('#main-content .page-fab--docked');
    if (docked && !isDesktopViewport()) {
      undockFabFromToolbar(docked);
      return;
    }
    if (!docked && isDesktopViewport()) {
      const floating = document.querySelector('#fab-layer .page-fab');
      // Der schwebende Knopf haengt in der Shell-Ebene, `dockFabIntoToolbar`
      // sucht ihn aber unter `#main-content` - hier also direkt anbieten.
      if (floating) dockFabIntoToolbar(floating);
    }
  });
}

/**
 * Modulköpfe verdrahten (Redesign Runde 4, C-1).
 *
 * Die Shell macht das, nicht die Module: der Kopf ist die eine Komponente, die
 * alle 17 teilen, und ein Opt-in, das jedes Modul selbst setzen müsste, fehlt
 * beim achtzehnten.
 *
 * ZWEI AUFRUFE PRO RENDER REICHEN NICHT - gemessen: Budget und Kalender bauen
 * ihren Kopf ein zweites Mal, wenn die Daten da sind, und liefern damit eine
 * NEUE Node, die kein Aufrufzeitpunkt mehr erwischt (beide klebten daraufhin
 * unverändert mit voller Höhe, während Aufgaben schon andockte). Deshalb hängt
 * hier ein Beobachter an der Shell statt eines Aufrufs am Render: er sieht
 * jeden Kopf, auch den eines Moduls, das es noch nicht gibt.
 *
 * Der Callback bleibt billig: er fragt nur die HINZUGEFÜGTEN Knoten, nicht bei
 * jeder Mutation den ganzen Teilbaum ab. `wireCollapsingHeader` ist idempotent.
 */
let _toolbarObserverRoot = null;
/**
 * Die Verdrahtung eines Kopfes haelt Beobachter - und einer davon ueberlebt
 * seinen Kopf.
 *
 * `wireCollapsingHeader()` gibt ein `destroy()` zurueck; es wurde hier
 * weggeworfen. Bei Resize- und Mutation-Observer verzeiht das die
 * Speicherbereinigung: sie beobachten nur Knoten aus demselben abgehaengten
 * Teilbaum, der als Ganzes unerreichbar wird. Der IntersectionObserver nicht -
 * seine `root` ist der Scrollport, und der ist ein Vorfahr, den
 * `content.replaceChildren()` NICHT mitnimmt. Ein registrierter Observer an
 * einer lebenden Wurzel haelt sein abgehaengtes Ziel fest, und das waechst mit
 * jeder Navigation.
 *
 * Deshalb merkt sich die Shell die Handles und raeumt sie beim Entfernen des
 * Kopfes ab - im selben Beobachter, der sie anlegt. Ein zweiter Ort waere eine
 * zweite Annahme darueber, wann ein Kopf verschwindet.
 */
const _toolbarHandles = new WeakMap();

/**
 * Icon-Fabrik für das Absender-Siegel eines Modulkopfes.
 *
 * ABGELEITET, NICHT ZWEITGESCHRIEBEN: welches Zeichen ein Modul führt, steht in
 * `MODULE_ICON` (nav-icons.js) - ein zweiter Katalog Modul→Icon wäre die Sorte
 * Dublette, die beim achtzehnten Modul auseinanderläuft. Genau das war er auch:
 * bis 2026-08-17 las diese Stelle aus `navItems()`, das Dashboard aus seinem
 * eigenen `widgetIcon()`, und Notizen trug deshalb im Kopf einen Zettel und im
 * Widget eine Stecknadel. Die Farbe braucht gar keine Angabe: das
 * Modul-Stylesheet setzt `--module-accent` auf seinem Root, der Kopf liegt
 * darin, das Siegel erbt.
 *
 * DRITTANBIETER-MODULE BEKOMMEN KEINES, und das ist kein Loch: das Siegel ist
 * Yuvomis eigene Ausweisform. Ein fremdes Modul ist kein Raum dieser Familie,
 * und sein Icon steht in keiner Zeile von MODULE_ICON.
 */
function headSealIcon(mod) {
  const name = mod ? MODULE_ICON[mod] : null;
  return name ? () => moduleIconEl(name) : null;
}

function wireToolbar(el) {
  const handle = wireCollapsingHeader(el, { sealIcon: headSealIcon(currentRoute()?.module) });
  // Der erste Handle gewinnt: `wireCollapsingHeader` ist idempotent und liefert
  // beim zweiten Anlauf ein wirkungsloses Paar zurueck. Wer das eintraegt,
  // ueberschreibt genau das `destroy()`, um das es hier geht.
  if (handle && !_toolbarHandles.has(el)) _toolbarHandles.set(el, handle);
}

function unwireToolbar(el) {
  _toolbarHandles.get(el)?.destroy();
  _toolbarHandles.delete(el);
}

function wirePageToolbars() {
  const main = document.getElementById('main-content');
  if (!main) return;
  main.querySelectorAll('.page-toolbar').forEach(wireToolbar);
  if (_toolbarObserverRoot === main) return;
  _toolbarObserverRoot = main;
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches('.page-toolbar')) wireToolbar(node);
        else node.querySelectorAll('.page-toolbar').forEach(wireToolbar);
      }
    }
    for (const m of mutations) {
      for (const node of m.removedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches('.page-toolbar')) unwireToolbar(node);
        else node.querySelectorAll('.page-toolbar').forEach(unwireToolbar);
      }
    }
  }).observe(main, { childList: true, subtree: true });
}

/** FAB der alten Seite abräumen - zusammen mit deren Inhalt, nicht später. */
function clearPageFab() {
  document.getElementById('fab-layer')?.replaceChildren();
}

const FAB_SEEN_KEY = (module) => `yuvomi:fabSeen:${module}`;
const FAB_SEEN_MAX = 5;
const SIDEBAR_COLLAPSED_KEY = 'yuvomi.sidebar.collapsed';

const SHORTCUTS = [
  // Direkt auf die Overlay-Funktion — der alte Umweg über einen Klick auf die
  // Suchleiste im (geschlossenen, inerten) Mehr-Sheet war eine fragile Kette.
  { key: '/',   description: () => t('shortcuts.search'),  action: () => _openSearch?.() },
  // Ein Selektor reicht: der Schnellaktionen-FAB des Dashboards war der einzige
  // Grund für den früheren Zweitweg über `#fab-main` (Audit A1-12), und er ist
  // seit dem Folgevorgang zu #634 selbst ein `.page-fab`.
  { key: 'n',   description: () => t('shortcuts.new'),     action: () => document.querySelector('.page-fab')?.click() },
  { key: 'f',   description: () => t('shortcuts.searchCalendar'), action: async () => {
    // Ausserhalb des Kalenders war `f` ein stiller No-Op (Critique 2026-08-31,
    // Alex-Persona): erst hinwechseln, dann suchen - ein Griff, ein Ziel.
    if (location.pathname !== '/calendar') await navigate('/calendar');
    document.querySelector('#cal-search')?.click();
  } },
  { key: '?',   description: () => t('shortcuts.help'),    action: () => showHelpModal() },
  { key: 'g d', description: () => t('shortcuts.goDash'),  action: () => navigate('/') },
  { key: 'g t', description: () => t('shortcuts.goTasks'), action: () => navigate('/tasks') },
  { key: 'g c', description: () => t('shortcuts.goCal'),   action: () => navigate('/calendar') },
  { key: 'g s', description: () => t('shortcuts.goShop'),  action: () => navigate('/shopping') },
  { key: 'g n', description: () => t('shortcuts.goNotes'),   action: () => navigate('/notes')              },
  { key: 'g h', description: () => t('shortcuts.goHealth'),  action: () => navigate(getLastHealthRoute())  },
  // Die 3er-Chords nennen ihr konkretes Ziel (Essensplan/Rezepte/Einkauf):
  // vier identische "Küche"-Zeilen im Hilfe-Modal waren nicht unterscheidbar
  // (Audit A1-13).
  { key: 'g k',   description: () => t('shortcuts.goKitchen'), action: () => navigate(getLastKitchenRoute()) },
  { key: 'g k m', description: () => t('nav.meals'),           action: () => navigate('/meals')             },
  { key: 'g k r', description: () => t('nav.recipes'),         action: () => navigate('/recipes')           },
  { key: 'g k s', description: () => t('nav.shopping'),        action: () => navigate('/shopping')          },
  { key: 'g k v', description: () => t('nav.pantry'),          action: () => navigate('/pantry')            },
  { key: 'g i', description: () => t('shortcuts.goInventory'), action: () => navigate('/inventory') },
  // Beschriftung wie bei den Kuechen-3er-Chords direkt aus den Nav-Labels -
  // kein zweiter Uebersetzungssatz. Nur die zwei Ziele mit eindeutiger
  // deutscher Merkhilfe (Budget, Einstellungen); die uebrigen Kandidaten
  // (Kontakte, Dokumente, Schichtplan, Haushaltshilfe, Belohnungen,
  // Geburtstage) warten auf eine Buchstaben-Entscheidung des Betreibers,
  // bevor sich ein unmerkbares Schema festsetzt (Critique 2026-08-31, Alex).
  { key: 'g b', description: () => t('nav.budget'),   action: () => navigate('/budget') },
  { key: 'g e', description: () => t('nav.settings'), action: () => navigate('/settings') },
];

let _pendingKey = null;
let _pendingTimer = null;
// Von initSearch gesetzt: öffnet das globale Such-Overlay (Sidebar-Item + `/`).
let _openSearch = null;

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
      <!-- Nutzerhandbuch aus der Community (#799). Es lebt in einem fremden
           Repository und in fremder Regie - deshalb steht die Herkunft im
           Linktext und nicht nur im Hinweis darunter: wer hier klickt,
           verlaesst das Projekt, und das soll er vorher wissen. -->
      <p class="help-guide">
        <a href="https://kyrodan.github.io/yuvomi-docs/" target="_blank" rel="noopener noreferrer">
          ${esc(t('help.guideLink'))}
        </a>
        <span class="help-guide__hint">${esc(t('help.guideHint'))}</span>
      </p>
    </div>
  `);

  panel.querySelector('.modal-panel__close').addEventListener('click', () => overlay.remove());
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onEsc); }
  });

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  // Die Zurueck-Geste schliesst auch diesen Dialog (#871). `attachOverlay`
  // statt `pushOverlay`, weil er auf drei Wegen per `remove()` verschwindet.
  attachOverlay(overlay, () => overlay.remove());
  if (window.lucide) window.lucide.createIcons({ el: panel });
}

// --------------------------------------------------------
// Update-Hinweis (#490)
// --------------------------------------------------------

// Zuletzt vom Server gemeldete neueste Release-Version. Persistiert, damit der
// Punkt nach einem Reload sofort wieder steht, statt bis zur nächsten Prüfung
// zu verschwinden und dann grundlos zurückzukommen.
const UPDATE_LATEST_KEY = 'yuvomi.update.latest';
const UPDATE_CHECKED_AT_KEY = 'yuvomi.update.checkedAt';

/**
 * Was DIESES KONTO zuletzt gesehen hat (#496, seit Migration 173 am Konto).
 *
 * Zwei Merker, zwei Fragen: `latest` ist die zuletzt bekannte VERÖFFENTLICHTE
 * Version und steuert den Punkt an der Navigation ("gibt es draußen etwas
 * Neueres"); `version` ist die INSTALLIERTE Version beim letzten Blick und
 * steuert die Liste ("hat sich in MEINER App etwas geändert"). Ein Haushalt auf
 * 2.55 soll nicht lesen, was 2.61 gebracht hat - bei ihm ist davon nichts
 * passiert.
 *
 * Vorher lagen beide im localStorage. Das hieß: wer am Rechner gelesen hat,
 * bekam auf dem Tablet denselben Punkt und dieselbe Liste noch einmal. Der
 * zuletzt von GitHub gemeldete Stand bleibt dagegen lokal - er ist ein
 * Zwischenspeicher für eine Auskunft des Servers, kein Zustand einer Person.
 */
function changelogSeen() {
  return currentUser?.changelog_seen || { version: null, latest: null };
}
// Der Server hält GitHub-Releases 30 Minuten im Cache; häufigeres Fragen wäre
// reiner Verkehr für eine Information, die sich um Wochen bewegt.
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Neuere Version, die noch niemand angesehen hat - oder '' wenn alles gesehen/aktuell. */
function pendingUpdateVersion() {
  const latest = localStorage.getItem(UPDATE_LATEST_KEY) || '';
  if (!latest) return '';
  if (!isNewerVersion(latest, getAppVersion())) return '';
  const seen = changelogSeen().latest || '';
  if (seen && !isNewerVersion(latest, seen)) return '';
  return latest;
}

/**
 * Setzt bzw. entfernt den Punkt an allen Einstiegen zum Änderungsverlauf.
 * Auf Mobil liegt der Eintrag im „Mehr"-Sheet - ohne Punkt am Sheet-Button
 * bliebe der Hinweis dort unsichtbar, deshalb bekommt auch dieser einen.
 */
function toggleUpdateDot(el, on) {
  const existing = el.querySelector('.nav-dot');
  if (!on) { existing?.remove(); return; }
  if (existing) return;
  const dot = document.createElement('span');
  dot.className = 'nav-dot';
  dot.setAttribute('aria-hidden', 'true');
  // Am Icon-Well hängt der Punkt auch in der eingeklappten Sidebar am richtigen
  // Fleck; die Listenzeile im „Mehr"-Sheet hat keins.
  (el.querySelector('.nav-item__icon-wrap') ?? el).appendChild(dot);
}

/**
 * Der Punkt ist rein visuell - die Ansage steckt im Namen des Elements.
 * Ohne `version` bleibt der Name unverändert.
 */
function withUpdateHint(label, version) {
  if (!version) return label;
  return `${label} - ${t('changelog.updateAvailable', { version: displayVersion(version) })}`.trim();
}

function applyUpdateBadge() {
  const version = pendingUpdateVersion();
  for (const el of document.querySelectorAll('.nav-item--changelog, .more-item--changelog, #more-btn')) {
    toggleUpdateDot(el, Boolean(version));
  }
  // Den Namen des „Mehr"-Buttons setzt setMoreButtonState bei jeder Navigation
  // neu; sein Zusatz gehört deshalb dorthin und nicht hierher, sonst wäre er
  // nach dem ersten Seitenwechsel wieder weg.
  for (const el of document.querySelectorAll('.nav-item--changelog, .more-item--changelog')) {
    const label = withUpdateHint(t('nav.changelog'), version);
    el.setAttribute('aria-label', label);
    if (el.hasAttribute('title')) el.setAttribute('title', label);
  }
}

/**
 * Fragt den Änderungsverlauf-Proxy nach der neuesten Version. Bewusst still:
 * schlägt der Abruf fehl (kein Netz, GitHub nicht erreichbar), bleibt der zuletzt
 * bekannte Stand stehen - eine Fehlermeldung für eine Nebeninformation wäre Lärm.
 */
async function checkForUpdate({ force = false } = {}) {
  const lastCheck = Number(localStorage.getItem(UPDATE_CHECKED_AT_KEY) || 0);
  const age = Date.now() - lastCheck;
  if (!force && lastCheck && age >= 0 && age < UPDATE_CHECK_INTERVAL_MS) {
    applyUpdateBadge();
    return;
  }

  try {
    const payload = await api.get('/changelog');
    const latest = String(payload?.data?.latest_version || '').trim();
    // Der mitgelieferte Stand beantwortet die Update-Frage nicht - er kennt
    // per Konstruktion nichts Neueres als sich selbst. Der Zeitstempel bleibt
    // deshalb stehen, sonst gaelte die Frage sechs Stunden lang als geklaert,
    // obwohl GitHub gar nicht geantwortet hat (#838).
    if (payload?.data?.source !== 'local') {
      localStorage.setItem(UPDATE_CHECKED_AT_KEY, String(Date.now()));
    }
    if (latest) localStorage.setItem(UPDATE_LATEST_KEY, latest);
  } catch { /* still: siehe oben */ }
  applyUpdateBadge();
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

/**
 * Ein Eintrag als Vorspann plus aufklappbare Begruendung.
 *
 * DAS IST DER KERN VON #496. Der Changelog erzaehlt seit v2.41.0 zweistufig -
 * ein fett gesetzter Satz, der die Aenderung benennt, darunter warum. Die
 * Ansicht hat diese Stufe bisher eingeebnet und daraus wieder Prosa gemacht.
 * Wer scannen will, liest jetzt nur die Vorspaenne; wer die Geschichte will,
 * klappt sie auf.
 *
 * Ohne Begruendung (Eintraege vor 2.41.0) gibt es nichts aufzuklappen - dann
 * steht der Vorspann allein, ohne Zusammenklapp-Dreieck, das nichts verbirgt.
 */
function entryNode(entry) {
  const li = document.createElement('li');
  const lead = String(entry?.lead || '');
  const detail = String(entry?.detail || '');
  if (!detail) {
    li.className = 'changelog-entry changelog-entry--plain';
    li.textContent = lead;
    return li;
  }
  li.className = 'changelog-entry';
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.className = 'changelog-entry__lead';
  summary.textContent = lead;
  const body = document.createElement('p');
  body.className = 'changelog-entry__detail';
  body.textContent = detail;
  details.appendChild(summary);
  details.appendChild(body);
  li.appendChild(details);
  return li;
}

/**
 * Die Eintraege einer Section - aus `entries`, sonst aus `items`.
 *
 * Der Rueckfall ist kein Schmuck: `items` ist die Form, die diese Route seit
 * jeher liefert, und ein Client, der gegen einen aelteren Server laeuft (oder
 * gegen einen Cache davon), bekommt sonst eine leere Liste statt der Texte.
 */
function sectionEntries(section) {
  if (Array.isArray(section?.entries) && section.entries.length) return section.entries;
  return (Array.isArray(section?.items) ? section.items : [])
    .map((item) => ({ lead: String(item || ''), detail: '' }));
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
  for (const entry of sectionEntries(section)) list.appendChild(entryNode(entry));
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

// Wie viele Vorspaenne die "Neu bei dir"-Liste hoechstens zeigt. Wer nach
// zwanzig Versionen aktualisiert, soll eine LISTE bekommen und keine zweite
// Textwand - der Rest steht darunter, und die Zahl wird genannt statt still
// abgeschnitten.
const WHATS_NEW_MAX = 12;

/**
 * Der Block, mit dem die Ansicht oeffnet: was sich seit dem letzten Blick
 * geaendert hat, als Liste der Vorspaenne (#496).
 *
 * BEIM ERSTEN OEFFNEN bleibt er weg. Ohne frueheren Stand gibt es keine
 * Aussage darueber, was jemand verpasst hat - alles zu zeigen waere die
 * Behauptung, er haette alles verpasst.
 */
function appendWhatsNew(parent, releases, currentVersion, seenInstalled) {
  const fresh = releasesNewForMe(releases, currentVersion, seenInstalled);
  if (!fresh.length) return;

  const entries = fresh.flatMap((release) =>
    (Array.isArray(release.sections) ? release.sections : []).flatMap(sectionEntries));
  if (!entries.length) return;

  const box = document.createElement('section');
  box.className = 'changelog-whats-new';

  const title = document.createElement('h3');
  title.className = 'changelog-whats-new__title';
  title.textContent = t('changelog.whatsNewTitle');
  box.appendChild(title);

  const since = document.createElement('p');
  since.className = 'changelog-whats-new__since';
  since.textContent = t('changelog.whatsNewSince', { version: displayVersion(seenInstalled) });
  box.appendChild(since);

  const list = document.createElement('ul');
  list.className = 'changelog-section__list';
  for (const entry of entries.slice(0, WHATS_NEW_MAX)) list.appendChild(entryNode(entry));
  box.appendChild(list);

  const hidden = entries.length - WHATS_NEW_MAX;
  if (hidden > 0) {
    const more = document.createElement('p');
    more.className = 'changelog-whats-new__more';
    more.textContent = t('changelog.whatsNewMore', { count: hidden });
    box.appendChild(more);
  }
  parent.appendChild(box);
}

function renderChangelog(panel, payload) {
  const data = payload?.data ?? {};
  const currentVersion = data.current_version;
  const latestVersion = data.latest_version;
  const releases = Array.isArray(data.releases) ? data.releases : [];

  panel.querySelector('#changelog-current-version').textContent = versionText(currentVersion);
  panel.querySelector('#changelog-latest-version').textContent = versionText(latestVersion);

  // Steht ein Update an, ist das die Nachricht - ob die laufende Version in der
  // GitHub-Liste auftaucht, interessiert dann niemanden mehr.
  //
  // Der mitgelieferte Stand geht beidem vor: er kann per Konstruktion nichts
  // ueber neuere Versionen wissen, also waere sowohl "Version X ist verfuegbar"
  // als auch "diese Version steht in den GitHub-Releases" eine Aussage ueber
  // etwas, das gerade niemand nachsehen konnte (#838).
  const local = data.source === 'local';
  const updateAvailable = !local && isNewerVersion(latestVersion, currentVersion);
  const note = panel.querySelector('#changelog-version-note');
  if (local) {
    note.textContent = t('changelog.offlineNotice');
  } else if (updateAvailable) {
    note.textContent = t('changelog.updateAvailable', { version: displayVersion(latestVersion) });
  } else {
    note.textContent = data.current_in_releases
      ? t('changelog.currentFound')
      : t('changelog.currentMissing');
  }
  note.classList.toggle('changelog-version-note--warning', local || (!updateAvailable && !data.current_in_releases));
  note.classList.toggle('changelog-version-note--update', updateAvailable);

  // Der Nutzer sieht die Liste gerade - der Punkt an der Navigation hat seinen
  // Zweck erfüllt und verschwindet, bis eine noch neuere Version erscheint.
  if (latestVersion) {
    localStorage.setItem(UPDATE_LATEST_KEY, String(latestVersion));
    localStorage.setItem(UPDATE_CHECKED_AT_KEY, String(Date.now()));
  }

  const status = panel.querySelector('#changelog-status');
  if (status) status.hidden = true;

  const list = panel.querySelector('#changelog-list');
  list.replaceChildren();
  if (!releases.length) {
    renderChangelogStatus(panel, t('changelog.empty'), 'muted');
    return;
  }

  const fragment = document.createDocumentFragment();
  // Erst lesen, dann fortschreiben: der Block beantwortet die Frage nach dem
  // ZUSTAND VOR diesem Aufruf, und ein Marker, der schon gesetzt ist, waere
  // die Antwort "nichts Neues" - jedes Mal.
  const seenInstalled = changelogSeen().version || '';
  appendWhatsNew(fragment, releases, currentVersion, seenInstalled);
  for (const release of releases) appendReleaseCard(fragment, release, currentVersion);
  list.appendChild(fragment);
  markChangelogSeen(latestVersion);
}

/**
 * Beide Merker am Konto fortschreiben, nachdem die Liste gezeigt wurde.
 *
 * AUCH BEIM ERSTEN MAL, obwohl dann nichts angezeigt wurde: sonst gilt der
 * nächste Aufruf wieder als erster und die Liste bliebe für immer leer.
 *
 * Der lokale Stand wird sofort mitgezogen, damit der Punkt in derselben
 * Sekunde verschwindet - auf die Antwort des Servers zu warten hieße, ihn
 * einen Wimpernschlag lang stehen zu lassen, nachdem man gelesen hat. Ein
 * Fehlschlag bleibt still: dann steht der Punkt beim nächsten Laden wieder da,
 * was lästig, aber ehrlich ist.
 */
function markChangelogSeen(latestVersion) {
  const seen = changelogSeen();
  if (currentUser) {
    currentUser.changelog_seen = {
      version: getAppVersion() || seen.version,
      latest: latestVersion || seen.latest,
    };
  }
  applyUpdateBadge();
  api.post('/auth/changelog-seen', latestVersion ? { latest: String(latestVersion) } : {})
    .catch(() => { /* still: siehe oben */ });
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

  // Der Marker der Zurueck-Geste, solange das Blatt offen ist (#871).
  let sheetOverlayToken = null;

  function openSheet() {
    lastFocusedBeforeSheet = document.activeElement;
    sheetOverlayToken = pushOverlay(() => closeSheet());
    setOverlayInteractive(sheet, true);
    sheet.addEventListener('keydown', moreSheetTrap);
    backdrop.classList.add('more-backdrop--visible');
    currentMoreBtn().setAttribute('aria-expanded', 'true');
    sheet.querySelector('#more-sheet-search, [data-route]')?.focus();
    if (window.lucide) window.lucide.createIcons({ el: sheet });
    /* ZUERST AUS DEM SPEICHER, DANN NACHZIEHEN.
     *
     * Der Speicher ist beim Oeffnen in der Regel schon warm: seit #868 holt
     * ihn der Shell-Aufbau, weil die Nav-Badges daran haengen. Ohne die erste
     * Zeile faenden die Kacheln davon nichts - `refreshModuleCounts()` gaebe
     * innerhalb seiner TTL `false` zurueck („nichts Neues"), und die Wache
     * darunter uebersprang das Zeichnen. Die Kacheln blieben dann bis zu 60
     * Sekunden nach dem Anmelden leer, obwohl die Zahlen im Speicher lagen -
     * derselbe Fehler, den dieser Fix fuer die Nav-Badges behebt, nur eine
     * Ebene versetzt.
     *
     * Das Nachziehen bleibt: das Sheet steht sofort, frische Zahlen kommen,
     * sobald die Antwort da ist. */
    paintMoreSheetBadges(sheet);
    refreshModuleCounts().then((fresh) => {
      if (fresh && sheet.getAttribute('aria-hidden') !== 'true') paintMoreSheetBadges(sheet);
    });
  }

  function closeSheet({ restoreFocus = true } = {}) {
    if (sheet.getAttribute('aria-hidden') === 'true') return;
    if (sheetOverlayToken !== null) {
      const token = sheetOverlayToken;
      sheetOverlayToken = null;
      dropOverlay(token);
    }
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

  /* WISCHEN SCHLIESST NUR VOM ANFANG DER LISTE AUS.
   *
   * Vorher schloss jede Abwaertsbewegung ueber 60px das Blatt, egal wo sie
   * begann. Seit `.more-sheet__body` scrollt (die Obergrenze gegen den
   * Blattueberstand bei 320px), IST diese Geste auch das Zurueckscrollen in den
   * Gruppen: wer unten steht und nach oben zurueckwischt, bewegt den Finger
   * abwaerts und schloss damit das Blatt (PR-Review #754).
   *
   * Der Stand wird beim BEGINN der Geste gemerkt, nicht am Ende: bis dahin hat
   * der Scroller laengst reagiert und stuende auch nach einem echten
   * Zieh-zum-Schliessen auf 0. */
  let _touchStartY = 0;
  let _touchStartAtTop = true;
  sheet.addEventListener('touchstart', (e) => {
    _touchStartY = e.touches[0].clientY;
    const body = sheet.querySelector('.more-sheet__body');
    _touchStartAtTop = !body || body.scrollTop <= 0;
  }, { passive: true });
  sheet.addEventListener('touchend', (e) => {
    if (!_touchStartAtTop) return;
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
// Durchsuchbare Domänen des /search-Endpunkts, in Anzeige-Reihenfolge. Dienen
// im Leerzustand als Direktsprung-Kacheln (labelKey/icon gespiegelt aus der
// Haupt-Navigation, damit Suche und Nav dieselbe Sprache sprechen).
const SEARCH_SCOPES = [
  { labelKey: 'nav.tasks',    route: '/tasks'    },
  { labelKey: 'nav.calendar', route: '/calendar' },
  { labelKey: 'nav.notes',    route: '/notes'    },
  { labelKey: 'nav.contacts', route: '/contacts' },
  { labelKey: 'nav.shopping', route: '/shopping' },
  { labelKey: 'nav.health',   route: '/health'   },
];

function initSearch(container) {
  const searchClose = container.querySelector('#search-close');
  const overlay      = container.querySelector('#search-overlay');
  const input        = container.querySelector('#search-input');
  const results      = container.querySelector('#search-results');
  const status       = container.querySelector('#search-status');
  if (!overlay || !input || !results) return null;

  function setStatus(text) {
    if (status) status.textContent = text || '';
  }

  // Leichtgewichtiger Focus Trap für das Search Overlay.
  // Eigenständig (kein modal.js), da modul-globale Variablen in modal.js
  // bei gleichzeitig offenem Modal überschrieben würden.
  let _searchTrapHandler = null;
  let lastFocusedBeforeSearch = null;

  // Leerzustand mit Erwartungshilfe + Direktsprung: statt einer leeren Fläche
  // erklärt die Lead-Zeile, was ab 2 Zeichen durchsucht wird, und darunter
  // führen Scope-Kacheln direkt ins jeweilige Modul (Critique P1: der leere
  // Zustand war der wertvollste, aber ungenutzte Moment der Palette).
  function renderSearchHint() {
    results.replaceChildren();
    results.removeAttribute('aria-busy');
    setStatus('');
    results.appendChild(emptyHintEl(t('search.emptyHint')));

    const scopes = document.createElement('div');
    scopes.className = 'search-scopes';
    const scopesHeading = document.createElement('h3');
    scopesHeading.className = 'search-section__heading';
    scopesHeading.textContent = t('search.scopesLabel');
    scopes.appendChild(scopesHeading);
    const list = document.createElement('div');
    list.className = 'search-scopes__list';
    SEARCH_SCOPES.forEach((scope) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'search-scope';
      // Markensiegel (Herkunfts-Regel, Block 2): die Kachel benennt ihr
      // Zielmodul ueber Familienton + Icon; der Slug ist die Route selbst.
      const seal = document.createElement('span');
      seal.className = 'module-seal module-seal--sm search-scope__seal';
      seal.setAttribute('aria-hidden', 'true');
      seal.style.setProperty('--seal-accent', moduleAccentVar(scope.route.slice(1)));
      seal.appendChild(moduleIconEl(MODULE_ICON[scope.route.slice(1)]));
      const label = document.createElement('span');
      label.textContent = t(scope.labelKey);
      btn.append(seal, label);
      btn.addEventListener('click', () => {
        closeSearch({ restoreFocus: false });
        navigate(scope.route);
      });
      list.appendChild(btn);
    });
    scopes.appendChild(list);
    results.appendChild(scopes);
    // Auch aus dem input-Handler (< 2 Zeichen) aufgerufen, wo openSearch die
    // Icons nicht nachzieht — daher hier selbst rendern.
    window.lucide?.createIcons({ el: results });
  }

  // Der Marker der Zurueck-Geste, solange die Suche offen ist (#871).
  let searchOverlayToken = null;

  function openSearch() {
    if (window._closeMoreSheet) window._closeMoreSheet({ restoreFocus: false });
    lastFocusedBeforeSearch = document.activeElement;
    if (searchOverlayToken === null) searchOverlayToken = pushOverlay(() => closeSearch());
    setOverlayInteractive(overlay, true);
    overlay.classList.add('search-overlay--visible');
    if (!input.value.trim()) renderSearchHint();
    setTimeout(() => input.focus(), 50);
    if (window.lucide) window.lucide.createIcons({ el: overlay });

    _searchTrapHandler = createFocusTrap(overlay);
    overlay.addEventListener('keydown', _searchTrapHandler);
  }

  function closeSearch({ restoreFocus = true } = {}) {
    if (searchOverlayToken !== null) {
      const token = searchOverlayToken;
      searchOverlayToken = null;
      dropOverlay(token);
    }
    // Laufenden Debounce abbrechen: sonst feuert ein noch offener Timer nach dem
    // Schließen ins versteckte Overlay und macht eine Phantom-Live-Ansage.
    clearTimeout(searchTimer);
    setOverlayInteractive(overlay, false);
    overlay.classList.remove('search-overlay--visible');
    if (_searchTrapHandler) {
      overlay.removeEventListener('keydown', _searchTrapHandler);
      _searchTrapHandler = null;
    }
    input.value = '';
    results.replaceChildren();
    results.removeAttribute('aria-busy');
    setStatus('');
    if (restoreFocus) returnFocus(lastFocusedBeforeSearch);
  }

  if (searchClose) searchClose.addEventListener('click', closeSearch);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('search-overlay--visible')) {
      closeSearch();
    }
  });

  // Pfeiltasten führen vom Suchfeld durch die Treffer (Audit A1-14): Enter
  // aktiviert den fokussierten Treffer nativ (Buttons), Esc schließt.
  overlay.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const hits = [...results.querySelectorAll('.search-result')];
    if (!hits.length) return;
    e.preventDefault();
    const idx = hits.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      (idx < 0 ? hits[0] : hits[Math.min(idx + 1, hits.length - 1)]).focus();
    } else if (idx > 0) {
      hits[idx - 1].focus();
    } else if (idx === 0) {
      input.focus();
    }
  });

  let searchTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (q.length < 2) {
      renderSearchHint();
      return;
    }
    searchTimer = setTimeout(async () => {
      // Ladezustand erst wenn der Fetch wirklich startet (nach dem Debounce):
      // Skeletons + „Suche läuft…" statt einer eingefroren wirkenden Fläche auf
      // langsamem Home-Server (Critique P1). Kein Flackern bei schnellem Tippen.
      results.replaceChildren();
      results.setAttribute('aria-busy', 'true');
      results.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 4, lines: 2 }));
      setStatus(t('search.loading'));
      try {
        const data = await api.get(`/search?q=${encodeURIComponent(q)}`);
        const count = renderSearchResults(results, data, () => closeSearch({ restoreFocus: false }));
        results.setAttribute('aria-busy', 'false');
        setStatus(
          count === 0 ? t('search.noResults')
            : count === 1 ? t('search.resultCountOne', { count })
            : t('search.resultCountMany', { count }),
        );
      } catch {
        // Fehler nicht verschlucken: sichtbare Meldung statt „wirkt wie 0 Treffer".
        // Die Ansage besitzt jetzt #search-status; der sichtbare Text bleibt rein
        // visuell (kein role=status), sonst läse der Screenreader ihn doppelt.
        results.replaceChildren();
        results.setAttribute('aria-busy', 'false');
        results.appendChild(emptyHintEl(t('search.error')));
        setStatus(t('search.error'));
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
  const { tasks = [], events = [], notes = [], contacts = [], items = [], meds = [], activities = [], waste = [] } = data;
  const total = tasks.length + events.length + notes.length + contacts.length + items.length
    + meds.length + activities.length + waste.length;

  if (total === 0) {
    container.appendChild(emptyHintEl(t('search.noResults')));
    return 0;
  }

  // Aktivitätstyp lokalisieren (Preset via labelKey, Freitext unverändert).
  const activityLabel = (item) => {
    const preset = activityType(item.title);
    return preset ? t(preset.labelKey) : item.title;
  };

  // Die Suche ist DIE Mischstelle der App (Herkunfts-Regel, Block 2): jede
  // Sektion traegt das Markensiegel ihres Herkunftsmoduls im Kopf; innerhalb
  // der Sektion ist die Herkunft damit selbstverstaendlich, die Zeilen
  // bleiben siegelfrei. Die Zeilen selbst liegen in GENAU EINEM Traeger
  // (Zeilenlisten-Regel) statt als Karte pro Treffer.
  function makeSection(labelKey, sealModule, items, routeFn, labelFn, metaFn) {
    if (!items.length) return;
    const section = document.createElement('div');
    section.className = 'search-section';
    const heading = document.createElement('h3');
    heading.className = 'search-section__heading';
    if (sealModule) {
      const sealEl = document.createElement('span');
      sealEl.className = 'module-seal module-seal--sm';
      sealEl.setAttribute('aria-hidden', 'true');
      sealEl.style.setProperty('--seal-accent', moduleAccentVar(sealModule));
      sealEl.appendChild(moduleIconEl(MODULE_ICON[sealModule]));
      heading.appendChild(sealEl);
    }
    heading.appendChild(document.createTextNode(t(labelKey)));
    section.appendChild(heading);
    const rows = document.createElement('div');
    rows.className = 'search-section__rows';
    items.forEach((item) => {
      const btn = document.createElement('button');
      btn.className = 'search-result';
      const title = document.createElement('span');
      title.className = 'search-result__title';
      title.textContent = labelFn ? labelFn(item) : item.title;
      btn.appendChild(title);
      // Zweitzeile mit Datum/Detail: Treffer ohne jeden Kontext waren nicht
      // unterscheidbar (Audit A1-14).
      const metaText = metaFn?.(item);
      if (metaText) {
        const meta = document.createElement('span');
        meta.className = 'search-result__meta';
        meta.textContent = metaText;
        btn.appendChild(meta);
      }
      btn.addEventListener('click', () => {
        onClose();
        navigate(routeFn(item));
      });
      rows.appendChild(btn);
    });
    section.appendChild(rows);
    container.appendChild(section);
  }

  makeSection('nav.tasks',    'tasks',    tasks,    (i) => `/tasks?open=${i.id}`, null,
    (i) => (i.due_date ? formatDate(i.due_date) : ''));
  makeSection('nav.calendar', 'calendar', events,   (i) => `/calendar?open=${i.id}`, null,
    (i) => (i.start_datetime ? `${formatDate(i.start_datetime)}${i.all_day ? '' : ` · ${formatTime(i.start_datetime)}`}` : ''));
  makeSection('nav.notes',    'notes',    notes,    (i) => `/notes?open=${i.id}`);
  makeSection('nav.contacts', 'contacts', contacts, (i) => `/contacts?open=${i.id}`);
  makeSection('nav.shopping', 'shopping', items,    (i) => `/shopping?list=${i.list_id}&highlight=${i.id}`);
  makeSection('health.tabs.meds',     'health', meds,       () => '/health/meds', null,
    (i) => i.dosage_text || '');
  makeSection('health.tabs.activity', 'health', activities, () => '/health/activity', activityLabel,
    (i) => (i.performed_at ? formatDate(i.performed_at) : ''));
  makeSection('nav.waste', 'waste', waste, (i) => `/waste?type=${i.id}`);

  // Die Siegel-Icons kommen als data-lucide-Platzhalter; der Treffer-Pfad
  // rendert sie selbst (der Leerzustands-Pfad tut es bereits genauso).
  window.lucide?.createIcons({ el: container });

  return total;
}

// Read-only-Modus für ein Modul anwenden (#467): FAB via <html data-module-readonly>
// ausblenden (CSS) und einen erklärenden Banner oben in die Seite einfügen.
// navModuleAccess liefert 'write' für nicht-gateable Module (Dashboard, Settings,
// Third-Party), sodass diese nie fälschlich als read-only markiert werden.
/**
 * Die Seitenwurzel eines Erweiterungsmoduls: `.app-page` im erklaerten Modus,
 * mit `--page-measure` gesetzt und `page.width` als Verfeinerung daran
 * (layout.css). Das Modul bekommt DIESE Wurzel als `container` und baut darin
 * Kopf und Koerper mit den Helfern aus /utils/page-layout.js - Geometrie
 * gehoert dem Kern, nicht dem Modul.
 *
 * Der Modus ist serverseitig normalisiert (services/modules.js); der Rueckfall
 * hier faengt nur einen manipulierten oder veralteten Listeneintrag ab.
 */
function mountExtensionPage(wrapper, thirdPartyModule) {
  const page = thirdPartyModule?.page || {};
  const mode = COMPOSITION_MODES.includes(page.composition) ? page.composition : 'reading';
  const root = document.createElement('div');
  root.className = `app-page app-page--${mode} extension-page`;
  root.dataset.composition = mode;
  if (page.width) root.dataset.pageWidth = String(page.width);
  wrapper.appendChild(root);
  return root;
}

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

function navItems({ catalog = false } = {}) {
  if (currentUser?.access_scope === 'split_guest') {
    return [
      { path: '/budget', label: t('splitExpenses.tabLabel'), icon: MODULE_ICON['split-expenses'], module: 'budget' },
    ];
  }
  /* DAS ZEICHEN STEHT NICHT HIER, SONDERN IN MODULE_ICON (nav-icons.js).
   *
   * Es stand hier, und daneben ein zweites Mal im Dashboard (`widgetIcon`) und
   * ein drittes Mal in der Kachelreihe - drei Tabellen fuer eine Zuordnung, und
   * sie sind auseinandergelaufen: Notizen fuehrte in der Leiste einen Zettel
   * und im Widget-Kopf eine Stecknadel, Haushaltshilfe hier einen Pinsel und
   * auf der Kachel Funkeln. Die Liste unten sagt jetzt, WAS es gibt und wo es
   * steht; WIE es aussieht, sagt eine Stelle. */
  const withIcon = (item) => ({ ...item, icon: MODULE_ICON[item.module] });
  const baseItems = [
    // Overview
    { path: '/',          label: t('nav.dashboard'), module: 'dashboard', section: NAV_SECTION.overview },
    // Plan
    { path: '/calendar',  label: t('nav.calendar'),  module: 'calendar',  section: NAV_SECTION.plan },
    { path: '/schedule',  label: t('nav.schedule'),  module: 'schedule',  section: NAV_SECTION.plan },
    { path: '/tasks',     label: t('nav.tasks'),     module: 'tasks',     section: NAV_SECTION.plan },
    { path: '/notes',     label: t('nav.notes'),     module: 'notes',     section: NAV_SECTION.plan },
    // Haushalt — Kitchen-Gruppe zuerst, dann die übrigen Haushalts-Module
    { path: '/meals',     label: t('nav.meals'),     module: 'meals',    section: NAV_SECTION.household, kitchenGroup: true },
    { path: '/recipes',   label: t('nav.recipes'),   module: 'recipes',  section: NAV_SECTION.household, kitchenGroup: true },
    { path: '/shopping',  label: t('nav.shopping'),  module: 'shopping', section: NAV_SECTION.household, kitchenGroup: true },
    { path: '/pantry',    label: t('nav.pantry'),    module: 'pantry',   section: NAV_SECTION.household, kitchenGroup: true },
    { path: '/housekeeping', label: t('nav.housekeeping'), module: 'housekeeping', section: NAV_SECTION.household },
    { path: '/waste',     label: t('nav.waste'),     module: 'waste',    section: NAV_SECTION.household },
    { path: '/documents', label: t('nav.documents'), module: 'documents',   section: NAV_SECTION.household },
    { path: '/inventory', label: t('nav.inventory'), module: 'inventory',   section: NAV_SECTION.household },
    { path: '/rewards',   label: t('nav.rewards'),   module: 'rewards',     section: NAV_SECTION.household },
    // Menschen
    { path: '/contacts',  label: t('nav.contacts'),  module: 'contacts',    section: NAV_SECTION.people },
    { path: '/birthdays', label: t('nav.birthdays'), module: 'birthdays',   section: NAV_SECTION.people },
    { path: '/health',    label: t('nav.health'),    module: 'health',      section: NAV_SECTION.people },
    // Finanzen
    { path: '/budget',    label: t('nav.budget'),    module: 'budget',      section: NAV_SECTION.finance },
    // Settings ist am Ende gepinnt (siehe unten).
    { path: '/settings',  navHref: '/settings?view=domains', label: t('nav.settings'),  module: 'settings',    section: NAV_SECTION.household },
  ].map(withIcon);
  const thirdPartyItems = _thirdPartyModules
    .filter((module) => module.enabled && module.status === 'enabled' && module.menu?.show && module.route?.path)
    .map((module) => ({
      path: module.route.path,
      label: moduleDisplayLabel(module),
      icon: module.menu.icon || module.icon || 'box',
      module: `third-party-${module.id}`,
      accent: module.accent,
      order: module.menu.order ?? 1000,
      orderId: `third-party-${module.id}`,
      section: NAV_SECTION.customModules,
    }))
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  const settings = baseItems.find((item) => item.module === 'settings');
  /* DER KATALOG IST NICHT DIE NAVIGATION.
   *
   * `navItems()` ist eine Liste von Zielen, die jemand ANKLICKEN kann - also
   * gefiltert. Zwei Stellen lasen daraus aber Metadaten: der Routen-Ansager
   * holt sich das Label und `headSealIcon()` das Symbol. Solange nur
   * abgeschaltete oder gesperrte Module fehlten, fiel das nicht auf; die
   * gehoeren wirklich nirgends hin. Seit #673 kann ein Modul aber sichtbar
   * ERREICHBAR und trotzdem aus der Navigation genommen sein - genau der Fall,
   * fuer den die Trennung gebaut ist. Wer ihn per Deep-Link oeffnete, bekam
   * "/calendar" angesagt statt "Kalender" und einen Kopf ohne Siegel
   * (Codex-Review zu PR #790). */
  const all = [...baseItems, ...thirdPartyItems];
  if (catalog) return all;
  const sortable = [
    ...baseItems.filter((item) =>
      item.module !== 'settings'
      && !_disabledModules.has(item.module)
      && !_hiddenModules.has(item.module)
      && canAccessNavModule(item.module)),
    ...thirdPartyItems,
  ];
  const ordered = sortNavigationItems(sortable, _moduleOrder);
  return settings ? [...ordered, settings] : ordered;
}

/** Alle Module mit ihren Metadaten - ungefiltert. Fuer Label und Symbol. */
function navCatalog() {
  return navItems({ catalog: true });
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
            icon: MODULE_ICON.kitchen,
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
  // Zwei entkoppelte Elemente hinter den Nav-Items (z-index: 0):
  // 1. Die persistente Aktiv-Pille bleibt am aktiven Item verankert — sie wandert
  //    NICHT beim Hover, damit „Du bist hier" beim Erkunden erhalten bleibt.
  // 2. Die zarte Hover-Vorschau folgt Hover/Fokus (leiser, ohne Glas-Blur) und
  //    ist die einzige, die sich beim Zeigen bewegt.
  const indicator = document.createElement('div');
  indicator.className = 'nav-sidebar__indicator';
  indicator.setAttribute('aria-hidden', 'true');
  elements.push(indicator);

  const hover = document.createElement('div');
  hover.className = 'nav-sidebar__hover';
  hover.setAttribute('aria-hidden', 'true');
  elements.push(hover);

  let kitchenAdded = false;
  let currentSection = null;
  let currentGroup = null;

  // Die Übersicht (Dashboard) ist die App-Wurzel und sitzt als einzelnes Item
  // ganz oben — ohne „Übersicht"-Sektionsheader über einem „Übersicht"-Item
  // (Stutter). Sie rendert als direktes Kind, ohne Gruppe/Label.
  const HEADERLESS_SECTIONS = new Set([NAV_SECTION.overview]);

  // Jede sichtbare Sektion wird ein role="group" mit aria-labelledby auf ihr Label
  // — so ist die visuelle Gruppierung für Screenreader hörbar (statt verwaister
  // Label-Divs zwischen Links). Items landen im aktuellen Gruppen-Container.
  const startSection = (section) => {
    if (section === currentSection) return;
    currentSection = section;
    if (HEADERLESS_SECTIONS.has(section)) { currentGroup = null; return; }
    const labelKey = NAV_SECTION_LABEL_KEYS[section];
    if (!labelKey) { currentGroup = null; return; }
    const labelId = `nav-section-${section}`;
    const label = document.createElement('div');
    label.className = 'nav-section-label';
    label.id = labelId;
    label.textContent = t(labelKey);
    const group = document.createElement('div');
    group.className = 'nav-sidebar__group';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-labelledby', labelId);
    group.appendChild(label);
    elements.push(group);
    currentGroup = group;
  };

  const appendNavEl = (el) => {
    (currentGroup ?? { appendChild: (n) => elements.push(n) }).appendChild(el);
  };

  navItems().forEach((item) => {
    // Settings ist gepinnt und gehört zu keiner sichtbaren Sektionsgruppe —
    // der Aufrufer hebt es aus der Liste heraus und hängt es als Geschwister
    // an die Sidebar-Spalte (siehe dort, und layout.css zum entfallenen Rand).
    if (item.module !== 'settings') startSection(item.section);

    if (item.kitchenGroup) {
      if (!kitchenAdded) {
        appendNavEl(sidebarKitchenEl());
        kitchenAdded = true;
      }
      return;
    }
    const el = navItemEl(item);
    if (item.module === 'settings') {
      // Ans Sidebar-Ende pinnen — über eine explizite Klasse statt
      // ":last-child a". Der Aufrufer erkennt sie und hängt den Eintrag
      // ausserhalb des Scrollers ein.
      el.classList.add('nav-item--pinned-end');
      elements.push(el);
      return;
    }
    appendNavEl(el);
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

function setHiddenModules(modules) {
  _hiddenModules = new Set(Array.isArray(modules) ? modules : []);
  // Zaehlstaende und Neuaufbau aus demselben Grund wie beim Haushalts-Schalter
  // darunter: die Kuechenkachel fasst vier Module zusammen, und ob ihr
  // Einkaufszaehler gilt, entscheidet `navItems()`.
  resetModuleCounts();
  rebuildNavigation();
}

function setDisabledModules(modules) {
  _disabledModules = new Set(Array.isArray(modules) ? modules : []);
  /* Die Zaehlstaende haengen an der Modulliste, nicht nur an der Sitzung: die
   * Kuechenkachel fasst vier Module zusammen, und ob ihr Einkaufszaehler gilt,
   * entscheidet `navItems()`. Schaltet eine Adminin den Einkauf ab, waere die
   * gecachte Zahl bis zu 60s lang noch die alte (Codex-Review zu PR #754,
   * Folgebefund des Cache-Fixes). */
  resetModuleCounts();
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

/* Der Auflöser Modul → Ton steht in `/utils/module-accent.js`. Er war bis
 * 2026-08-18 hier privat, und deshalb hatte die Modul-Liste der Einstellungen
 * keinen - Begründung dort. Die Aussage bleibt dieselbe: die Küche ist im
 * ROUTING vier Module (vier Einträge in ROUTES mit vier eigenen
 * `module:`-Werten), in NAVIGATION, AKZENT und STATUSBAR aber eines; ein
 * Farbwechsel beim Tabwechsel sendete dieselbe Botschaft wie ein Modulwechsel
 * (Critique 2026-07-29). */

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
  else if (mod) a.style.setProperty('--item-module-accent', moduleAccentVar(mod));
  const iconWrap = document.createElement('div');
  iconWrap.className = 'nav-item__icon-wrap';
  const well = document.createElement('div');
  well.className = 'nav-item__icon-well';
  well.appendChild(moduleIconEl(icon, 'nav-item__icon'));
  iconWrap.appendChild(well);
  const span = document.createElement('span');
  span.className = 'nav-item__label';
  span.textContent = label;
  a.appendChild(iconWrap);
  a.appendChild(span);
  return a;
}

function kitchenNavButtonEl() {
  const kitchenBtn = document.createElement('button');
  kitchenBtn.className = 'nav-item nav-item--kitchen';
  kitchenBtn.id = 'kitchen-btn';
  kitchenBtn.type = 'button';
  kitchenBtn.dataset.navId = 'kitchen';
  // Konstant: EIN Eintrag, EIN Akzent. Vorher folgte er dem aktiven Sub-Tab und
  // wechselte orange → teal → pink → oliv, obwohl der Nutzer das Modul nicht
  // verlassen hat (Critique 2026-07-29).
  kitchenBtn.style.setProperty('--item-module-accent', 'var(--module-kitchen)');
  kitchenBtn.setAttribute('aria-label', t('nav.kitchen'));
  kitchenBtn.setAttribute('title', t('nav.kitchen'));

  const iconWrap = document.createElement('div');
  iconWrap.className = 'nav-item__icon-wrap';
  const well = document.createElement('div');
  well.className = 'nav-item__icon-well';
  well.appendChild(moduleIconEl(MODULE_ICON.kitchen, 'nav-item__icon'));
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
  // KEIN --item-module-accent: „Mehr" ist kein Modul, sondern ein Ueberlauf.
  // Hier stand `var(--color-accent)`, gesetzt fuer den Fokusring, den die
  // Eine-Stimme-Regel seither aus der Leiste genommen hat - eine Zeile, die
  // ihren Grund ueberlebt hat. Seit die Zeichen der Leiste ihren Modulton
  // tragen (2026-08-17) waere sie sichtbar falsch: der Ueberlauf saehe aus wie
  // der aktive Tab. Ohne Angabe bleibt er tertiaer, wie die Regel es vorsieht.
  moreBtn.setAttribute('aria-label', t('nav.more'));
  moreBtn.setAttribute('title', t('nav.more'));
  // Öffnet das „Mehr"-Sheet (role=dialog): aria-haspopup kündigt das Popup an,
  // aria-expanded/-controls spiegeln den Offen-Zustand (Audit P3, Sam-Persona).
  moreBtn.setAttribute('aria-haspopup', 'dialog');
  moreBtn.setAttribute('aria-expanded', 'false');
  moreBtn.setAttribute('aria-controls', 'more-sheet');

  const iconWrap = document.createElement('div');
  iconWrap.className = 'nav-item__icon-wrap';
  const well = document.createElement('div');
  well.className = 'nav-item__icon-well';
  well.appendChild(moduleIconEl('more-horizontal', 'nav-item__icon'));
  iconWrap.appendChild(well);

  const label = document.createElement('span');
  label.className = 'nav-item__label';
  label.textContent = t('nav.more');
  moreBtn.append(iconWrap, label);
  return moreBtn;
}

function mobileDestinationEl(item) {
  return item.navId === 'kitchen' ? kitchenNavButtonEl() : navItemEl(item);
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
  // Aktives Item in den Sichtbereich holen (Audit F-01): bei überlaufender
  // Liste lagen Item UND Pille sonst unsichtbar unterhalb der Falte — die
  // Navigation verlor ihren „Du bist hier"-Anker. Manuelles Scrollen statt
  // scrollIntoView, damit garantiert nur dieser Container scrollt. Nur wenn das
  // Item wirklich außerhalb liegt: rebuildNavigation() stellt die Scroll-Position
  // vorher wieder her, ein sichtbares Item wird also nie mehr verschoben.
  const margin = 8;
  const top = active.offsetTop;
  const bottom = top + active.offsetHeight;
  if (top < container.scrollTop + margin) {
    container.scrollTop = Math.max(0, top - margin);
  } else if (bottom > container.scrollTop + container.clientHeight - margin) {
    container.scrollTop = bottom - container.clientHeight + margin;
  }
  // Pille vertikal im Item zentrieren — aus realen Höhen, token-unabhängig.
  // offsetTop ist scroll-unabhängig relativ zum (position:relative) Container.
  const centerOffset = (active.offsetHeight - indicator.getBoundingClientRect().height) / 2;
  indicator.style.transform = `translateY(${top + centerOffset}px)`;
  indicator.style.opacity = '';
}

// Seitliche Luft zur Slot-Kante und Maximalbreite der Aktiv-Kapsel. Eine
// slot-breite Pille lief im ersten/letzten Tab bis an die Bar-Kante, wo ihre
// Rundung gekappt wurde (#569-Nachtrag); begrenzt bleibt sie eine Kapsel hinter
// dem Icon statt einer randlosen Kachel.
const TAB_INDICATOR_INSET = 4;
const TAB_INDICATOR_MAX_WIDTH = 64;

/**
 * Positioniert den gleitenden Indikator in der mobilen Tab-Bar.
 *
 * Vertikal an der Icon-Well ausgerichtet (nicht über die ganze Bar-Höhe), damit
 * die Label-Grundlinie frei bleibt und die Kapsel weder in die Safe-Area noch
 * an die Bar-Kante läuft.
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
  const well = active.querySelector('.nav-item__icon-well');
  const wr = well ? well.getBoundingClientRect() : ar;
  const width = Math.max(
    wr.width,
    Math.min(ar.width - TAB_INDICATOR_INSET * 2, TAB_INDICATOR_MAX_WIDTH),
  );
  // clientTop: der Indikator sitzt in der Padding-Box der Bar, das Rect an der
  // Border-Kante - ohne den Abzug sitzt die Kapsel 1px zu tief.
  const top = wr.top - nr.top - nav.clientTop;
  const left = ar.left - nr.left + (ar.width - width) / 2;
  indicator.style.width = `${width}px`;
  indicator.style.height = `${wr.height}px`;
  indicator.style.transform = `translate(${left}px, ${top}px)`;
  indicator.style.opacity = '';
}

function sidebarKitchenEl() {
  const item = {
    path: getLastKitchenRoute(),
    label: t('nav.kitchen'),
    icon: MODULE_ICON.kitchen,
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
  else if (mod) a.style.setProperty('--item-module-accent', moduleAccentVar(mod));
  const well = document.createElement('div');
  // Markensiegel (Block 2): das Well nimmt Form und Material vom Baustein,
  // die Grid-Groesse und die Akzent-Weiterleitung stehen in layout.css.
  well.className = 'module-seal more-item__icon-well';
  well.appendChild(moduleIconEl(icon, 'more-item__icon'));
  const span = document.createElement('span');
  span.className = 'more-item__label';
  span.textContent = label;
  a.appendChild(well);
  a.appendChild(span);

  // Der Zaehlstand kommt spaeter (siehe paintMoreSheetBadges) und nur, wenn es
  // einen gibt. Die Kachel bleibt ohne ihn vollstaendig - ein Badge ist eine
  // Zugabe, kein Bestandteil.
  const count = _moduleCounts[navId ?? mod];
  if (count > 0) {
    a.appendChild(moreBadgeEl(count));
    a.setAttribute('aria-label', `${label}, ${t('nav.moreBadge', { count })}`);
  }
  return a;
}

/**
 * Zaehlbadge einer Modulkachel: „was wartet", nie „was existiert".
 * Die nackte Ziffer haengt sich sonst an den Kachelnamen („Belohnungen1"):
 * ein aria-label auf dem <span> zaehlt bei der Namensberechnung des Links
 * NICHT (Rolle generic traegt keinen Namen), sein Ziffern-Text aber schon.
 * Deshalb ist das Badge aria-hidden, und die Ansage steht als aria-label auf
 * der Kachel selbst („Belohnungen, 1 offen") - dasselbe Muster wie
 * nav-badges.js und setSubTabBadge.
 */
function moreBadgeEl(count) {
  const badge = document.createElement('span');
  badge.className = 'more-item__badge';
  badge.textContent = count > 99 ? '99+' : String(count);
  badge.setAttribute('aria-hidden', 'true');
  return badge;
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
      moreBtn.style.setProperty('--item-module-accent', moduleAccentVar(activeSecondary.module));
    }
  } else {
    moreBtn.removeAttribute('aria-current');
    moreBtn.style.setProperty('--item-module-accent', 'var(--color-accent)');
  }

  // Der Änderungsverlauf liegt auf Mobil im „Mehr"-Sheet: steht ein Update an,
  // muss der Name des Buttons das sagen - der Punkt daneben ist aria-hidden.
  moreBtn.setAttribute('aria-label', withUpdateHint(moreLabel, pendingUpdateVersion()));
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
    // Der Akzent ist konstant (--module-kitchen, in kitchenNavButtonEl gesetzt)
    // und wird hier nicht mehr je aktivem Sub-Tab nachgezogen.
    if (isKitchen) {
      kitchenNavBtn.setAttribute('aria-current', 'page');
    } else {
      kitchenNavBtn.removeAttribute('aria-current');
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
  // Der globale Fehlerbildschirm laeuft ueber dieselbe Grammatik wie jeder
  // Leerzustand im Modul. Er hatte `role="alert"` und einen Ausweg schon
  // richtig, aber seinen Titel als <div> - auf einem Bildschirm, der nichts
  // sonst enthaelt, war damit auch die Ueberschrift weg.
  //
  // „Ein unerwarteter Fehler ist aufgetreten" sagt niemandem, was kaputt ist -
  // die einzige verwertbare Information (Name, Meldung, Stack) lag frueher nur
  // in der Browserkonsole. Zugeklappt beigelegt stoert sie das Layout nicht,
  // ist aber ohne DevTools erreichbar und kopierbar.
  const state = emptyStateEl({
    variant: 'error',
    title: t('common.errorOccurred'),
    description: friendlyError(err),
    details: { summary: t('common.errorDetails'), text: errorDetails(err) },
    action: {
      label: t('common.reload'),
      attrs: { id: 'error-reload-btn' },
      onClick: () => location.reload(),
    },
  });
  // Fokusziel: nach einem Absturz soll die Ansage beim Screenreader ankommen
  // und die Tastatur nicht im abgeraeumten Baum haengen.
  state.tabIndex = -1;

  container.replaceChildren(state);
  if (window.lucide) window.lucide.createIcons({ el: state });
  state.focus({ preventScroll: true });
}

/**
 * Technische Fehlerbeschreibung für die aufklappbaren Details. Bewusst roh
 * (nicht übersetzt): der Text ist zum Weitergeben in einem Bugreport da.
 */
function errorDetails(err) {
  if (!err) return '';
  const head = [err.name, err.message].filter(Boolean).join(': ');
  const stack = typeof err.stack === 'string' ? err.stack.trim() : '';
  // Manche Engines wiederholen "Name: Message" als erste Stack-Zeile.
  if (stack) return stack.startsWith(head) ? stack : `${head}\n${stack}`;
  return head || String(err);
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
  const container = toastSurface((type === 'danger' || type === 'warning') ? 'assertive' : 'polite');
  if (!container) return;

  // Aktions-Button: Legacy-Undo (Funktion) oder benannte Aktion ({ label, onClick }).
  const action = typeof onUndo === 'function'
    ? { label: t('common.undo'), onClick: onUndo }
    : (onUndo && typeof onUndo.onClick === 'function' ? onUndo : null);

  // Long Loop: Success-Toasts nach TOAST_SUCCESS_MAX Aufrufen unterdrücken.
  // Aktions-Toasts (Undo oder benannte Aktion) sind wichtig → nie unterdrücken.
  if (type === 'success' && !action) {
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

  if (action) {
    const actionBtn = document.createElement('button');
    actionBtn.className = 'toast__undo';
    actionBtn.textContent = action.label;
    actionBtn.addEventListener('click', () => {
      clearTimeout(dismissTimer);
      toast.remove();
      action.onClick();
    });
    toast.appendChild(actionBtn);
  }

  container.appendChild(toast);
  const dismiss = () => {
    clearTimeout(dismissTimer);
    toast.classList.add('toast--out');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  };
  const dismissTimer = setTimeout(dismiss, duration);

  // Wischen zum Verwerfen: die Geste samt ihrer zwei Fallen liegt in
  // `wireSwipeToDismiss` (utils/ux.js), das CSS-Gegenstück ist das
  // `touch-action: pan-y` auf `.toast`.
  wireSwipeToDismiss(toast, { onDismiss: dismiss });
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

/* „ResizeObserver loop completed with undelivered notifications" IST KEIN
 * FEHLER, sondern eine Zustellnotiz. Die Spezifikation verlangt sie, sobald ein
 * Observer-Callback das Layout so aendert, dass eine weitere Runde faellig
 * wird: der Browser verschiebt diese Runde auf den naechsten Frame und meldet
 * die Verschiebung ueber `window.onerror`. Danach ist alles zugestellt.
 *
 * GEMESSEN, NICHT VERMUTET (2026-08-10): auf dem Dashboard feuerte die Meldung
 * zweimal beim Laden - und jeder Nutzer sah dafuer einen roten „Ein
 * unerwarteter Fehler ist aufgetreten". Instrumentiert man die beiden
 * Observer der Shell (wireScrollFade, observeNavCapsule), laufen sie 1x bzw.
 * 2x und nie mehr als einmal je Frame. Es gibt also keine Schleife, die man
 * zumachen koennte; die Meldung beschreibt den Normalfall.
 *
 * DER FILTER IST ABSICHTLICH ENG. Er nennt genau diese eine Meldung (Chrome
 * schreibt sie in zwei Fassungen, „...loop limit exceeded" ist die aeltere).
 * Ein `catch`-all ueber alle Meldungen ohne `e.error` waere die bequeme
 * Variante und wuerde echte Fehler aus fremden Ursprüngen mitverschlucken. */
const RESIZE_OBSERVER_NOTICE = /^ResizeObserver loop/;

window.addEventListener('error', (e) => {
  // Ressource-Ladefehler (z.B. fehlgeschlagenes Bild): ignorieren
  if (e.target && e.target !== window) return;
  if (RESIZE_OBSERVER_NOTICE.test(e.message || '')) return;
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
      // Ab hier keine Seitenmodule mehr nachladen. Früher wurde an dieser Stelle
      // der Modul-Cache dieses Routers geleert, damit die nächste Navigation
      // frische Module lädt - wirkungslos: geleert wurde nur die eigene Map,
      // während die Modul-Map des Dokuments die alten Abhängigkeiten weiter
      // auflöst. Genau daraus entstand der Mischzustand aus #616.
      shellStale = true;
      showToast(t('common.updateAvailable'), 'default', 8000);
      setTimeout(() => location.reload(), 8000);
    }
  });
}

// Browser zurück/vor
//
// EIN OFFENER DIALOG FAENGT DIE GESTE AB (#871). Auf dem Telefon ist die
// Wischgeste von links der Zurueck-Knopf, und ueber einem offenen Dialog meint
// sie den Dialog, nicht die Seite darunter. Vorher tat die App beides falsch
// herum: sie navigierte im Hintergrund und liess den Dialog stehen.
//
// Der Handler ist async, der Listener bleibt es nicht: `navigate()` darf erst
// laufen, wenn feststeht, dass die Geste NICHT fuer einen Dialog war - der
// Weg aus einem Formular mit ungespeicherten Aenderungen fragt zurueck und
// beantwortet die Frage erst danach.
window.addEventListener('popstate', (e) => {
  const target = e.state?.path || location.pathname;
  handleBackNavigation().then((handled) => {
    if (!handled) navigate(target, false);
  });
});

/* ES GIBT ZWEI ABGAENGE, UND SIE TEILEN SICH KEINEN CODE.
 *
 * Der bewusste Logout laeuft ueber `clearSession()`, der Sitzungsablauf ueber
 * `auth:expired` - beide raeumen auf, jeder fuer sich, und was nur in einem der
 * beiden steht, faellt auf dem anderen Weg durch. Genau das passierte mit den
 * per-user-Praeferenzen: `syncPreferencesOnce()` laedt einmal und kehrt danach
 * sofort zurueck, und An- wie Abmelden sind SPA-Navigationen. Wer also nicht
 * auf "Abmelden" drueckt, sondern dessen Sitzung ablaeuft, vererbte seine
 * ausgeblendeten Module dem naechsten Mitglied am selben Geraet - Ziele fehlten
 * in dessen Seitenleiste, waehrend das Einstellungsblatt sie als sichtbar
 * auswies, weil es frisch vom Server liest.
 *
 * `_disabledModules` bleibt bewusst STEHEN: der Wert ist haushaltweit, fuer
 * jedes Mitglied derselbe, und der Modul-Guard laeuft VOR dem Auth-Guard, der
 * die Praeferenzen nachlaedt. Ihn zu leeren gewaenne nichts und oeffnete ein
 * Fenster, in dem eine abgeschaltete Route wieder erreichbar waere. */
function forgetSessionState() {
  currentUser = null;
  _preferencesLoaded = false;
  _hiddenModules = new Set();
  _moduleOrder = [];
  _mobileNavOrder = [];
  // Offline-API-Cache leeren: Session-Ende → keine gecachten Daten zurücklassen,
  // die der nächste Nutzer am selben Gerät offline sehen könnte.
  clearApiCache();
  // Der Layout-Hinweis des Dashboards gehoert derselben Sitzung: ohne ihn sagt
  // das Skelett am geteilten Tablett das Raster des Vorgaengers voraus.
  forgetLayoutHint();
  // Gemerkte Scrollstände gehören zur Sitzung: der nächste Nutzer am selben
  // Gerät soll nicht auf den Positionen des vorigen landen.
  forgetScrollPositions();
  // Und die Zählstände der Modulkacheln aus demselben Grund.
  resetModuleCounts();
  // Ebenso die Zahlen an den Nav-Zielen (#868).
  resetNavBadges();
  // Was noch offen steht, geht mit der Sitzung zu (#871). SCHLIESSEN und nicht
  // nur vergessen: ein geteiltes Modal haengt an `document.body` und ueberlebt
  // das Abraeumen der Shell - ein bloss geleertes Register liesse es ueber der
  // Anmeldeseite stehen.
  closeAllOverlays();
  stopThirdPartyModulePolling();
  stopReminders();
  stopPush();
}

// Session abgelaufen
window.addEventListener('auth:expired', () => {
  forgetSessionState();
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
/**
 * Ein Ziel ist aus der Navigation verschwunden (Modul abgeschaltet oder
 * ausgeblendet): seine Zahl geht mit.
 *
 * Sonst lebt sie beim Wiedereinschalten wieder auf - und fuer das Inventar
 * heilt sich das nicht von selbst, weil `/dashboard` fuer dieses Modul keinen
 * Zaehler liefert: der alte Stand stuende dort, bis jemand die Seite besucht.
 */
function dropBadgesForRemovedRoutes() {
  for (const route of navBadgeRoutes()) {
    if (!document.querySelector(`.nav-sidebar [data-route="${route}"], .nav-bottom [data-route="${route}"]`)) {
      setNavBadge(route, 0);
    }
  }
}

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
    // replaceChildren recria toda a árvore da navegação (por exemplo, após
    // replaceChildren baut die Navigation komplett neu (Routenwechsel, Sprache,
    // Modulliste) und der Browser setzt die Scroll-Position dabei auf 0 zurück.
    // Ohne Sicherung sprang die Liste bei jedem Rebuild an den Anfang und das
    // Auto-Scroll unten riss sie sofort wieder zum aktiven Item — sichtbar als
    // Springen zwischen erstem und letztem Eintrag.
    const previousScrollTop = navSidebarItems.scrollTop;
    const sidebarEls = sidebarNavItems();
    navSidebarItems.replaceChildren(...sidebarEls);
    if (window.lucide) window.lucide.createIcons({ el: navSidebarItems });
    requestAnimationFrame(() => {
      navSidebarItems.scrollTop = Math.min(
        previousScrollTop,
        Math.max(0, navSidebarItems.scrollHeight - navSidebarItems.clientHeight),
      );
      positionSidebarIndicator();
    });
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
  // Die Einstiege zum Änderungsverlauf sind gerade neu entstanden - ein noch
  // offener Hinweis muss ihnen folgen, sonst fällt er beim Sprachwechsel weg.
  applyUpdateBadge();
  // Aus demselben Grund die Zahlen an den Nav-Zielen: `replaceChildren()` oben
  // hat sie mit weggeworfen, und bis #868 kamen sie erst wieder, wenn das
  // zugehoerige Modul erneut rendert - nach einem Sprachwechsel also womoeglich
  // nie.
  applyNavBadges();
  // Und was gerade aus der Navigation gefallen ist, verliert seine Zahl.
  dropBadgesForRemovedRoutes();
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
// Die Anzeigezone wirkt auf jede Uhrzeit auf dem Schirm - dasselbe Neuzeichnen
// wie beim Datums-/Zeitformat (#829 Teil 3).
window.addEventListener('timezone-changed', refreshCurrentRoute);
window.addEventListener('time-format-changed', refreshCurrentRoute);

window.addEventListener('resize', () => {
  positionSidebarIndicator();
  positionTabIndicator();
}, { passive: true });

/* DER INDIKATOR MISST ECHTE RECTS, ALSO MUSS ER JEDE BREITENAENDERUNG SEHEN -
 * und `resize` ist nur EINE ihrer Ursachen.
 *
 * Seit die Nav-Kapsel ihr hinteres Ende fuer den FAB freihaelt (`:has()` in
 * layout.css), aendert sich die Breite aller fuenf Slots, sobald ein FAB
 * erscheint oder verschwindet. Das passiert auch OHNE Navigation: budget.js
 * schaltet `fab.hidden` beim Tabwechsel, split-expenses.js beim Archivfilter.
 * Der Indikator stand danach auf den Koordinaten der alten Slotbreiten, bis
 * irgendwann ein Resize oder ein Routenwechsel kam (Codex-Review zu PR #719).
 *
 * Ein ResizeObserver AN DER KAPSEL statt Aufrufe an den beiden bekannten
 * Stellen: die Ursache ist die Breite, nicht die Liste der Module, die sie
 * gerade aendern. Der dritte Aufrufer waere sonst wieder einer, der es
 * vergisst. */
function observeNavCapsule() {
  if (typeof ResizeObserver !== 'function') return;
  const items = document.querySelector('.nav-bottom__items');
  if (!items || items.dataset.indicatorObserved === '1') return;
  items.dataset.indicatorObserved = '1';
  new ResizeObserver(() => requestAnimationFrame(() => positionTabIndicator())).observe(items);
}
observeNavCapsule();

// --------------------------------------------------------
// Virtuelle Tastatur: FAB ausblenden, solange sie offen ist.
// Nur auf Mobilgeräten relevant (< 1024px, siehe layout.css) - Desktop hat
// keine virtuelle Tastatur.
//
// ZWEI BEDINGUNGEN, NICHT EINE (#634): Ein geschrumpfter Viewport allein ist
// kein Beweis für eine Tastatur. Auf iOS schrumpft er auch, wenn die
// Adressleiste ausfährt, und die frühere Fassung schloss allein daraus auf
// „Tastatur offen". Schwerer als der Fehlschluss wog sein Rückweg: der Zustand
// hing an einem einzelnen `resize`, und blieb ein zweites aus, war die
// Primäraktion des Moduls dauerhaft weg - dieselbe Falle wie beim
// Scroll-Retract, den #634 entfernt hat. Der FAB ist der einzige Weg zum
// Anlegen (`.toolbar-new-btn` ist überall ausgeblendet), also kostet ein
// Falsch-Positiv hier das ganze Modul.
//
// Eine Tastatur ist offen, wenn ein Texteingabefeld den Fokus hat. Das ist
// direkt beobachtbar statt geschätzt, und es hat einen Rückweg, der nicht
// ausbleiben kann: `focusout` feuert immer, und jede Navigation fokussiert
// #main-content, was die Bedingung ebenfalls auflöst. Die Viewport-Messung
// bleibt als zweite Bedingung - sie kann jetzt nur noch dazu führen, dass der
// FAB stehen bleibt, nie mehr dazu, dass er ohne Tastatur verschwindet.
// --------------------------------------------------------

/** Eingabetypen, die keine Tastatur öffnen: eigene Picker oder Knöpfe. */
const NON_TEXT_INPUT_TYPES = new Set([
  'button', 'checkbox', 'color', 'date', 'datetime-local', 'file', 'hidden',
  'image', 'month', 'radio', 'range', 'reset', 'submit', 'time', 'week',
]);

function isTextEntry(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  return !NON_TEXT_INPUT_TYPES.has(el.type);
}

function syncKeyboardVisible() {
  const focused = isTextEntry(document.activeElement);
  const vv = window.visualViewport;
  // Ohne visualViewport trägt der Fokus die Entscheidung allein.
  const shrunk = !vv || vv.height < window.innerHeight * 0.75;
  document.body.classList.toggle('keyboard-visible', focused && shrunk);
}

// `focusout` feuert, bevor der neue Fokus steht - erst danach messen, sonst
// blitzt der FAB beim Sprung von einem Feld zum nächsten kurz auf.
//
// `setTimeout` und nicht `requestAnimationFrame`: rAF ruht in verborgenen Tabs.
// Der Zustand verbirgt die Primäraktion, also darf sein Rückweg nicht an einem
// Ereignis hängen, das ausbleiben kann - dieselbe Regel, an der der
// Scroll-Retract gescheitert ist. Timer werden gedrosselt, aber sie laufen.
let keyboardSyncTimer = 0;
function scheduleKeyboardSync() {
  if (keyboardSyncTimer) return;
  keyboardSyncTimer = setTimeout(() => {
    keyboardSyncTimer = 0;
    syncKeyboardVisible();
  }, 0);
}

document.addEventListener('focusin', scheduleKeyboardSync);
document.addEventListener('focusout', scheduleKeyboardSync);
// Die Messung kommt auf iOS erst einige hundert Millisekunden nach dem Fokus -
// ohne diesen Listener bliebe die zweite Bedingung beim Öffnen ungeprüft.
window.visualViewport?.addEventListener('resize', syncKeyboardVisible);

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

    // Theme „Automatisch" (kein data-theme) folgt prefers-color-scheme rein per
    // CSS - applyTheme() feuert dabei nie. Der Modul-Akzent im Inline-Style
    // bliebe also beim Sonnenuntergang des Systems auf dem Hellmodus-Wert
    // stehen: derselbe Kontrast-Bruch wie beim manuellen Umschalten, nur ohne
    // Nutzeraktion. Der Listener zieht ihn nach; bei explizitem Theme ist der
    // Aufruf idempotent (dieselbe Farbe wird erneut aufgelöst). Die Statusbar
    // hängt an derselben Momentaufnahme, siehe refreshThemeColorForTheme.
    darkSchemeQuery?.addEventListener?.('change', () => {
      applyModuleAccentForRoute(currentRoute());
      refreshThemeColorForTheme();
    });

    await initI18n();
    initExtensionI18n();
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
  setHiddenModules,
  setModuleOrder,
  setMobileNavOrder,
  refreshThirdPartyModules,
  isModuleDisabled,
  // Ein Modul hat etwas geaendert, das an einem Nav-Ziel gezaehlt wird (#868).
  // Begruendung an `invalidateModuleCounts`.
  invalidateModuleCounts,
  // Die Uebersichtsseite reicht ihre `/dashboard`-Antwort herein, statt sie ein
  // zweites Mal holen zu lassen. Begruendung an `primeModuleCountsFrom`.
  primeModuleCountsFrom,
  applyTheme: (value) => {
    if (value === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else if (value === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    // Der Modul-Akzent liegt als aufgelöste Farbe im Inline-Style von <html> und
    // folgt der CSS-Kaskade daher NICHT. Ohne dieses Nachziehen behielte die
    // ganze Shell (Buttons, Fokusringe, FAB, aktive Nav-Pille) den Akzent des
    // vorherigen Themes. Begründung an applyModuleAccentForRoute.
    applyModuleAccentForRoute(currentRoute());
    // Die Statusbar im Standalone-Modus trägt dieselbe eingefrorene
    // Momentaufnahme, siehe refreshThemeColorForTheme.
    refreshThemeColorForTheme();
    // Persistenz zuletzt und fehlertolerant: ein werfendes localStorage (Safari
    // Privatmodus, Quota) darf das sichtbare Anwenden nicht abbrechen. Vorher
    // stand diese Zeile zuerst - warf sie, fiel der Aufrufer in den
    // Einstellungen auf ein direktes data-theme zurück und liess den Akzent
    // stehen. Derselbe Schlüssel wird dort ohnehin über safeStorageSet
    // geschrieben, hier geht also nichts verloren.
    try {
      localStorage.setItem('yuvomi-theme', value);
    } catch {
      // Theme gilt für diese Sitzung, überlebt den Reload aber nicht.
    }
  },
  restoreThemeColor: () => {
    updateThemeColorForRoute(currentRoute());
  },
  // Client-seitigen Sitzungszustand nach einem bewussten Logout zurücksetzen,
  // damit die anschließende navigate('/login') nicht am currentUser-Guard
  // hängenbleibt und kurz das Dashboard zeigt (#478). Der Server-Logout läuft
  // separat über auth.logout().
  clearSession: () => {
    forgetSessionState();
    _navBuiltForUserId = null;
  },
};

// Legacy-Alias: Drittanbieter-Module unter modules/ wurden ggf. gegen die alte
// globale API `window.oikos` geschrieben. Ohne diesen Alias würfen ihre Aufrufe
// (window.oikos.navigate/showToast …) nach dem Rename, und der Router würde das
// Modul als fehlerhaft deaktivieren. Der Alias hält den Upgrade-Pfad nahtlos.
window.oikos = window.yuvomi;
