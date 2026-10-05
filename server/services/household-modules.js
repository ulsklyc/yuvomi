/**
 * Modul: Haushaltsweit abgeschaltete Module
 * Zweck: EINE Lesart von `sync_config.disabled_modules` fuer alle Server-Stellen,
 *        die ohne Request auskommen muessen (periodische Syncs, Zustellung,
 *        Countdowns), und seit #1660 der eine Filter fuer Mischstellen
 *        (modulesLeftOut, birthdaysSwitchedOff). Vorher standen hier vier private Abschriften derselben
 *        Abfrage (countdowns.js, pantry-, schedule- und waste-reminders.js),
 *        und jede neue Erinnerungsquelle haette eine fuenfte gebraucht (#1279).
 * Abhaengigkeiten: keine - nur die uebergebene Verbindung.
 *
 * `disabled_modules` (haushaltweit, Admin) heisst: dieses Modul gibt es hier
 * nicht (siehe server/routes/preferences.js ueber parseHiddenModules). Die
 * zweite Achse, `access_permissions` fuer ein einzelnes Mitglied, ist eine
 * andere Frage und bleibt bei resolvePermissions()/deniedModules().
 */

/**
 * Die Module, die fuer den ganzen Haushalt abgeschaltet sind.
 *
 * Defensiv gegen fehlenden, kaputten oder nicht-Array-Wert: "nichts
 * abgeschaltet" ist die einzige sichere Auslegung eines unlesbaren Werts, denn
 * die andere Richtung wuerde ein Modul stumm ausblenden. Bewusst KEIN Abgleich
 * mit der Allowlist aus preferences.js (TOGGLEABLE_MODULES): die vier
 * Abschriften, die diese Funktion ersetzt, taten das auch nicht, und die
 * Aufrufer fragen ohnehin nur nach einem bekannten Schluessel.
 *
 * @param {object} database  Offene DB-Verbindung
 * @returns {Set<string>}
 */
export function householdDisabledModules(database) {
  const row = database.prepare("SELECT value FROM sync_config WHERE key = 'disabled_modules'").get();
  if (!row?.value) return new Set();
  try {
    const parsed = JSON.parse(row.value);
    return new Set(Array.isArray(parsed) ? parsed.filter((m) => typeof m === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * Was eine MISCHSTELLE auslassen muss - eine Antwort, die mehrere Module in
 * einem Koerper liefert (Uebersicht, Countdowns). Beide Achsen in einem Set:
 * was der Haushalt abgeschaltet hat, und was diesem Betrachter entzogen ist
 * (`hiddenModulesFor()` in server/permissions.js: Rechte und Token-Scopes).
 *
 * DIE REGEL (#1660, docs/DECISIONS.md 11): abschalten heisst "der Haushalt nutzt
 * dieses Modul nicht", es ist keine Sperre. Was der Server von sich aus tut
 * oder ungefragt mitliefert, folgt dem Schalter; die eigenen Routen des Moduls
 * bleiben offen. Diese Funktion ist fuer das "ungefragt mitliefert".
 *
 * EIN SET UND NICHT ZWEI FILTER NACHEINANDER: fuer eine Mischstelle laufen
 * beide Achsen auf dieselbe Frage hinaus - gehoert dieser Teil in diese
 * Antwort? -, und Schnitt, Sortierung und Gesamtzahl muessen dieselbe Menge
 * meinen (die Begruendung steht an `getCountdowns()`, das diese Vereinigung
 * zuerst brauchte).
 *
 * HIER UND NICHT IN EINER MIDDLEWARE: der Pfad einer Mischstelle nennt keines
 * der Module, die sie ausliefert. Eine Regel, die in einem Pfad-Guard wohnt,
 * sieht sie nie.
 *
 * Die Schluessel beider Achsen stehen nebeneinander und heissen fuer fast jedes
 * Modul gleich. Zwei Schalter haben kein eigenes Recht: `birthdays` (Recht
 * `calendar`) und `recipes` (Recht `meals`). Sie kommen nur ueber den Schalter
 * in dieses Set - fuer die Geburtstage siehe birthdaysSwitchedOff().
 *
 * @param {object} database
 * @param {Iterable<string>|null} [hiddenModules]  aus hiddenModulesFor()
 * @returns {Set<string>}
 */
export function modulesLeftOut(database, hiddenModules = null) {
  return new Set([...householdDisabledModules(database), ...(hiddenModules ?? [])]);
}

/**
 * Sind die Geburtstage fuer den Haushalt abgeschaltet?
 *
 * EIGENE FRAGE, WEIL GEBURTSTAGE IN EINEM FREMDEN MODUL STEHEN: jeder
 * Geburtstag und Namenstag hat einen Kalendertermin, und der laeuft in
 * `GET /calendar`, in den Terminen der Uebersicht und im Kalender-Feed mit.
 * Der Schalter `calendar` erreicht diese Zeilen nicht (der Kalender ist ja an),
 * der Schalter `birthdays` muss sie selbst herausnehmen - dieselbe Ausnahme wie
 * bei den Erinnerungen in reminder-origins.js.
 *
 * @param {object} database
 * @returns {boolean}
 * @throws bei jedem Datenbankfehler ausser der fehlenden Tabelle `sync_config`
 */
export function birthdaysSwitchedOff(database) {
  try {
    return householdDisabledModules(database).has('birthdays');
  } catch (err) {
    // EINE DATENBANK OHNE EINSTELLUNGSTABELLE HAT KEINEN SCHALTER. Diese Frage
    // stellt der geteilte Termin-Leser bei JEDEM Aufruf, auch dort, wo es nie
    // um Module ging - derselbe Rueckfall wie `configuredHouseholdTimeZone()`
    // fuer die Zone, die derselbe Leser aus derselben Tabelle liest. Nur genau
    // dieser Fall: jeder andere Fehler ist ein Programmierfehler und soll laut
    // bleiben, sonst blendete ein Tippfehler in der Abfrage die Geburtstage
    // still wieder ein.
    if (/no such table: sync_config/.test(String(err?.message))) return false;
    throw err;
  }
}

/**
 * SQL-Bedingung "dieser Termin ist kein Geburtstag und kein Namenstag", fuer
 * Abfragen auf `calendar_events`.
 *
 * ERKANNT WIRD AM VERWEIS AUS `birthdays`, NICHT AM TITEL - wie in
 * calendar-event-reader.js und reminder-origins.js. Mitgemeint ist die
 * abgeloeste Einzelinstanz einer Serie (`recurrence_parent_id`): sie ist eine
 * eigene Zeile, auf die `birthdays` nicht zeigt, und bliebe sonst als einziger
 * Geburtstag im Kalender stehen.
 *
 * @param {string} alias  Alias von `calendar_events` in der Abfrage; nur aus
 *                        dem Code, nie aus einer Anfrage.
 * @returns {string}
 */
export function notBirthdayEventSql(alias = 'e') {
  return `NOT EXISTS (
    SELECT 1 FROM birthdays hb
    WHERE hb.calendar_event_id IN (${alias}.id, ${alias}.recurrence_parent_id)
       OR hb.name_day_calendar_event_id IN (${alias}.id, ${alias}.recurrence_parent_id)
  )`;
}
