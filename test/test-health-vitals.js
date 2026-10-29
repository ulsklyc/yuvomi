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

test('M3: mobil oeffnet die Kachel ein Blatt - sie behauptet keinen Umschalt-Zustand', async () => {
  await imBlatt(() => {
    const weight = vitalMetric('weight');
    const series = computeVitalSeries([{ id: 1, type: 'weight', value_num: 65, measured_at: '2026-09-22T07:00' }], { type: 'weight', range: 'month', anchor: '2026-09-27' });
    const telefon = health.cardMarkup(weight, series, { phone: true });
    assert.match(telefon, /aria-haspopup="dialog"/);
    assert.doesNotMatch(telefon, /aria-pressed/, 'eine Kachel, die ein Blatt oeffnet, ist kein Umschalter');
    const desktop = health.cardMarkup(weight, series);
    assert.match(desktop, /aria-pressed="/, 'am Desktop bleibt sie der Umschalter des Details darunter');
    assert.doesNotMatch(desktop, /aria-haspopup/);
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
    assert.match(html, /class="segmented health-vitals__ranges health-vital-sheet__ranges" role="tablist"/, 'das Kanon-Segment (R24 G5 P2-6)');
    assert.deepEqual([...html.matchAll(/data-sheet-range="(\w+)"/g)].map((m) => m[1]), ['day', 'week', 'month', 'year'],
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

test('M3 + R21: unter 640px entfallen Zeitraum und Detail; leere Messarten stehen auf jeder Breite in der Zeile', () => {
  const rules = [...eachRule(HEALTH_CSS)];
  const phone = (r) => r.at.some((a) => /max-width:\s*639px/.test(a));
  const hidden = rules.filter((r) => phone(r) && /display:\s*none/.test(r.body)).map((r) => r.selector);
  for (const sel of ['.health-vitals__toolbar', '.health-vitals__detail']) {
    assert.ok(hidden.some((s) => s.split(',').map((x) => x.trim()).includes(sel)), `${sel} bleibt mobil stehen`);
  }
  // R21 (D6): keine leere Kachel mehr, auch nicht am Desktop - die Zeile
  // "Weitere Messwerte" steht auf jeder Breite.
  assert.ok(!rules.some((r) => r.at.length === 0 && r.selector.trim() === '.health-vitals__more' && /display:\s*none/.test(r.body)),
    'die Zeile "Weitere Messwerte" ist nicht auf das Telefon beschraenkt');
  assert.doesNotMatch(HEALTH_CSS, /health-vitals__card--empty/, 'eine leere Kachel gibt es nicht mehr');
  const leer = rules.filter((r) => r.at.length === 0 && /\.health-vitals--empty/.test(r.selector)).map((r) => r.selector).join(',');
  assert.match(leer, /\.health-vitals--empty \.health-vitals__toolbar/);
  assert.match(leer, /\.health-vitals--empty \.health-vitals__detail/);
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

/* KENNZAHLKARTEN MIT FESTER ANATOMIE (Critique R18, 2026-10-07). Gesehen in der
 * Vitalreihe: die Datumszeilen auf drei Hoehen (mit Trendlinie, ohne, mit
 * zweizeiligem Label), "SAUERSTOFFSÄTTI-/GUNG" als gesperrte Versalzeile, die
 * Einheit unter dem Wert ("116/74" / "mmHg"), graue Haarlinien als Trend. */
test('R18: die Kennzahlkarte hat vier feste Zeilen - Kopf, Wert, Trendlinie, Meta', async () => {
  const panel = readFileSync(new URL('../public/styles/panel.css', import.meta.url), 'utf8');
  const typo = readFileSync(new URL('../public/styles/typography.css', import.meta.url), 'utf8');
  const rules = [...eachRule(panel)];
  const body = (sel, at = () => true) => rules.filter((r) => r.selector.split(',').map((s) => s.trim()).includes(sel) && at(r)).map((r) => r.body).join(';');
  const plain = (r) => r.at.length === 0;
  // Jeder Teil hat seine Zeile - eine fehlende Trendlinie zieht die Meta-Zeile nicht hoch.
  assert.match(body('.metric-rows > .metric-card', plain), /grid-template-rows:\s*auto auto minmax\(var\(--metric-spark-row, 0px\), auto\) auto/);
  for (const [part, row] of [['head', 1], ['body', 2], ['spark', 3], ['meta', 4], ['note', 4]]) {
    assert.match(body(`.metric-rows > .metric-card > .metric-card__${part}`), new RegExp(`grid-row:\\s*${row}\\b`), `.metric-card__${part} steht in Zeile ${row}`);
  }
  // Subgrid: die Karten EINER Rasterzeile teilen sich die vier Zeilenhoehen. Nur als Aufsatz.
  const sub = (r) => r.at.some((a) => /@supports\s*\(grid-template-rows:\s*subgrid\)/.test(a));
  assert.match(body('.metric-rows > .metric-card', sub), /grid-row:\s*span 4/);
  assert.match(body('.metric-rows > .metric-card', sub), /grid-template-rows:\s*subgrid/);
  assert.doesNotMatch(body('.metric-rows > .metric-card', plain), /subgrid/, 'ohne Subgrid bleibt der Rueckfall mit festen Zeilen');
  // Beide Vitalraster tragen die Anatomie und melden sich als Reihe (Kompaktstufe des Werts).
  const src = readFileSync(new URL('../public/pages/health.js', import.meta.url), 'utf8');
  assert.match(src, /<div class="health-vitals__cards metric-rows" id="health-vitals-cards">/);
  assert.match(src, /<div class="health-overview__vitals-grid metric-rows">/);
  const healthRules = [...eachRule(HEALTH_CSS)];
  for (const grid of ['.health-vitals__cards', '.health-overview__vitals-grid']) {
    const r = healthRules.find((x) => x.at.length === 0 && x.selector.trim() === grid);
    assert.match(r.body, /container:\s*metric-grid \/ inline-size/, `${grid}: ohne die Reihe stuende "116/74 mmHg" auf dem Telefon in 28px und braeche um`);
  }
  // Das Label: Satzschreibung, eine Zeile hoch gedacht - nicht mehr im Versal-Block.
  const label = body('.metric-card__label', plain);
  assert.match(label, /letter-spacing:\s*var\(--tracking-normal\)/);
  assert.doesNotMatch(label, /text-transform/);
  const versal = [...eachRule(typo)].find((r) => /text-transform:\s*uppercase/.test(r.body) && /letter-spacing:\s*var\(--tracking-label\)/.test(r.body));
  assert.ok(versal, 'der Versal-Block steht noch');
  assert.ok(!versal.selector.split(',').map((s) => s.trim()).includes('.metric-card__label'), 'das Kennzahl-Label steht nicht mehr im Versal-Block');
  // Wert und Einheit: eine Grundlinie.
  assert.match(body('.metric-card__body', plain), /align-items:\s*baseline/);

  // Die Karte selbst: Teile in der Reihenfolge der Zeilen.
  await imBlatt(() => {
    const weight = vitalMetric('weight');
    const series = computeVitalSeries([
      { id: 1, type: 'weight', value_num: 65, measured_at: '2026-09-22T07:00' },
      { id: 2, type: 'weight', value_num: 66, measured_at: '2026-09-12T07:00' },
    ], { type: 'weight', range: 'month', anchor: '2026-09-27' });
    const html = health.cardMarkup(weight, series);
    const order = ['metric-card__head', 'metric-card__body', 'metric-card__spark', 'metric-card__meta'].map((cls) => html.indexOf(`class="${cls}"`));
    assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `Kopf, Wert, Trendlinie, Meta: ${order}`);
    // Trendlinie: Flaeche unter der Linie, Endpunkt als Linie der Laenge null (kein gestreckter Kreis).
    const spark = html.slice(html.indexOf('<svg class="metric-card__spark"'), html.indexOf('</svg>'));
    assert.match(spark, /<linearGradient id="metric-spark-weight"/);
    assert.match(spark, /<polygon class="metric-card__spark-area" fill="url\(#metric-spark-weight\)"/);
    assert.match(spark, /<line class="metric-card__spark-end" x1="([\d.]+)" x2="\1" y1="([\d.]+)" y2="\2" vector-effect="non-scaling-stroke" \/>/);
    assert.doesNotMatch(spark, /<circle/, 'preserveAspectRatio="none" streckte den Kreis zur Ellipse');
    assert.doesNotMatch(spark, /stroke="var\(|fill="var\(/, 'die Farbe steht am geteilten Bauteil, nicht im Markup');
    assert.match(spark, /aria-hidden="true"/);
  });
  // Farbe: Modulton mit Rueckfall, Flaeche laeuft auf 0, Endpunkt in Label-Farbe.
  assert.match(body('.metric-card__spark', plain), /color:\s*var\(--module-accent, var\(--color-text-secondary\)\)/);
  // R24 S15: die Wurzel fuellt nicht. Ohne Angabe ist `fill` schwarz - Sonde 14
  // las die Trendlinie der Uebersicht im Dark als #000 auf #37332E (1,68:1).
  assert.match(body('.metric-card__spark', plain), /(?:^|;)\s*fill:\s*none\b/, 'das SVG traegt fill: none, die Tinte ist currentColor');
  assert.match(body('.metric-card__spark-to'), /stop-opacity:\s*0\b/);
  assert.match(body('.metric-card__spark-end'), /stroke:\s*var\(--color-text-primary\)/);
  // Grafikkontrast 3:1 der Linie gegen Karte und Well, beide Themes (Gesundheitston).
  const { contrastRatio } = await import('../public/utils/contrast.js');
  const tokens = readFileSync(new URL('../public/styles/tokens.css', import.meta.url), 'utf8');
  for (const [name, ink, surface] of [['hell/Karte', '#9E1E88', '#FFFFFF'], ['hell/Well', '#9E1E88', '#EDEAE3'], ['dunkel/Karte', '#DB60CB', '#2B2825'], ['dunkel/Well', '#DB60CB', '#37332E']]) {
    assert.ok(contrastRatio(ink, surface) >= 3, `${name}: ${contrastRatio(ink, surface)}`);
  }
  for (const hex of ['--_family-health:   #9E1E88', '--_family-health:   #DB60CB']) assert.ok(tokens.includes(hex), hex);
  // Zeiten, Daten und Betraege unter dem Wert stehen tabellarisch.
  for (const part of ['note', 'meta', 'trend', 'unit']) {
    assert.match(body(`.metric-card__${part}`), /font-variant-numeric:\s*tabular-nums/, `.metric-card__${part}`);
  }
});

// Critique 2026-10-16: (1) „Gemessen am" stand im Messwert-Dialog als nackter
// Text in der Zeile - Datum und Uhrzeit sehen in beiden Formular-Dialekten wie
// ein Feld aus (D4). (2) Die Kachel trennte bei 1280px „Sauerstoffsaetti-gung":
// das deutsche Etikett traegt einen weichen Trennstrich an der Wortfuge, und
// `hyphens: auto` haelt sich dann an ihn („Sauerstoff-saettigung", im Browser
// gesehen). (3) Naehrwerte ohne Tagesziel: ein zentrierter Leerhinweis ueber
// einer linksbuendigen Erklaerung - jetzt beide Saetze in einer Flucht.
test('Messwert-Dialog, Vital-Kachel, Naehrwerte-Leerzustand (Critique 2026-10-16)', () => {
  const layout = readFileSync(new URL('../public/styles/layout.css', import.meta.url), 'utf8');
  const field = [...eachRule(layout)].find((r) => !r.at.length && r.selector.trim() === '.form-row__control > yuvomi-datepicker .ydp__input');
  assert.ok(field, 'die Zeilenregel des Datumsfelds steht');
  assert.doesNotMatch(field.body, /border-color:\s*transparent|background-color:\s*transparent/, 'das Datumsfeld behaelt Kante und Flaeche');

  const de = JSON.parse(readFileSync(new URL('../public/locales/de.json', import.meta.url), 'utf8'));
  assert.equal(de.health.vitals.metric.spo2, 'Sauerstoff­sättigung', 'Trennstelle an der Wortfuge, nicht in der Silbe');

  const health = readFileSync(new URL('../public/pages/health.js', import.meta.url), 'utf8');
  const today = health.slice(health.indexOf('function nutritionTodaySectionMarkup(own)'), health.indexOf('function nutritionProgressRowMarkup('));
  assert.doesNotMatch(today, /emptyHintHTML\(t\('health\.nutrition\.targetNone'\)\)/, 'kein zentrierter Leerhinweis mehr');
  assert.match(today, /<div class="health-nutrition-today__none">/);
});

// ── Plausibilitaet (Critique R19, 2026-10-16) ──────────────────────────────
//
// 650 kg, SpO2 ueber 100 % und ein systolischer Wert unter dem diastolischen
// gingen durch. Unmoegliches haelt das Formular an (dieselben Grenzen wie der
// Server), Ungewoehnliches fragt nur nach.
test('vitalPlausibility: Unmoegliches ist hart, Ungewoehnliches weich, Normales still', async () => {
  const { vitalPlausibility } = await import('../public/utils/health-vitals.js');
  const p = (m) => vitalPlausibility(m);
  assert.deepEqual(p({ type: 'weight', unit: 'kg', value_num: 650 }), { hard: [], soft: [{ channel: 'value', issue: 'high' }] });
  assert.deepEqual(p({ type: 'weight', unit: 'kg', value_num: 6500 }).hard, [{ channel: 'value', issue: 'impossible' }]);
  assert.deepEqual(p({ type: 'weight', unit: 'kg', value_num: 72 }), { hard: [], soft: [] });
  assert.deepEqual(p({ type: 'spo2', unit: '%', value_num: 101 }).hard, [{ channel: 'value', issue: 'impossible' }]);
  assert.deepEqual(p({ type: 'spo2', unit: '%', value_num: 84 }).soft, [{ channel: 'value', issue: 'low' }]);
  assert.deepEqual(p({ type: 'temp', unit: '°C', value_num: 375 }).hard, [{ channel: 'value', issue: 'impossible' }]);
  assert.deepEqual(p({ type: 'temp', unit: '°F', value_num: 98.6 }), { hard: [], soft: [] });
  assert.deepEqual(p({ type: 'glucose', unit: 'mmol/L', value_num: 25 }).soft, [{ channel: 'value', issue: 'high' }]);
  assert.deepEqual(p({ type: 'bp', unit: 'mmHg', value_num: 80, value_num2: 120 }).hard, [{ channel: 'dia', issue: 'bpOrder' }]);
  assert.deepEqual(p({ type: 'bp', unit: 'mmHg', value_num: 120, value_num2: 80, value_num3: 190 }), { hard: [], soft: [{ channel: 'pulse', issue: 'high' }] });
  // Halb ausgefuellt: nur, was dasteht.
  assert.deepEqual(p({ type: 'bp', unit: 'mmHg', value_num: 120, value_num2: null }), { hard: [], soft: [] });
  // Metriken ohne Grenzen (Schlaf, Stimmung, Groesse) bleiben unberuehrt.
  assert.deepEqual(p({ type: 'height', unit: 'cm', value_num: 999 }), { hard: [], soft: [] });
});

// Review #2049: die Tabellen sind Objekte, `unit` und `type` kommen frei vom
// Client. Ein Name wie "constructor" oder "toString" fand frueher eine geerbte
// Eigenschaft - der Server warf 500, das Formular warf beim Tippen. Eine fremde
// Einheit hat keine Zahlenraender, also wird die Messung geprueft wie jede
// andere ohne Einheit.
test('Einheit oder Typ mit dem Namen einer Objekt-Eigenschaft hat keine Raender und wirft nicht', async () => {
  const client = await import('../public/utils/health-vitals.js');
  const server = await import('../server/routes/health/vital-limits.js');
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    for (const m of [
      { type: 'weight', unit: name, value_num: 70 },
      { type: 'bp', unit: name, value_num: 120, value_num2: 80 },
      { type: name, unit: 'kg', value_num: 70 },
      { type: 'glucose', unit: name, value_num: 5000 },
    ]) {
      assert.equal(server.vitalLimitError(m), null, JSON.stringify(m));
      assert.deepEqual(client.vitalPlausibility(m), { hard: [], soft: [] }, JSON.stringify(m));
    }
  }
  // Die Regeln ohne Einheit gelten weiter.
  assert.equal(server.vitalLimitError({ type: 'bp', unit: 'toString', value_num: 80, value_num2: 120 }), 'bp_order');
  assert.equal(server.vitalLimitError({ type: 'spo2', unit: 'constructor', value_num: 101 }), 'out_of_range');
});

// Review #2049: SpO2 ohne oder mit fremder Einheit pruefte nur den oberen Rand,
// -10 und 0 gingen durch. Eine Saettigung liegt in jeder Schreibweise in
// [1, 100] - Formular und Server sagen dasselbe.
test('SpO2 ohne oder mit fremder Einheit haelt beide Raender, in Formular und Server', async () => {
  const client = await import('../public/utils/health-vitals.js');
  const server = await import('../server/routes/health/vital-limits.js');
  for (const unit of [undefined, null, '', 'percent', 'constructor', '%']) {
    for (const value of [-10, 0, 0.5, 101]) {
      const m = { type: 'spo2', unit, value_num: value };
      assert.equal(server.vitalLimitError(m), 'out_of_range', JSON.stringify(m));
      assert.deepEqual(client.vitalPlausibility(m).hard, [{ channel: 'value', issue: 'impossible' }], JSON.stringify(m));
    }
    for (const value of [1, 97, 100]) {
      const m = { type: 'spo2', unit, value_num: value };
      assert.equal(server.vitalLimitError(m), null, JSON.stringify(m));
      assert.deepEqual(client.vitalPlausibility(m).hard, [], JSON.stringify(m));
    }
  }
});

test('die harten Grenzen von Formular und Server sind dieselben, und weich liegt innerhalb von hart', async () => {
  const client = await import('../public/utils/health-vitals.js');
  const server = await import('../server/routes/health/vital-limits.js');
  assert.deepEqual(client.VITAL_HARD_LIMITS, server.VITAL_HARD_LIMITS);
  assert.deepEqual(client.PULSE_HARD_LIMITS, server.PULSE_HARD_LIMITS);
  const inside = ([lo, hi], [hardLo, hardHi], label) => assert.ok(lo >= hardLo && hi <= hardHi, label);
  for (const [type, units] of Object.entries(client.VITAL_SOFT_RANGES)) {
    for (const [unit, range] of Object.entries(units)) {
      const hard = client.VITAL_HARD_LIMITS[type][unit];
      if (Array.isArray(range)) inside(range, hard, `${type} ${unit}`);
      else for (const ch of Object.keys(range)) inside(range[ch], hard[ch], `${type} ${unit} ${ch}`);
    }
  }
  inside(client.PULSE_SOFT_RANGE, client.PULSE_HARD_LIMITS, 'Puls');
  // Was der Server ablehnt, haelt auch das Formular an - und umgekehrt.
  for (const m of [
    { type: 'weight', unit: 'kg', value_num: 701 }, { type: 'spo2', unit: '%', value_num: 100.5 },
    { type: 'bp', unit: 'mmHg', value_num: 90, value_num2: 90 }, { type: 'bp', unit: 'mmHg', value_num: 120, value_num2: 80, value_num3: 10 },
    { type: 'weight', unit: 'kg', value_num: 650 }, { type: 'temp', unit: '°C', value_num: 41.5 },
  ]) {
    assert.equal(client.vitalPlausibility(m).hard.length > 0, server.vitalLimitError(m) !== null, JSON.stringify(m));
  }
});

test('der Vitalwerte-Dialog haelt Unmoegliches an und zeigt Ungewoehnliches als Hinweis', () => {
  const src = readFileSync(new URL('../public/pages/health.js', import.meta.url), 'utf8');
  assert.match(src, /if \(reportFieldErrors\(vitalPlausibility\(body\)\.hard\.map\(/, 'Speichern prueft die harten Grenzen nicht');
  assert.match(src, /<p class="form-hint form-hint--warning" id="vital-plausibility" role="status" hidden><\/p>/);
  // Seit der R19-Nachlese beim Abschluss des Feldes (change), siehe unten.
  assert.match(src, /fieldsHost\.addEventListener\('change', updatePlausibility\)/, 'der Hinweis folgt der Eingabe nicht');
});

// Re-Kritik 2026-10-17: nach dem Speichern stand der harte Fehler rot am Feld
// und derselbe Satz in Bernstein unter dem Puls. Im Browser gemessen (390px,
// Blutdruck 80/120): vorher Hinweis + Feldfehler, nachher nur der Feldfehler;
// ein ungewoehnlicher Wert (250/80) zeigt den Hinweis weiter.
test('Re-Kritik: steht ein harter Fehler am Feld, schweigt der Plausibilitaets-Hinweis dazu', () => {
  const src = readFileSync(new URL('../public/pages/health.js', import.meta.url), 'utf8');
  const update = src.slice(src.indexOf('const updatePlausibility = () => {'), src.indexOf('const clearPlausibilityWhenResolved'));
  assert.match(src, /const fieldCarriesError = \(\) => Boolean\(fieldsHost\.querySelector\('\[aria-invalid="true"\]'\)\);/,
    'der Hinweis fragt, ob ein Wertefeld seinen Fehler selbst traegt');
  assert.match(update, /vitalPlausibility\(values\)\.hard\.length && fieldCarriesError\(\) \? null : vitalPlausibilityText\(values\)/,
    'Hartes nur, solange kein Feld es traegt - Ungewoehnliches immer');
  const submitHard = src.slice(src.indexOf('if (reportFieldErrors(vitalPlausibility(body).hard.map('), src.indexOf('submitBtn.disabled = true;', src.indexOf('if (reportFieldErrors(vitalPlausibility(body).hard.map(')));
  assert.match(submitHard, /updatePlausibility\(\);\s*return;/, 'nach dem Melden am Feld zieht der Hinweis nach');
});

// Critique R19 Nachlese (Guide validate-input-after-interaction): der Hinweis
// stand beim Tippen von "37,5 °C" schon nach der "3" als "nicht moeglich" da.
// Gezeigt wird erst beim Abschluss des Feldes, beim Tippen nur weggenommen.
test('der Plausibilitaets-Hinweis erscheint nach dem Eingeben, nicht waehrend', () => {
  const src = readFileSync(new URL('../public/pages/health.js', import.meta.url), 'utf8');
  assert.match(src, /fieldsHost\.addEventListener\('input', clearPlausibilityWhenResolved\)/,
    'auf input wird der Hinweis gezeigt - mitten im Tippen');
  assert.match(src, /fieldsHost\.addEventListener\('change', updatePlausibility\)/);
  assert.doesNotMatch(src, /fieldsHost\.addEventListener\('input', updatePlausibility\)/);
  const clear = src.slice(src.indexOf('const clearPlausibilityWhenResolved'), src.indexOf("fieldsHost.addEventListener('input'"));
  assert.match(clear, /if \(plausibilityHint && !vitalPlausibilityText\(/, 'beim Tippen darf der Hinweis nur gehen, nicht kommen');
});

// Re-Critique 2026-10-17, P1: ein Blutdruck ohne Puls zeichnete Puls 0, weil
// Number(null) 0 ist. Fehlend bleibt fehlend - im Punkt UND im Delta.
test('Blutdruck ohne Puls: der Puls fehlt, er ist nicht 0', () => {
  const rows = [
    { id: 1, type: 'bp', value_num: 120, value_num2: 80, value_num3: null, unit: 'mmHg', measured_at: '2026-06-10T08:00' },
    { id: 2, type: 'bp', value_num: 130, value_num2: 85, value_num3: '', unit: 'mmHg', measured_at: '2026-06-12T08:00' },
    { id: 3, type: 'bp', value_num: 125, value_num2: 82, value_num3: 70, unit: 'mmHg', measured_at: '2026-06-14T08:00' },
  ];
  const s = computeVitalSeries(rows, { type: 'bp', range: 'month', anchor: '2026-06-15' });
  const at = (date) => s.points.find((p) => p.date === date);
  assert.equal(at('2026-06-10').value_num3, null, 'null ist kein Puls von 0');
  assert.equal(at('2026-06-12').value_num3, null, "'' ist kein Puls von 0");
  assert.equal(at('2026-06-14').value_num3, 70);
  assert.equal(at('2026-06-12').value_num, 130, 'der Druck selbst bleibt');
  assert.equal(s.deltas.value_num3, null, 'kein Delta gegen einen Puls, der nie gemessen wurde');
});


// --------------------------------------------------------
// R21 (Critique 2026-10-21, D6): Gesundheit als Briefing
// --------------------------------------------------------
//
// Oben ein Satz aus vorhandenen Daten (Veraenderung seit der letzten Messung,
// keine Bewertung); Messarten ohne Wert sind keine grauen Wells, sondern eine
// ruhige Zeile mit Erfassen-Aktion; die Achsen nennen ihre Einheit, haben eine
// Mindestspanne, der Puls steht auf eigener Achse, die Reihen sind direkt
// beschriftet; der Laborbefund zeigt kein "-" fuer fehlende Bewertung, die
// Aktivitaetsachse nennt Minuten.

const R21_ROWS = [
  { id: 1, type: 'weight', value_num: 65.2, unit: 'kg', measured_at: '2026-10-13T07:00' },
  { id: 2, type: 'weight', value_num: 65.0, unit: 'kg', measured_at: '2026-10-20T07:00' },
  { id: 3, type: 'bp', value_num: 120, value_num2: 76, value_num3: 70, unit: 'mmHg', measured_at: '2026-10-14T08:00' },
  { id: 4, type: 'bp', value_num: 116, value_num2: 74, value_num3: 68, unit: 'mmHg', measured_at: '2026-10-18T08:00' },
  { id: 5, type: 'height', value_num: 168, unit: 'cm', measured_at: '2026-09-11T08:00' },
];

async function inUebersicht(fn, rows, { access = 'write' } = {}) {
  const abraeumen = installMiniDom();
  setPermissions({ admin: false, modules: { health: access }, widgets: {}, capabilities: {} });
  health.setViewStateForTest('overview', { meId: 1, personId: 1, vitals: rows });
  try {
    return await fn();
  } finally {
    health.setViewStateForTest('overview', { vitals: [], personId: null, meId: null });
    clearPermissions();
    abraeumen();
  }
}

test('R21 D6 + R24 E9: ohne Messung keine grauen Wells, sondern eine ruhige Zeile - erfasst wird am FAB', async () => {
  await inUebersicht(() => {
    const html = health.overviewVitalsMarkup();
    assert.doesNotMatch(html, /metric-card__value--empty|metric-card/, 'keine Kachel ohne Wert');
    assert.match(html, /card-empty-row/, 'die geteilte ruhige Zeile (utils/empty-state.js)');
    assert.match(html, /health\.vitals\.emptyTitle/);
    assert.doesNotMatch(html, /data-action="ov-add-vital"/, 'R24 E9: kein zweiter Erfassen-Weg neben dem FAB-Menue');
  }, []);
  await inUebersicht(() => {
    assert.doesNotMatch(health.overviewVitalsMarkup(), /data-action="ov-add-vital"/, 'ohne Schreibrecht nur die Zeile');
  }, [], { access: 'read' });
  await inUebersicht(() => {
    const html = health.overviewVitalsMarkup();
    const kacheln = html.match(/data-vital-nav="/g) ?? [];
    assert.equal(kacheln.length, 3, 'nur die drei gemessenen Messarten');
    assert.doesNotMatch(html, /metric-card__value--empty/);
  }, R21_ROWS);
});

test('R21 D6: der Satz oben nennt die Veraenderung seit der letzten Messung - ohne Bewertung', async () => {
  await inUebersicht(() => {
    const html = health.overviewBriefMarkup();
    assert.match(html, /^<p class="health-brief"/);
    assert.match(html, /health\.overview\.brief\.changes/);
    // Gewicht 65,2 -> 65,0 und Blutdruck 120/76 -> 116/74, die juengste zuerst.
    assert.match(html, /health\.vitals\.metric\.weight/);
    assert.match(html, /health\.vitals\.metric\.bp/);
    assert.match(html, /-0,2 kg|−0,2 kg|-0\.2 kg|−0\.2 kg/);
    assert.match(html, /-4\/-2 mmHg|−4\/−2 mmHg/);
    assert.doesNotMatch(html, /health\.vitals\.metric\.height/, 'eine Messart ohne Vorwert hat keine Veraenderung');
    assert.doesNotMatch(html, /besser|schlechter|zu hoch|zu niedrig|better|worse/i, 'keine Bewertung');
  }, R21_ROWS);
  await inUebersicht(() => {
    assert.match(health.overviewBriefMarkup(), /health\.overview\.brief\.latest/, 'ohne Vorwert: der letzte Wert');
  }, [R21_ROWS[4]]);
  await inUebersicht(() => {
    assert.equal(health.overviewBriefMarkup(), '', 'ohne Messung kein Satz');
  }, []);
  const src = readFileSync(new URL('../public/pages/health.js', import.meta.url), 'utf8');
  assert.match(src, /\$\{overviewBriefMarkup\(\)\}\s*\$\{overviewGridMarkup\(\)\}/, 'der Satz steht ueber den Karten');
  const { hoistPlan } = await import('../public/utils/health-hoist.js');
  assert.ok(hoistPlan({ split: false, overview: true, phone: true }).some((p) => p.part === 'brief'),
    'auf dem Telefon zieht er mit vor die Bereichsliste');
});

test('R21 D6: die Vitalwerte-Seite zeigt keine leere Kachel mehr - auf keiner Breite', () => {
  const src = readFileSync(new URL('../public/pages/health.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function renderCards() {'), src.indexOf('function vitalsEmptyRowMarkup() {'));
  assert.match(fn, /all\.filter\(\(entry\) => entry\.series\.latest\)/, 'nur gemessene Messarten werden zur Kachel');
  assert.match(fn, /vitalsEmptyRowMarkup\(\)/, 'ohne jede Messung die ruhige Zeile');
  assert.doesNotMatch(src, /health-vitals__card--empty/);
});

test('R21 D6: Achsen mit Einheit und Mindestspanne, der Puls auf eigener Achse, Reihen direkt beschriftet', () => {
  const bp = computeVitalSeries(R21_ROWS, { type: 'bp', range: 'month', anchor: '2026-10-21' });
  const html = health.chartMarkup(vitalMetric('bp'), bp);
  const svgs = html.match(/<svg class="chart health-chart[^"]*"/g) ?? [];
  assert.equal(svgs.length, 2, 'Blutdruck und Puls je eine Achse');
  const [druck, puls] = html.split(/<svg class="chart health-chart/).slice(1);
  // Seit #1798 ein Balken je Messung statt zweier Kurven.
  assert.equal((druck.match(/<polyline/g) ?? []).length, 0, 'auf der mmHg-Achse keine Kurven');
  assert.ok((druck.match(/<line class="health-chart__bp"/g) ?? []).length >= 2, 'auf der mmHg-Achse die Balken von Systole bis Diastole');
  assert.equal((puls.match(/<polyline/g) ?? []).length, 1, 'der Puls hat seine eigene');
  assert.match(druck, /class="chart__axis-unit"> mmHg</, 'die Einheit steht am obersten Wert');
  assert.match(puls, /class="chart__axis-unit"> \/min</);
  assert.equal((html.match(/health-chart__series-label/g) ?? []).length, 3, 'jede Kurve traegt ihren Namen');
  assert.doesNotMatch(html, /health-chart__legend/, 'keine Farblegende mehr');
  // Blutzucker zwischen 88 und 90: die Achse steht mindestens 40 mg/dL weit.
  const zucker = [88, 90, 89].map((v, i) => ({ id: 10 + i, type: 'glucose', value_num: v, unit: 'mg/dL', measured_at: `2026-10-1${i + 1}T07:00` }));
  const gl = health.chartMarkup(vitalMetric('glucose'), computeVitalSeries(zucker, { type: 'glucose', range: 'month', anchor: '2026-10-21' }));
  const ticks = yTicks(gl);
  assert.ok(Math.max(...ticks) - Math.min(...ticks) >= 40, `Achse ${ticks.join('/')} dramatisiert 2 mg/dL Rauschen`);
  assert.ok(ticks.every((v) => Number.isInteger(v)), `keine halben Schritte: ${ticks.join('/')}`);
});

test('R21: der Laborbefund zeigt kein "-" fuer eine fehlende Bewertung, die Aktivitaetsachse nennt Minuten', () => {
  const abraeumen = installMiniDom();
  health.setViewStateForTest('labs', {
    meId: 1, personId: 1, selectedReportId: 7,
    reports: [{ id: 7, report_date: '2026-10-03', results: [
      { id: 1, analyte: 'Ferritin', value_num: 24, unit: 'ng/mL', ref_low: 15, ref_high: 150, flag: null },
      { id: 2, analyte: 'Vitamin D', value_num: 22, unit: 'ng/mL', ref_low: 30, ref_high: 100, flag: 'low' },
    ] }],
  });
  try {
    const html = health.labDetailMarkup();
    assert.doesNotMatch(html, /health-lab-flag--none|<span class="health-lab-flag[^"]*">-<\/span>/);
    assert.match(html, /health-lab-flag--low/, 'die Bewertung des Labors bleibt');
  } finally {
    health.setViewStateForTest('labs', { reports: [], selectedReportId: null, personId: null, meId: null });
    abraeumen();
  }
  const summary = { buckets: [30, 0, 55, 48, 40, 32, 0].map((durationMin, i) => ({ date: `2026-10-1${5 + i}`, weekday: i, durationMin })) };
  const svg = health.activityChartMarkup(summary);
  const oben = svg.match(/class="chart__axis chart__axis--y"[^>]*>([^<]*)</)?.[1] ?? '';
  assert.match(oben, /health\.activity\.unit\.min/, `oberster Achsenwert ohne Einheit: "${oben}"`);
});

// --------------------------------------------------------
// #1699 + #1798: Tagesband, Tagesansicht, Blutdruck als Balken je Messung,
// Uhrzeit und Notiz in der Messliste.
// --------------------------------------------------------

const { stepVitalAnchor } = await import('../public/utils/health-vitals.js');

const zuckerTag = [
  { id: 21, type: 'glucose', value_num: 55, unit: 'mg/dL', measured_at: '2026-09-15T07:00', note: 'vor dem Fruehstueck' },
  { id: 22, type: 'glucose', value_num: 190, unit: 'mg/dL', measured_at: '2026-09-15T13:00', note: '2 Knoppers' },
  { id: 23, type: 'glucose', value_num: 100, unit: 'mg/dL', measured_at: '2026-09-18T08:00' },
];

test('#1699: ein Bucket traegt neben dem Mittel den kleinsten und den groessten Wert', () => {
  const s = computeVitalSeries(zuckerTag, { type: 'glucose', range: 'month', anchor: '2026-09-27', today: '2026-10-05' });
  const tag = s.points.find((p) => p.key === '2026-09-15');
  assert.equal(tag.value_num, 122.5);
  assert.equal(tag.min.value_num, 55);
  assert.equal(tag.max.value_num, 190);
  const einzeln = s.points.find((p) => p.key === '2026-09-18');
  assert.equal(einzeln.min.value_num, 100, 'eine Messung: das Band faellt auf den Punkt');
  assert.equal(einzeln.max.value_num, 100);
  const leer = s.points.find((p) => p.key === '2026-09-16');
  assert.equal(leer.min.value_num, null);
});

test('#1699: die Serie fuehrt jede Messung des Fensters mit Uhrzeit und Bucket', () => {
  const s = computeVitalSeries(zuckerTag, { type: 'glucose', range: 'month', anchor: '2026-09-27', today: '2026-10-05' });
  assert.deepEqual(s.readings.map((r) => [r.id, r.minutes, r.index]), [[21, 420, 14], [22, 780, 14], [23, 480, 17]]);
});

test('#1699: die Tagesansicht ist EIN Datum mit jeder Messung als eigener Punkt', () => {
  const s = computeVitalSeries(zuckerTag, { type: 'glucose', range: 'day', anchor: '2026-09-15', today: '2026-10-05' });
  assert.equal(s.from, '2026-09-15');
  assert.equal(s.to, '2026-09-15');
  assert.equal(s.gran, 'hour');
  assert.deepEqual(s.readings.map((r) => r.id), [21, 22]);
  assert.equal(s.hasData, true);
  assert.equal(stepVitalAnchor('day', '2026-09-15', -1), '2026-09-14');
  assert.equal(stepVitalAnchor('day', '2026-09-30', 1), '2026-10-01');
});

test('#1699: Woche und Monat zeichnen je Tag ein Band vom kleinsten zum groessten Wert', () => {
  const s = computeVitalSeries(zuckerTag, { type: 'glucose', range: 'month', anchor: '2026-09-27', today: '2026-10-05' });
  const svg = health.chartMarkup(vitalMetric('glucose'), s);
  const baender = [...svg.matchAll(/<line class="health-chart__range"[^>]*y1="([\d.]+)"[^>]*y2="([\d.]+)"/g)];
  assert.equal(baender.length, 1, 'nur der Tag mit Spanne bekommt ein Band; der Einzelwert bleibt Punkt');
  const ticks = yTicks(svg);
  assert.ok(Math.min(...ticks) <= 55 && Math.max(...ticks) >= 190, `die Achse ${ticks.join('/')} schneidet das Band ab`);
  assert.match(svg, /health\.vitals\.bandValue/, 'Tooltip und Tabelle nennen die Spanne');
});

test('#1798: Blutdruck in Woche/Monat ist ein Balken JE MESSUNG von diastolisch bis systolisch', () => {
  const rows = [
    { id: 1, type: 'bp', value_num: 130, value_num2: 85, value_num3: 70, measured_at: '2026-09-15T07:00' },
    { id: 2, type: 'bp', value_num: 150, value_num2: 95, value_num3: 80, measured_at: '2026-09-15T19:00' },
    { id: 3, type: 'bp', value_num: 120, value_num2: 80, value_num3: 65, measured_at: '2026-09-18T08:00' },
    { id: 4, type: 'bp', value_num: 125, value_num2: null, value_num3: null, measured_at: '2026-09-20T08:00' },
  ];
  const s = computeVitalSeries(rows, { type: 'bp', range: 'month', anchor: '2026-09-27', today: '2026-10-05' });
  const svg = health.chartMarkup(vitalMetric('bp'), s);
  const primaer = svg.split('health-chart--secondary')[0];
  const balken = [...primaer.matchAll(/<line class="health-chart__bp"[^>]*x1="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.equal(balken.length, 3, 'drei Paare, drei Balken - zwei am selben Tag nebeneinander');
  assert.notEqual(balken[0], balken[1], 'zwei Messungen eines Tages liegen nicht uebereinander');
  assert.doesNotMatch(primaer, /<polyline/, 'Systole und Diastole sind keine zwei Kurven mehr');
  assert.match(primaer, /<circle class="health-chart__bp-point"/, 'ein Wert ohne Paar faellt auf einen Punkt zurueck');
  assert.match(svg, /health-chart--secondary/, 'der Puls bleibt seine eigene Achse darunter');
});

test('#1699: die Tagesansicht legt jede Messung an ihre Uhrzeit auf einer Stundenachse', () => {
  const s = computeVitalSeries(zuckerTag, { type: 'glucose', range: 'day', anchor: '2026-09-15', today: '2026-10-05' });
  const svg = health.chartMarkup(vitalMetric('glucose'), s);
  const { left, right } = chartScales();
  const cx = [...svg.matchAll(/<circle cx="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.equal(cx.length, 2);
  assert.ok(Math.abs(cx[0] - (left + (420 / 1440) * (right - left))) < 1, `07:00 steht bei ${cx[0]}`);
  assert.ok(Math.abs(cx[1] - (left + (780 / 1440) * (right - left))) < 1, `13:00 steht bei ${cx[1]}`);
  // Eine einzelne Messung am Tag ist in dieser Ansicht genau die Auskunft.
  const eine = computeVitalSeries(zuckerTag, { type: 'glucose', range: 'day', anchor: '2026-09-18', today: '2026-10-05' });
  assert.doesNotMatch(health.chartMarkup(vitalMetric('glucose'), eine), /health\.vitals\.sparse/);
});

test('#1699: die Messliste nennt Uhrzeit und Notiz', async () => {
  await imBlatt(() => {
    const html = health.recentMeasurementsMarkup(vitalMetric('glucose'));
    assert.match(html, /class="health-recent__time"[^>]*>13:00</);
    assert.match(html, /class="health-recent__note"[^>]*>2 Knoppers</);
    assert.equal((html.match(/health-recent__note/g) || []).length, 2, 'ohne Notiz keine leere Zeile');
  }, { view: { rows: zuckerTag } });
});

test('#1699: der Zeitraum-Umschalter beginnt mit "Tag"', async () => {
  await imBlatt(() => {
    const html = health.vitalSheetMarkup(vitalMetric('weight'));
    assert.deepEqual([...html.matchAll(/data-sheet-range="(\w+)"/g)].map((m) => m[1]), ['day', 'week', 'month', 'year']);
  });
});
