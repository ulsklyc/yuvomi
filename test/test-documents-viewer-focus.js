/**
 * Modul: Der Fokus im Dokument-Betrachter mit eingebautem PDF (#1511)
 * Zweck: Liegt der Fokus IM eingebauten PDF-Betrachter des Browsers, kommt kein
 *        Tastendruck mehr in der Seite an - Esc schliesst nicht. Das ist von
 *        der Seite aus nicht abzufangen (gemessen in Chromium: `keydown`
 *        erreicht weder das Dokument noch das Fenster des iframes). Was die
 *        Seite in der Hand hat, ist, ob der Fokus dort landet, OHNE dass jemand
 *        ins PDF geklickt hat. Gemessen: bei einer Datei, die sich als PDF
 *        ausgibt und keines ist, nahm sich der Betrachter den Fokus selbst -
 *        per Tastatur geoeffnet stand er danach im iframe, Esc war tot.
 *
 *        GEMESSEN WIRD AM AUFRUFER: der Betrachter wird ueber seinen echten
 *        Einstieg geoeffnet, verdrahtet wird ueber den Haken, den er dem Modal
 *        gibt (`onSave`), und abgebaut ueber `onClose`. Der Stub ist das, was
 *        der Browser dabei meldet: `blur` am Fenster, wenn der Fokus in den
 *        iframe wechselt, `keydown`/`pointerdown`/`pointermove` am Dokument.
 * Ausfuehren: npm run test:documents-viewer-focus
 */
import test from 'node:test';
import assert from 'node:assert/strict';

function target() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    fire(type, event = {}) { for (const fn of [...(listeners.get(type) ?? [])]) fn(event); },
    count(type) { return listeners.get(type)?.size ?? 0; },
  };
}

function element(name, extra = {}) {
  const el = {
    ...target(),
    name,
    isConnected: true,
    dataset: {},
    matches: () => false,
    setAttribute() {}, removeAttribute() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    focus() { globalThis.document.activeElement = el; },
    ...extra,
  };
  return el;
}

globalThis.localStorage = globalThis.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
const win = Object.assign(target(), { matchMedia: () => ({ matches: false }), yuvomi: { showToast() {} } });
const doc = Object.assign(target(), { activeElement: null, body: element('body'), querySelector: () => null, querySelectorAll: () => [] });
globalThis.window = win;
globalThis.document = doc;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { pdfViewerEnabled: true, onLine: true } });

const { __test: documentsPage } = await import('../public/pages/documents.js');

const PDF = { id: 3, name: 'Zeugnis', original_name: 'zeugnis.pdf', category: 'school', mime_type: 'application/pdf', file_size: 591, storage_backend: 'local', visibility: 'family', status: 'active' };

/**
 * Oeffnet den Betrachter und verdrahtet ihn wie das Modal.
 * @param {object} opts
 * @param {boolean} opts.keyboard - der Ausloeser traegt den Fokusring des Browsers
 */
function openViewer({ keyboard }) {
  const opener = element('opener', { matches: (sel) => sel === ':focus-visible' && keyboard });
  doc.activeElement = opener;
  let options = null;
  const previous = globalThis.__openModal;
  globalThis.__openModal = (opts) => { options = opts; };
  try { documentsPage.openDocumentViewer(PDF); } finally { globalThis.__openModal = previous; }
  assert.ok(options, 'der Betrachter oeffnet ein Modal');
  assert.match(options.content, /<iframe class="document-viewer__pdf"/, 'mit eingebautem Betrachter steht das PDF im iframe');

  const hover = { on: false };
  const frame = element('frame', { matches: (sel) => sel === ':hover' && hover.on });
  const close = element('close');
  const download = element('download');
  const panel = element('panel', {
    querySelector: (sel) => (sel === '.document-viewer__pdf' ? frame : sel === '.modal-panel__close' ? close : null),
  });
  // Das Modal legt den Erstfokus auf "Schliessen".
  close.focus();
  options.onSave(panel);
  panel.fire('focusin', { target: close });
  return {
    opener, frame, close, download, panel, hover,
    close_() { options.onClose?.(); },
    /** Der Fokus wechselt in den iframe: so meldet es der Browser. */
    async frameTakesFocus() {
      doc.activeElement = frame;
      win.fire('blur');
      await new Promise((resolve) => setTimeout(resolve, 5));
      return doc.activeElement;
    },
  };
}

test('per Tastatur geoeffnet: nimmt sich das PDF den Fokus selbst, geht er zurueck an den Dialog', async () => {
  const v = openViewer({ keyboard: true });
  assert.equal(await v.frameTakesFocus(), v.close, 'der Fokus bleibt im iframe - dort erreicht Esc die Seite nicht mehr');
  v.close_();
});

test('zurueck geht er an das Element, das ihn im Dialog zuletzt hatte', async () => {
  const v = openViewer({ keyboard: true });
  doc.fire('keydown', { key: 'Tab' });
  v.download.focus();
  v.panel.fire('focusin', { target: v.download });
  assert.equal(await v.frameTakesFocus(), v.download);
  v.close_();
});

test('Tab von einer angeklickten leeren Stelle aus fuehrt nicht ins PDF', async () => {
  const v = openViewer({ keyboard: false });
  doc.fire('pointerdown', { screenX: 400, screenY: 300 });
  doc.fire('keydown', { key: 'Tab' });
  assert.equal(await v.frameTakesFocus(), v.close);
  v.close_();
});

test('ein Klick ins PDF behaelt den Fokus: Markieren und Kopieren bleiben', async () => {
  // Per Maus geoeffnet - der Klick im iframe selbst ist von aussen nicht zu sehen.
  const mouse = openViewer({ keyboard: false });
  assert.equal(await mouse.frameTakesFocus(), mouse.frame, 'der Klick eines Mausnutzers wurde zurueckgenommen');
  mouse.close_();

  // Per Tastatur geoeffnet, dann zur Maus gegriffen: der Zeiger wandert ueber
  // den Dialog ins PDF.
  const mixed = openViewer({ keyboard: true });
  doc.fire('pointermove', { screenX: 400, screenY: 300 });
  doc.fire('pointermove', { screenX: 420, screenY: 340 });
  assert.equal(await mixed.frameTakesFocus(), mixed.frame, 'wer den Zeiger bewegt hat, bedient mit dem Zeiger');
  mixed.close_();

  // Der Zeiger steht ueber dem iframe: ein Klick ist moeglich.
  const hovering = openViewer({ keyboard: true });
  hovering.hover.on = true;
  assert.equal(await hovering.frameTakesFocus(), hovering.frame);
  hovering.close_();
});

test('ein pointermove ohne Bewegung macht aus der Tastatur keine Maus', async () => {
  // Nach einem Layoutwechsel schickt der Browser eines fuer den ruhenden Zeiger.
  const v = openViewer({ keyboard: true });
  doc.fire('pointermove', { screenX: 400, screenY: 300 });
  doc.fire('pointermove', { screenX: 400, screenY: 300 });
  assert.equal(await v.frameTakesFocus(), v.close);
  v.close_();
});

test('ein Betrachter, der sich den Fokus immer wieder nimmt, bekommt ihn nach drei Runden', async () => {
  const v = openViewer({ keyboard: true });
  for (let i = 0; i < 3; i++) assert.equal(await v.frameTakesFocus(), v.close);
  assert.equal(await v.frameTakesFocus(), v.frame, 'kein endloses Hin und Her');
  doc.fire('keydown', { key: 'Tab' });
  assert.equal(await v.frameTakesFocus(), v.close, 'die naechste Eingabe zaehlt neu');
  v.close_();
});

test('beim Schliessen haengt nichts mehr an Fenster und Dokument', async () => {
  const before = { blur: win.count('blur'), keydown: doc.count('keydown'), pointerdown: doc.count('pointerdown'), pointermove: doc.count('pointermove') };
  const v = openViewer({ keyboard: true });
  assert.equal(win.count('blur'), before.blur + 1, 'der Waechter haengt am Fenster');
  v.close_();
  assert.deepEqual(
    { blur: win.count('blur'), keydown: doc.count('keydown'), pointerdown: doc.count('pointerdown'), pointermove: doc.count('pointermove') },
    before,
  );
  assert.equal(await v.frameTakesFocus(), v.frame, 'ein geschlossener Betrachter fasst den Fokus nicht mehr an');
});
