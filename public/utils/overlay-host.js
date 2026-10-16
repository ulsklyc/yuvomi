/**
 * Modul: Wohin eine schwebende Ebene gehaengt wird (D7)
 * Zweck: Seit das geteilte Modal ein natives `<dialog>` in der Top-Layer ist,
 *        macht es alles ausserhalb seiner selbst inert - gemessen (Chrome 155)
 *        auch ein Popover, das als Kind von `document.body` in der Top-Layer
 *        DARUEBER liegt: es nimmt weder Fokus noch Klick. Ein Datepicker-
 *        Kalender, der aus einem Formular im Dialog aufgeht, waere so nur noch
 *        ein Bild.
 *
 * Die Antwort ist der Ort, nicht die Ebene: wer eine schwebende Flaeche
 * anhaengt, haengt sie in den Dialog, aus dem sie aufgeht - oder, ohne
 * Ausloeser, in den obersten offenen modalen Dialog. Ohne Dialog bleibt es
 * `document.body`, also das bisherige Verhalten.
 */

/**
 * @param {Element|null} [from] - das Element, aus dem die Ebene aufgeht
 * @returns {HTMLElement} der Elternknoten fuer die schwebende Ebene
 */
export function overlayHost(from = null) {
  const own = from?.closest?.('dialog[open]');
  if (own) return own;
  if (typeof document.querySelectorAll !== 'function') return document.body;
  // Ohne `:modal` (Browser vor Safari 15.6) gibt es auch keine Sperre durch
  // einen modalen Dialog - dann ist `document.body` richtig.
  const modals = [...document.querySelectorAll('dialog[open]')].filter((d) => {
    if (d.inert || typeof d.matches !== 'function') return false;
    try { return d.matches(':modal'); } catch { return false; }
  });
  return modals[modals.length - 1] ?? document.body;
}
