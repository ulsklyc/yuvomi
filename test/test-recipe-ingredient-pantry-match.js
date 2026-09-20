/**
 * Modul: Bestaetigte Zuordnung Rezeptzutat -> Vorratszeile (#1314, Stufe 1)
 * Zweck: Die eine Aussage, die der Haushalt selbst trifft - "diese Zutat meint
 *        diese Zeile in meinem Vorrat" - und die Grenze aus docs/DECISIONS.md
 *        Abschnitt 7: sie wird NUR auf Bestaetigung geschrieben, nie geraten,
 *        nie von einem Import.
 *
 * DIE MESSUNG, DIE DAS MODELL BESTIMMT HAT. `recipe_ingredients` wird beim
 * Speichern eines Rezepts KOMPLETT NEU GESCHRIEBEN - `DELETE FROM
 * recipe_ingredients WHERE recipe_id = ?` und danach ein INSERT je Zutat
 * (server/routes/recipes.js, PUT /:id). Der Provider-Sync tut dasselbe
 * (server/services/recipe-provider-sync.js). Eine Zuordnung an
 * `recipe_ingredients.id` waere damit nach jedem Speichern weg, und zwar still.
 * Der Anker ist deshalb (recipe_id, normalisierter Zutatenname) - beides
 * ueberlebt das Neuschreiben, weil die Zeile mit demselben Namen wieder
 * eingefuegt wird.
 *
 * Deshalb steht Test 2 hier zuerst und prueft NICHT die Position in der Liste:
 * eine Zuordnung, die nach einer Umsortierung auf der falschen Zutat sitzt,
 * waere schlimmer als keine.
 *
 * Ausfuehren: npm run test:recipe-pantry-match
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { freshTestDbPath } from './tmp-db.js';

// EINE DATEI, KEIN :memory:. Test 3 fragt, ob die Zuordnung einen Neustart
// ueberlebt, und das laesst sich nur an einer Datenbank messen, die es nach dem
// Schliessen der Verbindung noch gibt.
const DB_FILE = freshTestDbPath('recipe-ingredient-pantry-match');

const dbmod = await import('../server/db.js');
const { default: recipesRouter } = await import('../server/routes/recipes.js');
const { resolvePermissions, buildSessionModuleAccess } = await import('../server/permissions.js');
const db = dbmod.get();

const U = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role, family_role)
  VALUES ('member', 'Member', 'x', 'member', 'child')
`).run().lastInsertRowid;

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
app.use('/api/v1/recipes', recipesRouter);
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

/** Mitgliedsrechte, wie sie das Rechte-Blatt schreibt (vgl. test-cross-module-write-rights.js). */
function asMember(modules = {}) {
  db.prepare("DELETE FROM access_permissions WHERE subject_type = 'user' AND subject_id = ?").run(String(U));
  const ins = db.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', ?, ?)
  `);
  for (const [key, level] of Object.entries(modules)) ins.run(String(U), key, level);
  actor = { id: U, scopes: null };
}

function asToken(scopes) {
  db.prepare("DELETE FROM access_permissions WHERE subject_type = 'user' AND subject_id = ?").run(String(U));
  actor = { id: U, scopes };
}

function seedRecipe(title, ingredients) {
  const recipeId = Number(db.prepare('INSERT INTO recipes (title, created_by) VALUES (?, ?)').run(title, U).lastInsertRowid);
  const ins = db.prepare('INSERT INTO recipe_ingredients (recipe_id, name, quantity, category) VALUES (?, ?, ?, ?)');
  for (const name of ingredients) ins.run(recipeId, name, '1', 'Sonstiges');
  return recipeId;
}

function seedPantry(name) {
  return Number(db.prepare(
    'INSERT INTO pantry_items (name, quantity, unit, created_by) VALUES (?, 2, \'pcs\', ?)',
  ).run(name, U).lastInsertRowid);
}

const matchCount = () => db.prepare('SELECT COUNT(*) AS c FROM recipe_ingredient_pantry_matches').get().c;
const ingredientNames = (recipeId) => db
  .prepare('SELECT name FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id ASC').all(recipeId)
  .map((r) => r.name);

/**
 * Ein Rezept aus der Liste lesen. Der Router hat kein GET /:id - die Liste IST
 * der Leseweg der Oberflaeche, also misst der Test ihn und nicht einen zweiten,
 * den niemand fuehrt.
 */
async function readRecipe(id) {
  const res = await call('GET', '/recipes');
  assert.equal(res.status, 200);
  const found = res.body.data.find((r) => r.id === id);
  assert.ok(found, `Rezept ${id} steht nicht in der Liste`);
  return { status: res.status, body: { data: found } };
}

/** Die Zutat mit diesem Namen aus der gelesenen Rezeptantwort. */
function ingredientOf(body, name) {
  const found = (body?.data?.ingredients || []).find((i) => i.name === name);
  assert.ok(found, `Zutat "${name}" steht nicht in der Antwort`);
  return found;
}

function assertDeniedShape(res, ziel) {
  assert.equal(res.status, 403, ziel);
  assert.equal(res.body?.code, 403, 'der Code steht auch im Rumpf, wie beim Pfad-Guard');
  assert.equal(typeof res.body?.error, 'string');
}

// =========================================================================
// 0. Vorbedingung
// =========================================================================

// OHNE DIESEN TEST SAGT JEDES 403 UND JEDES `null` WEITER UNTEN NICHTS: eine
// Route, die aus einem anderen Grund gar nichts schreibt, saehe genauso aus.
test('Vorbedingung: mit vollem Recht laesst sich eine Zuordnung setzen und lesen', async () => {
  asMember({});
  const recipeId = seedRecipe('Brot', ['Mehl', 'Hefe']);
  const mehlGlas = seedPantry('Weizenmehl 405');

  const res = await call('PUT', `/recipes/${recipeId}/ingredient-match`, { name: 'Mehl', pantryItemId: mehlGlas });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.pantry_item_id, mehlGlas);

  const gelesen = await readRecipe(recipeId);
  assert.equal(ingredientOf(gelesen.body, 'Mehl').pantry_item_id, mehlGlas);
  assert.equal(ingredientOf(gelesen.body, 'Mehl').pantry_item_name, 'Weizenmehl 405');
});

// =========================================================================
// 1. Der Anker: die Zuordnung haengt an der Zutat, nicht an ihrer Zeile
// =========================================================================

test('die Zuordnung ueberlebt ein Speichern, das alle Zutatenzeilen neu schreibt', async () => {
  asMember({});
  const recipeId = seedRecipe('Pfannkuchen', ['Mehl', 'Milch', 'Ei']);
  const milchPackung = seedPantry('H-Milch 1,5%');

  await call('PUT', `/recipes/${recipeId}/ingredient-match`, { name: 'Milch', pantryItemId: milchPackung });
  const idsVorher = db.prepare('SELECT id FROM recipe_ingredients WHERE recipe_id = ?').all(recipeId).map((r) => r.id);

  // Genau der Vorgang, der den ID-Anker zerstoert haette: PUT /recipes/:id
  // loescht alle Zutaten und fuegt sie neu ein - hier zusaetzlich in GEDREHTER
  // Reihenfolge, damit eine Zuordnung ueber die Position sofort auffliegt.
  const gespeichert = await call('PUT', `/recipes/${recipeId}`, {
    title: 'Pfannkuchen',
    ingredients: [{ name: 'Ei' }, { name: 'Milch' }, { name: 'Mehl' }],
  });
  assert.equal(gespeichert.status, 200);

  const idsNachher = db.prepare('SELECT id FROM recipe_ingredients WHERE recipe_id = ?').all(recipeId).map((r) => r.id);
  assert.ok(
    idsNachher.every((id) => !idsVorher.includes(id)),
    'Vorbedingung dieses Tests: das Speichern hat die Zutatenzeilen wirklich ersetzt - '
    + 'sonst misst er den Anker gar nicht',
  );
  assert.deepEqual(ingredientNames(recipeId), ['Ei', 'Milch', 'Mehl'], 'und die Reihenfolge ist gedreht');

  assert.equal(ingredientOf(gespeichert.body, 'Milch').pantry_item_id, milchPackung,
    'die Zuordnung haengt an "Milch", nicht an Zeile 2');
  assert.equal(ingredientOf(gespeichert.body, 'Mehl').pantry_item_id, null);
  assert.equal(ingredientOf(gespeichert.body, 'Ei').pantry_item_id, null);
});

test('die Zuordnung ueberlebt einen Neustart', async () => {
  asMember({});
  const recipeId = seedRecipe('Griessbrei', ['Griess']);
  const griessTuete = seedPantry('Weichweizengriess');
  await call('PUT', `/recipes/${recipeId}/ingredient-match`, { name: 'Griess', pantryItemId: griessTuete });

  // Eine ZWEITE, unabhaengige Verbindung auf dieselbe Datei. Aus derselben
  // Verbindung zu lesen belegte nur, dass die Anweisung lief.
  const zweite = new DatabaseSync(DB_FILE, { readOnly: true });
  try {
    const row = zweite.prepare(
      'SELECT pantry_item_id FROM recipe_ingredient_pantry_matches WHERE recipe_id = ?',
    ).get(recipeId);
    assert.equal(row?.pantry_item_id, griessTuete, 'die Zuordnung steht auf der Platte, nicht im Prozess');
  } finally {
    zweite.close();
  }
});

// =========================================================================
// 2. Nie geraten: kein Import und kein Speichern setzt eine Zuordnung
// =========================================================================

test('ein Rezept anlegen setzt nie eine Zuordnung, auch bei gleichem Namen', async () => {
  asMember({});
  seedPantry('Zucker');
  const vorher = matchCount();
  const res = await call('POST', '/recipes', { title: 'Kuchen', ingredients: [{ name: 'Zucker' }] });
  assert.equal(res.status, 201);
  assert.equal(matchCount(), vorher, 'ein identischer Name ist eine Namensaehnlichkeit, keine Aussage des Haushalts');
  assert.equal(ingredientOf(res.body, 'Zucker').pantry_item_id, null);
});

test('ein Rezept aktualisieren setzt nie eine Zuordnung', async () => {
  asMember({});
  seedPantry('Salz');
  const recipeId = seedRecipe('Suppe', ['Wasser']);
  const vorher = matchCount();
  const res = await call('PUT', `/recipes/${recipeId}`, { title: 'Suppe', ingredients: [{ name: 'Salz' }] });
  assert.equal(res.status, 200);
  assert.equal(matchCount(), vorher);
  assert.equal(ingredientOf(res.body, 'Salz').pantry_item_id, null);
});

test('der Provider-Sync schreibt die Zuordnungstabelle nirgends an', () => {
  // Ein Spiegel-Lauf schreibt Zutaten genauso neu wie PUT /recipes/:id. Er darf
  // sie anfassen - aber die Zuordnungstabelle nie, in keiner Richtung ausser
  // dem Loeschen, das der FK ohnehin erledigt.
  const quelle = readFileSync(new URL('../server/services/recipe-provider-sync.js', import.meta.url), 'utf8');
  assert.equal(
    /recipe_ingredient_pantry_matches/.test(quelle), false,
    'server/services/recipe-provider-sync.js nennt die Zuordnungstabelle - ein Import darf sie nie setzen '
    + '(docs/DECISIONS.md Abschnitt 7)',
  );
});

// =========================================================================
// 3. Was das Loeschen der Vorratszeile tut
// =========================================================================

test('die Vorratszeile zu loeschen nimmt die Zuordnung mit und laesst die Zutat stehen', async () => {
  asMember({});
  const recipeId = seedRecipe('Risotto', ['Reis', 'Brühe']);
  const reisPackung = seedPantry('Risottoreis');
  await call('PUT', `/recipes/${recipeId}/ingredient-match`, { name: 'Reis', pantryItemId: reisPackung });
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM recipe_ingredient_pantry_matches WHERE pantry_item_id = ?').get(reisPackung).c,
    1, 'Vorbedingung: die Zuordnung steht',
  );

  db.prepare('DELETE FROM pantry_items WHERE id = ?').run(reisPackung);

  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM recipe_ingredient_pantry_matches WHERE pantry_item_id = ?').get(reisPackung).c,
    0, 'die Aussage galt genau dieser Zeile - ohne sie zeigt sie ins Leere',
  );
  assert.deepEqual(ingredientNames(recipeId), ['Reis', 'Brühe'],
    'aber die Zutat bleibt: eine Zuordnung, die das Rezept mitreisst, waere schlimmer als keine');

  const gelesen = await readRecipe(recipeId);
  assert.equal(ingredientOf(gelesen.body, 'Reis').pantry_item_id, null,
    'und die Zutat ist wieder unbekannt, nicht kaputt');
});

// =========================================================================
// 4. Der Rechteweg: der Weg haengt unter /recipes und greift in den Vorrat
// =========================================================================

for (const stufe of ['none', 'read']) {
  test(`Mitglied mit pantry: ${stufe} setzt keine Zuordnung`, async () => {
    asMember({});
    const recipeId = seedRecipe(`Gericht-${stufe}`, ['Butter']);
    const butter = seedPantry(`Butter-${stufe}`);
    const vorher = matchCount();

    asMember({ pantry: stufe });
    const res = await call('PUT', `/recipes/${recipeId}/ingredient-match`, { name: 'Butter', pantryItemId: butter });
    assertDeniedShape(res, `pantry: ${stufe} darf keine Vorratszeile in ein Rezept einhaengen`);
    assert.equal(matchCount(), vorher, 'und es steht auch keine Zuordnung in der Tabelle');
  });
}

test('Token mit meals:write, aber ohne Vorrats-Scope, setzt keine Zuordnung', async () => {
  asMember({});
  const recipeId = seedRecipe('Nudeln', ['Nudeln']);
  const packung = seedPantry('Spaghetti 500g');
  const vorher = matchCount();

  asToken(['meals:write']);
  const res = await call('PUT', `/recipes/${recipeId}/ingredient-match`, { name: 'Nudeln', pantryItemId: packung });
  assertDeniedShape(res, 'der Pfad sagt /recipes, benannt wird eine Zeile des Vorrats');
  assert.equal(matchCount(), vorher);
});

test('Token mit beiden Scopes kommt durch', async () => {
  const recipeId = seedRecipe('Pesto', ['Basilikum']);
  const topf = seedPantry('Basilikum im Topf');
  asToken(['meals:write', 'pantry:write']);
  const res = await call('PUT', `/recipes/${recipeId}/ingredient-match`, { name: 'Basilikum', pantryItemId: topf });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.pantry_item_id, topf);
});

test('das Loesen einer Zuordnung braucht dasselbe Recht wie das Setzen', async () => {
  asMember({});
  const recipeId = seedRecipe('Kartoffelsalat', ['Kartoffeln']);
  const netz = seedPantry('Kartoffeln 2,5kg');
  await call('PUT', `/recipes/${recipeId}/ingredient-match`, { name: 'Kartoffeln', pantryItemId: netz });

  asMember({ pantry: 'read' });
  const res = await call('PUT', `/recipes/${recipeId}/ingredient-match`, { name: 'Kartoffeln', pantryItemId: null });
  assertDeniedShape(res, 'eine Zuordnung zu loesen ist derselbe Schreibvorgang, nur rueckwaerts');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM recipe_ingredient_pantry_matches WHERE pantry_item_id = ?').get(netz).c,
    1, 'die Zuordnung steht unveraendert',
  );
});

// =========================================================================
// 4b. Der LESEWEG traegt dasselbe Recht wie der Schreibweg
// =========================================================================

/*
 * DERSELBE BEFUND WIE BEI DEN GEBURTSTAGEN (server/routes/birthdays.js): der
 * Pfad sagt `/recipes` und loest auf das Scope-Modul `meals` auf, der Inhalt
 * nennt eine Zeile des VORRATS. Der Riegel in server/index.js urteilt am ersten
 * Pfadsegment und fragt nie nach `pantry` - wer die Zutat lesen darf, bekam
 * `pantry_item_name` mitgeliefert, egal was seine Vorratsrechte sagen. Das
 * Verstecken in `pantryMatchEl()` (public/pages/recipes.js) ist eine
 * Darstellungsentscheidung, keine Zugriffskontrolle: GET /api/v1/recipes
 * beantwortet die Frage direkt.
 *
 * DIE PROBE LAEUFT GEGEN DIE ROUTE, NICHT GEGEN `attachPantryMatches`. Der
 * Helfer liesse sich einzeln richtigstellen und die Verdrahtung trotzdem
 * vergessen - beide Aufrufer bekamen `req` bisher gar nicht zu sehen
 * (`router.get('/', (_req, res) => ...)`). Und sie braucht BEIDE Achsen:
 * Mitgliedsrecht UND Token-Scope. Ein ungeprueft gebliebener Token-Weg ist
 * genau die Luecke aus #1290.
 */

/** Setzt eine Zuordnung mit vollem Recht und gibt Rezept-ID und Vorratszeile zurueck. */
async function seedMatch(titel, zutat, vorrat) {
  asMember({});
  const recipeId = seedRecipe(titel, [zutat, 'Salz']);
  const itemId = seedPantry(vorrat);
  const res = await call('PUT', `/recipes/${recipeId}/ingredient-match`, { name: zutat, pantryItemId: itemId });
  assert.equal(res.status, 200, 'Vorbedingung: die Zuordnung steht');
  return { recipeId, itemId };
}

test('Mitglied mit pantry: read sieht die Zuordnung weiter', async () => {
  // OHNE DIESEN TEST SAGT JEDES `null` WEITER UNTEN NICHTS: ein Filter, der
  // die Zuordnung IMMER leert, saehe an der gesperrten Stelle genauso aus.
  // Und nur `none` ist eine Sperre - wer lesen darf, darf lesen.
  const { recipeId, itemId } = await seedMatch('Bruschetta', 'Tomaten', 'Dosentomaten');

  asMember({ pantry: 'read' });
  const gelesen = await readRecipe(recipeId);
  assert.equal(ingredientOf(gelesen.body, 'Tomaten').pantry_item_id, itemId);
  assert.equal(ingredientOf(gelesen.body, 'Tomaten').pantry_item_name, 'Dosentomaten');
});

test('Mitglied mit pantry: none bekommt die Zuordnung aus GET /recipes nicht', async () => {
  const { recipeId } = await seedMatch('Chili', 'Bohnen', 'Kidneybohnen 400g');

  asMember({ pantry: 'none' });
  const gelesen = await readRecipe(recipeId);
  const bohnen = ingredientOf(gelesen.body, 'Bohnen');
  assert.equal(bohnen.pantry_item_id, null, 'die ID benennt eine Vorratszeile, die dieses Mitglied nicht sehen darf');
  assert.equal(bohnen.pantry_item_name, null, 'und der Name ist der Inhalt dieser Zeile');
  // Die Zutat selbst gehoert zum Rezept und bleibt.
  assert.equal(bohnen.name, 'Bohnen', 'das Rezept selbst bleibt lesbar - gesperrt ist der Vorrat, nicht das Essen');
});

test('Mitglied mit pantry: none bekommt die Zuordnung auch aus der Antwort auf PUT /recipes/:id nicht', async () => {
  // Der zweite Aufrufer von `attachPantryMatches`: `loadRecipeWithIngredients`
  // beantwortet POST und PUT. Ein Mitglied mit `pantry: none` darf Rezepte
  // speichern (das ist `meals`) und bekaeme die Zuordnung in der Antwort
  // zurueck - derselbe Inhalt, anderer Weg.
  const { recipeId } = await seedMatch('Gulasch', 'Paprika', 'Paprikapulver edelsuess');

  asMember({ pantry: 'none' });
  const gespeichert = await call('PUT', `/recipes/${recipeId}`, {
    title: 'Gulasch',
    ingredients: [{ name: 'Paprika' }, { name: 'Salz' }],
  });
  assert.equal(gespeichert.status, 200, 'Vorbedingung: das Speichern selbst ist erlaubt');
  assert.equal(ingredientOf(gespeichert.body, 'Paprika').pantry_item_id, null);
  assert.equal(ingredientOf(gespeichert.body, 'Paprika').pantry_item_name, null);
});

test('Token mit meals:read und pantry:read sieht die Zuordnung', async () => {
  // Die Vorbedingung der Token-Achse, aus demselben Grund wie oben.
  const { recipeId, itemId } = await seedMatch('Pizza', 'Mozzarella', 'Mozzarella 125g');

  asToken(['meals:read', 'pantry:read']);
  const gelesen = await readRecipe(recipeId);
  assert.equal(ingredientOf(gelesen.body, 'Mozzarella').pantry_item_id, itemId);
  assert.equal(ingredientOf(gelesen.body, 'Mozzarella').pantry_item_name, 'Mozzarella 125g');
});

test('Token mit meals:read, aber ohne Vorrats-Scope, bekommt die Zuordnung nicht', async () => {
  const { recipeId } = await seedMatch('Lasagne', 'Bechamel', 'Bechamelsauce Glas');

  asToken(['meals:read']);
  const gelesen = await readRecipe(recipeId);
  const bechamel = ingredientOf(gelesen.body, 'Bechamel');
  assert.equal(bechamel.pantry_item_id, null,
    'ein Token mit meals:read nennt den Vorrat nicht - es kommt am Pfad-Riegel vorbei, nicht an dieser Frage');
  assert.equal(bechamel.pantry_item_name, null);
  assert.equal(bechamel.name, 'Bechamel', 'das Rezept selbst darf es lesen');
});


// =========================================================================
// 5. Unbekannt, nicht fehlend
// =========================================================================

test('eine nicht zugeordnete Zutat kommt als unbekannt zurueck, nicht als fehlend', async () => {
  asMember({});
  const recipeId = seedRecipe('Omelett', ['Eier', 'Schnittlauch']);
  const eier = seedPantry('Eier 10er');
  await call('PUT', `/recipes/${recipeId}/ingredient-match`, { name: 'Eier', pantryItemId: eier });

  const gelesen = await readRecipe(recipeId);
  const schnittlauch = ingredientOf(gelesen.body, 'Schnittlauch');
  assert.equal(schnittlauch.pantry_item_id, null);
  assert.equal(schnittlauch.pantry_item_name, null);
  // KEIN Vorrats-Urteil auf der Zutat. Stufe 1 weiss nur, worauf der Haushalt
  // gezeigt hat; jedes `available`/`missing` hier waere eine Auskunft ueber
  // Bestand, die niemand gegeben hat (docs/DECISIONS.md Abschnitt 7,
  // "What counts as undoing it").
  for (const verboten of ['missing', 'available', 'in_stock', 'have']) {
    assert.equal(verboten in schnittlauch, false,
      `Stufe 1 gibt kein "${verboten}" heraus - unbekannt ist nicht fehlend`);
  }
});

test('auch die Liste traegt den Unterschied, nicht nur das einzelne Rezept', async () => {
  asMember({});
  const recipeId = seedRecipe('Bratkartoffeln', ['Kartoffeln', 'Zwiebel']);
  const netz = seedPantry('Kartoffeln festkochend');
  await call('PUT', `/recipes/${recipeId}/ingredient-match`, { name: 'Kartoffeln', pantryItemId: netz });

  const liste = await call('GET', '/recipes');
  const rezept = liste.body.data.find((r) => r.id === recipeId);
  assert.ok(rezept, 'das Rezept steht in der Liste');
  assert.equal(rezept.ingredients.find((i) => i.name === 'Kartoffeln').pantry_item_id, netz);
  assert.equal(rezept.ingredients.find((i) => i.name === 'Zwiebel').pantry_item_id, null);
});

test('die Oberflaeche nennt den unzugeordneten Zustand unbekannt, nicht fehlend', () => {
  // Die Grenze aus docs/DECISIONS.md Abschnitt 7 endet nicht an der API: "and
  // presenting an unmatched ingredient as missing rather than unknown" steht
  // dort unter "What counts as undoing it". Ein Wort wie "fehlt" macht aus
  // einer Teilauskunft eine vollstaendige.
  const de = JSON.parse(readFileSync(new URL('../public/locales/de.json', import.meta.url), 'utf8'));
  const text = de.recipes?.ingredientMatchNone;
  assert.equal(typeof text, 'string', 'recipes.ingredientMatchNone fehlt in public/locales/de.json');
  assert.match(text, /nicht zugeordnet|unbekannt/i, `"${text}" benennt den Zustand nicht als unbekannt`);
  assert.doesNotMatch(text, /fehlt|fehlend|nicht vorhanden|nicht da/i,
    `"${text}" liest sich wie eine Auskunft ueber den Bestand - Stufe 1 gibt keine`);

  const seite = readFileSync(new URL('../public/pages/recipes.js', import.meta.url), 'utf8');
  assert.match(seite, /recipes\.ingredientMatchNone/,
    'public/pages/recipes.js zeigt den unzugeordneten Zustand nicht an');
});
