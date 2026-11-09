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

/** Die Precache-Liste aus dist/sw.js (erste Zeile, vom Build geschrieben). */
export function distPrecache(root = DIST) {
  const line = readDist('sw.js', root).match(/^self\.__PRECACHE__ = (\[.*\]);$/m)?.[1];
  if (!line) throw new Error('dist/sw.js ohne self.__PRECACHE__ - Build veraltet, neu bauen');
  return /** @type {string[]} */ (JSON.parse(line));
}

/**
 * Liegt die Quelldatei `/pfad` (wie unter public/) offline bereit? Kopierte
 * Dateien stehen unter ihrem Pfad im Precache, gebuendelte Module in dem
 * gehashten Chunk, der ihren Code traegt. Ein Modul, dessen Code der Build ganz
 * wegfaltet (eine Konstante), liegt in keinem Chunk: dann `false` - wer danach
 * fragt, meint ein Modul mit Code.
 * @param {string} sourcePath
 */
export function isPrecachedSource(sourcePath, root = DIST) {
  const precache = new Set(distPrecache(root));
  if (precache.has(sourcePath)) return true;
  const id = `public${sourcePath}`;
  const { chunks } = JSON.parse(readDist('.vite/modules.json', root));
  return Object.entries(/** @type {Record<string, string[]>} */ (chunks))
    .some(([file, ids]) => ids.includes(id) && precache.has(`/${file}`));
}
