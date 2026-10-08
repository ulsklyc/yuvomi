/**
 * Modul: Uebergabe des Starts (Critique R18, "fuenf serielle Startabrufe")
 * Zweck: public/utils/start-handoff.js als Programm, dazu die Verdrahtung im
 *        Router. Gemessen am gedrosselten Telefon liefen `/version`,
 *        `/auth/me`, `/preferences`, `/version`, `/modules` strikt
 *        nacheinander, bevor die Uebersicht ihre Daten anfragte. Was davon
 *        nicht voneinander abhaengt, laeuft jetzt gleichzeitig, und das zweite
 *        `/version` und das zweite `/preferences` kommen aus dem ersten.
 *        Die Zusagen, die dabei NICHT fallen duerfen, stehen hier als Faelle:
 *        der 401-Pfad feuert `auth:expired` an derselben Stelle wie bisher, und
 *        nichts ueberlebt den Start, der es geholt hat.
 * Ausfuehren: node --test test/test-start-handoff.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStartHandoff } from '../public/utils/start-handoff.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

function setup(me) {
  const seen = { calls: [], expired: 0 };
  const handoff = createStartHandoff({
    auth: {
      me: (opts) => { seen.calls.push(opts ?? null); return me(opts); },
      logout: () => 'logout',
    },
    dispatchExpired: () => { seen.expired += 1; },
  });
  return { handoff, seen };
}

const expired = () => Object.assign(new Error('Sitzung abgelaufen.'), { status: 401 });

test('the guard gets the answer the start already asked for - one request, not two', async () => {
  const { handoff, seen } = setup(async () => ({ user: { id: 7 } }));
  handoff.askSession();

  const result = await handoff.auth.me();

  assert.deepEqual(result, { user: { id: 7 } });
  assert.deepEqual(seen.calls, [{ quietExpiry: true }]);
  assert.equal(seen.expired, 0);
});

test('the early question is quiet: a 401 nobody collected fires nothing', async () => {
  const { handoff, seen } = setup(async () => { throw expired(); });
  handoff.askSession();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(seen.expired, 0, 'vor der ersten Navigation darf niemand auf die Anmeldung schicken');
});

test('a 401 fires auth:expired exactly when the guard collects it, then throws', async () => {
  const { handoff, seen } = setup(async () => { throw expired(); });
  handoff.askSession();
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(handoff.auth.me(), /Sitzung abgelaufen/);
  assert.equal(seen.expired, 1);
});

test('a network error is no session end', async () => {
  const { handoff, seen } = setup(async () => { throw new TypeError('Failed to fetch'); });
  handoff.askSession();

  await assert.rejects(handoff.auth.me(), TypeError);
  assert.equal(seen.expired, 0);
});

test('the answer is handed out once; afterwards the guard asks for itself', async () => {
  let n = 0;
  const { handoff, seen } = setup(async () => ({ user: { id: (n += 1) } }));
  handoff.askSession();

  assert.equal((await handoff.auth.me()).user.id, 1);
  assert.equal((await handoff.auth.me()).user.id, 2);
  assert.deepEqual(seen.calls, [{ quietExpiry: true }, null], 'die zweite Frage ist ein gewoehnliches auth.me()');
});

test('what the first navigation did not collect expires with it', async () => {
  let n = 0;
  const { handoff } = setup(async () => ({ user: { id: (n += 1) } }));
  handoff.askSession();
  handoff.holdVersion({ version: '1.0.0' });
  handoff.expireStart();

  assert.equal(handoff.takeVersion(), null);
  assert.equal((await handoff.auth.me()).user.id, 2, 'eine spaetere Anmeldung bekommt keine fruehere Sitzung');
});

test('without an early question the guard asks as before', async () => {
  const { handoff, seen } = setup(async () => ({ user: { id: 1 } }));
  await handoff.auth.me();
  assert.deepEqual(seen.calls, [null]);
});

test('the other auth methods pass through untouched', () => {
  const { handoff } = setup(async () => ({}));
  assert.equal(handoff.auth.logout(), 'logout');
});

test('version: only the full answer of a signed-in start is reused, and only once', () => {
  const { handoff } = setup(async () => ({}));

  handoff.holdVersion({ app_name: 'Yuvomi', setup_required: false });
  assert.equal(handoff.takeVersion(), null, 'die knappe Antwort ohne Sitzung traegt keine Version');

  const full = { version: '2.75.0', app_name: 'Yuvomi', max_upload_bytes: 1 };
  handoff.holdVersion(full);
  assert.equal(handoff.takeVersion(), full);
  assert.equal(handoff.takeVersion(), null);
});

test('preferences: the running request is handed out once and expires with the page', () => {
  const { handoff } = setup(async () => ({}));
  const pending = Promise.resolve({ data: {} });

  handoff.holdPreferences(pending);
  assert.equal(handoff.takePreferences(), pending);
  assert.equal(handoff.takePreferences(), null);

  handoff.holdPreferences(pending);
  handoff.expirePage();
  assert.equal(handoff.takePreferences(), null, 'eine spaeter besuchte Seite bekaeme sonst einen alten Stand');
});

// --------------------------------------------------------
// Verdrahtung im Router und im API-Client
// --------------------------------------------------------

test('the start asks /version and the session before waiting for anything', () => {
  const router = read('../public/router.js');
  const init = router.slice(router.indexOf('// Initialisierung\n'));
  const order = ["api.get('/version')", 'startHandoff.askSession()', 'prefetchRoute(location.pathname)', 'await initI18n()', 'await version']
    .map((needle) => init.indexOf(needle));
  assert.ok(order.every((at) => at > 0), `Start nicht gefunden: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'erst anfragen, dann warten');
  assert.match(init, /if \(!startRoute \|\| startRoute\.requiresAuth\) \{\s*startHandoff\.askSession\(\);/,
    'eine oeffentliche Seite fragt nie nach der Sitzung');
  assert.match(init, /navigate\(location\.pathname, false\)\.finally\(\(\) => startHandoff\.expireStart\(\)\)/);
});

// Zwischen `api.get('/version')` und `await version` liegt `await initI18n()`.
// Scheitert `/version` in dieser Zeit, hat das Versprechen noch keinen
// Abnehmer: der Browser meldet `unhandledrejection`, und der globale Behandler
// zeigt einen roten Toast fuer einen Abruf, den der catch darunter ausdruecklich
// als unkritisch behandelt (Codex zu #1794).
test('a failing /version has a taker before anything is awaited', async () => {
  const router = read('../public/router.js');
  const init = router.slice(router.indexOf('// Initialisierung\n'));
  const asked = init.indexOf("const version = api.get('/version')");
  const waited = init.indexOf('await initI18n()');
  const taken = init.indexOf('version.catch(');
  assert.ok(asked > 0 && waited > asked);
  assert.ok(taken > asked && taken < waited, 'der Abnehmer steht zwischen Anfrage und erstem await');

  // Dass ein spaet angehaengter Abnehmer NICHT reicht, am echten Laufzeitverhalten:
  const seen = [];
  const onUnhandled = (reason) => { seen.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const guarded = Promise.reject(new Error('offline'));
    guarded.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(guarded, /offline/, 'das spaetere await sieht den Fehler weiter');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(seen, []);
});

test('syncPreferencesOnce runs its three requests side by side and navigate waits for all of them', () => {
  const router = read('../public/router.js');
  const body = router.slice(router.indexOf('async function syncPreferencesOnce() {'), router.indexOf('function applyStartPreferences('));
  assert.match(body, /await Promise\.all\(\[preferencesApplied, versionApplied, syncThirdPartyModules\(\)\]\);/);
  assert.equal([...body.matchAll(/\bawait\b/g)].length, 1, 'kein zweites await, das die drei wieder hintereinander stellt');
  assert.match(body, /startHandoff\.takeVersion\(\) \?\? api\.get\('\/version'\)/);
  assert.match(body, /if \(sameSession\(\)\) applyStartPreferences\(res\)/,
    'eine Antwort nach dem Sitzungsende setzt nichts mehr');
  assert.match(router, /auth: startHandoff\.auth, syncPreferencesOnce,/, 'navigate() fragt ueber die Uebergabe');
  assert.match(router, /finally \{\s*\/\/[^\n]*\n\s*startHandoff\.expirePage\(\);/);
});

test('the dashboard takes the preferences of the start instead of asking again', () => {
  const dashboard = read('../public/pages/dashboard.js');
  assert.match(dashboard, /\(window\.yuvomi\?\.takeStartPreferences\?\.\(\) \?\? api\.get\('\/preferences'\)\)\.catch/);
  assert.match(read('../public/router.js'), /takeStartPreferences: \(\) => startHandoff\.takePreferences\(\),/);
});

test('the handoff module ships with the shell', () => {
  assert.match(read('../public/sw.js'), /'\/utils\/start-handoff\.js',/);
});
