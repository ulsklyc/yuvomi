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
 * hier als Programm; dass `navigate()` sie an der richtigen Stelle ruft, haelt
 * der Verdrahtungsteil am Quelltext.
 *
 * Ausfuehren: node --test test/test-unknown-route.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const load = () => import('../public/utils/unknown-route.js');
const routerSrc = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');

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
    '/api/v1/tasks', '/api', '/docs', '/docs/', '/feed/calendar/abc.ics', '/mcp', '/mcp/sse',
    '/openapi.json', '/sw.js', '/index.html', '/manifest.webmanifest', '/styles/tokens.css',
    '/locales/de.json', '/icons/icon-192.png', '/settings/registry.js',
  ]) {
    assert.equal(unknownPathDetour(path, { known: KNOWN }), null, path);
  }
  // Nur das ERSTE Segment entscheidet: `/apiary` ist kein Serverpfad.
  assert.deepEqual(unknownPathDetour('/apiary', { known: KNOWN }), { target: '/', notify: true });
  assert.deepEqual(unknownPathDetour('/tasks/api', { known: KNOWN }), { target: '/tasks', notify: true });
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

// ─── Die Wirkung ────────────────────────────────────────────────────────────

function fakeHistory(entries) {
  const stack = [...entries];
  const calls = [];
  return {
    stack,
    calls,
    replaceState(state, _title, url) { calls.push(['replace', url, state]); stack[stack.length - 1] = url; },
    pushState(state, _title, url) { calls.push(['push', url, state]); stack.push(url); },
  };
}

test('Kaltstart auf toter Adresse: Eintrag ersetzt, nicht ergaenzt; Hinweis genau einmal, nach der Seite', async () => {
  const { unknownPathDetour, followUnknownPathDetour } = await load();
  const history = fakeHistory(['/tasks', '/settings/xyz']);
  const order = [];
  const detour = unknownPathDetour('/settings/xyz', { known: KNOWN });
  await followUnknownPathDetour(detour, {
    pushState: false,
    history,
    navigate: async (path, push) => { order.push(['navigate', path, push]); },
    notify: () => order.push(['notify']),
  });
  assert.deepEqual(history.calls, [['replace', '/settings', { path: '/settings' }]]);
  assert.deepEqual(history.stack, ['/tasks', '/settings'], 'Zurueck fuehrt nicht wieder auf die tote Adresse');
  assert.deepEqual(order, [['navigate', '/settings', false], ['notify']]);
});

test('Wechsel innerhalb der App auf eine tote Adresse: sie kommt nie in die History', async () => {
  const { unknownPathDetour, followUnknownPathDetour } = await load();
  const history = fakeHistory(['/tasks']);
  const order = [];
  await followUnknownPathDetour(unknownPathDetour('/xyz', { known: KNOWN }), {
    pushState: true,
    history,
    navigate: async (path, push) => { order.push(['navigate', path, push]); },
    notify: () => order.push(['notify']),
  });
  // Der laufende Eintrag gehoert der Seite davor - er wird nicht ueberschrieben.
  assert.deepEqual(history.calls, []);
  assert.deepEqual(order, [['navigate', '/', true], ['notify']]);
});

test('nur ein Schraegstrich zu viel: Adresse berichtigt, kein Hinweis', async () => {
  const { unknownPathDetour, followUnknownPathDetour } = await load();
  const history = fakeHistory(['/settings/']);
  let notified = 0;
  await followUnknownPathDetour(unknownPathDetour('/settings/', { known: KNOWN }), {
    pushState: false,
    history,
    navigate: async () => {},
    notify: () => { notified += 1; },
  });
  assert.deepEqual(history.stack, ['/settings']);
  assert.equal(notified, 0);
});

test('keine Schleife: das Ziel ist selbst nie unbekannt, und der Start auf / bleibt still', async () => {
  const { unknownPathDetour, followUnknownPathDetour } = await load();
  // Ein Router im Kleinen, so verdrahtet wie navigate().
  async function run(start) {
    const history = fakeHistory([start]);
    const rendered = [];
    let notified = 0;
    let hops = 0;
    async function navigate(path, pushState) {
      hops += 1;
      assert.ok(hops < 5, 'Umleitungsschleife');
      const detour = unknownPathDetour(path, { known: KNOWN });
      if (detour) {
        await followUnknownPathDetour(detour, { pushState, history, navigate, notify: () => { notified += 1; } });
        return;
      }
      rendered.push(path);
    }
    await navigate(start, false);
    return { history, rendered, notified, hops };
  }

  for (const [start, target] of [['/settings/xyz', '/settings'], ['/xyz', '/'], ['/a/b/c/d', '/']]) {
    const res = await run(start);
    assert.deepEqual(res.rendered, [target], start);
    assert.equal(res.notified, 1, `${start}: Hinweis genau einmal`);
    assert.equal(res.hops, 2, `${start}: ein Umweg, kein zweiter`);
    assert.deepEqual(res.history.stack, [target], start);
  }

  const home = await run('/');
  assert.deepEqual(home.rendered, ['/']);
  assert.equal(home.notified, 0, 'kein Hinweis beim Start auf /');
  assert.deepEqual(home.history.calls, []);

  const known = await run('/m/garden');
  assert.deepEqual(known.rendered, ['/m/garden']);
  assert.equal(known.notified, 0);
});

// ─── Die Verdrahtung in navigate() ──────────────────────────────────────────

function navigateBody() {
  const start = routerSrc.indexOf('async function navigate(');
  const end = routerSrc.indexOf('async function syncPreferencesOnce(');
  assert.ok(start > 0 && end > start, 'navigate() nicht gefunden');
  return routerSrc.slice(start, end);
}

test('navigate() fragt nach der unbekannten Adresse, und zwar erst nach dem zweiten Routen-Lookup', () => {
  const body = navigateBody();
  const secondLookup = body.indexOf('route = allRoutes().find((r) => r.path === basePath) ?? route;');
  const check = body.indexOf('unknownPathDetour(basePath');
  const push = body.indexOf('history.pushState({ path }');
  assert.ok(secondLookup > 0, 'zweiter Routen-Lookup nicht gefunden');
  assert.ok(check > 0, 'navigate() ruft unknownPathDetour(basePath, ...) nicht');
  // Erst nach dem Auth-Guard ist die Modulliste geladen: davor waere jede
  // Erweiterungsroute "unbekannt".
  assert.ok(check > secondLookup, 'die Pruefung steht vor dem zweiten Lookup - Modulrouten sind dort noch nicht geladen');
  assert.ok(check < push, 'die Pruefung steht hinter dem History-Eintrag der toten Adresse');
});

test('navigate() gibt den Umweg frei, folgt ihm und rendert die tote Adresse nicht', () => {
  const body = navigateBody();
  const check = body.indexOf('unknownPathDetour(basePath');
  const block = body.slice(check, check + 1200);
  assert.match(block, /isNavigating = false;/, 'ohne Freigabe bliebe navigate(target) am Riegel haengen');
  assert.match(block, /followUnknownPathDetour\(/);
  assert.match(block, /navigate,/, 'followUnknownPathDetour bekommt navigate');
  assert.match(block, /showToast\(t\('common\.unknownAddress'\)/, 'der Hinweis kommt aus dem Locale-Key');
  assert.match(block, /return;/);
  // Nur genau ein Aufrufer: ein zweiter (etwa am ersten Lookup) liefe vor dem
  // Laden der Modulliste.
  assert.equal(routerSrc.split('unknownPathDetour(').length - 1, 1);
});

test('die bekannten Pfade sind die Routen des Routers, die erreichbaren folgen dem Modul-Guard', () => {
  const body = navigateBody();
  const check = body.indexOf('unknownPathDetour(basePath');
  const block = body.slice(check - 900, check + 400);
  assert.match(block, /allRoutes\(\)/, 'bekannt ist, was allRoutes() kennt - samt Erweiterungsrouten');
  assert.match(block, /_disabledModules\.has\(/, 'ein abgeschaltetes Modul ist kein Landeplatz');
  assert.match(block, /canAccessNavModule\(/, 'ein gesperrtes Modul ist kein Landeplatz');
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
