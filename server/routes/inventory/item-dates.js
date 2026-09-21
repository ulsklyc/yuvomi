/**
 * Modul: Inventar - Frei definierbare Fristen je Gegenstand (TÜV, Service, ...)
 * Zweck: Volles Replace bei jedem Item-Speichern (server/routes/inventory/items.js
 *        ruft validateTrackedDatesInput dann writeTrackedDates auf), gleiches
 *        Muster wie server/services/document-links.js#replaceDocumentLinks bzw.
 *        die Mehrfach-Erinnerungen von server/routes/reminders.js (PUT /). Kein
 *        Diffing: freitextliche Zeilen haben keinen natuerlichen Schluessel,
 *        ueber den man "unveraendert" erkennen koennte - anders als Dokumente
 *        (document_id) oder Buchungen (entry_id).
 *
 * Erinnerungs-Ownership: die Zeile "gehoert" dem Gegenstand-Ersteller
 * (item.created_by), nicht der Person, die gerade speichert - identisches
 * Muster wie die Garantie-Erinnerung in items.js#syncReminder.
 *
 * interval_months (Vorrollen beim Abschluss, siehe service-log.js) ist KEINE
 * zweite Wiederholungs-Engine neben server/services/recurrence.js. Die dort
 * geparsten RRULEs beantworten "welcher Wochentag/welche Ordinalzahl im
 * Monat", genau das braucht eine Frist wie "alle 24 Monate" nicht - sie ist
 * dieselbe einfache Monats-Arithmetik wie server/services/subscriptions.js
 * #addBillingCycle und inventory-deadlines.js#warrantyEndDate, deshalb ueber
 * denselben geteilten Helfer (server/utils/interval-date.js#addMonthsClamped),
 * nicht ueber recurrence.js.
 */
import * as db from '../../db.js';
import { str, date, num, collectErrors } from '../../middleware/validate.js';

const MAX_TRACKED_DATES_PER_ITEM = 10;
const DEFAULT_REMINDER_OFFSET_DAYS = 30;

function loadTrackedDates(itemId) {
  return db.get().prepare(`
    SELECT id, item_id, label, date, reminder_offset_days, interval_months, interval_distance,
           created_at, updated_at
    FROM inventory_item_dates
    WHERE item_id = ?
    ORDER BY date ASC, id ASC
  `).all(itemId);
}

function loadTrackedDatesForItems(itemIds) {
  const map = new Map();
  if (!itemIds.length) return map;
  const placeholders = itemIds.map(() => '?').join(',');
  const rows = db.get().prepare(`
    SELECT id, item_id, label, date, reminder_offset_days, interval_months, interval_distance,
           created_at, updated_at
    FROM inventory_item_dates
    WHERE item_id IN (${placeholders})
    ORDER BY date ASC, id ASC
  `).all(...itemIds);
  for (const row of rows) {
    if (!map.has(row.item_id)) map.set(row.item_id, []);
    map.get(row.item_id).push(row);
  }
  return map;
}

/** Eine einzelne getrackte Frist, mit der Gegenstand-ID mitgeliefert
 *  (Ownership-Aufloesung braucht item.created_by, siehe service-log.js). */
function loadTrackedDate(id) {
  return db.get().prepare(`
    SELECT id, item_id, label, date, reminder_offset_days, interval_months, interval_distance,
           created_at, updated_at
    FROM inventory_item_dates
    WHERE id = ?
  `).get(id);
}

function validateTrackedDateRow(row) {
  const results = [];
  const vLabel = str(row?.label, 'Bezeichnung', { max: 100 });
  results.push(vLabel);
  const vDate = date(row?.date, 'Datum', true);
  results.push(vDate);

  let offsetDays = DEFAULT_REMINDER_OFFSET_DAYS;
  if (row?.reminder_offset_days !== undefined && row.reminder_offset_days !== null && row.reminder_offset_days !== '') {
    const vOffset = num(row.reminder_offset_days, 'Erinnerungs-Vorlauf');
    results.push(vOffset);
    if (vOffset.value !== null && (!Number.isInteger(vOffset.value) || vOffset.value < 0 || vOffset.value > 365)) {
      results.push({ error: 'Erinnerungs-Vorlauf muss eine ganze Zahl zwischen 0 und 365 sein.' });
    } else if (vOffset.value !== null) {
      offsetDays = vOffset.value;
    }
  }

  // NULL bleibt das heutige Einmal-Verhalten (keine Wiederholung) - genau wie
  // beim Vorlauf oben wird ein leeres/fehlendes Feld NICHT auf einen Default
  // umgeschrieben, sondern bleibt NULL (server/db.js Migration 224).
  let intervalMonths = null;
  if (row?.interval_months !== undefined && row.interval_months !== null && row.interval_months !== '') {
    const vInterval = num(row.interval_months, 'Wiederholung (Monate)');
    results.push(vInterval);
    if (vInterval.value !== null && (!Number.isInteger(vInterval.value) || vInterval.value < 1 || vInterval.value > 600)) {
      results.push({ error: 'Wiederholung muss eine ganze Zahl zwischen 1 und 600 Monaten sein.' });
    } else if (vInterval.value !== null) {
      intervalMonths = vInterval.value;
    }
  }

  // Nur ein Hinweis, nie eine Erinnerung (siehe Modulkopf von service-log.js) -
  // deshalb reicht hier eine reine Bereichspruefung, kein Default.
  let intervalDistance = null;
  if (row?.interval_distance !== undefined && row.interval_distance !== null && row.interval_distance !== '') {
    const vDistance = num(row.interval_distance, 'Distanz-Intervall');
    results.push(vDistance);
    if (vDistance.value !== null && (!Number.isInteger(vDistance.value) || vDistance.value <= 0)) {
      results.push({ error: 'Distanz-Intervall muss eine positive ganze Zahl sein.' });
    } else if (vDistance.value !== null) {
      intervalDistance = vDistance.value;
    }
  }

  return {
    value: {
      label: vLabel.value, date: vDate.value, reminder_offset_days: offsetDays,
      interval_months: intervalMonths, interval_distance: intervalDistance,
    },
    errors: collectErrors(results),
  };
}

/**
 * Validiert das komplette Array vor jedem Schreiben. Kein DB-Zugriff - reine
 * Funktion, damit sie (wie die Item-Feld-Validierung in items.js) VOR der
 * Transaktion laufen kann und ein 400 nie einen halb geschriebenen Zustand
 * hinterlaesst.
 */
function validateTrackedDatesInput(rows) {
  const input = Array.isArray(rows) ? rows : [];
  if (input.length > MAX_TRACKED_DATES_PER_ITEM) {
    return { values: null, errors: [`Maximal ${MAX_TRACKED_DATES_PER_ITEM} Fristen je Gegenstand.`] };
  }

  const values = [];
  const allErrors = [];
  for (const row of input) {
    const { value, errors } = validateTrackedDateRow(row);
    if (errors.length) allErrors.push(...errors);
    else values.push(value);
  }
  return { values: allErrors.length ? null : values, errors: allErrors };
}

function reminderDateFromOffset(dateKey, offsetDays) {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - Math.max(0, Number(offsetDays) || 0));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}T09:00`;
}

/**
 * Erinnerungs-Sync fuer eine einzelne getrackte Frist, identisches Muster wie
 * server/routes/inventory/items.js#syncReminder - hier mit dem zeilen-eigenen
 * Vorlauf statt eines festen Werts.
 */
function syncTrackedDateReminder(trackedDate, createdBy) {
  if (!createdBy) return;
  const remindAt = reminderDateFromOffset(trackedDate.date, trackedDate.reminder_offset_days);
  if (new Date(`${remindAt}Z`).getTime() <= Date.now()) return;
  db.get().prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('inventory_tracked_date', ?, ?, ?)
  `).run(trackedDate.id, remindAt, createdBy);
}

/**
 * Loescht alle Fristen-Erinnerungen eines Gegenstands in einem Statement.
 * reminders.entity_id hat keinen FK auf inventory_item_dates, die Zuordnung
 * laeuft also ueber die korrelierte Unterabfrage statt ueber ein CASCADE.
 */
function deleteTrackedDateReminders(database, itemId) {
  database.prepare(`
    DELETE FROM reminders WHERE entity_type = 'inventory_tracked_date'
      AND entity_id IN (SELECT id FROM inventory_item_dates WHERE item_id = ?)
  `).run(itemId);
}

/**
 * Volles Replace: alle bestehenden Zeilen (+ ihre Erinnerungen) loeschen, dann
 * die neue, bereits validierte Menge einfuegen. Wird innerhalb derselben
 * Transaktion wie der Item-Schreibvorgang aufgerufen (siehe items.js), damit
 * kein halb geschriebener Zustand entsteht.
 */
function writeTrackedDates(itemId, values, createdBy) {
  const database = db.get();
  deleteTrackedDateReminders(database, itemId);
  database.prepare('DELETE FROM inventory_item_dates WHERE item_id = ?').run(itemId);

  const insert = database.prepare(`
    INSERT INTO inventory_item_dates (item_id, label, date, reminder_offset_days, interval_months, interval_distance, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of values) {
    const result = insert.run(itemId, row.label, row.date, row.reminder_offset_days, row.interval_months, row.interval_distance, createdBy);
    syncTrackedDateReminder({ id: result.lastInsertRowid, date: row.date, reminder_offset_days: row.reminder_offset_days }, createdBy);
  }
}

/**
 * Rollt eine EINZELNE getrackte Frist auf ein neues Datum vor und synct ihre
 * Erinnerung neu - anders als writeTrackedDates() KEIN Replace: die Zeile
 * behaelt ihre id (server/routes/inventory/service-log.js#completeTrackedDate
 * braucht das fuer die ICS-UID, siehe inventory-deadlines-ics.js:64). Nur ein
 * Speichern des ganzen Items (writeTrackedDates) vergibt neue ids.
 */
function rollTrackedDateForward(trackedDate, newDate, createdBy) {
  const database = db.get();
  database.prepare(`DELETE FROM reminders WHERE entity_type = 'inventory_tracked_date' AND entity_id = ?`).run(trackedDate.id);
  database.prepare('UPDATE inventory_item_dates SET date = ? WHERE id = ?').run(newDate, trackedDate.id);
  syncTrackedDateReminder({ id: trackedDate.id, date: newDate, reminder_offset_days: trackedDate.reminder_offset_days }, createdBy);
}

/** Raeumt eine EINZELNE getrackte Frist samt ihrer Erinnerung ab - fuer eine
 *  Einmal-Frist (kein interval_months), die gerade erledigt wurde: die
 *  Historie lebt ab jetzt allein im Service-Log-Eintrag (Momentaufnahme),
 *  die Frist selbst hat nichts mehr zu tun. */
function removeTrackedDate(trackedDateId) {
  const database = db.get();
  database.prepare(`DELETE FROM reminders WHERE entity_type = 'inventory_tracked_date' AND entity_id = ?`).run(trackedDateId);
  database.prepare('DELETE FROM inventory_item_dates WHERE id = ?').run(trackedDateId);
}

/** Beim Loeschen eines Gegenstands: alle Erinnerungen seiner Fristen abraeumen,
 *  BEVOR die CASCADE die inventory_item_dates-Zeilen selbst entfernt -
 *  reminders.entity_id hat keinen FK, der das automatisch erledigt. */
function removeTrackedDateReminders(itemId) {
  deleteTrackedDateReminders(db.get(), itemId);
}

export {
  loadTrackedDates, loadTrackedDatesForItems, loadTrackedDate, validateTrackedDatesInput, writeTrackedDates,
  rollTrackedDateForward, removeTrackedDate, removeTrackedDateReminders, MAX_TRACKED_DATES_PER_ITEM,
};
