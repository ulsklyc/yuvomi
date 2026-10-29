/**
 * Test: Verwalter-Dialoge in der D10-Zeilen-Endzone (#2152)
 * Zweck: Rendert die Zeilen der Verwalter - Kategorien (geteilte Komponente
 *        fuer Budget, Aufgaben, Kontakte, Einkauf, Vorrat, Inventar, Notizen),
 *        Tags, Abo-Kategorien und Zahlungsarten, Schnelllinks, Familie, seit
 *        #2180 die Modulreihenfolge in Einstellungen > Navigation - und
 *        prueft am Markup, was DESIGN.md D10 verlangt:
 *          - am Zeilenende [hoechstens EINE sichtbare Handlung][Mehr][Griff],
 *            der Griff zuletzt und nur in sortierbaren Listen;
 *          - Umbenennen/Bearbeiten und Loeschen stehen im Mehr-Menue, das
 *            Loeschen mit `danger`; kein sichtbarer Papierkorb;
 *          - der Griff ist ein Knopf mit Objekt im Namen, und die Pfeiltasten
 *            am Griff verschieben die Zeile ueber denselben Weg wie das Menue.
 *        test:control-dialect zaehlt dieselben Regeln als Text ueber alle
 *        Module; diese Suite rendert die echten Zeilen mit echten Daten.
 * Ausfuehren: npm run test:manager-endzone
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.HTMLElement = globalThis.HTMLElement ?? class HTMLElement extends EventTarget {};
globalThis.CustomEvent = globalThis.CustomEvent ?? class CustomEvent extends Event {
  constructor(type, init = {}) { super(type, init); this.detail = init.detail; }
};
globalThis.localStorage = globalThis.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
globalThis.CSS = globalThis.CSS ?? { escape: String };
const { installMiniDom } = await import('./mini-dom.js');
installMiniDom();
globalThis.window = globalThis.window ?? {};
globalThis.window.yuvomi = { ...globalThis.window.yuvomi, showToast() {} };
globalThis.window.matchMedia = globalThis.window.matchMedia ?? (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));

const defined = new Map();
globalThis.customElements = {
  define(name, ctor) { defined.set(name, ctor); },
  get(name) { return defined.get(name); },
};

await import('../public/components/category-manager.js');
await import('../public/components/tag-manager.js');
const CategoryManager = defined.get('yuvomi-category-manager');
const TagManager = defined.get('yuvomi-tag-manager');
const { __test: subscriptions } = await import('../public/pages/subscriptions.js');
const { __test: quickLinks, openQuickLinksManager } = await import('../public/components/quick-links-manager.js');
const { sortableSet } = await import('../public/utils/sortable.js');
const { __test: family } = await import('../public/settings/pages/admin-family.js');

// ---------------------------------------------------------------------------
// Lesen des Markups
// ---------------------------------------------------------------------------

/** Jedes `<li ...>` bis zum naechsten `<li` derselben Ebene ist eine Zeile; Unterlisten trennt `cat-sublist`. */
function rowsOf(html, rowClass) {
  const re = new RegExp(`<li class="${rowClass}[" ]`, 'g');
  const starts = [...html.matchAll(re)].map((m) => m.index);
  return starts.map((start, i) => {
    const end = starts[i + 1] ?? html.length;
    const row = html.slice(start, end);
    // Die Unterliste gehoert nicht zur Endzone der Elternzeile.
    const sub = row.indexOf('<ul class="cat-sublist"');
    return sub === -1 ? row : row.slice(0, sub);
  });
}

/**
 * Die sichtbaren Bedienziele am Zeilenende, in Reihenfolge: `more` (der
 * Mehr-Knopf), `handle` (der Griff), `action` (jede andere `.row-action`).
 * Menue-Eintraege stehen im Popover und zaehlen nicht.
 */
function endzone(row) {
  const out = [];
  for (const m of row.matchAll(/<button\b[^>]*>/g)) {
    const tag = m[0];
    if (/popover-menu__item/.test(tag)) continue;
    const cls = (tag.match(/class="([^"]*)"/) || [])[1] ?? '';
    if (/\bpopover-menu__trigger\b/.test(cls)) out.push('more');
    else if (/\b(?:list-row|settings-member)__drag\b/.test(cls)) out.push('handle');
    else if (/\brow-action\b/.test(cls)) out.push('action');
  }
  return out;
}

/** Die Eintraege des Mehr-Menues: `{ action, danger, disabled, attrs }`. */
function menuItems(row) {
  return [...row.matchAll(/<button\b[^>]*class="popover-menu__item[^"]*"[^>]*>/g)].map((m) => ({
    action: (m[0].match(/data-action="([^"]*)"/) || [])[1],
    danger: /popover-menu__item--danger/.test(m[0]),
    disabled: /\sdisabled[\s>]/.test(m[0]),
    tag: m[0],
  }));
}

function handleTag(row) {
  return (row.match(/<button\b[^>]*list-row__drag[^>]*>/) || [])[0] ?? '';
}

/** D10 als eine Aussage: hoechstens eine Handlung, dann Mehr, der Griff zuletzt. */
function assertD10(zone, { sortable }, where) {
  const actions = zone.filter((k) => k === 'action');
  assert.ok(actions.length <= 1, `${where}: ${actions.length} sichtbare Handlungen (${zone.join(', ')})`);
  const more = zone.indexOf('more');
  if (more !== -1) assert.ok(!zone.slice(more + 1).includes('action'), `${where}: Handlung hinter dem Mehr-Knopf (${zone.join(', ')})`);
  if (sortable) assert.equal(zone.at(-1), 'handle', `${where}: der Griff steht nicht zuletzt (${zone.join(', ')})`);
  else assert.ok(!zone.includes('handle'), `${where}: Griff in einer Liste ohne Reihenfolge`);
}

// ---------------------------------------------------------------------------
// Kategorien-Verwalter (eine Komponente fuer alle Module)
// ---------------------------------------------------------------------------

function categoryManager(cats, opts = {}) {
  const manager = new CategoryManager();
  manager._renderShell = () => {};
  manager._load = () => {};
  manager.configure({ basePath: '/budget/categories', ...opts });
  manager._cats = cats;
  return manager;
}

test('Kategorien: Zeile endet [Mehr][Griff], Umbenennen/Auf/Ab/Loeschen im Menue, Loeschen danger', () => {
  const manager = categoryManager([{ key: 'a', name: 'Lebensmittel' }, { key: 'b', name: 'Wohnen' }, { key: 'c', name: 'Freizeit' }]);
  const rows = rowsOf(manager._groupSectionHtml({ key: '', labelKey: '' }), 'cat-row');
  assert.equal(rows.length, 3);
  rows.forEach((row, i) => {
    const zone = endzone(row);
    assertD10(zone, { sortable: true }, `Zeile ${i + 1}`);
    assert.deepEqual(zone, ['more', 'handle']);
    const items = menuItems(row);
    assert.deepEqual(items.map((x) => x.action), ['rename', 'up', 'down', 'delete']);
    assert.deepEqual(items.filter((x) => x.danger).map((x) => x.action), ['delete']);
    assert.equal(items[1].disabled, i === 0, 'Nach oben am Listenanfang gesperrt');
    assert.equal(items[2].disabled, i === rows.length - 1, 'Nach unten am Listenende gesperrt');
    assert.doesNotMatch(row, /<span class="cat-row__handle"/, 'kein role="img"-Griff vor der Zeile');
  });
  // Der Griff nennt Objekt und Position.
  assert.match(handleTag(rows[1]), /aria-label="shopping\.reorderHandle\{&quot;name&quot;:&quot;Wohnen&quot;\}, shopping\.reorderPosition\{&quot;index&quot;:2,&quot;total&quot;:3\}"/);
  assert.match(handleTag(rows[1]), /data-reorder-handle/);
});

test('Kategorien: Unterkategorien tragen dieselbe Endzone', () => {
  const manager = categoryManager([{ key: 'a', name: 'Haushalt', type: 'expense', subcategories: [{ key: 's1', name: 'Strom' }, { key: 's2', name: 'Wasser' }] }],
    { supportsSubcategories: true, groups: [{ key: 'expense', labelKey: 'x', subcategories: true }] });
  const html = manager._groupSectionHtml({ key: 'expense', labelKey: 'x', subcategories: true });
  const subRows = rowsOf(html, 'cat-subrow');
  assert.equal(subRows.length, 2);
  for (const row of subRows) {
    assert.deepEqual(endzone(row), ['more', 'handle']);
    assert.deepEqual(menuItems(row).map((x) => x.action), ['sub-rename', 'sub-up', 'sub-down', 'sub-delete']);
    assert.match(handleTag(row), /cat-subrow__handle/);
  }
});

/**
 * Ein Kategorien-Verwalter mit Attrappen-Zeilen: je Schluessel ein Griff und
 * ein Mehr-Knopf, die sich ins Protokoll `focused` eintragen. Gespeichert wird
 * ueber den echten `_move`/`_persistOrder`; die Antwort des Servers haelt der
 * Test in der Hand (`answers`), damit er zwei Schritte ueberlappen lassen kann.
 */
function reorderRig(keys) {
  const manager = categoryManager(keys.map((key) => ({ key, name: key.toUpperCase() })));
  manager._renderGroup = () => {};
  manager._announceMove = () => {};
  const focused = [];
  const rows = new Map();
  for (const key of keys) {
    const rowEl = { dataset: { key } };
    const handle = { focus: () => focused.push(`${key}:handle`) };
    const more = { focus: () => focused.push(`${key}:more`) };
    handle.closest = (sel) => (sel === '[data-reorder-handle]' ? handle : sel === '.cat-row' ? rowEl : sel.includes('cat-row') ? rowEl : null);
    more.closest = () => rowEl;
    rowEl.querySelector = () => null;
    rowEl.querySelectorAll = (sel) => (sel === '[data-reorder-handle]' ? [handle] : sel === '.row-action--more' ? [more] : []);
    rows.set(key, { rowEl, handle });
  }
  manager._groupsEl = { querySelector: (sel) => rows.get((sel.match(/data-key="([^"]*)"/) || [])[1])?.rowEl ?? null };
  const answers = [];
  globalThis.__apiStub = {
    patch: (_path, body) => new Promise((resolve, reject) => {
      const answer = () => resolve({ data: body.order.map((key) => ({ key, name: key.toUpperCase() })) });
      answer.fail = () => { const err = new Error('offline'); err.status = 500; err.data = {}; reject(err); };
      answers.push(answer);
    }),
  };
  const press = (key, arrow) => manager._onKeydown({ key: arrow, target: rows.get(key).handle, preventDefault() {} });
  return { manager, focused, answers, press };
}

test('Kategorien: Pfeiltasten am Griff verschieben die Zeile, der Fokus bleibt auf dem Griff', { timeout: 5000 }, async () => {
  const { manager, focused, answers, press } = reorderRig(['a', 'b']);
  try {
    const run = press('b', 'ArrowUp');
    await new Promise((r) => setImmediate(r));
    assert.equal(answers.length, 1, 'genau eine Speicheranfrage');
    answers[0]();
    await run;
    assert.deepEqual(manager._cats.map((c) => c.key), ['b', 'a']);
    assert.deepEqual(focused, ['b:handle']);
    // Derselbe Schritt aus dem Menue gibt den Fokus an den Mehr-Knopf.
    const menu = manager._move('b', 1);
    await new Promise((r) => setImmediate(r));
    answers[1]();
    await menu;
    assert.deepEqual(focused, ['b:handle', 'b:more']);
    // Andere Tasten und andere Ziele bleiben unberuehrt.
    await manager._onKeydown({ key: 'Enter', target: { closest: () => ({}) }, preventDefault() { throw new Error('nicht abfangen'); } });
    await manager._onKeydown({ key: 'ArrowDown', target: { closest: () => null }, preventDefault() { throw new Error('nicht abfangen'); } });
    assert.equal(answers.length, 2);
  } finally {
    delete globalThis.__apiStub;
  }
});

test('Kategorien: ein Zug zur Zeit - ein zweiter Schritt waehrend der Anfrage entfaellt, ein gezogener wird zurueckgenommen (Codex an #2177)', { timeout: 5000 }, async () => {
  // Bis zum Fix liefen zwei Schritte nebeneinander: der zweite rechnete auf
  // dem unbestaetigten Stand des ersten, und scheiterte der erste, stand eine
  // Folge da, die es nirgends gab.
  const { manager, focused, answers, press } = reorderRig(['a', 'b', 'c']);
  try {
    const first = press('a', 'ArrowDown');
    const second = press('c', 'ArrowUp');
    await new Promise((r) => setImmediate(r));
    assert.equal(answers.length, 1, 'der zweite Schritt startet keine Anfrage');
    assert.equal(manager._reorderBusy, true);
    answers[0].fail();
    await first;
    await second;
    assert.deepEqual(manager._cats.map((c) => c.key), ['a', 'b', 'c'], 'gescheitert: der gespeicherte Stand bleibt');
    assert.equal(manager._reorderBusy, false);
    // Nach der Antwort zaehlt der naechste Druck wieder, und der Fokus bleibt am Griff.
    const third = press('c', 'ArrowUp');
    await new Promise((r) => setImmediate(r));
    assert.equal(answers.length, 2);
    answers[1]();
    await third;
    assert.deepEqual(manager._cats.map((c) => c.key), ['a', 'c', 'b']);
    assert.deepEqual(focused, ['c:handle']);
  } finally {
    delete globalThis.__apiStub;
  }
});

// ---------------------------------------------------------------------------
// Tag-Verwalter
// ---------------------------------------------------------------------------

test('Tags: Zeile endet [Mehr] ohne Griff, Umbenennen und Entfernen (danger) im Menue', () => {
  const manager = new TagManager();
  const row = manager._rowMarkup('einkauf', 4, 0);
  const zone = endzone(row);
  assertD10(zone, { sortable: false }, 'Tag-Zeile');
  assert.deepEqual(zone, ['more']);
  const items = menuItems(row);
  assert.deepEqual(items.map((x) => x.action), ['tag-rename', 'tag-delete']);
  assert.match(items[0].tag, /data-rename-start="einkauf"/);
  assert.match(items[1].tag, /data-delete-start="einkauf"/);
  assert.ok(items[1].danger && !items[0].danger);
  assert.doesNotMatch(row, /row-action--danger/);
  assert.match(row, /aria-label="common\.moreActionsNamed\{&quot;name&quot;:&quot;einkauf&quot;\}"/);
});

test('Tags: nach Entfernen geht der Fokus an den Mehr-Knopf der Zeile an ihrem Platz', () => {
  const manager = new TagManager();
  const focused = [];
  const rowOf = (tag) => ({ dataset: { tag }, querySelector: (sel) => (sel === '.row-action--more' ? { focus: () => focused.push(tag) } : null) });
  manager._listEl = { querySelectorAll: () => [rowOf('a'), rowOf('c')], querySelector: () => null };
  manager._focusAfter = { tag: null, fallbackIndex: 1 };
  manager._restoreFocus();
  assert.deepEqual(focused, ['c']);
  // Umbenennen: die Zeile unter ihrem neuen Namen.
  manager._focusAfter = { tag: 'a', fallbackIndex: 1 };
  manager._restoreFocus();
  assert.deepEqual(focused, ['c', 'a']);
  // Die letzte Zeile entfernt: an die davor.
  manager._focusAfter = { tag: null, fallbackIndex: 5 };
  manager._restoreFocus();
  assert.deepEqual(focused, ['c', 'a', 'c']);
});

test('Tags: Escape im Umbenennen bricht nur die Zeile ab, nicht den Dialog', () => {
  const manager = new TagManager();
  manager._tags = [{ tag: 'a', count: 1 }, { tag: 'b', count: 2 }];
  manager._open = { tag: 'b', mode: 'rename' };
  let rendered = 0;
  manager._renderList = () => { rendered += 1; };
  // Esc waehrend einer IME-Umwandlung gehoert der Umwandlung (Codex an #2177):
  // das Feld bleibt offen, der Name ungespeichert, aber nicht verworfen.
  for (const composing of [{ isComposing: true }, { keyCode: 229 }]) {
    manager._onKeydown({ key: 'Escape', ...composing, target: { closest: () => ({}) }, preventDefault() { throw new Error('nicht abfangen'); }, stopPropagation() { throw new Error('nicht abfangen'); } });
  }
  assert.deepEqual(manager._open, { tag: 'b', mode: 'rename' });
  assert.equal(rendered, 0);
  let stopped = false;
  let prevented = false;
  manager._onKeydown({ key: 'Escape', target: { closest: () => ({}) }, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.equal(manager._open, null);
  assert.equal(rendered, 1);
  assert.ok(stopped && prevented, 'der Dialog darunter bekommt das Escape nicht');
  assert.deepEqual(manager._focusAfter, { tag: 'b', fallbackIndex: 1 });
  // Ohne offene Zeile gehoert Escape dem Dialog.
  manager._onKeydown({ key: 'Escape', target: { closest: () => ({}) }, preventDefault() { throw new Error('nicht abfangen'); }, stopPropagation() { throw new Error('nicht abfangen'); } });
});

// ---------------------------------------------------------------------------
// Abo-Verwalter (Kategorien und Zahlungsarten)
// ---------------------------------------------------------------------------

test('Abos: Zeile endet [Mehr][Griff], Bearbeiten/Auf/Ab/Loeschen im Menue, Loeschen danger', () => {
  const cats = [{ id: 1, name: 'Streaming', color: '#123456' }, { id: 2, name: 'Software', color: '#654321' }];
  for (const [items, kind] of [[cats, 'categories'], [[{ id: 7, name: 'Karte' }, { id: 8, name: 'Konto' }], 'methods']]) {
    const rows = rowsOf(subscriptions.metadataRows(items, kind).replace(/<li data-id/g, '<li class="meta" data-id'), 'meta');
    assert.equal(rows.length, 2);
    rows.forEach((row, i) => {
      const zone = endzone(row.split('subscriptions-metadata-row__edit')[0]);
      assertD10(zone, { sortable: true }, `${kind} ${i + 1}`);
      assert.deepEqual(zone, ['more', 'handle']);
      const entries = menuItems(row);
      assert.deepEqual(entries.map((x) => x.action), ['meta-edit', 'meta-up', 'meta-down', 'meta-delete']);
      assert.deepEqual(entries.filter((x) => x.danger).map((x) => x.action), ['meta-delete']);
      assert.match(entries[0].tag, /data-act="edit"/);
      assert.match(entries.at(-1).tag, /data-act="delete"/);
      assert.equal(entries[1].disabled, i === 0);
      assert.equal(entries[2].disabled, i === 1);
      assert.doesNotMatch(row, /row-action--danger/);
      assert.match(handleTag(row), /data-meta-handle/);
      assert.match(handleTag(row), /aria-label="shopping\.reorderHandle/);
    });
  }
});

test('Abos: eine einzelne Zeile hat weder Griff noch Auf/Ab', () => {
  const [row] = rowsOf(subscriptions.metadataRows([{ id: 1, name: 'Streaming', color: '#123456' }], 'categories').replace(/<li data-id/g, '<li class="meta" data-id'), 'meta');
  assert.deepEqual(endzone(row), ['more']);
  assert.deepEqual(menuItems(row).map((x) => x.action), ['meta-edit', 'meta-delete']);
});

// ---------------------------------------------------------------------------
// Schnelllinks-Verwalter
// ---------------------------------------------------------------------------

test('Schnelllinks: Zeile endet [Bearbeiten][Griff], der Griff ist ein Knopf mit Namen', () => {
  const link = { id: 3, name: 'Wiki', url: 'https://wiki.example', color: null, icon_name: null, icon_data: null, visibility: 'shared' };
  const row = quickLinks.listRowHtml(link, true, 2, 3);
  const zone = endzone(row);
  assertD10(zone, { sortable: true }, 'Schnelllink');
  assert.deepEqual(zone, ['action', 'handle']);
  assert.match(handleTag(row), /data-sortable-handle/);
  assert.doesNotMatch(handleTag(row), /aria-hidden/);
  assert.match(handleTag(row), /aria-label="shopping\.reorderHandle\{&quot;name&quot;:&quot;Wiki&quot;\}, shopping\.reorderPosition\{&quot;index&quot;:2,&quot;total&quot;:3\}"/);
  // Eine fremde Kachel: keine Handlung, der Griff bleibt (die Reihe gehoert dem Haushalt).
  assert.deepEqual(endzone(quickLinks.listRowHtml(link, false, 1, 3)), ['handle']);
  // Eine Kachel allein hat keine Reihenfolge.
  assert.deepEqual(endzone(quickLinks.listRowHtml(link, true, 1, 1)), ['action']);
});

// ---------------------------------------------------------------------------
// Familie (Mitglieder, Einladungen)
// ---------------------------------------------------------------------------

const member = (id, name, extra = {}) => ({
  id, username: `u${id}`, display_name: name, role: 'member', family_role: 'other', avatar_color: '#123456',
  sort_order: 1, is_household_member: true, is_worker: false, deactivated_at: null, ...extra,
});

test('Familie: Mitgliedszeile endet [Mehr][Griff], der Zeilentipp bearbeitet, Entfernen danger im Menue (R22 D13)', () => {
  const row = family.memberHtml(member(2, 'Zoe', { birth_date: '2010-04-05', phone: '0170 1', email: 'z@x.de' }), 1, { orderable: true, aligned: true });
  const zone = endzone(row);
  assertD10(zone, { sortable: true }, 'Mitglied');
  assert.deepEqual(zone, ['more', 'handle'], 'kein Stift neben Mehr und Griff');
  // Der Name ist der Knopf der Zeile: er traegt Bearbeiten, seine Flaeche deckt die Zeile (settings.css).
  assert.match(row, /<button type="button" class="settings-member__name settings-member__open" data-edit-user="2" data-member-name aria-label="[^"]*Zoe[^"]*">Zoe<\/button>/);
  assert.doesNotMatch(row, /edit-2|pencil/, 'kein Stift-Zeichen');
  // Der Geburtstag steht nicht in der Zeile, Telefon und Adresse schon.
  assert.doesNotMatch(row, /05\.04|2010|memberBirthday/);
  assert.match(row, /z@x\.de/);
  const items = menuItems(row);
  assert.deepEqual(items.map((x) => x.action), ['remove-member']);
  assert.ok(items[0].danger);
  assert.match(items[0].tag, /data-delete-user="2"/);
  assert.match(items[0].tag, /data-name="Zoe"/);
  assert.doesNotMatch(row, /row-action--danger/);
});

test('Familie: die eigene Zeile haelt den Platz des Mehr-Knopfs frei, der Griff bleibt zuletzt', () => {
  const row = family.memberHtml(member(1, 'Mara', { role: 'admin' }), 1, { orderable: true, aligned: true });
  assert.deepEqual(endzone(row), ['handle']);
  assert.match(row, /data-edit-user="1"/, 'auch die eigene Zeile oeffnet per Tipp');
  assert.ok(row.indexOf('settings-member__slot') < row.indexOf('settings-member__drag'), 'der freie Platz steht vor dem Griff');
  // Ehemalig: kein Bearbeiten, der Platzhalter des Griffs am Ende.
  const former = family.memberHtml(member(3, 'Alt', { deactivated_at: '2026-01-01T00:00:00Z' }), 1, { orderable: false, aligned: true });
  assert.deepEqual(endzone(former), ['more']);
  assert.doesNotMatch(former, /data-edit-user/, 'Ehemalige lassen sich nicht bearbeiten');
  assert.ok(former.indexOf('popover-menu__trigger') < former.indexOf('settings-member__drag--none'));
});

test('Familie: Einladung widerrufen steht im Mehr-Menue (danger)', () => {
  const row = family.inviteHtml({ id: 9, display_name: 'Oma', family_role: 'other', role: 'member', expires_at: '2026-12-01T00:00:00Z' });
  assert.deepEqual(endzone(row), ['more']);
  const items = menuItems(row);
  assert.deepEqual(items.map((x) => x.action), ['revoke-invite']);
  assert.ok(items[0].danger);
  assert.match(items[0].tag, /data-revoke-invite="9"/);
});

// ---------------------------------------------------------------------------
// Sortable-Instanzen der sich neu aufbauenden Dialoge (Codex an #2177)
// ---------------------------------------------------------------------------

test('sortableSet: clear() gibt alle frei, eine nach dem Schliessen fertige Instanz stirbt sofort', async () => {
  assert.equal(typeof sortableSet, 'function', 'utils/sortable.js exportiert sortableSet');
  const destroyed = [];
  let release;
  const late = new Promise((r) => { release = r; });
  const make = (name) => ({ name, destroy: () => destroyed.push(name) });
  const queue = [Promise.resolve(make('erste')), late];
  const set = sortableSet({ create: () => queue.shift() });
  const list = { isConnected: true };
  await set.add(list, {});
  assert.equal(set.size(), 1);
  const pending = set.add(list, {});
  set.clear();
  assert.deepEqual(destroyed, ['erste']);
  release(make('spaet'));
  assert.equal(await pending, null);
  assert.deepEqual(destroyed, ['erste', 'spaet'], 'die spaete Instanz wird zerstoert statt zu verwaisen');
  assert.equal(set.size(), 0);
  // Eine Liste, die schon aus dem Dokument ist, bekommt keine Instanz.
  const gone = sortableSet({ create: async () => make('weg') });
  assert.equal(await gone.add({ isConnected: false }, {}), null);
  assert.equal(destroyed.at(-1), 'weg');
});

test('Abos und Schnelllinks: der Verwalten-Dialog gibt seine Sortable-Instanzen beim Schliessen und Neuaufbau frei', async () => {
  const opened = [];
  globalThis.__openModal = (opts) => { opened.push(opts); };
  globalThis.__apiStub = { get: async () => ({ data: [] }) };
  try {
    subscriptions.openMetadataModal();
    await openQuickLinksManager();
  } finally {
    delete globalThis.__openModal;
    delete globalThis.__apiStub;
  }
  assert.equal(opened.length, 2, 'beide Dialoge gehen auf');
  for (const opts of opened) assert.equal(typeof opts.onClose, 'function', `${opts.title}: kein onClose, die Instanzen verwaisen`);
  const { readFileSync } = await import('node:fs');
  for (const [file, name] of [['../public/pages/subscriptions.js', 'metaSortables'], ['../public/components/quick-links-manager.js', 'manageSortables']]) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(src, new RegExp(`onClose: \\(\\) => ${name}\\.clear\\(\\)`), `${file}: onClose gibt frei`);
    assert.match(src, new RegExp(`${name}\\.clear\\(\\);\\n\\s*(?:for |${name}\\.add)`), `${file}: der Neuaufbau gibt erst frei`);
    assert.doesNotMatch(src, /\bmakeSortable\(/, `${file}: keine Instanz am Merker vorbei`);
  }
});

// ---------------------------------------------------------------------------
// Ein Zug, der nicht gespeichert werden kann, nimmt sich zurueck (Codex an #2177)
// ---------------------------------------------------------------------------

/** Eine Liste, die Kinder umhaengen kann - mehr braucht der Rueckweg nicht. */
function fakeList(ids, extra = {}) {
  const list = {
    children: [],
    appendChild(row) { this.remove(row); this.children.push(row); row.parentElement = this; return row; },
    insertBefore(row, ref) {
      this.remove(row);
      const at = ref ? this.children.indexOf(ref) : -1;
      if (at < 0) this.children.push(row); else this.children.splice(at, 0, row);
      row.parentElement = this;
      return row;
    },
    remove(row) { const i = this.children.indexOf(row); if (i >= 0) this.children.splice(i, 1); },
    querySelectorAll() { return [...this.children]; },
    order() { return this.children.map((row) => row.dataset.id); },
    ...extra,
  };
  for (const id of ids) list.appendChild({ dataset: { id: String(id) } });
  return list;
}

test('restoreOrder: haengt die Zeilen in die gespeicherte Folge zurueck', async () => {
  const { restoreOrder } = await import('../public/utils/sortable.js');
  assert.equal(typeof restoreOrder, 'function', 'utils/sortable.js exportiert restoreOrder');
  const list = fakeList([2, 1, 3]);
  restoreOrder(list, [1, 2, 3], (row) => row.dataset.id);
  assert.deepEqual(list.order(), ['1', '2', '3']);
});

test('Abos: scheitert das Speichern eines Zugs, steht wieder die gespeicherte Reihenfolge da', { timeout: 5000 }, async () => {
  const saved = subscriptions.state.meta.categories;
  subscriptions.state.meta.categories = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }];
  // So steht die Liste nach dem Ziehen: SortableJS hat 2 schon vor 1 gehaengt.
  const list = fakeList([2, 1, 3], { id: 'subscription-category-list' });
  globalThis.__apiStub = { put: async () => { const err = new Error('boom'); err.status = 500; err.data = {}; throw err; } };
  try {
    const ok = await subscriptions.persistMetaOrder(list, [2, 1, 3]);
    assert.equal(ok, false);
    assert.deepEqual(list.order(), ['1', '2', '3'], 'der ungespeicherte Zug ist zurueckgenommen');
  } finally {
    delete globalThis.__apiStub;
    subscriptions.state.meta.categories = saved;
  }
});

test('Abos: ein Zug zur Zeit - ein Zug waehrend der Anfrage wird zurueckgenommen, scheitert der erste, steht der gespeicherte Stand da (Codex an #2177)', { timeout: 5000 }, async () => {
  const saved = subscriptions.state.meta.categories;
  subscriptions.state.meta.categories = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }];
  const list = fakeList([2, 1, 3], { id: 'subscription-category-list' });
  const answers = [];
  globalThis.__apiStub = {
    put: () => new Promise((_resolve, reject) => { answers.push(() => { const err = new Error('boom'); err.status = 500; err.data = {}; reject(err); }); }),
  };
  try {
    const first = subscriptions.persistMetaOrder(list, [2, 1, 3]);
    // Waehrenddessen zieht jemand die dritte Zeile nach oben.
    list.insertBefore(list.children[2], list.children[0]);
    assert.equal(await subscriptions.persistMetaOrder(list, [3, 2, 1]), null);
    assert.equal(answers.length, 1, 'kein zweiter Schreibversuch');
    assert.deepEqual(list.order(), ['2', '1', '3'], 'der zweite Zug ist zurueckgenommen');
    answers[0]();
    assert.equal(await first, false);
    assert.deepEqual(list.order(), ['1', '2', '3'], 'angezeigt ist, was gespeichert ist');
  } finally {
    delete globalThis.__apiStub;
    subscriptions.state.meta.categories = saved;
  }
});

test('Abos: die Sperre gilt je Liste - ein Zahlungsart-Zug neben einem haengenden Kategorie-Zug wird nicht mit fremder Folge zurueckgenommen (Codex an #2177)', { timeout: 5000 }, async () => {
  const saved = { categories: subscriptions.state.meta.categories, payment_methods: subscriptions.state.meta.payment_methods };
  subscriptions.state.meta.categories = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
  subscriptions.state.meta.payment_methods = [{ id: 7, name: 'Karte' }, { id: 8, name: 'Konto' }];
  const cats = fakeList([2, 1], { id: 'subscription-category-list' });
  const methods = fakeList([8, 7], { id: 'subscription-method-list' });
  const answers = [];
  globalThis.__apiStub = {
    put: (_path, body) => new Promise((resolve, reject) => {
      answers.push({ body, ok: () => resolve({ data: true }), fail: () => { const err = new Error('boom'); err.status = 500; err.data = {}; reject(err); } });
    }),
  };
  try {
    const catMove = subscriptions.persistMetaOrder(cats, [2, 1]);
    const methodMove = subscriptions.persistMetaOrder(methods, [8, 7]);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(answers.map((a) => Object.keys(a.body)[0]), ['categories', 'payment_methods'], 'die Zahlungsarten speichern neben den Kategorien');
    assert.deepEqual(methods.order(), ['8', '7'], 'der Zahlungsart-Zug bleibt stehen, solange er speichert');
    answers[0].fail();
    assert.equal(await catMove, false);
    assert.deepEqual(cats.order(), ['1', '2'], 'die Kategorien aus IHRER gespeicherten Folge');
    assert.deepEqual(methods.order(), ['8', '7'], 'die Zahlungsarten unberuehrt');
    answers[1].fail();
    assert.equal(await methodMove, false);
    assert.deepEqual(methods.order(), ['7', '8'], 'die Zahlungsarten aus IHRER gespeicherten Folge');
  } finally {
    delete globalThis.__apiStub;
    subscriptions.state.meta.categories = saved.categories;
    subscriptions.state.meta.payment_methods = saved.payment_methods;
  }
});

test('Schnelllinks: scheitert das Speichern eines Schritts, steht wieder die gespeicherte Reihenfolge da', { timeout: 5000 }, async () => {
  const items = [{ id: 1, name: 'A', url: 'https://a.example' }, { id: 2, name: 'B', url: 'https://b.example' }];
  let onKeydown = null;
  const list = fakeList([1, 2], {
    addEventListener: (type, fn) => { if (type === 'keydown') onKeydown = fn; },
    querySelectorAll() { return [...this.children]; },
  });
  for (const row of list.children) {
    row.querySelector = () => null;
    row.handle = { focus() {}, closest: (sel) => (sel === '[data-sortable-handle]' ? row.handle : row) };
    row.closest = () => row;
  }
  // nextElementSibling/previousElementSibling aus der Folge der Liste.
  for (const row of list.children) {
    Object.defineProperty(row, 'nextElementSibling', { get: () => list.children[list.children.indexOf(row) + 1] ?? null });
    Object.defineProperty(row, 'previousElementSibling', { get: () => list.children[list.children.indexOf(row) - 1] ?? null });
  }
  const el = () => ({ addEventListener() {} });
  const panel = { querySelector: (sel) => (sel === '#quick-link-manage-list' ? list : el()), querySelectorAll: () => [] };
  let failed;
  const done = new Promise((r) => { failed = r; });
  globalThis.__openModal = (opts) => opts.onSave(panel);
  globalThis.__apiStub = {
    get: async () => ({ data: items }),
    put: async () => { failed(); throw new Error('offline'); },
  };
  try {
    await openQuickLinksManager();
    assert.ok(onKeydown, 'der Tastaturpfad ist verdrahtet');
    const first = list.children[0];
    onKeydown({ key: 'ArrowDown', target: first.handle, preventDefault() {} });
    assert.deepEqual(list.order(), ['2', '1'], 'der Schritt haengt die Zeile sofort um');
    await done;
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(list.order(), ['1', '2'], 'nach dem Fehlschlag zurueck auf den Stand des Servers');
  } finally {
    delete globalThis.__openModal;
    delete globalThis.__apiStub;
  }
});

test('Schnelllinks: ein Zug zur Zeit - scheitert der erste, steht kein zweiter gespeichert neben der Anzeige (Codex an #2177)', { timeout: 5000 }, async () => {
  const items = [{ id: 1, name: 'A', url: 'https://a.example' }, { id: 2, name: 'B', url: 'https://b.example' }, { id: 3, name: 'C', url: 'https://c.example' }];
  let onKeydown = null;
  const list = fakeList([1, 2, 3], { addEventListener: (type, fn) => { if (type === 'keydown') onKeydown = fn; } });
  for (const row of list.children) {
    row.querySelector = () => null;
    row.handle = { focus() {}, closest: (sel) => (sel === '[data-sortable-handle]' ? row.handle : row) };
    row.closest = () => row;
    Object.defineProperty(row, 'nextElementSibling', { get: () => list.children[list.children.indexOf(row) + 1] ?? null });
    Object.defineProperty(row, 'previousElementSibling', { get: () => list.children[list.children.indexOf(row) - 1] ?? null });
  }
  const el = () => ({ addEventListener() {} });
  const panel = { querySelector: (sel) => (sel === '#quick-link-manage-list' ? list : el()), querySelectorAll: () => [] };
  const answers = [];
  const sent = [];
  globalThis.__openModal = (opts) => opts.onSave(panel);
  globalThis.__apiStub = {
    get: async () => ({ data: items }),
    put: (_path, body) => new Promise((resolve, reject) => { sent.push(body.ids.join(',')); answers.push({ ok: () => resolve({ data: true }), fail: () => reject(new Error('offline')) }); }),
  };
  try {
    await openQuickLinksManager();
    const [a, , c] = list.children;
    onKeydown({ key: 'ArrowDown', target: a.handle, preventDefault() {} });
    onKeydown({ key: 'ArrowUp', target: c.handle, preventDefault() {} });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sent, ['2,1,3'], 'der zweite Schritt waehrend der Anfrage entfaellt');
    answers[0].fail();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(list.order(), ['1', '2', '3'], 'angezeigt ist, was gespeichert ist');
  } finally {
    delete globalThis.__openModal;
    delete globalThis.__apiStub;
  }
});

// ---------------------------------------------------------------------------
// Einstellungen > Navigation: Reihenfolge der Module (#2180)
// ---------------------------------------------------------------------------

const navigation = await import('../public/settings/pages/modules-navigation.js');

function navRow(id, label, extra = {}) {
  return { type: 'built-in', id, orderId: id, section: 'plan', label, icon: 'calendar', enabled: true, hidden: false, locked: false, sortable: true, ...extra };
}

/** Jede `<div class="settings-module-row ...">` bis zur naechsten ist eine Zeile. */
function navRowsOf(html) {
  const starts = [...html.matchAll(/<div class="settings-module-row[" ]/g)].map((m) => m.index);
  return starts.map((start, i) => html.slice(start, starts[i + 1] ?? html.length));
}

/** Die Endzone der Zeile; der Ausblenden-Knopf zaehlt als ihre eine sichtbare Handlung. */
function navEndzone(row) {
  const at = row.indexOf('settings-module-row__end');
  if (at === -1) return [];
  // Die eine Handlung ist seit R24 der Schalter "In meiner Navigation"
  // (`input role="switch"` in der geteilten Schalterzeile) - er zaehlt als
  // Handlung, wie vorher der Ausblenden-Knopf.
  return endzone(row.slice(at).replace(/<input type="checkbox" role="switch"/g, '<button class="row-action settings-module-hide"'));
}

test('Navigation: Zeile endet [Ausblenden][Mehr][Griff], kein sichtbares Auf/Ab-Paar mehr (#2180)', () => {
  const html = navigation.__test.sectionRowsHtml([
    navRow('dashboard', 'Uebersicht', { locked: true, sortable: false }),
    navRow('calendar', 'Kalender'),
    navRow('tasks', 'Aufgaben'),
    navRow('notes', 'Notizen'),
  ]);
  // Bis #2180 stand ein Paar `.settings-module-move` je Zeile, dazu ein Griff
  // vor dem Symbol mit nativem `draggable="true"` (kein Touch, kein Tastaturweg).
  assert.doesNotMatch(html, /settings-module-move|data-module-move|draggable="true"|settings-module-drag/);
  const [locked, ...rows] = navRowsOf(html);
  assert.deepEqual(navEndzone(locked), [], 'eine gesperrte Zeile hat keine Endzone');
  rows.forEach((row, i) => {
    const zone = navEndzone(row);
    assertD10(zone, { sortable: true }, `Navigationszeile ${i + 1}`);
    assert.deepEqual(zone, ['action', 'more', 'handle']);
    assert.match(row, /<label class="toggle-row toggle-row--switch settings-module-hide">[\s\S]*?<input type="checkbox" role="switch" data-module-hide="\w+"/,
      'die eine Handlung ist der Schalter "In meiner Navigation" (R24)');
    assert.doesNotMatch(row, /eye-off|aria-pressed/, 'kein durchgestrichenes Auge, kein Umschaltknopf mehr');
    const items = menuItems(row);
    assert.deepEqual(items.map((x) => x.action), ['module-move-up', 'module-move-down']);
    assert.equal(items[0].disabled, i === 0, 'Nach oben in der ersten Zeile gesperrt');
    assert.equal(items[1].disabled, i === rows.length - 1, 'Nach unten in der letzten Zeile gesperrt');
    const handle = handleTag(row);
    assert.match(handle, /data-module-handle/);
    assert.match(handle, /aria-keyshortcuts="ArrowUp ArrowDown"/);
    assert.match(handle, /shopping\.reorderHandle\{&quot;name&quot;:&quot;\w+&quot;\}, shopping\.reorderPosition\{&quot;index&quot;:\d,&quot;total&quot;:3\}/);
    assert.equal(handle.match(/&quot;index&quot;:(\d)/)[1], String(i + 1), 'das Label nennt die Position');
  });
});

test('Navigation: allein in der Gruppe - weder Griff noch Menue, aber der Platz bleibt (Augen in einer Spur)', () => {
  const [row] = navRowsOf(navigation.__test.sectionRowsHtml([navRow('budget', 'Budget')]));
  assert.deepEqual(navEndzone(row), ['action']);
  assert.equal(menuItems(row).length, 0);
  assert.equal((row.match(/settings-module-row__slot/g) || []).length, 2, 'Platzhalter fuer Mehr und Griff');
});

test('Navigation: ein Drittmodul ohne Ausblenden endet [Mehr][Griff]', () => {
  const html = navigation.__test.sectionRowsHtml([
    navRow('third-party-a', 'Alpha', { type: 'third-party', status: 'x', accent: '' }),
    navRow('third-party-b', 'Beta', { type: 'third-party', status: 'x', accent: '' }),
  ]);
  const rows = navRowsOf(html);
  assert.equal(rows.length, 2);
  for (const row of rows) assert.deepEqual(navEndzone(row), ['more', 'handle']);
});

/** Eine Gruppe aus Attrappen: Zeilen mit Griff, Mehr-Knopf und den zwei Menue-Eintraegen. */
function navRig(ids, { locked = [] } = {}) {
  const focused = [];
  const list = {
    children: [],
    appendChild(row) { this.remove(row); this.children.push(row); row.parentElement = this; return row; },
    insertBefore(row, ref) {
      this.remove(row);
      const at = this.children.indexOf(ref);
      this.children.splice(at < 0 ? this.children.length : at, 0, row);
      row.parentElement = this;
      return row;
    },
    remove(row) { const i = this.children.indexOf(row); if (i >= 0) this.children.splice(i, 1); },
    order() { return this.children.map((row) => row.dataset.moduleRowId); },
  };
  const rows = new Map();
  for (const id of [...locked, ...ids]) {
    const row = { dataset: { moduleRowId: id }, querySelector: () => null };
    if (!locked.includes(id)) {
      row.dataset.moduleOrderId = id;
      row.dataset.moduleName = id.toUpperCase();
      const parts = {
        handle: { focus: () => focused.push(`${id}:handle`), setAttribute(name, value) { this[name] = value; } },
        more: { focus: () => focused.push(`${id}:more`) },
        up: { dataset: { action: 'module-move-up' }, disabled: false },
        down: { dataset: { action: 'module-move-down' }, disabled: false },
      };
      parts.handle.closest = (sel) => (sel === '[data-module-handle]' ? parts.handle : row);
      parts.up.closest = () => row;
      parts.down.closest = () => row;
      row.querySelector = (sel) => ({
        '[data-module-handle]': parts.handle,
        '.row-action--more': parts.more,
        '[data-action="module-move-up"]': parts.up,
        '[data-action="module-move-down"]': parts.down,
      })[sel] ?? null;
      row.parts = parts;
    }
    list.appendChild(row);
    rows.set(id, row);
  }
  const answers = [];
  const lock = { saving: false, queued: false };
  const toasts = [];
  const drained = [];
  const reorder = navigation.createModuleReorder({
    save: () => new Promise((resolve, reject) => { answers.push({ order: list.order().join(','), ok: resolve, fail: () => reject(new Error('offline')) }); }),
    lock,
    notify: (ok) => toasts.push(ok),
    afterSave: async () => {
      if (!lock.queued) return;
      lock.queued = false;
      drained.push({ order: list.order().join(','), saving: lock.saving });
    },
  });
  reorder.adopt(list);
  const press = (id, key) => reorder.onKeydown({ key, target: rows.get(id).parts.handle, preventDefault() {} });
  const pick = (id, which) => {
    const item = rows.get(id).parts[which];
    return reorder.onClick({ target: { closest: () => item } });
  };
  return { list, rows, reorder, focused, answers, lock, toasts, drained, press, pick };
}

test('Navigation: Pfeiltaste am Griff verschiebt die Zeile, der Fokus bleibt auf dem Griff, Labels ziehen nach', { timeout: 5000 }, async () => {
  const { list, rows, focused, answers, toasts, press } = navRig(['calendar', 'tasks', 'notes'], { locked: ['dashboard'] });
  const run = press('tasks', 'ArrowUp');
  assert.deepEqual(list.order(), ['dashboard', 'tasks', 'calendar', 'notes'], 'nie ueber die gesperrte Zeile hinweg');
  assert.deepEqual(focused, ['tasks:handle']);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].order, 'dashboard,tasks,calendar,notes');
  answers[0].ok();
  assert.equal(await run, true);
  assert.deepEqual(toasts, [true]);
  assert.match(rows.get('tasks').parts.handle['aria-label'], /reorderPosition\{"index":1,"total":3\}/);
  assert.equal(rows.get('tasks').parts.up.disabled, true, 'oben angekommen: Nach oben gesperrt');
  assert.equal(rows.get('calendar').parts.up.disabled, false);
  // Am oberen Rand passiert nichts, keine Anfrage.
  assert.equal(press('tasks', 'ArrowUp'), null);
  assert.equal(answers.length, 1);
});

test('Navigation: Nach unten aus dem Mehr-Menue gibt den Fokus an den Mehr-Knopf der Zeile', { timeout: 5000 }, async () => {
  const { list, focused, answers, pick } = navRig(['calendar', 'tasks']);
  const run = pick('calendar', 'down');
  assert.deepEqual(list.order(), ['tasks', 'calendar']);
  assert.deepEqual(focused, ['calendar:more']);
  answers[0].ok();
  assert.equal(await run, true);
});

test('Navigation: ein Zug zur Zeit - waehrend des Speicherns entfaellt ein Schritt, ein Zug per Ziehen wird zurueckgenommen', { timeout: 5000 }, async () => {
  const { list, rows, answers, press, reorder } = navRig(['a', 'b', 'c']);
  const first = press('a', 'ArrowDown');
  assert.deepEqual(list.order(), ['b', 'a', 'c']);
  assert.equal(press('c', 'ArrowUp'), null, 'der zweite Schritt startet nicht');
  assert.deepEqual(list.order(), ['b', 'a', 'c']);
  // Waehrenddessen zieht jemand c nach oben (SortableJS haengt vor onEnd um).
  list.insertBefore(rows.get('c'), rows.get('b'));
  assert.equal(await reorder.persist(list), null);
  assert.deepEqual(list.order(), ['b', 'a', 'c'], 'zurueck auf die Folge, die gerade speichert');
  assert.equal(answers.length, 1, 'kein zweiter Schreibversuch');
  answers[0].ok();
  assert.equal(await first, true);
});

test('Navigation: scheitert das Speichern, steht wieder die gespeicherte Reihenfolge da', { timeout: 5000 }, async () => {
  const { list, rows, answers, toasts, press, lock } = navRig(['a', 'b', 'c']);
  const run = press('c', 'ArrowUp');
  assert.deepEqual(list.order(), ['a', 'c', 'b']);
  answers[0].fail();
  assert.equal(await run, false);
  assert.deepEqual(list.order(), ['a', 'b', 'c']);
  assert.deepEqual(toasts, [false]);
  assert.equal(lock.saving, false, 'die Sperre ist wieder frei');
  assert.match(rows.get('c').parts.handle['aria-label'], /"index":3/, 'das Label sagt wieder die gespeicherte Position');
});

test('Navigation: eine waehrend des Sortierens gemerkte Ausblendung wird auch nach einem Fehlschlag gespeichert', { timeout: 5000 }, async () => {
  const { list, answers, press, lock, drained } = navRig(['a', 'b', 'c']);
  const run = press('c', 'ArrowUp');
  // Waehrend der Sortier-Save laeuft, blendet jemand ein Modul aus: der Ausblende-Weg merkt sich das nur.
  lock.queued = true;
  answers[0].fail();
  assert.equal(await run, false);
  assert.deepEqual(list.order(), ['a', 'b', 'c']);
  assert.deepEqual(drained, [{ order: 'a,b,c', saving: false }], 'nachgeholt, mit der gespeicherten Reihenfolge und freier Sperre');
  assert.equal(lock.queued, false);
});
