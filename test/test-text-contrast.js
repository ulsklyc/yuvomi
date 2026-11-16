/**
 * Modul: Test-Infrastruktur - Farbrechnung der Sonde 2 (test/text-contrast.js)
 * Zweck: Sonde 2 der Dokument-Guards rechnet den Textkontrast auf dem
 *        KOMPONIERTEN Untergrund. Ihre Rechnung legte Verlaufsstops auf den
 *        fertigen Untergrund, also auch ueber Ebenen, die real ueber dem
 *        Verlauf liegen: die Karte `.empty-state.session-unreachable`
 *        (rgba(251, 250, 247, 0.86)) ueber dem Lichtfeld von `.app-shell` kam
 *        rechnerisch auf 4.33:1 und 3.94:1, real auf rund 5.70:1 und 5.18:1 -
 *        jeder 429 waehrend der Sonde machte sie rot. Hier steht beides: der
 *        Fall darf nicht mehr rot sein, und derselbe Verlauf direkt unter dem
 *        Text muss rot bleiben, sonst waere die Sonde blind geworden.
 *        Dieselbe Rechnung traegt `measureFasting` (test/fasting-visual-harness.js),
 *        das bis 2026-11 eine eigene Kopie der alten Rechnung fuehrte; die
 *        Faelle unten fahren es browserfrei mit einer Stub-Seite.
 * Ausfuehren: npm run test:text-contrast
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSample } from './text-contrast.js';
import { measureFasting } from './fasting-visual-harness.js';

const PAGE_BASE = [255, 255, 255];
const FIELD_FROM = 'color(srgb 0.545098 0.360784 0.964706';
const FIELD_TO = 'color(srgb 0.423529 0.227451 0.929412';
const STEPS = [100, 98, 90, 79, 65, 50, 35, 21, 10, 2];

/**
 * `--brand-field` (tokens.css) so, wie Chromium es als computed
 * `background-image` liefert: drei radiale Verlaeufe, Spitze bei 0.2 Deckung.
 * @param {string} from
 * @param {number} peak
 */
const radial = (from, peak) =>
  `radial-gradient(${STEPS.map((p, i) => `${from} / ${((0.2 * p * peak) / 10000).toFixed(4)}) ${i * 10}%`).join(', ')}, rgba(0, 0, 0, 0) 100%)`;
const BRAND_FIELD = [radial(FIELD_FROM, 100), radial(FIELD_TO, 100), radial(FIELD_FROM, 80)].join(', ');

const APP_SHELL = { bg: 'rgb(245, 243, 237)', image: BRAND_FIELD };
const NONE = { bg: 'rgba(0, 0, 0, 0)', image: 'none' };
const ROOT = { bg: 'rgb(245, 243, 237)', image: 'none' };

/**
 * @param {string} color
 * @param {Array<{bg: string, image: string}>} layers
 */
const sample = (color, layers) => ({ color, size: 14, weight: 400, layers });

test('Karte ueber dem Lichtfeld: der Verlauf liegt UNTER der Karte und kommt nur gedaempft durch', () => {
  const card = { bg: 'rgba(251, 250, 247, 0.86)', image: 'none' };
  /** @type {Array<[string, number]>} gemessen: #63615B und #6B675F auf #F7F5F6 */
  const cases = [
    ['rgb(99, 97, 91)', 5.7],
    ['rgb(107, 103, 95)', 5.18],
  ];
  for (const [color, expected] of cases) {
    const result = evaluateSample(sample(color, [NONE, card, APP_SHELL, NONE, ROOT]), PAGE_BASE);
    assert.ok(result);
    assert.equal(result.min, 4.5);
    assert.ok(result.ratio >= result.min, `${color}: ${result.ratio.toFixed(2)}:1 auf der Karte`);
    assert.ok(Math.abs(result.ratio - expected) < 0.1, `${color}: ${result.ratio.toFixed(2)}:1, erwartet rund ${expected}`);
  }
});

test('derselbe Verlauf direkt unter dem Text bleibt rot', () => {
  for (const color of ['rgb(99, 97, 91)', 'rgb(107, 103, 95)']) {
    const result = evaluateSample(sample(color, [NONE, NONE, APP_SHELL, NONE, ROOT]), PAGE_BASE);
    assert.ok(result);
    assert.ok(result.ratio < 4.5, `${color}: ${result.ratio.toFixed(2)}:1 - die Sonde sieht den Verlauf nicht mehr`);
  }
});

test('ein Verlauf auf der Karte selbst zaehlt ueber ihrer Farbe', () => {
  // background-image malt ueber background-color DERSELBEN Ebene: ein Stop auf
  // der Karte darf von ihrer eigenen Deckung nicht gedaempft werden.
  const card = { bg: 'rgba(251, 250, 247, 0.86)', image: `linear-gradient(${FIELD_FROM} / 0.3), rgba(0, 0, 0, 0))` };
  const result = evaluateSample(sample('rgb(107, 103, 95)', [NONE, card, APP_SHELL, NONE, ROOT]), PAGE_BASE);
  assert.ok(result);
  assert.ok(result.ratio < 4.5, `${result.ratio.toFixed(2)}:1 - der Stop der Karte wurde unter ihre Farbe gerechnet`);
});

test('ein echtes Bild bleibt unrechenbar', () => {
  const layers = [NONE, { bg: 'rgb(255, 255, 255)', image: 'url("x.png")' }];
  assert.equal(evaluateSample(sample('rgb(0, 0, 0)', layers), PAGE_BASE), null);
});

test('die Kandidatenmenge waechst nicht mit gleichen Stops', { timeout: 5000 }, () => {
  // Zwanzig Ebenen mit je drei gleichen Stops: ohne Deduplizierung waeren es
  // 4^20 Kandidaten und die Rechnung kaeme nie an; mit ihr sind es 21.
  const stop = `${FIELD_FROM} / 0.2)`;
  const layers = [
    NONE,
    ...Array.from({ length: 20 }, () => ({ bg: 'rgba(0, 0, 0, 0)', image: `linear-gradient(${stop}, ${stop}, ${stop})` })),
    ROOT,
  ];
  assert.ok(evaluateSample(sample('rgb(0, 0, 0)', layers), PAGE_BASE));
});

/**
 * Stub fuer die Puppeteer-Seite: `measureFasting` ruft `$eval` dreimal -
 * Einschwingen, Textproben, Geometrie - und bekommt hier feste Antworten.
 * @param {Array<{text: string, color: string, size: number, weight: number, layers: Array<{bg: string, image: string}>}>} samples
 */
const stubPage = (samples) => {
  const answers = [undefined, samples, { width: 360, scrollWidth: 360, viewport: 390, documentWidth: 390 }];
  return { $eval: async () => answers.shift() };
};

/** @param {Array<{bg: string, image: string}>} layers */
const fastingSamples = (layers) =>
  ['Fasten', '16:8', 'Seit 12 Stunden'].map((text) => ({ ...sample('rgb(107, 103, 95)', layers), text }));

test('measureFasting: Text auf der Karte ueber dem Lichtfeld besteht', async () => {
  const card = { bg: 'rgba(251, 250, 247, 0.86)', image: 'none' };
  const { measured } = await measureFasting(stubPage(fastingSamples([NONE, card, APP_SHELL, NONE, ROOT])), '.fasting-card', 'card');
  assert.equal(measured.length, 3);
  for (const entry of measured) {
    assert.deepEqual(Object.keys(entry), ['text', 'size', 'ratio', 'minimum']);
    assert.equal(entry.minimum, 4.5);
    assert.ok(entry.ratio >= 4.5, `${entry.text}: ${entry.ratio.toFixed(2)}:1`);
  }
});

test('measureFasting: derselbe Verlauf direkt unter dem Text scheitert', async () => {
  await assert.rejects(
    measureFasting(stubPage(fastingSamples([NONE, NONE, APP_SHELL, NONE, ROOT])), '.fasting-card', 'field'),
    /Rendered text meets AA/,
  );
});

test('measureFasting: ein echtes Bild unter dem Text scheitert', async () => {
  const image = { bg: 'rgb(255, 255, 255)', image: 'url("x.png")' };
  await assert.rejects(
    measureFasting(stubPage(fastingSamples([NONE, image, ROOT])), '.fasting-card', 'image'),
    /Text background image needs pixel-based inspection/,
  );
});
