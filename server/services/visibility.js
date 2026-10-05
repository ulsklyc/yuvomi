// --------------------------------------------------------
// Sichtbarkeit pro Aufgabe/Termin (#474): all | assignees | private.
//
//   all       – für alle Familienmitglieder sichtbar (Default, Altverhalten)
//   assignees – nur für Ersteller:in und zugewiesene Personen
//   private   – nur für die Ersteller:in
//
// Die Durchsetzung ist rein serverseitig (kein Admin-Bypass): jeder Lesepfad,
// der Aufgaben/Termine an eine betrachtende Person ausliefert, hängt das
// entsprechende WHERE-Fragment an. Der Kalender-Export (ICS-Feed) bleibt bewusst
// ungefiltert — Sichtbarkeit ist eine In-App-Kontrolle (#474, bestätigt).
// --------------------------------------------------------

export const VISIBILITY_VALUES = ['all', 'assignees', 'private'];

/** Normalisiert einen eingehenden Wert auf eine gültige Stufe. */
export function normalizeVisibility(value, fallback = 'all') {
  return VISIBILITY_VALUES.includes(value) ? value : fallback;
}

/**
 * WHERE-Fragment für die Sichtbarkeits-Durchsetzung.
 *
 * @param {string} alias        Tabellen-Alias der Aufgaben/Termine (z. B. 't' oder 'e')
 * @param {string} assignTable  Zuweisungs-Tabelle ('task_assignments' | 'event_assignments')
 * @param {string} assignCol    FK-Spalte darin ('task_id' | 'event_id')
 * @param {string} bind         Parameter-Platzhalter der betrachtenden User-ID.
 *                              '?' (positional, zwei Binds nötig) oder benannt wie '@me'
 *                              (dann genügt ein einzelner benannter Bind).
 * @returns {string} SQL-Fragment (ohne führendes AND)
 */
export function visibilityWhere(alias, assignTable, assignCol, bind = '?') {
  return `(
    ${alias}.visibility = 'all'
    OR ${alias}.created_by = ${bind}
    OR (${alias}.visibility = 'assignees' AND EXISTS (
          SELECT 1 FROM ${assignTable} vx
          WHERE vx.${assignCol} = ${alias}.id AND vx.user_id = ${bind}))
  )`;
}

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
export function icsSubscriptionVisibleWhere(alias, bind = '?') {
  return `(
    ${alias}.external_source <> 'ics'
    OR ${alias}.subscription_id IN (
      SELECT id FROM ics_subscriptions WHERE shared = 1 OR created_by = ${bind}
    )
  )`;
}
