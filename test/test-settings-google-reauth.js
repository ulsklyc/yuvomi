/**
 * Tests: die Google-Karte stellt auf "neu verbinden" um, wenn erst der
 *        Kalenderabruf das abgelehnte Token findet (#2019)
 * Modul: /public/settings/pages/sync-calendar.js  (buildGoogleProvider)
 *
 * DIE LAGE: Der Status kam mit `needsReauth: false`, danach lehnt Google beim
 * Laden der Kalenderauswahl das Token ab. Der Server meldet das mit dem Grund
 * `google_reauth_required` (409). Ohne Reaktion darauf zeigte die Karte weiter
 * "verbunden" und "Jetzt synchronisieren", der Knopf zum Neuverbinden fehlte
 * bis zum nächsten Seitenaufruf.
 *
 * Gemessen wird die echte Karte unter test/mini-dom.js; die Antworten des
 * Servers kommen aus dem `__apiStub` des Test-Loaders. Der Mini-DOM kennt
 * weder `replaceWith` noch Selektoren - beides ergänzt diese Suite nur so weit,
 * wie die Karte es braucht, und die Gegenprobe (anderer Fehler) zeigt, dass
 * die Ergänzung allein nichts grün macht.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom, MiniElement } from './mini-dom.js';

installMiniDom();
const toasts = [];
globalThis.window.yuvomi = { showToast: (message, kind) => toasts.push({ message, kind }) };

const replaced = [];
MiniElement.prototype.replaceWith = function replaceWith(next) { replaced.push({ from: this, to: next }); };
// Der Schreibschutz-Schalter entsteht aus Markup (createToggleRow) und fragt
// sein Eingabefeld ab; der Mini-DOM parst kein Markup.
Object.defineProperty(MiniElement.prototype, 'firstElementChild', {
  get() { return new MiniElement('div'); },
});
// Die Aktionszeile hängt nur, wenn sie Kinder hat.
Object.defineProperty(MiniElement.prototype, 'childElementCount', {
  get() { return this.childNodes.filter((n) => n instanceof MiniElement).length; },
});
MiniElement.prototype.querySelector = function querySelector() {
  return { addEventListener() {}, checked: false };
};
// Der Mini-DOM merkt sich nur, DASS ein Listener hängt; zum Klicken braucht
// diese Suite auch welchen.
MiniElement.prototype.addEventListener = function addEventListener(type, handler) {
  this.listener = type;
  (this.handlers ??= []).push({ type, handler });
};

/** Der erste Knopf unter `root`, dessen Text `text` ist. */
function findButton(root, text) {
  for (const node of root.childNodes ?? []) {
    if (!(node instanceof MiniElement)) continue;
    if (node.tagName === 'button' && node.textContent === text) return node;
    const hit = findButton(node, text);
    if (hit) return hit;
  }
  return null;
}

const { __test } = await import('../public/settings/pages/sync-calendar.js');

const admin = { id: 1, role: 'admin' };
const connected = { configured: true, connected: true, needsReauth: false, lastSync: null, mirroredEvents: 0 };

function apiError(status, data) {
  return Object.assign(new Error(data?.error || `HTTP ${status}`), { status, data });
}

/** Lässt die asynchronen Abrufe der Karte auslaufen. */
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

test('#2019: meldet der Kalenderabruf das abgelehnte Token, baut sich die Karte im Zustand "neu verbinden" neu auf', async () => {
  replaced.length = 0;
  const gets = [];
  globalThis.__apiStub = {
    get: async (path) => {
      gets.push(path);
      if (path === '/calendar/google/calendars') {
        throw apiError(409, { error: 'reconnect required', code: 409, reason: 'google_reauth_required' });
      }
      if (path === '/calendar/google/status') return { ...connected, needsReauth: true };
      return { data: [] };
    },
  };

  const card = __test.buildGoogleProvider(connected, admin);
  assert.doesNotMatch(card.outerHTML, /outlookReauthRequired/, 'Ausgangslage: die Karte sieht verbunden aus');
  assert.match(card.outerHTML, /settings\.syncNow/, 'Gegenprobe: der Mini-DOM gibt die Aktionszeile aus');
  await settle();

  assert.ok(gets.includes('/calendar/google/status'), 'der Status wird neu geholt');
  assert.equal(replaced.length, 1, 'die Karte wird ersetzt');
  assert.equal(replaced[0].from, card);
  const html = replaced[0].to.outerHTML;
  assert.match(html, /settings\.outlookReauthRequired/);
  assert.match(html, /settings\.outlookReconnect/, 'der Knopf zum Neuverbinden ist da');
  assert.doesNotMatch(html, /settings\.syncNow/, 'kein "Jetzt synchronisieren" mehr');
});

test('#2019: ein anderer Fehler beim Kalenderabruf lässt die Karte stehen', async () => {
  replaced.length = 0;
  globalThis.__apiStub = {
    get: async (path) => {
      if (path === '/calendar/google/calendars') throw apiError(500, { error: 'boom', code: 500 });
      return { ...connected };
    },
  };
  __test.buildGoogleProvider(connected, admin);
  await settle();
  assert.equal(replaced.length, 0);
});

test('#2019: meldet "Jetzt synchronisieren" das abgelehnte Token, baut sich die Karte im Zustand "neu verbinden" neu auf', async () => {
  replaced.length = 0;
  globalThis.__apiStub = {
    get: async (path) => {
      if (path === '/calendar/google/status') return { ...connected, needsReauth: true };
      return { data: [] };
    },
    post: async (path) => {
      if (path === '/calendar/google/sync') {
        throw apiError(409, { error: 'reconnect required', code: 409, reason: 'google_reauth_required' });
      }
      return {};
    },
  };

  const card = __test.buildGoogleProvider(connected, admin);
  await settle();
  const syncButton = findButton(card, 'settings.syncNow');
  assert.ok(syncButton, 'Ausgangslage: die Karte bietet "Jetzt synchronisieren"');
  await Promise.all(syncButton.handlers.filter((h) => h.type === 'click').map((h) => h.handler({ type: 'click' })));
  await settle();

  assert.equal(replaced.length, 1, 'die Karte wird ersetzt');
  const html = replaced[0].to.outerHTML;
  assert.match(html, /settings\.outlookReauthRequired/);
  assert.match(html, /settings\.outlookReconnect/);
});

// Ausgenommen sind Status und Trennen: beide fragen Google nicht.
test('#2019: jeder Google-Aufruf der Karte läuft über googleCall (Status und Trennen ausgenommen)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/settings/pages/sync-calendar.js', import.meta.url), 'utf8');
  const calls = [...src.matchAll(/api\.(?:get|post|put|patch|delete)\(\s*['`]\/calendar\/google\/([^'`?]*)/g)];
  assert.ok(calls.length >= 5, `zu wenige Google-Aufrufe gefunden (${calls.length})`);
  const unwrapped = calls
    .filter((m) => m[1] !== 'status' && m[1] !== 'disconnect')
    .filter((m) => !/googleCall\(\(\) => $/.test(src.slice(Math.max(0, m.index - 20), m.index)))
    .map((m) => m[0]);
  assert.deepEqual(unwrapped, [], 'ein Google-Aufruf der Karte umgeht handleReauth');
});

test('#2019: scheitert nach dem 409 der Status-Abruf, kommt der Fehler als Toast', async () => {
  replaced.length = 0;
  toasts.length = 0;
  globalThis.__apiStub = {
    get: async (path) => {
      if (path === '/calendar/google/status') throw apiError(503, { error: 'offline', code: 503 });
      return { data: [] };
    },
    post: async () => {
      throw apiError(409, { error: 'Google sign-in expired - reconnect required.', code: 409, reason: 'google_reauth_required' });
    },
  };

  const card = __test.buildGoogleProvider(connected, admin);
  await settle();
  const syncButton = findButton(card, 'settings.syncNow');
  await Promise.all(syncButton.handlers.filter((h) => h.type === 'click').map((h) => h.handler({ type: 'click' })));
  await settle();

  assert.equal(replaced.length, 0, 'ohne frischen Status keine neue Karte');
  assert.deepEqual(toasts.map((x) => x.message), ['Google sign-in expired - reconnect required.'],
    'der ursprüngliche Fehler erscheint, statt still zu verschwinden');
});
