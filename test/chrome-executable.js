/**
 * Modul: Test-Infrastruktur - welcher Chrome startet (#2155)
 *
 * Zweck: jede Stelle, die Puppeteer selbst startet (Harness der
 *        Dokument-Guards, die statischen Browser-Sonden, die Bild-Skripte),
 *        holt ihren Browser ueber `launchBrowser()` und damit ueber EINE
 *        Aufloesung.
 *
 * WARUM: Puppeteer pinnt seinen Chrome auf eine Version und sucht genau die in
 * `~/.cache/puppeteer`. Nach einem Puppeteer-Bump (#2103: 25.13.0 -> 25.14.0)
 * liegt dort auf einem Rechner, der die Suite vorher schon gefahren hat, nur
 * die alte Version, und jede Sonde starb nach Sekunden mit "Could not find
 * Chrome (ver. ...)". Der Handlauf vor dem Release darf an einem
 * Abhaengigkeits-Bump nicht sterben, ein installierter System-Chrome reicht
 * fuer ihn. Er ist aber nicht der gepinnte - deshalb laut im Log, nie still.
 *
 * Reihenfolge:
 *   1. `PUPPETEER_EXECUTABLE_PATH`, falls gesetzt. Ausdruecklich gewaehlt,
 *      also kein Rueckfall: fehlt die Datei, ist das ein Fehler (darauf baut
 *      `test:document-guards-harness`, das den Browserstart so scheitern laesst).
 *   2. Der gepinnte Chrome aus Puppeteers Cache.
 *   3. Ein System-Chrome: bekannte Pfade je Plattform, dann `which`.
 *   4. Nichts davon: ein Fehler mit dem Befehl, der den gepinnten nachholt.
 *
 * Die Aufloesung selbst importiert Puppeteer NICHT: Dateisystem, `which` und
 * Versionsabfrage kommen per Injektion, damit `test:chrome-executable` sie in
 * der netzfreien `npm test`-Kette pruefen kann (der Registry-Guard ordnet eine
 * Datei, die `puppeteer` importiert, der Browser-Kette zu). Die Aufrufer
 * reichen ihr eigenes `puppeteer` an `launchBrowser()` durch.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const INSTALL_COMMAND = 'npx puppeteer browsers install chrome';

/** Bekannte Installationsorte eines System-Chrome, in dieser Reihenfolge. */
export function systemChromeCandidates(platform, env = {}, home = '') {
  if (platform === 'darwin') {
    const apps = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Chromium.app/Contents/MacOS/Chromium',
    ];
    return {
      paths: [
        ...apps.map((a) => `/Applications/${a}`),
        ...(home ? apps.map((a) => join(home, 'Applications', a)) : []),
      ],
      commands: [],
    };
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    return {
      paths: roots.map((r) => join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')),
      commands: [],
    };
  }
  return {
    paths: ['/opt/google/chrome/chrome'],
    commands: ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'],
  };
}

/** Die Chrome-Version aus Puppeteers Cache-Pfad (`mac_arm-155.0.8059.79/...`). */
export function versionFromPath(path) {
  return path?.match(/(\d+\.\d+\.\d+\.\d+)/)?.[1] ?? null;
}

/**
 * Loest den Chrome auf, den Puppeteer starten soll.
 *
 * @param {object} deps
 * @param {Record<string, string|undefined>} deps.env
 * @param {string} deps.platform           `process.platform`
 * @param {string} [deps.home]             Heimatverzeichnis (macOS `~/Applications`)
 * @param {string|null} deps.pinnedPath    `await puppeteer.executablePath()`, null wenn es warf
 * @param {(p: string) => boolean} deps.exists
 * @param {(cmd: string) => string|null} deps.which
 * @param {(p: string) => string|null} deps.versionOf  Ausgabe von `<chrome> --version`
 * @returns {{ path: string, source: 'env'|'pinned'|'system', warning: string|null }}
 */
export function resolveChromeExecutable({ env, platform, home = '', pinnedPath, exists, which, versionOf }) {
  const fromEnv = env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv) {
    if (exists(fromEnv)) return { path: fromEnv, source: 'env', warning: null };
    throw new Error(
      `PUPPETEER_EXECUTABLE_PATH zeigt auf "${fromEnv}", dort liegt kein Chrome. `
      + `Variable korrigieren oder entfernen; den gepinnten Chrome holt: ${INSTALL_COMMAND}`,
    );
  }

  if (pinnedPath && exists(pinnedPath)) return { path: pinnedPath, source: 'pinned', warning: null };

  const pinnedVersion = versionFromPath(pinnedPath) ?? 'unbekannt';
  const { paths, commands } = systemChromeCandidates(platform, env, home);
  let found = paths.find((p) => exists(p)) ?? null;
  for (const cmd of commands) {
    if (found) break;
    const hit = which(cmd);
    if (hit && exists(hit)) found = hit;
  }

  if (!found) {
    throw new Error(
      `Puppeteers gepinnter Chrome ${pinnedVersion} fehlt${pinnedPath ? ` (${pinnedPath})` : ''}, `
      + `und kein System-Chrome gefunden. Nachholen mit: ${INSTALL_COMMAND} `
      + '- oder PUPPETEER_EXECUTABLE_PATH auf einen installierten Chrome setzen.',
    );
  }

  const foundVersion = versionOf(found)?.match(/(\d+(?:\.\d+)+)/)?.[1] ?? 'unbekannt';
  const warning = `WARNUNG: Puppeteers gepinnter Chrome ${pinnedVersion} fehlt; `
    + `es laeuft der System-Chrome ${foundVersion} (${found}). `
    + `Puppeteer garantiert nur den gepinnten - nachholen mit: ${INSTALL_COMMAND}`;
  return { path: found, source: 'system', warning };
}

function realWhich(cmd) {
  try {
    return execFileSync('which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

function realVersionOf(path) {
  try {
    return execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/**
 * Startet Puppeteer mit dem aufgeloesten Chrome. `puppeteer` reicht der
 * Aufrufer durch (siehe Kopf), `options` gehen unveraendert an `launch()`.
 */
export async function launchBrowser(puppeteer, options = {}) {
  let pinnedPath = null;
  try {
    pinnedPath = await puppeteer.executablePath();
  } catch {
    pinnedPath = null;
  }
  const { path, warning } = resolveChromeExecutable({
    env: process.env,
    platform: process.platform,
    home: homedir(),
    pinnedPath,
    exists: existsSync,
    which: realWhich,
    versionOf: realVersionOf,
  });
  if (warning) console.warn(`\n${warning}\n`);
  return puppeteer.launch({ ...options, executablePath: path });
}
