/**
 * Tests: ein Sitzungsende auf einer Seite ohne Anmeldung zeichnet sie nicht neu (#1945)
 *
 * api.js feuert `auth:expired` vor dem Wurf eines 401. Der Listener vergass die
 * Sitzung und rief danach bedingungslos `navigate('/login')`, und navigate()
 * kennt keinen Ausstieg fuer dieselbe Adresse: es zeichnete die Anmeldeseite
 * neu - was jemand schon getippt hatte, war weg.
 * Waehrend die Einrichtung aussteht, leitete `/login` auf `/setup` und zeichnete
 * diese Seite neu. Dasselbe tat das Nachholen im finally einer laufenden
 * Navigation.
 *
 * Der Listener steht seit #1945 in public/utils/router-navigate.js, und der
 * Harness feuert das Ereignis an dessen `window`: gemessen wird der echte
 * Listener, nicht eine Nachbildung.
 *
 * Ausfuehren: node --test test/test-session-expiry.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createNavigateHarness } from './router-navigate-harness.js';

const USER = { id: 1, access_scope: 'family', role: 'admin' };
const settle = () => new Promise((resolve) => { setTimeout(resolve, 10); });

for (const path of ['/login', '/join', '/pair']) {
  test(`Sitzungsende auf ${path}: kein Neuzeichnen, kein History-Eintrag, die Sitzung ist trotzdem vergessen`, async () => {
    const { navigate, env, log, expire } = createNavigateHarness();
    await navigate(path, false);
    assert.deepEqual(log.rendered, [path]);
    const historyBefore = log.history.length;

    expire();
    await settle();

    assert.equal(log.forgotten, 1, 'auth:expired vergisst die Sitzung immer');
    assert.deepEqual(log.rendered, [path], 'die Seite wurde neu gezeichnet - das Getippte waere weg');
    assert.equal(log.history.length, historyBefore, 'ein zweiter Eintrag mit derselben Seite');
    assert.equal(env.currentPath, path);
  });
}

test('Sitzungsende auf /setup, waehrend die Einrichtung aussteht: die Seite bleibt stehen', async () => {
  const { navigate, env, log, expire } = createNavigateHarness({ setupRequired: true });
  await navigate('/setup', false);
  assert.deepEqual(log.rendered, ['/setup']);

  expire();
  await settle();

  assert.equal(log.forgotten, 1);
  assert.deepEqual(log.rendered, ['/setup'], 'die Einrichtung wurde ueber /login neu gezeichnet');
  assert.deepEqual(log.history, []);
  assert.equal(env.currentPath, '/setup');
});

test('Sitzungsende auf einer Seite mit Anmeldung fuehrt wie bisher zur Anmeldung', async () => {
  const { navigate, env, log, expire } = createNavigateHarness({ user: USER });
  await navigate('/tasks');
  expire();
  await settle();

  assert.equal(log.forgotten, 1);
  assert.equal(env.currentUser, null);
  assert.deepEqual(log.rendered, ['/tasks', '/login']);
  assert.deepEqual(log.history.at(-1), ['push', '/login']);
});

test('Sitzungsende waehrend einer Navigation: nachgeholt, sobald sie steht', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { navigate, env, log, expire } = createNavigateHarness({
    user: USER,
    onRender: (route) => (route.path === '/tasks' ? held : undefined),
  });
  const running = navigate('/tasks');
  await settle();
  expire();
  assert.equal(env._pendingLoginRedirect, true, 'waehrend der Navigation nicht sofort');
  assert.equal(log.forgotten, 1);
  release();
  await running;
  await settle();
  assert.deepEqual(log.rendered, ['/tasks', '/login']);
  assert.equal(env._pendingLoginRedirect, false);
});

test('Sitzungsende waehrend die Anmeldeseite laedt: sie wird nicht ein zweites Mal gezeichnet', async () => {
  // Das Nachholen im finally lief ueber dieselbe Abkuerzung: bedingungslos
  // navigate('/login'), auch wenn die laufende Navigation selbst dort endete.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { navigate, log, expire } = createNavigateHarness({
    onRender: (route) => (route.path === '/login' ? held : undefined),
  });
  const running = navigate('/login', false);
  await settle();
  expire();
  release();
  await running;
  await settle();
  assert.deepEqual(log.rendered, ['/login']);
  assert.deepEqual(log.history, []);
});

test('der Router reicht dem Listener seine Aufraeumfunktion, und es gibt keinen zweiten', () => {
  // Der Listener steht in router-navigate.js; router.js gibt ihm
  // forgetSessionState() mit und haengt selbst keinen eigenen mehr an - zwei
  // Listener hiessen zwei Entscheidungen.
  const router = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  const nav = readFileSync(new URL('../public/utils/router-navigate.js', import.meta.url), 'utf8');
  assert.match(router, /createNavigate\(routerState, \{[^}]*\bforgetSessionState\b[^}]*\}\)/);
  assert.equal(/addEventListener\(\s*'auth:expired'/.test(router), false, 'router.js haengt wieder einen eigenen Listener an');
  assert.equal(nav.match(/addEventListener\(\s*'auth:expired'/g)?.length, 1);
});

test('Sitzungsende, nachdem eine oeffentliche Seite nicht laden konnte: die Shell der Sitzung geht', async () => {
  // Review #2070: angemeldet auf /tasks, dann /join - dessen Modul laedt nicht.
  // currentPath steht schon auf /join, aber renderPage() hat im catch nur den
  // Fehler in den Inhalt gezeichnet: die Shell der Sitzung steht noch. Das
  // Sitzungsende darf sie nicht stehen lassen.
  const { navigate, env, log, expire } = createNavigateHarness({
    user: USER,
    failRender: (route) => route.path === '/join',
  });
  await navigate('/tasks');
  await navigate('/join');
  assert.equal(env.currentPath, '/join');
  expire();
  await settle();
  assert.deepEqual(log.rendered, ['/tasks', '/login']);
});
