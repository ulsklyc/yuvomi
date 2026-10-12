/**
 * Test: der Such-Trigger an calendar_events feuert nur auf den indizierten
 *       Spalten (Migration v239, #1860)
 * Zweck: `trg_search_events_au` schrieb bei JEDEM UPDATE die FTS-Zeile des
 *        Termins neu, auch wenn kein durchsuchtes Feld betroffen war. Das SET
 *        NULL beim Loeschen eines CalDAV-Kontos fasst `caldav_account_id` an
 *        vieler Zeilen an und lief dadurch sekundenlang. v239 verengt den
 *        Trigger auf `AFTER UPDATE OF <indizierte Spalten>`.
 *        Geprueft wird:
 *        - der Suchindex folgt weiter jeder Aenderung an title, description,
 *          location, recurrence_parent_id und overridden_fields;
 *        - eine Aenderung NUR an caldav_account_id bzw. outbound_dirty laesst
 *          den Suchindex unberuehrt (Trigger feuert nicht);
 *        - ein Laufzeit-Guard ohne feste Millisekunden: ein Konto mit vielen
 *          Terminen loeschen loest keine einzige Such-Trigger-Ausloesung aus,
 *          waehrend eine Titelaenderung je Zeile genau eine ausloest.
 * Ausfuehren: node --test test/test-calendar-search-trigger-scope.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { tempDir } from './tmp-dir.js';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = join(tempDir('yuvomi-trgscope-'), 'unused.db');
const { MIGRATIONS } = await import('../server/db.js');

function migratedDatabase() {
  const db = new Database(join(tempDir('yuvomi-trgscope-'), 'db.sqlite'));
  db.pragma('foreign_keys = ON');
  for (const migration of MIGRATIONS) {
    db.transaction(() => {
      if (typeof migration.up === 'function') migration.up(db);
      else db.exec(migration.up);
      migration.afterUp?.(db);
    })();
  }
  db.prepare("INSERT INTO users (id, username, display_name, password_hash, role) VALUES (1,'admin','Admin','x','admin')").run();
  return db;
}

/** Die Spalten der `AFTER UPDATE OF`-Klausel des ECHTEN Such-Triggers. */
function searchTriggerColumns(db) {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_search_events_au'").get().sql;
  const m = /AFTER\s+UPDATE\s+OF\s+([^\n]+?)\s+ON\s+calendar_events/is.exec(sql);
  assert.ok(m, 'der Such-Trigger traegt keine AFTER UPDATE OF-Klausel');
  return m[1].split(',').map((c) => c.trim());
}

/**
 * Zaehlt die Ausloesungen des Such-Triggers - search_index ist eine FTS-Tabelle
 * und traegt selbst keinen Trigger. Stattdessen ein Zaehl-Trigger auf
 * calendar_events mit GENAU der Spaltenliste des echten Triggers (aus
 * sqlite_master gelesen): er feuert Zeile fuer Zeile dann und nur dann, wenn
 * auch der echte feuert. Die Gleichheit der Listen belegt der Strukturtest.
 */
function countSearchWrites(db) {
  const cols = searchTriggerColumns(db).join(', ');
  db.exec(`
    CREATE TABLE IF NOT EXISTS _search_writes (n INTEGER NOT NULL DEFAULT 0);
    INSERT INTO _search_writes (n) VALUES (0);
    CREATE TRIGGER IF NOT EXISTS _count_search_writes
      AFTER UPDATE OF ${cols} ON calendar_events
      BEGIN UPDATE _search_writes SET n = n + 1; END;
  `);
  return {
    columns: searchTriggerColumns(db),
    reset: () => db.prepare('UPDATE _search_writes SET n = 0').run(),
    value: () => db.prepare('SELECT n FROM _search_writes').get().n,
  };
}

const indexed = (db, id) => db.prepare("SELECT title, body FROM search_index WHERE entity = 'event' AND entity_id = ?").get(id);

function addCaldavAccount(db) {
  const id = Number(db.prepare("INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES ('A','https://a/','u','p')").run().lastInsertRowid);
  db.prepare("INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled) VALUES (?, 'https://a/cal/', 'F', '#4A90E2', 1)").run(id);
  return id;
}

function addEvent(db, { title = 'Termin', description = null, location = null, caldav = null } = {}) {
  return Number(db.prepare(`
    INSERT INTO calendar_events (title, description, location, start_datetime, created_by, external_source, external_calendar_id, caldav_account_id)
    VALUES (?, ?, ?, '2035-01-01T09:00', 1, ?, ?, ?)
  `).run(title, description, location, caldav ? 'caldav' : 'local', caldav ? 'uid-' + Math.random() : null, caldav).lastInsertRowid);
}

test('der Suchindex folgt jeder Aenderung an einer indizierten Spalte', () => {
  const db = migratedDatabase();
  const id = addEvent(db, { title: 'Alt', description: 'Beschreibung', location: 'Ort' });
  assert.equal(indexed(db, id).title, 'Alt');

  db.prepare('UPDATE calendar_events SET title = ? WHERE id = ?').run('Neu', id);
  assert.equal(indexed(db, id).title, 'Neu');
  db.prepare('UPDATE calendar_events SET description = ? WHERE id = ?').run('Anders', id);
  assert.match(indexed(db, id).body, /Anders/);
  db.prepare('UPDATE calendar_events SET location = ? WHERE id = ?').run('Woanders', id);
  assert.match(indexed(db, id).body, /Woanders/);

  // recurrence_parent_id/overridden_fields steuern, welche Felder ueberhaupt
  // indiziert werden: ein Kind ohne Override indiziert nichts.
  const parent = addEvent(db, { title: 'Serie' });
  const child = Number(db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, created_by, external_source, recurrence_parent_id, recurrence_id)
    VALUES ('Kind', '2035-02-01T09:00', 1, 'local', ?, '2035-02-01T09:00')
  `).run(parent).lastInsertRowid);
  assert.equal(indexed(db, child).title, '', 'ein Kind ohne Override indiziert den Titel nicht');
  db.prepare(`UPDATE calendar_events SET overridden_fields = '["title"]' WHERE id = ?`).run(child);
  assert.equal(indexed(db, child).title, 'Kind', 'nach dem Override steht der Titel im Index');
  db.close();
});

test('der Such-Trigger nennt genau die indizierten Spalten', () => {
  const db = migratedDatabase();
  assert.deepEqual(
    searchTriggerColumns(db).sort(),
    ['description', 'location', 'overridden_fields', 'recurrence_parent_id', 'title'].sort(),
    'die AFTER UPDATE OF-Spalten weichen von den im Rumpf gelesenen ab',
  );
  db.close();
});

test('eine Aenderung nur an caldav_account_id oder outbound_dirty laesst den Suchindex unberuehrt', () => {
  const db = migratedDatabase();
  const account = addCaldavAccount(db);
  const id = addEvent(db, { title: 'Bleibt', caldav: account });
  const writes = countSearchWrites(db);

  writes.reset();
  db.prepare('UPDATE calendar_events SET caldav_account_id = NULL WHERE id = ?').run(id);
  assert.equal(writes.value(), 0, 'das Loeschen der Kontozuordnung hat den Such-Trigger ausgeloest');

  writes.reset();
  db.prepare('UPDATE calendar_events SET outbound_dirty = 1, outbound_attempts = 2, external_object_url = ? WHERE id = ?')
    .run('https://a/cal/x.ics', id);
  assert.equal(writes.value(), 0, 'eine reine Ausgangs-Buchung hat den Such-Trigger ausgeloest');

  // Gegenprobe: der Titel feuert weiter.
  writes.reset();
  db.prepare('UPDATE calendar_events SET title = ? WHERE id = ?').run('Geaendert', id);
  assert.equal(writes.value(), 1);
  assert.equal(indexed(db, id).title, 'Geaendert');
  db.close();
});

test('Laufzeit-Guard: ein Konto mit vielen Terminen loeschen loest keine Such-Trigger aus', async () => {
  const db = migratedDatabase();
  const caldavSync = await import('../server/services/caldav-sync.js');
  const account = addCaldavAccount(db);
  const ref = Number(db.prepare("INSERT INTO external_calendars (source, external_id, name, color) VALUES ('caldav','https://a/cal/','F','#4A90E2')").run().lastInsertRowid);
  const ins = db.prepare("INSERT INTO calendar_events (title, description, start_datetime, created_by, external_source, external_calendar_id, calendar_ref_id, caldav_account_id) VALUES (?, 'lorem', '2035-01-01T09:00', 1, 'caldav', ?, ?, ?)");
  const N = 500;
  db.transaction(() => { for (let i = 0; i < N; i++) ins.run(`Bulk ${i}`, `bulk-${i}`, ref, account); })();
  const writes = countSearchWrites(db);

  const { _setTestDatabase, _resetTestDatabase } = await import('../server/db.js');
  _setTestDatabase(db);
  try {
    writes.reset();
    caldavSync.deleteAccount(account, { deleteEvents: false });
    assert.equal(writes.value(), 0, `das Loeschen des Kontos schrieb ${writes.value()} Suchzeilen neu`);
  } finally {
    _resetTestDatabase();
  }
  // Die Termine stehen noch, ohne Konto.
  assert.equal(db.prepare("SELECT COUNT(*) n FROM calendar_events WHERE caldav_account_id IS NULL").get().n, N);
  // Verhaeltnis: dieselbe Zahl Titelaenderungen loest je Zeile genau eine aus.
  writes.reset();
  const retitle = db.prepare('UPDATE calendar_events SET title = title || ? WHERE id = ?');
  const ids = db.prepare('SELECT id FROM calendar_events').all().map((r) => r.id);
  db.transaction(() => { for (const id of ids) retitle.run('!', id); })();
  assert.equal(writes.value(), N, 'eine Titelaenderung je Zeile muss je Zeile eine Suchzeile schreiben');
  db.close();
});
