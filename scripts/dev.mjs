#!/usr/bin/env node
/**
 * Modul: Entwicklungsbetrieb (`npm run dev`, Phase 1a Abschnitt D)
 * Zweck: Startet zwei Prozesse und haelt sie zusammen:
 *   - den Express-Server mit `--watch` (wie bisher `npm run dev`), mit
 *     YUVOMI_DEV_FRONTEND=vite: er verlangt dann kein dist/ und liefert keine
 *     statischen Dateien (server/utils/frontend-dir.js);
 *   - Vite auf http://localhost:5173 mit den Quellen aus public/, der API,
 *     Feeds und /sw.js an den Server durchreicht (vite.config.ts,
 *     scripts/build/dev-proxy.ts).
 *   Im Browser gilt http://localhost:5173. Ein Service Worker registriert sich
 *   dort nicht (public/sw-register.js). Endet einer der beiden, endet der andere.
 *   .env liest DIESES Skript einmal und gibt beiden dieselbe Umgebung: der
 *   Server laedt dotenv selbst, Vite nicht - PORT nur in .env zielte den Proxy
 *   sonst auf 3000, waehrend der Server woanders lief (Review auf #2631).
 * Abhaengigkeiten: node:child_process, dotenv, vite (devDependency)
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * Umgebung beider Prozesse: .env aus `dir` unter der laufenden Umgebung (eine
 * gesetzte Variable gewinnt, wie bei dotenv), PORT mit dem Standard des Servers.
 * @param {string} dir
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function devEnvironment(dir, env) {
  const file = path.join(dir, '.env');
  const fromFile = existsSync(file) ? dotenv.parse(readFileSync(file)) : {};
  const merged = { ...fromFile, ...env };
  return { ...merged, PORT: merged.PORT || '3000' };
}

function main() {
  const env = devEnvironment(root, process.env);
  const children = [
    spawn(process.execPath, ['--import', 'dotenv/config', '--watch', 'server/index.js'], {
      cwd: root, stdio: 'inherit', env: { ...env, YUVOMI_DEV_FRONTEND: 'vite' },
    }),
    spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))], {
      cwd: root, stdio: 'inherit', env,
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
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
