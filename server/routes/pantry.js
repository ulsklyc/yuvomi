/**
 * Modul: Vorrat (Pantry)
 * Zweck: REST-API für Vorratsartikel und Lagerorte (#596)
 * Abhängigkeiten: express, server/db.js, public/utils/pantry-units.js (isomorph)
 *
 * Routen-Reihenfolge: statische Pfade (/locations, /import-shopping) stehen vor
 * dynamischen (/:itemId), damit Express korrekt matcht - dasselbe Muster wie im
 * Einkaufs-Router.
 *
 * Kein Eigentümer-Gate: der Vorrat ist Haushaltsbesitz wie die Einkaufsliste,
 * nicht Privatbesitz wie ein Rezept. Wer die Milch aus dem Kühlschrank nimmt,
 * muss sie auch ausbuchen dürfen, egal wer sie eingetragen hat. `created_by`
 * bleibt als Herkunftsnachweis erhalten.
 *
 * Every write of a batch's name, unit or category puts the batch into its
 * household product in the same transaction (assignPantryProduct, #1448).
 */

import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { str, oneOf, num, date, id as idParam, collectErrors, MAX_TITLE, MAX_TEXT, MAX_SHORT } from '../middleware/validate.js';
import { normalizePantryUnit, normalizePantryQuantity, convertPantryQuantity } from '../../public/utils/pantry-units.js';
import { syncPantryExpiryReminder, resolvePantryAccess } from '../services/pantry-reminders.js';
import { assignPantryProduct, productKey } from '../services/pantry-products.js';
import { todayKey as householdToday } from '../utils/timezone.js';
import { mayReadModule } from '../permissions.js';

const log = createLogger('Pantry');
const router = express.Router();

// --------------------------------------------------------
// Hilfsfunktionen
// --------------------------------------------------------

function loadLocations() {
  return db.get().prepare('SELECT * FROM pantry_locations ORDER BY sort_order ASC, id ASC').all();
}

/**
 * The household products with the number of batches each one has (#1448). A
 * product outlives its last batch, so this is the only place a product without
 * batches can be seen: the stock page shows it as out of stock. The batches
 * themselves stay in `data`; this list only names the products.
 */
function loadProducts() {
  return db.get().prepare(`
    SELECT p.id, p.name, p.unit, p.category, COUNT(pi.id) AS batch_count
    FROM pantry_products p
    LEFT JOIN pantry_items pi ON pi.product_id = p.id
    GROUP BY p.id
    ORDER BY p.name COLLATE NOCASE ASC, p.id ASC
  `).all();
}

function loadCategories() {
  return db.get().prepare('SELECT * FROM shopping_categories ORDER BY sort_order ASC').all();
}

function validCategoryNames() {
  return loadCategories().map((c) => c.name);
}

function getItem(itemId) {
  return db.get().prepare('SELECT * FROM pantry_items WHERE id = ?').get(itemId);
}

/**
 * Kurze Fassade auf server/services/pantry-reminders.js: die Regel, WANN ein
 * Artikel meldet, steht dort - sie wird auch vom Push-Lauf gebraucht, der den
 * ganzen Bestand nachzieht, und darf deshalb nicht im Router wohnen.
 */
function syncReminder(item, access = null, today = null) {
  // `clampToNextMorning`: auf DIESEM Weg hat gerade jemand gehandelt. Ein
  // frisch gekaufter Joghurt mit fünf Tagen MHD bekäme sonst nie eine Meldung,
  // weil sein Vorlauf schon verstrichen ist - die Begründung steht am
  // Vergangenheits-Riegel in server/services/pantry-reminders.js.
  syncPantryExpiryReminder(db.get(), item, new Date(), access, { clampToNextMorning: true, today });
}

/**
 * Artikel in Anzeige-Reihenfolge: nach Lagerort-Sortierung, ortlose ans Ende,
 * innerhalb des Ortes alphabetisch (NOCASE). Dieselbe Reihenfolge, die die
 * Seite gruppiert rendert - der Client muss nichts nachsortieren.
 */
function loadItems() {
  return db.get().prepare(`
    SELECT pi.*, pl.name AS location_name, pl.icon AS location_icon
    FROM pantry_items pi
    LEFT JOIN pantry_locations pl ON pl.id = pi.location_id
    ORDER BY
      CASE WHEN pi.location_id IS NULL THEN 1 ELSE 0 END,
      pl.sort_order ASC,
      pi.name COLLATE NOCASE ASC,
      pi.id ASC
  `).all();
}

/**
 * Validiert die Felder eines Artikels. `partial: true` lässt fehlende Felder
 * unangetastet (PATCH), sonst gelten die Defaults für ein neues Objekt.
 * @returns {{ values: object|null, errors: string[] }}
 */
function validateItemFields(body, { partial = false, current = null } = {}) {
  const values = {};
  const results = [];

  if (!partial || body.name !== undefined) {
    const vName = str(body.name, 'name', { max: MAX_TITLE });
    results.push(vName);
    values.name = vName.value;
  }

  if (!partial || body.quantity !== undefined) {
    const vQty = num(body.quantity, 'quantity');
    results.push(vQty);
    if (vQty.value !== null && vQty.value < 0) {
      results.push({ error: 'quantity must not be negative.' });
    }
    // null/leer explizit abfangen: normalizePantryQuantity(null) wäre 0, und
    // "Artikel ohne Mengenangabe" heißt 1 Stück, nicht "leer".
    const fallbackQty = partial ? Number(current?.quantity ?? 1) : 1;
    values.quantity = vQty.value === null
      ? normalizePantryQuantity(fallbackQty, { fallback: 1 })
      : normalizePantryQuantity(vQty.value, { fallback: 1 });
  }

  // Einheit normalisiert statt validiert - siehe pantry-units.js.
  if (!partial || body.unit !== undefined) {
    values.unit = normalizePantryUnit(body.unit ?? current?.unit);
  }

  if (!partial || body.location_id !== undefined) {
    if (body.location_id === null || body.location_id === '' || body.location_id === undefined) {
      values.location_id = null;
    } else {
      const vLoc = idParam(body.location_id, 'location_id');
      results.push(vLoc);
      if (vLoc.value !== null) {
        const exists = db.get().prepare('SELECT id FROM pantry_locations WHERE id = ?').get(vLoc.value);
        if (!exists) results.push({ error: 'Location not found.' });
      }
      values.location_id = vLoc.value;
    }
  }

  if (!partial || body.category !== undefined) {
    const names = validCategoryNames();
    const fallback = current?.category ?? names[names.length - 1] ?? 'Sonstiges';
    const requested = body.category || fallback;
    const vCat = oneOf(requested, names, 'category');
    results.push(vCat);
    values.category = vCat.value ?? fallback;
  }

  if (!partial || body.expires_on !== undefined) {
    const vExp = date(body.expires_on, 'expires_on');
    results.push(vExp);
    values.expires_on = vExp.value;
  }

  if (!partial || body.min_quantity !== undefined) {
    if (body.min_quantity === null || body.min_quantity === '' || body.min_quantity === undefined) {
      values.min_quantity = null;
    } else {
      const vMin = num(body.min_quantity, 'min_quantity');
      results.push(vMin);
      if (vMin.value !== null && vMin.value < 0) {
        results.push({ error: 'min_quantity must not be negative.' });
      }
      values.min_quantity = vMin.value === null ? null : normalizePantryQuantity(vMin.value, { fallback: 0 });
    }
  }

  if (!partial || body.notes !== undefined) {
    const vNotes = str(body.notes, 'notes', { max: MAX_TEXT, required: false });
    results.push(vNotes);
    values.notes = vNotes.value;
  }

  return { values, errors: collectErrors(results) };
}

// --------------------------------------------------------
// GET /api/v1/pantry/locations
// Alle Lagerorte in Sortierreihenfolge.
// Response: { data: PantryLocation[] }
// --------------------------------------------------------
router.get('/locations', (_req, res) => {
  try {
    res.json({ data: loadLocations() });
  } catch (err) {
    log.error('GET /locations error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/pantry/locations
// Body: { name, icon? }
// Response: { data: PantryLocation }
// --------------------------------------------------------
router.post('/locations', (req, res) => {
  try {
    const vName = str(req.body.name, 'name', { max: MAX_SHORT });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const existing = db.get()
      .prepare('SELECT id FROM pantry_locations WHERE name = ? COLLATE NOCASE')
      .get(vName.value);
    if (existing) return res.status(409).json({ error: 'Storage location already exists.', code: 409 });

    const vIcon = str(req.body.icon, 'icon', { max: MAX_SHORT, required: false });
    if (vIcon.error) return res.status(400).json({ error: vIcon.error, code: 400 });

    const maxOrder = db.get()
      .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM pantry_locations')
      .get().m;

    const result = db.get()
      .prepare('INSERT INTO pantry_locations (name, icon, sort_order) VALUES (?, ?, ?)')
      .run(vName.value, vIcon.value ?? 'package', maxOrder + 1);

    res.status(201).json({
      data: db.get().prepare('SELECT * FROM pantry_locations WHERE id = ?').get(result.lastInsertRowid),
    });
  } catch (err) {
    log.error('POST /locations error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PATCH /api/v1/pantry/locations/reorder
// Body: { order: number[] }  (IDs in gewünschter Reihenfolge)
// Response: { data: PantryLocation[] }
// --------------------------------------------------------
router.patch('/locations/reorder', (req, res) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order) || order.length === 0)
      return res.status(400).json({ error: 'order must be a non-empty array of IDs.', code: 400 });

    const update = db.get().prepare('UPDATE pantry_locations SET sort_order = ? WHERE id = ?');
    db.get().transaction(() => {
      order.forEach((locId, idx) => update.run(idx, locId));
    })();

    res.json({ data: loadLocations() });
  } catch (err) {
    log.error('PATCH /locations/reorder error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PUT /api/v1/pantry/locations/:locId
// Body: { name?, icon? }
// Response: { data: PantryLocation }
// --------------------------------------------------------
router.put('/locations/:locId', (req, res) => {
  try {
    const vId = idParam(req.params.locId, 'locId');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });

    const loc = db.get().prepare('SELECT * FROM pantry_locations WHERE id = ?').get(vId.value);
    if (!loc) return res.status(404).json({ error: 'Storage location not found.', code: 404 });

    const vName = str(req.body.name, 'name', { max: MAX_SHORT });
    const vIcon = str(req.body.icon, 'icon', { max: MAX_SHORT, required: false });
    const errors = collectErrors([vName, vIcon]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const conflict = db.get()
      .prepare('SELECT id FROM pantry_locations WHERE name = ? COLLATE NOCASE AND id != ?')
      .get(vName.value, loc.id);
    if (conflict) return res.status(409).json({ error: 'Storage location already exists.', code: 409 });

    db.get()
      .prepare('UPDATE pantry_locations SET name = ?, icon = ? WHERE id = ?')
      .run(vName.value, vIcon.value ?? loc.icon, loc.id);

    res.json({ data: db.get().prepare('SELECT * FROM pantry_locations WHERE id = ?').get(loc.id) });
  } catch (err) {
    log.error('PUT /locations/:locId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/pantry/locations/:locId
// Artikel behalten ihren Bestand und werden ortlos (ON DELETE SET NULL).
// Der letzte verbleibende Ort kann nicht gelöscht werden.
// Response: { ok: true, orphaned: number }
// --------------------------------------------------------
router.delete('/locations/:locId', (req, res) => {
  try {
    const vId = idParam(req.params.locId, 'locId');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });

    const loc = db.get().prepare('SELECT * FROM pantry_locations WHERE id = ?').get(vId.value);
    if (!loc) return res.status(404).json({ error: 'Storage location not found.', code: 404 });

    const total = db.get().prepare('SELECT COUNT(*) AS c FROM pantry_locations').get().c;
    if (total <= 1) return res.status(400).json({ error: 'The last storage location cannot be deleted.', code: 400 });

    const orphaned = db.get()
      .prepare('SELECT COUNT(*) AS c FROM pantry_items WHERE location_id = ?')
      .get(loc.id).c;

    db.get().prepare('DELETE FROM pantry_locations WHERE id = ?').run(loc.id);

    res.json({ ok: true, orphaned });
  } catch (err) {
    log.error('DELETE /locations/:locId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/pantry/import-shopping
// Übernimmt abgehakte Artikel einer Einkaufsliste in den Vorrat.
// Body: { list_id, items: [{ shopping_item_id, quantity?, unit?, location_id?, expires_on? }] }
//
// Löscht bewusst NICHTS in der Einkaufsliste: das erledigt der Client danach
// über das bestehende DELETE /shopping/:listId/items/checked. So bleibt ein
// `pantry:write`-Token auf den Vorrat beschränkt und kann keine Einkaufsdaten
// entfernen.
//
// LESEN BRAUCHT DAS LESERECHT DER QUELLE. Der Pfad-Guard misst diese Route als
// `pantry`; Name und Kategorie der Einkaufsartikel stehen danach im Vorrat.
// Deshalb fragt die Route selbst nach `shopping: read` (beide Achsen), und
// zwar vor der Listensuche, damit ein 404 keine Listen-ID bestaetigt.
// Response: { data: { added, merged, skipped, changes } }
//
// ZUSAMMENFUEHREN (R23, D3). Eine Zeile wandert in eine bestehende Charge, wenn
// Name (normalisiert wie das Produkt: productKey), Lagerort und Einheit passen -
// vertraeglich heisst gleich ODER umrechenbar (g/kg, ml/l; die Menge wird in
// die Einheit der Charge umgerechnet) - und das MHD gleich ist oder eins von
// beiden fehlt (dann gilt das gesetzte). Bis R23 musste alles exakt gleich
// sein, Name per NOCASE (nur ASCII): der Critique-Lauf ergab 6 Dubletten aus
// 10 Artikeln ("Milch 1 l" neben "Milch 1000 ml", "Butter" ohne MHD neben
// "Butter" mit MHD).
//
// `changes` traegt das Rueckgaengig (POST /pantry/import-shopping/undo): je
// Zeile, ob sie neu ist oder wie viel sie wo dazugelegt hat und ob dabei ein
// MHD gesetzt wurde. Die Ruecknahme zieht genau das wieder ab, statt einen
// alten Stand zurueckzuschreiben - was jemand in der Zwischenzeit an der
// Charge geaendert hat, bleibt.
// --------------------------------------------------------
router.post('/import-shopping', (req, res) => {
  try {
    if (!mayReadModule(req, 'shopping')) {
      return res.status(403).json({ error: 'Read access to the shopping list is required.', code: 403, reason: 'cross_module_access' });
    }

    const vList = idParam(req.body.list_id, 'list_id');
    if (vList.error) return res.status(400).json({ error: vList.error, code: 400 });

    const list = db.get().prepare('SELECT id FROM shopping_lists WHERE id = ?').get(vList.value);
    if (!list) return res.status(404).json({ error: 'List not found.', code: 404 });

    const entries = Array.isArray(req.body.items) ? req.body.items : [];
    if (!entries.length) return res.json({ data: { added: 0, merged: 0, skipped: 0, changes: [] } });

    const checked = db.get()
      .prepare('SELECT * FROM shopping_items WHERE list_id = ? AND is_checked = 1')
      .all(vList.value);
    const checkedById = new Map(checked.map((i) => [i.id, i]));

    const userId = req.authUserId || req.session.userId;
    const categoryNames = validCategoryNames();
    const fallbackCategory = categoryNames[categoryNames.length - 1] ?? 'Sonstiges';

    // Die Rechte EINMAL fuer den ganzen Import aufloesen, nicht je Zeile: die
    // Schleife laeuft synchron in einer Transaktion, und bei vierzig Eintraegen
    // und vier Mitgliedern waeren das ein paar hundert Abfragen, die alle
    // dieselbe Antwort geben.
    const access = resolvePantryAccess(db.get());
    // `today` genauso EINMAL wie die Rechte: es kostet sonst je Importzeile
    // eine sync_config-Abfrage plus zwei Intl.DateTimeFormat-Konstruktionen,
    // und die Schleife laeuft synchron in einer Transaktion.
    const today = householdToday(db.get());

    const result = db.get().transaction(() => {
      const sameLocation = db.get().prepare(
        'SELECT id, name, quantity, unit, expires_on FROM pantry_items WHERE location_id IS ? ORDER BY id ASC',
      );
      const bump = db.get().prepare('UPDATE pantry_items SET quantity = ?, expires_on = ? WHERE id = ?');
      const insert = db.get().prepare(`
        INSERT INTO pantry_items (name, quantity, unit, location_id, category, expires_on, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      // Die beste passende Charge: gleiche Einheit und gleiches MHD vor gleicher
      // Einheit vor umrechenbarer Einheit - "Milch 1 l" landet lieber bei der
      // Literpackung als bei den 500 ml daneben.
      const findMatch = (name, unit, locationId, expiresOn) => {
        const key = productKey(name);
        if (!key) return null;
        let best = null;
        let bestRank = Infinity;
        for (const row of sameLocation.all(locationId)) {
          if (productKey(row.name) !== key) continue;
          if (convertPantryQuantity(1, unit, row.unit) === null) continue;
          if (row.expires_on && expiresOn && row.expires_on !== expiresOn) continue;
          const rank = (row.unit === unit ? 0 : 2) + (row.expires_on === expiresOn ? 0 : 1);
          if (rank < bestRank) { best = row; bestRank = rank; }
        }
        return best;
      };
      const changes = [];

      let added = 0, merged = 0, skipped = 0;

      for (const entry of entries) {
        const source = checkedById.get(Number(entry?.shopping_item_id));
        // Nicht abgehakt, fremde Liste oder inzwischen gelöscht → still übergehen.
        if (!source) { skipped += 1; continue; }

        const quantity = normalizePantryQuantity(entry.quantity, { fallback: 1 });
        const unit = normalizePantryUnit(entry.unit);
        const locationId = entry.location_id ? Number(entry.location_id) || null : null;
        // KALENDARISCH prüfen, nicht nur die Form: `date()` ist dieselbe
        // Funktion, die POST/PUT/PATCH benutzen. Die rohe Regex liess ein
        // '2027-02-30' durch - vorher nur eine unsinnige Zeile, seit die
        // Erinnerung mit dem Datum RECHNET ein Fehler mitten in der
        // Transaktion, der den ganzen Import zurückrollt.
        //
        // DER ARTIKEL KOMMT TROTZDEM AN, nur ohne MHD. Er selbst ist in
        // Ordnung - Name, Menge und Kategorie stammen aus der Einkaufsliste,
        // kaputt ist allein das Datum. Die Zeile zu verwerfen hiesse: jemand
        // hakt den Joghurt ab, drückt Übernehmen, und der Joghurt fehlt im
        // Vorrat. Ein Artikel ohne Ablaufdatum ist der kleinere Verlust, und
        // es ist der Zustand, den der Vorrat für die Mehrheit seiner Zeilen
        // ohnehin kennt.
        const expiresOn = date(entry.expires_on, 'expires_on').value;
        const category = categoryNames.includes(source.category) ? source.category : fallbackCategory;

        // Gleicher Name, gleicher Ort, vertraegliche Einheit, MHD gleich oder
        // eins leer → dieselbe Charge, also aufaddieren (Regel im Kopf). Zwei
        // VERSCHIEDENE MHDs sind zwei Chargen und bekommen eigene Zeilen.
        const match = findMatch(source.name, unit, locationId, expiresOn);
        if (match) {
          const added = normalizePantryQuantity(convertPantryQuantity(quantity, unit, match.unit), { fallback: quantity });
          const expiresSet = !match.expires_on && Boolean(expiresOn);
          bump.run(
            normalizePantryQuantity(Number(match.quantity) + added, { fallback: added }),
            match.expires_on ?? expiresOn,
            match.id,
          );
          changes.push({ pantry_item_id: match.id, kind: 'merged', quantity_added: added, expires_set: expiresSet });
          // Eine aufgefüllte Charge kann von Menge 0 zurückkommen - dann ist die
          // Erinnerung wieder fällig, die das Ausbuchen abgeräumt hat.
          syncReminder(getItem(match.id), access, today);
          merged += 1;
        } else {
          const inserted = insert.run(source.name, quantity, unit, locationId, category, expiresOn, userId);
          assignPantryProduct(db.get(), inserted.lastInsertRowid, { userId });
          syncReminder(getItem(inserted.lastInsertRowid), access, today);
          changes.push({ pantry_item_id: Number(inserted.lastInsertRowid), kind: 'added' });
          added += 1;
        }
      }

      return { added, merged, skipped, changes };
    })();

    res.json({ data: result });
  } catch (err) {
    log.error('POST /import-shopping error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/pantry/import-shopping/undo
// Nimmt eine Uebernahme aus dem Einkauf zurueck (R23, D3).
// Body: { changes } - die `changes` aus der Antwort von /import-shopping.
// Response: { data: { removed, reduced } }
//
// Neu angelegte Chargen werden geloescht (samt Erinnerung, wie DELETE /:itemId),
// aufgefuellte um genau ihren Zuwachs verringert, und ein MHD, das erst die
// Uebernahme gesetzt hat, faellt wieder weg. Abgezogen statt zurueckgeschrieben:
// wer im Fenster des Toasts selbst an der Charge drehte, behaelt seine Aenderung.
// Was inzwischen weg ist, wird still uebergangen - `removed`/`reduced` sagen,
// was tatsaechlich zurueckging (dieselbe Regel wie /shopping/items/undo-transfer).
//
// Kein Lesen des Einkaufs, also kein zweiter Riegel: die Route schreibt nur in
// den Vorrat und gehoert damit allein dessen Schreibrecht (Pfad-Guard).
// --------------------------------------------------------
router.post('/import-shopping/undo', (req, res) => {
  try {
    const raw = Array.isArray(req.body?.changes) ? req.body.changes : [];
    const changes = raw
      .map((c) => ({
        id: Number(c?.pantry_item_id),
        kind: c?.kind,
        quantity: Number(c?.quantity_added),
        expiresSet: c?.expires_set === true,
      }))
      .filter((c) => Number.isInteger(c.id) && c.id > 0 && (c.kind === 'added' || (c.kind === 'merged' && Number.isFinite(c.quantity))));
    if (!changes.length) return res.json({ data: { removed: 0, reduced: 0 } });

    const access = resolvePantryAccess(db.get());
    const today = householdToday(db.get());

    const result = db.get().transaction(() => {
      const remove = db.get().prepare('DELETE FROM pantry_items WHERE id = ?');
      const removeReminder = db.get().prepare("DELETE FROM reminders WHERE entity_type = 'pantry_item' AND entity_id = ?");
      const reduce = db.get().prepare('UPDATE pantry_items SET quantity = ?, expires_on = ? WHERE id = ?');
      let removed = 0;
      let reduced = 0;
      for (const change of changes) {
        const item = getItem(change.id);
        if (!item) continue;
        if (change.kind === 'added') {
          remove.run(change.id);
          removeReminder.run(change.id);
          removed += 1;
          continue;
        }
        const quantity = normalizePantryQuantity(Number(item.quantity) - change.quantity, { fallback: 0 });
        reduce.run(quantity, change.expiresSet ? null : item.expires_on, change.id);
        syncReminder(getItem(change.id), access, today);
        reduced += 1;
      }
      return { removed, reduced };
    })();

    res.json({ data: result });
  } catch (err) {
    log.error('POST /import-shopping/undo error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/pantry
// Alle Vorratsartikel plus Lagerorte und Kategorien in einem Roundtrip.
// Der Ablauf-/Bestands-Status wird bewusst NICHT hier berechnet: "abgelaufen"
// hängt am lokalen Datum des Nutzers, der Server rechnet in UTC.
// `products` names the household products with their number of batches,
// including products without batches (#1448).
// Response: { data: PantryItem[], products: [], locations: [], categories: [] }
// --------------------------------------------------------
router.get('/', (_req, res) => {
  try {
    res.json({ data: loadItems(), products: loadProducts(), locations: loadLocations(), categories: loadCategories() });
  } catch (err) {
    log.error('GET / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/pantry/products/:productId
// Deletes a household product that has no batches left (#1448; brought
// forward from step 5 so a product that outlived its last batch can go). A
// product with batches is refused with 409 and `reason`
// `pantry_product_has_batches`, so the ON DELETE CASCADE on
// `pantry_items.product_id` never takes stock with it. Count and delete run in
// one transaction: a batch written in between cannot slip under the check.
// Nothing else points at a product: recipe matches and reminders point at
// batches. Behind the pantry write permission like every DELETE under /pantry
// (module gate in server/index.js).
// Response: 204
// --------------------------------------------------------
router.delete('/products/:productId', (req, res) => {
  try {
    const vId = idParam(req.params.productId, 'productId');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });

    const outcome = db.get().transaction(() => {
      const product = db.get().prepare('SELECT id FROM pantry_products WHERE id = ?').get(vId.value);
      if (!product) return { status: 404 };
      const { batches } = db.get()
        .prepare('SELECT COUNT(*) AS batches FROM pantry_items WHERE product_id = ?').get(vId.value);
      if (batches > 0) return { status: 409, batches };
      db.get().prepare('DELETE FROM pantry_products WHERE id = ?').run(vId.value);
      return { status: 204 };
    })();

    if (outcome.status === 404) return res.status(404).json({ error: 'Product not found.', code: 404 });
    if (outcome.status === 409) {
      return res.status(409).json({
        error: 'The product still has batches; delete them first.',
        code: 409,
        reason: 'pantry_product_has_batches',
        count: outcome.batches,
      });
    }
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /products/:productId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/pantry
// Body: { name, quantity?, unit?, location_id?, category?, expires_on?, min_quantity?, notes? }
// Response: { data: PantryItem }
// --------------------------------------------------------
router.post('/', (req, res) => {
  try {
    const { values, errors } = validateItemFields(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    // Schreiben und Erinnerung in EINER Transaktion, wie in
    // server/routes/inventory/items.js: sonst kann der Artikel stehen und die
    // Erinnerung fehlen, ohne dass die Antwort davon erzählt.
    const created = db.get().transaction(() => {
      const result = db.get().prepare(`
        INSERT INTO pantry_items
          (name, quantity, unit, location_id, category, expires_on, min_quantity, notes, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        values.name, values.quantity, values.unit, values.location_id,
        values.category, values.expires_on, values.min_quantity, values.notes,
        req.authUserId || req.session.userId
      );
      assignPantryProduct(db.get(), result.lastInsertRowid, { userId: req.authUserId || req.session.userId });
      const item = getItem(result.lastInsertRowid);
      syncReminder(item);
      return item;
    })();

    res.status(201).json({ data: created });
  } catch (err) {
    log.error('POST / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PUT /api/v1/pantry/:itemId
// Vollständiges Update (Bearbeiten-Formular).
// Response: { data: PantryItem }
// --------------------------------------------------------
router.put('/:itemId', (req, res) => {
  try {
    const vId = idParam(req.params.itemId, 'itemId');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });

    const item = getItem(vId.value);
    if (!item) return res.status(404).json({ error: 'Item not found.', code: 404 });

    const { values, errors } = validateItemFields(req.body, { current: item });
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const updated = db.get().transaction(() => {
      db.get().prepare(`
        UPDATE pantry_items
        SET name = ?, quantity = ?, unit = ?, location_id = ?, category = ?,
            expires_on = ?, min_quantity = ?, notes = ?
        WHERE id = ?
      `).run(
        values.name, values.quantity, values.unit, values.location_id,
        values.category, values.expires_on, values.min_quantity, values.notes, item.id
      );
      // A changed name or unit moves the batch to the matching product (#1448).
      // The category reaches the product only when this edit changed it: the
      // form sends every field, and an expiry edit must not push the batch's
      // old category over one set later through another batch.
      assignPantryProduct(db.get(), item.id, {
        userId: req.authUserId || req.session.userId,
        syncCategory: values.category !== item.category,
      });
      const fresh = getItem(item.id);
      syncReminder(fresh);
      return fresh;
    })();

    res.json({ data: updated });
  } catch (err) {
    log.error('PUT /:itemId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PATCH /api/v1/pantry/:itemId
// Teil-Update. Trägt den ±-Stepper der Liste: ein Feld statt eines
// Vollobjekts, damit ein Tap keine ganze Zeile überschreibt.
// Response: { data: PantryItem }
// --------------------------------------------------------
router.patch('/:itemId', (req, res) => {
  try {
    const vId = idParam(req.params.itemId, 'itemId');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });

    const item = getItem(vId.value);
    if (!item) return res.status(404).json({ error: 'Item not found.', code: 404 });

    const { values, errors } = validateItemFields(req.body, { partial: true, current: item });
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    // Die Spaltennamen stammen aus dem festen Schlüsselvorrat von
    // validateItemFields, nicht aus dem Request-Body - kein Injection-Pfad.
    const fields = Object.keys(values);
    if (!fields.length) return res.json({ data: item });

    const updated = db.get().transaction(() => {
      db.get().prepare(`
        UPDATE pantry_items SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?
      `).run(...fields.map((f) => values[f]), item.id);

      // The stepper writes only the quantity and leaves the product alone. A
      // name or unit moves the batch to the matching product, a category is
      // the product's too (#1448).
      if (fields.some((f) => f === 'name' || f === 'unit' || f === 'category')) {
        assignPantryProduct(db.get(), item.id, {
          userId: req.authUserId || req.session.userId,
          syncCategory: fields.includes('category') && values.category !== item.category,
        });
      }

      // Auch der ±-Stepper landet hier: wer den letzten Joghurt ausbucht, soll
      // nicht in fünf Tagen an sein Ablaufdatum erinnert werden.
      const fresh = getItem(item.id);
      syncReminder(fresh);
      return fresh;
    })();

    res.json({ data: updated });
  } catch (err) {
    log.error('PATCH /:itemId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/pantry/:itemId
// Response: 204
// --------------------------------------------------------
router.delete('/:itemId', (req, res) => {
  try {
    const vId = idParam(req.params.itemId, 'itemId');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });

    const removed = db.get().transaction(() => {
      const result = db.get().prepare('DELETE FROM pantry_items WHERE id = ?').run(vId.value);
      if (result.changes === 0) return false;

      // `reminders` hat keinen Fremdschlüssel auf die Entität - entity_id ist
      // über sechs Tabellen hinweg polymorph, ein FK könnte nur auf eine davon
      // zeigen. Aufräumen ist deshalb Sache des Routers, wie im Inventar auch.
      db.get().prepare("DELETE FROM reminders WHERE entity_type = 'pantry_item' AND entity_id = ?").run(vId.value);
      return true;
    })();
    if (!removed) return res.status(404).json({ error: 'Item not found.', code: 404 });

    res.status(204).end();
  } catch (err) {
    log.error('DELETE /:itemId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
