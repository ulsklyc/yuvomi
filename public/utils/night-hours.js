/**
 * Die Nachtstunden dieses Geraets als Modul (#1901, #2234).
 *
 * Die Rechnung selbst steht in `/night-hours.js`, damit theme-init.js im
 * <head> und die Module hier dieselbe Funktion fragen statt zwei Fassungen
 * (Begruendung dort). Dieses Modul laedt sie und gibt ihr die Sprache der
 * Module: Exporte, die Anzeigezone aus utils/timezone.js und das Schreiben.
 *
 * Zwei Leser: die Wand (utils/wall-mode.js, `isWallNight`) und der
 * Bildschirmschoner (components/photo-screensaver.js), der nachts auch ohne
 * Wand-Modus abdunkelt.
 */

import '../night-hours.js';
import { getDisplayDeviceSettings } from './display-device-settings.js';
import { displayTimeZone } from './timezone.js';

const core = globalThis.yuvomiNightHours;

export const NIGHT_HOURS_KEY = core.KEY;
export const NIGHT_FROM_DEFAULT = core.DEFAULT_FROM;
export const NIGHT_TO_DEFAULT = core.DEFAULT_TO;

/** Die Nachtstunden DIESES Geraets, `{ from, to }` in ganzen Stunden. */
export function getNightHours() {
  const display = getDisplayDeviceSettings();
  if (display) return { from: display.night_from, to: display.night_until };
  let storage = null;
  try { storage = localStorage; } catch { storage = null; }
  return storage ? core.read(storage) : core.parse(null);
}

/**
 * Speichert die Nachtstunden fuer dieses Geraet. Die Vorgabe steht als "kein
 * Schluessel" da, wie bei der Schoner-Wartezeit: ein Geraet, das nie etwas
 * gewaehlt hat, und eines, das zurueckgestellt hat, sehen gleich aus.
 *
 * @param {number} from Stunde 0-23, ab der Nacht ist
 * @param {number} to   Stunde 0-23, ab der wieder Tag ist
 * @returns {{from:number,to:number}} was tatsaechlich gilt
 */
export function setNightHours(from, to) {
  const hours = core.parse(`${Number(from)}-${Number(to)}`);
  try {
    if (hours.from === NIGHT_FROM_DEFAULT && hours.to === NIGHT_TO_DEFAULT) localStorage.removeItem(NIGHT_HOURS_KEY);
    else localStorage.setItem(NIGHT_HOURS_KEY, core.serialize(hours));
  } catch {
    // Nicht schreibbarer Storage: die Vorgabe gilt weiter, die Seite bricht nicht ab.
  }
  return hours;
}

/**
 * Liegt `now` in den Nachtstunden dieses Geraets - auf der Uhr des Haushalts?
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isNightHours(now = new Date()) {
  return core.isNight(now, displayTimeZone(), getNightHours());
}
