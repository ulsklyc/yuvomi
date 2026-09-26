/**
 * Tests: Mengen-Stepper des Vorrats gegen eine ueberholende Auffrischung
 * Modul: /public/pages/pantry.js
 *
 * WARUM ALS REIHENFOLGE-TEST: der Fehler ist nicht „es fehlt eine Wache",
 * sondern „die Auffrischung faellt MITTEN in das Entprell-Fenster". Eine
 * Textprobe auf `pendingQuantity` waere seit jeher gruen gewesen - die Map gab
 * es, sie wurde nach dem Laden nur nie wieder aufgetragen, und der Timer hielt
 * danach ein Objekt, das an keinem Bestand mehr haengt. Die Tests unten stellen
 * die Reihenfolge deshalb wirklich: erst der Schritt, dann die Antwort mit dem
 * ALTEN Stand, dann der PATCH.
 *
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-pantry-ux.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

global.HTMLElement = class HTMLElement {};
global.customElements = { define() {}, get() { return undefined; } };

/** Generischer Knoten: genug fuer `rowEl`, das die Zeile wirklich neu baut. */
function makeNode() {
  const node = {
    style: {}, dataset: {}, children: [],
    className: '', textContent: '', type: '', hidden: false, disabled: false,
    isConnected: true,
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
    appendChild(child) { node.children.push(child); return child; },
    append(...kids) { node.children.push(...kids); },
    replaceChildren() { node.children = []; },
    replaceWith() {},
    insertAdjacentHTML() {},
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() {},
  };
  return node;
}

global.window = { matchMedia: () => ({ matches: false }), addEventListener() {}, yuvomi: {} };
global.document = {
  createElement: () => makeNode(),
  getElementById: () => null,
  querySelector: () => null,
  addEventListener() {},
  documentElement: { lang: 'de' },
  activeElement: null,
};

const { __test } = await import('../public/pages/pantry.js');

/** Zeile mit genau den zwei Stellen, die `refreshRowQuantity` wirklich anfasst. */
function makeRow(step = 1) {
  const quantityEl = makeNode();
  const minus = makeNode();
  const stepper = makeNode();
  stepper.dataset.step = String(step);
  const row = makeNode();
  row.querySelector = (sel) => {
    if (sel === '.pantry-row__quantity') return quantityEl;
    if (sel === '[data-action="decrease"]') return minus;
    if (sel === '.pantry-stepper') return stepper;
    return null;
  };
  return { row, quantityEl, minus };
}

function rice(quantity, extra = {}) {
  return {
    id: 5, name: 'Reis', quantity, unit: 'pcs',
    min_quantity: null, expires_on: null, category: 'Sonstiges', location_id: null,
    ...extra,
  };
}

function resetPantry() {
  __test.intents.clear();
  __test.resetLoadOrderForTest();
  __test.state.items = [];
  __test.state.locations = [];
  __test.state.categories = [];
  __test.state.filter = 'all';
  __test.state.query = '';
  __test.setContainerForTest(null);
  __test.setQuantityDebounceMsForTest(null);
  delete globalThis.__apiStub;
}

/** Wartet, bis der entprellte PATCH gefeuert und abgearbeitet ist. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 25));

test('ein Schritt ueberlebt eine Auffrischung mitten im Entprell-Fenster', async () => {
  resetPantry();
  __test.state.items = [rice(2)];
  __test.setQuantityDebounceMsForTest(5);

  let patched = null;
  globalThis.__apiStub = {
    // Der Schnappschuss dieser Auffrischung ist VOR dem Schritt entstanden.
    get: async () => ({ data: [rice(2)], locations: [], categories: [] }),
    patch: async (_path, body) => { patched = body; return { data: rice(body.quantity) }; },
  };

  const { row } = makeRow();
  __test.adjustQuantity(__test.state.items[0], +1, row);
  assert.equal(__test.quantityOf(__test.state.items[0]), 3, 'optimistisch erhoeht');

  // Die Auffrischung faellt in das Fenster - vor dem PATCH.
  await __test.loadPantry();
  assert.equal(__test.quantityOf(__test.state.items[0]), 3,
    'die alte Antwort darf den Schritt nicht zuruecknehmen');

  await settled();
  assert.deepEqual(patched, { quantity: 3 }, 'der Server bekommt den gewollten Wert');
});

test('die Antwort landet im NEUEN Artikelobjekt, nicht im abgehaengten', async () => {
  resetPantry();
  __test.state.items = [rice(2)];
  __test.setQuantityDebounceMsForTest(5);

  globalThis.__apiStub = {
    get: async () => ({ data: [rice(2)], locations: [], categories: [] }),
    // Der Server antwortet mit einer ANDEREN Menge als der optimistischen (er
    // darf normalisieren oder deckeln). Daran laesst sich ablesen, WO die
    // Antwort gelandet ist: bliebe es bei der 3, haette sie das abgehaengte
    // Objekt getroffen.
    patch: async () => ({ data: rice(2.5) }),
  };

  const { row } = makeRow();
  __test.adjustQuantity(__test.state.items[0], +1, row);
  await __test.loadPantry();   // tauscht `state.items` gegen neue Objekte aus
  await settled();

  assert.equal(__test.quantityOf(__test.state.items[0]), 2.5,
    'ohne frische Aufloesung schreibt die Antwort in ein Objekt, das an nichts mehr haengt');
});

test('die PATCH-Antwort ueberschreibt keine frisch geladenen Fremdfelder', async () => {
  // Die Route antwortet mit dem VOLLEN Datensatz, und der ist ein Schnappschuss
  // vom Zeitpunkt des Schreibvorgangs. Hat jemand anderes inzwischen den Namen
  // geaendert und eine Auffrischung das gebracht, machte ein `Object.assign`
  // daraus wieder den alten Stand (Codex-Befund P2 zu PR #1072).
  resetPantry();
  __test.state.items = [rice(2)];
  __test.setQuantityDebounceMsForTest(5);

  globalThis.__apiStub = {
    // Die Auffrischung bringt den neuen Namen.
    get: async () => ({ data: [rice(2, { name: 'Basmatireis' })], locations: [], categories: [] }),
    // Die PATCH-Antwort traegt den alten.
    patch: async (_p, body) => ({ data: rice(body.quantity, { name: 'Reis' }) }),
  };

  const { row } = makeRow();
  __test.adjustQuantity(__test.state.items[0], +1, row);
  await __test.loadPantry();
  assert.equal(__test.state.items[0].name, 'Basmatireis');
  await settled();

  assert.equal(__test.quantityOf(__test.state.items[0]), 3, 'die Menge kommt aus der Antwort');
  assert.equal(__test.state.items[0].name, 'Basmatireis',
    'der frisch geladene Name darf nicht auf den Stand der Antwort zurueckfallen');
});

test('ein zweiter Schritt springt nicht am ersten, erfolgreichen vorbei zurueck', async () => {
  // Auffrischung startet bei Menge 2, Schritt 1 (2->3) wird BESTAETIGT,
  // Schritt 2 (3->4) laeuft noch, und dann trifft die alte Antwort ein. Setzte
  // sie die Ruecksprung-Grundlage auf ihre 2, landete ein Fehlschlag von
  // Schritt 2 bei 2 - obwohl der Server 3 bestaetigt hat.
  resetPantry();
  __test.state.items = [rice(2)];
  __test.setQuantityDebounceMsForTest(5);

  const toasts = [];
  global.window.yuvomi.showToast = (msg) => toasts.push(msg);
  const alt = deferred();
  let patchZaehler = 0;
  globalThis.__apiStub = {
    get: () => alt.promise,
    patch: async (_p, body) => {
      patchZaehler += 1;
      if (patchZaehler === 1) return { data: rice(body.quantity) };   // Schritt 1: Erfolg
      throw Object.assign(new Error('nope'), { data: { error: 'kaputt' } });
    },
  };

  const laden = __test.loadPantry();          // Schnappschuss: 2
  const { row } = makeRow();
  __test.adjustQuantity(__test.state.items[0], +1, row);   // 2 -> 3
  await settled();                                          // bestaetigt
  assert.equal(__test.quantityOf(__test.state.items[0]), 3);

  __test.adjustQuantity(__test.state.items[0], +1, row);   // 3 -> 4, ausstehend
  alt.resolve({ data: [rice(2)], locations: [], categories: [] });
  await laden;
  await settled();                                          // Schritt 2 scheitert

  assert.equal(__test.quantityOf(__test.state.items[0]), 3,
    'der Ruecksprung gehoert auf die bestaetigte 3, nicht auf die 2 des alten Schnappschusses');
  delete global.window.yuvomi.showToast;
});

/** Ein von Hand aufloesbares Versprechen - damit steht die Reihenfolge fest. */
function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

test('eine Antwort, die den PATCH ueberholt hat, dreht den Schritt nicht zurueck', async () => {
  resetPantry();
  __test.state.items = [rice(2)];
  __test.setQuantityDebounceMsForTest(5);

  const gate = deferred();
  globalThis.__apiStub = {
    get: () => gate.promise,
    patch: async (_p, body) => ({ data: rice(body.quantity) }),
  };

  // 1. Die Auffrischung geht los, ihr Schnappschuss zeigt noch die 2.
  const loading = __test.loadPantry();
  // 2. Der Schritt und sein PATCH laufen komplett durch.
  const { row } = makeRow();
  __test.adjustQuantity(__test.state.items[0], +1, row);
  await settled();
  assert.equal(__test.quantityOf(__test.state.items[0]), 3);
  // 3. ERST JETZT trifft die alte Antwort ein - ein Merker, der beim
  //    PATCH-Erfolg verschwaende, waere hier schon weg.
  gate.resolve({ data: [rice(2)], locations: [], categories: [] });
  await loading;

  assert.equal(__test.quantityOf(__test.state.items[0]), 3,
    'die bestaetigte Menge muss die aeltere Antwort ueberstehen');
});

test('ein spaeter begonnenes Laden raeumt den Merker - fremde Aenderungen kommen durch', async () => {
  resetPantry();
  __test.state.items = [rice(2)];
  __test.setQuantityDebounceMsForTest(5);

  globalThis.__apiStub = {
    get: async () => ({ data: [rice(9)], locations: [], categories: [] }),
    patch: async (_p, body) => ({ data: rice(body.quantity) }),
  };

  const { row } = makeRow();
  __test.adjustQuantity(__test.state.items[0], +1, row);
  await settled();
  assert.equal(__test.quantityOf(__test.state.items[0]), 3);

  // Dieses Laden beginnt NACH der Bestaetigung: jemand anderes hat den Vorrat
  // aufgefuellt. Haelt der Merker hier noch, waere der Server unwirksam.
  await __test.loadPantry();
  assert.equal(__test.quantityOf(__test.state.items[0]), 9);
  assert.equal(__test.intents.size, 0, 'kein Rest im Merker');
});

test('scheitert der PATCH, bleibt kein Merker stehen', async () => {
  resetPantry();
  __test.state.items = [rice(2)];
  __test.setQuantityDebounceMsForTest(5);

  const toasts = [];
  global.window.yuvomi.showToast = (msg) => toasts.push(msg);
  globalThis.__apiStub = {
    get: async () => ({ data: [rice(2)], locations: [], categories: [] }),
    patch: async () => { throw Object.assign(new Error('nope'), { data: { error: 'kaputt' } }); },
  };

  const { row } = makeRow();
  __test.adjustQuantity(__test.state.items[0], +1, row);
  await settled();

  assert.equal(__test.quantityOf(__test.state.items[0]), 2, 'zurueckgedreht');
  assert.equal(__test.intents.size, 0, 'ein gescheiterter Wunsch darf nichts auftragen');
  assert.equal(toasts.length, 1);
  delete global.window.yuvomi.showToast;
});

test('eine aeltere Antwort, die NACH einer juengeren landet, fasst den Stand nicht mehr an', async () => {
  // Der Fall, den `settledAt` allein nicht deckt (Codex-Befund P1 zu PR #1072).
  resetPantry();
  __test.state.items = [rice(2)];
  __test.setQuantityDebounceMsForTest(5);

  const alt = deferred();   // Schnappschuss VOR dem Schritt
  const neu = deferred();   // Schnappschuss NACH der Bestaetigung
  const gates = [alt, neu];
  globalThis.__apiStub = {
    get: () => gates.shift().promise,
    patch: async (_p, body) => ({ data: rice(body.quantity) }),
  };

  const ladenAlt = __test.loadPantry();            // beginnt zuerst
  const { row } = makeRow();
  __test.adjustQuantity(__test.state.items[0], +1, row);
  await settled();                                  // PATCH bestaetigt
  const ladenNeu = __test.loadPantry();            // beginnt danach

  neu.resolve({ data: [rice(3)], locations: [], categories: [] });
  await ladenNeu;
  assert.equal(__test.quantityOf(__test.state.items[0]), 3);
  assert.equal(__test.intents.size, 0, 'die juengere Antwort kennt den Wert, der Eintrag darf gehen');

  alt.resolve({ data: [rice(2)], locations: [], categories: [] });
  await ladenAlt;
  assert.equal(__test.quantityOf(__test.state.items[0]), 3,
    'eine ueberholte Antwort darf den bereits angewandten Stand nicht mehr ueberschreiben');
});

test('scheitert der PATCH, springt die Menge auf den FRISCHEN Serverstand zurueck', async () => {
  // Lokal 2, jemand anderes fuellt auf 5 auf, hier wird auf 3 getippt und der
  // PATCH scheitert: der Ruecksprung muss 5 treffen. Die 2 hatte der Server nie
  // - und `applyPendingQuantities` ist die letzte Stelle, die die 5 noch sieht.
  resetPantry();
  __test.state.items = [rice(2)];
  __test.setQuantityDebounceMsForTest(5);

  const toasts = [];
  global.window.yuvomi.showToast = (msg) => toasts.push(msg);
  globalThis.__apiStub = {
    get: async () => ({ data: [rice(5)], locations: [], categories: [] }),
    patch: async () => { throw Object.assign(new Error('nope'), { data: { error: 'kaputt' } }); },
  };

  const { row } = makeRow();
  __test.adjustQuantity(__test.state.items[0], +1, row);
  await __test.loadPantry();
  assert.equal(__test.quantityOf(__test.state.items[0]), 3, 'der Schritt ueberlebt die Auffrischung');

  await settled();
  assert.equal(__test.quantityOf(__test.state.items[0]), 5,
    'der Ruecksprung muss den frischen Serverstand treffen, nicht den Stand von vor dem Tippen');
  assert.equal(toasts.length, 1);
  delete global.window.yuvomi.showToast;
});

test('die Zeile zeigt die Absicht, nicht den Serverstand', async () => {
  // Die Trennung selbst: `state.items` behaelt, was der Server sagte, und die
  // Ueberlagerung liefert, was gezeigt wird - samt der davon abgeleiteten
  // Angaben. Ohne diesen Test bliebe `withIntent` ungeprueft (gemessen: das
  // Totstellen der Ueberlagerung liess alle anderen Faelle gruen).
  resetPantry();
  __test.state.items = [rice(2)];
  __test.setQuantityDebounceMsForTest(5000);   // der PATCH kommt hier nie dran

  globalThis.__apiStub = { patch: async () => ({ data: rice(3) }) };
  const { row } = makeRow();
  __test.adjustQuantity(__test.state.items[0], +1, row);

  assert.equal(__test.state.items[0].quantity, 2, 'der Serverstand bleibt unberuehrt');
  assert.equal(__test.quantityOf(__test.state.items[0]), 3, 'die Zeile zeigt die Absicht');
  const gezeigt = __test.withIntent(__test.state.items[0]);
  assert.equal(gezeigt.quantity, 3, 'und die abgeleiteten Angaben rechnen damit');
  assert.equal(__test.state.items[0].quantity, 2, 'die Ueberlagerung ist eine Kopie, kein Schreiben');
});

test('ein ueberholter, aber erfolgreicher Schritt landet im Serverstand', async () => {
  // Zwei Schritte, der erste gelingt und ist da schon ueberstimmt. Sein
  // Ergebnis gehoert trotzdem verbucht - sonst faellt ein Fehlschlag des
  // zweiten an ihm vorbei auf einen Stand zurueck, den der Server nicht hat.
  resetPantry();
  __test.state.items = [rice(2)];
  __test.setQuantityDebounceMsForTest(5);

  const tore = [deferred(), deferred()];
  let n = 0;
  globalThis.__apiStub = { get: async () => ({ data: [rice(2)], locations: [], categories: [] }),
                           patch: () => tore[n++].promise };
  const { row } = makeRow();
  __test.adjustQuantity(__test.state.items[0], +1, row);           // 2 -> 3
  await new Promise((r) => setTimeout(r, 15));                     // Timer 1 feuert
  __test.adjustQuantity(__test.state.items[0], +1, row);           // 3 -> 4, ueberstimmt
  await new Promise((r) => setTimeout(r, 15));                     // Timer 2 feuert

  tore[0].resolve({ data: rice(3) });                              // erster: Erfolg
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(__test.state.items[0].quantity, 3,
    'der bestaetigte Wert des ueberholten Schritts gehoert in den Serverstand');
  assert.equal(__test.quantityOf(__test.state.items[0]), 4, 'die Zeile zeigt weiter die 4');

  global.window.yuvomi.showToast = () => {};
  tore[1].promise.catch(() => {});
  tore[1].resolve(Promise.reject(Object.assign(new Error('nope'), { data: { error: 'kaputt' } })));
  await settled();
  assert.equal(__test.quantityOf(__test.state.items[0]), 3,
    'der Fehlschlag faellt auf die bestaetigte 3, nicht auf die 2 von vor beiden');
  delete global.window.yuvomi.showToast;
});

test('eine aeltere Auffrischung ueberschreibt keine juengere', async () => {
  // Die reine Ladeordnung, ohne Absicht im Spiel - sonst faengt die
  // Bestaetigungswache den Fall mit und die Ordnung bliebe ungeprueft.
  resetPantry();
  __test.state.items = [rice(2)];

  const alt = deferred();
  const antworten = [() => alt.promise,
                     async () => ({ data: [rice(9)], locations: [], categories: [] })];
  globalThis.__apiStub = { get: () => antworten.shift()() };

  const ladenAlt = __test.loadPantry();      // beginnt zuerst
  await __test.loadPantry();                 // beginnt danach, landet zuerst
  assert.equal(__test.state.items[0].quantity, 9);

  alt.resolve({ data: [rice(2)], locations: [], categories: [] });
  await ladenAlt;
  assert.equal(__test.state.items[0].quantity, 9,
    'die ueberholte Antwort darf den juengeren Stand nicht ersetzen');
});

// --------------------------------------------------------
// Kopfregel mobil (2026-09-26): die Chipreihe steht IM Port
// --------------------------------------------------------

// Die Filter-Chips waren eine feste Zeile zwischen Kopf und Liste und hielten
// den Port mobil bei y181 fest. Jetzt sind sie das erste Kind von #pantry-list
// und scrollen mit weg - das geht nur, wenn der Neuaufbau der Liste sie stehen
// laesst. `renderList()` laeuft bei jedem Filter, jeder Suche und jedem
// ±-Schritt; ein nacktes `replaceChildren()` warf die Reihe beim ersten Mal
// aus dem DOM, und die Filter waeren danach verschwunden.
test('renderList() laesst die Chipreihe als erstes Kind des Ports stehen', () => {
  resetPantry();
  const chipRow = makeNode();
  const list = makeNode();
  list.querySelector = (sel) => (sel === ':scope > #pantry-filters' ? chipRow : null);
  list.replaceChildren = (...kids) => { list.children = [...kids]; };
  list.children = [chipRow, makeNode(), makeNode()];
  __test.setContainerForTest({ querySelector: (sel) => (sel === '#pantry-list' ? list : null) });

  // Der Leerzustand baut Text-Knoten; der generische Knoten reicht dafuer.
  const zuvor = global.document.createTextNode;
  global.document.createTextNode = () => makeNode();
  try {
    __test.renderList();
  } finally {
    global.document.createTextNode = zuvor;
  }

  assert.equal(list.children[0], chipRow, 'die Chipreihe muss den Neuaufbau als erstes Kind ueberleben');
  assert.equal(list.children.filter((c) => c === chipRow).length, 1, 'und genau einmal');
  assert.ok(list.children.length >= 2, 'Gegenprobe: hinter der Reihe steht der neue Inhalt (hier der Leerzustand)');
});
