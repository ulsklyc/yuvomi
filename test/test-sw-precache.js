/**
 * Precache-Vollständigkeits-Guard fuer den gebauten Service Worker (#616, Phase 1a Abschnitt D).
 *
 * Hintergrund: der Browser führt pro Dokument genau eine Modul-Map. Ist ein
 * geteiltes Modul einmal geladen, wird jeder spätere Import dagegen gebunden -
 * auch der eines Seitenmoduls, das der neue Service Worker gerade frisch vom
 * Netz geholt hat. Precacht der SW also ein Seitenmodul, nicht aber dessen
 * Abhängigkeiten, kann nach einem Update im laufenden Tab ein neues Seitenmodul
 * auf eine alte Abhängigkeit treffen (v1.63.0: recipes.js neu, empty-state.js
 * alt). Offline fehlt ein nicht precachtes Ziel eines Imports ganz.
 *
 * SEIT DEM BUILD PRUEFT DIESER GUARD DAS ARTEFAKT. Bis Phase 1a standen in
 * public/sw.js drei Listen von Hand (368 Zeilen), und dieser Guard rechnete den
 * Importgraphen der Quelle gegen sie nach. Jetzt schreibt der Build die Liste
 * (`self.__PRECACHE__` in dist/sw.js, scripts/build/service-worker.ts); geprueft
 * wird, was ausgeliefert wird: dist/sw.js gegen dist/.vite/manifest.json und die
 * Kopierliste (scripts/build/static-files.ts). Die Regel bleibt dieselbe: jede
 * Datei, die der Graph erreicht, ist precacht - statische und dynamische
 * Importe, denn die Seiten sind dynamische Importe des Routers.
 *
 * Abgedeckt:
 *   - jeder precachte Pfad liegt in dist/ (c.addAll() ist All-or-Nothing)
 *   - der Graph ab den Eintraegen ist lueckenlos precacht, ausser den Seiten
 *     in OFFLINE_EXCLUDED; jeder Laufzeit-Import einer Handkopie unter
 *     /vendor/ ist precacht oder eine Ausnahme mit Grund
 *   - jedes eager geladene Stylesheet und jedes Skript aus index.html ist
 *     precacht (beide haengen an keinem `import`)
 *   - die Kopierliste wirkt: jede Datei mit `precache: true` ist drin, keine mit `false`
 *   - Shell und Sprachen trennen sich wie das fetch-Routing, keine Doppel
 *   - jede Sprachdatei ist dem Worker bekannt, vorab nur die Rueckfallsprache
 *   - jedes Settings-Blatt der Registry ist precacht
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { parseSync } from 'rolldown/utils';
import { withoutHtmlComments } from './source-text.js';
import { DIST, distManifest, readDist } from './dist-build.js';
import { OFFLINE_EXCLUDED, copyEntryFor } from '../scripts/build/static-files.ts';
import { copiedFiles } from '../scripts/build/vite-plugins.ts';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

/**
 * Führt dist/sw.js in einer Sandbox aus und liest die Listen als echte Arrays
 * aus - so, wie der Worker sie zur Laufzeit sieht, samt der vom Build
 * vorangestellten Zeilen. Kein Regex-Parsing.
 * @param {string} src
 */
function loadSwLists(src) {
  const noop = () => {};
  const cacheStub = { match: async () => undefined, put: async () => {}, delete: async () => {}, addAll: async () => {}, keys: async () => [] };
  /** @type {Record<string, any>} */
  const sandbox = {
    self: { addEventListener: noop, skipWaiting: noop, clients: { claim: noop, matchAll: async () => [] }, location: { origin: 'https://app.test' } },
    caches: { open: async () => cacheStub, keys: async () => [], match: async () => undefined, delete: async () => {} },
    fetch: async () => ({ ok: false }),
    Request: class { /** @param {string} url */ constructor(url) { this.url = url; } },
    Response: class { /** @param {any} body @param {any} init */ constructor(body, init) { this.body = body; Object.assign(this, init); } },
    Headers: class { get() { return null; } set() {} },
    console, Date, Promise, parseInt,
  };
  sandbox.self.self = sandbox.self;
  const lists = runInContext(
    `${src}\n;({ APP_SHELL, APP_LOCALES, PRECACHED_LOCALES, API_CACHE_WHITELIST, ALL_CACHES })`,
    createContext(sandbox),
  );
  return {
    APP_SHELL: Array.from(/** @type {string[]} */ (lists.APP_SHELL)),
    APP_LOCALES: Array.from(/** @type {string[]} */ (lists.APP_LOCALES)),
    PRECACHED_LOCALES: Array.from(/** @type {string[]} */ (lists.PRECACHED_LOCALES)),
    API_CACHE_WHITELIST: Array.from(/** @type {string[]} */ (lists.API_CACHE_WHITELIST)),
    ALL_CACHES: Array.from(/** @type {string[]} */ (lists.ALL_CACHES)),
  };
}

const SW = readDist('sw.js');
const { APP_SHELL, APP_LOCALES, PRECACHED_LOCALES, API_CACHE_WHITELIST, ALL_CACHES } = loadSwLists(SW);
const precached = new Set([...APP_SHELL, ...PRECACHED_LOCALES]);
const manifest = distManifest();
const excludedSources = new Set(OFFLINE_EXCLUDED);

/**
 * Literale Importe eines gebauten Chunks (statisch und dynamisch) aus dem
 * Syntaxbaum - der minifizierte Code steht auf einer Zeile.
 * @param {string} file
 */
function chunkSpecifiers(file) {
  const { program } = parseSync(file, readFileSync(DIST + file, 'utf8'), { sourceType: 'module' });
  /** @type {string[]} */
  const out = [];
  /** @param {any} node */
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if ((node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source) out.push(node.source.value);
    if (node.type === 'ImportExpression') {
      // Der Minifier schreibt Zeichenketten gern als Template ohne Ausdruck.
      const src = node.source;
      if (src?.type === 'Literal' && typeof src.value === 'string') out.push(src.value);
      else if (src?.type === 'TemplateLiteral' && src.expressions.length === 0) out.push(src.quasis[0].value.cooked);
    }
    for (const key of Object.keys(node)) if (key !== 'type') walk(node[key]);
  };
  walk(program.body);
  return out;
}

/**
 * Bewusst nicht precacht, obwohl ein precachter Chunk es zur Laufzeit importiert.
 * An beiden Enden geprueft: die Kante besteht (sonst ueberfluessig) und der
 * Anlass auch (sonst gehoert die Datei in die Liste).
 */
const IMPORT_EXCEPTIONS = [
  {
    dep: '/vendor/pdfjs/pdf.min.mjs',
    from: 'pages/documents.js',
    reason: 'Die PDF-Vorschau braucht die Datei des Dokuments, und die kommt offline nicht: '
      + '/documents steht nicht auf der Offline-Liste der API (API_CACHE_WHITELIST in sw.js). '
      + 'Precacht haette pdf.js nichts zu zeigen, und allein reichte es ohnehin nicht - Worker '
      + '(1.4 MB) und standard_fonts/ gehoerten dazu. Dieselbe Lage fuer die Vorschaubilder '
      + '(utils/document-thumbs.js, im selben Chunk gebuendelt): sie rendern die erste Seite aus '
      + 'derselben /preview-Datei, die in keinem Cache des Geraets liegen soll.',
    stillValid: () => !API_CACHE_WHITELIST.some((p) => p === '/documents' || p.startsWith('/documents/')),
  },
];

test('dist/sw.js traegt die Liste des Builds, keine von Hand', () => {
  assert.match(SW, /^self\.__PRECACHE__ = \[/, 'der Build hat keine Precache-Liste vorangestellt');
  assert.ok(APP_SHELL.length >= 150, `nur ${APP_SHELL.length} Shell-Eintraege - die Liste kommt nicht aus dem Manifest`);
  const source = readFileSync(PUBLIC_DIR + 'sw.js', 'utf8');
  const handLines = source.split('\n').filter((line) => /^\s*'\/[^']*',?\s*(?:\/\/.*)?$/.test(line));
  assert.deepEqual(handLines, [], 'public/sw.js fuehrt wieder Pfadzeilen von Hand');
  assert.ok(!ALL_CACHES.some((name) => name.startsWith('yuvomi-pages-')), 'der Seiten-Cache ist zurueck - die gebauten Seiten liegen in der Shell');
});

test('jeder precachte Pfad liegt in dist/ (addAll ist All-or-Nothing)', () => {
  const missing = [...precached].filter((p) => p !== '/' && !existsSync(DIST + p.replace(/^\//, '')));
  assert.deepEqual(missing, [], `Precache verweist auf Dateien, die der Build nicht schreibt: ${missing.join(', ')}`);
});

test('der Graph ab den Eintraegen ist vollstaendig precacht (#616)', () => {
  const roots = Object.keys(manifest).filter((key) => manifest[key].isEntry);
  assert.deepEqual(roots.sort(), ['api.js', 'i18n.js', 'index.html', 'utils/html.js'], 'andere Eintraege als index.html und die drei Fassaden');
  const gaps = [];
  const usedExceptions = new Set();
  const skipped = new Set();
  const seen = new Set(roots);
  const queue = [...roots];
  while (queue.length) {
    const key = /** @type {string} */ (queue.shift());
    const chunk = manifest[key];
    if (chunk.src && excludedSources.has(chunk.src)) { skipped.add(chunk.src); continue; }
    for (const file of [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])]) {
      if (!precached.has(`/${file}`)) gaps.push(`/${file}  (${chunk.src ?? key})`);
    }
    for (const dep of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) {
      if (!seen.has(dep)) { seen.add(dep); queue.push(dep); }
    }
    // Laufzeit-Importe der Handkopien (external im Build): stehen nur im Code.
    for (const spec of chunkSpecifiers(chunk.file).filter((s) => s.startsWith('/vendor/'))) {
      if (precached.has(spec)) continue;
      const ex = IMPORT_EXCEPTIONS.find((e) => e.dep === spec && e.from === chunk.src);
      if (ex) usedExceptions.add(ex);
      else gaps.push(`${spec}  <- importiert von ${chunk.src ?? key}`);
    }
  }
  assert.ok(seen.size >= 100, `nur ${seen.size} Chunks erreicht - der Graph wird nicht mehr gelesen`);
  assert.deepEqual(gaps, [], `Diese Dateien erreicht der Graph, der Worker precacht sie aber nicht:\n  ${gaps.join('\n  ')}`);
  const stale = IMPORT_EXCEPTIONS.filter((ex) => !usedExceptions.has(ex));
  assert.deepEqual(stale.map((ex) => `${ex.dep} <- ${ex.from}`), [], 'Diese Ausnahme trifft keine fehlende Kante mehr - streichen');
  const expired = IMPORT_EXCEPTIONS.filter((ex) => !ex.stillValid());
  assert.deepEqual(expired.map((ex) => ex.dep), [], 'Der Anlass dieser Ausnahme ist weg - die Datei gehoert in den Precache');
  // Jede ausgenommene Seite wird ueberhaupt noch erreicht, sonst ist die Ausnahme tot.
  const pages = OFFLINE_EXCLUDED.filter((rel) => rel.endsWith('.js'));
  assert.deepEqual(pages.filter((rel) => !skipped.has(rel)), [], 'OFFLINE_EXCLUDED nennt Seiten, die der Graph nicht mehr erreicht');
});

test('was OFFLINE_EXCLUDED nennt, ist nicht precacht - wie vor dem Build', () => {
  const byChunk = new Map(Object.values(manifest).filter((c) => c.src).map((c) => [c.src, `/${c.file}`]));
  const leaked = OFFLINE_EXCLUDED.map((rel) => byChunk.get(rel) ?? `/${rel}`).filter((url) => precached.has(url));
  assert.deepEqual(leaked, [], 'diese Opt-in-Seiten/Blaetter sind doch precacht');
});

test('die Kopierliste wirkt: precache true ist drin, false nicht', () => {
  const copied = copiedFiles(PUBLIC_DIR);
  const wrong = copied.filter((rel) => {
    const want = Boolean(copyEntryFor(rel)?.precache) && !excludedSources.has(rel);
    return want !== precached.has(`/${rel}`);
  });
  assert.deepEqual(wrong, [], 'diese kopierten Dateien stehen anders im Precache, als die Kopierliste sagt');
});

test('jedes eager geladene Stylesheet aus index.html ist precacht', () => {
  const html = withoutHtmlComments(readFileSync(PUBLIC_DIR + 'index.html', 'utf8'));
  const eager = [...html.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*>/gi)]
    .map((m) => m[0])
    .filter((tag) => !/\bmedia=/i.test(tag) && !/\bonload=/i.test(tag))
    .map((tag) => tag.match(/\bhref=["']([^"']+)["']/i)?.[1])
    .filter(Boolean);
  assert.ok(eager.length >= 10, `Nur ${eager.length} eager geladene Stylesheets gefunden - das Muster greift nicht mehr`);
  const missing = eager.filter((href) => !precached.has(/** @type {string} */ (href)));
  assert.deepEqual(missing, [], `Diese Stylesheets laedt index.html eager, der Worker precacht sie nicht:\n  ${missing.join('\n  ')}`);
});

test('jedes von der gebauten index.html geladene Skript ist precacht', () => {
  const html = withoutHtmlComments(readDist('index.html'));
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
    .map((m) => m[1])
    .filter((src) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src));
  assert.ok(scripts.length >= 7, `Nur ${scripts.length} Skripte gefunden - das Muster greift nicht mehr`);
  const missing = scripts.filter((src) => !precached.has(src));
  assert.deepEqual(missing, [], `Diese Skripte laedt index.html, der Worker precacht sie nicht:\n  ${missing.join('\n  ')}`);
});

test('Shell und Sprachen trennen sich wie das fetch-Routing, keine Doppel', () => {
  assert.deepEqual(APP_SHELL.filter((p) => p.startsWith('/locales/')), [], 'eine Sprachdatei in der Shell - der Worker sucht sie in LOCALES_CACHE');
  assert.ok(APP_SHELL.includes('/') && APP_SHELL.includes('/index.html'));
  const all = [...APP_SHELL, ...PRECACHED_LOCALES];
  const dupes = all.filter((p, i) => all.indexOf(p) !== i);
  assert.deepEqual([...new Set(dupes)], [], `Mehrfach precacht: ${dupes.join(', ')}`);
});

test('jede Locale-Datei ist dem Worker bekannt', () => {
  const files = readdirSync(PUBLIC_DIR + 'locales')
    .filter((file) => file.endsWith('.json'))
    .map((file) => `/locales/${file}`)
    .sort();
  assert.deepEqual([...APP_LOCALES].sort(), files, 'self.__LOCALES__ in dist/sw.js deckt sich nicht mit public/locales/*.json');
});

test('vorab gecacht wird nur die Rueckfallsprache von i18n.js', () => {
  const i18n = readFileSync(PUBLIC_DIR + 'i18n.js', 'utf8');
  const fallback = i18n.match(/const DEFAULT_LOCALE = '([\w-]+)';/)?.[1];
  assert.ok(fallback, 'DEFAULT_LOCALE in public/i18n.js nicht gefunden');
  assert.deepEqual(PRECACHED_LOCALES, [`/locales/${fallback}.json`]);
  assert.ok(PRECACHED_LOCALES.every((path) => APP_LOCALES.includes(path)));
  assert.match(readFileSync(PUBLIC_DIR + 'sw.js', 'utf8'), /const freshLocales = PRECACHED_LOCALES\.map\(/, 'install cacht PRECACHED_LOCALES, nicht APP_LOCALES');
});

test('jedes Settings-Blatt der Registry ist precacht', () => {
  // Ein Blatt wird per dynamischem `loader: () => import(...)` geladen und
  // steht in keinem statischen Importbaum; gemessen am 2026-08-15 fehlten
  // sechs von 28. Kanonische Quelle ist die Registry, nicht das Verzeichnis.
  const registry = readFileSync(PUBLIC_DIR + 'settings/registry.js', 'utf8');
  const leaves = [...registry.matchAll(/loader:\s*\(\)\s*=>\s*import\(\s*(['"`])([^'"`]+)\1\s*\)/g)].map((m) => m[2]);
  assert.ok(leaves.length >= 20, `Nur ${leaves.length} Blätter in der Registry gefunden - das Muster greift nicht mehr`);
  const missing = leaves.filter((path) => {
    const chunk = manifest[path.replace(/^\//, '')];
    return !chunk || !precached.has(`/${chunk.file}`);
  });
  assert.deepEqual(missing, [], `Diese Settings-Blätter sind offline nicht erreichbar:\n  ${missing.join('\n  ')}`);
});
