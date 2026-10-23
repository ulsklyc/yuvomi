/**
 * Test: /reset-password prueft den Link, bevor jemand tippt (Critique R22, D19)
 *
 * Die Seite zeigte das Formular auch fuer einen abgelaufenen oder schon
 * eingeloesten Link und meldete den toten Link erst nach dem Absenden - alles
 * Eingetippte umsonst. Seit es `POST /auth/reset-password/check` gibt, fragt
 * die Seite vorab und steht gleich im Zustand "Link ungueltig" mit dem Weg zu
 * einem neuen Link.
 *
 * GEMESSEN WIRD DER AUFRUFER: die Seite laeuft als Programm gegen die ECHTE
 * public/api.js (wie test-setup-timezone.js); zugesichert werden die Anfragen,
 * die bei `fetch` ankommen, und der Zustand der Knoten danach. Kein jsdom
 * (siehe test/mini-dom.js): die Attrappe kennt genau die Knoten, die
 * reset-password.js anfasst.
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
    this.focused = false;
  }
  querySelector(selector) { return this.found[selector] ?? null; }
  querySelectorAll() { return []; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  setAttribute() {}
  getAttribute() { return null; }
  focus() { this.focused = true; }
  replaceChildren() {}
  insertAdjacentHTML() {}
}

global.CustomEvent = class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
};
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.document = { cookie: '', title: '', querySelector: () => null, createElement: () => new FakeNode() };
global.window = {
  location: { search: '' },
  dispatchEvent() {},
  addEventListener() {},
  yuvomi: { navigate() {} },
};

let requests = [];
let respond = () => ({ status: 200, body: {} });
global.fetch = async (url, opts = {}) => {
  const path = String(url);
  const body = opts.body ? JSON.parse(opts.body) : null;
  requests.push({ method: opts.method || 'GET', path, body });
  const { status, body: payload } = respond(path, body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null, has: () => false },
    json: async () => payload,
  };
};

const { render } = await import('../public/pages/reset-password.js');

/** Rendert /reset-password mit `search` und liefert die Knoten danach. */
async function renderWith(search, check) {
  requests = [];
  window.location.search = search;
  respond = (path) => {
    if (path.endsWith('/auth/oidc/config')) return { status: 200, body: { password_login_enabled: true } };
    if (path.endsWith('/auth/reset-password/check')) return check();
    return { status: 404, body: { error: 'not found', code: 404 } };
  };
  const form = new FakeNode({ '#password': new FakeNode(), '#confirm': new FakeNode() });
  const nodes = {
    '#reset-form': form,
    '#reset-error': Object.assign(new FakeNode(), { hidden: true }),
    '#reset-success': Object.assign(new FakeNode(), { hidden: true }),
    '#reset-btn': new FakeNode(),
    '#reset-title': Object.assign(new FakeNode(), { textContent: 'resetPassword.title' }),
    '#reset-request-new': Object.assign(new FakeNode(), { hidden: true }),
  };
  await render(new FakeNode(nodes));
  return {
    form,
    title: nodes['#reset-title'],
    error: nodes['#reset-error'],
    again: nodes['#reset-request-new'],
    checks: requests.filter((r) => r.path.endsWith('/auth/reset-password/check')),
    resets: requests.filter((r) => r.path.endsWith('/auth/reset-password')),
  };
}

test('/reset-password: ein toter Link steht sofort als "Link ungueltig" da, ohne Absenden', async () => {
  const page = await renderWith('?token=abc123', () => ({ status: 200, body: { data: { valid: false } } }));
  assert.equal(page.checks.length, 1, 'die Seite fragt den Server vorab');
  assert.equal(page.checks[0].method, 'POST');
  assert.deepEqual(page.checks[0].body, { token: 'abc123' }, 'der Token geht im Koerper, nicht in der URL');
  assert.doesNotMatch(page.checks[0].path, /abc123/);
  assert.equal(page.resets.length, 0, 'eingeloest wird nichts');
  assert.equal(page.title.textContent, 'resetPassword.invalidTitle');
  assert.equal(page.error.hidden, false);
  assert.equal(page.error.textContent, 'resetPassword.invalidToken');
  assert.equal(page.form.hidden, true, 'kein Formular fuer einen toten Link');
  assert.equal(page.again.hidden, false, '"Neuen Link anfordern" ist der Weg');
  assert.equal(page.again.focused, true);
  assert.equal(typeof page.form.listeners.submit, 'undefined', 'kein Absenden mehr verdrahtet');
});

test('/reset-password: ein gueltiger Link zeigt das Formular wie bisher', async () => {
  const page = await renderWith('?token=abc123', () => ({ status: 200, body: { data: { valid: true } } }));
  assert.equal(page.checks.length, 1);
  assert.equal(page.title.textContent, 'resetPassword.title');
  assert.equal(page.form.hidden, false);
  assert.equal(page.again.hidden, true);
  assert.equal(typeof page.form.listeners.submit, 'function');
});

test('/reset-password: ein voller Limiter oder ein Serverfehler erklaert den Link nicht fuer tot', async () => {
  for (const status of [429, 500]) {
    const page = await renderWith('?token=abc123', () => ({ status, body: { error: 'x', code: status } }));
    assert.equal(page.checks.length, 1, `HTTP ${status}`);
    assert.equal(page.form.hidden, false, `HTTP ${status}: das Formular bleibt, das Absenden fragt erneut`);
    assert.equal(page.title.textContent, 'resetPassword.title', `HTTP ${status}`);
    assert.equal(page.again.hidden, true, `HTTP ${status}`);
  }
});

test('/reset-password: ohne Token keine Anfrage, sondern der unvollstaendige Link', async () => {
  const page = await renderWith('', () => assert.fail('ohne Token darf nichts gefragt werden'));
  assert.equal(page.checks.length, 0);
  assert.equal(page.error.textContent, 'resetPassword.missingToken');
  assert.equal(page.form.hidden, true);
});
