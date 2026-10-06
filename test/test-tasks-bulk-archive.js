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
/**
 * Gerade genug DOM fuer die Sammelaktions-Pille (utils/bulk-pill.js): sie baut
 * ihre Knoten per createElement und haengt sie per replaceChildren in die
 * Schicht. Die Schicht merkt sich, was zuletzt darin stand - daran liest der
 * Test ab, welche Kapseln die Aufgaben anbieten.
 */
class FakeEl {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.classList = new Set(); this.listeners = {}; this.textContent = ''; }
  set className(v) { this.classList = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classList].join(' '); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  contains() { return false; }
}
const pillLayer = {
  bar: null,
  replaceChildren(...nodes) { this.bar = nodes[0] ?? null; },
  querySelector: () => null,
};
globalThis.document = {
  documentElement: { classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } } },
  activeElement: null,
  getElementById: (id) => (id === 'bulk-pill-layer' ? pillLayer : null),
  createElement: (tag) => new FakeEl(tag),
};
/** Die Kapseln der Pille, wie sie gerade steht: Beschriftung + Merkmale. */
function pillCapsules() {
  const bar = pillLayer.bar;
  if (!bar) return null;
  return bar.children
    .filter((c) => c.classList.has('list-bulkbar__action'))
    .map((c) => ({ label: c.textContent, danger: c.classList.has('list-bulkbar__action--danger'), aria: c.attrs['aria-label'] ?? null }));
}
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

/**
 * Seit D5 (Re-Critique 2026-09-27) laufen die Sammelaktionen ueber die Pille
 * der Shell: jede Kapsel ruft `runBulkAction(action, container)`. Gemessen wird
 * genau dieser Weg - der Container braucht dafuer nichts als `querySelector`.
 */
function fakeContainer() {
  return {
    container: { querySelector: () => null },
    click: (action) => tasks.runBulkAction(action, { querySelector: () => null }),
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
  const { click } = fakeContainer();
  select([11, 12, 13]);

  await click('archive');

  const writes = calls.filter(([m]) => m !== 'get');
  assert.deepEqual(writes, [['post', '/tasks/archive', { ids: [11, 12, 13] }]]);
  assert.ok(calls.some(([m, p]) => m === 'get' && p.startsWith('/tasks')), 'danach wird neu geladen');
  assert.equal(tasks.state.selectedTaskIds.size, 0, 'die Auswahl ist danach leer');
  assert.deepEqual(toasts, [{ msg: 'tasks.bulkArchived', type: 'success' }]);
});

test('Mehrfachauswahl: uebersprungene gesperrte Aufgaben stehen im Toast', async () => {
  recordApi(() => ({ data: { archived: 1, skipped: 2 } }));
  const { click } = fakeContainer();
  select([21, 22, 23]);

  await click('archive');

  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].type, 'success');
  assert.match(toasts[0].msg, /tasks\.tagsSkippedLocked\{"count":2\}/);
});

test('Mehrfachauswahl: nach einem Fehler wird trotzdem neu geladen', async () => {
  const calls = recordApi(() => { throw new Error('Too many requests'); });
  const { click } = fakeContainer();
  select([31, 32]);

  await click('archive');

  assert.deepEqual(toasts, [{ msg: 'Too many requests', type: 'danger' }]);
  assert.ok(calls.some(([m]) => m === 'get'), 'die Liste darf nicht stehen bleiben, was schon abgelegt ist');
});

test('Mehrfachauswahl: mehr als 500 geht in Teilen zu je hoechstens 500', async () => {
  const calls = recordApi();
  const { click } = fakeContainer();
  const ids = Array.from({ length: 501 }, (_, i) => i + 1);
  select(ids);

  await click('archive');

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

// ---------------------------------------------------------------------------
// D5 (Re-Critique 2026-09-27): Pille statt eigener Leiste, Auswahlkreis statt
// nativer Checkbox. Beide Faelle waren gegen den Stand davor rot: die Pille
// gab es in tasks.js nicht (`updateBulkActionsBar` schrieb in #bulk-actions-bar),
// und die Zeile trug `<input type="checkbox" class="task-bulk-checkbox">` VOR
// dem Statuskreis.
// ---------------------------------------------------------------------------

test('Pille: ausserhalb des Auswahlmodus leer, darin „Fertig" - und mit Auswahl Status und Loeschen', () => {
  tasks.state.viewMode = 'list';
  tasks.state.tasks = [
    { id: 1, title: 'A', status: 'open' },
    { id: 2, title: 'B', status: 'done' },
  ];
  const container = { querySelector: () => null };
  try {
    tasks.state.bulkSelectMode = false;
    pillLayer.bar = { stale: true };
    tasks.updateBulkActionsBar(container);
    assert.equal(pillLayer.bar, null, 'ohne Auswahlmodus raeumt die Pille ab');

    tasks.state.bulkSelectMode = true;
    tasks.updateBulkActionsBar(container);
    assert.deepEqual(pillCapsules().map((c) => c.label), ['tasks.bulkFinish'],
      'leere Auswahl: nur der Ausstieg, keine Kapsel ohne Gegenstand');

    tasks.state.selectedTaskIds.add(1);
    tasks.state.selectedTaskIds.add(2);
    tasks.updateBulkActionsBar(container);
    const caps = pillCapsules();
    assert.deepEqual(caps.map((c) => c.label), ['tasks.bulkMarkDone', 'tasks.bulkDelete', 'tasks.bulkFinish'],
      'drei Kapseln - Ablegen und Tags stehen waehrend der Auswahl im Werkzeugmenue');
    assert.deepEqual(caps.filter((c) => c.danger).map((c) => c.label), ['tasks.bulkDelete'],
      'nur Loeschen traegt die Gefahr - im Pillen-Stil, nicht als gefuellte rote Kapsel');
    // #1723: der Name des Knopfs ist eine AUSSAGE ("2 Aufgaben loeschen"). Bis
    // dahin trug er die Frage des Bestaetigungsschritts, ein Screenreader las
    // "2 Aufgaben loeschen?" vor, wo sichtbar "Loeschen" steht.
    assert.equal(caps[1].aria, 'tasks.bulkDeleteLabel{"count":2}', 'Loeschen nennt, wie viele - als Aussage');

    tasks.state.selectedTaskIds.delete(1);
    tasks.updateBulkActionsBar(container);
    assert.equal(pillCapsules()[0].label, 'tasks.bulkMarkOpen', 'nur Erledigtes gewaehlt: die Statuskapsel oeffnet wieder');
  } finally {
    tasks.state.bulkSelectMode = false;
    tasks.state.selectedTaskIds.clear();
    pillLayer.bar = null;
  }
});

// #1723: dass der Knopf einen eigenen Schluessel nimmt, hilft nur, wenn dessen
// Text in JEDER Sprache keine Frage ist. Gefahren wird das echte t() mit der
// echten Locale-Datei, nicht der Stub des Loaders - der gibt den Schluessel
// zurueck und saehe ein vergessenes Fragezeichen nie.
test('Sammel-Loeschen: der Knopfname ist in jeder Sprache eine Aussage, die Rueckfrage bleibt eine Frage (#1723)', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../public/locales/', import.meta.url);
  const dateien = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(dateien.length >= 26, `nur ${dateien.length} Locale-Dateien gelesen`);
  // ASCII, vollbreit, arabisch, spanisch eroeffnend, und das griechische
  // Fragezeichen (ein Semikolon, U+003B oder U+037E).
  const FRAGE = /[?？؟¿;;]/;
  for (const datei of dateien) {
    const locale = datei.replace(/\.json$/, '');
    const tasksKeys = JSON.parse(readFileSync(new URL(datei, dir), 'utf8')).tasks;
    const formen = (basis) => Object.keys(tasksKeys).filter((k) => k === basis || k.startsWith(`${basis}_`));
    const label = formen('bulkDeleteLabel');
    const ask = formen('bulkDeleteAsk');
    assert.ok(label.length >= 2, `${locale}: tasks.bulkDeleteLabel fehlt`);
    assert.deepEqual(label.map((k) => k.replace('bulkDeleteLabel', '')).sort(), ask.map((k) => k.replace('bulkDeleteAsk', '')).sort(),
      `${locale}: der Knopfname fuehrt dieselben Pluralformen wie die Rueckfrage`);
    for (const key of label) {
      assert.doesNotMatch(tasksKeys[key], FRAGE, `${locale}: tasks.${key} ist eine Frage: ${tasksKeys[key]}`);
      assert.notEqual(tasksKeys[key], tasksKeys[key.replace('bulkDeleteLabel', 'bulkDeleteAsk')], `${locale}: tasks.${key} gleicht der Rueckfrage`);
    }
    // Gegenprobe am Detektor: die Rueckfrage MUSS er als Frage erkennen, sonst
    // waere "keine Frage" oben fuer diese Sprache eine leere Aussage.
    for (const key of ask) {
      assert.match(tasksKeys[key], FRAGE, `${locale}: tasks.${key} sieht der Detektor nicht als Frage: ${tasksKeys[key]}`);
    }
  }
});

test('Auswahlkreis: ersetzt Statuskreis und Personenwahl, traegt den Titel im Namen, keine native Checkbox', () => {
  const task = { id: 7, title: 'Muell <raus>', status: 'open', priority: 'none', subtasks: [] };
  const normal = tasks.renderTaskCard(task);
  assert.match(normal, /task-status-btn/, 'Gegenprobe: ohne Auswahlmodus steht der Statuskreis');

  const selecting = tasks.renderTaskCard(task, { selecting: true, selected: false });
  assert.doesNotMatch(selecting, /type="checkbox"/, 'keine native Checkbox in der Zeile');
  assert.doesNotMatch(selecting, /task-status-btn|task-doer-btn/, 'der Auswahlkreis steht AN der Stelle, nicht daneben');
  assert.doesNotMatch(selecting, /data-action="(?:edit-task|archive-task|add-subtask)"/, 'Zeilenaktionen treten ab');
  const circle = selecting.match(/<button[^>]*class="select-circle[^"]*"[^>]*>/)?.[0] ?? '';
  assert.ok(circle, 'der Auswahlkreis ist ein Knopf');
  assert.match(circle, /aria-pressed="false"/);
  assert.match(circle, /aria-label="tasks\.selectTaskNamed\{&quot;title&quot;:&quot;Muell &lt;raus&gt;&quot;\}"/,
    'der Name nennt die Aufgabe - und maskiert sie');

  const on = tasks.renderTaskCard(task, { selecting: true, selected: true });
  assert.match(on, /class="select-circle task-select-btn select-circle--on"[^>]*aria-pressed="true"/);
});

test('Auswahlmodus: keine Wischgeste - ein Wisch hakt nicht ab und oeffnet nichts', () => {
  // Codex an #1483: die Karten stecken im Auswahlmodus weiter in
  // `renderSwipeRow()`, und `renderTaskList()` verdrahtete die Geste - ein
  // Wisch nach vorn hakte die Aufgabe ab, statt auszuwaehlen. Gemessen an den
  // verdrahteten Seiten UND an den Hoerern der Zeile: auch eine Geste ohne
  // Seite schoebe die Karte unter dem Finger weg.
  const hoerer = [];
  const zeile = {
    dataset: {}, classList: { add() {}, remove() {} },
    querySelector: () => ({ style: {} }),
    addEventListener: (type) => hoerer.push(type),
  };
  const liste = { querySelectorAll: (sel) => (sel === '.swipe-row' ? [zeile] : []), querySelector: () => null };
  const container = { querySelector: (sel) => (sel === '#task-list' ? liste : null) };
  const vorher = tasks.state.user;
  tasks.state.user = { id: 2 };
  try {
    const normal = tasks.wireSwipeGestures(container);
    assert.ok(normal.leading && normal.trailing, 'Gegenprobe: ausserhalb der Auswahl beide Seiten');
    assert.ok(hoerer.includes('touchend'), 'Gegenprobe: die Zeile ist verdrahtet');

    hoerer.length = 0;
    tasks.state.bulkSelectMode = true;
    const auswahl = tasks.wireSwipeGestures(container);
    assert.equal(auswahl.leading, null, 'kein Abhaken per Wisch in der Auswahl');
    assert.equal(auswahl.trailing, null, 'kein Oeffnen per Wisch in der Auswahl');
    assert.deepEqual(hoerer, [], 'die Zeile bekommt gar keine Beruehrungs-Hoerer');
  } finally {
    tasks.state.bulkSelectMode = false;
    tasks.state.user = vorher;
  }
});

test('Auswahlmodus: Teilaufgaben zeigen ihren Zustand, bieten aber nichts an - die Karte waehlt nur aus', () => {
  // Codex an #1483: der Auswahlkreis ersetzte nur den Statuskreis der
  // Elternaufgabe; Haken, Umbenennen, Loeschen und „Teilaufgabe hinzufuegen"
  // blieben bedienbar. ALLOWLIST statt Liste der verbotenen Aktionen: eine
  // kuenftige Teilaufgaben-Aktion faellt hier auf, ohne dass jemand sie
  // nachtraegt.
  const task = {
    id: 7, title: 'Muell', status: 'open', priority: 'none', subtask_total: 2, subtask_done: 1,
    subtasks: [
      { id: 8, title: 'Tonne', status: 'open', parent_task_id: 7 },
      { id: 9, title: 'Sack', status: 'done', parent_task_id: 7 },
    ],
  };
  const vorher = tasks.state.user;
  tasks.state.user = { id: 2 };
  try {
    const aktionen = (html) => new Set([...html.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]));
    const normal = aktionen(tasks.renderTaskCard(task));
    for (const a of ['toggle-subtask', 'rename-subtask', 'delete-subtask', 'add-subtask']) {
      assert.ok(normal.has(a), `Gegenprobe: ohne Auswahl bietet die Karte ${a} an`);
    }

    const html = tasks.renderTaskCard(task, { selecting: true });
    const ERLAUBT = new Set(['toggle-select', 'open-task', 'toggle-subtasks']);
    assert.deepEqual([...aktionen(html)].filter((a) => !ERLAUBT.has(a)), [],
      'in der Auswahl nur auswaehlen, oeffnen (waehlt dort aus) und auf-/zuklappen');
    assert.equal((html.match(/subtask-item__checkbox--static/g) ?? []).length, 2, 'der Zustand jeder Teilaufgabe bleibt als Zeichen');
    assert.match(html, /subtask-item__checkbox--done subtask-item__checkbox--static|subtask-item__checkbox--static[^"]*subtask-item__checkbox--done/,
      'die erledigte Teilaufgabe bleibt als erledigt erkennbar');
  } finally {
    tasks.state.user = vorher;
  }
});
