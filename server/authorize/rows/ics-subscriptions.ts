/**
 * Module: the second rule an event carries, its ICS subscription (phase 2, section B3;
 *         until then server/services/visibility.js)
 * Purpose: an event imported from an ICS subscription is there only when the
 *          subscription is shared or belongs to the viewer; the shared-surface variant
 *          without the viewer branch sits next to it.
 *
 * Dependencies: none. Erasable TS syntax only (runs through type stripping, no build).
 */

/**
 * WHERE-Fragment fuer die ZWEITE Regel, die ein Termin traegt: ein Termin aus
 * einem ICS-Abo ist nur da, wenn das Abo geteilt ist oder der betrachtenden
 * Person gehoert. Die Zeilen-Sichtbarkeit oben deckt das nicht - ein
 * importierter Termin steht auf `all`.
 *
 * EINE STELLE, weil die Klausel an acht Stellen wortgleich stand und an den
 * Wegen fehlte, die eine Kennung aus dem Pfad nehmen (GET/PUT/DELETE
 * /calendar/:id): die Liste verbarg den Termin, die Kennung lieferte ihn. Wer
 * Termine an eine Person ausliefert oder auf ihre Kennung hin aendert, haengt
 * BEIDE Fragmente an - dieses und `visibilityWhere()`.
 *
 * @param {string} alias  Tabellen-Alias der Termine (z. B. 'e')
 * @param {string} bind   Platzhalter der betrachtenden User-ID: '?' (ein
 *                        positionaler Bind), benannt wie '@userId', oder ein
 *                        SQL-Ausdruck
 * @returns {string} SQL-Fragment (ohne fuehrendes AND)
 */
// "The row visibility above" is visibilityWhere() in rows/assignees.ts.
export function icsSubscriptionVisibleWhere(alias: string, bind: string = '?'): string {
  return `(
    ${alias}.external_source <> 'ics'
    OR ${alias}.subscription_id IN (
      SELECT id FROM ics_subscriptions WHERE shared = 1 OR created_by = ${bind}
    )
  )`;
}

/** Wie `icsSubscriptionVisibleWhere`, ohne den Zweig „oder das Abo gehoert mir". */
export function icsSubscriptionSharedWhere(alias: string): string {
  return `(
    ${alias}.external_source <> 'ics'
    OR ${alias}.subscription_id IN (
      SELECT id FROM ics_subscriptions WHERE shared = 1
    )
  )`;
}
