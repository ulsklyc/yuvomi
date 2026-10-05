/**
 * Modul: Gemerkte Aufgaben-Filter und ihre Veraltung
 * Zweck: Ein gespeichertes Filter-Set nennt Werte, die spaeter verschwinden
 *        koennen - eine geloeschte Kategorie, ein umbenannter oder
 *        zusammengefuehrter Tag, ein entferntes Haushaltsmitglied. Der Chip bot
 *        sie weiter an, und ein Klick schrieb den toten Wert zurueck in die
 *        Abfrage: dauerhaft leere Liste, und ein Neuladen half nicht, weil der
 *        Wert im localStorage steht.
 *
 *        Bereinigt wird LESEND (D#984): eine Stelle statt eines Nachlaufs an
 *        jedem Aenderungspfad, und richtig auch dann, wenn die Aenderung in
 *        einem anderen Tab passiert ist. Der Speicher bleibt unangetastet -
 *        das prueft dieser Test ausdruecklich mit, denn ein Lesefilter, der
 *        sich ueber `saveRecentFilter` festschreibt, waere genau der Weg, den
 *        die Entscheidung ausgeschlossen hat.
 *
 *        Deckt ab:
 *          - alle DREI veraltbaren Achsen, nicht nur Kategorien
 *          - ein Set ohne Rest verschwindet ganz
 *          - der Speicher wird nicht umgeschrieben
 *          - nach einem Ladefehler wird NICHT gefiltert
 *          - Kopfregel mobil: „Filter (n)" zaehlt, das Blatt bietet an, was
 *            vorher in der Chipzeile stand, und zieht sich nach, ohne seine
 *            Knoten zu tauschen (die Lehre aus #1373); das Werkzeugmenue
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-task-filters.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };

// In-Memory-`localStorage`: tasks.js greift direkt aufs globale Objekt zu.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
};

const { __test: tasks } = await import('../public/pages/tasks.js');

const KEY = 'yuvomi:recentTaskFilters';
const emptySet = { status: [], priority: [], assigned_to: [], category: [], tags: [] };

/** Setzt den Bestand, gegen den die gemerkten Sets geprueft werden. */
function withKnown({ categories = [], tags = [], users = [], loadError = null, fromCache = false } = {}) {
  store.clear();
  tasks.state.categories = categories.map((key) => ({ key, name: key, sort_order: 0 }));
  tasks.state.allTags = tags.map((tag) => ({ tag, count: 1 }));
  tasks.state.users = users.map((id) => ({ id, display_name: `U${id}` }));
  tasks.state.loadError = loadError;
  tasks.state.metaStale = { users: fromCache, categories: fromCache, tags: fromCache };
}

const put = (...sets) => store.set(KEY, JSON.stringify(sets.map((s) => ({ ...emptySet, ...s }))));
const raw = () => JSON.parse(store.get(KEY));

test('eine geloeschte Kategorie wird nicht mehr angeboten, der Rest des Sets bleibt', () => {
  withKnown({ categories: ['haushalt'] });
  put({ status: ['open'], category: ['garten', 'haushalt'] });

  const [set] = tasks.getRecentFilters();
  assert.deepEqual(set.category, ['haushalt'], 'der tote Key faellt weg');
  assert.deepEqual(set.status, ['open'], 'was noch gilt, bleibt stehen');
});

test('dieselbe Veraltung trifft Tags und Zustaendige, nicht nur Kategorien', () => {
  // Der halbe Sweep waere hier die Falle: die Kategorie ist behandelt, Tag und
  // Person nicht - und beide kommen aus derselben Verwaltung.
  withKnown({ categories: ['haushalt'], tags: ['Garten'], users: [3] });
  put({ category: ['haushalt'], tags: ['garten', 'urlaub'], assigned_to: ['3', '9'] });

  const [set] = tasks.getRecentFilters();
  assert.deepEqual(set.tags, ['garten'], 'der Tag-Vergleich ignoriert die Schreibweise');
  assert.deepEqual(set.assigned_to, ['3'], 'das entfernte Mitglied faellt weg');
});

test('ein Set, von dem nichts uebrig bleibt, verschwindet ganz', () => {
  withKnown({ categories: ['haushalt'] });
  put({ category: ['garten'] }, { status: ['open'] });

  const sets = tasks.getRecentFilters();
  assert.equal(sets.length, 1, 'ein leeres Set waere eine Pille, die alles zuruecksetzt');
  assert.deepEqual(sets[0].status, ['open']);
});

test('Status und Prioritaet veralten nicht - sie sind Konstanten dieser Datei', () => {
  withKnown({});
  put({ status: ['open', 'done'], priority: ['high'] });

  const [set] = tasks.getRecentFilters();
  assert.deepEqual(set.status, ['open', 'done']);
  assert.deepEqual(set.priority, ['high']);
});

test('der Speicher wird nicht umgeschrieben - auch nicht beim naechsten Sichern', () => {
  withKnown({ categories: ['haushalt'] });
  put({ category: ['garten'] });

  // Lesen allein aendert nichts.
  tasks.getRecentFilters();
  assert.deepEqual(raw()[0].category, ['garten'], 'Lesen darf nicht schreiben');

  // Und ein neues Set schreibt die UNGEFILTERTE Liste fort. Liefe `save` ueber
  // den Lesefilter, waere der tote Key hier weg - Bereinigen beim Schreiben
  // durch die Hintertuer, und eine wieder angelegte Kategorie kaeme nie zurueck.
  tasks.saveRecentFilter({ ...emptySet, status: ['done'] });
  const keys = raw().flatMap((f) => f.category);
  assert.ok(keys.includes('garten'), 'der gemerkte Wert ueberlebt das Sichern');

  // Wird die Kategorie wieder angelegt, ist ihr Chip zurueck.
  tasks.state.categories.push({ key: 'garten', name: 'Garten', sort_order: 1 });
  assert.ok(tasks.getRecentFilters().some((f) => f.category.includes('garten')));
});

test('nach einem Ladefehler wird NICHT gefiltert', () => {
  // Im catch-Zweig von render() stehen users/categories/allTags auf []. Wuerde
  // „leer" als „gibt es nicht" gelesen, naehme ein Serverfehler dem Nutzer
  // saemtliche gemerkten Filter weg - und das dauerhaft aussehend.
  withKnown({ loadError: new Error('500') });
  put({ category: ['garten'], tags: ['urlaub'], assigned_to: ['9'] });

  const [set] = tasks.getRecentFilters();
  assert.deepEqual(set.category, ['garten']);
  assert.deepEqual(set.tags, ['urlaub']);
  assert.deepEqual(set.assigned_to, ['9']);
});

test('zwei Sets, die nach dem Beschneiden gleich aussehen, geben EIN Chip', () => {
  // Codex-Befund P2 zu PR #1072: `{Offen + Garten}` und `{Offen}` fallen
  // zusammen, sobald „Garten" geloescht ist. Zwei sicht- und verhaltensgleiche
  // Pillen nebeneinander sind keine Auswahl, sondern ein Fehler - und
  // `saveRecentFilter` kann die doppelte nicht verdraengen, weil es die
  // UNGEFILTERTEN Schluessel vergleicht und die sich noch unterscheiden.
  withKnown({ categories: ['haushalt'] });
  put({ status: ['open'], category: ['garten'] }, { status: ['open'] });

  const sets = tasks.getRecentFilters();
  assert.equal(sets.length, 1, 'die Dublette gehoert weg');
  assert.deepEqual(sets[0].status, ['open']);

  // Der Speicher bleibt trotzdem unangetastet: kommt „Garten" zurueck, sind es
  // wieder zwei verschiedene Sets.
  assert.equal(raw().length, 2, 'entdoppelt wird die ANSICHT, nicht der Speicher');
  tasks.state.categories.push({ key: 'garten', name: 'Garten', sort_order: 1 });
  assert.equal(tasks.getRecentFilters().length, 2);
});

test('gegen Referenzlisten aus dem Offline-Cache wird NICHT gefiltert', () => {
  // `/tasks` steht in `API_CACHE_WHITELIST` (sw.js), also auch
  // `/tasks/meta/options`. Offline antwortet `networkFirstApi` mit dem Cache
  // und Status 200 - `state.loadError` bleibt null, die Listen sehen echt aus
  // und sind beliebig alt (Codex-Befund P2 zu PR #1072).
  //
  // Beide Richtungen sind falsch: eine nach dem Cache-Zeitpunkt angelegte
  // Kategorie fehlt dort und versteckte ein gueltiges Chip, eine danach
  // geloeschte stuende noch drin und boete ein totes an. Offline gilt deshalb
  // dasselbe wie beim Ladefehler.
  withKnown({ categories: ['haushalt'], fromCache: true });
  put({ category: ['garten'], tags: ['urlaub'], assigned_to: ['9'] });

  const [set] = tasks.getRecentFilters();
  assert.deepEqual(set.category, ['garten'], 'der Cache darf kein Chip wegnehmen');
  assert.deepEqual(set.tags, ['urlaub']);
  assert.deepEqual(set.assigned_to, ['9']);

  // Sobald die Listen netzfrisch sind, greift die Bereinigung wieder.
  tasks.state.metaStale = { users: false, categories: false, tags: false };
  assert.equal(tasks.getRecentFilters().length, 0, 'netzfrisch wird wieder beschnitten');
});

test('refreshTags haelt fest, ob die neue Tag-Liste nachweislich frisch ist', async () => {
  // `/tasks/tags` faellt unter das `/tasks`-Praefix der Whitelist, kann also aus
  // dem Cache kommen; und schlaegt der Aufruf fehl, bleibt die ALTE Liste
  // stehen. Beide Male ist sie nicht mehr autoritativ, und `getRecentFilters`
  // darf nicht dagegen beschneiden (Codex-Befund P2 zu PR #1072, siebte Runde).
  withKnown({ tags: ['garten'] });

  globalThis.__apiStub = { getWithSource: async () => ({ data: { data: [{ tag: 'garten', count: 1 }] }, fromCache: false }) };
  await tasks.refreshTags();
  assert.equal(tasks.state.metaStale.tags, false, 'netzfrisch');

  globalThis.__apiStub = { getWithSource: async () => ({ data: { data: [] }, fromCache: true }) };
  await tasks.refreshTags();
  assert.equal(tasks.state.metaStale.tags, true, 'aus dem Cache');

  globalThis.__apiStub = { getWithSource: async () => { throw new Error('offline'); } };
  tasks.state.metaStale = { users: false, categories: false, tags: false };
  const vorher = tasks.state.allTags;
  await tasks.refreshTags();
  assert.equal(tasks.state.metaStale.tags, true, 'ein Fehlschlag laesst die alte Liste stehen');
  assert.equal(tasks.state.allTags, vorher, 'und die alte Liste bleibt wirklich stehen');

  // UND NUR DIE TAGS. Ueber Kategorien und Mitglieder sagt dieser Rundlauf
  // nichts - als EIN gemeinsames Flag erklaerte er sie faelschlich fuer frisch,
  // und das Beschneiden warf ein Chip weg, das es noch gibt.
  tasks.state.metaStale = { users: true, categories: true, tags: true };
  globalThis.__apiStub = { getWithSource: async () => ({ data: { data: [] }, fromCache: false }) };
  await tasks.refreshTags();
  assert.deepEqual(tasks.state.metaStale, { users: true, categories: true, tags: false },
    'eine frische Tag-Auffrischung sagt nichts ueber die anderen beiden Listen');

  delete globalThis.__apiStub;
});

test('eine stale Achse beschneidet nicht, die frischen schon', () => {
  // Der Kern der Aufteilung: gecachte Kategorien duerfen kein Kategorie-Chip
  // wegnehmen, waehrend frische Tags ihres sehr wohl beschneiden.
  withKnown({ categories: ['haushalt'], tags: ['garten'], users: [3] });
  tasks.state.metaStale = { users: false, categories: true, tags: false };
  put({ category: ['weg'], tags: ['weg'], assigned_to: ['9'] });

  const [set] = tasks.getRecentFilters();
  assert.deepEqual(set.category, ['weg'], 'die stale Kategorienliste faellt kein Urteil');
  assert.deepEqual(set.tags, [], 'die frische Tag-Liste beschneidet');
  assert.deepEqual(set.assigned_to, [], 'die frische Mitgliederliste ebenso');
});

test('ein Tag mit Komma kollidiert nicht mit zwei Tags', () => {
  // Codex-Befund P2 zu PR #1072, am Code nachgemessen: `normalizeTags`
  // splittet nur eine STRING-Eingabe an Kommas, ein Array-Element behaelt
  // seines (`normalizeTags(['a,b'])` -> `['a,b']`), und die Route nimmt
  // Arrays. Der Schluessel verband die Achse aber mit `,` - der eine Tag
  // `a,b` und die zwei Tags `a` und `b` ergaben denselben.
  //
  // Zwei Schaeden aus einer Ursache, und beide werden hier gemessen: die
  // Ansicht verbarg den einen Chip als Dublette, und `saveRecentFilter`
  // verdraengte beim Speichern den jeweils anderen.
  withKnown({ tags: ['a,b', 'a', 'b'] });
  put({ tags: ['a,b'] }, { tags: ['a', 'b'] });

  assert.equal(tasks.getRecentFilters().length, 2,
    'zwei verschiedene Filter, zwei Chips');

  // Und die Speicherseite: das eine Set darf das andere nicht verdraengen.
  store.clear();
  tasks.saveRecentFilter({ ...emptySet, tags: ['a,b'] });
  tasks.saveRecentFilter({ ...emptySet, tags: ['a', 'b'] });
  assert.equal(raw().length, 2, 'beide Sets stehen im Speicher');
});

test('derselbe Filter verdraengt sich weiterhin selbst', () => {
  // Die Gegenrichtung, ohne die der Fix nur "alles ist verschieden" hiesse:
  // dieselben Werte in anderer Reihenfolge und Schreibweise bleiben EIN Set.
  withKnown({ tags: ['garten', 'urlaub'] });
  store.clear();
  tasks.saveRecentFilter({ ...emptySet, tags: ['garten', 'urlaub'] });
  tasks.saveRecentFilter({ ...emptySet, tags: ['Urlaub', 'Garten'] });

  assert.equal(raw().length, 1, 'Reihenfolge und Schreibweise machen kein neues Set');
  assert.equal(tasks.getRecentFilters().length, 1);
});

// ---------------------------------------------------------------------------
// Kopfregel mobil (2026-09-26): „Filter (n)" im Kopf, die Filter im Blatt.
//
// Unter dem Kopf stand eine Chipzeile (aktive Filter, „Mir zugewiesen",
// „Geplante", Gruppierung) und darunter ein Inline-Panel. Mobil kostete das
// 54px unter einem 176px-Kopf, die erste Aufgabe stand bei y=287 (A3 P1-2);
// am Desktop lief das Panel 1156px ueber einer 720px-Liste (A3 P2-8). Jetzt
// traegt der Kopf EINEN Knopf mit der ZAHL der wirkenden Filter, und alles
// andere steht beschriftet im Filterblatt (utils/filter-sheet.js).
//
// Gemessen wird, WAS Knopf und Blatt anbieten und dass ein Filterwechsel ein
// offenes Blatt nachzieht, ohne seine Knoten zu tauschen - der Fokus bleibt
// auf dem getippten Chip. Das ist die Lehre aus #1373: dort fiel er nach jedem
// Rendern aufs Dokument, und Escape erreichte das Panel nicht mehr.
// ---------------------------------------------------------------------------

const { setPermissions, clearPermissions } = await import('../public/permissions.js');

/** Ausgangslage: Liste, zwei Personen, Standardfilter „Offen". */
function baseState(overrides = {}) {
  withKnown({ users: [1, 2], categories: ['haushalt'], tags: ['garten'] });
  Object.assign(tasks.state, {
    viewMode: 'list',
    currentUserId: 1,
    showFuture: false,
    groupMode: 'category',
    bulkSelectMode: false,
    filterSheet: null,
    filters: { status: ['open'], priority: [], assigned_to: [], category: [], tags: [] },
    ...overrides,
  });
}

test('Filter (n): die Zahl nennt nur ABWEICHUNGEN vom Standard (R16)', () => {
  // „Filter 1" brannte im Ruhezustand: der Startwert „Offen" zaehlte mit, der
  // Knopf trug also immer eine Zahl und die Aktiv-Farbe - und sagte damit
  // nichts mehr (Critique 2026-10-05, R16).
  baseState();
  assert.equal(tasks.activeFilterCount(), 0, 'der Standard ist kein Filter');
  tasks.state.filters.priority = ['high', 'urgent'];
  tasks.state.filters.tags = ['garten'];
  assert.equal(tasks.activeFilterCount(), 3, 'jeder Wert jeder Achse zaehlt (#671)');
  tasks.state.showFuture = true;
  assert.equal(tasks.activeFilterCount(), 4,
    '„Geplante anzeigen" hatte einen eigenen Chip - ohne ihn traegt allein die Zahl, dass er an ist');
  tasks.state.viewMode = 'kanban';
  assert.equal(tasks.activeFilterCount(), 4,
    'im Brett wirkt der Status nicht (die Spalten SIND er) - mitgezaehlt behauptete die Zahl einen unsichtbaren Filter');
});

test('Filter (n): ein Status abseits von „Offen" ist eine Abweichung - auch der leere (R16)', () => {
  baseState();
  tasks.state.filters.status = [];
  assert.equal(tasks.activeFilterCount(), 1, '„alle Status" zeigt mehr als der Standard und ist damit ein Filterzustand');
  tasks.state.filters.status = ['done'];
  assert.equal(tasks.activeFilterCount(), 1);
  tasks.state.filters.status = ['open', 'in_progress'];
  assert.equal(tasks.activeFilterCount(), 2, 'jeder gewaehlte Wert zaehlt');
  // „Bis heute faellig" weitet den Status selbst: das ist EIN Filter, nicht drei.
  baseState();
  tasks.setDueToday(true);
  assert.deepEqual(tasks.state.filters.status, ['open', 'in_progress']);
  assert.equal(tasks.activeFilterCount(), 1);
  tasks.setDueToday(false);
  assert.equal(tasks.activeFilterCount(), 0);
});

test('das Blatt: Filter zuerst, Kategorie und Tag eingeklappt, „Ansicht" abgesetzt am Ende (R16)', () => {
  baseState();
  const groups = () => tasks.filterSheetGroups();
  const headingsOf = () => groups().map((g) => g.heading);
  const groupOf = (heading) => groups().find((g) => g.heading === heading) ?? {};
  const htmlOf = (heading) => groupOf(heading).html ?? '';

  assert.deepEqual(headingsOf(), [
    'tasks.filterGroupShow', 'tasks.filterGroupStatus', 'tasks.filterGroupPriority',
    'tasks.filterGroupPerson', 'tasks.categoryLabel', 'tasks.filterGroupTag', 'tasks.viewToggleLabel',
  ]);
  const show = htmlOf('tasks.filterGroupShow');
  assert.match(show, /type="checkbox"[^>]*data-filter-mine/, '„Mir zugewiesen" ist ein Schalter im Blatt');
  assert.doesNotMatch(show, /data-filter-future/, '„Geplante anzeigen" ist eine Ansichtsoption, kein Filter der ersten Gruppe');

  // „Ansicht": Gruppierung und „Geplante anzeigen", abgesetzt.
  const view = groupOf('tasks.viewToggleLabel');
  assert.equal(view.variant, 'view');
  assert.match(view.html, /role="radiogroup"/, 'die Gruppierung ist EINE Wahl aus zwei, kein Paar von Schaltern');
  assert.match(view.html, /data-tab-id="category"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-tab-id="category"/);
  assert.match(view.html, /type="checkbox"[^>]*data-filter-future/);
  assert.match(htmlOf('tasks.filterGroupStatus'), /data-filter="status" data-value="open" aria-pressed="true"/,
    'der gewaehlte Status traegt seinen Zustand als aria-pressed');

  // Kategorie und Tag: eingeklappt, solange nichts gewaehlt ist - offen, sobald etwas wirkt.
  assert.deepEqual([groupOf('tasks.categoryLabel').fold, groupOf('tasks.filterGroupTag').fold], ['closed', 'closed']);
  assert.equal(groupOf('tasks.filterGroupStatus').fold, undefined, 'die haeufigen Achsen bleiben offen');
  tasks.state.filters.category = ['haushalt'];
  tasks.state.filters.tags = ['garten'];
  assert.deepEqual([groupOf('tasks.categoryLabel').fold, groupOf('tasks.filterGroupTag').fold], ['open', 'open'],
    'eine gesetzte Wahl ist nie hinter einem Aufklapper versteckt');

  // Das Brett: kein Status (die Spalten sind er), keine Gruppierung - „Geplante" bleibt.
  baseState();
  tasks.state.viewMode = 'kanban';
  assert.ok(!headingsOf().includes('tasks.filterGroupStatus'));
  assert.doesNotMatch(htmlOf('tasks.viewToggleLabel'), /radiogroup/);
  assert.match(htmlOf('tasks.viewToggleLabel'), /data-filter-future/);

  // Allein im Haushalt: keine Personenachse und kein „Mir zugewiesen".
  baseState();
  tasks.state.users = [{ id: 1, display_name: 'U1' }];
  assert.ok(!headingsOf().includes('tasks.filterGroupPerson'));
  assert.doesNotMatch(htmlOf('tasks.filterGroupShow'), /data-filter-mine/);
  assert.match(htmlOf('tasks.viewToggleLabel'), /data-filter-future/, '„Geplante" bleibt - es haengt an niemandem');
});

test('gemerkte Sets stehen zuerst im Blatt, als Aktion ohne Ein/Aus-Zustand', () => {
  baseState();
  put({ priority: ['high'], tags: ['garten'] });
  const [first] = tasks.filterSheetGroups();
  assert.equal(first.heading, 'tasks.filterGroupRecent');
  assert.match(first.html, /data-recent-filter="/);
  assert.doesNotMatch(first.html, /aria-pressed/, 'ein Set anwenden ist eine Aktion, kein Schalter');
  assert.match(first.html, /garten/, 'die Tags gehoeren in die Beschriftung, weil der Chip sie mitsetzt (#586)');
});

/** Ein Knoten mit genau dem, was das Blatt anfasst. */
class SheetEl {
  constructor({ dataset = {}, checked = false } = {}) {
    this.dataset = dataset;
    this.checked = checked;
    this.attrs = new Map();
    this.cls = new Set();
    this.classList = {
      toggle: (c, on) => { if (on) this.cls.add(c); else this.cls.delete(c); },
      contains: (c) => this.cls.has(c),
    };
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.get(k) ?? null; }
  matches(sel) {
    const m = sel.match(/^\[data-([a-z-]+)\]$/);
    const key = m?.[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return key !== undefined && this.dataset[key] !== undefined;
  }
  closest(sel) { return this.matches(sel) ? this : null; }
}

function mountSheet() {
  const chips = [
    new SheetEl({ dataset: { filter: 'status', value: 'open' } }),
    new SheetEl({ dataset: { filter: 'priority', value: 'high' } }),
    new SheetEl({ dataset: { filter: 'tag', value: 'Garten' } }),
  ];
  const mine = new SheetEl({ dataset: { filterMine: 'true' } });
  const future = new SheetEl({ dataset: { filterFuture: 'true' } });
  const panel = {
    isConnected: true,
    querySelectorAll: (sel) => (sel === '[data-filter]' ? chips : []),
    querySelector: (sel) => ({ '[data-filter-mine]': mine, '[data-filter-future]': future })[sel] ?? null,
  };
  // Kein Seiten-DOM: Knopf und Liste fehlen, renderFilters und loadTasks
  // laufen dann nur ueber den Zustand und das offene Blatt.
  const container = { querySelector: () => null, querySelectorAll: () => [] };
  tasks.state.filterSheet = panel;
  return { chips, mine, future, panel, container };
}

test('ein Chip im Blatt schaltet seinen Wert und bleibt DERSELBE Knoten (Lehre aus #1373)', async () => {
  baseState();
  const { chips, container } = mountSheet();
  const high = chips[1];
  await tasks.onFilterSheetClick({ target: high }, container);
  assert.deepEqual(tasks.state.filters.priority, ['high']);
  assert.equal(high.getAttribute('aria-pressed'), 'true', 'der getippte Knoten traegt den neuen Zustand selbst');
  assert.equal(high.classList.contains('filter-chip--active'), true);
  assert.equal(chips[0].getAttribute('aria-pressed'), 'true', 'die anderen Chips werden mit abgeglichen');

  // Tags vergleichen ohne Schreibweise - der Chip heisst „Garten", der Filter „garten".
  tasks.state.filters.tags = ['garten'];
  tasks.renderFilters(container);
  assert.equal(chips[2].getAttribute('aria-pressed'), 'true');

  await tasks.onFilterSheetClick({ target: high }, container);
  assert.deepEqual(tasks.state.filters.priority, [], 'ein zweiter Tipp nimmt den Wert wieder heraus');
  assert.equal(high.getAttribute('aria-pressed'), 'false');
});

// Review PR #1673: Kategorie und Tag stehen im Blatt eingeklappt, solange
// nichts gewaehlt ist. Ein gemerktes Set setzt sie bei OFFENEM Blatt - der Chip
// wurde aktiv, seine Falte blieb zu, und ein wirkender Filter war verborgen.
test('ein gemerktes Set klappt die Falte seiner Achse auf - derselbe Knoten, nichts klappt zu', async () => {
  baseState();
  const { chips, panel, container } = mountSheet();
  const fold = (open) => ({ open });
  const withFold = (dataset, f) => {
    const chip = new SheetEl({ dataset });
    chip.closest = (sel) => (sel === 'details.filter-sheet__fold' ? f : SheetEl.prototype.closest.call(chip, sel));
    return chip;
  };
  const tagFold = fold(false);
  const catFold = fold(false);
  const tagChip = withFold({ filter: 'tag', value: 'Garten' }, tagFold);
  const catChip = withFold({ filter: 'category', value: 'household' }, catFold);
  chips.push(tagChip, catChip);
  tasks.state.filterSheet = panel;

  const recent = new SheetEl({ dataset: {
    recentFilter: JSON.stringify({ status: ['open'], priority: [], assigned_to: [], category: [], tags: ['garten'] }),
  } });
  await tasks.onFilterSheetClick({ target: recent }, container);
  assert.deepEqual(tasks.state.filters.tags, ['garten']);
  assert.equal(tagChip.getAttribute('aria-pressed'), 'true');
  assert.equal(tagFold.open, true, 'die Falte mit dem wirkenden Tag steht offen');
  assert.equal(catFold.open, false, 'eine Achse ohne Wahl bleibt zu');

  // Faellt die Wahl wieder weg, bleibt die Falte offen: zuklappen naehme dem
  // Chip, auf dem der Fokus steht, den Boden.
  await tasks.onFilterSheetClick({ target: tagChip }, container);
  assert.deepEqual(tasks.state.filters.tags, []);
  assert.equal(tagFold.open, true);
});

test('die Schalter im Blatt: „Mir zugewiesen" ist die eigene ID in der Personenachse', async () => {
  baseState({ filters: { status: ['open'], priority: [], assigned_to: ['2'], category: [], tags: [] } });
  const { mine, future, container } = mountSheet();
  await tasks.onFilterSheetChange(mine, container);
  assert.deepEqual(tasks.state.filters.assigned_to, ['2', '1'],
    'eine schon gewaehlte zweite Person bleibt stehen (#671)');
  assert.equal(mine.checked, true, 'der Schalter wird aus dem Zustand nachgezogen');

  future.checked = true;
  await tasks.onFilterSheetChange(future, container);
  assert.equal(tasks.state.showFuture, true);
  assert.equal(store.get('yuvomi:taskShowFuture'), '1', 'pro Geraet gemerkt wie vorher der Chip');
});

test('„Filter zuruecksetzen" stellt den Standard her, keinen dritten Zustand (R16)', async () => {
  // „Alle Filter aufheben" leerte auch den Status: das zeigte Erledigtes mit,
  // war also weder der Ruhezustand noch das, was vorher eingestellt war.
  baseState({ showFuture: true });
  tasks.state.filters.priority = ['high'];
  tasks.state.filters.status = ['done'];
  const { container } = mountSheet();
  await tasks.resetTaskFilters(container);
  assert.deepEqual(tasks.state.filters, { status: ['open'], priority: [], assigned_to: [], category: [], tags: [] });
  assert.equal(tasks.state.showFuture, false);
  assert.equal(tasks.activeFilterCount(), 0);
});

test('das Werkzeugmenue: Verwalten nur mit Schreibrecht, Auswahl nur in der Liste', () => {
  baseState();
  const byAction = () => Object.fromEntries(tasks.toolsMenuItems().filter((i) => i.action).map((i) => [i.action, i]));
  assert.deepEqual(Object.keys(byAction()), ['bulk-select', 'bulk-archive', 'bulk-tag-add', 'bulk-tag-remove', 'toggle-history', 'manage-categories', 'manage-tags'],
    'alles, was vorher als loses Icon im Kopf stand, steht beschriftet im Menue');
  assert.equal(byAction()['bulk-select'].disabled, false);
  // Ablegen und die Tag-Sammelaktionen passen nicht in die einzeilige Pille
  // (D5): sie stehen im Menue, gesperrt, bis eine Auswahl sie freigibt.
  assert.equal(byAction()['bulk-archive'].disabled, true);
  assert.equal(byAction()['bulk-tag-add'].disabled, true);
  assert.equal(byAction()['bulk-tag-remove'].disabled, true);
  assert.equal(byAction()['toggle-history'].checked, false);

  tasks.state.viewMode = 'kanban';
  assert.equal(byAction()['bulk-select'].disabled, true, 'im Brett gibt es keine Mehrfachauswahl');
  tasks.state.viewMode = 'history';
  assert.equal(byAction()['toggle-history'].checked, true, 'der Verlauf ist ein Schalter mit Haken');

  setPermissions({ admin: false, modules: { tasks: 'read' }, widgets: {}, capabilities: {} });
  try {
    assert.deepEqual(Object.keys(byAction()), ['toggle-history'],
      'bei Nur-lesen bleibt nur, was zeigt (#467) - Auswahl fuehrt nur zu schreibenden Sammelaktionen');
  } finally {
    clearPermissions();
  }
});

// ---------------------------------------------------------------------------
// `?due=today` (Re-Critique 2026-09-27, S2): „+n weitere heute" in der
// Uebersicht zeigt auf die Aufgabenliste, und die Liste muss dann die Zeilen
// zeigen, die dort verdeckt waren - offen und bis heute faellig, das
// Ueberfaellige eingeschlossen. Der Filter kommt aus der Adresse, zaehlt am
// Knopf mit, steht im Blatt als Schalter und nimmt beim Ausschalten auch die
// Adresse wieder mit - sonst stuende er nach dem Neuladen wieder da.
// ---------------------------------------------------------------------------
const { todayKey: dueTodayKey, toLocalDateKey } = await import('../public/utils/date.js');

function dayOffset(days) {
  const d = new Date(`${dueTodayKey()}T12:00:00`);
  d.setDate(d.getDate() + days);
  return toLocalDateKey(d);
}

test('die Adresse setzt „Bis heute faellig" - nur mit genau diesem Wert', () => {
  assert.equal(tasks.dueTodayFromSearch('?due=today'), true);
  assert.equal(tasks.dueTodayFromSearch('?open=4&due=today'), true, 'neben anderen Parametern');
  assert.equal(tasks.dueTodayFromSearch('?due=tomorrow'), false, 'ein unbekannter Wert filtert nicht still leer');
  assert.equal(tasks.dueTodayFromSearch(''), false);
});

test('„Bis heute faellig" zeigt Offenes von heute UND Ueberfaelliges, sonst nichts', () => {
  baseState();
  tasks.state.searchQuery = '';
  tasks.state.tasks = [
    { id: 1, title: 'gestern', status: 'open', due_date: dayOffset(-1) },
    { id: 2, title: 'heute', status: 'in_progress', due_date: dueTodayKey() },
    { id: 3, title: 'morgen', status: 'open', due_date: dayOffset(1) },
    { id: 4, title: 'ohne', status: 'open', due_date: null },
    { id: 5, title: 'erledigt', status: 'done', due_date: dueTodayKey() },
  ];
  tasks.state.dueToday = false;
  assert.equal(tasks.filteredTasks().length, 5, 'ohne den Filter alles');
  tasks.state.dueToday = true;
  assert.deepEqual(tasks.filteredTasks().map((task) => task.id), [1, 2]);
  assert.equal(tasks.activeFilterCount(), 1, 'nur dieser zaehlt - der Standard „Offen" ist seit R16 kein Filter mehr');
  tasks.state.searchQuery = 'gest';
  assert.deepEqual(tasks.filteredTasks().map((task) => task.id), [1], 'die Suche engt weiter ein');
  tasks.state.searchQuery = '';
  tasks.state.dueToday = false;
});

test('im Blatt ein Schalter; Ausschalten nimmt ihn aus Zustand UND Adresse, Aufheben ebenso', async () => {
  const replaced = [];
  const prevLocation = globalThis.location;
  const prevHistory = globalThis.history;
  globalThis.location = { pathname: '/tasks', search: '?due=today', hash: '' };
  globalThis.history = {
    state: null,
    replaceState: (_s, _t, path) => {
      replaced.push(path);
      const [, search = ''] = path.split('?');
      globalThis.location.search = search ? `?${search}` : '';
    },
  };
  try {
    baseState({ dueToday: true });
    const show = tasks.filterSheetGroups().find((g) => g.heading === 'tasks.filterGroupShow').html;
    assert.match(show, /type="checkbox"[^>]*checked[^>]*data-filter-due-today|data-filter-due-today[^>]*checked/,
      'der Schalter steht an, wenn die Adresse ihn gesetzt hat');

    const { container } = mountSheet();
    const input = new SheetEl({ dataset: { filterDueToday: 'true' }, checked: false });
    await tasks.onFilterSheetChange(input, container);
    assert.equal(tasks.state.dueToday, false);
    assert.deepEqual(replaced, ['/tasks'], 'die Adresse verliert ?due=today');

    input.checked = true;
    await tasks.onFilterSheetChange(input, container);
    assert.equal(tasks.state.dueToday, true);
    assert.equal(replaced.at(-1), '/tasks?due=today', 'und bekommt ihn beim Einschalten zurueck');

    await tasks.resetTaskFilters(container);
    assert.equal(tasks.state.dueToday, false, '„Alle Filter aufheben" nimmt ihn mit');
    assert.equal(replaced.at(-1), '/tasks');
    assert.equal(tasks.activeFilterCount(), 0);
  } finally {
    globalThis.location = prevLocation;
    globalThis.history = prevHistory;
  }
});

test('?due=today weitet den Standard-Status auf „In Bearbeitung" - einen eigenen laesst es stehen', () => {
  baseState();
  tasks.applyDueTodayFromAddress('?due=today');
  assert.equal(tasks.state.dueToday, true);
  assert.deepEqual(tasks.state.filters.status, ['open', 'in_progress'],
    'die Heute-Liste der Uebersicht zeigt begonnene Aufgaben mit - der Link muss sie auch zeigen');
  assert.match(tasks.taskQuery(), /status=open&status=in_progress/, 'und der Server bekommt beide');

  baseState({ filters: { status: ['done'], priority: [], assigned_to: [], category: [], tags: [] } });
  tasks.applyDueTodayFromAddress('?due=today');
  assert.deepEqual(tasks.state.filters.status, ['done'], 'ein bewusst gesetzter Status bleibt');

  baseState();
  tasks.applyDueTodayFromAddress('');
  assert.equal(tasks.state.dueToday, false);
  assert.deepEqual(tasks.state.filters.status, ['open'], 'ohne die Adresse aendert sich nichts');
  tasks.state.dueToday = false;
});

// Review R11: der Schalter im Blatt filterte nur die geladene Liste, die
// Adresse weitete dazu den Status und lud nach. Derselbe Filter zeigte je
// Einstieg andere Zeilen, und das Neuladen der vom Blatt geschriebenen Adresse
// vergroesserte die Liste. Beide Einstiege muessen denselben Zustand UND
// dieselbe Abfrage ergeben; Ausschalten nimmt die eigene Weitung zurueck.
// Der Test bringt Adresse, Verlauf und Server-Stub selbst mit und raeumt ab.
test('„Bis heute faellig": Blatt und Adresse ergeben denselben Status und dieselbe Abfrage', async () => {
  const prevLocation = globalThis.location;
  const prevHistory = globalThis.history;
  const prevStub = globalThis.__apiStub;
  const abfragen = [];
  globalThis.location = { pathname: '/tasks', search: '', hash: '' };
  globalThis.history = {
    state: null,
    replaceState: (_s, _t, path) => {
      const [, search = ''] = path.split('?');
      globalThis.location.search = search ? `?${search}` : '';
    },
  };
  globalThis.__apiStub = { get: async (url) => { abfragen.push(url); return { data: [] }; } };
  try {
    // Einstieg ueber die Adresse: der Massstab.
    baseState({ dueToday: false, dueTodayWidened: false });
    tasks.applyDueTodayFromAddress('?due=today');
    const perAdresse = { status: [...tasks.state.filters.status], query: tasks.taskQuery() };

    // Einstieg ueber das Blatt, vom selben Ausgangszustand.
    baseState({ dueToday: false, dueTodayWidened: false });
    const { container } = mountSheet();
    const input = new SheetEl({ dataset: { filterDueToday: 'true' }, checked: true });
    await tasks.onFilterSheetChange(input, container);
    assert.equal(tasks.state.dueToday, true);
    assert.deepEqual(tasks.state.filters.status, perAdresse.status,
      'das Blatt weitet den Status wie die Adresse - sonst zeigt derselbe Filter andere Zeilen');
    assert.equal(abfragen.at(-1), `/tasks${perAdresse.query}`, 'und laedt mit derselben Abfrage nach');

    // Neuladen der geschriebenen Adresse aendert nichts mehr.
    const vorReload = [...tasks.state.filters.status];
    tasks.applyDueTodayFromAddress(globalThis.location.search);
    assert.deepEqual(tasks.state.filters.status, vorReload, 'ein Neuladen der Adresse vergroessert die Liste nicht');

    // Ausschalten nimmt die eigene Weitung zurueck und laedt wieder.
    const vorAus = abfragen.length;
    input.checked = false;
    await tasks.onFilterSheetChange(input, container);
    assert.equal(tasks.state.dueToday, false);
    assert.deepEqual(tasks.state.filters.status, ['open'], 'zurueck auf den Standard');
    assert.ok(abfragen.length > vorAus, 'und laedt ohne „In Bearbeitung" nach');
    assert.equal(abfragen.at(-1), '/tasks?status=open');

    // Ueber die Adresse eingeschaltet, im Blatt ausgeschaltet: ebenso zurueck.
    baseState({ dueToday: false, dueTodayWidened: false });
    tasks.applyDueTodayFromAddress('?due=today');
    await tasks.onFilterSheetChange(input, container);
    assert.deepEqual(tasks.state.filters.status, ['open']);

    // Ein bewusst gesetzter Status bleibt in beide Richtungen stehen.
    baseState({ dueToday: false, dueTodayWidened: false,
      filters: { status: ['open', 'in_progress'], priority: [], assigned_to: [], category: [], tags: [] } });
    input.checked = true;
    await tasks.onFilterSheetChange(input, container);
    input.checked = false;
    await tasks.onFilterSheetChange(input, container);
    assert.deepEqual(tasks.state.filters.status, ['open', 'in_progress'],
      'eine selbst gewaehlte Auswahl ist keine Weitung des Filters');
  } finally {
    globalThis.location = prevLocation;
    globalThis.history = prevHistory;
    if (prevStub === undefined) delete globalThis.__apiStub; else globalThis.__apiStub = prevStub;
    tasks.state.dueToday = false;
    tasks.state.dueTodayWidened = false;
    tasks.state.filterSheet = null;
  }
});
