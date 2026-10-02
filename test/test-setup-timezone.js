/**
 * Test: Die Browser-Ersteinrichtung reicht die Zone des Browsers mit (#1607, Punkt 4)
 *
 * `POST /api/v1/auth/setup` nimmt `timezone` seit langem an und legt daraus
 * `household_timezone` an - nur schickte die Setup-Seite sie nie. Ein frischer
 * Haushalt hatte damit keine Zone, der Server fiel auf `TZ` zurueck (im
 * Container meist UTC), und "heute" lag oestlich von UTC stundenlang auf
 * gestern: "Essen heute" leer, Ueberfaellig-Zaehler falsch.
 *
 * GEMESSEN WIRD DER AUFRUFER, NICHT NUR api.js. Die Seite laeuft hier als
 * Programm: `render()` wird gerufen, das Formular abgeschickt, und zugesichert
 * wird der Body, der bei `fetch` ankommt. Dafuer haengt diese Suite vor den
 * Stub des Loaders die ECHTE public/api.js - ein Test nur gegen
 * `auth.setup(..., zone)` waere gruen, waehrend setup.js die Zone gar nicht
 * uebergibt (genau der Zustand vor dem Fix).
 *
 * Kein jsdom (siehe test/mini-dom.js): die Attrappe unten kennt genau die
 * Knoten, die setup.js anfasst.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// Spaeter registrierte Hooks laufen zuerst: `/api.js` geht an die echte Datei,
// alles andere weiter an test-browser-loader.mjs.
const realApi = new URL('../public/api.js', import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === '/api.js') return nextResolve(${JSON.stringify(realApi)}, context);
    return nextResolve(specifier, context);
  }
`)}`);

/* ── Browser-Attrappe ─────────────────────────────────────────────────────── */

class FakeNode {
  constructor(found = {}) {
    this.found = found;
    this.listeners = {};
    this.hidden = false;
    this.value = '';
    this.textContent = '';
  }
  querySelector(selector) { return this.found[selector] ?? null; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  setAttribute() {}
  appendChild(node) { node.parentNode = this; return node; }
  insertBefore(node) { node.parentNode = this; return node; }
  replaceChildren() {}
  insertAdjacentHTML() {}
  remove() {}
}

global.CustomEvent = class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
};
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.document = {
  cookie: '',
  title: '',
  querySelector: () => null,
  createElement: () => new FakeNode(),
};
let navigated = [];
global.window = {
  dispatchEvent() {},
  addEventListener() {},
  yuvomi: { navigate: (...args) => { navigated.push(args); } },
};

let requests = [];
let respond = () => ({ status: 200, body: {} });
global.fetch = async (url, opts = {}) => {
  const path = String(url);
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (opts.method === 'POST') requests.push({ path, body });
  const { status, body: payload } = respond(path, body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null, has: () => false },
    json: async () => payload,
  };
};

const { render } = await import('../public/pages/setup.js');

/** Die Zone, die der Browser meldet - oder ein Wurf, wenn `zone` ein Error ist. */
function withBrowserZone(zone, fn) {
  const original = Intl.DateTimeFormat.prototype.resolvedOptions;
  Intl.DateTimeFormat.prototype.resolvedOptions = function patched() {
    if (zone instanceof Error) throw zone;
    return { ...original.call(this), timeZone: zone };
  };
  return Promise.resolve().then(fn).finally(() => {
    Intl.DateTimeFormat.prototype.resolvedOptions = original;
  });
}

/** Rendert die Seite, fuellt das Formular aus und schickt es ab. */
async function submitSetup() {
  requests = [];
  navigated = [];
  const inputs = {
    '#username': new FakeNode(),
    '#display_name': new FakeNode(),
    '#password': new FakeNode(),
    '#confirm_password': new FakeNode(),
  };
  for (const input of Object.values(inputs)) input.parentNode = new FakeNode();
  const form = new FakeNode(inputs);
  form.username = inputs['#username'];
  form.display_name = inputs['#display_name'];
  form.password = inputs['#password'];
  form.confirm_password = inputs['#confirm_password'];
  form.username.value = 'admin';
  form.display_name.value = 'Admin';
  form.password.value = 'password123';
  form.confirm_password.value = 'password123';
  const errorEl = new FakeNode();
  errorEl.hidden = true;
  const container = new FakeNode({
    '#setup-form': form,
    '#setup-error': errorEl,
    '#setup-btn': new FakeNode({ '.auth-btn__label': new FakeNode() }),
    '#setup-version': new FakeNode(),
  });

  await render(container);
  assert.equal(typeof form.listeners.submit, 'function', 'die Seite haengt einen submit-Handler an');
  await form.listeners.submit({ preventDefault() {} });
  return {
    setupCalls: requests.filter((r) => r.path.endsWith('/auth/setup')),
    loginCalls: requests.filter((r) => r.path.endsWith('/auth/login')),
    errorEl,
  };
}

const ok = (path) => (path.endsWith('/auth/setup')
  ? { status: 201, body: { user: { id: 1 } } }
  : { status: 200, body: { user: { id: 1 } } });

/* ── Die Zone reist mit ───────────────────────────────────────────────────── */

test('Setup-Seite: die Zone des Browsers steht im Body von POST /auth/setup', async () => {
  respond = ok;
  const { setupCalls, loginCalls } = await withBrowserZone('Asia/Seoul', submitSetup);
  assert.equal(setupCalls.length, 1);
  assert.equal(setupCalls[0].body.timezone, 'Asia/Seoul');
  // Die Attrappe misst wirklich den Body: die uebrigen Felder kommen an.
  assert.equal(setupCalls[0].body.username, 'admin');
  assert.equal(setupCalls[0].body.language, 'de');
  assert.equal(loginCalls.length, 1);
  assert.equal(navigated.length, 1);
});

test('Setup-Seite: eine Zone mit Viertelstunden-Versatz reist unveraendert mit', async () => {
  respond = ok;
  const { setupCalls } = await withBrowserZone('Pacific/Chatham', submitSetup);
  assert.equal(setupCalls[0].body.timezone, 'Pacific/Chatham');
});

/* ── Keine brauchbare Zone: Verhalten wie bisher ──────────────────────────── */

test('Setup-Seite: ohne brauchbare Browser-Zone fehlt das Feld ganz', async () => {
  respond = ok;
  // `UTC` ist die Antwort eines Browsers, der seine Zone verschweigt (Firefox
  // mit resistFingerprinting, Headless). Als ausdrueckliche Wahl gespeichert
  // ueberstimmte sie ein gesetztes `TZ` des Containers - nicht gesendet bleibt
  // es beim bisherigen Rueckfall.
  const cases = [undefined, '', 'UTC', 'Etc/UTC', 'Etc/Unknown', 'Mars/Olympus', new Error('no Intl')];
  for (const zone of cases) {
    const { setupCalls } = await withBrowserZone(zone, submitSetup);
    const label = zone instanceof Error ? 'Wurf' : JSON.stringify(zone);
    assert.equal(setupCalls.length, 1, `Zone ${label}`);
    assert.equal(Object.hasOwn(setupCalls[0].body, 'timezone'), false, `Zone ${label} darf nicht im Body stehen`);
    assert.equal(navigated.length, 1, `Zone ${label}: die Einrichtung laeuft durch`);
  }
});

/* ── Der Server kennt die Zone nicht: die Einrichtung scheitert nicht daran ── */

test('Setup-Seite: lehnt der Server die Zone ab, laeuft die Einrichtung ohne sie durch', async () => {
  // Der Browser kann eine Zone kennen, die die ICU-Daten des Servers (noch)
  // nicht fuehren. Die Route antwortet dann 400 mit `reason: invalid_timezone` -
  // das darf kein Admin-Konto kosten.
  respond = (path, body) => {
    if (path.endsWith('/auth/setup')) {
      return body.timezone
        ? { status: 400, body: { error: 'Invalid time zone.', code: 400, reason: 'invalid_timezone' } }
        : { status: 201, body: { user: { id: 1 } } };
    }
    return { status: 200, body: { user: { id: 1 } } };
  };
  const { setupCalls, loginCalls, errorEl } = await withBrowserZone('Asia/Seoul', submitSetup);
  assert.equal(setupCalls.length, 2);
  assert.equal(setupCalls[0].body.timezone, 'Asia/Seoul');
  assert.equal(Object.hasOwn(setupCalls[1].body, 'timezone'), false);
  assert.equal(setupCalls[1].body.language, 'de', 'die Sprache bleibt beim zweiten Versuch');
  assert.equal(loginCalls.length, 1);
  assert.equal(navigated.length, 1);
  assert.equal(errorEl.hidden, true);
});

test('Setup-Seite: ein 400 aus anderem Grund loest genau EINE Anfrage aus', async () => {
  // Setup haengt am Login-Limiter (fuenf Fehlversuche je Minute), und jedes 400
  // zaehlt. Eine Wiederholung bei JEDEM 400 kostete je Fehleingabe zwei
  // Versuche und machte aus der dritten Korrektur ein 429. Wiederholt wird
  // deshalb nur am maschinenlesbaren Anker, nie am Status allein und nie am
  // Wortlaut der Meldung.
  const others = [
    { error: 'Display name may be at most 128 characters long.', code: 400 },
    // Derselbe Wortlaut wie die Zonen-Ablehnung, aber ohne Anker: kein Grund.
    { error: 'Invalid time zone. Expected an IANA zone such as "Europe/Berlin".', code: 400 },
    { error: 'Unsupported language.', code: 400, reason: 'something_else' },
  ];
  for (const payload of others) {
    respond = (path) => (path.endsWith('/auth/setup')
      ? { status: 400, body: payload }
      : { status: 200, body: {} });
    const { setupCalls, loginCalls, errorEl } = await withBrowserZone('Asia/Seoul', submitSetup);
    assert.equal(setupCalls.length, 1, `keine Wiederholung bei ${JSON.stringify(payload)}`);
    assert.equal(setupCalls[0].body.timezone, 'Asia/Seoul');
    assert.equal(loginCalls.length, 0);
    assert.equal(navigated.length, 0);
    assert.equal(errorEl.hidden, false);
    assert.equal(errorEl.textContent, 'setup.errorGeneric');
  }
});

test('Setup-Seite: scheitert auch der Versuch ohne Zone, gibt es keinen dritten', async () => {
  respond = (path) => (path.endsWith('/auth/setup')
    ? { status: 400, body: { error: 'Invalid time zone.', code: 400, reason: 'invalid_timezone' } }
    : { status: 200, body: {} });
  const { setupCalls, errorEl } = await withBrowserZone('Asia/Seoul', submitSetup);
  assert.equal(setupCalls.length, 2);
  assert.equal(navigated.length, 0);
  assert.equal(errorEl.textContent, 'setup.errorGeneric');
});

test('Setup-Seite: ein 409 wird nicht wiederholt', async () => {
  respond = (path) => (path.endsWith('/auth/setup')
    ? { status: 409, body: { error: 'Username is already taken.', code: 409 } }
    : { status: 200, body: {} });
  const { setupCalls, errorEl } = await withBrowserZone('Asia/Seoul', submitSetup);
  assert.equal(setupCalls.length, 1);
  assert.equal(errorEl.textContent, 'setup.errorUsernameTaken');
});
