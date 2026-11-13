/**
 * Modul: MCP-Endpoint-Rechte über die Leitung (#823)
 * Zweck: test:mcp prüft die Tool-Schicht mit einem HANDGEBAUTEN Akteur. Genau
 *        dieser Akteur entsteht aber erst im Router (server/mcp/server.js), und
 *        das war die Stelle des Bugs: die Kern-Tools laufen in-process gegen
 *        SQLite und sehen die /api/v1-Middleware nie, also muss alles, was diese
 *        Middleware prüft, im Akteur MITREISEN. Ein Test über die Tool-Schicht
 *        allein bliebe grün, wenn der Router `moduleAccess` schlicht nicht
 *        setzt - deshalb geht dieser hier über den echten Router und die echte
 *        JSON-RPC-Antwort: gemessen wird, was auf der Leitung liegt.
 *
 *        Die Auth-Schicht ist wie in test-dashboard-permissions.js nachgestellt
 *        (`applyRoleModuleAccess` aus server/auth.js), nicht nachgebaut: dieselben
 *        Felder, dieselbe Auflösung (`resolveRequestModuleAccess`, die auch die
 *        Verbindung an server/authorize/ reicht). Eine Anfrage MIT Bearer-Token
 *        geht stattdessen durch das echte `requireAuth`.
 *
 * Ausführen: npm run test:mcp-router-permissions
 */

import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'mcp-router-permissions-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { resolveRequestModuleAccess } = await import('../server/authorize/index.ts');
const { requireAuth } = await import('../server/auth.js');
const { default: mcpRouter } = await import('../server/mcp/server.js');

const moduleDatabase = get();
const db = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(db);
moduleDatabase.close();

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

function seedUser(prefix, role, familyRole) {
  return db.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
    VALUES (?, ?, 'hash', '#007AFF', ?, ?)
  `).run(`${prefix}-${randomUUID()}`, prefix, role, familyRole).lastInsertRowid;
}

const PARENT = seedUser('parent', 'admin', 'parent');
const KID = seedUser('kid', 'member', 'child');
const GUEST = seedUser('guest', 'member', 'other');

// Haushaltsweit sichtbare Aufgabe: die Zeilen-Privatsphäre (#474) darf hier
// NICHTS wegnehmen, sonst prüfte der Test die falsche Achse und wäre grün, ohne
// je ein Modulrecht angefasst zu haben.
db.prepare(`
  INSERT INTO tasks (title, priority, status, visibility, created_by)
  VALUES ('Heizung entlüften', 'high', 'open', 'all', ?)
`).run(PARENT);

// Gast-Konto für geteilte Ausgaben. Unter /api/v1 sperrt ein eigener Guard es
// auf /split-expenses ein; /mcp liegt ausserhalb und hatte die Sperre nicht.
const groupId = db.prepare(
  'INSERT INTO expense_groups (name, created_by) VALUES (?, ?)'
).run('Urlaub', PARENT).lastInsertRowid;
db.prepare(
  'INSERT INTO split_expense_guest_users (user_id, group_id, created_by) VALUES (?, ?, ?)'
).run(GUEST, groupId, PARENT);

db.prepare(`
  INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
  VALUES ('user', ?, 'module', 'tasks', 'none')
`).run(String(KID));

let actor = PARENT;
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  if (req.headers.authorization) return requireAuth(req, res, next);
  const user = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(actor);
  req.authUserId = user.id;
  req.authRole = user.role;
  req.authMethod = 'api_token';
  req.authScopes = null;                      // Legacy-Token: kein Scoping
  req.sessionModuleAccess = resolveRequestModuleAccess(db, req);
  next();
});
app.use('/mcp', mcpRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/mcp`;

test.after(() => { server.close(); db.close(); });

async function rpcAs(userId, method, params) {
  actor = userId;
  const res = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

const callAs = (userId, name, args = {}) => rpcAs(userId, 'tools/call', { name, arguments: args });
const toolsFor = async (userId) => (await rpcAs(userId, 'tools/list')).result.tools.map((t) => t.name).sort();

// ── Vorbedingung ─────────────────────────────────────────────────────────────
// OHNE SIE IST JEDE VERWEIGERUNG WEITER UNTEN WERTLOS: ein Tool, das auch
// unbeschränkt nichts liefert, sichert nichts zu.

test('Vorbedingung: unbeschränkt liefert list_tasks die Aufgabe', async () => {
  const res = await callAs(PARENT, 'list_tasks');
  assert.equal(res.result.isError, false);
  const tasks = JSON.parse(res.result.content[0].text);
  assert.equal(tasks.some((t) => t.title === 'Heizung entlüften'), true);
});

// ── Modulrechte ──────────────────────────────────────────────────────────────

test('Mitglied mit tasks=none bekommt über /mcp keine Aufgaben (#823)', async () => {
  const res = await callAs(KID, 'list_tasks');
  assert.equal(res.result.isError, true);
  // Der Titel darf in KEINEM Feld der Antwort auftauchen - gemessen wird die
  // Schadensebene (was auf der Leitung liegt), nicht die Fix-Ebene.
  assert.equal(JSON.stringify(res).includes('Heizung entlüften'), false);
});

test('Mitglied mit tasks=none sieht die Tasks-Tools nicht in tools/list (#823)', async () => {
  const names = await toolsFor(KID);
  assert.equal(names.includes('list_tasks'), false);
  assert.equal(names.includes('create_task'), false);
  // Gegenprobe: nur das gesperrte Modul fällt, der Rest bleibt bedienbar.
  assert.equal(names.includes('list_upcoming_events'), true);
  assert.equal(names.includes('call_api_operation'), true);
});

// ── Split-Guest ──────────────────────────────────────────────────────────────

test('Split-Guest erreicht über /mcp kein Kern-Tool (#823)', async () => {
  const res = await callAs(GUEST, 'list_tasks');
  assert.equal(res.result.isError, true);
  assert.equal(JSON.stringify(res).includes('Heizung entlüften'), false);
  assert.deepEqual(await toolsFor(GUEST), ['call_api_operation', 'get_api_operation', 'list_api_operations']);
});

test('Der Guest-Status hängt am Konto, nicht am Endpoint', async () => {
  // Gegenprobe zur Zeile darüber: derselbe Endpoint, ein Konto ohne
  // Gast-Eintrag - sonst könnte die Sperre auch schlicht „/mcp ist zu" heissen.
  assert.deepEqual(
    (await toolsFor(PARENT)).includes('list_tasks'),
    true,
  );
});

// ── Display-Konto per Token ──────────────────────────────────────────────────

/**
 * Ein Integrations-Token fuer `userId`, direkt in `api_tokens` (wie die Matrix ihre Feed-Tokens).
 * @param {number|bigint} userId
 * @returns {string}
 */
function tokenFor(userId) {
  const credential = randomBytes(24).toString('hex');
  db.prepare(`
    INSERT INTO api_tokens (name, token_hash, token_prefix, created_by, subject_user_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(`t-${randomUUID()}`, createHash('sha256').update(credential, 'utf8').digest('hex'), credential.slice(0, 12), PARENT, userId);
  return credential;
}

/**
 * @param {string} credential
 * @param {string} method
 * @param {object} [params]
 */
async function rpcWithToken(credential, method, params) {
  const res = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

test('Ein Display-Konto per API-Token bekommt ueber /mcp kein Werkzeug (#1208)', async () => {
  // Das Display-Cookie traegt seine Art selbst (`authMethod: 'display'`); ein
  // Token, das auf ein Display-Konto lautet, nicht - dort entscheidet allein die
  // Abfrage auf `display_accounts`. Die Route verweigert solche Tokens, also steht
  // es direkt in der Datenbank: es geht um das, was der Server tut, wenn es eins gibt.
  const wall = seedUser('wall', 'member', 'other');
  db.prepare('INSERT INTO display_accounts (user_id, created_by) VALUES (?, ?)').run(wall, PARENT);
  const credential = tokenFor(wall);
  const list = await rpcWithToken(credential, 'tools/list');
  assert.deepEqual(list.result.tools, []);
  const call = await rpcWithToken(credential, 'tools/call', { name: 'list_tasks', arguments: {} });
  assert.equal(call.result.isError, true);
  assert.equal(JSON.stringify(call).includes('Heizung entlüften'), false);

  // Gegenprobe: derselbe Weg mit einem Konto ohne Display-Zeile liefert aus.
  const plain = tokenFor(seedUser('plain', 'member', 'other'));
  const names = (await rpcWithToken(plain, 'tools/list')).result.tools.map((/** @type {{ name: string }} */ t) => t.name);
  assert.equal(names.includes('list_tasks'), true);
});
