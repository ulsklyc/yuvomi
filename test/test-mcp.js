/**
 * Tests: MCP-Server (server/mcp/*)
 * Fokus: JSON-RPC-Dispatch (initialize / tools/list / tools/call), Kern-Tool-Logik
 *        (Anlegen + Lesen), Validierung und Fehlerpfade sowie die generische
 *        OpenAPI-Brücke (list/get/call_api_operation) inklusive Loopback-Verhalten
 *        (Operation-Auflösung, Path-Params, Query, Auth-Weiterleitung, Payload,
 *        Fehlerpropagation) über einen gemockten `fetch`.
 * Ausführen: node --experimental-sqlite --test test/test-mcp.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
import { handleMcpRequest, LATEST_PROTOCOL_VERSION } from '../server/mcp/protocol.js';
import { callTool, TOOL_DEFINITIONS } from '../server/mcp/tools.js';

// Deterministische Loopback-Basis für die OpenAPI-Brücke (fetch wird gemockt).
process.env.MCP_INTERNAL_BASE_URL = 'http://mcp.test';

// ── Test-DB aufsetzen ────────────────────────────────────────────────────────
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);`);
db.exec(MIGRATIONS_SQL[1]);

const uid = db.prepare(
  `INSERT INTO users (username, display_name, password_hash, avatar_color, role)
   VALUES ('admin', 'Anna', 'x', '#007AFF', 'admin')`
).run().lastInsertRowid;

const listId = db.prepare(
  `INSERT INTO shopping_lists (name, created_by) VALUES ('Wocheneinkauf', ?)`
).run(uid).lastInsertRowid;

const in3days = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

const actor = { id: uid, role: 'admin' };

// Hilfsfunktion: JSON-RPC-Request absetzen und Antwort zurückgeben.
let internalErrors = [];
function rpc(method, params, id = 1) {
  const body = { jsonrpc: '2.0', method };
  if (params !== undefined) body.params = params;
  if (id !== null) body.id = id;
  return handleMcpRequest(db, actor, body, (err) => internalErrors.push(err));
}
function toolCall(name, args) {
  return rpc('tools/call', { name, arguments: args });
}
function toolCallWithHeaders(name, args, requestHeaders) {
  return handleMcpRequest(
    db, actor,
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    (err) => internalErrors.push(err),
    { requestHeaders },
  );
}
function parseContent(res) {
  return JSON.parse(res.result.content[0].text);
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

test('tools/call create_task: fehlender Titel → isError mit Meldung', async () => {
  const res = await toolCall('create_task', {});
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /title/i);
});

test('tools/call create_task: ungültige Priorität → isError', async () => {
  const res = await toolCall('create_task', { title: 'X', priority: 'sofort' });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /priority/i);
});

// ── list_tasks ───────────────────────────────────────────────────────────────

test('tools/call list_tasks: enthält den neu angelegten Task', async () => {
  const res = await toolCall('list_tasks', {});
  assert.equal(res.result.isError, false);
  const tasks = parseContent(res);
  assert.ok(tasks.some((t) => t.title === 'Müll rausbringen'), 'neuer Task muss gelistet sein');
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

test('tools/call create_event: fehlender Start → isError', async () => {
  const res = await toolCall('create_event', { title: 'Ohne Start' });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /start_datetime/i);
});

test('tools/call list_upcoming_events: enthält das neue Event', async () => {
  const events = parseContent(await toolCall('list_upcoming_events', { limit: 10 }));
  assert.ok(events.some((e) => e.title === 'Zahnarzt'));
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
    assert.equal(calls[0].url, 'http://mcp.test/api/v1/dashboard');
    assert.equal(calls[0].options.method, 'GET');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
    assert.equal(calls[0].options.headers.Cookie, 'sid=abc');
    assert.equal(calls[0].options.body, undefined, 'GET darf keinen Body senden');
  } finally {
    global.fetch = realFetch;
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
    assert.equal(calls[0].url, 'http://mcp.test/api/v1/tasks/42?expand=subtasks');
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

test('keine internen Fehler während der Testläufe', () => {
  assert.equal(internalErrors.length, 0, `unerwartete interne Fehler: ${internalErrors.map((e) => e.message).join('; ')}`);
});
