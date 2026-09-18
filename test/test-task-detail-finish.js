/**
 * Test: Eine offene Aufgabe laesst sich in EINEM Schritt erledigen (#1251)
 *
 * Zweck: Die Leseansicht fuehrte genau einen Statusknopf, und der schaltete den
 *        Zustand eine Stufe weiter - `open` -> `in_progress` -> `done`. Wer eine
 *        Aufgabe von der Uebersicht aus abhaken wollte, musste sie also erst
 *        STARTEN, die Ansicht erneut oeffnen und dann erledigen. Auf dem Handy
 *        ist dieser Weg der einzige: die Listenkarte blendet ihre
 *        Inline-Aktionen unter 640px aus, und die Uebersicht zeigt gar keinen
 *        Statusknopf (dashboard.js, renderUrgentTasks). Dazwischen ist nichts
 *        zu sehen - die Uebersichtszeile sieht nach dem ersten Tipp genauso aus
 *        wie davor, also wirkte der Tipp verschluckt (#1251).
 *
 * WARUM ALS VERHALTENSTEST UND NICHT ALS TEXTGUARD. `test:detail-view` liest
 * task-detail.js als Quelltext und haelt fest, dass die Ansicht ueberhaupt
 * Statusknoepfe baut - genau deshalb sah sie den Fehler nicht: die Knoepfe gab
 * es, sie standen nur nie gleichzeitig zur Verfuegung. Gemessen wird hier
 * deshalb, was bei einem GEGEBENEN Status herauskommt. Der Loader-Stub von
 * /components/detail-view.js reicht die Optionen dafuer an
 * globalThis.__openDetailView durch.
 *
 * Ausfuehren: npm run test:task-detail-finish
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
// Die Leseansicht BAUT ihre Abschnitte als Knoten, bevor sie die Aktionsliste
// abgibt - ohne ein `document` scheitert sie vor der Stelle, die hier gemessen
// wird, und der Test waere rot aus dem falschen Grund.
import { installMiniDom } from './mini-dom.js';

installMiniDom();
globalThis.document.documentElement.classList = {
  toggle() {}, add() {}, remove() {}, contains() { return false; },
};

const { openTaskDetail } = await import('../public/components/task-detail.js');

const BASIS = { id: 7, title: 'Tisch decken', visibility: 'all', created_by: 2, subtasks: [] };

/**
 * Die Ansicht fuer einen Status oeffnen und die Aktionen einsammeln, die sie
 * dabei anbietet. Der Betrachter ist der Ersteller, damit Loeschen, Bearbeiten
 * und Ablegen mitkommen - sonst misst der Test eine Ansicht, die ohnehin fast
 * nichts zeigt.
 */
function aktionenBei(status, extra = {}) {
  let gesehen = null;
  globalThis.__openDetailView = (options) => { gesehen = options; };
  try {
    openTaskDetail({ task: { ...BASIS, status, ...extra }, currentUserId: 2 });
  } finally {
    delete globalThis.__openDetailView;
  }
  assert.ok(gesehen, 'die Leseansicht wurde gar nicht geoeffnet');
  return gesehen.actions ?? [];
}

/** Die Status, in die eine Aktionsliste fuehrt - der Knopf selbst zaehlt nicht. */
function zieleVon(actions) {
  return actions.map((a) => a.id);
}

test('eine offene Aufgabe bietet das Erledigen direkt an, nicht erst nach dem Starten', () => {
  const offen = aktionenBei('open');
  const ids = zieleVon(offen);

  assert.ok(ids.includes('task-detail-finish'),
    `eine offene Aufgabe braucht einen Erledigen-Knopf, gefunden: ${ids.join(', ')}`);

  // DER GEGENFALL GEHOERT DAZU: ohne ihn waere der Test auch dann gruen, wenn
  // das Starten dabei verloren ginge - und das Zwischenstadium ist eine
  // gewollte Angabe, keine Durchgangsstation.
  assert.ok(ids.includes('task-detail-start'),
    `das Starten bleibt daneben stehen, gefunden: ${ids.join(', ')}`);
});

test('die Reihenfolge stellt das Erledigen vor das Starten', () => {
  const ids = zieleVon(aktionenBei('open'));
  assert.ok(ids.indexOf('task-detail-finish') < ids.indexOf('task-detail-start'),
    `Erledigen steht vor Starten, gefunden: ${ids.join(', ')}`);
});

test('eine laufende Aufgabe fuehrt weiter genau einen Statusknopf', () => {
  const ids = zieleVon(aktionenBei('in_progress'));
  assert.ok(ids.includes('task-detail-finish'), 'sie laesst sich erledigen');
  assert.ok(!ids.includes('task-detail-start'),
    'ein zweites Starten waere ein Knopf ohne Wirkung');
});

test('eine erledigte Aufgabe bietet nur das Zuruecknehmen an', () => {
  const ids = zieleVon(aktionenBei('done'));
  assert.ok(ids.includes('task-detail-reopen'), 'sie laesst sich wieder oeffnen');
  assert.ok(!ids.includes('task-detail-finish'), 'ein zweites Erledigen gibt es nicht');
  assert.ok(!ids.includes('task-detail-start'), 'und ein Starten erst recht nicht');
});

test('solange ein Statuswechsel laeuft, ist der Nachbarknopf gesperrt', async () => {
  // DER GRUND IST KEIN KOSMETISCHER. `btnLoading()` sperrt nur den angeklickten
  // Knopf, und solange je Status genau einer dastand, war das vollstaendig. Mit
  // Erledigen UND Starten nebeneinander kann jemand auf einer langsamen Leitung
  // beide ausloesen: der erste Aufruf bucht Punkte, schreibt die Erledigung fort
  // und legt bei einer Serie die naechste Instanz an - der zweite liest `done`
  // vor, storniert alles davon und LOESCHT die Folgeinstanz.
  const knoepfe = new Map();
  const machKnopf = (id) => {
    const el = { id, disabled: false, classList: { add() {}, remove() {} } };
    knoepfe.set(id, el);
    return el;
  };
  machKnopf('task-detail-finish');
  machKnopf('task-detail-start');
  const vorherGetElementById = globalThis.document.getElementById;
  globalThis.document.getElementById = (id) => knoepfe.get(id) ?? null;

  // Die Antwort haengt, bis wir sie loesen - nur so ist der Zustand WAEHREND
  // des Schreibvorgangs ueberhaupt messbar.
  let loesen;
  globalThis.__apiStub = { patch: () => new Promise((r) => { loesen = r; }) };

  let aktionen = null;
  globalThis.__openDetailView = (options) => { aktionen = options.actions; };
  try {
    openTaskDetail({ task: { ...BASIS, status: 'open' }, currentUserId: 2 });
    const finish = aktionen.find((a) => a.id === 'task-detail-finish');
    const laeuft = finish.onClick({ button: knoepfe.get('task-detail-finish') });

    // NUR der Nachbar wird gemessen. Den gedrueckten sperrt `btnLoading()`, und
    // das ist Bestand aus modal.js, den der Loader stubt - eine Zusicherung
    // darueber maesse hier den Stub, nicht die Sache.
    assert.equal(knoepfe.get('task-detail-start').disabled, true,
      'und der Nachbar ebenso, sonst laufen zwei Schreibvorgaenge gegeneinander');

    loesen({ data: null });
    await laeuft;
  } finally {
    globalThis.document.getElementById = vorherGetElementById;
    delete globalThis.__openDetailView;
    delete globalThis.__apiStub;
  }
});

test('scheitert der Aufruf, ist der Nachbarknopf wieder bedienbar', async () => {
  // Der Gegenfall zum Riegel: eine Sperre, die nach einem Fehlschlag haengen
  // bleibt, macht die Ansicht unbedienbar, ohne dass etwas geschrieben wurde.
  const knoepfe = new Map();
  ['task-detail-finish', 'task-detail-start'].forEach((id) => {
    knoepfe.set(id, { id, disabled: false, classList: { add() {}, remove() {} } });
  });
  const vorherGetElementById = globalThis.document.getElementById;
  globalThis.document.getElementById = (id) => knoepfe.get(id) ?? null;
  globalThis.__apiStub = { patch: () => Promise.reject(new Error('Netzwerk')) };
  globalThis.window = globalThis.window ?? {};
  globalThis.window.yuvomi = { showToast() {} };

  let aktionen = null;
  globalThis.__openDetailView = (options) => { aktionen = options.actions; };
  try {
    openTaskDetail({ task: { ...BASIS, status: 'open' }, currentUserId: 2 });
    await aktionen.find((a) => a.id === 'task-detail-finish')
      .onClick({ button: knoepfe.get('task-detail-finish') });

    assert.equal(knoepfe.get('task-detail-start').disabled, false,
      'nach dem Fehlschlag steht der Nachbar wieder zur Verfuegung');
  } finally {
    globalThis.document.getElementById = vorherGetElementById;
    delete globalThis.__openDetailView;
    delete globalThis.__apiStub;
  }
});

test('eine abgelegte Aufgabe fuehrt gar keine Weiterschaltung', () => {
  // Abgelegt heisst aus dem Lauf genommen, nicht angehalten - ihr Knopf holt
  // zurueck. Ohne diesen Fall koennte der neue Erledigen-Knopf an der
  // Archiv-Bedingung vorbeilaufen, ohne dass es auffaellt.
  const ids = zieleVon(aktionenBei('open', { archived_at: '2026-09-01T10:00:00Z' }));
  assert.ok(!ids.includes('task-detail-finish'), 'kein Erledigen an einer abgelegten Aufgabe');
  assert.ok(!ids.includes('task-detail-start'), 'und kein Starten');
  assert.ok(ids.includes('task-detail-archive'), 'der Zurueckhol-Knopf bleibt');
});
