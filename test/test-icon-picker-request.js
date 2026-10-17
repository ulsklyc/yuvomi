/**
 * Symbolauswahl: eine Anforderung auf einmal, und nur, solange ihr Aufrufer
 * steht (Review #2049, Runde 2).
 *
 * Seit icon-picker.css erst mit dem ersten Oeffnen kommt (Critique R19), liegt
 * zwischen Tipp und Dialog ein Abruf. Gemessen wird der ECHTE openIconPicker()
 * mit dem echten component-style.js gegen ein kleines Dokument, dessen Blatt
 * der Test selbst laden laesst. Nur der Aufbau des Dialogs ist eine Attrappe
 * (`__test.setPresenter`): er braucht ein echtes <dialog>, und um ihn geht es
 * hier nicht - sondern darum, OB er gebaut wird.
 *
 * Laeuft mit test/test-browser-loader.mjs (Browser-absolute Importe).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HREF = '/styles/icon-picker.css';

// Genau das, was component-style.js und openIconPicker() anfassen.
function fakeDocument() {
  const children = [];
  const make = (tag) => {
    const listeners = {};
    return {
      tagName: tag.toUpperCase(), rel: '', href: '', sheet: null, dataset: {}, attrs: {}, isConnected: false,
      getAttribute(name) { return name === 'href' ? this.href : this.attrs[name] ?? null; },
      setAttribute(name, value) { this.attrs[name] = value; },
      removeAttribute(name) { delete this.attrs[name]; },
      addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
      fire(type) { if (type === 'load') this.sheet = {}; for (const fn of listeners[type] ?? []) fn(); },
      before(node) { children.splice(children.indexOf(this), 0, node); node.isConnected = true; },
      remove() { const at = children.indexOf(this); if (at >= 0) children.splice(at, 1); this.isConnected = false; },
    };
  };
  const slot = make('meta');
  slot.isConnected = true;
  children.push(slot);
  return {
    children,
    createElement: make,
    head: { querySelector: (sel) => (sel === 'meta[name="component-styles"]' ? slot : null), appendChild() {} },
    querySelectorAll: (sel) => (sel === 'link[rel="stylesheet"]' ? children.filter((c) => c.tagName === 'LINK') : []),
    styleLink: () => children.find((c) => c.href === HREF),
  };
}

async function setup() {
  const doc = fakeDocument();
  globalThis.document = doc;
  globalThis.window = {
    location: { pathname: '/settings/modules/health' },
    lucide: { icons: { Syringe: [], Pill: [] } },
  };
  const mod = await import(`../public/components/icon-picker.js?t=${Date.now()}-${Math.random()}`);
  const shown = [];
  mod.__test.setPresenter((current, resolve) => {
    const dialog = { isConnected: true };
    shown.push({ current, resolve, dialog });
    return dialog;
  });
  const owner = () => ({ isConnected: true });
  return { doc, mod, shown, owner };
}

const settle = () => new Promise((resolve) => { setImmediate(resolve); });
// Ein Aufrufer, der nie eine Antwort bekommt, haengt sonst die ganze Suite auf.
const HANGS = Symbol('haengt');
const within = (promise, ms = 200) => Promise.race([
  promise,
  new Promise((resolve) => { setTimeout(() => resolve(HANGS), ms); }),
]);

test('das Blatt kommt erst, nachdem der Aufrufer geschlossen hat: kein Dialog, Abbruch fuer den Aufrufer', async () => {
  const { doc, mod, shown, owner } = await setup();
  const trigger = owner();
  const chosen = mod.openIconPicker('pill', { owner: trigger });
  await settle();
  assert.equal(shown.length, 0, 'der Dialog wartet auf sein Blatt');
  trigger.isConnected = false; // das Formular ist zu
  doc.styleLink().fire('load');
  assert.equal(await within(chosen), undefined, 'der Aufrufer bekommt "nichts aendern"');
  assert.equal(shown.length, 0, 'ein Dialog ueber einer Seite, die nie nach ihm fragte');
});

test('das Blatt kommt erst nach einem Seitenwechsel: kein Dialog', async () => {
  const { doc, mod, shown } = await setup();
  const chosen = mod.openIconPicker(null); // ein Aufrufer ohne owner
  await settle();
  globalThis.window.location.pathname = '/tasks';
  doc.styleLink().fire('load');
  assert.equal(await within(chosen), undefined);
  assert.equal(shown.length, 0, 'der Dialog oeffnet ueber dem neuen Ziel');
});

test('zwei Tipps, waehrend das Blatt laedt: ein Dialog', async () => {
  const { doc, mod, shown, owner } = await setup();
  const trigger = owner();
  const first = mod.openIconPicker('pill', { owner: trigger });
  const second = mod.openIconPicker('pill', { owner: trigger });
  assert.equal(await within(second), undefined, 'der zweite Tipp endet als Abbruch');
  doc.styleLink().fire('load');
  await settle();
  assert.equal(shown.length, 1, 'ein Doppeltipp baut zwei modale Dialoge');
  // Solange der Dialog offen ist, oeffnet kein weiterer.
  assert.equal(await within(mod.openIconPicker('pill', { owner: trigger })), undefined);
  assert.equal(shown.length, 1);
  shown[0].resolve('syringe');
  assert.equal(await within(first), 'syringe', 'die Wahl kommt beim ersten Aufrufer an');
  // Danach oeffnet die Auswahl wieder.
  const again = mod.openIconPicker('syringe', { owner: trigger });
  await settle();
  assert.equal(shown.length, 2);
  shown[1].resolve(null);
  assert.equal(await within(again), null);
});

test('eine veraltete Anforderung blockiert die naechste nicht', async () => {
  const { doc, mod, shown, owner } = await setup();
  const gone = owner();
  const stale = mod.openIconPicker(null, { owner: gone });
  gone.isConnected = false;
  const fresh = mod.openIconPicker(null, { owner: owner() });
  assert.equal(await within(stale), undefined, 'die veraltete endet');
  doc.styleLink().fire('load');
  await settle();
  assert.equal(shown.length, 1, 'die neue oeffnet');
  shown[0].resolve('pill');
  assert.equal(await within(fresh), 'pill');
});

test('jeder Aufrufer nennt seinen Ausloeser', () => {
  // Ohne `owner` faellt die Pruefung auf die Seite zurueck - ein Formular,
  // das auf derselben Seite schliesst, bekaeme den Dialog trotzdem.
  const callers = [
    '../public/settings/pages/modules-health.js',
    '../public/components/quick-links-manager.js',
    '../public/pages/schedule.js',
    '../public/pages/waste.js',
  ];
  for (const file of callers) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    const calls = src.match(/openIconPicker\([^;]*\);/g) ?? [];
    assert.ok(calls.length >= 1, `${file}: kein Aufruf gefunden - der Guard misst nichts`);
    for (const call of calls) assert.match(call, /owner:/, `${file}: ${call} ohne owner`);
  }
});
