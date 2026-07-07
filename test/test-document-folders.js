/**
 * Modul: Dokument-Ordner-Routen (#453)
 * Zweck: Umbenennen (PUT) und Löschen (DELETE) von Dokumentordnern inkl.
 *        ON DELETE SET NULL-Invariante: Dokumente behalten ihre Zeile.
 * Ausführen: npm run test:document-folders
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'document-folders-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: documentsRouter } = await import('../server/routes/documents.js');

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

test('DELETE /folders/:id returns 404 for unknown id', async () => {
  const h = createHarness();
  try {
    const del = await h.call('DELETE', '/folders/999999');
    assert.equal(del.status, 404);
  } finally {
    await h.close();
  }
});
