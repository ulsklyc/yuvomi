/**
 * Modul: Einkaufslisten (Shopping)
 * Zweck: REST-API-Routen für Einkaufslisten, Artikel, Kategorien, Autocomplete
 * Abhängigkeiten: express, server/db.js
 *
 * Routen-Reihenfolge: Statische Pfade (/suggestions, /categories, /items/:id) müssen
 * vor dynamischen (/:listId) registriert sein, damit Express korrekt matcht.
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { str, oneOf, url, date, collectErrors, MAX_TITLE, MAX_SHORT, MAX_TEXT } from '../middleware/validate.js';
import { aggregateMealIngredients } from '../services/shopping-import.js';
import { loadItemTagsFor } from '../utils/task-tags.js';
import {
  flushOutbound, markTodoOutbound, queueTodoDeletions,
} from '../services/caldav-todo-outbound.js';
import rateLimit from 'express-rate-limit';
import { emailService as defaultEmailService } from '../services/email.js';
import { memberEmail, isHouseholdMember, listEmailableMembers } from '../services/member-email.js';
import { buildShoppingListMail } from '../services/shopping-mail.js';
import { householdTimeZone, utcToWall } from '../utils/timezone.js';

const log = createLogger('Shopping');

const router  = express.Router();

/**
 * Eigene Schranke fuer den Listenversand (#944). Der API-Limiter darueber
 * erlaubt 300 Anfragen je Minute - das ist fuer Lesen und Abhaken richtig
 * bemessen und fuer etwas, das eine Mail ausloest, zu grosszuegig: 300 Mails je
 * Minute an ein Haushaltsmitglied waeren keine Hilfe mehr, sondern eine Last
 * fuer dessen Postfach und fuer den SMTP-Server, in dessen Ruf sie sich
 * niederschlaegt.
 */
const sendListLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many send requests. Please wait a moment.', code: 429 },
});

// --------------------------------------------------------
// Hilfsfunktionen
// --------------------------------------------------------

/**
 * Aus einer CalDAV-Liste gespiegelte Artikel einer Auswahl - vor dem Löschen zu
 * ermitteln, danach sind UID und Objekt-URL weg (#617).
 */
function mirroredItems(where, ...params) {
  return db.get().prepare(
    `SELECT * FROM shopping_items WHERE ${where} AND external_source = 'caldav'`
  ).all(...params);
}

/**
 * Ausgehende Arbeit an einem CalDAV-Spiegel anstoßen (#617). Bewusst nach der
 * Antwort und ohne await: der Server-Aufruf darf die Antwort weder verzögern
 * noch scheitern lassen. Schlägt er fehl, bleibt die Vormerkung liegen und der
 * nächste Sync-Lauf holt sie nach.
 */
function pushToCalDAV(what) {
  flushOutbound().catch((err) => log.warn(`${what} vorgemerkt, Sofortversuch fehlgeschlagen:`, err.message));
}

/** Alle Kategorien aus DB laden (nach sort_order sortiert). */
function loadCategories() {
  return db.get().prepare('SELECT * FROM shopping_categories ORDER BY sort_order ASC').all();
}

/** Kategorie-Namen-Array für Validierung. */
function validCategoryNames() {
  return loadCategories().map((c) => c.name);
}

/**
 * Artikel einer Liste in Anzeigereihenfolge: Kategorie in Gang-Reihenfolge,
 * abgehaktes ans Ende, davor die Handsortierung (#678), zuletzt die
 * Eingabereihenfolge als Gleichstand-Entscheider.
 *
 * Eine Funktion für Lesen UND Umsortieren: die Sortierung ist die Aussage
 * dieses Moduls über "Reihenfolge" und darf nicht in zwei Schreibweisen
 * auseinanderlaufen - die Antwort auf ein Umsortieren muss genau das zeigen,
 * was das nächste Laden liefert.
 */
function loadListItems(listId, categories) {
  const categoryOrder = categories.map((c, i) => `WHEN '${c.name.replace(/'/g, "''")}' THEN ${i}`).join(' ');
  const items = db.get().prepare(`
    SELECT * FROM shopping_items
    WHERE list_id = ?
    ORDER BY
      CASE category ${categoryOrder} ELSE ${categories.length} END,
      is_checked ASC,
      sort_order ASC,
      created_at ASC
  `).all(listId);

  // Gespiegelte CATEGORIES der Quellliste (#586). Eine Abfrage für die ganze
  // Liste, nicht eine pro Zeile.
  const tagMap = loadItemTagsFor(db.get(), items.map((i) => i.id));
  for (const item of items) item.tags = tagMap.get(item.id) ?? [];
  return items;
}

// --------------------------------------------------------
// GET /api/v1/shopping/categories
// Alle Kategorien zurückgeben.
// Response: { data: ShoppingCategory[] }
// --------------------------------------------------------
router.get('/categories', (_req, res) => {
  try {
    res.json({ data: loadCategories() });
  } catch (err) {
    log.error('GET /categories error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/shopping/categories
// Neue Kategorie erstellen.
// Body: { name }
// Response: { data: ShoppingCategory }
// --------------------------------------------------------
router.post('/categories', (req, res) => {
  try {
    const vName = str(req.body.name, 'Name', { max: MAX_SHORT });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const existing = db.get()
      .prepare('SELECT id FROM shopping_categories WHERE name = ? COLLATE NOCASE')
      .get(vName.value);
    if (existing) return res.status(409).json({ error: 'Category already exists.', code: 409 });

    const maxOrder = db.get()
      .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM shopping_categories')
      .get().m;

    const result = db.get()
      .prepare('INSERT INTO shopping_categories (name, icon, sort_order) VALUES (?, ?, ?)')
      .run(vName.value, 'tag', maxOrder + 1);

    const cat = db.get()
      .prepare('SELECT * FROM shopping_categories WHERE id = ?')
      .get(result.lastInsertRowid);
    res.status(201).json({ data: cat });
  } catch (err) {
    log.error('POST /categories error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PUT /api/v1/shopping/categories/:catId
// Kategorie umbenennen.
// Body: { name }
// Response: { data: ShoppingCategory }
// --------------------------------------------------------
router.put('/categories/:catId', (req, res) => {
  try {
    const cat = db.get()
      .prepare('SELECT * FROM shopping_categories WHERE id = ?')
      .get(req.params.catId);
    if (!cat) return res.status(404).json({ error: 'Category not found.', code: 404 });

    const vName = str(req.body.name, 'Name', { max: MAX_SHORT });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const conflict = db.get()
      .prepare('SELECT id FROM shopping_categories WHERE name = ? COLLATE NOCASE AND id != ?')
      .get(vName.value, cat.id);
    if (conflict) return res.status(409).json({ error: 'Category already exists.', code: 409 });

    // Artikel, die die alte Kategorie nutzen, mitumbenennen
    db.get().transaction(() => {
      db.get()
        .prepare('UPDATE shopping_items SET category = ? WHERE category = ?')
        .run(vName.value, cat.name);
      db.get()
        .prepare('UPDATE shopping_categories SET name = ? WHERE id = ?')
        .run(vName.value, cat.id);
    })();

    const updated = db.get()
      .prepare('SELECT * FROM shopping_categories WHERE id = ?')
      .get(cat.id);
    res.json({ data: updated });
  } catch (err) {
    log.error('PUT /categories/:catId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/shopping/categories/:catId
// Kategorie löschen (Artikel werden zu "Sonstiges" verschoben).
// Die letzte verbleibende Kategorie kann nicht gelöscht werden.
// Response: { ok: true }
// --------------------------------------------------------
router.delete('/categories/:catId', (req, res) => {
  try {
    const cat = db.get()
      .prepare('SELECT * FROM shopping_categories WHERE id = ?')
      .get(req.params.catId);
    if (!cat) return res.status(404).json({ error: 'Category not found.', code: 404 });

    const total = db.get()
      .prepare('SELECT COUNT(*) AS c FROM shopping_categories')
      .get().c;
    if (total <= 1) return res.status(400).json({ error: 'The last category cannot be deleted.', code: 400 });

    // Fallback-Kategorie: erste andere Kategorie nach sort_order
    const fallback = db.get()
      .prepare('SELECT name FROM shopping_categories WHERE id != ? ORDER BY sort_order ASC LIMIT 1')
      .get(cat.id);

    db.get().transaction(() => {
      // Umziehende Artikel hinten anstellen, je Liste (#678). Ohne den Versatz
      // behielten sie ihre Ränge aus der gelöschten Kategorie und mischten sich
      // zwischen die handsortierten der Zielkategorie - eine Reihenfolge, die
      // niemand hergestellt hat.
      //
      // Der Versatz wird je Liste VOR dem Umzug bestimmt und nicht als Subquery
      // im UPDATE gelesen: dort zählte die gerade umgezogene Zeile schon zum
      // Maximum der Zielkategorie, und jede weitere sprang um ihren eigenen Rang
      // höher - die Umzügler kamen in der Reihenfolge ihrer id an statt in ihrer
      // eigenen (Test „Umzügler landen hinter der Handsortierung des Ziels").
      const listen = db.get()
        .prepare('SELECT DISTINCT list_id FROM shopping_items WHERE category = ?')
        .all(cat.name);
      const maxIn = db.get().prepare(
        'SELECT COALESCE(MAX(sort_order), 0) AS m FROM shopping_items WHERE list_id = ? AND category = ?'
      );
      const move = db.get().prepare(
        'UPDATE shopping_items SET category = ?, sort_order = sort_order + ? WHERE category = ? AND list_id = ?'
      );
      for (const { list_id: listId } of listen) {
        move.run(fallback.name, maxIn.get(listId, fallback.name).m, cat.name, listId);
      }
      db.get()
        .prepare('DELETE FROM shopping_categories WHERE id = ?')
        .run(cat.id);
    })();

    res.json({ ok: true });
  } catch (err) {
    log.error('DELETE /categories/:catId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PATCH /api/v1/shopping/categories/reorder
// Reihenfolge der Kategorien ändern.
// Body: { order: number[] }  (Array von IDs in gewünschter Reihenfolge)
// Response: { data: ShoppingCategory[] }
// --------------------------------------------------------
router.patch('/categories/reorder', (req, res) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order) || order.length === 0)
      return res.status(400).json({ error: 'order muss ein nicht-leeres Array von IDs sein.', code: 400 });

    const update = db.get().prepare('UPDATE shopping_categories SET sort_order = ? WHERE id = ?');
    db.get().transaction(() => {
      order.forEach((id, idx) => update.run(idx, id));
    })();

    res.json({ data: loadCategories() });
  } catch (err) {
    log.error('PATCH /categories/reorder error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/shopping/send-recipients
// Wer die Einkaufsliste per Mail bekommen kann (#944).
// Response: { data: [{ id, display_name }] }
//
// EIGENER ENDPUNKT STATT `/family/members`. Der zeigt alle Konten ausser
// Hauspersonal - also auch Geteilte-Ausgaben-Gaeste, die Externe sind. Wer die
// Auswahl von dort speist, bietet einen Empfaenger an, den die Versandroute
// zurueckweist; und stuende dort einmal jemand, den sie NICHT zurueckweist,
// waere die Grenze nur in der Oberflaeche gezogen. Auswahl und Route fragen
// deshalb dieselbe Funktion.
//
// Die Adressen bleiben hier: fuer die Auswahl reicht der Name, und wer sie
// nicht herausgibt, kann sie auch nicht versehentlich anzeigen.
// --------------------------------------------------------
router.get('/send-recipients', (req, res) => {
  try {
    void req;
    const members = listEmailableMembers({ db: db.get() })
      .map(({ id, display_name }) => ({ id, display_name }));
    res.json({ data: members });
  } catch (err) {
    log.error('GET /send-recipients error:', err.message);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/shopping/suggestions?q=…
// Autocomplete-Vorschläge aus bisherigen Artikelnamen.
// Response: { data: { name, category, quantity }[] }
//
// KATEGORIE UND MENGE REISEN MIT (#1103). Ein Name allein macht aus der Liste
// bisheriger Einkaeufe keinen Vorschlag, der etwas spart - ohne die Kategorie
// landet jeder abgetippte Vorschlag wieder in "Sonstiges" und die
// Gang-Reihenfolge, derentwegen jemand ueberhaupt Kategorien pflegt, ist beim
// naechsten Einkauf neu zu sortieren. Die juengste Zeile mit diesem Namen
// entscheidet, welche Kategorie/Menge vorgeschlagen wird - sie ist die
// aktuellste Aussage darueber, wie der Haushalt den Artikel heute einordnet.
//
// REIHENFOLGE NACH ZULETZT VERWENDET, NICHT ALPHABETISCH (#1103). Ein
// Haushalt kauft dieselbe Handvoll Artikel immer wieder - die zuletzt
// eingekauften stehen oben, statt hinter allem, was zufaellig frueher im
// Alphabet liegt.
// --------------------------------------------------------
router.get('/suggestions', (req, res) => {
  try {
    const q = (req.query.q ?? '').trim();
    if (q.length < 1) return res.json({ data: [] });

    const names = db.get().prepare(`
      SELECT name, MAX(created_at) AS latest, MAX(id) AS latest_id FROM shopping_items
      WHERE name LIKE ? COLLATE NOCASE
      GROUP BY name
      ORDER BY latest DESC, latest_id DESC
      LIMIT 8
    `).all(`${q}%`);

    const mostRecent = db.get().prepare(`
      SELECT category, quantity FROM shopping_items
      WHERE name = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `);
    const data = names.map((r) => {
      const recent = mostRecent.get(r.name);
      return { name: r.name, category: recent?.category ?? null, quantity: recent?.quantity ?? null };
    });

    res.json({ data });
  } catch (err) {
    log.error('suggestions error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PATCH /api/v1/shopping/items/:itemId
// --------------------------------------------------------
// Laeden (#1003) - eine verwaltete Liste, kein Freitext.
//
// Ein Haushalt besucht wenige genug Laeden, dass Pflegen billig ist; Freitext
// ist ab der ersten Woche unordentlich ("REWE", "Rewe", "rewe City" waeren
// drei). Deshalb eine winzige CRUD-Flaeche statt eines Textfelds.
// --------------------------------------------------------

// GET /api/v1/shopping/stores  -> { data: Store[] }
router.get('/stores', (_req, res) => {
  try {
    const stores = db.get().prepare('SELECT * FROM shopping_stores ORDER BY name COLLATE NOCASE ASC').all();
    res.json({ data: stores });
  } catch (err) {
    log.error('GET /stores error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

// POST /api/v1/shopping/stores  Body: { name }
router.post('/stores', (req, res) => {
  try {
    const vName = str(req.body.name, 'Name', { max: MAX_SHORT });
    const errors = collectErrors([vName]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    // Derselbe Laden zweimal ist kein Fehler des Nutzers, sondern schon da:
    // die vorhandene Zeile zurueckgeben statt einen Konflikt zu melden.
    const vorhanden = db.get().prepare('SELECT * FROM shopping_stores WHERE name = ? COLLATE NOCASE').get(vName.value);
    if (vorhanden) return res.status(200).json({ data: vorhanden });

    const result = db.get().prepare(
      'INSERT INTO shopping_stores (name, created_by) VALUES (?, ?)'
    ).run(vName.value, req.authUserId || req.session.userId);
    res.status(201).json({ data: db.get().prepare('SELECT * FROM shopping_stores WHERE id = ?').get(result.lastInsertRowid) });
  } catch (err) {
    log.error('POST /stores error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

// PUT /api/v1/shopping/stores/:id  Body: { name }
//
// Umbenennen statt neu anlegen: der Laden haengt an bezahlten Preisen, und ein
// Tippfehler soll die Historie nicht spalten. Die Form (PUT mit { name }) ist
// die, die der geteilte Kategorie-Manager erwartet - so verwaltet dieselbe
// Komponente Kategorien und Laeden, ohne einen zweiten Schirm.
router.put('/stores/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid store ID.', code: 400 });
    const store = db.get().prepare('SELECT * FROM shopping_stores WHERE id = ?').get(id);
    if (!store) return res.status(404).json({ error: 'Store not found.', code: 404 });

    const vName = str(req.body.name, 'Name', { max: MAX_SHORT });
    const errors = collectErrors([vName]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const kollision = db.get().prepare(
      'SELECT id FROM shopping_stores WHERE name = ? COLLATE NOCASE AND id != ?'
    ).get(vName.value, id);
    if (kollision) return res.status(409).json({ error: 'Diesen Laden gibt es schon.', code: 409 });

    db.get().prepare('UPDATE shopping_stores SET name = ? WHERE id = ?').run(vName.value, id);
    res.json({ data: db.get().prepare('SELECT * FROM shopping_stores WHERE id = ?').get(id) });
  } catch (err) {
    log.error('PUT /stores/:id error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

// DELETE /api/v1/shopping/stores/:id
router.delete('/stores/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid store ID.', code: 400 });
    const store = db.get().prepare('SELECT id FROM shopping_stores WHERE id = ?').get(id);
    if (!store) return res.status(404).json({ error: 'Store not found.', code: 404 });
    // Der Fremdschluessel steht auf SET NULL: bezahlte Preise bleiben stehen,
    // sie verlieren nur ihren Laden. Was einmal bezahlt wurde, bleibt wahr.
    db.get().prepare('DELETE FROM shopping_stores WHERE id = ?').run(id);
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /stores/:id error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

// --------------------------------------------------------
// Artikel aktualisieren (is_checked, name, quantity, category, notes, url).
// Body: { is_checked?, name?, quantity?, category?, notes?, url? }
// Response: { data: ShoppingItem }
// --------------------------------------------------------
router.patch('/items/:itemId', (req, res) => {
  try {
    const item = db.get()
      .prepare('SELECT * FROM shopping_items WHERE id = ?')
      .get(req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Item not found.', code: 404 });

    const {
      is_checked = item.is_checked,
      name       = item.name,
      quantity   = item.quantity,
      category   = item.category,
      notes      = item.notes,
      url: urlVal = item.url,
    } = req.body;

    /* PREIS UND LADEN (#1003, erster Schnitt).
     *
     * Beide sind optional und werden beim ABHAKEN erfasst - das ist der
     * Augenblick, in dem die Zahl bekannt ist. Ein Preis, der beim Anlegen
     * eingetippt wird, ist eine Schaetzung; einer beim Abhaken ist eine
     * Tatsache.
     *
     * Nicht mitgeschickt heisst unveraendert, `null` loescht - dieselbe
     * Unterscheidung wie beim Rezeptbild und aus demselben Grund: sonst raeumt
     * jedes Teil-Update, etwa das blosse Umsortieren, den Preis ab.
     */
    const priceGiven = req.body.price_cents !== undefined;
    let priceCents = item.price_cents;
    if (priceGiven) {
      const roh = req.body.price_cents;
      if (roh === null || roh === '') priceCents = null;
      else {
        const n = Number(roh);
        // Ganze Cent, nicht negativ, und eine Obergrenze, damit ein Vertipper
        // nicht als Millionenbetrag in der spaeteren Historie steht.
        if (!Number.isInteger(n) || n < 0 || n > 100_000_000) {
          return res.status(400).json({ error: 'price_cents muss eine ganze Zahl in Cent zwischen 0 und 100000000 sein.', code: 400 });
        }
        priceCents = n;
      }
    }

    const storeGiven = req.body.store_id !== undefined;
    let storeId = item.store_id;
    if (storeGiven) {
      const roh = req.body.store_id;
      if (roh === null || roh === '') storeId = null;
      else {
        const n = Number(roh);
        if (!Number.isInteger(n) || n <= 0) {
          return res.status(400).json({ error: 'store_id muss eine Laden-ID sein.', code: 400 });
        }
        // Ein unbekannter Laden wird abgelehnt statt still verworfen: anders als
        // bei einer Personenauswahl ist das hier ein Aufruffehler - die Liste
        // der Laeden ist verwaltet und kurz.
        if (!db.get().prepare('SELECT 1 FROM shopping_stores WHERE id = ?').get(n)) {
          return res.status(400).json({ error: 'Unbekannter Laden.', code: 400 });
        }
        storeId = n;
      }
    }

    if (!name?.trim()) return res.status(400).json({ error: 'name darf nicht leer sein.', code: 400 });

    const validNames = validCategoryNames();
    if (category && !validNames.includes(category))
      return res.status(400).json({ error: 'Invalid category.', code: 400 });

    // notes/url gleich validieren wie beim Anlegen (URL nur http/https → XSS-sicher).
    const vNotes = str(notes, 'Notiz', { max: MAX_TEXT, required: false });
    const vUrl   = url(urlVal, 'URL');
    const fieldErrors = collectErrors([vNotes, vUrl]);
    if (fieldErrors.length) return res.status(400).json({ error: fieldErrors.join(' '), code: 400 });

    db.get().prepare(`
      UPDATE shopping_items
      SET is_checked = ?, name = ?, quantity = ?, category = ?, notes = ?, url = ?,
          price_cents = ?, store_id = ?
      WHERE id = ?
    `).run(is_checked ? 1 : 0, name.trim(), quantity ?? null, category, vNotes.value, vUrl.value,
      priceCents ?? null, storeId ?? null, req.params.itemId);

    // Kategoriewechsel heißt Positionswechsel: die Handsortierung zählt je
    // Kategorie (#678), der alte Rang gilt in der neuen Nachbarschaft nicht.
    // Ans Ende - dort landet in dieser Liste auch alles neu Hinzugefügte.
    if (category !== item.category) {
      db.get().prepare(`
        UPDATE shopping_items SET sort_order = COALESCE((
          SELECT MAX(sort_order) FROM shopping_items
           WHERE list_id = ? AND category = ? AND id != ?
        ), 0) + 1 WHERE id = ?
      `).run(item.list_id, category, item.id, item.id);
    }

    const updated = db.get()
      .prepare('SELECT * FROM shopping_items WHERE id = ?')
      .get(req.params.itemId);

    // Abhaken oder Umbenennen eines gespiegelten Artikels zieht auf dem
    // CalDAV-Server nach (#617).
    const pending = markTodoOutbound('shopping', item, updated);

    res.json({ data: updated });

    if (pending) pushToCalDAV('Änderung');
  } catch (err) {
    log.error('PATCH items/:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/shopping/items/undo-transfer
// Nimmt einen Übertrag aus einem Nachbar-Tab der Küche zurück.
// Body: { ids: number[] } - die `added_ids` aus der Transfer-Antwort.
// Response: { data: { removed: number } }
//
// Die drei erzeugenden Pfade der Küche (Vorrat, Rezept, Mahlzeit → Einkauf)
// nehmen über DIESE Route zurück, nicht über N einzelne DELETEs. Zwei Gründe:
//
//   1. Ein Übertrag ist eine Handlung, also ist auch seine Rücknahme eine.
//      Einzel-DELETEs können zur Hälfte scheitern und lassen dann einen Zustand
//      zurück, den der Nutzer nie hergestellt hat. Hier ist es eine Transaktion.
//   2. Der Mahlzeit-Pfad setzt beim Übertragen `meal_ingredients.on_shopping_list`.
//      Wer nur die Einkaufsartikel löscht, lässt die Zutaten für immer als „schon
//      übertragen" zurück - weder auf der Liste noch erneut übertragbar. Das Flag
//      gehört zum Übertrag und muss mit ihm zurück (Audit 2026-07-30, P1-B).
//
// Zugeordnet wird über `added_from_meal` + Name: der Übertrag hat genau die
// offenen Zutaten dieser Mahlzeit eingefügt, der Name ist innerhalb einer
// Mahlzeit ihre Identität. Ein Doppelname wäre gemeinsam übertragen worden und
// geht damit auch gemeinsam zurück.
//
// Fremde IDs werden still übergangen statt mit 404 quittiert: `removed` sagt,
// was tatsächlich zurückging, und ein Undo, das mit einem Fehler endet, weil ein
// Artikel inzwischen von Hand gelöscht wurde, wäre die schlechtere Antwort.
// --------------------------------------------------------
router.post('/items/undo-transfer', (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.map(Number).filter(Number.isInteger)
      : [];
    if (!ids.length) return res.json({ data: { removed: 0 } });

    const removed = db.get().transaction(() => {
      const findItem = db.get()
        .prepare('SELECT id, name, added_from_meal FROM shopping_items WHERE id = ?');
      const deleteItem = db.get().prepare('DELETE FROM shopping_items WHERE id = ?');
      const unmarkIngredient = db.get().prepare(`
        UPDATE meal_ingredients SET on_shopping_list = 0
        WHERE meal_id = ? AND name = ? AND on_shopping_list = 1
      `);

      let count = 0;
      for (const id of ids) {
        const item = findItem.get(id);
        if (!item) continue;
        deleteItem.run(id);
        if (item.added_from_meal) unmarkIngredient.run(item.added_from_meal, item.name);
        count += 1;
      }
      return count;
    })();

    res.json({ data: { removed } });
  } catch (err) {
    log.error('POST /items/undo-transfer error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/shopping/items/:itemId
// Einzelnen Artikel löschen.
// Response: { ok: true }
// --------------------------------------------------------
router.delete('/items/:itemId', (req, res) => {
  try {
    const queued = queueTodoDeletions('shopping', mirroredItems('id = ?', req.params.itemId));

    const result = db.get()
      .prepare('DELETE FROM shopping_items WHERE id = ?')
      .run(req.params.itemId);
    if (result.changes === 0)
      return res.status(404).json({ error: 'Item not found.', code: 404 });
    res.json({ ok: true });

    if (queued) pushToCalDAV('Löschung');
  } catch (err) {
    log.error('DELETE items/:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/shopping
// Alle Einkaufslisten mit Artikel-Zähler.
// Response: { data: ShoppingList[] }
// --------------------------------------------------------
router.get('/', (req, res) => {
  try {
    const lists = db.get().prepare(`
      SELECT
        sl.*,
        COUNT(si.id)                                          AS item_total,
        SUM(CASE WHEN si.is_checked = 1 THEN 1 ELSE 0 END)   AS item_checked
      FROM shopping_lists sl
      LEFT JOIN shopping_items si ON si.list_id = sl.id
      GROUP BY sl.id
      ORDER BY sl.created_at ASC
    `).all();
    res.json({ data: lists });
  } catch (err) {
    log.error('GET / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/shopping
// Neue Einkaufsliste erstellen.
// Body: { name }
// Response: { data: ShoppingList }
// --------------------------------------------------------
router.post('/', (req, res) => {
  try {
    const vName = str(req.body.name, 'Name', { max: MAX_TITLE });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const result = db.get()
      .prepare('INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)')
      .run(vName.value, req.authUserId || req.session.userId);

    const list = db.get()
      .prepare('SELECT * FROM shopping_lists WHERE id = ?')
      .get(result.lastInsertRowid);
    res.status(201).json({ data: list });
  } catch (err) {
    log.error('POST / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PUT /api/v1/shopping/:listId
// Einkaufsliste umbenennen.
// Body: { name }
// Response: { data: ShoppingList }
// --------------------------------------------------------
router.put('/:listId', (req, res) => {
  try {
    const vName = str(req.body.name, 'Name', { max: MAX_TITLE });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const result = db.get()
      .prepare('UPDATE shopping_lists SET name = ? WHERE id = ?')
      .run(vName.value, req.params.listId);
    if (result.changes === 0)
      return res.status(404).json({ error: 'List not found.', code: 404 });

    const list = db.get()
      .prepare('SELECT * FROM shopping_lists WHERE id = ?')
      .get(req.params.listId);
    res.json({ data: list });
  } catch (err) {
    log.error('PUT /:listId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/shopping/:listId/duplicate
// Liste als neue Liste kopieren (#1103) - "der Einkauf letzte Woche war gut,
// das meiste davon wieder", ohne die alte Liste anzutasten.
// Body: { name, resetChecked?, keepQuantities?, keepNotes? }  (die drei Flags
//        sind alle standardmaessig an)
// Response: { data: ShoppingList }
//
// KATEGORIE UND HANDSORTIERUNG WERDEN IMMER UEBERNOMMEN - das ist der Punkt
// des Duplizierens, kein Schalter. Was NIE mitkopiert wird, unabhaengig von
// den Flags:
//
//   - Die CalDAV-Sync-Spalten (external_uid/external_source/...). Sie sind
//     eine Aussage ueber EIN Sync-Objekt auf einem fremden Server - eine
//     unveraenderte Kopie wuerde jede Aenderung der Kopie auf dasselbe
//     entfernte VTODO schreiben und jedes Loeschen der Kopie dessen Loeschung
//     dort anstossen (siehe auch die Diskussion in #998). Eine Kopie ist ein
//     neuer, lokaler Artikel, der beim naechsten Sync-Lauf ganz normal neu
//     angelegt wird, falls die Zielliste selbst gespiegelt ist.
//   - added_from_meal: eine Kopie stammt aus dieser Aktion, nicht aus der
//     Mahlzeit, aus der der ORIGINAL-Artikel kam.
//   - price_cents UND store_id: beide sind eine Tatsache ueber einen EINKAUF -
//     "einmal bezahlt, in diesem Laden" (#1003) - eine Kopie wurde noch nicht
//     bezahlt, ihr fehlen beide Tatsachen, die Preis und Laden festhalten
//     (Ruecksprache mit dem Maintainer auf #1103: derselbe Grund fuer beide,
//     nicht nur fuer den Preis).
// --------------------------------------------------------
router.post('/:listId/duplicate', (req, res) => {
  try {
    const list = db.get()
      .prepare('SELECT * FROM shopping_lists WHERE id = ?')
      .get(req.params.listId);
    if (!list) return res.status(404).json({ error: 'List not found.', code: 404 });

    const vName = str(req.body.name, 'Name', { max: MAX_TITLE });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const resetChecked   = req.body.resetChecked !== false;
    const keepQuantities = req.body.keepQuantities !== false;
    const keepNotes      = req.body.keepNotes !== false;

    const items = db.get()
      .prepare('SELECT * FROM shopping_items WHERE list_id = ?')
      .all(req.params.listId);

    const newList = db.get().transaction(() => {
      const info = db.get()
        .prepare('INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)')
        .run(vName.value, req.authUserId || req.session.userId);
      const newListId = info.lastInsertRowid;

      const insertItem = db.get().prepare(`
        INSERT INTO shopping_items
          (list_id, name, quantity, category, is_checked, notes, url, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of items) {
        insertItem.run(
          newListId,
          item.name,
          keepQuantities ? item.quantity : null,
          item.category,
          resetChecked ? 0 : item.is_checked,
          keepNotes ? item.notes : null,
          keepNotes ? item.url : null,
          // Rang explizit uebernehmen statt dem Einfuege-Trigger zu ueberlassen
          // (der neue Zeilen mit sort_order=0 ans Ende ihrer Kategorie stellt) -
          // die Handsortierung IST das, was diese Route verspricht zu erhalten.
          item.sort_order,
        );
      }
      return db.get().prepare('SELECT * FROM shopping_lists WHERE id = ?').get(newListId);
    })();

    res.status(201).json({ data: newList });
  } catch (err) {
    log.error('POST /:listId/duplicate error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/shopping/:listId
// Liste und alle Artikel löschen (CASCADE).
// Response: { ok: true }
// --------------------------------------------------------
router.delete('/:listId', (req, res) => {
  try {
    // Die Artikel gehen per CASCADE mit, also müssen ihre Löschungen vorher
    // vorgemerkt sein (#617).
    const queued = queueTodoDeletions('shopping', mirroredItems('list_id = ?', req.params.listId));

    const result = db.get()
      .prepare('DELETE FROM shopping_lists WHERE id = ?')
      .run(req.params.listId);
    if (result.changes === 0)
      return res.status(404).json({ error: 'List not found.', code: 404 });
    res.json({ ok: true });

    if (queued) pushToCalDAV('Löschung');
  } catch (err) {
    log.error('DELETE /:listId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/shopping/:listId/items
// Alle Artikel einer Liste, sortiert nach Supermarkt-Gang-Logik.
// Abgehakte Artikel ans Ende innerhalb ihrer Kategorie, davor die von Hand
// gesetzte Reihenfolge (#678).
// Response: { data: ShoppingItem[], list: ShoppingList, categories: ShoppingCategory[] }
// --------------------------------------------------------
router.get('/:listId/items', (req, res) => {
  try {
    const list = db.get()
      .prepare('SELECT * FROM shopping_lists WHERE id = ?')
      .get(req.params.listId);
    if (!list) return res.status(404).json({ error: 'List not found.', code: 404 });

    const categories = loadCategories();
    res.json({ data: loadListItems(req.params.listId, categories), list, categories });
  } catch (err) {
    log.error('GET /:listId/items error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PATCH /api/v1/shopping/:listId/items/reorder
// Reihenfolge der Artikel INNERHALB einer Kategorie ändern (#678).
// Body: { category: string, order: number[] }  (Artikel-IDs in gewünschter Reihenfolge)
// Response: { data: ShoppingItem[], categories: ShoppingCategory[] }
//
// Je Kategorie und nicht über die ganze Liste: die Kategorie-Reihenfolge ist
// bereits ein eigener Griff (shopping_categories.sort_order, umsortierbar im
// Kategorie-Manager) und bildet den Ladenweg ab. Ein zweiter, listenweiter Rang
// daneben hätte zwei Aussagen über dieselbe Reihenfolge gemacht.
//
// Die Anfrage muss ALLE Artikel der Kategorie nennen. Eine Teilmenge würde die
// Ränge der Ausgelassenen mit den neu vergebenen kollidieren lassen - danach
// entschiede wieder created_at, und der Zug wäre teilweise verpufft.
// --------------------------------------------------------
router.patch('/:listId/items/reorder', (req, res) => {
  try {
    const list = db.get()
      .prepare('SELECT id FROM shopping_lists WHERE id = ?')
      .get(req.params.listId);
    if (!list) return res.status(404).json({ error: 'List not found.', code: 404 });

    const { category, order } = req.body;
    if (!Array.isArray(order) || order.length === 0)
      return res.status(400).json({ error: 'order muss ein nicht-leeres Array von IDs sein.', code: 400 });

    const ids = order.map(Number);
    if (ids.some((id) => !Number.isInteger(id)))
      return res.status(400).json({ error: 'order darf nur Artikel-IDs enthalten.', code: 400 });
    if (new Set(ids).size !== ids.length)
      return res.status(400).json({ error: 'order darf keine ID doppelt enthalten.', code: 400 });

    // oneOf lässt Leerwerte durch (es validiert optionale Felder); hier ist die
    // Kategorie der Geltungsbereich der Ränge und damit Pflicht.
    if (!category) return res.status(400).json({ error: 'category ist erforderlich.', code: 400 });
    const vCat = oneOf(category, validCategoryNames(), 'Kategorie');
    if (vCat.error) return res.status(400).json({ error: vCat.error, code: 400 });

    // Die Kategorie ist der Geltungsbereich der Ränge - eine fremde ID darin
    // würde einen Artikel einer anderen Liste oder Kategorie umnummerieren.
    const own = db.get()
      .prepare('SELECT id FROM shopping_items WHERE list_id = ? AND category = ?')
      .all(req.params.listId, vCat.value)
      .map((r) => r.id);
    const ownSet = new Set(own);
    if (ids.some((id) => !ownSet.has(id)))
      return res.status(400).json({ error: 'order enthält Artikel außerhalb dieser Liste oder Kategorie.', code: 400 });
    if (ids.length !== own.length)
      return res.status(400).json({ error: 'order muss alle Artikel der Kategorie enthalten.', code: 400 });

    const update = db.get().prepare('UPDATE shopping_items SET sort_order = ? WHERE id = ?');
    db.get().transaction(() => {
      // Ab 1: die 0 bleibt dem Trigger als Marke "noch nicht eingeordnet".
      ids.forEach((id, idx) => update.run(idx + 1, id));
    })();

    const categories = loadCategories();
    res.json({ data: loadListItems(req.params.listId, categories), categories });
  } catch (err) {
    log.error('PATCH /:listId/items/reorder error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/shopping/:listId/items
// Artikel zur Liste hinzufügen.
// Body: { name, quantity?, category?, notes?, url? }
// Response: { data: ShoppingItem }
// --------------------------------------------------------
router.post('/:listId/items', (req, res) => {
  try {
    const list = db.get()
      .prepare('SELECT id FROM shopping_lists WHERE id = ?')
      .get(req.params.listId);
    if (!list) return res.status(404).json({ error: 'List not found.', code: 404 });

    // Ohne Kategorie faellt der Artikel auf die LETZTE (#548, "Sonstiges"),
    // nicht die erste ("Obst & Gemuese" nach Gang-Reihenfolge) - genau das war
    // der gemeldete Fehler: unzusammenhaengende Artikel landeten automatisch
    // in der ersten Kategorie, statt in der neutralen Sammelkategorie. Der
    // Quick-Add-Client schickt die Kategorie ohnehin immer explizit mit;
    // dieser Rueckfall greift nur, wenn sie fehlt (z.B. direkter API-Aufruf).
    const validNames = validCategoryNames();
    const defaultCat = validNames[validNames.length - 1] ?? 'Sonstiges';
    const requestedCat = req.body.category || defaultCat;

    const vName  = str(req.body.name, 'Name', { max: MAX_TITLE });
    const vQty   = str(req.body.quantity, 'Menge', { max: MAX_SHORT, required: false });
    const vCat   = oneOf(requestedCat, validNames, 'Kategorie');
    const vNotes = str(req.body.notes, 'Notiz', { max: MAX_TEXT, required: false });
    const vUrl   = url(req.body.url, 'URL');
    const errors = collectErrors([vName, vQty, vCat, vNotes, vUrl]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const result = db.get().prepare(`
      INSERT INTO shopping_items (list_id, name, quantity, category, notes, url)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(req.params.listId, vName.value, vQty.value, vCat.value || defaultCat, vNotes.value, vUrl.value);

    const item = db.get()
      .prepare('SELECT * FROM shopping_items WHERE id = ?')
      .get(result.lastInsertRowid);
    res.status(201).json({ data: item });
    // Gehört die Liste zu einer gespiegelten CalDAV-Liste, wandert der neue
    // Artikel gleich mit (#831) - sonst hinge er bis zum nächsten Sync-Intervall
    // fest, während Umbenennen und Abhaken sofort hinausgehen.
    pushToCalDAV('Neuer Einkaufsartikel');
  } catch (err) {
    log.error('POST /:listId/items error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/shopping/:listId/send
// Die offenen Artikel der Liste an ein Haushaltsmitglied mailen (#944).
// Body: { userId: number }   Response: { data: { sent: true, items: number } }
//
// DER EMPFAENGER IST EINE ID, NIE EINE ADRESSE. Naeme diese Route eine Adresse
// aus dem Rumpf entgegen, waere Yuvomi fuer jeden angemeldeten Nutzer ein
// offener Mailversender: beliebiger Text an beliebige Empfaenger, abgeschickt
// vom SMTP-Server des Haushalts und in dessen Ruf. Die Adresse loest deshalb
// der Server auf, aus derselben Quelle wie beim Passwort-Reset, und ein
// Mitglied ohne hinterlegte Adresse ist schlicht nicht erreichbar.
//
// Gesendet wird eine Abschrift, kein Zugang: kein Link, kein Token, nichts das
// weiterlebt. Wer die Liste laufend braucht, ist Mitglied und hat die App.
// --------------------------------------------------------
router.post('/:listId/send', sendListLimiter, async (req, res) => {
  // Diese Datei exportiert einen fertigen Router, keine Fabrik - eine
  // Abhaengigkeit laesst sich daher nicht ueber Parameter hineinreichen.
  // `app.locals` ist der Express-eigene Platz dafuer und hier der kleinere
  // Eingriff, als die Datei samt aller Aufrufer umzubauen. Im Betrieb ist der
  // Wert nie gesetzt und es bleibt beim Standarddienst.
  const emailService = req.app?.locals?.emailService || defaultEmailService;
  try {
    const list = db.get().prepare('SELECT * FROM shopping_lists WHERE id = ?').get(req.params.listId);
    if (!list) return res.status(404).json({ error: 'List not found.', code: 404 });

    const userId = Number(req.body?.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'A recipient userId is required.', code: 400 });
    }

    // Reihenfolge der Pruefungen ist Absicht: erst der Empfaenger, dann die
    // Einrichtung, dann der Inhalt. Jede Meldung nennt genau eine Ursache und
    // die naechste Handlung - "es ging nicht" waere hier dreimal dasselbe Wort
    // fuer drei verschiedene Aufgaben.
    // NICHT einfach "gibt es diese users-Zeile": Hauspersonal und
    // Geteilte-Ausgaben-Gaeste haben ebenfalls ein Konto und einen Kontakt mit
    // Adresse, sind aber keine Haushaltsmitglieder - ein Gast ist ausdruecklich
    // ein Externer, den index.js aus jeder anderen /api/v1-Route aussperrt. Die
    // Auswahl im Dialog zeigt beide nicht; sie hier trotzdem anzunehmen hiesse,
    // die Grenze nur zu verstecken statt sie zu ziehen. Dieselbe Antwort wie
    // fuer ein unbekanntes Konto, damit sich aus ihr nicht ablesen laesst,
    // welche Konten es gibt.
    if (!isHouseholdMember(userId, { db: db.get() })) {
      return res.status(404).json({ error: 'Recipient not found.', code: 404 });
    }
    const recipient = db.get().prepare('SELECT id, display_name FROM users WHERE id = ?').get(userId);

    // `reason` neben der Meldung: die drei Absagen sind alle 422, und der Text
    // ist englisch wie jede Server-Meldung hier. Ohne eine maschinenlesbare
    // Unterscheidung koennte die Oberflaeche sie nicht in ihrer eigenen Sprache
    // ausdruecken - der Nutzen der drei getrennten Gruende endet sonst an der
    // Sprachgrenze. Additiv, also fuer bestehende Aufrufer unveraendert.
    const to = memberEmail(userId, { db: db.get() });
    if (!to) {
      return res.status(422).json({
        error: 'This member has no email address on their contact.', code: 422, reason: 'recipient_no_email',
      });
    }
    if (!emailService.isConfigured()) {
      return res.status(422).json({
        error: 'Email is not configured. Set up SMTP in Settings first.', code: 422, reason: 'smtp_unconfigured',
      });
    }

    const categories = loadCategories();
    const items = loadListItems(req.params.listId, categories);
    // Wer sich die Liste selbst schickt, braucht kein "X hat dir diese Liste
    // geschickt" ueber der eigenen Einkaufsliste.
    const sender = userId === req.authUserId
      ? null
      : db.get().prepare('SELECT display_name FROM users WHERE id = ?').get(req.authUserId);
    const wall = utcToWall(new Date().toISOString(), householdTimeZone(db.get()));
    const sentAt = wall ? `${wall.date} ${wall.time}` : new Date().toISOString().slice(0, 16).replace('T', ' ');

    let mail;
    try {
      mail = buildShoppingListMail({
        list,
        items,
        categories,
        senderName: sender?.display_name || null,
        sentAt,
      });
    } catch (err) {
      // Eine leere Liste ist kein Serverfehler, sondern eine Eingabe, die
      // nichts bewirken kann.
      return res.status(422).json({ error: err.message || 'Nothing to send.', code: 422, reason: 'nothing_open' });
    }

    await emailService.sendMail({
      to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      // Betreff und Rumpf tragen Listennamen und Artikel, also Nutzertexte.
      // Sie gehoeren in die Mail, nicht in das Log des Servers.
      logLabel: 'shopping list',
    });
    res.json({ data: { sent: true, items: mail.openCount } });
  } catch (err) {
    log.error('POST /:listId/send error:', err.message);
    res.status(502).json({ error: 'The email could not be sent.', code: 502 });
  }
});

// --------------------------------------------------------
// POST /api/v1/shopping/:listId/import-meal-plan
// Importiert Zutaten aus dem Essensplan eines Datumsbereichs in eine Liste.
// Body: { from: YYYY-MM-DD, to: YYYY-MM-DD, preview?: boolean }
// preview:true rechnet nur (keine Schreib-Transaktion) - für die Vorschau
// "X Zutaten aus Y Mahlzeiten" im Import-Dialog (Audit A1-22).
// Response: { data: { transferred: number, added: number, meals: number, preview?: true } }
// --------------------------------------------------------
router.post('/:listId/import-meal-plan', (req, res) => {
  try {
    const list = db.get()
      .prepare('SELECT id FROM shopping_lists WHERE id = ?')
      .get(req.params.listId);
    if (!list) return res.status(404).json({ error: 'List not found.', code: 404 });

    const vFrom = date(req.body.from, 'From date', true);
    const vTo = date(req.body.to, 'To date', true);
    const errors = collectErrors([vFrom, vTo]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    if (vFrom.value > vTo.value) {
      return res.status(400).json({ error: 'From date must be before or equal to end date.', code: 400 });
    }

    const ingredients = db.get().prepare(`
      SELECT mi.id, mi.meal_id, mi.name, mi.quantity, mi.category
      FROM meal_ingredients mi
      JOIN meals m ON m.id = mi.meal_id
      WHERE m.date BETWEEN ? AND ?
        AND mi.on_shopping_list = 0
      ORDER BY m.date ASC, mi.id ASC
    `).all(vFrom.value, vTo.value);

    if (!ingredients.length) {
      return res.json({ data: { transferred: 0, added: 0, meals: 0 } });
    }

    const mealCount = new Set(ingredients.map((i) => i.meal_id)).size;
    const aggregated = aggregateMealIngredients(ingredients);

    // Vorschau (Audit A1-22): identische Auswahl und Aggregation, aber ohne
    // Schreib-Transaktion. Der Client zeigt "X Zutaten aus Y Mahlzeiten",
    // bevor der Nutzer den Import bestätigt.
    if (req.body.preview === true) {
      return res.json({ data: { transferred: ingredients.length, added: aggregated.length, meals: mealCount, preview: true } });
    }

    const added = db.get().transaction(() => {
      const insertItem = db.get().prepare(`
        INSERT INTO shopping_items (list_id, name, quantity, category, added_from_meal)
        VALUES (?, ?, ?, ?, ?)
      `);
      const markDone = db.get().prepare('UPDATE meal_ingredients SET on_shopping_list = 1 WHERE id = ?');

      for (const item of aggregated) {
        insertItem.run(req.params.listId, item.name, item.quantity, item.category, item.added_from_meal);
      }
      for (const ingredient of ingredients) {
        markDone.run(ingredient.id);
      }
      return aggregated.length;
    })();

    res.json({ data: { transferred: ingredients.length, added, meals: mealCount } });
  } catch (err) {
    log.error('POST /:listId/import-meal-plan error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/shopping/:listId/import-pantry
// Setzt Vorratsartikel auf die Einkaufsliste (leer oder unter Mindestbestand).
// Body: { items: [{ pantry_item_id, quantity? }] }
//
// Die Mengen-Angabe kommt als fertiger Anzeigetext vom Client: shopping_items.quantity
// ist Freitext, und die Einheiten des Vorrats ('pcs', 'can', …) sind erst über t()
// lesbar. Die Übersetzung bleibt damit im Frontend, wo sie hingehört.
//
// Liegt derselbe Name bereits unabgehakt auf der Liste, wird übersprungen statt
// dupliziert - zweimal "Milch" hilft im Supermarkt niemandem.
// Response: { data: { added: number, skipped: number, added_ids: number[] } }
//
// `added_ids` traegt das Undo im Client: der Warenkorb in einer Vorratszeile war
// die einzige Aktion des Kuechenmoduls, die etwas erzeugt und dafuer kein
// Zuruecknehmen anbot - und sie sitzt 4px neben "Menge erhoehen", das das
// Gegenteil bedeutet (Critique 2026-07-30). Ein verzoegerter Commit waere die
// Alternative gewesen; dann muesste der Toast eine Anzahl versprechen, die erst
// der Server kennt (Duplikate werden hier uebersprungen). Deshalb echtes Undo:
// sofort einfuegen, IDs zurueckgeben, auf Wunsch genau diese wieder loeschen.
// --------------------------------------------------------
router.post('/:listId/import-pantry', (req, res) => {
  try {
    const list = db.get()
      .prepare('SELECT id FROM shopping_lists WHERE id = ?')
      .get(req.params.listId);
    if (!list) return res.status(404).json({ error: 'List not found.', code: 404 });

    const entries = Array.isArray(req.body.items) ? req.body.items : [];
    if (!entries.length) return res.json({ data: { added: 0, skipped: 0, added_ids: [] } });

    const validNames = validCategoryNames();
    const defaultCat = validNames[validNames.length - 1] ?? 'Sonstiges';

    const result = db.get().transaction(() => {
      const findPantryItem = db.get().prepare('SELECT name, category FROM pantry_items WHERE id = ?');
      const findDuplicate = db.get().prepare(`
        SELECT id FROM shopping_items
        WHERE list_id = ? AND is_checked = 0 AND name = ? COLLATE NOCASE
        LIMIT 1
      `);
      const insertItem = db.get().prepare(`
        INSERT INTO shopping_items (list_id, name, quantity, category) VALUES (?, ?, ?, ?)
      `);

      let skipped = 0;
      const addedIds = [];

      for (const entry of entries) {
        const pantryItem = findPantryItem.get(Number(entry?.pantry_item_id));
        if (!pantryItem) { skipped += 1; continue; }
        if (findDuplicate.get(req.params.listId, pantryItem.name)) { skipped += 1; continue; }

        const vQty = str(entry.quantity, 'Menge', { max: MAX_SHORT, required: false });
        const category = validNames.includes(pantryItem.category) ? pantryItem.category : defaultCat;
        const info = insertItem.run(req.params.listId, pantryItem.name, vQty.value, category);
        addedIds.push(Number(info.lastInsertRowid));
      }

      return { added: addedIds.length, skipped, added_ids: addedIds };
    })();

    res.json({ data: result });
  } catch (err) {
    log.error('POST /:listId/import-pantry error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/shopping/:listId/items/checked
// Alle abgehakten Artikel aus einer Liste löschen.
// Response: { deleted: number }
// --------------------------------------------------------
router.delete('/:listId/items/checked', (req, res) => {
  try {
    const queued = queueTodoDeletions(
      'shopping', mirroredItems('list_id = ? AND is_checked = 1', req.params.listId)
    );

    const result = db.get().prepare(`
      DELETE FROM shopping_items WHERE list_id = ? AND is_checked = 1
    `).run(req.params.listId);
    res.json({ deleted: result.changes });

    if (queued) pushToCalDAV('Löschung');
  } catch (err) {
    log.error('DELETE /:listId/items/checked error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// Der Versand-Limiter, damit ihn eine Testsuite zwischen den Faellen zuruecksetzen
// kann. Die Grenze bleibt so bei der Zahl, die fuer den Betrieb richtig ist,
// statt auf die Zahl anzuwachsen, die eine Testdatei gerade braucht.
export const __test = { sendListLimiter };

export default router;
