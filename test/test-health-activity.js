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

/* DIE BALKEN DER WOCHE (Critique R18, 2026-10-07). Gemessen bei 390px: das
 * Diagramm 324x96, die Wochentage 3px IN den Balkenfuessen und neben der "0"
 * der Werteachse; Balken rundum gerundet (`rect rx`), alle sieben gleich laut,
 * fuenf Gitterlinien. */
const { __test: health } = await import('../public/pages/health.js');
const { calmDomain, CHART, chartScales } = await import('../public/utils/chart.js');
const { todayKey, addLocalDays } = await import('../public/utils/date.js');
const { readFileSync } = await import('node:fs');
const { eachRule } = await import('./css-rules.js');

function woche(minutenHeute, minutenGestern = 30) {
  const today = todayKey();
  const rows = [
    { id: 1, type: 'run', performed_at: `${addLocalDays(today, -1)}T07:00`, duration_min: minutenGestern },
    ...(minutenHeute ? [{ id: 2, type: 'run', performed_at: `${today}T07:00`, duration_min: minutenHeute }] : []),
  ];
  return weekSummary(rows, { anchor: today, weekStartsOn: 1 });
}

function mitFenster(phone, fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const base = globalThis.window ?? {};
  globalThis.window = { ...base, matchMedia: (q) => ({ matches: phone && /max-width:\s*639px/.test(q), addEventListener() {} }) };
  try { return fn(); } finally {
    if (saved) Object.defineProperty(globalThis, 'window', saved); else delete globalThis.window;
  }
}

test('R18 calmDomain: drei Linien, Luft ueber dem Spitzenwert, ganzzahlig auf Wunsch', () => {
  for (const max of [1, 7, 42, 55, 60, 175, 950, 5550, 24503]) {
    const d = calmDomain(max, { integer: true });
    assert.equal(d.steps, 2, `${max}: Grundlinie, Mitte, Obergrenze`);
    assert.equal(d.min, 0);
    assert.equal(d.max, d.step * 2);
    assert.ok(Number.isInteger(d.step), `${max}: ${d.step}`);
    assert.ok(d.max >= max * 1.15 - 1e-6, `${max}: 15 % Luft (${d.max})`);
    assert.ok(d.max <= Math.max(4, max * 1.75), `${max}: die Balken fuellen die Flaeche (${d.max})`);
  }
  assert.deepEqual(calmDomain(55, { integer: true }), { min: 0, max: 70, step: 35, steps: 2 });
  // Ohne `integer` bleiben kleine Spannen ablesbar (0,5-1,2).
  const klein = calmDomain(1.2);
  assert.ok(klein.max >= 1.38 && klein.max <= 2.1 && klein.steps === 2, JSON.stringify(klein));
});

test('R18 Aktivitaet: Balken oben voll gerundet und unten gerade, heute im Vollton mit Wert, drei Gitterlinien', () => {
  // Die Balkenform: Radius = halbe Breite, die Fuesse stehen gerade auf der Grundlinie.
  assert.equal(health.activityBarPath(100, 50, 20, 174), 'M100.0,174.0 V60.0 A10.0,10.0 0 0 1 120.0,60.0 V174.0 Z');
  // Ein sehr kleiner Wert bekommt einen flachen Bogen statt einer Kappe, die ueber den Wert hinausragt.
  assert.equal(health.activityBarPath(100, 170, 20, 174), 'M100.0,174.0 V174.0 A10.0,4.0 0 0 1 120.0,174.0 V174.0 Z');

  const html = mitFenster(false, () => health.activityChartMarkup(woche(55)));
  assert.doesNotMatch(html, /<rect\b/, 'kein rundum gerundetes Rechteck mehr');
  const bars = html.match(/<path class="health-activity-chart__bar[^"]*"/g) ?? [];
  assert.equal(bars.length, 2, 'gestern und heute');
  assert.equal(bars.filter((b) => /health-activity-chart__bar--today/.test(b)).length, 1, 'genau EIN Balken ist heute');
  assert.match(html, /<path class="health-activity-chart__bar health-activity-chart__bar--today" d="M[\d.]+,174\.0 V/, 'der Balken steht auf der Grundlinie');
  assert.doesNotMatch(html, /fill="var\(/, 'die Farbe steht im Stylesheet, nicht im Markup');
  // Der Wert steht nur am heutigen Balken; die sieben Werte bleiben in der Tabelle.
  assert.equal(html.match(/class="chart__axis health-activity-chart__value"/g)?.length, 1);
  assert.equal(html.match(/health-activity-chart__day--today/g)?.length, 1, 'der heutige Wochentag ist hervorgehoben');
  assert.match(html, /<table class="sr-only"|class="sr-only"[^>]*>\s*<caption|<caption/, 'die Tabelle fuer Screenreader bleibt');
  assert.equal(html.match(/<tr>/g)?.length >= 7, true, 'sieben Tage in der Tabelle');
  assert.match(html, /role="img"\s+aria-label="health\.activity\.chartTitle"/);
  assert.equal(html.match(/class="chart__grid"/g)?.length, 3, 'Grundlinie, Mitte, Obergrenze');
  // Ohne Aktivitaet heute: kein heutiger Balken, kein Wert - aber der Wochentag bleibt markiert.
  const ohne = mitFenster(false, () => health.activityChartMarkup(woche(0)));
  assert.doesNotMatch(ohne, /health-activity-chart__bar--today|health-activity-chart__value/);
  assert.equal(ohne.match(/health-activity-chart__day--today/g)?.length, 1);

  // Desktop: die geteilte Flaeche. Telefon: hoeher und mit mehr Fuss.
  assert.match(html, /viewBox="0 0 600 200" role="img"/);
  const phone = mitFenster(true, () => health.activityChartMarkup(woche(55)));
  const geo = health.ACTIVITY_CHART_NARROW;
  assert.match(phone, new RegExp(`viewBox="0 0 ${geo.W} ${geo.H}" style="aspect-ratio: ${geo.W} / ${geo.H}" role="img"`));
  // 390px Fenster: das SVG ist rund 288px breit (324 abzueglich Achsenpolster) - Massstab 0,48.
  const scale = 288 / geo.W;
  assert.ok(geo.H * scale >= 150, `die Flaeche stuende bei ${Math.round(geo.H * scale)}px (vorher 96)`);
  // Die Wochentage stehen frei UNTER der Grundlinie: Schrift 12px, Grundlinie 8 Einheiten ueber dem Rand.
  const labelTop = (geo.H - 8) * scale - 11;
  const baseline = chartScales(geo).bottom * scale;
  assert.ok(labelTop - baseline >= 4, `Wochentag ${labelTop.toFixed(1)}px, Grundlinie ${baseline.toFixed(1)}px`);
  const alt = ((CHART.H - 8) * (324 / CHART.W) - 11) - chartScales(CHART).bottom * (324 / CHART.W);
  assert.ok(alt < 0, `Gegenprobe: mit der geteilten Flaeche stand der Wochentag ${(-alt).toFixed(1)}px IN den Balkenfuessen`);
  // Schlanke Balken: hoechstens ~24px am Bildschirm.
  const width = (markup, s) => Number(/A([\d.]+),/.exec(markup)[1]) * 2 * s;
  assert.ok(width(phone, scale) <= 24, `Telefon: ${width(phone, scale).toFixed(1)}px`);
  assert.ok(width(html, 1.45) <= 27 && width(html, 1.2) >= 18, `Desktop: ${width(html, 1.45).toFixed(1)}px`);

  // CSS: heute Vollton, die uebrigen getoent - mit 3:1 gegen die Karte in beiden Themes.
  const css = readFileSync(new URL('../public/styles/health.css', import.meta.url), 'utf8');
  const body = (sel) => [...eachRule(css)].filter((r) => r.selector.trim() === sel).map((r) => r.body).join(';');
  assert.match(body('.health-activity-chart__bar--today'), /fill:\s*var\(--module-health\)/);
  assert.match(body('.health-activity-chart__bar'), /fill:\s*color-mix\(in srgb, var\(--module-health\) calc\(var\(--tint-ink\) \+ 5%\), var\(--color-surface\)\)/);
  assert.match(body('.health-activity-chart__value'), /fill:\s*var\(--color-text-primary\)/, 'der Wert traegt Textfarbe');
  const tokens = readFileSync(new URL('../public/styles/tokens.css', import.meta.url), 'utf8');
  assert.match(tokens, /--tint-ink:\s*70%/, 'die gerechnete Stufe ist die des Tokens');
});

test('R18 Aktivitaet: der getoente Balken haelt 3:1 gegen die Karte, hell und dunkel', async () => {
  const { contrastRatio } = await import('../public/utils/contrast.js');
  const mix = (a, b, p) => `#${[1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * p + parseInt(b.slice(i, i + 2), 16) * (1 - p)).toString(16).padStart(2, '0')).join('')}`;
  for (const [name, tone, surface] of [['hell', '#9E1E88', '#FFFFFF'], ['dunkel', '#DB60CB', '#2B2825']]) {
    assert.ok(contrastRatio(mix(tone, surface, 0.75), surface) >= 3, `${name} getoent: ${contrastRatio(mix(tone, surface, 0.75), surface)}`);
    assert.ok(contrastRatio(tone, surface) >= 3, `${name} Vollton`);
  }
  // Gegenprobe: bei der blanken Tinten-Stufe (70 %) reisst der dunkle Balken die 3:1.
  assert.ok(contrastRatio(mix('#DB60CB', '#2B2825', 0.7), '#2B2825') < 3, 'deshalb die fuenf Punkte darueber');
});
