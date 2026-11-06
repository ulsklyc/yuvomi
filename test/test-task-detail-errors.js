/**
 * Tests: die Fehler der Aufgaben-Leseansicht (#1909)
 * Module: server/routes/tasks.js; public/components/task-detail.js
 *
 * Die Leseansicht zeigte bei jedem gescheiterten Schreibweg `err.message` oder
 * `err.data.error` - den Text des Servers ("Parent task not found.", "Comment
 * not found.") oder den des Browsers, in jeder Sprache der App derselbe. Jetzt
 * nennt der Server den Fall (`reason`), und die Ansicht sagt den Satz der App.
 * Eine Aufgabe, die es nicht mehr gibt, schliesst die Ansicht und laedt die
 * Umgebung; ein schon geloeschter Kommentar oder eine schon geloeschte Aufgabe
 * zaehlt beim Loeschen als geloescht.
 *
 * Gefahren wird auf beiden Seiten der ECHTE Code:
 * - Server: der echte Router ueber einer migrierten In-Memory-DB.
 * - Ansicht: die echten Funktionen bis in ihr catch, ueber den api-Stub des
 *   Loaders (`__apiStub`) und den Ruecknahme-Stub (`__undoStub`).
 *
 * Ausfuehren: npm run test:task-detail-errors
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'task-detail-errors-test-secret';

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
  showToast: (text, kind) => { toasts.push([text, kind]); },
};
Object.defineProperty(globalThis, 'navigator', { value: { ...globalThis.navigator, onLine: true }, configurable: true, writable: true });

// Die Mini-DOM merkt sich nur den Typ eines Listeners - hier auch den Handler,
// damit ein Klick und ein Absenden die echten Handler der Ansicht laufen lassen.
const Element = globalThis.document.createElement('div').constructor;
Element.prototype.addEventListener = function addEventListener(type, handler) {
  this.handlers = { ...(this.handlers ?? {}), [type]: handler };
};
Element.prototype.remove = function remove() { this.removed = true; };
Element.prototype.focus = Element.prototype.focus ?? function focus() {};

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const { setPermissions } = await import('../public/permissions.js');
const taskDetail = await import('../public/components/task-detail.js');
const { __test: detail } = taskDetail;
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
const ada = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('ada', 'Ada', '$2b$12$x', 'member')`).run().lastInsertRowid;
const bo = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('bo', 'Bo', '$2b$12$x', 'member')`).run().lastInsertRowid;

let actor = ada;
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => {
  req.authUserId = actor;
  req.authRole = 'member';
  req.session = { userId: actor, role: 'member' };
  next();
});
app.use('/api/v1/tasks', tasksRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
test.after(() => new Promise((r) => server.close(r)));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;

async function call(method, path, body, as = ada) {
  actor = as;
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const GONE = 999999;

test('Server: eine Teilaufgabe an einer Aufgabe, die es nicht mehr gibt, nennt tasks_parent_not_found', async () => {
  const r = await call('POST', '/tasks', { title: 'Schritt', parent_task_id: GONE });
  assert.equal(r.status, 404, JSON.stringify(r.body));
  assert.equal(r.body.reason, 'tasks_parent_not_found');
  assert.equal(r.body.error, 'Parent task not found.');
  // Eine private Aufgabe von jemand anderem ist fuer diese Person dasselbe.
  const hidden = await call('POST', '/tasks', { title: 'Privat', visibility: 'private' }, bo);
  assert.equal(hidden.status, 201, JSON.stringify(hidden.body));
  const r2 = await call('POST', '/tasks', { title: 'Schritt', parent_task_id: hidden.body.data.id });
  assert.equal(r2.status, 404);
  assert.equal(r2.body.reason, 'tasks_parent_not_found');
});

test('Server: Kommentar aendern und loeschen - Aufgabe weg, Kommentar weg, fremder Kommentar', async () => {
  const task = await call('POST', '/tasks', { title: 'Mit Kommentar' });
  const id = task.body.data.id;
  const mine = await call('POST', `/tasks/${id}/comments`, { comment: 'erster' });
  const theirs = await call('POST', `/tasks/${id}/comments`, { comment: 'zweiter' }, bo);
  assert.equal(mine.status, 201);
  for (const [method, body] of [['PATCH', { comment: 'neu' }], ['DELETE', null]]) {
    const taskGone = await call(method, `/tasks/${GONE}/comments/${mine.body.data.id}`, body);
    assert.deepEqual(taskGone, { status: 404, body: { error: 'Comment not found.', code: 404, reason: 'tasks_task_not_found' } }, method);
    const commentGone = await call(method, `/tasks/${id}/comments/${GONE}`, body);
    assert.deepEqual(commentGone, { status: 404, body: { error: 'Comment not found.', code: 404, reason: 'tasks_comment_not_found' } }, method);
    // Die Absage bleibt, wie sie war: 403 ohne Grund.
    const foreign = await call(method, `/tasks/${id}/comments/${theirs.body.data.id}`, body);
    assert.deepEqual(foreign, { status: 403, body: { error: 'Not authorized.', code: 403 } }, method);
  }
  const ok = await call('PATCH', `/tasks/${id}/comments/${mine.body.data.id}`, { comment: 'neu' });
  assert.equal(ok.status, 200);
});

test('die Gruende haben ihren Satz und sind als "gibt es nicht mehr" bekannt', () => {
  assert.equal(CASE_MESSAGES.get('tasks_parent_not_found'), 'tasks.errorParentGone');
  assert.equal(CASE_MESSAGES.get('tasks_comment_not_found'), 'tasks.errorCommentGone');
  assert.ok(GONE_REASONS.has('tasks_parent_not_found'));
  assert.ok(GONE_REASONS.has('tasks_comment_not_found'));
});

// ---------------------------------------------------------------------------
// Ansicht
// ---------------------------------------------------------------------------

setPermissions({ admin: false, modules: {}, widgets: {}, capabilities: {} });

const SERVER_TEXT = 'Server sentence.';
const fehler = (status, reason) => Object.assign(new Error(SERVER_TEXT), {
  name: 'ApiError', status,
  data: { error: SERVER_TEXT, code: status, ...(reason ? { reason } : {}) },
});
const messages = () => toasts.map(([text]) => text);
const assertNoServerText = () => {
  for (const [text] of toasts) assert.doesNotMatch(String(text), /Server sentence/, 'der Text des Servers im Toast');
};

async function mit(antworten, lauf) {
  toasts.length = 0;
  const calls = [];
  const stub = { get: async (path) => { calls.push(['GET', path]); return { data: [] }; } };
  for (const verb of ['post', 'put', 'patch', 'delete']) {
    stub[verb] = async (path, body) => {
      calls.push([verb.toUpperCase(), path]);
      if (!antworten[verb]) throw new Error(`kein Stub fuer ${verb} ${path}`);
      return antworten[verb](path, body);
    };
  }
  const zuvor = globalThis.__apiStub;
  globalThis.__apiStub = stub;
  try {
    await lauf();
    for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
  } finally {
    globalThis.__apiStub = zuvor;
  }
  return calls;
}

const TASK_GONE = () => fehler(404, 'tasks_task_not_found');
const FAELLE = [
  [TASK_GONE(), 'tasks.errorTaskGone'],
  [fehler(403, 'task_locked'), 'tasks.errorLocked'],
  [fehler(400), 'common.errorGeneric'],
  [fehler(500), 'common.errorGeneric'],
  [Object.assign(new TypeError('Failed to fetch'), { status: 0 }), 'common.errorOfflineMutation'],
];

/** Umgebung der Ansicht: zaehlt Nachladen und Schliessen. */
function umgebung() {
  const env = { changed: 0, closed: 0, stale: 0 };
  env.ctx = { onChanged: async () => { env.changed += 1; }, onStale: () => { env.stale += 1; }, inPane: true };
  env.close = async () => { env.closed += 1; };
  return env;
}

for (const [name, lauf] of [
  ['Erledigen', (env) => detail.advanceTaskStatus({ id: 7, status: 'open' }, 'done', {}, env.ctx, env.close)],
  ['Personenwahl', (env) => detail.completeFor({ id: 7, status: 'open' }, { id: 3, display_name: 'Mia' }, {}, env.ctx, env.close)],
  ['Ablegen', (env) => detail.toggleTaskArchive({ id: 7, status: 'done', archived_at: null }, {}, env.ctx, env.close)],
]) {
  test(`${name}: der Satz der App; eine verschwundene Aufgabe schliesst die Ansicht und laedt die Umgebung`, async () => {
    for (const [err, expected] of FAELLE) {
      const env = umgebung();
      await mit({ patch: async () => { throw err; } }, () => lauf(env));
      const label = `${err.status} ${err.data?.reason ?? ''}`;
      assert.deepEqual(messages(), [expected], label);
      assertNoServerText();
      const gone = err.data?.reason === 'tasks_task_not_found';
      assert.equal(env.closed, gone ? 1 : 0, `${label}: Ansicht zu`);
      assert.equal(env.changed, gone ? 1 : 0, `${label}: Umgebung frisch`);
    }
  });
}

test('Teilaufgabe anlegen: der Satz der App; ist die Aufgabe weg, kommt die Umgebung frisch', async () => {
  for (const [err, expected, reload] of [
    [fehler(404, 'tasks_parent_not_found'), 'tasks.errorParentGone', true],
    [fehler(400), 'common.errorGeneric', false],
    [fehler(403, 'task_locked'), 'tasks.errorLocked', false],
  ]) {
    let changed = 0;
    let created;
    await mit({ post: async () => { throw err; } }, async () => {
      created = await taskDetail.addSubtask(7, 'Schritt', { onChanged: async () => { changed += 1; } });
    });
    assert.equal(created, null);
    assert.deepEqual(messages(), [expected], err.data.reason ?? String(err.status));
    assertNoServerText();
    assert.equal(changed, reload ? 1 : 0);
  }
});

test('Aufgabe loeschen: schon geloescht zaehlt als geloescht; alles andere sagt den Satz der App', async () => {
  for (const [err, expected] of [
    [TASK_GONE(), []],
    [fehler(403, 'task_locked'), ['tasks.errorLocked']],
    [fehler(500), ['common.errorGeneric']],
  ]) {
    let opts = null;
    let changed = 0;
    await mit({ delete: async () => { throw err; } }, async () => {
      globalThis.__undoStub = (o) => { opts = o; };
      try {
        await taskDetail.deleteTaskWithUndo(7, { onChanged: async () => { changed += 1; } });
      } finally {
        delete globalThis.__undoStub;
      }
      assert.ok(opts, 'kein Ruecknahme-Fenster');
      toasts.length = 0;
      try { await opts.commit({ keepalive: false }); } catch (e) { opts.restore(e); }
    });
    assert.deepEqual(messages(), expected, String(err.status));
    assertNoServerText();
    assert.equal(changed, expected.length ? 0 : 1, 'nach dem Erfolg kommt die Umgebung frisch');
  }
});

test('Haken in der Beschreibung: 409 bleibt der Konflikt, sonst der Satz der App', async () => {
  const box = {
    dataset: { mdLine: '0', mdChecked: '0' },
    setAttribute() {}, closest: () => null,
  };
  for (const [err, expected] of [
    [fehler(409), 'tasks.checkConflict'],
    [TASK_GONE(), 'tasks.errorTaskGone'],
    [fehler(400), 'common.unknownError'],
  ]) {
    await mit({ patch: async () => { throw err; } }, () => detail.toggleDescriptionCheck({ id: 7, description: '- [ ] Milch' }, box));
    assert.deepEqual(messages(), [expected], String(err.status));
    assertNoServerText();
  }
});

/** Alle Knoten mit einem Handler fuer `type`, in Dokumentreihenfolge. */
function mitHandler(node, type, out = []) {
  if (node?.handlers?.[type]) out.push(node);
  for (const child of node?.childNodes ?? []) mitHandler(child, type, out);
  return out;
}

test('Kommentar loeschen: schon geloescht zaehlt als geloescht; alles andere stellt zurueck und sagt den Satz', async () => {
  const comment = { id: 5, task_id: 7, user_id: ada, comment: 'Hallo', created_at: '2030-01-01T10:00:00Z', author_name: 'Ada' };
  for (const [err, expected] of [
    [fehler(404, 'tasks_comment_not_found'), []],
    [TASK_GONE(), ['tasks.errorTaskGone']],
    [fehler(500), ['common.errorGeneric']],
  ]) {
    let opts = null;
    let changed = 0;
    let row;
    await mit({ delete: async () => { throw err; } }, async () => {
      row = detail.commentRowNode(comment, { onChanged: async () => { changed += 1; }, ctx: { currentUserId: ada, isAdmin: false } });
      const [, del] = mitHandler(row, 'click');
      assert.ok(del, 'kein Loeschen-Knopf');
      globalThis.__undoStub = (o) => { opts = o; };
      try { del.handlers.click(); } finally { delete globalThis.__undoStub; }
      assert.ok(opts, 'kein Ruecknahme-Fenster');
      toasts.length = 0;
      try { await opts.commit({ keepalive: false }); } catch (e) { opts.restore(e); }
    });
    const label = err.data.reason ?? String(err.status);
    assert.deepEqual(messages(), expected, label);
    assertNoServerText();
    assert.equal(row.hidden, expected.length === 0, `${label}: die Zeile ${expected.length ? 'kommt zurueck' : 'bleibt weg'}`);
    assert.equal(changed, expected.length ? 0 : 1, label);
  }
});

test('Kommentar aendern und schreiben: der Satz der App; ist der Kommentar weg, kommt die Liste frisch', async () => {
  const comment = { id: 5, task_id: 7, user_id: ada, comment: 'Hallo', created_at: '2030-01-01T10:00:00Z' };
  for (const [err, expected, reload] of [
    [fehler(404, 'tasks_comment_not_found'), 'tasks.errorCommentGone', true],
    [TASK_GONE(), 'tasks.errorTaskGone', true],
    [fehler(400), 'common.errorGeneric', false],
  ]) {
    let changed = 0;
    await mit({ patch: async () => { throw err; } }, async () => {
      const row = globalThis.document.createElement('article');
      row.replaceWith = () => {};
      detail.startCommentEdit(row, comment, { onChanged: async () => { changed += 1; }, ctx: { currentUserId: ada } });
      const [form] = mitHandler(row, 'submit');
      assert.ok(form, 'kein Formular');
      await form.handlers.submit({ preventDefault() {} });
    });
    assert.deepEqual(messages(), [expected], err.data.reason ?? String(err.status));
    assertNoServerText();
    assert.equal(changed, reload ? 1 : 0);
  }
});
