/**
 * Modul: Vitalwerte-Aggregation-Test
 * Zweck: Reine Funktion computeVitalSeries() + buildVitalBuckets() —
 *        Zeitraum-Bucketing (week/month/year), Aggregation (Mittelwert je
 *        Bucket), Kennzahlen (letzter Wert + Delta zum Vorwert) und
 *        Typ-/Zeitraum-Filter. DOM-frei.
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-health-vitals.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  computeVitalSeries,
  buildVitalBuckets,
  vitalMetric,
  VITAL_TYPES,
  VITAL_METRICS,
  MOOD_SCALE,
  MOOD_MIN,
  MOOD_MAX,
  moodStep,
  splitDuration,
  durationToHours,
} = await import('../public/utils/health-vitals.js');

// --------------------------------------------------------
// Metrik-Definitionen
// --------------------------------------------------------

test('VITAL_TYPES enthält alle neun Metriken', () => {
  assert.deepEqual(VITAL_TYPES, [
    'bp', 'glucose', 'weight', 'height', 'head_circumference', 'spo2', 'temp', 'sleep', 'mood',
  ]);
  assert.equal(VITAL_METRICS.length, 9);
});

// #683: Körpermaße für Säuglinge. Rohe Messwerte ohne Bewertung - hier steht,
// was das heißt, damit eine spätere Perzentil-Idee als bewusste Erweiterung
// erkennbar ist und nicht als vergessenes Detail.
test('Körpermaße sind schlichte Längen in derselben Einheitenwahl', () => {
  for (const type of ['height', 'head_circumference']) {
    const m = vitalMetric(type);
    assert.ok(m, `${type} fehlt`);
    assert.deepEqual(m.channels, ['value_num'], `${type}: ein Kanal`);
    assert.deepEqual(m.units, ['cm', 'in'], `${type}: metrisch und imperial`);
    assert.equal(m.format, undefined, `${type}: kein Sonderformat`);
    assert.equal(m.domain, undefined, `${type}: keine geklemmte Achse - ein Kind waechst aus jeder`);
  }
});

test('Blutdruck belegt drei Kanäle, übrige Metriken einen', () => {
  assert.deepEqual(vitalMetric('bp').channels, ['value_num', 'value_num2', 'value_num3']);
  assert.deepEqual(vitalMetric('weight').channels, ['value_num']);
  assert.equal(vitalMetric('unknown'), null);
});

// Die Darstellung (Paar, Dauer, Skala) hängt an `format`, nicht am Typ-Namen:
// Karte, Verlaufsliste, Chart und Übersicht fragen ausschließlich dieses Feld
// ab. Ein Tippfehler hier bliebe sonst bis in die Oberfläche unbemerkt.
test('jede Metrik trägt genau ein bekanntes Anzeigeformat', () => {
  const KNOWN = ['pair', 'duration', 'scale'];
  const byType = Object.fromEntries(VITAL_METRICS.map((m) => [m.type, m.format]));
  assert.equal(byType.bp, 'pair');
  assert.equal(byType.sleep, 'duration');
  assert.equal(byType.mood, 'scale');
  for (const m of VITAL_METRICS) {
    if (m.format !== undefined) assert.ok(KNOWN.includes(m.format), `${m.type}: ${m.format}`);
  }
  // Schlichte Zahlenwerte tragen bewusst kein Format.
  assert.equal(byType.weight, undefined);
});

test('Stimmung trägt keine Einheit, Schlaf rechnet in Stunden', () => {
  assert.deepEqual(vitalMetric('mood').units, []);
  assert.deepEqual(vitalMetric('sleep').units, ['h']);
});

// --------------------------------------------------------
// Stimmungs-Skala (#609)
// --------------------------------------------------------

test('MOOD_SCALE ist eine lückenlose 1-5-Skala', () => {
  assert.deepEqual(MOOD_SCALE.map((s) => s.value), [1, 2, 3, 4, 5]);
  assert.equal(MOOD_MIN, 1);
  assert.equal(MOOD_MAX, 5);
  for (const step of MOOD_SCALE) {
    assert.ok(step.labelKey.startsWith('health.vitals.mood.'));
    assert.ok(step.icon);
  }
});

test('moodStep rundet den Tagesmittelwert auf eine Stufe', () => {
  assert.equal(moodStep(4).value, 4);
  assert.equal(moodStep(3.5).value, 4);
  assert.equal(moodStep(3.4).value, 3);
  assert.equal(moodStep('2').value, 2);
});

test('moodStep klemmt außerhalb der Skala statt undefined zu liefern', () => {
  assert.equal(moodStep(0).value, 1);
  assert.equal(moodStep(9).value, 5);
  assert.equal(moodStep(null), null);
  assert.equal(moodStep('keine Zahl'), null);
});

// --------------------------------------------------------
// Schlafdauer (#609)
// --------------------------------------------------------

test('splitDuration zerlegt Dezimalstunden in Stunden und Minuten', () => {
  assert.deepEqual(splitDuration(7.5), { hours: 7, minutes: 30 });
  assert.deepEqual(splitDuration(8), { hours: 8, minutes: 0 });
  assert.deepEqual(splitDuration(0.25), { hours: 0, minutes: 15 });
});

// Rundungsfehler dürfen nicht als "7 h 60 min" herauskommen - die Minute wird
// vor dem Zerlegen gerundet, nicht danach.
test('splitDuration rundet auf die Minute, ohne 60 Minuten zu erzeugen', () => {
  assert.deepEqual(splitDuration(7.999), { hours: 8, minutes: 0 });
  assert.deepEqual(splitDuration(1 / 3), { hours: 0, minutes: 20 });
  assert.equal(splitDuration(-1), null);
  assert.equal(splitDuration('viel'), null);
});

test('durationToHours ist die Umkehrung von splitDuration', () => {
  assert.equal(durationToHours(7, 30), 7.5);
  assert.equal(durationToHours(0, 45), 0.75);
  assert.equal(durationToHours(8, 0), 8);
  for (const value of [6.25, 7.5, 8.75, 0.5]) {
    const { hours, minutes } = splitDuration(value);
    assert.equal(durationToHours(hours, minutes), value);
  }
});

test('durationToHours behandelt leere Felder als null Minuten', () => {
  assert.equal(durationToHours(7, ''), 7);
  assert.equal(durationToHours('', ''), 0);
  assert.equal(durationToHours(-1, 0), null);
});

// Schlaf und Stimmung müssen dieselbe Aggregation wie jede andere Metrik
// durchlaufen - sie sind Kanal-1-Metriken, kein Sonderweg.
test('Schlaf und Stimmung aggregieren wie jede andere Einkanal-Metrik', () => {
  const rows = [
    { id: 1, type: 'sleep', value_num: 7.5, measured_at: '2026-06-15T07:00:00' },
    { id: 2, type: 'sleep', value_num: 6.5, measured_at: '2026-06-16T07:00:00' },
    { id: 3, type: 'mood', value_num: 4, measured_at: '2026-06-15T20:00:00' },
    { id: 4, type: 'mood', value_num: 2, measured_at: '2026-06-15T22:00:00' },
  ];
  const sleep = computeVitalSeries(rows, { type: 'sleep', range: 'month', anchor: '2026-06-15' });
  assert.equal(sleep.latest.id, 2);
  assert.equal(sleep.deltas.value_num, -1);

  const mood = computeVitalSeries(rows, { type: 'mood', range: 'month', anchor: '2026-06-15' });
  // Zwei Einträge am selben Tag mitteln sich zu 3 - moodStep() rundet das zurück
  // auf eine Stufe der Skala.
  const day = mood.points.find((p) => p.date === '2026-06-15');
  assert.equal(day.value_num, 3);
  assert.equal(moodStep(day.value_num).value, 3);
});

// --------------------------------------------------------
// buildVitalBuckets
// --------------------------------------------------------

test('week → 7 Tages-Buckets, from ≤ to', () => {
  const { buckets, from, to, gran } = buildVitalBuckets('week', '2026-06-15');
  assert.equal(buckets.length, 7);
  assert.equal(gran, 'day');
  assert.ok(from <= to);
  assert.equal(buckets[0].date, from);
  assert.equal(buckets[6].date, to);
});

test('month → ein Bucket je Kalendertag (Schaltjahr-korrekt)', () => {
  assert.equal(buildVitalBuckets('month', '2026-06-15').buckets.length, 30); // Juni
  assert.equal(buildVitalBuckets('month', '2026-02-10').buckets.length, 28); // Feb 2026
  assert.equal(buildVitalBuckets('month', '2024-02-10').buckets.length, 29); // Feb 2024 (Schaltjahr)
});

test('year → 12 Monats-Buckets', () => {
  const { buckets, from, to, gran } = buildVitalBuckets('year', '2026-06-15');
  assert.equal(buckets.length, 12);
  assert.equal(gran, 'month');
  assert.equal(buckets[0].key, '2026-01');
  assert.equal(buckets[11].key, '2026-12');
  assert.equal(from, '2026-01-01');
  assert.equal(to, '2026-12-31');
});

// --------------------------------------------------------
// computeVitalSeries — leer / Filter
// --------------------------------------------------------

test('leere Rohdaten → keine Serie, keine Kennzahlen', () => {
  const s = computeVitalSeries([], { type: 'weight', range: 'month', anchor: '2026-06-15' });
  assert.equal(s.hasData, false);
  assert.equal(s.latest, null);
  assert.equal(s.previous, null);
  assert.equal(s.deltas.value_num, null);
  assert.equal(s.points.length, 30);
  assert.ok(s.points.every((p) => p.count === 0 && p.value_num === null));
});

test('fremde Typen werden ignoriert', () => {
  const rows = [
    { id: 1, type: 'glucose', value_num: 95, measured_at: '2026-06-10T08:00' },
    { id: 2, type: 'weight', value_num: 70, measured_at: '2026-06-10T08:00' },
  ];
  const s = computeVitalSeries(rows, { type: 'weight', range: 'month', anchor: '2026-06-15' });
  assert.equal(s.hasData, true);
  assert.equal(s.latest.value_num, 70);
});

// --------------------------------------------------------
// Aggregation (Mittelwert je Bucket)
// --------------------------------------------------------

test('Tages-Bucket mittelt mehrere Messungen desselben Tages', () => {
  const rows = [
    { id: 1, type: 'weight', value_num: 70, measured_at: '2026-06-01T08:00' },
    { id: 2, type: 'weight', value_num: 72, measured_at: '2026-06-01T20:00' },
    { id: 3, type: 'weight', value_num: 69, measured_at: '2026-06-10T08:00' },
  ];
  const s = computeVitalSeries(rows, { type: 'weight', range: 'month', anchor: '2026-06-15' });
  const day1 = s.points.find((p) => p.key === '2026-06-01');
  const day10 = s.points.find((p) => p.key === '2026-06-10');
  assert.equal(day1.count, 2);
  assert.equal(day1.value_num, 71); // (70 + 72) / 2
  assert.equal(day10.count, 1);
  assert.equal(day10.value_num, 69);
});

test('year → Monats-Buckets mitteln über den Monat', () => {
  const rows = [
    { id: 1, type: 'weight', value_num: 70, measured_at: '2026-06-01T08:00' },
    { id: 2, type: 'weight', value_num: 72, measured_at: '2026-06-01T20:00' },
    { id: 3, type: 'weight', value_num: 69, measured_at: '2026-06-10T08:00' },
    { id: 4, type: 'weight', value_num: 80, measured_at: '2026-05-20T08:00' },
  ];
  const s = computeVitalSeries(rows, { type: 'weight', range: 'year', anchor: '2026-06-15' });
  const june = s.points.find((p) => p.key === '2026-06');
  const may = s.points.find((p) => p.key === '2026-05');
  assert.equal(june.count, 3);
  assert.ok(Math.abs(june.value_num - (70 + 72 + 69) / 3) < 1e-9);
  assert.equal(may.count, 1);
  assert.equal(may.value_num, 80);
});

// --------------------------------------------------------
// Kennzahlen: letzter Wert + Delta zum Vorwert
// --------------------------------------------------------

test('Delta = jüngste Messung minus Vormessung, je Kanal (Blutdruck)', () => {
  const rows = [
    { id: 1, type: 'bp', value_num: 120, value_num2: 80, value_num3: 60, measured_at: '2026-06-05T08:00' },
    { id: 2, type: 'bp', value_num: 130, value_num2: 85, value_num3: 62, measured_at: '2026-06-06T08:00' },
  ];
  const s = computeVitalSeries(rows, { type: 'bp', range: 'month', anchor: '2026-06-15' });
  assert.equal(s.latest.id, 2);
  assert.equal(s.previous.id, 1);
  assert.equal(s.deltas.value_num, 10);
  assert.equal(s.deltas.value_num2, 5);
  assert.equal(s.deltas.value_num3, 2);
});

test('Delta ist zeitraum-unabhängig — Vorwert außerhalb des Zeitraums zählt', () => {
  const rows = [
    { id: 1, type: 'weight', value_num: 80, measured_at: '2026-05-20T08:00' }, // Mai, außerhalb Juni
    { id: 2, type: 'weight', value_num: 78, measured_at: '2026-06-10T08:00' }, // Juni
  ];
  const s = computeVitalSeries(rows, { type: 'weight', range: 'month', anchor: '2026-06-15' });
  // Serie (Juni) enthält nur die Juni-Messung ...
  assert.equal(s.points.find((p) => p.key === '2026-06-10').value_num, 78);
  assert.ok(s.points.every((p) => p.key === '2026-06-10' || p.count === 0));
  // ... das Delta bezieht dennoch den Mai-Vorwert ein.
  assert.equal(s.latest.value_num, 78);
  assert.equal(s.previous.value_num, 80);
  assert.equal(s.deltas.value_num, -2);
});

test('einzelne Messung → letzter Wert, aber kein Delta', () => {
  const rows = [{ id: 1, type: 'glucose', value_num: 95, measured_at: '2026-06-10T08:00' }];
  const s = computeVitalSeries(rows, { type: 'glucose', range: 'week', anchor: '2026-06-10' });
  assert.equal(s.latest.value_num, 95);
  assert.equal(s.previous, null);
  assert.equal(s.deltas.value_num, null);
});

// --------------------------------------------------------
// Mobil: Detailblatt je Metrik (Re-Critique 2026-09-27, M3 / A6 P1-2)
// --------------------------------------------------------
//
// Bei 390x844 lag das Diagramm unter neun Kacheln (y=1060, 324x96), der
// Zeitraum-Umschalter 800px darueber, und zwei leere Metriken belegten je eine
// volle Kachel. Die Tests unten bauen ihre Umgebung selbst (Mini-DOM, Rechte,
// openModal-Haken) und raeumen sie wieder ab - sie erben nichts von oben.

const { installMiniDom } = await import('./mini-dom.js');
const { setPermissions, clearPermissions } = await import('../public/permissions.js');
const { readFileSync } = await import('node:fs');
const { eachRule } = await import('./css-rules.js');
const { CHART, chartScales } = await import('../public/utils/chart.js');
const { __test: health } = await import('../public/pages/health.js');

const HEALTH_CSS = readFileSync(new URL('../public/styles/health.css', import.meta.url), 'utf8');

/** Rechte, Mini-DOM und der openModal-Haken fuer EINEN Test; alles geht zurueck -
 *  bei einem async `fn` erst, wenn es fertig ist. */
async function imBlatt(fn, { access = 'write', view = {} } = {}) {
  const abraeumen = installMiniDom();
  const vorherModal = globalThis.__openModal;
  const geoeffnet = [];
  globalThis.__openModal = (opts) => { geoeffnet.push(opts); };
  setPermissions({ admin: false, modules: { health: access }, widgets: {}, capabilities: {} });
  health.setViewStateForTest('vitals', {
    meId: 1, personId: 1, range: 'month', anchor: '2026-09-27', sheetType: null, moreExpanded: false,
    rows: [
      { id: 9, type: 'weight', value_num: 65.2, unit: 'kg', measured_at: '2026-09-22T07:00' },
      { id: 8, type: 'weight', value_num: 65.4, unit: 'kg', measured_at: '2026-09-10T07:00' },
    ],
    ...view,
  });
  try {
    return await fn(geoeffnet);
  } finally {
    health.setViewStateForTest('vitals', { rows: [], sheetType: null, moreExpanded: false, root: null, selectedType: 'bp' });
    clearPermissions();
    if (vorherModal === undefined) delete globalThis.__openModal; else globalThis.__openModal = vorherModal;
    abraeumen();
  }
}

test('M3: mobil oeffnet die Kachel ein Blatt - sie behauptet keinen Umschalt-Zustand, die leere Kachel ist markiert', async () => {
  await imBlatt(() => {
    const weight = vitalMetric('weight');
    const series = computeVitalSeries([{ id: 1, type: 'weight', value_num: 65, measured_at: '2026-09-22T07:00' }], { type: 'weight', range: 'month', anchor: '2026-09-27' });
    const telefon = health.cardMarkup(weight, series, { phone: true });
    assert.match(telefon, /aria-haspopup="dialog"/);
    assert.doesNotMatch(telefon, /aria-pressed/, 'eine Kachel, die ein Blatt oeffnet, ist kein Umschalter');
    const desktop = health.cardMarkup(weight, series);
    assert.match(desktop, /aria-pressed="/, 'am Desktop bleibt sie der Umschalter des Details darunter');
    assert.doesNotMatch(desktop, /aria-haspopup/);
    const leer = health.cardMarkup(vitalMetric('height'), computeVitalSeries([], { type: 'height', range: 'month', anchor: '2026-09-27' }), { phone: true });
    assert.match(leer, /health-vitals__card--empty/);
    assert.doesNotMatch(telefon, /health-vitals__card--empty/);
  });
});

test('M3: leere Metriken stehen in EINER Zeile „Weitere Messwerte", deren Zeilen das Blatt oeffnen', async () => {
  await imBlatt(() => {
    const html = health.moreMetricsMarkup([vitalMetric('height'), vitalMetric('head_circumference')]);
    // `.row-divided` statt `.row-carrier`: die Gesundheit hat einen vollen Kopf,
    // ein Traeger auf dem Mass waere PAGE-016 (test-frontend-audit.js).
    assert.match(html, /^\s*<div class="row-divided health-vitals__more-list">/);
    assert.match(html, /<button type="button" class="health-vitals__more-row health-vitals__more-toggle"\s*aria-expanded="false" aria-controls="health-vitals-more-items">/);
    assert.match(html, /health\.vitals\.moreMetrics/);
    assert.match(html, /health\.vitals\.metric\.height, health\.vitals\.metric\.headCircumference/, 'die Namen stehen in der einen Zeile');
    assert.match(html, /id="health-vitals-more-items" hidden>/, 'eingeklappt');
    assert.equal((html.match(/data-sheet-type="/g) || []).length, 2);
    assert.match(html, /data-sheet-type="height" aria-haspopup="dialog"/);
  });
  await imBlatt(() => {
    const auf = health.moreMetricsMarkup([vitalMetric('height')]);
    assert.match(auf, /aria-expanded="true"/);
    assert.doesNotMatch(auf, /id="health-vitals-more-items" hidden/);
  }, { view: { moreExpanded: true } });
});

test('M3: das Blatt traegt Zeitraum, Stepper, ein hohes Diagramm und die Messliste mit Bearbeiten', async () => {
  await imBlatt((geoeffnet) => {
    health.openVitalSheet('weight');
    assert.equal(geoeffnet.length, 1);
    const blatt = geoeffnet[0];
    assert.equal(blatt.title, 'health.vitals.metric.weight');
    assert.match(blatt.content, /id="health-vital-sheet"/);
    assert.equal(blatt.headerAction?.label, 'health.vitals.addShort', 'Erfassen steht im Kopf des Blatts');

    const html = health.vitalSheetMarkup(vitalMetric('weight'));
    assert.match(html, /class="health-vitals__ranges health-vital-sheet__ranges" role="tablist"/);
    assert.deepEqual([...html.matchAll(/data-sheet-range="(\w+)"/g)].map((m) => m[1]), ['week', 'month', 'year'],
      'der Zeitraum-Umschalter steht IM Blatt');
    assert.match(html, /data-sheet-step="-1"[\s\S]*data-sheet-step="1"/);
    assert.match(html, /data-vital-edit="9"/, 'die Messliste mit dem Bearbeiten-Weg aus R8');
    // Das Diagramm: dieselben Raender, eine hoehere Flaeche - und viewBox wie
    // Seitenverhaeltnis folgen dem, was die Geometrie wirklich zeichnet.
    const geo = health.VITAL_SHEET_CHART;
    assert.equal(geo.W, CHART.W);
    assert.equal(geo.PAD_L, CHART.PAD_L);
    assert.ok(geo.H >= CHART.W * 200 / 290, `H ${geo.H}: bei ~290px Plotbreite (390er Blatt) waeren es unter 200px`);
    const hoch = chartScales(geo).bottom + geo.PAD_B;
    const svg = /<svg class="chart health-chart" viewBox="0 0 (\d+) (\d+)" role="img"([^>]*)>/.exec(html);
    assert.ok(svg, 'das Blatt zeichnet das Diagramm');
    assert.equal(Number(svg[2]), hoch);
    assert.equal(hoch, health.VITAL_SHEET_CHART.H, 'chart.js zeichnet die hohe Flaeche (Wunsch g9 angewandt)');
    if (hoch === CHART.H) assert.doesNotMatch(svg[3], /aspect-ratio/);
    else assert.match(svg[3], new RegExp(`style="aspect-ratio: ${CHART.W} / ${hoch}"`));
    // Die Seite selbst behaelt das geteilte 3:1.
    const seite = health.chartMarkup(vitalMetric('weight'), computeVitalSeries(
      [{ id: 1, type: 'weight', value_num: 65, measured_at: '2026-09-02T07:00' }, { id: 2, type: 'weight', value_num: 66, measured_at: '2026-09-20T07:00' }],
      { type: 'weight', range: 'month', anchor: '2026-09-27' }));
    assert.match(seite, new RegExp(`viewBox="0 0 ${CHART.W} ${CHART.H}" role="img"\\s*aria-label`));

    blatt.onClose();
  });
  await imBlatt((geoeffnet) => {
    health.openVitalSheet('weight');
    assert.equal(geoeffnet[0].headerAction, null, 'ohne Schreibrecht kein Erfassen');
    assert.doesNotMatch(health.vitalSheetMarkup(vitalMetric('weight')), /data-vital-edit/);
  }, { access: 'read' });
  await imBlatt(() => {
    const leer = health.vitalSheetMarkup(vitalMetric('height'));
    assert.match(leer, /health\.vitals\.noValue/);
    assert.doesNotMatch(leer, /data-sheet-range|data-sheet-step/, 'ohne Wert gibt es keinen Zeitraum zum Blaettern');
  });
});

test('M3: Bearbeiten aus dem Blatt fuehrt im selben Zug zurueck ins Blatt - ausser ein anderer Dialog hat uebernommen', async () => {
  const messung = { id: 9, type: 'weight', value_num: 65.2, unit: 'kg', measured_at: '2026-09-22T07:00' };
  await imBlatt((geoeffnet) => {
    const zurueck = () => {};
    health.openVitalModal({ row: messung, onClose: zurueck });
    assert.equal(geoeffnet.at(-1).onClose, zurueck, 'der Dialog reicht den Rueckweg an openModal weiter');
  });
  // Die Verdrahtung: Bearbeiten und Erfassen aus dem Blatt nehmen den Rueckweg mit.
  const src = readFileSync(new URL('../public/pages/health.js', import.meta.url), 'utf8');
  assert.match(src, /openVitalModal\(\{ row, onClose: \(\) => backToVitalSheet\(metric\.type\) \}\)/);
  assert.match(src, /openVitalModal\(\{ onClose: \(\) => backToVitalSheet\(metric\.type\) \}\)/);

  await imBlatt(async (geoeffnet) => {
    health.setViewStateForTest('vitals', { root: { isConnected: true } });
    // Der Dialog schliesst gerade: kein Overlay ohne Ausgangsklasse.
    globalThis.document.querySelector = () => null;
    health.backToVitalSheetForTest('weight');
    assert.equal(geoeffnet.length, 0, 'nicht synchron - erst nach dem Zug, der schliesst');
    await Promise.resolve();
    assert.equal(geoeffnet.length, 1, 'das Blatt geht wieder auf, solange der alte Dialog noch steht');
    assert.equal(geoeffnet[0].title, 'health.vitals.metric.weight');
    // Ein anderer Dialog hat uebernommen: das Blatt bleibt zu.
    globalThis.document.querySelector = (sel) => (sel === '.modal-overlay:not(.modal-overlay--closing)' ? {} : null);
    health.backToVitalSheetForTest('weight');
    await Promise.resolve();
    assert.equal(geoeffnet.length, 1);
    // Die Ansicht ist weg (Navigation): ebenso.
    globalThis.document.querySelector = () => null;
    health.setViewStateForTest('vitals', { root: { isConnected: false } });
    health.backToVitalSheetForTest('weight');
    await Promise.resolve();
    assert.equal(geoeffnet.length, 1);
  });
  // Und NICHT ueber whenModalClosed: dessen Warten liess den History-Marker
  // fallen, bevor das Blatt ihn neu legte (gemessen: X fuehrte eine Seite zurueck).
  const weg = src.slice(src.indexOf('function backToVitalSheet('), src.indexOf('function refreshVitalSheet('));
  assert.match(weg, /queueMicrotask\(/);
  assert.doesNotMatch(weg.replace(/\/\*[\s\S]*?\*\//g, ''), /whenModalClosed\(/);
});

test('M3: unter 640px entfallen Seiten-Umschalter, Detail und leere Kacheln; die Zeile gibt es nur dort', () => {
  const rules = [...eachRule(HEALTH_CSS)];
  const phone = (r) => r.at.some((a) => /max-width:\s*639px/.test(a));
  const hidden = rules.filter((r) => phone(r) && /display:\s*none/.test(r.body)).map((r) => r.selector);
  for (const sel of ['.health-vitals__toolbar', '.health-vitals__detail', '.health-vitals__cards > .health-vitals__card--empty']) {
    assert.ok(hidden.some((s) => s.split(',').map((x) => x.trim()).includes(sel)), `${sel} bleibt mobil stehen`);
  }
  const base = rules.find((r) => r.at.length === 0 && r.selector.trim() === '.health-vitals__more');
  assert.ok(base && /display:\s*none/.test(base.body), 'ab 640px gibt es keine Zeile „Weitere Messwerte"');
  const shown = rules.find((r) => phone(r) && r.selector.trim() === '.health-vitals__more');
  assert.ok(shown && /display:\s*block/.test(shown.body));
  assert.ok(!rules.some((r) => !phone(r) && /health-vitals__card--empty/.test(r.selector) && /display:\s*none/.test(r.body)),
    'am Desktop bleiben die leeren Kacheln');
});

// --------------------------------------------------------
// Achsen, die man ablesen kann (Re-Critique 2026-09-27, C4)
// --------------------------------------------------------
//
// Zwei Befunde an derselben Geometrie: die Y-Achse teilte die rohe Spanne in
// Viertel (Blutdruck 126/108/91/73/55), und die X-Achse zaehlte Punkte statt
// Tage - beim Blutdruck auf die Datenspanne geklemmt (09.09. und 20.09. an den
// Plotkanten unter einem Kopf "01.09. - 30.09."), bei den Laborbefunden nach
// Nummer (Januar, Februar, Dezember in gleichen Abstaenden).

const { niceDomain } = await import('../public/utils/chart.js');

/** Ist `step` 1, 2, 2,5 oder 5 mal eine Zehnerpotenz? */
const rund = (step) => {
  const f = step / 10 ** Math.floor(Math.log10(step) + 1e-9);
  return [1, 2, 2.5, 5].some((n) => Math.abs(f - n) < 1e-6);
};
const yTicks = (svg) => [...svg.matchAll(/class="chart__axis chart__axis--y"[^>]*>([^<]*)</g)]
  .map((m) => Number(m[1].replace(/\./g, '').replace(',', '.')));

test('niceDomain: die Skala enthaelt die Daten und steht auf runden Schritten', () => {
  const faelle = [[55, 126], [0, 5550], [0.5, 1.2], [36.1, 37.4], [60, 60], [-3, 7], [1200, 1320], [0, 23.5], [0, 0], [0.001, 0.0042]];
  for (const [lo, hi] of faelle) {
    const d = niceDomain(lo, hi);
    assert.ok(d.min <= lo && d.max >= hi, `${lo}-${hi}: ${d.min}-${d.max} schneidet ab`);
    assert.ok(d.steps >= 3 && d.steps <= 6, `${lo}-${hi}: ${d.steps} Schritte`);
    assert.ok(rund(d.step), `${lo}-${hi}: Schritt ${d.step} ist nicht rund`);
    assert.ok(Math.abs((d.max - d.min) / d.steps - d.step) < 1e-9, `${lo}-${hi}: Schritte passen nicht in die Spanne`);
    assert.ok(Math.abs(d.min / d.step - Math.round(d.min / d.step)) < 1e-6, `${lo}-${hi}: Unterkante ${d.min} liegt neben dem Raster`);
    if (lo >= 0) assert.ok(d.min >= 0, `${lo}-${hi}: erfindet eine Unterkante unter 0`);
  }
  for (const hi of [1, 3, 7, 13, 5550]) {
    assert.ok(Number.isInteger(niceDomain(0, hi, { integer: true }).step), `ganzzahlig ${hi}`);
  }
});

test('Vitalwerte: runde Achsenwerte und eine X-Achse ueber den ganzen Zeitraum', () => {
  const rows = [
    { id: 1, type: 'bp', value_num: 126, value_num2: 82, value_num3: 71, measured_at: '2026-09-09T08:00' },
    { id: 2, type: 'bp', value_num: 118, value_num2: 76, value_num3: 55, measured_at: '2026-09-20T08:00' },
  ];
  const series = computeVitalSeries(rows, { type: 'bp', range: 'month', anchor: '2026-09-15' });
  const svg = health.chartMarkup(vitalMetric('bp'), series);
  const ticks = yTicks(svg);
  assert.ok(ticks.length >= 4, `keine Werteachse gefunden: ${ticks}`);
  const step = Math.abs(ticks[0] - ticks[1]);
  assert.ok(rund(step), `Achse ${ticks.join('/')} steht nicht auf runden Schritten`);
  assert.ok(ticks.every((v) => Math.abs(v / step - Math.round(v / step)) < 1e-6), `Achse ${ticks.join('/')}`);

  const { left, right } = chartScales();
  const cx = [...svg.matchAll(/<circle cx="([\d.]+)"/g)].map((m) => Number(m[1]));
  const erster = Math.min(...cx);
  const letzter = Math.max(...cx);
  // 09.09. ist Tag 8 von 29 Schritten, 20.09. Tag 19: nicht an den Kanten.
  assert.ok(Math.abs(erster - (left + (8 / 29) * (right - left))) < 1, `09.09. steht bei ${erster}, nicht an seinem Tag`);
  assert.ok(Math.abs(letzter - (left + (19 / 29) * (right - left))) < 1, `20.09. steht bei ${letzter}, nicht an seinem Tag`);
});

test('Laborbefunde liegen nach ihrem Datum, nicht nach ihrer Nummer', () => {
  const punkte = [
    { date: '2026-01-01', value: 5.1, unit: 'mmol/l', flag: null, refLow: null, refHigh: null },
    { date: '2026-02-01', value: 5.4, unit: 'mmol/l', flag: null, refLow: null, refHigh: null },
    { date: '2026-12-31', value: 6.0, unit: 'mmol/l', flag: null, refLow: null, refHigh: null },
  ];
  const svg = health.labTrendChart(punkte, 'HbA1c');
  const { left, right } = chartScales();
  const cx = [...svg.matchAll(/<circle cx="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.equal(cx.length, 3);
  const erwartet = left + (31 / 364) * (right - left);
  assert.ok(Math.abs(cx[1] - erwartet) < 1, `Februar steht bei ${cx[1]}, erwartet ${erwartet.toFixed(1)} (nicht in der Mitte)`);
  const ticks = yTicks(svg);
  assert.ok(rund(Math.abs(ticks[0] - ticks[1])), `Achse ${ticks.join('/')}`);
});

// Review R11: die Nullspannen-Regel steht zentral in chartTimePositions - der
// Laborverlauf hatte sie selbst, der Kilometerstand im Inventar nicht.
test('Befunde am selben Tag: die Zeitachse verteilt nach dem Index statt auf die linke Kante', async () => {
  const { chartTimePositions } = await import('../public/utils/chart.js');
  const { left, right } = chartScales();
  assert.deepEqual(chartTimePositions([]), []);
  assert.deepEqual(chartTimePositions(['2026-03-01']), [left]);
  const gleich = chartTimePositions(['2026-03-01', '2026-03-01', '2026-03-01']);
  assert.deepEqual(gleich.map((x) => Math.round(x)), [left, (left + right) / 2, right].map(Math.round));
  const punkte = [
    { date: '2026-03-01', value: 5.1, unit: 'mmol/l', flag: null, refLow: null, refHigh: null },
    { date: '2026-03-01', value: 5.4, unit: 'mmol/l', flag: null, refLow: null, refHigh: null },
  ];
  const cx = [...health.labTrendChart(punkte, 'HbA1c').matchAll(/<circle cx="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.equal(cx.length, 2);
  assert.notEqual(cx[0], cx[1], 'zwei Befunde vom selben Tag sind zwei Punkte');
});

test('Schlaf auf der Karte: kurze Form „7:30" plus Einheit, der lange Satz bleibt Verlauf und Tooltip (Re-Critique 2026-09-28 A6 P2-4)', async () => {
  // Gemessen bei 390px: „7 Std. 30 Min." scrollWidth 173 > clientWidth 147 -
  // der Wert lief 13px ueber die Kartenkante. panel.css sagt selbst: zu lange
  // Werte werden geteilt, nicht weiter verkleinert.
  await imBlatt(() => {
    const sleep = vitalMetric('sleep');
    const series = computeVitalSeries([{ id: 1, type: 'sleep', value_num: 7.5, measured_at: '2026-09-22T07:00' }], { type: 'sleep', range: 'month', anchor: '2026-09-27' });
    for (const [wo, html] of [['Karte', health.cardMarkup(sleep, series, { phone: true })], ['Uebersicht', health.overviewVitalCardMarkup(sleep, series)]]) {
      const wert = html.match(/<span class="metric-card__value">([^<]*)<\/span>/)?.[1];
      assert.equal(wert, '7:30', `${wo}: der Wert ist die kurze Form`);
      assert.match(html, /<span class="metric-card__unit">[^<]+<\/span>/, `${wo}: die Einheit steht daneben`);
      assert.doesNotMatch(html, /health\.duration\.hm/, `${wo}: kein Satz „7 Std. 30 Min." auf der Karte`);
    }
    const kurz = computeVitalSeries([{ id: 2, type: 'sleep', value_num: 6 + 5 / 60, measured_at: '2026-09-22T07:00' }], { type: 'sleep', range: 'month', anchor: '2026-09-27' });
    assert.match(health.cardMarkup(sleep, kurz), /<span class="metric-card__value">6:05<\/span>/, 'Minuten zweistellig');
  });
});

// --------------------------------------------------------
// Gleitendes Standardfenster (Critique 2026-10-05, R16)
// --------------------------------------------------------
//
// Der Standard "Monat" war der KALENDERMONAT. Am 05.10. zeigte er fuenf Tage,
// und ueber vier Messungen der Vorwoche stand "Zu wenige Messwerte fuer einen
// Trend". Der laufende Zeitraum ist jetzt gleitend - die letzten 30 bzw. 7
// Tage, endend HEUTE -, und wer in die Vergangenheit blaettert, bekommt wie
// bisher den Kalendermonat bzw. die Kalenderwoche. `today` ist ein Parameter,
// damit die Regel ohne Uhr pruefbar ist; der letzte Test nagelt Uhr UND Zone
// fest und laesst den Standard selbst rechnen.

const R16_TODAY = '2026-10-05'; // Montag

test('R16: der laufende Monat sind die letzten 30 Tage, endend heute', () => {
  const { buckets, from, to, gran } = buildVitalBuckets('month', R16_TODAY, 1, { today: R16_TODAY });
  assert.equal(from, '2026-09-06');
  assert.equal(to, R16_TODAY);
  assert.equal(buckets.length, 30);
  assert.equal(gran, 'day');
  // Jeder Tag des Monats landet im gleitenden Fenster, nicht nur der Monatserste.
  assert.equal(buildVitalBuckets('month', '2026-10-01', 1, { today: R16_TODAY }).to, R16_TODAY);
});

test('R16: die laufende Woche sind die letzten 7 Tage, endend heute', () => {
  const { buckets, from, to } = buildVitalBuckets('week', R16_TODAY, 1, { today: R16_TODAY });
  assert.equal(from, '2026-09-29');
  assert.equal(to, R16_TODAY);
  assert.equal(buckets.length, 7);
});

test('R16: wer zurueckblaettert, bekommt den Kalendermonat und die Kalenderwoche', () => {
  const month = buildVitalBuckets('month', '2026-09-05', 1, { today: R16_TODAY });
  assert.deepEqual([month.from, month.to], ['2026-09-01', '2026-09-30']);
  const week = buildVitalBuckets('week', '2026-09-28', 1, { today: R16_TODAY });
  assert.deepEqual([week.from, week.to], ['2026-09-28', '2026-10-04']);
  // Auch nach vorn: ein Zeitraum, der heute nicht enthaelt, ist ein Kalenderfenster.
  const next = buildVitalBuckets('month', '2026-11-05', 1, { today: R16_TODAY });
  assert.deepEqual([next.from, next.to], ['2026-11-01', '2026-11-30']);
});

// Review PR #1673: das gleitende Fenster endet heute, "Weiter" begann erst mit
// dem naechsten Kalenderzeitraum. Der Rest der laufenden Woche / des laufenden
// Monats lag damit in KEINEM erreichbaren Fenster - und Messwerte duerfen ein
// Datum in der Zukunft tragen. Ein Anker hinter heute meint jetzt das
// Kalenderfenster, und das Blaettern haelt dort an.

const vitalsModule = await import('../public/utils/health-vitals.js');

test('R16: ein Anker hinter heute im laufenden Zeitraum zeigt das Kalenderfenster', () => {
  const week = buildVitalBuckets('week', '2026-10-08', 1, { today: R16_TODAY });
  assert.deepEqual([week.from, week.to], ['2026-10-05', '2026-10-11']);
  const month = buildVitalBuckets('month', '2026-10-31', 1, { today: R16_TODAY });
  assert.deepEqual([month.from, month.to], ['2026-10-01', '2026-10-31']);
  // Ein Messwert von uebermorgen steht damit in einem erreichbaren Fenster.
  const rows = [{ id: 1, type: 'weight', value_num: 70, unit: 'kg', measured_at: '2026-10-07T07:00' }];
  const series = computeVitalSeries(rows, { type: 'weight', range: 'week', anchor: '2026-10-11', today: R16_TODAY });
  assert.equal(series.hasData, true);
});

/** Laeuft `steps` Schritte und sammelt die Fenster [from, to] in Leserichtung. */
function walkWindows(range, start, dir, steps, today) {
  const out = [];
  let anchor = start;
  for (let i = 0; i <= steps; i++) {
    const { from, to } = buildVitalBuckets(range, anchor, 1, { today });
    out.push([from, to]);
    anchor = vitalsModule.stepVitalAnchor(range, anchor, dir, 1, { today });
  }
  return out;
}

function nextDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d + 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

test('R16: Blaettern laesst keinen Tag aus - jedes Fenster beginnt spaetestens am Tag nach dem vorigen', () => {
  // Montag, Mittwoch, Sonntag (letzter Tag der Woche), Monatsletzter, 31. Januar.
  for (const today of ['2026-10-05', '2026-10-07', '2026-10-11', '2026-10-31', '2027-01-31']) {
    for (const range of ['week', 'month']) {
      let start = today;
      for (let i = 0; i < 4; i++) start = vitalsModule.stepVitalAnchor(range, start, -1, 1, { today });
      const forward = walkWindows(range, start, 1, 9, today);
      for (let i = 1; i < forward.length; i++) {
        assert.ok(forward[i][0] <= nextDay(forward[i - 1][1]),
          `${range} am ${today}: Luecke zwischen ${forward[i - 1]} und ${forward[i]}`);
        assert.ok(forward[i][1] > forward[i - 1][1], `${range} am ${today}: ${forward[i]} fuehrt nicht weiter`);
      }
      // Zurueck ueber dieselben Fenster, in umgekehrter Reihenfolge.
      let end = start;
      for (let i = 0; i < 9; i++) end = vitalsModule.stepVitalAnchor(range, end, 1, 1, { today });
      assert.deepEqual(walkWindows(range, end, -1, 9, today), [...forward].reverse(), `${range} am ${today}: Rueckweg`);
    }
  }
});

test('R16: die Folge am Montag, 05.10. - vorige Woche, gleitend, laufende Woche, naechste Woche', () => {
  const start = vitalsModule.stepVitalAnchor('week', R16_TODAY, -1, 1, { today: R16_TODAY });
  assert.deepEqual(walkWindows('week', start, 1, 3, R16_TODAY), [
    ['2026-09-28', '2026-10-04'],
    ['2026-09-29', '2026-10-05'],
    ['2026-10-05', '2026-10-11'],
    ['2026-10-12', '2026-10-18'],
  ]);
  const monthStart = vitalsModule.stepVitalAnchor('month', R16_TODAY, -1, 1, { today: R16_TODAY });
  assert.deepEqual(walkWindows('month', monthStart, 1, 3, R16_TODAY), [
    ['2026-09-01', '2026-09-30'],
    ['2026-09-06', '2026-10-05'],
    ['2026-10-01', '2026-10-31'],
    ['2026-11-01', '2026-11-30'],
  ]);
  // Am 31. reichen 30 Tage nur bis zum 2. - der Monatserste gehoert dazu.
  const last = buildVitalBuckets('month', '2026-10-31', 1, { today: '2026-10-31' });
  assert.deepEqual([last.from, last.to, last.buckets.length], ['2026-10-01', '2026-10-31', 31]);
  // Am letzten Tag des Zeitraums liegt nichts mehr dahinter: kein Zwischenhalt.
  assert.equal(vitalsModule.stepVitalAnchor('week', '2026-10-11', 1, 1, { today: '2026-10-11' }), '2026-10-18');
  // Das Jahr blaettert wie bisher.
  assert.equal(vitalsModule.stepVitalAnchor('year', R16_TODAY, -1, 1, { today: R16_TODAY }), '2025-10-05');
});

test('R16: die Seite blaettert ueber die Bausteine, nicht ueber eigene Kalenderrechnung', () => {
  const src = readFileSync(new URL('../public/pages/health.js', import.meta.url), 'utf8');
  assert.match(src, /function stepAnchor\(dir\) \{\s*vitals\.anchor = stepVitalAnchor\(vitals\.range, vitals\.anchor, dir\);\s*\}/);
  assert.match(src, /function stepActivityWeek\(dir\) \{\s*activity\.anchor = stepActivityAnchor\(activity\.anchor, dir\);\s*\}/);
});

test('R16: vier Messungen der Vorwoche ergeben am Monatsanfang einen Trend', () => {
  const rows = ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'].map((day, i) => (
    { id: i + 1, type: 'weight', value_num: 70 + i / 10, unit: 'kg', measured_at: `${day}T07:00` }));
  const series = computeVitalSeries(rows, { type: 'weight', range: 'month', anchor: R16_TODAY, today: R16_TODAY });
  assert.equal(series.points.filter((p) => p.count > 0).length, 4, 'alle vier liegen im Fenster');
  assert.deepEqual([series.from, series.to], ['2026-09-06', R16_TODAY], 'die Beschriftung nennt den gleitenden Bereich');
  const svg = health.chartMarkup(vitalMetric('weight'), series);
  assert.match(svg, /<polyline/, 'eine Kurve, kein "zu wenige Messwerte"');
  assert.doesNotMatch(svg, /health\.vitals\.sparse/);
});

test('R16: "heute" ist der Tag des HAUSHALTS, auch wenn das Geraet noch im Vortag steht', async () => {
  const { mock } = await import('node:test');
  const tz = await import('/utils/timezone.js');
  const prevTz = process.env.TZ;
  // 23:30 UTC am 04.10.: in Berlin 01:30 am 05.10., in Los Angeles 16:30 am 04.10.
  process.env.TZ = 'America/Los_Angeles';
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-04T23:30:00Z') });
  tz.setDisplayTimeZone('Europe/Berlin');
  try {
    assert.equal(new Date().getDate(), 4, 'das Geraet steht im Vortag');
    const month = buildVitalBuckets('month');
    assert.deepEqual([month.from, month.to], ['2026-09-06', '2026-10-05']);
    const week = buildVitalBuckets('week');
    assert.deepEqual([week.from, week.to], ['2026-09-29', '2026-10-05']);
  } finally {
    tz.setDisplayTimeZone(null);
    mock.timers.reset();
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
  }
});

test('R16: die Jahresachse nennt Monate, keine Monatsersten', () => {
  const rows = [
    { id: 1, type: 'weight', value_num: 70, unit: 'kg', measured_at: '2026-02-10T07:00' },
    { id: 2, type: 'weight', value_num: 71, unit: 'kg', measured_at: '2026-08-10T07:00' },
  ];
  const series = computeVitalSeries(rows, { type: 'weight', range: 'year', anchor: R16_TODAY, today: R16_TODAY });
  const svg = health.chartMarkup(vitalMetric('weight'), series);
  const axis = [...svg.matchAll(/class="chart__axis" text-anchor="[a-z]+">([^<]*)</g)].map((m) => m[1]);
  assert.equal(axis.length, 3);
  for (const label of axis) {
    assert.doesNotMatch(label, /^\d{4}-\d{2}-01$/, `"${label}" ist ein Tagesdatum fuer einen Monatspunkt`);
  }
  assert.doesNotMatch(svg, /<title>[^<]*2026-0[28]-01/, 'auch der Punkt nennt seinen Monat, nicht dessen ersten Tag');
});
