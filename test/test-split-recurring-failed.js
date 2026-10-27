/**
 * Test: Eine Serie, die unerwartet scheitert, laeuft weiter und sagt es an ihrer Zeile (#1746)
 *
 * Zweck: Eine wiederkehrende geteilte Ausgabe, die aus bekanntem Grund nicht
 *        buchbar ist, pausiert der Lauf und schreibt den Grund in den Verlauf.
 *        Scheitert sie UNERWARTET (ein Fehler im Code oder in der Umgebung),
 *        pausiert er sie bewusst nicht - ein Bug auf unserer Seite soll keine
 *        Miete still anhalten. Bis hierher stand das nur im Serverlog, und der
 *        Lauf versuchte es stuendlich, fuer immer, ohne dass es im Haushalt
 *        jemand sah.
 *
 *        Entscheidung (Ulas): die Serie laeuft weiter, der Fehler steht an der
 *        Zeile. Dafuer merkt sie sich seit Migration 263 den ersten
 *        Fehlschlag (`recurring_expenses.failed_at`):
 *          - der Lauf setzt ihn beim ersten unerwarteten Fehler und laesst ihn
 *            bei weiteren stehen ("seit");
 *          - eine Buchung leert ihn, ein Bearbeiten auch (PUT), und eine
 *            Pause aus bekanntem Grund (dann gilt der Grund);
 *          - die Liste traegt ihn mit, die Serie bleibt unpausiert.
 *
 *        Die Fehlerrichtung kommt ueber die Naht `book` von
 *        processDueRecurringExpenses(today, book), wie in der Suite der Routen.
 *
 * Ausfuehren: npm run test:split-recurring-failed
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
import { tempDir } from './tmp-dir.js';

const dbmod = await import('../server/db.js');
const { default: splitRouter } = await import('../server/routes/split-expenses.js');
const { processDueRecurringExpenses, generateRecurringExpense } = await import('../server/services/split-expenses-scheduler.js');
const { MIGRATIONS, migrate } = dbmod;
const db = dbmod.get();

const mkUser = (username) => db.prepare(
  "INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, 'x', 'member')",
).run(username, username.toUpperCase()).lastInsertRowid;
const OWNER = mkUser('owner');
const MEM = mkUser('mem');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = OWNER;
  req.authRole = 'member';
  req.session = { userId: OWNER, role: 'member' };
  req.sessionModuleAccess = null;
  req.authScopes = null;
  next();
});
app.use('/', splitRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* leer */ }
  return { status: res.status, body: json };
}

// Eine Gruppe und eine faellige Serie je Fall; alles andere Faellige ruht.
async function faelligeSerie(name) {
  const g = await call('POST', '/groups', { name, type: 'household', default_currency: 'EUR' });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const gid = g.body.data.id;
  assert.equal((await call('POST', `/groups/${gid}/members`, { user_id: MEM, role: 'guest' })).status, 201);
  db.prepare("UPDATE recurring_expenses SET paused_at = '2020-01-01T00:00:00Z' WHERE paused_at IS NULL").run();
  const r = await call('POST', `/groups/${gid}/recurring`, {
    title: 'Miete', amount: '900.00', currency: 'EUR', frequency: 'monthly', next_run_date: '2026-03-01', payer_id: OWNER, participants: [OWNER, MEM],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { gid, id: r.body.data.id };
}
const stand = (id) => db.prepare('SELECT * FROM recurring_expenses WHERE id = ?').get(id);
// Ein Fehler, den der Lauf nicht als "unbuchbar" kennt: ein Bug im Code.
const kaputt = () => { throw new TypeError('boom'); };

test('Migration 263: frische Datenbank und Bestand auf 262 bekommen die Spalte, leer', () => {
  assert.ok(db.prepare('PRAGMA table_info(recurring_expenses)').all().some((c) => c.name === 'failed_at'), 'frische DB');
  const old = new Database(join(tempDir('yuvomi-split-failed-'), 'db.sqlite'));
  old.pragma('foreign_keys = ON');
  migrate(old, MIGRATIONS.filter((m) => m.version <= 262));
  const user = old.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('o', 'O', 'x', 'member')").run().lastInsertRowid;
  const group = old.prepare("INSERT INTO expense_groups (name, type, default_currency, created_by) VALUES ('WG', 'household', 'EUR', ?)").run(user).lastInsertRowid;
  old.prepare(`INSERT INTO recurring_expenses (group_id, title, amount_minor, currency, payer_id, split_snapshot, frequency, next_run_date, created_by)
    VALUES (?, 'Miete', 90000, 'EUR', ?, '{}', 'monthly', '2026-03-01', ?)`).run(group, user, user);
  migrate(old, MIGRATIONS);
  assert.equal(old.prepare('SELECT failed_at FROM recurring_expenses').get().failed_at, null, 'Bestand startet ohne Fehlschlag');
  old.close();
});

test('Unerwarteter Fehler: die Serie bleibt unpausiert und merkt sich den ERSTEN Fehlschlag', async () => {
  const { id } = await faelligeSerie('fehler');
  assert.deepEqual(processDueRecurringExpenses('2026-03-01', kaputt), { generated: 0, paused: 0, failed: 1 });
  const erst = stand(id);
  assert.equal(erst.paused_at, null, 'ein Bug haelt die Serie nicht an');
  assert.match(erst.failed_at ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  db.prepare("UPDATE recurring_expenses SET failed_at = '2026-03-01T08:00:00Z' WHERE id = ?").run(id);
  assert.deepEqual(processDueRecurringExpenses('2026-03-01', kaputt), { generated: 0, paused: 0, failed: 1 });
  assert.equal(stand(id).failed_at, '2026-03-01T08:00:00Z', 'der zweite Fehlschlag laesst das "seit" stehen');
  assert.equal(stand(id).next_run_date, '2026-03-01', 'der Termin bleibt, der naechste Lauf versucht ihn wieder');
});

test('Die Liste traegt failed_at mit', async () => {
  const { gid, id } = await faelligeSerie('liste');
  processDueRecurringExpenses('2026-03-01', kaputt);
  const r = await call('GET', `/groups/${gid}/recurring`);
  assert.equal(r.status, 200);
  const zeile = r.body.data.find((row) => row.id === id);
  assert.equal(zeile.failed_at, stand(id).failed_at);
  assert.ok(zeile.failed_at);
});

test('Eine Buchung leert den Fehlschlag', async () => {
  const { id } = await faelligeSerie('erholt');
  processDueRecurringExpenses('2026-03-01', kaputt);
  assert.ok(stand(id).failed_at);
  assert.deepEqual(processDueRecurringExpenses('2026-03-01', generateRecurringExpense), { generated: 1, paused: 0, failed: 0 });
  assert.equal(stand(id).failed_at, null);
  assert.equal(stand(id).next_run_date, '2026-04-01');
});

test('Ein Bearbeiten leert den Fehlschlag, auch eines, das nur den Titel aendert', async () => {
  const { id } = await faelligeSerie('bearbeitet');
  processDueRecurringExpenses('2026-03-01', kaputt);
  assert.ok(stand(id).failed_at);
  const r = await call('PUT', `/recurring/${id}`, { title: 'Miete neu' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.failed_at, null);
  assert.equal(stand(id).failed_at, null);
});

test('Eine Pause aus bekanntem Grund leert den Fehlschlag: dann gilt der Grund', async () => {
  const { id } = await faelligeSerie('pausiert');
  processDueRecurringExpenses('2026-03-01', kaputt);
  assert.ok(stand(id).failed_at);
  db.prepare("UPDATE recurring_expenses SET split_snapshot = 'kein json' WHERE id = ?").run(id);
  assert.deepEqual(processDueRecurringExpenses('2026-03-01'), { generated: 0, paused: 1, failed: 0 });
  assert.ok(stand(id).paused_at);
  assert.equal(stand(id).failed_at, null);
});

test('Ein Fehlschlag, der sich nicht merken laesst, bricht den Lauf nicht ab', async () => {
  const { id } = await faelligeSerie('ohne-spalte');
  // Der Fehlschlag wird in einem eigenen Schritt geschrieben; scheitert auch
  // der (hier: ein Trigger wirft), zaehlt die Serie als gescheitert wie bisher.
  db.exec(`CREATE TRIGGER t_failed_at_wirft BEFORE UPDATE OF failed_at ON recurring_expenses
    BEGIN SELECT RAISE(ABORT, 'nein'); END;`);
  try {
    assert.deepEqual(processDueRecurringExpenses('2026-03-01', kaputt), { generated: 0, paused: 0, failed: 1 });
    assert.equal(stand(id).failed_at, null);
  } finally {
    db.exec('DROP TRIGGER t_failed_at_wirft');
  }
});
