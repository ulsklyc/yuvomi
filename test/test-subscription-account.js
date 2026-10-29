/**
 * Tests: Konto und Sichtbarkeit am Abo (#1277, #1701)
 * Module: server/routes/subscriptions.js, server/routes/budget/accounts.js,
 *         public/pages/subscriptions.js
 *
 * #1277 - EIN KONTO AM ABO als Vorgabe fuer jede Buchung, die es bucht. Die
 * Buchung der naechsten Zahlung folgt dem Abo (Anlegen, Aendern, Verlaengern);
 * eine bezahlte Buchung ist danach eine gewoehnliche Buchung, ein spaeteres
 * Aendern des Abos fasst sie nicht an.
 *
 * ENTSCHEIDUNG (Ulas): Ist das gewaehlte Konto archiviert, bucht das Abo ohne
 * Konto und sagt es ruhig am Abo. Archivieren und Zurueckholen eines Kontos
 * ziehen die wartende Buchung nach; Loeschen leert die Vorgabe.
 *
 * #1701 - DIE SICHTBARKEIT im Abo-Dialog, unter derselben Bedingung wie im
 * Buchungsdialog (persoenlicher Budget-Modus) und mit derselben Vorauswahl
 * fuer ein neues Abo ("geteilt", wie budget.js).
 *
 * Gefahren wird auf beiden Seiten der ECHTE Code: der Server ueber einer
 * migrierten In-Memory-DB, die Seite ueber den api- und Modal-Stub des
 * Loaders.
 *
 * Ausfuehren: npm run test:subscription-account
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'subscription-account-test-secret';
delete process.env.FIXER_API_KEY;

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
globalThis.localStorage = globalThis.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
const { installMiniDom } = await import('./mini-dom.js');
installMiniDom();
globalThis.window.yuvomi = { ...globalThis.window.yuvomi, showToast: () => true };
globalThis.window.matchMedia = globalThis.window.matchMedia
  ?? (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));

const dbmod = await import('../server/db.js');
const subscriptions = await import('../server/routes/subscriptions.js');
const { default: budgetRouter } = await import('../server/routes/budget.js');
const { setPermissions } = await import('../public/permissions.js');
const { __test: page } = await import('../public/pages/subscriptions.js');
const { CASE_MESSAGES } = await import('../public/utils/friendly-error.js');

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
app.use('/api/v1/budget/subscriptions', subscriptions.default);
app.use('/api/v1/budget', budgetRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
test.after(() => new Promise((r) => server.close(r)));
const base = `http://127.0.0.1:${server.address().port}/api/v1/budget`;

async function call(method, path, body, as = ADA) {
  actor = { id: as, role: as === ADA ? 'admin' : 'member' };
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const ABO = { name: 'Gym', amount: 30, currency: 'EUR', billing_cycle: 'monthly', next_payment_date: '2030-01-15' };
async function account(name, extra = {}) {
  const r = await call('POST', '/accounts', { name, type: 'checking', starting_balance: 0, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data.id;
}
async function sub(extra = {}, as = ADA) {
  const r = await call('POST', '/subscriptions', { ...ABO, ...extra }, as);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
}
const entry = (id) => db.prepare('SELECT id, account_id, visibility, owner_id, date FROM budget_entries WHERE id = ?').get(id);
const row = (id) => db.prepare('SELECT * FROM budget_subscriptions WHERE id = ?').get(id);

test.beforeEach(() => {
  setMode('shared');
  db.prepare('DELETE FROM budget_subscriptions').run();
  db.prepare('DELETE FROM budget_entries').run();
  db.prepare('DELETE FROM budget_accounts').run();
});

test('Server: das Konto am Abo ist die Vorgabe der Buchung - Anlegen, Aendern, Leeren', async () => {
  const giro = await account('Giro');
  const karte = await account('Karte');
  const created = await sub({ account_id: giro });
  assert.equal(created.account_id, giro);
  assert.equal(created.account_name, 'Giro');
  assert.equal(created.account_archived, false);
  assert.equal(entry(created.budget_entry_id).account_id, giro, 'die wartende Buchung traegt das Konto');

  const moved = await call('PUT', `/subscriptions/${created.id}`, { account_id: karte });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(entry(moved.body.data.budget_entry_id).account_id, karte, 'die wartende Buchung folgt dem Abo');

  const kept = await call('PUT', `/subscriptions/${created.id}`, { name: 'Gym Plus' });
  assert.equal(kept.body.data.account_id, karte, 'ein PUT ohne account_id laesst das Konto stehen');

  const cleared = await call('PUT', `/subscriptions/${created.id}`, { account_id: null });
  assert.equal(cleared.body.data.account_id, null);
  assert.equal(entry(cleared.body.data.budget_entry_id).account_id, null);
});

test('Server: Verlaengern - die bezahlte Buchung behaelt ihr Konto, die naechste traegt das des Abos, ein spaeteres Aendern fasst die bezahlte nicht an', async () => {
  const giro = await account('Giro');
  const karte = await account('Karte');
  const created = await sub({ account_id: giro });
  const paidId = created.budget_entry_id;
  const renewed = await call('POST', `/subscriptions/${created.id}/renew`);
  assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
  const nextId = renewed.body.data.budget_entry_id;
  assert.notEqual(nextId, paidId);
  assert.equal(entry(paidId).account_id, giro);
  assert.equal(entry(nextId).account_id, giro);

  // Ein Monat, den jemand anderes bezahlt hat: die bezahlte Buchung umgestellt.
  db.prepare('UPDATE budget_entries SET account_id = ? WHERE id = ?').run(karte, paidId);
  await call('PUT', `/subscriptions/${created.id}`, { account_id: null });
  assert.equal(entry(paidId).account_id, karte, 'die bezahlte Buchung ist eine gewoehnliche Buchung');
  assert.equal(entry(nextId).account_id, null);
});

test('Server: ein archiviertes Konto - das Abo bucht ohne Konto und sagt es; Zurueckholen bucht wieder darauf', async () => {
  const giro = await account('Giro');
  const created = await sub({ account_id: giro });

  const archived = await call('PUT', `/accounts/${giro}`, { archived: true });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.equal(entry(created.budget_entry_id).account_id, null, 'Archivieren nimmt der wartenden Buchung das Konto');
  const list = await call('GET', '/subscriptions');
  const listed = list.body.data.subscriptions.find((s) => s.id === created.id);
  assert.equal(listed.account_id, giro, 'die Vorgabe bleibt stehen');
  assert.equal(listed.account_archived, true);

  const renewed = await call('POST', `/subscriptions/${created.id}/renew`);
  assert.equal(entry(created.budget_entry_id).account_id, null, 'die bezahlte Buchung ohne Konto');
  assert.equal(entry(renewed.body.data.budget_entry_id).account_id, null, 'die naechste auch');

  // Ein Bearbeiten bucht ebenfalls ohne Konto, solange es archiviert ist.
  const edited = await call('PUT', `/subscriptions/${created.id}`, { account_id: giro, name: 'Gym 2' });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.data.account_archived, true);
  assert.equal(entry(edited.body.data.budget_entry_id).account_id, null);

  await call('PUT', `/accounts/${giro}`, { archived: false });
  assert.equal(entry(edited.body.data.budget_entry_id).account_id, giro, 'Zurueckholen bucht die wartende wieder aufs Konto');
  assert.equal(entry(created.budget_entry_id).account_id, null, 'die bezahlte bleibt, wie sie ist');
});

test('Server: ein geloeschtes Konto leert die Vorgabe und die wartende Buchung', async () => {
  const giro = await account('Giro');
  const created = await sub({ account_id: giro });
  assert.equal(entry(created.budget_entry_id).account_id, giro, 'Vorbedingung: die Buchung traegt das Konto');
  const r = await call('DELETE', `/accounts/${giro}`);
  assert.equal(r.status, 204);
  assert.equal(row(created.id).account_id, null);
  assert.equal(entry(created.budget_entry_id).account_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_accounts WHERE id = ?').get(giro).n, 0, 'keine Huelle');
});

test('Server: ein Konto, das es nicht gibt - 400 mit reason, nichts geschrieben', async () => {
  const created = await sub();
  for (const [method, path] of [['POST', '/subscriptions'], ['PUT', `/subscriptions/${created.id}`]]) {
    const before = db.prepare('SELECT COUNT(*) AS n FROM budget_subscriptions').get().n;
    const r = await call(method, path, { ...ABO, account_id: 999999 });
    assert.equal(r.status, 400, `${method}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.reason, 'subscriptions_account_not_found');
    assert.match(r.body.error, /^[\x20-\x7e]+$/, 'englischer Satz fuer die API');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_subscriptions').get().n, before);
  }
  assert.equal(row(created.id).account_id, null);
  const bad = await call('POST', '/subscriptions', { ...ABO, account_id: 'abc' });
  assert.equal(bad.status, 400);
});

test('Server: privat und geteilt - die Buchung folgt der Sichtbarkeit, das Konto ist davon unabhaengig', async () => {
  setMode('personal');
  const giro = await account('Giro');
  const created = await sub({ account_id: giro, visibility: 'private' }, BEN);
  assert.equal(created.visibility, 'private');
  assert.deepEqual({ ...entry(created.budget_entry_id), id: 0, date: '' },
    { id: 0, date: '', account_id: giro, visibility: 'private', owner_id: BEN });
  const shared = await call('PUT', `/subscriptions/${created.id}`, { visibility: 'shared' }, BEN);
  assert.equal(entry(shared.body.data.budget_entry_id).visibility, 'shared');
});

test('Server: /meta nennt den Budget-Modus und die Konten - archivierte mit Kennzeichen, geloeschte nicht', async () => {
  const giro = await account('Giro');
  const alt = await account('Alt');
  await call('PUT', `/accounts/${alt}`, { archived: true });
  setMode('personal');
  const r = await call('GET', '/subscriptions/meta');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.budget_mode, 'personal');
  assert.deepEqual(r.body.data.accounts.map((a) => [a.id, a.name, a.archived]), [[giro, 'Giro', false], [alt, 'Alt', true]]);
  setMode('shared');
  assert.equal((await call('GET', '/subscriptions/meta')).body.data.budget_mode, 'shared');
});

// ---------------------------------------------------------------------------
// Seite
// ---------------------------------------------------------------------------

setPermissions({ admin: true, modules: {}, widgets: {}, capabilities: {} });

const META = {
  categories: [], payment_methods: [], billing_cycles: ['monthly', 'yearly'],
  budget_mode: 'personal',
  accounts: [{ id: 7, name: 'Giro', archived: false }, { id: 8, name: 'Altkonto', archived: true }],
};
const abo = (extra = {}) => ({
  id: 3, name: 'Gym', amount: 30, currency: 'EUR', billing_cycle: 'monthly', cycle_interval: 1,
  next_payment_date: '2030-01-15', enabled: true, status: 'active', visibility: 'shared',
  account_id: null, account_name: null, account_archived: false, ...extra,
});

function opened(subscription, meta = META) {
  const s = page.state;
  const zuvor = { meta: s.meta };
  s.meta = structuredClone(meta);
  let content = '';
  globalThis.__openModal = (opts) => { content = opts.content; };
  try {
    page.openSubscriptionModal(subscription);
  } finally {
    delete globalThis.__openModal;
    Object.assign(s, zuvor);
  }
  return content;
}
const selectBlock = (html, id) => String(html).split(`id="${id}"`)[1]?.split('</select>')[0] ?? '';
const options = (html, id) => [...selectBlock(html, id).matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)</g)]
  .map((m) => ({ value: m[1], selected: /selected/.test(m[2]), text: m[3].trim() }));
const selected = (html, id) => options(html, id).find((o) => o.selected)?.value;

test('Seite: Sichtbarkeit im persoenlichen Modus - neu auf geteilt (wie die Buchung), ein Bestand auf seiner Stufe; im geteilten Modus kein Feld', () => {
  assert.equal(selected(opened(null), 'subscription-visibility'), 'shared');
  assert.equal(selected(opened(abo({ visibility: 'private' })), 'subscription-visibility'), 'private');
  assert.deepEqual(options(opened(null), 'subscription-visibility').map((o) => o.value), ['private', 'shared']);
  assert.ok(!opened(null, { ...META, budget_mode: 'shared' }).includes('id="subscription-visibility"'));
});

test('Seite: Kontowahl - kein Konto und die aktiven; ein archiviertes nur, wenn es das gewaehlte ist, mit Hinweis', () => {
  const fresh = opened(null);
  assert.deepEqual(options(fresh, 'subscription-account-id').map((o) => o.value), ['', '7']);
  assert.equal(selected(fresh, 'subscription-account-id'), '');
  // Der Archiv-Hinweis steht nur, wenn ein archiviertes gewaehlt ist (sonst verborgen, fuer den Wechsel).
  const archivedHint = (html) => /id="subscription-account-id-archived"(?![^>]*hidden)[^>]*>subscriptions\.accountArchivedHint/.test(html);
  assert.ok(!archivedHint(fresh));

  const stale = opened(abo({ account_id: 8, account_name: 'Altkonto', account_archived: true }));
  assert.deepEqual(options(stale, 'subscription-account-id').map((o) => o.value), ['', '7', '8']);
  assert.equal(selected(stale, 'subscription-account-id'), '8');
  assert.ok(archivedHint(stale), 'der Hinweis unter dem Feld');
  assert.match(stale, /aria-describedby="[^"]*subscription-account-id-hint/);

  assert.ok(!opened(null, { ...META, accounts: [] }).includes('id="subscription-account-id"'), 'ohne Konten kein Feld');
});

test('Seite: Speichern schickt Konto und Sichtbarkeit - und im geteilten Modus keine Sichtbarkeit', async () => {
  const sent = [];
  const fields = {
    '#subscription-next-date': '2030-01-15', '#subscription-currency': 'EUR', '#subscription-end-type': 'never',
    '#subscription-amount': '30', '#subscription-name': 'Gym', '#subscription-cycle': 'monthly',
    '#subscription-interval': '1', '#subscription-reminder': '3',
  };
  const panelWith = (werte) => {
    const els = new Map();
    return {
      insertAdjacentHTML() {}, querySelectorAll: () => [],
      querySelector(sel) {
        if (!(sel in werte) && !sel.startsWith('#subscription-') && sel !== '[type="submit"]') return null;
        if ((sel === '#subscription-visibility' || sel === '#subscription-account-id') && !(sel in werte)) return null;
        if (!els.has(sel)) {
          els.set(sel, {
            value: werte[sel] ?? '', checked: false, disabled: false, files: [], dataset: {},
            addEventListener() {}, focus() {}, querySelector: () => null,
          });
        }
        return els.get(sel);
      },
    };
  };
  globalThis.__apiStub = {
    get: async (path) => (path.endsWith('/meta') ? { data: structuredClone(META) } : path.endsWith('/settings')
      ? { data: { monthly_budget: 0, base_currency: 'EUR' } } : { data: { subscriptions: [], summary: null, rates: null } }),
    post: async (path, body) => { sent.push(body); return { data: abo() }; },
    put: async (path, body) => { sent.push(body); return { data: abo() }; },
  };
  globalThis.__closeModal = () => true;
  const s = page.state;
  const zuvor = { meta: s.meta };
  try {
    s.meta = structuredClone(META);
    await page.saveSubscription(panelWith({ ...fields, '#subscription-visibility': 'private', '#subscription-account-id': '7' }), null);
    await page.saveSubscription(panelWith({ ...fields, '#subscription-visibility': 'shared', '#subscription-account-id': '' }), abo());
    s.meta = { ...structuredClone(META), budget_mode: 'shared', accounts: [] };
    await page.saveSubscription(panelWith(fields), abo({ account_id: 7 }));
  } finally {
    Object.assign(s, zuvor);
    delete globalThis.__apiStub;
    delete globalThis.__closeModal;
  }
  assert.equal(sent.length, 3);
  assert.equal(sent[0].visibility, 'private');
  assert.equal(sent[0].account_id, 7);
  assert.equal(sent[1].visibility, 'shared');
  assert.equal(sent[1].account_id, null);
  assert.ok(!('visibility' in sent[2]), 'geteilter Modus: der Server entscheidet');
  assert.ok(!('account_id' in sent[2]), 'ohne Kontofeld bleibt das Konto des Abos stehen');
});

test('Seite: die Zeile sagt ruhig, dass ein archiviertes Konto ohne Konto bucht - sonst nichts', () => {
  const stale = page.renderCard(abo({ account_id: 8, account_name: 'Altkonto', account_archived: true }));
  assert.ok(stale.includes('subscriptions.accountArchivedMeta'));
  const fine = page.renderCard(abo({ account_id: 7, account_name: 'Giro', account_archived: false }));
  assert.ok(!fine.includes('subscriptions.accountArchivedMeta'));
});

test('Seite: der Fall "Konto gibt es nicht mehr" hat seinen Satz', () => {
  assert.equal(CASE_MESSAGES.get?.('subscriptions_account_not_found') ?? CASE_MESSAGES.subscriptions_account_not_found,
    'subscriptions.errorAccountGone');
});

test('Seite: das gewaehlte Konto gibt es nicht mehr - der Dialog bleibt offen, die Seite laedt einmal, die Wahl kommt aus dem frischen Stand auf "Kein Konto"', async () => {
  const toasts = [];
  const zuvorToast = globalThis.window.yuvomi.showToast;
  globalThis.window.yuvomi.showToast = (text) => { toasts.push(text); return true; };
  const field = { html: '', removed: false, insertAdjacentHTML(_w, html) { this.html += html; }, remove() { this.removed = true; } };
  const select = { value: '7', focused: 0, addEventListener() {}, focus() { this.focused += 1; } };
  const els = new Map();
  const panel = {
    insertAdjacentHTML() {}, querySelectorAll: () => [],
    querySelector(sel) {
      if (sel === '[data-subscription-account-field]') return field.removed ? null : field;
      if (sel === '#subscription-account-id') return select;
      if (sel === '#subscription-visibility') return null;
      if (!els.has(sel)) {
        els.set(sel, { value: ({ '#subscription-next-date': '2030-01-15', '#subscription-currency': 'EUR', '#subscription-end-type': 'never',
          '#subscription-amount': '30', '#subscription-name': 'Gym', '#subscription-cycle': 'monthly', '#subscription-interval': '1',
          '#subscription-reminder': '3' })[sel] ?? '', checked: false, disabled: false, files: [], dataset: {},
        addEventListener() {}, focus() {}, querySelector: () => null });
      }
      return els.get(sel);
    },
  };
  const gets = [];
  let closed = 0;
  const fresh = { ...structuredClone(META), accounts: [{ id: 9, name: 'Neu', archived: false }] };
  globalThis.__apiStub = {
    get: async (path) => {
      gets.push(path);
      if (path.endsWith('/meta')) return { data: structuredClone(fresh) };
      if (path.endsWith('/settings')) return { data: { monthly_budget: 0, base_currency: 'EUR' } };
      return { data: { subscriptions: [], summary: null, rates: null } };
    },
    put: async () => {
      throw Object.assign(new Error('Server sentence.'), {
        name: 'ApiError', status: 400, data: { error: 'Account not found.', code: 400, reason: 'subscriptions_account_not_found' },
      });
    },
  };
  globalThis.__closeModal = () => { closed += 1; return true; };
  const container = { isConnected: true, querySelector: () => null, querySelectorAll: () => [] };
  const s = page.state;
  const zuvor = { meta: s.meta };
  s.meta = structuredClone(META);
  page.setContainerForTest(container);
  try {
    await page.saveSubscription(panel, abo({ account_id: 7 }));
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
  } finally {
    page.setContainerForTest(null);
    Object.assign(s, zuvor);
    delete globalThis.__apiStub;
    delete globalThis.__closeModal;
    globalThis.window.yuvomi.showToast = zuvorToast;
  }
  assert.deepEqual(toasts, ['subscriptions.errorAccountGone']);
  assert.equal(closed, 0, 'der Dialog bleibt offen');
  assert.equal(gets.filter((p) => p.endsWith('/meta')).length, 1, 'die Seite laedt einmal');
  assert.ok(field.removed, 'das alte Feld ist ersetzt');
  assert.deepEqual(options(field.html, 'subscription-account-id').map((o) => [o.value, o.selected]), [['', true], ['9', false]]);
  assert.equal(select.focused, 1);
});

// --- Nachtrag Review (Codex an #2312) ----------------------------------------

test('Server: die Folgezahlungen eines Abos tragen sein Konto - auch unter dem Kontofilter der Liste und der Zusammenfassung', async () => {
  const giro = await account('Giro');
  const karte = await account('Karte');
  await sub({ account_id: giro });
  // Die naechste Zahlung ist am 2030-01-15, der Februar ist nur erwartet.
  const all = await call('GET', '/?month=2030-02');
  assert.equal(all.status, 200, JSON.stringify(all.body));
  const expected = all.body.data.filter((e) => e.expected);
  assert.equal(expected.length, 1, 'Vorbedingung: eine erwartete Zahlung im Februar');
  assert.equal(expected[0].account_id, giro);
  const onGiro = await call('GET', `/?month=2030-02&account_id=${giro}`);
  assert.equal(onGiro.body.data.filter((e) => e.expected).length, 1, 'unter dem Konto steht sie');
  const onKarte = await call('GET', `/?month=2030-02&account_id=${karte}`);
  assert.equal(onKarte.body.data.filter((e) => e.expected).length, 0, 'unter einem anderen nicht');
  const sumGiro = await call('GET', `/summary?month=2030-02&account_id=${giro}`);
  assert.equal(sumGiro.status, 200, JSON.stringify(sumGiro.body));
  assert.equal(sumGiro.body.data.pending.count, 1, 'die Zusammenfassung zaehlt sie unter dem Konto');
  const sumKarte = await call('GET', `/summary?month=2030-02&account_id=${karte}`);
  assert.equal(sumKarte.body.data.pending.count, 0);
});

test('Server: ein Kontowechsel waehrend des Kursabrufs - ein Verlaengern dazwischen gibt die Zahlung mit dem NEUEN Konto ab', async () => {
  const giro = await account('Giro');
  const karte = await account('Karte');
  const answer = (base, list) => ({ rates: Object.fromEntries([[base, 1], ...list.map((c) => [c, 1])]), source: 'cache', fetchedAt: null });
  subscriptions._setRatesForTest(async (base, list) => answer(base, list));
  const created = await sub({ account_id: giro, currency: 'USD' });
  const pending = [];
  subscriptions._setRatesForTest(async (base, list) => {
    await new Promise((release) => pending.push(release));
    return answer(base, list);
  });
  try {
    const put = call('PUT', `/subscriptions/${created.id}`, { account_id: karte });
    for (let i = 0; i < 400 && pending.length < 1; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.equal(pending.length, 1, 'Vorbedingung: der PUT wartet auf den Kurs');
    const renew = call('POST', `/subscriptions/${created.id}/renew`);
    for (let i = 0; i < 400 && pending.length < 2; i += 1) await new Promise((r) => setTimeout(r, 5));
    subscriptions._setRatesForTest(async (base, list) => answer(base, list));
    for (const release of pending) release();
    const [p, r] = await Promise.all([put, renew]);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(entry(created.budget_entry_id).account_id, karte, 'die bezahlte Buchung traegt das neue Konto');
    assert.equal(entry(row(created.id).budget_entry_id).account_id, karte, 'die naechste auch');
  } finally {
    subscriptions._setRatesForTest(null);
  }
});

test('Server: eine einzeln umgestellte Zahlung zieht die Folgezahlungen nicht mit - sie stehen unter dem Konto des Abos, ein archiviertes ergibt keins', async () => {
  const giro = await account('Giro');
  const karte = await account('Karte');
  const created = await sub({ account_id: giro });
  db.prepare('UPDATE budget_entries SET account_id = ? WHERE id = ?').run(karte, created.budget_entry_id);
  const feb = (await call('GET', '/?month=2030-02')).body.data.filter((e) => e.expected);
  assert.equal(feb[0].account_id, giro, 'die Folgezahlung bucht das Verlaengern auf die Vorgabe');
  assert.equal((await call('GET', `/?month=2030-02&account_id=${karte}`)).body.data.filter((e) => e.expected).length, 0);
  assert.equal((await call('GET', `/summary?month=2030-02&account_id=${giro}`)).body.data.pending.count, 1);
  await call('PUT', `/accounts/${giro}`, { archived: true });
  assert.equal((await call('GET', '/?month=2030-02')).body.data.filter((e) => e.expected)[0].account_id, null);
  assert.equal((await call('GET', `/?month=2030-02&account_id=${giro}`)).body.data.filter((e) => e.expected).length, 0);
});
