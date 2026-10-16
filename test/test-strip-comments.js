/**
 * Modul: Kommentare beim Ausliefern - der Schnitt selbst (Critique R19)
 * Zweck: server/utils/strip-comments.js darf nie Code anfassen. Ein Fehler hier
 *        zerlegt nicht eine Seite, sondern die App: jedes Modul geht durch ihn.
 * Ausfuehren: node --expose-internals --test test/test-strip-comments.js
 *
 * DER BELEG IST EIN ECHTER PARSER, NICHT DIESER TEST. Node bringt acorn mit
 * (`internal/deps/acorn`, erreichbar mit `--expose-internals`, nur hier im
 * Test). Fuer JEDE ausgelieferte .js/.mjs-Datei unter public/ (ohne vendor/
 * und *.min.js, die der Server nicht schneidet) muessen die Kommentare, die der
 * Schnitt findet, Stelle fuer Stelle die sein, die acorn meldet - ein `//` in
 * einem Regex-Literal oder ein `/*` in einem Template, das der Schnitt fuer
 * Kommentar hielte, faellt hier auf. Danach `node --check` auf jedes Ergebnis.
 * Wer eine neue Datei mit einer Form schreibt, die der Schnitt falsch liest,
 * sieht es hier, bevor sie ausgeliefert wird.
 *
 * CSS: jede Datei unter public/styles/ ergibt geschnitten dieselben Regeln
 * (css-rules.js, ein eigener Leser). Gemessen am 2026-10-16 zusaetzlich im
 * Browser: das CSSOM aller 44 Blaetter ist vor und nach dem Schnitt gleich.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { cssCommentRanges, jsCommentRanges, stripCssComments, stripJsComments } from '../server/utils/strip-comments.js';
import { eachRule } from './css-rules.js';
import { tempDir } from './tmp-dir.js';

const PUBLIC_DIR = path.join(import.meta.dirname, '..', 'public');
const run = promisify(execFile);

function acorn() {
  try {
    return createRequire(import.meta.url)('internal/deps/acorn/acorn/dist/acorn');
  } catch (err) {
    throw new Error(`acorn aus Node nicht erreichbar - laeuft die Suite mit --expose-internals? (${err.message})`);
  }
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Genau die Dateien, die der Server schneidet (utils/static-assets.js). */
const shipped = walk(PUBLIC_DIR).filter((file) => {
  const rel = path.relative(PUBLIC_DIR, file);
  return !rel.startsWith(`vendor${path.sep}`) && !file.endsWith('.min.js');
});
const scripts = shipped.filter((file) => /\.m?js$/.test(file));
const sheets = shipped.filter((file) => file.endsWith('.css'));

// --------------------------------------------------------
// JS: erfundene Faelle, je einer fuer jede Falle
// --------------------------------------------------------

const JS_CASES = [
  ['Regex mit // und /* bleibt', 'const r = /https?:\\/\\/x\\/*/g; // weg\n', 'const r = /https?:\\/\\/x\\/*/g;\n'],
  ['Zeichenklasse mit /', 'x = s.split(/[/*]/); /* weg */\n', 'x = s.split(/[/*]/);\n'],
  ['Division nach Klammer', 'a = (b) / 2 / c; // weg\n', 'a = (b) / 2 / c;\n'],
  ['Regex nach if (...)', 'if (ok) /[//]/.test(s); // weg\n', 'if (ok) /[//]/.test(s);\n'],
  ['Regex nach Block', 'if (x) {}\n/[/*]/.test(s);\n', 'if (x) {}\n/[/*]/.test(s);\n'],
  ['Division nach Objekt-Literal', 'n = ({}).a / 2 // weg\n', 'n = ({}).a / 2\n'],
  ['Regex nach return', 'function f() { return /a\\/\\/b/; } // weg\n', 'function f() { return /a\\/\\/b/; }\n'],
  ['Eigenschaft namens return', 'x = y.return / 2 / z; // weg\n', 'x = y.return / 2 / z;\n'],
  ['Strings mit Kommentarzeichen', "s = '/* nein */' + \"// nein\"; // ja\n", "s = '/* nein */' + \"// nein\";\n"],
  ['Template mit Ersetzung', 'h = `a // ${b /* weg */ + `c /* ${d} */`} // e`;\n', 'h = `a // ${b + `c /* ${d} */`} // e`;\n'],
  ['Objekt in einer Ersetzung', 'h = `${ {a: 1}.a / 2 }`; // weg\n', 'h = `${ {a: 1}.a / 2 }`;\n'],
  ['Kommentar ohne Umbruch trennt weiter', 'x = 1/**//2/1;\n', 'x = 1 /2/1;\n'],
  ['Zeilen bleiben (ASI nach return)', 'return /*\n*/ x;\n', 'return\n x;\n'],
  ['Lizenzkommentar bleibt', '/*! (c) Lizenz */\nx = 1;\n', '/*! (c) Lizenz */\nx = 1;\n'],
  ['@license bleibt', '/** @license MIT */\nx = 1;\n', '/** @license MIT */\nx = 1;\n'],
  ['Leerzeichen vor dem Kommentar gehen mit', 'x = 1;    // weg\n\t// ganz\n', 'x = 1;\n\n'],
];

for (const [name, source, expected] of JS_CASES) {
  test(`JS: ${name}`, () => {
    assert.equal(stripJsComments(source), expected);
  });
}

test('JS: acorn liest die erfundenen Faelle wie der Schnitt', () => {
  const { parse } = acorn();
  for (const [name, source] of JS_CASES) {
    const reference = [];
    const wrapped = `function __w() {\n${source}}`;
    parse(wrapped, { ecmaVersion: 'latest', sourceType: 'script', onComment: (_b, _t, start, end) => reference.push(`${start}:${end}`) });
    const mine = jsCommentRanges(wrapped).map((c) => `${c.start}:${c.end}`);
    assert.deepEqual(mine, reference, name);
  }
});

// --------------------------------------------------------
// JS: jede ausgelieferte Datei
// --------------------------------------------------------

test('JS: in jeder ausgelieferten Datei findet der Schnitt genau die Kommentare, die acorn findet', () => {
  const { parse } = acorn();
  assert.ok(scripts.length > 200, `nur ${scripts.length} Skripte gefunden`);
  const wrong = [];
  for (const file of scripts) {
    const source = readFileSync(file, 'utf8');
    const reference = [];
    let parsed = false;
    for (const sourceType of ['module', 'script']) {
      reference.length = 0;
      try {
        parse(source, { ecmaVersion: 'latest', sourceType, onComment: (_b, _t, start, end) => reference.push(`${start}:${end}`) });
        parsed = true;
        break;
      } catch { /* naechste Lesart */ }
    }
    if (!parsed) { wrong.push(`${path.relative(PUBLIC_DIR, file)}: acorn kann die Datei nicht lesen`); continue; }
    const mine = jsCommentRanges(source).map((c) => `${c.start}:${c.end}`);
    if (mine.join() !== reference.join()) {
      const want = new Set(reference);
      const got = new Set(mine);
      wrong.push(`${path.relative(PUBLIC_DIR, file)}: fehlt ${reference.filter((r) => !got.has(r)).slice(0, 3)}, zu viel ${mine.filter((r) => !want.has(r)).slice(0, 3)}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('JS: jede geschnittene Datei besteht node --check, behaelt ihre Zeilen und bleibt beim zweiten Schnitt gleich', async () => {
  const dir = tempDir('yuvomi-strip-');
  const wrong = [];
  const jobs = scripts.map((file, index) => {
    const source = readFileSync(file, 'utf8');
    const cut = stripJsComments(source);
    const rel = path.relative(PUBLIC_DIR, file);
    if (cut.split(/\r\n|\n|\r/).length !== source.split(/\r\n|\n|\r/).length) wrong.push(`${rel}: Zeilenzahl geaendert`);
    if (stripJsComments(cut) !== cut) wrong.push(`${rel}: zweiter Schnitt aendert noch etwas`);
    // .mjs: die meisten Dateien sind Module; die klassischen Startskripte sind
    // als Modul ebenfalls gueltig, und strenger gelesen schadet nicht.
    const target = path.join(dir, `${index}.mjs`);
    writeFileSync(target, cut);
    return { rel, target };
  });
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const { rel, target } = jobs[next++];
      try {
        await run(process.execPath, ['--check', target]);
      } catch (err) {
        wrong.push(`${rel}: ${String(err.stderr).split('\n').slice(0, 5).join(' | ')}`);
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  assert.deepEqual(wrong, []);
});

// --------------------------------------------------------
// CSS
// --------------------------------------------------------

const CSS_CASES = [
  ['zwischen zwei Selektoren wird kein Leerraum daraus', '.a/* x */.b { color: red; }', '.a/**/.b { color: red; }'],
  ['neben einer Klammer faellt er ersatzlos weg', '.a{/* x */color:red}', '.a{color:red}'],
  ['zwischen verschmelzenden Zeichen bleibt ein leerer Kommentar', 'a { margin: 1px/* x */2px; }', 'a { margin: 1px/**/2px; }'],
  ['url() ohne Anfuehrungszeichen bleibt', 'a { background: url(http://x/*y*/z.png); } /* weg */', 'a { background: url(http://x/*y*/z.png); }'],
  ['Strings bleiben', 'a::after { content: "/* nein */"; }', 'a::after { content: "/* nein */"; }'],
  ['Zeilen bleiben, wo Leerraum steht', '/* eins\n   zwei */\n.a { color: red; } /* drei */\n', '\n\n.a { color: red; }\n'],
  ['Lizenzkommentar bleibt', '/*! Lizenz */\n.a{}', '/*! Lizenz */\n.a{}'],
];

for (const [name, source, expected] of CSS_CASES) {
  test(`CSS: ${name}`, () => {
    assert.equal(stripCssComments(source), expected);
  });
}

test('CSS: jedes Blatt ergibt geschnitten dieselben Regeln', () => {
  assert.ok(sheets.length > 40, `nur ${sheets.length} Blaetter gefunden`);
  const norm = (text) => text.replace(/\s+/g, ' ').trim();
  const rules = (css) => [...eachRule(css)].map((r) => `${norm(r.at.join('|'))} § ${norm(r.selector)} { ${norm(r.body)}`);
  const wrong = [];
  for (const file of sheets) {
    const source = readFileSync(file, 'utf8');
    const cut = stripCssComments(source);
    const rel = path.relative(PUBLIC_DIR, file);
    if (rules(cut).join('\n') !== rules(source).join('\n')) wrong.push(`${rel}: Regeln weichen ab`);
    if (cssCommentRanges(cut).length !== 0 && !/\/\*!|\/\*\*\//.test(cut)) wrong.push(`${rel}: Kommentar uebrig`);
    if (stripCssComments(cut) !== cut) wrong.push(`${rel}: zweiter Schnitt aendert noch etwas`);
  }
  assert.deepEqual(wrong, []);
});
