/**
 * Modul: Service Worker - Network-First mit Frist (Critique R18)
 * Zweck: `networkFirst()` in public/sw.js wartete auf das Netz, bis `fetch` von
 *        selbst aufgab. Ein Netz, das nicht "offline" meldet, aber nicht
 *        antwortet, liess den Start haengen, obwohl alles im Cache lag. Jetzt
 *        laeuft das Netz gegen eine Frist; danach kommt der Cache-Treffer, und
 *        die Netzantwort fuellt den Cache weiter nach.
 *        Dazu das Routing nach Dateiart: gehashte Dateien unter /assets/
 *        cache-first ohne Netzumlauf (#2633), pdf.js am Worker vorbei (#2634).
 * Ausfuehren: node --test test/test-sw-network-first.js
 *
 * sw.js laeuft wie in test-sw-api-cache.js per node:vm in einer Sandbox. DIE
 * UHR GEHOERT DEM TEST: `setTimeout` der Sandbox legt die Frist nur ab, der
 * Test laesst sie ablaufen. Ein `fetch`, das nie antwortet, laesst so keine
 * Suite haengen - und wo ein Fall trotzdem auf den Worker wartet, begrenzt
 * `within()` das Warten selbst.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { renderServiceWorker } from '../scripts/build/service-worker.ts';

// Wie der Build ihn schreibt (scripts/build/service-worker.ts): Listen vorne,
// Version und Revision eingesetzt. Die Seiten liegen gebaut unter /assets/.
const SRC = renderServiceWorker(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), {
  precache: ['/', '/index.html', '/router.js', '/api.js', '/assets/tasks-test.js', '/locales/de.json'],
  locales: readdirSync(new URL('../public/locales/', import.meta.url)).filter((f) => f.endsWith('.json')).map((f) => `/locales/${f}`),
  release: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
  revision: 'sw-network-first-test',
});
const ORIGIN = 'https://app.test';
// Die Version kommt aus dem Worker selbst: ein festes Literal hier brach die
// Suite bei jedem Versionssprung, weil die Saat dann im Cache der alten
// Version lag und der Worker im neuen suchte.
const RELEASE = SRC.match(/const APP_RELEASE\s*=\s*'([^']+)'/)[1];

class MockResponse {
  /** @param {any} body @param {{ status?: number, type?: string, contentType?: string | null }} [init] */
  constructor(body, { status = 200, type = 'basic', contentType = null } = {}) {
    this.body = body;
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this.type = type;
    this.contentType = contentType;
    this.headers = { get: (/** @type {string} */ name) => (String(name).toLowerCase() === 'content-type' ? this.contentType : null) };
  }
  clone() { return new MockResponse(this.body, { status: this.status, type: this.type, contentType: this.contentType }); }
}

class MockRequest {
  constructor(input, init = {}) {
    this.url = typeof input === 'string' ? input : input.url;
    this.method = init.method || input.method || 'GET';
    this.mode = init.mode || input.mode || 'cors';
    this.cache = init.cache || input.cache || 'default';
  }
}

const keyOf = (req) => {
  const url = typeof req === 'string' ? req : req.url;
  return url.startsWith('/') ? `${ORIGIN}${url}` : url;
};

class MockCache {
  constructor(fetchImpl) { this.store = new Map(); this.fetchImpl = fetchImpl; this.added = []; }
  async put(req, res) { this.store.set(keyOf(req), res); }
  async match(req) { return this.store.get(keyOf(req)); }
  async delete(req) { return this.store.delete(keyOf(req)); }
  // Wie im Browser: holen, und nur eine gelungene Antwort ablegen.
  async add(req) {
    this.added.push(req);
    const res = await this.fetchImpl(req);
    if (!res.ok) throw new TypeError('bad response');
    this.store.set(keyOf(req), res);
  }
  async addAll(reqs) { for (const req of reqs) await this.add(req); }
}

class MockCacheStorage {
  constructor(fetchImpl) { this.caches = new Map(); this.fetchImpl = fetchImpl; }
  async open(name) {
    if (!this.caches.has(name)) this.caches.set(name, new MockCache(this.fetchImpl));
    return this.caches.get(name);
  }
  async keys() { return [...this.caches.keys()]; }
  async delete(name) { return this.caches.delete(name); }
  async match(req) {
    for (const cache of this.caches.values()) {
      const hit = await cache.match(req);
      if (hit) return hit;
    }
    return undefined;
  }
}

/** Ein fetch, dessen Antwort der Test in der Hand haelt. */
function heldFetch() {
  const calls = [];
  const impl = (request) => new Promise((resolve, reject) => { calls.push({ request, resolve, reject }); });
  return { impl, calls };
}

function loadSw(fetchImpl) {
  const cacheStorage = new MockCacheStorage((...a) => fetchImpl(...a));
  const listeners = {};
  const timers = [];
  // Die Uhr des Workers: echte Zeit plus ein Versatz, den der Test vorstellt.
  let clockOffset = 0;
  const SandboxDate = { now: () => Date.now() + clockOffset };
  const self = {
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve(), matchAll: () => Promise.resolve([]) },
    registration: {},
    location: { origin: ORIGIN },
  };
  const sandbox = {
    self, caches: cacheStorage, fetch: (...a) => fetchImpl(...a),
    Request: MockRequest, Response: MockResponse, Headers: class {},
    URL, Date: SandboxDate, Promise, JSON, Number, String, Object, Array, Math, Map, Set, Symbol, parseInt, console,
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { if (timer) timer.cleared = true; },
  };
  sandbox.globalThis = sandbox;
  runInContext(SRC, createContext(sandbox));
  return {
    caches: cacheStorage,
    timers,
    advanceClock(ms) { clockOffset += ms; },
    /** Laesst jede noch offene Frist ablaufen. */
    expireDeadlines() { timers.splice(0).forEach((timer) => { if (!timer.cleared) timer.fn(); }); },
    async install() {
      let waited;
      listeners.install[0]({ waitUntil(p) { waited = p; } });
      await waited;
    },
    async message(data) {
      let waited = Promise.resolve();
      listeners.message[0]({ data, waitUntil(p) { waited = p; } });
      await waited;
    },
    /** Ein Worker-Update: activate setzt das Bypass-Fenster. */
    async activate() {
      let waited;
      listeners.activate[0]({ waitUntil(p) { waited = p; } });
      await waited;
    },
    fetchEvent(path, { mode = 'cors' } = {}) {
      const request = new MockRequest(`${ORIGIN}${path}`, { mode });
      const waited = [];
      let result;
      let responded = false;
      listeners.fetch[0]({ request, respondWith(p) { responded = true; result = Promise.resolve(p); }, waitUntil(p) { waited.push(p); } });
      return { request, result, waited, responded };
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Wartet hoechstens `ms` - sonst ist der Fall rot statt haengend. */
function within(promise, ms = 300) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('keine Antwort vom Worker')), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

async function seed(env, cacheName, path, body) {
  const name = (await env.caches.keys()).find((n) => n.startsWith(cacheName)) ?? `${cacheName}${RELEASE}-sw-network-first-test`;
  await (await env.caches.open(name)).put(`${ORIGIN}${path}`, new MockResponse(body));
}

const SHELL = 'yuvomi-shell-';

// Network-First mit Frist gilt fuer die UNGEHASHTEN Dateien. Die gehashten
// unter /assets/ gehen cache-first (#2633, eigene Faelle weiter unten).
for (const [label, path, cacheName, mode] of [
  ['navigation', '/', SHELL, 'navigate'],
  ['shell module', '/router.js', SHELL, 'cors'],
  ['facade', '/api.js', SHELL, 'cors'],
  ['stylesheet', '/styles/layout.css', SHELL, 'cors'],
]) {
  test(`${label}: a network that never answers gets the cached copy after the deadline`, async () => {
    const net = heldFetch();
    const env = loadSw(net.impl);
    await seed(env, cacheName, path, 'cached');

    const { result } = env.fetchEvent(path, { mode });
    await settle();
    assert.equal(net.calls.length, 1, 'das Netz wird zuerst gefragt - Network-First bleibt');
    assert.deepEqual(env.timers.map((t) => t.ms), [1500]);

    env.expireDeadlines();
    const response = await within(result);
    assert.equal(response.body, 'cached');
  });
}

test('the web app manifest comes from the network first, so a renamed app reaches installed browsers', async () => {
  // /manifest.webmanifest setzt den App-Namen aus den Einstellungen ein. Cache-first
  // bekam ein Browser, der es schon einmal geholt hatte, den alten Namen bis zum
  // naechsten Release - auch beim Neuinstallieren der PWA.
  const net = heldFetch();
  const env = loadSw(net.impl);
  await seed(env, SHELL, '/manifest.webmanifest', 'Yuvomi');

  const { result } = env.fetchEvent('/manifest.webmanifest');
  await settle();
  assert.equal(net.calls.length, 1, 'das Netz wird gefragt, nicht nur der Cache');
  net.calls[0].resolve(new MockResponse('Planer'));

  assert.equal((await within(result)).body, 'Planer');
  assert.equal((await env.caches.match(`${ORIGIN}/manifest.webmanifest`)).body, 'Planer');
});

test('a network that answers in time wins, and its answer goes into the cache', async () => {
  const net = heldFetch();
  const env = loadSw(net.impl);
  await seed(env, SHELL, '/router.js', 'cached');

  const { result } = env.fetchEvent('/router.js');
  await settle();
  net.calls[0].resolve(new MockResponse('fresh'));

  assert.equal((await within(result)).body, 'fresh');
  assert.equal(env.timers[0].cleared, true, 'die Frist wird abgeraeumt');
  assert.equal((await env.caches.match(`${ORIGIN}/router.js`)).body, 'fresh');
});

test('after the deadline the late network answer still refills the cache, kept alive by waitUntil', async () => {
  const net = heldFetch();
  const env = loadSw(net.impl);
  await seed(env, SHELL, '/router.js', 'cached');

  const { result, waited } = env.fetchEvent('/router.js');
  await settle();
  env.expireDeadlines();
  assert.equal((await within(result)).body, 'cached');
  assert.equal(waited.length, 1, 'ohne waitUntil darf der Browser den Worker vor dem Ablegen beenden');

  net.calls[0].resolve(new MockResponse('fresh'));
  await within(waited[0]);
  assert.equal((await env.caches.match(`${ORIGIN}/router.js`)).body, 'fresh', 'der naechste Abruf hat die neue Fassung');
});

test('a late network failure after the cached answer breaks nothing', async () => {
  const net = heldFetch();
  const env = loadSw(net.impl);
  await seed(env, SHELL, '/router.js', 'cached');

  const { result, waited } = env.fetchEvent('/router.js');
  await settle();
  env.expireDeadlines();
  await within(result);
  net.calls[0].reject(new TypeError('Failed to fetch'));

  await within(waited[0]);
  assert.equal((await env.caches.match(`${ORIGIN}/router.js`)).body, 'cached');
});

test('one missed deadline covers the whole start: the next cached files come at once', async () => {
  const net = heldFetch();
  const env = loadSw(net.impl);
  await seed(env, SHELL, '/router.js', 'router');
  await seed(env, SHELL, '/api.js', 'api');
  await seed(env, SHELL, '/styles/layout.css', 'layout');

  const first = env.fetchEvent('/router.js');
  await settle();
  env.expireDeadlines();
  assert.equal((await within(first.result)).body, 'router');

  // Die naechste Ebene des Modulgraphen: ohne die Regel wartete jede Ebene
  // erneut 1,5 s auf ein Netz, das eben nicht geantwortet hat.
  const second = env.fetchEvent('/api.js');
  const third = env.fetchEvent('/styles/layout.css');
  assert.equal((await within(second.result)).body, 'api');
  assert.equal((await within(third.result)).body, 'layout');
  assert.equal(env.timers.length, 0, 'keine neue Frist im Langsam-Fenster');
  assert.equal(net.calls.length, 3, 'das Netz wird trotzdem gefragt - es fuellt den Cache nach');
  assert.equal(second.waited.length, 1);

  // Was nicht im Cache liegt, wartet auch im Fenster aufs Netz.
  const uncached = env.fetchEvent('/styles/never-seen.css');
  await settle();
  let answered = false;
  uncached.result.then(() => { answered = true; });
  await settle();
  assert.equal(answered, false);
});

test('the slow window ends: afterwards the network is asked first again', async () => {
  const net = heldFetch();
  const env = loadSw(net.impl);
  await seed(env, SHELL, '/router.js', 'cached');

  const first = env.fetchEvent('/router.js');
  await settle();
  env.expireDeadlines();
  await within(first.result);

  env.advanceClock(10001);
  const later = env.fetchEvent('/router.js');
  await settle();
  assert.equal(env.timers.length, 1, 'wieder ein Rennen gegen die Frist');
  net.calls[1].resolve(new MockResponse('fresh'));
  assert.equal((await within(later.result)).body, 'fresh');
});

test('without a cached copy the deadline changes nothing: the request keeps waiting for the network', async () => {
  const net = heldFetch();
  const env = loadSw(net.impl);

  const { result } = env.fetchEvent('/i18n.js');
  await settle();
  env.expireDeadlines();
  await settle();
  let answered = false;
  result.then(() => { answered = true; });
  await settle();
  assert.equal(answered, false);

  net.calls[0].resolve(new MockResponse('fresh'));
  assert.equal((await within(result)).body, 'fresh');
});

test('a navigation to an app route gets the cached shell after the deadline, also on a route never loaded as a document', async () => {
  const net = heldFetch();
  const env = loadSw(net.impl);
  await seed(env, SHELL, '/index.html', 'shell');

  for (const path of ['/tasks', '/settings/admin/family', '/health', '/budget?tab=budget']) {
    env.advanceClock(10001); // jedes Mal ausserhalb des Langsam-Fensters: die Frist selbst zaehlt
    const { result } = env.fetchEvent(path, { mode: 'navigate' });
    await settle();
    env.expireDeadlines();
    assert.equal((await within(result)).body, 'shell', path);
  }
});

test('what is not an app route never gets the shell before the network has actually failed', async () => {
  // `/docs` ist die API-Dokumentation des Servers, keine Route der App (Codex zu #1794).
  for (const path of ['/feed/calendar/abc.ics', '/openapi.json', '/manifest.webmanifest', '/mcp', '/modules/x/page.html', '/docs', '/docs/']) {
    const net = heldFetch();
    const env = loadSw(net.impl);
    await seed(env, SHELL, '/index.html', 'shell');

    const { result } = env.fetchEvent(path, { mode: 'navigate' });
    await settle();
    env.expireDeadlines();
    await settle();
    let answered = false;
    result.then(() => { answered = true; });
    await settle();
    assert.equal(answered, false, `${path}: eine langsame Server-Route bekaeme sonst die Shell statt ihrer Antwort`);

    // Der Ausfall dagegen bekommt den Ersatz, wie bisher.
    net.calls[0].reject(new TypeError('Failed to fetch'));
    assert.equal((await within(result)).body, 'shell', path);
  }
});

test('a failing network still falls back at once, without waiting for the deadline', async () => {
  const env = loadSw(() => Promise.reject(new TypeError('Failed to fetch')));
  await seed(env, SHELL, '/api.js', 'cached');

  const { result } = env.fetchEvent('/api.js');
  assert.equal((await within(result)).body, 'cached');
});

test('the bypass window after a worker update knows no deadline: everything comes fresh', async () => {
  const net = heldFetch();
  const env = loadSw(net.impl);
  await seed(env, SHELL, '/router.js', 'cached');
  await env.activate();

  const { result } = env.fetchEvent('/router.js');
  await settle();
  assert.equal(env.timers.length, 0, 'im Bypass-Fenster laeuft nichts gegen eine Frist');
  assert.equal(net.calls[0].request.cache, 'no-cache', 'am HTTP-Cache vorbei, wie bisher');
  let answered = false;
  result.then(() => { answered = true; });
  await settle();
  assert.equal(answered, false, 'der Cache-Treffer wird nicht vorgezogen');

  net.calls[0].resolve(new MockResponse('fresh'));
  assert.equal((await within(result)).body, 'fresh');
});

test('the deadline is the documented order of magnitude', () => {
  const src = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.match(src, /const NETWORK_FIRST_DEADLINE_MS = 1500;/);
  // Die API-Strategie hat bewusst keine Frist: eine alte Liste als frische
  // auszugeben waere dort eine falsche Auskunft.
  const apiFn = src.slice(src.indexOf('async function networkFirstApi('), src.indexOf('async function cacheFirst('));
  assert.doesNotMatch(apiFn, /NETWORK_FIRST_DEADLINE_MS|setTimeout/);
});

// --------------------------------------------------------
// Sprachdateien: vorab nur die Rueckfallsprache, der Rest auf Zuruf (R18)
// --------------------------------------------------------

const LOCALES = 'yuvomi-locales-';

async function cacheNamed(env, prefix) {
  const name = (await env.caches.keys()).find((n) => n.startsWith(prefix));
  return name ? env.caches.open(name) : null;
}

test('install precaches one locale file, not all of them', async () => {
  const env = loadSw(async () => new MockResponse('file'));
  await env.install();

  const locales = await cacheNamed(env, LOCALES);
  assert.deepEqual(locales.added.map((req) => req.url), ['/locales/de.json']);
});

test('CACHE_LOCALE stores the language the page names', async () => {
  const fetched = [];
  const env = loadSw(async (req) => { fetched.push(req); return new MockResponse('fr-file'); });

  await env.message({ type: 'CACHE_LOCALE', locale: 'fr' });

  const locales = await cacheNamed(env, LOCALES);
  assert.equal((await locales.match('/locales/fr.json')).body, 'fr-file');
  assert.equal(fetched[0].cache, 'no-cache', 'revalidieren statt neu holen');
});

test('CACHE_LOCALE leaves a language alone that is already cached', async () => {
  const fetched = [];
  const env = loadSw(async (req) => { fetched.push(req); return new MockResponse('new'); });
  await seed(env, LOCALES, '/locales/fr.json', 'old');

  await env.message({ type: 'CACHE_LOCALE', locale: 'fr' });

  assert.equal(fetched.length, 0, 'der gewoehnliche Abruf haelt die Datei frisch, nicht diese Nachricht');
});

test('CACHE_LOCALE only accepts languages the app ships', async () => {
  for (const locale of ['xx', '../index', 'de/../../sw', '', undefined, 'fr.json']) {
    const fetched = [];
    const env = loadSw(async (req) => { fetched.push(req); return new MockResponse('x'); });
    await env.message({ type: 'CACHE_LOCALE', locale });
    assert.equal(fetched.length, 0, `${locale}: nichts holen, was nicht in APP_LOCALES steht`);
  }
});

test('CACHE_LOCALE while offline fails quietly', async () => {
  const env = loadSw(() => Promise.reject(new TypeError('Failed to fetch')));
  await env.message({ type: 'CACHE_LOCALE', locale: 'fr' });
  const locales = await cacheNamed(env, LOCALES);
  assert.equal(await locales.match('/locales/fr.json'), undefined);
});

test('a locale request while offline and never cached gets the offline page, not a language file', async () => {
  // Das ist der Stand, mit dem i18n.js rechnen muss: Status 200, aber HTML.
  // `resp.ok` allein beweist also keine Sprachdatei - erst das gelesene JSON.
  // Dass ein Wechsel daran scheitert, OHNE etwas umzustellen, haelt
  // test-i18n-switch.js mit genau so einer Antwort.
  const env = loadSw(() => Promise.reject(new TypeError('Failed to fetch')));
  await seed(env, SHELL, '/offline.html', 'offline-page');
  const { result } = env.fetchEvent('/locales/it.json');
  const response = await within(result);
  assert.equal(response.body, 'offline-page');
  assert.equal(response.ok, true);
});

// Guertel zum 404 des Servers (Review auf #2631): bekommt eine Datei-Anfrage
// HTML zurueck (ein alter Server, ein Proxy, der auf die Shell umleitet), darf
// das nie die gute Kopie im Cache ersetzen - der naechste Offline-Start bekaeme
// sonst index.html als Modul.
test('an HTML answer to a .js, .css or .json request never replaces the cached file', async () => {
  for (const [path, cacheName] of [['/api.js', SHELL], ['/styles/layout.css', SHELL], ['/locales/de.json', 'yuvomi-locales-']]) {
    const env = loadSw(async () => new MockResponse('<!DOCTYPE html><html></html>', { contentType: 'text/html; charset=utf-8' }));
    await seed(env, cacheName, path, 'good');
    const { result, waited } = env.fetchEvent(path);
    await result;
    await Promise.all(waited);
    await settle();
    const name = (await env.caches.keys()).find((n) => n.startsWith(cacheName));
    const cached = await (await env.caches.open(name)).match(`${ORIGIN}${path}`);
    assert.equal(cached.body, 'good', `${path}: die HTML-Antwort hat die Kopie im Cache ersetzt`);
  }
  // Eine echte Datei wird weiter abgelegt.
  const env = loadSw(async () => new MockResponse('fresh', { contentType: 'text/javascript' }));
  await seed(env, SHELL, '/api.js', 'old');
  const { result, waited } = env.fetchEvent('/api.js');
  await result;
  await Promise.all(waited);
  await settle();
  const name = (await env.caches.keys()).find((n) => n.startsWith(SHELL));
  assert.equal((await (await env.caches.open(name)).match(`${ORIGIN}/api.js`)).body, 'fresh');
});


// --------------------------------------------------------
// Gehashte Dateien unter /assets/: cache-first (#2633)
// --------------------------------------------------------

const ASSET = '/assets/tasks-test.js';

/**
 * Die Namen der Caches, die einen Eintrag unter `path` halten.
 * @param {ReturnType<typeof loadSw>} env
 * @param {string} path
 */
async function entriesFor(env, path) {
  const out = [];
  for (const name of await env.caches.keys()) {
    if (await (await env.caches.open(name)).match(`${ORIGIN}${path}`)) out.push(name);
  }
  return out;
}

test('a cached hashed asset is answered from the cache without asking the network', async () => {
  const net = heldFetch();
  const env = loadSw(net.impl);
  await seed(env, SHELL, ASSET, 'cached');

  const { result, responded } = env.fetchEvent(ASSET);
  assert.equal(responded, true);
  assert.equal((await within(result)).body, 'cached');
  await settle();
  assert.equal(net.calls.length, 0, 'ein gehashter Name aendert sich nie - kein Netzumlauf vor dem Ausliefern');
  assert.equal(env.timers.length, 0, 'keine Frist: es gibt kein Rennen');
});

test('the precache of install is where a hashed asset is found', async () => {
  // Kein zweiter Ablageort: install legt die Datei in den Shell-Cache, und
  // genau dort sucht der Abruf.
  let calls = 0;
  const env = loadSw(async () => { calls += 1; return new MockResponse('precached', { contentType: 'text/javascript' }); });
  await env.install();
  const afterInstall = calls;

  const { result } = env.fetchEvent(ASSET);
  assert.equal((await within(result)).body, 'precached');
  assert.equal(calls, afterInstall, 'der Abruf nach install fragt das Netz nicht mehr');
});

test('a hashed asset missing from the cache is fetched once and stored in the shell cache, nowhere else', async () => {
  const net = heldFetch();
  const env = loadSw(net.impl);

  const { result, waited } = env.fetchEvent(ASSET);
  await settle();
  assert.equal(net.calls.length, 1);
  net.calls[0].resolve(new MockResponse('fresh', { contentType: 'text/javascript' }));
  assert.equal((await within(result)).body, 'fresh');
  await within(Promise.all(waited));
  await settle();

  const names = await entriesFor(env, ASSET);
  assert.equal(names.length, 1, `genau ein Ablageort, gefunden: ${names.join(', ')}`);
  assert.ok(names[0].startsWith(SHELL), names[0]);

  const again = env.fetchEvent(ASSET);
  assert.equal((await within(again.result)).body, 'fresh');
  assert.equal(net.calls.length, 1, 'der zweite Abruf kommt aus dem Cache');
});

test('a failed or foreign answer for a hashed asset is never stored under its name', async () => {
  for (const [label, response] of [
    ['404 after a release', new MockResponse('not found', { status: 404, contentType: 'text/plain' })],
    ['HTML from an old server or proxy', new MockResponse('<!DOCTYPE html>', { contentType: 'text/html; charset=utf-8' })],
    ['opaque', new MockResponse('x', { type: 'opaque', status: 0 })],
  ]) {
    const env = loadSw(async () => response);
    const { result, waited } = env.fetchEvent(ASSET);
    await within(result);
    await within(Promise.all(waited));
    await settle();
    assert.deepEqual(await entriesFor(env, ASSET), [], `${label}: liegt jetzt unter dem Namen der Datei im Cache`);
  }
});

test('an uncached hashed asset while offline fails as a file, never as the shell', async () => {
  const env = loadSw(() => Promise.reject(new TypeError('Failed to fetch')));
  await seed(env, SHELL, '/index.html', 'shell');
  await seed(env, SHELL, '/offline.html', 'offline-page');

  const response = await within(env.fetchEvent(ASSET).result);
  assert.equal(response.ok, false, 'eine HTML-Seite als Modul liesse den Import mit einem MIME-Fehler scheitern');
  assert.notEqual(response.body, 'shell');
  assert.notEqual(response.body, 'offline-page');
});

test('the bypass window after an update serves a cached hashed asset from the cache too', async () => {
  // Das Fenster gibt es, weil ungehashte Dateien unter ihrem Namen wechseln.
  // Ein gehashter Name im Cache DIESER Revision ist die Datei, die der Server
  // auch liefern wuerde.
  const net = heldFetch();
  const env = loadSw(net.impl);
  await seed(env, SHELL, ASSET, 'cached');
  await env.activate();

  const { result } = env.fetchEvent(ASSET);
  assert.equal((await within(result)).body, 'cached');
  assert.equal(net.calls.length, 0);
});

test('the unhashed shell stays network-first', async () => {
  for (const [path, mode, cacheName] of [
    ['/', 'navigate', SHELL],
    ['/index.html', 'cors', SHELL],
    ['/api.js', 'cors', SHELL],
    ['/i18n.js', 'cors', SHELL],
    ['/utils/html.js', 'cors', SHELL],
    ['/manifest.json', 'cors', SHELL],
    ['/locales/de.json', 'cors', LOCALES],
  ]) {
    const net = heldFetch();
    const env = loadSw(net.impl);
    await seed(env, cacheName, path, 'cached');
    const { result } = env.fetchEvent(path, { mode });
    await settle();
    assert.equal(net.calls.length, 1, `${path}: das Netz wird zuerst gefragt`);
    net.calls[0].resolve(new MockResponse('fresh'));
    assert.equal((await within(result)).body, 'fresh', path);
  }
});

// --------------------------------------------------------
// pdf.js bleibt ganz aus den Caches (#2634, Entscheidung 10.11.2026)
// --------------------------------------------------------

const PDFJS_FILES = ['/vendor/pdfjs/pdf.min.mjs', '/vendor/pdfjs/pdf.worker.min.mjs', '/vendor/pdfjs/standard_fonts/FoxitSans.pfb'];

test('pdf.js passes the worker: no respondWith, no fetch of its own, no cache entry', async () => {
  let calls = 0;
  const env = loadSw(async () => { calls += 1; return new MockResponse('pdf', { contentType: 'text/javascript' }); });
  await settle(); // die Bypass-Initialisierung ist durch
  for (const path of PDFJS_FILES) {
    const { responded, waited } = env.fetchEvent(path);
    assert.equal(responded, false, `${path}: der Worker beantwortet es selbst - dann landet es im Cache`);
    await Promise.all(waited);
    await settle();
    assert.deepEqual(await entriesFor(env, path), [], `${path} liegt in einem Cache`);
  }
  assert.equal(calls, 0, 'der Browser holt pdf.js selbst, nicht der Worker');
});

test('pdf.js passes the worker also in the first event after start and in the bypass window', async () => {
  // Erstes Event: die Bypass-Initialisierung laeuft noch.
  const fresh = loadSw(async () => new MockResponse('pdf'));
  assert.equal(fresh.fetchEvent(PDFJS_FILES[0]).responded, false, 'vor dem Ende der Initialisierung');

  const env = loadSw(async () => new MockResponse('pdf'));
  await env.activate();
  assert.equal(env.fetchEvent(PDFJS_FILES[0]).responded, false, 'im Bypass-Fenster');
});

test('the other vendor files stay with the worker', async () => {
  const env = loadSw(async () => new MockResponse('lib', { contentType: 'text/javascript' }));
  await settle();
  for (const path of ['/vendor/sortablejs/sortable.esm.min.js', '/vendor/libphonenumber/core.min.mjs']) {
    assert.equal(env.fetchEvent(path).responded, true, path);
  }
});
