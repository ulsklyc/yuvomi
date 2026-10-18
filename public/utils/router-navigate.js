/**
 * navigate() des Routers als eigenes Modul (#1657).
 *
 * router.js haengt am Browser und laesst sich nicht importieren: beim Laden
 * registriert es Listener an `window` und zieht die halbe App nach. Dieses
 * Modul importiert deshalb NICHTS. Alles, was eine Navigation braucht, kommt
 * von aussen: der Zustand als EIN Objekt, das der Router und diese Funktion
 * teilen, der Rest als Abhaengigkeiten. router.js reicht die echten herein,
 * test/router-navigate-harness.js aufzeichnende Stellvertreter.
 *
 * Die zwei Listen unten SIND der Vertrag. createNavigate() prueft sie beim
 * Erzeugen: ein Name, der fehlt, wirft sofort - beim Start der App und nicht
 * erst auf dem einen Weg, der ihn braucht. Ein Name, den navigate() neu
 * benutzt und der hier nicht steht, ist im Modul ein ReferenceError.
 * `console` und `URLSearchParams` gibt es im Browser wie in Node, sie bleiben
 * global.
 */

/**
 * Schreibbarer Zustand. Er lebt in router.js (`routerState`) und NUR dort:
 * hier wird nichts kopiert, jeder Zugriff geht ueber `state.<name>`, weil der
 * Router dieselben Felder ausserhalb einer Navigation liest und schreibt
 * (auth:expired, renderPage(), syncPreferencesOnce(), der Start).
 */
export const NAVIGATE_STATE = Object.freeze([
  'currentUser',
  'currentPath',
  'isNavigating',
  '_preferencesLoaded',
  '_setupRequired',
  '_pendingLoginRedirect',
  '_disabledModules',
  '_renderedModule',
  '_renderedModuleName',
]);

/** Was navigate() ruft oder liest, ohne es je zuzuweisen. */
export const NAVIGATE_DEPS = Object.freeze([
  // Tabelle und Entscheidungen
  'ROUTES', 'allRoutes', 'unknownPathDetour', 'publicPathDetour', 'detourPaths', 'canAccessNavModule',
  // Browser
  'location', 'history', 'window', 'document',
  // Verlassen-Schutz und Overlay-History
  'hasLeaveGuard', 'mayLeave', 'whenHistorySettled', 'consumeOverlayMarker',
  // Sitzung
  'auth', 'syncPreferencesOnce', 'startThirdPartyModulePolling', 'loadReminderStyles', 'initReminders', 'initPush',
  'armScreensaver', 'showSessionUnreachable', 'forgetSessionState',
  // Seite
  'rememberScrollPosition', 'scrollPositionFor', 'renderPage', 'adoptPageFab', 'updateNav', 'topLevelSection',
  'syncWallMode', 'applyModuleAccentForRoute', 'updateThemeColorForRoute', 'updateBranding',
  'focusMainContentAfterNavigation', 'showToast', 't',
]);

/**
 * Der Pfad, den ein Element mit `data-route` vorwaermen laesst (#1821).
 *
 * `prefetchRoute()` findet eine Route nur an ihrem Pfad. Die Query fiel bisher
 * allein von `data-nav-href` ab; eine Inhaltszeile der Uebersicht traegt ihr
 * Ziel aber in `data-route` und samt Query (`/shopping?list=7`,
 * `/calendar?open=3&date=..`, `/pantry?filter=low`) - sie waermte nichts vor.
 * `data-nav-href` gewinnt, wie beim Klick-Handler der Navigation daneben.
 *
 * @param {{navHref?: string, route?: string}|null|undefined} dataset
 * @returns {string|null}
 */
export function prefetchPathOf(dataset) {
  const target = dataset?.navHref ?? dataset?.route;
  if (typeof target !== 'string') return null;
  return target.split(/[?#]/)[0] || null;
}

/** Grund eines ueberholten Seitenaufbaus - einmal erzeugt, ohne Stapel der Navigation. */
const NAVIGATION_SUPERSEDED = typeof DOMException === 'function'
  ? new DOMException('A newer navigation took over.', 'AbortError')
  : undefined;

/**
 * Zeigt `target` auf die Adresse, die gerade steht - Pfad UND Query (R20)?
 *
 * Der Tipp auf den aktiven Tab (oder dieselbe Zeile im Mehr-Blatt, in der
 * Seitenleiste) baute die Seite neu, sprang hart nach oben und legte einen
 * zweiten History-Eintrag mit derselben Adresse an: Zurueck tat danach
 * sichtbar nichts (Re-Critique 2026-10-17, a1 P2-1). Wie der Tab einer
 * iOS-Leiste fuehrt er jetzt nur nach oben. Ein Hash zaehlt nicht mit, eine
 * andere Query schon: `/tasks?open=3` -> `/tasks` ist ein echter Rueckweg.
 *
 * @param {string|null|undefined} target
 * @param {{pathname?: string, search?: string}|null|undefined} loc
 */
export function isCurrentAddress(target, loc) {
  if (typeof target !== 'string' || typeof loc?.pathname !== 'string') return false;
  const address = target.split('#')[0];
  return address === loc.pathname + (loc.search || '');
}

/**
 * Steht der Fokus nach einer Navigation schon IN der neuen Seite (#1821)?
 *
 * Der Router setzt den Fokus einen Frame nach dem Aufbau auf `<main>`, damit
 * Tastatur und Screenreader in der neuen Seite ankommen statt auf dem Link, der
 * sie geoeffnet hat. Wer in diesem Frame schon in der Seite steht - eine Zeile
 * der Uebersicht, ein Feld, das die Seite selbst fokussiert hat -, ist
 * angekommen; ihn auf `<main>` zurueckzuholen nahm der Zeile den Fokus, und
 * Enter tat nichts mehr. Der Frame ist kurz, solange der Tab sichtbar ist, und
 * beliebig lang, wenn er es nicht ist (rAF ruht im Hintergrund).
 *
 * @param {{contains: (el: unknown) => boolean}|null} main
 * @param {unknown} active - `document.activeElement`
 */
export function focusAlreadyInPage(main, active) {
  return Boolean(main && active && active !== main && main.contains(active));
}

/**
 * Fokus nach einer Navigation: einen Frame nach dem Aufbau auf `<main>`.
 *
 * Die Funktion steht HIER und nicht in router.js, damit sie als Programm
 * laeuft (router.js laesst sich nicht importieren): der Router reicht nur noch
 * seine Browser-Teile herein. Zwei Faelle lassen den Fokus, wo er ist, und
 * beide werden IM Frame gefragt, nicht davor - dazwischen liegt genau die
 * Zeit, in der jemand in die Seite tabbt oder die Seite einen Dialog oeffnet:
 *
 * - er liegt schon in der neuen Seite (focusAlreadyInPage);
 * - ein Overlay ist offen. Eine Navigation schliesst alle Overlays; steht nach
 *   dem Aufbau eines im Register, hat die NEUE Seite es geoeffnet (`?open=`
 *   bei Notizen, Kontakten, Geburtstagen, Aufgaben). Das Overlay liegt
 *   ausserhalb von `<main>` und haelt den Fokus selbst - `main.focus()` zoege
 *   ihn hinter den offenen Dialog, und Tab liefe durch die Seite dahinter.
 *
 * Alles andere - der Link in Seitenleiste oder Tableiste, `<body>`, ein
 * Element der alten Seite - gibt den Fokus an `<main>` ab. Das ist der Zweck
 * der Funktion und darf mit den beiden Ausnahmen nicht verloren gehen.
 *
 * @param {string} path
 * @param {{document: Document, requestAnimationFrame: (cb: () => void) => unknown, hasOpenOverlay: () => boolean}} env
 */
export function focusMainAfterNavigation(path, { document, requestAnimationFrame, hasOpenOverlay }) {
  if (path === '/login' || path === '/setup') return;
  const main = document.getElementById('main-content');
  if (!main || typeof main.focus !== 'function') return;
  requestAnimationFrame(() => {
    if (hasOpenOverlay()) return;
    if (focusAlreadyInPage(main, document.activeElement)) return;
    main.focus({ preventScroll: true });
  });
}

/**
 * Wartet auf `promise`, bis es fertig ist ODER `signal` abbricht (Review
 * #2049). renderPage() wartete blank auf `module.render()`, auch wenn die
 * Navigation laengst ueberholt war - und Seiten wie der Kalender rufen ihr
 * erstes api.get() ohne Signal: ein haengender Abruf hielt den neueren Tipp
 * unbegrenzt auf, denn der wartende startet erst im finally von navigate().
 *
 * Ein Fehler VOR dem Abbruch bleibt ein Fehler (renderPage zeigt ihn). Einer
 * DANACH - die Seite bricht ihr Laden ab - wird geschluckt: niemand wartet
 * mehr darauf, und als unbehandelte Ablehnung waere er nur Rauschen.
 *
 * @param {Promise<unknown>|unknown} promise
 * @param {AbortSignal|null} signal
 * @returns {Promise<boolean>} true, wenn fertig; false, wenn abgebrochen
 */
export function unlessAborted(promise, signal) {
  const work = Promise.resolve(promise);
  if (!signal) return work.then(() => true);
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.resolve(false);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      () => { signal.removeEventListener('abort', onAbort); resolve(true); },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) resolve(false);
        else reject(err);
      },
    );
  });
}

/**
 * @param {object} state - der geteilte Zustand, Felder wie in NAVIGATE_STATE
 * @param {object} deps - Abhaengigkeiten, Namen wie in NAVIGATE_DEPS
 * @returns {(path: string, userOrPushState?: object|boolean, pushState?: boolean) => Promise<void>}
 */
export function createNavigate(state, deps) {
  const missing = [
    ...NAVIGATE_STATE.filter((name) => !(name in state)),
    ...NAVIGATE_DEPS.filter((name) => deps[name] === undefined),
  ];
  if (missing.length) throw new Error(`createNavigate: es fehlt ${missing.join(', ')}`);
  const {
    ROUTES, allRoutes, unknownPathDetour, publicPathDetour, detourPaths, canAccessNavModule,
    location, history, window, document,
    hasLeaveGuard, mayLeave, whenHistorySettled, consumeOverlayMarker,
    auth, syncPreferencesOnce, startThirdPartyModulePolling, loadReminderStyles, initReminders, initPush,
    armScreensaver, showSessionUnreachable, forgetSessionState,
    rememberScrollPosition, scrollPositionFor, renderPage, adoptPageFab, updateNav, topLevelSection,
    syncWallMode, applyModuleAccentForRoute, updateThemeColorForRoute, updateBranding,
    focusMainContentAfterNavigation, showToast, t,
  } = deps;

  /**
   * Der Umweg fuer eine Adresse ohne Route (#1607), oder null. Regeln in
   * utils/unknown-route.js. Bekannt ist, was allRoutes() kennt - also erst
   * verlaesslich, wenn die Erweiterungsrouten geladen sind (nach der Anmeldung).
   * Landeplatz ist jede Route ausser einem abgeschalteten oder gesperrten Modul
   * und den zwei Seiten, von denen eine angemeldete Sitzung sofort wieder
   * wegfuehrt. Die Route eines solchen Moduls SELBST ist bekannt und bleibt den
   * Modul-Guards in navigate().
   *
   * OHNE SITZUNG (#1640) urteilt nur der oeffentliche Teil der Tabelle: `/pair`
   * und `/join` sind bekannt, bevor sich jemand angemeldet hat, also fuehrt
   * `/pair/extra` auf `/pair` statt ueber die Uebersicht auf die Anmeldung. Alles
   * andere bleibt offen bis hinter den Auth-Guard - dort erst stehen die
   * Erweiterungsrouten und die Rechte.
   */
  function unknownDetourFor(path) {
    const routes = allRoutes();
    const known = routes.map((r) => r.path);
    const landable = routes
      .filter((r) => r.path === '/' || (r.path !== '/login' && r.path !== '/setup'
        && !(r.module && (state._disabledModules.has(r.module) || !canAccessNavModule(r.module)))))
      .map((r) => r.path);
    if (!state.currentUser) {
      return publicPathDetour(path, {
        known,
        open: routes.filter((r) => !r.requiresAuth).map((r) => r.path),
        landable,
      });
    }
    return unknownPathDetour(path, { known, landable });
  }

  /**
   * Navigiert zu einem Pfad und rendert die entsprechende Seite.
   * @param {string} path
   * @param {Object|boolean} userOrPushState - Direkt ein User-Objekt nach Login,
   *   oder boolean (pushState) für interne Navigation
   * @param {boolean} pushState - false beim initialen Load und popstate
   */
  /*
   * DER LETZTE TIPP GEWINNT (Critique R19, Nachlese 1b). Bis hierher verwarf
   * navigate() jeden Aufruf, solange eine Navigation lief - wer waehrend des
   * Ladens einer Seite ein zweites Ziel antippte, blieb auf dem ersten (im
   * Browser gemessen: 1 von 24 schnellen Doppeltipps).
   *
   * Jetzt wartet der neue Wunsch als EINER (`queued`; ein noch neuerer
   * ersetzt ihn), und die laufende Navigation wird abgebrochen (`running`):
   * renderPage() rendert ein ueberholtes Seitenmodul nach seinem Laden nicht
   * mehr, und eine schon gezeichnete Seite bekommt ihr Signal entzogen. Danach
   * startet der wartende Wunsch - durch dieselben Weichen, denselben
   * Verlassen-Schutz und dieselbe Sperre wie jeder andere. Hat die ueberholte
   * Navigation schon einen History-Eintrag geschrieben, ERSETZT der naechste
   * ihn: Zurueck fuehrt nicht auf eine Seite, die nie zu sehen war. Ein
   * Sitzungsende (`_pendingLoginRedirect`) geht dem Wartenden vor.
   */
  let running = null;
  let queued = null;
  let replaceNextEntry = false;

  function startQueued() {
    const next = queued;
    queued = null;
    if (next) navigate(...next.args).then(next.resolve, next.resolve);
  }

  async function navigate(path, userOrPushState = true, pushState = true) {
    if (state.isNavigating) {
      queued?.resolve();
      // Ein fester Grund statt einer neuen Ausnahme je Abbruch (deren Stapel
      // hielte die laufende Navigation fest, siehe PAGE_LEFT in router.js).
      running?.abort(NAVIGATION_SUPERSEDED);
      return new Promise((resolve) => { queued = { args: [path, userOrPushState, pushState], resolve }; });
    }
    const run = new AbortController();
    // UNBEKANNTE ADRESSE (#1607): statt still die Uebersicht unter der toten
    // Adresse zu zeichnen, laeuft DIESE Navigation mit dem naechsten bekannten
    // Vorfahren weiter. Bewusst kein zweites navigate(): das gab im finally die
    // Sperre frei, waehrend das innere noch lud, und fragte den Verlassen-Schutz
    // zweimal (Review #1638). takeDetour berichtigt nur den Pfad; Adresse und
    // Hinweis folgen erst hinter Schutz und Sperre.
    let detourAddress = null;
    let unknownNotice = false;
    const takeDetour = (push) => {
      const detour = unknownDetourFor(path);
      if (!detour) return false;
      const corrected = detourPaths(detour, path, { pushState: push, location });
      path = corrected.path;
      detourAddress = corrected.address;
      unknownNotice = detour.notify;
      return true;
    };
    // Kaltstart und Zurueck/Vor: die tote Adresse IST der laufende Eintrag und
    // wird ersetzt, Zurueck fuehrt danach nicht wieder auf sie. Bei einem Wechsel
    // in der App schreibt der regulaere Eintrag weiter unten die berichtigte.
    const commitDetourAddress = (push) => {
      if (!push && detourAddress) history.replaceState({ path }, '', detourAddress);
    };
    // In einer laufenden Sitzung steht die Modulliste schon (sie kommt mit den
    // Praeferenzen) - dann VOR dem Verlassen-Schutz, damit er nach dem Ziel
    // fragt, auf dem die Navigation endet. Sonst nach dem zweiten Lookup unten.
    // Ohne Sitzung (#1640) ebenfalls hier, aber nur fuer oeffentliche Vorfahren:
    // der Lookup unten fiele sonst auf die Uebersicht zurueck, die eine Sitzung
    // verlangt, und `/pair/extra` endete auf der Anmeldung statt auf `/pair`.
    if (typeof userOrPushState !== 'object' && (!state.currentUser || state._preferencesLoaded)) takeDetour(userOrPushState);
    // VERLASSEN-SCHUTZ (utils/leave-guard.js, Re-Critique 2026-09-28 A7 P2-1):
    // eine Seite mit ungespeicherter Arbeit - der Anpassen-Modus der Uebersicht -
    // fragt, bevor sie verschwindet. Jeder Weg endet hier: Seitenleiste,
    // Tab-Leiste, Mehr-Blatt, Befehlspalette, Zurueck (popstate). Nur fuer
    // Wechsel einer angemeldeten Sitzung: das Anmelden (Objekt) und ein
    // Sitzungsablauf fragen nicht. Ohne Waechter kein await: zwischen der
    // Pruefung oben und `isNavigating = true` darf keine Luecke entstehen.
    if (state.currentUser && typeof userOrPushState !== 'object' && hasLeaveGuard() && !(await mayLeave(path))) {
      // Ein Zurueck hat die Adresse schon gewechselt - sie gehoert wieder der
      // Seite, die stehen bleibt.
      // Erst wenn die Rueckfrage ihren History-Eintrag zurueckgegeben hat
      // (whenHistorySettled in utils/overlay-history.js) - sonst truege deren
      // spaetes back() die Adresse gleich wieder weg.
      if (userOrPushState === false && state.currentPath) {
        const stay = state.currentPath;
        await whenHistorySettled();
        history.pushState({ path: stay }, '', stay);
      }
      return;
    }
    state.isNavigating = true;
    running = run;
    commitDetourAddress(userOrPushState);

    // Offenes „Mehr“-Sheet beim Navigieren immer schließen - robust und
    // unabhängig vom Klick-Bubbling (das reißt, wenn die Navigation
    // zwischendurch rebuildNavigation() auslöst, z. B. beim Settings-Ziel).
    if (window._closeMoreSheet) window._closeMoreSheet({ restoreFocus: false });

    try {
      // Überlastung: navigate(path, user) nach Login vs navigate(path, false) beim Init
      if (typeof userOrPushState === 'object' && userOrPushState !== null) {
        state.currentUser = userOrPushState;
        state._setupRequired = false;
        // Ab hier gibt es jemanden, dessen Bildschirmschoner es sein kann
        // (#1919). VOR dem await: laeuft die Sitzung dabei ab, entschaerft
        // `auth:expired` ihn wieder. Fuer jedes Konto, auch Gast und Display.
        armScreensaver();
        await syncPreferencesOnce();
        startThirdPartyModulePolling();
        // currentUser kann während des await oben auf null gesetzt worden sein
        // (auth:expired bei 401 von /preferences), daher Guard gegen null.
        if (state.currentUser && !['split_guest', 'display'].includes(state.currentUser.access_scope)) {
          loadReminderStyles();
          initReminders();
          initPush();
        }
      } else {
        pushState = userOrPushState;
      }

      // Alten Pfad merken, bevor currentPath aktualisiert wird - Kaltstart oder Wechsel
      const previousPath = state.currentPath;
      let basePath = path.split('?')[0];
      state.currentPath = basePath;

      // Scrollstand der Seite festhalten, die gerade verlassen wird - er ist die
      // Antwort auf ein späteres Browser-Zurück. Bewusst vor den Guards: was hier
      // sichtbar ist, gilt unabhängig davon, ob die Navigation gleich umgeleitet
      // wird. Der Scrollport ist #main-content selbst (== .app-content).
      if (previousPath) {
        rememberScrollPosition(previousPath, document.getElementById('main-content')?.scrollTop ?? 0);
      }
      // Vorwärts heißt oben anfangen, Zurück/Vor heißt weitermachen. Details und
      // die Begründung gegen eine Nav-Reihenfolge in utils/scroll-restore.js.
      let scrollTarget = scrollPositionFor(basePath, { restore: !pushState });

      // First-Run-Weiche: Solange kein Account existiert und niemand eingeloggt ist,
      // alle Routen außer /setup auf /setup umleiten.
      if (state._setupRequired && !state.currentUser && basePath !== '/setup') {
        state.currentPath = null;
        state.isNavigating = false;
        navigate('/setup');
        return;
      }
      // Setup bereits erledigt -> /setup ist nicht mehr erreichbar.
      if (!state._setupRequired && basePath === '/setup') {
        state.currentPath = null;
        state.isNavigating = false;
        navigate('/login');
        return;
      }

      let route = allRoutes().find((r) => r.path === basePath) ?? ROUTES.find((r) => r.path === '/');

      // DIESE Navigation laeuft auf einem anderen Pfad weiter (#1640), wie beim
      // Umweg oben: kein zweites navigate(). Das gab im finally die Sperre frei,
      // waehrend das innere noch lud, und liess den Eintrag der Adresse stehen,
      // von der die Weiche gleich wieder wegfuehrt - Zurueck landete in ihr.
      // Kaltstart und Zurueck/Vor ersetzen den laufenden Eintrag, ein Wechsel in
      // der App schreibt weiter unten das berichtigte Ziel.
      const continueOn = (target) => {
        path = target;
        basePath = target;
        state.currentPath = target;
        scrollTarget = scrollPositionFor(target, { restore: !pushState });
        route = allRoutes().find((r) => r.path === target) ?? route;
        detourAddress = target;
        commitDetourAddress(pushState);
      };

      // Split-Guest-Weiche: Gäste einer Ausgabenteilung sehen nur das Budget-Modul.
      // ABER: hat der Nutzer zusätzlich eine Familienrolle OHNE Budget-Recht, würde
      // ein bedingungsloser Wechsel auf '/budget' vom Modul-Guard (canAccessNavModule)
      // sofort wieder auf '/' geworfen - und '/' schickt zurück auf '/budget':
      // Endlosschleife bis Stack-Overflow (#480). Daher nur umleiten, wenn Budget
      // tatsächlich zugänglich ist; sonst greift der reguläre Rechte-Guard und der
      // Nutzer landet auf einer für ihn erlaubten Seite.
      // Zugaenglich heisst auch: im Haushalt nicht abgeschaltet (#1640). Der
      // Modul-Guard wirft von einem abgeschalteten '/budget' auf '/', die Weiche
      // von '/' wieder zurueck - dieselbe Schleife - und hinter dem Auth-Guard
      // prueft nach der Weiche niemand mehr die Abschaltung.
      if (state.currentUser?.access_scope === 'split_guest'
          && route.path !== '/budget'
          && canAccessNavModule('budget')
          && !state._disabledModules.has('budget')) {
        continueOn('/budget');
      }

      // Modul-Guard: deaktivierte ODER per Rechte gesperrte Module leiten auf das
      // Dashboard um (Rechte-Guard #467; die verbindliche 403-Sperre liegt am Server).
      if (route.module
          && route.path !== '/'
          && (state._disabledModules.has(route.module) || !canAccessNavModule(route.module))) {
        state.currentPath = null;
        state.isNavigating = false;
        navigate('/');
        return;
      }

      // Auth-Guard
      if (route.requiresAuth && !state.currentUser) {
        try {
          const result = await auth.me();
          state.currentUser = result.user;
          // Wie beim Anmelden oben (#1919). Hier wird auch ein gekoppeltes
          // Wanddisplay scharf: es hat keine Nutzersitzung, aber `/auth/me`
          // antwortet ihm mit seinem Konto.
          armScreensaver();
          await syncPreferencesOnce();
          startThirdPartyModulePolling();
          // currentUser kann während des await oben auf null gesetzt worden sein
          // (auth:expired bei 401 von /preferences), daher Guard gegen null.
          if (state.currentUser && !['split_guest', 'display'].includes(state.currentUser.access_scope)) {
            loadReminderStyles();
            initReminders();
            initPush();
          }
        } catch (err) {
          state.currentPath = null; // Reset damit navigate('/login') nicht geblockt wird
          state.isNavigating = false;
          // _pendingLoginRedirect leeren: der catch ruft navigate('/login') direkt auf,
          // der finally soll keinen zweiten Aufruf starten (würde isNavigating=true setzen,
          // während die Login-Seite rendert, und so post-login navigate blockieren).
          state._pendingLoginRedirect = false;
          // NUR EIN 401 HEISST "NICHT ANGEMELDET" (Critique R19, 2026-10-16).
          // Bis hierher fuehrte jeder Fehler zur Anmeldung: eine Bremse (429),
          // ein Serverfehler, ein Netzabbruch beim Kaltstart - mit gueltigen
          // Cookies. Alles ausser dem 401 zeigt jetzt den Fehlerzustand der
          // Shell, der selbst erneut versucht (utils/session-unreachable.js).
          // Derselbe Pfad und dieselbe Art wie dieser Aufruf, damit ein Erfolg
          // dort landet, wo die Navigation hinwollte.
          if (err?.status !== 401) {
            const retryPath = path;
            const retryPush = pushState;
            showSessionUnreachable(err, () => navigate(retryPath, retryPush));
            return;
          }
          navigate(state._setupRequired ? '/setup' : '/login');
          return;
        }
      }

      route = allRoutes().find((r) => r.path === basePath) ?? route;

      // Unbekannte Adresse, zweite Stelle (Kaltstart, Anmeldung): ERST HIER
      // sind die Erweiterungsrouten geladen (syncThirdPartyModules im Auth-Guard),
      // davor waere jede "unbekannt". Einen Verlassen-Schutz gibt es auf diesem
      // Weg nicht - es steht noch keine Seite. Die Guards danach urteilen ueber
      // die berichtigte Route.
      if (takeDetour(pushState)) {
        basePath = path.split('?')[0];
        state.currentPath = basePath;
        scrollTarget = scrollPositionFor(basePath, { restore: !pushState });
        route = allRoutes().find((r) => r.path === basePath) ?? route;
        commitDetourAddress(pushState);
      }

      // Split-Guest-Weiche: Gäste einer Ausgabenteilung sehen nur das Budget-Modul.
      // ABER: hat der Nutzer zusätzlich eine Familienrolle OHNE Budget-Recht, würde
      // ein bedingungsloser Wechsel auf '/budget' vom Modul-Guard (canAccessNavModule)
      // sofort wieder auf '/' geworfen - und '/' schickt zurück auf '/budget':
      // Endlosschleife bis Stack-Overflow (#480). Daher nur umleiten, wenn Budget
      // tatsächlich zugänglich ist; sonst greift der reguläre Rechte-Guard und der
      // Nutzer landet auf einer für ihn erlaubten Seite.
      // Zugaenglich heisst auch: im Haushalt nicht abgeschaltet (#1640). Der
      // Modul-Guard wirft von einem abgeschalteten '/budget' auf '/', die Weiche
      // von '/' wieder zurueck - dieselbe Schleife - und hinter dem Auth-Guard
      // prueft nach der Weiche niemand mehr die Abschaltung.
      if (state.currentUser?.access_scope === 'split_guest'
          && route.path !== '/budget'
          && canAccessNavModule('budget')
          && !state._disabledModules.has('budget')) {
        continueOn('/budget');
      }

      // Modul-Guard, zweite Stelle: nach frisch geladenen Rechten UND Praeferenzen
      // (Deep-Link auf ein gesperrtes oder abgeschaltetes Modul → Dashboard). #467
      //
      // Dieselbe Regel wie am Modul-Guard oben. Die Abschaltung fehlte hier: beim
      // Kaltstart laeuft der Guard oben, bevor die Praeferenzen geladen sind -
      // `_disabledModules` ist dann noch leer - und hier pruefte nur das Recht.
      // Der Direktlink auf ein abgeschaltetes Modul wurde gezeichnet.
      //
      // Wie die Gast-Weiche darueber laeuft DIESE Navigation weiter, statt eine
      // zweite zu starten (#1640). Das Ziel '/' nimmt die Bedingung selbst aus:
      // es kann weder abgeschaltet noch gesperrt sein, eine Schleife gibt es nicht.
      if (route.module
          && route.path !== '/'
          && (state._disabledModules.has(route.module) || !canAccessNavModule(route.module))) {
        continueOn('/');
      }

      if (!route.requiresAuth && state.currentUser && path === '/login') {
        state.currentPath = null;
        state.isNavigating = false;
        navigate('/');
        return;
      }

      // Nur die direkt folgende Navigation tritt an die Stelle einer ueberholten.
      const replaceEntry = replaceNextEntry;
      replaceNextEntry = false;
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
        /* DIESELBE ADRESSE IST KEIN NEUER SCHRITT (R20). Ein zweiter Eintrag
         * mit der Adresse, die schon steht, macht Zurueck zu einer Geste ohne
         * sichtbare Wirkung - derselbe Fehler wie beim Dialog-Platzhalter.
         * Zuerst consumeOverlayMarker(): es schliesst auch dann offene Dialoge. */
        const address = detourAddress ?? path;
        if (consumeOverlayMarker() || replaceEntry || isCurrentAddress(address, location)) history.replaceState({ path }, '', address);
        else history.pushState({ path }, '', address);
      }

      // Soft-Navigation innerhalb desselben Moduls (z. B. Settings-Blatt → Blatt
      // oder Browser-Zurück innerhalb der Einstellungen): Das bereits gerenderte
      // Modul tauscht nur seinen Detailbereich aus - keine App-Shell-Teardown,
      // keine Slide-Transition, kein erneuter Auth-Refresh. Gibt update() false
      // zurück (z. B. Redirect nötig), fällt die Navigation auf das volle Rendern
      // zurück.
      if (
        route.module
        && route.module === state._renderedModuleName
        && typeof state._renderedModule?.update === 'function'
      ) {
        let handled = false;
        try {
          // UEBERHOLBAR WIE renderPage() (Review #2049, Runde 2). update()
          // wartet auf Daten - Schedules Reiterwechsel auf activateView() und
          // dessen Abruf ohne Signal. Blank abgewartet hielt das den naechsten
          // Tipp auf, denn der wartende startet erst im finally. Das Signal
          // reist mit; endet das Warten mit dem Abbruch, kehrt diese
          // Navigation zurueck, ohne Scroll, FAB oder Nav anzufassen - und
          // ohne ein spaetes false noch auf ein volles Rendern umzulenken.
          const updating = state._renderedModule.update({
            user: state.currentUser,
            path: basePath,
            query: new URLSearchParams(path.split('?')[1] ?? ''),
            signal: run.signal,
          });
          if (!(await unlessAborted(updating, run.signal))) return;
          handled = await updating;
        } catch (error) {
          console.error('[Router] Soft-Update fehlgeschlagen, vollständiges Rendern folgt:', error);
          handled = false;
        }
        if (run.signal.aborted) return;
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
      // CSS und -Daten noch laden - statt erst nach Abschluss des Renders. Beim aller-
      // ersten Laden wird die Shell erst in renderPage gebaut; dann greift allein die
      // autoritative Aktualisierung danach.
      if (document.querySelector('.nav-bottom')) {
        updateNav(topLevelSection(basePath));
        updateThemeColorForRoute(route);
      }

      const shown = await renderPage(route, previousPath, scrollTarget, { signal: run.signal });
      if (run.signal.aborted) {
        // Ueberholt. Hat renderPage() nichts gezeichnet (`false`), gilt die
        // Seite, die zu sehen ist, und der Eintrag dieser Navigation gehoert dem
        // naechsten Ziel. Steht die Seite schon, bleibt beides - Nav, Titel und
        // Fokus zieht ohnehin die naechste Navigation nach.
        if (shown === false) {
          if (state.currentPath === basePath) state.currentPath = previousPath;
          if (pushState) replaceNextEntry = true;
        }
        return;
      }
      // Autoritative Aktualisierung nach dem Render: deckt den Erstlade-Fall ab und
      // markiert ggf. seiten-interne [data-route]-Links (idempotent).
      // Settings-Blätter teilen sich den /settings Nav-Eintrag (aria-current).
      updateNav(topLevelSection(basePath));
      updateThemeColorForRoute(route);
      updateBranding(basePath);
      focusMainContentAfterNavigation(basePath);
    } finally {
      // Hat eine Weiche oben schon die naechste Navigation gestartet, gehoert
      // ihr der Wartende - nicht diesem finally.
      const handOver = running === run;
      state.isNavigating = false;
      if (handOver) running = null;
      // Im finally, weil auch die Soft-Navigation (Settings-Blatt) frueh
      // zurueckkehrt - und nach dem Rendern, weil es die Toast-Flaeche beim
      // Kaltstart erst mit der Shell gibt. Deshalb leitet die Gast-Weiche oben
      // nicht mehr ueber ein zweites navigate() weiter (#1640): dieses finally
      // lief dann VOR dessen Rendern, und der Hinweis fand keine Flaeche.
      // Eine ueberholte Navigation meldet ihre Adresse nicht mehr.
      if (unknownNotice && !run.signal.aborted) showToast(t('common.unknownAddress'), 'default', 5000);
      // auth:expired kann waehrend einer Navigation gefeuert haben (z.B. wenn ein
      // paralleler API-Call 401 zurueckgab). Jetzt wo die Navigation abgeschlossen
      // ist, holen wir die Login-Weiterleitung nach.
      if (state._pendingLoginRedirect) {
        state._pendingLoginRedirect = false;
        queued?.resolve();
        queued = null;
        toSignIn();
      } else if (handOver) {
        startQueued();
      }
    }
  }

  /**
   * Nach einem Sitzungsende zur Anmeldung - es sei denn, die Seite, die steht,
   * braucht gar keine Sitzung (#1945).
   *
   * DIE EINE STELLE, DIE DAS ENTSCHEIDET, fuer beide Wege: sofort aus
   * `auth:expired` und nachgeholt im finally einer laufenden Navigation. Bis
   * hierher fuehrten beide bedingungslos auf `/login`, und navigate() kennt
   * keinen Ausstieg fuer dieselbe Adresse: es zeichnete die Anmeldeseite neu -
   * ein halb getippter Name samt Passwort war weg (im Browser gemessen). Waehrend
   * die Einrichtung aussteht, leitet `/login` auf `/setup` um und zeichnete diese
   * Seite neu. Dasselbe gilt fuer jede oeffentliche Seite (`/join`, `/pair`,
   * Passwort vergessen/zuruecksetzen): ohne Sitzung gibt es dort nichts, was
   * eine Sitzung braeuchte, und das Formular bleibt stehen. Unbekannt (Kaltstart,
   * noch keine Seite) heisst: zur Anmeldung, wie bisher.
   *
   * `currentPath` ist das ZIEL, nicht das Gezeichnete (Review #2070): laedt das
   * Modul einer oeffentlichen Seite nicht, zeichnet renderPage() nur den Fehler
   * in den Inhalt, und die Shell der Sitzung steht weiter. Ob sie steht, sagt
   * `.nav-bottom` - dasselbe Zeichen, an dem renderPage() und navigate() sie
   * erkennen. Steht sie, geht es zur Anmeldung, die sie abraeumt.
   */
  function toSignIn() {
    const standing = allRoutes().find((r) => r.path === state.currentPath);
    if (standing && !standing.requiresAuth && !document.querySelector('.nav-bottom')) return;
    navigate('/login');
  }

  // Sitzung abgelaufen (api.js feuert das Ereignis vor dem Wurf eines 401).
  // Der Listener steht HIER und nicht in router.js, damit der Test genau ihn
  // ausloest und nicht eine Nachbildung (test/router-navigate-harness.js).
  window.addEventListener('auth:expired', () => {
    forgetSessionState();
    if (state.isNavigating) {
      // Waehrend einer Navigation nicht sofort: ihr finally holt es nach.
      state._pendingLoginRedirect = true;
    } else {
      toSignIn();
    }
  });

  return navigate;
}
