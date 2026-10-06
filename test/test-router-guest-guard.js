/**
 * Regression: Split-Guest-Redirect-Schleife (#480)
 *
 * Ein Nutzer mit access_scope 'split_guest' UND einer Familienrolle ohne
 * Budget-Recht geriet in eine Endlosschleife:
 *   '/'      → split_guest-Weiche schickt auf '/budget'
 *   '/budget'→ Modul-Guard (kein Budget-Recht) schickt zurück auf '/'
 * … bis „Maximum call stack size exceeded".
 *
 * Fix: Die split_guest→/budget-Weiche greift nur noch, wenn Budget auch
 * tatsächlich zugänglich ist (canAccessNavModule('budget')). Ohne Budget-Recht
 * fällt der Nutzer durch und landet auf einer erlaubten Seite.
 *
 * Seit #1640 laeuft die Weiche als Programm: test/router-navigate-harness.js
 * fuehrt das echte navigate() aus (seit #1657 als importiertes Modul). Die
 * Weiche startet dabei kein zweites navigate() mehr - die laufende Navigation
 * wechselt selbst auf
 * '/budget', haelt ihre Sperre bis zum Ende und ersetzt beim Kaltstart den
 * Eintrag der Adresse, von der sie wegfuehrt. Das Rechte-Verhalten darunter
 * prueft weiter der echte public/permissions.js-Store.
 *
 * Ausführen: node --test test/test-router-guest-guard.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setPermissions,
  clearPermissions,
  canAccessNavModule,
} from '../public/permissions.js';
import { createNavigateHarness } from './router-navigate-harness.js';

const GUEST = { id: 2, access_scope: 'split_guest' };
const settle = () => new Promise((resolve) => { setTimeout(resolve, 10); });

test('Gast mit Budget-Recht landet von jeder Adresse auf /budget', async () => {
  for (const path of ['/', '/tasks', '/settings']) {
    const cold = createNavigateHarness({ sessionUser: GUEST });
    await cold.navigate(path, false);
    await settle();
    assert.deepEqual(cold.log.rendered, ['/budget'], `Kaltstart ${path}`);

    const running = createNavigateHarness({ user: GUEST });
    await running.navigate(path);
    await settle();
    assert.deepEqual(running.log.rendered, ['/budget'], `laufende Sitzung ${path}`);
  }
});

test('Gast OHNE Budget-Recht: keine Schleife, er landet auf einer erlaubten Seite (#480)', async () => {
  const noBudget = (module) => module !== 'budget';
  const cold = createNavigateHarness({ sessionUser: GUEST, canAccess: noBudget });
  await cold.navigate('/', false);
  await settle();
  assert.deepEqual(cold.log.rendered, ['/']);

  // Der Deep-Link auf das gesperrte Budget fuehrt der Rechte-Guard zur Uebersicht.
  const deep = createNavigateHarness({ sessionUser: GUEST, canAccess: noBudget });
  await deep.navigate('/budget', false);
  await settle();
  assert.deepEqual(deep.log.rendered, ['/']);
});

test('Budget im Haushalt abgeschaltet: die Weiche schickt den Gast nicht dorthin (#1640)', async () => {
  // Die Weiche pruefte das Recht, aber nicht die Abschaltung. In einer laufenden
  // Sitzung warfen sich Weiche ('/budget') und Modul-Guard ('/') den Gast zu,
  // bis der Stack ueberlief; beim Kaltstart stand die Weiche HINTER dem einzigen
  // Guard, der die Abschaltung kennt, und zeichnete das abgeschaltete Modul.
  // Die Weiche bleibt jetzt aus, wie beim Gast ohne Budget-Recht: von der
  // Uebersicht geht es nirgends hin, und sie ist das Ziel, das der Modul-Guard
  // fuer "nicht erreichbar" ohnehin kennt und selbst nie abweist.
  for (const path of ['/', '/tasks', '/settings/xyz']) {
    const cold = createNavigateHarness({ sessionUser: GUEST, disabledModules: ['budget'] });
    await cold.navigate(path, false);
    await settle();
    assert.notEqual(cold.log.rendered.at(-1), '/budget', `Kaltstart ${path}: das abgeschaltete Budget wurde gezeichnet`);
    assert.equal(cold.env.isNavigating, false, `Kaltstart ${path}`);
  }
  const coldRoot = createNavigateHarness({ sessionUser: GUEST, disabledModules: ['budget'] });
  await coldRoot.navigate('/', false);
  await settle();
  assert.deepEqual(coldRoot.log.rendered, ['/']);

  for (const path of ['/', '/tasks', '/budget']) {
    const running = createNavigateHarness({ user: GUEST, disabledModules: ['budget'] });
    await assert.doesNotReject(async () => running.navigate(path), `laufende Sitzung ${path}: navigate() laeuft in sich selbst`);
    await settle();
    assert.equal(running.log.rendered.includes('/budget'), false, `laufende Sitzung ${path}`);
    assert.equal(running.env.isNavigating, false, `laufende Sitzung ${path}`);
    // Nichts Neues: derselbe Ort wie fuer den Gast ohne Budget-Recht (#480).
    // Die Uebersicht und das abgeschaltete Budget enden auf '/', jede andere
    // Adresse bleibt den regulaeren Guards (und dem Server).
    const noRight = createNavigateHarness({ user: GUEST, canAccess: (module) => module !== 'budget' });
    await noRight.navigate(path);
    await settle();
    assert.deepEqual(running.log.rendered, noRight.log.rendered, `laufende Sitzung ${path}`);
    if (path !== '/tasks') assert.deepEqual(running.log.rendered, ['/'], `laufende Sitzung ${path}`);
  }
});

test('die Gast-Weiche haelt die Sperre, bis /budget gezeichnet ist (#1640)', async () => {
  // Ein zweites navigate('/budget') aus der laufenden Navigation heraus gab die
  // Sperre im finally der aeusseren frei, waehrend die innere noch lud: ein
  // Klick in dieser Zeit startete eine zweite Navigation daneben.
  for (const [label, options, args] of [
    ['Kaltstart', { sessionUser: GUEST }, ['/', false]],
    ['laufende Sitzung', { user: GUEST }, ['/tasks']],
  ]) {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const { navigate, log, env } = createNavigateHarness({ ...options, onRender: () => held });
    const running = navigate(...args);
    await settle();
    assert.deepEqual(log.rendered, [], label);
    assert.equal(env.isNavigating, true, `${label}: die Sperre ist frei, waehrend /budget noch laedt`);
    release();
    await running;
    await settle();
    assert.deepEqual(log.rendered, ['/budget'], label);
    assert.equal(env.isNavigating, false, label);
  }
});

test('die Gast-Weiche hinterlaesst keinen Eintrag, von dem sie gleich wieder wegfuehrt (#1640)', async () => {
  // Kaltstart und Zurueck/Vor: die Adresse IST der laufende Eintrag. Blieb er
  // stehen und '/budget' kam obendrauf, fuehrte Zurueck in die Weiche zurueck.
  const cold = createNavigateHarness({ sessionUser: GUEST });
  await cold.navigate('/', false);
  await settle();
  assert.deepEqual(cold.log.history, [['replace', '/budget']]);

  // Wechsel in der App: ein Eintrag, und zwar der des Ziels.
  const running = createNavigateHarness({ user: GUEST });
  await running.navigate('/tasks');
  await settle();
  assert.deepEqual(running.log.history, [['push', '/budget']]);
});

test('Budget-gesperrter Gast: Weiche feuert nicht (canAccessNavModule false)', () => {
  // Familienrolle setzt Budget auf 'none' → Gast darf NICHT nach /budget.
  setPermissions({ admin: false, modules: { budget: 'none' }, widgets: {} });
  assert.equal(canAccessNavModule('budget'), false);
  clearPermissions();
});

test('regulärer Gast ohne Einschränkung: Weiche feuert weiterhin', () => {
  // Reiner split_guest ohne Rechte-Overrides → Vollzugriff (fail-open).
  setPermissions({ admin: false, modules: {}, widgets: {} });
  assert.equal(canAccessNavModule('budget'), true);
  clearPermissions();
});
