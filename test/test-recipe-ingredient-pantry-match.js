/**
 * Modul: Bestaetigte Zuordnung Rezeptzutat -> Produkt des Haushalts (#1314, #1448 Teil 4)
 * Zweck: Die eine Aussage, die der Haushalt selbst trifft - "diese Schreibweise
 *        meint dieses Produkt in meinem Vorrat" - und die Grenze aus
 *        docs/DECISIONS.md Abschnitt 7: sie wird NUR auf Bestaetigung
 *        geschrieben, nie geraten, nie von einem Import.
 *
 * SEIT TEIL 4 VON #1448 GILT SIE FUER DEN HAUSHALT. `pantry_product_matches`
 * haengt am normalisierten Zutatennamen allein: einmal bestaetigt, steht sie an
 * jedem Rezept mit derselben Schreibweise, und weil sie ein PRODUKT nennt und
 * keine Charge, nimmt das Aufbrauchen der letzten Packung sie nicht mit. Ein
 * Speichern des Rezepts und ein Spiegel-Lauf loeschen sie nicht mehr: sie
 * gehoert keinem Rezept.
 *
 * DIE MESSUNG, DIE DAS MODELL BESTIMMT HAT, BLEIBT. `recipe_ingredients` wird
 * beim Speichern eines Rezepts KOMPLETT NEU GESCHRIEBEN (server/routes/recipes.js,
 * PUT /:id), der Provider-Sync tut dasselbe. Eine Zuordnung an
 * `recipe_ingredients.id` waere nach jedem Speichern weg, und zwar still. Der
 * Anker ist deshalb der normalisierte Name.
 *
 * Gefahren wird ueber die echten Router (recipes und pantry), an ihrem echten
 * Praefix: validateRequest() liest die Operation am Mount.
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

// EINE DATEI, KEIN :memory:. Ein Test fragt, ob die Zuordnung einen Neustart
// ueberlebt, und das laesst sich nur an einer Datenbank messen, die es nach dem
// Schliessen der Verbindung noch gibt.
const DB_FILE = freshTestDbPath('recipe-ingredient-pantry-match');

const dbmod = await import('../server/db.js');
const { default: recipesRouter } = await import('../server/routes/recipes.js');
const { default: pantryRouter } = await import('../server/routes/pantry.js');
const { defaultEmptyBody } = await import('../server/middleware/empty-body.js');
const { createErrorHandler } = await import('../server/middleware/error-handler.js');
const { assignPantryProduct } = await import('../server/services/pantry-products.js');
const { resolvePermissions, buildSessionModuleAccess } = await import('../server/authorize/index.ts');
const db = dbmod.get();

const U = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role, family_role)
  VALUES ('member', 'Member', 'x', 'member', 'child')
`).run().lastInsertRowid;

// A second member: who confirmed last is recorded (confirmed_by).
const U2 = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role, family_role)
  VALUES ('partner', 'Partner', 'x', 'member', 'parent')
`).run().lastInsertRowid;

let actor = { id: U, scopes: null };
const app = express();
app.use(express.json());
app.use(defaultEmptyBody);
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
app.use('/api/v1/pantry', pantryRouter);
app.use(createErrorHandler({ warn: () => {}, error: () => {} }));
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

/**
 * Eine Charge mit ihrem Produkt, wie jeder Schreibweg sie anlegt. Ohne Ort:
 * gibt es dasselbe Produkt schon, kommt die Charge dazu.
 * @param {string} name
 * @param {{ unit?: string, quantity?: number }} [options]
 * @returns {{ item: number, product: number }}
 */
function seedPantry(name, { unit = 'pcs', quantity = 2 } = {}) {
  const item = Number(db.prepare(
    'INSERT INTO pantry_items (name, quantity, unit, created_by) VALUES (?, ?, ?, ?)',
  ).run(name, quantity, unit, U).lastInsertRowid);
  // The batch was just written, so it has a product.
  return { item, product: /** @type {number} */ (assignPantryProduct(db, item, { userId: U })) };
}

const matchCount = () => db.prepare('SELECT COUNT(*) AS c FROM pantry_product_matches').get().c;
const matchOf = (/** @type {string} */ key) => db.prepare('SELECT product_id, confirmed_by FROM pantry_product_matches WHERE ingredient_key = ?').get(key);
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

const confirm = (/** @type {number} */ recipeId, /** @type {string} */ name, /** @type {number|null} */ pantryProductId) =>
  call('PUT', `/recipes/${recipeId}/ingredient-match`, { name, pantryProductId });

// =========================================================================
// 0. Vorbedingung
// =========================================================================

// OHNE DIESEN TEST SAGT JEDES 403 UND JEDES `null` WEITER UNTEN NICHTS: eine
// Route, die aus einem anderen Grund gar nichts schreibt, saehe genauso aus.
test('Vorbedingung: mit vollem Recht laesst sich eine Zuordnung auf ein Produkt setzen und lesen', async () => {
  asMember({});
  const recipeId = seedRecipe('Brot', ['Mehl', 'Hefe']);
  const mehl = seedPantry('Weizenmehl 405');

  const res = await confirm(recipeId, 'Mehl', mehl.product);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, {
    name: 'Mehl', ingredient_key: 'mehl',
    pantry_product_id: mehl.product, pantry_product_name: 'Weizenmehl 405',
    pantry_item_id: mehl.item, pantry_item_name: 'Weizenmehl 405',
  });

  const gelesen = ingredientOf((await readRecipe(recipeId)).body, 'Mehl');
  assert.equal(gelesen.pantry_product_id, mehl.product);
  assert.equal(gelesen.pantry_product_name, 'Weizenmehl 405');
  assert.equal(gelesen.pantry_item_id, mehl.item, 'die abgekuendigten Felder nennen eine Charge des Produkts');
  assert.equal(gelesen.pantry_item_name, 'Weizenmehl 405');
  assert.deepEqual(matchOf('mehl'), { product_id: mehl.product, confirmed_by: Number(U) });
});

// =========================================================================
// 1. Der Anker: die Zuordnung haengt an der Schreibweise, nicht an einer Zeile
// =========================================================================

test('die Zuordnung ueberlebt ein Speichern, das alle Zutatenzeilen neu schreibt', async () => {
  asMember({});
  const recipeId = seedRecipe('Pfannkuchen', ['Mehl', 'Milch', 'Ei']);
  const milch = seedPantry('H-Milch 1,5%');

  await confirm(recipeId, 'Milch', milch.product);
  const idsVorher = db.prepare('SELECT id FROM recipe_ingredients WHERE recipe_id = ?').all(recipeId).map((r) => r.id);

  // Genau der Vorgang, der den ID-Anker zerstoert haette: PUT /recipes/:id
  // loescht alle Zutaten und fuegt sie neu ein - hier zusaetzlich in GEDREHTER
  // Reihenfolge, damit eine Zuordnung ueber die Position sofort auffliegt.
  const gespeichert = await call('PUT', `/recipes/${recipeId}`, {
    title: 'Pfannkuchen',
    ingredients: [{ name: 'Ei' }, { name: 'Milch' }, { name: 'Zucker' }],
  });
  assert.equal(gespeichert.status, 200);

  const idsNachher = db.prepare('SELECT id FROM recipe_ingredients WHERE recipe_id = ?').all(recipeId).map((r) => r.id);
  assert.ok(
    idsNachher.every((id) => !idsVorher.includes(id)),
    'Vorbedingung dieses Tests: das Speichern hat die Zutatenzeilen wirklich ersetzt - '
    + 'sonst misst er den Anker gar nicht',
  );
  assert.deepEqual(ingredientNames(recipeId), ['Ei', 'Milch', 'Zucker'], 'und die Reihenfolge ist gedreht');

  assert.equal(ingredientOf(gespeichert.body, 'Milch').pantry_product_id, milch.product,
    'die Zuordnung haengt an "Milch", nicht an Zeile 2');
  assert.equal(ingredientOf(gespeichert.body, 'Zucker').pantry_product_id, null);
  assert.equal(ingredientOf(gespeichert.body, 'Ei').pantry_product_id, null);
});

test('die Zuordnung ueberlebt einen Neustart', async () => {
  asMember({});
  const recipeId = seedRecipe('Griessbrei', ['Griess']);
  const griess = seedPantry('Weichweizengriess');
  await confirm(recipeId, 'Griess', griess.product);

  // Eine ZWEITE, unabhaengige Verbindung auf dieselbe Datei. Aus derselben
  // Verbindung zu lesen belegte nur, dass die Anweisung lief.
  const zweite = new DatabaseSync(DB_FILE, { readOnly: true });
  try {
    const row = zweite.prepare('SELECT product_id FROM pantry_product_matches WHERE ingredient_key = ?').get('griess');
    assert.equal(row?.product_id, griess.product, 'die Zuordnung steht auf der Platte, nicht im Prozess');
  } finally {
    zweite.close();
  }
});

// =========================================================================
// 2. Fuer den Haushalt: einmal bestaetigt, in jedem Rezept
// =========================================================================

test('einmal bestaetigt, steht die Zuordnung in jedem Rezept mit derselben Schreibweise', async () => {
  asMember({});
  const tomaten = seedPantry('Dosentomaten gehackt');
  const sosse = seedRecipe('Tomatensosse', ['Gehackte Tomaten', 'Zwiebel']);
  const chili = seedRecipe('Chili', ['  gehackte   TOMATEN ', 'Bohnen']);
  await confirm(sosse, 'Gehackte Tomaten', tomaten.product);

  const nachbar = ingredientOf((await readRecipe(chili)).body, '  gehackte   TOMATEN ');
  assert.equal(nachbar.pantry_product_id, tomaten.product,
    'dieselbe Schreibweise (getrimmt, Leerraum gefaltet, klein) meint dasselbe Produkt - im anderen Rezept ohne neue Bestaetigung');
  assert.equal(nachbar.pantry_product_name, 'Dosentomaten gehackt');
  assert.equal(ingredientOf((await readRecipe(chili)).body, 'Bohnen').pantry_product_id, null,
    'eine andere Schreibweise bleibt unbekannt');

  // Und ein Rezept, das ERST DANACH entsteht, liest sie ebenso.
  const spaeter = await call('POST', '/recipes', { title: 'Shakshuka', ingredients: [{ name: 'gehackte Tomaten' }] });
  assert.equal(spaeter.status, 201);
  assert.equal(ingredientOf(spaeter.body, 'gehackte Tomaten').pantry_product_id, tomaten.product);
  assert.equal(matchCount(), db.prepare('SELECT COUNT(DISTINCT ingredient_key) AS c FROM pantry_product_matches').get().c,
    'eine Zeile je Schreibweise');
});

test('ein erneutes Bestaetigen aus einem anderen Rezept ersetzt die Aussage, das Loesen loest sie ueberall', async () => {
  asMember({});
  const reis = seedPantry('Basmati');
  const jasmin = seedPantry('Jasminreis');
  const curry = seedRecipe('Curry', ['Reis']);
  const pfanne = seedRecipe('Reispfanne', ['Reis']);
  await confirm(curry, 'Reis', reis.product);
  const vorher = matchCount();

  assert.equal(matchOf('reis')?.confirmed_by, Number(U));
  // Re-confirmed by the other member: the statement and its author are replaced.
  actor = { id: U2, scopes: null };
  const neu = await confirm(pfanne, 'reis', jasmin.product);
  actor = { id: U, scopes: null };
  assert.equal(neu.status, 200);
  assert.equal(matchOf('reis')?.confirmed_by, Number(U2), 'confirmed_by names who confirmed last');
  assert.equal(neu.body.data.name, 'Reis', 'der Name, wie DIESES Rezept ihn schreibt');
  assert.equal(matchCount(), vorher, 'ersetzt, nicht daneben gelegt');
  assert.equal(ingredientOf((await readRecipe(curry)).body, 'Reis').pantry_product_id, jasmin.product,
    'auch das erste Rezept liest jetzt die neue Aussage');

  const geloest = await call('PUT', `/recipes/${curry}/ingredient-match`, { name: 'Reis', pantryProductId: null });
  assert.equal(geloest.status, 200);
  assert.equal(geloest.body.data.pantry_product_id, null);
  assert.equal(matchOf('reis'), undefined);
  assert.equal(ingredientOf((await readRecipe(pfanne)).body, 'Reis').pantry_product_id, null,
    'geloest fuer den Haushalt, also auch im anderen Rezept');
});

// =========================================================================
// 3. Nie geraten: kein Import und kein Speichern setzt eine Zuordnung
// =========================================================================

test('ein Rezept anlegen setzt nie eine Zuordnung, auch bei gleichem Namen', async () => {
  asMember({});
  seedPantry('Zucker');
  const vorher = matchCount();
  const res = await call('POST', '/recipes', { title: 'Kuchen', ingredients: [{ name: 'Zucker' }] });
  assert.equal(res.status, 201);
  assert.equal(matchCount(), vorher, 'ein identischer Name ist eine Namensaehnlichkeit, keine Aussage des Haushalts');
  assert.equal(ingredientOf(res.body, 'Zucker').pantry_product_id, null);
});

test('ein Rezept aktualisieren setzt nie eine Zuordnung', async () => {
  asMember({});
  seedPantry('Salz');
  const recipeId = seedRecipe('Suppe', ['Wasser']);
  const vorher = matchCount();
  const res = await call('PUT', `/recipes/${recipeId}`, { title: 'Suppe', ingredients: [{ name: 'Salz' }] });
  assert.equal(res.status, 200);
  assert.equal(matchCount(), vorher);
  assert.equal(ingredientOf(res.body, 'Salz').pantry_product_id, null);
});

/*
 * KEIN ABRAEUMEN MEHR BEIM SPEICHERN (#1448, Teil 4). Bis dahin loeschte
 * PUT /recipes/:id die Zuordnung einer Zutat, die das Rezept nicht mehr trug:
 * eine spaeter wieder auftauchende Schreibweise haette sonst eine Bestaetigung
 * zurueckbekommen, die fuer DIESES Rezept niemand gegeben hatte. Jetzt hat der
 * Haushalt die Schreibweise bestaetigt, nicht das Rezept - genau das ist die
 * Aussage, und sie bleibt.
 */
test('eine Zutat umzubenennen loescht die Zuordnung nicht mehr, und der alte Name bekommt sie zurueck', async () => {
  asMember({});
  const recipeId = seedRecipe('Waffeln', ['Mehl', 'Zucker']);
  const mehl = seedPantry('Weizenmehl Type 550');
  await confirm(recipeId, 'Mehl', mehl.product);

  const umbenannt = await call('PUT', `/recipes/${recipeId}`, {
    title: 'Waffeln',
    ingredients: [{ name: 'Dinkelmehl' }, { name: 'Zucker' }],
  });
  assert.equal(umbenannt.status, 200);
  assert.equal(matchOf('mehl')?.product_id, mehl.product, 'die Aussage des Haushalts gehoert keinem Rezept');
  assert.equal(ingredientOf(umbenannt.body, 'Dinkelmehl').pantry_product_id, null,
    'und die umbenannte Zutat erbt sie nicht: Dinkelmehl ist eine andere Schreibweise');

  const zurueck = await call('PUT', `/recipes/${recipeId}`, { title: 'Waffeln', ingredients: [{ name: 'Mehl' }] });
  assert.equal(ingredientOf(zurueck.body, 'Mehl').pantry_product_id, mehl.product,
    'dieselbe Schreibweise meint, was der Haushalt bestaetigt hat');
});

test('ein Mitglied ohne Vorratsrechte kann ein Rezept speichern, und die Zuordnung bleibt', async () => {
  // Speichern ist kein Eingriff in den Vorrat - weder frueher (das Abraeumen
  // brauchte kein Vorratsrecht) noch jetzt, wo es gar nichts mehr abraeumt.
  asMember({});
  const recipeId = seedRecipe('Haferkekse', ['Haferflocken']);
  const glas = seedPantry('Haferflocken zart');
  await confirm(recipeId, 'Haferflocken', glas.product);

  asMember({ pantry: 'none' });
  const res = await call('PUT', `/recipes/${recipeId}`, { title: 'Haferkekse', ingredients: [{ name: 'Dinkelflocken' }] });
  assert.equal(res.status, 200, 'das Rezept gehoert dem Modul meals, nicht dem Vorrat');
  assert.equal(matchOf('haferflocken')?.product_id, glas.product);
});

test('der Provider-Sync fasst keine Zuordnungstabelle an, weder die alte noch die neue', () => {
  /*
   * Bis Teil 4 raeumte der Spiegel-Lauf die Zuordnungen umbenannter Zutaten ab
   * und durfte die Tabelle deshalb lesend und loeschend nennen. Jetzt gehoert
   * eine Zuordnung keinem Rezept, und ein Import schreibt nie eine: die Datei
   * nennt keine der beiden Tabellen mehr ausserhalb von Kommentaren.
   *
   * Die eigentliche Zusage misst nicht dieser Test, sondern ein Lauf:
   * test/test-recipe-provider-sync.js fuehrt sync() aus und prueft, dass ein
   * identischer Name keine Zuordnung anlegt und eine umbenannte Zutat keine
   * loescht.
   */
  let quelle = readFileSync(new URL('../server/services/recipe-provider-sync.js', import.meta.url), 'utf8');
  quelle = quelle.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const tabelle of ['pantry_product_matches', 'recipe_ingredient_pantry_matches']) {
    assert.ok(!quelle.includes(tabelle),
      `server/services/recipe-provider-sync.js nennt ${tabelle} - ein Import setzt und loescht keine Zuordnung (docs/DECISIONS.md Abschnitt 7, #1448 Teil 4)`);
  }
});

test('die alte Tabelle je Rezept liest und schreibt kein Weg mehr', () => {
  // Sie bleibt ein Release lang stehen (Antwort auf #1448), damit die vorige
  // Version ihre Zuordnungen findet - gelesen und geschrieben wird sie nicht.
  for (const datei of ['../server/routes/recipes.js', '../server/services/recipe-provider-sync.js', '../server/services/pantry-products.js', '../server/routes/pantry.js']) {
    let quelle = readFileSync(new URL(datei, import.meta.url), 'utf8');
    quelle = quelle.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!quelle.includes('recipe_ingredient_pantry_matches'), `${datei} nennt die alte Zuordnungstabelle`);
  }
});

// =========================================================================
// 4. Was der Vorrat mit der Zuordnung macht
// =========================================================================

test('die letzte Charge aufzubrauchen und zu loeschen laesst die Zuordnung stehen', async () => {
  asMember({});
  const recipeId = seedRecipe('Risotto', ['Reis', 'Brühe']);
  const packung = seedPantry('Risottoreis');
  await confirm(recipeId, 'Reis', packung.product);

  // Aufgebraucht: der Stepper setzt die Menge auf 0 (PATCH), die Charge steht noch.
  assert.equal((await call('PATCH', `/pantry/${packung.item}`, { quantity: 0 })).status, 200);
  assert.equal(ingredientOf((await readRecipe(recipeId)).body, 'Reis').pantry_product_id, packung.product);

  // Und geloescht, ueber den echten Weg des Vorrats.
  assert.equal((await call('DELETE', `/pantry/${packung.item}`)).status, 204);
  assert.ok(db.prepare('SELECT 1 FROM pantry_products WHERE id = ?').get(packung.product), 'Vorbedingung: das Produkt ueberlebt seine letzte Charge');

  const reis = ingredientOf((await readRecipe(recipeId)).body, 'Reis');
  assert.equal(reis.pantry_product_id, packung.product, 'die Aussage galt dem Produkt, nicht der Packung');
  assert.equal(reis.pantry_product_name, 'Risottoreis');
  assert.equal(reis.pantry_item_id, null, 'die abgekuendigte Charge gibt es nicht mehr');
  assert.equal(reis.pantry_item_name, null);
  assert.deepEqual(ingredientNames(recipeId), ['Reis', 'Brühe']);
});

test('eine zweite Packung an anderem Ort: die abgekuendigte Charge wechselt, das Produkt bleibt', async () => {
  asMember({});
  const recipeId = seedRecipe('Milchreis', ['Milch']);
  const kuehlschrank = seedPantry('Milch', { unit: 'l' });
  const garage = seedPantry('milch', { unit: 'l' });
  assert.equal(garage.product, kuehlschrank.product, 'Vorbedingung: beide Packungen sind ein Produkt');
  await confirm(recipeId, 'Milch', kuehlschrank.product);
  assert.equal(ingredientOf((await readRecipe(recipeId)).body, 'Milch').pantry_item_id, kuehlschrank.item,
    'die Charge mit der kleinsten ID');

  assert.equal((await call('DELETE', `/pantry/${kuehlschrank.item}`)).status, 204);
  const milch = ingredientOf((await readRecipe(recipeId)).body, 'Milch');
  assert.equal(milch.pantry_product_id, kuehlschrank.product);
  assert.equal(milch.pantry_item_id, garage.item, 'die Flasche in der Garage');
});

test('das Produkt zu loeschen nimmt seine Zuordnungen mit und laesst die Zutat stehen', async () => {
  asMember({});
  const recipeId = seedRecipe('Pesto', ['Pinienkerne']);
  const tuete = seedPantry('Pinienkerne');
  await confirm(recipeId, 'Pinienkerne', tuete.product);
  assert.equal((await call('DELETE', `/pantry/${tuete.item}`)).status, 204);

  assert.equal((await call('DELETE', `/pantry/products/${tuete.product}`)).status, 204);
  assert.equal(matchOf('pinienkerne'), undefined, 'ohne Produkt hat die Aussage keinen Gegenstand mehr');
  assert.deepEqual(ingredientNames(recipeId), ['Pinienkerne'], 'die Zutat bleibt');
  assert.equal(ingredientOf((await readRecipe(recipeId)).body, 'Pinienkerne').pantry_product_id, null,
    'und ist wieder unbekannt, nicht kaputt');
});

test('GET /pantry nennt je Produkt, wie viele Schreibweisen ihm zugeordnet sind (match_count)', async () => {
  // Die Seite braucht die Zahl fuer den Satz beim Loeschen eines leeren
  // Produkts: es nimmt seine Zuordnungen mit (CASCADE), und das soll der
  // Rueckgaengig-Hinweis sagen.
  asMember({});
  const recipeId = seedRecipe('Pasta e fagioli', ['Borlotti', 'Borlottibohnen', 'Rosmarin']);
  const dose = seedPantry('Borlotti Dose');
  const zweig = seedPantry('Rosmarinzweig');
  await confirm(recipeId, 'Borlotti', dose.product);
  await confirm(recipeId, 'Borlottibohnen', dose.product);
  const products = async () => Object.fromEntries((await call('GET', '/pantry')).body.products.map((/** @type {any} */ p) => [p.id, p.match_count]));
  let zahl = await products();
  assert.equal(zahl[dose.product], 2, 'zwei Schreibweisen meinen die Dose');
  assert.equal(zahl[zweig.product], 0, 'ein Produkt ohne Zuordnung: 0, nicht fehlend');

  await call('PUT', `/recipes/${recipeId}/ingredient-match`, { name: 'Borlottibohnen', pantryProductId: null });
  zahl = await products();
  assert.equal(zahl[dose.product], 1, 'eine geloeste Zuordnung zaehlt nicht mehr');
});

test('die einzige Charge umzubenennen nimmt die Zuordnung mit; bleibt eine Charge, bleibt sie beim Produkt', async () => {
  asMember({});
  const recipeId = seedRecipe('Kakao', ['Milch', 'Kakaopulver']);
  const einzige = seedPantry('Kuhmilch', { unit: 'l' });
  await confirm(recipeId, 'Milch', einzige.product);

  // Wie vor Teil 4, als die Zuordnung an der Charge hing: der Name folgt ihr.
  const umbenannt = await call('PUT', `/pantry/${einzige.item}`, { name: 'Vollmilch', quantity: 2, unit: 'l' });
  assert.equal(umbenannt.status, 200);
  const neu = umbenannt.body.data.product_id;
  assert.notEqual(neu, einzige.product, 'Vorbedingung: die Charge ist in ein anderes Produkt gewandert');
  assert.equal(matchOf('milch')?.product_id, neu, 'die Zuordnung geht mit der letzten Charge');
  assert.equal(ingredientOf((await readRecipe(recipeId)).body, 'Milch').pantry_product_name, 'Vollmilch');

  // Mit zwei Chargen spricht das Produkt noch fuer die andere: es behaelt sie.
  const pulver = seedPantry('Kakao', { unit: 'g' });
  seedPantry('kakao', { unit: 'g' });
  await confirm(recipeId, 'Kakaopulver', pulver.product);
  assert.equal((await call('PUT', `/pantry/${pulver.item}`, { name: 'Trinkschokolade', quantity: 2, unit: 'g' })).status, 200);
  assert.equal(matchOf('kakaopulver')?.product_id, pulver.product, 'das Produkt hat noch eine Charge');
});

// =========================================================================
// 5. Der Rechteweg: der Weg haengt unter /recipes und greift in den Vorrat
// =========================================================================

for (const stufe of ['none', 'read']) {
  test(`Mitglied mit pantry: ${stufe} setzt keine Zuordnung`, async () => {
    asMember({});
    const recipeId = seedRecipe(`Gericht-${stufe}`, ['Butter']);
    const butter = seedPantry(`Butter-${stufe}`);
    const vorher = matchCount();

    asMember({ pantry: stufe });
    const res = await confirm(recipeId, 'Butter', butter.product);
    assertDeniedShape(res, `pantry: ${stufe} darf kein Produkt des Vorrats in ein Rezept einhaengen`);
    assert.equal(matchCount(), vorher, 'und es steht auch keine Zuordnung in der Tabelle');
  });
}

test('Token mit meals:write, aber ohne Vorrats-Scope, setzt keine Zuordnung', async () => {
  asMember({});
  const recipeId = seedRecipe('Nudeln', ['Nudeln']);
  const packung = seedPantry('Spaghetti 500g');
  const vorher = matchCount();

  asToken(['meals:write']);
  const res = await confirm(recipeId, 'Nudeln', packung.product);
  assertDeniedShape(res, 'der Pfad sagt /recipes, benannt wird ein Produkt des Vorrats');
  assert.equal(matchCount(), vorher);
});

test('Token mit beiden Scopes kommt durch', async () => {
  const recipeId = seedRecipe('Pesto Genovese', ['Basilikum']);
  const topf = seedPantry('Basilikum im Topf');
  asToken(['meals:write', 'pantry:write']);
  const res = await confirm(recipeId, 'Basilikum', topf.product);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.pantry_product_id, topf.product);
});

test('das Loesen einer Zuordnung braucht dasselbe Recht wie das Setzen', async () => {
  asMember({});
  const recipeId = seedRecipe('Kartoffelsalat', ['Kartoffeln']);
  const netz = seedPantry('Kartoffeln 2,5kg');
  await confirm(recipeId, 'Kartoffeln', netz.product);

  asMember({ pantry: 'read' });
  const res = await call('PUT', `/recipes/${recipeId}/ingredient-match`, { name: 'Kartoffeln', pantryProductId: null });
  assertDeniedShape(res, 'eine Zuordnung zu loesen ist derselbe Schreibvorgang, nur rueckwaerts');
  assert.equal(matchOf('kartoffeln')?.product_id, netz.product, 'die Zuordnung steht unveraendert');
});

// =========================================================================
// 5b. Der LESEWEG traegt dasselbe Recht wie der Schreibweg
// =========================================================================

/*
 * DERSELBE BEFUND WIE BEI DEN GEBURTSTAGEN (server/routes/birthdays.js): der
 * Pfad sagt `/recipes` und loest auf das Scope-Modul `meals` auf, der Inhalt
 * nennt ein Produkt des VORRATS. Der Riegel in server/index.js urteilt am
 * ersten Pfadsegment und fragt nie nach `pantry`. Das Verstecken in
 * `pantryMatchEl()` (public/pages/recipes.js) ist eine Darstellungsentscheidung,
 * keine Zugriffskontrolle: GET /api/v1/recipes beantwortet die Frage direkt.
 * Gesperrt sind alle VIER Felder, die neuen und die abgekuendigten.
 */

/** Setzt eine Zuordnung mit vollem Recht und gibt Rezept-ID und Produkt zurueck. */
async function seedMatch(titel, zutat, vorrat) {
  asMember({});
  const recipeId = seedRecipe(titel, [zutat, 'Salz']);
  const { product, item } = seedPantry(vorrat);
  const res = await confirm(recipeId, zutat, product);
  assert.equal(res.status, 200, 'Vorbedingung: die Zuordnung steht');
  return { recipeId, product, item };
}

const MATCH_FIELDS = ['pantry_product_id', 'pantry_product_name', 'pantry_item_id', 'pantry_item_name'];

test('Mitglied mit pantry: read sieht die Zuordnung weiter', async () => {
  // OHNE DIESEN TEST SAGT JEDES `null` WEITER UNTEN NICHTS.
  const { recipeId, product, item } = await seedMatch('Bruschetta', 'Tomaten', 'Dosentomaten');

  asMember({ pantry: 'read' });
  const tomaten = ingredientOf((await readRecipe(recipeId)).body, 'Tomaten');
  assert.equal(tomaten.pantry_product_id, product);
  assert.equal(tomaten.pantry_product_name, 'Dosentomaten');
  assert.equal(tomaten.pantry_item_id, item);
});

test('Mitglied mit pantry: none bekommt die Zuordnung aus GET /recipes nicht', async () => {
  const { recipeId } = await seedMatch('Chili sin carne', 'Bohnen', 'Kidneybohnen 400g');

  asMember({ pantry: 'none' });
  const bohnen = ingredientOf((await readRecipe(recipeId)).body, 'Bohnen');
  for (const feld of MATCH_FIELDS) {
    assert.equal(bohnen[feld], null, `${feld} benennt den Vorrat, den dieses Mitglied nicht sehen darf`);
  }
  assert.equal(bohnen.name, 'Bohnen', 'das Rezept selbst bleibt lesbar - gesperrt ist der Vorrat, nicht das Essen');
});

test('Mitglied mit pantry: none bekommt die Zuordnung auch aus der Antwort auf PUT /recipes/:id nicht', async () => {
  const { recipeId } = await seedMatch('Gulasch', 'Paprika', 'Paprikapulver edelsuess');

  asMember({ pantry: 'none' });
  const gespeichert = await call('PUT', `/recipes/${recipeId}`, {
    title: 'Gulasch',
    ingredients: [{ name: 'Paprika' }, { name: 'Salz' }],
  });
  assert.equal(gespeichert.status, 200, 'Vorbedingung: das Speichern selbst ist erlaubt');
  for (const feld of MATCH_FIELDS) assert.equal(ingredientOf(gespeichert.body, 'Paprika')[feld], null, feld);
});

test('Token mit meals:read und pantry:read sieht die Zuordnung', async () => {
  const { recipeId, product } = await seedMatch('Pizza', 'Mozzarella', 'Mozzarella 125g');

  asToken(['meals:read', 'pantry:read']);
  const mozzarella = ingredientOf((await readRecipe(recipeId)).body, 'Mozzarella');
  assert.equal(mozzarella.pantry_product_id, product);
  assert.equal(mozzarella.pantry_product_name, 'Mozzarella 125g');
});

test('Token mit meals:read, aber ohne Vorrats-Scope, bekommt die Zuordnung nicht', async () => {
  const { recipeId } = await seedMatch('Lasagne', 'Bechamel', 'Bechamelsauce Glas');

  asToken(['meals:read']);
  const bechamel = ingredientOf((await readRecipe(recipeId)).body, 'Bechamel');
  for (const feld of MATCH_FIELDS) {
    assert.equal(bechamel[feld], null,
      `${feld}: ein Token mit meals:read nennt den Vorrat nicht - es kommt am Pfad-Riegel vorbei, nicht an dieser Frage`);
  }
  assert.equal(bechamel.name, 'Bechamel', 'das Rezept selbst darf es lesen');
});

// =========================================================================
// 6. Die abgekuendigte Charge im Request (#1448 Teil 4, CHANGELOG Deprecated)
// =========================================================================

test('pantryItemId meint das Produkt dieser Charge, fuer die Abkuendigungsfrist', async () => {
  asMember({});
  const recipeId = seedRecipe('Rührei', ['Eier']);
  const karton = seedPantry('Eier 10er');
  const zweiter = seedPantry('eier 10er');
  assert.equal(zweiter.product, karton.product, 'Vorbedingung: ein Produkt, zwei Chargen');

  const res = await call('PUT', `/recipes/${recipeId}/ingredient-match`, { name: 'Eier', pantryItemId: zweiter.item });
  assert.equal(res.status, 200, 'ein Client von gestern schickt eine Charge');
  assert.equal(res.body.data.pantry_product_id, karton.product, 'gespeichert ist das Produkt der Charge');
  assert.equal(matchOf('eier')?.product_id, karton.product);
  assert.equal(res.body.data.pantry_item_id, karton.item, 'die abgekuendigte Antwort folgt der Regel des Lesewegs');

  const geloest = await call('PUT', `/recipes/${recipeId}/ingredient-match`, { name: 'Eier', pantryItemId: null });
  assert.equal(geloest.status, 200);
  assert.equal(matchOf('eier'), undefined, 'pantryItemId: null loest wie frueher');
});

test('eine Charge ohne Produkt (aeltere Version) bekommt ihres und wird zugeordnet', async () => {
  asMember({});
  const recipeId = seedRecipe('Tee', ['Tee']);
  const item = Number(db.prepare("INSERT INTO pantry_items (name, quantity, unit) VALUES ('Schwarztee', 1, 'pkg')").run().lastInsertRowid);
  assert.equal(db.prepare('SELECT product_id FROM pantry_items WHERE id = ?').get(item).product_id, null);

  const res = await call('PUT', `/recipes/${recipeId}/ingredient-match`, { name: 'Tee', pantryItemId: item });
  assert.equal(res.status, 200);
  const product = db.prepare('SELECT product_id FROM pantry_items WHERE id = ?').get(item).product_id;
  assert.ok(product, 'die Charge hat jetzt ein Produkt');
  assert.equal(res.body.data.pantry_product_id, product);
});

test('beide Felder mit einer Zahl sind ein 400 auf Englisch; unbekanntes Produkt und unbekannte Charge sind ein 404', async () => {
  asMember({});
  const recipeId = seedRecipe('Salat', ['Gurke']);
  const gurke = seedPantry('Gurke');
  const vorher = matchCount();

  const beide = await call('PUT', `/recipes/${recipeId}/ingredient-match`, { name: 'Gurke', pantryProductId: gurke.product, pantryItemId: gurke.item });
  assert.deepEqual(beide, { status: 400, body: { error: 'Send pantryProductId or pantryItemId, not both.', code: 400 } });
  // Ein null daneben ist keine zweite Antwort.
  assert.equal((await call('PUT', `/recipes/${recipeId}/ingredient-match`, { name: 'Gurke', pantryProductId: gurke.product, pantryItemId: null })).status, 200);
  db.prepare('DELETE FROM pantry_product_matches WHERE ingredient_key = ?').run('gurke');

  assert.deepEqual(await call('PUT', `/recipes/${recipeId}/ingredient-match`, { name: 'Gurke', pantryProductId: 999999 }),
    { status: 404, body: { error: 'Pantry product not found.', code: 404, reason: 'recipes_selected_pantry_item_not_found' } });
  assert.deepEqual(await call('PUT', `/recipes/${recipeId}/ingredient-match`, { name: 'Gurke', pantryItemId: 999999 }),
    { status: 404, body: { error: 'Pantry item not found.', code: 404, reason: 'recipes_selected_pantry_item_not_found' } });
  assert.equal(matchCount(), vorher, 'nichts geschrieben');
});

// =========================================================================
// 7. Unbekannt, nicht fehlend
// =========================================================================

test('eine nicht zugeordnete Zutat kommt als unbekannt zurueck, nicht als fehlend', async () => {
  asMember({});
  const recipeId = seedRecipe('Omelett', ['Eier vom Hof', 'Schnittlauch']);
  const eier = seedPantry('Hofeier');
  await confirm(recipeId, 'Eier vom Hof', eier.product);

  const schnittlauch = ingredientOf((await readRecipe(recipeId)).body, 'Schnittlauch');
  for (const feld of MATCH_FIELDS) assert.equal(schnittlauch[feld], null, feld);
  // KEIN Vorrats-Urteil auf der Zutat. Die Zuordnung sagt nur, worauf der
  // Haushalt gezeigt hat; jedes `available`/`missing` hier waere eine Auskunft
  // ueber Bestand, die niemand gegeben hat (docs/DECISIONS.md Abschnitt 7,
  // "What counts as undoing it").
  for (const verboten of ['missing', 'available', 'in_stock', 'have']) {
    assert.equal(verboten in schnittlauch, false,
      `kein "${verboten}" - unbekannt ist nicht fehlend`);
  }
});

test('auch die Liste traegt den Unterschied, nicht nur das einzelne Rezept', async () => {
  asMember({});
  const recipeId = seedRecipe('Bratkartoffeln', ['Festkochende Kartoffeln', 'Zwiebel']);
  const netz = seedPantry('Kartoffeln festkochend');
  await confirm(recipeId, 'Festkochende Kartoffeln', netz.product);

  const liste = await call('GET', '/recipes');
  const rezept = liste.body.data.find((r) => r.id === recipeId);
  assert.ok(rezept, 'das Rezept steht in der Liste');
  assert.equal(rezept.ingredients.find((/** @type {any} */ i) => i.name === 'Festkochende Kartoffeln').pantry_product_id, netz.product);
  assert.equal(rezept.ingredients.find((/** @type {any} */ i) => i.name === 'Zwiebel').pantry_product_id, null);
});

test('die Oberflaeche nennt den unzugeordneten Zustand unbekannt, nicht fehlend', () => {
  // Die Grenze aus docs/DECISIONS.md Abschnitt 7 endet nicht an der API: "and
  // presenting an unmatched ingredient as missing rather than unknown" steht
  // dort unter "What counts as undoing it". Ein Wort wie "fehlt" macht aus
  // einer Teilauskunft eine vollstaendige.
  const de = JSON.parse(readFileSync(new URL('../public/locales/de.json', import.meta.url), 'utf8'));
  const text = de.recipes?.ingredientMatchNone;
  assert.equal(typeof text, 'string', 'recipes.ingredientMatchNone fehlt in public/locales/de.json');
  assert.match(text, /nicht zugeordnet|nicht verknüpft|unbekannt/i, `"${text}" benennt den Zustand nicht als unbekannt`);
  assert.doesNotMatch(text, /fehlt|fehlend|nicht vorhanden|nicht da/i,
    `"${text}" liest sich wie eine Auskunft ueber den Bestand - die Zuordnung gibt keine`);

  const seite = readFileSync(new URL('../public/pages/recipes.js', import.meta.url), 'utf8');
  assert.match(seite, /recipes\.ingredientMatchNone/,
    'public/pages/recipes.js zeigt den unzugeordneten Zustand nicht an');
});

// =========================================================================
// 8. Einmal statt sechsmal (Re-Critique 2026-09-27, W2), und fuer den Haushalt
// =========================================================================
//
// „Nicht zugeordnet" stand an jeder offenen Zutat - sechsmal je Rezept,
// unterstrichen, lauter als die Menge. Die Regel jetzt: an der ZEILE steht nur
// eine bestehende Zuordnung; der Weg zu den offenen ist EIN Knopf unter der
// Liste, nur fuer Konten mit Schreibrecht am Vorrat. Und das Detail traegt echte
// Abschnittskoepfe, eine Stufe unter dem Rezepttitel (<h2>).
test('die Zeile nennt nur bestehende Zuordnungen, der Weg zu den offenen steht einmal', () => {
  let seite = readFileSync(new URL('../public/pages/recipes.js', import.meta.url), 'utf8');
  for (let prev = ''; prev !== seite;) {
    prev = seite;
    seite = seite.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }
  const body = (name) => {
    const at = seite.indexOf(`function ${name}(`);
    assert.ok(at >= 0, `${name} fehlt in recipes.js`);
    return seite.slice(at, seite.indexOf('\n}\n', at));
  };
  const zeile = body('pantryMatchEl');
  assert.doesNotMatch(zeile, /ingredientMatchNone/,
    'pantryMatchEl schreibt den offenen Zustand wieder an jede Zeile');
  assert.match(zeile, /const matched = Boolean\(ing\.pantry_product_id\)/,
    'zugeordnet heisst: ein Produkt ist genannt (#1448 Teil 4), nicht eine Charge');
  assert.match(zeile, /if \(!matched\) return document\.createDocumentFragment\(\)/,
    'eine offene Zutat bekommt an der Zeile kein Element');

  const sammel = body('pantryMatchBulkEl');
  // Seit #1265 fragt der Knopf BEIDE Rechte, die der Server verlangt (Pfad-Guard
  // `meals: write`, Route `pantry: write`) - ueber `mayMatchIngredient()`. Das
  // Verhalten je Rechtekombination faehrt test-kitchen-readonly-ui.js.
  assert.match(sammel, /if \(!mayMatchIngredient\(recipe\.id\)\) return null/,
    'der Sammelknopf ist eine Handlung - Nur-Lesende bekommen ihn nicht (#467)');
  assert.match(sammel, /const open = openMatchIngredients\(recipe\)/, 'der Knopf zaehlt, was der Dialog fragt');
  assert.match(body('openPantryBulkMatchModal'), /const open = openMatchIngredients\(recipe\)/);
  const offen = body('openMatchIngredients');
  assert.match(offen, /if \(ing\.pantry_product_id\) return false;/, 'offen ist eine Zutat ohne Produkt');
  assert.match(offen, /if \(seen\.has\(key\)\) return false;/, 'je Schreibweise eine Frage (#1448 Teil 4)');
  assert.match(body('mayMatchIngredient'), /return pantryAccess\(\) === 'write' && mayWritePath\(/,
    'die Zuordnung braucht das Schreibrecht am Vorrat UND das der Kueche');
  assert.match(sammel, /ingredientMatchOpen/, 'der Sammelknopf nennt die Zahl der offenen Zutaten');
  assert.match(body('ingredientsSectionEl'), /pantryMatchBulkEl\(recipe\)/,
    'der Zutaten-Abschnitt traegt den einen Sammelknopf');

  // Beide Dialoge sagen, dass die Wahl fuer jedes Rezept gilt, und schicken das Produkt.
  for (const name of ['openPantryMatchModal', 'openPantryBulkMatchModal']) {
    assert.match(body(name), /pantryChoices\(await api\.get\('\/pantry'\)\)/, `${name} listet nicht die Produkte`);
    assert.match(body(name), /pantryProductId/, `${name} schickt kein Produkt`);
    assert.doesNotMatch(body(name), /pantryItemId/, `${name} schickt noch die abgekuendigte Charge`);
  }

  // Die Hinweise beider Dialoge sagen im selben Satz, dass die Wahl fuer jedes
  // Rezept gilt; jede Sprache setzt ihren Abstand selbst, also keiner nach dem
  // Satzzeichen der CJK-Sprachen (eine Verkettung im Code setzte ihn immer).
  assert.match(body('openPantryMatchModal'), /<p class="form-hint">\$\{t\('recipes\.ingredientMatchHint'\)\}<\/p>/);
  assert.match(body('openPantryBulkMatchModal'), /<p class="form-hint">\$\{t\('recipes\.ingredientMatchBulkHint'\)\}<\/p>/);
  const sprache = (/** @type {string} */ loc) => JSON.parse(readFileSync(new URL(`../public/locales/${loc}.json`, import.meta.url), 'utf8')).recipes;
  for (const key of ['ingredientMatchHint', 'ingredientMatchBulkHint']) {
    assert.match(sprache('en')[key], /every recipe that names this ingredient the same way\.$/, `en ${key}`);
    assert.match(sprache('de')[key], /jedes Rezept, das diese Zutat genauso nennt\.$/, `de ${key}`);
    for (const loc of ['ja', 'zh', 'zh-Hant']) assert.doesNotMatch(sprache(loc)[key], /。 /, `${loc} ${key}: kein Abstand nach dem Satzzeichen`);
  }
  assert.equal(sprache('en').ingredientMatchScope, undefined, 'der Satz steht in den Hinweisen, nicht daneben');

  const kopf = body('detailSectionEl');
  assert.match(kopf, /createElement\('h3'\)/, 'Abschnittskopf ist eine echte Ueberschrift unter dem <h2>-Titel');
  const detail = body('fillRecipeDetail');
  assert.match(detail, /ingredientsSectionEl\(recipe\)/, 'Zutaten stehen im Abschnitt mit Kopf');
  assert.match(detail, /detailSectionEl\(t\('recipes\.notesLabel'\)\)/, 'Notizen stehen im Abschnitt mit Kopf');

  const de = JSON.parse(readFileSync(new URL('../public/locales/de.json', import.meta.url), 'utf8'));
  for (const key of ['ingredientMatchOpen', 'ingredientMatchOpen_one', 'ingredientMatchBulkTitle', 'ingredientMatchBulkHint']) {
    assert.doesNotMatch(de.recipes[key], /fehlt|fehlend|nicht vorhanden/i,
      `recipes.${key} liest sich wie eine Auskunft ueber den Bestand - die Zuordnung gibt keine`);
  }
});
