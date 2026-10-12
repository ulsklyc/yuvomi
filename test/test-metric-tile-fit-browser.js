/**
 * Modul: Wert und Einheit einer Vitalkachel stehen auf einer Zeile (#1799) - Browser-Sonde
 * Zweck: Die Stufenleiter von `.metric-card__value` (panel.css) fragt die Breite
 *        der REIHE. Die beiden Vitalraster der Gesundheit fuellen sich selbst
 *        (`auto-fit`/`auto-fill`), also sagt die Reihe nichts ueber die Kachel:
 *        gemessen vor dem Fix stand "mmHg" bei 624-1100px Reihenbreite in jeder
 *        150-172px breiten Kachel unter "116/74" (Wert in 28px), und bei 320px
 *        Fensterbreite in der 138px-Kachel der Vitalwerte-Seite ebenso.
 *        Seitdem ist die Wertzeile jeder Kachel ein Container (`metric-tile`
 *        an `.metric-card__body`). Nicht die Kachel: als Container ist sie
 *        kein Subgrid mehr, und die geteilten Zeilen aus R18 (#1794) fallen weg -
 *        das haelt die Probe mit den gemischten Kacheln.
 * Ausfuehren: npm run test:metric-tile-fit-browser (haengt an test:document-guards)
 *
 * WARUM IM BROWSER. Wie breit "116/74" in Title 1 steht und ob eine Flex-Zeile
 * umbricht, weiss nur der Browser. Die Sonde braucht dafuer weder Server noch
 * Anmeldung: eine statische Seite mit den ECHTEN Stylesheets und dem Markup,
 * das `cardMarkup()` und `overviewVitalCardMarkup()` (public/pages/health.js)
 * schreiben. Dass dieses Markup noch das der Seite ist, haelt der erste Test.
 *
 * JEDE SONDE PRUEFT ZUERST, DASS SIE ETWAS MISST: eine Kachel ohne Einheit
 * bricht nirgends um.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';
import { tempDir } from './tmp-dir.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHEETS = ['tokens', 'reset', 'layout', 'typography', 'panel', 'health'];

/* Der breiteste Wert zuerst: dreistellig ueber dreistellig ist der Fall, an dem
 * die Stufen bemessen sind. Die uebrigen zeigen, dass kurze Werte mitkommen. */
const VALUES = [
  ['116/74', 'mmHg'], ['180/110', 'mmHg'], ['98', '%'], ['72', 'bpm'],
  ['36,6', '°C'], ['7:30', 'Std.'], ['108', 'mg/dL'], ['82,4', 'kg'],
];

/* Die Trendlinie, wie `sparklineMarkup()` sie schreibt (ohne den Verlauf). */
const SPARK = '<svg class="metric-card__spark" viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true"><polyline points="3,20 50,8 97,14" fill="none" stroke-width="1.5" /></svg>';
/* Ein Label, das in jeder Kachel unter ~250px zwei Zeilen braucht. */
const LONG_LABEL = 'Sauerstoffsättigung im Blut';

function tile(extraClass, [value, unit], { label = 'Blutdruck', spark = false } = {}) {
  return `<button type="button" class="metric-card metric-card--select${extraClass}">
    <span class="metric-card__head"><i class="metric-card__icon" aria-hidden="true"></i><span class="metric-card__label">${label}</span></span>
    <span class="metric-card__body"><span class="metric-card__value">${value}</span> <span class="metric-card__unit">${unit}</span></span>
    ${spark ? SPARK : ''}
    <span class="metric-card__meta"><span>03.10.</span></span>
  </button>`;
}

/* GEMISCHTE KACHELN, wie die Seite sie hat: mit und ohne Trendlinie, ein- und
 * zweizeiliges Label. Acht gleiche Kacheln sind von selbst gleich hoch und
 * sagen nichts ueber die geteilten Zeilen aus `.metric-rows`. Die Uebersicht
 * fuehrt keine Trendlinien (`overviewVitalCardMarkup()`), die Vitalwerte-Seite
 * schon (`cardMarkup()`). */
const mixed = (extraClass, { sparks }) => VALUES.map((v, i) => tile(extraClass, v, {
  label: i % 4 === 1 ? LONG_LABEL : 'Blutdruck',
  spark: sparks && i % 2 === 0,
})).join('');

const PAGE = `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${SHEETS.map((name) => `<link rel="stylesheet" href="${pathToFileURL(join(ROOT, 'public/styles', `${name}.css`)).href}">`).join('\n')}
</head><body>
<div id="host-overview"><div class="health-overview__vitals-grid metric-rows">${mixed(' metric-card--inset', { sparks: false })}</div></div>
<div id="host-vitals"><div class="health-vitals__cards metric-rows">${mixed('', { sparks: true })}</div></div>
<div id="host-plain"><div class="metric-grid"><article class="metric-card"><div class="metric-card__label">Einnahmen</div><div class="metric-card__value">24.503,00 €</div></article><article class="metric-card"><div class="metric-card__label">Ausgaben</div><div class="metric-card__value">1.200,00 €</div></article><article class="metric-card"><div class="metric-card__label">Saldo</div><div class="metric-card__value">23.303,00 €</div></article></div></div>
</body></html>`;

let browser;
let url;

before(async () => {
  // tempDir() raeumt beim Prozessende weg (test/tmp-dir.js, test:tmp-clean).
  const file = join(tempDir('yuvomi-metric-tile-'), 'tiles.html');
  writeFileSync(file, PAGE);
  url = pathToFileURL(file).href;
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});

after(async () => {
  await browser?.close();
});

/** Misst jede Kachel eines Rasters bei jeder der genannten Reihenbreiten. */
async function sweep(viewport, hostId, rowWidths, { columns = null } = {}) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: viewport, height: 900 });
    await page.goto(url);
    await page.evaluate(() => document.fonts.ready);
    return await page.evaluate((hostId, rowWidths, columns) => {
      const host = document.getElementById(hostId);
      // Nur fuer die Gegenprobe am Messgeraet: eine Spur, die es auf der Seite nicht gibt.
      if (columns) host.firstElementChild.style.gridTemplateColumns = columns;
      const out = [];
      for (const row of rowWidths) {
        host.style.width = `${row}px`;
        for (const card of host.querySelectorAll('.metric-card')) {
          const value = card.querySelector('.metric-card__value');
          const unit = card.querySelector('.metric-card__unit');
          const v = value.getBoundingClientRect();
          const u = unit.getBoundingClientRect();
          const c = card.getBoundingClientRect();
          const style = getComputedStyle(card);
          const inner = c.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth);
          out.push({
            row,
            text: `${value.textContent} ${unit.textContent}`,
            tile: Math.round(c.width),
            valueSize: getComputedStyle(value).fontSize,
            unitSize: getComputedStyle(unit).fontSize,
            // Die Einheit steht unter dem Wert, sobald ihre Oberkante dessen Unterkante erreicht.
            wrapped: u.top >= v.bottom - 1,
            overflow: Math.round((Math.max(v.right, u.right) - inner) * 10) / 10,
          });
        }
      }
      return out;
    }, hostId, rowWidths, columns);
  } finally {
    await page.close();
  }
}

const range = (from, to, step = 2) => {
  const out = [];
  for (let w = from; w <= to; w += step) out.push(w);
  return out;
};

function assertOneLine(rows, where) {
  assert.ok(rows.length > 0, `${where}: die Sonde hat keine Kachel gemessen`);
  assert.ok(rows.some((r) => r.text.includes('mmHg')), `${where}: der Blutdruck fehlt in der Messung`);
  const bad = rows.filter((r) => r.wrapped || r.overflow > 0.5);
  const sample = bad.slice(0, 5).map((r) => `"${r.text}" Reihe ${r.row}px, Kachel ${r.tile}px, Wert ${r.valueSize}, Einheit ${r.unitSize}, ${r.wrapped ? 'umgebrochen' : `${r.overflow}px ueber der Kante`}`);
  assert.equal(bad.length, 0, `${where}: ${bad.length} von ${rows.length} Messungen ohne gemeinsame Zeile\n  ${sample.join('\n  ')}`);
}

test('die Sonde misst das Markup, das health.js schreibt', () => {
  const source = readFileSync(join(ROOT, 'public/pages/health.js'), 'utf8');
  // Beide Kachelbauer setzen Wert und Einheit als Geschwister in `.metric-card__body`.
  const pair = source.split('<span class="metric-card__value">${esc(card.value)}</span>${unit ? ` <span class="metric-card__unit">${unit}</span>` : \'\'}').length - 1;
  assert.equal(pair, 2, 'cardMarkup() und overviewVitalCardMarkup() setzen Wert und Einheit nicht mehr so, wie die Sonde sie nachbaut');
  assert.equal(source.split('<span class="metric-card__body">${valueHtml}</span>').length - 1, 2);
  assert.ok(source.includes('class="health-vitals__cards metric-rows"'), 'das Raster der Vitalwerte-Seite heisst anders');
  assert.ok(source.includes('class="health-overview__vitals-grid metric-rows"'), 'das Raster der Uebersicht heisst anders');
  assert.ok(source.includes('metric-card metric-card--select metric-card--inset'), 'die Kachel der Uebersicht ist nicht mehr --inset');
  // Die Trendlinie steht zwischen Wert und Meta, nur auf der Vitalwerte-Seite.
  assert.ok(source.includes('<svg class="metric-card__spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">'), 'die Trendlinie ist anders gebaut');
  assert.equal(source.split("${latest ? sparklineMarkup(series.points, 'value_num', metric) : ''}").length - 1, 1, 'genau ein Kachelbauer fuehrt die Trendlinie');
});

test('die Sonde erkennt einen Umbruch: eine zu schmale Kachel faellt auf', async () => {
  // Gegenprobe am Messgeraet selbst. 100px sind schmaler als jede Kachel der
  // Seite (die Mindestspur ist 150px) - dort MUSS es umbrechen.
  const rows = await sweep(1280, 'host-overview', [400], { columns: '100px' });
  assert.ok(rows.some((r) => r.text === '180/110 mmHg' && (r.wrapped || r.overflow > 0.5)),
    'eine 100px-Kachel traegt "180/110 mmHg" in einer Zeile - die Sonde misst nichts');
});

test('Uebersicht, Desktop: keine Einheit auf eigener Zeile, 160-1100px Reihenbreite', async () => {
  assertOneLine(await sweep(1280, 'host-overview', range(160, 1100)), 'Uebersicht 1280px');
});

test('Vitalwerte, Desktop: keine Einheit auf eigener Zeile, 160-1100px Reihenbreite', async () => {
  assertOneLine(await sweep(1280, 'host-vitals', range(160, 1100)), 'Vitalwerte 1280px');
});

test('Telefon (390px und 320px Fenster): keine Einheit auf eigener Zeile', async () => {
  // 358px = 390px Fenster minus Seitenrand, 288px = 320px Fenster.
  for (const viewport of [390, 320]) {
    for (const host of ['host-overview', 'host-vitals']) {
      assertOneLine(await sweep(viewport, host, range(160, viewport - 32)), `${host} bei ${viewport}px`);
    }
  }
});

test('Telefon: die Vitalwerte-Seite bleibt bei 390px zweispaltig und hat nie mehr als zwei Spalten', async () => {
  const at390 = await sweep(390, 'host-vitals', [358]);
  assert.deepEqual([...new Set(at390.map((r) => r.tile))], [173], 'bei 390px stehen zwei 173px-Kacheln je Zeile');
  const at600 = await sweep(600, 'host-vitals', [568]);
  assert.deepEqual([...new Set(at600.map((r) => r.tile))], [278], 'bei 600px bleiben es zwei Spalten');
});

test('wo Platz ist, behaelt der Wert Title 1 und die Einheit ihre Groesse', async () => {
  // Acht Kacheln je 205px in einer Zeile: die Stufen duerfen breite Kacheln nicht verkleinern.
  const rows = await sweep(1800, 'host-overview', [1700]);
  // 168px Innenbreite ist die Schwelle (panel.css), plus 26px Polster und Kante.
  const wide = rows.filter((r) => r.tile >= 194);
  assert.ok(wide.length > 0);
  for (const r of wide) {
    assert.equal(r.valueSize, '28px', `${r.text} in ${r.tile}px`);
    assert.equal(r.unitSize, '14px', `${r.text} in ${r.tile}px`);
  }
});

test('die Kachelstufe hebt eine kleinere Stufe der Reihe nie an', async () => {
  // Reihe 358px vergibt Title 3 (20px); die 173px-Kachel hat 147px Innenbreite, also
  // die Title-2-Stufe der Kachel, und darf den Wert nicht auf 22px zurueckheben.
  const rows = await sweep(390, 'host-vitals', [358]);
  for (const r of rows) assert.equal(r.valueSize, '20px', `${r.text} in ${r.tile}px`);
});

test('die uebrigen Kennzahlkarten sind keine Container und behalten ihre Stufen', async () => {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(url);
    const measured = await page.evaluate(() => {
      const host = document.getElementById('host-plain');
      const out = {};
      for (const row of [990, 560, 360]) {
        host.style.width = `${row}px`;
        const card = host.querySelector('.metric-card');
        out[row] = {
          container: getComputedStyle(card).containerType,
          size: getComputedStyle(card.querySelector('.metric-card__value')).fontSize,
        };
      }
      return out;
    });
    assert.deepEqual(measured, {
      990: { container: 'normal', size: '28px' },
      560: { container: 'normal', size: '22px' },
      360: { container: 'normal', size: '20px' },
    });
  } finally {
    await page.close();
  }
});

test('gemischte Kacheln einer Zeile teilen ihre vier Zeilen: Wert und Datum stehen je auf einer Linie', async (t) => {
  // R18 (#1794): Kopf - Wert - Trendlinie - Meta liegen ueber Subgrid in
  // gemeinsamen Zeilen. Ein Container AUF DER KACHEL nimmt ihr das (Layout-
  // Containment schaltet Subgrid ab): gemessen standen die Werte dann auf
  // 31/44/31/31 und die Datumszeilen auf 84/75/62/84 statt je auf einer Linie.
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(url);
    for (const hostId of ['host-overview', 'host-vitals']) {
      const cards = await page.evaluate((hostId) => {
        const host = document.getElementById(hostId);
        host.style.width = '760px';
        const origin = host.getBoundingClientRect().top;
        const top = (el) => Math.round((el.getBoundingClientRect().top - origin) * 10) / 10;
        return [...host.querySelectorAll('.metric-card')].map((card) => ({
          top: top(card),
          height: Math.round(card.getBoundingClientRect().height * 10) / 10,
          rows: getComputedStyle(card).gridTemplateRows,
          labelHeight: Math.round(card.querySelector('.metric-card__label').getBoundingClientRect().height),
          spark: Boolean(card.querySelector('.metric-card__spark')),
          body: top(card.querySelector('.metric-card__body')),
          meta: top(card.querySelector('.metric-card__meta')),
        }));
      }, hostId);
      const row = cards.filter((c) => c.top === cards[0].top);
      const show = (key) => row.map((c) => c[key]).join('/');
      t.diagnostic(`${hostId}: Wert ${show('body')}, Datum ${show('meta')}, Hoehe ${show('height')}, Label ${show('labelHeight')}`);

      // Vorbedingungen: die Zeile IST gemischt - sonst misst der Test nichts.
      assert.equal(row.length, 4, `${hostId}: bei 760px stehen vier Kacheln in der ersten Zeile (${row.length})`);
      assert.ok(new Set(row.map((c) => c.labelHeight)).size > 1, `${hostId}: kein Label bricht um (${show('labelHeight')})`);
      if (hostId === 'host-vitals') {
        assert.deepEqual(row.map((c) => c.spark), [true, false, true, false], 'Vitalwerte: jede zweite Kachel fuehrt eine Trendlinie');
      }

      assert.equal(new Set(row.map((c) => c.body)).size, 1, `${hostId}: die Werte stehen auf verschiedenen Hoehen (${show('body')})`);
      assert.equal(new Set(row.map((c) => c.meta)).size, 1, `${hostId}: die Datumszeilen stehen auf verschiedenen Hoehen (${show('meta')})`);
      assert.equal(new Set(row.map((c) => c.height)).size, 1, `${hostId}: ungleiche Hoehen (${show('height')})`);
      assert.ok(row[0].height >= 60, `${hostId}: die Kachel ist ${row[0].height}px hoch - zusammengefallen`);
      // Die Ursache hinter den Linien: ohne Subgrid halten sie nur, solange nichts umbricht.
      // Chrome rechnet `subgrid` samt leerer Liniennamen aus ("subgrid [] [] [] [] []"), ohne Subgrid zu `none`.
      assert.ok(row.every((c) => /^subgrid\b/.test(c.rows)), `${hostId}: die Kachel ist kein Subgrid mehr (grid-template-rows: ${show('rows')})`);
    }
  } finally {
    await page.close();
  }
});

test('der Container ist die Wertzeile, nicht die Kachel', async () => {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(url);
    const types = await page.evaluate(() => {
      const card = document.querySelector('#host-vitals .metric-card');
      const body = card.querySelector('.metric-card__body');
      return { card: getComputedStyle(card).containerType, body: getComputedStyle(body).containerType, name: getComputedStyle(body).containerName };
    });
    assert.deepEqual(types, { card: 'normal', body: 'inline-size', name: 'metric-tile' });
  } finally {
    await page.close();
  }
});
