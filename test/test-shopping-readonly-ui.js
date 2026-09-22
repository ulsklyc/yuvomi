/**
 * Modul: Nur-lesen im Einkauf (#1265 P4)
 * Zweck: `shopping.js` zeichnete einem Mitglied mit `shopping: read` jede
 *        Schreib-Geste - Abhaken (Knopf, Zeilenklick, Wischen), Loeschen (Knopf,
 *        Wischen), Bearbeiten, Umsortieren (Griff, Ziehen, Pfeiltasten),
 *        Quick-Add und FAB, neue Liste und das ganze Listenmenue. Der Server
 *        antwortete 403, und das optimistische Abhaken sprang zurueck.
 *
 *        Die Regel (Kopf von public/utils/module-access.js):
 *          - Der Haken zeigt ZUSTAND und bleibt, als `span role="img"`, dessen
 *            Beschriftung den Zustand nennt - nicht als `disabled`-Knopf.
 *          - Handlungen verschwinden; Wischen und Ziehen haben kein Markup und
 *            bleiben deshalb UNVERDRAHTET (Regel 3).
 *          - Was nur im Editor stand (Preis, Laden, Link, Notiz), steht bei
 *            `read` in einer Leseansicht (Regel 9) - und der Knopf dorthin
 *            folgt dem Datensatz: ohne solche Felder gibt es nichts zu lesen.
 *          - Eine Positivliste im delegierten Handler nimmt den Effekt.
 *
 *        Dazu die zwei Kreuzwege der Kueche, die fremdes Recht brauchen:
 *        „In den Vorrat" (Pfad-Guard `pantry`) und der Warenkorb des Vorrats
 *        samt Sammel-Pille (Pfad-Guard `shopping`).
 *
 *        Gemessen am echten Markup und an den echten Handlern: die Zusage eines
 *        Riegels ist das AUSBLEIBEN einer Anfrage, das sieht kein Textguard.
 *        Jeder Fall prueft den Schreibrecht-Fall mit - erschiene das Gesuchte
 *        dort nicht, waere der Aufbau des Tests kaputt, nicht die Regel erfuellt.
 *
 * Ausführen: npm run test:shopping-readonly-ui
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eachRule } from './css-rules.js';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };

const { installMiniDom, MiniElement } = await import('./mini-dom.js');
installMiniDom();
// Der Einkauf ruft `window.yuvomi.showToast` ohne `?.`.
globalThis.window.yuvomi = { showToast() {}, ...globalThis.window.yuvomi };
globalThis.window.innerWidth = 1280;

// Die echte Sammel-Pille (utils/bulk-pill.js) setzt Klassen ueber `classList`;
// der Mini-DOM kennt nur das Attribut. Ein duenner Aufsatz darauf, damit das
// Markup, das sie baut, im `class`-Attribut ankommt und lesbar bleibt.
Object.defineProperty(MiniElement.prototype, 'classList', {
  get() {
    const el = this;
    const liste = () => el.className.split(/\s+/).filter(Boolean);
    const setze = (l) => { el.className = l.join(' '); };
    return {
      add: (...c) => setze([...new Set([...liste(), ...c])]),
      remove: (...c) => setze(liste().filter((k) => !c.includes(k))),
      contains: (c) => liste().includes(c),
      toggle: (c, an = !liste().includes(c)) => { if (an) setze([...new Set([...liste(), c])]); else setze(liste().filter((k) => k !== c)); return an; },
    };
  },
});

// Die Sammel-Pille zeichnet in eine Schicht der Shell; hier eine, deren
// Inhalt sich lesen laesst.
const pillenSchicht = Object.assign(new MiniElement('div'), { dataset: {} });
globalThis.document.getElementById = (id) => (id === 'bulk-pill-layer' ? pillenSchicht : null);

const { setPermissions, clearPermissions } = await import('../public/permissions.js');
const { __test: shopping } = await import('../public/pages/shopping.js');
const { __test: pantry } = await import('../public/pages/pantry.js');

async function withAccess(modules, fn) {
  setPermissions({ admin: false, modules, widgets: {}, capabilities: {} });
  try {
    return await fn();
  } finally {
    clearPermissions();
  }
}

const LESEN = { shopping: 'read', pantry: 'write' };
const SCHREIBEN = { shopping: 'write', pantry: 'write' };

/** Jeden API-Aufruf mitschreiben, statt ihn zu senden. */
async function aufrufe(fn, antworten = {}) {
  const liste = [];
  const zuvor = globalThis.__apiStub;
  const merke = (method) => async (path) => {
    liste.push(`${method} ${path}`);
    return antworten[`${method} ${path}`] ?? { data: [] };
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

/** Wer ein Modal oeffnet, kommt hier an - mit seinen Optionen. */
function modalMitschnitt(fn) {
  const geoeffnet = [];
  const zuvor = globalThis.__openModal;
  globalThis.__openModal = (opts) => { geoeffnet.push(opts); };
  try {
    fn();
  } finally {
    globalThis.__openModal = zuvor;
  }
  return geoeffnet;
}

const artikel = (over = {}) => ({
  id: 1, list_id: 5, name: 'Milch', quantity: '2 l', category: 'Sonstiges', is_checked: 0,
  price_cents: null, store_id: null, url: null, notes: null, tags: [], sort_order: 0, ...over,
});
const LISTE = { id: 5, name: 'Wocheneinkauf', item_total: 1, item_checked: 0 };

function zustand(patch = {}) {
  shopping.intents.clear();
  shopping.pendingRemovals.clear();
  shopping.resetLoadOrderForTest();
  shopping.resetPillMachine();
  Object.assign(shopping.state, {
    lists: [LISTE], activeList: LISTE, activeListId: LISTE.id, items: [artikel()],
    categories: [{ id: 1, name: 'Sonstiges', icon: 'tag', sort_order: 0 }],
    stores: [{ id: 9, name: 'Wochenmarkt' }], currency: 'EUR',
    listsError: null, itemsError: null, collapsedCategories: new Set(),
  }, patch);
}

/** Ein Container, der die Knoten liefert, nach denen die Seite fragt. */
function container(knoten = {}) {
  return {
    querySelector: (sel) => knoten[sel] ?? null,
    querySelectorAll: () => [],
    isConnected: true,
  };
}

/** Ein Knoten, der seine Listener nach Typ sammelt. */
function lauscher() {
  const listeners = {};
  return {
    dataset: {},
    listeners,
    addEventListener(type, fn, opts) {
      if (opts?.capture) return; // die Popover-Mechanik, nicht der Verteiler
      (listeners[type] ??= []).push(fn);
    },
  };
}

/** Ein Klick-Ereignis, dessen Ziel genau die Knoten findet, die man ihm gibt. */
function klick({ aktion = null, id = 1, checked = 0, zeile = null } = {}) {
  const ziel = aktion ? { dataset: { action: aktion, id: String(id), checked: String(checked) } } : null;
  return {
    target: {
      closest: (sel) => {
        if (sel === '[data-action]') return ziel;
        if (sel === '.shopping-item') return zeile;
        return null;
      },
    },
  };
}

// -------------------------------------------------------------------------
// Die Zeile
// -------------------------------------------------------------------------

test('Zeile bei `read`: der Haken bleibt als Zeichen, jede Handlung geht', async () => {
  zustand();
  const html = await withAccess(LESEN, () => shopping.renderItem(artikel()));
  assert.match(html, /<span class="item-check item-check--static\s*"\s+role="img"/);
  assert.match(html, /aria-label="Milch: shopping\.itemStateOpen"/, 'die Beschriftung nennt den Zustand');
  for (const weg of ['data-action="toggle-item"', 'data-action="delete-item"', 'data-action="reorder-handle"',
    'swipe-reveal', 'shopping.markDoneLabel', 'data-lucide="pencil"']) {
    assert.ok(!html.includes(weg), `${weg} steht bei \`read\` noch in der Zeile`);
  }
  assert.match(html, /class="swipe-row swipe-row--static"/, 'ohne Geste auch kein Wisch-Chevron');
  assert.match(html, /shopping-item--static/);
});

test('Zeile mit Schreibrecht (Gegenfall): Knopf, Griff, Bearbeiten, Loeschen, Wischflaechen', async () => {
  zustand();
  const html = await withAccess(SCHREIBEN, () => shopping.renderItem(artikel()));
  for (const da of ['data-action="toggle-item"', 'data-action="delete-item"', 'data-action="reorder-handle"',
    'data-action="item-details"', 'swipe-reveal--done', 'swipe-reveal--delete']) {
    assert.ok(html.includes(da), `${da} fehlt - dann misst der Lesefall nichts`);
  }
  assert.doesNotMatch(html, /item-check--static|swipe-row--static|shopping-item--static/);
});

test('Zeile bei `read`: ein abgehakter Artikel zeigt den Haken gesetzt und sagt es', async () => {
  zustand();
  const html = await withAccess(LESEN, () => shopping.renderItem(artikel({ is_checked: 1 })));
  assert.match(html, /item-check--static item-check--checked/);
  assert.match(html, /aria-label="Milch: shopping\.itemStateChecked"/);
});

test('Leseansicht-Knopf folgt dem Datensatz: nur, wo Preis, Laden, Link oder Notiz stehen', async () => {
  zustand();
  await withAccess(LESEN, () => {
    assert.doesNotMatch(shopping.renderItem(artikel()), /data-action="item-details"/,
      'Name, Menge und Kategorie zeigt die Zeile selbst - der Knopf saehe nichts Neues');
    for (const feld of [{ notes: 'laktosefrei' }, { url: 'https://example.org' }, { price_cents: 129 }, { store_id: 9 }]) {
      const html = shopping.renderItem(artikel(feld));
      assert.match(html, /data-action="item-details"/, `${Object.keys(feld)[0]} steht nur im Editor`);
      assert.match(html, /data-lucide="info"/, 'kein Stift: der Knopf oeffnet nichts zum Bearbeiten');
    }
    assert.doesNotMatch(shopping.renderItem(artikel({ store_id: 404 })), /data-action="item-details"/,
      'ein Laden, den es nicht mehr gibt, ist kein Wert');
  });
});

// -------------------------------------------------------------------------
// Leseansicht
// -------------------------------------------------------------------------

test('Leseansicht zeigt alles, was der Editor zeigt, und keine Eingabe', () => {
  zustand();
  const html = shopping.itemReadHtml(artikel({
    price_cents: 129, store_id: 9, url: 'https://example.org/milch', notes: 'laktosefrei',
  }));
  for (const wert of ['2 l', 'Sonstiges', 'Wochenmarkt', 'laktosefrei',
    'href="https://example.org/milch"', 'shopping.priceLabel']) {
    assert.ok(html.includes(wert), `${wert} fehlt in der Leseansicht`);
  }
  assert.doesNotMatch(html, /<(input|textarea|select|button|form)\b/, 'Leseansicht, kein gesperrtes Formular');
  const leer = shopping.itemReadHtml(artikel({ quantity: null }));
  assert.doesNotMatch(leer, /shopping\.itemQtyLabel|shopping\.priceLabel|shopping\.storeLabel|shopping\.urlLabel|shopping\.notesLabel/,
    'ein leeres Feld bekommt keine Zeile');
});

test('Leseansicht: ein Link ohne http(s) wird nicht zum Link', () => {
  zustand();
  const html = shopping.itemReadHtml(artikel({ url: 'javascript:alert(1)' }));
  assert.doesNotMatch(html, /href=/);
  assert.match(html, /javascript:alert\(1\)/, 'der Wert steht trotzdem da - als Text');
});

test('Details oeffnen: bei `read` die Leseansicht, mit Schreibrecht der Editor', async () => {
  zustand({ items: [artikel({ notes: 'laktosefrei' })] });
  const lesend = await withAccess(LESEN, () => modalMitschnitt(() => shopping.openItemDetails(1, container())));
  assert.equal(lesend.length, 1);
  assert.match(lesend[0].content, /data-view="read"/);
  assert.doesNotMatch(lesend[0].content, /item-details-form/);
  const schreibend = await withAccess(SCHREIBEN, () => modalMitschnitt(() => shopping.openItemDetails(1, container())));
  assert.match(schreibend[0].content, /id="item-details-form"/, 'Gegenfall: der Editor');
});

test('Editor: gehen die Rechte verloren, waehrend er offen steht, speichert er nichts', async () => {
  zustand();
  const felder = {};
  const feld = (sel) => (felder[sel] ??= {
    value: sel === '#item-details-name' ? 'Hafermilch' : '', checked: false, listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; }, focus() {}, replaceChildren() {},
  });
  const panel = { querySelector: feld };
  const [opts] = await withAccess(SCHREIBEN, () => modalMitschnitt(() => shopping.openItemDetails(1, container())));
  opts.onSave(panel);
  const absenden = () => felder['#item-details-form'].listeners.submit({ preventDefault() {} });
  assert.equal(typeof felder['#item-details-form'].listeners.submit, 'function', 'Gegenprobe: verdrahtet');
  assert.deepEqual(await withAccess(LESEN, () => aufrufe(absenden)), []);
  const zurueck = await withAccess(SCHREIBEN, () => aufrufe(absenden, {
    'PATCH /shopping/items/1': { data: artikel({ name: 'Hafermilch' }) },
  }));
  assert.deepEqual(zurueck, ['PATCH /shopping/items/1'], 'Gegenprobe: mit Schreibrecht geht die Bearbeitung raus');
});

// -------------------------------------------------------------------------
// Reiter, Menue, Quick-Add, Leerzustaende
// -------------------------------------------------------------------------

function leiste(modules) {
  const bar = new MiniElement('div');
  return withAccess(modules, () => {
    shopping.renderTabs(container({ '#list-tabs-bar': bar }));
    return bar.innerHTML;
  });
}

test('Reiterleiste bei `read`: Listen waehlbar, kein Anlegen, kein Listenmenue', async () => {
  zustand();
  const html = await leiste(LESEN);
  assert.match(html, /data-action="switch-list"/);
  assert.doesNotMatch(html, /data-action="new-list"/);
  assert.doesNotMatch(html, /list-actions-menu|rename-list|send-list|delete-list|manage-categories/,
    'jeder Menueeintrag schreibt - senden ist am Server ein POST');
  const gegen = await leiste(SCHREIBEN);
  assert.match(gegen, /data-action="new-list"/);
  assert.match(gegen, /data-action="send-list"/);
});

test('Listeninhalt bei `read`: kein Quick-Add', async () => {
  zustand();
  const inhalt = (modules) => withAccess(modules, () => {
    const content = new MiniElement('div');
    shopping.renderListContent(container({ '#list-content': content }));
    return content.innerHTML;
  });
  assert.doesNotMatch(await inhalt(LESEN), /quick-add-form/);
  assert.match(await inhalt(SCHREIBEN), /id="quick-add-form"/, 'Gegenfall');
});

test('Leerzustaende bei `read`: nur der Zustand, keine Einladung und kein Knopf', async () => {
  const leer = async (modules, patch) => withAccess(modules, () => {
    zustand(patch);
    const ziel = new MiniElement('div');
    if (patch.activeList === null) {
      shopping.renderListContent(container({ '#list-content': ziel }));
    } else {
      shopping.mountItems(ziel, container());
    }
    return ziel.innerHTML;
  });
  const ohneListe = { lists: [], activeList: null, activeListId: null, items: [] };
  const leereListe = { items: [] };
  for (const [name, patch, texte] of [
    ['keine Liste', ohneListe, ['shopping.noListsDescription', 'shopping.noListsHint', 'shopping.newListButton']],
    ['leere Liste', leereListe, ['shopping.emptyListDescription', 'emptyHint.shopping', 'shopping.emptyAction']],
  ]) {
    const lesend = await leer(LESEN, patch);
    const schreibend = await leer(SCHREIBEN, patch);
    assert.match(lesend, /empty-state__title/, `${name}: der Zustand bleibt benannt`);
    for (const text of texte) {
      assert.ok(!lesend.includes(text), `${name}: ${text} laedt bei \`read\` zu einer Handlung ein`);
      assert.ok(schreibend.includes(text), `${name}: Gegenfall - ${text} fehlt auch mit Schreibrecht`);
    }
  }
});

// -------------------------------------------------------------------------
// Verdrahtung und Riegel
// -------------------------------------------------------------------------

test('Wischen und Ziehen: bei `read` haengt keine Verdrahtung an der Liste', async () => {
  const verdrahtet = async (modules) => withAccess(modules, () => {
    zustand();
    const liste = new MiniElement('div');
    liste.dataset = {};
    const zuvor = globalThis.__sortableCalls;
    globalThis.__sortableCalls = [];
    try {
      shopping.updateItemsList(container({ '#items-list': liste }));
      return { listener: liste.listener, reorderWired: liste.dataset.reorderWired };
    } finally {
      globalThis.__sortableCalls = zuvor;
    }
  });
  assert.deepEqual(await verdrahtet(LESEN), { listener: undefined, reorderWired: undefined },
    'ein Riegel im Ende-Handler kaeme zu spaet - die Zeile waere schon weggewischt');
  const gegen = await verdrahtet(SCHREIBEN);
  assert.ok(gegen.listener, 'Gegenfall: mit Schreibrecht haengen Geste und Pfeiltasten');
  assert.equal(gegen.reorderWired, '1');
});

function verteiler() {
  const root = lauscher();
  shopping.wireListContentEvents(container({ '.shopping-page': root }));
  const [fn] = root.listeners.click ?? [];
  assert.equal(typeof fn, 'function', 'der delegierte Handler haengt nicht');
  return fn;
}

test('Delegierter Handler bei `read`: nur die Positivliste kommt durch', async () => {
  assert.deepEqual([...shopping.READ_SAFE_ACTIONS].sort(), ['item-details', 'switch-list'],
    'eine neue lesende Aktion ist eine Entscheidung - diese Liste haelt fest, welche es gibt');
  zustand();
  const handler = verteiler();
  const zeile = {
    dataset: { itemId: '1' },
    querySelector: (sel) => (sel === '[data-action="toggle-item"]' ? { dataset: { checked: '0' } } : null),
  };
  const undo = [];
  globalThis.__undoStub = (opts) => undo.push(opts);
  try {
    const gesten = [
      klick({ aktion: 'toggle-item' }),
      klick({ aktion: 'delete-item' }),
      klick({ aktion: 'rename-list' }),
      klick({ aktion: 'delete-list' }),
      klick({ aktion: 'send-list' }),
      klick({ aktion: 'eine-morgen-ergaenzte-aktion' }),
      klick({ zeile }),
    ];
    const lesend = await withAccess(LESEN, () => aufrufe(async () => {
      for (const g of gesten) await handler(g);
    }));
    assert.deepEqual(lesend, [], 'bei `read` erreicht kein Klick den Server');
    assert.equal(undo.length, 0, 'und kein Loeschen landet im Undo-Fenster');

    zustand();
    const schreibend = await withAccess(SCHREIBEN, () => aufrufe(async () => {
      await handler(klick({ aktion: 'toggle-item' }));
      zustand();
      await handler(klick({ zeile }));
      zustand();
      await handler(klick({ aktion: 'delete-item' }));
    }));
    assert.deepEqual(schreibend, ['PATCH /shopping/items/1', 'PATCH /shopping/items/1'],
      'Gegenprobe: Knopf und Zeilenklick haken mit Schreibrecht ab');
    assert.equal(undo.length, 1, 'Gegenprobe: das Loeschen landet im Undo-Fenster');
  } finally {
    delete globalThis.__undoStub;
  }
});

test('Reiterleiste bei `read`: der Anlegeweg fragt nicht einmal nach dem Namen', async () => {
  zustand();
  const bar = lauscher();
  shopping.wireTabBar(container({ '#list-tabs-bar': bar }));
  const fragen = [];
  const zuvor = globalThis.__promptModal;
  globalThis.__promptModal = (...a) => { fragen.push(a); return null; };
  try {
    await withAccess(LESEN, () => bar.listeners.click[0](klick({ aktion: 'new-list' })));
    assert.equal(fragen.length, 0);
    await withAccess(SCHREIBEN, () => bar.listeners.click[0](klick({ aktion: 'new-list' })));
    assert.equal(fragen.length, 1, 'Gegenfall: mit Schreibrecht fragt der Anlegeweg');
  } finally {
    globalThis.__promptModal = zuvor;
  }
});

test('Einstiege bei `read`: Abhaken, Loeschen, Senden und die Verwalter schicken nichts und oeffnen nichts', async () => {
  zustand();
  const undo = [];
  globalThis.__undoStub = (opts) => undo.push(opts);
  try {
    let modals = [];
    const posts = await withAccess(LESEN, () => aufrufe(async () => {
      await shopping.toggleShoppingItem(1, 0, container());
      shopping.deleteItemUndoable(1, container());
      shopping.clearCheckedUndoable(container());
      await shopping.openSendListDialog(container());
      modals = modalMitschnitt(() => {
        shopping.openDuplicateListDialog(container());
        shopping.openStoreManager(container());
      });
      await shopping.openCategoryManager(container());
    }));
    assert.deepEqual(posts, []);
    assert.deepEqual(modals, []);
    assert.equal(undo.length, 0);

    zustand();
    const gegen = await withAccess(SCHREIBEN, () => aufrufe(async () => {
      await shopping.toggleShoppingItem(1, 0, container());
      zustand(); // abgehakt gaebe es nichts Offenes mehr zu senden
      await shopping.openSendListDialog(container());
    }));
    assert.deepEqual(gegen, ['PATCH /shopping/items/1', 'GET /shopping/send-recipients'], 'Gegenfall');
  } finally {
    delete globalThis.__undoStub;
  }
});

test('Live-Auffrischung bei `read`: das Zeichen behaelt seine Zustands-Beschriftung', async () => {
  zustand();
  const label = {};
  const zeichen = {
    dataset: {},
    classList: { toggle() {}, contains: (c) => c === 'item-check--static' },
    setAttribute: (k, v) => { label[k] = v; },
  };
  const zeile = {
    dataset: {},
    closest: () => null,
    querySelector: (sel) => (sel === '.item-check' ? zeichen : null),
  };
  await withAccess(LESEN, () => shopping.updateItemRow(
    container({ '.swipe-row[data-swipe-id="1"]': zeile }),
    artikel({ is_checked: 1 }),
  ));
  assert.equal(label['aria-label'], 'Milch: shopping.itemStateChecked',
    'jemand anderes hakt ab - das Zeichen darf keine Handlungs-Beschriftung bekommen');
  assert.equal(zeichen.dataset.checked, undefined);
});

// -------------------------------------------------------------------------
// Kreuzwege der Kueche
// -------------------------------------------------------------------------

function pille(modules) {
  return withAccess(modules, () => {
    zustand({ items: [artikel({ is_checked: 1 })] });
    pillenSchicht.replaceChildren();
    shopping.setBulkPillHoldMsForTest(60_000);
    shopping.updateCheckedActions(container(), { userChecked: true });
    const html = pillenSchicht.innerHTML;
    shopping.resetPillMachine();
    shopping.setBulkPillHoldMsForTest(null);
    return html;
  });
}

test('Sammel-Pille: „In den Vorrat" nur mit Schreibrecht auf den Vorrat', async () => {
  const beide = await pille(SCHREIBEN);
  assert.match(beide, /shopping\.toPantry/, 'Gegenfall: die Pille wurde gezeichnet');
  assert.match(beide, /common\.delete/);
  const ohneVorrat = await pille({ shopping: 'write', pantry: 'read' });
  assert.doesNotMatch(ohneVorrat, /shopping\.toPantry/, 'der Uebertrag endete im 403 des Vorrats');
  assert.match(ohneVorrat, /common\.delete/, 'das Loeschen gehoert dem Einkauf und bleibt');
  assert.doesNotMatch(await pille(LESEN), /common\.delete/, 'bei `shopping: read` loescht die Pille nichts');
  assert.equal(await pille({ shopping: 'read', pantry: 'read' }), '', 'ohne eine Aktion keine Pille');
});

test('„In den Vorrat": der Einstieg fragt den Vorrat, bevor er irgendetwas laedt', async () => {
  zustand({ items: [artikel({ is_checked: 1 })] });
  assert.deepEqual(await withAccess({ shopping: 'write', pantry: 'read' },
    () => aufrufe(() => shopping.openPantryTransfer(container()))), []);
  const gegen = await withAccess(SCHREIBEN, () => aufrufe(() => shopping.openPantryTransfer(container())));
  assert.deepEqual(gegen, ['GET /pantry/locations'], 'Gegenfall: mit Schreibrecht laedt der Dialog die Lagerorte');
});

const knapp = () => ({
  id: 3, name: 'Reis', quantity: 1, min_quantity: 5, unit: 'pcs', category: 'Sonstiges',
  location_id: null, expires_on: null,
});

test('Vorrat: der Warenkorb der Zeile nur mit Schreibrecht auf den Einkauf', async () => {
  const zeile = (modules) => withAccess(modules, () => pantry.rowEl(knapp()).outerHTML);
  assert.match(await zeile({ pantry: 'write', shopping: 'write' }), /pantry-row__cart"/,
    'Gegenfall: ein knapper Artikel traegt den Warenkorb');
  const ohne = await zeile({ pantry: 'write', shopping: 'read' });
  assert.doesNotMatch(ohne, /pantry-row__cart"/, 'der Warenkorb endete im 403');
  assert.match(ohne, /pantry-row__cart-slot/, 'der Slot bleibt, damit die Bedienzone gleich breit bleibt');
});

test('Vorrat: der Handler schickt ohne Einkaufsrecht nichts - nicht einmal die Listenabfrage', async () => {
  pantry.state.lists = [{ id: 5, name: 'Wocheneinkauf' }];
  try {
    assert.deepEqual(await withAccess({ pantry: 'write', shopping: 'read' },
      () => aufrufe(() => pantry.sendToShopping([knapp()], null))), []);
    const gegen = await withAccess({ pantry: 'write', shopping: 'write' },
      () => aufrufe(() => pantry.sendToShopping([knapp()], null)));
    assert.deepEqual(gegen, ['POST /shopping/5/import-pantry'], 'Gegenfall: mit Schreibrecht geht der Uebertrag raus');
  } finally {
    pantry.state.lists = null;
  }
});

test('Vorrat: die Sammel-Pille fragt denselben Riegel wie der Warenkorb', () => {
  // renderBulkBar() zeichnet in die Shell-Schicht und liest den Seitenzustand;
  // als Fallback die kommentarfreie Quelle (siehe den Kopf von
  // test-module-readonly-ui.js), damit die Begruendung den Test nicht haelt.
  const quelle = readFileSync(new URL('../public/pages/pantry.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const koerper = quelle.slice(quelle.indexOf('function renderBulkBar()'), quelle.indexOf('function renderList()'));
  assert.match(koerper, /if \([^{]*!mayTransferPantryToShopping\(\)\) \{\s*clearBulkPill\(\);\s*return;/,
    'ohne Einkaufsrecht muss die Pille VOR setBulkPill() verschwinden');
});

// -------------------------------------------------------------------------
// Kaskade: das Zeichen lockt nicht
// -------------------------------------------------------------------------

const css = (datei) => [...eachRule(readFileSync(new URL(`../public/styles/${datei}`, import.meta.url), 'utf8'))];

test('CSS: der Hover-Rahmen nimmt das Zeichen aus, Zeiger und Pop sind neutral', () => {
  const regeln = css('shopping.css');
  const hover = regeln.filter(({ selector }) => /\.item-check[^,]*:hover::before/.test(selector));
  assert.ok(hover.length > 0, 'die Hover-Regel des Hakens fehlt');
  for (const { selector } of hover) {
    assert.match(selector, /\.item-check:not\(\.item-check--static\):hover::before/,
      `${selector} traefe auch das Zeichen`);
  }
  const statisch = regeln.find(({ selector, at }) => !at.length && selector === '.item-check.item-check--static');
  assert.ok(statisch, 'die Regel fuer das Zeichen fehlt - (0,2,0), damit sie `.item-check--checked` schlaegt');
  assert.match(statisch.body, /cursor:\s*default/);
  assert.match(statisch.body, /animation:\s*none/);
  const zeile = regeln.find(({ selector, at }) => !at.length && selector === '.shopping-item.shopping-item--static');
  assert.match(zeile?.body ?? '', /cursor:\s*default/, 'die Zeile verspraeche sonst ein Antippen');
});

test('CSS: eine Zeile ohne Geste zeigt keinen Wisch-Chevron', () => {
  const regeln = css('layout.css');
  const basis = regeln.findIndex(({ selector, at }) => !at.length && selector === '.swipe-row::after');
  const statisch = regeln.findIndex(({ selector, at }) => !at.length && selector === '.swipe-row--static::after');
  assert.ok(basis >= 0 && statisch >= 0);
  assert.ok(statisch > basis, 'gleiche Spezifitaet - die Ausnahme muss NACH der Basisregel stehen');
  assert.match(regeln[statisch].body, /content:\s*none/);
});
