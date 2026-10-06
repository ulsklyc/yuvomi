/**
 * Testhelfer: `navigate()` des Routers als Programm (#1640, #1657)
 *
 * router.js haengt am Browser und laesst sich nicht importieren: beim Laden
 * registriert es Listener an `window` und zieht die halbe App nach. Bis #1640
 * hielt deshalb nur die REIHENFOLGE im Quelltext fest, was `navigate()` tut.
 *
 * Seit #1657 steht `navigate()` in public/utils/router-navigate.js und wird
 * hier importiert wie jedes andere Modul: `createNavigate(state, deps)` bekommt
 * den Zustand des Routers (`currentUser`, `isNavigating`, ...) als les- und
 * schreibbare Felder und alles andere als Attrappe, die mitschreibt. Die
 * Entscheidungen selbst (`unknownPathDetour`, `publicPathDetour`,
 * `detourPaths`) sind die echten aus utils/unknown-route.js.
 *
 * Die Namen unten sind der Vertrag des Moduls (NAVIGATE_STATE, NAVIGATE_DEPS).
 * Fehlt hier einer, wirft createNavigate() beim Erzeugen: der Helfer veraltet
 * laut, nicht still.
 */
import { unknownPathDetour, publicPathDetour, detourPaths } from '../public/utils/unknown-route.js';
import { createNavigate } from '../public/utils/router-navigate.js';

/** Routen wie in der Tabelle des Routers: Pfad, Anmeldepflicht, Modul. */
export const HARNESS_ROUTES = Object.freeze([
  { path: '/login', requiresAuth: false, module: null },
  { path: '/setup', requiresAuth: false, module: null },
  { path: '/join', requiresAuth: false, module: null },
  { path: '/pair', requiresAuth: false, module: null },
  { path: '/', requiresAuth: true, module: 'dashboard' },
  { path: '/tasks', requiresAuth: true, module: 'tasks' },
  { path: '/budget', requiresAuth: true, module: 'budget' },
  { path: '/settings', requiresAuth: true, module: 'settings' },
  { path: '/settings/appearance', requiresAuth: true, module: 'settings' },
]);

/**
 * @param {object} [options]
 * @param {object|null} [options.user] - schon angemeldet (laufende Sitzung)
 * @param {object|null} [options.sessionUser] - was `auth.me()` beim Kaltstart liefert; null: 401
 * @param {boolean} [options.preferencesLoaded] - Vorgabe: ob `user` gesetzt ist
 * @param {boolean} [options.setupRequired]
 * @param {(module: string) => boolean} [options.canAccess]
 * @param {Iterable<string>} [options.disabledModules]
 * @param {{ search?: string, hash?: string }} [options.location]
 * @param {() => Promise<boolean>} [options.leaveGuard] - Verlassen-Schutz; fehlt er, gibt es keinen
 * @param {(route: object) => Promise<void>} [options.onRender] - haelt das Rendern an
 */
export function createNavigateHarness({
  user = null,
  sessionUser = null,
  preferencesLoaded = Boolean(user),
  setupRequired = false,
  canAccess = () => true,
  disabledModules = [],
  location = {},
  leaveGuard = null,
  onRender = null,
  routes = HARNESS_ROUTES,
} = {}) {
  /** Was nach aussen sichtbar wurde, in der Reihenfolge des Geschehens. */
  const log = { rendered: [], history: [], toasts: [], leaveAsked: [], authCalls: 0 };
  let shell = false;

  const env = {
    // ── Zustand des Routers ──
    currentUser: user,
    currentPath: null,
    isNavigating: false,
    _preferencesLoaded: preferencesLoaded,
    _setupRequired: setupRequired,
    _pendingLoginRedirect: false,
    // Wie im Router: die abgeschalteten Module kommen mit den Praeferenzen.
    // Beim Kaltstart ist die Menge leer, bis syncPreferencesOnce() gelaufen ist.
    _disabledModules: new Set(preferencesLoaded ? disabledModules : []),
    _renderedModule: null,
    _renderedModuleName: null,
    // ── Tabelle und Entscheidungen: die echten ──
    ROUTES: routes,
    allRoutes: () => routes,
    unknownPathDetour,
    publicPathDetour,
    detourPaths,
    // Wie im Router: die Rechte kommen mit der Anmeldung (`auth.me()` setzt
    // sie), davor ist alles offen - public/permissions.js gibt ohne Eintrag frei.
    canAccessNavModule: (module) => (env.currentUser ? canAccess(module) : true),
    // ── Browser ──
    location: { search: '', hash: '', ...location },
    history: {
      pushState: (_state, _title, address) => log.history.push(['push', address]),
      replaceState: (_state, _title, address) => log.history.push(['replace', address]),
    },
    window: {},
    document: { querySelector: () => null, getElementById: () => null },
    // ── Verlassen-Schutz ──
    hasLeaveGuard: () => Boolean(leaveGuard),
    mayLeave: async (path) => { log.leaveAsked.push(path); return leaveGuard(); },
    whenHistorySettled: async () => {},
    consumeOverlayMarker: () => false,
    // ── Sitzung ──
    auth: {
      me: async () => {
        log.authCalls += 1;
        if (!sessionUser) throw Object.assign(new Error('Sitzung abgelaufen.'), { status: 401 });
        return { user: sessionUser };
      },
    },
    syncPreferencesOnce: async () => {
      if (env._preferencesLoaded) return;
      env._preferencesLoaded = true;
      env._disabledModules = new Set(disabledModules);
    },
    startThirdPartyModulePolling: () => {},
    loadReminderStyles: () => {},
    initReminders: () => {},
    initPush: () => {},
    // ── Seite ──
    rememberScrollPosition: () => {},
    scrollPositionFor: () => 0,
    renderPage: async (route) => {
      if (onRender) await onRender(route);
      // Wie renderPage(): die Shell - und mit ihr die Toast-Flaeche - gibt es
      // nur auf Seiten mit Anmeldung.
      shell = route.requiresAuth;
      log.rendered.push(route.path);
    },
    adoptPageFab: () => {},
    updateNav: () => {},
    topLevelSection: (path) => path,
    syncWallMode: () => {},
    applyModuleAccentForRoute: () => {},
    updateThemeColorForRoute: () => {},
    updateBranding: () => {},
    focusMainContentAfterNavigation: () => {},
    // Wie utils/toast-show.js: ohne Flaeche geht der Toast still verloren.
    showToast: (message) => { log.toasts.push({ message, shown: shell }); },
    t: (key) => key,
  };

  // EIN Objekt fuer beides, wie bisher: die Tests lesen den Zustand an `env`
  // (`env.isNavigating`), und die Attrappen oben schreiben ihn dort.
  const navigate = createNavigate(env, env);

  return { navigate, env, log, setShell: (value) => { shell = value; } };
}
