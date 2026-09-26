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

test('kein Shorthand-Token mit einer zweiten Kurve in einer Transition', () => {
  // Welche --transition-*-Token Shorthands sind (Dauer UND Kurve), steht in
  // tokens.css - nicht in diesem Test.
  const tokens = css('tokens.css');
  const shorthandTokens = [...tokens.matchAll(/(--transition-[\w-]+)\s*:\s*([^;]+);/g)]
    .filter(([, , value]) => /\d(?:ms|s)\b/.test(value) && /(ease|linear|cubic-bezier|steps)/.test(value))
    .map(([, name]) => name);
  assert.ok(shorthandTokens.includes('--transition-fast'), 'Vorbedingung: --transition-fast ist ein Shorthand');

  const curve = /\b(?:ease|ease-in|ease-out|ease-in-out|linear)\b|cubic-bezier\(|steps\(|var\(--ease-[\w-]+\)|var\(--transition-[\w-]+\)/g;
  const failures = [];
  for (const file of allSheets) {
    for (const rule of eachRule(css(file))) {
      for (const decl of rule.body.matchAll(/(?:^|;)\s*(transition(?:-[\w-]+)?)\s*:\s*([^;]+)/g)) {
        // Auf oberster Ebene an Kommas trennen - `cubic-bezier(a, b, c, d)` nicht zerteilen.
        const items = [];
        let depth = 0;
        let cur = '';
        for (const ch of decl[2]) {
          if (ch === '(') depth += 1;
          if (ch === ')') depth -= 1;
          if (ch === ',' && depth === 0) { items.push(cur); cur = ''; } else cur += ch;
        }
        items.push(cur);
        for (const item of items) {
          if (!shorthandTokens.some((tok) => item.includes(`var(${tok})`))) continue;
          const curves = item.match(curve) ?? [];
          if (curves.length > 1) failures.push(`${file}: ${rule.selector} { ${decl[1]}: ${item.trim()} }`);
        }
      }
    }
  }
  assert.deepEqual(failures, [], `Ungueltige Transitions (zwei Kurven - die ganze Deklaration faellt weg):\n  ${failures.join('\n  ')}`);
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
  let resolveFinished;
  const doc = {
    visibilityState: visibility,
    startViewTransition: api
      ? (callback) => {
        log.push(`start old=${toolbarOld.style.viewTransitionName ?? ''}`);
        const updateCallbackDone = Promise.resolve().then(callback);
        return {
          updateCallbackDone,
          ready: updateCallbackDone,
          finished: new Promise((r) => { resolveFinished = r; }),
        };
      }
      : undefined,
  };
  return { doc, content, toolbarOld, toolbarNew, log, finish: () => resolveFinished() };
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
