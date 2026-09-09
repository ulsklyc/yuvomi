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
  __test.state.items = [];
  __test.state.categories = [];
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
    // Auch hier gilt die Gruppierung der Region (٬), nicht die von en-US.
    assert.deepEqual(__test.parseShoppingQuantity('١٬٠٠٠ g'), { quantity: 1, unit: 'pcs' });
  });
});
