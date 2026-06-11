/**
 * Modul: Family-Documents-Test
 * Zweck: Validiert die Content-Security-Policy am Preview-Endpunkt — PDFs benötigen
 *        eine gelockerte Policy, damit Chromiums interner PDF-Viewer rendert
 *        (Issue #328: "This page was blocked by Chrome"), nicht-PDFs bleiben strikt.
 * Ausführen: node --experimental-sqlite test/test-documents.js
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3';

process.env.DB_PATH = ':memory:';
const {
  MIGRATIONS,
  get,
  _resetTestDatabase,
  _setTestDatabase,
} = await import('../server/db.js');
const { default: documentsRouter } = await import('../server/routes/documents.js');

function buildTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )`);
  for (const m of MIGRATIONS) {
    if (typeof m.up === 'function') m.up(db); else db.exec(m.up);
    if (typeof m.afterUp === 'function') m.afterUp(db);
    db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(m.version, m.description);
  }
  return db;
}

const db = buildTestDb();
_setTestDatabase(db);

const userId = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('docuser', 'Doc User', '$2b$12$test', 'member')
`).run().lastInsertRowid;

function seedDoc(mime, original) {
  const content = Buffer.from('hello').toString('base64');
  return db.prepare(`
    INSERT INTO family_documents
      (name, category, visibility, original_name, mime_type, file_size, content_data, created_by)
    VALUES (?, 'other', 'family', ?, ?, ?, ?, ?)
  `).run(original, original, mime, 5, content, userId).lastInsertRowid;
}

const pdfId = seedDoc('application/pdf', 'doc.pdf');
const pngId = seedDoc('image/png', 'pic.png');

// Express-App mit injizierter Session aufsetzen
const app = express();
app.use((req, _res, next) => {
  req.authUserId = userId;
  req.authRole = 'member';
  req.session = { userId, role: 'member' };
  next();
});
app.use('/api/v1/documents', documentsRouter);

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

function fetchPreview(id) {
  return fetch(`http://127.0.0.1:${port}/api/v1/documents/${id}/preview`);
}

test('preview CSP: PDF wird mit gelockerter Policy ausgeliefert (Issue #328)', async () => {
  const res = await fetchPreview(pdfId);
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy');
  assert.ok(!csp.includes("default-src 'none'"), 'PDF darf nicht default-src none erhalten');
  assert.ok(csp.includes("default-src 'self'"), 'PDF braucht default-src self für den Viewer');
  // nosniff bleibt als Defense-in-Depth bestehen
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('preview CSP: Nicht-PDFs behalten strikte default-src none Policy', async () => {
  const res = await fetchPreview(pngId);
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp.includes("default-src 'none'"), 'Bilder müssen strikt bleiben');
});

test.after(async () => {
  await new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  db.close();
  _resetTestDatabase();
  get().close();
});
