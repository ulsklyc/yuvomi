/**
 * Modul: Wo das Frontend liegt (Phase 1a, Abschnitt D)
 * Zweck: Der Server liefert die GEBAUTE App aus dist/ (`npm run build`), nie die
 *        Quellen unter public/: der Router laedt seine Seiten ueber
 *        `import.meta.glob`, das ungebaut nicht laeuft, und der Service Worker
 *        bekommt seine Precache-Liste erst beim Bauen. Fehlt dist/, bricht der
 *        Start mit einer Meldung ab - ein stiller Rueckfall auf public/ lieferte
 *        eine App, die beim ersten Seitenwechsel scheitert.
 *        Einzige Ausnahme: `npm run dev` (scripts/dev.mjs) startet den Server mit
 *        YUVOMI_DEV_FRONTEND=vite. Dann bedient Vite auf 5173 das Frontend und
 *        reicht API, Feeds und /sw.js hierher durch; dieser Server liefert keine
 *        statischen Dateien und keine Shell.
 * Abhaengigkeiten: node:fs, node:path
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const DEV_FRONTEND_ENV = 'YUVOMI_DEV_FRONTEND';

export const MISSING_BUILD_MESSAGE = 'The web app is not built: dist/ is missing or incomplete. '
  + 'Run `npm run build` (production) or `npm run dev` (development) first.';

export const TEST_LAYOUT_MESSAGE = 'dist/ holds the test layout of the browser suites (npm run build:browser-tests), '
  + 'not the app as it ships. Run `npm run build` first.';

/**
 * Die Anordnung eines Builds: 'modules' (Testanordnung) oder 'bundle'.
 * @param {string} dir
 */
export function layoutOf(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, '.vite', 'modules.json'), 'utf8')).layout === 'modules' ? 'modules' : 'bundle';
  } catch {
    return 'bundle';
  }
}

/**
 * @param {string} repoRoot - Wurzel des Checkouts (dort liegen public/ und dist/)
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ mode: 'dist', dir: string, serviceWorker: string } | { mode: 'vite-dev', dir: null, serviceWorker: null }}
 */
export function resolveFrontendDir(repoRoot, env = process.env) {
  if (String(env[DEV_FRONTEND_ENV] ?? '').trim() === 'vite') {
    return { mode: 'vite-dev', dir: null, serviceWorker: null };
  }
  const dir = path.join(repoRoot, 'dist');
  const serviceWorker = path.join(dir, 'sw.js');
  if (!existsSync(path.join(dir, 'index.html')) || !existsSync(serviceWorker)) {
    throw new Error(MISSING_BUILD_MESSAGE);
  }
  // Nach test:document-guards liegt die Testanordnung in dist/ (vite.config.ts,
  // YUVOMI_BUILD_LAYOUT=modules). Ausgeliefert wird sie nur, wenn der Aufrufer
  // sie ausdruecklich will - der Harness der Browser-Suiten.
  if (layoutOf(dir) === 'modules' && String(env.YUVOMI_BUILD_LAYOUT ?? '').trim() !== 'modules') {
    throw new Error(TEST_LAYOUT_MESSAGE);
  }
  return { mode: 'dist', dir, serviceWorker };
}
