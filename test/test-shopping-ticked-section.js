/**
 * Tests: Abschnitt "Abgehakt" und der Rueckweg ueber den Vorschlag (#1816)
 * Modul: /public/pages/shopping.js
 *
 * Zugesagt in Discussion #1624: abgehakte Artikel wandern in EINEN
 * zugeklappten Abschnitt am Listenende und bleiben auf der Liste; ein
 * Vorschlag, der auf dieser Liste abgehakt ist, holt DIESE Zeile zurueck statt
 * eine zweite anzulegen; ein Name, der nicht auf der Liste steht, wird wie
 * bisher angelegt.
 *
 * WAS HIER GEMESSEN WIRD: die Aufteilung der Liste und das Markup, das daraus
 * entsteht; wohin eine Zeile nach dem Haken gehoert; der gemerkte
 * Klappzustand; die Umsortierung, die jetzt Artikel nennen muss, die nicht
 * mehr in ihrem Traeger stehen; und der Rueckweg als Programm - vom gewaehlten
 * Vorschlag ueber das Absenden bis zur Anfrage, die hinausgeht.
 *
 * WAS HIER NICHT GEMESSEN WIRD: der Umzug des Knotens selbst
 * (`settleItemPlacements`: Zeilen wechseln den Traeger, Zaehlstaende und Fokus
 * ziehen mit, die gemeinsame Pause). Der Loader hat kein DOM mit Selektoren;
 * das faehrt test-shopping-ticked-browser.js mit der echten Seite in Chromium.
 *
 * Ausführen: npm run test:shopping-ticked-section
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

function makeMemoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
    clear: () => data.clear(),
  };
}
globalThis.localStorage = makeMemoryStorage();

const { __test: shopping } = await import('../public/pages/shopping.js');

const CATEGORIES = [
  { id: 1, name: 'Obst', icon: 'apple', sort_order: 0 },
  { id: 2, name: 'Milch', icon: 'milk', sort_order: 1 },
];
const item = (id, name, category, over = {}) => ({
  id, list_id: 5, name, quantity: null, category, is_checked: 0,
  price_cents: null, store_id: null, url: null, notes: null, tags: [], sort_order: id, ...over,
});
const LISTE = { id: 5, name: 'Wocheneinkauf', item_total: 0, item_checked: 0 };

function zustand(items, patch = {}) {
  shopping.intents.clear();
  shopping.pendingRemovals.clear();
  shopping.resetLoadOrderForTest();
  shopping.resetPillMachine();
  // Keine Wartezeit vor dem Umzug: ohne Liste im Container tut er hier nichts,
  // aber die Suite soll nicht auf seine Uhr warten.
  shopping.setSettlePauseMsForTest(0);
  shopping.resetPlacementHold();
  toasts.length = 0;
  globalThis.localStorage.clear();
  Object.assign(shopping.state, {
    lists: [{ ...LISTE }], activeList: LISTE, activeListId: LISTE.id, items,
    categories: CATEGORIES, stores: [], currency: 'EUR', currentUserId: 7,
    listsError: null, itemsError: null, collapsedCategories: new Set(), tickedOpen: false,
  }, patch);
  // Der Bestand gehoert der offenen Liste - das verlangt das Zurueckholen.
  shopping.setItemsListForTest(shopping.state.activeListId);
}

const nullContainer = () => ({ querySelector: () => null, querySelectorAll: () => [], isConnected: true });

/** Jede Anfrage mitschreiben; die Antwort je "METHODE pfad" oder ein leeres Ergebnis. */
async function aufrufe(fn, antworten = {}) {
  const liste = [];
  const zuvor = globalThis.__apiStub;
  const merke = (method) => async (path, body) => {
    liste.push({ method, path, body });
    const antwort = antworten[`${method} ${path}`];
    if (antwort instanceof Error) throw antwort;
    return antwort ?? { data: null };
  };
  globalThis.__apiStub = {
    get: merke('GET'), post: merke('POST'), put: merke('PUT'), patch: merke('PATCH'), delete: merke('DELETE'),
  };
  try {
    await fn();
  } finally {
    globalThis.__apiStub = zuvor;
  }
  return liste;
}

/** Die Ids der Zeilen eines Markup-Stuecks, in ihrer Reihenfolge. */
const zeilenIds = (html) => [...html.matchAll(/data-swipe-id="(\d+)"/g)].map((m) => Number(m[1]));

/** Zerlegt renderItems() in seine Gruppen: [{ html, kategorie|null }]. */
function gruppen(html) {
  return html.split('<div class="list-group ').slice(1).map((teil) => ({
    html: teil,
    abgehakt: teil.startsWith('item-ticked'),
    kategorie: teil.match(/data-category="([^"]*)"/)?.[1] ?? null,
    versteckt: /^[^>]*\shidden>/.test(teil),
    zaehler: Number(teil.match(/class="list-group__count"[^>]*>(\d+)</)?.[1]),
    traegerVersteckt: /class="row-carrier"[^>]*\shidden>/.test(teil),
  }));
}

// -------------------------------------------------------------------------
// Die Aufteilung
// -------------------------------------------------------------------------

test('listSections: Abgehaktes verlaesst seine Kategorie und steht in EINEM Abschnitt', () => {
  // Der Quark (Milch) hat die KLEINERE Id und den kleineren Rang als die Birne
  // (Obst), und steht im Bestand vor ihr: nur die Kategorieposition stellt die
  // Birne nach vorn.
  zustand([
    item(2, 'Quark', 'Milch', { is_checked: 1, sort_order: 1 }), item(4, 'Butter', 'Milch'),
    item(1, 'Apfel', 'Obst'), item(3, 'Birne', 'Obst', { is_checked: 1, sort_order: 9 }),
    item(5, 'Kiwi', 'Obst', { is_checked: 1, sort_order: 2 }),
  ]);
  const { groups, ticked } = shopping.listSections(shopping.state.items);
  assert.deepEqual(groups.map(([cat, members]) => [cat, members.map((i) => i.id)]), [['Obst', [1]], ['Milch', [4]]]);
  assert.deepEqual(ticked.map((i) => i.id), [5, 3, 2], 'erst die Kategorie in Gang-Reihenfolge, darin der Rang');
});

test('listSections: eine Kategorie ohne offenen Artikel bleibt stehen - ihr Traeger wird fuer den Rueckweg gebraucht', () => {
  zustand([item(1, 'Apfel', 'Obst', { is_checked: 1 }), item(4, 'Butter', 'Milch')]);
  const { groups } = shopping.listSections(shopping.state.items);
  assert.deepEqual(groups.map(([cat, members]) => [cat, members.length]), [['Obst', 0], ['Milch', 1]]);
});

test('listSections: die eigene Absicht zaehlt vor dem Serverstand', () => {
  zustand([item(1, 'Apfel', 'Obst'), item(2, 'Birne', 'Obst', { is_checked: 1 })]);
  shopping.intents.set(1, { value: 1, seq: 1, listId: 5, delta: 1 });
  shopping.intents.set(2, { value: 0, seq: 2, listId: 5, delta: -1 });
  const { groups, ticked } = shopping.listSections(shopping.state.items);
  assert.deepEqual(groups[0][1].map((i) => i.id), [2]);
  assert.deepEqual(ticked.map((i) => i.id), [1]);
});

// -------------------------------------------------------------------------
// Das Markup
// -------------------------------------------------------------------------

test('renderItems: "Abgehakt" ist die letzte Gruppe, zugeklappt, mit Zaehler im Namen des Knopfs', () => {
  zustand([
    item(1, 'Apfel', 'Obst'), item(2, 'Birne', 'Obst', { is_checked: 1 }),
    item(3, 'Quark', 'Milch', { is_checked: 1 }), item(4, 'Butter', 'Milch'),
  ]);
  const alle = gruppen(shopping.renderItems());
  assert.deepEqual(alle.map((g) => g.kategorie), ['Obst', 'Milch', null]);
  const [obst, milch, abgehakt] = alle;

  assert.deepEqual(zeilenIds(obst.html), [1], 'die abgehakte Birne steht nicht mehr unter Obst');
  assert.deepEqual(zeilenIds(milch.html), [4]);
  assert.equal(obst.zaehler, 1, 'der Zaehler der Kategorie folgt den offenen Artikeln');

  assert.ok(abgehakt.abgehakt);
  assert.deepEqual(zeilenIds(abgehakt.html), [2, 3]);
  assert.equal(abgehakt.zaehler, 2);
  assert.equal(abgehakt.versteckt, false);
  assert.equal(abgehakt.traegerVersteckt, true, 'der Abschnitt startet zugeklappt');
  assert.match(abgehakt.html, /data-ticked-toggle\s+aria-expanded="false" aria-controls="shopping-ticked-rows"/);
  assert.match(abgehakt.html, /aria-labelledby="shopping-ticked-label shopping-ticked-count"/,
    'Wort UND Zahl benennen den Knopf - zugeklappt ist die Zahl alles, was er ueber den Inhalt sagt');
  assert.match(abgehakt.html, /id="shopping-ticked-label">shopping\.tickedSection</);
  assert.match(abgehakt.html, /id="shopping-ticked-rows"/);
});

test('renderItems: aufgeklappt gemerkt heisst aufgeklappt gezeichnet', () => {
  zustand([item(2, 'Birne', 'Obst', { is_checked: 1 })], { tickedOpen: true });
  const abgehakt = gruppen(shopping.renderItems()).at(-1);
  assert.equal(abgehakt.traegerVersteckt, false);
  assert.match(abgehakt.html, /aria-expanded="true"/);
});

test('renderItems: ohne Abgehaktes steht der Abschnitt im DOM, aber nicht im Bild; eine leer gehakte Kategorie ebenso', () => {
  zustand([item(1, 'Apfel', 'Obst')]);
  assert.equal(gruppen(shopping.renderItems()).at(-1).versteckt, true, 'leerer Abschnitt');

  zustand([item(1, 'Apfel', 'Obst', { is_checked: 1 }), item(4, 'Butter', 'Milch')]);
  const [obst, milch, abgehakt] = gruppen(shopping.renderItems());
  assert.equal(obst.versteckt, true, 'Obst hat keinen offenen Artikel mehr');
  assert.equal(milch.versteckt, false);
  assert.equal(abgehakt.versteckt, false);
});

// -------------------------------------------------------------------------
// Wohin eine Zeile gehoert
// -------------------------------------------------------------------------

test('placementOf: ein abgehakter Artikel gehoert in den Abschnitt, vor die dort Folgenden', () => {
  zustand([
    item(1, 'Apfel', 'Obst', { is_checked: 1 }), item(2, 'Birne', 'Obst', { is_checked: 1 }),
    item(3, 'Quark', 'Milch', { is_checked: 1 }),
  ]);
  assert.deepEqual(shopping.placementOf(shopping.state.items, 2), { ticked: true, category: 'Obst', following: [3] });
  assert.deepEqual(shopping.placementOf(shopping.state.items, 3).following, []);
});

test('placementOf: zurueckgeholt gehoert er in seine Kategorie, an seinen Rang', () => {
  zustand([
    item(1, 'Apfel', 'Obst', { sort_order: 1 }), item(3, 'Kiwi', 'Obst', { sort_order: 3 }),
    item(2, 'Birne', 'Obst', { sort_order: 2, is_checked: 1 }),
  ]);
  // Der eigene Tipp: die Absicht sagt "offen", der Serverstand noch nicht.
  shopping.intents.set(2, { value: 0, seq: 1, listId: 5, delta: -1 });
  assert.deepEqual(shopping.placementOf(shopping.state.items, 2), { ticked: false, category: 'Obst', following: [3] });
  assert.equal(shopping.placementOf(shopping.state.items, 99), null);
});

// -------------------------------------------------------------------------
// Der Klappzustand
// -------------------------------------------------------------------------

test('Klappzustand: je Mitglied und Liste gemerkt, Grundzustand zu', () => {
  zustand([]);
  assert.equal(shopping.loadTickedOpen(7, 5), false);
  shopping.saveTickedOpen(7, 5, true);
  assert.equal(shopping.loadTickedOpen(7, 5), true);
  assert.equal(shopping.loadTickedOpen(8, 5), false, 'ein anderes Mitglied am selben Geraet');
  assert.equal(shopping.loadTickedOpen(7, 6), false, 'eine andere Liste');
  shopping.saveTickedOpen(7, 5, false);
  assert.equal(globalThis.localStorage.getItem(shopping.tickedOpenStorageKey(7, 5)), null, 'zu hinterlaesst nichts');
});

test('toggleTickedSection: klappt auf, meldet es am Knopf und merkt es sich; der Gegenklick nimmt es zurueck', async () => {
  zustand([item(2, 'Birne', 'Obst', { is_checked: 1 })]);
  const rowsEl = { hidden: true, style: {} };
  const attrs = {};
  let chevronZu = true;
  const button = {
    setAttribute(k, v) { attrs[k] = v; },
    closest: (sel) => (sel === '.list-group' ? { querySelector: (s) => (s === '.row-carrier' ? rowsEl : null) } : null),
    querySelector: (sel) => (sel === '.list-group__chevron'
      ? { classList: { toggle(cls, on) { chevronZu = on; } } } : null),
  };

  shopping.toggleTickedSection(button);
  assert.equal(shopping.state.tickedOpen, true);
  assert.equal(rowsEl.hidden, false);
  assert.equal(attrs['aria-expanded'], 'true');
  assert.equal(chevronZu, false);
  assert.equal(shopping.loadTickedOpen(7, 5), true);

  shopping.toggleTickedSection(button);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(rowsEl.hidden, true, '`hidden` faellt nach dem Einklappen');
  assert.equal(attrs['aria-expanded'], 'false');
  assert.equal(shopping.loadTickedOpen(7, 5), false);
});

// -------------------------------------------------------------------------
// Umsortieren: die Route verlangt die GANZE Kategorie
// -------------------------------------------------------------------------

test('Umsortieren nennt jeden Artikel der Kategorie, der nicht in ihrem Traeger steht - abgehakt oder noch unterwegs', async () => {
  zustand([
    item(1, 'Apfel', 'Obst'), item(3, 'Kiwi', 'Obst'),
    item(2, 'Birne', 'Obst', { is_checked: 1 }), item(9, 'Quark', 'Milch', { is_checked: 1 }),
    // Eben zurueckgeholt (die Absicht sagt "offen"), die Zeile wartet aber noch
    // im Abschnitt auf die Pause: weder im Traeger noch abgehakt.
    item(6, 'Mango', 'Obst', { is_checked: 1 }),
  ]);
  shopping.intents.set(6, { value: 0, seq: 1, listId: 5, delta: -1 });
  // Der Traeger von Obst nach dem Zug: Kiwi vor Apfel. Die Birne steht im Abschnitt.
  const zeile = (id) => ({ dataset: { swipeId: String(id) }, querySelector: () => null });
  const rowsEl = {
    querySelectorAll: (sel) => (sel === ':scope > .swipe-row' ? [zeile(3), zeile(1)] : []),
  };
  const groupEl = { dataset: { category: 'Obst' }, querySelector: (sel) => (sel === '.row-carrier' ? rowsEl : null) };

  const liste = await aufrufe(async () => {
    shopping.persistItemOrder(groupEl, nullContainer(), null);
    await new Promise((r) => setTimeout(r, 0));
  }, { 'PATCH /shopping/5/items/reorder': { data: shopping.state.items } });

  assert.equal(liste.length, 1);
  assert.deepEqual(liste[0].body, { category: 'Obst', order: [3, 1, 2, 6] },
    'ohne Birne ODER Mango antwortet die Route mit 400 ("order muss alle Artikel der Kategorie enthalten")');
});

// -------------------------------------------------------------------------
// Wartende Zeilen
// -------------------------------------------------------------------------

test('Eine wartende Zeile steht in der Aufteilung dort, wo sie wartet - auch ueber einen Neuaufbau', async () => {
  zustand([item(1, 'Apfel', 'Obst'), item(2, 'Birne', 'Obst')]);
  shopping.setSettlePauseMsForTest(10_000);
  await aufrufe(async () => {
    await shopping.toggleShoppingItem(1, 0, nullContainer());
  }, { 'PATCH /shopping/items/1': { data: null } });

  assert.equal(shopping.checkedOf(shopping.state.items[0]), 1, 'der Haken ist gesetzt');
  assert.deepEqual([...shopping.heldRows], [[1, false]], 'die Zeile wartet in ihrer Kategorie');
  const [obst, abgehakt] = gruppen(shopping.renderItems());
  assert.deepEqual(zeilenIds(obst.html), [1, 2], 'ein Neuaufbau in der Pause laesst sie stehen');
  assert.deepEqual(zeilenIds(abgehakt.html), []);

  shopping.resetPlacementHold();
  const danach = gruppen(shopping.renderItems());
  assert.deepEqual(zeilenIds(danach[0].html), [2]);
  assert.deepEqual(zeilenIds(danach.at(-1).html), [1]);
});

test('Ein Listenwechsel verwirft die Pause der alten Liste', async () => {
  zustand([item(1, 'Apfel', 'Obst')]);
  shopping.setSettlePauseMsForTest(10_000);
  await aufrufe(async () => {
    await shopping.toggleShoppingItem(1, 0, nullContainer());
    assert.equal(shopping.heldRows.size, 1);
    await shopping.switchList(5, nullContainer());
  }, { 'PATCH /shopping/items/1': { data: null } });
  assert.equal(shopping.heldRows.size, 0);
});

test('Die Pause ist laenger als der Weg zur naechsten Zeile: das Dreifache des laengsten Bewegungsschritts', () => {
  shopping.setSettlePauseMsForTest(null);
  assert.equal(shopping.settlePauseMs(), 1200);
});

// -------------------------------------------------------------------------
// Verdrahtung
// -------------------------------------------------------------------------

test('Der Klick auf den Kopf von "Abgehakt" ist verdrahtet - und bei `read` ebenso', async () => {
  zustand([item(2, 'Birne', 'Obst', { is_checked: 1 })]);
  const listeners = {};
  const root = { dataset: {}, addEventListener(type, fn, opts) { if (!opts?.capture) (listeners[type] ??= []).push(fn); } };
  shopping.wireListContentEvents({ querySelector: (sel) => (sel === '.shopping-page' ? root : null), querySelectorAll: () => [] });

  const rowsEl = { hidden: true, style: {} };
  const button = {
    setAttribute() {},
    closest: (sel) => (sel === '.list-group' ? { querySelector: (q) => (q === '.row-carrier' ? rowsEl : null) } : null),
    querySelector: () => null,
  };
  const klick = { target: { closest: (sel) => (sel === '[data-ticked-toggle]' ? button : null) } };
  assert.equal(listeners.click?.length, 1, 'ein Klick-Verteiler haengt an der Seite');
  await listeners.click[0](klick);
  assert.equal(shopping.state.tickedOpen, true);
  assert.equal(rowsEl.hidden, false);
});

test('Der Klappzustand wird beim Listenwechsel geladen', async () => {
  zustand([]);
  shopping.saveTickedOpen(7, 6, true);
  await aufrufe(() => shopping.switchList(6, nullContainer()));
  assert.equal(shopping.state.tickedOpen, true, 'Liste 6 war offen gemerkt');
  await aufrufe(() => shopping.switchList(5, nullContainer()));
  assert.equal(shopping.state.tickedOpen, false, 'Liste 5 nicht');
});

// -------------------------------------------------------------------------
// Der Rueckweg: gewaehlt oder getippt
// -------------------------------------------------------------------------

function formular({ cat = 'Sonstiges', options = [...CATEGORIES.map((c) => c.name), 'Sonstiges'] } = {}) {
  const listeners = {};
  const catListeners = {};
  const name = { value: '', focus() {}, classList: { add() {}, remove() {} }, addEventListener() {} };
  const qty = { value: '' };
  const catSelect = {
    value: cat, options: options.map((value) => ({ value })),
    addEventListener(type, fn) { catListeners[type] = fn; },
  };
  const form = {
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    querySelector: () => null,
  };
  const els = { '#quick-add-form': form, '#item-name-input': name, '#item-qty-input': qty, '#item-cat-select': catSelect };
  return {
    name, qty, catSelect,
    container: { querySelector: (sel) => els[sel] ?? null, querySelectorAll: () => [], isConnected: true },
    absenden: () => Promise.all((listeners.submit ?? []).map((fn) => fn({ preventDefault() {} }))),
    /** Die Kategorie von Hand waehlen, wie es das Feld meldet. */
    waehleKategorie(value) { catSelect.value = value; catListeners.change?.(); },
  };
}

const wege = (liste) => liste.map((a) => `${a.method} ${a.path}`);

test('Vorschlag fuer einen abgehakten Artikel dieser Liste: das Formular zeigt SEINE Werte', () => {
  zustand([item(2, 'Karotten', 'Milch', { is_checked: 1, quantity: '1 kg' })]);
  const f = formular();
  // Der Vorschlag traegt die Werte des juengsten Namensvetters irgendeiner Liste.
  shopping.applyAutocompleteSuggestion(f.container, { dataset: { name: 'karotten', category: 'Obst', quantity: '500 g' } });
  assert.equal(f.name.value, 'Karotten');
  assert.equal(f.catSelect.value, 'Milch');
  assert.equal(f.qty.value, '1 kg');
});

test('Vorschlag fuer einen Namen, der hier nicht abgehakt steht: wie bisher', () => {
  zustand([item(2, 'Karotten', 'Obst')]); // offen, nicht abgehakt
  const f = formular({ cat: 'Milch' });
  shopping.applyAutocompleteSuggestion(f.container, { dataset: { name: 'Karotten', category: 'Obst', quantity: '500 g' } });
  assert.equal(f.name.value, 'Karotten');
  assert.equal(f.catSelect.value, 'Obst');
  assert.equal(f.qty.value, '500 g');
});

test('Absenden nach der Wahl: die abgehakte Zeile kommt zurueck, es entsteht KEINE zweite', async () => {
  zustand([item(2, 'Karotten', 'Obst', { is_checked: 1, quantity: '1 kg' })],
    { lists: [{ ...LISTE, item_total: 1, item_checked: 1 }] });
  const f = formular();
  shopping.wireQuickAdd(f.container);
  shopping.applyAutocompleteSuggestion(f.container, { dataset: { name: 'Karotten', category: 'Obst', quantity: '' } });

  const liste = await aufrufe(() => f.absenden(), { 'PATCH /shopping/items/2': { data: null } });

  assert.deepEqual(wege(liste), ['PATCH /shopping/items/2']);
  assert.deepEqual(liste[0].body, { is_checked: 0 });
  assert.equal(shopping.state.items.length, 1, 'eine Zeile dieses Namens, nicht zwei');
  assert.equal(shopping.checkedOf(shopping.state.items[0]), 0);
  assert.equal(shopping.state.lists[0].item_checked, 0, 'der Zaehler im Reiter folgt');
  assert.equal(shopping.state.lists[0].item_total, 1);
  assert.equal(f.name.value, '', 'das Feld ist frei fuer den naechsten Artikel');
  assert.equal(shopping.heldRows.size, 0, 'das Zurueckholen wartet nicht auf die Pause');
});

test('Ein von Hand getippter Name wird ebenso abgeglichen - ohne Gross-/Kleinschreibung, getrimmt', async () => {
  zustand([item(2, 'Karotten', 'Obst', { is_checked: 1, quantity: '1 kg' })]);
  const f = formular();
  shopping.wireQuickAdd(f.container);
  f.name.value = '  karOTTen ';

  const liste = await aufrufe(() => f.absenden(), { 'PATCH /shopping/items/2': { data: null } });
  assert.deepEqual(wege(liste), ['PATCH /shopping/items/2'], 'kein POST: es bleibt bei einer Zeile');
  assert.deepEqual(liste[0].body, { is_checked: 0 }, 'leere Felder lassen die Werte der Zeile stehen');
  assert.equal(shopping.state.items[0].quantity, '1 kg');
});

test('Die Rueckmeldung nennt den Artikel, mit seinem Namen von der Zeile und genau einmal maskiert', async () => {
  zustand([item(2, 'Tee <grün> & Co', 'Obst', { is_checked: 1 })]);
  const f = formular();
  shopping.wireQuickAdd(f.container);
  f.name.value = 'tee <grün> & co';
  await aufrufe(() => f.absenden(), { 'PATCH /shopping/items/2': { data: null } });
  // Der Loader-Stub von t() haengt die Parameter an den Schluessel. Der Toast
  // setzt seinen Text ueber textContent (utils/toast-show.js): ein esc() hier
  // stuende als "&lt;gruen&gt;" auf dem Schirm.
  assert.deepEqual(toasts, [['shopping.itemBackToast{"name":"Tee <grün> & Co"}', 'info']]);
});

test('Getippte Menge ueberschreibt, eine NICHT gewaehlte Kategorie schreibt nichts', async () => {
  zustand([item(2, 'Karotten', 'Milch', { is_checked: 1, quantity: '1 kg' })]);
  const f = formular({ cat: 'Sonstiges' }); // das Feld zeigt seinen Standard
  shopping.wireQuickAdd(f.container);
  f.name.value = 'Karotten';
  f.qty.value = '2 kg';

  const liste = await aufrufe(() => f.absenden(), {
    'PATCH /shopping/items/2': { data: item(2, 'Karotten', 'Milch', { is_checked: 0, quantity: '2 kg' }) },
  });
  assert.deepEqual(liste.map((a) => a.body), [{ is_checked: 0 }, { quantity: '2 kg' }],
    'die Kategorie "Sonstiges" hat niemand gewaehlt - die Zeile bleibt unter Milch');
  assert.equal(shopping.state.items[0].category, 'Milch');
  assert.equal(shopping.state.items[0].quantity, '2 kg');
});

test('Eine Zeile mit einer Kategorie, die es in der Auswahl nicht gibt, wird nicht still umgeschrieben', async () => {
  zustand([item(2, 'Karotten', 'Altbestand', { is_checked: 1 })]);
  const f = formular({ cat: 'Sonstiges' });
  shopping.wireQuickAdd(f.container);
  // Die Wahl aus dem Vorschlag kann die Kategorie nicht ins Feld setzen.
  shopping.applyAutocompleteSuggestion(f.container, { dataset: { name: 'Karotten', category: 'Altbestand', quantity: '' } });
  assert.equal(f.catSelect.value, 'Sonstiges');

  const liste = await aufrufe(() => f.absenden(), { 'PATCH /shopping/items/2': { data: null } });
  assert.deepEqual(liste.map((a) => a.body), [{ is_checked: 0 }]);
  assert.equal(shopping.state.items[0].category, 'Altbestand');
});

test('Eine von Hand GEWAEHLTE Kategorie wird geschrieben, und die Liste baut neu', async () => {
  zustand([item(2, 'Karotten', 'Obst', { is_checked: 1 })]);
  const f = formular();
  shopping.wireQuickAdd(f.container);
  shopping.applyAutocompleteSuggestion(f.container, { dataset: { name: 'Karotten', category: 'Obst', quantity: '' } });
  f.waehleKategorie('Milch');

  // Der Neuaufbau leert den Listen-Knoten und fuellt ihn neu - der Umzug einer
  // einzelnen Zeile fragt ihn nur ab.
  let neubau = 0;
  const liste5 = {
    dataset: {}, replaceChildren() { neubau += 1; }, insertAdjacentHTML() {},
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
  };
  const base = f.container.querySelector;
  f.container.querySelector = (sel) => (sel === '#items-list' ? liste5 : base(sel));

  const liste = await aufrufe(() => f.absenden(), {
    // Die Antwort traegt einen ALTEN Haken (sie wurde vor dem ersten PATCH gelesen).
    'PATCH /shopping/items/2': { data: item(2, 'Karotten', 'Milch', { is_checked: 1 }) },
  });
  assert.deepEqual(liste.map((a) => a.body), [{ is_checked: 0 }, { category: 'Milch' }]);
  assert.equal(shopping.state.items[0].category, 'Milch');
  assert.equal(shopping.state.items[0].is_checked, 0, 'die Antwort des zweiten PATCH dreht den bestaetigten Haken nicht zurueck');
  assert.equal(neubau, 1, 'ein Kategoriewechsel gruppiert neu (updateItemsList), genau einmal');
});

test('Die Wahl der Kategorie gilt fuer EIN Absenden: danach ist das Feld wieder ungewaehlt', async () => {
  zustand([item(2, 'Karotten', 'Obst', { is_checked: 1 }), item(3, 'Lauch', 'Obst', { is_checked: 1 })]);
  const f = formular();
  shopping.wireQuickAdd(f.container);
  f.name.value = 'Karotten';
  f.waehleKategorie('Milch');
  await aufrufe(() => f.absenden(), { 'PATCH /shopping/items/2': { data: item(2, 'Karotten', 'Milch', { is_checked: 0 }) } });

  f.name.value = 'Lauch';
  f.catSelect.value = 'Milch'; // steht noch da, gewaehlt hat es fuer den Lauch niemand
  const liste = await aufrufe(() => f.absenden(), { 'PATCH /shopping/items/3': { data: null } });
  assert.deepEqual(liste.map((a) => a.body), [{ is_checked: 0 }]);
});

test('Ein Name, der nicht auf der Liste steht, wird wie bisher angelegt', async () => {
  zustand([item(2, 'Karotten', 'Obst', { is_checked: 1 })]);
  const f = formular();
  shopping.wireQuickAdd(f.container);
  f.name.value = 'Karottensaft';

  const liste = await aufrufe(() => f.absenden(), {
    'POST /shopping/5/items': { data: item(3, 'Karottensaft', 'Sonstiges') },
  });
  assert.deepEqual(wege(liste), ['POST /shopping/5/items']);
  assert.deepEqual(shopping.state.items.map((i) => i.id), [2, 3]);
  assert.deepEqual(toasts, []);
});

test('Ein Name, der OFFEN auf der Liste steht, wird wie bisher ein zweites Mal angelegt', async () => {
  zustand([item(2, 'Karotten', 'Obst')]);
  const f = formular();
  shopping.wireQuickAdd(f.container);
  f.name.value = 'Karotten';
  const liste = await aufrufe(() => f.absenden(), { 'POST /shopping/5/items': { data: item(3, 'Karotten', 'Sonstiges') } });
  assert.deepEqual(wege(liste), ['POST /shopping/5/items']);
});

test('Waehrend eines Listenwechsels traegt der Bestand noch die alte Liste: der Name gilt als neu und geht an die OFFENE', async () => {
  // state.items gehoert noch Liste 5, offen ist schon Liste 6 (switchList hat
  // activeListId gesetzt, loadItems laeuft noch).
  zustand([item(2, 'Karotten', 'Obst', { is_checked: 1 })]);
  shopping.state.activeListId = 6;
  assert.equal(shopping.tickedItemNamed('Karotten'), undefined);

  const f = formular();
  shopping.wireQuickAdd(f.container);
  f.name.value = 'Karotten';
  const liste = await aufrufe(() => f.absenden(), {
    'POST /shopping/6/items': { data: item(9, 'Karotten', 'Sonstiges', { list_id: 6 }) },
  });
  assert.deepEqual(wege(liste), ['POST /shopping/6/items'], 'kein PATCH auf einen Artikel der verlassenen Liste');
  assert.equal(shopping.checkedOf(shopping.state.items.find((i) => i.id === 2)), 1, 'der alte bleibt abgehakt');
});

test('Zweimal Enter: das zweite Absenden wartet nicht hinter dem ersten her, es faellt', async () => {
  zustand([item(2, 'Karotten', 'Obst', { is_checked: 1 })]);
  const f = formular();
  shopping.wireQuickAdd(f.container);
  f.name.value = 'Karotten';

  const liste = await aufrufe(async () => {
    const erstes = f.absenden();
    const zweites = f.absenden(); // der PATCH des ersten ist noch unterwegs
    await Promise.all([erstes, zweites]);
  }, {
    'PATCH /shopping/items/2': { data: null },
    'POST /shopping/5/items': { data: item(3, 'Karotten', 'Sonstiges') },
  });
  assert.deepEqual(wege(liste), ['PATCH /shopping/items/2'], 'PATCH + POST waeren zwei offene Zeilen');
  assert.equal(shopping.state.items.length, 1);
});

test('Scheitert das Zurueckholen, bleibt das Formular stehen, nichts wird angelegt, und das naechste Absenden geht wieder', async () => {
  zustand([item(2, 'Karotten', 'Obst', { is_checked: 1 })]);
  const f = formular();
  shopping.wireQuickAdd(f.container);
  f.name.value = 'Karotten';

  const fehler = Object.assign(new Error('403'), { data: { error: 'Nein.' } });
  const liste = await aufrufe(() => f.absenden(), { 'PATCH /shopping/items/2': fehler });
  assert.deepEqual(liste.map((a) => a.method), ['PATCH']);
  assert.equal(shopping.checkedOf(shopping.state.items[0]), 1, 'der Haken steht wieder');
  assert.equal(f.name.value, 'Karotten', 'die Eingabe geht nicht verloren');
  assert.deepEqual(toasts, [['Nein.', 'danger']], 'keine Erfolgsmeldung');

  const nochmal = await aufrufe(() => f.absenden(), { 'PATCH /shopping/items/2': { data: null } });
  assert.deepEqual(wege(nochmal), ['PATCH /shopping/items/2'], 'die Sperre faellt auch nach einem Fehlschlag');
});

// -------------------------------------------------------------------------
// Das Dropdown
// -------------------------------------------------------------------------

test('Das Dropdown markiert Namen, die abgehakt auf der offenen Liste stehen - und nur die', async () => {
  zustand([item(2, 'Karotten', 'Obst', { is_checked: 1 }), item(3, 'Kartoffeln', 'Obst')]);
  const listeners = {};
  let html = '';
  const input = { value: 'kar', addEventListener(type, fn) { listeners[type] = fn; } };
  const dropdown = {
    hidden: true,
    replaceChildren() { html = ''; },
    insertAdjacentHTML(_pos, markup) { html += markup; },
    querySelectorAll: () => [],
  };
  const els = { '#item-name-input': input, '#autocomplete-dropdown': dropdown };
  shopping.wireAutocomplete({ querySelector: (sel) => els[sel] ?? null });

  await aufrufe(async () => {
    listeners.input();
    await new Promise((r) => setTimeout(r, 260)); // die Entprellung der Abfrage
  }, { 'GET /shopping/suggestions?q=kar': { data: [
    { name: 'Karotten', category: 'Obst', quantity: null },
    { name: 'Kartoffeln', category: 'Obst', quantity: null },
  ] } });

  const zeilen = html.split('<div class="autocomplete-item"').slice(1);
  assert.equal(zeilen.length, 2);
  assert.match(zeilen[0], /data-name="Karotten"[\s\S]*autocomplete-item__state">shopping\.itemStateChecked</);
  assert.doesNotMatch(zeilen[1], /autocomplete-item__state/, 'Kartoffeln stehen offen auf der Liste');
});
