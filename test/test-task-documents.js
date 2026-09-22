/**
 * Modul: Task-Dokument-Verknüpfungen (#503)
 * Zweck: GET/PUT /tasks/:id/documents inkl. Sichtbarkeits-Durchsetzung,
 *        Replace-Set (unsichtbare Alt-Links bleiben), document_count in Listen,
 *        CASCADE beim Löschen von Task/Dokument.
 * Ausführen: npm run test:task-documents
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'task-documents-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');

const moduleDatabase = get();
const suiteDatabase = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(suiteDatabase);
moduleDatabase.close();

const ALICE = seedUser('alice', 'admin');   // Admin (Ersteller der Tasks)
const BOB   = seedUser('bob', 'member');     // zweites Mitglied

test.after(() => suiteDatabase.close());

function applyMigration(db, migration) {
  if (typeof migration.up === 'function') migration.up(db);
  else db.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(db);
  db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
    .run(migration.version, migration.description);
}

function buildMigratedDatabase(migrations) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) applyMigration(db, migration);
  return db;
}

function seedUser(prefix, role) {
  return get().prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, 'hash', ?)
  `).run(`${prefix}-${randomUUID()}`, prefix, role).lastInsertRowid;
}

function createHarness({ userId = ALICE, role = 'admin', moduleAccess = null, authMethod, authScopes = null } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = userId;
    req.authRole = role;
    req.session = { userId, role };
    req.sessionModuleAccess = moduleAccess;
    req.authMethod = authMethod;
    req.authScopes = authScopes;
    next();
  });
  app.use('/api/v1/tasks', tasksRouter);
  const server = http.createServer(app);
  return {
    async call(method, pathname, body) {
      if (!server.listening) {
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      }
      const base = `http://127.0.0.1:${server.address().port}/api/v1/tasks`;
      const res = await fetch(`${base}${pathname}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    close() {
      return new Promise((resolve) => (server.listening ? server.close(resolve) : resolve()));
    },
  };
}

function seedTask(createdBy = ALICE, visibility = 'all') {
  return get().prepare(`
    INSERT INTO tasks (title, category, priority, status, created_by, visibility)
    VALUES (?, 'misc', 'none', 'open', ?, ?)
  `).run(`Task-${randomUUID()}`, createdBy, visibility).lastInsertRowid;
}

function seedDocument({ createdBy = ALICE, visibility = 'family', status = 'active' } = {}) {
  return get().prepare(`
    INSERT INTO family_documents
      (name, original_name, mime_type, file_size, content_data, category, visibility, status, created_by)
    VALUES (?, ?, 'application/pdf', 10, ?, 'other', ?, ?, ?)
  `).run(`Doc-${randomUUID()}`, 'file.pdf', Buffer.from('bytes'), visibility, status, createdBy).lastInsertRowid;
}

test('PUT links a family document and GET returns it', async () => {
  const h = createHarness();
  try {
    const taskId = seedTask();
    const docId = seedDocument({ visibility: 'family' });
    const put = await h.call('PUT', `/${taskId}/documents`, { document_ids: [docId] });
    assert.equal(put.status, 200);
    assert.equal(put.body.data.length, 1);
    assert.equal(put.body.data[0].id, docId);

    const list = await h.call('GET', `/${taskId}/documents`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data.map((d) => d.id), [docId]);
  } finally {
    await h.close();
  }
});

test('PUT ignores documents the user cannot see (private doc of another user)', async () => {
  const h = createHarness({ userId: ALICE, role: 'admin' });
  try {
    const taskId = seedTask();
    const privateDoc = seedDocument({ createdBy: BOB, visibility: 'private' });
    const put = await h.call('PUT', `/${taskId}/documents`, { document_ids: [privateDoc] });
    assert.equal(put.status, 200);
    assert.equal(put.body.data.length, 0, 'private doc of another user must not be linked (no admin bypass)');
  } finally {
    await h.close();
  }
});

test('PUT replace-set keeps invisible existing links intact', async () => {
  const h = createHarness({ userId: ALICE, role: 'admin' });
  try {
    const taskId = seedTask();
    const bobPrivate = seedDocument({ createdBy: BOB, visibility: 'private' });
    // Bob verknüpft direkt (simuliert seinen eigenen Save).
    get().prepare('INSERT INTO task_documents (task_id, document_id, created_by) VALUES (?, ?, ?)')
      .run(taskId, bobPrivate, BOB);

    const familyDoc = seedDocument({ visibility: 'family' });
    const put = await h.call('PUT', `/${taskId}/documents`, { document_ids: [familyDoc] });
    assert.equal(put.status, 200);
    // Alice sieht nur das Familien-Dokument.
    assert.deepEqual(put.body.data.map((d) => d.id), [familyDoc]);

    // Bobs privater Link bleibt in der DB bestehen (nicht durch Alices Replace-Set gelöscht).
    const rows = get().prepare('SELECT document_id FROM task_documents WHERE task_id = ? ORDER BY document_id').all(taskId);
    const ids = rows.map((r) => r.document_id).sort((a, b) => a - b);
    assert.deepEqual(ids, [bobPrivate, familyDoc].sort((a, b) => a - b));
  } finally {
    await h.close();
  }
});

test('PUT with empty document_ids clears the user-visible links', async () => {
  const h = createHarness();
  try {
    const taskId = seedTask();
    const docId = seedDocument({ visibility: 'family' });
    await h.call('PUT', `/${taskId}/documents`, { document_ids: [docId] });
    const cleared = await h.call('PUT', `/${taskId}/documents`, { document_ids: [] });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.data.length, 0);
  } finally {
    await h.close();
  }
});

test('GET/PUT on a task not visible to the user returns 404', async () => {
  const h = createHarness({ userId: BOB, role: 'member' });
  try {
    const privateTask = seedTask(ALICE, 'private'); // nur Alice sichtbar
    const docId = seedDocument({ visibility: 'family' });
    const get404 = await h.call('GET', `/${privateTask}/documents`);
    assert.equal(get404.status, 404);
    const put404 = await h.call('PUT', `/${privateTask}/documents`, { document_ids: [docId] });
    assert.equal(put404.status, 404);
  } finally {
    await h.close();
  }
});

test('archived documents are excluded from the linked list', async () => {
  const h = createHarness();
  try {
    const taskId = seedTask();
    const docId = seedDocument({ visibility: 'family' });
    await h.call('PUT', `/${taskId}/documents`, { document_ids: [docId] });
    get().prepare("UPDATE family_documents SET status = 'archived' WHERE id = ?").run(docId);
    const list = await h.call('GET', `/${taskId}/documents`);
    assert.equal(list.body.data.length, 0);
  } finally {
    await h.close();
  }
});

test('document_count appears in task list and detail', async () => {
  const h = createHarness();
  try {
    const taskId = seedTask();
    const d1 = seedDocument({ visibility: 'family' });
    const d2 = seedDocument({ visibility: 'family' });
    await h.call('PUT', `/${taskId}/documents`, { document_ids: [d1, d2] });

    const detail = await h.call('GET', `/${taskId}`);
    assert.equal(detail.body.data.document_count, 2);

    const list = await h.call('GET', '?include_future=1');
    const found = list.body.data.find((t) => t.id === taskId);
    assert.ok(found, 'task must appear in list');
    assert.equal(found.document_count, 2);
  } finally {
    await h.close();
  }
});

test('deleting a document cascades and removes the link', async () => {
  const h = createHarness();
  try {
    const taskId = seedTask();
    const docId = seedDocument({ visibility: 'family' });
    await h.call('PUT', `/${taskId}/documents`, { document_ids: [docId] });
    get().prepare('DELETE FROM family_documents WHERE id = ?').run(docId);
    const remaining = get().prepare('SELECT COUNT(*) AS n FROM task_documents WHERE task_id = ?').get(taskId).n;
    assert.equal(remaining, 0);
  } finally {
    await h.close();
  }
});

// ── Dokumentenrecht (#1358) ─────────────────────────────────────────────────────
// Die verknuepften Dokumente gehoeren dem Dokumente-Modul. Wer es nicht lesen
// darf (Mitgliedsrecht `documents: none` oder ein Token ohne documents:read),
// bekommt weder Namen noch IDs noch die ANZAHL: `document_count` und
// `documents` sind `null` ("nicht gesagt"), nicht 0 oder [] ("keine").
// Verknuepfen ist fuer jede ID dieselbe 403 - sonst waere die Antwort ein Orakel.

const NO_DOCS = [
  ['documents: none', { userId: BOB, role: 'member', moduleAccess: { documents: 'none' } }],
  ['Token ohne documents-Scope', { userId: BOB, role: 'member', authMethod: 'api_token', authScopes: ['tasks:write'] }],
  // Der Admin sieht jedes Familien-Dokument - sein Token ohne documents-Scope
  // trotzdem nicht: der Scope schneidet, die Rolle erweitert nicht.
  ['Admin-Token ohne documents-Scope', { userId: ALICE, role: 'admin', authMethod: 'api_token', authScopes: ['tasks:write'] }],
];

function linkedIds(taskId) {
  return get().prepare('SELECT document_id FROM task_documents WHERE task_id = ? ORDER BY document_id')
    .all(taskId).map((r) => r.document_id);
}

test('Dokumentenrecht: ohne documents-Lesen nennen Liste, Detail und GET /documents nichts (#1358)', async () => {
  const taskId = seedTask();
  const docId = seedDocument({ visibility: 'family' });
  get().prepare('INSERT INTO task_documents (task_id, document_id, created_by) VALUES (?, ?, ?)').run(taskId, docId, ALICE);

  const readable = [
    ['Mitglied', { userId: BOB, role: 'member' }],
    ['Admin-Sitzung', { userId: ALICE, role: 'admin' }],
    ['documents: read', { userId: BOB, role: 'member', moduleAccess: { documents: 'read' } }],
    ['Token mit documents:read', { userId: BOB, role: 'member', authMethod: 'api_token', authScopes: ['tasks:read', 'documents:read'] }],
  ];
  for (const [label, as] of readable) {
    const h = createHarness(as);
    try {
      const detail = await h.call('GET', `/${taskId}`);
      assert.equal(detail.body.data.document_count, 1, `${label}: Zahl`);
      assert.deepEqual(detail.body.data.documents.map((d) => d.id), [docId], `${label}: Detail`);
      const list = await h.call('GET', '?include_future=1');
      assert.equal(list.body.data.find((t) => t.id === taskId).document_count, 1, `${label}: Liste`);
      const docs = await h.call('GET', `/${taskId}/documents`);
      assert.equal(docs.status, 200);
      assert.deepEqual(docs.body.data.map((d) => d.id), [docId]);
    } finally { await h.close(); }
  }

  for (const [label, as] of NO_DOCS) {
    const h = createHarness(as);
    try {
      const detail = await h.call('GET', `/${taskId}`);
      assert.equal(detail.status, 200, `${label}: die Aufgabe selbst bleibt lesbar`);
      assert.equal(detail.body.data.document_count, null, `${label}: keine Zahl im Detail`);
      assert.equal(detail.body.data.documents, null, `${label}: keine Liste im Detail`);
      const list = await h.call('GET', '?include_future=1');
      assert.equal(list.status, 200);
      assert.equal(list.body.data.find((t) => t.id === taskId).document_count, null, `${label}: keine Zahl in der Liste`);
      const docs = await h.call('GET', `/${taskId}/documents`);
      assert.equal(docs.status, 403, `${label}: GET /documents ist 403`);
      assert.equal(docs.body.code, 403);
      // Nur Felder, die ein DOKUMENT benennen: eine blanke `"id":N`-Suche
      // traefe auch eine Aufgabe mit derselben Nummer.
      assert.doesNotMatch(JSON.stringify([detail.body, list.body, docs.body]),
        /Doc-|file\.pdf|application\/pdf|"document_id"|"documents":\[/,
        `${label}: weder Name, Datei, Typ noch Dokumentliste in den Antworten`);
    } finally { await h.close(); }
  }
});

test('Dokumentenrecht: ohne documents-Lesen verknuepft PUT nichts, jede ID antwortet gleich (#1358)', async () => {
  const taskId = seedTask();
  const stored = seedDocument({ visibility: 'family' });
  const other = seedDocument({ visibility: 'family' });
  get().prepare('INSERT INTO task_documents (task_id, document_id, created_by) VALUES (?, ?, ?)').run(taskId, stored, ALICE);
  const { lockDocumentDeletes, unlockDocumentDeletes } = await import('../server/services/document-deletion-lock.js');

  for (const [label, as] of NO_DOCS) {
    const h = createHarness(as);
    try {
      const valid = await h.call('PUT', `/${taskId}/documents`, { document_ids: [other] });
      assert.equal(valid.status, 403, `${label}: PUT mit Dokument ist 403`);
      assert.equal(valid.body.code, 403);
      for (const ids of [[stored], [987654]]) {
        const res = await h.call('PUT', `/${taskId}/documents`, { document_ids: ids });
        assert.deepEqual(res, { status: 403, body: valid.body }, `${label}: ${ids} antwortet wie jede andere ID`);
      }
      lockDocumentDeletes([stored]);
      try {
        const locked = await h.call('PUT', `/${taskId}/documents`, { document_ids: [stored] });
        assert.deepEqual(locked, { status: 403, body: valid.body }, `${label}: im Loeschfenster weiter 403, nicht 409`);
      } finally { unlockDocumentDeletes([stored]); }
      assert.deepEqual(linkedIds(taskId), [stored], `${label}: nichts verknuepft`);

      // Leer, `null` oder gar kein Feld: kein Verknuepfen - und mit Recht hiesse
      // jede der drei "alle sichtbaren loesen", ohne Recht loest keine etwas.
      for (const [form, body] of [['[]', { document_ids: [] }], ['null', { document_ids: null }], ['ohne Feld', {}]]) {
        const kept = await h.call('PUT', `/${taskId}/documents`, body);
        assert.equal(kept.status, 200, `${label}, ${form}: kein Verknuepfen`);
        assert.equal(kept.body.data, null, `${label}, ${form}: und die Antwort nennt nichts`);
        assert.deepEqual(linkedIds(taskId), [stored], `${label}, ${form}: und loest nichts, was er nicht sieht`);
      }
    } finally { await h.close(); }
  }

  const h = createHarness({ userId: BOB, role: 'member', authMethod: 'api_token', authScopes: ['tasks:write', 'documents:read'] });
  try {
    const res = await h.call('PUT', `/${taskId}/documents`, { document_ids: [other] });
    assert.equal(res.status, 200, 'mit documents:read verknuepft das Token');
    assert.deepEqual(linkedIds(taskId), [other]);
  } finally { await h.close(); }
});

test('deleting a task cascades and removes its links', async () => {
  const h = createHarness();
  try {
    const taskId = seedTask();
    const docId = seedDocument({ visibility: 'family' });
    await h.call('PUT', `/${taskId}/documents`, { document_ids: [docId] });
    await h.call('DELETE', `/${taskId}`);
    const remaining = get().prepare('SELECT COUNT(*) AS n FROM task_documents WHERE document_id = ?').get(docId).n;
    assert.equal(remaining, 0);
  } finally {
    await h.close();
  }
});
