/**
 * Modul: Rezepte (Recipes)
 * Zweck: REST-API-Routen fuer Rezept-CRUD inkl. Zutaten
 * Abhaengigkeiten: express, server/db.js
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { str, num, collectErrors, MAX_TITLE, MAX_TEXT, MAX_SHORT } from '../middleware/validate.js';
import { normalizeRecipeMealTypes } from '../../public/utils/recipe-meal-types.js';
import { ingredientMatchKey } from '../../public/utils/ingredient-match-key.js';
import { getAdapter } from '../services/recipe-providers/index.js';
import { dataUrlContentMatches } from '../utils/file-signature.js';
import { hiddenModulesFor, mayWriteModule } from '../permissions.js';

const log = createLogger('Recipes');
const router = express.Router();

// Nicht-skriptfähige Rasterformate (kein SVG), dieselbe Allowlist wie der
// DMS-Vorschau-Proxy (server/routes/dms.js) - dort wie hier landet ein
// Content-Type, den ein Drittsystem liefert, direkt im Response-Header.
const THUMBNAIL_MIME = new Set(['image/webp', 'image/jpeg', 'image/png']);
function normalizeMime(value) { return String(value || '').split(';')[0].trim().toLowerCase(); }

// Mirror-Rezepte tragen provider_account_id; native Rezepte haben diese Spalte
// NULL. `source` liest den tatsaechlichen Provider-Namen (mealie/tandoor/...)
// vom verknuepften Account statt ihn hart zu verdrahten - das ist der einzige
// Unterschied, den Frontend und Zugriffsschutz brauchen, um ein Rezept korrekt
// zu behandeln, und er erweitert sich automatisch um jeden neuen Provider.
function withSource(recipe) {
  // DAS BILD SELBST GEHT NIE MIT (#1059, Schritt 2). `SELECT r.*` zieht die
  // Spalte mit, und eine Data-URL von bis zu 5 MB je Zeile machte aus der
  // Rezeptliste ein Vielfaches ihrer selbst - fuer eine Vorschau von 32 Pixeln,
  // die ohnehin ueber `GET /recipes/:id/image` kommt. Uebrig bleibt das Flag,
  // das die Oberflaeche wirklich braucht: gibt es eins?
  const { image_data, ...rest } = recipe;
  return {
    ...rest,
    has_own_image: !!image_data,
    source: recipe.provider_account_id ? recipe.provider_type : 'native',
  };
}

/* DIE BESTAETIGTE ZUORDNUNG ZU EINER VORRATSZEILE (#1314, Stufe 1).
 *
 * Sie haengt NICHT an `recipe_ingredients.id`, und das ist keine Vorsicht,
 * sondern eine Messung: PUT /:id weiter unten loescht alle Zutaten eines
 * Rezepts und legt sie neu an, der Provider-Sync ebenso. Eine ID-Verbindung
 * waere nach dem naechsten Speichern still verschwunden. Gespeichert ist
 * deshalb (recipe_id, normalisierter Name) - siehe Migration 221.
 *
 * WAS HIER NICHT PASSIERT: nichts wird geraten. Eine Zutat ohne Zeile in
 * `recipe_ingredient_pantry_matches` bekommt `pantry_item_id: null` und sonst
 * gar nichts - kein "fehlt", kein "vorhanden". Stufe 1 weiss nur, worauf der
 * Haushalt gezeigt hat; unbekannt ist nicht fehlend (docs/DECISIONS.md
 * Abschnitt 7).
 */
function attachPantryMatches(req, ingredients) {
  if (!ingredients.length) return ingredients;

  // DAS RECHT AM LESEWEG, spiegelbildlich zum Schreibweg weiter unten. Der Pfad
  // haengt unter /recipes und gehoert dem Scope-Modul `meals`; der globale
  // Riegel in server/index.js urteilt am ersten Pfadsegment und fragt deshalb
  // nie nach `pantry`. Benannt wird hier aber eine Zeile des VORRATS, mit
  // ihrem Namen. Dieselbe Mischstelle wie die Import-Kandidaten in
  // server/routes/birthdays.js (Pfad `calendar`, Inhalt aus `contacts`), und
  // derselbe Aufruf schliesst sie: `hiddenModulesFor` prueft beide Achsen,
  // Mitgliedsrecht UND Token-Scope.
  //
  // Dass `pantryMatchEl()` in public/pages/recipes.js bei `access === 'none'`
  // nichts zeichnet, ist KEIN Ersatz: das ist eine Darstellungsentscheidung,
  // und GET /api/v1/recipes beantwortet die Frage am Browser vorbei.
  //
  // Was zurueckbleibt, ist `null` und nicht das Weglassen der Felder: die Zutat
  // ist fuer diesen Betrachter unzugeordnet, und die Antwort behaelt ihre Form.
  if (hiddenModulesFor(req, ['pantry']).has('pantry')) {
    return ingredients.map((ing) => ({ ...ing, pantry_item_id: null, pantry_item_name: null }));
  }
  const recipeIds = [...new Set(ingredients.map((i) => i.recipe_id))];
  const placeholders = recipeIds.map(() => '?').join(',');
  const rows = db.get().prepare(`
    SELECT m.recipe_id, m.ingredient_key, m.pantry_item_id, p.name AS pantry_item_name
    FROM recipe_ingredient_pantry_matches m
    JOIN pantry_items p ON p.id = m.pantry_item_id
    WHERE m.recipe_id IN (${placeholders})
  `).all(...recipeIds);

  const byKey = new Map(rows.map((r) => [`${r.recipe_id}\x00${r.ingredient_key}`, r]));
  return ingredients.map((ing) => {
    const hit = byKey.get(`${ing.recipe_id}\x00${ingredientMatchKey(ing.name)}`);
    return {
      ...ing,
      pantry_item_id: hit ? hit.pantry_item_id : null,
      pantry_item_name: hit ? hit.pantry_item_name : null,
    };
  });
}

function loadRecipeWithIngredients(req, id) {
  const recipe = db.get().prepare(`
    SELECT r.*, u.display_name AS creator_name, u.avatar_color AS creator_color,
           p.name AS provider_account_name, p.provider AS provider_type
    FROM recipes r
    LEFT JOIN users u ON u.id = r.created_by
    LEFT JOIN recipe_provider_accounts p ON p.id = r.provider_account_id
    WHERE r.id = ?
  `).get(id);

  if (!recipe) return null;

  const ingredients = attachPantryMatches(req, db.get().prepare(`
    SELECT * FROM recipe_ingredients
    WHERE recipe_id = ?
    ORDER BY id ASC
  `).all(id));

  return withSource({ ...recipe, meal_types: normalizeRecipeMealTypes(recipe.meal_types), ingredients });
}

router.get('/', (req, res) => {
  try {
    const recipes = db.get().prepare(`
      SELECT r.*, u.display_name AS creator_name, u.avatar_color AS creator_color,
             p.name AS provider_account_name, p.provider AS provider_type
      FROM recipes r
      LEFT JOIN users u ON u.id = r.created_by
      LEFT JOIN recipe_provider_accounts p ON p.id = r.provider_account_id
      ORDER BY r.title COLLATE NOCASE ASC, r.id DESC
    `).all();

    const ids = recipes.map((r) => r.id);
    let ingredientMap = {};

    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const ingredients = attachPantryMatches(req, db.get().prepare(`
        SELECT * FROM recipe_ingredients
        WHERE recipe_id IN (${placeholders})
        ORDER BY id ASC
      `).all(...ids));

      for (const ing of ingredients) {
        if (!ingredientMap[ing.recipe_id]) ingredientMap[ing.recipe_id] = [];
        ingredientMap[ing.recipe_id].push(ing);
      }
    }

    res.json({ data: recipes.map((r) => withSource({
      ...r,
      meal_types: normalizeRecipeMealTypes(r.meal_types),
      ingredients: ingredientMap[r.id] || [],
    })) });
  } catch (err) {
    log.error('GET / error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/* EIN EIGENES BILD JE REZEPT (#1059, Schritt 2).
 *
 * Dieselbe Regel wie beim Gegenstandsfoto (routes/inventory/items.js) und beim
 * Geburtstagsbild: eine Bild-Data-URL, dieselbe Groessengrenze, und der Inhalt
 * muss zu seinem deklarierten Typ passen (#937) - der Praefix kommt aus dem
 * Browser des Absenders und ist fuer sich genommen keine Auskunft.
 *
 * `undefined` heisst "nicht mitgeschickt" und laesst das gespeicherte Bild
 * stehen; `null` oder der leere String loeschen es. Ohne diese Unterscheidung
 * raeumte jedes Teil-Update das Bild ab - derselbe Fehler, den `meal_types`
 * weiter unten schon einmal hatte.
 */
const MAX_RECIPE_IMAGE_LENGTH = 6_990_507; // ~5 MB Rohbild in base64, wie inventory/birthdays
const RECIPE_IMAGE_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

function validateRecipeImage(val) {
  if (val === undefined) return { value: undefined, error: null };
  if (val === null || val === '') return { value: null, error: null };
  const s = String(val).trim();
  if (s.length > MAX_RECIPE_IMAGE_LENGTH) return { value: null, error: 'Image is too large.' };
  if (!RECIPE_IMAGE_RE.test(s)) return { value: null, error: 'Image must be a valid image data URL.' };
  if (!dataUrlContentMatches(s)) return { value: null, error: 'Image content does not match its image type.' };
  return { value: s, error: null };
}

router.post('/', (req, res) => {
  try {
    const { ingredients = [] } = req.body;

    const vTitle = str(req.body.title, 'Titel', { max: MAX_TITLE });
    const vNotes = str(req.body.notes, 'Notizen', { max: MAX_TEXT, required: false });
    const vRecipeUrl = str(req.body.recipe_url, 'Rezept-URL', { max: MAX_TEXT, required: false });
    const mealTypes = normalizeRecipeMealTypes(req.body.meal_types);

    const vImage = validateRecipeImage(req.body.image_data);
    const errors = collectErrors([vTitle, vNotes, vRecipeUrl, vImage]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const recipeId = db.transaction(() => {
      const result = db.get().prepare(`
        INSERT INTO recipes (title, notes, recipe_url, meal_types, image_data, created_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(vTitle.value, vNotes.value, vRecipeUrl.value, mealTypes.join(','),
        vImage.value ?? null, req.authUserId || req.session.userId);

      const rid = Number(result.lastInsertRowid);
      const insertIng = db.get().prepare(`
        INSERT INTO recipe_ingredients (recipe_id, name, quantity, category)
        VALUES (?, ?, ?, ?)
      `);

      for (const ing of ingredients) {
        const name = String(ing.name || '').trim().slice(0, MAX_TITLE);
        const quantity = String(ing.quantity || '').trim().slice(0, MAX_SHORT) || null;
        const category = String(ing.category || '').trim().slice(0, MAX_SHORT) || 'Sonstiges';
        if (name) insertIng.run(rid, name, quantity, category);
      }

      return rid;
    });

    const created = loadRecipeWithIngredients(req, recipeId);
    res.status(201).json({ data: created });
  } catch (err) {
    log.error('POST / error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.put('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Ungueltige Rezept-ID', code: 400 });

    const existing = db.get().prepare('SELECT id, created_by, provider_account_id, meal_types FROM recipes WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Recipe not found', code: 404 });
    // Mirror-Rezepte sind read-only: der Quell-Provider bleibt Quelle der
    // Wahrheit für ihren Inhalt. Der Check steht vor der created_by-Prüfung,
    // weil sonst genau der Nutzer, der den Provider-Account angelegt hat (und
    // damit als created_by dieser Rezepte gilt), sie über die API editieren könnte.
    if (existing.provider_account_id) return res.status(403).json({ error: 'Mirrored recipes are managed by their source provider and cannot be edited here.', code: 403 });
    if (existing.created_by !== (req.authUserId || req.session.userId)) return res.status(403).json({ error: 'Not authorized.', code: 403 });

    const { ingredients = [] } = req.body;

    const vTitle = str(req.body.title, 'Titel', { max: MAX_TITLE });
    const vNotes = str(req.body.notes, 'Notizen', { max: MAX_TEXT, required: false });
    const vRecipeUrl = str(req.body.recipe_url, 'Rezept-URL', { max: MAX_TEXT, required: false });
    // Fehlt das Feld, bleibt die gespeicherte Auswahl stehen - ein Teil-Update
    // darf sie nicht mitnehmen. Ohne den Rückgriff schriebe jeder Aufruf ohne
    // meal_types wieder alle vier Mahlzeiten hin und machte eine bewusst leere
    // Auswahl (#750) beim nächsten Speichern zunichte.
    const mealTypes = normalizeRecipeMealTypes(
      req.body.meal_types === undefined ? existing.meal_types : req.body.meal_types
    );
    const vImage = validateRecipeImage(req.body.image_data);
    const errors = collectErrors([vTitle, vNotes, vRecipeUrl, vImage]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    db.transaction(() => {
      // COALESCE fuer das Bild: ein nicht mitgeschicktes Feld (undefined -> NULL
      // als Bindung) laesst das gespeicherte stehen. Geloescht wird nur mit
      // ausdruecklichem null/'' - dann traegt vImage.value ebenfalls null, und
      // die Fallunterscheidung unten setzt es.
      db.get().prepare(`
        UPDATE recipes
        SET title = ?, notes = ?, recipe_url = ?, meal_types = ?,
            image_data = CASE WHEN ? = 1 THEN ? ELSE image_data END
        WHERE id = ?
      `).run(vTitle.value, vNotes.value, vRecipeUrl.value, mealTypes.join(','),
        vImage.value === undefined ? 0 : 1, vImage.value ?? null, id);

      db.get().prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(id);

      const insertIng = db.get().prepare(`
        INSERT INTO recipe_ingredients (recipe_id, name, quantity, category)
        VALUES (?, ?, ?, ?)
      `);

      for (const ing of ingredients) {
        const name = String(ing.name || '').trim().slice(0, MAX_TITLE);
        const quantity = String(ing.quantity || '').trim().slice(0, MAX_SHORT) || null;
        const category = String(ing.category || '').trim().slice(0, MAX_SHORT) || 'Sonstiges';
        if (name) insertIng.run(id, name, quantity, category);
      }
    });

    const updated = loadRecipeWithIngredients(req, id);
    res.json({ data: updated });
  } catch (err) {
    log.error('PUT /:id error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * GET /api/v1/recipes/:id/image
 * Liefert das selbst hochgeladene Rezeptbild als Datei (#1059, Schritt 2).
 *
 * ALS ROUTE UND NICHT IN DER LISTE. Die Spalte traegt eine Data-URL von bis zu
 * 5 MB; sie an jeder Mahlzeit einer Wochenansicht mitzuschicken waere ein
 * Vielfaches der ganzen uebrigen Antwort, fuer eine Vorschau von 32 Pixeln.
 * Die Listen tragen deshalb nur ein Flag, und das Bild holt sich der Browser
 * hier - genau wie beim Provider-Thumbnail nebenan, das aus demselben Grund
 * ein Proxy ist.
 */
router.get('/:id/image', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid recipe ID.', code: 400 });

    const row = db.get().prepare('SELECT image_data FROM recipes WHERE id = ?').get(id);
    if (!row?.image_data) return res.status(404).json({ error: 'No image available.', code: 404 });

    const match = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(row.image_data);
    if (!match) return res.status(415).json({ error: 'Stored image is not readable.', code: 415 });

    const buffer = Buffer.from(match[2], 'base64');
    res.setHeader('Content-Type', match[1]);
    res.setHeader('Content-Length', String(buffer.length));
    // Dieselben Kopfzeilen wie der Provider-Proxy: der Browser soll den Typ
    // nicht raten, und ein Bild aus der eigenen Datenbank gehoert niemandem
    // sonst in den Cache.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    res.end(buffer);
  } catch (err) {
    log.error('GET /:id/image error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid recipe ID.', code: 400 });

    const existing = db.get().prepare('SELECT id, created_by, provider_account_id FROM recipes WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Recipe not found.', code: 404 });
    // Siehe PUT /:id: Mirror-Rezepte lassen sich nur durch Löschen des
    // Provider-Accounts entfernen (DELETE /recipe-providers/accounts/:id), nicht
    // einzeln hier.
    if (existing.provider_account_id) return res.status(403).json({ error: 'Mirrored recipes are managed by their source provider and cannot be deleted here.', code: 403 });
    if (existing.created_by !== (req.authUserId || req.session.userId)) return res.status(403).json({ error: 'Not authorized.', code: 403 });

    const result = db.get().prepare('DELETE FROM recipes WHERE id = ?').run(id);
    if (result.changes === 0) return res.status(404).json({ error: 'Recipe not found', code: 404 });

    res.status(204).end();
  } catch (err) {
    log.error('DELETE /:id error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * GET /api/v1/recipes/:id/provider-thumbnail
 * Proxied das Rezeptbild eines Recipe-Providers (Mealie, Tandoor, ...). Kein
 * direkter <img src> auf den Provider möglich: dessen Medien-Route verlangt
 * denselben Bearer-Token wie jeder andere Endpunkt, und der darf den Client nie
 * erreichen (siehe publicAccount() in routes/recipe-providers.js) - also holt
 * der Server die Bytes und reicht sie durch, wie der DMS-Vorschau-Proxy es für
 * Paperless/Papra tut.
 */
router.get('/:id/provider-thumbnail', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid recipe ID.', code: 400 });

    const recipe = db.get().prepare(
      'SELECT provider_account_id, provider_recipe_id, provider_slug, provider_has_image FROM recipes WHERE id = ?'
    ).get(id);
    if (!recipe?.provider_account_id || !recipe.provider_has_image) {
      return res.status(404).json({ error: 'No thumbnail available.', code: 404 });
    }

    const account = db.get().prepare('SELECT * FROM recipe_provider_accounts WHERE id = ?').get(recipe.provider_account_id);
    if (!account) return res.status(404).json({ error: 'No thumbnail available.', code: 404 });

    const thumb = await getAdapter(account).fetchThumbnail({ id: recipe.provider_recipe_id, slug: recipe.provider_slug });
    const mime = normalizeMime(thumb?.mime);
    if (!thumb?.buffer?.length || !THUMBNAIL_MIME.has(mime)) {
      return res.status(415).json({ error: 'Thumbnail not available.', code: 415 });
    }
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', String(thumb.buffer.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    res.end(thumb.buffer);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'No thumbnail available.', code: 404 });
    log.error('GET /:id/provider-thumbnail error:', err);
    res.status(502).json({ error: 'Recipe provider thumbnail proxy failed.', code: 502 });
  }
});

// --------------------------------------------------------
// Integration: Rezeptzutaten → Einkaufsliste
// --------------------------------------------------------

/**
 * POST /api/v1/recipes/:id/to-shopping-list
 * Zutaten eines Rezepts auf eine Einkaufsliste übernehmen.
 * Body: { listId: number }
 * Response: { data: { transferred: number, skipped: number, added_ids: number[] } }
 *
 * Anders als bei Mahlzeiten wird hier NICHTS am Rezept markiert: ein Rezept ist
 * eine Vorlage, die beliebig oft gekocht wird - ein „schon übertragen"-Flag wie
 * meal_ingredients.on_shopping_list wäre nach dem ersten Einkauf für immer
 * gesetzt. Stattdessen überspringt der Import, was unter demselben Namen bereits
 * unabgehakt auf der Liste liegt; doppeltes Übernehmen fügt also nichts hinzu,
 * statt die Liste zu verdoppeln.
 *
 * `added_ids` trägt das Undo im Client, wie bei `/shopping/:listId/import-pantry`.
 * Ohne die IDs gäbe es nichts zurückzunehmen: die Anzahl kennt erst der Server
 * (er überspringt Duplikate), und dieser Pfad überträgt am meisten auf einmal -
 * eine ganze Zutatenliste in eine Liste, die der Nutzer gerade nicht ansieht
 * (Audit 2026-07-30, P1-B).
 */
router.post('/:id/to-shopping-list', (req, res) => {
  try {
    // Dieselbe Regel wie im Essensplan (#1290, ausfuehrlich in
    // routes/meals.js): `/recipes` gehoert dem Scope-Modul `meals`, angelegt
    // werden `shopping_items`. Wer in den Einkauf schreibt, braucht dessen
    // Schreibrecht - als Mitglied wie als Token. Vor den 404ern, damit die
    // Antwort keine Rezept- und Listen-IDs bestaetigt.
    if (!mayWriteModule(req, 'shopping')) {
      return res.status(403).json({ error: 'Write access to the shopping list is required.', code: 403 });
    }

    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid recipe ID.', code: 400 });

    const recipe = db.get().prepare('SELECT id FROM recipes WHERE id = ?').get(id);
    if (!recipe) return res.status(404).json({ error: 'Recipe not found.', code: 404 });

    const vList = num(req.body.listId, 'Listen-ID', { required: true });
    const errors = collectErrors([vList]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const list = db.get().prepare('SELECT id FROM shopping_lists WHERE id = ?').get(vList.value);
    if (!list) return res.status(404).json({ error: 'Shopping list not found.', code: 404 });

    const ingredients = db.get().prepare(
      'SELECT name, quantity, category FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id ASC',
    ).all(id);
    if (!ingredients.length) return res.json({ data: { transferred: 0, skipped: 0, added_ids: [] } });

    const result = db.transaction(() => {
      const existing = db.get().prepare(
        'SELECT name FROM shopping_items WHERE list_id = ? AND is_checked = 0',
      ).all(vList.value);
      const present = new Set(existing.map((i) => i.name.trim().toLowerCase()));

      const insertItem = db.get().prepare(`
        INSERT INTO shopping_items (list_id, name, quantity, category)
        VALUES (?, ?, ?, ?)
      `);

      const addedIds = [];
      let skipped = 0;
      for (const ing of ingredients) {
        const key = ing.name.trim().toLowerCase();
        if (present.has(key)) { skipped += 1; continue; }
        const info = insertItem.run(vList.value, ing.name, ing.quantity, ing.category || 'Sonstiges');
        present.add(key);
        addedIds.push(Number(info.lastInsertRowid));
      }
      return { transferred: addedIds.length, skipped, added_ids: addedIds };
    });

    res.json({ data: result });
  } catch (err) {
    log.error('POST /:id/to-shopping-list error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

// --------------------------------------------------------
// Integration: Rezeptzutat → Vorratszeile (#1314, Stufe 1)
// --------------------------------------------------------

/**
 * PUT /api/v1/recipes/:id/ingredient-match
 * Die bestaetigte Zuordnung einer Rezeptzutat zu einer Zeile im Vorrat setzen
 * oder loesen.
 * Body: { name: string, pantryItemId: number|null }
 * Response: { data: { name, ingredient_key, pantry_item_id, pantry_item_name } }
 *
 * NUR AUF BESTAETIGUNG, UND DESHALB ALS EIGENER WEG. Die Zuordnung haette auch
 * ein Feld im Rezept-PUT sein koennen - dann haette jeder Speichervorgang,
 * jedes Formular und jeder Client sie mitgeschrieben, und ein Client, der das
 * Feld nicht kennt, haette sie geloescht. Ein eigener Aufruf ist die einzige
 * Form, in der "ein Mensch hat das bestaetigt" auch technisch stimmt: es gibt
 * keinen anderen Weg, auf dem eine Zuordnung entsteht (docs/DECISIONS.md
 * Abschnitt 7 - eine geratene Zuordnung ist der gepflegte Katalog, eine
 * Ableitung nach der anderen).
 *
 * `pantryItemId: null` loest die Zuordnung. Derselbe Weg, dasselbe Recht: das
 * Loesen ist derselbe Schreibvorgang, nur rueckwaerts.
 *
 * DAS RECHT. Wie bei /recipes/:id/to-shopping-list nebenan: der Pfad haengt
 * unter `/recipes` und gehoert damit dem Scope-Modul `meals` - der globale
 * Riegel in server/index.js urteilt am ersten Pfadsegment und fragt nur danach.
 * Benannt wird hier aber eine Zeile des VORRATS, und sie wird dauerhaft in ein
 * anderes Modul eingehaengt. Wer das tut, braucht das Schreibrecht des Vorrats,
 * auf beiden Achsen (Mitgliedsrecht und Token-Scope). Der Riegel steht vor den
 * 404ern, damit die Antwort keine Rezept- und Vorrats-IDs bestaetigt.
 */
router.put('/:id/ingredient-match', (req, res) => {
  try {
    if (!mayWriteModule(req, 'pantry')) {
      return res.status(403).json({ error: 'Write access to the pantry is required.', code: 403 });
    }

    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid recipe ID.', code: 400 });

    const vName = str(req.body.name, 'Zutat', { max: MAX_TITLE });
    const errors = collectErrors([vName]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const key = ingredientMatchKey(vName.value);
    if (!key) return res.status(400).json({ error: 'Zutat darf nicht leer sein.', code: 400 });

    const recipe = db.get().prepare('SELECT id FROM recipes WHERE id = ?').get(id);
    if (!recipe) return res.status(404).json({ error: 'Recipe not found.', code: 404 });

    // DIE ZUTAT MUSS ES GEBEN. Sonst stuende eine Aussage ueber etwas in der
    // Tabelle, das in diesem Rezept nicht vorkommt - und sie bliebe dort
    // liegen, bis zufaellig jemand eine Zutat genau so nennt.
    const ingredients = db.get().prepare('SELECT name FROM recipe_ingredients WHERE recipe_id = ?').all(id);
    const treffer = ingredients.find((i) => ingredientMatchKey(i.name) === key);
    if (!treffer) return res.status(404).json({ error: 'Ingredient not found in this recipe.', code: 404 });

    const raw = req.body.pantryItemId;
    if (raw === null || raw === undefined || raw === '') {
      db.get().prepare(
        'DELETE FROM recipe_ingredient_pantry_matches WHERE recipe_id = ? AND ingredient_key = ?',
      ).run(id, key);
      return res.json({
        data: { name: treffer.name, ingredient_key: key, pantry_item_id: null, pantry_item_name: null },
      });
    }

    const vItem = num(raw, 'Vorrats-ID', { required: true });
    const itemErrors = collectErrors([vItem]);
    if (itemErrors.length) return res.status(400).json({ error: itemErrors.join(' '), code: 400 });

    const item = db.get().prepare('SELECT id, name FROM pantry_items WHERE id = ?').get(vItem.value);
    if (!item) return res.status(404).json({ error: 'Pantry item not found.', code: 404 });

    // Ein erneutes Bestaetigen ERSETZT die alte Aussage (Primaerschluessel
    // recipe_id + ingredient_key), statt eine zweite danebenzulegen.
    db.get().prepare(`
      INSERT INTO recipe_ingredient_pantry_matches (recipe_id, ingredient_key, pantry_item_id, confirmed_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(recipe_id, ingredient_key) DO UPDATE SET
        pantry_item_id = excluded.pantry_item_id,
        confirmed_by   = excluded.confirmed_by
    `).run(id, key, item.id, req.authUserId || req.session.userId);

    res.json({
      data: { name: treffer.name, ingredient_key: key, pantry_item_id: item.id, pantry_item_name: item.name },
    });
  } catch (err) {
    log.error('PUT /:id/ingredient-match error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

export default router;
