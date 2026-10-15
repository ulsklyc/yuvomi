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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

const { armPointerDeadTime, openModal, closeModal, whenModalClosed, captureModalContext, askOverModal, isOwnModalOpen } = await import('../public/components/modal.js');

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
function openDialog({ openedAt = 0, pointerDeadTime = true } = {}) {
  at(openedAt);
  let chosen = null;
  let closed = false;
  const button = makeNode('button[data-scope="this"]');
  openModal({
    pointerDeadTime,
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

// --------------------------------------------------------
// Die Browser-Sonden muessen die Totzeit abwarten
// --------------------------------------------------------

/**
 * Warum dieser Textguard hier steht, obwohl der Kopf dieser Datei Textsuchen
 * misstraut: Er misst nicht die Totzeit - das tun die Sonden darueber - sondern
 * eine Regel ueber den Sondencode selbst, und die IST Text.
 *
 * Der Anlass ist gemessen. Puppeteer klickt, sobald `waitForSelector`
 * zurueckkehrt; das ist weit innerhalb der Totzeit, der Klick faellt weg, das
 * Promise des Dialogs loest nie auf. Als das in test-document-guards.js an elf
 * Stellen passierte, lief der erste Test 189 s ins Timeout, riss den Browser
 * mit und faerbte die restlichen 47 Faelle in unter 1 ms rot - ein Bild, das
 * nach kaputter Umgebung aussieht und nicht nach einem Klick zu frueh.
 *
 * Ein Lauf deckt das also auf, aber erst nach drei Minuten und mit irrefuehrender
 * Spur. Hier kostet es Millisekunden und nennt die Stelle.
 */
test('keine Browser-Sonde klickt an der Totzeit vorbei', () => {
  const pfad = fileURLToPath(new URL('./test-document-guards.js', import.meta.url));

  // Nur die ARMIERTEN Dialoge, und die sind im Quelltext abzaehlbar: promptModal,
  // selectModal und confirmModal setzen `pointerDeadTime: true` hier in modal.js,
  // recurringScopeChoice tut es in calendar.js. Ein Editor bekommt keine Totzeit,
  // sein Knopf braucht die Wartezeit also nicht - fuenf ueberfluessige davon
  // rissen in Sonde 23 ein Fenster von 5 s, in dem ein PUT ankommen musste.
  //
  // Nicht nach `page.click('#confirm-modal-ok')` suchen, sondern nach einem
  // page.click, in dessen Zeile ueberhaupt so ein Knopf vorkommt. Die erste
  // Fassung fragte nach der Literalform und war blind fuer
  //   await page.click(confirmed ? '#confirm-modal-ok' : '#confirm-modal-cancel');
  // - genau die Zeile, an der die Suite 189 s lang haengenblieb.
  const ARMIERT = /#(?:confirm|prompt|select)-modal-|\[data-scope/;

  const direkt = readFileSync(pfad, 'utf8')
    .split('\n')
    .map((zeile, i) => [i + 1, zeile])
    .filter(([, zeile]) => /\bpage\.click\(/.test(zeile) && ARMIERT.test(zeile));

  assert.deepEqual(
    direkt.map(([nr, zeile]) => `${nr}: ${zeile.trim()}`),
    [],
    'diese Stellen muessen ueber clickPastDeadTime() gehen, sonst schluckt die Totzeit den Klick',
  );
});

test('ohne pointerDeadTime bleibt ein Overlay vom ersten Moment an bedienbar', () => {
  // DIE ANDERE RICHTUNG, und sie ist der teurere Fehler. Die Totzeit haengt an
  // openModal, also traf sie zuerst JEDES Overlay: 62 Aufrufe in 20 Dateien,
  // Formulare und Ansichtsblaetter darunter. Dort ist der erste Zeigerklick
  // Absicht - jemand hat das Blatt selbst aufgemacht und tippt hinein. Gemessen
  // fiel so der Moduswechsel im Notizblatt weg, und eine Sonde wartete 42 s auf
  // eine Vorschlagsliste, die nie kam.
  //
  // Ohne diesen Test waere die Suite nur noch fuer die armierte Haelfte wach:
  // ein `pointerDeadTime` das versehentlich wieder pauschal armiert, bliebe
  // gruen, weil jeder andere Test hier ihn ohnehin setzt.
  installDocument();
  const blatt = openDialog({ openedAt: 0, pointerDeadTime: false });
  blatt.tap(40);
  assert.equal(blatt.chosen, 'this', 'ein Formular schluckt den ersten Klick nicht');
});

// --------------------------------------------------------
// 3) whenModalClosed() - das ECHTE, nicht der Stub des Loaders
// --------------------------------------------------------
//
// Der Restore-Dialog (admin-backup.js) wartet darauf, bevor er den Fokus ins
// Schluesselfeld setzt: mobil schliesst das Modal animiert bis zu 400 ms nach
// der Antwort und gibt DANN den Fokus an den Ausloeser zurueck. Loest das
// Warten vor dieser Rueckgabe auf - oder gar nicht -, gewinnt wieder das Modal.
// test-settings-backup-key.js kann das nicht sehen: dort ersetzt der Loader
// modal.js durch einen Stub. Deshalb hier gegen `_doClose()` selbst.

/** Ausloeser, der wie im Browser den Fokus annimmt und es protokolliert. */
function makeTrigger(log) {
  const node = makeNode('button#trigger');
  node.tagName = 'BUTTON';
  node.id = 'trigger';
  node.focus = () => { document.activeElement = node; log.push('focus'); };
  return node;
}

/** Offenes Modal aus einem vorigen Test abraeumen, dann frisches Dokument. */
async function freshDocument({ width }) {
  installDocument();
  // Seit auch Desktop einen Ausgang hat (Critique 2026-09-26), raeumt ein
  // Schliessen auf JEDER Breite erst nach `animationend` ab. Das Aufraeumen
  // hier laeuft deshalb unter reduzierter Bewegung - dort schliesst modal.js
  // sofort, und ein offenes Modal aus dem vorigen Test haengt nicht nach.
  const previousMatchMedia = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  try {
    await closeModal({ force: true });
  } finally {
    globalThis.matchMedia = previousMatchMedia;
  }
  installDocument();
  window.innerWidth = width;
}

/** Ob das Promise nach allen anstehenden Mikro- und einem Makrotask aufgeloest ist. */
async function settled(promise) {
  let done = false;
  promise.then(() => { done = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return done;
}

function fireAnimationEnd(overlay) {
  const panel = overlay.querySelector('.modal-panel');
  // `target` wie im Browser: modal.js hoert nur auf das Ende der EIGENEN
  // Ausgangs-Animation, nicht auf ein hochblubberndes eines Kindes.
  for (const l of [...panel._listeners]) if (l.type === 'animationend') l.handler(makeEvent('animationend', { target: panel }));
}

test('whenModalClosed: ohne offenes Modal loest es sofort auf', async () => {
  await freshDocument({ width: 1024 });
  assert.equal(await settled(whenModalClosed()), true);
});

test('whenModalClosed: mobil loest es erst NACH der Fokus-Rueckgabe des animierten Schliessens auf', async () => {
  await freshDocument({ width: 375 });
  const log = [];
  const trigger = makeTrigger(log);
  document.activeElement = trigger;
  const dialog = openDialog({ openedAt: 0 });
  document.activeElement = null; // der Fokus liegt im Dialog
  await closeModal({ force: true });
  const closed = whenModalClosed().then(() => log.push('resolved'));

  assert.equal(await settled(closed), false, 'loest auf, waehrend die Schliess-Animation noch laeuft');
  assert.equal(dialog.overlay.isConnected, true, 'Vorbedingung: das Overlay steht noch');

  fireAnimationEnd(dialog.overlay);
  assert.equal(await settled(closed), true, 'loest nach dem Ende der Animation nicht auf');
  assert.deepEqual(log, ['focus', 'resolved'], 'Reihenfolge: erst gibt das Modal den Fokus zurueck, dann loest das Warten auf');
});

test('whenModalClosed: ein openModal() waehrend des Schliessens haelt das Warten auf das ALTE nicht an', async () => {
  await freshDocument({ width: 375 });
  const first = openDialog({ openedAt: 0 });
  await closeModal({ force: true });
  const waitFirst = whenModalClosed();

  const second = openDialog({ openedAt: 1000 });
  const waitSecond = whenModalClosed();
  assert.equal(await settled(waitFirst), false, 'das erste Overlay steht noch in seiner Animation');

  fireAnimationEnd(first.overlay);
  assert.equal(await settled(waitFirst), true, 'das Warten auf das erste haengt am zweiten Dialog');
  assert.equal(await settled(waitSecond), false, 'das Warten auf das zweite endet mit dem ersten');
  assert.equal(second.overlay.isConnected, true);

  await closeModal({ force: true });
  fireAnimationEnd(second.overlay);
  assert.equal(await settled(waitSecond), true);
});

test('closeModal: ein Fokus, den der Aufrufer nach dem Schliessen setzt, ueberlebt das Ende des Ausgangs', async () => {
  // Desktop hat seit der Critique 2026-09-26 einen Ausgang; closeModal() loest
  // mit seinem START auf. Der Fasten-Editor wartet darauf, zeichnet neu und
  // fokussiert das neue Steuerelement - rund 150 ms spaeter gab _doClose den
  // Fokus dem alten Ausloeser zurueck und nahm ihn dem Aufrufer wieder weg.
  await freshDocument({ width: 1024 });
  const log = [];
  const trigger = makeTrigger(log);
  document.activeElement = trigger;
  const dialog = openDialog({ openedAt: 0 });
  document.activeElement = null; // der Fokus liegt im Dialog
  await closeModal({ force: true });
  assert.equal(dialog.overlay.isConnected, true, 'Vorbedingung: der Ausgang laeuft noch');

  const neu = makeNode('button#neu');
  neu.tagName = 'BUTTON';
  neu.focus = () => { document.activeElement = neu; log.push('neu'); };
  neu.focus();
  fireAnimationEnd(dialog.overlay);
  await settled(whenModalClosed());

  assert.equal(document.activeElement, neu, 'das Ende des Ausgangs hat den Fokus des Aufrufers ueberschrieben');
  assert.deepEqual(log, ['neu']);
});

test('closeModal: ohne fremden Fokus gibt das Ende des Ausgangs ihn weiter dem Ausloeser zurueck', async () => {
  await freshDocument({ width: 1024 });
  const log = [];
  const trigger = makeTrigger(log);
  document.activeElement = trigger;
  const dialog = openDialog({ openedAt: 0 });
  document.activeElement = null;
  await closeModal({ force: true });
  fireAnimationEnd(dialog.overlay);
  await settled(whenModalClosed());
  assert.equal(document.activeElement, trigger);
  assert.deepEqual(log, ['focus']);
});

// --------------------------------------------------------
// 3) Spaete Antwort: closeModal({ context }) schliesst nur den EIGENEN Dialog (#1997)
// --------------------------------------------------------

/**
 * Der Ablauf einer Seite, wie er nach #1997 aussehen soll: Dialog festhalten,
 * Anfrage abwarten, dann nur diesen Dialog schliessen. Die Anfrage ist ein
 * Promise, das der Test selbst aufloest - so liegt dazwischen, was der Nutzer
 * waehrend des Wartens tut.
 */
function startSave() {
  let answer;
  const request = new Promise((resolve) => { answer = resolve; });
  const dialog = captureModalContext();
  const done = (async () => {
    await request;
    await closeModal({ force: true, context: dialog });
  })();
  return { answer: () => { answer(); return done; } };
}

const withLocation = () => { window.location = { pathname: '/recipes', search: '', hash: '' }; };

test('spaete Erfolgsantwort: ein inzwischen geoeffneter Dialog B bleibt offen (#1997)', async () => {
  await freshDocument({ width: 1024 });
  withLocation();
  globalThis.matchMedia = () => ({ matches: true });
  const a = openDialog({ openedAt: 0 });
  const save = startSave();
  await closeModal({ force: true });
  assert.equal(a.closed, true, 'Vorbedingung: A ist zu');
  const b = openDialog({ openedAt: 1000 });

  await save.answer();

  assert.equal(b.closed, false, 'die spaete Antwort aus A hat B geschlossen');
  assert.equal(b.overlay.isConnected, true, 'B haengt nicht mehr im Dokument');
  await closeModal({ force: true });
  assert.equal(b.closed, true, 'ein Schliessen ohne context schliesst B weiter');
});

test('spaete Erfolgsantwort: derselbe Dialog neu geoeffnet ist ein anderer Dialog', async () => {
  // Gleiche Maske, frische Eingaben: auch die gehoeren dem Nutzer.
  await freshDocument({ width: 1024 });
  withLocation();
  globalThis.matchMedia = () => ({ matches: true });
  openDialog({ openedAt: 0 });
  const save = startSave();
  await closeModal({ force: true });
  const again = openDialog({ openedAt: 1000 });
  await save.answer();
  assert.equal(again.closed, false);
  await closeModal({ force: true });
});

test('Erfolgsantwort, waehrend der eigene Dialog noch offen ist: er geht zu', async () => {
  // Die andere Richtung: ein Waechter, der nie schliesst, waere der neue Fehler.
  await freshDocument({ width: 1024 });
  withLocation();
  globalThis.matchMedia = () => ({ matches: true });
  const a = openDialog({ openedAt: 0 });
  const save = startSave();
  await save.answer();
  assert.equal(a.closed, true, 'der eigene Dialog blieb nach dem Erfolg offen');
  assert.equal(a.overlay.isConnected, false);
});

test('Erfolgsantwort nach einer Rueckfrage ueber dem Dialog: der zurueckgeholte Dialog geht zu', async () => {
  // Eine Rueckfrage parkt den Dialog und laeuft selbst durch openModal(); danach
  // kommt DERSELBE Dialog zurueck. Haengt die Pruefung an einem Zaehler je
  // openModal(), gilt er danach als fremd und bliebe nach dem Speichern offen.
  await freshDocument({ width: 1024 });
  withLocation();
  globalThis.matchMedia = () => ({ matches: true });
  const a = openDialog({ openedAt: 0 });
  const save = startSave();
  const answer = await askOverModal(async () => {
    openDialog({ openedAt: 1000 });
    await closeModal({ force: true });
    return 'abgebrochen';
  });
  assert.equal(answer, 'abgebrochen');
  assert.equal(a.closed, false, 'Vorbedingung: A ist zurueck und offen');
  await save.answer();
  assert.equal(a.closed, true, 'der zurueckgeholte eigene Dialog blieb nach dem Erfolg offen');
});

test('Erfolgsantwort, waehrend der eigene Dialog unter einer Rueckfrage geparkt liegt: die Rueckfrage bleibt, beim Zurueckholen geht er zu', async () => {
  // Codex an #2021: der geparkte Dialog ist nicht der aktive, aber auch nicht
  // ersetzt. Als „weg" behandelt, blieb er nach „Abbrechen" offen, obwohl er
  // gespeichert war - mit gesperrtem Speichern-Knopf.
  await freshDocument({ width: 1024 });
  withLocation();
  globalThis.matchMedia = () => ({ matches: true });
  const a = openDialog({ openedAt: 0 });
  const save = startSave();
  let frage = null;
  let frageZuDurchAntwort = null;
  const answer = await askOverModal(async () => {
    frage = openDialog({ openedAt: 1000 });
    await save.answer();
    frageZuDurchAntwort = frage.closed;
    await closeModal({ force: true }); // „Abbrechen"
    return 'abgebrochen';
  });
  assert.equal(answer, 'abgebrochen');
  assert.equal(frageZuDurchAntwort, false, 'die spaete Antwort hat die Rueckfrage geschlossen');
  assert.equal(a.closed, true, 'der gespeicherte Dialog blieb nach dem Abbrechen der Rueckfrage offen');
});

test('ein Dialog in seiner Schliess-Animation gehoert dem Ablauf nicht mehr (#1997, Codex an #2021)', async () => {
  // Der Nutzer schliesst den Verwalten-Dialog bewusst; die Antwort kommt
  // waehrend des Ausgangs. activeOverlay zeigt bis _doClose() noch auf den
  // Knoten - als "offen" gelesen, baute die Seite ihn nach dem Laden neu auf.
  await freshDocument({ width: 1024 });
  withLocation();
  globalThis.matchMedia = () => ({ matches: false }); // mit Ausgang
  const a = openDialog({ openedAt: 0 });
  const ctx = captureModalContext();
  assert.equal(isOwnModalOpen(ctx), true, 'Vorbedingung: offen gehoert er dem Ablauf');
  await closeModal({ force: true });
  assert.equal(a.overlay.isConnected, true, 'Vorbedingung: der Ausgang laeuft noch');
  assert.equal(isOwnModalOpen(ctx), false, 'der schliessende Dialog gilt weiter als offen');
  fireAnimationEnd(a.overlay);
  await settled(whenModalClosed());
});
