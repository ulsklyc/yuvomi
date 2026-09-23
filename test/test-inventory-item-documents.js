/**
 * Test: Dokument-Verknuepfungen an Inventar-Gegenstaenden (Stufe 2)
 * Zweck: End-to-End ueber den echten Items-Router. Kern des Features ist
 *        nicht das Verknuepfen selbst (das leistet der geteilte Service),
 *        sondern dass die Sichtbarkeit des Dokumente-Moduls dabei erhalten
 *        bleibt, obwohl Gegenstaende selbst haushaltsweit sichtbar sind:
 *          - GET liefert Belege je Gegenstand (Liste batched, Einzelabruf einzeln)
 *          - POST/PUT nehmen `attachment_document_ids` an
 *          - ein privates Fremd-Dokument ist ueber den Gegenstand weder lesbar
 *            noch loeschbar (kein Abraeumen beim Speichern durch andere)
 *          - eine unbekannte/unsichtbare ID wird still verworfen, nicht 400
 *          - PUT ohne das Feld laesst Belege unangetastet (Ausnahme vom
 *            vollen Replace der uebrigen Felder, siehe items.js)
 *          - Cascade in beide Richtungen (Gegenstand weg / Dokument weg)
 * Ausfuehren: node --experimental-sqlite --test test/test-inventory-item-documents.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: itemsRouter } = await import('../server/routes/inventory/items.js');
const db = dbmod.get();

const A = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('a','A','x','member')").run().lastInsertRowid;
const B = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('b','B','x','member')").run().lastInsertRowid;

let actor = { id: A };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.session = { userId: actor.id };
  req.sessionModuleAccess = actor.moduleAccess ?? null;
  req.authMethod = actor.authMethod;
  req.authScopes = actor.authScopes ?? null;
  next();
});
app.use('/items', itemsRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, path, { as = { id: A }, body } = {}) {
  actor = as;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204/leer */ }
  return { status: res.status, body: json };
}

/** Dokument-Fixture. visibility 'family' = fuer alle sichtbar, 'private' = nur Ersteller. */
function insertDocument({ name, createdBy = A, visibility = 'family' }) {
  return db.prepare(`
    INSERT INTO family_documents
      (name, category, visibility, original_name, mime_type, file_size, content_data, created_by)
    VALUES (?, 'warranty', ?, ?, 'application/pdf', 1234, 'data:application/pdf;base64,AA==', ?)
  `).run(name, visibility, `${name}.pdf`, createdBy).lastInsertRowid;
}

function linkedDocumentIds(itemId) {
  return db.prepare('SELECT document_id FROM inventory_item_documents WHERE item_id = ? ORDER BY document_id')
    .all(itemId).map((r) => r.document_id);
}

async function createItem(fields, options = {}) {
  const res = await call('POST', '/items', { body: { name: 'Espressomaschine', ...fields }, ...options });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

// ── POST ────────────────────────────────────────────────────────────────────────

test('POST /items: verknuepft uebergebene Dokumente und liefert sie zurueck', async () => {
  const doc = insertDocument({ name: 'Kaufbeleg' });
  const item = await createItem({ attachment_document_ids: [doc] });

  assert.equal(item.attachments.length, 1);
  assert.equal(item.attachments[0].document_id, doc);
  assert.equal(item.attachments[0].name, 'Kaufbeleg');
  assert.deepEqual(linkedDocumentIds(item.id), [doc]);
});

test('POST /items: ohne das Feld bleibt der Gegenstand ohne Belege', async () => {
  const item = await createItem({});
  assert.deepEqual(item.attachments, []);
});

test('POST /items: unbekannte und fremde private IDs werden still verworfen', async () => {
  const fremd = insertDocument({ name: 'Privatsache', createdBy: B, visibility: 'private' });
  const item = await createItem({ attachment_document_ids: [999999, fremd] });
  assert.deepEqual(item.attachments, []);
  assert.deepEqual(linkedDocumentIds(item.id), []);
});

// ── GET ─────────────────────────────────────────────────────────────────────────

test('GET /items: liefert Belege je Gegenstand der Liste (batched)', async () => {
  const doc = insertDocument({ name: 'Garantiekarte' });
  const mit = await createItem({ name: 'Mit Beleg', attachment_document_ids: [doc] });
  await createItem({ name: 'Ohne Beleg' });

  const res = await call('GET', '/items');
  assert.equal(res.status, 200);
  const rowMit = res.body.data.find((i) => i.id === mit.id);
  const rowOhne = res.body.data.find((i) => i.name === 'Ohne Beleg');
  assert.equal(rowMit.attachments.length, 1);
  assert.equal(rowMit.attachments[0].name, 'Garantiekarte');
  assert.deepEqual(rowOhne.attachments, []);
});

test('GET /items/:id: liefert Belege einzeln, sichtbarkeitsgefiltert', async () => {
  const doc = insertDocument({ name: 'Einzelbeleg' });
  const item = await createItem({ attachment_document_ids: [doc] });

  const res = await call('GET', `/items/${item.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.attachments.length, 1);
});

test('GET /items: privater Beleg einer anderen Person bleibt verborgen, Gegenstand selbst nicht', async () => {
  // Kern des Sichtbarkeitsmodells (Design-Doc, Abschnitt 3): der Gegenstand
  // ist haushaltsweit sichtbar, der verknuepfte private Beleg nicht.
  const privat = insertDocument({ name: 'Nur fuer A', createdBy: A, visibility: 'private' });
  const item = await createItem({ attachment_document_ids: [privat] });

  const fuerA = await call('GET', `/items/${item.id}`, { as: { id: A } });
  assert.equal(fuerA.body.data.attachments.length, 1);

  const fuerB = await call('GET', `/items/${item.id}`, { as: { id: B } });
  assert.equal(fuerB.status, 200); // Gegenstand selbst bleibt sichtbar ...
  assert.deepEqual(fuerB.body.data.attachments, []); // ... der Beleg nicht.
});

// ── PUT ─────────────────────────────────────────────────────────────────────────

test('PUT /items/:id: ersetzt die Beleg-Liste', async () => {
  const alt = insertDocument({ name: 'Alt' });
  const neu = insertDocument({ name: 'Neu' });
  const item = await createItem({ attachment_document_ids: [alt] });

  const res = await call('PUT', `/items/${item.id}`, { body: { name: item.name, attachment_document_ids: [neu] } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.attachments.map((a) => a.document_id), [neu]);
  assert.deepEqual(linkedDocumentIds(item.id), [neu]);
});

test('PUT /items/:id: leeres Array entfernt alle eigenen Belege', async () => {
  const doc = insertDocument({ name: 'Weg damit' });
  const item = await createItem({ attachment_document_ids: [doc] });

  const res = await call('PUT', `/items/${item.id}`, { body: { name: item.name, attachment_document_ids: [] } });
  assert.deepEqual(res.body.data.attachments, []);
  assert.deepEqual(linkedDocumentIds(item.id), []);
  // Das Dokument selbst bleibt - es lebt im Dokumente-Modul weiter.
  assert.ok(db.prepare('SELECT id FROM family_documents WHERE id = ?').get(doc));
});

test('PUT /items/:id: ohne das Feld bleiben Belege unangetastet', async () => {
  const doc = insertDocument({ name: 'Bleibt' });
  const item = await createItem({ attachment_document_ids: [doc] });

  const res = await call('PUT', `/items/${item.id}`, { body: { name: item.name, purchase_price: 42 } });
  assert.equal(res.body.data.purchase_price, 42);
  assert.deepEqual(res.body.data.attachments.map((a) => a.document_id), [doc]);
});

test('PUT /items/:id: fremder privater Beleg ueberlebt das Speichern durch andere', async () => {
  // Regressions-Guard: B bekommt A's privaten Beleg nie zu sehen, sein
  // Formular sendet ihn also nicht mit. Ein naives "alles loeschen, dann neu
  // setzen" wuerde ihn dabei stillschweigend abraeumen.
  const privatA = insertDocument({ name: 'Nur fuer A', createdBy: A, visibility: 'private' });
  const gemeinsam = insertDocument({ name: 'Fuer alle' });
  const item = await createItem({ attachment_document_ids: [privatA] });

  const res = await call('PUT', `/items/${item.id}`, {
    as: { id: B },
    body: { name: item.name, attachment_document_ids: [gemeinsam] },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.attachments.map((a) => a.document_id), [gemeinsam]);
  assert.deepEqual(linkedDocumentIds(item.id), [privatA, gemeinsam].sort((x, y) => x - y));
});

// ── Cascade ─────────────────────────────────────────────────────────────────────

test('DELETE /items/:id: loescht die Verknuepfung, nicht das Dokument', async () => {
  const doc = insertDocument({ name: 'Ueberlebt' });
  const item = await createItem({ attachment_document_ids: [doc] });

  const res = await call('DELETE', `/items/${item.id}`);
  assert.equal(res.status, 204);
  assert.deepEqual(linkedDocumentIds(item.id), []);
  assert.ok(db.prepare('SELECT id FROM family_documents WHERE id = ?').get(doc));
});

test('geloeschtes Dokument nimmt seine Verknuepfung mit', async () => {
  const doc = insertDocument({ name: 'Verschwindet' });
  const item = await createItem({ attachment_document_ids: [doc] });

  db.prepare('DELETE FROM family_documents WHERE id = ?').run(doc);
  assert.deepEqual(linkedDocumentIds(item.id), []);
  // Der Gegenstand selbst bleibt bestehen.
  assert.ok(db.prepare('SELECT id FROM inventory_items WHERE id = ?').get(item.id));
});

// ── Dokumentenrecht (#1358) ─────────────────────────────────────────────────────
// Der Beleg ist eine Zeile des Dokumente-Moduls. Wer es nicht lesen darf
// (Mitgliedsrecht `documents: none` oder ein Token ohne documents:read),
// bekommt keinen Beleg (`attachments` ist `null`, auch keine Anzahl), und jede ID, die er verknuepfen will, antwortet
// mit derselben 403 - sonst waere die Antwort ein Orakel.

const NONE = { id: A, moduleAccess: { documents: 'none' } };
const TOKEN = { id: A, authMethod: 'api_token', authScopes: ['inventory:write'] };
const TOKEN_DOCS = { id: A, authMethod: 'api_token', authScopes: ['inventory:write', 'documents:read'] };
// `null` bleibt `null`: ohne Dokumentenrecht gibt es keine Liste, auch keine leere.
const docFields = (list) => (list == null ? list : list.map((a) => ({
  document_id: a.document_id, name: a.name, original_name: a.original_name, mime_type: a.mime_type, file_size: a.file_size,
})));

test('Dokumentenrecht: ohne documents-Lesen kommen keine Belege und keine Anzahl - Liste, Einzelabruf, Verlauf (#1358)', async () => {
  const doc = insertDocument({ name: 'Garantie Recht' });
  const item = await createItem({ name: 'Rechteprobe', attachment_document_ids: [doc] });
  const open = [{ document_id: doc, name: 'Garantie Recht', original_name: 'Garantie Recht.pdf', mime_type: 'application/pdf', file_size: 1234 }];
  const seen = async (as) => {
    const list = await call('GET', '/items', { as });
    const one = await call('GET', `/items/${item.id}`, { as });
    const history = await call('GET', `/items/${item.id}/history`, { as });
    assert.equal(list.status, 200);
    assert.equal(one.status, 200);
    assert.equal(history.status, 200);
    return {
      list: docFields(list.body.data.find((i) => i.id === item.id).attachments),
      one: docFields(one.body.data.attachments),
      history: history.body.data.timeline.filter((row) => row.type === 'document').map((row) => ({ id: row.id, label: row.label })),
    };
  };
  const visible = { list: open, one: open, history: [{ id: doc, label: 'Garantie Recht' }] };
  const masked = { list: null, one: null, history: [] };
  assert.deepEqual(await seen({ id: A }), visible);
  assert.deepEqual(await seen({ ...NONE, moduleAccess: { documents: 'read' } }), visible, 'Leserecht reicht');
  assert.deepEqual(await seen(NONE), masked, 'documents: none sieht keinen Beleg, auch nicht ihre Anzahl');
  assert.deepEqual(await seen(TOKEN), masked, 'ein Token ohne documents-Scope ebenso');
  assert.deepEqual(await seen(TOKEN_DOCS), visible);
});

test('Dokumentenrecht: ohne documents-Lesen verknuepft POST/PUT nichts, jede ID antwortet gleich (#1358)', async () => {
  const doc = insertDocument({ name: 'Garantie Schreiben' });
  const other = insertDocument({ name: 'Garantie Anders' });
  const item = await createItem({ name: 'Schreibprobe', attachment_document_ids: [doc] });
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM inventory_items').get().n;
  for (const [label, as] of [['documents: none', NONE], ['Token ohne documents-Scope', TOKEN]]) {
    const before = count();
    const post = (ids) => call('POST', '/items', { as, body: { name: 'Neu', attachment_document_ids: ids } });
    const valid = await post([other]);
    assert.equal(valid.status, 403, `${label}: POST mit Beleg ist 403`);
    assert.equal(valid.body.code, 403);
    const invalid = await post([987654]);
    assert.deepEqual({ status: invalid.status, body: invalid.body }, { status: 403, body: valid.body }, `${label}: POST gleich`);
    assert.equal(count(), before, `${label}: kein Gegenstand angelegt`);

    const put = (ids) => call('PUT', `/items/${item.id}`, { as, body: { name: 'Schreibprobe', attachment_document_ids: ids } });
    for (const ids of [[other], [doc], [987654]]) {
      const res = await put(ids);
      assert.deepEqual({ status: res.status, body: res.body }, { status: 403, body: valid.body }, `${label}: PUT ${ids}`);
    }
    assert.deepEqual(linkedDocumentIds(item.id), [doc]);
    const kept = await put([]);
    assert.equal(kept.status, 200, `${label}: leere Liste ist kein Verknuepfen`);
    assert.deepEqual(linkedDocumentIds(item.id), [doc], `${label}: und loest nichts`);
  }
  const readable = await call('PUT', `/items/${item.id}`, { as: TOKEN_DOCS, body: { name: 'Schreibprobe', attachment_document_ids: [other] } });
  assert.equal(readable.status, 200);
  assert.deepEqual(linkedDocumentIds(item.id), [other]);
});
