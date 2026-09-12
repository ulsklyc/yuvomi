/**
 * Modul: Waste collection migration + store (#1063 Phase 1)
 * Zweck: fresh and upgrade schema for the four manual-domain tables, every
 *        constraint/index/trigger they declare, and the archive/delete-refusal
 *        semantics waste-store.js layers on top (invariant #5). Same
 *        buildMigratedDatabase/_setTestDatabase harness as test-countdown.js.
 * Ausführen: npm run test:waste-migrations
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'waste-migrations-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const store = await import('../server/services/waste-store.js');
const { todayKey, shiftDateKey } = await import('../server/utils/timezone.js');

const moduleDatabase = get();
const suiteDatabase = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(suiteDatabase);
moduleDatabase.close();

const ALICE = seedUser('alice', 'admin');

test.after(() => suiteDatabase.close());

function applyMigration(db, migration) {
  if (typeof migration.up === 'function') migration.up(db);
  else db.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(db);
  db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
    .run(migration.version, migration.description);
}

function buildMigratedDatabase(migrations) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) applyMigration(db, migration);
  return db;
}

function seedUser(prefix, role) {
  return get().prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, 'hash', ?)
  `).run(`${prefix}-${randomUUID()}`, prefix, role).lastInsertRowid;
}

function seedType(overrides = {}) {
  return store.createType(get(), { name: `Type-${randomUUID()}`, ...overrides }, ALICE);
}

function seedWeeklySchedule(typeId, overrides = {}) {
  return store.createSchedule(get(), {
    type_id: typeId, recurrence_kind: 'weekly', anchor_date: '2026-01-05',
    interval: 1, weekdays: 'MO', ...overrides,
  }, ALICE);
}

// -------------------------------------------------------------------------
// Fresh schema
// -------------------------------------------------------------------------

test('fresh schema: all nine Waste tables exist as ordinary tables (backup-compatible, invariant #11)', () => {
  const rows = get().prepare(
    `SELECT name, type FROM sqlite_master WHERE type = 'table' AND name LIKE 'waste_%' ORDER BY name`
  ).all();
  assert.deepEqual(rows.map((r) => r.name), [
    'waste_imported_pickups', 'waste_one_off_pickups', 'waste_reminder_entries', 'waste_reminder_settings',
    'waste_schedule_overrides', 'waste_schedules', 'waste_source_mappings', 'waste_sources', 'waste_types',
  ]);
  assert.ok(rows.every((r) => r.type === 'table'), 'no virtual tables or views - plain rows the SQLite backup already covers');
});

test('fresh schema: the ten expected indexes exist', () => {
  const rows = get().prepare(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_waste_%' ORDER BY name`
  ).all().map((r) => r.name);
  assert.deepEqual(rows, [
    'idx_waste_imported_pickups_source', 'idx_waste_imported_pickups_source_date',
    'idx_waste_imported_pickups_type_date',
    'idx_waste_one_off_pickups_type_date', 'idx_waste_reminder_entries_user',
    'idx_waste_schedule_overrides_schedule',
    'idx_waste_schedules_type_active', 'idx_waste_source_mappings_source',
    'idx_waste_sources_due', 'idx_waste_sources_name', 'idx_waste_types_sort',
  ]);
});

test('fresh schema: updated_at triggers fire on UPDATE for every table', () => {
  const type = seedType();
  const before = get().prepare('SELECT updated_at FROM waste_types WHERE id = ?').get(type.id).updated_at;
  get().prepare("UPDATE waste_types SET name = 'renamed' WHERE id = ?").run(type.id);
  const after = get().prepare('SELECT updated_at, name FROM waste_types WHERE id = ?').get(type.id);
  assert.equal(after.name, 'renamed');
  assert.ok(after.updated_at >= before);
});

// -------------------------------------------------------------------------
// Upgrade path: migrations < 197 leave no Waste tables; 197 alone adds them
// without touching anything else.
// -------------------------------------------------------------------------

test('upgrade: a database migrated only through 196 has no Waste tables, and pre-existing tables survive 197', () => {
  const preWaste = buildMigratedDatabase(MIGRATIONS.filter((m) => m.version < 197));
  const before = preWaste.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'waste_%'`
  ).all();
  assert.deepEqual(before, []);

  const usersBefore = preWaste.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  applyMigration(preWaste, MIGRATIONS.find((m) => m.version === 197));

  const after = preWaste.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'waste_%' ORDER BY name`
  ).all();
  assert.deepEqual(after.map((r) => r.name), [
    'waste_one_off_pickups', 'waste_schedule_overrides', 'waste_schedules', 'waste_types',
  ]);
  assert.equal(preWaste.prepare('SELECT COUNT(*) AS n FROM users').get().n, usersBefore);
  preWaste.close();
});

// -------------------------------------------------------------------------
// Constraints
// -------------------------------------------------------------------------

test('constraint: waste_schedules.type_id must reference an existing type (FK, foreign_keys=ON)', () => {
  assert.throws(() => {
    get().prepare(`
      INSERT INTO waste_schedules (type_id, recurrence_kind, anchor_date, interval, weekdays)
      VALUES (999999, 'weekly', '2026-01-05', 1, 'MO')
    `).run();
  }, /FOREIGN KEY/);
});

test('constraint: recurrence_kind is restricted to weekly / monthly_fixed_day / monthly_ordinal_weekday', () => {
  const type = seedType();
  assert.throws(() => {
    get().prepare(`
      INSERT INTO waste_schedules (type_id, recurrence_kind, anchor_date, interval, weekdays)
      VALUES (?, 'daily', '2026-01-05', 1, 'MO')
    `).run(type.id);
  }, /CHECK/);
});

test('constraint: a weekly schedule cannot carry a month_day, and vice versa', () => {
  const type = seedType();
  assert.throws(() => {
    get().prepare(`
      INSERT INTO waste_schedules (type_id, recurrence_kind, anchor_date, interval, weekdays, month_day)
      VALUES (?, 'weekly', '2026-01-05', 1, 'MO', 15)
    `).run(type.id);
  }, /CHECK/, 'weekly + month_day must be rejected');

  assert.throws(() => {
    get().prepare(`
      INSERT INTO waste_schedules (type_id, recurrence_kind, anchor_date, interval, weekdays, month_day)
      VALUES (?, 'monthly_fixed_day', '2026-01-15', 1, 'MO', 15)
    `).run(type.id);
  }, /CHECK/, 'monthly + weekdays must be rejected');
});

test('constraint: monthly_ordinal_weekday requires BOTH weekdays and month_day (#1063 Phase 9)', () => {
  const type = seedType();
  assert.throws(() => {
    get().prepare(`
      INSERT INTO waste_schedules (type_id, recurrence_kind, anchor_date, interval, weekdays)
      VALUES (?, 'monthly_ordinal_weekday', '2026-01-12', 1, 'MO')
    `).run(type.id);
  }, /CHECK/, 'ordinal-weekday without month_day (the ordinal position) must be rejected');

  assert.throws(() => {
    get().prepare(`
      INSERT INTO waste_schedules (type_id, recurrence_kind, anchor_date, interval, month_day)
      VALUES (?, 'monthly_ordinal_weekday', '2026-01-12', 1, 2)
    `).run(type.id);
  }, /CHECK/, 'ordinal-weekday without weekdays must be rejected');

  // Both present: succeeds. month_day here is an ORDINAL POSITION (2 = "2nd"),
  // reusing the same column monthly_fixed_day uses for a day-of-month - the
  // column's own CHECK (month_day BETWEEN 1 AND 31) already permits 1-4
  // without any change.
  const ok = get().prepare(`
    INSERT INTO waste_schedules (type_id, recurrence_kind, anchor_date, interval, weekdays, month_day)
    VALUES (?, 'monthly_ordinal_weekday', '2026-01-12', 1, 'MO', 2)
  `).run(type.id);
  assert.ok(ok.lastInsertRowid);
});

test('constraint: month_day is limited to -1 or 1..31', () => {
  const type = seedType();
  assert.throws(() => {
    get().prepare(`
      INSERT INTO waste_schedules (type_id, recurrence_kind, anchor_date, interval, month_day)
      VALUES (?, 'monthly_fixed_day', '2026-01-32', 1, 32)
    `).run(type.id);
  }, /CHECK/);
});

test('constraint: interval is bounded to 1..52', () => {
  const type = seedType();
  assert.throws(() => {
    get().prepare(`
      INSERT INTO waste_schedules (type_id, recurrence_kind, anchor_date, interval, weekdays)
      VALUES (?, 'weekly', '2026-01-05', 53, 'MO')
    `).run(type.id);
  }, /CHECK/);
});

test('constraint: an override cannot replace a date with itself', () => {
  const type = seedType();
  const schedule = seedWeeklySchedule(type.id);
  assert.throws(() => {
    get().prepare(`
      INSERT INTO waste_schedule_overrides (schedule_id, original_date, replacement_date)
      VALUES (?, '2026-01-05', '2026-01-05')
    `).run(schedule.id);
  }, /CHECK/);
});

test('constraint: an override is unique per (schedule_id, original_date)', () => {
  const type = seedType();
  const schedule = seedWeeklySchedule(type.id);
  get().prepare(`
    INSERT INTO waste_schedule_overrides (schedule_id, original_date, replacement_date) VALUES (?, '2026-01-05', '2026-01-06')
  `).run(schedule.id);
  assert.throws(() => {
    get().prepare(`
      INSERT INTO waste_schedule_overrides (schedule_id, original_date, replacement_date) VALUES (?, '2026-01-05', '2026-01-07')
    `).run(schedule.id);
  }, /UNIQUE/);
});

test('constraint: a one-off pickup is unique per (type_id, date)', () => {
  const type = seedType();
  store.createOneOff(get(), { type_id: type.id, date: '2026-02-01' }, ALICE);
  assert.throws(() => store.createOneOff(get(), { type_id: type.id, date: '2026-02-01' }, ALICE), store.WasteConflictError);
});

test('cascade: deleting a schedule cascades its overrides, but not the type', () => {
  const type = seedType();
  const schedule = seedWeeklySchedule(type.id);
  get().prepare(`
    INSERT INTO waste_schedule_overrides (schedule_id, original_date, replacement_date) VALUES (?, '2026-01-05', '2026-01-06')
  `).run(schedule.id);

  store.deleteSchedule(get(), schedule.id);

  assert.equal(get().prepare('SELECT COUNT(*) AS n FROM waste_schedule_overrides WHERE schedule_id = ?').get(schedule.id).n, 0);
  assert.ok(store.getType(get(), type.id), 'the type itself must survive its schedule being deleted');
});

// -------------------------------------------------------------------------
// Archive / delete semantics (invariant #5), via the store layer
// -------------------------------------------------------------------------

test('deleteType: refused while a schedule references the type', () => {
  const type = seedType();
  seedWeeklySchedule(type.id);
  assert.throws(() => store.deleteType(get(), type.id), store.WasteConflictError);
  assert.ok(store.getType(get(), type.id), 'the type must still exist after a refused delete');
});

test('deleteType: refused while a one-off pickup references the type', () => {
  const type = seedType();
  store.createOneOff(get(), { type_id: type.id, date: '2026-03-01' }, ALICE);
  assert.throws(() => store.deleteType(get(), type.id), store.WasteConflictError);
});

test('deleteType: succeeds once no schedule or one-off references the type', () => {
  const type = seedType();
  const schedule = seedWeeklySchedule(type.id);
  store.deleteSchedule(get(), schedule.id);
  store.deleteType(get(), type.id);
  assert.equal(store.getType(get(), type.id), null);
});

test('updateType: archiving is always allowed, even with references, and is reversible', () => {
  const type = seedType();
  seedWeeklySchedule(type.id);
  const archived = store.updateType(get(), type.id, { archived: true });
  assert.equal(archived.archived, 1);
  const restored = store.updateType(get(), type.id, { archived: false });
  assert.equal(restored.archived, 0);
});

test('upsertOverride: refuses an original_date that is not a real calculated occurrence of the schedule', () => {
  const type = seedType();
  const schedule = seedWeeklySchedule(type.id); // Mondays only
  assert.throws(
    () => store.upsertOverride(get(), schedule.id, { original_date: '2026-01-06', replacement_date: '2026-01-07' }),
    store.WasteValidationError
  );
});

test('upsertOverride: a valid move then an explicit skip both round-trip through the store', () => {
  const type = seedType();
  const schedule = seedWeeklySchedule(type.id);
  const moved = store.upsertOverride(get(), schedule.id, { original_date: '2026-01-05', replacement_date: '2026-01-07' });
  assert.equal(moved.replacement_date, '2026-01-07');

  const skipped = store.upsertOverride(get(), schedule.id, { original_date: '2026-01-05', replacement_date: null });
  assert.equal(skipped.replacement_date, null);
  assert.equal(store.listOverrides(get(), schedule.id).length, 1, 'the same (schedule, original_date) row is replaced, not duplicated');
});

// -------------------------------------------------------------------------
// Range / next-per-type reads through the store (glue over the pure domain
// resolver, already covered in depth by test-waste-domain.js)
// -------------------------------------------------------------------------

test('getOccurrences: rejects a range wider than the 731-day ceiling', () => {
  assert.throws(
    () => store.getOccurrences(get(), { from: '2026-01-01', to: '2028-01-02' }),
    store.WasteValidationError
  );
});

test('getOccurrences and getNextPerType: a seeded weekly schedule round-trips end to end', () => {
  const type = seedType({ name: 'End-to-end type' });
  seedWeeklySchedule(type.id, { anchor_date: '2026-01-05', weekdays: 'MO' });

  const occurrences = store.getOccurrences(get(), { from: '2026-01-01', to: '2026-01-31' });
  assert.ok(occurrences.some((o) => o.type_id === type.id && o.date_key === '2026-01-05'));

  const next = store.getNextPerType(get(), { now: new Date('2026-01-06T00:00:00Z') });
  const forType = next.find((n) => n.type.id === type.id);
  assert.equal(forType.next.date_key, '2026-01-12');
});

// -------------------------------------------------------------------------
// Import sources, mappings, and imported pickups (#1063 Phase 3)
// -------------------------------------------------------------------------

function icsFixture(dateKey, label = 'Restmüll', uid = `fixture-${randomUUID()}@x`) {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${label}\r\nCATEGORIES:${label}\r\nDTSTART;VALUE=DATE:${dateKey.replace(/-/g, '')}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
}

function commitFixture(overrides = {}) {
  return store.commitImport(get(), {
    sourceId: null,
    name: `Source-${randomUUID()}`,
    icsText: icsFixture('2026-09-01'),
    mappingDecisions: [{ normalized_label: 'restmüll', new_type: { name: `Imported-${randomUUID()}` } }],
    userId: ALICE,
    ...overrides,
  });
}

test('trg_waste_sources_updated_at / trg_waste_source_mappings_updated_at / trg_waste_imported_pickups_updated_at fire on UPDATE', () => {
  const { source } = commitFixture();
  const before = get().prepare('SELECT updated_at FROM waste_sources WHERE id = ?').get(source.id).updated_at;
  get().prepare("UPDATE waste_sources SET name = 'renamed' WHERE id = ?").run(source.id);
  const after = get().prepare('SELECT updated_at FROM waste_sources WHERE id = ?').get(source.id).updated_at;
  assert.ok(after >= before);

  const mapping = get().prepare('SELECT * FROM waste_source_mappings WHERE source_id = ?').get(source.id);
  const mBefore = mapping.updated_at;
  get().prepare("UPDATE waste_source_mappings SET original_label = 'renamed' WHERE id = ?").run(mapping.id);
  const mAfter = get().prepare('SELECT updated_at FROM waste_source_mappings WHERE id = ?').get(mapping.id).updated_at;
  assert.ok(mAfter >= mBefore);

  const pickup = get().prepare('SELECT * FROM waste_imported_pickups WHERE source_id = ?').get(source.id);
  const pBefore = pickup.updated_at;
  get().prepare("UPDATE waste_imported_pickups SET tz_note = 'renamed' WHERE id = ?").run(pickup.id);
  const pAfter = get().prepare('SELECT updated_at FROM waste_imported_pickups WHERE id = ?').get(pickup.id).updated_at;
  assert.ok(pAfter >= pBefore);
});

test('constraint: waste_source_mappings requires exactly one of (type_id set) / (ignored=1)', () => {
  const source = commitFixture().source;
  assert.throws(() => {
    get().prepare(`
      INSERT INTO waste_source_mappings (source_id, original_label, normalized_label, type_id, ignored)
      VALUES (?, 'Both', 'both', ?, 1)
    `).run(source.id, seedType().id);
  }, /CHECK/, 'type_id set AND ignored=1 must be rejected');
  assert.throws(() => {
    get().prepare(`
      INSERT INTO waste_source_mappings (source_id, original_label, normalized_label, type_id, ignored)
      VALUES (?, 'Neither', 'neither', NULL, 0)
    `).run(source.id);
  }, /CHECK/, 'neither type_id nor ignored must be rejected');
});

test('constraint: a mapping is unique per (source_id, normalized_label)', () => {
  const source = commitFixture().source;
  const type = seedType();
  assert.throws(() => {
    get().prepare(`
      INSERT INTO waste_source_mappings (source_id, original_label, normalized_label, type_id, ignored)
      VALUES (?, 'Restmüll', 'restmüll', ?, 0)
    `).run(source.id, type.id);
  }, /UNIQUE/);
});

test('constraint: an imported pickup is unique per (source_id, identity_key)', () => {
  const source = commitFixture().source;
  const pickup = get().prepare('SELECT * FROM waste_imported_pickups WHERE source_id = ?').get(source.id);
  assert.throws(() => {
    get().prepare(`
      INSERT INTO waste_imported_pickups (source_id, type_id, identity_key, date_key)
      VALUES (?, ?, ?, '2026-09-02')
    `).run(source.id, pickup.type_id, pickup.identity_key);
  }, /UNIQUE/);
});

test('cascade: deleting a source cascades its mappings and imported pickups, but not the type', () => {
  const { source } = commitFixture();
  const pickup = get().prepare('SELECT * FROM waste_imported_pickups WHERE source_id = ?').get(source.id);
  const typeId = pickup.type_id;

  store.deleteSource(get(), source.id);

  assert.equal(get().prepare('SELECT COUNT(*) AS n FROM waste_source_mappings WHERE source_id = ?').get(source.id).n, 0);
  assert.equal(get().prepare('SELECT COUNT(*) AS n FROM waste_imported_pickups WHERE source_id = ?').get(source.id).n, 0);
  assert.ok(store.getType(get(), typeId), 'the type itself must survive its source being deleted');
});

test('cascade: deleting a source never touches another source\'s mappings or imported pickups', () => {
  const first = commitFixture();
  const second = commitFixture();
  store.deleteSource(get(), first.source.id);
  assert.ok(get().prepare('SELECT COUNT(*) AS n FROM waste_imported_pickups WHERE source_id = ?').get(second.source.id).n > 0);
});

test('needs_refresh (invariant #6): true when no mapped pickup is on/after today, false otherwise', () => {
  const today = todayKey(get());
  const future = shiftDateKey(today, 10);
  const past = shiftDateKey(today, -10);

  const healthy = commitFixture({ icsText: icsFixture(future) }).source;
  assert.equal(healthy.needs_refresh, false);

  const stale = commitFixture({ icsText: icsFixture(past) }).source;
  assert.equal(stale.needs_refresh, true);

  assert.equal(store.listSources(get()).find((s) => s.id === healthy.id).needs_refresh, false);
  assert.equal(store.getSource(get(), stale.id).needs_refresh, true);
});

test('deleteType: refused while an imported pickup references the type (invariant #5)', () => {
  const { source } = commitFixture();
  const pickup = get().prepare('SELECT * FROM waste_imported_pickups WHERE source_id = ?').get(source.id);
  assert.throws(() => store.deleteType(get(), pickup.type_id), store.WasteConflictError);
});

test('commitImport: a fresh import creates a source at version 1 with coverage and last_success_at set', () => {
  const { source, diff } = commitFixture();
  assert.equal(source.version, 1);
  assert.equal(source.coverage_start, '2026-09-01');
  assert.equal(source.coverage_end, '2026-09-01');
  assert.ok(source.last_success_at);
  assert.equal(source.last_error, null);
  assert.deepEqual(diff, { added: 1, changed: 0, removed: 0, coalesced: 0 });
});

test('commitImport: a re-import bumps version, applies additions/changes/removals, and preserves the type', () => {
  const first = commitFixture();
  const typeId = get().prepare('SELECT type_id FROM waste_imported_pickups WHERE source_id = ?').get(first.source.id).type_id;

  const second = store.commitImport(get(), {
    sourceId: first.source.id,
    name: first.source.name,
    icsText: icsFixture('2026-09-08'), // a different date - the 09-01 pickup is now removed
    mappingDecisions: [{ normalized_label: 'restmüll', type_id: typeId }],
    expectedVersion: first.source.version,
    userId: ALICE,
  });

  assert.equal(second.source.version, 2);
  assert.deepEqual(second.diff, { added: 1, changed: 0, removed: 1, coalesced: 0 });
  const rows = get().prepare('SELECT date_key FROM waste_imported_pickups WHERE source_id = ?').all(first.source.id);
  assert.deepEqual(rows.map((r) => r.date_key), ['2026-09-08']);
});

test('commitImport: refuses a re-import whose expected_version no longer matches (concurrency guard, invariant #9)', () => {
  const { source } = commitFixture();
  assert.throws(() => store.commitImport(get(), {
    sourceId: source.id,
    name: source.name,
    icsText: icsFixture('2026-09-08'),
    mappingDecisions: [{ normalized_label: 'restmüll', new_type: { name: `Stale-${randomUUID()}` } }],
    expectedVersion: source.version - 1,
    userId: ALICE,
  }), store.WasteConflictError);
});

test('commitImport: refuses a commit that leaves a blocking diagnostic unresolved', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:unbounded@x\r\nSUMMARY:Restmüll\r\nDTSTART;VALUE=DATE:20260901\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\nEND:VCALENDAR';
  assert.throws(() => store.commitImport(get(), {
    sourceId: null, name: `Blocked-${randomUUID()}`, icsText: ics, mappingDecisions: [], userId: ALICE,
  }), store.WasteValidationError);
});

test('commitImport: a mid-transaction failure (nonexistent type_id) leaves no partial source/mapping/pickup rows behind', () => {
  const sourcesBefore = get().prepare('SELECT COUNT(*) AS n FROM waste_sources').get().n;
  assert.throws(() => store.commitImport(get(), {
    sourceId: null, name: `Rollback-${randomUUID()}`, icsText: icsFixture('2026-12-01'),
    mappingDecisions: [{ normalized_label: 'restmüll', type_id: 999999 }],
    userId: ALICE,
  }), store.WasteValidationError);
  assert.equal(get().prepare('SELECT COUNT(*) AS n FROM waste_sources').get().n, sourcesBefore, 'no source row must survive a rolled-back commit');
});

test('commitImport: two distinct labels both mapped to new_type with the identical (trimmed, case-folded) name create one type, not two', () => {
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'UID:merge-1@x', 'SUMMARY:Bioabfall', 'DTSTART;VALUE=DATE:20260901', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:merge-2@x', 'SUMMARY:Bioabfall *', 'DTSTART;VALUE=DATE:20260908', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  // The household edited the second label's "new type" field to the exact
  // same name as the first, expecting them to merge into one type - the
  // scenario reported live: a provider's own footnote convention this
  // importer's built-in "*" strip does not happen to catch.
  const { source } = store.commitImport(get(), {
    sourceId: null, name: `Merge-${randomUUID()}`, icsText: ics,
    mappingDecisions: [
      { normalized_label: 'bioabfall', new_type: { name: 'Bioabfall' } },
      { normalized_label: 'bioabfall *', new_type: { name: '  Bioabfall  ' } },
    ],
    userId: ALICE,
  });
  const typeRows = get().prepare("SELECT id FROM waste_types WHERE name = 'Bioabfall'").all();
  assert.equal(typeRows.length, 1, 'exactly one "Bioabfall" type must exist, not one per label');
  const pickupTypeIds = get().prepare('SELECT DISTINCT type_id FROM waste_imported_pickups WHERE source_id = ?').all(source.id);
  assert.deepEqual(pickupTypeIds.map((r) => r.type_id), [typeRows[0].id], 'both labels\' pickups must reference the same, single type');
});

test('commitImport: requires an explicit decision for every label', () => {
  assert.throws(() => store.commitImport(get(), {
    sourceId: null, name: `NoDecision-${randomUUID()}`, icsText: icsFixture('2026-09-01'), mappingDecisions: [], userId: ALICE,
  }), store.WasteValidationError);
});

test('previewImport + commitImport: getOccurrences surfaces an import origin with kind "import" and the source name', () => {
  const { source } = commitFixture();
  const occurrences = store.getOccurrences(get(), { from: '2026-08-25', to: '2026-09-05' });
  const occ = occurrences.find((o) => o.origins.some((og) => og.kind === 'import' && og.source_id === source.id));
  assert.ok(occ, 'an occurrence carrying this test\'s own import origin must be present');
  const origin = occ.origins.find((o) => o.kind === 'import' && o.source_id === source.id);
  assert.equal(origin.source_name, source.name);
});
