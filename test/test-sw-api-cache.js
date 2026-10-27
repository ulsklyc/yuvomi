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
import { createNavigateHarness, HARNESS_ROUTES } from './router-navigate-harness.js';
import { createOfflineSession } from '../public/utils/offline-session.js';

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
  async delete(req) { return this.store.delete(keyOf(req)); }
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
function loadSw({ fetchImpl, withSession = false, clock = null } = {}) {
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
    // Eine stellbare Uhr fuer Fristen von Tagen (`clock.now`); ohne sie die echte.
    URL, Date: clock ? class extends Date { static now() { return clock.now; } } : Date, Promise, JSON, Number, String, Object, Array, Math, Map, Set,
    parseInt, console, Symbol, setTimeout, clearTimeout,
  };
  sandbox.globalThis = sandbox;
  const context = createContext(sandbox);
  runInContext(SRC, context);
  // Eine angemeldete Sitzung mit gueltigem Ablauf (#2293): ohne sie legt der
  // Worker keine Liste ab und liefert keine aus.
  if (withSession) {
    const marker = new MockCache();
    marker.store.set(runInContext('SESSION_EXPIRY_KEY', context), new MockResponse(JSON.stringify({ expiresAt: Date.now() + 24 * 60 * 60 * 1000 })));
    cacheStorage.caches.set(runInContext('API_CACHE', context), marker);
  }
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
  const env = loadSw({ withSession: true,
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
  const env = loadSw({ withSession: true,
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
  const env = loadSw({ withSession: true,
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
  const env = loadSw({ withSession: true,
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
  const env = loadSw({ withSession: true,
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
  // `/auth/me` und `/preferences` selbst gehen als Abzug in den Cache (#2293,
  // eigene Tests unten), ihre Unterpfade nie.
  for (const path of ['/auth/users', '/auth/me/sessions', '/auth/2fa', '/budget', '/preferences/countries', '/documents/meta/options']) {
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
  const env = loadSw({ withSession: true,
    fetchImpl: async () => new MockResponse(JSON.stringify({ data: [{ list_id: 1, version: 3 }] }), { status: 200 }),
  });
  const versions = new MockRequest(apiUrl('/shopping/versions'), { method: 'GET' });
  const { responded } = dispatchFetch(env, versions);
  assert.equal(responded, false, 'die Abfrage im Takt darf nicht in den API-Cache');
  // Der Cache steht schon (Sitzungsablauf, #2293): gemessen wird, dass die
  // Laufnummern NICHT darin landen (unten).

  const items = new MockRequest(apiUrl('/shopping/1/items'), { method: 'GET' });
  const itemsFetch = dispatchFetch(env, items);
  assert.ok(itemsFetch.responded, 'die Artikel einer Liste bleiben offline lesbar');
  assert.equal((await itemsFetch.result).status, 200);
  const cache = await env.caches.open(await apiCacheName(env));
  assert.ok(await cache.match(items), 'die Artikel-Antwort liegt im API-Cache');
  assert.equal(await cache.match(versions), undefined, 'die Laufnummern liegen nicht daneben');
});

test('CLEAR_API_CACHE leert den API-Cache (Nutzerwechsel-Leak-Schutz)', async () => {
  const env = loadSw({ withSession: true,
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
  const env = loadSw({ withSession: true,
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

// --------------------------------------------------------
// Kaltstart ohne Verbindung (#2293): Abzuege von /auth/me und /preferences
// --------------------------------------------------------
const ME_BODY = {
  user: {
    id: 7, username: 'ana', display_name: 'Ana', avatar_color: '#123456', avatar_data: null,
    role: 'member', family_role: 'parent', access_scope: 'family',
    onboarding_version: 3, changelog_seen_version: '2.81.0', changelog_seen_latest: '2.81.0',
    email: 'ana@example.test', phone: '+49 123', birth_date: '1990-01-01', created_at: '2026-01-01',
  },
  permissions: { tasks: 'write' },
  householdSize: 3,
  initialsRoster: [{ id: 7, name: 'Ana' }],
  othersCanRead: { tasks: true },
  gravatarAvailable: true,
  gravatarHost: 'gravatar.example',
  csrfToken: 'geheimes-csrf-token',
  sessionExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
};

function meResponse(body = ME_BODY, status = 200) {
  return new MockResponse(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'csrf-token=geheimes-csrf-token', 'x-csrf-token': 'geheimes-csrf-token' },
  });
}

test('offline Kaltstart: /auth/me kommt als reduzierter Abzug, ohne CSRF, Kontaktdaten und Kopfzeilen', async () => {
  const env = loadSw({ fetchImpl: async () => meResponse() });
  const req = new MockRequest(apiUrl('/auth/me'), { method: 'GET' });

  const online = dispatchFetch(env, req);
  assert.ok(online.responded, '/auth/me muss vom Service Worker beantwortet werden');
  const fresh = await online.result;
  assert.equal((await fresh.json()).csrfToken, 'geheimes-csrf-token', 'online geht die Netzantwort unveraendert an die Seite');

  env.setFetch(async () => { throw new TypeError('Failed to fetch'); });
  const offline = await dispatchFetch(env, req).result;
  assert.equal(offline.status, 200);
  const body = await offline.json();
  assert.equal(body.offlineSnapshot, true, 'der Abzug sagt, dass die Sitzung nicht geprueft ist');
  assert.equal(body.user.id, 7);
  assert.equal(body.user.access_scope, 'family');
  assert.deepEqual(body.permissions, { tasks: 'write' });
  assert.equal(body.householdSize, 3);
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('geheimes-csrf-token'), 'kein CSRF-Token im Abzug');
  for (const field of ['email', 'phone', 'birth_date']) {
    assert.equal(field in body.user, false, `${field} gehoert nicht in den Abzug`);
  }
  assert.equal(offline.headers.get('set-cookie'), null, 'keine Cookie-Kopfzeile im Abzug');
  assert.equal(offline.headers.get('x-csrf-token'), null, 'keine CSRF-Kopfzeile im Abzug');
});

// Ein Wanddisplay bekommt seit dem Folgeauftrag zu #2342 einen eigenen,
// reduzierten Abzug (Tests unten, "Display-Kaltstart"); hier bleibt der Gast.
for (const scope of ['split_guest']) {
  test(`kein Abzug fuer ${scope}: ein vorhandener wird geloescht, offline bleibt es bei 503`, async () => {
    const env = loadSw({ fetchImpl: async () => meResponse() });
    const req = new MockRequest(apiUrl('/auth/me'), { method: 'GET' });
    await dispatchFetch(env, req).result;
    env.setFetch(async () => meResponse({ ...ME_BODY, user: { ...ME_BODY.user, access_scope: scope } }));
    await dispatchFetch(env, req).result;

    env.setFetch(async () => { throw new TypeError('Failed to fetch'); });
    const res = await dispatchFetch(env, req).result;
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'offline' });
  });
}

test('eine 401 auf /auth/me loescht den Abzug', async () => {
  const env = loadSw({ fetchImpl: async () => meResponse() });
  const req = new MockRequest(apiUrl('/auth/me'), { method: 'GET' });
  await dispatchFetch(env, req).result;
  env.setFetch(async () => meResponse({ error: 'Not authenticated' }, 401));
  const denied = await dispatchFetch(env, req).result;
  assert.equal(denied.status, 401, 'die 401 geht unveraendert an die Seite');

  env.setFetch(async () => { throw new TypeError('Failed to fetch'); });
  const res = await dispatchFetch(env, req).result;
  assert.equal(res.status, 503, 'nach der 401 gibt es keinen Abzug mehr');
});

test('/preferences kommt offline als Abzug mit Modulen, Reihenfolge und Zone', async () => {
  const prefs = {
    data: {
      disabled_modules: ['budget'], hidden_modules: [], module_order: ['shopping', 'tasks'], mobile_nav_order: ['shopping'],
      timezone: 'Europe/Berlin', date_format: 'dd.mm.yyyy', time_format: '24h',
      weather_location: 'Musterstadt',
      dashboard_widgets: [{ id: 'tasks', visible: true, filter: 'mine' }], dashboard_follows_default: false,
      dashboard_today_glance: { show: true },
    },
  };
  const env = loadSw({ withSession: true, fetchImpl: async () => new MockResponse(JSON.stringify(prefs), { status: 200 }) });
  const req = new MockRequest(apiUrl('/preferences'), { method: 'GET' });
  await dispatchFetch(env, req).result;

  env.setFetch(async () => { throw new TypeError('Failed to fetch'); });
  const body = await (await dispatchFetch(env, req).result).json();
  assert.equal(body.offlineSnapshot, true);
  assert.deepEqual(body.data.disabled_modules, ['budget']);
  assert.deepEqual(body.data.module_order, ['shopping', 'tasks']);
  assert.equal(body.data.timezone, 'Europe/Berlin');
  assert.equal('weather_location' in body.data, false, 'nur die Felder der Shell');
  // Die Uebersicht baut aus ihnen ihre Abfrage: ohne sie fragte sie offline
  // die Standardansicht an, die nie im Cache lag (Codex-Befund).
  assert.deepEqual(body.data.dashboard_widgets, [{ id: 'tasks', visible: true, filter: 'mine' }]);
  assert.equal(body.data.dashboard_follows_default, false);
  assert.deepEqual(body.data.dashboard_today_glance, { show: true });
});

test('CLEAR_API_CACHE nimmt den Sitzungsabzug mit', async () => {
  const env = loadSw({ fetchImpl: async () => meResponse() });
  const req = new MockRequest(apiUrl('/auth/me'), { method: 'GET' });
  await dispatchFetch(env, req).result;
  await dispatchMessage(env, { type: 'CLEAR_API_CACHE' });

  env.setFetch(async () => { throw new TypeError('Failed to fetch'); });
  const res = await dispatchFetch(env, req).result;
  assert.equal(res.status, 503);
});

// --------------------------------------------------------
// Abmelden ohne steuernden Service Worker (#2293)
// --------------------------------------------------------
// clearApiCache() schickte bisher NUR eine Nachricht an den steuernden Worker.
// Ohne Controller (harter Reload, Worker im Wechsel, Erstbesuch) blieb der
// API-Cache samt Sitzungsabzug liegen - am geteilten Tablett las die naechste
// Person offline den Stand der vorigen. Die Seite loescht ihn deshalb selbst.
test('clearApiCache leert den API-Cache auch ohne steuernden Service Worker', async () => {
  const storage = new MockCacheStorage();
  await storage.open('yuvomi-api-2.81.0-x');
  await storage.open('oikos-api-1.0.0');
  await storage.open('yuvomi-shell-2.81.0-x');
  const before = { caches: globalThis.caches, nav: Object.getOwnPropertyDescriptor(globalThis, 'navigator') };
  globalThis.caches = storage;
  Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: { controller: null, addEventListener() {} } }, configurable: true, writable: true });
  globalThis.window ??= { addEventListener() {} };
  globalThis.document ??= { addEventListener() {} };
  try {
    const { clearApiCache } = await import(`../public/sw-register.js?logout=${Date.now()}`);
    await clearApiCache({ timeoutMs: 50 });
    assert.deepEqual((await storage.keys()).sort(), ['yuvomi-shell-2.81.0-x'], 'nur die API-Caches gehen, die Shell bleibt');
  } finally {
    globalThis.caches = before.caches;
    if (before.nav) Object.defineProperty(globalThis, 'navigator', before.nav);
  }
});

// --------------------------------------------------------
// Der Fall des Issues (#2293), von vorne bis hinten: der echte Service Worker
// und die echte navigate() zusammen. Die App war online offen, wurde
// geschlossen und startet jetzt ohne Netz.
// --------------------------------------------------------
/** Ein Abruf der Seite: geht durch den Worker, wenn er antwortet, sonst ans Netz. */
async function pageGet(env, path, network) {
  const req = new MockRequest(apiUrl(path), { method: 'GET' });
  const { responded, result } = dispatchFetch(env, req);
  const res = responded ? await result : await network(req);
  const body = await res.json();
  if (!res.ok) throw Object.assign(new Error(body.error || 'Fehler'), { status: res.status, data: body });
  return body;
}

test('Kaltstart ohne Netz mit gefuelltem Cache zeigt die Einkaufsliste, nicht "nicht erreichbar"', async () => {
  const online = async (req) => {
    if (req.url.endsWith('/auth/me')) return meResponse();
    return new MockResponse(JSON.stringify({ data: [{ id: 1, name: 'Milch' }] }), { status: 200 });
  };
  const sw = loadSw({ fetchImpl: online });
  // Online: die Shell fragt die Sitzung, die Liste wird angesehen.
  await pageGet(sw, '/auth/me', online);
  await pageGet(sw, '/shopping', online);

  // App zu, Netz weg, App auf.
  const down = async () => { throw new TypeError('Failed to fetch'); };
  sw.setFetch(down);
  const routes = [...HARNESS_ROUTES, { path: '/shopping', requiresAuth: true, module: 'shopping' }];
  const { navigate, log, env } = createNavigateHarness({ routes, me: () => pageGet(sw, '/auth/me', down) });
  await navigate('/shopping');

  assert.deepEqual(log.unreachable, [], 'kein "Server nicht erreichbar"');
  assert.deepEqual(log.rendered, ['/shopping'], 'die Einkaufsliste wird gezeichnet');
  assert.equal(env.currentUser?.id, 7);
  assert.equal(log.offlineSessions.length, 1, 'der Router weiss, dass die Sitzung ungeprueft ist');
  assert.equal(log.reminders + log.push, 0, 'Erinnerungen und Push warten auf die gepruefte Sitzung');
  const list = await pageGet(sw, '/shopping', down);
  assert.deepEqual(list.data, [{ id: 1, name: 'Milch' }], 'die Liste kommt aus dem Cache');
});

test('Kaltstart ohne Netz und ohne Abzug bleibt beim Zustand "nicht erreichbar"', async () => {
  const down = async () => { throw new TypeError('Failed to fetch'); };
  const sw = loadSw({ fetchImpl: down });
  const routes = [...HARNESS_ROUTES, { path: '/shopping', requiresAuth: true, module: 'shopping' }];
  const { navigate, log } = createNavigateHarness({ routes, me: () => pageGet(sw, '/auth/me', down) });
  await navigate('/shopping');
  assert.equal(log.unreachable.length, 1);
  assert.deepEqual(log.rendered, []);
});

// --------------------------------------------------------
// Die ungepruefte Sitzung (utils/offline-session.js): wann sie endet
// --------------------------------------------------------
function offlineSessionWith(answers) {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const seen = { changes: [], verified: [] };
  const session = createOfflineSession({
    window: win,
    document: doc,
    verify: async () => {
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    onVerified: (result) => { seen.verified.push(result); },
    onChange: (active) => { seen.changes.push(active); },
    intervalMs: 60 * 60 * 1000,
  });
  return { session, win, doc, seen };
}

test('ungepruefte Sitzung: bleibt bei Netzfehler und erneutem Abzug, endet mit der echten Antwort', async () => {
  const { session, win, seen } = offlineSessionWith([
    new TypeError('Failed to fetch'),
    { user: { id: 7 }, offlineSnapshot: true },
    { user: { id: 7 } },
  ]);
  session.start();
  assert.deepEqual(seen.changes, [true]);
  await session.check();
  await session.check();
  assert.equal(session.isActive(), true, 'Netzfehler und Abzug lassen sie ungeprueft');
  win.dispatchEvent(new Event('online'));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(session.isActive(), false);
  assert.deepEqual(seen.verified, [{ user: { id: 7 } }]);
  assert.deepEqual(seen.changes, [true, false]);
});

test('ungepruefte Sitzung: eine 401 beendet sie ohne Freigabe', async () => {
  const { session, seen } = offlineSessionWith([Object.assign(new Error('Sitzung abgelaufen.'), { status: 401 })]);
  session.start();
  await session.check();
  assert.equal(session.isActive(), false);
  assert.deepEqual(seen.verified, [], 'die Abmeldung macht auth:expired, nicht onVerified');
});

// --------------------------------------------------------
// Der Abzug endet mit der Sitzung (#2293, Security-Befund im Review)
// --------------------------------------------------------
// Ohne Grenze zeigte ein Geraet, dessen Sitzung laengst abgelaufen oder
// widerrufen ist, offline beliebig lange die Haushaltsdaten. Die Grenze kommt
// vom Server (`sessionExpiresAt` aus `/auth/me`, der Ablauf des Session-Cookies).
test('nach dem Sitzungsablauf liefert der Worker offline weder Abzug noch Listen und raeumt den Cache', async () => {
  const online = async (req) => {
    if (req.url.endsWith('/auth/me')) return meResponse({ ...ME_BODY, sessionExpiresAt: Date.now() + 40 });
    return new MockResponse(JSON.stringify({ data: [{ id: 1, name: 'Milch' }] }), { status: 200 });
  };
  const sw = loadSw({ fetchImpl: online });
  await pageGet(sw, '/auth/me', online);
  await pageGet(sw, '/shopping', online);
  await new Promise((r) => setTimeout(r, 60));

  const down = async () => { throw new TypeError('Failed to fetch'); };
  sw.setFetch(down);
  for (const path of ['/auth/me', '/shopping']) {
    const res = await dispatchFetch(sw, new MockRequest(apiUrl(path), { method: 'GET' })).result;
    assert.equal(res.status, 503, `${path} nach Ablauf: kein gespeicherter Stand`);
  }
  assert.equal(await apiCacheName(sw), undefined, 'der abgelaufene API-Cache ist geloescht');

  const routes = [...HARNESS_ROUTES, { path: '/shopping', requiresAuth: true, module: 'shopping' }];
  const { navigate, log } = createNavigateHarness({ routes, me: () => pageGet(sw, '/auth/me', down) });
  await navigate('/shopping');
  assert.equal(log.unreachable.length, 1, 'der bestehende Hinweis statt der Liste');
  assert.deepEqual(log.rendered, []);
});

test('vor dem Sitzungsablauf bleibt der Stand lesbar', async () => {
  const sw = loadSw({ fetchImpl: async () => meResponse() });
  await pageGet(sw, '/auth/me', async () => meResponse());
  sw.setFetch(async () => { throw new TypeError('Failed to fetch'); });
  const res = await dispatchFetch(sw, new MockRequest(apiUrl('/auth/me'), { method: 'GET' })).result;
  assert.equal(res.status, 200);
});

test('ohne Ablauf vom Server legt der Worker keinen Sitzungsabzug an', async () => {
  const { sessionExpiresAt, ...withoutExpiry } = ME_BODY;
  assert.ok(sessionExpiresAt);
  const sw = loadSw({ fetchImpl: async () => meResponse(withoutExpiry) });
  await dispatchFetch(sw, new MockRequest(apiUrl('/auth/me'), { method: 'GET' })).result;
  sw.setFetch(async () => { throw new TypeError('Failed to fetch'); });
  const res = await dispatchFetch(sw, new MockRequest(apiUrl('/auth/me'), { method: 'GET' })).result;
  assert.equal(res.status, 503);
});

// --------------------------------------------------------
// Fail-closed (#2293, zweiter Security-Befund): ohne gueltigen Ablauf kein
// gespeicherter Stand - auch nicht fuer Listen von vor diesem Update.
// --------------------------------------------------------
async function putRaw(env, path, body) {
  const name = env.evaluate('API_CACHE');
  const cache = await env.caches.open(name);
  await cache.put(path.startsWith('http') ? path : apiUrl(path), new MockResponse(body, { status: 200, headers: { 'x-cached-at': '1' } }));
}

for (const [label, marker] of [
  ['ohne Marker (Bestand von vor dem Update)', null],
  ['mit unlesbarem Marker', 'kein json'],
  ['mit ungueltigem Ablauf', JSON.stringify({ expiresAt: 'morgen' })],
]) {
  test(`offline ${label}: keine Liste, der API-Cache wird geloescht`, async () => {
    const env = loadSw({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    await putRaw(env, '/shopping', JSON.stringify({ data: [{ id: 1 }] }));
    if (marker !== null) await putRaw(env, env.evaluate('SESSION_EXPIRY_KEY'), marker);
    const res = await dispatchFetch(env, new MockRequest(apiUrl('/shopping'), { method: 'GET' })).result;
    assert.equal(res.status, 503);
    assert.equal(await apiCacheName(env), undefined);
  });
}

test('meldet der Server keinen Ablauf mehr, geht der ganze API-Cache, nicht nur der Marker', async () => {
  const online = async (req) => {
    if (req.url.endsWith('/auth/me')) return meResponse();
    return new MockResponse(JSON.stringify({ data: [{ id: 1 }] }), { status: 200 });
  };
  const sw = loadSw({ fetchImpl: online });
  await pageGet(sw, '/auth/me', online);
  await pageGet(sw, '/shopping', online);
  const { sessionExpiresAt, ...withoutExpiry } = ME_BODY;
  assert.ok(sessionExpiresAt);
  sw.setFetch(async () => meResponse(withoutExpiry));
  await dispatchFetch(sw, new MockRequest(apiUrl('/auth/me'), { method: 'GET' })).result;
  assert.equal(await apiCacheName(sw), undefined);
});

test('ohne gueltigen Marker legt der Worker keine Liste ab', async () => {
  const env = loadSw({ fetchImpl: async () => new MockResponse(JSON.stringify({ data: [] }), { status: 200 }) });
  await dispatchFetch(env, new MockRequest(apiUrl('/shopping'), { method: 'GET' })).result;
  const name = await apiCacheName(env);
  const stored = name ? await (await env.caches.open(name)).match(apiUrl('/shopping')) : undefined;
  assert.equal(stored, undefined);
});

// Nach dem Anmelden fragt navigate() die Sitzung einmal ab (Codex-Befund):
// nur `/auth/me` legt den Sitzungsablauf an, und ohne ihn cacht der Worker in
// dieser ganzen Sitzung keine Liste.
test('nach dem Anmelden fragt navigate() /auth/me, bevor die Seite laedt', async () => {
  let harness = null;
  const seenBeforeRender = [];
  harness = createNavigateHarness({
    me: async () => {
      seenBeforeRender.push(harness.log.renderStarted.length === 0);
      return { user: { id: 7, access_scope: 'family' } };
    },
  });
  await harness.navigate('/tasks', { id: 7, access_scope: 'family' });
  assert.equal(harness.log.authCalls, 1, 'eine Abfrage der Sitzung nach dem Anmelden');
  assert.deepEqual(seenBeforeRender, [true], 'vor der Seite, damit ihre Listen in den Cache duerfen');
  assert.deepEqual(harness.log.rendered, ['/tasks']);
});

// Codex, zweite Runde: ohne Marker holt der Worker den Sitzungsablauf SELBST,
// statt darauf zu warten, dass die Seite `/auth/me` fragt. Sonst fehlt er nach
// einem Update (Bypass-Fenster verschluckt die Startabfrage) oder wenn
// `/preferences` beim Start vor `/auth/me` ankommt - und die ganze Sitzung
// bliebe ohne Offline-Stand.
function onlineHousehold() {
  return async (req) => {
    if (req.url.endsWith('/auth/me')) return meResponse();
    if (req.url.endsWith('/preferences')) return new MockResponse(JSON.stringify({ data: { module_order: ['shopping'] } }), { status: 200 });
    return new MockResponse(JSON.stringify({ data: [{ id: 1, name: 'Milch' }] }), { status: 200 });
  };
}

test('kommt /preferences vor /auth/me an, landet der Abzug trotzdem im Cache', async () => {
  const sw = loadSw({ fetchImpl: onlineHousehold() });
  await dispatchFetch(sw, new MockRequest(apiUrl('/preferences'), { method: 'GET' })).result;
  sw.setFetch(async () => { throw new TypeError('Failed to fetch'); });
  const res = await dispatchFetch(sw, new MockRequest(apiUrl('/preferences'), { method: 'GET' })).result;
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data.module_order, ['shopping']);
});

test('eine Liste ohne vorheriges /auth/me (nach Update oder Anmeldung) holt den Ablauf nach und bleibt offline lesbar', async () => {
  const sw = loadSw({ fetchImpl: onlineHousehold() });
  await dispatchFetch(sw, new MockRequest(apiUrl('/shopping'), { method: 'GET' })).result;
  sw.setFetch(async () => { throw new TypeError('Failed to fetch'); });
  const list = await dispatchFetch(sw, new MockRequest(apiUrl('/shopping'), { method: 'GET' })).result;
  assert.equal(list.status, 200, 'die Liste ist offline da');
  const session = await dispatchFetch(sw, new MockRequest(apiUrl('/auth/me'), { method: 'GET' })).result;
  assert.equal(session.status, 200, 'und mit ihr der Sitzungsabzug');
});

// Sicherheitsbefund (#2293): eine Antwort, die noch unter Person A unterwegs
// war, als abgemeldet wurde, darf nicht in den frischen Cache von Person B.
test('eine Antwort aus der Zeit vor CLEAR_API_CACHE landet nicht im Cache der naechsten Sitzung', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const sw = loadSw({ withSession: true, fetchImpl: () => pending });
  const inFlight = dispatchFetch(sw, new MockRequest(apiUrl('/shopping'), { method: 'GET' }));

  await dispatchMessage(sw, { type: 'CLEAR_API_CACHE' });
  // B meldet sich an: ab jetzt antwortet /auth/me mit einer anderen, gueltigen Sitzung.
  sw.setFetch(async (req) => {
    if (req.url.endsWith('/auth/me')) return meResponse({ ...ME_BODY, user: { ...ME_BODY.user, id: 8, username: 'ben' } });
    return new MockResponse(JSON.stringify({ data: [] }), { status: 200 });
  });
  release(new MockResponse(JSON.stringify({ data: [{ id: 1, name: 'Annas Liste' }] }), { status: 200 }));
  await inFlight.result;
  await Promise.all(inFlight.waited);

  const name = await apiCacheName(sw);
  const entries = name ? [...(await sw.caches.open(name)).store.keys()] : [];
  assert.deepEqual(entries, [], 'kein Eintrag im API-Cache');
});

test('auch ein Abzug aus der Zeit vor CLEAR_API_CACHE wird verworfen', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const sw = loadSw({ withSession: true, fetchImpl: () => pending });
  const inFlight = dispatchFetch(sw, new MockRequest(apiUrl('/auth/me'), { method: 'GET' }));
  await dispatchMessage(sw, { type: 'CLEAR_API_CACHE' });
  release(meResponse());
  await inFlight.result;
  assert.equal(await apiCacheName(sw), undefined);
});

// --------------------------------------------------------
// Wanddisplay: gleitende Offline-Frist (Folge von #2293)
// --------------------------------------------------------
// Ein Display hat keine Anmeldesitzung. Der Server nennt ihm deshalb als
// Ablauf jetzt + 72 Stunden - in `/auth/me` und als Kopfzeile an jeder
// Antwort -, und die Frist rueckt mit jedem Kontakt vor. Einen Sitzungsabzug
// bekommt es weiterhin nicht, nur die Listen.
const HOUR = 60 * 60 * 1000;
const DISPLAY_GRACE = 72 * HOUR;
const OFFLINE_HEADER = 'x-offline-expires-at';

function displayServer(clock) {
  return async (req) => {
    const until = String(clock.now + DISPLAY_GRACE);
    if (req.url.endsWith('/auth/me')) {
      const res = meResponse({ ...ME_BODY, user: { ...ME_BODY.user, access_scope: 'display' }, sessionExpiresAt: clock.now + DISPLAY_GRACE });
      res.headers.set(OFFLINE_HEADER, until);
      return res;
    }
    return new MockResponse(JSON.stringify({ data: [{ id: 1, title: 'Muell raus' }] }), {
      status: 200, headers: { 'Content-Type': 'application/json', [OFFLINE_HEADER]: until },
    });
  };
}

const down = async () => { throw new TypeError('Failed to fetch'); };
const get = (sw, path) => dispatchFetch(sw, new MockRequest(apiUrl(path), { method: 'GET' })).result;

test('Display: online abgerufen, offline kommen die Listen aus dem Cache', async () => {
  const clock = { now: Date.now() };
  const sw = loadSw({ clock, fetchImpl: displayServer(clock) });
  await get(sw, '/auth/me');
  await get(sw, '/tasks');

  sw.setFetch(down);
  clock.now += 71 * HOUR;
  const list = await get(sw, '/tasks');
  assert.equal(list.status, 200, 'die Aufgaben sind offline da');
  assert.deepEqual((await list.json()).data, [{ id: 1, title: 'Muell raus' }]);
  const me = await get(sw, '/auth/me');
  assert.equal(me.status, 200, 'und der reduzierte Display-Abzug fuer den Kaltstart');
  assert.equal((await me.json()).offlineSnapshot, true);
});

test('Display: nach mehr als 72 Stunden ohne Serverkontakt sind die Listen weg', async () => {
  const clock = { now: Date.now() };
  const sw = loadSw({ clock, fetchImpl: displayServer(clock) });
  await get(sw, '/auth/me');
  await get(sw, '/tasks');

  sw.setFetch(down);
  clock.now += DISPLAY_GRACE + 1;
  const list = await get(sw, '/tasks');
  assert.equal(list.status, 503);
  assert.equal(await apiCacheName(sw), undefined, 'der API-Cache ist geloescht');
});

test('Display: jeder neue Serverkontakt verlaengert die Frist, auch ohne /auth/me', async () => {
  const clock = { now: Date.now() };
  const sw = loadSw({ clock, fetchImpl: displayServer(clock) });
  await get(sw, '/auth/me');
  await get(sw, '/tasks');

  // 60 Stunden spaeter fragt die Uebersicht ihre Liste neu - nur die Liste.
  clock.now += 60 * HOUR;
  await get(sw, '/tasks');

  sw.setFetch(down);
  clock.now += 70 * HOUR; // 130 h nach /auth/me, 70 h nach dem letzten Kontakt
  const list = await get(sw, '/tasks');
  assert.equal(list.status, 200, 'die Frist laeuft ab dem letzten Kontakt');

  clock.now += 3 * HOUR; // 73 h nach dem letzten Kontakt
  assert.equal((await get(sw, '/tasks')).status, 503);
});

test('Display: eine Frist in der Vergangenheit oder ohne Zahl verlaengert nichts', async () => {
  const clock = { now: Date.now() };
  const sw = loadSw({ clock, fetchImpl: displayServer(clock) });
  await get(sw, '/auth/me');
  await get(sw, '/tasks');
  for (const bad of ['morgen', String(clock.now - 1)]) {
    sw.setFetch(async () => new MockResponse(JSON.stringify({ data: [] }), { status: 200, headers: { [OFFLINE_HEADER]: bad } }));
    await get(sw, '/tasks');
  }
  sw.setFetch(down);
  clock.now += DISPLAY_GRACE + 1;
  assert.equal((await get(sw, '/tasks')).status, 503, 'die alte Frist gilt weiter');
});

test('Display: ein gesperrtes Token (401) loescht den Cache', async () => {
  const clock = { now: Date.now() };
  const sw = loadSw({ clock, fetchImpl: displayServer(clock) });
  await get(sw, '/auth/me');
  await get(sw, '/tasks');
  sw.setFetch(down);
  assert.equal((await get(sw, '/tasks')).status, 200, 'vorher offline lesbar');

  // Online wieder: das Token ist widerrufen. Die 401 geht an die Seite, die
  // raeumt per `auth:expired` den API-Cache (public/api.js -> clearApiCache).
  sw.setFetch(async () => new MockResponse(JSON.stringify({ error: 'Not authenticated.' }), { status: 401 }));
  const denied = await get(sw, '/tasks');
  assert.equal(denied.status, 401);
  await dispatchMessage(sw, { type: 'CLEAR_API_CACHE' });

  sw.setFetch(down);
  assert.equal((await get(sw, '/tasks')).status, 503);
  assert.equal(await apiCacheName(sw), undefined);
});

test('Familiensitzung: eine Liste ohne Display-Frist laesst den Sitzungsablauf, wie er ist', async () => {
  const clock = { now: Date.now() };
  const sw = loadSw({
    clock,
    fetchImpl: async (req) => (req.url.endsWith('/auth/me')
      ? meResponse({ ...ME_BODY, sessionExpiresAt: clock.now + 24 * HOUR })
      : new MockResponse(JSON.stringify({ data: [] }), { status: 200 })),
  });
  await get(sw, '/auth/me');
  clock.now += 20 * HOUR;
  await get(sw, '/shopping');
  sw.setFetch(down);
  clock.now += 5 * HOUR;
  assert.equal((await get(sw, '/shopping')).status, 503, 'endet mit dem Sitzungsablauf');
});

test('Display: auch /preferences rueckt die Frist vor', async () => {
  const clock = { now: Date.now() };
  const sw = loadSw({ clock, fetchImpl: displayServer(clock) });
  await get(sw, '/auth/me');
  await get(sw, '/tasks');
  clock.now += 60 * HOUR;
  sw.setFetch(async () => new MockResponse(JSON.stringify({ data: { module_order: ['tasks'] } }), {
    status: 200, headers: { [OFFLINE_HEADER]: String(clock.now + DISPLAY_GRACE) },
  }));
  await get(sw, '/preferences');
  sw.setFetch(down);
  clock.now += 70 * HOUR;
  assert.equal((await get(sw, '/tasks')).status, 200);
});

// --------------------------------------------------------
// Display-Kaltstart (Folge von #2342): ein eigener, reduzierter Abzug
// --------------------------------------------------------
// Ein Tablett, das ohne Netz neu startet, zeichnete trotz gefuelltem Cache
// "Server nicht erreichbar": ohne `/auth/me` kennt der Router niemanden. Der
// Abzug traegt nur, was Shell und Router fuer ein Display lesen.
const DISPLAY_ME = {
  user: {
    id: 42, username: 'display-kueche-7f3a', display_name: 'Kueche', avatar_color: '#336699',
    avatar_data: 'data:image/png;base64,AAAA', role: 'member', family_role: null, access_scope: 'display',
    email: 'tablet@example.test', phone: '+49 555', birth_date: '1999-09-09', created_at: '2026-01-01',
    onboarding_pending: true, changelog_seen: { version: '2.80.0', latest: '2.81.0' },
    sort_order: null, is_household_member: false, sso_only: false,
  },
  permissions: { admin: false, modules: { tasks: 'read', calendar: 'read' }, widgets: { tasks: 'read' }, capabilities: {} },
  householdSize: 4,
  initialsRoster: ['Ana Beispiel', 'Ben Beispiel'],
  othersCanRead: ['tasks'],
  gravatarAvailable: true,
  gravatarHost: 'gravatar.example',
  csrfToken: 'geheimes-csrf-token',
};

function displayColdServer(clock) {
  return async (req) => {
    const until = clock.now + DISPLAY_GRACE;
    if (req.url.endsWith('/auth/me')) {
      return new MockResponse(JSON.stringify({ ...DISPLAY_ME, sessionExpiresAt: until }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'csrf-token=geheimes-csrf-token', 'x-csrf-token': 'geheimes-csrf-token', [OFFLINE_HEADER]: String(until) },
      });
    }
    return new MockResponse(JSON.stringify({ data: [{ id: 1, title: 'Muell raus' }] }), {
      status: 200, headers: { 'Content-Type': 'application/json', [OFFLINE_HEADER]: String(until) },
    });
  };
}

async function displayOnline(clock) {
  const sw = loadSw({ clock, fetchImpl: displayColdServer(clock) });
  await get(sw, '/auth/me');
  await get(sw, '/tasks');
  return sw;
}

test('Display-Abzug: nur Kennung, Name, Farbe, Rolle, Bereich, Rechte und Haushaltsgroesse', async () => {
  const clock = { now: Date.now() };
  const sw = await displayOnline(clock);
  sw.setFetch(down);
  const res = await get(sw, '/auth/me');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['expiresAt', 'householdSize', 'offlineSnapshot', 'permissions', 'user']);
  assert.deepEqual(body.user, { id: 42, display_name: 'Kueche', avatar_color: '#336699', role: 'member', access_scope: 'display' });
  assert.deepEqual(body.permissions, DISPLAY_ME.permissions);
  assert.equal(body.householdSize, 4);
  assert.equal(body.offlineSnapshot, true);
  const raw = JSON.stringify(body);
  for (const secret of ['geheimes-csrf-token', 'tablet@example.test', '+49 555', 'Ana Beispiel', 'display-kueche-7f3a', 'data:image']) {
    assert.ok(!raw.includes(secret), `${secret} gehoert nicht in den Display-Abzug`);
  }
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(res.headers.get('x-csrf-token'), null);
  assert.equal(res.headers.get(OFFLINE_HEADER), null, 'keine Kopfzeile der Netzantwort');
});

test('Display-Kaltstart ohne Netz mit gefuelltem Cache zeigt die Aufgaben, nicht "nicht erreichbar"', async () => {
  const clock = { now: Date.now() };
  const sw = await displayOnline(clock);
  sw.setFetch(down);
  clock.now += 48 * HOUR;
  const routes = [...HARNESS_ROUTES, { path: '/tasks', requiresAuth: true, module: 'tasks' }];
  const { navigate, log, env } = createNavigateHarness({ routes, me: () => pageGet(sw, '/auth/me', down) });
  await navigate('/tasks');
  assert.deepEqual(log.unreachable, [], 'kein "Server nicht erreichbar"');
  assert.deepEqual(log.rendered, ['/tasks']);
  assert.equal(env.currentUser?.access_scope, 'display');
  assert.equal(log.offlineSessions.length, 1, 'die ungepruefte Sitzung wird gehalten und spaeter geprueft');
  assert.equal(log.reminders + log.push, 0, 'Erinnerungen und Push bleiben aus');
  const list = await pageGet(sw, '/tasks', down);
  assert.deepEqual(list.data, [{ id: 1, title: 'Muell raus' }]);
});

test('Display-Kaltstart nach Ablauf der Frist: kein Abzug, der bestehende Hinweis', async () => {
  const clock = { now: Date.now() };
  const sw = await displayOnline(clock);
  sw.setFetch(down);
  clock.now += DISPLAY_GRACE + 1;
  assert.equal((await get(sw, '/auth/me')).status, 503);
  const routes = [...HARNESS_ROUTES, { path: '/tasks', requiresAuth: true, module: 'tasks' }];
  const { navigate, log } = createNavigateHarness({ routes, me: () => pageGet(sw, '/auth/me', down) });
  await navigate('/tasks');
  assert.equal(log.unreachable.length, 1);
  assert.deepEqual(log.rendered, []);
});

test('Display: eine 401 auf /auth/me loescht den Abzug', async () => {
  const clock = { now: Date.now() };
  const sw = await displayOnline(clock);
  sw.setFetch(async () => new MockResponse(JSON.stringify({ error: 'Not authenticated.' }), { status: 401 }));
  assert.equal((await get(sw, '/auth/me')).status, 401);
  sw.setFetch(down);
  assert.equal((await get(sw, '/auth/me')).status, 503);
});

test('Display: ein Abzug aus der Zeit vor CLEAR_API_CACHE wird verworfen', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const clock = { now: Date.now() };
  const sw = loadSw({ clock, withSession: true, fetchImpl: () => pending });
  const inFlight = dispatchFetch(sw, new MockRequest(apiUrl('/auth/me'), { method: 'GET' }));
  await dispatchMessage(sw, { type: 'CLEAR_API_CACHE' });
  release(await displayColdServer(clock)(new MockRequest(apiUrl('/auth/me'))));
  await inFlight.result;
  assert.equal(await apiCacheName(sw), undefined);
});
