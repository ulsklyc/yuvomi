/**
 * Modul: Kreuztransfer der Kueche in der Oberflaeche (#1290)
 * Zweck: Drei Wege schreiben aus einem Kuechen-Tab in ein FREMDES Modul, und
 *        der Server verlangt fuer jeden zwei Schreibrechte:
 *          - Mahlzeit -> Einkauf (`POST /meals/:id/to-shopping-list`) und
 *            Rezept -> Einkauf (`POST /recipes/:id/to-shopping-list`): der
 *            Pfad-Guard misst den Aufruf als `meals` (beide Praefixe gehoeren
 *            dem Scope-Modul `meals`), die Route verlangt dazu `shopping`.
 *          - Einkauf <- Essensplan (`POST /shopping/:listId/import-meal-plan`):
 *            der Pfad-Guard misst `shopping`, die Route verlangt dazu `meals`.
 *        Fehlt EINES der beiden, endet der Knopf im 403. Die Oberflaeche bietet
 *        ihn dann nicht an (Regel 2 in public/utils/module-access.js: die
 *        Handlung geht weg), und der Handler loest den Aufruf auch nicht aus,
 *        falls ihn doch jemand erreicht.
 *
 *        Gemessen wird am echten Markup und am echten Handler: die Zusage des
 *        Handlers ist das AUSBLEIBEN einer Anfrage, und das sieht kein
 *        Textguard. Jeder Fall prueft die Positivseite mit - erschiene der
 *        Knopf dort nicht, waere der Aufbau des Tests kaputt, nicht die Regel
 *        erfuellt.
 *
 * Ausführen: npm run test:kitchen-transfer-ui
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
globalThis.window = globalThis.window ?? {};
// Toasts ins Leere: der Einkauf ruft `window.yuvomi.showToast` ohne `?.`.
globalThis.window.yuvomi = { showToast() {}, ...globalThis.window.yuvomi };

const { installMiniDom } = await import('./mini-dom.js');
installMiniDom();

const { setPermissions, clearPermissions } = await import('../public/permissions.js');
const { __test: meals } = await import('../public/pages/meals.js');
const { __test: recipes } = await import('../public/pages/recipes.js');
const { __test: shopping } = await import('../public/pages/shopping.js');

/** Rechte setzen, `fn` fahren (auch async) und danach sicher aufraeumen. */
async function withAccess(modules, fn) {
  setPermissions({ admin: false, modules, widgets: {}, capabilities: {} });
  try {
    return await fn();
  } finally {
    clearPermissions();
  }
}

/** Jeden POST mitschreiben, statt ihn zu senden. */
async function recordPosts(fn) {
  const posts = [];
  const zuvor = globalThis.__apiStub;
  globalThis.__apiStub = {
    post: async (path, body) => {
      posts.push(path);
      return { data: { transferred: 0, skipped: 0, added_ids: [] } };
    },
  };
  try {
    await fn();
  } finally {
    globalThis.__apiStub = zuvor;
  }
  return posts;
}

// Die Rechtekombinationen, die der Server abweist, und die eine, die er annimmt.
const BEIDE = { meals: 'write', shopping: 'write' };
const KEIN_TRANSFER_AUS_DER_KUECHE = [
  ['shopping: read', { meals: 'write', shopping: 'read' }],
  ['shopping: none', { meals: 'write', shopping: 'none' }],
  // Der Pfad-Guard: `/meals` gehoert dem Modul `meals`, und die Route kippt
  // `on_shopping_list` im Essensplan - Mahlzeit -> Einkauf braucht `meals: write`.
  ['meals: read', { meals: 'read', shopping: 'write' }],
];
// Rezept -> Einkauf LIEST das Rezept (Entscheidung 22.09.2026, server/scopes.js
// `READ_LEVEL_WRITES`): dort reicht `meals: read`, `none` bleibt zu.
const REZEPT_ERLAUBT = [
  ['beiden Schreibrechten', BEIDE],
  ['meals: read + shopping: write', { meals: 'read', shopping: 'write' }],
];
const KEIN_REZEPT_TRANSFER = [
  ['shopping: read', { meals: 'write', shopping: 'read' }],
  ['shopping: none', { meals: 'write', shopping: 'none' }],
  ['meals: none', { meals: 'none', shopping: 'write' }],
  ['meals: read + shopping: read', { meals: 'read', shopping: 'read' }],
];
const KEIN_IMPORT_IN_DEN_EINKAUF = [
  ['meals: read', { shopping: 'write', meals: 'read' }],
  ['meals: none', { shopping: 'write', meals: 'none' }],
  // Der Pfad-Guard: `/shopping/...` gehoert dem Modul `shopping`.
  ['shopping: read', { shopping: 'read', meals: 'write' }],
];

const LISTE = { id: 5, name: 'Wocheneinkauf', item_total: 0, item_checked: 0 };

// -------------------------------------------------------------------------
// Essensplan: die Kachel und der Dialog
// -------------------------------------------------------------------------

const mahlzeit = () => ({
  id: 11, title: 'Linsensuppe', date: '2026-09-21', meal_type: 'lunch',
  ingredients: [{ id: 1, name: 'Linsen', quantity: '200 g', on_shopping_list: 0 }],
});
const kachel = () => meals.renderSlot('2026-09-21', { key: 'lunch', label: 'Mittag' }, [mahlzeit()], 1, 1);
const dialog = () => {
  const zuvor = meals.state.lists;
  meals.state.lists = [LISTE];
  try {
    return meals.buildModalContent({ mode: 'edit', date: '2026-09-21', mealType: 'lunch', meal: mahlzeit() });
  } finally {
    meals.state.lists = zuvor;
  }
};

test('Essensplan mit beiden Schreibrechten: Kachel und Dialog bieten den Transfer an', async () => {
  await withAccess(BEIDE, () => {
    assert.match(kachel(), /data-action="transfer-meal"/);
    assert.match(dialog(), /id="transfer-btn"/);
  });
});

for (const [name, modules] of KEIN_TRANSFER_AUS_DER_KUECHE) {
  test(`Essensplan mit ${name}: weder Kachel noch Dialog bieten den Transfer an`, async () => {
    await withAccess(modules, () => {
      assert.doesNotMatch(kachel(), /data-action="transfer-meal"/,
        'der Einkaufswagen an der Kachel fuehrte ins 403');
      const html = dialog();
      assert.doesNotMatch(html, /id="transfer-btn"/, 'der Transfer-Knopf im Dialog fuehrte ins 403');
      assert.doesNotMatch(html, /shopping-transfer/,
        'der ganze Abschnitt entfaellt - ein Auswahlfeld ohne Knopf verspraeche dasselbe');
    });
  });

  test(`Essensplan mit ${name}: der Handler schickt keinen Transfer`, async () => {
    const zuvor = meals.state.lists;
    meals.state.lists = [LISTE];
    try {
      const posts = await withAccess(modules, () => recordPosts(() => meals.transferMeal(11, null)));
      assert.deepEqual(posts, []);
    } finally {
      meals.state.lists = zuvor;
    }
  });
}

test('Essensplan mit beiden Schreibrechten: der Handler schickt den Transfer', async () => {
  const zuvor = meals.state.lists;
  meals.state.lists = [LISTE];
  try {
    const posts = await withAccess(BEIDE, () => recordPosts(() => meals.transferMeal(11, null)));
    assert.deepEqual(posts, ['/meals/11/to-shopping-list']);
  } finally {
    meals.state.lists = zuvor;
  }
});

// -------------------------------------------------------------------------
// Rezepte: der Knopf im Detail
// -------------------------------------------------------------------------

const rezept = { id: 21, title: 'Pfannkuchen' };
const zutaten = [{ name: 'Mehl', quantity: '250 g' }];

async function mitListe(fn) {
  const zuvor = recipes.state.lists;
  recipes.state.lists = [LISTE];
  try {
    return await fn();
  } finally {
    recipes.state.lists = zuvor;
  }
}

for (const [name, modules] of REZEPT_ERLAUBT) {
  test(`Rezept mit ${name}: Knopf da, Handler schickt den Transfer`, async () => {
    await mitListe(async () => {
      await withAccess(modules, async () => {
        const btn = recipes.shoppingTransferButton(rezept, zutaten);
        assert.equal(btn?.dataset.action, 'to-shopping');
        const posts = await recordPosts(() => recipes.transferRecipe(rezept, null));
        assert.deepEqual(posts, ['/recipes/21/to-shopping-list']);
      });
    });
  });
}

for (const [name, modules] of KEIN_REZEPT_TRANSFER) {
  test(`Rezept mit ${name}: kein Knopf, und der Handler schickt nichts`, async () => {
    await mitListe(async () => {
      await withAccess(modules, async () => {
        assert.equal(recipes.shoppingTransferButton(rezept, zutaten), null,
          '„Auf die Einkaufsliste" fuehrte ins 403');
        const posts = await recordPosts(() => recipes.transferRecipe(rezept, null));
        assert.deepEqual(posts, []);
      });
    });
  });
}

// -------------------------------------------------------------------------
// Einkauf: „Aus dem Essensplan uebernehmen" im Listenmenue
// -------------------------------------------------------------------------

function listenMenue() {
  let html = '';
  const bar = {
    replaceChildren() { html = ''; },
    insertAdjacentHTML(_pos, markup) { html += markup; },
  };
  const container = { querySelector: (sel) => (sel === '#list-tabs-bar' ? bar : null) };
  const zuvor = { lists: shopping.state.lists, activeList: shopping.state.activeList, activeListId: shopping.state.activeListId };
  Object.assign(shopping.state, { lists: [LISTE], activeList: LISTE, activeListId: LISTE.id });
  try {
    shopping.renderTabs(container);
  } finally {
    Object.assign(shopping.state, zuvor);
  }
  return html;
}

async function importOeffnetDialog() {
  let geoeffnet = false;
  const zuvorModal = globalThis.__openModal;
  const zuvorId = shopping.state.activeListId;
  globalThis.__openModal = () => { geoeffnet = true; };
  shopping.state.activeListId = LISTE.id;
  try {
    shopping.openMealPlanImport({});
  } finally {
    globalThis.__openModal = zuvorModal;
    shopping.state.activeListId = zuvorId;
  }
  return geoeffnet;
}

test('Einkauf mit beiden Schreibrechten: das Menue fuehrt die Uebernahme, der Dialog geht auf', async () => {
  await withAccess(BEIDE, async () => {
    const html = listenMenue();
    assert.match(html, /data-action="import-meals"/);
    assert.match(html, /data-action="rename-list"/, 'Gegenprobe: das Menue selbst wurde gezeichnet');
    assert.equal(await importOeffnetDialog(), true);
  });
});

for (const [name, modules] of KEIN_IMPORT_IN_DEN_EINKAUF) {
  test(`Einkauf mit ${name}: keine Uebernahme aus dem Essensplan`, async () => {
    await withAccess(modules, async () => {
      assert.doesNotMatch(listenMenue(), /data-action="import-meals"/,
        'die Uebernahme endete im 403 - schon ihre Vorschau');
      assert.equal(await importOeffnetDialog(), false,
        'der Einstieg oeffnet keinen Dialog, dessen Vorschau der Server abweist');
    });
  });
}

// -------------------------------------------------------------------------
// Die Dialoge als Programm: Rechte aendern sich, WAEHREND sie offen stehen
// -------------------------------------------------------------------------

/**
 * Ein Panel-Stub, der je Selektor EIN Element liefert und dessen Listener
 * mitschreibt - genug fuer die Verdrahtung eines Dialogs. Gemessen wird davon
 * nur der eine Handler, den der Test herausgreift.
 */
function stubPanel(werte = {}) {
  const elemente = new Map();
  const element = (sel) => {
    if (!elemente.has(sel)) {
      const listeners = {};
      elemente.set(sel, {
        listeners, value: werte[sel] ?? '', hidden: false, disabled: false, checked: false,
        addEventListener(typ, fn) { listeners[typ] = fn; },
        replaceChildren() {}, appendChild() {}, querySelectorAll: () => [],
      });
    }
    return elemente.get(sel);
  };
  return { querySelector: element, querySelectorAll: () => [], element };
}

/** Einen Dialog mit dem echten `onSave` oeffnen und das Panel zurueckgeben. */
function oeffne(openFn, werte) {
  const panel = stubPanel(werte);
  const zuvor = globalThis.__openModal;
  globalThis.__openModal = (opts) => opts.onSave(panel);
  try {
    openFn();
  } finally {
    globalThis.__openModal = zuvor;
  }
  return panel;
}

test('Mahlzeit-Dialog: gehen die Rechte verloren, waehrend er offen steht, schickt der Transfer-Knopf nichts', async () => {
  const zuvor = meals.state.lists;
  meals.state.lists = [LISTE];
  try {
    const panel = await withAccess(BEIDE, () => oeffne(
      () => meals.openMealModal({ mode: 'edit', date: '2026-09-21', mealType: 'lunch', meal: mahlzeit() }),
      { '#transfer-list-select': String(LISTE.id) },
    ));
    const klick = panel.element('#transfer-btn').listeners.click;
    assert.equal(typeof klick, 'function', 'Gegenprobe: der Dialog hat den Transfer-Knopf verdrahtet');
    for (const [name, modules] of KEIN_TRANSFER_AUS_DER_KUECHE) {
      const posts = await withAccess(modules, () => recordPosts(() => klick()));
      assert.deepEqual(posts, [], `mit ${name} endete der Klick im 403`);
    }
    const posts = await withAccess(BEIDE, () => recordPosts(() => klick()));
    assert.deepEqual(posts, ['/meals/11/to-shopping-list'], 'Gegenprobe: mit beiden Rechten geht der Transfer raus');
  } finally {
    meals.state.lists = zuvor;
    meals.state.modal = null;
  }
});

test('Import-Dialog im Einkauf: gehen die Rechte verloren, waehrend er offen steht, schicken Vorschau und Uebernehmen nichts', async () => {
  const zuvorId = shopping.state.activeListId;
  shopping.state.activeListId = LISTE.id;
  try {
    const panel = await withAccess(BEIDE, () => oeffne(
      () => shopping.openMealPlanImport({}),
      { '#shopping-import-from': '2026-09-21', '#shopping-import-to': '2026-09-27' },
    ));
    const vorschau = panel.element('#shopping-import-from').listeners.change;
    const absenden = () => panel.element('#shopping-import-meals-form').listeners.submit({ preventDefault() {} });
    assert.equal(typeof vorschau, 'function', 'Gegenprobe: der Dialog hat die Vorschau verdrahtet');
    for (const [name, modules] of KEIN_IMPORT_IN_DEN_EINKAUF) {
      const posts = await withAccess(modules, () => recordPosts(async () => { await vorschau(); await absenden(); }));
      assert.deepEqual(posts, [], `mit ${name} endeten Vorschau und Uebernehmen im 403`);
    }
    const posts = await withAccess(BEIDE, () => recordPosts(async () => { await vorschau(); await absenden(); }));
    assert.deepEqual(posts, [`/shopping/${LISTE.id}/import-meal-plan`, `/shopping/${LISTE.id}/import-meal-plan`],
      'Gegenprobe: mit beiden Rechten rechnet die Vorschau, und Uebernehmen schickt den Import');
  } finally {
    shopping.state.activeListId = zuvorId;
  }
});
