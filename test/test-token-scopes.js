/**
 * Tests: Token-Scopes (server/scopes.js + MCP-Durchsetzung)
 * Fokus:
 *   1. Reines Scope-Modell: parseScopes / normalizeScopes / serializeScopes,
 *      requiredAccess (Methode → read/write), moduleForPath (Pfad → Modul),
 *      tokenAllows (null = voll, write ⊇ read, unbekannt = verweigert).
 *   2. MCP-Enforcement: tools/list ist auf die Scopes gefiltert, tools/call
 *      verweigert Tools außerhalb der Scopes; null-Scopes = voller Zugriff.
 * Hintergrund: Discussion #455 — an LLM-/MCP-Clients ausgegebene Tokens sollen
 *   per Modul und Lese-/Schreibrecht eingeschränkt werden können.
 * Ausführen: node --experimental-sqlite --test test/test-token-scopes.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
import {
  parseScopes, normalizeScopes, serializeScopes,
  requiredAccess, moduleForPath, tokenAllows, MODULE_KEYS, ALL_SCOPES,
} from '../server/scopes.js';
import { handleMcpRequest } from '../server/mcp/protocol.js';

// ── Scope-Modell (reine Funktionen) ──────────────────────────────────────────

test('parseScopes: null/leer/ungültig ⇒ null (= kein Scoping)', () => {
  assert.equal(parseScopes(null), null);
  assert.equal(parseScopes(undefined), null);
  assert.equal(parseScopes(''), null);
  assert.equal(parseScopes('   '), null);
  assert.equal(parseScopes('not json'), null);
  assert.equal(parseScopes('{"a":1}'), null); // kein Array
});

test('parseScopes: JSON-Array wird normalisiert', () => {
  assert.deepEqual(parseScopes('["calendar:write","tasks:read"]'), ['calendar:write', 'tasks:read']);
  // Array-Eingabe wird ebenfalls akzeptiert (idempotent).
  assert.deepEqual(parseScopes(['tasks:read', 'tasks:read']), ['tasks:read']);
});

test('normalizeScopes: verwirft Unbekanntes, dedupliziert, sortiert stabil', () => {
  assert.deepEqual(
    normalizeScopes(['tasks:write', 'bogus:read', 'tasks:write', 'calendar:read', 'HEALTH:WRITE']),
    ['calendar:read', 'health:write', 'tasks:write'],
  );
  assert.deepEqual(normalizeScopes([]), []);
  assert.deepEqual(normalizeScopes(['nope']), []);
});

test('serializeScopes: null bleibt null, sonst JSON-String', () => {
  assert.equal(serializeScopes(null), null);
  assert.equal(serializeScopes(['tasks:read']), '["tasks:read"]');
  assert.equal(serializeScopes(['bogus']), '[]');
});

test('requiredAccess: GET/HEAD/OPTIONS = read, sonst write', () => {
  for (const m of ['GET', 'get', 'HEAD', 'OPTIONS']) assert.equal(requiredAccess(m), 'read');
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(requiredAccess(m), 'write');
});

test('moduleForPath: Pfad-Prefix ⇒ Modul (inkl. geteilter Router)', () => {
  assert.equal(moduleForPath('/health/cycle'), 'health');
  assert.equal(moduleForPath('health'), 'health');
  assert.equal(moduleForPath('/reminders/all'), 'calendar');   // reminders gehört zu calendar
  assert.equal(moduleForPath('/birthdays'), 'calendar');
  assert.equal(moduleForPath('/split-expenses/x'), 'budget');  // split-expenses gehört zu budget
  assert.equal(moduleForPath('/recipes'), 'meals');
  // /recipe-providers gehört zu meals: sonst greift die Mitglieds-Zugriffssperre
  // (server/index.js #467) nicht, und ein auf meals='none' gesperrtes Mitglied
  // könnte GET /recipe-providers/status trotzdem abfragen (das selbst absichtlich
  // ohne eigenes Admin-Gate ist, siehe server/routes/recipe-providers.js).
  assert.equal(moduleForPath('/recipe-providers'), 'meals');
  assert.equal(moduleForPath('/preferences'), null);           // nicht scopebar
  assert.equal(moduleForPath('/'), null);
});

test('tokenAllows: null = voller Zugriff auf alles', () => {
  assert.equal(tokenAllows(null, 'health', 'read'), true);
  assert.equal(tokenAllows(null, 'health', 'write'), true);
  assert.equal(tokenAllows(null, null, 'read'), true);
});

test('tokenAllows: write schließt read ein, read erlaubt kein write', () => {
  assert.equal(tokenAllows(['calendar:write'], 'calendar', 'write'), true);
  assert.equal(tokenAllows(['calendar:write'], 'calendar', 'read'), true);   // write ⊇ read
  assert.equal(tokenAllows(['calendar:read'], 'calendar', 'read'), true);
  assert.equal(tokenAllows(['calendar:read'], 'calendar', 'write'), false);
});

test('tokenAllows: nicht gelistetes/unbekanntes Modul wird verweigert', () => {
  const scopes = ['calendar:write', 'tasks:read'];
  assert.equal(tokenAllows(scopes, 'health', 'read'), false);   // Kern des #455-Beispiels
  assert.equal(tokenAllows(scopes, 'budget', 'read'), false);
  assert.equal(tokenAllows(scopes, null, 'read'), false);        // unbekannter Pfad
  assert.equal(tokenAllows([], 'calendar', 'read'), false);      // leere Allowlist = nichts
});

test('ALL_SCOPES deckt jedes Modul in beiden Zugriffsarten ab', () => {
  assert.equal(ALL_SCOPES.length, MODULE_KEYS.length * 2);
  assert.ok(ALL_SCOPES.includes('health:read'));
  assert.ok(ALL_SCOPES.includes('health:write'));
});

// ── MCP-Enforcement über handleMcpRequest ────────────────────────────────────

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
db.prepare(`INSERT INTO shopping_lists (name, created_by) VALUES ('Wocheneinkauf', ?)`).run(uid);

function listToolNames(scopes) {
  return handleMcpRequest(db, { id: uid, role: 'admin', scopes },
    { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    .then((res) => res.result.tools.map((t) => t.name));
}
function callToolRes(scopes, name, args = {}) {
  return handleMcpRequest(db, { id: uid, role: 'admin', scopes },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
}

test('tools/list: null-Scopes zeigen alle Tools (Legacy-Token)', async () => {
  const names = await listToolNames(null);
  for (const n of ['list_tasks', 'create_task', 'list_upcoming_events', 'create_event',
    'list_shopping_items', 'add_shopping_item', 'call_api_operation']) {
    assert.ok(names.includes(n), `erwartet ${n}`);
  }
});

test('tools/list: calendar:write zeigt nur Kalender-Tools + Brücke', async () => {
  const names = await listToolNames(['calendar:write']);
  assert.ok(names.includes('list_upcoming_events'));
  assert.ok(names.includes('create_event'));
  // Brücken-/Meta-Tools bleiben sichtbar (Scopes greifen serverseitig am REST-Layer).
  assert.ok(names.includes('call_api_operation'));
  assert.ok(names.includes('list_api_operations'));
  // Fremde Module ausgeblendet:
  assert.ok(!names.includes('list_tasks'));
  assert.ok(!names.includes('create_task'));
  assert.ok(!names.includes('add_shopping_item'));
});

test('tools/list: tasks:read blendet Schreib-Tool aus', async () => {
  const names = await listToolNames(['tasks:read']);
  assert.ok(names.includes('list_tasks'));
  assert.ok(!names.includes('create_task')); // write nicht gewährt
});

test('tools/call: read-Scope erlaubt Lesen, verweigert Schreiben', async () => {
  const okRes = await callToolRes(['tasks:read'], 'list_tasks', {});
  assert.equal(okRes.result.isError, false);

  const denied = await callToolRes(['tasks:read'], 'create_task', { title: 'X', priority: 'high' });
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /not permitted by this token's scopes/);
});

test('tools/call: write-Scope erlaubt Anlegen, andere Module bleiben gesperrt', async () => {
  const created = await callToolRes(['tasks:write'], 'create_task', { title: 'Rasen mähen', priority: 'high' });
  assert.equal(created.result.isError, false);

  const denied = await callToolRes(['calendar:write'], 'list_tasks', {});
  assert.equal(denied.result.isError, true);
});

test('tools/call: null-Scopes erlauben jedes Kern-Tool', async () => {
  const res = await callToolRes(null, 'list_shopping_items', {});
  assert.equal(res.result.isError, false);
});
