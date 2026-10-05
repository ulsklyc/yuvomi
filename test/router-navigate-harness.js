/**
 * Testhelfer: `navigate()` aus public/router.js als Programm (#1640)
 *
 * router.js haengt am Browser und laesst sich nicht importieren: beim Laden
 * registriert es Listener an `window` und zieht die halbe App nach. Bis #1640
 * hielt deshalb nur die REIHENFOLGE im Quelltext fest, was `navigate()` tut.
 *
 * Dieser Helfer fuehrt den ECHTEN Text von `unknownDetourFor()` und
 * `navigate()` aus - keine Kopie, kein Nachbau. Er schneidet beide aus
 * router.js und stellt ihnen eine Umgebung hin, in der jeder freie Name ein
 * Feld ist: der Zustand des Routers (`currentUser`, `isNavigating`, ...) als
 * les- und schreibbare Felder, alles andere als Attrappe, die mitschreibt.
 * Die Entscheidungen selbst (`unknownPathDetour`, `publicPathDetour`,
 * `detourPaths`) sind die echten aus utils/unknown-route.js.
 *
 * Ein Name, den `navigate()` neu benutzt und den es hier nicht gibt, wirft
 * einen ReferenceError: der Helfer veraltet laut, nicht still.
 */
import { readFileSync } from 'node:fs';
import { unknownPathDetour, publicPathDetour, detourPaths } from '../public/utils/unknown-route.js';

const routerSrc = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');

function navigateSource() {
  const start = routerSrc.indexOf('function unknownDetourFor(');
  const end = routerSrc.indexOf('async function syncPreferencesOnce(');
  if (start < 0 || end < start) throw new Error('navigate() in router.js nicht gefunden');
  return routerSrc.slice(start, end);
}

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
    console,
    URLSearchParams,
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

  // `with` gibt es nur ausserhalb des Strict-Modus - `new Function` ist das.
  // eslint-disable-next-line no-new-func
  const navigate = new Function('env', `with (env) { return (function () {
    ${navigateSource()}
    return navigate;
  }()); }`)(env);

  return { navigate, env, log, setShell: (value) => { shell = value; } };
}
