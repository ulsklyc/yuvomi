/**
 * Modul: Notiz-Zugriff (#1514, #1602)
 * Zweck: Die zwei Fragen, die eine einzelne Notiz an ihre Betrachter stellt -
 *        wer sie sieht und wer sie aendert -, an EINER Stelle fuer Server und
 *        Oberflaeche. Rein, ohne DOM und ohne Datenbank: der Server importiert
 *        dieselbe Datei (wie `markdown-checklist.js`).
 *
 * WAS DIE AUTORIN ENTSCHEIDET. Beide Felder sind ihre Entscheidung ueber ihre
 * Notiz (#1602): die Sichtbarkeit allein ihre (`private` heisst „nur wer sie
 * angelegt hat", ohne Admin-Zweig, DECISIONS 1), die Sperre ihre und die der
 * Admins - dieselben, die eine gesperrte Notiz noch aendern duerfen.
 */

/** Dieselben Woerter wie Aufgaben und Termine (DECISIONS 5), ohne "Nur Zugewiesene": Notizen haben keine. */
export const NOTE_VISIBILITY_VALUES = Object.freeze(['all', 'private']);

/**
 * Ein eingehender Wert als Stufe, oder `null`, wenn er keine ist. `family` und
 * `shared` sind die offene Stufe anderer Module und heissen hier `all`
 * (DECISIONS 5: das Vokabular wird beim Lesen angeglichen, nicht abgewiesen).
 */
export function noteVisibilityValue(value) {
  if (value === 'family' || value === 'shared') return 'all';
  return NOTE_VISIBILITY_VALUES.includes(value) ? value : null;
}

function isOwn(note, viewer) {
  return note?.created_by != null && Number(note.created_by) === Number(viewer?.userId);
}

/**
 * Ist diese Notiz fuer diese Person gesperrt (#1602)?
 *
 * DIE SPERRE GILT GANZ: anders als bei Aufgaben bleibt hier auch das Abhaken
 * einer Checklisten-Zeile zu, ebenso Anpinnen und das Einsortieren in
 * Kategorien. Eine Notiz ist ihr Text; ein Haken darin IST der Text.
 *
 * @param {{locked?: number|boolean, created_by?: number|null}|null} note
 * @param {{userId?: number|string|null, isAdmin?: boolean}} viewer
 */
export function noteLockedFor(note, viewer = {}) {
  if (!note?.locked) return false;
  if (viewer.isAdmin) return false;
  return !isOwn(note, viewer);
}

/** Darf diese Person die Sperre setzen oder loesen? Ersteller:in und Admins. */
export function mayChangeNoteLock(note, viewer = {}) {
  return Boolean(viewer.isAdmin) || isOwn(note, viewer);
}

/**
 * Darf diese Person die Sichtbarkeit aendern? Nur wer die Notiz angelegt hat -
 * auch kein Admin: `private` an einer fremden Notiz naehme sie dem Haushalt
 * und dem, der es setzt, und liesse sie einer Person, die es nicht wollte.
 */
export function mayChangeNoteVisibility(note, viewer = {}) {
  return isOwn(note, viewer);
}
