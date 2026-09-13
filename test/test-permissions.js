/**
 * Tests: Rollen & Rechte (server/permissions.js)
 * Fokus:
 *   1. Auflösung: Admin-Bypass, Standard = Vollzugriff (rückwärtskompatibel),
 *      Rollen-Profil, Mitglied-Override gewinnt, Widget erbt Modulsperre.
 *   2. Session-Enforcement-Map: nur Abweichungen, null bei Vollzugriff/Admin.
 *   3. Speicherung: Sparse (Standard nicht gespeichert), Validierung, atomarer
 *      Ersatz, „von Rolle erben" via leerer Eingabe.
 * Hintergrund: Discussion #467.
 * Ausführen: node --experimental-sqlite --test test/test-permissions.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
import {
  resolvePermissions,
  buildSessionModuleAccess,
  moduleAccessVerdict,
  clientPermissions,
  permissionCatalog,
  getSubjectPermissions,
  replaceSubjectPermissions,
  normalizePermissionInput,
  isValidFamilyRole,
  PERMISSION_MODULES,
  PERMISSION_WIDGETS,
  PERMISSION_CAPABILITIES,
} from '../server/permissions.js';
import { WIDGET_IDS } from '../public/utils/dashboard-widgets.js';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(MIGRATIONS_SQL[1]);   // users
  db.exec(MIGRATIONS_SQL[74]);  // access_permissions
  db.exec(MIGRATIONS_SQL[175]); // capability resource type
  return db;
}

function addUser(db, { id, role = 'member', family_role = 'other', name = 'U' }) {
  db.prepare('INSERT INTO users (id, username, display_name, password_hash, role, family_role) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, `user${id}`, name, 'x', role, family_role);
  return db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(id);
}

test('migration 175 preserves overrides and permits capability resources', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(MIGRATIONS_SQL[74]);
  db.prepare(`
    INSERT INTO access_permissions
      (subject_type, subject_id, resource_type, resource_key, access, updated_at)
    VALUES ('role', 'child', 'module', 'notes', 'read', '2024-01-02T03:04:05Z')
  `).run();

  db.exec(MIGRATIONS_SQL[175]);

  assert.deepEqual(
    { ...db.prepare(`
      SELECT subject_type, subject_id, resource_type, resource_key, access, updated_at
      FROM access_permissions
    `).get() },
    {
      subject_type: 'role',
      subject_id: 'child',
      resource_type: 'module',
      resource_key: 'notes',
      access: 'read',
      updated_at: '2024-01-02T03:04:05Z',
    },
  );
  assert.doesNotThrow(() => db.prepare(`
    INSERT INTO access_permissions
      (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', '42', 'capability', 'example', 'allow')
  `).run());
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM access_permissions WHERE resource_type = 'capability'").get().count,
    1,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_access_permissions_subject'").get().count,
    1,
  );
  db.close();
});

// ── Auflösung ────────────────────────────────────────────────────────────────

test('Admin: Vollzugriff, admin-Flag, kein Scoping', () => {
  const db = freshDb();
  const admin = addUser(db, { id: 1, role: 'admin', family_role: 'dad' });
  const r = resolvePermissions(db, admin);
  assert.equal(r.admin, true);
  for (const m of PERMISSION_MODULES) assert.equal(r.modules[m.key], 'write');
  for (const w of PERMISSION_WIDGETS) assert.equal(r.widgets[w.id], 'allow');
  assert.equal(buildSessionModuleAccess(r), null);
});

test('Standard ohne Konfiguration: Vollzugriff (rückwärtskompatibel)', () => {
  const db = freshDb();
  const member = addUser(db, { id: 2, role: 'member', family_role: 'child' });
  const r = resolvePermissions(db, member);
  assert.equal(r.admin, false);
  assert.equal(r.modules.budget, 'write');
  assert.equal(r.widgets.cycle, 'allow');
  assert.equal(r.capabilities.notes_manage_household_categories, 'none');
  assert.equal(buildSessionModuleAccess(r), null); // nichts eingeschränkt
});

test('Haushaltskategorien: Admin darf immer verwalten', () => {
  const db = freshDb();
  const admin = addUser(db, { id: 20, role: 'admin', family_role: 'other' });
  const r = resolvePermissions(db, admin);
  assert.equal(r.capabilities.notes_manage_household_categories, 'allow');
});

test('Haushaltskategorien: Rolle kann erlauben, Mitglied-Override kann verbieten', () => {
  const db = freshDb();
  const child = addUser(db, { id: 21, family_role: 'child' });
  replaceSubjectPermissions(db, 'role', child.family_role, {
    capabilities: { notes_manage_household_categories: 'allow' },
  });
  assert.equal(resolvePermissions(db, child).capabilities.notes_manage_household_categories, 'allow');

  replaceSubjectPermissions(db, 'user', child.id, {
    capabilities: { notes_manage_household_categories: 'none' },
  });
  assert.equal(resolvePermissions(db, child).capabilities.notes_manage_household_categories, 'none');
});

test('Rollen-Profil greift für alle Mitglieder der Rolle', () => {
  const db = freshDb();
  const child = addUser(db, { id: 3, role: 'member', family_role: 'child' });
  replaceSubjectPermissions(db, 'role', 'child', { modules: { budget: 'none', housekeeping: 'read' } });
  const r = resolvePermissions(db, child);
  assert.equal(r.modules.budget, 'none');
  assert.equal(r.modules.housekeeping, 'read');
  assert.equal(r.modules.tasks, 'write'); // unkonfiguriert = Standard
  assert.deepEqual(buildSessionModuleAccess(r), { budget: 'none', housekeeping: 'read' });
});

test('Mitglied-Override gewinnt gegen Rollen-Profil', () => {
  const db = freshDb();
  const child = addUser(db, { id: 4, role: 'member', family_role: 'child' });
  replaceSubjectPermissions(db, 'role', 'child', { modules: { budget: 'none' } });
  replaceSubjectPermissions(db, 'user', 4, { modules: { budget: 'read' } });
  const r = resolvePermissions(db, child);
  assert.equal(r.modules.budget, 'read'); // Override statt Rollen-none
});

test('Widget erbt Modulsperre: Modul none ⇒ Widgets gesperrt', () => {
  const db = freshDb();
  const child = addUser(db, { id: 5, role: 'member', family_role: 'child' });
  replaceSubjectPermissions(db, 'role', 'child', { modules: { health: 'none' } });
  const r = resolvePermissions(db, child);
  assert.equal(r.widgets.health, 'none');
  assert.equal(r.widgets.cycle, 'none'); // cycle hängt an health
});

test('cycle-Widget einzeln sperrbar ohne Gesundheit zu sperren (#467)', () => {
  const db = freshDb();
  const dad = addUser(db, { id: 6, role: 'member', family_role: 'dad' });
  replaceSubjectPermissions(db, 'role', 'dad', { widgets: { cycle: 'none' } });
  const r = resolvePermissions(db, dad);
  assert.equal(r.modules.health, 'write'); // Modul bleibt voll nutzbar
  assert.equal(r.widgets.cycle, 'none');   // nur das Widget ist weg
  assert.equal(r.widgets.health, 'allow'); // andere Health-Widgets bleiben
});

test('Mitglied-Override kann cycle für eine Person sperren', () => {
  const db = freshDb();
  const child = addUser(db, { id: 7, role: 'member', family_role: 'child' });
  replaceSubjectPermissions(db, 'user', 7, { widgets: { cycle: 'none' } });
  const r = resolvePermissions(db, child);
  assert.equal(r.widgets.cycle, 'none');
});

// ── Session-Enforcement-Map ──────────────────────────────────────────────────

test('buildSessionModuleAccess: nur Abweichungen, write wird ausgelassen', () => {
  const db = freshDb();
  const child = addUser(db, { id: 8, role: 'member', family_role: 'child' });
  replaceSubjectPermissions(db, 'role', 'child', { modules: { budget: 'none', calendar: 'read', tasks: 'write' } });
  const map = buildSessionModuleAccess(resolvePermissions(db, child));
  assert.deepEqual(map, { budget: 'none', calendar: 'read' });
  assert.equal('tasks' in map, false);
});

// ── Speicherung / Validierung ────────────────────────────────────────────────

// ── Durchsetzung (geteilt von /api/v1 und MCP, #823) ─────────────────────────

test('moduleAccessVerdict: null lässt alles durch (Admin/unbeschränkt)', () => {
  assert.equal(moduleAccessVerdict(null, 'tasks', 'write'), 'allow');
  assert.equal(moduleAccessVerdict(undefined, 'tasks', 'write'), 'allow');
});

test('moduleAccessVerdict: Deny-Liste — nicht gelistete Module bleiben offen', () => {
  const map = { tasks: 'none' };
  assert.equal(moduleAccessVerdict(map, 'calendar', 'write'), 'allow');
  // Auch ein Pfad ohne Modulzuordnung darf nicht stillschweigend zufallen,
  // sonst wäre die App für eingeschränkte Mitglieder unbedienbar.
  assert.equal(moduleAccessVerdict(map, null, 'read'), 'allow');
});

test('moduleAccessVerdict: none sperrt beide Zugriffsarten', () => {
  const map = { tasks: 'none' };
  assert.equal(moduleAccessVerdict(map, 'tasks', 'read'), 'none');
  assert.equal(moduleAccessVerdict(map, 'tasks', 'write'), 'none');
});

test('moduleAccessVerdict: read erlaubt Lesen, weist Schreiben ab', () => {
  const map = { tasks: 'read' };
  assert.equal(moduleAccessVerdict(map, 'tasks', 'read'), 'allow');
  assert.equal(moduleAccessVerdict(map, 'tasks', 'write'), 'read-only');
});

test('Sparse: Standard-Werte werden nicht gespeichert', () => {
  const db = freshDb();
  addUser(db, { id: 9, role: 'member', family_role: 'parent' });
  replaceSubjectPermissions(db, 'role', 'parent', {
    modules: { budget: 'write', health: 'none' }, // write = Standard ⇒ verworfen
    widgets: { cycle: 'allow', family: 'none' },   // allow = Standard ⇒ verworfen
  });
  const stored = getSubjectPermissions(db, 'role', 'parent');
  assert.deepEqual(stored.modules, { health: 'none' });
  assert.deepEqual(stored.widgets, { family: 'none' });
});

test('replaceSubjectPermissions ersetzt atomar (kein Merge)', () => {
  const db = freshDb();
  addUser(db, { id: 10, role: 'member', family_role: 'relative' });
  replaceSubjectPermissions(db, 'role', 'relative', { modules: { budget: 'none' } });
  replaceSubjectPermissions(db, 'role', 'relative', { modules: { health: 'read' } });
  const stored = getSubjectPermissions(db, 'role', 'relative');
  assert.deepEqual(stored.modules, { health: 'read' }); // budget-Sperre ist weg
});

test('replaceSubjectPermissions erhält Capability-Zeilen beim Speichern von Modulen', () => {
  const db = freshDb();
  db.exec(MIGRATIONS_SQL[175]);
  db.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('role', 'child', 'capability', 'notes.categories', 'allow')
  `).run();

  replaceSubjectPermissions(db, 'role', 'child', { modules: { budget: 'none' } });

  assert.deepEqual(
    db.prepare(`
      SELECT resource_type, resource_key, access
      FROM access_permissions
      WHERE subject_type = 'role' AND subject_id = 'child'
      ORDER BY resource_type, resource_key
    `).all().map((row) => ({ ...row })),
    [
      { resource_type: 'capability', resource_key: 'notes.categories', access: 'allow' },
      { resource_type: 'module', resource_key: 'budget', access: 'none' },
    ],
  );
});

test('replaceSubjectPermissions ersetzt Capabilities nur bei ausdrücklichem Feld', () => {
  const db = freshDb();
  db.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('role', 'child', 'capability', 'notes_manage_household_categories', 'allow')
  `).run();

  replaceSubjectPermissions(db, 'role', 'child', { modules: {} });
  assert.deepEqual(getSubjectPermissions(db, 'role', 'child').capabilities, {
    notes_manage_household_categories: 'allow',
  });

  replaceSubjectPermissions(db, 'role', 'child', { capabilities: {} });
  assert.deepEqual(getSubjectPermissions(db, 'role', 'child').capabilities, {});
});

test('Leere Eingabe leert die alten Achsen und lässt ausgelassene Capabilities bestehen', () => {
  const db = freshDb();
  addUser(db, { id: 11, role: 'member', family_role: 'child' });
  replaceSubjectPermissions(db, 'user', 11, {
    modules: { budget: 'none' },
    capabilities: { notes_manage_household_categories: 'allow' },
  });
  replaceSubjectPermissions(db, 'user', 11, {}); // zurücksetzen
  assert.deepEqual(getSubjectPermissions(db, 'user', 11), {
    modules: {},
    widgets: {},
    capabilities: { notes_manage_household_categories: 'allow' },
  });
  replaceSubjectPermissions(db, 'user', 11, { capabilities: {} });
  assert.deepEqual(getSubjectPermissions(db, 'user', 11), { modules: {}, widgets: {}, capabilities: {} });
});

test('normalizePermissionInput: unbekannte/ungültige Werte werfen', () => {
  assert.throws(() => normalizePermissionInput({ modules: { nope: 'read' } }), /Unknown module/);
  assert.throws(() => normalizePermissionInput({ modules: { budget: 'bogus' } }), /Invalid module access/);
  assert.throws(() => normalizePermissionInput({ widgets: { nope: 'allow' } }), /Unknown widget/);
  assert.throws(() => normalizePermissionInput({ widgets: { cycle: 'read' } }), /Invalid widget access/);
});

test('Capability-Defaults bleiben bei Rollen sparse, Nutzer dürfen geerbtes allow aufheben', () => {
  const db = freshDb();
  const child = addUser(db, { id: 15, role: 'member', family_role: 'child' });

  replaceSubjectPermissions(db, 'role', 'child', {
    capabilities: { notes_manage_household_categories: 'none' },
  });
  assert.deepEqual(getSubjectPermissions(db, 'role', child.family_role).capabilities, {});

  replaceSubjectPermissions(db, 'role', child.family_role, {
    capabilities: { notes_manage_household_categories: 'allow' },
  });
  replaceSubjectPermissions(db, 'user', child.id, {
    capabilities: { notes_manage_household_categories: 'none' },
  });
  assert.deepEqual(getSubjectPermissions(db, 'user', child.id).capabilities, {
    notes_manage_household_categories: 'none',
  });
  assert.equal(resolvePermissions(db, child).capabilities.notes_manage_household_categories, 'none');
});

test('isValidFamilyRole', () => {
  assert.equal(isValidFamilyRole('child'), true);
  assert.equal(isValidFamilyRole('nope'), false);
});

test('permissionCatalog liefert Module, Widgets, Rollen, Levels', () => {
  const cat = permissionCatalog();
  assert.ok(cat.modules.some((m) => m.key === 'budget'));
  assert.ok(cat.widgets.some((w) => w.id === 'cycle' && w.module === 'health'));
  assert.ok(cat.roles.includes('child'));
  assert.deepEqual(cat.moduleAccessLevels, ['none', 'read', 'write']);
  assert.deepEqual(cat.widgetAccessLevels, ['none', 'allow']);
  assert.ok(cat.capabilities.some((item) => item.key === 'notes_manage_household_categories'));
  assert.deepEqual(cat.capabilityAccessLevels, ['none', 'allow']);
  assert.deepEqual(PERMISSION_CAPABILITIES.map((item) => item.key), ['notes_manage_household_categories', 'health_use_fasting']);
});

test('clientPermissions: kompakte Payload mit admin-Flag', () => {
  const db = freshDb();
  const child = addUser(db, { id: 12, role: 'member', family_role: 'child' });
  replaceSubjectPermissions(db, 'role', 'child', { modules: { budget: 'read' } });
  const p = clientPermissions(db, child);
  assert.equal(p.admin, false);
  assert.equal(p.modules.budget, 'read');
  assert.ok('cycle' in p.widgets);
});

// --------------------------------------------------------
// Guard: die drei Widget-Listen dürfen nicht auseinanderlaufen
// --------------------------------------------------------

/**
 * Ein Dashboard-Widget steht an drei Stellen: als ID im Raster, als sperrbare
 * Ressource in den Rechten und als Beschriftung in der Rechte-Oberfläche. Fehlt
 * es in der zweiten, kann ein Admin es als einziges nicht sperren; fehlt es in
 * der dritten, steht in seiner Zeile der rohe Slug. Beides fällt beim Bauen
 * eines neuen Widgets nicht auf - deshalb dieser Abgleich (statt einer Liste
 * erlaubter Ausnahmen: die deckte nur die Dateien ab, nicht die Regel).
 */
function idsFromSource(relativePath, pattern) {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf-8');
  const match = source.match(pattern);
  assert.ok(match, `${relativePath}: Widget-Liste nicht gefunden - Guard muss nachgezogen werden`);
  return match[1];
}

test('jedes Dashboard-Widget ist sperrbar und in der Rechte-UI benannt', () => {
  /* AUS DEM MODUL, NICHT AUS SEINEM QUELLTEXT (Etappe 7, 2026-08-13). Diese
   * Zeile las `WIDGET_IDS` per Regex aus `public/pages/dashboard.js`, und
   * `af2cac51` hat die Liste nach `utils/dashboard-widgets.js` gezogen: seitdem
   * fand das Muster nichts und die Suite war rot - auf ganzer Strecke, in einem
   * `npm test`, das niemand fuhr. Der Commit dort zaehlt sechs gruene Suiten
   * auf, und diese ist keine davon. Dieselbe Form wie beim Precache-Fund einen
   * Commit vorher: ein Umzug bricht eine Zusicherung zwei Dateien weiter.
   *
   * Der Import kann das nicht wieder passieren lassen - er schlaegt laut fehl,
   * wo ein Regex still leer zurueckkommt. Das Modul ist dafuer gebaut: es
   * haengt an nichts und laeuft in node (siehe seinen Kopf). */
  const dashboardIds = [...WIDGET_IDS];

  const labelKeys = idsFromSource(
    '../public/settings/pages/admin-permissions.js',
    /const WIDGET_LABEL_KEYS = \{([^}]+)\}/,
  )
    .split('\n')
    .map((line) => line.trim().match(/^([a-z_]+):/i)?.[1])
    .filter(Boolean);

  const permissionIds = PERMISSION_WIDGETS.map((w) => w.id);

  assert.deepEqual(
    [...dashboardIds].sort(),
    [...permissionIds].sort(),
    'WIDGET_IDS (utils/dashboard-widgets.js) und PERMISSION_WIDGETS (server/permissions.js) sind auseinandergelaufen',
  );
  assert.deepEqual(
    [...dashboardIds].sort(),
    [...labelKeys].sort(),
    'WIDGET_IDS (utils/dashboard-widgets.js) und WIDGET_LABEL_KEYS (admin-permissions.js) sind auseinandergelaufen',
  );
});
