/**
 * Modul: Suche und Modulrechte (#467)
 * Zweck: Dieselbe Frage wie bei test-dashboard-permissions.js, einen Endpoint
 *        weiter: findet ein Mitglied über GET /api/v1/search Treffer aus einem
 *        Modul, das ihm auf `none` steht?
 *
 *        Die Suche filtert bisher nur nach Zeilen-Besitz - und selbst der ist
 *        lückenhaft: Termine, Kontakte und Einkaufsartikel haben gar keinen
 *        Betrachterfilter, weil sie Familienbesitz sind. Das ist für die
 *        Sichtbarkeits-Achse richtig und sagt über die Modul-Achse nichts.
 *
 *        Gemessen wird die echte HTTP-Antwort des echten Routers, nicht der
 *        Resolver: es geht darum, was auf der Leitung liegt.
 *
 * Ausführen: npm run test:search-permissions
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'search-permissions-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const {
  resolvePermissions, buildSessionModuleAccess, PERMISSION_MODULES,
} = await import('../server/permissions.js');
const { moduleForPath } = await import('../server/scopes.js');
const { default: searchRouter } = await import('../server/routes/search.js');

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

// --------------------------------------------------------------------------
// EIN Suchwort trifft ALLE acht Trefferarten (seit #1063 Phase 10: Waste kam
// als achte dazu). Das ist der Punkt: die Antwort der Suche ist ein Objekt aus
// acht Listen, und die Frage lautet nicht „findet er etwas", sondern „welche
// der acht bleiben ihm".
//
// Alles gehört dem KIND bzw. ist familiensichtbar, damit die Zeilen-Achse
// nichts wegnimmt - sonst prüfte der Test die falsche Achse.
// --------------------------------------------------------------------------
const MARKER = 'Wunderkerze';

db.prepare(`
  INSERT INTO tasks (title, priority, status, visibility, created_by)
  VALUES (?, 'medium', 'open', 'all', ?)
`).run(`${MARKER} besorgen`, KID);

db.prepare(`
  INSERT INTO calendar_events (title, start_datetime, visibility, created_by)
  VALUES (?, '2030-01-01T10:00:00Z', 'all', ?)
`).run(`${MARKER} anzünden`, PARENT);

db.prepare('INSERT INTO notes (title, content, created_by) VALUES (?, ?, ?)')
  .run(`${MARKER}-Notiz`, 'Text', KID);

db.prepare('INSERT INTO contacts (name, phone) VALUES (?, ?)')
  .run(`${MARKER} Handel GmbH`, '555-1');

const listId = db.prepare('INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)')
  .run('Silvester', PARENT).lastInsertRowid;
db.prepare('INSERT INTO shopping_items (list_id, name) VALUES (?, ?)').run(listId, `${MARKER} 10er`);

db.prepare(`
  INSERT INTO medications (user_id, name, dosage_text, visibility)
  VALUES (?, ?, '1 Tablette', 'private')
`).run(KID, `${MARKER}forte`);

db.prepare(`
  INSERT INTO health_activities (user_id, type, performed_at, note, visibility)
  VALUES (?, ?, '2030-01-01T08:00:00Z', 'Notiz', 'private')
`).run(KID, `${MARKER}lauf`);

db.prepare('INSERT INTO waste_types (name, color) VALUES (?, ?)')
  .run(`${MARKER}-Tonne`, '#22C55E');

// --------------------------------------------------------------------------
// Server: Auth-Schicht nachgestellt wie in server/auth.js
// (`applyRoleModuleAccess`) - Admin bekommt null (Bypass), ein eingeschränktes
// Mitglied die aufgelöste Modul→Access-Map.
// --------------------------------------------------------------------------
let actor = KID;
const app = express();
app.use((req, _res, next) => {
  const user = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(actor);
  req.authUserId = user.id;
  req.authRole = user.role;
  req.session = { userId: user.id, role: user.role };
  req.sessionModuleAccess = user.role === 'admin'
    ? null
    : buildSessionModuleAccess(resolvePermissions(db, user));
  next();
});
app.use('/api/v1/search', searchRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1/search`;

test.after(() => { server.close(); db.close(); });

async function searchAs(userId, q = MARKER) {
  actor = userId;
  const res = await fetch(`${base}?q=${encodeURIComponent(q)}`);
  assert.equal(res.status, 200, 'die Suche antwortet auch eingeschränkt mit 200 - gefiltert, nicht verweigert');
  return res.json();
}

function denyModules(userId, modules) {
  const ins = db.prepare(`
    INSERT OR REPLACE INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', ?, 'none')
  `);
  // subject_id wird als TEXT gehalten und auch so abgefragt (`loadSubjectRows`).
  for (const key of modules) ins.run(String(userId), key);
}

function clearModuleDenials(userId) {
  db.prepare("DELETE FROM access_permissions WHERE subject_type = 'user' AND subject_id = ?").run(String(userId));
}

// Trefferart → Permissions-Modul. Die Zuordnung ist die eigentliche Aussage
// dieses Tests und steht deshalb hier, nicht in fünf verstreuten Assertions.
const BUCKET_MODULE = {
  tasks: 'tasks',
  events: 'calendar',
  notes: 'notes',
  contacts: 'contacts',
  items: 'shopping',
  meds: 'health',
  activities: 'health',
  waste: 'waste',
};
const BUCKETS = Object.keys(BUCKET_MODULE);
const ALL_DENIED = PERMISSION_MODULES.map((m) => m.key);

// --------------------------------------------------------------------------
// Vorbedingung. Ohne sie sichert keine leere Trefferliste weiter unten etwas
// zu: eine Suche, die auch ungesperrt nichts fände, wäre gesperrt genauso leer.
// --------------------------------------------------------------------------
// GENAU EINER je Trefferart, nicht „mindestens einer". Die Zahl stand eine Weile
// auf „> 0", weil ein Einkaufsartikel doppelt im Suchindex stand - ein anderer
// Fehler, den dieser Test weder zementieren noch an dem er scheitern sollte.
// Seit Migration 151 ist er behoben, und damit ist die genaue Zahl wieder die
// schärfere Zusicherung: sie fiele auch auf, wenn eine Sperre eine Trefferart
// nur halbierte statt sie zu leeren.
test('Vorbedingung: ungesperrt findet das Mitglied in JEDER der acht Trefferarten etwas', async () => {
  clearModuleDenials(KID);
  const body = await searchAs(KID);

  for (const bucket of BUCKETS) {
    assert.equal(body[bucket]?.length, 1, `${bucket} hat genau einen Treffer auf „${MARKER}"`);
  }
});

// --------------------------------------------------------------------------
// Der Befund.
// --------------------------------------------------------------------------
test('Kalender auf `none`: die Suche findet den Termin nicht mehr', async () => {
  clearModuleDenials(KID);
  denyModules(KID, ['calendar']);

  const kid = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(KID);
  assert.equal(resolvePermissions(db, kid).modules.calendar, 'none', 'Vorbedingung: der Kalender ist gesperrt');

  const body = await searchAs(KID);
  assert.deepEqual(body.events, [], 'kein Termin-Treffer mehr');
  assert.ok(!JSON.stringify(body).includes(`${MARKER} anzünden`), 'der Titel steht nirgendwo in der Antwort');

  // Termine tragen KEINEN Besitzerfilter (Familienbesitz, #471) - hier hing also
  // nichts anderes davor, was den Treffer schon weggenommen hätte.
  assert.equal(body.tasks.length, 1, 'die anderen Trefferarten bleiben');
  assert.equal(body.contacts.length, 1);
});

test('Jede Sperre nimmt genau ihre Trefferart, und keine nimmt eine fremde mit', async () => {
  // Modul für Modul einzeln. `health` trägt zwei Trefferarten (Medikamente und
  // Aktivitäten) - beide müssen fallen, und nur die beiden.
  for (const moduleKey of [...new Set(Object.values(BUCKET_MODULE))]) {
    clearModuleDenials(KID);
    denyModules(KID, [moduleKey]);
    const body = await searchAs(KID);

    for (const bucket of BUCKETS) {
      if (BUCKET_MODULE[bucket] === moduleKey) {
        assert.deepEqual(body[bucket], [], `Sperre auf ${moduleKey}: ${bucket} liefert nichts mehr`);
      } else {
        assert.equal(body[bucket].length, 1, `Sperre auf ${moduleKey} darf ${bucket} nicht mit leeren`);
      }
    }
  }
  clearModuleDenials(KID);
});

test('`read` ist keine Sperre: wer nur lesen darf, findet weiterhin', async () => {
  clearModuleDenials(KID);
  db.prepare(`
    INSERT OR REPLACE INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', 'contacts', 'read')
  `).run(String(KID));

  const body = await searchAs(KID);
  assert.equal(body.contacts.length, 1, 'nur-lesend heißt lesen dürfen');
  clearModuleDenials(KID);
});

test('Rollenprofil wirkt genauso wie der Mitglied-Override', async () => {
  clearModuleDenials(KID);
  db.prepare(`
    INSERT OR REPLACE INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('role', 'child', 'module', 'shopping', 'none')
  `).run();
  try {
    const body = await searchAs(KID);
    assert.deepEqual(body.items, [], 'die Rolle „child" sperrt den Einkauf');
    assert.equal(body.notes.length, 1);
  } finally {
    db.prepare("DELETE FROM access_permissions WHERE subject_type = 'role'").run();
  }
});

test('Admin-Bypass: eine Sperre auf seiner Rolle nimmt dem Admin nichts weg', async () => {
  db.prepare(`
    INSERT OR REPLACE INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('role', 'parent', 'module', 'calendar', 'none')
  `).run();
  try {
    const body = await searchAs(PARENT);
    assert.equal(body.events.length, 1, 'kein Selbst-Aussperren (#467)');
  } finally {
    db.prepare("DELETE FROM access_permissions WHERE subject_type = 'role'").run();
  }
});

// --------------------------------------------------------------------------
// Der Guard für alles, was noch kommt. Er misst die Antwort, nicht den Fix:
// eine achte Trefferart ohne Modulzuordnung fällt hier auf, ohne dass jemand
// eine Liste pflegen muss.
// --------------------------------------------------------------------------
test('Guard: bei voller Sperre bleibt keine Trefferart übrig', async () => {
  clearModuleDenials(KID);
  const offen = await searchAs(KID);
  const belegt = Object.entries(offen).filter(([, v]) => Array.isArray(v) && v.length > 0);
  assert.ok(belegt.length >= 8, `Vorbedingung: ungesperrt sind mindestens 8 Listen belegt (${belegt.length})`);

  denyModules(KID, ALL_DENIED);
  const zu = await searchAs(KID);
  const uebrig = Object.entries(zu).filter(([, v]) => Array.isArray(v) && v.length > 0).map(([k]) => k);

  assert.deepEqual(uebrig, [], [
    'Diese Trefferarten liefern noch etwas, obwohl JEDES Modul gesperrt ist.',
    'Eine neue Trefferart braucht ihren Eintrag in BUCKET_MODULE',
    '(server/services/search.js) - sonst durchsucht sie ein Modul,',
    'das der Betrachter nicht öffnen darf.',
  ].join(' '));

  clearModuleDenials(KID);
});

// --------------------------------------------------------------------------
// Warum die Route selbst filtern muss.
// --------------------------------------------------------------------------
test('Die /api/v1-Modulsperre kann diesen Endpoint gar nicht abdecken', async () => {
  // Wie bei /dashboard: der Guard in server/index.js schlägt den Pfad in
  // scopes.js nach, /search ergibt den Schlüssel `search`, und der ist kein
  // Permissions-Modul - er steht also nie in der Access-Map und wird nie
  // geprüft. Wer diesen Test löscht, weil „das macht die Middleware", findet
  // hier den Grund, warum sie es nicht macht.
  clearModuleDenials(KID);
  denyModules(KID, ALL_DENIED);
  const kid = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(KID);
  const access = buildSessionModuleAccess(resolvePermissions(db, kid));

  assert.equal(moduleForPath('/search'), 'search', 'der Pfad löst auf ein Scope-Modul auf');
  assert.ok(!('search' in access), 'aber `search` ist kein Permissions-Modul → der Guard greift nie');
  assert.equal(access.contacts, 'none', 'gesperrt sind die Module, die die Suche DURCHSUCHT');
  clearModuleDenials(KID);
});
