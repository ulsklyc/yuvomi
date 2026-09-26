/**
 * Test: Aufgaben in Liste + Detail (Breitenregel, DESIGN.md; utils/master-detail.js)
 *
 * Zweck: Ab der Schwelle steht rechts neben der Aufgabenliste das Detail der
 *        ausgewaehlten Aufgabe. Zwei Zusagen haengen daran, die kein Textguard
 *        sieht, weil sie Verhalten sind:
 *
 *   1. DIE ANSICHT IN DER SPALTE SCHLIESST NICHT WIE EIN MODAL. Ihre Aktionen
 *      (Erledigen, Starten, Ablegen) riefen `closeDetailView()` - das ist in
 *      der Spalte ein blindes `closeModal()` und schloesse ein fremdes, gerade
 *      offenes Modal. Sie muessen das `close` nehmen, das die Ansicht ihnen
 *      reicht (detail-view.js, openInPane).
 *   2. DIE AUSWAHL UEBERLEBT DAS NEUZEICHNEN DER LISTE. Abhaken, Filter, Suche
 *      zeichnen die Liste neu. Bleibt die Zeile, bleibt die Auswahl; hat sich
 *      die Aufgabe geaendert, malt das Detail neu - ausser die Aenderung kam
 *      aus dem Detail selbst. Verlaesst die Zeile die Ansicht, rueckt die
 *      Auswahl auf die Nachbarin (erst darunter, dann darueber), sonst
 *      Leerzustand.
 *
 * Ausfuehren: npm run test:tasks-split
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installMiniDom } from './mini-dom.js';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
};
installMiniDom();
globalThis.document.documentElement.classList = {
  toggle() {}, add() {}, remove() {}, contains() { return false; },
};
globalThis.CSS = globalThis.CSS ?? { escape: (v) => String(v) };
globalThis.window = globalThis.window ?? {};
globalThis.window.yuvomi = { showToast() {} };

const { openTaskDetail } = await import('../public/components/task-detail.js');
const { __test: tasks } = await import('../public/pages/tasks.js');

// ── 1. Die Ansicht in der Spalte ──────────────────────────────────────────

const BASIS = { id: 7, title: 'Tisch decken', visibility: 'all', created_by: 2, subtasks: [] };

function openInPane(extra = {}) {
  let gesehen = null;
  globalThis.__openDetailView = (options) => { gesehen = options; };
  const pane = { isPane: true };
  const onClose = () => {};
  const standalone = () => {};
  try {
    openTaskDetail({
      task: { ...BASIS, status: 'open' },
      currentUserId: 2,
      categories: [{ key: 'household' }],
      pane,
      onClose,
      edit: { mount() {}, standalone },
      ...extra,
    });
  } finally {
    delete globalThis.__openDetailView;
  }
  assert.ok(gesehen, 'die Leseansicht wurde gar nicht geoeffnet');
  return { options: gesehen, pane, onClose, standalone };
}

test('die Leseansicht reicht Spalte, Abmeldung und Bearbeiten-Weg an detail-view durch', () => {
  const { options, pane, onClose, standalone } = openInPane();
  assert.equal(options.pane, pane, 'ohne `pane` oeffnete sie ein Sheet ueber der Spalte');
  assert.equal(options.onClose, onClose, 'ohne `onClose` erfaehrt die Liste nicht, dass eine Aktion lief');
  assert.equal(options.edit?.standalone, standalone,
    'ohne `standalone` fehlt in der Spalte der Bearbeiten-Knopf (openInPane baut ihn nur damit)');
});

for (const [id, label] of [['task-detail-finish', 'Erledigen'], ['task-detail-start', 'Starten'], ['task-detail-archive', 'Ablegen']]) {
  test(`${label} in der Spalte schliesst ueber das gereichte close, nicht ueber closeDetailView`, async () => {
    globalThis.__apiStub = { patch: async () => ({ data: null }) };
    let geaendert = 0;
    const { options } = openInPane({ onChanged: () => { geaendert += 1; } });
    const action = options.actions.find((a) => a.id === id);
    assert.ok(action, `${id} fehlt`);
    const closes = [];
    const button = { id, disabled: false, classList: { add() {}, remove() {} } };
    try {
      await action.onClick({ button, close: (opts) => { closes.push(opts); return Promise.resolve(); } });
    } finally {
      delete globalThis.__apiStub;
    }
    assert.equal(closes.length, 1, 'das close der Ansicht muss laufen - closeDetailView schloesse ein fremdes Modal');
    assert.deepEqual(closes[0], { force: true }, 'ohne Verwerfen-Frage: der Status steht schon beim Server');
    assert.equal(geaendert, 1, 'und danach zieht die Umgebung nach');
  });
}

// ── 2. Die Auswahl ueber das Neuzeichnen ──────────────────────────────────

/** Eine Liste mit Zeilen in Dokumentreihenfolge; `hidden` = nicht zu sehen. */
function listOf(ids, { hidden = [] } = {}) {
  const rows = ids.map((id) => ({
    dataset: { mdId: String(id) },
    hidden: false,
    getClientRects: () => (hidden.includes(id) ? [] : [{}]),
  }));
  return {
    querySelectorAll: (sel) => { assert.equal(sel, '[data-md-id]'); return rows; },
    querySelector: (sel) => {
      const m = sel.match(/^\[data-md-id="([^"]+)"\]$/);
      assert.ok(m, `Stub kennt den Selektor nicht: ${sel}`);
      return rows.find((row) => row.dataset.mdId === m[1]) ?? null;
    },
  };
}

/** Der Baustein als Protokoll: was die Seite mit ihm tut. */
function fakeMd(selected, { split = true } = {}) {
  const calls = [];
  const md = {
    selectedId: () => selected,
    isSplit: () => split,
    refresh: (opts = {}) => calls.push(['refresh', opts]),
    select: (id, opts = {}) => { selected = String(id); calls.push(['select', String(id), opts]); },
    clear: (opts = {}) => { selected = null; calls.push(['clear', opts]); },
  };
  return { md, calls };
}

function withTasks(list, fn) {
  const before = tasks.state.tasks;
  const query = tasks.state.searchQuery;
  tasks.state.tasks = list;
  tasks.state.searchQuery = '';
  try { return fn(); } finally {
    tasks.state.tasks = before;
    tasks.state.searchQuery = query;
    tasks.useTaskMd(null);
  }
}

const T = (id, over = {}) => ({ id, title: `T${id}`, status: 'open', ...over });

test('die Nachbarin ist erst die Zeile darunter, dann die darueber', () => {
  const order = ['1', '2', '3', '4'];
  assert.equal(tasks.neighborMdId(order, '2', new Set(['1', '3', '4'])), '3');
  assert.equal(tasks.neighborMdId(order, '4', new Set(['1', '2', '3'])), '3', 'am Ende: die darueber');
  assert.equal(tasks.neighborMdId(order, '2', new Set(['1', '4'])), '4', 'uebersprungen wird, was auch fehlt');
  assert.equal(tasks.neighborMdId(order, '2', new Set()), null, 'keine mehr: Leerzustand');
  assert.equal(tasks.neighborMdId(order, '9', new Set(['1'])), null, 'eine unbekannte Zeile hat keine Nachbarin');
});

test('bleibt die Zeile, bleibt die Auswahl - ohne Neumalen, solange sich nichts geaendert hat', () => {
  withTasks([T(1), T(2)], () => {
    const { md, calls } = fakeMd('2');
    tasks.useTaskMd(md);
    const list = listOf([1, 2]);
    tasks.syncPaneAfterRender(list, ['1', '2']); // erster Stand wird gemerkt
    calls.length = 0;
    tasks.syncPaneAfterRender(list, ['1', '2']);
    assert.deepEqual(calls, [['refresh', { repaint: false }]]);
  });
});

test('aendert sich die ausgewaehlte Aufgabe (Status aus der Liste), malt das Detail neu', () => {
  const data = [T(1), T(2)];
  withTasks(data, () => {
    const { md, calls } = fakeMd('2');
    tasks.useTaskMd(md);
    const list = listOf([1, 2]);
    tasks.syncPaneAfterRender(list, ['1', '2']);
    tasks.state.tasks = [T(1), T(2, { status: 'done' })];
    calls.length = 0;
    tasks.syncPaneAfterRender(list, ['1', '2']);
    assert.deepEqual(calls, [['refresh', { repaint: true }]],
      'die Zeile blieb, aber das Detail zeigte den alten Status');
  });
});

test('kam die Aenderung aus dem Detail selbst, malt es NICHT neu (Fokus bleibt im Knopf)', () => {
  withTasks([T(1), T(2)], () => {
    const { md, calls } = fakeMd('2');
    tasks.useTaskMd(md);
    const list = listOf([1, 2]);
    tasks.syncPaneAfterRender(list, ['1', '2']);
    tasks.state.tasks = [T(1), T(2, { subtask_done: 1 })];
    calls.length = 0;
    tasks.syncPaneAfterRender(list, ['1', '2'], { quiet: true });
    assert.deepEqual(calls, [['refresh', { repaint: false }]]);
  });
});

test('nach einer Aktion der Spalte (Status, Ablage) malt das Detail neu, auch ohne Datenaenderung', () => {
  withTasks([T(1), T(2)], () => {
    const { md, calls } = fakeMd('2');
    tasks.useTaskMd(md);
    const list = listOf([1, 2]);
    tasks.syncPaneAfterRender(list, ['1', '2']);
    tasks.onPaneActionClosed({ querySelector: () => null });
    calls.length = 0;
    tasks.syncPaneAfterRender(list, ['1', '2'], { quiet: true });
    assert.deepEqual(calls, [['refresh', { repaint: true }]]);
  });
});

test('verlaesst die Zeile die Ansicht, rueckt die Auswahl auf die Nachbarin darunter', () => {
  withTasks([T(1), T(3)], () => {
    const { md, calls } = fakeMd('2');
    tasks.useTaskMd(md);
    tasks.syncPaneAfterRender(listOf([1, 3]), ['1', '2', '3']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'select', `erwartet Weiterruecken, war ${JSON.stringify(calls)}`);
    assert.equal(calls[0][1], '3');
    assert.equal(calls[0][2].history, 'replace', 'das Weiterruecken ist keine Navigation - kein neuer Eintrag');
  });
});

test('die letzte Zeile geht: Auswahl auf die darueber', () => {
  withTasks([T(1), T(2)], () => {
    const { md, calls } = fakeMd('3');
    tasks.useTaskMd(md);
    tasks.syncPaneAfterRender(listOf([1, 2]), ['1', '2', '3']);
    assert.deepEqual(calls.map((c) => c.slice(0, 2)), [['select', '2']]);
  });
});

test('geht die einzige Zeile, steht der Leerzustand', () => {
  withTasks([], () => {
    const { md, calls } = fakeMd('1');
    tasks.useTaskMd(md);
    tasks.syncPaneAfterRender(listOf([]), ['1']);
    assert.deepEqual(calls, [['clear', { history: 'replace' }]]);
  });
});

test('ist die Aufgabe noch da, nur nicht gezeichnet (Gruppe zu), bleibt die Auswahl stehen', () => {
  withTasks([T(1), T(2)], () => {
    const { md, calls } = fakeMd('2');
    tasks.useTaskMd(md);
    tasks.syncPaneAfterRender(listOf([1]), ['1', '2']);
    assert.deepEqual(calls, [], 'Zuklappen ist kein Verlassen der Ansicht');
  });
});

test('ohne Auswahl raeumt das Neuzeichnen nur die Markierung auf', () => {
  withTasks([T(1)], () => {
    const { md, calls } = fakeMd(null);
    tasks.useTaskMd(md);
    tasks.syncPaneAfterRender(listOf([1]), ['1']);
    assert.deepEqual(calls, [['refresh', {}]]);
  });
});

// ── Das Blatt unter der Schwelle: erst laden, dann nur oeffnen, wenn es noch gilt ──

test('openTaskSheet oeffnet nach dem Laden nur, solange das Signal des Bausteins steht', async () => {
  // Zwei Anfragen, dann das Blatt. Ging der Nutzer dazwischen zurueck oder
  // wurde das Fenster breit (Detail in der Spalte), legte die Fortsetzung
  // trotzdem das alte Blatt darueber.
  const opened = [];
  let release;
  globalThis.__apiStub = {
    get: (path) => (String(path).startsWith('/tasks/')
      ? new Promise((resolve) => { release = () => resolve({ data: { ...BASIS, status: 'open' } }); })
      : Promise.resolve({ data: null })),
  };
  globalThis.__openDetailView = (options) => opened.push(options.title);
  try {
    const stale = new AbortController();
    const first = tasks.openTaskSheet('7', {}, stale.signal);
    stale.abort();
    release();
    await first;
    assert.deepEqual(opened, [], 'ueberholt: kein Blatt');

    const live = new AbortController();
    const second = tasks.openTaskSheet('7', {}, live.signal);
    release();
    await second;
    assert.deepEqual(opened, ['Tisch decken'], 'steht das Signal, geht das Blatt auf');
  } finally {
    delete globalThis.__apiStub;
    delete globalThis.__openDetailView;
  }
  // Der Aufrufer reicht das Signal des Bausteins durch.
  const src = readFileSync(new URL('../public/pages/tasks.js', import.meta.url), 'utf8');
  assert.match(src, /openNarrow: \(id, _trigger, \{ signal \}\) => openTaskSheet\(id, container, signal\)/,
    'mountTaskSplit gibt das Signal aus openNarrow an openTaskSheet weiter');
});

test('renderTaskPane: nur 404/403 heisst „gibt es nicht"; ein Netz- oder Serverfehler wirft', async () => {
  // Im Vertrag des Bausteins raeumt `false` Auswahl und `?open=` ab. Bei einem
  // 500 oder einer Zeitueberschreitung gibt es die Aufgabe aber noch - die
  // Spalte zeigt dann einen Fehler mit Erneut versuchen (master-detail.js).
  const failWith = (status) => {
    globalThis.__apiStub = { get: () => Promise.reject(Object.assign(new Error('x'), { status })) };
  };
  const body = { replaceChildren() {}, insertAdjacentHTML() {} };
  const signal = new AbortController().signal;
  try {
    failWith(404);
    assert.equal(await tasks.renderTaskPane('7', body, signal, {}), false, '404: weg');
    failWith(403);
    assert.equal(await tasks.renderTaskPane('7', body, signal, {}), false, '403: nicht sichtbar');
    failWith(500);
    await assert.rejects(tasks.renderTaskPane('7', body, signal, {}), (err) => err.status === 500,
      '500: voruebergehend - der Baustein haelt die Auswahl');
    globalThis.__apiStub = { get: () => Promise.reject(new TypeError('Failed to fetch')) };
    await assert.rejects(tasks.renderTaskPane('7', body, signal, {}), TypeError, 'offline: ebenso');
  } finally {
    delete globalThis.__apiStub;
  }
});
