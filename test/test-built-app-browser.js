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
 *   - der Service Worker registriert sich und precacht die gehashten Chunks,
 *     liefert gecachte Chunks ohne eigene Netzanfrage aus (#2633) und legt
 *     pdf.js in keinen Cache (#2634);
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

test('the running worker serves cached hashed chunks without the network and keeps pdf.js out of its caches', async () => {
  // #2633 und #2634 am laufenden Worker. Was der Worker selbst anfragt, sieht
  // die Seite nicht; gezaehlt wird deshalb im Worker-Ziel ueber CDP.
  const table = pageUrls();
  const harness = /** @type {any} */ (await startHarness());
  try {
    await harness.reset();
    const page = await harness.context.newPage();
    await page.setCookie(...harness.cookies);
    harness.touched = true;
    await page.goto(`${harness.baseUrl}/`, { waitUntil: 'load' });
    const swTarget = await harness.context.waitForTarget((/** @type {any} */ t) => t.type() === 'service_worker', { timeout: 30000 });
    // Precache durch und die Seite kontrolliert (sw-register.js laedt beim
    // ersten controllerchange einmal neu).
    await page.waitForFunction(async () => {
      if (!navigator.serviceWorker.controller) return false;
      const shell = (await caches.keys()).find((n) => n.startsWith('yuvomi-shell-'));
      return shell !== undefined && (await (await caches.open(shell)).keys()).length >= 150;
    }, { timeout: 30000, polling: 500 });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), { timeout: 15000 });

    const cdp = await swTarget.createCDPSession();
    /** @type {string[]} */
    const workerRequests = [];
    cdp.on('Network.requestWillBeSent', (/** @type {any} */ e) => workerRequests.push(new URL(e.request.url).pathname));
    await cdp.send('Network.enable');

    const chunks = ['/pages/budget.js', '/pages/notes.js', '/pages/contacts.js'].map((source) => table[source]);
    assert.ok(chunks.every(Boolean), 'Seitenliste ohne die erwarteten Seiten');
    const statuses = await page.evaluate(async (/** @type {string[]} */ urls) => Promise.all(urls.map(async (u) => (await fetch(u)).status)), chunks);
    assert.deepEqual(statuses, chunks.map(() => 200));
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(workerRequests.filter((p) => chunks.includes(p)), [], 'der Worker fragt fuer gecachte gehashte Chunks das Netz');

    // pdf.js erst nach dem Bypass-Fenster des Updates (30 s ab activate): darin
    // legte auch der alte Worker nichts ab, die Probe waere dort blind.
    await page.evaluate(async () => {
      const flag = await (await caches.open('yuvomi-bypass-flag')).match('/active');
      const until = Number(flag?.headers.get('x-until') || 0);
      if (until > Date.now()) await new Promise((resolve) => setTimeout(resolve, until - Date.now() + 200));
    });
    // pdf.js so, wie die Dokumente es laden: Modulimport, dazu der Worker.
    await page.evaluate(async () => {
      const pdfjsUrl = '/vendor/pdfjs/pdf.min.mjs';
      await import(pdfjsUrl);
      await fetch('/vendor/pdfjs/pdf.worker.min.mjs');
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const pdfEntries = await page.evaluate(async () => {
      const found = [];
      for (const name of await caches.keys()) {
        for (const req of await (await caches.open(name)).keys()) {
          if (new URL(req.url).pathname.startsWith('/vendor/pdfjs/')) found.push(`${name}: ${new URL(req.url).pathname}`);
        }
      }
      return found;
    });
    assert.deepEqual(pdfEntries, [], 'pdf.js liegt nach dem Laden in einem Cache des Workers');
    await cdp.detach().catch(() => {});
  } finally {
    await harness.close();
  }
});

/**
 * Oeffnet `/` (oder `start`) ohne Sitzung und wartet, bis die Adresse steht -
 * auch ueber die Weiterleitung der Probe hinweg, die den ersten Ladevorgang
 * abbricht.
 * @param {import('puppeteer').Page} page
 * @param {string} base
 * @param {string} [start]
 */
async function landing(page, base, start = '/') {
  await page.goto(`${base}${start}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
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
      // Die Hinweisseite laedt keine Sprachdatei und fordert sie auch nicht
      // vorab an (data-no-locale-preload, #2651).
      const localeHints = await page.evaluate(() => ({
        links: [...document.querySelectorAll('link[rel="preload"]')].map((el) => el.getAttribute('href')),
        fetched: performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname).filter((p) => p.startsWith('/locales/')),
      }));
      assert.deepEqual(localeHints, { links: [], fetched: [] }, `${locale}: Sprachdatei auf der Hinweisseite angefordert`);
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
    // Und oeffnet er die Hinweisseite direkt (Lesezeichen, Neuladen nach einem
    // Update), geht er von selbst zurueck in die App (#2651).
    const back = await landing(page, harness.baseUrl, '/browser-too-old.html');
    assert.notEqual(back, '/browser-too-old.html', 'ein faehiger Browser bleibt auf der Hinweisseite stehen');
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
/**
 * Stellt in einer offenen Seite den Browser ohne Popover-API nach (siehe
 * oben) und laedt `/` neu. Liefert die mitgeschnittenen Pfade.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<string[]>}
 */
async function withoutPopoverApi(page) {
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
  return requested;
}

test('without the Popover API the polyfill chunk loads and an overflow menu opens and closes; with it, nothing loads', async () => {
  const harness = /** @type {any} */ (await startHarness());
  try {
    await harness.reset();
    const page = await openPage(harness, { device: 'mobile', locale: 'de' });
    const requested = await withoutPopoverApi(page);
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

    // DAS KONTOMENUE AM DESKTOP (Review auf #2640). Es haengt in der
    // Seitenleiste, und die ist `position: fixed`, `overflow: hidden` und traegt
    // `backdrop-filter`: ohne Top-Layer wird sie zum Containing Block des
    // Panels und schneidet ab, was ueber ihre Kante ragt. Gemessen wird, dass
    // das Menue ganz im Fenster und ganz in der Leiste steht und jeder Eintrag
    // trifft - ausgeklappt und eingeklappt (dort klappt der Fokus auf dem
    // Ausloeser die Leiste auf, `:focus-within`, wie beim echten Klick).
    for (const collapsed of [false, true]) {
      const desk = await openPage(harness, { device: 'desktop', locale: 'de' });
      await desk.evaluate((/** @type {boolean} */ c) => localStorage.setItem('yuvomi.sidebar.collapsed', c ? '1' : '0'), collapsed);
      await withoutPopoverApi(desk);
      const account = await desk.evaluate(async () => {
        const panel = /** @type {any} */ (document.getElementById('nav-account-menu'));
        /** @type {HTMLElement | null} */ (document.querySelector('[popovertarget="nav-account-menu"]'))?.focus();
        panel.showPopover();
        await new Promise((resolve) => setTimeout(resolve, 600));
        const box = (/** @type {Element} */ el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
        const p = box(panel);
        const side = box(/** @type {Element} */ (document.querySelector('.nav-sidebar')));
        const items = [...panel.querySelectorAll('.popover-menu__item')].map((/** @type {Element} */ it) => {
          const r = it.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return Boolean(hit && it.contains(hit));
        });
        return {
          polyfilled: panel.classList.contains(':popover-open'),
          inViewport: p.left >= 0 && p.top >= 0 && p.right <= innerWidth && p.bottom <= innerHeight && p.right > p.left,
          inSidebar: p.left >= side.left && p.right <= side.right && p.top >= side.top && p.bottom <= side.bottom,
          items,
          collapsed: document.documentElement.classList.contains('sidebar-collapsed'),
        };
      });
      assert.equal(account.collapsed, collapsed, 'Vorbedingung: Zustand der Seitenleiste');
      assert.equal(account.polyfilled, true, 'das Kontomenue ist ueber den Polyfill offen');
      assert.ok(account.items.length >= 2, 'Reichweite: Eintraege des Kontomenues');
      assert.deepEqual({ inViewport: account.inViewport, inSidebar: account.inSidebar, items: account.items },
        { inViewport: true, inSidebar: true, items: account.items.map(() => true) },
        `Kontomenue ${collapsed ? 'eingeklappt' : 'ausgeklappt'}: ganz sichtbar, nicht von der Seitenleiste geschnitten, jeder Eintrag trifft`);
      await desk.close();
    }

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
