/**
 * Test: Der Rezept-Import aus einem Modell
 * Zweck: Die Route `POST /api/v1/recipes/llm-import` macht ein Rezept aus
 *        einem Text oder einer Adresse - und legt es an wie `POST /recipes`.
 *
 *        GEMESSEN WIRD DER EFFEKT, nicht der Aufruf: die abgelehnten Faelle
 *        (Schalter aus, Konfiguration unvollstaendig, keine Quelle, Adresse im
 *        privaten Netz, unbrauchbare Antwort des Modells, Bremse) legen KEIN
 *        Rezept an, und der gelungene Fall legt genau eines an - mit der
 *        Menge als Satz ("500 g") und dem Zubereitungsblock im Notizfeld.
 *
 *        DER ABRUF WIRD ERSETZT, nicht das Netz. `setLlmImportFetch()` aus
 *        dem Dienst tauscht den Abruf aus, mit dem die Route die Quelle holt
 *        und das Modell fragt; der Test antwortet selbst und braucht weder
 *        Server noch Netz. Die Test-Adresse zeigt auf eine oeffentlich
 *        aussehende IP - eine private wuerde der SSRF-Riegel abweisen, bevor
 *        der Abruf stattfindet (das ist der Fall `url_blocked`).
 *
 * Ausfuehren: npm run test:recipe-llm-import
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: recipesRouter } = await import('../server/routes/recipes.js');
const llm = await import('../server/services/llm-recipe-import.js');
const db = dbmod.get();

const USER_ID = db.prepare(`
  INSERT INTO users (username, display_name, avatar_color, password_hash, role)
  VALUES ('llm', 'LLM', '#112233', 'x', 'member')
`).run().lastInsertRowid;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => {
  req.authUserId = USER_ID;
  req.authRole = 'member';
  req.session = { userId: USER_ID, role: 'member' };
  next();
});
app.use('/recipes', recipesRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(body) {
  const res = await fetch(`${baseUrl}/recipes/llm-import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* leer */ }
  return { status: res.status, body: json };
}

/* ── Die Konfiguration im Dienst ─────────────────────────────────────────── */

function cfgSet(key, value) {
  db.prepare('INSERT INTO sync_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}
function cfgDelete(key) {
  db.prepare('DELETE FROM sync_config WHERE key = ?').run(key);
}

/** Der Schalter aus, die Konfiguration voll - der Ausgangspunkt jeder Probe. */
function konfigurieren({ enabled = true, voll = true } = {}) {
  cfgSet('llm_import_enabled', enabled ? '1' : '0');
  if (!voll) {
    cfgDelete('llm_base_url');
    cfgDelete('llm_api_key');
    cfgDelete('llm_model');
    return;
  }
  cfgSet('llm_base_url', 'https://llm.example/v1');
  cfgSet('llm_api_key', 'test-key-nicht-geheim');
  cfgSet('llm_model', 'test-model');
}

/* ── Der ersetzte Abruf ──────────────────────────────────────────────────── */

let aufrufe = [];
let antwortAuf = null;

/**
 * Der Abruf, den die Route benutzt. Er beantwortet die Quellseite mit HTML
 * und das Modell mit einem Rezept-JSON - je nachdem, wonach gefragt wird.
 */
function fetchMocken({ seite = '<html><body><h1>Pfannkuchen</h1><p>Mehl, Milch, Eier</p></body></html>', modell = null } = {}) {
  aufrufe = [];
  llm.setLlmImportFetch(async (url) => {
    aufrufe.push(String(url));
    if (String(url).includes('/chat/completions')) {
      const inhalt = typeof modell === 'string' ? modell : JSON.stringify(modell ?? {
        title: 'Pfannkuchen',
        description: 'Ein einfaches Pfannkuchen-Rezept.',
        ingredients: [{ name: 'Mehl', amount: 500, unit: 'g' }],
        instructions: ['Mehl und Milch verruehren.', 'In der Pfanne braten.'],
        servings: 4,
        prep_time_minutes: 25,
      });
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: inhalt } }] }) };
    }
    return { ok: true, status: 200, text: async () => seite };
  });
}

test.beforeEach(() => {
  llm.resetLlmImportRateLimit();
  llm.configureLlmImportRateLimit({ limit: 10 });
  fetchMocken();
  konfigurieren();
  // Die Tabelle leeren: sonst zaehlt der Test die Rezepte der vorigen Probe
  // mit, und die Aussage "genau ein Rezept" waere dann falsch.
  db.prepare('DELETE FROM recipe_ingredients').run();
  db.prepare('DELETE FROM recipes').run();
});

test.after(() => {
  llm.resetLlmImportFetch();
  llm.resetLlmImportRateLimit();
});

/** Die Rezepte in der Datenbank - der Effekt, nicht die Antwort. */
function rezepte() {
  return db.prepare('SELECT id, title, notes, recipe_url, servings FROM recipes ORDER BY id').all();
}
function zutaten(recipeId) {
  return db.prepare('SELECT name, quantity, category FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id').all(recipeId);
}

const RECEPT_TEXT = 'Pfannkuchen aus 500 g Mehl, 300 ml Milch und zwei Eiern zu vier Portionen.';

// -------------------------------------------------------------------------
// Die drei Absagen vor der Arbeit
// -------------------------------------------------------------------------

test('der Schalter aus: 403 llm_import_disabled, und kein Rezept entsteht', async () => {
  konfigurieren({ enabled: false });
  const r = await call({ text: RECEPT_TEXT });
  assert.equal(r.status, 403);
  assert.equal(r.body.reason, 'llm_import_disabled');
  assert.equal(rezepte().length, 0);
  assert.equal(aufrufe.length, 0, 'der Schalter aus heisst: gar kein Abruf');
});

test('die Konfiguration unvollstaendig: 403 llm_import_not_configured', async () => {
  konfigurieren({ voll: false });
  const r = await call({ text: RECEPT_TEXT });
  assert.equal(r.status, 403);
  assert.equal(r.body.reason, 'llm_import_not_configured');
  assert.equal(rezepte().length, 0);
});

test('ohne Quelle: 400 llm_import_source_required (weder Adresse noch Text)', async () => {
  const r = await call({});
  assert.equal(r.status, 400);
  assert.equal(r.body.reason, 'llm_import_source_required');
  assert.equal(rezepte().length, 0);
});

test('beide Quellen zugleich: 400 llm_import_source_required', async () => {
  const r = await call({ source_url: 'http://93.184.216.34/rezept', text: RECEPT_TEXT });
  assert.equal(r.status, 400);
  assert.equal(r.body.reason, 'llm_import_source_required');
  assert.equal(rezepte().length, 0);
});

test('ein Text, der kuerzer ist als ein Rezept: 400 llm_import_source_required', async () => {
  const r = await call({ text: 'Pfannkuchen' });
  assert.equal(r.status, 400);
  assert.equal(r.body.reason, 'llm_import_source_required');
  assert.equal(rezepte().length, 0);
});

// -------------------------------------------------------------------------
// Die Quelle
// -------------------------------------------------------------------------

test('eine Adresse im privaten Netz: 400 llm_import_url_blocked, und sie wird nicht geholt', async () => {
  const r = await call({ source_url: 'http://192.168.1.10/rezept' });
  assert.equal(r.status, 400);
  assert.equal(r.body.reason, 'llm_import_url_blocked');
  assert.equal(aufrufe.length, 0, 'die Adresse wird abgewiesen, BEVOR sie geholt wird');
  assert.equal(rezepte().length, 0);
});

test('eine Adresse, die keine Seite liefert: 400 llm_import_url_empty', async () => {
  llm.setLlmImportFetch(async (url) => {
    aufrufe.push(String(url));
    if (String(url).includes('/chat/completions')) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
    return { ok: true, status: 200, text: async () => '   ' };
  });
  const r = await call({ source_url: 'http://93.184.216.34/rezept' });
  assert.equal(r.status, 400);
  assert.equal(r.body.reason, 'llm_import_url_empty');
  assert.equal(rezepte().length, 0);
});

// -------------------------------------------------------------------------
// Das Modell
// -------------------------------------------------------------------------

test('eine Antwort, die kein Rezept ist: 502 llm_import_bad_response', async () => {
  fetchMocken({ modell: 'Ich kann dir kein Rezept geben.' });
  const r = await call({ text: RECEPT_TEXT });
  assert.equal(r.status, 502);
  assert.equal(r.body.reason, 'llm_import_bad_response');
  assert.equal(rezepte().length, 0);
});

// -------------------------------------------------------------------------
// Der Erfolg
// -------------------------------------------------------------------------

test('Text: 201, ein Rezept in der Datenbank, Menge als Satz und Zubereitungsblock im Notizfeld', async () => {
  const r = await call({ text: RECEPT_TEXT });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.data.id, 'die Antwort nennt die neue ID');
  assert.equal(r.body.data.title, 'Pfannkuchen');

  const zeilen = rezepte();
  assert.equal(zeilen.length, 1, 'genau ein Rezept steht in der Datenbank');
  const [rezept] = zeilen;
  assert.equal(rezept.title, 'Pfannkuchen');
  // Die Menge ist ein Satz: Zahl und Einheit zusammen ("500 g").
  const zut = zutaten(rezept.id);
  assert.equal(zut.length, 1);
  assert.equal(zut[0].name, 'Mehl');
  assert.equal(zut[0].quantity, '500 g');
  // Das Notizfeld traegt Beschreibung, Zubereitung und Zeit.
  assert.match(rezept.notes, /Pfannkuchen-Rezept/);
  assert.match(rezept.notes, /Zubereitung:/);
  assert.match(rezept.notes, /1\. Mehl und Milch verruehren\./);
  assert.match(rezept.notes, /Zeit: 25 Min\./);
});

test('Adresse: 201, und die Adresse steht als Quelle am Rezept', async () => {
  const r = await call({ source_url: 'http://93.184.216.34/rezept' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(rezepte().length, 1);
  assert.equal(rezepte()[0].recipe_url, 'http://93.184.216.34/rezept');
  assert.ok(aufrufe.some((u) => u === 'http://93.184.216.34/rezept'), 'die Quelle wurde geholt');
});

test('bestaetigte Vorschau: 201, ohne einen zweiten Aufruf beim Modell', async () => {
  const r = await call({
    confirmed: true,
    recipe: {
      title: 'Kartoffelsalat',
      description: 'Ein Salat fuer den Sommer.',
      ingredients: [{ name: 'Kartoffeln', amount: 1, unit: 'kg' }],
      instructions: ['Kartoffeln kochen.'],
      servings: 6,
      prep_time_minutes: 30,
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.title, 'Kartoffelsalat');
  assert.equal(aufrufe.length, 0, 'die bestaetigte Vorschau fragt das Modell nicht');
  const [rezept] = rezepte();
  assert.equal(rezept.title, 'Kartoffelsalat');
  assert.equal(zutaten(rezept.id)[0].quantity, '1 kg');
  assert.match(rezept.notes, /Zubereitung:/);
});

test('eine bestaetigte Vorschau ohne Titel: 502 llm_import_bad_response', async () => {
  const r = await call({ confirmed: true, recipe: { ingredients: [] } });
  assert.equal(r.status, 502);
  assert.equal(r.body.reason, 'llm_import_bad_response');
  assert.equal(rezepte().length, 0);
});

// -------------------------------------------------------------------------
// Die Bremse
// -------------------------------------------------------------------------

test('nach zehn Versuchen: 429 llm_import_rate_limited', async () => {
  llm.configureLlmImportRateLimit({ limit: 2 });
  for (let i = 0; i < 2; i += 1) {
    const r = await call({ text: RECEPT_TEXT });
    assert.equal(r.status, 201, `Versuch ${i + 1}`);
  }
  const r = await call({ text: RECEPT_TEXT });
  assert.equal(r.status, 429);
  assert.equal(r.body.reason, 'llm_import_rate_limited');
  assert.equal(rezepte().length, 2, 'der dritte Versuch legt kein Rezept an');
});

/* ── Die Vorschau ────────────────────────────────────────────────────────── */

test('Vorschau: 200, das Rezept vollstaendig im Ergebnis, und es liegt nichts in der Datenbank', async () => {
  konfigurieren();
  fetchMocken();
  const r = await call({ text: 'Mehl, Milch, Eier und eine Prise Salz zu einem glatten Teig verruehren und in der Pfanne goldbraun ausbacken.', preview: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.recipe.title, 'Pfannkuchen');
  assert.equal(r.body.data.recipe.ingredients.length, 1);
  assert.equal(rezepte().length, 0);
  assert.equal(aufrufe.length, 1);
});

test('Bestaetigung trotz Vorschau-Schalter: gespeichert wird das vorgelegte Rezept, das Modell bleibt unangetastet', async () => {
  konfigurieren();
  fetchMocken();
  const r = await call({ confirmed: true, preview: true, recipe: { title: 'Vorschau-Speichern', ingredients: [] } });
  assert.equal(r.status, 201);
  assert.equal(rezepte().length, 1);
  assert.equal(aufrufe.length, 0);
});
