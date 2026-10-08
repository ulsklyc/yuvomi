/**
 * Modul: Service Worker - Network-First mit Frist (Critique R18)
 * Zweck: `networkFirst()` in public/sw.js wartete auf das Netz, bis `fetch` von
 *        selbst aufgab. Ein Netz, das nicht "offline" meldet, aber nicht
 *        antwortet, liess den Start haengen, obwohl alles im Cache lag. Jetzt
 *        laeuft das Netz gegen eine Frist; danach kommt der Cache-Treffer, und
 *        die Netzantwort fuellt den Cache weiter nach.
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
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { renderServiceWorkerSource } from '../server/utils/service-worker.js';

const SRC = renderServiceWorkerSource(
  readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'),
  'sw-network-first-test',
);
const ORIGIN = 'https://app.test';

class MockResponse {
  constructor(body, { status = 200, type = 'basic' } = {}) {
    this.body = body;
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this.type = type;
    this.headers = { get: () => null };
  }
  clone() { return new MockResponse(this.body, { status: this.status, type: this.type }); }
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
      listeners.fetch[0]({ request, respondWith(p) { result = Promise.resolve(p); }, waitUntil(p) { waited.push(p); } });
      return { request, result, waited };
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
  const name = (await env.caches.keys()).find((n) => n.startsWith(cacheName)) ?? `${cacheName}2.75.0-sw-network-first-test`;
  await (await env.caches.open(name)).put(`${ORIGIN}${path}`, new MockResponse(body));
}

const SHELL = 'yuvomi-shell-';
const PAGES = 'yuvomi-pages-';

for (const [label, path, cacheName, mode] of [
  ['navigation', '/', SHELL, 'navigate'],
  ['shell module', '/router.js', SHELL, 'cors'],
  ['page module', '/pages/tasks.js', PAGES, 'cors'],
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
  await seed(env, PAGES, '/pages/tasks.js', 'tasks');

  const first = env.fetchEvent('/router.js');
  await settle();
  env.expireDeadlines();
  assert.equal((await within(first.result)).body, 'router');

  // Die naechste Ebene des Modulgraphen: ohne die Regel wartete jede Ebene
  // erneut 1,5 s auf ein Netz, das eben nicht geantwortet hat.
  const second = env.fetchEvent('/api.js');
  const third = env.fetchEvent('/pages/tasks.js');
  assert.equal((await within(second.result)).body, 'api');
  assert.equal((await within(third.result)).body, 'tasks');
  assert.equal(env.timers.length, 0, 'keine neue Frist im Langsam-Fenster');
  assert.equal(net.calls.length, 3, 'das Netz wird trotzdem gefragt - es fuellt den Cache nach');
  assert.equal(second.waited.length, 1);

  // Was nicht im Cache liegt, wartet auch im Fenster aufs Netz.
  const uncached = env.fetchEvent('/pages/never-seen.js');
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

  const { result } = env.fetchEvent('/pages/tasks.js');
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
  await seed(env, PAGES, '/pages/tasks.js', 'cached');

  const { result } = env.fetchEvent('/pages/tasks.js');
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
