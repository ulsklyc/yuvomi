/**
 * Modul: Bewegung der Shell - Ausgaenge, Transitions, Seitenwechsel
 * Zweck: Die Zusagen aus der Runde "animate" (Critique 2026-09-26) halten, die
 *        man einem Stylesheet nicht ansieht, weil sie erst aus dem Zusammenspiel
 *        mehrerer Dateien entstehen.
 *
 *  1. JEDER AUSGANG SCHLAEGT SEINE EINFAHRT. `.modal-panel--closing` stand in
 *     layout.css, die Einfahrt `.modal-panel { animation: glass-sheet-in }` in
 *     glass.css - gleiche Spezifitaet, glass.css laedt spaeter, also gewann die
 *     Einfahrt. Die Tafel stand beim Schliessen 400ms still und verschwand hart.
 *     Keine Datei fuer sich ist falsch; falsch ist die Kaskade. Deshalb rechnet
 *     dieser Guard sie nach: fuer jede Ausgangsklasse (`--closing`, `--out`) und
 *     jede Breite, auf der eine Ausgangsregel gilt, muss die gewinnende
 *     `animation` aus einer Regel MIT der Ausgangsklasse kommen.
 *  2. KEIN SHORTHAND-TOKEN MIT ZWEITER KURVE. `--transition-fast` ist schon
 *     "150ms ease"; `var(--transition-fast) var(--ease-out)` hat zwei Kurven
 *     und macht die GANZE Deklaration ungueltig - die Transition lief nie.
 *  3. KEINE FEDER UND KEIN VERSATZ AUF DEM SEITENINHALT. Der Rueckfall des
 *     Seitenwechsels ist eine reine Blende; glass.css hatte ihm die Glas-Feder
 *     gegeben (Inhalt schwang 2px ueber).
 *  4. DIE SHEET-EINFAHRT HEBT 24px, NICHT 40 %.
 *  5. swapPage (utils/view-transition.js): Tausch im Callback, Kopf benannt
 *     und danach wieder frei, ohne API ein direkter Tausch.
 *  6. DIE KUECHEN-LEISTE STEHT IM NEUEN BILD. Der Browser nimmt das neue Bild
 *     gleich nach dem synchronen Teil von render() auf. Setzt eine Kuechen-
 *     Seite ihre Leiste erst nach einem `await` ein, fehlt sie dort: die
 *     Leiste blendete beim Wechsel Mahlzeiten -> Einkauf aus und kam nach den
 *     Daten zurueck (in der sichtbaren Pane gemessen, Integration Runde 3).
 *
 * Ausfuehren: node --test test/test-motion.js
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import { eachRule } from './css-rules.js';

const stylesDir = new URL('../public/styles/', import.meta.url);
const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = (name) => readFileSync(new URL(name, stylesDir), 'utf8');

/** Ladereihenfolge wie im Browser: die globalen Blaetter aus index.html, danach die Modul-Blaetter. */
const globalSheets = [...indexHtml.matchAll(/<link rel="stylesheet" href="\/styles\/([\w-]+\.css)"/g)].map((m) => m[1]);
const allSheets = readdirSync(stylesDir).filter((f) => f.endsWith('.css')).sort();
const sheetOrder = [...globalSheets, ...allSheets.filter((f) => !globalSheets.includes(f))];

function keyframeNames() {
  const names = new Set();
  for (const file of allSheets) {
    for (const m of css(file).matchAll(/@keyframes\s+([\w-]+)/g)) names.add(m[1]);
  }
  return names;
}

function keyframesBody(name) {
  for (const file of allSheets) {
    const src = css(file).replace(/\/\*[\s\S]*?\*\//g, '');
    const at = src.search(new RegExp(`@keyframes\\s+${name}\\s*\\{`));
    if (at === -1) continue;
    let i = src.indexOf('{', at) + 1;
    let depth = 1;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') depth -= 1;
      i += 1;
    }
    return src.slice(start, i - 1);
  }
  return null;
}

/**
 * Wertet eine At-Kette fuer eine Breite aus. Nur, was fuer Bewegung zaehlt:
 * Breiten, `@supports` (gilt), reduzierte Bewegung (gilt NICHT - geprueft wird
 * der Normalfall). Alles andere zaehlt als nicht zutreffend.
 */
function atMatches(at, width) {
  return at.every((rule) => {
    if (rule.startsWith('@supports')) return true;
    if (!rule.startsWith('@media')) return false;
    if (/prefers-reduced-motion:\s*no-preference/.test(rule)) return true;
    const features = [...rule.matchAll(/\(([^()]+)\)/g)].map((m) => m[1].trim());
    if (!features.length) return false;
    return features.every((f) => {
      const min = f.match(/^min-width:\s*(\d+)px$/);
      if (min) return width >= Number(min[1]);
      const max = f.match(/^max-width:\s*(\d+)px$/);
      if (max) return width <= Number(max[1]);
      return false;
    });
  });
}

/** `.a.b:not(.c)` -> { has: [a, b], not: [c], specificity: 3 }; alles Komplexere -> null. */
function parseCompound(selector) {
  const s = selector.trim();
  if (!/^(?:\.[\w-]+|:not\(\.[\w-]+\))+$/.test(s)) return null;
  const has = [...s.replace(/:not\(\.[\w-]+\)/g, '').matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  const not = [...s.matchAll(/:not\(\.([\w-]+)\)/g)].map((m) => m[1]);
  return { has, not, specificity: has.length + not.length };
}

/** Alle Regeln mit `animation`-Shorthand, in Kaskadenreihenfolge. */
function animationRules() {
  const rules = [];
  let order = 0;
  for (const file of sheetOrder) {
    for (const rule of eachRule(css(file))) {
      const decl = rule.body.match(/(?:^|;)\s*animation\s*:\s*([^;]+)/);
      if (!decl) continue;
      for (const part of rule.selector.split(',')) {
        const compound = parseCompound(part);
        if (compound) rules.push({ file, at: rule.at, selector: part.trim(), value: decl[1].trim(), order: order++, ...compound });
      }
    }
  }
  return rules;
}

function winner(rules, classes, width) {
  const hits = rules.filter((r) => atMatches(r.at, width)
    && r.has.every((c) => classes.includes(c))
    && r.not.every((c) => !classes.includes(c)));
  hits.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  return hits.at(-1) ?? null;
}

test('jeder Ausgang schlaegt seine Einfahrt - auf jeder Breite, ueber alle Stylesheets', () => {
  const rules = animationRules();
  const names = keyframeNames();
  const exitClasses = [...new Set(rules.flatMap((r) => r.has).filter((c) => /--(closing|out)$/.test(c)))];
  assert.ok(exitClasses.includes('modal-panel--closing'), 'Vorbedingung: der Scanner sieht die Schliess-Regel der Tafel');

  const failures = [];
  let checked = 0;
  for (const exit of exitClasses) {
    const base = exit.replace(/--(closing|out)$/, '');
    for (const width of [390, 767, 768, 1024, 1440]) {
      const exitRules = rules.filter((r) => r.has.includes(exit) && atMatches(r.at, width));
      if (!exitRules.length) continue;
      const win = winner(rules, [base, exit], width);
      checked += 1;
      if (!win?.has.includes(exit)) {
        const name = win?.value.split(/\s+/).find((tok) => names.has(tok)) ?? win?.value;
        failures.push(`.${base}.${exit} @${width}px spielt "${name}" aus ${win?.file} (${win?.selector}) statt der Ausgangs-Animation`);
      }
    }
  }
  assert.ok(checked >= 2, 'Vorbedingung: mindestens Tafel mobil und Desktop geprueft');
  assert.deepEqual(failures, [], `Einfahrt schlaegt Ausgang:\n  ${failures.join('\n  ')}`);
});

test('die Tafel und ihr Overlay haben auf JEDER Breite einen Ausgang', () => {
  const rules = animationRules();
  for (const width of [390, 1024]) {
    const panel = winner(rules, ['modal-panel', 'modal-panel--closing'], width);
    assert.ok(panel?.has.includes('modal-panel--closing'), `Tafel ohne Ausgang bei ${width}px`);
    const overlay = winner(rules, ['modal-overlay', 'modal-overlay--closing'], width);
    assert.ok(overlay?.has.includes('modal-overlay--closing'), `Overlay ohne Ausgang bei ${width}px`);
  }
});

/** Ein Wert auf oberster Ebene an Kommas trennen - `cubic-bezier(a, b, c, d)` nicht zerteilen. */
function splitCommas(value) {
  const items = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { items.push(cur); cur = ''; } else cur += ch;
  }
  items.push(cur);
  return items.map((item) => item.trim()).filter(Boolean);
}

/**
 * Jede `transition`-/`animation`-Deklaration aller Stylesheets, je Listeneintrag:
 * `{ file, selector, prop, item, reduced }`. EIN Leser fuer alle Motion-Guards.
 */
function motionItems() {
  const out = [];
  for (const file of allSheets) {
    for (const rule of eachRule(css(file))) {
      const reduced = rule.at.some((a) => /prefers-reduced-motion:\s*reduce/.test(a));
      for (const decl of rule.body.matchAll(/(?:^|;)\s*((transition|animation)(?:-[\w-]+)?)\s*:\s*([^;]+)/g)) {
        for (const item of splitCommas(decl[3])) {
          out.push({ file, selector: rule.selector, prop: decl[1], kind: decl[2], item, reduced });
        }
      }
    }
  }
  return out;
}

/** Shorthand-Token aus tokens.css: Dauer UND Kurve in einem Wert. */
function shorthandTokens() {
  const tokens = css('tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
  return [...tokens.matchAll(/(--(?:transition|sheet)-[\w-]+)\s*:\s*([^;]+);/g)]
    .filter(([, , value]) => /\d(?:ms|s)\b|var\(--duration-[\w-]+\)/.test(value)
      && /(?<![\w-])(?:ease|linear|ease-in|ease-out|ease-in-out)(?![\w-])|cubic-bezier|steps\(|var\(--ease-[\w-]+\)/.test(value))
    .map(([, name, value]) => ({ name, value: value.trim() }));
}

test('kein Shorthand-Token mit einer zweiten Kurve in einer Transition oder Animation', () => {
  // Welche Token Shorthands sind (Dauer UND Kurve), steht in tokens.css - nicht
  // in diesem Test.
  const names = shorthandTokens().map((tok) => tok.name);
  for (const expected of ['--transition-fast', '--transition-base', '--transition-slow', '--transition-glass', '--sheet-in', '--sheet-out']) {
    assert.ok(names.includes(expected), `Vorbedingung: ${expected} ist als Shorthand erkannt (gefunden: ${names})`);
  }

  const curve = /(?<![\w-])(?:ease|ease-in|ease-out|ease-in-out|linear)(?![\w-])|cubic-bezier\(|steps\(|var\(--ease-[\w-]+\)|var\(--(?:transition|sheet)-[\w-]+\)/g;
  const failures = [];
  let seen = 0;
  for (const { file, selector, prop, item } of motionItems()) {
    const used = names.filter((tok) => item.includes(`var(${tok})`));
    if (!used.length) continue;
    seen += 1;
    const curves = (item.match(curve) ?? []).filter((c) => !/^var\(--sheet-lift\)$/.test(c));
    if (curves.length > 1) failures.push(`${file}: ${selector} { ${prop}: ${item} }`);
  }
  assert.ok(seen > 200, `der Scanner sieht die Shorthand-Nutzungen nicht (${seen}) - der Guard waere blind`);
  assert.deepEqual(failures, [], `Ungueltige Deklarationen (zwei Kurven - die ganze Deklaration faellt weg):\n  ${failures.join('\n  ')}`);
});

/*
 * 9. EINE KURVENFAMILIE (Critique R16, P2 Bewegung). Die drei Shorthands
 *    fuehrten `ease` (307 Nutzungen) neben `--ease-out` (69): Hover und Press
 *    liefen auf einer anderen Kurve als Seiten, Dialoge und Listen. Dazu rund
 *    vierzig Deklarationen mit nacktem Keyword, 3x `transition: all` und
 *    Literal-Dauern (140ms, 0.15s, 420ms, 0.35s ...).
 *
 *    Die Regel: Interaktions-Motion nimmt Dauer und Kurve aus tokens.css.
 *    AUSGENOMMEN sind nur
 *      - Endlos-Schleifen (`infinite`): Wetter, Spinner, Shimmer, Blob - dort
 *        ist `linear`/`ease-in-out` die Aussage und die Periode kein UI-Tempo;
 *      - die benannten Stellen unten, jede mit ihrem Grund;
 *      - Nullwerte (`0s`, `none`) - kein Tempo, sondern "aus".
 *    Eine Ausnahme, die nichts mehr trifft, macht den Guard rot: eine Liste
 *    mit toten Eintraegen deckt die naechste echte Stelle.
 */
const KEYWORD_CURVE = /(?<![\w-])(ease|ease-in|ease-out|ease-in-out|linear)(?![\w(-])/;
const LITERAL_TIME = /(?<![\w.-])(\d*\.?\d+)(ms|s)\b/g;

/** `datei: selektor` -> Grund. Gilt fuer Keyword-Kurve UND Literal-Dauer der Stelle. */
const MOTION_EXCEPTIONS = new Map([
  ['calendar.css: .cal-press-ghost', 'Fortschritt des Langdrucks: laeuft linear mit der Haltezeit (--cal-press-ms), keine Bewegungskurve'],
  ['layout.css: .app-content', 'sanktionierte Layout-Transition des Offline-Banners (ignore.md) - nicht angefasst'],
  ['layout.css: .search-overlay', '`visibility 0s linear <Verzoegerung>`: diskreter Schalter nach der Blende, keine Bewegung'],
  ['layout.css: .swipe-reveal', 'folgt dem Finger: die Deckkraft wird je Frame gesetzt, linear glaettet nur'],
  ['layout.css: .swipe-row--hint > :first-child', 'einmaliger Wisch-Hinweis (Onboarding), nicht im Arbeitsfluss'],
  ['dashboard.css: .dashboard-icon-btn--hint', 'einmaliger Hinweis-Puls (3 Wiederholungen), nicht im Arbeitsfluss'],
  ['health.css: .cycle-ring__now', 'Hinweis-Puls am heutigen Tag (3 Wiederholungen), nicht im Arbeitsfluss'],
  ['screensaver.css: .photo-screensaver img', 'Bildschirmschoner: langsame Ueberblendung zwischen Fotos, kein Bedienmoment'],
]);

function motionViolations() {
  const used = new Set();
  const keyword = [];
  const literal = [];
  const all = [];
  let loops = 0;
  for (const { file, selector, prop, kind, item, reduced } of motionItems()) {
    const where = `${file}: ${selector}`;
    if (kind === 'transition' && /^(?:transition|transition-property)$/.test(prop) && /^all\b/.test(item)) {
      all.push(`${where} { ${prop}: ${item} }`);
    }
    const kw = KEYWORD_CURVE.test(item);
    const lits = [...item.replace(/cubic-bezier\([^)]*\)/g, '').matchAll(LITERAL_TIME)]
      .filter((m) => parseFloat(m[1]) !== 0);
    if (!kw && !lits.length) continue;
    if (/(?<![\w-])infinite(?![\w-])/.test(item)) { loops += 1; continue; }
    if (MOTION_EXCEPTIONS.has(where)) { used.add(where); continue; }
    // Unter reduzierter Bewegung steht kein Tempo, nur "aus" - ein Keyword
    // dort ist trotzdem eins, eine Literal-Dauer auch.
    if (kw) keyword.push(`${where} { ${prop}: ${item} }${reduced ? ' [reduced-motion]' : ''}`);
    if (lits.length) literal.push(`${where} { ${prop}: ${item} }${reduced ? ' [reduced-motion]' : ''}`);
  }
  return { keyword, literal, all, used, loops };
}

test('eine Kurvenfamilie: die Shorthands und das Sheet-Paar bestehen aus Tokens', () => {
  const byName = new Map(shorthandTokens().map((tok) => [tok.name, tok.value]));
  for (const name of ['--transition-fast', '--transition-base', '--transition-slow']) {
    assert.match(byName.get(name) ?? '', /^var\(--duration-[\w-]+\) var\(--ease-out\)$/, `${name}: Dauer-Token + --ease-out, kein Keyword und kein Literal`);
  }
  assert.match(byName.get('--transition-glass') ?? '', /^var\(--duration-[\w-]+\) var\(--ease-glass\)$/);
  assert.match(byName.get('--sheet-in') ?? '', /^var\(--duration-[\w-]+\) var\(--ease-glass\)$/, 'der Eintritt des Blatts federt');
  assert.match(byName.get('--sheet-out') ?? '', /^var\(--duration-[\w-]+\) var\(--ease-out\)$/, 'der Austritt hat keinen Ueberschwinger');
  const ms = (name) => parseFloat(css('tokens.css').match(new RegExp(`${name}:\\s*(\\d+)ms`))?.[1] ?? 'NaN');
  const dur = (name) => ms(byName.get(name).match(/var\((--duration-[\w-]+)\)/)[1]);
  assert.ok(dur('--sheet-out') < dur('--sheet-in'), 'der Austritt ist kuerzer als der Eintritt');
  assert.ok(dur('--sheet-in') <= 300, 'keine Bewegung ueber 300ms im Arbeitsfluss');
});

test('ein Blatt von unten: Dialog-Sheet, Mehr-Blatt und mobile Suche fahren aus EINEM Token-Paar', () => {
  const items = motionItems().filter((m) => !m.reduced);
  const uses = (selector, token) => items.some((m) => m.selector === selector && m.item.includes(`var(${token})`));
  // Eintritt
  assert.ok(items.some((m) => m.file === 'glass.css' && /^\.modal-panel:not\(\.modal-panel--closing\)$/.test(m.selector) && /glass-sheet-in var\(--sheet-in\)/.test(m.item)), 'Dialog-Sheet: Einfahrt aus --sheet-in');
  assert.ok(uses('.more-sheet[aria-hidden="false"]', '--sheet-in'), 'Mehr-Blatt: Einfahrt aus --sheet-in');
  assert.ok(uses('.search-overlay--visible', '--sheet-in'), 'Suche: Einfahrt aus --sheet-in');
  // Austritt
  assert.ok(items.some((m) => m.selector === '.modal-panel.modal-panel--closing' && /sheet-out var\(--sheet-out\)/.test(m.item)), 'Dialog-Sheet: Ausgang aus --sheet-out');
  assert.ok(uses('.more-sheet', '--sheet-out'), 'Mehr-Blatt: Ausgang aus --sheet-out');
  assert.ok(uses('.search-overlay', '--sheet-out'), 'Suche: Ausgang aus --sheet-out');
  // Der Hub: kein Vollhub mehr - die Feder wuerfe ihn ueber die Ruhelage.
  const layout = [...eachRule(css('layout.css'))];
  for (const sel of ['.more-sheet', '.search-overlay']) {
    const body = layout.find((r) => r.selector === sel && !r.at.length)?.body ?? '';
    assert.match(body, /transform:\s*translateY\(var\(--sheet-lift\)\)/, `${sel}: kurzer Hub`);
    assert.doesNotMatch(body, /translateY\((?:calc\()?100%/, `${sel}: kein Vollhub`);
  }
  // Die tote zweite Einfahrt in layout.css bleibt weg.
  assert.doesNotMatch(css('layout.css').replace(/\/\*[\s\S]*?\*\//g, ''), /modal-sheet-in|modal-slide-up|modal-scale-in/);
});

test('eine Kurvenfamilie: keine nackte Keyword-Kurve in Interaktions-Motion', () => {
  const { keyword, loops } = motionViolations();
  assert.ok(loops >= 8, `der Scanner sieht die Endlos-Schleifen nicht (${loops}) - der Guard waere blind`);
  assert.deepEqual(keyword, [], `Keyword-Kurve statt var(--ease-out)/var(--ease-in-out):\n  ${keyword.join('\n  ')}`);
});

test('keine Literal-Dauer und kein `transition: all` in Interaktions-Motion', () => {
  const { literal, all } = motionViolations();
  assert.deepEqual(all, [], `transition: all - die wechselnden Eigenschaften nennen:\n  ${all.join('\n  ')}`);
  assert.deepEqual(literal, [], `Literal-Dauer statt var(--duration-*):\n  ${literal.join('\n  ')}`);
});

test('die Ausnahmeliste der Motion-Guards hat keinen toten Eintrag', () => {
  const { used } = motionViolations();
  const dead = [...MOTION_EXCEPTIONS.keys()].filter((key) => !used.has(key));
  assert.deepEqual(dead, [], `Ausnahme trifft nichts mehr - streichen:\n  ${dead.join('\n  ')}`);
});

test('reduzierte Bewegung hat EINE "aus"-Konvention: 0s aus reset.css, kein 0.01ms daneben', () => {
  const offenders = [];
  for (const file of allSheets) {
    for (const rule of eachRule(css(file))) {
      if (/(?<![\w.-])0?\.\d+ms\b/.test(rule.body)) offenders.push(`${file}: ${rule.selector}`);
    }
  }
  assert.deepEqual(offenders, [], `Bruchteil-Millisekunden als "aus":\n  ${offenders.join('\n  ')}`);
});

/*
 * 10. BEWEGUNG AUS SKRIPTEN NIMMT DIESELBEN TOKENS. Eine Inline-Transition
 *     darf auf Custom Properties zeigen (`transform var(--duration-md)
 *     var(--ease-out)`), die Web Animations API bekommt ihre Zahl aus
 *     `durationToken()`/`easingToken()` (utils/ux.js). Literale standen in
 *     swipe-row.js (`0.2s ease`), sortable.js (die Federkurve als zweite
 *     Quelle) und im Shadow Tree des Installationsbanners (0.35s, 0.15s).
 */
function frontendScripts(dir = new URL('../public/', import.meta.url)) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'vendor' || entry.name === 'locales') continue;
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) out.push(...frontendScripts(url));
    else if (entry.name.endsWith('.js')) out.push(url);
  }
  return out;
}

test('Skripte: keine Literal-Dauer, kein Keyword und keine Literal-Kurve in Transition-Texten', () => {
  const scripts = frontendScripts();
  assert.ok(scripts.length > 100, 'Vorbedingung: der Scanner findet die Frontend-Skripte');
  const offenders = [];
  // Eine Eigenschaft, dann eine Literal-Dauer: `transform 0.2s ease`,
  // `transition: background 0.15s ease` (auch in CSS-Texten eines Shadow Trees).
  const timed = /(?:transform|opacity|background(?:-color)?|color|translate|box-shadow|border-color|filter|height|width)\s+\d*\.?\d+(?:ms|s)\b/;
  const bezier = /cubic-bezier\(\s*[\d.]/;
  for (const url of scripts) {
    const lines = readFileSync(url, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if (/^\s*(?:\*|\/\*)/.test(code)) return;
      if (timed.test(code) || bezier.test(code)) offenders.push(`${url.pathname.split('/public/')[1]}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `Literal-Motion im Skript - var(--duration-*)/var(--ease-*) oder durationToken()/easingToken():\n  ${offenders.join('\n  ')}`);
});

test('der Seiteninhalt blendet nur - keine Feder, kein Versatz', () => {
  const failures = [];
  for (const file of allSheets) {
    for (const rule of eachRule(css(file))) {
      if (!/\.page-transition--/.test(rule.selector)) continue;
      if (/--ease-glass|--transition-glass/.test(rule.body)) failures.push(`${file}: ${rule.selector} - Feder auf Inhalt`);
      const anim = rule.body.match(/(?:^|;)\s*animation(?:-name)?\s*:\s*([^;]+)/);
      const name = anim?.[1].trim().split(/\s+/)[0];
      if (name && name !== 'none') {
        const body = keyframesBody(name);
        assert.ok(body, `@keyframes ${name} fehlt`);
        if (/translate/.test(body)) failures.push(`${file}: ${rule.selector} - @keyframes ${name} versetzt den Inhalt`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('die Sheet-Einfahrt hebt hoechstens 24px', () => {
  const names = [...keyframeNames()].filter((n) => /sheet-in$/.test(n));
  assert.ok(names.includes('glass-sheet-in'), 'Vorbedingung: die Glas-Einfahrt ist gefunden');
  for (const name of names) {
    const from = keyframesBody(name).match(/from\s*\{([^}]*)\}/)?.[1] ?? '';
    const hub = from.match(/translateY\(([^)]+)\)/)?.[1]?.trim();
    assert.ok(hub, `${name}: kein translateY im Start`);
    assert.match(hub, /^\d+px$/, `${name}: Hub in px, nicht relativ zur Tafelhoehe (gefunden: ${hub})`);
    assert.ok(parseFloat(hub) <= 24, `${name}: ${hub} Hub - die Feder wirft die Tafel sonst ueber ihre Ruhelage`);
  }
});

// --------------------------------------------------------
// swapPage
// --------------------------------------------------------

function stubDocument({ api = true, visibility = 'visible' } = {}) {
  const toolbarOld = { style: {} };
  const toolbarNew = { style: {} };
  const content = { current: toolbarOld, querySelector: () => content.current };
  const log = [];
  const listeners = [];
  let resolveFinished;
  const doc = {
    visibilityState: visibility,
    addEventListener: (type, fn, opts) => listeners.push({ type, fn, capture: Boolean(opts?.capture) }),
    removeEventListener: (type, fn, opts) => {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === Boolean(opts?.capture));
      if (i >= 0) listeners.splice(i, 1);
    },
    startViewTransition: api
      ? (callback) => {
        log.push(`start old=${toolbarOld.style.viewTransitionName ?? ''}`);
        const updateCallbackDone = Promise.resolve().then(callback);
        return {
          updateCallbackDone,
          ready: updateCallbackDone,
          finished: new Promise((r) => { resolveFinished = r; }),
          skipTransition: () => { log.push('skip'); resolveFinished(); },
        };
      }
      : undefined,
  };
  return { doc, content, toolbarOld, toolbarNew, log, listeners, finish: () => resolveFinished() };
}

test('swapPage: tauscht im Callback der View Transition und benennt den Kopf nur fuer die Dauer', async () => {
  const { swapPage } = await import('../public/utils/view-transition.js');
  const env = stubDocument();
  globalThis.document = env.doc;
  globalThis.matchMedia = () => ({ matches: false });
  try {
    let swapped = false;
    const promise = swapPage(() => {
      swapped = true;
      env.log.push(`update old=${env.toolbarOld.style.viewTransitionName}`);
      env.content.current = env.toolbarNew;
    }, { content: env.content, from: '/shopping', animate: true });
    assert.equal(swapped, false, 'der Tausch wartet auf den Callback (erst das alte Bild, dann der Tausch)');
    const { transition, finished } = await promise;
    assert.equal(transition, true);
    assert.equal(swapped, true);
    assert.deepEqual(env.log, ['start old=page-toolbar', 'update old=']);
    assert.equal(env.toolbarNew.style.viewTransitionName, 'page-toolbar', 'der neue Kopf steht waehrend der Transition');
    env.finish();
    await finished;
    assert.equal(env.toolbarNew.style.viewTransitionName, '', 'danach ist der Name frei - er kollidierte sonst beim naechsten Wechsel');
  } finally {
    delete globalThis.document;
    delete globalThis.matchMedia;
  }
});

test('swapPage: der erste Tipp waehrend der Blende bricht sie ab, danach haengt kein Zuhoerer mehr', async () => {
  // Chromium trifft waehrend einer Wurzel-Transition jeden Zeiger nur auf <html>
  // (gemessen 2026-09-27, trotz `::view-transition { pointer-events: none }`):
  // Tipps bis zum Ende der Blende verpufften alle. Ein pointerdown in der
  // Capture-Phase beendet sie, damit der naechste Tipp die neue Seite erreicht.
  const { swapPage } = await import('../public/utils/view-transition.js');
  const env = stubDocument();
  globalThis.document = env.doc;
  globalThis.matchMedia = () => ({ matches: false });
  try {
    const { finished } = await swapPage(() => { env.content.current = env.toolbarNew; }, { content: env.content, from: '/tasks', animate: true });
    const taps = env.listeners.filter((l) => l.type === 'pointerdown' && l.capture);
    assert.equal(taps.length, 1, 'waehrend der Blende wartet genau ein pointerdown-Zuhoerer in der Capture-Phase');
    taps[0].fn();
    assert.deepEqual(env.log.filter((e) => e === 'skip'), ['skip'], 'der Tipp bricht die Blende ab');
    await finished;
    assert.equal(env.listeners.filter((l) => l.type === 'pointerdown').length, 0, 'nach der Blende ist der Zuhoerer weg');

    // Ohne Tipp: endet die Blende von selbst, geht der Zuhoerer mit.
    const second = await swapPage(() => {}, { content: env.content, from: '/notes', animate: true });
    assert.equal(env.listeners.filter((l) => l.type === 'pointerdown').length, 1);
    env.finish();
    await second.finished;
    assert.equal(env.listeners.filter((l) => l.type === 'pointerdown').length, 0, 'ein Zuhoerer ueberlebte die Blende und braeche die naechste beim ersten Klick ab');
  } finally {
    delete globalThis.document;
    delete globalThis.matchMedia;
  }
});

test('swapPage: ein zweiter Wechsel vor dem Ende des ersten behaelt den Kopfnamen', async () => {
  // Zwei Tipps innerhalb der Transition: der Browser verwirft die erste, ihr
  // `finished` loest auf, waehrend die zweite ihr altes Bild noch nicht
  // aufgenommen hat. Bleibt der Kopf ueber den Wechsel derselbe Knoten, darf das
  // Aufraeumen der ersten ihm den Namen nicht mitten in der zweiten nehmen.
  const { swapPage } = await import('../public/utils/view-transition.js');
  const env = stubDocument();
  const finishers = [];
  const start = env.doc.startViewTransition;
  env.doc.startViewTransition = (callback) => {
    const tr = start(callback);
    let resolve;
    tr.finished = new Promise((r) => { resolve = r; });
    finishers.push(resolve);
    return tr;
  };
  globalThis.document = env.doc;
  globalThis.matchMedia = () => ({ matches: false });
  try {
    // Derselbe Kopf-Knoten in beiden Wechseln (Seite ersetzt ihn nicht).
    const first = await swapPage(() => {}, { content: env.content, from: '/meals', animate: true });
    const second = await swapPage(() => {}, { content: env.content, from: '/recipes', animate: true });
    finishers[0]();
    await first.finished;
    assert.equal(env.toolbarOld.style.viewTransitionName, 'page-toolbar',
      'das Ende des ersten Wechsels nimmt dem laufenden zweiten den Namen');
    finishers[1]();
    await second.finished;
    assert.equal(env.toolbarOld.style.viewTransitionName, '', 'nach dem letzten Wechsel ist der Name frei');
  } finally {
    delete globalThis.document;
    delete globalThis.matchMedia;
  }
});

test('swapPage: ohne API, verdeckt, unter reduzierter Bewegung oder beim Kaltstart tauscht es direkt', async () => {
  const { swapPage } = await import('../public/utils/view-transition.js');
  const cases = [
    { name: 'ohne API', env: stubDocument({ api: false }), reduce: false, animate: true },
    { name: 'verdeckt', env: stubDocument({ visibility: 'hidden' }), reduce: false, animate: true },
    { name: 'reduzierte Bewegung', env: stubDocument(), reduce: true, animate: true },
    { name: 'Kaltstart', env: stubDocument(), reduce: false, animate: false },
  ];
  for (const { name, env, reduce, animate } of cases) {
    globalThis.document = env.doc;
    globalThis.matchMedia = () => ({ matches: reduce });
    try {
      let swapped = false;
      const promise = swapPage(() => { swapped = true; }, { content: env.content, animate });
      assert.equal(swapped, true, `${name}: synchron getauscht`);
      const { transition } = await promise;
      assert.equal(transition, false, name);
      assert.deepEqual(env.log, [], `${name}: keine Transition gestartet`);
    } finally {
      delete globalThis.document;
      delete globalThis.matchMedia;
    }
  }
});

/** Quelltext ohne Kommentare - ein "Daten-await" in einem Kommentar ist kein Warten. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('jede Kuechen-Seite setzt ihre Leiste vor dem ersten await ein', () => {
  const offenders = [];
  for (const page of ['meals', 'recipes', 'shopping', 'pantry']) {
    const src = stripComments(readFileSync(new URL(`../public/pages/${page}.js`, import.meta.url), 'utf8'));
    const start = src.indexOf('export async function render(');
    assert.ok(start >= 0, `${page}.js: render() nicht gefunden - der Guard liest nichts mehr`);
    const body = src.slice(start);
    const bar = body.indexOf('renderKitchenTabsBar(');
    const wait = body.search(/(^|[^\w-])await\s/m);
    assert.ok(bar >= 0, `${page}.js: render() setzt keine Kuechen-Leiste ein`);
    if (wait >= 0 && wait < bar) offenders.push(`${page}.js: erstes await vor renderKitchenTabsBar()`);
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

/*
 * 7. DIE ERSATZ-BLENDEN LEBEN AUCH BEI REDUZIERTER BEWEGUNG (Re-Critique
 *    2026-09-27, C5). reset.css setzte dort `transition-duration: 0s
 *    !important` auf JEDES Element - auch auf die Opacity-Blenden, die als
 *    bewegungsfreier Ersatz fuer Slides gebaut waren (Mehr-Blatt, Such-
 *    Overlay). Sie liefen nie; aus der Blende wurde ein harter Schnitt. Apple
 *    ersetzt Bewegung durch Ueberblenden, es schaltet sie nicht ab.
 *    Die Regel: Bewegung bleibt global aus, eine Blende meldet sich per
 *    `--motion-fade` davon ab - und NUR eine Blende darf das.
 */
function reducedMotionRules() {
  const out = [];
  for (const file of readdirSync(stylesDir).filter((f) => f.endsWith('.css'))) {
    const css = readFileSync(new URL(file, stylesDir), 'utf8');
    for (const rule of eachRule(css)) {
      if (!rule.at.some((a) => /prefers-reduced-motion:\s*reduce/.test(a))) continue;
      out.push({ file, selectors: rule.selector.split(',').map((s) => s.trim()), body: rule.body });
    }
  }
  return out;
}

/** `opacity 150ms, opacity .2s` -> nur Opacity? Dauer unter 1ms zaehlt als Schnitt. */
function opacityFade(value) {
  const parts = value.split(/,(?![^(]*\))/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length || !parts.every((p) => /^opacity\b/.test(p))) return false;
  return !parts.every((p) => /\b0?\.0\dms\b|\b0s\b/.test(p));
}

test('reduzierte Bewegung: die globale Sperre laesst Blenden durch, Bewegung nicht', () => {
  const reset = readFileSync(new URL('reset.css', stylesDir), 'utf8');
  const globalRule = [...eachRule(reset)].find((r) =>
    r.at.some((a) => /prefers-reduced-motion:\s*reduce/.test(a)) && /^\*\s*,/.test(r.selector.trim()));
  assert.ok(globalRule, 'die globale Regel fuer reduzierte Bewegung fehlt');
  assert.match(globalRule.body, /--motion-fade:\s*0s/, 'ohne Abmeldung bleibt jede Transition bei 0s');
  assert.match(globalRule.body, /transition-duration:\s*var\(--motion-fade\)\s*!important/);
  assert.match(globalRule.body, /animation-duration:\s*0s\s*!important/, 'Animationen bleiben aus');

  const rules = reducedMotionRules();
  const fades = new Set();
  for (const r of rules) {
    const m = r.body.match(/(?:^|;)\s*transition\s*:\s*([^;]+)/);
    if (m && opacityFade(m[1])) r.selectors.forEach((s) => fades.add(s));
  }
  assert.ok(fades.size >= 2, `der Scanner findet die Ersatz-Blenden nicht (${[...fades]}) - der Guard waere blind`);
  const optedIn = new Map();
  for (const r of rules) {
    const m = r.body.match(/(?:^|;)\s*--motion-fade\s*:\s*([^;]+)/);
    if (!m || /^0s$/.test(m[1].trim())) continue;
    r.selectors.forEach((s) => optedIn.set(s, `${r.file}: ${m[1].trim()}`));
  }
  for (const sel of fades) {
    assert.ok(optedIn.has(sel), `${sel}: Ersatz-Blende ohne --motion-fade - die globale Sperre schneidet sie ab`);
  }
  for (const [sel, where] of optedIn) {
    if (sel === '*' || sel.startsWith('*')) continue;
    assert.ok(fades.has(sel), `${sel} (${where}): meldet sich von der Sperre ab, blendet aber nicht nur - Bewegung kaeme zurueck`);
  }
  // Ausserhalb reduzierter Bewegung hat die Abmeldung nichts zu suchen.
  for (const file of readdirSync(stylesDir).filter((f) => f.endsWith('.css'))) {
    const css = readFileSync(new URL(file, stylesDir), 'utf8');
    for (const rule of eachRule(css)) {
      if (!/--motion-fade\s*:/.test(rule.body)) continue;
      assert.ok(rule.at.some((a) => /prefers-reduced-motion:\s*reduce/.test(a)), `${file}: ${rule.selector} setzt --motion-fade ausserhalb reduzierter Bewegung`);
    }
  }
});

/*
 * 8. GLAS SIEHT NUR BIS ZUR NAECHSTEN BACKDROP ROOT (Re-Critique 2026-09-28,
 *    A1 P1-1). `view-transition-name: nav-bottom` stand dauerhaft an
 *    `.nav-bottom` und machte die Zone zur Backdrop Root: der `backdrop-filter`
 *    der Kapsel `.nav-bottom__items` sah nur den transparenten Elternknoten,
 *    Schrift lief scharf zwischen den Tab-Labels durch. Dieselbe Falle stand an
 *    `.nav-sidebar` ueber `.nav-sidebar__indicator`. Backdrop Root wird ein
 *    Element mit `view-transition-name`, `opacity < 1`, `filter` oder `mask`.
 *    Der Guard sucht jedes Glas-Element (Regel mit `backdrop-filter`), leitet
 *    seine Vorfahren ab (Shell-Wurzeln, BEM-Block, Nachfahren-Selektor und die
 *    Schichten, in die router.js es haengt) und verlangt: keine dauerhafte Regel
 *    gibt einem Vorfahren eine dieser Eigenschaften. Waehrend eines
 *    Seitenwechsels (`html.page-swapping`, gesetzt von swapPage) ist der Name
 *    erlaubt - dort steht die Kapsel als eigenes Bild ohnehin still.
 *    `opacity: 0` ist ein versteckter Zustand und kein Befund.
 */
const SHELL_ROOTS = ['html', 'body', 'app', 'app-shell'];
// Schichten, in die router.js (und dashboard.js fuer den Speed-Dial) die
// Glas-Elemente haengt - nicht aus dem Klassennamen ablesbar.
const SHELL_PARENTS = {
  'page-fab': ['fab-layer', 'page-fab-group'],
  'fab-action': ['fab-actions', 'page-fab-group', 'fab-layer'],
  'fab-backdrop': ['page-fab-group', 'fab-layer'],
  'list-bulkbar': ['bulk-pill-layer'],
  toast: ['toast-container'],
};
const TRANSIENT_GATE = /\.page-swapping\b/;

function splitTop(src, isSep) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of src) {
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (depth === 0 && isSep(ch)) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const selectorList = (sel) => splitTop(sel, (ch) => ch === ',');
const compoundsOf = (sel) => splitTop(sel, (ch) => /[\s>+~]/.test(ch));
/** Kennung eines Compounds: erste Klasse, sonst ID, sonst Tag (`:root` = html). */
function compoundKey(compound) {
  const c = compound.replace(/::[\w-]+(\([^)]*\))?/g, '');
  if (/^:root\b/.test(c)) return 'html';
  const cls = c.match(/[.#]([\w-]+)/);
  if (cls) return cls[1];
  const tag = c.match(/^([a-z][\w-]*)/i);
  return tag ? tag[1].toLowerCase() : null;
}
function declValue(body, prop) {
  const m = body.match(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`));
  return m ? m[1].replace(/!important/, '').trim() : null;
}

function glassAncestors() {
  const glass = new Map();
  for (const file of allSheets) {
    for (const rule of eachRule(css(file))) {
      const v = declValue(rule.body, 'backdrop-filter') ?? declValue(rule.body, '-webkit-backdrop-filter');
      if (!v || v === 'none') continue;
      for (const sel of selectorList(rule.selector)) {
        const parts = compoundsOf(sel);
        const subject = parts.at(-1);
        const own = compoundKey(subject);
        const ancestors = new Set(SHELL_ROOTS);
        parts.slice(0, -1).map(compoundKey).filter(Boolean).forEach((k) => ancestors.add(k));
        // Ein Pseudo-Element (body::after) hat seinen Wirt als Vorfahren.
        if (/::/.test(subject) && own) ancestors.add(own);
        const block = own?.includes('__') ? own.split('__')[0] : null;
        if (block) ancestors.add(block);
        for (const k of [own, block]) (SHELL_PARENTS[k] ?? []).forEach((p) => ancestors.add(p));
        if (!/::/.test(subject)) ancestors.delete(own);
        glass.set(`${file}: ${sel}`, ancestors);
      }
    }
  }
  return glass;
}

/** Was eine Regel am Element zur Backdrop Root macht (null = nichts). */
function backdropRootCause(body) {
  const vtn = declValue(body, 'view-transition-name');
  if (vtn && vtn !== 'none') return `view-transition-name: ${vtn}`;
  const filter = declValue(body, 'filter');
  if (filter && filter !== 'none') return `filter: ${filter}`;
  for (const prop of ['mask', '-webkit-mask', 'mask-image', '-webkit-mask-image']) {
    const v = declValue(body, prop);
    if (v && v !== 'none') return `${prop}: ${v}`;
  }
  const opacity = declValue(body, 'opacity');
  if (opacity && /^[\d.]+%?$/.test(opacity)) {
    const n = opacity.endsWith('%') ? parseFloat(opacity) / 100 : parseFloat(opacity);
    if (n > 0 && n < 1) return `opacity: ${opacity}`;
  }
  return null;
}

test('Glas: kein Vorfahre eines backdrop-filter-Elements ist dauerhaft eine Backdrop Root', () => {
  const glass = glassAncestors();
  assert.ok(glass.size >= 8, `der Scanner findet die Glas-Elemente nicht (${glass.size}) - der Guard waere blind`);
  const kapsel = [...glass].find(([k]) => k.endsWith('.nav-bottom__items'));
  assert.ok(kapsel && kapsel[1].has('nav-bottom'), 'die Kapsel und ihr Vorfahre .nav-bottom muessen erkannt sein');

  const offenders = [];
  for (const file of allSheets) {
    for (const rule of eachRule(css(file))) {
      const cause = backdropRootCause(rule.body);
      if (!cause) continue;
      for (const sel of selectorList(rule.selector)) {
        if (sel.includes('::view-transition') || TRANSIENT_GATE.test(sel)) continue;
        const subject = compoundsOf(sel).at(-1);
        if (/::/.test(subject)) continue;
        const key = compoundKey(subject);
        for (const [glassSel, ancestors] of glass) {
          if (ancestors.has(key)) offenders.push(`${file}: ${sel} { ${cause} } nimmt ${glassSel} den Hintergrund`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('swapPage: die Chrome-Namen stehen nur waehrend des Wechsels (html.page-swapping)', async () => {
  // Der Name macht die Leiste zur Backdrop Root (Guard oben). Er muss schon beim
  // Aufnehmen des alten Bildes stehen - also VOR startViewTransition - und nach
  // dem letzten Wechsel wieder weg sein, sonst blurrt die Kapsel nie.
  const { swapPage } = await import('../public/utils/view-transition.js');
  const env = stubDocument();
  const classes = new Set();
  env.doc.documentElement = {
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
  };
  const finishers = [];
  const start = env.doc.startViewTransition;
  env.doc.startViewTransition = (callback) => {
    env.log.push(`class=${classes.has('page-swapping')}`);
    const tr = start(callback);
    let resolve;
    tr.finished = new Promise((r) => { resolve = r; });
    finishers.push(resolve);
    return tr;
  };
  globalThis.document = env.doc;
  globalThis.matchMedia = () => ({ matches: false });
  try {
    const first = await swapPage(() => {}, { content: env.content, from: '/tasks', animate: true });
    assert.equal(env.log[0], 'class=true', 'beim Aufnehmen des alten Bildes fehlte der Name - die Leiste blendete mit');
    const second = await swapPage(() => {}, { content: env.content, from: '/notes', animate: true });
    finishers[0]();
    await first.finished;
    assert.equal(classes.has('page-swapping'), true, 'das Ende des ersten Wechsels nimmt dem laufenden zweiten die Namen');
    finishers[1]();
    await second.finished;
    assert.equal(classes.has('page-swapping'), false, 'nach dem Wechsel bleibt die Leiste Backdrop Root - das Glas blurrt nie');

    await swapPage(() => {}, { content: env.content, animate: false });
    assert.equal(classes.has('page-swapping'), false, 'ohne Transition gibt es keinen Namen');
  } finally {
    delete globalThis.document;
    delete globalThis.matchMedia;
  }
});

/*
 * 11. DIE ZWEI GETEILTEN HELFER (Critique R16, P2 Bewegung): `swapContent`
 *     (utils/content-swap.js) fuer "derselbe Traeger, neuer Inhalt" und
 *     `redrawList`/`collapseRow` (utils/list-motion.js) fuer neu gezeichnete
 *     Listen. Gefahren werden die ECHTEN Module samt echtem ux.js und flip.js -
 *     gestubbt sind nur DOM und Uhr. Drei Zusagen je Helfer:
 *       a) der Tausch laeuft immer, genau einmal und synchron;
 *       b) unter reduzierter Bewegung bewegt sich nichts;
 *       c) der Endzustand braucht weder rAF noch ein `finish`-Ereignis.
 */
function motionEnv({ reduced = false, visibility = 'visible', dir = '' } = {}) {
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };
  globalThis.window = { matchMedia: (q) => ({ matches: reduced && /prefers-reduced-motion/.test(q) }) };
  globalThis.document = { visibilityState: visibility, documentElement: { dir } };
  globalThis.getComputedStyle = () => ({
    getPropertyValue: () => '',
    opacity: '1', paddingTop: '4px', paddingBottom: '4px', marginTop: '0px', marginBottom: '0px', borderTopWidth: '0px', borderBottomWidth: '0px',
  });
  // (c): kein Helfer darf auf einen Frame warten - im verdeckten Tab kommt keiner.
  globalThis.requestAnimationFrame = () => { throw new Error('rAF darf fuer den Endzustand nicht noetig sein'); };
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  };
}

function motionEl(key, top = 0) {
  const el = {
    key,
    style: {},
    calls: [],
    cancelled: 0,
    top,
    getAttribute: (name) => (name === 'data-key' ? key : null),
    getBoundingClientRect: () => ({ left: 0, top: el.top, width: 300, height: 48 }),
    // `finished` loest NIE auf: wer darauf wartet, haengt (Zusage c).
    animate(keyframes, timing) {
      const anim = { keyframes, timing, finished: new Promise(() => {}), cancel: () => { el.cancelled += 1; } };
      el.calls.push(anim);
      return anim;
    },
  };
  return el;
}

const motionHost = (rows) => {
  const host = motionEl('host');
  host.rows = rows;
  host.querySelectorAll = () => host.rows;
  host.closest = () => null;
  return host;
};

test('swapContent: der Tausch laeuft einmal und VOR der Blende, die Blende beginnt bei 0,4 ohne Versatz', async () => {
  const restore = motionEnv();
  try {
    const { swapContent, SWAP_FROM_OPACITY } = await import('../public/utils/content-swap.js');
    const host = motionHost([]);
    const log = [];
    const origAnimate = host.animate;
    host.animate = (...args) => { log.push('animate'); return origAnimate.apply(host, args); };
    const anim = swapContent(host, () => log.push('update'));
    assert.deepEqual(log, ['update', 'animate']);
    assert.ok(anim, 'die Blende ist gestartet');
    assert.deepEqual(anim.keyframes, [{ opacity: SWAP_FROM_OPACITY }, { opacity: 1 }], 'nur Deckkraft, kein leerer Frame');
    assert.equal(anim.timing.duration, 200, '--duration-md (Rueckfall ohne Stylesheet)');
    assert.equal(anim.timing.fill, undefined, 'kein fill: am Ende gilt das Stylesheet');
    assert.deepEqual(host.style, {}, 'kein Inline-Stil am Traeger');
  } finally { restore(); }
});

test('swapContent: gerichtet kommt der Inhalt von der Seite, zu der man blaettert - in RTL gespiegelt', async () => {
  const { swapContent, SWAP_SHIFT_PX } = await import('../public/utils/content-swap.js');
  for (const [dir, direction, expected] of [['', 1, SWAP_SHIFT_PX], ['', -1, -SWAP_SHIFT_PX], ['', 7, SWAP_SHIFT_PX], ['rtl', 1, -SWAP_SHIFT_PX], ['rtl', -1, SWAP_SHIFT_PX]]) {
    const restore = motionEnv({ dir });
    try {
      const anim = swapContent(motionHost([]), () => {}, { direction });
      assert.equal(anim.keyframes[0].transform, `translateX(${expected}px)`, `dir=${dir || 'ltr'} direction=${direction}`);
      assert.equal(anim.keyframes[1].transform, 'none');
    } finally { restore(); }
  }
});

test('swapContent: reduzierte Bewegung nimmt den Versatz, die kurze Blende bleibt', async () => {
  const restore = motionEnv({ reduced: true });
  try {
    const { swapContent } = await import('../public/utils/content-swap.js');
    let ran = 0;
    const anim = swapContent(motionHost([]), () => { ran += 1; }, { direction: 1 });
    assert.equal(ran, 1);
    assert.equal(anim.keyframes[0].transform, undefined, 'kein translate');
    assert.equal(anim.keyframes[1].transform, undefined);
    assert.equal(anim.timing.duration, 150, '--duration-sm');
  } finally { restore(); }
});

test('swapContent: ohne Blende (verdeckt, kein animate, animate:false, kein Traeger) steht der Inhalt trotzdem', async () => {
  const { swapContent } = await import('../public/utils/content-swap.js');
  const cases = [
    ['verdeckter Tab', { visibility: 'hidden' }, () => motionHost([]), {}],
    ['kein animate', {}, () => ({ style: {} }), {}],
    ['animate: false', {}, () => motionHost([]), { animate: false }],
    ['kein Traeger', {}, () => null, {}],
  ];
  for (const [name, env, makeHost, opts] of cases) {
    const restore = motionEnv(env);
    try {
      const host = makeHost();
      let ran = 0;
      const anim = swapContent(host, () => { ran += 1; }, opts);
      assert.equal(ran, 1, `${name}: der Tausch laeuft`);
      assert.equal(anim, null, `${name}: keine Blende`);
      assert.equal(host?.calls?.length ?? 0, 0, `${name}: animate nicht gerufen`);
    } finally { restore(); }
  }
});

test('swapContent: ein neuer Aufruf bricht die laufende Blende ab; ein werfender Tausch startet keine', async () => {
  const restore = motionEnv();
  try {
    const { swapContent } = await import('../public/utils/content-swap.js');
    const host = motionHost([]);
    swapContent(host, () => {});
    assert.equal(host.cancelled, 0);
    swapContent(host, () => {}, { direction: -1 });
    assert.equal(host.cancelled, 1, 'die erste Blende ist abgebrochen');
    assert.equal(host.calls.length, 2);
    // Ein anderer Traeger bleibt unberuehrt.
    const other = motionHost([]);
    swapContent(other, () => {});
    assert.equal(host.cancelled, 1);

    const broken = motionHost([]);
    assert.throws(() => swapContent(broken, () => { throw new Error('render kaputt'); }), /render kaputt/);
    assert.equal(broken.calls.length, 0, 'kein Einblenden eines halben Inhalts');
  } finally { restore(); }
});

test('redrawList: ein Aufbau aus dem Leeren staffelt - einmal je Traeger - und klappt nichts auf', async () => {
  const restore = motionEnv();
  try {
    const { redrawList } = await import('../public/utils/list-motion.js');
    const host = motionHost([]);
    let renders = 0;
    const opts = { selector: '.row', keyAttr: 'data-key' };
    assert.deepEqual(redrawList(host, () => { renders += 1; }, opts), { first: false, entered: 0, moved: 0 }, 'leer: nichts zu bewegen');
    const a = motionEl('a', 0);
    const b = motionEl('b', 48);
    const drawn = redrawList(host, () => { renders += 1; host.rows = [a, b]; }, opts);
    assert.equal(renders, 2, 'render laeuft je Aufruf genau einmal');
    assert.equal(drawn.first, true);
    assert.equal(a.style.opacity, '0', 'stagger hat die Zeilen angesetzt');
    assert.equal(a.calls.length, 0, 'der Aufbau klappt nichts auf');

    // Derselbe Traeger zeigt zwischendurch etwas anderes (anderer Reiter) und
    // baut die Liste dann wieder auf: keine Zeile gilt als "neu", und das
    // gestaffelte Einblenden wiederholt sich nicht.
    host.rows = [];
    const a2 = motionEl('a', 0);
    const b2 = motionEl('b', 48);
    const again = redrawList(host, () => { host.rows = [a2, b2]; }, opts);
    assert.equal(again.entered, 0);
    assert.equal(a2.calls.length + b2.calls.length, 0, 'kein Aufklappen jeder Zeile beim Zurueckkehren');
    assert.equal(a2.style.opacity, undefined, 'und kein zweites Staffeln');
  } finally { restore(); }
  // stagger raeumt seine Inline-Werte per Timer ab - abwarten, damit kein Test daran haengt.
  await new Promise((r) => setTimeout(r, 500));
});

test('redrawList: eine neue Zeile klappt ein (ohne FLIP darueber), eine reine Umsortierung gleitet', async () => {
  const restore = motionEnv();
  try {
    const { redrawList } = await import('../public/utils/list-motion.js');
    const opts = { selector: '.row', keyAttr: 'data-key' };
    const host = motionHost([motionEl('a', 0), motionEl('b', 48)]);
    redrawList(host, () => {}, opts); // erster Aufbau

    // Neue Zeile "c" zwischen a und b: b rutscht im Layout nach unten.
    const a2 = motionEl('a', 0); const c2 = motionEl('c', 48); const b2 = motionEl('b', 96);
    const entered = redrawList(host, () => { host.rows = [a2, c2, b2]; }, opts);
    assert.deepEqual(entered, { first: false, entered: 1, moved: 0 });
    assert.equal(c2.calls.length, 1, 'die neue Zeile zieht ihre Hoehe auf');
    assert.equal(c2.calls[0].keyframes[0].height, '0px');
    assert.equal(c2.calls[0].keyframes[1].height, '48px');
    assert.equal(b2.calls.length, 0, 'der Nachbar folgt dem Layout - kein zweiter Versatz per FLIP');

    // Reine Umsortierung: b vor a.
    const b3 = motionEl('b', 0); const a3 = motionEl('a', 48); const c3 = motionEl('c', 96);
    host.rows = [a2, c2, b2];
    a2.top = 0; c2.top = 48; b2.top = 96;
    const moved = redrawList(host, () => { host.rows = [b3, a3, c3]; }, opts);
    assert.deepEqual(moved, { first: false, entered: 0, moved: 3 });
    assert.deepEqual(b3.calls[0].keyframes, [{ transform: 'translate(0px, 96px)' }, { transform: 'none' }]);
    assert.equal(b3.calls[0].timing.duration, 200, '--duration-md');
  } finally { restore(); }
  await new Promise((r) => setTimeout(r, 500));
});

test('redrawList/collapseRow: unter reduzierter Bewegung laeuft nur das Neuzeichnen', async () => {
  const restore = motionEnv({ reduced: true });
  try {
    const { redrawList, collapseRow } = await import('../public/utils/list-motion.js');
    const opts = { selector: '.row', keyAttr: 'data-key' };
    const a = motionEl('a', 0);
    const host = motionHost([a]);
    redrawList(host, () => {}, opts);
    assert.equal(a.style.opacity, undefined, 'kein gestaffeltes Einblenden');
    const a2 = motionEl('a', 48); const n = motionEl('n', 0);
    let ran = 0;
    redrawList(host, () => { ran += 1; host.rows = [n, a2]; }, opts);
    assert.equal(ran, 1);
    assert.equal(n.calls.length + a2.calls.length, 0, 'weder Aufklappen noch FLIP');
    await collapseRow(a2);
    assert.equal(a2.calls.length, 0, 'kein Ausklappen');
  } finally { restore(); }
});

test('collapseRow: klappt die Zeile aus, mit der letzten Zeile die Gruppe - und loest auch ohne finish auf', async () => {
  const restore = motionEnv();
  try {
    const { collapseRow } = await import('../public/utils/list-motion.js');
    await collapseRow(null); // nichts zu tun

    const row = motionEl('a');
    const started = Date.now();
    await collapseRow(row); // `finished` loest in motionEl NIE auf
    assert.ok(Date.now() - started < 1000, 'der Timer loest auf, nicht das Ereignis');
    assert.equal(row.calls.length, 1);
    assert.equal(row.calls[0].keyframes[1].height, '0px');
    assert.equal(row.calls[0].timing.fill, 'forwards', 'bleibt zu, bis die Liste neu gezeichnet ist');
    assert.equal(row.calls[0].timing.duration, 250, '--duration-lg');

    const group = motionEl('group');
    const only = motionEl('x');
    group.querySelectorAll = () => [only];
    await collapseRow(only, { group, selector: '.row' });
    assert.equal(only.calls.length, 0);
    assert.equal(group.calls.length, 1, 'die Gruppe geht mit ihrer letzten Zeile');

    const group2 = motionEl('group2');
    const one = motionEl('y');
    group2.querySelectorAll = () => [one, motionEl('z')];
    await collapseRow(one, { group: group2, selector: '.row' });
    assert.equal(one.calls.length, 1);
    assert.equal(group2.calls.length, 0);
  } finally { restore(); }
});

/*
 * 12. DER STANDARD HAELT NUR, WENN DIE MODULE IHN AUFRUFEN. Die Helfer oben
 *     sind getestet; ob eine Seite sie benutzt, sieht man ihnen nicht an. Die
 *     Listen unten sind das Inventar: jede Zeile ist ein Traeger, dessen
 *     Inhaltswechsel bzw. Listenaenderung vor R16 ein harter Schnitt war (oder
 *     eine eigene Einzelloesung trug). Wer einen davon wieder direkt neu
 *     zeichnet, macht den Guard rot.
 */
const pageSource = (name) => readFileSync(new URL(`../public/pages/${name}.js`, import.meta.url), 'utf8');

test('Inhaltswechsel: Reiter, Zeitraeume und Bereiche tauschen ueber swapContent/swapPeriod', () => {
  const carriers = [
    ['rewards', /swapContent\(el, draw, \{ direction/, 'Reiterwechsel'],
    ['housekeeping', /swapContent\(content, \(\) => \{/, 'Reiterwechsel'],
    ['housekeeping', /swapPeriod\(content, towards, \(\) => renderReports\(content\)\)/, 'Berichtsmonat'],
    ['budget', /swapContent\(_container\.querySelector\('#budget-body'\), renderBody, \{ direction \}\)/, 'Reiterwechsel'],
    ['budget', /swapPeriod\(bodyEl\(\), dir,/, 'Monat/Berichtszeitraum'],
    ['budget', /swapContent\(body, renderBody\)/, 'Aufloesung der Statistik'],
    ['calendar', /swapPeriod\(_container\?\.querySelector\('#cal-body'\), dir, renderView\)/, 'Blaettern per Pfeil und Kuerzel'],
    ['calendar', /swapPeriod\(_container\?\.querySelector\('#cal-body'\), towardsToday, renderView\)/, 'Heute'],
    ['meals', /swapPeriod\(_container\?\.querySelector\('#week-grid'\) \?\? null, step, renderWeekGrid\)/, 'Woche'],
    ['schedule', /swapContent\(bodyEl\(\), renderPage, \{ direction \}\)/, 'Reiterwechsel'],
    ['schedule', /swapPeriod\(bodyEl\(\), step, renderPage\)/, 'Woche/Tag der Uebersicht'],
    ['health', /swapContent\(panel, null\)/, 'Bereichswechsel in jeder Breite'],
  ];
  const missing = carriers.filter(([name, pattern]) => !pattern.test(pageSource(name))).map(([name, , what]) => `${name}.js: ${what}`);
  assert.deepEqual(missing, [], `Traeger ohne den geteilten Uebergang:\n  ${missing.join('\n  ')}`);
  // Der Wisch im Kalender bringt sein eigenes Hereingleiten mit - kein zweiter Uebergang darueber.
  assert.match(pageSource('calendar'), /onStep: \(step\) => navigate\(step, \{ swap: false \}\)/);
  // Die zwei Einzelloesungen sind im Helfer aufgegangen.
  for (const file of ['budget.css', 'health.css']) {
    assert.ok(![...eachRule(css(file))].some((r) => /--entering\b/.test(r.selector)), `${file}: eigene Einblend-Klasse`);
  }
});

test('Listenbewegung: Module, die ihre Zeilen neu bauen, nutzen list-motion bzw. die Bausteine dahinter', () => {
  const modules = [
    ['housekeeping', /redrawList\(content, \(\) => drawTasks\(content\)/, 'Aufgabenliste'],
    ['housekeeping', /collapseRow\(row\)\.then\(repaint\)/, 'geloeschte Aufgabe klappt aus'],
    ['rewards', /await collapseRow\(row, \{ group:/, 'entschiedene Anfrage klappt aus'],
    ['waste', /redrawList\(host, \(\) => drawUpcoming\(host\)/, 'Abholungen'],
    ['waste', /redrawList\(host, \(\) => drawTypes\(host\)/, 'Abfallarten'],
    ['waste', /redrawList\(host, \(\) => drawSources\(host\)/, 'Quellen'],
    ['pantry', /redrawList\(list, \(\) => drawList\(list\)/, 'Vorrat nach Datenaenderung'],
    ['pantry', /collapseOut\(rowEl_\)/, 'geloeschter Artikel klappt aus'],
    ['shopping', /flipPlay\(listEl,/, 'Einkauf (Bestand)'],
    ['tasks', /await collapseOut\(lastInGroup \? group : row\)/, 'Aufgaben (Bestand)'],
  ];
  const missing = modules.filter(([name, pattern]) => !pattern.test(pageSource(name))).map(([name, , what]) => `${name}.js: ${what}`);
  assert.deepEqual(missing, [], `Liste ohne Bewegung:\n  ${missing.join('\n  ')}`);
  // Belohnungen: das Skelett steht nur beim ersten Aufbau, nicht bei jedem Wechsel.
  const rewards = pageSource('rewards');
  const fn = rewards.slice(rewards.indexOf('async function renderCurrentTab('), rewards.indexOf('async function renderCurrentTab(') + 900);
  assert.match(fn, /if \(first\) \{\s*el\.replaceChildren\(\);\s*el\.insertAdjacentHTML\('beforeend', renderSkeletonList/, 'Skelett nur unter `first`');
});

test('Schichtplan: Laden zeigt das geteilte Skelett, Blaettern haelt den Inhalt bis zur Antwort', () => {
  const schedule = pageSource('schedule');
  assert.doesNotMatch(schedule, /card card--padded schedule-stat-loading/, 'keine Textkarte "Laedt..." mehr');
  assert.match(schedule, /function scheduleLoadingHtml\([^)]*\) \{[\s\S]{0,200}renderSkeletonList\(/);
  const fn = schedule.slice(schedule.indexOf('async function activateView('), schedule.indexOf('async function activateView(') + 1500);
  assert.match(fn, /const hold = step !== null && !overview\.loading && !overview\.error;/);
  assert.match(fn, /if \(hold\) swapPeriod\(bodyEl\(\), step, renderPage\);/);
});
