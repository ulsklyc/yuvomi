/**
 * Modul: Die ausgelieferte App im Browser (Phase 1a, Abschnitt D)
 * Zweck: Alle anderen Browser-Suiten laufen gegen die Testanordnung
 *        (`npm run build:browser-tests`, jedes Modul unter seinem Quellpfad).
 *        Diese eine laeuft gegen den Build, der ausgeliefert wird
 *        (`npm run build`), und belegt, was nur dort gilt:
 *   - dist/index.html startet die App ueber den gebauten Eintrag;
 *   - Seitenwechsel laden gehashte Chunks ueber PAGE_LOADERS, nie /pages/;
 *   - das Vorwaermen trifft Adressen aus #yuvomi-page-urls;
 *   - ein Drittmodul (test/fixtures/module-facade/) importiert /api.js,
 *     /i18n.js und /utils/html.js und bekommt DIESELBE Instanz wie die App;
 *   - der Service Worker registriert sich und precacht die gehashten Chunks.
 * Ausfuehren: npm run test:built-app-browser (baut vorher `npm run build`);
 *        in test:document-guards als erstes Glied, danach baut die Kette die
 *        Testanordnung fuer die uebrigen Suiten.
 * Abhaengigkeiten: puppeteer, test/document-guards-harness.js, dist/ (Buendel)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startHarness, openPage, settle } from './document-guards-harness.js';
import { readDist } from './dist-build.js';

const FIXTURE_URL = '/__fixture__/module-facade/index.js';
const FIXTURE = readFileSync(new URL('./fixtures/module-facade/index.js', import.meta.url), 'utf8');

/** #yuvomi-page-urls aus dist/index.html - verweigert die Testanordnung (readDist). */
function pageUrls() {
  const json = readDist('index.html').match(/<script type="application\/json" id="yuvomi-page-urls">(.*?)<\/script>/)?.[1];
  assert.ok(json, 'dist/index.html hat keine Seitenliste - ist das der ausgelieferte Build?');
  return /** @type {Record<string, string>} */ (JSON.parse(json));
}

/** @param {import('puppeteer').Page} page */
const resourceNames = (page) => page.evaluate(() => performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname));

test('the shipped build starts, switches pages through its chunks and warms them up', async () => {
  const table = pageUrls();
  assert.ok(Object.keys(table).length >= 25, 'Seitenliste zu kurz');
  const harness = /** @type {any} */ (await startHarness());
  try {
    await harness.reset();
    const page = await openPage(harness, { device: 'desktop', locale: 'de' });
    const head = await page.evaluate(() => ({
      entry: document.querySelector('script[type="module"][src^="/assets/index-"]')?.getAttribute('src') ?? null,
      table: Boolean(document.getElementById('yuvomi-page-urls')),
      sourceScripts: [...document.querySelectorAll('script[type="module"]')].map((s) => s.getAttribute('src')).filter((src) => !src?.startsWith('/assets/')),
    }));
    assert.ok(head.entry, 'kein gebauter Eintrag im <head>');
    assert.ok(head.table, '#yuvomi-page-urls fehlt');
    assert.deepEqual(head.sourceScripts, [], 'Modulskripte mit Quellpfad im ausgelieferten Dokument');

    for (const [route, source] of [['/tasks', '/pages/tasks.js'], ['/calendar', '/pages/calendar.js']]) {
      await page.evaluate((/** @type {string} */ r) => window.yuvomi.navigate(r), route);
      await settle(page);
      assert.equal(await page.evaluate(() => location.pathname), route);
      const loaded = await resourceNames(page);
      assert.ok(loaded.includes(table[source]), `${route}: ${table[source]} wurde nicht geladen`);
    }
    const all = await resourceNames(page);
    assert.deepEqual(all.filter((p) => p.startsWith('/pages/') || p.startsWith('/components/') || p.startsWith('/utils/') && p !== '/utils/html.js'), [],
      'die gebaute App fragt Quellpfade an');

    // Vorwaermen: im Leerlauf (warmPrimaryRoutes) oder auf Absicht - jedes
    // modulepreload zeigt auf eine gebaute Adresse aus der Liste.
    await page.waitForFunction(() => document.querySelectorAll('link[rel="modulepreload"][fetchpriority="low"]').length > 0
      || [...document.querySelectorAll('link[rel="modulepreload"]')].length > 30, { timeout: 15000 }).catch(() => {});
    const built = new Set(Object.values(table));
    const preloads = await page.evaluate(() => [...document.querySelectorAll('link[rel="modulepreload"]')].map((l) => new URL(/** @type {HTMLLinkElement} */ (l).href).pathname));
    assert.deepEqual(preloads.filter((/** @type {string} */ href) => href.startsWith('/pages/')), [], 'ein Vorwaermen zielt auf einen Quellpfad');
    assert.ok(preloads.some((/** @type {string} */ href) => built.has(href)), `kein Vorwaermen trifft eine Adresse aus #yuvomi-page-urls (${preloads.length} Links)`);
  } finally {
    await harness.close();
  }
});

test('a third-party module gets the same /api.js, /i18n.js and /utils/html.js as the app', async () => {
  const harness = /** @type {any} */ (await startHarness());
  try {
    await harness.reset();
    const page = await openPage(harness, { device: 'desktop', locale: 'de' });
    /** @type {any} */ (page).__yuvomiRequestInterceptor = (/** @type {import('puppeteer').HTTPRequest} */ req) => {
      if (new URL(req.url()).pathname !== FIXTURE_URL) return false;
      req.respond({ status: 200, contentType: 'text/javascript; charset=utf-8', body: FIXTURE });
      return true;
    };
    const result = await page.evaluate(async (/** @type {string} */ url) => {
      const fixture = await import(url);
      const probe = fixture.probe();
      // Dieselbe Instanz wie die App: ein Eingriff ueber die Fassade erreicht
      // die Aufrufe der App selbst. Gezaehlt wird, was die App beim
      // naechsten Seitenwechsel ueber api.get anfragt.
      const original = probe.api.get;
      let seen = 0;
      probe.api.get = (/** @type {any[]} */ ...args) => { seen += 1; return original.apply(probe.api, args); };
      await window.yuvomi.navigate('/shopping');
      await new Promise((resolve) => setTimeout(resolve, 2500));
      probe.api.get = original;
      return { seen, translated: probe.translated, locale: probe.locale, lang: document.documentElement.lang, escaped: probe.escaped };
    }, FIXTURE_URL);
    assert.ok(result.seen > 0, 'die App fragt nicht ueber das api-Objekt der Fassade an - zwei Instanzen');
    assert.notEqual(result.translated, 'nav.tasks', 'i18n der Fassade hat keine Sprache geladen - eine zweite Instanz neben der App');
    assert.equal(result.locale, 'de');
    assert.equal(result.escaped, '&lt;b&gt;&amp;&lt;/b&gt;');
  } finally {
    await harness.close();
  }
});

test('the service worker registers and precaches the hashed chunks', async () => {
  const table = pageUrls();
  const harness = /** @type {any} */ (await startHarness());
  try {
    await harness.reset();
    // Ohne die Abschaltung aus openPage(): hier soll der Worker laufen.
    const page = await harness.context.newPage();
    await page.setCookie(...harness.cookies);
    harness.touched = true;
    await page.goto(`${harness.baseUrl}/`, { waitUntil: 'load' });
    const cached = await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      const until = Date.now() + 30000;
      for (;;) {
        const names = await caches.keys();
        const shell = names.find((n) => n.startsWith('yuvomi-shell-'));
        const urls = shell ? (await (await caches.open(shell)).keys()).map((r) => new URL(r.url).pathname) : [];
        if (urls.length >= 150 || Date.now() > until) return { names, urls };
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    });
    assert.ok(cached.urls.length >= 150, `nur ${cached.urls.length} Eintraege im Shell-Cache`);
    for (const source of ['/pages/dashboard.js', '/pages/calendar.js', '/pages/tasks.js']) {
      assert.ok(cached.urls.includes(table[source]), `${table[source]} (${source}) fehlt im Precache`);
    }
    assert.ok(cached.urls.some((/** @type {string} */ u) => /^\/assets\/index-[\w-]+\.js$/.test(u)), 'der gebaute Eintrag fehlt im Precache');
    assert.deepEqual(cached.urls.filter((/** @type {string} */ u) => u.startsWith('/pages/')), [], 'Quellpfade im Precache');
  } finally {
    await harness.close();
  }
});
