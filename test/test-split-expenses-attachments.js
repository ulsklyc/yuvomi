/**
 * Test: Belege an geteilten Ausgaben (#583, Nachrüstung)
 * Zweck: Das Backend nahm `attachment_document_ids` und `proof_document_id`
 *        entgegen, ohne die Sichtbarkeit des Dokumente-Moduls zu prüfen - und
 *        lieferte Beleg-Namen an jedes Gruppenmitglied aus. Folgenlos, solange
 *        kein Frontend etwas anhängte; mit der UI wäre es ein Leak. Diese Suite
 *        nagelt die Regeln fest:
 *          - verknüpfen und entfernen nur, was die handelnde Person sieht
 *          - ein privater Beleg bleibt für die Gruppe unsichtbar
 *          - PUT ohne das Feld lässt Belege stehen
 *          - proof_document_id einer Zahlung wird gegen die Sichtbarkeit geprüft
 * Ausführen: node --experimental-sqlite --test test/test-split-expenses-attachments.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: splitRouter } = await import('../server/routes/split-expenses.js');
const db = dbmod.get();

function mkUser(username, role = 'member') {
  return db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, 'x', ?)")
    .run(username, username.toUpperCase(), role).lastInsertRowid;
}
const OWNER = mkUser('owner');
const MEM = mkUser('mem');
const ADMIN = mkUser('admin', 'admin');

let actor = { id: OWNER, role: 'member' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/', splitRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, path, { as = { id: OWNER, role: 'member' }, body } = {}) {
  actor = as;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204 */ }
  return { status: res.status, body: json };
}

function insertDocument({ name, createdBy = OWNER, visibility = 'family' }) {
  return db.prepare(`
    INSERT INTO family_documents
      (name, category, visibility, original_name, mime_type, file_size, content_data, created_by)
    VALUES (?, 'finance', ?, ?, 'application/pdf', 999, 'data:application/pdf;base64,AA==', ?)
  `).run(name, visibility, `${name}.pdf`, createdBy).lastInsertRowid;
}

function linkedDocumentIds(expenseId) {
  return db.prepare('SELECT document_id FROM expense_attachments WHERE expense_id = ? ORDER BY document_id')
    .all(expenseId).map((r) => r.document_id);
}

let GROUP;
test('setup: Gruppe mit Owner und Mitglied', async () => {
  const created = await call('POST', '/groups', { body: { name: 'WG', type: 'household', default_currency: 'EUR' } });
  assert.equal(created.status, 201);
  GROUP = created.body.data.id;
  const added = await call('POST', `/groups/${GROUP}/members`, { body: { user_id: MEM, role: 'admin' } });
  assert.equal(added.status, 201);
});

async function createExpense(body, options = {}) {
  const res = await call('POST', `/groups/${GROUP}/expenses`, {
    body: { title: 'Einkauf', amount: '30.00', currency: 'EUR', expense_date: '2030-06-01', ...body },
    ...options,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

test('POST /expenses: verknüpft sichtbare Dokumente und liefert sie zurück', async () => {
  const doc = insertDocument({ name: 'Supermarkt' });
  const expense = await createExpense({ attachment_document_ids: [doc] });
  assert.equal(expense.attachments.length, 1);
  assert.equal(expense.attachments[0].document_id, doc);
  assert.equal(expense.attachments[0].name, 'Supermarkt');
  assert.equal(expense.attachments[0].kind, 'receipt');
});

test('POST /expenses: fremdes privates Dokument wird still verworfen', async () => {
  // Vorher landete jede übergebene ID in der Tabelle - der Name eines geratenen
  // fremden Dokuments wäre über die Ausgabe auslesbar gewesen.
  const fremd = insertDocument({ name: 'Gehalt MEM', createdBy: MEM, visibility: 'private' });
  const expense = await createExpense({ attachment_document_ids: [fremd, 987654] });
  assert.deepEqual(expense.attachments, []);
  assert.deepEqual(linkedDocumentIds(expense.id), []);
});

test('GET /expenses: privater Beleg bleibt vor der übrigen Gruppe verborgen', async () => {
  const privat = insertDocument({ name: 'Privatbeleg', createdBy: OWNER, visibility: 'private' });
  const expense = await createExpense({ title: 'Mit Privatbeleg', attachment_document_ids: [privat] });

  const fuerOwner = await call('GET', `/groups/${GROUP}/expenses`);
  assert.equal(fuerOwner.body.data.find((e) => e.id === expense.id).attachments.length, 1);

  const fuerMem = await call('GET', `/groups/${GROUP}/expenses`, { as: { id: MEM, role: 'member' } });
  assert.deepEqual(fuerMem.body.data.find((e) => e.id === expense.id).attachments, []);

  // Der System-Admin darf die Gruppe sehen (bewusster Bypass), das private
  // Dokument aber nicht - das Dokumente-Modul kennt keinen Admin-Bypass.
  const fuerAdmin = await call('GET', `/groups/${GROUP}/expenses`, { as: { id: ADMIN, role: 'admin' } });
  assert.deepEqual(fuerAdmin.body.data.find((e) => e.id === expense.id).attachments, []);
});

test('PUT /expenses/:id: ersetzt die Beleg-Liste', async () => {
  const alt = insertDocument({ name: 'Alt' });
  const neu = insertDocument({ name: 'Neu' });
  const expense = await createExpense({ attachment_document_ids: [alt] });

  const res = await call('PUT', `/expenses/${expense.id}`, {
    body: { title: 'Einkauf', amount: '30.00', currency: 'EUR', expense_date: '2030-06-01', attachment_document_ids: [neu] },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.attachments.map((a) => a.document_id), [neu]);
});

test('PUT /expenses/:id: ohne das Feld bleiben Belege unangetastet', async () => {
  const doc = insertDocument({ name: 'Bleibt' });
  const expense = await createExpense({ attachment_document_ids: [doc] });

  const res = await call('PUT', `/expenses/${expense.id}`, {
    body: { title: 'Korrigiert', amount: '31.00', currency: 'EUR', expense_date: '2030-06-01' },
  });
  assert.equal(res.body.data.title, 'Korrigiert');
  assert.deepEqual(res.body.data.attachments.map((a) => a.document_id), [doc]);
});

test('PUT /expenses/:id: fremder privater Beleg überlebt das Speichern durch andere', async () => {
  const privatOwner = insertDocument({ name: 'Nur Owner', createdBy: OWNER, visibility: 'private' });
  const gemeinsam = insertDocument({ name: 'Für alle' });
  const expense = await createExpense({ attachment_document_ids: [privatOwner] });

  const res = await call('PUT', `/expenses/${expense.id}`, {
    as: { id: MEM, role: 'member' },
    body: { title: 'Einkauf', amount: '30.00', currency: 'EUR', expense_date: '2030-06-01', attachment_document_ids: [gemeinsam] },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.attachments.map((a) => a.document_id), [gemeinsam]);
  assert.deepEqual(linkedDocumentIds(expense.id), [privatOwner, gemeinsam].sort((x, y) => x - y));
});

test('POST /settlements: übernimmt nur einen sichtbaren Zahlungsnachweis', async () => {
  const sichtbar = insertDocument({ name: 'Überweisung' });
  const ok = await call('POST', `/groups/${GROUP}/settlements`, {
    body: { payer_id: MEM, payee_id: OWNER, amount: '10.00', currency: 'EUR', proof_document_id: sichtbar },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.proof_document_id, sichtbar);

  const fremd = insertDocument({ name: 'Fremd', createdBy: MEM, visibility: 'private' });
  const abgelehnt = await call('POST', `/groups/${GROUP}/settlements`, {
    body: { payer_id: MEM, payee_id: OWNER, amount: '5.00', currency: 'EUR', proof_document_id: fremd },
  });
  assert.equal(abgelehnt.status, 201);
  // Die Zahlung wird gebucht, der fremde Nachweis aber nicht angeheftet.
  assert.equal(abgelehnt.body.data.proof_document_id, null);
});

test('gelöschte Ausgabe und gelöschtes Dokument räumen die Verknüpfung ab', async () => {
  const doc = insertDocument({ name: 'Cascade' });
  const expense = await createExpense({ attachment_document_ids: [doc] });

  db.prepare('DELETE FROM family_documents WHERE id = ?').run(doc);
  assert.deepEqual(linkedDocumentIds(expense.id), []);
  assert.ok(db.prepare('SELECT id FROM expenses WHERE id = ?').get(expense.id));
});
