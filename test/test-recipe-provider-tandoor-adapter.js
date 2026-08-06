/**
 * Modul: Recipe-Provider-Adapter-Test (Tandoor)
 * Zweck: Validiert TandoorAdapter (testConnection/listRecipeSummaries/getRecipe/
 *        recipeUrl/fetchThumbnail) gegen einen echten lokalen HTTP-Server -
 *        keine echte Netzwerkverbindung nach außen. Seit der SSRF-Härtung läuft
 *        der Adapter über server/utils/http.js#safeRequest statt globalem
 *        fetch(), deshalb wird hier gegen einen echten Server getestet - gleiche
 *        Konvention wie test-ics-subscription.js#fetchAndParse und
 *        test-recipe-provider-adapter.js (Mealie, erster Provider desselben
 *        Musters). Deckt zusätzlich zwei sicherheitsrelevante Verhalten ab, die
 *        über ein reines fetch()-Mock nicht sinnvoll testbar wären: Origin-Pinning
 *        des Thumbnail-Bildpfads (kein Bearer-Token an einen abweichenden Host)
 *        und host-agnostisches Parsing des DRF-`next`-Links (Reverse-Proxy).
 * Ausführen: node --test test/test-recipe-provider-tandoor-adapter.js
 */
import assert from 'node:assert/strict';
import test, { before, after, beforeEach } from 'node:test';
import http from 'node:http';
import { TandoorAdapter } from '../server/services/recipe-providers/tandoor.js';

const ENV_FLAG = 'RECIPE_PROVIDER_ALLOW_PRIVATE_NETWORK';

let calls;
let handler;
let server;
let base;
let account;

before(async () => {
  // Ohne das Opt-in würde safeRequest()s Anti-Rebinding-Lookup jede Anfrage an
  // 127.0.0.1 (dieser Testserver) als privates Netzwerkziel blocken. Die
  // Guard-Logik selbst ist in test-ssrf.js/test-http.js abgedeckt.
  process.env[ENV_FLAG] = 'true';
  server = http.createServer((req, res) => {
    calls.push({ url: `${base}${req.url}`, opts: { headers: { Authorization: req.headers.authorization } } });
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  account = { base_url: base, api_token: 'tok123' };
});

after(async () => {
  delete process.env[ENV_FLAG];
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  calls = [];
  handler = (_req, res) => { res.writeHead(500); res.end(); };
});

function mockHandler(fn) {
  handler = fn;
}

function sendJson(res, body, status = 200) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
  res.end(buf);
}

function sendBinary(res, buffer, mime, status = 200) {
  res.writeHead(status, { 'Content-Type': mime, 'Content-Length': buffer.length });
  res.end(buffer);
}

// Für den Netzwerkfehler-Test: ein Port, an dem garantiert niemand lauscht
// (Server kurz geöffnet, sofort wieder geschlossen) → ECONNREFUSED über eine
// echte Verbindung, statt globalThis.fetch zu werfen.
async function deadBaseUrl() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return `http://127.0.0.1:${port}`;
}

test('Konstruktor entfernt trailing slash von base_url', () => {
  const adapter = new TandoorAdapter({ ...account, base_url: `${base}/` });
  assert.equal(adapter.base, base);
});

// --------------------------------------------------------------------------
// Bearer-Auth: jeder Request trägt denselben Header
// --------------------------------------------------------------------------

test('Bearer-Authorization-Header wird bei jedem Request gesetzt', async () => {
  mockHandler((req, res) => sendJson(res, { results: [], next: null }));
  const adapter = new TandoorAdapter(account);
  await adapter.listRecipeSummaries();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok123');
});

// --------------------------------------------------------------------------
// testConnection: /api/recipe/?page_size=1
// --------------------------------------------------------------------------

test('testConnection: ok=true bei 200 auf /api/recipe/?page_size=1', async () => {
  mockHandler((req, res) => sendJson(res, { count: 0, results: [] }));
  const adapter = new TandoorAdapter(account);
  const out = await adapter.testConnection();
  assert.equal(calls[0].url, `${base}/api/recipe/?page_size=1`);
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok123');
  assert.equal(out.ok, true);
  assert.equal(out.status, 200);
});

test('testConnection: ok=false bei 401, kein Wurf', async () => {
  mockHandler((req, res) => sendJson(res, {}, 401));
  const adapter = new TandoorAdapter(account);
  const out = await adapter.testConnection();
  assert.equal(out.ok, false);
  assert.equal(out.status, 401);
});

test('testConnection: Netzwerkfehler → ok=false, status=0, error gesetzt', async () => {
  const adapter = new TandoorAdapter({ ...account, base_url: await deadBaseUrl() });
  const out = await adapter.testConnection();
  assert.equal(out.ok, false);
  assert.equal(out.status, 0);
  assert.match(out.error, /ECONNREFUSED/);
});

// --------------------------------------------------------------------------
// listRecipeSummaries: DRF-Pagination über den `next`-Link
// --------------------------------------------------------------------------

test('listRecipeSummaries: folgt dem next-Link über mehrere Seiten', async () => {
  mockHandler((req, res) => {
    const url = new URL(req.url, base);
    const page = url.searchParams.get('page');
    if (page === '1') {
      return sendJson(res, {
        results: [{ id: 1, updated_at: 't1' }, { id: 2, updated_at: 't2' }],
        next: `${base}/api/recipe/?page=2&page_size=50`,
      });
    }
    if (page === '2') {
      return sendJson(res, { results: [{ id: 3, updated_at: 't3' }], next: null });
    }
    throw new Error(`unerwartete Seite: ${page}`);
  });
  const adapter = new TandoorAdapter(account);
  const summaries = await adapter.listRecipeSummaries();
  assert.equal(calls.length, 2);
  assert.deepEqual(summaries.map((s) => s.id), ['1', '2', '3']);
  assert.deepEqual(summaries.map((s) => s.ref), ['1', '2', '3']);
  assert.deepEqual(summaries.map((s) => s.updatedAt), ['t1', 't2', 't3']);
});

test('listRecipeSummaries: next=null → genau ein Request', async () => {
  mockHandler((req, res) => sendJson(res, { results: [{ id: 9, updated_at: 't9' }], next: null }));
  const adapter = new TandoorAdapter(account);
  const summaries = await adapter.listRecipeSummaries();
  assert.equal(calls.length, 1);
  assert.equal(summaries.length, 1);
});

test('listRecipeSummaries: next-Link mit abweichendem Host (Reverse-Proxy) wird trotzdem gegen base_url angefragt', async () => {
  // DRF meldet `next` mit dem Host, den der Proxy selbst für sich hält - die
  // zweite Seite muss trotzdem gegen this.base gehen, sonst ECONNREFUSED/Timeout
  // gegen einen Host, den der Server gar nicht erreichen kann.
  mockHandler((req, res) => {
    const page = new URL(req.url, base).searchParams.get('page');
    if (page === '1') {
      return sendJson(res, {
        results: [{ id: 1, updated_at: 't1' }],
        next: 'https://public-facing-host.example.com/api/recipe/?page=2&page_size=50',
      });
    }
    return sendJson(res, { results: [{ id: 2, updated_at: 't2' }], next: null });
  });
  const adapter = new TandoorAdapter(account);
  const summaries = await adapter.listRecipeSummaries();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, `${base}/api/recipe/?page=2&page_size=50`);
  assert.deepEqual(summaries.map((s) => s.id), ['1', '2']);
});

// --------------------------------------------------------------------------
// getRecipe: flacht steps[].ingredients, überspringt is_header-Zeilen
// --------------------------------------------------------------------------

test('getRecipe: flacht Zutaten über alle steps hinweg, überspringt is_header-Zeilen', async () => {
  mockHandler((req, res) => sendJson(res, {
    id: 5, updated_at: 't5', name: 'Soup', description: 'Tasty', image: '/media/recipe_images/soup.jpg',
    steps: [
      {
        ingredients: [
          { is_header: true, food: null },
          { food: { name: 'Carrot' }, amount: 2, unit: { name: 'pieces' }, no_amount: false },
        ],
      },
      {
        ingredients: [
          { food: { name: 'Water' }, amount: 1, unit: { name: 'liter' }, no_amount: false },
        ],
      },
    ],
  }));
  const adapter = new TandoorAdapter(account);
  const recipe = await adapter.getRecipe('5');
  assert.equal(calls[0].url, `${base}/api/recipe/5/`);
  assert.equal(recipe.id, '5');
  assert.equal(recipe.title, 'Soup');
  assert.equal(recipe.notes, 'Tasty');
  assert.equal(recipe.hasImage, true);
  assert.equal(recipe.slug, '/media/recipe_images/soup.jpg');
  assert.deepEqual(recipe.ingredients.map((i) => i.name), ['Carrot', 'Water']);
});

test('getRecipe: null-Menge bei no_amount=true oder falsy amount', async () => {
  mockHandler((req, res) => sendJson(res, {
    id: 6, updated_at: 't6', name: 'Salad', description: null, image: null,
    steps: [
      {
        ingredients: [
          { food: { name: 'Salt' }, amount: 1, unit: null, no_amount: true },
          { food: { name: 'Pepper' }, amount: 0, unit: null, no_amount: false },
          { food: { name: 'Oil' }, amount: 2, unit: { name: 'tbsp' }, no_amount: false },
        ],
      },
    ],
  }));
  const adapter = new TandoorAdapter(account);
  const recipe = await adapter.getRecipe('6');
  assert.equal(recipe.hasImage, false);
  assert.equal(recipe.slug, null);
  const byName = Object.fromEntries(recipe.ingredients.map((i) => [i.name, i.quantity]));
  assert.equal(byName.Salt, null); // no_amount=true
  assert.equal(byName.Pepper, null); // amount=0 ist falsy
  assert.equal(byName.Oil, '2 tbsp');
});

test('getRecipe: HTTP-Fehler wirft mit Statuscode', async () => {
  mockHandler((req, res) => sendJson(res, {}, 404));
  const adapter = new TandoorAdapter(account);
  await assert.rejects(() => adapter.getRecipe('missing'), /Tandoor request failed \(404\)/);
});

// --------------------------------------------------------------------------
// recipeUrl: /view/recipe/{id}, linkContext wird komplett ignoriert
// --------------------------------------------------------------------------

test('recipeUrl: baut /view/recipe/{id}, ignoriert linkContext (auch null/undefined)', () => {
  const adapter = new TandoorAdapter(account);
  assert.equal(adapter.recipeUrl(null, { id: 42 }), `${base}/view/recipe/42`);
  assert.equal(adapter.recipeUrl(undefined, { id: 42 }), `${base}/view/recipe/42`);
  assert.equal(adapter.recipeUrl({ groupSlug: 'irrelevant' }, { id: 42 }), `${base}/view/recipe/42`);
});

test('recipeUrl: nutzt external_url statt base_url, wenn gesetzt', () => {
  const adapter = new TandoorAdapter({ ...account, external_url: 'https://recipes.example.com/' });
  assert.equal(adapter.recipeUrl(null, { id: 7 }), 'https://recipes.example.com/view/recipe/7');
  assert.equal(adapter.base, base);
});

// --------------------------------------------------------------------------
// fetchThumbnail: {slug} ist der gespeicherte Bildpfad, kein separater Fetch bei fehlendem slug
// --------------------------------------------------------------------------

test('fetchThumbnail: fehlender slug → wirft 404 ohne Request', async () => {
  mockHandler(() => { throw new Error('sollte nicht aufgerufen werden'); });
  const adapter = new TandoorAdapter(account);
  await assert.rejects(() => adapter.fetchThumbnail({ slug: null }), (err) => {
    assert.equal(err.status, 404);
    return true;
  });
  assert.equal(calls.length, 0);
});

test('fetchThumbnail: lädt Binärdaten vom gespeicherten Bildpfad, gibt buffer + mime zurück', async () => {
  const buf = Buffer.from('\x89PNG fake');
  mockHandler((req, res) => sendBinary(res, buf, 'image/png'));
  const adapter = new TandoorAdapter(account);
  const out = await adapter.fetchThumbnail({ slug: '/media/recipe_images/soup.jpg' });
  assert.equal(calls[0].url, `${base}/media/recipe_images/soup.jpg`);
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok123');
  assert.equal(out.mime, 'image/png');
  assert.ok(Buffer.isBuffer(out.buffer));
  assert.equal(out.buffer.toString(), '\x89PNG fake');
});

test('fetchThumbnail: gespeicherter Bildpfad ist eine absolute URL auf demselben Host (Tandoors serializer baut sie via build_absolute_uri) - kein Doppel-Host', async () => {
  const buf = Buffer.from('\x89PNG fake');
  mockHandler((req, res) => sendBinary(res, buf, 'image/png'));
  const adapter = new TandoorAdapter(account);
  const out = await adapter.fetchThumbnail({ slug: `${base}/media/recipes/abc123_5.webp` });
  assert.equal(calls[0].url, `${base}/media/recipes/abc123_5.webp`);
  assert.equal(out.mime, 'image/png');
});

test('fetchThumbnail: absolute URL mit abweichendem Host wird abgelehnt (502), kein Bearer-Token verlässt den konfigurierten Host', async () => {
  mockHandler(() => { throw new Error('sollte nicht aufgerufen werden'); });
  const adapter = new TandoorAdapter(account);
  await assert.rejects(
    () => adapter.fetchThumbnail({ slug: 'https://attacker.example.com/steal.jpg' }),
    (err) => {
      assert.equal(err.status, 502);
      assert.match(err.message, /does not match the configured account/);
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test('fetchThumbnail: HTTP-Fehler wirft mit Statuscode', async () => {
  mockHandler((req, res) => sendJson(res, {}, 500));
  const adapter = new TandoorAdapter(account);
  await assert.rejects(() => adapter.fetchThumbnail({ slug: '/media/x.jpg' }), /Tandoor thumbnail request failed \(500\)/);
});
