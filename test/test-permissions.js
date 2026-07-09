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
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
import {
  resolvePermissions,
  buildSessionModuleAccess,
  clientPermissions,
  permissionCatalog,
  getSubjectPermissions,
  replaceSubjectPermissions,
  normalizePermissionInput,
  isValidFamilyRole,
  PERMISSION_MODULES,
  PERMISSION_WIDGETS,
} from '../server/permissions.js';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(MIGRATIONS_SQL[1]);   // users
  db.exec(MIGRATIONS_SQL[74]);  // access_permissions
  return db;
}

function addUser(db, { id, role = 'member', family_role = 'other', name = 'U' }) {
  db.prepare('INSERT INTO users (id, username, display_name, password_hash, role, family_role) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, `user${id}`, name, 'x', role, family_role);
  return db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(id);
}

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
  assert.equal(buildSessionModuleAccess(r), null); // nichts eingeschränkt
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

test('Leere Eingabe = „von Rolle erben" (alle Overrides entfernt)', () => {
  const db = freshDb();
  addUser(db, { id: 11, role: 'member', family_role: 'child' });
  replaceSubjectPermissions(db, 'user', 11, { modules: { budget: 'none' } });
  replaceSubjectPermissions(db, 'user', 11, {}); // zurücksetzen
  assert.deepEqual(getSubjectPermissions(db, 'user', 11), { modules: {}, widgets: {} });
});

test('normalizePermissionInput: unbekannte/ungültige Werte werfen', () => {
  assert.throws(() => normalizePermissionInput({ modules: { nope: 'read' } }), /Unknown module/);
  assert.throws(() => normalizePermissionInput({ modules: { budget: 'bogus' } }), /Invalid module access/);
  assert.throws(() => normalizePermissionInput({ widgets: { nope: 'allow' } }), /Unknown widget/);
  assert.throws(() => normalizePermissionInput({ widgets: { cycle: 'read' } }), /Invalid widget access/);
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
