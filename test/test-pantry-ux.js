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

/** Generischer Knoten: genug fuer `rowEl`, das die Zeile wirklich neu baut.
 *  Attribute und eingesetztes HTML werden mitgeschrieben, damit die Produktzeile
 *  (#1448) an `aria-expanded`, `aria-controls` und ihrem Winkel pruefbar ist. */
function makeNode() {
  const attrs = new Map();
  const node = {
    style: {}, dataset: {}, children: [], html: '',
    className: '', textContent: '', type: '', hidden: false, disabled: false,
    isConnected: true,
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(name, value) { attrs.set(name, String(value)); },
    removeAttribute(name) { attrs.delete(name); },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    appendChild(child) { node.children.push(child); return child; },
    append(...kids) { node.children.push(...kids); },
    prepend(...kids) { node.children.unshift(...kids); },
    replaceChildren() { node.children = []; },
    replaceWith() {},
    insertAdjacentHTML(_where, html) { node.html += html; },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() {},
  };
  return node;
}

global.window = { matchMedia: () => ({ matches: false }), addEventListener() {}, yuvomi: {} };
// maybeShowSwipeHint() (utils/swipe-row.js) liest den Pfad: seit R16 2b traegt
// auch die Vorratsliste den Wisch, also braucht das Mini-DOM eine Adresse.
global.location = { pathname: '/pantry' };
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
// R24 E2: keine Seitenspalte, der Status steht in der Metazeile
// --------------------------------------------------------

// Critique 2026-10-26 (G3-Vorrat-P2-1): "Laeuft bald ab" stand dreifach da -
// Chip mit Zaehler, Nebenpanel mit denselben Artikeln, Etikett an der Zeile.
// E2 (Ulas 28.10.): Kennzahlen nicht als Spalte; die Chips tragen die Zahl.
test('R24 E2: der Vorrat hat keine Seitenspalte mehr - weder Markup noch Regel', async () => {
  const { eachRule } = await import('./css-rules.js');
  const css = readFileSync(new URL('../public/styles/pantry.css', import.meta.url), 'utf8');
  const rules = [...eachRule(css)];
  assert.ok(!rules.some((r) => /pantry-watch/.test(r.selector)), 'keine Regel fuer ein Nebenpanel');
  assert.ok(!rules.some((r) => r.at.some?.((at) => /pantry-surface/.test(at)) || /pantry-surface/.test(String(r.at))),
    'keine Container-Abfrage, die Liste und Spalte nebeneinander stellt');
  const src = readFileSync(new URL('../public/pages/pantry.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /pantry-watch|renderWatch|onWatchClick/, 'kein Panel im Code');
  assert.match(src, /body\.append\(list\)/, 'der Koerper traegt nur die Liste');
});

// Am Telefon stand der Status mal neben, mal unter dem Namen, am Desktop frei
// schwebend - jetzt immer nach der Menge in der Metazeile.
test('R24: der Status steht in der Metazeile nach der Menge, nicht neben dem Namen', () => {
  resetPantry();
  __test.state.todayKey = '2026-09-27';
  const item = rice(1, { id: 7, name: 'Vollmilch', expires_on: '2026-09-29', min_quantity: 2, location_name: 'fridge' });
  const wrap = __test.rowEl(item, { batch: false, total: null });
  const li = byClass(wrap, 'pantry-row')[0] ?? wrap;
  const headline = byClass(li, 'pantry-row__headline')[0];
  assert.equal(byClass(headline, 'pantry-badge').length, 0, 'kein Etikett neben dem Namen');
  const meta = byClass(li, 'pantry-row__meta')[0];
  const kids = meta.children.map((c) => c.className);
  assert.equal(kids[0], 'pantry-row__quantity', 'die Menge fuehrt');
  assert.equal(kids[1], 'pantry-row__badges', 'der Status folgt ihr');
  assert.equal(kids[2], 'pantry-row__where', 'MHD und Ort danach, als ein Knoten');
  assert.deepEqual(byClass(meta, 'pantry-badge').map(textOf), ['pantry.badgeExpiresDays{"count":2}', 'pantry.badgeLow']);
  const where = meta.children[2];
  assert.equal(where.children[0].className, 'pantry-row__lead-sep', 'der Trenner vor dem MHD ist ein eigener Knoten');
  assert.ok(!where.children[1].textContent.startsWith(' · '), 'das MHD beginnt nicht mit dem Trenner');
});

test('R24: am Telefon rueckt bei einem Status die zweite Haelfte in eine eigene Zeile, das MHD bleibt', async () => {
  const { eachRule } = await import('./css-rules.js');
  const css = readFileSync(new URL('../public/styles/pantry.css', import.meta.url), 'utf8');
  const rules = [...eachRule(css)];
  const narrow = (sel) => rules.find((r) => r.selector.trim() === sel && String(r.at).includes('list-rows (max-width: 26rem)'));
  assert.match(narrow('.pantry-row__meta:has(.pantry-badge) > .pantry-row__where')?.body ?? '', /display:\s*block/);
  assert.match(narrow('.pantry-row__meta:has(.pantry-badge) > .pantry-row__where > .pantry-row__lead-sep')?.body ?? '', /display:\s*none/);
  assert.ok(!rules.some((r) => /pantry-row__expiry/.test(r.selector) && /display:\s*none/.test(r.body)),
    'das MHD wird nirgends mehr weggelassen');
});

// Codex P2 zu R10 L4: das Panel zeichnete aus `withIntent`, der Klick holte den
// Artikel aber aus dem nackten Serverstand. Stepper-Schritt, Zeile im Panel
// oeffnen, anderes Feld speichern - und der PUT schrieb die alte Menge zurueck.
// Gemessen am Feld, das der Dialog wirklich fuellt, fuer BEIDE Einstiege.
test('der Bearbeiten-Dialog zeigt die Menge eines noch entprellten Schritts', () => {
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
    const row = { dataset: { id: '2' } };
    const editBtn = { dataset: { action: 'edit' }, closest: (sel) => (sel === '.pantry-row[data-id]' ? row : null) };
    __test.onListClick({ target: { closest: (sel) => (sel === '[data-action]' ? editBtn : null) } });
    assert.equal(opened.length, 1, 'die Listenzeile oeffnet den Dialog');
    assert.equal(fieldsOf(opened[0])['#pantry-quantity'].value, '4', 'die Menge der Absicht, nicht der Serverstand 1');

    // Gegenprobe ohne Absicht: der Serverstand.
    __test.intents.clear();
    __test.onListClick({ target: { closest: (sel) => (sel === '[data-action]' ? editBtn : null) } });
    assert.equal(fieldsOf(opened[1])['#pantry-quantity'].value, '1');
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
  // Seit R17 (E6) steht die Zeile geteilt in layout.css (`.form-pair`); die
  // Untergrenze ist der Rueckfallwert der Variable, die `--wide` anhebt.
  const css = readFileSync(new URL('../public/styles/layout.css', import.meta.url), 'utf8');
  const row = [...eachRule(css)].find((r) => r.selector.trim() === '.form-pair' && !r.at.length);
  const min = /minmax\(var\(--form-pair-min,\s*(\d+(?:\.\d+)?)rem\),\s*1fr\)/.exec(row?.body ?? '');
  const page = readFileSync(new URL('../public/pages/pantry.js', import.meta.url), 'utf8');
  assert.match(page, /<div class="form-pair">/, 'das Vorrats-Formular nutzt die geteilte Zeile');
  assert.ok(min, 'die Zeile bleibt ein auto-fit-Raster mit rem-Untergrenze');
  // Sheet 364px, Innenabstand 2x16, Luecke 12: zwei Spalten brauchen 2*min*16 + 12 <= 332.
  assert.ok(2 * Number(min[1]) * 16 + 12 <= 332, `minmax(${min[1]}rem) passt im 364px-Sheet nicht zweispaltig`);
});


/* R16 Schritt 2b (Critique 2026-10-05, Kuechenregel in DESIGN.md): der Vorrat
 * war der letzte Kuechen-Reiter ohne Loesch-Wisch. Gegen den Stand davor rot
 * gelaufen (rowEl lieferte die nackte Zeile, wirePantrySwipe fehlte). */
test('R16: die Vorratszeile liegt auf einer Wisch-Buehne - Zeilenende loescht, Stepper und Warenkorb sind Ausnahmezone', () => {
  resetPantry();
  const wrap = __test.rowEl({ id: 7, name: 'Reis', quantity: 2, unit: 'kg' });
  assert.match(wrap.className, /\bswipe-row\b/, 'das Listenelement ist die Buehne');
  assert.equal(wrap.dataset.swipeId, '7');
  const row = wrap.children.at(-1);
  assert.match(row.className, /\blist-row pantry-row\b/, 'die Zeile liegt als letztes Kind in der Buehne');
  assert.equal(row.dataset.id, '7', 'die Zeile behaelt ihre id - Klick, Stepper und Auffrischung suchen sie dort');

  assert.equal(typeof __test.wirePantrySwipe, 'function');
  const optionen = __test.wirePantrySwipe(makeNode());
  assert.equal(optionen.card, '.pantry-row');
  assert.equal(optionen.leading, undefined, 'nur eine Seite: am Zeilenanfang gibt es nichts zu erledigen');
  assert.equal(optionen.trailing.reveal, '.swipe-reveal--delete');
  assert.notEqual(optionen.trailing.flyOut, true, 'die Karte federt zurueck - removeItem() blendet aus und holt sie beim Undo wieder');
  for (const zone of ['.pantry-stepper', '.pantry-row__cart']) {
    assert.ok(optionen.ignore.split(',').map((s) => s.trim()).includes(zone), `${zone} ist Ausnahmezone`);
  }
  const src = readFileSync(new URL('../public/pages/pantry.js', import.meta.url), 'utf8');
  assert.match(src, /wrap\.insertAdjacentHTML\('beforeend', `\s*<div class="swipe-reveal swipe-reveal--delete swipe-reveal--trailing" aria-hidden="true">/);
  assert.match(src, /wirePantrySwipe\(list\);/, 'renderList verdrahtet die Geste nach jedem Aufbau');
  assert.match(src, /inner\?\.closest\('\.swipe-row'\) \?\? inner/, 'ausgeblendet wird die Buehne, nicht nur die Zeile darin');
});

test('R16: ein Werkzeugmenue mit einem einzigen Eintrag ist ein direkter Knopf', async () => {
  const { pageToolsMenuHtml } = await import('../public/utils/popover-menu.js');
  const einer = pageToolsMenuHtml({ id: 'x-menu', label: 'Mehr', items: [{ action: 'manage-locations', label: 'Lagerorte verwalten', icon: 'map-pin' }] });
  assert.match(einer, /<button type="button" class="btn btn--secondary btn--icon page-tools-btn page-tools-btn--direct"\s+data-action="manage-locations"\s+aria-label="Lagerorte verwalten" title="Lagerorte verwalten">/);
  assert.match(einer, /data-lucide="map-pin"/, 'das Icon der Handlung, kein Auslassungszeichen');
  assert.doesNotMatch(einer, /popovertarget|role="menu"|ellipsis/, 'kein Menue, kein Popover');
  const zwei = pageToolsMenuHtml({ id: 'x-menu', label: 'Mehr', items: [
    { action: 'a', label: 'A', icon: 'tag' }, { separator: true }, { action: 'b', label: 'B', icon: 'tag' }] });
  assert.match(zwei, /popovertarget="x-menu"[\s\S]*role="menu"/, 'ab zwei Eintraegen das Menue');
  const schalter = pageToolsMenuHtml({ id: 'x-menu', label: 'Mehr', items: [{ action: 'a', label: 'A', icon: 'tag', checked: true }] });
  assert.match(schalter, /role="menuitemcheckbox"/, 'ein Schalter bleibt im Menue - sein Zustand braucht den Haken');
});

// Critique 2026-10-16: zwei beringte 48px-Kreise je Zeile machten den Stepper
// zum lautesten Element der Vorratsliste. Er traegt die Haut der Zeilenaktion
// (keine Kante, keine Flaeche in Ruhe), die Trefferflaeche bleibt.
test('Vorrat: der Mengen-Stepper ist ruhig wie die Zeilenaktion, Trefferflaeche unveraendert (Critique 2026-10-16)', async () => {
  const { eachRule } = await import('./css-rules.js');
  const css = readFileSync(new URL('../public/styles/pantry.css', import.meta.url), 'utf8');
  const btn = [...eachRule(css)].find((r) => !r.at.length && r.selector.trim() === '.pantry-stepper__btn');
  assert.match(btn?.body ?? '', /border:\s*none/, 'kein Ring');
  assert.match(btn?.body ?? '', /background-color:\s*transparent/, 'keine Flaeche in Ruhe');
  assert.match(btn?.body ?? '', /width:\s*var\(--pantry-step-btn\);\s*height:\s*var\(--pantry-step-btn\)/, 'Trefferflaeche bleibt');
  assert.ok([...eachRule(css)].some((r) => r.at.some((a) => /hover:\s*none/.test(a)) && /--pantry-step-btn:\s*var\(--target-base\)/.test(r.body)),
    'am Finger weiter das Fingermass');
});

// R20 (Re-Critique 2026-10-17 a2 P3): "Vorrat -/+ als 12px-Glyphe in 48px".
test('Vorrat: die Stepper-Zeichen haben Knopfmass (--icon-md), keine Inline-Marker', () => {
  const src = readFileSync(new URL('../public/pages/pantry.js', import.meta.url), 'utf8');
  assert.match(src, /data-lucide="minus" class="icon-md"/);
  assert.match(src, /data-lucide="plus" class="icon-md"/);
  assert.doesNotMatch(src, /data-lucide="(minus|plus)" class="icon-sm"/);
});

// #1997: kommt die Antwort auf "Speichern" erst, nachdem der Nutzer den Dialog
// geschlossen und einen anderen geoeffnet hat, darf das force-Schliessen nur
// den eigenen treffen. Ob der Slot noch denselben Dialog haelt, entscheidet
// closeModal({ context }) in components/modal.js (test-modal-dead-time.js);
// hier zaehlt die Verdrahtung: der echte Klick auf Speichern reicht den
// Kontext von VOR der Anfrage hinein - beim Anlegen wie beim Aendern.
test('#1997: Artikel speichern - eine spaete Antwort schliesst nur mit dem Kontext von VOR der Anfrage', async () => {
  for (const [name, mode, item] of [['anlegen', 'create', null], ['aendern', 'edit', rice(2)]]) {
    resetPantry();
    __test.state.items = item ? [item] : [];
    __test.setContainerForTest(makeNode());
    let kontext = 'eigener-dialog';
    const geschlossen = [];
    const toasts = [];
    const klicks = {};
    const felder = {};
    const panel = {
      querySelector: (sel) => {
        felder[sel] ??= { value: '', addEventListener(typ, fn) { klicks[sel] = fn; } };
        return felder[sel];
      },
      querySelectorAll: () => [],
    };
    let optionen = null;
    globalThis.__openModal = (opts) => { optionen = opts; };
    globalThis.__modalContextId = () => kontext;
    globalThis.__closeModal = (opts) => { geschlossen.push(opts ?? {}); return true; };
    global.window.yuvomi.showToast = (msg, art) => toasts.push([msg, art]);
    const schreibe = async () => { kontext = 'ein-anderer-dialog'; return { data: rice(3, { name: 'Reis' }) }; };
    globalThis.__apiStub = { post: schreibe, put: schreibe, get: async () => ({ data: [rice(3)], locations: [], categories: [] }) };
    try {
      __test.openItemModal(mode, item);
      optionen.onSave(panel);
      felder['#pantry-name'].value = 'Reis';
      await klicks['#pantry-save']();
      assert.equal(geschlossen.length, 1, `${name}: genau ein Schliessen (${JSON.stringify(geschlossen)})`);
      assert.equal(geschlossen[0].force, true, `${name}: force wie bisher`);
      assert.equal(geschlossen[0].context, 'eigener-dialog',
        `${name}: geschlossen wird ohne den Kontext von vor der Anfrage - die spaete Antwort traefe den Dialog, der jetzt offen ist`);
      assert.equal(toasts.some(([, art]) => art === 'danger'), false, `${name}: der Erfolg ist kein Fehler (${JSON.stringify(toasts)})`);
    } finally {
      delete globalThis.__openModal;
      delete globalThis.__modalContextId;
      delete globalThis.__closeModal;
      delete global.window.yuvomi.showToast;
      resetPantry();
    }
  }
});

// --------------------------------------------------------
// #1448 Schritt 2: Produkte ueber den Chargen
// --------------------------------------------------------

/** Every node of a built tree, depth first (strings from `append` are skipped). */
function nodesOf(node) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    out.push(n);
    for (const kid of n.children ?? []) walk(kid);
  };
  walk(node);
  return out;
}
const hasClass = (n, cls) => String(n.className ?? '').split(/\s+/).includes(cls);
const byClass = (root, cls) => nodesOf(root).filter((n) => hasClass(n, cls));
/** The text a tree shows: textContent of the leaves plus strings appended. */
function textOf(node) {
  if (typeof node === 'string') return node;
  return (node.textContent ?? '') + (node.children ?? []).map(textOf).join('');
}

const CATS = [
  { name: 'Milchprodukte', icon: 'milk', sort_order: 0 },
  { name: 'Haushalt', icon: 'spray-can', sort_order: 1 },
  { name: 'Sonstiges', icon: 'tag', sort_order: 2 },
];
const LOCS = [{ id: 1, name: 'Garage' }, { id: 2, name: 'Dachboden' }, { id: 3, name: 'Speisekammer' }];
const batch = (id, productId, extra) => ({
  id, product_id: productId, quantity: 1, unit: 'pcs', min_quantity: null, expires_on: null,
  category: 'Sonstiges', location_id: null, location_name: null, notes: null, ...extra,
});

/** Milk in two places (one batch expired), passata twice in one place, butter once, toothpaste with none. */
function groupedPantry() {
  resetPantry();
  __test.expandedProducts.clear();
  __test.state.categories = CATS;
  __test.state.locations = LOCS;
  __test.state.todayKey = '2026-10-19';
  __test.state.products = [
    { id: 10, name: 'Milch', unit: 'l', category: 'Milchprodukte', batch_count: 2 },
    { id: 11, name: 'Passata', unit: 'can', category: 'Sonstiges', batch_count: 2 },
    { id: 12, name: 'Butter', unit: 'pcs', category: 'Milchprodukte', batch_count: 1 },
    { id: 13, name: 'Zahnpasta', unit: 'pcs', category: 'Haushalt', batch_count: 0 },
  ];
  __test.state.items = [
    batch(1, 10, { name: 'Milch', unit: 'l', quantity: 2, category: 'Milchprodukte', location_id: 2, location_name: 'Dachboden', expires_on: '2026-10-28' }),
    batch(2, 10, { name: 'Milch', unit: 'l', quantity: 1, category: 'Milchprodukte', location_id: 1, location_name: 'Garage', expires_on: '2026-10-18', min_quantity: 1 }),
    batch(3, 11, { name: 'Passata', unit: 'can', quantity: 2, location_id: 3, location_name: 'Speisekammer', expires_on: '2026-11-08' }),
    batch(4, 11, { name: 'Passata', unit: 'can', quantity: 4, location_id: 3, location_name: 'Speisekammer', expires_on: '2027-08-15' }),
    batch(5, 12, { name: 'Butter', category: 'Milchprodukte', location_id: 1, location_name: 'Garage' }),
  ];
}

test('#1448: ohne Filter gliedert die Liste nach Kategorie, darin nach Produkt; Chargen nach Ort und MHD', () => {
  groupedPantry();
  const sections = __test.productSections(__test.state.items);
  assert.deepEqual(sections.map((s) => s.key), ['Milchprodukte', 'Haushalt', 'Sonstiges'],
    'Reihenfolge der Einkaufs-Kategorien (sort_order), nicht alphabetisch');
  assert.deepEqual(sections.map((s) => s.products.map((p) => p.name)),
    [['Butter', 'Milch'], ['Zahnpasta'], ['Passata']], 'Produkte nach Namen');
  const milk = sections[0].products[1];
  assert.deepEqual(milk.batches.map((b) => b.id), [2, 1], 'Garage vor Dachboden: die Reihenfolge der Lagerorte');
  const passata = sections[2].products[0];
  assert.deepEqual(passata.batches.map((b) => b.id), [3, 4], 'ein Ort: das fruehere MHD zuerst');
  assert.equal(sections[1].products[0].batches.length, 0, 'das Produkt ohne Charge steht in seiner Kategorie');

  // Gegenprobe: eine Kategorie ohne Produkt bildet keinen Abschnitt, und ein
  // Produkt ohne Kategorie landet unter "Sonstiges".
  __test.state.products = __test.state.products.filter((p) => p.id !== 13);
  __test.state.products[0] = { ...__test.state.products[0], category: '' };
  for (const item of __test.state.items) if (item.product_id === 10) item.category = null;
  const again = __test.productSections(__test.state.items);
  assert.deepEqual(again.map((s) => s.key), ['Milchprodukte', 'Sonstiges']);
  assert.deepEqual(again[1].products.map((p) => p.name), ['Milch', 'Passata']);
});

test('#1448: die Suche zeigt ein Produkt ganz - ueber den Ort gefunden aufgeklappt, ueber den Namen nicht', () => {
  groupedPantry();
  __test.state.query = 'dachboden';
  // visibleItems() liefert nur die Charge im Keller; das Produkt kommt ganz.
  const matching = __test.state.items.filter((i) => i.location_name === 'Dachboden');
  const sections = __test.productSections(matching);
  assert.deepEqual(sections.flatMap((s) => s.products.map((p) => p.name)), ['Milch'], 'kein leeres Produkt ohne Namenstreffer');
  const milk = sections[0].products[0];
  assert.equal(milk.batches.length, 2, 'beide Chargen, auch die in der Garage');
  assert.equal(milk.openForSearch, true, 'ueber eine Charge gefunden: aufgeklappt, sonst saehe man den Treffer nicht');

  __test.state.query = 'milch';
  const byName = __test.productSections(__test.state.items.filter((i) => i.name === 'Milch'));
  assert.equal(byName[0].products[0].openForSearch, false, 'Namenstreffer: so zu, wie gemerkt');

  __test.state.query = 'zahn';
  const empty = __test.productSections([]);
  assert.deepEqual(empty.flatMap((s) => s.products.map((p) => p.name)), ['Zahnpasta'], 'das leere Produkt findet sein Name');
});

test('#1448: ein Produkt mit EINER Charge ist die heutige Zeile, mit ihrem Ort in der Meta-Zeile', () => {
  groupedPantry();
  const butter = __test.productSections(__test.state.items)[0].products[0];
  const el = __test.productEl(butter);
  assert.match(el.className, /\bswipe-row\b/, 'die Wisch-Buehne der heutigen Zeile');
  const row = el.children.at(-1);
  assert.match(row.className, /^list-row pantry-row$/, 'keine Chargen-Zeile');
  assert.equal(byClass(el, 'pantry-stepper').length, 1, 'mit Stepper');
  assert.equal(textOf(byClass(el, 'list-row__name')[0]), 'Butter');
  assert.match(textOf(byClass(el, 'pantry-row__place')[0]), /Garage/, 'der Ort steht in der Zeile');
  assert.equal(byClass(el, 'pantry-row__total').length, 0, 'keine Summe bei einer Charge');
  assert.equal(byClass(el, 'pantry-product__toggle').length, 0, 'und kein Aufklappen');
});

test('#1448: mehrere Chargen - eine Produktzeile mit Summe, zugeklappt, die Chargen darunter als heutige Zeilen', () => {
  groupedPantry();
  const milk = __test.productSections(__test.state.items)[0].products[1];
  const el = __test.productEl(milk);
  assert.match(el.className, /\bpantry-product\b/);
  const [toggle] = byClass(el, 'pantry-product__toggle');
  assert.equal(toggle.type, 'button', 'ein Knopf: Enter und Leertaste kommen vom Element');
  assert.equal(toggle.dataset.action, 'toggle-product');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'zugeklappt');
  const [region] = byClass(el, 'pantry-batches');
  assert.equal(toggle.getAttribute('aria-controls'), region.id);
  assert.equal(region.hidden, true);
  assert.match(toggle.html, /list-group__chevron list-group__chevron--collapsed/, 'der Winkel der Gruppenkoepfe, zugeklappt');

  const total = textOf(byClass(el, 'pantry-product__total')[0]);
  assert.match(total, /^pantry\.productTotal/, 'die Summe als eigener Satz');
  assert.match(total, /"quantity":"3 /, '2 l + 1 l');
  assert.match(textOf(byClass(el, 'pantry-product__where')[0]), /pantry\.productPlaces\{"count":2\}/, 'zwei Orte');

  // Die Produktzeile hat in Schritt 2 keine Bedienung: kein Stepper, kein Warenkorb, kein Wisch.
  const head = el.children[0];
  for (const cls of ['pantry-stepper', 'pantry-row__cart', 'swipe-row', 'swipe-reveal']) {
    assert.equal(byClass(head, cls).length, 0, `kein ${cls} an der Produktzeile`);
  }
  assert.doesNotMatch(el.className, /swipe-row/);

  const rows = region.children;
  assert.equal(rows.length, 2);
  for (const wrap of rows) {
    assert.match(wrap.className, /\bswipe-row\b/, 'jede Charge ist die heutige Zeile mit Wisch');
    const row = wrap.children.at(-1);
    assert.match(row.className, /\bpantry-row--batch\b/);
    assert.equal(byClass(wrap, 'pantry-stepper').length, 1, 'mit Stepper');
  }
  const first = rows[0];
  assert.equal(textOf(byClass(first, 'list-row__name')[0]), 'Milch: Garage', 'benannt nach dem Ort, der Produktname fuer Screenreader');
  assert.equal(byClass(first, 'pantry-row__cart').length, 1, 'die abgelaufene, knappe Charge behaelt ihren Warenkorb');
  assert.match(textOf(byClass(first, 'pantry-row__date')[0]), /2026/, 'das MHD bleibt an der Charge stehen');
  assert.equal(byClass(first, 'pantry-row__expiry').length, 0, 'nicht als der Knoten, den die schmale Zeile weglaesst');
  const plus = nodesOf(first).find((n) => n.dataset?.action === 'increase');
  assert.match(plus.getAttribute('aria-label'), /Milch, Garage$/, 'der Knopf nennt Produkt und Ort');

  // Ein Ort, zwei Chargen: "2 Chargen" statt "2 Orte".
  const passata = __test.productSections(__test.state.items)[2].products[0];
  assert.match(textOf(byClass(__test.productEl(passata), 'pantry-product__where')[0]), /pantry\.productBatches\{"count":2\}.*Speisekammer/);
});

test('#1448: alle Chargen an EINEM Ort heissen nach ihrem MHD, an verschiedenen Orten nach dem Ort', () => {
  groupedPantry();
  // Passata: beide in der Speisekammer, eine dritte Charge ohne MHD dazu.
  __test.state.items.push(batch(6, 11, { name: 'Passata', unit: 'can', quantity: 1, location_id: 3, location_name: 'Speisekammer' }));
  const passata = __test.productSections(__test.state.items)[2].products[0];
  const el = __test.productEl(passata);
  assert.match(textOf(byClass(el, 'pantry-product__where')[0]), /Speisekammer/, 'der Ort steht einmal, in der Produktzeile');
  const rows = byClass(el, 'pantry-batches')[0].children;
  const titles = rows.map((wrap) => textOf(byClass(wrap, 'list-row__name')[0]));
  assert.deepEqual(titles, [
    'Passata: pantry.bestBefore{"date":"2026-11-08"}',
    'Passata: pantry.bestBefore{"date":"2027-08-15"}',
    'Passata: pantry.noBestBefore',
  ], 'nach Datum benannt, ohne Datum ausdruecklich; der Ort wiederholt sich nicht');
  for (const wrap of rows) {
    assert.equal(byClass(wrap, 'pantry-row__date').length + byClass(wrap, 'pantry-row__expiry').length, 0,
      'das Datum steht im Titel, nicht noch einmal in der Meta-Zeile');
    assert.equal(byClass(wrap, 'pantry-row__place').length, 0);
    const meta = byClass(wrap, 'list-row__meta')[0];
    assert.equal(byClass(meta, 'pantry-row__quantity').length, 1, 'die Menge fuehrt die Meta-Zeile');
  }
  const plus = nodesOf(rows[0]).find((n) => n.dataset?.action === 'increase');
  assert.match(plus.getAttribute('aria-label'), /Passata, pantry\.bestBefore\{"date":"2026-11-08"\}$/, 'der Knopf nennt die Charge so, wie sie heisst');
  // Nach einem Schritt baut refreshRowQuantity die Zeile aus rowOptions neu: dieselbe Benennung.
  assert.equal(__test.rowOptions(passata.batches[0]).byDate, true);

  // Gegenprobe Milch (Garage und Dachboden): der Ort ist der Titel, das Datum steht in der Meta-Zeile.
  const milk = __test.productSections(__test.state.items)[0].products[1];
  const milkRows = byClass(__test.productEl(milk), 'pantry-batches')[0].children;
  assert.deepEqual(milkRows.map((wrap) => textOf(byClass(wrap, 'list-row__name')[0])), ['Milch: Garage', 'Milch: Dachboden']);
  assert.ok(milkRows.every((wrap) => byClass(wrap, 'pantry-row__date').length === 1), 'das MHD in der Meta-Zeile');
  assert.equal(__test.rowOptions(milk.batches[0]).byDate, false);
});

test('#1448: aufklappen schaltet aria-expanded und die Region; der Zustand gilt fuer den Besuch', async () => {
  groupedPantry();
  const milk = __test.productSections(__test.state.items)[0].products[1];
  const el = __test.productEl(milk);
  const [toggle] = byClass(el, 'pantry-product__toggle');
  const [region] = byClass(el, 'pantry-batches');
  toggle.closest = (sel) => (sel === '.pantry-product' ? el : (sel === '[data-action]' ? toggle : null));
  el.querySelector = (sel) => (sel === ':scope > .pantry-batches' ? region : null);

  __test.toggleProduct(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(region.hidden, false, 'auf: hidden faellt sofort');
  assert.ok(__test.expandedProducts.has(milk.key));

  // Neu gezeichnet (nach einem Schritt, einem Speichern) bleibt es offen.
  const redrawn = __test.productEl(milk);
  assert.equal(byClass(redrawn, 'pantry-product__toggle')[0].getAttribute('aria-expanded'), 'true');
  assert.equal(byClass(redrawn, 'pantry-batches')[0].hidden, false);

  __test.toggleProduct(toggle);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(region.hidden, true, 'zu');
  assert.equal(__test.expandedProducts.has(milk.key), false);

  // Der Klick-Handler der Liste fuehrt dorthin, auch bei Nur-lesen (Positivliste).
  assert.ok(__test.READ_SAFE_ACTIONS.has('toggle-product'));
  __test.onListClick({ target: toggle });
  assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'onListClick klappt auf');
});

test('#1448: ein Produkt ohne Charge steht als "Leer" mit 0 und einem Warenkorb, der den Namen uebergibt', async () => {
  groupedPantry();
  const tooth = __test.productSections(__test.state.items)[1].products[0];
  const el = __test.productEl(tooth);
  const row = el.children[0];
  assert.match(row.className, /\bpantry-row--out\b/);
  assert.equal(textOf(byClass(el, 'pantry-badge')[0]), 'pantry.badgeOut');
  assert.match(textOf(byClass(el, 'pantry-row__quantity')[0]), /^0 /, 'null in seiner Einheit');
  assert.equal(byClass(el, 'pantry-stepper').length, 0, 'nichts zu buchen');
  assert.match(el.className, /\bswipe-row\b/, 'wegwischen loescht das leere Produkt (Review #2085, unten)');
  const [cart] = byClass(el, 'pantry-row__cart');
  assert.equal(cart.dataset.action, 'to-shopping-product');
  assert.equal(cart.dataset.productId, '13');
  assert.match(cart.getAttribute('aria-label'), /Zahnpasta$/);

  // Der Weg in den Einkauf: per Produkt-ID, ohne Menge.
  let posted = null;
  globalThis.__apiStub = {
    get: async () => ({ data: [{ id: 7, name: 'Wocheneinkauf' }] }),
    post: async (path, body) => { posted = { path, body }; return { data: { added: 1, skipped: 0, added_ids: [99] } }; },
  };
  __test.state.lists = null;
  const yuvomi = global.window.yuvomi;
  let toast = null;
  global.window.yuvomi = { showToast(message, tone) { toast = { message, tone }; } };
  try {
    cart.closest = (sel) => (sel === '[data-action]' ? cart : null);
    __test.onListClick({ target: cart });
    for (let i = 0; i < 40 && !toast; i++) await new Promise((r) => setTimeout(r, 5));
  } finally {
    global.window.yuvomi = yuvomi;
  }
  assert.deepEqual(posted, { path: '/shopping/7/import-pantry', body: { items: [{ pantry_product_id: 13 }] } });
  assert.equal(toast?.tone, 'success', 'die Meldung des geteilten Uebertrags');
});

test('#1448: mit Filter bleibt die Liste flach je Charge; Ort und Produktsumme stehen in der Meta-Zeile', () => {
  groupedPantry();
  __test.state.filter = 'expired';
  const expired = __test.state.items[1];
  const opts = __test.rowOptions(expired);
  assert.deepEqual(opts, { batch: false, byDate: false, total: 3 }, 'keine Chargen-Zeile, aber die Summe des Produkts');
  const el = __test.rowEl(expired, opts);
  assert.match(el.children.at(-1).className, /^list-row pantry-row$/);
  assert.equal(textOf(byClass(el, 'list-row__name')[0]), 'Milch', 'der Name des Produkts, nicht der Ort');
  assert.match(textOf(byClass(el, 'pantry-row__place')[0]), /Garage/);
  assert.match(textOf(byClass(el, 'pantry-row__total')[0]), /pantry\.productTotal\{"quantity":"3 /);
  assert.equal(byClass(el, 'pantry-row__expiry').length, 1, 'das MHD wie heute');

  // Gegenprobe: eine Charge ohne Geschwister nennt keine Summe.
  const butter = __test.rowEl(__test.state.items[4], __test.rowOptions(__test.state.items[4]));
  assert.equal(byClass(butter, 'pantry-row__total').length, 0);
  // Und ohne Filter ist dieselbe Milch-Charge eine Chargen-Zeile.
  __test.state.filter = 'all';
  assert.equal(__test.rowOptions(expired).batch, true);
});

test('#1448: renderList zeichnet ohne Filter Produkte in Kategorie-Abschnitten, mit Filter eine flache Liste', () => {
  groupedPantry();
  const list = makeNode();
  list.querySelector = () => null;
  list.replaceChildren = (...kids) => { list.children = [...kids]; };
  __test.setContainerForTest({ querySelector: (sel) => (sel === '#pantry-list' ? list : null), querySelectorAll: () => [] });
  __test.renderList();
  const sections = list.children.filter((c) => hasClass(c, 'pantry-group'));
  assert.equal(sections.length, 3, 'drei Kategorien');
  const title = byClass(sections[0], 'list-group__title')[0];
  assert.equal(textOf(byClass(title, 'list-group__count')[0]), '2', 'die Zahl zaehlt Produkte, nicht Chargen');
  assert.equal(byClass(sections[0], 'pantry-product__toggle').length, 1, 'Milch als Produktzeile');
  assert.equal(byClass(list, 'pantry-product--empty').length, 1, 'Zahnpasta als Leer');

  __test.state.filter = 'expired';
  __test.renderList();
  const flat = list.children.filter((c) => hasClass(c, 'pantry-group'));
  assert.equal(flat.length, 1, 'ein flacher Abschnitt');
  assert.equal(byClass(flat[0], 'list-group__title').length, 0, 'ohne Ueberschrift');
  assert.equal(byClass(flat[0], 'pantry-product__toggle').length, 0, 'keine Produktzeilen');
  assert.equal(byClass(flat[0], 'pantry-product--empty').length, 0, 'das leere Produkt beantwortet keine Packungsfrage');
  assert.deepEqual(byClass(flat[0], 'pantry-row').map((r) => r.dataset.id), ['2'], 'die abgelaufene Charge');

  // Gegenprobe: ein Vorrat nur aus leeren Produkten ist nicht leer.
  __test.state.filter = 'all';
  __test.state.items = [];
  __test.renderList();
  assert.equal(byClass(list, 'pantry-product--empty').length, 4, 'alle vier als Leer, kein Leerzustand');
});

test('#1448: die zugeklappte Produktzeile zeigt das dringendste MHD ihrer Chargen, nie "Fast leer"', () => {
  groupedPantry();
  // Milch: eine Charge gestern abgelaufen (und knapp), eine laeuft in zwei Tagen ab.
  __test.state.items[0].expires_on = '2026-10-21';
  const milk = __test.productSections(__test.state.items)[0].products[1];
  const el = __test.productEl(milk);
  const head = el.children[0];
  const [slot] = byClass(head, 'pantry-product__badges');
  const badges = byClass(slot, 'pantry-badge');
  assert.equal(badges.length, 1, 'ein Badge: das dringendste');
  assert.equal(textOf(badges[0]), 'pantry.badgeExpiredYesterday', 'abgelaufen schlaegt bald');
  assert.match(badges[0].className, /pantry-badge--danger/);
  assert.ok(nodesOf(byClass(head, 'pantry-product__toggle')[0]).includes(slot), 'im Knopf: der Screenreader liest es mit dem Namen');
  assert.ok(!nodesOf(head).some((n) => /pantry\.badge(Low|Out)/.test(n.textContent ?? '')), 'kein Fast leer / Leer an der Produktzeile (Schritt 3)');

  // Nur bald: das Badge der Charge, die zuerst ablaeuft.
  __test.state.items[1].expires_on = '2026-10-23';
  const soon = __test.productEl(__test.productSections(__test.state.items)[0].products[1]);
  assert.equal(textOf(byClass(byClass(soon, 'pantry-product__badges')[0], 'pantry-badge')[0]), 'pantry.badgeExpiresDays{"count":2}');

  // Gegenprobe: alle Chargen in Ordnung (Passata, Monate hin) - kein Badge.
  const passata = __test.productSections(__test.state.items)[2].products[0];
  const calm = __test.productEl(passata).children[0];
  assert.equal(byClass(byClass(calm, 'pantry-product__badges')[0], 'pantry-badge').length, 0);
});

test('#1448: im Rueckgaengig-Fenster zaehlt die Produktzeile die geloeschte Charge nicht mit', () => {
  groupedPantry();
  const milk = __test.productSections(__test.state.items)[0].products[1];
  const el = __test.productEl(milk);
  const head = el.children[0];
  const total = byClass(head, 'pantry-product__total')[0];
  const where = byClass(head, 'pantry-product__where')[0];
  const slot = byClass(head, 'pantry-product__badges')[0];
  const key = milk.key;
  __test.setContainerForTest({
    querySelector: () => null,
    querySelectorAll: (sel) => {
      const prefix = `.pantry-product[data-product-key="${key}"] > .pantry-product__row `;
      if (sel === `${prefix}.pantry-product__total`) return [total];
      if (sel === `${prefix}.pantry-product__where`) return [where];
      if (sel === `${prefix}.pantry-product__badges`) return [slot];
      return [];
    },
  });
  try {
    // Die abgelaufene Kuehlschrank-Charge (1 l) wird weggewischt.
    const expired = __test.state.items[1];
    __test.pendingDeletes.add(expired.id);
    __test.refreshProductTotals(expired, { speak: false });
    assert.match(textOf(total), /"quantity":"2 /, 'nur noch die 2 l im Dachboden');
    assert.match(textOf(where), /pantry\.productBatches\{"count":1\}.*Dachboden/, 'eine Charge an einem Ort');
    assert.equal(byClass(slot, 'pantry-badge').length, 0, 'das Abgelaufen-Badge geht mit der Charge');

    // Rueckgaengig: alles zurueck.
    __test.pendingDeletes.delete(expired.id);
    __test.refreshProductTotals(expired, { speak: false });
    assert.match(textOf(total), /"quantity":"3 /);
    assert.match(textOf(where), /pantry\.productPlaces\{"count":2\}/);
    assert.equal(textOf(byClass(slot, 'pantry-badge')[0]), 'pantry.badgeExpiredYesterday');
  } finally {
    __test.pendingDeletes.clear();
  }

  // removeItem traegt die Charge ein und das Rueckgaengig nimmt sie wieder heraus.
  const src = readFileSync(new URL('../public/pages/pantry.js', import.meta.url), 'utf8');
  const remove = src.slice(src.indexOf('async function removeItem'), src.indexOf('// Lagerort-Verwaltung'));
  assert.match(remove, /pendingDeletes\.add\(item\.id\);\s*refreshProductTotals\(item, \{ speak: false \}\);/);
  assert.match(remove, /restore: \(err\) => \{\s*restored = true;\s*pendingDeletes\.delete\(item\.id\);\s*refreshProductTotals\(item, \{ speak: false \}\);/);
  assert.match(remove, /state\.items = state\.items\.filter\(\(i\) => i\.id !== item\.id\);\s*pendingDeletes\.delete\(item\.id\);/);
});

// --------------------------------------------------------
// Review of #2085: deleting a product without batches, the step path of the
// product total, and one chip per place
// --------------------------------------------------------

const { setPermissions, clearPermissions } = await import('../public/permissions.js');

/** A container whose list and live region are real enough for renderList and announce. */
function pageStub({ stage = null, extra = {} } = {}) {
  const list = makeNode();
  list.querySelector = () => null;
  list.replaceChildren = (...kids) => { list.children = [...kids]; };
  const live = makeNode();
  const container = {
    list,
    live,
    querySelector: (sel) => {
      if (sel === '#pantry-list') return list;
      if (sel === '#pantry-live') return live;
      if (stage && sel === '.pantry-product[data-product-key="p13"]') return stage;
      return extra[sel] ?? null;
    },
    querySelectorAll: () => [],
  };
  __test.setContainerForTest(container);
  return container;
}

const productNames = () => __test.productSections(__test.state.items).flatMap((s) => s.products.map((p) => p.name));

test('#2085: the product without batches lies on a swipe stage and has a more button with "Delete"', async () => {
  groupedPantry();
  const tooth = __test.productSections(__test.state.items)[1].products[0];
  const el = __test.emptyProductEl(tooth);
  assert.match(el.className, /\bswipe-row\b/, 'the stage of a batch row');
  assert.match(el.className, /\bpantry-swipe\b/);
  assert.equal(el.dataset.swipeId, 'product-13', 'its own key space next to the batch ids');
  assert.match(el.html, /swipe-reveal swipe-reveal--delete swipe-reveal--trailing/, 'the delete panel at the row end');
  const row = el.children.at(-1);
  assert.match(row.className, /\bpantry-row\b/, 'the card the swipe moves (`.pantry-row`)');
  const [actions] = byClass(row, 'list-row__actions');
  assert.match(actions.html, /row-action row-action--more/, 'the more button of the component canon');
  assert.match(actions.html, /aria-label="common\.moreActionsNamed\{&quot;name&quot;:&quot;Zahnpasta&quot;\}"/, 'named with the object');
  assert.match(actions.html, /data-action="delete-product" data-id="13"/);
  assert.match(actions.html, /popover-menu__item--danger/);
  assert.equal(byClass(row, 'pantry-row__cart').length, 1, 'the cart stays');

  // pantry: read: no swipe, no menu; the cart follows shopping (Rule 8).
  setPermissions({ admin: false, modules: { pantry: 'read', shopping: 'write' }, widgets: {}, capabilities: {} });
  try {
    const ro = __test.emptyProductEl(tooth);
    assert.doesNotMatch(ro.className, /swipe-row/);
    assert.equal(ro.dataset.swipeId, undefined);
    assert.doesNotMatch(byClass(ro, 'list-row__actions')[0].html, /delete-product/);
    assert.equal(byClass(ro, 'pantry-row__cart').length, 1);
    __test.onListClick({ target: { closest: () => ({ dataset: { action: 'delete-product', id: '13' } }) } });
    assert.equal(__test.pendingProductDeletes.size, 0, 'the click handler refuses it at read too');
  } finally {
    clearPermissions();
  }
});

test('#2085: deleting a product without batches folds the row away, undo brings it back, only the commit calls the server', async () => {
  groupedPantry();
  const stage = makeNode();
  const page = pageStub({ stage });
  let pending = null;
  const deleted = [];
  globalThis.__undoStub = (opts) => { pending = opts; };
  globalThis.__apiStub = { delete: async (path) => { deleted.push(path); } };
  try {
    // Through the menu entry, as the list's click handler receives it.
    const entry = { dataset: { action: 'delete-product', id: '13' } };
    __test.onListClick({ target: { closest: (sel) => (sel === '[data-action]' ? entry : null) } });
    assert.ok(pending, 'the undo window opens');
    assert.equal(pending.message, 'pantry.deleted');
    assert.ok(__test.pendingProductDeletes.has(13));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(stage.style.display, 'none', 'the row is gone at once');
    assert.deepEqual(productNames().includes('Zahnpasta'), false, 'a redraw in the window does not bring it back');
    assert.deepEqual(deleted, [], 'nothing sent yet');

    // Undo: the row comes back, nothing was sent.
    pending.restore();
    assert.equal(stage.style.display, '', 'undo shows the row again');
    assert.equal(__test.pendingProductDeletes.size, 0);
    assert.ok(productNames().includes('Zahnpasta'));
    assert.deepEqual(deleted, []);

    // Again, through the swipe this time, and the window runs out: the commit.
    pending = null;
    const optionen = __test.wirePantrySwipe(makeNode());
    optionen.trailing.run({ dataset: { swipeId: 'product-13' } });
    assert.ok(pending, 'the swipe opens the same undo window');
    await pending.commit({ keepalive: false });
    assert.deepEqual(deleted, ['/pantry/products/13'], 'the commit calls the route');
    assert.equal(__test.state.products.some((p) => p.id === 13), false);
    assert.equal(__test.pendingProductDeletes.size, 0);
    assert.equal(byClass(page.list, 'pantry-product--empty').length, 0, 'the redraw after the commit has no Zahnpasta');
    assert.ok(byClass(page.list, 'pantry-product__toggle').length > 0, 'the rest of the list is drawn');

    // Counter-check: a batch's swipe id still deletes the batch, not a product.
    pending = null;
    optionen.trailing.run({ dataset: { swipeId: '5' } });
    assert.ok(pending);
    assert.ok(__test.pendingDeletes.has(5), 'the butter batch is in its undo window');
    assert.equal(__test.pendingProductDeletes.size, 0);
  } finally {
    __test.pendingDeletes.clear();
    __test.pendingProductDeletes.clear();
    delete globalThis.__undoStub;
  }
});

test('#2085: the server refuses a product that has batches again: the row comes back, the toast says why, the page reloads', async () => {
  groupedPantry();
  const stage = makeNode();
  pageStub({ stage });
  let pending = null;
  let reloaded = 0;
  globalThis.__undoStub = (opts) => { pending = opts; };
  globalThis.__apiStub = {
    get: async () => { reloaded += 1; return { data: __test.state.items, products: __test.state.products, locations: LOCS, categories: CATS }; },
  };
  const yuvomi = global.window.yuvomi;
  let toast = null;
  global.window.yuvomi = { showToast(message, tone) { toast = { message, tone }; } };
  try {
    __test.removeProduct(__test.state.products.find((p) => p.id === 13));
    pending.restore({ status: 409, data: { reason: 'pantry_product_has_batches', error: 'The product still has batches.' } });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(stage.style.display, '');
    assert.deepEqual(toast, { message: 'pantry.errorProductHasStock', tone: 'danger' }, 'in the language of the app, not the server text');
    assert.equal(reloaded, 1, 'the page reloads to show the new batch');

    // Counter-check: another failure says the general sentence and does not reload.
    __test.removeProduct(__test.state.products.find((p) => p.id === 13));
    pending.restore({ status: 500, data: { error: 'Boom' } });
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(toast, { message: 'common.unknownError', tone: 'danger' });
    assert.equal(reloaded, 1);
  } finally {
    global.window.yuvomi = yuvomi;
    __test.pendingProductDeletes.clear();
    delete globalThis.__undoStub;
  }
});

test('#2085: a step on a batch under an open product updates the product total and the live region says it', async () => {
  groupedPantry();
  __test.setQuantityDebounceMsForTest(5);
  const milk = __test.productSections(__test.state.items)[0].products[1];
  __test.expandedProducts.add(milk.key);
  const el = __test.productEl(milk);
  const head = el.children[0];
  const total = byClass(head, 'pantry-product__total')[0];
  const where = byClass(head, 'pantry-product__where')[0];
  const slot = byClass(head, 'pantry-product__badges')[0];
  assert.match(textOf(total), /"quantity":"3 /, 'before: 2 l + 1 l');
  const live = makeNode();
  __test.setContainerForTest({
    querySelector: (sel) => (sel === '#pantry-live' ? live : null),
    querySelectorAll: (sel) => {
      const prefix = `.pantry-product[data-product-key="${milk.key}"] > .pantry-product__row `;
      if (sel === `${prefix}.pantry-product__total`) return [total];
      if (sel === `${prefix}.pantry-product__where`) return [where];
      if (sel === `${prefix}.pantry-product__badges`) return [slot];
      return [];
    },
  });
  globalThis.__apiStub = { patch: async (_path, body) => ({ data: { quantity: body.quantity } }) };
  try {
    // "+" on the 2 l in the Dachboden: litres step by 0.5.
    const { row } = makeRow(0.5);
    const dachboden = __test.state.items.find((i) => i.id === 1);
    __test.adjustQuantity(dachboden, +1, row);
    assert.match(textOf(total), /"quantity":"3[.,]5 /, 'the product row shows the new total at once');
    assert.match(live.textContent, /^Milch: .*2[.,]5 .*, pantry\.productTotal\{"quantity":"3[.,]5 /,
      'the live region says the batch and the new total');
    await settled();
  } finally {
    __test.expandedProducts.clear();
    __test.setQuantityDebounceMsForTest(null);
  }
});

test('#2085: one chip per place that holds a batch, in the order of the places, single-select with the status chips', () => {
  groupedPantry();
  __test.state.locations = [...LOCS, { id: 4, name: 'Keller', icon: 'warehouse' }];
  const chips = __test.placeChips(__test.state.items);
  assert.deepEqual(chips.map((c) => [c.id, c.label, c.count]), [
    ['place:1', 'Garage', 2], ['place:2', 'Dachboden', 1], ['place:3', 'Speisekammer', 2],
  ], 'Keller holds nothing and gets no chip; the rest in the order of the places');
  assert.equal(chips[0].icon, 'map-pin', 'a place without an icon gets the pin');

  // The bar: the same filter-chip markup as the status chips, aria-pressed on each, one pressed.
  const bar = makeNode();
  bar.contains = () => false;
  bar.querySelector = () => null;
  __test.setContainerForTest({ querySelector: (sel) => (sel === '#pantry-filters' ? bar : null), querySelectorAll: () => [] });
  __test.state.filter = 'place:3';
  const { wasReset } = __test.renderFilters();
  assert.equal(wasReset, false);
  assert.equal(bar.hidden, false);
  const buttons = bar.html.match(/<button[^>]*>/g);
  const pressed = buttons.filter((b) => /aria-pressed="true"/.test(b));
  assert.equal(pressed.length, 1, 'single-select: one chip pressed');
  assert.match(pressed[0], /class="filter-chip filter-chip--sm filter-chip--active"\s+data-filter="place:3"/);
  assert.ok(buttons.some((b) => /data-filter="expired" aria-pressed="false"/.test(b)), 'the status chips stay, unpressed');
  assert.ok(buttons.every((b) => /class="filter-chip filter-chip--sm/.test(b)), 'every chip is a filter-chip');
  assert.deepEqual(buttons.map((b) => b.match(/data-filter="([^"]+)"/)[1]),
    ['all', 'expired', 'low', 'place:1', 'place:2', 'place:3'], 'status chips first, then the places');
  assert.match(bar.html, /<span>Speisekammer<\/span>\s*<span class="filter-chip__count">2<\/span>/);

  // A place that loses its last batch drops its chip and the filter falls back to All.
  __test.state.filter = 'place:2';
  __test.state.items = __test.state.items.filter((i) => i.id !== 1);
  assert.equal(__test.renderFilters().wasReset, true);
  assert.equal(__test.state.filter, 'all');

  // A household with a single place still sees its one place chip, as asked on #2085.
  __test.state.items = __test.state.items.filter((i) => i.location_id === 1);
  assert.deepEqual(__test.placeChips(__test.state.items).map((c) => [c.id, c.count]), [['place:1', 2]]);
  // Counter-check: a batch without a place gives no chip.
  __test.state.items = [batch(9, 12, { name: 'Butter' })];
  assert.deepEqual(__test.placeChips(__test.state.items), []);
});

test('#2085: a place chip lists the batches there, flat, by name, with the product total; the search narrows it', () => {
  groupedPantry();
  __test.state.filter = 'place:1';
  assert.deepEqual(__test.visibleItems().map((i) => i.id), [2, 5], 'Garage: one milk batch and the butter');
  assert.deepEqual(__test.flatItems(__test.visibleItems()).map((i) => i.id), [5, 2], 'by name: Butter before Milch');

  const page = pageStub();
  __test.renderList();
  const groups = page.list.children.filter((c) => hasClass(c, 'pantry-group'));
  assert.equal(groups.length, 1, 'one flat section');
  assert.equal(byClass(groups[0], 'list-group__title').length, 0);
  const rows = byClass(groups[0], 'pantry-row');
  assert.deepEqual(rows.map((r) => r.dataset.id), ['5', '2']);
  assert.equal(byClass(groups[0], 'pantry-row__place').length, 0, 'the chip names the place, the rows do not repeat it');
  assert.match(textOf(byClass(rows[1], 'pantry-row__total')[0]), /pantry\.productTotal\{"quantity":"3 /, 'milk says its total: 2 l more are elsewhere');
  assert.equal(byClass(groups[0], 'pantry-product--empty').length, 0, 'a product without batches is in no place');
  assert.equal(page.live.textContent, 'pantry.resultCount{"count":2}');

  // Search and chip together: both apply.
  __test.state.query = 'milch';
  assert.deepEqual(__test.visibleItems().map((i) => i.id), [2]);
  __test.state.query = 'passata';
  assert.deepEqual(__test.visibleItems().map((i) => i.id), [], 'passata is in the Speisekammer, not here');
  __test.state.query = '';

  // Counter-check: the status chips are untouched by the place logic.
  __test.state.filter = 'expired';
  assert.deepEqual(__test.visibleItems().map((i) => i.id), [2]);
  __test.state.filter = 'all';
  assert.equal(__test.visibleItems().length, 5);
});

test('#2085: renderList keeps the scroll position of the chip row, so the active place chip stays in view', () => {
  groupedPantry();
  const chipRow = makeNode();
  chipRow.scrollLeft = 558;
  const list = makeNode();
  list.querySelector = (sel) => (sel === ':scope > #pantry-filters' ? chipRow : null);
  // As in a browser: taking the row out and putting it back resets its scroll.
  list.replaceChildren = (...kids) => { list.children = [...kids]; if (kids.includes(chipRow)) chipRow.scrollLeft = 0; };
  __test.setContainerForTest({ querySelector: (sel) => (sel === '#pantry-list' ? list : null), querySelectorAll: () => [] });
  __test.state.filter = 'place:2';
  __test.renderList();
  assert.equal(list.children[0], chipRow);
  assert.equal(chipRow.scrollLeft, 558, 'where renderFilters() scrolled the active chip to');
});
