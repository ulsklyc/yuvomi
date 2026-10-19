/**
 * Tests: die Fehler der Aufgaben-Seite (#1909)
 * Module: server/routes/tasks.js; public/pages/tasks.js
 *
 * Die Seite zeigte bei jedem gescheiterten Schreibweg `err.message` - den Text
 * des Servers ("Task not found.") oder den des Browsers, in jeder Sprache der
 * App derselbe. Jetzt nennt der Server den Fall (`reason`), und die Seite sagt
 * den Satz der App. Eine Aufgabe, die es nicht mehr gibt (geloescht oder privat
 * gestellt), laedt die Liste frisch; das Loeschen einer schon geloeschten
 * Aufgabe ist ein Erfolg, und das Bearbeiten-Formular geht dann zu.
 *
 * Gefahren wird auf beiden Seiten der ECHTE Code:
 * - Server: der echte Router ueber einer migrierten In-Memory-DB.
 * - Seite: die echten Handler bis in ihr catch, ueber den api-Stub des Loaders
 *   (`__apiStub`), den Modal-Stub (`__closeModal`) und den Ruecknahme-Stub
 *   (`__undoStub`).
 *
 * Ausfuehren: npm run test:tasks-errors
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'tasks-errors-test-secret';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
globalThis.localStorage = globalThis.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
const { installMiniDom } = await import('./mini-dom.js');
installMiniDom();
globalThis.document.documentElement.classList = { toggle() {}, add() {}, remove() {}, contains: () => false };
globalThis.CSS = globalThis.CSS ?? { escape: (v) => String(v) };
const toasts = [];
globalThis.window.yuvomi = {
  ...globalThis.window.yuvomi,
  showToast: (text, kind, _duration, onUndo = null) => { toasts.push([text, kind, onUndo]); },
};
Object.defineProperty(globalThis, 'navigator', { value: { ...globalThis.navigator, onLine: true }, configurable: true, writable: true });

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const { setPermissions } = await import('../public/permissions.js');
const { __test: tasks } = await import('../public/pages/tasks.js');
const { CASE_MESSAGES, GONE_REASONS } = await import('../public/utils/friendly-error.js');

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function buildTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
  for (const m of MIGRATIONS) {
    if (typeof m.up === 'function') m.up(db); else db.exec(m.up);
    if (typeof m.afterUp === 'function') m.afterUp(db);
    db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(m.version, m.description);
  }
  return db;
}

const moduleDb = get();
const db = buildTestDb();
_setTestDatabase(db);
moduleDb.close();
test.after(() => db.close());
const admin = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('ada', 'Ada', '$2b$12$x', 'admin')`).run().lastInsertRowid;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => {
  req.authUserId = admin;
  req.authRole = 'admin';
  req.session = { userId: admin, role: 'admin' };
  next();
});
app.use('/api/v1/tasks', tasksRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
test.after(() => new Promise((r) => server.close(r)));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const GONE = 999999;

test('Server: eine Aufgabe, die es nicht mehr gibt - jeder Weg nennt tasks_task_not_found, englisch', async () => {
  for (const [method, path, body] of [
    ['GET', `/tasks/${GONE}`, null],
    ['PUT', `/tasks/${GONE}`, { title: 'x' }],
    ['DELETE', `/tasks/${GONE}`, null],
    ['PATCH', `/tasks/${GONE}/status`, { status: 'done' }],
    ['PATCH', `/tasks/${GONE}/archive`, { archived: true }],
    ['PATCH', `/tasks/${GONE}/check`, { line: 0, checked: true }],
    ['GET', `/tasks/${GONE}/completions`, null],
    ['GET', `/tasks/${GONE}/comments`, null],
    ['POST', `/tasks/${GONE}/comments`, { comment: 'x' }],
    ['PATCH', '/tasks/reorder', { order: [GONE] }],
    ['POST', '/tasks/reorder/reset', { ids: [GONE] }],
  ]) {
    const r = await call(method, path, body);
    const label = `${method} ${path}: ${JSON.stringify(r.body)}`;
    // Der Status bleibt, wie er war.
    assert.equal(r.status, 404, label);
    assert.equal(r.body?.reason, 'tasks_task_not_found', label);
    assert.equal(r.body?.error, 'Task not found.', label);
  }
});

test('Server: eine Aufgabe, die es gibt, bekommt keinen Grund untergeschoben', async () => {
  const created = await call('POST', '/tasks', { title: 'Blumen giessen' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const r = await call('GET', `/tasks/${created.body.data.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.reason, undefined);
});

test('der Grund hat seinen Satz und ist als "gibt es nicht mehr" bekannt', () => {
  assert.equal(CASE_MESSAGES.get('tasks_task_not_found'), 'tasks.errorTaskGone');
  assert.ok(GONE_REASONS.has('tasks_task_not_found'));
});

// ---------------------------------------------------------------------------
// Seite
// ---------------------------------------------------------------------------

setPermissions({ admin: true, modules: {}, widgets: {}, capabilities: {} });

const SERVER_TEXT = 'Server sentence.';
const fehler = (status, reason) => Object.assign(new Error(SERVER_TEXT), {
  name: 'ApiError', status,
  data: { error: SERVER_TEXT, code: status, ...(reason ? { reason } : {}) },
});
const GONE_ERR = () => fehler(404, 'tasks_task_not_found');

const messages = () => toasts.map(([text, kind]) => [text, kind]);
const assertNoServerText = () => {
  for (const [text] of toasts) assert.doesNotMatch(String(text), /Server sentence/, 'der Text des Servers im Toast');
};

const container = () => ({ querySelector: () => null, querySelectorAll: () => [], isConnected: true });

/** Mit einem api-Stub laufen lassen; `calls` schreibt jede Anfrage mit, `closed` jedes Schliessen. */
async function mit(antworten, lauf) {
  toasts.length = 0;
  const calls = [];
  const closed = [];
  const stub = {
    get: async (path) => { calls.push(['GET', path]); return antworten.get?.(path) ?? { data: [] }; },
    getWithSource: async (path) => { calls.push(['GET', path]); return { data: { data: [] }, fromCache: false }; },
  };
  for (const verb of ['post', 'put', 'patch', 'delete']) {
    stub[verb] = async (path, body) => {
      calls.push([verb.toUpperCase(), path]);
      if (!antworten[verb]) throw new Error(`kein Stub fuer ${verb} ${path}`);
      return antworten[verb](path, body);
    };
  }
  const zuvor = { api: globalThis.__apiStub, close: globalThis.__closeModal };
  globalThis.__apiStub = stub;
  globalThis.__closeModal = (opts) => { closed.push(opts ?? {}); return true; };
  try {
    await lauf();
    for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
  } finally {
    globalThis.__apiStub = zuvor.api;
    globalThis.__closeModal = zuvor.close;
  }
  return { calls, closed };
}

const reloaded = (calls) => calls.some(([verb, path]) => verb === 'GET' && /^\/tasks(\?|$)/.test(path));

const FAELLE = [
  [GONE_ERR(), 'tasks.errorTaskGone'],
  [fehler(403, 'task_locked'), 'tasks.errorLocked'],
  [fehler(400), 'common.errorGeneric'],
  [fehler(500), 'common.errorGeneric'],
];

test('Personenwahl: der Fall wird sein Satz, nie der Text des Servers', async () => {
  tasks.state.users = [{ id: 3, display_name: 'Mia' }];
  for (const [err, expected] of FAELLE) {
    const { calls } = await mit({ patch: async () => { throw err; } }, () => tasks.completeTaskFor(container(), 7, 3));
    assert.deepEqual(messages(), [[expected, 'danger']], `${err.status} ${err.data.reason ?? ''}`);
    assertNoServerText();
    assert.ok(reloaded(calls), 'die Liste kommt frisch');
  }
  tasks.state.users = [];
});

test('Rueckgaengig nach dem Abhaken: eine verschwundene Aufgabe sagt es und laedt die Liste, alles andere nur den Satz', async () => {
  for (const [err, expected] of FAELLE) {
    const { calls } = await mit({ patch: async () => { throw err; } }, async () => {
      tasks.acknowledgeStatusToggle(container(), 7, 'done', { data: { id: 7 } });
      const undo = toasts[0][2];
      toasts.length = 0;
      await undo();
    });
    const label = `${err.status} ${err.data.reason ?? ''}`;
    assert.deepEqual(messages(), [[expected, 'danger']], label);
    assertNoServerText();
    assert.equal(reloaded(calls), err.data.reason === 'tasks_task_not_found', `${label}: Liste frisch`);
  }
});

test('Brett: ein gescheiterter Spaltenwechsel sagt den Satz der App', async () => {
  tasks.state.viewMode = 'kanban';
  try {
    for (const [err, expected] of FAELLE) {
      await mit({ patch: async () => { throw err; } }, () => tasks.runColumnMove({ id: 7, status: 'open', archived_at: null }, 'done', container()));
      assert.deepEqual(messages(), [[expected, 'danger']], `${err.status}`);
      assertNoServerText();
    }
  } finally {
    tasks.state.viewMode = 'list';
  }
});

test('Reihenfolge zuruecksetzen: der Satz der App, und eine verschwundene Aufgabe laedt die Liste', async () => {
  const group = {
    dataset: { groupId: 'g' },
    querySelector: (sel) => (sel === '.row-carrier'
      ? { children: [], querySelectorAll: () => [{ dataset: { swipeId: '7' }, classList: { contains: () => false } }] }
      : null),
  };
  for (const [err, expected] of FAELLE) {
    const { calls } = await mit({ post: async () => { throw err; } }, () => tasks.resetTaskOrder(group, container()));
    if (!calls.some(([verb]) => verb === 'POST')) assert.fail('resetTaskOrder hat nicht gesendet - die Attrappe der Gruppe passt nicht mehr');
    const label = `${err.status} ${err.data.reason ?? ''}`;
    assert.deepEqual(messages(), [[expected, 'danger']], label);
    assertNoServerText();
    assert.equal(reloaded(calls), err.data.reason === 'tasks_task_not_found', `${label}: Liste frisch`);
  }
});

test('Mehrere loeschen: eine schon geloeschte Aufgabe zaehlt als geloescht; alles andere stellt zurueck und sagt den Satz', async () => {
  for (const [err, expectedToasts] of [
    [GONE_ERR(), []],
    [fehler(403, 'task_locked'), [['tasks.errorLocked', 'danger']]],
    [fehler(500), [['common.errorGeneric', 'danger']]],
  ]) {
    let opts = null;
    const deleted = [];
    await mit({
      delete: async (path) => {
        if (path === '/tasks/7') throw err;
        deleted.push(path);
        return null;
      },
    }, async () => {
      globalThis.__undoStub = (o) => { opts = o; };
      tasks.state.selectedTaskIds = new Set([7, 8]);
      try {
        await tasks.runBulkAction('delete', container());
      } finally {
        delete globalThis.__undoStub;
      }
      assert.ok(opts, 'kein Ruecknahme-Fenster');
      toasts.length = 0;
      try { await opts.commit({ keepalive: true }); } catch (e) { opts.restore(e); }
    });
    assert.deepEqual(messages(), expectedToasts, `${err.status} ${err.data.reason ?? ''}`);
    assertNoServerText();
    assert.deepEqual(deleted, ['/tasks/8']);
  }
});

// --- Formular ----------------------------------------------------------------

const feld = (value = '') => ({ value: String(value) });

async function saveInEditForm(err, taskId = '7') {
  let changed = 0;
  const nodes = {
    'task-form-error': { hidden: true, textContent: '' },
    'task-submit-btn': { disabled: false, textContent: '', classList: { add() {}, remove() {} } },
    'task-id': feld(taskId),
  };
  const realDocument = globalThis.document;
  const form = { querySelector: () => null };
  for (const [name, value] of Object.entries({
    title: 'Blumen giessen', description: '', priority: 'none', category: 'household',
    start_date: '', due_date: '2030-06-15', due_time: '', points: '0',
  })) form[name] = feld(value);
  globalThis.__rruleValues = { is_recurring: 0, valid_until: true };
  const result = await mit({
    put: async () => { throw err; },
    post: async () => { throw err; },
  }, async () => {
    globalThis.document = { getElementById: (id) => nodes[id] ?? null, documentElement: realDocument.documentElement, addEventListener() {} };
    try {
      await tasks.handleFormSubmit({ preventDefault() {}, target: form }, { container: null, onChanged: async () => { changed += 1; } });
    } finally {
      globalThis.document = realDocument;
      delete globalThis.__rruleValues;
    }
  });
  return { ...result, changed, errorLine: nodes['task-form-error'].hidden ? null : nodes['task-form-error'].textContent };
}

test('Formular: eine verschwundene Aufgabe schliesst das Formular und laedt die Liste; alles andere bleibt offen mit dem Satz der App', async () => {
  const gone = await saveInEditForm(GONE_ERR());
  assert.deepEqual(messages(), [['tasks.errorTaskGone', 'danger']]);
  assert.equal(gone.closed.length, 1, 'das Formular geht zu');
  assert.equal(gone.changed, 1, 'die Liste kommt frisch');
  assert.equal(gone.errorLine, null);

  for (const [err, expected] of [[fehler(403, 'task_locked'), 'tasks.errorLocked'], [fehler(400), 'common.errorGeneric']]) {
    const r = await saveInEditForm(err);
    assert.equal(r.errorLine, expected, `${err.status}`);
    assert.equal(r.closed.length, 0, `${err.status}: bleibt offen`);
    assert.equal(r.changed, 0);
    assertNoServerText();
  }
  // Beim Anlegen gibt es nichts, das verschwinden koennte: Fehlerzeile, offen.
  const created = await saveInEditForm(GONE_ERR(), '');
  assert.equal(created.closed.length, 0);
  assert.equal(created.errorLine, 'tasks.errorTaskGone');
});

// --- #1997: eine spaete Erfolgsantwort schliesst nur ihren EIGENEN Dialog -----

// Kommt die Antwort erst, nachdem der Nutzer den Dialog geschlossen und einen
// anderen geoeffnet hat, darf das force-Schliessen nur den eigenen treffen. Ob
// der Slot noch denselben Dialog haelt, entscheidet closeModal({ context }) in
// components/modal.js (am echten Modul gemessen in test-modal-dead-time.js);
// hier zaehlt die Verdrahtung: Speichern im Formular und Schlagwoerter der
// Mehrfachauswahl reichen den Kontext von VOR der Anfrage hinein. Gefahren
// wird je Weg der echte Handler; die schreibende Anfrage wechselt den Kontext.
test('#1997: Erfolg nach Dialogwechsel - Aufgabe speichern und Schlagwort setzen schliessen nur mit dem Kontext von VOR der Anfrage', async () => {
  const realDocument = globalThis.document;
  const formularAbsenden = (taskId) => async () => {
    const nodes = {
      'task-form-error': { hidden: true, textContent: '' },
      'task-submit-btn': { disabled: false, textContent: '', classList: { add() {}, remove() {} } },
      'task-id': feld(taskId),
    };
    const form = { querySelector: () => null };
    for (const [name, value] of Object.entries({
      title: 'Blumen giessen', description: '', priority: 'none', category: 'household',
      start_date: '', due_date: '2030-06-15', due_time: '', points: '0',
    })) form[name] = feld(value);
    globalThis.__rruleValues = { is_recurring: 0, valid_until: true };
    globalThis.document = { getElementById: (id) => nodes[id] ?? null, documentElement: realDocument.documentElement, addEventListener() {} };
    try {
      await tasks.handleFormSubmit({ preventDefault() {}, target: form }, { container: null, onChanged: async () => {} });
    } finally {
      globalThis.document = realDocument;
      delete globalThis.__rruleValues;
    }
  };
  const schlagwort = async () => {
    let opts = null;
    globalThis.__openModal = (o) => { opts = o; };
    try { tasks.openBulkTagDialog([7, 8], 'add', container()); } finally { delete globalThis.__openModal; }
    assert.ok(opts, 'der Dialog wurde geoeffnet');
    const handlers = {};
    const form = { elements: { tag: feld('garten') }, addEventListener(type, fn) { handlers[type] = fn; } };
    opts.onSave({ querySelector: (sel) => (sel === '#bulk-tag-form' ? form : null), querySelectorAll: () => [] });
    await handlers.submit({ preventDefault() {} });
  };
  const WEGE = [
    ['Aufgabe aendern', formularAbsenden('7')],
    ['Aufgabe anlegen', formularAbsenden('')],
    ['Schlagwort setzen (Mehrfachauswahl)', schlagwort],
  ];
  for (const [name, lauf] of WEGE) {
    let kontext = 'eigener-dialog';
    const geschrieben = [];
    const schreibe = (verb) => (path) => {
      geschrieben.push(`${verb} ${path}`);
      kontext = 'ein-anderer-dialog';
      return { data: { id: 7, title: 'Blumen giessen', tags: [], updated: 2, skipped: 0 } };
    };
    globalThis.__modalContextId = () => kontext;
    try {
      const { closed } = await mit({ post: schreibe('POST'), put: schreibe('PUT') }, lauf);
      assert.equal(geschrieben.length, 1, `${name}: der Weg schreibt (${JSON.stringify(geschrieben)})`);
      assert.equal(toasts.some(([, art]) => art === 'danger'), false, `${name}: der Erfolg ist kein Fehler (${JSON.stringify(messages())})`);
      assert.equal(closed.length, 1, `${name}: genau ein Schliessen (${JSON.stringify(closed)})`);
      assert.equal(closed[0].force, true, `${name}: force wie bisher`);
      assert.equal(closed[0].context, 'eigener-dialog',
        `${name}: geschlossen wird ohne den Kontext von vor der Anfrage - die spaete Antwort traefe den Dialog, der jetzt offen ist`);
    } finally {
      delete globalThis.__modalContextId;
    }
  }
});
