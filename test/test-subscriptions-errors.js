/**
 * Tests: die Fehler der Abos (#1909)
 * Module: server/routes/subscriptions.js, public/pages/subscriptions.js
 *
 * Der Server nennt den Fall (`reason`), die Seite sagt den Satz der App - nie
 * den des Servers. Sagt der Grund, dass es das Ziel der Handlung nicht mehr
 * gibt (ein anderes Haushaltsmitglied hat das Abo, die Kategorie oder die
 * Zahlungsart geloescht), laedt die Seite ueber das normale Laden mit
 * Ladenummer neu - Liste, Kennzahlen und Filter rechnet der Server -, und der
 * Dialog der Handlung geht zu, nur wenn er noch der offene ist. Fehlt nur die im Abo-Dialog GEWAEHLTE Kategorie oder Zahlungsart, bleibt
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
// Der juengste Toast mit Aktion: Rueckgaengig und das Ende seiner Frist
// (`onExpire`, dort laeuft das Loeschen hinter scheduleUndoableDelete).
let lastAction = null;
globalThis.window.yuvomi = { ...globalThis.window.yuvomi, showToast: (text, kind, _ms, action, opts) => {
  toasts.push([text, kind]);
  if (action) lastAction = { action, onExpire: opts?.onExpire ?? null };
  return true;
} };
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
    if (label === 'verlaengern') {
      // Verlaengern gibt die bezahlte Buchung ab, bevor es auf den Kurs wartet
      // (#2004): sie ist Verlauf wie nach jedem Verlaengern und ueberlebt das
      // Loeschen des Abos - wie in der Folge "verlaengern, dann loeschen". Die
      // Buchung der naechsten Zahlung ging mit dem Abo.
      assert.equal(count('SELECT COUNT(*) AS n FROM budget_entries'), buchungenVorher, `${label}: nur die bezahlte Buchung bleibt`);
      assert.deepEqual(
        db.prepare("SELECT id, date FROM budget_entries WHERE title LIKE 'Weg beim verlaengern%'").all(),
        [{ id: abo.budget_entry_id, date: abo.next_payment_date }],
        `${label}: die bezahlte Buchung, keine fuer die naechste Zahlung`,
      );
    } else {
      assert.equal(count('SELECT COUNT(*) AS n FROM budget_entries'), buchungenVorher - 1, `${label}: keine neue Buchung ohne Abo`);
      assert.equal(count("SELECT COUNT(*) AS n FROM budget_entries WHERE title LIKE 'Weg beim%'"), 0, `${label}: kein Waise im Budget`);
    }
  }
});

/**
 * Die Luecke im await auf den Kurs. Seit #2004 schreibt jede Buchung aus der
 * Zeile, die NACH dem await frisch gelesen wird, und Verlaengern gibt seine
 * bezahlte Buchung vor dem await ab; die Rennen dazu (Pause, Sichtbarkeit,
 * zwei Betraege, Waehrung, zweimal Verlaengern) misst
 * `test:subscription-booking-races`. Hier bleibt der Fall aus dem Review zu
 * #2003: ein Verlaengern in der Luecke eines PUT darf die neue Buchung nicht
 * auf das alte Datum zurueckschreiben. `vorDemKurs` laeuft im ersten Abruf des
 * Kurses.
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

test('Server: verlaengert jemand, waehrend eine Aenderung den Kurs holt, steht die Buchung wie auf main - die Aenderung schreibt die neue Buchung nicht auf das alte Datum zurueck', async () => {
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

const SERVER_REASONS = [
  'subscriptions_subscription_not_found', 'subscriptions_subscription_completed', 'subscriptions_category_not_found', 'subscriptions_payment_method_not_found',
  'subscriptions_selected_category_not_found', 'subscriptions_selected_payment_method_not_found',
  'subscriptions_account_not_found',
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

/**
 * Der Stand des Servers NACH "gibt es nicht mehr": Abo 3 ist weg, Abo 4 da,
 * und die Kennzahlen rechnet er selbst. Die Seite muss genau das zeigen.
 */
const NACHHER = {
  subscriptions: [{ id: 4, name: 'Spotify', amount: 9.99, currency: 'EUR', billing_cycle: 'monthly', cycle_interval: 1,
    next_payment_date: '2026-11-05', enabled: true, status: 'active', category_id: 5, payment_method_id: null }],
  summary: { active_count: 1, disabled_count: 0, completed_count: 0, monthly_total: 9.99, monthly_budget: 0, remaining_budget: -9.99, base_currency: 'EUR', by_category: [], by_payment_method: [] },
  rates: null,
};
const metaNachher = (ohne = []) => ({
  ...structuredClone(META),
  categories: META.categories.filter((c) => !ohne.includes(c.id)),
  payment_methods: META.payment_methods.filter((m) => !ohne.includes(m.id)),
});
/** Antworten des Servers fuer das Laden danach. */
const serverDanach = (ohne = []) => (path) => {
  if (LIST_PATH.test(path)) return { data: structuredClone(NACHHER) };
  if (path === '/budget/subscriptions/meta') return { data: metaNachher(ohne) };
  return undefined;
};
/** Genau EIN Laden: Liste, Kategorien und Einstellungen je einmal. */
const einmalGeladen = (gets) => gets.filter((p) => LIST_PATH.test(p)).length === 1
  && gets.filter((p) => p === '/budget/subscriptions/meta').length === 1
  && gets.filter((p) => p === '/budget/subscriptions/settings').length === 1
  && gets.length === 3;
const listenAnfrage = (gets) => gets.find((p) => LIST_PATH.test(p)) ?? '';

const assertNoServerText = () => {
  for (const [text] of toasts) assert.doesNotMatch(String(text), /Server sentence/, 'der Text des Servers im Toast');
};

/** Die Optionen einer Kombobox als [Wert, Text]-Paare. */
const optionen = (html, id) => {
  const block = String(html).split(`data-combobox="${id}"`)[1]?.split('data-combobox=')[0] ?? '';
  return [...block.matchAll(/role="option" data-value="([^"]*)"[^>]*>([^<]*)<\/button>/g)].map((m) => [m[1], m[2].trim()]);
};

// --- Abo speichern ----------------------------------------------------------

test('Seite: ein Abo speichern - der Fall wird sein Satz; "gibt es nicht mehr" schliesst und laedt EINMAL ueber die Ladenummer - Liste und Kennzahlen kommen vom Server', async () => {
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
    let summe = null;
    let draws = 0;
    const { gets, closed } = await mitSeite(async (container) => {
      const lauf = await mit({ get: serverDanach(), put: async () => { throw err; } }, () => page.saveSubscription(panel, abo()));
      liste = page.state.subscriptions.map((s) => s.id);
      summe = page.state.summary?.active_count ?? null;
      draws = container.draws;
      return lauf;
    });
    const label = `${err.status} ${err.data.reason ?? ''}`;
    assert.deepEqual(toasts, [[expected, 'danger']], label);
    assert.equal(closed.length, gone ? 1 : 0, `${label}: geschlossen`);
    if (gone) assert.ok(einmalGeladen(gets), `${label}: genau ein Laden: ${gets.join(', ')}`);
    else assert.deepEqual(gets, [], `${label}: kein Laden`);
    assert.deepEqual(liste, gone ? [4] : [3], `${label}: die Liste des Servers`);
    assert.equal(summe, gone ? 1 : null, `${label}: die Kennzahlen des Servers`);
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
        get: serverDanach(),
        put: async () => { kontext = 'ein-anderer-dialog'; throw fehler(404, 'subscriptions_subscription_not_found'); },
      }, () => page.saveSubscription(panel, abo()));
      assert.deepEqual(toasts, [['subscriptions.errorSubscriptionGone', 'danger']]);
      assert.deepEqual(closed, [], 'der andere Dialog bleibt offen');
      assert.ok(einmalGeladen(gets), gets.join(', '));
      assert.deepEqual(page.state.subscriptions.map((s) => s.id), [4], 'die Seite zeigt trotzdem den Stand des Servers');
    });
  } finally {
    delete globalThis.__modalContextId;
  }
});

test('Seite: beim Anlegen braucht die Seite keine id - "gibt es nicht mehr" laedt wie ueberall', async () => {
  const panel = formular(ABO_FORM);
  await mitSeite(async () => {
    const { gets } = await mit({ get: serverDanach(), post: async () => { throw fehler(404, 'subscriptions_subscription_not_found'); } },
      () => page.saveSubscription(panel, null));
    assert.deepEqual(toasts, [['subscriptions.errorSubscriptionGone', 'danger']]);
    assert.ok(einmalGeladen(gets), gets.join(', '));
    assert.deepEqual(page.state.subscriptions.map((s) => s.id), [4]);
  });
});

test('Seite: die gewaehlte Kategorie oder Zahlungsart ist weg - der Dialog bleibt offen, die Seite laedt einmal, die Auswahl kommt aus dem frischen Stand ueber denselben Helfer wie beim Oeffnen', async () => {
  for (const [reason, id, expected, goneId, filterKey] of [
    ['subscriptions_selected_category_not_found', 'subscription-category', 'subscriptions.errorSelectedCategoryGone', '6', 'categoryId'],
    ['subscriptions_selected_payment_method_not_found', 'subscription-method', 'subscriptions.errorSelectedPaymentMethodGone', '8', 'paymentMethodId'],
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
    let filter = null;
    const { gets, closed } = await mitSeite(async () => {
      // Die Seite ist auf genau die geloeschte gefiltert.
      page.state[filterKey] = goneId;
      const lauf = await mit({ get: serverDanach([Number(goneId)]), put: async () => { throw fehler(400, reason); } },
        () => page.saveSubscription(panel, abo()));
      filter = page.state[filterKey];
      return lauf;
    });
    assert.deepEqual(toasts, [[expected, 'danger']], reason);
    assert.deepEqual(closed, [], `${reason}: der Dialog bleibt offen`);
    assert.ok(einmalGeladen(gets), `${reason}: genau ein Laden: ${gets.join(', ')}`);
    assert.equal(filter, '', `${reason}: der Filter auf die geloeschte geht auf "alle"`);
    assert.doesNotMatch(listenAnfrage(gets), /category_id=|payment_method_id=/, `${reason}: und zwar VOR dem Laden`);
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

test('Seite: die gewaehlte Kategorie ist weg und das Laden scheitert - wenigstens die geloeschte faellt aus der Auswahl, ohne zweiten Toast', async () => {
  const panel = formular({ ...ABO_FORM });
  const root = panel.querySelector('[data-combobox="subscription-category"]');
  await mitSeite(() => mit({
    get: (path) => { if (path === '/budget/subscriptions/meta') throw fehler(500); return undefined; },
    put: async () => { throw fehler(400, 'subscriptions_selected_category_not_found'); },
  }, () => page.saveSubscription(panel, abo())));
  assert.deepEqual(toasts, [['subscriptions.errorSelectedCategoryGone', 'danger']]);
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

test('Seite: verlaengern - "gibt es nicht mehr" und "schon abgeschlossen" laden einmal, die Seite zeigt den Stand des Servers; alles andere sagt den Satz der App', async () => {
  for (const [err, expected, gone] of [
    [fehler(404, 'subscriptions_subscription_not_found'), 'subscriptions.errorSubscriptionGone', true],
    // #2011: die Karte war veraltet - ein anderes Haushaltsmitglied hat die
    // letzte Zahlung gebucht. Der Satz sagt es, das Laden nimmt den Knopf weg.
    [fehler(409, 'subscriptions_subscription_completed'), 'subscriptions.errorSubscriptionCompleted', true],
    [fehler(403), 'common.errorNoPermission', false],
    [fehler(500), 'common.unknownError', false],
  ]) {
    await mitSeite(async () => {
      const { gets } = await mit({ get: serverDanach(), post: async () => { throw err; } }, () => page.renewSubscription(abo()));
      const label = `${err.status} ${err.data.reason ?? ''}`;
      assert.deepEqual(toasts, [[expected, 'danger']], label);
      if (gone) assert.ok(einmalGeladen(gets), `${label}: ${gets.join(', ')}`);
      else assert.deepEqual(gets, [], `${label}: kein Laden`);
      assert.deepEqual(page.state.subscriptions.map((s) => s.id), gone ? [4] : [3], label);
      assert.equal(page.state.summary?.monthly_total ?? null, gone ? 9.99 : null, `${label}: Kennzahlen`);
      assertNoServerText();
    });
  }
});

test('Seite: verlaengern auf einem abgeschlossenen Abo (#2011) - weder Knopf noch Wischgeste fragen nach oder schreiben', async () => {
  let gefragt = 0;
  const zuvor = globalThis.__confirmModal;
  globalThis.__confirmModal = async () => { gefragt += 1; return true; };
  try {
    await mitSeite(async () => {
      const fertig = abo({ status: 'completed', enabled: false, completed_at: '2026-10-01T08:00:00Z' });
      const { calls } = await mit({ post: async () => ({ data: fertig }) }, () => page.renewSubscription(fertig));
      assert.deepEqual(calls, [], 'kein Request');
      assert.equal(gefragt, 0, 'keine Rueckfrage');
      assert.deepEqual(toasts, []);
    });
  } finally {
    globalThis.__confirmModal = zuvor;
  }
});

/* R23, D6: Loeschen mit Rueckgaengig statt Rueckfrage. Die Liste verliert das
 * Abo sofort, der Server erst mit dem Ende der Toast-Frist. */
/** Faengt das Undo-Fenster ab (Stub von scheduleUndoableDelete in test-browser-loader). */
function fangeUndo() {
  const box = { opts: null };
  globalThis.__undoStub = (opts) => { box.opts = opts; };
  test.after(() => { delete globalThis.__undoStub; });
  return box;
}

test('Seite: loeschen - keine Rueckfrage, das Abo geht sofort, der Server erst mit dem Ende der Frist (R23 D6)', async () => {
  let gefragt = 0;
  const zuvor = globalThis.__confirmModal;
  globalThis.__confirmModal = async () => { gefragt += 1; return true; };
  try {
    await mitSeite(async () => {
      const undo = fangeUndo();
      const { calls } = await mit({ delete: async () => ({}) }, () => page.deleteSubscription(abo()));
      assert.equal(gefragt, 0, 'keine Rueckfrage');
      assert.equal(undo.opts?.message, 'common.deletedNamed{"name":"Netflix"}', 'der Satz nennt das Abo');
      assert.deepEqual(calls.filter(([v]) => v === 'DELETE'), [], 'noch nichts geloescht');
      assert.deepEqual(page.state.subscriptions.map((x) => x.id), [], 'die Liste ohne das Abo');
      const ende = await mit({ delete: async () => ({}) }, () => undo.opts.commit({ keepalive: false }));
      assert.deepEqual(ende.calls.filter(([v]) => v === 'DELETE').map(([, p]) => p), ['/budget/subscriptions/3']);
    });
  } finally {
    globalThis.__confirmModal = zuvor;
  }
});

test('Seite: loeschen - Rueckgaengig loescht nichts und holt das Abo zurueck', async () => {
  await mitSeite(async () => {
    const undo = fangeUndo();
    await mit({ get: () => undefined }, () => page.deleteSubscription(abo()));
    const back = await mit({
      get: (path) => (LIST_PATH.test(path) ? { data: { subscriptions: [abo()], summary: null, rates: null } } : undefined),
    }, () => undo.opts.restore());
    assert.deepEqual(back.calls.filter(([v]) => v === 'DELETE'), [], 'kein Loeschen');
    assert.ok(reloaded(back.gets));
    assert.deepEqual(page.state.subscriptions.map((x) => x.id), [3], 'das Abo steht wieder da');
  });
});

test('Seite: loeschen - "schon geloescht" ist ein Erfolg, alles andere nennt den Fehler und holt das Abo zurueck', async () => {
  for (const [err, expectedToasts, gone] of [
    [fehler(404, 'subscriptions_subscription_not_found'), [], true],
    [fehler(403), [['common.errorNoPermission', 'danger']], false],
    [fehler(404), [['common.unknownError', 'danger']], false],
    [fehler(500), [['common.unknownError', 'danger']], false],
  ]) {
    await mitSeite(async () => {
      const undo = fangeUndo();
      await mit({ get: () => undefined }, () => page.deleteSubscription(abo()));
      const label = `${err.status} ${err.data.reason ?? ''}`;
      // Wie scheduleUndoableDelete: scheitert das Loeschen, laeuft restore(err).
      const ende = await mit({
        get: (path) => (LIST_PATH.test(path) ? { data: { subscriptions: gone ? [] : [abo()], summary: null, rates: null } } : undefined),
        delete: async () => { throw err; },
      }, async () => { try { await undo.opts.commit({ keepalive: false }); } catch (e) { await undo.opts.restore(e); } });
      assert.deepEqual(toasts, expectedToasts, label);
      if (gone) assert.deepEqual(ende.gets, [], `${label}: kein Laden noetig`);
      else assert.ok(reloaded(ende.gets), `${label}: ${ende.gets.join(', ')}`);
      assert.deepEqual(page.state.subscriptions.map((x) => x.id), gone ? [] : [3], label);
      assertNoServerText();
    });
  }
});

/* R23, D6: "Bezahlt" ohne Rueckfrage, mit Rueckweg ueber die Marke des Servers. */
test('Seite: verlaengern - keine Rueckfrage, Toast mit Name und Datum, Rueckgaengig schickt die Marke (R23 D6)', async () => {
  let gefragt = 0;
  const zuvor = globalThis.__confirmModal;
  globalThis.__confirmModal = async () => { gefragt += 1; return true; };
  try {
    await mitSeite(async () => {
      lastAction = null;
      const renewed = { ...abo(), next_payment_date: '2026-12-05' };
      const { calls } = await mit({ post: async () => ({ data: renewed, undo: { token: 'abc' } }) }, () => page.renewSubscription(abo()));
      assert.equal(gefragt, 0, 'keine Rueckfrage');
      assert.deepEqual(calls.filter(([v]) => v === 'POST').map(([, p]) => p), ['/budget/subscriptions/3/renew']);
      // R23 (D11): das Datum mit kurzem Wochentag (utils/date-format.js).
      const wd = new Intl.DateTimeFormat('de', { weekday: 'short', timeZone: 'UTC' }).format(new Date('2026-12-05T12:00:00Z'));
      assert.deepEqual(toasts, [[`subscriptions.renewedNamed{"name":"Netflix","date":"${wd}, 2026-12-05"}`, 'default']]);
      let body = null;
      const undo = await mit({ post: async (_p, b) => { body = b; return { data: abo() }; } }, () => lastAction.action());
      assert.deepEqual(undo.calls.filter(([v]) => v === 'POST').map(([, p]) => p), ['/budget/subscriptions/3/renew/undo']);
      assert.deepEqual(body, { token: 'abc' }, 'nur die Marke, keine Buchungs-Id');
    });
  } finally {
    globalThis.__confirmModal = zuvor;
  }
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
  // Die Mehr-Menues der Zeilen (#2152) haengen sich an den Dialog.
  panel.dataset = {};
  panel.addEventListener = () => {};
  return panel;
}

/** Eine Zeile des Verwalten-Dialogs mit Bearbeiten-Feldern. */
function zeile(kind, id, name) {
  const li = feld();
  li.dataset = { kind, id: String(id) };
  // Die Liste, in der die Zeile steht: ihr Platz traegt den Fokus nach dem Neuaufbau (#2152).
  li.parentElement = { children: [li] };
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

test('Seite: im Verwalten-Dialog umbenennen - weg laedt einmal und baut den Dialog danach aus dem frischen Stand neu auf; vergeben laesst ihn stehen', async () => {
  for (const [kind, err, expected, gone] of [
    ['categories', fehler(404, 'subscriptions_category_not_found'), 'subscriptions.errorCategoryGone', true],
    ['methods', fehler(404, 'subscriptions_payment_method_not_found'), 'subscriptions.errorPaymentMethodGone', true],
    ['categories', fehler(409, 'subscriptions_category_exists'), 'subscriptions.errorCategoryExists', false],
    ['methods', fehler(500), 'common.unknownError', false],
  ]) {
    const rowId = kind === 'categories' ? 6 : 8;
    const { knopf } = zeile(kind, rowId, 'Neu');
    const panel = verwalten({}, { '[data-act="save"]': [knopf] });
    let opened = 0;
    let metaBeimNeuaufbau = null;
    globalThis.__openModal = (opts) => {
      opened += 1;
      if (opened === 1) opts.onSave(panel);
      else metaBeimNeuaufbau = structuredClone(page.state.meta);
    };
    try {
      const { closed, gets } = await mitSeite(() => mit({ get: serverDanach([rowId]), put: async () => { throw err; } }, async () => {
        page.openMetadataModal();
        await knopf.handlers.click();
      }));
      const label = `${kind} ${err.status} ${err.data.reason ?? ''}`;
      assert.deepEqual(toasts, [[expected, 'danger']], label);
      assert.equal(closed.length, gone ? 1 : 0, `${label}: geschlossen`);
      if (gone) assert.ok(einmalGeladen(gets), `${label}: ${gets.join(', ')}`);
      else assert.deepEqual(gets, [], `${label}: kein Laden`);
      assert.equal(opened, gone ? 2 : 1, `${label}: neu aufgebaut`);
      if (gone) assert.deepEqual(metaBeimNeuaufbau, metaNachher([rowId]), `${label}: mit dem frischen Stand`);
      assertNoServerText();
    } finally {
      delete globalThis.__openModal;
    }
  }
});

test('Seite: im Verwalten-Dialog loeschen - schon geloescht ist ein Erfolg und laedt; alles andere sagt den Satz der App', async () => {
  for (const [kind, err, expected, gone] of [
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
      let filter = null;
      const filterKey = kind === 'categories' ? 'categoryId' : 'paymentMethodId';
      const { gets } = await mitSeite(async () => {
        page.state[filterKey] = String(rowId);
        const lauf = await mit({ get: serverDanach([rowId]), delete: async () => { throw err; } }, async () => {
          page.openMetadataModal();
          await knopf.handlers.click();
        });
        filter = page.state[filterKey];
        return lauf;
      });
      const label = `${kind} ${err.status} ${err.data.reason ?? ''}`;
      assert.deepEqual(toasts, [expected], label);
      if (gone) {
        assert.ok(einmalGeladen(gets), `${label}: ${gets.join(', ')}`);
        assert.equal(filter, '', `${label}: der Filter auf die geloeschte geht vor dem Laden auf "alle"`);
        assert.doesNotMatch(listenAnfrage(gets), /category_id=|payment_method_id=/, label);
      } else {
        assert.deepEqual(gets, [], `${label}: kein Laden`);
      }
      assert.equal(opened, 2, `${label}: der Dialog steht wieder`);
      assertNoServerText();
    } finally {
      delete globalThis.__openModal;
    }
  }
});

// #1997: Oeffnet der Nutzer WAEHREND des Loeschens einen anderen Dialog, baut
// die Antwort die Verwaltung nicht darueber neu auf - openMetadataModal()
// schloesse ihn sonst mit force. Das gilt fuer den Erfolg (samt "schon
// geloescht") wie fuer den Fehler, nach dem die Verwaltung sonst wieder aufgeht.
test('Seite: im Verwalten-Dialog loeschen - kommt die Antwort, nachdem ein anderer Dialog aufging, geht die Verwaltung nicht wieder auf (#1997)', async () => {
  for (const [kind, loesche, expected] of [
    ['categories', async () => ({ data: null }), ['subscriptions.metaDeletedToast', 'success']],
    ['methods', async () => { throw fehler(404, 'subscriptions_payment_method_not_found'); }, ['subscriptions.metaDeletedToast', 'success']],
    ['methods', async () => { throw fehler(500); }, ['common.unknownError', 'danger']],
  ]) {
    const rowId = kind === 'categories' ? 6 : 8;
    const { knopf } = zeile(kind, rowId, 'Musik');
    const panel = verwalten({}, { '[data-act="delete"]': [knopf] });
    let opened = 0;
    let kontext = 'verwaltung';
    globalThis.__modalContextId = () => kontext;
    globalThis.__openModal = (opts) => { opened += 1; if (opened === 1) opts.onSave(panel); };
    try {
      await mitSeite(() => mit({
        get: serverDanach([rowId]),
        delete: async (...args) => { kontext = 'ein-anderer-dialog'; return loesche(...args); },
      }, async () => {
        page.openMetadataModal();
        await knopf.handlers.click();
      }));
      const label = `${kind} ${expected[0]}`;
      assert.deepEqual(toasts, [expected], label);
      assert.equal(opened, 1, `${label}: die Verwaltung geht ueber dem anderen Dialog wieder auf und verdraengt ihn`);
    } finally {
      delete globalThis.__openModal;
      delete globalThis.__modalContextId;
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
    // Loeschen faellt seit R23 (D6) heraus: es fragt den Server erst mit dem
    // Ende der Toast-Frist, und sein restore laedt nur die eigene Instanz
    // (isCurrentOwner) - der Fall "Antwort kommt auf einer neuen Seite an"
    // entsteht dort nicht mehr waehrend des Tipps.
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
        const { gets } = await mit({ [verb]: weg }, lauf);
        assert.deepEqual(gets, [], `${label}: die neue Seite laedt nicht wegen einer fremden Antwort`);
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
        const { gets } = await mit({ get: serverDanach([rowId]), put: async () => { throw fehler(404, reason); } }, async () => {
          page.openMetadataModal();
          await knopf.handlers.click();
        });
        assert.equal(page.state[filterKey], '', `${kind}: der Filter auf die geloeschte zeigt auf "alle"`);
        const param = filterKey === 'categoryId' ? 'category_id' : 'payment_method_id';
        assert.doesNotMatch(listenAnfrage(gets), new RegExp(`${param}=`), `${kind}: das Laden fragt ohne die geloeschte`);
        assert.notEqual(page.state[anderer], '', `${kind}: der andere Filter bleibt`);
      });
    } finally {
      delete globalThis.__openModal;
    }
  }
});

test('Seite: scheitert das Laden nach "gibt es nicht mehr", bleibt es bei dem einen Satz', async () => {
  await mitSeite(async () => {
    await mit({
      get: (path) => { if (LIST_PATH.test(path)) throw fehler(500); return undefined; },
      post: async () => { throw fehler(404, 'subscriptions_subscription_not_found'); },
    }, () => page.renewSubscription(abo()));
    assert.deepEqual(toasts, [['subscriptions.errorSubscriptionGone', 'danger']], 'kein zweiter Toast fuer das Laden');
  });
});

// Review-Runde 1 zu #2010 (#2009): ein abgeschlossenes Abo steht nach seinem
// Ende - bei `on_date` liegt das naechste Datum hinter dem Enddatum, bei
// `after_count` ist der Zaehler erreicht. Wer es wieder ins Budget aufnimmt,
// braucht ein spaeteres Ende. Das sagt die Seite VOR dem Absenden am Feld,
// mit dem Satz, den sonst die Absage des Servers als Toast braeuchte. Bleibt
// das Abo abgeschlossen (nur eine Notiz geaendert), gilt der Vergleich nicht,
// wie am Server.
test('Seite: ein abgeschlossenes Abo wieder aufnehmen - ein zu fruehes Ende steht am Feld, nicht im Toast', async () => {
  const marks = [];
  globalThis.__reportFieldError = (input, message) => marks.push([input, message]);
  const done = { status: 'completed', enabled: false, completed_at: '2028-01-15T08:00:00Z', next_payment_date: '2028-02-15', occurrences_done: 1 };
  const cases = [
    ['on_date', { end_type: 'on_date', end_date: '2028-01-20' }, { '#subscription-end-type': 'on_date', '#subscription-end-date': '2028-01-20' }, '#subscription-end-date', 'subscriptions.errorEndBeforeNextPayment'],
    ['after_count', { end_type: 'after_count', occurrence_count: 1 }, { '#subscription-end-type': 'after_count', '#subscription-end-count': '1' }, '#subscription-end-count', 'subscriptions.errorOccurrenceCountTooLow'],
  ];
  try {
    for (const [label, row, fields, fieldId, sentence] of cases) {
      const existing = abo({ ...done, ...row });
      const form = { ...ABO_FORM, '#subscription-next-date': '2028-02-15', ...fields };
      // Wieder aufnehmen: abgelehnt am Feld, kein Request, kein Toast.
      const panel = formular(form);
      panel.querySelector('#subscription-enabled').checked = true;
      marks.length = 0;
      const lauf = await mitSeite(() => mit({ put: async () => ({ data: existing }) }, () => page.saveSubscription(panel, existing)));
      assert.deepEqual(marks.map(([input, message]) => [input === panel.querySelector(fieldId), message]), [[true, sentence]], label);
      assert.equal(lauf.calls.some(([verb]) => verb === 'PUT'), false, `${label}: nichts gesendet`);
      assert.deepEqual(toasts, [], `${label}: kein Toast`);
      // Abgeschlossen lassen und nur speichern: geht durch.
      const still = formular(form);
      marks.length = 0;
      const ok = await mitSeite(() => mit({ put: async () => ({ data: existing }) }, () => page.saveSubscription(still, existing)));
      assert.deepEqual(marks, [], `${label}: abgeschlossen bleibt ohne Feldfehler`);
      assert.equal(ok.calls.some(([verb]) => verb === 'PUT'), true, `${label}: gespeichert`);
      // Mit spaeterem Ende wieder aufnehmen: geht durch.
      const later = formular({ ...form, '#subscription-end-date': '2028-06-30', '#subscription-end-count': '4' });
      later.querySelector('#subscription-enabled').checked = true;
      marks.length = 0;
      const back = await mitSeite(() => mit({ put: async () => ({ data: existing }) }, () => page.saveSubscription(later, existing)));
      assert.deepEqual(marks, [], `${label}: spaeteres Ende ohne Feldfehler`);
      assert.equal(back.calls.some(([verb]) => verb === 'PUT'), true, `${label}: reaktiviert`);
    }
  } finally {
    delete globalThis.__reportFieldError;
  }
});

// #1997: die ERFOLGSWEGE. Ob der Slot noch den eigenen Dialog haelt, entscheidet
// closeModal({ context }) in components/modal.js (am echten Modul gemessen in
// test-modal-dead-time.js); hier zaehlt die Verdrahtung: jeder Erfolgsweg reicht
// den VOR der Anfrage gemerkten Kontext hinein, und der Verwalten-Dialog baut
// sich nur neu auf, wenn es sein eigener war, der eben zuging - sonst schloesse
// openMetadataModal() den Dialog, den der Nutzer inzwischen geoeffnet hat.
test('Seite: Erfolg nach Dialogwechsel - jeder Erfolgsweg schliesst nur mit dem Kontext von VOR der Anfrage (#1997)', async () => {
  const wege = [
    ['Abo speichern', () => page.saveSubscription(formular(ABO_FORM), abo())],
    ['Monatsbudget', async () => {
      const panel = formular({ '#subscriptions-base-currency': 'EUR', '#subscriptions-budget': '50' });
      globalThis.__openModal = (opts) => opts.onSave(panel);
      try {
        await page.openSettingsModal();
        await panel.querySelector('#subscriptions-settings-form').handlers.submit({ preventDefault() {} });
      } finally {
        delete globalThis.__openModal;
      }
    }],
    ['Verwalten: anlegen', async () => {
      const panel = verwalten({ '#subscription-new-category': 'Musik' });
      let opened = 0;
      globalThis.__openModal = (opts) => { opened += 1; if (opened === 1) opts.onSave(panel); };
      try {
        page.openMetadataModal();
        await panel.querySelector('#subscription-add-category').handlers.click();
      } finally {
        delete globalThis.__openModal;
      }
    }],
  ];
  for (const [name, lauf] of wege) {
    let kontext = 'eigener-dialog';
    globalThis.__modalContextId = () => kontext;
    const wechsel = async (antwort) => { kontext = 'ein-anderer-dialog'; return antwort; };
    try {
      const { closed } = await mitSeite(() => mit({
        put: () => wechsel({ data: abo() }),
        post: () => wechsel({ data: { id: 99, name: 'Musik' } }),
      }, lauf));
      assert.equal(closed.length, 1, `${name}: genau ein Schliessen`);
      assert.equal(closed[0].force, true, `${name}: force wie bisher`);
      assert.equal(closed[0].context, 'eigener-dialog',
        `${name}: geschlossen wird ohne den Kontext von vor der Anfrage - die spaete Antwort traefe den Dialog, der jetzt offen ist`);
    } finally {
      delete globalThis.__modalContextId;
    }
  }
});

test('Seite: Verwalten-Erfolg - neu aufgebaut nur, wenn der eigene Dialog noch offen war (#1997)', async () => {
  for (const [eigenerOffen, erwartet] of [[true, 2], [false, 1]]) {
    const panel = verwalten({ '#subscription-new-category': 'Musik' });
    let opened = 0;
    globalThis.__openModal = (opts) => { opened += 1; if (opened === 1) opts.onSave(panel); };
    globalThis.__isOwnModalOpen = () => eigenerOffen;
    try {
      await mitSeite(() => mit({ post: async () => ({ data: { id: 99, name: 'Musik' } }) }, async () => {
        page.openMetadataModal();
        await panel.querySelector('#subscription-add-category').handlers.click();
      }));
    } finally {
      delete globalThis.__openModal;
      delete globalThis.__isOwnModalOpen;
    }
    assert.equal(opened, erwartet, eigenerOffen
      ? 'der eigene Dialog wird nach dem Speichern nicht mehr neu aufgebaut'
      : 'der Neuaufbau ersetzt den Dialog, den der Nutzer inzwischen geoeffnet hat');
  }
});

test('Seite: Verwalten-Erfolg - oeffnet der Nutzer WAEHREND des Ladens danach einen anderen Dialog, wird nicht neu aufgebaut (#1997)', async () => {
  // Codex an #2021: der eigene Dialog war beim Schliessen noch offen, das
  // Laden danach dauert - was der Nutzer in dieser Zeit oeffnet, ersetzte
  // openMetadataModal() sonst samt Eingabe.
  const panel = verwalten({ '#subscription-new-category': 'Musik' });
  let opened = 0;
  let kontext = 'nach-dem-schliessen';
  globalThis.__modalContextId = () => kontext;
  globalThis.__openModal = (opts) => { opened += 1; if (opened === 1) opts.onSave(panel); };
  try {
    await mitSeite(() => mit({
      post: async () => ({ data: { id: 99, name: 'Musik' } }),
      get: (path) => { if (path === '/budget/subscriptions/meta') kontext = 'ein-anderer-dialog'; return undefined; },
    }, async () => {
      page.openMetadataModal();
      await panel.querySelector('#subscription-add-category').handlers.click();
    }));
  } finally {
    delete globalThis.__openModal;
    delete globalThis.__modalContextId;
  }
  assert.equal(opened, 1, 'der Neuaufbau ersetzt den Dialog, der waehrend des Ladens aufging');
});
