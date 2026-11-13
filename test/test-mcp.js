/**
 * Tests: MCP-Server (server/mcp/*)
 * Fokus: JSON-RPC-Dispatch (initialize / tools/list / tools/call), Kern-Tool-Logik
 *        (Anlegen + Lesen), Validierung und Fehlerpfade sowie die generische
 *        OpenAPI-Brücke (list/get/call_api_operation) inklusive Loopback-Verhalten
 *        (Operation-Auflösung, Path-Params, Query, Auth-Weiterleitung, Payload,
 *        Fehlerpropagation) über einen gemockten `fetch`.
 *        Dazu die Rechte-Durchsetzung der Tool-Schicht (#823): Modulrechte des
 *        Nutzers, Token-Scopes und Split-Guests - die lesenden Kern-Tools laufen
 *        an der /api/v1-Middleware vorbei und müssen dieselbe Grenze selbst ziehen.
 *
 *        DIE DREI SCHREIBENDEN KERN-TOOLS GEHEN SEIT #2616 DURCH IHRE ROUTE.
 *        Deshalb hängt in dieser Suite ein echter Server an einem echten
 *        Middleware-Stapel (Auth, CSRF, Idempotenz) und `MCP_INTERNAL_BASE_URL`
 *        zeigt darauf: Standardpunkte, eigene Kategorien, der Listenstand und
 *        die Retry-Sicherheit entstehen IN der Route - eine fetch-Attrappe
 *        könnte nur messen, was sie selbst geantwortet hat. Die Attrappen-Tests
 *        der Brücke bleiben, sie setzen `fetch` je Test und stellen es zurück.
 * Ausführen: npm run test:mcp
 */

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'mcp-test-secret';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
// @ts-expect-error express 5 ships no type declarations (TS7016); new code type-checks clean
import express from 'express';

// Nach den beiden env-Zeilen: server/db.js liest DB_PATH beim Laden.
const dbmod = await import('../server/db.js');
const db = dbmod.get();
const { handleMcpRequest, LATEST_PROTOCOL_VERSION } = await import('../server/mcp/protocol.js');
const { callTool, TOOL_DEFINITIONS } = await import('../server/mcp/tools.js');
const { buildSessionModuleAccess, resolvePermissions } = await import('../server/authorize/index.ts');
const { csrfMiddleware } = await import('../server/middleware/csrf.js');
const { default: idempotencyMiddleware } = await import('../server/middleware/idempotency.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const { default: shoppingRouter } = await import('../server/routes/shopping.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');

const uid = db.prepare(
  `INSERT INTO users (username, display_name, password_hash, avatar_color, role)
   VALUES ('admin', 'Anna', 'x', '#007AFF', 'admin')`
).run().lastInsertRowid;

const listId = db.prepare(
  `INSERT INTO shopping_lists (name, created_by) VALUES ('Wocheneinkauf', ?)`
).run(uid).lastInsertRowid;

const in3days = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

const actor = { kind: 'token', userId: uid, role: 'admin' };

// ── Loopback: die echten Routen hinter dem echten Middleware-Stapel ──────────
//
// Die Auth-Schicht ist nachgestellt wie in test-mcp-router-permissions.js: was
// `requireAuth` setzt, setzt diese Zeile. Zwei Wege, weil die Brücke genau zwei
// weiterreicht - ein Bearer-Token (`api_token`, von CSRF ausgenommen) und ein
// Sitzungs-Cookie (`session`, CSRF-pflichtig). Welcher gilt, entscheidet der
// weitergereichte Header, nicht der Test.
const SESSION_COOKIE = 'yuvomi.sid=mcp-test';
// EINE Sitzung je Cookie-Wert, ueber Anfragen hinweg wie bei express-session:
// ein neues Objekt je Anfrage liesse `csrfMiddleware` jedes Mal ein neues
// Token ziehen, und kein mitgeschickter Wert koennte je passen.
/** @type {Map<string, any>} */
const sessions = new Map();
const app = express();
app.use(express.json());
app.use('/api/v1', (/** @type {any} */ req, /** @type {any} */ _res, /** @type {any} */ next) => {
  const cookie = String(req.headers.cookie || '');
  req.authUserId = Number(uid);
  req.authRole = 'admin';
  req.authMethod = cookie.includes('yuvomi.sid=') ? 'session' : 'api_token';
  req.authScopes = null;
  if (!sessions.has(cookie)) sessions.set(cookie, { userId: Number(uid), role: 'admin' });
  req.session = sessions.get(cookie);
  next();
});
app.use('/api/v1', csrfMiddleware);
app.use('/api/v1', idempotencyMiddleware);
app.use('/api/v1/tasks', tasksRouter);
app.use('/api/v1/shopping', shoppingRouter);
app.use('/api/v1/calendar', calendarRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(null)));
const LOOPBACK = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
process.env.MCP_INTERNAL_BASE_URL = LOOPBACK;
test.after(() => server.close());

// Hilfsfunktion: JSON-RPC-Request absetzen und Antwort zurückgeben.
/** @type {any[]} */
let internalErrors = [];
/**
 * @param {string} method
 * @param {any} [params]
 * @param {number|null} [id]
 * @param {any} [requestHeaders]
 * @returns {Promise<any>}
 */
function rpc(method, params, id = 1, requestHeaders = { authorization: 'Bearer mcp-test' }) {
  /** @type {any} */
  const body = { jsonrpc: '2.0', method };
  if (params !== undefined) body.params = params;
  if (id !== null) body.id = id;
  return handleMcpRequest(db, actor, body, (err) => internalErrors.push(err), { requestHeaders });
}
/** @returns {Promise<any>} */
function toolCall(name, args) {
  return rpc('tools/call', { name, arguments: args });
}
/**
 * ctx wie `server/mcp/server.js` ihn baut: Akteur plus weitergereichte Header.
 * @param {any} [headers]
 * @param {any} [as]
 * @returns {any}
 */
function ctxFor(headers = { authorization: 'Bearer mcp-test' }, as = actor) {
  return { db, actor: as, requestHeaders: headers };
}
/** @returns {Promise<any>} */
function toolCallWithHeaders(name, args, requestHeaders) {
  return handleMcpRequest(
    db, actor,
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    (err) => internalErrors.push(err),
    { requestHeaders },
  );
}
/** @returns {any} */
function parseContent(res) {
  return JSON.parse(res.result.content[0].text);
}
/**
 * Eine Zeile aus der Test-DB, ohne Typzeremonie.
 * @param {string} sql
 * @param {...any} params
 * @returns {any}
 */
function row(sql, ...params) {
  return db.prepare(sql).get(...params);
}

// ── fetch-Mock für die OpenAPI-Brücke ────────────────────────────────────────
const realFetch = global.fetch;
function installFetchMock(handler) {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options);
  };
  return calls;
}
function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok, status,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => Buffer.from(JSON.stringify(body)),
  };
}
function binaryResponse(bytes, { contentLength, contentType = 'application/octet-stream', ok = true, status = 200 } = {}) {
  const buf = Buffer.from(bytes);
  const map = { 'content-type': contentType };
  if (contentLength !== undefined) map['content-length'] = String(contentLength);
  return {
    ok, status,
    headers: { get: (h) => (map[String(h).toLowerCase()] ?? null) },
    json: async () => null,
    text: async () => buf.toString(),
    // Kein body.getReader → readCappedBinary nutzt den arrayBuffer-Fallback.
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

// ── initialize ───────────────────────────────────────────────────────────────

test('initialize: liefert serverInfo, Capabilities und Protokollversion', async () => {
  const res = await rpc('initialize', { protocolVersion: LATEST_PROTOCOL_VERSION });
  assert.equal(res.result.protocolVersion, LATEST_PROTOCOL_VERSION);
  assert.equal(res.result.serverInfo.name, 'yuvomi');
  assert.ok(res.result.serverInfo.version, 'Version muss gesetzt sein');
  assert.ok(res.result.capabilities.tools, 'tools-Capability muss vorhanden sein');
});

test('initialize: unbekannte Protokollversion fällt auf die neueste zurück', async () => {
  const res = await rpc('initialize', { protocolVersion: '1999-01-01' });
  assert.equal(res.result.protocolVersion, LATEST_PROTOCOL_VERSION);
});

// ── tools/list ───────────────────────────────────────────────────────────────

test('tools/list: listet die sechs Kern-Tools plus die drei OpenAPI-Brücken-Tools', async () => {
  const res = await rpc('tools/list');
  const names = res.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'add_shopping_item', 'call_api_operation', 'create_event', 'create_task',
    'get_api_operation', 'list_api_operations', 'list_shopping_items',
    'list_tasks', 'list_upcoming_events',
  ]);
  assert.equal(res.result.tools.length, TOOL_DEFINITIONS.length);
  for (const t of res.result.tools) {
    assert.equal(t.inputSchema.type, 'object', `${t.name} braucht ein object-Schema`);
    // Issue #599: Properties ohne `type` werden von manchen Clients zu Strings
    // koerziert — jede Property muss ihren Typ deklarieren.
    for (const [prop, schema] of Object.entries(t.inputSchema.properties || {})) {
      assert.ok(schema.type, `${t.name}.${prop} braucht ein deklariertes type`);
    }
  }
});

// ── create_task ──────────────────────────────────────────────────────────────

test('tools/call create_task: legt Task an und gibt sie zurück', async () => {
  const res = await toolCall('create_task', { title: 'Müll rausbringen', priority: 'high', due_date: in3days });
  assert.equal(res.result.isError, false);
  const task = parseContent(res);
  assert.equal(task.title, 'Müll rausbringen');
  assert.equal(task.priority, 'high');
  assert.equal(task.status, 'open');

  const row = db.prepare('SELECT title, created_by, status FROM tasks WHERE id = ?').get(task.id);
  assert.equal(row.title, 'Müll rausbringen');
  assert.equal(row.created_by, uid, 'created_by muss der Actor sein');
});

test('tools/call create_task: ohne Kategorie fällt auf den Key misc, nicht auf Sonstiges', async () => {
  // 'Sonstiges' war der Anzeigename der Auffangkategorie vor v83, nie ein Key in
  // task_categories. Der alte Fallback ließ jede per MCP erzeugte Aufgabe aus
  // Dropdown und Filter fallen und sie beim ersten Speichern im Modal still auf
  // die erste echte Kategorie springen. Migration v114 hat den Bestand geputzt -
  // ohne diesen Guard liefert die Tool-Schicht ihn weiter nach. Seit #2616 ist
  // es der Rückfall der Route (`FALLBACK_CATEGORY`), nicht mehr ein eigener.
  const res = await toolCall('create_task', { title: 'Ohne Kategorie', priority: 'low' });
  assert.equal(res.result.isError, false);
  const task = parseContent(res);
  assert.equal(task.category, 'misc');
});

test('tools/call create_task: fehlender Titel → isError mit Meldung', async () => {
  const res = await toolCall('create_task', {});
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /title/i);
});

// `null` heisst "nicht angegeben", wie vor #2616: viele Clients serialisieren
// ein weggelassenes optionales Argument so. Die Route liest `null` in Kategorie
// und Priorität als falsche Form (400) - also darf es sie nicht erreichen.
test('tools/call create_task: category null legt an wie ohne das Feld', async () => {
  const res = await toolCall('create_task', { title: 'Kategorie null', category: null });
  assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
  assert.equal(parseContent(res).category, 'misc');
});

test('tools/call create_task: priority null legt an wie ohne das Feld', async () => {
  const res = await toolCall('create_task', { title: 'Priorität null', priority: null });
  assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
  assert.equal(parseContent(res).priority, 'none');
});

test('null in jedem optionalen Feld der drei Schreibwerkzeuge heisst weggelassen', async () => {
  const task = await toolCall('create_task', {
    title: 'Alles null', description: null, category: null, priority: null,
    due_date: null, due_time: null, tags: null, idempotency_key: null,
  });
  assert.equal(task.result.isError, false, task.result.content?.[0]?.text);
  assert.deepEqual(parseContent(task).tags, []);
  const item = await toolCall('add_shopping_item', { name: 'Alles null', quantity: null, category: null, list: null });
  assert.equal(item.result.isError, false, item.result.content?.[0]?.text);
  assert.equal(parseContent(item).list, 'Wocheneinkauf');
  const event = await toolCall('create_event', {
    title: 'Alles null', start_datetime: `${in3days}T11:15`, description: null,
    end_datetime: null, all_day: null, location: null,
  });
  assert.equal(event.result.isError, false, event.result.content?.[0]?.text);
  assert.equal(parseContent(event).all_day, 0);
  assert.equal(parseContent(event).start_datetime, `${in3days}T11:15`);
});

test('tools/call create_task: ungültige Priorität → isError', async () => {
  const res = await toolCall('create_task', { title: 'X', priority: 'sofort' });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /priority/i);
});

// ── #2616: dasselbe Verhalten wie die App, weil es DIESELBE Route ist ────────
//
// Jeder Fall hier war gegen das eigene INSERT der Tool-Schicht rot. Gemessen
// wird die Zeile, nicht die Antwort: eine Automatisierung, die anders anlegt
// als der Dialog, erzeugt Aufgaben, die der Haushalt hinterher nachbessert.

test('tools/call create_task: der Haushalt-Standardwert für Punkte greift (#2616)', async (t) => {
  db.prepare(`INSERT INTO sync_config (key, value) VALUES ('tasks_default_points', '5')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
  t.after(() => db.prepare(`DELETE FROM sync_config WHERE key = 'tasks_default_points'`).run());

  const res = await toolCall('create_task', { title: 'Mit Standardpunkten' });
  assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
  assert.equal(row('SELECT points FROM tasks WHERE id = ?', parseContent(res).id).points, 5, 'das eigene INSERT liess points auf dem Spaltendefault 0');
});

test('tools/call create_task: eigene Kategorie erlaubt, gelöschter Standard-Key nicht (#2616)', async (t) => {
  db.prepare(`INSERT INTO task_categories (key, name, sort_order) VALUES ('garten', 'Garten', 20)`).run();
  const removed = row(`SELECT * FROM task_categories WHERE key = 'repair'`);
  db.prepare(`DELETE FROM task_categories WHERE key = 'repair'`).run();
  t.after(() => {
    db.prepare(`DELETE FROM task_categories WHERE key = 'garten'`).run();
    db.prepare(`INSERT OR IGNORE INTO task_categories (key, name, label_key, sort_order) VALUES (?, ?, ?, ?)`)
      .run(removed.key, removed.name, removed.label_key, removed.sort_order);
  });

  // Die feste Liste `VALID_CATEGORIES` kannte 'garten' nicht und wies ab.
  const own = await toolCall('create_task', { title: 'Hecke schneiden', category: 'garten' });
  assert.equal(own.result.isError, false, own.result.content?.[0]?.text);
  assert.equal(parseContent(own).category, 'garten');

  // Und sie kannte 'repair' noch, als der Haushalt es längst gelöscht hatte -
  // die Aufgabe fiel damit aus Dropdown und Filter.
  const deleted = await toolCall('create_task', { title: 'Geht nicht mehr', category: 'repair' });
  assert.equal(deleted.result.isError, true);
  assert.match(deleted.result.content[0].text, /category/i);
  assert.equal(db.prepare(`SELECT 1 FROM tasks WHERE category = 'repair'`).get(), undefined);
});

// ── list_tasks ───────────────────────────────────────────────────────────────

test('tools/call list_tasks: enthält den neu angelegten Task', async () => {
  const res = await toolCall('list_tasks', {});
  assert.equal(res.result.isError, false);
  const tasks = parseContent(res);
  assert.ok(tasks.some((t) => t.title === 'Müll rausbringen'), 'neuer Task muss gelistet sein');
});

// Dieselbe Auswahl wie UI und REST-API (#825). Ohne diese Zusicherung faellt
// MCP still zurueck: die Tools bauen ihre Abfragen selbst und laufen an jedem
// Pfad-Guard vorbei, weil sie express nie durchlaufen - genau der Weg, auf dem
// hier schon einmal die Sichtbarkeit (#474) gefehlt hat.
test('tools/call list_tasks: was erst spaeter beginnt, ist noch nicht dran', async () => {
  // Lokaler Kalendertag, nicht `toISOString()`: `start_date` ist ein lokal
  // eingegebener Tag, und westlich von UTC liefert der UTC-Tag hier abends den
  // Vortag - genau die Falle, gegen die dieser Test steht (CLAUDE.md).
  const week = new Date();
  week.setDate(week.getDate() + 7);
  const inAWeek = `${week.getFullYear()}-${String(week.getMonth() + 1).padStart(2, '0')}-${String(week.getDate()).padStart(2, '0')}`;
  db.prepare(
    `INSERT INTO tasks (title, created_by, status, visibility, start_date) VALUES (?, ?, 'open', 'all', ?)`
  ).run('Erst naechste Woche', uid, inAWeek);

  const listed = parseContent(await toolCall('list_tasks', {}));
  assert.ok(
    !listed.some((t) => t.title === 'Erst naechste Woche'),
    'eine erst spaeter beginnende Aufgabe darf nicht als anstehend gemeldet werden',
  );

  const withFuture = parseContent(await toolCall('list_tasks', { include_future: true }));
  assert.ok(
    withFuture.some((t) => t.title === 'Erst naechste Woche'),
    'mit include_future muss sie erscheinen - sonst waere sie ueber MCP gar nicht erreichbar',
  );
});

// "Heute" ist der Tag der Haushaltszone wie in GET /tasks, nicht der Prozesstag.
// Von +14 und -11 weicht immer mindestens eine Zone vom Prozesstag ab.
test('tools/call list_tasks: Startdatum-Riegel rechnet "heute" in der Haushaltszone', async (t) => {
  const { todayKey } = await import('../server/utils/timezone.js');
  const { toLocalDateKey } = await import('../public/utils/date.js');
  const setZone = db.prepare(`INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  const zone = ['Pacific/Kiritimati', 'Pacific/Pago_Pago'].find((z) => {
    setZone.run(z);
    return todayKey(db) !== toLocalDateKey();
  });
  t.after(() => db.prepare(`DELETE FROM sync_config WHERE key = 'household_timezone'`).run());
  assert.ok(zone);

  const today = todayKey(db);
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const insert = db.prepare(
    `INSERT INTO tasks (title, created_by, status, visibility, start_date) VALUES (?, ?, 'open', 'all', ?)`
  );
  insert.run('Zone ab heute', uid, today);
  insert.run('Zone ab morgen', uid, tomorrow);

  const titles = parseContent(await toolCall('list_tasks', {})).map((row) => row.title);
  assert.ok(titles.includes('Zone ab heute'), `beginnt heute (${zone}) und ist dran`);
  assert.ok(!titles.includes('Zone ab morgen'), `beginnt morgen (${zone}) und ist noch nicht dran`);
});

test('tools/call create_task + list_tasks: Tags reisen mit (#586)', async () => {
  const created = await toolCall('create_task', {
    title: 'Rasen mähen', priority: 'low', tags: ['Garten', 'Sommer'],
  });
  assert.equal(created.result.isError, false);
  assert.deepEqual(parseContent(created).tags, ['Garten', 'Sommer']);

  const listed = parseContent(await toolCall('list_tasks', {}));
  const row = listed.find((t) => t.title === 'Rasen mähen');
  // Als Liste, nicht als verbundene Zeichenkette: ein Tag darf selbst ein Komma
  // enthalten ("Haus, Hof"), verbunden wäre er nicht mehr eindeutig trennbar.
  assert.deepEqual(row.tags, ['Garten', 'Sommer']);
});

test('tools/call list_tasks: der tag-Filter engt UND-verknüpft ein', async () => {
  await toolCall('create_task', { title: 'Nur Garten', priority: 'low', tags: ['Garten'] });

  const beide = parseContent(await toolCall('list_tasks', { tag: ['Garten', 'Sommer'] }));
  assert.deepEqual(beide.map((t) => t.title), ['Rasen mähen'],
    'Eine Aufgabe muss alle genannten Tags tragen');

  const einer = parseContent(await toolCall('list_tasks', { tag: ['garten'] }));
  assert.equal(einer.length, 2, 'Die Schreibweise zählt beim Filtern nicht');
});

test('tools/call list_tasks: private Aufgaben anderer bleiben verborgen (#474)', async () => {
  // Diese Prüfung fehlte, obwohl die Termin-Abfrage sie führt und docs/SPEC.md
  // sie für MCP zusagt: ein Token sah jede private Aufgabe des Haushalts. Mit
  // den Tags käme deren Freitext gleich mit.
  const other = db.prepare(
    `INSERT INTO users (username, display_name, password_hash, avatar_color, role)
     VALUES ('bob', 'Bob', 'x', '#FF0000', 'member')`
  ).run().lastInsertRowid;
  db.prepare(
    `INSERT INTO tasks (title, created_by, status, visibility) VALUES (?, ?, 'open', 'private')`
  ).run('Geschenk für Anna', other);

  const seenByAnna = await callTool({ db, actor }, 'list_tasks', {});
  assert.equal(seenByAnna.some((t) => t.title === 'Geschenk für Anna'), false);
  // Gegenprobe: die Ersteller:in sieht sie sehr wohl.
  const seenByBob = await callTool({ db, actor: { kind: 'token', userId: other, role: 'member' } }, 'list_tasks', {});
  assert.equal(seenByBob.some((t) => t.title === 'Geschenk für Anna'), true);
});

test('tools/call list_tasks: ein unsinniger tag-Filter wird abgewiesen', async () => {
  // Die gefährliche Richtung: callTool erzwingt das JSON-Schema zur Laufzeit
  // nicht, und normalizeTags macht aus einem Objekt stillschweigend eine leere
  // Liste. Ein einschränkender Filter lieferte damit die VOLLE Liste statt
  // eines Fehlers, und eine Automatisierung handelte an fremden Aufgaben.
  const res = await toolCall('list_tasks', { tag: { nope: 1 } });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /tag/i);
});

// ── Shopping ─────────────────────────────────────────────────────────────────

test('tools/call add_shopping_item: fügt Artikel zur Standardliste hinzu', async () => {
  const res = await toolCall('add_shopping_item', { name: 'Milch', quantity: '2' });
  assert.equal(res.result.isError, false);
  const item = parseContent(res);
  assert.equal(item.name, 'Milch');
  assert.equal(item.quantity, '2');

  const row = db.prepare('SELECT name, list_id FROM shopping_items WHERE id = ?').get(item.id);
  assert.equal(row.list_id, listId, 'muss der ersten Liste zugeordnet sein');
});

test('tools/call add_shopping_item: unbekannte Liste → isError', async () => {
  const res = await toolCall('add_shopping_item', { name: 'Brot', list: 'Gibt-es-nicht' });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /Gibt-es-nicht/);
});

test('tools/call add_shopping_item: eine fremde Kategorie wird abgewiesen wie in der Route (#2616)', async () => {
  // Das eigene INSERT schrieb jeden Text in die Spalte. Eine Kategorie, die
  // `validCategoryNames()` nicht kennt, sortiert den Artikel ganz nach unten,
  // und PATCH /items/:id lehnt danach schon das Abhaken ab ("Invalid category").
  const res = await toolCall('add_shopping_item', { name: 'Schrauben', category: 'Baumarkt' });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /category/i);
  assert.equal(db.prepare(`SELECT 1 FROM shopping_items WHERE category = 'Baumarkt'`).get(), undefined);
});

test('tools/call add_shopping_item: ohne Kategorie gilt der Rückfall der Route (#2616)', async (t) => {
  // Der eigene Rückfall war der feste Text 'Sonstiges'. Hat der Haushalt diese
  // Kategorie umbenannt, schrieb die Tool-Schicht einen Namen, den es nicht
  // mehr gibt; die Route nimmt dann die letzte in Gang-Reihenfolge.
  db.prepare(`UPDATE shopping_categories SET name = 'Diverses' WHERE name = 'Sonstiges'`).run();
  t.after(() => db.prepare(`UPDATE shopping_categories SET name = 'Sonstiges' WHERE name = 'Diverses'`).run());

  const res = await toolCall('add_shopping_item', { name: 'Klebeband' });
  assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
  const names = db.prepare('SELECT name FROM shopping_categories ORDER BY sort_order ASC').all().map((c) => c.name);
  assert.equal(parseContent(res).category, names.at(-1));
  assert.notEqual(parseContent(res).category, 'Sonstiges');
});

test('tools/call add_shopping_item: die Laufnummer der Liste rückt vor (#2616)', async () => {
  // Hier bewegt sie ein TRIGGER (Migration v196), nicht die Route - der Stand
  // rückte deshalb auch beim eigenen INSERT vor. Die Zeile steht trotzdem:
  // `withListChange()` rahmt den Schreibvorgang mit genau dieser Nummer ein,
  // und ein Einkaufszettel, der sie abfragt, muss den MCP-Artikel sehen.
  const version = () => row('SELECT version FROM shopping_list_changes WHERE list_id = ?', Number(listId))?.version;
  const before = version();
  const res = await toolCall('add_shopping_item', { name: 'Butter' });
  assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
  assert.ok(version() > before, `Laufnummer blieb bei ${before}`);
});

test('tools/call list_shopping_items: unerledigte Artikel enthalten Milch', async () => {
  const items = parseContent(await toolCall('list_shopping_items', {}));
  assert.ok(items.some((i) => i.name === 'Milch'));
});

// ── Kalender ─────────────────────────────────────────────────────────────────

test('tools/call create_event: legt Event an', async () => {
  const res = await toolCall('create_event', { title: 'Zahnarzt', start_datetime: `${in3days}T09:30` });
  assert.equal(res.result.isError, false);
  const ev = parseContent(res);
  assert.equal(ev.title, 'Zahnarzt');
  assert.equal(ev.start_datetime, `${in3days}T09:30`);

  const row = db.prepare('SELECT title, external_source, created_by FROM calendar_events WHERE id = ?').get(ev.id);
  assert.equal(row.external_source, 'local');
  assert.equal(row.created_by, uid);
});

test('tools/call create_event: für den Ort gilt das Maß der Route (#2616)', async () => {
  // Die Tool-Schicht prüfte `location` gegen MAX_SHORT (100), die Route gegen
  // MAX_TITLE (200) - derselbe Termin, einmal angelegt und einmal abgewiesen,
  // je nachdem ob ein Mensch oder ein Assistent ihn eintrug. Eine Adresse mit
  // Zusatz reisst die 100 schnell.
  const location = `${'Musterstraße 1, 12345 Musterstadt, '.repeat(4)}Hinterhof`;
  assert.ok(location.length > 100 && location.length <= 200, `Probe misst ${location.length} Zeichen`);
  const res = await toolCall('create_event', {
    title: 'Mit langer Adresse', start_datetime: `${in3days}T08:00`, location,
  });
  assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
  assert.equal(parseContent(res).location, location);
});

test('tools/call create_event: all_day "false" behält die Uhrzeit und ist nicht ganztägig', async () => {
  // Die Route liest `!!req.body.all_day`: der String "false" wäre ganztägig und
  // die Uhrzeit fiele weg. Das Werkzeug nahm immer nur das Boolean `true`.
  const res = await toolCall('create_event', {
    title: 'Kein Ganztag', start_datetime: `${in3days}T09:30`, all_day: 'false',
  });
  assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
  const ev = parseContent(res);
  assert.equal(ev.all_day, 0);
  assert.equal(ev.start_datetime, `${in3days}T09:30`);
  assert.equal(row('SELECT all_day FROM calendar_events WHERE id = ?', ev.id).all_day, 0);

  // Gegenprobe: das Boolean `true` bleibt ganztägig.
  const allDay = parseContent(await toolCall('create_event',
    { title: 'Ganztag', start_datetime: `${in3days}T09:30`, all_day: true }));
  assert.equal(allDay.all_day, 1);
});

test('tools/call create_event: fehlender Start → isError', async () => {
  const res = await toolCall('create_event', { title: 'Ohne Start' });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /start_datetime/i);
});

test('tools/call list_upcoming_events: enthält das neue Event', async () => {
  const events = parseContent(await toolCall('list_upcoming_events', { limit: 10 }));
  assert.ok(events.some((e) => e.title === 'Zahnarzt'));
});

test('tools/call list_upcoming_events: enthält auch Termine nach mehr als zwei Jahren', async () => {
  const beyondDashboardWindow = new Date();
  beyondDashboardWindow.setUTCDate(beyondDashboardWindow.getUTCDate() + 120);
  const dateKey = beyondDashboardWindow.toISOString().slice(0, 10);
  const id = db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, all_day, created_by, external_source, visibility)
    VALUES ('MCP langfristig', ?, ?, 0, ?, 'local', 'all')
  `).run(`${dateKey}T09:00:00`, `${dateKey}T10:00:00`, uid).lastInsertRowid;

  const events = parseContent(await toolCall('list_upcoming_events', { limit: 100 }));
  assert.ok(events.some((event) => Number(event.id) === Number(id)), 'Termin nach 120 Tagen fehlt');

  const beyondBound = new Date();
  beyondBound.setUTCDate(beyondBound.getUTCDate() + 800);
  const beyondKey = beyondBound.toISOString().slice(0, 10);
  const farId = db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, all_day, created_by, external_source, visibility)
    VALUES ('MCP außerhalb horizontu', ?, ?, 0, ?, 'local', 'all')
  `).run(`${beyondKey}T09:00:00`, `${beyondKey}T10:00:00`, uid).lastInsertRowid;
  const upcoming = parseContent(await toolCall('list_upcoming_events', { limit: 100 }));
  assert.ok(upcoming.some((event) => Number(event.id) === Number(farId)),
    'Termin nach 800 Tagen fehlt');
});

test('tools/call list_upcoming_events liest keine großen attachment_data-Bodies', async () => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 5);
  const dateKey = date.toISOString().slice(0, 10);
  const id = db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, all_day, created_by, external_source,
       visibility, attachment_data)
    VALUES ('MCP großer Anhang', ?, ?, 0, ?, 'local', 'all', ?)
  `).run(`${dateKey}T13:00:00`, `${dateKey}T14:00:00`, uid, 'A'.repeat(1024 * 1024))
    .lastInsertRowid;

  const originalPrepare = db.prepare.bind(db);
  const statements = [];
  db.prepare = (sql) => {
    statements.push(String(sql));
    return originalPrepare(sql);
  };
  let events;
  try {
    events = parseContent(await toolCall('list_upcoming_events', { limit: 100 }));
  } finally {
    delete db.prepare;
  }

  assert.ok(events.some((event) => Number(event.id) === Number(id)), 'Termin fehlt');
  const calendarReads = statements.filter((sql) => /\b(?:FROM|JOIN)\s+calendar_events\b/i.test(sql));
  assert.ok(calendarReads.length > 0, 'keine Kalenderabfrage aufgezeichnet');
  assert.ok(calendarReads.every((sql) => !/\be\.\*|\battachment_data\b/i.test(sql)),
    `Attachment-Body in kompakter Kalenderabfrage: ${calendarReads.join('\n---\n')}`);
});

test('tools/call list_upcoming_events reuses linked occurrence resolution', async () => {
  const dateKey = (days) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };
  const originalDate = dateKey(4);
  const movedDate = dateKey(7);
  const masterId = db.prepare(`
    INSERT INTO calendar_events
      (title, description, location, start_datetime, end_datetime, all_day, recurrence_rule,
       created_by, external_source, visibility)
    VALUES ('MCP master', 'Current MCP description', 'Current MCP location', ?, ?, 0,
            'FREQ=DAILY;COUNT=4', ?, 'local', 'all')
  `).run(`${originalDate}T09:00:00`, `${originalDate}T10:00:00`, uid).lastInsertRowid;
  const childId = db.prepare(`
    INSERT INTO calendar_events
      (title, description, location, start_datetime, end_datetime, all_day, created_by,
       external_source, visibility, recurrence_parent_id, recurrence_id, overridden_fields)
    VALUES ('MCP moved override', 'Stale MCP description', 'Stale MCP location', ?, ?, 0, ?, 'local',
            'all', ?, ?, '["title","start_datetime","end_datetime","attachment","reminders"]')
  `).run(`${movedDate}T11:00:00`, `${movedDate}T12:00:00`, uid, masterId, originalDate)
    .lastInsertRowid;
  db.prepare(`
    INSERT INTO calendar_event_exceptions (event_id, exception_date)
    VALUES (?, ?)
  `).run(masterId, originalDate);

  const events = parseContent(await toolCall('list_upcoming_events', { limit: 100 }));
  const linked = events.find((event) => Number(event.id) === Number(childId));

  assert.ok(linked, 'moved linked occurrence missing from MCP upcoming output');
  assert.equal(linked.title, 'MCP moved override');
  assert.equal(linked.location, 'Current MCP location');
  assert.equal(linked.start_datetime, `${movedDate}T11:00:00`);
  assert.equal(linked.series_id, Number(masterId));
  assert.equal(linked.recurrence_id, originalDate);
  assert.equal(linked.is_occurrence_override, true);
  assert.equal(linked.attachment_owner_id, Number(childId));
  assert.equal(linked.reminder_owner_id, Number(childId));
  assert.equal(events.some((event) => Number(event.id) === Number(masterId)
    && event.recurrence_id === originalDate), false, 'original EXDATE slot must stay suppressed');
});

test('die schreibenden Kern-Tools antworten weiter in ihrer schlanken Form (#2616)', async () => {
  // Die Route antwortet mit der ganzen Zeile samt Zuweisungen, Anhängen und
  // Sync-Zielen. Ein LLM braucht davon sechs bis acht Felder; alles andere
  // kostet nur Kontext. Die Auswahl steht hier, damit sie nicht mit der
  // Routenantwort mitwächst.
  const task = parseContent(await toolCall('create_task', { title: 'Form der Antwort' }));
  assert.deepEqual(Object.keys(task),
    ['id', 'title', 'status', 'priority', 'category', 'due_date', 'due_time', 'tags']);
  // Die Werte, nicht nur die Schlüssel: eine Kennung als Text oder `tags` als
  // verbundener String fiele bei Object.keys nicht auf.
  assert.equal(typeof task.id, 'number');
  assert.equal(task.title, 'Form der Antwort');
  assert.equal(task.status, 'open');
  assert.equal(task.priority, 'none');
  assert.equal(task.category, 'misc');
  assert.equal(task.due_date, null);
  assert.equal(task.due_time, null);
  assert.ok(Array.isArray(task.tags), '`tags` ist eine Liste');
  const item = parseContent(await toolCall('add_shopping_item', { name: 'Form der Antwort', quantity: '3' }));
  assert.deepEqual(Object.keys(item), ['id', 'name', 'quantity', 'category', 'is_checked', 'list']);
  assert.equal(typeof item.id, 'number');
  assert.equal(item.name, 'Form der Antwort');
  assert.equal(item.quantity, '3');
  assert.equal(typeof item.category, 'string');
  assert.equal(item.list, 'Wocheneinkauf', '`list` ist der NAME der Liste, nicht ihre Kennung');
  assert.equal(item.is_checked, 0, '0/1 wie in der Spalte, kein Boolean');
  const event = parseContent(await toolCall('create_event',
    { title: 'Form der Antwort', start_datetime: `${in3days}T07:00` }));
  assert.deepEqual(Object.keys(event),
    ['id', 'title', 'start_datetime', 'end_datetime', 'all_day', 'location']);
  assert.equal(typeof event.id, 'number');
  assert.equal(event.title, 'Form der Antwort');
  assert.equal(event.start_datetime, `${in3days}T07:00`);
  assert.equal(event.end_datetime, null);
  assert.equal(event.all_day, 0);
  assert.equal(event.location, null);
});

// ── Idempotenz der schreibenden Kern-Tools (#2616) ───────────────────────────
//
// Opt-in über ein Argument, nicht über die JSON-RPC-id: ein Client, der seine
// ids hochzählt, hätte sonst Retry-Sicherheit, die er nie bestellt hat, und
// einer, der sie wiederverwendet, bekäme 409 auf eine neue Aufgabe.

test('tools/call create_task: derselbe idempotency_key legt genau einmal an (#2616)', async () => {
  const args = { title: 'Nur einmal anlegen', idempotency_key: 'mcp-task-once' };
  const first = await toolCall('create_task', args);
  const second = await toolCall('create_task', args);
  assert.equal(first.result.isError, false, first.result.content?.[0]?.text);
  assert.equal(second.result.isError, false, second.result.content?.[0]?.text);
  assert.equal(parseContent(second).id, parseContent(first).id, 'die Wiederholung muss dieselbe Aufgabe nennen');
  assert.equal(
    row(`SELECT COUNT(*) AS n FROM tasks WHERE title = 'Nur einmal anlegen'`).n, 1,
  );
});

test('tools/call create_task: ohne idempotency_key bleibt jede Wiederholung ein neuer Vorgang', async () => {
  // Die Gegenprobe zur Zeile darüber: ohne Schlüssel geht KEIN Header hinaus,
  // und für bestehende Aufrufer ändert sich damit nichts.
  await toolCall('create_task', { title: 'Zweimal gewollt' });
  await toolCall('create_task', { title: 'Zweimal gewollt' });
  assert.equal(
    row(`SELECT COUNT(*) AS n FROM tasks WHERE title = 'Zweimal gewollt'`).n, 2,
  );
});

test('tools/call add_shopping_item: derselbe Schlüssel für anderen Inhalt → Fehler der Route', async () => {
  const first = await toolCall('add_shopping_item', { name: 'Hefe', idempotency_key: 'mcp-item-once' });
  assert.equal(first.result.isError, false, first.result.content?.[0]?.text);
  const clash = await toolCall('add_shopping_item', { name: 'Mehl', idempotency_key: 'mcp-item-once' });
  assert.equal(clash.result.isError, true);
  // Der Grund der Route reist mit, damit das LLM den Unterschied zwischen
  // "schon angelegt" und "Schlüssel verbraucht" lesen kann.
  assert.match(clash.result.content[0].text, /already used for a different request/i);
  assert.match(clash.result.content[0].text, /\[reason: idempotency_key_reused\]/);
  assert.equal(db.prepare(`SELECT 1 FROM shopping_items WHERE name = 'Mehl'`).get(), undefined);
});

test('tools/call create_event: ein unbrauchbarer idempotency_key wird vorher abgewiesen', async () => {
  // Ein Zeilenumbruch im Header-Wert liesse `fetch` werfen - das wäre ein
  // interner Fehler statt einer Meldung, die der Aufrufer lesen kann.
  const res = await toolCall('create_event', {
    title: 'Kaputter Schlüssel', start_datetime: `${in3days}T10:00`, idempotency_key: 'a\nb',
  });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /idempotency_key/);
  assert.equal(db.prepare(`SELECT 1 FROM calendar_events WHERE title = 'Kaputter Schlüssel'`).get(), undefined);
});

// ── Die Grenze, die der Umbau zieht (#2616) ──────────────────────────────────

test('Schreiben mit Sitzungs-Cookie ohne CSRF-Token wird abgewiesen (#2616)', async () => {
  // DIESE GRENZE IST NEU UND SIE IST GEWOLLT. `/mcp` liegt ausserhalb der
  // /api/v1-Gates und kennt deshalb kein CSRF; die Route dahinter schon. Ein
  // MCP-Aufrufer, der sich mit einem Sitzungs-Cookie ausweist, konnte vor #2616
  // schreiben und braucht jetzt ein API-Token oder ein mitgeschicktes
  // CSRF-Token. Ohne diesen Test kippt sie still.
  const res = await rpc('tools/call', { name: 'create_task', arguments: { title: 'Ohne CSRF' } },
    1, { cookie: SESSION_COOKIE });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /Invalid CSRF token/);
  assert.equal(db.prepare(`SELECT 1 FROM tasks WHERE title = 'Ohne CSRF'`).get(), undefined);

  // `status`, `code` und `reason` hängen am Fehler, nicht nur im Text: wer die
  // Brücke programmatisch nutzt, soll den Grund nicht aus dem Satz lesen müssen.
  await assert.rejects(
    () => callTool(ctxFor({ cookie: SESSION_COOKIE }), 'create_task', { title: 'Ohne CSRF' }),
    (/** @type {any} */ err) => {
      assert.equal(err.status, 403);
      assert.equal(err.code, 403);
      assert.equal(err.reason, 'csrf_invalid');
      assert.match(err.message, /\[reason: csrf_invalid\]$/);
      return true;
    },
  );
});

test('Schreiben mit Sitzungs-Cookie UND gültigem CSRF-Token legt an (#2616)', async () => {
  // Die zweite Hälfte der Zusage: eine Sitzung, die ihr Token mitschickt, darf
  // schreiben. Das Token holt ein GET durch denselben Stapel, wie die App es tut.
  const probe = await fetch(`${LOOPBACK}/api/v1/tasks/categories`, { headers: { cookie: SESSION_COOKIE } });
  await probe.text();
  const token = probe.headers.get('x-csrf-token');
  assert.match(String(token), /^[0-9a-f]{64}$/);
  const res = await rpc('tools/call', { name: 'create_task', arguments: { title: 'Mit CSRF' } },
    1, { cookie: SESSION_COOKIE, 'x-csrf-token': token });
  assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
  assert.ok(row(`SELECT 1 FROM tasks WHERE title = 'Mit CSRF'`));
});

test('Loopback nicht erreichbar: eine Meldung mit MCP_INTERNAL_BASE_URL, kein interner Fehler (#2616)', async () => {
  // `BASE_URL` ist oft die öffentliche Adresse hinter einem Proxy. Wirft
  // `fetch`, soll der Aufrufer die Einstellung lesen, nicht "Internal error".
  const before = internalErrors.length;
  installFetchMock(async () => { throw new TypeError('fetch failed'); });
  let res;
  try {
    res = await toolCall('create_task', { title: 'Unerreichbar' });
  } finally {
    global.fetch = realFetch;
  }
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /MCP_INTERNAL_BASE_URL/);
  assert.doesNotMatch(res.result.content[0].text, /fetch failed|Internal error/);
  assert.equal(internalErrors.length, before);
});

// ── OpenAPI-Brücke: Metadaten (list/get) ─────────────────────────────────────

test('list_api_operations / get_api_operation: spiegeln die Live-OpenAPI-Spec', async () => {
  const listed = await toolCall('list_api_operations', { search: 'dashboard' });
  assert.equal(listed.result.isError, false);
  const payload = parseContent(listed);
  assert.ok(payload.count >= 1, 'Dashboard-Operation muss auffindbar sein');
  const dashboard = payload.operations.find((op) => op.operation_key === 'get_dashboard');
  assert.ok(dashboard, 'get_dashboard muss gelistet sein');
  assert.equal(dashboard.method, 'GET');
  assert.equal(dashboard.path, '/api/v1/dashboard');

  const described = await toolCall('get_api_operation', { operation_key: 'get_tasks_by_id' });
  assert.equal(described.result.isError, false);
  const operation = parseContent(described);
  assert.equal(operation.method, 'GET');
  assert.equal(operation.path, '/api/v1/tasks/{id}');
  assert.deepEqual(operation.path_parameters, ['id']);
});

test('get_api_operation: unbekannter operation_key → isError', async () => {
  const res = await toolCall('get_api_operation', { operation_key: 'does_not_exist' });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /Unknown operation_key/i);
});

// Modul installieren/loeschen geht nur aus einer Browser-Sitzung. Die Bruecke
// reicht aber auch ein Sitzungs-Cookie weiter (siehe Loopback-Test unten) -
// darum tragen die drei Operationen `x-mcp-exclude` und fehlen hier ganz.
test('x-mcp-exclude: Modul-Installation und -Loeschen sind ueber MCP weder gelistet noch aufrufbar', async () => {
  const listed = parseContent(await toolCall('list_api_operations', { tag: 'Modules' }));
  const keys = listed.operations.map((op) => op.operation_key);
  assert.ok(keys.includes('get_modules'), 'die Modulliste bleibt erreichbar');
  assert.ok(keys.includes('patch_modules_by_id'), 'das Ein-/Ausschalten bleibt erreichbar');
  for (const key of ['post_modules_install_zip', 'post_modules_install_github', 'delete_modules_by_id']) {
    assert.ok(!keys.includes(key), `${key} darf nicht gelistet sein`);
  }

  const calls = installFetchMock(() => jsonResponse({ data: {} }));
  try {
    for (const args of [
      { operation_key: 'post_modules_install_github', payload: { url: 'o/r' } },
      { operation_key: 'delete_modules_by_id', path_params: { id: 'x-mod' } },
      { method: 'DELETE', path: '/api/v1/modules/{id}', path_params: { id: 'x-mod' } },
    ]) {
      const res = await toolCallWithHeaders('call_api_operation', args, { cookie: 'sid=abc' });
      assert.equal(res.result.isError, true, JSON.stringify(args));
      assert.match(res.result.content[0].text, /not available through MCP/);
    }
    assert.equal(calls.length, 0, 'kein Loopback-Aufruf');
  } finally {
    global.fetch = realFetch;
  }
  const described = await toolCall('get_api_operation', { operation_key: 'delete_modules_by_id' });
  assert.equal(described.result.isError, true);

  // Das Ein-/Ausschalten bleibt gelistet, weil Ausschalten per Token nuetzlich
  // ist; dass Einschalten eine Sitzung braucht (Runde 3 von #1671), steht in
  // der Beschreibung, die der Assistent liest - sonst plant er den Schritt.
  const patch = parseContent(await toolCall('get_api_operation', { operation_key: 'patch_modules_by_id' }));
  assert.match(patch.description, /browser session/);
  assert.match(patch.description, /module_session_required/);
  assert.match(patch.description, /Disabling .* token/);
});

// ── OpenAPI-Brücke: call_api_operation (Loopback via gemocktem fetch) ─────────

test('call_api_operation GET: baut URL, leitet Auth-Header weiter, gibt Body zurück', async () => {
  const calls = installFetchMock(() => jsonResponse({ data: { open_tasks: 3 } }));
  try {
    const res = await toolCallWithHeaders(
      'call_api_operation',
      { operation_key: 'get_dashboard' },
      { authorization: 'Bearer test-token', cookie: 'sid=abc' },
    );
    assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
    assert.deepEqual(parseContent(res), { data: { open_tasks: 3 } });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${LOOPBACK}/api/v1/dashboard`);
    assert.equal(calls[0].options.method, 'GET');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
    assert.equal(calls[0].options.headers.Cookie, 'sid=abc');
    assert.equal(calls[0].options.body, undefined, 'GET darf keinen Body senden');
  } finally {
    global.fetch = realFetch;
  }
});

test('call_api_operation: ohne BASE_URL folgt der Selbstaufruf BIND_ADDRESS', async () => {
  // Bindet der Server nur an eine LAN-Adresse, ginge der Loopback-Default ins
  // Leere. Die Bruecke muss dieselbe Adresse fragen wie server/index.js.
  const saved = {
    MCP_INTERNAL_BASE_URL: process.env.MCP_INTERNAL_BASE_URL,
    BASE_URL: process.env.BASE_URL,
    BIND_ADDRESS: process.env.BIND_ADDRESS,
    PORT: process.env.PORT,
  };
  delete process.env.MCP_INTERNAL_BASE_URL;
  delete process.env.BASE_URL;
  process.env.BIND_ADDRESS = '192.168.1.5';
  process.env.PORT = '3100';
  const calls = installFetchMock(() => jsonResponse({ data: {} }));
  try {
    const res = await toolCallWithHeaders(
      'call_api_operation',
      { operation_key: 'get_dashboard' },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
    assert.equal(calls[0].url, 'http://192.168.1.5:3100/api/v1/dashboard');
  } finally {
    global.fetch = realFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('call_api_operation: rendert Path-Params und Query in die URL', async () => {
  const calls = installFetchMock(() => jsonResponse({ data: { id: 42 } }));
  try {
    const res = await toolCallWithHeaders(
      'call_api_operation',
      { operation_key: 'get_tasks_by_id', path_params: { id: 42 }, query: { expand: 'subtasks' } },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
    assert.equal(calls[0].url, `${LOOPBACK}/api/v1/tasks/42?expand=subtasks`);
    assert.equal(calls[0].options.method, 'GET');
  } finally {
    global.fetch = realFetch;
  }
});

test('call_api_operation POST: sendet JSON-Payload mit Content-Type', async () => {
  const calls = installFetchMock(() => jsonResponse({ data: { id: 7, title: 'Neu' } }));
  try {
    const res = await toolCallWithHeaders(
      'call_api_operation',
      { operation_key: 'post_tasks', payload: { title: 'Neu' } },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(calls[0].options.body), { title: 'Neu' });
  } finally {
    global.fetch = realFetch;
  }
});

// Issue #599: Clients, die Tool-Argumente typkoerzieren, schicken das Payload als
// JSON-String. Ohne Durchreichen entstünde ein doppelt kodiertes String-Primitive,
// das `express.json({ strict: true })` mit „Invalid JSON in request body" ablehnt.
test('call_api_operation POST: string-serialisiertes Payload wird nicht doppelt kodiert', async () => {
  const calls = installFetchMock(() => jsonResponse({ data: { id: 8, title: 'Neu' } }));
  try {
    const res = await toolCallWithHeaders(
      'call_api_operation',
      { operation_key: 'post_tasks', payload: '{"title":"Neu"}' },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
    assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(calls[0].options.body), { title: 'Neu' });
  } finally {
    global.fetch = realFetch;
  }
});

// #2197: die Felder neben `operation_key` statt in `payload` - vorher ging der
// POST ohne Body raus, die Felder fielen still weg, die Route antwortete 500.
test('call_api_operation POST: Body-Felder auf oberster Ebene → isError mit Hinweis auf payload (kein fetch)', async () => {
  const calls = installFetchMock(() => jsonResponse({}));
  try {
    const res = await toolCallWithHeaders(
      'call_api_operation',
      { operation_key: 'post_recipes', title: 'error-probe' },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /Unknown argument\(s\) title/);
    assert.match(res.result.content[0].text, /"payload"/);
    assert.equal(calls.length, 0, 'ohne payload darf kein Request ohne Body abgehen');
  } finally {
    global.fetch = realFetch;
  }
});

test('call_api_operation POST: Pflicht-Body ohne payload geht als {} raus, mit JSON-Content-Type (#2197)', async () => {
  const calls = installFetchMock(() => jsonResponse({ error: 'Titel is required.' }, { ok: false, status: 400 }));
  try {
    const res = await toolCallWithHeaders(
      'call_api_operation',
      { operation_key: 'post_recipes' },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /Titel is required/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
    assert.equal(calls[0].options.body, '{}');
  } finally {
    global.fetch = realFetch;
  }
});

test('call_api_operation GET: fremde Schluessel bleiben ohne Wirkung (kein Body-Hinweis)', async () => {
  const calls = installFetchMock(() => jsonResponse({ data: [] }));
  try {
    const res = await toolCallWithHeaders(
      'call_api_operation',
      { operation_key: 'get_recipes', title: 'egal' },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.body, undefined);
  } finally {
    global.fetch = realFetch;
  }
});

test('call_api_operation POST: unparsbares String-Payload → isError (kein fetch)', async () => {
  const calls = installFetchMock(() => jsonResponse({}));
  try {
    const res = await toolCallWithHeaders(
      'call_api_operation',
      { operation_key: 'post_tasks', payload: 'Neu' },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /payload must be a JSON object/i);
    assert.equal(calls.length, 0, 'ungültiges Payload darf keinen Request auslösen');
  } finally {
    global.fetch = realFetch;
  }
});

test('call_api_operation: fehlender Path-Parameter → isError (kein fetch)', async () => {
  const calls = installFetchMock(() => jsonResponse({}));
  try {
    const res = await toolCallWithHeaders(
      'call_api_operation',
      { operation_key: 'get_tasks_by_id' },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /Missing path parameter/i);
    assert.equal(calls.length, 0, 'ohne Path-Parameter darf kein Request abgehen');
  } finally {
    global.fetch = realFetch;
  }
});

test('call_api_operation: Upstream-Fehler wird als isError durchgereicht', async () => {
  installFetchMock(() => jsonResponse({ error: 'Task not found' }, { ok: false, status: 404 }));
  try {
    const res = await toolCallWithHeaders(
      'call_api_operation',
      { operation_key: 'get_tasks_by_id', path_params: { id: 999 } },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /Task not found/);
  } finally {
    global.fetch = realFetch;
  }
});

test('call_api_operation: ein `reason` der Route hängt an Meldung und Fehler (#2616)', async () => {
  installFetchMock(() => jsonResponse(
    { error: 'Task not found.', code: 404, reason: 'tasks_task_not_found' }, { ok: false, status: 404 },
  ));
  try {
    const res = await toolCallWithHeaders(
      'call_api_operation',
      { operation_key: 'get_tasks_by_id', path_params: { id: 999 } },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, true);
    assert.equal(res.result.content[0].text, 'Task not found. [reason: tasks_task_not_found]');
  } finally {
    global.fetch = realFetch;
  }
});

test('call_api_operation: kleine Binärantwort wird als base64 durchgereicht', async () => {
  installFetchMock(() => binaryResponse(Buffer.from('PDFDATA'), { contentLength: 7 }));
  try {
    const res = await toolCallWithHeaders(
      'call_api_operation',
      { operation_key: 'get_dashboard' },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
    const payload = parseContent(res);
    assert.equal(payload.content_type, 'application/octet-stream');
    assert.equal(Buffer.from(payload.content_base64, 'base64').toString(), 'PDFDATA');
  } finally {
    global.fetch = realFetch;
  }
});

test('call_api_operation: übergroße Binärantwort wird per Content-Length abgelehnt', async () => {
  const huge = 50 * 1024 * 1024; // 50 MiB > 5-MiB-Deckel
  const calls = installFetchMock(() => binaryResponse(Buffer.alloc(0), { contentLength: huge }));
  try {
    const res = await toolCallWithHeaders(
      'call_api_operation',
      { operation_key: 'get_dashboard' },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /too large/i);
    // Abweisung vor dem Puffern — arrayBuffer darf nicht angefasst werden.
    assert.equal(calls.length, 1);
  } finally {
    global.fetch = realFetch;
  }
});

// ── Protokoll-Fehlerpfade ────────────────────────────────────────────────────

test('unbekannte Methode → JSON-RPC-Fehler -32601', async () => {
  const res = await rpc('foo/bar');
  assert.equal(res.error.code, -32601);
});

test('tools/call mit unbekanntem Tool → isError', async () => {
  const res = await toolCall('teleport', {});
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /Unknown tool/i);
});

test('tools/call ohne Tool-Name → -32602', async () => {
  const res = await rpc('tools/call', {});
  assert.equal(res.error.code, -32602);
});

test('Notification (ohne id) liefert keine Antwort', async () => {
  const res = await rpc('notifications/initialized', undefined, null);
  assert.equal(res, null);
});

test('ungültiger Body → -32600', async () => {
  const res = await handleMcpRequest(db, actor, { jsonrpc: '1.0', method: 'x' });
  assert.equal(res.error.code, -32600);
});

test('callTool direkt: list_upcoming_events liefert ein Array', async () => {
  const events = await callTool({ db, actor }, 'list_upcoming_events', {});
  assert.ok(Array.isArray(events));
});

// ── Rechte-Durchsetzung der Tool-Schicht (#823) ──────────────────────────────
//
// Der Kern des Bugs: die Kern-Tools laufen in-process gegen SQLite und sehen die
// /api/v1-Middleware nie. Ein Mitglied mit `tasks: none` bekam über `list_tasks`
// trotzdem die Aufgaben, obwohl REST für dieselbe Person 403 lieferte.
// Die Modulrechte werden hier bewusst über resolvePermissions +
// buildSessionModuleAccess erzeugt und nicht als Handkarte geschrieben: geprüft
// werden soll die ganze Kette, nicht nur die letzte Funktion darin.

let restrictedSeq = 0;
function restrictedActor(modules) {
  const uid = db.prepare(
    `INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
     VALUES (?, 'Eingeschränkt', 'x', '#00FF00', 'member', 'child')`
  ).run(`restricted_${++restrictedSeq}`).lastInsertRowid;
  for (const [key, access] of Object.entries(modules)) {
    db.prepare(
      `INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
       VALUES ('user', ?, 'module', ?, ?)`
    ).run(String(uid), key, access);
  }
  const user = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(uid);
  return {
    kind: 'token',
    userId: uid,
    role: 'member',
    scopes: null,
    moduleAccess: buildSessionModuleAccess(resolvePermissions(db, user)),
  };
}

async function toolNamesFor(restrictedTo) {
  const res = await handleMcpRequest(
    db, restrictedTo,
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    (err) => internalErrors.push(err),
  );
  return res.result.tools.map((t) => t.name).sort();
}

test('Modul none: list_tasks verweigert statt zu liefern (#823)', async () => {
  const denied = restrictedActor({ tasks: 'none' });
  await assert.rejects(
    () => callTool({ db, actor: denied }, 'list_tasks', {}),
    /not permitted/i,
  );
  await assert.rejects(
    () => callTool({ db, actor: denied }, 'create_task', { title: 'Darf nicht entstehen' }),
    /not permitted/i,
  );
  // Gegenprobe: die Aufgabe ist wirklich nicht angelegt worden — ein Tool, das
  // erst schreibt und dann meckert, wäre die schlimmere Variante.
  const leaked = db.prepare('SELECT 1 FROM tasks WHERE title = ?').get('Darf nicht entstehen');
  assert.equal(leaked, undefined);
});

test('Modul read: Lesen erlaubt, Schreiben verweigert (#823)', async () => {
  const readOnly = restrictedActor({ tasks: 'read' });
  const tasks = await callTool({ db, actor: readOnly }, 'list_tasks', {});
  assert.ok(Array.isArray(tasks), 'Lesen bleibt erlaubt');
  await assert.rejects(
    () => callTool({ db, actor: readOnly }, 'create_task', { title: 'Nur-Lesen-Verstoß' }),
    /not permitted/i,
  );
});

test('Ein Token-Scope kann das Modulrecht nicht aufweiten (#823)', async () => {
  // Scopes schränken ein, sie gewähren nicht. Ein Token mit tasks:write, dessen
  // Nutzer tasks: none hat, bleibt draußen — sonst wäre das Ausstellen eines
  // Tokens eine Rechteausweitung.
  const denied = { ...restrictedActor({ tasks: 'none' }), scopes: ['tasks:write'] };
  await assert.rejects(
    () => callTool({ db, actor: denied }, 'list_tasks', {}),
    /not permitted/i,
  );
});

test('tools/list zeigt gesperrte Module gar nicht erst an (#823)', async () => {
  const denied = restrictedActor({ tasks: 'none', shopping: 'read' });
  const names = await toolNamesFor(denied);
  assert.equal(names.includes('list_tasks'), false);
  assert.equal(names.includes('create_task'), false);
  // shopping: read — lesendes Tool bleibt, schreibendes verschwindet.
  assert.equal(names.includes('list_shopping_items'), true);
  assert.equal(names.includes('add_shopping_item'), false);
  // Unbeschränkte Module und die Brücken-Tools bleiben unangetastet; letztere
  // setzen die Rechte am Loopback über den echten Middleware-Stapel durch.
  assert.equal(names.includes('list_upcoming_events'), true);
  assert.deepEqual(
    names.filter((n) => n.endsWith('_api_operation') || n === 'list_api_operations').sort(),
    ['call_api_operation', 'get_api_operation', 'list_api_operations'],
  );
});

test('Split-Guest erreicht kein Kern-Tool (#823)', async () => {
  // Gast-Konten für geteilte Ausgaben kommen unter /api/v1 nur an
  // /split-expenses; /mcp liegt außerhalb dieses Guards und hatte die Sperre
  // deshalb gar nicht.
  const guest = { kind: 'guest', userId: uid, role: 'member', scopes: null, moduleAccess: null };
  await assert.rejects(
    () => callTool({ db, actor: guest }, 'list_tasks', {}),
    /not permitted/i,
  );
  const names = await toolNamesFor(guest);
  assert.deepEqual(names, ['call_api_operation', 'get_api_operation', 'list_api_operations']);
});

test('Unbeschränktes Mitglied sieht weiterhin alle Tools', async () => {
  const plain = restrictedActor({});
  const names = await toolNamesFor(plain);
  assert.equal(names.length, TOOL_DEFINITIONS.length);
});

test('keine internen Fehler während der Testläufe', () => {
  assert.equal(internalErrors.length, 0, `unerwartete interne Fehler: ${internalErrors.map((e) => e.message).join('; ')}`);
});
