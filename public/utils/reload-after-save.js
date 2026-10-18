/**
 * Modul: Nachladen nach dem Speichern (#2069)
 * Zweck: reloadAfterSave - das EINE Muster fuer "gespeichert, jetzt die Liste
 *        frisch holen".
 * Abhaengigkeiten: i18n.js
 *
 * DAS PROBLEM: Steht das Nachladen im selben `try` wie das Speichern, landet
 * ein gescheitertes Nachladen (Netz weg, 429, langsamer Server) im catch des
 * Speicherns. Der Dialog bleibt offen, der Toast sagt "nicht gespeichert" -
 * und ein zweites Speichern legt den Eintrag doppelt an.
 *
 * DIE REGEL: Ist das Schreiben angekommen, gilt der Eintrag als gespeichert.
 * reloadAfterSave() faengt den Fehler des Nachladens selbst, meldet ihn als
 * Aktualisierungsproblem (Warnung, nicht Fehler) und wirft nie weiter; der
 * Aufrufer schliesst den Dialog und zeichnet mit dem Stand, den er hat. Das
 * Schreiben wird nie wiederholt. test:frontend-audit findet ein Nachladen, das
 * ohne diesen Helfer hinter einem Schreiben im selben try steht
 * (test/reload-after-write.js).
 */
import { t } from '/i18n.js';

/** So lange steht die Warnung: ein Satz mit Handlungsanweisung, kein Haken. */
export const RELOAD_FAILED_TOAST_MS = 6000;

/**
 * @template T
 * @param {() => Promise<T> | T} reload  das Nachladen (samt Neuzeichnen, wenn es dazugehoert)
 * @returns {Promise<T | false>} der Wert des Nachladens, oder false, wenn es scheiterte
 */
export async function reloadAfterSave(reload) {
  try {
    return await reload();
  } catch (err) {
    console.warn('[reloadAfterSave] saved, but the reload failed:', err);
    window.yuvomi?.showToast(t('common.savedReloadFailed'), 'warning', RELOAD_FAILED_TOAST_MS);
    return false;
  }
}
