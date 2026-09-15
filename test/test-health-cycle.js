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
import { readFileSync, readdirSync } from 'node:fs';

const {
  FLOW_LEVELS, FLOW_VALUES, flowLevel,
  SYMPTOM_TYPES, SYMPTOM_VALUES, symptomType,
  INTENSITY_LEVELS, symptomIntensityLabelKey, normalizeSymptomEntries,
  MOOD_TYPES, MOOD_VALUES, moodType,
  PHASE,
  daysBetween, sortPeriodsAsc, cycleGaps, periodLengths,
  cycleStats, predictCycle, buildCycleCalendar, cycleRing, pregnancyInfo,
  detectTemperatureShift,
  cycleLengthTrend, symptomFrequencyByPhase, feelingFrequencyByPhase, normalizeFeelingEntries,
  bbtSeries, symptomIntensityTrend,
  symptomCyclePattern, TYPICAL_CYCLE_RANGE, isTypicalCycleLength,
  predictSymptomLikelihood, projectFutureCycles,
  pmsWindow, periodFlowSummary, periodFlowLoad, periodFlowStats, heavyBleedingSignal,
  PAIN_SYMPTOM_VALUES, painSummary, peakPainDay,
  CERVIX_MUCUS_TYPES, CERVIX_MUCUS_VALUES, TEST_RESULT_VALUES,
  INTIMACY_TYPES, INTIMACY_VALUES,
  CONTRACEPTION_TYPES, CONTRACEPTION_VALUES, HORMONAL_CONTRACEPTION_VALUES,
} = await import('../public/utils/health-cycle.js');

const de = JSON.parse(readFileSync(new URL('../public/locales/de.json', import.meta.url), 'utf8'));
const translate = (key) => key.split('.').reduce((value, segment) => value?.[segment], de);

// Baut eine Historie aus Startdaten mit fester Periodenlänge (Tage).
function periods(starts, periodLen = 5) {
  return starts.map((start, i) => {
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + periodLen - 1);
    return { id: i + 1, start_date: start, end_date: d.toISOString().slice(0, 10) };
  });
}

// Baut Tages-Logs mit Basaltemperatur aus [datum, wert, einheit?]-Tripeln
// (einheit default 'c'). Nur die fuer detectTemperatureShift() relevanten
// Felder.
function tempLogs(entries) {
  return entries.map(([log_date, basal_temp, basal_temp_unit = 'c']) => ({ log_date, basal_temp, basal_temp_unit }));
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
    assert.equal(s.hasIntensity, true);
  }
  assert.ok(SYMPTOM_VALUES.includes('cramps'));
  assert.equal(symptomType('cramps').value, 'cramps');
  assert.equal(symptomType('unknown'), null);
  // Jeder Wert kommt genau einmal vor - eine versehentliche Dopplung beim
  // Erweitern der Liste würde SYMPTOM_VALUES sonst still verkürzt lassen.
  assert.equal(new Set(SYMPTOM_VALUES).size, SYMPTOM_VALUES.length);
  for (const m of MOOD_TYPES) {
    assert.ok(m.labelKey.startsWith('health.cycle.mood.'));
    assert.equal(typeof m.icon, 'string');
  }
  assert.equal(moodType('great').value, 'great');
  assert.equal(moodType('unknown'), null);
});

// CERVIX_MUCUS_TYPES/TEST_RESULT_VALUES/INTIMACY_TYPES/CONTRACEPTION_TYPES
// haben EIN Zuhause hier statt mehrerer Kopien (server/routes/health/cycle.js
// + public/pages/health.js importieren sie).
test('CERVIX_MUCUS_TYPES/INTIMACY_TYPES: vollständige labelKeys, Werte einmalig', () => {
  for (const m of CERVIX_MUCUS_TYPES) assert.ok(m.labelKey.startsWith('health.cycle.mucus.'));
  assert.deepEqual(CERVIX_MUCUS_VALUES, CERVIX_MUCUS_TYPES.map((m) => m.value));
  assert.equal(new Set(CERVIX_MUCUS_VALUES).size, CERVIX_MUCUS_VALUES.length);

  for (const i of INTIMACY_TYPES) assert.ok(i.labelKey.startsWith('health.cycle.intimacy.'));
  assert.deepEqual(INTIMACY_VALUES, INTIMACY_TYPES.map((i) => i.value));
  assert.equal(new Set(INTIMACY_VALUES).size, INTIMACY_VALUES.length);
});

test('TEST_RESULT_VALUES: genau negative/positive', () => {
  assert.deepEqual(TEST_RESULT_VALUES, ['negative', 'positive']);
});

test('CONTRACEPTION_TYPES: HORMONAL_CONTRACEPTION_VALUES ist eine Teilmenge von CONTRACEPTION_VALUES, hormonal-Flag konsistent', () => {
  assert.deepEqual(CONTRACEPTION_VALUES, CONTRACEPTION_TYPES.map((c) => c.value));
  assert.equal(new Set(CONTRACEPTION_VALUES).size, CONTRACEPTION_VALUES.length);
  for (const c of CONTRACEPTION_TYPES) assert.ok(c.labelKey.startsWith('health.cycle.settings.contraceptionOptions.'));

  // Teilmenge ⊆ Gesamtmenge.
  for (const v of HORMONAL_CONTRACEPTION_VALUES) assert.ok(CONTRACEPTION_VALUES.includes(v));
  // Die abgeleitete Teilmenge muss exakt den als hormonal:true markierten Einträgen entsprechen.
  assert.deepEqual(
    [...HORMONAL_CONTRACEPTION_VALUES].sort(),
    CONTRACEPTION_TYPES.filter((c) => c.hormonal).map((c) => c.value).sort(),
  );
  assert.deepEqual([...HORMONAL_CONTRACEPTION_VALUES].sort(), ['hormonal_iud', 'implant', 'injection', 'patch', 'pill', 'ring'].sort());
});

// Quelltext-Guard (source-text check, wie andere Guards dieses Repos): weder
// health.js noch server/routes/health/cycle.js dürfen die geschlossenen
// Wertelisten noch selbst definieren - beide müssen sie aus health-cycle.js
// importieren (EIN Zuhause statt dreier Kopien).
test('Fix 6 Guard: health.js und server/routes/health/cycle.js definieren CERVIX_MUCUS/TEST_RESULT/INTIMACY/CONTRACEPTION-Listen nicht mehr selbst', () => {
  const healthJs = readFileSync(new URL('../public/pages/health.js', import.meta.url), 'utf8');
  const routeJs = readFileSync(new URL('../server/routes/health/cycle.js', import.meta.url), 'utf8');

  assert.match(healthJs, /CERVIX_MUCUS_TYPES,\s*TEST_RESULT_VALUES,\s*INTIMACY_TYPES,\s*CONTRACEPTION_TYPES,/,
    'health.js muss die Typen aus health-cycle.js importieren');
  assert.ok(!/const CERVIX_MUCUS_TYPES = Object\.freeze/.test(healthJs), 'health.js darf CERVIX_MUCUS_TYPES nicht mehr selbst definieren');
  assert.ok(!/const INTIMACY_TYPES = Object\.freeze/.test(healthJs), 'health.js darf INTIMACY_TYPES nicht mehr selbst definieren');
  assert.ok(!/const CONTRACEPTION_TYPES = Object\.freeze/.test(healthJs), 'health.js darf CONTRACEPTION_TYPES nicht mehr selbst definieren');

  assert.match(routeJs, /CERVIX_MUCUS_VALUES,\s*TEST_RESULT_VALUES,\s*INTIMACY_VALUES,\s*CONTRACEPTION_VALUES,/,
    'server/routes/health/cycle.js muss die *_VALUES aus health-cycle.js importieren');
  assert.ok(!/const CERVIX_MUCUS_VALUES = \[/.test(routeJs), 'server-Route darf CERVIX_MUCUS_VALUES nicht mehr selbst definieren');
  assert.ok(!/const CONTRACEPTION_VALUES = \[/.test(routeJs), 'server-Route darf CONTRACEPTION_VALUES nicht mehr selbst definieren');
});

test('INTENSITY_LEVELS: drei Stufen, symptomIntensityLabelKey löst sie auf', () => {
  assert.deepEqual(INTENSITY_LEVELS.map((l) => l.value), [1, 2, 3]);
  for (const l of INTENSITY_LEVELS) assert.ok(l.labelKey.startsWith('health.cycle.intensity.'));
  assert.equal(symptomIntensityLabelKey(1), 'health.cycle.intensity.mild');
  assert.equal(symptomIntensityLabelKey(2), 'health.cycle.intensity.moderate');
  assert.equal(symptomIntensityLabelKey(3), 'health.cycle.intensity.severe');
  assert.equal(symptomIntensityLabelKey(0), null);
  assert.equal(symptomIntensityLabelKey(4), null);
  assert.equal(symptomIntensityLabelKey(undefined), null);
});

test('normalizeSymptomEntries: aktuelles Array-Format mit Intensität', () => {
  const entries = normalizeSymptomEntries([{ key: 'Cramps', intensity: 2 }, { key: 'headache', intensity: '3' }]);
  assert.deepEqual(entries, [{ key: 'cramps', intensity: 2 }, { key: 'headache', intensity: 3 }]);
});

test('normalizeSymptomEntries: dedupliziert nach key, letzter Eintrag gewinnt', () => {
  const entries = normalizeSymptomEntries([{ key: 'cramps', intensity: 1 }, { key: 'cramps', intensity: 3 }]);
  assert.deepEqual(entries, [{ key: 'cramps', intensity: 3 }]);
});

test('normalizeSymptomEntries: ungültige Intensität wird zu null, nicht verworfen', () => {
  assert.deepEqual(normalizeSymptomEntries([{ key: 'cramps', intensity: 9 }]), [{ key: 'cramps', intensity: null }]);
  assert.deepEqual(normalizeSymptomEntries([{ key: 'cramps', intensity: 0 }]), [{ key: 'cramps', intensity: null }]);
  assert.deepEqual(normalizeSymptomEntries([{ key: 'cramps' }]), [{ key: 'cramps', intensity: null }]);
  assert.deepEqual(normalizeSymptomEntries([{ key: 'cramps', intensity: 'nope' }]), [{ key: 'cramps', intensity: null }]);
});

test('normalizeSymptomEntries: unlesbare/ungültige Schlüssel fallen still raus', () => {
  assert.deepEqual(normalizeSymptomEntries([{ key: 'bad key!' }, { key: '' }, { key: 'a'.repeat(33) }]), []);
});

// Abwärtskompatibilität: vor Phase 2 gespeicherte Werte kamen als Komma-String
// oder reines String-Array, beide ohne Intensität.
test('normalizeSymptomEntries: Komma-String und String-Array (Vor-Phase-2-Format)', () => {
  assert.deepEqual(normalizeSymptomEntries('cramps,headache,cramps'),
    [{ key: 'cramps', intensity: null }, { key: 'headache', intensity: null }]);
  assert.deepEqual(normalizeSymptomEntries(['cramps', 'headache']),
    [{ key: 'cramps', intensity: null }, { key: 'headache', intensity: null }]);
});

test('normalizeSymptomEntries: leer/null/undefined ergibt ein leeres Array', () => {
  assert.deepEqual(normalizeSymptomEntries(undefined), []);
  assert.deepEqual(normalizeSymptomEntries(null), []);
  assert.deepEqual(normalizeSymptomEntries(''), []);
  assert.deepEqual(normalizeSymptomEntries([]), []);
});

// MOOD_VALUES ist die Auswahl-Reihenfolge der Stimmungs-Chips, nicht nur eine
// Menge: von "great" nach "anxious". Wie bei FLOW_VALUES/SYMPTOM_VALUES hält der
// Guard die abgeleitete Liste an ihre Presets gebunden.
test('MOOD_VALUES: aus MOOD_TYPES abgeleitet, feste Reihenfolge', () => {
  assert.deepEqual(MOOD_VALUES, MOOD_TYPES.map((m) => m.value));
  assert.deepEqual(MOOD_VALUES, ['great', 'good', 'neutral', 'sensitive', 'sad', 'irritable', 'anxious']);
  assert.equal(new Set(MOOD_VALUES).size, MOOD_VALUES.length);
  assert.ok(Object.isFrozen(MOOD_VALUES));
});

// Die startsWith-Prüfungen oben belegen nur das Präfix. Ein Preset ohne
// Übersetzung würde dort durchrutschen und erst in der UI als roher Key auffallen.
test('jeder Zyklus-Preset-labelKey ist in de.json übersetzt', () => {
  const presets = [...FLOW_LEVELS, ...SYMPTOM_TYPES, ...MOOD_TYPES];
  for (const p of presets) {
    assert.equal(typeof translate(p.labelKey), 'string', `${p.labelKey} fehlt in de.json`);
  }
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
  // 4 Perioden -> 3 Lücken, erreicht MIN_HISTORY_GAPS.
  const s = cycleStats(periods(['2026-01-01', '2026-01-29', '2026-02-26', '2026-03-26'], 5));
  assert.equal(s.count, 4);
  assert.equal(s.avgCycle, 28);
  assert.equal(s.avgPeriod, 5);
  assert.equal(s.regular, true);
  assert.equal(s.source, 'history');
});

test('cycleStats: unter MIN_HISTORY_GAPS bleibt es beim Default, aber mit source "insufficient_history"', () => {
  const noHistory = cycleStats([]);
  assert.equal(noHistory.avgCycle, 28);
  assert.equal(noHistory.source, 'default');

  const oneGap = cycleStats(periods(['2026-01-01', '2026-01-29'], 5)); // 1 Lücke
  assert.equal(oneGap.avgCycle, 28); // Default-Fallback, NICHT der (zufällig gleiche) Ein-Punkt-Mittelwert
  assert.equal(oneGap.source, 'insufficient_history');

  const twoGaps = cycleStats(periods(['2026-01-01', '2026-01-31', '2026-03-01'], 5)); // 30/29, noch unter der Schwelle
  assert.equal(twoGaps.avgCycle, 28); // weiterhin Default, nicht der abgeleitete ~29.5-Mittelwert
  assert.equal(twoGaps.source, 'insufficient_history');

  const threeGaps = cycleStats(periods(['2026-01-01', '2026-01-31', '2026-03-01', '2026-04-01'], 5)); // 30/29/31
  assert.equal(threeGaps.avgCycle, 30); // jetzt greift der abgeleitete Mittelwert
  assert.equal(threeGaps.source, 'history');
});

test('cycleStats: manuelle Einstellung gewinnt unabhängig von der Lücken-Anzahl', () => {
  const s = cycleStats(periods(['2026-01-01', '2026-01-29'], 5), { cycle_length_avg: 35 }); // nur 1 Lücke
  assert.equal(s.avgCycle, 35);
  assert.equal(s.source, 'settings');
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
  const s = cycleStats(periods(['2026-01-01', '2026-01-29', '2026-02-26', '2026-03-26'], 5),
    { cycle_length_avg: null, period_length_avg: null, luteal_length: null, track_fertility: 1 });
  assert.equal(s.avgCycle, 28);
  assert.equal(s.avgPeriod, 5);
  assert.equal(s.lutealLength, 14);
  assert.equal(s.source, 'history');
});

// A-3: eine implausible Lücke (Ueberlappung/Doppel-Erfassung ODER ein Start
// in der Zukunft) darf den Mittelwert/die Schwankung nicht verzerren.
// Historie (Starts): 01-01, 01-29 (Lücke 28, plausibel), 02-01 (Lücke zu
// 01-29: 3 Tage - unplausibel, < 10), 03-01 (Lücke zu 02-01: 28, plausibel),
// 03-29 (Lücke zu 03-01: 28, plausibel), 04-20 (Lücke zu 03-29: 22 Tage -
// an sich plausibel, ABER 04-20 liegt NACH "heute" 04-01, zählt also nicht
// als abgeschlossene Lücke). Bleiben 3 plausible Lücken: 28/28/28.
test('cycleGaps/cycleStats: unplausible Lücken (Ueberlappung < 10 Tage, Start in der Zukunft) werden ausgeschlossen', () => {
  const hist = periods([
    '2026-01-01', '2026-01-29', '2026-02-01', '2026-03-01', '2026-03-29', '2026-04-20',
  ], 3);
  const today = '2026-04-01';

  assert.deepEqual(cycleGaps(hist, today), [28, 28, 28]);

  const s = cycleStats(hist, {}, today);
  assert.equal(s.excludedGaps, 2);       // die 3-Tage- und die Zukunfts-Lücke
  assert.equal(s.plausibleGapCount, 3);
  assert.equal(s.avgCycle, 28);          // Mittel aus [28,28,28] - NICHT durch die 3-Tage-Lücke verzerrt
  assert.equal(s.minCycle, 28);
  assert.equal(s.maxCycle, 28);
  assert.equal(s.variation, 0);
  assert.equal(s.regular, true);
  assert.equal(s.source, 'history');
});

test('cycleGaps: ohne todayKey-Argument Default "heute" - unplausible Lücken bleiben in beiden Fällen aussen vor', () => {
  // Alle Test-Daten liegen (Stand des Depots) klar in der Vergangenheit -
  // dieselbe 3-Tage-Lücke wird unabhängig vom Referenzdatum ausgeschlossen.
  const hist = periods(['2026-01-01', '2026-01-29', '2026-02-01', '2026-03-01'], 3);
  assert.deepEqual(cycleGaps(hist, '2026-06-01'), [28, 28]);
});

// Eine harte 90-Tage-Obergrenze schnitt bislang JEDE
// Lücke einer Person mit konsistent langen (~95-100 Tage, PCOS-/oligomeno-
// rrhoe-typischen) Zyklen weg - der Mittelwert fiel trotz konsistenter
// Historie auf den 28-Tage-Default zurück. Reichen PLAUSIBEL (10-90 Tage)
// allein die MIN_HISTORY_GAPS-Schwelle nicht, aber PLAUSIBEL+LANG (90-365
// Tage) zusammen, werden auch die langen Lücken für den Mittelwert gerettet.
test('cycleStats: konsistente 97-Tage-Zyklen werden gerettet (avgCycle 60 - Clamp-Obergrenze, source "history")', () => {
  const hist = periods(['2020-01-01', '2020-04-07', '2020-07-13', '2020-10-18'], 5); // 3× 97 Tage
  const today = '2020-10-28';
  const s = cycleStats(hist, {}, today);
  assert.equal(s.avgCycle, 60); // clampInt(97, 15, 60) - reproduziert denselben Wert wie vor der 90-Tage-Grenze
  assert.equal(s.source, 'history');
  assert.equal(s.excludedGaps, 0); // alle drei langen Lücken wurden gerettet, keine bleibt ausgeschlossen
  assert.equal(s.plausibleGapCount, 3);
});

test('cycleStats: eine einzelne lange Lücke bleibt ausgeschlossen, wenn die plausiblen Lücken die Schwelle allein schon erreichen', () => {
  // Drei 28-Tage-Lücken erreichen MIN_HISTORY_GAPS (3) bereits allein - die
  // vierte, 200-Tage-Lücke ist dann weiterhin ein Ausreisser, kein Signal für
  // einen generell langen Zyklus, und bleibt ausgeschlossen.
  const hist = periods(['2020-01-01', '2020-01-29', '2020-02-26', '2020-03-25', '2020-10-11'], 5);
  const today = '2020-10-21';
  const s = cycleStats(hist, {}, today);
  assert.equal(s.avgCycle, 28);
  assert.equal(s.excludedGaps, 1); // die 200-Tage-Lücke - NICHT gerettet
  assert.equal(s.plausibleGapCount, 3);
});

test('cycleStats: eine zu kurze (< 10 Tage) Lücke bleibt IMMER ausgeschlossen, auch wenn die Rettung für lange Lücken greift', () => {
  // Lückenfolge 97/3/97/97: die drei langen Lücken reichen zusammen für die
  // Rettung (MIN_HISTORY_GAPS=3) - die 3-Tage-Lücke dazwischen ist trotzdem
  // NIE rettbar (Ueberlappung/Doppel-Erfassung, nicht "langer Zyklus").
  const hist = periods(['2020-01-01', '2020-04-07', '2020-04-10', '2020-07-16', '2020-10-21'], 5);
  const today = '2020-10-31';
  const s = cycleStats(hist, {}, today);
  assert.equal(s.avgCycle, 60); // Mittel aus den drei geretteten 97-Tage-Lücken, clamped
  assert.equal(s.excludedGaps, 1); // nur die 3-Tage-Lücke - die drei langen wurden gerettet
  assert.equal(s.plausibleGapCount, 3);
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

// Hormonelle Verhütung (Untermenge, siehe server/routes/health/cycle.js
// CONTRACEPTION_VALUES) schaltet Eisprung/fruchtbares Fenster ab wie
// track_fertility=0, dokumentiert aber zusätzlich WARUM.
test('predictCycle: hormonelle Verhütung unterdrückt die Fruchtbarkeits-Vorhersage, mit Grund-Flag', () => {
  const hist = periods(['2026-06-01'], 5); // Ø-Zyklus 28 (Default), Luteal 14 -> kalendarisch Eisprung 2026-06-15
  const pill = predictCycle(hist, { contraception: 'pill' }, '2026-06-10');
  assert.equal(pill.trackFertility, false);
  assert.equal(pill.ovulationDate, null);
  assert.equal(pill.fertileStart, null);
  assert.equal(pill.fertileEnd, null);
  assert.equal(pill.fertilitySuppressed, 'contraception');
  assert.notEqual(pill.phase, PHASE.FERTILE);
});

test('predictCycle: nicht-hormonelle/unbekannte Verhütung ändert nichts', () => {
  const hist = periods(['2026-06-01'], 5);
  const copper = predictCycle(hist, { contraception: 'copper_iud' }, '2026-06-10');
  assert.equal(copper.trackFertility, true);
  assert.equal(copper.fertilitySuppressed, null);
  assert.equal(copper.ovulationDate, '2026-06-15');

  const none = predictCycle(hist, { contraception: null }, '2026-06-10');
  assert.equal(none.trackFertility, true);
  assert.equal(none.fertilitySuppressed, null);

  const unset = predictCycle(hist, {}, '2026-06-10');
  assert.equal(unset.fertilitySuppressed, null);
});

test('cycleRing: hormonelle Verhütung - keine Eisprung-/Fruchtbarkeits-Segmente (dieselbe Route wie track_fertility)', () => {
  const p = predictCycle(periods(['2026-06-01'], 5), { contraception: 'hormonal_iud' }, '2026-06-08');
  const ring = cycleRing(p);
  assert.ok(ring.segments.every((s) => s.phase === PHASE.MENSTRUATION));
  assert.equal(ring.ovulationFrac, null);
});

// Perimenopause-Modus: eine Spanne aus dem TATSAECHLICHEN Min/Max der
// juengsten plausiblen Lücken, zusätzlich zum unveränderten Mittelwert-
// `nextStart`. Historie: Lücken 24 (01-01 -> 01-25), 32 (01-25 -> 02-26), 28
// (02-26 -> 03-26) - Ø (24+32+28)/3 = 28, Variation 32-24=8 (> 7, wäre ohne
// den Modus "unregelmäßig").
test('predictCycle: Perimenopause-Modus liefert eine Min/Max-Spanne, regular wird unterdrückt', () => {
  const hist = periods(['2026-01-01', '2026-01-25', '2026-02-26', '2026-03-26'], 5);
  const p = predictCycle(hist, { perimenopause_mode: 1 }, '2026-04-01');
  assert.equal(p.perimenopause, true);
  assert.equal(p.stats.regular, null);
  assert.equal(p.stats.minCycle, 24);
  assert.equal(p.stats.maxCycle, 32);
  assert.equal(p.nextStart, '2026-04-23');           // unverändert: Mittelwert-basiert (28 Tage)
  assert.deepEqual(p.nextStartRange, { min: '2026-04-19', max: '2026-04-27' }); // lastStart 03-26 + 24 / + 32
});

test('predictCycle: Perimenopause-Modus ohne genug plausible Lücken - perimenopause=true, aber keine Spanne', () => {
  const hist = periods(['2026-01-01', '2026-01-29'], 5); // nur 1 Lücke, < MIN_HISTORY_GAPS
  const p = predictCycle(hist, { perimenopause_mode: 1 }, '2026-02-01');
  assert.equal(p.perimenopause, true);
  assert.equal(p.nextStartRange, null);
});

test('predictCycle: ohne Perimenopause-Modus bleibt regular normal berechnet', () => {
  const hist = periods(['2026-01-01', '2026-01-25', '2026-02-26', '2026-03-26'], 5);
  const p = predictCycle(hist, {}, '2026-04-01');
  assert.equal(p.perimenopause, false);
  assert.equal(p.nextStartRange, null);
  assert.equal(p.stats.regular, false); // Variation 8 > 7
});

// --------------------------------------------------------
// detectTemperatureShift (BBT, Phase 3)
// --------------------------------------------------------

test('detectTemperatureShift: klarer Anstieg nach 6 niedrigen Werten wird erkannt', () => {
  const logs = tempLogs([
    ['2026-06-01', 36.30], ['2026-06-02', 36.30], ['2026-06-03', 36.30],
    ['2026-06-04', 36.30], ['2026-06-05', 36.30], ['2026-06-06', 36.30],
    ['2026-06-07', 36.55], ['2026-06-08', 36.60], ['2026-06-09', 36.58],
  ]);
  assert.equal(detectTemperatureShift(logs, '2026-06-01'), '2026-06-07');
});

test('detectTemperatureShift: zu wenig Messwerte (< 6 Basislinie + 3 Anstieg) → null', () => {
  const logs = tempLogs([
    ['2026-06-01', 36.30], ['2026-06-02', 36.30], ['2026-06-03', 36.30],
    ['2026-06-04', 36.30], ['2026-06-05', 36.30], ['2026-06-06', 36.30],
    ['2026-06-07', 36.55], ['2026-06-08', 36.60],
  ]);
  assert.equal(detectTemperatureShift(logs, '2026-06-01'), null);
});

test('detectTemperatureShift: kein Anstieg (flache Reihe) → null', () => {
  const logs = tempLogs(Array.from({ length: 9 }, (_, i) => [`2026-06-${String(i + 1).padStart(2, '0')}`, 36.30]));
  assert.equal(detectTemperatureShift(logs, '2026-06-01'), null);
});

// Ein einzelner Ausreisser-Tag unter der Schwelle laesst BEIDE benachbarten
// Kandidaten-Fenster scheitern - bewusst keine Ausnahme-Regel (siehe
// Modulkommentar bei detectTemperatureShift).
test('detectTemperatureShift: ein Ausreisser-Tag verhindert die Erkennung (keine Rauschtoleranz)', () => {
  const logs = tempLogs([
    ['2026-06-01', 36.30], ['2026-06-02', 36.30], ['2026-06-03', 36.30],
    ['2026-06-04', 36.30], ['2026-06-05', 36.30], ['2026-06-06', 36.30],
    ['2026-06-07', 36.55], ['2026-06-08', 36.15], ['2026-06-09', 36.60], ['2026-06-10', 36.65],
  ]);
  assert.equal(detectTemperatureShift(logs, '2026-06-01'), null);
});

test('detectTemperatureShift: rechnet Fahrenheit korrekt in Celsius um, auch gemischt mit Celsius-Werten', () => {
  // 97.5°F ≈ 36.39°C (Basislinie), 98.0°F ≈ 36.67°C (Anstieg, Δ ≈ 0.28°C ≥ 0,2).
  const allFahrenheit = tempLogs([
    ['2026-06-01', 97.5, 'f'], ['2026-06-02', 97.5, 'f'], ['2026-06-03', 97.5, 'f'],
    ['2026-06-04', 97.5, 'f'], ['2026-06-05', 97.5, 'f'], ['2026-06-06', 97.5, 'f'],
    ['2026-06-07', 98.0, 'f'], ['2026-06-08', 98.0, 'f'], ['2026-06-09', 98.0, 'f'],
  ]);
  assert.equal(detectTemperatureShift(allFahrenheit, '2026-06-01'), '2026-06-07');

  // Basislinie in Celsius, Anstieg in Fahrenheit (97.9°F ≈ 36.61°C, Δ ≈ 0.31°C).
  const mixedUnits = tempLogs([
    ['2026-06-01', 36.30], ['2026-06-02', 36.30], ['2026-06-03', 36.30],
    ['2026-06-04', 36.30], ['2026-06-05', 36.30], ['2026-06-06', 36.30],
    ['2026-06-07', 97.9, 'f'], ['2026-06-08', 97.9, 'f'], ['2026-06-09', 97.9, 'f'],
  ]);
  assert.equal(detectTemperatureShift(mixedUnits, '2026-06-01'), '2026-06-07');
});

test('detectTemperatureShift: Messwerte vor cycleStart zählen nicht zur Basislinie', () => {
  const logs = tempLogs([
    ['2026-05-20', 40.00], // extremer Wert vor Zyklusbeginn - darf die Basislinie nicht verzerren
    ['2026-06-01', 36.30], ['2026-06-02', 36.30], ['2026-06-03', 36.30],
    ['2026-06-04', 36.30], ['2026-06-05', 36.30], ['2026-06-06', 36.30],
    ['2026-06-07', 36.55], ['2026-06-08', 36.60], ['2026-06-09', 36.58],
  ]);
  assert.equal(detectTemperatureShift(logs, '2026-06-01'), '2026-06-07');
});

test('detectTemperatureShift: Tage ohne basal_temp werden übersprungen, kein Absturz', () => {
  const logs = [
    ...tempLogs([['2026-05-30', 36.30], ['2026-05-31', 36.30], ['2026-06-01', 36.30], ['2026-06-02', 36.30]]),
    { log_date: '2026-06-03', basal_temp: null, basal_temp_unit: null },
    { log_date: '2026-06-04', flow: 'light' }, // basal_temp fehlt ganz
    ...tempLogs([['2026-06-05', 36.30], ['2026-06-06', 36.30],
      ['2026-06-07', 36.55], ['2026-06-08', 36.60], ['2026-06-09', 36.58]]),
  ];
  // 6 gültige Basislinien-Werte (05-30, 05-31, 06-01, 06-02, 06-05, 06-06),
  // die beiden Lücken (null, fehlendes Feld) übersprungen, dann der Anstieg.
  assert.equal(detectTemperatureShift(logs, '2026-05-30'), '2026-06-07');
});

test('detectTemperatureShift: leere/fehlende Eingabe → null, kein Absturz', () => {
  assert.equal(detectTemperatureShift([], '2026-06-01'), null);
  assert.equal(detectTemperatureShift(null, '2026-06-01'), null);
  assert.equal(detectTemperatureShift(undefined, '2026-06-01'), null);
});

test('predictCycle: bestätigter Temperaturanstieg ersetzt das kalendarische Eisprungdatum', () => {
  const hist = periods(['2026-04-06', '2026-05-04', '2026-06-01'], 5); // Ø-Zyklus 28, Lutealphase 14 → kalendarisch 06-15
  const logs = tempLogs([
    ['2026-06-01', 36.30], ['2026-06-02', 36.30], ['2026-06-03', 36.30],
    ['2026-06-04', 36.30], ['2026-06-05', 36.30], ['2026-06-06', 36.30],
    ['2026-06-07', 36.55], ['2026-06-08', 36.60], ['2026-06-09', 36.58],
  ]);
  const withoutTemps = predictCycle(hist, {}, '2026-06-10');
  assert.equal(withoutTemps.ovulationDate, '2026-06-15');
  assert.equal(withoutTemps.ovulationConfirmed, false);

  const withTemps = predictCycle(hist, {}, '2026-06-10', logs);
  assert.equal(withTemps.ovulationDate, '2026-06-07');
  assert.equal(withTemps.ovulationConfirmed, true);
  // Fruchtbares Fenster folgt dem BESTÄTIGTEN Datum, nicht mehr dem kalendarischen.
  assert.equal(withTemps.fertileEnd, '2026-06-07');
});

test('predictCycle: track_fertility=0 ruft erst gar keine Temperatur-Erkennung auf', () => {
  const hist = periods(['2026-04-06', '2026-05-04', '2026-06-01'], 5);
  const logs = tempLogs([
    ['2026-06-01', 36.30], ['2026-06-02', 36.30], ['2026-06-03', 36.30],
    ['2026-06-04', 36.30], ['2026-06-05', 36.30], ['2026-06-06', 36.30],
    ['2026-06-07', 36.55], ['2026-06-08', 36.60], ['2026-06-09', 36.58],
  ]);
  const p = predictCycle(hist, { track_fertility: 0 }, '2026-06-10', logs);
  assert.equal(p.ovulationDate, null);
  assert.equal(p.ovulationConfirmed, false);
});

test('cycleRing: bestätigter Eisprung positioniert den Marker am tatsächlichen Zyklustag, nicht am kalendarischen', () => {
  const hist = periods(['2026-04-06', '2026-05-04', '2026-06-01'], 5);
  const logs = tempLogs([
    ['2026-06-01', 36.30], ['2026-06-02', 36.30], ['2026-06-03', 36.30],
    ['2026-06-04', 36.30], ['2026-06-05', 36.30], ['2026-06-06', 36.30],
    ['2026-06-07', 36.55], ['2026-06-08', 36.60], ['2026-06-09', 36.58],
  ]);
  const prediction = predictCycle(hist, {}, '2026-06-10', logs);
  const ring = cycleRing(prediction);
  assert.equal(ring.ovulationConfirmed, true);
  // Zyklustag 7 (06-07 ist der 7. Tag ab 06-01) von 28 Tagen Gesamtlaenge.
  assert.equal(ring.ovulationFrac, (7 - 0.5) / 28);
});

// --------------------------------------------------------
// Trend-Aggregationen (Phase 4)
// --------------------------------------------------------

test('cycleLengthTrend: eine Lücke je Folgeperiode, mit deren Datum, über die GESAMTE Historie', () => {
  const hist = periods(['2026-01-01', '2026-01-29', '2026-03-05', '2026-04-02'], 5); // 28/35/28
  assert.deepEqual(cycleLengthTrend(hist), [
    { date: '2026-01-29', days: 28 },
    { date: '2026-03-05', days: 35 },
    { date: '2026-04-02', days: 28 },
  ]);
});

test('cycleLengthTrend: unter 2 Perioden gibt es keine Lücke', () => {
  assert.deepEqual(cycleLengthTrend([]), []);
  assert.deepEqual(cycleLengthTrend(periods(['2026-01-01'])), []);
});

// --------------------------------------------------------
// isTypicalCycleLength (Phase 4d)
// --------------------------------------------------------

test('isTypicalCycleLength: Grenzfälle bei 24 und 38 Tagen (jeweils inklusive)', () => {
  assert.equal(TYPICAL_CYCLE_RANGE.min, 24);
  assert.equal(TYPICAL_CYCLE_RANGE.max, 38);
  assert.equal(isTypicalCycleLength(23), false);
  assert.equal(isTypicalCycleLength(24), true);
  assert.equal(isTypicalCycleLength(38), true);
  assert.equal(isTypicalCycleLength(39), false);
});

test('isTypicalCycleLength: nicht-endliche Werte sind nie typisch', () => {
  assert.equal(isTypicalCycleLength(NaN), false);
  assert.equal(isTypicalCycleLength(undefined), false);
  assert.equal(isTypicalCycleLength(null), false);
});

test('bbtSeries: alle Messungen chronologisch, unabhängig vom Zyklus (anders als detectTemperatureShift)', () => {
  const logs = tempLogs([['2026-06-02', 36.40], ['2026-06-01', 36.30], ['2026-05-15', 37.00, 'f']]);
  // 37.00°F ≈ 2.78°C
  assert.deepEqual(bbtSeries(logs), [
    { date: '2026-05-15', celsius: (37.00 - 32) * 5 / 9 },
    { date: '2026-06-01', celsius: 36.30 },
    { date: '2026-06-02', celsius: 36.40 },
  ]);
});

test('bbtSeries: leer ohne Messungen, überspringt Logs ohne basal_temp', () => {
  assert.deepEqual(bbtSeries([]), []);
  assert.deepEqual(bbtSeries([{ log_date: '2026-06-01', flow: 'light' }]), []);
});

test('symptomFrequencyByPhase: klassifiziert Menstruation/Luteal/Sonstige je nach TATSÄCHLICHEM Zyklus, sortiert nach Gesamthäufigkeit', () => {
  // Zyklus 1: 2026-05-01..05-05 Periode, nächste Periode 2026-05-29 → Luteal
  // (Lutealphase 14, Standard) ab 2026-05-15.
  const hist = periods(['2026-05-01', '2026-05-29'], 5);
  const logs = [
    { log_date: '2026-05-02', symptoms: [{ key: 'cramps', intensity: 2 }] }, // Menstruation
    { log_date: '2026-05-20', symptoms: [{ key: 'headache' }] }, // Luteal
    { log_date: '2026-05-10', symptoms: [{ key: 'cramps' }, { key: 'fatigue' }] }, // Sonstige (follikulär)
    { log_date: '2026-04-15', symptoms: [{ key: 'nausea' }] }, // vor der ersten Periode -> kein bekannter Zyklus, übersprungen
  ];
  const freq = symptomFrequencyByPhase(logs, hist, {});
  assert.deepEqual(freq, [
    { key: 'cramps', menstruation: 1, luteal: 0, other: 1, total: 2, avgIntensity: 2 },
    { key: 'headache', menstruation: 0, luteal: 1, other: 0, total: 1, avgIntensity: null },
    { key: 'fatigue', menstruation: 0, luteal: 0, other: 1, total: 1, avgIntensity: null },
  ]);
});

test('symptomFrequencyByPhase: der letzte (offene) Zyklus fällt auf die Ø-Zykluslänge zurück', () => {
  // Nur EINE Periode - keine "nächste", also nextStart = start + avgCycle (Default 28,
  // da keine Historie für einen abgeleiteten Wert reicht).
  const hist = periods(['2026-06-01'], 5);
  const logs = [{ log_date: '2026-06-20', symptoms: [{ key: 'fatigue' }] }]; // Luteal: ab 06-01+28-14=06-15
  assert.deepEqual(symptomFrequencyByPhase(logs, hist, {}), [
    { key: 'fatigue', menstruation: 0, luteal: 1, other: 0, total: 1, avgIntensity: null },
  ]);
});

test('symptomFrequencyByPhase: ohne jede Periode gibt es keine Klassifikation', () => {
  assert.deepEqual(symptomFrequencyByPhase([{ log_date: '2026-06-01', symptoms: [{ key: 'cramps' }] }], [], {}), []);
});

test('symptomFrequencyByPhase: avgIntensity mittelt nur gradierte Vorkommen, ignoriert ungradierte', () => {
  const hist = periods(['2026-05-01', '2026-05-29'], 5);
  const logs = [
    { log_date: '2026-05-02', symptoms: [{ key: 'cramps', intensity: 1 }] },
    { log_date: '2026-05-10', symptoms: [{ key: 'cramps' }] }, // ungradiert - zählt nicht ins Mittel
    { log_date: '2026-05-20', symptoms: [{ key: 'cramps', intensity: 3 }] },
  ];
  const freq = symptomFrequencyByPhase(logs, hist, {});
  assert.equal(freq[0].key, 'cramps');
  assert.equal(freq[0].total, 3);
  assert.equal(freq[0].avgIntensity, 2); // Mittel aus [1, 3], die ungradierte Auswahl bleibt aussen vor.
});

test('symptomFrequencyByPhase: avgIntensity ist null, wenn KEINE Auswahl gradiert wurde', () => {
  const hist = periods(['2026-05-01'], 5);
  const logs = [{ log_date: '2026-05-02', symptoms: [{ key: 'bloating' }] }];
  const freq = symptomFrequencyByPhase(logs, hist, {});
  assert.equal(freq[0].avgIntensity, null);
});

// --------------------------------------------------------
// symptomIntensityTrend (Phase 4b)
// --------------------------------------------------------

test('symptomIntensityTrend: nur gradierte Vorkommen DIESES Symptoms, chronologisch', () => {
  const logs = [
    { log_date: '2026-05-10', symptoms: [{ key: 'cramps', intensity: 3 }] },
    { log_date: '2026-05-02', symptoms: [{ key: 'cramps', intensity: 1 }] },
    { log_date: '2026-05-05', symptoms: [{ key: 'cramps' }] },              // ungradiert -> ausgeschlossen
    { log_date: '2026-05-06', symptoms: [{ key: 'headache', intensity: 2 }] }, // anderes Symptom -> ausgeschlossen
  ];
  assert.deepEqual(symptomIntensityTrend(logs, 'cramps'), [
    { date: '2026-05-02', intensity: 1 },
    { date: '2026-05-10', intensity: 3 },
  ]);
});

test('symptomIntensityTrend: leer ohne Logs oder ohne Treffer für das Symptom', () => {
  assert.deepEqual(symptomIntensityTrend([], 'cramps'), []);
  assert.deepEqual(symptomIntensityTrend([{ log_date: '2026-05-01', symptoms: [{ key: 'headache', intensity: 2 }] }], 'cramps'), []);
});

// --------------------------------------------------------
// symptomCyclePattern (Phase 4c)
// --------------------------------------------------------

test('symptomCyclePattern: Zyklustag-Nummerierung, juengster Zyklus zuerst, mostCommonPhase', () => {
  const hist = periods(['2026-05-01', '2026-05-29', '2026-06-26'], 5);
  const logs = [
    { log_date: '2026-05-02', symptoms: [{ key: 'cramps' }] }, // Zyklus 1, Tag 2, Menstruation
    { log_date: '2026-05-31', symptoms: [{ key: 'cramps' }] }, // Zyklus 2, Tag 3, Menstruation
  ];
  const pattern = symptomCyclePattern(logs, hist, {}, 'cramps');
  assert.equal(pattern.totalCount, 3);
  assert.equal(pattern.occurredCount, 2);
  assert.equal(pattern.mostCommonPhase, PHASE.MENSTRUATION);
  // Juengster Zyklus (2026-06-26, keine Periode danach geloggt) zuerst.
  assert.deepEqual(pattern.cycles.map((c) => c.cycleStart), ['2026-06-26', '2026-05-29', '2026-05-01']);
  assert.deepEqual(pattern.cycles[0].occurredOnDays, []);
  assert.deepEqual(pattern.cycles[1].occurredOnDays, [3]);
  assert.deepEqual(pattern.cycles[2].occurredOnDays, [2]);
});

test('symptomCyclePattern: mehrere Vorkommen im selben Zyklus zaehlen den Zyklus trotzdem nur einmal', () => {
  const hist = periods(['2026-05-01', '2026-05-29'], 5);
  const logs = [
    { log_date: '2026-05-04', symptoms: [{ key: 'cramps' }] },
    { log_date: '2026-05-02', symptoms: [{ key: 'cramps' }] },
  ];
  const pattern = symptomCyclePattern(logs, hist, {}, 'cramps');
  assert.equal(pattern.occurredCount, 1);
  assert.equal(pattern.totalCount, 2);
  assert.deepEqual(pattern.cycles[1].occurredOnDays, [2, 4]); // sortiert, nicht Log-Reihenfolge
});

test('symptomCyclePattern: Gleichstand zwischen Phasen loest sich per fester Prioritaet Menstruation > Luteal > Sonstige', () => {
  const hist = periods(['2026-05-01', '2026-05-29'], 5);
  const logs = [
    { log_date: '2026-05-02', symptoms: [{ key: 'cramps' }] }, // Menstruation
    { log_date: '2026-05-20', symptoms: [{ key: 'cramps' }] }, // Luteal (ab 2026-05-15)
  ];
  const pattern = symptomCyclePattern(logs, hist, {}, 'cramps');
  assert.equal(pattern.mostCommonPhase, PHASE.MENSTRUATION);
});

test('symptomCyclePattern: maxCycles deckelt die Anzahl zurueckgegebener Zyklen', () => {
  const hist = periods(['2026-03-01', '2026-03-29', '2026-04-26', '2026-05-24'], 5);
  const pattern = symptomCyclePattern([], hist, {}, 'cramps', 2);
  assert.equal(pattern.cycles.length, 2);
  assert.equal(pattern.totalCount, 2);
  assert.deepEqual(pattern.cycles.map((c) => c.cycleStart), ['2026-05-24', '2026-04-26']);
});

test('symptomCyclePattern: nie geloggtes Symptom - occurredCount 0, Zyklen bleiben konsistent geformt (kein undefined)', () => {
  const hist = periods(['2026-05-01', '2026-05-29'], 5);
  const pattern = symptomCyclePattern([{ log_date: '2026-05-02', symptoms: [{ key: 'headache' }] }], hist, {}, 'cramps');
  assert.equal(pattern.occurredCount, 0);
  assert.equal(pattern.mostCommonPhase, null);
  pattern.cycles.forEach((c) => assert.deepEqual(c.occurredOnDays, []));
});

test('symptomCyclePattern: phaseByDay klassifiziert jeden Zyklustag - Menstruation, Luteal, Sonstige', () => {
  // Zyklus 2026-05-01..05-05 Periode (Tag 1-5 Menstruation), naechste Periode
  // 2026-05-29 -> Luteal (14 Tage Standard) ab Tag 15 (2026-05-15).
  const hist = periods(['2026-05-01', '2026-05-29'], 5);
  const pattern = symptomCyclePattern([], hist, {}, 'cramps');
  const cyc = pattern.cycles.find((c) => c.cycleStart === '2026-05-01');
  assert.equal(cyc.cycleLength, 28);
  assert.equal(cyc.phaseByDay.length, 28);
  assert.deepEqual(cyc.phaseByDay.slice(0, 5), Array(5).fill(PHASE.MENSTRUATION));
  assert.equal(cyc.phaseByDay[5], 'other');  // Tag 6, follikulär
  assert.equal(cyc.phaseByDay[13], 'other'); // Tag 14, letzter Tag vor Luteal
  assert.equal(cyc.phaseByDay[14], PHASE.LUTEAL); // Tag 15
  assert.equal(cyc.phaseByDay[27], PHASE.LUTEAL); // Tag 28, letzter Tag des Zyklus
});

test('symptomCyclePattern: typicalDaysBeforePeriod - haeufigster Wert unter den lutealen Vorkommen, ab zwei Zyklen', () => {
  const hist = periods(['2026-01-01', '2026-01-29', '2026-02-26', '2026-03-26'], 5);
  const logs = [
    { log_date: '2026-01-26', symptoms: [{ key: 'bloating' }] }, // Zyklus 1, Tag 26, Luteal -> 3 Tage vorher
    { log_date: '2026-02-23', symptoms: [{ key: 'bloating' }] }, // Zyklus 2, Tag 26, Luteal -> 3 Tage vorher
  ];
  const pattern = symptomCyclePattern(logs, hist, {}, 'bloating');
  assert.equal(pattern.typicalDaysBeforePeriod, 3);
});

test('symptomCyclePattern: typicalDaysBeforePeriod bleibt null bei nur einem lutealen Treffer (kein Zufall als Muster)', () => {
  const hist = periods(['2026-01-01', '2026-01-29'], 5);
  const logs = [{ log_date: '2026-01-26', symptoms: [{ key: 'bloating' }] }]; // Tag 26, Luteal, nur 1x
  const pattern = symptomCyclePattern(logs, hist, {}, 'bloating');
  assert.equal(pattern.typicalDaysBeforePeriod, null);
});

test('symptomCyclePattern: typicalDaysBeforePeriod ignoriert Vorkommen ausserhalb der Lutealphase', () => {
  const hist = periods(['2026-01-01', '2026-01-29', '2026-02-26'], 5);
  const logs = [
    { log_date: '2026-01-02', symptoms: [{ key: 'cramps' }] }, // Tag 2, Menstruation
    { log_date: '2026-01-30', symptoms: [{ key: 'cramps' }] }, // Tag 2, Menstruation
  ];
  const pattern = symptomCyclePattern(logs, hist, {}, 'cramps');
  assert.equal(pattern.mostCommonPhase, PHASE.MENSTRUATION);
  assert.equal(pattern.typicalDaysBeforePeriod, null);
});

test('symptomCyclePattern: typicalDaysBeforePeriod - bei Gleichstand gewinnt der Wert aus dem juengeren Zyklus', () => {
  const hist = periods(['2026-01-01', '2026-01-29', '2026-02-26', '2026-03-26'], 5);
  const logs = [
    { log_date: '2026-01-26', symptoms: [{ key: 'x' }] }, // Zyklus 1 (aeltester), Tag 26 -> 3 Tage vorher
    { log_date: '2026-02-23', symptoms: [{ key: 'x' }] }, // Zyklus 2, Tag 26 -> 3 Tage vorher (2. Treffer fuer 3)
    { log_date: '2026-03-22', symptoms: [{ key: 'x' }] }, // Zyklus 3, Tag 25 -> 4 Tage vorher
    { log_date: '2026-04-19', symptoms: [{ key: 'x' }] }, // Zyklus 4 (juengster), Tag 25 -> 4 Tage vorher (2. Treffer fuer 4)
  ];
  const pattern = symptomCyclePattern(logs, hist, {}, 'x');
  assert.equal(pattern.typicalDaysBeforePeriod, 4); // beide Werte 2x, aber 4 stammt aus dem juengeren Zyklus
});

test('symptomCyclePattern: zwei Perioden mit identischem Startdatum teilen sich NICHT dieselbe occurredOnDays-Liste (Regression)', () => {
  // Entartete, aber vom Schema nicht ausgeschlossene Eingabe: zwei Perioden
  // mit demselben start_date wuerden bei einem String-Schluessel (cycleStart)
  // dieselbe Map-Zelle treffen und ihre Vorkommen teilen.
  const hist = [
    { id: 1, start_date: '2026-05-27', end_date: '2026-06-01' },
    { id: 2, start_date: '2026-08-13', end_date: '2026-08-18' },
    { id: 3, start_date: '2026-08-13', end_date: '2026-08-18' }, // identisches Startdatum wie id 2
  ];
  const logs = [{ log_date: '2026-08-30', symptoms: [{ key: 'headache' }] }]; // faellt in den Zyklus von id 3 (der letzte, echte Folgezyklus)
  const pattern = symptomCyclePattern(logs, hist, {}, 'headache');
  assert.equal(pattern.occurredCount, 1);
  const [mostRecent, degenerate] = pattern.cycles;
  assert.equal(mostRecent.cycleStart, '2026-08-13');
  assert.equal(degenerate.cycleStart, '2026-08-13');
  assert.deepEqual(mostRecent.occurredOnDays, [18]);
  assert.deepEqual(degenerate.occurredOnDays, []); // die entartete (0 Tage lange) Periode bleibt unberuehrt
});

test('symptomCyclePattern: ohne jede Periode gibt es nichts zu rekonstruieren', () => {
  assert.deepEqual(symptomCyclePattern([], [], {}, 'cramps'), { cycles: [], occurredCount: 0, totalCount: 0, mostCommonPhase: null, typicalDaysBeforePeriod: null });
});

test('symptomCyclePattern/symptomFrequencyByPhase: reconstructCycles()-Refactor liefert unveraendertes Ergebnis (Regression)', () => {
  const hist = periods(['2026-05-01', '2026-05-29'], 5);
  const logs = [{ log_date: '2026-05-02', symptoms: [{ key: 'cramps', intensity: 2 }] }];
  assert.deepEqual(symptomFrequencyByPhase(logs, hist, {}), [
    { key: 'cramps', menstruation: 1, luteal: 0, other: 0, total: 1, avgIntensity: 2 },
  ]);
});

// --------------------------------------------------------
// predictSymptomLikelihood (Phase 4e)
// --------------------------------------------------------

test('predictSymptomLikelihood: projiziert einen stabilen Zyklustag korrekt auf den aktuellen Zyklus, isLikelyToday', () => {
  const hist = periods(['2026-01-01', '2026-01-29', '2026-02-26', '2026-03-26'], 5); // 28/28/28
  const logs = [
    { log_date: '2026-01-02', symptoms: [{ key: 'cramps' }] }, // Tag 2
    { log_date: '2026-01-30', symptoms: [{ key: 'cramps' }] }, // Tag 2
    { log_date: '2026-02-27', symptoms: [{ key: 'cramps' }] }, // Tag 2
    { log_date: '2026-03-27', symptoms: [{ key: 'cramps' }] }, // Tag 2
  ];
  // C-2: Tag 2 wird zusaetzlich auf den naechsten projizierten Zyklus gemappt.
  // Naechster Start (Kalendermethode): letzter Start 2026-03-26 + Ø-Zyklus 28
  // (nur 3 Luecken, avgCycle bleibt beim Default 28) = 2026-04-23; Tag 2 davon
  // ist 2026-04-24.
  const onDay = predictSymptomLikelihood(logs, hist, {}, 'cramps', '2026-03-27');
  assert.deepEqual(onDay.likelyDates, ['2026-03-27', '2026-04-24']);
  assert.equal(onDay.todayCycleDay, 2);
  assert.equal(onDay.isLikelyToday, true);
  // "heute" (2026-03-27) selbst zaehlt nicht als "danach" - der naechste
  // wirklich zukuenftige Treffer ist der auf den Folgezyklus projizierte.
  assert.equal(onDay.nextLikelyDate, '2026-04-24');

  const offDay = predictSymptomLikelihood(logs, hist, {}, 'cramps', '2026-04-01');
  assert.equal(offDay.todayCycleDay, 7);
  assert.equal(offDay.isLikelyToday, false);
  // dieselbe Vorhersage, unabhaengig vom Blickpunkt "heute" - jetzt mit BEIDEN
  // Zyklen (vorher waere um diesen Zeitpunkt jeder Marker schon Vergangenheit).
  assert.deepEqual(offDay.likelyDates, ['2026-03-27', '2026-04-24']);
  assert.equal(offDay.nextLikelyDate, '2026-04-24');
});

test('predictSymptomLikelihood: unter MIN_HISTORY_GAPS betrachteten Zyklen keine Vorhersage, todayCycleDay bleibt berechnet', () => {
  const hist = periods(['2026-01-01', '2026-01-29'], 5); // nur 1 Zyklus betrachtbar
  const logs = [{ log_date: '2026-01-02', symptoms: [{ key: 'cramps' }] }];
  const result = predictSymptomLikelihood(logs, hist, {}, 'cramps', '2026-01-30');
  assert.deepEqual(result.likelyDates, []);
  assert.equal(result.isLikelyToday, false);
  assert.equal(result.todayCycleDay, 2); // 2026-01-30 ist Tag 2 des (einzigen echten) Zyklus seit 2026-01-29
});

test('predictSymptomLikelihood: ohne stabilen Zyklustag keine falsche "wahrscheinlich"-Aussage', () => {
  const hist = periods(['2026-01-01', '2026-01-29', '2026-02-26', '2026-03-26'], 5);
  // Jeweils ein anderer Zyklustag je Zyklus - kein Tag erreicht die 50%-Schwelle.
  const logs = [
    { log_date: '2026-01-03', symptoms: [{ key: 'cramps' }] },  // Tag 3
    { log_date: '2026-02-01', symptoms: [{ key: 'cramps' }] },  // Tag 4 (relativ zu 01-29)
    { log_date: '2026-03-02', symptoms: [{ key: 'cramps' }] },  // Tag 5 (relativ zu 02-26)
    { log_date: '2026-04-01', symptoms: [{ key: 'cramps' }] },  // Tag 7 (relativ zu 03-26)
  ];
  const result = predictSymptomLikelihood(logs, hist, {}, 'cramps', '2026-03-27');
  assert.deepEqual(result.likelyDates, []);
  assert.equal(result.isLikelyToday, false);
});

test('predictSymptomLikelihood: ein einzelner eligibler Zyklus ist kein Muster, auch bei 100% Treffer an diesem Tag', () => {
  // Zyklus 3 (02-26, 44 Tage lang) ist der einzige, der Tag 35 ueberhaupt erreicht -
  // der letzte, offene Zyklus faellt auf einen kuerzeren Ø-Wert (33 Tage) zurueck.
  const hist = periods(['2026-01-01', '2026-01-29', '2026-02-26', '2026-04-11'], 5);
  const logs = [{ log_date: '2026-04-01', symptoms: [{ key: 'cramps' }] }]; // Tag 35 des dritten Zyklus
  const result = predictSymptomLikelihood(logs, hist, {}, 'cramps', '2026-04-11');
  assert.deepEqual(result.likelyDates, []); // nur 1 eligibler Zyklus fuer Tag 35 (< MIN_ELIGIBLE_CYCLES_FOR_DAY)
});

test('predictSymptomLikelihood: ohne jede Periode gibt es nichts vorherzusagen', () => {
  assert.deepEqual(predictSymptomLikelihood([], [], {}, 'cramps', '2026-01-01'),
    { likelyDates: [], todayCycleDay: 0, isLikelyToday: false, nextLikelyDate: null });
});

// C-2: die alte Implementierung projizierte NUR auf den laufenden Zyklus -
// ein Symptom, das frueh im Zyklus auftritt, waere ab Zyklusmitte bereits
// vollstaendig in der Vergangenheit und liefert (vor dem Fix) KEIN einziges
// zukuenftiges Datum. Regressionstest fuer genau dieses Szenario.
test('predictSymptomLikelihood: Vorwaertsprojektion - ein frueher Zyklustag bleibt auch spaet im Zyklus als kommendes Datum sichtbar', () => {
  const hist = periods(['2026-01-01', '2026-01-29', '2026-02-26', '2026-03-26'], 5); // 28/28/28
  const logs = [
    { log_date: '2026-01-02', symptoms: [{ key: 'cramps' }] }, // Tag 2
    { log_date: '2026-01-30', symptoms: [{ key: 'cramps' }] }, // Tag 2
    { log_date: '2026-02-27', symptoms: [{ key: 'cramps' }] }, // Tag 2
    { log_date: '2026-03-27', symptoms: [{ key: 'cramps' }] }, // Tag 2
  ];
  // "Heute" liegt kurz vor dem Ende des laufenden Zyklus (Tag 26 von 28) -
  // Tag 2 des LAUFENDEN Zyklus (2026-03-27) liegt damit klar in der
  // Vergangenheit; nur die Projektion auf den naechsten Zyklus liefert ein
  // Datum in der Zukunft.
  const result = predictSymptomLikelihood(logs, hist, {}, 'cramps', '2026-04-20');
  assert.equal(result.todayCycleDay, 26);
  assert.ok(result.likelyDates.some((d) => daysBetween('2026-04-20', d) > 0),
    'ohne Vorwaertsprojektion gäbe es hier kein einziges zukünftiges Datum');
  assert.equal(result.nextLikelyDate, '2026-04-24'); // Tag 2 des Folgezyklus (Start 2026-04-23)
});

// --------------------------------------------------------
// projectFutureCycles (aus buildCycleCalendar() herausgezogen, Phase 5 -
// derselbe Horizont, den der neue ICS-Feed braucht)
// --------------------------------------------------------

test('projectFutureCycles: drei Folgezyklen ab dem letzten Periodenstart', () => {
  const hist = periods(['2026-01-01', '2026-01-29', '2026-02-26'], 5); // 28/28 -> avgCycle 28
  const projected = projectFutureCycles(hist, {});
  assert.equal(projected.length, 3);
  assert.equal(projected[0].start, '2026-03-26');
  assert.equal(projected[1].start, '2026-04-23');
  assert.equal(projected[2].start, '2026-05-21');
  assert.equal(projected[0].end, '2026-03-30'); // avgPeriod (Default 5) - 1 Tag
  // Eisprung = Start - Lutealphase (Default 14).
  assert.equal(projected[0].ovulation, '2026-03-12');
});

test('projectFutureCycles: leer ohne jede Periode', () => {
  assert.deepEqual(projectFutureCycles([], {}), []);
});

test('projectFutureCycles: leer im Schwangerschafts-Modus (keine Prognose ohne Basis)', () => {
  const hist = periods(['2026-01-01', '2026-01-29'], 5);
  const settings = { pregnancy_mode: 1, pregnancy_due_date: '2026-09-01' };
  assert.deepEqual(projectFutureCycles(hist, settings, '2026-03-01'), []);
});

// projectFutureCycles() ankerte bisher IMMER auf den
// allerletzten Periodenstart, auch wenn der in der Zukunft lag (eine bereits
// im Voraus geloggte Periode) - predictCycle() ankert dagegen seit jeher auf
// den jüngsten NICHT-zukünftigen Start. Mit zwei verschiedenen Ankern zeigte
// buildCycleCalendar() (dessen `projected.slice(1)` genau EIN reales Fenster
// verwerfen soll, weil predictCycle() dessen Nachfolger ersetzt) ein Fenster
// mit dem FALSCHEN Anker direkt neben der geloggten künftigen Periode. Mit
// derselben Anker-Regel (latestNonFutureStart(), health-cycle.js) liefert
// projectFutureCycles()[0].start jetzt exakt denselben Wert wie
// predictCycle().nextStart.
test('projectFutureCycles/predictCycle: derselbe (nicht-zukünftige) Anker bei einer bereits geloggten künftigen Periode', () => {
  // 3 plausible 28-Tage-Lücken (erreicht MIN_HISTORY_GAPS) + eine bereits
  // geloggte künftige Periode (2026-05-01, nach "heute" 2026-04-01).
  const hist = periods(['2026-01-01', '2026-01-29', '2026-02-26', '2026-03-26', '2026-05-01'], 5);
  const today = '2026-04-01';

  const prediction = predictCycle(hist, {}, today, []);
  assert.equal(prediction.lastStart, '2026-03-26'); // NICHT der künftige Start 2026-05-01
  assert.equal(prediction.nextStart, '2026-04-23');

  const projected = projectFutureCycles(hist, {}, today);
  assert.equal(projected[0].start, prediction.nextStart, 'projectFutureCycles()[0] muss denselben Anker wie predictCycle() nutzen');

  // Kalenderfenster leiten sich vollstaendig vom (nicht-zukuenftigen) Anker ab:
  // die vorhergesagte Periode UND das fruchtbare Fenster des ersten
  // projizierten Zyklus sind sichtbar, exakt an den aus lastStart=2026-03-26
  // abgeleiteten Daten.
  const cal = buildCycleCalendar('2026-04-15', { periods: hist, logs: [], settings: {}, todayKey: today, weekStartsOn: 1 });
  const at = (k) => cal.weeks.flat().find((c) => c.dateKey === k);
  assert.equal(at('2026-04-23').phase, PHASE.MENSTRUATION);
  assert.equal(at('2026-04-23').predicted, true);
  // Fruchtbares Fenster (Eisprung = 04-23 - 14 = 04-09, Fenster 04-04..04-09).
  assert.equal(at('2026-04-06').phase, PHASE.FERTILE);
  assert.equal(at('2026-04-09').phase, PHASE.OVULATION);

  // Die bereits geloggte künftige Periode selbst rendert weiterhin als
  // GELOGGTE (nicht vorhergesagte) Menstruation, über loggedPeriodPhase() -
  // unveraendert von diesem Fix.
  const calMay = buildCycleCalendar('2026-05-15', { periods: hist, logs: [], settings: {}, todayKey: today, weekStartsOn: 1 });
  const atMay = (k) => calMay.weeks.flat().find((c) => c.dateKey === k);
  assert.equal(atMay('2026-05-01').phase, PHASE.MENSTRUATION);
  assert.equal(atMay('2026-05-01').predicted, false);
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

// symptoms ist seit Phase 2 ein Array ({key, intensity}[]) statt eines
// Komma-Strings - ein LEERES Array ist in JS wahr, ein reines `!!log.symptoms`
// würde einen Tag ohne jeden Eintrag fälschlich als geloggt zählen.
test('buildCycleCalendar: hasLog zählt ein leeres symptoms-Array nicht als Log', () => {
  const cal = buildCycleCalendar('2026-06-15', {
    periods: periods(['2026-06-01'], 5),
    logs: [
      { log_date: '2026-06-05', symptoms: [] },
      { log_date: '2026-06-06', symptoms: [{ key: 'cramps', intensity: 2 }] },
    ],
    todayKey: '2026-06-15',
    weekStartsOn: 1,
  });
  const at = (k) => cal.weeks.flat().find((c) => c.dateKey === k);
  assert.equal(at('2026-06-05').hasLog, false);
  assert.equal(at('2026-06-06').hasLog, true);
});

// R4-1: ein Tag, der nur Feelings, Zervixschleim, LH-Test oder BBT enthält
// (kein flow/symptoms/mood/note), muss trotzdem als geloggt gelten - sonst
// verschwindet der Kalenderpunkt für genau die Felder, die seit Phase 2 neu
// dazugekommen sind bzw. für einen bereits umgestellten Tag (mood wird beim
// erneuten Speichern gelöscht, ohne dass hasLog das noch bemerkt).
test('buildCycleCalendar: hasLog erkennt reine Feelings-Einträge ohne flow/symptoms/mood/note', () => {
  const cal = buildCycleCalendar('2026-06-15', {
    periods: periods(['2026-06-01'], 5),
    logs: [
      { log_date: '2026-06-07', feelings: ['good'] },
    ],
    todayKey: '2026-06-15',
    weekStartsOn: 1,
  });
  const at = (k) => cal.weeks.flat().find((c) => c.dateKey === k);
  assert.equal(at('2026-06-07').hasLog, true);
});

test('buildCycleCalendar: hasLog erkennt einen reinen cervix_mucus-Eintrag', () => {
  const cal = buildCycleCalendar('2026-06-15', {
    periods: periods(['2026-06-01'], 5),
    logs: [
      { log_date: '2026-06-08', cervix_mucus: 'eggwhite' },
    ],
    todayKey: '2026-06-15',
    weekStartsOn: 1,
  });
  const at = (k) => cal.weeks.flat().find((c) => c.dateKey === k);
  assert.equal(at('2026-06-08').hasLog, true);
});

// R5-1a: GET /cycle/logs liefert `feelings` auf JEDER Zeile als Array, auch
// wenn keine Gefühle gespeichert sind - ein leeres Array ist in JS wahr, ein
// reines `!!log.feelings` (statt `log.feelings?.length`) würde deshalb JEDEN
// Tag fälschlich als geloggt zählen.
test('buildCycleCalendar: hasLog zählt ein leeres feelings-Array (ohne sonstige Felder) nicht als Log', () => {
  const cal = buildCycleCalendar('2026-06-15', {
    periods: periods(['2026-06-01'], 5),
    logs: [
      { log_date: '2026-06-09', feelings: [] },
    ],
    todayKey: '2026-06-15',
    weekStartsOn: 1,
  });
  const at = (k) => cal.weeks.flat().find((c) => c.dateKey === k);
  assert.equal(at('2026-06-09').hasLog, false);
});

// R5-1b: mood, lh_test, pregnancy_test und basal_temp isoliert - je ein Tag
// mit GENAU einem dieser Felder und sonst nichts, damit ein versehentliches
// Entfernen eines einzelnen Feldes aus der hasLog-Bedingung genau einen
// dieser Tests (und nur diesen) rot werden lässt.
test('buildCycleCalendar: hasLog erkennt einen reinen mood-Eintrag', () => {
  const cal = buildCycleCalendar('2026-06-15', {
    periods: periods(['2026-06-01'], 5),
    logs: [
      { log_date: '2026-06-10', mood: 'sad' },
    ],
    todayKey: '2026-06-15',
    weekStartsOn: 1,
  });
  const at = (k) => cal.weeks.flat().find((c) => c.dateKey === k);
  assert.equal(at('2026-06-10').hasLog, true);
});

test('buildCycleCalendar: hasLog erkennt einen reinen lh_test-Eintrag', () => {
  const cal = buildCycleCalendar('2026-06-15', {
    periods: periods(['2026-06-01'], 5),
    logs: [
      { log_date: '2026-06-12', lh_test: 'positive' },
    ],
    todayKey: '2026-06-15',
    weekStartsOn: 1,
  });
  const at = (k) => cal.weeks.flat().find((c) => c.dateKey === k);
  assert.equal(at('2026-06-12').hasLog, true);
});

test('buildCycleCalendar: hasLog erkennt einen reinen pregnancy_test-Eintrag', () => {
  const cal = buildCycleCalendar('2026-06-15', {
    periods: periods(['2026-06-01'], 5),
    logs: [
      { log_date: '2026-06-13', pregnancy_test: 'negative' },
    ],
    todayKey: '2026-06-15',
    weekStartsOn: 1,
  });
  const at = (k) => cal.weeks.flat().find((c) => c.dateKey === k);
  assert.equal(at('2026-06-13').hasLog, true);
});

test('buildCycleCalendar: hasLog erkennt einen reinen basal_temp-Eintrag', () => {
  const cal = buildCycleCalendar('2026-06-15', {
    periods: periods(['2026-06-01'], 5),
    logs: [
      { log_date: '2026-06-14', basal_temp: 36.5 },
    ],
    todayKey: '2026-06-15',
    weekStartsOn: 1,
  });
  const at = (k) => cal.weeks.flat().find((c) => c.dateKey === k);
  assert.equal(at('2026-06-14').hasLog, true);
});

// A-1: buildCycleCalendar() muss dieselbe BBT-Bestätigung wie predictCycle()
// zeigen - sonst widersprechen sich Hero/Ring und Kalender (live beobachtet:
// Hero "bestätigt 06-07", Kalender zeigte weiter das rein kalendarische
// Fenster 06-10..06-15). Historie: 3 Perioden (2 Lücken, unter
// MIN_HISTORY_GAPS) -> Ø-Zyklus bleibt Default 28, Luteal Default 14 ->
// kalendarisch wäre der Eisprung 2026-06-01 + 28 - 14 = 2026-06-15.
test('buildCycleCalendar: bestätigter Temperaturanstieg verschiebt Eisprung/fruchtbares Fenster des AKTUELLEN Zyklus', () => {
  const hist = periods(['2026-04-06', '2026-05-04', '2026-06-01'], 5);
  const logs = tempLogs([
    ['2026-06-01', 36.30], ['2026-06-02', 36.30], ['2026-06-03', 36.30],
    ['2026-06-04', 36.30], ['2026-06-05', 36.30], ['2026-06-06', 36.30],
    ['2026-06-07', 36.55], ['2026-06-08', 36.60], ['2026-06-09', 36.58],
  ]); // bestätigter Anstieg ab 2026-06-07 (siehe detectTemperatureShift()-Tests weiter oben)

  const cal = buildCycleCalendar('2026-06-15', { periods: hist, logs, todayKey: '2026-06-10', weekStartsOn: 1 });
  const at = (k) => cal.weeks.flat().find((c) => c.dateKey === k);

  // Fruchtbares Fenster folgt jetzt 06-02..06-07 (bestätigt) statt 06-10..06-15
  // (kalendarisch) - die ersten Tage davon (06-02..06-05) liegen aber noch in
  // der geloggten Periode (2026-06-01..06-05) und bleiben deshalb Menstruation
  // (höhere Priorität als jede Vorhersage/Bestätigung).
  assert.equal(at('2026-06-05').phase, PHASE.MENSTRUATION);
  assert.equal(at('2026-06-06').phase, PHASE.FERTILE);
  assert.equal(at('2026-06-06').confirmed, true);
  assert.equal(at('2026-06-06').predicted, false);
  assert.equal(at('2026-06-07').phase, PHASE.OVULATION);
  assert.equal(at('2026-06-07').confirmed, true);
  assert.equal(at('2026-06-07').predicted, false);

  // Das rein kalendarische Datum (06-15) erscheint NICHT mehr - genau der
  // Widerspruch, den A-1 behebt.
  assert.equal(at('2026-06-15').phase, null);
  assert.equal(at('2026-06-15').confirmed, false);
  assert.equal(at('2026-06-15').predicted, false);
});

test('buildCycleCalendar: Folgezyklen (k>=2) bleiben unverändert reine Kalendermethode, unberührt von der BBT-Bestätigung', () => {
  const hist = periods(['2026-04-06', '2026-05-04', '2026-06-01'], 5);
  const logs = tempLogs([
    ['2026-06-01', 36.30], ['2026-06-02', 36.30], ['2026-06-03', 36.30],
    ['2026-06-04', 36.30], ['2026-06-05', 36.30], ['2026-06-06', 36.30],
    ['2026-06-07', 36.55], ['2026-06-08', 36.60], ['2026-06-09', 36.58],
  ]);
  // Zweiter Folgezyklus (k=2): Start 2026-06-01 + 2*28 = 2026-07-27, Eisprung
  // 2026-07-27 - 14 = 2026-07-13 - reine Kalendermethode.
  const cal = buildCycleCalendar('2026-07-15', { periods: hist, logs, todayKey: '2026-06-10', weekStartsOn: 1 });
  const at = (k) => cal.weeks.flat().find((c) => c.dateKey === k);
  assert.equal(at('2026-07-13').phase, PHASE.OVULATION);
  assert.equal(at('2026-07-13').predicted, true);
  assert.equal(at('2026-07-13').confirmed, false);
});

test('buildCycleCalendar: ohne BBT-Bestätigung bleibt das aktuelle Fenster wie zuvor "predicted", nie "confirmed"', () => {
  const cal = buildCycleCalendar('2026-06-15', {
    periods: periods(['2026-06-01'], 5),
    todayKey: '2026-06-15',
    weekStartsOn: 1,
  });
  const at = (k) => cal.weeks.flat().find((c) => c.dateKey === k);
  assert.equal(at('2026-06-15').phase, PHASE.OVULATION);
  assert.equal(at('2026-06-15').predicted, true);
  assert.equal(at('2026-06-15').confirmed, false);
});

// Hormonelle Verhütung muss auch im Kalender konsistent mit dem Ring
// sein (siehe cycleRing()-Test) - sonst zeigt der Kalender ein Fenster, das
// Hero/Ring bereits als unterdrückt behandeln.
test('buildCycleCalendar: hormonelle Verhütung zeigt keine Eisprung-/Fruchtbarkeits-Zellen', () => {
  const cal = buildCycleCalendar('2026-06-15', {
    periods: periods(['2026-06-01'], 5),
    settings: { contraception: 'pill' },
    todayKey: '2026-06-15',
    weekStartsOn: 1,
  });
  const any = cal.weeks.flat().some((c) => c.phase === PHASE.FERTILE || c.phase === PHASE.OVULATION);
  assert.equal(any, false);
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

// Der Kalenderkopf steht in `grid-template-columns: repeat(7, 1fr)`
// (.cycle-cal__weekdays in styles/health.css): sieben feste Spalten, die nicht
// mitwachsen. Ein langer Tagesname laeuft dort in die Nachbarspalte, statt den
// Kopf breiter zu machen - auf schmalen Telefonen wird die Zeile unlesbar.
//
// Deshalb hier eine Obergrenze statt einer Sichtpruefung: Arabisch stand nach
// der Uebersetzungsrunde auf den vollen Namen (الثلاثاء, acht Zeichen), weil
// die Werte aus health.meds.weekday uebernommen wurden. Deren Schalter ist ein
// flex-wrap-Element mit Innenabstand und darf lang sein - derselbe Text an zwei
// Orten heisst eben nicht, dass beide Orte gleich viel Platz haben.
test('die Wochentage im Zyklus-Kalender passen in sieben feste Spalten', () => {
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  const graphemes = (value) => [...segmenter.segment(value)].length;
  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const LIMIT = 4;

  const dir = new URL('../public/locales/', import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  assert.ok(files.length >= 20, 'Locale-Dateien nicht gefunden');

  for (const file of files) {
    const locale = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    const weekday = locale.health?.cycle?.weekday;
    assert.ok(weekday, `${file}: health.cycle.weekday fehlt`);
    for (const day of DAYS) {
      const label = weekday[day];
      assert.ok(
        graphemes(label) <= LIMIT,
        `${file}: "${label}" (${day}) ist ${graphemes(label)} Zeichen lang, erlaubt sind ${LIMIT} - der Kalenderkopf hat feste Spalten`,
      );
    }
  }
});

// --------------------------------------------------------
// pmsWindow
// --------------------------------------------------------

// Historie: 4 Perioden, Lücken 28/28/28 (Ø-Zyklus 28) -> letzter Start
// 2026-03-26, nächster Start (Kalendermethode) 2026-03-26 + 28 = 2026-04-23.
const PMS_HIST = periods(['2026-01-01', '2026-01-29', '2026-02-26', '2026-03-26'], 5);

test('pmsWindow: Fenster aus mehreren Symptom-Mustern mit unterschiedlicher Vorlaufzeit', () => {
  const logs = [
    // bloating: Zyklus 1 (Start 01-01) Tag 26, Zyklus 2 (Start 01-29) Tag 26 ->
    // je 28-26+1 = 3 Tage vor der nächsten Periode.
    { log_date: '2026-01-26', symptoms: [{ key: 'bloating' }] },
    { log_date: '2026-02-23', symptoms: [{ key: 'bloating' }] },
    // headache: Zyklus 1 Tag 24, Zyklus 2 Tag 24 -> je 28-24+1 = 5 Tage vorher.
    { log_date: '2026-01-24', symptoms: [{ key: 'headache' }] },
    { log_date: '2026-02-21', symptoms: [{ key: 'headache' }] },
  ];
  const win = pmsWindow(logs, PMS_HIST, {}, '2026-04-01');
  // Spanne über BEIDE Muster: 5 Tage vorher (weitester Wert) bis 3 Tage vorher
  // (nächster Wert) -> 2026-04-23 - 5 = 2026-04-18 bis 2026-04-23 - 3 = 2026-04-20.
  // symptomKeys in SYMPTOM_TYPES-Reihenfolge (headache steht vor bloating).
  assert.deepEqual(win, { start: '2026-04-18', end: '2026-04-20', symptomKeys: ['headache', 'bloating'] });
});

test('pmsWindow: kein Symptom mit einem echten Muster -> null', () => {
  assert.equal(pmsWindow([], PMS_HIST, {}, '2026-04-01'), null);
  // Ein einzelner Treffer ist kein Muster (dieselbe Regel wie
  // symptomCyclePattern().typicalDaysBeforePeriod).
  const singleHit = [{ log_date: '2026-03-22', symptoms: [{ key: 'nausea' }] }];
  assert.equal(pmsWindow(singleHit, PMS_HIST, {}, '2026-04-01'), null);
});

test('pmsWindow: settings.show_pms === 0 unterdrückt das Fenster', () => {
  const logs = [
    { log_date: '2026-01-26', symptoms: [{ key: 'bloating' }] },
    { log_date: '2026-02-23', symptoms: [{ key: 'bloating' }] },
  ];
  assert.equal(pmsWindow(logs, PMS_HIST, { show_pms: 0 }, '2026-04-01'), null);
  // show_pms fehlend/1 blendet dagegen nicht aus.
  assert.notEqual(pmsWindow(logs, PMS_HIST, {}, '2026-04-01'), null);
  assert.notEqual(pmsWindow(logs, PMS_HIST, { show_pms: 1 }, '2026-04-01'), null);
});

test('pmsWindow: Schwangerschafts-Modus unterdrückt das Fenster', () => {
  const logs = [
    { log_date: '2026-01-26', symptoms: [{ key: 'bloating' }] },
    { log_date: '2026-02-23', symptoms: [{ key: 'bloating' }] },
  ];
  const settings = { pregnancy_mode: 1, pregnancy_due_date: '2026-12-01' };
  assert.equal(pmsWindow(logs, PMS_HIST, settings, '2026-04-01'), null);
});

test('pmsWindow: ohne jede Periode gibt es kein Fenster', () => {
  assert.equal(pmsWindow([], [], {}, '2026-04-01'), null);
});

test('pmsWindow: die dem nächsten Start nähere Grenze wird auf mindestens 2 Tage geklemmt', () => {
  // fatigue: Zyklus 1 (Start 01-01) Tag 28, Zyklus 2 (Start 01-29) Tag 28 ->
  // je 28-28+1 = 1 Tag vor der nächsten Periode (roh - wird auf 2 geklemmt).
  const logs = [
    { log_date: '2026-01-28', symptoms: [{ key: 'fatigue' }] },
    { log_date: '2026-02-25', symptoms: [{ key: 'fatigue' }] },
  ];
  const win = pmsWindow(logs, PMS_HIST, {}, '2026-04-01');
  assert.deepEqual(win, { start: '2026-04-21', end: '2026-04-21', symptomKeys: ['fatigue'] });
});

// --------------------------------------------------------
// periodFlowStats - EIN Durchlauf statt zweier fast
// identischer Schleifen (periodFlowSummary()/periodFlowLoad() bleiben als
// dünne Wrapper bestehen, s. u.)
// --------------------------------------------------------

test('periodFlowStats: liefert heaviest, load UND loggedDays in einem Durchlauf', () => {
  const period = { id: 1, start_date: '2026-01-01', end_date: '2026-01-05' };
  const logs = [
    { log_date: '2026-01-01', flow: 'spotting' },
    { log_date: '2026-01-02', flow: 'medium' },
    { log_date: '2026-01-03', flow: 'heavy' },
    { log_date: '2026-01-04', flow: 'light' },
  ];
  assert.deepEqual(periodFlowStats(period, logs), { heaviest: 'heavy', load: 1 + 3 + 4 + 2, loggedDays: 4 });
});

test('periodFlowStats: null ohne einen einzigen Flow-Log im Zeitraum', () => {
  const period = { id: 1, start_date: '2026-01-01', end_date: '2026-01-05' };
  assert.equal(periodFlowStats(period, []), null);
});

test('periodFlowSummary/periodFlowLoad: dünne Wrapper um periodFlowStats() - konsistent zueinander', () => {
  const period = { id: 1, start_date: '2026-01-01', end_date: '2026-01-05' };
  const logs = [
    { log_date: '2026-01-01', flow: 'heavy' },
    { log_date: '2026-01-02', flow: 'light' },
  ];
  const stats = periodFlowStats(period, logs);
  assert.deepEqual(periodFlowSummary(period, logs), { heaviest: stats.heaviest, loggedDays: stats.loggedDays });
  assert.deepEqual(periodFlowLoad(period, logs), { load: stats.load, loggedDays: stats.loggedDays });
});

// --------------------------------------------------------
// periodFlowSummary (v2, B-2) - Blutungsstärke-Zusammenfassung je Periode
// --------------------------------------------------------

test('periodFlowSummary: stärkster Flow-Wert + Anzahl geloggter Tage einer abgeschlossenen Periode', () => {
  const period = { id: 1, start_date: '2026-01-01', end_date: '2026-01-05' };
  const logs = [
    { log_date: '2026-01-01', flow: 'spotting' },
    { log_date: '2026-01-02', flow: 'medium' },
    { log_date: '2026-01-03', flow: 'heavy' },
    { log_date: '2026-01-04', flow: 'light' },
    // kein Log am 01-05.
  ];
  assert.deepEqual(periodFlowSummary(period, logs), { heaviest: 'heavy', loggedDays: 4 });
});

test('periodFlowSummary: kein Flow-Log im Zeitraum -> null', () => {
  const period = { id: 1, start_date: '2026-01-01', end_date: '2026-01-05' };
  assert.equal(periodFlowSummary(period, []), null);
  // Logs existieren, aber ohne flow-Wert (nur Symptome/Notiz) -> zählen nicht.
  const logsWithoutFlow = [{ log_date: '2026-01-02', symptoms: [{ key: 'cramps' }] }];
  assert.equal(periodFlowSummary(period, logsWithoutFlow), null);
});

test('periodFlowSummary: Logs außerhalb der Periodenspanne zählen nicht mit', () => {
  const period = { id: 1, start_date: '2026-01-01', end_date: '2026-01-05' };
  const logs = [
    { log_date: '2025-12-31', flow: 'heavy' }, // ein Tag zu früh
    { log_date: '2026-01-06', flow: 'heavy' }, // ein Tag zu spät
    { log_date: '2026-01-03', flow: 'light' }, // einzig gültiger Tag
  ];
  assert.deepEqual(periodFlowSummary(period, logs), { heaviest: 'light', loggedDays: 1 });
});

test('periodFlowSummary: offene (laufende) Periode nutzt avgPeriod für die Spanne, wie loggedPeriodPhase()', () => {
  const period = { id: 1, start_date: '2026-01-01' }; // kein end_date.
  // avgPeriod=3 -> Spanne 01-01..01-03; ein Log am 01-04 liegt außerhalb.
  const logs = [
    { log_date: '2026-01-02', flow: 'heavy' },
    { log_date: '2026-01-04', flow: 'heavy' },
  ];
  assert.deepEqual(periodFlowSummary(period, logs, 3), { heaviest: 'heavy', loggedDays: 1 });
  // Ohne avgPeriod-Argument greift der DEFAULT_PERIOD-Fallback (5 Tage) - der
  // 01-04-Log liegt dann innerhalb der Spanne.
  assert.deepEqual(periodFlowSummary(period, logs), { heaviest: 'heavy', loggedDays: 2 });
});

test('periodFlowSummary: ein unbekannter flow-Wert zählt den Tag mit, bestimmt aber keinen Rang', () => {
  const period = { id: 1, start_date: '2026-01-01', end_date: '2026-01-03' };
  const logs = [{ log_date: '2026-01-02', flow: 'not-a-real-level' }];
  assert.deepEqual(periodFlowSummary(period, logs), { heaviest: null, loggedDays: 1 });
});

// --------------------------------------------------------
// feelingFrequencyByPhase
// --------------------------------------------------------

test('feelingFrequencyByPhase: klassifiziert Menstruation/Luteal/Sonstige wie symptomFrequencyByPhase, aber über `feelings`', () => {
  const hist = periods(['2026-05-01', '2026-05-29'], 5);
  const logs = [
    { log_date: '2026-05-02', feelings: ['irritable'] }, // Menstruation
    { log_date: '2026-05-20', feelings: ['sad'] }, // Luteal
    { log_date: '2026-05-10', feelings: ['sad', 'anxious'] }, // Sonstige (follikulär)
  ];
  const freq = feelingFrequencyByPhase(logs, hist, {});
  assert.deepEqual(freq, [
    { key: 'sad', menstruation: 0, luteal: 1, other: 1, total: 2, avgIntensity: null },
    { key: 'irritable', menstruation: 1, luteal: 0, other: 0, total: 1, avgIntensity: null },
    { key: 'anxious', menstruation: 0, luteal: 0, other: 1, total: 1, avgIntensity: null },
  ]);
});

// Ein bewusst GELEERTES `feelings: []` ist "keine Gefühle
// mehr" und darf NICHT auf das eingefrorene `mood` zurückfallen - nur wenn
// `feelings` als Schlüssel ganz fehlt (kein Array ist), greift der Fallback.
// Vorher machte `.length` das leere Array ununterscheidbar von "fehlt".
test('feelingFrequencyByPhase: fällt auf das alte Einzelfeld `mood` NUR zurück, wenn `feelings` fehlt (nicht wenn es leer ist)', () => {
  const hist = periods(['2026-05-01'], 5);
  const logs = [
    { log_date: '2026-05-02', mood: 'sad' }, // kein feelings-Schlüssel -> Fallback auf mood
    { log_date: '2026-05-03', feelings: [], mood: 'irritable' }, // explizit geleert -> KEIN Fallback
    { log_date: '2026-05-04', feelings: ['great'], mood: 'sad' }, // feelings hat Vorrang vor mood
  ];
  const byKey = Object.fromEntries(feelingFrequencyByPhase(logs, hist, {}).map((f) => [f.key, f.total]));
  assert.deepEqual(byKey, { sad: 1, great: 1 }); // 'irritable' erscheint NICHT - 05-03 hat keine Gefühle
});

test('normalizeFeelingEntries: leeres `feelings`-Array ist geleert (kein Fallback); fehlendes `feelings` fällt auf `mood` zurück', () => {
  assert.deepEqual(normalizeFeelingEntries({ feelings: [], mood: 'sad' }), []);
  assert.deepEqual(normalizeFeelingEntries({ mood: 'sad' }), [{ key: 'sad', intensity: null }]);
  // Sanity: ein normales, nicht-leeres feelings-Array bleibt unverändert Vorrang.
  assert.deepEqual(normalizeFeelingEntries({ feelings: ['good'], mood: 'sad' }), [{ key: 'good', intensity: null }]);
});

test('feelingFrequencyByPhase: unbekannte Gefühlswerte werden verworfen', () => {
  const hist = periods(['2026-05-01'], 5);
  const logs = [{ log_date: '2026-05-02', feelings: ['not-a-real-feeling', 'good'] }];
  assert.deepEqual(feelingFrequencyByPhase(logs, hist, {}), [
    { key: 'good', menstruation: 1, luteal: 0, other: 0, total: 1, avgIntensity: null },
  ]);
});

test('feelingFrequencyByPhase: ohne jede Periode gibt es keine Klassifikation', () => {
  assert.deepEqual(feelingFrequencyByPhase([{ log_date: '2026-06-01', feelings: ['good'] }], [], {}), []);
});

// --------------------------------------------------------
// periodFlowLoad (v2, B-3)
// --------------------------------------------------------

test('periodFlowLoad: Summe der Flow-Ränge + Anzahl geloggter Tage einer abgeschlossenen Periode', () => {
  const period = { id: 1, start_date: '2026-01-01', end_date: '2026-01-05' };
  const logs = [
    { log_date: '2026-01-01', flow: 'spotting' }, // rank 1
    { log_date: '2026-01-02', flow: 'medium' },   // rank 3
    { log_date: '2026-01-03', flow: 'heavy' },    // rank 4
    { log_date: '2026-01-04', flow: 'light' },    // rank 2
  ];
  assert.deepEqual(periodFlowLoad(period, logs), { load: 10, loggedDays: 4 });
});

test('periodFlowLoad: kein Flow-Log im Zeitraum -> null', () => {
  const period = { id: 1, start_date: '2026-01-01', end_date: '2026-01-05' };
  assert.equal(periodFlowLoad(period, []), null);
});

test('periodFlowLoad: ein unbekannter flow-Wert zählt den Tag mit, trägt aber 0 zur Last bei', () => {
  const period = { id: 1, start_date: '2026-01-01', end_date: '2026-01-03' };
  const logs = [
    { log_date: '2026-01-01', flow: 'not-a-real-level' },
    { log_date: '2026-01-02', flow: 'heavy' },
  ];
  assert.deepEqual(periodFlowLoad(period, logs), { load: 4, loggedDays: 2 });
});

test('periodFlowLoad: offene (laufende) Periode nutzt avgPeriod für die Spanne, wie periodFlowSummary()', () => {
  const period = { id: 1, start_date: '2026-01-01' }; // kein end_date.
  const logs = [
    { log_date: '2026-01-02', flow: 'heavy' },
    { log_date: '2026-01-04', flow: 'heavy' },
  ];
  assert.deepEqual(periodFlowLoad(period, logs, 3), { load: 4, loggedDays: 1 });
  assert.deepEqual(periodFlowLoad(period, logs), { load: 8, loggedDays: 2 });
});

// --------------------------------------------------------
// heavyBleedingSignal (v2, B-4)
// --------------------------------------------------------

test('heavyBleedingSignal: mindestens 3 von 5 abgeschlossenen Episoden "heavy" -> \'heavy\'', () => {
  const hist = periods(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01'], 5);
  const logs = [
    { log_date: '2026-01-02', flow: 'heavy' },
    { log_date: '2026-02-02', flow: 'heavy' },
    { log_date: '2026-03-02', flow: 'heavy' },
    { log_date: '2026-04-02', flow: 'light' },
    { log_date: '2026-05-02', flow: 'light' },
  ];
  assert.equal(heavyBleedingSignal(hist, logs), 'heavy');
});

test('heavyBleedingSignal: eine abgeschlossene Episode über 7 Tage -> \'long\'', () => {
  const hist = [{ id: 1, start_date: '2026-01-01', end_date: '2026-01-09' }]; // 9 Tage
  assert.equal(heavyBleedingSignal(hist, []), 'long');
});

test('heavyBleedingSignal: weder Muster noch lang -> false', () => {
  const hist = periods(['2026-01-01', '2026-02-01'], 5);
  const logs = [{ log_date: '2026-01-02', flow: 'light' }];
  assert.equal(heavyBleedingSignal(hist, logs), false);
});

test('heavyBleedingSignal: eine laufende (nicht abgeschlossene) Episode zählt nicht mit', () => {
  const hist = [{ id: 1, start_date: '2026-01-01' }]; // kein end_date
  assert.equal(heavyBleedingSignal(hist, []), false);
});

test('heavyBleedingSignal: betrachtet nur die letzten 5 abgeschlossenen Episoden', () => {
  // Drei "heavy"-Episoden liegen VOR den letzten 5 (werden also ausgeschlossen);
  // die letzten 5 sind alle "light".
  const oldHeavy = periods(['2025-01-01', '2025-02-01', '2025-03-01'], 5);
  const recentLight = periods(['2025-04-01', '2025-05-01', '2025-06-01', '2025-07-01', '2025-08-01'], 5);
  const hist = [...oldHeavy, ...recentLight];
  const logs = [
    { log_date: '2025-01-02', flow: 'heavy' },
    { log_date: '2025-02-02', flow: 'heavy' },
    { log_date: '2025-03-02', flow: 'heavy' },
  ];
  assert.equal(heavyBleedingSignal(hist, logs), false);
});

// --------------------------------------------------------
// painSummary
// --------------------------------------------------------

test('painSummary: die vier schmerzbezogenen Symptom-Presets', () => {
  assert.deepEqual(PAIN_SYMPTOM_VALUES, ['cramps', 'headache', 'backache', 'joint_pain']);
});

test('painSummary: null ohne jemals ein Schmerz-Symptom geloggt zu haben', () => {
  assert.equal(painSummary([{ log_date: '2026-01-01', symptoms: [{ key: 'fatigue' }] }], [], {}), null);
});

test('painSummary: Schmerztage zählen TAGE (nicht Einzel-Einträge); Ø nur über abgeschlossene Zyklen', () => {
  // Zyklus 1 (abgeschlossen): 2026-01-01..01-29, 2 Schmerztage darin.
  // Zyklus 2 (laufend, kein zweiter Start): ab 2026-01-29.
  const hist = periods(['2026-01-01', '2026-01-29'], 5);
  const logs = [
    { log_date: '2026-01-02', symptoms: [{ key: 'cramps', intensity: 1 }] },
    // EIN Tag mit ZWEI Schmerz-Symptomen zählt trotzdem nur einmal als Schmerztag.
    { log_date: '2026-01-03', symptoms: [{ key: 'cramps', intensity: 2 }, { key: 'headache', intensity: 3 }] },
    { log_date: '2026-01-30', symptoms: [{ key: 'backache' }] }, // laufender Zyklus, ungradiert
  ];
  const summary = painSummary(logs, hist, {}, '2026-02-05');
  assert.equal(summary.currentCyclePainDays, 1);
  assert.equal(summary.avgPainDaysPerCycle, 2); // nur der eine abgeschlossene Zyklus zählt
  assert.equal(summary.avgIntensity, 2); // Mittel aus [1, 2, 3] - die ungradierte Auswahl bleibt außen vor.
});

test('painSummary: der laufende Zyklus zählt Schmerztage nur bis `todayKey`', () => {
  const hist = periods(['2026-01-01'], 5); // eine Periode -> ein laufender Zyklus
  const logs = [
    { log_date: '2026-01-05', symptoms: [{ key: 'cramps' }] }, // vor "heute"
    { log_date: '2026-01-20', symptoms: [{ key: 'cramps' }] }, // nach "heute" - darf nicht zählen
  ];
  const summary = painSummary(logs, hist, {}, '2026-01-10');
  assert.equal(summary.currentCyclePainDays, 1);
  assert.equal(summary.avgPainDaysPerCycle, null); // kein abgeschlossener Zyklus vorhanden
});

// --------------------------------------------------------
// peakPainDay (v2, Nutzer-Feedback)
// --------------------------------------------------------
// Drei Perioden -> zwei ABGESCHLOSSENE Zyklen (2026-01-01..01-29, 01-29..02-26)
// + ein laufender (ab 02-26), der wie bei painSummary()s avgPainDaysPerCycle
// nie mitzählt. Zyklustag 2 ist damit 2026-01-02 im ersten, 2026-01-30 im
// zweiten abgeschlossenen Zyklus.
const peakPainHist = periods(['2026-01-01', '2026-01-29', '2026-02-26'], 5);

test('peakPainDay: Muster gefunden - 2 Zyklen, Tag 2, Ø 2,5', () => {
  const logs = [
    { log_date: '2026-01-02', symptoms: [{ key: 'cramps', intensity: 2 }] },
    { log_date: '2026-01-30', symptoms: [{ key: 'cramps', intensity: 3 }] },
  ];
  const result = peakPainDay(logs, peakPainHist, {});
  assert.deepEqual(result, { cycleDay: 2, symptomKey: 'cramps', avgIntensity: 2.5, cycles: 2 });
});

test('peakPainDay: null unter der Mindest-Intensität (Ø 1,5 < 2)', () => {
  const logs = [
    { log_date: '2026-01-02', symptoms: [{ key: 'cramps', intensity: 1 }] },
    { log_date: '2026-01-30', symptoms: [{ key: 'cramps', intensity: 2 }] },
  ];
  assert.equal(peakPainDay(logs, peakPainHist, {}), null);
});

test('peakPainDay: null mit nur einem abgeschlossenen Zyklus', () => {
  // Nur zwei Perioden -> ein einziger abgeschlossener Zyklus, der laufende
  // zählt nie mit - selbst eine hohe, wiederholte Intensität reicht nicht.
  const hist = periods(['2026-01-01', '2026-01-29'], 5);
  const logs = [
    { log_date: '2026-01-02', symptoms: [{ key: 'cramps', intensity: 3 }] },
  ];
  assert.equal(peakPainDay(logs, hist, {}), null);
});

test('peakPainDay: bei Gleichstand gewinnt der frühere Zyklustag', () => {
  const logs = [
    // Tag 2: Ø (2+3)/2 = 2,5
    { log_date: '2026-01-02', symptoms: [{ key: 'cramps', intensity: 2 }] },
    { log_date: '2026-01-30', symptoms: [{ key: 'cramps', intensity: 3 }] },
    // Tag 5: derselbe Ø 2,5, aber später - darf Tag 2 nicht verdrängen.
    { log_date: '2026-01-05', symptoms: [{ key: 'cramps', intensity: 2 }] },
    { log_date: '2026-02-02', symptoms: [{ key: 'cramps', intensity: 3 }] },
  ];
  const result = peakPainDay(logs, peakPainHist, {});
  assert.equal(result.cycleDay, 2);
  assert.equal(result.avgIntensity, 2.5);
});

test('peakPainDay: null, wenn Schmerz-Symptome nie gradiert wurden', () => {
  const logs = [
    { log_date: '2026-01-02', symptoms: [{ key: 'cramps' }] },
    { log_date: '2026-01-30', symptoms: [{ key: 'cramps' }] },
  ];
  assert.equal(peakPainDay(logs, peakPainHist, {}), null);
});
