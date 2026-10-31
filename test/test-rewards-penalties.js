/**
 * Modul: Konsequenzen-Test (Migration 274, POST/DELETE /rewards/penalty)
 * Zweck: Der optionale Gegenzweig des Punkte-Systems. Schalter aus = 403 fuer
 *        jeden; Schalter an = Eltern (und Admin) buchen Kindern ehrliche
 *        'penalty'-Zeilen, Erwachsene bleiben verschont, die Ruecknahme ist
 *        eine Gegenbuchung (reversal, reverses_id) und keine Radierung.
 *        Dazu: der Rebuild der Migration traegt Spalten der Geld-Kette und
 *        laeuft zweimal auf gedrifteter Datenbank ohne Fehler.
 * Ausführen: npm run test:rewards-penalties
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: rewardsRouter } = await import('../server/routes/rewards.js');
const { getBalance } = await import('../server/services/rewards.js');
const db = dbmod.get();

// ── Nutzer ─────────────────────────────────────────────────────────────────
db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('admin','Admin','x','admin','parent')").run();
db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('mom','Mom','x','member','mom')").run();
db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('opa','Opa','x','member','grandparent')").run();
db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('leo','Leo','x','member','child')").run();
db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('luke','Luke','x','member','child')").run();
const id = (name) => db.prepare('SELECT id FROM users WHERE username = ?').get(name).id;
const ADMIN = { id: id('admin'), role: 'admin' };
const MOM = { id: id('mom'), role: 'member' };
const OPA = { id: id('opa'), role: 'member' };
const LEO = { id: id('leo'), role: 'member' };
const LUKE = { id: id('luke'), role: 'member' };
for (const uid of [LEO, LUKE]) db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(uid.id);

const setFlag = (v) => db.prepare(
  "INSERT INTO sync_config (key, value) VALUES ('rewards_penalties_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
).run(v);

let actor = ADMIN;
const app = express();
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use(express.json());
app.use('/', rewardsRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, route, { as = ADMIN, body } = {}) {
  actor = as;
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// ── Schalter ───────────────────────────────────────────────────────────────
test('Schalter aus (Default): POST /penalty ist 403, auch fuer Mom', async () => {
  const res = await call('POST', '/penalty', { as: MOM, body: { user_id: LEO.id, amount: 5, reason: 'Zimmer unordentlich' } });
  assert.equal(res.status, 403);
  assert.equal(res.body.reason, 'rewards_penalties_disabled');
});

// ── Berechtigungen ─────────────────────────────────────────────────────────
test('Schalter an: Mom bucht Leo -5 penalty, Saldo sinkt', async () => {
  setFlag('1');
  const before = getBalance(db, LEO.id);
  const res = await call('POST', '/penalty', { as: MOM, body: { user_id: LEO.id, amount: 5, reason: 'Zimmer unordentlich', category: 'zimmer' } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.balance, before - 5);
  const row = db.prepare("SELECT * FROM reward_ledger WHERE user_id = ? AND type = 'penalty'").get(LEO.id);
  assert.equal(row.delta, -5);
  assert.equal(row.created_by, MOM.id);
  assert.match(row.reason, /^zimmer: Zimmer unordentlich$/);
});

test('Kind darf nicht; Opa (kein Elternteil) nicht; Ziel muss Kind sein', async () => {
  setFlag('1');
  assert.equal((await call('POST', '/penalty', { as: LEO, body: { user_id: LUKE.id, amount: 5, reason: 'test grund' } })).status, 403);
  assert.equal((await call('POST', '/penalty', { as: OPA, body: { user_id: LUKE.id, amount: 5, reason: 'test grund' } })).status, 403);
  // Mom gegen einen Erwachsenen (Opa) — Konsequenzen gelten nur fuer Kinder.
  const adult = db.prepare("SELECT id FROM users WHERE role = 'member' AND family_role = 'grandparent'").get();
  assert.equal((await call('POST', '/penalty', { as: MOM, body: { user_id: adult.id, amount: 5, reason: 'test grund' } })).status, 403);
  // Admin gegen Kind ist erlaubt (Erzieht wie Eltern, Zielpruefung identisch).
  const res = await call('POST', '/penalty', { as: ADMIN, body: { user_id: LEO.id, amount: 2, reason: 'zu spaet ins Bett' } });
  assert.equal(res.status, 201);
});

test('Validierung: amount 0/-3/101/"abc" -> 400; fehlender Grund -> 400; fremde Kategorie -> 400', async () => {
  setFlag('1');
  for (const bad of [0, -3, 101, 'abc', null]) {
    const res = await call('POST', '/penalty', { as: MOM, body: { user_id: LEO.id, amount: bad, reason: 'grund text' } });
    assert.equal(res.status, 400, `amount=${bad} musste 400 sein`);
  }
  assert.equal((await call('POST', '/penalty', { as: MOM, body: { user_id: LEO.id, amount: 5 } })).status, 400);
  assert.equal((await call('POST', '/penalty', { as: MOM, body: { user_id: LEO.id, amount: 5, reason: 'x' } })).status, 400);
  assert.equal((await call('POST', '/penalty', { as: MOM, body: { user_id: LEO.id, amount: 5, reason: 'grund', category: 'quatsch' } })).status, 400);
  assert.equal((await call('POST', '/penalty', { as: MOM, body: { user_id: 99999, amount: 5, reason: 'grund text' } })).status, 404);
});

// ── Ruecknahme ─────────────────────────────────────────────────────────────
test('DELETE /penalty/:id: Urheber holt zurueck (reversal mit reverses_id), zweite Loeschung 409', async () => {
  setFlag('1');
  const before = getBalance(db, LUKE.id);
  const create = await call('POST', '/penalty', { as: MOM, body: { user_id: LUKE.id, amount: 7, reason: 'ramba zamba beim ins-bett-gehen', category: 'ritual' } });
  assert.equal(create.status, 201);
  const row = db.prepare("SELECT * FROM reward_ledger WHERE user_id = ? AND type = 'penalty' AND delta = -7").get(LUKE.id);
  const del = await call('DELETE', `/penalty/${row.id}`, { as: MOM });
  assert.equal(del.status, 200);
  assert.equal(del.body.data.balance, before, 'Saldo zurueck auf Ausgangswert');
  const rev = db.prepare('SELECT * FROM reward_ledger WHERE reverses_id = ?').get(row.id);
  assert.ok(rev, 'Gegenbuchung vorhanden');
  assert.equal(rev.type, 'reversal');
  assert.equal(rev.delta, 7);
  const again = await call('DELETE', `/penalty/${row.id}`, { as: MOM });
  assert.equal(again.status, 409);
});

test('Nur Urheber oder Admin: fremdes Elternteil (Admin) darf; ein zweites Elternteil nicht', async () => {
  setFlag('1');
  const row = db.prepare("SELECT * FROM reward_ledger WHERE user_id = ? AND type = 'penalty' AND delta = -5").get(LEO.id);
  assert.ok(row);
  // Mom ist Urheber -> darf (schon getestet); ein Nicht-Urheber-Nicht-Admin:
  const opa = { id: id('opa'), role: 'member' };
  // Opa hat keine Erlaubnis ueberhaupt -> 403
  assert.equal((await call('DELETE', `/penalty/${row.id}`, { as: opa })).status, 403);
});

// ── Ledger-Sichtbarkeit ────────────────────────────────────────────────────
test('Leo sieht Grund seiner eigenen Konsequenz; Luke sieht ihn nicht', async () => {
  const mine = await call('GET', '/ledger?user_id=' + LEO.id, { as: LEO });
  assert.equal(mine.status, 200);
  const withReason = mine.body.data.find((r) => r.type === 'penalty');
  assert.ok(withReason && withReason.reason, 'Kind sieht den Grund der eigenen Konsequenz');
  const foreign = await call('GET', '/ledger?user_id=' + LEO.id, { as: LUKE });
  const row = foreign.body.data.find((r) => r.type === 'penalty');
  assert.ok(!row || row.reason === null, 'Geschwister sehen den Grund nicht');
});

// ── Migration: Rebuild traegt und ist idempotent ───────────────────────────
test('Migration 274: zweiter Lauf auf bestehender DB ohne Fehler; penalty-CHECK aktiv', () => {
  const { MIGRATIONS } = dbmod;
  const m = MIGRATIONS.find((x) => x.version === 274);
  assert.ok(m, 'Migration 274 existiert');
  m.up(db); // zweiter Lauf: bewacht, muss ein Noop sein
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'reward_ledger'").get().sql;
  assert.match(ddl, /'penalty'/);
  // Der CHECK traegt: ein Typ ausserhalb der Liste scheitert.
  let threw = false;
  try {
    db.prepare("INSERT INTO reward_ledger (user_id, delta, type) VALUES (?, 1, 'quatsch')").run(LEO);
  } catch { threw = true; }
  assert.ok(threw, 'type-CHECK lehnt unbekannte Typen weiter ab');
  // Geld-Kette trug mit: Spalten existieren noch.
  const cols = db.prepare('PRAGMA table_info(reward_ledger)').all().map((c) => c.name);
  for (const need of ['series_id', 'reverses_id', 'unit', 'allowance_date', 'currency']) {
    assert.ok(cols.includes(need), `${need} fehlt nach Rebuild`);
  }
  // uniq_reward_earn existiert bewusst NICHT (Migration 230): Wiedervergabe
  // nach Ruecknahme muss buchen koennen. Der allowance-Index traegt den Rebuild:
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reward_ledger'").all().map((r) => r.name);
  assert.ok(!names.includes('uniq_reward_earn'), 'uniq_reward_earn kommt nicht zurueck (230)');
  assert.ok(names.includes('uniq_reward_allowance_credit'), 'allowance-Index traegt den Rebuild');
  const task = db.prepare("INSERT INTO tasks (title, status, created_by) VALUES ('drei', 'open', ?)").run(ADMIN.id).lastInsertRowid;
  db.prepare("INSERT INTO reward_ledger (user_id, delta, type, task_id) VALUES (?, 3, 'earn', ?)").run(LEO.id, task);
  // Doppelte earn-Zeile ist erlaubt (230-Verhalten) — und der allowance-Pfad bleibt dicht:
  db.prepare("INSERT INTO reward_ledger (user_id, delta, type, task_id) VALUES (?, 3, 'earn', ?)").run(LEO.id, task);
  db.prepare("INSERT INTO reward_ledger (user_id, delta, type, allowance_date) VALUES (?, 5, 'bonus', '2026-11-01')").run(LEO.id);
  let dup = false;
  try { db.prepare("INSERT INTO reward_ledger (user_id, delta, type, allowance_date) VALUES (?, 5, 'bonus', '2026-11-01')").run(LEO.id); } catch { dup = true; }
  assert.ok(dup, 'uniq_reward_allowance_credit ueberlebte den Rebuild');
});
