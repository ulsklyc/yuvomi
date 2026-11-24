/**
 * Modul: Playwright fuer die Bild-Skripte (#2637)
 *
 * Zweck: take-screenshots, build-screenshot-crops und build-screenshot-webp
 *        brauchen Playwrights `chromium`. Playwright ist KEINE Abhaengigkeit des
 *        Projekts (package.json fuehrt es nicht), sondern liegt global auf dem
 *        Rechner der Maintainerin. Bis hierher stand der Homebrew-Pfad fest im
 *        Import jedes Skripts; das machte die Dateien auf jedem anderen Rechner
 *        unlauffaehig und hielt sie aus dem Typecheck. Jetzt loest EINE Stelle
 *        den Pfad zur Laufzeit auf.
 *
 * Aufloesung: `YUVOMI_PLAYWRIGHT_PATH` (Datei, meist `.../playwright/index.mjs`),
 *        sonst der Homebrew-Pfad. Fehlt die Datei, bricht `loadChromium()` mit
 *        einer Meldung ab, die Pfad und Variable nennt.
 *
 * Entwickler-Variable, daher nicht in tools/installer/env-schema.js (das ist
 * Betreiber-Konfiguration).
 */

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DEFAULT_PLAYWRIGHT_PATH = '/opt/homebrew/lib/node_modules/playwright/index.mjs';

/** @param {Record<string, string|undefined>} env */
export function playwrightModulePath(env) {
  return env.YUVOMI_PLAYWRIGHT_PATH || DEFAULT_PLAYWRIGHT_PATH;
}

/**
 * @param {object} [deps]
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {(p: string) => boolean} [deps.exists]
 * @param {(p: string) => Promise<any>} [deps.importer]
 * @returns {Promise<any>} Playwrights `chromium`
 */
export async function loadChromium({
  env = process.env,
  exists = existsSync,
  importer = (p) => import(pathToFileURL(p).href),
} = {}) {
  const path = playwrightModulePath(env);
  if (!exists(path)) {
    throw new Error(
      `Playwright nicht gefunden unter "${path}". Die Bild-Skripte brauchen ein global `
      + 'installiertes Playwright (kein Teil der Abhaengigkeiten); '
      + 'YUVOMI_PLAYWRIGHT_PATH auf dessen index.mjs setzen.',
    );
  }
  const mod = await importer(path);
  const chromium = mod?.chromium ?? mod?.default?.chromium;
  if (!chromium) throw new Error(`"${path}" exportiert kein chromium; YUVOMI_PLAYWRIGHT_PATH pruefen.`);
  return chromium;
}
