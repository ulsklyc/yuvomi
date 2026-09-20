/**
 * Modul: Herkunft einer Erinnerung (entity_type -> Modul)
 * Zweck: EINE Karte fuer die Frage, zu welchem Modul eine `reminders`-Zeile
 *        gehoert. Gelesen von GET /reminders/pending (server/routes/reminders.js:
 *        Token-Scopes, Mitgliedsrechte, Haushaltsschalter) und von der Zustellung
 *        (server/services/notifications.js#processDueNotifications:
 *        Haushaltsschalter und Mitgliedsrechte). Bis #1279 stand die Karte nur
 *        im Router, und die Zustellung fragte gar nicht nach dem Modul; bis
 *        #1289 fragte sie nicht nach den Rechten des Empfaengers.
 * Abhaengigkeiten: server/services/household-modules.js, server/permissions.js
 */
import { householdDisabledModules } from './household-modules.js';
// Nur die Aufloesung, nicht server/db.js: die Zustellung reicht ihre eigene
// Verbindung herein, und permissions.js haengt bewusst an nichts weiter als
// scopes.js/display-scopes.js (siehe dessen Kommentarkopf).
import { resolvePermissions, buildSessionModuleAccess, deniedModules } from '../permissions.js';

/* EINE KARTE UEBER ALLE HERKUENFTE, OHNE AUSNAHME FUER DIE NEUESTE.
 *
 * `/api/v1/reminders` loest ueber `moduleForPath()` auf `calendar` auf, die
 * Zeilen stammen aber aus vielen Modulen (siehe den Kommentar ueber
 * `mayTouchOrigin()` in server/routes/reminders.js). Was hier fehlt, liefert
 * der Router nicht aus: `mayTouchOrigin()` lehnt eine unbekannte Herkunft ab.
 * Eine neue Herkunft, die nur in VALID_ENTITY_TYPES und der CHECK-Liste der
 * Migration landet, verschwaende also still aus `/pending` - dagegen haelt
 * test/test-disabled-module-reminders.js jeden Wert beider Listen an diese
 * Karte. */
export const ORIGIN_MODULE = Object.freeze({
  task:                   'tasks',
  event:                  'calendar',
  subscription:           'budget',
  inventory_item:         'inventory',
  inventory_tracked_date: 'inventory',
  pantry_item:            'pantry',
  cycle_period:           'health',
  cycle_log_nudge:        'health',
  schedule_entry:         'schedule',
  schedule_extra_entry:   'schedule',
  waste_pickup:           'waste',
  document_expiry:        'documents',
});

/**
 * Gehoert dieser Termin einem Geburtstag? Geburtstage schreiben ihre
 * Erinnerungen als `event` an den Kalendertermin, den sie selbst anlegen
 * (services/birthdays.js#syncBirthdayReminder), die Karte oben sieht darin
 * also Kalender. Fuer den Haushaltsschalter sind es aber zwei Module.
 */
function isBirthdayEvent(database, eventId) {
  return Boolean(database.prepare(`
    SELECT 1 FROM birthdays WHERE calendar_event_id = ? OR name_day_calendar_event_id = ? LIMIT 1
  `).get(eventId, eventId));
}

/**
 * Die Zeilen ohne die, deren Modul im Haushalt abgeschaltet ist (#1279).
 *
 * UEBERSPRINGEN, NICHT LOESCHEN. Eine Aufgaben- oder Termin-Erinnerung hat
 * jemand von Hand gesetzt; Abo-, Inventar- und Dokument-Erinnerungen entstehen
 * nur beim SCHREIBEN ihres Datensatzes. Keine davon legt ein Lauf wieder an -
 * geloescht kaeme sie nach dem Wiedereinschalten nie zurueck. Die Zeile bleibt
 * deshalb ausstehend und wird nach dem Wiedereinschalten zugestellt wie nach
 * einem Serverausfall (die Zustellung kennt keine Altersgrenze). Quellen, die
 * ein Lauf periodisch neu herstellt (Vorrat, Schichtplan, Muell, Zyklus,
 * Geburtstage), raeumen ihre Zeilen zusaetzlich selbst ab; fuer sie ist dieser
 * Filter nur der Riegel zwischen zwei Laeufen.
 *
 * GEBURTSTAGE SIND DIE EINE AUSNAHME VON DER KARTE: ihre `event`-Zeilen folgen
 * dem Schalter `birthdays`, nicht `calendar`. Ohne diese Unterscheidung naehme
 * ein abgeschalteter Kalender einem Haushalt mit eingeschalteten Geburtstagen
 * deren Meldungen weg. Nachgeschlagen wird nur, wenn einer der beiden Schalter
 * ueberhaupt steht.
 *
 * Synchron, ohne `await`: die Aufrufer lesen die Zeilen unmittelbar davor.
 *
 * @param {object} database
 * @param {Array<{entity_type: string, entity_id: number}>} rows
 * @returns {Array} dieselben Zeilenobjekte, gefiltert
 */
export function withoutSwitchedOffModules(database, rows) {
  const off = householdDisabledModules(database);
  if (!off.size) return rows;
  const eventsNeedLookup = off.has('calendar') || off.has('birthdays');
  return rows.filter((row) => {
    if (row.entity_type === 'event' && eventsNeedLookup) {
      return !off.has(isBirthdayEvent(database, row.entity_id) ? 'birthdays' : 'calendar');
    }
    return !off.has(ORIGIN_MODULE[row.entity_type]);
  });
}

/**
 * Die Module, die DIESEM Empfaenger ganz entzogen sind - oder `null`, wenn es
 * ihn gar nicht (mehr) gibt.
 *
 * DIESELBEN ZWEI SCHRITTE WIE IM ROUTER, nicht eine zweite Schreibweise:
 * `resolvePermissions()` -> `buildSessionModuleAccess()` -> `deniedModules()`
 * ist genau der Weg, den `req.sessionModuleAccess` in server/auth.js nimmt und
 * den `mayTouchOrigin()` in server/routes/reminders.js auswertet. Damit zaehlt
 * hier wie dort nur `none`, nicht `read`: wer ein Modul lesen darf, darf auch
 * von ihm hoeren - ein Filter, der ihm die Meldung naehme, haette aus einer
 * Leseberechtigung eine Sperre gemacht. Ein Admin faellt ueber
 * `buildSessionModuleAccess()` auf `null` und damit auf die leere Menge.
 *
 * `null` STATT DER LEEREN MENGE FUER EINEN UNBEKANNTEN EMPFAENGER, und das ist
 * kein Geschmack (siehe `creatorLacksPantry()` in services/pantry-reminders.js):
 * eine Denylist beantwortet "unbekannte ID" mit "nichts gesperrt", also mit JA.
 * Ohne Konto gibt es niemanden, dem die Meldung gehoert. `created_by` ist zwar
 * NOT NULL mit Fremdschluessel auf `users` - aber genau darauf zu bauen hiesse,
 * die Antwort von einem PRAGMA abhaengig zu machen.
 */
function recipientDeniedModules(database, userId) {
  const user = database.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  return deniedModules(buildSessionModuleAccess(resolvePermissions(database, user)));
}

/**
 * Die Zeilen ohne die, deren Modul dem EMPFAENGER entzogen ist (#1289).
 *
 * DIE ZWEITE ACHSE DER ZUSTELLUNG, NEBEN DEM HAUSHALTSSCHALTER DARUEBER.
 * `GET /reminders/pending` fragt sie laengst (`mayTouchOrigin()`), Web Push und
 * die Kanaele taten es nicht: ein Mitglied mit `tasks: none` sah den Toast
 * nicht mehr, bekam den Aufgabentitel aber weiter aufs Telefon, bei Abos samt
 * Betrag und Datum, und der Tipp darauf oeffnete eine Seite, die der
 * Routen-Guard abweist.
 *
 * DIE PRUEFUNG STEHT HIER, an der EINEN Stelle, durch die jede Zeile muss, und
 * nicht bei jeder Quelle, die Zeilen schreibt: Vorrat, Schichtplan, Muell und
 * Zyklus fragen beim Anlegen schon danach, und trotzdem blieb die Luecke offen -
 * ein Recht kann auch NACH dem Anlegen entzogen werden. Eine Regel, die an der
 * Schreibseite wohnt, muesste in sieben Dateien stehen und waere in der achten
 * vergessen.
 *
 * KEINE TOKEN-SCOPES. Die zweite Achse des Routers hat hier kein Gegenstueck:
 * ein Scope gehoert einem API-Token, also einer ANFRAGE, und ein Zustelllauf
 * ist keine. Das Konto entscheidet, nicht ein Credential, das gerade nicht im
 * Spiel ist.
 *
 * UEBERSPRINGEN, NICHT LOESCHEN - gleicher Grund wie beim Haushaltsschalter
 * darueber, und hier noch etwas staerker: ein entzogenes Recht ist eine
 * Verwaltungsentscheidung, die zurueckgenommen werden kann, und die Zeile
 * gehoert dem Mitglied selbst (es hat sie gesetzt oder bekam sie zugewiesen).
 * `pushed_at` bleibt leer, die Meldung geht nach der Rueckgabe des Rechts raus.
 *
 * GEBURTSTAGE BRAUCHEN HIER KEINE AUSNAHME, anders als beim Haushaltsschalter:
 * `birthdays` ist kein Rechte-Modul, sondern eine Nav-ID unter `calendar`
 * (PERMISSION_MODULES in server/permissions.js). Wer den Kalender nicht hat,
 * hat die Geburtstage nicht - eine Sonderbehandlung wuerde eine Unterscheidung
 * erfinden, die die Rechtematrix gar nicht anbietet.
 *
 * Eine Herkunft OHNE Modul geht durch, wie beim Haushaltsschalter: die Karte
 * oben ist vollstaendig, und dass sie es bleibt, haelt der Guard in
 * test/test-disabled-module-reminders.js fest. Eine Sperre auf Verdacht waere
 * hier die falsche Antwort - sie liesse eine kuenftige Herkunft stumm
 * verschwinden, statt sie zuzustellen.
 *
 * Synchron, ohne `await`: der Aufrufer liest die Zeilen unmittelbar davor.
 *
 * @param {object} database
 * @param {Array<{entity_type: string, created_by: number}>} rows
 * @returns {Array} dieselben Zeilenobjekte, gefiltert
 */
export function withoutModulesDeniedToRecipient(database, rows) {
  if (!rows.length) return rows;
  // Einmal je Empfaenger, nicht je Zeile: ein Lauf traegt typischerweise
  // mehrere Meldungen derselben Person, und jede Aufloesung sind zwei Abfragen.
  const byUser = new Map();
  return rows.filter((row) => {
    if (!byUser.has(row.created_by)) byUser.set(row.created_by, recipientDeniedModules(database, row.created_by));
    const denied = byUser.get(row.created_by);
    if (!denied) return false;
    const moduleKey = ORIGIN_MODULE[row.entity_type];
    return !moduleKey || !denied.has(moduleKey);
  });
}
