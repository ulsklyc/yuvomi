/**
 * Tests: Modal Utilities (wireBlurValidation, btnSuccess, btnError)
 * Modul: /public/components/modal.js
 * Läuft im Node-Kontext - die Utility-Funktionen greifen ausschließlich
 * über ihre Parameter auf DOM-Objekte zu, daher kein DOM-Polyfill nötig.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// /i18n.js wird durch test-browser-loader.mjs gemockt (--loader Flag)
const { wireBlurValidation, btnSuccess, btnError } = await import('../public/components/modal.js');

// matchMedia und document.createElementNS werden von btnSuccess/btnError benötigt
global.matchMedia = () => ({ matches: false });

const _makeSvgEl = (tag) => {
  const attrs = {};
  const children = [];
  return {
    tag,
    setAttribute(k, v) { attrs[k] = v; },
    appendChild(child) { children.push(child); },
    get outerHTML() {
      const attrStr = Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join('');
      const inner = children.map(c => c.outerHTML ?? '').join('');
      return `<${tag}${attrStr}>${inner}</${tag}>`;
    },
    _attrs: attrs,
    _children: children,
  };
};
global.document = {
  createElementNS: (_ns, tag) => _makeSvgEl(tag),
  // _ensureFieldError legt die Fehlermeldung als <p> an.
  createElement: (tag) => ({ tagName: tag.toUpperCase(), className: '', id: '', textContent: '' }),
};

const _origSetTimeout = setTimeout;

// --------------------------------------------------------
// DOM-Mocks
// --------------------------------------------------------

/**
 * Feldgruppe. `withDom: false` liefert bewusst einen schlanken Container ohne
 * querySelector/appendChild - die Klassen-Umschaltung muss auch damit laufen.
 */
function makeField({ withDom = true } = {}) {
  const classes = new Set();
  const listeners = {};
  const dataset = {};
  const children = [];
  const field = {
    dataset,
    offsetWidth: 0,
    classList: {
      toggle(cls, force) { force ? classes.add(cls) : classes.delete(cls); },
      add(cls) { classes.add(cls); },
      remove(cls) { classes.delete(cls); },
      contains(cls) { return classes.has(cls); },
    },
    addEventListener(event, fn) { listeners[event] = fn; },
    _classes: classes,
    _listeners: listeners,
    _children: children,
  };
  if (withDom) {
    field.querySelector = (sel) => children.find((c) => `.${c.className}` === sel) ?? null;
    field.appendChild = (node) => { children.push(node); return node; };
  }
  return field;
}

function makeInput({ value = '', required = true } = {}) {
  const listeners = {};
  const attrs = {};
  const field = makeField();
  return {
    value,
    required,
    _field: field,
    _listeners: listeners,
    _attrs: attrs,
    addEventListener(event, fn) { listeners[event] = fn; },
    closest() { return field; },
    parentElement: field,
    setAttribute(k, v) { attrs[k] = v; },
    getAttribute(k) { return attrs[k] ?? null; },
    removeAttribute(k) { delete attrs[k]; },
  };
}

function makeContainer(inputs = []) {
  return {
    querySelectorAll(selector) {
      if (selector.includes('required')) return inputs;
      return [];
    },
  };
}

function makeBtn({ textContent = 'Speichern' } = {}) {
  const classes = new Set();
  const listeners = {};
  let _children = [];
  return {
    textContent,
    get innerHTML() {
      return _children.map(c => c?.outerHTML ?? '').join('');
    },
    offsetWidth: 0,
    classList: {
      add(cls) { classes.add(cls); },
      remove(cls) { classes.delete(cls); },
      contains(cls) { return classes.has(cls); },
    },
    replaceChildren(...nodes) { _children = nodes; },
    addEventListener(event, fn) { listeners[event] = fn; },
    _classes: classes,
    _listeners: listeners,
  };
}

// --------------------------------------------------------
// wireBlurValidation
// --------------------------------------------------------

test('wireBlurValidation: registriert blur-Listener auf required inputs', () => {
  const input = makeInput();
  wireBlurValidation(makeContainer([input]));
  assert.equal(typeof input._listeners['blur'], 'function');
});

test('wireBlurValidation: blur mit leerem Wert setzt form-field--error', () => {
  const input = makeInput({ value: '' });
  wireBlurValidation(makeContainer([input]));
  input._listeners['blur']();
  assert.ok(input._field._classes.has('form-field--error'));
  assert.ok(!input._field._classes.has('form-field--valid'));
  assert.equal(input._attrs['aria-invalid'], 'true');
});

test('wireBlurValidation: blur mit gültigem Wert setzt form-field--valid', () => {
  const input = makeInput({ value: 'Hallo' });
  wireBlurValidation(makeContainer([input]));
  input._listeners['blur']();
  assert.ok(input._field._classes.has('form-field--valid'));
  assert.ok(!input._field._classes.has('form-field--error'));
  assert.equal(input._attrs['aria-invalid'], 'false');
});

test('wireBlurValidation: Whitespace-only gilt als leer → form-field--error', () => {
  const input = makeInput({ value: '   ' });
  wireBlurValidation(makeContainer([input]));
  input._listeners['blur']();
  assert.ok(input._field._classes.has('form-field--error'));
  assert.equal(input._attrs['aria-invalid'], 'true');
});

test('wireBlurValidation: kein Fehler wenn closest() null zurückgibt', () => {
  const input = makeInput({ value: '' });
  input.closest = () => null;
  input.parentElement = null;
  wireBlurValidation(makeContainer([input]));
  assert.doesNotThrow(() => input._listeners['blur']());
});

// Feldbezogene Fehlermeldung + aria-describedby (Critique-Nachlauf #534):
// ein Sammelbanner am Formularende erfüllt WCAG 3.3.1 nicht, weil die Meldung
// nie mit dem Feld verknüpft ist.
test('wireBlurValidation: legt Fehlermeldung an und verknüpft sie per aria-describedby', () => {
  const input = makeInput({ value: '' });
  input.id = 'cardav-name';
  wireBlurValidation(makeContainer([input]));
  input._listeners['blur']();

  const errorEl = input._field._children.find((c) => c.className === 'form-field__error');
  assert.ok(errorEl, 'Fehlermeldung wurde angelegt');
  assert.equal(errorEl.id, 'cardav-name-error');
  assert.ok(errorEl.textContent.length > 0, 'Meldung hat Text');
  assert.equal(input._attrs['aria-describedby'], 'cardav-name-error');
});

test('wireBlurValidation: legt die Meldung nur einmal an', () => {
  const input = makeInput({ value: '' });
  input.id = 'cardav-url';
  wireBlurValidation(makeContainer([input]));
  input._listeners['blur']();
  input._listeners['blur']();
  const errors = input._field._children.filter((c) => c.className === 'form-field__error');
  assert.equal(errors.length, 1);
  assert.equal(input._attrs['aria-describedby'], 'cardav-url-error');
});

test('wireBlurValidation: schlanker Container ohne DOM-API bleibt fehlerfrei', () => {
  const input = makeInput({ value: '' });
  input._field = makeField({ withDom: false });
  input.closest = () => input._field;
  input.parentElement = input._field;
  wireBlurValidation(makeContainer([input]));
  assert.doesNotThrow(() => input._listeners['blur']());
  assert.ok(input._field._classes.has('form-field--error'));
});

// --------------------------------------------------------
// btnSuccess
// --------------------------------------------------------

test('btnSuccess: fügt btn--success-Klasse hinzu', () => {
  global.setTimeout = () => {};
  const btn = makeBtn();
  btnSuccess(btn, 'Test');
  assert.ok(btn._classes.has('btn--success'));
  global.setTimeout = _origSetTimeout;
});

test('btnSuccess: setzt SVG-Checkmark als innerHTML', () => {
  global.setTimeout = () => {};
  const btn = makeBtn();
  btnSuccess(btn, 'Test');
  assert.ok(btn.innerHTML.includes('<svg'));
  assert.ok(btn.innerHTML.includes('polyline'));
  global.setTimeout = _origSetTimeout;
});

test('btnSuccess: stellt Label nach 700ms wieder her', () => {
  let capturedFn, capturedMs;
  global.setTimeout = (fn, ms) => { capturedFn = fn; capturedMs = ms; };
  const btn = makeBtn({ textContent: 'Speichern' });
  btnSuccess(btn, 'Speichern');
  assert.equal(capturedMs, 700);
  capturedFn();
  assert.ok(!btn._classes.has('btn--success'));
  assert.equal(btn.textContent, 'Speichern');
  global.setTimeout = _origSetTimeout;
});

test('btnSuccess: nutzt btn.textContent als Fallback wenn kein Label übergeben', () => {
  let capturedFn;
  global.setTimeout = (fn) => { capturedFn = fn; };
  const btn = makeBtn({ textContent: 'Automatisch' });
  btnSuccess(btn);
  capturedFn();
  assert.equal(btn.textContent, 'Automatisch');
  global.setTimeout = _origSetTimeout;
});

// --------------------------------------------------------
// btnError
// --------------------------------------------------------

test('btnError: fügt btn--shaking-Klasse hinzu', () => {
  const btn = makeBtn();
  btnError(btn);
  assert.ok(btn._classes.has('btn--shaking'));
});

test('btnError: entfernt btn--shaking nach animationend', () => {
  const btn = makeBtn();
  btnError(btn);
  btn._listeners['animationend']();
  assert.ok(!btn._classes.has('btn--shaking'));
});

test('btnError: entfernt btn--shaking zuerst um Animation-Restart zu erzwingen', () => {
  const order = [];
  const btn = makeBtn();
  const origAdd = btn.classList.add.bind(btn);
  const origRemove = btn.classList.remove.bind(btn);
  btn.classList.remove = (cls) => { order.push(`remove:${cls}`); origRemove(cls); };
  btn.classList.add    = (cls) => { order.push(`add:${cls}`);    origAdd(cls); };
  btnError(btn);
  assert.equal(order[0], 'remove:btn--shaking');
  assert.equal(order[1], 'add:btn--shaking');
});
