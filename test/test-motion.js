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
 *      - Endlos-Schleifen (`infinite`): Wetter, Spinner, Shimmer - dort
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
    ['health', /swapContent\(panel, null, \{ direction \}\)/, 'Bereichswechsel in jeder Breite (schmal mit Richtung, R18)'],
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

/* R17, Bewegung: "das System steht, die Abdeckung fehlt". Acht Seiten bauten
 * ihre Liste nach Anlegen und Loeschen hart neu. Jede Zeile hier ist eine
 * Stelle, an der die DATEN sich aendern - nicht die Frage (Filter, Suche). */
test('Listenbewegung R17: Notizen, Dokumente, Kontakte, Budget, Inventar, Abos, Aufteilung und Geburtstage zeichnen ueber list-motion', () => {
  const modules = [
    ['notes', /redrawList\(grid, \(\) => drawGrid\(grid\), \{ selector: NOTE_CARD, keyAttr: 'data-id' \}\)/, 'Raster'],
    ['notes', /state\.notes = state\.notes\.filter\(\(n\) => n\.id !== id\);\s*renderNotesAndFilters\(\{ motion: true \}\)/, 'geloeschte Notiz'],
    ['notes', /closeSavedEditorWhenActive\(\);\s*renderNotesAndFilters\(\{ motion: true \}\)/, 'gespeicherte Notiz'],
    ['documents', /redrawList\(list, drawDocuments, \{ selector: DOCUMENT_ITEM, keyAttr: 'data-id' \}\)/, 'Liste und Raster'],
    ['documents', /Promise\.all\(leaving\.map\(\(row\) => collapseRow\(row\)\)\)\.then\(/, 'geloeschte Zeile klappt aus'],
    ['contacts', /redrawList\(container, \(\) => drawList\(container, \{ animate \}\), \{ selector: CONTACT_ROW, keyAttr: 'data-id' \}\)/, 'Liste'],
    ['contacts', /collapseRow\(row, \{ group: row\?\.closest\('\.contact-group'\), selector: CONTACT_ROW \}\)/, 'geloeschter Kontakt klappt aus, mit dem letzten die Gruppe'],
    ['budget', /redrawList\(body, renderBody, \{ selector: BUDGET_ENTRY, keyAttr: 'data-id' \}\)/, 'Buchungsliste'],
    ['budget', /summaryWith\(state\.summary, \[entry\], -1\);[\s\S]{0,260}collapseEntryThenRedraw\(id\);/, 'geloeschte Buchung klappt aus'],
    ['budget', /closeModal\(\{ force: true \}\);\s*redrawEntries\(\);\s*window\.yuvomi\?\.showToast\(t\('budget\.addedToast'\)/, 'neue Buchung zieht auf'],
    ['inventory', /redrawList\(host, renderListBody, \{ selector: INVENTORY_ITEM_ROW, keyAttr: 'data-id' \}\)/, 'Gegenstaende'],
    ['inventory', /await collapseRow\(_container\?\.querySelector\(`#inventory-list \.list-row\[data-id="\$\{item\.id\}"\]`\)/, 'geloeschter Gegenstand klappt aus'],
    ['subscriptions', /redrawList\(content, drawContent, \{ selector: SUBSCRIPTION_ROW, keyAttr: 'data-swipe-id' \}\)/, 'Abos'],
    ['subscriptions', /await collapseRow\(container\.querySelector\(`#subscriptions-list \.swipe-row\[data-swipe-id=/, 'geloeschtes Abo klappt aus'],
    ['split-expenses', /redrawList\(main, \(\) => drawMain\(main\), \{ selector: SPLIT_ROW, keyAttr: 'data-row-key' \}\)/, 'Ausgaben und Serien'],
    ['split-expenses', /await collapseSplitRow\(`expense-\$\{expense\.id\}`\);\s*renderAll\(\{ motion: true \}\)/, 'geloeschte Ausgabe klappt aus'],
    ['split-expenses', /await collapseSplitRow\(`recurring-\$\{recurring\.id\}`\);\s*renderAll\(\{ motion: true \}\)/, 'geloeschte Serie klappt aus'],
    ['split-expenses', /renderAll\(\);[\s\S]{0,260}swapContent\(_container\?\.querySelector\(`#split-main \[data-row-key="recurring-\$\{id\}"\]`\) \?\? null, null\);/, 'Pausieren/Fortsetzen blendet die Serienzeile'],
    ['birthdays', /redrawList\(host, \(\) => drawList\(host, \{ repaint \}\), \{ selector: BIRTHDAY_ROW, keyAttr: 'data-swipe-id' \}\)/, 'Liste'],
    ['birthdays', /collapseRow\(row\)\.then\(\(\) => \{ if \(_container === owner\) renderList\(\{ motion: true \}\); \}\)/, 'geloeschter Geburtstag klappt aus'],
  ];
  const missing = modules.filter(([name, pattern]) => !pattern.test(pageSource(name))).map(([name, , what]) => `${name}.js: ${what}`);
  assert.deepEqual(missing, [], `Liste ohne Bewegung:\n  ${missing.join('\n  ')}`);
  // Die Zeile muss das Attribut auch TRAGEN, an dem die Bewegung sie
  // wiedererkennt - ein Selektor ohne Treffer zeichnet still ohne Bewegung.
  const carried = [
    ['notes', /class="note-card \$\{[^}]+\}"\s+data-id="\$\{note\.id\}"/],
    ['documents', /<article class="document-card\$\{[^}]+\}" data-id="\$\{doc\.id\}">/],
    ['documents', /<article class="list-row document-row\$\{[^}]+\}" data-id="\$\{doc\.id\}">/],
    ['contacts', /contact-item" data-id="\$\{c\.id\}"/],
    ['budget', /const rowInteraction = masked \? '' : `data-id="\$\{e\.id\}"`;/],
    ['inventory', /<div class="list-row" data-id="\$\{item\.id\}" data-md-id=/],
    ['subscriptions', /data-swipe-id="\$\{subscription\.id\}"/],
    ['split-expenses', /data-expense-id="\$\{expense\.id\}" data-row-key="expense-\$\{expense\.id\}"/],
    ['split-expenses', /data-expense-view="\$\{expense\.id\}" data-row-key="expense-\$\{expense\.id\}"/],
    ['split-expenses', /split-recurring-row\$\{[^}]+\}" data-row-key="recurring-\$\{recurring\.id\}"/],
    ['birthdays', /data-swipe-id="\$\{birthday\.id\}"/],
  ];
  const bare = carried.filter(([name, pattern]) => !pattern.test(pageSource(name))).map(([name, pattern]) => `${name}.js: ${pattern}`);
  assert.deepEqual(bare, [], `Zeile ohne Wiedererkennungs-Attribut:\n  ${bare.join('\n  ')}`);
});

const publicSource = (path) => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');

test('Liste + Detail: ein Wechsel der Auswahl blendet die Detailspalte, ein Neuzeichnen derselben nicht', () => {
  const md = publicSource('utils/master-detail.js');
  // Nur select() mit einer ANDEREN Auswahl blendet ...
  assert.match(md, /if \(!same \|\| bodyEl\.hidden\) paint\(selected, \{ swap: !same \}\);/);
  // ... und zwar NACH dem Zeichnen, ohne Richtung (nur opacity: ein transform
  // machte die Spalte zum Bezugsrahmen ihres klebenden Kopfes).
  const paint = md.slice(md.indexOf('async function paint('), md.indexOf('function showLoadError('));
  assert.match(paint, /createIcons\(\{ el: bodyEl \}\);[\s\S]{0,260}if \(swap\) swapContent\(bodyEl, null\);\n  \}/);
  assert.ok(paint.indexOf('await renderDetail') < paint.indexOf('swapContent(bodyEl'), 'erst zeichnen, dann blenden');
  // refresh({ repaint }) zeichnet dieselbe Auswahl neu - ohne Blende.
  assert.match(md, /if \(repaint && selected != null && isSplit\(\)\) paint\(selected\);/);
  assert.equal((md.match(/swap: /g) ?? []).length, 1, 'genau eine Stelle setzt swap');
});

const ruleBodies = (file, selector) => [...eachRule(css(file))]
  .filter((r) => r.selector.replace(/\s+/g, ' ').trim() === selector)
  .map((r) => r.body);

test('Large Title: der Titel blendet in seinen neuen Schnitt, Layout wird nicht animiert', () => {
  const settle = ruleBodies('layout.css', '.page-toolbar--capped.is-collapsed > .page-toolbar__title').join(';');
  assert.match(settle, /animation:\s*page-title-settle var\(--duration-xs\) var\(--ease-out\)/, 'Einklappen blendet');
  const back = ruleBodies('layout.css', '.page-toolbar--capped.was-collapsed:not(.is-collapsed) > .page-toolbar__title').join(';');
  assert.match(back, /animation:\s*page-title-settle-back var\(--duration-xs\) var\(--ease-out\)/, 'Ausklappen blendet');
  // Nur Deckkraft: ein Keyframe mit Groesse, Abstand oder Versatz animierte Layout im klebenden Kopf.
  for (const name of ['page-title-settle', 'page-title-settle-back']) {
    const body = keyframesBody(name);
    assert.ok(body, `@keyframes ${name} fehlt`);
    const props = [...body.matchAll(/([\w-]+)\s*:/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(props)], ['opacity'], `${name} animiert mehr als opacity`);
  }
  // Der Rueckweg haengt am Merker, nicht an `--capped` allein: sonst blendete
  // jeder Seitenaufbau seinen Titel ein, sobald die Messung die Klasse setzt.
  const titleRules = [...eachRule(css('layout.css'))].filter((r) => /page-title-settle/.test(r.body));
  assert.equal(titleRules.length, 2);
  for (const r of titleRules) assert.match(r.selector, /\.is-collapsed|\.was-collapsed/, `${r.selector}: Blende ohne Zustand`);
  const ux = publicSource('utils/ux.js');
  assert.match(ux, /if \(top > 24\) toolbar\.classList\.add\(\.\.\.states, 'was-collapsed'\);/, 'der Merker faellt beim ersten Einklappen');
  assert.match(ux, /classList\.remove\('page-toolbar--stacked', 'page-toolbar--capped', 'is-collapsed', 'is-docked', 'was-collapsed',/, 'und geht mit dem Abbau');
  // Weiterhin keine font-size-Transition am Titel (R16).
  for (const file of ['layout.css', 'typography.css']) {
    for (const r of eachRule(css(file))) {
      if (!/page-toolbar__title/.test(r.selector)) continue;
      assert.doesNotMatch(r.body, /transition[^;]*font-size/, `${file}: ${r.selector} animiert font-size`);
    }
  }
  // Der angedockte Titel blendet ein und aus (Muster des Popover-Menues).
  const dock = ruleBodies('layout.css', '.page-toolbar--stacked > .page-toolbar__dock-title').join(';');
  assert.match(dock, /opacity:\s*0/);
  assert.match(dock, /transition:\s*opacity var\(--duration-xs\) var\(--ease-out\),\s*display var\(--duration-xs\) allow-discrete/);
  assert.match(css('layout.css'), /@starting-style \{\s*\.page-toolbar--stacked\.is-docked > \.page-toolbar__dock-title \{\s*opacity: 0;/);
  assert.match(ruleBodies('layout.css', '.page-toolbar--stacked.is-docked > .page-toolbar__dock-title').join(';'), /opacity:\s*1/);
});

test('Zeitraum-Wisch: das Budget blaettert seine Monats-Reiter wie der Kalender, ohne zweiten Uebergang', () => {
  const budget = pageSource('budget');
  assert.match(budget, /import \{ wirePeriodSwipe \} from '\/utils\/period-swipe\.js';/);
  const wire = budget.slice(budget.indexOf('wirePeriodSwipe(bodyEl(), {'), budget.indexOf('wirePeriodSwipe(bodyEl(), {') + 260);
  assert.match(wire, /enabled: \(\) => Boolean\(tabCaps\(\)\.month\) && !state\.loadError,/, 'nur Reiter mit Zeitachse (TAB_CAPS.month)');
  assert.match(wire, /ignore: PERIOD_SWIPE_IGNORE,/);
  assert.match(wire, /onStep: \(step\) => stepPeriod\(step, \{ swap: false \}\),/, 'derselbe Stepper wie die Pfeile; der Wisch gleitet selbst herein');
  // Was selbst waagerecht arbeitet, behaelt seinen Finger.
  const ignore = budget.match(/const PERIOD_SWIPE_IGNORE = '([^']+)';/)?.[1] ?? '';
  for (const sel of ['.u-scroll-fade', '.budget-stats__points', 'input']) {
    assert.ok(ignore.split(',').map((s) => s.trim()).includes(sel), `${sel} fehlt in PERIOD_SWIPE_IGNORE`);
  }
  assert.match(publicSource('pages/budget-stats.js'), /class="budget-stats__points"/, 'die Diagrammflaeche heisst noch so');
  // Senkrecht scrollt, waagerecht gehoert dem Wisch - wie #cal-body.
  assert.match(ruleBodies('budget.css', '#budget-body').join(';'), /touch-action:\s*pan-y pinch-zoom/);
  // Das Hereingleiten steht im geteilten Blatt: calendar.css laedt nur mit dem Kalender.
  assert.ok(globalSheets.includes('layout.css'));
  assert.ok([...eachRule(css('layout.css'))].some((r) => /\.period-swipe-in--next/.test(r.selector) && /animation:\s*period-swipe-in var\(--duration-md\) var\(--ease-out\)/.test(r.body)));
  assert.match(css('layout.css'), /@keyframes period-swipe-in\b/);
  assert.doesNotMatch(css('calendar.css').replace(/\/\*[\s\S]*?\*\//g, ''), /period-swipe-in/, 'keine zweite Fassung im Modul-Blatt');
});

test('Kalender: das Filter-Popover hat Ein- und Ausgang wie das Popover-Menue', () => {
  const base = ruleBodies('calendar.css', '.cal-filters-popover').join(';');
  assert.match(base, /opacity:\s*0/);
  assert.match(base, /transform:\s*scale\(0\.96\)/);
  assert.match(base, /overlay var\(--duration-xs\) allow-discrete,\s*display var\(--duration-xs\) allow-discrete/, 'der Ausgang haelt es im Top-Layer');
  // Rueckfall: die erste transition-Deklaration kommt ohne allow-discrete aus.
  const transitions = [...base.matchAll(/transition:\s*([^;]+)/g)].map((m) => m[1]);
  assert.equal(transitions.length, 2);
  assert.doesNotMatch(transitions[0], /allow-discrete/);
  const open = ruleBodies('calendar.css', '.cal-filters-popover:popover-open').join(';');
  assert.match(open, /opacity:\s*1/);
  assert.match(open, /transform:\s*none/);
  assert.match(open, /opacity var\(--duration-md\) var\(--ease-out\)/, 'die Einfahrt ist laenger als der Ausgang');
  assert.match(css('calendar.css'), /@starting-style \{\s*\.cal-filters-popover:popover-open \{\s*opacity: 0;\s*transform: scale\(0\.96\);/);
  // Der Ursprung kommt mit der Position aus JS (keine physische Seite im Blatt, RTL-Guard in test:calendar).
  assert.doesNotMatch(base, /transform-origin/);
  assert.match(pageSource('calendar'), /pop\.style\.transformOrigin = `\$\{Math\.round\(Math\.min\(Math\.max\(0, rect\.right - left\), width\)\)\}px 0`;/);
  // Ein sofortiges remove() im toggle schnitt den Ausgang ab.
  const cal = pageSource('calendar');
  const toggle = cal.slice(cal.indexOf("pop.addEventListener('toggle'"), cal.indexOf('pop.showPopover();'));
  assert.doesNotMatch(toggle.replace(/\/\/.*$/gm, ''), /^\s*pop\.remove\(\);/m, 'das Popover geht erst nach dem Ausgang aus dem Baum');
  assert.match(toggle, /setTimeout\(\(\) => pop\.remove\(\), durationToken\('--duration-xs', 120\) \+ 40\);/);
});

test('Erststart: die Karte steht, der Schritt wechselt ueber swapContent mit fester Hoehe', () => {
  const dash = pageSource('dashboard');
  const fn = dash.slice(dash.indexOf('function showOnboarding('), dash.indexOf('function maybeHintCustomize('));
  assert.doesNotMatch(fn, /overlay\.replaceChildren\(\)/, 'die Karte wird nicht mehr je Schritt neu gebaut');
  assert.match(fn, /swapContent\(stepEl, \(\) => \{ next = fillStep\(\); \}, \{ direction: 1 \}\);\s*next\?\.focus\(\);/, 'Tausch, dann Fokus auf den neuen Hauptknopf');
  assert.match(fn, /function fitSteps\(\) \{[\s\S]{0,420}tallest = Math\.max\(tallest, stepEl\.offsetHeight\);[\s\S]{0,200}stepEl\.style\.minBlockSize = `\$\{tallest\}px`;/, 'die Hoehe ist die des hoechsten Schritts');
  assert.match(fn, /appContainer\.appendChild\(overlay\);[\s\S]{0,120}fitSteps\(\);/, 'gemessen wird im Baum');
  const step = ruleBodies('dashboard.css', '.onboarding-step').join(';');
  assert.match(step, /display:\s*flex/);
  assert.match(ruleBodies('dashboard.css', '.onboarding-step > .onboarding-body').join(';'), /flex:\s*1 0 auto/, 'der Text nimmt den Rest, Punkte und Knoepfe stehen');
});

test('Diagramme: Kurven und Ring der Berichte zeichnen sich einmal ein (drawChartOnce)', () => {
  const stats = publicSource('pages/budget-stats.js');
  assert.match(stats, /import \{ growBars, drawChartOnce \} from '\/utils\/ux\.js';/);
  // Die Kurven stehen in EINER Gruppe - an ihr haengt der Beschnitt, Raster und Achse bleiben stehen.
  // Seit R17 (Zukunft punktiert) stehen bis zu vier Linien in der Gruppe - alle zeichnen sich mit ein.
  // Seit R18 dazu die Flaeche unter den Einnahmen und der Punkt mit Wert - auch sie in der Gruppe.
  assert.match(stats, /<g class="budget-stats__lines">\s*<polygon[\s\S]{0,200}<polyline[\s\S]{0,400}<polyline[\s\S]{0,1400}<\/g>/);
  assert.match(stats, /drawChartOnce\('budget-stats-trend', \{ lines: host\.querySelector\('\.budget-stats__lines'\) \}\);/);
  assert.match(stats, /drawChartOnce\('budget-stats-donut', \{ arcs: host\.querySelectorAll\('\.budget-stats__donut circle'\) \}\);/);
  // Das Ringsegment traegt "Laenge Umfang" - daraus liest der Helfer den Startwert.
  assert.match(stats, /stroke-dasharray="\$\{\(frac \* C\)\.toFixed\(2\)\} \$\{C\.toFixed\(2\)\}"/);
  // Der Helfer selbst: ohne fill (Endzustand = Markup), einmal je Sitzung.
  const ux = publicSource('utils/ux.js');
  const fn = ux.slice(ux.indexOf('export function drawChartOnce('), ux.indexOf('function settleAnimation('));
  assert.doesNotMatch(fn, /fill:/, 'kein fill - faellt die Animation aus, steht das Diagramm');
  assert.match(fn, /prefers-reduced-motion: reduce/);
  assert.match(fn, /durationToken\('--duration-xl', 300\), easing: easingToken\('--ease-out'/);
});

test('Schichtplan: Laden zeigt das geteilte Skelett, Blaettern haelt den Inhalt bis zur Antwort', () => {
  const schedule = pageSource('schedule');
  assert.doesNotMatch(schedule, /card card--padded schedule-stat-loading/, 'keine Textkarte "Laedt..." mehr');
  assert.match(schedule, /function scheduleLoadingHtml\([^)]*\) \{[\s\S]{0,200}renderSkeletonList\(/);
  const fn = schedule.slice(schedule.indexOf('async function activateView('), schedule.indexOf('async function activateView(') + 1500);
  assert.match(fn, /const hold = step !== null && !overview\.loading && !overview\.error;/);
  assert.match(fn, /if \(hold\) swapPeriod\(bodyEl\(\), step, renderPage\);/);
});

// --------------------------------------------------------------------------
// R18: KEINE DREHUNG AUF EINEM KNOTEN, DER TEXT TRAEGT.
//
// `.page-fab[aria-expanded="true"] { transform: rotate(45deg) }` (dashboard.css)
// sollte aus dem Plus ein X machen und drehte den ganzen Knopf. Am runden FAB
// faellt das nicht auf; dieselbe Klasse traegt am Desktop aber die Kapsel
// "+ Neu" (`.page-fab--docked`), und die kippte samt Wort um 45 Grad.
//
// Knoepfe sind die Knoten, die ein Etikett tragen KOENNEN: `.page-fab`
// (angedockt beschriftet), `.btn`, der Popover-Ausloeser. Eine Drehung gehoert
// an das Icon darin, nie an den Knopf - gleich in welcher Datei.
// --------------------------------------------------------------------------
const LABEL_BEARERS = ['page-fab', 'btn', 'popover-menu__trigger', 'toolbar-new-btn'];

/** Der letzte zusammengesetzte Selektor - der Knoten, den die Regel trifft. */
function subjectOf(selector) {
  return selector.trim().split(/\s*[>+~]\s*|\s+/).pop();
}

function rotatedLabelBearers() {
  const hits = [];
  for (const file of allSheets) {
    for (const { selector, body } of eachRule(css(file))) {
      if (!/(?:^|[;\s])(?:transform|rotate)\s*:[^;]*(?:rotate[XYZ]?\(|\d(?:deg|turn|rad))/.test(body)) continue;
      for (const part of selector.split(',')) {
        const subject = subjectOf(part);
        // Ein Pseudo-Element ist ein eigener Kasten ohne Text - das darf drehen.
        if (/::|:(?:before|after)\b/.test(subject)) continue;
        const classes = (subject.match(/\.[\w-]+/g) ?? []).map((c) => c.slice(1));
        if (classes.some((c) => LABEL_BEARERS.includes(c))) hits.push(`${file}: ${part.trim()}`);
      }
    }
  }
  return hits;
}

test('R18: keine Drehung auf einem Knopf, der Text tragen kann - es dreht das Icon', () => {
  assert.deepEqual(rotatedLabelBearers(), [],
    'eine Drehung am Knopf kippt seine Beschriftung mit (Kapsel "+ Neu" am Desktop)');

  // Reichweite: das Plus-zu-X gibt es weiterhin, am Icon.
  const dash = [...eachRule(css('dashboard.css'))];
  const turn = dash.find((r) => r.selector.split(',').some((s) => s.trim() === '.page-fab[aria-expanded="true"] > svg'));
  assert.ok(turn, 'die Regel fuer das gedrehte Icon fehlt');
  assert.match(turn.body, /transform:\s*rotate\(45deg\)/);

  // Das Grau des offenen Speed-Dials erreicht die angedockte Kapsel nicht.
  const grey = dash.filter((r) => /\.page-fab\[aria-expanded="true"\]/.test(r.selector) && /background(?:-color)?\s*:/.test(r.body));
  assert.ok(grey.length > 0, 'Reichweite: der offene Speed-Dial faerbt sich weiterhin um');
  for (const r of grey) {
    assert.match(r.selector, /:not\(\.page-fab--docked\)/, `${r.selector} wuerde die violette Kapsel ergrauen lassen`);
  }
});

// --------------------------------------------------------------------------
// R18, Bewegung: DIE QUITTUNG HAENGT AN DER BERUEHRUNG, NICHT AM ZUSTAND.
//
// `check-pop` stand als `animation` an `.item-check--checked`,
// `.task-status-btn--done`, `.subtask-item__checkbox--done` und
// `.note-md-check.is-checked`. Eine Animation an einer Zustandsklasse startet
// jedes Mal, wenn ein Knoten MIT der Klasse entsteht - also bei jedem
// Neuzeichnen. Gemessen im Einkauf: beim Anlegen, Loeschen und beim Aufklappen
// einer Gruppe zuckten alle laengst abgehakten Haken. Das Projekt kannte die
// Fehlerklasse (#467, das Zustandszeichen) und hatte sie je Stelle mit einer
// Gegenregel geflickt.
//
// Die Regel: eine Zustandsklasse traegt Aussehen, keine Animation. Die
// Quittung startet der Handler (`acknowledgeCheck` in utils/ux.js), am
// beruehrten Element, einmal.
// --------------------------------------------------------------------------

/** Klassen, die einen ZUSTAND nennen - er steht, solange die Daten ihn tragen. */
const STATE_CLASS = /\.(?:[\w-]+--(?:checked|done|selected|active|current|open|expanded|completed|pinned|archived|collapsed|on)|(?:is|was|has)-[\w-]+)(?![\w-])/;

/** `datei: selektor` -> Grund. Ein Eintrag, der nichts mehr trifft, macht den Guard rot. */
const STATE_ANIMATION_EXCEPTIONS = new Map([
  ['layout.css: .page-toolbar--capped.is-collapsed > .page-toolbar__title', 'Large Title: der Zustand folgt dem Scrollstand am selben, nie neu gezeichneten Knoten; die Blende ist sein Uebergang (Guard "Large Title")'],
  ['layout.css: .page-toolbar--capped.was-collapsed:not(.is-collapsed) > .page-toolbar__title', 'Rueckweg derselben Blende; `was-collapsed` faellt erst nach dem ersten Einklappen, ein Seitenaufbau spielt sie nicht'],
]);

function stateAnimations() {
  const hits = [];
  for (const file of allSheets) {
    for (const rule of eachRule(css(file))) {
      const decl = rule.body.match(/(?:^|;)\s*animation(?:-name)?\s*:\s*([^;]+)/);
      if (!decl || /^none\b/.test(decl[1].trim())) continue;
      // Endlos-Schleifen (Spinner an `.is-loading`) SIND der Zustand.
      if (/(?<![\w-])infinite(?![\w-])/.test(decl[1])) continue;
      for (const part of selectorList(rule.selector)) {
        if (STATE_CLASS.test(part)) hits.push(`${file}: ${part.replace(/\s+/g, ' ')}`);
      }
    }
  }
  return hits;
}

test('R18: keine Animation an einer Zustandsklasse - ein Neuzeichnen spielte sie an unberuehrten Zeilen', () => {
  // Reichweite des Musters, an Text geprueft.
  for (const sel of ['.item-check--checked', '.task-status-btn--done', '.note-md-check.is-checked .note-md-box', '.a.was-collapsed:not(.is-collapsed) > .b']) {
    assert.match(sel, STATE_CLASS, `${sel} muss als Zustand gelten`);
  }
  for (const sel of ['.modal-panel--closing', '.toast--out', '.btn--shaking', '.detail-pane--enter', '.history-list']) {
    assert.doesNotMatch(sel, STATE_CLASS, `${sel} ist ein kurzlebiger Moment, kein Zustand`);
  }
  const hits = stateAnimations();
  const offenders = hits.filter((hit) => !STATE_ANIMATION_EXCEPTIONS.has(hit));
  assert.deepEqual(offenders, [], `Animation an einer Zustandsklasse - im Handler ausloesen (acknowledgeCheck) oder benannt ausnehmen:\n  ${offenders.join('\n  ')}`);
  const dead = [...STATE_ANIMATION_EXCEPTIONS.keys()].filter((key) => !hits.includes(key));
  assert.deepEqual(dead, [], `Ausnahme trifft nichts mehr - streichen:\n  ${dead.join('\n  ')}`);
  // Die alte Kurve (fuenf Stuetzpunkte, vier Richtungswechsel in 200ms) ist weg.
  assert.ok(!keyframeNames().has('check-pop'), '@keyframes check-pop ist in acknowledgeCheck aufgegangen');
});

/** Skalierungen der Stuetzpunkte: `scale(1.16)` -> 1.16. */
const scalesOf = (keyframes) => keyframes.map((k) => Number(String(k.transform).match(/^scale\(([\d.]+)\)$/)?.[1]));

test('acknowledgeCheck: eine Quittung am beruehrten Element, ein Ueberschwinger, auch beim Zuruecknehmen', async () => {
  const restore = motionEnv();
  try {
    const { acknowledgeCheck } = await import('../public/utils/ux.js');
    const el = motionEl('haken');
    const started = Date.now();
    await acknowledgeCheck(el, { checked: true }); // `finished` loest in motionEl NIE auf
    assert.ok(Date.now() - started < 1000, 'der Timer loest auf, nicht das Ereignis - der Aufrufer wartet darauf vor dem Neuzeichnen');
    assert.equal(el.calls.length, 1, 'genau eine Animation');
    const up = scalesOf(el.calls[0].keyframes);
    assert.equal(up.length, 3, 'Ruhe - Ausschlag - Ruhe: ein Richtungswechsel, nicht vier');
    assert.equal(up[0], 1);
    assert.equal(up[2], 1);
    assert.ok(up[1] > 1 && up[1] <= 1.2, `Abhaken schwingt einmal ueber (${up[1]})`);
    assert.equal(el.calls[0].timing.duration, 200, '--duration-md');
    assert.equal(el.calls[0].timing.fill, undefined, 'kein fill: am Ende gilt das Stylesheet');
    assert.deepEqual(el.style, {}, 'kein Inline-Stil, keine Klasse');

    const back = motionEl('zurueck');
    await acknowledgeCheck(back, { checked: false });
    const down = scalesOf(back.calls[0].keyframes);
    assert.ok(down[1] < 1 && down[1] >= 0.85, `Zuruecknehmen gibt einmal nach (${down[1]})`);
    assert.equal(back.calls[0].timing.duration, 150, '--duration-sm: der Rueckweg ist kuerzer');

    // Ein zweiter Tipp auf denselben Haken bricht die laufende Quittung ab.
    const twice = motionEl('doppelt');
    acknowledgeCheck(twice, { checked: true });
    await acknowledgeCheck(twice, { checked: false });
    assert.equal(twice.cancelled, 1);
    assert.equal(twice.calls.length, 2);

    await acknowledgeCheck(null); // nichts zu tun
  } finally { restore(); }
});

test('acknowledgeCheck: reduzierte Bewegung und verdeckter Tab bewegen nichts und halten niemanden auf', async () => {
  for (const env of [{ reduced: true }, { visibility: 'hidden' }]) {
    const restore = motionEnv(env);
    try {
      const { acknowledgeCheck } = await import('../public/utils/ux.js');
      const el = motionEl('haken');
      await acknowledgeCheck(el, { checked: true });
      assert.equal(el.calls.length, 0, JSON.stringify(env));
    } finally { restore(); }
  }
});

test('R18: jeder Abhak-Handler quittiert selbst - die Zeilen-Auffrischung nicht', () => {
  const shopping = pageSource('shopping');
  const toggle = shopping.slice(shopping.indexOf('async function toggleShoppingItem('), shopping.indexOf('async function toggleShoppingItem(') + 2600);
  assert.match(toggle, /updateItemRow\(container, item\);[\s\S]{0,400}acknowledgeCheck\(checkOf\(container, id\), \{ checked: newVal === 1 \}\);/, 'Einkauf: Quittung im Tipp');
  // updateItemRow laeuft auch fuer fremde Aenderungen (Live-Auffrischung) und
  // beim Zuruecksetzen nach einem Fehler: dort hat niemand etwas beruehrt.
  const refresh = shopping.slice(shopping.indexOf('function updateItemRow('), shopping.indexOf('function refreshItemName('));
  assert.doesNotMatch(stripComments(refresh), /acknowledgeCheck/);

  const tasks = pageSource('tasks');
  assert.match(tasks, /const settled = acknowledgeCheck\(target, \{ checked: nextStatus === 'done' \}\);/, 'Aufgabe: Quittung laeuft neben dem Roundtrip');
  assert.match(tasks, /await toggleTaskStatus\(id, status\);\s*await settled;/, 'und das Neuzeichnen wartet auf sie');
  assert.match(tasks, /const settled = acknowledgeCheck\(target, \{ checked: subtaskDone \}\);[\s\S]{0,200}await toggleSubtaskStatus\(id, target\.dataset\.status\);\s*await settled;/, 'Teilaufgabe ebenso');
  assert.match(pageSource('housekeeping'), /const settled = acknowledgeCheck\(button, \{ checked: true \}\);/);
  assert.match(pageSource('notes'), /paintCheck\(noteId, line, checked\);\s*acknowledgeCheck\(box, \{ checked \}\);/, 'Notiz-Checkliste: am angetippten Kasten, nicht an jeder Ansicht');
  assert.match(publicSource('components/task-detail.js'), /paint\(checked\);\s*acknowledgeCheck\(box, \{ checked \}\);/, 'Checkliste in der Aufgabenbeschreibung');
  // Der alte Warter hing an `animationend` - das feuert die Web Animations API nicht.
  assert.doesNotMatch(publicSource('utils/ux.js'), /export function animationSettled/);
});

// --------------------------------------------------------------------------
// R18, Bewegung: "NEUE AUFGABE" SCHLIESST SOFORT. Der Dialog zeigte nach dem
// Speichern 700ms einen Haken im Knopf und schloss dann (gemessen: Ausgang
// beginnt 739-750ms nach dem Klick, Zeile sichtbar nach 887-901ms; Notizen
// schliessen in 25ms). Die Quittung einer angelegten Aufgabe ist die Zeile,
// die aufzieht - nicht ein Knopf, hinter dem sie wartet.
// --------------------------------------------------------------------------
test('R18: der Aufgaben-Dialog schliesst mit dem Speichern - die aufziehende Zeile ist die Quittung', () => {
  const tasks = stripComments(pageSource('tasks'));
  const save = tasks.slice(tasks.indexOf("const res = await api.post('/tasks', body);"), tasks.indexOf('async function handleRenameSubtask('));
  assert.ok(save.length > 500, 'Vorbedingung: der Speicherpfad ist gefunden');
  assert.doesNotMatch(save, /btnSuccess\(/, 'kein Haken im Knopf eines Dialogs, der schliesst');
  assert.doesNotMatch(save, /setTimeout\(\(\) => closeModal/, 'kein verzoegertes Schliessen');
  // Das Neuzeichnen steht in einem eigenen try: sein Fehler gehoert auf die
  // Seite, nicht an den geschlossenen Dialog (Review zu #1794, Test weiter unten).
  assert.match(save, /closeModal\(\{ force: true \}\);\s*try \{\s*await refreshTags\(\);\s*await onChanged\(\);/, 'schliessen, dann neu zeichnen');
  // Die Reihenfolge der Enthuellung bleibt: erst der Dialog weg, dann die
  // History wieder bei der Seite, dann die Zeile (sonst traegt `back()` die
  // alte Adresse wieder herein).
  assert.match(save, /whenModalClosed\(\)\s*\.then\(\(\) => whenHistorySettled\(\)\)\s*\.then\(\(\) => \{\s*revealCreatedTask\(container, savedTaskId\);\s*refocusAfterRender\(\);\s*\}\);/);
  // Der Dialog ist jetzt vor dem Neuzeichnen zu - der Fokus-Rueckweg muss nachgezogen werden.
  assert.match(save, /await onChanged\(\);\s*refocusAfterRender\(\);/);
  // Der Fehlerpfad der Dokument-Verknuepfung haelt das Formular weiter offen.
  assert.match(save, /resetSubmit\(t\('tasks\.documentsLinkFailed'\)\);\s*btnError\(submitBtn\);/);
  // btnSuccess bleibt als Baustein fuer Formulare, die OFFEN bleiben.
  assert.match(publicSource('components/modal.js'), /export function btnSuccess\(/);
});

// --------------------------------------------------------------------------
// R18, Bewegung: DRILL-DOWN HAT EINE RICHTUNG. Einstellungen mobil, Uebersicht
// <-> Blatt: 0 Animationen in drei Messungen (der Soft-Update-Zweig des
// Routers ruft `startViewTransition` nie). Gesundheit, Bereich hin und
// zurueck: nur die richtungslose Blende.
//
// BENANNTE AUSNAHME zur Regel "der Seiteninhalt blendet nur - kein Versatz"
// (Guard weiter oben): die gilt dem TAB-WECHSEL - Geschwister ohne Raumbezug,
// das Chrome steht. Ein Drill-down ist eine Ebene tiefer im SELBEN Modul; dort
// sagt die Richtung, wohin Zurueck fuehrt. Er laeuft nicht ueber
// `.page-transition--*`, sondern ueber `swapContent(host, ..., { direction })`:
// 8px, RTL-fest, unter reduzierter Bewegung nur die Blende (alles oben am
// Helfer getestet). Hinein +1, zurueck -1 - und nur dort, wo die Ebenen
// einander ERSETZEN: neben der Seitenleiste bzw. in der Split-Ansicht bleibt
// es bei der Blende.
// --------------------------------------------------------------------------
const DRILL_DOWN_HOSTS = [
  ['settings/shell.js', /const drill = existingShell && !isSplit\(shell\) && wasLeaf !== Boolean\(activeLeaf\)\s*\? \(activeLeaf \? 1 : -1\)\s*: 0;/, 'Einstellungen: Uebersicht <-> Blatt, nur ohne Seitenleiste'],
  ['settings/shell.js', /if \(drill\) swapContent\(content, null, \{ direction: drill \}\);\s*if \(toolbar\) renderToolbar\(toolbar, content, \{ activeLeaf, domain: leafDomain \}\);\s*await renderLeafContent\(/, 'Einstellungen: das Blatt gleitet mit seinem Geruest herein - vor dem Laden gestartet, nicht danach'],
  ['settings/shell.js', /renderOverview\(content, domains, user\);[\s\S]{0,200}if \(drill\) swapContent\(content, null, \{ direction: drill \}\);/, 'Einstellungen: zurueck zur Uebersicht'],
  ['pages/health.js', /const drill = !narrow \? 0 : id === HEALTH_OVERVIEW_ID \? -1 : previous === HEALTH_OVERVIEW_ID \? 1 : 0;\s*if \(previous && previous !== id\) markAreaEntering\(route, drill\);/, 'Gesundheit: Uebersicht <-> Bereich, nur schmal'],
  ['pages/health.js', /if \(panel\) swapContent\(panel, null, \{ direction \}\);/, 'Gesundheit: ueber den geteilten Helfer'],
];

test('R18: Drill-down gleitet mit Richtung - hinein +1, zurueck -1, ueber swapContent', () => {
  const missing = DRILL_DOWN_HOSTS.filter(([file, pattern]) => !pattern.test(publicSource(file))).map(([file, , what]) => `${file}: ${what}`);
  assert.deepEqual(missing, [], `Drill-down ohne Richtung:\n  ${missing.join('\n  ')}`);
  // Die Ausnahme oeffnet die Tab-Regel nicht: keine `.page-transition--*`-Regel
  // versetzt, und kein Drill-down haengt eine solche Klasse an.
  for (const [file] of DRILL_DOWN_HOSTS) assert.doesNotMatch(publicSource(file), /page-transition--/, `${file} greift in die Seitenblende`);
  // Kein Doppel: das Blatt, das hereingleitet, traegt nicht zusaetzlich die Blattwechsel-Blende.
  assert.match(publicSource('settings/shell.js'), /const swapping = Boolean\(content\.querySelector\(':scope > \.settings-leaf'\)\);/);
});

// --------------------------------------------------------------------------
// R18, Bewegung: ZEILEN UND KARTEN QUITTIEREN DEN TIPP, UND HOVER KLEBT NICHT.
//
// Gemessen: keine `:active`-Regel an Listenzeilen, Aufgabenkarten, Heute-
// Karten, Einstellungszeilen; rund 250 `:hover`-Regeln, davon 5 unter
// `@media (hover: hover)`. Auf einem Touch-Geraet bleibt `:hover` nach dem
// Tipp am Element haengen, bis woanders getippt wird - die Zeile sah nach dem
// Loslassen weiter "beruehrt" aus und hatte waehrenddessen nichts gezeigt.
//
// Die Regel fuer die GETEILTEN Bausteine (nicht fuer alle 250 Stellen):
//   - ihre Hover-Flaeche steht unter `@media (hover: hover)`;
//   - sie tragen ein `:active` - ueber den einen Press-Baustein in
//     list-row.css oder (Karten mit eigenem Druckbild) ueber eine eigene Regel.
// Fuer den Rest gilt ein Ratchet: die Zahl der ungeschuetzten `:hover`-Regeln
// darf nicht steigen.
// --------------------------------------------------------------------------
const SHARED_PRESSABLE = [
  // [Selektor des Bausteins, Selektor im Press-Baustein | 'own' fuer eine eigene :active-Regel]
  ['.list-row', 'a.list-row'],
  ['.task-card', '.task-card'],
  ['.tasks-page .task-card', '.task-card'],
  ['.shopping-page .shopping-item', '.shopping-item:not(.shopping-item--static)'],
  ['.today-cockpit-card[data-route]', '.today-cockpit-card[data-route]'],
  ['.today-cockpit-card--group', '.today-cockpit-card--group'],
  ['.today-cockpit__more--link', '.today-cockpit__more--link'],
  ['.quick-link-tile', '.quick-link-tile'],
  ['.widget__link', '.widget__link'],
  ['.settings-shell__navigation-link', '.settings-shell__navigation-link'],
  ['.settings-overview__row', '.settings-overview__row'],
  ['.metric-card--tile', 'own'],
  ['.card--interactive', 'own'],
  ['.more-item', 'own'],
];
/** Hoechststand der `:hover`-Regeln ausserhalb von `@media (hover: hover)`. Nur senken. */
const UNGUARDED_HOVER_MAX = 240;

function hoverRules() {
  const out = [];
  for (const file of allSheets) {
    for (const rule of eachRule(css(file))) {
      if (!/:hover/.test(rule.selector)) continue;
      out.push({ file, selectors: selectorList(rule.selector), guarded: rule.at.some((a) => /\(hover:\s*hover\)/.test(a)) });
    }
  }
  return out;
}

function pressRule() {
  return [...eachRule(css('list-row.css'))].find((r) => /^:is\(/.test(r.selector.trim()) && /:active/.test(r.selector) && /--duration-2xs/.test(r.body));
}

test('R18: geteilte Zeilen und Karten tragen Hover nur unter (hover: hover) und quittieren den Druck', () => {
  const hovers = hoverRules();
  const press = pressRule();
  assert.ok(press, 'der Press-Baustein in list-row.css fehlt');
  const pressSelectors = selectorList(press.selector.trim().replace(/^:is\(/, '').replace(/\):active[\s\S]*$/, ''));
  const failures = [];
  for (const [base, via] of SHARED_PRESSABLE) {
    const own = hovers.filter((h) => h.selectors.includes(`${base}:hover`));
    if (!own.length) failures.push(`${base}: keine Hover-Regel mehr - Eintrag streichen`);
    for (const h of own) if (!h.guarded) failures.push(`${h.file}: ${base}:hover steht ausserhalb von @media (hover: hover)`);
    if (via === 'own') {
      const leaf = base.split(/\s+/).pop();
      const has = allSheets.some((file) => [...eachRule(css(file))].some((r) => selectorList(r.selector).some((s) => s.replace(/\s+/g, ' ') === `${leaf}:active`)));
      if (!has) failures.push(`${base}: keine eigene :active-Regel`);
    } else if (!pressSelectors.includes(via)) {
      failures.push(`${base}: ${via} fehlt im Press-Baustein`);
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('R18: der Press-Baustein - vorhandene Zustandsflaeche, hinein 80ms, nie unter dem Wisch und nie fuer ein inneres Ziel', () => {
  const press = pressRule();
  assert.match(press.body, /background-color:\s*var\(--color-surface-hover\)/, 'die vorhandene neutrale Zustandsstufe - ihre Kontraste sind gehalten, keine neue Zahl');
  assert.match(press.body, /transition-duration:\s*var\(--duration-2xs\)/, 'hinein schnell; heraus gilt die Dauer der Ruhe-Regel');
  assert.match(press.selector, /:not\(\.swipe-row--swiping \*\)/, 'eine gezogene Wischzeile sieht nicht gedrueckt aus');
  assert.match(press.selector, /:not\(:has\(:is\([^)]*button[^)]*\):not\(\.u-row-title\):active\)\)/, 'ein Knopf IN der Zeile drueckt die Zeile nicht mit - ausser ihr Titel');
  // Zurueckgenommene Zeilen behalten ihre Flaeche (#1230) - der Baustein schluege sie sonst mit (0,4,1).
  for (const word of ['done', 'checked', 'archived', 'paused', 'inactive', 'completed']) {
    assert.ok(press.selector.includes(`[class*="--${word}"]`), `--${word} ist nicht vom Druckbild ausgenommen`);
  }
  // Heraus langsamer: die Bausteine tragen in Ruhe eine laengere Dauer.
  const out = ruleBodies('list-row.css', '.list-row').join(';');
  assert.match(out, /transition:\s*background-color var\(--transition-fast\)/);
  const tokens = css('tokens.css');
  const ms = (name) => Number(tokens.match(new RegExp(`${name}:\\s*(\\d+)ms`))?.[1]);
  assert.ok(ms('--duration-2xs') < ms('--duration-sm'), 'Druck schneller als Loslassen');
  // Keine Bewegung: reduzierte Bewegung braucht keinen eigenen Zweig.
  assert.doesNotMatch(press.body, /transform|scale|translate/);
});

test('R18: die Zahl der ungeschuetzten :hover-Regeln steigt nicht (Ratchet)', () => {
  const open = hoverRules().filter((h) => !h.guarded);
  assert.ok(open.length <= UNGUARDED_HOVER_MAX,
    `${open.length} :hover-Regeln ausserhalb von @media (hover: hover), erlaubt sind ${UNGUARDED_HOVER_MAX}. Neue Hover-Flaechen gehoeren unter (hover: hover) - auf Touch klebt :hover nach dem Tipp.`);
  // Wer aufraeumt, senkt die Zahl mit: ein zu hoher Deckel liesse neue Stellen durch.
  assert.ok(open.length >= UNGUARDED_HOVER_MAX - 3, `nur noch ${open.length} ungeschuetzt - UNGUARDED_HOVER_MAX auf ${open.length} senken`);
});

// --------------------------------------------------------------------------
// R18, Bewegung: DAS CHROME STEHT BEIM SEITENWECHSEL (mobil gemessen).
//
//  a) Die Kapsel verlor fuer die Dauer der Blende ihr Glas: der Name
//     `nav-bottom` sass am ELTERNKNOTEN `.nav-bottom`, der damit Backdrop Root
//     war - der `backdrop-filter` der Kapsel darin sah nur noch Transparenz,
//     Zeilentext lief scharf durch sie hindurch (Zwischenbild bei 67ms).
//     Jetzt traegt das GLAS-ELEMENT selbst den Namen: der Browser uebernimmt
//     dessen `backdrop-filter` an die Gruppe des Uebergangs, und die blurrt
//     das Wurzelbild darunter. Die Pille daneben bekommt ihren eigenen Namen,
//     sonst laege sie im Wurzelbild UNTER dem Glas.
//  b) Der FAB poppte bei JEDEM Tab-Wechsel neu herein (`fab-in`, 4 von 4): er
//     ist ein neuer Knoten je Seite. Jetzt steht er wie der Kopf (eigener Name
//     nur fuer die Dauer), und `fab-in` spielt nur, wenn die Vorseite keinen
//     hatte - also auch beim Kaltstart.
//  c) Die Tab-Leiste sprang, wenn die Zielseite ihren FAB erst nach den Daten
//     anlegt: die FAB-Reserve der Kapsel fiel dazwischen weg. Sie haelt jetzt
//     bis zum Ende des Aufbaus.
//  d) Das gestaffelte Einblenden der Zeilen lief UNTER der Blende mit - zwei
//     Einblendungen fuer einen Wechsel. Waehrend `html.page-swapping` staffelt
//     nichts; die Blende traegt die Zeilen.
// --------------------------------------------------------------------------
const namedRules = () => {
  const out = [];
  for (const file of allSheets) {
    for (const rule of eachRule(css(file))) {
      const name = declValue(rule.body, 'view-transition-name');
      if (!name || name === 'none') continue;
      for (const sel of selectorList(rule.selector)) out.push({ file, selector: sel.replace(/\s+/g, ' '), name });
    }
  }
  return out;
};

test('R18: die Kapsel behaelt ihr Glas - der Name sitzt am Glas-Element, nicht an seinem Elternknoten', () => {
  const named = namedRules();
  const byName = (name) => named.filter((r) => r.name === name).map((r) => r.selector);
  assert.deepEqual(byName('nav-bottom'), ['html.page-swapping .nav-bottom__items'], 'genau EIN Traeger je Name - ein doppelter verwirft die ganze Transition');
  assert.deepEqual(byName('nav-bottom-indicator'), ['html.page-swapping .nav-bottom__indicator']);
  assert.deepEqual(byName('page-fab'), ['html.page-swapping .fab-layer .page-fab'], 'nur der schwebende FAB der Ebene: dort steht hoechstens einer');
  // Das benannte Element IST das Glas (sonst haette die Gruppe nichts zu uebernehmen).
  const glass = [...glassAncestors().keys()];
  assert.ok(glass.some((k) => k.endsWith(': .nav-bottom__items')), 'die Kapsel traegt den backdrop-filter selbst');
  // Jeder Name nur waehrend des Wechsels.
  for (const r of named.filter((n) => /^(?:nav-|page-fab)/.test(n.name))) assert.match(r.selector, TRANSIENT_GATE, `${r.selector} traegt ${r.name} dauerhaft`);

  // Die Gruppen stehen (kein Gleiten), das alte Bild entfaellt, das neue lebt ohne Blende.
  const layout = [...eachRule(css('layout.css'))];
  const rule = (needle) => layout.filter((r) => selectorList(r.selector).some((s) => s.replace(/\s+/g, ' ') === needle));
  for (const name of ['nav-bottom', 'nav-bottom-indicator', 'page-fab']) {
    assert.ok(rule(`::view-transition-group(${name})`).some((r) => /animation:\s*none/.test(r.body)), `Gruppe ${name} gleitet`);
    assert.ok(rule(`::view-transition-old(${name}):not(:only-child)`).some((r) => /display:\s*none/.test(r.body)), `altes Bild von ${name} bleibt als Geist stehen`);
    assert.ok(rule(`::view-transition-new(${name}):not(:only-child)`).some((r) => /animation:\s*none/.test(r.body)), `neues Bild von ${name} blendet`);
  }
  // Der backdrop-filter der Gruppe folgt ihrem Kasten: ohne Radius blurrte ein
  // Rechteck ueber die Rundung der Kapsel hinaus (im Zwischenbild gesehen).
  for (const name of ['nav-bottom', 'page-fab']) {
    assert.ok(rule(`::view-transition-group(${name})`).some((r) => /border-radius:\s*var\(--radius-full\)/.test(r.body)), `Gruppe ${name} ohne Rundung`);
  }
  assert.match(ruleBodies('layout.css', '.nav-bottom__items').join(';'), /border-radius:\s*var\(--radius-full\)/, 'die Kapsel selbst ist voll gerundet - sonst passt die Gruppe nicht');
});

test('R18: der FAB steht ueber den Wechsel, poppt nur ohne Vorgaenger, und seine Reserve haelt bis zum Ende des Aufbaus', () => {
  const router = stripComments(publicSource('router.js'));
  const swap = router.slice(router.indexOf('const swap = () => {'), router.indexOf('await swapPage(swap,'));
  assert.ok(swap.length > 300, 'Vorbedingung: der Tausch-Callback ist gefunden');
  // VOR dem Tausch gefragt - danach gibt es den alten FAB nicht mehr: der
  // schwebende faellt mit clearPageFab(), der im Kopf angedockte (Desktop)
  // schon mit `content.replaceChildren()`. (Im Browser gesehen: an der zweiten
  // Stelle gefragt, poppte die Kapsel "+ Neu" am Desktop weiter bei jedem Wechsel.)
  const held = swap.indexOf('holdFabAcrossSwap(');
  assert.ok(held >= 0 && held < swap.indexOf('content.replaceChildren(pageWrapper)') && held < swap.indexOf('clearPageFab();'), 'der Vorgaenger wird vor dem Inhaltstausch festgehalten');
  const hold = router.slice(router.indexOf('function holdFabAcrossSwap('), router.indexOf('function holdFabAcrossSwap(') + 700);
  assert.match(hold, /classList\.toggle\('fab-steady', /, 'fab-in nur ohne Vorgaenger');
  assert.match(hold, /classList\.toggle\('fab-holding', /, 'die Reserve der Kapsel haelt');
  // Losgelassen wird nach dem letzten adoptPageFab() - und auch, wenn der Aufbau scheitert.
  assert.match(router, /const pageFab = adoptPageFab\(\);\s*releaseFabHold\(\);/);
  const render = router.slice(router.indexOf('async function renderPage('), router.indexOf('const pageFab = adoptPageFab();'));
  const tail = router.slice(router.indexOf('const pageFab = adoptPageFab();'));
  assert.match(tail.slice(0, tail.indexOf('\nasync function ') > 0 ? tail.indexOf('\nasync function ') : 6000), /\} catch \(err\) \{[\s\S]{0,400}releaseFabHold\(\);/, 'ein gescheiterter Aufbau laesst die Reserve nicht stehen');
  assert.ok(render.length > 0);

  assert.match(ruleBodies('layout.css', 'html.fab-steady .page-fab').join(';'), /animation:\s*none/);
  const reserve = [...eachRule(css('layout.css'))].find((r) => /padding-inline-end:\s*calc\(var\(--fab-size\)/.test(r.body) && /\.nav-bottom__items/.test(r.selector));
  assert.ok(reserve, 'die FAB-Reserve der Kapsel fehlt');
  assert.ok(selectorList(reserve.selector).map((s) => s.replace(/\s+/g, ' ')).includes('html.fab-holding .nav-bottom__items'), 'die Reserve haelt waehrend des Aufbaus');
  // Kaltstart: die Einfahrt gibt es weiter.
  assert.match(ruleBodies('layout.css', '.page-fab').join(';'), /animation:\s*fab-in var\(--duration-xl\) var\(--ease-out\) backwards/);
});

test('R18: stagger startet nicht unter der Seitenblende - und holt es danach nicht nach', async () => {
  const restore = motionEnv();
  const classes = new Set(['page-swapping']);
  globalThis.document.documentElement.classList = { contains: (c) => classes.has(c) };
  try {
    const { stagger } = await import('../public/utils/ux.js');
    const host = motionEl('host');
    const rows = [motionEl('a'), motionEl('b')];
    stagger(rows, { host });
    assert.equal(rows[0].style.opacity, undefined, 'unter der Blende setzt nichts die Zeilen auf 0');
    assert.equal(rows[0].style.transform, undefined);
    // Die Blende WAR das Einblenden dieses Aufbaus: ein spaeteres Neuzeichnen staffelt nicht nach.
    classes.delete('page-swapping');
    const again = [motionEl('a'), motionEl('b')];
    stagger(again, { host });
    assert.equal(again[0].style.opacity, undefined, 'der Merker ist verbraucht');
    // Ohne Seitenwechsel (Kaltstart, Reiter im Modul) staffelt es wie bisher.
    const fresh = [motionEl('x')];
    stagger(fresh, { host: motionEl('anderer') });
    assert.equal(fresh[0].style.opacity, '0');
  } finally { restore(); }
  await new Promise((r) => setTimeout(r, 500));
});

// --------------------------------------------------------------------------
// R18, Bewegung: DIE BLATT-GESTE WIRD ZU ENDE GEFUEHRT.
//
// Nach einem Flick loeste sich das Blatt AM ORT auf: der Tipp-Ausgang
// (`sheet-out`: 24px + Deckkraft) lief dort los, wo der Finger es liess - rund
// 150px unter der Ruhelage. Das Tempo des Fingers entschied nur Ja/Nein und
// ging dann verloren, die Abdunklung blieb waehrend des Zugs voll.
//
// Die Guards (1) und (4) oben gelten den KEYFRAMES des Tipp- und Esc-Ausgangs
// (kurzer Hub, entschieden am 05.10.) - die bleiben. Der GESTEN-Ausgang ist ein
// eigener Fall: per Web Animations API auf `translate` (setzt sich mit dem
// `transform` der Keyframes zusammen), von der Lage des Fingers aus dem Bild.
// --------------------------------------------------------------------------
function gestureSheet({ height = 500, top = 300, animate = true } = {}) {
  const handlers = {};
  const attrs = {};
  const calls = [];
  let translate = '';
  let clock = 1000;
  const panel = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    removeEventListener: () => {},
    getBoundingClientRect: () => ({ top, height }),
    setAttribute: (k, v) => { attrs[k] = v; },
    removeAttribute: (k) => { delete attrs[k]; },
    getAttribute: (k) => attrs[k] ?? null,
    style: { get translate() { return translate; }, set translate(v) { translate = v; } },
  };
  if (animate) {
    panel.animate = (keyframes, timing) => {
      const anim = { keyframes, timing, cancelled: false, finished: new Promise(() => {}), cancel() { anim.cancelled = true; } };
      calls.push(anim);
      return anim;
    };
  }
  const at = (y, dt = 16) => { clock += dt; return { timeStamp: clock, touches: [{ clientY: y }], changedTouches: [{ clientY: y }] }; };
  return {
    panel, attrs, calls,
    get translate() { return translate; },
    start: (y) => handlers.touchstart(at(y, 0)),
    move: (y, dt) => handlers.touchmove(at(y, dt)),
    end: (y, dt) => handlers.touchend(at(y, dt)),
  };
}

function dimEl() {
  const props = new Map();
  const calls = [];
  return {
    props, calls,
    style: { setProperty: (k, v) => props.set(k, String(v)), removeProperty: (k) => props.delete(k) },
    animate: (keyframes, timing) => { calls.push({ keyframes, timing }); return { finished: new Promise(() => {}), cancel() {} }; },
  };
}

test('Blatt-Geste: nach dem Flick faehrt das Blatt von der Lage des Fingers aus dem Bild - Dauer aus Reststrecke und Tempo', async () => {
  const restore = motionEnv();
  globalThis.requestAnimationFrame = (fn) => fn();
  try {
    const { wireSheetDrag, travelDuration } = await import('../public/utils/sheet-drag.js');
    let dismissed = 0;
    const sheet = gestureSheet({ height: 500 });
    wireSheetDrag(sheet.panel, { onDismiss: () => { dismissed += 1; } });
    // 60px in 32ms, dann los: 1,875px/ms. Versatz 50px (60 minus Schwelle).
    sheet.start(600);
    sheet.move(630, 16);
    sheet.move(660, 16);
    sheet.end(660, 1);
    assert.equal(dismissed, 1);
    assert.equal(sheet.calls.length, 1, 'genau ein Flug');
    const fly = sheet.calls[0];
    assert.deepEqual(fly.keyframes, [{ translate: '0px 50px', opacity: 1 }, { translate: '0px 500px', opacity: 1 }], 'von der Lage des Fingers ueber die eigene Hoehe hinaus - ohne Aufloesen');
    assert.equal(fly.timing.fill, 'forwards', 'bleibt draussen, bis das Blatt abgebaut bzw. zurueckgesetzt ist');
    // (500 - 50) / ~1,82 px/ms waeren rund 247ms -> geklemmt auf die Dauer des Ausgangs.
    assert.equal(fly.timing.duration, 200, 'hoechstens --duration-md: der Ausgang bleibt kuerzer als die Einfahrt (300ms)');
    // Die Klemme selbst.
    assert.equal(travelDuration(450, 3, { min: 120, max: 200 }), 150, 'Weg / Tempo');
    assert.equal(travelDuration(450, 30, { min: 120, max: 200 }), 120, 'nie kuerzer als --duration-xs');
    assert.equal(travelDuration(450, 0, { min: 120, max: 200 }), 200, 'ohne Tempo (langsam ueber die Schwelle gezogen) die volle Dauer');
    assert.equal(travelDuration(450, -2, { min: 120, max: 200 }), 200, 'ein Tempo gegen die Richtung beschleunigt nichts');
  } finally { delete globalThis.requestAnimationFrame; restore(); }
});

test('Blatt-Geste: ein schneller Flick an einem kurzen Blatt ist schneller draussen', async () => {
  const restore = motionEnv();
  globalThis.requestAnimationFrame = (fn) => fn();
  try {
    const { wireSheetDrag } = await import('../public/utils/sheet-drag.js');
    const sheet = gestureSheet({ height: 300 });
    wireSheetDrag(sheet.panel, { onDismiss: () => {} });
    sheet.start(600);
    sheet.move(660, 16);
    sheet.move(720, 16);
    sheet.end(720, 1); // ~3,6px/ms, Rest 190px -> ~52ms -> geklemmt auf 120
    assert.equal(sheet.calls[0].timing.duration, 120);
  } finally { delete globalThis.requestAnimationFrame; restore(); }
});

test('Blatt-Geste: unter der Schwelle federt es mit dem Tempo des Loslassens zurueck - der Endzustand haengt an keiner Animation', async () => {
  const restore = motionEnv();
  globalThis.requestAnimationFrame = (fn) => fn();
  try {
    const { wireSheetDrag } = await import('../public/utils/sheet-drag.js');
    let dismissed = 0;
    const sheet = gestureSheet({ height: 500 });
    wireSheetDrag(sheet.panel, { onDismiss: () => { dismissed += 1; } });
    sheet.start(600);
    sheet.move(630, 200);
    sheet.move(650, 200);
    sheet.end(650, 400); // 50px, Finger steht: kein Schliessen
    assert.equal(dismissed, 0);
    assert.equal(sheet.translate, '', 'der Versatz ist sofort weg - die Feder liegt nur darueber');
    assert.equal(sheet.calls.length, 1);
    const back = sheet.calls[0];
    assert.deepEqual(back.keyframes, [{ translate: '0px 40px' }, { translate: '0px 0px' }]);
    assert.equal(back.timing.fill, undefined, 'kein fill: am Ende gilt das Stylesheet');
    assert.equal(back.timing.duration, 250, 'ohne Tempo --duration-lg, wie die Transition davor');
    assert.equal(sheet.attrs['data-sheet-drag'], 'drag', 'solange die Feder laeuft, schweigt die CSS-Transition darunter - sonst spraenge das Blatt an ihrem Ende');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(sheet.attrs['data-sheet-drag'], undefined, 'die Marke faellt per Timer, nicht per finish');
  } finally { delete globalThis.requestAnimationFrame; restore(); }
});

test('Blatt-Geste: die Abdunklung folgt dem Zug, kehrt beim Zurueckfedern zurueck und haelt beim Schliessen', async () => {
  const restore = motionEnv();
  globalThis.requestAnimationFrame = (fn) => fn();
  try {
    const { wireSheetDrag } = await import('../public/utils/sheet-drag.js');
    const dim = dimEl();
    const sheet = gestureSheet({ height: 400 });
    const drag = wireSheetDrag(sheet.panel, { onDismiss: () => {}, dim: () => dim, resetAfterDismiss: true });
    sheet.start(600);
    sheet.move(710, 300); // Versatz 100px von 400px
    assert.equal(dim.props.get('--sheet-pull'), '0.25', 'Anteil des Zugs an der Blatthoehe - das Stylesheet macht daraus opacity');
    sheet.move(650, 300); // zurueck auf 40px
    assert.equal(dim.props.get('--sheet-pull'), '0.1');
    sheet.end(650, 400);
    assert.equal(dim.props.has('--sheet-pull'), false, 'zurueckgefedert: volle Abdunklung');
    assert.deepEqual(dim.calls[0]?.keyframes, [{ opacity: 0.9 }, { opacity: 1 }], 'und sie kehrt mit dem Blatt zurueck, nicht in einem Sprung');

    // Schliessen: der Wert bleibt, bis das Blatt zurueckgesetzt ist - sonst
    // spraenge die Abdunklung auf voll, waehrend das Blatt hinausfaehrt.
    sheet.start(600);
    sheet.move(760, 300);
    sheet.end(760, 100);
    assert.equal(dim.props.get('--sheet-pull'), '0.375');
    const fly = sheet.calls.at(-1);
    assert.equal(fly.timing.fill, 'forwards');
    drag.reset();
    assert.equal(dim.props.has('--sheet-pull'), false);
    assert.equal(fly.cancelled, true, 'das Mehr-Blatt bleibt im DOM: der Flug darf es beim naechsten Oeffnen nicht draussen halten');
  } finally { delete globalThis.requestAnimationFrame; restore(); }
});

test('Blatt-Geste: ohne animate oder unter reduzierter Bewegung bleibt es beim Ausgang des Stylesheets', async () => {
  for (const [name, env, opts] of [['reduzierte Bewegung', { reduced: true }, {}], ['kein animate', {}, { animate: false }]]) {
    const restore = motionEnv(env);
    globalThis.requestAnimationFrame = (fn) => fn();
    try {
      const { wireSheetDrag } = await import('../public/utils/sheet-drag.js');
      let dismissed = 0;
      const sheet = gestureSheet(opts);
      wireSheetDrag(sheet.panel, { onDismiss: () => { dismissed += 1; } });
      sheet.start(600); sheet.move(700, 16); sheet.end(700, 1);
      assert.equal(dismissed, 1, name);
      assert.equal(sheet.calls.length, 0, `${name}: kein Flug`);
      sheet.start(600); sheet.move(640, 300); sheet.end(640, 400);
      assert.equal(sheet.calls.length, 0, `${name}: keine Feder`);
      assert.equal(sheet.attrs['data-sheet-drag'], undefined, `${name}: die Transition des Stylesheets federt`);
    } finally { delete globalThis.requestAnimationFrame; restore(); }
  }
});

test('Blatt-Geste: Verdrahtung - das Mehr-Blatt reicht seinen Backdrop durch, dessen Deckkraft folgt der Custom Property', () => {
  assert.match(publicSource('router.js'), /wireSheetDrag\(sheet, \{[\s\S]{0,200}resetAfterDismiss: true,[\s\S]{0,160}dim: \(\) => backdrop,/);
  const backdrop = ruleBodies('layout.css', '.more-backdrop').join(';');
  assert.match(backdrop, /opacity:\s*calc\(1 - var\(--sheet-pull, 0\)\)/, 'nur opacity - kein Layout, kein Neuzeichnen der Flaeche');
  // Der Tipp-/Esc-Ausgang bleibt der kurze Hub (Entscheidung 05.10.).
  assert.match(keyframesBody('sheet-out'), /translateY\(var\(--sheet-lift\)\)/);
  // Der Helfer schreibt weiter `translate`, nie `transform` (eine gefuellte Einfahrt schluege es).
  const src = stripComments(publicSource('utils/sheet-drag.js'));
  assert.doesNotMatch(src, /transform/);
  // Und er mutiert das DOM nicht im touchend: Marke und Versatz fallen im rAF.
  const end = src.slice(src.indexOf('const end = (e) => {'), src.indexOf("sheet.addEventListener('touchend', end);"));
  assert.match(end, /raf\(\(\) => settle\(/);
});

// --------------------------------------------------------------------------
// R18, Bewegung: KLEINE HARTE KANTEN.
// --------------------------------------------------------------------------
test('R18: das Backdrop des FAB-Menues blendet ein und aus - und liegt in Ruhe weiter nicht im Baum (#166)', () => {
  const base = ruleBodies('dashboard.css', '.fab-backdrop').join(';');
  // #166: kein dauerhaft fixiertes Vollbild-Overlay - in Ruhe `display: none`.
  assert.match(base, /display:\s*none/);
  assert.match(base, /opacity:\s*0/);
  const transitions = [...base.matchAll(/transition:\s*([^;]+)/g)].map((m) => m[1]);
  assert.equal(transitions.length, 2, 'zwei Deklarationen: die erste ist der Rueckfall ohne allow-discrete');
  assert.doesNotMatch(transitions[0], /allow-discrete/);
  assert.match(transitions[1], /opacity var\(--duration-xs\) var\(--ease-out\),\s*display var\(--duration-xs\) allow-discrete/, 'der Ausgang haelt es fuer seine Dauer im Baum');
  const open = ruleBodies('dashboard.css', '.fab-backdrop--visible').join(';');
  assert.match(open, /display:\s*block/);
  assert.match(open, /opacity:\s*1/);
  assert.match(open, /opacity var\(--duration-md\) var\(--ease-out\)/, 'die Einfahrt ist laenger als der Ausgang');
  assert.match(css('dashboard.css'), /@starting-style \{\s*\.fab-backdrop--visible \{\s*opacity: 0;/);
});

test('R18: das Detail-Popover hat einen Ausgang - in der Grammatik des Popover-Menues', () => {
  const rules = animationRules();
  const exit = winner(rules, ['detail-popover', 'detail-popover--closing'], 1024);
  assert.ok(exit?.has.includes('detail-popover--closing'), 'der Ausgang schlaegt die Einfahrt');
  assert.match(exit.value, /^detail-popover-out var\(--duration-xs\) var\(--ease-out\) forwards$/);
  const out = keyframesBody('detail-popover-out');
  assert.match(out, /opacity:\s*0/);
  assert.match(out, /transform:\s*scale\(0\.96\)/, 'nimmt die 4 % zurueck wie das Menue');
  // Die Einfahrt bleibt die Blende: die Karte wird im selben Takt VERMESSEN
  // (positionPopover), und eine Startskalierung verfaelschte ihre Masse um 4 %.
  const enter = ruleBodies('detail-view.css', '.detail-popover').join(';');
  assert.match(enter, /animation:\s*detail-pane-enter var\(--duration-sm\) var\(--ease-out\)/, 'Einfahrt (150ms) laenger als der Ausgang (120ms)');
  assert.match(ruleBodies('detail-view.css', '.detail-popover.detail-popover--closing').join(';'), /pointer-events:\s*none/, 'der Ausgang nimmt keinen Zeiger mehr');
  // Der Ursprung kommt mit der Position aus JS - die Karte waechst vom Anker aus.
  const dv = publicSource('components/detail-view.js');
  assert.match(dv, /popover\.style\.transformOrigin = /);
  // Schliessen: Zustand sofort (Marker, Fokus, onClose), der Knoten geht nach dem Ausgang.
  const close = dv.slice(dv.indexOf('export function closeDetailView('), dv.indexOf('export function closeDetailView(') + 1800);
  assert.match(close, /leavePopover\(el\);/);
  assert.doesNotMatch(stripComments(close), /^\s*el\.remove\(\);/m, 'ein sofortiges remove() schnitte den Ausgang ab');
  const leave = dv.slice(dv.indexOf('function leavePopover('), dv.indexOf('function leavePopover(') + 900);
  assert.match(leave, /el\.removeAttribute\('id'\);/, 'die Kennung ist sofort frei - das naechste Popover traegt sie');
  assert.match(leave, /setTimeout\(\(\) => el\.remove\(\), durationToken\('--duration-xs', 120\) \+ 40\);/);
});

test('R18: der Leerzustand bleibt in der 300-ms-Regel - keine Verzoegerung am Knopf', () => {
  const tokens = css('tokens.css');
  const ms = (name) => Number(tokens.match(new RegExp(`${name}:\\s*(\\d+)ms`))?.[1]);
  const items = motionItems().filter((m) => !m.reduced && /^\.empty-state(?:__[\w-]+)?$/.test(m.selector) && m.kind === 'animation' && m.item !== 'none');
  assert.ok(items.some((m) => m.selector === '.empty-state'), 'Vorbedingung: der Leerzustand blendet weiter ein');
  for (const m of items) {
    const durations = [...m.item.matchAll(/var\((--duration-[\w-]+)\)/g)].map((d) => ms(d[1]));
    assert.ok(durations.length >= 1, `${m.selector}: Dauer aus einem Token`);
    assert.ok(durations.reduce((a, b) => a + b, 0) <= 300, `${m.selector}: ${m.item} - Dauer plus Verzoegerung ueber 300ms`);
  }
});

test('R18: die Vitalwert-Kurven zeichnen sich einmal ein (drawChartOnce), Raster und Achse stehen', () => {
  const health = pageSource('health');
  assert.match(health, /import \{[^}]*\bdrawChartOnce\b[^}]*\} from '\/utils\/ux\.js';/);
  const chart = health.slice(health.indexOf('function chartMarkup(metric, series'), health.indexOf('// Erfassungs-Modal'));
  assert.match(chart, /\$\{grid\}\s*<g class="health-chart__lines">\s*\$\{area\}\s*\$\{seriesSvg\}\s*<\/g>\s*\$\{xLabels\}/, 'Flaeche und Kurven in EINER Gruppe - an ihr haengt der Beschnitt');
  assert.match(health, /drawChartOnce\(`health-vitals-\$\{metric\.type\}`, \{ lines: host\.querySelector\('\.health-chart__lines'\) \}\);/, 'einmal je Messgroesse und Sitzung');
});

test('R18: der Theme-Wechsel blendet ueber die Wurzel - nur der gewaehlte, nicht der Nachtwechsel der Wand', async () => {
  const router = publicSource('router.js');
  const apply = router.slice(router.indexOf('applyTheme: (value) => {'), router.indexOf('applyTheme: (value) => {') + 2600);
  assert.match(apply, /swapTheme\(\(\) => \{/, 'der sichtbare Wechsel laeuft im Callback');
  assert.doesNotMatch(publicSource('utils/wall-mode.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''), /swapTheme|startViewTransition/, 'die Wand schaltet nachts ohne Blende');

  const { swapTheme } = await import('../public/utils/view-transition.js');
  // Mit API: der Tausch laeuft im Callback, die Klasse steht fuer die Dauer.
  const env = stubDocument();
  const classes = new Set();
  env.doc.documentElement = { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) } };
  globalThis.document = env.doc;
  globalThis.matchMedia = () => ({ matches: false });
  try {
    let ran = 0;
    const done = swapTheme(() => { ran += 1; assert.equal(classes.has('theme-swapping'), true); });
    assert.equal(ran, 0, 'erst das alte Bild, dann der Tausch');
    await Promise.resolve(); await Promise.resolve();
    assert.equal(ran, 1);
    assert.equal(classes.has('page-swapping'), false, 'kein Seitenwechsel: die Chrome-Namen bleiben aus');
    env.finish();
    await done;
    assert.equal(classes.has('theme-swapping'), false);
  } finally { delete globalThis.document; delete globalThis.matchMedia; }
  // Ohne API, verdeckt oder unter reduzierter Bewegung: direkt und synchron.
  for (const [name, e, reduce] of [['ohne API', stubDocument({ api: false }), false], ['verdeckt', stubDocument({ visibility: 'hidden' }), false], ['reduzierte Bewegung', stubDocument(), true]]) {
    globalThis.document = e.doc;
    globalThis.matchMedia = () => ({ matches: reduce });
    try {
      let ran = 0;
      swapTheme(() => { ran += 1; });
      assert.equal(ran, 1, `${name}: synchron`);
      assert.deepEqual(e.log, [], `${name}: keine Transition`);
    } finally { delete globalThis.document; delete globalThis.matchMedia; }
  }
  // Ein werfender Tausch (localStorage im Privatmodus) kommt beim Aufrufer an.
  globalThis.document = stubDocument({ api: false }).doc;
  globalThis.matchMedia = () => ({ matches: false });
  try { assert.throws(() => swapTheme(() => { throw new Error('quota'); }), /quota/); } finally { delete globalThis.document; delete globalThis.matchMedia; }
});

// --------------------------------------------------------
// Der Dialog ist zu - ein Fehler danach braucht einen Ort, den man sieht
// --------------------------------------------------------
// Seit "Neue Aufgabe" sofort schliesst, laeuft das Neuladen der Liste NACH dem
// Schliessen. Scheitert es, fing es der aeussere catch und schrieb die Meldung
// an Knopf und Fehlerzeile eines Dialogs, den es nicht mehr gibt: oben stand
// der gruene Toast "angelegt", die Liste blieb alt, und niemand erfuhr es
// (Codex zu #1794). Gespeichert IST die Aufgabe - deshalb eine Meldung auf der
// Seite und kein zweiter Versuch am Formular.
test('tasks: a failing reload after the dialog closed is reported on the page, not on the closed dialog', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/pages/tasks.js', import.meta.url), 'utf8');
  const submit = src.slice(src.indexOf('async function handleFormSubmit('));
  const closed = submit.indexOf('closeModal({ force: true });');
  assert.ok(closed > 0, 'der Dialog schliesst vor dem Neuladen');
  const after = submit.slice(closed, submit.indexOf('\n  } catch (err) {\n    resetSubmit(err.message);', closed));
  const reload = after.match(/try \{\s*await refreshTags\(\);\s*await onChanged\(\);[\s\S]*?\n    \} catch \((\w+)\) \{([\s\S]*?)\n    \}/);
  assert.ok(reload, 'das Neuladen nach dem Schliessen hat einen eigenen catch');
  assert.match(reload[2], /showToast\([\s\S]*?'danger'\)/, 'der Fehler steht als Toast auf der Seite');
  assert.doesNotMatch(reload[2], /resetSubmit|btnError/, 'nicht an Bedienelementen des geschlossenen Dialogs');
  assert.match(reload[2], /return;/, 'ohne frische Liste wird keine neue Zeile gesucht');
});
