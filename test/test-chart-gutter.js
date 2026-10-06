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
 * der Browser dieselbe Formel so anwendet, misst `test:ko-layout-browser` am
 * Budget-Verlauf; dass jedes Diagramm gemessen wird, sobald es im Dokument
 * steht (#1722), misst `test:chart-gutter-browser` an den gerenderten Seiten.
 * Hier steht der Beobachter dazu an Attrappen.
 *
 * Fehlt `.chart-host`, rechnet der Test mit der Regel in `:root` weiter - also
 * mit dem Stand vor dem Fix. Er wird dann am Won-Wert rot und nicht an einer
 * fehlenden Regel: genau der Befund, der gemeldet war.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { eachRule } from './css-rules.js';
import { CHART, AXIS_GAP, chartGridMarkup, fitChartGutter, watchChartGutters } from '../public/utils/chart.js';

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

test('fitChartGutter misst im neuen Massstab nach und nimmt den groesseren Wert', () => {
  // Das Polster aendert den Massstab, und Chrome setzt denselben Text darin anders breit (#1722).
  const grows = fakeHost();
  const widthAfter = (host, first, second) => () => ({ width: host.props['--chart-label-width'] ? second : first });
  const growing = fakeLabels(grows, [0]);
  growing[0].getBoundingClientRect = widthAfter(grows, 69.4, 75.8);
  fitChartGutter(fakeRoot(growing));
  assert.equal(grows.props['--chart-label-width'], '76px', 'der Wert ist im Massstab nach dem Polster breiter: der breitere gilt');
  // Wird er schmaler, bleibt der erste Wert - nach unten wird nicht nachgezogen, sonst pendelt es.
  const shrinks = fakeHost();
  const shrinking = fakeLabels(shrinks, [0]);
  shrinking[0].getBoundingClientRect = widthAfter(shrinks, 77.6, 70.7);
  fitChartGutter(fakeRoot(shrinking));
  assert.equal(shrinks.props['--chart-label-width'], '78px');
  assert.deepEqual(shrinks.classes, ['chart-host'], 'ein Traeger wird nur einmal angefasst, wenn sich nichts aendert');
});

/* ── watchChartGutters: Einsetzen und Messen sind ein Schritt (#1722) ────── */

/** Die beiden Beobachter als Attrappen: der Test loest ihre Rueckrufe selbst aus. */
function fakeObservers() {
  const seen = { added: [], sized: [] };
  class Added {
    constructor(callback) { this.callback = callback; this.targets = []; this.connected = true; seen.added.push(this); }
    observe(target, options) { this.targets.push({ target, options }); }
    disconnect() { this.connected = false; }
  }
  class Sized {
    constructor(callback) { this.callback = callback; this.targets = new Set(); this.connected = true; seen.sized.push(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.connected = false; this.targets.clear(); }
  }
  return { seen, options: { MutationObserver: Added, ResizeObserver: Sized } };
}

/** Ein `svg.chart` mit Werten an einem Traeger. `shown` schaltet, ob es eine Flaeche hat. */
function fakeChart(labelWidths) {
  const host = fakeHost();
  const svg = {
    nodeType: 1, isConnected: true, shown: true, parentElement: host,
    closest: (selector) => (selector === 'svg.chart' ? svg : null),
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: svg.shown ? 300 : 0 }),
  };
  const labels = labelWidths.map((width) => ({
    closest: (selector) => (selector === 'svg.chart' ? svg : null),
    getBoundingClientRect: () => ({ width: svg.shown ? width : 0 }),
  }));
  host.querySelectorAll = (selector) => (selector === 'svg.chart .chart__axis--y' ? labels : []);
  return { host, svg };
}
/** Ein Knoten, der Diagramme ENTHAELT - so kommt ein ganzer Abschnitt ins Dokument. */
const fakeSection = (...svgs) => ({
  nodeType: 1,
  closest: () => null,
  querySelectorAll: (selector) => (selector === 'svg.chart' ? svgs : []),
});
const fakeBody = (...svgs) => ({ ...fakeSection(...svgs), isBody: true });
const insert = (observer, ...nodes) => observer.callback([{ addedNodes: nodes, removedNodes: [] }]);
const remove = (observer, ...nodes) => observer.callback([{ addedNodes: [], removedNodes: nodes }]);

test('watchChartGutters misst ein Diagramm, sobald es im Dokument steht - ohne Aufruf der Seite', () => {
  const { seen, options } = fakeObservers();
  const body = fakeBody();
  watchChartGutters(body, options);
  assert.equal(seen.added.length, 1);
  assert.deepEqual(seen.added[0].targets, [{ target: body, options: { childList: true, subtree: true } }],
    'beobachtet wird der ganze Baum: ein Diagramm kommt als Teil eines Abschnitts');
  const direct = fakeChart([20.2]);
  const nested = fakeChart([77.6, 31]);
  insert(seen.added[0], direct.svg, { nodeType: 3 }, fakeSection(nested.svg));
  assert.equal(direct.host.props['--chart-label-width'], '21px');
  assert.equal(nested.host.props['--chart-label-width'], '78px', 'ein Wort an der Achse ("Umiarkowane", 77.6px) bekommt seinen Platz');
  assert.deepEqual(nested.host.classes, ['chart-host']);
  assert.equal(seen.sized[0].targets.size, 0, 'ein gemessenes Diagramm wartet auf nichts mehr');
});

test('watchChartGutters misst, was beim Start schon im Dokument steht', () => {
  const { options } = fakeObservers();
  const chart = fakeChart([44]);
  watchChartGutters(fakeBody(chart.svg), options);
  assert.equal(chart.host.props['--chart-label-width'], '44px');
});

test('watchChartGutters wartet auf ein Diagramm ohne Flaeche und misst es, wenn es eine hat', () => {
  // Der Schweregrad-Verlauf liegt in einem geschlossenen Aufklapper.
  const { seen, options } = fakeObservers();
  watchChartGutters(fakeBody(), options);
  const chart = fakeChart([77.6]);
  chart.svg.shown = false;
  insert(seen.added[0], fakeSection(chart.svg));
  assert.deepEqual(chart.host.props, {}, 'ohne Flaeche gibt es nichts zu messen');
  const waiting = seen.sized[0];
  assert.ok(waiting.targets.has(chart.svg), 'das Diagramm muss auf seine Flaeche warten');
  // Ein Rueckruf, solange es weiter keine Flaeche hat, aendert nichts.
  waiting.callback([{ target: chart.svg }]);
  assert.deepEqual(chart.host.props, {});
  assert.ok(waiting.targets.has(chart.svg));
  chart.svg.shown = true;
  waiting.callback([{ target: chart.svg }]);
  assert.equal(chart.host.props['--chart-label-width'], '78px');
  assert.ok(!waiting.targets.has(chart.svg), 'einmal gemessen, wird es entlassen: die Schrift skaliert nicht mit');
});

test('watchChartGutters entlaesst ein wartendes Diagramm, das aus dem Dokument geht', () => {
  const { seen, options } = fakeObservers();
  watchChartGutters(fakeBody(), options);
  const chart = fakeChart([50]);
  chart.svg.shown = false;
  const section = fakeSection(chart.svg);
  insert(seen.added[0], section);
  assert.ok(seen.sized[0].targets.has(chart.svg));
  remove(seen.added[0], section);
  assert.ok(!seen.sized[0].targets.has(chart.svg));
  // Und ein Diagramm, das schon wieder weg ist, wenn der Rueckruf laeuft, wird nicht angefasst.
  const gone = fakeChart([50]);
  gone.svg.isConnected = false;
  insert(seen.added[0], gone.svg);
  assert.deepEqual(gone.host.props, {});
  assert.ok(!seen.sized[0].targets.has(gone.svg));
});

test('watchChartGutters misst neu, wenn nur die Achse eines Diagramms getauscht wird', () => {
  const { seen, options } = fakeObservers();
  watchChartGutters(fakeBody(), options);
  const chart = fakeChart([90]);
  insert(seen.added[0], { nodeType: 1, closest: (selector) => (selector === 'svg.chart' ? chart.svg : null), querySelectorAll: () => [] });
  assert.equal(chart.host.props['--chart-label-width'], '90px');
});

test('watchChartGutters laesst sich beenden und braucht keinen ResizeObserver', () => {
  const { seen, options } = fakeObservers();
  const stop = watchChartGutters(fakeBody(), options);
  stop();
  assert.equal(seen.added[0].connected, false);
  assert.equal(seen.sized[0].connected, false);
  // Ohne ResizeObserver bleibt ein Diagramm ohne Flaeche bei der Mindestbreite - kein Wurf.
  const bare = fakeObservers();
  watchChartGutters(fakeBody(), { MutationObserver: bare.options.MutationObserver, ResizeObserver: undefined });
  const hidden = fakeChart([50]);
  hidden.svg.shown = false;
  assert.doesNotThrow(() => insert(bare.seen.added[0], hidden.svg));
  const shown = fakeChart([50]);
  insert(bare.seen.added[0], shown.svg);
  assert.equal(shown.host.props['--chart-label-width'], '50px');
  // Ohne MutationObserver (Node, alte Umgebung) passiert nichts.
  assert.doesNotThrow(() => watchChartGutters(fakeBody(), { MutationObserver: undefined })());
  assert.doesNotThrow(() => watchChartGutters(null)());
});

/* DER BEOBACHTER STARTET MIT DEM MODUL. Ein `.chart__axis--y` entsteht nur
 * ueber `chartGridMarkup()`; wer ein Diagramm zeichnen kann, hat chart.js
 * geladen. Hier wird das Modul ein zweites Mal geladen, mit einem Dokument:
 * gefahren, nicht gelesen. Dass der Browser es genauso tut und jedes der neun
 * Diagramme davon erreicht wird, misst test:chart-gutter-browser. */
test('chart.js beobachtet document.body, sobald es geladen ist', async () => {
  const { seen, options } = fakeObservers();
  const body = fakeBody();
  const before = { document: globalThis.document, MutationObserver: globalThis.MutationObserver, ResizeObserver: globalThis.ResizeObserver };
  Object.assign(globalThis, { document: { body }, ...options });
  try {
    await import('../public/utils/chart.js?mit-dokument');
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
  assert.equal(seen.added.length, 1, 'beim Laden muss genau ein Beobachter entstehen');
  assert.equal(seen.added[0].targets[0]?.target, body);
  const chart = fakeChart([67.1]);
  insert(seen.added[0], fakeSection(chart.svg));
  assert.equal(chart.host.props['--chart-label-width'], '68px');
});

test('keine Seite ruft fitChartGutter selbst: der Weg ist einer', () => {
  // TEXTGUARD, und als solcher gemeint: ein zweiter Weg neben dem Beobachter
  // waere wieder ein Aufruf, den die naechste Seite vergessen kann.
  for (const file of readdirSync(new URL('../public/pages/', import.meta.url)).filter((name) => name.endsWith('.js'))) {
    assert.doesNotMatch(read(`../public/pages/${file}`), /\bfitChartGutter\b/, `${file} ruft fitChartGutter selbst`);
  }
});
