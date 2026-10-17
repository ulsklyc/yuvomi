/**
 * Tests: das geteilte Modal laeuft auf einem nativen <dialog> (D7, Critique 2026-10-16)
 * Modul: /public/components/modal.js, /public/utils/overlay-host.js
 * Ausfuehren: npm run test:modal-dialog
 *
 * Bis hierher war das Overlay ein `div` ausserhalb der Top-Layer: `#app` blieb
 * bedienbar und vorlesbar, Tab lief nur dank eines keydown-Fangs nicht hinaus,
 * und Esc hing an einem Dokument-Handler. Jetzt:
 *
 *   1. `openModal()` legt den Dialog per `showModal()` in die Top-Layer - der
 *      Browser macht den Hintergrund inert.
 *   2. Esc nimmt der eigene Handler (Dirty-Guard!) und unterdrueckt den
 *      Close-Request des Browsers; ein Esc, das einem Popover oder einem
 *      eigenen Dialog darueber gehoert, laesst er liegen.
 *   3. Ein Close-Request (`cancel`, etwa die Zurueck-Geste) laeuft durch
 *      `closeModal()`, statt den Dialog hart zu schliessen.
 *   4. Der Ausgang verlaesst die Top-Layer sofort: waehrend der Animation ist
 *      die Seite wieder bedienbar (wer nach `await closeModal()` fokussiert,
 *      fokussiert nichts Inertes).
 *   5. Der Fokus, den der Browser beim `close()` selbst zurueckgibt, zaehlt
 *      nicht als Wahl des Aufrufers - das Ende des Ausgangs gibt ihn regulaer
 *      an den gemerkten Ausloeser.
 *   6. Toasts liegen waehrend eines Dialogs IN ihm (ausserhalb waeren sie
 *      inert) und kehren danach an ihren Platz zurueck.
 *   7. Schwebende Ebenen (Datepicker) haengen im Dialog, aus dem sie aufgehen.
 *
 * Die Sonden laufen gegen eine Attrappe des Dokuments, wie
 * test-modal-dead-time.js: was der Browser tut (inert, Top-Layer), misst der
 * Browserlauf des Umbaus; hier steht, dass modal.js es AUSLOEST.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeNode(name, { tag = 'DIV' } = {}) {
  const listeners = [];
  const classes = new Set();
  const node = {
    name,
    tagName: tag,
    id: '',
    isConnected: true,
    inert: false,
    style: { setProperty(name, value) { this[name] = value; } },
    dataset: {},
    parentElement: null,
    children: [],
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle(c, on) { if (on ?? !classes.has(c)) classes.add(c); else classes.delete(c); },
    },
    addEventListener(type, handler) { listeners.push({ type, handler }); },
    removeEventListener(type, handler) {
      const i = listeners.findIndex((l) => l.type === type && l.handler === handler);
      if (i !== -1) listeners.splice(i, 1);
    },
    setAttribute() {},
    getAttribute() { return null; },
    hasAttribute() { return false; },
    removeAttribute(attr) { if (attr === 'id') node.id = ''; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    contains(other) {
      for (let n = other; n; n = n.parentElement) if (n === node) return true;
      return false;
    },
    append(child) {
      if (child.parentElement) child.parentElement.children = child.parentElement.children.filter((c) => c !== child);
      child.parentElement = node;
      node.children.push(child);
    },
    insertBefore(child) { node.append(child); },
    focus() { if (!node.inert) globalThis.document.activeElement = node; },
    remove() { node.isConnected = false; },
    matches() { return false; },
    _listeners: listeners,
    _fire(type, event) { for (const l of [...listeners]) if (l.type === type) l.handler(event); return event; },
  };
  node.appendChild = node.append;
  return node;
}

function makeEvent(type, props = {}) {
  return {
    type,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
    stopImmediatePropagation() {},
    ...props,
  };
}

const overlays = [];
let reduce = true;
let stack;
let stackHome;

function installDocument() {
  overlays.length = 0;
  const body = makeNode('body', { tag: 'BODY' });
  stackHome = makeNode('#app');
  stack = makeNode('.shell-bottom-stack');
  stackHome.append(stack);
  body.insertAdjacentHTML = () => {
    const panel = makeNode('.modal-panel');
    const overlay = makeNode('dialog.modal-overlay', { tag: 'DIALOG' });
    overlay.id = 'shared-modal-overlay';
    overlay.open = false;
    overlay.calls = [];
    panel.parentElement = overlay;
    overlay.querySelector = (selector) => (selector === '.modal-panel' ? panel : null);
    overlay.showModal = () => { overlay.calls.push('showModal'); overlay.open = true; };
    overlay.close = () => {
      overlay.calls.push('close');
      overlay.open = false;
      // Wie der Browser: der Fokus geht an das Element vor showModal() zurueck.
      if (overlay._restoreOnClose) overlay._restoreOnClose.focus();
    };
    overlay.remove = () => {
      overlay.isConnected = false;
      const i = overlays.indexOf(overlay);
      if (i !== -1) overlays.splice(i, 1);
    };
    overlay._panel = panel;
    overlays.push(overlay);
  };
  const docListeners = [];
  globalThis.document = {
    body,
    documentElement: makeNode('html'),
    activeElement: null,
    addEventListener(type, handler, opts) { docListeners.push({ type, handler, capture: opts === true || opts?.capture === true }); },
    removeEventListener(type, handler, opts) {
      const capture = opts === true || opts?.capture === true;
      const i = docListeners.findIndex((l) => l.type === type && l.handler === handler && l.capture === capture);
      if (i !== -1) docListeners.splice(i, 1);
    },
    getElementById: (id) => overlays.find((o) => o.id === id) ?? null,
    querySelector: (selector) => (selector === '.modal-overlay' ? overlays.at(-1) ?? null : null),
    querySelectorAll: (selector) => {
      if (selector === 'dialog.modal-overlay' || selector === '.modal-overlay') return [...overlays];
      if (selector === '.shell-bottom-stack') return [stack];
      if (selector === 'dialog[open]') return overlays.filter((o) => o.open);
      return [];
    },
    // Wie der Browser: erst die Capture-Listener am Dokument, dann das Ziel,
    // dann die Bubble-Listener. `stoppedBelow` spielt einen Handler am Ziel
    // nach, der `stopPropagation()` ruft - die Bubble-Phase am Dokument faellt aus.
    _fire(type, event) {
      for (const l of [...docListeners]) if (l.type === type && l.capture) l.handler(event);
      if (event.stoppedBelow) return event;
      for (const l of [...docListeners]) if (l.type === type && !l.capture) l.handler(event);
      return event;
    },
  };
  globalThis.window = { innerWidth: 1024 };
  globalThis.Element = class Element {};
  globalThis.history = { state: null, pushState() {}, back() {}, forward() {} };
  globalThis.location = { href: 'http://localhost/', pathname: '/', search: '', hash: '' };
  globalThis.matchMedia = () => ({ matches: reduce });
}

installDocument();
const { openModal, closeModal, dockNextModal } = await import('../public/components/modal.js');
const { overlayHost } = await import('../public/utils/overlay-host.js');

async function fresh() {
  reduce = true;
  await closeModal({ force: true });
  installDocument();
}

function open(opts = {}) {
  openModal({ title: 'Probe', content: '', ...opts });
  return overlays.at(-1);
}

test('openModal legt den Dialog per showModal() in die Top-Layer', async () => {
  await fresh();
  const overlay = open();
  assert.deepEqual(overlay.calls, ['showModal'], 'kein showModal(): der Hintergrund bleibt bedienbar und vorlesbar');
  assert.equal(overlay.open, true);
  await closeModal({ force: true });
});

test('Esc: der eigene Handler schliesst und unterdrueckt den Close-Request des Browsers', async () => {
  await fresh();
  const overlay = open({ onClose: () => { overlay.closedVia = 'onClose'; } });
  const target = makeNode('input');
  target.closest = () => overlay;
  const esc = document._fire('keydown', makeEvent('keydown', { key: 'Escape', target }));
  assert.equal(esc.defaultPrevented, true,
    'ohne preventDefault feuert der Browser zusaetzlich cancel - beim zweiten Esc ohne Klick nicht abbrechbar, '
    + 'und der Dialog ginge an der Verwerfen-Rueckfrage vorbei zu');
  assert.equal(overlay.closedVia, 'onClose', 'Esc hat das Modal nicht geschlossen');
});

test('Esc in einem Popover oder eigenen Dialog darueber gehoert dem, nicht dem Modal', async () => {
  await fresh();
  let closed = false;
  const overlay = open({ onClose: () => { closed = true; } });
  for (const kind of ['[popover]', 'dialog']) {
    const owner = makeNode(kind);
    owner.matches = (sel) => sel.includes(kind === 'dialog' ? 'dialog' : '[popover]');
    const target = makeNode('button');
    target.closest = () => owner;
    const esc = document._fire('keydown', makeEvent('keydown', { key: 'Escape', target }));
    assert.equal(esc.defaultPrevented, false, `${kind}: der Request muss beim Browser bleiben, sonst schliesst ${kind} nicht`);
    assert.equal(closed, false, `${kind}: Esc schloss das Formular darunter mit`);
  }
  // Ein schon erledigtes Esc (Datepicker) bleibt liegen.
  const handled = makeEvent('keydown', { key: 'Escape', target: makeNode('x') });
  handled.defaultPrevented = true;
  document._fire('keydown', handled);
  assert.equal(closed, false, 'ein vom Datepicker erledigtes Esc schloss das Modal');
  assert.equal(overlay.open, true);
  await closeModal({ force: true });
});

test('ein Close-Request (cancel) laeuft durch closeModal(), nicht am Dirty-Guard vorbei', async () => {
  await fresh();
  let closed = false;
  const overlay = open({ onClose: () => { closed = true; } });
  const cancel = overlay._fire('cancel', makeEvent('cancel', { currentTarget: overlay }));
  assert.equal(cancel.defaultPrevented, true, 'cancel nicht abgefangen: der Browser schliesst hart');
  assert.equal(closed, true, 'cancel lief nicht durch closeModal()');
});

test('ein Esc, das ein Handler darunter fuer sich behaelt, schliesst das Modal auch per cancel nicht', async () => {
  // Die Fasten-Hilfe (und Anhang-Auswahl, Menues) schliesst ihr Tooltip auf Esc
  // mit stopPropagation() - beim div-Overlay blieb das Formular darum stehen.
  // Der native Dialog bekommt danach aber noch den Close-Request des Browsers:
  // gemessen ging der ganze Einstellungsdialog mit dem Tooltip zu.
  await fresh();
  let closed = false;
  const overlay = open({ onClose: () => { closed = true; } });
  const target = makeNode('button');
  target.closest = () => overlay;
  document._fire('keydown', makeEvent('keydown', { key: 'Escape', target, stoppedBelow: true }));
  const cancel = overlay._fire('cancel', makeEvent('cancel', { currentTarget: overlay }));
  assert.equal(cancel.defaultPrevented, true, 'cancel nicht abgefangen: der Browser schliesst hart');
  assert.equal(closed, false, 'das Esc gehoerte dem Tooltip, das Formular ging trotzdem zu');
  // Die Zurueck-Geste danach (cancel ohne Esc) schliesst wieder.
  await new Promise((r) => setTimeout(r, 5));
  overlay._fire('cancel', makeEvent('cancel', { currentTarget: overlay }));
  assert.equal(closed, true, 'nach dem behaltenen Esc schliesst die Zurueck-Geste nicht mehr');
});

test('der Ausgang verlaesst die Top-Layer sofort - die Seite ist waehrend der Animation bedienbar', async () => {
  await fresh();
  reduce = false;
  const overlay = open();
  assert.equal(overlay.open, true, 'die Probe braucht einen modalen Dialog');
  const done = closeModal();
  assert.equal(overlay.isConnected, true, 'die Probe braucht einen laufenden Ausgang');
  assert.equal(overlay.open, false, 'der Dialog blieb modal bis zum Ende der Animation - Fokus nach await closeModal() ginge ins Leere');
  assert.equal(overlay.classList.contains('modal-overlay--closing'), true, 'ohne --closing verschwindet der geschlossene Dialog sofort');
  await done;
  // Netz: das Ende kommt hier nie, MODAL_EXIT_FALLBACK_MS raeumt ab.
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(overlay.isConnected, false);
});

test('der vom Browser beim close() zurueckgegebene Fokus ist keine Wahl des Aufrufers', async () => {
  await fresh();
  const trigger = makeNode('button#trigger', { tag: 'BUTTON' });
  trigger.id = 'trigger';
  document.getElementById = (id) => (id === 'trigger' ? trigger : overlays.find((o) => o.id === id) ?? null);
  trigger.focus();
  const overlay = open();
  const fremd = makeNode('button#vor-showmodal', { tag: 'BUTTON' });
  overlay._restoreOnClose = fremd;
  await closeModal({ force: true });
  assert.ok(overlay.calls.includes('close'), 'die Probe braucht das native close() samt Fokus-Rueckgabe des Browsers');
  assert.equal(document.activeElement, trigger, 'der Fokus blieb dort, wohin der Browser ihn legte, statt am Ausloeser');
});

test('Toasts ziehen waehrend des Dialogs in ihn und danach nach Hause', async () => {
  await fresh();
  const overlay = open();
  assert.equal(stack.parentElement, overlay, 'der Toast-Stapel blieb ausserhalb - neben einem modalen Dialog ist er inert');
  await closeModal({ force: true });
  assert.equal(stack.parentElement, stackHome, 'der Stapel kam nicht an seinen Platz zurueck');
});

test('overlayHost: eine schwebende Ebene haengt im Dialog, aus dem sie aufgeht', async () => {
  await fresh();
  const overlay = open();
  const field = makeNode('yuvomi-datepicker');
  field.closest = (sel) => (sel === 'dialog[open]' ? overlay : null);
  assert.equal(overlayHost(field), overlay);
  const outside = makeNode('button');
  overlay.matches = (sel) => sel === ':modal';
  assert.equal(overlayHost(outside), overlay, 'ohne eigenen Dialog: der oberste modale');
  await closeModal({ force: true });
  assert.equal(overlayHost(outside), document.body, 'ohne Dialog bleibt es document.body');
});

// --------------------------------------------------------
// Bearbeiten in der Detailspalte (Critique R19): derselbe Dialog, nur sein Ort
// --------------------------------------------------------
function makeDock({ display = 'flex', rect = { top: 101, left: 738, width: 670, height: 783 } } = {}) {
  const dock = makeNode('.split-view__detail');
  dock.display = display;
  dock.getBoundingClientRect = () => rect;
  return dock;
}

test('dockNextModal: der naechste Dialog legt sich deckungsgleich auf die Spalte - und bleibt ein Dialog', async () => {
  await fresh();
  globalThis.getComputedStyle = (node) => ({ display: node.display ?? 'block' });
  const dock = makeDock();
  dockNextModal(dock);
  const overlay = open();
  assert.equal(overlay.classList.contains('modal-overlay--docked'), true, 'das Formular liegt in der Spalte');
  assert.deepEqual(
    ['--dock-top', '--dock-left', '--dock-width', '--dock-height'].map((k) => overlay.style[k]),
    ['101px', '738px', '670px', '783px'],
    'die Lage ist die gemessene Spalte',
  );
  assert.deepEqual(overlay.calls, ['showModal'], 'weiter showModal(): Fokusfalle, inerter Hintergrund, Escape und Dirty-Guard bleiben');
  await closeModal({ force: true });
  assert.equal(overlay._undock, null, 'beim Schliessen haengt der Dialog sich von der Spalte ab');

  // Die Anmeldung gilt EINEM Dialog: der naechste oeffnet wie immer.
  await fresh();
  const next = open();
  assert.equal(next.classList.contains('modal-overlay--docked'), false, 'eine verbrauchte Anmeldung dockt nichts mehr an');
  await closeModal({ force: true });
});

test('dockNextModal: keine Spalte (unter der Schwelle), keine Anmeldung oder eine alte - dann das Modal wie immer', async () => {
  globalThis.getComputedStyle = (node) => ({ display: node.display ?? 'block' });
  await fresh();
  dockNextModal(makeDock({ display: 'none' }));
  assert.equal(open().classList.contains('modal-overlay--docked'), false, 'unter der Schwelle steht die Spalte nicht');
  await closeModal({ force: true });

  await fresh();
  const realNow = Date.now;
  try {
    dockNextModal(makeDock());
    Date.now = () => realNow() + 60_000;
    assert.equal(open().classList.contains('modal-overlay--docked'), false, 'eine Minute alte Anmeldung gilt nicht mehr');
  } finally {
    Date.now = realNow;
  }
  await closeModal({ force: true });

  await fresh();
  assert.equal(open().classList.contains('modal-overlay--docked'), false, 'ohne Anmeldung kein Andocken');
  await closeModal({ force: true });
});

test('der gedockte Dialog zeigt mit einem Hauch, dass die Liste daneben gerade nicht bedienbar ist', async () => {
  // R19-Nachlese (modern-web-guidance „light-dismiss-a-dialog"): ein ganz
  // durchsichtiger Grund liess die inerte Liste bedienbar aussehen.
  const { readFileSync } = await import('node:fs');
  const { eachRule } = await import('./css-rules.js');
  const css = readFileSync(new URL('../public/styles/layout.css', import.meta.url), 'utf8');
  const rule = [...eachRule(css)].find((r) => r.selector.trim() === 'dialog.modal-overlay.modal-overlay--docked::backdrop');
  assert.ok(rule, 'der Grund des gedockten Dialogs hat eine eigene Regel');
  assert.doesNotMatch(rule.body, /background-color:\s*transparent/, 'kein unsichtbarer Grund');
  assert.match(rule.body, /background-color:\s*color-mix\(in srgb, var\(--color-overlay-light\)/, 'der Hauch kommt aus dem Overlay-Token');
  assert.match(rule.body, /backdrop-filter:\s*none/, 'ohne Blur - die Spalte bleibt der Ort der Bearbeitung');
});
