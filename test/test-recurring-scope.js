/**
 * Tests: Serientermin-Scope-Logik (public/utils/recurrence-scope.js, #532)
 * Fokus:
 *  - truncateRuleBefore kürzt Serien per UNTIL (Vortag, inklusiv) und wirft
 *    bestehendes UNTIL/COUNT ab; Reihenfolge FREQ;INTERVAL;BYDAY;UNTIL.
 *  - Die gekürzte Regel entfernt in der echten Expansion genau die Vorkommen
 *    ab dem Grenzdatum (End-to-End gegen server/services/calendar-events.js).
 *  - shiftSeriesStart / shiftEndForStart erhalten die Verschiebung bzw. Dauer.
 * Rein im Node-Kontext (keine DOM-/i18n-Abhängigkeiten).
 * Ausführen: node test/test-recurring-scope.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { truncateRuleBefore, shiftSeriesStart, shiftEndForStart } =
  await import('../public/utils/recurrence-scope.js');
const { expandRecurringEvents } = await import('../server/services/calendar-events.js');

// Der Server-Validator, gegen den gekürzte Regeln bestehen müssen.
const RRULE_RE = /^(FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;INTERVAL=\d{1,2})?(;BYDAY=[A-Z,]{2,}(,[A-Z]{2})*)?(;(UNTIL=\d{8}(T\d{6}Z)?|COUNT=\d{1,4}))?)?$/;

// --- truncateRuleBefore ---

test('truncateRuleBefore: setzt UNTIL auf den Vortag (inklusive Grenze)', () => {
  assert.equal(
    truncateRuleBefore('FREQ=WEEKLY', '2026-07-19'),
    'FREQ=WEEKLY;UNTIL=20260718'
  );
});

test('truncateRuleBefore: erhält INTERVAL und BYDAY in kanonischer Reihenfolge', () => {
  assert.equal(
    truncateRuleBefore('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH', '2026-07-20'),
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;UNTIL=20260719'
  );
});

test('truncateRuleBefore: wirft bestehendes UNTIL/COUNT ab', () => {
  assert.equal(
    truncateRuleBefore('FREQ=DAILY;UNTIL=20261231T235959Z', '2026-07-10'),
    'FREQ=DAILY;UNTIL=20260709'
  );
  assert.equal(
    truncateRuleBefore('FREQ=DAILY;COUNT=10', '2026-07-10'),
    'FREQ=DAILY;UNTIL=20260709'
  );
});

test('truncateRuleBefore: INTERVAL=1 wird weggelassen (wie beim UI-Builder)', () => {
  assert.equal(truncateRuleBefore('FREQ=DAILY;INTERVAL=1', '2026-07-10'), 'FREQ=DAILY;UNTIL=20260709');
});

test('truncateRuleBefore: Ergebnis besteht den Server-RRULE-Validator', () => {
  for (const rule of ['FREQ=DAILY', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR', 'FREQ=MONTHLY;COUNT=5']) {
    const out = truncateRuleBefore(rule, '2026-08-15');
    assert.ok(RRULE_RE.test(out), `ungültige Regel: ${out}`);
  }
});

test('truncateRuleBefore: null bei fehlender Regel oder ungültigem Datum', () => {
  assert.equal(truncateRuleBefore('', '2026-07-19'), null);
  assert.equal(truncateRuleBefore('FREQ=DAILY', 'kaputt'), null);
  assert.equal(truncateRuleBefore('FREQ=DAILY', ''), null);
});

// --- End-to-End: gekürzte Regel entfernt Vorkommen ab Grenzdatum ---

test('gekürzte Serie: Vorkommen ab Grenzdatum entfallen, davor bleiben', () => {
  const base = {
    id: 1,
    title: 'Standup',
    start_datetime: '2026-07-06T09:00',
    end_datetime: '2026-07-06T09:15',
    all_day: 0,
  };
  // Wöchentlich montags ab 06.07.; „dieser und folgende" ab dem 20.07. löschen.
  const truncated = truncateRuleBefore('FREQ=WEEKLY', '2026-07-20');
  const dates = expandRecurringEvents(
    [{ ...base, recurrence_rule: truncated }],
    '2026-07-01', '2026-08-31'
  ).map((e) => e.start_datetime.slice(0, 10));
  assert.deepEqual(dates, ['2026-07-06', '2026-07-13']); // 20.07. und später entfallen
});

// --- shiftSeriesStart: Delta auf den Master anwenden ---

test('shiftSeriesStart: nur Titel geändert (kein Zeitversatz) → Master-Start unverändert', () => {
  // Instanz #3 geöffnet, Zeit unverändert → Master behält seinen DTSTART.
  assert.equal(
    shiftSeriesStart('2026-07-06T09:00', '2026-07-20T09:00', '2026-07-20T09:00', false),
    '2026-07-06T09:00'
  );
});

test('shiftSeriesStart: Uhrzeit verschoben → gleiche Verschiebung am Master', () => {
  assert.equal(
    shiftSeriesStart('2026-07-06T09:00', '2026-07-20T09:00', '2026-07-20T10:30', false),
    '2026-07-06T10:30'
  );
});

test('shiftSeriesStart: ganztägig, um zwei Tage verschoben', () => {
  assert.equal(
    shiftSeriesStart('2026-07-06', '2026-07-20', '2026-07-22', true),
    '2026-07-08'
  );
});

// --- shiftEndForStart: Dauer erhalten ---

test('shiftEndForStart: Dauer bleibt am neuen Start erhalten', () => {
  assert.equal(
    shiftEndForStart('2026-07-06T10:30', '2026-07-20T10:30', '2026-07-20T11:00', false),
    '2026-07-06T11:00'
  );
});

test('shiftEndForStart: ohne Ende → null', () => {
  assert.equal(shiftEndForStart('2026-07-06T10:30', '2026-07-20T10:30', null, false), null);
});

test('shiftEndForStart: ganztägig mehrtägig, Dauer in Tagen erhalten', () => {
  assert.equal(
    shiftEndForStart('2026-07-08', '2026-07-22', '2026-07-24', true),
    '2026-07-10'
  );
});
