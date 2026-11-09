#!/usr/bin/env node
/**
 * Modul: Entwicklungsbetrieb (`npm run dev`, Phase 1a Abschnitt D)
 * Zweck: Startet zwei Prozesse und haelt sie zusammen:
 *   - den Express-Server mit `--watch` (wie bisher `npm run dev`), mit
 *     YUVOMI_DEV_FRONTEND=vite: er verlangt dann kein dist/ und liefert keine
 *     statischen Dateien (server/utils/frontend-dir.js);
 *   - Vite auf http://localhost:5173 mit den Quellen aus public/, der API,
 *     Feeds und /sw.js an den Server durchreicht (vite.config.ts, `server.proxy`).
 *   Im Browser gilt http://localhost:5173. Ein Service Worker registriert sich
 *   dort nicht (public/sw-register.js). Endet einer der beiden, endet der andere.
 * Abhaengigkeiten: node:child_process, vite (devDependency)
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const children = [
  spawn(process.execPath, ['--import', 'dotenv/config', '--watch', 'server/index.js'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, YUVOMI_DEV_FRONTEND: 'vite' },
  }),
  spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))], {
    cwd: root, stdio: 'inherit', env: process.env,
  }),
];

let stopping = false;
/** @param {number} code */
function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const child of children) child.on('exit', (code) => stopAll(code ?? 1));
for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) process.on(signal, () => stopAll(0));
