/**
 * Test: Inventar-Erinnerungen (Stufe 4)
 * Zweck: End-to-End über den echten Items-Router - Erinnerungs-Lebenszyklus
 *        (löschen+neu anlegen bei jedem POST/PUT, wie server/routes/subscriptions.js
 *        #syncReminder):
 *          - genau eine Erinnerung, Ersteller = created_by, wenn Kaufdatum +
 *            Garantiemonate vollständig sind und der Erinnerungstermin noch
 *            nicht fällig wäre
 *          - keine Erinnerung ohne vollständige Garantiedaten
 *          - keine Erinnerung, wenn der Erinnerungstermin schon in der
 *            Vergangenheit läge (kein Nachtrags-Nagging bei Altbestand)
 *          - PUT ersetzt die Erinnerung vollständig
 *          - DELETE /items/:id räumt die Erinnerung explizit ab (reminders hat
 *            keinen FK auf inventory_items)
 * Ausführen: node --experimental-sqlite --test test/test-inventory-item-reminders.js
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

let actor = { id: A };
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authUserId = actor.id; req.session = { userId: actor.id }; next(); });
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

function reminderFor(itemId) {
  return db.prepare(
    "SELECT * FROM reminders WHERE entity_type = 'inventory_item' AND entity_id = ?"
  ).get(itemId);
}

// Weit in der Zukunft: der Erinnerungstermin (30 Tage vor Garantieende) liegt sicher noch nicht in der Vergangenheit.
const FUTURE_PURCHASE = '2099-01-01';
// Weit in der Vergangenheit: Garantieende UND Erinnerungstermin liegen längst hinter uns.
const PAST_PURCHASE = '2000-01-01';

test('POST mit vollständigen Garantiedaten legt genau eine Erinnerung an, Ersteller = created_by', async () => {
  const r = await call('POST', '/items', {
    body: { name: 'Kühlschrank', purchase_date: FUTURE_PURCHASE, warranty_months: 24 },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const reminder = reminderFor(r.body.data.id);
  assert.ok(reminder, 'Erinnerung sollte existieren');
  assert.equal(reminder.created_by, A);
  assert.equal(reminder.remind_at, '2100-12-02T09:00');
});

test('POST ohne Kaufdatum oder ohne Garantiemonate legt keine Erinnerung an', async () => {
  const r1 = await call('POST', '/items', { body: { name: 'Ohne Kaufdatum', warranty_months: 12 } });
  assert.equal(r1.status, 201);
  assert.equal(reminderFor(r1.body.data.id), undefined);

  const r2 = await call('POST', '/items', { body: { name: 'Ohne Garantie', purchase_date: FUTURE_PURCHASE } });
  assert.equal(r2.status, 201);
  assert.equal(reminderFor(r2.body.data.id), undefined);
});

test('POST mit längst abgelaufenem Erinnerungstermin legt keine Erinnerung an', async () => {
  const r = await call('POST', '/items', {
    body: { name: 'Alt-Gerät', purchase_date: PAST_PURCHASE, warranty_months: 12 },
  });
  assert.equal(r.status, 201);
  assert.equal(reminderFor(r.body.data.id), undefined);
});

test('PUT ersetzt die Erinnerung vollständig (alte Zeile weg, neue mit anderem Termin da)', async () => {
  const created = await call('POST', '/items', {
    body: { name: 'Waschmaschine', purchase_date: FUTURE_PURCHASE, warranty_months: 12 },
  });
  const firstReminder = reminderFor(created.body.data.id);
  assert.ok(firstReminder);

  const updated = await call('PUT', `/items/${created.body.data.id}`, {
    body: { name: 'Waschmaschine', purchase_date: FUTURE_PURCHASE, warranty_months: 24 },
  });
  assert.equal(updated.status, 200);
  const secondReminder = reminderFor(created.body.data.id);
  assert.ok(secondReminder);
  assert.notEqual(secondReminder.id, firstReminder.id);
  assert.notEqual(secondReminder.remind_at, firstReminder.remind_at);
});

test('PUT das die Garantiemonate entfernt räumt die Erinnerung ab', async () => {
  const created = await call('POST', '/items', {
    body: { name: 'Fernseher', purchase_date: FUTURE_PURCHASE, warranty_months: 12 },
  });
  assert.ok(reminderFor(created.body.data.id));

  const updated = await call('PUT', `/items/${created.body.data.id}`, {
    body: { name: 'Fernseher', purchase_date: FUTURE_PURCHASE, warranty_months: null },
  });
  assert.equal(updated.status, 200);
  assert.equal(reminderFor(created.body.data.id), undefined);
});

test('DELETE /items/:id räumt die zugehörige Erinnerung ab', async () => {
  const created = await call('POST', '/items', {
    body: { name: 'Laptop', purchase_date: FUTURE_PURCHASE, warranty_months: 12 },
  });
  assert.ok(reminderFor(created.body.data.id));

  const deleted = await call('DELETE', `/items/${created.body.data.id}`);
  assert.equal(deleted.status, 204);
  assert.equal(reminderFor(created.body.data.id), undefined);
});

test('POST mit kalendarisch ungültigem Kaufdatum antwortet 400 und schreibt nichts', async () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM inventory_items').get().c;
  // 2026-02-30 hat die reine Formatpruefung frueher passiert, wurde geschrieben
  // und liess erst syncReminder werfen - Item angelegt, Antwort 500.
  const r = await call('POST', '/items', {
    body: { name: 'Unmögliches Datum', purchase_date: '2026-02-30', warranty_months: 12 },
  });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM inventory_items').get().c, before);
});

test('PUT mit kalendarisch ungültigem Kaufdatum antwortet 400 und lässt die Zeile unverändert', async () => {
  const created = await call('POST', '/items', {
    body: { name: 'Trockner', purchase_date: FUTURE_PURCHASE, warranty_months: 12 },
  });
  const id = created.body.data.id;

  const r = await call('PUT', `/items/${id}`, {
    body: { name: 'Trockner', purchase_date: '2027-13-01', warranty_months: 12 },
  });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(
    db.prepare('SELECT purchase_date FROM inventory_items WHERE id = ?').get(id).purchase_date,
    FUTURE_PURCHASE,
  );
  assert.ok(reminderFor(id), 'die bestehende Erinnerung bleibt bestehen');
});
