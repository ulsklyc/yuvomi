/**
 * Tests: Kategorie-Einklappen und Sammelaktions-Automat des Einkaufs (#1039)
 * Modul: /public/pages/shopping.js
 *
 * WARUM ALS VERHALTENSTEST: eine Textprobe auf `localStorage.setItem` oder
 * `setTimeout` bliebe gruen, auch wenn die Speicherung falsch scopt oder die
 * Frist bei jedem weiteren Treffer neu startet - genau die Fehlerklasse, die
 * dieses Ticket beheben soll. Getrieben werden deshalb die echten exportierten
 * Funktionen (`__test`), mit dem kleinstmoeglichen DOM-Stub: shopping.js
 * importiert am Modulkopf mehrere echte Browser-Module (u.a.
 * category-manager.js, ein Custom Element), die ohne `customElements`/
 * `HTMLElement`/`document` beim Laden selbst schon werfen - der Stub unten
 * deckt genau das ab, nichts, was das Modul beim Rendern einer Seite bräuchte.
 *
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-shopping-ux.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

global.HTMLElement = class HTMLElement {};
global.customElements = { define() {}, get() { return undefined; } };

/** Sammelaktions-Schicht: zeichnet nichts, merkt aber ihre Listener - genug,
 *  um Hover/Fokus-Ende so auszuloesen, wie es der echte Browser täte.
 *  `replaceChildren` zaehlt ihre Aufrufe: Pantry und Kontakte teilen sich
 *  dieselbe Schicht, und ein Test unten prueft, dass eine fremde (oder
 *  laengst verlassene) Sammelaktion sie nicht versehentlich leert. */
function makeBulkPillLayer() {
  const handlers = {};
  return {
    dataset: {},
    contains: () => false,
    addEventListener(type, handler) { handlers[type] = handler; },
    replaceChildren() { this.replaceChildrenCalls = (this.replaceChildrenCalls ?? 0) + 1; },
    replaceChildrenCalls: 0,
    querySelector: () => null,
    fire(type, evt = {}) { handlers[type]?.(evt); },
  };
}
const bulkPillLayer = makeBulkPillLayer();

global.window = {
  matchMedia: () => ({ matches: false }),
  addEventListener() {},
  yuvomi: {},
};
global.document = {
  getElementById: (id) => (id === 'bulk-pill-layer' ? bulkPillLayer : null),
  createElement: () => Object.assign(new global.HTMLElement(), {
    style: {}, setAttribute() {}, appendChild() {}, addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} },
  }),
  addEventListener() {},
  documentElement: { lang: 'de' },
};

// In-Memory-`localStorage`, wie es der Browser-Loader fuer keine der beiden
// Funktionen mitbringt - shopping.js ruft sie direkt aus dem globalen Scope.
function makeMemoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
    clear: () => data.clear(),
  };
}
global.localStorage = makeMemoryStorage();

const { __test } = await import('../public/pages/shopping.js');

function resetShoppingState() {
  // AUFRAEUMEN AM ANFANG. `_loadSeq` waechst global weiter, und eine
  // Wasserstandsmarke aus einem frueheren Fall verwirft sonst die Auffrischung
  // des naechsten - der Fall ist dann isoliert gruen und in der Suite rot.
  __test.intents.clear();
  __test.resetLoadOrderForTest();
  __test.state.items = [];
  __test.state.categories = [];
  // Ein Fehlerbild aus einem frueheren Fall (loadLists faengt selbst und
  // vermerkt es) liesse die Live-Aktualisierung des naechsten stumm bleiben.
  __test.state.listsError = null;
  __test.state.itemsError = null;
  __test.state.activeListId = 1;
  __test.state.currentUserId = 7;
  __test.state.collapsedCategories = new Set();
  __test.resetPillMachine();
  __test.setPillInteractingForTest(false);
  __test.setBulkPillHoldMsForTest(null);
  bulkPillLayer.replaceChildrenCalls = 0;
  global.localStorage.clear();
}

/** Kleinstes DOM, das toggleCategoryCollapse bedient: closest + ein Kind je Selektor. */
function makeCategoryGroup(key, { collapsed = false } = {}) {
  const rowsEl = { hidden: collapsed };
  const chevron = {
    _collapsed: collapsed,
    classList: {
      toggle(cls, on) { if (cls === 'list-group__chevron--collapsed') chevron._collapsed = on; },
    },
  };
  const groupEl = {
    _sel: '.list-group',
    querySelector(sel) {
      if (sel === '.list-rows') return rowsEl;
      return null;
    },
  };
  const button = {
    dataset: { categoryToggle: key },
    _attrs: { 'aria-expanded': String(!collapsed) },
    setAttribute(k, v) { button._attrs[k] = v; },
    getAttribute(k) { return button._attrs[k] ?? null; },
    closest(sel) { return sel === '.list-group' ? groupEl : null; },
    querySelector(sel) { return sel === '.list-group__chevron' ? chevron : null; },
  };
  return { button, rowsEl, chevron };
}

// --------------------------------------------------------
// Kategorie-Einklappen: stabiler Schluessel
// --------------------------------------------------------

test('categoryStorageKey: bekannte Kategorie traegt ihre ID, nicht ihren Namen', () => {
  resetShoppingState();
  __test.state.categories = [{ id: 42, name: 'Obst & Gemüse', icon: 'apple' }];
  assert.equal(__test.categoryStorageKey('Obst & Gemüse'), 'id:42');

  // Rename-sicher: der Name aendert sich, die ID nicht - derselbe Schluessel.
  __test.state.categories[0].name = 'Frisches Obst & Gemüse';
  assert.equal(__test.categoryStorageKey('Frisches Obst & Gemüse'), 'id:42');
});

test('categoryStorageKey: unbekannte/geloeschte Kategorie faellt auf den normalisierten Namen zurueck', () => {
  resetShoppingState();
  __test.state.categories = [];
  assert.equal(__test.categoryStorageKey('Sonstiges'), 'name:sonstiges');
  assert.equal(__test.categoryStorageKey('  SONSTIGES  '), 'name:sonstiges');
});

// --------------------------------------------------------
// Kategorie-Einklappen: Speicherung, Scoping, Validierung
// --------------------------------------------------------

test('loadCollapsedCategories/saveCollapsedCategories: Rundreise ueber localStorage', () => {
  resetShoppingState();
  __test.saveCollapsedCategories(7, 1, new Set(['id:1', 'id:2']));
  const loaded = __test.loadCollapsedCategories(7, 1);
  assert.deepEqual([...loaded].sort(), ['id:1', 'id:2']);
});

test('loadCollapsedCategories: scoped je Nutzer UND je Liste - keine Ueberdeckung', () => {
  resetShoppingState();
  __test.saveCollapsedCategories(7, 1, new Set(['id:1']));

  // Anderer Nutzer, gleiche Liste: sieht nichts vom ersten.
  assert.deepEqual([...__test.loadCollapsedCategories(9, 1)], []);
  // Gleicher Nutzer, andere Liste: sieht ebenfalls nichts.
  assert.deepEqual([...__test.loadCollapsedCategories(7, 2)], []);
  // Genau dieselbe Kombination: sieht den gespeicherten Zustand.
  assert.deepEqual([...__test.loadCollapsedCategories(7, 1)], ['id:1']);
});

test('loadCollapsedCategories: kaputte/fremde Werte fallen sicher auf eine leere Menge zurueck', () => {
  resetShoppingState();
  const key = __test.collapsedCategoriesStorageKey(7, 1);

  global.localStorage.setItem(key, 'kein-json{{{');
  assert.deepEqual([...__test.loadCollapsedCategories(7, 1)], [], 'kaputtes JSON darf nicht werfen');

  global.localStorage.setItem(key, JSON.stringify({ version: 999, collapsed: ['id:1'] }));
  assert.deepEqual([...__test.loadCollapsedCategories(7, 1)], [], 'eine fremde Version darf nicht blind uebernommen werden');

  global.localStorage.setItem(key, JSON.stringify({ version: 1, collapsed: 'id:1' }));
  assert.deepEqual([...__test.loadCollapsedCategories(7, 1)], [], 'collapsed muss ein Array sein');
});

test('pruneCollapsedCategories: entfernt Schluessel geloeschter Kategorien, behaelt gueltige', () => {
  resetShoppingState();
  __test.state.categories = [{ id: 1, name: 'Obst', icon: 'apple' }];
  __test.state.collapsedCategories = new Set(['id:1', 'id:99', 'name:veraltet']);

  // Nur "Obst" (id:1) ist in der aktuell gerenderten Gruppierung noch da.
  __test.pruneCollapsedCategories([['Obst', [{ id: 100 }]]]);

  assert.deepEqual([...__test.state.collapsedCategories], ['id:1'],
    'id:99 (geloeschte Kategorie) und name:veraltet (verschwundene Unbekannt-Gruppe) muessen weg sein');
  // Und persistiert, nicht nur im Speicher veraendert:
  assert.deepEqual([...__test.loadCollapsedCategories(7, 1)], ['id:1']);
});

test('pruneCollapsedCategories: ruehrt nichts an, wenn alles noch gueltig ist (kein unnoetiger Schreibzugriff)', () => {
  resetShoppingState();
  __test.state.categories = [{ id: 1, name: 'Obst', icon: 'apple' }];
  __test.state.collapsedCategories = new Set(['id:1']);
  __test.saveCollapsedCategories(7, 1, new Set(['id:1']));

  __test.pruneCollapsedCategories([['Obst', [{ id: 100 }]]]);
  assert.deepEqual([...__test.state.collapsedCategories], ['id:1']);
});

// --------------------------------------------------------
// Kategorie-Einklappen: der Umschalter selbst
// --------------------------------------------------------

test('toggleCategoryCollapse: klappt zu, meldet aria-expanded/hidden/Chevron und speichert', () => {
  resetShoppingState();
  const { button, rowsEl, chevron } = makeCategoryGroup('id:1', { collapsed: false });

  __test.toggleCategoryCollapse(button);

  assert.equal(rowsEl.hidden, true, 'die Zeilen bleiben im DOM, werden aber ausgeblendet');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(chevron._collapsed, true);
  assert.deepEqual([...__test.state.collapsedCategories], ['id:1']);
  assert.deepEqual([...__test.loadCollapsedCategories(7, 1)], ['id:1'], 'persistiert sofort');
});

test('toggleCategoryCollapse: klappt wieder auf (Gegenprobe der Umkehrung)', () => {
  resetShoppingState();
  __test.state.collapsedCategories = new Set(['id:1']);
  const { button, rowsEl, chevron } = makeCategoryGroup('id:1', { collapsed: true });

  __test.toggleCategoryCollapse(button);

  assert.equal(rowsEl.hidden, false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(chevron._collapsed, false);
  assert.deepEqual([...__test.state.collapsedCategories], []);
});

test('toggleCategoryCollapse: eine neue Kategorie ist ohne Zutun aufgeklappt', () => {
  // Gespeichert wird nur, was EINGEKLAPPT ist (dieselbe Regel wie bei den
  // Aufgaben-Gruppen, #812) - eine frisch angelegte Kategorie taucht in keiner
  // gespeicherten Menge auf und ist damit automatisch offen.
  resetShoppingState();
  assert.equal(__test.state.collapsedCategories.has('id:123'), false);
});

// --------------------------------------------------------
// Sammelaktions-Pille: Zustandsautomat
// --------------------------------------------------------

const fakeContainer = () => ({ isConnected: true });

test('updateCheckedActions: vorbelegte (geladene) Artikel zeigen KEINE Pille', () => {
  // Das Kernversprechen von #1039: "pre-checked data does not create a
  // permanent pill" gilt nicht nur beim allerersten Seitenaufruf, sondern bei
  // jedem Nachladen (Listenwechsel) - deshalb hier ohne userChecked.
  resetShoppingState();
  __test.state.items = [{ id: 1, is_checked: 1 }, { id: 2, is_checked: 0 }];
  __test.updateCheckedActions(fakeContainer());
  assert.equal(__test.getPillPhaseForTest(), 'idle');
});

test('updateCheckedActions: ein echter Abhak-Treffer aus dem Ruhezustand oeffnet die Pille', () => {
  resetShoppingState();
  __test.state.items = [{ id: 1, is_checked: 1 }];
  __test.updateCheckedActions(fakeContainer(), { userChecked: true });
  assert.equal(__test.getPillPhaseForTest(), 'visible');
});

test('updateCheckedActions: zurueck auf 0 setzt den Automaten in den Ruhezustand', () => {
  resetShoppingState();
  __test.state.items = [{ id: 1, is_checked: 1 }];
  __test.updateCheckedActions(fakeContainer(), { userChecked: true });
  assert.equal(__test.getPillPhaseForTest(), 'visible');

  __test.state.items = [{ id: 1, is_checked: 0 }];
  __test.updateCheckedActions(fakeContainer());
  assert.equal(__test.getPillPhaseForTest(), 'idle');
});

test('updateCheckedActions: die Frist startet NICHT bei jedem weiteren Treffer neu', async () => {
  resetShoppingState();
  __test.setBulkPillHoldMsForTest(50);

  __test.state.items = [{ id: 1, is_checked: 1 }];
  __test.updateCheckedActions(fakeContainer(), { userChecked: true }); // t=0, Frist bis ~50ms

  await new Promise((r) => setTimeout(r, 30));
  __test.state.items = [{ id: 1, is_checked: 1 }, { id: 2, is_checked: 1 }];
  // Ein zweiter Treffer bei bereits sichtbarer Pille - userChecked waere hier
  // ohnehin wirkungslos, weil die Pille nicht mehr im Ruhezustand ist.
  __test.updateCheckedActions(fakeContainer(), { userChecked: true }); // t=30ms
  assert.equal(__test.getPillPhaseForTest(), 'visible', 'Zahl/Aktionen aktualisiert, Frist unangetastet');

  // Haette der zweite Treffer die Frist verlaengert, stuende die Pille bei
  // t=60ms noch (30ms nach dem zweiten Treffer waeren erst 30/50 verstrichen).
  // Ohne Verlaengerung ist die ORIGINALE Frist (t=50ms ab dem ERSTEN Treffer)
  // laengst abgelaufen.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(__test.getPillPhaseForTest(), 'suppressed',
    'die Frist muss ab dem ERSTEN Treffer laufen, nicht ab dem letzten');
});

test('updateCheckedActions: derselbe Batch zeigt sich nach dem Ausblenden nicht erneut', async () => {
  resetShoppingState();
  __test.setBulkPillHoldMsForTest(20);

  __test.state.items = [{ id: 1, is_checked: 1 }];
  __test.updateCheckedActions(fakeContainer(), { userChecked: true });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(__test.getPillPhaseForTest(), 'suppressed');

  // Ein weiterer Artikel desselben (noch nicht auf 0 gefallenen) Batches darf
  // die Pille nicht zurueckholen.
  __test.state.items = [{ id: 1, is_checked: 1 }, { id: 2, is_checked: 1 }];
  __test.updateCheckedActions(fakeContainer(), { userChecked: true });
  assert.equal(__test.getPillPhaseForTest(), 'suppressed');

  // Erst der Fall auf 0 und ein NEUER Treffer eroeffnen einen neuen Batch.
  __test.state.items = [{ id: 1, is_checked: 0 }, { id: 2, is_checked: 0 }];
  __test.updateCheckedActions(fakeContainer());
  assert.equal(__test.getPillPhaseForTest(), 'idle');

  __test.state.items = [{ id: 1, is_checked: 1 }, { id: 2, is_checked: 0 }];
  __test.updateCheckedActions(fakeContainer(), { userChecked: true });
  assert.equal(__test.getPillPhaseForTest(), 'visible');
});

test('updateCheckedActions: Hover/Fokus auf der Pille schiebt das Ausblenden auf, bis die Interaktion endet', async () => {
  resetShoppingState();
  __test.setBulkPillHoldMsForTest(20);

  __test.state.items = [{ id: 1, is_checked: 1 }];
  __test.updateCheckedActions(fakeContainer(), { userChecked: true });
  __test.setPillInteractingForTest(true);

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(__test.getPillPhaseForTest(), 'deferred',
    'die Frist ist um, aber die Interaktion haelt die Pille noch offen');

  // Interaktion endet (mouseleave/focusout auf der geteilten Schicht):
  bulkPillLayer.fire('mouseleave');
  assert.equal(__test.getPillPhaseForTest(), 'suppressed');
});

test('das Ende einer Interaktion loescht die geteilte Schicht nicht mehr, wenn die Seite laengst verlassen ist', async () => {
  // Die Hover/Fokus-Listener haengen EINMALIG, app-weit an der Schicht (Pantry
  // und Kontakte zeigen dort ihre eigene Pille). Ohne Eigentums-Pruefung
  // wuerde ein Maus-Verlassen auf einer FREMDEN, gerade sichtbaren Pille sie
  // loeschen, nur weil `pillPhase` hier zufaellig noch 'deferred' vom letzten
  // Einkaufsbesuch war.
  resetShoppingState();
  __test.setBulkPillHoldMsForTest(20);

  const container = fakeContainer();
  __test.state.items = [{ id: 1, is_checked: 1 }];
  __test.updateCheckedActions(container, { userChecked: true });
  __test.setPillInteractingForTest(true);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(__test.getPillPhaseForTest(), 'deferred');

  // Seite verlassen, BEVOR die Interaktion endet.
  container.isConnected = false;
  const callsBefore = bulkPillLayer.replaceChildrenCalls;

  bulkPillLayer.fire('mouseleave');
  assert.equal(__test.getPillPhaseForTest(), 'suppressed', 'der interne Zustand darf trotzdem aufraeumen');
  assert.equal(bulkPillLayer.replaceChildrenCalls, callsBefore,
    'eine verlassene Seite darf die geteilte Schicht (moeglicherweise mit einer fremden Pille) nicht anfassen');
});

test('updateCheckedActions: eine veraltete Frist nach einem Listenwechsel bleibt folgenlos', async () => {
  resetShoppingState();
  __test.setBulkPillHoldMsForTest(20);

  __test.state.items = [{ id: 1, is_checked: 1 }];
  __test.updateCheckedActions(fakeContainer(), { userChecked: true });
  assert.equal(__test.getPillPhaseForTest(), 'visible');

  // Ein Listenwechsel (resetPillMachine) waehrend die Frist noch laeuft.
  __test.resetPillMachine();
  assert.equal(__test.getPillPhaseForTest(), 'idle');

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(__test.getPillPhaseForTest(), 'idle',
    'die alte Frist darf den frischen Ruhezustand der neuen Liste nicht ueberschreiben');
});

test('updateCheckedActions: eine veraltete Frist nach dem Verlassen der Seite bleibt folgenlos (isConnected)', async () => {
  resetShoppingState();
  __test.setBulkPillHoldMsForTest(20);

  const container = fakeContainer();
  __test.state.items = [{ id: 1, is_checked: 1 }];
  __test.updateCheckedActions(container, { userChecked: true });
  assert.equal(__test.getPillPhaseForTest(), 'visible');

  // Die Seite wurde verlassen: der Router ersetzt den Inhalt, diese Wurzel
  // haengt nicht mehr im Dokument.
  container.isConnected = false;

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(__test.getPillPhaseForTest(), 'visible',
    'eine Frist ohne lebende Wurzel darf weder den Zustand noch die geteilte Schicht anfassen');
});

// --------------------------------------------------------
// Laden-Verwaltung (#1003)
// --------------------------------------------------------

test('der Laden-Manager meldet sich beim Schliessen NICHT vom Aenderungs-Ereignis ab', () => {
  // Gemessen am 08.09.2026 im laufenden Browser: beim Loeschen raeumt
  // `confirmOverModal` das Modal darunter mit ab, und `api.delete` laeuft
  // danach weiter - `category-manager-changed` kommt also erst, wenn das
  // Element schon aus dem Dokument ist (imDom: false in der Sonde). Wer beim
  // Schliessen abmeldet, verpasst genau diese Aenderung: `state.stores` boete
  // danach einen Laden an, den der Server nicht mehr kennt, und das naechste
  // Speichern liefe in dessen 400-Antwort.
  //
  // Als Textprobe und nicht als Verhaltenstest, weil der Ablauf am echten
  // Modal-Stack haengt (Suspend/Resume ueber zwei Overlays) - der Stub dieser
  // Suite bildet ihn nicht ab. Der Nachweis liegt in der Messung, hier steht
  // nur die Sperre gegen den Rueckfall.
  const src = readFileSync(new URL('../public/pages/shopping.js', import.meta.url), 'utf8');
  const fn = src.match(/function openStoreManager\(container\)[\s\S]*?\n\}/);
  assert.ok(fn, 'openStoreManager nicht gefunden');
  assert.doesNotMatch(fn[0], /removeEventListener\(\s*'category-manager-changed'/,
    'openStoreManager meldet sich wieder ab und verpasst damit das Loeschen');
  // Die Auffrischung muss im Ereignis stehen, nicht in onClose: onClose laeuft,
  // bevor der Server ueberhaupt geantwortet hat.
  assert.match(fn[0], /const onChanged = async \(\) => \{[\s\S]*?loadStores\(\)/,
    'die Auffrischung gehoert in den Ereignis-Handler');
});

// --------------------------------------------------------
// Mengenangabe -> Vorrats-Uebertrag (#1003, Nachzug zur Preis-Umschrift)
// --------------------------------------------------------

/**
 * Fuehrt `fn` unter einer anderen Format-Locale aus. Die Locale ist im Browser
 * eine Haushalts-Einstellung; der Loader dieser Suite liest sie aus
 * `globalThis.__formatLocale` (Standard 'de'), damit hier genau die Faelle
 * messbar sind, an denen die alte Umschrift still falsch lag.
 */
function withFormatLocale(locale, fn) {
  const vorher = globalThis.__formatLocale;
  globalThis.__formatLocale = locale;
  try { fn(); } finally { globalThis.__formatLocale = vorher; }
}

test('parseShoppingQuantity: die Schreibweisen aus dem Seed bleiben, wie sie waren', () => {
  // Gegen echte Werte aus scripts/seed-demo.js gemessen, nicht gegen erfundene:
  // die Freitext-Menge ist meistens gar keine reine Zahl, und ein Test nur auf
  // "250 g" haette die Rueckfaelle darunter nicht bemerkt.
  const p = __test.parseShoppingQuantity;
  assert.deepEqual(p('250 g'), { quantity: 250, unit: 'g' });
  assert.deepEqual(p('1 kg'), { quantity: 1, unit: 'kg' });
  assert.deepEqual(p('2 l'), { quantity: 2, unit: 'l' });
  assert.deepEqual(p('12'), { quantity: 12, unit: 'pcs' });
  // '1 Laib' faengt mit 'l' an: die Einheit braucht die Wortgrenze, sonst waere
  // ein Laib Brot ein Liter.
  assert.deepEqual(p('1 Laib'), { quantity: 1, unit: 'pcs' });
  assert.deepEqual(p('1 Kopf'), { quantity: 1, unit: 'pcs' });
  assert.deepEqual(p('6 × 1 l'), { quantity: 6, unit: 'pcs' });
  assert.deepEqual(p('4er-Pack'), { quantity: 4, unit: 'pcs' });
  assert.deepEqual(p(''), { quantity: 1, unit: 'pcs' });
  assert.deepEqual(p(null), { quantity: 1, unit: 'pcs' });
});

test('parseShoppingQuantity: der Dezimaltrenner kommt aus der Region, nicht aus dem Quelltext', () => {
  // In de trennt das Komma. Das konnte die alte Fassung auch - sie hatte den
  // Trenner nur fest verdrahtet und lag damit ueberall sonst falsch.
  withFormatLocale('de', () => {
    assert.deepEqual(__test.parseShoppingQuantity('1,5 kg'), { quantity: 1.5, unit: 'kg' });
  });
  // In en-US und de-CH trennt der Punkt.
  withFormatLocale('en-US', () => {
    assert.deepEqual(__test.parseShoppingQuantity('1.5 kg'), { quantity: 1.5, unit: 'kg' });
  });
  withFormatLocale('de-CH', () => {
    assert.deepEqual(__test.parseShoppingQuantity('0.5 l'), { quantity: 0.5, unit: 'l' });
  });
});

test('parseShoppingQuantity: eine gruppierte Menge wird abgewiesen, nicht geraten', () => {
  // Der Kern des Fehlers: das Gruppierungszeichen ist regionsabhaengig, und
  // beide Deutungen sind vertretbar. "1,000 g" heisst in en-US tausend Gramm,
  // als Dezimalzahl aber ein Gramm - die falsche liegt um den Faktor 1000
  // daneben, und die alte Fassung nahm sie stillschweigend (Menge 1, Einheit g).
  //
  // Abgewiesen wird auf den Standard, nicht auf "1 g": ein Wert mit Einheit
  // sieht nach einer verstandenen Angabe aus. "1 Stueck" sagt sichtbar, dass
  // nichts erkannt wurde, und der Uebernahme-Dialog zeigt beides in einem Feld,
  // das sich korrigieren laesst.
  withFormatLocale('en-US', () => {
    assert.deepEqual(__test.parseShoppingQuantity('1,000 g'), { quantity: 1, unit: 'pcs' });
  });
  withFormatLocale('de', () => {
    assert.deepEqual(__test.parseShoppingQuantity('1.000 g'), { quantity: 1, unit: 'pcs' });
  });
  // Zwei Stellen hinter dem Trenner sind nicht mehrdeutig und bleiben Dezimalangabe.
  withFormatLocale('en-US', () => {
    assert.deepEqual(__test.parseShoppingQuantity('1.25 kg'), { quantity: 1.25, unit: 'kg' });
  });
});

test('parseShoppingQuantity: oestliche Ziffern kommen ueberhaupt an', () => {
  // `\d` ist in JavaScript ASCII. Unter fa oder ar-EG zeigt die Oberflaeche
  // ihre eigenen Ziffern, und wer sie eintippt, traf die alte Regex nicht -
  // die Menge fiel wortlos auf 1 Stueck zurueck, egal was dastand.
  withFormatLocale('fa', () => {
    assert.deepEqual(__test.parseShoppingQuantity('۲۵۰ g'), { quantity: 250, unit: 'g' });
    assert.deepEqual(__test.parseShoppingQuantity('۱٫۵ kg'), { quantity: 1.5, unit: 'kg' });
    // Das Einheitenwort bleibt bewusst unuebersetzt (siehe Kopf der Funktion):
    // erkannt wird die ZAHL, das Wort landet bei 'Stueck'.
    assert.deepEqual(__test.parseShoppingQuantity('۲۵۰ گرم'), { quantity: 250, unit: 'pcs' });
  });
  withFormatLocale('ar-EG', () => {
    assert.deepEqual(__test.parseShoppingQuantity('٢٥٠ g'), { quantity: 250, unit: 'g' });
    // Auch hier gilt die Gruppierung der Region (٬), nicht die von en-US. Die
    // fuehrende Ziffer ist bewusst NICHT die 1: mit „١٬٠٠٠ g" war dieser Test
    // gruen, obwohl die Umschrift die Gruppierung gar nicht erkannte - der
    // abgeschnittene Anfang „1" traf zufaellig denselben Wert wie der Standard.
    // Ein Guard, dessen Erwartung auf zwei Wegen erreichbar ist, misst nichts.
    assert.deepEqual(__test.parseShoppingQuantity('٢٬٠٠٠ g'), { quantity: 1, unit: 'pcs' });
  });
});

test('parseShoppingQuantity: eine mitten im Trenner abgeschnittene Menge wird abgewiesen', () => {
  // Die Gruppierungspruefung greift am MUSTER: drei Ziffern hinter dem Trenner.
  // „٢٬٥٠" hat zwei, ist also keine erkannte Gruppierung - und ein Zeichen, das
  // die Region ueberhaupt nicht als Trenner kennt, steht sowieso einfach da.
  // Diese Regex liest nur den ANFANG und naehme daraus wortlos die 2.
  withFormatLocale('ar-EG', () => {
    assert.deepEqual(__test.parseShoppingQuantity('٢٬٥٠ g'), { quantity: 1, unit: 'pcs' });
  });
  // Unter fa trennt das ASCII-Komma nichts.
  withFormatLocale('fa', () => {
    assert.deepEqual(__test.parseShoppingQuantity('1,5 kg'), { quantity: 1, unit: 'pcs' });
  });
  // Der Schweizer Gruppierungsapostroph, den weder de noch en-US kennt.
  withFormatLocale('de', () => {
    assert.deepEqual(__test.parseShoppingQuantity("1'000 g"), { quantity: 1, unit: 'pcs' });
  });
  // Ein Leerzeichen trennt dagegen zwei Angaben und schneidet nichts ab.
  withFormatLocale('de', () => {
    assert.deepEqual(__test.parseShoppingQuantity('6 × 1 l'), { quantity: 6, unit: 'pcs' });
  });
  // Und ein `x` ist kein Trenner: nach ihm ist die Zahl vollstaendig gelesen. Die
  // Pruefung war erst „irgendein Zeichen zwischen zwei Ziffern" und traf damit
  // die Multiplikator-Schreibweise mit, die der Kommentar an der Regex
  // ausdruecklich lesbar halten will.
  withFormatLocale('de', () => {
    assert.deepEqual(__test.parseShoppingQuantity('2x500 g'), { quantity: 2, unit: 'pcs' });
    assert.deepEqual(__test.parseShoppingQuantity('3x'), { quantity: 3, unit: 'pcs' });
    assert.deepEqual(__test.parseShoppingQuantity('4er-Pack'), { quantity: 4, unit: 'pcs' });
    // Die kompakte Form auch mit dem typografischen Kreuz.
    assert.deepEqual(__test.parseShoppingQuantity('2×500 ml'), { quantity: 2, unit: 'pcs' });
  });
});

test('parseShoppingQuantity: eine Gruppierung im REST laesst die fuehrende Menge stehen', () => {
  // „6 × 1.000 ml" ist eine ganz gewoehnliche Einkaufszeile: sechs Flaschen zu
  // je einem Liter. Gelesen wird nur die 6, die 1.000 wird gar nicht angefasst -
  // sie darf die Zeile deshalb auch nicht abweisen. Vorher fiel sie auf 1 Stueck.
  withFormatLocale('de', () => {
    assert.deepEqual(__test.parseShoppingQuantity('6 × 1.000 ml'), { quantity: 6, unit: 'pcs' });
  });
  withFormatLocale('en-US', () => {
    assert.deepEqual(__test.parseShoppingQuantity('6 × 1,000 ml'), { quantity: 6, unit: 'pcs' });
  });
  withFormatLocale('ar-EG', () => {
    assert.deepEqual(__test.parseShoppingQuantity('٦ × ١٬٠٠٠ ml'), { quantity: 6, unit: 'pcs' });
  });
  // Im fuehrenden Token wird weiter abgewiesen - die Eingrenzung ist kein Freibrief.
  withFormatLocale('de', () => {
    assert.deepEqual(__test.parseShoppingQuantity('1.000 g'), { quantity: 1, unit: 'pcs' });
  });
});

test('parseShoppingQuantity: der Trenner der Region bleibt der Trenner, auch nach der Gruppierungspruefung', () => {
  // Gegenprobe zur REIHENFOLGE in toDecimalString. Wuerde die Gruppierung erst
  // nach dem Ersetzen des Dezimaltrenners geprueft, waere „1,000" in de schon ein
  // „1.000" - und der Punkt IST dort das Gruppierungszeichen. Eine gueltige
  // Menge von einem Gramm floege dann als vermeintlich gruppiert raus.
  withFormatLocale('de', () => {
    assert.deepEqual(__test.parseShoppingQuantity('1,000 g'), { quantity: 1, unit: 'g' });
  });
  withFormatLocale('en-US', () => {
    assert.deepEqual(__test.parseShoppingQuantity('1.000 g'), { quantity: 1, unit: 'g' });
  });
});

// --------------------------------------------------------
// Abhaken gegen eine ueberholende Auffrischung
//
// WARUM ALS REIHENFOLGE-TEST: der Fehler ist nicht „es fehlt eine Wache",
// sondern „die Antwort trifft NACH der Bearbeitung ein". Eine Textprobe auf das
// Vorhandensein von `pendingChecks` bliebe gruen, auch wenn der Merker zum
// falschen Zeitpunkt geraeumt wird - und genau daran ist die erste Fassung
// dieses Fixes gescheitert (Loeschen beim PATCH-Erfolg kam zu frueh). Die Tests
// unten stellen die Reihenfolge deshalb wirklich: der GET wird von Hand
// aufgeloest, nachdem der PATCH durch ist.
// --------------------------------------------------------

/** Container ohne DOM: alle Render-Helfer steigen an ihrem Null-Guard aus. */
function makeNullContainer() {
  return { querySelector: () => null, querySelectorAll: () => [] };
}

/** Ein von Hand aufloesbares Versprechen - damit steht die Reihenfolge fest. */
function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function milk(isChecked) {
  return { id: 10, name: 'Milch', is_checked: isChecked, category: 'Sonstiges', sort_order: 0 };
}

test('Abhaken ueberlebt eine Auffrischung, deren GET aelter ist als der PATCH', async () => {
  resetShoppingState();
  __test.intents.clear();
  __test.state.lists = [{ id: 1, name: 'Einkauf', item_total: 1, item_checked: 0 }];
  __test.state.items = [milk(0)];

  const gate = deferred();
  globalThis.__apiStub = {
    // Der Schnappschuss dieser Auffrischung ist VOR dem Abhaken entstanden.
    get: () => gate.promise,
    patch: async () => ({ data: null }),
  };

  // 1. Eine Auffrischung geht los (Kategorie-Manager, Ladenverwaltung, Import).
  const loading = __test.loadItems(1);
  // 2. Die Liste ist bedienbar: der Nutzer hakt ab, der PATCH ist durch.
  await __test.toggleShoppingItem(10, 0, makeNullContainer());
  assert.equal(__test.checkedOf(__test.state.items[0]), 1, 'optimistisch abgehakt');
  // 3. ERST JETZT trifft die alte Antwort ein.
  gate.resolve({ data: [milk(0)] });
  await loading;

  assert.equal(__test.checkedOf(__test.state.items[0]), 1,
    'die alte Antwort darf die Bearbeitung nicht zurueckdrehen');
  delete globalThis.__apiStub;
});

test('ein spaeter begonnenes Laden raeumt den Merker - fremde Aenderungen kommen durch', async () => {
  resetShoppingState();
  __test.intents.clear();
  __test.state.lists = [{ id: 1, name: 'Einkauf', item_total: 1, item_checked: 0 }];
  __test.state.items = [milk(0)];

  globalThis.__apiStub = { get: async () => ({ data: [milk(0)] }), patch: async () => ({ data: null }) };
  await __test.toggleShoppingItem(10, 0, makeNullContainer());
  assert.equal(__test.checkedOf(__test.state.items[0]), 1);

  // Dieses Laden beginnt NACH der Bestaetigung: sein Schnappschuss kennt den
  // Wert, seine Antwort ist die frischere Wahrheit. Haelt der Merker hier noch,
  // koennte niemand im Haushalt den Artikel je wieder zurueckholen.
  await __test.loadItems(1);
  assert.equal(__test.checkedOf(__test.state.items[0]), 0,
    'ein Merker, der nie geraeumt wird, macht den Server unwirksam');
  assert.equal(__test.intents.size, 0, 'kein Rest im Merker');
  delete globalThis.__apiStub;
});

test('scheitert der PATCH, bleibt kein Merker stehen', async () => {
  resetShoppingState();
  __test.intents.clear();
  __test.state.lists = [{ id: 1, name: 'Einkauf', item_total: 1, item_checked: 0 }];
  __test.state.items = [milk(0)];

  const toasts = [];
  global.window.yuvomi.showToast = (msg, tone) => toasts.push([msg, tone]);
  globalThis.__apiStub = {
    get: async () => ({ data: [milk(0)] }),
    patch: async () => { throw Object.assign(new Error('nope'), { data: { error: 'kaputt' } }); },
  };

  await __test.toggleShoppingItem(10, 0, makeNullContainer());
  assert.equal(__test.checkedOf(__test.state.items[0]), 0, 'zurueckgedreht');
  assert.equal(__test.intents.size, 0, 'ein gescheiterter Wunsch darf nichts auftragen');
  assert.equal(toasts.length, 1);

  // Und die naechste Auffrischung traegt nichts nach.
  await __test.loadItems(1);
  assert.equal(__test.checkedOf(__test.state.items[0]), 0);
  delete globalThis.__apiStub;
  delete global.window.yuvomi.showToast;
});

test('eine aeltere Antwort, die NACH einer juengeren landet, fasst den Stand nicht mehr an', async () => {
  // Der Fall, den `settledAt` allein nicht deckt (Codex-Befund P1 zu PR #1072):
  // die juengere Antwort raeumt den Merker zu Recht - sie kennt den Wert -, und
  // die aeltere schrieb danach den Stand von vor der Bearbeitung zurueck.
  resetShoppingState();
  __test.intents.clear();
  __test.state.lists = [{ id: 1, name: 'Einkauf', item_total: 1, item_checked: 0 }];
  __test.state.items = [milk(0)];

  const alt = deferred();   // Schnappschuss VOR dem Abhaken
  const neu = deferred();   // Schnappschuss NACH der Bestaetigung
  const gates = [alt, neu];
  globalThis.__apiStub = { get: () => gates.shift().promise, patch: async () => ({ data: null }) };

  const ladenAlt = __test.loadItems(1);            // beginnt zuerst
  await __test.toggleShoppingItem(10, 0, makeNullContainer());
  const ladenNeu = __test.loadItems(1);            // beginnt danach

  // Die JUENGERE landet zuerst und raeumt den Merker.
  neu.resolve({ data: [milk(1)] });
  await ladenNeu;
  assert.equal(__test.checkedOf(__test.state.items[0]), 1);
  assert.equal(__test.intents.size, 0, 'die juengere Antwort kennt den Wert, der Merker darf gehen');

  // Und jetzt trifft die AELTERE ein.
  alt.resolve({ data: [milk(0)] });
  await ladenAlt;
  assert.equal(__test.checkedOf(__test.state.items[0]), 1,
    'eine ueberholte Antwort darf den bereits angewandten Stand nicht mehr ueberschreiben');
  delete globalThis.__apiStub;
});

test('scheitert der PATCH, springt die Zeile auf den FRISCHEN Serverstand zurueck', async () => {
  // Ohne diesen Weg naehme der Ruecksprung den Wert von vor dem Antippen - eine
  // Angabe, die der Server nie hatte, wenn jemand anderes die Zeile inzwischen
  // umgestellt hat. Die Auffrischung ist die letzte Stelle, die davon weiss.
  resetShoppingState();
  __test.intents.clear();
  __test.state.lists = [{ id: 1, name: 'Einkauf', item_total: 1, item_checked: 0 }];
  __test.state.items = [milk(0)];

  const toasts = [];
  global.window.yuvomi.showToast = (msg) => toasts.push(msg);
  const patchGate = deferred();
  globalThis.__apiStub = {
    // Jemand anderes im Haushalt hat den Artikel ebenfalls abgehakt.
    get: async () => ({ data: [milk(1)] }),
    patch: () => patchGate.promise,
  };

  const abhaken = __test.toggleShoppingItem(10, 0, makeNullContainer());
  await __test.loadItems(1);
  assert.equal(__test.checkedOf(__test.state.items[0]), 1);

  patchGate.promise.catch(() => {});
  patchGate.resolve(Promise.reject(Object.assign(new Error('nope'), { data: { error: 'kaputt' } })));
  await abhaken;

  assert.equal(__test.checkedOf(__test.state.items[0]), 1,
    'der Ruecksprung muss den frischen Serverstand treffen, nicht den Stand von vor dem Antippen');
  assert.equal(__test.state.lists[0].item_checked, 1, 'und der Zaehler muss dazu passen');
  assert.equal(toasts.length, 1);
  delete globalThis.__apiStub;
  delete global.window.yuvomi.showToast;
});

// --------------------------------------------------------
// Eine Antwort aus dem Offline-Cache ist kein Beweis
//
// `/shopping` steht in `API_CACHE_WHITELIST` (sw.js). Faellt das Netz aus,
// liefert `networkFirstApi` die zuletzt gecachte Antwort mit ihrem
// urspruenglichen Status 200 - vom Aufrufer sonst nicht von einer frischen zu
// unterscheiden, und eine Mutation leert diesen Cache nicht. Genau der Fall im
// Laden bei wackligem Netz (Codex-Befund P1 zu PR #1072).
// --------------------------------------------------------

test('eine gecachte Antwort raeumt den Merker NICHT', async () => {
  resetShoppingState();
  __test.intents.clear();
  __test.state.lists = [{ id: 1, name: 'Einkauf', item_total: 1, item_checked: 0 }];
  __test.state.items = [milk(0)];

  globalThis.__apiStub = {
    // Der Cache-Stand ist von VOR dem Abhaken - und traegt trotzdem 200.
    getWithSource: async () => ({ data: { data: [milk(0)] }, fromCache: true }),
    patch: async () => ({ data: null }),
  };

  await __test.toggleShoppingItem(10, 0, makeNullContainer());
  assert.equal(__test.checkedOf(__test.state.items[0]), 1);

  // Ein spaeter begonnenes Laden - aber offline. Es beweist nichts.
  await __test.loadItems(1);
  assert.equal(__test.checkedOf(__test.state.items[0]), 1,
    'offline darf die Zeile nicht auf den Cache-Stand zurueckspringen');
  assert.equal(__test.intents.size, 1, 'der Merker muss stehen bleiben');

  // Sobald das Netz wieder da ist, raeumt eine echte Antwort auf.
  globalThis.__apiStub.getWithSource = async () => ({ data: { data: [milk(1)] }, fromCache: false });
  await __test.loadItems(1);
  assert.equal(__test.intents.size, 0, 'die netzfrische Antwort raeumt');
  delete globalThis.__apiStub;
});

test('eine gecachte Antwort setzt die Ruecksprung-Grundlage nicht neu', async () => {
  // Sonst haette der Cache-Stand das letzte Wort darueber, was „der Server
  // zuletzt sagte" - und er ist beliebig alt.
  resetShoppingState();
  __test.intents.clear();
  __test.state.lists = [{ id: 1, name: 'Einkauf', item_total: 1, item_checked: 0 }];
  __test.state.items = [milk(0)];

  global.window.yuvomi.showToast = () => {};
  const patchGate = deferred();
  globalThis.__apiStub = {
    // Erst frisch: jemand anderes hat den Artikel ebenfalls abgehakt.
    getWithSource: async () => ({ data: { data: [milk(1)] }, fromCache: false }),
    patch: () => patchGate.promise,
  };

  const abhaken = __test.toggleShoppingItem(10, 0, makeNullContainer());
  await __test.loadItems(1);

  // Dann faellt das Netz aus, und der Cache traegt noch den Stand von vorher.
  globalThis.__apiStub.getWithSource = async () => ({ data: { data: [milk(0)] }, fromCache: true });
  await __test.loadItems(1);

  patchGate.promise.catch(() => {});
  patchGate.resolve(Promise.reject(Object.assign(new Error('nope'), { data: { error: 'kaputt' } })));
  await abhaken;

  assert.equal(__test.checkedOf(__test.state.items[0]), 1,
    'die Grundlage bleibt die frische 1, nicht die gecachte 0');
  delete globalThis.__apiStub;
  delete global.window.yuvomi.showToast;
});

test('eine gecachte Antwort verdraengt keine echte, die spaeter eintrifft', async () => {
  // Bei wackligem Netz scheitert die SPAETER begonnene Anfrage oft zuerst und
  // wird aus dem Cache bedient. Zoege sie die Wasserstandsmarke hoch, waere die
  // frueher begonnene, aber ECHTE Antwort danach „veraltet" - der Cache haette
  // den frischen Stand verdraengt (Codex-Befund P2 zu PR #1072).
  resetShoppingState();
  __test.intents.clear();
  __test.state.lists = [{ id: 1, name: 'Einkauf', item_total: 1, item_checked: 0 }];
  __test.state.items = [milk(0)];

  const frisch = deferred();
  const antworten = [
    () => frisch.promise,                                             // beginnt zuerst, antwortet spaet
    async () => ({ data: { data: [milk(0)] }, fromCache: true }),     // beginnt spaeter, aus dem Cache
  ];
  globalThis.__apiStub = { getWithSource: () => antworten.shift()(), patch: async () => ({ data: null }) };

  const ladenFrisch = __test.loadItems(1);   // startedAt 1
  await __test.loadItems(1);                 // startedAt 2, aus dem Cache

  frisch.resolve({ data: { data: [milk(1)] }, fromCache: false });
  await ladenFrisch;

  assert.equal(__test.checkedOf(__test.state.items[0]), 1,
    'die echte Antwort muss ankommen, auch wenn eine gecachte spaeter begann');
  delete globalThis.__apiStub;
});

test('ein zweites Antippen springt nicht am ersten, erfolgreichen vorbei zurueck', async () => {
  // Auffrischung startet bei is_checked 0, das erste Antippen (0->1) wird
  // BESTAETIGT, das zweite (1->0) laeuft noch, dann trifft die alte Antwort
  // ein. Setzte sie die Ruecksprung-Grundlage auf ihre 0, landete ein
  // Fehlschlag des zweiten Antippens bei 0 - obwohl der Server 1 bestaetigt hat.
  resetShoppingState();
  __test.intents.clear();
  __test.state.lists = [{ id: 1, name: 'Einkauf', item_total: 1, item_checked: 0 }];
  __test.state.items = [milk(0)];

  global.window.yuvomi.showToast = () => {};
  const alt = deferred();
  let patchZaehler = 0;
  globalThis.__apiStub = {
    getWithSource: () => alt.promise,
    patch: async () => {
      patchZaehler += 1;
      if (patchZaehler === 1) return { data: null };                  // erstes Antippen: Erfolg
      throw Object.assign(new Error('nope'), { data: { error: 'kaputt' } });
    },
  };

  const laden = __test.loadItems(1);                                   // Schnappschuss: 0
  await __test.toggleShoppingItem(10, 0, makeNullContainer());         // 0 -> 1, bestaetigt
  assert.equal(__test.checkedOf(__test.state.items[0]), 1);

  const zweites = __test.toggleShoppingItem(10, 1, makeNullContainer()); // 1 -> 0, ausstehend
  alt.resolve({ data: { data: [milk(0)] }, fromCache: false });
  await laden;
  await zweites;

  assert.equal(__test.checkedOf(__test.state.items[0]), 1,
    'der Ruecksprung gehoert auf die bestaetigte 1, nicht auf die 0 des alten Schnappschusses');
  delete globalThis.__apiStub;
  delete global.window.yuvomi.showToast;
});

// --------------------------------------------------------
// Die Liste gehoert zur Aktion (Codex-Befunde P1/P2 zu PR #1072, vierte Runde)
// --------------------------------------------------------

test('eine Auffrischung von Liste B raeumt den Merker von Liste A nicht', async () => {
  resetShoppingState();
  __test.intents.clear();
  __test.state.lists = [
    { id: 1, name: 'A', item_total: 1, item_checked: 0 },
    { id: 2, name: 'B', item_total: 0, item_checked: 0 },
  ];
  __test.state.activeListId = 1;
  __test.state.items = [milk(0)];

  globalThis.__apiStub = {
    getWithSource: async () => ({ data: { data: [] }, fromCache: false }),
    patch: async () => ({ data: null }),
  };

  await __test.toggleShoppingItem(10, 0, makeNullContainer());
  assert.equal(__test.intents.size, 1);

  // Zu B wechseln und dort auffrischen. Die Antwort sagt ueber A nichts aus.
  __test.state.activeListId = 2;
  await __test.loadItems(2);
  assert.equal(__test.intents.size, 1,
    'der Merker von Liste A gehoert nicht Liste B');

  // Zurueck zu A, und diesmal offline: ohne den Merker kaeme der Cache-Stand.
  __test.state.activeListId = 1;
  globalThis.__apiStub.getWithSource = async () => ({ data: { data: [milk(0)] }, fromCache: true });
  await __test.loadItems(1);
  assert.equal(__test.checkedOf(__test.state.items[0]), 1,
    'der abgehakte Artikel muss den Umweg ueber B ueberstehen');
  delete globalThis.__apiStub;
});

test('die Wasserstandsmarke gilt je Liste, nicht global', async () => {
  resetShoppingState();
  __test.intents.clear();
  __test.state.lists = [
    { id: 1, name: 'A', item_total: 1, item_checked: 0 },
    { id: 2, name: 'B', item_total: 0, item_checked: 0 },
  ];
  __test.state.activeListId = 1;
  __test.state.items = [];

  const aLauf = deferred();
  const antworten = [
    () => aLauf.promise,                                                 // A, beginnt zuerst
    async () => ({ data: { data: [] }, fromCache: false }),              // B, beginnt danach
  ];
  globalThis.__apiStub = { getWithSource: () => antworten.shift()() };

  const ladenA = __test.loadItems(1);      // startedAt 1, Liste A
  __test.state.activeListId = 2;
  await __test.loadItems(2);               // startedAt 2, Liste B - zieht global die Marke hoch
  __test.state.activeListId = 1;

  aLauf.resolve({ data: { data: [milk(0)] }, fromCache: false });
  await ladenA;

  assert.equal(__test.state.items.length, 1,
    'die brauchbare A-Antwort darf nicht daran scheitern, dass B dazwischen lief');
  delete globalThis.__apiStub;
});

test('zweimal antippen vor dem ersten Rundlauf: der Ruecksprung bleibt der Serverstand', async () => {
  // Beide PATCHes scheitern. Der erste schweigt wegen der Folgenummer, der
  // zweite springt zurueck - und zwar auf 0, nicht auf den optimistischen
  // Zwischenwert 1, den der Server nie hatte.
  resetShoppingState();
  __test.intents.clear();
  __test.state.lists = [{ id: 1, name: 'Einkauf', item_total: 1, item_checked: 0 }];
  __test.state.items = [milk(0)];

  global.window.yuvomi.showToast = () => {};
  const tore = [deferred(), deferred()];
  let n = 0;
  globalThis.__apiStub = {
    getWithSource: async () => ({ data: { data: [milk(0)] }, fromCache: false }),
    patch: () => tore[n++].promise,
  };

  const erstes  = __test.toggleShoppingItem(10, 0, makeNullContainer());   // 0 -> 1
  const zweites = __test.toggleShoppingItem(10, 1, makeNullContainer());   // 1 -> 0

  for (const tor of tore) {
    tor.promise.catch(() => {});
    tor.resolve(Promise.reject(Object.assign(new Error('nope'), { data: { error: 'kaputt' } })));
  }
  await Promise.all([erstes, zweites]);

  assert.equal(__test.checkedOf(__test.state.items[0]), 0,
    'nach zwei Fehlschlaegen gehoert der Stand von vor dem ERSTEN Antippen in die Zeile');
  assert.equal(__test.state.lists[0].item_checked, 0, 'und der Zaehler dazu');
  delete globalThis.__apiStub;
  delete global.window.yuvomi.showToast;
});

test('ein ueberholter, aber ERFOLGREICHER Rundlauf bleibt die Ruecksprung-Grundlage', async () => {
  // Zweimal antippen, der erste PATCH gelingt, der zweite scheitert. Wird der
  // Erfolg des ersten bloss verworfen, springt die Zeile auf den Stand von vor
  // BEIDEN zurueck - der Server steht dann auf dem Wert des ersten
  // (Codex-Befund P2 zu PR #1072, sechste Runde).
  resetShoppingState();
  __test.intents.clear();
  __test.state.lists = [{ id: 1, name: 'Einkauf', item_total: 1, item_checked: 0 }];
  __test.state.activeListId = 1;
  __test.state.items = [milk(0)];

  global.window.yuvomi.showToast = () => {};
  const tore = [deferred(), deferred()];
  let n = 0;
  globalThis.__apiStub = {
    getWithSource: async () => ({ data: { data: [milk(0)] }, fromCache: false }),
    patch: () => tore[n++].promise,
  };

  const erstes  = __test.toggleShoppingItem(10, 0, makeNullContainer());   // 0 -> 1
  const zweites = __test.toggleShoppingItem(10, 1, makeNullContainer());   // 1 -> 0

  tore[0].resolve({ data: null });                                          // erster: Erfolg
  await erstes;
  tore[1].promise.catch(() => {});
  tore[1].resolve(Promise.reject(Object.assign(new Error('nope'), { data: { error: 'kaputt' } })));
  await zweites;

  assert.equal(__test.checkedOf(__test.state.items[0]), 1,
    'der Server steht auf dem Wert des ERSTEN Rundlaufs, dorthin gehoert der Ruecksprung');
  assert.equal(__test.state.lists[0].item_checked, 1, 'und der Zaehler dazu');
  delete globalThis.__apiStub;
  delete global.window.yuvomi.showToast;
});

test('ein Fehlschlag nach dem Listenwechsel dreht den Zaehler der URSPRUNGSLISTE zurueck', async () => {
  // `state.items` traegt dann die Zeilen von B, die Zeile aus A ist nicht mehr
  // zu finden. Stand die Zaehler-Buchung im `if (current)`, blieb die
  // optimistische Erhoehung von A stehen - und `loadItems` frischt nur die
  // Artikel auf, die Zaehler kommen aus `loadLists`.
  resetShoppingState();
  __test.intents.clear();
  __test.state.lists = [
    { id: 1, name: 'A', item_total: 1, item_checked: 0 },
    { id: 2, name: 'B', item_total: 0, item_checked: 0 },
  ];
  __test.state.activeListId = 1;
  __test.state.items = [milk(0)];

  global.window.yuvomi.showToast = () => {};
  const tor = deferred();
  globalThis.__apiStub = {
    getWithSource: async () => ({ data: { data: [] }, fromCache: false }),
    patch: () => tor.promise,
  };

  const abhaken = __test.toggleShoppingItem(10, 0, makeNullContainer());
  assert.equal(__test.state.lists[0].item_checked, 1, 'optimistisch gebucht');

  // Listenwechsel, waehrend der PATCH laeuft.
  __test.state.activeListId = 2;
  __test.state.items = [];

  tor.promise.catch(() => {});
  tor.resolve(Promise.reject(Object.assign(new Error('nope'), { data: { error: 'kaputt' } })));
  await abhaken;

  assert.equal(__test.state.lists[0].item_checked, 0,
    'der Zaehler von Liste A gehoert zurueckgedreht, auch ohne sichtbare Zeile');
  assert.equal(__test.state.lists[1].item_checked, 0, 'und Liste B bleibt unberuehrt');
  delete globalThis.__apiStub;
  delete global.window.yuvomi.showToast;
});

test('ein geloeschter Artikel bucht seinen Zaehler nicht doppelt zurueck', async () => {
  // Abhaken, sofort loeschen, dann scheitert der PATCH. Das Loeschen hat den
  // Zaehler schon korrigiert; ohne Raeumung des Merkers buchte der Fehlschlag
  // ein zweites Mal und hinterliess `item_checked: -1` (Codex-Befund P2 zu
  // PR #1072, siebte Runde - Folge der Zaehlerbuchung aus der sechsten).
  resetShoppingState();
  __test.intents.clear();
  __test.state.lists = [{ id: 1, name: 'Einkauf', item_total: 1, item_checked: 0 }];
  __test.state.activeListId = 1;
  __test.state.items = [milk(0)];

  global.window.yuvomi.showToast = () => {};
  const tor = deferred();
  globalThis.__apiStub = {
    getWithSource: async () => ({ data: { data: [] }, fromCache: false }),
    patch: () => tor.promise,
    delete: async () => ({ data: null }),
  };

  const abhaken = __test.toggleShoppingItem(10, 0, makeNullContainer());
  assert.equal(__test.state.lists[0].item_checked, 1);

  __test.deleteItemUndoable(10, makeNullContainer());
  assert.equal(__test.state.lists[0].item_total, 0);
  assert.equal(__test.state.lists[0].item_checked, 0, 'das Loeschen hat schon korrigiert');
  // Die Absicht bleibt liegen - sie wird beim Zuruecknehmen gebraucht, damit
  // die wiederhergestellte Zeile zeigt, was der Server inzwischen hat. Was das
  // Loeschen ihr nimmt, ist nur die ZAEHLERQUITTUNG.
  assert.equal(__test.intents.size, 1, 'die Absicht ueberlebt fuer das Zuruecknehmen');
  assert.equal(__test.intents.get(10).delta, 0, 'ihre Buchung ist mit dem Loeschen abgegolten');

  tor.promise.catch(() => {});
  tor.resolve(Promise.reject(Object.assign(new Error('nope'), { data: { error: 'kaputt' } })));
  await abhaken;

  assert.equal(__test.state.lists[0].item_checked, 0,
    'der Fehlschlag darf nicht ein zweites Mal buchen');
  delete globalThis.__apiStub;
  delete global.window.yuvomi.showToast;
});

test('offline zurueck zu Liste A zeigt A, nicht die liegengebliebenen Artikel von B', async () => {
  // A laden, zu B wechseln, offline zurueck zu A. Die gecachte A-Antwort wurde
  // abgelehnt, weil A einmal netzfrisch geladen war - und `switchList` loescht
  // danach den Fehler und zeichnet die noch liegenden Artikel von B unter dem
  // Reiter von A. Ohne Meldung, und jede Aktion traf ab da die falsche Liste
  // (Codex-Befund P1 zu PR #1072, neunte Runde).
  resetShoppingState();
  __test.state.lists = [
    { id: 1, name: 'A', item_total: 1, item_checked: 0 },
    { id: 2, name: 'B', item_total: 1, item_checked: 0 },
  ];
  const aWare = { ...milk(0), id: 10, name: 'Milch' };
  const bWare = { ...milk(0), id: 20, name: 'Brot' };

  const antworten = [
    async () => ({ data: { data: [aWare] }, fromCache: false }),   // A, netzfrisch
    async () => ({ data: { data: [bWare] }, fromCache: false }),   // B, netzfrisch
    async () => ({ data: { data: [aWare] }, fromCache: true }),    // A, offline
  ];
  globalThis.__apiStub = { getWithSource: () => antworten.shift()() };

  __test.state.activeListId = 1; await __test.loadItems(1);
  assert.deepEqual(__test.state.items.map((i) => i.id), [10]);

  __test.state.activeListId = 2; await __test.loadItems(2);
  assert.deepEqual(__test.state.items.map((i) => i.id), [20]);

  __test.state.activeListId = 1; await __test.loadItems(1);
  assert.deepEqual(__test.state.items.map((i) => i.id), [10],
    'die gecachte A-Antwort gehoert angewandt, solange der Bestand einer anderen Liste gehoert');
  delete globalThis.__apiStub;
});

test('nach einem Fehlschlag derselben Liste wird die gecachte Antwort angenommen', async () => {
  // Folge des Zugehoerigkeits-Fixes: `state.items = []` im Fehlerzweig liess
  // `_itemsListId` stehen, und die Cache-Wache lehnte danach die einzige
  // brauchbare Antwort ab - die Liste stand als echt leer da, ohne Meldung
  // (Codex-Befund P2 zu PR #1072, zehnte Runde).
  resetShoppingState();
  __test.state.lists = [{ id: 1, name: 'A', item_total: 1, item_checked: 0 }];

  const antworten = [
    async () => ({ data: { data: [milk(0)] }, fromCache: false }),   // erst netzfrisch
    async () => { throw Object.assign(new Error('500'), { data: { error: 'kaputt' } }); },
    async () => ({ data: { data: [milk(0)] }, fromCache: true }),    // Wiederholung: aus dem Cache
  ];
  globalThis.__apiStub = { getWithSource: () => antworten.shift()() };

  await __test.loadItems(1);
  assert.equal(__test.state.items.length, 1);

  // Derselbe Ablauf wie in `switchList`: Fehler, Bestand verwerfen.
  await __test.loadItems(1).catch(() => { __test.clearItems(); });
  assert.equal(__test.state.items.length, 0);

  await __test.loadItems(1);
  assert.equal(__test.state.items.length, 1,
    'ist der Bestand verworfen, ist die gecachte Antwort das Beste, was es gibt');
  delete globalThis.__apiStub;
});

// --------------------------------------------------------
// Live-Aktualisierung: fremde Aenderungen erreichen den Zettel
// --------------------------------------------------------

const bread = (isChecked = 0) => ({ id: 11, name: 'Brot', is_checked: isChecked, category: 'Backwaren', sort_order: 0 });
const listRow = (checked) => ({ id: 1, name: 'Einkauf', item_total: 2, item_checked: checked });

test('liveRefreshPlan: bewegt sich nur der Haken, bleiben die Zeilen stehen - auch in anderer Reihenfolge', () => {
  const previous = [milk(0), bread(0)];
  // Der Server sortiert Abgehaktes ans Ende: die Antwort kommt in anderer Reihenfolge.
  const fresh = [bread(0), milk(1)];
  const plan = __test.liveRefreshPlan(previous, fresh);
  assert.equal(plan.rebuild, false, 'dieselben Artikel, dieselben Namen: kein Neuaufbau, keine Animation, kein Sprung');
  assert.deepEqual(plan.changed.map((i) => i.id), [10], 'nur die Zeile mit dem neuen Haken wird umgefaerbt');
});

test('liveRefreshPlan: ein neuer, fehlender, umbenannter oder umsortierter Artikel baut die Liste neu', () => {
  const previous = [milk(0), bread(0)];
  const rebuilds = {
    'dazugekommen':      [milk(0), bread(0), { id: 12, name: 'Eier', is_checked: 0, category: 'Sonstiges' }],
    'verschwunden':      [milk(0)],
    'umbenannt':         [{ ...milk(0), name: 'Hafermilch' }, bread(0)],
    'andere Kategorie':  [{ ...milk(0), category: 'Kuehlregal' }, bread(0)],
    'andere Menge':      [{ ...milk(0), quantity: '2 l' }, bread(0)],
  };
  for (const [why, fresh] of Object.entries(rebuilds)) {
    assert.equal(__test.liveRefreshPlan(previous, fresh).rebuild, true, why);
  }
  assert.equal(__test.liveRefreshPlan([], []).rebuild, false, 'leer zu leer ist keine Bewegung');
});

test('refreshFromFeed: die aktive Liste laedt Listen UND Artikel, eine andere nur die Listenzeile', async () => {
  resetShoppingState();
  __test.state.lists = [listRow(0), { id: 2, name: 'Baumarkt', item_total: 0, item_checked: 0 }];
  __test.state.items = [milk(0), bread(0)];

  const calls = [];
  globalThis.__apiStub = {
    get: async (path) => { calls.push(path); return { data: [listRow(1), { id: 2, name: 'Baumarkt', item_total: 3, item_checked: 0 }] }; },
    getWithSource: async (path) => { calls.push(path); return { data: { data: [bread(0), milk(1)] }, fromCache: false }; },
  };
  const signal = new AbortController().signal;

  await __test.refreshFromFeed(makeNullContainer(), 1, signal);
  assert.deepEqual([...calls].sort(), ['/shopping', '/shopping/1/items']);
  assert.equal(__test.state.items.find((i) => i.id === 10).is_checked, 1, 'der fremde Haken steht im Serverstand');
  assert.equal(__test.state.lists[0].item_checked, 1, 'der Zaehler im Reiter folgt');

  calls.length = 0;
  await __test.refreshFromFeed(makeNullContainer(), 2, signal);
  assert.deepEqual(calls, ['/shopping'], 'fuer eine andere Liste reicht der Zaehler - switchList laedt ohnehin frisch');
  assert.equal(__test.state.lists[1].item_total, 3);
  delete globalThis.__apiStub;
});

test('refreshFromFeed: ein Fehler beim Nachladen bleibt still und laesst den letzten Stand stehen', async () => {
  resetShoppingState();
  __test.state.lists = [listRow(0)];
  __test.state.items = [milk(0)];
  globalThis.__apiStub = {
    get: async () => { throw Object.assign(new Error('500'), { data: { error: 'kaputt' } }); },
    getWithSource: async () => { throw Object.assign(new Error('500'), { data: { error: 'kaputt' } }); },
  };
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  await assert.doesNotReject(() => __test.refreshFromFeed(makeNullContainer(), 1, new AbortController().signal));
  console.warn = origWarn;
  assert.equal(__test.state.items.length, 1, 'der Bestand bleibt');
  assert.equal(__test.state.itemsError, null, 'kein Fehlerbild fuer eine stille Auffrischung');
  // loadLists() faengt selbst und leert die Listen - eine stille Auffrischung
  // darf daraus weder leere Reiter noch einen Merker machen, der jede weitere
  // Meldung abweist.
  assert.equal(__test.state.lists.length, 1, 'die Reiter bleiben stehen');
  assert.equal(__test.state.listsError, null, 'kein Merker, der die naechste Meldung stumm schaltet');
  delete globalThis.__apiStub;
});

test('refreshFromFeed: die eigene, noch unbestaetigte Bearbeitung ueberlebt die Meldung des Feeds', async () => {
  resetShoppingState();
  __test.intents.clear();
  __test.state.lists = [listRow(0)];
  __test.state.items = [milk(0)];

  const gate = deferred();
  globalThis.__apiStub = {
    get: async () => ({ data: [listRow(0)] }),
    // Die Antwort kennt den Haken noch nicht: der eigene PATCH ist unterwegs.
    getWithSource: async () => ({ data: { data: [milk(0)] }, fromCache: false }),
    patch: () => gate.promise,
  };

  const toggling = __test.toggleShoppingItem(10, 0, makeNullContainer());
  await __test.refreshFromFeed(makeNullContainer(), 1, new AbortController().signal);
  assert.equal(__test.checkedOf(__test.state.items[0]), 1,
    'die Absicht ueberlagert den alten Serverstand - die Zeile springt nicht zurueck');
  assert.equal(__test.intents.size, 1, 'die Absicht steht, bis eine Antwort sie traegt');

  gate.resolve({ data: null });
  await toggling;
  delete globalThis.__apiStub;
});

test('refreshFromFeed: die Meldung der EIGENEN Aenderung erfuellt die Absicht, statt sie zurueckzudrehen', async () => {
  resetShoppingState();
  __test.intents.clear();
  __test.state.lists = [listRow(0)];
  __test.state.items = [milk(0)];

  globalThis.__apiStub = {
    get: async () => ({ data: [listRow(1)] }),
    getWithSource: async () => ({ data: { data: [milk(1)] }, fromCache: false }),
    patch: async () => ({ data: null }),
  };
  await __test.toggleShoppingItem(10, 0, makeNullContainer());
  assert.equal(__test.intents.size, 1);

  // Der Trigger meldet auch den eigenen Haken; die Antwort darauf traegt ihn.
  await __test.refreshFromFeed(makeNullContainer(), 1, new AbortController().signal);
  assert.equal(__test.intents.size, 0, 'die Antwort traegt den gewollten Wert - die Absicht ist erfuellt');
  assert.equal(__test.checkedOf(__test.state.items[0]), 1);
  delete globalThis.__apiStub;
});

test('refreshFromFeed: ein abgebrochener Aufbau zeichnet nichts mehr', async () => {
  resetShoppingState();
  __test.state.lists = [listRow(0)];
  __test.state.items = [milk(0)];
  const gate = deferred();
  globalThis.__apiStub = {
    get: async () => ({ data: [listRow(1)] }),
    getWithSource: () => gate.promise,
  };
  const ac = new AbortController();
  const refreshing = __test.refreshFromFeed(makeNullContainer(), 1, ac.signal);
  ac.abort(); // die Seite wird verlassen, waehrend die Antwort unterwegs ist
  gate.resolve({ data: { data: [milk(1)] }, fromCache: false });
  await refreshing;
  assert.equal(__test.state.lists[0].item_checked, 1,
    'der Serverstand kommt an - er ist die Wahrheit, gleich wer sie noch anschaut');
  delete globalThis.__apiStub;
});

test('refreshFromFeed: ist die aktive Liste weg, wechselt der Zettel auf die erste verbliebene', async () => {
  resetShoppingState();
  __test.state.activeListId = 1;
  __test.state.lists = [listRow(0), { id: 2, name: 'Baumarkt', item_total: 0, item_checked: 0 }];
  __test.state.items = [milk(0)];
  const calls = [];
  globalThis.__apiStub = {
    // Liste 1 hat jemand anderes geloescht: die Antwort kennt nur noch Liste 2.
    get: async (path) => { calls.push(path); return { data: [{ id: 2, name: 'Baumarkt', item_total: 1, item_checked: 0 }] }; },
    getWithSource: async (path) => { calls.push(path); return { data: { data: [bread(0)], list: { id: 2, name: 'Baumarkt' } }, fromCache: false }; },
  };
  await __test.refreshFromFeed(makeNullContainer(), 1, new AbortController().signal);
  assert.equal(__test.state.activeListId, 2, 'die erste verbliebene Liste wird aktiv');
  assert.ok(calls.includes('/shopping/2/items'), 'und geladen');
  assert.deepEqual(__test.state.items.map((i) => i.id), [11]);
  delete globalThis.__apiStub;
});

/** Zwei Makrotasks reichen, damit die Warteschlange Stub-Antworten verarbeitet hat. */
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };

test('wireLiveUpdates: die Abfrage haengt am Router-Signal, eine bewegte Nummer laedt nach, die eigene Quittung erspart das Nachladen', async () => {
  resetShoppingState();
  __test.state.lists = [listRow(0)];
  __test.state.items = [milk(0)];

  let versions = [{ list_id: 1, version: 4 }];
  const calls = [];
  globalThis.__apiStub = {
    get: async (path) => {
      calls.push(path);
      if (path === '/shopping/versions') return { data: versions };
      return { data: [listRow(1)] };
    },
    getWithSource: async (path) => { calls.push(path); return { data: { data: [milk(1)] }, fromCache: false }; },
    patch: async () => ({ data: null, list_change: { list_id: 1, before: 4, after: 6 } }),
  };

  const route = new AbortController();
  try {
    __test.wireLiveUpdates(makeNullContainer(), route.signal);
    await settle();
    assert.deepEqual(calls, ['/shopping/versions'], 'die erste Abfrage setzt nur die Marken');

    // Der eigene Haken: die Quittung rueckt die Marke auf 6 - die naechste
    // Abfrage sieht 6 und laedt NICHT nach.
    await __test.toggleShoppingItem(10, 0, makeNullContainer());
    versions = [{ list_id: 1, version: 6 }];
    calls.length = 0;
    await __test.getLiveFeedForTest().poll();
    await settle();
    assert.deepEqual(calls, ['/shopping/versions'], 'das eigene Werk loest kein Nachladen aus');

    // Jemand anderes: die Nummer steigt ueber die Quittung hinaus.
    versions = [{ list_id: 1, version: 7 }];
    calls.length = 0;
    await __test.getLiveFeedForTest().poll();
    await settle();
    assert.ok(calls.includes('/shopping/1/items'), 'eine fremde Bewegung laedt die aktive Liste nach');

    const first = __test.getLiveFeedForTest();
    __test.wireLiveUpdates(makeNullContainer(), route.signal);
    assert.notEqual(__test.getLiveFeedForTest(), first, 'der naechste Aufbau derselben Seite hat seinen eigenen Feed');
    await settle(); // die erste Abfrage des NEUEN Feeds ist durch
    calls.length = 0;
    await first.poll();
    assert.deepEqual(calls, [], 'der Feed des vorigen Aufbaus fragt nicht mehr');

    route.abort();
    assert.equal(__test.getLiveFeedForTest(), null, 'die Seite verlassen beendet den Feed');
  } finally {
    // Der Takt hinge sonst am Prozess, wenn eine Zusicherung oben scheitert -
    // die Suite endete dann nie.
    route.abort();
    __test.abortLiveUpdatesForTest();
    delete globalThis.__apiStub;
  }
});
