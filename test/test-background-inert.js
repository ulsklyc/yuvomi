/**
 * Tests: der Hintergrund einer eigenen modalen Ebene wird inert
 * Modul: /public/utils/background-inert.js
 * Ausfuehren: npm run test:background-inert
 *
 * Modern-Web-Guidance-Audit, Befund 10: Ebenen mit `aria-modal="true"`, die
 * kein natives `<dialog>` sind (Mehr-Blatt, Suche, Rundgang, die Picker im
 * Dialog), liessen den Hintergrund bedienbar. `inertOutside()` sperrt ihn und
 * gibt ihn wieder frei. Der Baum hier ist eine Attrappe mit echten
 * Eltern-Kind-Beziehungen; was der Browser aus `inert` macht, misst die
 * Browserpruefung des Umbaus.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { inertOutside } = await import('../public/utils/background-inert.js');

function el(name, tag = 'DIV', classes = []) {
  const node = {
    name, tagName: tag, nodeType: 1, children: [], parentElement: null, inert: false, open: false,
    classes: new Set(classes),
    append(...kids) { for (const k of kids) { k.parentElement = node; node.children.push(k); } return node; },
    contains(other) { for (let n = other; n; n = n.parentElement) if (n === node) return true; return false; },
    matches(sel) {
      if (sel === 'dialog[open]') return tag === 'DIALOG' && node.open;
      if (sel.startsWith('.')) return node.classes.has(sel.slice(1));
      return false;
    },
    closest(sel) { for (let n = node; n; n = n.parentElement) if (n.matches(sel)) return n; return null; },
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } };
      walk(node);
      return out;
    },
  };
  return node;
}

/** body > [#app > (header, main, sheet, backdrop), stack > (pill, toasts), script] */
function page() {
  const body = el('body', 'BODY');
  const app = el('#app');
  const header = el('header');
  const main = el('main');
  const sheet = el('sheet');
  const backdrop = el('backdrop');
  app.append(header, main, sheet, backdrop);
  const stack = el('stack', 'DIV', ['shell-bottom-stack']);
  const pill = el('pill', 'DIV', ['bulk-pill-layer']);
  const toasts = el('toasts', 'DIV', ['toast-container']);
  stack.append(pill, toasts);
  const script = el('script', 'SCRIPT');
  body.append(app, stack, script);
  globalThis.document = { body };
  return { body, app, header, main, sheet, backdrop, stack, pill, toasts, script };
}

test('auf der Seite: alles ausser der Ebene, ihrer Abdunklung und den Toasts wird inert', () => {
  const p = page();
  const release = inertOutside(p.sheet, { keep: [p.backdrop] });
  assert.equal(p.header.inert, true);
  assert.equal(p.main.inert, true);
  assert.equal(p.app.inert, false, 'der Zweig mit der Ebene wird durchlaufen, nicht gesperrt - inert erbte sich in die Ebene');
  assert.equal(p.sheet.inert, false);
  assert.equal(p.backdrop.inert, false, 'die Abdunklung schliesst per Klick und muss bedienbar bleiben');
  assert.equal(p.toasts.inert, false, 'ein Rueckgaengig im Toast bleibt erreichbar');
  assert.equal(p.stack.inert, false, 'der Stapel wird durchlaufen, nicht gesperrt');
  assert.equal(p.pill.inert, true, 'die Sammelaktions-Pille aendert Daten und gehoert zum Hintergrund (Codex-Review zu #2058)');
  assert.equal(p.script.inert, false);
  release();
  assert.equal(p.header.inert, false);
  assert.equal(p.main.inert, false);
});

test('im offenen Dialog: nur der Dialog wird gesperrt, die Seite dahinter macht showModal() schon inert', () => {
  const p = page();
  const dialog = el('dialog', 'DIALOG');
  dialog.open = true;
  const panel = el('panel');
  const head = el('head');
  const form = el('form');
  const picker = el('picker');
  panel.append(head, form, picker);
  dialog.append(panel);
  p.body.append(dialog);
  const release = inertOutside(picker);
  assert.equal(head.inert, true);
  assert.equal(form.inert, true);
  assert.equal(picker.inert, false);
  assert.equal(panel.inert, false);
  assert.equal(p.main.inert, false, 'ausserhalb des Dialogs fasst der Helfer nichts an');
  release();
  assert.equal(form.inert, false);
});

test('was vorher schon inert war, bleibt es; zwei Ebenen geben gemeinsam frei', () => {
  const p = page();
  p.header.inert = true; // etwa ein geparkter Dialog
  const first = inertOutside(p.sheet, { keep: [p.backdrop] });
  const second = inertOutside(p.sheet, { keep: [p.backdrop] });
  first();
  assert.equal(p.main.inert, true, 'die zweite Ebene haelt den Zweig noch');
  second();
  assert.equal(p.main.inert, false);
  assert.equal(p.header.inert, true, 'ein fremdes inert nimmt die Freigabe nicht zurueck');
  second();
  assert.equal(p.main.inert, false, 'eine doppelte Freigabe zaehlt nicht doppelt');
});

test('eine Ebene ausserhalb ihres Bereichs sperrt nichts', () => {
  const p = page();
  const loose = el('loose');
  const release = inertOutside(loose);
  assert.equal(p.main.inert, false);
  release();
});

// Codex-Review zu #2058: die Navigation baut ihre Tabs neben dem Mehr-Knopf neu
// auf, waehrend das Blatt offen ist. Ein durchlaufener Zweig bekommt dabei neue
// Kinder - sie gehoeren zum Hintergrund und werden mitgesperrt.
test('spaeter in einen durchlaufenen Zweig eingefuegte Knoten werden mitgesperrt', () => {
  const observers = [];
  globalThis.MutationObserver = class {
    constructor(cb) { this.cb = cb; this.targets = []; this.off = false; observers.push(this); }
    observe(node) { this.targets.push(node); }
    disconnect() { this.off = true; }
  };
  try {
    const p = page();
    const release = inertOutside(p.sheet, { keep: [p.backdrop] });
    const tab = el('neuer Tab');
    p.app.append(tab);
    const obs = observers.at(-1);
    assert.ok(obs.targets.includes(p.app), 'der durchlaufene Zweig wird beobachtet');
    obs.cb([{ addedNodes: [tab] }]);
    assert.equal(tab.inert, true, 'der neue Tab ist hinter dem Blatt bedienbar');
    release();
    assert.equal(obs.off, true, 'die Freigabe beendet die Beobachtung');
    assert.equal(tab.inert, false, 'und gibt den neuen Tab frei');
  } finally {
    delete globalThis.MutationObserver;
  }
});
