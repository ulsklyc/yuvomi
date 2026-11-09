/**
 * Modul: Lesehilfe fuer den gebauten Stand dist/ (Phase 1a, Abschnitt D)
 * Zweck: Suiten, die das Artefakt pruefen statt der Quelle, lesen dist/ ueber
 *        diese Datei. Fehlt der Build, scheitern sie mit EINER Meldung statt
 *        mit ENOENT irgendwo - und nie still gruen. Gebaut wird hier nicht
 *        (eine Sekunde je Suite mal Dutzende Suiten): `npm test` und CI bauen
 *        vorher einmal (`npm run build`).
 * Abhaengigkeiten: node:fs
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

/** Wirft mit klarer Meldung, wenn kein Build da ist. */
export function requireDist(root = DIST) {
  if (!existsSync(`${root}.vite/manifest.json`)) {
    throw new Error(`${root} hat keinen Build (.vite/manifest.json fehlt) - zuerst \`npm run build\``);
  }
  return root;
}

/**
 * Datei aus dist/ als Text.
 * @param {string} rel
 */
export function readDist(rel, root = DIST) {
  return readFileSync(`${requireDist(root)}${rel.replace(/^\//, '')}`, 'utf8');
}

/** dist/.vite/manifest.json */
export function distManifest(root = DIST) {
  return JSON.parse(readDist('.vite/manifest.json', root));
}

/** dist/.vite/modules.json: `graph` (jedes per import erreichte Quellmodul) oder `rendered` (Code liegt in einem Chunk). */
export function distModules(kind = 'graph', root = DIST) {
  const list = JSON.parse(readDist('.vite/modules.json', root))[kind];
  if (!Array.isArray(list)) throw new Error(`modules.json ohne ${kind} - Build veraltet, neu bauen`);
  return list;
}
