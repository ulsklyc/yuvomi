/**
 * Modul: Fassaden fuer Drittmodule im Build (Phase 1a, Abschnitt D, E10)
 * Zweck: Ein Drittmodul importiert `/api.js`, `/i18n.js` und `/utils/html.js`
 *        (docs/SPEC.md, "Third-Party Modules"). Seit dem Build sind alle
 *        anderen Dateien gehasht; diese drei muessen unter genau ihrem Pfad
 *        liegen, ungehasht, mit jedem Export der Quelle, und die App muss
 *        dieselbe Modulinstanz sehen (sonst haette ein Drittmodul eine zweite
 *        i18n ohne geladene Sprache). Geprueft am gebauten dist/, nicht an der
 *        Quelle: was Tree-Shaking wegnimmt, sieht man nur dort.
 * Ausfuehren: npm run build && node --test test/test-module-facades.js
 * Abhaengigkeiten: dist/ (npm run build), rolldown/utils (Parser, kommt mit vite)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseSync } from 'rolldown/utils';
import { FACADES } from '../scripts/build/static-files.ts';
import { DIST, distManifest, requireDist } from './dist-build.js';

const PUBLIC = new URL('../public/', import.meta.url);

/**
 * Exportnamen eines Moduls aus dem Syntaxbaum - ohne es auszufuehren.
 * @param {string} file
 * @param {string} code
 * @returns {Set<string>}
 */
function exportNames(file, code) {
  const { program, errors } = parseSync(file, code, { sourceType: 'module' });
  assert.deepEqual(errors, [], `${file} laesst sich nicht lesen`);
  const names = new Set();
  for (const node of /** @type {any[]} */ (program.body)) {
    if (node.type === 'ExportAllDeclaration') {
      assert.fail(`${file}: \`export *\` - die Namen sind so nicht abzulesen; ausschreiben`);
    }
    if (node.type === 'ExportDefaultDeclaration') names.add('default');
    if (node.type !== 'ExportNamedDeclaration') continue;
    for (const spec of node.specifiers ?? []) names.add(spec.exported.name ?? spec.exported.value);
    const decl = node.declaration;
    if (!decl) continue;
    if (decl.id?.name) names.add(decl.id.name);
    for (const d of decl.declarations ?? []) {
      if (d.id.type === 'Identifier') names.add(d.id.name);
      else assert.fail(`${file}: destrukturierter Export ${d.id.type} - nicht vorgesehen`);
    }
  }
  return names;
}

test('MODULES.md nennt genau die Fassaden aus scripts/build/static-files.ts', () => {
  // Eine weitere Fassade ist ein Eintrag in FACADES - und ein Satz in der Zusage.
  const doc = readFileSync(new URL('../MODULES.md', import.meta.url), 'utf8');
  const promise = doc.match(/the stable facades: ((?:`[^`]+`(?:, )?)+)\./)?.[1];
  assert.ok(promise, 'MODULES.md nennt die Fassadenliste nicht mehr');
  const named = [...promise.matchAll(/`\/([^`]+)`/g)].map((m) => m[1]);
  assert.deepEqual(named, [...FACADES], 'MODULES.md und FACADES nennen verschiedene Pfade');
  assert.ok(FACADES.includes('api.js') && FACADES.includes('utils/html.js'), 'docs/SPEC.md sagt /api.js und /utils/html.js zu');
});

test('MODULES.md und die SPEC zeigen Drittmodulen nur Importe der Fassaden', () => {
  // Entscheidung 09.11.2026: genau drei Fassaden. Ein Beispiel, das einen
  // anderen App-Pfad importiert (bis dahin /utils/page-layout.js), laedt im
  // Build nicht: der Pfad liegt gehasht im Buendel, der Server antwortet 404.
  const allowed = new Set(FACADES.map((f) => `/${f}`));
  const spec = readFileSync(new URL('../docs/SPEC.md', import.meta.url), 'utf8');
  const third = spec.slice(spec.indexOf('### Third-Party Modules'), spec.indexOf('\n---', spec.indexOf('### Third-Party Modules')));
  for (const [name, text] of [['MODULES.md', readFileSync(new URL('../MODULES.md', import.meta.url), 'utf8')], ['docs/SPEC.md (Third-Party Modules)', third]]) {
    const imports = [...text.matchAll(/\bfrom\s+['"](\/[^'"]+)['"]|\bimport\(\s*['"](\/[^'"]+)['"]/g)].map((m) => m[1] ?? m[2]);
    const foreign = imports.filter((spec) => !allowed.has(spec) && !spec.startsWith('/api/v1/'));
    assert.deepEqual(foreign, [], `${name} importiert App-Pfade ausserhalb der Fassaden`);
    assert.doesNotMatch(text, /page-layout\.js|utilities under `?\/utils\/`?/, `${name} verweist Modulautoren auf Pfade ausserhalb der Fassaden`);
  }
});

test('jede Fassade liegt ungehasht unter ihrem Pfad und ist Eintrag im Manifest', () => {
  requireDist();
  const manifest = distManifest();
  for (const file of FACADES) {
    assert.ok(existsSync(`${DIST}${file}`), `dist/${file} fehlt - ein Drittmodul bekaeme 404`);
    const entry = manifest[file];
    assert.ok(entry, `${file} steht nicht im Manifest`);
    assert.equal(entry.file, file, `${file} wurde als ${entry.file} ausgegeben (gehasht?)`);
    assert.equal(entry.isEntry, true, `${file} ist kein Eintrag`);
  }
});

test('die Fassaden exportieren mindestens, was die Quelle exportiert (Tree-Shaking nimmt nichts weg)', () => {
  requireDist();
  for (const file of FACADES) {
    const source = exportNames(file, readFileSync(new URL(file, PUBLIC), 'utf8'));
    const built = exportNames(file, readFileSync(`${DIST}${file}`, 'utf8'));
    assert.ok(source.size >= 3, `${file}: nur ${source.size} Exporte in der Quelle gelesen - der Leser greift nicht`);
    const missing = [...source].filter((name) => !built.has(name));
    assert.deepEqual(missing, [], `dist/${file} exportiert diese Namen der Quelle nicht mehr`);
  }
});

test('die App teilt die Modulinstanz mit der Fassade: ihr Chunk importiert denselben Code', () => {
  const manifest = distManifest();
  const index = manifest['index.html'];
  assert.ok(index?.isEntry, 'index.html fehlt im Manifest');
  // Statischer Graph des Eintrags: jede Fassade zeigt auf einen Chunk, den auch
  // die App laedt - sonst laege ihr Code zweimal im Build, mit zwei Zustaenden.
  const reach = new Set();
  const queue = ['index.html'];
  while (queue.length) {
    const key = /** @type {string} */ (queue.shift());
    if (reach.has(key)) continue;
    reach.add(key);
    queue.push(...(manifest[key].imports ?? []));
  }
  for (const file of FACADES) {
    const targets = manifest[file].imports ?? [];
    assert.ok(targets.length > 0, `${file} traegt seinen Code selbst statt ihn aus dem gemeinsamen Chunk zu holen`);
    for (const target of targets) assert.ok(reach.has(target), `${file} -> ${target}: diesen Chunk laedt die App nicht, eine zweite Instanz`);
  }
});

test('die gebauten Fassaden laden in einem Modul-Kontext und liefern ihre Namen', async () => {
  requireDist();
  // Das Noetigste an Browser, damit die Chunks beim Laden nicht an `window`
  // scheitern; geprueft wird das Binden der Namen, nicht ihr Verhalten.
  /** @type {Record<string, PropertyDescriptor | undefined>} */
  const restore = {};
  /** @type {Record<string, unknown>} */
  const stubs = {
    window: globalThis,
    document: { documentElement: { lang: 'de', dataset: {} }, addEventListener() {}, querySelector: () => null, getElementById: () => null, createElement: () => ({ style: {} }) },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener: () => {},
  };
  for (const [k, v] of Object.entries(stubs)) {
    restore[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    if (!(k in globalThis)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  try {
    for (const file of FACADES) {
      const mod = await import(pathToFileURL(`${DIST}${file}`).href);
      const source = exportNames(file, readFileSync(new URL(file, PUBLIC), 'utf8'));
      const missing = [...source].filter((name) => !(name in mod));
      assert.deepEqual(missing, [], `dist/${file} bindet diese Namen nicht`);
    }
  } finally {
    for (const [k, d] of Object.entries(restore)) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete /** @type {any} */ (globalThis)[k];
    }
  }
});
