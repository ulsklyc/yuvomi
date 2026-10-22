/**
 * Test: Verwalter-Dialoge in der D10-Zeilen-Endzone (#2152)
 * Zweck: Rendert die Zeilen der Verwalter - Kategorien (geteilte Komponente
 *        fuer Budget, Aufgaben, Kontakte, Einkauf, Vorrat, Inventar, Notizen),
 *        Tags, Abo-Kategorien und Zahlungsarten, Schnelllinks, Familie - und
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
    patch: (_path, body) => new Promise((resolve) => {
      answers.push(() => resolve({ data: body.order.map((key) => ({ key, name: key.toUpperCase() })) }));
    }),
  };
  const press = (key, arrow) => manager._onKeydown({ key: arrow, target: rows.get(key).handle, preventDefault() {} });
  return { manager, focused, answers, press };
}

test('Kategorien: Pfeiltasten am Griff verschieben die Zeile, der Fokus bleibt auf dem Griff', async () => {
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

test('Kategorien: zwei Pfeiltasten waehrend einer laufenden Anfrage - beide Schritte behalten den Griff (Codex an #2177)', async () => {
  // Bis zum Fix lag die Herkunft "vom Griff" in einem geteilten Merker: die
  // erste Antwort verbrauchte ihn, und die zweite gab den Fokus an Mehr.
  const { focused, answers, press } = reorderRig(['a', 'b', 'c']);
  try {
    const first = press('a', 'ArrowDown');
    const second = press('c', 'ArrowUp');
    await new Promise((r) => setImmediate(r));
    assert.equal(answers.length, 2, 'beide Schritte laufen');
    answers[0]();
    await first;
    answers[1]();
    await second;
    assert.deepEqual(focused, ['a:handle', 'c:handle']);
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

test('Familie: Mitgliedszeile endet [Bearbeiten][Mehr][Griff], Entfernen danger im Menue', () => {
  const row = family.memberHtml(member(2, 'Zoe'), 1, { orderable: true, aligned: true });
  const zone = endzone(row);
  assertD10(zone, { sortable: true }, 'Mitglied');
  assert.deepEqual(zone, ['action', 'more', 'handle']);
  const items = menuItems(row);
  assert.deepEqual(items.map((x) => x.action), ['remove-member']);
  assert.ok(items[0].danger);
  assert.match(items[0].tag, /data-delete-user="2"/);
  assert.match(items[0].tag, /data-name="Zoe"/);
  assert.doesNotMatch(row, /row-action--danger/);
});

test('Familie: die eigene Zeile haelt den Platz des Mehr-Knopfs frei, der Griff bleibt zuletzt', () => {
  const row = family.memberHtml(member(1, 'Mara', { role: 'admin' }), 1, { orderable: true, aligned: true });
  assert.deepEqual(endzone(row), ['action', 'handle']);
  assert.ok(row.indexOf('settings-member__slot') < row.indexOf('settings-member__drag'), 'der freie Platz steht vor dem Griff');
  // Ehemalig: kein Bearbeiten, der Platzhalter des Griffs am Ende.
  const former = family.memberHtml(member(3, 'Alt', { deactivated_at: '2026-01-01T00:00:00Z' }), 1, { orderable: false, aligned: true });
  assert.deepEqual(endzone(former), ['more']);
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
