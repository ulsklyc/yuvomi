/**
 * Modul: Aktivitäts-Logik-Test
 * Zweck: Reine Funktionen weekSummary() (7 Tages-Buckets Mo–So mit Dauer-Summe
 *        je Tag + Zeitraum from/to, Filterung außerhalb der Woche) und
 *        activityTotals() (Anzahl/Dauer/Distanz/Kalorien-Summen). DOM-frei.
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-health-activity.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  ACTIVITY_TYPES,
  ACTIVITY_TYPE_VALUES,
  activityType,
  weekSummary,
  activityTotals,
} = await import('../public/utils/health-activity.js');

// --------------------------------------------------------
// Preset-Definitionen
// --------------------------------------------------------

test('ACTIVITY_TYPES: jeder Eintrag trägt value + vollständigen labelKey + icon', () => {
  assert.ok(ACTIVITY_TYPES.length >= 5);
  for (const a of ACTIVITY_TYPES) {
    assert.equal(typeof a.value, 'string');
    assert.ok(a.labelKey.startsWith('health.activity.type.'));
    assert.equal(typeof a.icon, 'string');
  }
});

test('ACTIVITY_TYPE_VALUES spiegelt die value-Reihenfolge', () => {
  assert.deepEqual(ACTIVITY_TYPE_VALUES, ACTIVITY_TYPES.map((a) => a.value));
});

test('activityType: Treffer + null für Freitext-Typ', () => {
  assert.equal(activityType('running')?.value, 'running');
  assert.equal(activityType('Frisbee'), null);
  assert.equal(activityType(null), null);
});

// --------------------------------------------------------
// weekSummary — 7 Tages-Buckets Mo–So
// --------------------------------------------------------

// Anker Mittwoch, 2026-07-01 → Woche Mo 2026-06-29 … So 2026-07-05.
const ANCHOR = '2026-07-01';

test('weekSummary: 7 Buckets Mo–So mit korrektem Zeitraum', () => {
  const s = weekSummary([], { anchor: ANCHOR, weekStartsOn: 1 });
  assert.equal(s.buckets.length, 7);
  assert.equal(s.from, '2026-06-29');
  assert.equal(s.to, '2026-07-05');
  assert.deepEqual(s.buckets.map((b) => b.date), [
    '2026-06-29', '2026-06-30', '2026-07-01',
    '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05',
  ]);
  assert.deepEqual(s.buckets.map((b) => b.index), [0, 1, 2, 3, 4, 5, 6]);
});

test('weekSummary: Dauer je Tag summiert, mehrere Einheiten pro Tag', () => {
  const activities = [
    { performed_at: '2026-06-29T07:00', duration_min: 30 },
    { performed_at: '2026-06-29T18:30', duration_min: 45 },
    { performed_at: '2026-07-05T10:00', duration_min: 60 },
  ];
  const s = weekSummary(activities, { anchor: ANCHOR, weekStartsOn: 1 });
  assert.equal(s.buckets[0].durationMin, 75); // Mo: 30 + 45
  assert.equal(s.buckets[0].count, 2);
  assert.equal(s.buckets[6].durationMin, 60); // So
  assert.equal(s.buckets[6].count, 1);
  assert.equal(s.buckets[3].durationMin, 0);  // Do: leer
});

test('weekSummary: Einheiten außerhalb der Woche werden ignoriert', () => {
  const activities = [
    { performed_at: '2026-06-28T09:00', duration_min: 20 }, // So davor
    { performed_at: '2026-07-06T09:00', duration_min: 20 }, // Mo danach
    { performed_at: '2026-07-01T09:00', duration_min: 25 }, // in der Woche
  ];
  const s = weekSummary(activities, { anchor: ANCHOR, weekStartsOn: 1 });
  const total = s.buckets.reduce((sum, b) => sum + b.durationMin, 0);
  assert.equal(total, 25);
  assert.equal(s.buckets[2].durationMin, 25); // Mi
});

test('weekSummary: fehlende/ungültige Dauer zählt als Einheit, aber nicht zur Summe', () => {
  const activities = [
    { performed_at: '2026-07-01T09:00' },                      // keine Dauer
    { performed_at: '2026-07-01T10:00', duration_min: null },  // null
    { performed_at: '2026-07-01T11:00', duration_min: 'abc' }, // ungültig
    { performed_at: '2026-07-01T12:00', duration_min: 40 },
  ];
  const s = weekSummary(activities, { anchor: ANCHOR, weekStartsOn: 1 });
  assert.equal(s.buckets[2].count, 4);
  assert.equal(s.buckets[2].durationMin, 40);
});

test('weekSummary: performed_at mit Datetime-Anteil wird nach Datum gebucketet', () => {
  const s = weekSummary(
    [{ performed_at: '2026-07-03T23:59', duration_min: 10 }],
    { anchor: ANCHOR, weekStartsOn: 1 },
  );
  assert.equal(s.buckets[4].durationMin, 10); // Fr
});

test('weekSummary: robust gegen leere/ungültige Eingaben', () => {
  assert.equal(weekSummary(null, { anchor: ANCHOR }).buckets.length, 7);
  assert.equal(weekSummary(undefined, { anchor: ANCHOR }).buckets.length, 7);
  const s = weekSummary([null, undefined, {}], { anchor: ANCHOR });
  assert.equal(s.buckets.reduce((sum, b) => sum + b.durationMin, 0), 0);
});

// --------------------------------------------------------
// activityTotals — Summen über eine Liste
// --------------------------------------------------------

test('activityTotals: summiert Anzahl/Dauer/Distanz/Kalorien', () => {
  const activities = [
    { duration_min: 30, distance_km: 5, calories: 300 },
    { duration_min: 45, distance_km: 8.5, calories: 500 },
    { duration_min: 20 },
  ];
  const t = activityTotals(activities);
  assert.equal(t.count, 3);
  assert.equal(t.durationMin, 95);
  assert.equal(t.distanceKm, 13.5);
  assert.equal(t.calories, 800);
});

test('activityTotals: fehlende/ungültige Felder übersprungen, count zählt jede Einheit', () => {
  const activities = [
    { duration_min: null, distance_km: '', calories: undefined },
    { duration_min: 'x', distance_km: 3, calories: 100 },
    {},
  ];
  const t = activityTotals(activities);
  assert.equal(t.count, 3);
  assert.equal(t.durationMin, 0);
  assert.equal(t.distanceKm, 3);
  assert.equal(t.calories, 100);
});

test('activityTotals: leere/ungültige Eingaben → Nullsummen (null-Einträge zählen nicht)', () => {
  const zero = { count: 0, durationMin: 0, distanceKm: 0, calories: 0 };
  for (const input of [[], null, undefined, [null, undefined]]) {
    assert.deepEqual(activityTotals(input), zero);
  }
});

// --------------------------------------------------------
// Gleitende Woche (Critique 2026-10-05, R16)
// --------------------------------------------------------
//
// Die Aktivitaet rechnete in der Kalenderwoche: am Montag, 05.10., war die
// Woche leer, waehrend die Bereichsliste "Laufen · 04.10." meldete. Die
// laufende Woche sind jetzt die letzten 7 Tage, endend heute; zurueckgeblaettert
// bleibt es die Kalenderwoche Mo-So.

test('R16: die laufende Woche sind die letzten 7 Tage, der Lauf von gestern zaehlt', () => {
  const today = '2026-10-05'; // Montag
  const s = weekSummary([{ performed_at: '2026-10-04T18:00', duration_min: 40 }], { anchor: today, today });
  assert.deepEqual([s.from, s.to], ['2026-09-29', today]);
  assert.equal(s.buckets.at(-2).durationMin, 40, 'der Sonntag steht im Fenster');
  // Die Spalten nennen ihren WOCHENTAG - sie beginnen nicht mehr immer am Montag.
  assert.deepEqual(s.buckets.map((b) => b.weekday), [1, 2, 3, 4, 5, 6, 0], 'Di ... So, Mo');
});

test('R16: zurueckgeblaettert bleibt es die Kalenderwoche Mo-So', () => {
  const s = weekSummary([], { anchor: '2026-09-28', today: '2026-10-05' });
  assert.deepEqual([s.from, s.to], ['2026-09-28', '2026-10-04']);
  assert.deepEqual(s.buckets.map((b) => b.weekday), [0, 1, 2, 3, 4, 5, 6]);
});

// Review PR #1673: nach dem Speichern springt die Seite auf den Tag der
// Einheit. Lag er hinter heute in der laufenden Woche, zeigte sie das gleitende
// Fenster bis heute - die eben gespeicherte Einheit stand in keinem Fenster.
test('R16: eine Einheit von uebermorgen steht in der laufenden Kalenderwoche', () => {
  const today = '2026-10-05'; // Montag
  const s = weekSummary([{ performed_at: '2026-10-07T18:00', duration_min: 30 }], { anchor: '2026-10-07', today });
  assert.deepEqual([s.from, s.to], ['2026-10-05', '2026-10-11']);
  assert.equal(s.buckets[2].durationMin, 30);
});

test('R16: die Aktivitaetswoche blaettert lueckenlos', async () => {
  const { stepActivityAnchor } = await import('../public/utils/health-activity.js');
  const today = '2026-10-07'; // Mittwoch
  const windows = [];
  let anchor = stepActivityAnchor(today, -1, 1, { today });
  for (let i = 0; i < 4; i++) {
    const s = weekSummary([], { anchor, today });
    windows.push([s.from, s.to]);
    anchor = stepActivityAnchor(anchor, 1, 1, { today });
  }
  assert.deepEqual(windows, [
    ['2026-09-28', '2026-10-04'],
    ['2026-10-01', '2026-10-07'],
    ['2026-10-05', '2026-10-11'],
    ['2026-10-12', '2026-10-18'],
  ]);
});

test('R16: ohne Anker und ohne "today" rechnet die Woche am Tag des Haushalts', async () => {
  const { mock } = await import('node:test');
  const tz = await import('/utils/timezone.js');
  const prevTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-04T23:30:00Z') });
  tz.setDisplayTimeZone('Europe/Berlin');
  try {
    const s = weekSummary([]);
    assert.deepEqual([s.from, s.to], ['2026-09-29', '2026-10-05']);
  } finally {
    tz.setDisplayTimeZone(null);
    mock.timers.reset();
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
  }
});
