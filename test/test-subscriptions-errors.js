/**
 * Tests: die Fehler der Abos (#1909)
 * Module: server/routes/subscriptions.js, public/pages/subscriptions.js
 *
 * Der Server nennt den Fall (`reason`), die Seite sagt den Satz der App - nie
 * den des Servers. Sagt der Grund, dass es das Ziel der Handlung nicht mehr
 * gibt (ein anderes Haushaltsmitglied hat das Abo, die Kategorie oder die
 * Zahlungsart geloescht), holt die Seite Abos, Kategorien und Einstellungen
 * selbst neu, und der Dialog der Handlung geht zu - nur wenn er noch der offene
 * ist. Fehlt nur die im Abo-Dialog GEWAEHLTE Kategorie oder Zahlungsart, bleibt
 * der Dialog offen und bietet den aktuellen Stand an.
 *
 * LOESCHEN AUF "GIBT ES NICHT MEHR" IST HIER EIN ERFOLG. Abos tragen zwar eine
 * Sichtbarkeit (geteilt/privat), aber die Schreibrouten lesen das Abo ohne
 * Sichtbarkeitsfilter (`loadSubscription`), und ein fremdes privates Abo endet
 * im persoenlichen Modus mit 403 (`mayEditSub`). Eine 404 heisst also nur
 * "schon geloescht" - gemessen unten. Kategorien und Zahlungsarten haben gar
 * keine Sichtbarkeit.
 *
 * DIE BUCHUNG IM BUDGET. Anlegen, Aendern und Verlaengern buchen das Abo ins
 * Budget, und in fremder Waehrung liegt davor ein await auf den Kurs. Was davor
 * geprueft wurde, haelt nicht: die Suite loescht das Abo genau waehrend dieses
 * await (`_setRatesForTest`) und laesst zwei Aenderungen dort aufeinander
 * treffen.
 *
 * Gefahren wird auf beiden Seiten der ECHTE Code:
 * - Server: der echte Router ueber einer migrierten In-Memory-DB.
 * - Seite: die echten Handler bis in ihr catch, ueber den api-Stub des Loaders
 *   (`__apiStub`), den Modal-Stub (`__openModal`, `__closeModal`,
 *   `__modalContextId`) und `__refocusAfterRender`.
 *
 * Ausfuehren: npm run test:subscriptions-errors
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'subscriptions-errors-test-secret';
delete process.env.FIXER_API_KEY;

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
globalThis.localStorage = globalThis.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
const { installMiniDom } = await import('./mini-dom.js');
installMiniDom();
const toasts = [];
globalThis.window.yuvomi = { ...globalThis.window.yuvomi, showToast: (text, kind) => { toasts.push([text, kind]); } };
globalThis.window.matchMedia = globalThis.window.matchMedia
  ?? (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));

const dbmod = await import('../server/db.js');
const routes = await import('../server/routes/subscriptions.js');
const { setPermissions } = await import('../public/permissions.js');
const { __test: page } = await import('../public/pages/subscriptions.js');
const { CASE_MESSAGES, GONE_REASONS } = await import('../public/utils/friendly-error.js');

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const db = dbmod.get();
const user = (name, role) => db.prepare(
  'INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?)',
).run(name, name, 'x', role).lastInsertRowid;
const ADA = user('ada', 'admin');
const BEN = user('ben', 'member');
db.prepare(`INSERT INTO sync_config (key, value) VALUES ('currency', 'EUR')
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
const setMode = (mode) => db.prepare(`INSERT INTO sync_config (key, value) VALUES ('budget_mode', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(mode);

let actor = { id: ADA, role: 'admin' };
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/api/v1/budget/subscriptions', routes.default);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
test.after(() => new Promise((r) => server.close(r)));
const base = `http://127.0.0.1:${server.address().port}/api/v1/budget/subscriptions`;

async function call(method, path, body, as = { id: ADA, role: 'admin' }) {
  actor = as;
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const GONE = 999999;
const ABO = { name: 'Netflix', amount: 12.99, currency: 'EUR', billing_cycle: 'monthly', next_payment_date: '2026-11-01' };
async function aboRow(extra = {}) {
  const r = await call('POST', '', { ...ABO, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
}
const count = (sql, ...args) => db.prepare(sql).get(...args).n;

test.beforeEach(() => {
  setMode('shared');
  routes._setRatesForTest?.(null);
  routes._setLogoFinderForTest?.(null);
});

test('Server: ein Abo, das es nicht mehr gibt - aendern, verlaengern und loeschen nennen subscriptions_subscription_not_found', async () => {
  for (const [method, path, body] of [
    ['PUT', `/${GONE}`, { name: 'x' }],
    ['POST', `/${GONE}/renew`, {}],
    ['DELETE', `/${GONE}`, null],
  ]) {
    const r = await call(method, path, body);
    assert.deepEqual([r.status, r.body?.reason, r.body?.error], [404, 'subscriptions_subscription_not_found', 'Subscription not found.'], `${method} ${path}`);
  }
});

test('Server: die 404 eines Abos heisst nur "geloescht" - ein fremdes privates Abo antwortet 403, nicht 404', async () => {
  setMode('personal');
  const privat = (await call('POST', '', { ...ABO, visibility: 'private' }, { id: BEN, role: 'member' })).body.data;
  for (const [method, path, body] of [['PUT', `/${privat.id}`, { name: 'x' }], ['POST', `/${privat.id}/renew`, {}], ['DELETE', `/${privat.id}`, null]]) {
    const r = await call(method, path, body, { id: ADA, role: 'admin' });
    assert.equal(r.status, 403, `${method}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.reason, undefined);
  }
  assert.equal(count('SELECT COUNT(*) AS n FROM budget_subscriptions WHERE id = ?', privat.id), 1, 'das Abo steht noch');
});

test('Server: Kategorie und Zahlungsart - weg (404) und schon vergeben (409) nennen ihren Fall', async () => {
  const cat = (await call('POST', '/categories', { name: 'Musik' })).body.data;
  assert.equal((await call('POST', '/categories', { name: 'Video' })).status, 201);
  const method = (await call('POST', '/payment-methods', { name: 'Gutschein' })).body.data;
  for (const [verb, path, body, reason, status, error] of [
    ['PUT', `/categories/${GONE}`, { name: 'x' }, 'subscriptions_category_not_found', 404, 'Category not found.'],
    ['DELETE', `/categories/${GONE}`, null, 'subscriptions_category_not_found', 404, 'Category not found.'],
    ['PUT', `/payment-methods/${GONE}`, { name: 'x' }, 'subscriptions_payment_method_not_found', 404, 'Payment method not found.'],
    ['DELETE', `/payment-methods/${GONE}`, null, 'subscriptions_payment_method_not_found', 404, 'Payment method not found.'],
    ['POST', '/categories', { name: 'Musik' }, 'subscriptions_category_exists', 409, 'Category already exists.'],
    ['PUT', `/categories/${cat.id}`, { name: 'Video' }, 'subscriptions_category_exists', 409, 'Category already exists.'],
    ['POST', '/payment-methods', { name: 'Gutschein' }, 'subscriptions_payment_method_exists', 409, 'Payment method already exists.'],
  ]) {
    const r = await call(verb, path, body);
    assert.deepEqual([r.status, r.body?.reason, r.body?.error], [status, reason, error], `${verb} ${path}`);
  }
  const zweite = (await call('POST', '/payment-methods', { name: 'Bar' })).body.data;
  const r = await call('PUT', `/payment-methods/${zweite.id}`, { name: method.name });
  assert.deepEqual([r.status, r.body?.reason], [409, 'subscriptions_payment_method_exists']);
});

test('Server: die gewaehlte Kategorie oder Zahlungsart ist weg - 400 mit ihrem Grund statt 500 am Fremdschluessel, nichts geschrieben', async () => {
  const abo = await aboRow();
  const vorher = count('SELECT COUNT(*) AS n FROM budget_subscriptions');
  for (const [method, path, body, reason] of [
    ['POST', '', { ...ABO, category_id: GONE }, 'subscriptions_selected_category_not_found'],
    ['POST', '', { ...ABO, payment_method_id: GONE }, 'subscriptions_selected_payment_method_not_found'],
    ['PUT', `/${abo.id}`, { category_id: GONE }, 'subscriptions_selected_category_not_found'],
    ['PUT', `/${abo.id}`, { payment_method_id: GONE }, 'subscriptions_selected_payment_method_not_found'],
  ]) {
    const r = await call(method, path, body);
    assert.deepEqual([r.status, r.body?.reason], [400, reason], `${method} ${path}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /^(Category|Payment method) not found\.$/);
  }
  assert.equal(count('SELECT COUNT(*) AS n FROM budget_subscriptions'), vorher, 'kein Abo dazu');
  const danach = db.prepare('SELECT category_id, payment_method_id FROM budget_subscriptions WHERE id = ?').get(abo.id);
  assert.deepEqual(danach, { category_id: null, payment_method_id: null }, 'das Abo blieb unveraendert');
});

test('Server: Ende vor der naechsten Zahlung, zu wenige Zahlungen, Logo mit falschem Inhalt - je ihr Grund, bei mehreren Befunden keiner', async () => {
  const abo = await aboRow({ end_type: 'after_count', occurrence_count: 5 });
  db.prepare('UPDATE budget_subscriptions SET occurrences_done = 3 WHERE id = ?').run(abo.id);
  const fakePng = `data:image/png;base64,${Buffer.from('hello world, no image').toString('base64')}`;
  for (const [method, path, body, reason] of [
    ['POST', '', { ...ABO, end_type: 'on_date', end_date: '2026-10-01' }, 'subscriptions_end_before_next_payment'],
    ['PUT', `/${abo.id}`, { end_type: 'on_date', end_date: '2026-10-01' }, 'subscriptions_end_before_next_payment'],
    ['PUT', `/${abo.id}`, { occurrence_count: 2 }, 'subscriptions_occurrence_count_too_low'],
    ['POST', '', { ...ABO, logo_data: fakePng }, 'subscriptions_logo_content_mismatch'],
  ]) {
    const r = await call(method, path, body);
    assert.deepEqual([r.status, r.body?.reason], [400, reason], `${method} ${path}: ${JSON.stringify(r.body)}`);
  }
  // Zwei Befunde zugleich erreicht nur ein Aufrufer der API: kein Grund.
  const beide = await call('POST', '', { ...ABO, logo_data: fakePng, currency: 'EURO' });
  assert.equal(beide.status, 400);
  assert.equal(beide.body.reason, undefined, JSON.stringify(beide.body));
  assert.match(beide.body.error, /Currency must be a three-letter ISO code\. Logo content does not match its image type\./);
});

test('Server: die Logo-Suche findet nichts - 404 mit subscriptions_no_logo_found', async () => {
  routes._setLogoFinderForTest?.(async () => []);
  const r = await call('POST', '/logo-search', { query: 'netflix' });
  assert.deepEqual([r.status, r.body?.reason, r.body?.error], [404, 'subscriptions_no_logo_found', 'No supported logo could be found.']);
});

test('Server: das Abo verschwindet, waehrend seine Buchung den Kurs holt - 404 statt 500, und keine Buchung ohne Abo', async () => {
  for (const [label, path, method, body] of [
    ['aendern', (id) => `/${id}`, 'PUT', { amount: 20 }],
    ['verlaengern', (id) => `/${id}/renew`, 'POST', {}],
  ]) {
    const abo = await aboRow({ currency: 'USD', name: `Weg beim ${label}` });
    const buchungenVorher = count('SELECT COUNT(*) AS n FROM budget_entries');
    routes._setRatesForTest?.(async () => {
      // Ein anderes Haushaltsmitglied loescht das Abo samt Buchung, genau jetzt.
      db.prepare('DELETE FROM budget_entries WHERE id = (SELECT budget_entry_id FROM budget_subscriptions WHERE id = ?)').run(abo.id);
      db.prepare('DELETE FROM budget_subscriptions WHERE id = ?').run(abo.id);
      return { rates: { EUR: 1, USD: 0.9 }, source: 'cache', fetchedAt: null };
    });
    const r = await call(method, path(abo.id), body);
    routes._setRatesForTest?.(null);
    assert.deepEqual([r.status, r.body?.reason], [404, 'subscriptions_subscription_not_found'], `${label}: ${JSON.stringify(r.body)}`);
    assert.equal(count('SELECT COUNT(*) AS n FROM budget_entries'), buchungenVorher - 1, `${label}: keine neue Buchung ohne Abo`);
    assert.equal(count("SELECT COUNT(*) AS n FROM budget_entries WHERE title LIKE 'Weg beim%'"), 0, `${label}: kein Waise im Budget`);
  }
});

test('Server: zwei Aenderungen treffen sich im await auf den Kurs - das Abo behaelt EINE Buchung', async () => {
  const abo = await aboRow({ currency: 'USD', name: 'Doppelt', enabled: false });
  assert.equal(count("SELECT COUNT(*) AS n FROM budget_entries WHERE title LIKE 'Doppelt%'"), 0, 'Vorbedingung: pausiert, ohne Buchung');
  let release;
  const gate = new Promise((r) => { release = r; });
  let waiting = 0;
  routes._setRatesForTest?.(async () => {
    waiting += 1;
    if (waiting === 2) release();
    await gate;
    return { rates: { EUR: 1, USD: 0.9 }, source: 'cache', fetchedAt: null };
  });
  const [a, b] = await Promise.all([
    call('PUT', `/${abo.id}`, { enabled: true }),
    call('PUT', `/${abo.id}`, { enabled: true, amount: 15 }),
  ]);
  assert.deepEqual([a.status, b.status], [200, 200], JSON.stringify([a.body, b.body]));
  assert.equal(count("SELECT COUNT(*) AS n FROM budget_entries WHERE title LIKE 'Doppelt%'"), 1, 'eine Buchung, kein Duplikat');
  const linked = db.prepare('SELECT budget_entry_id FROM budget_subscriptions WHERE id = ?').get(abo.id).budget_entry_id;
  assert.equal(count('SELECT COUNT(*) AS n FROM budget_entries WHERE id = ?', linked), 1, 'und das Abo zeigt auf sie');
});

const SERVER_REASONS = [
  'subscriptions_subscription_not_found', 'subscriptions_category_not_found', 'subscriptions_payment_method_not_found',
  'subscriptions_selected_category_not_found', 'subscriptions_selected_payment_method_not_found',
  'subscriptions_category_exists', 'subscriptions_payment_method_exists',
  'subscriptions_end_before_next_payment', 'subscriptions_occurrence_count_too_low', 'subscriptions_logo_content_mismatch',
  'subscriptions_no_logo_found',
];

test('Server: jeder Grund der Abos hat einen Satz, und genau die "gibt es nicht mehr" laden nach', () => {
  for (const reason of SERVER_REASONS) {
    assert.ok(CASE_MESSAGES.has(reason), `${reason}: kein Satz`);
    assert.equal(GONE_REASONS.has(reason), reason.endsWith('_not_found'), `${reason}: Nachladen`);
  }
  assert.deepEqual([...CASE_MESSAGES.keys()].filter((r) => r.startsWith('subscriptions_')).sort(), [...SERVER_REASONS].sort(),
    'ein Grund in CASE_MESSAGES, den diese Suite nicht nennt');
});

// ---------------------------------------------------------------------------
// Seite
// ---------------------------------------------------------------------------

setPermissions({ admin: true, modules: {}, widgets: {}, capabilities: {} });

const SERVER_TEXT = 'Server sentence.';
const fehler = (status, reason) => Object.assign(new Error(SERVER_TEXT), {
  name: 'ApiError', status,
  data: { error: SERVER_TEXT, code: status, ...(reason ? { reason } : {}) },
});

const META = {
  categories: [
    { id: 5, name: 'Streaming', label_key: 'subscriptions.categoryStreaming', color: '#111111' },
    { id: 6, name: 'Musik', label_key: null, color: '#222222' },
  ],
  payment_methods: [{ id: 8, name: 'Credit card', label_key: 'subscriptions.paymentMethodCreditCard' }],
  billing_cycles: ['monthly', 'yearly'],
};
const abo = (extra = {}) => ({
  id: 3, name: 'Netflix', amount: 12.99, currency: 'EUR', billing_cycle: 'monthly', cycle_interval: 1,
  next_payment_date: '2026-11-01', enabled: true, status: 'active', category_id: 6, payment_method_id: 8, ...extra,
});
const LIST_PATH = /^\/budget\/subscriptions\?/;

/** Ein Element, das Wert, Fokus, Handler und eingefuegtes Markup merkt. */
function feld(wert = '') {
  return {
    value: wert, checked: false, disabled: false, hidden: false, textContent: '', html: null, focused: 0,
    dataset: {}, handlers: {}, files: [], removed: false, isConnected: true,
    focus() { this.focused += 1; },
    select() {},
    replaceChildren() { this.html = ''; },
    insertAdjacentHTML(_where, html) { this.html = (this.html ?? '') + html; },
    addEventListener(type, fn) { this.handlers[type] = fn; },
    dispatchEvent() {},
    remove() { this.removed = true; },
    setAttribute() {}, removeAttribute() {}, appendChild() {}, closest: () => null, contains: () => false,
    classList: { toggle() {}, add() {}, remove() {} },
    querySelector: () => null, querySelectorAll: () => [],
  };
}

/** Ein Formular: jedes Feld wird beim ersten Fragen angelegt und gemerkt. */
function formular(werte = {}) {
  const gemerkt = new Map();
  const panel = {
    gemerkt,
    insertAdjacentHTML() {},
    querySelectorAll: () => [],
    querySelector(selector) {
      if (!gemerkt.has(selector)) {
        const el = feld(werte[selector] ?? '');
        // Eine Kombobox fragt ihre Felder ueber das Formular.
        el.querySelector = (inner) => panel.querySelector(inner);
        gemerkt.set(selector, el);
      }
      const el = gemerkt.get(selector);
      // Ein entferntes Element ist weg: die naechste Frage bekommt das neue.
      if (el.removed) { gemerkt.delete(selector); return panel.querySelector(selector); }
      return el;
    },
  };
  return panel;
}

const ABO_FORM = {
  '#subscription-next-date': '2026-11-01', '#subscription-currency': 'EUR', '#subscription-end-type': 'never',
  '#subscription-amount': '12.99', '#subscription-name': 'Netflix', '#subscription-cycle': 'monthly',
  '#subscription-interval': '1', '#subscription-reminder': '3', '#subscription-category': '6', '#subscription-method': '8',
};

/** Der Container der Seite: zeichnet in EIN Inhaltselement und zaehlt, wie oft. */
function seite() {
  const content = feld();
  let draws = 0;
  const origReplace = content.replaceChildren.bind(content);
  content.replaceChildren = () => { draws += 1; origReplace(); };
  return {
    isConnected: true,
    get draws() { return draws; },
    querySelector: (sel) => (sel === '#subscriptions-content' ? content : null),
    querySelectorAll: () => [],
  };
}

async function mitSeite(fn, { container = seite() } = {}) {
  const s = page.state;
  const zuvor = { ...s };
  Object.assign(s, { subscriptions: [abo()], meta: structuredClone(META), query: '', categoryId: '', paymentMethodId: '', status: 'all' });
  page.setContainerForTest?.(container);
  try {
    return await fn(container);
  } finally {
    Object.assign(s, zuvor);
    page.setContainerForTest?.(null);
  }
}

/**
 * Mit einem api-Stub laufen lassen. Lesen liefert, was `antworten.get` sagt,
 * sonst den Stand von META; die Schreibwege nennt der Test.
 */
async function mit(antworten, lauf) {
  toasts.length = 0;
  const calls = [];
  const closed = [];
  const stub = {
    get: async (path) => {
      calls.push(['GET', path]);
      const answer = antworten.get?.(path);
      if (answer !== undefined) return answer;
      if (path === '/budget/subscriptions/meta') return { data: structuredClone(META) };
      if (path === '/budget/subscriptions/settings') return { data: { monthly_budget: 0, base_currency: 'EUR' } };
      return { data: { subscriptions: [], summary: null, rates: null } };
    },
  };
  for (const verb of ['post', 'put', 'patch', 'delete']) {
    stub[verb] = async (path, body) => {
      calls.push([verb.toUpperCase(), path]);
      if (!antworten[verb]) throw new Error(`kein Stub fuer ${verb} ${path}`);
      return antworten[verb](path, body);
    };
  }
  const zuvor = { api: globalThis.__apiStub, close: globalThis.__closeModal };
  globalThis.__apiStub = stub;
  globalThis.__closeModal = (opts) => { closed.push(opts ?? {}); return true; };
  try {
    await lauf();
    for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
  } finally {
    globalThis.__apiStub = zuvor.api;
    globalThis.__closeModal = zuvor.close;
  }
  const gets = calls.filter(([verb]) => verb === 'GET').map(([, path]) => path);
  return { calls, closed, gets };
}

const reloaded = (gets) => gets.some((p) => LIST_PATH.test(p)) && gets.includes('/budget/subscriptions/meta');

const assertNoServerText = () => {
  for (const [text] of toasts) assert.doesNotMatch(String(text), /Server sentence/, 'der Text des Servers im Toast');
};

/** Die Optionen einer Kombobox als [Wert, Text]-Paare. */
const optionen = (html, id) => {
  const block = String(html).split(`data-combobox="${id}"`)[1]?.split('data-combobox=')[0] ?? '';
  return [...block.matchAll(/role="option" data-value="([^"]*)"[^>]*>([^<]*)<\/button>/g)].map((m) => [m[1], m[2].trim()]);
};

// --- Abo speichern ----------------------------------------------------------

test('Seite: ein Abo speichern - der Fall wird sein Satz; "gibt es nicht mehr" schliesst und laedt nach', async () => {
  for (const [err, expected, gone] of [
    [fehler(404, 'subscriptions_subscription_not_found'), 'subscriptions.errorSubscriptionGone', true],
    [fehler(400, 'subscriptions_end_before_next_payment'), 'subscriptions.errorEndBeforeNextPayment', false],
    [fehler(400, 'subscriptions_occurrence_count_too_low'), 'subscriptions.errorOccurrenceCountTooLow', false],
    [fehler(400, 'subscriptions_logo_content_mismatch'), 'subscriptions.errorLogoContentMismatch', false],
    [fehler(403), 'common.errorNoPermission', false],
    [fehler(400), 'common.unknownError', false],
    [fehler(500), 'common.unknownError', false],
  ]) {
    const panel = formular(ABO_FORM);
    const { gets, closed } = await mitSeite(() => mit({ put: async () => { throw err; } },
      () => page.saveSubscription(panel, abo())));
    const label = `${err.status} ${err.data.reason ?? ''}`;
    assert.deepEqual(toasts, [[expected, 'danger']], label);
    assert.equal(closed.length, gone ? 1 : 0, `${label}: geschlossen`);
    assert.equal(reloaded(gets), gone, `${label}: nachgeladen ${gets.join(', ')}`);
    assert.equal(panel.querySelector('[type="submit"]').disabled, false, `${label}: Speichern geht wieder`);
    assertNoServerText();
  }
});

test('Seite: ein Abo speichern - wechselt der Dialog zwischen Anfrage und Antwort, bleibt der andere offen', async () => {
  let kontext = 'abo';
  globalThis.__modalContextId = () => kontext;
  try {
    const panel = formular(ABO_FORM);
    const { closed, gets } = await mitSeite(() => mit({
      put: async () => { kontext = 'ein-anderer-dialog'; throw fehler(404, 'subscriptions_subscription_not_found'); },
    }, () => page.saveSubscription(panel, abo())));
    assert.deepEqual(toasts, [['subscriptions.errorSubscriptionGone', 'danger']]);
    assert.deepEqual(closed, [], 'der andere Dialog bleibt offen');
    assert.ok(reloaded(gets), 'die Seite laedt trotzdem nach');
  } finally {
    delete globalThis.__modalContextId;
  }
});

test('Seite: die gewaehlte Kategorie oder Zahlungsart ist weg - der Dialog bleibt offen, die Auswahl kommt frisch ueber denselben Helfer wie beim Oeffnen', async () => {
  for (const [reason, id, expected, goneId] of [
    ['subscriptions_selected_category_not_found', 'subscription-category', 'subscriptions.errorSelectedCategoryGone', '6'],
    ['subscriptions_selected_payment_method_not_found', 'subscription-method', 'subscriptions.errorSelectedPaymentMethodGone', '8'],
  ]) {
    // Beim Oeffnen stehen beide Kategorien und die Zahlungsart zur Wahl.
    let content = null;
    globalThis.__openModal = (opts) => { content = opts.content; };
    try {
      await mitSeite(() => page.openSubscriptionModal(abo()));
    } finally {
      delete globalThis.__openModal;
    }
    assert.ok(optionen(content, id).length >= 2, `Vorbedingung: ${id} hat Optionen beim Oeffnen`);

    const panel = formular({ ...ABO_FORM });
    const altesRoot = panel.querySelector(`[data-combobox="${id}"]`);
    // Inzwischen geloescht: die gewaehlte ist nicht mehr im Stand des Servers.
    const frisch = structuredClone(META);
    frisch.categories = frisch.categories.filter((c) => String(c.id) !== goneId);
    frisch.payment_methods = frisch.payment_methods.filter((m) => String(m.id) !== goneId);
    const { gets, closed } = await mitSeite(() => mit({
      get: (path) => (path === '/budget/subscriptions/meta' ? { data: frisch } : undefined),
      put: async () => { throw fehler(400, reason); },
    }, () => page.saveSubscription(panel, abo())));
    assert.deepEqual(toasts, [[expected, 'danger']], reason);
    assert.deepEqual(closed, [], `${reason}: der Dialog bleibt offen`);
    assert.equal(reloaded(gets), false, `${reason}: die Liste bleibt, nur die Auswahl kommt frisch`);
    assert.ok(gets.includes('/budget/subscriptions/meta'), `${reason}: Kategorien und Zahlungsarten frisch geholt`);
    assert.equal(altesRoot.removed, true, `${reason}: die alte Auswahl ist ersetzt`);
    const neu = optionen(altesRoot.html, id);
    assert.equal(neu.some(([value]) => value === goneId), false, `${reason}: die geloeschte steht nicht mehr zur Wahl`);
    assert.equal(neu[0][0], '', `${reason}: "keine" steht vorn`);
    // DERSELBE Beschriftungshelfer: jede Option steht beim Oeffnen genauso da.
    for (const [value, text] of neu) {
      assert.ok(optionen(content, id).some(([v, t]) => v === value && t === text), `${reason}: Option ${value} wie beim Oeffnen: ${text}`);
    }
    assert.match(altesRoot.html, new RegExp(`id="${id}" type="hidden" value=""`), `${reason}: die Auswahl steht auf "keine"`);
    assert.equal(panel.querySelector(`#${id}-search`).focused, 1, `${reason}: und traegt den Fokus`);
    assert.equal(panel.querySelector('[type="submit"]').disabled, false, `${reason}: Speichern geht wieder`);
    assertNoServerText();
  }
});

test('Seite: die gewaehlte Kategorie ist weg und das Nachladen scheitert - wenigstens die geloeschte faellt aus der Auswahl', async () => {
  const panel = formular({ ...ABO_FORM });
  const root = panel.querySelector('[data-combobox="subscription-category"]');
  await mitSeite(() => mit({
    get: (path) => { if (path === '/budget/subscriptions/meta') throw fehler(500); return undefined; },
    put: async () => { throw fehler(400, 'subscriptions_selected_category_not_found'); },
  }, () => page.saveSubscription(panel, abo())));
  const neu = optionen(root.html, 'subscription-category').map(([value]) => value);
  assert.deepEqual(neu, ['', '5'], 'Musik (6) ist weg, Streaming bleibt');
});

test('Seite: eine Logo-Datei, die die Seite ablehnt, sagt ihren eigenen Satz', async () => {
  const panel = formular(ABO_FORM);
  panel.querySelector('#subscription-logo').files = [{ type: 'text/plain', size: 10 }];
  await mitSeite(() => mit({ put: async () => ({ data: abo() }) }, () => page.saveSubscription(panel, abo())));
  assert.deepEqual(toasts, [['subscriptions.logoTypeError', 'danger']]);
});

// --- Verlaengern und Loeschen ----------------------------------------------

test('Seite: verlaengern - "gibt es nicht mehr" laedt nach; alles andere sagt den Satz der App', async () => {
  for (const [err, expected, gone] of [
    [fehler(404, 'subscriptions_subscription_not_found'), 'subscriptions.errorSubscriptionGone', true],
    [fehler(403), 'common.errorNoPermission', false],
    [fehler(500), 'common.unknownError', false],
  ]) {
    const { gets } = await mitSeite(() => mit({ post: async () => { throw err; } }, () => page.renewSubscription(abo())));
    const label = `${err.status} ${err.data.reason ?? ''}`;
    assert.deepEqual(toasts, [[expected, 'danger']], label);
    assert.equal(reloaded(gets), gone, `${label}: nachgeladen ${gets.join(', ')}`);
    assertNoServerText();
  }
});

test('Seite: loeschen - "schon geloescht" ist ein Erfolg; alles andere bleibt ein Fehler und laedt nicht nach', async () => {
  for (const [err, expectedToasts, reloads] of [
    [fehler(404, 'subscriptions_subscription_not_found'), [['subscriptions.deletedToast', 'success']], true],
    [fehler(403), [['common.errorNoPermission', 'danger']], false],
    [fehler(404), [['common.unknownError', 'danger']], false],
    [fehler(500), [['common.unknownError', 'danger']], false],
  ]) {
    const { gets } = await mitSeite(() => mit({ delete: async () => { throw err; } }, () => page.deleteSubscription(abo())));
    const label = `${err.status} ${err.data.reason ?? ''}`;
    assert.deepEqual(toasts, expectedToasts, label);
    assert.equal(reloaded(gets), reloads, `${label}: nachgeladen ${gets.join(', ')}`);
    assertNoServerText();
  }
});

// --- Einstellungen, Logo-Suche, Laden ---------------------------------------

test('Seite: Monatsbudget speichern - der allgemeine Satz, nie der Text des Servers', async () => {
  for (const err of [fehler(400), fehler(500)]) {
    const panel = formular({ '#subscriptions-base-currency': 'EUR', '#subscriptions-budget': '50' });
    globalThis.__openModal = (opts) => opts.onSave(panel);
    try {
      await mitSeite(() => mit({ put: async () => { throw err; } }, async () => {
        await page.openSettingsModal();
        await panel.querySelector('#subscriptions-settings-form').handlers.submit({ preventDefault() {} });
      }));
    } catch (e) {
      // wireCombobox braucht mehr als das Formular hier - dann misst der Test nichts.
      throw new Error(`Vorbedingung: der Einstellungsdialog laesst sich nicht verdrahten (${e.message})`);
    } finally {
      delete globalThis.__openModal;
    }
    assert.deepEqual(toasts, [['common.unknownError', 'danger']], String(err.status));
  }
});

test('Seite: die Logo-Suche - nichts gefunden sagt das, alles andere den Satz der Suche, nie den des Servers', async () => {
  // Der Picker meldet sich bei der Overlay-History an (utils/overlay-history.js):
  // gerade genug davon, damit er sich oeffnen und wieder abmelden kann.
  const zuvor = { mo: globalThis.MutationObserver, history: globalThis.history, location: globalThis.location };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.history = { state: null, pushState() {}, back() {} };
  globalThis.location = { href: 'http://localhost/budget' };
  test.after(() => Object.assign(globalThis, { MutationObserver: zuvor.mo, history: zuvor.history, location: zuvor.location }));
  for (const [err, expected] of [
    [fehler(404, 'subscriptions_no_logo_found'), 'subscriptions.logoSearchEmpty'],
    [fehler(400), 'subscriptions.logoSearchError'],
    [fehler(500), 'subscriptions.logoSearchError'],
  ]) {
    const overlay = formular({ '#subscription-logo-search-input': 'netflix' });
    const picker = { ...feld(), querySelector: (sel) => overlay.querySelector(sel), remove() {} };
    const formPanel = formular();
    const panel = { ...formPanel, querySelector: (sel) => (sel === '.subscriptions-logo-picker-modal' ? picker : formPanel.querySelector(sel)) };
    await mitSeite(() => mit({ post: async () => { throw err; } }, async () => {
      page.openLogoPickerModal(panel, 'netflix', () => {});
      await overlay.querySelector('#subscription-logo-search-form').handlers.submit({ preventDefault() {} });
    }));
    // Schliessen meldet den Picker wieder ab.
    overlay.querySelector('#subscription-logo-picker-close').handlers.click();
    assert.deepEqual(toasts, [[expected, 'danger']], `${err.status} ${err.data.reason ?? ''}`);
    assert.match(overlay.querySelector('#subscription-logo-results').html, new RegExp(expected.replace('.', '\\.')));
    assertNoServerText();
  }
});

test('Seite: neu laden scheitert - der Satz der Seite, nie der Text des Servers', async () => {
  for (const err of [fehler(400), fehler(500)]) {
    await mitSeite(() => mit({ get: () => { throw err; } }, () => page.reload()));
    assert.deepEqual(toasts, [['subscriptions.loadError', 'danger']], String(err.status));
  }
});

// --- Verwalten: Kategorien und Zahlungsarten --------------------------------

function verwalten(werte = {}, zeilen = {}) {
  const panel = formular(werte);
  panel.querySelectorAll = (sel) => zeilen[sel] ?? [];
  return panel;
}

/** Eine Zeile des Verwalten-Dialogs mit Bearbeiten-Feldern. */
function zeile(kind, id, name) {
  const li = feld();
  li.dataset = { kind, id: String(id) };
  const edit = feld();
  const nameInput = feld(name);
  nameInput.defaultValue = `${name}-alt`;
  edit.querySelector = (sel) => (sel === '.subscriptions-metadata-edit-name' ? nameInput
    : sel === '.subscriptions-metadata-edit-color' ? feld('#123456') : null);
  li.querySelector = (sel) => (sel === '.subscriptions-metadata-row__edit' ? edit : feld());
  const knopf = feld();
  knopf.closest = () => li;
  return { li, knopf };
}

test('Seite: im Verwalten-Dialog anlegen - vergeben sagt seinen Satz und laesst den Dialog stehen; bis #1909 lief das ohne catch', async () => {
  for (const [err, expected, sel, valueSel] of [
    [fehler(409, 'subscriptions_category_exists'), 'subscriptions.errorCategoryExists', '#subscription-add-category', '#subscription-new-category'],
    [fehler(409, 'subscriptions_payment_method_exists'), 'subscriptions.errorPaymentMethodExists', '#subscription-add-method', '#subscription-new-method'],
    [fehler(500), 'common.unknownError', '#subscription-add-category', '#subscription-new-category'],
  ]) {
    const panel = verwalten({ [valueSel]: 'Musik' });
    let opened = 0;
    globalThis.__openModal = (opts) => { opened += 1; if (opened === 1) opts.onSave(panel); };
    try {
      const { closed, gets } = await mitSeite(() => mit({ post: async () => { throw err; } }, async () => {
        page.openMetadataModal();
        await panel.querySelector(sel).handlers.click();
      }));
      const label = `${err.status} ${err.data.reason ?? ''}`;
      assert.deepEqual(toasts, [[expected, 'danger']], label);
      assert.deepEqual(closed, [], `${label}: der Dialog bleibt mit der Eingabe stehen`);
      assert.equal(reloaded(gets), false, label);
      assert.equal(opened, 1, `${label}: nicht neu aufgebaut`);
      assertNoServerText();
    } finally {
      delete globalThis.__openModal;
    }
  }
});

test('Seite: im Verwalten-Dialog umbenennen - weg baut den Dialog frisch auf, vergeben laesst ihn stehen', async () => {
  for (const [kind, err, expected, gone] of [
    ['categories', fehler(404, 'subscriptions_category_not_found'), 'subscriptions.errorCategoryGone', true],
    ['methods', fehler(404, 'subscriptions_payment_method_not_found'), 'subscriptions.errorPaymentMethodGone', true],
    ['categories', fehler(409, 'subscriptions_category_exists'), 'subscriptions.errorCategoryExists', false],
    ['methods', fehler(500), 'common.unknownError', false],
  ]) {
    const { li, knopf } = zeile(kind, 6, 'Neu');
    const panel = verwalten({}, { '[data-act="save"]': [knopf] });
    let opened = 0;
    globalThis.__openModal = (opts) => { opened += 1; if (opened === 1) opts.onSave(panel); };
    try {
      const { closed, gets } = await mitSeite(() => mit({ put: async () => { throw err; } }, async () => {
        page.openMetadataModal();
        await knopf.handlers.click();
      }));
      const label = `${kind} ${err.status} ${err.data.reason ?? ''}`;
      assert.ok(li, label);
      assert.deepEqual(toasts, [[expected, 'danger']], label);
      assert.equal(closed.length, gone ? 1 : 0, `${label}: geschlossen`);
      assert.equal(reloaded(gets), gone, `${label}: nachgeladen`);
      assert.equal(opened, gone ? 2 : 1, `${label}: frisch aufgebaut`);
      assertNoServerText();
    } finally {
      delete globalThis.__openModal;
    }
  }
});

test('Seite: im Verwalten-Dialog loeschen - schon geloescht ist ein Erfolg, alles andere sagt den Satz der App', async () => {
  for (const [kind, err, expected, reloads] of [
    ['categories', fehler(404, 'subscriptions_category_not_found'), ['subscriptions.metaDeletedToast', 'success'], true],
    ['methods', fehler(404, 'subscriptions_payment_method_not_found'), ['subscriptions.metaDeletedToast', 'success'], true],
    // Der Grund der ANDEREN Art ist kein "schon geloescht" fuer diese Zeile.
    ['categories', fehler(404, 'subscriptions_payment_method_not_found'), ['subscriptions.errorPaymentMethodGone', 'danger'], false],
    ['methods', fehler(500), ['common.unknownError', 'danger'], false],
  ]) {
    const { knopf } = zeile(kind, 6, 'Musik');
    const panel = verwalten({}, { '[data-act="delete"]': [knopf] });
    let opened = 0;
    globalThis.__openModal = (opts) => { opened += 1; if (opened === 1) opts.onSave(panel); };
    try {
      const { gets } = await mitSeite(() => mit({ delete: async () => { throw err; } }, async () => {
        page.openMetadataModal();
        await knopf.handlers.click();
      }));
      const label = `${kind} ${err.status} ${err.data.reason ?? ''}`;
      assert.deepEqual(toasts, [expected], label);
      assert.equal(reloaded(gets), reloads, `${label}: nachgeladen`);
      assert.equal(opened, 2, `${label}: der Dialog steht wieder`);
      assertNoServerText();
    } finally {
      delete globalThis.__openModal;
    }
  }
});

// --- Nachladen: Besitzer und Reihenfolge ------------------------------------

test('Seite: nach "gibt es nicht mehr" wird gezeichnet und der Fokus kommt zurueck', async () => {
  let refocus = 0;
  globalThis.__refocusAfterRender = () => { refocus += 1; };
  try {
    await mitSeite(async (container) => {
      await mit({ post: async () => { throw fehler(404, 'subscriptions_subscription_not_found'); } }, () => page.renewSubscription(abo()));
      assert.equal(container.draws, 1, 'die Liste ist neu gezeichnet');
      assert.equal(refocus, 1, 'der Fokus geht auf den Nachfolger des Ausloesers');
    });
  } finally {
    delete globalThis.__refocusAfterRender;
  }
});

test('Seite: wird die Seite waehrend des Nachladens aus dem Dokument genommen, zeichnet nichts und kein Fokus wandert - auch wenn die Modulvariable noch auf sie zeigt', async () => {
  let refocus = 0;
  globalThis.__refocusAfterRender = () => { refocus += 1; };
  try {
    await mitSeite(async (container) => {
      const vorher = page.state.subscriptions;
      await mit({
        get: (path) => {
          // Die Navigation haengt den Container ab, leert aber `container` nicht.
          if (LIST_PATH.test(path)) container.isConnected = false;
          return undefined;
        },
        post: async () => { throw fehler(404, 'subscriptions_subscription_not_found'); },
      }, () => page.renewSubscription(abo()));
      assert.deepEqual(toasts, [['subscriptions.errorSubscriptionGone', 'danger']]);
      assert.equal(container.draws, 0, 'auf eine abgehaengte Seite wird nicht gezeichnet');
      assert.equal(refocus, 0, 'kein Fokus auf einer Seite, die es nicht mehr gibt');
      assert.notEqual(page.state.subscriptions, vorher, 'Vorbedingung: das Nachladen kam wirklich an');
    });
  } finally {
    delete globalThis.__refocusAfterRender;
  }
});

test('Seite: eine Anlage zwischen Start und Antwort des Nachladens - das spaete Nachladen ueberschreibt das neue Abo nicht', async () => {
  const neuesAbo = abo({ id: 4, name: 'Spotify' });
  let ersteAntwort;
  const ersteListe = new Promise((r) => { ersteAntwort = r; });
  let listen = 0;
  await mitSeite(async () => {
    await mit({
      get: (path) => {
        if (!LIST_PATH.test(path)) return undefined;
        listen += 1;
        // Das Nachladen nach "gibt es nicht mehr" haengt; das nach der Anlage
        // antwortet sofort mit dem neuen Abo.
        if (listen === 1) return ersteListe;
        return { data: { subscriptions: [neuesAbo], summary: null, rates: null } };
      },
      post: async (path) => {
        if (path.endsWith('/renew')) throw fehler(404, 'subscriptions_subscription_not_found');
        return { data: neuesAbo };
      },
    }, async () => {
      const renew = page.renewSubscription(abo());
      for (let i = 0; i < 4; i += 1) await new Promise((r) => setImmediate(r));
      assert.equal(listen, 1, 'Vorbedingung: das Nachladen laeuft');
      await page.saveSubscription(formular(ABO_FORM), null);
      assert.deepEqual(page.state.subscriptions.map((s) => s.id), [4], 'nach der Anlage steht das neue Abo');
      ersteAntwort({ data: { subscriptions: [], summary: null, rates: null } });
      await renew;
    });
    assert.deepEqual(page.state.subscriptions.map((s) => s.id), [4], 'die spaete, aeltere Antwort ueberschreibt es nicht');
  });
});

test('Seite: antwortet das Nachladen, nachdem eine Anlage angenommen ist, aber bevor ihre Liste kommt, bleibt die aeltere Antwort liegen', async () => {
  const neuesAbo = abo({ id: 4, name: 'Spotify' });
  let ersteAntwort;
  const ersteListe = new Promise((r) => { ersteAntwort = r; });
  let schliessen;
  let listen = 0;
  await mitSeite(async () => {
    await mit({
      get: (path) => {
        if (!LIST_PATH.test(path)) return undefined;
        listen += 1;
        if (listen === 1) return ersteListe;
        return { data: { subscriptions: [neuesAbo], summary: null, rates: null } };
      },
      post: async (path) => {
        if (path.endsWith('/renew')) throw fehler(404, 'subscriptions_subscription_not_found');
        return { data: neuesAbo };
      },
    }, async () => {
      const renew = page.renewSubscription(abo());
      for (let i = 0; i < 4; i += 1) await new Promise((r) => setImmediate(r));
      assert.equal(listen, 1, 'Vorbedingung: das Nachladen laeuft');
      // Der Server hat die Anlage angenommen; der Dialog schliesst noch.
      globalThis.__closeModal = () => new Promise((r) => { schliessen = r; });
      const save = page.saveSubscription(formular(ABO_FORM), null);
      for (let i = 0; i < 4; i += 1) await new Promise((r) => setImmediate(r));
      assert.equal(typeof schliessen, 'function', 'Vorbedingung: die Anlage steht beim Schliessen');
      ersteAntwort({ data: { subscriptions: [], summary: null, rates: null } });
      await renew;
      for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
      assert.deepEqual(page.state.subscriptions.map((s) => s.id), [3], 'die aeltere Antwort uebernimmt nichts');
      schliessen(true);
      await save;
    });
    assert.deepEqual(page.state.subscriptions.map((s) => s.id), [4], 'danach steht das neue Abo');
  });
});

test('Seite: baut sich die Seite waehrend des Nachladens neu auf (anderer Container), zeichnet das Nachladen nicht in den alten', async () => {
  let refocus = 0;
  globalThis.__refocusAfterRender = () => { refocus += 1; };
  try {
    await mitSeite(async (container) => {
      const neu = seite();
      await mit({
        get: (path) => {
          // Ein Reiterwechsel im Budget rendert die Abos in einen neuen Knoten;
          // der alte haengt dabei noch im Dokument.
          if (LIST_PATH.test(path)) page.setContainerForTest?.(neu);
          return undefined;
        },
        post: async () => { throw fehler(404, 'subscriptions_subscription_not_found'); },
      }, () => page.renewSubscription(abo()));
      assert.equal(container.draws, 0, 'der alte Container bekommt nichts');
      assert.equal(neu.draws, 0, 'und der neue kein Ergebnis einer Anfrage, die nicht seine war');
      assert.equal(refocus, 0);
    });
  } finally {
    delete globalThis.__refocusAfterRender;
  }
});
