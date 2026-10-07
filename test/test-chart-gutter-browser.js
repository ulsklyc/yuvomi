/**
 * Modul: Jede Werteachse wird gemessen, sobald ihr Diagramm im Dokument steht (#1722) - Browser-Sonde
 * Zweck: `fitChartGutter()` rief nur der Budget-Verlauf. Die sieben Diagramme
 *        der Gesundheit und der Kilometerstand des Inventars behielten die
 *        Mindestbreite, bemessen an "5.550 €". Gemessen vor dem Fix: an der
 *        Achse des Schweregrad-Verlaufs begann "Umiarkowane" (pl, 78px) bei
 *        375px Fensterbreite 16px links vom Diagramm und 1px vor der Kante
 *        seiner Karte, bei 1280px 11px links vom Diagramm; "Katamtaman" (fil)
 *        und "Умеренная" (ru) ebenso. Seitdem misst `watchChartGutters()`
 *        (public/utils/chart.js) jedes `svg.chart`, das ins Dokument kommt.
 * Ausfuehren: npm run test:chart-gutter-browser (haengt an test:document-guards)
 *
 * WARUM IM BROWSER. Wie breit ein Wort in 12px steht, weiss nur der Browser,
 * und ob ein MutationObserver ein Diagramm in einem Blatt, in einer
 * Detailspalte und in einem geschlossenen Aufklapper erreicht, steht in keinem
 * Quelltext. Die Rechnung und den Beobachter an Attrappen haelt
 * `test:chart-gutter`; hier steht, dass die Seiten wirklich so gemessen werden.
 *
 * DIE GANZE APP im Harness der Dokument-Guards. Was eine Sonde braucht
 * (Schweregrade, einen sechsstelligen Laborwert, einen siebenstelligen
 * Kilometerstand), legt sie selbst ueber die API an.
 *
 * JEDE SONDE PRUEFT ZUERST, DASS SIE ETWAS MISST: ein Diagramm, das nicht da
 * ist, ragt nirgends hinaus, und ein kurzer Wert braucht keinen Platz.
 */

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, openPage, gotoRoute, settle } from './document-guards-harness.js';

let harness;

before(async () => {
  harness = await startHarness();
});

beforeEach(async () => {
  await harness.reset();
});

after(async () => {
  await harness?.close();
});

/** Ruft die API aus der Seite heraus, mit dem CSRF-Wert der Sitzung. */
async function api(page, method, path, body) {
  const result = await page.evaluate(async ({ method, path, body }) => {
    const raw = document.cookie.split('; ').find((c) => c.startsWith('csrf-token='));
    const res = await fetch(`/api/v1${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(raw ? raw.slice('csrf-token='.length) : '') },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* kein JSON */ }
    return { status: res.status, text: text.slice(0, 300), json };
  }, { method, path, body });
  assert.ok(result.status >= 200 && result.status < 300, `${method} ${path} -> ${result.status} ${result.text}`);
  return result.json;
}

/** Tagesschluessel relativ zu heute, im Kalender der Seite. */
const dayKey = (page, offset) => page.evaluate((offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}, offset);

/**
 * Lage der Y-Werte jedes Diagramms unter `scope` gegen die Kanten, die zaehlen:
 * die eigene Flaeche samt Polster (dort soll der Wert stehen) und der naechste
 * Vorfahr, der abschneidet.
 */
function axisGeometry(page, scope, except = null) {
  return page.evaluate((scope, except) => [...document.querySelectorAll(`${scope} svg.chart`)].filter((svg) => !except || !svg.closest(except)).map((svg) => {
    const box = svg.getBoundingClientRect();
    const host = svg.parentElement;
    let clip = host;
    while (clip && getComputedStyle(clip).overflowX === 'visible') clip = clip.parentElement;
    const labels = [...svg.querySelectorAll('.chart__axis--y')]
      .filter((label) => label.textContent !== '')
      .map((label) => {
        const rect = label.getBoundingClientRect();
        return { text: label.textContent, left: rect.left, width: rect.width };
      });
    return {
      name: svg.getAttribute('aria-label') || svg.getAttribute('class'),
      shown: box.width > 0,
      svgLeft: box.left,
      clipLeft: (clip ?? document.documentElement).getBoundingClientRect().left,
      // Die Breite, gegen die `100%` in `--chart-inset` rechnet: der Inhalt des Traegers, ohne sein Polster.
      hostWidth: host.clientWidth - parseFloat(getComputedStyle(host).paddingLeft) - parseFloat(getComputedStyle(host).paddingRight),
      paddingLeft: parseFloat(getComputedStyle(svg).paddingLeft),
      fitted: host.classList.contains('chart-host'),
      labelWidth: parseFloat(host.style.getPropertyValue('--chart-label-width')),
      labels,
    };
  }).filter((chart) => chart.labels.length), scope, except);
}

/** Der Beobachter laeuft als Mikrotask, ein Diagramm ohne Flaeche wartet auf das naechste Bild. */
async function waitFitted(page, scope) {
  try {
    await page.waitForFunction((scope) => {
      const shown = [...document.querySelectorAll(`${scope} svg.chart`)]
        .filter((svg) => svg.querySelector('.chart__axis--y') && svg.getBoundingClientRect().width > 0);
      return shown.length > 0 && shown.every((svg) => svg.parentElement.classList.contains('chart-host'));
    }, { timeout: 3000 }, scope);
  } catch {
    /* Die Zusicherung unten nennt das Diagramm, das nicht gemessen wurde. */
  }
}

/** Jeder Wert steht in der Flaeche seines Diagramms, und der Traeger kennt seine Breite. */
function assertFitted(chart, where) {
  const widest = Math.max(...chart.labels.map((label) => label.width));
  assert.ok(chart.shown, `${where}: "${chart.name}" hat keine Flaeche - die Sonde misst nichts`);
  assert.ok(widest > 0, `${where}: "${chart.name}" hat keinen Achsenwert mit Breite`);
  assert.ok(chart.fitted, `${where}: der Traeger von "${chart.name}" ist nicht gemessen (kein .chart-host) - breitester Wert ${widest.toFixed(1)}px`);
  // Die Breite eines Worts haengt um wenige Pixel am Massstab, und der aendert sich mit dem Polster.
  assert.ok(chart.labelWidth >= widest - 8 && chart.labelWidth <= widest + 9,
    `${where}: "${chart.name}" traegt --chart-label-width ${chart.labelWidth}px, der breiteste Wert misst ${widest.toFixed(1)}px`);
  for (const label of chart.labels) {
    assert.ok(label.left >= chart.svgLeft - 0.5,
      `${where}: "${label.text}" beginnt ${(chart.svgLeft - label.left).toFixed(1)}px links von seinem Diagramm "${chart.name}"`);
    assert.ok(label.left >= chart.clipLeft - 0.5,
      `${where}: "${label.text}" beginnt ${(chart.clipLeft - label.left).toFixed(1)}px links von der Kante, die ihn abschneidet`);
  }
  return widest;
}

/** Die Mindestbreite aus :root (panel.css): (64 * 600 - P * 56) / 544, nie unter 0. */
const minimumInset = (hostWidth) => Math.max(0, (64 * 600 - hostWidth * 56) / 544);

/* ── 1. Woerter an der Achse: der Schweregrad-Verlauf ────────────────────── */

async function seedCycle(page) {
  const days = [[-6, 'heavy', 3, 36.45], [-5, 'heavy', 2, 36.52], [-4, 'medium', 1, 36.61], [-3, 'light', 2, 36.38]];
  for (const [offset, flow, intensity, temp] of days) {
    await api(page, 'POST', '/health/cycle/logs', {
      log_date: await dayKey(page, offset), flow, visibility: 'family', basal_temp: temp, basal_temp_unit: 'c',
      symptoms: [{ key: 'cramps', intensity }],
    });
  }
  // Blutungslast braucht zwei abgeschlossene Perioden mit Eintraegen; der Seed traegt eine.
  for (const [index, flow] of ['heavy', 'medium', 'light'].entries()) {
    await api(page, 'POST', '/health/cycle/logs', { log_date: await dayKey(page, -34 + index), flow, visibility: 'family' });
  }
}

for (const device of ['mobile', 'desktop']) {
  test(`Zyklus (${device}, pl): ein Wort an der Werteachse steht in seinem Diagramm`, async () => {
    const page = await openPage(harness, { device, locale: 'pl' });
    await seedCycle(page);
    await gotoRoute(page, '/health/cycle');
    await page.waitForSelector('.cycle-trends svg.chart', { timeout: 15000 });
    await settle(page);

    // Der Schweregrad-Verlauf liegt in einem geschlossenen Aufklapper.
    const severity = '.cycle-symptom-row';
    assert.equal(await page.$$eval(`${severity} details:not([open]) svg.chart`, (list) => list.length), 1,
      'erwartet ist genau ein Schweregrad-Verlauf in einem geschlossenen Aufklapper');

    const summary = await page.$(`${severity} details > summary`);
    await summary.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await summary.click();
    await waitFitted(page, severity);
    const [open] = await axisGeometry(page, severity);
    assert.ok(open.labels.some((label) => label.text === 'Umiarkowane'), `die Achse traegt die polnischen Woerter nicht: ${open.labels.map((l) => l.text).join(' | ')}`);
    const widest = assertFitted(open, 'Schweregrad');
    assert.ok(widest > 64, `der breiteste Wert misst nur ${widest.toFixed(1)}px - das ist nicht der Fall, um den es geht`);
    assert.ok(open.paddingLeft > minimumInset(open.hostWidth) + 4, 'ein Wort, das breiter ist als die Mindestbreite, muss Polster bekommen');

    // Die uebrigen Zyklus-Diagramme stehen offen da. Kurze Werte lassen sie, wo sie standen.
    await waitFitted(page, '.cycle-trends > .health-chart-section');
    const others = (await axisGeometry(page, '.cycle-trends > .health-chart-section', severity)).filter((chart) => chart.shown);
    assert.ok(others.length >= 3, `erwartet sind Zykluslaenge, Blutungslast und Basaltemperatur, gefunden: ${others.map((c) => c.name).join(' | ')}`);
    for (const chart of others) {
      const width = assertFitted(chart, 'Zyklus');
      assert.ok(width < 54, `"${chart.name}": der breiteste Wert misst ${width.toFixed(1)}px - fuer diesen Fall muss er kurz sein`);
      assert.ok(Math.abs(chart.paddingLeft - minimumInset(chart.hostWidth)) <= 0.5,
        `"${chart.name}": das Polster ist ${chart.paddingLeft.toFixed(2)}px statt ${minimumInset(chart.hostWidth).toFixed(2)}px - ein kurzer Wert darf das Diagramm nicht verschieben`);
    }
    await page.close();
  });
}

/* ── 2. Zahlen an der Achse: Vitalwerte, Labor, Aktivitaet, Kilometerstand ── */

for (const device of ['mobile', 'desktop']) {
  test(`Vitalwerte, Labor, Aktivitaet und Kilometerstand (${device}): jede Achse ist gemessen`, async () => {
    const page = await openPage(harness, { device, locale: 'de' });
    for (const [offset, value] of [[-120, 248000], [-5, 312500]]) {
      await api(page, 'POST', '/health/labs', { report_date: await dayKey(page, offset), lab_name: 'q1722',
        results: [{ analyte: 'q1722 Thrombozyten', value_num: value, unit: '/µL' }] });
    }
    const car = (await api(page, 'POST', '/inventory/items', { name: 'q1722 Langlaeufer', category: 'vehicles' })).data.id;
    for (const [offset, km] of [[-300, 985000], [-10, 1250000]]) {
      await api(page, 'POST', `/inventory/items/${car}/service-log`, { label: `q1722 ${km}`, performed_on: await dayKey(page, offset), odometer: km });
    }

    // Vitalwerte: am Telefon oeffnet die Karte ein Blatt, am Desktop die Detailspalte.
    await gotoRoute(page, '/health/vitals');
    const card = await page.waitForSelector('[data-vitals-root] .metric-card--select[data-type="bp"]', { timeout: 15000 });
    await settle(page);
    await card.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await card.click();
    await waitFitted(page, 'body');
    const vitals = (await axisGeometry(page, 'body')).filter((chart) => chart.shown);
    assert.equal(vitals.length, 1, `erwartet ist ein sichtbarer Vitalwerte-Verlauf, gefunden: ${vitals.length}`);
    assertFitted(vitals[0], 'Vitalwerte');

    // Labor: ein sechsstelliger Wert.
    await gotoRoute(page, '/health/labs');
    await page.waitForSelector('#health-lab-trend-analyte', { timeout: 15000 });
    await settle(page);
    await page.select('#health-lab-trend-analyte', 'q1722 Thrombozyten');
    await page.waitForFunction(() => /\d{3}\.\d{3}/.test(document.querySelector('.health-lab-trend svg.chart .chart__axis--y')?.textContent ?? ''), { timeout: 5000 });
    await waitFitted(page, '.health-lab-trend');
    const [labs] = await axisGeometry(page, '.health-lab-trend');
    assert.ok(assertFitted(labs, 'Labor') > 40, `die Achse traegt keinen sechsstelligen Wert: ${labs.labels.map((l) => l.text).join(' | ')}`);

    // Aktivitaet.
    await gotoRoute(page, '/health/activity');
    await page.waitForSelector('.health-activity__chart svg.chart', { timeout: 15000 });
    await settle(page);
    await waitFitted(page, '.health-activity__chart');
    const [activity] = await axisGeometry(page, '.health-activity__chart');
    assertFitted(activity, 'Aktivitaet');

    // Kilometerstand: das Diagramm wird ausserhalb des Dokuments gebaut und dann eingehaengt.
    await gotoRoute(page, '/inventory');
    // Seit R17 (E3) steht jeder Gegenstand auf der Wurzel - kein Kategorie-Schritt davor.
    const row = await page.waitForSelector(`.list-row[data-id="${car}"] [data-action="open-detail"]`, { timeout: 15000 });
    await row.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await row.click();
    await page.waitForSelector('svg.chart.inventory-chart .chart__axis--y', { timeout: 15000 });
    await waitFitted(page, 'body');
    const odometer = (await axisGeometry(page, 'body')).filter((chart) => chart.shown);
    assert.equal(odometer.length, 1, `erwartet ist ein sichtbarer Kilometerstand-Verlauf, gefunden: ${odometer.length}`);
    assert.ok(odometer[0].labels.some((label) => /^\d\.\d{3}\.\d{3}$/.test(label.text)),
      `die Achse traegt keinen siebenstelligen Stand: ${odometer[0].labels.map((l) => l.text).join(' | ')}`);
    assertFitted(odometer[0], 'Kilometerstand');
    await page.close();
  });
}

/* ── 3. Ein Diagramm ohne Flaeche wartet, bis es eine hat ────────────────── */

/* Chrome misst auch in einem geschlossenen Aufklapper (dessen Inhalt ist
 * `content-visibility: hidden`, nicht `display: none`); ein Diagramm in einem
 * ausgeblendeten Bereich hat dagegen wirklich keine Breite - am Telefon etwa
 * der Vitalwerte-Verlauf der Seite, solange das Blatt ihn zeigt. Dieser Weg
 * (ResizeObserver) wird hier an einem eigens gebauten Diagramm gefahren, mit
 * dem Modul, das die Seite geladen hat. */
test('ein ausgeblendetes Diagramm wird gemessen, sobald es eine Flaeche hat', async () => {
  const page = await openPage(harness, { device: 'desktop', locale: 'de' });
  await gotoRoute(page, '/health/activity');
  await page.waitForSelector('.health-activity__chart svg.chart', { timeout: 15000 });
  await settle(page);
  const state = () => page.evaluate(() => {
    const host = document.getElementById('q1722-host');
    const label = host.querySelector('.chart__axis--y');
    return { fitted: host.classList.contains('chart-host'), value: host.style.getPropertyValue('--chart-label-width'), width: label.getBoundingClientRect().width };
  });
  await page.evaluate(() => {
    const NS = 'http://www.w3.org/2000/svg';
    const host = document.createElement('div');
    host.id = 'q1722-host';
    host.style.display = 'none';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'chart');
    svg.setAttribute('viewBox', '0 0 600 200');
    const label = document.createElementNS(NS, 'text');
    label.setAttribute('class', 'chart__axis chart__axis--y');
    label.setAttribute('x', '50');
    label.setAttribute('y', '100');
    label.setAttribute('text-anchor', 'end');
    label.textContent = 'Umiarkowane';
    svg.append(label);
    host.append(svg);
    document.getElementById('main-content').append(host);
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const hidden = await state();
  assert.equal(hidden.width, 0, 'das Diagramm hat schon eine Flaeche - die Sonde misst den Fall nicht, um den es geht');
  assert.equal(hidden.fitted, false, 'ein Diagramm ohne Flaeche kann nicht gemessen sein');

  await page.evaluate(() => { document.getElementById('q1722-host').style.display = 'block'; });
  try {
    await page.waitForFunction(() => document.getElementById('q1722-host').classList.contains('chart-host'), { timeout: 3000 });
  } catch {
    /* Die Zusicherung unten sagt es. */
  }
  const shown = await state();
  assert.ok(shown.fitted, 'das Diagramm hat jetzt eine Flaeche und ist nicht gemessen');
  assert.ok(shown.width > 60, `"Umiarkowane" misst nur ${shown.width.toFixed(1)}px`);
  assert.ok(Math.abs(parseFloat(shown.value) - shown.width) <= 9, `--chart-label-width ist ${shown.value}, der Wert misst ${shown.width.toFixed(1)}px`);
  await page.close();
});
