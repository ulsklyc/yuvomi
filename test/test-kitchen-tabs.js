/**
 * Tests: Kitchen-Tabs Utility (pure functions)
 * Läuft mit: node --loader ./test-browser-loader.mjs test-kitchen-tabs.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { KITCHEN_ROUTES, KITCHEN_STORAGE_KEY, getLastKitchenRoute, isKitchenRoute } = await (async () => {
  global.window = { yuvomi: null };
  global.document = {
    createElement: () => ({
      className: '', dataset: {}, style: {},
      setAttribute() {}, appendChild() {},
      classList: { add() {}, toggle() {} },
      insertAdjacentElement() {},
      addEventListener() {},
    }),
  };
  const storage = {
    _d: {},
    getItem(k) { return this._d[k] ?? null; },
    setItem(k, v) { this._d[k] = v; },
  };
  global.sessionStorage = storage;
  global.t = (k) => k;
  return import('../public/utils/kitchen-tabs.js');
})();

test('KITCHEN_ROUTES enthält alle vier Sub-Routen in Kreislauf-Reihenfolge', () => {
  // planen → kochen → einkaufen → lagern (#596)
  assert.deepEqual(KITCHEN_ROUTES, ['/meals', '/recipes', '/shopping', '/pantry']);
});

test('KITCHEN_ROUTES ist eingefroren (kanonische Kitchen-Routen)', () => {
  assert.equal(Object.isFrozen(KITCHEN_ROUTES), true);
});

test('KITCHEN_STORAGE_KEY ist korrekt', () => {
  assert.equal(KITCHEN_STORAGE_KEY, 'yuvomi-kitchen-tab');
});

test('getLastKitchenRoute: Standardwert /meals wenn kein Storage-Eintrag', () => {
  global.sessionStorage._d = {};
  assert.equal(getLastKitchenRoute(), '/meals');
});

test('getLastKitchenRoute: gibt gespeicherte Route zurück', () => {
  global.sessionStorage._d = { 'yuvomi-kitchen-tab': '/recipes' };
  assert.equal(getLastKitchenRoute(), '/recipes');
});

test('getLastKitchenRoute: ignoriert ungültige gespeicherte Route', () => {
  global.sessionStorage._d = { 'yuvomi-kitchen-tab': '/admin' };
  assert.equal(getLastKitchenRoute(), '/meals');
});

test('isKitchenRoute: erkennt Kitchen-Routen', () => {
  assert.equal(isKitchenRoute('/meals'), true);
  assert.equal(isKitchenRoute('/recipes'), true);
  assert.equal(isKitchenRoute('/shopping'), true);
  assert.equal(isKitchenRoute('/pantry'), true);
});

test('isKitchenRoute: lehnt Nicht-Kitchen-Routen ab', () => {
  assert.equal(isKitchenRoute('/tasks'), false);
  assert.equal(isKitchenRoute('/'), false);
  assert.equal(isKitchenRoute('/calendar'), false);
  assert.equal(isKitchenRoute(''), false);
});

// --------------------------------------------------------
// Der geteilte Auswahl-Indikator (utils/segment-indicator.js, Re-Critique
// 2026-09-27, A1 P2-2): EINE Auswahl-Bewegung fuer jede Segment-Leiste, aus
// kitchen-tabs.js herausgeloest.
// --------------------------------------------------------
import { readFileSync } from 'node:fs';

const readSrc = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const seg = await import('../public/utils/segment-indicator.js');

/** Eine Leiste aus Attrappen: Eintraege mit fester Lage, eine Kapsel mit animate(). */
function fakeBar(items) {
  const animations = [];
  const attrs = (el) => {
    el._attrs = {};
    el.setAttribute = (k, v) => { el._attrs[k] = String(v); };
    el.removeAttribute = (k) => { delete el._attrs[k]; };
    el.hasAttribute = (k) => k in el._attrs;
    return el;
  };
  const children = items.map((it) => attrs({
    ...it,
    hidden: false,
    classList: new Set(it.active ? ['sub-tab', 'sub-tab--active'] : ['sub-tab']),
    matches(sel) { return sel.split(',').some((s) => s.trim() === '.sub-tab--active' && this.classList.has('sub-tab--active')); },
  }));
  const bar = {
    children,
    classList: { add() {}, remove() {} },
    querySelector: () => null,
    querySelectorAll: () => children,
    prepend(el) { this.indicator = el; },
    parentElement: null,
  };
  global.document.createElement = () => attrs({
    className: '',
    style: {},
    animate(frames, opts) { const a = { frames, opts, playState: 'running', cancel() { this.playState = 'idle'; } }; animations.push(a); return a; },
  });
  const handle = seg.attachSegmentIndicator(bar, { itemSelector: '.sub-tab' });
  const activate = (i) => children.forEach((c, k) => {
    if (k === i) c.classList.add('sub-tab--active'); else c.classList.delete('sub-tab--active');
  });
  return { bar, children, handle, animations, activate };
}

test('Indikator: steht beim Anhaengen unter dem aktiven Eintrag, ohne zu gleiten; der Eintrag gibt seine Flaeche ab', () => {
  const { handle, children, animations } = fakeBar([
    { offsetLeft: 10, offsetTop: 4, offsetWidth: 90, offsetHeight: 40, active: true },
    { offsetLeft: 104, offsetTop: 4, offsetWidth: 90, offsetHeight: 40 },
  ]);
  assert.equal(handle.indicator.style.transform, 'translate(10px, 4px)');
  assert.equal(handle.indicator.style.width, '90px');
  assert.equal(animations.length, 0, 'eine frische Leiste steht sofort');
  assert.ok(children[0].hasAttribute('data-seg-active'), 'der aktive Eintrag traegt die Marke, die ihm die Flaeche nimmt (sub-tabs.css)');
  assert.equal(handle.indicator.className, 'seg-indicator');
  assert.equal(handle.indicator._attrs['aria-hidden'], 'true');
});

test('Indikator: gleitet per transform mit --duration-lg/--ease-out; Breite nur, wenn sie sich aendert', () => {
  const same = fakeBar([
    { offsetLeft: 10, offsetTop: 4, offsetWidth: 90, offsetHeight: 40, active: true },
    { offsetLeft: 104, offsetTop: 4, offsetWidth: 90, offsetHeight: 40 },
  ]);
  same.activate(1);
  same.handle.place({ glide: true });
  assert.equal(same.animations.length, 1);
  assert.deepEqual(same.animations[0].frames, [{ transform: 'translate(10px, 4px)' }, { transform: 'translate(104px, 4px)' }],
    'gleich breite Segmente gleiten rein per transform - kein width/height');
  assert.equal(same.animations[0].opts.duration, 250, 'Rueckfall = --duration-lg');
  assert.ok(same.children[1].hasAttribute('data-seg-active') && !same.children[0].hasAttribute('data-seg-active'));

  const wide = fakeBar([
    { offsetLeft: 10, offsetTop: 4, offsetWidth: 90, offsetHeight: 40, active: true },
    { offsetLeft: 104, offsetTop: 4, offsetWidth: 130, offsetHeight: 40 },
  ]);
  wide.activate(1);
  wide.handle.place({ glide: true });
  assert.deepEqual(Object.keys(wide.animations[0].frames[0]).sort(), ['transform', 'width'], 'nur die Breite kommt dazu, die Hoehe nicht');
});

test('Indikator: reduzierte Bewegung springt', () => {
  global.matchMedia = (q) => ({ matches: /reduced-motion/.test(q) });
  try {
    const bar = fakeBar([
      { offsetLeft: 0, offsetTop: 0, offsetWidth: 80, offsetHeight: 40, active: true },
      { offsetLeft: 90, offsetTop: 0, offsetWidth: 80, offsetHeight: 40 },
    ]);
    bar.activate(1);
    bar.handle.place({ glide: true });
    assert.equal(bar.animations.length, 0);
    assert.equal(bar.handle.indicator.style.transform, 'translate(90px, 0px)');
  } finally {
    delete global.matchMedia;
  }
});

test('Indikator: eine ersetzte Leiste haengt ihre Observer selbst ab - Neurendern haeuft keine an', () => {
  // Codex an #1483: Schichtplan, Gesundheit und Verlauf bauen ihre Leiste bei
  // jedem Wechsel neu und verwerfen den Handle. Der ResizeObserver beobachtet
  // auch den STABILEN Elternknoten - jede ersetzte Leiste blieb damit
  // lebendig, hielt ihren abgehaengten Baum und rechnete bei jedem Resize
  // weiter. Gezaehlt werden die lebenden Observer nach N Neuaufbauten.
  const live = new Set();
  global.ResizeObserver = class {
    constructor(cb) { this.cb = cb; live.add(this); }
    observe() {}
    disconnect() { live.delete(this); }
  };
  const createElement = global.document.createElement;
  global.document.createElement = () => ({
    className: '', style: {}, hidden: false,
    setAttribute() {}, removeAttribute() {}, remove() { this.removed = true; },
  });
  try {
    const parent = {};
    const mkBar = () => {
      const item = {
        hidden: false, offsetLeft: 10, offsetTop: 4, offsetWidth: 90, offsetHeight: 40,
        matches: (sel) => sel.includes('.sub-tab--active'),
        setAttribute() {}, removeAttribute() {},
      };
      const children = [item];
      return {
        isConnected: true, parentElement: parent, children,
        classList: { add() {}, remove() {} },
        querySelector: () => null,
        querySelectorAll: () => children,
        prepend(el) { this.indicator = el; },
      };
    };
    const RENDERS = 6;
    let bar = null;
    let handle = null;
    const replaced = [];
    for (let i = 0; i < RENDERS; i++) {
      if (bar) { bar.isConnected = false; replaced.push(handle); }
      bar = mkBar();
      handle = seg.attachSegmentIndicator(bar, { itemSelector: '.sub-tab' });
      // Ein Resize des Elternteils: jeder noch lebende Observer meldet sich.
      for (const ro of [...live]) ro.cb([]);
    }
    assert.equal(live.size, 1, `nach ${RENDERS} Neuaufbauten lebt nur der Observer der aktuellen Leiste, waren ${live.size}`);
    assert.ok(replaced.every((h) => h.indicator.removed), 'die Kapsel einer ersetzten Leiste geht mit');
    assert.equal(handle.indicator.style.transform, 'translate(10px, 4px)', 'die aktuelle Leiste steht weiter');
    assert.ok(!handle.indicator.removed);
  } finally {
    delete global.ResizeObserver;
    global.document.createElement = createElement;
  }
});

test('Indikator: eine fehlende Leiste ist ein No-op wie bei wireTablist/wireScrollFade - der Aufrufer bleibt heil', () => {
  // Seiten verdrahten ihre Leiste nach dem Rendern in einer Reihe
  // (wireTablist -> attachSegmentIndicator -> wireScrollFade). Die beiden
  // Nachbarn schlucken ein null; warf der Indikator, riss er alles hinter sich
  // mit (Haushaltshilfe: Riegel, Scroll-Fade, Inhalt).
  const handle = seg.attachSegmentIndicator(null, { key: 'probe' });
  assert.equal(typeof handle.place, 'function');
  assert.equal(typeof handle.destroy, 'function');
  assert.doesNotThrow(() => { handle.place({ glide: true }); handle.destroy(); });
});

test('Indikator: keine Regel stellt eine Segment-/Tab-Leiste auf position: static - sonst misst die Kapsel gegen den Kopf und steht in gescrollten Leisten daneben', async () => {
  // Der Bezugsrahmen der Kapsel ist der von `offsetLeft` der Eintraege: die
  // Leiste selbst, solange sie positioniert ist. `:where(.has-seg-indicator)`
  // traegt Spezifitaet 0 - jede Regel, die eine Leiste auf `static` setzt,
  // schlaegt es, offsetParent wird der Kopf, und in einer gescrollten Leiste
  // (Gesundheit mobil auf "Fasten") steht die Kapsel um scrollLeft daneben.
  const { eachRule } = await import('./css-rules.js');
  const { readdirSync } = await import('node:fs');
  const BAR = /^(?:sub-tabs-bar|segmented|group-toggle|documents-view-toggle|kitchen-tabs-bar|has-seg-indicator|[\w-]+-tabs|[\w-]+-toggle|[\w-]+__views|[\w-]+__ranges|[\w-]*-?mode-?switch|[\w-]+modeswitch)$/;
  const dir = new URL('../public/styles/', import.meta.url);
  const hits = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.css'))) {
    for (const r of eachRule(readSrc(`../public/styles/${f}`))) {
      if (!/(?:^|;)\s*position\s*:\s*static\b/.test(r.body)) continue;
      for (const sel of r.selector.split(',')) {
        const subject = sel.trim().split(/\s*[>+~]\s*|\s+/).pop().replace(/::?[\w-]+(\([^)]*\))?/g, '');
        const classes = [...subject.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
        if (classes.some((c) => BAR.test(c))) hits.push(`${f}: ${sel.trim()}`);
      }
    }
  }
  assert.deepEqual(hits, [], 'eine Leiste im Kopf gibt sticky ab, aber nicht den Bezugsrahmen: position: relative statt static');
});

test('Indikator: glideKeyframes ist die Regel "transform, Groesse nur wenn noetig"', () => {
  const a = { x: 0, y: 0, w: 50, h: 30 };
  assert.deepEqual(seg.glideKeyframes(a, { ...a, x: 60 }).map(Object.keys), [['transform'], ['transform']]);
  assert.deepEqual(seg.glideKeyframes(a, { ...a, h: 40 }).map((f) => Object.keys(f).sort()), [['height', 'transform'], ['height', 'transform']]);
});

test('Indikator: beobachtet die Leiste als BORDER-Box - sonst steht die Kuechen-Kapsel nach dem Einklappen der Seitenleiste daneben (A1 P2-1)', () => {
  // Gemessen 2026-09-27: nach dem Einklappen Kapsel x=417, Tab x=437. Die
  // Leiste wuchs um ihr Polster (`--page-inline-pad` zentriert die Spalte),
  // ihre Content-Box blieb 1280px, und der ResizeObserver meldete nichts.
  const src = readSrc('../public/utils/segment-indicator.js');
  assert.match(src, /\.observe\(bar,\s*\{\s*box:\s*'border-box'\s*\}\)/);
});

test('Kueche: nutzt den geteilten Indikator und baut keinen eigenen mehr', () => {
  const src = readSrc('../public/utils/kitchen-tabs.js');
  assert.match(src, /attachSegmentIndicator\(_bar/);
  assert.doesNotMatch(src, /\.animate\(|new ResizeObserver|kitchen-tabs-bar__indicator/,
    'Gleiten und Nachziehen stehen im Helfer, nicht in der Kueche');
  const css = readSrc('../public/styles/kitchen-tabs.css');
  assert.doesNotMatch(css, /__indicator\s*\{/, 'die Kapsel-Regeln stehen in sub-tabs.css');
  const sub = readSrc('../public/styles/sub-tabs.css');
  assert.match(sub, /\.seg-indicator\s*\{[^}]*z-index:\s*-1/);
  assert.match(sub, /\.has-seg-indicator \[data-seg-active\]\[data-seg-active\]\s*\{[^}]*background-color:\s*transparent/);
});

test('Seitenleiste: Pille <= 300ms aus Tokens, Hover-Absicht 150-250ms aus einem Token (A1 P2-2 / P3-1)', () => {
  const layout = readSrc('../public/styles/layout.css');
  const tokens = readSrc('../public/styles/tokens.css');
  const ruleBody = (sel) => {
    const i = layout.indexOf(`${sel} {`);
    assert.ok(i >= 0, `${sel} fehlt`);
    return layout.slice(i, layout.indexOf('}', i));
  };
  for (const sel of ['.nav-sidebar__indicator', '.nav-sidebar__hover']) {
    const transition = ruleBody(sel).match(/transition:([^;]*);/)[1];
    assert.doesNotMatch(transition, /\d+m?s\b/, `${sel}: keine Literal-Dauer (vorher 450ms/280ms/180ms)`);
    const durs = [...transition.matchAll(/var\(--duration-(\w+)\)/g)].map((m) => m[1]);
    assert.ok(durs.length && durs.every((d) => ['xs', 'sm', 'md', 'lg', 'xl'].includes(d)), `${sel}: Dauern <= --duration-xl (${durs})`);
  }
  const intent = Number(tokens.match(/--sidebar-hover-intent:\s*(\d+)ms/)?.[1]);
  assert.ok(intent >= 150 && intent <= 250, `--sidebar-hover-intent ${intent}ms`);
  assert.match(layout, /\.nav-sidebar:hover:not\(:focus-within\)\s*\{\s*transition:\s*width var\(--duration-xl\) var\(--ease-out\) var\(--sidebar-hover-intent\)/,
    'das Ausklappen per Zeiger wartet die Absicht ab, mit der Kurve der Shell');
});

// --------------------------------------------------------
// EINE REGEL FUER DEN KUECHENKOPF MOBIL (Re-Critique 2026-09-28, P7 / A4 P2-3).
// R9 M10 hatte Lupe und "..." von Rezepte/Vorrat IN die Kuechen-Leiste gelegt;
// dafuer schrumpften dort die Zaehler zu Punkten, waehrend Mahlzeiten und
// Einkauf ihre Werkzeuge in einer eigenen Kontextzeile trugen. Vier Tabs, vier
// Kopfbauarten: die Leiste sprang beim Tabwechsel. Jetzt traegt die Leiste nur
// Tabs mit Zahlen, und jedes Werkzeug steht in der Kontextzeile seines Tabs.
// --------------------------------------------------------
test('Kueche mobil: die Leiste traegt nur Tabs mit Zahlen, Werkzeuge stehen in der Kontextzeile', async () => {
  const { eachRule } = await import('./css-rules.js');
  const rules = [...eachRule(readSrc('../public/styles/kitchen-tabs.css'))];
  const narrow = rules.filter((r) => r.at.some((a) => /\(max-width:\s*639px\)/.test(a)));
  assert.ok(narrow.some((r) => /\.kitchen-tabs-bar \.module-seal/.test(r.selector) && /display:\s*none/.test(r.body)),
    'mobil kostet das Siegel 26px, und die untere Leiste fuehrt dasselbe Besteck als aktiven Eintrag');
  assert.deepEqual(narrow.filter((r) => /--kitchen-tools/.test(r.body) || /--kitchen-tools/.test(r.selector)).map((r) => r.selector), [],
    'keine Werkzeuge mehr in der Leiste');
  assert.deepEqual(narrow.filter((r) => /margin-block-start:\s*calc\(-1 \* var\(--kitchen-tabs-height\)\)/.test(r.body)).map((r) => r.selector), [],
    'keine Seite rueckt mehr in die Zeile der Leiste - ihr Kopf ist die Kontextzeile darunter');
  assert.deepEqual(narrow.filter((r) => /\.sub-tab__badge/.test(r.selector) && /color:\s*transparent/.test(r.body)).map((r) => r.selector), [],
    'kein Zaehler schrumpft je Tab zum Punkt - die Zahl bleibt in allen vier Tabs');
});

// --------------------------------------------------------
// R9 (Hauptsession-Entscheid nach k9): die Leiste passt auch bei 375px ohne
// Scrollen. Gemessen vorher (375x812, de): Rezepte 3px, Vorrat 9px Ueberlauf.
// Die Rechnung liest jede Laenge aus den Stylesheets und tokens.css; nur die
// Wortbreiten sind gemessen (de, --text-sm, Pane 2026-09-27) - Deutsch ist
// die laengste Locale, fuer die die Leiste ausgelegt ist (siehe Kopf von
// kitchen-tabs.css). Werkzeuge mit --target-lg (Finger), wie auf dem Telefon.
// --------------------------------------------------------
test('Kueche mobil: die Leiste passt bei 375px in allen vier Tabs ohne Scrollen (R9)', async () => {
  const { eachRule } = await import('./css-rules.js');
  const tokens = readSrc('../public/styles/tokens.css');
  const tok = (name) => {
    const m = tokens.match(new RegExp(`--${name}:\\s*([\\d.]+)px`));
    assert.ok(m, `Token --${name} nicht gefunden`);
    return Number(m[1]);
  };
  const px = (v) => {
    const s = String(v ?? '').trim();
    if (s === '0') return 0;
    const m = s.match(/^var\(--([\w-]+)\)$/);
    assert.ok(m, `Laenge nicht lesbar: "${s}"`);
    return tok(m[1]);
  };
  const narrow = (r) => r.at.some((a) => /\(max-width:\s*639px\)/.test(a));
  const kitchen = [...eachRule(readSrc('../public/styles/kitchen-tabs.css'))].filter(narrow);
  const base = [...eachRule(readSrc('../public/styles/sub-tabs.css'))].filter((r) => !r.at.length);
  // Komma nur auf oberster Ebene trennen - `:is(a, b)` ist EIN Selektor.
  const topLevel = (sel) => {
    const out = []; let depth = 0; let cur = '';
    for (const ch of sel) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    return [...out, cur].map((x) => x.trim().replace(/\s+/g, ' '));
  };
  const decl = (rules, sel, prop) => {
    let out;
    for (const r of rules) {
      if (!topLevel(r.selector).includes(sel)) continue;
      const m = r.body.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`));
      if (m) out = m[1].trim();
    }
    return out;
  };
  const barGap = px(decl(kitchen, '.kitchen-tabs-bar', 'gap'));
  const tabPad = px(decl(kitchen, '.kitchen-tabs-bar .sub-tab', 'padding-inline'));
  const tabGap = px(decl(kitchen, '.kitchen-tabs-bar .sub-tab', 'gap'));
  const badgeMargin = px(decl(kitchen, '.kitchen-tabs-bar .sub-tab__badge', 'margin-inline-start') ?? decl(base, '.sub-tab__badge', 'margin-inline-start'));
  const badgePad = px(decl(kitchen, '.kitchen-tabs-bar .sub-tab__badge', 'padding-inline') ?? decl(base, '.sub-tab__badge', 'padding').split(/\s+/)[1]);
  const badgeMin = px(decl(base, '.sub-tab__badge', 'min-width'));
  // Seit der Re-Critique 2026-09-28 (P7) stehen keine Werkzeuge mehr in der
  // Leiste und kein Zaehler wird zum Punkt - die Rechnung hat vier Tabs mit
  // Zahlen und das Seitenpolster an beiden Enden.
  // Gemessene Wortbreiten (inaktiv / aktiv, der aktive Tab ist fetter) und die Zahl im Zaehler.
  const WORD = { meals: [72, 73.7], recipes: [53.9, 55], shopping: [48.8, 50.2], pantry: [40.9, 42] };
  const DIGITS = 15.8;
  const PAGE_PAD = tok('space-4');
  const W = 375;
  const numeric = Math.max(badgeMin, DIGITS + 2 * badgePad);
  const width = ({ active, badges }) => {
    const tabs = Object.keys(WORD).map((id) => WORD[id][id === active ? 1 : 0] + 2 * tabPad
      + (badges.includes(id) && id !== active ? tabGap + badgeMargin + numeric : 0));
    return PAGE_PAD + tabs.reduce((a, b) => a + b, 0) + (tabs.length - 1) * barGap + PAGE_PAD;
  };
  // Einkauf und Vorrat tragen Zaehler; der aktive Tab zeigt seinen nicht.
  for (const tab of Object.keys(WORD)) {
    const need = width({ active: tab, badges: ['shopping', 'pantry'] });
    assert.ok(need <= W, `${tab}: die Leiste braucht ${need.toFixed(1)}px von ${W} - sie scrollt fuer vier Tabs`);
  }
  assert.ok(numeric >= badgeMin, 'der Zaehler bleibt eine Pille');
  assert.ok(tabPad >= tok('space-1'), 'die Kapsel des aktiven Tabs laesst dem Wort weiter 4px je Seite');
});
