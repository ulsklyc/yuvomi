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
 *   - der Service Worker registriert sich und precacht die gehashten Chunks;
 *   - die Browser-Untergrenze (Phase 1a E): ohne `CSSLayerBlockRule` schickt
 *     browser-floor.js auf /browser-too-old.html, die Seite zeigt den Text der
 *     Seitensprache, axe meldet dort nichts, und ein Lauf ohne Eingriff bleibt
 *     in der App.
 * Ausfuehren: npm run test:built-app-browser (baut vorher `npm run build`);
 *        in test:document-guards als erstes Glied, danach baut die Kette die
 *        Testanordnung fuer die uebrigen Suiten.
 * Abhaengigkeiten: puppeteer, test/document-guards-harness.js, dist/ (Buendel)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { startHarness, openPage, openAnonPage, settle, gotoRoute } from './document-guards-harness.js';
import { readDist } from './dist-build.js';

const FIXTURE_URL = '/__fixture__/module-facade/index.js';
const FIXTURE = readFileSync(new URL('./fixtures/module-facade/index.js', import.meta.url), 'utf8');
// Als Quelltext ueber CDP, nicht per `addScriptTag`: die CSP laesst kein
// eingefuegtes Inline-Skript zu, `Runtime.evaluate` unterliegt ihr nicht.
const AXE_SOURCE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
/** @type {Record<string, any>} */
const LOCALES = {
  de: JSON.parse(readFileSync(new URL('../public/locales/de.json', import.meta.url), 'utf8')),
  en: JSON.parse(readFileSync(new URL('../public/locales/en.json', import.meta.url), 'utf8')),
};

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

/**
 * Oeffnet `/` ohne Sitzung und wartet, bis die Adresse steht - auch ueber die
 * Weiterleitung der Probe hinweg, die den ersten Ladevorgang abbricht.
 * @param {import('puppeteer').Page} page
 * @param {string} base
 */
async function landing(page, base) {
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  // Fertig ist die Adresse, die 1,5 s lang steht (die App selbst leitet
  // anonym noch auf /login weiter).
  const until = Date.now() + 15000;
  let last = '';
  let stableSince = Date.now();
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const path = new URL(page.url()).pathname;
    if (path !== last) { last = path; stableSince = Date.now(); } else if (Date.now() - stableSince > 1500) break;
  }
  await page.waitForSelector('body', { timeout: 15000 });
  return new URL(page.url()).pathname;
}

test('a browser below the floor lands on /browser-too-old.html in its language, and the page passes axe', async () => {
  const harness = /** @type {any} */ (await startHarness());
  try {
    for (const [locale, shown] of [['de', 'de'], ['en', 'en'], ['fr', 'en']]) {
      const page = await openAnonPage(harness, { device: 'mobile', locale });
      // Wie ein Browser vor Chrome 99 / Firefox 97 / Safari 15.4.
      await page.evaluateOnNewDocument(() => { delete (/** @type {any} */ (window)).CSSLayerBlockRule; });
      const path = await landing(page, harness.baseUrl);
      assert.equal(path, '/browser-too-old.html', `${locale}: die Probe hat nicht weitergeleitet`);
      const visible = await page.evaluate(() => [...document.querySelectorAll('.copy')]
        .filter((el) => getComputedStyle(el).display !== 'none')
        .map((el) => ({ lang: el.getAttribute('lang'), title: el.querySelector('h1')?.textContent?.trim() })));
      assert.deepEqual(visible, [{ lang: shown, title: LOCALES[shown].browserTooOld.title }], `${locale}: sichtbar ist genau der Block der Seitensprache`);
      assert.equal(await page.title(), `${LOCALES[shown].browserTooOld.pageTitle} - Yuvomi`, `${locale}: <title> in der Seitensprache`);
      if (locale === 'de') {
        await page.evaluate(AXE_SOURCE);
        const violations = await page.evaluate(async () => {
          const result = await /** @type {any} */ (window).axe.run(document);
          return result.violations.map((/** @type {any} */ v) => `${v.id} (${v.impact}): ${v.nodes.map((/** @type {any} */ n) => n.target.join(' ')).join(', ')}`);
        });
        assert.deepEqual(violations, [], 'axe auf der Hinweisseite');
      }
      await page.close();
    }

    // Gegenlauf ohne Eingriff: der Browser bleibt in der App.
    const page = await openAnonPage(harness, { device: 'mobile', locale: 'de' });
    const path = await landing(page, harness.baseUrl);
    assert.notEqual(path, '/browser-too-old.html', 'ein Browser ueber der Untergrenze landet auf der Hinweisseite');
    assert.equal(await page.evaluate(() => typeof CSSLayerBlockRule), 'function', 'Vorbedingung: der Testbrowser kennt CSSLayerBlockRule');
    await page.close();
  } finally {
    await harness.close();
  }
});

/**
 * Der Polyfill-Chunk unter den Anfragen einer Seite.
 * @param {string[]} paths
 */
const polyfillRequests = (paths) => paths.filter((p) => /^\/assets\/popover-fn-[\w-]+\.js$/.test(p));

/**
 * EIN BROWSER OHNE POPOVER-API, SO NAH WIE ES IN CHROME GEHT. Ein aelteres
 * Chrome laesst sich hier nicht starten, und `--disable-blink-features=
 * HTMLPopoverAttribute` wirkt nicht mehr (gemessen an Chrome 156). Deshalb
 * zwei Eingriffe, die zusammen den alten Browser nachstellen:
 *   - JS: `popover` und die drei Methoden fehlen am Prototyp - so fragt die
 *     Probe in utils/popover-support.js, und so findet der Polyfill sie vor;
 *   - CSS: jedes `:popover-open` (nicht das escapte `.\:popover-open`) wird in
 *     den ausgelieferten Blaettern zu einer unbekannten Pseudoklasse. Damit
 *     faellt jede Regel damit weg wie im alten Browser, und
 *     `@supports not selector(...)` in reset.css greift.
 * Geoeffnet wird ueber `showPopover()` am Panel, wie showPopoverMenuAt() in
 * utils/popover-menu.js es tut: ein Klick auf den `popovertarget`-Knopf liefe
 * in diesem Chrome zusaetzlich durch die native Aktivierung und belegte nichts.
 */
test('without the Popover API the polyfill chunk loads and an overflow menu opens and closes; with it, nothing loads', async () => {
  const harness = /** @type {any} */ (await startHarness());
  try {
    await harness.reset();
    const page = await openPage(harness, { device: 'mobile', locale: 'de' });
    /** @type {string[]} */
    const requested = [];
    page.on('request', (/** @type {import('puppeteer').HTTPRequest} */ req) => requested.push(new URL(req.url()).pathname));
    /** @type {any} */ (page).__yuvomiRequestInterceptor = (/** @type {import('puppeteer').HTTPRequest} */ req) => {
      if (!new URL(req.url()).pathname.endsWith('.css')) return false;
      fetch(req.url())
        .then((res) => res.text())
        .then((css) => req.respond({
          status: 200,
          contentType: 'text/css; charset=utf-8',
          body: css.replace(/(?<!\\):popover-open/g, ':x-no-popover-open'),
        }))
        .catch(() => req.continue());
      return true;
    };
    await page.evaluateOnNewDocument(() => {
      const proto = /** @type {any} */ (HTMLElement.prototype);
      for (const name of ['popover', 'showPopover', 'hidePopover', 'togglePopover']) delete proto[name];
    });
    await gotoRoute(page, '/');
    assert.equal(polyfillRequests(requested).length, 1, 'ohne Popover-API laedt der Router den Polyfill-Chunk');
    assert.equal(await page.evaluate(() => CSS.supports('selector(:x-no-popover-open)')), false, 'Vorbedingung: die Ersatz-Pseudoklasse ist unbekannt');

    /** Zustand des Anpassen-Menues der Uebersicht (mobil ein Ueberlaufmenue). */
    const menuState = () => page.evaluate(() => {
      const panel = /** @type {HTMLElement | null} */ (document.getElementById('dashboard-tools-menu'));
      if (!panel) return null;
      const rect = panel.getBoundingClientRect();
      const style = getComputedStyle(panel);
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        polyfilled: !/native code/.test(String(/** @type {any} */ (panel).showPopover)),
        open: panel.classList.contains(':popover-open'),
        display: style.display,
        opacity: style.opacity,
        onTop: Boolean(hit && panel.contains(hit)),
        size: rect.width > 0 && rect.height > 0,
      };
    });
    // Die Deckkraft zaehlt geschlossen nicht: `.popover-menu:not(:popover-open)`
    // faellt im alten Browser weg, `display: none` aus reset.css traegt allein.
    const closed = await menuState();
    assert.deepEqual(closed && { ...closed, opacity: undefined }, { polyfilled: true, open: false, display: 'none', opacity: undefined, onTop: false, size: false },
      'geschlossen ist das Menue weg (reset.css), und showPopover() ist die Fassung des Polyfills');

    await page.evaluate(() => /** @type {any} */ (document.getElementById('dashboard-tools-menu')).showPopover());
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(await menuState(), { polyfilled: true, open: true, display: 'flex', opacity: '1', onTop: true, size: true },
      'offen steht das Menue sichtbar ueber der Seite (Zwilling in reset.css, z-index statt Top-Layer)');

    await page.keyboard.press('Escape');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal((await menuState())?.open, false, 'Esc schliesst');

    await page.evaluate(() => /** @type {any} */ (document.getElementById('dashboard-tools-menu')).showPopover());
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal((await menuState())?.open, true);
    await page.mouse.click(8, 700);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal((await menuState())?.open, false, 'ein Klick daneben schliesst');
    await page.close();

    // Gegenlauf mit der API: der Chunk wird nie angefragt.
    const plain = await openPage(harness, { device: 'mobile', locale: 'de' });
    /** @type {string[]} */
    const plainRequests = [];
    plain.on('request', (/** @type {import('puppeteer').HTTPRequest} */ req) => plainRequests.push(new URL(req.url()).pathname));
    await gotoRoute(plain, '/');
    assert.ok(plainRequests.some((p) => /^\/assets\/index-[\w-]+\.js$/.test(p)), 'Reichweite: der Start wurde mitgeschnitten');
    assert.deepEqual(polyfillRequests(plainRequests), [], 'ein Browser mit Popover-API laedt den Polyfill nicht');
    await plain.close();
  } finally {
    await harness.close();
  }
});
