/**
 * Test: Inventar-Buchungsverknuepfungen (Stufe 3)
 * Zweck: End-to-End ueber die echten Items- und Entries-Router. Kern ist
 *        nicht das Verknuepfen selbst, sondern:
 *          - Sichtbarkeit exakt wie Budget selbst (shared: alle sehen alles;
 *            personal: visibility/owner_id, kein Admin-Bypass)
 *          - Verknuepfen einer materialisierten Serieninstanz oder einer
 *            erwarteten (is_pending) Buchung wird abgelehnt
 *          - Entfernen geht nur, was man sehen darf
 *          - Kaufpreis-Vorbelegung nur beim ERSTEN Link auf eine Buchung
 *          - Ruckrichtung (GET /entries/:entryId/items) filtert wie ein
 *            Einzelabruf
 *          - Cascade in beide Richtungen
 * Ausfuehren: node --experimental-sqlite --test test/test-inventory-item-entries.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: itemsRouter } = await import('../server/routes/inventory/items.js');
const { default: entriesRouter } = await import('../server/routes/inventory/entries.js');
const db = dbmod.get();

const A = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('a','A','x','member')").run().lastInsertRowid;
const B = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('b','B','x','member')").run().lastInsertRowid;

function setMode(mode) {
  db.prepare(`INSERT INTO sync_config (key, value) VALUES ('budget_mode', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(mode);
}
setMode('shared');

let actor = { id: A };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.session = { userId: actor.id };
  // Beide Rechte-Achsen wie requireAuth/applyRoleModuleAccess; ohne Angabe
  // unbeschraenkt, damit die uebrigen Faelle unveraendert laufen.
  req.sessionModuleAccess = actor.moduleAccess ?? null;
  req.authScopes = actor.scopes ?? null;
  next();
});
app.use('/items', itemsRouter);
app.use('/entries', entriesRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());
test.afterEach(() => setMode('shared'));

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

/** Direkter Buchungs-Insert (umgeht die Budget-POST-Validierung fuer Fixtures). */
function insertEntry(fields = {}) {
  const f = {
    title: 'x', amount: -100, category: 'food', date: '2030-01-10',
    is_recurring: 0, recurrence_rule: null, recurrence_parent_id: null,
    is_pending: 0, created_by: A, owner_id: A, visibility: 'shared', ...fields,
  };
  return db.prepare(`
    INSERT INTO budget_entries
      (title, amount, category, date, is_recurring, recurrence_rule, recurrence_parent_id,
       is_pending, created_by, owner_id, visibility)
    VALUES (@title,@amount,@category,@date,@is_recurring,@recurrence_rule,@recurrence_parent_id,
       @is_pending,@created_by,@owner_id,@visibility)
  `).run(f).lastInsertRowid;
}

async function createItem(fields = {}, options = {}) {
  const res = await call('POST', '/items', { body: { name: 'Espressomaschine', ...fields }, ...options });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

// ── POST /items/:id/entries ────────────────────────────────────────────

test('POST /items/:id/entries: verknuepft eine sichtbare Buchung', async () => {
  const entry = insertEntry({ title: 'Laptop', amount: -899 });
  const item = await createItem();

  const r = await call('POST', `/items/${item.id}/entries`, { body: { entry_id: entry } });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.linked_entries.length, 1);
  assert.equal(r.body.data.linked_entries[0].entry_id, entry);
  assert.equal(r.body.data.linked_entries[0].role, 'purchase');
  assert.equal(r.body.data.linked_entries_total, -899);
});

test('POST /items/:id/entries: unbekannte/unsichtbare Buchung -> 404', async () => {
  const item = await createItem();
  const r = await call('POST', `/items/${item.id}/entries`, { body: { entry_id: 999999 } });
  assert.equal(r.status, 404);
});

test('POST /items/:id/entries: materialisierte Serieninstanz wird abgelehnt', async () => {
  const parent = insertEntry({ title: 'Serie', is_recurring: 1 });
  const instance = insertEntry({ title: 'Serie (Instanz)', recurrence_parent_id: parent });
  const item = await createItem();

  const r = await call('POST', `/items/${item.id}/entries`, { body: { entry_id: instance } });
  assert.equal(r.status, 400);
});

test('POST /items/:id/entries: erwartete (is_pending) Buchung wird abgelehnt', async () => {
  const entry = insertEntry({ title: 'Erwartet', is_pending: 1 });
  const item = await createItem();

  const r = await call('POST', `/items/${item.id}/entries`, { body: { entry_id: entry } });
  assert.equal(r.status, 400);
});

test('POST /items/:id/entries: doppelte (Gegenstand, Buchung, Rolle) -> 409', async () => {
  const entry = insertEntry({ title: 'Doppelt' });
  const item = await createItem();
  await call('POST', `/items/${item.id}/entries`, { body: { entry_id: entry, role: 'purchase' } });

  const r = await call('POST', `/items/${item.id}/entries`, { body: { entry_id: entry, role: 'purchase' } });
  assert.equal(r.status, 409);
});

test('POST /items/:id/entries: gleiche Buchung, andere Rolle ist erlaubt', async () => {
  const entry = insertEntry({ title: 'Kauf plus Reparatur' });
  const item = await createItem();
  await call('POST', `/items/${item.id}/entries`, { body: { entry_id: entry, role: 'purchase' } });

  const r = await call('POST', `/items/${item.id}/entries`, { body: { entry_id: entry, role: 'maintenance' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.linked_entries.length, 2);
});

// ── DELETE /items/:id/entries/:entryId ─────────────────────────────────

test('DELETE /items/:id/entries/:entryId: entfernt die Verknuepfung, Buchung bleibt', async () => {
  const entry = insertEntry({ title: 'Weg damit' });
  const item = await createItem();
  await call('POST', `/items/${item.id}/entries`, { body: { entry_id: entry } });

  const r = await call('DELETE', `/items/${item.id}/entries/${entry}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.linked_entries, []);
  assert.ok(db.prepare('SELECT id FROM budget_entries WHERE id = ?').get(entry));
});

test('DELETE /items/:id/entries/:entryId: entfernt ALLE Rollen fuer dieses Paar', async () => {
  const entry = insertEntry({ title: 'Zwei Rollen' });
  const item = await createItem();
  await call('POST', `/items/${item.id}/entries`, { body: { entry_id: entry, role: 'purchase' } });
  await call('POST', `/items/${item.id}/entries`, { body: { entry_id: entry, role: 'maintenance' } });

  const r = await call('DELETE', `/items/${item.id}/entries/${entry}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.linked_entries, []);
});

// ── Sichtbarkeit (personal-Modus) ───────────────────────────────────────

test('personal-Modus: private Buchung eines anderen Mitglieds bleibt beim Verknuepfen verborgen', async () => {
  setMode('personal');
  const privat = insertEntry({ title: 'Privat', created_by: B, owner_id: B, visibility: 'private' });
  const item = await createItem();

  const r = await call('POST', `/items/${item.id}/entries`, { as: { id: A }, body: { entry_id: privat } });
  assert.equal(r.status, 404); // fuer A unsichtbar
});

test('personal-Modus: eigene private Verknuepfung ist fuer andere unsichtbar im Gesamtbild', async () => {
  setMode('personal');
  const privatA = insertEntry({ title: 'Nur A', owner_id: A, visibility: 'private' });
  const item = await createItem();
  await call('POST', `/items/${item.id}/entries`, { as: { id: A }, body: { entry_id: privatA } });

  const fuerB = await call('GET', `/items/${item.id}`, { as: { id: B } });
  assert.equal(fuerB.status, 200);
  assert.deepEqual(fuerB.body.data.linked_entries, []);
  assert.equal(fuerB.body.data.linked_entries_total, 0);

  const fuerA = await call('GET', `/items/${item.id}`, { as: { id: A } });
  assert.equal(fuerA.body.data.linked_entries.length, 1);
});

test('personal-Modus: Entfernen einer nicht sichtbaren Verknuepfung -> 404, Link bleibt', async () => {
  setMode('personal');
  const privatB = insertEntry({ title: 'Nur B', owner_id: B, visibility: 'private' });
  const item = await createItem();
  await call('POST', `/items/${item.id}/entries`, { as: { id: B }, body: { entry_id: privatB } });

  const r = await call('DELETE', `/items/${item.id}/entries/${privatB}`, { as: { id: A } });
  assert.equal(r.status, 404);

  const fuerB = await call('GET', `/items/${item.id}`, { as: { id: B } });
  assert.equal(fuerB.body.data.linked_entries.length, 1);
});

// ── Kaufpreis-Vorbelegung (POST /items mit entry_id) ────────────────────

test('POST /items mit entry_id: Kaufpreis wird aus der Buchung vorbelegt', async () => {
  const entry = insertEntry({ title: 'Fernseher', amount: -650 });
  const item = await createItem({ entry_id: entry });
  assert.equal(item.purchase_price, 650);
  assert.equal(item.linked_entries.length, 1);
  assert.equal(item.linked_entries[0].role, 'purchase');
});

test('POST /items mit entry_id: zweiter Gegenstand auf derselben Buchung bekommt KEINE Vorbelegung', async () => {
  const entry = insertEntry({ title: 'Sammelrechnung', amount: -300 });
  await createItem({ entry_id: entry });
  const zweiter = await createItem({ name: 'Zweiter Gegenstand', entry_id: entry });
  assert.equal(zweiter.purchase_price, null);
  assert.equal(zweiter.linked_entries.length, 1); // trotzdem verknuepft
});

test('POST /items mit entry_id UND explizitem purchase_price: expliziter Wert gewinnt', async () => {
  const entry = insertEntry({ title: 'Explizit', amount: -500 });
  const item = await createItem({ entry_id: entry, purchase_price: 1 });
  assert.equal(item.purchase_price, 1);
});

test('POST /items mit unbekannter entry_id -> 404, kein Gegenstand wird angelegt', async () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM inventory_items').get().c;
  const r = await call('POST', '/items', { body: { name: 'X', entry_id: 999999 } });
  assert.equal(r.status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM inventory_items').get().c, before);
});

// ── GET /entries/:entryId/items ─────────────────────────────────────────

test('GET /entries/:entryId/items: liefert verknuepfte Gegenstaende', async () => {
  const entry = insertEntry({ title: 'Ruckrichtung' });
  const item = await createItem();
  await call('POST', `/items/${item.id}/entries`, { body: { entry_id: entry } });

  const r = await call('GET', `/entries/${entry}/items`);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.length, 1);
  assert.equal(r.body.data[0].id, item.id);
});

test('GET /entries/:entryId/items: unbekannte/unsichtbare Buchung -> 404', async () => {
  const r = await call('GET', '/entries/999999/items');
  assert.equal(r.status, 404);
});

// ── Cascade ──────────────────────────────────────────────────────────────

test('Gegenstand loeschen entfernt nur die Verknuepfung', async () => {
  const entry = insertEntry({ title: 'Bleibt' });
  const item = await createItem({ entry_id: entry });

  await call('DELETE', `/items/${item.id}`);
  assert.ok(db.prepare('SELECT id FROM budget_entries WHERE id = ?').get(entry));
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM inventory_item_entries WHERE item_id = ?').get(item.id).c, 0);
});

test('Buchung loeschen entfernt nur die Verknuepfung', async () => {
  const entry = insertEntry({ title: 'Verschwindet' });
  const item = await createItem({ entry_id: entry });

  db.prepare('DELETE FROM budget_entries WHERE id = ?').run(entry);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM inventory_item_entries WHERE entry_id = ?').get(entry).c, 0);
  assert.ok(db.prepare('SELECT id FROM inventory_items WHERE id = ?').get(item.id));
});

// ── Budgetrecht: verknuepfte Buchungen folgen dem Leserecht auf `budget` ─
//
// Der Pfad gehoert `inventory`, Titel, Betrag und Datum kommen aber aus
// `budget`. Ohne dessen Leserecht (Mitgliedsrecht ODER Token-Scope) liefert
// der Gegenstand keine Buchungen, die Historie keine Buchungszeilen, und jede
// Geste, die eine Buchung nachschlaegt, antwortet wie bei einer unbekannten.

const NO_BUDGET = { id: A, moduleAccess: { budget: 'none' } };
const TOKEN_NO_BUDGET = { id: A, scopes: ['inventory:write'] };

test('Budgetrecht: mit vollem Recht stehen die Buchungen da (Vorbedingung)', async () => {
  const entry = insertEntry({ title: 'Rechte-Vorbedingung', amount: -250, date: '2030-02-01' });
  const item = await createItem({ entry_id: entry });
  const detail = await call('GET', `/items/${item.id}`);
  assert.equal(detail.body.data.linked_entries.length, 1);
  assert.equal(detail.body.data.linked_entries[0].title, 'Rechte-Vorbedingung');
  // Die Historie fuehrt nur Wartungsrollen; eine Kaufbuchung zaehlt dort nicht.
  const wartung = insertEntry({ title: 'Rechte-Wartung', amount: -40, date: '2030-02-01' });
  assert.equal((await call('POST', `/items/${item.id}/entries`, { body: { entry_id: wartung, role: 'maintenance' } })).status, 201);
  const hist = await call('GET', `/items/${item.id}/history`);
  assert.ok(hist.body.data.timeline.some((row) => row.type === 'budget_entry' && row.label === 'Rechte-Wartung'));
  assert.equal(hist.body.data.total, -40);
});

for (const [name, viewer] of [['budget: none', NO_BUDGET], ['Token ohne budget:read', TOKEN_NO_BUDGET]]) {
  test(`Budgetrecht (${name}): Detail, Liste und Historie liefern keine Buchung`, async () => {
    const entry = insertEntry({ title: `Geheim ${name}`, amount: -777, date: '2030-02-02' });
    const item = await createItem({ entry_id: entry, name: `Gegenstand ${name}` });
    const wartung = insertEntry({ title: `Wartung ${name}`, amount: -40, date: '2030-02-02' });
    assert.equal((await call('POST', `/items/${item.id}/entries`, { body: { entry_id: wartung, role: 'maintenance' } })).status, 201);

    const detail = await call('GET', `/items/${item.id}`, { as: viewer });
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body.data.linked_entries, [], 'keine verknuepfte Buchung');
    assert.equal(detail.body.data.linked_entries_total, 0, 'keine Summe');

    const list = await call('GET', '/items', { as: viewer });
    const row = list.body.data.find((r) => r.id === item.id);
    assert.deepEqual(row.linked_entries, [], 'auch nicht in der Liste');

    const hist = await call('GET', `/items/${item.id}/history`, { as: viewer });
    assert.equal(hist.status, 200);
    assert.equal(hist.body.data.timeline.some((r) => r.type === 'budget_entry'), false, 'keine Buchungszeile in der Historie');
    assert.equal(hist.body.data.total, 0, 'keine Summe in der Historie');
  });

  test(`Budgetrecht (${name}): Nachschlagen einer Buchung antwortet wie bei einer unbekannten`, async () => {
    const entry = insertEntry({ title: `Nachschlag ${name}`, amount: -55, date: '2030-02-03' });
    const item = await createItem();
    const links = () => db.prepare('SELECT COUNT(*) AS c FROM inventory_item_entries WHERE entry_id = ?').get(entry).c;

    assert.equal((await call('POST', `/items/${item.id}/entries`, { as: viewer, body: { entry_id: entry } })).status, 404);
    assert.equal(links(), 0, 'keine Verknuepfung angelegt');

    const before = db.prepare('SELECT COUNT(*) AS c FROM inventory_items').get().c;
    assert.equal((await call('POST', '/items', { as: viewer, body: { name: 'Vorbelegt', entry_id: entry } })).status, 404,
      'die Kaufpreis-Vorbelegung liest den Betrag der Buchung');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM inventory_items').get().c, before);

    assert.equal((await call('GET', `/entries/${entry}/items`, { as: viewer })).status, 404);
  });

  test(`Budgetrecht (${name}): Entfernen einer Verknuepfung antwortet 404, der Link bleibt`, async () => {
    const entry = insertEntry({ title: `Entfernen ${name}`, amount: -12, date: '2030-02-05' });
    const item = await createItem({ entry_id: entry });
    const links = () => db.prepare('SELECT COUNT(*) AS c FROM inventory_item_entries WHERE item_id = ? AND entry_id = ?').get(item.id, entry).c;
    assert.equal(links(), 1, 'Vorbedingung: die Verknuepfung steht');

    const r = await call('DELETE', `/items/${item.id}/entries/${entry}`, { as: viewer });
    assert.equal(r.status, 404, 'wie bei einer unbekannten Buchung');
    assert.equal(links(), 1, 'die Verknuepfung steht noch');
  });
}

test('Budgetrecht: read reicht', async () => {
  const entry = insertEntry({ title: 'Lesend', amount: -30, date: '2030-02-04' });
  const item = await createItem({ entry_id: entry });
  const detail = await call('GET', `/items/${item.id}`, { as: { id: A, moduleAccess: { budget: 'read' } } });
  assert.equal(detail.body.data.linked_entries.length, 1);
  const token = await call('GET', `/items/${item.id}`, { as: { id: A, scopes: ['inventory:read', 'budget:read'] } });
  assert.equal(token.body.data.linked_entries.length, 1);
});
