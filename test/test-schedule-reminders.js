/**
 * Test: Schichtplan-Erinnerungen (Schedule v3)
 * Zweck: (1) syncScheduleRemindersForUser() - Anker+Erinnerung anlegen,
 *        abraeumen, unangetastet lassen, retimen. (2) syncAllScheduleReminders()
 *        ueber mehrere Nutzer isoliert. (3) Der Verwaltungs-Router
 *        (/schedule/preferences) end-to-end. (4) Integration mit dem generischen
 *        Erinnerungs-Router: schedule_entry ist eine abgeleitete Herkunft.
 * Ausführen: node --experimental-sqlite --test test/test-schedule-reminders.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const scheduleReminders = await import('../server/services/schedule-reminders.js');
const { default: schedulePreferencesRouter } = await import('../server/routes/schedule-preferences.js');
const { default: remindersRouter } = await import('../server/routes/reminders.js');
const db = dbmod.get();

db.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'UTC')").run();
// Der Schichtplan ist wie das Inventar standardmäßig abgeschaltet
// (disabled_modules seedet ihn schon bei der Installation) - der periodische
// Sync respektiert das bewusst, wie server/services/pantry-reminders.js es
// für den Vorrat tut. Für diesen Test ist das Modul aktiv.
db.prepare("INSERT INTO sync_config (key, value) VALUES ('disabled_modules', '[]') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();

function insertUser(username) {
  return db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, 'x', 'member')
  `).run(username, username).lastInsertRowid;
}

const alice = insertUser('rem-alice');
const bob = insertUser('rem-bob');

function insertType(fields = {}) {
  const f = { name: 'Frueh', short_code: 'F', start_time: '06:00', end_time: '14:00', color: '#6C3AED', ...fields };
  return db.prepare(`
    INSERT INTO schedule_shift_types (name, short_code, start_time, end_time, color)
    VALUES (@name, @short_code, @start_time, @end_time, @color)
  `).run(f).lastInsertRowid;
}

function setOffset(userId, minutes) {
  db.prepare('UPDATE users SET schedule_reminder_offset_minutes = ? WHERE id = ?').run(minutes, userId);
}

function insertOverride(userId, dateKey, shiftTypeId) {
  db.prepare('INSERT INTO schedule_overrides (user_id, date_key, shift_type_id) VALUES (?, ?, ?)')
    .run(userId, dateKey, shiftTypeId);
}

// Ein Extra traegt seinen eigenen Vorlauf (reminder_offset_minutes) - der
// haushaltsweite users.schedule_reminder_offset_minutes gilt fuer ihn NICHT.
function insertExtra(userId, dateKey, shiftTypeId, reminderOffsetMinutes = null) {
  return db.prepare('INSERT INTO schedule_extra_shifts (user_id, date_key, shift_type_id, reminder_offset_minutes) VALUES (?, ?, ?, ?)')
    .run(userId, dateKey, shiftTypeId, reminderOffsetMinutes).lastInsertRowid;
}

function extraReminderFor(extraId) {
  return db.prepare(`SELECT * FROM reminders WHERE entity_type = 'schedule_extra_entry' AND entity_id = ?`).get(extraId);
}

// cycle_length 1, anchored on TODAY: position 0 always resolves to TODAY.
// `validUntil` defaults to TODAY too - the sync window is 8 days
// (today..today+7 inclusive), and an unconstrained cycle_length-1 pattern
// would otherwise recur identically on every one of those days, multiplying
// every anchor/reminder count in a test by 8 for no reason relevant to what's
// being tested here.
function insertPattern(userId, { anchorDate = TODAY, validUntil = TODAY } = {}) {
  return db.prepare('INSERT INTO schedule_patterns (user_id, name, anchor_date, cycle_length, valid_until) VALUES (?, ?, ?, 1, ?)')
    .run(userId, 'Timetable', anchorDate, validUntil).lastInsertRowid;
}

function insertPatternDay(patternId, shiftTypeId, position = 0) {
  return db.prepare('INSERT INTO schedule_pattern_days (pattern_id, position, shift_type_id) VALUES (?, ?, ?)')
    .run(patternId, position, shiftTypeId).lastInsertRowid;
}

function clearAll() {
  db.exec('DELETE FROM schedule_extra_shifts');
  db.exec("DELETE FROM reminders WHERE entity_type = 'schedule_extra_entry'");
  db.exec('DELETE FROM schedule_overrides');
  db.exec('DELETE FROM schedule_patterns');
  db.exec('DELETE FROM schedule_pattern_days');
  db.exec('DELETE FROM schedule_reminder_entries');
  db.exec("DELETE FROM reminders WHERE entity_type = 'schedule_entry'");
  db.exec('UPDATE users SET schedule_reminder_offset_minutes = NULL');
}

function anchorFor(userId, dateKey) {
  return db.prepare('SELECT * FROM schedule_reminder_entries WHERE user_id = ? AND date_key = ?').get(userId, dateKey);
}

// Plural counterpart for a timetable day: a pattern day can now resolve to
// several qualifying entries on the same date, each its own anchor.
function anchorsFor(userId, dateKey) {
  return db.prepare('SELECT * FROM schedule_reminder_entries WHERE user_id = ? AND date_key = ? ORDER BY id').all(userId, dateKey);
}

function reminderFor(anchorId) {
  return db.prepare(`SELECT * FROM reminders WHERE entity_type = 'schedule_entry' AND entity_id = ?`).get(anchorId);
}

const NOW = new Date('2026-09-10T04:00:00Z');
const TODAY = '2026-09-10';

// Für Tests, die über den Verwaltungs-Router laufen: der Router ruft den Sync
// ohne ein injizierbares `now`, also mit der echten Uhrzeit. "Morgen" (real)
// liegt garantiert im rollierenden 7-Tage-Fenster, unabhängig davon, wann der
// Test läuft.
function realTomorrowKey() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const REAL_TOMORROW = realTomorrowKey();

// --------------------------------------------------------
// syncScheduleRemindersForUser
// --------------------------------------------------------

test('legt für eine anstehende Zeit-Schicht Anker und Erinnerung mit korrektem Vorlauf an', () => {
  clearAll();
  const early = insertType();
  setOffset(alice, 30);
  insertOverride(alice, TODAY, early);

  scheduleReminders.syncScheduleRemindersForUser(db, alice, NOW);

  const anchor = anchorFor(alice, TODAY);
  assert.ok(anchor, 'Anker muss existieren');
  assert.equal(anchor.shift_type_id, early);

  const reminder = reminderFor(anchor.id);
  assert.ok(reminder, 'Erinnerung muss existieren');
  assert.equal(reminder.remind_at, '2026-09-10T05:30');
  assert.equal(reminder.created_by, alice);
});

test('überspringt freie Tage und zeitlose Schichttypen (Urlaub/Krank)', () => {
  clearAll();
  const vacation = insertType({ name: 'Urlaub', short_code: 'U', start_time: null, end_time: null });
  setOffset(alice, 30);
  insertOverride(alice, TODAY, vacation);
  insertOverride(alice, '2026-09-11', null); // freier Tag

  scheduleReminders.syncScheduleRemindersForUser(db, alice, NOW);

  assert.equal(anchorFor(alice, TODAY), undefined);
  assert.equal(anchorFor(alice, '2026-09-11'), undefined);
});

test('legt keine Erinnerung an, deren Zielzeitpunkt schon verstrichen ist', () => {
  clearAll();
  const early = insertType();
  setOffset(alice, 30);
  insertOverride(alice, TODAY, early);

  // 05:30 (Ziel) liegt schon hinter 06:30 (jetzt).
  scheduleReminders.syncScheduleRemindersForUser(db, alice, new Date('2026-09-10T06:30:00Z'));

  const anchor = anchorFor(alice, TODAY);
  assert.ok(anchor, 'Anker existiert trotzdem - er ist nur ein stabiler Verweis, keine Zusage');
  assert.equal(reminderFor(anchor.id), undefined, 'keine nachtraegliche Meldung fuer einen verstrichenen Zeitpunkt');
});

test('lässt eine bestehende Erinnerung unangetastet, wenn sich der Zielzeitpunkt nicht ändert', () => {
  clearAll();
  const early = insertType();
  setOffset(alice, 30);
  insertOverride(alice, TODAY, early);

  scheduleReminders.syncScheduleRemindersForUser(db, alice, NOW);
  const anchor = anchorFor(alice, TODAY);
  db.prepare(`UPDATE reminders SET pushed_at = ? WHERE entity_type = 'schedule_entry' AND entity_id = ?`)
    .run('2026-09-10T05:30:00Z', anchor.id);

  scheduleReminders.syncScheduleRemindersForUser(db, alice, NOW);
  const reminder = reminderFor(anchor.id);
  assert.ok(reminder.pushed_at, 'ein zweiter Lauf darf pushed_at nicht zurücksetzen');
});

test('retimt eine bestehende Erinnerung, wenn sich der Vorlauf ändert', () => {
  clearAll();
  const early = insertType();
  setOffset(alice, 30);
  insertOverride(alice, TODAY, early);
  scheduleReminders.syncScheduleRemindersForUser(db, alice, NOW);

  setOffset(alice, 60);
  scheduleReminders.syncScheduleRemindersForUser(db, alice, NOW);

  const anchor = anchorFor(alice, TODAY);
  const reminder = reminderFor(anchor.id);
  assert.equal(reminder.remind_at, '2026-09-10T05:00');
});

test('räumt Anker und Erinnerung ab, sobald der Tag nicht mehr qualifiziert', () => {
  clearAll();
  const early = insertType();
  setOffset(alice, 30);
  insertOverride(alice, TODAY, early);
  scheduleReminders.syncScheduleRemindersForUser(db, alice, NOW);
  const anchorId = anchorFor(alice, TODAY).id;
  assert.ok(reminderFor(anchorId));

  db.exec('DELETE FROM schedule_overrides');
  scheduleReminders.syncScheduleRemindersForUser(db, alice, NOW);

  assert.equal(anchorFor(alice, TODAY), undefined);
  assert.equal(db.prepare(`SELECT * FROM reminders WHERE entity_type = 'schedule_entry' AND entity_id = ?`).get(anchorId), undefined);
});

test('offsetMinutes = null räumt bestehende Anker/Erinnerungen vollständig ab', () => {
  clearAll();
  const early = insertType();
  setOffset(alice, 30);
  insertOverride(alice, TODAY, early);
  scheduleReminders.syncScheduleRemindersForUser(db, alice, NOW);
  assert.ok(anchorFor(alice, TODAY));

  setOffset(alice, null);
  scheduleReminders.syncScheduleRemindersForUser(db, alice, NOW);
  assert.equal(anchorFor(alice, TODAY), undefined);
});

// Audit finding: schedule_reminder_entries.shift_type_id is ON DELETE CASCADE
// (Migration 184), unlike every other live reference to schedule_shift_types
// (overrides, pattern days, extras all use RESTRICT). If a shift type still
// referenced by an anchor is deleted before the next sync pass runs, the
// cascade takes the anchor with it - but the `reminders` row (entity_type
// 'schedule_entry') pointing at that now-gone anchor id does NOT disappear,
// since entity_id carries no real foreign key (polymorphic, same as
// everywhere else in this module). Constructed directly here (a stray
// reminders row with no matching anchor) rather than by timing a real delete
// against a sync pass, since the orphan itself - not how it got there - is
// what sweepStrandedReminders() must clean up.
test('sweepStrandedReminders raeumt eine reminders-Zeile ab, deren Anker (schedule_reminder_entries) verschwunden ist, und laesst echte Erinnerungen unangetastet', () => {
  clearAll();
  const early = insertType();
  setOffset(alice, 30);
  insertOverride(alice, TODAY, early);
  scheduleReminders.syncScheduleRemindersForUser(db, alice, NOW);
  const legitAnchor = anchorFor(alice, TODAY);
  assert.ok(legitAnchor, 'sanity: a legitimate anchor+reminder exist before the stray row is added');
  assert.ok(reminderFor(legitAnchor.id));

  const orphanAnchorId = legitAnchor.id + 1000; // guaranteed to not exist in schedule_reminder_entries
  db.prepare(`INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('schedule_entry', ?, '2099-01-01T00:00', ?)`).run(orphanAnchorId, alice);
  assert.ok(db.prepare(`SELECT 1 FROM reminders WHERE entity_type='schedule_entry' AND entity_id=?`).get(orphanAnchorId), 'sanity: the orphan row exists before the sync runs');

  scheduleReminders.syncScheduleRemindersForUser(db, alice, NOW);

  assert.equal(db.prepare(`SELECT 1 FROM reminders WHERE entity_type='schedule_entry' AND entity_id=?`).get(orphanAnchorId), undefined,
    'the orphaned reminders row (no matching schedule_reminder_entries anchor) must be swept');
  const survivingAnchor = anchorFor(alice, TODAY);
  assert.ok(survivingAnchor, 'the legitimate anchor must survive the sweep');
  assert.ok(reminderFor(survivingAnchor.id), 'the legitimate reminder must survive the sweep');
});

// Same sweep, for the extra-entry side: schedule_extra_shifts rows use
// RESTRICT (not CASCADE) on their shift type, so they cannot orphan the same
// way - but the shift row itself can vanish (a real DELETE /extras/:id) while
// a sync pass that would have noticed is skipped (e.g. an exception earlier
// in syncAllScheduleReminders()'s per-user loop). Same guard, same reason.
// --------------------------------------------------------
// Extra-Schichten (entity_type 'schedule_extra_entry'): eigener Vorlauf je
// Extra, unabhaengig vom Nutzer-Offset - bis hier hatte dieser Pfad keinerlei
// Abdeckung (Audit-Befund).
// --------------------------------------------------------

test('ein Extra mit eigenem Vorlauf bekommt seine Erinnerung auch ohne aktivierten Nutzer-Offset', () => {
  clearAll();
  const early = insertType(); // 06:00-14:00
  const extraId = insertExtra(alice, TODAY, early, 90);
  // users.schedule_reminder_offset_minutes bleibt NULL: der primaere Pfad ist aus.

  scheduleReminders.syncScheduleRemindersForUser(db, alice, NOW);

  const reminder = extraReminderFor(extraId);
  assert.ok(reminder, 'Extra-Erinnerung muss existieren');
  // 06:00 UTC minus 90 Minuten Vorlauf, von Hand: 04:30.
  assert.equal(reminder.remind_at, '2026-09-10T04:30');
  assert.equal(reminder.created_by, alice);
  assert.equal(anchorFor(alice, TODAY), undefined, 'kein primaerer Anker - der Nutzer-Offset ist aus');
});

test('der Nutzer-Offset aendert den Vorlauf eines Extras NICHT (beide Pfade unabhaengig)', () => {
  clearAll();
  const early = insertType();
  const extraId = insertExtra(alice, TODAY, early, 90);
  setOffset(alice, 15);
  insertOverride(alice, TODAY, early);

  scheduleReminders.syncScheduleRemindersForUser(db, alice, NOW);

  // Primaer: 06:00 - 15 = 05:45. Extra: 06:00 - 90 = 04:30. Von Hand.
  assert.equal(reminderFor(anchorFor(alice, TODAY).id).remind_at, '2026-09-10T05:45');
  assert.equal(extraReminderFor(extraId).remind_at, '2026-09-10T04:30');
});

test('ein geaenderter Extra-Vorlauf retimt die Erinnerung, ein entferntes Extra raeumt sie ab', () => {
  clearAll();
  const early = insertType();
  const extraId = insertExtra(alice, TODAY, early, 90);
  scheduleReminders.syncScheduleRemindersForUser(db, alice, NOW);
  assert.equal(extraReminderFor(extraId).remind_at, '2026-09-10T04:30');

  db.prepare('UPDATE schedule_extra_shifts SET reminder_offset_minutes = 30 WHERE id = ?').run(extraId);
  scheduleReminders.syncScheduleRemindersForUser(db, alice, NOW);
  assert.equal(extraReminderFor(extraId).remind_at, '2026-09-10T05:30', 'von Hand: 06:00 - 30');

  db.prepare('DELETE FROM schedule_extra_shifts WHERE id = ?').run(extraId);
  scheduleReminders.syncScheduleRemindersForUser(db, alice, NOW);
  assert.equal(extraReminderFor(extraId), undefined, 'ohne Extra keine Erinnerung');
});

test('ein Extra ohne eigenen Vorlauf bekommt KEINE Erinnerung, auch wenn der Nutzer-Offset gesetzt ist', () => {
  clearAll();
  const early = insertType();
  const extraId = insertExtra(alice, TODAY, early, null);
  setOffset(alice, 30);

  scheduleReminders.syncScheduleRemindersForUser(db, alice, NOW);

  assert.equal(extraReminderFor(extraId), undefined,
    'reminder_offset_minutes NULL heisst opt-out fuer genau dieses Extra - der Nutzer-Offset gilt nur fuer den primaeren Pfad');
});

test('sweepStrandedReminders raeumt eine reminders-Zeile fuer ein verschwundenes Extra (schedule_extra_entry) ab', () => {
  clearAll();
  const orphanExtraId = 999999; // guaranteed to not exist in schedule_extra_shifts
  db.prepare(`INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('schedule_extra_entry', ?, '2099-01-01T00:00', ?)`).run(orphanExtraId, alice);

  scheduleReminders.syncScheduleRemindersForUser(db, alice, NOW);

  assert.equal(db.prepare(`SELECT 1 FROM reminders WHERE entity_type='schedule_extra_entry' AND entity_id=?`).get(orphanExtraId), undefined,
    'the orphaned extra reminder (no matching schedule_extra_shifts row) must be swept');
});

// A timetable's whole point: two classes, same day, different times - each
// needs its own anchor (schedule_reminder_entries used to be one row per
// (user, date), full stop) and its own reminder.
test('zwei Klassen am selben Tag bekommen zwei unabhaengige Anker und Erinnerungen', () => {
  clearAll();
  const math = insertType({ name: 'Mathe', short_code: 'M', start_time: '08:00', end_time: '09:00' });
  const bio = insertType({ name: 'Bio', short_code: 'B', start_time: '09:15', end_time: '10:00' });
  const pattern = insertPattern(alice);
  insertPatternDay(pattern, math);
  insertPatternDay(pattern, bio);
  setOffset(alice, 10);

  scheduleReminders.syncScheduleRemindersForUser(db, alice, NOW);

  const anchors = anchorsFor(alice, TODAY);
  assert.equal(anchors.length, 2, 'jede Klasse bekommt ihren eigenen Anker');
  assert.deepEqual(anchors.map((a) => a.shift_type_id).sort(), [bio, math].sort());
  assert.notEqual(anchors[0].pattern_day_id, anchors[1].pattern_day_id);

  const reminders = anchors.map((a) => reminderFor(a.id));
  assert.ok(reminders.every(Boolean), 'jeder Anker bekommt seine eigene Erinnerung');
  const mathReminder = reminderFor(anchors.find((a) => a.shift_type_id === Number(math)).id);
  const bioReminder = reminderFor(anchors.find((a) => a.shift_type_id === Number(bio)).id);
  assert.equal(mathReminder.remind_at, '2026-09-10T07:50');
  assert.equal(bioReminder.remind_at, '2026-09-10T09:05');
});

// PUT /patterns/:id/days (server/routes/schedule.js) loescht und legt bei
// JEDEM Speichern ALLE Tage des Musters neu an, auch unveraenderte - simuliert
// hier direkt an der Tabelle, ohne den Router zu bemuehen. Der Sync darf sich
// davon nicht aus dem Tritt bringen lassen: nach dem naechsten Lauf muss
// wieder GENAU ein Anker+Erinnerung je aktueller Klasse stehen, keine Leichen
// unter den alten Ids und keine Duplikate.
test('ein Speichern im Tageseditor vergibt frische pattern_day_ids - der naechste Sync-Lauf heilt das selbst', () => {
  clearAll();
  const math = insertType({ name: 'Mathe', short_code: 'M', start_time: '08:00', end_time: '09:00' });
  const bio = insertType({ name: 'Bio', short_code: 'B', start_time: '09:15', end_time: '10:00' });
  const history = insertType({ name: 'Geschichte', short_code: 'G', start_time: '10:15', end_time: '11:00' });
  const pattern = insertPattern(alice);
  insertPatternDay(pattern, math);
  insertPatternDay(pattern, bio);
  setOffset(alice, 10);
  scheduleReminders.syncScheduleRemindersForUser(db, alice, NOW);
  assert.equal(anchorsFor(alice, TODAY).length, 2);

  // "Speichern": alle Zeilen des Musters weg, alle neu - Bio bleibt inhaltlich
  // gleich, aber unter neuer Id; Mathe wird durch Geschichte ersetzt.
  db.prepare('DELETE FROM schedule_pattern_days WHERE pattern_id = ?').run(pattern);
  insertPatternDay(pattern, bio);
  insertPatternDay(pattern, history);

  scheduleReminders.syncScheduleRemindersForUser(db, alice, NOW);

  const anchors = anchorsFor(alice, TODAY);
  assert.equal(anchors.length, 2, 'weiterhin genau ein Anker je aktueller Klasse, keine Leichen unter den alten Ids');
  assert.deepEqual(anchors.map((a) => a.shift_type_id).sort(), [bio, history].sort(), 'Mathe ist weg, Geschichte ist da, Bio blieb inhaltlich gleich');
  assert.ok(anchors.every((a) => reminderFor(a.id)), 'jeder aktuelle Anker traegt seine Erinnerung, auch der unter neuer Id neu angelegte fuer Bio');
  assert.equal(db.prepare(`SELECT count(*) AS n FROM reminders WHERE entity_type = 'schedule_entry'`).get().n, 2, 'keine verwaisten Erinnerungen unter den abgeraeumten alten Ankern');
});

// --------------------------------------------------------
// DST-Korrektheit (localToUTCPrecise, ueber syncScheduleRemindersForUser
// end-to-end - die Funktion selbst ist nicht exportiert): Europe/Berlin,
// beide 2026-Uebergaenge.
// --------------------------------------------------------

/** Fuehrt fn() mit einer anderen Haushaltszone aus, stellt UTC danach wieder her - wie test-schedule-feed.js's withHouseholdTimeZone. */
function withHouseholdTimeZone(zone, fn) {
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(zone);
  try {
    fn();
  } finally {
    db.prepare("UPDATE sync_config SET value = 'UTC' WHERE key = 'household_timezone'").run();
  }
}

// Hand-derived ground truth: Europe/Berlin's 2026 spring-forward transition
// happens at 2026-03-29T01:00:00Z - local clocks jump from 02:00 CET (+01:00)
// to 03:00 CEST (+02:00) at that instant. 06:00 local that day is well past
// the jump, so it is unambiguous CEST: 06:00 CEST = 04:00Z. With a 60-minute
// lead: remind_at = 04:00 - 0:60 = 03:00Z.
test('shiftReminderAt (via syncScheduleRemindersForUser) rechnet ueber den Fruehjahrs-Sprung korrekt: 2026-03-29 06:00 lokal (CEST, +02:00) -> 03:00Z mit 60 Minuten Vorlauf', () => {
  clearAll();
  withHouseholdTimeZone('Europe/Berlin', () => {
    const early = insertType({ start_time: '06:00', end_time: '14:00' });
    setOffset(alice, 60);
    insertOverride(alice, '2026-03-29', early);

    scheduleReminders.syncScheduleRemindersForUser(db, alice, new Date('2026-03-28T22:00:00Z'));

    const anchor = anchorFor(alice, '2026-03-29');
    assert.ok(anchor);
    const reminder = reminderFor(anchor.id);
    assert.ok(reminder);
    assert.equal(reminder.remind_at, '2026-03-29T03:00');
  });
});

// Hand-derived ground truth: Europe/Berlin's 2026 fall-back transition
// happens at 2026-10-25T01:00:00Z - local clocks fall from 03:00 CEST
// (+02:00) back to 02:00 CET (+01:00) at that instant. 06:00 local that day
// is well past the fold, so it is unambiguous CET: 06:00 CET = 05:00Z. With a
// 60-minute lead: remind_at = 05:00 - 0:60 = 04:00Z.
test('shiftReminderAt (via syncScheduleRemindersForUser) rechnet ueber den Herbst-Ruecksprung korrekt: 2026-10-25 06:00 lokal (CET, +01:00) -> 04:00Z mit 60 Minuten Vorlauf', () => {
  clearAll();
  withHouseholdTimeZone('Europe/Berlin', () => {
    const early = insertType({ start_time: '06:00', end_time: '14:00' });
    setOffset(alice, 60);
    insertOverride(alice, '2026-10-25', early);

    scheduleReminders.syncScheduleRemindersForUser(db, alice, new Date('2026-10-24T20:00:00Z'));

    const anchor = anchorFor(alice, '2026-10-25');
    assert.ok(anchor);
    const reminder = reminderFor(anchor.id);
    assert.ok(reminder);
    assert.equal(reminder.remind_at, '2026-10-25T04:00');
  });
});

// The nonexistent-wall-clock-time (spring gap) case: 2026-03-29 02:30 local
// never happened - the clock jumps straight from 02:00 to 03:00 at
// 2026-03-29T01:00:00Z. localToUTCPrecise() (schedule-reminders.js) documents
// its fallback for exactly this: advance past the gap by the gap's own width.
//
// Hand-derivation, following localToUTCPrecise()'s own documented procedure:
//   naiveMs  = 2026-03-29T02:30:00Z (the local digits read literally as UTC)
//   o1       = offset AT naiveMs (02:30 UTC is AFTER the 01:00Z boundary) = CEST = +120min
//   guessA   = naiveMs - 120min = 2026-03-29T00:30:00Z
//   o2       = offset AT guessA (00:30 UTC is BEFORE the boundary) = CET = +60min
//   o2 != o1 (60 vs 120) -> second pass:
//   guessB   = naiveMs - 60min = 2026-03-29T01:30:00Z
//   o3       = offset AT guessB (01:30 UTC is AFTER the boundary) = CEST = +120min
//   o3 != o2 (120 vs 60) -> no fixed point after two passes: this IS the gap.
//   gapMinutes = |o2 - o1| = |60 - 120| = 60
//   result     = guessA + gapMinutes = 00:30Z + 60min = 01:30Z
// With a 30-minute lead: remind_at = 01:30 - 0:30 = 01:00Z.
test('shiftReminderAt (via syncScheduleRemindersForUser) schiebt eine nicht existierende Wanduhrzeit in der Fruehjahrsluecke ueber die Luecke vor (2026-03-29 02:30 lokal)', () => {
  clearAll();
  withHouseholdTimeZone('Europe/Berlin', () => {
    const gapType = insertType({ name: 'Luecke', short_code: 'G', start_time: '02:30', end_time: '10:30' });
    setOffset(alice, 30);
    insertOverride(alice, '2026-03-29', gapType);

    scheduleReminders.syncScheduleRemindersForUser(db, alice, new Date('2026-03-28T22:00:00Z'));

    const anchor = anchorFor(alice, '2026-03-29');
    assert.ok(anchor);
    const reminder = reminderFor(anchor.id);
    assert.ok(reminder);
    assert.equal(reminder.remind_at, '2026-03-29T01:00');
  });
});

// --------------------------------------------------------
// syncAllScheduleReminders
// --------------------------------------------------------

test('syncAllScheduleReminders behandelt mehrere Nutzer isoliert', () => {
  clearAll();
  const early = insertType();
  setOffset(alice, 30);
  setOffset(bob, 15);
  insertOverride(alice, TODAY, early);
  insertOverride(bob, TODAY, early);

  scheduleReminders.syncAllScheduleReminders(db, NOW);

  const aliceReminder = reminderFor(anchorFor(alice, TODAY).id);
  const bobReminder = reminderFor(anchorFor(bob, TODAY).id);
  assert.equal(aliceReminder.remind_at, '2026-09-10T05:30');
  assert.equal(bobReminder.remind_at, '2026-09-10T05:45');
});

test('syncAllScheduleReminders lässt Nutzer ohne aktivierten Vorlauf unberührt', () => {
  clearAll();
  const early = insertType();
  insertOverride(alice, TODAY, early); // kein Vorlauf gesetzt

  scheduleReminders.syncAllScheduleReminders(db, NOW);
  assert.equal(anchorFor(alice, TODAY), undefined);
});

// --------------------------------------------------------
// Verwaltungs-Router
// --------------------------------------------------------

let actorId = alice;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authUserId = actorId; req.sessionModuleAccess = {}; req.authScopes = null; next(); });
app.use('/schedule/preferences', schedulePreferencesRouter);
app.use('/reminders', remindersRouter);
const server = app.listen(0);
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, path, { as = alice, body } = {}) {
  actorId = as;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* leer */ }
  return { status: res.status, body: json };
}

test('GET /schedule/preferences liefert beide Felder als null ohne eigene Einstellung, Ueberstunden-Verfolgung an', async () => {
  clearAll();
  const r = await call('GET', '/schedule/preferences');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.reminderOffsetMinutes, null);
  assert.equal(r.body.data.weeklyHours, null);
  assert.equal(r.body.data.overtimeEnabled, true, 'ungesetzt (NULL) muss als "an" gelesen werden - kein stiller Verhaltenswechsel fuer Bestandshaushalte (S-24)');
});

test('PUT /schedule/preferences setzt den Vorlauf und synchronisiert sofort', async () => {
  clearAll();
  const early = insertType();
  insertOverride(alice, REAL_TOMORROW, early);

  const r = await call('PUT', '/schedule/preferences', { body: { reminderOffsetMinutes: 30 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.reminderOffsetMinutes, 30);

  // Sofort wirksam, ohne auf den periodischen Lauf zu warten.
  const anchor = anchorFor(alice, REAL_TOMORROW);
  assert.ok(anchor, 'PUT muss sofort synchronisieren');
});

test('PUT /schedule/preferences lehnt ungültige Vorlauf-Werte ab', async () => {
  clearAll();
  const bad1 = await call('PUT', '/schedule/preferences', { body: { reminderOffsetMinutes: -5 } });
  assert.equal(bad1.status, 400);
  const bad2 = await call('PUT', '/schedule/preferences', { body: { reminderOffsetMinutes: 99999 } });
  assert.equal(bad2.status, 400);
  const bad3 = await call('PUT', '/schedule/preferences', { body: { reminderOffsetMinutes: 'soon' } });
  assert.equal(bad3.status, 400);
});

test('PUT /schedule/preferences mit reminderOffsetMinutes: null schaltet ab', async () => {
  clearAll();
  const early = insertType();
  insertOverride(alice, REAL_TOMORROW, early);
  await call('PUT', '/schedule/preferences', { body: { reminderOffsetMinutes: 30 } });
  assert.ok(anchorFor(alice, REAL_TOMORROW));

  const r = await call('PUT', '/schedule/preferences', { body: { reminderOffsetMinutes: null } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.reminderOffsetMinutes, null);
  assert.equal(anchorFor(alice, REAL_TOMORROW), undefined);
});

test('PUT /schedule/preferences setzt die Wochenstunden, ohne den Vorlauf anzufassen', async () => {
  clearAll();
  await call('PUT', '/schedule/preferences', { body: { reminderOffsetMinutes: 30 } });

  const r = await call('PUT', '/schedule/preferences', { body: { weeklyHours: 20 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.weeklyHours, 20);
  assert.equal(r.body.data.reminderOffsetMinutes, 30, 'ein Feld ohne Erwaehnung im Body bleibt unangetastet');

  const get = await call('GET', '/schedule/preferences');
  assert.equal(get.body.data.weeklyHours, 20);
  assert.equal(get.body.data.reminderOffsetMinutes, 30);
});

test('PUT /schedule/preferences lehnt ungültige Wochenstunden ab', async () => {
  clearAll();
  const bad1 = await call('PUT', '/schedule/preferences', { body: { weeklyHours: 0 } });
  assert.equal(bad1.status, 400);
  const bad2 = await call('PUT', '/schedule/preferences', { body: { weeklyHours: 169 } });
  assert.equal(bad2.status, 400);
  const bad3 = await call('PUT', '/schedule/preferences', { body: { weeklyHours: 12.5 } });
  assert.equal(bad3.status, 400);
});

test('PUT /schedule/preferences mit weeklyHours: null setzt auf den Rückfallwert zurück', async () => {
  clearAll();
  await call('PUT', '/schedule/preferences', { body: { weeklyHours: 20 } });
  const r = await call('PUT', '/schedule/preferences', { body: { weeklyHours: null } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.weeklyHours, null);
});

test('PUT /schedule/preferences schaltet die Ueberstunden-Verfolgung um, ohne die anderen Felder anzufassen (S-24)', async () => {
  clearAll();
  await call('PUT', '/schedule/preferences', { body: { weeklyHours: 30, reminderOffsetMinutes: 10 } });

  const off = await call('PUT', '/schedule/preferences', { body: { overtimeEnabled: false } });
  assert.equal(off.status, 200);
  assert.equal(off.body.data.overtimeEnabled, false);
  assert.equal(off.body.data.weeklyHours, 30, 'ein Feld ohne Erwaehnung im Body bleibt unangetastet');
  assert.equal(off.body.data.reminderOffsetMinutes, 10);

  const get = await call('GET', '/schedule/preferences');
  assert.equal(get.body.data.overtimeEnabled, false, 'der Zustand bleibt ueber einen GET-Roundtrip hinweg erhalten');

  const on = await call('PUT', '/schedule/preferences', { body: { overtimeEnabled: true } });
  assert.equal(on.status, 200);
  assert.equal(on.body.data.overtimeEnabled, true);
});

test('PUT /schedule/preferences lehnt einen nicht-booleschen overtimeEnabled-Wert ab', async () => {
  clearAll();
  const bad1 = await call('PUT', '/schedule/preferences', { body: { overtimeEnabled: 'yes' } });
  assert.equal(bad1.status, 400);
  const bad2 = await call('PUT', '/schedule/preferences', { body: { overtimeEnabled: 1 } });
  assert.equal(bad2.status, 400);
  const bad3 = await call('PUT', '/schedule/preferences', { body: { overtimeEnabled: null } });
  assert.equal(bad3.status, 400, 'anders als reminderOffsetMinutes/weeklyHours gibt es hier keinen "zurueck auf Vorgabe"-Nullwert - ein Schalter ist immer eindeutig an oder aus');
});

test('PUT /schedule/preferences: weeklyHours: 0 bleibt abgelehnt - kein Sonderwert fuer "aus" (S-24, Entscheidung D-C)', async () => {
  clearAll();
  const r = await call('PUT', '/schedule/preferences', { body: { weeklyHours: 0 } });
  assert.equal(r.status, 400, 'ein eigener Schalter (overtimeEnabled) ist die Antwort auf S-24, nicht eine umgedeutete 0');
});

test('POST /reminders lehnt ein handgesetztes schedule_entry mit 400 ab', async () => {
  clearAll();
  const early = insertType();
  insertOverride(alice, REAL_TOMORROW, early);
  await call('PUT', '/schedule/preferences', { body: { reminderOffsetMinutes: 30 } });
  const anchor = anchorFor(alice, REAL_TOMORROW);

  const r = await call('POST', '/reminders', { body: { entity_type: 'schedule_entry', entity_id: anchor.id, remind_at: '2026-09-10T05:00:00' } });
  assert.equal(r.status, 400);
});
