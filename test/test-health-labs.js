/**
 * Modul: Laborwerte-Logik-Test
 * Zweck: Reine Funktionen deriveFlag() (Referenz-Flag-Ableitung, spiegelt den
 *        Server), summarizeReport() (Analyten-Anzahl + Auffälligkeiten),
 *        analyteNames() (distinkte Analyt-Namen) und analyteTrend()
 *        (chronologischer Werteverlauf fürs Chart). DOM-frei.
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-health-labs.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  deriveFlag,
  summarizeReport,
  analyteNames,
  analyteTrend,
  defaultTrendAnalyte,
  LAB_FLAGS,
} = await import('../public/utils/health-labs.js');

// --------------------------------------------------------
// deriveFlag — spiegelt die Server-Ableitung
// --------------------------------------------------------

test('LAB_FLAGS listet low/normal/high', () => {
  assert.deepEqual(LAB_FLAGS, ['low', 'normal', 'high']);
});

test('deriveFlag: Wert unter ref_low → low', () => {
  assert.equal(deriveFlag(3, 3.5, 5.5), 'low');
});

test('deriveFlag: Wert über ref_high → high', () => {
  assert.equal(deriveFlag(6, 3.5, 5.5), 'high');
});

test('deriveFlag: Wert innerhalb der Grenzen → normal', () => {
  assert.equal(deriveFlag(4.5, 3.5, 5.5), 'normal');
});

test('deriveFlag: Grenzwerte selbst gelten als normal (inklusive Grenzen)', () => {
  assert.equal(deriveFlag(3.5, 3.5, 5.5), 'normal');
  assert.equal(deriveFlag(5.5, 3.5, 5.5), 'normal');
});

test('deriveFlag: nur eine Grenze gesetzt', () => {
  assert.equal(deriveFlag(10, 5, null), 'normal'); // über Untergrenze, keine Obergrenze
  assert.equal(deriveFlag(2, 5, null), 'low');
  assert.equal(deriveFlag(10, null, 8), 'high');
  assert.equal(deriveFlag(6, null, 8), 'normal');
});

test('deriveFlag: keine Grenze gesetzt → null (kein Flag)', () => {
  assert.equal(deriveFlag(42, null, null), null);
  assert.equal(deriveFlag(42, undefined, undefined), null);
  assert.equal(deriveFlag(42, '', ''), null);
});

test('deriveFlag: fehlender/ungültiger Wert → null', () => {
  assert.equal(deriveFlag(null, 1, 5), null);
  assert.equal(deriveFlag(undefined, 1, 5), null);
  assert.equal(deriveFlag('', 1, 5), null);
  assert.equal(deriveFlag('abc', 1, 5), null);
});

test('deriveFlag: String-Zahlen aus Formularfeldern werden geparst', () => {
  assert.equal(deriveFlag('2', '3.5', '5.5'), 'low');
  assert.equal(deriveFlag('4.5', '3.5', '5.5'), 'normal');
  assert.equal(deriveFlag('9', '3.5', '5.5'), 'high');
});

// --------------------------------------------------------
// summarizeReport
// --------------------------------------------------------

test('summarizeReport: zählt Analyten und Auffälligkeiten', () => {
  const report = {
    results: [
      { analyte: 'Hb', flag: 'normal' },
      { analyte: 'Ferritin', flag: 'low' },
      { analyte: 'CRP', flag: 'high' },
    ],
  };
  const s = summarizeReport(report);
  assert.equal(s.total, 3);
  assert.equal(s.abnormal, 2);
  assert.equal(s.hasAbnormal, true);
});

test('summarizeReport: nur normale Werte → keine Auffälligkeit', () => {
  const s = summarizeReport({ results: [{ flag: 'normal' }, { flag: 'normal' }] });
  assert.equal(s.total, 2);
  assert.equal(s.abnormal, 0);
  assert.equal(s.hasAbnormal, false);
});

test('summarizeReport: null-Flag (kein Referenzbereich) gilt nicht als auffällig', () => {
  const s = summarizeReport({ results: [{ flag: null }, { flag: 'high' }] });
  assert.equal(s.total, 2);
  assert.equal(s.abnormal, 1);
});

test('summarizeReport: fehlende/leere results → 0/0', () => {
  assert.deepEqual(summarizeReport({}), { total: 0, abnormal: 0, hasAbnormal: false });
  assert.deepEqual(summarizeReport(null), { total: 0, abnormal: 0, hasAbnormal: false });
  assert.deepEqual(summarizeReport({ results: [] }), { total: 0, abnormal: 0, hasAbnormal: false });
});

// --------------------------------------------------------
// analyteNames
// --------------------------------------------------------

test('analyteNames: distinkte Namen in Erst-Auftreten-Reihenfolge', () => {
  const reports = [
    { results: [{ analyte: 'Hb' }, { analyte: 'Ferritin' }] },
    { results: [{ analyte: 'Ferritin' }, { analyte: 'CRP' }] },
  ];
  assert.deepEqual(analyteNames(reports), ['Hb', 'Ferritin', 'CRP']);
});

test('analyteNames: case-insensitiv dedupliziert, erste Schreibweise gewinnt', () => {
  const reports = [
    { results: [{ analyte: 'Ferritin' }] },
    { results: [{ analyte: 'ferritin' }, { analyte: '  FERRITIN  ' }] },
  ];
  assert.deepEqual(analyteNames(reports), ['Ferritin']);
});

test('analyteNames: leere Namen und fehlende results werden ignoriert', () => {
  const reports = [
    { results: [{ analyte: '' }, { analyte: '  ' }, { analyte: 'Hb' }] },
    { },
    null,
  ];
  assert.deepEqual(analyteNames(reports), ['Hb']);
});

// --------------------------------------------------------
// analyteTrend
// --------------------------------------------------------

test('analyteTrend: chronologisch aufsteigend nach report_date', () => {
  const reports = [
    { id: 2, report_date: '2026-05-01', results: [{ analyte: 'Hb', value_num: 14, unit: 'g/dL', flag: 'normal', ref_low: 13, ref_high: 17 }] },
    { id: 1, report_date: '2026-03-01', results: [{ analyte: 'Hb', value_num: 12, unit: 'g/dL', flag: 'low', ref_low: 13, ref_high: 17 }] },
    { id: 3, report_date: '2026-07-01', results: [{ analyte: 'Hb', value_num: 15, unit: 'g/dL', flag: 'normal', ref_low: 13, ref_high: 17 }] },
  ];
  const trend = analyteTrend(reports, 'Hb');
  assert.deepEqual(trend.map((p) => p.value), [12, 14, 15]);
  assert.deepEqual(trend.map((p) => p.date), ['2026-03-01', '2026-05-01', '2026-07-01']);
  assert.equal(trend[0].flag, 'low');
  assert.equal(trend[0].unit, 'g/dL');
  assert.equal(trend[0].refLow, 13);
  assert.equal(trend[0].refHigh, 17);
});

test('analyteTrend: case-insensitiver Namensvergleich', () => {
  const reports = [
    { id: 1, report_date: '2026-01-01', results: [{ analyte: 'Glukose', value_num: 90 }] },
    { id: 2, report_date: '2026-02-01', results: [{ analyte: 'glukose', value_num: 95 }] },
  ];
  assert.deepEqual(analyteTrend(reports, 'GLUKOSE').map((p) => p.value), [90, 95]);
});

test('analyteTrend: Befunde ohne den Analyten oder ohne Wert entfallen', () => {
  const reports = [
    { id: 1, report_date: '2026-01-01', results: [{ analyte: 'Hb', value_num: 14 }] },
    { id: 2, report_date: '2026-02-01', results: [{ analyte: 'CRP', value_num: 3 }] }, // anderer Analyt
    { id: 3, report_date: '2026-03-01', results: [{ analyte: 'Hb', value_num: null }] }, // kein Wert
    { id: 4, report_date: '2026-04-01', results: [{ analyte: 'Hb', value_num: 'x' }] }, // ungültig
  ];
  const trend = analyteTrend(reports, 'Hb');
  assert.equal(trend.length, 1);
  assert.equal(trend[0].value, 14);
});

test('analyteTrend: Gleichstand beim Datum → Sortierung nach id', () => {
  const reports = [
    { id: 5, report_date: '2026-01-01', results: [{ analyte: 'Hb', value_num: 15 }] },
    { id: 2, report_date: '2026-01-01', results: [{ analyte: 'Hb', value_num: 13 }] },
  ];
  assert.deepEqual(analyteTrend(reports, 'Hb').map((p) => p.value), [13, 15]);
});

test('analyteTrend: leerer Name oder leere Eingabe → []', () => {
  assert.deepEqual(analyteTrend([{ id: 1, report_date: '2026-01-01', results: [{ analyte: 'Hb', value_num: 14 }] }], ''), []);
  assert.deepEqual(analyteTrend(null, 'Hb'), []);
  assert.deepEqual(analyteTrend(undefined, 'Hb'), []);
});

// Critique 2026-10-16: Laborwerte mobil waren eine seitlich scrollende Tabelle,
// die Bewertung („Niedrig") lag rechts ausserhalb des Bilds. Unter 640px steht
// jeder Analyt jetzt als Zeile (Name links, Wert rechts, Referenz und
// Bewertung darunter), auffaellige zuerst.
test('Laborwerte mobil: Zeilen statt seitlich scrollender Tabelle, auffaellige zuerst (Critique 2026-10-16)', async () => {
  const { readFileSync } = await import('node:fs');
  const { eachRule } = await import('./css-rules.js');
  const src = readFileSync(new URL('../public/pages/health.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function resultListMarkup(results)'), src.indexOf('function referenceLabel('));
  assert.match(fn, /const ordered = \[\.\.\.results\.filter\(abnormal\), \.\.\.results\.filter\(\(r\) => !abnormal\(r\)\)\];/, 'auffaellige Werte vorn');
  assert.match(fn, /const abnormal = \(r\) => r\.flag === 'low' \|\| r\.flag === 'high';/);
  assert.match(fn, /health-lab-rows__ref">\$\{esc\(t\('health\.labs\.col\.reference'\)\)\}/, 'die Referenz ist beschriftet');
  assert.match(fn, /flagIndicatorMarkup\(r\.flag\)/, 'die Bewertung kommt als Pfeil plus Wort, wie in der Tabelle');
  assert.match(src, /\$\{resultListMarkup\(results\)\}/, 'der Befund rendert beide Fassungen');
  const css = readFileSync(new URL('../public/styles/health.css', import.meta.url), 'utf8');
  const rules = [...eachRule(css)];
  const phone = (r) => r.at.some((a) => /max-width:\s*639px/.test(a));
  assert.ok(rules.some((r) => phone(r) && r.selector.trim() === '.health-lab-table-wrap' && /display:\s*none/.test(r.body)), 'mobil keine Tabelle');
  assert.ok(rules.some((r) => phone(r) && r.selector.trim() === '.health-lab-rows' && /display:\s*block/.test(r.body)), 'mobil die Zeilen');
  assert.ok(rules.some((r) => !r.at.length && r.selector.trim() === '.health-lab-rows' && /display:\s*none/.test(r.body)), 'ab 640px die Tabelle');
});

// Re-Critique 2026-10-17 (Persona Sam): wer per Tastatur einen anderen Befund
// waehlte, verlor den Fokus an BODY - der Neuaufbau tauschte die Liste aus.
// Gemessen im Browser (Playwright, 1440 und 390): vorher BODY, nachher die
// gewaehlte Karte. Der Guard haelt die Verdrahtung: nach renderLabsShell()
// bekommt die Karte DERSELBEN ID den Fokus.
test('Laborwerte: die Wahl eines Befunds behaelt den Fokus auf seiner Karte', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/pages/health.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function wireLabs()'), src.indexOf('function wireLabsDetail()'));
  assert.match(fn, /labs\.selectedReportId = id;\s*renderLabsShell\(\);[\s\S]{0,400}labs\.root\.querySelector\(`\.health-lab-card\[data-report-id="\$\{id\}"\]`\)\?\.focus\(\{ preventScroll: true \}\);/);
});

// --------------------------------------------------------
// defaultTrendAnalyte (R20, Re-Critique 2026-10-17 a5 P2-6)
// --------------------------------------------------------

test('defaultTrendAnalyte: der auffaellige Wert des neuesten Befunds fuehrt, nicht der erste Name', () => {
  const reports = [
    { id: 1, report_date: '2026-03-01', results: [
      { analyte: 'Ferritin', value_num: 40, flag: 'normal' },
      { analyte: 'Vitamin D', value_num: 24, flag: 'low' },
    ] },
    { id: 2, report_date: '2026-09-01', results: [
      { analyte: 'Ferritin', value_num: 45, flag: 'normal' },
      { analyte: 'vitamin d', value_num: 18, flag: 'low' },
      { analyte: 'TSH', value_num: 5, flag: 'high' },
    ] },
  ];
  assert.equal(analyteNames(reports)[0], 'Ferritin', 'Vorbedingung: der erste Name ist unauffaellig');
  assert.equal(defaultTrendAnalyte(reports), 'Vitamin D', 'auffaellig im neuesten Befund UND mit Verlauf; die Schreibweise der Liste');
  // Die Listenreihenfolge entscheidet nicht, welcher Befund der neueste ist.
  assert.equal(defaultTrendAnalyte([...reports].reverse()).toLowerCase(), 'vitamin d');
  // Ohne Verlauf: der auffaellige Wert trotzdem.
  assert.equal(defaultTrendAnalyte([reports[1]]), 'vitamin d');
  // Nichts auffaellig: der erste mit Verlauf, sonst der erste Name.
  const calm = reports.map((r) => ({ ...r, results: r.results.map((x) => ({ ...x, flag: 'normal' })) }));
  assert.equal(defaultTrendAnalyte(calm), 'Ferritin');
  assert.equal(defaultTrendAnalyte([]), null);
});
