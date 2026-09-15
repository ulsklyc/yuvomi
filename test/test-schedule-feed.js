/**
 * Test: Schichtplan-ICS-Feed (Schedule v3)
 * Zweck: (1) Reine ICS-Erzeugung aus server/services/schedule-ics.js - nur die
 *        EIGENEN aufgeloesten Eintraege des Feed-Besitzers, freie Tage
 *        uebersprungen, Ganztags- vs. Uhrzeit-Events je nach Schichttyp.
 *        (2) Token-Lebenszyklus (get/regenerate/clear) gegen die per-Nutzer-
 *        Spalte users.schedule_feed_token (Migration 183).
 *        (3) Der Verwaltungs-Router (/schedule/feed) end-to-end.
 * Ausführen: node --experimental-sqlite --test test/test-schedule-feed.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const scheduleIcs = await import('../server/services/schedule-ics.js');
const { default: scheduleFeedRouter } = await import('../server/routes/schedule-feed.js');
const db = dbmod.get();

function insertUser(username, role = 'member') {
  return db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, 'x', ?)
  `).run(username, username, role).lastInsertRowid;
}

const alice = insertUser('feed-alice');
const bob = insertUser('feed-bob');

// Ohne diese Zeile faellt householdTimeZone() auf serverTimeZone() zurueck -
// die Zone der Maschine, die den Test gerade ausfuehrt (#1022, Review-Fund
// 2026-09-05). In einem UTC-Container liefert resolveFeedZone() dann `null`
// und stampProp() haengt ein 'Z' an; ausserhalb UTC entsteht stattdessen
// `DTSTART;TZID=<Zone>:...`. Die alten, nicht endverankerten Assertions unten
// passten zufaellig auf beide Formen und pruefte damit nie wirklich die
// Verankerung. Pin wie test-schedule-reminders.js es schon fuer die Erinnerungen tut.
db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', 'UTC')").run();

/** Fuehrt `fn` mit einer anderen Haushaltszone aus, stellt UTC danach wieder her. */
function withHouseholdTimeZone(zone, fn) {
  db.prepare("UPDATE sync_config SET value = ? WHERE key = 'household_timezone'").run(zone);
  try {
    fn();
  } finally {
    db.prepare("UPDATE sync_config SET value = 'UTC' WHERE key = 'household_timezone'").run();
  }
}

function insertType(fields = {}) {
  const f = { name: 'Frueh', short_code: 'F', start_time: '06:00', end_time: '14:00', color: '#6C3AED', ...fields };
  return db.prepare(`
    INSERT INTO schedule_shift_types (name, short_code, start_time, end_time, color)
    VALUES (@name, @short_code, @start_time, @end_time, @color)
  `).run(f).lastInsertRowid;
}

function insertOverride(userId, dateKey, shiftTypeId, note = null) {
  db.prepare('INSERT INTO schedule_overrides (user_id, date_key, shift_type_id, note) VALUES (?, ?, ?, ?)')
    .run(userId, dateKey, shiftTypeId, note);
}

function insertExtra(userId, dateKey, shiftTypeId, note = null) {
  return db.prepare('INSERT INTO schedule_extra_shifts (user_id, date_key, shift_type_id, note) VALUES (?, ?, ?, ?)')
    .run(userId, dateKey, shiftTypeId, note).lastInsertRowid;
}

// cycle_length 1, anchored on `date` and valid only that one day - the feed
// spans a wide window (FEED_PAST_DAYS..FEED_FUTURE_DAYS), and an
// unconstrained cycle-1 pattern would otherwise recur identically across all
// of it, producing far more VEVENTs than a test that only cares about one day
// wants to reason about.
function insertPattern(userId, date) {
  return db.prepare('INSERT INTO schedule_patterns (user_id, name, anchor_date, cycle_length, valid_from, valid_until) VALUES (?, ?, ?, 1, ?, ?)')
    .run(userId, 'Timetable', date, date, date).lastInsertRowid;
}

function insertPatternDay(patternId, shiftTypeId) {
  return db.prepare('INSERT INTO schedule_pattern_days (pattern_id, position, shift_type_id) VALUES (?, 0, ?)')
    .run(patternId, shiftTypeId).lastInsertRowid;
}

// --------------------------------------------------------
// buildScheduleFeed
// --------------------------------------------------------

test('buildScheduleFeed enthält nur die eigenen Einträge des Feed-Besitzers', () => {
  const early = insertType({ name: 'Alice-Fruehschicht' });
  const today = dbmod.get().prepare("SELECT date('now') AS d").get().d;
  insertOverride(alice, today, early);
  insertOverride(bob, today, early);

  const ics = scheduleIcs.buildScheduleFeed(db, alice);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.match(ics, new RegExp(`UID:schedule-entry-${alice}-${today}@yuvomi`));

  db.exec('DELETE FROM schedule_overrides');
});

// Ohne die eigene Id in der UID trueg ein Extra dieselbe UID wie der primaere
// Eintrag desselben Tages - ein Kalender-Client dedupliziert per RFC 5545
// danach, eine der beiden Schichten verschwaende beim Abonnenten spurlos.
test('ein Extra am selben Tag wie der primaere Eintrag bekommt eine eigene UID, beide VEVENTs bleiben erhalten', () => {
  const early = insertType({ name: 'Fruehschicht' });
  const onCall = insertType({ name: 'Bereitschaft', short_code: 'B' });
  const today = db.prepare("SELECT date('now') AS d").get().d;
  insertOverride(alice, today, early);
  const extraId = insertExtra(alice, today, onCall, 'On-call');

  const ics = scheduleIcs.buildScheduleFeed(db, alice);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2, 'both the primary shift and the extra produce their own VEVENT');
  assert.match(ics, new RegExp(`UID:schedule-entry-${alice}-${today}@yuvomi`), 'the primary entry keeps its plain UID');
  assert.match(ics, new RegExp(`UID:schedule-entry-${alice}-${today}-extra-${extraId}@yuvomi`), 'the extra carries its own id so the UID never collides with the primary entry');

  db.exec('DELETE FROM schedule_overrides');
  db.exec('DELETE FROM schedule_extra_shifts');
});

// Same reasoning as the extra above, for a timetable's own case: two classes
// on the same day are two entries with source:'pattern', and without the
// pattern_day_id disambiguator both would collide on one UID.
test('zwei Klassen am selben Tag (ein Musterzyklus-Tag) bekommen je eine eigene UID', () => {
  const math = insertType({ name: 'Mathe', short_code: 'M' });
  const bio = insertType({ name: 'Bio', short_code: 'B' });
  const today = db.prepare("SELECT date('now') AS d").get().d;
  const pattern = insertPattern(alice, today);
  const mathDayId = insertPatternDay(pattern, math);
  const bioDayId = insertPatternDay(pattern, bio);

  const ics = scheduleIcs.buildScheduleFeed(db, alice);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2, 'both classes produce their own VEVENT');
  assert.match(ics, new RegExp(`UID:schedule-entry-${alice}-${today}-pattern-${mathDayId}@yuvomi`));
  assert.match(ics, new RegExp(`UID:schedule-entry-${alice}-${today}-pattern-${bioDayId}@yuvomi`));

  db.exec('DELETE FROM schedule_patterns');
});

test('buildScheduleFeed überspringt freie Tage (NULL-Override)', () => {
  const type = insertType({ name: 'Spaet' });
  const today = db.prepare("SELECT date('now') AS d").get().d;
  const tomorrow = db.prepare("SELECT date('now', '+1 day') AS d").get().d;
  insertOverride(alice, today, type);
  insertOverride(alice, tomorrow, null); // freier Tag

  const ics = scheduleIcs.buildScheduleFeed(db, alice);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1, 'der freie Tag darf kein VEVENT erzeugen');

  db.exec('DELETE FROM schedule_overrides');
});

test('ein Schichttyp ohne Uhrzeiten (Urlaub/Krank) wird als Ganztags-Event exportiert', () => {
  const vacation = insertType({ name: 'Urlaub', short_code: 'U', start_time: null, end_time: null });
  const today = db.prepare("SELECT date('now') AS d").get().d;
  const tomorrow = db.prepare("SELECT date('now', '+1 day') AS d").get().d.replace(/-/g, '');
  insertOverride(alice, today, vacation);

  const ics = scheduleIcs.buildScheduleFeed(db, alice);
  assert.match(ics, /DTSTART;VALUE=DATE:\d{8}/);
  assert.match(ics, new RegExp(`DTEND;VALUE=DATE:${tomorrow}`));

  db.exec('DELETE FROM schedule_overrides');
});

test('eine Schicht mit Uhrzeiten trägt DTSTART/DTEND als Zeitstempel, nicht als Ganztags-Wert', () => {
  const type = insertType({ name: 'Spaet2', start_time: '14:00', end_time: '22:00' });
  const today = db.prepare("SELECT date('now') AS d").get().d;
  insertOverride(alice, today, type);

  const ics = scheduleIcs.buildScheduleFeed(db, alice);
  // Endverankert (kein `/DTSTART:\d{8}T140000/` ohne `$`): die Haushaltszone ist
  // hier UTC, resolveFeedZone() liefert also null und stampProp() haengt ein
  // 'Z' an - eine unverankerte Regex saehe das faelschlich als Treffer fuer die
  // TZID-Form einer anderen Zone (#1022, Review-Fund 2026-09-05).
  assert.match(ics, /DTSTART:\d{8}T140000Z$/m);
  assert.match(ics, /DTEND:\d{8}T220000Z$/m);
  assert.doesNotMatch(ics, /DTSTART;VALUE=DATE/);
  assert.doesNotMatch(ics, /TZID=/);

  db.exec('DELETE FROM schedule_overrides');
});

test('eine Schicht mit Uhrzeiten verankert an einer Nicht-UTC-Haushaltszone statt an "Z"', () => {
  const type = insertType({ name: 'Spaet2b', start_time: '14:00', end_time: '22:00' });
  const today = db.prepare("SELECT date('now') AS d").get().d;
  insertOverride(alice, today, type);

  withHouseholdTimeZone('Europe/Berlin', () => {
    const ics = scheduleIcs.buildScheduleFeed(db, alice);
    assert.match(ics, /DTSTART;TZID=Europe\/Berlin:\d{8}T140000$/m);
    assert.match(ics, /DTEND;TZID=Europe\/Berlin:\d{8}T220000$/m);
    assert.doesNotMatch(ics, /DTSTART:\d{8}T140000Z/);
  });

  db.exec('DELETE FROM schedule_overrides');
});

test('eine Nachtschicht über Mitternacht endet auf dem Folgetag', () => {
  const night = insertType({ name: 'Nacht', start_time: '22:00', end_time: '06:00' });
  const today = db.prepare("SELECT date('now') AS d").get().d;
  const tomorrow = db.prepare("SELECT date('now', '+1 day') AS d").get().d.replace(/-/g, '');
  insertOverride(alice, today, night);

  const ics = scheduleIcs.buildScheduleFeed(db, alice);
  // Endverankert, gleicher Grund wie oben: UTC-Haushalt, also 'Z' statt TZID.
  assert.match(ics, new RegExp(`DTEND:${tomorrow}T060000Z$`, 'm'));

  db.exec('DELETE FROM schedule_overrides');
});

test('buildScheduleFeed escaped Sonderzeichen in der Notiz', () => {
  const type = insertType({ name: 'Spaet3' });
  const today = db.prepare("SELECT date('now') AS d").get().d;
  insertOverride(alice, today, type, 'Vertretung; fuer Bob, dringend');

  const ics = scheduleIcs.buildScheduleFeed(db, alice);
  assert.match(ics, /DESCRIPTION:Vertretung\\; fuer Bob\\, dringend/);

  db.exec('DELETE FROM schedule_overrides');
});

// Migration 189: DESCRIPTION faltet die Notiz UND jedes ueberlagerungssichtbare
// eigene Feld mit einem Wert zusammen - ein Feld ohne diesen Haken bleibt
// draussen, auch wenn es einen Wert traegt.
test('buildScheduleFeed nimmt ueberlagerungssichtbare Feldwerte in DESCRIPTION auf, andere nicht', () => {
  const type = insertType({ name: 'Feld-Schicht' });
  const room = db.prepare("INSERT INTO schedule_custom_fields (name) VALUES ('Room')").run().lastInsertRowid;
  const instructor = db.prepare("INSERT INTO schedule_custom_fields (name) VALUES ('Instructor')").run().lastInsertRowid;
  db.prepare('INSERT INTO schedule_shift_type_fields (shift_type_id, custom_field_id, position, show_in_overlay) VALUES (?, ?, 0, 1)').run(type, room);
  db.prepare('INSERT INTO schedule_shift_type_fields (shift_type_id, custom_field_id, position, show_in_overlay) VALUES (?, ?, 1, 0)').run(type, instructor);

  const today = db.prepare("SELECT date('now') AS d").get().d;
  insertOverride(alice, today, type);
  const overrideId = db.prepare('SELECT id FROM schedule_overrides WHERE user_id=? AND date_key=?').get(alice, today).id;
  db.prepare("INSERT INTO schedule_custom_field_values (entry_type, entry_id, custom_field_id, value) VALUES ('override', ?, ?, 'Room 204')").run(overrideId, room);
  db.prepare("INSERT INTO schedule_custom_field_values (entry_type, entry_id, custom_field_id, value) VALUES ('override', ?, ?, 'Ms. Rivera')").run(overrideId, instructor);

  const ics = scheduleIcs.buildScheduleFeed(db, alice);
  assert.match(ics, /DESCRIPTION:Room: Room 204/);
  assert.doesNotMatch(ics, /Ms\. Rivera/, 'Instructor is attached but not flagged show_in_overlay, so it stays out of the feed');

  db.exec('DELETE FROM schedule_overrides; DELETE FROM schedule_custom_field_values; DELETE FROM schedule_shift_type_fields; DELETE FROM schedule_custom_fields;');
});

test('buildScheduleFeed liefert ein valides VCALENDAR-Gerüst auch ohne Einträge', () => {
  const ics = scheduleIcs.buildScheduleFeed(db, alice);
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
  assert.match(ics, /X-WR-CALNAME:Yuvomi Schedule/);
});

// --------------------------------------------------------
// Migration 183: Token-Spalte auf users
// --------------------------------------------------------

test('Migration 183 legt die Token-Spalte samt partiellem UNIQUE-Index an', () => {
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  assert.ok(cols.includes('schedule_feed_token'));

  assert.equal(scheduleIcs.getFeedToken(db, alice), null);
  assert.equal(scheduleIcs.getFeedToken(db, bob), null);

  const token = scheduleIcs.regenerateFeedToken(db, alice);
  assert.throws(
    () => db.prepare('UPDATE users SET schedule_feed_token = ? WHERE id = ?').run(token, bob),
    /UNIQUE/i,
  );
  scheduleIcs.clearFeedToken(db, alice);
});

test('Token-Lebenszyklus: null ohne Token, regenerate erzeugt, clear entfernt', () => {
  assert.equal(scheduleIcs.getFeedToken(db, alice), null);

  const token = scheduleIcs.regenerateFeedToken(db, alice);
  assert.ok(token && token.length > 20);
  assert.equal(scheduleIcs.getFeedToken(db, alice), token);
  assert.equal(scheduleIcs.findUserIdByFeedToken(db, token), alice);
  assert.equal(scheduleIcs.findUserIdByFeedToken(db, 'wrong-token'), null);
  assert.equal(scheduleIcs.findUserIdByFeedToken(db, null), null);

  const token2 = scheduleIcs.regenerateFeedToken(db, alice);
  assert.notEqual(token2, token);
  assert.equal(scheduleIcs.findUserIdByFeedToken(db, token), null, 'alter Token muss ungültig werden');

  scheduleIcs.clearFeedToken(db, alice);
  assert.equal(scheduleIcs.getFeedToken(db, alice), null);
});

test('ein Rückzug trifft genau ein Abo, nicht alle', () => {
  const aliceToken = scheduleIcs.regenerateFeedToken(db, alice);
  const bobToken = scheduleIcs.regenerateFeedToken(db, bob);
  assert.notEqual(aliceToken, bobToken);

  scheduleIcs.clearFeedToken(db, alice);
  assert.equal(scheduleIcs.findUserIdByFeedToken(db, aliceToken), null);
  assert.equal(scheduleIcs.findUserIdByFeedToken(db, bobToken), bob, 'Bobs Abo muss weiterlaufen');

  scheduleIcs.clearFeedToken(db, bob);
});

// --------------------------------------------------------
// Verwaltungs-Router
// --------------------------------------------------------

let actorId = alice;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authUserId = actorId; next(); });
app.use('/schedule/feed', scheduleFeedRouter);
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

test('GET /schedule/feed liefert null ohne aktiven Feed', async () => {
  scheduleIcs.clearFeedToken(db, alice);
  const r = await call('GET', '/schedule/feed');
  assert.equal(r.status, 200);
  assert.equal(r.body.data, null);
});

test('POST /schedule/feed/regenerate aktiviert den Feed, GET liefert ihn danach', async () => {
  const r = await call('POST', '/schedule/feed/regenerate');
  assert.equal(r.status, 200);
  assert.ok(r.body.data.token);
  assert.match(r.body.data.url, /\/feed\/schedule\/.+\.ics$/);

  const get = await call('GET', '/schedule/feed');
  assert.equal(get.body.data.token, r.body.data.token);
});

test('DELETE /schedule/feed deaktiviert den Feed', async () => {
  await call('POST', '/schedule/feed/regenerate');
  const del = await call('DELETE', '/schedule/feed');
  assert.equal(del.status, 200);
  assert.equal(del.body.data.token, null);

  const get = await call('GET', '/schedule/feed');
  assert.equal(get.body.data, null);
});

test('Jeder Angemeldete verwaltet sein eigenes Token - auch Nicht-Admins', async () => {
  const bobRes = await call('POST', '/schedule/feed/regenerate', { as: bob });
  assert.equal(bobRes.status, 200);
  assert.ok(bobRes.body.data.token);

  const aliceRes = await call('POST', '/schedule/feed/regenerate', { as: alice });
  assert.notEqual(aliceRes.body.data.token, bobRes.body.data.token);

  await call('DELETE', '/schedule/feed', { as: alice });
  const bobStill = await call('GET', '/schedule/feed', { as: bob });
  assert.equal(bobStill.body.data.token, bobRes.body.data.token, 'Bobs Abo muss Alices DELETE überleben');

  await call('DELETE', '/schedule/feed', { as: bob });
});
