/**
 * Test: Die Eingabezeile "Teilaufgabe hinzufuegen" legt im Blatt wirklich an (#1598)
 *
 * Zweck: Seit v2.70.0 wird der Knopf "Teilaufgabe hinzufuegen" in der
 *        Leseansicht zum Feld, Enter soll anlegen. In der Detailspalte ab
 *        1280px tat es das - im BLATT (jedes Telefon, jedes schmale Fenster)
 *        nie: der Focus-Trap von modal.js faengt Enter in jedem einzeiligen
 *        Feld ab und klickt den ERSTEN `button[type="submit"]` des ganzen
 *        Panels. In der Aufgabe ist das "Kommentieren" - der leere Kommentar
 *        tat nichts, `preventDefault()` nahm dem eigenen Formular des Feldes
 *        die implizite Absendung, und einen sichtbaren Knopf gab es nicht. Es
 *        blieb kein Weg, eine Teilaufgabe anzulegen.
 *
 * ZWEI SEITEN, BEIDE GEMESSEN. Der Trap muss den Absende-Knopf des Formulars
 * nehmen, in dem das Feld steht, und die Eingabezeile muss einen solchen Knopf
 * fuehren - eine Seite allein laesst den Fehler stehen. Der Trap laeuft hier
 * als ECHTE Funktion aus modal.js (`__test.trapFocus`) gegen Attrappen, die
 * Eingabezeile kommt aus dem echten `openTaskDetail`.
 *
 * Ausfuehren: npm run test:subtask-compose
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
};
import { installMiniDom } from './mini-dom.js';

installMiniDom();
globalThis.document.documentElement.classList = {
  toggle() {}, add() {}, remove() {}, contains() { return false; },
};

const { __test: modalTest } = await import('../public/components/modal.js');
const { openTaskDetail } = await import('../public/components/task-detail.js');

// --------------------------------------------------------
// Der Trap: Enter gehoert dem Formular des Feldes
// --------------------------------------------------------

/** Ein Knopf, der seine Klicks zaehlt. */
function knopf(name) {
  return { name, disabled: false, clicks: 0, click() { this.clicks += 1; } };
}

/**
 * Ein Panel wie das der Aufgabe: `first` ist, was die panelweite Suche
 * `button[type="submit"], .btn--primary` zuerst findet.
 */
function panelMit(first) {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener() {},
    querySelector(selector) {
      return selector.includes('button[type="submit"]') ? first : null;
    },
    querySelectorAll() { return []; },
  };
}

/** Enter im gegebenen Feld druecken; liefert, ob der Trap es verschluckt hat. */
function enterIn(panel, field) {
  globalThis.document.activeElement = field;
  let prevented = false;
  panel.listeners.get('keydown')({ key: 'Enter', preventDefault() { prevented = true; } });
  return prevented;
}

test('Enter in einem Feld mit eigenem Formular klickt DESSEN Absende-Knopf, nicht den ersten des Panels', () => {
  assert.equal(typeof modalTest.trapFocus, 'function', 'modal.js gibt den Trap nicht mehr fuer Tests heraus');
  const kommentieren = knopf('Kommentieren');
  const hinzufuegen = knopf('Hinzufuegen');
  const panel = panelMit(kommentieren);
  modalTest.trapFocus(panel, 'none');

  const field = {
    tagName: 'INPUT',
    type: 'text',
    form: { querySelector: (s) => (s.includes('button[type="submit"]') ? hinzufuegen : null) },
  };
  enterIn(panel, field);

  assert.equal(kommentieren.clicks, 0,
    'Enter in der Teilaufgaben-Zeile hat "Kommentieren" ausgeloest - der Trap nimmt den ersten Absende-Knopf des Panels statt den des Formulars');
  assert.equal(hinzufuegen.clicks, 1, 'der Absende-Knopf des eigenen Formulars wurde nicht ausgeloest');
});

test('ein Formular OHNE eigenen Absende-Knopf faellt weiter auf den des Panels (#543)', () => {
  // DER GEGENFALL: die meisten Blaetter tragen ihren Speichern-Knopf in der
  // Fusszeile, also AUSSERHALB des Formulars. Naehme der Trap nur noch Knoepfe
  // aus dem Formular, speicherte Enter dort nichts mehr.
  const speichern = knopf('Speichern');
  const panel = panelMit(speichern);
  modalTest.trapFocus(panel, 'none');

  assert.equal(enterIn(panel, { tagName: 'INPUT', type: 'text', form: { querySelector: () => null } }), true);
  assert.equal(speichern.clicks, 1, 'Feld in einem Formular ohne eigenen Knopf');

  assert.equal(enterIn(panel, { tagName: 'INPUT', type: 'text', form: null }), true);
  assert.equal(speichern.clicks, 2, 'Feld ganz ohne Formular');
});

test('ein gesperrter Absende-Knopf des eigenen Formulars loest nichts aus - auch nicht den des Panels', () => {
  // Gesperrt heisst "gerade unterwegs". Der Rueckfall auf das Panel waere hier
  // genau der Fehler aus #1598 durch die Hintertuer.
  const kommentieren = knopf('Kommentieren');
  const hinzufuegen = knopf('Hinzufuegen');
  hinzufuegen.disabled = true;
  const panel = panelMit(kommentieren);
  modalTest.trapFocus(panel, 'none');

  enterIn(panel, { tagName: 'INPUT', type: 'text', form: { querySelector: () => hinzufuegen } });
  assert.equal(kommentieren.clicks, 0);
  assert.equal(hinzufuegen.clicks, 0);
});

// --------------------------------------------------------
// Die Eingabezeile: ein sichtbarer Knopf, der absendet
// --------------------------------------------------------

/** Die Eingabezeile der echten Leseansicht fuer eine Aufgabe, die man aendern darf. */
function eingabezeile() {
  let gesehen = null;
  globalThis.__openDetailView = (options) => { gesehen = options; };
  try {
    openTaskDetail({
      task: { id: 7, title: 'Tisch decken', status: 'open', visibility: 'all', created_by: 2, subtasks: [] },
      currentUserId: 2,
    });
  } finally {
    delete globalThis.__openDetailView;
  }
  assert.ok(gesehen, 'die Leseansicht wurde gar nicht geoeffnet');
  const section = gesehen.sections.find((s) => s?.label === 'tasks.subtasksLabel');
  assert.ok(section?.node, 'die Leseansicht fuehrt keinen Teilaufgaben-Abschnitt');
  const form = section.node.childNodes.find((n) => n.tagName === 'form');
  assert.ok(form, 'die Eingabezeile ist kein <form> mehr');
  return form;
}

test('die Eingabezeile fuehrt neben dem Feld einen beschrifteten Absende-Knopf', () => {
  const form = eingabezeile();
  const input = form.childNodes.find((n) => n.tagName === 'input');
  assert.ok(input, 'das Feld fehlt');

  const submit = form.childNodes.find((n) => n.tagName === 'button' && n.type === 'submit');
  assert.ok(submit,
    'die Eingabezeile hat keinen button[type="submit"] - ohne ihn gibt es auf dem Telefon keinen sichtbaren Weg, '
    + 'die Teilaufgabe anzulegen, und der Focus-Trap des Blatts findet nur fremde Knoepfe');
  assert.equal(submit.textContent, 'common.add', 'der Knopf traegt seinen Namen als sichtbaren Text aus t()');
  assert.ok(form.childNodes.indexOf(input) < form.childNodes.indexOf(submit), 'der Knopf steht hinter dem Feld');
});
