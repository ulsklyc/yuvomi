/**
 * Modul: Zyklus-Logik-Test
 * Zweck: Reine Funktionen aus public/utils/health-cycle.js — Presets, Kennzahlen
 *        (cycleStats), Vorhersage (predictCycle: Zyklustag/Phase/nächste Periode/
 *        Eisprung/fruchtbares Fenster), Monatskalender (buildCycleCalendar) und
 *        Ring-Segmente (cycleRing). DOM-frei.
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-health-cycle.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  FLOW_LEVELS, FLOW_VALUES, flowLevel,
  SYMPTOM_TYPES, SYMPTOM_VALUES, symptomType,
  MOOD_TYPES, moodType,
  PHASE,
  daysBetween, sortPeriodsAsc, cycleGaps, periodLengths,
  cycleStats, predictCycle, buildCycleCalendar, cycleRing, pregnancyInfo,
} = await import('../public/utils/health-cycle.js');

// Baut eine Historie aus Startdaten mit fester Periodenlänge (Tage).
function periods(starts, periodLen = 5) {
  return starts.map((start, i) => {
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + periodLen - 1);
    return { id: i + 1, start_date: start, end_date: d.toISOString().slice(0, 10) };
  });
}

// --------------------------------------------------------
// Presets
// --------------------------------------------------------

test('FLOW_LEVELS: value + labelKey + aufsteigender rank', () => {
  assert.equal(FLOW_LEVELS.length, 4);
  FLOW_LEVELS.forEach((f, i) => {
    assert.equal(typeof f.value, 'string');
    assert.ok(f.labelKey.startsWith('health.cycle.flow.'));
    assert.equal(f.rank, i + 1);
  });
  assert.deepEqual(FLOW_VALUES, ['spotting', 'light', 'medium', 'heavy']);
  assert.equal(flowLevel('heavy').rank, 4);
  assert.equal(flowLevel('nope'), null);
});

test('SYMPTOM_TYPES / MOOD_TYPES: vollständige labelKeys + icons', () => {
  assert.ok(SYMPTOM_TYPES.length >= 6);
  for (const s of SYMPTOM_TYPES) {
    assert.ok(s.labelKey.startsWith('health.cycle.symptom.'));
    assert.equal(typeof s.icon, 'string');
  }
  assert.ok(SYMPTOM_VALUES.includes('cramps'));
  assert.equal(symptomType('cramps').value, 'cramps');
  assert.equal(symptomType('unknown'), null);
  for (const m of MOOD_TYPES) assert.ok(m.labelKey.startsWith('health.cycle.mood.'));
  assert.equal(moodType('great').value, 'great');
});

// --------------------------------------------------------
// Datums-/Historie-Helfer
// --------------------------------------------------------

test('daysBetween: ganzzahlige Differenz, NaN bei Müll', () => {
  assert.equal(daysBetween('2026-01-01', '2026-01-08'), 7);
  assert.equal(daysBetween('2026-01-08', '2026-01-01'), -7);
  assert.equal(daysBetween('2026-02-28', '2026-03-01'), 1); // 2026 kein Schaltjahr
  assert.ok(Number.isNaN(daysBetween('', '2026-01-01')));
});

test('sortPeriodsAsc: aufsteigend, filtert kaputte Zeilen', () => {
  const asc = sortPeriodsAsc([
    { start_date: '2026-03-01' }, { start_date: null }, { start_date: '2026-01-01' },
  ]);
  assert.deepEqual(asc.map((p) => p.start_date), ['2026-01-01', '2026-03-01']);
});

test('cycleGaps / periodLengths', () => {
  const hist = periods(['2026-01-01', '2026-01-29', '2026-02-26'], 5); // Abstände 28/28
  assert.deepEqual(cycleGaps(hist), [28, 28]);
  assert.deepEqual(periodLengths(hist), [5, 5, 5]);
});

// --------------------------------------------------------
// cycleStats
// --------------------------------------------------------

test('cycleStats: Mittelwerte aus Historie + Regelmäßigkeit', () => {
  const s = cycleStats(periods(['2026-01-01', '2026-01-29', '2026-02-26'], 5));
  assert.equal(s.count, 3);
  assert.equal(s.avgCycle, 28);
  assert.equal(s.avgPeriod, 5);
  assert.equal(s.regular, true);
  assert.equal(s.source, 'history');
});

test('cycleStats: unregelmäßig, wenn Schwankung > 7 Tage', () => {
  const s = cycleStats(periods(['2026-01-01', '2026-01-25', '2026-03-05'], 4)); // 24 / 39
  assert.equal(s.regular, false);
  assert.equal(s.variation, 15);
});

test('cycleStats: Einstellungen überschreiben Historie, Defaults ohne Daten', () => {
  const s = cycleStats(periods(['2026-01-01', '2026-01-29']), { cycle_length_avg: 30, period_length_avg: 6, luteal_length: 13 });
  assert.equal(s.avgCycle, 30);
  assert.equal(s.avgPeriod, 6);
  assert.equal(s.lutealLength, 13);
  assert.equal(s.source, 'settings');

  const empty = cycleStats([]);
  assert.equal(empty.avgCycle, 28);
  assert.equal(empty.avgPeriod, 5);
  assert.equal(empty.source, 'default');
});

test('cycleStats: explizite NULL-Einstellungen fallen auf Historie zurück (Number(null)≠0-Falle)', () => {
  // GET /cycle/settings liefert cycle_length_avg=null etc. — darf NICHT auf die
  // Clamp-Untergrenze (15/1) fallen, sondern die abgeleiteten Werte nutzen.
  const s = cycleStats(periods(['2026-01-01', '2026-01-29', '2026-02-26'], 5),
    { cycle_length_avg: null, period_length_avg: null, luteal_length: null, track_fertility: 1 });
  assert.equal(s.avgCycle, 28);
  assert.equal(s.avgPeriod, 5);
  assert.equal(s.lutealLength, 14);
  assert.equal(s.source, 'history');
});

// --------------------------------------------------------
// predictCycle
// --------------------------------------------------------

test('predictCycle: ohne Historie → hasData=false', () => {
  const p = predictCycle([], {}, '2026-06-01');
  assert.equal(p.hasData, false);
});

test('predictCycle: Zyklustag, nächste Periode, Eisprung, fruchtbares Fenster', () => {
  // Letzter Start 2026-06-01, Ø-Zyklus 28, Lutealphase 14 → Eisprung 2026-06-15.
  const hist = periods(['2026-04-06', '2026-05-04', '2026-06-01'], 5);
  const p = predictCycle(hist, {}, '2026-06-10');
  assert.equal(p.hasData, true);
  assert.equal(p.lastStart, '2026-06-01');
  assert.equal(p.cycleDay, 10);         // 9 Tage nach Start + 1
  assert.equal(p.avgCycle, 28);
  assert.equal(p.nextStart, '2026-06-29');
  assert.equal(p.daysUntilNext, 19);
  assert.equal(p.ovulationDate, '2026-06-15');
  assert.equal(p.fertileStart, '2026-06-10'); // Eisprung − 5
  assert.equal(p.fertileEnd, '2026-06-15');
  assert.equal(p.phase, PHASE.FERTILE);       // 2026-06-10 liegt im Fenster
});

test('predictCycle: Phase Menstruation an Tag 2', () => {
  const p = predictCycle(periods(['2026-06-01'], 5), {}, '2026-06-02');
  assert.equal(p.phase, PHASE.MENSTRUATION);
  assert.equal(p.cycleDay, 2);
});

test('predictCycle: Eisprungtag + Lutealphase', () => {
  const hist = periods(['2026-06-01'], 5);
  const ov = predictCycle(hist, {}, '2026-06-15');
  assert.equal(ov.phase, PHASE.OVULATION);
  assert.equal(ov.daysUntilOvulation, 0);
  const lut = predictCycle(hist, {}, '2026-06-20');
  assert.equal(lut.phase, PHASE.LUTEAL);
});

test('predictCycle: track_fertility=0 blendet Fruchtbarkeit aus', () => {
  const p = predictCycle(periods(['2026-06-01'], 5), { track_fertility: 0 }, '2026-06-12');
  assert.equal(p.ovulationDate, null);
  assert.equal(p.fertileStart, null);
  assert.notEqual(p.phase, PHASE.FERTILE);
});

test('predictCycle: überfällig, wenn heute nach vorhergesagtem Start', () => {
  const p = predictCycle(periods(['2026-06-01'], 5), {}, '2026-07-05'); // nextStart 06-29
  assert.equal(p.isPredictedOverdue, true);
  assert.ok(p.daysUntilNext < 0);
});

// --------------------------------------------------------
// buildCycleCalendar
// --------------------------------------------------------

test('buildCycleCalendar: 6×7-Raster mit korrektem Monat', () => {
  const cal = buildCycleCalendar('2026-06-15', { periods: periods(['2026-06-01'], 5), weekStartsOn: 1 });
  assert.equal(cal.month, '2026-06');
  assert.equal(cal.weeks.length, 6);
  cal.weeks.forEach((w) => assert.equal(w.length, 7));
  // 1. Juni 2026 ist ein Montag → erste Zelle bei weekStartsOn=1.
  assert.equal(cal.weeks[0][0].dateKey, '2026-06-01');
  assert.equal(cal.weeks[0][0].inMonth, true);
});

test('buildCycleCalendar: geloggte + vorhergesagte Periode, Eisprung, Flow, heute', () => {
  const cal = buildCycleCalendar('2026-06-15', {
    periods: periods(['2026-06-01'], 5),
    logs: [{ log_date: '2026-06-02', flow: 'heavy' }],
    todayKey: '2026-06-15',
    weekStartsOn: 1,
  });
  const flat = cal.weeks.flat();
  const at = (k) => flat.find((c) => c.dateKey === k);

  assert.equal(at('2026-06-01').phase, PHASE.MENSTRUATION);
  assert.equal(at('2026-06-01').predicted, false);
  assert.equal(at('2026-06-02').flow, 'heavy');
  assert.equal(at('2026-06-02').hasLog, true);
  assert.equal(at('2026-06-15').isToday, true);
  // Eisprung des Folgezyklus: nextStart 06-29 − 14 = 06-15.
  assert.equal(at('2026-06-15').phase, PHASE.OVULATION);
  assert.equal(at('2026-06-15').predicted, true);
  // Vorhergesagte Periode ab 06-29.
  assert.equal(at('2026-06-29').phase, PHASE.MENSTRUATION);
  assert.equal(at('2026-06-29').predicted, true);
  // Fruchtbares Fenster (06-10..06-15) enthält 06-11.
  assert.equal(at('2026-06-11').phase, PHASE.FERTILE);
});

// --------------------------------------------------------
// cycleRing
// --------------------------------------------------------

test('cycleRing: Segmente als Brüche 0..1 + Marker', () => {
  const p = predictCycle(periods(['2026-06-01'], 5), {}, '2026-06-08'); // avgCycle 28, avgPeriod 5, luteal 14
  const ring = cycleRing(p);
  assert.equal(ring.total, 28);

  const mens = ring.segments.find((s) => s.phase === PHASE.MENSTRUATION);
  assert.equal(mens.start, 0);
  assert.ok(Math.abs(mens.end - 5 / 28) < 1e-9);

  // Eisprung an Zyklustag 14 (28 − 14).
  const ov = ring.segments.find((s) => s.phase === PHASE.OVULATION);
  assert.ok(Math.abs(ov.start - 13 / 28) < 1e-9);
  assert.ok(Math.abs(ring.ovulationFrac - 13.5 / 28) < 1e-9);

  // Aktueller Tag 8 → Marker bei (8-0.5)/28.
  assert.ok(Math.abs(ring.currentFrac - 7.5 / 28) < 1e-9);
});

test('cycleRing: ohne Fruchtbarkeit nur Menstruations-Segment', () => {
  const p = predictCycle(periods(['2026-06-01'], 5), { track_fertility: 0 }, '2026-06-08');
  const ring = cycleRing(p);
  assert.ok(ring.segments.every((s) => s.phase === PHASE.MENSTRUATION));
  assert.equal(ring.ovulationFrac, null);
});

test('cycleRing: null bei fehlender Vorhersage', () => {
  assert.equal(cycleRing(predictCycle([], {}, '2026-06-01')), null);
  assert.equal(cycleRing(null), null);
});

// --------------------------------------------------------
// Schwangerschafts-Modus (#450): Vorhersagen pausiert
// --------------------------------------------------------

test('pregnancyInfo: aus → active=false, keine Ableitungen', () => {
  const info = pregnancyInfo({ pregnancy_mode: 0, pregnancy_due_date: '2026-12-01' }, '2026-06-01');
  assert.equal(info.active, false);
});

test('pregnancyInfo: aktiv ohne Termin → active=true, hasDue=false', () => {
  const info = pregnancyInfo({ pregnancy_mode: 1, pregnancy_due_date: null }, '2026-06-01');
  assert.equal(info.active, true);
  assert.equal(info.hasDue, false);
  assert.equal(info.dueDate, null);
});

test('pregnancyInfo: SSW/Trimester/Countdown aus Termin (Naegele, 280 Tage)', () => {
  // ET 2026-12-01; „heute" 2026-06-01 → 183 Tage bis Termin, 97 Tage schwanger.
  const info = pregnancyInfo({ pregnancy_mode: 1, pregnancy_due_date: '2026-12-01' }, '2026-06-01');
  assert.equal(info.active, true);
  assert.equal(info.hasDue, true);
  assert.equal(info.daysUntilDue, 183);
  assert.equal(info.gestationalDays, 97);   // 280 − 183
  assert.equal(info.gestWeeks, 13);         // floor(97/7)
  assert.equal(info.gestDays, 6);           // 97 % 7
  assert.equal(info.trimester, 1);          // < 14 Wochen
  assert.equal(info.overdue, false);
  assert.ok(Math.abs(info.progress - 97 / 280) < 1e-9);
});

test('pregnancyInfo: Trimester-Grenzen (2. ab SSW 14, 3. ab SSW 28)', () => {
  const at = (weeks) => pregnancyInfo(
    { pregnancy_mode: 1, pregnancy_due_date: '2026-12-01' },
    // heute = ET − (280 − weeks*7) Tage
    new Date(Date.parse('2026-12-01T00:00:00Z') - (280 - weeks * 7) * 86400000).toISOString().slice(0, 10),
  );
  assert.equal(at(13).trimester, 1);
  assert.equal(at(14).trimester, 2);
  assert.equal(at(27).trimester, 2);
  assert.equal(at(28).trimester, 3);
});

test('pregnancyInfo: über Termin → overdue, gestationalDays gekappt bei 280', () => {
  const info = pregnancyInfo({ pregnancy_mode: 1, pregnancy_due_date: '2026-06-01' }, '2026-06-10');
  assert.equal(info.overdue, true);
  assert.equal(info.daysUntilDue, -9);
  assert.equal(info.gestationalDays, 280);  // geklemmt
  assert.equal(info.progress, 1);
});

test('predictCycle: Schwangerschaft pausiert Vorhersagen (isPregnant, keine Prognose)', () => {
  const hist = periods(['2026-05-01'], 5);
  const p = predictCycle(hist, { pregnancy_mode: 1, pregnancy_due_date: '2027-01-01' }, '2026-06-01');
  assert.equal(p.isPregnant, true);
  assert.equal(p.trackFertility, false);
  assert.equal(p.hasData, true);            // Historie bleibt erhalten
  assert.equal(p.nextStart, undefined);     // keine Vorhersage-Felder
  assert.equal(p.ovulationDate, undefined);
  assert.ok(p.pregnancy.active);
});

test('predictCycle: Schwangerschaft aktiv auch ohne Historie', () => {
  const p = predictCycle([], { pregnancy_mode: 1, pregnancy_due_date: '2027-01-01' }, '2026-06-01');
  assert.equal(p.isPregnant, true);
  assert.equal(p.hasData, false);
  assert.ok(p.pregnancy.active);
});

test('buildCycleCalendar: keine Projektion im Schwangerschafts-Modus', () => {
  const hist = periods(['2026-05-01'], 5);
  const settings = { pregnancy_mode: 1, pregnancy_due_date: '2027-01-01' };
  const cal = buildCycleCalendar('2026-07-15', { periods: hist, settings, todayKey: '2026-06-01' });
  // Juli liegt nach der geloggten Periode → ohne Projektion darf keine Zelle
  // eine (vorhergesagte) Phase tragen.
  const anyPredicted = cal.weeks.flat().some((c) => c.predicted);
  assert.equal(anyPredicted, false);
});

test('cycleRing: null im Schwangerschafts-Modus', () => {
  const p = predictCycle(periods(['2026-05-01'], 5), { pregnancy_mode: 1, pregnancy_due_date: '2027-01-01' }, '2026-06-01');
  assert.equal(cycleRing(p), null);
});
