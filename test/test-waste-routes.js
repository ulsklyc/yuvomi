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
// The upload limit is configuration, not a constant: 1 MB here, so the cases
// below see the limit the server READ in its answer (`params.limit_mb: 1`),
// not a 5 somebody wrote into a sentence (#1909).
process.env.MAX_UPLOAD_MB = '1';

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

const { BODY_LIMIT } = await import('../server/utils/upload-limit.js');

const app = express();
// The same body limit server/index.js mounts: a file just over the upload
// limit still reaches the route, which is what names the reason.
app.use(express.json({ limit: BODY_LIMIT }));
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
  assert.equal(r.body.reason, 'source_changed', 'the refusal names its reason, so the client can say it in the household language');
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
  // #1909: Fall und Zahlen des letzten Fehlschlags gehen mit dem Text.
  const source = {
    id: 1, kind: 'url', url: 'https://example.com/cal.ics', last_error: 'boom',
    last_error_reason: 'waste_source_fetch_http_status', last_error_params: { status: 503 },
  };
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

// -------------------------------------------------------------------------
// #1909: the server names the case (`reason`), the client owns the sentence
// -------------------------------------------------------------------------
//
// One case per reason, through the real routes: status AND reason. The `error`
// sentence stays (it is the API's), so each case also asserts it is still there.
// What a case answers is written down here by hand - it is not derived from the
// server source or from the client's map, so the two closing tests below compare
// three independent things: what the routes really answer, which literals the
// server source carries, and which reasons the client has a sentence for.

const MISSING = 987654;
const seenReasons = new Set();

async function expectReason(response, status, reason) {
  const r = await response;
  assert.equal(r.status, status, JSON.stringify(r.body));
  assert.equal(r.body.reason, reason, JSON.stringify(r.body));
  assert.equal(r.body.code, status);
  assert.equal(typeof r.body.error, 'string', 'the English sentence stays for API consumers');
  assert.ok(r.body.error.length > 0);
  seenReasons.add(reason);
}

const monthly = (typeId, overrides = {}) => ({
  type_id: typeId, recurrence_kind: 'monthly_fixed_day', anchor_date: '2026-01-15', interval: 1, month_day: 15, ...overrides,
});

test('reason waste_type_not_found: a type that is gone, on every route that names one', async () => {
  await expectReason(call('GET', `/waste/types/${MISSING}`), 404, 'waste_type_not_found');
  await expectReason(call('PUT', `/waste/types/${MISSING}`, { body: { name: 'x' } }), 404, 'waste_type_not_found');
  await expectReason(call('DELETE', `/waste/types/${MISSING}`), 404, 'waste_type_not_found');
  await expectReason(call('PUT', `/waste/reminder-settings/${MISSING}`, { body: { enabled: true } }), 404, 'waste_type_not_found');
});

// The CHOSEN type is gone - not the thing the request is about. Its own reason,
// so `waste_type_not_found` means one thing only (a 404: the type itself), and
// the page can keep a dialog open that merely offered a stale choice.
test('reason waste_selected_type_not_found: a schedule, pickup, mapping or import decision names a type that is gone', async () => {
  await expectReason(call('POST', '/waste/schedules', {
    body: { type_id: MISSING, recurrence_kind: 'weekly', anchor_date: '2026-01-05', interval: 1, weekdays: ['MO'] },
  }), 400, 'waste_selected_type_not_found');
  const type = await createType();
  const schedule = await createWeeklySchedule(type.id);
  await expectReason(call('PUT', `/waste/schedules/${schedule.id}`, { body: { type_id: MISSING } }), 400, 'waste_selected_type_not_found');
  await expectReason(call('POST', '/waste/pickups', { body: { type_id: MISSING, date: '2026-03-01' } }), 400, 'waste_selected_type_not_found');
  const source = await commitSource();
  const mapping = (await call('GET', `/waste/sources/${source.id}`)).body.data.mappings[0];
  await expectReason(call('PUT', `/waste/sources/${source.id}/mappings/${mapping.id}`, { body: { type_id: MISSING } }), 400, 'waste_selected_type_not_found');
  await expectReason(call('POST', '/waste/import/commit', {
    body: { ics: icsFixture('2026-10-09'), name: 'gone type', mappings: [{ normalized_label: 'restmüll', type_id: MISSING }] },
  }), 400, 'waste_selected_type_not_found');
});

test('reason waste_schedule_not_found: get, update, delete and an override on a schedule that is gone', async () => {
  await expectReason(call('GET', `/waste/schedules/${MISSING}`), 404, 'waste_schedule_not_found');
  await expectReason(call('PUT', `/waste/schedules/${MISSING}`, { body: { active: false } }), 404, 'waste_schedule_not_found');
  await expectReason(call('DELETE', `/waste/schedules/${MISSING}`), 404, 'waste_schedule_not_found');
  await expectReason(call('PUT', `/waste/schedules/${MISSING}/overrides/2026-01-05`, { body: { replacement_date: null } }), 404, 'waste_schedule_not_found');
});

test('reason waste_pickup_not_found: get, update and delete of a pickup that is gone', async () => {
  await expectReason(call('GET', `/waste/pickups/${MISSING}`), 404, 'waste_pickup_not_found');
  await expectReason(call('PUT', `/waste/pickups/${MISSING}`, { body: { date: '2026-03-01' } }), 404, 'waste_pickup_not_found');
  await expectReason(call('DELETE', `/waste/pickups/${MISSING}`), 404, 'waste_pickup_not_found');
});

test('reason waste_source_not_found: every source route on a source that is gone', async () => {
  for (const [method, path, body] of [
    ['GET', `/waste/sources/${MISSING}`],
    ['PUT', `/waste/sources/${MISSING}`, { name: 'x' }],
    ['DELETE', `/waste/sources/${MISSING}`],
    ['POST', `/waste/sources/${MISSING}/refresh`, {}],
    ['GET', `/waste/sources/${MISSING}/mapping-profile/export`],
    ['POST', `/waste/sources/${MISSING}/mapping-profile/import/preview`, { profile: { mappings: [] } }],
    ['POST', `/waste/sources/${MISSING}/mapping-profile/import/commit`, { profile: { mappings: [] } }],
    ['PUT', `/waste/sources/${MISSING}/mappings/1`, { ignored: true }],
    ['POST', `/waste/sources/${MISSING}/reimport/preview`, { ics: icsFixture('2026-10-03') }],
    ['POST', `/waste/sources/${MISSING}/reimport/commit`, { ics: icsFixture('2026-10-03') }],
  ]) {
    await expectReason(call(method, path, { body }), 404, 'waste_source_not_found');
  }
});

test('reason waste_mapping_not_found: a mapping that is gone on a source that exists', async () => {
  const source = await commitSource();
  await expectReason(call('PUT', `/waste/sources/${source.id}/mappings/${MISSING}`, { body: { ignored: true } }), 404, 'waste_mapping_not_found');
});

test('reason waste_override_not_found and waste_occurrence_not_found: restoring twice, moving a day the schedule does not have', async () => {
  const type = await createType();
  const schedule = await createWeeklySchedule(type.id);
  await expectReason(call('DELETE', `/waste/schedules/${schedule.id}/overrides/2026-01-05`), 404, 'waste_override_not_found');
  // 2026-01-06 is a Tuesday; the schedule runs on Mondays.
  await expectReason(call('PUT', `/waste/schedules/${schedule.id}/overrides/2026-01-06`, { body: { replacement_date: '2026-01-08' } }), 400, 'waste_occurrence_not_found');
});

test('reason waste_type_in_use and waste_pickup_exists: the two conflicts', async () => {
  const type = await createType();
  await createWeeklySchedule(type.id);
  await expectReason(call('DELETE', `/waste/types/${type.id}`), 409, 'waste_type_in_use');

  const first = await call('POST', '/waste/pickups', { body: { type_id: type.id, date: '2026-04-01' } });
  assert.equal(first.status, 201);
  await expectReason(call('POST', '/waste/pickups', { body: { type_id: type.id, date: '2026-04-01' } }), 409, 'waste_pickup_exists');
  const second = await call('POST', '/waste/pickups', { body: { type_id: type.id, date: '2026-04-02' } });
  await expectReason(call('PUT', `/waste/pickups/${second.body.data.id}`, { body: { date: '2026-04-01' } }), 409, 'waste_pickup_exists');
});

test('reasons of the schedule dialog: each input the dialog lets through names its own case', async () => {
  const type = await createType();
  const weekly = (overrides) => ({ type_id: type.id, recurrence_kind: 'weekly', anchor_date: '2026-01-05', interval: 1, weekdays: ['MO'], ...overrides });
  const post = (body) => call('POST', '/waste/schedules', { body });

  await expectReason(post(weekly({ anchor_date: '' })), 400, 'waste_schedule_anchor_date_invalid');
  await expectReason(post(weekly({ valid_until: '2026-01-01' })), 400, 'waste_schedule_ends_before_anchor');
  await expectReason(post(weekly({ weekdays: [] })), 400, 'waste_schedule_weekdays_required');
  await expectReason(post(weekly({ interval: 53 })), 400, 'waste_schedule_interval_invalid');
  await expectReason(post(monthly(type.id, { interval: 25 })), 400, 'waste_schedule_interval_invalid');
  await expectReason(post({ type_id: type.id, recurrence_kind: 'monthly_ordinal_weekday', anchor_date: '2026-01-13', interval: 25, weekdays: 'TU', month_day: 2 }), 400, 'waste_schedule_interval_invalid');
  await expectReason(post(monthly(type.id, { month_day: 0, anchor_date: '2026-01-15' })), 400, 'waste_schedule_month_day_invalid');
  await expectReason(post(monthly(type.id, { month_day: 1 })), 400, 'waste_schedule_anchor_not_month_day');
  await expectReason(post(monthly(type.id, { month_day: -1 })), 400, 'waste_schedule_anchor_not_last_day');
  // 2026-01-13 is the second Tuesday; the 14th is not.
  await expectReason(post({ type_id: type.id, recurrence_kind: 'monthly_ordinal_weekday', anchor_date: '2026-01-14', interval: 1, weekdays: 'TU', month_day: 2 }), 400, 'waste_schedule_anchor_not_ordinal_weekday');

  // The same through the update route.
  const schedule = await createWeeklySchedule(type.id);
  await expectReason(call('PUT', `/waste/schedules/${schedule.id}`, { body: { weekdays: [] } }), 400, 'waste_schedule_weekdays_required');
});

test('a validation only an API caller triggers carries no reason, and does not hide one a member can reach', async () => {
  const type = await createType();
  const apiOnly = await call('POST', '/waste/schedules', {
    body: { type_id: type.id, recurrence_kind: 'yearly', anchor_date: '2026-01-05', interval: 1 },
  });
  assert.equal(apiOnly.status, 400);
  assert.equal('reason' in apiOnly.body, false, JSON.stringify(apiOnly.body));

  // Two problems at once: the response carries every sentence and the reason of
  // the first problem that has one.
  const both = await call('POST', '/waste/schedules', {
    body: { type_id: type.id, recurrence_kind: 'weekly', anchor_date: '2026-01-05', interval: 1, weekdays: [], valid_until: 'someday' },
  });
  assert.equal(both.status, 400);
  assert.equal(both.body.reason, 'waste_schedule_weekdays_required');
  assert.match(both.body.error, /^valid_until must be a valid YYYY-MM-DD date\. weekdays must be a non-empty list/,
    'the problem without a reason comes first and does not take the reason away from the second');

  const typeName = await call('POST', '/waste/types', { body: {} });
  assert.equal(typeName.status, 400);
  assert.equal('reason' in typeName.body, false);
});

test('reasons waste_pickup_date_invalid, waste_override_date_invalid, waste_override_same_date: an empty or unchanged date', async () => {
  const type = await createType();
  await expectReason(call('POST', '/waste/pickups', { body: { type_id: type.id, date: '' } }), 400, 'waste_pickup_date_invalid');
  const pickup = await call('POST', '/waste/pickups', { body: { type_id: type.id, date: '2026-05-01' } });
  await expectReason(call('PUT', `/waste/pickups/${pickup.body.data.id}`, { body: { date: '' } }), 400, 'waste_pickup_date_invalid');

  const schedule = await createWeeklySchedule(type.id);
  const override = (replacement) => call('PUT', `/waste/schedules/${schedule.id}/overrides/2026-01-05`, { body: { replacement_date: replacement } });
  await expectReason(override(''), 400, 'waste_override_date_invalid');
  await expectReason(override('2026-01-05'), 400, 'waste_override_same_date');
});

test('reasons waste_reminder_offset_invalid and waste_reminder_time_invalid: the two fields of a reminder row', async () => {
  const type = await createType();
  const put = (body) => call('PUT', `/waste/reminder-settings/${type.id}`, { body });
  await expectReason(put({ enabled: true, offset_days: 99, delivery_time: '08:00' }), 400, 'waste_reminder_offset_invalid');
  await expectReason(put({ enabled: true, offset_days: 'soon', delivery_time: '08:00' }), 400, 'waste_reminder_offset_invalid');
  await expectReason(put({ enabled: true, offset_days: 1, delivery_time: '25:00' }), 400, 'waste_reminder_time_invalid');
  // The emptied time field of the dialog: this was a 500 (NOT NULL constraint).
  await expectReason(put({ enabled: true, offset_days: 1, delivery_time: '' }), 400, 'waste_reminder_time_invalid');
});

// -------------------------------------------------------------------------
// #1909, second slice: import limits, mapping profile, URL sources
// -------------------------------------------------------------------------

/** Like expectReason, and the numbers of the cause travel structured next to it. */
async function expectReasonWithParams(response, status, reason, params) {
  const r = await response;
  await expectReason(r, status, reason);
  assert.deepEqual(r.body.params, params, JSON.stringify(r.body));
  return r;
}

const vcalendar = (events) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.join('\r\n')}\r\nEND:VCALENDAR`;

test('reasons of the import limits: an empty or oversized file, too many entries, pickups or labels - each with its limit as a number', async () => {
  const { MAX_ICS_BYTES, MAX_VEVENTS, MAX_DISTINCT_LABELS, MAX_CANDIDATE_INSTANCES } = await import('../server/services/waste-import.js');
  assert.equal(MAX_ICS_BYTES, 1024 * 1024, 'the suite runs with MAX_UPLOAD_MB=1');
  const source = await commitSource();
  const previews = ['/waste/import/preview', `/waste/sources/${source.id}/reimport/preview`];

  for (const path of previews) {
    await expectReason(call('POST', path, { body: {} }), 400, 'waste_import_empty_file');
    await expectReason(call('POST', path, { body: { ics: '   ' } }), 400, 'waste_import_empty_file');
    const tooLarge = await expectReasonWithParams(call('POST', path, { body: { ics: 'X'.repeat(MAX_ICS_BYTES + 1) } }),
      400, 'waste_import_file_too_large', { limit_mb: 1 });
    assert.match(tooLarge.body.error, /exceeds the 1 MB upload limit/, 'the sentence for API consumers is unchanged');
  }
  await expectReason(call('POST', '/waste/import/commit', { body: { name: 'x' } }), 400, 'waste_import_empty_file');

  const manyEvents = [];
  for (let i = 0; i <= MAX_VEVENTS; i += 1) manyEvents.push(`BEGIN:VEVENT\r\nUID:m-${i}@x\r\nSUMMARY:R\r\nDTSTART;VALUE=DATE:20260701\r\nEND:VEVENT`);
  const manyLabels = [];
  for (let i = 0; i <= MAX_DISTINCT_LABELS; i += 1) manyLabels.push(`BEGIN:VEVENT\r\nUID:l-${i}@x\r\nSUMMARY:Label-${i}\r\nCATEGORIES:Label-${i}\r\nDTSTART;VALUE=DATE:20260701\r\nEND:VEVENT`);
  // Six daily series from the start of the import window: more instances in
  // the window than the cap, however the day of the run falls.
  const windowStart = new Date(Date.now() - 360 * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
  const manyInstances = [];
  for (let i = 0; i < 6; i += 1) manyInstances.push(`BEGIN:VEVENT\r\nUID:i-${i}@x\r\nSUMMARY:R\r\nDTSTART;VALUE=DATE:${windowStart}\r\nRRULE:FREQ=DAILY;COUNT=1500\r\nEND:VEVENT`);

  for (const [events, reason, limit] of [
    [manyEvents, 'waste_import_event_cap_exceeded', MAX_VEVENTS],
    [manyLabels, 'waste_import_label_cap_exceeded', MAX_DISTINCT_LABELS],
    [manyInstances, 'waste_import_instance_cap_exceeded', MAX_CANDIDATE_INSTANCES],
  ]) {
    for (const path of previews) {
      await expectReasonWithParams(call('POST', path, { body: { ics: vcalendar(events) } }), 400, reason, { limit });
    }
    // The commit reparses and names the same case.
    await expectReasonWithParams(call('POST', '/waste/import/commit', { body: { ics: vcalendar(events), name: 'x', mappings: [] } }), 400, reason, { limit });
  }
});

test('an import refusal only an API caller triggers carries no reason and no params', async () => {
  for (const body of [
    { ics: icsFixture('2026-10-11') },                          // no name
    { ics: icsFixture('2026-10-11'), name: 'x', mappings: [] }, // no decision for the label
  ]) {
    const r = await call('POST', '/waste/import/commit', { body });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal('reason' in r.body, false, JSON.stringify(r.body));
    assert.equal('params' in r.body, false, JSON.stringify(r.body));
  }
});

test('reasons preview_changed and source_changed: the two refusals of a stale preview', async () => {
  const source = await commitSource('2026-11-21');
  const preview = await call('POST', `/waste/sources/${source.id}/reimport/preview`, { body: { ics: icsFixture('2026-11-21') } });
  const mappings = [{ normalized_label: 'restmüll', ignored: true }];
  await expectReason(call('POST', `/waste/sources/${source.id}/reimport/commit`, {
    body: { ics: icsFixture('2026-11-21'), mappings, expected_version: preview.body.data.expected_version + 7, preview_digest: preview.body.data.digest },
  }), 409, 'source_changed');
  await expectReason(call('POST', `/waste/sources/${source.id}/reimport/commit`, {
    body: { ics: icsFixture('2026-11-22'), mappings, expected_version: preview.body.data.expected_version, preview_digest: preview.body.data.digest },
  }), 409, 'preview_changed');
});

test('reasons waste_profile_invalid and waste_profile_changed: a file that is no mapping profile, a profile other than the previewed one', async () => {
  const source = await commitSource();
  const preview = (profile) => call('POST', `/waste/sources/${source.id}/mapping-profile/import/preview`, { body: { profile } });
  await expectReason(preview(undefined), 400, 'waste_profile_invalid');
  await expectReason(preview('a string'), 400, 'waste_profile_invalid');
  await expectReason(preview({ anything: 'else' }), 400, 'waste_profile_invalid');
  await expectReason(preview({ mappings: [{ pattern: 'restmüll' }] }), 400, 'waste_profile_invalid');
  await expectReason(preview({ mappings: [{ pattern: ' ', type_name: 'x' }] }), 400, 'waste_profile_invalid');

  const commit = (body) => call('POST', `/waste/sources/${source.id}/mapping-profile/import/commit`, { body });
  await expectReason(commit({ profile: [] }), 400, 'waste_profile_invalid');
  await expectReason(commit({ profile: { mappings: [] }, profile_digest: 'not the digest of this profile' }), 409, 'waste_profile_changed');
});

async function sourceCount() {
  return (await call('GET', '/waste/sources')).body.data.length;
}

test('reasons of the URL source dialog: an address that is none, one without https, an interval out of bounds - and no source is left behind', async () => {
  const { MIN_REFRESH_INTERVAL_MINUTES, MAX_REFRESH_INTERVAL_MINUTES } = await import('../server/services/waste-url-source.js');
  assert.equal(process.env.WASTE_SOURCE_ALLOW_PRIVATE_NETWORK, undefined, 'https is required in this part');
  const before = await sourceCount();
  const post = (body) => call('POST', '/waste/sources', { body: { name: 'Feed', ...body } });
  const bounds = { min: MIN_REFRESH_INTERVAL_MINUTES, max: MAX_REFRESH_INTERVAL_MINUTES };

  await expectReason(post({}), 400, 'waste_source_url_invalid');
  await expectReason(post({ url: 'not an address' }), 400, 'waste_source_url_invalid');
  await expectReason(post({ url: 'ftp://example.org/a.ics' }), 400, 'waste_source_url_invalid');
  await expectReason(post({ url: 'http://example.org/a.ics' }), 400, 'waste_source_url_not_https');
  for (const interval of [MIN_REFRESH_INTERVAL_MINUTES - 1, MAX_REFRESH_INTERVAL_MINUTES + 1, 90.5, 'often']) {
    await expectReasonWithParams(post({ url: 'https://example.org/a.ics', refresh_interval_minutes: interval }), 400, 'waste_source_interval_invalid', bounds);
  }
  assert.equal(await sourceCount(), before, 'a refused dialog creates nothing, and none of these reached the network');

  // No name: only an API caller gets here (the dialog fills one in).
  const unnamed = await call('POST', '/waste/sources', { body: { url: 'https://example.org/a.ics' } });
  assert.equal(unnamed.status, 400);
  assert.equal('reason' in unnamed.body, false);
});

test('reason waste_source_not_url: a manual refresh of a source that came from a file', async () => {
  const source = await commitSource();
  await expectReason(call('POST', `/waste/sources/${source.id}/refresh`, { body: {} }), 400, 'waste_source_not_url');
});

/** A throwaway local stand-in for the other side; never the network. `handler` may be swapped between requests. */
async function startStandIn() {
  const standIn = { handler: (_req, res) => { res.writeHead(500).end(); } };
  const remote = http.createServer((req, res) => standIn.handler(req, res));
  await new Promise((r) => remote.listen(0, '127.0.0.1', r));
  standIn.url = `http://127.0.0.1:${remote.address().port}/cal.ics`;
  standIn.close = () => new Promise((r) => { remote.closeAllConnections?.(); remote.close(r); });
  return standIn;
}

/** A port nothing listens on: bound once, then released. */
async function closedPort() {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

async function withPrivateNetwork(run) {
  process.env.WASTE_SOURCE_ALLOW_PRIVATE_NETWORK = 'true';
  try { return await run(); } finally { delete process.env.WASTE_SOURCE_ALLOW_PRIVATE_NETWORK; }
}

/** The answer of a refresh that ran and failed at the fetch: 200, outcome 'error', the class as reason. */
async function expectFetchFailure(response, status, reason, params) {
  const r = await response;
  assert.equal(r.status, status, JSON.stringify(r.body));
  assert.equal(r.body.data.outcome, 'error', JSON.stringify(r.body));
  assert.equal(r.body.data.reason, reason, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.params, params, JSON.stringify(r.body));
  seenReasons.add(reason);
  return r;
}

test('reasons of a failed fetch: one per class - the status of the other side, too large, unreachable, a blocked address - on refresh, create and re-import', async () => {
  const standIn = await startStandIn();
  try {
    const labelType = await createType({ name: `Feedtype-${randomUUID()}` });
    const feed = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:feed-1@x\r\nSUMMARY:${labelType.name}\r\nDTSTART;VALUE=DATE:20261201\r\nEND:VEVENT\r\nEND:VCALENDAR`;
    standIn.handler = (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/calendar' }).end(feed); };
    const created = await withPrivateNetwork(() => call('POST', '/waste/sources', { body: { name: 'Feed', url: standIn.url } }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.notEqual(created.body.data.outcome, 'error');
    assert.equal('reason' in created.body.data, false, 'a fetch that worked names no failure');
    const id = created.body.data.source.id;
    const refresh = () => withPrivateNetwork(() => call('POST', `/waste/sources/${id}/refresh`, { body: {} }));
    const reimport = (step) => withPrivateNetwork(() => call('POST', `/waste/sources/${id}/reimport/${step}`, { body: {} }));

    // The other side answers, but not with a calendar.
    for (const status of [404, 503]) {
      standIn.handler = (_req, res) => { res.writeHead(status).end('nope'); };
      const failed = await expectFetchFailure(refresh(), 200, 'waste_source_fetch_http_status', { status });
      assert.match(failed.body.data.source.last_error, new RegExp(`HTTP ${status}`), 'the stored text is unchanged');
      for (const step of ['preview', 'commit']) {
        const r = await expectReasonWithParams(reimport(step), 502, 'waste_source_fetch_http_status', { status });
        assert.equal(r.body.error, `Fetching the source URL failed: HTTP ${status}`, 'the sentence for API consumers is unchanged');
      }
    }

    // More than the upload limit: announced, and unannounced mid-stream.
    const { MAX_ICS_BYTES } = await import('../server/services/waste-import.js');
    standIn.handler = (_req, res) => { res.writeHead(200, { 'Content-Length': String(MAX_ICS_BYTES + 1) }); res.write('X'); };
    await expectFetchFailure(refresh(), 200, 'waste_source_fetch_too_large', { limit_mb: 1 });
    standIn.handler = (_req, res) => { res.writeHead(200); res.end('X'.repeat(MAX_ICS_BYTES + 10)); };
    await expectFetchFailure(refresh(), 200, 'waste_source_fetch_too_large', { limit_mb: 1 });
    await expectReasonWithParams(reimport('preview'), 502, 'waste_source_fetch_too_large', { limit_mb: 1 });

    // Nothing answers: a refused connection, and a connection cut mid-answer.
    standIn.handler = (req) => { req.socket.destroy(); };
    await expectFetchFailure(refresh(), 200, 'waste_source_fetch_unreachable', undefined);
    await expectReason(reimport('preview'), 502, 'waste_source_fetch_unreachable');
    const dead = `http://127.0.0.1:${await closedPort()}/cal.ics`;
    const unreachable = await expectFetchFailure(
      withPrivateNetwork(() => call('POST', '/waste/sources', { body: { name: 'Dead', url: dead } })),
      201, 'waste_source_fetch_unreachable', undefined,
    );
    assert.equal(typeof unreachable.body.data.source.id, 'number', 'the source is created either way, as before');

    // Without the opt-in a private address is refused before any connection.
    const localUrl = `https://127.0.0.1:${await closedPort()}/cal.ics`;
    const local = await withPrivateNetwork(() => call('POST', '/waste/sources', { body: { name: 'Local', url: localUrl } }));
    assert.equal(local.status, 201, JSON.stringify(local.body));
    const blocked = await expectFetchFailure(call('POST', `/waste/sources/${local.body.data.source.id}/refresh`, { body: {} }), 200, 'waste_source_fetch_blocked', undefined);
    assert.match(blocked.body.data.source.last_error, /private IP address/);
    await expectReason(call('POST', `/waste/sources/${local.body.data.source.id}/reimport/preview`, { body: {} }), 502, 'waste_source_fetch_blocked');

    // A stored address that no longer passes validation (http, opt-in removed):
    // the reason of the validation, not a class of its own.
    await expectReason(call('POST', `/waste/sources/${id}/reimport/preview`, { body: {} }), 502, 'waste_source_url_not_https');
    await expectFetchFailure(call('POST', `/waste/sources/${id}/refresh`, { body: {} }), 200, 'waste_source_url_not_https', undefined);
  } finally {
    await standIn.close();
  }
});

// -------------------------------------------------------------------------
// #1938: zero calendar entries is never a calendar
// -------------------------------------------------------------------------

const NO_EVENT_TEXTS = [
  ['an HTML page', '<html><head><title>Login</title></head><body><form><input name="user"></form></body></html>'],
  ['an empty VCALENDAR', 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//x//EN\r\nEND:VCALENDAR\r\n'],
];

function importedPickupCount(sourceId) {
  return db.prepare('SELECT COUNT(*) AS n FROM waste_imported_pickups WHERE source_id = ?').get(sourceId).n;
}

test('reason waste_import_no_events: a file without a calendar entry is refused at the preview and at the commit - fresh import and re-import, and nothing is created or removed', async () => {
  const source = await commitSource('2026-11-05');
  assert.equal(importedPickupCount(source.id), 1);
  const sourcesBefore = await sourceCount();
  for (const [name, ics] of NO_EVENT_TEXTS) {
    // The preview refuses already: nobody gets to confirm "0 pickups".
    for (const path of ['/waste/import/preview', `/waste/sources/${source.id}/reimport/preview`]) {
      const r = await expectReasonWithParams(call('POST', path, { body: { ics } }), 400, 'waste_import_no_events', undefined);
      assert.equal(r.body.error, 'The file contains no calendar entries.', `${name}: ${path}`);
      assert.equal('params' in r.body, false);
    }
    // A client that goes straight to the commit, with everything it needs.
    await expectReason(call('POST', '/waste/import/commit', { body: { ics, name: `Empty ${name}`, mappings: [] } }), 400, 'waste_import_no_events');
    await expectReason(call('POST', `/waste/sources/${source.id}/reimport/commit`, { body: { ics, mappings: [], expected_version: source.version } }), 400, 'waste_import_no_events');
  }
  assert.equal(await sourceCount(), sourcesBefore, 'no empty source was created');
  assert.equal(importedPickupCount(source.id), 1, 'the re-import removed nothing');
  assert.equal((await call('GET', `/waste/sources/${source.id}`)).body.data.version, source.version);

  // A calendar WITH entries, none of them a pickup (far outside the window),
  // previews and commits as before: the rule is about what the file holds.
  const far = icsFixture('2040-01-01');
  const preview = await call('POST', `/waste/sources/${source.id}/reimport/preview`, { body: { ics: far } });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(preview.body.data.counts, { events: 1, candidates: 0, distinct_labels: 0 });
  const commit = await call('POST', `/waste/sources/${source.id}/reimport/commit`, {
    body: { ics: far, mappings: [], expected_version: source.version, preview_digest: preview.body.data.digest },
  });
  assert.equal(commit.status, 200, JSON.stringify(commit.body));
  assert.equal(commit.body.data.diff.removed, 1);
});

test('reason waste_source_fetch_no_events: an address that answers 200 without a calendar entry - on refresh, on create and in the reviewed re-import', async () => {
  const standIn = await startStandIn();
  try {
    const labelType = await createType({ name: `Emptyfeed-${randomUUID()}` });
    const feed = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:ef-1@x\r\nSUMMARY:${labelType.name}\r\nDTSTART;VALUE=DATE:20261201\r\nEND:VEVENT\r\nEND:VCALENDAR`;
    standIn.handler = (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/calendar' }).end(feed); };
    const created = await withPrivateNetwork(() => call('POST', '/waste/sources', { body: { name: 'Feed that goes empty', url: standIn.url } }));
    assert.equal(created.body.data.outcome, 'needs_mapping', JSON.stringify(created.body));
    const id = created.body.data.source.id;
    // The reviewed first commit, so that the source HAS a pickup to lose.
    const first = await withPrivateNetwork(() => call('POST', `/waste/sources/${id}/reimport/commit`, {
      body: {
        expected_version: created.body.data.preview.expected_version, preview_digest: created.body.data.preview.digest,
        mappings: created.body.data.preview.labels.map((l) => ({ normalized_label: l.normalized_label, type_id: labelType.id })),
      },
    }));
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const { version } = first.body.data.source;
    assert.equal(importedPickupCount(id), 1);

    for (const [name, body] of NO_EVENT_TEXTS) {
      standIn.handler = (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html', ETag: '"page"' }).end(body); };
      const refreshed = await expectFetchFailure(withPrivateNetwork(() => call('POST', `/waste/sources/${id}/refresh`, { body: {} })), 200, 'waste_source_fetch_no_events', undefined);
      assert.equal(refreshed.body.data.source.last_error, 'No calendar entries in the response', name);
      assert.equal(refreshed.body.data.source.version, version, 'nothing was committed');
      assert.equal(importedPickupCount(id), 1, `${name}: the imported pickup is still there`);
      for (const step of ['preview', 'commit']) {
        const r = await expectReasonWithParams(
          withPrivateNetwork(() => call('POST', `/waste/sources/${id}/reimport/${step}`, { body: { mappings: [], expected_version: version } })),
          502, 'waste_source_fetch_no_events', undefined,
        );
        assert.equal(r.body.error, 'Fetching the source URL failed: No calendar entries in the response');
      }
      const fresh = await expectFetchFailure(
        withPrivateNetwork(() => call('POST', '/waste/sources', { body: { name: `Typo ${name}`, url: standIn.url } })),
        201, 'waste_source_fetch_no_events', undefined,
      );
      assert.equal(fresh.body.data.source.version, 0, 'the first answer was not taken for a calendar');
    }
    assert.equal(importedPickupCount(id), 1);
  } finally {
    await standIn.close();
  }
});

test('reason refresh_in_progress: a second manual refresh while the first is still fetching', async () => {
  const standIn = await startStandIn();
  try {
    let release;
    const held = new Promise((r) => { release = r; });
    let arrived;
    const first = new Promise((r) => { arrived = r; });
    standIn.handler = async (_req, res) => { arrived(); await held; res.writeHead(304).end(); };
    const { createUrlSourcePlaceholder } = await import('../server/services/waste-store.js');
    const source = createUrlSourcePlaceholder(db, { name: 'Slow', url: standIn.url, refreshIntervalMinutes: 60, userId: ADMIN });
    await withPrivateNetwork(async () => {
      const running = call('POST', `/waste/sources/${source.id}/refresh`, { body: {} });
      await first;
      await expectReason(call('POST', `/waste/sources/${source.id}/refresh`, { body: {} }), 409, 'refresh_in_progress');
      release();
      assert.equal((await running).status, 200);
    });
  } finally {
    await standIn.close();
  }
});

// Runs after the cases above (node:test keeps file order): what they SAW.
test('every waste_* reason the server source carries is answered by a real route, and nothing else is', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const files = [
    ...readdirSync(new URL('../server/routes/waste/', import.meta.url)).map((name) => `../server/routes/waste/${name}`),
    ...readdirSync(new URL('../server/services/', import.meta.url)).filter((name) => name.startsWith('waste-')).map((name) => `../server/services/${name}`),
  ];
  assert.ok(files.length >= 15, 'the scan found the waste routes and services');
  const inSource = new Set();
  for (const file of files) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    // A reason stands as `reason: '...'` or as the trailing argument of a typed
    // error / a domain problem. `entity_type = 'waste_pickup'` in SQL is neither.
    // Three reasons are older than the `waste_` prefix (#1795) and part of the
    // promised API, so they keep their names.
    for (const [, reason] of text.matchAll(/(?:reason:\s*|,\s*)'(waste_[a-z_]+|preview_changed|source_changed|refresh_in_progress)'\s*[)},]/g)) inSource.add(reason);
  }
  // An import limit names its reason through its own code: the store builds
  // `waste_import_<code>` from the WasteImportError it catches.
  const importer = readFileSync(new URL('../server/services/waste-import.js', import.meta.url), 'utf8');
  const codes = [...importer.matchAll(/new WasteImportError\([^\n]*?,\s*'([a-z_]+)'\s*[,)]/g)].map((m) => m[1]);
  assert.equal(codes.length, 6, `the scan reads the import refusals (found ${codes.join(', ')})`);
  for (const code of codes) inSource.add(`waste_import_${code}`);
  assert.ok(inSource.size >= 20, `the scan reads reasons at all (found ${inSource.size})`);
  assert.deepEqual([...seenReasons].sort(), [...inSource].sort(),
    'a reason in the server source has no case above that sees it in a real answer - or a case sees one the scan misses');
});

test('every waste_* reason a route answers has a sentence in the client, and the client knows no other', async () => {
  const { readFileSync } = await import('node:fs');
  // The client side, read without the server: the map in public/utils/friendly-error.js.
  // This suite runs without the browser loader, so the map is read as text here;
  // test:friendly-error imports the same file as a program and checks the keys
  // in every locale.
  const client = readFileSync(new URL('../public/utils/friendly-error.js', import.meta.url), 'utf8');
  const caseMap = client.slice(client.indexOf('export const CASE_MESSAGES'), client.indexOf('export const GONE_REASONS'));
  // Every reason whose sentence is a waste sentence - with or without the prefix.
  const withSentence = new Set([...caseMap.matchAll(/^\s*\['([a-z_]+)',\s*'waste\.[A-Za-z]+'\],?\s*$/gm)].map((m) => m[1]));
  assert.ok(withSentence.size >= 40, `the map is read at all (found ${withSentence.size})`);
  assert.deepEqual([...withSentence].sort(), [...seenReasons].sort(),
    'server and client disagree: a reason without a sentence shows the general one and hides the cause, '
    + 'a sentence without a reason is never shown');
});
