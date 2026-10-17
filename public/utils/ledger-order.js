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
 *   - `amount`: erst die Ausgaben, dann die Einnahmen, jede Gruppe mit dem
 *              groessten Betrag zuerst (die Frage ist "wo ging das Geld hin",
 *              nicht "was war am negativsten"). Gleichstand behaelt die
 *              Reihenfolge des Servers. Die Abschnitte "Geplant" und "Gebucht"
 *              bleiben stehen, sortiert wird in jedem (budget.js).
 *
 * R19 sortierte beide Richtungen gemeinsam nach dem Betrag ohne Vorzeichen und
 * loeste dafuer die Abschnitte auf. Die Re-Critique 2026-10-17 (Persona Alex)
 * las das als Fehler: +2.400 EUR Gehalt stand zwischen zwei Ausgaben, und eine
 * geplante Buchung war von einer gebuchten nicht mehr zu unterscheiden. Die
 * Richtung ist ein Merkmal der Zeile, keine Groesse - sie trennt, der Betrag ordnet.
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
  const amount = (entry) => Number(entry?.amount) || 0;
  // 0 = Ausgabe, 1 = Einnahme (eine Null-Buchung steht bei den Einnahmen).
  const group = (entry) => (amount(entry) < 0 ? 0 : 1);
  return list
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => group(a.entry) - group(b.entry)
      || Math.abs(amount(b.entry)) - Math.abs(amount(a.entry))
      || a.index - b.index)
    .map(({ entry }) => entry);
}
