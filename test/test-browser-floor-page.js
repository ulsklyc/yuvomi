/**
 * Modul: Test - die Browser-Untergrenze ist sichtbar (Phase 1a, Abschnitt E)
 * Zweck: Ein Browser unter der Untergrenze (vite.config.ts `build.target`,
 *        Chrome 105 / Firefox 115 / Safari und iOS 15.4) sah bis hierhin eine
 *        leere App: das gebaute Buendel scheitert dort beim Laden, und nichts
 *        sagte, warum. Jetzt fragt eine ES5-Probe im <head> zuerst
 *        (`public/browser-floor.js`: `CSSLayerBlockRule` und `Object.hasOwn`)
 *        und schickt einen zu alten Browser auf die statische Seite
 *        `public/browser-too-old.html`. Diese Suite haelt:
 *   1. die Probe steht in index.html und offline.html VOR jedem anderen Skript,
 *      ist klassisch (kein Modul, kein async/defer) und ES5 - sie laeuft genau
 *      auf dem Browser, der neuere Syntax nicht versteht;
 *   2. die Probe als Programm: fehlt eine der beiden APIs, ersetzt sie die
 *      Adresse durch die Hinweisseite, sonst nicht;
 *   3. die Hinweisseite und offline.html sind statisch (kein Modul, kein
 *      App-Stylesheet), laden nur ES5-Skripte, tragen ihre Texte de und en, und
 *      jeder Text ist der Wert eines Schluessels in de.json bzw. en.json -
 *      die dokumentierte Ausnahme von "UI-Text nur ueber t()" fuer genau diese
 *      zwei Seiten (Ticket 14), an genau diese zwei Seiten gebunden;
 *   4. die Mindestversionen auf der Seite sind die von `build.target`;
 *   5. beide Seiten stehen mit precache auf der Kopierliste;
 *   6. ihre gespiegelten Token-Werte sind die von tokens.css (die Ausnahme
 *      "Werte inline" hat ein Verfallsdatum an beiden Enden: der Anlass - kein
 *      App-Stylesheet - und die Gleichheit der Werte).
 * Ausfuehren: npm run test:browser-floor-page
 * Abhaengigkeiten: keine (liest Quelltexte, fuehrt die Probe in node:vm aus)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { eachRule } from './css-rules.js';
import { withoutCommentsKeepingLines, withoutHtmlComments } from './source-text.js';
import { COPY_LIST, copyEntryFor } from '../scripts/build/static-files.ts';

const REPO = new URL('../', import.meta.url);
/** @param {string} rel */
const read = (rel) => readFileSync(new URL(rel, REPO), 'utf8');
const PROBE = 'public/browser-floor.js';
const NOTICE = 'public/browser-too-old.html';
const NOTICE_URL = '/browser-too-old.html';
/** Die beiden statischen Seiten mit fester de/en-Fassung (Ticket 14). */
const STATIC_PAGES = ['public/browser-too-old.html', 'public/offline.html'];

/* ──────────────────────────────────────────────────────────────────────────
 * Leser: ES5 oder nicht
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * ES2015+-Formen, die ein Browser an der ES5-Grenze nicht parst. Eine Naeherung
 * ueber den Text (ohne Kommentare und Literale), keine Parserpruefung: sie
 * trifft die Schreibweisen, die man in einer kleinen Datei hinschreibt.
 */
const ES2015_FORMS = [
  { form: 'Pfeilfunktion (=>)', pattern: /=>/ },
  { form: 'const', pattern: /\bconst\b/ },
  { form: 'let', pattern: /\blet(?:\s+[\w$]|\s*[[{])/ },
  { form: 'class', pattern: /\bclass\b/ },
  { form: 'Spread/Rest (...)', pattern: /\.\.\./ },
  { form: 'for...of', pattern: /\bfor\s*\([^)]*\bof\b/ },
  { form: 'async/await', pattern: /\basync\s+function\b|\basync\s*\(|\bawait\b/ },
  { form: 'import/export', pattern: /^\s*(?:import|export)\b|\bimport\s*\(/m },
  { form: 'Optional Chaining (?.)', pattern: /\?\.(?!\d)/ },
  { form: 'Nullish Coalescing (??)', pattern: /\?\?/ },
  { form: 'Potenz (**)', pattern: /\*\*/ },
];

/**
 * Template-Literale: ein Backtick im Code, nicht in einem String.
 * @param {string} source
 */
function hasTemplateLiteral(source) {
  const code = withoutCommentsKeepingLines(source)
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, '""');
  return code.includes('`');
}

/**
 * Die ES2015+-Formen einer Quelle, je Form einmal.
 * @param {string} source
 */
function es2015Findings(source) {
  const code = withoutCommentsKeepingLines(source, { blankLiterals: true });
  const found = ES2015_FORMS.filter(({ pattern }) => pattern.test(code)).map(({ form }) => form);
  if (hasTemplateLiteral(source)) found.push('Template-Literal');
  return found;
}

test('Leser: erkennt ES2015+-Formen, nicht ihre Doppelgaenger in Kommentaren und Strings (erfundene Faelle)', () => {
  assert.deepEqual(es2015Findings('var a = function (x) { return x; };'), []);
  assert.deepEqual(es2015Findings('var f = (x) => x;'), ['Pfeilfunktion (=>)']);
  assert.deepEqual(es2015Findings('const a = 1;'), ['const']);
  assert.deepEqual(es2015Findings('let a = 1;'), ['let']);
  assert.deepEqual(es2015Findings('class A {}'), ['class']);
  assert.deepEqual(es2015Findings('f(...xs);'), ['Spread/Rest (...)']);
  assert.deepEqual(es2015Findings('for (var x of xs) {}'), ['for...of']);
  assert.deepEqual(es2015Findings('var s = `a`;'), ['Template-Literal']);
  assert.deepEqual(es2015Findings('var v = a?.b;'), ['Optional Chaining (?.)']);
  assert.deepEqual(es2015Findings('var v = a ?? b;'), ['Nullish Coalescing (??)']);
  assert.deepEqual(es2015Findings('import x from "/x.js";'), ['import/export']);
  // Erlaubt: dieselben Zeichen in Kommentaren, Strings und Regex-Literalen,
  // der Ternaer-Operator mit einer Zahl, `letter` als Bezeichner.
  assert.deepEqual(es2015Findings([
    '// const a = () => `x`;',
    '/* class A { ...b } */',
    "var s = 'a => b, const, `tick`, ...rest';",
    'var r = /=>/.test(s);',
    'var v = ok ?.5 : 1;',
    'var letter = 1; letter = 2;',
  ].join('\n')), []);
});

/* ──────────────────────────────────────────────────────────────────────────
 * Die Probe
 * ────────────────────────────────────────────────────────────────────────── */

test('die Probe ist eine klassische ES5-Datei, die node parst', () => {
  assert.ok(existsSync(new URL(PROBE, REPO)), `${PROBE} fehlt`);
  const check = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(PROBE, REPO))], { encoding: 'utf8' });
  assert.equal(check.status, 0, `node --check ${PROBE}: ${check.stderr}`);
  assert.deepEqual(es2015Findings(read(PROBE)), [], `${PROBE} traegt Syntax, die ein zu alter Browser nicht parst`);
});

/** Fuehrt die Probe aus und liefert die Adressen, auf die sie ersetzt hat. */
function runProbe({ layerRule = true, hasOwn = true } = {}) {
  /** @type {string[]} */
  const replaced = [];
  const context = createContext({ location: { replace: (/** @type {string} */ url) => replaced.push(url) } });
  // Die Eingriffe in den Intrinsics des Kontexts, wie ein alter Browser sie nie hatte.
  if (!hasOwn) runInContext('delete Object.hasOwn;', context);
  if (layerRule) runInContext('this.CSSLayerBlockRule = function CSSLayerBlockRule() {};', context);
  runInContext(read(PROBE), context);
  return replaced;
}

test('die Probe als Programm: ohne CSSLayerBlockRule oder Object.hasOwn geht es auf die Hinweisseite', () => {
  assert.deepEqual(runProbe(), [], 'ein Browser mit beiden APIs bleibt in der App');
  assert.deepEqual(runProbe({ layerRule: false }), [NOTICE_URL], 'ohne CSSLayerBlockRule (Chrome < 99, Firefox < 97, Safari < 15.4)');
  assert.deepEqual(runProbe({ hasOwn: false }), [NOTICE_URL], 'ohne Object.hasOwn (Chrome < 93, Firefox < 92, Safari < 15.4)');
  assert.deepEqual(runProbe({ layerRule: false, hasOwn: false }), [NOTICE_URL], 'einmal, nicht zweimal');
});

/**
 * Die `<script>`-Tags eines Dokuments in Reihenfolge, ohne auskommentierte.
 * @param {string} html
 */
const scriptTags = (html) => [...withoutHtmlComments(html).matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
/** @param {string} tag */
const srcOf = (tag) => tag.match(/\bsrc=["']([^"']+)["']/)?.[1] ?? null;

test('index.html und offline.html laden die Probe vor jedem anderen Skript, klassisch und blockierend', () => {
  for (const file of ['public/index.html', 'public/offline.html']) {
    const html = read(file);
    const tags = scriptTags(html);
    assert.ok(tags.length >= 2, `${file}: Reichweiten-Nachweis, nur ${tags.length} Skripte gelesen`);
    assert.equal(tags[0], '<script src="/browser-floor.js">',
      `${file}: das erste Skript ist ${tags[0]} - die Probe muss vor allem laufen, was ein alter Browser nicht versteht`);
    assert.equal(tags.filter((tag) => srcOf(tag) === '/browser-floor.js').length, 1, `${file}: die Probe genau einmal`);
    const head = withoutHtmlComments(html).split(/<\/head>/i)[0];
    assert.ok(head.includes('<script src="/browser-floor.js">'), `${file}: die Probe steht im <head>`);
  }
});

/* ──────────────────────────────────────────────────────────────────────────
 * Die statischen Seiten: Hinweisseite und offline.html
 * ────────────────────────────────────────────────────────────────────────── */

test('die Hinweisseite ist statisch: kein Modul, kein App-Stylesheet, keine Probe, nur ES5-Skripte', () => {
  assert.ok(existsSync(new URL(NOTICE, REPO)), `${NOTICE} fehlt`);
  for (const file of STATIC_PAGES) {
    const html = withoutHtmlComments(read(file));
    assert.doesNotMatch(html, /<script\b[^>]*type=["']module["']/i, `${file}: ein Modul laeuft auf dem Zielbrowser nicht`);
    assert.doesNotMatch(html, /<link\b[^>]*rel=["']stylesheet["']/i, `${file}: ein App-Stylesheet (tokens.css) ist auf einem alten Browser nicht garantiert`);
    assert.doesNotMatch(html, /@import\b/, `${file}: kein @import`);
    for (const tag of scriptTags(html)) {
      const src = srcOf(tag);
      assert.ok(src, `${file}: kein Inline-Skript (CSP script-src 'self'): ${tag}`);
      assert.doesNotMatch(tag, /\b(?:async|defer)\b/, `${file}: ${src} laeuft blockierend`);
      const source = read(`public${src}`);
      assert.deepEqual(es2015Findings(source), [], `${file} laedt ${src}, und das traegt Syntax ueber ES5`);
    }
  }
  const notice = withoutHtmlComments(read(NOTICE));
  assert.ok(!scriptTags(notice).some((tag) => srcOf(tag) === '/browser-floor.js'),
    'die Hinweisseite laedt die Probe nicht - sie schickte sich sonst auf sich selbst');
});

/**
 * Die Untergrenze aus `build.target` in vite.config.ts.
 * @returns {{ chrome: string, firefox: string, safari: string, ios: string }}
 */
function buildTarget() {
  const list = read('vite.config.ts').match(/\btarget:\s*\[([^\]]+)\]/)?.[1] ?? '';
  const of = (/** @type {string} */ engine) => list.match(new RegExp(`['"]${engine}([\\d.]+)['"]`))?.[1] ?? '';
  const floor = { chrome: of('chrome'), firefox: of('firefox'), safari: of('safari') };
  assert.ok(floor.chrome && floor.firefox && floor.safari, `build.target in vite.config.ts nicht lesbar: ${list}`);
  return { ...floor, ios: floor.safari };
}

/**
 * Wert eines Punkt-Schluessels in einer Locale, `{{x}}` aus `vars` ersetzt.
 * @param {any} locale
 * @param {string} key
 * @param {Record<string, string>} [vars]
 * @returns {string | undefined}
 */
function valueOf(locale, key, vars = {}) {
  const value = key.split('.').reduce((/** @type {any} */ node, part) => node?.[part], locale);
  if (typeof value !== 'string') return undefined;
  return value.replace(/\{\{(\w+)\}\}/g, (all, name) => (name in vars ? vars[name] : all));
}

/**
 * Der sichtbare Text eines Markup-Stuecks: Tags weg, Leerraum zu einem
 * Zeichen. Ein Zeichen-Scanner statt `replace(/<[^>]+>/g, '')`: ein Tag reicht
 * vom `<` bis zum naechsten `>`, ein `<` ohne `>` nimmt den Rest mit - wie
 * withoutHtmlComments() in source-text.js, und so liest CodeQL es nicht als
 * unvollstaendige Bereinigung. Ein Text-Leser, kein Sanitizer.
 * @param {string} html
 */
function plainText(html) {
  let out = '';
  let pos = 0;
  for (;;) {
    const open = html.indexOf('<', pos);
    if (open === -1) { out += html.slice(pos); break; }
    out += html.slice(pos, open);
    const close = html.indexOf('>', open + 1);
    if (close === -1) break;
    pos = close + 1;
  }
  return out.split(/\s+/).filter(Boolean).join(' ');
}

/**
 * Die Sprachbloecke einer Seite: `<div class="copy" lang="xx" data-title="...">`
 * mit ihren `data-key`-Elementen. Ein Text ohne Schluessel waere eine Stelle,
 * an der die Seite und die Locale auseinanderlaufen koennen.
 * @param {string} html
 */
function copyBlocks(html) {
  /** @type {Record<string, { title: string, keys: { key: string, text: string }[], loose: string }>} */
  const blocks = {};
  const source = withoutHtmlComments(html);
  // Ein Block traegt kein weiteres <div>: das erste </div> schliesst ihn.
  for (const [, lang, title, body] of source.matchAll(/<div class="copy" lang="(\w+)" data-title="([^"]*)"[^>]*>([\s\S]*?)<\/div>/g)) {
    const keyed = [...body.matchAll(/<(\w+)\b[^>]*\bdata-key="([\w.]+)"[^>]*>([\s\S]*?)<\/\1>/g)];
    const keys = keyed.map(([, , key, inner]) => ({ key, text: plainText(inner) }));
    // Text ausserhalb eines data-key-Elements zaehlt mit - er haette keinen
    // Schluessel. Die Treffer werden per Position herausgeschnitten, nicht per
    // zweitem replace().
    let rest = '';
    let pos = 0;
    for (const m of keyed) {
      rest += body.slice(pos, m.index);
      pos = (m.index ?? 0) + m[0].length;
    }
    const loose = plainText(rest + body.slice(pos));
    blocks[lang] = { title, keys, loose };
  }
  return blocks;
}

test('Leser: plainText und die Sprachbloecke (erfundene Faelle)', () => {
  assert.equal(plainText('<a href="/">Erneut <b>versuchen</b></a>'), 'Erneut versuchen');
  assert.equal(plainText('a <svg><path d="M1 1"/></svg>\n  b'), 'a b');
  assert.equal(plainText('<<b>x</b>'), 'x', 'ein verschachteltes < laesst kein Tag stehen');
  assert.equal(plainText('Text <ohne Ende'), 'Text', 'ein offenes Tag nimmt den Rest mit');
  const blocks = copyBlocks([
    '<div class="copy" lang="de" data-title="T - Yuvomi" dir="ltr">',
    '  <h1 data-key="a.title">Titel</h1> lose <p data-key="a.body">Satz <b>fett</b></p>',
    '</div>',
    '<div class="copy" lang="en" data-title="E - Yuvomi"><h1 data-key="a.title">Title</h1></div>',
  ].join('\n'));
  assert.deepEqual(blocks.de, { title: 'T - Yuvomi', keys: [{ key: 'a.title', text: 'Titel' }, { key: 'a.body', text: 'Satz fett' }], loose: 'lose' });
  assert.deepEqual(blocks.en, { title: 'E - Yuvomi', keys: [{ key: 'a.title', text: 'Title' }], loose: '' });
});

/** Was jede der beiden Seiten mindestens sagt: Titel, Satz, Aktion. @type {Record<string, string[]>} */
const REQUIRED_KEYS = {
  'public/browser-too-old.html': ['browserTooOld.title', 'browserTooOld.body', 'browserTooOld.versions', 'browserTooOld.action', 'common.retry'],
  'public/offline.html': ['common.sessionUnreachableTitle', 'offline.unreachableBody', 'common.retry'],
};
/** @type {Record<string, string>} */
const DOC_TITLE_KEY = {
  'public/browser-too-old.html': 'browserTooOld.pageTitle',
  'public/offline.html': 'common.sessionUnreachableTitle',
};

test('beide statischen Seiten sprechen de und en, und jeder Text ist ein Schluessel in de.json/en.json (Ticket 14)', () => {
  /** @type {Record<string, any>} */
  const locales = { de: JSON.parse(read('public/locales/de.json')), en: JSON.parse(read('public/locales/en.json')) };
  const vars = buildTarget();
  for (const file of STATIC_PAGES) {
    const html = read(file);
    assert.match(html, /<html lang="en">/, `${file}: Englisch ist der Rueckfall, bevor lang-init.js die Sprache setzt`);
    const blocks = copyBlocks(html);
    assert.deepEqual(Object.keys(blocks).sort(), ['de', 'en'], `${file}: genau ein Block je Sprache`);
    for (const lang of ['de', 'en']) {
      const { title, keys, loose } = blocks[lang];
      assert.equal(loose, '', `${file} (${lang}): Text ohne Schluessel: "${loose}"`);
      assert.deepEqual(keys.map((k) => k.key), REQUIRED_KEYS[file], `${file} (${lang}): Schluessel und Reihenfolge`);
      for (const { key, text } of keys) {
        const expected = valueOf(locales[lang], key, vars);
        assert.ok(expected, `${key} fehlt in ${lang}.json`);
        assert.doesNotMatch(expected, /\{\{/, `${key} (${lang}): ein Platzhalter blieb offen`);
        assert.equal(text, expected, `${file} (${lang}): ${key} weicht von ${lang}.json ab`);
      }
      assert.equal(title, `${valueOf(locales[lang], DOC_TITLE_KEY[file])} - Yuvomi`, `${file} (${lang}): data-title`);
    }
    // Der statische <title> ist der englische - der Rueckfall ohne Skript.
    assert.match(html, new RegExp(`<title>${blocks.en.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</title>`), `${file}: <title> ist die englische Fassung`);
    // Die Auswahl: lang-init.js setzt <html lang>, das Stylesheet zeigt den Block.
    const scripts = scriptTags(html).map(srcOf);
    assert.ok(scripts.includes('/lang-init.js'), `${file}: lang-init.js setzt die Sprache (gespeichert vor navigator.language)`);
    assert.ok(scripts.includes('/static-page-title.js'), `${file}: static-page-title.js setzt den <title> der Sprache`);
  }
});

test('die Mindestversionen auf der Hinweisseite sind die von build.target', () => {
  const floor = buildTarget();
  assert.deepEqual(floor, { chrome: '105', firefox: '115', safari: '15.4', ios: '15.4' },
    'die beschlossene Untergrenze (Entscheidung 11) - aendert sich build.target, aendert sich die Seite mit');
  const text = plainText(withoutHtmlComments(read(NOTICE)));
  for (const version of [floor.chrome, floor.firefox, floor.safari]) {
    assert.ok(text.includes(version), `die Hinweisseite nennt ${version} nicht`);
  }
});

test('EINE Matrix: die Zeile in docs/installation.md und die READMEs nennen build.target', () => {
  const floor = buildTarget();
  const row = read('docs/installation.md').split('\n').find((line) => line.startsWith('| **Starts, every screen opens, scrolls** |'));
  assert.equal(row, `| **Starts, every screen opens, scrolls** | ${floor.chrome} | ${floor.firefox} | ${floor.safari} | ${floor.ios} |`,
    'die dokumentierte Untergrenze (test:old-browser-fallbacks misst gegen sie) ist build.target');
  assert.doesNotMatch(read('docs/installation.md'), /\*\*Everything as designed\*\*/, 'keine zweite Zeile mehr');
  for (const [file, label] of [['README.md', '- **Browsers** - '], ['README.de.md', '- **Browser** - ']]) {
    const line = read(file).split('\n').find((l) => l.startsWith(label)) ?? '';
    assert.ok(line.includes(`Chrome und Edge ${floor.chrome}`) || line.includes(`Chrome and Edge ${floor.chrome}`), `${file}: ${line}`);
    assert.ok(line.includes(`Firefox ${floor.firefox}`) && line.includes(`Safari ${floor.safari}`) && line.includes(`iOS ${floor.ios}`), `${file}: ${line}`);
  }
});

/**
 * Welcher Block sichtbar ist: das Stylesheet der Seite zeigt `.copy[lang=en]`,
 * ausser `<html>` steht auf Deutsch. Gelesen am Stylesheet selbst, nicht an
 * einer Kopie der Regel.
 */
test('das Stylesheet zeigt den Block der Seitensprache, Englisch sonst', () => {
  for (const file of STATIC_PAGES) {
    const html = read(file);
    const style = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'));
    const rules = [...eachRule(style)].filter((r) => !r.at.length).map((r) => `${r.selector.replace(/\s+/g, ' ')} {${r.body.replace(/\s+/g, ' ').trim()}}`);
    for (const expected of [
      '.copy {display: none;}',
      '.copy[lang="en"] {display: block;}',
      ':root:lang(de) .copy[lang="en"] {display: none;}',
      ':root:lang(de) .copy[lang="de"] {display: block;}',
    ]) {
      assert.ok(rules.includes(expected), `${file}: Regel fehlt: ${expected}`);
    }
  }
});

/**
 * Fuehrt static-page-title.js gegen erfundene Bloecke aus.
 * @param {string} lang
 */
function runTitle(lang) {
  const blocks = [
    { lang: 'de', title: 'Browser zu alt - Yuvomi' },
    { lang: 'en', title: 'Browser too old - Yuvomi' },
  ].map((b) => ({ getAttribute: (/** @type {string} */ name) => (name === 'lang' ? b.lang : name === 'data-title' ? b.title : null) }));
  const document = {
    title: 'Browser too old - Yuvomi',
    documentElement: { lang },
    querySelectorAll: (/** @type {string} */ selector) => (selector === '.copy[data-title]' ? blocks : []),
  };
  runInContext(read('public/static-page-title.js'), createContext({ document }));
  return document.title;
}

test('static-page-title.js als Programm: Deutsch fuer de und de-*, sonst Englisch', () => {
  assert.equal(runTitle('de'), 'Browser zu alt - Yuvomi');
  assert.equal(runTitle('de-AT'), 'Browser zu alt - Yuvomi');
  assert.equal(runTitle('en'), 'Browser too old - Yuvomi');
  assert.equal(runTitle('fr'), 'Browser too old - Yuvomi', 'jede andere Sprache bekommt den englischen Rueckfall');
  assert.equal(runTitle(''), 'Browser too old - Yuvomi');
  assert.equal(runTitle('dek'), 'Browser too old - Yuvomi', 'nur de als Sprach-Subtag');
});

/* ──────────────────────────────────────────────────────────────────────────
 * Kopierliste und Service Worker
 * ────────────────────────────────────────────────────────────────────────── */

test('Probe, Hinweisseite und ihre Skripte stehen mit precache auf der Kopierliste', () => {
  for (const rel of ['browser-floor.js', 'browser-too-old.html', 'offline.html', 'static-page-title.js', 'lang-init.js', 'theme-init.js', 'night-hours.js']) {
    const entry = copyEntryFor(rel);
    assert.ok(entry, `${rel} steht nicht auf der Kopierliste (scripts/build/static-files.ts)`);
    assert.equal(entry.precache, true, `${rel}: precache - ein zu alter Browser mit einem Worker von gestern bekommt die Seite auch ohne Netz`);
  }
  assert.ok(COPY_LIST.length >= 10, 'Reichweiten-Nachweis: Kopierliste nicht gelesen');
});

test('die Hinweisseite kommt als Datei, nie als Shell: Server-Rueckfall und Worker unterscheiden per Endung', () => {
  // server/index.js: eine Adresse mit Endung ist Datei oder 404, nie index.html.
  const server = read('server/index.js');
  assert.match(server, /if \(req\.path\.startsWith\('\/assets\/'\) \|\| \/\\\.\[a-z0-9\]\+\$\/i\.test\(lastSegment\)\) \{\s*return res\.status\(404\)/);
  // sw.js: isAppRouteNavigation() legt die Shell nur unter Adressen ohne Endung.
  const sw = read('public/sw.js');
  const navStart = sw.indexOf('function isAppRouteNavigation(');
  const nav = sw.slice(navStart, sw.indexOf('\n}\n', navStart));
  assert.match(nav, /return !\/\\\.\[a-z0-9\]\+\$\/i\.test\(pathname\);/);
  assert.ok(/\.[a-z0-9]+$/i.test(NOTICE_URL), 'die Hinweisseite traegt eine Endung');
  // isShellInsteadOfFile() prueft nur js/css/json - eine .html-Antwort wird gecacht.
  const shellCheck = sw.slice(sw.indexOf('function isShellInsteadOfFile('), sw.indexOf('function networkFirst('));
  assert.match(shellCheck, /if \(!\/\\\.\(m\?js\|css\|json\)\$\/i\.test\(pathname\)\) return false;/);
});

/* ──────────────────────────────────────────────────────────────────────────
 * Gespiegelte Token: Anlass und Gleichheit
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Namen der Seiten, die in tokens.css anders heissen. Jeder andere gespiegelte
 * Name muss in tokens.css stehen - ein Literal ohne Gegenstueck prueft niemand.
 */
/** @type {Record<string, string>} */
const TOKEN_ALIASES = {
  '--color-text': '--color-text-primary',
  '--type-sender': '--type-section-title',
  '--type-title': '--type-toolbar-title',
};

const tokensCss = () => read('public/styles/tokens.css');
/**
 * @param {string} css
 * @param {string} wanted
 * @param {(at: string[]) => boolean} atOk
 */
const propsOf = (css, wanted, atOk) => {
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const { selector, body, at } of eachRule(css)) {
    if (selector !== wanted || !atOk(at)) continue;
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) map.set(name, value.trim());
  }
  return map;
};
/** @param {string[]} at */
const screenOnly = (at) => at.every((a) => /^@media\s+screen$/.test(a.trim()));
/** @param {string[]} at */
const darkMedia = (at) => at.length === 1 && /prefers-color-scheme:\s*dark/.test(at[0]);

/** Die Farbwelten von tokens.css: hell (:root) und dunkel (beide Wege). */
function tokenScopes() {
  const css = tokensCss();
  const light = propsOf(css, ':root', screenOnly);
  const dark = new Map([
    ...light,
    ...propsOf(css, ':root:not([data-theme="light"])', darkMedia),
    ...propsOf(css, '[data-theme="dark"]', screenOnly),
  ]);
  return { light, dark };
}

/**
 * Loest `var()`-Ketten auf und rechnet `calc(a * b)` mit zwei Zahlen aus.
 * @param {Map<string, string>} scope
 * @param {string} value
 * @param {number} [depth]
 * @returns {string}
 */
function resolveToken(scope, value, depth = 0) {
  if (depth > 12) return value;
  return value
    .replace(/var\(\s*(--[\w-]+)\s*\)/g, (/** @type {string} */ all, /** @type {string} */ name) => (scope.has(name) ? resolveToken(scope, scope.get(name) ?? '', depth + 1) : all))
    .replace(/calc\(\s*([\d.]+)\s*\*\s*([\d.]+)\s*\)/g, (_all, /** @type {string} */ a, /** @type {string} */ b) => String(Number((Number(a) * Number(b)).toFixed(4))));
}
/** @param {string} v */
const normValue = (v) => v.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim().toUpperCase();

/**
 * Abweichungen der Spiegel einer Seite von tokens.css.
 * @param {string} html
 * @param {{ light: Map<string, string>, dark: Map<string, string> }} scopes
 */
function mirrorDrift(html, scopes) {
  const style = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'));
  const drift = [];
  let checked = 0;
  /** @type {[string, string, (at: string[]) => boolean, Map<string, string>][]} */
  const worlds = [
    ['hell', ':root', (at) => at.length === 0, scopes.light],
    ['dunkel (System)', ':root:not([data-theme="light"])', darkMedia, scopes.dark],
    ['dunkel (Wahl)', ':root[data-theme="dark"]', (at) => at.length === 0, scopes.dark],
  ];
  for (const [label, selector, atOk, scope] of worlds) {
    const declared = propsOf(style, selector, atOk);
    if (label !== 'hell' && declared.size === 0) drift.push(`${label}: kein Block`);
    for (const [name, value] of declared) {
      const token = TOKEN_ALIASES[name] ?? name;
      if (!scope.has(token)) { drift.push(`${label}: ${name} hat kein Gegenstueck in tokens.css`); continue; }
      const expected = resolveToken(scope, scope.get(token) ?? '');
      checked += 1;
      if (normValue(expected) !== normValue(value)) drift.push(`${label}: ${name} ist ${value}, tokens.css ${token} ${expected}`);
    }
  }
  return { drift, checked };
}

test('Leser: Spiegel-Abgleich findet abweichende und unbekannte Werte (erfundene Faelle)', () => {
  const scopes = {
    light: new Map([['--a', '#111111'], ['--b', 'var(--a)'], ['--color-text-primary', '#222222'], ['--s', '2'], ['--i', 'inset 0 rgba(0, 0, 0, calc(0.5 * var(--s)))']]),
    dark: new Map([['--a', '#333333'], ['--b', 'var(--a)'], ['--color-text-primary', '#444444']]),
  };
  const page = (/** @type {string} */ light, /** @type {string} */ dark) => `<style>:root { ${light} } @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${dark} } } :root[data-theme="dark"] { ${dark} }</style>`;
  assert.deepEqual(mirrorDrift(page('--b: #111111; --color-text: #222222; --i: inset 0 rgba(0,0,0,1);', '--b: #333333;'), scopes).drift, []);
  assert.deepEqual(mirrorDrift(page('--b: #999999;', '--b: #333333;'), scopes).drift, ['hell: --b ist #999999, tokens.css --b #111111']);
  assert.deepEqual(mirrorDrift(page('--erfunden: 1px;', '--b: #333333;'), scopes).drift, ['hell: --erfunden hat kein Gegenstueck in tokens.css']);
  assert.deepEqual(mirrorDrift(page('--b: #111111;', ''), scopes).drift, ['dunkel (System): kein Block', 'dunkel (Wahl): kein Block']);
});

test('die Werte der beiden statischen Seiten sind die von tokens.css (Ausnahme "inline" mit Verfallsdatum an beiden Enden)', () => {
  const scopes = tokenScopes();
  assert.ok(scopes.light.size > 100 && scopes.dark.size > scopes.light.size - 1, 'tokens.css nicht gelesen');
  for (const file of STATIC_PAGES) {
    const html = read(file);
    // Ende 1, der Anlass: die Seite laedt kein App-Stylesheet (oben geprueft).
    // Laedt sie tokens.css eines Tages doch, entfaellt der Spiegel - dieser
    // Test meldet es, weil die Seite dann keinen :root-Block mehr braucht.
    assert.doesNotMatch(withoutHtmlComments(html), /href=["'][^"']*tokens\.css/, `${file}: laedt tokens.css - dann die Spiegel streichen`);
    // Ende 2, die Gleichheit.
    const { drift, checked } = mirrorDrift(html, scopes);
    assert.ok(checked >= 20, `${file}: Reichweiten-Nachweis, nur ${checked} Werte verglichen`);
    assert.deepEqual(drift, [], `${file}: die gespiegelten Werte weichen von tokens.css ab`);
  }
});
