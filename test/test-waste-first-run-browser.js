/**
 * Modul: Waste, Leerzustand ohne Abfallart - Browser-Sonde (#1771)
 * Zweck: Ohne Abfallart steht EIN Block auf der Seite. Er sass links der Mitte:
 *        das Spaltenraster (`.page-columns`) blieb zweispurig, die Listenspalte
 *        ist im Onboarding ausgeblendet, der Block lag in der ersten Spur
 *        (612px), die zweite blieb leer. Gemessen bei 1280px: Mitte des
 *        Blocks bei x=558, Mitte der Inhaltsflaeche bei x=750.
 * Ausfuehren: npm run test:waste-first-run-browser (haengt an test:document-guards)
 *
 * Gemessen wird die Lage im gesetzten Dokument, nicht die Schreibweise der Regel:
 * die Mitte des Blocks gegen die Mitte der Inhaltsflaeche (der Bildlauf-Vorfahr ohne Bildlaufleiste).
 * Der Gegenfall: mit einer Abfallart bleiben es zwei Spuren, Liste links,
 * Seitenspalte rechts daneben.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, openPage, gotoRoute } from './document-guards-harness.js';

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
    return { status: res.status, json: await res.json().catch(() => null) };
  }, { method, path, body });
  assert.ok(result.status >= 200 && result.status < 300, `${method} ${path} -> ${result.status} ${JSON.stringify(result.json)}`);
  return result.json;
}

/** Loescht jede Abfallart, damit die Seite im Leerzustand steht (der Seed legt Arten an). */
async function clearTypes(page) {
  const { data } = await api(page, 'GET', '/waste/types');
  for (const type of data) await api(page, 'DELETE', `/waste/types/${type.id}`);
}

async function measure(page) {
  return page.evaluate(() => {
    const rect = (el) => (el ? el.getBoundingClientRect() : null);
    // Die Inhaltsflaeche ist die des Bildlauf-Vorfahren ohne seine Bildlaufleiste.
    let scroller = document.querySelector('.waste-page');
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const area = scroller && { left: scroller.getBoundingClientRect().left, right: scroller.getBoundingClientRect().left + scroller.clientWidth };
    const onboarding = rect(document.querySelector('.waste-onboarding'));
    const rail = rect(document.querySelector('.waste-page .page-columns__rail'));
    const main = document.querySelector('.waste-page .page-columns__main');
    const columns = document.querySelector('.waste-page .page-columns');
    return {
      area,
      onboarding: onboarding && { left: onboarding.left, right: onboarding.right },
      rail: rail && { left: rail.left, right: rail.right },
      mainVisible: !!main && getComputedStyle(main).display !== 'none',
      tracks: columns ? getComputedStyle(columns).gridTemplateColumns.split(' ').length : 0,
      onboardingClass: document.querySelector('.waste-page')?.classList.contains('waste-page--onboarding') ?? false,
    };
  });
}

for (const width of [1280, 1440]) {
  test(`Waste ohne Abfallart (${width}px): der Leerzustand steht in der Mitte der Inhaltsflaeche`, async () => {
    const page = await openPage(harness, { device: 'desktop' });
    await page.setViewport({ width, height: 900 });
    await gotoRoute(page, '/waste');
    await clearTypes(page);
    await gotoRoute(page, '/waste');

    const m = await measure(page);
    // Vorbedingung: gemessen wird wirklich der Leerzustand im Zweispurraster.
    assert.ok(m.onboardingClass, 'die Seite steht nicht im Onboarding');
    assert.ok(m.onboarding, 'kein .waste-onboarding auf der Seite');
    assert.equal(m.mainVisible, false, 'die Listenspalte ist im Onboarding ausgeblendet');
    assert.equal(m.tracks, 2, 'das Raster ist zweispurig - sonst misst die Sonde den Fehler nicht');

    const areaMid = (m.area.left + m.area.right) / 2;
    const blockMid = (m.onboarding.left + m.onboarding.right) / 2;
    assert.ok(Math.abs(blockMid - areaMid) <= 4,
      `Mitte des Leerzustands x=${blockMid.toFixed(1)}, Mitte der Inhaltsflaeche x=${areaMid.toFixed(1)} bei ${width}px`);
    await page.close();
  });
}

test('Waste mit einer Abfallart (1280px): zwei Spuren, die Seitenspalte steht rechts neben der Liste', async () => {
  const page = await openPage(harness, { device: 'desktop' });
  await gotoRoute(page, '/waste');
  await clearTypes(page);
  await api(page, 'POST', '/waste/types', { name: 'Restmuell', color: '#6b7280' });
  await gotoRoute(page, '/waste');

  const m = await measure(page);
  assert.equal(m.onboardingClass, false, 'mit einer Abfallart gibt es kein Onboarding');
  assert.equal(m.mainVisible, true, 'die Listenspalte ist sichtbar');
  assert.equal(m.tracks, 2, 'zwei Spuren');
  const columns = await page.evaluate(() => {
    const main = document.querySelector('.waste-page .page-columns__main').getBoundingClientRect();
    const rail = document.querySelector('.waste-page .page-columns__rail').getBoundingClientRect();
    return { mainRight: main.right, railLeft: rail.left, railWidth: rail.width };
  });
  assert.ok(columns.railLeft >= columns.mainRight, `Seitenspalte (x=${columns.railLeft}) steht nicht rechts der Liste (bis x=${columns.mainRight})`);
  assert.ok(columns.railWidth < 500, `die Seitenspalte ist ${columns.railWidth}px breit - sie ueberspannt das Raster`);
  await page.close();
});
