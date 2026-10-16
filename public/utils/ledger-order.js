/**
 * Modul: Reihenfolge des Budget-Hauptbuchs (Critique R19, Persona Alex)
 * Zweck: Datum oder Betrag - die Sortierung der Transaktionsliste, rein und
 *        ohne DOM, damit Seite und Test dieselbe Regel lesen.
 * Abhaengigkeiten: keine
 *
 * Muster: utils/loan-order.js (Darlehen, #1706). Die Wahl ordnet nur und
 * schreibt nichts; sie wird je Geraet gemerkt (`yuvomi:budget:ledger-sort`).
 *
 *   - `date`   (Voreinstellung): die Reihenfolge des Servers - neueste zuerst,
 *              im laufenden Monat getrennt in "Geplant" und "Gebucht".
 *   - `amount`: der groesste Betrag zuerst, Einnahme und Ausgabe nach ihrem
 *              Betrag ohne Vorzeichen (die Frage ist "wo ging das Geld hin",
 *              nicht "was war am negativsten"). Gleichstand behaelt die
 *              Reihenfolge des Servers.
 */

export const LEDGER_SORTS = ['date', 'amount'];

export const DEFAULT_LEDGER_SORT = 'date';

/** @returns {'date'|'amount'} Eine gueltige Sortierung, sonst die Voreinstellung. */
export function normalizeLedgerSort(value) {
  return LEDGER_SORTS.includes(value) ? value : DEFAULT_LEDGER_SORT;
}

/**
 * @param {object[]} entries Buchungen in der Reihenfolge des Servers
 * @param {string} sort      'date' | 'amount'
 * @returns {object[]} neue Liste; die Eingabe bleibt unveraendert
 */
export function sortLedger(entries, sort) {
  const list = [...(entries ?? [])];
  if (normalizeLedgerSort(sort) !== 'amount') return list;
  const size = (entry) => Math.abs(Number(entry?.amount) || 0);
  return list
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => size(b.entry) - size(a.entry) || a.index - b.index)
    .map(({ entry }) => entry);
}
