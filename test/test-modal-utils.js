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
  restoreFocusAfterClose, refocusAfterRender, forgetRestore,
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

test('das Popover gibt den Fokus nur zurueck, wo niemand woanders hin wollte (#1083)', () => {
  const src = readFileSync(new URL('../public/components/detail-view.js', import.meta.url), 'utf8');
  const fn = src.match(/export function closeDetailView\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /if \(fokus && merker\) restoreFocusAfterClose\(merker\);\s*else forgetRestore\(\);/,
    'Rueckgabe mit eigenem Merker, sonst verwerfen - nie einen fremden stehen lassen');
  assert.match(src, /!popover\.contains\(e\.target\)\) closeDetailView\(\{ fokus: false \}\)/,
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
// --------------------------------------------------------
const { __test: modalInternals } = await import('../public/components/modal.js');

function fakeSheet() {
  const handlers = {};
  const writes = [];
  let transform = '';
  const panel = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    querySelector: () => ({ scrollTop: 0 }),
    getBoundingClientRect: () => ({ top: 100 }),
    style: {
      get transform() { return transform; },
      set transform(v) { writes.push(v); transform = v; },
    },
  };
  modalInternals.wireSheetSwipe(panel);
  const at = (y) => ({ touches: [{ clientY: y }], changedTouches: [{ clientY: y }] });
  return {
    writes,
    get transform() { return transform; },
    start: (y) => handlers.touchstart(at(y)),
    move: (y) => handlers.touchmove(at(y)),
    end: (y) => handlers.touchend(at(y)),
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
  assert.equal(sheet.transform, 'translateY(24px)', 'die Geste zieht das Sheet trotz des Zitterns');
});

test('Sheet-Swipe: ein begonnener Zug bleibt verfolgt und setzt das Panel einmal zurueck', () => {
  global.requestAnimationFrame = (fn) => fn();
  try {
    const sheet = fakeSheet();
    sheet.start(600);
    sheet.move(650); // 50px nach unten: das Sheet folgt
    assert.equal(sheet.transform, 'translateY(24px)');
    sheet.move(590); // der Finger kehrt ueber den Start zurueck
    assert.equal(sheet.transform, '', 'zurueckgesetzt, sobald der Finger ueber dem Start steht (b7c0312c)');
    const writesAfterReset = sheet.writes.length;
    sheet.move(570);
    sheet.move(550);
    assert.equal(sheet.writes.length, writesAfterReset, 'zurueckgesetzt wird einmal, nicht in jedem Frame');
    sheet.move(640);
    sheet.end(640); // 40px: kein Schliessen, zurueck in die Ruhelage
    assert.equal(sheet.transform, '', 'touchend raeumt den Zug ab');
  } finally {
    delete global.requestAnimationFrame;
  }
});
