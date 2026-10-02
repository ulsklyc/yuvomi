/**
 * Tests: promptModal nimmt ein leeres Feld nicht als Antwort (#1607 Punkt 8)
 * Modul: /public/components/modal.js  (promptModal)
 *
 * DIE GEMESSENE LAGE: "Neue Liste" im Einkauf, Namensfeld leer, Speichern. Der
 * Dialog loeste mit `null` auf - demselben Wert wie Abbrechen - und jeder
 * Aufrufer liest `null` als "nichts tun". Das Blatt ging zu, nichts entstand,
 * keine Meldung. Fuer die Person am Geraet sah Speichern aus wie ein Fehler
 * ohne Text.
 *
 * WAS HIER GEMESSEN WIRD ist deshalb das Verhalten am Formular und nicht der
 * Quelltext: das `submit` wird wirklich zugestellt, und gezaehlt wird, ob das
 * Versprechen aufloest, ob das Overlay noch haengt und was am Feld steht. Beide
 * Richtungen zaehlen - ein Dialog, der nach der Fehlermeldung auch den
 * gefuellten Wert nicht mehr annimmt oder sich nicht mehr abbrechen laesst,
 * waere der teurere Fehler.
 *
 * DAS DOM DARUNTER ist ein Stub in der Bauart von test-modal-dead-time.js:
 * statt HTML zu parsen, liefert das Panel die drei Knoten, nach denen
 * promptModal fragt (Formular, Feld, Abbrechen).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.performance = { now: () => 0 };

function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    contains: (c) => set.has(c),
    toggle(c, force) {
      const on = force === undefined ? !set.has(c) : Boolean(force);
      if (on) set.add(c); else set.delete(c);
      return on;
    },
  };
}

function makeNode(name) {
  const listeners = [];
  const attrs = new Map();
  const node = {
    name,
    id: '',
    value: '',
    textContent: '',
    isConnected: true,
    inert: false,
    style: {},
    dataset: {},
    classList: makeClassList(),
    addEventListener(type, handler, options) {
      listeners.push({ type, handler, capture: options === true || options?.capture === true });
    },
    removeEventListener(type, handler) {
      const i = listeners.findIndex((l) => l.type === type && l.handler === handler);
      if (i !== -1) listeners.splice(i, 1);
    },
    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute(k) { return attrs.get(k) ?? null; },
    hasAttribute(k) { return attrs.has(k); },
    removeAttribute(k) { attrs.delete(k); if (k === 'id') node.id = ''; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    contains() { return false; },
    matches() { return false; },
    appendChild() {},
    focus() { node._focused = (node._focused ?? 0) + 1; },
    select() {},
    scrollIntoView() {},
    remove() { node.isConnected = false; },
    _fire(type, event = {}) {
      const e = { type, target: node, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...event };
      for (const l of [...listeners]) if (l.type === type) l.handler(e);
      return e;
    },
  };
  return node;
}

const overlays = [];
/** Die Knoten des zuletzt geoeffneten Prompts. */
let parts = null;

function installDocument() {
  overlays.length = 0;
  const body = makeNode('body');
  body.insertAdjacentHTML = () => {
    const form = makeNode('#prompt-modal-form');
    const input = makeNode('#prompt-modal-input');
    input.id = 'prompt-modal-input';
    const cancel = makeNode('#prompt-modal-cancel');
    const group = makeNode('.form-field');
    let errorEl = null;
    group.querySelector = (selector) => (selector === '.form-field__error' ? errorEl : null);
    input.closest = (selector) => (selector === '.form-field' ? group : null);
    input.matches = () => true;
    input.insertAdjacentElement = (_position, el) => { errorEl = el; };
    parts = { form, input, cancel, group, get error() { return errorEl; } };

    const panel = makeNode('.modal-panel');
    panel.querySelector = (selector) => ({
      '#prompt-modal-form': form,
      '#prompt-modal-input': input,
      '#prompt-modal-cancel': cancel,
    }[selector] ?? null);
    const overlay = makeNode('.modal-overlay');
    overlay.id = 'shared-modal-overlay';
    overlay.querySelector = (selector) => (selector === '.modal-panel' ? panel : null);
    overlay.remove = () => {
      overlay.isConnected = false;
      const i = overlays.indexOf(overlay);
      if (i !== -1) overlays.splice(i, 1);
    };
    overlays.push(overlay);
  };
  globalThis.document = {
    body,
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
    createElement: (tag) => makeNode(tag),
    getElementById: (id) => overlays.find((o) => o.id === id) ?? null,
    querySelector: (selector) => (selector === '.modal-overlay' ? overlays.at(-1) ?? null : null),
    querySelectorAll: () => [],
  };
  globalThis.window = { innerWidth: 1024 };
  globalThis.Element = class Element {};
  globalThis.history = { state: null, pushState() {}, back() {}, forward() {} };
  globalThis.location = { href: 'http://localhost/' };
}

const { promptModal, closeModal, whenModalClosed } = await import('../public/components/modal.js');

/** Oeffnet den Prompt und meldet, ob und womit das Versprechen aufgeloest hat. */
function openPrompt(defaultValue = '') {
  installDocument();
  const state = { settled: false, value: undefined };
  const promise = promptModal('Neue Liste', defaultValue).then((value) => {
    state.settled = true;
    state.value = value;
    return value;
  });
  const { form, input, cancel, group } = parts;
  input.value = defaultValue;
  const held = parts;
  return {
    state,
    promise,
    input,
    group,
    get error() { return held.error; },
    get open() { return overlays.length > 0; },
    submit: () => form._fire('submit'),
    cancel: () => cancel._fire('click'),
    /** Mikrotasks abwarten: `.then` oben laeuft erst nach dem resolve(). */
    settle: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

test('ein leeres Feld loest nicht auf: der Dialog bleibt offen und meldet am Feld', async () => {
  const dialog = openPrompt('');
  const event = dialog.submit();
  await dialog.settle();

  assert.equal(event.defaultPrevented, true, 'das Formular wurde wirklich abgeschickt');
  assert.equal(dialog.state.settled, false, 'leeres Speichern hat den Dialog beantwortet (wie Abbrechen)');
  assert.equal(dialog.open, true, 'der Dialog ist nach leerem Speichern zu');
  assert.equal(dialog.group.classList.contains('form-field--error'), true, 'das Feld traegt keinen Fehlerzustand');
  assert.equal(dialog.input.getAttribute('aria-invalid'), 'true');
  assert.equal(dialog.error?.textContent, 'common.required', 'am Feld steht keine Pflichtfeld-Meldung');
  assert.match(dialog.input.getAttribute('aria-describedby') ?? '', /prompt-modal-input-error/);

  await closeModal({ force: true });
});

test('nur Leerzeichen gelten als leer', async () => {
  const dialog = openPrompt('');
  dialog.input.value = '   ';
  dialog.submit();
  await dialog.settle();
  assert.equal(dialog.state.settled, false);
  assert.equal(dialog.open, true);
  await closeModal({ force: true });
});

test('nach der Meldung nimmt der Dialog den gefuellten Wert an', async () => {
  // Die andere Richtung: ein Dialog, der nach dem Fehler taub bleibt, haette
  // den stillen Abbruch gegen eine Sackgasse getauscht.
  const dialog = openPrompt('');
  dialog.submit();
  await dialog.settle();
  dialog.input.value = '  Wocheneinkauf ';
  dialog.submit();
  assert.equal(await dialog.promise, 'Wocheneinkauf');
  // Das Versprechen loest beim Absenden auf, das Blatt geht erst mit dem Ende
  // der Ausgangsanimation aus dem Dokument.
  await whenModalClosed();
  assert.equal(dialog.open, false, 'der Dialog blieb nach gueltigem Speichern offen');
});

test('ein geleertes Umbenennen-Feld ist ebenfalls keine Antwort', async () => {
  // Alle Aufrufer mit Vorbelegung (Liste, Ordner, Kategorie, Teilschritt)
  // behandelten das geleerte Feld wie Abbrechen - der alte Name blieb, ohne
  // dass der Dialog es sagte.
  const dialog = openPrompt('Alter Name');
  dialog.input.value = '';
  dialog.submit();
  await dialog.settle();
  assert.equal(dialog.state.settled, false);
  assert.equal(dialog.open, true);
  await closeModal({ force: true });
});

test('Abbrechen liefert weiter null, auch nach einer Fehlermeldung', async () => {
  const dialog = openPrompt('');
  dialog.submit();
  await dialog.settle();
  dialog.cancel();
  assert.equal(await dialog.promise, null);
  await whenModalClosed();
  assert.equal(dialog.open, false);
});

test('ein gefuellter Wert geht beim ersten Speichern durch', async () => {
  // Gegenprobe zum Stub: liefert er hier nichts, misst die Datei gar nichts.
  const dialog = openPrompt('Baumarkt');
  dialog.submit();
  assert.equal(await dialog.promise, 'Baumarkt');
  await whenModalClosed();
});
