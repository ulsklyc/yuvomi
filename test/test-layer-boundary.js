/**
 * Schicht-Guard (Frontend/Backend-Grenze).
 * Hält die Architektur-Invariante dauerhaft:
 *
 *   - `public/` (Browser-Frontend) importiert NIEMALS aus `server/`.
 *     Frontend-Code läuft im Browser; ein Server-Modul (node:*, better-sqlite3,
 *     Middleware) dort zu importieren bricht zur Laufzeit und vermischt die Schichten.
 *   - `server/` (Node-Backend) importiert aus `public/` NUR bewusst geteilte,
 *     isomorphe Utilities aus der Liste SERVER_PUBLIC_IMPORT_NAMES in
 *     `.dependency-cruiser.mjs` (reine Funktionen ohne DOM/Node-Abhängigkeit, die
 *     Front- und Backend identisch nutzen sollen). Die Liste steht nur dort, mit
 *     dem Grund je Eintrag; dieser Test liest sie.
 *
 * Motivation: Ein AST-Namensauflöser (z. B. graphify) band gleichnamige Funktionen
 * (`num()`, `save()`) über die Schichtgrenze hinweg falsch aneinander. Die Regel
 * „public/ ruft nie server/ direkt auf, außer über geteilte isomorphe Utils" ist der
 * zuverlässige Filter dafür — und zugleich eine echte Architektur-Invariante des
 * Produkts. Dieser Guard erzwingt sie an der Quelle statt am regenerierten Graphen.
 *
 * Eine neue geteilte isomorphe Util wird bewusst durch Aufnahme in
 * SERVER_PUBLIC_IMPORT_NAMES freigegeben - nicht durch Aufweichen der Regel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SERVER_PUBLIC_IMPORT_NAMES } from '../.dependency-cruiser.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const SERVER_DIR = path.join(ROOT, 'server');

// The shared isomorphic modules server/ may import from public/ are listed once, in
// SERVER_PUBLIC_IMPORT_NAMES in .dependency-cruiser.mjs (decision E16, frozen until
// phase 4), each with the reason it is shared. Names without extension: the rename to
// TypeScript in phase 2 is no new target.
const SHARED_ISOMORPHIC = new Set(SERVER_PUBLIC_IMPORT_NAMES.map((name) => `public/utils/${name}`));

const SOURCE_EXT = /\.(js|mjs|ts)$/;

/** Alle .js/.mjs-Dateien unter dir (rekursiv), als absolute Pfade. */
function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (SOURCE_EXT.test(name)) out.push(full);
  }
  return out;
}

/**
 * Liefert je import/export-from und dynamischem import() das Modul-Specifier
 * samt Zeilennummer. Deckt statische ES-Module und `import('…')` ab.
 */
function importSpecifiers(code) {
  const out = [];
  // static: import ... from '…'  |  export ... from '…'  |  import '…'
  const staticRe = /\b(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g;
  // dynamic: import('…')  — nur String-Literale (variable Specifier sind hier ohnehin selten)
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [staticRe, dynRe]) {
    let m;
    while ((m = re.exec(code)) !== null) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;
      const line = code.slice(0, m.index).split('\n').length;
      out.push({ spec, line });
    }
  }
  return out;
}

/** 'public' | 'server' | null für einen absoluten Pfad. */
function layerOf(absPath) {
  const rel = path.relative(ROOT, absPath);
  if (rel === 'public' || rel.startsWith('public' + path.sep)) return 'public';
  if (rel === 'server' || rel.startsWith('server' + path.sep)) return 'server';
  return null;
}

/**
 * Löst einen relativen Specifier gegen die Datei auf und liefert den absoluten
 * Zielpfad — oder null für nicht-relative Specifier (node:*, npm, Browser-Root `/…`).
 * Nur relative Pfade können die Schichtgrenze überqueren; alles andere ist irrelevant.
 */
function resolveRelative(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  return path.resolve(path.dirname(fromFile), spec);
}

test('public/ importiert niemals aus server/', () => {
  const violations = [];
  for (const file of sourceFiles(PUBLIC_DIR)) {
    const code = readFileSync(file, 'utf8');
    for (const { spec, line } of importSpecifiers(code)) {
      const target = resolveRelative(file, spec);
      if (target && layerOf(target) === 'server') {
        violations.push(`${path.relative(ROOT, file)}:${line} → importiert '${spec}' (server/)`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    'Frontend-Code darf keine Server-Module importieren — die Logik gehört hinter die API:\n' +
      violations.join('\n'),
  );
});

test('server/ importiert aus public/ nur geteilte isomorphe Utils (Allowlist)', () => {
  const violations = [];
  for (const file of sourceFiles(SERVER_DIR)) {
    const code = readFileSync(file, 'utf8');
    for (const { spec, line } of importSpecifiers(code)) {
      const target = resolveRelative(file, spec);
      if (target && layerOf(target) === 'public') {
        const relTarget = path.relative(ROOT, target).split(path.sep).join('/');
        if (!SHARED_ISOMORPHIC.has(relTarget.replace(/\.[jt]s$/, ''))) {
          violations.push(
            `${path.relative(ROOT, file)}:${line} → importiert '${spec}' (${relTarget})`,
          );
        }
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    'Backend darf aus public/ nur bewusst freigegebene isomorphe Utils importieren.\n' +
      'Ist das Modul wirklich isomorph (rein, ohne DOM/Node), ist das eine Entwurfsentscheidung:\n' +
      'Name samt Grund in SERVER_PUBLIC_IMPORT_NAMES (.dependency-cruiser.mjs) aufnehmen -\n' +
      'sonst die Logik ins Backend verschieben:\n' +
      violations.join('\n'),
  );
});

// ── Keine Quelldatei ist fuer Textwerkzeuge unsichtbar ───────────────────────
//
// Ein rohes NUL-Byte im Quelltext laeuft zur Laufzeit einwandfrei - JavaScript
// erlaubt das Zeichen im String, und beide Fundstellen benutzten es bewusst als
// Trennzeichen in einem Map-Schluessel. Fuer Unix-Werkzeuge macht es die Datei
// aber zur BINAERDATEI: `file` meldet "data", und `grep` schweigt ohne `-a`,
// statt "keine Treffer" auch nur zu behaupten.
//
// Gefunden wurde das, weil eine Suche nach `sync` in server/services/holidays.js
// leer zurueckkam - bei einer Datei mit 33 Treffern. Der falsche Schluss daraus
// ("der Service liest diese Konfiguration nicht") war schon gezogen. Jeder
// Guard dieses Repos, der ueber Textsuche arbeitet, haette dieselbe Luecke
// gehabt, ohne je rot zu werden.
//
// Die Escape-Sequenz `\x00` erzeugt exakt dasselbe Zeichen; geprueft wird
// deshalb die SCHREIBWEISE, nicht die Absicht.

test('keine Quelldatei enthaelt ein rohes NUL-Byte', () => {
  const roots = ['server', 'public', 'tools', 'test'];
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|mjs|ts|json|css|html)$/.test(entry.name)) files.push(full);
    }
  };
  for (const r of roots) walk(path.join(ROOT, r));

  assert.ok(files.length >= 200, `nur ${files.length} Quelldateien gefunden - die Suche greift nicht mehr`);

  const binary = files
    .filter((f) => readFileSync(f).includes(0x00))
    .map((f) => path.relative(ROOT, f));
  assert.deepEqual(binary, [],
    'Diese Dateien enthalten ein rohes NUL-Byte und gelten damit als Binaerdateien - '
    + 'grep und Konsorten ueberspringen sie stumm. Schreib das Zeichen als \\x00:\n  '
    + binary.join('\n  '));
});
