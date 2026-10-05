/* WIE VIELE TERMINE DIE KALENDER-KACHEL LISTET (#1680).
 *
 * Drei feste Stufen statt einer freien Zahl: die Kachel folgt ihrer Hoehe
 * nicht, und jede Zahl dazwischen waere eine weitere Fassung, die jemand
 * messen muesste. Fuenf ist der Auslieferungszustand und wird deshalb weder
 * gespeichert noch mitgeschickt - dieselbe Regel wie `scope: 'all'`.
 *
 * EINE LISTE FUER BEIDE SEITEN. Die Route (`server/routes/dashboard.js`)
 * importiert diese Datei und klemmt mit derselben Funktion, mit der die Kachel
 * schneidet; zwei Listen waeren zwei Gelegenheiten, dass der Server acht
 * liefert und der Browser fuenf zeigt. Deshalb ist die Datei rein: kein
 * Import, kein DOM, kein Node (freigegeben in test/test-layer-boundary.js).
 *
 * Allowlist, kein Bereich: `7` ist nicht „fast acht", und `500` ist nicht
 * „zwoelf". Alles ausserhalb der Stufen ist die Vorgabe - auch der fehlende,
 * der leere und der doppelte Parameter (Express macht daraus ein Array). */
export const EVENT_LIMIT_STEPS = Object.freeze([5, 8, 12]);
export const EVENT_LIMIT_DEFAULT = EVENT_LIMIT_STEPS[0];

/**
 * @param {unknown} value Zahl aus den Widget-Optionen oder Text aus der Query
 * @returns {number} eine der Stufen, sonst die Vorgabe
 */
export function clampEventLimit(value) {
  return EVENT_LIMIT_STEPS.find((step) => value === step || value === String(step)) ?? EVENT_LIMIT_DEFAULT;
}
