/**
 * Modul: Test - der "Neues Rezept"-Knopf bleibt nach dem Andocken sichtbar und im DOM.
 * Zweck: Auf dem Desktop dockt der Router den Page-FAB in den Aktions-Slot des
 *        Modulkopfs (`dockFabIntoToolbar()` in router.js: der ERSTE
 *        `.page-toolbar__actions` unter #main-content). Auf der Rezepte-Seite war
 *        dieser Slot zugleich der Container des Quellenfilters - und der wird
 *        per `hidden` geschaltet und per `replaceChildren()` neu befuellt.
 *        Zwei Folgen, beide am Verhalten gemessen:
 *          1. ohne gespiegeltes Rezept steht der Knopf in einem `hidden`-Container
 *             (auf main nur zufaellig sichtbar, weil `.page-toolbar__actions
 *             { display: flex }` das UA-`[hidden]` schlug);
 *          2. mit gespiegelten Rezepten wirft `renderSourceFilter()` ihn aus dem
 *             DOM, und kein spaeterer Router-Schritt holt ihn zurueck.
 *
 *        GEMESSEN WIRD DAS PROGRAMM, NICHT EIN NACHBAU. Die Seite laeuft durch ihr
 *        echtes `render()` (Browser-Loader), und das Andocken durch die echten
 *        Funktionen aus router.js - sie werden aus dem Quelltext geschnitten und
 *        ausgefuehrt, in derselben Reihenfolge wie `renderPage()`: einmal nach dem
 *        synchronen Teil von `render()`, einmal nach dessen Ende. Ein Nachbau des
 *        Andockens wuerde weiter gruen melden, wenn der Router seinen Slot anders
 *        waehlt.
 *
 *        Das DOM ist ein Doppel (kein jsdom, siehe test/mini-dom.js): Elemente,
 *        Attribute samt `hidden`/`id`/`class`/`data-*`, `insertAdjacentHTML` mit
 *        echtem Parsen, und Selektoren aus Tag, id, Klasse, Attribut, `:not()`,
 *        Nachfahren- und Kind-Kombinator. Was es nicht kann, wirft - ein
 *        Selektor, der still nichts findet, waere hier ein gruener Test ueber
 *        nichts.
 * Ausfuehren: npm run test:hidden-cascade (zusammen mit test-hidden-cascade.js)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

/* ===========================================================================
 * DOM-Doppel
 * ======================================================================== */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const kebab = (key) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

class FakeText {
  constructor(data) {
    this.nodeType = 3;
    this.data = String(data);
    this.parentNode = null;
  }

  get textContent() { return this.data; }

  remove() { this.parentNode?.removeChild(this); }
}

class FakeElement {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.nodeType = 1;
    this.localName = tag.toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.attrs = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = {};
    this.style = {};
    const el = this;
    this.dataset = new Proxy({}, {
      get: (_, key) => (typeof key === 'string' ? el.getAttribute(`data-${kebab(key)}`) ?? undefined : undefined),
      set: (_, key, value) => { el.setAttribute(`data-${kebab(key)}`, value); return true; },
      has: (_, key) => el.hasAttribute(`data-${kebab(key)}`),
      deleteProperty: (_, key) => { el.removeAttribute(`data-${kebab(key)}`); return true; },
    });
  }

  // Reflektierte Attribute - nur die, an denen hier etwas haengt.
  get id() { return this.getAttribute('id') ?? ''; }
  set id(value) { this.setAttribute('id', value); }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(value) { this.setAttribute('class', value); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(value) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }

  get classList() {
    const el = this;
    const read = () => el.className.split(/\s+/).filter(Boolean);
    const write = (list) => { el.className = [...new Set(list)].join(' '); };
    return {
      add: (...names) => write([...read(), ...names]),
      remove: (...names) => write(read().filter((n) => !names.includes(n))),
      contains: (name) => read().includes(name),
      toggle: (name, force) => {
        const on = force ?? !read().includes(name);
        if (on) write([...read(), name]); else write(read().filter((n) => n !== name));
        return on;
      },
    };
  }

  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  removeAttribute(name) { this.attrs.delete(name); }
  hasAttribute(name) { return this.attrs.has(name); }
  toggleAttribute(name, force) {
    const on = force ?? !this.hasAttribute(name);
    if (on) this.setAttribute(name, ''); else this.removeAttribute(name);
    return on;
  }

  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstElementChild() { return this.children[0] ?? null; }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === this.ownerDocument.documentElement;
  }

  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(value) { this.replaceChildren(...(value === '' || value == null ? [] : [new FakeText(value)])); }

  removeChild(node) {
    this.childNodes = this.childNodes.filter((n) => n !== node);
    node.parentNode = null;
    return node;
  }

  /** Knoten fuer das Einfuegen vorbereiten: Fragmente geben ihre Kinder ab, Strings werden Text. */
  static adopt(nodes) {
    return nodes.flatMap((n) => {
      if (typeof n === 'string') return [new FakeText(n)];
      if (n.localName === '#fragment') {
        const kids = [...n.childNodes];
        n.childNodes = [];
        return kids;
      }
      return [n];
    });
  }

  insertAt(index, nodes) {
    const adopted = FakeElement.adopt(nodes);
    for (const node of adopted) node.parentNode?.removeChild(node);
    // Der Index kann sich durch das Herausloesen aus DIESEM Knoten verschoben haben.
    const at = Math.min(index, this.childNodes.length);
    this.childNodes.splice(at, 0, ...adopted);
    for (const node of adopted) node.parentNode = this;
  }

  append(...nodes) { this.insertAt(this.childNodes.length, nodes); }
  appendChild(node) { this.append(node); return node; }
  prepend(...nodes) { this.insertAt(0, nodes); }
  insertBefore(node, ref) {
    const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.insertAt(i < 0 ? this.childNodes.length : i, [node]);
    return node;
  }
  replaceChildren(...nodes) {
    for (const n of this.childNodes) n.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  remove() { this.parentNode?.removeChild(this); }
  before(...nodes) { const p = this.parentNode; if (p) p.insertAt(p.childNodes.indexOf(this), nodes); }
  after(...nodes) { const p = this.parentNode; if (p) p.insertAt(p.childNodes.indexOf(this) + 1, nodes); }

  insertAdjacentHTML(position, html) {
    const nodes = parseHtml(this.ownerDocument, html);
    if (position === 'beforeend') this.append(...nodes);
    else if (position === 'afterbegin') this.prepend(...nodes);
    else if (position === 'beforebegin') this.before(...nodes);
    else if (position === 'afterend') this.after(...nodes);
    else throw new Error(`insertAdjacentHTML: unbekannte Position ${position}`);
  }

  insertAdjacentElement(position, node) {
    if (position === 'beforeend') this.append(node);
    else if (position === 'afterbegin') this.prepend(node);
    else if (position === 'beforebegin') this.before(node);
    else if (position === 'afterend') this.after(node);
    return node;
  }

  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  *descendants() {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }

  matches(selector) { return selectorList(selector).some((s) => matchComplex(this, s)); }
  closest(selector) {
    for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.matches(selector)) return n;
    return null;
  }
  querySelectorAll(selector) {
    const list = selectorList(selector);
    return [...this.descendants()].filter((el) => list.some((s) => matchComplex(el, s)));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }

  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn); }
  dispatchEvent() { return true; }
  focus() {}
  blur() {}
  /** Ruft die eigenen click-Listener - ohne Bubbling, das braucht hier niemand. */
  click() {
    const event = { type: 'click', target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} };
    for (const fn of this.listeners.click ?? []) fn(event);
  }
  scrollIntoView() {}
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
}

class FakeDocument {
  constructor() {
    this.documentElement = new FakeElement(this, 'html');
    this.body = new FakeElement(this, 'body');
    this.documentElement.append(this.body);
    this.activeElement = this.body;
  }

  createElement(tag) { return new FakeElement(this, tag); }
  createElementNS(_, tag) { return new FakeElement(this, tag); }
  createTextNode(data) { return new FakeText(data); }
  createDocumentFragment() { return new FakeElement(this, '#fragment'); }
  getElementById(id) { return this.documentElement.querySelector(`#${id}`); }
  querySelector(selector) { return this.documentElement.querySelector(selector); }
  querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); }
  addEventListener() {}
  removeEventListener() {}
}

/** HTML in Knoten: Tags, Attribute, Text; Kommentare fallen weg. */
function parseHtml(doc, html) {
  const root = doc.createDocumentFragment();
  const stack = [root];
  const token = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
  for (const m of html.matchAll(token)) {
    const top = stack.at(-1);
    if (m[1]) {
      const at = stack.findLastIndex((n) => n.localName === m[1].toLowerCase());
      if (at > 0) stack.length = at;
    } else if (m[2]) {
      const el = doc.createElement(m[2]);
      const attrText = m[3].replace(/\/\s*$/, '');
      for (const a of attrText.matchAll(/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g)) {
        el.setAttribute(a[1].toLowerCase(), a[2] ?? a[3] ?? a[4] ?? '');
      }
      top.append(el);
      if (!VOID.has(el.localName) && !/\/\s*$/.test(m[3])) stack.push(el);
    } else if (m[4] && m[4].trim()) {
      top.append(new FakeText(m[4]));
    }
  }
  return [...root.childNodes];
}

/* --- Selektoren ---------------------------------------------------------- */

function splitTop(text, sep) {
  const out = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth -= 1;
    else if (depth === 0 && c === sep) { out.push(text.slice(from, i)); from = i + 1; }
  }
  out.push(text.slice(from));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** `a b > c` in [{ compound, combinator }] von rechts gelesen. */
function parseComplex(selector) {
  const parts = [];
  let depth = 0;
  let current = '';
  let pending = ' ';
  for (let i = 0; i < selector.length; i += 1) {
    const c = selector[i];
    if (c === '(' || c === '[') depth += 1;
    if (c === ')' || c === ']') depth -= 1;
    if (depth === 0 && /[\s>+~]/.test(c)) {
      if (current) { parts.push({ combinator: pending, compound: parseCompound(current) }); current = ''; pending = ' '; }
      if (c !== ' ' && c !== '\n' && c !== '\t') {
        if (c === '+' || c === '~') throw new Error(`Selektor nicht unterstuetzt: ${selector}`);
        pending = c;
      }
      continue;
    }
    current += c;
  }
  if (current) parts.push({ combinator: pending, compound: parseCompound(current) });
  return parts;
}

function parseCompound(raw) {
  const c = { tag: null, ids: [], classes: [], attrs: [], nots: [] };
  let i = 0;
  const name = () => {
    const m = /^[\w-]+/.exec(raw.slice(i))?.[0] ?? '';
    i += m.length;
    return m;
  };
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '#') { i += 1; c.ids.push(name()); }
    else if (ch === '.') { i += 1; c.classes.push(name()); }
    else if (ch === '[') {
      const end = raw.indexOf(']', i);
      const m = /^\s*([\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+)))?\s*$/.exec(raw.slice(i + 1, end));
      if (!m) throw new Error(`Attributselektor nicht unterstuetzt: ${raw}`);
      c.attrs.push({ name: m[1], value: m[2] ?? m[3] ?? m[4] ?? null });
      i = end + 1;
    } else if (raw.startsWith(':not(', i)) {
      let depth = 1;
      let j = i + 5;
      while (depth > 0) { if (raw[j] === '(') depth += 1; else if (raw[j] === ')') depth -= 1; j += 1; }
      c.nots.push(parseCompound(raw.slice(i + 5, j - 1)));
      i = j;
    } else if (ch === '*') { i += 1; }
    else if (/[\w-]/.test(ch)) { c.tag = name().toLowerCase(); }
    else throw new Error(`Selektor nicht unterstuetzt: ${raw}`);
  }
  return c;
}

const selectorCache = new Map();
function selectorList(selector) {
  if (!selectorCache.has(selector)) selectorCache.set(selector, splitTop(selector, ',').map(parseComplex));
  return selectorCache.get(selector);
}

function matchCompound(el, c) {
  if (el.nodeType !== 1) return false;
  if (c.tag && el.localName !== c.tag) return false;
  if (c.ids.some((id) => el.id !== id)) return false;
  const classes = el.className.split(/\s+/);
  if (c.classes.some((cls) => !classes.includes(cls))) return false;
  if (c.attrs.some((a) => !el.hasAttribute(a.name) || (a.value !== null && el.getAttribute(a.name) !== a.value))) return false;
  if (c.nots.some((n) => matchCompound(el, n))) return false;
  return true;
}

function matchComplex(el, parts, index = parts.length - 1) {
  if (!matchCompound(el, parts[index].compound)) return false;
  if (index === 0) return true;
  const { combinator } = parts[index];
  if (combinator === '>') return el.parentElement ? matchComplex(el.parentElement, parts, index - 1) : false;
  for (let p = el.parentElement; p; p = p.parentElement) if (matchComplex(p, parts, index - 1)) return true;
  return false;
}

/* ===========================================================================
 * Die Andock-Funktionen des Routers, aus dem Quelltext geschnitten
 * ======================================================================== */

/** Index hinter der schliessenden Klammer zu src[open], Strings/Templates/Kommentare uebersprungen. */
function closingBrace(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '"' || c === "'" || c === '`') {
      for (i += 1; i < src.length && src[i] !== c; i += 1) if (src[i] === '\\') i += 1;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  throw new Error('keine schliessende Klammer');
}

function functionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `router.js hat keine Funktion ${name}() mehr - der Test misst nichts`);
  return src.slice(start, closingBrace(src, src.indexOf('{', start)));
}

const ROUTER = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
const ROUTER_FUNCTIONS = ['adoptPageFab', 'dockFabIntoToolbar', 'markFabShortcut', 'isDesktopViewport'];

/**
 * Die echten Router-Funktionen, gebunden an das DOM-Doppel - ausgefuehrt in einer
 * vm-Sandbox wie sw.js in test-sw-precache.js. Der Quelltext ist router.js aus
 * diesem Baum, keine Fremdeingabe.
 */
function routerFabFunctions(doc, win) {
  const context = createContext({ document: doc, window: win });
  const source = ROUTER_FUNCTIONS.map((n) => functionSource(ROUTER, n)).join('\n');
  return runInContext(`${source}\n;({ adoptPageFab })`, context);
}

/* ===========================================================================
 * Die Seite, wie renderPage() sie aufbaut
 * ======================================================================== */

const recipe = (id, source) => ({ id, title: `Rezept ${id}`, source, ingredients: [], notes: '', meal_types: [] });

/**
 * Rendert die Rezepte-Seite in ein frisches Doppel und dockt den FAB an wie
 * `renderPage()`: `adoptPageFab()` nach dem synchronen Teil von `render()`,
 * dann `await render`, dann `adoptPageFab()` noch einmal. Liefert das Doppel.
 */
async function renderRecipesPage(recipes) {
  const doc = new FakeDocument();
  const win = {
    location: { search: '' },
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    yuvomi: { showToast() {}, navigate() {}, isModuleDisabled: () => false },
  };
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.HTMLElement ??= class {};
  globalThis.customElements ??= { get: () => undefined, define() {} };
  globalThis.__apiStub = {
    get: async (url) => ({ data: url === '/recipes' ? recipes : [] }),
  };

  // Die Shell, soweit das Andocken sie liest: die FAB-Ebene und der Scrollport.
  const layer = doc.createElement('div');
  layer.id = 'fab-layer';
  const main = doc.createElement('main');
  main.id = 'main-content';
  const wrapper = doc.createElement('div');
  wrapper.className = 'page-transition';
  main.append(wrapper);
  doc.body.append(layer, main);

  const { render } = await import('../public/pages/recipes.js');
  const { adoptPageFab } = routerFabFunctions(doc, win);
  const pending = render(wrapper);
  adoptPageFab();
  await pending;
  adoptPageFab();
  return doc;
}

/** Der FAB im Doppel - angedockt, schwebend oder (Befund) gar nicht mehr da. */
function newRecipeButton(doc) {
  return doc.querySelector('#fab-new-recipe');
}

/** Nur Primitive in die Zusicherungen, siehe unten. */
function assertButtonUsable(doc, when) {
  const fab = newRecipeButton(doc);
  assert.ok(fab !== null,
    `${when}: der Neu-Knopf steht nicht mehr im DOM - ein replaceChildren() auf seinem Slot hat ihn entfernt`);
  assert.ok(fab.classList.contains('page-fab--docked'), `${when}: der Knopf wurde nicht angedockt - der Test misst den Desktop-Fall nicht`);
  const hiddenAncestor = fab.closest('[hidden]');
  assert.equal(hiddenAncestor ? `${hiddenAncestor.localName}#${hiddenAncestor.id}.${hiddenAncestor.className}` : null, null,
    `${when}: der Neu-Knopf steht in einem [hidden]-Container`);
  assert.equal(fab.isConnected, true, `${when}: der Neu-Knopf haengt nicht im Dokument`);
  assert.equal(doc.querySelector('#recipes-source-filter').contains(fab), false,
    `${when}: der Neu-Knopf steht im Container des Quellenfilters`);
}

/* ===========================================================================
 * Tests
 * ======================================================================== */

test('Doppel: Selektoren, hidden und insertAdjacentHTML verhalten sich wie im Browser', () => {
  // Gegenprobe zum Doppel selbst: ein Selektor, der still nichts findet, liesse
  // die Tests unten ueber nichts gruen werden.
  const doc = new FakeDocument();
  const host = doc.createElement('div');
  host.className = 'zz-host';
  doc.body.append(host);
  host.insertAdjacentHTML('beforeend', '<nav class="zz-a" hidden><button type="button" data-zz-value="x" class="zz-b">x</button><br></nav><p class="zz-c">t</p>');
  assert.equal(doc.querySelector('.zz-host > .zz-a .zz-b[data-zz-value="x"]')?.textContent, 'x');
  assert.equal(doc.querySelector('.zz-b').closest('[hidden]'), doc.querySelector('.zz-a'));
  assert.equal(doc.querySelectorAll('.zz-host :not(.zz-a)').length, 3, 'button, br und p');
  assert.equal(doc.querySelector('.zz-c').closest('[hidden]'), null);
  const b = doc.querySelector('.zz-b');
  host.append(b);
  assert.equal(b.parentElement, host, 'appendChild zieht um, statt zu kopieren');
  doc.querySelector('.zz-a').replaceChildren();
  assert.equal(b.isConnected, true);
  host.replaceChildren();
  assert.equal(b.isConnected, false, 'replaceChildren nimmt den Knoten aus dem Dokument');
  let clicks = 0;
  b.addEventListener('click', () => { clicks += 1; });
  b.click();
  assert.equal(clicks, 1, 'click() ruft die Listener');
  assert.throws(() => doc.querySelector('.zz-a + .zz-c'), /nicht unterstuetzt/);
});

test('Router: die Andock-Funktionen sind aus router.js lesbar', () => {
  // Reichweite: faende der Schnitt eine Funktion nicht mehr, liefe der Test
  // unten gegen gar kein Andocken und waere gruen, weil nichts gedockt wurde.
  const { adoptPageFab } = routerFabFunctions(new FakeDocument(), { matchMedia: () => ({ matches: true }) });
  assert.equal(typeof adoptPageFab, 'function');
  assert.match(functionSource(ROUTER, 'dockFabIntoToolbar'), /\.page-toolbar__actions/,
    'dockFabIntoToolbar sucht seinen Slot nicht mehr ueber .page-toolbar__actions - Test und Guard pruefen den falschen Slot');
});

for (const [label, recipes] of [
  ['ohne gespiegelte Rezepte', [recipe(1, 'native'), recipe(2, 'native')]],
  ['mit gespiegelten Rezepten', [recipe(1, 'native'), recipe(2, 'mealie')]],
]) {
  test(`Rezepte, Desktop, ${label}: der Neu-Knopf ist angedockt, sichtbar und im DOM`, async () => {
    // Nur Primitive in die Zusicherungen: ein Element als `actual` liesse node
    // beim Fehlschlag den ganzen Knotengraph samt Dokument inspizieren - gemessen
    // 17 s fuer einen einzigen roten Fall.
    const doc = await renderRecipesPage(recipes);
    const mirrored = recipes.some((r) => r.source !== 'native');
    const filter = doc.querySelector('#recipes-source-filter');
    assert.ok(filter !== null, 'der Quellenfilter-Container fehlt');
    assert.equal(filter.hidden, !mirrored, 'der Filter steht genau dann, wenn es gespiegelte Rezepte gibt');
    assertButtonUsable(doc, 'nach dem Rendern');

    // Der `n`-Kurzbefehl erreicht denselben Knopf (utils/fab.js, wie im Router).
    const { triggerPageFab } = await import('../public/utils/fab.js');
    let reached = false;
    newRecipeButton(doc).click = () => { reached = true; };
    assert.equal(triggerPageFab(doc), true, 'der n-Kurzbefehl findet keinen .page-fab');
    assert.equal(reached, true, 'der n-Kurzbefehl loest einen anderen Knopf aus');

    // renderSourceFilter() laeuft nicht nur einmal: jede Wahl im Filtermenue baut
    // ihn neu. Gewaehlt wird wie im Browser, ueber den Menuepunkt.
    if (mirrored) {
      const option = doc.querySelector('#recipes-source-filter [data-source-value="mealie"]');
      assert.ok(option !== null, 'der Menuepunkt "mealie" fehlt - der Filter wurde nicht gebaut');
      option.click();
      assert.ok(doc.querySelector('#recipes-source-filter [data-source-value="mealie"][aria-checked="true"]') !== null,
        'die Wahl kam im Filter nicht an - der Test misst den zweiten Durchlauf nicht');
      assertButtonUsable(doc, 'nach einer Wahl im Filtermenue');
    }
  });
}
