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
