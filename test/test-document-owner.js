/**
 * Modul: Besitzregel der Dokument-Schreibrouten (#989)
 * Zweck: Sehen heisst nicht aendern. Bearbeiten (PUT /:id), Archivieren
 *        (PATCH /:id/archive) und Loeschen (DELETE /:id) stehen der Person zu,
 *        die das Dokument angelegt hat, und Admins. Einem Mitglied, dem ein
 *        Familien-Dokument nur sichtbar ist, antworten alle drei mit 403 und
 *        lassen die Zeile unberuehrt. Die Ordner-Routen wenden dieselbe Regel
 *        auf einen ganzen Zweig an (test:document-folders).
 * Ausführen: npm run test:document-owner
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'document-owner-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: documentsRouter } = await import('../server/routes/documents.js');

const moduleDatabase = get();
const suiteDatabase = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(suiteDatabase);
moduleDatabase.close();

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

function seedUser(role) {
  return get().prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, 'hash', ?)
  `).run(`document-${role}-${randomUUID()}`, `Document ${role}`, role).lastInsertRowid;
}

const OWNER = seedUser('member');
const MEMBER = seedUser('member');
const ADMIN = seedUser('admin');

/** Ein Familien-Dokument: fuer alle sichtbar, also erreicht jede Anfrage die Besitzpruefung. */
function seedDocument(createdBy) {
  return get().prepare(`
    INSERT INTO family_documents
      (name, original_name, mime_type, file_size, content_data, category, visibility, status, created_by)
    VALUES (?, 'owned.txt', 'text/plain', 5, ?, 'other', 'family', 'active', ?)
  `).run(`Dokument ${randomUUID()}`, Buffer.from('owned'), createdBy).lastInsertRowid;
}

function documentRow(id) {
  return get().prepare('SELECT name, status, created_by FROM family_documents WHERE id = ?').get(id);
}

function createHarness(userId, role) {
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

const WRITES = [
  {
    route: 'PUT /:id',
    send: (h, id) => h.call('PUT', `/${id}`, { name: 'Umbenannt' }),
    status: 200,
    applied: (row) => row?.name === 'Umbenannt',
  },
  {
    route: 'PATCH /:id/archive',
    send: (h, id) => h.call('PATCH', `/${id}/archive`, { archived: true }),
    status: 200,
    applied: (row) => row?.status === 'archived',
  },
  {
    route: 'DELETE /:id',
    send: (h, id) => h.call('DELETE', `/${id}`),
    status: 204,
    applied: (row) => row === undefined,
  },
];

const ACTORS = [
  { who: 'die Person, die es angelegt hat', userId: OWNER, role: 'member' },
  { who: 'ein Admin, auch bei einem fremden Dokument', userId: ADMIN, role: 'admin' },
];

for (const write of WRITES) {
  test(`${write.route}: ein Mitglied, dem das Dokument nur sichtbar ist, bekommt 403`, async () => {
    const id = seedDocument(OWNER);
    const before = documentRow(id);
    const h = createHarness(MEMBER, 'member');
    try {
      const res = await write.send(h, id);
      assert.equal(res.status, 403);
      assert.equal(res.body.error, 'Not authorized.');
      assert.deepEqual(documentRow(id), before, 'die Zeile bleibt unberuehrt');
    } finally {
      await h.close();
    }
  });

  for (const actor of ACTORS) {
    test(`${write.route}: ${actor.who} darf`, async () => {
      const id = seedDocument(OWNER);
      const h = createHarness(actor.userId, actor.role);
      try {
        const res = await write.send(h, id);
        assert.equal(res.status, write.status, JSON.stringify(res.body));
        assert.ok(write.applied(documentRow(id)), 'die Aenderung ist angekommen');
      } finally {
        await h.close();
      }
    });
  }
}
