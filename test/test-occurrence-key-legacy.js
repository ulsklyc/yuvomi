/**
 * Test: Altdaten lesen sich wie auf main (#2034, Schritt 4).
 *
 * Schritt 4 stellt den Schluessel eines Vorkommens auf den RFC-Originalstart
 * um (Format A: ganztaegig `YYYY-MM-DD`, mit Zone `YYYY-MM-DDTHH:MM:SSZ`,
 * schwebend `YYYY-MM-DDTHH:MM:SS`). Ohne Migration: alles, was schon in der
 * Datenbank steht, traegt weiter die alte Form `YYYY-MM-DD`, und diese Form
 * bedeutet IMMER die Lesart von main (eingefroren in
 * server/services/legacy-occurrence-key.js). Diese Datei haelt das fest.
 *
 * GOLDEN SNAPSHOT. `test/occurrence-key-legacy-fixture.json` ist MIT MAIN
 * erzeugt worden (Stand c5751b3c5, vor Schritt 4), unter TZ=UTC und
 * TZ=America/Chicago gleich. Der Korpus deckt die Uhren ab, die die Expansion
 * kennt, jede Serie mit einer alten Ausnahme und einem verknuepften
 * Einzelvorkommen in der alten Form:
 *   - Europe/Berlin taeglich 01:30, Start im Sommer (Schleife in Ortstagen,
 *     Schluessel ueber die alte Uhr: 24. und 25.03.2035 teilen `2035-03-24`)
 *   - Europe/Berlin taeglich 01:30, Start im Winter
 *   - America/Los_Angeles woechentlich 23:30 (UTC-Tag = Folgetag)
 *   - Asia/Tokyo taeglich 08:00 (UTC-Tag = Vortag)
 *   - schwebend (ohne Zone), ganztaegig
 *   - `tzid` mit zonenlosem Start (#1993, Haushalt Berlin)
 *   - Google-Start mit Offset und `tzid` (#2000: Schluessel = Ortstag)
 *
 * Verglichen werden: die gelesenen Termine (Start, Ende, Titel, Einzel-
 * vorkommen samt Schluessel) ueber den echten Lesepfad, die EXDATE-,
 * RECURRENCE-ID- und DTSTART-Zeilen des ICS-Feeds, und die alte Identitaet
 * jedes Vorkommens - die liefert ab Schritt 4 `legacyKeyFor()` der Uhr, auf
 * main war sie `recurrence_identity`. Dazu 1000 Tage je Serie ohne Ausnahmen:
 * `legacyKeyFor` muss dort Tag fuer Tag das `utcTagFuer` von main treffen.
 *
 * Neu erzeugen (nur mit Grund und nur auf dem Stand von main):
 *   OCCURRENCE_KEY_SNAPSHOT_WRITE=1 node --experimental-sqlite test/test-occurrence-key-legacy.js
 *
 * Ausfuehren: npm run test:occurrence-key-legacy (TZ=UTC und America/Chicago)
 */

process.env.TZ = process.env.TZ || 'UTC';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const FIXTURE = new URL('./occurrence-key-legacy-fixture.json', import.meta.url);
const WRITE = process.env.OCCURRENCE_KEY_SNAPSHOT_WRITE === '1';

const db = (await import('../server/db.js')).get();
const { expandRecurringEvents } = await import('../server/services/calendar-events.js');
const { expandAndResolveEventRows } = await import('../server/services/calendar-event-reader.js');
const { buildFeed } = await import('../server/services/ics-export.js');

const HOUSEHOLD = 'Europe/Berlin';
const FEED_NOW = new Date('2035-03-01T12:00:00Z');
db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run();
db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', ?)").run(HOUSEHOLD);

const CORPUS = [
  {
    name: 'berlin-summer-start', tzid: 'Europe/Berlin', rule: 'FREQ=DAILY',
    start: '2034-06-30T23:30:00Z', end: '2034-07-01T00:30:00Z',
    exdate: '2035-03-24', child: '2035-10-28',
    windows: [['2035-03-21', '2035-03-28'], ['2035-10-25', '2035-10-31']],
  },
  {
    name: 'berlin-winter-start', tzid: 'Europe/Berlin', rule: 'FREQ=DAILY',
    start: '2035-01-10T00:30:00Z', end: '2035-01-10T01:30:00Z',
    exdate: '2035-03-25', child: '2035-10-26',
    windows: [['2035-03-21', '2035-03-28'], ['2035-10-24', '2035-10-31']],
  },
  {
    name: 'la-weekly-2330', tzid: 'America/Los_Angeles', rule: 'FREQ=WEEKLY;BYDAY=MO',
    start: '2035-06-12T06:30:00Z', end: '2035-06-12T07:30:00Z',
    exdate: '2035-06-19', child: '2035-06-26',
    windows: [['2035-06-10', '2035-07-12'], ['2035-10-28', '2035-11-14']],
  },
  {
    name: 'tokyo-daily-0800', tzid: 'Asia/Tokyo', rule: 'FREQ=DAILY',
    start: '2026-01-06T23:00:00Z', end: '2026-01-07T00:00:00Z',
    exdate: '2026-01-07', child: '2026-01-08',
    windows: [['2026-01-05', '2026-01-12']],
  },
  {
    name: 'floating-daily', tzid: null, rule: 'FREQ=DAILY',
    start: '2035-03-20T01:30', end: '2035-03-20T02:30',
    exdate: '2035-03-25', child: '2035-03-26',
    windows: [['2035-03-20', '2035-03-29']],
  },
  {
    name: 'all-day-weekly', tzid: null, rule: 'FREQ=WEEKLY', allDay: 1,
    start: '2035-03-20', end: '2035-03-20',
    exdate: '2035-03-27', child: '2035-04-03',
    windows: [['2035-03-18', '2035-04-12']],
  },
  {
    name: 'tzid-naive-start-1993', tzid: 'America/New_York', rule: 'FREQ=DAILY',
    start: '2035-03-20T19:30', end: '2035-03-20T20:30',
    exdate: '2035-03-25', child: '2035-03-27',
    windows: [['2035-03-20', '2035-03-30'], ['2035-11-01', '2035-11-06']],
  },
  {
    name: 'google-offset-start', tzid: 'America/New_York', rule: 'FREQ=DAILY',
    start: '2035-10-30T19:30:00-04:00', end: '2035-10-30T20:30:00-04:00',
    source: 'google', exdate: '2035-11-05', child: '2035-11-07',
    windows: [['2035-10-30', '2035-11-10']],
  },
];

const ids = new Map();
for (const c of CORPUS) {
  const id = Number(db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, all_day, tzid, recurrence_rule,
       created_by, color, icon, visibility, external_source)
    VALUES (?, ?, ?, ?, ?, ?, 1, '#007AFF', 'calendar', 'all', ?)
  `).run(c.name, c.start, c.end, c.allDay ?? 0, c.tzid, c.rule, c.source ?? 'local').lastInsertRowid);
  ids.set(c.name, id);
  const insertException = db.prepare(
    'INSERT INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)',
  );
  insertException.run(id, c.exdate);
  insertException.run(id, c.child);
  // Ein verknuepftes Einzelvorkommen in alter Form: nur der Titel ist eigen,
  // Start und Ende kommen aus dem Slot, den der alte Schluessel trifft.
  db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, all_day, created_by, color, icon,
       visibility, external_source, recurrence_parent_id, recurrence_id, overridden_fields)
    VALUES (?, ?, ?, ?, 1, '#007AFF', 'calendar', 'all', 'local', ?, ?, '["title"]')
  `).run(`${c.name} (moved)`, c.start, c.end, c.allDay ?? 0, id, c.child);
}

function master(name) {
  return db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(ids.get(name));
}

function eventRows(name) {
  const id = ids.get(name);
  return db.prepare(`
    SELECT * FROM calendar_events WHERE id = ? OR recurrence_parent_id = ? ORDER BY id
  `).all(id, id);
}

/** Lesepfad wie GET /calendar, ein Fenster, nur die Felder, die bleiben muessen. */
function readWindow(name, from, to) {
  return expandAndResolveEventRows(db, eventRows(name), from, to)
    .filter((row) => !row.is_occurrence_override
      || (String(row.start_datetime).slice(0, 10) >= from && String(row.start_datetime).slice(0, 10) <= to))
    .map((row) => ({
      start: row.start_datetime,
      end: row.end_datetime ?? null,
      title: row.title,
      all_day: row.all_day ? 1 : 0,
      override: row.is_occurrence_override === true,
      // Ein Einzelvorkommen nennt seinen GESPEICHERTEN Schluessel - der bleibt
      // ohne Migration in alter Form und muss Wort fuer Wort gleich sein.
      ...(row.is_occurrence_override ? { recurrence_id: row.recurrence_id } : {}),
      // Die Identitaet eines Serienvorkommens wechselt mit Schritt 4 die Form;
      // ihre alte Lesart prueft `legacyIdentity` unten.
      ...(!row.is_occurrence_override ? { legacy_identity: WRITE ? row.recurrence_identity : null } : {}),
    }));
}

function feedLines() {
  const ics = buildFeed(db, 1, FEED_NOW, HOUSEHOLD);
  const blocks = ics.replace(/\r\n /g, '').split('BEGIN:VEVENT').slice(1);
  const byUid = {};
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const uid = lines.find((line) => line.startsWith('UID:'));
    const kept = lines.filter((line) => /^(DTSTART|DTEND|EXDATE|RECURRENCE-ID|RRULE)[;:]/.test(line));
    (byUid[uid] ??= []).push(kept);
  }
  for (const uid of Object.keys(byUid)) byUid[uid].sort((a, b) => a.join().localeCompare(b.join()));
  return byUid;
}

function daysBetween(fromKey, toKey) {
  return Math.round((Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / 86400000);
}

/** Der Tag eines Starts, wie er ohne Uhr der Serie abzulesen ist. */
function plainDayOf(start) {
  return /(?:Z|[+-]\d{2}:\d{2})$/.test(start) ? new Date(start).toISOString().slice(0, 10) : start.slice(0, 10);
}

/** 1000 Tage ohne Ausnahmen: Starts als Digest, Identitaet als Tagesversatz. */
function thousandDays(name, identityOf) {
  const row = master(name);
  const from = plainDayOf(row.start_datetime);
  const to = new Date(Date.parse(`${from}T00:00:00Z`) + 1000 * 86400000).toISOString().slice(0, 10);
  const occurrences = expandRecurringEvents([row], from, to, new Map(), {
    includeRecurrenceIdentity: true, householdZone: HOUSEHOLD, maxIterations: 5000,
  });
  const starts = occurrences.map((o) => o.start_datetime);
  const offsets = occurrences.map((o) => {
    const delta = daysBetween(plainDayOf(o.start_datetime), identityOf(row, o));
    return delta === 0 ? '0' : delta === 1 ? '+' : delta === -1 ? '-' : `[${delta}]`;
  }).join('');
  return {
    count: occurrences.length,
    starts_sha256: createHash('sha256').update(starts.join('\n')).digest('hex'),
    identity_offsets: offsets,
  };
}

function produce(identityOf) {
  const out = { household_zone: HOUSEHOLD, cases: {} };
  for (const c of CORPUS) {
    out.cases[c.name] = {
      windows: c.windows.map(([from, to]) => ({ from, to, events: readWindow(c.name, from, to) })),
      thousand_days: thousandDays(c.name, identityOf),
    };
  }
  out.feed = feedLines();
  return out;
}

if (WRITE) {
  const snapshot = produce((_row, occurrence) => occurrence.recurrence_identity);
  writeFileSync(FIXTURE, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`wrote ${FIXTURE.pathname}`);
} else {
  const { occurrenceClock } = await import('../server/services/calendar-events.js');
  const { storedToInstantMs } = await import('../server/utils/timezone.js');
  const snapshot = JSON.parse(readFileSync(FIXTURE, 'utf8'));

  /** Der Schleifentag eines Vorkommens: der Tag, dessen Start dieser Zeitpunkt ist. */
  function loopDayOf(clock, start) {
    const base = plainDayOf(start);
    for (const offset of [0, -1, 1]) {
      const day = new Date(Date.parse(`${base}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
      const candidate = String(clock.instantFor(day));
      if (candidate === start
          || (storedToInstantMs(candidate, 'UTC') !== null
            && storedToInstantMs(candidate, 'UTC') === storedToInstantMs(start, 'UTC'))) return day;
    }
    return null;
  }
  const legacyIdentity = (row, occurrence) => {
    const clock = occurrenceClock(row, HOUSEHOLD);
    const day = loopDayOf(clock, occurrence.start_datetime);
    assert.ok(day, `kein Schleifentag fuer ${occurrence.start_datetime}`);
    return clock.legacyKeyFor(day);
  };

  test('Golden Snapshot: gelesene Termine je Fenster wie auf main', () => {
    for (const c of CORPUS) {
      c.windows.forEach(([from, to], index) => {
        const expected = snapshot.cases[c.name].windows[index];
        assert.equal(expected.from, from);
        const actual = readWindow(c.name, from, to);
        const row = master(c.name);
        const clock = occurrenceClock(row, HOUSEHOLD);
        // Die alte Identitaet jedes Serienvorkommens ueber die eingefrorene Lesart.
        for (const event of actual) {
          if (event.override) continue;
          const day = loopDayOf(clock, event.start);
          event.legacy_identity = day ? clock.legacyKeyFor(day) : null;
        }
        assert.deepEqual(actual, expected.events, `${c.name} ${from}..${to}`);
      });
    }
  });

  test('Golden Snapshot: ICS-Feed nennt dieselben Slots wie auf main', () => {
    assert.deepEqual(feedLines(), snapshot.feed);
  });

  test('legacyKeyFor trifft utcTagFuer von main Tag fuer Tag ueber 1000 Tage', () => {
    for (const c of CORPUS) {
      assert.deepEqual(thousandDays(c.name, legacyIdentity), snapshot.cases[c.name].thousand_days, c.name);
    }
  });

  test('der Korpus deckt die Kollision der alten Form ab (sonst prueft er nichts)', () => {
    // Berlin, Start im Sommer: der 24. und der 25.03.2035 tragen auf main
    // denselben Schluessel - und die alte Ausnahme blendet beide aus.
    const window = snapshot.cases['berlin-summer-start'].windows[0].events;
    const starts = window.map((event) => event.start);
    assert.ok(!starts.includes('2035-03-24T00:30:00Z'));
    assert.ok(!starts.includes('2035-03-24T23:30:00Z'));
    // Google mit Offset: die alte Identitaet ist der Ortstag, nicht der UTC-Tag (#2000).
    const google = snapshot.cases['google-offset-start'].windows[0].events
      .find((event) => event.start === '2035-11-07T00:30:00Z');
    assert.equal(google?.legacy_identity, '2035-11-06');
  });
}
