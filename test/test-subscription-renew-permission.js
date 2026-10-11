/**
 * Test: "Als verlaengert markieren" folgt der Schreibregel der Abos
 *
 * Zweck: Im persoenlichen Budget-Modus darf ein Abo nur aendern, wem es
 *        gehoert (mayEditSub -> canEditEntry, kein Admin-Bypass). PUT und
 *        DELETE fragten das, POST /:id/renew nicht - und das Verlaengern
 *        schreibt: es rueckt den Zahlungstag vor, zaehlt eine Zahlung, legt
 *        eine Buchung an und schliesst ein endliches Abo ab.
 *
 * Gemessen ueber den echten Router auf einer In-Memory-DB: wer verlaengern
 * darf, und dass eine Absage NICHTS geschrieben hat.
 *
 * Ausfuehren: node --experimental-sqlite --test test/test-subscription-renew-permission.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
delete process.env.FIXER_API_KEY;

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: subscriptionsRouter } = await import('../server/routes/subscriptions.js');
const db = dbmod.get();

const user = (name, role) => db.prepare(
  'INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?)'
).run(name, name, 'x', role).lastInsertRowid;
const OWNER = user('owner', 'member');
const OTHER = user('other', 'member');
const ADMIN = user('admin', 'admin');

function setMode(mode) {
  db.prepare(`INSERT INTO sync_config (key, value) VALUES ('budget_mode', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(mode);
}
db.prepare(`INSERT INTO sync_config (key, value) VALUES ('currency', 'EUR')
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();

let actor = { id: OWNER, role: 'member' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authUserId = actor.id; req.authRole = actor.role; req.session = { userId: actor.id, role: actor.role }; next(); });
app.use('/', subscriptionsRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

test.beforeEach(() => {
  db.prepare('DELETE FROM budget_subscriptions').run();
  db.prepare('DELETE FROM budget_entries').run();
  setMode('personal');
});

async function call(method, route, { as, role = 'member', body } = {}) {
  actor = { id: as, role };
  const headers = {};
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${baseUrl}${route}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* leer */ }
  return { status: res.status, body: json, text };
}

async function createSub(fields = {}) {
  const r = await call('POST', '/', {
    as: OWNER,
    body: {
      name: 'Streaming', amount: 12.99, currency: 'EUR', billing_cycle: 'monthly', cycle_interval: 1,
      next_payment_date: '2030-01-20', visibility: 'shared', ...fields,
    },
  });
  assert.equal(r.status, 201, r.text);
  return r.body.data;
}

const stateOf = (id) => ({
  sub: db.prepare('SELECT next_payment_date, occurrences_done, enabled, completed_at, budget_entry_id FROM budget_subscriptions WHERE id = ?').get(id),
  entries: db.prepare('SELECT id, date, amount FROM budget_entries ORDER BY id').all(),
});

test('persoenlicher Modus: ein anderes Mitglied verlaengert ein fremdes Abo nicht - 403, nichts geschrieben', async () => {
  for (const visibility of ['shared', 'private']) {
    const sub = await createSub({ visibility });
    const before = stateOf(sub.id);
    const r = await call('POST', `/${sub.id}/renew`, { as: OTHER });
    assert.equal(r.status, 403, `${visibility}: ${r.text}`);
    // Dieselbe Antwort wie PUT und DELETE - eine Regel, ein Wortlaut.
    const put = await call('PUT', `/${sub.id}`, { as: OTHER, body: { name: 'x' } });
    assert.equal(put.status, 403);
    assert.deepEqual(r.body, put.body);
    assert.deepEqual(stateOf(sub.id), before, `${visibility}: Zahlungstag, Zaehler und Buchungen stehen wie zuvor`);
  }
});

test('persoenlicher Modus: die letzte Zahlung eines endlichen Abos schliesst ein Fremder nicht ab', async () => {
  const sub = await createSub({ end_type: 'after_count', occurrence_count: 1 });
  const before = stateOf(sub.id);
  const r = await call('POST', `/${sub.id}/renew`, { as: OTHER });
  assert.equal(r.status, 403, r.text);
  assert.deepEqual(stateOf(sub.id), before, 'weder abgeschlossen noch die Buchung entfernt');
});

test('persoenlicher Modus: wem das Abo gehoert, der verlaengert es', async () => {
  const sub = await createSub();
  const r = await call('POST', `/${sub.id}/renew`, { as: OWNER });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.data.next_payment_date, '2030-02-20');
  assert.equal(stateOf(sub.id).entries.length, 2, 'die bezahlte Buchung bleibt, die naechste entsteht');
});

test('persoenlicher Modus: die Admin-Rolle allein reicht nicht - wie bei PUT und DELETE', async () => {
  const sub = await createSub();
  const before = stateOf(sub.id);
  const put = await call('PUT', `/${sub.id}`, { as: ADMIN, role: 'admin', body: { name: 'x' } });
  assert.equal(put.status, 403, 'Vorbedingung: die Schreibregel kennt keinen Admin-Bypass');
  const r = await call('POST', `/${sub.id}/renew`, { as: ADMIN, role: 'admin' });
  assert.equal(r.status, 403, r.text);
  assert.deepEqual(stateOf(sub.id), before);
});

test('geteilter Modus: unveraendert, jedes Mitglied verlaengert', async () => {
  setMode('shared');
  const sub = await createSub();
  const r = await call('POST', `/${sub.id}/renew`, { as: OTHER });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.data.next_payment_date, '2030-02-20');
  const admin = await call('POST', `/${sub.id}/renew`, { as: ADMIN, role: 'admin' });
  assert.equal(admin.status, 200);
  assert.equal(admin.body.data.next_payment_date, '2030-03-20');
});

test('ein Abo, das es nicht gibt: 404 wie zuvor', async () => {
  const r = await call('POST', '/999999/renew', { as: OTHER });
  assert.equal(r.status, 404);
});
