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

test('Mit mehreren Listen steht die Listen-Auswahl neben der Kategorie, die offene Liste ist gewaehlt', () => {
  zustand();
  const { content } = oeffne();
  const paar = content.split('<div class="form-pair">').slice(1).find((teil) => teil.includes('id="item-details-cat"'));
  assert.ok(paar, 'die Kategorie steht in einer Formularzeile');
  // `paar` reicht bis zur naechsten Formularzeile (Preis und Laden).
  assert.ok(paar.includes('id="item-details-list"'), 'die Liste steht in DERSELBEN Zeile wie die Kategorie');
  assert.ok(paar.indexOf('id="item-details-cat"') < paar.indexOf('id="item-details-list"'), 'nach der Kategorie');
  assert.ok(!paar.includes('id="item-details-qty"'), 'die Menge hat ihr den Platz gemacht');

  assert.match(content, /<label class="form-label" for="item-details-list">shopping\.itemListLabel<\/label>/);
  assert.match(content, /<option value="1" selected>Wocheneinkauf<\/option>/);
  assert.match(content, /<option value="2" >Bau &amp; &lt;Markt&gt;<\/option>/, 'Listennamen sind Nutzerdaten');
  // Die Menge steht davor allein - sie ist weiter da.
  assert.ok(content.indexOf('id="item-details-qty"') < content.indexOf('id="item-details-cat"'));
});

test('Mit nur einer Liste gibt es nichts zu waehlen: kein Feld, die Zeile bleibt Menge + Kategorie', () => {
  zustand();
  shopping.state.lists = [LISTEN()[0]];
  const { content } = oeffne();
  assert.ok(!content.includes('item-details-list'));
  const paar = content.split('<div class="form-pair">')[1];
  assert.ok(paar.includes('id="item-details-qty"') && paar.includes('id="item-details-cat"'));
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
  assert.equal(toasts.length, 1, 'die Zeile ist weg - eine Meldung sagt, wohin');
  assert.equal(toasts[0][1], 'info');
  assert.match(toasts[0][0], /shopping\.itemMovedToast/);
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
