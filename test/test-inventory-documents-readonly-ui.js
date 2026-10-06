/**
 * Modul: Nur-lesen im Inventar und in den Dokumenten, dazu die Besitzregel der
 *        Dokumente (#1265, letztes Paket) und `edit.primary` im Inventar (#1463)
 * Zweck: `inventory.js` und `documents.js` zeichneten einem Mitglied mit
 *        `read` jede Schreib-Geste - Anlegen, Bearbeiten, Loeschen, „Erledigt"
 *        an einer Frist, die Orts- und Kategorienverwaltung, Ordner anlegen,
 *        umbenennen, verschieben und loeschen, das Dokument-Menue und die
 *        Mehrfachauswahl. Der Server antwortete 403; das Loeschen eines
 *        Dokuments kam nach dem Rueckgaengig-Fenster als Fehler wieder.
 *
 *        Die Dokumente tragen dazu eine ZWEITE Regel, die die Oberflaeche gar
 *        nicht kannte: aendern, archivieren und loeschen darf nur, wer das
 *        Dokument angelegt hat, oder ein Admin (`canManageDocument()` in
 *        server/services/document-access.js). Mit `documents: write` trug
 *        trotzdem jedes fremde Familien-Dokument das volle Menue.
 *
 *        Die Regel (Kopf von public/utils/module-access.js):
 *          - Handlungen verschwinden, der Zustand bleibt (Regel 2).
 *          - Die Leseansicht zeigt alles, was der Editor zeigt (Regel 9): im
 *            Inventar die Detailansicht, in den Dokumenten der Betrachter - was
 *            sonst nur im Formular stand, steht bei fehlendem Recht dort.
 *          - Ein Riegel im Handler nimmt den Effekt; in den Dokumenten als
 *            Positivliste (`READ_SAFE_ACTIONS`).
 *
 *        Gemessen am echten Markup und an den echten Handlern: die Zusage eines
 *        Riegels ist das AUSBLEIBEN einer Anfrage, das sieht kein Textguard.
 *        Jeder Fall prueft den Schreibrecht-Fall mit - erschiene das Gesuchte
 *        dort nicht, waere der Aufbau des Tests kaputt, nicht die Regel erfuellt.
 *
 * Ausführen: npm run test:module-readonly-ui
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eachRule } from './css-rules.js';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
globalThis.CSS = globalThis.CSS ?? { escape: (value) => String(value) };
globalThis.localStorage = globalThis.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };

const { installMiniDom, MiniElement } = await import('./mini-dom.js');
installMiniDom();
globalThis.window.yuvomi = { showToast() {}, ...globalThis.window.yuvomi };
globalThis.window.matchMedia = globalThis.window.matchMedia
  ?? (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
globalThis.document.activeElement = globalThis.document.activeElement ?? null;
if (!globalThis.navigator?.pdfViewerEnabled) {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { pdfViewerEnabled: true, onLine: true } });
}

const { setPermissions, clearPermissions } = await import('../public/permissions.js');
const { __test: inventory } = await import('../public/pages/inventory.js');
const { __test: documents, render: renderDocuments } = await import('../public/pages/documents.js');

async function withAccess(modules, fn, { admin = false } = {}) {
  setPermissions({ admin, modules, widgets: {}, capabilities: {} });
  try {
    return await fn();
  } finally {
    clearPermissions();
  }
}

const LESEN = { inventory: 'read', documents: 'read', budget: 'read' };
const SCHREIBEN = { inventory: 'write', documents: 'write', budget: 'write' };

/**
 * Jeden API-Aufruf mitschreiben, statt ihn zu senden. Wer wissen muss, WAS
 * hinausging (ein `PUT` auf denselben Pfad ist Umbenennen ODER Verschieben),
 * gibt `inhalte` mit und bekommt dort `[Aufruf, Rumpf]` je Schreibanfrage.
 */
async function aufrufe(fn, antworten = {}, inhalte = null) {
  const liste = [];
  const zuvor = globalThis.__apiStub;
  const merke = (method) => async (path, body) => {
    liste.push(`${method} ${path}`);
    if (inhalte && method !== 'GET') inhalte.push([`${method} ${path}`, body]);
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

const schreibend = (liste) => liste.filter((eintrag) => !eintrag.startsWith('GET '));

/** Einen Stub der Ladehilfe fuer die Dauer von `fn` setzen. */
async function mitStub(name, wert, fn) {
  const zuvor = globalThis[name];
  globalThis[name] = wert;
  try {
    return await fn();
  } finally {
    globalThis[name] = zuvor;
  }
}

/** Wer ein Modal oeffnet, kommt hier an - mit seinen Optionen. */
async function modalMitschnitt(fn) {
  const geoeffnet = [];
  await mitStub('__openModal', (opts) => { geoeffnet.push(opts); }, fn);
  return geoeffnet;
}

/** Wer die geteilte Detailansicht oeffnet, kommt hier an. */
async function detailMitschnitt(fn) {
  const geoeffnet = [];
  await mitStub('__openDetailView', (opts) => { geoeffnet.push(opts); }, fn);
  return geoeffnet;
}

/** Wer ein Rueckgaengig-Fenster oeffnet, kommt hier an. */
async function undoMitschnitt(fn) {
  const fenster = [];
  await mitStub('__undoStub', (opts) => { fenster.push(opts); }, fn);
  return fenster;
}

/** Alle Knoten eines Mini-Baums mit diesem Tag. */
function knoten(el, tag) {
  if (!el || !el.childNodes) return [];
  return [...(el.tagName === tag ? [el] : []), ...el.childNodes.flatMap((kind) => knoten(kind, tag))];
}

/**
 * Dem Mini-DOM fuer die Dauer von `fn` geben, was es bewusst nicht hat und was
 * zwei Wege hier brauchen: `classList` (die Sammel-Pille faerbt ihre
 * Loeschen-Kapsel) und die Popover-Methoden (das Ordner-Menue). Liefert alles,
 * was in der Zeit gebaut wurde - ein Menue, das NICHT aufgeht, ist darin nicht
 * zu finden.
 */
async function mitElementen(fn) {
  const gebaut = [];
  const bauen = globalThis.document.createElement;
  const koerper = globalThis.document.body.childNodes.length;
  globalThis.document.createElement = (tag) => {
    const el = new MiniElement(tag);
    const klassen = () => el.className.split(' ').filter(Boolean);
    el.classList = {
      add: (...namen) => { el.className = [...new Set([...klassen(), ...namen])].join(' '); },
      remove: (...namen) => { el.className = klassen().filter((k) => !namen.includes(k)).join(' '); },
      contains: (name) => klassen().includes(name),
      toggle() {},
    };
    Object.assign(el, { showPopover() {}, hidePopover() {}, remove() {}, focus() {}, offsetWidth: 0, offsetHeight: 0 });
    gebaut.push(el);
    return el;
  };
  try {
    await fn();
  } finally {
    globalThis.document.createElement = bauen;
    globalThis.document.body.childNodes.length = koerper;
  }
  return gebaut;
}

/**
 * Eine Seite, die sich merkt, was in sie gezeichnet wird - gerade genug, damit
 * `render()` und die Zeichner der Dokumente an ihr laufen.
 *
 * SIE ERFINDET NICHTS: einen Traeger gibt es nur, wenn seine `id` im
 * gezeichneten Seitenmarkup steht, und einen Menue-Eintrag nur, wenn das Markup
 * sein Attribut traegt. Ein Knopf, den die Seite bei `read` weglaesst, ist
 * damit auch hier nicht zu finden.
 */
function seite(vorab = '') {
  let html = vorab;
  const traeger = new Map();
  const eintraege = new Map();
  const menue = {
    addEventListener() {},
    querySelectorAll: () => [],
    querySelector(selektor) {
      if (!html.includes(selektor.replace(/^\[|\]$/g, ''))) return null;
      if (!eintraege.has(selektor)) eintraege.set(selektor, { hidden: false, disabled: false, querySelector: () => null });
      return eintraege.get(selektor);
    },
  };
  const gezeichnet = (id) => {
    if (!traeger.has(id)) traeger.set(id, new MiniElement('div'));
    return traeger.get(id);
  };
  const BEKANNT = ['documents-list', 'documents-folder-browser', 'documents-tools-menu'];
  return {
    isConnected: true,
    dataset: {},
    addEventListener() {},
    replaceChildren() { html = ''; },
    insertAdjacentHTML(_position, markup) { html += markup; },
    querySelectorAll: () => [],
    querySelector(selektor) {
      const id = /^#([\w-]+)$/.exec(selektor)?.[1];
      if (!BEKANNT.includes(id) || !html.includes(`id="${id}"`)) return null;
      return id === 'documents-tools-menu' ? menue : gezeichnet(id);
    },
    get html() { return html; },
    liste: () => gezeichnet('documents-list').innerHTML,
    ordner: () => gezeichnet('documents-folder-browser').innerHTML,
    eintrag: (selektor) => menue.querySelector(selektor),
  };
}

/**
 * Ein Formular aus lauter Feldern: jede Anfrage nach einem Feld bekommt eines,
 * mit dem Wert aus `werte` oder leer. Die Speicher-Handler lesen nur `.value`
 * (und `.files`), also traegt das den ganzen Weg bis zur Anfrage.
 */
function felder(werte = {}) {
  const gemerkt = new Map();
  return {
    querySelectorAll: () => [],
    querySelector(selektor) {
      if (!gemerkt.has(selektor)) {
        const wert = werte[selektor];
        gemerkt.set(selektor, {
          value: typeof wert === 'string' ? wert : '', files: Array.isArray(wert) ? wert : [],
          disabled: false, hidden: false, textContent: '',
        });
      }
      return gemerkt.get(selektor);
    },
  };
}

/** Alle Zeilen (`rows`) einer Detailansicht, Gruppen aufgeloest. */
const zeilen = (sections) => sections.flatMap((s) => (s.rows ? s.rows : [s]));

// -------------------------------------------------------------------------
// Inventar
// -------------------------------------------------------------------------

/** Ein Gegenstand mit einer seit Jahren faelligen Frist - „Erledigt" stuende also da. */
const gegenstand = (over = {}) => ({
  id: 42, name: 'Fernseher', category: 'electronics', category_icon: 'tv', status: 'active', condition: 'good',
  location_path: 'Wohnzimmer', purchase_price: 999, currency: 'EUR', attachments: [], linked_entries: [],
  tracked_dates: [{ id: 5, label: 'TUEV', date: '2020-01-15', reminder_offset_days: 30, interval_months: 24, interval_distance: null }],
  ...over,
});

async function detailOeffnen(modules) {
  const [opts] = await withAccess(modules, () => detailMitschnitt(
    () => aufrufe(() => inventory.openItemDetail(gegenstand()), {
      'GET /inventory/items/42/history': { data: { timeline: [], odometer: [] } },
    }),
  ));
  assert.ok(opts, 'die Detailansicht geht auf - bei jedem Recht, sie ist die Leseansicht');
  return opts;
}

test('Inventar bei `read`: die Detailansicht bietet weder Bearbeiten noch Loeschen an', async () => {
  const lesen = await detailOeffnen(LESEN);
  assert.equal(lesen.edit ?? null, null, '`edit` fehlt - openDetailView baut dann keinen Bearbeiten-Knopf');
  assert.deepEqual(lesen.actions ?? [], [], 'keine Objektaktion, also kein „Loeschen"');
  assert.equal(lesen.title, 'Fernseher', 'die Ansicht selbst bleibt');

  const voll = await detailOeffnen(SCHREIBEN);
  assert.equal(typeof voll.edit?.mount, 'function', 'Gegenfall: Bearbeiten steht mit Schreibrecht da');
  assert.equal(typeof voll.edit?.standalone, 'function');
  assert.deepEqual(voll.actions.map((a) => a.id), ['inventory-detail-delete'], 'Gegenfall: Loeschen');
});

test('Inventar (#1463): Bearbeiten ist im Blatt der Primaerknopf, Loeschen bleibt zurueckgenommen', async () => {
  const voll = await detailOeffnen(SCHREIBEN);
  assert.equal(voll.edit.primary, true, '`edit.primary` - Bearbeiten steht unten in der Daumenzone');
  const [loeschen] = voll.actions;
  assert.equal(loeschen.variant, 'danger-ghost');
  assert.equal(loeschen.align, 'start', 'Loeschen steht am Anfang der Fusszeile, weg vom Daumen');
});

test('Inventar bei `read`: eine faellige Frist traegt kein „Erledigt", zeigt aber, was sonst nur das Formular zeigt', async () => {
  const fristZeile = (opts) => zeilen(opts.sections).find((r) => r.label === 'inventory.trackedDatesLabel');

  const lesen = fristZeile(await detailOeffnen(LESEN));
  assert.ok(lesen?.node, 'die Fristen stehen da');
  assert.deepEqual(knoten(lesen.node, 'button'), [], '„Erledigt" ist eine Handlung');
  assert.match(lesen.node.textContent, /TUEV/, 'die Frist selbst bleibt');
  assert.match(lesen.node.textContent, /inventory\.trackedDateOverdueDays/, 'und dass sie faellig ist, sagt die Zeile');
  assert.match(lesen.node.textContent, /inventory\.trackedDateRemindBeforeLabel: 30/, 'der Erinnerungs-Vorlauf stand nur im Formular');
  assert.match(lesen.node.textContent, /inventory\.trackedDateIntervalMonthsLabel: 24/, 'das Monats-Intervall ebenso');

  const voll = fristZeile(await detailOeffnen(SCHREIBEN));
  assert.equal(knoten(voll.node, 'button').length, 1, 'Gegenfall: „Erledigt" steht mit Schreibrecht da');
  assert.doesNotMatch(voll.node.textContent, /trackedDateRemindBeforeLabel|trackedDateIntervalMonthsLabel/,
    'Gegenfall: wer bearbeiten darf, findet beides im Formular');
});

test('Inventar bei `read`: kein Werkzeugmenue, und der Leerzustand laedt zu nichts ein', async () => {
  const lesen = await withAccess(LESEN, () => ({ menue: inventory.inventoryToolsHtml(), leer: inventory.emptyInventoryState() }));
  assert.equal(lesen.menue, '', 'Orte und Kategorien verwalten sind beide Schreibwege (Regel 7)');
  assert.equal(lesen.leer.title, 'inventory.emptyTitle');
  assert.equal(lesen.leer.action, undefined, 'kein Anlegen-Knopf');
  assert.equal(lesen.leer.description, undefined, 'und kein Text, der zu ihm einlaedt (Regel 9)');

  const voll = await withAccess(SCHREIBEN, () => ({ menue: inventory.inventoryToolsHtml(), leer: inventory.emptyInventoryState() }));
  assert.match(voll.menue, /data-action="manage-locations"/, 'Gegenfall');
  assert.match(voll.menue, /data-action="manage-categories"/);
  assert.equal(typeof voll.leer.action?.onClick, 'function', 'Gegenfall: der Knopf');
  assert.equal(voll.leer.description, 'inventory.emptyDescription');
});

/** Jeder Schreibweg des Inventars, der ohne Formular-Panel erreichbar ist. */
async function inventarSchreibwege() {
  const item = gegenstand();
  const modale = await modalMitschnitt(async () => {
    inventory.openItemModal('create');
    inventory.openItemModal('edit', item);
    await inventory.openLocationManager();
    await inventory.openCategoryManager();
    // Nicht abgewartet: mit Schreibrecht wartet die Karte auf ihr Schliessen.
    inventory.openCompletionSheet(item, item.tracked_dates[0]);
    await inventory.removeItem(item);
  });
  return modale;
}

test('Inventar bei `read`: kein Schreibweg oeffnet ein Formular oder sendet etwas', async () => {
  let modale;
  const gesendet = await withAccess(LESEN, () => aufrufe(async () => { modale = await inventarSchreibwege(); }));
  assert.deepEqual(modale, [], 'Anlegen, Bearbeiten, beide Verwaltungen und die Abschluss-Karte bleiben zu');
  assert.deepEqual(schreibend(gesendet), [], 'und Loeschen sendet nichts (die Rueckfrage ist im Test bejaht)');

  let volleModale;
  const voll = await withAccess(SCHREIBEN, () => aufrufe(async () => { volleModale = await inventarSchreibwege(); }));
  assert.equal(volleModale.length, 5, 'Gegenfall: zwei Formulare, zwei Verwaltungen, die Abschluss-Karte');
  assert.deepEqual(schreibend(voll), ['DELETE /inventory/items/42'], 'Gegenfall: Loeschen geht raus');
});

test('Inventar bei `read`: der direkte Aufruf des Speicherns sendet nichts', async () => {
  // Der Riegel in openItemModal() haelt das Formular zu - aber ein Formular,
  // das schon offen stand, als das Recht fiel, ruft saveItem() trotzdem.
  const formular = () => felder({
    '#inv-name': 'Fernseher', '#inv-category': 'electronics', '#inv-status': 'active', '#inv-condition': 'good',
  });
  const speichere = (modules, mode) => withAccess(modules, () => aufrufe(
    () => inventory.saveItem(formular(), mode, mode === 'edit' ? gegenstand() : null, null, null, null),
  ));

  assert.deepEqual(schreibend(await speichere(LESEN, 'edit')), [], 'read: Bearbeiten speichert nicht');
  assert.deepEqual(schreibend(await speichere(LESEN, 'create')), [], 'read: Anlegen speichert nicht');

  assert.deepEqual(schreibend(await speichere(SCHREIBEN, 'edit')), ['PUT /inventory/items/42'], 'Gegenfall: Bearbeiten geht raus');
  assert.deepEqual(schreibend(await speichere(SCHREIBEN, 'create')), ['POST /inventory/items'], 'Gegenfall: Anlegen geht raus');
});

// -------------------------------------------------------------------------
// Dokumente
// -------------------------------------------------------------------------

const ICH = 7;
const ANDERE = 8;
const dokument = (over = {}) => ({
  id: 9, name: 'Mietvertrag', original_name: 'mietvertrag.pdf', description: 'Unterschrieben am 3. Mai',
  category: 'home', mime_type: 'application/pdf', file_size: 591, storage_backend: 'local',
  visibility: 'restricted', allowed_member_ids: [ICH], status: 'active', folder_id: null, folder_name: null,
  created_by: ANDERE, updated_at: '2026-10-01', expires_at: '2030-01-01', expiry_reminder_days: 14,
  ...over,
});
const eigenes = (over = {}) => dokument({ id: 10, name: 'Zeugnis', created_by: ICH, ...over });

/** Den Zustand der Dokumentenseite setzen und danach zuruecknehmen. */
async function mitDokumenten(patch, fn) {
  const s = documents.state;
  const zuvor = { ...s, selected: new Set(s.selected) };
  const docs = patch.allDocuments ?? [dokument(), eigenes()];
  Object.assign(s, {
    currentUserId: ICH, isAdmin: false, allDocuments: docs, documents: docs, folders: [{ id: 3, name: 'Wohnung', parent_id: null }],
    members: [{ id: ICH, display_name: 'Mira' }, { id: ANDERE, display_name: 'Jonas' }], directory: [],
    dmsAccounts: [], status: 'active', query: '', queryText: '', category: '', folderId: '', expiringSoon: false,
    selectMode: false, selected: new Set(), view: 'list',
  }, patch);
  // Die Seite fehlt: jede Zeichnung findet keinen Traeger und kehrt um.
  documents.setContainerForTest({ querySelector: () => null, querySelectorAll: () => [], isConnected: false });
  try {
    return await fn();
  } finally {
    Object.assign(s, zuvor);
    documents.setContainerForTest(null);
  }
}

const hatKebab = (html) => /data-action="menu"/.test(html);

test('Dokumente: der Kebab folgt dem Dokument - `read` nie, `write` nur am eigenen, Admin immer', async () => {
  const zeichne = (modules, doc, opts) => withAccess(modules, () => mitDokumenten({}, () => ({
    zeile: documents.renderListItem(doc), karte: documents.renderGridCard(doc),
  })), opts);

  for (const doc of [dokument(), eigenes()]) {
    const lesen = await zeichne(LESEN, doc);
    for (const html of [lesen.zeile, lesen.karte]) {
      assert.equal(hatKebab(html), false, `read, ${doc.name}: das Menue traegt nur Handlungen`);
      assert.match(html, /data-action="view"/, 'Ansehen ist Lesen und bleibt');
      assert.match(html, new RegExp(`href="/api/v1/documents/${doc.id}/download"`), 'Herunterladen ebenso');
      assert.match(html, /data-read-bar/, 'die Leiste ist als kebablos gekennzeichnet (documents.css)');
    }
  }

  const fremd = await zeichne(SCHREIBEN, dokument());
  assert.equal(hatKebab(fremd.zeile), false, 'write, fremdes Dokument: der Server nimmt keine Aenderung an');
  assert.equal(hatKebab(fremd.karte), false);
  assert.match(fremd.zeile, /data-action="view"/);

  const mein = await zeichne(SCHREIBEN, eigenes());
  assert.equal(hatKebab(mein.zeile), true, 'Gegenfall: am eigenen Dokument steht der Kebab');
  assert.equal(hatKebab(mein.karte), true);
  assert.doesNotMatch(mein.zeile, /data-read-bar/);

  const admin = await zeichne(SCHREIBEN, dokument(), { admin: true });
  assert.equal(hatKebab(admin.zeile), true, 'ein Admin verwaltet jedes Dokument, wie am Server');
});

test('Dokumente: die kompakte Zeile behaelt ihr Auge, wenn kein Kebab da ist', () => {
  // Unter 30rem faellt das Auge weg, weil das Kebab-Menue „Ansehen" fuehrt.
  // Ohne Kebab waere die Zeile dann fuer die Tastatur zu.
  const css = readFileSync(new URL('../public/styles/documents.css', import.meta.url), 'utf8');
  const kompakt = [...eachRule(css)].filter((rule) => rule.at.some((a) => /@container list-rows \(max-width: 30rem\)/.test(a)));
  const versteckt = kompakt.filter((rule) => /\[data-action="view"\]/.test(rule.selector) && /display:\s*none/.test(rule.body));
  assert.equal(versteckt.length, 1, 'genau eine Regel blendet das Auge aus');
  assert.match(versteckt[0].selector, /\.document-row__actions:not\(\[data-read-bar\]\)/,
    'und sie nimmt die kebablose Leiste aus');
});

test('Dokumente bei `read`: keine Mehrfachauswahl, und der Leerzustand laedt zu nichts ein', async () => {
  const lesen = await withAccess(LESEN, () => mitDokumenten({}, () => {
    const menue = documents.documentsToolsMenuHtml();
    const leer = documents.emptyStateFor();
    documents.state.category = 'taxes';
    const gefiltert = documents.emptyStateFor();
    documents.enterSelectMode();
    return { menue, leer, gefiltert, selectMode: documents.state.selectMode };
  }));
  assert.doesNotMatch(lesen.menue, /enter-select|select-all|select-archive/, 'die Auswahl ist nur fuer Handlungen da');
  assert.match(lesen.menue, /data-sort="name"/, 'Sortieren ist Lesen und bleibt');
  assert.match(lesen.menue, /data-view-choice="grid"/, 'die Ansicht ebenso');
  assert.deepEqual(lesen.leer.actions, [], 'kein Hochladen, kein Ordner');
  assert.equal(lesen.leer.description, undefined, 'und kein Text, der dazu einlaedt (Regel 9)');
  assert.deepEqual(lesen.gefiltert.actions.map((a) => a.id), ['documents-empty-reset'], 'Filter zuruecksetzen ist Lesen');
  assert.equal(lesen.selectMode, false, 'und der Handler oeffnet die Auswahl nicht');

  const voll = await withAccess(SCHREIBEN, () => mitDokumenten({}, () => ({
    menue: documents.documentsToolsMenuHtml(), leer: documents.emptyStateFor(),
  })));
  assert.match(voll.menue, /data-action="enter-select"/, 'Gegenfall');
  assert.deepEqual(voll.leer.actions.map((a) => a.id), ['documents-empty-upload', 'documents-empty-folder']);
  assert.equal(voll.leer.description, 'documents.emptyDescription');
});

/** Jede Menue-Aktion eines Dokuments fahren und mitschreiben, was passiert. */
async function dokumentAktionen(doc) {
  let modale;
  let fenster;
  const gesendet = await aufrufe(async () => {
    fenster = await undoMitschnitt(async () => {
      modale = await modalMitschnitt(async () => {
        for (const action of ['edit', 'move', 'archive', 'push-dms', 'delete']) {
          await documents.runDocumentAction(action, doc);
        }
        documents.openDocumentModal(doc);
        documents.deleteDocuments([doc]);
      });
    });
  });
  return { modale, fenster, gesendet: schreibend(gesendet) };
}

test('Dokumente: ohne Verwaltungsrecht sendet keine Menue-Aktion etwas - `read` und fremdes Dokument', async () => {
  const lesen = await withAccess(LESEN, () => mitDokumenten({}, () => dokumentAktionen(eigenes())));
  assert.deepEqual(lesen, { modale: [], fenster: [], gesendet: [] }, 'read: auch am eigenen Dokument nichts');

  const fremd = await withAccess(SCHREIBEN, () => mitDokumenten({}, () => dokumentAktionen(dokument())));
  assert.deepEqual(fremd, { modale: [], fenster: [], gesendet: [] },
    'write, fremdes Dokument: kein Dialog, kein Rueckgaengig-Fenster, keine Anfrage');

  const mein = await withAccess(SCHREIBEN, () => mitDokumenten({}, () => dokumentAktionen(eigenes())));
  assert.deepEqual(mein.gesendet, ['PATCH /documents/10/archive'], 'Gegenfall: Archivieren geht raus');
  assert.equal(mein.modale.length, 2, 'Gegenfall: der Bearbeiten-Dialog geht auf (Menue und direkter Aufruf)');
  assert.equal(mein.fenster.length, 2, 'Gegenfall: Loeschen oeffnet sein Rueckgaengig-Fenster');

  for (const action of ['edit', 'move', 'archive', 'push-dms', 'delete']) {
    assert.equal(documents.READ_SAFE_ACTIONS.has(action), false, `${action} darf nicht in der Positivliste stehen`);
  }
  assert.deepEqual([...documents.READ_SAFE_ACTIONS], ['view'], 'die Positivliste nennt nur Lesen');
});

test('Dokumente: der Betrachter ist die Leseansicht - ohne Stift, mit allem, was der Dialog zeigt', async () => {
  const betrachte = (modules, doc) => withAccess(modules, () => mitDokumenten({}, async () => {
    const [opts] = await modalMitschnitt(() => documents.runDocumentAction('view', doc));
    return opts;
  }));

  for (const [fall, modules, doc] of [['read', LESEN, eigenes({ description: 'Unterschrieben am 3. Mai', visibility: 'restricted', allowed_member_ids: [ICH] })], ['write, fremd', SCHREIBEN, dokument()]]) {
    const opts = await betrachte(modules, doc);
    assert.ok(opts, `${fall}: der Betrachter geht auf`);
    assert.doesNotMatch(opts.content, /edit-document/, `${fall}: kein Bearbeiten-Stift`);
    assert.match(opts.content, new RegExp(`href="/api/v1/documents/${doc.id}/download"`), `${fall}: Herunterladen bleibt`);
    assert.match(opts.content, /class="document-viewer__body"/, `${fall}: die Vorschau bleibt`);
    assert.match(opts.content, /document-viewer__details/, `${fall}: die Lesezeilen stehen da`);
    assert.match(opts.content, /documents\.descriptionLabel[\s\S]*Unterschrieben am 3\. Mai/, `${fall}: Beschreibung`);
    assert.match(opts.content, /documents\.visibilityLabel[\s\S]*documents\.visibility\.restricted/, `${fall}: Sichtbarkeit`);
    assert.match(opts.content, /documents\.allowedMembersLabel[\s\S]*Mira/, `${fall}: fuer wen freigegeben`);
    assert.match(opts.content, /documents\.expiryReminderLabel[\s\S]*14/, `${fall}: Erinnerungs-Vorlauf`);
    assert.doesNotMatch(opts.content, /<input|<select|<textarea/, `${fall}: keine Eingabe`);
  }

  const archiviert = await betrachte(LESEN, dokument({ status: 'archived' }));
  assert.match(archiviert.content, /documents\.statusLabel[\s\S]*documents\.statusArchived/, 'der Archiv-Status stand nur im Dialog');

  const mein = await betrachte(SCHREIBEN, eigenes());
  assert.match(mein.content, /data-action="edit-document"/, 'Gegenfall: am eigenen Dokument steht der Stift');
  assert.doesNotMatch(mein.content, /document-viewer__details/, 'Gegenfall: wer bearbeiten darf, findet die Werte im Dialog');
});

test('Dokumente bei `read`: Hochladen und jede Ordner-Handlung bleiben zu', async () => {
  const ordner = { id: 3, name: 'Wohnung', parent_id: null };
  const fahre = () => mitDokumenten({}, async () => {
    let modale;
    const gesendet = await mitStub('__promptModal', async () => 'Haus', () => aufrufe(async () => {
      modale = await modalMitschnitt(async () => {
        documents.openDocumentModal();
        documents.openFolderModal();
        await documents.renameFolder(ordner);
        await documents.moveFolder(ordner);
        // Nicht abgewartet: mit Schreibrecht wartet das Loeschen auf die
        // Antwort seiner Rueckfrage. Die Folgen-Abfrage davor ist dann raus.
        documents.deleteFolder(ordner);
        await new Promise((resolve) => setImmediate(resolve));
      });
    }));
    return { modale: modale.length, gesendet };
  });

  const lesen = await withAccess(LESEN, fahre);
  assert.equal(lesen.modale, 0, 'weder der Hochladen- noch der Ordner-Dialog geht auf');
  assert.deepEqual(lesen.gesendet, [], 'Umbenennen sendet nichts, und Loeschen fragt nicht einmal die Folgen ab');

  const voll = await withAccess(SCHREIBEN, fahre);
  assert.equal(voll.modale >= 2, true, 'Gegenfall: beide Dialoge gehen auf');
  assert.ok(voll.gesendet.includes('PUT /documents/folders/3'), 'Gegenfall: Umbenennen geht raus');
  assert.ok(voll.gesendet.includes('GET /documents/folders/3/delete-impact'), 'Gegenfall: Loeschen fragt die Folgen ab');
});

test('Dokumente: die Mehrfachauswahl nimmt nur, was die Person verwalten darf', async () => {
  const ergebnis = await withAccess(SCHREIBEN, () => mitDokumenten({ selectMode: true }, async () => {
    const kreisFremd = documents.renderSelectBox(dokument());
    const kreisEigen = documents.renderSelectBox(eigenes());
    // Der Tipp auf die fremde Karte waehlt nichts aus.
    documents.toggleDocumentSelection({ dataset: { id: '9' }, querySelector: () => null, classList: { toggle() {} } });
    const nachTipp = [...documents.state.selected];
    // Und selbst ein eingeschmuggelter Eintrag kommt bei keiner Sammelaktion an.
    documents.state.selected = new Set([9, 10]);
    const gewaehlt = documents.selectedDocuments().map((doc) => doc.id);
    return { kreisFremd, kreisEigen, nachTipp, gewaehlt };
  }));
  assert.equal(ergebnis.kreisFremd, '', 'ein fremdes Dokument traegt keinen Auswahlkreis');
  assert.match(ergebnis.kreisEigen, /data-select-id="10"/, 'Gegenfall: das eigene schon');
  assert.deepEqual(ergebnis.nachTipp, [], 'die fremde Karte laesst sich nicht auswaehlen');
  assert.deepEqual(ergebnis.gewaehlt, [10], 'Verschieben, Archivieren und Loeschen bekommen nur das eigene');
});

// -------------------------------------------------------------------------
// Dokumente: die Seite als Ganzes (`render()`), Ordner, Sammelauswahl, Speichern
// -------------------------------------------------------------------------

const ORDNER = [
  { id: 3, name: 'Wohnung', parent_id: null },
  { id: 5, name: 'Archiv', parent_id: null },
  { id: 6, name: 'Keller', parent_id: 3 },
];

/**
 * Die Dokumentenseite wirklich zeichnen: `render()` mit seinem Kontext, die
 * Daten aus den Antworten des Servers. `currentUserId` steht vorher auf null -
 * wer die Person ist, darf allein aus `context.user` kommen.
 */
async function mitSeite({ user, docs = [dokument(), eigenes()] } = {}, fn) {
  return mitDokumenten({ currentUserId: null, allDocuments: [], documents: [] }, async () => {
    const s = seite();
    const ende = new AbortController();
    try {
      await aufrufe(() => renderDocuments(s, { user, signal: ende.signal }), {
        'GET /documents?status=active': { data: docs },
        'GET /documents/folders': { data: ORDNER },
        'GET /family/members': { data: [{ id: ICH, display_name: 'Mira' }, { id: ANDERE, display_name: 'Jonas' }] },
        'GET /documents/meta/options': { data: { is_admin: false } },
      });
      return await fn(s);
    } finally {
      ende.abort();
    }
  });
}

/** Der Abschnitt eines Dokuments in der gezeichneten Liste. */
function artikel(html, id) {
  return html.split('<article').find((teil) => new RegExp(`data-id="${id}"`).test(teil.split('>')[0])) ?? null;
}

test('Dokumente: `render()` nimmt die Person aus dem Kontext - das eigene Dokument traegt Kebab, Stift und Auswahl, das fremde nicht', async () => {
  const stift = async (doc) => {
    const [opts] = await modalMitschnitt(() => documents.runDocumentAction('view', doc));
    return /data-action="edit-document"/.test(opts.content);
  };
  const zeichne = (user) => withAccess(SCHREIBEN, () => mitSeite({ user }, async (s) => {
    const liste = s.liste();
    const stifte = { 9: await stift(dokument()), 10: await stift(eigenes()) };
    documents.enterSelectMode();
    return { liste, stifte, auswahl: s.liste(), person: documents.state.currentUserId };
  }));

  const ich = await zeichne({ id: ICH });
  assert.equal(ich.person, ICH);
  assert.ok(artikel(ich.liste, 9) && artikel(ich.liste, 10), 'beide Dokumente stehen in der Liste');
  assert.equal(hatKebab(artikel(ich.liste, 10)), true, 'das eigene Dokument traegt den Kebab');
  assert.doesNotMatch(artikel(ich.liste, 10), /data-read-bar/);
  assert.equal(hatKebab(artikel(ich.liste, 9)), false, 'das fremde nicht');
  assert.match(artikel(ich.liste, 9), /data-read-bar/);
  assert.match(artikel(ich.liste, 9), /data-action="view"/, 'Ansehen bleibt auch am fremden');
  assert.deepEqual(ich.stifte, { 9: false, 10: true }, 'der Stift im Betrachter folgt derselben Regel');
  assert.match(artikel(ich.auswahl, 10), /data-select-id="10"/, 'in der Auswahl traegt das eigene den Kreis');
  assert.doesNotMatch(artikel(ich.auswahl, 9), /data-select-id/, 'das fremde nicht');

  // Gegenfall: dieselben zwei Dokumente, die andere Person - alles kehrt sich um.
  // Bliebe ein Rest von vorher stehen, statt dass der Kontext gilt, fiele es hier auf.
  const andere = await zeichne({ id: ANDERE });
  assert.equal(hatKebab(artikel(andere.liste, 9)), true, 'Gegenfall: der anderen Person gehoert das andere Dokument');
  assert.equal(hatKebab(artikel(andere.liste, 10)), false);
  assert.deepEqual(andere.stifte, { 9: true, 10: false });
  assert.match(artikel(andere.auswahl, 9), /data-select-id="9"/);
  assert.doesNotMatch(artikel(andere.auswahl, 10), /data-select-id/);

  const niemand = await zeichne(undefined);
  assert.equal(niemand.person, null, 'ohne Person im Kontext gehoert einem nichts');
  assert.equal(hatKebab(artikel(niemand.liste, 9)) || hatKebab(artikel(niemand.liste, 10)), false);
});

test('Dokumente bei `read`: die Ordnerleiste traegt weder „+" noch Kebab, und das Ordner-Menue geht nicht auf', async () => {
  const anker = () => {
    const attribute = {};
    return {
      attribute, isConnected: false, focus() {},
      setAttribute(name, wert) { attribute[name] = wert; },
      getBoundingClientRect: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
    };
  };
  const zeichne = (modules) => withAccess(modules, () => mitSeite({ user: { id: ICH } }, async (s) => {
    const knopf = anker();
    const gebaut = await mitElementen(() => documents.openFolderMenu(ORDNER[0], knopf));
    const menues = gebaut.filter((el) => el.getAttribute('popover') !== null);
    return { kopf: s.html, ordner: s.ordner(), menues: menues.map((el) => el.innerHTML), knopf: knopf.attribute };
  }));

  const lesen = await zeichne(LESEN);
  assert.match(lesen.ordner, /data-folder-select="3"[\s\S]*Wohnung/, 'die Ordner selbst bleiben - und waehlbar');
  assert.doesNotMatch(lesen.kopf, /id="documents-folder-add"/, 'kein „+": Ordner anlegen ist Schreiben');
  assert.doesNotMatch(lesen.ordner, /data-folder-menu/, 'kein Kebab an einer Ordnerzeile');
  assert.deepEqual(lesen.menues, [], 'und der Handler oeffnet das Menue nicht');
  assert.deepEqual(lesen.knopf, {}, 'der Ausloeser meldet auch kein offenes Menue');

  const voll = await zeichne(SCHREIBEN);
  assert.match(voll.kopf, /id="documents-folder-add"/, 'Gegenfall: das „+" steht da');
  assert.deepEqual([...voll.ordner.matchAll(/data-folder-menu="(\d+)"/g)].map((m) => m[1]), ['3', '5'],
    'Gegenfall: jede sichtbare Ordnerzeile traegt ihren Kebab (Keller liegt zugeklappt unter Wohnung)');
  assert.equal(voll.menues.length, 1, 'Gegenfall: das Menue geht auf');
  assert.deepEqual([...voll.menues[0].matchAll(/data-menu-action="([a-z]+)"/g)].map((m) => m[1]),
    ['subfolder', 'rename', 'move', 'delete'], 'mit seinen vier Schreib-Eintraegen');
  assert.equal(voll.knopf['aria-expanded'], 'true');
});

test('Dokumente bei `read`: ein Ordner zieht nicht um - mit Schreibrecht geht genau der Umzug raus', async () => {
  // Der Stub der Ladehilfe bricht die Auswahl ab; dann sendet moveFolder() auch
  // mit Schreibrecht nichts, und ein Test ohne Antwort misst den Riegel nicht.
  const ziehe = (modules, antwort) => withAccess(modules, () => mitDokumenten({ folders: ORDNER }, async () => {
    const fragen = [];
    const inhalte = [];
    const offen = new Set(documents.state.expanded);
    try {
      await mitStub('__selectModal', async (titel, optionen) => { fragen.push(optionen.map((o) => o.value)); return antwort; },
        () => aufrufe(() => documents.moveFolder(ORDNER[0]), {}, inhalte));
    } finally {
      for (const id of documents.state.expanded) if (!offen.has(id)) documents.state.expanded.delete(id);
    }
    return { fragen, inhalte };
  }));

  assert.deepEqual(await ziehe(LESEN, '5'), { fragen: [], inhalte: [] }, 'read: keine Auswahl, keine Anfrage');

  const voll = await ziehe(SCHREIBEN, '5');
  assert.deepEqual(voll.fragen, [['', '5']], 'Gegenfall: die Auswahl fragt - ohne den Ordner selbst und seinen Teilbaum');
  assert.deepEqual(voll.inhalte, [['PUT /documents/folders/3', { parent_id: 5 }]], 'Gegenfall: genau der Umzug geht raus');

  const wurzel = await ziehe(SCHREIBEN, '');
  assert.deepEqual(wurzel.inhalte, [['PUT /documents/folders/3', { parent_id: null }]], 'die oberste Ebene ist `null`, kein Abbruch');

  assert.deepEqual((await ziehe(SCHREIBEN, null)).inhalte, [], 'eine abgebrochene Auswahl sendet nichts');
});

test('Dokumente: „Alle auswaehlen" nimmt nur Verwaltbares, und die Pille nennt diese Zahl', async () => {
  const drei = [dokument(), eigenes(), eigenes({ id: 11, name: 'Impfpass' })];
  const waehle = (opts) => withAccess(SCHREIBEN, () => mitDokumenten({ selectMode: true, allDocuments: drei }, async () => {
    const s = seite('<div id="documents-list"></div>');
    const pille = new MiniElement('div');
    const finde = globalThis.document.getElementById;
    documents.setContainerForTest(s);
    globalThis.document.getElementById = (id) => (id === 'bulk-pill-layer' ? pille : null);
    try {
      let alle;
      await mitElementen(() => {
        documents.toggleSelectAll();
        alle = { gewaehlt: [...documents.state.selected].sort((a, b) => a - b), pille: pille.textContent, liste: s.liste() };
        documents.toggleSelectAll();
      });
      return { ...alle, danach: [...documents.state.selected], pilleDanach: pille.textContent };
    } finally {
      globalThis.document.getElementById = finde;
    }
  }), opts);

  const mitglied = await waehle();
  assert.deepEqual(mitglied.gewaehlt, [10, 11], 'das fremde Dokument bleibt aussen vor');
  assert.match(mitglied.pille, /documents\.selectCount\{"count":2\}/, 'und die Pille zaehlt, was die Sammelaktion wirklich bekommt');
  assert.match(artikel(mitglied.liste, 10), /data-select-id="10" aria-pressed="true"/);
  assert.match(artikel(mitglied.liste, 11), /data-select-id="11" aria-pressed="true"/);
  assert.doesNotMatch(artikel(mitglied.liste, 9), /data-select-id/);
  assert.deepEqual(mitglied.danach, [], 'der zweite Griff nimmt die Auswahl zurueck');
  assert.match(mitglied.pilleDanach, /documents\.selectCount\{"count":0\}/);

  const admin = await waehle({ admin: true });
  assert.deepEqual(admin.gewaehlt, [9, 10, 11], 'Gegenfall: ein Admin verwaltet alle drei');
  assert.match(admin.pille, /documents\.selectCount\{"count":3\}/);
});

test('Dokumente: „Mehrere auswaehlen" ist verborgen, wenn der Person nichts gehoert', async () => {
  const EINSTIEG = '[data-action="enter-select"]';
  const TRENNER = '[data-select-separator]';
  const zeichne = (docs, opts) => withAccess(SCHREIBEN, () => mitSeite({ user: { id: ICH }, docs }, (s) => {
    const vorher = { einstieg: s.eintrag(EINSTIEG)?.hidden, trenner: s.eintrag(TRENNER)?.hidden };
    documents.enterSelectMode();
    return { ...vorher, inAuswahl: s.eintrag(EINSTIEG)?.hidden };
  }), opts);

  const nurFremde = await zeichne([dokument(), dokument({ id: 12, name: 'Police' })]);
  assert.deepEqual({ einstieg: nurFremde.einstieg, trenner: nurFremde.trenner }, { einstieg: true, trenner: true },
    'nichts Eigenes: kein Einstieg in die Auswahl, und kein Trennstrich ueber einer leeren Gruppe');

  const einEigenes = await zeichne([dokument(), eigenes()]);
  assert.deepEqual({ einstieg: einEigenes.einstieg, trenner: einEigenes.trenner }, { einstieg: false, trenner: false },
    'Gegenfall: ein eigenes Dokument genuegt');
  assert.equal(einEigenes.inAuswahl, false, 'waehrend der Auswahl bleibt der Eintrag stehen (er ist dann gesperrt)');

  const admin = await zeichne([dokument()], { admin: true });
  assert.equal(admin.einstieg, false, 'Gegenfall: einem Admin gehoert die Verwaltung aller');
});

test('Dokumente: der direkte Aufruf des Speicherns sendet nichts ohne Verwaltungsrecht', async () => {
  // openDocumentModal() haelt den Dialog zu - aber ein Dialog, der schon offen
  // stand, als das Recht fiel, schickt sein Formular trotzdem an saveDocument().
  const speichere = (modules, doc, werte = {}) => withAccess(modules, () => mitDokumenten({}, async () => {
    const formular = felder({
      '#document-name': 'Neuer Name', '#document-category': 'home', '#document-visibility': 'family',
      '#document-status': 'active', ...werte,
    });
    const inhalte = [];
    let verhindert = 0;
    const ereignis = { target: formular, preventDefault() { verhindert += 1; } };
    await aufrufe(() => documents.saveDocument(ereignis, doc, felder()), {}, inhalte);
    return { gesendet: inhalte.map(([was, rumpf]) => [was, rumpf.name]), verhindert, fehler: formular.querySelector('#document-error').textContent };
  }));
  // Das Hochladen liest die Datei ueber FileReader; den gibt es in Node nicht.
  class Leser {
    readAsDataURL() { this.result = 'data:application/pdf;base64,AA=='; queueMicrotask(() => this.onload()); }
  }
  const datei = { '#document-file': [{ name: 'scan.pdf', size: 10 }] };
  const ladeHoch = (modules) => mitStub('FileReader', Leser, () => speichere(modules, null, datei));

  const lesen = await speichere(LESEN, eigenes());
  assert.deepEqual(lesen.gesendet, [], 'read: auch am eigenen Dokument wird nichts gespeichert');
  assert.equal(lesen.verhindert, 1, 'und das Formular laedt die Seite nicht neu');
  assert.deepEqual((await speichere(SCHREIBEN, dokument())).gesendet, [], 'write, fremdes Dokument: nichts');
  assert.deepEqual((await ladeHoch(LESEN)).gesendet, [], 'read: Hochladen sendet nichts');

  assert.deepEqual((await speichere(SCHREIBEN, eigenes())).gesendet, [['PUT /documents/10', 'Neuer Name']],
    'Gegenfall: am eigenen Dokument geht die Aenderung raus');
  const hoch = await ladeHoch(SCHREIBEN);
  assert.equal(hoch.fehler, '', 'Gegenfall: das Hochladen laeuft ohne Fehler durch');
  assert.deepEqual(hoch.gesendet, [['POST /documents', 'Neuer Name']], 'Gegenfall: Hochladen geht raus');
});
