/**
 * Modul: Aufgaben - Handordnung in der Liste (Oberflaeche)
 * Zweck: Was die Route nicht sieht: wann die Liste Griffe zeigt und wie die
 *        Kategorie-Gruppe sortiert.
 *
 *        Deckt ab:
 *          - sortTasksManual: Rang vor Standardordnung, Rangloses danach
 *          - canReorderTasks: nur Liste + Kategorie, nicht im Auswahlmodus,
 *            nicht bei `tasks: read`, nicht am Wandtablett
 *          - renderTaskCard: der Griff erscheint nur mit `reorderable`
 *          - der Griff traegt keine data-action (ein Klick darauf darf nichts
 *            ausloesen), die Wischgeste ignoriert ihn
 *          - die VERDRAHTUNG, gefahren gegen eine Fake-Liste: ein Pfeil am Griff
 *            ordnet die Zeilen um und sendet PATCH /tasks/reorder mit der neuen
 *            ID-Reihenfolge; ohne Berechtigung haengt gar kein Sortable dran
 *          - das Zuruecksetzen einer Gruppe sendet POST /tasks/reorder/reset
 * Ausfuehren: npm run test:tasks-reorder-ui
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
};
globalThis.document = globalThis.document ?? {
  documentElement: { classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } } },
};

const { __test: tasks } = await import('../public/pages/tasks.js');
const { setPermissions, clearPermissions } = await import('../public/permissions.js');

const task = (over = {}) => ({
  id: 1, title: 'X', status: 'open', category: 'household', priority: 'none',
  due_date: null, visibility: 'all', subtasks: [], ...over,
});
const NOW = new Date('2030-01-01T12:00:00Z');
const ids = (list) => list.map((t) => t.id);

test('sortTasksManual: eingeordnete Aufgaben nach Rang, ohne Ruecksicht auf Faelligkeit', () => {
  const frueh = task({ id: 1, sort_order: 2, due_date: '2030-01-02' });
  const spaet = task({ id: 2, sort_order: 1, due_date: '2030-06-01' });
  assert.deepEqual(ids([frueh, spaet].sort((a, b) => tasks.sortTasksManual(a, b, NOW))), [2, 1]);
});

test('sortTasksManual: Rangloses steht hinter allem Eingeordneten', () => {
  const dringend = task({ id: 1, sort_order: null, priority: 'urgent', due_date: '2030-01-02' });
  const ranked = task({ id: 2, sort_order: 5 });
  const sorted = [dringend, ranked].sort((a, b) => tasks.sortTasksManual(a, b, NOW));
  assert.deepEqual(ids(sorted), [2, 1], 'auch eine dringende neue Aufgabe verschiebt die Handordnung nicht');
});

test('sortTasksManual: ohne jeden Rang gilt die bisherige Ordnung', () => {
  const a = task({ id: 1, priority: 'low', due_date: '2030-02-01' });
  const b = task({ id: 2, priority: 'high', due_date: '2030-01-05' });
  const manual = [a, b].sort((x, y) => tasks.sortTasksManual(x, y, NOW));
  const standard = [a, b].sort((x, y) => tasks.sortTasks(x, y, NOW));
  assert.deepEqual(ids(manual), ids(standard));
});

test('sortTasksManual: gleicher Rang faellt auf die bisherige Ordnung zurueck', () => {
  const a = task({ id: 1, sort_order: 3, priority: 'low' });
  const b = task({ id: 2, sort_order: 3, priority: 'urgent' });
  assert.deepEqual(ids([a, b].sort((x, y) => tasks.sortTasksManual(x, y, NOW))), [2, 1]);
});

function mitZustand(patch, fn) {
  const s = tasks.state;
  const vorher = { viewMode: s.viewMode, bulkSelectMode: s.bulkSelectMode, user: s.user };
  Object.assign(s, { viewMode: 'list', bulkSelectMode: false, user: { id: 2 } }, patch);
  try { return fn(); } finally { Object.assign(s, vorher); }
}

test('canReorderTasks: nur in der Liste, gruppiert nach Kategorie', () => {
  mitZustand({}, () => {
    assert.equal(tasks.canReorderTasks('category'), true);
    assert.equal(tasks.canReorderTasks('due'), false, 'nach Faelligkeit hat die Position keine Aussage');
  });
  mitZustand({ viewMode: 'kanban' }, () => assert.equal(tasks.canReorderTasks('category'), false));
  mitZustand({ viewMode: 'history' }, () => assert.equal(tasks.canReorderTasks('category'), false));
});

test('canReorderTasks: nicht im Auswahlmodus und nicht am Wandtablett', () => {
  mitZustand({ bulkSelectMode: true }, () => assert.equal(tasks.canReorderTasks('category'), false));
  mitZustand({ user: { id: 4, access_scope: 'display' } }, () => {
    assert.equal(tasks.canReorderTasks('category'), false);
  });
});

test('renderTaskCard: Griff nur mit reorderable, ohne data-action', () => {
  const mit = mitZustand({}, () => tasks.renderTaskCard(task(), { reorderable: true }));
  const ohne = mitZustand({}, () => tasks.renderTaskCard(task(), {}));
  assert.match(mit, /class="row-action list-row__drag"/, 'Gegenfall: der Griff wird gezeichnet');
  assert.ok(!ohne.includes('list-row__drag'), 'ohne reorderable kein Griff');
  const griff = mit.match(/<button[^>]*list-row__drag[^>]*>/)[0];
  assert.ok(!griff.includes('data-action'), 'ein Klick auf den Griff darf keine Listenaktion ausloesen');
  assert.match(griff, /aria-label=/, 'der Griff hat einen Namen');
});

test('tasks: read - keine Griffe, auch wenn alles andere stimmt', () => {
  // DER GEGENFALL ZUERST: mit Schreibrecht zeigt dieselbe Lage Griffe.
  mitZustand({}, () => assert.equal(tasks.canReorderTasks('category'), true));
  setPermissions({ admin: false, modules: { tasks: 'read' }, widgets: {}, capabilities: {} });
  try {
    mitZustand({}, () => {
      assert.equal(tasks.canReorderTasks('category'), false);
      const html = tasks.renderTaskCard(task(), { reorderable: tasks.canReorderTasks('category') });
      assert.ok(!html.includes('list-row__drag'), 'die Zeile traegt keinen Griff');
    });
  } finally {
    clearPermissions();
  }
});

test('die Wischgeste ignoriert den Griff', () => {
  // `wireSwipeGestures` baut die Optionen und gibt sie zurueck (siehe dort). Mit
  // einer Liste wird verdrahtet, der Griff steht in `ignore`: ein Zug daran ist
  // Umsortieren, kein Wisch. Gegenprobe: ohne Liste kommt gar nichts zurueck.
  assert.equal(tasks.wireSwipeGestures({ querySelector: () => null }), undefined);
  const liste = { querySelectorAll: () => [], querySelector: () => null, addEventListener() {} };
  const optionen = tasks.wireSwipeGestures({ querySelector: (sel) => (sel === '#task-list' ? liste : null) });
  assert.equal(optionen.ignore, '.list-row__drag');
});

// --------------------------------------------------------
// Verdrahtung gegen eine Fake-Liste
// --------------------------------------------------------

/** Eine Gruppe mit Zeilen, soviel DOM, wie moveTaskRow und die Sicherung anfassen. */
function fakeGroup(titles, groupId = 'household') {
  const handles = [];
  const rowsEl = {
    children: [],
    querySelectorAll: (sel) => (sel === ':scope > .swipe-row' ? [...rowsEl.children] : []),
    insertBefore(node, ref) {
      this.children.splice(this.children.indexOf(node), 1);
      this.children.splice(ref ? this.children.indexOf(ref) : this.children.length, 0, node);
    },
    closest: (sel) => (sel === '.task-group' ? group : null),
  };
  titles.forEach(([id, title]) => {
    const handle = { attrs: {}, focused: false, setAttribute(k, v) { this.attrs[k] = v; }, focus() { this.focused = true; } };
    handles.push(handle);
    const row = {
      dataset: { swipeId: String(id) },
      parentElement: rowsEl,
      get nextSibling() { return rowsEl.children[rowsEl.children.indexOf(this) + 1] ?? null; },
      querySelector: (sel) => (sel === '.list-row__drag' ? handle : sel === '.task-card__title' ? { textContent: title } : null),
    };
    rowsEl.children.push(row);
  });
  // Der Gruppenkopf nimmt den Knopf zum Zuruecksetzen auf, sobald der erste Zug gesichert ist.
  const title = {
    html: '',
    querySelector(sel) { return sel === '[data-group-reset]' && this.html ? {} : null; },
    insertAdjacentHTML(_pos, html) { this.html += html; },
  };
  const group = {
    dataset: { groupId },
    querySelector: (sel) => (sel === '.row-carrier' ? rowsEl
      : sel === '.list-group__toggle span' ? { textContent: 'Haushalt' }
      : sel === '.list-group__title' ? title : null),
  };
  return { group, rowsEl, handles, title };
}

/** Ein Container mit #task-list, der Gruppen und die zwei Listener kennt. */
function fakeContainer(groups) {
  const listeners = {};
  const live = { textContent: '' };
  const listEl = {
    dataset: {},
    querySelectorAll: (sel) => (sel === '.task-group' ? groups : []),
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  const container = {
    querySelector: (sel) => (sel === '#task-list' ? listEl : sel === '#tasks-reorder-announce' ? live : null),
    querySelectorAll: () => [],
  };
  return { container, listEl, listeners, live };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const idsOf = (rowsEl) => rowsEl.children.map((r) => Number(r.dataset.swipeId));

async function mitApi(fn) {
  const calls = [];
  globalThis.__apiStub = {
    patch: async (path, body) => { calls.push({ method: 'PATCH', path, body }); return { data: [] }; },
    post: async (path, body) => { calls.push({ method: 'POST', path, body }); return { data: [] }; },
    get: async () => ({ data: [] }),
  };
  try { return await fn(calls); } finally { delete globalThis.__apiStub; }
}

test('Pfeil am Griff: ordnet die Zeilen um und sendet PATCH /tasks/reorder mit der neuen Reihenfolge', async () => {
  await mitApi(async (calls) => {
    const { group, rowsEl, handles, title } = fakeGroup([[11, 'A'], [12, 'B'], [13, 'C']]);
    const { container, listEl, listeners, live } = fakeContainer([group]);
    globalThis.__sortableCalls = [];
    try {
      mitZustand({ groupMode: 'category' }, () => tasks.wireTaskReorder(container));
      await tick();
      assert.equal(globalThis.__sortableCalls.length, 1, 'ein Sortable je Gruppe');
      assert.equal(globalThis.__sortableCalls[0].el, rowsEl);
      assert.equal(globalThis.__sortableCalls[0].opts.handle, '.list-row__drag');
      assert.ok(typeof listeners.keydown === 'function', 'der Tastaturpfad ist eingehaengt');
      assert.equal(listEl.dataset.reorderWired, '1');
      assert.match(handles[0].attrs['aria-label'], /A/, 'der Griff traegt den Namen');

      // ArrowDown am Griff der ersten Zeile.
      let prevented = false;
      listeners.keydown({
        key: 'ArrowDown',
        preventDefault: () => { prevented = true; },
        target: { closest: (sel) => (sel === '.list-row__drag' ? { closest: () => rowsEl.children[0] } : null) },
      });
      await tick();

      assert.ok(prevented, 'die Taste wird dem Browser abgenommen');
      assert.deepEqual(idsOf(rowsEl), [12, 11, 13], 'die erste Zeile ist eine Stelle nach unten gerutscht');
      assert.equal(handles[0].focused, true, 'der Fokus bleibt am Griff');
      assert.deepEqual(calls, [{ method: 'PATCH', path: '/tasks/reorder', body: { order: [12, 11, 13] } }]);
      // Der Loader-Stub von t() liefert Schluessel und Parameter zurueck.
      assert.match(live.textContent, /"name":"A","position":2,"total":3/, 'die neue Position der bewegten Zeile wird angesagt');
      assert.match(title.html, /data-group-reset="household"/, 'mit dem ersten gesicherten Zug erscheint der Knopf zum Zuruecksetzen');
      // Ein zweiter Zug haengt keinen zweiten Knopf an.
      listeners.keydown({
        key: 'ArrowDown',
        preventDefault() {},
        target: { closest: (sel) => (sel === '.list-row__drag' ? { closest: () => rowsEl.children[1] } : null) },
      });
      await tick();
      assert.equal(title.html.match(/data-group-reset/g).length, 1, 'der Knopf steht nur einmal da');
    } finally {
      delete globalThis.__sortableCalls;
    }
  });
});

test('die Raenge im State kommen aus der Antwort des Servers, nicht aus der Position (Review an #1646)', async () => {
  // Der Server verteilt Raenge um und vergibt kein 1..n. Eine Gruppe, die nur
  // eine Teilmenge zeigt (Suche), hat deshalb Raenge wie 3 und 6 - mit `idx + 1`
  // im Client stimmte die Reihenfolge nach dem Loeschen des Filters nicht mehr.
  const calls = [];
  globalThis.__apiStub = {
    patch: async (path, body) => {
      calls.push({ path, body });
      return { data: body.order.map((id, i) => ({ id, sort_order: [3, 6][i] })) };
    },
    get: async () => ({ data: [] }),
  };
  const vorher = tasks.state.tasks;
  tasks.state.tasks = [task({ id: 11, sort_order: 3 }), task({ id: 12, sort_order: 6 })];
  try {
    const { group, rowsEl } = fakeGroup([[11, 'A'], [12, 'B']]);
    const { container, listeners } = fakeContainer([group]);
    mitZustand({ groupMode: 'category' }, () => tasks.wireTaskReorder(container));
    listeners.keydown({
      key: 'ArrowDown',
      preventDefault() {},
      target: { closest: (sel) => (sel === '.list-row__drag' ? { closest: () => rowsEl.children[0] } : null) },
    });
    await tick();
    assert.deepEqual(calls[0].body, { order: [12, 11] });
    const rank = (id) => tasks.state.tasks.find((t) => t.id === id).sort_order;
    assert.equal(rank(12), 3, 'der Rang steht, wie der Server ihn vergeben hat');
    assert.equal(rank(11), 6);
    assert.ok(![1, 2].includes(rank(11)) && ![1, 2].includes(rank(12)), 'nicht 1..n');
  } finally {
    tasks.state.tasks = vorher;
    delete globalThis.__apiStub;
  }
});

test('Pfeil an der Kante bewegt nichts und sendet nichts', async () => {
  await mitApi(async (calls) => {
    const { group, rowsEl } = fakeGroup([[1, 'A'], [2, 'B']]);
    const { container, listeners } = fakeContainer([group]);
    mitZustand({ groupMode: 'category' }, () => tasks.wireTaskReorder(container));
    listeners.keydown({
      key: 'ArrowUp',
      preventDefault() {},
      target: { closest: (sel) => (sel === '.list-row__drag' ? { closest: () => rowsEl.children[0] } : null) },
    });
    await tick();
    assert.deepEqual(idsOf(rowsEl), [1, 2]);
    assert.deepEqual(calls, []);
  });
});

test('ohne Berechtigung haengt gar kein Sortable und kein Tastaturpfad dran', async () => {
  const zaehle = async (patch) => {
    const { group } = fakeGroup([[1, 'A'], [2, 'B']]);
    const { container, listeners } = fakeContainer([group]);
    globalThis.__sortableCalls = [];
    try {
      mitZustand(patch, () => tasks.wireTaskReorder(container));
      await tick();
      return { sortables: globalThis.__sortableCalls.length, keyboard: 'keydown' in listeners };
    } finally {
      delete globalThis.__sortableCalls;
    }
  };
  // Der Gegenfall zuerst: mit Recht ist beides da.
  assert.deepEqual(await zaehle({ groupMode: 'category' }), { sortables: 1, keyboard: true });
  assert.deepEqual(await zaehle({ groupMode: 'due' }), { sortables: 0, keyboard: false }, 'nach Faelligkeit');
  assert.deepEqual(await zaehle({ groupMode: 'category', bulkSelectMode: true }), { sortables: 0, keyboard: false }, 'im Auswahlmodus');
  assert.deepEqual(await zaehle({ groupMode: 'category', user: { id: 4, access_scope: 'display' } }), { sortables: 0, keyboard: false }, 'am Wandtablett');
  setPermissions({ admin: false, modules: { tasks: 'read' }, widgets: {}, capabilities: {} });
  try {
    assert.deepEqual(await zaehle({ groupMode: 'category' }), { sortables: 0, keyboard: false }, 'bei tasks: read');
  } finally {
    clearPermissions();
  }
});

test('Zuruecksetzen: sendet die IDs der Gruppe an POST /tasks/reorder/reset und laedt neu', async () => {
  const fehler = [];
  globalThis.window = { yuvomi: { showToast: (msg) => fehler.push(msg) } };
  try {
    await mitApi(async (calls) => {
      const { group } = fakeGroup([[21, 'A'], [22, 'B']]);
      // Ohne #task-list zeichnet renderTaskList nichts - es geht hier um die
      // Anfragen, nicht um das Markup.
      const live = { textContent: '' };
      const container = {
        querySelector: (sel) => (sel === '#tasks-reorder-announce' ? live : null),
        querySelectorAll: () => [],
      };
      await mitZustand({ groupMode: 'category' }, () => tasks.resetTaskOrder(group, container));
      assert.deepEqual(calls.filter((c) => c.method === 'POST'),
        [{ method: 'POST', path: '/tasks/reorder/reset', body: { ids: [21, 22] } }]);
      assert.deepEqual(fehler, [], 'kein Fehler-Toast');
      assert.match(live.textContent, /tasks\.resetOrderDone/, 'die Rueckmeldung wird angesagt');
    });
  } finally {
    delete globalThis.window;
  }
});

test('der Knopf "Automatisch sortieren" steht nur in einer Gruppe mit Handordnung', () => {
  const render = (tasksList, groupMode = 'category', patch = {}) => mitZustand({ groupMode, ...patch }, () =>
    tasks.renderTaskGroups(tasksList, groupMode));
  const ohne = render([task({ id: 1 }), task({ id: 2 })]);
  const mit = render([task({ id: 1, sort_order: 1 }), task({ id: 2 })]);
  assert.ok(!ohne.includes('data-group-reset'), 'ohne Rang kein Knopf');
  assert.match(mit, /data-group-reset="household"/, 'mit Rang steht er am Gruppenkopf');
  assert.ok(!render([task({ id: 1, sort_order: 1 })], 'due').includes('data-group-reset'), 'nach Faelligkeit nie');
  assert.ok(!render([task({ id: 1, sort_order: 1 })], 'category', { bulkSelectMode: true }).includes('data-group-reset'),
    'im Auswahlmodus nie');
});

test('Quelltext: der Griff ist vom Long-Press der Personenauswahl ausgenommen', () => {
  const src = readFileSync(new URL('../public/pages/tasks.js', import.meta.url), 'utf8');
  assert.match(src, /e\.target\.closest\?\.\('\.list-row__drag'\)\) return;\s*\n\s*const card = e\.target\.closest\?\.\('\.task-card'\)/,
    'pointerdown am Griff startet keinen Long-Press');
});
