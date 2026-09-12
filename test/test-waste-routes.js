/**
 * Modul: Waste collection HTTP routes (#1063 Phase 2)
 * Zweck: CRUD, validation, and error-contract coverage for
 *        server/routes/waste/*.js - the isolated-router harness used by
 *        test-task-default-points.js (module/permission/token-scope gating,
 *        CSRF, and idempotency are all applied once, centrally, at the
 *        /api/v1 mount point in server/index.js, and are covered by the
 *        generic suites for those cross-cutting concerns, not per module).
 * Ausführen: npm run test:waste-routes
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'waste-routes-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: wasteRouter } = await import('../server/routes/waste/index.js');
const helpers = await import('../server/routes/waste/helpers.js');

const moduleDatabase = get();
const db = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(db);
moduleDatabase.close();

function applyMigration(database, migration) {
  if (typeof migration.up === 'function') migration.up(database);
  else database.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(database);
  database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
    .run(migration.version, migration.description);
}

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
  for (const migration of migrations) applyMigration(database, migration);
  return database;
}

function seedUser(prefix, role = 'member') {
  return db.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES (?, ?, 'hash', '#007AFF', ?)
  `).run(`${prefix}-${randomUUID()}`, prefix, role).lastInsertRowid;
}

const ADMIN = seedUser('admin', 'admin');
let actor = { id: ADMIN, role: 'admin' };

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/api/v1/waste', wasteRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}/api/v1`;

test.after(() => { server.close(); db.close(); });

async function call(method, path, { body } = {}) {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function createType(overrides = {}) {
  const r = await call('POST', '/waste/types', { body: { name: `Type-${randomUUID()}`, ...overrides } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
}

async function createWeeklySchedule(typeId, overrides = {}) {
  const r = await call('POST', '/waste/schedules', {
    body: { type_id: typeId, recurrence_kind: 'weekly', anchor_date: '2026-01-05', interval: 1, weekdays: ['MO'], ...overrides },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
}

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

test('POST /waste/types: creates with defaults, GET lists it', async () => {
  const created = await createType({ name: 'Recycling' });
  assert.equal(created.name, 'Recycling');
  assert.equal(created.icon, 'trash-2');
  assert.match(created.color, /^#[0-9A-Fa-f]{6}$/);

  const listed = await call('GET', '/waste/types');
  assert.equal(listed.status, 200);
  assert.ok(listed.body.data.some((t) => t.id === created.id));
});

test('POST /waste/types: 400 on a missing name', async () => {
  const r = await call('POST', '/waste/types', { body: {} });
  assert.equal(r.status, 400);
  assert.ok(r.body.error);
});

test('GET /waste/types/:id: 404 for an unknown id', async () => {
  const r = await call('GET', '/waste/types/999999');
  assert.equal(r.status, 404);
});

test('GET /waste/types: excludes archived by default, include_archived=1 includes it', async () => {
  const type = await createType();
  await call('PUT', `/waste/types/${type.id}`, { body: { archived: true } });

  const withoutArchived = await call('GET', '/waste/types');
  assert.ok(!withoutArchived.body.data.some((t) => t.id === type.id));

  const withArchived = await call('GET', '/waste/types?include_archived=1');
  assert.ok(withArchived.body.data.some((t) => t.id === type.id));
});

test('DELETE /waste/types/:id: 409 while a schedule references it, 204 once it does not', async () => {
  const type = await createType();
  const schedule = await createWeeklySchedule(type.id);

  const refused = await call('DELETE', `/waste/types/${type.id}`);
  assert.equal(refused.status, 409);

  await call('DELETE', `/waste/schedules/${schedule.id}`);
  const ok = await call('DELETE', `/waste/types/${type.id}`);
  assert.equal(ok.status, 204);
});

test('PUT /waste/types/:id: archiving succeeds even while referenced, and is reversible', async () => {
  const type = await createType();
  await createWeeklySchedule(type.id);

  const archived = await call('PUT', `/waste/types/${type.id}`, { body: { archived: true } });
  assert.equal(archived.status, 200);
  assert.equal(archived.body.data.archived, 1);

  const restored = await call('PUT', `/waste/types/${type.id}`, { body: { archived: false } });
  assert.equal(restored.body.data.archived, 0);
});

// -------------------------------------------------------------------------
// Schedules
// -------------------------------------------------------------------------

test('POST /waste/schedules: 400 when type_id does not reference an existing type', async () => {
  const r = await call('POST', '/waste/schedules', {
    body: { type_id: 999999, recurrence_kind: 'weekly', anchor_date: '2026-01-05', interval: 1, weekdays: ['MO'] },
  });
  assert.equal(r.status, 400);
});

test('POST /waste/schedules: 400 on an invalid recurrence (weekly with no weekdays)', async () => {
  const type = await createType();
  const r = await call('POST', '/waste/schedules', {
    body: { type_id: type.id, recurrence_kind: 'weekly', anchor_date: '2026-01-05', interval: 1 },
  });
  assert.equal(r.status, 400);
});

test('GET /waste/schedules?type_id=: filters to one type', async () => {
  const typeA = await createType();
  const typeB = await createType();
  await createWeeklySchedule(typeA.id);
  await createWeeklySchedule(typeB.id);

  const r = await call('GET', `/waste/schedules?type_id=${typeA.id}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.data.every((s) => s.type_id === typeA.id));
  assert.ok(r.body.data.length >= 1);
});

test('PUT /waste/schedules/:id: pause (active:false) then reactivate', async () => {
  const type = await createType();
  const schedule = await createWeeklySchedule(type.id);

  const paused = await call('PUT', `/waste/schedules/${schedule.id}`, { body: { active: false } });
  assert.equal(paused.body.data.active, 0);

  const reactivated = await call('PUT', `/waste/schedules/${schedule.id}`, { body: { active: true } });
  assert.equal(reactivated.body.data.active, 1);
});

test('DELETE /waste/schedules/:id: cascades its overrides, leaves the type alone', async () => {
  const type = await createType();
  const schedule = await createWeeklySchedule(type.id);
  await call('PUT', `/waste/schedules/${schedule.id}/overrides/2026-01-05`, { body: { replacement_date: '2026-01-06' } });

  const del = await call('DELETE', `/waste/schedules/${schedule.id}`);
  assert.equal(del.status, 204);

  const typeStill = await call('GET', `/waste/types/${type.id}`);
  assert.equal(typeStill.status, 200);
});

// -------------------------------------------------------------------------
// Overrides (move / skip / restore)
// -------------------------------------------------------------------------

test('PUT .../overrides/:originalDate: 400 when original_date is not a real calculated occurrence', async () => {
  const type = await createType();
  const schedule = await createWeeklySchedule(type.id); // Mondays only
  const r = await call('PUT', `/waste/schedules/${schedule.id}/overrides/2026-01-06`, { body: { replacement_date: '2026-01-07' } });
  assert.equal(r.status, 400);
});

test('PUT then DELETE .../overrides/:originalDate: move, then restore', async () => {
  const type = await createType();
  const schedule = await createWeeklySchedule(type.id);

  const moved = await call('PUT', `/waste/schedules/${schedule.id}/overrides/2026-01-05`, { body: { replacement_date: '2026-01-07' } });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.data.replacement_date, '2026-01-07');

  const restored = await call('DELETE', `/waste/schedules/${schedule.id}/overrides/2026-01-05`);
  assert.equal(restored.status, 204);

  const restoredAgain = await call('DELETE', `/waste/schedules/${schedule.id}/overrides/2026-01-05`);
  assert.equal(restoredAgain.status, 404);
});

test('PUT .../overrides/:originalDate with replacement_date: null skips the occurrence', async () => {
  const type = await createType();
  const schedule = await createWeeklySchedule(type.id);
  const skipped = await call('PUT', `/waste/schedules/${schedule.id}/overrides/2026-01-05`, { body: { replacement_date: null } });
  assert.equal(skipped.status, 200);
  assert.equal(skipped.body.data.replacement_date, null);
});

// -------------------------------------------------------------------------
// One-off pickups
// -------------------------------------------------------------------------

test('POST /waste/pickups: creates, and a duplicate (type_id, date) is refused with 409', async () => {
  const type = await createType();
  const created = await call('POST', '/waste/pickups', { body: { type_id: type.id, date: '2026-04-01' } });
  assert.equal(created.status, 201);

  const duplicate = await call('POST', '/waste/pickups', { body: { type_id: type.id, date: '2026-04-01' } });
  assert.equal(duplicate.status, 409);
});

test('POST /waste/pickups: 400 when type_id does not reference an existing type', async () => {
  const r = await call('POST', '/waste/pickups', { body: { type_id: 999999, date: '2026-04-01' } });
  assert.equal(r.status, 400);
});

test('DELETE /waste/pickups/:id: removes it, second delete is 404', async () => {
  const type = await createType();
  const created = await call('POST', '/waste/pickups', { body: { type_id: type.id, date: '2026-04-02' } });
  const del = await call('DELETE', `/waste/pickups/${created.body.data.id}`);
  assert.equal(del.status, 204);
  const delAgain = await call('DELETE', `/waste/pickups/${created.body.data.id}`);
  assert.equal(delAgain.status, 404);
});

// -------------------------------------------------------------------------
// Occurrences / next-per-type
// -------------------------------------------------------------------------

test('GET /waste/occurrences: 400 when the range exceeds the 731-day ceiling', async () => {
  const r = await call('GET', '/waste/occurrences?from=2026-01-01&to=2028-01-02');
  assert.equal(r.status, 400);
});

test('GET /waste/occurrences: 400 on a missing or malformed from/to', async () => {
  const missing = await call('GET', '/waste/occurrences');
  assert.equal(missing.status, 400);
  const malformed = await call('GET', '/waste/occurrences?from=not-a-date&to=2026-02-01');
  assert.equal(malformed.status, 400);
});

test('GET /waste/occurrences: returns a seeded weekly schedule\'s occurrence in range', async () => {
  const type = await createType();
  await createWeeklySchedule(type.id, { anchor_date: '2026-05-04', weekdays: ['MO'] }); // a Monday
  const r = await call('GET', '/waste/occurrences?from=2026-05-01&to=2026-05-31');
  assert.equal(r.status, 200);
  assert.ok(r.body.data.some((o) => o.type_id === type.id && o.date_key === '2026-05-04'));
});

test('GET /waste/occurrences/next: one entry per non-archived type, sorted', async () => {
  const type = await createType({ name: 'Next-per-type test' });
  await createWeeklySchedule(type.id, { anchor_date: '2026-06-01', weekdays: ['MO'] });
  const r = await call('GET', '/waste/occurrences/next');
  assert.equal(r.status, 200);
  const entry = r.body.data.find((e) => e.type.id === type.id);
  assert.ok(entry, 'the seeded type must appear');
  assert.ok(entry.next === null || typeof entry.next.date_key === 'string');
});

// -------------------------------------------------------------------------
// Import (#1063 Phase 3)
// -------------------------------------------------------------------------

function icsFixture(dateKey, label = 'Restmüll') {
  const uid = `route-fixture-${randomUUID()}@x`;
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${label}\r\nCATEGORIES:${label}\r\nDTSTART;VALUE=DATE:${dateKey.replace(/-/g, '')}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
}

test('POST /waste/import/preview: 400 when the ics field is missing', async () => {
  const r = await call('POST', '/waste/import/preview', { body: {} });
  assert.equal(r.status, 400);
});

test('POST /waste/import/preview: returns labels and candidates without writing anything', async () => {
  const r = await call('POST', '/waste/import/preview', { body: { ics: icsFixture('2026-10-01') } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.labels.length, 1);
  assert.equal(r.body.data.labels[0].normalized_label, 'restmüll');
  assert.equal(r.body.data.counts.candidates, 1);
  const sources = await call('GET', '/waste/sources');
  assert.ok(!sources.body.data.some((s) => s.content_hash === r.body.data.digest), 'preview must not create a source');
});

test('POST /waste/import/commit: creates a source, mappings, and imported pickups; then appears in getOccurrences', async () => {
  const ics = icsFixture('2026-10-02');
  const commit = await call('POST', '/waste/import/commit', {
    body: {
      ics, name: 'Commit test source',
      mappings: [{ normalized_label: 'restmüll', new_type: { name: `Route-new-type-${randomUUID()}` } }],
    },
  });
  assert.equal(commit.status, 201, JSON.stringify(commit.body));
  assert.equal(commit.body.data.source.version, 1);
  assert.deepEqual(commit.body.data.diff, { added: 1, changed: 0, removed: 0, coalesced: 0 });

  const occ = await call('GET', '/waste/occurrences?from=2026-09-25&to=2026-10-10');
  assert.equal(occ.status, 200);
  assert.ok(occ.body.data.some((o) => o.date_key === '2026-10-02' && o.origins.some((og) => og.kind === 'import')));
});

test('POST /waste/import/commit: 400 when a label has no mapping decision', async () => {
  const r = await call('POST', '/waste/import/commit', {
    body: { ics: icsFixture('2026-10-03'), name: 'No decision', mappings: [] },
  });
  assert.equal(r.status, 400);
});

test('POST /waste/import/commit: 400 when an unresolved blocking diagnostic (unbounded recurrence) remains', async () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:unbounded-route@x\r\nSUMMARY:Restmüll\r\nDTSTART;VALUE=DATE:20261001\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const r = await call('POST', '/waste/import/commit', { body: { ics, name: 'Blocked', mappings: [] } });
  assert.equal(r.status, 400);
});

// -------------------------------------------------------------------------
// Sources
// -------------------------------------------------------------------------

async function commitSource(dateKey = '2026-11-01', overrides = {}) {
  const r = await call('POST', '/waste/import/commit', {
    body: {
      ics: icsFixture(dateKey), name: `Source-${randomUUID()}`,
      mappings: [{ normalized_label: 'restmüll', new_type: { name: `Source-type-${randomUUID()}` } }],
      ...overrides,
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data.source;
}

test('GET /waste/sources and GET /waste/sources/:id: list and detail include mappings', async () => {
  const source = await commitSource();
  const list = await call('GET', '/waste/sources');
  assert.ok(list.body.data.some((s) => s.id === source.id));
  const detail = await call('GET', `/waste/sources/${source.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.mappings.length, 1);
});

test('GET /waste/sources/:id: 404 for an unknown source', async () => {
  const r = await call('GET', '/waste/sources/999999');
  assert.equal(r.status, 404);
});

test('PUT /waste/sources/:id: renames the source', async () => {
  const source = await commitSource();
  const r = await call('PUT', `/waste/sources/${source.id}`, { body: { name: 'Renamed source' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.name, 'Renamed source');
});

test('PUT /waste/sources/:id/mappings/:mappingId: updates a mapping decision without a re-import', async () => {
  const source = await commitSource();
  const detail = await call('GET', `/waste/sources/${source.id}`);
  const mapping = detail.body.data.mappings[0];
  const otherType = await createType();
  const r = await call('PUT', `/waste/sources/${source.id}/mappings/${mapping.id}`, { body: { type_id: otherType.id } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.type_id, otherType.id);
});

test('POST /waste/sources/:id/reimport/preview: prefills the remembered mapping decision for a label seen before', async () => {
  const source = await commitSource('2026-11-05');
  const detail = await call('GET', `/waste/sources/${source.id}`);
  const mappedTypeId = detail.body.data.mappings[0].type_id;

  const r = await call('POST', `/waste/sources/${source.id}/reimport/preview`, { body: { ics: icsFixture('2026-11-12') } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.expected_version, 1);
  assert.equal(r.body.data.labels[0].remembered_type_id, mappedTypeId, 'the same label ("restmüll") was already mapped on commit and should be remembered');
});

test('POST /waste/sources/:id/reimport/commit: bumps version and applies the diff', async () => {
  const source = await commitSource('2026-11-06');
  const preview = await call('POST', `/waste/sources/${source.id}/reimport/preview`, { body: { ics: icsFixture('2026-11-13') } });
  assert.equal(preview.status, 200);
  const remembered = preview.body.data.labels[0].remembered_type_id;
  assert.ok(remembered, 'the label was mapped on the original commit and should be remembered on re-import');

  const commit = await call('POST', `/waste/sources/${source.id}/reimport/commit`, {
    body: {
      ics: icsFixture('2026-11-13'), mappings: [{ normalized_label: 'restmüll', type_id: remembered }],
      expected_version: 1,
    },
  });
  assert.equal(commit.status, 200, JSON.stringify(commit.body));
  assert.equal(commit.body.data.source.version, 2);
  assert.deepEqual(commit.body.data.diff, { added: 1, changed: 0, removed: 1, coalesced: 0 });
});

test('POST /waste/sources/:id/reimport/commit: 409 on a stale expected_version', async () => {
  const source = await commitSource('2026-11-07');
  const r = await call('POST', `/waste/sources/${source.id}/reimport/commit`, {
    body: { ics: icsFixture('2026-11-14'), mappings: [], expected_version: 0 },
  });
  assert.equal(r.status, 409);
});

test('DELETE /waste/sources/:id: cascades mappings and imported pickups, survives a 404 on repeat', async () => {
  const source = await commitSource('2026-11-08');
  const del = await call('DELETE', `/waste/sources/${source.id}`);
  assert.equal(del.status, 204);
  const detail = await call('GET', `/waste/sources/${source.id}`);
  assert.equal(detail.status, 404);
  const delAgain = await call('DELETE', `/waste/sources/${source.id}`);
  assert.equal(delAgain.status, 404);
});

// -------------------------------------------------------------------------
// Reminder settings (#1063 Phase 8)
// -------------------------------------------------------------------------

test('GET /waste/reminder-settings: synthesizes an all-disabled default for a type with no row yet', async () => {
  const type = await createType({ name: 'ReminderDefault' });
  const list = await call('GET', '/waste/reminder-settings');
  assert.equal(list.status, 200);
  const entry = list.body.data.find((r) => r.type_id === type.id);
  assert.ok(entry, 'every active type must appear, even without a settings row');
  assert.equal(entry.enabled, false);
  assert.equal(entry.offset_days, 1);
  assert.equal(entry.delivery_time, '08:00');
});

test('PUT /waste/reminder-settings/:typeId: upserts, and a later GET reflects it', async () => {
  const type = await createType({ name: 'ReminderUpsert' });
  const put = await call('PUT', `/waste/reminder-settings/${type.id}`, {
    body: { enabled: true, offset_days: 3, delivery_time: '19:30' },
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body.data, { type_id: type.id, enabled: true, offset_days: 3, delivery_time: '19:30' });

  const list = await call('GET', '/waste/reminder-settings');
  const entry = list.body.data.find((r) => r.type_id === type.id);
  assert.deepEqual(entry, { type_id: type.id, type_name: 'ReminderUpsert', enabled: true, offset_days: 3, delivery_time: '19:30' });
});

test('PUT /waste/reminder-settings/:typeId: rejects offset_days outside the bound and a malformed delivery_time', async () => {
  const type = await createType({ name: 'ReminderInvalid' });
  const badOffset = await call('PUT', `/waste/reminder-settings/${type.id}`, { body: { enabled: true, offset_days: 999 } });
  assert.equal(badOffset.status, 400);
  const badTime = await call('PUT', `/waste/reminder-settings/${type.id}`, { body: { enabled: true, delivery_time: 'not-a-time' } });
  assert.equal(badTime.status, 400);
});

test('PUT /waste/reminder-settings/:typeId: 404 for a type that does not exist', async () => {
  const r = await call('PUT', '/waste/reminder-settings/999999', { body: { enabled: true } });
  assert.equal(r.status, 404);
});

// -------------------------------------------------------------------------
// ICS feed (#1063 Phase 10)
// -------------------------------------------------------------------------

test('GET /waste/feed: null before the feed is ever enabled', async () => {
  const r = await call('GET', '/waste/feed');
  assert.equal(r.status, 200);
  assert.equal(r.body.data, null);
});

test('POST /waste/feed/regenerate: issues a token/url, GET then reflects it', async () => {
  const issued = await call('POST', '/waste/feed/regenerate');
  assert.equal(issued.status, 200);
  assert.ok(issued.body.data.token);
  assert.ok(issued.body.data.url.endsWith(`/feed/waste/${issued.body.data.token}.ics`));
  assert.equal(issued.body.data.type_ids, null);

  const status = await call('GET', '/waste/feed');
  assert.equal(status.body.data.token, issued.body.data.token);
});

test('POST /waste/feed/regenerate: a second call rotates the token (previous URL stops matching)', async () => {
  const first = await call('POST', '/waste/feed/regenerate');
  const second = await call('POST', '/waste/feed/regenerate');
  assert.notEqual(second.body.data.token, first.body.data.token);
});

test('PUT /waste/feed/types: rejects an unknown type id, accepts a valid selection, null clears it', async () => {
  await call('POST', '/waste/feed/regenerate');
  const type = await createType({ name: 'Feed filter type' });

  const bad = await call('PUT', '/waste/feed/types', { body: { type_ids: [999999] } });
  assert.equal(bad.status, 400);

  const good = await call('PUT', '/waste/feed/types', { body: { type_ids: [type.id] } });
  assert.equal(good.status, 200, JSON.stringify(good.body));
  assert.deepEqual(good.body.data.type_ids, [type.id]);

  const cleared = await call('PUT', '/waste/feed/types', { body: { type_ids: null } });
  assert.equal(cleared.body.data.type_ids, null);
});

test('PUT /waste/feed/types: rejects a non-array, non-null body', async () => {
  await call('POST', '/waste/feed/regenerate');
  const r = await call('PUT', '/waste/feed/types', { body: { type_ids: 'nope' } });
  assert.equal(r.status, 400);
});

test('PUT /waste/feed/types: 404 when the caller has no feed enabled yet', async () => {
  await call('DELETE', '/waste/feed');
  const r = await call('PUT', '/waste/feed/types', { body: { type_ids: null } });
  assert.equal(r.status, 404);
});

test('DELETE /waste/feed: revokes - GET returns null again', async () => {
  await call('POST', '/waste/feed/regenerate');
  const del = await call('DELETE', '/waste/feed');
  assert.equal(del.status, 200);
  assert.equal(del.body.data, null);
  const status = await call('GET', '/waste/feed');
  assert.equal(status.body.data, null);
});

test('buildWasteFeed: emits a stable UID/all-day VEVENT for a seeded occurrence, honors the type selection', async () => {
  const { buildWasteFeed, regenerateFeedToken, setFeedTypeIds } = await import('../server/services/waste-ics.js');
  const shown = await createType({ name: 'Feed-shown' });
  const hidden = await createType({ name: 'Feed-hidden' });
  const soon = new Date();
  soon.setUTCDate(soon.getUTCDate() + 3);
  const dateKey = soon.toISOString().slice(0, 10);
  await call('POST', '/waste/pickups', { body: { type_id: shown.id, date: dateKey } });
  await call('POST', '/waste/pickups', { body: { type_id: hidden.id, date: dateKey } });

  const token = regenerateFeedToken(db, ADMIN);
  const unfiltered = buildWasteFeed(db, ADMIN);
  assert.match(unfiltered, /BEGIN:VCALENDAR/);
  assert.match(unfiltered, new RegExp(`UID:waste-pickup-${shown.id}-${dateKey}@yuvomi`));
  assert.match(unfiltered, new RegExp(`UID:waste-pickup-${hidden.id}-${dateKey}@yuvomi`));

  setFeedTypeIds(db, ADMIN, [shown.id]);
  const filtered = buildWasteFeed(db, ADMIN);
  assert.match(filtered, new RegExp(`UID:waste-pickup-${shown.id}-${dateKey}@yuvomi`));
  assert.doesNotMatch(filtered, new RegExp(`UID:waste-pickup-${hidden.id}-${dateKey}@yuvomi`));
  assert.ok(token, 'token was issued');

  // Real translated text, not the raw i18n key - a locale file missing
  // waste.icsPickupSummary/icsCalendarName would otherwise silently ship the
  // literal key to every calendar subscriber (translate()'s no-match
  // fallback returns the key itself, server/utils/i18n.js).
  assert.doesNotMatch(unfiltered, /waste\.icsPickupSummary/, 'SUMMARY must be translated text, not the raw key');
  assert.doesNotMatch(unfiltered, /waste\.icsCalendarName/, 'X-WR-CALNAME must be translated text, not the raw key');
  assert.match(unfiltered, /SUMMARY:.*Feed-shown/, 'the translated summary must still carry the type name');

  await call('DELETE', '/waste/feed');
});

// -------------------------------------------------------------------------
// Mapping profile export/import (#1063 Phase 10)
// -------------------------------------------------------------------------

test('GET /waste/sources/:id/mapping-profile/export: 404 for an unknown source', async () => {
  const r = await call('GET', '/waste/sources/999999/mapping-profile/export');
  assert.equal(r.status, 404);
});

test('GET /waste/sources/:id/mapping-profile/export: returns the source\'s resolved mappings as {pattern, type_name}', async () => {
  const source = await commitSource('2027-01-01');
  const r = await call('GET', `/waste/sources/${source.id}/mapping-profile/export`);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.version, 1);
  assert.equal(r.body.data.mappings.length, 1);
  assert.equal(r.body.data.mappings[0].pattern, 'restmüll');
});

test('mapping-profile import/preview: unchanged when the profile already matches, applicable when it points elsewhere', async () => {
  const source = await commitSource('2027-01-02');
  const exported = (await call('GET', `/waste/sources/${source.id}/mapping-profile/export`)).body.data;

  const same = await call('POST', `/waste/sources/${source.id}/mapping-profile/import/preview`, { body: { profile: exported } });
  assert.equal(same.status, 200);
  assert.equal(same.body.data.entries[0].status, 'unchanged');
  assert.equal(same.body.data.applicable_count, 0);

  const otherType = await createType({ name: 'Mapping profile target' });
  const redirected = { version: 1, mappings: [{ pattern: exported.mappings[0].pattern, type_name: otherType.name }] };
  const preview = await call('POST', `/waste/sources/${source.id}/mapping-profile/import/preview`, { body: { profile: redirected } });
  assert.equal(preview.body.data.entries[0].status, 'applicable');
  assert.equal(preview.body.data.applicable_count, 1);
});

test('mapping-profile import/preview: unmatched_pattern and unmatched_type are reported, never invented', async () => {
  const source = await commitSource('2027-01-03');
  const otherType = await createType({ name: 'Mapping profile target 2' });
  const profile = {
    version: 1,
    mappings: [
      { pattern: 'no such pattern in this source', type_name: otherType.name },
      { pattern: 'restmüll', type_name: 'No such type at all' },
    ],
  };
  const r = await call('POST', `/waste/sources/${source.id}/mapping-profile/import/preview`, { body: { profile } });
  assert.equal(r.body.data.entries[0].status, 'unmatched_pattern');
  assert.equal(r.body.data.entries[1].status, 'unmatched_type');
  assert.equal(r.body.data.applicable_count, 0);
});

test('mapping-profile import/preview: a name shared by two types resolves to the mapping\'s own current type (never guesses), and is ambiguous otherwise', async () => {
  const source = await commitSource('2027-01-05');
  const exported = (await call('GET', `/waste/sources/${source.id}/mapping-profile/export`)).body.data;
  const currentTypeName = exported.mappings[0].type_name;

  // A second, distinct type happens to share the exact same name (a real
  // household hit this: two "Gelbe Tonne" types, one created long before the
  // other). The profile names only the type by string - previewing it must
  // not silently repoint the mapping to whichever same-named type loaded last.
  await createType({ name: currentTypeName });

  const same = await call('POST', `/waste/sources/${source.id}/mapping-profile/import/preview`, { body: { profile: exported } });
  assert.equal(same.body.data.entries[0].status, 'unchanged',
    'the mapping already points at one of the two same-named types - it must resolve to ITS OWN current type, not the other one');
  assert.equal(same.body.data.applicable_count, 0);

  // Now the mapping doesn't currently point at either same-named candidate -
  // there is no idempotent choice left, so this must surface as ambiguous
  // rather than guessing.
  const thirdType = await createType({ name: 'Mapping profile ambiguity control' });
  await call('PUT', `/waste/sources/${source.id}/mappings/${(await call('GET', `/waste/sources/${source.id}`)).body.data.mappings[0].id}`,
    { body: { type_id: thirdType.id } });
  const ambiguous = await call('POST', `/waste/sources/${source.id}/mapping-profile/import/preview`, { body: { profile: exported } });
  assert.equal(ambiguous.body.data.entries[0].status, 'ambiguous_type');
  assert.equal(ambiguous.body.data.applicable_count, 0, 'an ambiguous entry must never count as applicable');
});

test('mapping-profile import/commit: applies applicable entries and updates the mapping, 409 on a stale digest', async () => {
  const source = await commitSource('2027-01-04');
  const exported = (await call('GET', `/waste/sources/${source.id}/mapping-profile/export`)).body.data;
  const otherType = await createType({ name: 'Mapping profile committed target' });
  const profile = { version: 1, mappings: [{ pattern: exported.mappings[0].pattern, type_name: otherType.name }] };

  const stale = await call('POST', `/waste/sources/${source.id}/mapping-profile/import/commit`, {
    body: { profile, profile_digest: 'not-the-real-digest' },
  });
  assert.equal(stale.status, 409);

  const preview = await call('POST', `/waste/sources/${source.id}/mapping-profile/import/preview`, { body: { profile } });
  const commit = await call('POST', `/waste/sources/${source.id}/mapping-profile/import/commit`, {
    body: { profile, profile_digest: preview.body.data.profile_digest },
  });
  assert.equal(commit.status, 200, JSON.stringify(commit.body));
  assert.equal(commit.body.data.applied_count, 1);

  const detail = await call('GET', `/waste/sources/${source.id}`);
  assert.equal(detail.body.data.mappings[0].type_id, otherType.id);
});

test('mapping-profile import/commit: 404 for an unknown source', async () => {
  const r = await call('POST', '/waste/sources/999999/mapping-profile/import/commit', {
    body: { profile: { version: 1, mappings: [] }, profile_digest: 'x' },
  });
  assert.equal(r.status, 404);
});

// -------------------------------------------------------------------------
// hasWasteWriteAccess / redactSourceForReader (pure, given a fabricated req) -
// an API token inherits its OWNER's actual module rights on top of whatever
// the token itself scopes down to; checking only the token's own scope let
// an unscoped (or waste:write-scoped) token issued for a read-only member
// still read that member's source url/last_error unredacted, even though the
// identical write 403s at the mount point (server/index.js) for that same
// token, because the mount point applies both gates in sequence.
// -------------------------------------------------------------------------

test('hasWasteWriteAccess/redactSourceForReader: a session with write module access sees url/last_error unredacted', () => {
  const req = { authMethod: 'session', sessionModuleAccess: null };
  assert.equal(helpers.hasWasteWriteAccess(req), true);
  const source = { id: 1, kind: 'url', url: 'https://example.com/cal.ics', last_error: 'boom' };
  assert.deepEqual(helpers.redactSourceForReader(source, req), source);
});

test('hasWasteWriteAccess/redactSourceForReader: a read-only session never sees url/last_error, regardless of an unscoped or write-scoped token', () => {
  const source = { id: 1, kind: 'url', url: 'https://example.com/cal.ics', last_error: 'boom' };
  const readOnlySession = { authMethod: 'session', sessionModuleAccess: { waste: 'read' } };
  assert.equal(helpers.hasWasteWriteAccess(readOnlySession), false);
  assert.deepEqual(helpers.redactSourceForReader(source, readOnlySession), { id: 1, kind: 'url' });

  // The bug this test guards: an unscoped token (authScopes null, meaning
  // "no scope restriction beyond the token owner's own role") was previously
  // enough on its own to grant write access here, ignoring that the token's
  // OWNER is a read-only member. Same for a token explicitly scoped
  // waste:write - scope only ever narrows what a token's owner can already
  // do, it cannot widen it.
  const unscopedTokenForReadOnlyMember = { authMethod: 'api_token', authScopes: null, sessionModuleAccess: { waste: 'read' } };
  assert.equal(helpers.hasWasteWriteAccess(unscopedTokenForReadOnlyMember), false);
  assert.deepEqual(helpers.redactSourceForReader(source, unscopedTokenForReadOnlyMember), { id: 1, kind: 'url' });

  const writeScopedTokenForReadOnlyMember = { authMethod: 'api_token', authScopes: ['waste:write'], sessionModuleAccess: { waste: 'read' } };
  assert.equal(helpers.hasWasteWriteAccess(writeScopedTokenForReadOnlyMember), false);
  assert.deepEqual(helpers.redactSourceForReader(source, writeScopedTokenForReadOnlyMember), { id: 1, kind: 'url' });
});

test('hasWasteWriteAccess: a write-scoped token for a member with actual write rights is allowed', () => {
  const req = { authMethod: 'api_token', authScopes: ['waste:write'], sessionModuleAccess: null };
  assert.equal(helpers.hasWasteWriteAccess(req), true);
});

test('hasWasteWriteAccess: a read-only-scoped token is denied even for an admin session, since the token itself narrows access', () => {
  const req = { authMethod: 'api_token', authScopes: ['waste:read'], sessionModuleAccess: null };
  assert.equal(helpers.hasWasteWriteAccess(req), false);
});
