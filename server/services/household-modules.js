/**
 * Modul: Haushaltsweit abgeschaltete Module
 * Zweck: EINE Lesart von `sync_config.disabled_modules` fuer alle Server-Stellen,
 *        die ohne Request auskommen muessen (periodische Syncs, Zustellung,
 *        Countdowns). Vorher standen hier vier private Abschriften derselben
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
