/**
 * Modul: Kalendersuche - Schnitt und Gleichstand (GET /api/v1/calendar/search)
 * Zweck: Die Route liest hoechstens 100 Kandidaten. Sie schneidet in der Folge
 *        der globalen Suche (calendarSearchSlice): Kommendes und Serien zuerst,
 *        dann vergangene Einzeltermine ab dem juengsten, bei Gleichstand die
 *        hoehere id. Angezeigt wird aufsteigend nach aufgeloestem Start, bei
 *        gleichem Start die niedrigere id zuerst.
 *        Alle Daten liegen relativ zu `todayKey()`, nie auf einem festen Tag.
 * Ausfuehren: node test/test-calendar-search-cut.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

const dbmod = await import('../server/db.js');
const { createCalendarApp } = await import('./calendar-app.js');
const { todayKey, shiftDateKey } = await import('../server/utils/timezone.js');
const db = dbmod.get();

db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run();

// createCalendarApp (test/calendar-app.js): echter Praefix, defaultEmptyBody und
// der zentrale Fehlerhandler, wie validateRequest() sie braucht (#2810).
const app = await createCalendarApp({
  mount: ['calendar'],
  auth: (/** @type {Record<string, unknown>} */ req, /** @type {unknown} */ _res, /** @type {() => void} */ next) => {
    req.authUserId = 1;
    req.authRole = 'admin';
    req.session = { userId: 1, role: 'admin' };
    req.sessionModuleAccess = null;
    req.authScopes = null;
    next();
  },
});
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}/api/v1/calendar`)));
test.after(() => server.close());

/** @param {string} q */
async function search(q) {
  const res = await fetch(`${baseUrl}/search?q=${encodeURIComponent(q)}`);
  assert.equal(res.status, 200);
  return res.json();
}

/**
 * @param {string} title
 * @param {string} start
 * @param {{ id?: number, recurrence_rule?: string }} [extra]
 */
function insertEvent(title, start, extra = {}) {
  return Number(db.prepare(`
    INSERT INTO calendar_events (id, title, start_datetime, created_by, visibility, external_source, recurrence_rule)
    VALUES (@id, @title, @start, 1, 'all', 'local', @rule)
  `).run({ id: extra.id ?? null, title, start, rule: extra.recurrence_rule ?? null }).lastInsertRowid);
}

const today = todayKey(db);

test('mehr als 100 Treffer: Kommendes und Serie bleiben, von den vergangenen die juengsten', async () => {
  // 105 vergangene Einzeltermine, Tag -200 bis -96; der juengste zuletzt angelegt.
  /** @type {number[]} */
  const past = [];
  for (let i = 0; i < 105; i++) past.push(insertEvent(`Qzxcutpast ${i}`, `${shiftDateKey(today, -200 + i)}T09:00`));
  const upcoming = insertEvent('Qzxcutpast kommend', `${shiftDateKey(today, 10)}T09:00`);
  // Eine Serie von vor zehn Jahren: ihre Stammzeile ist der aelteste Treffer,
  // aufgeloest liegt sie im kommenden Jahr.
  const series = insertEvent('Qzxcutpast Serie', `${shiftDateKey(today, -3650)}T18:00`, { recurrence_rule: 'FREQ=YEARLY' });

  const body = await search('Qzxcutpast');
  assert.equal(body.total, 107, 'total nennt alle Treffer');
  assert.equal(body.data.length, 100);
  const ids = body.data.map((/** @type {{ id: number, series_id?: number }} */ e) => e.series_id ?? e.id);
  assert.ok(ids.includes(upcoming), 'der kommende Termin fehlt');
  assert.ok(ids.includes(series), 'die Serieninstanz fehlt');
  const seriesHit = body.data.find((/** @type {{ id: number, series_id?: number }} */ e) => (e.series_id ?? e.id) === series);
  assert.ok(seriesHit.start_datetime.slice(0, 10) >= today, 'die Serie steht an einer kommenden Instanz');
  // Die 98 juengsten vergangenen bleiben, die sieben aeltesten fallen weg.
  assert.deepEqual(ids.filter((/** @type {number} */ id) => past.includes(id)), past.slice(7));
  const starts = body.data.map((/** @type {{ start_datetime: string }} */ e) => e.start_datetime);
  assert.deepEqual(starts, [...starts].sort(), 'Anzeige aufsteigend nach aufgeloestem Start');
});

test('Gleichstand am Schnitt: es bleiben die vergangenen mit den hoechsten ids, angezeigt id aufsteigend', async () => {
  const start = `${shiftDateKey(today, -30)}T09:00`;
  /** @type {number[]} */
  const past = [];
  for (let i = 0; i < 101; i++) past.push(insertEvent(`Qzxcuttie ${i}`, start));
  const upcoming = insertEvent('Qzxcuttie kommend', `${shiftDateKey(today, 5)}T09:00`);

  const body = await search('Qzxcuttie');
  assert.equal(body.total, 102);
  const ids = body.data.map((/** @type {{ id: number }} */ e) => e.id);
  assert.deepEqual(ids, [...past.slice(2), upcoming]);
});

test('Gleichstand in der Anzeige: gleicher Start steht id aufsteigend', async () => {
  const start = `${shiftDateKey(today, 7)}T09:00`;
  for (const id of [9002, 9003, 9001]) insertEvent(`Qzxcuttri ${id}`, start, { id });

  const body = await search('Qzxcuttri');
  assert.deepEqual(body.data.map((/** @type {{ id: number }} */ e) => e.id), [9001, 9002, 9003]);
});
