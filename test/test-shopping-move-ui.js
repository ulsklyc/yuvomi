/**
 * Tests: Listen-Auswahl im Bearbeiten-Dialog des Einkaufs (#1700)
 * Modul: /public/pages/shopping.js
 *
 * Zugesagt in Discussion #998: "The list selector goes into the existing edit
 * dialog". Kein Ziehen, keine eigene "Verschieben"-Aktion.
 *
 * Gemessen wird am echten Markup des Dialogs und an seinem echten
 * Speichern-Handler: ob das Feld neben der Kategorie steht, ob ein gewoehnliches
 * Speichern `list_id` NICHT mitschickt, und was die Seite tut, wenn die Antwort
 * den Artikel auf einer anderen Liste zeigt - er verlaesst den Bestand, beide
 * Zaehler in den Reitern folgen, eine Meldung nennt das Ziel.
 *
 * Die Route selbst (Rang, CalDAV, Absagen) faehrt test-shopping-move.js.
 *
 * Ausführen: npm run test:shopping-move-ui
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };

const { installMiniDom } = await import('./mini-dom.js');
installMiniDom();
const toasts = [];
globalThis.window.yuvomi = { ...globalThis.window.yuvomi, showToast: (text, kind) => { toasts.push([text, kind]); } };
globalThis.document.getElementById = () => null;

const { __test: shopping } = await import('../public/pages/shopping.js');

const item = (over = {}) => ({
  id: 10, list_id: 1, name: 'Dübel', quantity: '20', category: 'Sonstiges', is_checked: 0,
  price_cents: null, store_id: null, url: null, notes: '8 mm', tags: [], sort_order: 1, ...over,
});
const LISTEN = () => [
  { id: 1, name: 'Wocheneinkauf', item_total: 2, item_checked: 1 },
  { id: 2, name: 'Bau & <Markt>', item_total: 4, item_checked: 0 },
];

function zustand(patch = {}) {
  toasts.length = 0;
  shopping.intents.clear();
  shopping.pendingRemovals.clear();
  shopping.resetLoadOrderForTest();
  const lists = LISTEN();
  Object.assign(shopping.state, {
    lists, activeList: lists[0], activeListId: 1, items: [item(), item({ id: 11, name: 'Milch', is_checked: 1 })],
    categories: [{ id: 1, name: 'Sonstiges', icon: 'tag', sort_order: 0 }],
    stores: [], currency: 'EUR', listsError: null, itemsError: null, collapsedCategories: new Set(),
  }, patch);
}

const nullContainer = () => ({ querySelector: () => null, querySelectorAll: () => [], isConnected: true });

/** Oeffnet den Dialog ueber den Modal-Stub und gibt seine Optionen zurueck. */
function oeffne(id = 10) {
  let opts = null;
  globalThis.__openModal = (o) => { opts = o; };
  try {
    shopping.openItemDetails(id, nullContainer());
  } finally {
    delete globalThis.__openModal;
  }
  return opts;
}

/** Kleinstes Panel: Felder mit Wert, ein Formular mit submit-Handler. */
function panel(values) {
  const fields = {};
  for (const [id, value] of Object.entries(values)) fields[`#${id}`] = { value, addEventListener() {} };
  const handlers = {};
  const form = { addEventListener(type, fn) { handlers[type] = fn; } };
  return {
    querySelector: (sel) => (sel === '#item-details-form' ? form : fields[sel] ?? null),
    submit: () => handlers.submit({ preventDefault() {} }),
  };
}

const felder = (over = {}) => ({
  'item-details-name': 'Dübel', 'item-details-qty': '20', 'item-details-cat': 'Sonstiges',
  'item-details-url': '', 'item-details-notes': '8 mm', 'item-details-price': '', 'item-details-store': '',
  'item-details-link': '', 'item-details-cancel': '', 'item-details-delete': '', ...over,
});

/** Speichert den Dialog und schreibt die PATCH-Anfragen mit. */
async function speichere(values, antwort) {
  const gesendet = [];
  const geschlossen = [];
  globalThis.__apiStub = {
    patch: async (path, payload) => { gesendet.push({ path, payload }); return antwort(payload); },
  };
  globalThis.__closeModal = (...args) => { geschlossen.push(args[0] ?? {}); };
  try {
    const opts = oeffne();
    const p = panel(values);
    opts.onSave(p);
    await p.submit();
  } finally {
    delete globalThis.__apiStub;
    delete globalThis.__closeModal;
  }
  return { gesendet, geschlossen };
}

// -------------------------------------------------------------------------
// Das Feld
// -------------------------------------------------------------------------

/** Der Dialog, in seine Formularzeilen zerlegt: das Paar Menge+Kategorie und was darauf folgt. */
function zeilen(content) {
  const [, erstesPaar, zweitesPaar] = content.split('<div class="form-pair">');
  return { mengeKategorie: erstesPaar, preisLaden: zweitesPaar };
}

test('Mit mehreren Listen ist die Liste eine EIGENE Formularzeile unter Menge und Kategorie', () => {
  zustand();
  const { content } = oeffne();
  const { mengeKategorie, preisLaden } = zeilen(content);

  // Menge und Kategorie bleiben nebeneinander, wie ohne das Feld.
  const paarEnde = mengeKategorie.indexOf('<div class="form-rows">');
  assert.ok(paarEnde > 0, 'nach dem Paar folgt der Traeger der Formularzeile (utils/form-row.js)');
  const paar = mengeKategorie.slice(0, paarEnde);
  assert.ok(paar.includes('id="item-details-qty"') && paar.includes('id="item-details-cat"'));
  assert.ok(!paar.includes('item-details-list'), 'die Liste steht NICHT im Paar');
  // ... und das Paar ist GESCHLOSSEN, bevor die Zeile beginnt: Feldgruppe zu, Paar zu, dann der Traeger.
  assert.match(mengeKategorie, /<\/select>\s*<\/div>\s*<\/div>\s*<div class="form-rows">/, 'die Zeile ist ein Geschwister des Paars, kein drittes Feld darin');

  // Die Zeile: Etikett links als <label for>, die Auswahl als ihr Bedienelement.
  const zeile = mengeKategorie.slice(paarEnde);
  assert.match(zeile, /<div class="form-row form-field">/);
  assert.match(zeile, /<label class="form-row__label" for="item-details-list">shopping\.itemListLabel<\/label>/);
  assert.match(zeile, /<div class="form-row__control"><select class="form-input" id="item-details-list">/);
  assert.match(zeile, /<option value="1" selected>Wocheneinkauf<\/option>/, 'die offene Liste ist gewaehlt');
  assert.match(zeile, /<option value="2" >Bau &amp; &lt;Markt&gt;<\/option>/, 'Listennamen sind Nutzerdaten');
  // Und sie steht VOR Preis und Laden.
  assert.ok(preisLaden.includes('id="item-details-price"') && !preisLaden.includes('item-details-list'));
});

test('Der Dialog sieht mit einer Liste aus wie mit mehreren - nur ohne die Zeile', () => {
  zustand();
  const mehrere = oeffne().content;
  shopping.state.lists = [LISTEN()[0]];
  const eine = oeffne().content;
  assert.ok(!eine.includes('form-rows') && !eine.includes('item-details-list'));
  const ohneZeile = mehrere.replace(/<div class="form-rows">[\s\S]*?<\/select><\/div><\/div><\/div>/, '');
  assert.notEqual(ohneZeile, mehrere, 'die Probe hat die Zeile gefunden und entfernt');
  assert.equal(ohneZeile.replace(/\s+/g, ' '), eine.replace(/\s+/g, ' '), 'das uebrige Layout aendert sich nicht mit der Listenzahl');
});


// -------------------------------------------------------------------------
// Speichern
// -------------------------------------------------------------------------

test('Gewoehnliches Speichern schickt keine list_id und laesst den Artikel auf seiner Liste', async () => {
  zustand();
  const { gesendet } = await speichere(felder({ 'item-details-list': '1', 'item-details-name': 'Spreizdübel' }),
    (payload) => ({ data: { ...item(), ...payload }, list_change: { list_id: 1, before: 3, after: 4 } }));

  assert.equal(gesendet.length, 1);
  assert.ok(!('list_id' in gesendet[0].payload), 'die eigene Liste ist kein Umzug');
  assert.deepEqual(shopping.state.items.map((i) => i.id), [10, 11]);
  assert.equal(shopping.state.items[0].name, 'Spreizdübel');
  assert.deepEqual(toasts, []);
});

test('Andere Liste gewaehlt: list_id reist mit den uebrigen Feldern, der Artikel verlaesst den Zettel, die Zaehler folgen', async () => {
  zustand();
  const { gesendet, geschlossen } = await speichere(felder({ 'item-details-list': '2', 'item-details-qty': '50' }),
    (payload) => ({ data: { ...item(), ...payload }, list_change: { list_id: 1, before: 3, after: 4 } }));

  assert.equal(gesendet[0].path, '/shopping/items/10');
  assert.equal(gesendet[0].payload.list_id, 2);
  assert.deepEqual([gesendet[0].payload.name, gesendet[0].payload.quantity, gesendet[0].payload.notes], ['Dübel', '50', '8 mm'],
    'EIN Speichern: Bearbeitung und Umzug zusammen');

  assert.deepEqual(shopping.state.items.map((i) => i.id), [11], 'die Zeile ist vom offenen Zettel weg');
  const [alt, neu] = shopping.state.lists;
  assert.deepEqual([alt.item_total, alt.item_checked], [1, 1]);
  assert.deepEqual([neu.item_total, neu.item_checked], [5, 0]);
  assert.deepEqual(geschlossen, [{ force: true }], 'ohne Verwerfen-Rueckfrage');
  // Der Loader-Stub von t() haengt die Parameter an den Schluessel: gemessen
  // wird, WAS die Meldung nennt - den Artikel und die Zielliste, unmaskiert
  // (der Toast setzt textContent).
  assert.deepEqual(toasts, [['shopping.itemMovedToast{"name":"Dübel","list":"Bau & <Markt>"}', 'info']],
    'die Zeile ist weg - eine Meldung sagt, was wohin gegangen ist');
});

test('Ein abgehakter Artikel nimmt seinen Haken in beiden Zaehlern mit', async () => {
  zustand();
  shopping.state.items[0].is_checked = 1;
  shopping.state.lists[0].item_checked = 2;
  await speichere(felder({ 'item-details-list': '2' }),
    (payload) => ({ data: { ...item({ is_checked: 1 }), ...payload }, list_change: { list_id: 1, before: 3, after: 4 } }));
  const [alt, neu] = shopping.state.lists;
  assert.deepEqual([alt.item_total, alt.item_checked], [1, 1]);
  assert.deepEqual([neu.item_total, neu.item_checked], [5, 1]);
});

test('Sagt der Server Nein, bleibt der Artikel, wo er ist', async () => {
  zustand();
  const fehler = Object.assign(new Error('400'), { data: { error: 'Unbekannte Liste.' } });
  const { geschlossen } = await speichere(felder({ 'item-details-list': '2' }), () => { throw fehler; });
  assert.deepEqual(shopping.state.items.map((i) => i.id), [10, 11]);
  assert.deepEqual(shopping.state.lists.map((l) => l.item_total), [2, 4]);
  assert.deepEqual(geschlossen, [], 'der Dialog bleibt mit der Eingabe offen');
  assert.deepEqual(toasts, [['Unbekannte Liste.', 'danger']]);
});

// -------------------------------------------------------------------------
// Was mit dem Artikel geht, und was bleibt
// -------------------------------------------------------------------------

test('Eine offene Abhak-Absicht geht mit dem Artikel: sie ueberlagert ihn auf der neuen Liste nicht fuer immer', async () => {
  zustand();
  // Eben abgehakt, der Server hat es noch nicht bestaetigt: Absicht 1 gegen Serverstand 0.
  shopping.intents.set(10, { value: 1, seq: 1, listId: 1, delta: 1 });
  shopping.state.lists[0].item_checked = 2; // die Buchung der Absicht steht schon im Reiter
  await speichere(felder({ 'item-details-list': '2' }),
    (payload) => ({ data: { ...item(), ...payload }, list_change: { list_id: 1, before: 3, after: 4 } }));

  assert.equal(shopping.intents.has(10), false, 'die Absicht ist weg');
  // Auf der neuen Liste nimmt jemand anderes den Haken zurueck: das zeigt die Zeile.
  assert.equal(shopping.checkedOf({ id: 10, is_checked: 0 }), 0);
  // Der Zaehler der Herkunft zieht ab, was die Zeile GEZEIGT hat - den Haken der Absicht.
  const [alt, neu] = shopping.state.lists;
  assert.deepEqual([alt.item_total, alt.item_checked], [1, 1], 'gezeigt war der Artikel abgehakt (checkedOf), nicht offen');
  assert.deepEqual([neu.item_total, neu.item_checked], [5, 0], 'die Zielliste zaehlt den Serverstand');
});

test('Gehoert der Bestand inzwischen der ZIELLISTE, bleibt der Artikel dort stehen', async () => {
  zustand();
  // Der Dialog ging auf Liste 1 auf. Bis die Antwort kommt, ist Liste 2 offen
  // und hat den umgezogenen Artikel schon geladen.
  const gesendet = [];
  globalThis.__apiStub = {
    patch: async (path, payload) => {
      gesendet.push(payload);
      shopping.state.activeListId = 2;
      shopping.state.items = [item({ list_id: 2 })];
      return { data: { ...item(), ...payload }, list_change: { list_id: 1, before: 3, after: 4 } };
    },
  };
  globalThis.__closeModal = () => {};
  try {
    const opts = oeffne();
    const p = panel(felder({ 'item-details-list': '2' }));
    opts.onSave(p);
    await p.submit();
  } finally {
    delete globalThis.__apiStub;
    delete globalThis.__closeModal;
  }
  assert.equal(gesendet[0].list_id, 2);
  assert.deepEqual(shopping.state.items.map((i) => i.id), [10], 'er steht auf dem Zettel, den man jetzt ansieht');
});
