/**
 * Tests für die Read-only-Offline-API-Cache-Logik in public/sw.js.
 *
 * Der Service Worker ist ein klassisches Script (kein ES-Modul), daher wird er —
 * wie test-lang-init.js — via node:vm in einer Sandbox mit gemockten Browser-APIs
 * (caches, fetch, Request/Response/Headers, self) ausgeführt. Jeder Testfall lädt
 * eine frische Sandbox, damit modul-interner State (bypassCacheUntil) isoliert ist.
 *
 * Abgedeckt:
 *   - Network-First cacht GET-Whitelist (x-cached-at-Header)
 *   - offline → Cache-Fallback, sonst 503 {error:'offline'}
 *   - Mutationen (POST/…) werden nie gecacht/angefasst
 *   - Nicht-Whitelist- und /auth/*-GETs werden durchgereicht
 *   - CLEAR_API_CACHE leert den API-Cache (Nutzerwechsel-Leak-Schutz)
 *   - activate entfernt alte oikos-api-*-Caches der Vorversionen
 *   - im Bypass-Fenster (nach SW-Update) wird die API nicht gecacht
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { renderServiceWorkerSource } from '../server/utils/service-worker.js';

const TEST_BUILD_REVISION = 'sw-api-cache-test';
const SRC = renderServiceWorkerSource(
  readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'),
  TEST_BUILD_REVISION,
);
const ORIGIN = 'https://app.test';

// --------------------------------------------------------
// Mocks der Service-Worker-Browser-APIs
// --------------------------------------------------------
class MockHeaders {
  constructor(init = {}) {
    this._map = new Map();
    if (init instanceof MockHeaders) {
      for (const [k, v] of init._map) this._map.set(k, v);
    } else if (init) {
      for (const [k, v] of Object.entries(init)) this._map.set(String(k).toLowerCase(), String(v));
    }
  }
  get(k) { const v = this._map.get(String(k).toLowerCase()); return v === undefined ? null : v; }
  set(k, v) { this._map.set(String(k).toLowerCase(), String(v)); }
  toObject() { return Object.fromEntries(this._map); }
}

class MockResponse {
  constructor(body, { status = 200, statusText = 'OK', headers = {}, type = 'basic' } = {}) {
    this._body = body;
    this.status = status;
    this.statusText = statusText;
    this.ok = status >= 200 && status < 300;
    this.type = type;
    this.headers = headers instanceof MockHeaders ? headers : new MockHeaders(headers);
  }
  clone() {
    return new MockResponse(this._body, {
      status: this.status, statusText: this.statusText,
      headers: this.headers.toObject(), type: this.type,
    });
  }
  async blob() { return this._body; }
  async text() { return typeof this._body === 'string' ? this._body : JSON.stringify(this._body); }
  async json() { return typeof this._body === 'string' ? JSON.parse(this._body) : this._body; }
}

class MockRequest {
  constructor(input, init = {}) {
    if (input instanceof MockRequest) {
      this.url = input.url;
      this.method = init.method || input.method;
    } else {
      this.url = String(input);
      this.method = init.method || 'GET';
    }
  }
}

const keyOf = (req) => (typeof req === 'string' ? req : req.url);

class MockCache {
  constructor() { this.store = new Map(); }
  async put(req, res) { this.store.set(keyOf(req), res); }
  async match(req) { return this.store.get(keyOf(req)) || undefined; }
  async addAll() { /* no-op für Tests */ }
}

class MockCacheStorage {
  constructor() { this.caches = new Map(); }
  async open(name) {
    if (!this.caches.has(name)) this.caches.set(name, new MockCache());
    return this.caches.get(name);
  }
  async keys() { return [...this.caches.keys()]; }
  async delete(name) { return this.caches.delete(name); }
  async has(name) { return this.caches.has(name); }
  async match(req) {
    for (const c of this.caches.values()) {
      const r = await c.match(req);
      if (r) return r;
    }
    return undefined;
  }
}

/** Lädt sw.js in eine frische Sandbox und liefert Handles für Listener + Caches. */
function loadSw({ fetchImpl } = {}) {
  const cacheStorage = new MockCacheStorage();
  const ctl = { fetchImpl: fetchImpl || (async () => new MockResponse('{}', { status: 200 })) };
  const listeners = {};
  const self = {
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    skipWaiting() { return Promise.resolve(); },
    clients: { claim() { return Promise.resolve(); }, matchAll() { return Promise.resolve([]); } },
    registration: { showNotification() { return Promise.resolve(); } },
    location: { origin: ORIGIN },
  };
  const sandbox = {
    self, caches: cacheStorage,
    fetch: (...a) => ctl.fetchImpl(...a),
    Request: MockRequest, Response: MockResponse, Headers: MockHeaders,
    URL, Date, Promise, JSON, Number, String, Object, Array, Math, Map, Set,
    parseInt, console, Symbol, setTimeout, clearTimeout,
  };
  sandbox.globalThis = sandbox;
  const context = createContext(sandbox);
  runInContext(SRC, context);
  return {
    listeners, caches: cacheStorage,
    evaluate: (code) => runInContext(code, context),
    setFetch: (f) => { ctl.fetchImpl = f; },
  };
}

function apiUrl(path) { return `${ORIGIN}/api/v1${path}`; }

/** Feuert ein fetch-Event; liefert ob respondWith aufgerufen wurde + dessen Promise, dazu die waitUntil-Promises. */
function dispatchFetch(env, request) {
  let responded = false;
  let result;
  const waited = [];
  env.listeners.fetch[0]({ request, respondWith(p) { responded = true; result = p; }, waitUntil(p) { waited.push(p); } });
  return { responded, result: responded ? Promise.resolve(result) : null, waited };
}

async function dispatchActivate(env) {
  let waited;
  env.listeners.activate[0]({ waitUntil(p) { waited = p; } });
  await waited;
}

async function dispatchMessage(env, data) {
  let waited;
  env.listeners.message[0]({ data, waitUntil(p) { waited = p; } });
  await waited;
}

async function apiCacheName(env) {
  return (await env.caches.keys()).find((n) => n.startsWith('yuvomi-api-'));
}

// --------------------------------------------------------
// Tests
// --------------------------------------------------------

test('Network-First cacht GET-Whitelist mit x-cached-at-Header', async () => {
  const env = loadSw({
    fetchImpl: async () => new MockResponse(JSON.stringify({ data: [{ id: 1 }] }), { status: 200 }),
  });
  const req = new MockRequest(apiUrl('/calendar?from=2026-06-01&to=2026-06-30'), { method: 'GET' });

  const { responded, result } = dispatchFetch(env, req);
  assert.ok(responded, 'Whitelist-GET muss respondWith auslösen');
  const res = await result;
  assert.equal(res.status, 200);

  const name = await apiCacheName(env);
  assert.ok(name, 'API-Cache muss angelegt sein');
  const cache = await env.caches.open(name);
  const cached = await cache.match(req);
  assert.ok(cached, 'Antwort muss im API-Cache liegen');
  const stamp = cached.headers.get('x-cached-at');
  assert.ok(Number.isFinite(Number(stamp)), 'x-cached-at muss ein Zeitstempel sein');
  assert.deepEqual((await cached.json()).data, [{ id: 1 }]);
});

test('offline → Cache-Fallback liefert den letzten Stand', async () => {
  const env = loadSw({
    fetchImpl: async () => new MockResponse(JSON.stringify({ data: 'frisch' }), { status: 200 }),
  });
  const req = new MockRequest(apiUrl('/tasks'), { method: 'GET' });

  await (dispatchFetch(env, req).result); // Cache füllen

  env.setFetch(async () => { throw new TypeError('Failed to fetch'); });
  const { responded, result } = dispatchFetch(env, req);
  assert.ok(responded);
  const res = await result;
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data, 'frisch');
  assert.ok(res.headers.get('x-cached-at'), 'Fallback stammt aus dem Cache');
});

test('offline ohne Cache → 503 mit {error:"offline"}', async () => {
  const env = loadSw({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  const req = new MockRequest(apiUrl('/shopping'), { method: 'GET' });

  const { responded, result } = dispatchFetch(env, req);
  assert.ok(responded);
  const res = await result;
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'offline' });
});

// Aufgaben, Termine und Uebersicht tragen fuer ein Profilbild die Adresse
// /people/:id/avatar statt der Data-URL (server/routes/people.js). Offline
// zeigt die gecachte Zeile ihr Bild nur, wenn es im selben Cache liegt.
test('Profilbilder (/people/:id/avatar) gehen in den API-Cache und kommen offline zurueck', async () => {
  const env = loadSw({
    fetchImpl: async () => new MockResponse('BILD', { status: 200 }),
  });
  const req = new MockRequest(apiUrl('/people/2/avatar?v=4012'), { method: 'GET' });
  await (dispatchFetch(env, req).result);

  env.setFetch(async () => { throw new TypeError('Failed to fetch'); });
  const { responded, result } = dispatchFetch(env, req);
  assert.ok(responded, 'das Bild ist ein Whitelist-GET');
  const res = await result;
  assert.equal(res.status, 200, 'offline aus dem Cache');
  assert.ok(res.headers.get('x-cached-at'));
});

// Codex-Review zu #2056: ein Bild in einer Zeile, die nie auf dem Schirm war,
// laedt der Browser wegen loading="lazy" nie - offline fehlte es dann, obwohl
// die Liste aus dem Cache kam. Wer eine Liste cacht, holt die Bilder, deren
// Adresse darin steht, gleich mit (je Person einmal).
test('eine gecachte Liste holt die Profilbilder ihrer Zeilen mit in den Cache', async () => {
  const key = 'ab'.repeat(16);
  const seen = [];
  const env = loadSw({
    fetchImpl: async (req) => {
      const url = typeof req === 'string' ? req : req.url;
      seen.push(url);
      if (url.includes('/people/')) return new MockResponse('BILD', { status: 200 });
      return new MockResponse(JSON.stringify({ data: [
        { id: 1, assigned_avatar: `/api/v1/people/2/avatar?v=${key}` },
        { id: 2, assigned_users: [{ avatar_data: `/api/v1/people/2/avatar?v=${key}` }] },
      ] }), { status: 200 });
    },
  });
  const list = dispatchFetch(env, new MockRequest(apiUrl('/tasks'), { method: 'GET' }));
  await list.result;
  // Codex-Review zu #2056: das Mitholen haengt am fetch-Event (`waitUntil`).
  // Ohne das darf der Browser den Worker beenden, sobald die Liste beantwortet
  // ist, und das Bild kaeme nie im Cache an.
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(list.waited.length > 0, 'das fetch-Event bleibt bis zum Mitholen am Leben');
  await Promise.all(list.waited);
  const avatarUrl = apiUrl(`/people/2/avatar?v=${key}`);
  assert.equal(seen.filter((u) => u === avatarUrl).length, 1, 'das Bild wird genau einmal geholt, nicht je Zeile');

  env.setFetch(async () => { throw new TypeError('Failed to fetch'); });
  const { result } = dispatchFetch(env, new MockRequest(avatarUrl, { method: 'GET' }));
  const res = await result;
  assert.equal(res.status, 200, 'offline kommt das nie angezeigte Bild aus dem Cache');
});

// Codex-Review zu #2056: nur die Bildfelder zaehlen. Ein Titel oder eine
// Beschreibung, in die jemand Bildpfade tippt, loeste sonst je Treffer einen
// Abruf aus - bei jedem Laden der Liste wieder, weil ein 404 nie im Cache liegt.
test('nur Bildfelder holen ein Bild mit, eingetippter Text nie', async () => {
  const key = 'cd'.repeat(16);
  const typed = Array.from({ length: 5 }, (_, i) => `/api/v1/people/${10 + i}/avatar?v=${'e'.repeat(32)}`);
  const seen = [];
  const env = loadSw({
    fetchImpl: async (req) => {
      const url = typeof req === 'string' ? req : req.url;
      seen.push(url);
      if (url.includes('/people/')) return new MockResponse('BILD', { status: 200 });
      return new MockResponse(JSON.stringify({ data: [
        { id: 1, title: typed[0], description: typed.slice(1).join(' '), creator_avatar: `/api/v1/people/3/avatar?v=${key}` },
      ] }), { status: 200 });
    },
  });
  const list = dispatchFetch(env, new MockRequest(apiUrl('/tasks'), { method: 'GET' }));
  await list.result;
  await new Promise((r) => setTimeout(r, 0));
  await Promise.all(list.waited);
  const fetched = seen.filter((u) => u.includes('/people/'));
  assert.deepEqual(fetched, [apiUrl(`/people/3/avatar?v=${key}`)], 'nur das Bild aus creator_avatar');
});

test('der Service Worker liest dieselben Bildfelder wie der Server', async () => {
  const { AVATAR_FIELDS } = await import('../server/services/person-avatar.js');
  const env = loadSw();
  assert.deepEqual([...env.evaluate('AVATAR_FIELDS')].sort(), [...AVATAR_FIELDS].sort());
});

test('Mutationen werden nie gecacht und nicht angefasst', async () => {
  const env = loadSw();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const req = new MockRequest(apiUrl('/calendar'), { method });
    const { responded } = dispatchFetch(env, req);
    assert.equal(responded, false, `${method} muss durchgereicht werden`);
  }
  assert.equal(await apiCacheName(env), undefined, 'kein API-Cache durch Mutationen');
});

test('Nicht-Whitelist- und /auth/*-GETs werden durchgereicht', async () => {
  const env = loadSw();
  for (const path of ['/auth/me', '/auth/users', '/budget', '/preferences', '/documents/meta/options']) {
    const req = new MockRequest(apiUrl(path), { method: 'GET' });
    const { responded } = dispatchFetch(env, req);
    assert.equal(responded, false, `${path} darf nicht gecacht werden`);
  }
  assert.equal(await apiCacheName(env), undefined);
});

test('Dokumentdateien gehen nie in einen Cache des Service Workers', async () => {
  // Die Vorschaubilder der Dokumentenseite (Critique 2026-09-25) holen jede
  // lokale Datei ueber /preview. Arztbriefe und Ausweise duerfen nicht als
  // Kopie in der Cache-API landen - sie laege unverschluesselt auf dem Geraet.
  const env = loadSw({ fetchImpl: async () => new MockResponse('%PDF-1.4', { status: 200 }) });
  for (const path of ['/documents', '/documents/7', '/documents/7/preview', '/documents/7/download', '/documents/7/thumbnail']) {
    const req = new MockRequest(apiUrl(path), { method: 'GET' });
    const { responded } = dispatchFetch(env, req);
    assert.equal(responded, false, `${path} muss unangetastet ans Netz`);
  }
  assert.equal(await apiCacheName(env), undefined, 'kein API-Cache durch Dokumentdateien');
});

test('die Laufnummern-Abfrage /shopping/versions wird durchgereicht, /shopping/:id/items daneben gecacht', async () => {
  const env = loadSw({
    fetchImpl: async () => new MockResponse(JSON.stringify({ data: [{ list_id: 1, version: 3 }] }), { status: 200 }),
  });
  const versions = new MockRequest(apiUrl('/shopping/versions'), { method: 'GET' });
  const { responded } = dispatchFetch(env, versions);
  assert.equal(responded, false, 'die Abfrage im Takt darf nicht in den API-Cache');
  assert.equal(await apiCacheName(env), undefined, 'kein API-Cache durch die Laufnummern-Abfrage');

  const items = new MockRequest(apiUrl('/shopping/1/items'), { method: 'GET' });
  const itemsFetch = dispatchFetch(env, items);
  assert.ok(itemsFetch.responded, 'die Artikel einer Liste bleiben offline lesbar');
  assert.equal((await itemsFetch.result).status, 200);
  const cache = await env.caches.open(await apiCacheName(env));
  assert.ok(await cache.match(items), 'die Artikel-Antwort liegt im API-Cache');
  assert.equal(await cache.match(versions), undefined, 'die Laufnummern liegen nicht daneben');
});

test('CLEAR_API_CACHE leert den API-Cache (Nutzerwechsel-Leak-Schutz)', async () => {
  const env = loadSw({
    fetchImpl: async () => new MockResponse(JSON.stringify({ data: 'geheim' }), { status: 200 }),
  });
  const req = new MockRequest(apiUrl('/contacts'), { method: 'GET' });
  await (dispatchFetch(env, req).result);

  const name = await apiCacheName(env);
  assert.ok(name, 'Cache vor dem Leeren vorhanden');

  await dispatchMessage(env, { type: 'CLEAR_API_CACHE' });
  assert.equal(await env.caches.has(name), false, 'API-Cache muss geleert sein');
});

test('CLEAR_API_CACHE ignoriert fremde Nachrichten', async () => {
  const env = loadSw({
    fetchImpl: async () => new MockResponse(JSON.stringify({ data: 1 }), { status: 200 }),
  });
  await (dispatchFetch(env, new MockRequest(apiUrl('/dashboard'), { method: 'GET' })).result);
  const name = await apiCacheName(env);

  await dispatchMessage(env, { type: 'SOMETHING_ELSE' });
  assert.equal(await env.caches.has(name), true, 'fremde Message darf nichts löschen');
});

test('activate entfernt alte Vorversions- und Legacy-oikos-Caches, behält aktuelle Versions-Caches', async () => {
  const env = loadSw();
  // Vorzustand: alter API-Cache, ein Legacy-`oikos-*`-Cache aus der Zeit vor dem
  // Yuvomi-Rename + aktueller Shell- und API-Cache der laufenden Version.
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  await env.caches.open('yuvomi-api-0.0.1');                 // Vorversion → löschen
  await env.caches.open('oikos-shell-0.0.1');               // Legacy-Rename → löschen
  const currentRelease = `${pkg.version}-${TEST_BUILD_REVISION}`;
  await env.caches.open(`yuvomi-shell-${currentRelease}`);  // aktuell → behalten
  await env.caches.open(`yuvomi-api-${currentRelease}`);    // aktuell → behalten

  await dispatchActivate(env);

  assert.equal(await env.caches.has('yuvomi-api-0.0.1'), false, 'alter API-Cache muss weg sein');
  assert.equal(await env.caches.has('oikos-shell-0.0.1'), false, 'Legacy-oikos-Cache muss weg sein');
  assert.equal(await env.caches.has(`yuvomi-shell-${currentRelease}`), true, 'aktueller Shell-Cache bleibt');
  assert.equal(await env.caches.has(`yuvomi-api-${currentRelease}`), true, 'aktueller API-Cache bleibt');
});

test('im Bypass-Fenster (nach SW-Update) wird die API nicht gecacht', async () => {
  const env = loadSw({
    fetchImpl: async () => new MockResponse(JSON.stringify({ data: 'x' }), { status: 200 }),
  });
  await dispatchActivate(env); // setzt bypassCacheUntil = jetzt + 30s

  const req = new MockRequest(apiUrl('/calendar?from=a&to=b'), { method: 'GET' });
  const { responded, result } = dispatchFetch(env, req);
  assert.ok(responded, 'Whitelist-GET wird beantwortet (frisch ans Netz)');
  await result;

  const name = await apiCacheName(env);
  const cache = name ? await env.caches.open(name) : null;
  const cached = cache ? await cache.match(req) : undefined;
  assert.equal(cached, undefined, 'im Bypass-Fenster darf nichts gecacht werden');
});
