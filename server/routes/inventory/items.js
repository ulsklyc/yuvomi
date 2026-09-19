/**
 * Modul: Inventar – Gegenstaende
 * Zweck: CRUD + Liste + Dokument-/Buchungsverknuepfung (Stufen 1-3). Keine
 *        Abo-Verknuepfung, die kommt in einer spaeteren Stufe.
 *
 * Kein Eigentuemer-Gate: Inventar ist Haushaltseigentum wie der Vorrat.
 * created_by bleibt als Herkunftsnachweis (nullable, ON DELETE SET NULL).
 */

import express from 'express';
import * as db from '../../db.js';
import { createLogger } from '../../logger.js';
import {
  str, oneOf, num, date, id as idParam, collectErrors, MAX_TITLE, MAX_TEXT, MAX_SHORT,
} from '../../middleware/validate.js';
import {
  assertDocumentLinkTargetsAvailable, documentLinksFor, loadDocumentLinks, replaceDocumentLinks,
} from '../../services/document-links.js';
import { sendDocumentDeletionConflict } from '../../services/document-deletion-lock.js';
import {
  ROLES, visibleEntry, linkabilityError, entryHasLinks, linkEntry, unlinkEntry,
  loadLinkedEntriesForItems, loadLinkedEntries, computeTotal,
} from './entry-links.js';
import { warrantyEndDate, reminderDateForWarranty } from '../../services/inventory-deadlines.js';
import { dataUrlContentMatches } from '../../utils/file-signature.js';
import { todayKey } from '../../utils/timezone.js';
import {
  validateTrackedDatesInput, writeTrackedDates, removeTrackedDateReminders, loadTrackedDates, loadTrackedDatesForItems,
} from './item-dates.js';
import {
  validateServiceLogInput, validateCompletionInput, odometerBaselineExcluding, loadServiceLog, createServiceLogEntry,
  updateServiceLogEntry, deleteServiceLogEntry, completeTrackedDate, loadHistory,
} from './service-log.js';

const log = createLogger('Inventory');
const router = express.Router();

const CONDITIONS = ['new', 'good', 'fair', 'poor'];
const STATUSES = ['active', 'sold', 'disposed', 'lost'];
const ODOMETER_UNITS = ['km', 'mi'];
const CURRENCY_RE = /^[A-Z]{3}$/;
const MAX_PHOTO_LENGTH = 6_990_507; // ~5 MB raw image in base64, same cap as birthdays.js
const PHOTO_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const DOCS = { table: 'inventory_item_documents', ownerColumn: 'item_id' };

const WARRANTY_REMINDER_OFFSET_DAYS = 30;

/**
 * Erinnerungs-Lebenszyklus, identisches Muster wie server/routes/subscriptions.js
 * #syncReminder: bei jedem Schreiben erst löschen, dann - falls die Bedingungen
 * greifen - neu anlegen. Kein Diffing, keine Sonderfälle für "nur ein Feld hat
 * sich geändert".
 */
function syncReminder(item) {
  const database = db.get();
  database.prepare(`
    DELETE FROM reminders WHERE entity_type = 'inventory_item' AND entity_id = ?
  `).run(item.id);

  if (!item.purchase_date || item.warranty_months == null || !item.created_by) return;

  const warrantyEnd = warrantyEndDate(item.purchase_date, item.warranty_months);
  const remindAt = reminderDateForWarranty(warrantyEnd, WARRANTY_REMINDER_OFFSET_DAYS);

  // Bereits vergangene Erinnerungstermine nicht anlegen (Design-Doc §4): sonst
  // nagt ein zurückdatiertes Altgerät sofort nach dem Anlegen. remind_at ist
  // naiv-UTC (siehe public/utils/reminder-offset.js) - ein 'Z'-Suffix macht den
  // Vergleich gegen Date.now() korrekt statt einen zweiten Zeitzonen-Offset einzuführen.
  if (new Date(`${remindAt}Z`).getTime() <= Date.now()) return;

  database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('inventory_item', ?, ?, ?)
  `).run(item.id, remindAt, item.created_by);
}

/** Gleiches Muster wie server/routes/subscriptions.js#budgetCurrency(). */
function householdCurrency() {
  return db.get().prepare("SELECT value FROM sync_config WHERE key = 'currency'").get()?.value || 'EUR';
}

/** Gleiche Regel wie server/routes/birthdays.js#validatePhotoData - ein
 *  einzelnes optionales Bild je Datensatz, gleiche Groessen-/Typgrenze. */
function validatePhotoData(val) {
  if (val === undefined) return { value: undefined, error: null };
  if (val === null || val === '') return { value: null, error: null };
  const s = String(val).trim();
  if (s.length > MAX_PHOTO_LENGTH) return { value: null, error: 'Photo is too large.' };
  if (!PHOTO_RE.test(s)) return { value: null, error: 'Photo must be a valid image data URL.' };
  // Der Regex prueft die Deklaration, diese Zeile den Inhalt (#937).
  if (!dataUrlContentMatches(s)) return { value: null, error: 'Photo content does not match its image type.' };
  return { value: s, error: null };
}

function validCategoryKeys() {
  return db.get().prepare('SELECT key FROM inventory_categories').all().map((r) => r.key);
}

/** Traegt DIESE Kategorie den Kilometerstand (Review #1257: eine Eigenschaft
 *  der Kategorie-Zeile, kein hartcodierter Vergleich gegen 'vehicles' - eine
 *  geloeschte oder umbenannte Kategorie bricht die Funktion damit nicht mehr,
 *  und ein selbst angelegtes Fahrzeug-Aequivalent kann sie ebenso tragen). */
function categoryTracksOdometer(key) {
  return db.get().prepare('SELECT tracks_odometer FROM inventory_categories WHERE key = ?').get(key)?.tracks_odometer === 1;
}

/**
 * Ortspfad fuer die Anzeige, z. B. "Keller · Regal 2" fuer einen Unterort,
 * "Garage" fuer einen Top-Ebene-Ort. NULL fuer ortlose Gegenstaende.
 */
function locationPath(locationId) {
  if (locationId == null) return null;
  const loc = db.get().prepare('SELECT * FROM inventory_locations WHERE id = ?').get(locationId);
  if (!loc) return null;
  if (loc.parent_id == null) return loc.name;
  const parent = db.get().prepare('SELECT name FROM inventory_locations WHERE id = ?').get(loc.parent_id);
  return parent ? `${parent.name} · ${loc.name}` : loc.name;
}

function loadItem(id, userId) {
  const item = db.get().prepare('SELECT * FROM inventory_items WHERE id = ?').get(id);
  if (!item) return null;
  const category = db.get().prepare('SELECT name, icon, label_key FROM inventory_categories WHERE key = ?').get(item.category);
  const linkedEntries = loadLinkedEntries(item.id, userId);
  return {
    ...item,
    category_name: category?.name ?? item.category,
    category_icon: category?.icon ?? 'package',
    category_label_key: category?.label_key ?? null,
    location_path: locationPath(item.location_id),
    attachments: documentLinksFor(db.get(), { ...DOCS, ownerId: item.id, userId }),
    linked_entries: linkedEntries,
    linked_entries_total: computeTotal(linkedEntries),
    tracked_dates: loadTrackedDates(item.id),
  };
}

function loadItems({ category, locationId, status, q } = {}, userId) {
  const clauses = [];
  const params = [];
  if (category !== undefined) { clauses.push('ii.category = ?'); params.push(category); }
  if (locationId !== undefined) { clauses.push('ii.location_id = ?'); params.push(locationId); }
  if (status !== undefined) { clauses.push('ii.status = ?'); params.push(status); }
  if (q) {
    // account_username ist mitgesucht (#1004): das Feld traegt kein Geheimnis,
    // und "wo ist das Geraet, das unter dieser Adresse laeuft" ist genau die
    // Frage, fuer die es angelegt wurde.
    clauses.push('(ii.name LIKE ? OR ii.brand LIKE ? OR ii.model LIKE ? OR ii.serial_number LIKE ? OR ii.account_username LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.get().prepare(`
    SELECT ii.*, ic.name AS category_name, ic.icon AS category_icon, ic.label_key AS category_label_key
    FROM inventory_items ii
    LEFT JOIN inventory_categories ic ON ic.key = ii.category
    ${where}
    ORDER BY ii.name COLLATE NOCASE ASC
  `).all(...params);
  const byItem = loadDocumentLinks(db.get(), { ...DOCS, ownerIds: rows.map((r) => r.id), userId });
  const entriesByItem = loadLinkedEntriesForItems(rows.map((r) => r.id), userId);
  const datesByItem = loadTrackedDatesForItems(rows.map((r) => r.id));
  return rows.map((row) => {
    const linkedEntries = entriesByItem.get(row.id) || [];
    return {
      ...row,
      location_path: locationPath(row.location_id),
      attachments: byItem.get(row.id) || [],
      linked_entries: linkedEntries,
      linked_entries_total: computeTotal(linkedEntries),
      tracked_dates: datesByItem.get(row.id) || [],
    };
  });
}

/**
 * Validiert die Felder eines Gegenstands fuer ein volles Replace (POST wie PUT
 * identisch). Ein weggelassenes Feld wird NULL/Default - kein Feld behaelt den
 * Altwert (siehe die erste, einfachere Inventar-Version dieses Projekts, wo genau
 * diese Inkonsistenz per Review-Fund korrigiert werden musste).
 */
function validateItemFields(body) {
  const values = {};
  const results = [];

  const vName = str(body.name, 'Name', { max: MAX_TITLE });
  results.push(vName);
  values.name = vName.value;

  const vBrand = str(body.brand, 'Marke', { max: MAX_SHORT, required: false });
  results.push(vBrand);
  values.brand = vBrand.value;

  const vModel = str(body.model, 'Modell', { max: MAX_SHORT, required: false });
  results.push(vModel);
  values.model = vModel.value;

  const vSerial = str(body.serial_number, 'Seriennummer', { max: MAX_SHORT, required: false });
  results.push(vSerial);
  values.serial_number = vSerial.value;

  const categoryKeys = validCategoryKeys();
  const vCategory = oneOf(body.category || 'other', categoryKeys, 'Kategorie');
  results.push(vCategory);
  values.category = vCategory.value ?? 'other';

  if (body.location_id === null || body.location_id === '' || body.location_id === undefined) {
    values.location_id = null;
  } else {
    const vLoc = idParam(body.location_id, 'Ort');
    results.push(vLoc);
    if (vLoc.value !== null) {
      const exists = db.get().prepare('SELECT id FROM inventory_locations WHERE id = ?').get(vLoc.value);
      if (!exists) results.push({ error: 'Location not found.' });
    }
    values.location_id = vLoc.value;
  }

  const vPurchaseDate = date(body.purchase_date, 'Kaufdatum');
  results.push(vPurchaseDate);
  values.purchase_date = vPurchaseDate.value;

  if (body.purchase_price === null || body.purchase_price === '' || body.purchase_price === undefined) {
    values.purchase_price = null;
  } else {
    const vPrice = num(body.purchase_price, 'Kaufpreis');
    results.push(vPrice);
    if (vPrice.value !== null && vPrice.value < 0) results.push({ error: 'Kaufpreis darf nicht negativ sein.' });
    values.purchase_price = vPrice.value;
  }

  if (body.currency === null || body.currency === '' || body.currency === undefined) {
    values.currency = householdCurrency();
  } else {
    const currency = String(body.currency).toUpperCase();
    if (!CURRENCY_RE.test(currency)) results.push({ error: 'Currency must be a three-letter ISO code.' });
    values.currency = currency;
  }

  const vVendor = str(body.vendor, 'Haendler', { max: MAX_SHORT, required: false });
  results.push(vVendor);
  values.vendor = vVendor.value;

  // Unter welchem Konto der Gegenstand registriert ist (#1004) - eine Adresse
  // oder ein Benutzername, KEIN Passwort. Deshalb steht das Feld hier bei den
  // gewoehnlichen Textspalten und nicht in einem eigenen, verschluesselten
  // Topf: ein Benutzername ohne sein Passwort ist ein Telefonbucheintrag.
  // Haushaltsweit sichtbar wie jede andere Spalte dieser Tabelle - inventory_items
  // hat weder owner_id noch visibility (#467, Entscheidung in #1004).
  const vAccount = str(body.account_username, 'Konto', { max: MAX_SHORT, required: false });
  results.push(vAccount);
  values.account_username = vAccount.value;

  if (body.warranty_months === null || body.warranty_months === '' || body.warranty_months === undefined) {
    values.warranty_months = null;
  } else {
    const vWarranty = num(body.warranty_months, 'Garantiemonate');
    results.push(vWarranty);
    if (vWarranty.value !== null && (!Number.isInteger(vWarranty.value) || vWarranty.value < 0 || vWarranty.value > 600)) {
      results.push({ error: 'Garantiemonate muss eine ganze Zahl zwischen 0 und 600 sein.' });
    }
    values.warranty_months = vWarranty.value;
  }

  // Manuelle Kilometerstand-Ablesung - bewusst auf Kategorien begrenzt, die
  // tracks_odometer tragen (per Voreinstellung nur "Fahrzeuge", Nutzer-
  // Entscheidung 2026-09-17). Fuer jede andere Kategorie wird still auf NULL
  // genullt statt mit 400 abgelehnt - dasselbe volle-Replace-Verhalten wie ein
  // weggelassenes Feld (siehe Modulkopf dieser Funktion): ein Kategoriewechsel
  // weg von einer odometer-tragenden Kategorie raeumt einen vorher gesetzten
  // Wert automatisch ab, statt ihn unsichtbar (das Formular blendet das Feld
  // dann aus) stehen zu lassen.
  if (!categoryTracksOdometer(values.category)) {
    values.odometer = null;
    values.odometer_unit = null;
    values.odometer_on = null;
  } else {
    if (body.odometer === null || body.odometer === '' || body.odometer === undefined) {
      values.odometer = null;
    } else {
      const vOdometer = num(body.odometer, 'Kilometerstand');
      results.push(vOdometer);
      if (vOdometer.value !== null && (!Number.isInteger(vOdometer.value) || vOdometer.value < 0)) {
        results.push({ error: 'Kilometerstand darf nicht negativ sein.' });
      }
      values.odometer = vOdometer.value;
    }

    if (body.odometer_unit === null || body.odometer_unit === '' || body.odometer_unit === undefined) {
      // Ohne explizite Einheit, aber mit Zahl: 'km' als Standard, damit kein
      // Wert ohne Einheit dasteht - dasselbe Muster wie currency weiter oben.
      values.odometer_unit = values.odometer != null ? 'km' : null;
    } else {
      const vUnit = oneOf(body.odometer_unit, ODOMETER_UNITS, 'Einheit');
      results.push(vUnit);
      values.odometer_unit = vUnit.value;
    }

    const vOdometerOn = date(body.odometer_on, 'Ablesedatum');
    results.push(vOdometerOn);
    // Eine Ablesung ohne Datum bekommt "heute" (Haushalts-Zeitzone) - derselbe
    // Ersatzwert wie 'km' fuer odometer_unit direkt darueber. Ohne ein Datum
    // haelt odometerRegressionError() (service-log.js) jeden neuen Log-Eintrag
    // fuer nicht-konkurrierend und laesst ihn den aktuellen Stand unbemerkt
    // ueberschreiben - der Tippfehler-Schutz waere fuer dieses Item dauerhaft
    // aus, sobald eine Ablesung ohne Datum stand (Review #1257).
    values.odometer_on = vOdometerOn.value ?? (values.odometer != null ? todayKey(db.get(), new Date()) : null);
  }

  const vCondition = oneOf(body.condition || 'good', CONDITIONS, 'Zustand');
  results.push(vCondition);
  values.condition = vCondition.value ?? 'good';

  const vStatus = oneOf(body.status || 'active', STATUSES, 'Status');
  results.push(vStatus);
  values.status = vStatus.value ?? 'active';

  const vNotes = str(body.notes, 'Notiz', { max: MAX_TEXT, required: false });
  results.push(vNotes);
  values.notes = vNotes.value;

  const vPhoto = validatePhotoData(body.photo_data);
  results.push(vPhoto);
  // `?? null`, nicht `vPhoto.value`: ein fehlendes Feld validiert als
  // `{value: undefined}`, aber dies ist ein volles Replace (Global
  // Constraints) - ein weggelassenes Foto wird NULL, nicht "unveraendert".
  values.photo_data = vPhoto.value ?? null;

  return { values, errors: collectErrors(results) };
}

// --------------------------------------------------------
// GET /api/v1/inventory/items   Query: ?category=&location_id=&status=&q=
// --------------------------------------------------------
router.get('/', (req, res) => {
  try {
    const category = typeof req.query.category === 'string' && req.query.category ? req.query.category : undefined;
    let locationId;
    if (req.query.location_id !== undefined) {
      const n = parseInt(req.query.location_id, 10);
      if (!n || n < 1) return res.status(400).json({ error: 'location_id must be a positive number.', code: 400 });
      locationId = n;
    }
    const status = typeof req.query.status === 'string' && STATUSES.includes(req.query.status) ? req.query.status : undefined;
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : undefined;
    const userId = req.authUserId || req.session.userId;

    res.json({ data: loadItems({ category, locationId, status, q }, userId) });
  } catch (err) {
    log.error('GET / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/inventory/items/:id
// --------------------------------------------------------
router.get('/:id', (req, res) => {
  try {
    const vId = idParam(req.params.id, 'Gegenstand-ID');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const userId = req.authUserId || req.session.userId;
    const item = loadItem(vId.value, userId);
    if (!item) return res.status(404).json({ error: 'Item not found.', code: 404 });
    res.json({ data: item });
  } catch (err) {
    log.error('GET /:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/inventory/items
// --------------------------------------------------------
router.post('/', (req, res) => {
  try {
    const userId = req.authUserId || req.session.userId;

    // Kaufpreis-Vorbelegung (Design-Doc §5.6): entry_id wird VOR dem Insert
    // geprueft, damit eine ungueltige Buchung nie einen verwaisten Gegenstand
    // anlegt. Vorbelegt wird nur, wenn purchase_price fehlt UND die Buchung
    // noch keine andere Verknuepfung hat (Sammelrechnung, zweiter Gegenstand).
    let effectiveBody = req.body;
    let entry = null;
    const rawEntryId = req.body.entry_id;
    if (rawEntryId !== undefined && rawEntryId !== null && rawEntryId !== '') {
      const vEntryId = idParam(rawEntryId, 'Buchung');
      if (vEntryId.error) return res.status(400).json({ error: vEntryId.error, code: 400 });
      entry = visibleEntry(vEntryId.value, userId);
      if (!entry) return res.status(404).json({ error: 'Booking not found.', code: 404 });
      const linkError = linkabilityError(entry);
      if (linkError) return res.status(linkError.code).json({ error: linkError.error, code: linkError.code });

      const priceOmitted = req.body.purchase_price === undefined || req.body.purchase_price === null || req.body.purchase_price === '';
      if (priceOmitted && !entryHasLinks(entry.id)) {
        effectiveBody = { ...req.body, purchase_price: Math.abs(entry.amount) };
      }
    }

    const { values, errors } = validateItemFields(effectiveBody);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const { values: trackedDateValues, errors: trackedDateErrors } = validateTrackedDatesInput(req.body.tracked_dates);
    if (trackedDateErrors.length) return res.status(400).json({ error: trackedDateErrors.join(' '), code: 400 });

    // Insert und Erinnerungs-Sync in einer Transaktion (gleiches Muster wie
    // DELETE /:id): wirft syncReminder - etwa an einem Kaufdatum, das die
    // Datumsrechnung nicht parsen kann -, darf der Gegenstand nicht trotzdem
    // geschrieben bleiben, waehrend die Anfrage mit 500 endet.
    assertDocumentLinkTargetsAvailable(db.get(), req.body.attachment_document_ids, userId);
    const result = db.get().transaction(() => {
      const inserted = db.get().prepare(`
        INSERT INTO inventory_items
          (name, brand, model, serial_number, category, location_id, purchase_date,
           purchase_price, currency, vendor, warranty_months, condition,
           status, notes, photo_data, account_username, odometer, odometer_unit, odometer_on, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        values.name, values.brand, values.model, values.serial_number, values.category,
        values.location_id, values.purchase_date, values.purchase_price,
        values.currency, values.vendor, values.warranty_months, values.condition, values.status,
        values.notes, values.photo_data, values.account_username,
        values.odometer, values.odometer_unit, values.odometer_on, userId,
      );

      syncReminder({
        id: inserted.lastInsertRowid,
        purchase_date: values.purchase_date,
        warranty_months: values.warranty_months,
        created_by: userId,
      });

      writeTrackedDates(inserted.lastInsertRowid, trackedDateValues, userId);

      return inserted;
    })();

    // Belege sind optional, deshalb erst nach dem Insert - der Gegenstand
    // steht auch ohne sie, ein unbekanntes Dokument darf ihn nicht scheitern lassen.
    replaceDocumentLinks(db.get(), {
      ...DOCS, ownerId: result.lastInsertRowid, documentIds: req.body.attachment_document_ids, userId,
    });

    if (entry) {
      linkEntry({ itemId: result.lastInsertRowid, entryId: entry.id, role: 'purchase', amountShare: null, userId });
    }

    res.status(201).json({ data: loadItem(result.lastInsertRowid, userId) });
  } catch (err) {
    if (sendDocumentDeletionConflict(res, err)) return;
    log.error('POST / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PUT /api/v1/inventory/items/:id   Volles Replace, siehe Kommentar oben.
// --------------------------------------------------------
router.put('/:id', (req, res) => {
  try {
    const vId = idParam(req.params.id, 'Gegenstand-ID');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const item = db.get().prepare('SELECT id, created_by FROM inventory_items WHERE id = ?').get(vId.value);
    if (!item) return res.status(404).json({ error: 'Item not found.', code: 404 });

    const { values, errors } = validateItemFields(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    let trackedDateValues = null;
    if (req.body.tracked_dates !== undefined) {
      const result = validateTrackedDatesInput(req.body.tracked_dates);
      if (result.errors.length) return res.status(400).json({ error: result.errors.join(' '), code: 400 });
      trackedDateValues = result.values;
    }

    // A rejected in-flight attachment must not leave the item fields or its
    // reminders half-updated.
    const userId = req.authUserId || req.session.userId;
    if (req.body.attachment_document_ids !== undefined) {
      assertDocumentLinkTargetsAvailable(db.get(), req.body.attachment_document_ids, userId);
    }

    // Update und Erinnerungs-Sync in einer Transaktion, gleiche Begruendung wie
    // im POST-Handler: kein halb geschriebener Zustand, wenn syncReminder wirft.
    db.get().transaction(() => {
      db.get().prepare(`
        UPDATE inventory_items
        SET name = ?, brand = ?, model = ?, serial_number = ?, category = ?, location_id = ?,
            purchase_date = ?, purchase_price = ?, currency = ?, vendor = ?,
            warranty_months = ?, condition = ?, status = ?, notes = ?, photo_data = ?,
            account_username = ?, odometer = ?, odometer_unit = ?, odometer_on = ?
        WHERE id = ?
      `).run(
        values.name, values.brand, values.model, values.serial_number, values.category,
        values.location_id, values.purchase_date, values.purchase_price,
        values.currency, values.vendor, values.warranty_months, values.condition, values.status,
        values.notes, values.photo_data, values.account_username,
        values.odometer, values.odometer_unit, values.odometer_on, item.id,
      );

      syncReminder({
        id: item.id,
        purchase_date: values.purchase_date,
        warranty_months: values.warranty_months,
        created_by: item.created_by,
      });

      if (trackedDateValues !== null) {
        writeTrackedDates(item.id, trackedDateValues, item.created_by);
      }
    })();

    // Belege nur anfassen, wenn das Feld mitkommt - ein PUT, das nur einen
    // Wert korrigiert, darf angehaengte Belege nicht stillschweigend abraeumen
    // (gleiches Muster wie server/routes/budget/entries.js#PUT /:id).
    if (req.body.attachment_document_ids !== undefined) {
      replaceDocumentLinks(db.get(), {
        ...DOCS, ownerId: item.id, documentIds: req.body.attachment_document_ids, userId,
      });
    }

    res.json({ data: loadItem(item.id, userId) });
  } catch (err) {
    if (sendDocumentDeletionConflict(res, err)) return;
    log.error('PUT /:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/inventory/items/:id/entries   Body: { entry_id, role?, amount_share? }
// --------------------------------------------------------
router.post('/:id/entries', (req, res) => {
  try {
    const vId = idParam(req.params.id, 'Gegenstand-ID');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const item = db.get().prepare('SELECT id FROM inventory_items WHERE id = ?').get(vId.value);
    if (!item) return res.status(404).json({ error: 'Item not found.', code: 404 });

    const vEntryId = idParam(req.body.entry_id, 'Buchung');
    if (vEntryId.error) return res.status(400).json({ error: vEntryId.error, code: 400 });

    const vRole = oneOf(req.body.role || 'purchase', ROLES, 'Rolle');
    if (vRole.error) return res.status(400).json({ error: vRole.error, code: 400 });

    let amountShare = null;
    if (req.body.amount_share !== undefined && req.body.amount_share !== null && req.body.amount_share !== '') {
      const vShare = num(req.body.amount_share, 'Anteil');
      if (vShare.error) return res.status(400).json({ error: vShare.error, code: 400 });
      if (vShare.value !== null && vShare.value < 0) {
        return res.status(400).json({ error: 'Anteil darf nicht negativ sein.', code: 400 });
      }
      amountShare = vShare.value;
    }

    const userId = req.authUserId || req.session.userId;
    const result = linkEntry({ itemId: item.id, entryId: vEntryId.value, role: vRole.value, amountShare, userId });
    if (result.error) return res.status(result.code).json({ error: result.error, code: result.code });

    res.status(201).json({ data: loadItem(item.id, userId) });
  } catch (err) {
    log.error('POST /:id/entries error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/inventory/items/:id/entries/:entryId
// Entfernt ALLE Verknuepfungen zwischen Gegenstand und Buchung (rollenunabhaengig).
// --------------------------------------------------------
router.delete('/:id/entries/:entryId', (req, res) => {
  try {
    const vId = idParam(req.params.id, 'Gegenstand-ID');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const item = db.get().prepare('SELECT id FROM inventory_items WHERE id = ?').get(vId.value);
    if (!item) return res.status(404).json({ error: 'Item not found.', code: 404 });

    const vEntryId = idParam(req.params.entryId, 'Buchung-ID');
    if (vEntryId.error) return res.status(400).json({ error: vEntryId.error, code: 400 });

    const userId = req.authUserId || req.session.userId;
    const result = unlinkEntry({ itemId: item.id, entryId: vEntryId.value, userId });
    if (result.error) return res.status(result.code).json({ error: result.error, code: result.code });

    res.json({ data: loadItem(item.id, userId) });
  } catch (err) {
    log.error('DELETE /:id/entries/:entryId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/inventory/items/:id/dates/:dateId/complete
// Body: { performed_on, odometer?, vendor?, note? }
// --------------------------------------------------------
router.post('/:id/dates/:dateId/complete', (req, res) => {
  try {
    const vId = idParam(req.params.id, 'Gegenstand-ID');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const vDateId = idParam(req.params.dateId, 'Frist-ID');
    if (vDateId.error) return res.status(400).json({ error: vDateId.error, code: 400 });

    const item = db.get().prepare('SELECT id, created_by, odometer, odometer_on FROM inventory_items WHERE id = ?').get(vId.value);
    if (!item) return res.status(404).json({ error: 'Item not found.', code: 404 });

    const { value, errors } = validateCompletionInput(req.body, item);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const userId = req.authUserId || req.session.userId;
    const result = completeTrackedDate({ item, dateId: vDateId.value, values: value, userId });
    if (result.error) return res.status(result.code).json({ error: result.error, code: result.code });

    res.status(201).json({ data: loadItem(item.id, userId) });
  } catch (err) {
    log.error('POST /:id/dates/:dateId/complete error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET|POST /api/v1/inventory/items/:id/service-log
// --------------------------------------------------------
router.get('/:id/service-log', (req, res) => {
  try {
    const vId = idParam(req.params.id, 'Gegenstand-ID');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const item = db.get().prepare('SELECT id FROM inventory_items WHERE id = ?').get(vId.value);
    if (!item) return res.status(404).json({ error: 'Item not found.', code: 404 });

    res.json({ data: loadServiceLog(item.id) });
  } catch (err) {
    log.error('GET /:id/service-log error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/:id/service-log', (req, res) => {
  try {
    const vId = idParam(req.params.id, 'Gegenstand-ID');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const item = db.get().prepare('SELECT id, odometer, odometer_on FROM inventory_items WHERE id = ?').get(vId.value);
    if (!item) return res.status(404).json({ error: 'Item not found.', code: 404 });

    const { value, errors } = validateServiceLogInput(req.body, item);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const userId = req.authUserId || req.session.userId;
    const entry = createServiceLogEntry({ itemId: item.id, values: value, userId });
    res.status(201).json({ data: entry });
  } catch (err) {
    log.error('POST /:id/service-log error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PUT|DELETE /api/v1/inventory/items/:id/service-log/:logId
// PUT statt PATCH (Review #1257): validateServiceLogInput() verlangt label +
// performed_on und loescht jedes weggelassene Feld - volles Replace, nicht
// Teil-Update. Kein bestehender Aufrufer haengt daran: die App ruft bisher
// nur /complete und /history auf, dieser Weg ist reine /api/v1-Oberflaeche.
// --------------------------------------------------------
router.put('/:id/service-log/:logId', (req, res) => {
  try {
    const vId = idParam(req.params.id, 'Gegenstand-ID');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const vLogId = idParam(req.params.logId, 'Eintrag-ID');
    if (vLogId.error) return res.status(400).json({ error: vLogId.error, code: 400 });
    const item = db.get().prepare('SELECT id, odometer, odometer_on FROM inventory_items WHERE id = ?').get(vId.value);
    if (!item) return res.status(404).json({ error: 'Item not found.', code: 404 });

    // Die bearbeitete Zeile darf den Tippfehler-Schutz nicht gegen ihren
    // eigenen alten Wert pruefen (Review #1257).
    const baseline = odometerBaselineExcluding(item, item.id, vLogId.value);
    const { value, errors } = validateServiceLogInput(req.body, baseline);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const updated = updateServiceLogEntry({ itemId: item.id, logId: vLogId.value, values: value });
    if (!updated) return res.status(404).json({ error: 'Service log entry not found.', code: 404 });
    res.json({ data: updated });
  } catch (err) {
    log.error('PUT /:id/service-log/:logId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.delete('/:id/service-log/:logId', (req, res) => {
  try {
    const vId = idParam(req.params.id, 'Gegenstand-ID');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const vLogId = idParam(req.params.logId, 'Eintrag-ID');
    if (vLogId.error) return res.status(400).json({ error: vLogId.error, code: 400 });
    const item = db.get().prepare('SELECT id FROM inventory_items WHERE id = ?').get(vId.value);
    if (!item) return res.status(404).json({ error: 'Item not found.', code: 404 });

    const deleted = deleteServiceLogEntry({ itemId: item.id, logId: vLogId.value });
    if (deleted.changes === 0) return res.status(404).json({ error: 'Service log entry not found.', code: 404 });
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /:id/service-log/:logId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/inventory/items/:id/history
// Read-only aggregation: service log + linked maintenance/accessory bookings
// + linked documents, merged into one dated timeline (DECISIONS #6).
// --------------------------------------------------------
router.get('/:id/history', (req, res) => {
  try {
    const vId = idParam(req.params.id, 'Gegenstand-ID');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const item = db.get().prepare('SELECT id FROM inventory_items WHERE id = ?').get(vId.value);
    if (!item) return res.status(404).json({ error: 'Item not found.', code: 404 });

    const userId = req.authUserId || req.session.userId;
    res.json({ data: loadHistory(item.id, userId) });
  } catch (err) {
    log.error('GET /:id/history error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/inventory/items/:id
// --------------------------------------------------------
router.delete('/:id', (req, res) => {
  try {
    const vId = idParam(req.params.id, 'Gegenstand-ID');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });

    const deleted = db.get().transaction(() => {
      db.get().prepare("DELETE FROM reminders WHERE entity_type = 'inventory_item' AND entity_id = ?").run(vId.value);
      removeTrackedDateReminders(vId.value);
      return db.get().prepare('DELETE FROM inventory_items WHERE id = ?').run(vId.value);
    })();

    if (deleted.changes === 0) return res.status(404).json({ error: 'Item not found.', code: 404 });
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
