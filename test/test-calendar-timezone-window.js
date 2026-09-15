/**
 * Modul: Kalender-Ladefenster über Zeitzonengrenzen (#824)
 * Zweck: Extern synchronisierte Termine liegen als UTC in der Datenbank; der
 *        Serverfilter in server/routes/calendar/read.js vergleicht deren
 *        UTC-Kalendertag (`DATE(start_datetime)`) gegen die lokalen
 *        Tagesschlüssel der Ansicht. Westlich von UTC fällt ein Abendtermin
 *        damit auf den UTC-Folgetag - bei einem Fenster, das exakt die
 *        angezeigten Tage umfasst, verschwand er aus der Tagesansicht,
 *        während Monat, Woche und Agenda ihn zeigten (#824).
 *
 *        Deckt ab:
 *          - fetchWindow() weitet jedes Anzeigefenster um genau einen Tag
 *          - der Serverfilter lässt den Abendtermin ohne Puffer fallen
 *            (Gegenprobe: ohne sie wäre der Test blind, siehe unten)
 *          - mit Puffer liefert er ihn, und die Klammerung auf das
 *            Anzeigefenster hält Nachbartage draußen
 *          - östlich von UTC (Asia/Tokyo) bleibt das Ergebnis korrekt
 *
 *        Die Zeitzone wird hier explizit gesetzt: in der UTC-CI kippt kein
 *        Kalendertag, ein Test ohne TZ-Vorgabe wäre grün und blind.
 * Ausführen: node --experimental-sqlite --test test/test-calendar-timezone-window.js
 */
process.env.TZ = 'America/Los_Angeles';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');
const { __test: cal } = await import('../public/pages/calendar.js');
const db = dbmod.get();

db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run();

const app = express();
app.use((req, _res, next) => {
  req.authUserId = 1; req.authRole = 'admin';
  req.session = { userId: 1, role: 'admin' };
  next();
});
app.use('/', calendarRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

function insertEvent(title, start, end) {
  db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, created_by, color, icon, visibility,
       external_source, all_day, user_modified)
    VALUES (?, ?, ?, 1, '#007AFF', 'calendar', 'all', 'caldav', 0, 0)
  `).run(title, start, end);
}

// Alle drei in America/Los_Angeles (UTC-7 im März) gedacht:
insertEvent('Abend 19:00',   '2035-03-13T02:00:00Z', '2035-03-13T03:00:00Z'); // Di 12.03. lokal
insertEvent('Vormittag 09:00', '2035-03-12T16:00:00Z', '2035-03-12T17:00:00Z'); // Di 12.03. lokal
insertEvent('Vortag 19:00',  '2035-03-12T02:00:00Z', '2035-03-12T03:00:00Z'); // Mo 11.03. lokal

const pad = (n) => String(n).padStart(2, '0');
const localDate = (str) => {
  if (!str || str.length <= 10) return (str || '').slice(0, 10);
  const d = new Date(str);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

async function fetchRange(from, to) {
  const res = await fetch(`${baseUrl}/?from=${from}&to=${to}`);
  return (await res.json()).data;
}

/** Spiegelt buildDayIndex(): Bucket je lokalem Tag, geklammert auf das Anzeigefenster. */
function eventsOnDay(rows, cursor) {
  return rows.filter((e) => {
    const start = localDate(e.start_datetime);
    const end   = localDate(e.end_datetime || e.start_datetime);
    const from  = start < cursor ? cursor : start;
    const to    = end   > cursor ? cursor : end;
    return from <= to;
  }).map((e) => e.title).sort();
}

test('fetchWindow weitet das Anzeigefenster um genau einen Tag je Seite', () => {
  assert.deepEqual(cal.fetchWindow('2035-03-12', '2035-03-12'), { from: '2035-03-11', to: '2035-03-13' });
  assert.deepEqual(cal.fetchWindow('2035-03-01', '2035-03-31'), { from: '2035-02-28', to: '2035-04-01' });
});

test('Gegenprobe: ohne Puffer verliert die Tagesansicht den Abendtermin', async () => {
  const rows = await fetchRange('2035-03-12', '2035-03-12');
  assert.deepEqual(eventsOnDay(rows, '2035-03-12'), ['Vormittag 09:00'],
    'Ohne diese Gegenprobe wäre der Test unten auch bei kaputtem Puffer grün');
});

test('Tagesansicht zeigt mit Puffer alle Termine des lokalen Tages (#824)', async () => {
  const win  = cal.fetchWindow('2035-03-12', '2035-03-12');
  const rows = await fetchRange(win.from, win.to);
  assert.deepEqual(eventsOnDay(rows, '2035-03-12'), ['Abend 19:00', 'Vormittag 09:00']);
});

test('Der Puffer blendet keine Nachbartage ein', async () => {
  const win  = cal.fetchWindow('2035-03-12', '2035-03-12');
  const rows = await fetchRange(win.from, win.to);
  assert.ok(!eventsOnDay(rows, '2035-03-12').includes('Vortag 19:00'),
    'Der Montagstermin gehört auf den 11.03., nicht in die Tagesansicht des 12.03.');
  assert.deepEqual(eventsOnDay(rows, '2035-03-11'), ['Vortag 19:00']);
});

test('Wochenfenster verliert den Abendtermin am rechten Rand nicht', async () => {
  const win  = cal.fetchWindow('2035-03-06', '2035-03-12');
  const rows = await fetchRange(win.from, win.to);
  assert.ok(eventsOnDay(rows, '2035-03-12').includes('Abend 19:00'));
});

test('Östlich von UTC bleibt die Zuordnung korrekt', async () => {
  const prevTz = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  try {
    // 2035-03-11T23:00Z ist in Tokio (UTC+9) der 12.03. um 08:00.
    const win  = cal.fetchWindow('2035-03-12', '2035-03-12');
    const rows = await fetchRange(win.from, win.to);
    const titles = eventsOnDay(rows, '2035-03-12');
    assert.ok(titles.includes('Vortag 19:00'), 'in Tokio ist 2035-03-12T02:00Z der 12.03. um 11:00');
    assert.ok(!titles.includes('Abend 19:00'), '2035-03-13T02:00Z ist in Tokio der 13.03.');
  } finally {
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
  }
});
