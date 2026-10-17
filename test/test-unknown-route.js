/**
 * Tests: unbekannte Adresse (#1607)
 *
 * Bis dahin fiel ein Pfad ohne Route (`/settings/xyz`) in `navigate()` still
 * auf die Uebersicht zurueck: die Adresse blieb stehen, der Titel hiess
 * "App-Name · App-Name". Jetzt fuehrt er auf den naechsten bekannten Vorfahren,
 * die tote Adresse verlaesst die History, und ein Hinweis sagt es einmal.
 *
 * router.js ist browser-gekoppelt und nicht importierbar. Die Entscheidung und
 * ihre Wirkung stehen deshalb in `public/utils/unknown-route.js` und laufen
 * hier als Programm. Seit #1640 laeuft auch `navigate()` selbst, seit #1657
 * als importiertes Modul (public/utils/router-navigate.js): der Helfer
 * test/router-navigate-harness.js gibt ihm aufzeichnende Stellvertreter, und
 * der Teil "navigate() als Programm" misst, wo eine Navigation ENDET. Der
 * aeltere Verdrahtungsteil am Quelltext bleibt daneben stehen.
 *
 * Ausfuehren: node --test test/test-unknown-route.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createNavigateHarness, HARNESS_ROUTES } from './router-navigate-harness.js';

const load = () => import('../public/utils/unknown-route.js');
// navigate() steht seit #1657 in einem eigenen Modul. Der Verdrahtungsteil liest
// BEIDE Dateien als einen Text: "genau ein Aufrufer" und "Hinweis genau einmal"
// gelten ueber den Router samt Modul, nicht nur ueber die Datei, die uebrig blieb.
const navigateSrc = readFileSync(new URL('../public/utils/router-navigate.js', import.meta.url), 'utf8');
const routerSrc = `${readFileSync(new URL('../public/router.js', import.meta.url), 'utf8')}\n${navigateSrc}`;

const KNOWN = [
  '/login', '/setup', '/pair', '/', '/tasks', '/budget', '/health', '/health/vitals',
  '/settings', '/settings/appearance', '/schedule', '/m/garden',
];

// ─── Die Entscheidung ───────────────────────────────────────────────────────

test('unbekannter Pfad unter einer Sektion fuehrt auf die Sektion', async () => {
  const { unknownPathDetour } = await load();
  assert.deepEqual(unknownPathDetour('/settings/xyz', { known: KNOWN }), { target: '/settings', notify: true });
  assert.deepEqual(unknownPathDetour('/settings/appearance/xyz', { known: KNOWN }), { target: '/settings/appearance', notify: true });
  assert.deepEqual(unknownPathDetour('/health/xyz/abc', { known: KNOWN }), { target: '/health', notify: true });
  assert.deepEqual(unknownPathDetour('/tasks/42', { known: KNOWN }), { target: '/tasks', notify: true });
});

test('unbekannter Pfad ohne bekannten Vorfahren fuehrt auf die Uebersicht', async () => {
  const { unknownPathDetour } = await load();
  assert.deepEqual(unknownPathDetour('/xyz', { known: KNOWN }), { target: '/', notify: true });
  assert.deepEqual(unknownPathDetour('/xyz/abc', { known: KNOWN }), { target: '/', notify: true });
  // Gross-/Kleinschreibung zaehlt wie im Router: `/Settings` ist keine Route.
  assert.deepEqual(unknownPathDetour('/Settings', { known: KNOWN }), { target: '/', notify: true });
});

test('bekannte Routen bleiben unberuehrt, auch die Uebersicht selbst', async () => {
  const { unknownPathDetour } = await load();
  for (const path of KNOWN) {
    assert.equal(unknownPathDetour(path, { known: KNOWN }), null, path);
  }
  // Query und Hash machen eine bekannte Route nicht unbekannt.
  assert.equal(unknownPathDetour('/budget?tab=budget', { known: KNOWN }), null);
  assert.equal(unknownPathDetour('/tasks#x', { known: KNOWN }), null);
});

test('Query und Hash des unbekannten Pfads reisen nicht mit', async () => {
  const { unknownPathDetour } = await load();
  assert.deepEqual(unknownPathDetour('/settings/xyz?view=domains&open=3', { known: KNOWN }), { target: '/settings', notify: true });
  assert.deepEqual(unknownPathDetour('/xyz#frag', { known: KNOWN }), { target: '/', notify: true });
  assert.deepEqual(unknownPathDetour('/xyz?a=1#frag', { known: KNOWN }), { target: '/', notify: true });
});

test('nur ein Schraegstrich zu viel: richtige Seite, kein Hinweis', async () => {
  const { unknownPathDetour } = await load();
  assert.deepEqual(unknownPathDetour('/settings/', { known: KNOWN }), { target: '/settings', notify: false });
  assert.deepEqual(unknownPathDetour('/tasks//', { known: KNOWN }), { target: '/tasks', notify: false });
  // Ein unbekanntes Blatt mit Schraegstrich bleibt unbekannt.
  assert.deepEqual(unknownPathDetour('/settings/xyz/', { known: KNOWN }), { target: '/settings', notify: true });
});

test('Erweiterungsrouten: eine nicht geladene oder abgeschaltete Modulroute gilt nicht als unbekannt', async () => {
  const { unknownPathDetour } = await load();
  // Die Modulliste ist (noch) leer oder nennt das Modul nicht als aktiv.
  const withoutModules = KNOWN.filter((path) => !path.startsWith('/m/'));
  assert.equal(unknownPathDetour('/m/garden', { known: withoutModules }), null);
  assert.equal(unknownPathDetour('/m/garden/beds', { known: withoutModules }), null);
  assert.equal(unknownPathDetour('/m', { known: withoutModules }), null);
  assert.equal(unknownPathDetour('/m/', { known: withoutModules }), null);
  // Registriert und aktiv: die Route selbst ist bekannt, ein Pfad darunter
  // fuehrt auf sie.
  assert.equal(unknownPathDetour('/m/garden', { known: KNOWN }), null);
  assert.deepEqual(unknownPathDetour('/m/garden/beds', { known: KNOWN }), { target: '/m/garden', notify: true });
  // `/mx` ist kein Erweiterungspfad.
  assert.deepEqual(unknownPathDetour('/mx', { known: KNOWN }), { target: '/', notify: true });
});

test('Pfade, die der Server beantwortet, werden nicht umgeleitet', async () => {
  const { unknownPathDetour } = await load();
  for (const path of [
    // Unterbaeume, die server/index.js ganz bedient (`app.use`).
    '/api/v1/tasks', '/api', '/api/typo', '/mcp', '/mcp/sse',
    // `/docs` gibt es am Server nur genau so (mit und ohne Schraegstrich).
    '/docs', '/docs/',
    // Dateien ausserhalb jeder App-Route: Feeds, Shell, Statisches.
    '/feed/calendar/abc.ics', '/openapi.json', '/sw.js', '/index.html', '/manifest.webmanifest',
    '/styles/tokens.css', '/locales/de.json', '/icons/icon-192.png',
  ]) {
    assert.equal(unknownPathDetour(path, { known: KNOWN }), null, path);
  }
  // Nur das ERSTE Segment entscheidet: `/apiary` ist kein Serverpfad.
  assert.deepEqual(unknownPathDetour('/apiary', { known: KNOWN }), { target: '/', notify: true });
  assert.deepEqual(unknownPathDetour('/tasks/api', { known: KNOWN }), { target: '/tasks', notify: true });
});

test('die Ausnahmen reichen nicht weiter als der Server (Review #1638)', async () => {
  const { unknownPathDetour } = await load();
  // Unter `/docs` bedient der Server nichts: `/docs/typo` bekommt die Shell.
  assert.deepEqual(unknownPathDetour('/docs/typo', { known: KNOWN }), { target: '/', notify: true });
  // Ein Feed ohne Datei ist keiner.
  assert.deepEqual(unknownPathDetour('/feed/calendar', { known: KNOWN }), { target: '/', notify: true });
  // Ein Punkt macht einen Pfad UNTER einer App-Route nicht zur Datei.
  assert.deepEqual(unknownPathDetour('/settings/missing.js', { known: KNOWN }), { target: '/settings', notify: true });
  assert.deepEqual(unknownPathDetour('/tasks/v1.2', { known: KNOWN }), { target: '/tasks', notify: true });
  // Auch unter einer Route, die gerade kein Landeplatz ist.
  const landable = KNOWN.filter((path) => path !== '/budget');
  assert.deepEqual(unknownPathDetour('/budget/report.pdf', { known: KNOWN, landable }), { target: '/', notify: true });
});

test('ein nicht erreichbarer Vorfahr wird uebersprungen', async () => {
  const { unknownPathDetour } = await load();
  // Budget ist abgeschaltet oder fuer dieses Mitglied gesperrt: der Umweg
  // endet nicht auf einer Seite, von der der Modul-Guard gleich wieder wegfuehrt.
  const landable = KNOWN.filter((path) => path !== '/budget');
  assert.deepEqual(unknownPathDetour('/budget/xyz', { known: KNOWN, landable }), { target: '/', notify: true });
  // Die abgeschaltete Route SELBST ist bekannt und bleibt dem Modul-Guard.
  assert.equal(unknownPathDetour('/budget', { known: KNOWN, landable }), null);
});

test('kein Pfad, kein Urteil', async () => {
  const { unknownPathDetour } = await load();
  for (const path of [undefined, null, '', 'tasks', 42, {}]) {
    assert.equal(unknownPathDetour(path, { known: KNOWN }), null, String(path));
  }
});

// ─── Ohne Sitzung: nur oeffentliche Vorfahren (#1640) ───────────────────────

const OPEN = ['/login', '/setup', '/pair'];
const OPEN_LANDABLE = ['/pair'];

test('ohne Sitzung fuehrt ein unbekannter Pfad unter einer oeffentlichen Seite auf sie', async () => {
  const { publicPathDetour } = await load();
  const routes = { known: KNOWN, open: OPEN, landable: OPEN_LANDABLE };
  assert.deepEqual(publicPathDetour('/pair/extra', routes), { target: '/pair', notify: true });
  assert.deepEqual(publicPathDetour('/pair/a/b?code=1#x', routes), { target: '/pair', notify: true });
  // Nur ein Schraegstrich zu viel: dieselbe Seite, kein Hinweis - auch die Anmeldung.
  assert.deepEqual(publicPathDetour('/pair/', routes), { target: '/pair', notify: false });
  assert.deepEqual(publicPathDetour('/login/', routes), { target: '/login', notify: false });
  // Eine bekannte Adresse braucht keinen Umweg.
  assert.equal(publicPathDetour('/pair', routes), null);
});

test('ohne Sitzung bleibt alles andere unbeurteilt, bis die Anmeldung steht', async () => {
  const { publicPathDetour } = await load();
  const routes = { known: KNOWN, open: OPEN, landable: OPEN_LANDABLE };
  // Der Vorfahr verlangt eine Sitzung: erst hinter dem Auth-Guard.
  assert.equal(publicPathDetour('/settings/xyz', routes), null);
  assert.equal(publicPathDetour('/settings/', routes), null);
  // Kein bekannter Vorfahr: die Uebersicht verlangt eine Sitzung.
  assert.equal(publicPathDetour('/xyz', routes), null);
  // Anmeldung und Einrichtung sind kein Landeplatz - der Pfad bleibt offen.
  assert.equal(publicPathDetour('/login/extra', routes), null);
  assert.equal(publicPathDetour('/setup/extra', routes), null);
  // Erweiterungsrouten kommen erst mit der Anmeldung.
  const withoutModules = KNOWN.filter((path) => !path.startsWith('/m/'));
  assert.equal(publicPathDetour('/m/garden/beds', { known: withoutModules, open: OPEN, landable: OPEN_LANDABLE }), null);
  // Was der Server beantwortet, bleibt unberuehrt wie mit Sitzung.
  assert.equal(publicPathDetour('/api/v1/tasks', routes), null);
  // Ein Landeplatz, der nicht oeffentlich ist, zaehlt nicht.
  assert.equal(publicPathDetour('/tasks/42', { known: KNOWN, open: OPEN, landable: KNOWN }), null);
});

// ─── Adresse und Pfad nach dem Umweg ────────────────────────────────────────

test('echt unbekannt: Query und Hash fallen weg, in Pfad und Adresse', async () => {
  const { unknownPathDetour, detourPaths } = await load();
  const location = { search: '?view=domains', hash: '#frag' };
  for (const pushState of [true, false]) {
    const path = '/settings/xyz?view=domains#frag';
    assert.deepEqual(
      detourPaths(unknownPathDetour(path, { known: KNOWN }), path, { pushState, location }),
      { path: '/settings', address: '/settings' },
    );
  }
});

test('nur ein Schraegstrich zu viel: Query und Hash bleiben (Review #1638)', async () => {
  const { unknownPathDetour, detourPaths } = await load();
  // Kaltstart und Zurueck/Vor: navigate() bekommt nur `location.pathname`,
  // die Parameter stehen in der Adresszeile - und die Seite liest sie dort.
  for (const [search, hash] of [['?view=domain&domain=calendar', ''], ['?sync_ok', ''], ['?sync_error=google', '#top'], ['', '']]) {
    const path = '/settings/';
    assert.deepEqual(
      detourPaths(unknownPathDetour(path, { known: KNOWN }), path, { pushState: false, location: { search, hash } }),
      { path: '/settings', address: `/settings${search}${hash}` },
      search + hash,
    );
  }
  // Wechsel innerhalb der App: die Parameter stehen im uebergebenen Pfad, die
  // Adresszeile gehoert noch der Seite davor.
  const inApp = '/settings/?view=domain&domain=calendar#x';
  assert.deepEqual(
    detourPaths(unknownPathDetour(inApp, { known: KNOWN }), inApp, { pushState: true, location: { search: '?tab=budget', hash: '' } }),
    { path: '/settings?view=domain&domain=calendar', address: '/settings?view=domain&domain=calendar#x' },
  );
});

// ─── Die Verdrahtung in navigate() ──────────────────────────────────────────
// navigate() haengt am Browser; geprueft wird am Quelltext die REIHENFOLGE, an
// der die Befunde aus dem Review zu #1638 hingen.

function navigateBody() {
  const start = navigateSrc.indexOf('async function navigate(');
  const end = navigateSrc.indexOf('\n  return navigate;\n', start);
  assert.ok(start > 0 && end > start, 'navigate() nicht gefunden');
  return navigateSrc.slice(start, end);
}
const count = (haystack, needle) => haystack.split(needle).length - 1;

test('navigate() loest den Umweg selbst auf: kein verschachteltes navigate, eine Sperre', () => {
  const body = navigateBody();
  // Ein un-awaitetes navigate(target) gab im finally die Sperre frei, waehrend
  // das innere noch lud - ein zweiter Klick startete eine parallele Navigation.
  assert.equal(count(routerSrc, 'followUnknownPathDetour'), 0, 'der Umweg laeuft wieder ueber ein zweites navigate()');
  assert.equal(count(body, 'takeDetour('), 2, 'genau zwei Stellen: vor dem Verlassen-Schutz und nach dem zweiten Lookup');
  const helper = body.indexOf('const takeDetour = ');
  assert.ok(helper > 0, 'takeDetour nicht gefunden');
  const helperBody = body.slice(helper, body.indexOf('};', helper));
  assert.doesNotMatch(helperBody, /navigate\(/, 'takeDetour ruft navigate()');
  assert.match(helperBody, /path = /, 'takeDetour berichtigt den Pfad dieser Navigation');
});

test('der Verlassen-Schutz fragt genau einmal, und zwar nach dem berichtigten Ziel', () => {
  const body = navigateBody();
  assert.equal(count(body, 'mayLeave('), 1);
  const early = body.indexOf('takeDetour(userOrPushState)');
  const guard = body.indexOf('mayLeave(path)');
  assert.ok(early > 0, 'der fruehe Umweg fehlt');
  assert.ok(early < guard, 'der Umweg wird erst nach dem Verlassen-Schutz aufgeloest - der fragte dann nach der toten Adresse');
  // Frueh nur, wenn die Modulliste da ist: angemeldet und Praeferenzen geladen.
  const condition = body.slice(body.lastIndexOf('if (', early), early);
  assert.match(condition, /currentUser/);
  assert.match(condition, /_preferencesLoaded/);
});

test('bricht der Verlassen-Schutz ab, aendert sich weder Adresse noch erscheint der Hinweis', () => {
  const body = navigateBody();
  const guard = body.indexOf('mayLeave(path)');
  const lock = body.indexOf('isNavigating = true;');
  assert.ok(guard > 0 && lock > guard);
  // Alles, was der Umweg an der Welt aendert, steht hinter der Sperre.
  const replace = body.indexOf('commitDetourAddress(');
  assert.ok(replace > lock, 'die Adresse wird vor dem Verlassen-Schutz ersetzt');
  // Vor der Sperre steht `history.replaceState` nur in der DEFINITION des Helfers.
  const helper = body.indexOf('const commitDetourAddress = ');
  const beforeLock = body.slice(0, helper) + body.slice(body.indexOf('};', helper), lock);
  assert.equal(count(beforeLock, 'history.replaceState'), 0);
  assert.equal(count(beforeLock, 'showToast('), 0);
  const toast = body.indexOf("showToast(t('common.unknownAddress')");
  assert.ok(toast > lock, 'der Hinweis steht vor dem Verlassen-Schutz');
  assert.equal(count(routerSrc, "t('common.unknownAddress')"), 1, 'Hinweis genau einmal');
  // Im finally: auch die Soft-Navigation (Settings-Blatt) kehrt frueh zurueck.
  assert.ok(toast > body.lastIndexOf('} finally {'), 'der Hinweis steht nicht im finally - die Soft-Navigation bliebe stumm');
});

test('der zweite Umweg steht nach dem zweiten Routen-Lookup und vor dem History-Eintrag', () => {
  const body = navigateBody();
  const secondLookup = body.indexOf('route = allRoutes().find((r) => r.path === basePath) ?? route;');
  const late = body.indexOf('takeDetour(pushState)');
  const push = body.indexOf('history.pushState({ path }');
  assert.ok(secondLookup > 0, 'zweiter Routen-Lookup nicht gefunden');
  // Erst nach dem Auth-Guard ist die Modulliste geladen: davor waere beim
  // Kaltstart jede Erweiterungsroute "unbekannt".
  assert.ok(late > secondLookup, 'die Pruefung steht vor dem zweiten Lookup');
  assert.ok(late < push, 'die Pruefung steht hinter dem History-Eintrag der toten Adresse');
  const block = body.slice(late, late + 700);
  for (const needle of ['basePath = ', 'currentPath = basePath', 'scrollTarget = ', 'route = ', 'commitDetourAddress(']) {
    assert.ok(block.includes(needle), `nach dem Umweg fehlt: ${needle}`);
  }
});

test('die Adresse des Umwegs: ersetzt bei Kaltstart/Zurueck, sonst als neuer Eintrag', () => {
  const body = navigateBody();
  const helper = body.indexOf('const commitDetourAddress = ');
  assert.ok(helper > 0, 'commitDetourAddress nicht gefunden');
  const helperBody = body.slice(helper, body.indexOf('};', helper));
  assert.match(helperBody, /!push && detourAddress/, 'ersetzt wird nur, wenn die tote Adresse der laufende Eintrag ist');
  assert.match(helperBody, /history\.replaceState\(\{ path \}, '', detourAddress\)/);
  // Der regulaere Eintrag traegt die berichtigte Adresse samt Hash.
  assert.equal(count(body, "'', detourAddress ?? path)"), 2, 'pushState und Overlay-replaceState nehmen die berichtigte Adresse');
});

test('unknownDetourFor() liest allRoutes() und hat genau einen Aufrufer je Entscheidung', () => {
  const start = routerSrc.indexOf('function unknownDetourFor(');
  assert.ok(start > 0, 'unknownDetourFor nicht gefunden');
  const fn = routerSrc.slice(start, routerSrc.indexOf('\n}\n', start));
  assert.match(fn, /allRoutes\(\)/, 'bekannt ist, was allRoutes() kennt - samt Erweiterungsrouten');
  assert.equal(count(routerSrc, 'unknownPathDetour('), 1, 'genau ein Aufrufer');
  assert.equal(count(routerSrc, 'publicPathDetour('), 1, 'genau ein Aufrufer');
});

// ─── navigate() als Programm (#1640) ────────────────────────────────────────
// Das echte navigate() mit den Stellvertretern aus router-navigate-harness.js.
// Gemessen wird, was aussen ankommt: welche Seite gezeichnet wird, was in der
// History steht, ob der Hinweis eine Flaeche fand.

const MEMBER = { id: 1, access_scope: 'full' };
const GUEST = { id: 2, access_scope: 'split_guest' };
const settle = () => new Promise((resolve) => { setTimeout(resolve, 10); });

test('die Routen des Helfers tragen dieselbe Anmeldepflicht wie die Tabelle des Routers', () => {
  const tableStart = routerSrc.indexOf('const ROUTES = [');
  const tableEnd = routerSrc.indexOf('ROUTES.push(...SETTINGS_ROUTES);');
  assert.ok(tableStart > 0 && tableEnd > tableStart, 'Routentabelle nicht gefunden');
  const real = new Map(
    [...routerSrc.slice(tableStart, tableEnd).matchAll(/\{ path: '([^']+)',[^}]*?requiresAuth: (true|false)/g)]
      .map((m) => [m[1], m[2] === 'true']),
  );
  for (const path of ['/login', '/setup', '/join', '/pair', '/', '/tasks', '/budget']) {
    const fixture = HARNESS_ROUTES.find((route) => route.path === path);
    assert.equal(real.get(path), fixture.requiresAuth, path);
  }
});

test('ohne Sitzung: /pair/extra endet auf /pair, nicht auf der Anmeldung (#1640)', async () => {
  for (const [dead, landing] of [['/pair/extra', '/pair'], ['/join/extra', '/join'], ['/pair/a/b', '/pair']]) {
    const { navigate, log, env } = createNavigateHarness();
    await navigate(dead, false);
    await settle();
    assert.deepEqual(log.rendered, [landing], dead);
    // Kaltstart: die tote Adresse ist der laufende Eintrag und wird ersetzt.
    assert.deepEqual(log.history, [['replace', landing]], dead);
    assert.equal(log.authCalls, 0, 'eine oeffentliche Seite fragt nicht nach der Sitzung');
    assert.equal(env.isNavigating, false);
  }
});

test('ohne Sitzung: ein unbekannter Pfad unter einer geschuetzten Seite endet weiter auf der Anmeldung', async () => {
  for (const dead of ['/settings/xyz', '/xyz', '/login/extra', '/m/garden/beds']) {
    const { navigate, log } = createNavigateHarness();
    await navigate(dead, false);
    await settle();
    assert.deepEqual(log.rendered, ['/login'], dead);
    assert.equal(log.toasts.length, 0, dead);
  }
});

test('Kaltstart mit Sitzung: der Umweg faellt erst hinter dem Auth-Guard', async () => {
  const { navigate, log } = createNavigateHarness({ sessionUser: MEMBER });
  await navigate('/settings/xyz', false);
  assert.deepEqual(log.rendered, ['/settings']);
  assert.deepEqual(log.history, [['replace', '/settings']]);
  assert.deepEqual(log.toasts, [{ message: 'common.unknownAddress', shown: true }]);
  // Auch hier fuehrt der oeffentliche Vorfahr direkt ans Ziel.
  const open = createNavigateHarness({ sessionUser: MEMBER });
  await open.navigate('/pair/extra', false);
  assert.deepEqual(open.log.rendered, ['/pair']);
});

test('laufende Sitzung: oeffentliche Seiten bleiben Landeplatz, Anmeldung und gesperrte Module nicht', async () => {
  const open = createNavigateHarness({ user: MEMBER });
  await open.navigate('/pair/extra');
  assert.deepEqual(open.log.rendered, ['/pair']);
  assert.deepEqual(open.log.history, [['push', '/pair']]);

  const login = createNavigateHarness({ user: MEMBER });
  await login.navigate('/login/extra');
  assert.deepEqual(login.log.rendered, ['/']);

  const locked = createNavigateHarness({ user: MEMBER, canAccess: (module) => module !== 'budget' });
  await locked.navigate('/budget/xyz');
  assert.deepEqual(locked.log.rendered, ['/']);

  const disabled = createNavigateHarness({ user: MEMBER, disabledModules: ['tasks'] });
  await disabled.navigate('/tasks/42');
  assert.deepEqual(disabled.log.rendered, ['/']);
});

test('laufende Sitzung: eine Sperre bis zum Ende, der Verlassen-Schutz fragt einmal nach dem Ziel', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { navigate, log, env, setShell } = createNavigateHarness({
    user: MEMBER,
    leaveGuard: async () => true,
    onRender: () => held,
  });
  setShell(true);
  const running = navigate('/settings/xyz');
  await settle();
  assert.equal(env.isNavigating, true, 'die Sperre haelt, solange das Ziel laedt');
  release();
  await running;
  assert.deepEqual(log.rendered, ['/settings']);
  assert.deepEqual(log.leaveAsked, ['/settings']);
  assert.deepEqual(log.history, [['push', '/settings']]);
  assert.deepEqual(log.toasts, [{ message: 'common.unknownAddress', shown: true }]);
});

/*
 * DER LETZTE TIPP GEWINNT (Critique R19, Nachlese 1b). Bis hierher verwarf
 * navigate() einen zweiten Klick, solange die erste Navigation lud - dieser
 * Test hielt das als "ein zweiter Klick startet keine zweite Navigation" fest.
 * Im Browser hiess das: wer waehrend des Ladens ein anderes Ziel antippte,
 * blieb auf dem ersten (1 von 24 schnellen Doppeltipps). Jetzt wartet der
 * neue Wunsch, das ueberholte Ziel rendert nach seinem Laden nichts mehr, und
 * sein History-Eintrag gehoert dem neuen Ziel. Weiter EINE Sperre zur Zeit:
 * gerendert wird nie zweimal nebeneinander.
 */
test('laufende Sitzung: der letzte Tipp gewinnt - das ueberholte Ziel rendert nicht', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { navigate, log, env, setShell } = createNavigateHarness({
    user: MEMBER,
    leaveGuard: async () => true,
    onRender: (route) => (route.path === '/settings' ? held : undefined),
  });
  setShell(true);
  const first = navigate('/settings/xyz');
  await settle();
  assert.equal(env.isNavigating, true);
  const second = navigate('/budget');
  const third = navigate('/tasks');
  await settle();
  assert.deepEqual(log.rendered, [], 'waehrend das erste Ziel laedt, rendert nichts daneben');
  release();
  await first;
  await third;
  await second; // ersetzt vom dritten - es loest auf, ohne zu navigieren
  await settle();
  assert.deepEqual(log.rendered, ['/tasks'], 'gerendert wird nur das Ziel des letzten Tipps');
  assert.deepEqual(log.leaveAsked, ['/settings', '/tasks'], 'das ersetzte /budget fragt nie');
  assert.deepEqual(log.history, [['push', '/settings'], ['replace', '/tasks']],
    'Zurueck fuehrt nicht auf eine Seite, die nie zu sehen war');
  assert.deepEqual(log.toasts, [], 'das ueberholte Ziel meldet seine Adresse nicht');
  assert.equal(env.currentPath, '/tasks');
  assert.equal(env.isNavigating, false);
});

/*
 * Review #2049: ueberholt wird auch NACH dem Tausch. Hat swap() das render()
 * des ersten Ziels schon gestartet, wartete renderPage() trotzdem darauf - und
 * Seiten wie der Kalender rufen ihr erstes api.get() ohne Signal. Ein
 * haengender Abruf hielt den neueren Tipp unbegrenzt auf. Jetzt endet das
 * Warten mit dem Abbruch.
 */
const within = (promise, ms, label) => Promise.race([
  promise.then(() => 'fertig'),
  new Promise((resolve) => { setTimeout(() => resolve(`${label}: haengt`), ms); }),
]);

test('laufende Sitzung: ein render(), das nie fertig wird, haelt den neueren Tipp nicht auf', async () => {
  const never = new Promise(() => {});
  const { navigate, log, env, setShell } = createNavigateHarness({
    user: MEMBER,
    onPageRender: (route) => (route.path === '/budget' ? never : undefined),
  });
  setShell(true);
  const first = navigate('/budget');
  await settle();
  assert.deepEqual(log.swapped, ['/budget'], 'die erste Seite ist getauscht, ihr render() laeuft');
  assert.equal(env.isNavigating, true);
  const second = navigate('/tasks');
  assert.equal(await within(second, 500, 'zweiter Tipp'), 'fertig', 'der zweite Tipp kommt an');
  assert.equal(await within(first, 50, 'erste Navigation'), 'fertig');
  assert.deepEqual(log.swapped, ['/budget', '/tasks']);
  assert.deepEqual(log.rendered, ['/tasks'], 'das ueberholte Ziel gilt nicht als fertig gerendert');
  assert.equal(env.currentPath, '/tasks');
  assert.equal(env.isNavigating, false);
  // Die erste Seite stand schon - ihr Eintrag bleibt, der zweite kommt dazu.
  assert.deepEqual(log.history, [['push', '/budget'], ['push', '/tasks']]);
});

/*
 * Review #2049, Runde 2: dasselbe fuer die WEICHE Navigation. Ein Reiter im
 * Schichtplan oder ein Einstellungsblatt laeuft ueber `update()` des schon
 * gezeichneten Moduls statt ueber renderPage() - und dort wartete der Router
 * blank. Schedules update() wartet auf activateView() und das auf einen
 * Abruf ohne Signal: ein haengender hielt den naechsten Tipp unbegrenzt auf.
 */
test('laufende Sitzung: ein weiches update(), das nie fertig wird, haelt den neueren Tipp nicht auf', async () => {
  const never = new Promise(() => {});
  const calls = [];
  const { navigate, log, env, setShell } = createNavigateHarness({ user: MEMBER });
  setShell(true);
  env.currentPath = '/settings';
  env._renderedModuleName = 'settings';
  env._renderedModule = {
    update: (args) => { calls.push(args); return never; },
  };
  const first = navigate('/settings/appearance');
  await settle();
  assert.equal(calls.length, 1, 'die weiche Navigation ruft update()');
  assert.equal(env.isNavigating, true);
  const second = navigate('/tasks');
  assert.equal(await within(second, 500, 'zweiter Tipp'), 'fertig', 'der zweite Tipp kommt an');
  assert.equal(await within(first, 50, 'erste Navigation'), 'fertig');
  assert.ok(calls[0].signal instanceof AbortSignal, 'update() bekommt das Signal der Navigation');
  assert.equal(calls[0].signal.aborted, true, 'das ueberholte update() erfaehrt den Abbruch');
  assert.deepEqual(log.rendered, ['/tasks']);
  assert.equal(env.currentPath, '/tasks');
  assert.equal(env.isNavigating, false);
});

test('laufende Sitzung: ein ueberholtes update() faellt danach nicht aufs volle Rendern zurueck', async () => {
  let finish;
  const late = new Promise((resolve) => { finish = resolve; });
  const { navigate, log, env, setShell } = createNavigateHarness({ user: MEMBER });
  setShell(true);
  env.currentPath = '/settings';
  env._renderedModuleName = 'settings';
  env._renderedModule = { update: () => late };
  const first = navigate('/settings/appearance');
  await settle();
  assert.equal(await within(navigate('/tasks'), 500, 'zweiter Tipp'), 'fertig');
  assert.equal(await within(first, 50, 'erste Navigation'), 'fertig');
  // Kommt die Antwort spaet mit false (volles Rendern noetig), zeichnet die
  // ueberholte Navigation trotzdem nichts mehr ueber die neue Seite.
  finish(false);
  await settle();
  assert.deepEqual(log.rendered, ['/tasks'], 'ein spaetes false rendert die alte Route nicht nach');
  assert.equal(env.currentPath, '/tasks');
});

test('unlessAborted: endet mit dem Abbruch, gibt sonst Wert und Fehler weiter', async () => {
  const { unlessAborted } = await import('../public/utils/router-navigate.js');
  assert.equal(await unlessAborted(Promise.resolve(1), null), true, 'ohne Signal: wie await');
  assert.equal(await unlessAborted(Promise.resolve(1), new AbortController().signal), true);
  await assert.rejects(unlessAborted(Promise.reject(new Error('kaputt')), new AbortController().signal), /kaputt/,
    'ein Fehler vor dem Abbruch bleibt ein Fehler (renderPage zeigt ihn)');
  const run = new AbortController();
  const waiting = unlessAborted(new Promise(() => {}), run.signal);
  run.abort();
  assert.equal(await within(waiting, 200, 'Abbruch'), 'fertig');
  assert.equal(await waiting, false, 'abgebrochen heisst false');
  // Ein Fehler NACH dem Abbruch (die Seite bricht ihr Laden ab) wird verschluckt.
  const late = new AbortController();
  let fail;
  const failing = unlessAborted(new Promise((_r, reject) => { fail = reject; }), late.signal);
  late.abort();
  fail(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  assert.equal(await failing, false);
  const done = new AbortController();
  done.abort();
  assert.equal(await unlessAborted(new Promise(() => {}), done.signal), false, 'schon abgebrochen');
});

test('ein Sitzungsende geht dem wartenden Tipp vor', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { navigate, log, env } = createNavigateHarness({ user: MEMBER, onRender: (route) => (route.path === '/budget' ? held : undefined) });
  const first = navigate('/budget');
  await settle();
  navigate('/tasks');
  env._pendingLoginRedirect = true;
  env.currentUser = null;
  release();
  await first;
  await settle();
  assert.ok(!log.rendered.includes('/tasks'), 'nach dem Sitzungsende rendert der wartende Tipp nicht');
  assert.equal(log.rendered.at(-1), '/login');
});

test('laufende Sitzung: bricht der Verlassen-Schutz ab, bleibt alles, wie es war', async () => {
  const { navigate, log, env } = createNavigateHarness({ user: MEMBER, leaveGuard: async () => false });
  await navigate('/settings/xyz');
  assert.deepEqual(log.rendered, []);
  assert.deepEqual(log.history, []);
  assert.deepEqual(log.toasts, []);
  assert.equal(env.isNavigating, false);
});

test('Kaltstart als Gast: der Hinweis erscheint erst, wenn die Flaeche steht (#1640)', async () => {
  // `/settings/xyz` fuehrt auf `/settings`, die Gast-Weiche weiter auf `/budget`.
  // Lief die Weiche ueber ein zweites navigate(), kam der Hinweis vor dessen
  // Rendern - ohne Shell gibt es keine Toast-Flaeche, und er ging verloren.
  const { navigate, log } = createNavigateHarness({ sessionUser: GUEST });
  await navigate('/settings/xyz', false);
  await settle();
  assert.deepEqual(log.rendered, ['/budget']);
  assert.deepEqual(log.toasts, [{ message: 'common.unknownAddress', shown: true }]);
  assert.deepEqual(log.history.at(-1), ['replace', '/budget']);
});

test('Kaltstart: der Direktlink auf ein abgeschaltetes Modul endet auf der Uebersicht', async () => {
  // Der Modul-Guard vor dem Auth-Guard laeuft beim Kaltstart, bevor die
  // Praeferenzen geladen sind: die Menge der abgeschalteten Module ist da noch
  // leer. Der Guard dahinter pruefte nur das Recht - das Modul wurde gezeichnet,
  // fuer Mitglieder wie fuer Gaeste.
  for (const [who, sessionUser] of [['Mitglied', MEMBER], ['Gast', GUEST]]) {
    for (const [path, module] of [['/budget', 'budget'], ['/tasks', 'tasks']]) {
      // Der Gast wird von '/tasks' ohnehin auf sein Budget geschickt.
      if (who === 'Gast' && path === '/tasks') continue;
      const { navigate, log, env } = createNavigateHarness({ sessionUser, disabledModules: [module] });
      await navigate(path, false);
      await settle();
      assert.deepEqual(log.rendered, ['/'], `${who} ${path}`);
      // Dieselbe Navigation, eine Sperre; die Adresse des abgeschalteten Moduls
      // bleibt nicht als Eintrag stehen, in den Zurueck wieder hineinfuehrte.
      assert.deepEqual(log.history, [['replace', '/']], `${who} ${path}`);
      assert.equal(env.isNavigating, false, `${who} ${path}`);
    }
  }
  // Ein unbekannter Pfad unter dem abgeschalteten Modul: Uebersicht, mit Hinweis.
  const below = createNavigateHarness({ sessionUser: MEMBER, disabledModules: ['tasks'] });
  await below.navigate('/tasks/42', false);
  await settle();
  assert.deepEqual(below.log.rendered, ['/']);
  assert.deepEqual(below.log.toasts, [{ message: 'common.unknownAddress', shown: true }]);
});

test('Kaltstart: der Direktlink auf ein gesperrtes Modul endet weiter auf der Uebersicht', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { navigate, log, env } = createNavigateHarness({
    sessionUser: MEMBER,
    canAccess: (module) => module !== 'budget',
    onRender: () => held,
  });
  const running = navigate('/budget', false);
  await settle();
  assert.equal(env.isNavigating, true, 'die Sperre ist frei, waehrend die Uebersicht noch laedt');
  release();
  await running;
  await settle();
  assert.deepEqual(log.rendered, ['/']);
  assert.deepEqual(log.history, [['replace', '/']]);
});

test('ein eingeschaltetes Modul bleibt beim Kaltstart erreichbar', async () => {
  const { navigate, log } = createNavigateHarness({ sessionUser: MEMBER, disabledModules: ['tasks'] });
  await navigate('/budget', false);
  await settle();
  assert.deepEqual(log.rendered, ['/budget']);
  assert.deepEqual(log.history, []);
});

// ─── Kein Weg der App fuehrt selbst auf eine unbekannte Adresse ─────────────
// Seit der Umleitung faellt ein totes Ziel auf: vorher landete es still auf der
// Uebersicht. `/health/medications` (Zyklus-Tagesprotokoll, "Schmerzmittel")
// war so eines - die Route heisst `/health/meds`.

test('jedes woertliche navigate()-Ziel in public/ ist eine Route', async () => {
  const { readdirSync, statSync } = await import('node:fs');
  const { HEALTH_ROUTES } = await import('../public/utils/health-tabs.js');
  const { SCHEDULE_ROUTES } = await import('../public/utils/schedule-tabs.js');

  const tableStart = routerSrc.indexOf('const ROUTES = [');
  const tableEnd = routerSrc.indexOf('ROUTES.push(...SETTINGS_ROUTES);');
  assert.ok(tableStart > 0 && tableEnd > tableStart, 'Routentabelle nicht gefunden');
  const routes = new Set([
    ...[...routerSrc.slice(tableStart, tableEnd).matchAll(/\{ path: '([^']+)'/g)].map((m) => m[1]),
    ...HEALTH_ROUTES,
    ...SCHEDULE_ROUTES,
  ]);
  assert.ok(routes.has('/') && routes.has('/settings') && routes.has('/health/meds'), 'Routentabelle unvollstaendig gelesen');

  const root = new URL('../public/', import.meta.url);
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (name === 'vendor' || name === 'locales') continue;
      const url = new URL(name, dir);
      if (statSync(url).isDirectory()) walk(new URL(`${name}/`, dir));
      else if (name.endsWith('.js') && !name.endsWith('.min.js')) files.push(url);
    }
  }(root));

  const targets = [];
  for (const url of files) {
    const src = readFileSync(url, 'utf8');
    for (const m of src.matchAll(/navigate\(\s*['"`](\/[^'"`?#$]*)/g)) {
      targets.push({ file: url.pathname.split('/public/')[1], path: m[1] });
    }
  }
  assert.ok(targets.length > 30, `zu wenige Ziele gelesen (${targets.length}) - das Muster greift nicht mehr`);
  const dead = targets.filter(({ path }) => !routes.has(path) && !path.startsWith('/settings/'));
  assert.deepEqual(dead, [], 'navigate() auf eine Adresse, die es nicht gibt');
});

// Die Gegenseite im Router (router.js laesst sich nicht importieren): ein
// ueberholtes Seitenmodul rendert nach seinem Laden nichts, sein Blatt geht
// wieder, und eine schon getauschte Seite verliert ihr Signal.
test('renderPage: ein ueberholtes Ziel rendert nach dem Laden nichts, sein Blatt geht wieder', () => {
  const router = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  const render = router.slice(router.indexOf('async function renderPage('));
  assert.match(render, /^async function renderPage\(route, previousPath = null, scrollTarget = 0, \{ signal = null \} = \{\}\)/);
  // Seit Review #2049 endet schon das Warten auf Modul und Blatt mit dem
  // Abbruch (unlessAborted), nicht erst die Frage danach.
  assert.match(render, /style\.ready,\s*\]\);[\s\S]{0,600}?const loaded = await unlessAborted\(loading, signal\);\s*if \(!loaded \|\| signal\?\.aborted\) \{\s*style\.abandon\(\);\s*return false;\s*\}/,
    'nach importPage/style.ready fragt renderPage nicht, ob es ueberholt ist - oder wartet blank darauf');
  assert.match(render, /signal\?\.addEventListener\('abort', \(\) => _pageController\?\.abort\(\), \{ once: true \}\);\s*const \{ transition, finished \} = await swapPage/);
  // Review #2049: auch auf den Rest von render() wartet renderPage nur, bis es
  // ueberholt ist - ein blankes `await renderPromise` hielt den neueren Tipp auf.
  assert.doesNotMatch(render.slice(0, render.indexOf('\n}\n')), /await renderPromise/,
    'renderPage wartet blank auf render() - ein haengender Abruf blockiert den naechsten Tipp');
  assert.match(render, /if \(!\(await unlessAborted\(renderPromise, signal\)\)\) return true;/,
    'ueberholt nach dem Tausch: renderPage kehrt zurueck, ohne die Seite fertigzustellen');
  const style = router.slice(router.indexOf('function loadPageStyle('), router.indexOf('function loadPageStyle(') + 1600);
  assert.equal((style.match(/abandon:/g) ?? []).length, 3, 'jede Antwort von loadPageStyle() kann ihr Blatt zuruecknehmen');
  assert.match(style, /abandon: \(\) => \{\s*link\.remove\(\);\s*if \(activePageStyle === link\) activePageStyle = oldLink;/);
});
