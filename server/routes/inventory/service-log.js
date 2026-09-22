/**
 * Modul: Inventar - Service-Log und Verlaufs-Ansicht (TÜV, Wartung, ...)
 * Zweck: Helfer-Modul, KEIN Router (gleicher Schnitt wie item-dates.js und
 *        entry-links.js) - die Routen selbst liegen in items.js neben den
 *        bestehenden /:id/entries-Routen.
 *
 * Drei Dinge leben hier:
 *   1. Die "Erledigt"-Aktion (completeTrackedDate): ein Log-Eintrag entsteht,
 *      und je nachdem, ob die Frist ein interval_months traegt, rollt das
 *      Datum weiter (addMonthsClamped, server/utils/interval-date.js) oder die
 *      Frist verschwindet - siehe item-dates.js#rollTrackedDateForward/
 *      removeTrackedDate fuer die Begruendung, warum eine Zeile ihre id
 *      dabei behaelt.
 *   2. Plain CRUD auf inventory_item_service_log.
 *   3. Die Verlaufs-Ansicht (loadHistory): eine REINE Zusammenfuehrung von
 *      Log-Zeilen, verknuepften Buchungen (entry-links.js, Rollen
 *      maintenance/accessory) und verknuepften Dokumenten
 *      (document-links.js) - kein neuer Speicher (DECISIONS.md #6). Beide
 *      bestehenden Sichtbarkeitsregeln (budgetDetailsVisibleWhere ueber
 *      loadLinkedEntries, documentVisibleSql ueber documentLinksFor) laufen
 *      unveraendert mit - keine zweite Kopie (DECISIONS.md #2).
 *
 * Inventar hat kein Sichtbarkeitsmodell je Gegenstand - Gegenstaende sind
 * haushaltweit (items.js Modulkopf). Log-Zeilen sind es deshalb auch: keine
 * neue Sichtbarkeits-Vokabel fuer sie erfinden.
 */
import * as db from '../../db.js';
import {
  str, date, num, collectErrors, MAX_SHORT, MAX_TEXT,
} from '../../middleware/validate.js';
import { addMonthsClamped, parseDateKey } from '../../utils/interval-date.js';
import {
  loadTrackedDate, rollTrackedDateForward, removeTrackedDate,
} from './item-dates.js';
import { loadLinkedEntries, computeTotal } from './entry-links.js';
import { documentLinksFor } from '../../services/document-links.js';
import { householdTimeZone, utcToWall } from '../../utils/timezone.js';

/** Rollen, die im Service-Verlauf zaehlen - dieselben, die das Formular unter
 *  "Reparatur/Wartung" bzw. "Zubehoer" anbietet (entry-links.js#ROLES). */
const HISTORY_ENTRY_ROLES = ['maintenance', 'accessory'];
const DOCS = { table: 'inventory_item_documents', ownerColumn: 'item_id' };
// Die Speicherform von inventory_item_dates.date: vier Stellen Jahr, also
// hoechstens 9999-12-31.
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Ein Eintrag, der den AKTUELLEN Kilometerstand des Gegenstands stellen
 * wuerde (sein Datum ist die neueste bekannte Ablesung, siehe
 * maybeAdvanceItemOdometer), darf keinen niedrigeren Wert tragen als der
 * bisherige aktuelle Stand - ein Fahrzeug faehrt nicht rueckwaerts. `5120`
 * statt `51200` getippt wuerde sonst den aktuellen Stand des Gegenstands
 * stillschweigend zuruecksetzen (maybeAdvanceItemOdometer war frueher nur
 * eine Datums-, keine Wert-Pruefung). Eine RUECKDATIERTE Reparatur bleibt
 * dagegen ausdruecklich erlaubt, auch mit einem niedrigeren Stand als der
 * aktuelle: ihr Datum liegt vor der neuesten Ablesung, sie konkurriert also
 * gar nicht um den aktuellen Wert (maybeAdvanceItemOdometer laesst sie
 * unangetastet).
 * @param {{odometer:number|null,odometer_on:string|null}|undefined} item
 * @param {number|null} odometer
 * @param {string|null} performedOn
 * @returns {string|null} Fehlertext, oder null wenn unbedenklich
 */
function odometerRegressionError(item, odometer, performedOn) {
  if (odometer == null || item?.odometer == null || item.odometer_on == null) return null;
  if (performedOn == null || performedOn < item.odometer_on) return null;
  if (odometer < item.odometer) {
    return `Kilometerstand darf nicht unter den zuletzt erfassten Stand (${item.odometer}) fallen.`;
  }
  return null;
}

function validateServiceLogInput(body, item) {
  const results = [];
  const vLabel = str(body?.label, 'Bezeichnung', { max: 100 });
  results.push(vLabel);
  const vPerformedOn = date(body?.performed_on, 'Datum', true);
  results.push(vPerformedOn);

  let odometer = null;
  if (body?.odometer !== undefined && body.odometer !== null && body.odometer !== '') {
    const vOdometer = num(body.odometer, 'Kilometerstand');
    results.push(vOdometer);
    if (vOdometer.value !== null && (!Number.isInteger(vOdometer.value) || vOdometer.value < 0)) {
      results.push({ error: 'Kilometerstand darf nicht negativ sein.' });
    } else if (vOdometer.value !== null) {
      odometer = vOdometer.value;
    }
  }
  const regressionError = odometerRegressionError(item, odometer, vPerformedOn.value);
  if (regressionError) results.push({ error: regressionError });

  const vVendor = str(body?.vendor, 'Haendler', { max: MAX_SHORT, required: false });
  results.push(vVendor);
  const vNote = str(body?.note, 'Notiz', { max: MAX_TEXT, required: false });
  results.push(vNote);

  return {
    value: {
      label: vLabel.value, performed_on: vPerformedOn.value, odometer,
      vendor: vVendor.value, note: vNote.value,
    },
    errors: collectErrors(results),
  };
}

/**
 * Wie validateServiceLogInput, aber ohne Bezeichnung - die "Erledigt"-Aktion
 * uebernimmt sie von der getrackten Frist selbst (completeTrackedDate), sie
 * kommt hier nie aus dem Body.
 */
function validateCompletionInput(body, item) {
  const results = [];
  const vPerformedOn = date(body?.performed_on, 'Datum', true);
  results.push(vPerformedOn);

  let odometer = null;
  if (body?.odometer !== undefined && body.odometer !== null && body.odometer !== '') {
    const vOdometer = num(body.odometer, 'Kilometerstand');
    results.push(vOdometer);
    if (vOdometer.value !== null && (!Number.isInteger(vOdometer.value) || vOdometer.value < 0)) {
      results.push({ error: 'Kilometerstand darf nicht negativ sein.' });
    } else if (vOdometer.value !== null) {
      odometer = vOdometer.value;
    }
  }
  const regressionError = odometerRegressionError(item, odometer, vPerformedOn.value);
  if (regressionError) results.push({ error: regressionError });

  const vVendor = str(body?.vendor, 'Haendler', { max: MAX_SHORT, required: false });
  results.push(vVendor);
  const vNote = str(body?.note, 'Notiz', { max: MAX_TEXT, required: false });
  results.push(vNote);

  return {
    value: { performed_on: vPerformedOn.value, odometer, vendor: vVendor.value, note: vNote.value },
    errors: collectErrors(results),
  };
}

function loadServiceLog(itemId) {
  return db.get().prepare(`
    SELECT id, item_id, item_date_id, label, performed_on, odometer, vendor, note, created_by, created_at, updated_at
    FROM inventory_item_service_log
    WHERE item_id = ?
    ORDER BY performed_on DESC, id DESC
  `).all(itemId);
}

function loadServiceLogEntry(itemId, logId) {
  return db.get().prepare(`
    SELECT id, item_id, item_date_id, label, performed_on, odometer, vendor, note, created_by, created_at, updated_at
    FROM inventory_item_service_log
    WHERE id = ? AND item_id = ?
  `).get(logId, itemId);
}

/** Spiegelt items.js#categoryTracksOdometer, hier ueber item_id statt Kategorie-Key -
 *  ein Log-Eintrag mit odometer auf einem Gegenstand ausserhalb einer odometer-
 *  tragenden Kategorie darf inventory_items.odometer nicht setzen, auch wenn
 *  das Formular das Feld fuer diese Kategorie gar nicht mehr zeigt (Review #1257). */
function itemCategoryTracksOdometer(itemId) {
  return db.get().prepare(`
    SELECT ic.tracks_odometer FROM inventory_items ii
    JOIN inventory_categories ic ON ic.key = ii.category
    WHERE ii.id = ?
  `).get(itemId)?.tracks_odometer === 1;
}

/**
 * Ein Kilometerstand auf einer Log-Zeile schreibt inventory_items.odometer nur
 * fort, wenn er die neueste Ablesung ist - ein rueckdatierter Reparatur-
 * Eintrag darf den aktuellen Kilometerstand des Fahrzeugs nicht zuruecksetzen.
 *
 * odometer_unit gehoert dem GEGENSTAND, nicht der Log-Zeile (die Tabelle hat
 * keine eigene Einheiten-Spalte - jede Ablesung eines Gegenstands gilt in
 * derselben Einheit). Ein bereits gewaehlter Wert (z. B. 'mi') bleibt stehen;
 * ohne einen wird 'km' Standard, dieselbe Regel wie
 * items.js#validateItemFields() fuer eine im Formular eingetragene erste
 * Ablesung (Review #1257: vorher blieb odometer_unit hier immer NULL, und
 * 'km' erschien fuer ein Meilen-Fahrzeug an jeder Anzeigestelle).
 */
function maybeAdvanceItemOdometer(itemId, performedOn, odometer) {
  if (odometer == null) return;
  if (!itemCategoryTracksOdometer(itemId)) return;
  const item = db.get().prepare('SELECT odometer_on FROM inventory_items WHERE id = ?').get(itemId);
  if (!item) return;
  if (item.odometer_on == null || performedOn >= item.odometer_on) {
    db.get().prepare(`
      UPDATE inventory_items
      SET odometer = ?, odometer_on = ?, odometer_unit = COALESCE(odometer_unit, 'km')
      WHERE id = ?
    `).run(odometer, performedOn, itemId);
  }
}

function createServiceLogEntry({ itemId, values, userId }) {
  const result = db.get().transaction(() => {
    const inserted = db.get().prepare(`
      INSERT INTO inventory_item_service_log (item_id, label, performed_on, odometer, vendor, note, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(itemId, values.label, values.performed_on, values.odometer, values.vendor, values.note, userId);
    maybeAdvanceItemOdometer(itemId, values.performed_on, values.odometer);
    return inserted;
  })();
  return loadServiceLogEntry(itemId, result.lastInsertRowid);
}

function updateServiceLogEntry({ itemId, logId, values }) {
  const existing = loadServiceLogEntry(itemId, logId);
  if (!existing) return null;
  db.get().transaction(() => {
    // Vor dem Schreiben pruefen, ob DIESE Zeile (mit ihrem ALTEN Wert) die
    // Quelle des zwischengespeicherten Stands war - derselbe Guard wie
    // deleteServiceLogEntry(), nur fuer UPDATE statt DELETE (Review #1257).
    // War sie es, kann ein blosses maybeAdvanceItemOdometer() mit den NEUEN
    // Werten den Stand nicht mehr korrekt herleiten (die alte, jetzt
    // ueberschriebene Ablesung bleibt im Cache stehen, obwohl ihre Quelle
    // gerade einen anderen Wert bekommen hat) - stattdessen zaehlt neu, was
    // ALLE verbleibenden Zeilen (inklusive der geaenderten) jetzt hergeben.
    const item = db.get().prepare('SELECT odometer, odometer_on FROM inventory_items WHERE id = ?').get(itemId);
    const wasSource = item && existing.odometer != null
      && item.odometer === existing.odometer && item.odometer_on === existing.performed_on;

    db.get().prepare(`
      UPDATE inventory_item_service_log
      SET label = ?, performed_on = ?, odometer = ?, vendor = ?, note = ?
      WHERE id = ?
    `).run(values.label, values.performed_on, values.odometer, values.vendor, values.note, logId);

    if (wasSource) {
      recomputeItemOdometer(itemId);
    } else {
      maybeAdvanceItemOdometer(itemId, values.performed_on, values.odometer);
    }
  })();
  return loadServiceLogEntry(itemId, logId);
}

/**
 * Fehlt bislang das Gegenstueck zu maybeAdvanceItemOdometer: das Loeschen der
 * Log-Zeile, die den aktuellen Kilometerstand des Gegenstands zuletzt gesetzt
 * hat, liesse den Gegenstand sonst auf einem Stand stehen, dessen Quelle es
 * nicht mehr gibt. Setzt auf die neueste VERBLEIBENDE Ablesung zurueck, oder
 * auf NULL, wenn keine Log-Zeile mehr eine traegt.
 *
 * odometer_unit bleibt dabei stehen, wenn keine Ablesung uebrig ist: die
 * Einheit kann im Formular gewaehlt worden sein, ohne dass je eine Ablesung
 * dabei war, und ohne Ablesung zeigt keine Stelle sie an. Sie auf NULL zu
 * setzen, liesse die naechste Ablesung als 'km' hereinkommen - bei einem
 * Meilen-Fahrzeug genau der Fehler, den maybeAdvanceItemOdometer() schliesst.
 *
 * Braucht dieselbe tracks_odometer-Sperre wie maybeAdvanceItemOdometer - aber
 * hier RAEUMT das Gate ab, statt nur abzubrechen (Review #1257, Runde 2 an
 * dieser Sperre): diese Funktion ist die Aufraeum-Funktion selbst, ein
 * blosses return liesse den Gegenstand auf einer verwaisten Ablesung stehen,
 * deren Quelle es nicht mehr gibt - genau die Sperre wuerde dann verhindern,
 * dass sie je wieder abgeraeumt wird. Dieselbe Regel wie
 * items.js#validateItemFields() beim Kategoriewechsel: keine tracking-
 * Kategorie heisst odometer/odometer_unit/odometer_on werden NULL, nicht
 * "bleiben stehen, wie sie sind".
 */
function recomputeItemOdometer(itemId) {
  if (!itemCategoryTracksOdometer(itemId)) {
    db.get().prepare('UPDATE inventory_items SET odometer = NULL, odometer_unit = NULL, odometer_on = NULL WHERE id = ?').run(itemId);
    return;
  }
  const latest = db.get().prepare(`
    SELECT performed_on, odometer FROM inventory_item_service_log
    WHERE item_id = ? AND odometer IS NOT NULL
    ORDER BY performed_on DESC, id DESC LIMIT 1
  `).get(itemId);
  db.get().prepare(`
    UPDATE inventory_items
    SET odometer = ?, odometer_on = ?,
        odometer_unit = CASE WHEN ? IS NULL THEN odometer_unit ELSE COALESCE(odometer_unit, 'km') END
    WHERE id = ?
  `).run(latest?.odometer ?? null, latest?.performed_on ?? null, latest?.odometer ?? null, itemId);
}

/**
 * PUT auf eine Log-Zeile darf den Tippfehler-Schutz nicht gegen den EIGENEN
 * alten Wert der Zeile pruefen, die gerade bearbeitet wird - sonst blockiert
 * jede Korrektur dieser einen Zeile sich selbst (z. B. 520000 auf 52000
 * richtigstellen scheitert daran, dass 520000 noch der zwischengespeicherte
 * Stand ist). War diese Zeile die Quelle des aktuellen Stands, zaehlt
 * stattdessen der Stand, der ohne sie gelten wuerde (dieselbe Ableitung wie
 * recomputeItemOdometer(), nur ohne sie zu schreiben - Review #1257).
 */
function odometerBaselineExcluding(item, itemId, excludeLogId) {
  const excluded = db.get().prepare(
    'SELECT performed_on, odometer FROM inventory_item_service_log WHERE id = ? AND item_id = ?'
  ).get(excludeLogId, itemId);
  if (!excluded || excluded.odometer == null) return item;
  if (item?.odometer !== excluded.odometer || item?.odometer_on !== excluded.performed_on) return item;

  const latest = db.get().prepare(`
    SELECT performed_on, odometer FROM inventory_item_service_log
    WHERE item_id = ? AND id != ? AND odometer IS NOT NULL
    ORDER BY performed_on DESC, id DESC LIMIT 1
  `).get(itemId, excludeLogId);
  return { odometer: latest?.odometer ?? null, odometer_on: latest?.performed_on ?? null };
}

function deleteServiceLogEntry({ itemId, logId }) {
  const result = db.get().transaction(() => {
    // Vor dem Loeschen pruefen, ob DIESE Zeile ueberhaupt den aktuell
    // zwischengespeicherten Kilometerstand gesetzt hat - eine rueckdatierte
    // oder sonst nicht fuehrende Zeile darf einen unabhaengig (z. B. im
    // Formular) gesetzten Stand nicht mitreissen, nur weil sie geloescht wird
    // (Review #1257).
    const logRow = db.get().prepare(
      'SELECT performed_on, odometer FROM inventory_item_service_log WHERE id = ? AND item_id = ?'
    ).get(logId, itemId);
    const changes = db.get().prepare('DELETE FROM inventory_item_service_log WHERE id = ? AND item_id = ?').run(logId, itemId);
    if (changes.changes > 0 && logRow?.odometer != null) {
      const item = db.get().prepare('SELECT odometer, odometer_on FROM inventory_items WHERE id = ?').get(itemId);
      if (item && item.odometer === logRow.odometer && item.odometer_on === logRow.performed_on) {
        recomputeItemOdometer(itemId);
      }
    }
    return changes;
  })();
  return result;
}

/** Ganze Kalendermonate zwischen zwei YYYY-MM-DD-Werten (Tag ignoriert) -
 *  ein erster, geschlossen berechneter Sprung fuer rollForwardPast(), statt
 *  sich monatsweise ans Ziel heranzutasten. */
function monthsBetween(fromKey, toKey) {
  const from = parseDateKey(fromKey);
  const to = parseDateKey(toKey);
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
}

/**
 * Rollt `fromDate` in interval_months-Schritten vor, bis das Ergebnis nach
 * `afterDate` liegt - das ERSTE solche Vielfache, nie eins dahinter. Jeder
 * Kandidat wird vom Ausgangsdatum aus gerechnet (fromDate + k * Intervall),
 * nicht Schritt fuer Schritt, damit sich die Tages-Klemmung nicht aufsummiert.
 *
 * `performed_on` ist Nutzereingabe; eine Schleife, die ein Intervall je
 * Durchlauf vorankommt, liefe bei einem Datum Jahrzehnte in der Zukunft
 * entsprechend oft (Review #1257). floor(monthsBetween / Intervall) ist
 * deshalb der Einstieg: dieses Vielfache landet hoechstens im Monat von
 * `afterDate`, nie danach, und das naechste liegt schon in einem spaeteren
 * Monat - die Schleife dreht also hoechstens einmal (gleicher Monat, Tag noch
 * nicht erreicht). Ein ceil()-Einstieg sprang in genau diesem Fall ein
 * Intervall zu weit: faellig 2025-06-10, jaehrlich, erledigt 2026-06-05
 * ergab 2027-06-10 statt 2026-06-10.
 *
 * Gibt null zurueck, wenn diese Marke hinter 9999-12-31 laege - der Aufrufer
 * weist die Erledigung dann ab, statt ein fuenfstelliges Jahr zu speichern.
 */
function rollForwardPast(fromDate, intervalMonths, afterDate) {
  let k = Math.max(1, Math.floor(monthsBetween(fromDate, afterDate) / intervalMonths));
  for (;;) {
    const candidate = addMonthsClamped(fromDate, k * intervalMonths);
    // Jenseits von 9999-12-31 hat das Jahr fuenf Stellen, und der Textvergleich
    // unten traegt nicht mehr ('10000-…' < '9999-…'): die Schleife lief an der
    // Grenze vorbei bis '99990-…', und genau das landete in der Frist.
    if (!DATE_KEY_RE.test(candidate)) return null;
    if (candidate > afterDate) return candidate;
    k += 1;
  }
}

/**
 * Die "Erledigt"-Aktion: EINE Transaktion (Log-Zeile schreiben, Frist
 * vorrollen ODER abraeumen, Erinnerung neu synct). Die Erinnerung gehoert
 * item.created_by, nicht der Person, die gerade klickt - identisches Muster
 * wie item-dates.js selbst (Modulkopf) und items.js#syncReminder.
 *
 * Gibt nur {ok:true} oder {error, code} zurueck - der einzige Aufrufer
 * (items.js) laedt den Gegenstand danach ohnehin per loadItem() neu, ein
 * Ruecklauf der geschriebenen Zeilen waere zwei ungenutzte Extra-Abfragen je
 * Aufruf gewesen (Review #1257).
 * @returns {{ok:true}|{error:string, code:number}}
 */
function completeTrackedDate({ item, dateId, values, userId }) {
  const trackedDate = loadTrackedDate(dateId);
  if (!trackedDate || trackedDate.item_id !== item.id) {
    return { error: 'Tracked date not found.', code: 404 };
  }

  // Vom FAELLIGKEITSDATUM aus vorrollen, nicht vom Erledigungsdatum - eine
  // laengst ueberfaellige Frist (mehr als ein Intervall alt) rollte sonst
  // nur EINMAL vor und landete erneut in der Vergangenheit: die Zeile
  // bliebe ueberfaellig, keine Erinnerung entstuende (syncTrackedDateReminder
  // verwirft einen bereits vergangenen remind_at), und ein zweiter Klick auf
  // "Erledigt" schriebe eine zweite Log-Zeile mit demselben performed_on.
  // Auf die ERSTE Intervall-Marke nach dem Erledigungsdatum vorrollen.
  // Gerechnet VOR der Transaktion: liegt die Marke hinter dem letzten
  // darstellbaren Tag, entsteht weder die Log-Zeile noch eine Aenderung.
  const nextDate = trackedDate.interval_months != null
    ? rollForwardPast(trackedDate.date, trackedDate.interval_months, values.performed_on)
    : null;
  if (trackedDate.interval_months != null && nextDate === null) {
    return {
      error: 'The next due date would fall after 9999-12-31. Choose an earlier completion date or remove the interval.',
      code: 400,
    };
  }

  db.get().transaction(() => {
    const inserted = db.get().prepare(`
      INSERT INTO inventory_item_service_log
        (item_id, item_date_id, label, performed_on, odometer, vendor, note, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.id, trackedDate.id, trackedDate.label, values.performed_on,
      values.odometer, values.vendor, values.note, userId,
    );

    maybeAdvanceItemOdometer(item.id, values.performed_on, values.odometer);

    if (trackedDate.interval_months != null) {
      rollTrackedDateForward(trackedDate, nextDate, item.created_by);
    } else {
      removeTrackedDate(trackedDate.id);
    }

    return inserted;
  })();

  return { ok: true };
}

/**
 * Die Verlaufs-Ansicht: Log-Zeilen + verknuepfte Buchungen (Rollen
 * maintenance/accessory) + verknuepfte Dokumente, zu EINER nach Datum
 * sortierten Zeitleiste zusammengefuehrt. Reine Aggregation, kein neuer
 * Speicher (DECISIONS.md #6) - beide Sichtbarkeitsregeln laufen ueber ihre
 * bestehenden, einzigen Stellen (DECISIONS.md #2).
 *
 * `viewer` ist `documentViewer(req)`. Ohne Leserecht auf die Dokumente kommen
 * die Belege maskiert (#1358) - eine Verlaufszeile ohne Namen und Ziel sagt
 * nichts, sie faellt deshalb ganz weg.
 */
function loadHistory(itemId, userId, viewer) {
  const logRows = loadServiceLog(itemId).map((row) => ({
    type: 'service_log',
    id: row.id,
    date: row.performed_on,
    label: row.label,
    odometer: row.odometer,
    vendor: row.vendor,
    note: row.note,
  }));

  const bookingLinks = loadLinkedEntries(itemId, userId)
    .filter((link) => HISTORY_ENTRY_ROLES.includes(link.role));
  const bookingRows = bookingLinks.map((link) => ({
    type: 'budget_entry',
    id: link.entry_id,
    date: link.date,
    label: link.title,
    role: link.role,
    amount: link.amount,
  }));

  const householdTz = householdTimeZone(db.get());
  const documents = documentLinksFor(db.get(), { ...DOCS, ownerId: itemId, viewer })
    .filter((doc) => doc.document_id != null);
  const documentRows = documents.map((doc) => ({
    type: 'document',
    id: doc.document_id,
    // doc.created_at ist ein UTC-Instant (%Y-%m-%dT%H:%M:%SZ) - der Link-
    // Zeitpunkt, nicht das Dokument-Datum selbst -, gemischt in eine Zeitleiste
    // aus reinen Tages-Schluesseln (performed_on/link.date). In die
    // Haushaltszone gewandelt (utcToWall, dieselbe Funktion wie todayKey())
    // statt auf den UTC-Tag gekuerzt - ein Abend-Link faellt sonst genau auf
    // den Nachbartag, den dieser Kommentar vermeiden wollte (Review #1257).
    date: utcToWall(doc.created_at, householdTz)?.date ?? String(doc.created_at).slice(0, 10),
    label: doc.name || doc.original_name || '',
  }));

  const timeline = [...logRows, ...bookingRows, ...documentRows]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return { timeline, total: computeTotal(bookingLinks) };
}

export {
  HISTORY_ENTRY_ROLES,
  validateServiceLogInput,
  validateCompletionInput,
  odometerBaselineExcluding,
  loadServiceLog,
  loadServiceLogEntry,
  createServiceLogEntry,
  updateServiceLogEntry,
  deleteServiceLogEntry,
  completeTrackedDate,
  loadHistory,
};
