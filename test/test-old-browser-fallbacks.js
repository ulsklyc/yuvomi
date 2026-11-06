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
 *           Seit #1369 dasselbe fuer jede API, die neuer ist als die
 *           dokumentierte Mindestversion (Liste STARTUP_FORBIDDEN).
 *        3. SYNTAX. Kein Modul der App traegt Syntax, die neuer ist als die
 *           Mindestversion - ein Syntaxfehler toetet die ganze Datei, im
 *           Startpfad also die App, sonst einen ganzen Bildschirm (#1369).
 *        4. GANZE BLOECKE. Kein Stylesheet nutzt ein Konstrukt, bei dem ein
 *           Browser an der Mindestversion einen ganzen Block verwirft
 *           (`@layer`, `@scope`, Nesting, Media-Bereichssyntax) (#1369).
 *        5. POPOVER. Ohne Popover-API bleibt jedes Popover zu: reset.css reicht
 *           die UA-Regel `[popover] { display: none }` nach, und keine Regel
 *           schlaegt sie mit einem `display` an einer Popover-Klasse (#2107).
 *
 * DIE MINDESTVERSION steht in docs/installation.md, Abschnitt "Browser
 * Support", zweite Tabellenzeile - gemessen am 21.09.2026 (#1369). Die Suite
 * liest sie dort und prueft jeden Eintrag ihrer Verbotslisten dagegen: ein
 * Eintrag, den die Mindestversion schon kann, ist ueberfluessig. Hebt jemand
 * die Mindestversion, meldet die Suite genau die Eintraege, die dann fallen.
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
 *   - ohne var()/env(): der vh-Zwilling davor in derselben Regel, gleiche
 *     Eigenschaft, gleicher Wert bis auf die Einheit. Dazwischen darf nur
 *     dieselbe Eigenschaft ohne dvh-Einheit stehen - so steht
 *     `height: -webkit-fill-available` zwischen 100vh und 100dvh, das auf iOS
 *     13.4 bis 15.3 die SICHTBARE Hoehe liefert, wo 100vh die grosse waere
 *     (Review zu #1371). Jede andere Deklaration dazwischen bricht die Kette;
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
import { moduleSpecifiers, withoutHtmlComments } from './source-text.js';
import { formatUnit, pickLocale } from '../public/i18n.js';

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
 * Steht der vh-Zwilling vor der Deklaration an `index`? Rueckwaerts gelesen
 * darf dazwischen nur dieselbe Eigenschaft OHNE dvh-Einheit stehen - etwa
 * `-webkit-fill-available` fuer Safari 13.4 bis 15.3. Eine andere Eigenschaft
 * oder eine weitere dvh-Zeile beendet die Suche.
 */
function twinBefore(decls, index, property, expected) {
  for (let j = index - 1; j >= 0; j -= 1) {
    const candidate = decls[j];
    if (candidate.property !== property || hasUnit(candidate.text)) return false;
    if (norm(candidate.value) === norm(expected)) return true;
  }
  return false;
}

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
      const expected = twinValue(decl.value);
      if (!twinBefore(decls, index, decl.property, expected)) {
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
  'twin-missing': 'vh-Zwilling davor fehlt (dazwischen darf nur dieselbe Eigenschaft ohne dvh stehen)',
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
// Leer seit #2183. Hier stand `.wall { min-height: 100dvh }` (Wand-Modus):
// ohne dvh war die Wand so hoch wie ihr Inhalt, und auf einem Wandrahmen mit
// WebView 106 sass der Fuss mitten im Bild. Die Wand nimmt ihre Hoehe jetzt
// von der Shell (eigener Test unten), eine Viewport-Einheit braucht sie nicht.
const EXCEPTIONS = [];
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

  // Richtig: Zwilling davor, auch in anderer Schreibweise und Familie.
  assert.deepEqual(kinds('.a { height: 100vh; height: 100dvh; }'), []);
  assert.deepEqual(kinds('.a { width: 50vw; width: 50DVW }'), []);
  assert.deepEqual(kinds('.a { max-height: min(88vh, 90vh); max-height: min(88svh, 90lvh); }'), []);
  assert.deepEqual(kinds('@supports (height: 100dvh) { :root { --h: 100dvh; } }'), []);
  assert.deepEqual(kinds('@media (min-width: 1px) { @supports (height: 1svh) { .a { height: calc(100svh - var(--x)); } } }'), []);
  // Ein `;` in einem String trennt keine Deklaration.
  assert.deepEqual(kinds('.a { height: 100vh; height: 100dvh; background: url("data:a;b") }'), []);
  // Zwischen Zwilling und dvh-Zeile: dieselbe Eigenschaft ohne dvh - die iOS-Kette.
  assert.deepEqual(kinds('.a { height: 100vh; height: -webkit-fill-available; height: 100dvh; }'), []);
  assert.deepEqual(kinds('.a { height: 100vh; height: -webkit-fill-available; height: stretch; height: 100dvh }'), []);

  // Falsch: kein Zwilling, fremde Deklaration dazwischen, anderer Wert, andere Eigenschaft.
  assert.deepEqual(kinds('.a { height: 100dvh }'), ['twin-missing']);
  assert.deepEqual(kinds('.a { height: 100vh; color: red; height: 100dvh; }'), ['twin-missing']);
  assert.deepEqual(kinds('.a { height: 50vh; height: 100dvh; }'), ['twin-missing']);
  assert.deepEqual(kinds('.a { min-height: 100vh; height: 100dvh; }'), ['twin-missing']);
  assert.deepEqual(kinds('.a { background: url("x;y"); height: 100dvh; }'), ['twin-missing']);
  // fill-available allein ist kein Zwilling, und eine dvh-Zeile dazwischen
  // beendet die Suche: dann fehlt beiden der eigene Zwilling.
  assert.deepEqual(kinds('.a { height: -webkit-fill-available; height: 100dvh; }'), ['twin-missing']);
  assert.deepEqual(kinds('.a { height: 100vh; height: 50svh; height: 100dvh; }'), ['twin-missing', 'twin-missing']);
  assert.deepEqual(kinds('.a { height: 100vh; width: 10px; height: -webkit-fill-available; height: 100dvh; }'), ['twin-missing']);
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

/**
 * body und .app-shell tragen fuer `height` genau drei Zeilen, in genau dieser
 * Reihenfolge (Review zu #1371). Der Guard oben laesst fill-available zwischen
 * Zwilling und dvh-Zeile nur ZU - er verlangt es nicht, und ohne diesen Test
 * gingen Entfernen und Vertauschen beide gruen durch (gemessen). Jede Zeile
 * gilt fuer andere Browser: 100dvh wo dvh bekannt ist, -webkit-fill-available
 * wo nur das bekannt ist (Safari 13.4 bis 15.3: die SICHTBARE Hoehe), 100vh wo
 * keins von beiden bekannt ist. Vertauscht gewaenne auf alten Browsern die
 * falsche Zeile.
 */
const IOS_HEIGHT_CHAIN = ['100vh', '-webkit-fill-available', '100dvh'];
const IOS_HEIGHT_CHAIN_CARRIERS = [
  { file: 'public/styles/reset.css', selector: 'body' },
  { file: 'public/styles/layout.css', selector: '.app-shell' },
];

test('body und .app-shell tragen die Hoehe als 100vh -> -webkit-fill-available -> 100dvh', () => {
  const wrong = [];
  for (const { file, selector } of IOS_HEIGHT_CHAIN_CARRIERS) {
    const rules = [...eachRule(read(file))].filter((rule) => rule.at.length === 0 && rule.selector === selector);
    assert.ok(rules.length > 0, `Reichweiten-Nachweis: keine Regel ${selector} in ${file} gelesen`);
    const heights = rules.flatMap((rule) => declarations(rule.body))
      .filter((decl) => decl.property === 'height')
      .map((decl) => norm(decl.value));
    if (JSON.stringify(heights) !== JSON.stringify(IOS_HEIGHT_CHAIN)) {
      wrong.push(`${file}: ${selector} { height: ${heights.join('; height: ') || '(keine)'} }`);
    }
  }
  assert.deepEqual(wrong, [],
    `body und .app-shell brauchen genau height: ${IOS_HEIGHT_CHAIN.join('; height: ')} - in dieser `
    + 'Reihenfolge. iOS Safari 13.4 bis 15.3 kennt -webkit-fill-available, aber kein dvh: fehlt die '
    + 'Zeile oder steht sie vor 100vh, gilt dort 100vh, die GROSSE Hoehe bei eingefahrener '
    + 'Adressleiste, und die untere Navigation liegt unter der Adressleiste. An beiden Stellen, weil '
    + 'fill-available sich am Containing Block misst - body mit 100vh gaebe der Shell wieder die '
    + 'grosse Hoehe:\n' + wrong.join('\n'));
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
 *
 * Der Leser ist `moduleSpecifiers()` aus source-text.js - derselbe, mit dem
 * test-sw-precache.js den Modulgraph liest. Dort kannte eine eigene Kopie nur
 * einfache Anfuehrungszeichen und sah documents-storage.js als importfrei.
 * HTML-Kommentare schneidet `withoutHtmlComments()` von dort; ein Kommentar,
 * der nicht geschlossen wird, gilt wie im Browser bis zum Dateiende.
 */
const staticImports = (source) => moduleSpecifiers(source).static;

/** Die `<script>`-Tags eines HTML-Dokuments, ohne die auskommentierten. */
function scriptEntries(html) {
  const tags = [...withoutHtmlComments(html).matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
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

/* ──────────────────────────────────────────────────────────────────────────
 * Die dokumentierte Mindestversion
 * ────────────────────────────────────────────────────────────────────────── */

const ENGINES = ['chrome', 'firefox', 'safari'];
const ENGINE_NAMES = { chrome: 'Chrome', firefox: 'Firefox', safari: 'Safari' };
// "14.1" -> [14, 1]; verglichen wird Stelle fuer Stelle, nicht als Dezimalzahl
// (15.10 ist neuer als 15.4).
const parseVersion = (text) => String(text).trim().split('.').map(Number);
const newer = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
};
const describeSince = (since) => ENGINES.map((e) => `${ENGINE_NAMES[e]} ${since[e]}`).join(', ');

/**
 * Die zweite Zeile der Tabelle in docs/installation.md ("Starts, every screen
 * opens, scrolls"): Chrome, Firefox, Safari (macOS), iOS. Gelesen und nicht
 * abgeschrieben - sonst stuende dieselbe Zahl an zwei Stellen, und nur eine
 * davon waere die gepruefte.
 */
function documentedFloor(markdown) {
  const row = markdown.split('\n').find((line) => /^\|\s*\*\*Starts, every screen opens, scrolls\*\*\s*\|/.test(line));
  if (!row) return null;
  const cells = row.split('|').slice(2, 6).map((cell) => cell.trim());
  if (cells.length !== 4 || !cells.every((cell) => /^\d+(?:\.\d+)?$/.test(cell))) return null;
  return { chrome: cells[0], firefox: cells[1], safari: cells[2], ios: cells[3] };
}

const FLOOR = documentedFloor(read('docs/installation.md'));

// Ein Eintrag einer Verbotsliste ist nur dann sinnvoll, wenn mindestens eine
// Engine an der Mindestversion ihn NICHT kann.
const aboveFloor = (since) => ENGINES.some((e) => newer(parseVersion(since[e]), parseVersion(FLOOR[e])));

test('die Mindestversion steht lesbar in docs/installation.md', () => {
  assert.ok(FLOOR, 'docs/installation.md: keine Zeile "| **Starts, every screen opens, scrolls** | <Chrome> | '
    + '<Firefox> | <Safari> | <iOS> |" - die Verbotslisten dieser Suite messen gegen genau diese Zeile');
  assert.equal(documentedFloor('| **Starts, every screen opens, scrolls** | 87 | 79 | 14.1 | 14.5 |').safari, '14.1');
  assert.equal(documentedFloor('| **Starts, every screen opens, scrolls** | 87 | 79 | 14.1 |'), null);
  assert.ok(newer(parseVersion('15.10'), parseVersion('15.4')) && !newer(parseVersion('14.1'), parseVersion('14.1')));
});

/* ──────────────────────────────────────────────────────────────────────────
 * Teil 2 (Fortsetzung): APIs auf dem Startpfad
 * ────────────────────────────────────────────────────────────────────────── */

// APIs, die neuer sind als die Mindestversion und die man leicht hinschreibt.
// Versionen aus MDN browser-compat-data 8.1.2 (#1369). Eine Liste von Hand und
// keine vollstaendige Pruefung: sie haelt die haeufigen Griffe fest, nicht
// jede denkbare API.
const STARTUP_FORBIDDEN = [
  {
    api: 'Object.hasOwn',
    since: { chrome: '93', firefox: '92', safari: '15.4' },
    instead: 'Object.prototype.hasOwnProperty.call(obj, key)',
    patterns: [
      /\bObject\s*(?:\.\s*hasOwn|\[\s*(['"`])hasOwn\1\s*\])(?![\w$])/,
      /\{[^{}]*\bhasOwn\b[^{}]*\}\s*=\s*Object\b/,
    ],
  },
  {
    api: 'Array.prototype.at / String.prototype.at',
    since: { chrome: '92', firefox: '90', safari: '15.4' },
    instead: 'list[list.length - 1]',
    patterns: [/\.\s*at\s*\(/],
  },
  {
    api: 'Array.prototype.findLast / findLastIndex',
    since: { chrome: '97', firefox: '104', safari: '15.4' },
    instead: 'eine Schleife von hinten',
    patterns: [/\.\s*findLast(?:Index)?\s*\(/],
  },
  {
    api: 'structuredClone',
    since: { chrome: '98', firefox: '94', safari: '15.4' },
    instead: 'JSON.parse(JSON.stringify(x)) oder eine gezielte Kopie',
    patterns: [/\bstructuredClone\s*\(/],
  },
  {
    api: 'crypto.randomUUID',
    since: { chrome: '92', firefox: '95', safari: '15.4' },
    instead: 'crypto.getRandomValues()',
    patterns: [/\.\s*randomUUID\s*\(/],
  },
  {
    api: 'Array.prototype.toSorted / toReversed / toSpliced',
    since: { chrome: '110', firefox: '115', safari: '16' },
    instead: '[...list].sort() usw.',
    patterns: [/\.\s*to(?:Sorted|Reversed|Spliced)\s*\(/],
  },
  {
    api: 'Object.groupBy / Map.groupBy',
    since: { chrome: '117', firefox: '119', safari: '17.4' },
    instead: 'reduce() in ein Objekt oder eine Map',
    patterns: [/\b(?:Object|Map)\s*\.\s*groupBy\b/],
  },
  {
    api: 'Promise.withResolvers',
    since: { chrome: '119', firefox: '121', safari: '17.4' },
    instead: 'new Promise((resolve, reject) => ...)',
    patterns: [/\bPromise\s*\.\s*withResolvers\b/],
  },
  {
    api: 'AbortSignal.timeout',
    since: { chrome: '124', firefox: '100', safari: '16' },
    instead: 'AbortController plus setTimeout',
    patterns: [/\bAbortSignal\s*\.\s*timeout\b/],
  },
  {
    api: 'AbortSignal.any',
    since: { chrome: '116', firefox: '124', safari: '17.4' },
    instead: 'ein eigener AbortController, der auf beide Signale hoert',
    patterns: [/\bAbortSignal\s*\.\s*any\b/],
  },
  {
    api: 'Array.fromAsync',
    since: { chrome: '121', firefox: '115', safari: '16.4' },
    instead: 'for await in ein Array',
    patterns: [/\bArray\s*\.\s*fromAsync\b/],
  },
];

/**
 * Treffer im Startpfad, die bewusst stehen bleiben. Jede Ausnahme wird an
 * beiden Enden geprueft: der Treffer muss noch da sein, und ihr Grund auch.
 */
const STARTUP_EXCEPTIONS = [
  // Leer seit dem Fix zu formatUnit(): dessen findLastIndex war die einzige
  // Ausnahme und ist eine Schleife geworden. Eine neue braucht `path`, `api`,
  // die EINE `line`, einen `reason` und ein `stillValid`, das den Grund prueft.
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

test('Leser: findet die neueren APIs, nicht ihre aelteren Namensvettern (erfundene Faelle)', () => {
  const apis = (source) => forbiddenCalls(source).map((hit) => hit.rule.api);
  assert.deepEqual(apis('const last = parts.at(-1);'), ['Array.prototype.at / String.prototype.at']);
  assert.deepEqual(apis('const i = parts.findLastIndex((p) => p);'), ['Array.prototype.findLast / findLastIndex']);
  assert.deepEqual(apis('const copy = window.structuredClone(x);'), ['structuredClone']);
  assert.deepEqual(apis('const id = crypto.randomUUID();'), ['crypto.randomUUID']);
  assert.deepEqual(apis('const s = list.toSorted();'), ['Array.prototype.toSorted / toReversed / toSpliced']);
  assert.deepEqual(apis('const g = Object.groupBy(xs, f);'), ['Object.groupBy / Map.groupBy']);
  assert.deepEqual(apis('const { promise } = Promise.withResolvers();'), ['Promise.withResolvers']);
  assert.deepEqual(apis('fetch(u, { signal: AbortSignal.timeout(5000) });'), ['AbortSignal.timeout']);
  assert.deepEqual(apis('const s = AbortSignal.any([a, b]);'), ['AbortSignal.any']);
  assert.deepEqual(apis('const xs = await Array.fromAsync(it);'), ['Array.fromAsync']);
  // Die aelteren Nachbarn bleiben erlaubt.
  assert.deepEqual(apis([
    'const i = parts.findIndex((p) => p);',
    'const d = new Date(at); const v = row.attr; const c = item.atTop;',
    'list.sort(); list.reverse(); list.splice(1, 1); list.toString();',
    'const ids = crypto.getRandomValues(new Uint8Array(4));',
    'new AbortController().signal;',
    'Array.from(xs);',
  ].join('\n')), []);
});

test('jeder Eintrag der Start-Verbotsliste ist neuer als die dokumentierte Mindestversion', () => {
  const stale = STARTUP_FORBIDDEN.filter((rule) => !aboveFloor(rule.since));
  assert.deepEqual(stale.map((rule) => `${rule.api} (${describeSince(rule.since)})`), [],
    `Die Mindestversion (${describeSince(FLOOR)}) kann diese APIs schon - der Eintrag verbietet nichts mehr `
    + 'und gehoert gestrichen');
});

function startupSources() {
  const { files, unresolved } = startupFiles();
  const sources = [...files].map(([path, via]) => ({
    path,
    via,
    source: readFileSync(new URL(path.replace(/^\//, ''), PUBLIC), 'utf8'),
  }));
  return { files, unresolved, sources };
}

test('der Startpfad ruft keine API, die neuer ist als die Mindestversion (#1276, #1369)', () => {
  const { files, unresolved, sources } = startupSources();
  assert.deepEqual(unresolved, [], 'Der Startpfad liess sich nicht vollstaendig aufloesen');
  // Reichweiten-Nachweis an den Dateien, um die es geht: der Router, der den
  // Start fuehrt, und i18n.js, in dem der Fehler von #1276 stand.
  for (const must of ['/router.js', '/i18n.js', '/api.js', '/theme-init.js', '/lang-init.js']) {
    assert.ok(files.has(must), `Reichweiten-Nachweis: ${must} fehlt im Startpfad - greift der Leser noch?`);
  }

  const offenders = [];
  const matchedExceptions = new Set();
  for (const { path, via, source } of sources) {
    for (const hit of forbiddenCalls(source)) {
      const exception = STARTUP_EXCEPTIONS.find((ex) => ex.path === path && ex.api === hit.rule.api
        && hit.line === ex.line);
      if (exception) { matchedExceptions.add(exception); continue; }
      offenders.push(`${path}:${hit.number} (geladen von ${via}): ${hit.line}\n    ${hit.rule.api} erst ab `
        + `${describeSince(hit.rule.since)} - stattdessen ${hit.rule.instead}`);
    }
  }
  assert.deepEqual(offenders, [],
    `Diese Stellen laufen vor dem ersten Bild. Die dokumentierte Mindestversion (${describeSince(FLOOR)}) `
    + 'kennt die API nicht, wirft dort und zeigt nur die Fehlerseite des Routers:\n' + offenders.join('\n'));

  const stale = STARTUP_EXCEPTIONS.filter((ex) => !matchedExceptions.has(ex));
  assert.deepEqual(stale.map((ex) => `${ex.path}: ${ex.api}`), [],
    'Diese Ausnahme trifft keinen Aufruf mehr - aus STARTUP_EXCEPTIONS streichen');
});

test('die Ausnahmen des Startpfads haben ihren Anlass noch', () => {
  const { sources } = startupSources();
  const lapsed = STARTUP_EXCEPTIONS.filter((ex) => !ex.stillValid(sources));
  assert.deepEqual(lapsed.map((ex) => `${ex.path}: ${ex.api} - ${ex.reason}`), [],
    'Der Grund dieser Ausnahme besteht nicht mehr: der Aufruf laeuft jetzt beim Start. Die API ersetzen '
    + 'und die Ausnahme streichen');
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

test('formatUnit() laeuft ohne findLastIndex - als Programm, nicht nur als Text', () => {
  // Nicht im Startpfad, aber an der Mindestversion (Chrome 87) auf dem Schirm:
  // die Leseansicht eines Geburtstags mit eigener Erinnerungsfrist und die
  // Fastendauern. findLastIndex kennt Chrome erst ab 97; dort warf der Aufruf,
  // und die Angabe fehlte. Erwartet wird dasselbe Ergebnis wie mit der API.
  const cases = [[2, 'day'], [1, 'week'], [1.5, 'hour'], [-3, 'minute'], [1234.5, 'hour']];
  const format = () => cases.flatMap(([value, unit]) => ['short', 'long']
    .map((unitDisplay) => formatUnit(value, unit, { unitDisplay })));
  const expected = format();
  const saved = Object.getOwnPropertyDescriptor(Array.prototype, 'findLastIndex');
  delete Array.prototype.findLastIndex;
  let results;
  try {
    results = format();
  } finally {
    if (saved) Object.defineProperty(Array.prototype, 'findLastIndex', saved);
  }
  assert.deepEqual(results, expected);
});

/* ──────────────────────────────────────────────────────────────────────────
 * Teil 3: Syntax in jedem Modul der App (#1369)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Syntax, die neuer ist als die Mindestversion. Anders als eine fehlende API
 * wirft sie nicht erst beim Aufruf: der Browser verwirft die GANZE Datei beim
 * Laden. Im Startpfad heisst das keine App, in einer Seite kein Bildschirm -
 * deshalb gilt diese Liste fuer jedes Modul, nicht nur fuer den Start.
 *
 * Erhoben wurde die Syntax aller Module mit einem echten Parser (acorn,
 * ecmaVersion-Leiter, #1369): das Neueste in der App ist `||=`/`??=`
 * (Firefox 79) und ein statisches Klassenfeld (Safari 14.1), beides genau an
 * der Mindestversion. Private Klassenglieder, statische Initialisierungsbloecke
 * und Lookbehind stehen nur im vendorten PDF.js. Die Muster hier sind Text und
 * damit eine Naeherung: sie treffen die Schreibweise, mit der die Konstrukte
 * tatsaechlich benutzt werden (`this.#x`, `static {`, `(?<=`).
 */
const MODULE_SYNTAX_FORBIDDEN = [
  {
    syntax: 'private Klassenglieder (#feld, #methode(), #x in obj)',
    since: { chrome: '74', firefox: '90', safari: '14.1' },
    patterns: [/\.\s*#[A-Za-z_$]/, /#[A-Za-z_$][\w$]*\s+in\s/],
  },
  {
    syntax: 'statischer Initialisierungsblock (static { ... })',
    since: { chrome: '94', firefox: '93', safari: '16.4' },
    patterns: [/\bstatic\s*\{/],
  },
  {
    syntax: 'Lookbehind im regulaeren Ausdruck ((?<= ...) / (?<! ...))',
    since: { chrome: '62', firefox: '78', safari: '16.4' },
    patterns: [/\(\?<[=!]/],
  },
];

function syntaxHits(source) {
  const hits = [];
  for (const { line, number } of codeLines(source)) {
    for (const rule of MODULE_SYNTAX_FORBIDDEN) {
      if (rule.patterns.some((pattern) => pattern.test(line))) hits.push({ rule, number, line: line.trim() });
    }
  }
  return hits;
}

// Jedes Skript der App: Module, klassische Skripte und der Service Worker.
// Vendor-Code ist fremd und steht fuer sich (PDF.js braucht mehr, das steht in
// docs/installation.md); lucide.min.js ebenso.
function appScripts() {
  return readdirSync(PUBLIC, { recursive: true })
    .map((entry) => String(entry).split('\\').join('/'))
    .filter((entry) => /\.m?js$/.test(entry) && !entry.startsWith('vendor/') && entry !== 'lucide.min.js')
    .sort()
    .map((entry) => `public/${entry}`);
}

test('Leser: erkennt neuere Syntax, nicht ihre Doppelgaenger in Strings (erfundene Faelle)', () => {
  const kinds = (source) => syntaxHits(source).map((hit) => hit.rule.syntax.split(' ')[0]);
  assert.deepEqual(kinds('class A { #n = 0; get n() { return this.#n; } }'), ['private']);
  assert.deepEqual(kinds('if (#brand in obj) {}'), ['private']);
  assert.deepEqual(kinds('class A { static { init(); } }'), ['statischer']);
  assert.deepEqual(kinds('const re = /(?<=\\$)\\d+/;'), ['Lookbehind']);
  assert.deepEqual(kinds("const re = new RegExp('(?<!a)b');"), ['Lookbehind']);
  // Erlaubt: Hex-Farben, Anker, IDs, statische Felder und Methoden, benannte Gruppen.
  assert.deepEqual(kinds([
    "el.style.color = '#fff'; const sel = '#main-content'; location.hash = '#top';",
    'const css = `.x { color: #1a1a18; }`;',
    'class B { static formAssociated = true; static get observedAttributes() { return []; } }',
    'const m = /(?<year>\\d{4})-(?:\\d\\d)/.exec(s);',
    '// this.#privat im Kommentar',
  ].join('\n')), []);
});

test('jeder Eintrag der Syntax-Verbotsliste ist neuer als die dokumentierte Mindestversion', () => {
  const stale = MODULE_SYNTAX_FORBIDDEN.filter((rule) => !aboveFloor(rule.since));
  assert.deepEqual(stale.map((rule) => `${rule.syntax} (${describeSince(rule.since)})`), [],
    `Die Mindestversion (${describeSince(FLOOR)}) versteht diese Syntax schon - der Eintrag gehoert gestrichen`);
});

test('kein Modul der App traegt Syntax, die neuer ist als die Mindestversion (#1369)', () => {
  const files = appScripts();
  // Reichweiten-Nachweis: Start, Seiten, Einstellungen und der Service Worker.
  for (const must of ['public/router.js', 'public/pages/calendar.js', 'public/settings/shell.js', 'public/sw.js']) {
    assert.ok(files.includes(must), `Reichweiten-Nachweis: ${must} fehlt in der Dateiliste`);
  }
  assert.ok(files.length >= 150, `Reichweiten-Nachweis: nur ${files.length} Skripte gefunden`);

  const offenders = [];
  for (const file of files) {
    for (const hit of syntaxHits(read(file))) {
      offenders.push(`${file}:${hit.number}: ${hit.line}\n    ${hit.rule.syntax} erst ab ${describeSince(hit.rule.since)}`);
    }
  }
  assert.deepEqual(offenders, [],
    `Ein Browser an der Mindestversion (${describeSince(FLOOR)}) verwirft die ganze Datei beim Laden - `
    + 'im Startpfad die App, sonst den Bildschirm:\n' + offenders.join('\n'));
});

/* ──────────────────────────────────────────────────────────────────────────
 * Teil 4: Konstrukte, die einen ganzen CSS-Block kosten (#1369)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Eine unbekannte Eigenschaft kostet eine Zeile; diese Konstrukte kosten einen
 * ganzen Block, und darin kann die Hoehe der Shell, die Lage der Navigation
 * oder ein Dialog stehen. Heute nutzt kein Stylesheet der App eines davon.
 *   - `@layer` / `@scope`: der Block faellt weg, samt allem darin;
 *   - Nesting: die verschachtelte Regel faellt weg;
 *   - Bereichssyntax in `@media` (`width >= 768px`): die Bedingung ist
 *     ungueltig, der Block greift nie - die responsive Regel ist weg.
 * `@container` gehoert NICHT hierher: Container-Abfragen sind eine bewusste
 * Verfeinerung oberhalb der Mindestversion (docs/installation.md).
 */
const CSS_BLOCK_DROPPERS = [
  { construct: '@layer', since: { chrome: '99', firefox: '97', safari: '15.4' } },
  { construct: '@scope', since: { chrome: '118', firefox: '146', safari: '26.4' } },
  { construct: 'CSS-Nesting', since: { chrome: '120', firefox: '117', safari: '17.2' } },
  { construct: 'Bereichssyntax in @media', since: { chrome: '104', firefox: '102', safari: '16.4' } },
];
const dropper = (name) => CSS_BLOCK_DROPPERS.find((d) => d.construct === name);

// Ein Medienmerkmal in Klammern, das <, > oder = traegt und keinen Doppelpunkt:
// `(width >= 768px)`, `(400px < width < 800px)`, nicht `(min-width: 768px)`.
const RANGE_FEATURE = /\([^():]*[<>=][^():]*\)/;

function blockDropperFindings(css) {
  const findings = [];
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of plain.matchAll(/@(layer|scope)\b/gi)) {
    findings.push({ construct: `@${match[1].toLowerCase()}`, where: plain.slice(match.index, match.index + 60).split('\n')[0] });
  }
  for (const { selector, body, at } of eachRule(css)) {
    // eachRule() steigt in @media/@supports/@container ab; was sonst einen
    // Block im Rumpf traegt, ist eine verschachtelte Regel. At-Regeln mit
    // eigenem Rumpf (@starting-style, @font-face) sind kein Nesting.
    if (!selector.startsWith('@') && body.includes('{')) {
      findings.push({ construct: 'CSS-Nesting', where: selector });
    }
    for (const preamble of at) {
      if (/^@media\b/i.test(preamble) && RANGE_FEATURE.test(preamble)) {
        findings.push({ construct: 'Bereichssyntax in @media', where: preamble });
      }
    }
  }
  // Dieselbe @media-Praeambel steht vor jeder ihrer Regeln - einmal reicht.
  return findings.filter((f, i) => findings.findIndex((g) => g.construct === f.construct && g.where === f.where) === i);
}

test('Leser: erkennt die Block-Konstrukte, nicht ihre harmlosen Nachbarn (erfundene Faelle)', () => {
  const kinds = (css) => blockDropperFindings(css).map((f) => f.construct);
  assert.deepEqual(kinds('@layer base { .a { color: red } }'), ['@layer']);
  assert.deepEqual(kinds('@layer base, theme;'), ['@layer']);
  assert.deepEqual(kinds('@scope (.card) { img { border: 0 } }'), ['@scope']);
  assert.deepEqual(kinds('.a { color: red; .b { color: blue } }'), ['CSS-Nesting']);
  assert.deepEqual(kinds('.a { &:hover { color: blue } }'), ['CSS-Nesting']);
  assert.deepEqual(kinds('@media (width >= 768px) { .a { display: flex } .b { gap: 0 } }'), ['Bereichssyntax in @media']);
  assert.deepEqual(kinds('@media (400px < width < 800px) { .a { display: flex } }'), ['Bereichssyntax in @media']);
  // Erlaubt: klassische Media-Merkmale, @supports und @container, @starting-style,
  // @keyframes, ein Kommentar ueber @layer.
  assert.deepEqual(kinds([
    '/* frueher @layer base */',
    '@media (min-width: 768px) and (max-height: 499px) { .a { display: flex } }',
    '@supports (height: 100dvh) { :root { --h: 100dvh } }',
    '@container (min-width: 560px) { .a { display: grid } }',
    '@starting-style { .p:popover-open { opacity: 0 } }',
    '@keyframes k { from { opacity: 0 } to { opacity: 1 } }',
    '.a[data-x="a=b"] { color: red }',
  ].join('\n')), []);
});

test('jeder Eintrag der Block-Verbotsliste ist neuer als die dokumentierte Mindestversion', () => {
  const stale = CSS_BLOCK_DROPPERS.filter((d) => !aboveFloor(d.since));
  assert.deepEqual(stale.map((d) => `${d.construct} (${describeSince(d.since)})`), [],
    `Die Mindestversion (${describeSince(FLOOR)}) versteht dieses Konstrukt schon - der Eintrag gehoert gestrichen`);
});

test('kein Stylesheet nutzt ein Konstrukt, das an der Mindestversion einen ganzen Block kostet (#1369)', () => {
  const files = appStylesheets();
  const offenders = [];
  for (const file of files) {
    for (const finding of blockDropperFindings(read(file))) {
      offenders.push(`${file}: ${finding.where}\n    ${finding.construct} erst ab ${describeSince(dropper(finding.construct).since)}`);
    }
  }
  assert.ok(files.length >= 40, `Reichweiten-Nachweis: nur ${files.length} Stylesheets gefunden`);
  assert.deepEqual(offenders, [],
    `Ein Browser an der Mindestversion (${describeSince(FLOOR)}) verwirft hier einen ganzen Block. `
    + 'Die Regel ohne das Konstrukt schreiben (klassische min-/max-width-Merkmale, Selektoren '
    + 'ausschreiben):\n' + offenders.join('\n'));
});

// DIE PILLE DER MOBILEN KAPSEL (R20, Review): sie verschiebt das aktive Ziel
// mit `translate` (Chromium 104) und schneidet mit `overflow: clip` (90). Unter
// der Mindestversion (Chrome 87, der Chromebook aus #1276 bei 91) schrumpfte
// die Kapsel ohne den Versatz, und die Pille stuende leer. Jede Regel, die die
// Pille baut, steht deshalb in `@supports (translate: 0)`; ohne die Eigenschaft
// minimiert die Kapsel wie in R19.
test('die Pille der Kapsel steht nur dort, wo translate gilt', () => {
  const pillRules = [...eachRule(read('public/styles/layout.css'))].filter(({ selector, body }) => (
    /nav-item--pill/.test(selector)
    || /var\(--nav-(?:pill-width|pill-shift|item-width)/.test(body)
    || (/\.nav-bottom__items/.test(selector) && /overflow:\s*clip/.test(body))
  ));
  assert.ok(pillRules.length >= 4, `Reichweite: nur ${pillRules.length} Regeln der Pille gefunden`);
  const open = pillRules.filter(({ at }) => !at.some((a) => /^@supports \(translate: 0\)/.test(a)))
    .map(({ selector }) => selector);
  assert.deepEqual(open, [], 'Regeln der Pille ohne @supports (translate: 0)');
});

/* ──────────────────────────────────────────────────────────────────────────
 * Teil 5: Popover ohne Popover-API (#2107)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Jedes Popover der App verlaesst sich fuer den geschlossenen Zustand auf das
 * UA-Blatt (`[popover] { display: none }`). Ein Browser ohne die API (Chrome
 * < 114, Firefox < 125, Safari < 17, also zwischen den beiden Zeilen der
 * Doku) hat diese Regel nicht und verwirft jede Autorenregel mit
 * `:popover-open`, auch `.popover-menu:not(:popover-open)`. In einer WebView
 * mit Chrome 106 stand deshalb jedes Menue der Seite offen und fing die Klicks
 * darunter ab. reset.css reicht die UA-Regel in
 * `@supports not selector(:popover-open)` nach.
 *
 * Zwei Zusagen:
 *   1. der Rueckfall steht in einem Stylesheet, das index.html laedt;
 *   2. keine Regel, die in so einem Browser gilt, setzt `display` (ausser
 *      `none`) an einer Klasse, die im Markup ein `popover`-Attribut traegt.
 *      `[popover]` hat die Spezifitaet einer Klasse: eine spaeter geladene
 *      `.x-menu { display: flex }` schluege den Rueckfall still. Erlaubt ist
 *      `display` unter `:popover-open` (die Regel faellt dort weg) und in
 *      `@supports selector(:popover-open)`.
 */
const POPOVER_FALLBACK_AT = /^@supports not selector\(\s*:popover-open\s*\)$/;

// Selektorliste an Kommas ausserhalb von Klammern trennen.
function selectorParts(selector) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const c = selector[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(selector.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(selector.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

// Das Subjekt eines Selektors: der letzte zusammengesetzte Teil hinter dem
// letzten Kombinator. Klammerinhalte zaehlen nicht (`:not(.a .b)`).
function subjectCompound(part) {
  let flat = part;
  while (/\([^()]*\)/.test(flat)) flat = flat.replace(/\([^()]*\)/g, '');
  return flat.trim().split(/\s*[>+~]\s*|\s+/).pop();
}

/**
 * Klassen der Elemente, die ein `popover`-Attribut tragen - aus Markup in
 * Template-Literalen (`class="a b" ... popover`) und aus DOM-Code
 * (`el.className = 'a b'` vor `el.setAttribute('popover', ...)`).
 * `popovertarget` ist kein Popover.
 */
function popoverClasses(source) {
  const classes = new Set();
  const add = (list) => list.split(/\s+/)
    .filter((name) => /^[\w-]+$/.test(name))
    .forEach((name) => classes.add(name));
  for (const tag of source.matchAll(/<[a-z][\w-]*\s([^<>]*)>/gi)) {
    const attrs = tag[1];
    if (!/(?:^|\s)popover(?![\w-])/.test(attrs)) continue;
    const cls = attrs.match(/(?:^|\s)class="([^"]*)"/);
    if (cls) add(cls[1]);
  }
  for (const call of source.matchAll(/\b(\w+)\.setAttribute\(\s*['"]popover['"]/g)) {
    const before = source.slice(Math.max(0, call.index - 800), call.index);
    const assignments = [...before.matchAll(new RegExp(`\\b${call[1]}\\.className\\s*=\\s*(['"\`])([^'"\`]*)\\1`, 'g'))];
    if (assignments.length) add(assignments.at(-1)[2]);
  }
  return classes;
}

function popoverDisplayFindings(css, classes) {
  const findings = [];
  for (const { selector, body, at } of eachRule(css)) {
    if (at.some((a) => /^@supports selector\(\s*:popover-open\s*\)$/.test(a))) continue;
    const display = declarations(body).filter((d) => d.property === 'display' && !/^none\b/i.test(d.value));
    if (!display.length) continue;
    for (const part of selectorParts(selector)) {
      if (part.includes(':popover-open')) continue;
      const subject = subjectCompound(part);
      const hit = [...classes].find((name) => new RegExp(`\\.${name}(?![\\w-])`).test(subject));
      if (hit) findings.push({ selector: part, className: hit, value: display.at(-1).value });
    }
  }
  return findings;
}

const hasPopoverFallback = (css) => [...eachRule(css)].some(({ selector, body, at }) => (
  selector === '[popover]'
  && at.length === 1 && POPOVER_FALLBACK_AT.test(at[0])
  && declarations(body).some((d) => d.property === 'display' && /^none$/i.test(d.value))
));

test('Leser: Popover-Klassen aus Markup und DOM-Code, nicht aus popovertarget (erfundene Faelle)', () => {
  const names = (source) => [...popoverClasses(source)].sort();
  assert.deepEqual(names('<div class="popover-menu x-menu" id="${esc(id)}" popover role="menu">'), ['popover-menu', 'x-menu']);
  assert.deepEqual(names('<span class="tip" role="tooltip" popover="manual" hidden>'), ['tip']);
  assert.deepEqual(names('<button class="trigger" popovertarget="m">'), []);
  assert.deepEqual(names([
    "const menu = document.createElement('div');",
    "menu.className = 'ctx-menu';",
    "menu.setAttribute('role', 'menu');",
    "menu.setAttribute('popover', 'auto');",
    "button.className = 'not-a-popover';",
    "button.setAttribute('popovertarget', 'x');",
  ].join('\n')), ['ctx-menu']);
});

test('Leser: display an einer Popover-Klasse schlaegt den Rueckfall, unter :popover-open nicht (erfundene Faelle)', () => {
  const classes = new Set(['popover-menu', 'x-menu']);
  const hits = (css) => popoverDisplayFindings(css, classes).map((f) => f.selector);
  assert.deepEqual(hits('.popover-menu { display: flex }'), ['.popover-menu']);
  assert.deepEqual(hits('.page .x-menu, .other { display: grid }'), ['.page .x-menu']);
  assert.deepEqual(hits('@media (min-width: 768px) { .x-menu.is-wide { display: block } }'), ['.x-menu.is-wide']);
  assert.deepEqual(hits([
    '.popover-menu:popover-open { display: flex }',
    '.popover-menu:not(:popover-open) { display: block }',
    '.popover-menu { display: none }',
    '.popover-menu__item { display: flex }',
    '.popover-menu .row { display: flex }',
    '@supports selector(:popover-open) { .x-menu { display: flex } }',
    '.popover-menu { position: fixed }',
  ].join('\n')), []);
  assert.equal(hasPopoverFallback('@supports not selector(:popover-open) { [popover] { display: none; } }'), true);
  assert.equal(hasPopoverFallback('[popover] { display: none; }'), false);
  assert.equal(hasPopoverFallback('@supports selector(:popover-open) { [popover] { display: none; } }'), false);
  assert.equal(hasPopoverFallback('@supports not selector(:popover-open) { [popover] { opacity: 0; } }'), false);
});

test('ohne Popover-API bleibt jedes Popover zu: der Rueckfall steht im Basis-Blatt (#2107)', () => {
  const linked = [...read('public/index.html').matchAll(/<link\s[^>]*rel="stylesheet"[^>]*href="\/([^"]+\.css)"/g)]
    .map((m) => `public/${m[1]}`);
  const carriers = linked.filter((file) => hasPopoverFallback(read(file)));
  assert.ok(linked.length >= 5, `Reichweite: nur ${linked.length} Stylesheets in index.html gefunden`);
  assert.deepEqual(carriers, ['public/styles/reset.css'],
    'Genau ein von index.html geladenes Stylesheet traegt `@supports not selector(:popover-open) '
    + '{ [popover] { display: none } }` - sonst steht in einem Browser ohne Popover-API jedes Menue offen');
});

test('keine Regel setzt display an einem Popover ausserhalb von :popover-open (#2107)', () => {
  const classes = new Set();
  for (const file of appScripts()) popoverClasses(read(file)).forEach((name) => classes.add(name));
  // Reichweite: die bekannten Popover-Familien muessen gefunden werden, sonst
  // ist der Leser blind und der Test gruen ueber einer leeren Menge.
  for (const known of ['popover-menu', 'nav-sidebar__account-menu', 'documents-context-menu',
    'ydp-popover', 'note-category-overflow-tooltip', 'filter-popover', 'fasting-help__tooltip']) {
    assert.ok(classes.has(known), `Reichweite: Popover-Klasse ${known} nicht gefunden`);
  }
  const offenders = [];
  for (const file of appStylesheets()) {
    for (const f of popoverDisplayFindings(read(file), classes)) {
      offenders.push(`${file}: ${f.selector} { display: ${f.value} } (Popover-Klasse .${f.className})`);
    }
  }
  assert.deepEqual(offenders, [],
    'Diese Regel schlaegt in einem Browser ohne Popover-API den Rueckfall `[popover] { display: none }` '
    + '(reset.css) - das Panel stuende offen. `display` an einem Popover nur unter `:popover-open`:\n'
    + offenders.join('\n'));
});

/* ──────────────────────────────────────────────────────────────────────────
 * (6) Wand-Modus ohne dvh (#2183)
 *
 * Die Wand stand mit `min-height: 100dvh` da. Chrome < 108 verwirft die
 * Zeile, und ein vh-Zwilling ist auf der Wand verboten (test:frontend-audit,
 * Wand-Guard: auf dem Telefon ist 100vh die GROSSE Hoehe). Ergebnis auf einem
 * Wandrahmen mit Android-WebView 106: die Wand war so hoch wie ihr Inhalt, und
 * Datenstand, Kuechentimer und Ausstieg standen mitten im Bild.
 *
 * Die Shell hat die Hoehe schon, mit Rueckfallkette (100vh ->
 * -webkit-fill-available -> 100dvh), und `.page-transition` reicht sie als
 * `height: 100%` durch. Die Wand fuellt diesen Platz ueber `min-height: 100%`
 * an der Seite und Flex darunter - in jedem Browser, ohne Viewport-Einheit.
 * ────────────────────────────────────────────────────────────────────────── */
const wallRule = (css, selector) => [...eachRule(css)]
  .find((r) => !r.at.length && r.selector.replace(/\s+/g, ' ').trim() === selector);
const decl = (rule, property) => (rule ? declarations(rule.body).filter((d) => d.property === property).at(-1)?.value : undefined);

test('die Wand nimmt ihre Hoehe von der Shell, nicht vom Viewport (#2183)', () => {
  const css = read('public/styles/dashboard.css');
  const viewportHeight = /(?<![\w.])(?:\d*\.)?\d+[dsl]?vh\b/i;
  const wallHeights = [...eachRule(css)]
    .filter((r) => /(^|[\s,])\.wall(?![\w-])/.test(r.selector))
    .flatMap((r) => declarations(r.body)
      .filter((d) => /^(min-|max-)?height$/.test(d.property) && viewportHeight.test(d.value))
      .map((d) => `${r.selector.trim()} { ${d.text} }`));
  assert.deepEqual(wallHeights, [],
    'Die Wand-Flaeche haengt ihre Hoehe an eine Viewport-Einheit - ohne dvh (Chrome < 108) ist sie '
    + 'dann so hoch wie ihr Inhalt und der Fuss steht mitten im Bild:\n' + wallHeights.join('\n'));

  // Die Kette von der Shell bis zur Flaeche, Glied fuer Glied.
  assert.equal(decl(wallRule(read('public/styles/layout.css'), '.page-transition'), 'height'), '100%',
    '.page-transition reicht die Hoehe der Shell nicht mehr durch - min-height: 100% darunter griffe ins Leere');
  const page = wallRule(css, '.dashboard--wall');
  assert.equal(decl(page, 'min-height'), '100%', '.dashboard--wall fuellt die Hoehe der Shell nicht');
  const shell = wallRule(css, '.dashboard--wall .dashboard-shell');
  assert.equal(decl(shell, 'display'), 'flex', 'die Shell der Wand reicht die Hoehe nicht weiter (display: flex)');
  assert.equal(decl(shell, 'flex-direction'), 'column');
  assert.match(decl(shell, 'flex') || '', /^1\b/, 'die Shell der Wand waechst nicht in die Seite (flex: 1 ...)');
  assert.match(decl(wallRule(css, '.wall'), 'flex') || '', /^1\b/, 'die Wand-Flaeche waechst nicht in die Shell (flex: 1 ...)');
});

/* ──────────────────────────────────────────────────────────────────────────
 * (7) color-mix() ohne Unterstuetzung (#2184; Entscheidung 25.10.2026:
 *     gezielte Rueckfaelle)
 *
 * Chrome < 111, Firefox < 113, Safari < 16.2 kennen color-mix() nicht. Fast
 * jede Stelle traegt ein var(): die Deklaration gilt beim Parsen als gueltig,
 * gewinnt die Kaskade und faellt erst beim Berechnen auf ihren Anfangswert -
 * eine Flaeche wird durchsichtig, ein `border` verschwindet ganz. Ein Zwilling
 * davor (das dvh-Muster) wirkt deshalb nicht.
 *
 * Die meisten der rund 270 Stellen kosten dort nur Tonung, und das ist die
 * Zusage der Zeile "Starts, every screen opens, scrolls" in
 * docs/installation.md. Einen Rueckfall bekommt nur, was INFORMATION verliert:
 * Schrift, die ohne ihre Flaeche unlesbar wird (weiss auf durchsichtig), eine
 * Auswahl, die nur an der Tonung hing, eine Flaeche, die Inhalt verdecken muss,
 * eine vom Nutzer gewaehlte Farbe ohne andere Spur, eine leere Checkbox ohne
 * Rand. Alle Rueckfaelle stehen in EINEM Block in reset.css (neben dem
 * Popover-Rueckfall, im zweiten Blatt nach den Tokens) und nehmen nur
 * Token-Werte. Sie muessen die color-mix-Regeln der spaeter geladenen Blaetter
 * schlagen, also hoehere Spezifitaet (`:root ` davor).
 *
 * Bewusst ohne Rueckfall (Spur bleibt): Kalendertermine (farbige Kante),
 * Segment-Steuerungen und Unter-Reiter (eigene Flaeche + Schatten), Auswahl
 * mit Modulkante (Gesundheit, Widget-Groesse), Dialog-Hintergruende (der Dialog
 * hat seine eigene Flaeche), Skelette, Glyphen-Schimmer, Hover/Fokus/Drag.
 * ────────────────────────────────────────────────────────────────────────── */
const COLOR_MIX_FALLBACK_AT = /^@supports not \(color: color-mix\(in srgb, red, red\)\)$/;

/**
 * Was einen Rueckfall braucht. `selector` ist ein Teil der Quell-Selektorliste,
 * wortgleich; `property` die Eigenschaft der color-mix-Zeile dort. Bedingungen
 * aus `@media`/`@container` der Quelle muss der Rueckfall wiederholen.
 */
const COLOR_MIX_FALLBACKS = [
  // Schrift auf einer Fuellung: ohne sie unlesbar. (Der Primaerknopf fuellt sich
  // aus einem Token, eigener Test unten.)
  { file: 'public/styles/glass.css', selector: '.page-fab:not(.page-fab--docked)', property: 'background-color',
    why: 'das weisse Plus des Schnellknopfs auf durchsichtiger Flaeche' },
  { file: 'public/styles/glass.css', selector: '.toast:not(.toast--danger):not(.toast--warning)', property: 'background-color',
    why: 'Meldungstext (helle Schrift) ohne Grund ueber der Seite' },
  { file: 'public/styles/glass.css', selector: '.list-bulkbar', property: 'background-color',
    why: 'Sammelaktionen, dieselbe Glasregel wie die Meldung' },
  { file: 'public/styles/calendar.css', selector: '.month-day__holiday', property: 'background',
    why: 'Feiertagsname in --holi-ink (weiss) auf durchsichtiger Flaeche' },
  { file: 'public/styles/calendar.css', selector: '.allday-holiday', property: 'background',
    why: 'wie oben, Ganztagszeile der Woche und des Tags' },
  { file: 'public/styles/documents.css', selector: '.dms-result__open', property: 'background',
    why: 'Oeffnen-Zeichen in Flaechenfarbe auf dem Vorschaubild' },
  { file: 'public/styles/documents.css', selector: '.document-viewer__pdf-indicator', property: 'background',
    why: 'Seitenzahl ueber dem PDF ohne eigenen Grund' },
  // Flaechen, die Inhalt verdecken muessen.
  { file: 'public/styles/layout.css', selector: '.search-overlay', property: 'background-color',
    why: 'Suchergebnisse ueber der durchscheinenden Seite' },
  { file: 'public/styles/layout.css', selector: '.search-overlay', property: 'background-color',
    media: '@media (min-width: 768px)', why: 'am Desktop die Abblendung hinter dem Suchfeld' },
  // Auswahl, die nur an der Tonung hing.
  { file: 'public/styles/layout.css', selector: '.search-result[aria-selected="true"]', property: 'background-color',
    why: 'der Treffer, den Enter oeffnet' },
  { file: 'public/styles/layout.css', selector: '.split-view [data-md-id].is-selected', property: 'background-color',
    media: '@container module-surface (min-width: 65rem)', why: 'die Zeile, deren Detail daneben steht' },
  { file: 'public/styles/tasks.css', selector: '.tasks-page .task-card--selected > .task-card__main', property: 'background-color',
    why: 'die Aufgabe, deren Detail daneben steht' },
  { file: 'public/styles/contacts.css', selector: '.contact-item--selected', property: 'background-color',
    why: 'der gewaehlte Kontakt' },
  { file: 'public/styles/documents.css', selector: '.document-row.is-selected', property: 'background-color',
    why: 'das gewaehlte Dokument' },
  { file: 'public/styles/split-expenses.css', selector: '.split-group--active', property: 'background',
    why: 'die gewaehlte Gruppe' },
  { file: 'public/styles/budget.css', selector: '.budget-bar-row.is-category-selected', property: 'background',
    why: 'die Kategorie, nach der die Liste filtert' },
  { file: 'public/styles/filter-chip.css', selector: '.filter-chip--active', property: 'background-color',
    why: 'der aktive Filter - Flaeche, Kante und Schrift hingen alle an color-mix()' },
  { file: 'public/styles/documents.css', selector: '.documents-folder-chip[data-folder-active]', property: 'background-color',
    media: '@media (max-width: 1023px)', why: 'der offene Ordner als Chip' },
  { file: 'public/styles/documents.css', selector: '.documents-folder-chip[data-category-active]', property: 'background-color',
    media: '@media (max-width: 767px)', why: 'die gewaehlte Kategorie als Chip' },
  // Vom Nutzer gewaehlte Farbe ohne andere Spur.
  { file: 'public/styles/notes.css', selector: '.note-card', property: 'background',
    why: 'die Farbe der Notiz' },
  { file: 'public/styles/glass.css', selector: '.dashboard .note-item', property: 'background-color',
    why: 'die Farbe der Notiz auf der Uebersicht' },
  { file: 'public/styles/schedule.css', selector: '.schedule-overview__block', property: 'background',
    why: 'die Farbe der Schichtart - der Block hat keine Kante' },
  // Leerer Zustand ohne Rand.
  { file: 'public/styles/typography.css', selector: '.note-md-box', property: 'border',
    why: 'die offene Checkbox einer Notiz-Checkliste - `border` faellt ganz weg' },
];

// Spezifitaet (a, b, c) eines einzelnen Selektors. Reicht fuer die Formen der
// App: :not()/:is()/:has() zaehlen ihr Argument, :where() nichts.
function specificity(selector) {
  let s = selector;
  let a = 0; let b = 0; let c = 0;
  const add = ([x, y, z]) => { a += x; b += y; c += z; };
  for (;;) {
    const m = s.match(/:(not|is|has|where)\(([^()]*)\)/);
    if (!m) break;
    if (m[1] !== 'where') {
      const inner = selectorParts(m[2]).map(specificity)
        .sort((p, q) => (q[0] - p[0]) || (q[1] - p[1]) || (q[2] - p[2]))[0] || [0, 0, 0];
      add(inner);
    }
    s = s.replace(m[0], ' ');
  }
  s = s.replace(/"[^"]*"|'[^']*'/g, '');
  a += (s.match(/#[\w-]+/g) || []).length;
  b += (s.match(/\.[\w-]+/g) || []).length + (s.match(/\[[^\]]*\]/g) || []).length
    + (s.match(/(?<!:):(?!:)[\w-]+/g) || []).length;
  c += (s.match(/::[\w-]+/g) || []).length
    + (s.replace(/\[[^\]]*\]/g, '').match(/(?:^|[\s>+~(])([a-z][\w-]*)/gi) || []).length;
  return [a, b, c];
}
const higher = (p, q) => p[0] !== q[0] ? p[0] > q[0] : p[1] !== q[1] ? p[1] > q[1] : p[2] > q[2];
const family = (property) => (/^background(-color)?$/.test(property) ? 'background'
  : /^border(-color)?$/.test(property) ? 'border' : property);
const conditions = (at) => at.filter((a) => /^@(media|container)\b/.test(a)).map(norm);

/** Die Rueckfall-Regeln eines Blatts: nur im color-mix-@supports. */
function colorMixFallbackRules(css) {
  return [...eachRule(css)].filter(({ at }) => at.length
    && COLOR_MIX_FALLBACK_AT.test(at[0].replace(/\s+/g, ' ').trim()));
}

/** Wirkt ein Rueckfall fuer diesen Eintrag? Liefert den Grund, wenn nicht. */
function fallbackProblem(entry, fallbackRules) {
  const want = entry.media ? [norm(entry.media)] : [];
  const candidates = fallbackRules.filter((r) => JSON.stringify(conditions(r.at)) === JSON.stringify(want));
  for (const rule of candidates) {
    const part = selectorParts(rule.selector).find((p) => p.replace(/^:root\s+/, '') === entry.selector);
    if (!part) continue;
    const ds = declarations(rule.body).filter((d) => family(d.property) === family(entry.property));
    if (!ds.length) return `${part}: setzt ${entry.property} nicht`;
    if (ds.some((d) => /color-mix\(/i.test(d.value))) return `${part}: der Rueckfall nimmt selbst color-mix()`;
    if (!higher(specificity(part), specificity(entry.selector))) {
      return `${part}: Spezifitaet (${specificity(part).join(",")}) schlaegt ${entry.selector} (${specificity(entry.selector).join(",")}) nicht`;
    }
    return null;
  }
  return 'kein Rueckfall' + (entry.media ? ` unter ${entry.media}` : '');
}

test('Leser: Spezifitaet und color-mix-Rueckfaelle (erfundene Faelle)', () => {
  assert.deepEqual(specificity('.a'), [0, 1, 0]);
  assert.deepEqual(specificity(':root .a'), [0, 2, 0]);
  assert.deepEqual(specificity('.a:not(.b):not(.c)'), [0, 3, 0]);
  assert.deepEqual(specificity('.a [data-x].b'), [0, 3, 0]);
  assert.deepEqual(specificity('.a > .b::before'), [0, 2, 1]);
  assert.deepEqual(specificity('dialog.a::backdrop'), [0, 1, 2]);
  assert.deepEqual(specificity('.a:where(.b, .c)'), [0, 1, 0]);
  assert.deepEqual(specificity('.a[aria-selected="true"]'), [0, 2, 0]);

  const entry = { selector: '.a', property: 'background-color' };
  const rules = (css) => colorMixFallbackRules(css);
  const at = '@supports not (color: color-mix(in srgb, red, red))';
  assert.equal(fallbackProblem(entry, rules(`${at} { :root .a { background-color: var(--x); } }`)), null);
  assert.equal(fallbackProblem(entry, rules(`${at} { :root .z, :root .a { background: var(--x); } }`)), null,
    'background und background-color sind dieselbe Familie, Selektorlisten zaehlen');
  assert.match(fallbackProblem(entry, rules(`${at} { .a { background-color: var(--x); } }`)), /Spezifitaet/);
  assert.match(fallbackProblem(entry, rules(`${at} { :root .a { color: red; } }`)), /setzt background-color nicht/);
  assert.match(fallbackProblem(entry, rules(`${at} { :root .a { background-color: color-mix(in srgb, red, blue); } }`)), /selbst color-mix/);
  assert.match(fallbackProblem(entry, rules(':root .a { background-color: var(--x); }')), /kein Rueckfall/);
  assert.match(fallbackProblem(entry, rules(`@supports (color: color-mix(in srgb, red, red)) { :root .a { background-color: var(--x); } }`)), /kein Rueckfall/);
  const media = { ...entry, media: '@media (min-width: 768px)' };
  assert.match(fallbackProblem(media, rules(`${at} { :root .a { background-color: var(--x); } }`)), /unter @media/);
  assert.equal(fallbackProblem(media, rules(`${at} { @media (min-width: 768px) { :root .a { background-color: var(--x); } } }`)), null);
});

test('ohne color-mix() bleibt lesbar, was nur an der Tonung hing: die Rueckfaelle stehen im Basis-Blatt (#2184)', () => {
  const linked = [...read('public/index.html').matchAll(/<link\s[^>]*rel="stylesheet"[^>]*href="\/([^"]+\.css)"/g)]
    .map((m) => `public/${m[1]}`);
  const carriers = linked.filter((file) => colorMixFallbackRules(read(file)).length);
  assert.deepEqual(carriers, ['public/styles/reset.css'],
    'Genau ein von index.html geladenes Blatt traegt die color-mix-Rueckfaelle '
    + '(`@supports not (color: color-mix(in srgb, red, red))`) - verstreut verliert man den Ueberblick');
  // Und nirgends sonst: ein Modulblatt laedt spaeter und fiele aus der Liste.
  const elsewhere = appStylesheets().filter((file) => file !== 'public/styles/reset.css'
    && colorMixFallbackRules(read(file)).length);
  assert.deepEqual(elsewhere, [], 'color-mix-Rueckfaelle ausserhalb von reset.css');

  const fallbackRules = colorMixFallbackRules(read('public/styles/reset.css'));
  const problems = [];
  for (const entry of COLOR_MIX_FALLBACKS) {
    // Die Quelle besteht noch: sonst ist der Eintrag ueberfluessig.
    const source = [...eachRule(read(entry.file))].find((r) => selectorParts(r.selector).includes(entry.selector)
      && JSON.stringify(conditions(r.at)) === JSON.stringify(entry.media ? [norm(entry.media)] : [])
      && declarations(r.body).some((d) => d.property === entry.property && /color-mix\(/i.test(d.value)));
    if (!source) {
      problems.push(`${entry.file}: ${entry.selector} { ${entry.property}: color-mix(...) } besteht nicht mehr - Eintrag und Rueckfall streichen`);
      continue;
    }
    const problem = fallbackProblem(entry, fallbackRules);
    if (problem) problems.push(`${entry.file}: ${entry.selector}${entry.media ? ` (${entry.media})` : ''} - ${problem} (${entry.why})`);
  }
  assert.ok(COLOR_MIX_FALLBACKS.length >= 20, 'Reichweite: die Liste ist geschrumpft');
  assert.deepEqual(problems, [],
    'In einem Browser ohne color-mix() (Chrome < 111, Safari < 16.2) geht hier Information verloren, '
    + 'und der Rueckfall in reset.css fehlt oder wirkt nicht:\n' + problems.join('\n'));
});

/**
 * Der Sweep fuer neue Stellen: eine Regel, die ihre Schrift fuer eine Fuellung
 * waehlt (die Ink-Token auf Vollton, die Flaechenfarbe als Schrift) und die
 * Fuellung per color-mix() setzt, wird ohne color-mix() unlesbar. Ruhezustand
 * zaehlt; Hover/Fokus/Drag nicht.
 */
const INK_FOR_A_FILL = /var\(--(color-ink-on-vivid|color-text-on-accent|holi-ink|color-surface)\b/;
test('jede Schrift, die eine color-mix-Fuellung braucht, hat einen Rueckfall (#2184)', () => {
  const listed = new Set(COLOR_MIX_FALLBACKS.map((e) => `${e.file}|${e.selector}`));
  const offenders = [];
  let seen = 0;
  for (const file of appStylesheets()) {
    for (const { selector, body } of eachRule(read(file))) {
      if (/^@/.test(selector)) continue;
      const ds = declarations(body.replace(/\/\*[\s\S]*?\*\//g, ''));
      const fill = ds.find((d) => family(d.property) === 'background' && /color-mix\(/i.test(d.value));
      const ink = ds.find((d) => d.property === 'color' && INK_FOR_A_FILL.test(d.value));
      if (!fill || !ink) continue;
      for (const part of selectorParts(selector)) {
        if (/:(hover|focus|focus-visible|focus-within|active)\b|drag|sortable/.test(part)) continue;
        seen += 1;
        if (!listed.has(`${file}|${part}`)) offenders.push(`${file}: ${part} { ${fill.property}: color-mix(...); ${ink.text} }`);
      }
    }
  }
  assert.ok(seen >= 3, `Reichweite: nur ${seen} Schrift-auf-Fuellung-Regeln gefunden - greift der Leser noch?`);
  assert.deepEqual(offenders, [],
    'Ohne color-mix() steht diese Schrift auf einer durchsichtigen Flaeche. Rueckfall in reset.css '
    + 'und Eintrag in COLOR_MIX_FALLBACKS:\n' + offenders.join('\n'));
});

/**
 * Der Primaerknopf ist der wichtigste Fall und laeuft anders: ueber Tokens wie
 * --viewport-height. Ein Rueckfall in reset.css braeuchte fuer den Hover
 * `:root .btn--primary:hover` (0,3,0) und stiege damit ueber die
 * Rueckmelde-Zustaende `button.<zustand>:is(:enabled, :disabled)` (0,2,1,
 * test:frontend-audit, #2180) - ein gruener Erfolgsknopf waere unter dem
 * Zeiger wieder lila. Mit Token gibt es keinen Spezifitaetsstreit.
 */
test('der Primaerknopf fuellt sich aus einem Token: Vollton ohne color-mix(), Abdunklung im @supports (#2184)', () => {
  const tokens = [...eachRule(read('public/styles/tokens.css'))];
  const setters = (name) => tokens.flatMap((r) => declarations(r.body)
    .filter((d) => d.property === name).map((d) => ({ at: r.at.map((a) => a.replace(/\s+/g, ' ').trim()), selector: r.selector.trim(), value: d.value })));
  const plain = { '--btn-primary-fill': 'var(--color-accent)', '--btn-primary-fill-hover': 'var(--color-accent-hover)' };
  for (const [name, value] of Object.entries(plain)) {
    const all = setters(name);
    const base = all.filter((x) => !x.at.length && x.selector === ':root');
    const mixed = all.filter((x) => x.at.length === 1 && x.at[0] === '@supports (color: color-mix(in srgb, red, red))' && x.selector === ':root');
    assert.deepEqual(base.map((x) => x.value), [value],
      `${name}: an :root ohne Bedingung muss der Vollton stehen (${value}) - ohne color-mix() sonst keine Flaeche`);
    assert.equal(mixed.length, 1, `${name}: die Abdunklung gehoert in @supports (color: color-mix(in srgb, red, red))`);
    assert.match(mixed[0].value, /^color-mix\(/);
    assert.equal(all.length, 2, `${name}: weitere Stellen setzen den Token:\n${JSON.stringify(all, null, 1)}`);
  }
  const layout = read('public/styles/layout.css');
  assert.equal(decl(wallRule(layout, '.btn--primary'), 'background-color'), 'var(--btn-primary-fill)');
  assert.equal(decl(wallRule(layout, '.btn--primary:hover'), 'background-color'), 'var(--btn-primary-fill-hover)');
});
