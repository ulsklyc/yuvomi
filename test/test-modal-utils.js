/**
 * Tests: Modal Utilities (wireBlurValidation, btnSuccess, btnError)
 * Modul: /public/components/modal.js
 * Läuft im Node-Kontext - die Utility-Funktionen greifen ausschließlich
 * über ihre Parameter auf DOM-Objekte zu, daher kein DOM-Polyfill nötig.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eachRule } from './css-rules.js';

// /i18n.js wird durch test-browser-loader.mjs gemockt (--loader Flag)
const {
  wireBlurValidation,
  btnSuccess,
  btnError,
  focusRestoreTarget,
  rememberFocus,
  __test: modalTest,
  restoreFocusAfterClose, refocusAfterRender, forgetRestore, renderKeepingFocus,
} = await import('../public/components/modal.js');

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
  // Der Focus-Restore sucht ueber id und ueber die data-Attribute nach einem
  // Ersatz; die Sonden unten bestuecken beides je Fall.
  getElementById: () => null,
  getElementsByTagName: () => [],
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

test('confirmOverModal finalisiert das geparkte Modal gemäß closeOnConfirm', async () => {
  const suspended = { id: 'editor' };
  const resumed = [];
  const closed = [];
  const dependencies = {
    resume: (token) => resumed.push(token),
    close: async (options) => closed.push(options),
  };

  assert.equal(await modalTest.finishSuspendedConfirmation(
    false, true, suspended, dependencies
  ), false);
  assert.deepEqual(resumed, [suspended]);
  assert.deepEqual(closed, []);

  assert.equal(await modalTest.finishSuspendedConfirmation(
    true, false, suspended, dependencies
  ), true);
  assert.deepEqual(resumed, [suspended, suspended]);
  assert.deepEqual(closed, []);

  assert.equal(await modalTest.finishSuspendedConfirmation(
    true, true, suspended, dependencies
  ), true);
  assert.deepEqual(resumed, [suspended, suspended, suspended]);
  assert.deepEqual(closed, [{ force: true }]);
});

test('confirmOverModal orchestration passes closeOnConfirm through the real suspended path', async () => {
  const suspended = { id: 'editor' };
  const confirmations = [];
  const resumed = [];
  const closed = [];
  const confirmOverModal = modalTest.createConfirmOverModal({
    getActiveOverlay: () => ({ id: 'active-overlay' }),
    getModalState: () => 'open',
    showConfirmation: async () => assert.fail('the fallback confirmation must not run'),
    suspend: () => suspended,
    confirmSuspended: async (message, options, token) => {
      confirmations.push({ message, options, token });
      return true;
    },
    resume: (token) => resumed.push(token),
    close: async (options) => closed.push(options),
  });

  assert.equal(await confirmOverModal('Continue saving?', {
    closeOnConfirm: false,
    danger: true,
  }), true);
  assert.deepEqual(confirmations, [{
    message: 'Continue saving?',
    options: { danger: true },
    token: suspended,
  }]);
  assert.deepEqual(resumed, [suspended]);
  assert.deepEqual(closed, []);

  assert.equal(await confirmOverModal('Delete this event?'), true);
  assert.deepEqual(resumed, [suspended, suspended]);
  assert.deepEqual(closed, [{ force: true }]);
});

test('askOverModal parkt das Formular und gibt es nach JEDER Antwort zurueck (#1284)', async () => {
  // Die Frage nach der Reichweite eines Serientermins hat vier Ausgaenge. Das
  // Formular darunter kommt bei allen zurueck: bei einer Wahl, weil danach noch
  // eine Meldung an einer Zeile stehen kann, beim Abbrechen, weil es der
  // einzige Grund ist, ueberhaupt zu fragen.
  const suspended = { id: 'editor' };
  const asked = [];
  const resumed = [];
  let answer = 'series';
  const askOverModal = modalTest.createAskOverModal({
    getActiveOverlay: () => ({ id: 'active-overlay' }),
    getModalState: () => 'open',
    suspend: () => suspended,
    askSuspended: async (ask, token) => { asked.push(token); return ask(); },
    resume: (token) => resumed.push(token),
  });
  assert.equal(await askOverModal(async () => answer), 'series');
  answer = null;
  assert.equal(await askOverModal(async () => answer), null);
  assert.deepEqual(asked, [suspended, suspended]);
  assert.deepEqual(resumed, [suspended, suspended]);
});

test('askOverModal ohne offenes Modal fragt direkt und parkt nichts', async () => {
  for (const [overlay, state] of [[null, 'idle'], [{ id: 'closing' }, 'closing']]) {
    const askOverModal = modalTest.createAskOverModal({
      getActiveOverlay: () => overlay,
      getModalState: () => state,
      suspend: () => assert.fail('nothing to suspend'),
      askSuspended: async () => assert.fail('no suspended path'),
      resume: () => assert.fail('nothing to resume'),
    });
    assert.equal(await askOverModal(async () => 'this'), 'this');
  }
});

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

// --------------------------------------------------------
// Panel-Overflow (#805)
// --------------------------------------------------------

/* Das .modal-panel darf keine Scroll-Box haben.
 *
 * `overflow: hidden` erzeugt eine - unsichtbar fuer den Nutzer (keine
 * Scrollbar), aber programmatisch scrollbar. Chrome ruft beim Fokussieren
 * eines <select> scrollIntoView auf ALLEN Vorfahren auf und schob das Panel
 * dabei um 507px hoch: Kopfzeile und Schliessen-X verliessen das Sichtfeld,
 * ohne Weg zurueck. Ausloeser war ein .sr-only-Input (position:absolute im
 * Fluss), das dem overflow:auto des Bodys entkommt.
 *
 * `overflow: clip` ist visuell deckungsgleich, erzeugt aber gar keine
 * Scroll-Box. Gescrollt wird strukturell nur im Body.
 *
 * Der Guard prueft beide Enden der Zusage - sonst faellt nicht auf, wenn
 * jemand die Regel spaeter im selben Stylesheet auf hidden zuruecksetzt. */
const layoutCss = readFileSync(new URL('../public/styles/layout.css', import.meta.url), 'utf8');

function overflowValuesOf(css, selector) {
  const out = [];
  for (const rule of eachRule(css)) {
    if (!rule.selector.split(',').map((s) => s.trim()).includes(selector)) continue;
    const m = rule.body.match(/(?:^|;)\s*overflow\s*:\s*([^;]+)/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

test('#805: .modal-panel bekommt overflow:clip, nie hidden', () => {
  const werte = overflowValuesOf(layoutCss, '.modal-panel');
  assert.ok(werte.length > 0, '.modal-panel setzt gar kein overflow - die Zusage steht nirgends');
  assert.ok(
    werte.every((v) => v === 'clip'),
    `.modal-panel muss overflow:clip tragen, gefunden: ${werte.join(', ')}. `
    + 'hidden macht das Panel programmatisch scrollbar und schiebt das Schliessen-X aus dem Bild (#805).',
  );
});

test('#805: der Modal-Body bleibt der scrollende Container', () => {
  const rule = [...eachRule(layoutCss)].find((r) => r.selector.trim() === '.modal-panel__body');
  assert.ok(rule, '.modal-panel__body fehlt');
  assert.match(
    rule.body, /overflow-y\s*:\s*auto/,
    '.modal-panel__body muss overflow-y:auto behalten - nimmt man ihm das Scrollen, '
    + 'ist langer Modal-Inhalt hinter dem clip des Panels unerreichbar.',
  );
});

/* Zweite Runde zu #805: der erste Fix sass nur am Panel und hat den Fehler
 * damit bloss eine Ebene hoeher geschoben.
 *
 * Ab 768px trug .modal-panel kein position:relative - das stand allein in der
 * Mobile-Media-Query. In der Rolle des Containing Blocks hielt es sich dort nur
 * durch den transform-Endwert seiner Einfahr-Animation, und den nimmt
 * `prefers-reduced-motion: reduce` weg. Dann faengt das .sr-only-Input am
 * fixed .modal-overlay an, dessen `overflow: hidden` dieselbe unsichtbare
 * Scroll-Box ist: gemessen 1259px Scroll-Hoehe bei 700px Sichtfeld, das Panel
 * liess sich um 507px hochschieben, Kopfzeile und Schliessen-X weg.
 *
 * Beide Enden gehoeren gehalten: dem Overlay die Scroll-Box nehmen UND das
 * Panel breakpoint-unabhaengig zum Containing Block machen. Eine Zusage, die an
 * einer Animation haengt, ist keine. */

test('#805: .modal-overlay bekommt overflow:clip, nie hidden', () => {
  const werte = overflowValuesOf(layoutCss, '.modal-overlay');
  assert.ok(werte.length > 0, '.modal-overlay setzt gar kein overflow - die Zusage steht nirgends');
  assert.ok(
    werte.every((v) => v === 'clip'),
    `.modal-overlay muss overflow:clip tragen, gefunden: ${werte.join(', ')}. `
    + 'hidden macht das Overlay programmatisch scrollbar und schiebt das ganze Panel '
    + 'samt Schliessen-X aus dem Bild (#805).',
  );
});

test('#805: .modal-panel ist auf jeder Breite der Containing Block', () => {
  const regeln = [...eachRule(layoutCss)]
    .filter((r) => r.selector.split(',').map((s) => s.trim()).includes('.modal-panel'))
    .filter((r) => /(?:^|;)\s*position\s*:\s*relative/.test(r.body));
  assert.ok(
    regeln.some((r) => r.at.length === 0),
    '.modal-panel braucht position:relative in der BASISREGEL, nicht nur in einer '
    + `Media-Query (gefunden in: ${regeln.map((r) => r.at.join(' ') || 'Basis').join(' | ') || 'keiner Regel'}). `
    + 'Sonst haengen absolut positionierte Nachfahren am .modal-overlay statt am Panel (#805).',
  );
});


// --------------------------------------------------------
// Focus-Restore, wenn der Ausloeser ausgetauscht wurde
// --------------------------------------------------------

/* WARUM VERHALTENSTESTS UND KEIN QUELLTEXT-GUARD: der Fehler steckt nicht in
 * der Schreibweise, sondern in der FRAGE, welches Element am Ende den Fokus
 * bekommt. Ein Guard auf „prueft isConnected" bliebe gruen, wenn die Pruefung
 * da stuende und der Rueckfall trotzdem `document.body` traefe - und genau das
 * war der Befund: `.focus()` auf einem abgehaengten Knoten ist ein No-op, ohne
 * Fehler und ohne Spur. Die Sonden messen deshalb das ERGEBNIS.
 *
 * Gemessen wird `rememberFocus()` + `focusRestoreTarget()` und nicht der volle
 * Weg oeffnen-austauschen-schliessen: der braeuchte ein echtes DOM samt
 * HTML-Parser fuer `insertAdjacentHTML`, und das Projekt haelt sich bewusst
 * frei von jsdom. Die Entscheidung liegt vollstaendig in diesen beiden
 * Funktionen; dass `_doClose` sie benutzt und danach nachfasst, halten die
 * letzten beiden Sonden fest.
 *
 * Die Mechanik des Nachfassens ist ausserhalb dieser Suite im Browser gemessen
 * worden (Chrome 152, Puppeteer gegen eine statische Nachbau-Seite): ohne sie
 * landet der Fokus nach `closeModal(); renderGrid();` auf BODY, mit ihr auf dem
 * neu gebauten Knoten.
 *
 * ZWEI GEGENPROBEN, beide durch TOT STELLEN statt Loeschen - ein entfernter
 * Codeblock haette nur einen ReferenceError geworfen und nichts bewiesen. Die
 * Zahlen stehen bei den jeweiligen Sonden.
 */

/**
 * Element-Attrappe: was `rememberFocus()` liest - plus die Attribute.
 *
 * `attrs` beginnt LEER, seit der Review zu #1069 zeigte, dass die Seitenwurzel
 * nicht ueberall fokussierbar ist: eine Attrappe, die ein tabindex immer zu
 * haben scheint, kann den Fall nie sehen - wie das `<main>` der Auth-Seiten.
 */
function makeNode(tag, { id = '', cls = null, data = {}, connected = true, attrs = {}, row = null } = {}) {
  return {
    tagName: tag.toUpperCase(), id, isConnected: connected, dataset: { ...data },
    _attrs: { ...attrs },
    getAttribute: (name) => (name === 'class' ? cls : null),
    // Der Zeilen-Vorfahre: bei Listenzeilen traegt er die Identitaet, nicht der
    // Knopf. `row` ist dessen data-id, oder null wenn es keinen gibt.
    closest: (sel) => (sel === '[data-id]' && row !== null ? { dataset: { id: row } } : null),
    hasAttribute(n) { return n in this._attrs; },
    setAttribute(n, v) { this._attrs[n] = String(v); },    focus() { this._focused = true; },
  };
}

/** Bestueckt die Suchwege von `document` fuer die Dauer eines Falls. */
function withDom({ byId = {}, byTag = {} }, fn) {
  const vorherId  = global.document.getElementById;
  const vorherTag = global.document.getElementsByTagName;
  global.document.getElementById = (id) => byId[id] ?? null;
  global.document.getElementsByTagName = (tag) => byTag[tag] ?? [];
  try { return fn(); } finally {
    global.document.getElementById = vorherId;
    global.document.getElementsByTagName = vorherTag;
  }
}

test('der Fokus geht auf den Ausloeser zurueck, solange er im Dokument haengt', () => {
  const knopf = makeNode('button', { id: 'budget-manage-categories' });
  withDom({}, () => {
    assert.equal(focusRestoreTarget(rememberFocus(knopf)), knopf,
      'ein lebender Ausloeser bleibt das Ziel - der Rueckfall darf den Normalfall nicht umleiten');
  });
});

/* Der urspruenglich gemeldete Fall: `#budget-manage-categories` liegt in
 * `#budget-body`, genau dem Bereich, den `renderBody()` austauscht. */
test('ein ausgetauschter Ausloeser wird ueber seine id wiedergefunden', () => {
  const alt = makeNode('button', { id: 'budget-manage-categories', connected: false });
  const neu = makeNode('button', { id: 'budget-manage-categories' });
  withDom({ byId: { 'budget-manage-categories': neu, 'main-content': makeNode('main', { id: 'main-content' }) } }, () => {
    assert.equal(focusRestoreTarget(rememberFocus(alt)), neu,
      'steht unter derselben id ein lebendes Element, gehoert ihm der Fokus');
  });
});

/* DER HAEUFIGE FALL, und er hat keine id. Eine Notizkarte heisst
 * `.note-card[data-id="42"]`, eine Mahlzeit-Zelle traegt `data-action`,
 * `data-date` und `data-type`. Bei 83 Modal-Oeffnungen im Projekt ist die
 * Listenzeile der typische Ausloeser, nicht der Toolbar-Knopf mit id. */
test('eine Listenzeile ohne id wird ueber ihre data-Attribute wiedergefunden', () => {
  const alt = makeNode('button', { cls: 'note-card', data: { id: '42' }, connected: false });
  const neu = makeNode('button', { cls: 'note-card', data: { id: '42' } });
  const fremd = makeNode('button', { cls: 'note-card', data: { id: '43' } });
  withDom({ byTag: { BUTTON: [fremd, neu] }, byId: { 'main-content': makeNode('main', { id: 'main-content' }) } }, () => {
    assert.equal(focusRestoreTarget(rememberFocus(alt)), neu,
      'die neu gebaute Zeile mit denselben data-Werten muss den Fokus bekommen, nicht die Nachbarzeile');
  });
});

test('eine andere Klasse gilt nicht als dieselbe Zeile', () => {
  const alt = makeNode('button', { cls: 'note-card', data: { id: '42' }, connected: false });
  const andere = makeNode('button', { cls: 'task-row', data: { id: '42' } });
  const wurzel = makeNode('main', { id: 'main-content' });
  withDom({ byTag: { BUTTON: [andere] }, byId: { 'main-content': wurzel } }, () => {
    assert.equal(focusRestoreTarget(rememberFocus(alt)), wurzel,
      'gleiche data-id in einer anderen Liste ist ein anderes Element - lieber die Wurzel als das falsche Ziel');
  });
});

/* Ohne data-Attribute wird NICHT geraten: Tag und Klasse allein treffen
 * irgendeinen Knopf derselben Sorte. Ein falsches Fokusziel ist schlimmer als
 * keines - es setzt den Nutzer an eine Stelle, die er nicht gewaehlt hat. */
test('ohne id und ohne data-Attribute wird nicht geraten, sondern die Wurzel genommen', () => {
  const alt = makeNode('button', { cls: 'btn btn--ghost', connected: false });
  const gleichartig = makeNode('button', { cls: 'btn btn--ghost' });
  const wurzel = makeNode('main', { id: 'main-content' });
  withDom({ byTag: { BUTTON: [gleichartig] }, byId: { 'main-content': wurzel } }, () => {
    assert.equal(focusRestoreTarget(rememberFocus(alt)), wurzel,
      'ein gleich aussehender Knopf ist nicht derselbe Knopf');
  });
});

test('verschwundener Ausloeser ohne Ersatz landet auf der Seitenwurzel', () => {
  const alt = makeNode('button', { id: 'contacts-manage-cats', connected: false });
  const wurzel = makeNode('main', { id: 'main-content' });
  withDom({ byId: { 'main-content': wurzel } }, () => {
    assert.equal(focusRestoreTarget(rememberFocus(alt)), wurzel,
      'findet die Suche nichts, bleibt die Seitenwurzel - document.body ist kein Fokusziel');
  });
});

/* Anmelde- und Setup-Seiten laufen ohne die App-Shell, es gibt dort kein
 * `#main-content`. Dann ohne Ziel schliessen statt zu werfen. */
test('ohne Seitenwurzel liefert der Rueckfall null statt zu werfen', () => {
  const alt = makeNode('button', { id: 'setup-btn', connected: false });
  withDom({}, () => {
    assert.equal(focusRestoreTarget(rememberFocus(alt)), null,
      'ausserhalb der App-Shell gibt es keine Wurzel');
  });
});

test('ohne gemerkten Ausloeser bleibt es bei null', () => {
  withDom({ byId: { 'main-content': makeNode('main', { id: 'main-content' }) } }, () => {
    assert.equal(focusRestoreTarget(null), null, 'nie ein Ausloeser gemerkt, also nichts zurueckzugeben');
    assert.equal(rememberFocus(null), null, 'und kein Merkzettel fuer nichts');
  });
});

/* `document.body` traegt kein `focus`, taucht aber als `activeElement` auf,
 * sobald vorher schon Fokus verloren ging. Ein Merkzettel darauf haette den
 * Wiederfinder auf BODY losgeschickt. */
test('ein Knoten ohne focus() bekommt keinen Merkzettel', () => {
  assert.equal(rememberFocus({ tagName: 'DIV' }), null, 'ohne focus() ist es kein Fokusziel');
});

/* `document.body` ERBT `focus()` von HTMLElement - eine Attrappe ohne die
 * Methode prueft die Ablehnung deshalb gar nicht (genau dieser Fehler stand
 * hier, Review zu #1070). Der Merker auf `body` waere toedlich: `isConnected`
 * immer wahr, der Fokus schon darauf, also braeche jedes Nachfassen sofort ab. */
test('document.body bekommt keinen Merkzettel, obwohl es focus() hat', () => {
  const body = { tagName: 'BODY', focus() {}, id: '', dataset: {}, isConnected: true };
  assert.equal(rememberFocus(body), null,
    'body ist kein Fokusziel, sondern das Fehlen eines - als Merker schaltet es das '
    + 'Nachfassen fuer diesen Schliessvorgang dauerhaft ab');
});

/* GEGENPROBE 1 (durchgefuehrt): in `focusRestoreTarget` ein `return memo.el;`
 * vor die `isConnected`-Weiche, die Funktion also auf das alte Verhalten
 * zurueckgenommen. Gemessen 6 von 30 rot - alle Wiederfinde-Sonden, waehrend
 * der Normalfall gruen blieb (richtig: den deckt das alte Verhalten mit ab). */

/* DIE VERDRAHTUNG. Die Sonden oben pruefen die Entscheidung; diese halten fest,
 * dass `_doClose` sie stellt und danach nachfasst. Ohne sie bliebe die Suite
 * gruen, waehrend der Schliesspfad weiter direkt auf dem gemerkten Zeiger
 * fokussiert - die Funktionen waeren geprueft und ungenutzt.
 *
 * GEGENPROBE 2 (durchgefuehrt): `_doClose` fokussiert wieder direkt und das
 * Nachfassen wird nicht gerufen, beide Funktionen bleiben vollstaendig stehen.
 * Gemessen 2 von 30 rot - genau diese beiden Sonden. */
test('_doClose fokussiert das Ergebnis des Rueckfalls, nicht den gemerkten Zeiger', () => {
  const src = readFileSync(new URL('../public/components/modal.js', import.meta.url), 'utf8');
  const doClose = src.match(/function _doClose\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(doClose, '_doClose nicht gefunden');
  assert.match(doClose, /focusRestoreTarget\(merkzettel\)/,
    '_doClose muss das Fokusziel ueber focusRestoreTarget() bestimmen');
  assert.doesNotMatch(doClose, /previouslyFocused\.focus\(/,
    '_doClose darf nicht mehr direkt auf dem gemerkten Zeiger fokussieren - '
    + 'genau dieser Aufruf ist auf einem abgehaengten Knoten ein stiller No-op');
});

test('_doClose fasst nach, und das Nachfassen behaelt seine Wachen', () => {
  const src = readFileSync(new URL('../public/components/modal.js', import.meta.url), 'utf8');
  const doClose = src.match(/function _doClose\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(doClose, /_refocusIfDropped\(merkzettel, gesetzt\)/,
    '_doClose muss nachfassen - und zwar auf dem TATSAECHLICH gesetzten Ziel');
  assert.match(doClose, /_fokussiereMitRueckfall\(restoreTarget\)/,
    'nimmt der Ersatz den Fokus nicht an, muss _doClose auf die Wurzel ausweichen');

  // Die Wachen sitzen in `_tryRefocus`, das sich beide Wege teilen: das
  // automatische Nachfassen und der oeffentliche `refocusAfterRender()`. Eine
  // zweite Kopie waere die Stelle, an der sie auseinanderlaufen.
  const wachen = src.match(/function _tryRefocus\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(wachen, '_tryRefocus nicht gefunden');
  assert.match(wachen, /ziel\.isConnected && document\.activeElement === ziel && !istRueckfall/,
    'nicht die ANWESENHEIT des Ziels beendet den Lauf, sondern sein FOKUSBESITZ - eine Zeile auf '
    + '`display: none` haengt weiter im Dokument und haelt trotzdem keinen Fokus');
  assert.match(wachen, /document\.activeElement === document\.body/,
    'hat die Seite selbst etwas fokussiert, ist ihre Wahl die bessere');
  assert.match(wachen, /if \(activeOverlay\) return;/,
    'sonst risse das Nachfassen den Fokus aus einem Modal, das in derselben Geste aufgegangen ist');
  assert.doesNotMatch(wachen, /ersatz === ziel\) return|\|\| ersatz === ziel/,
    'ein Abbruch bei "derselbe Ersatz" verfehlt den Fall, der hierher fuehrt: das Ziel haelt den '
    + 'Fokus nicht, ist aber noch verbunden - dann gibt focusRestoreTarget es unveraendert zurueck, '
    + 'und der Rueckfall auf die Wurzel wuerde nie erreicht');
  assert.match(wachen, /_fokussiereMitRueckfall\(ersatz\)/,
    'der Versuch muss durch die Wirkungspruefung mit Rueckfall laufen');

  const oeffentlich = src.match(/export function refocusAfterRender\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(oeffentlich, /_tryRefocus\(/,
    'der oeffentliche Griff muss durch dieselben Wachen wie das automatische Nachfassen');

  // Die Wirkungspruefung ist der Kern: `.focus()` meldet nicht, ob es griff.
  const fok = src.match(/function _fokussiere\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fok, /return document\.activeElement === el;/,
    '_fokussiere muss zurueckmelden, OB der Fokus angekommen ist - ein disabled oder '
    + 'ausgeblendeter Ersatz nimmt ihn nicht an, und genau das ist der stille Ausfall');
});

test('ein vorhandenes tabindex wird nicht ueberschrieben', () => {
  const alt = makeNode('button', { id: 'irgendwas', connected: false });
  const wurzel = makeNode('main', { id: 'main-content', attrs: { tabindex: '0' } });
  withDom({ byId: { 'main-content': wurzel } }, () => {
    focusRestoreTarget(rememberFocus(alt));
    assert.equal(wurzel._attrs.tabindex, '0',
      'eine Seite, die ihrer Wurzel bewusst ein anderes tabindex gibt, behaelt es');
  });
});

/* ZWEITER REVIEW-BEFUND ZU #1069: der Ausloeser KANN die Seitenwurzel sein.
 *
 * Ein Dialog, der geoeffnet wird, waehrend der Fokus auf `#main-content` liegt
 * (Tastenkuerzel, programmatisches Oeffnen), merkt sich die Wurzel als
 * Ausloeser. Beim Schliessen findet die id-Suche dann die NEUE Wurzel und gab
 * sie direkt zurueck - am Fokussierbar-Machen vorbei. Auf einer Auth-Seite ist
 * das wieder ein `<main>` ohne tabindex und `.focus()` wieder ein No-op.
 */
test('auch ein Ersatz, der selbst die Seitenwurzel ist, wird fokussierbar gemacht', () => {
  const alt = makeNode('main', { id: 'main-content', connected: false });
  const neueWurzel = makeNode('main', { id: 'main-content' });        // Auth-Seite: kein tabindex
  withDom({ byId: { 'main-content': neueWurzel } }, () => {
    const ziel = focusRestoreTarget(rememberFocus(alt));
    assert.equal(ziel, neueWurzel, 'die neue Wurzel ist das Ziel');
    assert.equal(ziel.hasAttribute('tabindex'), true,
      'die id-Suche darf nicht am Fokussierbar-Machen vorbeifuehren - sonst ist `.focus()` '
      + 'auf der Auth-Seite wieder ein stiller No-op');
  });
});

/* REVIEW-BEFUND ZU #1070: bei Listenzeilen traegt der Knopf keine Identitaet.
 *
 * `<div class="list-row" data-id="42"><button class="list-row__main"
 * data-action="open-detail">` - so bauen inventory und pantry ihre Zeilen. Tag,
 * Klasse und `data-action` sind bei JEDER Zeile gleich; nur der Vorfahre
 * unterscheidet sie. Ohne den Anker gewann der erste Treffer, und der Fokus
 * landete nach dem Speichern zuverlaessig auf Zeile eins statt auf der Zeile,
 * aus der der Dialog kam.
 */
test('eine Zeile wird ueber ihren Vorfahren unterschieden, nicht ueber den Knopf allein', () => {
  const opts = { cls: 'list-row__main', data: { action: 'open-detail' } };
  const alt   = makeNode('button', { ...opts, row: '42', connected: false });
  const zeile1 = makeNode('button', { ...opts, row: '7' });
  const zeile42 = makeNode('button', { ...opts, row: '42' });
  withDom({ byTag: { BUTTON: [zeile1, zeile42] }, byId: { 'main-content': makeNode('main', { id: 'main-content' }) } }, () => {
    assert.equal(focusRestoreTarget(rememberFocus(alt)), zeile42,
      'der Fokus gehoert der Zeile, aus der der Dialog kam - nicht der ersten der Liste');
  });
});

/* Bleiben mehrere Kandidaten, ist keiner nachweislich der gesuchte. Dann ist
 * die Wurzel die ehrlichere Antwort: ein falsches Fokusziel setzt den Nutzer an
 * eine Stelle, die er nicht gewaehlt hat. */
test('mehrdeutige Treffer werden abgelehnt statt geraten', () => {
  const opts = { cls: 'list-row__main', data: { action: 'open-detail' } };
  const alt = makeNode('button', { ...opts, connected: false });   // kein row-Anker
  const a = makeNode('button', opts);
  const b = makeNode('button', opts);
  const wurzel = makeNode('main', { id: 'main-content' });
  withDom({ byTag: { BUTTON: [a, b] }, byId: { 'main-content': wurzel } }, () => {
    assert.equal(focusRestoreTarget(rememberFocus(alt)), wurzel,
      'zwei gleich aussehende Zeilen: lieber die Wurzel als die falsche');
  });
});

/* REVIEW ZU #1070, RUNDE 5. Zwei Faelle, in denen `.focus()` wieder still
 * fehlschlaegt oder ein Fokus an falscher Stelle haengen bleibt.
 */

/* Ein neu gebauter Knopf kann DEAKTIVIERT sein - in rewards wird der
 * Einloesen-Knopf es, sobald die Punkte nicht mehr reichen. Er ist dann der
 * eindeutige Treffer und nimmt den Fokus trotzdem nicht an. Ohne Rueckmeldung
 * bliebe der Fokus auf `body`, und die Wache `ziel.isConnected` haette jeden
 * weiteren Versuch abgewiesen. */
test('_fokussiere meldet, ob der Fokus wirklich angekommen ist', () => {
  const src = readFileSync(new URL('../public/components/modal.js', import.meta.url), 'utf8');
  const fok = src.match(/function _fokussiere\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(fok, '_fokussiere nicht gefunden');
  assert.match(fok, /return document\.activeElement === el;/,
    '`.focus()` meldet nichts - erst der Vergleich mit activeElement zeigt, ob es griff');
  const mit = src.match(/function _fokussiereMitRueckfall\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(mit, '_fokussiereMitRueckfall nicht gefunden');
  assert.match(mit, /PAGE_ROOT_ID/,
    'griff der Fokus nicht, muss auf die Seitenwurzel ausgewichen werden - sonst bleibt er auf body');
});

/* Ein Loader, der den Ausloeser sofort gegen ein Skelett tauscht und ihn erst
 * nach der Abfrage neu baut, laesst den Frame-Lauf auf der Wurzel landen. Ohne
 * die Ausnahme fuer den eigenen Rueckfall haetten `isConnected` und
 * `activeElement` danach jeden weiteren Versuch abgewiesen. */
test('ein Fokus auf der Seitenwurzel darf spaeter vom echten Ziel abgeloest werden', () => {
  const src = readFileSync(new URL('../public/components/modal.js', import.meta.url), 'utf8');
  const wachen = src.match(/function _tryRefocus\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(wachen, /const istRueckfall = ziel\.id === PAGE_ROOT_ID;/,
    'der eigene Rueckfall muss als solcher erkannt werden');
  assert.match(wachen, /document\.activeElement === document\.body \|\| document\.activeElement === ziel/,
    'liegt der Fokus auf dem Ziel selbst, gilt das als "noch niemand hat gewaehlt" - sonst bliebe '
    + 'er am Rueckfall haengen, obwohl der Knopf laengst wieder da ist');
});

/* Ein Knoten kann im Dokument haengen und trotzdem unbedienbar sein: der
 * Loesch-Weg der Aufgaben setzt die Zeile auf `display: none`, statt sie zu
 * entfernen. Der Fokus faellt dabei auf `body`, der Knoten bleibt verbunden -
 * eine Wache auf `isConnected` allein haette hier abgebrochen (Review zu #1070).
 */
test('ein verbundenes, aber unbedienbares Ziel beendet den Lauf nicht', () => {
  const src = readFileSync(new URL('../public/components/modal.js', import.meta.url), 'utf8');
  const wachen = src.match(/function _tryRefocus\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.doesNotMatch(wachen, /if \(ziel\.isConnected\)\s*return;/,
    'die Anwesenheit allein darf den Lauf nicht beenden - sie sagt nichts darueber, '
    + 'ob das Ziel den Fokus auch haelt');
  assert.match(wachen, /document\.activeElement === ziel/,
    'geprueft gehoert der Fokusbesitz');
});

/* REVIEW ZU #1070: nicht jedes data-Feld traegt Identitaet.
 *
 * Der Umbenennen-Knopf einer Teilaufgabe fuehrt `data-action` und `data-id` -
 * aber auch `data-title`, und genau das aendert sich beim Umbenennen. Ein
 * Vergleich auf Gleichheit ALLER Felder findet den neu gebauten Knopf danach
 * nie wieder und faellt auf die Wurzel zurueck: die Funktion waere in genau dem
 * Fall unwirksam, fuer den sie gebaut ist.
 */
test('ein geaendertes Nutzlast-Feld verhindert das Wiederfinden nicht', () => {
  const gemeinsam = { cls: 'subtask-item__action' };
  const alt = makeNode('button', { ...gemeinsam, data: { action: 'rename-subtask', id: '7', title: 'Alt' }, connected: false });
  const neu = makeNode('button', { ...gemeinsam, data: { action: 'rename-subtask', id: '7', title: 'Neu' } });
  const wurzel = makeNode('main', { id: 'main-content' });
  withDom({ byTag: { BUTTON: [neu] }, byId: { 'main-content': wurzel } }, () => {
    assert.equal(focusRestoreTarget(rememberFocus(alt)), neu,
      'die Identitaet steht in action und id - ein geaenderter Titel darf den Knopf nicht verstecken');
  });
});

/* Der zweite Anlauf besteht weiter auf Eindeutigkeit: zwei Teilaufgaben mit
 * derselben action, aber verschiedenen ids bleiben unterscheidbar, und wo die
 * identitaetstragenden Felder selbst mehrdeutig sind, wird nichts geraten. */
test('der zweite Anlauf raet nicht - Mehrdeutigkeit bleibt Mehrdeutigkeit', () => {
  const gemeinsam = { cls: 'subtask-item__action' };
  const alt = makeNode('button', { ...gemeinsam, data: { action: 'rename-subtask', title: 'Alt' }, connected: false });
  const a = makeNode('button', { ...gemeinsam, data: { action: 'rename-subtask', title: 'X' } });
  const b = makeNode('button', { ...gemeinsam, data: { action: 'rename-subtask', title: 'Y' } });
  const wurzel = makeNode('main', { id: 'main-content' });
  withDom({ byTag: { BUTTON: [a, b] }, byId: { 'main-content': wurzel } }, () => {
    assert.equal(focusRestoreTarget(rememberFocus(alt)), wurzel,
      'ohne unterscheidende id bleiben zwei Kandidaten - dann die Wurzel statt der falschen');
  });
});

/* DER MERKER GILT FUER SEINEN VORGANG, NICHT FUER EINEN AUFRUF.
 *
 * Ein Schliessvorgang kann mehrfach neu aufbauen - das Loeschen eines
 * Budget-Plans rendert sofort und noch einmal, wenn jemand den
 * Toast-Rueckgaengig drueckt. Beide Male ist derselbe Knopf gemeint. Ein
 * Merker, der beim ersten Gebrauch verfaellt, macht den zweiten Weg wirkungslos
 * (Review zu #1070, nachdem ein frueherer Anlauf genau das eingebaut hatte).
 *
 * Gegen den anderen Fehler - der Merker wirkt weiter, wo diese Schicht gar
 * nicht geschlossen hat - hilft nicht der Verbrauch, sondern das gezielte
 * Verwerfen: `closeDetailView()` kehrt im Popover-Zweig frueh zurueck und ruft
 * dafuer `forgetRestore()`.
 */
test('refocusAfterRender behaelt seinen Merker fuer weitere Neuaufbauten', () => {
  const src = readFileSync(new URL('../public/components/modal.js', import.meta.url), 'utf8');
  const fn = src.match(/export function refocusAfterRender\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(fn, 'refocusAfterRender nicht gefunden');
  assert.doesNotMatch(fn, /_lastRestore = null/,
    'der Merker darf beim Gebrauch NICHT verfallen - ein Vorgang kann mehrfach neu aufbauen, '
    + 'und der zweite Weg (Toast-Rueckgaengig) meint denselben Knopf');
  assert.match(src, /export function forgetRestore\(\)/,
    'zum Verwerfen braucht es einen eigenen Griff fuer alle, die an dieser Schicht vorbei schliessen');
});

/* Wer an modal.js vorbei schliesst, muss den Merker verwerfen - sonst wirkt er
 * dort weiter, wo diese Schicht nicht beteiligt war, und setzt den Fokus in
 * einen fremden Zusammenhang. */
test('closeDetailView verwirft den Merker, wenn es am Modal vorbei schliesst', () => {
  const src = readFileSync(new URL('../public/components/detail-view.js', import.meta.url), 'utf8');
  const fn = src.match(/export function closeDetailView\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(fn, 'closeDetailView nicht gefunden');
  assert.match(fn, /forgetRestore\(\)/,
    'der Popover-Zweig kehrt ohne closeModal() zurueck - ohne Verwerfen bliebe der Merker '
    + 'des vorigen Dialogs stehen');
});

/* DAS POPOVER GIBT DEN FOKUS UEBER DENSELBEN MERKER ZURUECK WIE EIN MODAL (#1083).
 *
 * Bis hierher verwarf `closeDetailView()` im Popover-Zweig nur den fremden
 * Merker. Der Fokus fiel mit dem entfernten Popover auf `body`, und ein
 * `refocusAfterRender()` nach dem Neuaufbau - etwa nach dem Zuruecksetzen eines
 * ICS-Termins, der das Raster neu zeichnet - hatte nichts, worauf es sich
 * beziehen konnte. Gemessen am ERGEBNIS, nicht an der Schreibweise.
 */
test('der Merker aus dem Popover traegt auch den Neuaufbau danach (#1083)', () => {
  const vorher = { active: global.document.activeElement, body: global.document.body };
  global.document.body = makeNode('body');
  const fokussierbar = (n) => { n.focus = () => { global.document.activeElement = n; }; return n; };
  const wurzel = fokussierbar(makeNode('main', { id: 'main-content' }));
  const anker = fokussierbar(makeNode('div', { cls: 'calendar-chip', data: { eventId: '7' } }));
  try {
    const merker = rememberFocus(anker);
    withDom({ byId: { 'main-content': wurzel } }, () => {
      global.document.activeElement = global.document.body;
      assert.equal(restoreFocusAfterClose(merker), anker,
        'haengt der Ausloeser noch, bekommt er den Fokus selbst');
      assert.equal(global.document.activeElement, anker);
    });

    // Die Seite zeichnet das Raster neu: der alte Chip ist weg, ein gleicher steht da.
    anker.isConnected = false;
    const neu = fokussierbar(makeNode('div', { cls: 'calendar-chip', data: { eventId: '7' } }));
    withDom({ byTag: { DIV: [neu] }, byId: { 'main-content': wurzel } }, () => {
      global.document.activeElement = global.document.body;
      refocusAfterRender();
      assert.equal(global.document.activeElement, neu,
        'ohne den Merker aus dem Popover bliebe der Fokus nach dem Neuaufbau auf body');
    });

    assert.equal(restoreFocusAfterClose(null), null, 'ohne Merker gibt es nichts zurueckzugeben');
  } finally {
    forgetRestore();
    global.document.activeElement = vorher.active;
    global.document.body = vorher.body;
  }
});

/* DER NEUAUFBAU OHNE SCHLIESSEN (#1083). Das Loeschen im Kalender rendert nach
 * dem Undo-Fenster erneut, ausserhalb jedes Handlers. Gemessen in der Agenda fiel
 * der Fokus dabei von der Zeile, auf die der Nutzer inzwischen gewechselt war,
 * auf BODY - und der Merker des Popovers zeigte auf die geloeschte Zeile. Hier
 * zaehlt, was DIREKT VOR dem Neuaufbau den Fokus hielt. Gemessen am Ergebnis. */
test('renderKeepingFocus traegt den Fokus ueber einen Neuaufbau ohne Schliessen (#1083)', () => {
  const vorher = { active: global.document.activeElement, body: global.document.body };
  global.document.body = makeNode('body');
  const fokussierbar = (n) => { n.focus = () => { global.document.activeElement = n; }; return n; };
  const wurzel = fokussierbar(makeNode('main', { id: 'main-content' }));
  const zeile = (id) => fokussierbar(makeNode('div', { cls: 'list-row', data: { id } }));
  // Der Neuaufbau haengt das fokussierte Element ab; der Fokus faellt auf body.
  const tauscheAus = (el) => () => { el.isConnected = false; global.document.activeElement = global.document.body; };
  try {
    const alt = zeile('15');
    const neu = zeile('15');
    global.document.activeElement = alt;
    withDom({ byTag: { DIV: [zeile('16'), neu] }, byId: { 'main-content': wurzel } }, () => {
      assert.equal(renderKeepingFocus(tauscheAus(alt)), neu,
        'die neu gebaute Zeile mit denselben data-Werten bekommt den Fokus, nicht die Nachbarzeile');
      assert.equal(global.document.activeElement, neu);
    });

    const ohneErsatz = zeile('9');
    global.document.activeElement = ohneErsatz;
    withDom({ byId: { 'main-content': wurzel } }, () => {
      renderKeepingFocus(tauscheAus(ohneErsatz));
      assert.equal(global.document.activeElement, wurzel, 'ohne Ersatz die Seitenwurzel, nie body');
    });

    const eigeneWahl = fokussierbar(makeNode('button', { id: 'cal-today' }));
    const weg = zeile('15');
    global.document.activeElement = weg;
    withDom({ byTag: { DIV: [neu] }, byId: { 'main-content': wurzel } }, () => {
      assert.equal(renderKeepingFocus(() => { weg.isConnected = false; eigeneWahl.focus(); }), null);
      assert.equal(global.document.activeElement, eigeneWahl,
        'hat der Neuaufbau selbst etwas fokussiert, ist dessen Wahl die bessere');
    });

    const bleibt = zeile('15');
    global.document.activeElement = bleibt;
    withDom({ byTag: { DIV: [neu] }, byId: { 'main-content': wurzel } }, () => {
      assert.equal(renderKeepingFocus(() => {}), null, 'haelt das Element den Fokus noch, gibt es nichts zu tun');
      assert.equal(global.document.activeElement, bleibt);
    });

    global.document.activeElement = global.document.body;
    withDom({ byTag: { DIV: [neu] }, byId: { 'main-content': wurzel } }, () => {
      assert.equal(renderKeepingFocus(() => {}), null, 'war vorher nichts fokussiert, wird nichts erfunden');
      assert.equal(global.document.activeElement, global.document.body);
    });
  } finally {
    global.document.activeElement = vorher.active;
    global.document.body = vorher.body;
  }
});

test('das Popover gibt den Fokus nur zurueck, wo niemand woanders hin wollte (#1083)', () => {
  const src = readFileSync(new URL('../public/components/detail-view.js', import.meta.url), 'utf8');
  const fn = src.match(/export function closeDetailView\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /if \(fokus && merker\) restoreFocusAfterClose\(merker\);\s*else forgetRestore\(\);/,
    'Rueckgabe mit eigenem Merker, sonst verwerfen - nie einen fremden stehen lassen');
  // Die Regel am Klick-daneben-Handler selbst, nicht an einer Zeile: seit er
  // den Klick schluckt (Re-Kritik 2026-09-28, E2), steht die Pruefung auf
  // "im Popover" als eigene Frueh-Rueckkehr davor - geschlossen wird danach
  // weiterhin ohne Fokus-Rueckgabe, und nirgends im Handler mit.
  const outside = src.match(/const onOutsideClick = \(e\) => \{[\s\S]*?\n {2}\};/)?.[0] ?? '';
  assert.ok(outside, 'der Klick-daneben-Handler des Popovers ist auffindbar');
  const schliesst = [...outside.matchAll(/closeDetailView\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.ok(schliesst.length > 0, 'ein Klick daneben schliesst das Popover');
  assert.deepEqual([...new Set(schliesst)], ['{ fokus: false }'],
    'ein Klick daneben wollte woanders hin - der Fokus springt nicht zurueck');
  assert.match(src, /if \(activePopover\) closeDetailView\(\{ fokus: false \}\)/,
    'eine neue Ansicht nimmt den Fokus selbst');
});

/* REVIEW ZU #1070: die Klasse ist Darstellung, keine Identitaet.
 *
 * Eine Mahlzeitenkarte traegt `meal-card__open--with-thumb`, sobald ihr Rezept
 * ein Bild hat. Wer beim Bearbeiten eines hinzufuegt, aendert damit die Klasse
 * des Knopfes, ueber den er gekommen ist - ein exakter Klassenvergleich findet
 * ihn danach nicht wieder. Derselbe Fehlertyp wie beim veraenderlichen
 * data-Feld, nur eine Ebene weiter.
 */
test('eine geaenderte Modifier-Klasse verhindert das Wiederfinden nicht', () => {
  // `data-meal-id`, wie das echte Markup es schreibt - NICHT `data-id`. Die
  // erste Fassung dieser Sonde erfand `{ action, id }` und prueste damit einen
  // Fall, den es nicht gibt; der Produktivknopf waere durchgefallen (Review zu
  // #1070). Das Repo fuehrt 24 solcher Schluesselfelder.
  const alt = makeNode('button', { cls: 'meal-card__open', data: { action: 'edit-meal', mealId: '9' }, connected: false });
  const neu = makeNode('button', { cls: 'meal-card__open meal-card__open--with-thumb', data: { action: 'edit-meal', mealId: '9' } });
  const wurzel = makeNode('main', { id: 'main-content' });
  withDom({ byTag: { BUTTON: [neu] }, byId: { 'main-content': wurzel } }, () => {
    assert.equal(focusRestoreTarget(rememberFocus(alt)), neu,
      'die Identitaet steht in action und id - eine Darstellungsklasse darf den Knopf nicht verstecken');
  });
});

/* Auch der dritte Anlauf raet nicht: zwei Karten mit derselben action, aber
 * verschiedenen ids bleiben unterscheidbar; ohne unterscheidende id bleibt es
 * bei der Wurzel. */
test('der Anlauf ohne Klasse besteht weiter auf Eindeutigkeit', () => {
  // Keiner der beiden traegt die Klasse des Ausloesers - erst der dritte Anlauf
  // sieht sie, und dort sind sie nicht zu unterscheiden.
  const alt = makeNode('button', { cls: 'meal-card__open', data: { action: 'edit-meal', mealId: '9' }, connected: false });
  const a = makeNode('button', { cls: 'meal-card__open--with-thumb', data: { action: 'edit-meal', mealId: '9' } });
  const b = makeNode('button', { cls: 'meal-card__open--compact', data: { action: 'edit-meal', mealId: '9' } });
  const wurzel = makeNode('main', { id: 'main-content' });
  withDom({ byTag: { BUTTON: [a, b] }, byId: { 'main-content': wurzel } }, () => {
    assert.equal(focusRestoreTarget(rememberFocus(alt)), wurzel,
      'ohne unterscheidende id bleiben zwei Kandidaten - dann die Wurzel statt der falschen');
  });
});

/* REVIEW ZU #1070: das Ergebnis des Nachfassens gehoert in den Merker zurueck.
 *
 * Weicht `_fokussiereMitRueckfall` auf die Wurzel aus, sitzt der Fokus dort -
 * der Merker zeigte aber weiter auf das alte, abgehaengte Element. Der naechste
 * Lauf urteilte damit ueber ein Ziel, das es nicht mehr gibt, und verlor den
 * frisch wieder aufgebauten Knopf.
 */
test('_tryRefocus schreibt das tatsaechlich gesetzte Ziel in den Merker zurueck', () => {
  const src = readFileSync(new URL('../public/components/modal.js', import.meta.url), 'utf8');
  const fn = src.match(/function _tryRefocus\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(fn, '_tryRefocus nicht gefunden');
  assert.match(fn, /const gesetzt = _fokussiereMitRueckfall\(ersatz\)/,
    'der Rueckgabewert traegt, WO der Fokus wirklich gelandet ist - er darf nicht verfallen');
  assert.match(fn, /_lastRestore\.ziel = gesetzt/,
    'ohne das Zurueckschreiben urteilt der naechste Lauf ueber ein Ziel, das es nicht mehr gibt');
});

// --------------------------------------------------------
// Sheet-Swipe (#981): eine Aufwaertsbewegung, bevor das Sheet gezogen wurde, ist
// Scrollen des Inhalts. Die Geste darf das Panel dann nicht anfassen - vorher
// schrieb sie bei jedem Aufwaerts-Frame `translateY(0)`, und ein frisch
// geoeffneter Dialog steht immer oben, also begann jede Wischgeste so.
//
// Seit der Re-Critique 2026-09-27 laeuft die Geste ueber den geteilten Helfer
// utils/sheet-drag.js (Dialog-Sheet UND Mehr-Blatt) und schreibt `translate`
// statt `transform`: die Einfahrt haelt `transform` per `forwards`, und eine
// gefuellte Animation schlaegt jedes Inline-`transform` - gemessen blieb die
// Tafel bei `style.transform = 'translateY(100px)'` stehen. Der Faktor 0.6 ist
// 1:1 gewichen (vorher `translateY(24px)` fuer 50px Weg, jetzt 40px).
// --------------------------------------------------------
const { __test: modalInternals } = await import('../public/components/modal.js');
const sheetDrag = await import('../public/utils/sheet-drag.js');

function fakeSheet({ wire = (panel) => modalInternals.wireSheetSwipe(panel), top = 100 } = {}) {
  const handlers = {};
  const writes = [];
  const attrs = {};
  let translate = '';
  let clock = 1000;
  const panel = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    removeEventListener: () => {},
    querySelector: () => ({ scrollTop: 0 }),
    getBoundingClientRect: () => ({ top }),
    setAttribute: (k, v) => { attrs[k] = v; },
    removeAttribute: (k) => { delete attrs[k]; },
    getAttribute: (k) => attrs[k] ?? null,
    style: {
      get translate() { return translate; },
      set translate(v) { writes.push(v); translate = v; },
    },
  };
  wire(panel);
  // Jede Probe 16ms nach der vorigen, ausser der Test gibt die Zeit vor.
  const at = (y, dt = 16) => {
    clock += dt;
    return { timeStamp: clock, touches: [{ clientY: y }], changedTouches: [{ clientY: y }] };
  };
  return {
    writes,
    attrs,
    get translate() { return translate; },
    start: (y) => handlers.touchstart(at(y, 0)),
    move: (y, dt) => handlers.touchmove(at(y, dt)),
    end: (y, dt) => handlers.touchend(at(y, dt)),
    cancel: (y, dt) => handlers.touchcancel(at(y, dt)),
    // Ein zweiter Finger setzt auf: touchstart meldet zwei Beruehrungen.
    secondFinger: (y) => { clock += 16; handlers.touchstart({ timeStamp: clock, touches: [{ clientY: y }, { clientY: y + 80 }], changedTouches: [{ clientY: y + 80 }] }); },
  };
}

test('Sheet-Swipe: aufwaerts im Inhalt schreibt nichts ans Panel (#981)', () => {
  const sheet = fakeSheet();
  sheet.start(600); // Inhalt steht oben, der Finger weit unter der Griffzone
  for (const y of [590, 560, 500, 420, 330]) sheet.move(y);
  sheet.end(330);
  assert.deepEqual(sheet.writes, [], 'kein Stil-Schreibzugriff, waehrend eine Aufwaertsgeste den Inhalt scrollt');
});

test('Sheet-Swipe: ein Zittern nach oben verwirft eine Schliessgeste nicht', () => {
  // Die erste Fassung der Sperre griff beim ersten Pixel nach oben: eine
  // gewollte Abwaertsgeste mit unruhigem Aufsetzen blieb danach tot. Nach oben
  // gilt dieselbe Schwelle wie nach unten.
  const sheet = fakeSheet();
  sheet.start(600);
  sheet.move(598);
  sheet.move(592); // 8px nach oben: innerhalb der Schwelle
  assert.deepEqual(sheet.writes, [], 'innerhalb der Schwelle kein Schreibzugriff');
  sheet.move(650);
  assert.equal(sheet.translate, '0px 40px', 'die Geste zieht das Sheet trotz des Zitterns - 1:1 ab der Schwelle');
});

test('Sheet-Swipe: 1:1 - der Versatz folgt dem Finger Pixel fuer Pixel', () => {
  const sheet = fakeSheet();
  sheet.start(600);
  sheet.move(620);
  assert.equal(sheet.translate, '0px 10px');
  sheet.move(655);
  assert.equal(sheet.translate, '0px 45px', 'kein Faktor 0.6 mehr');
  assert.equal(sheet.attrs['data-sheet-drag'], 'drag', 'waehrend des Zugs keine Transition (Marke fuer layout.css)');
});

test('Sheet-Swipe: ein begonnener Zug bleibt verfolgt; ueber dem Start gibt das Blatt nur als Gummiband nach', () => {
  global.requestAnimationFrame = (fn) => fn();
  try {
    const sheet = fakeSheet();
    sheet.start(600);
    sheet.move(650); // 50px nach unten: das Sheet folgt
    assert.equal(sheet.translate, '0px 40px');
    sheet.move(590); // der Finger kehrt ueber den Start zurueck
    const up = parseFloat(sheet.translate.split(' ')[1]);
    assert.ok(up < 0 && up > -10, `Gummiband: leicht nach oben, gedaempft (${sheet.translate})`);
    sheet.move(300); // 300px ueber dem Start
    const far = parseFloat(sheet.translate.split(' ')[1]);
    assert.ok(far < up && far > -24, `das Gummiband hat eine Grenze (${sheet.translate})`);
    sheet.move(640);
    sheet.end(640, 400); // 40px, langsam: kein Schliessen, zurueck in die Ruhelage
    assert.equal(sheet.translate, '', 'touchend raeumt den Zug ab');
    assert.equal(sheet.attrs['data-sheet-drag'], undefined, 'ohne Marke federt `translate` per Transition zurueck');
  } finally {
    delete global.requestAnimationFrame;
  }
});

test('Sheet-Drag: schliesst ab 80px Weg ODER bei einem Flick > 0.5px/ms, sonst federt es zurueck', () => {
  global.requestAnimationFrame = (fn) => fn();
  try {
    const run = (moves, endY, endDt) => {
      let dismissed = 0;
      const sheet = fakeSheet({ wire: (p) => sheetDrag.wireSheetDrag(p, { onDismiss: () => { dismissed += 1; } }) });
      sheet.start(600);
      for (const [y, dt] of moves) sheet.move(y, dt);
      sheet.end(endY, endDt);
      return { dismissed, translate: sheet.translate };
    };
    // 90px langsam gezogen (Tempo 0.1px/ms): der Weg reicht.
    assert.equal(run([[630, 300], [660, 300], [690, 300]], 690, 100).dismissed, 1);
    // 40px, aber schnell (40px in 32ms = 1.25px/ms): ein Flick schliesst.
    assert.equal(run([[620, 16], [640, 16]], 640, 1).dismissed, 1, 'kurzer Flick schliesst (vorher: sprang zurueck)');
    // 40px langsam: weder Weg noch Tempo - das Blatt federt zurueck.
    const slow = run([[620, 300], [640, 300]], 640, 300);
    assert.equal(slow.dismissed, 0);
    assert.equal(slow.translate, '');
    // Beim Schliessen bleibt der Zug stehen: der Ausgang startet am Finger.
    const kept = run([[700, 16]], 700, 16);
    assert.equal(kept.dismissed, 1);
    assert.equal(kept.translate, '0px 90px', 'der Ausgang startet dort, wo der Finger losliess');
  } finally {
    delete global.requestAnimationFrame;
  }
});

test('Sheet-Drag: bleibt das Blatt stehen (onDismiss -> false, Rueckfrage), federt es in die Ruhelage', () => {
  global.requestAnimationFrame = (fn) => fn();
  try {
    const sheet = fakeSheet({ wire: (p) => sheetDrag.wireSheetDrag(p, { onDismiss: () => false }) });
    sheet.start(600);
    sheet.move(720);
    sheet.end(720);
    assert.equal(sheet.translate, '');
  } finally {
    delete global.requestAnimationFrame;
  }
});

test('Sheet-Drag: touchcancel bricht die Geste ab - es schliesst nie, das Blatt federt zurueck', () => {
  // Ein abgebrochener Touch (Browser uebernimmt die Geste, Unterbrechung) ist
  // keine Absicht zu schliessen, auch wenn der letzte Stand wie ein Flick aussah.
  global.requestAnimationFrame = (fn) => fn();
  try {
    let dismissed = 0;
    const sheet = fakeSheet({ wire: (p) => sheetDrag.wireSheetDrag(p, { onDismiss: () => { dismissed += 1; } }) });
    sheet.start(600);
    sheet.move(650, 16);
    sheet.move(720, 16); // 120px schnell: als touchend waere das ein Schliessen
    sheet.cancel(720, 1);
    assert.equal(dismissed, 0, 'touchcancel darf onDismiss nie ausloesen');
    assert.equal(sheet.translate, '', 'der Zug wird zurueckgenommen');
    assert.equal(sheet.attrs['data-sheet-drag'], undefined, 'ohne Marke federt es per Transition zurueck');
  } finally {
    delete global.requestAnimationFrame;
  }
});

test('Sheet-Drag: ein zweiter Finger mitten im Zug laesst das Blatt nicht versetzt stehen', () => {
  global.requestAnimationFrame = (fn) => fn();
  try {
    let dismissed = 0;
    const sheet = fakeSheet({ wire: (p) => sheetDrag.wireSheetDrag(p, { onDismiss: () => { dismissed += 1; } }) });
    sheet.start(600);
    sheet.move(660);
    assert.equal(sheet.translate, '0px 50px');
    sheet.secondFinger(660);
    sheet.end(660);
    assert.equal(dismissed, 0);
    assert.equal(sheet.translate, '', 'der Versatz faellt zurueck, statt bei 50px zu kleben');
    assert.equal(sheet.attrs['data-sheet-drag'], undefined, 'die Zieh-Marke (keine Transition) bleibt nicht haengen');
  } finally {
    delete global.requestAnimationFrame;
  }
});

test('Sheet-Drag: Entscheidung und Tempo als reine Funktionen', () => {
  assert.equal(sheetDrag.shouldDismissSheet({ distance: 80, velocity: 0 }), true);
  assert.equal(sheetDrag.shouldDismissSheet({ distance: 79, velocity: 0.5 }), false, 'die Grenze ist "groesser als 0.5"');
  assert.equal(sheetDrag.shouldDismissSheet({ distance: 10, velocity: 0.51 }), true);
  // Tempo misst die letzten 100ms, nicht die ganze Geste: langer Anlauf, schneller Schluss.
  const v = sheetDrag.releaseVelocity([{ y: 0, t: 0 }, { y: 10, t: 900 }, { y: 40, t: 950 }, { y: 80, t: 1000 }]);
  assert.ok(Math.abs(v - 0.7) < 1e-9, `Tempo der letzten 100ms (${v})`);
  assert.equal(sheetDrag.rubberBand(10), 0);
  assert.ok(sheetDrag.rubberBand(-1000) > -24);
});

test('Sheet-Drag: ein Tipp schreibt nichts (Schwelle), auch nicht beim Loslassen', () => {
  const sheet = fakeSheet({ wire: (p) => sheetDrag.wireSheetDrag(p, { onDismiss: () => assert.fail('ein Tipp schliesst nicht') }) });
  sheet.start(600);
  sheet.move(605);
  sheet.end(605);
  assert.deepEqual(sheet.writes, []);
});

test('Sheet-Griff: sichtbar im hellen Theme, in der Kopfzone statt ueber einem leeren Streifen, gleich an Dialog und Mehr-Blatt (Re-Critique 2026-09-27, P1 #1)', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const layout = read('../public/styles/layout.css');
  const glass = read('../public/styles/glass.css');
  const tokens = read('../public/styles/tokens.css');
  const mobile = [...eachRule(layout)].filter((r) => r.at.some((a) => /max-width:\s*767px/.test(a)));
  const body = (rules, sel) => rules.find((r) => r.selector === sel)?.body ?? '';
  // Vorher: `--modal-handle-color: var(--glass-border)` fuer JEDES Theme -
  // Glas-Weiss 65 % auf weisser Tafel, gemessen unsichtbar.
  assert.ok(![...eachRule(glass)].some((r) => /--modal-handle-color|--sheet-grabber/.test(r.body)),
    'glass.css faerbt den Griff nicht mehr fuer jedes Theme um - das Glas-Weiss gehoert nur dem Dark (Token)');
  assert.match(tokens, /--_sheet-grabber:\s*var\(--color-border-strong\)/, 'hell: die kraeftigere neutrale Kante');
  assert.equal((tokens.match(/--_sheet-grabber:\s*var\(--glass-border\)/g) || []).length, 2, 'dunkel (Media + data-theme): Glas-Weiss');
  const grip = body(mobile, '.modal-panel::before');
  assert.match(grip, /background-color:\s*var\(--sheet-grabber\)/);
  assert.match(grip, /width:\s*36px/);
  assert.match(grip, /height:\s*5px/);
  // Der leere 36px-Streifen (`--space-4 + 20px`) ist weg; Griff-Oberkante bis
  // Titel-Oberkante 16px (8px + Kopfpolster 12px + Zentrierung neben dem X).
  assert.match(body(mobile, '.modal-panel'), /padding-top:\s*0/);
  assert.match(grip, /top:\s*var\(--space-2\)/);
  assert.match(body(mobile, '.modal-panel > .modal-panel__header'), /padding-top:\s*var\(--space-3\)/);
  // Das Mehr-Blatt traegt denselben Griff.
  const more = body([...eachRule(layout)], '.more-sheet__handle');
  assert.match(more, /background-color:\s*var\(--sheet-grabber\)/);
  assert.match(more, /height:\s*5px/);
});

test('Sheet-Grammatik: das Mehr-Blatt zieht ueber denselben Helfer wie der Dialog und federt per translate zurueck', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const router = read('../public/router.js');
  const layout = read('../public/styles/layout.css');
  assert.match(router, /wireSheetDrag\(sheet, \{[\s\S]{0,200}resetAfterDismiss: true/);
  assert.doesNotMatch(router, /clientY - _touchStartY > 60/, 'die alte Geste (erst bei touchend, ab 60px) ist weg');
  const more = [...eachRule(layout)].find((r) => r.selector === '.more-sheet' && !r.at.length)?.body ?? '';
  assert.match(more, /translate var\(--duration-lg\) var\(--ease-out\)/, 'Rueckfedern mit Token-Dauer und -Kurve');
  assert.match(more, /border-radius:\s*var\(--radius-lg\)/, 'Radius des Dialog-Sheets');
});

/* DER ERSTFOKUS NIMMT KEINEN SPAETER GESETZTEN FOKUS WEG (#1156).
 *
 * Gemessen im Browser mit gestrecktem 50-ms-Timer: das Speichern-Tor gab den
 * Fokus beim Fortsetzen korrekt auf den Speichern-Knopf zurueck, und 1,5 s spaeter
 * zog der liegengebliebene Erstfokus ihn ins erste Feld. Der Timer wird hier
 * abgefangen und von Hand ausgeloest; gemessen wird, wo der Fokus danach steht. */
function erstfokusLage({ inert = false } = {}) {
  const vorher = { active: global.document.activeElement, setTimeout: global.setTimeout, body: global.document.body };
  global.document.body = { id: 'BODY' };
  const geplant = [];
  global.setTimeout = (fn, ms) => { geplant.push({ fn, ms }); return geplant.length; };
  const imModal = new Set();
  const knoten = (id, drinnen, { popover = false } = {}) => {
    const n = {
      id,
      isConnected: true,
      closest: (sel) => (sel === '[popover]' && popover ? {} : null),
      focus() { global.document.activeElement = n; },
    };
    if (drinnen) imModal.add(n);
    return n;
  };
  const feld = knoten('first-field', true);
  const container = {
    querySelector: () => feld,
    contains: (el) => imModal.has(el),
    closest: (sel) => (sel === '[inert]' && inert ? {} : null),
  };
  return {
    geplant, feld, container, knoten,
    ausloesen: () => geplant.splice(0).forEach(({ fn }) => fn()),
    aufraeumen: () => {
      global.setTimeout = vorher.setTimeout;
      global.document.activeElement = vorher.active;
      global.document.body = vorher.body;
    },
  };
}

test('Erstfokus: ein Modal, in dem nichts den Fokus haelt, bekommt sein erstes Feld (#1156)', () => {
  const lage = erstfokusLage();
  try {
    global.document.activeElement = lage.knoten('ausloeser-draussen', false);
    modalTest.applyInitialFocus(lage.container, 'first-field');
    assert.deepEqual(lage.geplant.map(({ ms }) => ms), [50], 'der Erstfokus bleibt ein 50-ms-Timer');
    lage.ausloesen();
    assert.equal(global.document.activeElement, lage.feld, 'der Normalfall bleibt: Fokus ins erste Feld');
  } finally {
    lage.aufraeumen();
  }
});

test('Erstfokus: ein inzwischen im Modal gewaehlter Fokus bleibt stehen (#1156)', () => {
  const lage = erstfokusLage();
  try {
    global.document.activeElement = lage.knoten('ausloeser-draussen', false);
    modalTest.applyInitialFocus(lage.container, 'first-field');
    // Das Speichern-Tor hat fortgesetzt und den Fokus auf den Knopf gelegt.
    const speichern = lage.knoten('gate-save', true);
    speichern.focus();
    lage.ausloesen();
    assert.equal(global.document.activeElement, speichern,
      'ein liegengebliebener Timer darf den Fokus nicht ins erste Feld ziehen');
  } finally {
    lage.aufraeumen();
  }
});

test('Erstfokus: ein geparktes (inert) Modal und ein abgehaengtes Ziel bekommen keinen Fokus (#1156)', () => {
  const geparkt = erstfokusLage({ inert: true });
  try {
    const draussen = geparkt.knoten('dialog-knopf', false);
    global.document.activeElement = draussen;
    modalTest.applyInitialFocus(geparkt.container, 'first-field');
    geparkt.ausloesen();
    assert.equal(global.document.activeElement, draussen, 'unter einem Dialog geparkt: der Dialog behaelt den Fokus');
  } finally {
    geparkt.aufraeumen();
  }

  const weg = erstfokusLage();
  try {
    const draussen = weg.knoten('seite', false);
    global.document.activeElement = draussen;
    modalTest.applyInitialFocus(weg.container, 'first-field');
    weg.feld.isConnected = false;
    weg.ausloesen();
    assert.equal(global.document.activeElement, draussen, 'ein geschlossenes Modal fokussiert nichts mehr');
  } finally {
    weg.aufraeumen();
  }
});

test('Erstfokus: ein ausdrueckliches Ziel traegt dieselbe Wache, "none" plant nichts (#1156)', () => {
  const lage = erstfokusLage();
  try {
    const ziel = lage.knoten('confirm-modal-ok', true);
    global.document.activeElement = lage.knoten('ausloeser-draussen', false);
    modalTest.applyInitialFocus(lage.container, ziel);
    lage.ausloesen();
    assert.equal(global.document.activeElement, ziel, 'ein ausdrueckliches Ziel bekommt den Fokus wie bisher');

    modalTest.applyInitialFocus(lage.container, ziel);
    const gewaehlt = lage.knoten('confirm-modal-cancel', true);
    gewaehlt.focus();
    lage.ausloesen();
    assert.equal(global.document.activeElement, gewaehlt, 'und nimmt einen spaeter gewaehlten Fokus ebenso wenig weg');

    modalTest.applyInitialFocus(lage.container, 'none');
    assert.equal(lage.geplant.length, 0, 'bei "none" setzt der Aufrufer den Fokus selbst');
  } finally {
    lage.aufraeumen();
  }
});

/* Review zu #1193: der Datepicker oeffnet sein Popover unter document.body und
 * fokussiert synchron hinein - AUSSERHALB des Modal-Containers. Eine Wache, die
 * nur im Modal nachsieht, riss den Fokus aus dem offenen Kalender. */
test('Erstfokus: ein Fokus in einem Popover ausserhalb des Modals bleibt stehen (#1156)', () => {
  const lage = erstfokusLage();
  try {
    global.document.activeElement = lage.knoten('ausloeser-draussen', false);
    modalTest.applyInitialFocus(lage.container, 'first-field');
    const kalender = lage.knoten('ydp-popover-tag', false, { popover: true });
    kalender.focus();
    lage.ausloesen();
    assert.equal(global.document.activeElement, kalender,
      'das Datepicker-Popover haengt unter body - der Erstfokus darf es trotzdem nicht verdraengen');
  } finally {
    lage.aufraeumen();
  }
});

/* Zweite Runde der Review zu #1193: wer waehrend der Verzoegerung Tab drueckt,
 * landet auf der Seite DAHINTER (nicht inert, der Trap haengt nur am Panel). Galt
 * das als Wahl, kam der Fokus nie in den aria-modal-Dialog. */
test('Erstfokus: ein Seitenelement hinter dem Modal ist keine Wahl, das erste Feld kommt trotzdem (#1156)', () => {
  const lage = erstfokusLage();
  try {
    global.document.activeElement = lage.knoten('ausloeser-draussen', false);
    modalTest.applyInitialFocus(lage.container, 'first-field');
    lage.knoten('naechster-link-der-seite', false).focus();
    lage.ausloesen();
    assert.equal(global.document.activeElement, lage.feld,
      'ein Tab in die Seite dahinter darf den Einstieg in den Dialog nicht verhindern');
  } finally {
    lage.aufraeumen();
  }
});

test('Erstfokus: ein auf body gefallener Fokus ist keine Wahl, das erste Feld kommt trotzdem (#1156)', () => {
  const lage = erstfokusLage();
  try {
    global.document.activeElement = lage.knoten('listenzeile', false);
    modalTest.applyInitialFocus(lage.container, 'first-field');
    // Die Seite rendert die Liste neu, die Zeile ist weg, der Fokus faellt auf body.
    global.document.activeElement = global.document.body;
    lage.ausloesen();
    assert.equal(global.document.activeElement, lage.feld,
      'ohne diese Ausnahme bekaeme ein Modal ueber einer neu gerenderten Liste gar keinen Fokus');
  } finally {
    lage.aufraeumen();
  }
});

// --------------------------------------------------------
// Dialogfuss mit Loeschen mobil (Re-Critique 2026-09-27, R9 M8)
// --------------------------------------------------------

/**
 * Eine Attrappe, die genau so viel DOM kann, wie `decorateFooterDelete`
 * braucht: Klassen, data-Attribute, Kindknoten (Text und Elemente) und ein
 * Selektor-Matcher fuer die Formen, die dort vorkommen (`.klasse`, `[attr]`,
 * `tag`, `input[type="text"]`, `input:not([type])`, Kommalisten).
 */
function fussAttrappe() {
  const matches = (el, sel) => sel.split(',').map((s) => s.trim()).some((s) => {
    if (el.nodeType !== 1) return false;
    if (s === 'input:not([type])') return el.tagName === 'INPUT' && !('type' in el.attrs);
    const typed = s.match(/^(\w+)\[type="(\w+)"\]$/);
    if (typed) return el.tagName === typed[1].toUpperCase() && el.attrs.type === typed[2];
    if (s.startsWith('.')) return el.classes.has(s.slice(1));
    if (s.startsWith('[')) {
      const name = s.slice(1, -1);
      return name.startsWith('data-')
        ? el.dataset[name.slice(5).replace(/-(\w)/g, (_m, c) => c.toUpperCase())] !== undefined
        : name in el.attrs;
    }
    return el.tagName === s.toUpperCase();
  });
  const all = (root) => root.childNodes.flatMap((c) => (c.nodeType === 1 ? [c, ...all(c)] : []));
  const el = (tag, { cls = [], attrs = {}, data = {}, text = null, kids = [] } = {}) => {
    const node = {
      nodeType: 1, tagName: tag.toUpperCase(), attrs: { ...attrs }, dataset: { ...data },
      classes: new Set(cls), childNodes: [], parentElement: null, value: attrs.value ?? '', form: null,
      get classList() {
        const set = node.classes;
        return {
          add: (...c) => c.forEach((x) => set.add(x)),
          remove: (...c) => c.forEach((x) => set.delete(x)),
          contains: (c) => set.has(c),
          toggle: (c, on) => { if (on) set.add(c); else set.delete(c); },
        };
      },
      set className(v) { node.classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
      get className() { return [...node.classes].join(' '); },
      textContent: text ?? '',
      hasAttribute: (n) => n in node.attrs,
      getAttribute: (n) => node.attrs[n] ?? null,
      setAttribute: (n, v) => { node.attrs[n] = String(v); },
      appendChild(c) { c.parentElement = node; node.childNodes.push(c); return c; },
      prepend(c) { c.parentElement = node; node.childNodes.unshift(c); },
      querySelectorAll: (s) => all(node).filter((c) => matches(c, s)),
      querySelector: (s) => all(node).find((c) => matches(c, s)) ?? null,
      closest(s) { for (let x = node; x; x = x.parentElement) if (matches(x, s)) return x; return null; },
    };
    for (const k of kids) node.appendChild(k);
    return node;
  };
  const txt = (s) => {
    const node = { nodeType: 3, textContent: s, parentElement: null };
    node.remove = () => { const p = node.parentElement.childNodes; p.splice(p.indexOf(node), 1); };
    return node;
  };
  const withText = (node, ...texts) => { for (const s of texts) { const n = txt(s); n.parentElement = node; node.childNodes.push(n); } return node; };
  return { el, txt, withText };
}

test('M8: der Loeschen-Knopf im Fuss wird erkannt, bekommt Symbol, Wortspanne und Objektnamen', async () => {
  const { decorateFooterDelete } = await import('../public/components/modal.js');
  const { el, withText } = fussAttrappe();
  const savedWindow = globalThis.window;
  const savedCreate = global.document.createElement;
  globalThis.window = { lucide: { icons: { Trash2: [] }, createElement: () => el('svg', { attrs: { 'data-icon': 'trash-2' } }) } };
  global.document.createElement = (tag) => el(tag);
  try {
    const titel = el('input', { attrs: { type: 'text', value: 'Wocheneinkauf' } });
    const del = withText(el('button', { cls: ['btn', 'btn--danger-ghost'] }), '\n  ', 'Loeschen', '\n');
    const cancel = withText(el('button', { cls: ['btn', 'btn--secondary'] }), 'Abbrechen');
    const save = withText(el('button', { cls: ['btn', 'btn--primary'] }), 'Speichern');
    const footer = el('div', { cls: ['modal-panel__footer'], kids: [del, cancel, save] });
    const form = el('form', { kids: [titel] });
    for (const b of [del, cancel, save]) b.form = form;
    el('div', { cls: ['modal-panel'], kids: [el('div', { cls: ['modal-panel__body'], kids: [form] }), footer] });

    const found = decorateFooterDelete(footer);
    assert.deepEqual(found, [del], 'genau der Gefahrenknopf ist Loeschen');
    assert.ok(del.classList.contains('modal-panel__delete'));
    assert.ok(footer.classList.contains('modal-panel__footer--has-delete'));
    assert.ok(footer.classList.contains('modal-panel__footer--one-row'), 'Dreiheit Loeschen/Abbrechen/Primaer steht in einer Zeile');
    const label = del.childNodes.find((n) => n.nodeType === 1 && n.classList.contains('modal-panel__delete-label'));
    assert.equal(label?.textContent, 'Loeschen', 'das Wort steht in einer eigenen Spanne, die das CSS mobil ausblendet');
    assert.equal(del.childNodes[0].tagName, 'SVG', 'fehlendes Papierkorb-Symbol kommt dazu');
    assert.match(del.getAttribute('aria-label'), /common\.deleteNamed.*Wocheneinkauf/, 'Objektname aus dem ersten Textfeld');

    decorateFooterDelete(footer);
    assert.equal(del.childNodes.filter((n) => n.nodeType === 1 && n.classList.contains('modal-panel__delete-label')).length, 1, 'idempotent');
    assert.equal(del.childNodes.filter((n) => n.tagName === 'SVG').length, 1, 'kein zweites Symbol');
  } finally {
    globalThis.window = savedWindow;
    global.document.createElement = savedCreate;
  }
});

test('M8: data-delete-name und ein vorhandenes aria-label gewinnen; off und die Detailansicht mit drei Aktionen bleiben beim Umbruch', async () => {
  const { decorateFooterDelete } = await import('../public/components/modal.js');
  const { el, withText } = fussAttrappe();
  const savedCreate = global.document.createElement;
  const savedWindow = globalThis.window;
  global.document.createElement = (tag) => el(tag);
  globalThis.window = {};
  try {
    const named = withText(el('button', { cls: ['btn', 'btn--danger-outline'], data: { deleteName: 'Blutdruck 12.09.' } }), 'Loeschen');
    const f1 = el('div', { cls: ['modal-panel__footer'], kids: [named, withText(el('button', { cls: ['btn'] }), 'Abbrechen')] });
    decorateFooterDelete(f1);
    assert.match(named.getAttribute('aria-label'), /Blutdruck 12\.09\./);

    const labelled = withText(el('button', { cls: ['btn', 'btn--danger-outline'], attrs: { 'aria-label': 'Eintrag „Miete" loeschen' } }), 'Loeschen');
    decorateFooterDelete(el('div', { cls: ['modal-panel__footer'], kids: [labelled] }));
    assert.equal(labelled.getAttribute('aria-label'), 'Eintrag „Miete" loeschen', 'ein vorhandenes aria-label wird nie ueberschrieben');

    const primary = withText(el('button', { cls: ['btn', 'btn--danger-outline'], data: { footerDelete: 'off' } }), 'Liste leeren');
    const f3 = el('div', { cls: ['modal-panel__footer'], kids: [primary] });
    assert.deepEqual(decorateFooterDelete(f3), [], 'off nimmt den Knopf heraus');
    assert.equal(f3.classList.contains('modal-panel__footer--has-delete'), false);

    const detail = el('div', { cls: ['modal-panel__footer'], kids: [
      withText(el('button', { cls: ['btn', 'btn--danger-ghost'] }), 'Loeschen'),
      withText(el('button', { cls: ['btn', 'btn--secondary'] }), 'Erledigen'),
      withText(el('button', { cls: ['btn', 'btn--ghost'] }), 'Starten'),
      withText(el('button', { cls: ['btn', 'btn--ghost'] }), 'Aufgabe archivieren'),
    ] });
    const detailTitle = el('h2', { cls: ['modal-panel__title'], text: 'Kinderzimmer aufraeumen' });
    detail.classList.add('detail-view__footer');
    el('div', { cls: ['modal-panel'], kids: [el('div', { cls: ['modal-panel__header'], kids: [detailTitle] }), detail] });
    decorateFooterDelete(detail);
    assert.ok(detail.classList.contains('modal-panel__footer--has-delete'), 'der Papierkorb gilt auch hier');
    assert.match(detail.childNodes[0].getAttribute('aria-label') ?? '', /Kinderzimmer aufraeumen/,
      'in der Detailansicht ist der Dialogtitel der Objektname');
    assert.equal(detail.classList.contains('modal-panel__footer--one-row'), false,
      'drei beschriftete Aktionen neben Loeschen quetschen sich in einer Zeile auf ~80px - dort bleibt der Umbruch');

    const konto = el('div', { cls: ['modal-panel__footer'], kids: [
      el('div', { kids: [withText(el('button', { cls: ['btn', 'btn--danger-outline'] }), 'Loeschen'), el('button', { cls: ['btn', 'btn--secondary', 'btn--icon'] })] }),
      el('div', { kids: [withText(el('button', { cls: ['btn'] }), 'Abbrechen'), withText(el('button', { cls: ['btn', 'btn--primary'] }), 'Speichern')] }),
    ] });
    decorateFooterDelete(konto);
    assert.ok(konto.classList.contains('modal-panel__footer--one-row'), 'ein Icon-Knopf daneben zaehlt nicht als beschriftete Aktion');
  } finally {
    global.document.createElement = savedCreate;
    globalThis.window = savedWindow;
  }
});

test('M8: mountFooter dekoriert die gehobene Fusszeile', () => {
  const src = readFileSync(new URL('../public/components/modal.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export function mountFooter'), src.indexOf('export const FOOTER_DELETE_SELECTOR'));
  assert.match(fn, /panel\.appendChild\(bodyFooter\);\s*decorateFooterDelete\(bodyFooter\);/,
    'ohne den Aufruf bleibt jede Regel unten wirkungslos - der Fuss traegt nie die Klassen');
});

test('M8: mobil ist Loeschen ein Icon-Knopf der Zielgroesse, das Wort nur fuer den Screenreader, die Dreiheit bricht nicht um', () => {
  const css = readFileSync(new URL('../public/styles/layout.css', import.meta.url), 'utf8');
  const mobile = [...eachRule(css)].filter((r) => r.at.some((a) => /max-width:\s*639px/.test(a)));
  const rule = (sel) => mobile.find((r) => r.selector.split(',').map((s) => s.trim()).includes(sel))?.body ?? '';
  const btn = rule('.modal-panel__footer .btn.modal-panel__delete');
  assert.match(btn, /width:\s*var\(--target-base\)/, 'Treffflaeche der Geraeteklasse (44 Zeiger / 48 Finger)');
  assert.match(btn, /min-width:\s*var\(--target-base\)/);
  assert.match(btn, /padding:\s*0/);
  const label = rule('.modal-panel__footer .modal-panel__delete .modal-panel__delete-label');
  assert.match(label, /position:\s*absolute/, 'das Wort verlaesst das Bild ...');
  assert.match(label, /clip:\s*rect\(0,\s*0,\s*0,\s*0\)/, '... aber nicht den Baum (sr-only, nicht display:none)');
  assert.doesNotMatch(label, /display:\s*none/);
  const row = rule('.modal-panel__footer.modal-panel__footer--one-row');
  assert.match(row, /flex-wrap:\s*nowrap/, 'Speichern steht nie allein in Zeile 2');
  assert.match(rule('.modal-panel__footer.modal-panel__footer--one-row .btn:not(.modal-panel__delete):not(.btn--icon)'),
    /overflow-wrap:\s*anywhere/, 'eine lange Beschriftung bricht innen statt den Fuss nach links hinauszuschieben (#872)');
});

/*
 * F3 (Re-Critique 2026-09-28, A5 P2-4): IN JEDEM FUSS PASST LOESCHEN IN SEINEN
 * KNOPF. Die Detailansicht (components/detail-view.js) baut ihre Knoepfe mit
 * Symbol und einer `.btn__label`-Spanne, nicht mit losem Text. decorateFooterDelete
 * packte nur losen Text in `.modal-panel__delete-label`; das Wort blieb sichtbar
 * und ragte bei 390px aus dem 48px-Quadrat (Kontakt-Detail: Inhalt 72px, der
 * Papierkorb 5px vom Blattrand). Die Regel, die jeder Fuss erfuellen muss: kein
 * sichtbares Wort im Loeschen-Knopf ausserhalb der ausgeblendeten Spanne.
 */
function visibleWordsOutsideLabel(btn) {
  const out = [];
  const walk = (node, hidden) => {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { if (!hidden && c.textContent.trim()) out.push(c.textContent.trim()); continue; }
      if (c.tagName === 'SVG' || c.tagName === 'I') continue;
      const inLabel = hidden || c.classList.contains('modal-panel__delete-label');
      if (!inLabel && !c.childNodes.length && c.textContent.trim()) out.push(c.textContent.trim());
      walk(c, inLabel);
    }
  };
  walk(btn, false);
  return out;
}

test('F3: in jedem Fuss liegt das Wort des Loeschen-Knopfs in der ausgeblendeten Spanne - auch mit .btn__label', async () => {
  const { decorateFooterDelete } = await import('../public/components/modal.js');
  const { el, withText } = fussAttrappe();
  const savedCreate = global.document.createElement;
  const savedWindow = globalThis.window;
  global.document.createElement = (tag) => el(tag);
  globalThis.window = {};
  try {
    const cases = {
      // Die Form aus detail-view.js: Symbol + .btn__label.
      detailansicht: () => el('button', { cls: ['btn', 'btn--danger-ghost'], kids: [
        el('i', { data: { lucide: 'trash-2' } }),
        el('span', { cls: ['btn__label'], text: 'Loeschen' }),
      ] }),
      // Die Form der Formular-Dialoge: loser Text.
      formular: () => withText(el('button', { cls: ['btn', 'btn--danger-outline'] }), 'Loeschen'),
      // Symbol und loser Text gemischt.
      gemischt: () => withText(el('button', { cls: ['btn', 'btn--danger-outline'], kids: [el('i', { data: { lucide: 'trash-2' } })] }), 'Loeschen'),
    };
    for (const [name, make] of Object.entries(cases)) {
      const del = make();
      const footer = el('div', { cls: ['modal-panel__footer', 'detail-view__footer'], kids: [del, withText(el('button', { cls: ['btn', 'btn--primary'] }), 'Bearbeiten')] });
      el('div', { cls: ['modal-panel'], kids: [el('h2', { cls: ['modal-panel__title'], text: 'Dr. Anna Weber' }), footer] });
      decorateFooterDelete(footer);
      assert.ok(del.classList.contains('modal-panel__delete'), `${name}: nicht erkannt`);
      assert.deepEqual(visibleWordsOutsideLabel(del), [],
        `${name}: das Wort bleibt sichtbar und sprengt mobil das 48px-Quadrat`);
      const labels = del.querySelectorAll('.modal-panel__delete-label');
      assert.equal(labels.length, 1, `${name}: genau eine Wortspanne`);
      assert.equal(labels[0].textContent, 'Loeschen', `${name}: das Wort bleibt fuer den Screenreader im Baum`);
      decorateFooterDelete(footer);
      assert.equal(del.querySelectorAll('.modal-panel__delete-label').length, 1, `${name}: idempotent`);
    }
  } finally {
    global.document.createElement = savedCreate;
    globalThis.window = savedWindow;
  }
});

/*
 * LOESCHEN STEHT IM DIALOGFUSS AM ANFANG (Re-Critique 2026-09-28, A2 P1-2).
 * Der Termindialog - das Vorbild des Kanons - stellte "Loeschen" 12px neben
 * "Abbrechen" an den rechten Rand, weil der Fuss rechtsbuendig ist und nur
 * wer den Knopf selbst wegschob (`style="margin-inline-end:auto"`, zwanzig
 * Module), ihn links hatte. Die Zusage gilt fuer JEDEN Fuss mit Loeschen:
 * (1) EINE Regel in layout.css schiebt den erkannten Knopf (und seine Gruppe)
 * an den Anfang, (2) in jedem Fuss-Markup ist Loeschen der erste Knopf -
 * sonst schoebe die Regel Abbrechen mit nach links.
 */
function footerChunks(source) {
  const chunks = [];
  for (const m of source.matchAll(/<div class="modal-panel__footer[^"]*"[^>]*>/g)) {
    let depth = 0;
    let end = source.length;
    const tokens = /<div\b|<\/div>/g;
    tokens.lastIndex = m.index;
    for (let t = tokens.exec(source); t; t = tokens.exec(source)) {
      depth += t[0] === '</div>' ? -1 : 1;
      if (depth === 0) { end = t.index; break; }
    }
    chunks.push(source.slice(m.index, end));
  }
  return chunks;
}

const DELETE_BUTTON = /class="[^"]*\bbtn--danger-(?:outline|ghost)\b|data-footer-delete(?!="off")/;

test('A2 P1-2: in jedem Dialogfuss steht Loeschen am Anfang, Abbrechen und Primaer am Ende', async () => {
  const { readdirSync, statSync } = await import('node:fs');
  const { join, relative } = await import('node:path');
  const root = new URL('..', import.meta.url).pathname;
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'vendor' || name === 'locales') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.js')) files.push(path);
    }
  };
  walk(join(root, 'public'));

  const rules = [...eachRule(layoutCss)].filter((r) => !r.at.length && /margin-inline-end:\s*auto/.test(r.body));
  const selectors = rules.flatMap((r) => r.selector.split(',').map((s) => s.trim().replace(/\s+/g, ' ')));
  const globalRule = selectors.includes('.modal-panel__footer > .modal-panel__delete')
    && selectors.includes('.modal-panel__footer > :has(> .modal-panel__delete)');

  let seen = 0;
  const notFirst = [];
  const notStart = [];
  for (const path of files) {
    const file = relative(root, path);
    for (const chunk of footerChunks(readFileSync(path, 'utf8'))) {
      const buttons = [...chunk.matchAll(/<button\b[^>]*>/g)].map((b) => b[0]);
      const del = buttons.findIndex((b) => DELETE_BUTTON.test(b));
      if (del < 0) continue;
      seen += 1;
      if (del !== 0) notFirst.push(file);
      const own = /margin-inline-end:\s*auto/.test(buttons[del])
        || /<div[^>]*margin-inline-end:\s*auto[^>]*>\s*(?:\$\{[^`]*`)?\s*<button[^>]*btn--danger/.test(chunk);
      if (!globalRule && !own) notStart.push(file);
    }
  }
  assert.ok(seen >= 15, `nur ${seen} Fuesse mit Loeschen gefunden - der Guard waere blind`);
  assert.deepEqual(notFirst, [], 'Loeschen ist nicht der erste Knopf im Fuss - die Regel schoebe Abbrechen mit nach links');
  assert.deepEqual(notStart, [], 'hier steht Loeschen neben Abbrechen am Ende statt am Anfang');
  assert.ok(globalRule, 'die eine Regel in layout.css fehlt - jeder neue Fuss muesste wieder selbst schieben');
});
