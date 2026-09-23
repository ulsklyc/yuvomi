/**
 * Modul: Dokument-Ordner-Routen (#453)
 * Zweck: Umbenennen (PUT) und Löschen (DELETE) von Dokumentordnern inkl.
 *        ON DELETE SET NULL-Invariante: Dokumente behalten ihre Zeile.
 * Ausführen: npm run test:document-folders
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'document-folders-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: documentsRouter } = await import('../server/routes/documents.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');

const moduleDatabase = get();
const suiteDatabase = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(suiteDatabase);
moduleDatabase.close();

// created_by ist NOT NULL REFERENCES users(id) — echten Admin für alle Tests seeden.
const ADMIN_ID = seedUser();

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

function createHarness({ userId = ADMIN_ID, role = 'admin' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = userId;
    req.authRole = role;
    req.session = { userId, role };
    next();
  });
  app.use('/api/v1/documents', documentsRouter);
  app.use('/api/v1/tasks', tasksRouter);
  const server = http.createServer(app);
  return {
    async call(method, pathname, body) {
      if (!server.listening) {
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      }
      const base = `http://127.0.0.1:${server.address().port}/api/v1/documents`;
      const res = await fetch(`${base}${pathname}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    async callTask(method, pathname, body) {
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

function seedUser() {
  return get().prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, 'hash', 'admin')
  `).run(`folder-admin-${randomUUID()}`, 'Folder Admin').lastInsertRowid;
}

test('PUT /folders/:id renames a folder', async () => {
  const h = createHarness();
  try {
    const created = await h.call('POST', '/folders', { name: 'Vorher' });
    assert.equal(created.status, 201);
    const id = created.body.data.id;

    const renamed = await h.call('PUT', `/folders/${id}`, { name: 'Nachher' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.data.name, 'Nachher');

    const list = await h.call('GET', '/folders');
    assert.ok(list.body.data.some((f) => f.id === id && f.name === 'Nachher'));
  } finally {
    await h.close();
  }
});

test('PUT /folders/:id rejects empty name (400) and unknown id (404)', async () => {
  const h = createHarness();
  try {
    const created = await h.call('POST', '/folders', { name: `Ordner-${randomUUID()}` });
    const id = created.body.data.id;

    const empty = await h.call('PUT', `/folders/${id}`, { name: '   ' });
    assert.equal(empty.status, 400);

    const missing = await h.call('PUT', '/folders/999999', { name: 'Egal' });
    assert.equal(missing.status, 404);
  } finally {
    await h.close();
  }
});

test('DELETE /folders/:id removes the folder but keeps its documents (folder_id → NULL)', async () => {
  const h = createHarness();
  try {
    const userId = ADMIN_ID;
    const created = await h.call('POST', '/folders', { name: `Löschbar-${randomUUID()}` });
    const folderId = created.body.data.id;

    // Dokument direkt in den Ordner legen (FK-Verhalten ist DB-Ebene).
    const docId = get().prepare(`
      INSERT INTO family_documents
        (name, original_name, mime_type, file_size, content_data, category, visibility, status, folder_id, created_by)
      VALUES (?, ?, 'text/plain', 10, ?, 'other', 'family', 'active', ?, ?)
    `).run('Police', 'police.txt', Buffer.from('bytes'), folderId, userId).lastInsertRowid;

    const del = await h.call('DELETE', `/folders/${folderId}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.data.id, folderId);

    // Ordner weg …
    const list = await h.call('GET', '/folders');
    assert.ok(!list.body.data.some((f) => f.id === folderId));

    // … Dokument bleibt, ohne Ordnerbindung.
    const doc = get().prepare('SELECT id, folder_id FROM family_documents WHERE id = ?').get(docId);
    assert.ok(doc, 'document row must still exist');
    assert.equal(doc.folder_id, null);
  } finally {
    await h.close();
  }
});

test('DELETE /folders/:id?documents=delete removes documents from the entire folder subtree', async () => {
  const h = createHarness();
  try {
    const root = await h.call('POST', '/folders', { name: `Delete-tree-${randomUUID()}` });
    const child = await h.call('POST', '/folders', { name: 'Child', parent_id: root.body.data.id });

    const insert = get().prepare(`
      INSERT INTO family_documents
        (name, original_name, mime_type, file_size, content_data, category, visibility, status, folder_id, created_by)
      VALUES (?, ?, 'text/plain', 5, ?, 'other', 'family', 'active', ?, ?)
    `);
    const rootDoc = insert.run('Root document', 'root.txt', Buffer.from('root'), root.body.data.id, ADMIN_ID).lastInsertRowid;
    const childDoc = insert.run('Child document', 'child.txt', Buffer.from('child'), child.body.data.id, ADMIN_ID).lastInsertRowid;

    const impact = await h.call('GET', `/folders/${root.body.data.id}/delete-impact`);
    const del = await h.call(
      'DELETE',
      `/folders/${root.body.data.id}?documents=delete&expected_snapshot=${impact.body.data.snapshot}`,
    );

    assert.equal(del.status, 200);
    assert.equal(del.body.data.removed_folders, 2);
    assert.equal(del.body.data.deleted_documents, 2);
    assert.equal(get().prepare('SELECT COUNT(*) AS n FROM family_documents WHERE id IN (?, ?)').get(rootDoc, childDoc).n, 0);
  } finally {
    await h.close();
  }
});

test('GET /folders/:id/delete-impact counts documents and subfolders across the entire subtree', async () => {
  const h = createHarness();
  try {
    const root = await h.call('POST', '/folders', { name: `Impact-tree-${randomUUID()}` });
    const child = await h.call('POST', '/folders', { name: 'Archived', parent_id: root.body.data.id });
    const insert = get().prepare(`
      INSERT INTO family_documents
        (name, original_name, mime_type, file_size, content_data, category, visibility, status, folder_id, created_by)
      VALUES (?, ?, 'text/plain', 1, ?, 'other', 'family', ?, ?, ?)
    `);
    insert.run('Active', 'active.txt', Buffer.from('a'), 'active', root.body.data.id, ADMIN_ID);
    insert.run('Archived', 'archived.txt', Buffer.from('b'), 'archived', child.body.data.id, ADMIN_ID);

    const impact = await h.call('GET', `/folders/${root.body.data.id}/delete-impact`);

    assert.equal(impact.status, 200);
    assert.equal(impact.body.data.id, root.body.data.id);
    assert.equal(impact.body.data.removed_folders, 2);
    assert.equal(impact.body.data.documents, 2);
    assert.equal(impact.body.data.can_delete_documents, true);
    assert.match(impact.body.data.snapshot, /^[a-f0-9]{64}$/);
    const enumerableDigest = createHash('sha256').update(JSON.stringify({
      folders: [root.body.data.id, child.body.data.id].sort((a, b) => a - b),
      documents: get().prepare('SELECT id FROM family_documents WHERE folder_id IN (?, ?) ORDER BY id')
        .all(root.body.data.id, child.body.data.id).map((row) => row.id),
    })).digest('hex');
    assert.notEqual(impact.body.data.snapshot, enumerableDigest,
      'the public snapshot must be keyed, not a brute-forceable digest of sequential ids');
  } finally {
    await h.close();
  }
});

test('GET delete impact names every module whose document links will change', async () => {
  const h = createHarness();
  const otherUserId = get().prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, 'hash', 'member')
  `).run(`impact-member-${randomUUID()}`, 'Impact Member').lastInsertRowid;
  try {
    const folder = await h.call('POST', '/folders', { name: `Linked-impact-${randomUUID()}` });
    const documentId = get().prepare(`
      INSERT INTO family_documents
        (name, original_name, mime_type, file_size, content_data, category, visibility, status, folder_id, created_by)
      VALUES ('Linked document', 'linked.txt', 'text/plain', 1, ?, 'other', 'family', 'active', ?, ?)
    `).run(Buffer.from('linked'), folder.body.data.id, ADMIN_ID).lastInsertRowid;

    get().prepare(`
      INSERT INTO calendar_events (title, start_datetime, created_by, attachment_document_id)
      VALUES ('Linked event', '2026-09-03T10:00:00Z', ?, ?)
    `).run(ADMIN_ID, documentId);
    get().prepare(`
      INSERT INTO housekeeping_work_sessions (check_in, created_by, receipt_document_id)
      VALUES ('2026-09-03T10:00:00Z', ?, ?)
    `).run(ADMIN_ID, documentId);
    const expenseGroupId = get().prepare(`
      INSERT INTO expense_groups (name, created_by, avatar_document_id)
      VALUES ('Linked group', ?, ?)
    `).run(ADMIN_ID, documentId).lastInsertRowid;
    const expenseId = get().prepare(`
      INSERT INTO expenses
        (group_id, title, amount_minor, currency, converted_amount_minor, converted_currency, payer_id, created_by)
      VALUES (?, 'Linked expense', 100, 'EUR', 100, 'EUR', ?, ?)
    `).run(expenseGroupId, ADMIN_ID, ADMIN_ID).lastInsertRowid;
    get().prepare(`
      INSERT INTO expense_attachments (expense_id, document_id, created_by)
      VALUES (?, ?, ?)
    `).run(expenseId, documentId, ADMIN_ID);
    get().prepare(`
      INSERT INTO settlements
        (group_id, payer_id, payee_id, amount_minor, currency, created_by, proof_document_id)
      VALUES (?, ?, ?, 100, 'EUR', ?, ?)
    `).run(expenseGroupId, ADMIN_ID, otherUserId, ADMIN_ID, documentId);
    const taskId = get().prepare(`
      INSERT INTO tasks (title, created_by) VALUES ('Linked task', ?)
    `).run(ADMIN_ID).lastInsertRowid;
    get().prepare(`
      INSERT INTO task_documents (task_id, document_id, created_by) VALUES (?, ?, ?)
    `).run(taskId, documentId, ADMIN_ID);
    const budgetEntryId = get().prepare(`
      INSERT INTO budget_entries (title, amount, date, created_by)
      VALUES ('Linked budget entry', 1, '2026-09-03', ?)
    `).run(ADMIN_ID).lastInsertRowid;
    get().prepare(`
      INSERT INTO budget_entry_attachments (entry_id, document_id, created_by) VALUES (?, ?, ?)
    `).run(budgetEntryId, documentId, ADMIN_ID);
    const inventoryItemId = get().prepare(`
      INSERT INTO inventory_items (name, created_by) VALUES ('Linked item', ?)
    `).run(ADMIN_ID).lastInsertRowid;
    get().prepare(`
      INSERT INTO inventory_item_documents (item_id, document_id, created_by) VALUES (?, ?, ?)
    `).run(inventoryItemId, documentId, ADMIN_ID);

    const impact = await h.call('GET', `/folders/${folder.body.data.id}/delete-impact`);

    assert.equal(impact.status, 200);
    assert.deepEqual(impact.body.data.linked_records, {
      calendar: 1,
      housekeeping: 1,
      split_expenses: 3,
      tasks: 1,
      budget: 1,
      inventory: 1,
    });
  } finally {
    await h.close();
  }
});

test('DELETE rejects a collateral-link change made after the impact preview', async () => {
  const h = createHarness();
  try {
    const folder = await h.call('POST', '/folders', { name: `Linked-race-${randomUUID()}` });
    const documentId = get().prepare(`
      INSERT INTO family_documents
        (name, original_name, mime_type, file_size, content_data, category, visibility, status, folder_id, created_by)
      VALUES ('Late link', 'late.txt', 'text/plain', 1, ?, 'other', 'family', 'active', ?, ?)
    `).run(Buffer.from('late'), folder.body.data.id, ADMIN_ID).lastInsertRowid;
    const impact = await h.call('GET', `/folders/${folder.body.data.id}/delete-impact`);
    const taskId = get().prepare("INSERT INTO tasks (title, created_by) VALUES ('Late task', ?)")
      .run(ADMIN_ID).lastInsertRowid;
    get().prepare('INSERT INTO task_documents (task_id, document_id, created_by) VALUES (?, ?, ?)')
      .run(taskId, documentId, ADMIN_ID);

    const del = await h.call(
      'DELETE',
      `/folders/${folder.body.data.id}?documents=delete&expected_snapshot=${impact.body.data.snapshot}`,
    );

    assert.equal(del.status, 409);
    assert.equal(del.body.reason, 'FOLDER_CONTENT_CHANGED');
    assert.ok(get().prepare('SELECT id FROM family_documents WHERE id = ?').get(documentId));
  } finally {
    await h.close();
  }
});

test('DELETE with documents rejects a member before deleting any owned document', async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), 'yuvomi-folder-delete-authorization-'));
  const previousStoragePath = process.env.DOCUMENT_STORAGE_LOCAL_PATH;
  process.env.DOCUMENT_STORAGE_LOCAL_PATH = storageRoot;
  const memberId = get().prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, 'hash', 'member')
  `).run(`folder-member-${randomUUID()}`, 'Folder Member').lastInsertRowid;
  const adminHarness = createHarness();
  const memberHarness = createHarness({ userId: memberId, role: 'member' });
  try {
    const folder = await adminHarness.call('POST', '/folders', { name: `Protected-${randomUUID()}` });
    const insert = get().prepare(`
      INSERT INTO family_documents
        (name, original_name, mime_type, file_size, content_data, storage_key,
         category, visibility, status, folder_id, created_by)
      VALUES (?, ?, 'text/plain', 9, ?, ?, 'other', 'family', 'active', ?, ?)
    `);
    const storedFiles = ['owned-1.txt', 'owned-2.txt', 'owned-3.txt', 'protected.txt'];
    storedFiles.forEach((name) => writeFileSync(join(storageRoot, name), `stored ${name}`));
    const ownedDocumentIds = storedFiles.slice(0, 3).map((storageKey, index) => insert.run(
      `Owned document ${index + 1}`, storageKey, Buffer.alloc(0), storageKey,
      folder.body.data.id, memberId,
    ).lastInsertRowid);
    const foreignDocumentId = insert.run(
      'Protected document', 'protected.txt', Buffer.alloc(0), 'protected.txt',
      folder.body.data.id, ADMIN_ID,
    ).lastInsertRowid;

    const impact = await memberHarness.call('GET', `/folders/${folder.body.data.id}/delete-impact`);
    assert.equal(impact.body.data.can_delete_documents, false);

    const del = await memberHarness.call(
      'DELETE',
      `/folders/${folder.body.data.id}?documents=delete&expected_snapshot=${impact.body.data.snapshot}`,
    );

    assert.equal(del.status, 403);
    const survivingDocuments = get().prepare(`
      SELECT id, storage_key FROM family_documents
      WHERE id IN (?, ?, ?, ?)
      ORDER BY id
    `).all(...ownedDocumentIds, foreignDocumentId);
    assert.deepEqual(
      survivingDocuments.map((document) => document.id),
      [...ownedDocumentIds, foreignDocumentId].sort((a, b) => a - b),
      'the authorization gate must run before any document row is removed',
    );
    for (const document of survivingDocuments) {
      assert.equal(existsSync(join(storageRoot, document.storage_key)), true,
        `document ${document.id} must keep its stored file`);
    }
    assert.ok(get().prepare('SELECT id FROM family_document_folders WHERE id = ?').get(folder.body.data.id));

  } finally {
    await Promise.all([adminHarness.close(), memberHarness.close()]);
    if (previousStoragePath === undefined) delete process.env.DOCUMENT_STORAGE_LOCAL_PATH;
    else process.env.DOCUMENT_STORAGE_LOCAL_PATH = previousStoragePath;
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('delete impact does not count a hidden private document and admins cannot delete it through a folder', async () => {
  const ownerId = get().prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, 'hash', 'member')
  `).run(`private-owner-${randomUUID()}`, 'Private document owner').lastInsertRowid;
  const h = createHarness();
  try {
    const folder = await h.call('POST', '/folders', { name: `Private-impact-${randomUUID()}` });
    const insert = get().prepare(`
      INSERT INTO family_documents
        (name, original_name, mime_type, file_size, content_data, category, visibility, status, folder_id, created_by)
      VALUES (?, ?, 'text/plain', 1, ?, 'other', ?, 'active', ?, ?)
    `);
    const visibleId = insert.run(
      'Visible document',
      'visible.txt',
      Buffer.from('visible'),
      'family',
      folder.body.data.id,
      ADMIN_ID,
    ).lastInsertRowid;
    const hiddenId = insert.run(
      'Private document',
      'private.txt',
      Buffer.from('private'),
      'private',
      folder.body.data.id,
      ownerId,
    ).lastInsertRowid;

    const impact = await h.call('GET', `/folders/${folder.body.data.id}/delete-impact`);
    assert.equal(impact.status, 200);
    assert.equal(impact.body.data.documents, 1, 'the response must not reveal the hidden document count');
    // #1358: the preview must be the same with and without the hidden document -
    // `can_delete_documents: false` told an admin exactly that one is there.
    assert.equal(impact.body.data.can_delete_documents, true,
      'the admin may delete every document they can see; the hidden one must not flip the verdict');
    get().prepare('UPDATE family_documents SET folder_id = NULL WHERE id = ?').run(hiddenId);
    const withoutHidden = await h.call('GET', `/folders/${folder.body.data.id}/delete-impact`);
    get().prepare('UPDATE family_documents SET folder_id = ? WHERE id = ?').run(folder.body.data.id, hiddenId);
    assert.deepEqual(impact.body.data, withoutHidden.body.data,
      'the delete preview is identical with and without a document the caller cannot see');

    const del = await h.call(
      'DELETE',
      `/folders/${folder.body.data.id}?documents=delete`
      + `&expected_documents=${impact.body.data.documents}`
      + `&expected_folders=${impact.body.data.removed_folders}`
      + `&expected_snapshot=${impact.body.data.snapshot}`,
    );

    assert.equal(del.status, 403);
    assert.equal(del.body.error, 'Not authorized to delete every document in this folder.');
    assert.equal(get().prepare('SELECT COUNT(*) AS count FROM family_documents WHERE id IN (?, ?)')
      .get(visibleId, hiddenId).count, 2);
    assert.ok(get().prepare('SELECT id FROM family_document_folders WHERE id = ?').get(folder.body.data.id));

    const unfile = await h.call('DELETE', `/folders/${folder.body.data.id}?documents=unfile`);
    assert.equal(unfile.status, 200);
    assert.equal(unfile.body.data.unfiled_documents, 1,
      'the response must count only documents visible to the caller');
  } finally {
    await h.close();
  }
});

test('DELETE /folders/:id rejects an unknown document action without changing the folder', async () => {
  const h = createHarness();
  try {
    const folder = await h.call('POST', '/folders', { name: `Unknown-action-${randomUUID()}` });

    const del = await h.call('DELETE', `/folders/${folder.body.data.id}?documents=destroy`);

    assert.equal(del.status, 400);
    assert.ok(get().prepare('SELECT id FROM family_document_folders WHERE id = ?').get(folder.body.data.id));
  } finally {
    await h.close();
  }
});

test('DELETE with documents rejects a changed subtree before deleting anything', async () => {
  const h = createHarness();
  try {
    const folder = await h.call('POST', '/folders', { name: `Changed-impact-${randomUUID()}` });
    const insert = get().prepare(`
      INSERT INTO family_documents
        (name, original_name, mime_type, file_size, content_data, category, visibility, status, folder_id, created_by)
      VALUES (?, ?, 'text/plain', 1, ?, 'other', 'family', 'active', ?, ?)
    `);
    const firstId = insert.run('First', 'first.txt', Buffer.from('a'), folder.body.data.id, ADMIN_ID).lastInsertRowid;
    const impact = await h.call('GET', `/folders/${folder.body.data.id}/delete-impact`);
    assert.equal(impact.body.data.documents, 1);

    const secondId = insert.run('Added later', 'later.txt', Buffer.from('b'), folder.body.data.id, ADMIN_ID).lastInsertRowid;
    const del = await h.call(
      'DELETE',
      `/folders/${folder.body.data.id}?documents=delete&expected_documents=1&expected_folders=1&expected_snapshot=${impact.body.data.snapshot}`,
    );

    assert.equal(del.status, 409);
    assert.equal(del.body.error, 'Folder contents changed. Review the deletion impact and try again.');
    assert.equal(del.body.reason, 'FOLDER_CONTENT_CHANGED');
    assert.equal(get().prepare('SELECT COUNT(*) AS n FROM family_documents WHERE id IN (?, ?)').get(firstId, secondId).n, 2);
    assert.ok(get().prepare('SELECT id FROM family_document_folders WHERE id = ?').get(folder.body.data.id));
  } finally {
    await h.close();
  }
});

test('DELETE with documents rejects an identity swap even when counts stay unchanged', async () => {
  const h = createHarness();
  try {
    const folder = await h.call('POST', '/folders', { name: `Changed-identity-${randomUUID()}` });
    const other = await h.call('POST', '/folders', { name: `Changed-identity-other-${randomUUID()}` });
    const insert = get().prepare(`
      INSERT INTO family_documents
        (name, original_name, mime_type, file_size, content_data, category, visibility, status, folder_id, created_by)
      VALUES (?, ?, 'text/plain', 1, ?, 'other', 'family', 'active', ?, ?)
    `);
    const previewedId = insert.run('Previewed', 'previewed.txt', Buffer.from('a'), folder.body.data.id, ADMIN_ID).lastInsertRowid;
    const impact = await h.call('GET', `/folders/${folder.body.data.id}/delete-impact`);

    get().prepare('UPDATE family_documents SET folder_id = ? WHERE id = ?').run(other.body.data.id, previewedId);
    const replacementId = insert.run('Replacement', 'replacement.txt', Buffer.from('b'), folder.body.data.id, ADMIN_ID).lastInsertRowid;
    const del = await h.call(
      'DELETE',
      `/folders/${folder.body.data.id}?documents=delete&expected_documents=1&expected_folders=1&expected_snapshot=${impact.body.data.snapshot}`,
    );

    assert.equal(del.status, 409);
    assert.equal(del.body.error, 'Folder contents changed. Review the deletion impact and try again.');
    assert.equal(del.body.reason, 'FOLDER_CONTENT_CHANGED');
    assert.equal(get().prepare('SELECT COUNT(*) AS n FROM family_documents WHERE id IN (?, ?)')
      .get(previewedId, replacementId).n, 2);
    assert.ok(get().prepare('SELECT id FROM family_document_folders WHERE id = ?').get(folder.body.data.id));
  } finally {
    await h.close();
  }
});

test('DELETE with documents requires a delete-impact snapshot', async () => {
  const h = createHarness();
  try {
    const folder = await h.call('POST', '/folders', { name: `Missing-snapshot-${randomUUID()}` });
    const documentId = get().prepare(`
      INSERT INTO family_documents
        (name, original_name, mime_type, file_size, content_data, category, visibility, status, folder_id, created_by)
      VALUES ('Still here', 'still-here.txt', 'text/plain', 1, ?, 'other', 'family', 'active', ?, ?)
    `).run(Buffer.from('a'), folder.body.data.id, ADMIN_ID).lastInsertRowid;

    const del = await h.call('DELETE', `/folders/${folder.body.data.id}?documents=delete`);

    assert.equal(del.status, 400);
    assert.ok(get().prepare('SELECT id FROM family_documents WHERE id = ?').get(documentId));
    assert.ok(get().prepare('SELECT id FROM family_document_folders WHERE id = ?').get(folder.body.data.id));
  } finally {
    await h.close();
  }
});

test('DELETE with documents rejects a snapshot created for another folder', async () => {
  const h = createHarness();
  try {
    const first = await h.call('POST', '/folders', { name: `Snapshot-first-${randomUUID()}` });
    const second = await h.call('POST', '/folders', { name: `Snapshot-second-${randomUUID()}` });
    const insert = get().prepare(`
      INSERT INTO family_documents
        (name, original_name, mime_type, file_size, content_data, category, visibility, status, folder_id, created_by)
      VALUES (?, ?, 'text/plain', 1, ?, 'other', 'family', 'active', ?, ?)
    `);
    insert.run('First', 'first.txt', Buffer.from('first'), first.body.data.id, ADMIN_ID);
    insert.run('Second', 'second.txt', Buffer.from('second'), second.body.data.id, ADMIN_ID);
    const firstImpact = await h.call('GET', `/folders/${first.body.data.id}/delete-impact`);

    const del = await h.call(
      'DELETE',
      `/folders/${second.body.data.id}?documents=delete&expected_snapshot=${firstImpact.body.data.snapshot}`,
    );

    assert.equal(del.status, 409);
    assert.equal(del.body.error, 'Folder contents changed. Review the deletion impact and try again.');
    assert.equal(del.body.reason, 'FOLDER_CONTENT_CHANGED');
    assert.ok(get().prepare('SELECT id FROM family_document_folders WHERE id = ?').get(second.body.data.id));
  } finally {
    await h.close();
  }
});

test('DELETE with documents rejects a malformed snapshot with an explicit validation error', async () => {
  const h = createHarness();
  try {
    const folder = await h.call('POST', '/folders', { name: `Malformed-snapshot-${randomUUID()}` });

    const del = await h.call(
      'DELETE',
      `/folders/${folder.body.data.id}?documents=delete&expected_snapshot=not-a-sha256`,
    );

    assert.equal(del.status, 400);
    assert.equal(del.body.error, 'Invalid expected folder snapshot.');
    assert.ok(get().prepare('SELECT id FROM family_document_folders WHERE id = ?').get(folder.body.data.id));
  } finally {
    await h.close();
  }
});

test('DELETE with documents reports partial storage failures and retains the folder', async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), 'yuvomi-folder-delete-'));
  const previousStoragePath = process.env.DOCUMENT_STORAGE_LOCAL_PATH;
  process.env.DOCUMENT_STORAGE_LOCAL_PATH = storageRoot;
  mkdirSync(join(storageRoot, 'cannot-unlink-directory'));
  const h = createHarness();
  try {
    const folder = await h.call('POST', '/folders', { name: `Partial-${randomUUID()}` });
    const insert = get().prepare(`
      INSERT INTO family_documents
        (name, original_name, mime_type, file_size, content_data, storage_key, category, visibility, status, folder_id, created_by)
      VALUES (?, ?, 'text/plain', 1, ?, ?, 'other', 'family', 'active', ?, ?)
    `);
    const deletedId = insert.run('Blob document', 'blob.txt', Buffer.from('a'), null, folder.body.data.id, ADMIN_ID).lastInsertRowid;
    const failedId = insert.run(
      'Directory-backed document',
      'directory.txt',
      Buffer.alloc(0),
      'cannot-unlink-directory',
      folder.body.data.id,
      ADMIN_ID,
    ).lastInsertRowid;

    const impact = await h.call('GET', `/folders/${folder.body.data.id}/delete-impact`);
    const del = await h.call(
      'DELETE',
      `/folders/${folder.body.data.id}?documents=delete&expected_snapshot=${impact.body.data.snapshot}`,
    );

    assert.equal(del.status, 207);
    assert.equal(del.body.data.deleted_documents, 1);
    assert.equal(del.body.data.failed_documents.length, 1);
    assert.equal(del.body.data.failed_documents[0].id, failedId);
    assert.equal(del.body.data.failed_documents[0].failure_stage, 'storage');
    assert.ok(del.body.data.failed_documents[0].storage_code);
    assert.equal('error_code' in del.body.data.failed_documents[0], false,
      'a storage failure must not be reported as a database failure');
    assert.equal(del.body.data.folder_deleted, false);
    assert.equal(get().prepare('SELECT id FROM family_documents WHERE id = ?').get(deletedId), undefined);
    assert.ok(get().prepare('SELECT id FROM family_documents WHERE id = ?').get(failedId));
    assert.ok(get().prepare('SELECT id FROM family_document_folders WHERE id = ?').get(folder.body.data.id));
  } finally {
    await h.close();
    if (previousStoragePath === undefined) delete process.env.DOCUMENT_STORAGE_LOCAL_PATH;
    else process.env.DOCUMENT_STORAGE_LOCAL_PATH = previousStoragePath;
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('DELETE with documents distinguishes a database-row failure after storage was removed', async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), 'yuvomi-folder-delete-database-'));
  const previousStoragePath = process.env.DOCUMENT_STORAGE_LOCAL_PATH;
  process.env.DOCUMENT_STORAGE_LOCAL_PATH = storageRoot;
  const storageKey = 'database-failure.txt';
  writeFileSync(join(storageRoot, storageKey), 'stored bytes');
  const h = createHarness();
  let triggerName;
  try {
    const folder = await h.call('POST', '/folders', { name: `Database-failure-${randomUUID()}` });
    const documentId = get().prepare(`
      INSERT INTO family_documents
        (name, original_name, mime_type, file_size, content_data, storage_key, category, visibility, status, folder_id, created_by)
      VALUES ('Database failure', 'database-failure.txt', 'text/plain', 12, ?, ?, 'other', 'family', 'active', ?, ?)
    `).run(Buffer.alloc(0), storageKey, folder.body.data.id, ADMIN_ID).lastInsertRowid;
    triggerName = `reject_document_delete_${documentId}`;
    get().exec(`
      CREATE TRIGGER ${triggerName}
      BEFORE DELETE ON family_documents
      WHEN OLD.id = ${Number(documentId)}
      BEGIN
        SELECT RAISE(ABORT, 'simulated row delete failure');
      END
    `);

    const impact = await h.call('GET', `/folders/${folder.body.data.id}/delete-impact`);
    const del = await h.call(
      'DELETE',
      `/folders/${folder.body.data.id}?documents=delete&expected_snapshot=${impact.body.data.snapshot}`,
    );

    assert.equal(del.status, 207);
    assert.equal(del.body.data.failed_documents.length, 1);
    assert.equal(del.body.data.failed_documents[0].id, documentId);
    assert.equal(del.body.data.failed_documents[0].failure_stage, 'database');
    assert.equal(del.body.data.failed_documents[0].error_code, 'DOCUMENT_DATABASE_DELETE_FAILED');
    assert.equal('storage_code' in del.body.data.failed_documents[0], false,
      'a database failure must not be reported as a storage failure');
    assert.equal(existsSync(join(storageRoot, storageKey)), false, 'the storage object was already removed');
    assert.ok(get().prepare('SELECT id FROM family_documents WHERE id = ?').get(documentId),
      'the database row remains after the failed row deletion');
  } finally {
    if (triggerName) get().exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
    await h.close();
    if (previousStoragePath === undefined) delete process.env.DOCUMENT_STORAGE_LOCAL_PATH;
    else process.env.DOCUMENT_STORAGE_LOCAL_PATH = previousStoragePath;
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('DELETE with documents retains the folder when its contents change during storage deletion', async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), 'yuvomi-folder-delete-race-'));
  const previousStoragePath = process.env.DOCUMENT_STORAGE_LOCAL_PATH;
  process.env.DOCUMENT_STORAGE_LOCAL_PATH = storageRoot;
  const h = createHarness();
  try {
    const folder = await h.call('POST', '/folders', { name: `Concurrent-${randomUUID()}` });
    const insert = get().prepare(`
      INSERT INTO family_documents
        (name, original_name, mime_type, file_size, content_data, storage_key, category, visibility, status, folder_id, created_by)
      VALUES (?, ?, 'text/plain', 1, ?, ?, 'other', 'family', 'active', ?, ?)
    `);
    const storageKeys = Array.from({ length: 40 }, (_unused, index) => `concurrent-${index}.txt`);
    for (const storageKey of storageKeys) {
      writeFileSync(join(storageRoot, storageKey), storageKey);
      insert.run(storageKey, storageKey, Buffer.alloc(0), storageKey, folder.body.data.id, ADMIN_ID);
    }

    const impact = await h.call('GET', `/folders/${folder.body.data.id}/delete-impact`);
    const deletion = h.call(
      'DELETE',
      `/folders/${folder.body.data.id}?documents=delete&expected_documents=40&expected_folders=1&expected_snapshot=${impact.body.data.snapshot}`,
    );
    const deadline = Date.now() + 2000;
    while (existsSync(join(storageRoot, storageKeys[0])) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(existsSync(join(storageRoot, storageKeys[0])), false, 'deletion must have started');
    const addedId = insert.run(
      'Added during deletion',
      'added-during-delete.txt',
      Buffer.from('new'),
      null,
      folder.body.data.id,
      ADMIN_ID,
    ).lastInsertRowid;

    const del = await deletion;

    assert.equal(del.status, 207);
    assert.equal(del.body.data.folder_deleted, false);
    assert.equal(del.body.data.contents_changed, true);
    const concurrentFailure = del.body.data.failed_documents.find((document) => document.id === addedId);
    assert.equal(concurrentFailure.failure_stage, 'concurrency');
    assert.equal(concurrentFailure.error_code, 'FOLDER_CONTENT_CHANGED');
    assert.equal('storage_code' in concurrentFailure, false);
    assert.ok(get().prepare('SELECT id FROM family_documents WHERE id = ? AND folder_id = ?')
      .get(addedId, folder.body.data.id));
    assert.ok(get().prepare('SELECT id FROM family_document_folders WHERE id = ?').get(folder.body.data.id));
  } finally {
    await h.close();
    if (previousStoragePath === undefined) delete process.env.DOCUMENT_STORAGE_LOCAL_PATH;
    else process.env.DOCUMENT_STORAGE_LOCAL_PATH = previousStoragePath;
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('DELETE with documents locks previewed documents and folders against concurrent moves', async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), 'yuvomi-folder-delete-lock-'));
  const previousStoragePath = process.env.DOCUMENT_STORAGE_LOCAL_PATH;
  process.env.DOCUMENT_STORAGE_LOCAL_PATH = storageRoot;
  const memberId = get().prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, 'hash', 'member')
  `).run(`folder-lock-member-${randomUUID()}`, 'Folder Lock Member').lastInsertRowid;
  const h = createHarness();
  const memberHarness = createHarness({ userId: memberId, role: 'member' });
  try {
    const root = await h.call('POST', '/folders', { name: `Locked-${randomUUID()}` });
    const child = await h.call('POST', '/folders', { name: 'Child', parent_id: root.body.data.id });
    const outside = await h.call('POST', '/folders', { name: `Outside-${randomUUID()}` });
    const insert = get().prepare(`
      INSERT INTO family_documents
        (name, original_name, mime_type, file_size, content_data, storage_key, category, visibility, status, folder_id, created_by)
      VALUES (?, ?, 'text/plain', 1, ?, ?, 'other', 'family', 'active', ?, ?)
    `);
    const documents = [];
    for (let index = 0; index < 120; index += 1) {
      const storageKey = `locked-${index}.txt`;
      writeFileSync(join(storageRoot, storageKey), storageKey);
      const id = insert.run(
        storageKey,
        storageKey,
        Buffer.alloc(0),
        storageKey,
        child.body.data.id,
        ADMIN_ID,
      ).lastInsertRowid;
      documents.push({ id, storageKey });
    }
    get().prepare("UPDATE family_documents SET visibility = 'private' WHERE id = ?")
      .run(documents.at(-1).id);
    const outsideDocumentId = insert.run(
      'Outside document',
      'outside.txt',
      Buffer.from('outside'),
      null,
      outside.body.data.id,
      ADMIN_ID,
    ).lastInsertRowid;
    const impact = await h.call('GET', `/folders/${root.body.data.id}/delete-impact`);
    const deletion = h.call(
      'DELETE',
      `/folders/${root.body.data.id}?documents=delete&expected_snapshot=${impact.body.data.snapshot}`,
    );
    const deadline = Date.now() + 2000;
    while (existsSync(join(storageRoot, documents[0].storageKey)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(existsSync(join(storageRoot, documents[0].storageKey)), false, 'deletion must have started');

    const taskId = get().prepare("INSERT INTO tasks (title, created_by) VALUES ('Concurrent link', ?)")
      .run(ADMIN_ID).lastInsertRowid;
    const [
      linkDocumentDuringDelete,
      archiveDocumentDuringDelete,
      hiddenUpdate,
      hiddenDelete,
      moveDocument,
      moveFolder,
      moveFolderIntoTree,
      moveDocumentIntoTree,
      deleteDocumentDuringDelete,
    ] = await Promise.all([
      h.callTask('PUT', `/${taskId}/documents`, {
        // The first storage item is already gone, but its row must remain visible
        // and locked until every asynchronous storage operation has finished.
        document_ids: [documents[0].id],
      }),
      h.call('PATCH', `/${documents[1].id}/archive`, { archived: true }),
      memberHarness.call('PUT', `/${documents.at(-1).id}`, { folder_id: outside.body.data.id }),
      memberHarness.call('DELETE', `/${documents.at(-1).id}`),
      h.call('PUT', `/${documents.at(-1).id}`, { folder_id: outside.body.data.id }),
      h.call('PUT', `/folders/${child.body.data.id}`, { parent_id: outside.body.data.id }),
      h.call('PUT', `/folders/${outside.body.data.id}`, { parent_id: root.body.data.id }),
      h.call('PUT', `/${outsideDocumentId}`, { folder_id: child.body.data.id }),
      h.call('DELETE', `/${documents[2].id}`),
    ]);

    assert.equal(hiddenUpdate.status, 404);
    assert.equal(hiddenDelete.status, 404);
    assert.equal(moveDocument.status, 409);
    assert.equal(moveDocument.body.reason, 'DOCUMENT_DELETE_IN_PROGRESS');
    assert.equal(moveFolder.status, 409);
    assert.equal(moveFolderIntoTree.status, 409);
    assert.equal(moveFolderIntoTree.body.error,
      'The document folder is currently being deleted. Try again when the operation finishes.');
    assert.equal(moveFolderIntoTree.body.reason, 'FOLDER_DELETE_IN_PROGRESS');
    assert.equal(moveDocumentIntoTree.status, 409);
    assert.equal(moveDocumentIntoTree.body.error,
      'The document folder is currently being deleted. Try again when the operation finishes.');
    assert.equal(moveDocumentIntoTree.body.reason, 'FOLDER_DELETE_IN_PROGRESS');
    assert.equal(linkDocumentDuringDelete.status, 409);
    assert.equal(linkDocumentDuringDelete.body.reason, 'DOCUMENT_DELETE_IN_PROGRESS');
    assert.equal(archiveDocumentDuringDelete.status, 409);
    assert.equal(archiveDocumentDuringDelete.body.reason, 'DOCUMENT_DELETE_IN_PROGRESS');
    assert.equal(deleteDocumentDuringDelete.status, 409);
    assert.equal(deleteDocumentDuringDelete.body.reason, 'DOCUMENT_DELETE_IN_PROGRESS');
    assert.equal(get().prepare('SELECT COUNT(*) AS count FROM task_documents WHERE task_id = ?')
      .get(taskId).count, 0);
    const del = await deletion;
    assert.equal(del.status, 200);
    assert.equal(del.body.data.folder_deleted, true);
  } finally {
    await Promise.all([h.close(), memberHarness.close()]);
    if (previousStoragePath === undefined) delete process.env.DOCUMENT_STORAGE_LOCAL_PATH;
    else process.env.DOCUMENT_STORAGE_LOCAL_PATH = previousStoragePath;
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

function seedMember(prefix) {
  return get().prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, 'hash', 'member')
  `).run(`${prefix}-${randomUUID()}`, prefix).lastInsertRowid;
}

function insertFolderDocument(folderId, createdBy, visibility, name = `doc-${randomUUID()}`) {
  return get().prepare(`
    INSERT INTO family_documents
      (name, original_name, mime_type, file_size, content_data, category, visibility, status, folder_id, created_by)
    VALUES (?, ?, 'text/plain', 1, ?, 'other', ?, 'active', ?, ?)
  `).run(name, `${name}.txt`, Buffer.from('x'), visibility, folderId, createdBy).lastInsertRowid;
}

test('the delete-impact snapshot ignores every change to documents the caller cannot see (#1355)', async () => {
  const memberId = seedMember('snapshot-member');
  const ownerId = seedMember('snapshot-owner');
  const memberHarness = createHarness({ userId: memberId, role: 'member' });
  const adminHarness = createHarness();
  try {
    const folder = await adminHarness.call('POST', '/folders', { name: `Hidden-activity-${randomUUID()}` });
    const folderId = folder.body.data.id;
    insertFolderDocument(folderId, memberId, 'family');
    const preview = async () => {
      const impact = await memberHarness.call('GET', `/folders/${folderId}/delete-impact`);
      assert.equal(impact.status, 200);
      return impact.body.data.snapshot;
    };
    const before = await preview();

    // added
    const hiddenId = insertFolderDocument(folderId, ownerId, 'private');
    assert.equal(await preview(), before, 'adding a hidden document must not change the snapshot');
    // changed
    get().prepare("UPDATE family_documents SET name = 'renamed hidden' WHERE id = ?").run(hiddenId);
    assert.equal(await preview(), before, 'changing a hidden document must not change the snapshot');
    // linked
    const taskId = get().prepare("INSERT INTO tasks (title, created_by) VALUES ('Hidden link', ?)")
      .run(ownerId).lastInsertRowid;
    get().prepare('INSERT INTO task_documents (task_id, document_id, created_by) VALUES (?, ?, ?)')
      .run(taskId, hiddenId, ownerId);
    assert.equal(await preview(), before, 'linking a hidden document must not change the snapshot');
    // removed
    get().prepare('DELETE FROM family_documents WHERE id = ?').run(hiddenId);
    assert.equal(await preview(), before, 'removing a hidden document must not change the snapshot');

    // Gegenprobe: ein SICHTBARES neues Dokument aendert ihn weiterhin.
    insertFolderDocument(folderId, ownerId, 'family');
    assert.notEqual(await preview(), before, 'a visible change must still change the snapshot');
  } finally {
    await Promise.all([memberHarness.close(), adminHarness.close()]);
  }
});

test('a branch the caller may not delete answers 403 before any 409 content check (#1355)', async () => {
  const memberId = seedMember('race-member');
  const ownerId = seedMember('race-owner');
  const memberHarness = createHarness({ userId: memberId, role: 'member' });
  try {
    const folder = await memberHarness.call('POST', '/folders', { name: `Race-${randomUUID()}` });
    const folderId = folder.body.data.id;
    const ownedId = insertFolderDocument(folderId, memberId, 'family');
    const impact = await memberHarness.call('GET', `/folders/${folderId}/delete-impact`);
    assert.equal(impact.body.data.can_delete_documents, true);
    const query = `/folders/${folderId}?documents=delete`
      + `&expected_documents=${impact.body.data.documents}`
      + `&expected_folders=${impact.body.data.removed_folders}`
      + `&expected_snapshot=${impact.body.data.snapshot}`;

    // Nach der Vorschau kommt ein fuer das Mitglied unsichtbares Dokument dazu.
    const hiddenId = insertFolderDocument(folderId, ownerId, 'private');
    const hiddenRace = await memberHarness.call('DELETE', query);
    assert.equal(hiddenRace.status, 403, 'an invisible late document must not surface as 409');
    assert.equal(hiddenRace.body.reason, 'FOLDER_DOCUMENTS_NOT_MANAGEABLE');
    get().prepare('DELETE FROM family_documents WHERE id = ?').run(hiddenId);

    // Ein sichtbares, fremdes Dokument (nicht verwaltbar) darf ebenso kein 409 sein.
    const foreignId = insertFolderDocument(folderId, ownerId, 'family');
    const foreignRace = await memberHarness.call('DELETE', query);
    assert.equal(foreignRace.status, 403);
    assert.equal(foreignRace.body.reason, 'FOLDER_DOCUMENTS_NOT_MANAGEABLE');
    get().prepare('DELETE FROM family_documents WHERE id = ?').run(foreignId);

    // Ein sichtbares, eigenes Dokument nach der Vorschau bleibt ein 409.
    const lateOwnId = insertFolderDocument(folderId, memberId, 'family');
    const visibleRace = await memberHarness.call('DELETE', query);
    assert.equal(visibleRace.status, 409);
    assert.equal(visibleRace.body.reason, 'FOLDER_CONTENT_CHANGED');

    assert.equal(get().prepare('SELECT COUNT(*) AS count FROM family_documents WHERE id IN (?, ?)')
      .get(ownedId, lateOwnId).count, 2, 'no refused request may delete anything');
    assert.ok(get().prepare('SELECT id FROM family_document_folders WHERE id = ?').get(folderId));
  } finally {
    await memberHarness.close();
  }
});

test('unfile is not blocked by somebody else\'s single-document delete in progress (#1355)', async () => {
  const { lockDocumentDeletes, unlockDocumentDeletes } = await import('../server/services/document-deletion-lock.js');
  const memberId = seedMember('unfile-member');
  const ownerId = seedMember('unfile-owner');
  const memberHarness = createHarness({ userId: memberId, role: 'member' });
  const lockedIds = [];
  try {
    const folder = await memberHarness.call('POST', '/folders', { name: `Unfile-lock-${randomUUID()}` });
    const folderId = folder.body.data.id;
    const visibleId = insertFolderDocument(folderId, ownerId, 'family');
    const hiddenId = insertFolderDocument(folderId, ownerId, 'private');
    // Die Einzel-Loeschung (DELETE /:id) haelt ihre Sperre ueber den ganzen
    // asynchronen Storage-Aufruf - genau dieses Fenster wird hier gehalten.
    lockedIds.push(visibleId, hiddenId);
    lockDocumentDeletes(lockedIds);

    const impact = await memberHarness.call('GET', `/folders/${folderId}/delete-impact`);
    const destructive = await memberHarness.call('DELETE',
      `/folders/${folderId}?documents=delete&expected_snapshot=${impact.body.data.snapshot}`);
    assert.equal(destructive.status, 403, 'the destructive mode keeps its gates');

    const unfile = await memberHarness.call('DELETE',
      `/folders/${folderId}?documents=unfile`
      + `&expected_documents=${impact.body.data.documents}&expected_folders=${impact.body.data.removed_folders}`);
    assert.equal(unfile.status, 200, 'a locked (possibly hidden) document must not refuse the unfile');
    assert.equal(unfile.body.data.unfiled_documents, 1);
    assert.equal(get().prepare('SELECT id FROM family_document_folders WHERE id = ?').get(folderId), undefined);
    const rows = get().prepare('SELECT id, folder_id FROM family_documents WHERE id IN (?, ?) ORDER BY id')
      .all(visibleId, hiddenId);
    assert.deepEqual(rows.map((row) => row.folder_id), [null, null]);
  } finally {
    unlockDocumentDeletes(lockedIds);
    await memberHarness.close();
  }
});

test('destructive delete still waits for a single-document delete in progress (#1355)', async () => {
  const { lockDocumentDeletes, unlockDocumentDeletes } = await import('../server/services/document-deletion-lock.js');
  const h = createHarness();
  let documentId = null;
  try {
    const folder = await h.call('POST', '/folders', { name: `Delete-lock-${randomUUID()}` });
    documentId = insertFolderDocument(folder.body.data.id, ADMIN_ID, 'family');
    const impact = await h.call('GET', `/folders/${folder.body.data.id}/delete-impact`);
    lockDocumentDeletes([documentId]);
    const del = await h.call('DELETE',
      `/folders/${folder.body.data.id}?documents=delete&expected_snapshot=${impact.body.data.snapshot}`);
    assert.equal(del.status, 409);
    assert.equal(del.body.reason, 'FOLDER_DELETE_IN_PROGRESS');
    assert.ok(get().prepare('SELECT id FROM family_documents WHERE id = ?').get(documentId));
  } finally {
    unlockDocumentDeletes([documentId]);
    await h.close();
  }
});

test('DELETE /folders/:id returns 404 for unknown id', async () => {
  const h = createHarness();
  try {
    const del = await h.call('DELETE', '/folders/999999');
    assert.equal(del.status, 404);
  } finally {
    await h.close();
  }
});

// --------------------------------------------------------
// Ein Ordner darf in einem Ordner liegen (#785)
// --------------------------------------------------------

/** Legt einen Ordner an und gibt seine Zeile zurueck. */
async function mkFolder(h, name, parentId) {
  const res = await h.call('POST', '/folders', { name, parent_id: parentId });
  assert.equal(res.status, 201, `anlegen von ${name} schlug fehl: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

test('ein Ordner kann unter einem anderen liegen', async () => {
  const h = createHarness();
  try {
    const wohnung = await mkFolder(h, `Wohnung-${randomUUID()}`);
    const miete = await mkFolder(h, 'Miete', wohnung.id);

    assert.equal(miete.parent_id, wohnung.id);

    const list = await h.call('GET', '/folders');
    const found = list.body.data.find((f) => f.id === miete.id);
    assert.equal(found.parent_id, wohnung.id, 'die Liste muss parent_id mitliefern - sonst baut niemand den Baum');
  } finally {
    await h.close();
  }
});

test('derselbe Name darf unter verschiedenen Eltern stehen', async () => {
  const h = createHarness();
  try {
    // Das ist der Grund fuer den Tabellen-Neubau in v164: mit dem alten
    // globalen UNIQUE(name) waere der zweite Aufruf ein 409 gewesen, und ein
    // Baum, in dem jeder Name nur einmal im Haushalt vorkommen darf, ist keiner.
    const auto = await mkFolder(h, `Auto-${randomUUID()}`);
    const wohnung = await mkFolder(h, `Wohnung-${randomUUID()}`);

    const a = await mkFolder(h, 'Rechnungen', auto.id);
    const b = await mkFolder(h, 'Rechnungen', wohnung.id);

    assert.notEqual(a.id, b.id);
  } finally {
    await h.close();
  }
});

test('derselbe Name unter DEMSELBEN Elternteil bleibt abgewiesen', async () => {
  const h = createHarness();
  try {
    const auto = await mkFolder(h, `Auto-${randomUUID()}`);
    await mkFolder(h, 'Rechnungen', auto.id);

    const zweite = await h.call('POST', '/folders', { name: 'Rechnungen', parent_id: auto.id });
    assert.equal(zweite.status, 409);
  } finally {
    await h.close();
  }
});

test('ein Ordner kann nicht in sich selbst oder in sein eigenes Kind wandern', async () => {
  const h = createHarness();
  try {
    // Ohne diese Absage schneidet der Zweig sich vom Baum ab: er waere in
    // keiner Ansicht mehr erreichbar, aber weiter da.
    const oben = await mkFolder(h, `Oben-${randomUUID()}`);
    const mitte = await mkFolder(h, 'Mitte', oben.id);
    const unten = await mkFolder(h, 'Unten', mitte.id);

    assert.equal((await h.call('PUT', `/folders/${oben.id}`, { parent_id: oben.id })).status, 400);
    assert.equal((await h.call('PUT', `/folders/${oben.id}`, { parent_id: mitte.id })).status, 400);
    assert.equal((await h.call('PUT', `/folders/${oben.id}`, { parent_id: unten.id })).status, 400,
      'auch der ENKEL ist ein eigener Nachfahre - eine Pruefung nur auf das direkte Kind reicht nicht');

    // Die Gegenprobe: nach oben verschieben bleibt erlaubt.
    assert.equal((await h.call('PUT', `/folders/${unten.id}`, { parent_id: oben.id })).status, 200);
  } finally {
    await h.close();
  }
});

test('umbenennen allein laesst den Ordner stehen, wo er ist', async () => {
  const h = createHarness();
  try {
    // Ein Feld, das nicht mitkommt, ist keine Ansage. Ohne diese Trennung
    // naehme jedes Umbenennen den Ordner an die Wurzel mit.
    const oben = await mkFolder(h, `Oben-${randomUUID()}`);
    const kind = await mkFolder(h, 'Kind', oben.id);

    const res = await h.call('PUT', `/folders/${kind.id}`, { name: 'Anders' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.name, 'Anders');
    assert.equal(res.body.data.parent_id, oben.id);
  } finally {
    await h.close();
  }
});

test('parent_id: null holt einen Ordner an die Wurzel zurueck', async () => {
  const h = createHarness();
  try {
    const oben = await mkFolder(h, `Oben-${randomUUID()}`);
    const kind = await mkFolder(h, `Kind-${randomUUID()}`, oben.id);

    const res = await h.call('PUT', `/folders/${kind.id}`, { parent_id: null });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.parent_id, null);
  } finally {
    await h.close();
  }
});

test('die Tiefe ist begrenzt - und der ganze Zweig zaehlt mit', async () => {
  const h = createHarness();
  try {
    // Fuenf Ebenen sind erlaubt, die sechste nicht.
    let parent = null;
    const chain = [];
    for (let i = 0; i < 5; i += 1) {
      const folder = await mkFolder(h, `Ebene${i}-${randomUUID()}`, parent);
      chain.push(folder);
      parent = folder.id;
    }
    const zuTief = await h.call('POST', '/folders', { name: 'Ebene5', parent_id: parent });
    assert.equal(zuTief.status, 400);

    // Und ein dreistufiger Zweig passt nicht mehr unter Ebene 3: gezaehlt wird
    // die HOEHE des verschobenen Teilbaums, nicht nur der eine Ordner.
    const zweigWurzel = await mkFolder(h, `Zweig-${randomUUID()}`);
    const zweigMitte = await mkFolder(h, 'ZweigMitte', zweigWurzel.id);
    await mkFolder(h, 'ZweigBlatt', zweigMitte.id);

    const zuTiefVerschoben = await h.call('PUT', `/folders/${zweigWurzel.id}`, { parent_id: chain[2].id });
    assert.equal(zuTiefVerschoben.status, 400,
      'drei Ebenen unter Ebene 3 waeren sechs - eine Pruefung nur auf den Ordner selbst uebersaehe das');
  } finally {
    await h.close();
  }
});

test('ein Ordner zeigt auch die Dokumente seiner Unterordner', async () => {
  const h = createHarness();
  try {
    const wohnung = await mkFolder(h, `Wohnung-${randomUUID()}`);
    const miete = await mkFolder(h, 'Miete', wohnung.id);

    // Direkt in die Tabelle: der Upload-Weg braucht eine echte Datei, und die
    // Frage hier ist die Filterung, nicht das Hochladen.
    const insert = get().prepare(`
      INSERT INTO family_documents (name, category, status, visibility, original_name,
                                    mime_type, file_size, content_data, folder_id, created_by)
      VALUES (?, 'home', 'active', 'family', 'x.pdf', 'application/pdf', 1, 'x', ?, ?)
    `);
    insert.run(`Mietvertrag-${randomUUID()}`, miete.id, ADMIN_ID);

    // Wer "Wohnung" oeffnet, hat das Dokument in "Wohnung/Miete" abgelegt -
    // eine leere Ansicht waere die falsche Antwort.
    const res = await h.call('GET', `/?folder_id=${wohnung.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 1);
  } finally {
    await h.close();
  }
});

test('ein unbekannter Ordner zeigt nichts - nicht alles', async () => {
  const h = createHarness();
  try {
    const insert = get().prepare(`
      INSERT INTO family_documents (name, category, status, visibility, original_name,
                                    mime_type, file_size, content_data, created_by)
      VALUES (?, 'home', 'active', 'family', 'x.pdf', 'application/pdf', 1, 'x', ?)
    `);
    insert.run(`Ohne-Ordner-${randomUUID()}`, ADMIN_ID);

    // Der gefaehrliche Ausgang waere, dass eine leere Teilbaumliste zu "kein
    // Filter" wird und die Antwort ALLE Dokumente zeigt - also mehr, nicht
    // weniger, als gefragt war.
    const res = await h.call('GET', '/?folder_id=999999');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, []);
  } finally {
    await h.close();
  }
});

test('ein geloeschter Ordner nimmt seinen Zweig mit - aber kein Dokument', async () => {
  const h = createHarness();
  try {
    const wohnung = await mkFolder(h, `Wohnung-${randomUUID()}`);
    const miete = await mkFolder(h, 'Miete', wohnung.id);

    const name = `Mietvertrag-${randomUUID()}`;
    get().prepare(`
      INSERT INTO family_documents (name, category, status, visibility, original_name,
                                    mime_type, file_size, content_data, folder_id, created_by)
      VALUES (?, 'home', 'active', 'family', 'x.pdf', 'application/pdf', 1, 'x', ?, ?)
    `).run(name, miete.id, ADMIN_ID);

    const res = await h.call('DELETE', `/folders/${wohnung.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.removed_folders, 2, 'die Antwort muss sagen, was mitging');
    assert.equal(res.body.data.unfiled_documents, 1);

    // Der Unterordner ist weg (CASCADE) ...
    const list = await h.call('GET', '/folders');
    assert.ok(!list.body.data.some((f) => f.id === miete.id));

    // ... das Dokument nicht. Das ist die aeltere Zusicherung dieser Route und
    // die Untergrenze des ganzen Moduls: kein Loeschen kostet ein Dokument.
    const doc = get().prepare('SELECT folder_id FROM family_documents WHERE name = ?').get(name);
    assert.ok(doc, 'das Dokument darf nicht mitgeloescht werden');
    assert.equal(doc.folder_id, null, 'es landet unter "ohne Ordner"');
  } finally {
    await h.close();
  }
});

test('ein Modulordner behaelt seinen Schluessel, wenn er verschoben wird', async () => {
  const h = createHarness();
  try {
    // Der Schluessel traegt die IDENTITAET (v157), nicht die Position - sonst
    // verloeren sechs Module ihren Ablageort, sobald jemand aufraeumt.
    const ablage = await mkFolder(h, `Ablage-${randomUUID()}`);
    const belege = get().prepare(
      'INSERT INTO family_document_folders (name, module_key, created_by) VALUES (?, ?, ?)',
    ).run(`Belege-${randomUUID()}`, 'budget', ADMIN_ID);

    const res = await h.call('PUT', `/folders/${belege.lastInsertRowid}`, { parent_id: ablage.id });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.module_key, 'budget');
    assert.equal(res.body.data.parent_id, ablage.id);
  } finally {
    await h.close();
  }
});
