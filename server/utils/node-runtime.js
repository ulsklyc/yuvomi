/**
 * Modul: Laufzeitpruefung fuer den Datenbanktreiber
 * Zweck: Sagt in einer Zeile, warum der Server nicht startet, statt dass der
 *        Prozess beim ersten `new Database()` ohne jede Ausgabe stirbt.
 * Abhaengigkeiten: node:fs (nur fuer package.json und die Ausgabe)
 *
 * Gemessen am 2026-10-08: die Prebuilds von better-sqlite3-multiple-ciphers
 * 13.0.3 brauchen Node-API 10. Unter Node 22.12.0, 22.13.0 und 22.13.1
 * (Node-API 9) laedt der Treiber noch, aber `new Database(':memory:')` beendet
 * den Prozess mit Segfault (Exit 139) und ohne eine Zeile. Ab 22.14.0
 * (Node-API 10) laeuft er.
 *
 * Geprueft wird die FAEHIGKEIT (`process.versions.napi`), nicht die
 * Versionsnummer: an ihr haengt der Absturz, und sie stimmt auch dort, wo eine
 * einfache Untergrenze luegt (Node 23.0 bis 23.5 liegen ueber 22.14 und haben
 * trotzdem nur Node-API 9; 23.6.0 ist die erste 23er mit Node-API 10, gemessen
 * am 2026-10-08). Welche Node-Versionen das sind, steht nur in package.json
 * `engines.node`; die Meldung liest die Spanne von dort.
 */

import { readFileSync, writeSync } from 'node:fs';

/** Node-API-Stand, den die Prebuilds des Datenbanktreibers voraussetzen. */
export const REQUIRED_NAPI = 10;

/**
 * Die Node-Spanne aus package.json, wie sie dort steht.
 * @returns {string | null} null, wenn package.json nicht lesbar ist
 */
export function declaredNodeRange() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    return typeof pkg.engines?.node === 'string' ? pkg.engines.node : null;
  } catch {
    return null;
  }
}

/**
 * Reine Pruefung: nennt das Problem der eingereichten Laufzeit oder null.
 *
 * @param {object} runtime
 * @param {string} runtime.node  `process.versions.node`
 * @param {string | number | undefined} runtime.napi  `process.versions.napi`
 * @param {string | null} [runtime.range]  `engines.node` aus package.json
 * @returns {string | null} einzeilige Meldung oder null
 */
export function runtimeProblem({ node, napi, range = null }) {
  const have = Number.parseInt(String(napi ?? ''), 10);
  if (Number.isInteger(have) && have >= REQUIRED_NAPI) return null;
  const found = Number.isInteger(have) ? `Node-API ${have}` : 'no known Node-API version';
  const wanted = range ? `a release that matches "${range}"` : 'a newer release';
  return (
    `Yuvomi cannot start: the database driver needs Node-API ${REQUIRED_NAPI}, ` +
    `but this is Node.js ${node} with ${found}. ` +
    `Update Node.js to ${wanted} and start again.`
  );
}

/**
 * Bricht den Prozess mit der Meldung auf stderr und Exit-Code 1 ab, wenn die
 * laufende Laufzeit den Treiber nicht traegt. `writeSync` statt `console.error`:
 * auf einer Pipe darf die Zeile nicht hinter `process.exit` verloren gehen.
 */
export function assertSupportedRuntime() {
  const runtime = { node: process.versions.node, napi: process.versions.napi };
  if (!runtimeProblem(runtime)) return;
  // package.json erst hier lesen: der gute Start zahlt dafuer nichts.
  const problem = runtimeProblem({ ...runtime, range: declaredNodeRange() });
  try {
    writeSync(2, `${problem}\n`);
  } catch {
    console.error(problem);
  }
  process.exit(1);
}
