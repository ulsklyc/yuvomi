/**
 * Modul: Toast anzeigen - Frist und Ansage (Re-Critique 2026-09-28, A1 P2-3/P2-4)
 * Zweck: Zwei Zusagen von public/utils/toast-show.js, die man einem Toast im
 *        Browser nur mit Stoppuhr ansieht:
 *   1. DIE FRIST PAUSIERT, solange Zeiger oder Fokus auf dem Toast liegen, und
 *      setzt danach mit mindestens 2s Rest fort. Vorher lief `setTimeout(dismiss,
 *      duration)` stur ab: wer zu "Rueckgaengig" tabbte, sah den Toast unter dem
 *      Fokus verschwinden (WCAG 2.2.1).
 *   2. DIE ANSAGE BLEIBT IMMER. Der Zaehler fuer Erfolgs-Toasts (50, dann still)
 *      unterdrueckte Flaeche UND Ansage: ab dem 51. Erfolg hoerte ein
 *      Screenreader nie mehr "Gespeichert". Jetzt verstummt nur die Flaeche, der
 *      Text landet weiter in der hoeflichen Live-Region.
 * Ausfuehren: node --loader ./test/test-browser-loader.mjs --test test/test-toast-show.js
 *
 * Eigene DOM-Attrappe statt globaler Reste anderer Tests: jeder Test baut sie
 * neu und raeumt sie wieder ab.
 */

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

class FakeClassList {
  constructor(el) { this.el = el; }
  get set() { return new Set(this.el.className.split(/\s+/).filter(Boolean)); }
  add(...c) { const s = this.set; c.forEach((x) => s.add(x)); this.el.className = [...s].join(' '); }
  remove(...c) { const s = this.set; c.forEach((x) => s.delete(x)); this.el.className = [...s].join(' '); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) { const on = force ?? !this.contains(c); if (on) this.add(c); else this.remove(c); return on; }
}

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.className = '';
    this.classList = new FakeClassList(this);
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = {};
    this.listeners = {};
    this._text = '';
    this.id = '';
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  appendChild(child) { child.parentNode?.removeChild?.(child); child.parentNode = this; this.children.push(child); return child; }
  append(...c) { c.forEach((x) => this.appendChild(x)); }
  removeChild(child) { this.children = this.children.filter((c) => c !== child); child.parentNode = null; }
  remove() { this.parentNode?.removeChild(this); }
  contains(node) { if (node === this) return true; return this.children.some((c) => c.contains(node)); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn); }
  dispatch(type, init = {}) { for (const fn of [...(this.listeners[type] ?? [])]) fn({ type, target: this, ...init }); }
  setPointerCapture() {}
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
}

function installDom() {
  const polite = new FakeElement('div');
  polite.className = 'toast-container';
  polite.setAttribute('id', 'toast-container-polite');
  polite.setAttribute('aria-live', 'polite');
  const assertive = new FakeElement('div');
  assertive.className = 'toast-container';
  assertive.setAttribute('id', 'toast-container-assertive');
  assertive.setAttribute('aria-live', 'assertive');
  const byId = { 'toast-container-polite': polite, 'toast-container-assertive': assertive };
  const store = new Map();
  globalThis.document = {
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    getElementById: (id) => byId[id] ?? null,
    querySelectorAll: (sel) => {
      if (sel !== '.toast-container .toast') throw new Error(`Attrappe kennt ${sel} nicht`);
      return [...polite.walk(), ...assertive.walk()].filter((e) => e.classList.contains('toast'));
    },
  };
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  return { polite, assertive, store };
}

function removeDom() {
  delete globalThis.document;
  delete globalThis.localStorage;
}

const toastsIn = (container) => container.children.filter((c) => c.classList.contains('toast'));
const leaving = (toast) => toast.classList.contains('toast--out');

test('Frist: Zeiger auf dem Toast haelt ihn, danach bleiben mindestens 2s', async () => {
  const { polite } = installDom();
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { showToast } = await import('../public/utils/toast-show.js');
    showToast('Geloescht', 'default', 5000, () => {});
    const [toast] = toastsIn(polite);
    assert.ok(toast, 'kein Toast angelegt');
    mock.timers.tick(4500);
    toast.dispatch('pointerenter');
    mock.timers.tick(20000);
    assert.equal(leaving(toast), false, 'der Toast lief unter dem Zeiger ab');
    toast.dispatch('pointerleave');
    mock.timers.tick(1900);
    assert.equal(leaving(toast), false, 'nach dem Zeiger blieben weniger als 2s - die Restfrist von 500ms lief einfach weiter');
    mock.timers.tick(200);
    assert.equal(leaving(toast), true, 'nach der Restfrist muss der Toast gehen');
  } finally {
    mock.timers.reset();
    removeDom();
  }
});

test('Frist: Fokus im Toast haelt ihn, ein Fokuswechsel innerhalb laesst ihn stehen', async () => {
  const { polite } = installDom();
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { showToast } = await import('../public/utils/toast-show.js');
    showToast('Geloescht', 'default', 5000, () => {});
    const [toast] = toastsIn(polite);
    const undo = toast.children.find((c) => c.className === 'toast__undo');
    assert.ok(undo, 'Rueckgaengig-Knopf fehlt');
    mock.timers.tick(3000);
    toast.dispatch('focusin', { target: undo });
    mock.timers.tick(30000);
    assert.equal(leaving(toast), false, 'der Toast verschwand unter dem Fokus');
    // Fokus wandert innerhalb des Toasts: keine Wiederaufnahme.
    toast.dispatch('focusout', { target: undo, relatedTarget: toast });
    mock.timers.tick(30000);
    assert.equal(leaving(toast), false, 'ein Fokuswechsel im Toast startete die Frist');
    toast.dispatch('focusout', { target: undo, relatedTarget: null });
    mock.timers.tick(2000);
    assert.equal(leaving(toast), true, 'nach dem Fokus laeuft der Rest (hier 2s) ab');
  } finally {
    mock.timers.reset();
    removeDom();
  }
});

test('Frist: Zeiger UND Fokus - erst wenn beide gehen, laeuft sie weiter', async () => {
  const { polite } = installDom();
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { showToast } = await import('../public/utils/toast-show.js');
    showToast('Geloescht', 'default', 5000, () => {});
    const [toast] = toastsIn(polite);
    toast.dispatch('pointerenter');
    toast.dispatch('focusin', { target: toast });
    toast.dispatch('pointerleave');
    mock.timers.tick(30000);
    assert.equal(leaving(toast), false, 'der Fokus lag noch auf dem Toast');
    toast.dispatch('focusout', { target: toast, relatedTarget: null });
    mock.timers.tick(5000);
    assert.equal(leaving(toast), true);
  } finally {
    mock.timers.reset();
    removeDom();
  }
});

test('Ohne Beruehrung geht der Toast nach seiner Frist', async () => {
  const { polite } = installDom();
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { showToast } = await import('../public/utils/toast-show.js');
    showToast('Gespeichert', 'default', 3000);
    const [toast] = toastsIn(polite);
    mock.timers.tick(2999);
    assert.equal(leaving(toast), false);
    mock.timers.tick(1);
    assert.equal(leaving(toast), true);
  } finally {
    mock.timers.reset();
    removeDom();
  }
});

test('Erfolgs-Zaehler: ab dem 51. verstummt die Flaeche, die Ansage bleibt', async () => {
  const { polite, store } = installDom();
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { showToast, TOAST_SUCCESS_MAX } = await import('../public/utils/toast-show.js');
    store.set('yuvomi:toastSuccessCount', String(TOAST_SUCCESS_MAX));
    showToast('Gespeichert', 'success');
    assert.equal(toastsIn(polite).length, 0, 'die sichtbare Flaeche darf nach dem Zaehler still sein');
    assert.match(polite.textContent, /Gespeichert/,
      'nach 50 Erfolgen erfuhr ein Screenreader nie mehr "Gespeichert" - die Ansage muss in die hoefliche Region');
    const announce = polite.children.find((c) => c.textContent.includes('Gespeichert'));
    assert.ok(announce.classList.contains('sr-only'), 'die Ansage ist unsichtbar (sr-only), sonst waere es wieder ein Toast');
    mock.timers.tick(10000);
    assert.equal(polite.children.length, 0, 'die Ansage raeumt sich wieder ab');
  } finally {
    mock.timers.reset();
    removeDom();
  }
});

test('Erfolgs-Zaehler: ein Speicher, der wirft, kostet keine Rueckmeldung', async () => {
  const { polite } = installDom();
  globalThis.localStorage = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('SecurityError'); },
  };
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { showToast } = await import('../public/utils/toast-show.js');
    assert.doesNotThrow(() => showToast('Gespeichert', 'success'));
    assert.equal(toastsIn(polite).length, 1, 'ohne Speicher zaehlt nichts - der Toast erscheint');
  } finally {
    mock.timers.reset();
    removeDom();
  }
});
