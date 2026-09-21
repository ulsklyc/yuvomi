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
 *          - #1373: das Filter-Panel laesst sich schliessen, egal wie viele
 *            Filter gewaehlt sind (Knopfplatz, Escape, „Fertig")
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
// #1373: Das Filter-Panel muss sich schliessen lassen, egal wie viele Filter
// gewaehlt sind.
//
// Auf dem Telefon scrollt `#filter-bar` seitlich. Der Filterknopf war ihr
// LETZTES Kind: jeder gewaehlte Filter setzte einen Chip davor und schob den
// Knopf weiter aus dem sichtbaren Streifen (gemessen auf 375x812: von x=122 auf
// x=437, Streifen endet bei 243). Das Panel hatte keinen zweiten Schliessweg.
//
// Gemessen wird das VERHALTEN von `renderFilters` auf einem kleinen DOM-Stub:
// wo der Knopf nach dem Waehlen steht, und dass Escape und „Fertig" das Panel
// wirklich zuklappen - ueber die Verdrahtung, die `renderFilters` selbst
// anhaengt, nicht ueber eine direkt gerufene Hilfsfunktion.
// ---------------------------------------------------------------------------

class StubEl {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.attrs = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.hidden = false;
    this.text = '';
  }
  set id(v) { this.attrs.set('id', String(v)); }
  get id() { return this.attrs.get('id') ?? ''; }
  set className(v) { this.attrs.set('class', String(v)); }
  get className() { return this.attrs.get('class') ?? ''; }
  set textContent(v) { this.children = []; this.text = String(v); }
  get textContent() { return this.text + this.children.map((c) => c.textContent ?? '').join(''); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); if (k === 'id') this.id = v; }
  getAttribute(k) { return this.attrs.get(k) ?? null; }
  appendChild(n) { n.parent = this; this.children.push(n); return n; }
  append(...ns) { ns.forEach((n) => this.appendChild(n)); }
  replaceChildren(...ns) { this.children.forEach((c) => { c.parent = null; }); this.children = []; this.append(...ns); }
  contains(n) { for (let x = n; x; x = x.parent) if (x === this) return true; return false; }
  *walk() { for (const c of this.children) { if (c instanceof StubEl) { yield c; yield* c.walk(); } } }
  matches(sel) {
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    const m = sel.match(/^\[data-([a-z-]+)\]$/);
    if (m) {
      const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return this.dataset[key] !== undefined;
    }
    throw new Error(`stub kennt den Selektor nicht: ${sel}`);
  }
  querySelector(sel) { for (const e of this.walk()) if (e.matches(sel)) return e; return null; }
  querySelectorAll(sel) { return [...this.walk()].filter((e) => e.matches(sel)); }
  closest(sel) { for (let x = this; x instanceof StubEl; x = x.parent) if (x.matches(sel)) return x; return null; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatch(type, init = {}) {
    const ev = { type, target: this, key: init.key, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    for (let x = this; x && !ev.stopped; x = x.parent) (x.listeners.get(type) ?? []).forEach((fn) => fn(ev));
    return ev;
  }
  click() { return this.dispatch('click'); }
  focus() { globalThis.document.activeElement = this; }
}

function mountFilterDom() {
  globalThis.document = {
    createElement: (tag) => new StubEl(tag),
    createTextNode: (text) => ({ textContent: String(text), parent: null }),
    activeElement: null,
  };
  globalThis.window = globalThis.window ?? {};
  const container = new StubEl('div');
  const row = container.appendChild(new StubEl('div'));
  row.className = 'tasks-filters-row';
  for (const id of ['filter-toggle-slot', 'filter-bar']) row.appendChild(new StubEl('div')).id = id;
  container.appendChild(new StubEl('div')).id = 'filter-panel';
  return container;
}

/** Die Ausgangslage aus dem Issue: Panel offen, mehrere Filter gewaehlt. */
function openWithFilters(container) {
  withKnown({ users: [1, 2] });
  tasks.state.viewMode = 'list';
  tasks.state.currentUserId = 1;
  tasks.state.filters = { status: ['open'], priority: ['high', 'urgent', 'medium'], assigned_to: ['2'], category: [], tags: [] };
  tasks.state.filterPanelOpen = true;
  tasks.renderFilters(container);
}

test('#1373: der Filterknopf scrollt nicht mit der Chip-Leiste weg, egal wie viele Filter', () => {
  const container = mountFilterDom();
  openWithFilters(container);
  const bar = container.querySelector('#filter-bar');
  const toggle = container.querySelector('#filter-toggle-btn');
  assert.ok(toggle, 'der Knopf wird gerendert');
  assert.ok(bar.querySelectorAll('[data-filter]').length >= 5, 'Gegenprobe: die Leiste traegt die gewaehlten Chips');
  assert.equal(bar.contains(toggle), false,
    'der Knopf steht nicht in der seitlich scrollenden Leiste, sonst schieben ihn die Chips hinaus');
  assert.equal(container.querySelector('#filter-toggle-slot').contains(toggle), true,
    'der Knopf steht in seinem festen Platz vor der Leiste');
});

test('#1373: Escape im offenen Panel klappt es zu und gibt den Fokus an den Knopf', () => {
  const container = mountFilterDom();
  openWithFilters(container);
  const panel = container.querySelector('#filter-panel');
  assert.equal(panel.hidden, false, 'Ausgangslage: das Panel ist offen');
  const chip = panel.querySelector('[data-filter]');
  const ev = chip.dispatch('keydown', { key: 'Escape' });
  assert.equal(tasks.state.filterPanelOpen, false);
  assert.equal(panel.hidden, true, 'das Panel ist zu');
  assert.equal(ev.defaultPrevented, true);
  assert.equal(globalThis.document.activeElement, container.querySelector('#filter-toggle-btn'),
    'der Fokus steht auf dem NEU gebauten Knopf');

  // Andere Tasten schliessen nicht - sonst waere das Panel mit jeder Taste zu.
  openWithFilters(container);
  panel.querySelector('[data-filter]').dispatch('keydown', { key: 'Enter' });
  assert.equal(tasks.state.filterPanelOpen, true);
});

test('#1373: „Fertig" am Ende des Panels klappt es zu, ohne die Filter anzufassen', () => {
  const container = mountFilterDom();
  openWithFilters(container);
  const panel = container.querySelector('#filter-panel');
  const done = panel.querySelector('#filter-panel-done');
  assert.ok(done, 'das Panel traegt einen eigenen Schliessweg');
  assert.equal(done.textContent, 'tasks.filterPanelDone');
  done.click();
  assert.equal(panel.hidden, true);
  assert.equal(tasks.state.filterPanelOpen, false);
  assert.deepEqual(tasks.state.filters.priority, ['high', 'urgent', 'medium'], 'die Auswahl bleibt');
});

test('#1373: die Escape-Verdrahtung stapelt sich nicht mit jedem Rendern', () => {
  const container = mountFilterDom();
  openWithFilters(container);
  for (let i = 0; i < 5; i++) tasks.renderFilters(container);
  const panel = container.querySelector('#filter-panel');
  assert.equal(panel.listeners.get('keydown').length, 1, 'ein Listener, nicht einer je Rendern');
});

test('#1373: nach dem Waehlen eines Chips im Panel schliesst Escape es weiterhin', () => {
  // Review zu #1385: das Rendern tauscht den fokussierten Chip aus, der Fokus
  // fiel aufs Dokument, und Escape erreichte das Panel nie - genau in dem
  // Zustand mit mehreren gewaehlten Filtern, um den es im Issue geht.
  const container = mountFilterDom();
  openWithFilters(container);
  const panel = container.querySelector('#filter-panel');
  const low = () => panel.querySelectorAll('[data-filter]')
    .find((el) => el.dataset.filter === 'priority' && el.dataset.value === 'low');
  const before = low();
  before.focus();
  // Was der Klick-Handler tut: Zustand aendern, neu rendern.
  tasks.state.filters.priority.push('low');
  tasks.renderFilters(container);
  const after = low();
  assert.notEqual(after, before, 'Gegenprobe: der Chip ist wirklich ein neuer Knoten');
  assert.equal(globalThis.document.activeElement, after, 'der Fokus steht auf dem Nachfolger des Chips');
  globalThis.document.activeElement.dispatch('keydown', { key: 'Escape' });
  assert.equal(tasks.state.filterPanelOpen, false, 'Escape schliesst das Panel');
});

test('#1373: verschwindet der fokussierte Chip, geht der Fokus an den Filterknopf', () => {
  const container = mountFilterDom();
  openWithFilters(container);
  const bar = container.querySelector('#filter-bar');
  const chip = bar.querySelectorAll('[data-filter]').find((el) => el.dataset.value === 'urgent');
  chip.focus();
  tasks.state.filters.priority = tasks.state.filters.priority.filter((v) => v !== 'urgent');
  tasks.renderFilters(container);
  assert.equal(globalThis.document.activeElement, container.querySelector('#filter-toggle-btn'));
});
