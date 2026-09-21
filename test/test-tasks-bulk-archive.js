/**
 * Test: Sammel-Ablage im Client (#1250)
 *
 * Die Mehrfachauswahl der Liste legte ab, indem sie je Aufgabe einen
 * PATCH /tasks/:id/archive absetzte. Eine gesperrte Aufgabe oder das
 * Ratenlimit brach die Schleife ab, und neu geladen wurde danach nicht - der
 * Rest war aber schon abgelegt, die Liste zeigte ihn trotzdem weiter.
 *
 * Gemessen wird deshalb, WIE OFT und WOHIN der Client fragt: einmal
 * POST /tasks/archive mit allen IDs, kein PATCH je Aufgabe, und neu geladen
 * wird auch nach einem Fehler. Dazu der Kopf der Erledigt-Spalte, der genau die
 * gezeigten erledigten Karten schickt und vorher fragt.
 *
 * Ausfuehren: npm run test:tasks-bulk-archive
 */
import test from 'node:test';
import assert from 'node:assert/strict';

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
const toasts = [];
globalThis.window = globalThis.window ?? {};
globalThis.window.yuvomi = { showToast: (msg, type) => toasts.push({ msg, type }) };

const { __test: tasks } = await import('../public/pages/tasks.js');

/** Zeichnet jeden API-Aufruf auf; `post` antwortet mit `postAnswer`. */
function recordApi(postAnswer = (_path, body) => ({ data: { archived: body.ids.length, skipped: 0 } })) {
  const calls = [];
  globalThis.__apiStub = {
    get:    async (path) => { calls.push(['get', path]); return { data: [] }; },
    post:   async (path, body) => { calls.push(['post', path, body]); return postAnswer(path, body); },
    patch:  async (path, body) => { calls.push(['patch', path, body]); return { data: null }; },
    put:    async (path, body) => { calls.push(['put', path, body]); return { data: null }; },
    delete: async (path) => { calls.push(['delete', path]); return { data: null }; },
  };
  return calls;
}

/** Ein Container mit nichts als der Sammelaktionsleiste. */
function fakeContainer() {
  let onClick = null;
  const bar = {
    hidden: true,
    classList: { toggle() {} },
    querySelectorAll: () => [],
    addEventListener: (type, fn) => { if (type === 'click') onClick = fn; },
  };
  return {
    container: { querySelector: (sel) => (sel === '#bulk-actions-bar' ? bar : null) },
    click: (id) => onClick({ target: { closest: (sel) => (sel === 'button[id^="bulk-"]' ? { id, dataset: {} } : null) } }),
  };
}

function select(ids) {
  tasks.state.viewMode = 'list';
  tasks.state.selectedTaskIds.clear();
  ids.forEach((id) => tasks.state.selectedTaskIds.add(id));
}

test.afterEach(() => {
  delete globalThis.__apiStub;
  delete globalThis.__confirmModal;
  toasts.length = 0;
  tasks.state.tasks = [];
  tasks.state.searchQuery = '';
  tasks.state.selectedTaskIds.clear();
});

test('Mehrfachauswahl: ein POST /tasks/archive fuer alle, kein PATCH je Aufgabe', async () => {
  const calls = recordApi();
  const { container, click } = fakeContainer();
  tasks.wireBulkActions(container);
  select([11, 12, 13]);

  await click('bulk-archive');

  const writes = calls.filter(([m]) => m !== 'get');
  assert.deepEqual(writes, [['post', '/tasks/archive', { ids: [11, 12, 13] }]]);
  assert.ok(calls.some(([m, p]) => m === 'get' && p.startsWith('/tasks')), 'danach wird neu geladen');
  assert.equal(tasks.state.selectedTaskIds.size, 0, 'die Auswahl ist danach leer');
  assert.deepEqual(toasts, [{ msg: 'tasks.bulkArchived', type: 'success' }]);
});

test('Mehrfachauswahl: uebersprungene gesperrte Aufgaben stehen im Toast', async () => {
  recordApi(() => ({ data: { archived: 1, skipped: 2 } }));
  const { container, click } = fakeContainer();
  tasks.wireBulkActions(container);
  select([21, 22, 23]);

  await click('bulk-archive');

  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].type, 'success');
  assert.match(toasts[0].msg, /tasks\.tagsSkippedLocked\{"count":2\}/);
});

test('Mehrfachauswahl: nach einem Fehler wird trotzdem neu geladen', async () => {
  const calls = recordApi(() => { throw new Error('Too many requests'); });
  const { container, click } = fakeContainer();
  tasks.wireBulkActions(container);
  select([31, 32]);

  await click('bulk-archive');

  assert.deepEqual(toasts, [{ msg: 'Too many requests', type: 'danger' }]);
  assert.ok(calls.some(([m]) => m === 'get'), 'die Liste darf nicht stehen bleiben, was schon abgelegt ist');
});

test('Mehrfachauswahl: mehr als 500 geht in Teilen zu je hoechstens 500', async () => {
  const calls = recordApi();
  const { container, click } = fakeContainer();
  tasks.wireBulkActions(container);
  const ids = Array.from({ length: 501 }, (_, i) => i + 1);
  select(ids);

  await click('bulk-archive');

  const posts = calls.filter(([m]) => m === 'post');
  assert.equal(posts.length, 2);
  assert.deepEqual(posts.map(([, , body]) => body.ids.length), [500, 1]);
  assert.deepEqual(posts.flatMap(([, , body]) => body.ids), ids);
});

test('Erledigt-Spalte: schickt genau die gezeigten erledigten Karten, nach der Rueckfrage', async () => {
  const calls = recordApi();
  const asked = [];
  globalThis.__confirmModal = async (msg) => { asked.push(msg); return true; };
  tasks.state.viewMode = 'kanban';
  tasks.state.tasks = [
    { id: 1, title: 'Muell', status: 'done', archived_at: null },
    { id: 2, title: 'Abwasch', status: 'done', archived_at: null },
    { id: 3, title: 'Muell rausbringen', status: 'open', archived_at: null },
    { id: 4, title: 'Muell alt', status: 'done', archived_at: '2026-01-01T00:00:00Z' },
  ];
  tasks.state.searchQuery = 'muell';

  await tasks.archiveDoneColumn({ querySelector: () => null });

  assert.deepEqual(asked, ['tasks.kanbanArchiveDoneConfirm']);
  // Nur die erledigte Karte, die die Suche uebrig laesst - nicht die offene,
  // nicht die schon abgelegte, nicht die weggefilterte.
  assert.deepEqual(calls.filter(([m]) => m !== 'get'), [['post', '/tasks/archive', { ids: [1] }]]);
});

test('Erledigt-Spalte: abgebrochene Rueckfrage schickt nichts', async () => {
  const calls = recordApi();
  globalThis.__confirmModal = async () => false;
  tasks.state.tasks = [{ id: 5, title: 'X', status: 'done', archived_at: null }];

  await tasks.archiveDoneColumn({ querySelector: () => null });

  assert.deepEqual(calls, []);
});

test('Erledigt-Spalte: der Knopf steht nur am Kopf einer nicht leeren Erledigt-Spalte', () => {
  const cols = tasks.KANBAN_COLS();
  const grouped = Object.fromEntries(cols.map((c) => [c.status, [{ id: c.status.length, title: c.status, status: c.status, subtasks: [] }]]));
  const html = tasks.kanbanBoardHtml(cols, grouped);
  assert.equal(html.match(/data-kanban-archive-done/g)?.length, 1);
  const doneCol = html.slice(html.indexOf('data-status="done"'), html.indexOf('data-status="archived"'));
  assert.match(doneCol, /data-kanban-archive-done/);

  // Gegenfall: leere Erledigt-Spalte, kein Knopf ohne Gegenstand.
  const empty = tasks.kanbanBoardHtml(cols, { ...grouped, done: [] });
  assert.doesNotMatch(empty, /data-kanban-archive-done/);
});
