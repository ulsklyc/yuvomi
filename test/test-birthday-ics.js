import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { spawn } from 'node:child_process';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'birthday-feed-test';
const { get } = await import('../server/db.js');
const feed = await import('../server/services/birthday-ics.js');
const { nextOccurrenceAfter } = await import('../server/services/recurrence.js');
const calendarFeed = await import('../server/services/ics-export.js');
const { default: calendarFeedRouter } = await import('../server/routes/calendar/feed.js');
const { MIGRATIONS, migrate } = await import('../server/db.js');
const { default: Database } = await import('better-sqlite3-multiple-ciphers');
const { default: birthdaysRouter } = await import('../server/routes/birthdays.js');
const db = get();
const ids = ['first', 'second'].map(name => Number(db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, 'x', 'member')").run(name, name).lastInsertRowid));
let actor = ids[0];
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor; req.authRole = 'member'; req.session = { userId: actor, role: 'member' };
  next();
});
app.use('/birthdays', birthdaysRouter);
app.use('/calendar', calendarFeedRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); db.close(); });
async function call(method, path, body) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

test('birthday-only ICS includes reminder-free birthdays, all-day recurrence and stable UIDs without other events or birth years', async () => {
  const created = await call('POST', '/birthdays', { name: 'Ada, Test', birth_date: '1984-12-31', reminder_offset: '' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.calendar_event_id, null);
  await call('POST', '/birthdays', { name: 'Leap birthday', birth_date: '2000-02-29', reminder_offset: '' });
  db.prepare("INSERT INTO calendar_events (title,start_datetime,created_by) VALUES ('Not a birthday','2035-01-01T12:00:00',?)").run(actor);
  const ics = feed.buildBirthdayFeed(db, new Date('2035-01-01T00:00:00Z'));
  assert.match(ics, /Ada\\, Test/);
  assert.match(ics, /DTSTART;VALUE=DATE:20001231\r\nDTEND;VALUE=DATE:20010101/);
  assert.match(ics, /DTSTART;VALUE=DATE:20000229/);
  assert.match(ics, /RRULE:FREQ=YEARLY;INTERVAL=1/);
  assert.doesNotMatch(ics, /1984|Not a birthday|TZID|VALARM/);
  assert.match(ics, new RegExp(`UID:birthday-${created.body.data.id}@yuvomi`));
  assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 2);
  db.prepare('UPDATE birthdays SET name = ? WHERE id = ?').run('Renamed\r\nBEGIN:VEVENT', created.body.data.id);
  const renamed = feed.buildBirthdayFeed(db);
  assert.match(renamed, new RegExp(`UID:birthday-${created.body.data.id}@yuvomi`));
  assert.equal((renamed.match(/\r\nBEGIN:VEVENT\r\n/g) ?? []).length, 2, 'text cannot inject an event');
});

test('birthday feed links are independent per user, rotate and revoke without touching the calendar feed', async () => {
  assert.equal((await call('GET', '/birthdays/feed')).body.data, null);
  const enabled = await call('POST', '/birthdays/feed/regenerate');
  assert.equal(enabled.status, 200);
  assert.ok(enabled.body.data.url.endsWith(`/feed/birthdays/${enabled.body.data.token}.ics`));
  assert.equal(feed.findUserIdByFeedToken(db, enabled.body.data.token), actor);
  db.prepare("UPDATE users SET calendar_feed_token = 'calendar-token' WHERE id = ?").run(actor);
  actor = ids[1];
  assert.equal((await call('GET', '/birthdays/feed')).body.data, null);
  const other = await call('POST', '/birthdays/feed/regenerate');
  assert.notEqual(other.body.data.token, enabled.body.data.token);
  actor = ids[0];
  const rotated = await call('POST', '/birthdays/feed/regenerate');
  assert.equal(feed.findUserIdByFeedToken(db, enabled.body.data.token), null);
  assert.equal(feed.findUserIdByFeedToken(db, rotated.body.data.token), actor);
  await call('DELETE', '/birthdays/feed');
  assert.equal(feed.findUserIdByFeedToken(db, rotated.body.data.token), null);
  assert.equal(feed.findUserIdByFeedToken(db, other.body.data.token), ids[1]);
  assert.equal(db.prepare('SELECT calendar_feed_token FROM users WHERE id = ?').get(actor).calendar_feed_token, 'calendar-token');
});

test('production birthday ICS route accepts only its own token and ends access when revoked', { timeout: 20000 }, async () => {
  const script = `
    const { server } = await import('./server/index.js');
    const { get } = await import('./server/db.js');
    const feed = await import('./server/services/birthday-ics.js');
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const db = get();
    const id = Number(db.prepare("INSERT INTO users (username,display_name,password_hash,role) VALUES ('feed','Feed','x','member')").run().lastInsertRowid);
    db.prepare("INSERT INTO birthdays (name,birth_date,created_by,reminder_offset) VALUES ('HTTP birthday','1990-05-12',?,'')").run(id);
    db.prepare("UPDATE users SET calendar_feed_token = 'different-calendar-token' WHERE id = ?").run(id);
    const token = feed.regenerateFeedToken(db,id);
    process.on('message', () => { feed.clearFeedToken(db,id); process.send({ revoked: true }); });
    process.send({ port: server.address().port, token });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, DB_PATH: ':memory:', DB_ENCRYPTION_KEY: '', PORT: '0', BIND_ADDRESS: '127.0.0.1', NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Birthday feed server startup: ' + errors)), 15000);
      child.once('message', data => { clearTimeout(timer); resolve(data); });
      child.once('error', err => { clearTimeout(timer); reject(err); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Feed server exited: ' + code + errors)); });
    });
    const url = `http://127.0.0.1:${ready.port}/feed/birthdays/${ready.token}.ics`;
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/calendar/);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.match(await response.text(), /HTTP birthday/);
    assert.equal((await fetch(url.replace(ready.token, 'different-calendar-token'))).status, 404);
    const revoked = new Promise(resolve => child.once('message', resolve));
    child.send('revoke'); await revoked;
    assert.equal((await fetch(url)).status, 404);
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill(); await exited;
    }
  }
});


test('name days export without reminders, with stable UIDs distinct from birthdays', async () => {
  actor = ids[0];
  const created = await call('POST', '/birthdays', { name: 'Name-only export', birth_date: '1984-07-01', name_day: '12-31', reminder_offset: '' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const ics = feed.buildBirthdayFeed(db);
  const id = created.body.data.id;
  assert.match(ics, new RegExp('UID:name-day-' + id + '@yuvomi'));
  assert.match(ics, new RegExp('UID:birthday-' + id + '@yuvomi'));
  assert.match(ics, /SUMMARY:Name day: Name-only export/);
  assert.match(ics, /DTSTART;VALUE=DATE:20001231\r\nDTEND;VALUE=DATE:20010101/);
  db.prepare('UPDATE birthdays SET name = ? WHERE id = ?').run('Renamed name day', id);
  assert.match(feed.buildBirthdayFeed(db), new RegExp('UID:name-day-' + id + '@yuvomi'));
});

test('calendar birthday inclusion defaults on, is personal, survives token rotation and leaves the separate feed intact', async () => {
  actor = ids[0];
  const created = await call('POST', '/birthdays', { name: 'Calendar inclusion probe', birth_date: '1990-05-12', name_day: '05-13', reminder_offset: '0' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  await call('POST', '/calendar/feed/regenerate');
  assert.equal((await call('GET', '/calendar/feed')).body.data.includeBirthdays, true);
  assert.match(calendarFeed.buildFeed(db, actor), /Calendar inclusion probe/);
  const disabled = await call('PUT', '/calendar/feed', { includeBirthdays: false });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.data.includeBirthdays, false);
  assert.doesNotMatch(calendarFeed.buildFeed(db, actor), /Calendar inclusion probe/);
  assert.match(calendarFeed.buildFeed(db, ids[1]), /Calendar inclusion probe/);
  assert.match(feed.buildBirthdayFeed(db), /Calendar inclusion probe/);
  const before = db.prepare('SELECT * FROM users WHERE id = ?').get(actor);
  assert.equal((await call('PUT', '/calendar/feed', { showAssignees: true, includeBirthdays: 'false' })).status, 400);
  assert.deepEqual(db.prepare('SELECT * FROM users WHERE id = ?').get(actor), before, 'invalid options never partially write');
  await call('POST', '/calendar/feed/regenerate');
  assert.equal((await call('GET', '/calendar/feed')).body.data.includeBirthdays, false);
  assert.equal((await call('PUT', '/calendar/feed', { showAssignees: true })).body.data.includeBirthdays, false);
  await call('PUT', '/calendar/feed', { includeBirthdays: true });
  assert.match(calendarFeed.buildFeed(db, actor), /Calendar inclusion probe/);
  db.prepare("INSERT INTO sync_config (key,value) VALUES ('disabled_modules', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(['birthdays']));
  try {
    assert.doesNotMatch(calendarFeed.buildFeed(db, actor), /Calendar inclusion probe/);
    assert.match(feed.buildBirthdayFeed(db), /Calendar inclusion probe/);
  } finally { db.prepare("DELETE FROM sync_config WHERE key='disabled_modules'").run(); }
});

test('birthday feed migration leaves existing calendar subscriptions enabled and creates independent token storage', () => {
  const database = new Database(':memory:');
  try {
    const migration = MIGRATIONS.find(item => item.description.startsWith('Birthdays: independently'));
    migrate(database, MIGRATIONS.filter(item => item.version < migration.version));
    database.prepare("INSERT INTO users (username,display_name,password_hash,calendar_feed_token) VALUES ('existing','Existing','x','existing-token')").run();
    migrate(database, [migration]);
    assert.deepEqual(database.prepare('SELECT calendar_feed_token, birthday_feed_token, calendar_feed_include_birthdays FROM users').get(),
      { calendar_feed_token: 'existing-token', birthday_feed_token: null, calendar_feed_include_birthdays: 1 });
    assert.throws(() => database.prepare('UPDATE users SET calendar_feed_include_birthdays=2').run(), /CHECK constraint/);
  } finally { database.close(); }
});


test('February 29 birthday and name-day feeds recur on the last day of February every year', async () => {
  actor = ids[0];
  const created = await call('POST', '/birthdays', { name: 'Leap-day pair', birth_date: '1984-02-29', name_day: '02-29', reminder_offset: '' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id;
  const events = feed.buildBirthdayFeed(db).split('BEGIN:VEVENT\r\n');
  for (const kind of ['birthday', 'name-day']) {
    const event = events.find(block => block.startsWith('UID:' + kind + '-' + id + '@yuvomi\r\n'));
    assert.ok(event, kind + ' is exported');
    assert.match(event, /DTSTART;VALUE=DATE:20000229\r\nDTEND;VALUE=DATE:20000301/);
    const rule = event.match(/RRULE:([^\r\n]+)/)[1];
    assert.equal(rule, 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1');
    for (const [year, day] of [[2023, '28'], [2024, '29'], [2100, '28'], [2400, '29']]) {
      assert.equal(nextOccurrenceAfter('2000-02-29', rule, year + '-01-01', { seriesStart: '2000-02-29' }), year + '-02-' + day);
    }
  }
});


test('birthday token lookup rejects mismatches and unequal byte lengths and excludes deactivated owners', () => {
  const first = feed.regenerateFeedToken(db, ids[0]);
  const second = feed.regenerateFeedToken(db, ids[1]);
  assert.equal(feed.findUserIdByFeedToken(db, first), ids[0]);
  assert.equal(feed.findUserIdByFeedToken(db, second), ids[1]);
  const changedFirst = (first[0] === 'A' ? 'B' : 'A') + first.slice(1);
  const changedLast = first.slice(0, -1) + (first.at(-1) === 'A' ? 'B' : 'A');
  for (const candidate of [null, '', first.slice(1), first + 'x', changedFirst, changedLast, 'é'.repeat(first.length)]) {
    assert.equal(feed.findUserIdByFeedToken(db, candidate), null);
  }
  db.prepare("UPDATE users SET deactivated_at = '2035-01-01T00:00:00Z' WHERE id = ?").run(ids[1]);
  try {
    assert.equal(feed.findUserIdByFeedToken(db, second), null);
    assert.equal(feed.findUserIdByFeedToken(db, first), ids[0]);
  } finally { db.prepare('UPDATE users SET deactivated_at = NULL WHERE id = ?').run(ids[1]); }
});

// #2095: ein Geburtstag ohne Jahr. Der Geburtstags-Feed traegt ohnehin kein
// Jahr (Anker 2000) und bleibt, wie er ist; im allgemeinen Kalender-Feed
// beginnt die Serie im Platzhalterjahr statt 1604, und die Beschreibung nennt
// kein Datum mit erfundenem Jahr.
test('a birthday without a year exports on its day, without 1604 or an invented date', async () => {
  actor = ids[0];
  const created = await call('POST', '/birthdays', { name: 'Yearless', birth_date: '1604-03-15', year_unknown: true });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id;

  const birthdayEvent = feed.buildBirthdayFeed(db).split('BEGIN:VEVENT\r\n')
    .find(block => block.startsWith('UID:birthday-' + id + '@yuvomi\r\n'));
  assert.match(birthdayEvent, /DTSTART;VALUE=DATE:20000315/);

  const calendar = calendarFeed.buildFeed(db, actor);
  const block = calendar.split('BEGIN:VEVENT').find(b => b.includes('Yearless'));
  assert.ok(block, 'the generated event is in the calendar feed');
  assert.match(block, /DTSTART;VALUE=DATE:20000315/);
  assert.doesNotMatch(block, /1604|15\.03\.2000|2000-03-15/);
});
