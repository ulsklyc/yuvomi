/**
 * Modul: Jede Datei unter public/ kommt in den Build - gebuendelt, kopiert oder mit Grund nicht
 * Zweck: `publicDir` ist im Build aus (Phase 1a, E9); was die App per Adresse
 *        laedt statt per `import` (klassische Skripte, Seitenblaetter,
 *        Sprachdateien, Icons, Handkopien unter vendor/), kopiert die benannte
 *        Liste in scripts/build/static-files.ts. Eine neue Datei, die weder im
 *        Modulgraphen landet noch auf der Liste steht, fehlte im Image und im
 *        Tarball - online ein 404 (bzw. index.html aus dem SPA-Fallback),
 *        offline ein Loch. Dieser Guard haelt Liste und Verzeichnis zusammen.
 * Ausfuehren: npm run build && node --test test/test-static-copy-list.js
 * Abhaengigkeiten: dist/.vite/modules.json (npm run build)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COPY_LIST, NOT_COPIED, OFFLINE_EXCLUDED, matchesEntry } from '../scripts/build/static-files.ts';
import { copiedFiles, sourceFiles } from '../scripts/build/vite-plugins.ts';
import { withoutHtmlComments } from './source-text.js';
import { DIST, distModules } from './dist-build.js';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
// Was git kennt oder nicht ignoriert - dieselbe Sicht wie das Kopier-Plugin.
const files = sourceFiles(PUBLIC);

test('jede Datei unter public/ ist gebuendelt, kopiert oder als nicht kopiert benannt', () => {
  const bundled = new Set(distModules().filter((m) => m.startsWith('public/')).map((m) => m.slice('public/'.length)));
  assert.ok(bundled.size >= 250, `nur ${bundled.size} gebuendelte Quellmodule - modules.json wird nicht mehr geschrieben`);
  const notCopied = new Set(NOT_COPIED.map((e) => e.path));
  const copied = new Set(copiedFiles(PUBLIC));
  const orphans = files.filter((rel) => !bundled.has(rel) && !copied.has(rel) && !notCopied.has(rel));
  assert.deepEqual(orphans, [],
    'Diese Dateien erreicht weder ein `import` noch die Kopierliste (scripts/build/static-files.ts) - '
    + 'sie fehlten in dist/, im Image und im Tarball. Auf die Liste setzen oder nach NOT_COPIED mit Grund');
});

test('kein Eintrag der Kopierliste ist leer, jede Ausnahme gibt es', () => {
  const stale = COPY_LIST.filter((entry) => !files.some((rel) => matchesEntry(entry, rel))).map((e) => e.path);
  assert.deepEqual(stale, [], 'diese Eintraege treffen keine Datei mehr');
  for (const entry of COPY_LIST) assert.ok(entry.why.length > 10, `${entry.path}: ohne Grund`);
  const missing = [...NOT_COPIED.map((e) => e.path), ...OFFLINE_EXCLUDED].filter((rel) => !existsSync(PUBLIC + rel));
  assert.deepEqual(missing, [], 'diese Ausnahmen nennen Dateien, die es nicht gibt');
});

/**
 * Gebuendelt UND kopiert mit Grund. Beide Enden geprueft: die Kante gibt es
 * noch (sonst ist die Ausnahme ueberfluessig) und die Datei steht noch im Kopf.
 */
const BOTH = [
  {
    file: 'night-hours.js',
    edge: { from: 'utils/night-hours.js', spec: "import '../night-hours.js';" },
    why: 'theme-init.js im <head> fragt die Nachtstunden vor dem ersten Bild (klassisch, also kopiert); '
      + 'utils/night-hours.js importiert dieselbe Datei fuer die Module (gebuendelt). Beide setzen '
      + 'globalThis.yuvomiNightHours auf dasselbe - vor dem Build lief die Datei ebenfalls zweimal, als Skript und als Modul.',
  },
];

test('ein JS-Modul wird gebuendelt, nicht kopiert - ausser mit benanntem Grund', () => {
  // Kopiert und zugleich gebuendelt hiesse sonst: zwei Fassungen desselben
  // Codes unter zwei Adressen, und wer die kopierte laedt, bekommt eine zweite Instanz.
  const bundled = new Set(distModules().filter((m) => m.startsWith('public/')).map((m) => m.slice('public/'.length)));
  const allowed = new Set(BOTH.map((b) => b.file));
  const both = copiedFiles(PUBLIC).filter((rel) => bundled.has(rel));
  assert.deepEqual(both.filter((rel) => !allowed.has(rel)), [], 'diese Dateien liegen gebuendelt UND kopiert in dist/');
  for (const b of BOTH) {
    assert.ok(both.includes(b.file), `${b.file}: nicht mehr beides - Ausnahme streichen`);
    assert.ok(readFileSync(PUBLIC + b.edge.from, 'utf8').includes(b.edge.spec), `${b.edge.from} importiert ${b.file} nicht mehr so`);
  }
});

test('was die Kopierliste nennt, liegt in dist/', () => {
  const absent = copiedFiles(PUBLIC).filter((rel) => !existsSync(DIST + rel));
  assert.deepEqual(absent, [], 'das Kopier-Plugin hat diese Dateien nicht geschrieben');
});

test('jeder Verweis von index.html und offline.html ausser Modulen zeigt auf eine kopierte Datei, auch gebaut', () => {
  // Vite laesst diese Tags stehen (markNonModuleTags, scripts/build/vite-plugins.ts);
  // ihre Adresse muss dann als Datei in dist/ liegen. /manifest.webmanifest ist eine Server-Route.
  const SERVER_ROUTES = new Set(['/manifest.webmanifest']);
  const copied = new Set(copiedFiles(PUBLIC).map((rel) => `/${rel}`));
  /** @param {string} html */
  const refsOf = (html) => [...withoutHtmlComments(html).matchAll(/<(link|script)\b([^>]*)>/gi)]
    .filter((m) => !/type="module"/i.test(m[2]) && !/rel="modulepreload"/i.test(m[2]))
    .map((m) => m[2].match(/\b(?:href|src)="(\/[^"]*)"/i)?.[1])
    .filter((url) => url !== undefined);
  const refs = [];
  for (const page of ['index.html', 'offline.html']) {
    for (const url of refsOf(readFileSync(PUBLIC + page, 'utf8'))) refs.push({ page, url });
  }
  assert.ok(refs.length >= 25, `nur ${refs.length} Verweise gelesen - das Muster greift nicht`);
  const dangling = refs.filter((r) => !SERVER_ROUTES.has(r.url) && !copied.has(r.url)).map((r) => `${r.page}: ${r.url}`);
  assert.deepEqual(dangling, [], 'diese Adressen liegen nicht in dist/');
  // Gebaut: dieselben Adressen in derselben Reihenfolge - Vite hat keines davon
  // gebuendelt oder gehasht (sonst kaeme die Kaskade aus einer anderen Datei).
  const source = refsOf(readFileSync(PUBLIC + 'index.html', 'utf8'));
  const built = refsOf(readFileSync(DIST + 'index.html', 'utf8')).filter((url) => !url.startsWith('/assets/'));
  assert.deepEqual(built, source, 'dist/index.html laedt andere Blaetter, Icons oder Skripte als die Quelle');
  const hashed = refsOf(readFileSync(DIST + 'index.html', 'utf8')).filter((url) => url.startsWith('/assets/'));
  assert.deepEqual(hashed, [], 'Vite hat Tags aus <head> verarbeitet, die die Kopierliste liefert');
});
