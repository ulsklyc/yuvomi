/**
 * Tests: die Fehler von Inventar, Notizen, Kontakten und Geburtstagen (#1909)
 * Module: server/routes/inventory/*, server/routes/notes.js,
 *         server/services/note-categories.js, server/routes/contacts.js,
 *         server/routes/birthdays.js; public/pages/inventory.js, notes.js,
 *         contacts.js, birthdays.js
 *
 * Der Server nennt den Fall (`reason`), die Seite sagt den Satz der App - nie
 * den des Servers. Sagt der Grund, dass es das Ziel der Handlung nicht mehr
 * gibt (ein anderes Haushaltsmitglied hat es geloescht), faellt es aus dem
 * Stand der Seite, und der Dialog der Handlung geht zu. Fehlt nur etwas im
 * Formular GEWAEHLTES (Ort, Kategorie, vorgemerkte Buchung), bleibt das
 * Formular offen und bietet den aktuellen Stand an.
 *
 * LOESCHEN AUF "GIBT ES NICHT MEHR" IST EIN ERFOLG: keines der vier Module
 * kennt eine Sichtbarkeit, die 404 heisst nur "schon geloescht".
 *
 * Gefahren wird auf beiden Seiten der ECHTE Code:
 * - Server: die echten Router ueber einer migrierten In-Memory-DB.
 * - Seite: die echten Handler bis in ihr catch, ueber den api-Stub des Loaders
 *   (`__apiStub`), den Modal-Stub (`__openModal`, `__closeModal`) und den
 *   Ruecknahme-Stub (`__undoStub`).
 *
 * Ausfuehren: npm run test:inventory-notes-errors
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'inventory-notes-errors-test-secret';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
globalThis.localStorage = globalThis.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
const { installMiniDom } = await import('./mini-dom.js');
installMiniDom();
const toasts = [];
globalThis.window.yuvomi = { ...globalThis.window.yuvomi, showToast: (text, kind) => { toasts.push([text, kind]); } };
globalThis.window.matchMedia = globalThis.window.matchMedia
  ?? (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
globalThis.matchMedia ??= globalThis.window.matchMedia;
// Online: der Satz einer Ladestoerung haengt daran (loadErrorSentence).
Object.defineProperty(globalThis, 'navigator', { value: { ...globalThis.navigator, onLine: true }, configurable: true, writable: true });

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: inventoryRouter } = await import('../server/routes/inventory/index.js');
const { default: notesRouter } = await import('../server/routes/notes.js');
const { default: contactsRouter } = await import('../server/routes/contacts.js');
const { default: birthdaysRouter } = await import('../server/routes/birthdays.js');
const { setPermissions } = await import('../public/permissions.js');
const { __test: inventory } = await import('../public/pages/inventory.js');
const { __test: notes } = await import('../public/pages/notes.js');
const { __test: contacts } = await import('../public/pages/contacts.js');
const { __test: birthdays } = await import('../public/pages/birthdays.js');
const { CASE_MESSAGES, GONE_REASONS } = await import('../public/utils/friendly-error.js');

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function buildTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
  for (const m of MIGRATIONS) {
    if (typeof m.up === 'function') m.up(db); else db.exec(m.up);
    if (typeof m.afterUp === 'function') m.afterUp(db);
    db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(m.version, m.description);
  }
  return db;
}

const moduleDb = get();
const db = buildTestDb();
_setTestDatabase(db);
moduleDb.close();
test.after(() => db.close());
const admin = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('ada', 'Ada', '$2b$12$x', 'admin')`).run().lastInsertRowid;

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use((req, _res, next) => {
  req.authUserId = admin;
  req.authRole = 'admin';
  req.session = { userId: admin, role: 'admin' };
  next();
});
app.use('/api/v1/inventory', inventoryRouter);
app.use('/api/v1/notes', notesRouter);
app.use('/api/v1/contacts', contactsRouter);
app.use('/api/v1/birthdays', birthdaysRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
test.after(() => new Promise((r) => server.close(r)));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const GONE = 999999;

function expectCase(r, status, reason, label) {
  assert.equal(r.status, status, `${label}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body?.reason, reason, `${label}: ${JSON.stringify(r.body)}`);
  // Der Text bleibt fuer API-Aufrufer und Protokolle - englisch.
  assert.doesNotMatch(String(r.body?.error), /nicht gefunden|Notiz|Kontakt/, `${label}: deutscher Text`);
}

function insertEntry() {
  return db.prepare(`INSERT INTO budget_entries (title, amount, category, date, created_by, owner_id, visibility)
    VALUES ('Laptop', -899, 'food', '2030-01-10', ?, ?, 'shared')`).run(admin, admin).lastInsertRowid;
}

async function itemRow(extra = {}) {
  const r = await call('POST', '/inventory/items', { name: 'Espressomaschine', ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
}

test('Server/Inventar: ein Gegenstand, den es nicht mehr gibt - jeder Schreibweg nennt inventory_item_not_found', async () => {
  for (const [method, path, body] of [
    ['GET', `/inventory/items/${GONE}`, null],
    ['PUT', `/inventory/items/${GONE}`, { name: 'x' }],
    ['DELETE', `/inventory/items/${GONE}`, null],
    ['POST', `/inventory/items/${GONE}/entries`, { entry_id: 1 }],
    ['DELETE', `/inventory/items/${GONE}/entries/1`, null],
    ['POST', `/inventory/items/${GONE}/dates/1/complete`, { performed_on: '2026-10-01' }],
  ]) {
    expectCase(await call(method, path, body), 404, 'inventory_item_not_found', `${method} ${path}`);
  }
});

test('Server/Inventar: Frist weg, Buchung weg, Buchung schon verknuepft', async () => {
  const item = await itemRow();
  expectCase(await call('POST', `/inventory/items/${item.id}/dates/${GONE}/complete`, { performed_on: '2026-10-01' }),
    404, 'inventory_tracked_date_not_found', 'Frist erledigen');
  expectCase(await call('POST', `/inventory/items/${item.id}/entries`, { entry_id: GONE }),
    404, 'inventory_booking_not_found', 'verknuepfen');
  expectCase(await call('DELETE', `/inventory/items/${item.id}/entries/${GONE}`),
    404, 'inventory_booking_not_found', 'loesen');
  expectCase(await call('POST', '/inventory/items', { name: 'Neu', entry_id: GONE }),
    404, 'inventory_booking_not_found', 'anlegen mit vorgemerkter Buchung');
  const entry = insertEntry();
  const first = await call('POST', `/inventory/items/${item.id}/entries`, { entry_id: entry });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  expectCase(await call('POST', `/inventory/items/${item.id}/entries`, { entry_id: entry }),
    409, 'inventory_booking_already_linked', 'zweimal verknuepfen');
});

test('Server/Inventar: der gewaehlte Ort ist weg - ein Grund nur, wenn er der einzige Befund ist', async () => {
  expectCase(await call('POST', '/inventory/items', { name: 'Neu', location_id: GONE }),
    400, 'inventory_selected_location_not_found', 'anlegen');
  const item = await itemRow();
  expectCase(await call('PUT', `/inventory/items/${item.id}`, { name: 'Neu', location_id: GONE }),
    400, 'inventory_selected_location_not_found', 'aendern');
  // Zwei Befunde: kein Grund - der Satz des einen waere fuer den anderen falsch.
  const both = await call('POST', '/inventory/items', { name: '', location_id: GONE });
  assert.deepEqual([both.status, both.body?.reason], [400, undefined]);
});

test('Server/Notizen: eine Notiz, die es nicht mehr gibt - aendern, anpinnen, abhaken, loeschen nennen notes_note_not_found, englisch', async () => {
  for (const [method, path, body] of [
    ['PUT', `/notes/${GONE}`, { content: 'x' }],
    ['PATCH', `/notes/${GONE}/pin`, {}],
    ['PATCH', `/notes/${GONE}/check`, { line: 0, checked: true }],
    ['DELETE', `/notes/${GONE}`, null],
  ]) {
    const r = await call(method, path, body);
    expectCase(r, 404, 'notes_note_not_found', `${method} ${path}`);
    assert.equal(r.body.error, 'Note not found.');
  }
});

test('Server/Notizen: eine gewaehlte Kategorie ist weg, eine neue gibt es schon', async () => {
  expectCase(await call('POST', '/notes', { content: 'x', category_ids: [GONE] }),
    400, 'notes_selected_category_not_found', 'anlegen');
  const note = await call('POST', '/notes', { content: 'x' });
  expectCase(await call('PUT', `/notes/${note.body.data.id}`, { content: 'y', category_ids: [GONE] }),
    400, 'notes_selected_category_not_found', 'aendern');
  assert.equal((await call('POST', '/notes/categories', { name: 'Haus' })).status, 201);
  expectCase(await call('POST', '/notes/categories', { name: 'Haus' }), 409, 'category_exists', 'Kategorie doppelt');
});

test('Server/Kontakte und Geburtstage: was es nicht mehr gibt, nennt seinen Grund, englisch', async () => {
  for (const [method, path, body] of [
    ['PUT', `/contacts/${GONE}`, { name: 'x' }],
    ['DELETE', `/contacts/${GONE}`, null],
  ]) {
    const r = await call(method, path, body);
    expectCase(r, 404, 'contacts_contact_not_found', `${method} ${path}`);
    assert.equal(r.body.error, 'Contact not found.');
  }
  for (const [method, path, body] of [
    ['PUT', `/birthdays/${GONE}`, { name: 'x' }],
    ['DELETE', `/birthdays/${GONE}`, null],
  ]) {
    expectCase(await call(method, path, body), 404, 'birthdays_birthday_not_found', `${method} ${path}`);
  }
});

test('Server/Inventar: Orte und Kategorien nennen "gibt es schon" und "gibt es nicht mehr", englisch', async () => {
  const keller = await call('POST', '/inventory/locations', { name: 'Keller' });
  assert.equal(keller.status, 201, JSON.stringify(keller.body));
  const id = keller.body.data.id;
  const sub = await call('POST', `/inventory/locations/${id}/subcategories`, { name: 'Regal' });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  for (const [method, path, body] of [
    ['POST', '/inventory/locations', { name: 'keller' }],
    ['POST', `/inventory/locations/${id}/subcategories`, { name: 'Regal' }],
  ]) {
    expectCase(await call(method, path, body), 409, 'inventory_location_exists', `${method} ${path}`);
  }
  for (const [method, path, body] of [
    ['PUT', `/inventory/locations/${GONE}`, { name: 'x' }],
    ['DELETE', `/inventory/locations/${GONE}`, null],
    ['POST', `/inventory/locations/${GONE}/subcategories`, { name: 'x' }],
    ['PUT', `/inventory/locations/${id}/subcategories/${GONE}`, { name: 'x' }],
    ['DELETE', `/inventory/locations/${id}/subcategories/${GONE}`, null],
  ]) {
    expectCase(await call(method, path, body), 404, 'inventory_location_not_found', `${method} ${path}`);
  }
  const werkzeug = await call('POST', '/inventory/categories', { name: 'Werkzeug' });
  assert.equal(werkzeug.status, 201, JSON.stringify(werkzeug.body));
  expectCase(await call('POST', '/inventory/categories', { name: 'Werkzeug' }), 409, 'category_exists', 'POST /inventory/categories');
  for (const [method, path, body] of [
    ['PUT', '/inventory/categories/weg', { name: 'x' }],
    ['DELETE', '/inventory/categories/weg', null],
  ]) {
    expectCase(await call(method, path, body), 404, 'inventory_category_not_found', `${method} ${path}`);
  }
});

test('Server/Kontakte: die gewaehlte Kategorie ist weg - ein Grund nur, wenn sie der einzige Befund ist', async () => {
  const r = await call('POST', '/contacts', { name: 'Ada', category: 'weg' });
  expectCase(r, 400, 'contacts_selected_category_not_found', 'POST /contacts');
  assert.doesNotMatch(r.body.error, /Kategorie/, 'deutscher Feldname');
  // Zwei Befunde: der Grund wuerde einen davon verschweigen.
  const zwei = await call('POST', '/contacts', { name: '', category: 'weg' });
  assert.equal(zwei.status, 400);
  assert.equal(zwei.body.reason, undefined);
  const bea = await call('POST', '/contacts', { name: 'Bea' });
  assert.equal(bea.status, 201, JSON.stringify(bea.body));
  expectCase(await call('PUT', `/contacts/${bea.body.data.id}`, { category: 'weg' }), 400, 'contacts_selected_category_not_found', 'PUT /contacts/:id');
  // Ohne Kategorie im Rumpf ist nichts gewaehlt - und nichts verschwunden.
  const ok = await call('PUT', `/contacts/${bea.body.data.id}`, { notes: 'x' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

const SERVER_REASONS = [
  'inventory_item_not_found', 'inventory_tracked_date_not_found', 'inventory_selected_location_not_found',
  'inventory_booking_not_found', 'inventory_booking_already_linked',
  'inventory_location_exists', 'inventory_location_not_found', 'inventory_category_not_found',
  'notes_note_not_found', 'notes_selected_category_not_found',
  'contacts_contact_not_found', 'contacts_selected_category_not_found', 'birthdays_birthday_not_found',
];

test('jeder Grund dieser Module hat einen Satz, und jeder "gibt es nicht mehr" ist als solcher bekannt', () => {
  for (const reason of SERVER_REASONS) {
    assert.ok(CASE_MESSAGES.has(reason), `${reason}: kein Satz`);
    assert.equal(GONE_REASONS.has(reason), reason.endsWith('_not_found'), `${reason}: GONE_REASONS`);
  }
  assert.deepEqual([...CASE_MESSAGES.keys()].filter((r) => /^(inventory|notes|contacts|birthdays)_/.test(r)).sort(),
    [...SERVER_REASONS].sort(), 'ein Grund in CASE_MESSAGES, den kein Server dieser Suite nennt');
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

const assertNoServerText = () => {
  for (const [text] of toasts) assert.doesNotMatch(String(text), /Server sentence/, 'der Text des Servers im Toast');
};

/** Eine angezeigte Seite, in der nichts zu zeichnen ist. */
const shownPage = () => ({ querySelector: () => null, querySelectorAll: () => [], isConnected: true });

/**
 * Mit einem api-Stub laufen lassen. `calls` schreibt jede Anfrage mit,
 * `closed` jedes Schliessen eines Dialogs.
 */
async function mit(antworten, lauf) {
  toasts.length = 0;
  const calls = [];
  const closed = [];
  const stub = {
    get: async (path) => { calls.push(['GET', path]); return antworten.get?.(path) ?? { data: [] }; },
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
  return { calls, closed };
}

/**
 * Ein Formular-Element: merkt Wert, Fokus, Handler und neu gebaute Optionen.
 * Jede andere Methode, die ein Handler am Element ruft, tut nichts.
 */
function feld(wert = '') {
  const el = {
    value: wert, checked: false, disabled: false, hidden: false, textContent: '', html: null, focused: 0, clicked: 0,
    dataset: {}, style: {}, handlers: {}, isConnected: true,
    focus() { this.focused += 1; },
    click() { this.clicked += 1; this.handlers.click?.({ target: this, preventDefault() {} }); },
    replaceChildren() { this.html = ''; },
    insertAdjacentHTML(_where, html) { this.html = (this.html ?? '') + html; },
    addEventListener(type, fn) { this.handlers[type] = fn; },
    setAttribute() {}, removeAttribute() {}, appendChild() {}, remove() {}, closest: () => null,
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    querySelector: () => null, querySelectorAll: () => [],
  };
  // Jede andere Methode (prepend, scrollIntoView, ...) tut nichts.
  return new Proxy(el, {
    get: (target, prop) => (prop in target || typeof prop === 'symbol' || prop === 'then' ? target[prop] : () => {}),
  });
}

function formular(werte = {}, { ohne = [] } = {}) {
  const gemerkt = new Map();
  return {
    dataset: {}, isConnected: true, handlers: {},
    addEventListener(type, fn) { this.handlers[type] = fn; },
    querySelectorAll: () => [],
    closest: () => null,
    querySelector(selector) {
      if (ohne.includes(selector)) return null;
      if (!gemerkt.has(selector)) gemerkt.set(selector, feld(werte[selector] ?? ''));
      return gemerkt.get(selector);
    },
  };
}

// --- Inventar --------------------------------------------------------------

const gegenstand = (extra = {}) => ({ id: 5, name: 'Espressomaschine', category: 'other', tracked_dates: [], ...extra });

async function mitInventar(fn) {
  const s = inventory.state;
  const zuvor = { items: s.items, locations: s.locations, categories: s.categories };
  Object.assign(s, { items: [gegenstand(), gegenstand({ id: 6, name: 'Bohrer' })], locations: [{ id: 1, name: 'Keller', subcategories: [] }], categories: [] });
  inventory.setContainerForTest(shownPage());
  try {
    return await fn();
  } finally {
    Object.assign(s, zuvor);
    inventory.setContainerForTest(null);
  }
}

test('Inventar: speichern - der Fall wird sein Satz; ein verschwundener Gegenstand faellt aus der Liste und das Formular geht zu', async () => {
  for (const [err, expected, art] of [
    [fehler(404, 'inventory_item_not_found'), 'inventory.errorItemGone', 'gone'],
    [fehler(400, 'inventory_selected_location_not_found'), 'inventory.errorSelectedLocationGone', 'location'],
    [fehler(404, 'inventory_booking_not_found'), 'inventory.errorBookingGone', 'booking'],
    [fehler(403, 'module_read_only'), 'settings.permReadOnlyBanner', 'stay'],
    [fehler(400), 'common.errorGeneric', 'stay'],
    [fehler(500), 'common.errorGeneric', 'stay'],
  ]) {
    const panel = formular({ '#inv-name': 'Espressomaschine', '#inv-location': '1' });
    const { closed, calls } = await mitInventar(() => mit({
      put: async () => { throw err; },
      get: (path) => (path === '/inventory/locations' ? { data: [{ id: 2, name: 'Dachboden', subcategories: [] }] } : { data: [] }),
    }, () => inventory.saveItem(panel, 'edit', gegenstand(), null, null, null)));
    const label = `${err.status} ${err.data.reason ?? ''}`;
    assert.deepEqual(toasts, [[expected, 'danger']], label);
    assertNoServerText();
    assert.equal(closed.length, art === 'gone' ? 1 : 0, `${label}: geschlossen`);
    if (art === 'gone') assert.equal(closed[0].context, 'test-modal-context', 'nur der eigene Dialog');
    const select = panel.querySelector('#inv-location');
    if (art === 'location') {
      assert.ok(calls.some(([verb, path]) => verb === 'GET' && path === '/inventory/locations'), 'die Orte kommen frisch');
      assert.match(select.html, /value="2"/, 'der aktuelle Ort steht zur Wahl');
      assert.doesNotMatch(select.html, /value="1"/, 'der geloeschte nicht mehr');
      assert.equal(select.value, '');
      assert.equal(select.focused, 1);
    } else {
      assert.equal(select.html, null, `${label}: die Ortsauswahl bleibt`);
    }
    assert.equal(panel.querySelector('[data-clear-picked-booking]').clicked, art === 'booking' ? 1 : 0, `${label}: Vormerkung`);
    assert.equal(panel.querySelector('#inv-save').disabled, false, `${label}: der Knopf ist wieder frei`);
  }
});

test('Inventar: der verschwundene Gegenstand faellt aus dem Stand, ohne die Liste neu zu holen', async () => {
  await mitInventar(async () => {
    const { calls } = await mit({ put: async () => { throw fehler(404, 'inventory_item_not_found'); } },
      () => inventory.saveItem(formular({ '#inv-name': 'x' }), 'edit', gegenstand(), null, null, null));
    assert.deepEqual(inventory.state.items.map((i) => i.id), [6]);
    assert.equal(calls.filter(([verb]) => verb === 'GET').length, 0);
  });
});

test('Inventar: loeschen - "schon geloescht" ist ein Erfolg; alles andere sagt den Satz der App', async () => {
  for (const [err, expected] of [
    [fehler(404, 'inventory_item_not_found'), [['inventory.deleted', 'success']]],
    [fehler(404), [['common.errorGeneric', 'danger']]],
    [fehler(500), [['common.errorGeneric', 'danger']]],
  ]) {
    await mitInventar(() => mit({ delete: async () => { throw err; } }, () => inventory.removeItem(gegenstand())));
    assert.deepEqual(toasts, expected, `${err.status} ${err.data.reason ?? ''}`);
    assertNoServerText();
  }
});

test('Inventar: eine Frist erledigen - Gegenstand oder Frist weg schliesst die Karte, sonst bleibt sie', async () => {
  for (const [err, expected, schliesst] of [
    [fehler(404, 'inventory_item_not_found'), 'inventory.errorItemGone', true],
    [fehler(404, 'inventory_tracked_date_not_found'), 'inventory.errorTrackedDateGone', true],
    [fehler(400), 'common.errorGeneric', false],
  ]) {
    const panel = formular({ '#inv-complete-date': '2026-10-01' });
    let ergebnis;
    const { closed, calls } = await mitInventar(() => mit({ post: async () => { throw err; } }, async () => {
      globalThis.__openModal = (opts) => { opts.onSave(panel); };
      try {
        ergebnis = inventory.openCompletionSheet(gegenstand(), { id: 3, label: 'TUeV' });
        await panel.querySelector('#inv-complete-save').handlers.click();
      } finally {
        delete globalThis.__openModal;
      }
    }));
    const label = `${err.status} ${err.data.reason ?? ''}`;
    assert.deepEqual(toasts, [[expected, 'danger']], label);
    assertNoServerText();
    assert.equal(closed.length, schliesst ? 1 : 0, `${label}: geschlossen`);
    if (schliesst) assert.equal(await ergebnis, false, `${label}: nichts erledigt`);
    const reload = calls.some(([verb, path]) => verb === 'GET' && path === '/inventory/items');
    assert.equal(reload, err.data.reason === 'inventory_tracked_date_not_found', `${label}: Gegenstaende frisch`);
  }
});

// --- Notizen ---------------------------------------------------------------

async function mitNotizen(fn) {
  const s = notes.state;
  const zuvor = { notes: s.notes };
  s.notes = [{ id: 5, content: 'Milch', pinned: 0 }, { id: 6, content: 'Brot', pinned: 0 }];
  notes.setContainerForTest(shownPage());
  try {
    return await fn();
  } finally {
    s.notes = zuvor.notes;
    notes.setContainerForTest(null);
  }
}

test('Notizen: anpinnen - der Fall wird sein Satz, eine verschwundene Notiz faellt aus dem Stand', async () => {
  for (const [err, expected, faellt] of [
    [fehler(404, 'notes_note_not_found'), 'notes.errorNoteGone', true],
    [fehler(500), 'common.errorGeneric', false],
  ]) {
    await mitNotizen(async () => {
      await mit({ patch: async () => { throw err; } }, () => notes.togglePin(5));
      assert.deepEqual(toasts, [[expected, 'danger']]);
      assertNoServerText();
      assert.deepEqual(notes.state.notes.map((n) => n.id), faellt ? [6] : [5, 6]);
    });
  }
});

test('Notizen: loeschen mit Ruecknahme - "schon geloescht" ist ein Erfolg ohne Toast; alles andere stellt zurueck', async () => {
  for (const [err, expectedToasts, restored] of [
    [fehler(404, 'notes_note_not_found'), [], false],
    [fehler(500), [['common.errorGeneric', 'danger']], true],
  ]) {
    await mitNotizen(async () => {
      let opts = null;
      await mit({ delete: async () => { throw err; } }, async () => {
        globalThis.__undoStub = (o) => { opts = o; };
        try { notes.deleteNote(5); } finally { delete globalThis.__undoStub; }
        toasts.length = 0;
        try { await opts.commit({ keepalive: false }); } catch (e) { opts.restore(e); }
      });
      assert.deepEqual(toasts, expectedToasts, `${err.status}`);
      assertNoServerText();
      assert.equal(notes.state.notes.some((n) => n.id === 5), restored);
    });
  }
});

// --- Kontakte --------------------------------------------------------------

async function mitKontakten(fn) {
  const s = contacts.state;
  const zuvor = { contacts: s.contacts, selected: s.selected };
  s.contacts = [{ id: 5, name: 'Ada' }, { id: 6, name: 'Bea' }];
  contacts.setContainerForTest(shownPage());
  try {
    return await fn();
  } finally {
    Object.assign(s, zuvor);
    contacts.setContainerForTest(null);
  }
}

test('Kontakte: loeschen mit Ruecknahme - "schon geloescht" ist ein Erfolg; alles andere stellt zurueck und sagt den Satz der App', async () => {
  for (const [err, expectedToasts, restored] of [
    [fehler(404, 'contacts_contact_not_found'), [], false],
    [fehler(403, 'family_member_contact'), [['common.errorNoPermission', 'danger']], true],
    [fehler(500), [['common.errorGeneric', 'danger']], true],
  ]) {
    await mitKontakten(async () => {
      let opts = null;
      await mit({ delete: async () => { throw err; } }, async () => {
        globalThis.__undoStub = (o) => { opts = o; };
        try { contacts.deleteContact(5); } finally { delete globalThis.__undoStub; }
        try { await opts.commit({ keepalive: false }); } catch (e) { opts.restore(e); }
      });
      assert.deepEqual(toasts, expectedToasts, `${err.status} ${err.data.reason ?? ''}`);
      assertNoServerText();
      assert.equal(contacts.state.contacts.some((c) => c.id === 5), restored);
    });
  }
});

test('Kontakte: mehrere loeschen - ein schon geloeschter zaehlt als geloescht, die anderen gehen durch', async () => {
  await mitKontakten(async () => {
    contacts.state.selected = new Set([5, 6]);
    let opts = null;
    const deleted = [];
    await mit({
      delete: async (path) => {
        if (path === '/contacts/5') throw fehler(404, 'contacts_contact_not_found');
        deleted.push(path);
        return null;
      },
    }, async () => {
      globalThis.__undoStub = (o) => { opts = o; };
      try { await contacts.deleteSelected(); } finally { delete globalThis.__undoStub; }
      try { await opts.commit({ keepalive: false }); } catch (e) { opts.restore(e); }
    });
    assert.deepEqual(toasts, []);
    assert.deepEqual(deleted, ['/contacts/6']);
    assert.deepEqual(contacts.state.contacts.map((c) => c.id), []);
  });
});

// --- Geburtstage -----------------------------------------------------------

async function mitGeburtstagen(fn) {
  const s = birthdays.state;
  const zuvor = { birthdays: s.birthdays };
  s.birthdays = [{ id: 5, name: 'Ada', birth_date: '1990-01-01', days_until: 3 }, { id: 6, name: 'Bea', birth_date: '1991-01-01', days_until: 4 }];
  birthdays.setContainerForTest(shownPage());
  try {
    return await fn();
  } finally {
    s.birthdays = zuvor.birthdays;
    birthdays.setContainerForTest(null);
  }
}

test('Geburtstage: loeschen mit Ruecknahme - "schon geloescht" ist ein Erfolg; alles andere stellt zurueck und sagt den Satz der App', async () => {
  for (const [err, expectedToasts, restored] of [
    [fehler(404, 'birthdays_birthday_not_found'), [], false],
    [fehler(500), [['common.errorGeneric', 'danger']], true],
  ]) {
    await mitGeburtstagen(async () => {
      let opts = null;
      await mit({ delete: async () => { throw err; } }, async () => {
        globalThis.__undoStub = (o) => { opts = o; };
        try { birthdays.deleteBirthday(5); } finally { delete globalThis.__undoStub; }
        try { await opts.commit({ keepalive: false }); } catch (e) { opts.restore(e); }
      });
      assert.deepEqual(toasts, expectedToasts, `${err.status} ${err.data.reason ?? ''}`);
      assertNoServerText();
      assert.equal(birthdays.state.birthdays.some((b) => b.id === 5), restored);
    });
  }
});

test('Geburtstage: die Kontakte zum Import laden nicht - der Satz der Stelle oder der Fall, nie der Text des Servers', async () => {
  for (const [err, expected] of [
    [fehler(500), 'common.errorServer'],
    [fehler(400), 'common.errorGeneric'],
    [fehler(403, 'cross_module_access'), 'common.errorNoPermission'],
  ]) {
    await mitGeburtstagen(() => mit({ get: () => { throw err; } }, () => birthdays.openImportModal()));
    assert.deepEqual(toasts, [[expected, 'danger']], `${err.status}`);
    assertNoServerText();
  }
});

// --- Formulare: speichern auf etwas, das es nicht mehr gibt -----------------

/** Einen Dialog oeffnen und sein Formular verdrahten lassen. */
async function oeffne(panel, lauf) {
  globalThis.__openModal = (opts) => { opts.onSave(panel); };
  try {
    await lauf();
  } finally {
    delete globalThis.__openModal;
  }
}

test('Notizen: speichern - eine verschwundene Notiz schliesst den Editor; eine verschwundene Kategorie laesst ihn offen und raeumt die Auswahl', async () => {
  for (const [err, expected, art] of [
    [fehler(404, 'notes_note_not_found'), 'notes.errorNoteGone', 'gone'],
    [fehler(400, 'notes_selected_category_not_found'), 'notes.errorSelectedCategoryGone', 'category'],
    [fehler(409, 'notes_selected_category_not_found'), 'notes.errorSelectedCategoryGone', 'category'],
    [fehler(500), 'common.errorGeneric', 'stay'],
  ]) {
    await mitNotizen(async () => {
      notes.state.categories = [{ id: 1, name: 'Haus', scope: 'household' }, { id: 2, name: 'Weg', scope: 'household' }];
      const panel = formular({ '#note-content': 'Milch' }, { ohne: ['.note-mode-switch'] });
      // Zwei gewaehlte Kategorien; die zweite gibt es am Server nicht mehr.
      const chips = [1, 2].map((id) => Object.assign(feld(), { dataset: { selectedCategoryId: String(id) }, removed: false, remove() { this.removed = true; } }));
      const choices = panel.querySelector('#note-category-choices');
      choices.querySelectorAll = (selector) => (selector.includes('selected-category-id') ? chips.filter((c) => !c.removed) : []);
      const { closed, calls } = await mit({
        put: async () => { throw err; },
        get: (path) => (path === '/notes/categories' ? { data: [{ id: 1, name: 'Haus', scope: 'household' }], meta: {} } : { data: [] }),
      }, async () => {
        await oeffne(panel, () => notes.openNoteModal({ mode: 'edit', note: notes.state.notes[0] }));
        await panel.querySelector('#note-modal-save').handlers.click();
      });
      const label = `${err.status} ${err.data.reason ?? ''}`;
      assert.deepEqual(toasts, [[expected, 'danger']], label);
      assertNoServerText();
      assert.equal(closed.length, art === 'gone' ? 1 : 0, `${label}: geschlossen`);
      assert.deepEqual(notes.state.notes.map((n) => n.id), art === 'gone' ? [6] : [5, 6], `${label}: Stand`);
      const frisch = calls.some(([verb, path]) => verb === 'GET' && path === '/notes/categories');
      assert.equal(frisch, art === 'category', `${label}: Kategorien frisch`);
      assert.deepEqual(chips.map((c) => c.removed), art === 'category' ? [false, true] : [false, false], `${label}: Auswahl`);
    });
  }
});

test('Kontakte: speichern - ein verschwundener Kontakt schliesst das Formular und faellt aus der Liste', async () => {
  for (const [err, expected, gone] of [
    [fehler(404, 'contacts_contact_not_found'), 'contacts.errorContactGone', true],
    [fehler(409, 'email_in_use'), 'common.emailInUse', false],
    [fehler(400), 'common.errorGeneric', false],
  ]) {
    await mitKontakten(async () => {
      const panel = formular({ '#cm-first-name': 'Ada', '#cm-last-name': 'Lovelace' });
      const { closed } = await mit({ put: async () => { throw err; } }, async () => {
        contacts.buildContactForm({ mode: 'edit', contact: contacts.state.contacts[0] }).wire(panel);
        await panel.querySelector('#cm-save').handlers.click();
      });
      const label = `${err.status} ${err.data.reason ?? ''}`;
      assert.deepEqual(toasts, [[expected, 'danger']], label);
      assertNoServerText();
      assert.equal(closed.length, gone ? 1 : 0, `${label}: geschlossen`);
      assert.deepEqual(contacts.state.contacts.map((c) => c.id), gone ? [6] : [5, 6], `${label}: Stand`);
    });
  }
});

test('Geburtstage: speichern - ein verschwundener Geburtstag schliesst das Formular und faellt aus der Liste', async () => {
  for (const [err, expected, gone] of [
    [fehler(404, 'birthdays_birthday_not_found'), 'birthdays.errorBirthdayGone', true],
    [fehler(400), 'common.errorGeneric', false],
  ]) {
    await mitGeburtstagen(async () => {
      const panel = formular({ '#bd-name': 'Ada', '#bd-birth-date': '1990-01-01' });
      const { closed } = await mit({ put: async () => { throw err; } }, async () => {
        await oeffne(panel, () => birthdays.openBirthdayModal({ mode: 'edit', birthday: birthdays.state.birthdays[0] }));
        await panel.querySelector('#bd-save').handlers.click();
      });
      const label = `${err.status} ${err.data.reason ?? ''}`;
      assert.deepEqual(toasts, [[expected, 'danger']], label);
      assertNoServerText();
      assert.equal(closed.length, gone ? 1 : 0, `${label}: geschlossen`);
      assert.deepEqual(birthdays.state.birthdays.map((b) => b.id), gone ? [6] : [5, 6], `${label}: Stand`);
    });
  }
});

test('Kontakte: speichern - eine verschwundene Kategorie laesst das Formular offen und bietet die aktuellen an', async () => {
  await mitKontakten(async () => {
    const zuvor = contacts.state.categories;
    contacts.state.categories = [{ key: 'misc', name: 'Sonstiges' }, { key: 'weg', name: 'Weg' }];
    try {
      const panel = formular({ '#cm-first-name': 'Ada', '#cm-last-name': 'Lovelace', '#cm-category': 'weg' });
      const { closed, calls } = await mit({
        put: async () => { throw fehler(400, 'contacts_selected_category_not_found'); },
        get: (path) => (path === '/contacts/categories' ? { data: [{ key: 'misc', name: 'Sonstiges' }] } : { data: [] }),
      }, async () => {
        contacts.buildContactForm({ mode: 'edit', contact: contacts.state.contacts[0] }).wire(panel);
        await panel.querySelector('#cm-save').handlers.click();
      });
      assert.deepEqual(toasts, [['contacts.errorSelectedCategoryGone', 'danger']]);
      assertNoServerText();
      assert.equal(closed.length, 0, 'das Formular bleibt offen');
      assert.ok(calls.some(([verb, path]) => verb === 'GET' && path === '/contacts/categories'), 'die Kategorien kommen frisch');
      assert.deepEqual(contacts.state.categories.map((c) => c.key), ['misc']);
      const select = panel.querySelector('#cm-category');
      assert.equal(select.value, 'misc', 'die Auswahl faellt auf eine, die es gibt');
      assert.match(select.html, /value="misc"/);
      assert.doesNotMatch(select.html, /value="weg"/, 'die verschwundene steht nicht mehr zur Wahl');
      assert.deepEqual(contacts.state.contacts.map((c) => c.id), [5, 6], 'der Kontakt bleibt');
    } finally {
      contacts.state.categories = zuvor;
    }
  });
});

test('Inventar: Orts- und Kategorie-Verwalter sagen den Satz der App und nehmen "schon geloescht" als Erfolg', async () => {
  for (const [open, reason] of [
    [inventory.openLocationManager, 'inventory_location_not_found'],
    [inventory.openCategoryManager, 'inventory_category_not_found'],
  ]) {
    let options = null;
    const manager = { addEventListener() {}, configure(o) { options = o; } };
    const panel = { querySelector: (sel) => (sel === 'yuvomi-category-manager' ? manager : null) };
    await oeffne(panel, () => open());
    assert.ok(options, `${reason}: der Verwalter wurde nicht eingerichtet`);
    assert.equal(options.errorFallbackKey, 'common.errorGeneric', `${reason}: ohne Rueckfall zeigt der Verwalter den Text des Servers`);
    assert.equal(options.alreadyDeletedReason, reason);
  }
});

// --- #1997: eine spaete Erfolgsantwort schliesst nur ihren EIGENEN Dialog ----

// Kommt die Antwort erst, nachdem der Nutzer den Dialog geschlossen und einen
// anderen geoeffnet hat, darf das force-Schliessen nur den eigenen treffen. Ob
// der Slot noch denselben Dialog haelt, entscheidet closeModal({ context }) in
// components/modal.js (am echten Modul gemessen in test-modal-dead-time.js);
// hier zaehlt die Verdrahtung: jeder Erfolgsweg reicht den Kontext von VOR der
// Anfrage hinein. Gefahren wird je Weg der echte Handler; die schreibende
// Anfrage wechselt den Kontext.
test('#1997: Erfolg nach Dialogwechsel - Inventar, Kontakte und Geburtstage schliessen nur mit dem Kontext von VOR der Anfrage', async () => {
  const ankreuzen = (value) => Object.assign(feld(String(value)), { checked: true });
  const mitListe = (panel, boxen) => Object.assign(panel, { querySelectorAll: () => boxen });
  const WEGE = [
    ['Inventar: Gegenstand anlegen', mitInventar, () => inventory.saveItem(formular({ '#inv-name': 'Bohrer', '#inv-location': '1' }), 'create', null, null, null, null)],
    ['Inventar: Gegenstand aendern', mitInventar, () => inventory.saveItem(formular({ '#inv-name': 'Bohrer', '#inv-location': '1' }), 'edit', gegenstand(), null, null, null)],
    ['Inventar: Frist erledigen', mitInventar, async () => {
      const panel = formular({ '#inv-complete-date': '2026-10-01' });
      await oeffne(panel, () => { inventory.openCompletionSheet(gegenstand(), { id: 3, label: 'TUeV' }); });
      await panel.querySelector('#inv-complete-save').handlers.click();
    }],
    ['Kontakte: anlegen', mitKontakten, async () => {
      const panel = formular({ '#cm-first-name': 'Ada', '#cm-last-name': 'Lovelace', '#cm-category': 'misc' });
      contacts.buildContactForm({ mode: 'create' }).wire(panel);
      await panel.querySelector('#cm-save').handlers.click();
    }],
    ['Kontakte: aendern', mitKontakten, async () => {
      const panel = formular({ '#cm-first-name': 'Ada', '#cm-last-name': 'Lovelace' });
      contacts.buildContactForm({ mode: 'edit', contact: contacts.state.contacts[0] }).wire(panel);
      await panel.querySelector('#cm-save').handlers.click();
    }],
    ['Kontakte: vCard-Import', mitKontakten, async () => {
      const panel = mitListe(formular(), [ankreuzen(0)]);
      await oeffne(panel, () => contacts.openImportSelectionModal([{ name: 'Cleo' }], 0));
      await panel.querySelector('#vcard-import-submit').handlers.click();
    }],
    ['Geburtstage: anlegen', mitGeburtstagen, async () => {
      const panel = formular({ '#bd-name': 'Cleo', '#bd-birth-date': '1992-02-02' });
      await oeffne(panel, () => birthdays.openBirthdayModal({ mode: 'create' }));
      await panel.querySelector('#bd-save').handlers.click();
    }],
    ['Geburtstage: aendern', mitGeburtstagen, async () => {
      const panel = formular({ '#bd-name': 'Ada', '#bd-birth-date': '1990-01-01' });
      await oeffne(panel, () => birthdays.openBirthdayModal({ mode: 'edit', birthday: birthdays.state.birthdays[0] }));
      await panel.querySelector('#bd-save').handlers.click();
    }],
    ['Geburtstage: aus Kontakten uebernehmen', mitGeburtstagen, async () => {
      const panel = mitListe(formular(), [ankreuzen(11)]);
      await oeffne(panel, () => birthdays.openImportModal());
      await panel.querySelector('#bd-import-submit').handlers.click();
    }],
  ];
  for (const [name, umgebung, lauf] of WEGE) {
    let kontext = 'eigener-dialog';
    const geschrieben = [];
    const schreibe = (verb) => (path) => {
      geschrieben.push(`${verb} ${path}`);
      kontext = 'ein-anderer-dialog';
      return { data: { id: 7, name: 'Cleo', imported: 1 } };
    };
    globalThis.__modalContextId = () => kontext;
    try {
      const { closed } = await umgebung(() => mit({
        post: schreibe('POST'), put: schreibe('PUT'),
        get: (path) => (path === '/birthdays/import/candidates'
          ? { data: { withBirthday: [{ id: 11, name: 'Cleo', birthday: '1992-02-02' }], withoutBirthday: [] } }
          : { data: [] }),
      }, lauf));
      assert.equal(geschrieben.length, 1, `${name}: der Weg schreibt (${JSON.stringify(geschrieben)})`);
      assert.equal(toasts.some(([, art]) => art === 'danger'), false, `${name}: der Erfolg ist kein Fehler (${JSON.stringify(toasts)})`);
      assert.equal(closed.length, 1, `${name}: genau ein Schliessen (${JSON.stringify(closed)})`);
      assert.equal(closed[0].force, true, `${name}: force wie bisher`);
      assert.equal(closed[0].context, 'eigener-dialog',
        `${name}: geschlossen wird ohne den Kontext von vor der Anfrage - die spaete Antwort traefe den Dialog, der jetzt offen ist`);
    } finally {
      delete globalThis.__modalContextId;
    }
  }
});
