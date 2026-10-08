/**
 * Modul: Uebersicht - welche Einkaufslisten die Einkaufs-Kachel zeigt (#1818, aus D#1624)
 * Zweck: Die Kachel zeigte die drei zuletzt geaenderten Listen mit Offenem, und
 *        welche das sind, war keine Wahl. Seit #1818 bietet der Optionen-Dialog
 *        der Kachel "alle Listen" (nichts gespeichert, Verhalten wie zuvor) oder
 *        eine Auswahl bestimmter Listen, je Person. Geprueft wird der ganze Weg:
 *
 *        1. Route: `shopping_list` waehlt VOR dem Deckel und zaehlt in der
 *           Auswahl; ohne Parameter ist die Antwort wie zuvor. Eine gewaehlte
 *           Liste steht auch ohne Offenes da. Geloeschte und erfundene Ids
 *           fallen weg; bleibt keine uebrig, antwortet die Route wie ohne
 *           Parameter - nie leer, nie ein Fehler. Wer Einkauf nicht sehen darf,
 *           bekommt die leere Fassung, was immer der Parameter nennt.
 *        2. Ablage: die Auswahl geht durch `PUT /preferences`, gehoert der
 *           Person und reist mit der Haushaltsvorgabe.
 *        3. Browser: die Anfrage traegt die Auswahl nur bei sichtbarer Kachel
 *           und gilt als Filter der Zahlen; der Dialog zeigt die Listen, hakt
 *           die gespeicherten an und speichert nur eine echte Auswahl; die
 *           Kachel zeichnet eine leere gewaehlte Liste, ohne sich zu verzaehlen.
 *
 * Ausfuehren: npm run test:dashboard-shopping-selection
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { register } from 'node:module';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

register('./test-browser-loader.mjs', import.meta.url);

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'dashboard-shopping-selection-test-secret';

const { resolvePermissions, buildSessionModuleAccess } = await import('../server/permissions.js');
const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: dashboardRouter, normalizeShoppingListFilter } = await import('../server/routes/dashboard.js');
const { default: preferencesRouter } = await import('../server/routes/preferences.js');
const { dashboardPaths } = await import('../server/openapi/paths/dashboard.js');
const widgets = await import('../public/utils/dashboard-widgets.js');

function buildMigratedDatabase(migrations) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) {
    if (typeof migration.up === 'function') migration.up(database);
    else database.exec(migration.up);
    if (typeof migration.afterUp === 'function') migration.afterUp(database);
    database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
      .run(migration.version, migration.description);
  }
  return database;
}

const moduleDatabase = get();
const db = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(db);
moduleDatabase.close();

const addUser = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
  VALUES (?, ?, 'hash', '#7C3AED', ?, ?)
`);
const ADMIN = Number(addUser.run(`shop-admin-${randomUUID()}`, 'Anna', 'admin', 'parent').lastInsertRowid);
const LEO = Number(addUser.run(`shop-leo-${randomUUID()}`, 'Leo', 'member', 'child').lastInsertRowid);

let currentUser = ADMIN;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const user = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(currentUser);
  req.authUserId = user.id;
  req.authRole = user.role;
  req.session = { userId: user.id, role: user.role };
  req.sessionModuleAccess = buildSessionModuleAccess(resolvePermissions(db, user));
  next();
});
app.use('/preferences', preferencesRouter);
app.use('/', dashboardRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

async function getJson(path) {
  const res = await fetch(`${base}${path}`);
  assert.equal(res.status, 200, `${path}: ${res.status}`);
  return res.json();
}

// --------------------------------------------------------------------------
// Die Saat: fuenf Listen. Vier mit Offenem, in dieser Reihenfolge zuletzt
// geaendert (juengste zuerst): Drogerie, Baumarkt, Wocheneinkauf, Garten.
// "Fest" ist vollstaendig abgehakt - ohne Auswahl steht sie nie auf der Kachel.
// --------------------------------------------------------------------------
const insertList = db.prepare('INSERT INTO shopping_lists (name, created_by, updated_at) VALUES (?, ?, ?)');
const insertItem = db.prepare('INSERT INTO shopping_items (list_id, name, is_checked) VALUES (?, ?, ?)');
function addList(name, updatedAt, open, done = 0) {
  const id = Number(insertList.run(name, ADMIN, updatedAt).lastInsertRowid);
  for (let i = 0; i < open; i += 1) insertItem.run(id, `${name} offen ${i + 1}`, 0);
  for (let i = 0; i < done; i += 1) insertItem.run(id, `${name} erledigt ${i + 1}`, 1);
  // KEIN nachtraegliches UPDATE: `trg_shopping_lists_updated_at` schreibt bei
  // jeder Aenderung der Liste "jetzt" hinein und ebnete die Saat ein.
  return id;
}
const GARTEN = addList('Garten', '2026-10-01T08:00:00Z', 1);
const WOCHE = addList('Wocheneinkauf', '2026-10-02T08:00:00Z', 8, 2);
const BAUMARKT = addList('Baumarkt', '2026-10-03T08:00:00Z', 2);
const DROGERIE = addList('Drogerie', '2026-10-04T08:00:00Z', 3);
const FEST = addList('Fest', '2026-10-05T08:00:00Z', 0, 4);

const names = (body) => body.shoppingLists.map((list) => list.name);
const numbers = (body) => [body.shoppingOpenCount, body.shoppingOpenLists];
const query = (...ids) => `/?${ids.map((id) => `shopping_list=${id}`).join('&')}`;

// --------------------------------------------------------------------------
// 1. Die Route
// --------------------------------------------------------------------------

test('ohne shopping_list bleibt die Antwort wie zuvor: drei Listen mit Offenem, die juengste zuerst', async () => {
  const body = await getJson('/');
  assert.deepEqual(names(body), ['Drogerie', 'Baumarkt', 'Wocheneinkauf']);
  assert.deepEqual(numbers(body), [14, 4], 'gezaehlt wird ueber alle Listen');
  assert.ok(!names(body).includes('Fest'), 'eine ganz abgehakte Liste steht ohne Auswahl nicht da');
});

test('mit Auswahl stehen nur die gewaehlten Listen da - auch wenn eine andere juenger ist', async () => {
  const body = await getJson(query(GARTEN, WOCHE));
  // Garten ist die aelteste der vier und stand ohne Auswahl hinter dem Deckel.
  assert.deepEqual(names(body), ['Wocheneinkauf', 'Garten']);
  assert.deepEqual(numbers(body), [9, 2], 'und die Zahlen zaehlen in der Auswahl');
  assert.deepEqual(body.shoppingLists[0].items.length, 6, 'der Deckel von sechs Artikeln bleibt');
});

test('eine einzelne Liste: der Parameter als einzelner Wert', async () => {
  const body = await getJson(query(GARTEN));
  assert.deepEqual(names(body), ['Garten']);
  assert.deepEqual(numbers(body), [1, 1]);
});

test('eine gewaehlte Liste ohne Offenes bleibt stehen, hinter denen mit Offenem', async () => {
  // "Fest" ist die juengste Liste - ohne die Regel "Offenes zuerst" stuende
  // sie vorn und draengte am Deckel eine volle Liste hinaus.
  const body = await getJson(query(FEST, GARTEN));
  assert.deepEqual(names(body), ['Garten', 'Fest']);
  const fest = body.shoppingLists.find((list) => list.name === 'Fest');
  assert.deepEqual([fest.open_count, fest.total_count, fest.items.length], [0, 4, 0]);
  assert.deepEqual(numbers(body), [1, 1], 'gezaehlt werden offene Artikel und Listen MIT Offenem');

  const only = await getJson(query(FEST));
  assert.deepEqual(names(only), ['Fest'], 'auch allein: die Kachel ist nicht leer');
  assert.deepEqual(numbers(only), [0, 0]);
});

test('der Deckel von drei Listen bleibt: vier gewaehlte, Offenes zuerst', async () => {
  const body = await getJson(query(FEST, GARTEN, WOCHE, BAUMARKT, DROGERIE));
  assert.deepEqual(names(body), ['Drogerie', 'Baumarkt', 'Wocheneinkauf']);
  assert.deepEqual(numbers(body), [14, 4]);
});

test('eine geloeschte Liste in der Auswahl faellt weg, die uebrigen bleiben', async () => {
  const gone = addList('Wird geloescht', '2026-10-06T08:00:00Z', 2);
  assert.deepEqual(names(await getJson(query(gone, GARTEN))), ['Wird geloescht', 'Garten']);
  db.prepare('DELETE FROM shopping_lists WHERE id = ?').run(gone);
  const body = await getJson(query(gone, GARTEN));
  assert.deepEqual(names(body), ['Garten']);
  assert.deepEqual(numbers(body), [1, 1]);
});

test('ist JEDE gewaehlte Liste geloescht, antwortet die Route wie ohne Auswahl - nie leer', async () => {
  const gone = addList('Auch geloescht', '2026-10-07T08:00:00Z', 1);
  db.prepare('DELETE FROM shopping_lists WHERE id = ?').run(gone);
  const plain = await getJson('/');
  const body = await getJson(query(gone));
  assert.deepEqual(names(body), names(plain));
  assert.deepEqual(numbers(body), numbers(plain));
  assert.deepEqual(names(body), ['Drogerie', 'Baumarkt', 'Wocheneinkauf']);
});

test('was keine Id ist oder keine Liste nennt, antwortet wie kein Parameter - nie mit einem Fehler', async () => {
  const plain = await getJson('/');
  const outside = [
    'shopping_list=', 'shopping_list=abc', 'shopping_list=0', 'shopping_list=-1', 'shopping_list=1.5',
    'shopping_list=1e3', 'shopping_list=%201', 'shopping_list=999999', 'shopping_list=99999999999999999999',
    `shopping_list=${GARTEN}abc`, 'shopping_list=1%20OR%201=1', "shopping_list=1'--",
    // Klammer-Schreibweisen: je nach Query-Parser ein Objekt, ein Array oder
    // ein anderer Schluessel - der Browser schreibt sie nie, keine gilt.
    `shopping_list[a]=${GARTEN}`, `shopping_list[]=${GARTEN}`,
  ];
  for (const raw of outside) {
    const body = await getJson(`/?${raw}`);
    assert.deepEqual(names(body), names(plain), raw);
    assert.deepEqual(numbers(body), numbers(plain), raw);
  }
  // Unsinn NEBEN einer echten Id: die echte gilt.
  assert.deepEqual(names(await getJson(`/?shopping_list=abc&shopping_list=${GARTEN}&shopping_list=999999`)), ['Garten']);
});

test('normalizeShoppingListFilter: positive ganze Zahlen, ohne Doppelte, hoechstens 50', () => {
  assert.deepEqual(normalizeShoppingListFilter(undefined), []);
  assert.deepEqual(normalizeShoppingListFilter('7'), [7]);
  assert.deepEqual(normalizeShoppingListFilter(['7', '3', '7']), [7, 3]);
  assert.deepEqual(normalizeShoppingListFilter(['7', 'abc', '', '0', '-1', '07', '1.5', { a: '1' }, 4]), [7]);
  assert.deepEqual(normalizeShoppingListFilter({ a: '1' }), []);
  assert.equal(normalizeShoppingListFilter(Array.from({ length: 80 }, (_, i) => String(i + 1))).length, 50);
});

test('wer Einkauf nicht sehen darf, bekommt die leere Fassung - mit und ohne Auswahl', async () => {
  const lock = () => db.prepare(`
    INSERT OR REPLACE INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', 'shopping', 'none')
  `).run(String(LEO));
  const unlock = () => db.prepare("DELETE FROM access_permissions WHERE subject_type = 'user' AND subject_id = ?").run(String(LEO));
  currentUser = LEO;
  try {
    // Gegenprobe ohne Sperre: Leo sieht die gewaehlte Liste - sonst sagte die
    // leere Antwort unten nichts ueber die Sperre.
    assert.deepEqual(names(await getJson(query(GARTEN))), ['Garten']);
    lock();
    assert.equal(resolvePermissions(db, db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(LEO)).modules.shopping, 'none',
      'Vorbedingung: der Einkauf ist fuer Leo gesperrt');
    for (const path of ['/', query(GARTEN), query(GARTEN, WOCHE, FEST)]) {
      const body = await getJson(path);
      assert.deepEqual(body.shoppingLists, [], path);
      assert.deepEqual(numbers(body), [0, 0], path);
      assert.ok(!JSON.stringify(body).includes('Garten'), `${path}: kein Listenname in der Antwort`);
    }
  } finally {
    unlock();
    currentUser = ADMIN;
  }
});

test('OpenAPI beschreibt den Parameter', () => {
  const parameter = dashboardPaths()['/api/v1/dashboard'].get.parameters.find((item) => item.name === 'shopping_list');
  assert.ok(parameter);
  assert.equal(parameter.in, 'query');
  assert.equal(parameter.schema.type, 'array');
  assert.equal(parameter.schema.items.type, 'integer');
  assert.equal(parameter.schema.items.minimum, 1);
  assert.equal(parameter.schema.maxItems, 50);
});

// --------------------------------------------------------------------------
// 2. Die Ablage: je Person, mit Haushaltsvorgabe
// --------------------------------------------------------------------------

const readPrefs = async () => (await getJson('/preferences')).data;
async function writePrefs(body) {
  const res = await fetch(`${base}/preferences`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return res.status;
}
function clearDashboardPreferences() {
  db.prepare(`
    DELETE FROM sync_config
    WHERE key IN ('dashboard_widgets', 'dashboard_widgets_default')
       OR key LIKE 'dashboard_widgets:user:%'
  `).run();
}
const shoppingTile = (options, visible = true) => [{ id: 'shopping', visible, order: 0, size: '1x2', ...(options ? { options } : {}) }];
const shoppingOptions = (config) => config.find((w) => w.id === 'shopping')?.options;

test('die Auswahl ueberlebt das Speichern, gehoert der Person und aendert nichts fuer die andere', async () => {
  clearDashboardPreferences();
  try {
    currentUser = ADMIN;
    assert.equal(await writePrefs({ dashboard_widgets: shoppingTile({ lists: [GARTEN, WOCHE] }) }), 200);
    const mine = (await readPrefs()).dashboard_widgets;
    assert.deepEqual(shoppingOptions(mine), { lists: [GARTEN, WOCHE] });
    assert.equal(widgets.dashboardQuery(mine), `/dashboard?shopping_list=${GARTEN}&shopping_list=${WOCHE}`);
    // Der ganze Weg: gespeicherte Anordnung -> Anfrage -> Antwort.
    assert.deepEqual(names(await getJson(widgets.dashboardQuery(mine).replace('/dashboard', '/'))), ['Wocheneinkauf', 'Garten']);

    currentUser = LEO;
    const theirs = (await readPrefs()).dashboard_widgets;
    assert.deepEqual(theirs, [], 'Leos Anordnung bleibt unberuehrt');
    assert.deepEqual(names(await getJson(widgets.dashboardQuery(theirs).replace('/dashboard', '/'))),
      ['Drogerie', 'Baumarkt', 'Wocheneinkauf'], 'und Leo sieht weiter alle Listen');
  } finally {
    currentUser = ADMIN;
    clearDashboardPreferences();
  }
});

test('die Vorgabe des Haushalts traegt die Auswahl, eine eigene Anordnung loest sie ab', async () => {
  clearDashboardPreferences();
  try {
    currentUser = ADMIN;
    assert.equal(await writePrefs({ dashboard_widgets_default: shoppingTile({ lists: [DROGERIE] }) }), 200);
    currentUser = LEO;
    assert.deepEqual(shoppingOptions((await readPrefs()).dashboard_widgets), { lists: [DROGERIE] });
    assert.equal(await writePrefs({ dashboard_widgets: shoppingTile() }), 200);
    assert.equal(shoppingOptions((await readPrefs()).dashboard_widgets), undefined);
  } finally {
    currentUser = ADMIN;
    clearDashboardPreferences();
  }
});

// --------------------------------------------------------------------------
// 3. Der Browser: Anfrage, Dialog, Kachel
// --------------------------------------------------------------------------

test('dashboardQuery: die Auswahl reist als wiederholter Parameter, und nur bei sichtbarer Kachel', () => {
  const q = (options, visible) => widgets.dashboardQuery(shoppingTile(options, visible));
  assert.equal(q(undefined), '/dashboard');
  assert.equal(q({ lists: [] }), '/dashboard', 'keine Auswahl heisst alle und steht in keiner Anfrage');
  assert.equal(q({ lists: [7] }), '/dashboard?shopping_list=7');
  assert.equal(q({ lists: [7, 3] }), '/dashboard?shopping_list=7&shopping_list=3');
  assert.equal(q({ lists: ['7', 7, 'abc', 0, -2, 1.5, null] }), '/dashboard?shopping_list=7', 'Fremdwerte im Layout werden nicht zur Anfrage');
  assert.equal(q({ lists: 'alle' }), '/dashboard');
  // Ausgeblendet spricht das Heute-Blatt fuer den Einkauf und zaehlt ueber alle
  // Listen: die Auswahl einer versteckten Kachel darf diese Zahl nicht kuerzen.
  assert.equal(q({ lists: [7] }, false), '/dashboard');
});

test('die Auswahl gilt als Filter der Zahlen: die Navigation holt ihre eigenen', () => {
  // `shoppingOpenCount` speist die Badge der Navigation. Mit Auswahl ist es
  // eine andere Zahl - die Allowlist der zahl-neutralen Parameter darf den
  // Parameter NICHT enthalten, sonst zeigte die Navigation die gefilterte.
  assert.equal(widgets.dashboardQueryFiltersCounts('/dashboard?shopping_list=7'), true);
  assert.equal(widgets.dashboardQueryFiltersCounts('/dashboard'), false);
});

const { __test: dash } = await import('../public/pages/dashboard.js');

/** Den Dialog oeffnen, ohne DOM: der Stub faengt Inhalt und Speichern-Handler. */
async function openShoppingDialog(current, { lists, picked = [] }) {
  let content = null;
  let submit = null;
  const toasts = [];
  const prev = { open: globalThis.__openModal, close: globalThis.__closeModal, window: globalThis.window };
  const field = (selector) => {
    if (selector === '[data-action="cancel"]') return { addEventListener() {} };
    if (selector === '#widget-options-form') return { addEventListener: (_type, handler) => { submit = handler; } };
    return null;
  };
  globalThis.window = { yuvomi: { showToast: (message, type) => toasts.push([message, type]) } };
  globalThis.__openModal = (config) => {
    content = config.content;
    config.onSave({
      querySelector: field,
      querySelectorAll: (selector) => (selector === 'input[name="shopping-list"]:checked' ? picked.map((value) => ({ value: String(value) })) : []),
    });
  };
  globalThis.__closeModal = () => true;
  try {
    const result = dash.openWidgetOptions('shopping', current, { loadLists: async () => lists });
    await Promise.resolve();
    await Promise.resolve();
    if (content === null) return { content, saved: await result, toasts };
    assert.equal(typeof submit, 'function', 'der Dialog hat keinen Speichern-Handler verdrahtet');
    submit({ preventDefault() {} });
    return { content, saved: await result, toasts };
  } finally {
    globalThis.__openModal = prev.open;
    globalThis.__closeModal = prev.close;
    globalThis.window = prev.window;
  }
}
const choices = (content) => [...content.matchAll(/<input type="checkbox" name="shopping-list" value="(\d+)"\s+(checked)?>\s*<span>([^<]*)<\/span>/g)]
  .map((m) => ({ id: Number(m[1]), checked: Boolean(m[2]), name: m[3] }));
const CATALOG = [{ id: 1, name: 'Wocheneinkauf' }, { id: 7, name: 'Drogerie & "Bad"' }, { id: 9, name: 'Baumarkt' }];

test('die Einkaufs-Kachel hat Optionen', async () => {
  const { setPermissions, clearPermissions } = await import('../public/permissions.js');
  const prevWindow = globalThis.window;
  globalThis.window = { yuvomi: { isModuleDisabled: () => false }, matchMedia: () => ({ matches: false }) };
  setPermissions({ admin: true, modules: {}, widgets: {}, capabilities: {} });
  try {
    const layout = (id) => dash.renderDashboardLayout([{ id, visible: true, order: 0, size: '1x2' }], { shoppingLists: [] }, null, 'EUR', { editing: true });
    assert.match(layout('shopping'), /data-widget-options="shopping"/);
    // Reichweite der Probe: eine Kachel OHNE Optionen traegt den Knopf nicht.
    assert.doesNotMatch(layout('birthdays'), /data-widget-options=/);
  } finally {
    clearPermissions();
    globalThis.window = prevWindow;
  }
});

test('Dialog: jede Liste ist waehlbar, ohne Auswahl ist nichts angehakt', async () => {
  const { content } = await openShoppingDialog({}, { lists: CATALOG });
  assert.deepEqual(choices(content), [
    { id: 1, checked: false, name: 'Wocheneinkauf' },
    { id: 7, checked: false, name: 'Drogerie &amp; &quot;Bad&quot;' },
    { id: 9, checked: false, name: 'Baumarkt' },
  ]);
  assert.match(content, /dashboard\.optionShoppingLists</, 'die Gruppe traegt ihre Ueberschrift ueber t()');
  assert.match(content, /dashboard\.optionShoppingListsHint/, 'und sagt, was "ohne Auswahl" heisst');
});

test('Dialog: die gespeicherte Auswahl ist angehakt, eine geloeschte Liste hat keine Zeile mehr', async () => {
  const { content } = await openShoppingDialog({ lists: [7, 404, '9'] }, { lists: CATALOG, picked: [7, 9] });
  assert.deepEqual(choices(content).filter((c) => c.checked).map((c) => c.id), [7, 9]);
  assert.ok(!/value="404"/.test(content));
});

test('Dialog: gespeichert wird nur eine echte Auswahl, als Zahlen', async () => {
  assert.deepEqual((await openShoppingDialog({}, { lists: CATALOG, picked: [7, 9] })).saved, { lists: [7, 9] });
  assert.deepEqual((await openShoppingDialog({ lists: [7] }, { lists: CATALOG, picked: [] })).saved, {},
    'alles abgewaehlt heisst wieder "alle Listen" - nichts wird gespeichert');
  // Die geloeschte Liste 404 stand im Layout; mit dem Speichern ist sie fort.
  assert.deepEqual((await openShoppingDialog({ lists: [7, 404] }, { lists: CATALOG, picked: [7] })).saved, { lists: [7] });
});

test('Dialog: ohne Listen sagt er das, statt eine leere Gruppe zu zeigen', async () => {
  const { content, saved } = await openShoppingDialog({}, { lists: [] });
  assert.deepEqual(choices(content), []);
  assert.match(content, /dashboard\.noShoppingLists/);
  assert.deepEqual(saved, {});
});

test('Dialog: scheitert der Katalog, geht er nicht auf und die Auswahl bleibt', async () => {
  // `null` heisst fuer den Aufrufer "nichts aendern". Ein Dialog ohne Katalog
  // haette beim Speichern `{}` geliefert und die Auswahl still geloescht.
  const { content, saved, toasts } = await openShoppingDialog({ lists: [7] }, { lists: null });
  assert.equal(content, null);
  assert.equal(saved, null);
  assert.deepEqual(toasts, [['dashboard.loadError', 'danger']]);
});

test('Kachel: eine gewaehlte Liste ohne Offenes sagt, dass nichts offen ist, und bleibt der Weg zu ihr', () => {
  const lists = [
    { id: 3, name: 'Garten', open_count: 1, total_count: 1, items: [{ id: 30, name: 'Erde' }] },
    { id: 5, name: 'Fest', open_count: 0, total_count: 4, items: [] },
  ];
  const html = dash.renderShoppingLists(lists, 1, 1);
  const rows = html.split('class="shopping-widget-list"').slice(1);
  assert.equal(rows.length, 2);
  assert.ok(!/shoppingListNothingOpen/.test(rows[0]), 'eine Liste mit Offenem traegt den Satz nicht');
  assert.match(rows[1], /dashboard\.shoppingListNothingOpen/);
  assert.match(rows[1], />4\/4</, 'der Zaehler der Zeile sagt weiter erledigt/gesamt');
  assert.match(html, /data-route="\/shopping\?list=5"/, 'die leere Liste ist einen Tipp entfernt');
  // Die leere gezeigte Liste zaehlt nicht als "weitere Liste" - der Server
  // zaehlt nur Listen mit Offenem, und die eine ist schon gezeigt.
  assert.ok(!/shoppingMoreLists/.test(html));
  assert.ok(!/widget__empty/.test(html), 'kein Leerzustand: die Kachel zeigt ihre Auswahl');
});

test('Kachel: ohne Auswahl bleibt "+n weitere Listen" wie zuvor', () => {
  const lists = [1, 2, 3].map((id) => ({ id, name: `L${id}`, open_count: 2, total_count: 2, items: [] }));
  assert.match(dash.renderShoppingLists(lists, 14, 5), /dashboard\.shoppingMoreLists\{&quot;count&quot;:2\}/);
  assert.ok(!/shoppingMoreLists/.test(dash.renderShoppingLists(lists, 6, 3)));
});
