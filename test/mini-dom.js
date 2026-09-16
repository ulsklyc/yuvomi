/**
 * Modul: Mini-DOM für Markup-Tests (kein jsdom)
 * Zweck: Gerade genug `document`, damit Renderer, die Knoten BAUEN statt
 *        Template-Literale zurückzugeben, im Node-Test laufen - allen voran
 *        `emptyStateHTML()` aus public/utils/empty-state.js, durch das jeder
 *        Leerzustand der App geht.
 *
 * WARUM NICHT jsdom: dieses Repo hat bewusst keine solche Abhängigkeit (siehe
 * den Kopf von test/test-waste-ui.js). Was hier fehlt, fehlt absichtlich -
 * Layout, Events, Selektoren. Wer davon etwas braucht, prüft am falschen Ort.
 *
 * WORAUF MAN SICH VERLASSEN DARF: `outerHTML` gibt Tag, Attribute (inklusive
 * `class`, `id`, `type` und allem per setAttribute Gesetzten), eingefügtes
 * Markup und Textknoten in Einfügereihenfolge aus. Ein Test, der ein Attribut
 * sucht, misst damit den Renderer und nicht diesen Stub - vorausgesetzt, er
 * stellt die GEGENPROBE mit: wenn das gesuchte Attribut im Positivfall nicht
 * erscheint, ist der Stub kaputt und der Test wird rot, statt still zu passen.
 */

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'i-void']);

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

class MiniText {
  constructor(text) { this.text = String(text ?? ''); }
  get outerHTML() { return escapeText(this.text); }
}

class MiniElement {
  constructor(tag) {
    this.tagName = String(tag).toLowerCase();
    this.attributes = new Map();
    // Kinder und roh eingefügtes Markup teilen sich EINE Liste, damit
    // `insertAdjacentHTML('beforeend')` nach einem `appendChild` auch dahinter
    // landet - die Reihenfolge ist in den Renderern bedeutungstragend.
    this.childNodes = [];
    this.style = {};
    this.dataset = {};
  }

  set className(value) { this.attributes.set('class', String(value)); }
  get className() { return this.attributes.get('class') ?? ''; }

  set type(value) { this.attributes.set('type', String(value)); }
  get type() { return this.attributes.get('type') ?? ''; }

  set textContent(value) { this.childNodes = [new MiniText(value)]; }
  get textContent() {
    return this.childNodes.map((n) => (n instanceof MiniText ? n.text : (n.textContent ?? ''))).join('');
  }

  setAttribute(name, value) { this.attributes.set(String(name), String(value)); }
  getAttribute(name) { return this.attributes.get(String(name)) ?? null; }
  removeAttribute(name) { this.attributes.delete(String(name)); }
  hasAttribute(name) { return this.attributes.has(String(name)); }

  appendChild(node) { this.childNodes.push(node); return node; }
  append(...nodes) { for (const n of nodes) this.childNodes.push(typeof n === 'string' ? new MiniText(n) : n); }
  replaceChildren(...nodes) { this.childNodes = []; this.append(...nodes); }

  insertAdjacentHTML(position, html) {
    const raw = { outerHTML: String(html) };
    if (position === 'afterbegin') this.childNodes.unshift(raw);
    else this.childNodes.push(raw);
  }

  addEventListener() {}
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }

  get innerHTML() { return this.childNodes.map((n) => n.outerHTML).join(''); }

  get outerHTML() {
    const attrs = [...this.attributes].map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('');
    if (VOID_TAGS.has(this.tagName)) return `<${this.tagName}${attrs}>`;
    return `<${this.tagName}${attrs}>${this.innerHTML}</${this.tagName}>`;
  }
}

/**
 * Setzt `globalThis.document` (und ein knappes `window`), falls noch keins
 * steht, und gibt eine Funktion zum Zurücknehmen zurück.
 */
export function installMiniDom() {
  const vorher = { document: globalThis.document, window: globalThis.window };
  globalThis.document = {
    createElement: (tag) => new MiniElement(tag),
    createElementNS: (_ns, tag) => new MiniElement(tag),
    createTextNode: (text) => new MiniText(text),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    documentElement: new MiniElement('html'),
    body: new MiniElement('body'),
  };
  globalThis.window = globalThis.window ?? {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    yuvomi: {},
  };
  return () => {
    globalThis.document = vorher.document;
    globalThis.window = vorher.window;
  };
}

export { MiniElement, MiniText };
