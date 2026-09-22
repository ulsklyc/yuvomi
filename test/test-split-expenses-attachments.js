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
  req.sessionModuleAccess = actor.moduleAccess ?? null;
  req.authMethod = actor.authMethod;
  req.authScopes = actor.authScopes ?? null;
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

// ── Dokumentenrecht (#1358) ─────────────────────────────────────────────────────
// Beleg und Zahlungsnachweis sind Zeilen des Dokumente-Moduls. Wer es nicht
// lesen darf (Mitgliedsrecht `documents: none` oder ein Token ohne
// documents:read), bekommt weder Namen noch ID, und jede ID, die er verknuepfen
// will, antwortet mit derselben 403 - sonst waere die Antwort ein Orakel.

const NONE = { id: OWNER, role: 'member', moduleAccess: { documents: 'none' } };
const TOKEN = { id: OWNER, role: 'member', authMethod: 'api_token', authScopes: ['budget:write'] };
const TOKEN_DOCS = { id: OWNER, role: 'member', authMethod: 'api_token', authScopes: ['budget:write', 'documents:read'] };
const docFields = (list) => (list || []).map((a) => ({
  document_id: a.document_id, name: a.name, original_name: a.original_name, mime_type: a.mime_type, file_size: a.file_size,
}));
const MASKED = { document_id: null, name: null, original_name: null, mime_type: null, file_size: null };
const expenseBody = (extra = {}) => ({ title: 'Einkauf', amount: '30.00', currency: 'EUR', expense_date: '2030-06-01', ...extra });

test('Dokumentenrecht: ohne documents-Lesen kommen Belege maskiert - Liste und PUT-Antwort (#1358)', async () => {
  const doc = insertDocument({ name: 'Bon Recht' });
  const expense = await createExpense({ title: 'Rechteprobe', attachment_document_ids: [doc] });
  const listed = async (as) => {
    const res = await call('GET', `/groups/${GROUP}/expenses`, { as });
    assert.equal(res.status, 200);
    return docFields(res.body.data.find((e) => e.id === expense.id).attachments);
  };
  const open = [{ document_id: doc, name: 'Bon Recht', original_name: 'Bon Recht.pdf', mime_type: 'application/pdf', file_size: 999 }];
  assert.deepEqual(await listed({ id: OWNER, role: 'member' }), open);
  assert.deepEqual(await listed({ ...NONE, moduleAccess: { documents: 'read' } }), open, 'Leserecht reicht');
  assert.deepEqual(await listed(NONE), [MASKED], 'documents: none sieht nur, dass ein Beleg da ist');
  assert.deepEqual(await listed(TOKEN), [MASKED], 'ein Token ohne documents-Scope ebenso');
  assert.deepEqual(await listed(TOKEN_DOCS), open);

  const put = await call('PUT', `/expenses/${expense.id}`, { as: NONE, body: expenseBody({ title: 'Rechteprobe' }) });
  assert.equal(put.status, 200);
  assert.deepEqual(docFields(put.body.data.attachments), [MASKED], 'PUT-Antwort');
  assert.deepEqual(linkedDocumentIds(expense.id), [doc]);
});

test('Dokumentenrecht: ohne documents-Lesen verknuepft POST/PUT nichts, jede ID antwortet gleich (#1358)', async () => {
  const doc = insertDocument({ name: 'Bon Schreiben' });
  const other = insertDocument({ name: 'Bon Anders' });
  const expense = await createExpense({ title: 'Schreibprobe', attachment_document_ids: [doc] });
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM expenses').get().n;
  for (const [label, as] of [['documents: none', NONE], ['Token ohne documents-Scope', TOKEN]]) {
    const before = count();
    const post = (ids) => call('POST', `/groups/${GROUP}/expenses`, { as, body: expenseBody({ attachment_document_ids: ids }) });
    const valid = await post([other]);
    assert.equal(valid.status, 403, `${label}: POST mit Beleg ist 403`);
    assert.equal(valid.body.code, 403);
    const invalid = await post([987654]);
    assert.deepEqual({ status: invalid.status, body: invalid.body }, { status: 403, body: valid.body }, `${label}: POST gleich`);
    assert.equal(count(), before, `${label}: keine Ausgabe angelegt`);

    const put = (ids) => call('PUT', `/expenses/${expense.id}`, { as, body: expenseBody({ title: 'Schreibprobe', attachment_document_ids: ids }) });
    for (const ids of [[other], [doc], [987654]]) {
      const res = await put(ids);
      assert.deepEqual({ status: res.status, body: res.body }, { status: 403, body: valid.body }, `${label}: PUT ${ids}`);
    }
    assert.deepEqual(linkedDocumentIds(expense.id), [doc]);
    assert.equal((await put([])).status, 200, `${label}: leere Liste ist kein Verknuepfen`);
    assert.deepEqual(linkedDocumentIds(expense.id), [doc], `${label}: und loest nichts`);

    const settle = (proof) => call('POST', `/groups/${GROUP}/settlements`, {
      as, body: { payer_id: MEM, payee_id: OWNER, amount: '1.00', currency: 'EUR', proof_document_id: proof },
    });
    const proofValid = await settle(other);
    assert.deepEqual({ status: proofValid.status, body: proofValid.body }, { status: 403, body: valid.body },
      `${label}: Zahlungsnachweis ist 403`);
    const proofInvalid = await settle(987654);
    assert.deepEqual({ status: proofInvalid.status, body: proofInvalid.body }, { status: 403, body: valid.body },
      `${label}: gueltiger und ungueltiger Nachweis antworten gleich`);
    assert.equal((await settle(null)).status, 201, `${label}: eine Zahlung ohne Nachweis geht`);
  }
  const readable = await call('PUT', `/expenses/${expense.id}`, { as: TOKEN_DOCS, body: expenseBody({ title: 'Schreibprobe', attachment_document_ids: [other] }) });
  assert.equal(readable.status, 200);
  assert.deepEqual(linkedDocumentIds(expense.id), [other]);
});

test('Dokumentenrecht: der Zahlungsnachweis in der Antwort folgt Recht und Sichtbarkeit (#1358)', async () => {
  const privat = insertDocument({ name: 'Nachweis privat', createdBy: OWNER, visibility: 'private' });
  const made = await call('POST', `/groups/${GROUP}/settlements`, {
    body: { payer_id: MEM, payee_id: OWNER, amount: '2.00', currency: 'EUR', proof_document_id: privat },
  });
  assert.equal(made.status, 201);
  assert.equal(made.body.data.proof_document_id, privat, 'die Erstellerin sieht ihren Nachweis');
  // MEM verwaltet die Gruppe und darf stornieren, das private Dokument der
  // Erstellerin sieht er aber nicht - die ID darf ihm die Antwort nicht nennen.
  const reversed = await call('POST', `/groups/${GROUP}/settlements/${made.body.data.id}/reverse`, { as: { id: MEM, role: 'member' } });
  assert.equal(reversed.status, 200);
  assert.equal(reversed.body.data.proof_document_id, null);

  const shared = insertDocument({ name: 'Nachweis Familie' });
  const second = await call('POST', `/groups/${GROUP}/settlements`, {
    body: { payer_id: MEM, payee_id: OWNER, amount: '3.00', currency: 'EUR', proof_document_id: shared },
  });
  const noneReversed = await call('POST', `/groups/${GROUP}/settlements/${second.body.data.id}/reverse`, { as: NONE });
  assert.equal(noneReversed.status, 200);
  assert.equal(noneReversed.body.data.proof_document_id, null, 'documents: none bekommt die ID nicht');
});
