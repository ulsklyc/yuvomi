/**
 * Test: ein Countdown zaehlt auf den Tag der HAUSHALTSZONE herunter, nie auf
 * den der Prozesszone (#1998).
 *
 * Ein lokal angelegter Termin mit Uhrzeit steht als zonenlose Wanduhr des
 * Haushalts in der Zeile (`2035-10-02T23:30`). `eventStartDateKey` las diese
 * Ziffern mit `utcToWall()`, also ueber `new Date()` in der Zone des PROZESSES:
 * im Standard-Container (TZ=UTC) mit Haushalt Europe/Berlin wurde aus 23:30 am
 * 02.10. der 03.10. `test:countdown` sah das nie, weil die Suite TZ fest auf
 * Europe/Berlin setzt - Prozess und Haushalt fielen dort zusammen.
 *
 * Erwartet: zonenlose Ziffern tragen ihren Tag im Datumsteil; ein Instant wird
 * in der Haushaltszone zum Tag. "Heute" kommt als fester `todayKey` herein,
 * die Uhr ist damit eingefroren - nichts hier liest `Date.now()`.
 *
 * Das Skript faehrt die Datei unter TZ=UTC, Europe/Berlin und Pacific/Auckland.
 *
 * Ausfuehren: npm run test:countdown-household-day
 */

process.env.TZ = process.env.TZ || 'UTC';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';

const db = (await import('../server/db.js')).get();
const { getCountdowns, nextEventDate } = await import('../server/services/countdowns.js');

const BERLIN = 'Europe/Berlin';
const LA = 'America/Los_Angeles';
const ZONE = process.env.TZ;

const userId = db.prepare(
  "INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')",
).run().lastInsertRowid;

function setHousehold(zone) {
  db.prepare(`INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(zone);
}

function insertEvent({ start, rule = null, tzid = null }) {
  return db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, all_day, recurrence_rule, tzid, created_by, visibility, countdown)
    VALUES ('Abend', ?, 0, ?, ?, ?, 'all', 1)
  `).run(start, rule, tzid, userId).lastInsertRowid;
}

function countdownFor(id, todayKey) {
  const { items } = getCountdowns(db, { userId, todayKey });
  return items.find((item) => item.source === 'event' && item.id === id) ?? null;
}

test(`TZ=${ZONE}: ein Abendtermin zaehlt auf seinen eigenen Tag, Haushalt oestlich von UTC`, () => {
  assert.equal(nextEventDate({ all_day: 0, start_datetime: '2035-10-02T23:30' }, '2035-10-01', null, { tz: BERLIN }),
    '2035-10-02');
});

test(`TZ=${ZONE}: ein Fruehtermin zaehlt auf seinen eigenen Tag, Haushalt westlich von UTC`, () => {
  // Die verschobene Zone: 00:30 in Los Angeles liegt in jeder Prozesszone
  // dieses Laufs (UTC, Berlin, Auckland) noch oder schon auf einem anderen Tag.
  assert.equal(nextEventDate({ all_day: 0, start_datetime: '2035-10-02T00:30' }, '2035-10-01', null, { tz: LA }),
    '2035-10-02');
});

test(`TZ=${ZONE}: ein Instant wird in der Haushaltszone zum Tag`, () => {
  // 22:30Z ist in Berlin (Sommerzeit) 00:30 am Folgetag, in Los Angeles 15:30.
  const ev = { all_day: 0, start_datetime: '2035-10-02T22:30:00Z' };
  assert.equal(nextEventDate(ev, '2035-10-01', null, { tz: BERLIN }), '2035-10-03');
  assert.equal(nextEventDate(ev, '2035-10-01', null, { tz: LA }), '2035-10-02');
});

test(`TZ=${ZONE}: eine woechentliche Abendserie springt nicht auf den Folgetag`, () => {
  // Mittwochs 23:30 ab dem 03.10.2035. Am Donnerstag ist das naechste
  // Vorkommen der Mittwoch darauf - nicht "heute".
  const ev = { all_day: 0, start_datetime: '2035-10-03T23:30', recurrence_rule: 'RRULE:FREQ=WEEKLY' };
  assert.equal(nextEventDate(ev, '2035-10-04', null, { tz: BERLIN }), '2035-10-10');
  assert.equal(nextEventDate(ev, '2035-10-03', null, { tz: BERLIN }), '2035-10-03');
});

test(`TZ=${ZONE}: getCountdowns liest die Haushaltszone aus der Datenbank`, () => {
  setHousehold(BERLIN);
  const evening = insertEvent({ start: '2035-10-02T23:30' });
  const item = countdownFor(evening, '2035-10-02');
  assert.ok(item, 'der Abendtermin steht in der Liste');
  assert.equal(item.date, '2035-10-02');
  assert.equal(item.days_until, 0);

  setHousehold(LA);
  const early = insertEvent({ start: '2035-10-02T00:30' });
  const earlyItem = countdownFor(early, '2035-10-01');
  assert.ok(earlyItem, 'der Fruehtermin steht in der Liste');
  assert.equal(earlyItem.date, '2035-10-02');
  assert.equal(earlyItem.days_until, 1);
  db.prepare('UPDATE calendar_events SET countdown = 0').run();
});

test(`TZ=${ZONE}: die Monatsletzten-Frage einer Serie mit tzid haengt nicht an der Prozesszone`, () => {
  // Haushalt = tzid = Los Angeles, also keine zweite Uhr: der Start am 15.
  // um 00:30 liegt nicht auf "letzter Tag des Monats", der erste Termin ist der
  // 31.10. - so zeigt es auch der Kalender. Unter der Prozesszone gelesen lag
  // die Wanduhr der tzid am 14., die Pruefung setzte aus, und der Countdown
  // nannte den 15., an dem nichts stattfindet.
  const ev = {
    all_day: 0, tzid: LA, start_datetime: '2035-10-15T00:30', recurrence_rule: 'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1',
  };
  assert.equal(nextEventDate(ev, '2035-10-01', null, { tz: LA }), '2035-10-31');
  assert.equal(nextEventDate(ev, '2035-11-01', null, { tz: LA }), '2035-11-30');
});
