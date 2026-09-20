/**
 * Tests: Totzeit gegen den Doppeltipp (#1284)
 * Modul: /public/components/modal.js  (armPointerDeadTime + openModal)
 *
 * WAS HIER GEMESSEN WIRD - UND WARUM NICHT DIE KONSTANTE
 *
 * Die Totzeit ist eine ZEIT, kein Text. Ein Guard, der `350` im Quelltext
 * sucht, bliebe gruen, wenn der Handler nie angehaengt wird, wenn er die
 * Ereignisse nicht mehr trifft oder wenn `openModal` ihn hinter dem
 * Overlay-Schliesser registriert - toter Code besteht jede Textsuche. Die
 * Sonden hier stellen deshalb die Uhr vor und fahren dieselbe Betaetigung
 * einmal INNERHALB und einmal AUSSERHALB des Fensters. Beide Richtungen
 * zaehlen: ein Test, der nur das Schlucken belegt, waere auch gruen, wenn der
 * Dialog danach dauerhaft taub bliebe.
 *
 * DIE ZWEITE HAELFTE IST DIE TASTATUR. Eine Totzeit, die `Enter`/`Space` oder
 * Escape mitnimmt, waere kein Schutz, sondern ein Rueckschritt in der
 * Bedienbarkeit - und im Quelltext nicht zu sehen, weil der Browser einen per
 * Tastatur ausgeloesten Klick als denselben `click` schickt. Er unterscheidet
 * sich nur in `pointerType` (leer) und `detail` (0), und genau daran haengt
 * die Sperre.
 *
 * DAS DOM DARUNTER ist der kleinstmoegliche Stub in der Bauart von
 * test-popover-menu.js: er hebt Listener samt Capture-Flag auf und stellt
 * Ereignisse in der Reihenfolge zu, die der Browser zusichert - Capture auf
 * der Wurzel, dann das Ziel, dann Bubble. Nur so faellt auf, wenn die Totzeit
 * ZU SPAET registriert wird: ein Klick auf das Overlay selbst landet im
 * AT_TARGET-Fall, und dort entscheidet die Registrierungsreihenfolge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// --------------------------------------------------------
// Uhr: modal.js liest performance.now(), also steht sie hier.
// --------------------------------------------------------
let clock = 0;
globalThis.performance = { now: () => clock };
const at = (ms) => { clock = ms; };

// --------------------------------------------------------
// Mini-DOM
// --------------------------------------------------------

/** Knoten, der seine Listener samt Capture-Flag aufhebt. */
function makeNode(name) {
  const listeners = [];
  const node = {
    name,
    id: '',
    isConnected: true,
    inert: false,
    style: {},
    dataset: {},
    children: [],
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    addEventListener(type, handler, options) {
      listeners.push({ type, handler, capture: options === true || options?.capture === true });
    },
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
    contains() { return false; },
    appendChild() {},
    focus() {},
    remove() { node.isConnected = false; },
    _listeners: listeners,
    /** Nur die Typen, auf die ueberhaupt gehoert wird. */
    _types() { return [...new Set(listeners.map((l) => l.type))]; },
  };
  return node;
}

/** Ereignis, wie der Code es anfasst: preventDefault/stopImmediatePropagation. */
function makeEvent(type, props = {}) {
  return {
    type,
    defaultPrevented: false,
    _stopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
    stopImmediatePropagation() { this._stopped = true; },
    ...props,
  };
}

/**
 * Zustellung wie im Browser: Capture auf der Wurzel, dann das Ziel, dann
 * Bubble auf der Wurzel. Ist die Wurzel selbst das Ziel (AT_TARGET), laufen
 * ihre Listener in REGISTRIERUNGSREIHENFOLGE - unabhaengig vom Capture-Flag.
 */
function dispatch(root, target, event) {
  const run = (entries) => {
    for (const l of entries) {
      if (event._stopped) return;
      if (l.type === event.type) l.handler(event);
    }
  };
  if (target === root) {
    run([...root._listeners]);
    return event;
  }
  run([...root._listeners].filter((l) => l.capture));
  run([...target._listeners]);
  run([...root._listeners].filter((l) => !l.capture));
  return event;
}

/** Ein Zeigerklick, wie Chrome ihn fuer Maus und Finger schickt. */
const pointerClick = (target, pointerType = 'mouse') => makeEvent('click', { target, pointerType, detail: 1 });
/** Ein per Tastatur ausgeloester Klick: leere Zeigerart, detail 0. */
const keyboardClick = (target) => makeEvent('click', { target, pointerType: '', detail: 0 });

const { armPointerDeadTime, openModal, closeModal } = await import('../public/components/modal.js');

// --------------------------------------------------------
// 1) Die Sperre selbst - mit eigener Uhr, ohne openModal
// --------------------------------------------------------

function armed({ duration } = {}) {
  let hand = 0;
  const root = makeNode('.modal-overlay');
  const button = makeNode('button');
  let hits = 0;
  button.addEventListener('click', () => { hits += 1; });
  armPointerDeadTime(root, { now: () => hand, ...(duration === undefined ? {} : { duration }) });
  return {
    root,
    button,
    tick(ms) { hand = ms; },
    click(event) { dispatch(root, button, event); return hits; },
    get hits() { return hits; },
  };
}

test('der Zeigerklick im Fenster kommt nicht an, der danach schon', () => {
  const dialog = armed();

  dialog.tick(50);
  dialog.click(pointerClick(dialog.button));
  assert.equal(dialog.hits, 0, 'ein Klick 50 ms nach dem Oeffnen hat den Knopf erreicht');

  dialog.tick(500);
  dialog.click(pointerClick(dialog.button));
  assert.equal(dialog.hits, 1, 'ein Klick 500 ms nach dem Oeffnen kam NICHT an - die Sperre bleibt haengen');
});

test('das Fenster endet bei 350 ms, nicht irgendwann', () => {
  // Die Grenze gehoert gemessen, nicht angenommen: ein `>` statt `>=` waere im
  // Quelltext unsichtbar und in der Bedienung eine halbe Sekunde taub.
  const kurzDavor = armed();
  kurzDavor.tick(349);
  kurzDavor.click(pointerClick(kurzDavor.button));
  assert.equal(kurzDavor.hits, 0, '349 ms galten schon als abgelaufen');

  const genau = armed();
  genau.tick(350);
  genau.click(pointerClick(genau.button));
  assert.equal(genau.hits, 1, '350 ms sind noch gesperrt - das Fenster ist laenger als angegeben');
});

test('ein Klick aus der Tastatur laeuft durch die Totzeit hindurch', () => {
  // `Enter`/`Space` auf einem Knopf kommen in Chrome als PointerEvent mit
  // leerer Zeigerart und detail 0 - genauso die Betaetigung durch einen
  // Screenreader und `element.click()`. Wer so bedient, hat nie danebengetippt.
  const dialog = armed();
  dialog.tick(10);
  dialog.click(keyboardClick(dialog.button));
  assert.equal(dialog.hits, 1, 'die Totzeit hat die Tastatur mitgenommen');
});

test('der Tipp zaehlt als Zeiger, auch ohne detail', () => {
  const finger = armed();
  finger.tick(60);
  finger.click(makeEvent('click', { target: finger.button, pointerType: 'touch', detail: 0 }));
  assert.equal(finger.hits, 0, 'ein Tipp mit pointerType "touch" ging durch');

  // Und umgekehrt: ein aelterer MouseEvent ohne pointerType traegt detail >= 1.
  const maus = armed();
  maus.tick(60);
  maus.click(makeEvent('click', { target: maus.button, detail: 1 }));
  assert.equal(maus.hits, 0, 'ein MouseEvent ohne pointerType ging durch');
});

test('die Sperre haengt nur an den Zeiger-Ereignissen', () => {
  // Die Touch-Ereignisse tragen das Scrollen des Inhalts und die Wischgeste des
  // Sheets. Wer sie abfaengt, schneidet eine laufende Geste mittendrin ab -
  // und `keydown` ist der Escape-Weg aus dem Dialog.
  const dialog = armed();
  const typen = dialog.root._types();
  assert.deepEqual(
    [...typen].sort(),
    ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'],
    'die Totzeit hoert auf andere Ereignisse als die fuenf Zeiger-Betaetigungen',
  );
  for (const l of dialog.root._listeners) {
    assert.equal(l.capture, true, `${l.type} haengt nicht in der Capture-Phase`);
  }
});

// --------------------------------------------------------
// 2) Der Aufrufer - openModal haengt sie WIRKLICH an
// --------------------------------------------------------

const overlays = [];
let panelOf = new WeakMap();

function installDocument() {
  overlays.length = 0;
  panelOf = new WeakMap();
  const body = makeNode('body');
  body.insertAdjacentHTML = () => {
    // Statt HTML zu parsen: der Knoten, den `getElementById` gleich liefert.
    const panel = makeNode('.modal-panel');
    const overlay = makeNode('.modal-overlay');
    overlay.id = 'shared-modal-overlay';
    overlay.querySelector = (selector) => (selector === '.modal-panel' ? panel : null);
    overlay.remove = () => {
      overlay.isConnected = false;
      const i = overlays.indexOf(overlay);
      if (i !== -1) overlays.splice(i, 1);
    };
    panelOf.set(overlay, panel);
    overlays.push(overlay);
  };
  const docListeners = [];
  globalThis.document = {
    body,
    activeElement: null,
    addEventListener(type, handler) { docListeners.push({ type, handler }); },
    removeEventListener(type, handler) {
      const i = docListeners.findIndex((l) => l.type === type && l.handler === handler);
      if (i !== -1) docListeners.splice(i, 1);
    },
    getElementById: (id) => overlays.find((o) => o.id === id) ?? null,
    querySelector: (selector) => (selector === '.modal-overlay' ? overlays.at(-1) ?? null : null),
    querySelectorAll: () => [],
    // Wie im Browser: ein Listener, der die Ausbreitung stoppt, beendet die
    // Zustellung. Ohne das saehe eine Totzeit, die am `document` haengt, hier
    // wirkungslos aus - und die Escape-Sonde belegte nichts.
    _fire(type, event) {
      for (const l of [...docListeners]) {
        if (event._stopped) return;
        if (l.type === type) l.handler(event);
      }
    },
  };
  globalThis.window = { innerWidth: 1024 };
  // Der delegierte Schliesser prueft `e.target instanceof Element`; ohne den
  // Typ bricht er mit einem ReferenceError, statt den Klick zu bewerten.
  globalThis.Element = class Element {};
  globalThis.history = { state: null, pushState() {}, back() {}, forward() {} };
  globalThis.location = { href: 'http://localhost/' };
}

/**
 * Oeffnet einen Dialog mit einem Knopf darin - so wie die Serien-Rueckfrage:
 * `onSave` bekommt das Panel und verdrahtet die Wahl.
 */
function openDialog({ openedAt = 0 } = {}) {
  at(openedAt);
  let chosen = null;
  let closed = false;
  const button = makeNode('button[data-scope="this"]');
  openModal({
    title: 'Serientermin speichern',
    content: '<button data-scope="this">Nur diesen Termin</button>',
    onClose: () => { closed = true; },
    onSave: (panel) => {
      panelOf.set(panel, panel);
      button.addEventListener('click', () => { chosen = 'this'; });
    },
  });
  const overlay = overlays.at(-1);
  return {
    overlay,
    button,
    get chosen() { return chosen; },
    get closed() { return closed; },
    tap(ms, event = pointerClick(button)) { at(ms); dispatch(overlay, button, event); },
    backdrop(ms) { at(ms); dispatch(overlay, overlay, pointerClick(overlay)); },
    escape(ms) { at(ms); document._fire('keydown', makeEvent('keydown', { key: 'Escape' })); },
  };
}

test('openModal haengt die Totzeit an - der zweite Tipp waehlt nichts aus', async () => {
  // DIE GEMESSENE LAGE (#1284): das Sheet faehrt ein und schiebt die drei
  // Wahlknoepfe unter den Finger, der eben "Speichern" getroffen hat. 40-70 ms
  // spaeter lag "Nur diesen Termin" darunter.
  installDocument();
  const dialog = openDialog();

  dialog.tap(60);
  assert.equal(dialog.chosen, null, 'der Tipp 60 ms nach dem Oeffnen hat eine Reichweite gewaehlt');

  dialog.tap(500);
  assert.equal(dialog.chosen, 'this', 'der Dialog nimmt nach der Totzeit keine Wahl mehr an');
  await closeModal({ force: true });
});

test('openModal laesst die Tastatur durch, auch im Fenster', async () => {
  installDocument();
  const dialog = openDialog();
  dialog.tap(60, keyboardClick(dialog.button));
  assert.equal(dialog.chosen, 'this', 'die Wahl per Tastatur wurde von der Totzeit geschluckt');
  await closeModal({ force: true });
});

test('Escape kommt auch im Fenster an', async () => {
  // Der Dialog muss waehrend der Totzeit verlassbar bleiben - sonst tauscht der
  // Fix eine falsche Antwort gegen einen Dialog, der 350 ms lang nichts tut.
  installDocument();
  const dialog = openDialog();
  dialog.escape(60);
  assert.equal(dialog.closed, true, 'Escape blieb waehrend der Totzeit wirkungslos');
});

test('die Totzeit liegt VOR dem Overlay-Schliesser, nicht dahinter', async () => {
  // Ein Klick auf den Hintergrund trifft das Overlay SELBST. Dort laufen
  // Capture- und Bubble-Listener desselben Knotens in Registrierungsreihenfolge:
  // wird die Totzeit nach dem Schliesser angehaengt, greift sie hier nicht.
  installDocument();
  const dialog = openDialog();
  dialog.backdrop(60);
  assert.equal(dialog.closed, false, 'der Hintergrundklick im Fenster hat den Dialog geschlossen');

  dialog.backdrop(500);
  assert.equal(dialog.closed, true, 'der Hintergrundklick nach der Totzeit schliesst nicht mehr');
});

test('jeder Dialog bringt seine eigene Totzeit mit', async () => {
  // Die Sperre gilt JE OEFFNUNG. Liefe sie einmal ab und nie wieder, waere die
  // Loeschfrage nach dem ersten Dialog einer Sitzung wieder offen fuer den
  // Doppelklick - und genau sie ist der Fall, den es schon vor #1284 gab.
  installDocument();
  const erster = openDialog({ openedAt: 0 });
  erster.tap(500);
  assert.equal(erster.chosen, 'this');
  await closeModal({ force: true });

  const zweiter = openDialog({ openedAt: 1000 });
  zweiter.tap(1060);
  assert.equal(zweiter.chosen, null, 'der zweite Dialog oeffnete ohne Totzeit');
  zweiter.tap(1500);
  assert.equal(zweiter.chosen, 'this');
  await closeModal({ force: true });
});
