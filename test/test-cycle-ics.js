/**
 * Test: Zyklus-ICS-Feed (Phase 5)
 * Zweck: (1) Reine ICS-Erzeugung aus server/services/cycle-ics.js - VEVENTs für
 *        geloggte Perioden (stabile UID über die DB-Id), vorhergesagte
 *        Perioden/Eisprung/fruchtbares Fenster (nur ohne Schwangerschafts-
 *        Modus, nur bei aktivierter Fruchtbarkeitsverfolgung), Personenbindung
 *        des FEED-INHALTS (nicht nur des Tokens, anders als der Inventar-Feed).
 *        (2) Token-Lebenszyklus gegen users.cycle_feed_token (Migration 180).
 *        (3) Der Verwaltungs-Router (/health/cycle/feed) end-to-end.
 * Ausführen: node --experimental-sqlite --test test/test-cycle-ics.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const cycleIcs = await import('../server/services/cycle-ics.js');
const { default: cycleFeedRouter } = await import('../server/routes/health/cycle-feed.js');
const db = dbmod.get();

function setHouseholdLanguage(language) {
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('language', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(language);
}

function insertUser(username, role = 'member') {
  return db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, 'x', ?)
  `).run(username, username, role).lastInsertRowid;
}

function insertPeriod(userId, startDate, endDate) {
  return db.prepare(`
    INSERT INTO cycle_periods (user_id, start_date, end_date) VALUES (?, ?, ?)
  `).run(userId, startDate, endDate).lastInsertRowid;
}

function setSettings(userId, fields = {}) {
  const f = { cycle_length_avg: null, period_length_avg: null, luteal_length: 14, track_fertility: 1, ...fields };
  db.prepare(`
    INSERT INTO cycle_settings (user_id, cycle_length_avg, period_length_avg, luteal_length, track_fertility)
    VALUES (@user_id, @cycle_length_avg, @period_length_avg, @luteal_length, @track_fertility)
    ON CONFLICT(user_id) DO UPDATE SET
      cycle_length_avg = excluded.cycle_length_avg, period_length_avg = excluded.period_length_avg,
      luteal_length = excluded.luteal_length, track_fertility = excluded.track_fertility
  `).run({ user_id: userId, ...f });
}

const alice = insertUser('alice', 'admin');
const bob = insertUser('bob', 'member');

// --------------------------------------------------------
// buildCycleFeed
// --------------------------------------------------------

test('buildCycleFeed: ein VEVENT je geloggter Periode, stabile UID über die DB-Id', () => {
  db.exec('DELETE FROM cycle_periods; DELETE FROM cycle_settings;');
  insertPeriod(alice, '2026-05-01', '2026-05-06');
  insertPeriod(alice, '2026-05-29', '2026-06-03');

  const ics = cycleIcs.buildCycleFeed(db, alice, new Date('2026-05-10T00:00:00Z'));
  assert.match(ics, /UID:cycle-period-\d+@yuvomi/);
  assert.match(ics, /DTSTART;VALUE=DATE:20260501/);
  assert.match(ics, /DTEND;VALUE=DATE:20260507/); // exklusiv (RFC 5545): end_date + 1 Tag
});

test('buildCycleFeed: eine offene (noch nicht beendete) Periode nutzt start_date auch als end', () => {
  db.exec('DELETE FROM cycle_periods; DELETE FROM cycle_settings;');
  insertPeriod(alice, '2026-05-01', null);

  const ics = cycleIcs.buildCycleFeed(db, alice, new Date('2026-05-02T00:00:00Z'));
  assert.match(ics, /DTSTART;VALUE=DATE:20260501/);
  assert.match(ics, /DTEND;VALUE=DATE:20260502/);
});

test('buildCycleFeed: vorhergesagte Perioden nur mit genug Historie, klar als "vorhergesagt" beschriftet', () => {
  db.exec('DELETE FROM cycle_periods; DELETE FROM cycle_settings;');
  insertPeriod(alice, '2026-01-01', '2026-01-06');
  insertPeriod(alice, '2026-01-29', '2026-02-03');
  insertPeriod(alice, '2026-02-26', '2026-03-03');
  setHouseholdLanguage('en');

  const ics = cycleIcs.buildCycleFeed(db, alice, new Date('2026-03-10T00:00:00Z'));
  const predicted = (ics.match(/SUMMARY:Predicted period/g) || []).length;
  assert.equal(predicted, 3); // derselbe 3-Zyklen-Horizont wie buildCycleCalendar()
  assert.match(ics, /UID:cycle-period-predicted-\d+-2026-03-26@yuvomi/);
});

test('buildCycleFeed: fruchtbares Fenster + Eisprung nur bei aktivierter Fruchtbarkeitsverfolgung', () => {
  db.exec('DELETE FROM cycle_periods; DELETE FROM cycle_settings;');
  insertPeriod(alice, '2026-01-01', '2026-01-06');
  insertPeriod(alice, '2026-01-29', '2026-02-03');
  insertPeriod(alice, '2026-02-26', '2026-03-03');
  setHouseholdLanguage('en');

  setSettings(alice, { track_fertility: 1 });
  const withFertility = cycleIcs.buildCycleFeed(db, alice, new Date('2026-03-10T00:00:00Z'));
  assert.equal((withFertility.match(/SUMMARY:Fertile window \(predicted\)/g) || []).length, 3);
  assert.equal((withFertility.match(/SUMMARY:Ovulation \(predicted\)/g) || []).length, 3);

  setSettings(alice, { track_fertility: 0 });
  const withoutFertility = cycleIcs.buildCycleFeed(db, alice, new Date('2026-03-10T00:00:00Z'));
  assert.doesNotMatch(withoutFertility, /Fertile window|Ovulation/);
});

test('buildCycleFeed: im Schwangerschafts-Modus keine Prognose, geloggte Perioden bleiben', () => {
  db.exec('DELETE FROM cycle_periods; DELETE FROM cycle_settings;');
  insertPeriod(alice, '2026-01-01', '2026-01-06');
  insertPeriod(alice, '2026-01-29', '2026-02-03');
  insertPeriod(alice, '2026-02-26', '2026-03-03');
  db.prepare(`
    INSERT INTO cycle_settings (user_id, pregnancy_mode, pregnancy_due_date)
    VALUES (?, 1, '2026-10-01')
    ON CONFLICT(user_id) DO UPDATE SET pregnancy_mode = 1, pregnancy_due_date = '2026-10-01'
  `).run(alice);

  const ics = cycleIcs.buildCycleFeed(db, alice, new Date('2026-03-10T00:00:00Z'));
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 3, 'nur die drei geloggten Perioden, keine Prognose');
  assert.doesNotMatch(ics, /Predicted|Fertile window|Ovulation/);
});

test('buildCycleFeed: Feed-Inhalt ist personengebunden - Bobs Feed zeigt nicht Alices Perioden', () => {
  db.exec('DELETE FROM cycle_periods; DELETE FROM cycle_settings;');
  insertPeriod(alice, '2026-05-01', '2026-05-06');
  insertPeriod(bob, '2026-06-01', '2026-06-06');

  const aliceIcs = cycleIcs.buildCycleFeed(db, alice, new Date('2026-05-10T00:00:00Z'));
  assert.match(aliceIcs, /DTSTART;VALUE=DATE:20260501/);
  assert.doesNotMatch(aliceIcs, /DTSTART;VALUE=DATE:20260601/);

  const bobIcs = cycleIcs.buildCycleFeed(db, bob, new Date('2026-06-10T00:00:00Z'));
  assert.match(bobIcs, /DTSTART;VALUE=DATE:20260601/);
  assert.doesNotMatch(bobIcs, /DTSTART;VALUE=DATE:20260501/);
});

test('buildCycleFeed: valides VCALENDAR-Gerüst auch ganz ohne Perioden', () => {
  db.exec('DELETE FROM cycle_periods; DELETE FROM cycle_settings;');
  const ics = cycleIcs.buildCycleFeed(db, alice, new Date('2026-05-10T00:00:00Z'));
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 0);
});

test('buildCycleFeed: Text folgt der Haushaltssprache statt fest deutsch zu sein', () => {
  db.exec('DELETE FROM cycle_periods; DELETE FROM cycle_settings;');
  insertPeriod(alice, '2026-05-01', '2026-05-06');

  setHouseholdLanguage('de');
  const de = cycleIcs.buildCycleFeed(db, alice, new Date('2026-05-10T00:00:00Z'));
  assert.match(de, /X-WR-CALNAME:Yuvomi Zyklus/);
  assert.match(de, /SUMMARY:Periode/);

  setHouseholdLanguage('en');
  const en = cycleIcs.buildCycleFeed(db, alice, new Date('2026-05-10T00:00:00Z'));
  assert.match(en, /X-WR-CALNAME:Yuvomi Cycle/);
  assert.match(en, /SUMMARY:Period/);
});

// --------------------------------------------------------
// Migration 180: Token-Spalte auf users
// --------------------------------------------------------

test('Migration 180 legt die Token-Spalte samt partiellem UNIQUE-Index an', () => {
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  assert.ok(cols.includes('cycle_feed_token'));

  assert.equal(cycleIcs.getFeedToken(db, alice), null);
  assert.equal(cycleIcs.getFeedToken(db, bob), null);

  const token = cycleIcs.regenerateFeedToken(db, alice);
  assert.throws(
    () => db.prepare('UPDATE users SET cycle_feed_token = ? WHERE id = ?').run(token, bob),
    /UNIQUE/i,
  );
  cycleIcs.clearFeedToken(db, alice);
});

// --------------------------------------------------------
// Token-Lebenszyklus
// --------------------------------------------------------

test('Token-Lebenszyklus: null ohne Token, regenerate erzeugt, clear entfernt, ein Rückzug trifft nur ein Abo', () => {
  assert.equal(cycleIcs.getFeedToken(db, alice), null);

  const token = cycleIcs.regenerateFeedToken(db, alice);
  assert.ok(token && token.length > 20);
  assert.equal(cycleIcs.findUserIdByFeedToken(db, token), alice);
  assert.equal(cycleIcs.findUserIdByFeedToken(db, 'wrong-token'), null);
  assert.equal(cycleIcs.findUserIdByFeedToken(db, null), null);

  const bobToken = cycleIcs.regenerateFeedToken(db, bob);
  cycleIcs.clearFeedToken(db, alice);
  assert.equal(cycleIcs.findUserIdByFeedToken(db, token), null);
  assert.equal(cycleIcs.findUserIdByFeedToken(db, bobToken), bob, 'Bobs Abo muss Alices Rückzug überleben');

  cycleIcs.clearFeedToken(db, bob);
});

// --------------------------------------------------------
// Verwaltungs-Router
// --------------------------------------------------------

let actorId = alice;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authUserId = actorId; next(); });
app.use('/health', cycleFeedRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, path, { as = alice } = {}) {
  actorId = as;
  const res = await fetch(`${baseUrl}${path}`, { method });
  let json = null;
  try { json = await res.json(); } catch { /* leer */ }
  return { status: res.status, body: json };
}

test('GET /health/cycle/feed liefert null ohne aktiven Feed', async () => {
  cycleIcs.clearFeedToken(db, alice);
  const r = await call('GET', '/health/cycle/feed');
  assert.equal(r.status, 200);
  assert.equal(r.body.data, null);
});

test('POST /health/cycle/feed/regenerate aktiviert den Feed, GET liefert ihn danach', async () => {
  const r = await call('POST', '/health/cycle/feed/regenerate');
  assert.equal(r.status, 200);
  assert.ok(r.body.data.token);
  assert.match(r.body.data.url, /\/feed\/cycle\/.+\.ics$/);

  const get = await call('GET', '/health/cycle/feed');
  assert.equal(get.body.data.token, r.body.data.token);
});

test('DELETE /health/cycle/feed deaktiviert den Feed', async () => {
  await call('POST', '/health/cycle/feed/regenerate');
  const del = await call('DELETE', '/health/cycle/feed');
  assert.equal(del.status, 200);
  assert.equal(del.body.data.token, null);

  const get = await call('GET', '/health/cycle/feed');
  assert.equal(get.body.data, null);
});

test('Jeder Angemeldete verwaltet sein eigenes Token, niemand sieht/löscht das des anderen', async () => {
  const bobRes = await call('POST', '/health/cycle/feed/regenerate', { as: bob });
  assert.equal(bobRes.status, 200);

  const aliceRes = await call('POST', '/health/cycle/feed/regenerate', { as: alice });
  assert.notEqual(aliceRes.body.data.token, bobRes.body.data.token);

  await call('DELETE', '/health/cycle/feed', { as: alice });
  const bobStill = await call('GET', '/health/cycle/feed', { as: bob });
  assert.equal(bobStill.body.data.token, bobRes.body.data.token, 'Bobs Abo muss Alices DELETE überleben');

  await call('DELETE', '/health/cycle/feed', { as: bob });
});
