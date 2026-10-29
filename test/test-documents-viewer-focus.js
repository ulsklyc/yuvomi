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
function openViewer({ keyboard, staleRing = false }) {
  // Der Zeuge ist die letzte Eingabe (modal.js, lastInputWasKeyboard), nicht
  // der Fokusring des Ausloesers: `staleRing` stellt die Seitenwurzel nach
  // einem Seitenwechsel nach, die ihn auch nach einem Mausklick traegt.
  globalThis.__lastInputKeyboard = keyboard;
  const opener = element('opener', { matches: (sel) => sel === ':focus-visible' && (keyboard || staleRing) });
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

/**
 * DIE BUEHNE IST NIE LEER (Critique R21, a4). Mobil stand der Betrachter
 * 300-400 ms ohne Bild und ohne Ladezeichen da, bis die volle Datei kam. Jetzt
 * steht das Bild auf einer Buehne mit Ladezeichen (und dem Poster der Kachel,
 * wenn es eines gibt); sobald das Bild da ist oder scheitert, geht sie aus dem
 * Ladezustand. Gemessen am Aufrufer: Betrachter ueber seinen Einstieg, das
 * Verdrahten ueber `onSave`.
 */
test('R21 S8: das Bild steht auf einer Buehne mit Ladezeichen, die mit dem Bild ihren Ladezustand verlaesst', () => {
  const IMG = { ...PDF, id: 4, name: 'Impfpass', original_name: 'impfpass.jpg', mime_type: 'image/jpeg' };
  for (const outcome of ['load', 'error']) {
    let options = null;
    const previous = globalThis.__openModal;
    globalThis.__openModal = (opts) => { options = opts; };
    try { documentsPage.openDocumentViewer(IMG); } finally { globalThis.__openModal = previous; }
    assert.match(options.content, /<div class="document-viewer__stage" data-stage-loading>/, 'ohne Buehne steht bis zum Bild eine leere Flaeche');
    assert.match(options.content, /<span class="document-viewer__stage-status" role="status">/, 'ohne Ladezeichen sieht das Warten aus wie ein Fehler');
    assert.doesNotMatch(options.content, /loading="lazy"/, 'im offenen Dialog wartete lazy erst ein Layout ab');

    const attrs = new Set(['data-stage-loading']);
    const img = element('img', { complete: false, naturalWidth: 0 });
    const inserted = [];
    let removed = false;
    const stage = element('stage', {
      removeAttribute: (a) => { attrs.delete(a); },
      querySelector: (sel) => (sel.startsWith('img.document-viewer__image') ? img : null),
      insertAdjacentHTML: (where, html) => { inserted.push({ where, html }); },
      remove: () => { removed = true; },
    });
    const panel = element('panel', {
      querySelector: (sel) => (sel === '.document-viewer__stage[data-stage-loading]' ? stage : null),
    });
    options.onSave(panel);
    assert.ok(attrs.has('data-stage-loading'), 'die Buehne gab den Ladezustand vor dem Bild auf');
    img.fire(outcome);
    if (outcome === 'load') {
      assert.equal(attrs.has('data-stage-loading'), false, 'nach load blieben Poster und Ladezeichen stehen');
      assert.equal(removed, false, 'ein geladenes Bild bleibt stehen');
    } else {
      // R24, Critique G4 P2-1: ein kaputtes Bild ist keine Buehne. Statt des
      // Broken-Image-Zeichens steht die Ersatzkarte des Betrachters da.
      assert.equal(removed, true, 'nach error blieb das kaputte Bild auf der Buehne stehen');
      assert.equal(inserted.length, 1, 'keine Ersatzkarte eingesetzt');
      assert.equal(inserted[0].where, 'afterend');
      assert.match(inserted[0].html, /class="document-viewer__unsupported" role="alert"/);
      assert.match(inserted[0].html, /documents\.viewerImageFallbackHint/);
      assert.match(inserted[0].html, /impfpass\.jpg/, 'die Karte nennt die Datei');
    }
    options.onClose?.();
  }
});

test('R24 G4 P2-1: ein Bild, das schon gescheitert ist, bevor die Buehne verdrahtet wird, bekommt die Ersatzkarte', () => {
  const IMG = { ...PDF, id: 5, name: 'Kassenbon', original_name: 'bon.jpg', mime_type: 'image/jpeg' };
  let options = null;
  const previous = globalThis.__openModal;
  globalThis.__openModal = (opts) => { options = opts; };
  try { documentsPage.openDocumentViewer(IMG); } finally { globalThis.__openModal = previous; }
  const img = element('img', { complete: true, naturalWidth: 0 });
  const inserted = [];
  let removed = false;
  const stage = element('stage', {
    querySelector: () => img,
    insertAdjacentHTML: (where, html) => { inserted.push(html); },
    remove: () => { removed = true; },
  });
  options.onSave(element('panel', { querySelector: (sel) => (sel.includes('data-stage-loading') ? stage : null) }));
  assert.equal(removed, true);
  assert.match(inserted[0] ?? '', /documents\.viewerImageFallbackHint/);
  options.onClose?.();
});

// Critique R21 (Persona Alex): Vor und Zurueck im Betrachter - Knoepfe mit dem
// Namen des Ziels und die Pfeiltasten, die auf sie zeigen. Die Nachbarn sind
// die der SICHTBAREN Liste; aus einem Feld heraus gehoeren die Pfeile dem Feld.
test('Betrachter: Vor/Zurueck nennt das Ziel, die Pfeile blaettern durch die sichtbare Liste', () => {
  const A = { ...PDF, id: 1, name: 'Mietvertrag' };
  const B = { ...PDF, id: 9, name: 'Impfpass' };
  documentsPage.state.documents = [A, PDF, B];
  documentsPage.state.query = '';
  const opened = [];
  const previous = globalThis.__openModal;
  globalThis.__openModal = (opts) => { opened.push(opts); };
  try {
    doc.activeElement = element('opener', { matches: () => false });
    documentsPage.openDocumentViewer(PDF);
    const html = opened[0].content;
    assert.match(html, /data-action="viewer-prev"[^>]*aria-label="documents\.viewerPrevNamed\{&quot;name&quot;:&quot;Mietvertrag&quot;\}"/);
    assert.match(html, /data-action="viewer-next"[^>]*aria-label="documents\.viewerNextNamed\{&quot;name&quot;:&quot;Impfpass&quot;\}"/);
    assert.match(html, /aria-keyshortcuts="ArrowLeft"/);
    const panel = element('panel', { querySelector: () => null });
    opened[0].onSave(panel);
    const key = (k, target = element('body-target', { closest: () => null })) => {
      let prevented = false;
      panel.fire('keydown', { key: k, target, preventDefault: () => { prevented = true; } });
      return prevented;
    };
    assert.equal(key('ArrowRight'), true);
    assert.match(opened.at(-1).title, /Impfpass/, 'Rechts oeffnet das naechste Dokument der Liste');
    assert.equal(key('ArrowLeft'), true);
    assert.match(opened.at(-1).title, /Mietvertrag/, 'Links das vorige');
    const count = opened.length;
    assert.equal(key('ArrowRight', element('feld', { closest: (sel) => (/input/.test(sel) ? {} : null) })), false, 'aus einem Feld heraus nicht');
    assert.equal(opened.length, count);
    // Am Rand der Liste: kein Pfeil ins Leere. Seit R22 (D11) steht der
    // fehlende Pfeil gedimmt als Zeichen (kein Knopf, aus dem Baum), damit das
    // Paar als Paar lesbar bleibt - vorher stand mobil "  >" allein in der Zeile.
    opened.length = 0;
    documentsPage.openDocumentViewer(B);
    assert.doesNotMatch(opened[0].content, /data-action="viewer-next"/);
    assert.match(opened[0].content, /<span class="row-action document-viewer__pager-edge" aria-hidden="true"><i data-lucide="chevron-right"/);
    assert.doesNotMatch(opened[0].content, /document-viewer__pager-gap/);
    // Das Paar ist ein eigenes Kind der Meta-Zeile, VOR den Handlungen.
    const html2 = opened[0].content;
    assert.ok(html2.indexOf('class="document-viewer__pager"') < html2.indexOf('class="document-viewer__actions"'));
    assert.doesNotMatch(html2.slice(html2.indexOf('class="document-viewer__actions"')), /document-viewer__pager"/, 'nicht mehr in der Handlungsleiste');
  } finally {
    globalThis.__openModal = previous;
    documentsPage.state.documents = [];
  }
});

// Codex-Review zu #2142: Blaettern ruft openDocumentViewer() erneut auf, und
// der neue Dialog merkt sich document.activeElement als Ausloeser (modal.js,
// rememberFocus) - nach dem Blaettern einen Knopf im alten Betrachter, der mit
// ihm verschwindet. Beim Schliessen fiel der Fokus dann auf die Seitenwurzel
// statt zurueck in die Liste, und "Bearbeiten" reichte denselben toten Knopf
// weiter. Der Betrachter reicht den Ausloeser in der LISTE durch, wie der
// Wechsel nach "Bearbeiten" es schon tat. Gemessen wird, was im Moment des
// openModal()-Aufrufs fokussiert ist - genau das merkt sich das echte Modal.
test('Betrachter: Blaettern reicht den Ausloeser in der Liste weiter, ueber mehrere Schritte bis "Bearbeiten"', () => {
  const A = { ...PDF, id: 1, name: 'Mietvertrag' };
  const B = { ...PDF, id: 9, name: 'Impfpass' };
  documentsPage.state.documents = [A, PDF, B];
  documentsPage.state.query = '';
  const opened = [];
  const previous = globalThis.__openModal;
  globalThis.__openModal = (opts) => { opened.push({ opts, focus: doc.activeElement }); };
  /** Verdrahtet wie das Modal; die Knoepfe stehen im Dialog und gehen mit ihm. */
  const wire = (entry) => {
    const buttons = new Map(['viewer-prev', 'viewer-next', 'edit-document'].map((action) => [action, element(action)]));
    const panel = element('panel', { querySelector: (sel) => buttons.get(/data-action="([^"]+)"/.exec(sel)?.[1]) ?? null });
    entry.opts.onSave(panel);
    return { panel, buttons, gone() { for (const button of buttons.values()) button.isConnected = false; } };
  };
  try {
    const row = element('row');
    row.focus();
    documentsPage.openDocumentViewer(PDF);
    assert.equal(opened[0].focus, row, 'Ausgangslage: der erste Betrachter merkt sich die Zeile');

    // Schritt 1 per Knopf.
    const first = wire(opened[0]);
    first.buttons.get('viewer-next').focus();
    first.buttons.get('viewer-next').fire('click');
    first.gone();
    assert.match(opened[1].opts.title, /Impfpass/);
    assert.equal(opened[1].focus, row, 'der naechste Dialog merkte sich den Knopf im alten Betrachter - der verschwindet mit ihm');

    // Schritt 2 per Pfeiltaste, aus dem schon geblaetterten Betrachter.
    const second = wire(opened[1]);
    const prev = second.buttons.get('viewer-prev');
    prev.focus();
    second.panel.fire('keydown', { key: 'ArrowLeft', target: prev, preventDefault() {} });
    second.gone();
    assert.match(opened[2].opts.title, /Zeugnis/);
    assert.equal(opened[2].focus, row, 'nach dem zweiten Schritt kennt der Betrachter die Zeile nicht mehr');

    // Bearbeiten aus dem zweimal geblaetterten Betrachter: derselbe Ausloeser.
    const third = wire(opened[2]);
    const edit = third.buttons.get('edit-document');
    edit.focus();
    edit.fire('click');
    assert.equal(doc.activeElement, row, '"Bearbeiten" gab den Fokus an einen Knopf eines laengst geschlossenen Betrachters');
  } finally {
    globalThis.__openModal = previous;
    documentsPage.state.documents = [];
  }
});

// R23 S11 (Rest aus S6): nach einem Seitenwechsel traegt der Ausloeser den
// Fokusring auch nach einem Mausklick - der Waechter hielt den Zeiger dann
// fuer eine Taste und nahm den Fokus aus dem PDF zurueck.
test('per Zeiger geoeffnet, aber mit altem Fokusring: der Zeiger zaehlt', async () => {
  const v = openViewer({ keyboard: false, staleRing: true });
  assert.equal(await v.frameTakesFocus(), v.frame, 'der Fokus darf im angeklickten PDF bleiben');
  v.close_();
});
