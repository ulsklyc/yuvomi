process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');
const { buildCalendarFeed } = await import('../server/services/ics-export.js');
const { findCalendarByFeedToken } = await import('../server/services/local-calendars.js');

const db = dbmod.get();
const ADMIN = { id: 1, role: 'admin' };

db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run();

let actor = ADMIN;
const app = express();
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
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
  db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, external_source, external_calendar_id, created_by)
    VALUES (?, ?, ?, 'google', ?, ?)
  `).run('Google event', '2035-05-01T11:00:00Z', '2035-05-01T12:00:00Z', 'google-id', ADMIN.id);
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
  assert.equal(row.local_calendar_id, defaultCalendar.id);
});
