/**
 * Modul: Reihenfolge der Darlehen (#1706)
 * Zweck: Die Darlehensliste nach Zinssatz oder Restschuld ordnen. Eine
 *        Rechnung, die der Haushalt liest - sie entscheidet nichts und raet zu
 *        nichts (Vorfaelligkeitsentgelte und Sondertilgungsrechte kennt Yuvomi
 *        nicht, #935).
 * Abhängigkeiten: keine (rein, ohne DOM - testbar in test:budget-loans-order)
 *
 * Die Zahlen kommen vom Server und werden hier nur verglichen:
 *   - Zinssatz  = `interest.current_rate`, der Satz der naechsten Rate
 *                 (Zinsbindung: fest, danach Anschlusssatz). Ein Darlehen ohne
 *                 Zins zaehlt als 0 % und steht damit am Ende.
 *   - Restschuld = `remaining_principal` (folgt den gebuchten Zahlungen, #954),
 *                 ueber `exchange_rate` in die Budget-Waehrung gerechnet, damit
 *                 1.000 USD und 1.000 EUR nicht als gleich gross gelten. Das
 *                 ist dieselbe Bewertung wie in der Summenkarte.
 *
 * Getilgte Darlehen stehen in JEDER Sortierung hinter den laufenden, unter sich
 * in der Reihenfolge des Servers: ihre Restschuld ist 0, und ohne diese Regel
 * fuehrten sie die Liste "kleinste Restschuld zuerst" an.
 */

/** Die waehlbaren Sortierungen; 'start' ist die Reihenfolge des Servers. */
export const LOAN_SORTS = ['start', 'rate', 'balance'];

export const DEFAULT_LOAN_SORT = 'start';

/** @returns {string} Eine gueltige Sortierung, sonst die Voreinstellung. */
export function normalizeLoanSort(value) {
  return LOAN_SORTS.includes(value) ? value : DEFAULT_LOAN_SORT;
}

/** Der Satz, nach dem sortiert wird; ohne Zins 0. */
export function loanSortRate(loan) {
  const rate = Number(loan?.interest?.current_rate);
  return Number.isFinite(rate) ? rate : 0;
}

/** Die Restschuld in der Budget-Waehrung. */
export function loanSortBalance(loan) {
  const balance = Number(loan?.remaining_principal ?? loan?.remaining_amount) || 0;
  const rate = Number(loan?.exchange_rate);
  return balance * (Number.isFinite(rate) && rate > 0 ? rate : 1);
}

function isOpen(loan) {
  return loan?.status !== 'paid' && !loan?.is_settled;
}

/**
 * @param {object[]} loans Darlehen in der Reihenfolge des Servers
 * @param {string} sort    'start' | 'rate' | 'balance'
 * @returns {object[]} neue Liste; die Eingabe bleibt unveraendert
 */
export function sortLoans(loans, sort) {
  const list = Array.isArray(loans) ? loans : [];
  const mode = normalizeLoanSort(sort);
  if (mode === 'start') return [...list];
  const compare = mode === 'rate'
    ? (a, b) => loanSortRate(b) - loanSortRate(a)      // hoechster Satz zuerst
    : (a, b) => loanSortBalance(a) - loanSortBalance(b); // kleinste Restschuld zuerst
  // Der Index haelt Gleichstaende in der Reihenfolge des Servers.
  return list
    .map((loan, index) => ({ loan, index }))
    .sort((a, b) => {
      const openA = isOpen(a.loan);
      const openB = isOpen(b.loan);
      if (openA !== openB) return openA ? -1 : 1;
      if (!openA) return a.index - b.index;
      return compare(a.loan, b.loan) || a.index - b.index;
    })
    .map(({ loan }) => loan);
}
