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
 * (`settleItemPlacement`: eine Zeile wechselt den Traeger, Zaehlstaende und
 * Fokus ziehen mit). Der Loader hat kein DOM mit Selektoren; ein Nachbau, der
 * genau die erwarteten Abfragen beantwortet, haette nur sich selbst geprueft.
 * Das ist im Browser angesehen.
 *
 * Ausführen: npm run test:shopping-ticked-section
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };

const { installMiniDom } = await import('./mini-dom.js');
installMiniDom();
globalThis.window.yuvomi = { showToast() {}, ...globalThis.window.yuvomi };
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
  shopping.setTickSettleMsForTest(0);
  globalThis.localStorage.clear();
  Object.assign(shopping.state, {
    lists: [{ ...LISTE }], activeList: LISTE, activeListId: LISTE.id, items,
    categories: CATEGORIES, stores: [], currency: 'EUR', currentUserId: 7,
    listsError: null, itemsError: null, collapsedCategories: new Set(), tickedOpen: false,
  }, patch);
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
  zustand([
    item(1, 'Apfel', 'Obst'), item(2, 'Birne', 'Obst', { is_checked: 1 }),
    item(3, 'Quark', 'Milch', { is_checked: 1 }), item(4, 'Butter', 'Milch'),
  ]);
  const { groups, ticked } = shopping.listSections(shopping.state.items);
  assert.deepEqual(groups.map(([cat, members]) => [cat, members.map((i) => i.id)]), [['Obst', [1]], ['Milch', [4]]]);
  assert.deepEqual(ticked.map((i) => i.id), [2, 3], 'in Gang-Reihenfolge der Kategorien');
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

test('Umsortieren nennt auch die abgehakten Artikel der Kategorie, die nicht mehr in ihrem Traeger stehen', async () => {
  zustand([
    item(1, 'Apfel', 'Obst'), item(3, 'Kiwi', 'Obst'),
    item(2, 'Birne', 'Obst', { is_checked: 1 }), item(9, 'Quark', 'Milch', { is_checked: 1 }),
  ]);
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
  assert.deepEqual(liste[0].body, { category: 'Obst', order: [3, 1, 2] },
    'ohne die Birne antwortet die Route mit 400 ("order muss alle Artikel der Kategorie enthalten")');
});

// -------------------------------------------------------------------------
// Der Rueckweg ueber den Vorschlag
// -------------------------------------------------------------------------

function formular({ cat = 'Obst' } = {}) {
  const listeners = {};
  const name = {
    value: '', dataset: {}, focus() {}, classList: { add() {}, remove() {} }, addEventListener() {},
  };
  const qty = { value: '' };
  const catSelect = { value: cat, options: CATEGORIES.map((c) => ({ value: c.name })) };
  const form = {
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    querySelector: () => null,
  };
  const els = { '#quick-add-form': form, '#item-name-input': name, '#item-qty-input': qty, '#item-cat-select': catSelect };
  return {
    name, qty, catSelect,
    container: { querySelector: (sel) => els[sel] ?? null, querySelectorAll: () => [], isConnected: true },
    absenden: () => Promise.all((listeners.submit ?? []).map((fn) => fn({ preventDefault() {} }))),
  };
}

test('Vorschlag fuer einen abgehakten Artikel dieser Liste: das Formular zeigt SEINE Werte und merkt sich die Zeile', () => {
  zustand([item(2, 'Karotten', 'Milch', { is_checked: 1, quantity: '1 kg' })]);
  const f = formular();
  // Der Vorschlag traegt die Werte des juengsten Namensvetters irgendeiner Liste.
  shopping.applyAutocompleteSuggestion(f.container, { dataset: { name: 'karotten', category: 'Obst', quantity: '500 g' } });
  assert.equal(f.name.value, 'Karotten');
  assert.equal(f.name.dataset.reviveId, '2');
  assert.equal(f.catSelect.value, 'Milch');
  assert.equal(f.qty.value, '1 kg');
});

test('Vorschlag fuer einen Namen, der hier nicht abgehakt steht: wie bisher, ohne Merker', () => {
  zustand([item(2, 'Karotten', 'Obst')]); // offen, nicht abgehakt
  const f = formular({ cat: 'Milch' });
  f.name.dataset.reviveId = '7'; // Rest einer frueheren Wahl
  shopping.applyAutocompleteSuggestion(f.container, { dataset: { name: 'Karotten', category: 'Obst', quantity: '500 g' } });
  assert.equal(f.name.value, 'Karotten');
  assert.equal(f.name.dataset.reviveId, undefined);
  assert.equal(f.qty.value, '500 g');
});

test('Absenden nach der Wahl: die abgehakte Zeile kommt zurueck, es entsteht KEINE zweite', async () => {
  zustand([item(2, 'Karotten', 'Obst', { is_checked: 1, quantity: '1 kg' })],
    { lists: [{ ...LISTE, item_total: 1, item_checked: 1 }] });
  const f = formular();
  shopping.wireQuickAdd(f.container);
  shopping.applyAutocompleteSuggestion(f.container, { dataset: { name: 'Karotten', category: 'Obst', quantity: '' } });

  const liste = await aufrufe(() => f.absenden(), { 'PATCH /shopping/items/2': { data: null } });

  assert.deepEqual(liste.map((a) => `${a.method} ${a.path}`), ['PATCH /shopping/items/2']);
  assert.deepEqual(liste[0].body, { is_checked: 0 });
  assert.equal(shopping.state.items.length, 1, 'eine Zeile dieses Namens, nicht zwei');
  assert.equal(shopping.checkedOf(shopping.state.items[0]), 0);
  assert.equal(shopping.state.lists[0].item_checked, 0, 'der Zaehler im Reiter folgt');
  assert.equal(shopping.state.lists[0].item_total, 1);
  assert.equal(f.name.value, '', 'das Feld ist frei fuer den naechsten Artikel');
  assert.equal(f.name.dataset.reviveId, undefined);
});

test('Absenden nach der Wahl mit geaenderter Menge: der Haken faellt, dann folgt die Menge', async () => {
  zustand([item(2, 'Karotten', 'Obst', { is_checked: 1, quantity: '1 kg' })]);
  const f = formular();
  shopping.wireQuickAdd(f.container);
  shopping.applyAutocompleteSuggestion(f.container, { dataset: { name: 'Karotten', category: 'Obst', quantity: '' } });
  f.qty.value = '2 kg';

  const liste = await aufrufe(() => f.absenden(), {
    'PATCH /shopping/items/2': { data: item(2, 'Karotten', 'Obst', { is_checked: 0, quantity: '2 kg' }) },
  });
  assert.deepEqual(liste.map((a) => a.body), [{ is_checked: 0 }, { quantity: '2 kg' }]);
  assert.equal(shopping.state.items[0].quantity, '2 kg');
});

test('Ein Name, der nicht auf der Liste steht, wird wie bisher angelegt', async () => {
  zustand([item(2, 'Karotten', 'Obst', { is_checked: 1 })]);
  const f = formular();
  shopping.wireQuickAdd(f.container);
  shopping.applyAutocompleteSuggestion(f.container, { dataset: { name: 'Lauch', category: 'Obst', quantity: '' } });

  const liste = await aufrufe(() => f.absenden(), {
    'POST /shopping/5/items': { data: item(3, 'Lauch', 'Obst') },
  });
  assert.deepEqual(liste.map((a) => `${a.method} ${a.path}`), ['POST /shopping/5/items']);
  assert.deepEqual(shopping.state.items.map((i) => i.id), [2, 3]);
});

test('Der Merker gilt nur, solange Name und Haken noch stimmen', () => {
  zustand([item(2, 'Karotten', 'Obst', { is_checked: 1 })]);
  const feld = { dataset: { reviveId: '2' } };
  assert.equal(shopping.reviveCandidate(feld, 'karotten ')?.id, 2, 'Gross-/Kleinschreibung egal, wie der Vorschlag sucht');
  assert.equal(shopping.reviveCandidate(feld, 'Karottensaft'), undefined, 'der Name im Feld ist ein anderer geworden');
  assert.equal(shopping.reviveCandidate({ dataset: {} }, 'Karotten'), undefined, 'getippt, nicht gewaehlt');
  // Jemand anderes hat die Zeile inzwischen zurueckgeholt.
  shopping.state.items[0].is_checked = 0;
  assert.equal(shopping.reviveCandidate(feld, 'Karotten'), undefined);
});

test('Scheitert das Zurueckholen, bleibt das Formular stehen und nichts wird angelegt', async () => {
  zustand([item(2, 'Karotten', 'Obst', { is_checked: 1 })]);
  const f = formular();
  shopping.wireQuickAdd(f.container);
  shopping.applyAutocompleteSuggestion(f.container, { dataset: { name: 'Karotten', category: 'Obst', quantity: '' } });

  const fehler = Object.assign(new Error('403'), { data: { error: 'Nein.' } });
  const liste = await aufrufe(() => f.absenden(), { 'PATCH /shopping/items/2': fehler });
  assert.deepEqual(liste.map((a) => a.method), ['PATCH']);
  assert.equal(shopping.checkedOf(shopping.state.items[0]), 1, 'der Haken steht wieder');
  assert.equal(f.name.value, 'Karotten', 'die Eingabe geht nicht verloren');
});
