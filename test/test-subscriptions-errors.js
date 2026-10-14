/**
 * Tests: die Fehler der Abos (#1909)
 * Module: server/routes/subscriptions.js, public/pages/subscriptions.js
 *
 * Der Server nennt den Fall (`reason`), die Seite sagt den Satz der App - nie
 * den des Servers. Sagt der Grund, dass es das Ziel der Handlung nicht mehr
 * gibt (ein anderes Haushaltsmitglied hat das Abo, die Kategorie oder die
 * Zahlungsart geloescht), nimmt die Seite genau dieses Ding aus ihrem Stand -
 * ohne GET (Zuschnitt vom 15.10.) -, und der Dialog der Handlung geht zu - nur
 * wenn er noch der offene ist. Fehlt nur die im Abo-Dialog GEWAEHLTE Kategorie oder Zahlungsart, bleibt
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
const { __test: page, render: renderPage } = await import('../public/pages/subscriptions.js');
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

/**
 * Was waehrend des await auf den Kurs am Abo geschieht (Review zu #2003): die
 * Buchung entsteht aus der Zeile, wie sie NACH dem await steht, nicht aus dem
 * Schnappschuss davor. `vorDemKurs` laeuft im ersten Abruf des Kurses, also
 * genau in der Luecke zwischen Lesen und Schreiben des ersten Requests.
 */
const KURS = { rates: { EUR: 1, USD: 1 }, source: 'cache', fetchedAt: null };
function mitLuecke(vorDemKurs) {
  let erster = true;
  routes._setRatesForTest?.(async () => {
    if (erster) { erster = false; await vorDemKurs(); }
    return KURS;
  });
}
const buchungen = (name) => db.prepare('SELECT id, amount, date FROM budget_entries WHERE title LIKE ? ORDER BY id').all(`${name}%`);
const aboZeile = (id) => db.prepare('SELECT enabled, amount, next_payment_date, budget_entry_id FROM budget_subscriptions WHERE id = ?').get(id);

test('Server: verlaengert jemand, waehrend eine Aenderung den Kurs holt, schreibt die Aenderung die neue Buchung nicht auf das alte Datum zurueck', async () => {
  routes._setRatesForTest?.(async () => KURS);
  const a = await aboRow({ name: 'Luecke-Renew', currency: 'USD', amount: 10 });
  mitLuecke(async () => {
    const r = await call('POST', `/${a.id}/renew`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
  const put = await call('PUT', `/${a.id}`, { notes: 'x' });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const zeilen = buchungen('Luecke-Renew');
  assert.deepEqual(zeilen.map((z) => z.date), ['2026-11-01', '2026-12-01'], 'je eine Buchung am alten und am neuen Zahlungstag');
  assert.equal(aboZeile(a.id).budget_entry_id, zeilen[1].id, 'das Abo zeigt auf die Buchung der naechsten Zahlung');
});

test('Server: pausiert jemand das Abo, waehrend eine Aenderung den Kurs holt, bekommt das pausierte Abo keine Buchung', async () => {
  routes._setRatesForTest?.(async () => KURS);
  const a = await aboRow({ name: 'Luecke-Pause', currency: 'USD', amount: 10 });
  mitLuecke(async () => {
    const r = await call('PUT', `/${a.id}`, { enabled: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
  const put = await call('PUT', `/${a.id}`, { notes: 'x' });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(aboZeile(a.id).enabled, 0, 'Vorbedingung: pausiert');
  assert.deepEqual(buchungen('Luecke-Pause'), [], 'keine Buchung fuer ein pausiertes Abo');
  assert.equal(aboZeile(a.id).budget_entry_id, null);
});

test('Server: zwei Betraege, und der zuerst gestartete Request kommt zuletzt zurueck - die Buchung traegt den Betrag des Abos', async () => {
  routes._setRatesForTest?.(async () => KURS);
  const a = await aboRow({ name: 'Luecke-Betrag', currency: 'USD', amount: 10 });
  const tore = [];
  routes._setRatesForTest?.(() => new Promise((r) => tore.push(() => r(KURS))));
  const warte = async (n) => { while (tore.length < n) await new Promise((r) => setTimeout(r, 5)); };
  const erst = call('PUT', `/${a.id}`, { amount: 20 });
  await warte(1);
  const dann = call('PUT', `/${a.id}`, { amount: 30 });
  await warte(2);
  tore[1]();
  assert.equal((await dann).status, 200);
  tore[0]();
  assert.equal((await erst).status, 200);
  assert.equal(aboZeile(a.id).amount, 30, 'Vorbedingung: das Abo steht auf dem zuletzt gespeicherten Betrag');
  assert.deepEqual(buchungen('Luecke-Betrag').map((z) => z.amount), [-30], 'eine Buchung, mit diesem Betrag');
});

test('Server: wechselt jemand die Waehrung, waehrend eine Aenderung den Kurs holt, schreibt die Aenderung nicht mit dem Kurs der alten Waehrung', async () => {
  routes._setRatesForTest?.(async () => KURS);
  const a = await aboRow({ name: 'Luecke-Waehrung', currency: 'USD', amount: 10 });
  let gbpAbrufe = 0;
  let erster = true;
  routes._setRatesForTest?.(async (_base, [currency]) => {
    if (currency === 'GBP') { gbpAbrufe += 1; return { rates: { EUR: 1, GBP: 0.5 }, source: 'cache', fetchedAt: null }; }
    if (erster) {
      erster = false;
      const r = await call('PUT', `/${a.id}`, { currency: 'GBP' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    return KURS;
  });
  const put = await call('PUT', `/${a.id}`, { notes: 'x' });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(gbpAbrufe, 1, 'Vorbedingung: der Waehrungswechsel hat seinen eigenen Kurs geholt');
  // Die Buchung ist die des Waehrungswechsels (10 GBP zum Kurs des Stubs: 5);
  // mit dem USD-Kurs der aelteren Aenderung stuende -10 da.
  assert.deepEqual(buchungen('Luecke-Waehrung').map((z) => z.amount), [-5]);
});

test('Server: zwei Verlaengerungen treffen sich im await - jede bucht ihre eigene Zahlung, verknuepft ist die naechste', async () => {
  routes._setRatesForTest?.(async () => KURS);
  const a = await aboRow({ name: 'Luecke-Zweimal', currency: 'USD', amount: 10 });
  const tore = [];
  routes._setRatesForTest?.(() => new Promise((r) => tore.push(() => r(KURS))));
  const warte = async (n) => { while (tore.length < n) await new Promise((r) => setTimeout(r, 5)); };
  const erst = call('POST', `/${a.id}/renew`, {});
  await warte(1);
  const dann = call('POST', `/${a.id}/renew`, {});
  await warte(2);
  // Der zuerst gestartete kommt zuletzt zurueck.
  tore[1]();
  assert.equal((await dann).status, 200);
  tore[0]();
  assert.equal((await erst).status, 200);
  const zeilen = buchungen('Luecke-Zweimal');
  assert.deepEqual(zeilen.map((z) => z.date).sort(), ['2026-11-01', '2026-12-01', '2027-01-01'], 'je Zahlung eine Buchung');
  assert.equal(aboZeile(a.id).next_payment_date, '2027-01-01');
  assert.equal(aboZeile(a.id).budget_entry_id, zeilen.find((z) => z.date === '2027-01-01').id, 'verknuepft ist die Buchung der naechsten Zahlung');
});

const SERVER_REASONS = [
  'subscriptions_subscription_not_found', 'subscriptions_category_not_found', 'subscriptions_payment_method_not_found',
  'subscriptions_selected_category_not_found', 'subscriptions_selected_payment_method_not_found',
  'subscriptions_category_exists', 'subscriptions_payment_method_exists',
  'subscriptions_end_before_next_payment', 'subscriptions_occurrence_count_too_low', 'subscriptions_logo_content_mismatch',
  'subscriptions_no_logo_found',
];

test('Server: jeder Grund der Abos hat einen Satz, und genau die "gibt es nicht mehr" stehen in GONE_REASONS', () => {
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

test('Seite: ein Abo speichern - der Fall wird sein Satz; "gibt es nicht mehr" schliesst, nimmt das Abo aus der Liste und laedt NICHT nach', async () => {
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
    let liste = null;
    let draws = 0;
    const { gets, closed } = await mitSeite(async (container) => {
      const lauf = await mit({ put: async () => { throw err; } }, () => page.saveSubscription(panel, abo()));
      liste = page.state.subscriptions.map((s) => s.id);
      draws = container.draws;
      return lauf;
    });
    const label = `${err.status} ${err.data.reason ?? ''}`;
    assert.deepEqual(toasts, [[expected, 'danger']], label);
    assert.equal(closed.length, gone ? 1 : 0, `${label}: geschlossen`);
    assert.deepEqual(gets, [], `${label}: kein GET`);
    assert.deepEqual(liste, gone ? [] : [3], `${label}: das Abo faellt aus der Liste`);
    assert.equal(draws, gone ? 1 : 0, `${label}: neu gezeichnet`);
    assert.equal(panel.querySelector('[type="submit"]').disabled, false, `${label}: Speichern geht wieder`);
    assertNoServerText();
  }
});

test('Seite: ein Abo speichern - wechselt der Dialog zwischen Anfrage und Antwort, bleibt der andere offen', async () => {
  let kontext = 'abo';
  globalThis.__modalContextId = () => kontext;
  try {
    const panel = formular(ABO_FORM);
    await mitSeite(async () => {
      const { closed, gets } = await mit({
        put: async () => { kontext = 'ein-anderer-dialog'; throw fehler(404, 'subscriptions_subscription_not_found'); },
      }, () => page.saveSubscription(panel, abo()));
      assert.deepEqual(toasts, [['subscriptions.errorSubscriptionGone', 'danger']]);
      assert.deepEqual(closed, [], 'der andere Dialog bleibt offen');
      assert.deepEqual(gets, []);
      assert.deepEqual(page.state.subscriptions, [], 'das Abo faellt trotzdem aus der Liste');
    });
  } finally {
    delete globalThis.__modalContextId;
  }
});

test('Seite: beim Anlegen kennt die Seite keine id - "gibt es nicht mehr" sagt seinen Satz und laesst die Liste stehen', async () => {
  const panel = formular(ABO_FORM);
  await mitSeite(async () => {
    const { gets } = await mit({ post: async () => { throw fehler(404, 'subscriptions_subscription_not_found'); } },
      () => page.saveSubscription(panel, null));
    assert.deepEqual(toasts, [['subscriptions.errorSubscriptionGone', 'danger']]);
    assert.deepEqual(gets, []);
    assert.deepEqual(page.state.subscriptions.map((s) => s.id), [3]);
  });
});

test('Seite: die gewaehlte Kategorie oder Zahlungsart ist weg - der Dialog bleibt offen, die Auswahl ohne sie kommt ueber denselben Helfer wie beim Oeffnen, ohne GET', async () => {
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
    let meta = null;
    let karte = null;
    const { gets, closed } = await mitSeite(async () => {
      const lauf = await mit({ put: async () => { throw fehler(400, reason); } }, () => page.saveSubscription(panel, abo()));
      meta = page.state.meta;
      karte = page.state.subscriptions[0];
      return lauf;
    });
    assert.deepEqual(toasts, [[expected, 'danger']], reason);
    assert.deepEqual(closed, [], `${reason}: der Dialog bleibt offen`);
    assert.deepEqual(gets, [], `${reason}: kein GET, der Stand wird lokal nachgezogen`);
    const liste = id === 'subscription-category' ? meta.categories : meta.payment_methods;
    assert.equal(liste.some((item) => String(item.id) === goneId), false, `${reason}: aus dem Stand der Seite`);
    const feldName = id === 'subscription-category' ? 'category_id' : 'payment_method_id';
    assert.equal(karte[feldName], null, `${reason}: das Abo, das sie trug, verliert sie wie am Server (ON DELETE SET NULL)`);
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

test('Seite: eine Logo-Datei, die die Seite ablehnt, sagt ihren eigenen Satz', async () => {
  const panel = formular(ABO_FORM);
  panel.querySelector('#subscription-logo').files = [{ type: 'text/plain', size: 10 }];
  await mitSeite(() => mit({ put: async () => ({ data: abo() }) }, () => page.saveSubscription(panel, abo())));
  assert.deepEqual(toasts, [['subscriptions.logoTypeError', 'danger']]);
});

// --- Verlaengern und Loeschen ----------------------------------------------

test('Seite: verlaengern - "gibt es nicht mehr" nimmt das Abo aus der Liste, ohne GET; alles andere sagt den Satz der App', async () => {
  for (const [err, expected, gone] of [
    [fehler(404, 'subscriptions_subscription_not_found'), 'subscriptions.errorSubscriptionGone', true],
    [fehler(403), 'common.errorNoPermission', false],
    [fehler(500), 'common.unknownError', false],
  ]) {
    await mitSeite(async () => {
      const { gets } = await mit({ post: async () => { throw err; } }, () => page.renewSubscription(abo()));
      const label = `${err.status} ${err.data.reason ?? ''}`;
      assert.deepEqual(toasts, [[expected, 'danger']], label);
      assert.deepEqual(gets, [], `${label}: kein GET`);
      assert.deepEqual(page.state.subscriptions.map((s) => s.id), gone ? [] : [3], label);
      assertNoServerText();
    });
  }
});

test('Seite: loeschen - "schon geloescht" ist ein Erfolg ohne GET; alles andere bleibt ein Fehler und laesst die Liste stehen', async () => {
  for (const [err, expectedToasts, removed] of [
    [fehler(404, 'subscriptions_subscription_not_found'), [['subscriptions.deletedToast', 'success']], true],
    [fehler(403), [['common.errorNoPermission', 'danger']], false],
    [fehler(404), [['common.unknownError', 'danger']], false],
    [fehler(500), [['common.unknownError', 'danger']], false],
  ]) {
    await mitSeite(async (container) => {
      const { gets } = await mit({ delete: async () => { throw err; } }, () => page.deleteSubscription(abo()));
      const label = `${err.status} ${err.data.reason ?? ''}`;
      assert.deepEqual(toasts, expectedToasts, label);
      assert.deepEqual(gets, [], `${label}: kein GET`);
      assert.deepEqual(page.state.subscriptions.map((s) => s.id), removed ? [] : [3], label);
      assert.equal(container.draws, removed ? 1 : 0, `${label}: neu gezeichnet`);
      assertNoServerText();
    });
  }
});

test('Seite: loeschen gelingt - die Liste kommt wie bisher vom Server', async () => {
  await mitSeite(async () => {
    const { gets } = await mit({ delete: async () => ({}) }, () => page.deleteSubscription(abo()));
    assert.deepEqual(toasts, [['subscriptions.deletedToast', 'success']]);
    assert.ok(reloaded(gets), gets.join(', '));
  });
});

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

test('Seite: im Verwalten-Dialog umbenennen - weg nimmt sie aus dem Stand und baut den Dialog neu auf, ohne GET; vergeben laesst ihn stehen', async () => {
  for (const [kind, err, expected, gone] of [
    ['categories', fehler(404, 'subscriptions_category_not_found'), 'subscriptions.errorCategoryGone', true],
    ['methods', fehler(404, 'subscriptions_payment_method_not_found'), 'subscriptions.errorPaymentMethodGone', true],
    ['categories', fehler(409, 'subscriptions_category_exists'), 'subscriptions.errorCategoryExists', false],
    ['methods', fehler(500), 'common.unknownError', false],
  ]) {
    const rowId = kind === 'categories' ? 6 : 8;
    const { li, knopf } = zeile(kind, rowId, 'Neu');
    const panel = verwalten({}, { '[data-act="save"]': [knopf] });
    let opened = 0;
    globalThis.__openModal = (opts) => { opened += 1; if (opened === 1) opts.onSave(panel); };
    try {
      let meta = null;
      const { closed, gets } = await mitSeite(async () => {
        const lauf = await mit({ put: async () => { throw err; } }, async () => {
          page.openMetadataModal();
          await knopf.handlers.click();
        });
        meta = page.state.meta;
        return lauf;
      });
      const label = `${kind} ${err.status} ${err.data.reason ?? ''}`;
      assert.ok(li, label);
      assert.deepEqual(toasts, [[expected, 'danger']], label);
      assert.equal(closed.length, gone ? 1 : 0, `${label}: geschlossen`);
      assert.deepEqual(gets, [], `${label}: kein GET`);
      const liste = kind === 'categories' ? meta.categories : meta.payment_methods;
      assert.equal(liste.some((item) => item.id === rowId), !gone, `${label}: aus dem Stand (nur bei weg)`);
      assert.equal(opened, gone ? 2 : 1, `${label}: frisch aufgebaut`);
      assertNoServerText();
    } finally {
      delete globalThis.__openModal;
    }
  }
});

test('Seite: im Verwalten-Dialog loeschen - schon geloescht ist ein Erfolg, alles andere sagt den Satz der App', async () => {
  for (const [kind, err, expected, removed] of [
    ['categories', fehler(404, 'subscriptions_category_not_found'), ['subscriptions.metaDeletedToast', 'success'], true],
    ['methods', fehler(404, 'subscriptions_payment_method_not_found'), ['subscriptions.metaDeletedToast', 'success'], true],
    // Der Grund der ANDEREN Art ist kein "schon geloescht" fuer diese Zeile.
    ['categories', fehler(404, 'subscriptions_payment_method_not_found'), ['subscriptions.errorPaymentMethodGone', 'danger'], false],
    ['methods', fehler(500), ['common.unknownError', 'danger'], false],
  ]) {
    const rowId = kind === 'categories' ? 6 : 8;
    const { knopf } = zeile(kind, rowId, 'Musik');
    const panel = verwalten({}, { '[data-act="delete"]': [knopf] });
    let opened = 0;
    globalThis.__openModal = (opts) => { opened += 1; if (opened === 1) opts.onSave(panel); };
    try {
      let meta = null;
      const { gets } = await mitSeite(async () => {
        const lauf = await mit({ delete: async () => { throw err; } }, async () => {
          page.openMetadataModal();
          await knopf.handlers.click();
        });
        meta = page.state.meta;
        return lauf;
      });
      const label = `${kind} ${err.status} ${err.data.reason ?? ''}`;
      assert.deepEqual(toasts, [expected], label);
      assert.deepEqual(gets, [], `${label}: kein GET`);
      const liste = kind === 'categories' ? meta.categories : meta.payment_methods;
      assert.equal(liste.some((item) => item.id === rowId), !removed, `${label}: aus dem Stand (nur bei schon geloescht)`);
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

test('Seite: wird die Seite waehrend des Schliessens aus dem Dokument genommen, zeichnet "gibt es nicht mehr" nichts und kein Fokus wandert - auch wenn die Modulvariable noch auf sie zeigt', async () => {
  let refocus = 0;
  globalThis.__refocusAfterRender = () => { refocus += 1; };
  try {
    await mitSeite(async (container) => {
      await mit({ put: async () => { throw fehler(404, 'subscriptions_subscription_not_found'); } }, async () => {
        // Die Navigation haengt den Container ab, leert aber `container` nicht.
        globalThis.__closeModal = () => { container.isConnected = false; return true; };
        await page.saveSubscription(formular(ABO_FORM), abo());
      });
      assert.deepEqual(toasts, [['subscriptions.errorSubscriptionGone', 'danger']]);
      assert.equal(container.draws, 0, 'auf eine abgehaengte Seite wird nicht gezeichnet');
      assert.equal(refocus, 0, 'kein Fokus auf einer Seite, die es nicht mehr gibt');
    });
  } finally {
    delete globalThis.__refocusAfterRender;
  }
});

test('Seite: eine Anlage zwischen Start und Antwort eines anderen Ladens - die spaete, aeltere Antwort ueberschreibt das neue Abo nicht', async () => {
  const neuesAbo = abo({ id: 4, name: 'Spotify' });
  let ersteAntwort;
  const ersteListe = new Promise((r) => { ersteAntwort = r; });
  let listen = 0;
  await mitSeite(async () => {
    await mit({
      get: (path) => {
        if (!LIST_PATH.test(path)) return undefined;
        listen += 1;
        // Das Laden einer Filteraenderung haengt; das nach der Anlage antwortet sofort.
        if (listen === 1) return ersteListe;
        return { data: { subscriptions: [neuesAbo], summary: null, rates: null } };
      },
      post: async () => ({ data: neuesAbo }),
    }, async () => {
      const filter = page.reload();
      for (let i = 0; i < 4; i += 1) await new Promise((r) => setImmediate(r));
      assert.equal(listen, 1, 'Vorbedingung: das erste Laden laeuft');
      await page.saveSubscription(formular(ABO_FORM), null);
      assert.deepEqual(page.state.subscriptions.map((s) => s.id), [4], 'nach der Anlage steht das neue Abo');
      ersteAntwort({ data: { subscriptions: [], summary: null, rates: null } });
      await filter;
    });
    assert.deepEqual(page.state.subscriptions.map((s) => s.id), [4], 'die spaete, aeltere Antwort ueberschreibt es nicht');
  });
});

test('Seite: ein ueberholtes Laden meldet erst, wenn das neueste da ist - wer danach den Dialog neu aufbaut, sieht den frischen Stand', async () => {
  const antworten = [];
  await mitSeite(async () => {
    await mit({
      get: (path) => {
        if (path !== '/budget/subscriptions/meta') return undefined;
        return new Promise((r) => antworten.push(r));
      },
    }, async () => {
      const alt = page.reload();
      for (let i = 0; i < 4; i += 1) await new Promise((r) => setImmediate(r));
      const neu = page.reload();
      for (let i = 0; i < 4; i += 1) await new Promise((r) => setImmediate(r));
      assert.equal(antworten.length, 2, 'Vorbedingung: zwei Laden laufen');
      let altFertig = null;
      alt.then((ergebnis) => { altFertig = { ergebnis, kategorien: page.state.meta.categories.map((c) => c.id) }; });
      // Das alte antwortet zuerst, mit dem alten Stand.
      antworten[0]({ data: structuredClone(META) });
      for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
      assert.equal(altFertig, null, 'das ueberholte Laden meldet noch nichts');
      antworten[1]({ data: { ...structuredClone(META), categories: [{ id: 9, name: 'Neu', label_key: null, color: '#333333' }] } });
      await neu;
      await alt;
      assert.deepEqual(altFertig, { ergebnis: true, kategorien: [9] }, 'es meldet mit dem frischen Stand');
    });
  });
});

test('Seite: der erste Aufbau zeichnet nichts und bindet nichts, wenn die Seite waehrend des Ladens verlassen wird', async () => {
  const container = seite();
  container.insertAdjacentHTML = () => {};
  container.replaceChildren = () => {};
  await mitSeite(async () => {
    await mit({
      get: (path) => {
        if (LIST_PATH.test(path)) container.isConnected = false;
        return undefined;
      },
    }, () => renderPage(container, { user: null }));
    assert.equal(container.draws, 0, 'die Liste einer verlassenen Seite wird nicht gezeichnet');
  }, { container });
});

test('Seite: baut sich die Seite waehrend des Schliessens neu auf (anderer Container), zeichnet "gibt es nicht mehr" in keinen der beiden', async () => {
  let refocus = 0;
  globalThis.__refocusAfterRender = () => { refocus += 1; };
  try {
    await mitSeite(async (container) => {
      const neu = seite();
      await mit({ put: async () => { throw fehler(404, 'subscriptions_subscription_not_found'); } }, async () => {
        // Ein Reiterwechsel im Budget rendert die Abos in einen neuen Knoten;
        // der alte haengt dabei noch im Dokument.
        globalThis.__closeModal = () => { page.setContainerForTest?.(neu); return true; };
        await page.saveSubscription(formular(ABO_FORM), abo());
      });
      assert.equal(container.draws, 0, 'der alte Container bekommt nichts');
      assert.equal(neu.draws, 0, 'und der neue kein Ergebnis einer Anfrage, die nicht seine war');
      assert.equal(refocus, 0);
    });
  } finally {
    delete globalThis.__refocusAfterRender;
  }
});

test('Seite: eine spaete "gibt es nicht mehr"-Antwort nach "weg und zurueck" laesst die NEUE Seite unberuehrt - an jeder Aufrufstelle', async () => {
  const faelle = [
    ['Abo speichern', 'put', 'subscriptions_subscription_not_found', () => page.saveSubscription(formular(ABO_FORM), abo())],
    ['gewaehlte Kategorie', 'put', 'subscriptions_selected_category_not_found', () => page.saveSubscription(formular(ABO_FORM), abo())],
    ['verlaengern', 'post', 'subscriptions_subscription_not_found', () => page.renewSubscription(abo())],
    ['loeschen', 'delete', 'subscriptions_subscription_not_found', () => page.deleteSubscription(abo())],
  ];
  for (const kind of ['categories', 'methods']) {
    faelle.push([`umbenennen ${kind}`, 'put', kind === 'categories' ? 'subscriptions_category_not_found' : 'subscriptions_payment_method_not_found', async () => {
      const { knopf } = zeile(kind, kind === 'categories' ? 6 : 8, 'Neu');
      const panel = verwalten({}, { '[data-act="save"]': [knopf] });
      globalThis.__openModal = (opts) => opts.onSave(panel);
      try { page.openMetadataModal(); } finally { delete globalThis.__openModal; }
      await knopf.handlers.click();
    }]);
    faelle.push([`loeschen ${kind}`, 'delete', kind === 'categories' ? 'subscriptions_category_not_found' : 'subscriptions_payment_method_not_found', async () => {
      const { knopf } = zeile(kind, kind === 'categories' ? 6 : 8, 'Musik');
      const panel = verwalten({}, { '[data-act="delete"]': [knopf] });
      let opened = 0;
      globalThis.__openModal = (opts) => { opened += 1; if (opened === 1) opts.onSave(panel); };
      try {
        page.openMetadataModal();
        await knopf.handlers.click();
      } finally { delete globalThis.__openModal; }
    }]);
  }
  let refocus = 0;
  globalThis.__refocusAfterRender = () => { refocus += 1; };
  try {
    // Der Router kann die Seite in einen neuen Knoten bauen oder in DENSELBEN:
    // auch dann ist es eine neue Instanz.
    for (const [label, verb, reason, lauf, derselbe] of faelle.flatMap((f) => [[...f, false], [...f, true]])) {
      refocus = 0;
      await mitSeite(async (alt) => {
        const neu = derselbe ? alt : seite();
        const drawsVorher = neu.draws;
        // Waehrend der Request unterwegs ist: Seite verlassen und wieder
        // geoeffnet - eine neue Instanz, die das Abo 3 und die Kategorie 6
        // (wieder) zeigt, dazu ein neues Abo 4.
        const weg = async () => {
          page.setContainerForTest?.(neu);
          page.state.subscriptions = [abo(), abo({ id: 4, name: 'Spotify', category_id: 6 })];
          page.state.meta = structuredClone(META);
          page.state.categoryId = '6';
          page.state.paymentMethodId = '8';
          throw fehler(verb === 'put' && reason.includes('selected') ? 400 : 404, reason);
        };
        await mit({ [verb]: weg }, lauf);
        assert.deepEqual(page.state.subscriptions.map((s) => [s.id, s.category_id, s.payment_method_id]), [[3, 6, 8], [4, 6, 8]], `${label}: Abos der neuen Seite`);
        assert.deepEqual(page.state.meta, META, `${label}: Kategorien und Zahlungsarten der neuen Seite`);
        assert.deepEqual([page.state.categoryId, page.state.paymentMethodId], ['6', '8'], `${label}: Filter der neuen Seite`);
        assert.equal(neu.draws, drawsVorher, `${label}${derselbe ? ' (derselbe Knoten)' : ''}: die neue Seite wird nicht gezeichnet`);
        assert.equal(refocus, 0, `${label}: kein Fokus`);
      });
    }
  } finally {
    delete globalThis.__refocusAfterRender;
  }
});

test('Seite: steht der Filter auf einer Kategorie oder Zahlungsart, die es nicht mehr gibt, geht er auf "alle" zurueck', async () => {
  for (const [kind, rowId, reason, filterKey] of [
    ['categories', 6, 'subscriptions_category_not_found', 'categoryId'],
    ['methods', 8, 'subscriptions_payment_method_not_found', 'paymentMethodId'],
  ]) {
    const { knopf } = zeile(kind, rowId, 'Neu');
    const panel = verwalten({}, { '[data-act="save"]': [knopf] });
    globalThis.__openModal = (opts) => opts.onSave(panel);
    try {
      await mitSeite(async () => {
        page.state[filterKey] = String(rowId);
        // Ein anderer Filter bleibt stehen.
        const anderer = filterKey === 'categoryId' ? 'paymentMethodId' : 'categoryId';
        page.state[anderer] = filterKey === 'categoryId' ? '8' : '6';
        await mit({ put: async () => { throw fehler(404, reason); } }, async () => {
          page.openMetadataModal();
          await knopf.handlers.click();
        });
        assert.equal(page.state[filterKey], '', `${kind}: der Filter auf die geloeschte zeigt auf "alle"`);
        assert.notEqual(page.state[anderer], '', `${kind}: der andere Filter bleibt`);
      });
    } finally {
      delete globalThis.__openModal;
    }
  }
});
