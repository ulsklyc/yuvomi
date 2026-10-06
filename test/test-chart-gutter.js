/**
 * Modul: Der Gutter einer Auswertungsflaeche folgt dem breitesten Achsenwert (#1607)
 * Zweck: `--chart-inset` hielt dem Gutter eine feste Mindestbreite frei,
 *        bemessen an "5.550 €". In koreanischer Region mit Won stand
 *        "₩6,000,000" links ausserhalb seines Scrollports: 6px bei 375px
 *        Fensterbreite, 13px bei 1280px. Seitdem misst `fitChartGutter()` die
 *        Werte, und `.chart-host` rechnet das Polster daraus.
 * Ausfuehren: npm run test:chart-gutter
 *
 * WAS HIER GEMESSEN WIRD UND WAS NICHT. Die Breite eines Achsenwerts kennt nur
 * der Browser; die Zahlen unten sind dort gemessen (Chrome, macOS,
 * Systemschrift, 12px) und stehen hier als Eingabe. Gerechnet wird mit der
 * FORMEL AUS DEM STYLESHEET, nicht mit einer Abschrift: sie wird aus
 * `panel.css` gelesen und ausgewertet, mit den Token aus `tokens.css`. Dass
 * der Browser dieselbe Formel so anwendet und dass die Budget-Seite den Helfer
 * wirklich ruft, misst `test:ko-layout-browser` an der gerenderten Seite.
 *
 * Fehlt `.chart-host`, rechnet der Test mit der Regel in `:root` weiter - also
 * mit dem Stand vor dem Fix. Er wird dann am Won-Wert rot und nicht an einer
 * fehlenden Regel: genau der Befund, der gemeldet war.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eachRule } from './css-rules.js';
import { CHART, AXIS_GAP, chartGridMarkup, fitChartGutter } from '../public/utils/chart.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const panelRules = [...eachRule(read('../public/styles/panel.css'))].filter((rule) => rule.at.length === 0);
const tokensCss = read('../public/styles/tokens.css');

function insetDeclaration(selector) {
  const body = panelRules
    .filter((rule) => rule.selector.split(',').map((s) => s.trim()).includes(selector))
    .map((rule) => rule.body).join('\n');
  return body.match(/--chart-inset:\s*([^;]+);/)?.[1] ?? null;
}

function tokenPx(name) {
  const value = tokensCss.match(new RegExp(`${name}:\\s*(\\d+(?:\\.\\d+)?)px`))?.[1];
  assert.ok(value, `${name} ist in tokens.css kein Pixelwert`);
  return Number(value);
}

/** Wertet eine `--chart-inset`-Deklaration aus: P = Breite des Elternteils, L = Breite des Werts. */
function evaluateInset(declaration, parentWidth, labelWidth) {
  const js = declaration
    .replace(/var\(--chart-label-width,\s*0px\)/g, String(labelWidth))
    .replace(/var\((--space-\d+)\)/g, (_m, name) => String(tokenPx(name)))
    .replace(/100%/g, String(parentWidth))
    .replace(/(\d)px/g, '$1')
    .replace(/calc\(/g, '(')
    .replace(/max\(/g, 'Math.max(');
  assert.match(js, /^[\d\s.+\-*/(),Mathmx]+$/, `die Formel enthaelt etwas, das der Test nicht rechnet: ${js}`);
  return Function(`"use strict"; return (${js});`)();
}

const ROOT = insetDeclaration(':root');
const HOST = insetDeclaration('.chart-host');
/** Das Polster eines Diagramms, dessen Werte gemessen sind. */
const fittedInset = (parentWidth, labelWidth) => evaluateInset(HOST ?? ROOT, parentWidth, labelWidth);
/** Wo das linke Ende des Werts steht, gemessen von der linken Kante des Elternteils. */
function labelLeft(parentWidth, labelWidth) {
  const inset = fittedInset(parentWidth, labelWidth);
  const scale = (parentWidth - inset) / CHART.W;
  return inset + (CHART.PAD_L - AXIS_GAP) * scale - labelWidth;
}

// Im Browser gemessene Breiten (px), aufgerundet wie `fitChartGutter` es tut.
const WIDE = [
  ['₩6,000,000 (ko-KR, KRW)', 68],
  ['₩125,000,000 (ko-KR, KRW)', 82],
  ['1.250.000 € (de-DE, EUR)', 68],
  ["CHF 125'000'000 (de-CH, CHF)", 100],
  ['Rp 6.000.000.000 (id-ID, IDR)', 103],
];
// Die Faelle aus dem Kommentar an PAD_L und an der Mindestbreite: sie standen
// vorher im Bild und duerfen sich nicht bewegen.
const SHORT = [
  ['5.550 € (Budget)', 44],
  ['6.000 € (Budget)', 44],
  ['125 (Blutdruck)', 21],
  ['8:24 (Schlaf)', 25],
  ['0,5 (Laborwert)', 19],
];
const WIDTHS = [];
for (let p = 240; p <= 1600; p += 1) WIDTHS.push(p);

test('die Mindestbreite in :root bleibt, wie sie war', () => {
  assert.ok(ROOT, ':root traegt --chart-inset nicht mehr');
  assert.equal(evaluateInset(ROOT, 343, 0).toFixed(2), '35.28', 'bei 343px Elternbreite sind es 35,28px Polster');
  assert.equal(evaluateInset(ROOT, 600, 0).toFixed(2), '8.82');
  assert.equal(evaluateInset(ROOT, 700, 0), 0, 'ab ~686px traegt der Gutter die Mindestbreite allein');
});

test('ein breiter Achsenwert steht bei jeder Diagrammbreite ganz im Bild', () => {
  for (const [name, width] of WIDE) {
    const out = WIDTHS.filter((p) => labelLeft(p, width) < -0.01);
    assert.deepEqual(out.slice(0, 5), [],
      `"${name}" (${width}px) ragt links hinaus, z.B. bei ${out[0]}px Elternbreite um ${out.length ? (-labelLeft(out[0], width)).toFixed(1) : 0}px - an ${out.length} von ${WIDTHS.length} Breiten`);
  }
});

test('ein kurzer Achsenwert laesst das Diagramm, wo es stand', () => {
  for (const [name, width] of SHORT) {
    for (const p of WIDTHS) {
      assert.equal(fittedInset(p, width), evaluateInset(ROOT, p, 0),
        `"${name}" (${width}px) verschiebt das Diagramm bei ${p}px Elternbreite`);
      assert.ok(labelLeft(p, width) >= 0, `"${name}" ragt bei ${p}px hinaus`);
    }
  }
});

test('die Formel im Stylesheet rechnet mit der Geometrie aus chart.js', () => {
  assert.ok(HOST, '.chart-host traegt keine eigene --chart-inset');
  const anchor = CHART.PAD_L - AXIS_GAP;
  assert.match(HOST, new RegExp(`\\*\\s*${CHART.W}\\s*-\\s*100%\\s*\\*\\s*${anchor}\\)\\s*/\\s*${CHART.W - anchor}\\)`),
    `der Wert steht rechtsbuendig bei PAD_L - AXIS_GAP = ${anchor}: die Formel muss (L * ${CHART.W} - 100% * ${anchor}) / ${CHART.W - anchor} rechnen`);
  assert.match(HOST, new RegExp(`\\*\\s*${CHART.W}\\s*-\\s*100%\\s*\\*\\s*${CHART.PAD_L}\\)\\s*/\\s*${CHART.W - CHART.PAD_L}\\)`),
    'die Mindestbreite bleibt als untere Grenze in der Formel');
  // Und der Wert steht wirklich dort, womit die Formel rechnet.
  const xs = [...chartGridMarkup(0, 4, String).matchAll(/<text x="([\d.]+)"[^>]*chart__axis--y/g)].map((m) => Number(m[1]));
  assert.equal(xs.length, 5);
  assert.deepEqual([...new Set(xs)], [anchor]);
});

/* ── fitChartGutter: was an das Elternelement geht ───────────────────────── */

function fakeHost() {
  const host = { classes: [], props: {} };
  host.classList = { add: (name) => host.classes.push(name) };
  host.style = { setProperty: (name, value) => { host.props[name] = value; } };
  return host;
}
function fakeLabels(host, widths, { inDocument = true } = {}) {
  const svg = { parentElement: inDocument ? host : null };
  return widths.map((width) => ({
    closest: (selector) => (selector === 'svg.chart' ? svg : null),
    getBoundingClientRect: () => ({ width }),
  }));
}
const fakeRoot = (labels) => ({
  querySelectorAll: (selector) => {
    assert.equal(selector, 'svg.chart .chart__axis--y', 'gemessen werden die Werte der Y-Achse, nicht die Daten der X-Achse');
    return labels;
  },
});

test('fitChartGutter schreibt die Breite des breitesten Werts an das Elternelement', () => {
  const host = fakeHost();
  fitChartGutter(fakeRoot(fakeLabels(host, [67.1, 67, 66.6, 18])));
  assert.deepEqual(host.props, { '--chart-label-width': '68px' }, 'aufgerundet: ein halber Pixel zu wenig schneidet das erste Zeichen an');
  assert.deepEqual(host.classes, ['chart-host']);
});

test('fitChartGutter misst jedes Diagramm fuer sich', () => {
  const a = fakeHost();
  const b = fakeHost();
  fitChartGutter(fakeRoot([...fakeLabels(a, [20.2, 12]), ...fakeLabels(b, [99.01])]));
  assert.equal(a.props['--chart-label-width'], '21px');
  assert.equal(b.props['--chart-label-width'], '100px');
});

test('fitChartGutter laesst stehen, was keine Breite hat', () => {
  // Ein Diagramm, das beim Aufbau nicht im Bild steht, misst 0 - dann gilt die Mindestbreite weiter.
  const hidden = fakeHost();
  fitChartGutter(fakeRoot(fakeLabels(hidden, [0, 0])));
  assert.deepEqual(hidden.props, {});
  assert.deepEqual(hidden.classes, []);
  const detached = fakeHost();
  fitChartGutter(fakeRoot(fakeLabels(detached, [50], { inDocument: false })));
  assert.deepEqual(detached.props, {});
  assert.doesNotThrow(() => fitChartGutter(null));
  assert.doesNotThrow(() => fitChartGutter({}));
});

/* TEXTGUARD, und als solcher gemeint: dass der Budget-Verlauf den Helfer NACH
 * dem Einsetzen ruft, steht hier nur als Reihenfolge im Quelltext. Den Aufruf
 * selbst faehrt test:ko-layout-browser. */
test('der Budget-Verlauf misst seine Achse, nachdem er im Dokument steht', () => {
  const src = read('../public/pages/budget-stats.js');
  const fn = src.slice(src.indexOf('function renderTrendChart()'), src.indexOf('function periodLabel('));
  const inserted = fn.indexOf("host.insertAdjacentHTML('beforeend'");
  const fitted = fn.search(/^\s*fitChartGutter\(host\);/m);
  assert.ok(inserted > 0, 'renderTrendChart setzt das Diagramm nicht mehr per insertAdjacentHTML ein');
  assert.ok(fitted > inserted, 'fitChartGutter(host) muss nach dem Einsetzen stehen: vorher hat kein Wert eine Breite');
});
