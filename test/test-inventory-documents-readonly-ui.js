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

const { installMiniDom } = await import('./mini-dom.js');
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
const { __test: documents } = await import('../public/pages/documents.js');

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
