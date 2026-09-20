/**
 * Modul: Schreiben ueber Modulgrenzen (#1290)
 * Zweck: Die beiden Riegel in server/index.js urteilen am ERSTEN PFADSEGMENT
 *        (`moduleForPath`). Vier Routen der Kueche schreiben aber in ein
 *        ANDERES Modul als das, unter dessen Praefix sie haengen:
 *
 *          POST /meals/:id/to-shopping-list   -> legt shopping_items an
 *          POST /meals/week-to-shopping-list  -> dasselbe fuer eine Woche
 *          POST /recipes/:id/to-shopping-list -> dasselbe (`/recipes` = meals)
 *          PUT  /recipes/:id/ingredient-match -> haengt eine Zeile des VORRATS
 *               dauerhaft in ein Rezept ein (#1314)
 *          POST /shopping/:listId/import-meal-plan -> setzt
 *               meal_ingredients.on_shopping_list, also Essensplan-Daten
 *
 *        Dazu die Ruecknahme `POST /shopping/items/undo-transfer`, die dasselbe
 *        Flag zurueckdreht - aber nur fuer Artikel aus einem Mahlzeit-Uebertrag
 *        (`added_from_meal`), weshalb sie als einzige BEDINGT fragt.
 *
 *        Die Entscheidung: wer in ein Modul schreibt, braucht dessen
 *        Schreibrecht, auf BEIDEN Achsen (Mitgliedsrecht und Token-Scope) und
 *        egal ueber welche Route der Request kommt.
 *
 *        Gemessen wird der EFFEKT, nicht nur der Statuscode: nach einem 403
 *        steht kein Artikel auf der Liste und kein Zutaten-Flag ist gekippt.
 *        Ein Riegel, der erst nach der Transaktion greift, waere sonst gruen.
 *
 *        Die Suite haengt die Router OHNE die Gates aus server/index.js ein -
 *        genau so, wie der Fehler entstand: die Gates lassen diese Aufrufe
 *        durch, weil ihr Pfad auf das falsche Modul zeigt. Was hier prueft, ist
 *        die Route selbst.
 *
 * Ausfuehren: npm run test:cross-module-write
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: mealsRouter } = await import('../server/routes/meals.js');
const { default: recipesRouter } = await import('../server/routes/recipes.js');
const { default: shoppingRouter } = await import('../server/routes/shopping.js');
const { resolvePermissions, buildSessionModuleAccess } = await import('../server/permissions.js');
const db = dbmod.get();

const U = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role, family_role)
  VALUES ('member', 'Member', 'x', 'member', 'child')
`).run().lastInsertRowid;
const LIST = db.prepare(`INSERT INTO shopping_lists (name, created_by) VALUES ('REWE', ?)`).run(U).lastInsertRowid;

// Wie server/auth.js (`applyRoleModuleAccess`) plus die Scope-Achse aus
// `requireAuth`: beide kommen aus derselben Anfrage, also setzt sie auch hier
// EINE Middleware.
let actor = { id: U, scopes: null };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const user = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(actor.id);
  req.authUserId = user.id;
  req.authRole = user.role;
  req.session = { userId: user.id, role: user.role };
  req.authScopes = actor.scopes;
  req.sessionModuleAccess = user.role === 'admin'
    ? null
    : buildSessionModuleAccess(resolvePermissions(db, user));
  next();
});
app.use('/api/v1/meals', mealsRouter);
app.use('/api/v1/recipes', recipesRouter);
app.use('/api/v1/shopping', shoppingRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => { server.close(); });

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* leer */ }
  return { status: res.status, body: json };
}

/** Mitgliedsrechte: gespeicherte Abweichungen, wie sie das Rechte-Blatt schreibt. */
function asMember(modules = {}) {
  db.prepare("DELETE FROM access_permissions WHERE subject_type = 'user' AND subject_id = ?").run(String(U));
  const ins = db.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', ?, ?)
  `);
  for (const [key, level] of Object.entries(modules)) ins.run(String(U), key, level);
  actor = { id: U, scopes: null };
}

/** Token-Scopes: dasselbe Subjekt ohne Rechte-Abweichung, aber gescopt. */
function asToken(scopes) {
  db.prepare("DELETE FROM access_permissions WHERE subject_type = 'user' AND subject_id = ?").run(String(U));
  actor = { id: U, scopes };
}

let dayCounter = 0;
/** Ein frischer Tag je Saat - Wochen- und Bereichs-Import greifen sonst ineinander. */
function nextDate() {
  dayCounter += 1;
  return `2026-03-${String(dayCounter).padStart(2, '0')}`;
}

function seedMeal(ingredientNames = ['Milch', 'Brot'], date = nextDate()) {
  const mealId = db.prepare(`
    INSERT INTO meals (date, meal_type, title, created_by) VALUES (?, 'lunch', 'Pasta', ?)
  `).run(date, U).lastInsertRowid;
  const ins = db.prepare('INSERT INTO meal_ingredients (meal_id, name, quantity) VALUES (?, ?, ?)');
  for (const name of ingredientNames) ins.run(mealId, name, '1');
  return { mealId, date };
}

function seedRecipe(ingredientNames = ['Mehl', 'Hefe']) {
  const recipeId = db.prepare('INSERT INTO recipes (title, created_by) VALUES (?, ?)').run('Brot', U).lastInsertRowid;
  const ins = db.prepare('INSERT INTO recipe_ingredients (recipe_id, name, quantity) VALUES (?, ?, ?)');
  for (const name of ingredientNames) ins.run(recipeId, name, '1');
  return recipeId;
}

const itemCount = () => db.prepare('SELECT COUNT(*) AS c FROM shopping_items WHERE list_id = ?').get(LIST).c;
const openIngredients = (mealId) => db.prepare(
  'SELECT COUNT(*) AS c FROM meal_ingredients WHERE meal_id = ? AND on_shopping_list = 0',
).get(mealId).c;

/** Ein 403 dieser Klasse hat die Form des Pfad-Guards aus server/index.js. */
function assertDeniedShape(res, ziel) {
  assert.equal(res.status, 403, ziel);
  assert.equal(res.body?.code, 403, 'der Code steht auch im Rumpf, wie beim Pfad-Guard');
  assert.equal(typeof res.body?.error, 'string');
}

// =========================================================================
// 0. Vorbedingung
// =========================================================================

// OHNE DIESEN TEST SAGT JEDER 403 WEITER UNTEN NICHTS. Eine Route, die aus
// einem ganz anderen Grund scheitert, saehe genauso aus wie ein greifender
// Riegel.
test('Vorbedingung: mit vollem Recht gehen alle fuenf Wege durch', async () => {
  asMember({});
  const einzel = seedMeal();
  const r1 = await call('POST', `/meals/${einzel.mealId}/to-shopping-list`, { listId: LIST });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.data.transferred, 2);

  const woche = seedMeal(['Butter'], '2026-11-02');
  const r2 = await call('POST', '/meals/week-to-shopping-list', { listId: LIST, week: '2026-11-02' });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.data.transferred, 1);
  assert.equal(openIngredients(woche.mealId), 0);

  const rezept = seedRecipe(['Mehl-frei', 'Hefe-frei']);
  const r3 = await call('POST', `/recipes/${rezept}/to-shopping-list`, { listId: LIST });
  assert.equal(r3.status, 200);
  assert.equal(r3.body.data.transferred, 2);

  const bereich = seedMeal(['Salz'], '2026-04-10');
  const r4 = await call('POST', `/shopping/${LIST}/import-meal-plan`, { from: '2026-04-10', to: '2026-04-10' });
  assert.equal(r4.status, 200);
  assert.equal(r4.body.data.added, 1);
  assert.equal(openIngredients(bereich.mealId), 0);

  const r5 = await call('POST', '/shopping/items/undo-transfer', { ids: r1.body.data.added_ids });
  assert.equal(r5.status, 200);
  assert.equal(r5.body.data.removed, 2);
  assert.equal(openIngredients(einzel.mealId), 2, 'die Ruecknahme dreht auch das Zutaten-Flag zurueck');
});

// =========================================================================
// 1. Mahlzeit und Rezept schreiben in den Einkauf
// =========================================================================

for (const stufe of ['none', 'read']) {
  test(`Mitglied mit shopping: ${stufe} uebertraegt keine Mahlzeit`, async () => {
    asMember({ shopping: stufe });
    const { mealId } = seedMeal();
    const vorher = itemCount();
    const res = await call('POST', `/meals/${mealId}/to-shopping-list`, { listId: LIST });
    assertDeniedShape(res, `shopping: ${stufe} darf nicht in eine Liste schreiben`);
    assert.equal(itemCount(), vorher, 'kein Artikel angelegt');
    assert.equal(openIngredients(mealId), 2, 'kein Zutaten-Flag gekippt');
  });

  test(`Mitglied mit shopping: ${stufe} uebertraegt keine Rezeptzutaten`, async () => {
    asMember({ shopping: stufe });
    const recipeId = seedRecipe();
    const vorher = itemCount();
    const res = await call('POST', `/recipes/${recipeId}/to-shopping-list`, { listId: LIST });
    assertDeniedShape(res, `shopping: ${stufe} darf nicht in eine Liste schreiben`);
    assert.equal(itemCount(), vorher, 'kein Artikel angelegt');
  });
}

test('Mitglied mit shopping: none uebertraegt auch keine ganze Woche', async () => {
  asMember({ shopping: 'none' });
  const { mealId, date } = seedMeal(['Reis'], '2026-12-07');
  const vorher = itemCount();
  const res = await call('POST', '/meals/week-to-shopping-list', { listId: LIST, week: date });
  assertDeniedShape(res, 'der Wochen-Transfer ist derselbe Schreibvorgang, nur groesser');
  assert.equal(itemCount(), vorher);
  assert.equal(openIngredients(mealId), 1);
});

test('Token mit meals:write, aber ohne Einkaufs-Scope, uebertraegt nichts', async () => {
  asToken(['meals:write']);
  const { mealId, date } = seedMeal();
  const recipeId = seedRecipe();
  const vorher = itemCount();

  assertDeniedShape(
    await call('POST', `/meals/${mealId}/to-shopping-list`, { listId: LIST }),
    'Mahlzeit -> Einkauf braucht shopping:write',
  );
  assertDeniedShape(
    await call('POST', '/meals/week-to-shopping-list', { listId: LIST, week: date }),
    'Woche -> Einkauf braucht shopping:write',
  );
  assertDeniedShape(
    await call('POST', `/recipes/${recipeId}/to-shopping-list`, { listId: LIST }),
    'Rezept -> Einkauf braucht shopping:write, obwohl /recipes dem Modul meals gehoert',
  );
  assert.equal(itemCount(), vorher, 'kein Artikel angelegt');
  assert.equal(openIngredients(mealId), 2, 'kein Zutaten-Flag gekippt');
});

test('Token mit beiden Scopes kommt durch', async () => {
  asToken(['meals:write', 'shopping:write']);
  const { mealId } = seedMeal(['Ei']);
  const res = await call('POST', `/meals/${mealId}/to-shopping-list`, { listId: LIST });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.transferred, 1);
});

// =========================================================================
// 1b. Das Rezept haengt eine Vorratszeile ein (#1314)
// =========================================================================

// DIESELBE FRAGE, DAS DRITTE MODUL. `/recipes` gehoert dem Scope-Modul `meals`,
// benannt und dauerhaft eingehaengt wird aber eine Zeile des VORRATS. Der
// Pfad-Guard in server/index.js sieht davon nichts, genau wie beim
// Einkaufs-Uebertrag darueber.
function seedPantryItem(name) {
  return Number(db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, created_by) VALUES (?, 1, 'pcs', ?)",
  ).run(name, U).lastInsertRowid);
}
const matchCount = () => db.prepare('SELECT COUNT(*) AS c FROM recipe_ingredient_pantry_matches').get().c;

test('Vorbedingung: mit vollem Recht laesst sich eine Zutat dem Vorrat zuordnen', async () => {
  asMember({});
  const recipeId = seedRecipe(['Mehl-zuordnung']);
  const item = seedPantryItem('Mehl im Schrank');
  const res = await call('PUT', `/recipes/${recipeId}/ingredient-match`, {
    name: 'Mehl-zuordnung', pantryItemId: item,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.pantry_item_id, item);
});

for (const stufe of ['none', 'read']) {
  test(`Mitglied mit pantry: ${stufe} haengt keine Vorratszeile in ein Rezept`, async () => {
    asMember({});
    const recipeId = seedRecipe([`Zutat-${stufe}`]);
    const item = seedPantryItem(`Glas-${stufe}`);
    const vorher = matchCount();

    asMember({ pantry: stufe });
    const res = await call('PUT', `/recipes/${recipeId}/ingredient-match`, {
      name: `Zutat-${stufe}`, pantryItemId: item,
    });
    assertDeniedShape(res, `pantry: ${stufe} darf keine Vorratszeile einhaengen`);
    assert.equal(matchCount(), vorher, 'keine Zuordnung angelegt');
  });
}

test('Token mit meals:write, aber ohne Vorrats-Scope, ordnet nichts zu', async () => {
  asMember({});
  const recipeId = seedRecipe(['Zutat-Token']);
  const item = seedPantryItem('Dose-Token');
  const vorher = matchCount();

  asToken(['meals:write']);
  const res = await call('PUT', `/recipes/${recipeId}/ingredient-match`, {
    name: 'Zutat-Token', pantryItemId: item,
  });
  assertDeniedShape(res, 'der Pfad sagt /recipes, benannt wird eine Zeile des Vorrats');
  assert.equal(matchCount(), vorher);
});

// =========================================================================
// 2. Die Gegenrichtung: der Einkauf schreibt in den Essensplan
// =========================================================================

for (const stufe of ['none', 'read']) {
  test(`Mitglied mit meals: ${stufe} importiert keinen Essensplan`, async () => {
    asMember({ meals: stufe });
    const { mealId, date } = seedMeal(['Zwiebel']);
    const vorher = itemCount();
    const res = await call('POST', `/shopping/${LIST}/import-meal-plan`, { from: date, to: date });
    assertDeniedShape(res, `meals: ${stufe} darf on_shopping_list nicht setzen`);
    assert.equal(itemCount(), vorher, 'kein Artikel angelegt');
    assert.equal(openIngredients(mealId), 1, 'das Plan-Flag steht unveraendert');
  });
}

test('auch die Vorschau bleibt zu: sie kuendigt genau diesen Schreibvorgang an', async () => {
  asMember({ meals: 'read' });
  const { date } = seedMeal(['Lauch']);
  const res = await call('POST', `/shopping/${LIST}/import-meal-plan`, { from: date, to: date, preview: true });
  assertDeniedShape(res, 'eine rechnende Vorschau vor einem 403 waere eine Zusage, die nicht haelt');
});

test('Token mit shopping:write, aber ohne meals-Scope, importiert nicht', async () => {
  asToken(['shopping:write']);
  const { mealId, date } = seedMeal(['Paprika']);
  const vorher = itemCount();
  const res = await call('POST', `/shopping/${LIST}/import-meal-plan`, { from: date, to: date });
  assertDeniedShape(res, 'der Pfad sagt shopping, geschrieben wird auch im Essensplan');
  assert.equal(itemCount(), vorher);
  assert.equal(openIngredients(mealId), 1);
});

test('Token mit beiden Scopes importiert', async () => {
  asToken(['shopping:write', 'meals:write']);
  const { mealId, date } = seedMeal(['Kuerbis']);
  const res = await call('POST', `/shopping/${LIST}/import-meal-plan`, { from: date, to: date });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.added, 1);
  assert.equal(openIngredients(mealId), 0);
});

// =========================================================================
// 3. Die Ruecknahme fragt nur, wenn sie den Plan anfasst
// =========================================================================

test('Ruecknahme eines Mahlzeit-Uebertrags braucht das Essensplan-Recht', async () => {
  asMember({});
  const { mealId } = seedMeal(['Sellerie']);
  const uebertrag = await call('POST', `/meals/${mealId}/to-shopping-list`, { listId: LIST });
  assert.equal(uebertrag.status, 200);
  const ids = uebertrag.body.data.added_ids;
  assert.equal(openIngredients(mealId), 0, 'Vorbedingung: das Flag steht');

  asMember({ meals: 'read' });
  const res = await call('POST', '/shopping/items/undo-transfer', { ids });
  assertDeniedShape(res, 'die Ruecknahme setzt on_shopping_list zurueck');
  assert.equal(openIngredients(mealId), 0, 'das Flag blieb stehen');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM shopping_items WHERE id = ?').get(ids[0]).c, 1,
    'und der Artikel wurde auch nicht geloescht',
  );
});

test('Ruecknahme ohne Mahlzeit-Herkunft bleibt dem Einkauf erhalten', async () => {
  // Ein Rezept- oder Vorrats-Uebertrag traegt kein `added_from_meal`, ruehrt
  // den Essensplan also nicht an. Eine pauschale Sperre haette dem Einkauf das
  // Undo seiner eigenen Uebertraege genommen.
  asMember({});
  const recipeId = seedRecipe(['Zimt']);
  const uebertrag = await call('POST', `/recipes/${recipeId}/to-shopping-list`, { listId: LIST });
  assert.equal(uebertrag.status, 200);

  asMember({ meals: 'none' });
  const res = await call('POST', '/shopping/items/undo-transfer', { ids: uebertrag.body.data.added_ids });
  assert.equal(res.status, 200, 'kein Essensplan im Spiel, keine Frage danach');
  assert.equal(res.body.data.removed, 1);
});
