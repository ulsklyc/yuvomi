/**
 * Modul: Haushaltswaehrung
 * Zweck: Der eine Leser fuer `sync_config.currency` mit dem Rueckfall auf EUR.
 * Abhängigkeiten: better-sqlite3-Handle (synchron), vom Aufrufer uebergeben.
 *
 * WARUM DIESE DATEI EXISTIERT: dieselbe Zeile steht viermal im Baum
 * (server/routes/budget/helpers.js, subscriptions.js, inventory/items.js,
 * dashboard.js). Das Taschengeld (#1734) waere die fuenfte Kopie gewesen. Die
 * vier bestehenden sind hier bewusst NICHT umgestellt - das ist eine eigene
 * Aenderung an vier Modulen -, aber eine neue Stelle soll keine weitere
 * schreiben.
 */

/**
 * @param {object} d
 * @returns {string} ISO-4217-Code der Haushaltswaehrung
 */
export function householdCurrency(d) {
  return d.prepare("SELECT value FROM sync_config WHERE key = 'currency'").get()?.value || 'EUR';
}
