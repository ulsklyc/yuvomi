/**
 * Modul: Update der laufenden App (Critique R18, "Start und Laden stolpern")
 * Zweck: Zwei Zusagen, die man der App nur im Moment eines Updates ansieht:
 *   1. DER ERSTBESUCH LAEDT NICHT NEU. `controllerchange` feuert auch, wenn der
 *      frisch installierte Service Worker eine Seite uebernimmt, die vorher
 *      keinen hatte. public/sw-register.js lud dann nach 200 ms neu - mitten
 *      ins Anmeldeformular (gemessen 1,0 bis 4,5 s nach dem Start).
 *   2. EIN UPDATE-WEG, NIE MITTEN IN DER EINGABE. public/utils/app-update.js
 *      laedt nur neu, wenn kein Dialog offen ist, kein Verlassen-Schutz greift
 *      und niemand tippt; sonst steht der Hinweis da und die Shell gilt als alt.
 * Ausfuehren: node --test test/test-app-update.js
 *
 * sw-register.js wird als PROGRAMM gefahren: es haengt beim Laden Listener an
 * `navigator.serviceWorker` und `window`. Jeder Fall stellt beide als Attrappe
 * hin und importiert die Datei frisch (eigener Query-String je Import).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createUpdateFlow, isTyping, isUserBusy } from '../public/utils/app-update.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

let importCounter = 0;

/**
 * Laedt sw-register.js gegen eine Attrappe.
 * @param {{ controller: object|null }} options - Controller beim Laden des Dokuments
 */
async function loadSwRegister({ controller }) {
  const listeners = {};
  const reloads = [];
  const serviceWorker = {
    controller,
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    register: () => Promise.resolve({ update: () => Promise.resolve() }),
    getRegistration: () => Promise.resolve(null),
  };
  const saved = {
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { serviceWorker } });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: { addEventListener: () => {}, location: { reload: () => reloads.push(Date.now()) } },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: { addEventListener: () => {}, visibilityState: 'visible' },
  });
  importCounter += 1;
  const mod = await import(`../public/sw-register.js?case=${importCounter}`);
  return {
    mod,
    reloads,
    /** Ein neuer Worker uebernimmt die Seite. */
    takeOver(next = {}) {
      serviceWorker.controller = next;
      (listeners.controllerchange || []).forEach((fn) => fn());
    },
    restore() {
      for (const [name, descriptor] of Object.entries(saved)) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

// --------------------------------------------------------
// 1. sw-register.js: Erstinstall ist kein Update
// --------------------------------------------------------

test('first install: the page that had no controller is not reloaded', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = await loadSwRegister({ controller: null });
  t.after(() => page.restore());

  page.takeOver();
  // Weit ueber jede Frist hinaus, die diese Datei kennt (200 ms, 10 s).
  t.mock.timers.tick(60000);

  assert.equal(page.reloads.length, 0, 'ein Erstinstall darf das Anmeldeformular nicht leeren');
});

test('first install announces no update to the router', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = await loadSwRegister({ controller: null });
  t.after(() => page.restore());
  let announced = 0;
  page.mod.onServiceWorkerUpdate(() => { announced += 1; });

  page.takeOver();
  t.mock.timers.tick(60000);

  assert.equal(announced, 0);
});

test('a change from an old controller to a new one is an update - and the router decides', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = await loadSwRegister({ controller: { id: 'old' } });
  t.after(() => page.restore());
  let announced = 0;
  page.mod.onServiceWorkerUpdate(() => { announced += 1; });

  page.takeOver({ id: 'new' });
  t.mock.timers.tick(60000);

  assert.equal(announced, 1);
  assert.equal(page.reloads.length, 0, 'mit einem Empfaenger laedt sw-register.js nie selbst');
});

test('the second takeover after a first install is an update', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = await loadSwRegister({ controller: null });
  t.after(() => page.restore());
  let announced = 0;
  page.mod.onServiceWorkerUpdate(() => { announced += 1; });

  page.takeOver({ id: 'first' });
  assert.equal(announced, 0);
  page.takeOver({ id: 'second' });
  assert.equal(announced, 1);
});

test('a router that subscribes late still learns about the update', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = await loadSwRegister({ controller: { id: 'old' } });
  t.after(() => page.restore());

  page.takeOver({ id: 'new' });
  let announced = 0;
  page.mod.onServiceWorkerUpdate(() => { announced += 1; });
  t.mock.timers.tick(60000);

  assert.equal(announced, 1);
  assert.equal(page.reloads.length, 0, 'der spaete Empfaenger nimmt sw-register.js den Reload ab');
});

test('an update nobody listens for reloads on its own - a broken shell must heal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = await loadSwRegister({ controller: { id: 'old' } });
  t.after(() => page.restore());

  page.takeOver({ id: 'new' });
  t.mock.timers.tick(page.mod.UPDATE_ORPHAN_RELOAD_MS - 1);
  assert.equal(page.reloads.length, 0);
  t.mock.timers.tick(1);
  assert.equal(page.reloads.length, 1);
});

// --------------------------------------------------------
// 2. app-update.js: ein Weg, nie mitten in der Eingabe
// --------------------------------------------------------

function fakeDocument() {
  const listeners = {};
  return {
    visibilityState: 'visible',
    activeElement: null,
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    hide() {
      this.visibilityState = 'hidden';
      (listeners.visibilitychange || []).forEach((fn) => fn());
    },
  };
}

function setupFlow({ busy = false, reloadAllowed = true } = {}) {
  const document = fakeDocument();
  const state = { busy, reloads: 0, notices: 0, stale: 0, timers: [] };
  const flow = createUpdateFlow({
    document,
    isBusy: () => state.busy,
    reload: () => {
      if (!reloadAllowed) return false;
      state.reloads += 1;
      return true;
    },
    onStale: () => { state.stale += 1; },
    notify: () => { state.notices += 1; },
    delayMs: 200,
    setTimeout: (fn, ms) => { state.timers.push({ fn, ms }); },
  });
  const runTimers = () => { state.timers.splice(0).forEach(({ fn }) => fn()); };
  return { flow, state, document, runTimers };
}

test('idle: the update reloads after the iOS delay, without a notice', () => {
  const { flow, state, runTimers } = setupFlow();
  flow.announce();

  assert.equal(state.stale, 1, 'die Shell gilt sofort als alt (#616)');
  assert.equal(state.reloads, 0, 'nicht vor der Frist');
  assert.deepEqual(state.timers.map((x) => x.ms), [200]);
  runTimers();
  assert.equal(state.reloads, 1);
  assert.equal(state.notices, 0);
});

test('busy: no reload, the shell is stale, the notice stands', () => {
  const { flow, state, runTimers } = setupFlow({ busy: true });
  flow.announce();
  runTimers();

  assert.equal(state.reloads, 0, 'ein offenes Formular ueberlebt das Update');
  assert.equal(state.stale, 1);
  assert.equal(state.notices, 1);
  assert.equal(flow.isStale(), true);
});

test('somebody who gets busy during the delay is not reloaded either', () => {
  const { flow, state, runTimers } = setupFlow();
  flow.announce();
  state.busy = true;
  runTimers();

  assert.equal(state.reloads, 0);
  assert.equal(state.notices, 1);
});

test('going to the background reloads once nobody is busy any more', () => {
  const { flow, state, document, runTimers } = setupFlow({ busy: true });
  flow.announce();
  runTimers(); // die iOS-Frist ist um
  state.busy = false;
  document.hide();

  assert.equal(state.reloads, 1);
});

// Die Frist nach dem Wechsel des Workers gilt JEDEM Reload-Weg (Codex zu
// #1794): wer in den ersten 200 ms die App wechselt, loeste sonst genau den
// sofortigen Reload aus, den die Frist auf iOS-Standalone verhindern soll
// (leere Seite, verlorene Cookies).
test('going to the background inside the iOS delay does not reload early - the delay does', () => {
  const { flow, state, document, runTimers } = setupFlow();
  flow.announce();
  document.hide();
  assert.equal(state.reloads, 0, 'nicht vor der Frist, auch nicht im Hintergrund');

  runTimers();
  assert.equal(state.reloads, 1, 'die Frist laedt neu, genau einmal');
});

test('busy at the takeover, free and hidden inside the delay: the reload waits for the delay', () => {
  const { flow, state, document, runTimers } = setupFlow({ busy: true });
  flow.announce();
  state.busy = false;
  document.hide();
  assert.equal(state.reloads, 0);

  runTimers();
  assert.equal(state.reloads, 1, 'im Hintergrund und frei: nach der Frist wird neu geladen');
});

test('going to the background with an open form keeps the form', () => {
  const { flow, state, document } = setupFlow({ busy: true });
  flow.announce();
  document.hide();

  assert.equal(state.reloads, 0);
});

test('without an update the background does nothing', () => {
  const { state, document } = setupFlow();
  document.hide();
  assert.equal(state.reloads, 0);
});

test('a reload the loop brake refuses turns into the notice', () => {
  const { flow, state, runTimers } = setupFlow({ reloadAllowed: false });
  flow.announce();
  runTimers();

  assert.equal(state.reloads, 0);
  assert.equal(state.notices, 1, 'sonst bliebe die Seite alt, ohne dass es jemand erfaehrt');
});

test('announcing twice is one update', () => {
  const { flow, state, runTimers } = setupFlow({ busy: true });
  flow.announce();
  flow.announce();
  runTimers();
  assert.equal(state.stale, 1);
  assert.equal(state.notices, 1);
});

// --------------------------------------------------------
// 3. Wer ist beschaeftigt?
// --------------------------------------------------------

const field = (props) => ({ tagName: 'INPUT', type: 'text', value: '', closest: () => null, ...props });

test('typing: focus in a text field with content', () => {
  assert.equal(isTyping({ activeElement: field({ value: 'linda' }) }), true);
  assert.equal(isTyping({ activeElement: field({ value: '   ' }) }), false);
  assert.equal(isTyping({ activeElement: { tagName: 'TEXTAREA', value: 'Notiz', closest: () => null } }), true);
  assert.equal(isTyping({ activeElement: { tagName: 'DIV', isContentEditable: true, textContent: 'x', closest: () => null } }), true);
});

test('typing: an empty focused field counts when its form already holds input (login)', () => {
  const username = field({ value: 'linda' });
  const password = field({ type: 'password', value: '' });
  const form = { querySelectorAll: () => [username, password] };
  password.closest = () => form;
  assert.equal(isTyping({ activeElement: password }), true);

  username.value = '';
  assert.equal(isTyping({ activeElement: password }), false, 'ein leeres Formular haelt niemanden auf');
});

test('typing: buttons, checkboxes and no focus at all are not typing', () => {
  assert.equal(isTyping({ activeElement: null }), false);
  assert.equal(isTyping({ activeElement: { tagName: 'BUTTON', value: 'x' } }), false);
  assert.equal(isTyping({ activeElement: field({ type: 'checkbox', value: 'on' }) }), false);
  assert.equal(isTyping({ activeElement: { tagName: 'BODY' } }), false);
});

test('busy: an open dialog, a leave guard or typing - each one alone is enough', () => {
  const idle = { document: { activeElement: null }, hasLeaveGuard: () => false, hasOpenOverlay: () => false };
  assert.equal(isUserBusy(idle), false);
  assert.equal(isUserBusy({ ...idle, hasOpenOverlay: () => true }), true);
  assert.equal(isUserBusy({ ...idle, hasLeaveGuard: () => true }), true);
  assert.equal(isUserBusy({ ...idle, document: { activeElement: field({ value: 'a' }) } }), true);
});

// --------------------------------------------------------
// 4. Verdrahtung: es gibt keinen zweiten Weg
// --------------------------------------------------------

test('the router wires the one update path and owns no timed reload of its own', () => {
  const router = read('../public/router.js');
  assert.match(router, /onServiceWorkerUpdate\(\(\) => updateFlow\.announce\(\)\)/);
  assert.match(router, /reload: reloadOnce,/, 'der Update-Reload laeuft ueber die Schleifenbremse');
  assert.match(router, /isUserBusy\(\{ document, hasLeaveGuard, hasOpenOverlay \}\)/);
  assert.doesNotMatch(router, /setTimeout\(\(\) => location\.reload\(\)/, 'kein Reload nach fester Frist');
  assert.doesNotMatch(router, /type === 'SW_UPDATED'/, 'die Worker-Nachricht kommt auch beim Erstinstall');
});

test('sw-register.js reloads only as the orphan fallback', () => {
  const src = read('../public/sw-register.js');
  assert.equal([...src.matchAll(/location\.reload\(\)/g)].length, 1);
  assert.match(src, /if \(!updateListeners\.size\) window\.location\.reload\(\);/);
});

test('the update module ships with the shell', () => {
  assert.match(read('../public/sw.js'), /'\/utils\/app-update\.js',/);
});
