/**
 * Test: Bestehende Kinderkonten starten ohne Zyklus-Tab (Migration 258, #2148)
 * Zweck: Seit R21 schreibt `applyChildStartPermissions()` fuer ein NEUES Kind
 *        `health_cycle_enabled:user:<id>` = '0'. Migration 258 zieht das fuer
 *        Kinder von vorher nach - aber nur, wo nichts steht:
 *          - Kind ohne Zeile -> '0' (Zyklus aus);
 *          - Kind mit eigener Wahl ('1' oder '0') -> bleibt;
 *          - Kind mit Zyklusdaten (Periode, Tageslog oder Einstellungen) und
 *            ohne Zeile -> bleibt ohne Zeile, behaelt also den Tab;
 *          - Erwachsene und Admins (auch mit Familienrolle child) -> unberuehrt;
 *          - zweiter Lauf aendert nichts;
 *          - die Fasten-Capability bleibt unberuehrt (keine Mitglied-Zeile ist
 *            nicht eindeutig "nie geaendert", siehe Kommentar an Migration 258);
 *          - der Schluessel ist derselbe, den die Laufzeit fuer neue Kinder
 *            schreibt und `healthCycleViews()` liest.
 * Ausfuehren: npm run test:child-health-defaults-migration
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'child-health-defaults-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';

const dbmod = await import('../server/db.js');
const { applyChildStartPermissions, CHILD_START_PREFERENCES } = await import('../server/permissions.js');
const db = dbmod.get();

const migration = dbmod.MIGRATIONS.find((m) => m.version === 258);

function addUser(username, role, familyRole) {
  return Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role, family_role)
    VALUES (?, ?, 'x', ?, ?)
  `).run(username, username, role, familyRole).lastInsertRowid);
}

function cycleRow(userId) {
  return db.prepare('SELECT value FROM sync_config WHERE key = ?').get(`health_cycle_enabled:user:${userId}`)?.value ?? null;
}

function setCycle(userId, value) {
  db.prepare('INSERT INTO sync_config (key, value) VALUES (?, ?)').run(`health_cycle_enabled:user:${userId}`, value);
}

function capabilityRows(userId) {
  return db.prepare(`
    SELECT resource_key, access FROM access_permissions
    WHERE subject_type = 'user' AND subject_id = ? AND resource_type = 'capability'
  `).all(String(userId));
}

const CHILD_UNTOUCHED = addUser('kind-ohne', 'member', 'child');
const CHILD_CHOSE_ON = addUser('kind-an', 'member', 'child');
const CHILD_CHOSE_OFF = addUser('kind-aus', 'member', 'child');
const ADULT = addUser('papa', 'member', 'dad');
const ADMIN = addUser('mama', 'admin', 'mom');
const ADMIN_CHILD = addUser('kind-admin', 'admin', 'child');
setCycle(CHILD_CHOSE_ON, '1');
setCycle(CHILD_CHOSE_OFF, '0');
// Kinder, die den Zyklus benutzen, ohne den Schalter je angefasst zu haben -
// je eines pro Tabelle, damit jede Ausnahme einzeln haelt.
const CHILD_WITH_PERIOD = addUser('kind-periode', 'member', 'child');
const CHILD_WITH_DAY_LOG = addUser('kind-tageslog', 'member', 'child');
const CHILD_WITH_SETTINGS = addUser('kind-einstellungen', 'member', 'child');
db.prepare("INSERT INTO cycle_periods (user_id, start_date) VALUES (?, '2026-09-01')").run(CHILD_WITH_PERIOD);
db.prepare("INSERT INTO cycle_day_logs (user_id, log_date, flow) VALUES (?, '2026-09-02', 'light')").run(CHILD_WITH_DAY_LOG);
db.prepare('INSERT INTO cycle_settings (user_id) VALUES (?)').run(CHILD_WITH_SETTINGS);

test('Migration 258 ist die Zyklus-Vorgabe fuer bestehende Kinder', () => {
  assert.ok(migration, 'Migration 258 fehlt');
  assert.equal(typeof migration.up, 'function');
  migration.up(db);
});

test('Kind ohne Eintrag startet ohne Zyklus', () => {
  assert.equal(cycleRow(CHILD_UNTOUCHED), '0');
});

test('eine eigene Wahl bleibt, auch das ausdrueckliche Ja', () => {
  assert.equal(cycleRow(CHILD_CHOSE_ON), '1');
  assert.equal(cycleRow(CHILD_CHOSE_OFF), '0');
});

test('ein Kind mit Zyklusdaten behaelt den Tab, auch ohne Zeile', () => {
  assert.equal(cycleRow(CHILD_WITH_PERIOD), null, 'Periode eingetragen');
  assert.equal(cycleRow(CHILD_WITH_DAY_LOG), null, 'Tageslog eingetragen');
  assert.equal(cycleRow(CHILD_WITH_SETTINGS), null, 'Zyklus-Einstellungen gespeichert');
});

test('Erwachsene und Admins bleiben unberuehrt', () => {
  assert.equal(cycleRow(ADULT), null);
  assert.equal(cycleRow(ADMIN), null);
  assert.equal(cycleRow(ADMIN_CHILD), null, 'ein Admin mit Familienrolle child umgeht die Kinder-Vorgaben wie bei der Anlage');
});

test('die Fasten-Capability bleibt unberuehrt', () => {
  for (const id of [CHILD_UNTOUCHED, CHILD_CHOSE_ON, CHILD_CHOSE_OFF, ADULT]) {
    assert.deepEqual(capabilityRows(id), [], `Konto ${id} darf keine Capability-Zeile bekommen`);
  }
});

test('ein zweiter Lauf aendert nichts', () => {
  const before = db.prepare("SELECT key, value FROM sync_config WHERE key LIKE 'health_cycle_enabled:user:%' ORDER BY key").all();
  migration.up(db);
  const after = db.prepare("SELECT key, value FROM sync_config WHERE key LIKE 'health_cycle_enabled:user:%' ORDER BY key").all();
  assert.deepEqual(after, before);
});

test('die Migration schreibt dieselbe Zeile wie die Anlage eines neuen Kindes', () => {
  // Gleichwertig HEUTE: weicht die Laufzeit spaeter bewusst ab, wird dieser
  // Test angepasst, nicht die eingefrorene Migration.
  assert.deepEqual(CHILD_START_PREFERENCES, { health_cycle_enabled: '0' });
  const fresh = addUser('kind-neu', 'member', 'child');
  applyChildStartPermissions(db, { id: fresh, role: 'member', family_role: 'child' });
  const runtime = cycleRow(fresh);
  db.prepare('DELETE FROM sync_config WHERE key = ?').run(`health_cycle_enabled:user:${fresh}`);
  migration.up(db);
  assert.equal(cycleRow(fresh), runtime);
});
