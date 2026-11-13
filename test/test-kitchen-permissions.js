/**
 * Modul: Küchen-Leiste und Modulrechte (#467)
 * Zweck: `GET /api/v1/kitchen/summary` trägt zwei Module in einer Antwort
 *        (Einkauf und Vorrat) und ist der dritte Endpunkt, den der Pfad-Guard
 *        in server/index.js nicht erreicht - `kitchen` ist nicht einmal ein
 *        Scope-Modul, `moduleForPath('/kitchen')` ergibt null.
 *
 *        Es sind nur Zahlen und keine Titel. Die Leiste rendert aber auf JEDER
 *        Küchen-Seite, also auch beim Essensplan: ein Mitglied ohne
 *        Einkaufszugriff sah dort ein Abzeichen „7 offen" für eine Liste, die
 *        es nicht öffnen darf.
 *
 * Ausführen: npm run test:kitchen-permissions
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'kitchen-permissions-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { resolvePermissions, buildSessionModuleAccess } = await import('../server/authorize/index.ts');
const { moduleForPath } = await import('../server/scopes.js');
const { default: kitchenRouter } = await import('../server/routes/kitchen.js');

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

// Je Modul genau ein Grund, eine Zahl > 0 zu melden.
const listId = db.prepare('INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)')
  .run('Wocheneinkauf', PARENT).lastInsertRowid;
db.prepare('INSERT INTO shopping_items (list_id, name, is_checked) VALUES (?, ?, 0)').run(listId, 'Milch');

db.prepare(`
  INSERT INTO pantry_items (name, quantity, min_quantity, expires_on)
  VALUES ('Mehl', 0, 1, '2000-01-01')
`).run();

let actor = KID;
const app = express();
app.use((req, _res, next) => {
  const user = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(actor);
  req.authUserId = user.id;
  req.authRole = user.role;
  req.session = { userId: user.id, role: user.role };
  // Wie server/auth.js (`applyRoleModuleAccess`).
  req.sessionModuleAccess = user.role === 'admin'
    ? null
    : buildSessionModuleAccess(resolvePermissions(db, user));
  next();
});
app.use('/api/v1/kitchen', kitchenRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1/kitchen/summary`;

test.after(() => { server.close(); db.close(); });

async function summaryAs(userId) {
  actor = userId;
  const res = await fetch(base);
  assert.equal(res.status, 200);
  return (await res.json()).data;
}

function denyModules(userId, modules) {
  const ins = db.prepare(`
    INSERT OR REPLACE INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', ?, 'none')
  `);
  for (const key of modules) ins.run(String(userId), key);
}

function clearModuleDenials(userId) {
  db.prepare("DELETE FROM access_permissions WHERE subject_type = 'user' AND subject_id = ?").run(String(userId));
}

// Vorbedingung zuerst: ohne sie sagt jede Null weiter unten nichts aus.
test('Vorbedingung: ungesperrt meldet die Leiste beide Zahlen', async () => {
  clearModuleDenials(KID);
  const data = await summaryAs(KID);
  assert.equal(data.shopping.open, 1);
  assert.equal(data.pantry.attention, 1);
  assert.equal(data.pantry.expired, 1);
  assert.equal(data.pantry.out, 1);
});

test('Einkauf auf `none`: kein Abzeichen mehr, der Vorrat bleibt', async () => {
  clearModuleDenials(KID);
  denyModules(KID, ['shopping']);
  const data = await summaryAs(KID);
  assert.equal(data.shopping.open, 0, 'die Zahl über einen gesperrten Bestand entfällt');
  assert.equal(data.pantry.attention, 1, 'der Vorrat ist ein eigenes Modul und bleibt');
  clearModuleDenials(KID);
});

test('Vorrat auf `none`: alle vier Vorratszahlen entfallen, der Einkauf bleibt', async () => {
  clearModuleDenials(KID);
  denyModules(KID, ['pantry']);
  const data = await summaryAs(KID);
  assert.deepEqual(data.pantry, { attention: 0, expired: 0, low: 0, out: 0 }, 'die Form bleibt, die Zahlen gehen');
  assert.equal(data.shopping.open, 1, 'der Einkauf bleibt');
  clearModuleDenials(KID);
});

test('Beide gesperrt: die Antwort behält ihre Form und meldet nichts', async () => {
  clearModuleDenials(KID);
  denyModules(KID, ['shopping', 'pantry']);
  const data = await summaryAs(KID);
  assert.deepEqual(data, {
    shopping: { open: 0 },
    pantry: { attention: 0, expired: 0, low: 0, out: 0 },
  }, 'kein fehlendes Feld - die Leiste liest sie ohne Fallunterscheidung');
  clearModuleDenials(KID);
});

test('Admin-Bypass und `read` nehmen nichts weg', async () => {
  db.prepare(`
    INSERT OR REPLACE INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', 'shopping', 'none')
  `).run(String(PARENT));
  db.prepare(`
    INSERT OR REPLACE INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', 'pantry', 'read')
  `).run(String(KID));
  try {
    assert.equal((await summaryAs(PARENT)).shopping.open, 1, 'kein Selbst-Aussperren (#467)');
    assert.equal((await summaryAs(KID)).pantry.attention, 1, 'nur-lesend heißt lesen dürfen');
  } finally {
    clearModuleDenials(PARENT);
    clearModuleDenials(KID);
  }
});

test('Die /api/v1-Modulsperre kann diesen Endpoint gar nicht abdecken', async () => {
  // Schwächer als bei /dashboard und /search: dort löst der Pfad wenigstens auf
  // ein Scope-Modul auf. `kitchen` ist gar keins - der Guard sieht null und
  // lässt durch, ohne je eine Rechte-Karte zu befragen.
  assert.equal(moduleForPath('/kitchen'), null, '`kitchen` ist kein Scope-Modul');
  const kid = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(KID);
  denyModules(KID, ['shopping', 'pantry']);
  const access = buildSessionModuleAccess(resolvePermissions(db, kid));
  assert.equal(access.shopping, 'none', 'gesperrt ist, was die Route zählt');
  clearModuleDenials(KID);
});
