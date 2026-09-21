/**
 * Modul: Test - alte Browser auf den kritischen Pfaden (#1276).
 * Zweck: Zwei Zusagen an einen Browser, der aelter ist als die App. Anlass war
 *        ein Chromebook mit Chrome 91, auf dem der Hauptbereich nicht scrollte.
 *
 *        1. FENSTERHOEHE. `dvh`/`svh`/`lvh` kennt Chrome erst ab 108 (Safari ab
 *           15.4). Ein aelterer Browser verwirft jede Deklaration damit, und an
 *           diesen Deklarationen hing die Hoehe von Body und Shell: ohne sie
 *           waechst #main-content auf Inhaltshoehe, und nichts scrollt. Dialoge
 *           verloren ebenso ihre Hoehengrenze. Jede solche Deklaration braucht
 *           deshalb einen Rueckfall, der in einem alten Browser auch WIRKT.
 *        2. START. Was vor dem ersten Bild laeuft, darf kein `Object.hasOwn`
 *           rufen (Chrome erst ab 93): `pickLocale()` tat es, und jeder ohne
 *           gespeicherte Sprache landete auf der Fehlerseite des Routers.
 * Ausfuehren: node --test test/test-old-browser-fallbacks.js
 *
 * DIE ENTSCHEIDUNG (21.09.2026) lautet: alte Browser nur auf kritischen Pfaden
 * stuetzen. Diese Suite haelt genau diese Pfade und keinen weiteren - die
 * anderen `Object.hasOwn`-Stellen (Einstellungen, Notizen, Fasten ...) laufen
 * erst nach dem Start in einzelnen Seiten und bleiben bewusst stehen.
 *
 * WARUM DER vh-ZWILLING NICHT UEBERALL REICHT - GEMESSEN, NICHT GERATEN.
 * `height: 100vh; height: 100dvh` ist der uebliche Rueckfall: wer dvh nicht
 * kennt, verwirft die zweite Zeile beim Parsen und behaelt die erste. Das gilt
 * aber nur fuer eine Deklaration OHNE var() oder env(). Mit var() gilt die
 * Deklaration beim Parsen als gueltig, verdraengt den Zwilling in der Kaskade
 * und wird erst beim Berechnen ungueltig - dann faellt der Wert auf seinen
 * Anfangswert (`max-height: none`), nicht auf den Zwilling. In aktuellem
 * Chromium mit einer unbekannten Einheit als Ersatz fuer dvh gemessen:
 * `max-height: calc(100vh - var(--x)); max-height: calc(100Xvh - var(--x))`
 * ergab `none`, ohne var() ergab derselbe Zwilling 100vh. Elf der sechzehn
 * dvh-Deklarationen trugen var(), darunter alle Hoehengrenzen der Dialoge.
 *
 * DESHALB DREI ERLAUBTE FORMEN, und der Leser unterscheidet sie:
 *   - ohne var()/env(): der vh-Zwilling DIREKT davor in derselben Regel, gleiche
 *     Eigenschaft, gleicher Wert bis auf die Einheit;
 *   - mit var()/env(): gar keine dvh-Einheit, sondern `var(--viewport-height)`
 *     aus tokens.css (dort 100vh, in `@supports (height: 100dvh)` 100dvh);
 *   - innerhalb eines `@supports`, das die Einheit selbst abfragt: nichts, denn
 *     ein Browser ohne die Einheit sieht den Block gar nicht erst. Nur so darf
 *     eine Custom Property eine dvh-Einheit tragen - ihr Wert wird erst beim
 *     Einsetzen geprueft, ein Zwilling davor waere dort genauso wirkungslos.
 *
 * ZWEI LESER, EIN VERGLEICH. Die Deklarationen kommen aus `eachRule()`
 * (test/css-rules.js), nie aus einem eigenen Regel-Regex. Dessen bekannte
 * Grenze ist `@keyframes`: er ueberspringt es. Eine dvh-Einheit in einer
 * Animationsstufe waere also ungeprueft. Deshalb zaehlt ein zweiter, bewusst
 * anders gebauter Leser die Einheiten im blossen Text (ohne Kommentare und
 * At-Praeambeln), und beide Zahlen muessen gleich sein.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { eachRule } from './css-rules.js';
import { pickLocale } from '../public/i18n.js';

const REPO = new URL('../', import.meta.url);
const PUBLIC = new URL('../public/', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, REPO), 'utf8');

/* ──────────────────────────────────────────────────────────────────────────
 * Teil 1: Fensterhoehe
 * ────────────────────────────────────────────────────────────────────────── */

// Die ganze Familie aus Chrome 108: dynamisch, klein, gross - Hoehe, Breite,
// min, max. Gross- und Kleinschreibung sind in CSS-Einheiten egal.
const UNIT = String.raw`(?:\d*\.)?\d+[dsl]v(?:h|w|min|max)\b`;
const countUnits = (text) => (text.match(new RegExp(UNIT, 'gi')) || []).length;
const hasUnit = (text) => new RegExp(UNIT, 'i').test(text);
const norm = (text) => text.replace(/\s+/g, ' ').trim().toLowerCase();
// Der Wert, den der Zwilling tragen muss: dieselbe Zahl in der alten Einheit.
const twinValue = (value) => value.replace(new RegExp(UNIT, 'gi'), (m) => m.replace(/[dsl](?=v)/i, ''));

/**
 * Deklarationen eines Regelrumpfs, getrennt an `;` ausserhalb von Strings und
 * Klammern - ein `;` in `url("data:...;base64,...")` trennt nichts.
 */
function declarations(body) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === ';' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean).map((text) => {
    const colon = text.indexOf(':');
    return {
      text,
      property: (colon < 0 ? text : text.slice(0, colon)).trim().toLowerCase(),
      value: colon < 0 ? '' : text.slice(colon + 1).trim(),
    };
  });
}

// Ein `@supports`, das die Einheit selbst abfragt und nicht verneint: wer die
// Einheit nicht kennt, sieht den Block nicht, braucht also keinen Rueckfall.
const guardedBySupports = (at) => at.some(
  (preamble) => /^@supports\b/i.test(preamble) && !/\bnot\b/i.test(preamble) && hasUnit(preamble),
);

/**
 * Jede Deklaration mit einer dvh-Einheit, die in einem Browser ohne diese
 * Einheit keinen wirksamen Rueckfall hat. `seen` zaehlt die Einheiten, die der
 * Leser in Deklarationen gesehen hat - fuer den Abgleich mit dem Textleser.
 */
function viewportUnitFindings(css) {
  const findings = [];
  let seen = 0;
  for (const { selector, body, at } of eachRule(css)) {
    const decls = declarations(body);
    decls.forEach((decl, index) => {
      const units = countUnits(decl.text);
      if (!units) return;
      seen += units;
      if (guardedBySupports(at)) return;
      const where = { selector, at, declaration: decl.text };
      if (decl.property.startsWith('--')) {
        findings.push({ ...where, kind: 'custom-property' });
        return;
      }
      if (/\b(?:var|env)\s*\(/i.test(decl.value)) {
        findings.push({ ...where, kind: 'computed-time' });
        return;
      }
      const previous = decls[index - 1];
      const expected = twinValue(decl.value);
      if (!previous || previous.property !== decl.property || norm(previous.value) !== norm(expected)) {
        findings.push({ ...where, kind: 'twin-missing', expected: `${decl.property}: ${expected}` });
      }
    });
  }
  return { findings, seen };
}

// Der zweite Leser: blosser Text ohne Kommentare und ohne At-Praeambeln (die
// Bedingung von `@supports (height: 100dvh)` ist keine Deklaration).
const unitsInText = (css) => countUnits(
  css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@[a-z-]+[^{};]*[{;]/gi, ''),
);

const HINTS = {
  'twin-missing': 'vh-Zwilling direkt davor fehlt',
  'computed-time': 'traegt var()/env() - ein vh-Zwilling davor hilft hier NICHT, der Wert faellt '
    + 'beim Berechnen auf seinen Anfangswert; var(--viewport-height) nehmen',
  'custom-property': 'Custom Property - ihr Wert wird erst beim Einsetzen geprueft; die Weiche '
    + 'gehoert in ein @supports, das die Einheit abfragt (wie --viewport-height in tokens.css)',
};

/**
 * Bewusst ohne Rueckfall. Jede Ausnahme nennt ihren Grund und wird an beiden
 * Enden geprueft: der Verstoss muss noch bestehen (sonst ist sie ueberfluessig)
 * und der Anlass auch (sonst gehoert der Rueckfall hinein).
 */
const EXCEPTIONS = [
  {
    file: 'public/styles/dashboard.css',
    selector: '.wall',
    declaration: 'min-height: 100dvh',
    reason: 'Wand-Modus, kein kritischer Pfad. Ein Zwilling `min-height: 100vh` waere die einzige '
      + 'vh-Einheit in den Wand-Regeln, und die verbietet der Wand-Guard in '
      + 'test-frontend-audit.js aus gemessenem Grund: eine Wand kann nicht gescrollt werden, und '
      + 'auf einem mobilen Browser ohne dvh ist 100vh die GROSSE Fensterhoehe - sie schoebe '
      + 'Datenstand und Ausstieg unter die Adressleiste, genau den Fehler, den der Wand-Guard '
      + 'festhaelt. Ohne min-height ist die Wand so hoch wie ihr Inhalt, und nichts faellt heraus. '
      + 'Die Wand braucht ohnehin @container (Chrome 105).',
    stillValid: () => read('test/test-frontend-audit.js')
      .includes("test('die Distanzskala der Wand haengt an der KNAPPEN Seite, nicht an der Hoehe'"),
  },
];
const isException = (file, finding) => EXCEPTIONS.some((ex) => ex.file === file
  && ex.selector === finding.selector && norm(ex.declaration) === norm(finding.declaration));

// Jedes Stylesheet der App, nicht nur public/styles/ - ein neues unter
// public/settings/ oder daneben soll nicht ungesehen bleiben. Vendor-Code ist
// fremd und wird nicht angefasst.
function appStylesheets() {
  return readdirSync(PUBLIC, { recursive: true })
    .map((entry) => String(entry).split('\\').join('/'))
    .filter((entry) => entry.endsWith('.css') && !entry.startsWith('vendor/'))
    .sort()
    .map((entry) => `public/${entry}`);
}

test('Leser: erkennt fehlende, falsche und wirkungslose Rueckfaelle (erfundene Faelle)', () => {
  const kinds = (css) => viewportUnitFindings(css).findings.map((f) => f.kind);

  // Richtig: Zwilling direkt davor, auch in anderer Schreibweise und Familie.
  assert.deepEqual(kinds('.a { height: 100vh; height: 100dvh; }'), []);
  assert.deepEqual(kinds('.a { width: 50vw; width: 50DVW }'), []);
  assert.deepEqual(kinds('.a { max-height: min(88vh, 90vh); max-height: min(88svh, 90lvh); }'), []);
  assert.deepEqual(kinds('@supports (height: 100dvh) { :root { --h: 100dvh; } }'), []);
  assert.deepEqual(kinds('@media (min-width: 1px) { @supports (height: 1svh) { .a { height: calc(100svh - var(--x)); } } }'), []);
  // Ein `;` in einem String trennt keine Deklaration.
  assert.deepEqual(kinds('.a { height: 100vh; height: 100dvh; background: url("data:a;b") }'), []);

  // Falsch: kein Zwilling, nicht direkt davor, anderer Wert, andere Eigenschaft.
  assert.deepEqual(kinds('.a { height: 100dvh }'), ['twin-missing']);
  assert.deepEqual(kinds('.a { height: 100vh; color: red; height: 100dvh; }'), ['twin-missing']);
  assert.deepEqual(kinds('.a { height: 50vh; height: 100dvh; }'), ['twin-missing']);
  assert.deepEqual(kinds('.a { min-height: 100vh; height: 100dvh; }'), ['twin-missing']);
  assert.deepEqual(kinds('.a { background: url("x;y"); height: 100dvh; }'), ['twin-missing']);
  assert.deepEqual(kinds('@media (min-width: 768px) { .a { max-height: 100svh; } }'), ['twin-missing']);

  // Wirkungslos: der Zwilling steht da, und trotzdem faellt der Wert auf none.
  assert.deepEqual(kinds('.a { max-height: calc(100vh - var(--x)); max-height: calc(100dvh - var(--x)); }'), ['computed-time']);
  assert.deepEqual(kinds('.a { max-height: calc(100dvh - env(safe-area-inset-top)); }'), ['computed-time']);
  assert.deepEqual(kinds(':root { --h: 100vh; --h: 100dvh; }'), ['custom-property']);
  assert.deepEqual(kinds('@supports not (height: 100dvh) { .a { height: 100dvh } }'), ['twin-missing']);

  // Der Zwilling-Vorschlag nennt die richtige Zeile.
  assert.equal(viewportUnitFindings('.a { max-height: min(88dvh, 50px) }').findings[0].expected,
    'max-height: min(88vh, 50px)');
});

test('Textleser: sieht, was eachRule() ueberspringt (erfundene Faelle)', () => {
  // Kommentare und die Bedingung von @supports zaehlen nicht.
  const plain = '/* 100dvh */ @supports (height: 100dvh) { .a { height: 100vh; height: 100dvh; } }';
  assert.equal(unitsInText(plain), 1);
  assert.equal(viewportUnitFindings(plain).seen, 1);
  // @keyframes: eachRule() ueberspringt es, der Textleser nicht - der Abgleich
  // der beiden Zahlen ist genau fuer diesen Fall da.
  const keyframes = '@keyframes slide { to { transform: translateY(100dvh); } }';
  assert.equal(unitsInText(keyframes), 1);
  assert.equal(viewportUnitFindings(keyframes).seen, 0);
});

test('jede dvh-Deklaration in den Stylesheets hat einen Rueckfall, der in Chrome 91 wirkt (#1276)', () => {
  const files = appStylesheets();
  const offenders = [];
  const matchedExceptions = new Set();
  let rules = 0;
  let seen = 0;
  let inText = 0;

  for (const file of files) {
    const css = read(file);
    rules += [...eachRule(css)].length;
    const result = viewportUnitFindings(css);
    seen += result.seen;
    inText += unitsInText(css);
    for (const finding of result.findings) {
      if (isException(file, finding)) {
        matchedExceptions.add(EXCEPTIONS.find((ex) => ex.file === file && ex.selector === finding.selector));
        continue;
      }
      const context = finding.at.length ? `${finding.at.join(' > ')} > ` : '';
      offenders.push(`${file}: ${context}${finding.selector} { ${finding.declaration} } - ${HINTS[finding.kind]}`
        + (finding.expected ? ` (\`${finding.expected};\` davor)` : ''));
    }
  }

  // Reichweiten-Nachweis: der Regelscanner greift, und die beiden Leser sehen
  // dieselben Einheiten.
  assert.ok(files.includes('public/styles/layout.css') && files.includes('public/styles/tokens.css'),
    `Stylesheet-Suche greift nicht: ${files.join(', ')}`);
  assert.ok(rules >= 2000, `Reichweiten-Nachweis: nur ${rules} Regeln gelesen - greift eachRule() noch?`);
  assert.ok(seen > 0, 'Reichweiten-Nachweis: keine einzige dvh-Einheit gelesen - greift der Leser noch?');
  assert.equal(seen, inText,
    `Der Deklarationsleser sah ${seen} dvh-Einheiten, der Textleser ${inText}. Die Differenz steht an `
    + 'einer Stelle, die eachRule() nicht liefert (z.B. @keyframes) - dort prueft dieser Guard nichts.');

  assert.deepEqual(offenders, [],
    'Ein Browser ohne dvh (Chrome < 108, Safari < 15.4) verwirft diese Deklarationen, und der '
    + 'Rueckfall fehlt oder wirkt nicht:\n' + offenders.join('\n'));

  const stale = EXCEPTIONS.filter((ex) => !matchedExceptions.has(ex));
  assert.deepEqual(stale.map((ex) => `${ex.file}: ${ex.selector} { ${ex.declaration} }`), [],
    'Diese Ausnahme trifft keinen Verstoss mehr - aus EXCEPTIONS streichen');
});

test('die Ausnahmen haben ihren Anlass noch', () => {
  const lapsed = EXCEPTIONS.filter((ex) => !ex.stillValid());
  assert.deepEqual(lapsed.map((ex) => `${ex.file}: ${ex.selector} - ${ex.reason}`), [],
    'Der Grund dieser Ausnahme besteht nicht mehr - den Rueckfall ergaenzen und sie streichen');
});

test('--viewport-height ist 100vh und wird erst in @supports zu 100dvh', () => {
  const rules = [...eachRule(read('public/styles/tokens.css'))];
  const find = (supports) => rules.findIndex((rule) => rule.selector === ':root'
    && (supports ? rule.at.length === 1 && guardedBySupports(rule.at) : rule.at.length === 0)
    && declarations(rule.body).some((d) => d.property === '--viewport-height'));
  const base = find(false);
  const modern = find(true);
  assert.ok(base >= 0, 'tokens.css: kein --viewport-height auf :root ausserhalb von @-Bloecken');
  assert.ok(modern >= 0, 'tokens.css: kein --viewport-height in einem @supports, das dvh abfragt');
  const value = (index) => declarations(rules[index].body).find((d) => d.property === '--viewport-height').value;
  assert.equal(norm(value(base)), '100vh', 'der Grundwert ist der Rueckfall fuer Browser ohne dvh');
  assert.equal(norm(value(modern)), '100dvh');
  assert.ok(modern > base,
    'Die @supports-Regel muss HINTER dem :root-Block stehen - gleiche Spezifitaet, die spaetere gewinnt');
});

/* ──────────────────────────────────────────────────────────────────────────
 * Teil 2: der Start bis zum ersten Bild
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Statische Importe einer Quelle, als Specifier. Jede Schreibweise, die der
 * Browser laedt: benannt, Standard, Namensraum, Seiteneffekt, Re-Export, ueber
 * mehrere Zeilen, mit einfachen UND doppelten Anfuehrungszeichen (die
 * Einstellungsseite fuer Dokumentenspeicher nutzt doppelte). Dynamisches
 * `import()` bleibt draussen - es laeuft erst, wenn der Code es ruft.
 */
function staticImports(source) {
  const pattern = /^[ \t]*(?:import|export)\b\s*(?:[^'";()]*?\bfrom\s*)?(['"])([^'"\n]+)\1/gm;
  return [...source.matchAll(pattern)].map((m) => m[2]);
}

/**
 * HTML ohne Kommentare, per indexOf statt per replace-Regex - wie in
 * test-installer-schema.js (#1198). CodeQL wertet jedes Kommentar-replace
 * einzeln als unvollstaendige Bereinigung (js/incomplete-multi-character-
 * sanitization), auch in einer Fixpunkt-Schleife. Und ein Kommentar, der nicht
 * geschlossen wird, gilt wie im Browser bis zum Dateiende: ein `<script>`
 * dahinter laeuft nie.
 */
function htmlWithoutComments(src) {
  let out = '';
  let pos = 0;
  for (;;) {
    const start = src.indexOf('<!--', pos);
    if (start === -1) return out + src.slice(pos);
    out += src.slice(pos, start);
    const end = src.indexOf('-->', start + 4);
    if (end === -1) return out;
    pos = end + 3;
  }
}

/** Die `<script>`-Tags eines HTML-Dokuments, ohne die auskommentierten. */
function scriptEntries(html) {
  const tags = [...htmlWithoutComments(html).matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
  return tags.map((tag) => ({
    path: tag.match(/\bsrc=["']([^"']+)["']/i)?.[1],
    module: /\btype=["']module["']/i.test(tag),
  }));
}

/**
 * Was vor dem ersten Bild laeuft: jedes Skript aus index.html (klassisch und als
 * Modul) und transitiv alles, was die Module statisch importieren. modulepreload
 * zaehlt nicht - es laedt, fuehrt aber nichts aus.
 */
function startupFiles() {
  const entries = scriptEntries(read('public/index.html'));
  const files = new Map();
  const unresolved = [];
  const queue = [];
  for (const entry of entries) {
    if (!entry.path) { unresolved.push('<script> ohne src - Inline-Code wird hier nicht gelesen'); continue; }
    files.set(entry.path, entry.path.startsWith('/vendor/') ? 'vendor' : 'index.html');
    if (entry.module) queue.push(entry.path);
  }
  while (queue.length) {
    const current = queue.shift();
    const file = new URL(current.replace(/^\//, ''), PUBLIC);
    if (!existsSync(file)) { unresolved.push(`${current} existiert nicht`); continue; }
    for (const spec of staticImports(readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('/') && !spec.startsWith('.')) {
        unresolved.push(`${current}: nackter Specifier '${spec}'`);
        continue;
      }
      const dep = spec.startsWith('/') ? spec : posix.resolve(posix.dirname(current), spec);
      if (files.has(dep)) continue;
      files.set(dep, current);
      queue.push(dep);
    }
  }
  return { files, unresolved };
}

// APIs, die Chrome 91 nicht kennt und die auf dem Startpfad nichts verloren
// haben. Heute genau eine; die Liste ist die Stelle fuer die naechste.
const STARTUP_FORBIDDEN = [
  {
    api: 'Object.hasOwn',
    since: 'Chrome 93, Safari 15.4',
    instead: 'Object.prototype.hasOwnProperty.call(obj, key)',
    patterns: [
      /\bObject\s*(?:\.\s*hasOwn|\[\s*(['"`])hasOwn\1\s*\])(?![\w$])/,
      /\{[^{}]*\bhasOwn\b[^{}]*\}\s*=\s*Object\b/,
    ],
  },
];

// Zeilen, die Code sind: Kommentarzeilen zaehlen nicht, ein Hinweis wie "statt
// Object.hasOwn" darf den Guard nicht rot machen.
const codeLines = (source) => source.split('\n')
  .map((line, index) => ({ line, number: index + 1 }))
  .filter(({ line }) => !/^\s*(?:\/\/|\/\*|\*)/.test(line));

function forbiddenCalls(source) {
  const hits = [];
  for (const { line, number } of codeLines(source)) {
    for (const rule of STARTUP_FORBIDDEN) {
      if (rule.patterns.some((pattern) => pattern.test(line))) hits.push({ rule, number, line: line.trim() });
    }
  }
  return hits;
}

test('Leser: statische Importe in jeder Schreibweise, dynamische nicht (erfundene Faelle)', () => {
  const source = [
    "import { a } from '/a.js';",
    'import b from "./b.js";',
    "import * as c from '../c.js';",
    "import '/side-effect.js';",
    'import d, {',
    '  e,',
    '  f as g,',
    "} from '/multi.js';",
    "export * from './re.js';",
    'export { h } from "/re2.js";',
    "const lazy = await import('/lazy.js');",
    "// import x from '/commented.js';",
    "export const label = 'from';",
    'export function f() { return import.meta.url; }',
  ].join('\n');
  assert.deepEqual(staticImports(source),
    ['/a.js', './b.js', '../c.js', '/side-effect.js', '/multi.js', './re.js', '/re2.js']);
});

test('Leser: auskommentierte Skripte zaehlen nicht, auch hinter einem offenen Kommentar (erfundene Faelle)', () => {
  const html = [
    '<script src="/classic.js"></script>',
    '<!-- <script src="/commented.js"></script> -->',
    '<script type="module" src="/module.js"></script>',
    '<!-- <!-- verschachtelt --> <script src="/after-first-close.js"></script>',
    '<!-- nie geschlossen',
    '<script type="module" src="/after-open-comment.js"></script>',
  ].join('\n');
  assert.deepEqual(scriptEntries(html), [
    { path: '/classic.js', module: false },
    { path: '/module.js', module: true },
    // Ein Kommentar endet am ERSTEN `-->`, wie im Browser.
    { path: '/after-first-close.js', module: false },
  ]);
});

test('Leser: findet Object.hasOwn in jeder Form, Kommentare und hasOwnProperty nicht (erfundene Faelle)', () => {
  const hits = (source) => forbiddenCalls(source).map((hit) => hit.number);
  assert.deepEqual(hits('if (Object.hasOwn(o, k)) {}'), [1]);
  assert.deepEqual(hits("x = Object['hasOwn'](o, k);"), [1]);
  assert.deepEqual(hits('const { hasOwn } = Object;'), [1]);
  assert.deepEqual(hits('Object.prototype.hasOwnProperty.call(o, k);'), []);
  assert.deepEqual(hits('// statt Object.hasOwn\n * Object.hasOwn im Kommentar\nok();'), []);
});

test('der Startpfad ruft kein Object.hasOwn (Chrome 91 kommt bis zum ersten Bild, #1276)', () => {
  const { files, unresolved } = startupFiles();
  assert.deepEqual(unresolved, [], 'Der Startpfad liess sich nicht vollstaendig aufloesen');
  // Reichweiten-Nachweis an den Dateien, um die es geht: der Router, der den
  // Start fuehrt, und i18n.js, in dem der Fehler von #1276 stand.
  for (const must of ['/router.js', '/i18n.js', '/api.js', '/theme-init.js', '/lang-init.js']) {
    assert.ok(files.has(must), `Reichweiten-Nachweis: ${must} fehlt im Startpfad - greift der Leser noch?`);
  }

  const offenders = [];
  for (const [path, via] of files) {
    const source = readFileSync(new URL(path.replace(/^\//, ''), PUBLIC), 'utf8');
    for (const hit of forbiddenCalls(source)) {
      offenders.push(`${path}:${hit.number} (geladen von ${via}): ${hit.line}\n    ${hit.rule.api} erst ab `
        + `${hit.rule.since} - stattdessen ${hit.rule.instead}`);
    }
  }
  assert.deepEqual(offenders, [],
    'Diese Stellen laufen vor dem ersten Bild; ein aelterer Browser wirft dort und zeigt nur die '
    + 'Fehlerseite des Routers:\n' + offenders.join('\n'));
});

test('pickLocale() laeuft ohne Object.hasOwn - als Programm, nicht nur als Text', () => {
  // Der Textguard oben sieht nur, was dasteht. Dieser Test nimmt dem Prozess
  // die API weg, wie Chrome 91 sie nie hatte, und ruft die Aufloesung mit den
  // Tags, die den Zweig mit der Region erreichen - `de-DE` genuegte dafuer.
  const saved = Object.getOwnPropertyDescriptor(Object, 'hasOwn');
  delete Object.hasOwn;
  let results;
  try {
    results = [
      pickLocale(['de-DE'], ['de', 'en']),
      pickLocale(['zh-TW'], ['en', 'zh', 'zh-Hant']),
      pickLocale(['zh-Hans-HK'], ['en', 'zh', 'zh-Hant']),
      pickLocale(['xx-YY'], ['de', 'en']),
    ];
  } finally {
    if (saved) Object.defineProperty(Object, 'hasOwn', saved);
  }
  assert.deepEqual(results, ['de', 'zh-Hant', 'zh', 'en']);
});
