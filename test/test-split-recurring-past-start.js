/**
 * Test: Eine Serie mit Datum in der Vergangenheit fragt, bevor sie die Luecke bucht (#1748)
 *
 * Zweck: Anlegen und Verlegen einer wiederkehrenden geteilten Ausgabe nahmen
 *        jedes Datum in der Vergangenheit an. Der stuendliche Lauf buchte dann
 *        je Lauf einen versaeumten Termin nach, bis er aufgeholt hatte: eine
 *        Serie mit Start Januar 2024 wurde einen Tag lang stuendlich zur
 *        Ausgabe. Das Fortsetzen fragte schon (#1714), Anlegen und Bearbeiten
 *        nicht.
 *
 *        Jetzt nehmen POST und PUT dasselbe `missed: skip|book` wie das
 *        Fortsetzen. `skip` stellt die Serie auf ihren ersten Termin ab heute,
 *        gezaehlt mit der Rechnung des Laufs (`nextRunNotBefore`), der Ankertag
 *        bleibt der Tag des eingegebenen Datums. `book` und ein Aufruf ohne
 *        `missed` lassen das Datum stehen (alte Clients aendern sich nicht).
 *        Der Dialog stellt die Frage; seine Zahl und sein Datum rechnet er mit
 *        derselben Datei (public/utils/interval-date.js), die der Server
 *        importiert.
 *
 * KEINE UHR: "heute" steht fest (Uhr per Mock UND Haushaltszone), der Lauf
 * bekommt seinen Tag als Argument.
 *
 * Ausfuehren: npm run test:split-recurring-past-start
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: splitRouter } = await import('../server/routes/split-expenses.js');
const { processDueRecurringExpenses } = await import('../server/services/split-expenses-scheduler.js');
const db = dbmod.get();

const HEUTE = '2026-06-15';

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

db.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();

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

// "Heute" fuer die Route: nur `Date` steht, Timer laufen echt weiter (fetch).
function amTag(t) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(`${HEUTE}T10:00:00Z`) });
  t.after(() => t.mock.timers.reset());
}

// Eine Gruppe je Fall; alles andere Faellige ruht, damit der Lauf nur die
// Serie dieses Falls bucht.
async function gruppe(name) {
  const g = await call('POST', '/groups', { name, type: 'household', default_currency: 'EUR' });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const gid = g.body.data.id;
  assert.equal((await call('POST', `/groups/${gid}/members`, { user_id: MEM, role: 'guest' })).status, 201);
  db.prepare("UPDATE recurring_expenses SET paused_at = '2020-01-01T00:00:00Z' WHERE paused_at IS NULL").run();
  return gid;
}
const anlegen = (gid, extra) => call('POST', `/groups/${gid}/recurring`, {
  title: 'Miete', amount: '900.00', currency: 'EUR', frequency: 'monthly', payer_id: OWNER, participants: [OWNER, MEM], ...extra,
});
const stand = (id) => db.prepare('SELECT * FROM recurring_expenses WHERE id = ?').get(id);
const buchungen = (id) => db.prepare('SELECT expense_date FROM expenses WHERE recurring_rule_id = ? ORDER BY id').all(id).map((r) => r.expense_date);

// Der Lauf, bis er fuer diese Serie nichts mehr bucht (hoechstens `max` Mal).
function aufholen(max = 20) {
  for (let i = 0; i < max; i += 1) {
    if (processDueRecurringExpenses(HEUTE).generated === 0) return;
  }
  assert.fail('der Lauf holt nicht auf');
}

test('Anlegen drei Monate zurueck mit skip: nichts wird gebucht, die Serie steht auf dem naechsten Termin', async (t) => {
  amTag(t);
  const gid = await gruppe('skip');
  const r = await anlegen(gid, { next_run_date: '2026-03-20', missed: 'skip' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.next_run_date, '2026-06-20', 'der erste Termin ab heute, im Raster der Serie');
  assert.equal(stand(r.body.data.id).anchor_day, 20, 'der Ankertag bleibt der Tag des eingegebenen Datums');
  aufholen();
  assert.deepEqual(buchungen(r.body.data.id), [], 'keine Luecke gebucht');
});

test('Anlegen mit skip: der Ankertag bleibt, auch wenn der naechste Termin geklemmt ist', async (t) => {
  amTag(t);
  const gid = await gruppe('skip-anker');
  const r = await anlegen(gid, { next_run_date: '2026-01-31', missed: 'skip' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.next_run_date, '2026-06-30');
  assert.equal(stand(r.body.data.id).anchor_day, 31);
});

test('Anlegen mit book: jeder versaeumte Termin wird genau einmal gebucht', async (t) => {
  amTag(t);
  const gid = await gruppe('book');
  const r = await anlegen(gid, { next_run_date: '2026-03-20', missed: 'book' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.next_run_date, '2026-03-20');
  aufholen();
  assert.deepEqual(buchungen(r.body.data.id), ['2026-03-20', '2026-04-20', '2026-05-20']);
  assert.equal(stand(r.body.data.id).next_run_date, '2026-06-20');
});

test('Anlegen ohne missed: das Datum bleibt stehen wie bisher', async (t) => {
  amTag(t);
  const gid = await gruppe('ohne');
  const r = await anlegen(gid, { next_run_date: '2026-03-20' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.next_run_date, '2026-03-20');
});

test('Anlegen mit skip auf heute oder spaeter: nichts verschiebt sich', async (t) => {
  amTag(t);
  const gid = await gruppe('heute');
  for (const datum of [HEUTE, '2026-07-01']) {
    const r = await anlegen(gid, { next_run_date: datum, missed: 'skip' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.next_run_date, datum, 'ein Termin am heutigen Tag ist nicht versaeumt');
  }
});

test('Anlegen mit unbekanntem missed: 400 mit reason, nichts angelegt', async (t) => {
  amTag(t);
  const gid = await gruppe('falsch');
  const r = await anlegen(gid, { next_run_date: '2026-03-20', missed: 'later' });
  assert.equal(r.status, 400);
  assert.equal(r.body.reason, 'invalid_missed');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recurring_expenses WHERE group_id = ?').get(gid).n, 0);
});

test('Verlegen in die Vergangenheit mit skip: die Serie steht auf dem naechsten Termin, der Anker folgt dem Datum', async (t) => {
  amTag(t);
  const gid = await gruppe('verlegen');
  const angelegt = (await anlegen(gid, { next_run_date: '2026-07-01' })).body.data;
  const r = await call('PUT', `/recurring/${angelegt.id}`, { next_run_date: '2026-02-10', frequency: 'weekly', missed: 'skip' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // 10.02. + 18 Wochen = 16.06., der erste Dienstag ab dem 15.06.
  assert.equal(r.body.data.next_run_date, '2026-06-16');
  aufholen();
  assert.deepEqual(buchungen(angelegt.id), []);
});

test('Verlegen in die Vergangenheit mit book oder ohne missed: das Datum bleibt', async (t) => {
  amTag(t);
  const gid = await gruppe('verlegen-book');
  for (const missed of ['book', undefined]) {
    const angelegt = (await anlegen(gid, { next_run_date: '2026-07-01' })).body.data;
    const r = await call('PUT', `/recurring/${angelegt.id}`, { next_run_date: '2026-04-01', missed });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.next_run_date, '2026-04-01', String(missed));
  }
});

test('Bearbeiten ohne Verlegung: skip rueckt einen faelligen Termin nicht still weiter', async (t) => {
  amTag(t);
  const gid = await gruppe('stehen');
  const angelegt = (await anlegen(gid, { next_run_date: '2026-05-01' })).body.data;
  const r = await call('PUT', `/recurring/${angelegt.id}`, { title: 'Neu', missed: 'skip' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.next_run_date, '2026-05-01', 'nur ein gesetzter Termin fragt');
});

test('Bearbeiten mit unbekanntem missed: 400 mit reason, nichts geaendert', async (t) => {
  amTag(t);
  const gid = await gruppe('put-falsch');
  const angelegt = (await anlegen(gid, { next_run_date: '2026-07-01' })).body.data;
  const r = await call('PUT', `/recurring/${angelegt.id}`, { next_run_date: '2026-04-01', missed: 'yes' });
  assert.equal(r.status, 400);
  assert.equal(r.body.reason, 'invalid_missed');
  assert.equal(stand(angelegt.id).next_run_date, '2026-07-01');
});

test('Server und Dialog zaehlen mit DERSELBEN Rechnung', async () => {
  const server = await import('../server/utils/interval-date.js');
  const browser = await import('../public/utils/interval-date.js');
  assert.equal(server.nextRunNotBefore, browser.nextRunNotBefore);
  assert.equal(server.addInterval, browser.addInterval);
});
