/**
 * Tests: die Einkaufsseite laedt selbst nach, wenn etwas verschwunden ist (#1909)
 * Modul: /public/pages/shopping.js
 *
 * Nennt der Server als Grund, dass es das Ziel einer Handlung nicht mehr gibt
 * (`shopping_*_not_found`: jemand anderes im Haushalt hat es geloescht), holt
 * die Seite Listen, Laeden, Kategorien und Artikel selbst neu. Der Toast bleibt,
 * raet aber zu nichts mehr.
 *
 * Gefahren werden die ECHTEN Aufrufer - das Abhaken (`toggleShoppingItem`) und
 * das Speichern im Bearbeiten-Dialog (`openItemDetails`) -, deren catch den
 * Fehler meldet. Der api-Stub schreibt mit, was die Seite danach holt; er
 * nimmt keine Antwort der Seite vorweg.
 *
 * Die eine Ausnahme: wer einen Artikel LOESCHT, den es nicht mehr gibt, hat sein
 * Ziel erreicht. Kein Toast, die Zeile bleibt weg, die Seite laedt still nach.
 * Gefahren wird `deleteItemUndoable` - der eine Weg hinter Knopf, Wisch und
 * Bearbeiten-Dialog - samt dem Ablauf des Undo-Fensters.
 *
 * Dasselbe gilt fuer die drei anderen Loeschwege der Seite: die Liste (der
 * Zweig `delete-list` des delegierten Handlers, gefahren ueber einen Klick) und
 * Laden und Kategorie (die echten `openStoreManager`/`openCategoryManager`
 * konfigurieren die echte Verwalter-Komponente, deren `_delete` laeuft).
 *
 * Ausführen: npm run test:shopping-gone-reload
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Ein EventTarget, damit die echte Verwalter-Komponente Zuhoerer tragen kann.
globalThis.HTMLElement = globalThis.HTMLElement ?? class HTMLElement extends EventTarget {};
/** Die echte Klasse hinter `<yuvomi-category-manager>`, wie shopping.js sie laedt. */
let CategoryManager = null;
globalThis.customElements = {
  define(name, constructor) { if (name === 'yuvomi-category-manager') CategoryManager = constructor; },
  get() {},
};

const { installMiniDom } = await import('./mini-dom.js');
installMiniDom();
const toasts = [];
globalThis.window.yuvomi = { ...globalThis.window.yuvomi, showToast: (text, kind) => { toasts.push([text, kind]); } };
globalThis.document.getElementById = () => null;
// Der Klapp-Zustand je Liste liegt im localStorage; die Seite raeumt ihn beim
// Loeschen der Liste ab.
const speicher = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (k) => (speicher.has(k) ? speicher.get(k) : null),
    setItem: (k, v) => { speicher.set(k, String(v)); },
    removeItem: (k) => { speicher.delete(k); },
  },
});

const { __test: shopping } = await import('../public/pages/shopping.js');

const item = (over = {}) => ({
  id: 10, list_id: 1, name: 'Milch', quantity: '1', category: 'Sonstiges', is_checked: 0,
  price_cents: null, store_id: null, url: null, notes: null, tags: [], sort_order: 1, ...over,
});
const LISTEN = () => [
  { id: 1, name: 'Wocheneinkauf', item_total: 2, item_checked: 0 },
  { id: 2, name: 'Baumarkt', item_total: 1, item_checked: 0 },
];
const KATEGORIEN = () => [{ id: 1, name: 'Sonstiges', icon: 'tag', sort_order: 0 }];

function zustand(patch = {}) {
  toasts.length = 0;
  shopping.intents.clear();
  shopping.pendingRemovals.clear();
  shopping.resetLoadOrderForTest();
  shopping.resetGoneReloadForTest?.();
  shopping.abortLiveUpdatesForTest();
  const lists = LISTEN();
  Object.assign(shopping.state, {
    lists, activeList: lists[0], activeListId: 1,
    items: [item(), item({ id: 11, name: 'Brot', sort_order: 2 })],
    categories: [...KATEGORIEN(), { id: 2, name: 'Alt', icon: 'tag', sort_order: 1 }],
    stores: [{ id: 5, name: 'Eckladen' }], currency: 'EUR',
    listsError: null, itemsError: null, collapsedCategories: new Set(),
  }, patch);
  shopping.setItemsListForTest(shopping.state.activeListId);
}

const nullContainer = () => ({ querySelector: () => null, querySelectorAll: () => [], isConnected: true });

const fehler = (status, reason) => Object.assign(new Error('Server sentence.'), {
  status, data: { error: 'Server sentence.', code: status, ...(reason ? { reason } : {}) },
});

/**
 * Der Server NACH der fremden Loeschung: was er auf die Lese-Anfragen sagt.
 * `gets` schreibt jede mit. `liest` darf werfen (das Nachladen scheitert).
 */
function server({ lists = LISTEN(), items = { 1: [item({ id: 11, name: 'Brot', sort_order: 2 })], 2: [item({ id: 20, list_id: 2, name: 'Dübel' })] },
  categories = KATEGORIEN(), stores = [], liest = null } = {}) {
  const gets = [];
  const lese = async (path) => {
    gets.push(path);
    if (liest) await liest(path);
    if (path === '/shopping') return { data: lists };
    if (path === '/shopping/categories') return { data: categories };
    if (path === '/shopping/stores') return { data: stores };
    if (path === '/preferences') return { data: { currency: 'EUR' } };
    const m = /^\/shopping\/(\d+)\/items$/.exec(path);
    if (m) {
      const id = Number(m[1]);
      if (!lists.some((l) => l.id === id)) throw fehler(404, 'shopping_list_not_found');
      return { data: items[id] ?? [], list: lists.find((l) => l.id === id), version: 7 };
    }
    throw new Error(`kein Stub fuer GET ${path}`);
  };
  return {
    gets,
    stub: {
      get: lese,
      getWithSource: async (path) => ({ data: await lese(path), fromCache: false }),
    },
  };
}

/** Mit dem api-Stub laufen lassen und auf das angestossene Nachladen warten. */
async function mit(stub, lauf) {
  globalThis.__apiStub = stub;
  const geschlossen = [];
  globalThis.__closeModal = (...args) => { geschlossen.push(args[0] ?? {}); };
  const laut = [console.error, console.warn];
  console.error = () => {};
  console.warn = () => {};
  try {
    await lauf();
    // Ein bestellter Folgelauf haengt am selben Versprechen.
    await laeuft();
    await new Promise((r) => setImmediate(r));
  } finally {
    [console.error, console.warn] = laut;
    delete globalThis.__apiStub;
    delete globalThis.__closeModal;
  }
  return geschlossen;
}

/** Der laufende Nachlade-Lauf, oder nichts. */
const laeuft = () => shopping.goneReloadForTest?.() ?? null;

const NACHLADEN = ['/preferences', '/shopping', '/shopping/1/items', '/shopping/categories', '/shopping/stores'];

/** Der Bearbeiten-Dialog ueber den Modal-Stub: sein Panel und sein Speichern. */
function dialog(id = 10, eigeneFelder = {}) {
  let opts = null;
  globalThis.__openModal = (o) => { opts = o; };
  try {
    shopping.openItemDetails(id, nullContainer());
  } finally {
    delete globalThis.__openModal;
  }
  const werte = {
    'item-details-name': 'Milch', 'item-details-qty': '1', 'item-details-cat': 'Sonstiges',
    'item-details-url': '', 'item-details-notes': '', 'item-details-price': '', 'item-details-store': '',
    'item-details-link': '', 'item-details-cancel': '', 'item-details-delete': '',
  };
  const fields = {};
  for (const [key, value] of Object.entries(werte)) fields[`#${key}`] = { value, addEventListener() {} };
  Object.assign(fields, eigeneFelder);
  const handlers = {};
  const form = { addEventListener(type, fn) { handlers[type] = fn; } };
  const panel = { querySelector: (sel) => (sel === '#item-details-form' ? form : fields[sel] ?? null) };
  opts.onSave(panel);
  return { opts, submit: () => handlers.submit({ preventDefault() {} }) };
}

// -------------------------------------------------------------------------
// Nachladen bei "gibt es nicht mehr"
// -------------------------------------------------------------------------

test('Abhaken eines geloeschten Artikels: Toast ohne Rat, und die Seite holt den frischen Stand selbst', async () => {
  zustand();
  const { gets, stub } = server({ stores: [{ id: 6, name: 'Markt' }] });
  stub.patch = async () => { throw fehler(404, 'shopping_item_not_found'); };

  await mit(stub, () => shopping.toggleShoppingItem(10, 0, nullContainer()));

  assert.deepEqual(toasts, [['shopping.errorItemGone', 'danger']]);
  // Listen, Laeden, Kategorien und die Artikel der aktiven Liste - je einmal.
  assert.deepEqual([...gets].sort(), NACHLADEN);
  assert.deepEqual(shopping.state.items.map((i) => i.id), [11], 'der geloeschte Artikel ist aus dem Bestand');
  assert.deepEqual(shopping.state.stores, [{ id: 6, name: 'Markt' }]);
  assert.deepEqual(shopping.state.categories.map((c) => c.name), ['Sonstiges']);
  assert.equal(shopping.intents.size, 0);
});

for (const [name, err] of [
  ['500 ohne Grund', fehler(500)],
  ['blanke 404 ohne Grund', fehler(404)],
  ['400 mit unbekanntem Grund', fehler(400, 'shopping_future_not_found')],
  ['409, den Laden gibt es schon', fehler(409, 'shopping_store_exists')],
  ['eine Absage (403), auch wenn sie einen solchen Grund nennt', fehler(403, 'shopping_item_not_found')],
  ['offline', Object.assign(new Error('offline'), { status: 0 })],
]) {
  test(`Kein Nachladen bei einem anderen Fehler: ${name}`, async () => {
    zustand();
    const { gets, stub } = server();
    stub.patch = async () => { throw err; };

    await mit(stub, () => shopping.toggleShoppingItem(10, 0, nullContainer()));

    assert.equal(toasts.length, 1);
    assert.deepEqual(gets, [], 'die Seite hat nichts nachgeladen');
    assert.equal(laeuft(), null);
    assert.deepEqual(shopping.state.items.map((i) => i.id), [10, 11]);
  });
}

test('Scheitert das Nachladen selbst, loest es kein zweites aus - und der letzte Stand bleibt stehen', async () => {
  zustand();
  // Jede Lese-Anfrage scheitert, und zwar ausgerechnet mit einem Grund, der
  // sonst Nachladen ausloest.
  // Mit Atempause und Deckel: liefe das Nachladen doch im Kreis, endet der Fall
  // rot statt nie.
  let versuche = 0;
  const { gets, stub } = server({
    liest: async () => {
      await new Promise((r) => setImmediate(r));
      versuche += 1;
      if (versuche <= 60) throw fehler(404, 'shopping_list_not_found');
    },
  });
  stub.patch = async () => { throw fehler(404, 'shopping_item_not_found'); };

  await mit(stub, () => shopping.toggleShoppingItem(10, 0, nullContainer()));
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual([...gets].sort(), NACHLADEN, 'genau EIN Lauf');
  assert.deepEqual(toasts, [['shopping.errorItemGone', 'danger']], 'das Nachladen meldet seinen Fehler nicht');
  assert.equal(laeuft(), null);
  assert.equal(shopping.state.listsError, null, 'kein Fehlerbild aus einem stillen Nachladen');
  assert.deepEqual(shopping.state.lists.map((l) => l.id), [1, 2]);
  assert.deepEqual(shopping.state.items.map((i) => i.id), [10, 11]);
  assert.deepEqual(shopping.state.categories.map((c) => c.name), ['Sonstiges', 'Alt'], 'Kategorien nicht geleert');
  assert.deepEqual(shopping.state.stores, [{ id: 5, name: 'Eckladen' }], 'Laeden nicht geleert');
});

test('Zwei Fehler waehrend EINES Laufs bestellen genau einen Folgelauf, keinen parallelen', async () => {
  zustand({ items: [item(), item({ id: 11, name: 'Brot', sort_order: 2 }), item({ id: 12, name: 'Salz', sort_order: 3 })] });
  let offen = 0;
  let hoechstens = 0;
  const { gets, stub } = server({
    liest: async (path) => {
      if (path !== '/shopping') return;
      offen += 1;
      hoechstens = Math.max(hoechstens, offen);
      await new Promise((r) => setTimeout(r, 10));
      offen -= 1;
    },
  });
  stub.patch = async () => { throw fehler(404, 'shopping_item_not_found'); };

  await mit(stub, async () => {
    const c = nullContainer();
    await shopping.toggleShoppingItem(10, 0, c);
    // Der erste Lauf ist unterwegs; zwei weitere Fehler treffen ein.
    await shopping.toggleShoppingItem(11, 0, c);
    await shopping.toggleShoppingItem(12, 0, c);
  });

  assert.equal(gets.filter((p) => p === '/shopping').length, 2, 'ein Lauf und EIN Folgelauf');
  assert.equal(hoechstens, 1, 'nie zwei Laeufe zugleich');
});

test('Eine laufende eigene Aenderung ueberlebt das Nachladen', async () => {
  zustand();
  // Der Server kennt 11 noch als offen; die Seite hat ihn gerade abgehakt und
  // wartet auf die Antwort, als der Fehler zu Artikel 10 das Nachladen anstoesst.
  const { stub } = server();
  let loese;
  stub.patch = (path) => (path.endsWith('/11')
    ? new Promise((r) => { loese = r; })
    : Promise.reject(fehler(404, 'shopping_item_not_found')));

  await mit(stub, async () => {
    const c = nullContainer();
    shopping.toggleShoppingItem(11, 0, c);
    await shopping.toggleShoppingItem(10, 0, c);
    await laeuft();
    assert.equal(shopping.checkedOf(shopping.state.items.find((i) => i.id === 11)), 1, 'die Zeile zeigt weiter die Absicht');
    loese({ data: item({ id: 11, is_checked: 1 }) });
  });
  assert.equal(shopping.state.items.find((i) => i.id === 11).is_checked, 1);
});

// -------------------------------------------------------------------------
// Die aktive Liste ist weg
// -------------------------------------------------------------------------

test('Ist die aktive Liste weg, faellt die Seite auf die erste verbliebene - und ein offener Dialog geht zu', async () => {
  zustand();
  const { stub } = server({ lists: LISTEN().filter((l) => l.id !== 1) });
  stub.patch = async () => { throw fehler(404, 'shopping_item_not_found'); };

  const geschlossen = await mit(stub, () => dialog().submit());

  assert.equal(shopping.state.activeListId, 2);
  assert.deepEqual(shopping.state.items.map((i) => i.id), [20]);
  assert.deepEqual(shopping.state.lists.map((l) => l.id), [2]);
  assert.deepEqual(geschlossen, [{ force: true }]);
});

test('Ist die letzte Liste weg, zeigt die Seite den Leerzustand', async () => {
  zustand();
  const { stub } = server({ lists: [] });
  stub.patch = async () => { throw fehler(404, 'shopping_item_not_found'); };

  await mit(stub, () => shopping.toggleShoppingItem(10, 0, nullContainer()));

  assert.equal(shopping.state.activeListId, null);
  assert.equal(shopping.state.activeList, null);
  assert.deepEqual(shopping.state.items, []);
  assert.equal(shopping.state.listsError, null);
});

// -------------------------------------------------------------------------
// Der offene Bearbeiten-Dialog
// -------------------------------------------------------------------------

test('Dialog zu einem Artikel, den es nicht mehr gibt: er geht zu', async () => {
  zustand();
  const { stub } = server();
  stub.patch = async () => { throw fehler(404, 'shopping_item_not_found'); };

  const geschlossen = await mit(stub, () => dialog().submit());

  assert.deepEqual(toasts, [['shopping.errorItemGone', 'danger']]);
  assert.deepEqual(geschlossen, [{ force: true }]);
});

test('Dialog, dessen Artikel noch da ist (der Laden ist weg): er bleibt mit den Eingaben offen', async () => {
  zustand();
  const { gets, stub } = server({ items: { 1: [item(), item({ id: 11, name: 'Brot', sort_order: 2 })] } });
  stub.patch = async () => { throw fehler(400, 'shopping_store_not_found'); };

  const geschlossen = await mit(stub, () => dialog().submit());

  assert.deepEqual(toasts, [['shopping.errorStoreGone', 'danger']]);
  assert.deepEqual([...gets].sort(), NACHLADEN);
  assert.deepEqual(geschlossen, [], 'der Dialog bleibt offen');
  assert.deepEqual(shopping.state.stores, [], 'der verschwundene Laden wird nicht mehr angeboten');
});

test('Ein gescheitertes Nachladen schliesst keinen Dialog', async () => {
  zustand();
  const { stub } = server({ liest: async () => { throw new Error('Netz weg'); } });
  stub.patch = async () => { throw fehler(404, 'shopping_item_not_found'); };

  const geschlossen = await mit(stub, () => dialog().submit());

  assert.deepEqual(geschlossen, []);
  assert.deepEqual(shopping.state.items.map((i) => i.id), [10, 11]);
});

test('Der offene Dialog bekommt die frische Auswahl: Kategorie, Zielliste und Laeden', async () => {
  zustand();
  const auswahl = (value) => Object.assign(globalThis.document.createElement('select'), { value });
  const kategorie = auswahl('Sonstiges');
  // Der Nutzer hatte als Ziel die Liste gewaehlt, die es nicht mehr gibt.
  const liste = auswahl('2');
  const laeden = globalThis.document.createElement('datalist');
  const { stub } = server({
    lists: LISTEN().filter((l) => l.id !== 2),
    items: { 1: [item(), item({ id: 11, name: 'Brot', sort_order: 2 })] },
    stores: [{ id: 6, name: 'Markt' }],
  });
  stub.patch = async () => { throw fehler(400, 'shopping_list_not_found'); };

  const geschlossen = await mit(stub, () => dialog(10, {
    '#item-details-cat': kategorie, '#item-details-list': liste, '#item-details-store-options': laeden,
  }).submit());

  assert.deepEqual(toasts, [['shopping.errorListGone', 'danger']]);
  assert.deepEqual(geschlossen, []);
  const werte = (el) => el.childNodes.map((o) => o.value);
  assert.deepEqual(werte(kategorie), ['Sonstiges'], 'die geloeschte Kategorie "Alt" ist nicht mehr waehlbar');
  assert.equal(kategorie.value, 'Sonstiges', 'die Wahl bleibt, wo es sie noch gibt');
  assert.deepEqual(werte(liste), ['1']);
  assert.equal(liste.value, '1', 'die verschwundene Zielliste faellt auf die eigene Liste zurueck');
  assert.deepEqual(werte(laeden), ['Markt']);
});

// -------------------------------------------------------------------------
// Loeschen eines Artikels, den es nicht mehr gibt: still erledigt
// -------------------------------------------------------------------------

/**
 * Einen Artikel loeschen und das Undo-Fenster ablaufen lassen.
 *
 * Der Loader ersetzt `scheduleUndoableDelete` durch einen Stub, der `commit`
 * und `restore` herausgibt. `ablauf` tut damit, was `finish` in utils/ux.js
 * tut: commit, und bei einem Wurf restore mit dem Fehler - beim Verlassen der
 * Seite (`keepalive`) ohne restore. Die vier Zeilen dort faehrt diese Suite
 * also NICHT selbst.
 */
function loeschen(id, { keepalive = false } = {}) {
  let opts = null;
  let zurueck = 0;
  globalThis.__undoStub = (o) => { opts = o; };
  try {
    shopping.deleteItemUndoable(id, nullContainer());
  } finally {
    delete globalThis.__undoStub;
  }
  assert.ok(opts, 'das Loeschen hat ein Undo-Fenster geoeffnet');
  return {
    opts,
    zurueckgeholt: () => zurueck,
    ablauf: async () => {
      try {
        await opts.commit({ keepalive });
      } catch (err) {
        if (!keepalive) { zurueck += 1; opts.restore(err); }
      }
    },
  };
}

/** Der Server nach der fremden Loeschung von Artikel 10: Liste 1 zaehlt einen weniger. */
const NACH_FREMDEM_LOESCHEN = (checked = 0) => LISTEN().map((l) => (l.id === 1 ? { ...l, item_total: 1, item_checked: checked } : l));

test('Loeschen eines schon geloeschten Artikels: kein Toast, die Zeile bleibt weg, der Zaehler stimmt', async () => {
  zustand();
  const { gets, stub } = server({ lists: NACH_FREMDEM_LOESCHEN() });
  const geloescht = [];
  stub.delete = async (path) => { geloescht.push(path); throw fehler(404, 'shopping_item_not_found'); };

  let lauf;
  await mit(stub, async () => {
    lauf = loeschen(10);
    // Die Zeile geht sofort, der Zaehler mit.
    assert.deepEqual(shopping.state.items.map((i) => i.id), [11]);
    assert.equal(shopping.state.lists[0].item_total, 1);
    await lauf.ablauf();
    // Gleich nach der Antwort, noch vor dem Ende des Nachladens: nichts ist
    // zurueckgesprungen.
    assert.deepEqual(shopping.state.items.map((i) => i.id), [11], 'die Zeile ist nicht zurueckgekommen');
    assert.equal(shopping.state.lists[0].item_total, 1);
  });

  assert.deepEqual(geloescht, ['/shopping/items/10']);
  assert.deepEqual(toasts, [], 'kein Toast: der Nutzer hat, was er wollte');
  assert.equal(lauf.zurueckgeholt(), 0, 'restore lief nicht');
  assert.deepEqual(shopping.state.items.map((i) => i.id), [11]);
  assert.equal(shopping.state.lists[0].item_total, 1, 'Reiter zaehlt den Artikel nicht mehr');
  assert.equal(shopping.state.lists[0].item_checked, 0);
  assert.equal(shopping.pendingRemovals.size, 0, 'keine schwebende Loeschung bleibt liegen');
  // Der Stand war veraltet: die Seite holt den frischen, still.
  assert.deepEqual([...gets].sort(), NACHLADEN);
});

test('Loeschen eines schon geloeschten, abgehakten Artikels: auch der Abgehakt-Zaehler stimmt', async () => {
  zustand({ items: [item({ is_checked: 1 }), item({ id: 11, name: 'Brot', sort_order: 2, is_checked: 1 })] });
  shopping.state.lists[0].item_checked = 2;
  const { stub } = server({
    lists: NACH_FREMDEM_LOESCHEN(1),
    items: { 1: [item({ id: 11, name: 'Brot', sort_order: 2, is_checked: 1 })] },
  });
  stub.delete = async () => { throw fehler(404, 'shopping_item_not_found'); };

  await mit(stub, () => loeschen(10).ablauf());

  assert.deepEqual(toasts, []);
  assert.deepEqual(shopping.state.items.map((i) => i.id), [11]);
  assert.equal(shopping.state.lists[0].item_total, 1);
  assert.equal(shopping.state.lists[0].item_checked, 1);
});

test('Scheitert das stille Nachladen, stimmt der Stand trotzdem - und es bleibt still', async () => {
  zustand();
  const { stub } = server({ liest: async () => { throw new Error('Netz weg'); } });
  stub.delete = async () => { throw fehler(404, 'shopping_item_not_found'); };

  await mit(stub, () => loeschen(10).ablauf());

  assert.deepEqual(toasts, []);
  assert.deepEqual(shopping.state.items.map((i) => i.id), [11]);
  assert.equal(shopping.state.lists[0].item_total, 1, 'der Zaehler kommt vom Loeschen, nicht vom Nachladen');
  assert.equal(shopping.pendingRemovals.size, 0);
});

test('Beim Verlassen der Seite (keepalive) laedt das erledigte Loeschen nichts nach', async () => {
  zustand();
  const { gets, stub } = server();
  stub.delete = async () => { throw fehler(404, 'shopping_item_not_found'); };

  await mit(stub, () => loeschen(10, { keepalive: true }).ablauf());

  assert.deepEqual(toasts, []);
  assert.deepEqual(gets, []);
  assert.equal(laeuft(), null);
});

for (const [name, err, satz, laedtNach] of [
  ['500 ohne Grund', fehler(500), 'common.errorGeneric', false],
  ['blanke 404 ohne Grund', fehler(404), 'common.errorGeneric', false],
  ['eine Absage (403) mit diesem Grund', fehler(403, 'shopping_item_not_found'), 'common.errorNoPermission', false],
  ['offline', Object.assign(new Error('offline'), { status: 0 }), 'common.errorOfflineMutation', false],
  // Ein ANDERES Ding ist weg, nicht der Artikel: das bleibt ein Fehler mit
  // Satz und Nachladen. Nur der Grund des geloeschten Dings zaehlt als erledigt.
  ['die Liste ist weg, nicht der Artikel', fehler(404, 'shopping_list_not_found'), 'shopping.errorListGone', true],
]) {
  test(`Loeschen scheitert an etwas anderem: die Zeile kommt zurueck, Toast - ${name}`, async () => {
    zustand();
    // Der Server hat den Artikel noch (das Loeschen ist ja gescheitert).
    const { gets, stub } = server({ items: { 1: [item(), item({ id: 11, name: 'Brot', sort_order: 2 })] } });
    stub.delete = async () => { throw err; };

    let lauf;
    await mit(stub, async () => { lauf = loeschen(10); await lauf.ablauf(); });

    assert.deepEqual(toasts, [[satz, 'danger']]);
    assert.equal(lauf.zurueckgeholt(), 1);
    assert.deepEqual(shopping.state.items.map((i) => i.id), [10, 11], 'die Zeile ist wieder da');
    assert.equal(shopping.state.lists[0].item_total, 2);
    assert.equal(shopping.pendingRemovals.size, 0);
    assert.deepEqual([...gets].sort(), laedtNach ? NACHLADEN : []);
  });
}

// Gemessen, nicht gebaut: was "Rueckgaengig" tut, wenn der Artikel fremd
// geloescht wurde. Im Undo-Fenster ist das DELETE noch gar nicht unterwegs -
// die Seite weiss also nichts. Das Zuruecknehmen ist rein lokal und kann
// deshalb in keinen Fehler laufen; die Zeile steht bis zur naechsten
// Auffrischung als Rest da, und die naechste Handlung daran meldet es (#1921).
test('Rueckgaengig im Undo-Fenster ist lokal: kein Aufruf, kein Fehler - die naechste Handlung meldet den verschwundenen Artikel', async () => {
  zustand();
  const { gets, stub } = server({ lists: NACH_FREMDEM_LOESCHEN() });
  const schreibt = [];
  stub.delete = async (path) => { schreibt.push(path); throw fehler(404, 'shopping_item_not_found'); };
  stub.patch = async (path) => { schreibt.push(path); throw fehler(404, 'shopping_item_not_found'); };

  await mit(stub, async () => {
    const { opts } = loeschen(10);
    // Der Nutzer tippt "Rueckgaengig": restore ohne Fehler.
    opts.restore();
    assert.deepEqual(schreibt, [], 'das Zuruecknehmen ruft den Server nicht');
    assert.deepEqual(toasts, []);
    assert.deepEqual(shopping.state.items.map((i) => i.id), [10, 11]);
    assert.equal(shopping.state.lists[0].item_total, 2);
    assert.deepEqual(gets, []);
    await shopping.toggleShoppingItem(10, 0, nullContainer());
  });

  assert.deepEqual(schreibt, ['/shopping/items/10']);
  assert.deepEqual(toasts, [['shopping.errorItemGone', 'danger']]);
  assert.deepEqual(shopping.state.items.map((i) => i.id), [11]);
});

// Das Sammel-Loeschen kennt den Fall nicht als Fehler: die Route loescht, was
// von den genannten Artikeln noch da ist, und antwortet 200 mit der Zahl. Ist
// ein Teil (oder alles) schon weg, bleibt es still - und weil die Quittung dann
// nicht gilt, holt die naechste Abfrage den Stand.
test('Abgehakte loeschen, von denen einer schon weg ist: 200 mit kleinerer Zahl, kein Toast, nichts kommt zurueck', async () => {
  zustand({ items: [item({ is_checked: 1 }), item({ id: 11, name: 'Brot', sort_order: 2, is_checked: 1 })] });
  shopping.state.lists[0].item_checked = 2;
  const { stub } = server();
  const koerper = [];
  stub.delete = async (path, opts) => { koerper.push([path, JSON.parse(opts.body)]); return { deleted: 1, list_change: { list_id: 1, before: 3, after: 4 } }; };

  let opts = null;
  let zurueck = 0;
  await mit(stub, async () => {
    globalThis.__undoStub = (o) => { opts = o; };
    try { shopping.clearCheckedUndoable(nullContainer()); } finally { delete globalThis.__undoStub; }
    try { await opts.commit({ keepalive: false }); } catch (err) { zurueck += 1; opts.restore(err); }
  });

  assert.deepEqual(koerper, [['/shopping/1/items/checked', { ids: [10, 11] }]]);
  assert.equal(zurueck, 0);
  assert.deepEqual(toasts, []);
  assert.deepEqual(shopping.state.items, []);
  assert.equal(shopping.state.lists[0].item_total, 0);
  assert.equal(shopping.state.lists[0].item_checked, 0);
});

// -------------------------------------------------------------------------
// Loeschen einer Liste, die es nicht mehr gibt: still erledigt
// -------------------------------------------------------------------------

/** Der Klapp-Zustand der Kategorien von Liste 1, wie die Seite ihn ablegt. */
const KLAPP_LISTE_1 = 'yuvomi:shopping:collapsedCategories:v1:anon:1';
/** Der zweite Eintrag je Liste (#1816): "Abgehakt" steht offen. */
const ABGEHAKT_LISTE_1 = 'yuvomi:shopping:tickedOpen:v1:anon:1';
/** Derselbe Eintrag der Nachbarliste: er gehoert nicht zur geloeschten. */
const ABGEHAKT_LISTE_2 = 'yuvomi:shopping:tickedOpen:v1:anon:2';
/** Beide Eintraege der Liste 1 ablegen, dazu den der Nachbarliste. */
function speicherFuellen() {
  speicher.clear();
  speicher.set(KLAPP_LISTE_1, '["x"]');
  speicher.set(ABGEHAKT_LISTE_1, '1');
  speicher.set(ABGEHAKT_LISTE_2, '1');
}

/**
 * Die aktive Liste ueber den delegierten Klick-Handler der Seite loeschen
 * (`data-action="delete-list"`), samt Rueckfrage (der Loader sagt Ja) und dem
 * Wechsel auf die Nachbarliste. Das Undo-Fenster ist derselbe Stub wie beim
 * Artikel: `ablauf` tut, was `finish` in utils/ux.js tut.
 */
async function listeLoeschen({ keepalive = false } = {}) {
  const handlers = {};
  const root = { dataset: {}, addEventListener(type, fn, opts) { if (!opts?.capture) (handlers[type] ??= []).push(fn); } };
  const container = { querySelector: (sel) => (sel === '.shopping-page' ? root : null), querySelectorAll: () => [], isConnected: true };
  shopping.wireListContentEvents(container);
  const [klick] = handlers.click ?? [];
  assert.equal(typeof klick, 'function', 'der delegierte Handler haengt nicht');
  let opts = null;
  let zurueck = 0;
  globalThis.__undoStub = (o) => { opts = o; };
  try {
    await klick({ target: { closest: (sel) => (sel === '[data-action]' ? { dataset: { action: 'delete-list' } } : null) } });
  } finally {
    delete globalThis.__undoStub;
  }
  assert.ok(opts, 'das Loeschen der Liste hat ein Undo-Fenster geoeffnet');
  return {
    zurueckgeholt: () => zurueck,
    ablauf: async () => {
      try {
        await opts.commit({ keepalive });
      } catch (err) {
        if (!keepalive) { zurueck += 1; await opts.restore(err); }
      }
    },
  };
}

/** Der Server nach der fremden Loeschung von Liste 1. */
const OHNE_LISTE_1 = () => LISTEN().filter((l) => l.id !== 1);
const NACHLADEN_LISTE_2 = ['/preferences', '/shopping', '/shopping/2/items', '/shopping/categories', '/shopping/stores'];

test('Loeschen einer schon geloeschten Liste: kein Toast, die Liste kommt nicht zurueck, die Seite laedt still nach', async () => {
  zustand();
  speicherFuellen();
  const { gets, stub } = server({ lists: OHNE_LISTE_1() });
  const geloescht = [];
  stub.delete = async (path) => { geloescht.push(path); throw fehler(404, 'shopping_list_not_found'); };

  let lauf;
  await mit(stub, async () => {
    lauf = await listeLoeschen();
    // Die Liste geht sofort, die Seite steht auf der Nachbarliste.
    assert.deepEqual(shopping.state.lists.map((l) => l.id), [2]);
    assert.equal(shopping.state.activeListId, 2);
    assert.ok(speicher.has(KLAPP_LISTE_1), 'im Undo-Fenster bleibt der Klapp-Zustand');
    assert.ok(speicher.has(ABGEHAKT_LISTE_1), 'und der Zustand des Abschnitts "Abgehakt"');
    gets.length = 0;
    await lauf.ablauf();
    // Gleich nach der Antwort, noch vor dem Ende des Nachladens: nichts ist
    // zurueckgesprungen.
    assert.deepEqual(shopping.state.lists.map((l) => l.id), [2], 'die Liste ist nicht zurueckgekommen');
    assert.equal(shopping.state.activeListId, 2, 'und nicht wieder die aktive');
  });

  assert.deepEqual(geloescht, ['/shopping/1']);
  assert.deepEqual(toasts, [], 'kein Toast: der Nutzer hat, was er wollte');
  assert.equal(lauf.zurueckgeholt(), 0, 'restore lief nicht');
  assert.deepEqual(shopping.state.lists.map((l) => l.id), [2]);
  assert.equal(shopping.state.activeListId, 2);
  assert.deepEqual(shopping.state.items.map((i) => i.id), [20]);
  // Wie beim gewoehnlichen Erfolg: der verwaiste Klapp-Zustand geht mit.
  assert.equal(speicher.has(KLAPP_LISTE_1), false, 'der Klapp-Zustand der Liste ist abgeraeumt');
  assert.deepEqual([...speicher.keys()], [ABGEHAKT_LISTE_2], 'keiner der beiden Eintraege der Liste bleibt (#1929)');
  // Der Stand war veraltet: die Seite holt den frischen, still.
  assert.deepEqual([...gets].sort(), NACHLADEN_LISTE_2);
});

test('Gegenfall: das gewoehnliche Loeschen einer Liste raeumt denselben Klapp-Zustand ab und laedt nichts nach', async () => {
  zustand();
  speicherFuellen();
  const { gets, stub } = server({ lists: OHNE_LISTE_1() });
  stub.delete = async () => ({ ok: true });

  let lauf;
  await mit(stub, async () => {
    lauf = await listeLoeschen();
    // Im Undo-Fenster steht noch alles: ein zurueckgenommenes Loeschen soll
    // beide Zustaende behalten.
    assert.deepEqual([...speicher.keys()].sort(), [KLAPP_LISTE_1, ABGEHAKT_LISTE_1, ABGEHAKT_LISTE_2].sort());
    gets.length = 0;
    await lauf.ablauf();
  });

  assert.deepEqual(toasts, []);
  assert.equal(lauf.zurueckgeholt(), 0);
  assert.equal(speicher.has(KLAPP_LISTE_1), false);
  // #1929: der zweite Eintrag der Liste geht an derselben Stelle mit - und nur
  // der dieser Liste.
  assert.deepEqual([...speicher.keys()], [ABGEHAKT_LISTE_2], 'keiner der beiden Eintraege der Liste bleibt');
  assert.deepEqual(gets, [], 'nur das erledigte Loeschen laedt nach, das gelungene nicht');
});

test('Beim Verlassen der Seite (keepalive) laedt das erledigte Loeschen der Liste nichts nach', async () => {
  zustand();
  const { gets, stub } = server({ lists: OHNE_LISTE_1() });
  stub.delete = async () => { throw fehler(404, 'shopping_list_not_found'); };

  await mit(stub, async () => { const lauf = await listeLoeschen({ keepalive: true }); gets.length = 0; await lauf.ablauf(); });

  assert.deepEqual(toasts, []);
  assert.deepEqual(gets, []);
  assert.equal(laeuft(), null);
});

for (const [name, err, satz, laedtNach] of [
  ['500 ohne Grund', fehler(500), 'common.unknownError', false],
  ['blanke 404 ohne Grund', fehler(404), 'common.unknownError', false],
  ['400 mit unbekanntem Grund', fehler(400, 'shopping_future_not_found'), 'common.unknownError', false],
  ['eine Absage (403) mit diesem Grund', fehler(403, 'shopping_list_not_found'), 'common.errorNoPermission', false],
  ['offline', Object.assign(new Error('offline'), { status: 0 }), 'common.errorOfflineMutation', false],
  // Ein ANDERES Ding ist weg, nicht die Liste: das bleibt ein Fehler mit Satz
  // und Nachladen.
  ['ein Artikel ist weg, nicht die Liste', fehler(404, 'shopping_item_not_found'), 'shopping.errorItemGone', true],
]) {
  test(`Loeschen der Liste scheitert an etwas anderem: sie kommt zurueck, Toast - ${name}`, async () => {
    zustand();
    speicherFuellen();
    // Der Server hat die Liste noch (das Loeschen ist ja gescheitert).
    const { gets, stub } = server({ items: { 1: [item(), item({ id: 11, name: 'Brot', sort_order: 2 })], 2: [item({ id: 20, list_id: 2, name: 'Dübel' })] } });
    stub.delete = async () => { throw err; };

    let lauf;
    await mit(stub, async () => { lauf = await listeLoeschen(); gets.length = 0; await lauf.ablauf(); });

    assert.deepEqual(toasts, [[satz, 'danger']]);
    assert.equal(lauf.zurueckgeholt(), 1);
    assert.deepEqual(shopping.state.lists.map((l) => l.id), [1, 2], 'die Liste ist wieder da, an ihrem Platz');
    assert.equal(shopping.state.activeListId, 1);
    assert.deepEqual(shopping.state.items.map((i) => i.id), [10, 11]);
    assert.ok(speicher.has(KLAPP_LISTE_1), 'der Klapp-Zustand einer Liste, die es noch gibt, bleibt');
    assert.ok(speicher.has(ABGEHAKT_LISTE_1), 'und ihr Abschnitt "Abgehakt" bleibt offen');
    assert.deepEqual([...gets].sort(), laedtNach ? NACHLADEN : []);
  });
}

// -------------------------------------------------------------------------
// Laden und Kategorie loeschen, die es nicht mehr gibt: ein Erfolg
// -------------------------------------------------------------------------

/**
 * Einen Verwalter so oeffnen, wie die Seite es tut, und eine Zeile loeschen.
 *
 * `open` ist der echte Aufrufer (`openStoreManager`/`openCategoryManager`): er
 * konfiguriert die ECHTE Komponente und haengt seinen Zuhoerer an sie. Danach
 * laeuft das echte `_delete` gegen den api-Stub. Gestubt sind das Modal (der
 * Loader), die Rueckfrage (sagt Ja) und das Zeichnen der Komponente
 * (`_renderShell`, `_load`, `_renderGroup`) - das Markup des Verwalters faehrt
 * diese Suite also nicht.
 */
async function imVerwalterLoeschen(open, zeile) {
  const { manager, ereignisse } = await verwalterOeffnen(open);
  manager._cats = [zeile, { id: 99, name: 'Bleibt' }];
  await manager._delete(String(zeile.id));
  // Der Zuhoerer der Seite laedt asynchron nach; das Ereignis wartet nicht auf ihn.
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  return { ereignisse, zeilen: manager._cats.map((c) => c.id) };
}

/** Die echte Komponente, vom echten Aufrufer konfiguriert - noch ohne Zeilen. */
async function verwalterOeffnen(open) {
  assert.ok(CategoryManager, 'shopping.js hat die Verwalter-Komponente geladen');
  const manager = new CategoryManager();
  manager._renderShell = () => {};
  manager._load = () => {};
  manager._renderGroup = () => {};
  const ereignisse = [];
  manager.addEventListener('category-manager-changed', (e) => { ereignisse.push(e.detail?.action ?? null); });
  let opts = null;
  globalThis.__openModal = (o) => { opts = o; };
  try {
    await open(nullContainer());
  } finally {
    delete globalThis.__openModal;
  }
  assert.ok(opts, 'der Verwalter ist aufgegangen');
  opts.onSave({ querySelector: (sel) => (sel === 'yuvomi-category-manager' ? manager : null) });
  return { manager, ereignisse };
}

const VERWALTER = [
  {
    was: 'Laden', open: (c) => shopping.openStoreManager(c), zeile: { id: 5, name: 'Eckladen' },
    pfad: '/shopping/stores/5', grund: 'shopping_store_not_found', satz: 'shopping.errorStoreGone',
    // #1929: der Laden-Dialog spricht von Laeden, nicht von Kategorien.
    wort: { angelegt: 'shopping.storeAdded', umbenannt: 'shopping.storeRenamed', geloescht: 'shopping.storeDeleted', loeschknopf: 'shopping.storeDeleteNamed' },
    fremderGrund: 'shopping_category_not_found', fremderSatz: 'shopping.errorCategoryGone',
    holt: ['/preferences', '/shopping/1/items', '/shopping/stores'],
  },
  {
    was: 'Kategorie', open: (c) => shopping.openCategoryManager(c), zeile: { id: 2, name: 'Alt' },
    pfad: '/shopping/categories/2', grund: 'shopping_category_not_found', satz: 'shopping.errorCategoryGone',
    wort: { angelegt: 'category.added', umbenannt: 'category.renamed', geloescht: 'category.deleted', loeschknopf: 'category.deleteNamed' },
    fremderGrund: 'shopping_store_not_found', fremderSatz: 'shopping.errorStoreGone',
    holt: ['/shopping/1/items', '/shopping/categories'],
  },
];

for (const v of VERWALTER) {
  test(`${v.was} loeschen, schon fremd geloescht: der gewoehnliche Erfolg - Zeile raus, "Geloescht", die Seite zieht nach`, async () => {
    zustand();
    const { gets, stub } = server({ items: { 1: [item(), item({ id: 11, name: 'Brot', sort_order: 2 })] } });
    const geloescht = [];
    stub.delete = async (path) => { geloescht.push(path); throw fehler(404, v.grund); };

    let ergebnis;
    await mit(stub, async () => { ergebnis = await imVerwalterLoeschen(v.open, v.zeile); });

    assert.deepEqual(geloescht, [v.pfad]);
    assert.deepEqual(toasts, [[v.wort.geloescht, 'default']], 'der gewoehnliche Erfolgs-Toast, kein Fehler');
    assert.deepEqual(ergebnis.zeilen, [99], 'die Zeile ist aus dem Verwalter');
    assert.deepEqual(ergebnis.ereignisse, ['delete'], 'die Seite erfaehrt es wie jedes Loeschen');
    assert.deepEqual([...gets].sort(), v.holt, 'und holt, was sie nach jedem Loeschen holt');
  });

  test(`Gegenfall: das gewoehnliche Loeschen (${v.was}) sieht genauso aus`, async () => {
    zustand();
    const { gets, stub } = server({ items: { 1: [item(), item({ id: 11, name: 'Brot', sort_order: 2 })] } });
    stub.delete = async () => ({ ok: true });

    let ergebnis;
    await mit(stub, async () => { ergebnis = await imVerwalterLoeschen(v.open, v.zeile); });

    assert.deepEqual(toasts, [[v.wort.geloescht, 'default']]);
    assert.deepEqual(ergebnis, { ereignisse: ['delete'], zeilen: [99] });
    assert.deepEqual([...gets].sort(), v.holt);
  });

  // #1929, die VERDRAHTUNG: gefahren wird der echte Aufrufer der Seite, nicht
  // eine von Hand konfigurierte Komponente. Was er `configure()` mitgibt, liest
  // die Suite an dem ab, was die Komponente danach sagt.
  test(`${v.was}: anlegen, umbenennen und der Name des Loeschknopfs tragen den Wortlaut des Aufrufers`, async () => {
    zustand();
    const { stub } = server({ items: { 1: [item(), item({ id: 11, name: 'Brot', sort_order: 2 })] } });
    stub.post = async (_path, body) => ({ data: { id: 77, ...body } });
    stub.put = async (_path, body) => ({ data: { ...v.zeile, ...body } });

    let knopfnamen;
    await mit(stub, async () => {
      const { manager } = await verwalterOeffnen(v.open);
      manager._cats = [v.zeile];
      const input = { value: 'Neu' };
      const form = { dataset: { group: '' }, querySelector: (sel) => (sel === 'input' ? input : null) };
      await manager._onSubmit({ preventDefault() {}, target: { closest: (sel) => (sel === '.cat-add-form' ? form : null) } });
      globalThis.__promptModal = () => 'Anders';
      try { await manager._rename(String(v.zeile.id)); } finally { delete globalThis.__promptModal; }
      // Seit R19 stehen die vier Aktionen im Mehr-Menue der Zeile (hoechstens
      // zwei sichtbare Zeilenaktionen plus Mehr) - ihr Name ist der Text des
      // Menueeintrags, nicht mehr das aria-label eines Icon-Knopfs.
      knopfnamen = [...manager._rowActionsHtml('Anders', { isFirst: true, isLast: true })
        .matchAll(/role="menuitem"[^>]*>\s*<i [^>]*><\/i>\s*<span>([a-zA-Z.]+)\{/g)].map((m) => m[1]);
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
    });

    assert.deepEqual(toasts, [[v.wort.angelegt, 'success'], [v.wort.umbenannt, 'success']]);
    assert.equal(knopfnamen.length, 4, 'umbenennen, hoch, runter, loeschen');
    assert.equal(knopfnamen.at(-1), v.wort.loeschknopf);
  });

  for (const [name, err, satz, gemeldet] of [
    ['500 ohne Grund', fehler(500), 'common.errorGeneric', false],
    ['blanke 404 ohne Grund', fehler(404), 'common.errorGeneric', false],
    ['400 mit unbekanntem Grund', fehler(400, 'shopping_future_not_found'), 'common.errorGeneric', false],
    ['eine Absage (403) mit diesem Grund', fehler(403, v.grund), 'common.errorNoPermission', false],
    ['die letzte Kategorie', fehler(400, 'category_last'), 'category.errorLast', false],
    // Ein ANDERES Ding ist weg: Fehler mit Satz, und der Verwalter meldet der
    // Seite den veralteten Stand (wie seit #1921) - aber die Zeile bleibt.
    ['etwas anderes ist weg', fehler(404, v.fremderGrund), v.fremderSatz, true],
    ['die Liste ist weg', fehler(404, 'shopping_list_not_found'), 'shopping.errorListGone', true],
  ]) {
    test(`${v.was} loeschen scheitert an etwas anderem: Fehler-Toast, die Zeile bleibt - ${name}`, async () => {
      zustand();
      const { stub } = server({ items: { 1: [item(), item({ id: 11, name: 'Brot', sort_order: 2 })] } });
      stub.delete = async () => { throw err; };

      let ergebnis;
      await mit(stub, async () => { ergebnis = await imVerwalterLoeschen(v.open, v.zeile); });

      assert.deepEqual(toasts, [[satz, 'danger']]);
      assert.deepEqual(ergebnis.zeilen, [v.zeile.id, 99], 'die Zeile steht noch im Verwalter');
      assert.deepEqual(ergebnis.ereignisse, gemeldet ? [null] : [], 'kein "delete" an die Seite');
    });
  }
}
