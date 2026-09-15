/**
 * Test: Belege an Budget-Buchungen (#583)
 * Zweck: End-to-End über den echten Budget-Router. Der Kern des Features ist
 *        nicht das Verknüpfen selbst, sondern dass die Sichtbarkeit des
 *        Dokumente-Moduls dabei erhalten bleibt:
 *          - GET / liefert Belege je Eintrag (batch, nur sichtbare)
 *          - POST/PUT nehmen `attachment_document_ids` an
 *          - ein privates Fremd-Dokument ist über die Buchung weder lesbar
 *            (kein Name im Response) noch löschbar (kein Abräumen beim Speichern)
 *          - eine unbekannte/unsichtbare ID wird still verworfen, nicht 400
 *          - PUT ohne das Feld lässt Belege unangetastet
 *          - Serien-PUT fasst Belege nicht an (Beleg gehört zur Buchung)
 *          - Cascade in beide Richtungen (Buchung weg / Dokument weg)
 * Ausführen: node --experimental-sqlite --test test/test-budget-attachments.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: budgetRouter } = await import('../server/routes/budget.js');
const { filterVisibleDocumentIds } = await import('../server/services/document-access.js');
const db = dbmod.get();

const A = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('a','A','x','member')").run().lastInsertRowid;
const B = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('b','B','x','member')").run().lastInsertRowid;
const ADMIN = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run().lastInsertRowid;

db.prepare(`INSERT INTO sync_config (key, value) VALUES ('budget_mode', 'shared')
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();

let actor = { id: A, role: 'member' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authUserId = actor.id; req.authRole = actor.role; req.session = { userId: actor.id }; next(); });
app.use('/', budgetRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, route, { as = { id: A, role: 'member' }, body } = {}) {
  actor = as;
  const headers = {};
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${baseUrl}${route}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 204 o. ä. */ }
  return { status: res.status, body: json };
}

/** Dokument-Fixture. visibility 'family' = für alle sichtbar, 'private' = nur Ersteller. */
function insertDocument({ name, createdBy = A, visibility = 'family' }) {
  return db.prepare(`
    INSERT INTO family_documents
      (name, category, visibility, original_name, mime_type, file_size, content_data, created_by)
    VALUES (?, 'finance', ?, ?, 'application/pdf', 1234, 'data:application/pdf;base64,AA==', ?)
  `).run(name, visibility, `${name}.pdf`, createdBy).lastInsertRowid;
}

function linkedDocumentIds(entryId) {
  return db.prepare('SELECT document_id FROM budget_entry_attachments WHERE entry_id = ? ORDER BY document_id')
    .all(entryId).map((r) => r.document_id);
}

async function createEntry(fields, options = {}) {
  const res = await call('POST', '/', {
    body: { title: 'Einkauf', amount: -25, category: 'food', date: '2030-05-04', ...fields },
    ...options,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

// ── POST ────────────────────────────────────────────────────────────────────────

test('POST /: verknüpft übergebene Dokumente und liefert sie zurück', async () => {
  const doc = insertDocument({ name: 'Kassenbon Mai' });
  const entry = await createEntry({ attachment_document_ids: [doc] });

  assert.equal(entry.attachments.length, 1);
  assert.equal(entry.attachments[0].document_id, doc);
  assert.equal(entry.attachments[0].name, 'Kassenbon Mai');
  assert.equal(entry.attachments[0].mime_type, 'application/pdf');
  assert.deepEqual(linkedDocumentIds(entry.id), [doc]);
});

test('POST /: ohne das Feld bleibt die Buchung ohne Belege', async () => {
  const entry = await createEntry({});
  assert.deepEqual(entry.attachments, []);
});

test('POST /: unbekannte und fremde private IDs werden still verworfen', async () => {
  const fremd = insertDocument({ name: 'Gehaltsabrechnung', createdBy: B, visibility: 'private' });
  // 400 wäre hier die schlechtere Antwort: sie verriete, welche IDs existieren.
  const entry = await createEntry({ attachment_document_ids: [999999, fremd] });
  assert.deepEqual(entry.attachments, []);
  assert.deepEqual(linkedDocumentIds(entry.id), []);
});

test('POST /: mehrere Belege an einer Buchung, Duplikate zusammengefasst', async () => {
  const bon = insertDocument({ name: 'Bon' });
  const rechnung = insertDocument({ name: 'Rechnung' });
  const entry = await createEntry({ attachment_document_ids: [bon, rechnung, bon] });
  assert.equal(entry.attachments.length, 2);
  assert.deepEqual(linkedDocumentIds(entry.id), [bon, rechnung].sort((x, y) => x - y));
});

// ── GET ─────────────────────────────────────────────────────────────────────────

test('GET /: liefert Belege je Eintrag der Monatsliste', async () => {
  const doc = insertDocument({ name: 'Tankquittung' });
  const entry = await createEntry({ date: '2031-02-10', attachment_document_ids: [doc] });
  await createEntry({ date: '2031-02-11' });

  const res = await call('GET', '/?month=2031-02');
  assert.equal(res.status, 200);
  const mit = res.body.data.find((e) => e.id === entry.id);
  const ohne = res.body.data.find((e) => e.id !== entry.id);
  assert.equal(mit.attachments.length, 1);
  assert.equal(mit.attachments[0].name, 'Tankquittung');
  assert.deepEqual(ohne.attachments, []);
});

test('GET /: privater Beleg einer anderen Person bleibt verborgen', async () => {
  // Kern des Sichtbarkeits-Modells: A hängt ein nur ihm sichtbares Dokument an
  // eine geteilte Buchung. B sieht die Buchung, aber weder Name noch Existenz
  // des Belegs.
  const privat = insertDocument({ name: 'Privatrechnung', createdBy: A, visibility: 'private' });
  const entry = await createEntry({ date: '2031-03-05', attachment_document_ids: [privat] });

  const fuerA = await call('GET', '/?month=2031-03', { as: { id: A, role: 'member' } });
  assert.equal(fuerA.body.data.find((e) => e.id === entry.id).attachments.length, 1);

  const fuerB = await call('GET', '/?month=2031-03', { as: { id: B, role: 'member' } });
  assert.deepEqual(fuerB.body.data.find((e) => e.id === entry.id).attachments, []);

  // Auch Admins nicht: das Dokumente-Modul kennt keinen Admin-Bypass.
  const fuerAdmin = await call('GET', '/?month=2031-03', { as: { id: ADMIN, role: 'admin' } });
  assert.deepEqual(fuerAdmin.body.data.find((e) => e.id === entry.id).attachments, []);
});

test('GET /: restricted-Dokument nur für freigegebene Mitglieder', async () => {
  const doc = insertDocument({ name: 'Steuerbescheid', createdBy: A, visibility: 'restricted' });
  db.prepare('INSERT INTO family_document_access (document_id, user_id) VALUES (?, ?)').run(doc, B);
  const entry = await createEntry({ date: '2031-04-02', attachment_document_ids: [doc] });

  const fuerB = await call('GET', '/?month=2031-04', { as: { id: B, role: 'member' } });
  assert.equal(fuerB.body.data.find((e) => e.id === entry.id).attachments.length, 1);

  const fuerAdmin = await call('GET', '/?month=2031-04', { as: { id: ADMIN, role: 'admin' } });
  assert.deepEqual(fuerAdmin.body.data.find((e) => e.id === entry.id).attachments, []);
});

// ── PUT ─────────────────────────────────────────────────────────────────────────

test('PUT /:id: ersetzt die Beleg-Liste', async () => {
  const alt = insertDocument({ name: 'Alt' });
  const neu = insertDocument({ name: 'Neu' });
  const entry = await createEntry({ attachment_document_ids: [alt] });

  const res = await call('PUT', `/${entry.id}`, { body: { attachment_document_ids: [neu] } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.attachments.map((a) => a.document_id), [neu]);
  assert.deepEqual(linkedDocumentIds(entry.id), [neu]);
});

test('PUT /:id: leeres Array entfernt alle eigenen Belege', async () => {
  const doc = insertDocument({ name: 'Weg damit' });
  const entry = await createEntry({ attachment_document_ids: [doc] });

  const res = await call('PUT', `/${entry.id}`, { body: { attachment_document_ids: [] } });
  assert.deepEqual(res.body.data.attachments, []);
  assert.deepEqual(linkedDocumentIds(entry.id), []);
  // Das Dokument selbst bleibt - es lebt im Dokumente-Modul weiter.
  assert.ok(db.prepare('SELECT id FROM family_documents WHERE id = ?').get(doc));
});

test('PUT /:id: ohne das Feld bleiben Belege unangetastet', async () => {
  const doc = insertDocument({ name: 'Bleibt' });
  const entry = await createEntry({ attachment_document_ids: [doc] });

  const res = await call('PUT', `/${entry.id}`, { body: { amount: -99 } });
  assert.equal(res.body.data.amount, -99);
  assert.deepEqual(res.body.data.attachments.map((a) => a.document_id), [doc]);
});

test('PUT /:id: fremder privater Beleg überlebt das Speichern durch andere', async () => {
  // Regressions-Guard: B bekommt den privaten Beleg von A nie zu sehen, sein
  // Formular sendet ihn also nicht mit. Ein naives "alles löschen, dann neu
  // setzen" würde ihn dabei stillschweigend abräumen.
  const privatA = insertDocument({ name: 'Nur für A', createdBy: A, visibility: 'private' });
  const gemeinsam = insertDocument({ name: 'Für alle' });
  const entry = await createEntry({ attachment_document_ids: [privatA] });

  const res = await call('PUT', `/${entry.id}`, {
    as: { id: B, role: 'member' },
    body: { attachment_document_ids: [gemeinsam] },
  });
  assert.equal(res.status, 200);
  // B sieht nur seinen eigenen Beleg …
  assert.deepEqual(res.body.data.attachments.map((a) => a.document_id), [gemeinsam]);
  // … A's privater Beleg hängt aber weiterhin dran.
  assert.deepEqual(linkedDocumentIds(entry.id), [privatA, gemeinsam].sort((x, y) => x - y));
});

test('PUT /:id/series: Belege bleiben an der einzelnen Buchung', async () => {
  const doc = insertDocument({ name: 'Serienbeleg' });
  const parent = await createEntry({
    date: '2000-01-15', is_recurring: 1, attachment_document_ids: [doc],
  });

  const res = await call('PUT', `/${parent.id}/series`, { body: { amount: -42 } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.attachments.map((a) => a.document_id), [doc]);
  assert.deepEqual(linkedDocumentIds(parent.id), [doc]);
});

// ── Cascade ─────────────────────────────────────────────────────────────────────

test('DELETE /:id: löscht die Verknüpfung, nicht das Dokument', async () => {
  const doc = insertDocument({ name: 'Überlebt' });
  const entry = await createEntry({ attachment_document_ids: [doc] });

  const res = await call('DELETE', `/${entry.id}`);
  assert.equal(res.status, 204);
  assert.deepEqual(linkedDocumentIds(entry.id), []);
  assert.ok(db.prepare('SELECT id FROM family_documents WHERE id = ?').get(doc));
});

test('gelöschtes Dokument nimmt seine Verknüpfung mit', async () => {
  const doc = insertDocument({ name: 'Verschwindet' });
  const entry = await createEntry({ attachment_document_ids: [doc] });

  db.prepare('DELETE FROM family_documents WHERE id = ?').run(doc);
  assert.deepEqual(linkedDocumentIds(entry.id), []);
  // Die Buchung selbst bleibt bestehen.
  assert.ok(db.prepare('SELECT id FROM budget_entries WHERE id = ?').get(entry.id));
});

// ── Sichtbarkeits-Helfer ────────────────────────────────────────────────────────

test('filterVisibleDocumentIds: filtert, dedupliziert und hält die Reihenfolge', () => {
  const eigen = insertDocument({ name: 'Eigen', createdBy: A, visibility: 'private' });
  const offen = insertDocument({ name: 'Offen' });
  const fremd = insertDocument({ name: 'Fremd', createdBy: B, visibility: 'private' });

  assert.deepEqual(
    filterVisibleDocumentIds(db, [offen, fremd, eigen, offen, 0, -1, 'x', null], A),
    [offen, eigen]
  );
  assert.deepEqual(filterVisibleDocumentIds(db, [], A), []);
  assert.deepEqual(filterVisibleDocumentIds(db, [fremd], A), []);
  assert.deepEqual(filterVisibleDocumentIds(db, [fremd], B), [fremd]);
});
