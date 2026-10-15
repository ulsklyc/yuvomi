/**
 * Tests: die Fehler der Rezepte (#1909)
 * Module: server/routes/recipes.js, server/routes/meals.js (Rezept einplanen),
 *         public/pages/recipes.js, public/utils/avatar-crop.js
 *
 * Der Server nennt den Fall (`reason`), die Seite sagt den Satz der App - nie
 * den des Servers. Sagt der Grund, dass es das Ziel der Handlung nicht mehr
 * gibt (ein anderes Haushaltsmitglied hat das Rezept geloescht, der Abgleich
 * mit einer Rezeptquelle hat es entfernt oder seine Zutaten ersetzt, die
 * Einkaufsliste ist weg), nimmt die Seite genau dieses Ding aus ihrem Stand
 * und zeichnet neu - OHNE die Liste nachzuladen (Zuschnitt nach Codex an
 * #2001) -, und der Dialog der Handlung geht zu - nur wenn er noch der offene ist. Fehlt nur die
 * im Dialog GEWAEHLTE Vorratszeile, bleibt der Dialog offen und bietet den
 * aktuellen Vorrat an.
 *
 * LOESCHEN AUF "GIBT ES NICHT MEHR" IST HIER EIN ERFOLG. Rezepte haben keine
 * Sichtbarkeit: die Liste und jede Schreibroute lesen `recipes` ohne Filter,
 * und ein gespiegeltes Rezept weist DELETE vorher mit 403 `recipe_mirrored`
 * ab. Eine 404 auf DELETE heisst also nur "schon geloescht" - wie im Einkauf,
 * anders als bei Dokumenten und Gesundheit.
 *
 * Gefahren wird auf beiden Seiten der ECHTE Code:
 * - Server: die echten Router (recipes, meals) ueber einer migrierten
 *   In-Memory-DB.
 * - Seite: die echten Handler bis in ihr catch, ueber den api-Stub des Loaders
 *   (`__apiStub`), den Modal-Stub (`__openModal`, `__closeModal`,
 *   `__modalContextId`) und den Ruecknahme-Stub (`__undoStub`).
 *
 * Ausfuehren: npm run test:recipes-errors
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'recipes-errors-test-secret';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
globalThis.localStorage = globalThis.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
const { installMiniDom, MiniElement } = await import('./mini-dom.js');
installMiniDom();
// Fuer das Zeichnen der Liste: Zutaten ohne Zuordnung geben ein leeres
// Fragment, und die Seite setzt Klassen ueber `classList`, wo der Mini-DOM nur
// das Attribut kennt. Derselbe duenne Aufsatz wie in test-kitchen-readonly-ui.js.
globalThis.document.createDocumentFragment ??= () => ({ childNodes: [], dataset: {}, outerHTML: '' });
if (!Object.getOwnPropertyDescriptor(MiniElement.prototype, 'classList')) {
  Object.defineProperty(MiniElement.prototype, 'classList', {
    get() {
      const el = this;
      const liste = () => el.className.split(/\s+/).filter(Boolean);
      const setze = (l) => { el.className = l.join(' '); };
      return {
        add: (...c) => setze([...new Set([...liste(), ...c])]),
        remove: (...c) => setze(liste().filter((k) => !c.includes(k))),
        contains: (c) => liste().includes(c),
        toggle: (c, an = !liste().includes(c)) => { if (an) setze([...new Set([...liste(), c])]); else setze(liste().filter((k) => k !== c)); return an; },
      };
    },
  });
}
const toasts = [];
globalThis.window.yuvomi = { ...globalThis.window.yuvomi, showToast: (text, kind) => { toasts.push([text, kind]); } };
globalThis.window.matchMedia = globalThis.window.matchMedia
  ?? (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: recipesRouter } = await import('../server/routes/recipes.js');
const { default: mealsRouter } = await import('../server/routes/meals.js');
const { setPermissions } = await import('../public/permissions.js');
const { __test: page } = await import('../public/pages/recipes.js');
const { __test: meals } = await import('../public/pages/meals.js');
const crop = await import('../public/utils/avatar-crop.js');
const { CASE_MESSAGES, GONE_REASONS } = await import('../public/utils/friendly-error.js');

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function buildTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
  for (const m of MIGRATIONS) {
    if (typeof m.up === 'function') m.up(db); else db.exec(m.up);
    if (typeof m.afterUp === 'function') m.afterUp(db);
    db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(m.version, m.description);
  }
  return db;
}

const moduleDb = get();
const db = buildTestDb();
_setTestDatabase(db);
moduleDb.close();
test.after(() => db.close());
const admin = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('ada', 'Ada', '$2b$12$x', 'admin')`).run().lastInsertRowid;

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use((req, _res, next) => {
  req.authUserId = admin;
  req.authRole = 'admin';
  req.session = { userId: admin, role: 'admin' };
  next();
});
app.use('/api/v1/recipes', recipesRouter);
app.use('/api/v1/meals', mealsRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
test.after(() => new Promise((r) => server.close(r)));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const GONE = 999999;

async function recipeRow(title = 'Suppe') {
  const r = await call('POST', '/recipes', { title, ingredients: [{ name: 'Mehl' }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data.id;
}

const listId = db.prepare("INSERT INTO shopping_lists (name, created_by) VALUES ('Wocheneinkauf', ?)").run(admin).lastInsertRowid;
const pantryItem = () => db.prepare("INSERT INTO pantry_items (name) VALUES ('Mehl')").run().lastInsertRowid;

test('Server: ein Rezept, das es nicht mehr gibt - aendern, loeschen, auf die Einkaufsliste und zuordnen nennen recipes_recipe_not_found', async () => {
  for (const [method, path, body] of [
    ['PUT', `/recipes/${GONE}`, { title: 'x' }],
    ['DELETE', `/recipes/${GONE}`, null],
    ['POST', `/recipes/${GONE}/to-shopping-list`, { listId }],
    ['PUT', `/recipes/${GONE}/ingredient-match`, { name: 'Mehl', pantryItemId: null }],
  ]) {
    const r = await call(method, path, body);
    assert.deepEqual([r.status, r.body?.reason, r.body?.error], [404, 'recipes_recipe_not_found', 'Recipe not found.'], `${method} ${path}`);
  }
});

test('Server: die Einkaufsliste ist inzwischen weg - die Uebernahme nennt shopping_list_not_found', async () => {
  const id = await recipeRow();
  const r = await call('POST', `/recipes/${id}/to-shopping-list`, { listId: GONE });
  assert.deepEqual([r.status, r.body?.reason, r.body?.error], [404, 'shopping_list_not_found', 'Shopping list not found.']);
});

test('Server: zuordnen - die Zutat steht nicht mehr im Rezept, oder die gewaehlte Vorratszeile ist weg', async () => {
  const id = await recipeRow();
  const zutatWeg = await call('PUT', `/recipes/${id}/ingredient-match`, { name: 'Zucker', pantryItemId: pantryItem() });
  assert.deepEqual([zutatWeg.status, zutatWeg.body?.reason, zutatWeg.body?.error],
    [404, 'recipes_ingredient_not_found', 'Ingredient not found in this recipe.']);
  const zeileWeg = await call('PUT', `/recipes/${id}/ingredient-match`, { name: 'Mehl', pantryItemId: GONE });
  assert.deepEqual([zeileWeg.status, zeileWeg.body?.reason, zeileWeg.body?.error],
    [404, 'recipes_selected_pantry_item_not_found', 'Pantry item not found.']);
});

test('Server: ein Rezept einplanen, das es nicht mehr gibt - anlegen, Plan uebernehmen und aendern nennen den Fall (400 wie bisher)', async () => {
  const meal = await call('POST', '/meals', { date: '2026-10-20', meal_type: 'dinner', title: 'Curry' });
  assert.equal(meal.status, 201, JSON.stringify(meal.body));
  for (const [method, path, body] of [
    ['POST', '/meals', { date: '2026-10-20', meal_type: 'dinner', title: 'Curry', recipe_id: GONE }],
    ['POST', '/meals/apply-plan', { assignments: [{ date: '2026-10-21', meal_type: 'lunch', title: 'x', recipe_id: GONE }] }],
    ['PUT', `/meals/${meal.body.data.id}`, { recipe_id: GONE }],
  ]) {
    const r = await call(method, path, body);
    assert.deepEqual([r.status, r.body?.reason, r.body?.error], [400, 'meals_selected_recipe_not_found', 'Recipe not found.'], `${method} ${path}`);
  }
});

// Der zweite deutsche Satz der Routen ("Zutat darf nicht leer sein.", jetzt
// "Ingredient must not be empty.") ist ueber HTTP nicht erreichbar: `str()`
// schneidet den Namen zu und lehnt einen leeren schon selbst ab, und ein
// nicht leerer Name ergibt nie einen leeren Schluessel. Gemessen wird deshalb
// nur dieser hier.
test('Server: der deutsche Satz zur Rezept-ID ist englisch', async () => {
  const r = await call('PUT', '/recipes/abc', { title: 'x' });
  assert.deepEqual([r.status, r.body?.error], [400, 'Invalid recipe ID.']);
});

const SERVER_REASONS = ['recipes_recipe_not_found', 'recipes_ingredient_not_found', 'recipes_selected_pantry_item_not_found', 'meals_selected_recipe_not_found'];

test('Server: jeder Grund der Rezepte hat einen Satz, und jeder "gibt es nicht mehr" ist als solcher bekannt', () => {
  for (const reason of [...SERVER_REASONS, 'shopping_list_not_found']) {
    assert.ok(CASE_MESSAGES.has(reason), `${reason}: kein Satz`);
    assert.ok(GONE_REASONS.has(reason), `${reason}: nicht in GONE_REASONS`);
  }
  assert.deepEqual([...CASE_MESSAGES.keys()].filter((r) => /^(recipes|meals)_/.test(r)).sort(), [...SERVER_REASONS].sort(),
    'ein Grund in CASE_MESSAGES, den kein Server dieser Suite nennt');
});

// ---------------------------------------------------------------------------
// Seite
// ---------------------------------------------------------------------------

setPermissions({ admin: true, modules: {}, widgets: {}, capabilities: {} });

const SERVER_TEXT = 'Server sentence.';
const fehler = (status, reason) => Object.assign(new Error(SERVER_TEXT), {
  name: 'ApiError', status,
  data: { error: SERVER_TEXT, code: status, ...(reason ? { reason } : {}) },
});

const PANTRY = [{ id: 7, name: 'Mehl', location_name: 'Keller' }, { id: 8, name: 'Zucker', location_name: 'Kueche' }];
const rezept = (extra = {}) => ({
  id: 5, title: 'Suppe', source: 'native', meal_types: ['dinner'],
  ingredients: [{ name: 'Mehl', pantry_item_id: null }, { name: 'Salz', pantry_item_id: null }], ...extra,
});

/** Den Seitenzustand fuer einen Fall herstellen und danach zuruecksetzen. */
async function mitSeite(patch, fn) {
  const s = page.state;
  const zuvor = { ...s };
  Object.assign(s, { recipes: [rezept()], lists: [{ id: 1, name: 'Wocheneinkauf' }], query: '', sourceFilter: 'all', loadError: null }, patch);
  // Eine Seite, die gerade angezeigt wird: im DOM eingehaengt.
  const container = { querySelector: () => null, querySelectorAll: () => [], isConnected: true };
  page.setContainerForTest(container);
  try {
    return await fn();
  } finally {
    Object.assign(s, zuvor);
    page.setContainerForTest(null);
  }
}

/**
 * Mit einem api-Stub laufen lassen. `calls` schreibt jede Anfrage mit,
 * `closed` jedes Schliessen eines Dialogs. Lesen liefert, was `antworten.get`
 * sagt, sonst leere Listen; die Schreibwege nennt der Test.
 */
async function mit(antworten, lauf) {
  toasts.length = 0;
  const calls = [];
  const closed = [];
  const stub = {
    get: async (path) => { calls.push(['GET', path]); return antworten.get?.(path) ?? { data: [] }; },
  };
  for (const verb of ['post', 'put', 'patch', 'delete']) {
    stub[verb] = async (path, body) => {
      calls.push([verb.toUpperCase(), path]);
      if (!antworten[verb]) throw new Error(`kein Stub fuer ${verb} ${path}`);
      return antworten[verb](path, body);
    };
  }
  const zuvor = { api: globalThis.__apiStub, close: globalThis.__closeModal, select: globalThis.__selectModal };
  globalThis.__apiStub = stub;
  globalThis.__closeModal = (opts) => { closed.push(opts ?? {}); return true; };
  globalThis.__selectModal = async () => antworten.select ?? null;
  try {
    await lauf();
    for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
  } finally {
    globalThis.__apiStub = zuvor.api;
    globalThis.__closeModal = zuvor.close;
    globalThis.__selectModal = zuvor.select;
  }
  const gets = calls.filter(([verb]) => verb === 'GET').map(([, path]) => path);
  // Der Stand der Seite am Ende des Laufs, bevor mitSeite() ihn zuruecksetzt.
  const stand = {
    rezepte: page.state.recipes.map((r) => r.id),
    listen: page.state.lists.map((l) => l.id),
    zutaten: page.state.recipes.find((r) => r.id === 5)?.ingredients?.map((i) => i.name) ?? null,
  };
  return { calls, closed, gets, stand };
}

/** Holt die Seite Rezepte oder Listen neu? Nach dem Zuschnitt nie. */
const reloaded = (gets) => gets.includes('/recipes') || gets.includes('/shopping');

/** Der erwartete Stand nach "gibt es nicht mehr": was genau fehlt jetzt. */
const STAND_VORHER = { rezepte: [5], listen: [1], zutaten: ['Mehl', 'Salz'] };
const standNach = (was) => ({
  ...STAND_VORHER,
  ...(was === 'rezept' ? { rezepte: [], zutaten: null } : {}),
  ...(was === 'zutat' ? { zutaten: ['Salz'] } : {}),
  ...(was === 'liste' ? { listen: [] } : {}),
});

const assertNoServerText = () => {
  for (const [text] of toasts) assert.doesNotMatch(String(text), /Server sentence/, 'der Text des Servers im Toast');
};

/** Ein Formular-Element, das Wert, Fokus, Handler und neu gebaute Optionen merkt. */
function feld(wert = '') {
  return {
    value: wert, disabled: false, hidden: false, textContent: '', html: null, focused: 0, dataset: {}, handlers: {},
    focus() { this.focused += 1; },
    replaceChildren() { this.html = ''; },
    insertAdjacentHTML(_where, html) { this.html = (this.html ?? '') + html; },
    addEventListener(type, fn) { this.handlers[type] = fn; },
    setAttribute() {}, removeAttribute() {}, appendChild() {}, closest: () => null,
    classList: { toggle() {}, add() {}, remove() {} },
    querySelector: () => null, querySelectorAll: () => [],
  };
}

function formular(werte = {}, listen = {}) {
  const gemerkt = new Map();
  return {
    dataset: {},
    querySelectorAll: (selector) => listen[selector] ?? [],
    querySelector(selector) {
      if (!gemerkt.has(selector)) gemerkt.set(selector, feld(werte[selector] ?? ''));
      return gemerkt.get(selector);
    },
  };
}

/** Einen Dialog oeffnen, seinen Inhalt merken und das Formular liefern. */
function oeffne(panel, lauf) {
  let content = null;
  globalThis.__openModal = (opts) => { content = opts.content; opts.onSave(panel); };
  return Promise.resolve(lauf()).then(() => content).finally(() => { delete globalThis.__openModal; });
}

/** Optionen einer Auswahl als [Wert, Text]-Paare. */
const optionen = (html) => [...String(html).matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2].trim()]);

// --- Vorrat laden ----------------------------------------------------------

test('Seite: der Vorrat laedt nicht - der Satz der Stelle oder der Fall, nie der Text des Servers', async () => {
  for (const lauf of [() => page.openPantryMatchModal(rezept(), 'Mehl'), () => page.openPantryBulkMatchModal(rezept())]) {
    for (const [err, expected] of [
      [fehler(500), 'recipes.ingredientMatchLoadError'],
      [fehler(400), 'recipes.ingredientMatchLoadError'],
      [fehler(403, 'module_access_denied'), 'common.errorModuleNoAccess'],
    ]) {
      await mitSeite({}, () => mit({ get: () => { throw err; } }, lauf));
      assert.deepEqual(toasts, [[expected, 'danger']], `${err.status} ${err.data.reason ?? ''}`);
      assertNoServerText();
    }
  }
});

// --- Eine Zutat zuordnen ---------------------------------------------------

const ZUORDNEN_FAELLE = [
  [fehler(404, 'recipes_recipe_not_found'), 'recipes.errorRecipeGone', 'gone', 'rezept'],
  [fehler(404, 'recipes_ingredient_not_found'), 'recipes.errorIngredientGone', 'gone', 'zutat'],
  [fehler(404, 'recipes_selected_pantry_item_not_found'), 'recipes.errorSelectedPantryItemGone', 'selected', null],
  [fehler(403, 'cross_module_access'), 'common.errorNoPermission', 'stay', null],
  [fehler(400), 'common.errorGeneric', 'stay', null],
  [fehler(500), 'common.errorGeneric', 'stay', null],
];

/** Nach dem Oeffnen nur noch Mehl im Vorrat: Zucker wurde inzwischen geloescht. */
const vorratDanach = { get: (path) => (path === '/pantry' ? { data: [PANTRY[0]] } : { data: [] }) };

test('Seite: eine Zutat zuordnen - der Fall wird sein Satz; "gibt es nicht mehr" schliesst und nimmt Rezept oder Zutat aus dem Stand, die weggefallene Vorratszeile frischt die Auswahl auf', async () => {
  for (const [err, expected, art, was] of ZUORDNEN_FAELLE) {
    const panel = formular({ '#pantry-match-select': '8' });
    let content = null;
    let ersterGet = true;
    const { gets, closed, stand } = await mitSeite({}, () => mit({
      get: (path) => {
        if (path === '/pantry' && ersterGet) { ersterGet = false; return { data: PANTRY }; }
        return vorratDanach.get(path);
      },
      put: async () => { throw err; },
    }, async () => {
      content = await oeffne(panel, () => page.openPantryMatchModal(page.state.recipes[0], 'Mehl'));
      await panel.querySelector('#pantry-match-save').handlers.click();
    }));
    const label = `${err.status} ${err.data.reason ?? ''}`;
    assert.deepEqual(toasts, [[expected, 'danger']], label);
    assert.equal(closed.length, art === 'gone' ? 1 : 0, `${label}: geschlossen`);
    assert.equal(reloaded(gets), false, `${label}: nachgeladen ${gets.join(', ')}`);
    assert.deepEqual(stand, standNach(was), `${label}: der Stand danach`);
    const select = panel.querySelector('#pantry-match-select');
    if (art === 'selected') {
      assert.equal(gets.filter((p) => p === '/pantry').length, 2, 'der Vorrat kommt frisch');
      assert.deepEqual(optionen(select.html).map(([value]) => value), ['', '7'], 'die geloeschte Zeile steht nicht mehr zur Wahl');
      // DERSELBE Beschriftungshelfer wie beim Oeffnen: die Option steht dort genauso.
      for (const [value, text] of optionen(select.html)) {
        assert.ok(optionen(content).some(([v, t]) => v === value && t === text), `Option ${value} wie beim Oeffnen: ${text}`);
      }
      assert.equal(select.value, '', 'die Auswahl steht auf "nicht zugeordnet"');
      assert.equal(select.focused, 1, 'und traegt den Fokus');
    } else {
      assert.equal(select.html, null, `${label}: die Auswahl bleibt, wie sie war`);
    }
    assertNoServerText();
  }
});

test('Seite: eine Zutat zuordnen - wechselt der Dialog zwischen Anfrage und Antwort, bleibt der andere offen', async () => {
  let kontext = 'zuordnen';
  globalThis.__modalContextId = () => kontext;
  try {
    const panel = formular({ '#pantry-match-select': '7' });
    const { closed, gets, stand } = await mitSeite({}, () => mit({
      get: (path) => (path === '/pantry' ? { data: PANTRY } : { data: [] }),
      put: async () => { kontext = 'ein-anderer-dialog'; throw fehler(404, 'recipes_recipe_not_found'); },
    }, async () => {
      await oeffne(panel, () => page.openPantryMatchModal(rezept(), 'Mehl'));
      await panel.querySelector('#pantry-match-save').handlers.click();
    }));
    assert.deepEqual(toasts, [['recipes.errorRecipeGone', 'danger']]);
    assert.deepEqual(closed, [], 'der andere Dialog bleibt offen');
    assert.deepEqual(stand.rezepte, [], 'das Rezept faellt trotzdem aus dem Stand');
    assert.equal(reloaded(gets), false, 'ohne Nachladen');
  } finally {
    delete globalThis.__modalContextId;
  }
});

// --- Mehrere Zutaten zuordnen ----------------------------------------------

test('Seite: mehrere Zutaten zuordnen - derselbe Weg; die weggefallene Vorratszeile frischt JEDE Auswahl auf und behaelt, was noch steht', async () => {
  for (const [err, expected, art, was] of ZUORDNEN_FAELLE) {
    const mehl = { ...feld('8'), dataset: { ingredientIndex: '0' } };
    const salz = { ...feld('7'), dataset: { ingredientIndex: '1' } };
    const panel = formular({}, { 'select[data-ingredient-index]': [mehl, salz] });
    let content = null;
    let ersterGet = true;
    const { gets, closed, stand } = await mitSeite({}, () => mit({
      get: (path) => {
        if (path === '/pantry' && ersterGet) { ersterGet = false; return { data: PANTRY }; }
        return vorratDanach.get(path);
      },
      put: async () => { throw err; },
    }, async () => {
      content = await oeffne(panel, () => page.openPantryBulkMatchModal(page.state.recipes[0]));
      await panel.querySelector('#pantry-bulk-match-save').handlers.click();
    }));
    const label = `${err.status} ${err.data.reason ?? ''}`;
    assert.deepEqual(toasts, [[expected, 'danger']], label);
    assert.equal(closed.length, art === 'gone' ? 1 : 0, `${label}: geschlossen`);
    assert.equal(reloaded(gets), false, `${label}: nachgeladen ${gets.join(', ')}`);
    // Gescheitert ist die erste gewaehlte Zutat (Mehl): genau sie faellt weg.
    assert.deepEqual(stand, standNach(was), `${label}: der Stand danach`);
    assert.equal(panel.querySelector('#pantry-bulk-match-save').disabled, false, `${label}: Speichern geht wieder`);
    if (art === 'selected') {
      for (const select of [mehl, salz]) {
        assert.deepEqual(optionen(select.html).map(([value]) => value), ['', '7']);
        for (const [value, text] of optionen(select.html)) {
          assert.ok(optionen(content).some(([v, t]) => v === value && t === text), `Option ${value} wie beim Oeffnen: ${text}`);
        }
      }
      assert.equal(mehl.value, '', 'die geloeschte Wahl faellt auf "nicht zugeordnet"');
      assert.equal(mehl.focused, 1, 'und traegt den Fokus');
      assert.equal(salz.value, '7', 'eine Wahl, die es noch gibt, bleibt stehen');
      assert.equal(salz.focused, 0);
    } else {
      assert.equal(mehl.html, null, `${label}: die Auswahl bleibt, wie sie war`);
    }
    assertNoServerText();
  }
});

// --- Rezept speichern ------------------------------------------------------

test('Seite: ein Rezept speichern - "gibt es nicht mehr" schliesst den Dialog und nimmt das Rezept aus dem Stand; gespiegelt und alles andere sagen ihren Satz', async () => {
  for (const [err, expected, gone] of [
    [fehler(404, 'recipes_recipe_not_found'), 'recipes.errorRecipeGone', true],
    [fehler(403, 'recipe_mirrored'), 'recipes.errorMirrored', false],
    [fehler(400), 'common.errorGeneric', false],
    [fehler(500), 'common.errorGeneric', false],
  ]) {
    const panel = formular({ '#recipe-title': 'Suppe' });
    const { gets, closed, stand } = await mitSeite({}, () => mit({ put: async () => { throw err; } },
      () => page.saveRecipe(panel, 'edit', rezept())));
    const label = `${err.status} ${err.data.reason ?? ''}`;
    assert.deepEqual(toasts, [[expected, 'danger']], label);
    assert.equal(closed.length, gone ? 1 : 0, `${label}: geschlossen`);
    assert.equal(reloaded(gets), false, `${label}: nachgeladen ${gets.join(', ')}`);
    assert.deepEqual(stand, standNach(gone ? 'rezept' : null), `${label}: der Stand danach`);
    assert.equal(panel.querySelector('#recipe-save').disabled, false, `${label}: Speichern geht wieder`);
    assertNoServerText();
  }
});

test('Seite: ein Rezept speichern - wechselt der Dialog zwischen Anfrage und Antwort, bleibt der andere offen', async () => {
  let kontext = 'rezept';
  globalThis.__modalContextId = () => kontext;
  try {
    const panel = formular({ '#recipe-title': 'Suppe' });
    const { closed } = await mitSeite({}, () => mit({
      put: async () => { kontext = 'anderer'; throw fehler(404, 'recipes_recipe_not_found'); },
    }, () => page.saveRecipe(panel, 'edit', rezept())));
    assert.deepEqual(toasts, [['recipes.errorRecipeGone', 'danger']]);
    assert.deepEqual(closed, []);
  } finally {
    delete globalThis.__modalContextId;
  }
});

test('Seite: duplizieren - der allgemeine Satz, nie der Text des Servers', async () => {
  for (const err of [fehler(400), fehler(500)]) {
    await mitSeite({}, () => mit({ post: async () => { throw err; } }, () => page.duplicateRecipe(rezept())));
    assert.deepEqual(toasts, [['common.errorGeneric', 'danger']], String(err.status));
    assertNoServerText();
  }
});

// --- Einplanen -------------------------------------------------------------

test('Seite: in den Essensplan - ein Rezept, das es nicht mehr gibt, schliesst den Dialog und faellt aus dem Stand; sonst der allgemeine Satz', async () => {
  for (const [err, expected, gone] of [
    [fehler(400, 'meals_selected_recipe_not_found'), 'recipes.errorRecipeGone', true],
    [fehler(400), 'common.errorGeneric', false],
    [fehler(500), 'common.errorGeneric', false],
  ]) {
    const panel = formular({ '#plan-date': '20.10.2026', '#plan-type': 'dinner' });
    const { gets, closed, stand } = await mitSeite({}, () => mit({ post: async () => { throw err; } }, async () => {
      await oeffne(panel, () => page.planRecipe(rezept(), null));
      const confirm = panel.querySelector('#plan-confirm');
      await confirm.handlers.click({ currentTarget: confirm });
    }));
    const label = `${err.status} ${err.data.reason ?? ''}`;
    assert.deepEqual(toasts, [[expected, 'danger']], label);
    assert.equal(closed.length, gone ? 1 : 0, `${label}: geschlossen`);
    assert.equal(reloaded(gets), false, `${label}: nachgeladen ${gets.join(', ')}`);
    assert.deepEqual(stand, standNach(gone ? 'rezept' : null), `${label}: der Stand danach`);
    assert.equal(panel.querySelector('#plan-confirm').disabled, false, `${label}: der Knopf geht wieder`);
    assertNoServerText();
  }
});

// --- Auf die Einkaufsliste -------------------------------------------------

test('Seite: auf die Einkaufsliste - Rezept oder Liste weg nimmt genau das aus dem Stand, ohne nachzuladen; sonst der allgemeine Satz', async () => {
  for (const [err, expected, was] of [
    [fehler(404, 'recipes_recipe_not_found'), 'recipes.errorRecipeGone', 'rezept'],
    [fehler(404, 'shopping_list_not_found'), 'shopping.errorListGone', 'liste'],
    [fehler(403, 'cross_module_access'), 'common.errorNoPermission', null],
    [fehler(500), 'common.errorGeneric', null],
  ]) {
    const { gets, stand } = await mitSeite({}, () => mit({
      post: async () => { throw err; },
    }, () => page.transferRecipe(rezept(), null)));
    const label = `${err.status} ${err.data.reason ?? ''}`;
    assert.deepEqual(toasts, [[expected, 'danger']], label);
    assert.equal(reloaded(gets), false, `${label}: nachgeladen ${gets.join(', ')}`);
    assert.deepEqual(stand, standNach(was), `${label}: der Stand danach`);
    assertNoServerText();
  }
});

test('Seite: auf die Einkaufsliste - nach "Liste weg" faellt genau die gewaehlte Liste aus der Auswahl', async () => {
  const { stand } = await mitSeite({ lists: [{ id: 1, name: 'Wocheneinkauf' }, { id: 2, name: 'Drogerie' }] }, () => mit({
    select: '2',
    post: async () => { throw fehler(404, 'shopping_list_not_found'); },
  }, () => page.transferRecipe(rezept(), null)));
  assert.deepEqual(stand.listen, [1]);
});

// --- Loeschen --------------------------------------------------------------

test('Seite: loeschen mit Ruecknahme - "schon geloescht" ist ein Erfolg ohne Toast; alles andere stellt zurueck und sagt den Satz der App', async () => {
  for (const [err, expectedToasts, restored] of [
    [fehler(404, 'recipes_recipe_not_found'), [], false],
    [fehler(403, 'recipe_mirrored'), [['recipes.errorMirrored', 'danger']], true],
    [fehler(500), [['common.unknownError', 'danger']], true],
  ]) {
    await mitSeite({}, async () => {
      let opts = null;
      const itemEl = { style: { display: '' } };
      page.setContainerForTest({ querySelector: (s) => (s.startsWith('.recipe-row-item') ? itemEl : null), querySelectorAll: () => [] });
      globalThis.__undoStub = (o) => { opts = o; };
      try { page.removeRecipe(rezept()); } finally { delete globalThis.__undoStub; }
      assert.ok(opts, 'der Ruecknahme-Weg wurde gestartet');
      assert.equal(itemEl.style.display, 'none', 'die Zeile ist sofort weg');
      await mit({ delete: async () => { throw err; } }, async () => {
        try { await opts.commit({ keepalive: false }); } catch (e) { opts.restore(e); }
      });
      const label = `${err.status} ${err.data.reason ?? ''}`;
      assert.deepEqual(toasts, expectedToasts, label);
      assert.equal(itemEl.style.display === '', restored, `${label}: zurueckgestellt`);
      assert.equal(page.state.recipes.some((r) => r.id === 5), restored, `${label}: im Zustand`);
      assertNoServerText();
    });
  }
});

// --- Eigenes Bild ----------------------------------------------------------

test('Seite: ein eigenes Bild waehlen - die Pruefung des Bildes sagt ihren Satz, ein anderer Fehler den allgemeinen, nie seinen eigenen Text', async () => {
  for (const [datei, expected] of [
    // Falscher Typ: die Pruefung in utils/avatar-crop.js sagt ihren Satz.
    [{ type: 'text/plain', size: 10 }, 'settings.profilePictureTypeError'],
    // Ein Bild, das sich nicht lesen laesst, weil es hier keinen FileReader
    // gibt: ein Fehler, den keine Pruefung benannt hat ("FileReader is not
    // defined") - ein Programmfehler, keine Ansage fuer den Nutzer.
    [{ type: 'image/png', size: 10 }, 'common.errorGeneric'],
  ]) {
    const panel = formular({ '#recipe-title': 'Suppe' });
    await mitSeite({}, () => mit({}, async () => {
      await oeffne(panel, () => page.openRecipeModal('create'));
      await panel.querySelector('#recipe-image').handlers.change({ target: { files: [datei], value: 'x' } });
    }));
    const [[text, kind] = []] = toasts;
    assert.equal(kind, 'danger', datei.type);
    assert.equal(text, expected, datei.type);
    assert.doesNotMatch(String(text), /FileReader/);
  }
});

test('Seite: ein eigenes Bild, das zu gross ist - als Datei oder nach dem Zuschnitt - sagt den Satz seiner Pruefung', async () => {
  // Lesen und Zuschnitt gibt es ohne Browser nicht: der FileReader liefert
  // eine Data-URL, der Zuschnitt ein Ergebnis ueber der Grenze von 768 KB.
  const zuvor = globalThis.FileReader;
  globalThis.FileReader = class {
    readAsDataURL() { this.result = 'data:image/png;base64,AAAA'; queueMicrotask(() => this.onload()); }
  };
  crop._setCropDialogForTest(async () => `data:image/jpeg;base64,${'A'.repeat(800 * 1024)}`);
  try {
    for (const [datei, expected] of [
      [{ type: 'image/png', size: 5 * 1024 * 1024 + 1 }, 'settings.profilePictureFileTooLarge'],
      // Die Rezepte nennen fuer den Zuschnitt ihren eigenen Satz.
      [{ type: 'image/png', size: 10 }, 'recipes.imageTooLarge'],
    ]) {
      const panel = formular({ '#recipe-title': 'Suppe' });
      await mitSeite({}, () => mit({}, async () => {
        await oeffne(panel, () => page.openRecipeModal('create'));
        await panel.querySelector('#recipe-image').handlers.change({ target: { files: [datei], value: 'x' } });
      }));
      assert.deepEqual(toasts, [[expected, 'danger']], `${datei.size}`);
    }
  } finally {
    crop._setCropDialogForTest(null);
    globalThis.FileReader = zuvor;
  }
});

// --- Neu zeichnen nach "gibt es nicht mehr" --------------------------------

test('Seite: nach "gibt es nicht mehr" kommt der Fokus zurueck; wer die Seite inzwischen verlassen hat (derselbe, nun abgehaengte Container), bekommt nichts gezeichnet', async () => {
  let refocus = 0;
  globalThis.__refocusAfterRender = () => { refocus += 1; };
  try {
    await mitSeite({}, () => mit({ post: async () => { throw fehler(404, 'recipes_recipe_not_found'); } },
      () => page.transferRecipe(rezept(), null)));
    assert.equal(refocus, 1, 'der Fokus geht auf den Nachfolger des Ausloesers');

    refocus = 0;
    const gefragt = [];
    const seite = { querySelector: (sel) => { gefragt.push(sel); return null; }, querySelectorAll: () => [], isConnected: true };
    await mitSeite({}, async () => {
      page.setContainerForTest(seite);
      await mit({
        post: async () => {
          // Die Seite wird verlassen, waehrend die Antwort unterwegs ist.
          seite.isConnected = false;
          gefragt.length = 0;
          throw fehler(404, 'recipes_recipe_not_found');
        },
      }, () => page.transferRecipe(rezept(), null));
    });
    assert.deepEqual(gefragt, [], 'in die verlassene Seite wird nicht gezeichnet');
    assert.equal(refocus, 0, 'der Fokus der neuen Seite bleibt, wo er ist');
  } finally {
    delete globalThis.__refocusAfterRender;
  }
});

/** Die Liste in einen Mini-Knoten zeichnen lassen; Zeilen-Suchen finden nichts. */
function mitListe(fn) {
  const liste = new MiniElement('div');
  liste.querySelectorAll = () => [];
  const seite = {
    isConnected: true,
    querySelector: (sel) => (sel === '#recipes-list' ? liste : null),
    querySelectorAll: () => [],
  };
  page.setContainerForTest(seite);
  return fn(liste);
}

// Codex an #2001: das Loeschen eines Rezepts blendet seine Zeile sofort aus,
// geschrieben wird erst nach dem Ruecknahme-Fenster. Ein Neuzeichnen in diesem
// Fenster (hier: "gibt es nicht mehr" an einem ANDEREN Rezept) darf die Zeile
// nicht zurueckbringen - auch nicht, wenn der Server sie noch fuehrt.
test('Seite: "gibt es nicht mehr" waehrend das Loeschen eines ANDEREN Rezepts im Ruecknahme-Fenster steht - das ausgeblendete Rezept bleibt ausgeblendet', async () => {
  const eintopf = rezept({ id: 6, title: 'Eintopf' });
  const salat = rezept({ id: 7, title: 'Salat' });
  await mitSeite({ recipes: [rezept(), eintopf, salat] }, () => mitListe(async (liste) => {
    let opts = null;
    globalThis.__undoStub = (o) => { opts = o; };
    try { page.removeRecipe(eintopf); } finally { delete globalThis.__undoStub; }
    assert.ok(opts, 'Vorbedingung: das Loeschen wartet im Ruecknahme-Fenster');
    await mit({
      // Der Server fuehrt den Eintopf noch: geloescht wird erst nach dem Fenster.
      get: (path) => (path === '/recipes' ? { data: [eintopf, salat] } : { data: [] }),
      post: async () => { throw fehler(404, 'recipes_recipe_not_found'); },
    }, () => page.transferRecipe(rezept(), null));
    const html = liste.outerHTML;
    assert.match(html, /Salat/, 'Vorbedingung: die Liste ist neu gezeichnet');
    assert.doesNotMatch(html, /Eintopf/, 'das Rezept im Ruecknahme-Fenster bleibt ausgeblendet');
    assert.doesNotMatch(html, /Suppe/, 'das verschwundene Rezept ist weg');

    // Rueckgaengig: jetzt steht es wieder da.
    opts.restore();
    page.buildRecipeList();
    assert.match(liste.outerHTML, /Eintopf/, 'nach Rueckgaengig steht es wieder in der Liste');
  }));
});

// Codex an #2001: ein offener Zuordnungsdialog haelt Rezept und Zutat in
// seiner Closure. "Gibt es nicht mehr" an einem ANDEREN Rezept darf diese
// Objekte nicht durch neue ersetzen - sonst schriebe sein Speichern in
// Objekte, die die Seite nicht mehr fuehrt.
test('Seite: ein offener Zuordnungsdialog speichert nach "gibt es nicht mehr" an einem ANDEREN Rezept in den aktuellen Stand', async () => {
  const andere = rezept({ id: 6, title: 'Eintopf' });
  await mitSeite({ recipes: [rezept(), andere] }, async () => {
    const suppe = page.state.recipes[0];
    const panel = formular({ '#pantry-match-select': '7' });
    await mit({
      // Was ein Nachladen jetzt holte: frische Objekte derselben Suppe.
      get: (path) => (path === '/pantry' ? { data: PANTRY } : path === '/recipes' ? { data: [rezept()] } : { data: [] }),
      post: async () => { throw fehler(404, 'recipes_recipe_not_found'); },
      put: async () => ({ data: { pantry_item_id: 7, pantry_item_name: 'Mehl' } }),
    }, async () => {
      await oeffne(panel, () => page.openPantryMatchModal(suppe, 'Mehl'));
      // Waehrend der Dialog offen steht, scheitert die Uebernahme des Eintopfs.
      await page.transferRecipe(andere, null);
      for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
      assert.deepEqual(page.state.recipes.map((r) => r.id), [5], 'Vorbedingung: der Eintopf ist aus dem Stand');
      await panel.querySelector('#pantry-match-save').handlers.click();
    });
    const mehl = page.state.recipes.find((r) => r.id === 5).ingredients.find((i) => i.name === 'Mehl');
    assert.equal(mehl.pantry_item_id, 7, 'die Zuordnung steht im Stand, den die Liste zeichnet');
  });
});

// --- Essensplan: Mahlzeit speichern -----------------------------------------

test('Essensplan: eine Mahlzeit speichern, deren gewaehltes Rezept es nicht mehr gibt - der Satz der App, nie der Text des Servers', async () => {
  for (const [err, expected] of [
    [fehler(400, 'meals_selected_recipe_not_found'), 'recipes.errorRecipeGone'],
    [fehler(400), 'common.errorGeneric'],
    [fehler(500), 'common.errorGeneric'],
  ]) {
    const felder = {
      '#modal-save': { disabled: false, textContent: '' },
      '#modal-date': { value: '2026-10-20' }, '#modal-type': { value: 'dinner' }, '#modal-title': { value: 'Curry' },
      '#modal-notes': { value: '' }, '#modal-recipe-url': { value: '' }, '#modal-recipe-id': { value: '5' },
    };
    const form = { querySelector: (sel) => felder[sel] ?? null, querySelectorAll: () => [] };
    meals.setContainerForTest({ querySelector: () => null, querySelectorAll: () => [] });
    meals.state.modal = { mode: 'create' };
    try {
      const { calls } = await mit({ post: async () => { throw err; } }, () => meals.saveModal(form));
      assert.ok(calls.some(([verb, path]) => verb === 'POST' && path === '/meals'), 'Vorbedingung: gespeichert wurde wirklich');
    } finally {
      meals.state.modal = null;
      meals.setContainerForTest(null);
    }
    assert.deepEqual(toasts, [[expected, 'danger']], `${err.status} ${err.data.reason ?? ''}`);
    assert.equal(felder['#modal-save'].disabled, false, 'Speichern geht wieder');
    assertNoServerText();
  }
});

// Codex an #2001: der Server sucht die Zutat mit `ingredientMatchKey()`.
// "Gibt es nicht mehr" gilt also fuer jede Schreibweise mit demselben
// Schluessel - die Seite nimmt sie mit derselben Funktion heraus.
test('Seite: Zutat weg - jede Zutat mit demselben Schluessel wie beim Server faellt aus dem Stand, andere bleiben', async () => {
  const zutaten = [{ name: 'Salz', pantry_item_id: null }, { name: '  salz ', pantry_item_id: null }, { name: 'SALZ  ', pantry_item_id: null }, { name: 'Salzbutter', pantry_item_id: null }, { name: 'Mehl', pantry_item_id: null }];
  const panel = formular({ '#pantry-match-select': '7' });
  const { stand } = await mitSeite({ recipes: [rezept({ ingredients: zutaten.map((z) => ({ ...z })) })] }, () => mit({
    get: (path) => (path === '/pantry' ? { data: PANTRY } : { data: [] }),
    put: async () => { throw fehler(404, 'recipes_ingredient_not_found'); },
  }, async () => {
    await oeffne(panel, () => page.openPantryMatchModal(page.state.recipes[0], 'Salz'));
    await panel.querySelector('#pantry-match-save').handlers.click();
  }));
  assert.deepEqual(stand.zutaten, ['Salzbutter', 'Mehl']);
});

// Codex an #2001: `owner` wird VOR der Anfrage gemerkt. Wer die Seite
// verlaesst und zurueckkehrt, hat einen NEUEN Container und einen frisch
// geladenen Stand - eine spaete "gibt es nicht mehr"-Antwort der alten Seite
// faesst ihn nicht an.
test('Seite: verlassen und zurueck (neuer Container), dann kommt eine spaete "gibt es nicht mehr"-Antwort - der neue Stand bleibt unberuehrt', async () => {
  let refocus = 0;
  globalThis.__refocusAfterRender = () => { refocus += 1; };
  try {
    for (const [name, err, lauf] of [
      ['Zutat zuordnen', fehler(404, 'recipes_ingredient_not_found'), async (panel) => {
        await oeffne(panel, () => page.openPantryMatchModal(page.state.recipes[0], 'Mehl'));
        await panel.querySelector('#pantry-match-save').handlers.click();
      }],
      ['auf die Einkaufsliste', fehler(404, 'recipes_recipe_not_found'), () => page.transferRecipe(page.state.recipes[0], null)],
      ['Liste weg', fehler(404, 'shopping_list_not_found'), () => page.transferRecipe(page.state.recipes[0], null)],
      ['einplanen', fehler(400, 'meals_selected_recipe_not_found'), async (panel) => {
        await oeffne(panel, () => page.planRecipe(page.state.recipes[0], null));
        const confirm = panel.querySelector('#plan-confirm');
        await confirm.handlers.click({ currentTarget: confirm });
      }],
    ]) {
      refocus = 0;
      const gefragt = [];
      const neu = { querySelector: (sel) => { gefragt.push(sel); return null; }, querySelectorAll: () => [], isConnected: true };
      const zurueck = () => {
        // Die alte Seite wird verlassen, die neue laedt frisch: das Rezept mit
        // beiden Zutaten, die Liste steht.
        page.setContainerForTest(neu);
        page.state.recipes = [rezept()];
        page.state.lists = [{ id: 1, name: 'Wocheneinkauf' }];
        throw err;
      };
      const panel = formular({ '#pantry-match-select': '7', '#plan-date': '20.10.2026', '#plan-type': 'dinner' });
      const { stand } = await mitSeite({}, () => mit({
        get: (path) => (path === '/pantry' ? { data: PANTRY } : { data: [] }),
        put: async () => zurueck(), post: async () => zurueck(),
      }, () => lauf(panel)));
      assert.deepEqual(stand, STAND_VORHER, `${name}: der neue Stand bleibt`);
      assert.deepEqual(gefragt, [], `${name}: in die neue Seite wird nichts gezeichnet`);
      assert.equal(refocus, 0, `${name}: kein Fokus`);
    }
  } finally {
    delete globalThis.__refocusAfterRender;
  }
});

// Codex an #2001: das Zuordnen haengt, der Nutzer schliesst den Dialog,
// bearbeitet das Rezept und speichert - die Zutat steht im gespeicherten
// Stand wieder da. Die spaete "Zutat gibt es nicht mehr"-Antwort darf sie
// diesem NEUEN Stand nicht nehmen.
test('Seite: Zuordnen haengt, das Rezept wird inzwischen gespeichert - die spaete "Zutat weg"-Antwort laesst den gespeicherten Stand stehen', async () => {
  for (const [name, oeffnen, speichernKnopf, panel] of [
    ['einzeln', (r) => page.openPantryMatchModal(r, 'Mehl'), '#pantry-match-save', formular({ '#pantry-match-select': '7' })],
    ['mehrere', (r) => page.openPantryBulkMatchModal(r), '#pantry-bulk-match-save',
      formular({}, { 'select[data-ingredient-index]': [{ ...feld('7'), dataset: { ingredientIndex: '0' } }] })],
  ]) {
    const { stand } = await mitSeite({}, async () => {
      let freigeben;
      const tor = new Promise((r) => { freigeben = r; });
      return mit({
        get: (path) => (path === '/pantry' ? { data: PANTRY } : { data: [] }),
        put: async (path) => {
          if (path.endsWith('/ingredient-match')) { await tor; throw fehler(404, 'recipes_ingredient_not_found'); }
          // Das Speichern des Rezepts: der Server legt Mehl wieder an.
          return { data: rezept({ ingredients: [{ name: 'Mehl', pantry_item_id: null }, { name: 'Salz', pantry_item_id: null }] }) };
        },
      }, async () => {
        await oeffne(panel, () => oeffnen(page.state.recipes[0]));
        const zuordnen = panel.querySelector(speichernKnopf).handlers.click();
        // Waehrend das Zuordnen haengt, speichert der Nutzer das Rezept.
        await page.saveRecipe(formular({ '#recipe-title': 'Suppe' }), 'edit', page.state.recipes[0]);
        freigeben();
        await zuordnen;
      });
    });
    assert.deepEqual(stand.zutaten, ['Mehl', 'Salz'], `${name}: die gespeicherte Zutat bleibt`);
  }
});

// Codex an #2001: der Sonderweg "die GEWAEHLTE Vorratszeile ist weg" laeuft
// am reportError vorbei - er prueft Seite und Dialog genauso, bevor er den
// Vorrat neu holt und den Fokus setzt.
test('Seite: gewaehlte Vorratszeile weg, aber Seite verlassen und zurueck oder Dialog ersetzt - kein frischer Vorrat, kein Fokus', async () => {
  const wege = [
    ['einzeln', (r) => page.openPantryMatchModal(r, 'Mehl'), '#pantry-match-save', () => {
      const panel = formular({ '#pantry-match-select': '8' });
      return { panel, auswahl: [panel.querySelector('#pantry-match-select')] };
    }],
    ['mehrere', (r) => page.openPantryBulkMatchModal(r), '#pantry-bulk-match-save', () => {
      const mehl = { ...feld('8'), dataset: { ingredientIndex: '0' } };
      return { panel: formular({}, { 'select[data-ingredient-index]': [mehl] }), auswahl: [mehl] };
    }],
  ];
  for (const [name, oeffnen, knopf, bau] of wege) {
    for (const art of ['seite', 'dialog']) {
      const { panel, auswahl } = bau();
      let kontext = 'zuordnen';
      globalThis.__modalContextId = () => kontext;
      try {
        const neu = { querySelector: () => null, querySelectorAll: () => [], isConnected: true };
        const { gets } = await mitSeite({}, () => mit({
          get: (path) => (path === '/pantry' ? { data: PANTRY } : { data: [] }),
          put: async () => {
            if (art === 'seite') page.setContainerForTest(neu); else kontext = 'ein-anderer-dialog';
            throw fehler(404, 'recipes_selected_pantry_item_not_found');
          },
        }, async () => {
          await oeffne(panel, () => oeffnen(page.state.recipes[0]));
          await panel.querySelector(knopf).handlers.click();
        }));
        const label = `${name}, ${art}`;
        assert.deepEqual(toasts, [['recipes.errorSelectedPantryItemGone', 'danger']], `${label}: der Satz kommt`);
        assert.equal(gets.filter((p) => p === '/pantry').length, 1, `${label}: kein frischer Vorrat`);
        for (const select of auswahl) {
          assert.equal(select.html, null, `${label}: die Auswahl bleibt`);
          assert.equal(select.focused, 0, `${label}: kein Fokus`);
        }
      } finally {
        delete globalThis.__modalContextId;
      }
    }
  }
});

// Codex an #2001: faellt das letzte Rezept der gewaehlten Quelle weg, gibt es
// die Quelle im Filter nicht mehr - der Filter geht auf "Alle".
test('Seite: das letzte Rezept der gewaehlten Quelle ist weg - der Quellenfilter geht auf "Alle"; bleibt eins, bleibt der Filter', async () => {
  for (const [mealie, erwartet] of [[[6], 'all'], [[6, 7], 'mealie']]) {
    const rezepte = [rezept(), ...mealie.map((id) => rezept({ id, title: `M${id}`, source: 'mealie' }))];
    let filter = null;
    await mitSeite({ recipes: rezepte, sourceFilter: 'mealie' }, async () => {
      await mit({ post: async () => { throw fehler(404, 'recipes_recipe_not_found'); } },
        () => page.transferRecipe(page.state.recipes[1], null));
      filter = page.state.sourceFilter;
    });
    assert.equal(filter, erwartet, `${mealie.length} Mealie-Rezept(e)`);
  }
});

// #1997: die ERFOLGSWEGE. Eine Antwort, die erst kommt, nachdem der Nutzer den
// Dialog geschlossen und einen anderen geoeffnet hat, darf nur den EIGENEN
// schliessen. Ob der Slot noch denselben Dialog haelt, entscheidet
// closeModal({ context }) in components/modal.js (dort am echten Modul
// gemessen, test-modal-dead-time.js); hier zaehlt die Verdrahtung: jeder
// Erfolgsweg reicht den VOR der Anfrage gemerkten Kontext hinein, und die
// Zuordnen-Wege zeichnen nur auf der Seite, die noch steht, und tragen den
// Fokus nur zurueck, wenn es ihr Dialog war, der zuging.
// renderIngredientSections sucht die Abschnitte per CSS.escape; Node kennt es nicht.
globalThis.CSS ??= { escape: (value) => String(value) };

test('Seite: Erfolg nach Dialogwechsel - jeder Erfolgsweg schliesst nur mit dem Kontext von VOR der Anfrage (#1997)', async () => {
  const wege = [
    ['zuordnen', async () => {
      const panel = formular({ '#pantry-match-select': '7' });
      await oeffne(panel, () => page.openPantryMatchModal(page.state.recipes[0], 'Mehl'));
      await panel.querySelector('#pantry-match-save').handlers.click();
    }],
    ['mehrere zuordnen', async () => {
      const mehl = { ...feld('7'), dataset: { ingredientIndex: '0' } };
      const panel = formular({}, { 'select[data-ingredient-index]': [mehl] });
      await oeffne(panel, () => page.openPantryBulkMatchModal(page.state.recipes[0]));
      await panel.querySelector('#pantry-bulk-match-save').handlers.click();
    }],
    ['speichern', () => page.saveRecipe(formular({ '#recipe-title': 'Suppe' }), 'edit', page.state.recipes[0])],
    ['einplanen', async () => {
      const panel = formular({ '#plan-date': '20.10.2026', '#plan-type': 'dinner' });
      await oeffne(panel, () => page.planRecipe(page.state.recipes[0], null));
      const confirm = panel.querySelector('#plan-confirm');
      await confirm.handlers.click({ currentTarget: confirm });
    }],
  ];
  for (const [name, lauf] of wege) {
    let kontext = 'eigener-dialog';
    globalThis.__modalContextId = () => kontext;
    const wechsel = async (antwort) => { kontext = 'ein-anderer-dialog'; return antwort; };
    try {
      const { closed } = await mitSeite({}, () => mit({
        get: (path) => (path === '/pantry' ? { data: PANTRY } : { data: [] }),
        put: (path) => wechsel({ data: path.endsWith('/ingredient-match')
          ? { pantry_item_id: 7, pantry_item_name: 'Mehl' } : rezept() }),
        post: () => wechsel({ data: {} }),
      }, lauf));
      assert.equal(closed.length, 1, `${name}: genau ein Schliessen`);
      assert.equal(closed[0].force, true, `${name}: force wie bisher`);
      assert.equal(closed[0].context, 'eigener-dialog',
        `${name}: geschlossen wird ohne den Kontext von vor der Anfrage - die spaete Antwort traefe den Dialog, der jetzt offen ist`);
      assert.equal(toasts.some(([, art]) => art === 'success'), true, `${name}: der Erfolg wird trotzdem gemeldet`);
    } finally {
      delete globalThis.__modalContextId;
    }
  }
});

test('Seite: Zuordnen-Erfolg - gezeichnet nur auf der Seite, die noch steht; Fokus nur, wenn der eigene Dialog zuging (#1997)', async () => {
  const wege = [
    ['einzeln', async () => {
      const panel = formular({ '#pantry-match-select': '7' });
      await oeffne(panel, () => page.openPantryMatchModal(page.state.recipes[0], 'Mehl'));
      await panel.querySelector('#pantry-match-save').handlers.click();
    }],
    ['mehrere', async () => {
      const mehl = { ...feld('7'), dataset: { ingredientIndex: '0' } };
      const panel = formular({}, { 'select[data-ingredient-index]': [mehl] });
      await oeffne(panel, () => page.openPantryBulkMatchModal(page.state.recipes[0]));
      await panel.querySelector('#pantry-bulk-match-save').handlers.click();
    }],
  ];
  let refocus = 0;
  globalThis.__refocusAfterRender = () => { refocus += 1; };
  try {
    for (const [name, lauf] of wege) {
      // [Fall, Seite bleibt?, eigener Dialog noch offen?, gezeichnet?, Fokus?]
      for (const [fall, seiteBleibt, eigenerOffen, zeichnet, fokus] of [
        ['alles wie vorher', true, true, true, 1],
        ['anderer Dialog offen', true, false, true, 0],
        ['Seite verlassen', false, true, false, 0],
      ]) {
        refocus = 0;
        const gezeichnet = [];
        const seite = {
          querySelector: () => null,
          querySelectorAll: (sel) => { gezeichnet.push(sel); return []; },
          isConnected: true,
        };
        globalThis.__isOwnModalOpen = () => eigenerOffen;
        try {
          await mitSeite({}, async () => {
            page.setContainerForTest(seite);
            await mit({
              get: (path) => (path === '/pantry' ? { data: PANTRY } : { data: [] }),
              put: async () => {
                if (!seiteBleibt) seite.isConnected = false;
                gezeichnet.length = 0;
                return { data: { pantry_item_id: 7, pantry_item_name: 'Mehl' } };
              },
            }, lauf);
          });
        } finally {
          delete globalThis.__isOwnModalOpen;
        }
        const label = `${name}, ${fall}`;
        assert.equal(gezeichnet.some((sel) => sel.includes('recipe-detail__ingredients-section')), zeichnet, `${label}: gezeichnet`);
        assert.equal(refocus, fokus, `${label}: Fokus zurueckgetragen`);
      }
    }
  } finally {
    delete globalThis.__refocusAfterRender;
  }
});
