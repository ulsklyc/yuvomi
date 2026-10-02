process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');
const { buildCalendarFeed } = await import('../server/services/ics-export.js');
const { findCalendarByFeedToken, ensureDefaultCalendar, resolveLocalCalendarId } = await import('../server/services/local-calendars.js');

const db = dbmod.get();
const ADMIN = { id: 1, role: 'admin' };

db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run();

let actor = ADMIN;
const app = express();
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.sessionModuleAccess = { calendar: actor.access ?? 'write' };
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use('/', calendarRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((resolve) => {
  server.on('listening', () => resolve(`http://127.0.0.1:${server.address().port}`));
});

test.after(() => server.close());

async function call(method, route, { body } = {}) {
  const headers = {};
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${route}`, { method, headers, body: payload });
  const ct = res.headers.get('content-type') || '';
  let json = null;
  if (ct.includes('application/json')) json = await res.json();
  return { status: res.status, body: json };
}

async function createCalendar(name, color) {
  const res = await call('POST', '/calendars', { body: { name, color } });
  assert.equal(res.status, 201);
  return res.body.data;
}

async function createEvent(title, calendarId = undefined) {
  const res = await call('POST', '/', {
    body: {
      title,
      start_datetime: '2035-05-01T09:00',
      end_datetime: '2035-05-01T10:00',
      local_calendar_id: calendarId,
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

test('local calendars: default exists and calendars can be created', async () => {
  const before = await call('GET', '/calendars');
  assert.equal(before.status, 200);
  assert.ok(before.body.data.some((calendar) => calendar.is_default), 'default calendar exists');

  const work = await createCalendar('Work', '#3366AA');
  assert.equal(work.name, 'Work');
  assert.equal(work.color, '#3366AA');
  assert.equal(work.is_default, false);
});

test('event create assigns selected calendar and older clients fall back to default', async () => {
  const family = await createCalendar('Family', '#CC3355');
  const event = await createEvent('Family appointment', family.id);
  assert.equal(event.local_calendar_id, family.id);
  assert.equal(event.local_calendar_name, 'Family');
  assert.equal(event.local_calendar_color, '#CC3355');

  const fallback = await createEvent('Default appointment');
  assert.ok(fallback.local_calendar_id > 0, 'missing local_calendar_id falls back');
  const defaultCalendar = (await call('GET', '/calendars')).body.data.find((calendar) => calendar.is_default);
  assert.equal(fallback.local_calendar_id, defaultCalendar.id);
});

test('calendar feed token exports only one local calendar', async () => {
  const privateCalendar = await createCalendar('Private feed', '#22AA66');
  const sharedCalendar = await createCalendar('Shared feed', '#AA6622');
  await createEvent('Only private feed', privateCalendar.id);
  await createEvent('Only shared feed', sharedCalendar.id);

  const tokenRes = await call('POST', `/calendars/${privateCalendar.id}/feed/regenerate`);
  assert.equal(tokenRes.status, 200);
  const token = tokenRes.body.data.token;
  assert.equal(findCalendarByFeedToken(db, token)?.id, privateCalendar.id);

  const ics = buildCalendarFeed(db, privateCalendar.id, new Date('2035-05-02T00:00:00Z'), 'Europe/Brussels');
  assert.match(ics, /X-WR-CALNAME:Private feed/);
  assert.match(ics, /SUMMARY:Only private feed/);
  assert.doesNotMatch(ics, /SUMMARY:Only shared feed/);
});

test('local calendar feeds exclude externally synchronized events', async () => {
  const local = await createCalendar('Local only', '#445566');
  const localEvent = await createEvent('Local event', local.id);
  const insert = db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, external_source, external_calendar_id, local_calendar_id, created_by)
    VALUES (?, ?, ?, 'google', ?, ?, ?)
  `);
  assert.throws(() => insert.run('Google event', '2035-05-01T11:00:00Z', '2035-05-01T12:00:00Z', 'google-id', local.id, ADMIN.id), /mutually exclusive/);
  insert.run('Google event', '2035-05-01T11:00:00Z', '2035-05-01T12:00:00Z', 'google-id', null, ADMIN.id);
  const ics = buildCalendarFeed(db, local.id, new Date('2035-05-02T00:00:00Z'), 'Europe/Brussels');
  assert.match(ics, /SUMMARY:Local event/);
  assert.doesNotMatch(ics, /SUMMARY:Google event/);
});

test('deleting a non-default calendar reassigns events to the default calendar', async () => {
  const temp = await createCalendar('Temporary', '#8844AA');
  const event = await createEvent('Move me', temp.id);
  const del = await call('DELETE', `/calendars/${temp.id}`);
  assert.equal(del.status, 204);

  const defaultCalendar = (await call('GET', '/calendars')).body.data.find((calendar) => calendar.is_default);
  const row = db.prepare('SELECT local_calendar_id FROM calendar_events WHERE id = ?').get(event.id);
  assert.equal(row.local_calendar_id, null);
  assert.equal(resolveLocalCalendarId(db, event.id), defaultCalendar.id);
  assert.equal((await call('GET', `/${event.id}`)).body.data.local_calendar_id, defaultCalendar.id);
});

const MEMBER = { id: Number(db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('member','Member','x','member')").run().lastInsertRowid), role: 'member' };

test('member write access manages calendars; feeds and linked deletion require admin', async () => {
  actor = MEMBER;
  try {
    const calendar = await createCalendar('Member calendar', '#112233');
    assert.equal((await call('PUT', `/calendars/${calendar.id}`, { body: { name: 'Renamed', sort_order: 5 } })).status, 200);
    assert.equal((await call('POST', `/calendars/${calendar.id}/feed/regenerate`)).status, 403);
    assert.equal((await call('DELETE', `/calendars/${calendar.id}/feed`)).status, 403);
    actor = { ...MEMBER, access: 'read' };
    assert.equal((await call('POST', '/calendars', { body: { name: 'Denied' } })).status, 403);
    assert.equal((await call('PUT', `/calendars/${calendar.id}`, { body: { name: 'Denied', sort_order: 9 } })).status, 403);
    assert.equal((await call('DELETE', `/calendars/${calendar.id}`)).status, 403);
    actor = ADMIN;
    assert.equal((await call('POST', `/calendars/${calendar.id}/feed/regenerate`)).status, 200);
    actor = MEMBER;
    assert.equal((await call('DELETE', `/calendars/${calendar.id}`)).status, 403);
    const listed = (await call('GET', '/calendars')).body.data.find(row => row.id === calendar.id);
    assert.equal(listed.feed_token, null);
    actor = ADMIN;
    assert.equal((await call('DELETE', `/calendars/${calendar.id}/feed`)).status, 200);
    actor = MEMBER;
    assert.equal((await call('DELETE', `/calendars/${calendar.id}`)).status, 204);
  } finally { actor = ADMIN; }
});

test('calendar counts respect the viewer; household feeds have no private audience', async () => {
  const calendar = await createCalendar('Visibility', '#112233');
  for (const visibility of ['all', 'private', 'assignees']) {
    const event = await createEvent(`Visibility ${visibility}`, calendar.id);
    db.prepare('UPDATE calendar_events SET visibility = ? WHERE id = ?').run(visibility, event.id);
    if (visibility === 'assignees') db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(event.id, MEMBER.id);
  }
  actor = MEMBER;
  try {
    assert.equal((await call('GET', '/calendars')).body.data.find(row => row.id === calendar.id).event_count, 2);
  } finally { actor = ADMIN; }
  assert.equal((await call('GET', '/calendars')).body.data.find(row => row.id === calendar.id).event_count, 3);
  const feed = buildCalendarFeed(db, calendar.id, new Date('2035-05-02T00:00:00Z'));
  assert.match(feed, /SUMMARY:Visibility all/);
  assert.doesNotMatch(feed, /SUMMARY:Visibility (private|assignees)/);
});

test('default repair never assigns rows and generated events have no local calendar', async () => {
  const authored = await createEvent('Authored default');
  const birthday = await createEvent('Generated birthday');
  const nameDay = await createEvent('Generated name day');
  const visit = await createEvent('Generated visit');
  db.prepare('INSERT INTO birthdays (name, birth_date, calendar_event_id, name_day_calendar_event_id, created_by) VALUES (?, ?, ?, ?, ?)')
    .run('Person', '2000-05-01', birthday.id, nameDay.id, ADMIN.id);
  db.prepare('INSERT INTO housekeeping_work_sessions (check_in, created_by, calendar_event_id) VALUES (?, ?, ?)')
    .run('2035-05-01T09:00', ADMIN.id, visit.id);
  const external = db.prepare("INSERT INTO calendar_events (title,start_datetime,external_source,created_by) VALUES ('External default','2035-05-01T09:00','google',?)").run(ADMIN.id).lastInsertRowid;
  db.prepare('DELETE FROM local_calendars WHERE is_default = 1').run();
  const before = db.prepare('SELECT * FROM calendar_events ORDER BY id').all();
  const fallback = ensureDefaultCalendar(db);
  assert.equal(fallback.created_by, null);
  assert.deepEqual(db.prepare('SELECT * FROM calendar_events ORDER BY id').all(), before);
  assert.equal(resolveLocalCalendarId(db, authored.id), fallback.id);
  assert.equal(db.prepare('SELECT local_calendar_id FROM calendar_events WHERE id = ?').get(authored.id).local_calendar_id, null);
  for (const id of [birthday.id, nameDay.id, visit.id, external]) {
    assert.equal(resolveLocalCalendarId(db, id), null);
    assert.equal((await call('PUT', `/${id}`, { body: { local_calendar_id: fallback.id } })).status, 400);
  }
  const feed = buildCalendarFeed(db, fallback.id, new Date('2035-05-02T00:00:00Z'));
  assert.match(feed, /SUMMARY:Authored default/);
  assert.doesNotMatch(feed, /SUMMARY:(Generated|External default)/);
  assert.equal((await call('PUT', `/calendars/${fallback.id}`, { body: { name: 'Our calendar' } })).status, 200);
  assert.equal((await call('GET', `/${authored.id}`)).body.data.local_calendar_name, 'Our calendar');
  assert.match(buildCalendarFeed(db, fallback.id), /X-WR-CALNAME:Our calendar/);
});

test('migration 230 leaves every existing event untouched', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { MIGRATIONS } = dbmod;
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE calendar_events (id INTEGER PRIMARY KEY, title TEXT, external_source TEXT,
        target_google_calendar_id TEXT, target_caldav_account_id INTEGER, updated_at TEXT);
      INSERT INTO calendar_events VALUES (1, 'Authored', 'local', NULL, NULL, 'original'),
        (2, 'External', 'google', NULL, NULL, 'original');`);
    const before = database.prepare('SELECT * FROM calendar_events ORDER BY id').all();
    database.exec(MIGRATIONS.find(row => row.version === 230).up);
    const after = database.prepare('SELECT id,title,external_source,target_google_calendar_id,target_caldav_account_id,updated_at FROM calendar_events ORDER BY id').all();
    assert.deepEqual(after, before);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM calendar_events WHERE local_calendar_id IS NOT NULL').get().n, 0);
    assert.equal(database.prepare('SELECT created_by FROM local_calendars WHERE is_default = 1').get().created_by, null);
  } finally { database.close(); }
});

test('calendar membership moves at series level and following creates a separate calendar series', async () => {
  const a = await createCalendar('Series A', '#112233');
  const b = await createCalendar('Series B', '#445566');
  const c = await createCalendar('Series C', '#778899');
  const created = await call('POST', '/', { body: { title: 'Series membership', start_datetime: '2035-05-01T09:00', end_datetime: '2035-05-01T10:00', recurrence_rule: 'FREQ=DAILY;COUNT=10', local_calendar_id: a.id } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id;
  const occurrence = await call('PUT', `/${id}/occurrences/2035-05-04`, { body: { title: 'Linked replacement' } });
  assert.equal(occurrence.status, 200, JSON.stringify(occurrence.body));
  assert.equal((await call('PUT', `/${id}/occurrences/2035-05-04`, { body: { local_calendar_id: b.id } })).status, 400);
  const moved = await call('PUT', `/${id}`, { body: { local_calendar_id: b.id } });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  let child = db.prepare('SELECT * FROM calendar_events WHERE recurrence_parent_id = ?').get(id);
  assert.equal(child.local_calendar_id, b.id);
  assert.equal((await call('GET', `/${child.id}`)).body.data.local_calendar_id, b.id);
  assert.equal(db.prepare('SELECT outbound_dirty FROM calendar_events WHERE id = ?').get(id).outbound_dirty, 0);
  const following = await call('PUT', `/${id}/occurrences/2035-05-03/following`, { body: { local_calendar_id: c.id } });
  assert.equal(following.status, 201, JSON.stringify(following.body));
  child = db.prepare('SELECT * FROM calendar_events WHERE title = ? AND recurrence_parent_id IS NOT NULL').get('Linked replacement');
  assert.equal(child.local_calendar_id, c.id);
  assert.notEqual(child.recurrence_parent_id, id);
  assert.equal(db.prepare('SELECT local_calendar_id FROM calendar_events WHERE id = ?').get(child.recurrence_parent_id).local_calendar_id, c.id);
  assert.equal(resolveLocalCalendarId(db, id), b.id);
});

test('sync targets exclude local calendars before and after outbound sync; Outlook remains a mirror', async () => {
  const local = await createCalendar('Sync separation', '#112233');
  const body = { title: 'Target event', start_datetime: '2035-05-01T09:00', target_google_calendar_id: 'target@example.test' };
  assert.equal((await call('POST', '/', { body: { ...body, local_calendar_id: local.id } })).status, 400);
  const created = await call('POST', '/', { body });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.local_calendar_id, null);
  const id = created.body.data.id;
  assert.equal(resolveLocalCalendarId(db, id), null);
  const localEvent = await createEvent('Moving to sync', local.id);
  assert.equal((await call('PUT', `/${localEvent.id}`, { body: { target_google_calendar_id: 'target@example.test', local_calendar_id: local.id } })).status, 400);
  const moved = await call('PUT', `/${localEvent.id}`, { body: { target_google_calendar_id: 'target@example.test' } });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(db.prepare('SELECT local_calendar_id FROM calendar_events WHERE id = ?').get(localEvent.id).local_calendar_id, null);
  const plain = await createEvent('Trigger protection', local.id);
  assert.throws(() => db.prepare("UPDATE calendar_events SET external_source = 'google' WHERE id = ?").run(plain.id), /mutually exclusive/);
  db.prepare("UPDATE calendar_events SET external_source = 'google', local_calendar_id = NULL WHERE id = ?").run(plain.id);
  assert.equal(resolveLocalCalendarId(db, plain.id), null);
  const outlook = await createEvent('Outlook mirror', local.id);
  db.prepare("UPDATE calendar_events SET target_outlook_account_id = 999, target_outlook_calendar_id = 'outlook' WHERE id = ?").run(outlook.id);
  assert.equal(resolveLocalCalendarId(db, outlook.id), local.id);
});


test('linked default-calendar occurrences keep resolved membership in API projections', async () => {
  const created = await call('POST', '/', { body: { title: 'Implicit default series', start_datetime: '2035-05-01T09:00', recurrence_rule: 'FREQ=DAILY;COUNT=5' } });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  const edited = await call('PUT', `/${id}/occurrences/2035-05-02`, { body: { title: 'Implicit default child' } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const child = db.prepare('SELECT id,local_calendar_id FROM calendar_events WHERE recurrence_parent_id = ?').get(id);
  assert.equal(child.local_calendar_id, null);
  const calendar = ensureDefaultCalendar(db);
  assert.equal(edited.body.data.local_calendar_id, calendar.id);
  assert.equal((await call('GET', `/${child.id}`)).body.data.local_calendar_id, calendar.id);
});
