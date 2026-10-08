/**
 * Modul: Uebersicht - welche Einkaufslisten die Einkaufs-Kachel zeigt (#1818, aus D#1624)
 * Zweck: Die Kachel zeigte die drei zuletzt geaenderten Listen mit Offenem, und
 *        welche das sind, war keine Wahl. Seit #1818 bietet der Optionen-Dialog
 *        der Kachel "alle Listen" (nichts gespeichert, Verhalten wie zuvor) oder
 *        eine Auswahl bestimmter Listen, je Person. Geprueft wird der ganze Weg:
 *
 *        1. Route: `shopping_list` fuellt ein EIGENES Feld (`shoppingTile`):
 *           die gewaehlten Listen vor dem Deckel, die offenen Artikel darin und
 *           die Zahl der gewaehlten Listen. Die geteilten Felder
 *           (`shoppingLists`, `shoppingOpenCount`, `shoppingOpenLists`) bleiben
 *           ungefiltert - die Auswahl gilt NUR der Kachel. Eine gewaehlte Liste
 *           steht auch ohne Offenes da. Geloeschte und erfundene Ids fallen
 *           weg; bleibt keine uebrig, antwortet die Route wie ohne Parameter -
 *           nie leer, nie ein Fehler. Wer Einkauf nicht sehen darf, bekommt die
 *           leere Fassung, was immer der Parameter nennt.
 *        2. Ablage: die Auswahl geht durch `PUT /preferences`, gehoert der
 *           Person und reist mit der Haushaltsvorgabe.
 *        3. Browser: die Anfrage traegt die Auswahl, der Parameter aendert
 *           keine Zahl der Navigation; der Dialog zeigt die Listen, hakt die
 *           gespeicherten an, speichert nur eine echte Auswahl, und sein echter
 *           Lader laesst bei einem Fehler die Auswahl stehen; die Kachel nennt
 *           eine abgeschnittene gewaehlte Liste als "+1".
 *        4. Heute-Blatt und Wand: mit gesetzter Auswahl dieselbe Zahl wie
 *           ohne, und zwar die des Servers ueber alle Listen.
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
/** Ein gekoppeltes Display: Methode und Scopes wie `requireAuth` sie setzt, sonst null. */
let displayScopes = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const user = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(currentUser);
  req.authUserId = user.id;
  req.authRole = user.role;
  req.session = { userId: user.id, role: user.role };
  req.sessionModuleAccess = buildSessionModuleAccess(resolvePermissions(db, user));
  if (displayScopes) { req.authMethod = 'display'; req.authScopes = displayScopes; }
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
/** Die Fassung der Kachel: Namen, offene Artikel in der Auswahl, gewaehlte Listen. */
const tileNames = (body) => body.shoppingTile?.lists.map((list) => list.name) ?? null;
const tileNumbers = (body) => (body.shoppingTile ? [body.shoppingTile.openCount, body.shoppingTile.listCount] : null);
const query = (...ids) => `/?${ids.map((id) => `shopping_list=${id}`).join('&')}`;
/** Was jeder ANDERE Leser sieht: die drei geteilten Felder, ganz. */
const shared = (body) => JSON.stringify([body.shoppingLists, body.shoppingOpenCount, body.shoppingOpenLists]);

// --------------------------------------------------------------------------
// 1. Die Route
// --------------------------------------------------------------------------

test('ohne shopping_list bleibt die Antwort wie zuvor: drei Listen mit Offenem, die juengste zuerst', async () => {
  const body = await getJson('/');
  assert.deepEqual(names(body), ['Drogerie', 'Baumarkt', 'Wocheneinkauf']);
  assert.deepEqual(numbers(body), [14, 4], 'gezaehlt wird ueber alle Listen');
  assert.ok(!names(body).includes('Fest'), 'eine ganz abgehakte Liste steht ohne Auswahl nicht da');
  assert.equal('shoppingTile' in body, false, 'ohne Auswahl gibt es keine eigene Kachel-Fassung');
});

test('mit Auswahl traegt die Kachel-Fassung nur die gewaehlten Listen - auch wenn eine andere juenger ist', async () => {
  const body = await getJson(query(GARTEN, WOCHE));
  // Garten ist die aelteste der vier und stand ohne Auswahl hinter dem Deckel.
  assert.deepEqual(tileNames(body), ['Wocheneinkauf', 'Garten']);
  assert.deepEqual(tileNumbers(body), [9, 2], 'und die Zahlen der Kachel zaehlen in der Auswahl');
  assert.deepEqual(body.shoppingTile.lists[0].items.length, 6, 'der Deckel von sechs Artikeln bleibt');
});

test('die Auswahl gilt NUR der Kachel: was Wand, Heute-Blatt und Navigation lesen, bleibt ungefiltert', async () => {
  // Der Fehler der ersten Fassung: die Auswahl filterte `shoppingLists` und
  // `shoppingOpenCount`. Das Wandtablet eines Haushalts, dessen Vorgabe eine
  // Liste waehlt, zeigte "1 offen" bei vierzehn - und mit nur der fertig
  // gekauften Liste verschwand die Zeile ganz.
  const plain = await getJson('/');
  for (const path of [query(GARTEN), query(FEST), query(GARTEN, WOCHE), query(FEST, GARTEN, WOCHE, BAUMARKT, DROGERIE)]) {
    const body = await getJson(path);
    assert.equal(shared(body), shared(plain), `${path}: die geteilten Felder sind die der ungefilterten Antwort`);
    assert.deepEqual(numbers(body), [14, 4], path);
  }
});

test('eine einzelne Liste: der Parameter als einzelner Wert', async () => {
  const body = await getJson(query(GARTEN));
  assert.deepEqual(tileNames(body), ['Garten']);
  assert.deepEqual(tileNumbers(body), [1, 1]);
});

test('eine gewaehlte Liste ohne Offenes bleibt stehen, hinter denen mit Offenem', async () => {
  // "Fest" ist die juengste Liste - ohne die Regel "Offenes zuerst" stuende
  // sie vorn und draengte am Deckel eine volle Liste hinaus.
  const body = await getJson(query(FEST, GARTEN));
  assert.deepEqual(tileNames(body), ['Garten', 'Fest']);
  const fest = body.shoppingTile.lists.find((list) => list.name === 'Fest');
  assert.deepEqual([fest.open_count, fest.total_count, fest.items.length], [0, 4, 0]);
  assert.deepEqual(tileNumbers(body), [1, 2], 'ein offener Artikel, ZWEI gewaehlte Listen - auch die leere zaehlt als Liste');

  const only = await getJson(query(FEST));
  assert.deepEqual(tileNames(only), ['Fest'], 'auch allein: die Kachel ist nicht leer');
  assert.deepEqual(tileNumbers(only), [0, 1]);
});

test('der Deckel von drei Listen bleibt, und JEDE gewaehlte Liste zaehlt - auch die abgeschnittene ohne Offenes', async () => {
  // Vier gewaehlt, drei mit Offenem, eine fertig gekauft: drei stehen da, und
  // `listCount` sagt vier - daraus macht die Kachel "+1 weitere Liste". Zaehlte
  // die Route nur Listen mit Offenem, fehlte "Fest" stumm.
  const four = await getJson(query(FEST, GARTEN, WOCHE, BAUMARKT));
  assert.deepEqual(tileNames(four), ['Baumarkt', 'Wocheneinkauf', 'Garten']);
  assert.deepEqual(tileNumbers(four), [11, 4]);

  const five = await getJson(query(FEST, GARTEN, WOCHE, BAUMARKT, DROGERIE));
  assert.deepEqual(tileNames(five), ['Drogerie', 'Baumarkt', 'Wocheneinkauf']);
  assert.deepEqual(tileNumbers(five), [14, 5]);
});

test('eine geloeschte Liste in der Auswahl faellt weg, die uebrigen bleiben', async () => {
  const gone = addList('Wird geloescht', '2026-10-06T08:00:00Z', 2);
  assert.deepEqual(tileNames(await getJson(query(gone, GARTEN))), ['Wird geloescht', 'Garten']);
  db.prepare('DELETE FROM shopping_lists WHERE id = ?').run(gone);
  const body = await getJson(query(gone, GARTEN));
  assert.deepEqual(tileNames(body), ['Garten']);
  assert.deepEqual(tileNumbers(body), [1, 1], 'die geloeschte zaehlt auch nicht als "+1"');
});

test('ist JEDE gewaehlte Liste geloescht, antwortet die Route wie ohne Auswahl - nie leer', async () => {
  const gone = addList('Auch geloescht', '2026-10-07T08:00:00Z', 1);
  db.prepare('DELETE FROM shopping_lists WHERE id = ?').run(gone);
  const plain = await getJson('/');
  const body = await getJson(query(gone));
  assert.equal('shoppingTile' in body, false, 'keine Kachel-Fassung: die Kachel zeigt alle Listen');
  assert.equal(shared(body), shared(plain));
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
    assert.equal('shoppingTile' in body, false, raw);
    assert.equal(shared(body), shared(plain), raw);
  }
  // Unsinn NEBEN einer echten Id: die echte gilt.
  assert.deepEqual(tileNames(await getJson(`/?shopping_list=abc&shopping_list=${GARTEN}&shopping_list=999999`)), ['Garten']);
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
    assert.deepEqual(tileNames(await getJson(query(GARTEN))), ['Garten']);
    lock();
    assert.equal(resolvePermissions(db, db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(LEO)).modules.shopping, 'none',
      'Vorbedingung: der Einkauf ist fuer Leo gesperrt');
    for (const path of ['/', query(GARTEN), query(GARTEN, WOCHE, FEST)]) {
      const body = await getJson(path);
      assert.deepEqual(body.shoppingLists, [], path);
      assert.deepEqual(numbers(body), [0, 0], path);
      assert.equal('shoppingTile' in body, false, `${path}: auch keine Kachel-Fassung`);
      assert.ok(!JSON.stringify(body).includes('Garten'), `${path}: kein Listenname in der Antwort`);
    }
  } finally {
    unlock();
    currentUser = ADMIN;
  }
});

test('ein gekoppeltes Display bekommt keinen Einkauf - auch nicht ueber die Auswahl der Haushaltsvorgabe', async () => {
  // Das Display folgt der Vorgabe des Haushalts, sein Browser schickt deren
  // `shopping_list` also mit (#1808 fuer `events_scope`). Es hat aber keinen
  // Einkaufs-Scope: die Auswahl darf dort kein Feld fuellen.
  const { DISPLAY_SCOPES } = await import('../server/services/display-accounts.js');
  assert.ok(!DISPLAY_SCOPES.some((scope) => scope.startsWith('shopping:')), 'Vorbedingung: das Display hat keinen Einkaufs-Scope');
  assert.deepEqual(tileNames(await getJson(query(GARTEN))), ['Garten'], 'Gegenprobe: ohne Display fuellt dieselbe Anfrage die Kachel');
  displayScopes = [...DISPLAY_SCOPES];
  try {
    for (const path of ['/', query(GARTEN), query(GARTEN, FEST)]) {
      const body = await getJson(path);
      assert.deepEqual(body.shoppingLists, [], path);
      assert.deepEqual(numbers(body), [0, 0], path);
      assert.equal('shoppingTile' in body, false, path);
      assert.ok(!JSON.stringify(body).includes('Garten'), `${path}: kein Listenname in der Antwort`);
    }
  } finally {
    displayScopes = null;
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
    assert.deepEqual(tileNames(await getJson(widgets.dashboardQuery(mine).replace('/dashboard', '/'))), ['Wocheneinkauf', 'Garten']);

    currentUser = LEO;
    const theirs = (await readPrefs()).dashboard_widgets;
    assert.deepEqual(theirs, [], 'Leos Anordnung bleibt unberuehrt');
    const leo = await getJson(widgets.dashboardQuery(theirs).replace('/dashboard', '/'));
    assert.equal(tileNames(leo), null, 'und Leo hat keine Kachel-Fassung');
    assert.deepEqual(names(leo), ['Drogerie', 'Baumarkt', 'Wocheneinkauf'], 'er sieht weiter alle Listen');
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

test('dashboardQuery: die Auswahl reist als wiederholter Parameter, wie jede andere Option', () => {
  const q = (options, visible) => widgets.dashboardQuery(shoppingTile(options, visible));
  assert.equal(q(undefined), '/dashboard');
  assert.equal(q({ lists: [] }), '/dashboard', 'keine Auswahl heisst alle und steht in keiner Anfrage');
  assert.equal(q({ lists: [7] }), '/dashboard?shopping_list=7');
  assert.equal(q({ lists: [7, 3] }), '/dashboard?shopping_list=7&shopping_list=3');
  assert.equal(q({ lists: ['7', 7, 'abc', 0, -2, 1.5, null] }), '/dashboard?shopping_list=7', 'Fremdwerte im Layout werden nicht zur Anfrage');
  assert.equal(q({ lists: 'alle' }), '/dashboard');
  // Keine Sichtbarkeits-Bedingung im Browser: die Route haelt die Auswahl von
  // allem ausser der Kachel fern, also braucht hier niemand daran zu denken.
  assert.equal(q({ lists: [7] }, false), '/dashboard?shopping_list=7');
});

test('die Auswahl filtert keine Zahl der Navigation: kein zweiter Abruf, und die Badge zaehlt alle Listen', async () => {
  // Die Antwort der Seite gilt fuer die Navigation als ungefiltert ...
  assert.equal(widgets.dashboardQueryFiltersCounts('/dashboard?shopping_list=7'), false);
  assert.equal(widgets.dashboardQueryFiltersCounts('/dashboard?shopping_list=7&events_limit=8'), false);
  // (Reichweite: ein echter Filter daneben bleibt einer.)
  assert.equal(widgets.dashboardQueryFiltersCounts('/dashboard?shopping_list=7&tasks_category=x'), true);
  // ... und sie IST es: die Zahl, die die Badge liest, ist mit Auswahl dieselbe.
  const plain = await getJson('/');
  const picked = await getJson(query(GARTEN));
  assert.equal(picked.shoppingOpenCount, 14);
  assert.equal(picked.shoppingOpenCount, plain.shoppingOpenCount);
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

/** Der Dialog mit dem ECHTEN Lader: nur die Netzschicht (`api.get`) ist ersetzt. */
async function openWithRealLoader(current, get) {
  const prev = { stub: globalThis.__apiStub, open: globalThis.__openModal, close: globalThis.__closeModal, window: globalThis.window };
  const calls = [];
  const toasts = [];
  let opened = false;
  globalThis.__apiStub = { get: (...args) => { calls.push(args); return get(...args); } };
  globalThis.__openModal = () => { opened = true; };
  globalThis.__closeModal = () => true;
  globalThis.window = { yuvomi: { showToast: (message, type) => toasts.push([message, type]) } };
  try {
    const pending = dash.openWidgetOptions('shopping', current);
    // Geht der Dialog auf, wartet er auf Speichern oder Schliessen; die Probe
    // braucht dann nur, DASS er aufging.
    const result = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve('offen'), 20))]);
    return { result, calls, toasts, opened };
  } finally {
    globalThis.__apiStub = prev.stub;
    globalThis.__openModal = prev.open;
    globalThis.__closeModal = prev.close;
    globalThis.window = prev.window;
  }
}

test('Lader: der Dialog holt die Listen von /shopping, und ein Fehler loescht die gespeicherte Auswahl nicht', async () => {
  // Jeder Dialogtest oben reicht `loadLists` herein - der echte Lader lief nie.
  // Sein Vertrag: `null` bei einem Fehler. Lieferte er `[]`, ginge der Dialog
  // ohne Zeilen auf, und Speichern schriebe `{}`: die Auswahl waere still fort.
  const failed = await openWithRealLoader({ lists: [7] }, async () => { throw new Error('offline'); });
  assert.deepEqual(failed.calls, [['/shopping']], 'der Pfad der Einkaufslisten');
  assert.equal(failed.opened, false, 'ohne Katalog geht der Dialog nicht auf');
  assert.equal(failed.result, null, '`null` heisst fuer den Aufrufer: Optionen stehen lassen');
  assert.deepEqual(failed.toasts, [['dashboard.loadError', 'danger']]);

  // Eine Antwort ohne Liste (kaputte Form) ist ebenfalls kein leerer Katalog.
  const odd = await openWithRealLoader({ lists: [7] }, async () => ({ data: null }));
  assert.deepEqual([odd.opened, odd.result], [false, null]);

  // Und mit Katalog geht er auf - auch mit einem leeren (das ist eine Antwort).
  assert.equal((await openWithRealLoader({ lists: [7] }, async () => ({ data: [{ id: 7, name: 'Drogerie' }] }))).opened, true);
  assert.equal((await openWithRealLoader({}, async () => ({ data: [] }))).opened, true);

  // Der Aufrufer nimmt `null` als "nichts aendern" - sonst wuerde er `undefined` speichern.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const wiring = src.slice(src.indexOf("container.querySelectorAll('[data-widget-options]')"));
  assert.match(wiring.slice(0, 600), /const next = await openWidgetOptions\(id, current\);\n\s+if \(next === null\) return;/);
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
  const html = dash.renderShoppingTile({ shoppingTile: { lists, openCount: 1, listCount: 2 }, shoppingLists: [], shoppingOpenCount: 14, shoppingOpenLists: 4 });
  const rows = html.split('class="shopping-widget-list"').slice(1);
  assert.equal(rows.length, 2);
  assert.ok(!/shoppingListNothingOpen/.test(rows[0]), 'eine Liste mit Offenem traegt den Satz nicht');
  assert.match(rows[1], /dashboard\.shoppingListNothingOpen/);
  assert.match(rows[1], />4\/4</, 'der Zaehler der Zeile sagt weiter erledigt/gesamt');
  assert.match(html, /data-route="\/shopping\?list=5"/, 'die leere Liste ist einen Tipp entfernt');
  assert.match(html, /widget__badge[^>]*>1</, 'die Badge zaehlt in der Auswahl, nicht die 14 des Haushalts');
  // Beide gewaehlten Listen stehen da: nichts ist abgeschnitten.
  assert.ok(!/shoppingMoreLists/.test(html));
  assert.ok(!/widget__empty/.test(html), 'kein Leerzustand: die Kachel zeigt ihre Auswahl');
});

test('Kachel: eine gewaehlte Liste, die der Deckel abschneidet, ist als "+1 weitere Liste" da - auch ohne Offenes', async () => {
  // Der ganze Weg, von der Route bis zur Kachel. Vier gewaehlt, drei mit
  // Offenem, "Fest" fertig gekauft: drei Zeilen und "+1". Mit der Zaehlung
  // "nur Listen mit Offenem" (3 - 3 = 0) fehlte "Fest" stumm, obwohl Hinweis
  // und CHANGELOG sagen, eine gewaehlte Liste bleibe stehen.
  const four = await getJson(query(FEST, GARTEN, WOCHE, BAUMARKT));
  const html = dash.renderShoppingTile(four);
  assert.equal(html.split('class="shopping-widget-list"').length - 1, 3);
  assert.ok(!html.includes('>Fest<'), 'Vorbedingung: die fertig gekaufte Liste ist abgeschnitten');
  assert.match(html, /dashboard\.shoppingMoreLists\{&quot;count&quot;:1\}/);

  // Zwei gewaehlt, beide gezeigt (eine davon leer): kein "+n".
  assert.ok(!/shoppingMoreLists/.test(dash.renderShoppingTile(await getJson(query(FEST, GARTEN)))));
  // Fuenf gewaehlt: "+2".
  assert.match(dash.renderShoppingTile(await getJson(query(FEST, GARTEN, WOCHE, BAUMARKT, DROGERIE))), /shoppingMoreLists\{&quot;count&quot;:2\}/);
});

test('Kachel: ohne Auswahl liest sie die geteilten Felder, und "+n weitere Listen" bleibt wie zuvor', async () => {
  const lists = [1, 2, 3].map((id) => ({ id, name: `L${id}`, open_count: 2, total_count: 2, items: [] }));
  assert.match(dash.renderShoppingLists(lists, 14, 5), /dashboard\.shoppingMoreLists\{&quot;count&quot;:2\}/);
  assert.ok(!/shoppingMoreLists/.test(dash.renderShoppingLists(lists, 6, 3)));
  // Durch die echte Antwort: vier Listen mit Offenem, drei gezeigt, "+1", Badge 14.
  const html = dash.renderShoppingTile(await getJson('/'));
  assert.match(html, /shoppingMoreLists\{&quot;count&quot;:1\}/);
  assert.match(html, /widget__badge[^>]*>14</);
});

// --------------------------------------------------------------------------
// 4. Was die Auswahl NICHT anfasst: Heute-Blatt und Wand
// --------------------------------------------------------------------------

/** Die Einkaufszeile des Blatts, wie Heute-Blatt (Layout ohne Kachel) und Wand (immer leeres Layout) sie bauen. */
async function sheetShoppingRow(data, cap) {
  const { setPermissions, clearPermissions } = await import('../public/permissions.js');
  const prevWindow = globalThis.window;
  globalThis.window = { yuvomi: { isModuleDisabled: () => false }, matchMedia: () => ({ matches: false }) };
  setPermissions({ admin: true, modules: {}, widgets: {}, capabilities: {} });
  try {
    const model = dash.buildTodayCockpitModel(data, [], { cap, groupOverdue: false });
    let row = null;
    JSON.stringify(model, (_key, value) => { if (value && value.kind === 'shopping') row = value; return value; });
    return row;
  } finally {
    clearPermissions();
    globalThis.window = prevWindow;
  }
}

test('Heute-Blatt und Wand zaehlen ueber ALLE Listen - auch wenn die Kachel eine Auswahl traegt', async () => {
  // Das Kuechentablett, das einer Haushaltsvorgabe mit Auswahl folgt: die Wand
  // baut ihr Blatt mit leerem Layout auf denselben Daten, dort spricht der
  // Einkauf also immer. Mit der ersten Fassung: "1" bei einer gewaehlten
  // Liste, und mit nur der fertig gekauften verschwand die Zeile.
  for (const cap of [dash.PROGRAM_ROW_CAP, dash.WALL_ROW_CAP]) {
    for (const path of ['/', query(GARTEN), query(FEST), query(GARTEN, WOCHE)]) {
      const row = await sheetShoppingRow(await getJson(path), cap);
      assert.ok(row, `${path}: die Einkaufszeile steht da`);
      assert.equal(row.title, 'dashboard.todayShoppingCount{"count":14}', `${path} (Deckel ${cap})`);
    }
  }
});

test('die Einkaufszeile des Heute-Blatts waehlt ihr Ziel aus den UNGEFILTERTEN Listen (#1821)', async () => {
  // `/shopping?list=<id>` gilt, wenn im HAUSHALT genau eine Liste Offenes hat -
  // nicht, wenn die Kachel genau eine Liste gewaehlt hat. Hier haben vier Listen
  // Offenes: das Ziel bleibt die Seite, auch mit einer einzelnen gewaehlten.
  // Filterte die Route die geteilten Felder, stuende hier `?list=<Garten>`.
  for (const path of ['/', query(GARTEN), query(FEST)]) {
    const data = await getJson(path);
    assert.equal(dash.shoppingSoleListRoute(data), '/shopping', path);
    assert.equal((await sheetShoppingRow(data, dash.PROGRAM_ROW_CAP)).route, '/shopping', path);
  }
  // Reichweite: mit genau einer Liste mit Offenem im Haushalt ist sie das Ziel -
  // auch wenn die Kachel eine ANDERE gewaehlt hat.
  const one = { shoppingLists: [{ id: 7, name: 'Drogerie', open_count: 2, total_count: 2, items: [] }], shoppingOpenCount: 2, shoppingOpenLists: 1,
    shoppingTile: { lists: [{ id: 9, name: 'Fest', open_count: 0, total_count: 1, items: [] }], openCount: 0, listCount: 1 } };
  assert.equal(dash.shoppingSoleListRoute(one), '/shopping?list=7');
});

test('das Heute-Blatt liest die Zahl des Servers, nicht die Summe der drei gelieferten Listen', async () => {
  // Bestand vor #1818: `shoppingLists` traegt hoechstens drei Listen, das Blatt
  // summierte deren `open_count` - 13 bei vierzehn offenen in vier Listen.
  const plain = await getJson('/');
  assert.equal(plain.shoppingLists.reduce((sum, list) => sum + list.open_count, 0), 13, 'Vorbedingung: die Summe der drei ist kleiner');
  assert.equal(dash.buildTodayHighlights(plain).openShoppingCount, 14);
  // Ohne die Zahl (aelterer Server) oder nach gescheiterter Abfrage (`null`) bleibt die Summe.
  assert.equal(dash.buildTodayHighlights({ shoppingLists: plain.shoppingLists }).openShoppingCount, 13);
  assert.equal(dash.buildTodayHighlights({ shoppingLists: plain.shoppingLists, shoppingOpenCount: null }).openShoppingCount, 13);
  // Null offen ist eine Zahl, kein Fehlen.
  assert.equal(dash.buildTodayHighlights({ shoppingLists: plain.shoppingLists, shoppingOpenCount: 0 }).openShoppingCount, 0);
});
