/**
 * Test: Inventar-Fristen (Volles Replace bei jedem Item-Speichern)
 * Zweck: End-to-End über den echten Items-Router.
 *          - POST/PUT mit tracked_dates legt Zeilen + je eine Erinnerung mit
 *            eigenem Vorlauf an
 *          - PUT ohne tracked_dates laesst bestehende Fristen unangetastet
 *            (gleiches Muster wie attachment_document_ids)
 *          - PUT mit [] raeumt alle Fristen ab
 *          - ungueltige Zeile / zu viele Zeilen -> 400, kein Teil-Schreiben
 *          - DELETE /items/:id raeumt Fristen UND ihre Erinnerungen ab
 *          - GET /pending loest den Titel ueber den Join korrekt auf
 * Ausführen: node --experimental-sqlite --test test/test-inventory-tracked-dates.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: itemsRouter } = await import('../server/routes/inventory/items.js');
const { default: remindersRouter } = await import('../server/routes/reminders.js');
const db = dbmod.get();
// Das Inventar ist standardmaessig abgeschaltet (Migration 145), und seit #1279
// liefert GET /reminders/pending keine Zeile eines abgeschalteten Moduls mehr aus.
// Diese Suite prueft ein Inventar, das der Haushalt benutzt - also ist es an.
db.prepare("INSERT INTO sync_config (key, value) VALUES ('disabled_modules', '[]') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();

const A = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('a','A','x','member')").run().lastInsertRowid;

let actor = { id: A };
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authUserId = actor.id; req.session = { userId: actor.id }; next(); });
app.use('/items', itemsRouter);
app.use('/reminders', remindersRouter);
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

function trackedDateReminders(trackedDateId) {
  return db.prepare("SELECT * FROM reminders WHERE entity_type = 'inventory_tracked_date' AND entity_id = ?").all(trackedDateId);
}

const FUTURE_DATE = '2099-06-01';

test('POST mit tracked_dates legt Zeilen und je eine Erinnerung mit eigenem Vorlauf an', async () => {
  const r = await call('POST', '/items', {
    body: {
      name: 'Auto',
      tracked_dates: [
        { label: 'TÜV', date: FUTURE_DATE, reminder_offset_days: 60 },
        { label: 'Inspektion', date: FUTURE_DATE },
      ],
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const dates = r.body.data.tracked_dates;
  assert.equal(dates.length, 2);
  const tuv = dates.find((d) => d.label === 'TÜV');
  const inspektion = dates.find((d) => d.label === 'Inspektion');
  assert.equal(tuv.reminder_offset_days, 60);
  assert.equal(inspektion.reminder_offset_days, 30, 'Default-Vorlauf ohne explizite Angabe');

  const tuvReminders = trackedDateReminders(tuv.id);
  assert.equal(tuvReminders.length, 1);
  assert.equal(tuvReminders[0].created_by, A);
  assert.equal(tuvReminders[0].remind_at, '2099-04-02T09:00', '60 Tage vor dem 2099-06-01');
});

test('POST ohne tracked_dates legt keine Fristen an', async () => {
  const r = await call('POST', '/items', { body: { name: 'Ohne Fristen' } });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.data.tracked_dates, []);
});

test('POST mit ungültiger Zeile schreibt gar nichts (auch nicht das Item)', async () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM inventory_items').get().c;
  const r = await call('POST', '/items', {
    body: { name: 'Sollte nicht existieren', tracked_dates: [{ label: '', date: FUTURE_DATE }] },
  });
  assert.equal(r.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM inventory_items').get().c, before);
});

test('POST mit mehr als 10 Zeilen wird abgelehnt', async () => {
  const rows = Array.from({ length: 11 }, (_, i) => ({ label: `Frist ${i}`, date: FUTURE_DATE }));
  const r = await call('POST', '/items', { body: { name: 'Zu viele Fristen', tracked_dates: rows } });
  assert.equal(r.status, 400);
});

test('PUT ohne tracked_dates lässt bestehende Fristen unangetastet', async () => {
  const created = await call('POST', '/items', {
    body: { name: 'Kühlschrank', tracked_dates: [{ label: 'Service', date: FUTURE_DATE }] },
  });
  const originalDateId = created.body.data.tracked_dates[0].id;

  const updated = await call('PUT', `/items/${created.body.data.id}`, { body: { name: 'Kühlschrank (umbenannt)' } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.tracked_dates.length, 1);
  assert.equal(updated.body.data.tracked_dates[0].id, originalDateId, 'unveränderte Zeile, nicht neu erzeugt');
});

test('PUT mit tracked_dates ersetzt die komplette Menge (alte Erinnerungen weg, neue da)', async () => {
  const created = await call('POST', '/items', {
    body: { name: 'Fernseher', tracked_dates: [{ label: 'Garantieverlängerung', date: FUTURE_DATE }] },
  });
  const oldDateId = created.body.data.tracked_dates[0].id;
  assert.equal(trackedDateReminders(oldDateId).length, 1);

  const updated = await call('PUT', `/items/${created.body.data.id}`, {
    body: { name: 'Fernseher', tracked_dates: [{ label: 'Neue Frist', date: FUTURE_DATE }] },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.tracked_dates.length, 1);
  assert.equal(updated.body.data.tracked_dates[0].label, 'Neue Frist');
  assert.equal(trackedDateReminders(oldDateId).length, 0, 'alte Erinnerung muss weg sein');
});

test('PUT mit leerem Array räumt alle Fristen ab', async () => {
  const created = await call('POST', '/items', {
    body: { name: 'Waschmaschine', tracked_dates: [{ label: 'Service', date: FUTURE_DATE }] },
  });
  const updated = await call('PUT', `/items/${created.body.data.id}`, { body: { name: 'Waschmaschine', tracked_dates: [] } });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.data.tracked_dates, []);
});

test('DELETE /items/:id räumt Fristen und ihre Erinnerungen ab', async () => {
  const created = await call('POST', '/items', {
    body: { name: 'Laptop', tracked_dates: [{ label: 'Akku prüfen', date: FUTURE_DATE }] },
  });
  const dateId = created.body.data.tracked_dates[0].id;
  assert.equal(trackedDateReminders(dateId).length, 1);

  const deleted = await call('DELETE', `/items/${created.body.data.id}`);
  assert.equal(deleted.status, 204);
  assert.equal(trackedDateReminders(dateId).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM inventory_item_dates WHERE item_id = ?').get(created.body.data.id).c, 0);
});

test('GET /reminders/pending löst den Titel für inventory_tracked_date über den Join auf', async () => {
  const created = await call('POST', '/items', {
    body: { name: 'Heizung', tracked_dates: [{ label: 'Wartung', date: '2000-01-05', reminder_offset_days: 1 }] },
  });
  // 2000-01-05 minus 1 Tag liegt in der Vergangenheit, syncTrackedDateReminder
  // legt dafuer keine Erinnerung an (siehe items.js#syncReminder-Analogon) -
  // fuer diesen Test wird die Erinnerung direkt eingefuegt, um GET /pending
  // unabhaengig vom "kein Nachtrags-Nagging"-Verhalten zu pruefen.
  const dateId = created.body.data.tracked_dates[0].id;
  db.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('inventory_tracked_date', ?, '2000-01-01T00:00:00', ?)
  `).run(dateId, A);

  const res = await call('GET', '/reminders/pending');
  assert.equal(res.status, 200);
  const match = res.body.data.find((r) => r.entity_type === 'inventory_tracked_date' && r.entity_id === dateId);
  assert.ok(match, 'Erinnerung sollte in /pending auftauchen');
  assert.equal(match.entity_title, 'Heizung · Wartung');
});
