/**
 * Modul: Untere Navigation immer ausgefahren
 * Zweck: Geraetelokaler Schalter gegen das Minimieren der Tab-Kapsel beim
 *        Abwaertsscrollen. Der Standard bleibt das bisherige Verhalten.
 * Abhaengigkeiten: keine
 *
 * Der Schalter gehoert dem GERAET, nicht dem Konto: ein Telefon mit Daumen-
 * Bedienung will die flache Pille, ein Wandtablet oder ein grosses iPad die
 * volle Leiste. Er liegt deshalb neben `yuvomi-wall-mode` in `localStorage`
 * und nicht in den persoenlichen Preferences auf dem Server.
 *
 * `data-nav-fixed` an `<html>` ist der eine Zustand, den CSS und
 * `watchNavMinimize()` lesen; gesetzt wird er hier und beim Aufbau der Shell.
 */

export const NAV_FIXED_KEY = 'yuvomi-nav-fixed';

/** @returns {boolean} true, wenn die Leiste auf diesem Geraet ausgefahren bleibt */
export function isNavFixed() {
  try {
    return localStorage.getItem(NAV_FIXED_KEY) === '1';
  } catch {
    // Privater Modus / gesperrter Storage: der bisherige Zustand gilt.
    return false;
  }
}

/**
 * Speichert die Wahl und wendet sie sofort an.
 * Der Standard ("aus") liegt als fehlender Schluessel vor, damit ein Geraet,
 * das den Schalter nie beruehrt hat, und eines, das ihn zurueckgestellt hat,
 * gleich aussehen.
 *
 * @param {boolean} on
 * @returns {boolean} der gespeicherte Zustand
 */
export function setNavFixed(on) {
  const fixed = Boolean(on);
  try {
    if (fixed) localStorage.setItem(NAV_FIXED_KEY, '1');
    else localStorage.removeItem(NAV_FIXED_KEY);
  } catch {
    // Ein nicht schreibbarer Storage darf die Einstellungsseite nicht brechen;
    // die Wahl gilt bis zum naechsten Laden.
  }
  document.documentElement.toggleAttribute('data-nav-fixed', fixed);
  return fixed;
}

/**
 * Folgt einer Aenderung aus einem anderen Tab desselben Browsers.
 *
 * @param {StorageEvent} event
 */
export function syncNavFixedFromStorage(event) {
  if (event?.key !== NAV_FIXED_KEY && event?.key !== null) return;
  document.documentElement.toggleAttribute('data-nav-fixed', isNavFixed());
}
