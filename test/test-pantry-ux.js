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
import { readFileSync } from 'node:fs';

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

// --------------------------------------------------------
// Nebenpanel „Braucht Aufmerksamkeit" (Re-Critique 2026-09-27, A4 P1 / R10 L4)
// --------------------------------------------------------

// Am Desktop standen die Lagerort-Gruppen auf 252-972, rechts 436px leer. Das
// Panel fuellt die Flaeche mit den drei Fragen der Filterchips - und muss
// dieselbe Zuordnung sprechen, sonst stuende ein Artikel im Panel unter
// „Fast leer", den der gleichnamige Chip nicht findet.
const WATCH_TODAY = '2026-09-27';
const watchItems = () => [
  rice(5, { id: 1, name: 'Reis' }),                                                  // ruhig
  rice(1, { id: 2, name: 'Milch', expires_on: '2026-09-25', location_name: 'fridge' }), // abgelaufen
  rice(1, { id: 3, name: 'Joghurt', expires_on: '2026-09-29' }),                       // bald
  rice(1, { id: 4, name: 'Eier', expires_on: '2026-09-28' }),                          // bald, frueher
  rice(1, { id: 5, name: 'Mehl', min_quantity: 2 }),                                   // fast leer
  rice(0, { id: 6, name: 'Zucker' }),                                                  // leer
];

// NUR ZEITKRITISCHES (Re-Critique 2026-09-28, P7 / A4 P2-6): "Fast leer"
// stand dreifach da - Zeilen-Badge, Chip mit Zaehler und hier; 14 von 21
// Artikeln standen rechts ein zweites Mal. Die Frist ist die Frage, die nicht
// warten kann; "Fast leer" bleibt Chip und Warenkorb an der Zeile.
test('das Panel ordnet wie die Filterchips, aber nur, was eine Frist hat: abgelaufen, bald', async () => {
  resetPantry();
  assert.equal(typeof __test.pantryWatchGroups, 'function', 'pantryWatchGroups fehlt im __test-Export');
  const { matchesPantryFilter } = await import('../public/utils/pantry-status.js');
  const groups = __test.pantryWatchGroups(watchItems(), WATCH_TODAY);
  assert.deepEqual(groups.map((g) => [g.key, g.items.map((i) => i.name)]), [
    ['expired', ['Milch']],
    ['soon', ['Eier', 'Joghurt']],
  ]);
  for (const g of groups) {
    const chip = watchItems().filter((i) => matchesPantryFilter(i, g.key, WATCH_TODAY)).map((i) => i.id).sort();
    assert.deepEqual(g.items.map((i) => i.id).sort(), chip, `${g.key}: Panel und Chip meinen dieselben Artikel`);
  }
  assert.deepEqual(__test.pantryWatchGroups([rice(5)], WATCH_TODAY), [], 'nichts faellig heisst keine Abschnitte');
});

test('renderList zeichnet das Panel mit - unabhaengig von Suche und aktivem Filter', () => {
  resetPantry();
  const list = makeNode();
  list.replaceChildren = (...kids) => { list.children = [...kids]; };
  const watch = makeNode();
  watch.hidden = true;
  __test.setContainerForTest({
    querySelector: (sel) => (sel === '#pantry-list' ? list : sel === '#pantry-watch' ? watch : null),
  });
  __test.state.todayKey = WATCH_TODAY;
  __test.state.items = watchItems();
  __test.state.filter = 'low';
  __test.state.query = 'mehl';
  const zuvor = global.document.createTextNode;
  global.document.createTextNode = () => makeNode();
  try {
    __test.renderList();
  } finally {
    global.document.createTextNode = zuvor;
  }
  assert.equal(watch.hidden, false, 'mit Artikeln steht das Panel');
  assert.equal(watch.children.length, 2, 'zwei Abschnitte (abgelaufen, bald), obwohl die Liste nur „Mehl" unter „Fast leer" zeigt');
  // Ohne jeden Artikel: kein Panel (der Leerzustand der Liste spricht).
  __test.state.items = [];
  __test.renderWatch();
  assert.equal(watch.hidden, true);
  // Artikel, aber nichts faellig: ein ruhiger Satz statt eines leeren Kastens.
  __test.state.items = [rice(5)];
  __test.renderWatch();
  assert.equal(watch.hidden, false);
  assert.equal(watch.children.length, 1);
  assert.equal(watch.children[0].textContent, 'pantry.watchEmpty');
});

test('das Panel steht nur ab 60rem Vorratsflaeche, und die Liste fuellt die Spalte bis zu ihm', async () => {
  const { eachRule } = await import('./css-rules.js');
  const css = readFileSync(new URL('../public/styles/pantry.css', import.meta.url), 'utf8');
  const rules = [...eachRule(css)];
  assert.ok(rules.some((r) => r.selector.trim() === '.pantry-page' && /container:\s*pantry-surface\s*\/\s*inline-size/.test(r.body)),
    'die Seite ist der Container - die Abfrage misst die Vorratsflaeche, nicht den Viewport');
  const base = rules.find((r) => r.selector.trim() === '.pantry-watch' && !r.at.length);
  assert.match(base?.body ?? '', /display:\s*none/, 'unter der Schwelle tragen die Chips die Frage');
  const wide = (sel) => rules.find((r) => r.selector.trim() === sel && r.at.includes('@container pantry-surface (min-width: 60rem)'));
  assert.match(wide('.pantry-watch:not([hidden])')?.body ?? '', /display:\s*grid/);
  assert.match(wide('.pantry-watch:not([hidden])')?.body ?? '', /overflow-y:\s*auto/, 'ein langes Panel scrollt fuer sich');
  assert.match(wide('.pantry-body')?.body ?? '', /flex-direction:\s*row/);
  assert.match(wide('.pantry-body > .pantry-list')?.body ?? '', /--page-measure:\s*100%/,
    'die Gruppen kappen auf die Spalte, ueber dieselbe Variable wie ueberall');
  const src = readFileSync(new URL('../public/pages/pantry.js', import.meta.url), 'utf8');
  assert.match(src, /body\.append\(list, watch\)/, 'Liste und Panel teilen den Koerper');
  assert.match(src, /watch\.addEventListener\('click', onWatchClick\)/, 'eine Panelzeile oeffnet ihren Artikel');
});

// Codex P2 zu R10 L4: das Panel zeichnete aus `withIntent`, der Klick holte den
// Artikel aber aus dem nackten Serverstand. Stepper-Schritt, Zeile im Panel
// oeffnen, anderes Feld speichern - und der PUT schrieb die alte Menge zurueck.
// Gemessen am Feld, das der Dialog wirklich fuellt, fuer BEIDE Einstiege.
test('der Bearbeiten-Dialog zeigt die Menge eines noch entprellten Schritts - aus Panel und Liste', () => {
  resetPantry();
  __test.state.items = [rice(1, { id: 2, name: 'Milch' })];
  __test.intents.set(2, { quantity: 4, seq: 1, timer: null, flush: () => {} });

  const fieldsOf = (open) => {
    const fields = {};
    const panel = {
      querySelector: (sel) => {
        fields[sel] ??= { value: '', addEventListener() {} };
        return fields[sel];
      },
    };
    open.onSave(panel);
    return fields;
  };
  const opened = [];
  globalThis.__openModal = (opts) => { opened.push(opts); };
  try {
    const watchBtn = { dataset: { watchId: '2' } };
    __test.onWatchClick({ target: { closest: (sel) => (sel === '[data-watch-id]' ? watchBtn : null) } });
    assert.equal(opened.length, 1, 'die Panelzeile oeffnet den Dialog');
    assert.equal(fieldsOf(opened[0])['#pantry-quantity'].value, '4', 'Panel: die Menge der Absicht, nicht der Serverstand 1');

    const row = { dataset: { id: '2' } };
    const editBtn = { dataset: { action: 'edit' }, closest: (sel) => (sel === '.pantry-row[data-id]' ? row : null) };
    __test.onListClick({ target: { closest: (sel) => (sel === '[data-action]' ? editBtn : null) } });
    assert.equal(opened.length, 2, 'die Listenzeile oeffnet den Dialog');
    assert.equal(fieldsOf(opened[1])['#pantry-quantity'].value, '4', 'Liste: dieselbe Menge wie die Zeile');

    // Gegenprobe ohne Absicht: der Serverstand.
    __test.intents.clear();
    __test.onWatchClick({ target: { closest: (sel) => (sel === '[data-watch-id]' ? watchBtn : null) } });
    assert.equal(fieldsOf(opened[2])['#pantry-quantity'].value, '1');
  } finally {
    delete globalThis.__openModal;
    resetPantry();
  }
});

// Re-Critique 2026-09-28 (P7 / A4 P3-11): im 364px-Sheet passte
// `minmax(11rem, 1fr)` nie zweispaltig - "1,5" und "kg" belegten je eine volle
// Zeile, der Koerper lief 1053px bei 591px sichtbar.
test('Vorrats-Sheet: Menge und Einheit stehen mobil nebeneinander', async () => {
  const { eachRule } = await import('./css-rules.js');
  const css = readFileSync(new URL('../public/styles/pantry.css', import.meta.url), 'utf8');
  const row = [...eachRule(css)].find((r) => r.selector.trim() === '.pantry-form-row' && !r.at.length);
  const min = /minmax\((\d+(?:\.\d+)?)rem,\s*1fr\)/.exec(row?.body ?? '');
  assert.ok(min, 'die Zeile bleibt ein auto-fit-Raster mit rem-Untergrenze');
  // Sheet 364px, Innenabstand 2x16, Luecke 12: zwei Spalten brauchen 2*min*16 + 12 <= 332.
  assert.ok(2 * Number(min[1]) * 16 + 12 <= 332, `minmax(${min[1]}rem) passt im 364px-Sheet nicht zweispaltig`);
});
