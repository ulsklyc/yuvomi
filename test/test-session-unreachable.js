/**
 * Tests: Nur ein 401 fuehrt zur Anmeldung (Critique R19, 2026-10-16)
 *
 * Der Auth-Guard in navigate() fing JEDEN Fehler von `auth.me()` und schickte
 * zur Anmeldung. Gemessen: 429, 500, 503 und ein Netzabbruch beim Kaltstart
 * zeigten das Anmeldeformular, obwohl die Cookies gueltig waren. Jetzt fuehrt
 * nur der 401 dorthin; alles andere zeigt den Fehlerzustand der Shell
 * (utils/session-unreachable.js), der `Retry-After` achtet und mit wachsendem
 * Abstand selbst erneut versucht.
 *
 * Ausfuehren: node --loader ./test/test-browser-loader.mjs --test test/test-session-unreachable.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNavigateHarness } from './router-navigate-harness.js';
import { installMiniDom } from './mini-dom.js';

const { sessionRetryDelay, showSessionUnreachable, showPageUnreachable, isUnreachableFailure, unreachableTitleKey } = await import('../public/utils/session-unreachable.js');
const { loadErrorSentence } = await import('../public/utils/friendly-error.js');

const USER = { id: 1, access_scope: 'family', role: 'admin' };

function setOnline(onLine) {
  Object.defineProperty(globalThis, 'navigator', { value: { onLine }, configurable: true, writable: true });
}

// ── Die Entscheidung in navigate() ─────────────────────────────────────────

test('ein 401 der Sitzungspruefung fuehrt wie bisher zur Anmeldung', async () => {
  const { navigate, log } = createNavigateHarness({ sessionUser: null });
  await navigate('/tasks', false);
  assert.deepEqual(log.rendered, ['/login']);
  assert.equal(log.unreachable.length, 0);
});

for (const [label, error] of [
  ['429', Object.assign(new Error('Too many requests.'), { status: 429, retryAfter: '30' })],
  ['500', Object.assign(new Error('Internal server error.'), { status: 500 })],
  ['503', Object.assign(new Error('Service unavailable.'), { status: 503 })],
  ['Netzabbruch', new TypeError('Failed to fetch')],
]) {
  test(`ein ${label} der Sitzungspruefung zeigt den Fehlerzustand statt der Anmeldung`, async () => {
    const { navigate, env, log } = createNavigateHarness({ sessionUser: USER, sessionError: error });
    await navigate('/tasks', false);
    assert.deepEqual(log.rendered, [], 'es wurde eine Seite gezeichnet - die Anmeldung?');
    assert.equal(log.unreachable.length, 1);
    assert.equal(log.unreachable[0].error, error);
    // Die Sperre ist frei, sonst liefe der naechste Versuch ins Leere.
    assert.equal(env.isNavigating, false);
    assert.equal(env.currentPath, null);
    assert.equal(env._pendingLoginRedirect, false);

    // Der Versuch danach gelingt: dieselbe Adresse, kein neuer History-Eintrag.
    env.sessionError = null;
    await log.unreachable[0].retry();
    assert.deepEqual(log.rendered, ['/tasks']);
    assert.equal(env.currentUser, USER);
    assert.equal(log.history.filter(([kind]) => kind === 'push').length, 0);
  });
}

test('ein Versuch, der wieder scheitert, zeigt den Fehlerzustand erneut', async () => {
  const error = Object.assign(new Error('x'), { status: 503 });
  const { navigate, log } = createNavigateHarness({ sessionUser: USER, sessionError: error });
  await navigate('/', false);
  await log.unreachable[0].retry();
  assert.equal(log.unreachable.length, 2);
  assert.deepEqual(log.rendered, []);
});

// ── Der Abstand ────────────────────────────────────────────────────────────

test('sessionRetryDelay: exponentiell ab 2 s, gedeckelt bei 30 s', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 20].map((n) => sessionRetryDelay(n, null, 0)),
    [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test('sessionRetryDelay: Retry-After in Sekunden oder als Datum gewinnt, wenn laenger', () => {
  assert.equal(sessionRetryDelay(0, '45', 0), 45_000);
  assert.equal(sessionRetryDelay(4, '5', 0), 30_000, 'ein kuerzeres Retry-After unterbietet den Abstand nicht');
  const now = Date.parse('2026-10-16T12:00:00Z');
  assert.equal(sessionRetryDelay(0, 'Fri, 16 Oct 2026 12:01:00 GMT', now), 60_000);
  assert.equal(sessionRetryDelay(0, 'kein Datum', now), 2000);
  assert.equal(sessionRetryDelay(0, '99999', 0), 600_000, 'gekappt bei 10 Minuten');
});

// ── Der Zustand selbst ─────────────────────────────────────────────────────

function fakeEnv() {
  const timers = [];
  const listeners = new Map();
  return {
    timers,
    listeners,
    env: {
      now: () => 0,
      setTimer: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length - 1; },
      clearTimer: (id) => { if (timers[id]) timers[id].cleared = true; },
      win: {
        addEventListener: (type, fn) => listeners.set(type, fn),
        removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
      },
    },
  };
}

function fakeContainer() {
  return {
    child: null,
    replaceChildren(node) {
      if (this.child) this.child.isConnected = false;
      this.child = node;
      node.isConnected = true;
    },
  };
}

test('der Fehlerzustand nennt die Ursache, legt den Status in die Details und plant den Versuch', () => {
  const restore = installMiniDom();
  setOnline(true);
  try {
    const { env, timers, listeners } = fakeEnv();
    const app = fakeContainer();
    let retried = 0;
    const err = Object.assign(new Error('Too many requests.'), { status: 429, retryAfter: '20' });
    const box = showSessionUnreachable(app, err, () => { retried += 1; }, env);
    const html = box.outerHTML;
    assert.match(html, /role="alert"/);
    // Der Titel folgt der Ursache (Re-Critique 2026-10-17): eine Bremse ist keine unterbrochene Verbindung.
    assert.match(html, /common\.rateLimitedTitle/);
    assert.match(html, /common\.errorRateLimited/, 'die Bremse sagt "kurz warten", nicht "pruefe die Verbindung"');
    assert.doesNotMatch(html, /common\.loadErrorDescription/);
    assert.match(html, /<details class="empty-state__details"><summary>common\.errorDetails<\/summary><pre>HTTP 429/);
    assert.match(html, /common\.sessionRetryHint\{&quot;seconds&quot;:20\}/);
    assert.match(html, /data-action="session-retry"/);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 20_000, 'Retry-After 20 s gilt');

    // Wieder online: sofort, und nur einmal.
    listeners.get('online')();
    assert.equal(retried, 1);
    assert.equal(timers[0].cleared, true);
    timers[0].fn();
    assert.equal(retried, 1, 'Zeitgeber nach dem online-Versuch feuert nicht ein zweites Mal');

    // Scheitert der Versuch, waechst der Abstand (der Zustand stand noch).
    showSessionUnreachable(app, Object.assign(new Error('x'), { status: 503 }), () => {}, env);
    assert.equal(timers[1].ms, 4000);
    showSessionUnreachable(app, Object.assign(new Error('x'), { status: 503 }), () => {}, env);
    assert.equal(timers[2].ms, 8000);

    // Hat ein Versuch die Seite gezeichnet, beginnt die naechste Folge bei 2 s.
    app.child.isConnected = false;
    showSessionUnreachable(app, Object.assign(new Error('x'), { status: 503 }), () => {}, env);
    assert.equal(timers[3].ms, 2000);
  } finally {
    restore();
  }
});

// ── Der Satz ───────────────────────────────────────────────────────────────

test('loadErrorSentence: die Ursache statt "pruefe die Verbindung", nie der Servertext', () => {
  setOnline(true);
  assert.equal(loadErrorSentence({ status: 429, data: { error: 'Too many requests.' } }), 'common.errorRateLimited');
  assert.equal(loadErrorSentence({ status: 500, data: { error: 'Internal server error.' } }), 'common.errorServer');
  assert.equal(loadErrorSentence({ status: 503, data: { error: 'offline' } }), 'common.errorOffline', 'das 503 des Service Workers ohne Netz');
  assert.equal(loadErrorSentence({ status: 403 }), 'common.errorNoPermission');
  assert.equal(loadErrorSentence({ status: 404 }), 'common.errorNotFound');
  assert.equal(loadErrorSentence(new TypeError('Failed to fetch')), 'common.loadErrorDescription');
  assert.equal(loadErrorSentence({ status: 400, data: { error: 'Invalid month.' } }), undefined);
  setOnline(false);
  assert.equal(loadErrorSentence({ status: 500 }), 'common.errorOffline');
  setOnline(true);
});

// ── Eine Ansage je Folge (Critique R19 Nachlese) ───────────────────────────
//
// Gemessen: drei Fehlversuche in 7 s fuegten drei Alarme ein, und der
// Fokus lag auf dem Alarm selbst - jede Absage wurde doppelt und jeder Versuch
// neu angesagt (Guides accessibility "Live Regions",
// accessible-error-announcement).
test('der Zustand sagt sich EINMAL an: kein Fokus, weitere Fehlversuche aktualisieren still denselben Knoten', () => {
  const restore = installMiniDom();
  setOnline(true);
  try {
    const { env } = fakeEnv();
    const app = fakeContainer();
    let replaced = 0;
    const orig = app.replaceChildren.bind(app);
    app.replaceChildren = (node) => { replaced += 1; orig(node); };
    let focused = 0;
    const first = showSessionUnreachable(app, Object.assign(new Error('x'), { status: 503 }), () => {}, env);
    first.focus = () => { focused += 1; };
    assert.equal(first.getAttribute('role'), 'alert', 'die erste Absage ist ein Alarm');
    assert.equal(first.getAttribute('tabindex'), null, 'der Alarm nimmt den Fokus - doppelte Ansage');
    assert.equal(first.tabIndex, undefined, 'der Alarm ist fokussierbar gemacht');
    const second = showSessionUnreachable(app, Object.assign(new Error('x'), { status: 503 }), () => {}, env);
    assert.equal(second, first, 'ein weiterer Fehlversuch zeichnet einen neuen Knoten - ein neuer Alarm');
    assert.equal(second.getAttribute('role'), null, 'der weitere Fehlversuch sagt sich erneut an');
    assert.equal(replaced, 1);
    assert.equal(focused, 0);
  } finally {
    restore();
  }
});

// ── Titel nach Ursache und die nicht erreichbare SEITE (Re-Critique 2026-10-17) ──

test('der Titel widerspricht dem Satz nicht: 503 heisst "Server nicht bereit", offline "Verbindung unterbrochen"', () => {
  const on = { onLine: true };
  assert.equal(unreachableTitleKey({ status: 503 }, on), 'common.serverNotReadyTitle',
    'ueber "Serverfehler" stand "Verbindung unterbrochen"');
  assert.equal(unreachableTitleKey({ status: 500 }, on), 'common.serverNotReadyTitle');
  assert.equal(unreachableTitleKey({ status: 429 }, on), 'common.rateLimitedTitle');
  assert.equal(unreachableTitleKey({ status: 503, data: { error: 'offline' } }, on), 'common.sessionUnreachableTitle',
    'die 503 des Service Workers ist kein Serverfehler');
  assert.equal(unreachableTitleKey(new TypeError('Failed to fetch'), on), 'common.sessionUnreachableTitle');
  assert.equal(unreachableTitleKey({ status: 503 }, { onLine: false }), 'common.sessionUnreachableTitle');
});

test('isUnreachableFailure: Netz und nicht ladbare Seitenmodule ja, ein Fehler im Code der Seite nein', () => {
  const on = { onLine: true };
  assert.equal(isUnreachableFailure(new TypeError('x is not a function'), { onLine: false }), true, 'offline immer');
  assert.equal(isUnreachableFailure(new TypeError('Failed to fetch dynamically imported module: /pages/tasks.js'), on), true);
  assert.equal(isUnreachableFailure(new TypeError('Importing a module script failed.'), on), true, 'Safari');
  assert.equal(isUnreachableFailure(new TypeError('NetworkError when attempting to fetch resource.'), on), true, 'Firefox');
  assert.equal(isUnreachableFailure(Object.assign(new Error('offline'), { status: 0 }), on), true);
  assert.equal(isUnreachableFailure(new TypeError('x is not a function'), on), false);
  assert.equal(isUnreachableFailure(Object.assign(new Error('x'), { status: 500 }), on), false,
    'ein Serverfehler beim Laden zeigt die Seite selbst (mountLoadError), nicht diesen Zustand');
});

test('offline: eigener Zustand statt "Etwas ist schiefgelaufen", und bei online zeichnet die Seite sich selbst neu', () => {
  const restore = installMiniDom();
  try {
    const { env, listeners } = fakeEnv();
    const main = fakeContainer();
    let retried = 0;
    const err = new TypeError('Failed to fetch dynamically imported module: /pages/tasks.js');
    const box = showPageUnreachable(main, err, () => { retried += 1; }, { win: env.win, nav: { onLine: false } });
    const html = box.outerHTML;
    assert.match(html, /offline\.pageTitle/);
    assert.match(html, /offline\.pageDescription/);
    assert.doesNotMatch(html, /common\.errorOccurred|common\.reload/, 'kein Absturzbildschirm, kein "Neu laden"');
    assert.match(html, /role="status"/, 'ein Zustand, kein Alarm');
    assert.match(html, /data-action="page-retry"/);
    assert.match(html, /<pre>TypeError: Failed to fetch/, 'die Ursache steht in den Details');
    assert.equal(main.child, box);
    listeners.get('online')();
    assert.equal(retried, 1, 'online zeichnet neu');
    assert.equal(listeners.has('online'), false, 'und nur einmal');

    // Ist der Zustand inzwischen ersetzt (andere Seite), zeichnet online nichts.
    showPageUnreachable(main, err, () => { retried += 1; }, { win: env.win, nav: { onLine: false } });
    main.child.isConnected = false;
    listeners.get('online')();
    assert.equal(retried, 1, 'eine verlassene Seite holt sich nicht zurueck');
  } finally {
    restore();
  }
});

test('router: ein Netzfehler beim Seitenaufbau geht an showPageUnreachable, nur der Rest an renderError', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf("console.error('[Router] Seiten-Render-Fehler:', err);"));
  const body = block.slice(0, block.indexOf('} finally {'));
  assert.match(body, /if \(!route\.thirdPartyModule && isUnreachableFailure\(err\)\) \{[\s\S]*showPageUnreachable\(errorHost, err, \(\) => navigate\(retryPath, false\)\);[\s\S]*\} else \{\s*renderError\(errorHost, err[,)]/);
});
