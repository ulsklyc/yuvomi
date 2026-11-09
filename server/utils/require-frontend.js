/**
 * Modul: Startpruefung "die App ist gebaut" (Phase 1a, Abschnitt D)
 * Zweck: Laeuft als Import ganz oben in server/index.js - vor der Datenbank
 *        und vor der Instanz-Sperre: ohne dist/ startet nichts, und die Meldung
 *        sagt, was zu tun ist (utils/frontend-dir.js).
 * Abhaengigkeiten: ./frontend-dir.js
 */
import { fileURLToPath } from 'node:url';
import { resolveFrontendDir } from './frontend-dir.js';

let frontend;
try {
  frontend = resolveFrontendDir(fileURLToPath(new URL('../..', import.meta.url)));
} catch (err) {
  console.error(`[Server] ${/** @type {Error} */ (err).message}`);
  process.exit(1);
}

export const FRONTEND = /** @type {ReturnType<typeof resolveFrontendDir>} */ (frontend);
