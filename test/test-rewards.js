/**
 * Modul: Rewards-Test (Belohnungen)
 * Zweck: Punkte-Service (Vergabe/Storno/Idempotenz) + REST-API (Teilnehmer,
 *        Katalog, Einlösen mit Freigabe, Bonus, Ledger).
 * Ausführen: node --experimental-sqlite test/test-rewards.js
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
import { MIGRATIONS, _setTestDatabase } from '../server/db.js';
import {
  awardForCompletion, reverseTaskEarnings, syncTaskRewards, getBalance, isEnrolled,
} from '../server/services/rewards.js';
import { syncTaskCompletion } from '../server/services/task-completions.js';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const { default: rewardsRouter } = await import('../server/routes/rewards.js');

function buildTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
  for (const m of MIGRATIONS) {
    if (typeof m.up === 'function') m.up(db); else db.exec(m.up);
    if (typeof m.afterUp === 'function') m.afterUp(db);
    db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(m.version, m.description);
  }
  return db;
}

const db = buildTestDb();
_setTestDatabase(db);

const admin = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('mom', 'Mama', 'x', 'admin')").run().lastInsertRowid;
const child1 = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('lea', 'Lea', 'x', 'member')").run().lastInsertRowid;
const child2 = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('tim', 'Tim', 'x', 'member')").run().lastInsertRowid;

function makeTask(points, assignees = []) {
  const id = db.prepare("INSERT INTO tasks (title, status, created_by, points) VALUES ('Chore', 'open', ?, ?)").run(admin, points).lastInsertRowid;
  const ins = db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)');
  for (const uid of assignees) ins.run(id, uid);
  return id;
}

// --------------------------------------------------------
// Schema
// --------------------------------------------------------
test('Schema: tasks.points existiert (Default 0)', () => {
  const cols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  assert.ok(cols.includes('points'));
});

test('Schema: Reward-Tabellen existieren', () => {
  for (const t of ['reward_participants', 'reward_catalog', 'reward_redemptions', 'reward_ledger']) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
    assert.equal(row?.name, t, `${t} fehlt`);
  }
});

// --------------------------------------------------------
// Service: Vergabe
// --------------------------------------------------------
test('Nur teilnehmende Mitglieder erhalten Punkte', () => {
  db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(child1);
  assert.equal(isEnrolled(db, child1), true);
  assert.equal(isEnrolled(db, child2), false);

  const taskId = makeTask(50, [child1, child2]);
  awardForCompletion(db, taskId, admin);
  assert.equal(getBalance(db, child1), 50);
  assert.equal(getBalance(db, child2), 0, 'nicht-teilnehmend erhält nichts');
});

test('Vergabe ist idempotent (Doppelaufruf ändert nichts)', () => {
  const taskId = makeTask(30, [child1]);
  awardForCompletion(db, taskId, admin);
  awardForCompletion(db, taskId, admin);
  const earns = db.prepare("SELECT COUNT(*) AS n FROM reward_ledger WHERE task_id = ? AND type='earn'").get(taskId).n;
  assert.equal(earns, 1);
});

test('syncTaskRewards: done→open storniert die Vergabe', () => {
  const before = getBalance(db, child1);
  const taskId = makeTask(40, [child1]);
  syncTaskRewards(db, taskId, 'open', 'done', admin);
  assert.equal(getBalance(db, child1), before + 40);
  syncTaskRewards(db, taskId, 'done', 'open', admin);
  assert.equal(getBalance(db, child1), before, 'Storno stellt Saldo wieder her');
});

test('v230 läuft ein zweites Mal durch, ohne etwas doppelt anzulegen', () => {
  const v230 = MIGRATIONS.find((m) => m.version === 230);
  assert.doesNotThrow(() => v230.up(db));
  for (const [table, column] of [['tasks', 'recurrence_series_id'], ['reward_ledger', 'series_id'], ['reward_ledger', 'reverses_id']]) {
    const n = db.prepare(`PRAGMA table_info(${table})`).all().filter((c) => c.name === column).length;
    assert.equal(n, 1, `${table}.${column}`);
  }
});

test('uniq_reward_earn ist gefallen, die Netto-Frage hat ihren Index (v230, #1607)', () => {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reward_ledger'").all().map((r) => r.name);
  assert.ok(!names.includes('uniq_reward_earn'), 'der eindeutige Index verschluckte die Neuvergabe nach dem Wiederöffnen');
  assert.ok(names.includes('idx_reward_ledger_task'));
});

test('Wiederöffnen bucht gegen und lässt die earn-Zeile stehen (#1607)', () => {
  const before = getBalance(db, child1);
  const taskId = makeTask(40, [child1]);
  syncTaskRewards(db, taskId, 'open', 'done', admin);
  syncTaskRewards(db, taskId, 'done', 'open', child1);
  const rows = db.prepare('SELECT delta, type, reason, created_by FROM reward_ledger WHERE task_id = ? ORDER BY id ASC').all(taskId);
  assert.deepEqual(rows, [
    { delta: 40, type: 'earn', reason: 'Chore', created_by: admin },
    { delta: -40, type: 'reversal', reason: 'Chore', created_by: child1 },
  ], 'die Gegenbuchung trägt den Aufgabentitel und wer zurückgenommen hat');
  assert.equal(getBalance(db, child1), before);

  const [earn, reversal] = db.prepare('SELECT id, series_id, reverses_id FROM reward_ledger WHERE task_id = ? ORDER BY id ASC').all(taskId);
  assert.equal(earn.series_id, taskId, 'die Gutschrift trägt ihre Serie - ein erstes Vorkommen ist seine eigene');
  assert.equal(reversal.reverses_id, earn.id, 'die Gegenbuchung zeigt auf ihre Gutschrift, nicht nur auf dieselbe Aufgabe');

  // Ein zweites Zurücknehmen findet nichts Offenes mehr.
  reverseTaskEarnings(db, taskId, admin);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reward_ledger WHERE task_id = ?').get(taskId).n, 2);
});

test('Die Gegenbuchung nimmt den GEBUCHTEN Betrag, nicht den heutigen Punktwert (#1607)', () => {
  const before = getBalance(db, child1);
  const taskId = makeTask(40, [child1]);
  syncTaskRewards(db, taskId, 'open', 'done', admin);
  db.prepare('UPDATE tasks SET points = 5 WHERE id = ?').run(taskId);
  syncTaskRewards(db, taskId, 'done', 'open', admin);
  assert.equal(getBalance(db, child1), before, 'sonst blieben 35 Punkte für eine offene Aufgabe stehen');
  // Die Neuvergabe nimmt dann den neuen Wert.
  syncTaskRewards(db, taskId, 'open', 'done', admin);
  assert.equal(getBalance(db, child1), before + 5);
});

test('Wechselt die Zuweisung zwischen Erledigen und Wiederöffnen, trifft die Gegenbuchung den Empfänger (#1607)', () => {
  db.prepare('INSERT OR IGNORE INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(child2);
  const b1 = getBalance(db, child1);
  const b2 = getBalance(db, child2);
  const taskId = makeTask(12, [child1]);
  syncTaskRewards(db, taskId, 'open', 'done', admin);
  db.prepare('UPDATE task_assignments SET user_id = ? WHERE task_id = ?').run(child2, taskId);
  syncTaskRewards(db, taskId, 'done', 'open', admin);
  assert.equal(getBalance(db, child1), b1, 'child1 hatte die Punkte und gibt sie zurück');
  assert.equal(getBalance(db, child2), b2, 'child2 hatte nie welche');
  db.prepare('DELETE FROM reward_participants WHERE user_id = ?').run(child2);
});

// --------------------------------------------------------
// Eine Serie zahlt je Person einmal am Tag (#1603)
// --------------------------------------------------------

/**
 * Folgeinstanz OHNE recurrence_series_id - so, wie sie in einem Bestand von vor
 * v230 steht: neue Zeile, zeigt nur auf die Vorgängerin. Die Tests darunter
 * halten damit den RÜCKFALL fest (Serie = Wurzel der Kette). Den Weg mit
 * mitreisender Kennung, auch über ein gelöschtes Vorkommen hinweg, fährt
 * test:tasks-routes über die echte Route.
 */
function makeFollowup(originId, points, assignees = []) {
  const id = db.prepare(`INSERT INTO tasks (title, status, created_by, points, is_recurring, recurrence_rule, recurrence_origin_id)
    VALUES ('Chore', 'open', ?, ?, 1, 'FREQ=DAILY', ?)`).run(admin, points, originId).lastInsertRowid;
  const ins = db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)');
  for (const uid of assignees) ins.run(id, uid);
  return id;
}

/** Abhaken wie die Route: erst die Punkte, dann der Verlauf - mit festgenagelter Uhr. */
function complete(taskId, when, { by = admin, doneBy = null } = {}) {
  syncTaskRewards(db, taskId, 'open', 'done', by, doneBy, { now: new Date(when) });
  syncTaskCompletion(db, taskId, 'open', 'done', by, doneBy);
}
function reopen(taskId, when, { by = admin } = {}) {
  syncTaskRewards(db, taskId, 'done', 'open', by, null, { now: new Date(when) });
  syncTaskCompletion(db, taskId, 'done', 'open', by, null);
}
function setZone(zone) {
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(zone);
}

test('Serie: die zweite Instanz am selben Haushaltstag bringt keine zweite Gutschrift (#1603)', () => {
  setZone('Europe/Berlin');
  const before = getBalance(db, child1);
  const a = makeTask(10, [child1]);
  complete(a, '2031-03-03T09:00:00Z');
  const b = makeFollowup(a, 10, [child1]);
  complete(b, '2031-03-03T09:00:05Z');
  const c = makeFollowup(b, 10, [child1]);
  complete(c, '2031-03-03T20:00:00Z');
  assert.equal(getBalance(db, child1), before + 10, 'drei Haken an einem Tag sind eine Gutschrift');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_completions WHERE task_id IN (?, ?, ?)').get(a, b, c).n, 3,
    'das Abhaken selbst bleibt erlaubt und steht im Verlauf');

  // Am nächsten Tag zahlt die Serie wieder.
  const e = makeFollowup(c, 10, [child1]);
  complete(e, '2031-03-04T09:00:00Z');
  assert.equal(getBalance(db, child1), before + 20);
});

test('Serie: der Tag ist der Haushaltstag, nicht der UTC-Tag (#1603)', () => {
  // 10:00Z und 12:00Z liegen am selben UTC-Tag. In Auckland (UTC+13 im März)
  // ist das 23:00 am 3. und 01:00 am 4. - zwei Tage, zwei Gutschriften.
  setZone('Pacific/Auckland');
  const before = getBalance(db, child1);
  const a = makeTask(10, [child1]);
  complete(a, '2031-03-03T10:00:00Z');
  const b = makeFollowup(a, 10, [child1]);
  complete(b, '2031-03-03T12:00:00Z');
  assert.equal(getBalance(db, child1), before + 20, 'über Mitternacht der Haushaltszone hinweg zahlt die Serie zweimal');

  // Umgekehrt: 23:30Z am 3. und 00:30Z am 4. sind zwei UTC-Tage, in Auckland
  // aber derselbe 4. (12:30 und 13:30) - eine Gutschrift.
  const c = makeTask(10, [child1]);
  complete(c, '2031-03-03T23:30:00Z');
  const e = makeFollowup(c, 10, [child1]);
  complete(e, '2031-03-04T00:30:00Z');
  assert.equal(getBalance(db, child1), before + 30, 'zwei UTC-Tage, ein Haushaltstag: der Deckel greift');
  setZone('Europe/Berlin');
});

test('Serie: der Deckel gilt je Person (#1603)', () => {
  db.prepare('INSERT OR IGNORE INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(child2);
  const b1 = getBalance(db, child1);
  const b2 = getBalance(db, child2);
  const a = makeTask(10, [child1, child2]);
  complete(a, '2031-04-01T09:00:00Z');
  assert.equal(getBalance(db, child1), b1 + 10);
  assert.equal(getBalance(db, child2), b2 + 10, 'mehrere Zugewiesene: jede Person bekommt ihre eine Gutschrift');

  // Die zweite Instanz erledigt nachweislich child2 - child2 ist für heute
  // schon vergütet, child1 wird nicht benannt und bekommt auch nichts.
  const b = makeFollowup(a, 10, [child1, child2]);
  complete(b, '2031-04-01T10:00:00Z', { doneBy: child2 });
  assert.equal(getBalance(db, child1), b1 + 10);
  assert.equal(getBalance(db, child2), b2 + 10);

  // Eine Person, die heute für diese Serie noch nichts bekommen hat, bekommt es.
  const x = makeTask(10, [child1]);
  complete(x, '2031-04-02T09:00:00Z');
  const y = makeFollowup(x, 10, [child1]);
  complete(y, '2031-04-02T10:00:00Z', { doneBy: child2 });
  assert.equal(getBalance(db, child2), b2 + 20, 'child1 war vergütet, child2 für diese Serie heute noch nicht');
  db.prepare('DELETE FROM reward_participants WHERE user_id = ?').run(child2);
});

test('Serie: Wiederöffnen und erneut Erledigen am selben Tag verliert die Gutschrift nicht (#1603, #1607)', () => {
  const before = getBalance(db, child1);
  const a = makeTask(10, [child1]);
  complete(a, '2031-05-01T09:00:00Z');
  reopen(a, '2031-05-01T09:01:00Z');
  assert.equal(getBalance(db, child1), before);
  complete(a, '2031-05-01T09:02:00Z');
  assert.equal(getBalance(db, child1), before + 10, 'die eigene, zurückgenommene Gutschrift sperrt die Neuvergabe nicht');

  // Und mit einer gedeckelten Folgeinstanz dazwischen: die zurückgenommene
  // Gutschrift der Vorgängerin zählt nicht mehr als "heute schon vergütet".
  const b = makeFollowup(a, 10, [child1]);
  complete(b, '2031-05-01T09:03:00Z');
  assert.equal(getBalance(db, child1), before + 10, 'gedeckelt');
  reopen(b, '2031-05-01T09:04:00Z');
  reopen(a, '2031-05-01T09:05:00Z');
  assert.equal(getBalance(db, child1), before);
  complete(a, '2031-05-01T09:06:00Z');
  assert.equal(getBalance(db, child1), before + 10);
});

test('Serie: auch die Teilaufgaben einer Folgeinstanz zahlen am selben Tag nicht noch einmal (#1603)', () => {
  // Teilaufgaben tragen eigene Punkte und werden mit jeder Folgeinstanz neu
  // angelegt (recurrence_origin_id zeigt auf die Teilaufgabe der Vorgängerin).
  // Im Verlauf stehen sie bewusst nicht - der Deckel darf deshalb nicht allein
  // an task_completions hängen, sonst bliebe die Lücke über die Checkliste offen.
  const before = getBalance(db, child1);
  const sub = (parent, origin, createdAt) => db.prepare(`INSERT INTO tasks
      (title, status, created_by, points, parent_task_id, recurrence_origin_id, created_at)
    VALUES ('Schritt', 'open', ?, 5, ?, ?, ?)`).run(admin, parent, origin, createdAt).lastInsertRowid;
  const assign = (id) => db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(id, child1);

  const a = makeTask(0, [child1]);
  const sa = sub(a, null, '2031-07-01T08:00:00Z'); assign(sa);
  complete(sa, '2031-07-01T09:00:00Z');
  complete(a, '2031-07-01T09:00:10Z');
  assert.equal(getBalance(db, child1), before + 5);

  // Die Folgeinstanz entsteht mit dem Abhaken der Vorgängerin - ihr
  // Anlagezeitpunkt IST deren Erledigung.
  const b = makeFollowup(a, 0, [child1]);
  const sb = sub(b, sa, '2031-07-01T09:00:10Z'); assign(sb);
  complete(sb, '2031-07-01T09:01:00Z');
  assert.equal(getBalance(db, child1), before + 5, 'dieselbe Teilaufgabe, derselbe Tag: eine Gutschrift');

  const c = makeFollowup(b, 0, [child1]);
  const sc = sub(c, sb, '2031-07-01T09:01:10Z'); assign(sc);
  complete(sc, '2031-07-02T09:00:00Z');
  assert.equal(getBalance(db, child1), before + 10, 'am nächsten Tag zahlt sie wieder');
});

test('Serie: zwei verschiedene Serien am selben Tag zahlen beide (#1603)', () => {
  const before = getBalance(db, child1);
  complete(makeTask(10, [child1]), '2031-06-01T09:00:00Z');
  complete(makeTask(10, [child1]), '2031-06-01T09:00:00Z');
  assert.equal(getBalance(db, child1), before + 20, 'der Deckel hängt an der Serie, nicht am Tag');
});

test('Ohne Zuweisung erhält die handelnde Person (Kiosk)', () => {
  const before = getBalance(db, child1);
  const taskId = makeTask(15, []);
  awardForCompletion(db, taskId, child1);
  assert.equal(getBalance(db, child1), before + 15);
});

test('Die benannte erledigende Person bekommt die Punkte, nicht die zustaendige (#1205)', () => {
  // child1 nimmt teil (oben eingeschrieben), child2 nicht.
  db.prepare('INSERT OR IGNORE INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(child2);
  const before1 = getBalance(db, child1);
  const before2 = getBalance(db, child2);

  const taskId = makeTask(20, [child1]);           // zugewiesen an child1 ...
  awardForCompletion(db, taskId, admin, child2);   // ... erledigt hat es child2

  assert.equal(getBalance(db, child2), before2 + 20, 'wer es getan hat, bekommt sie');
  assert.equal(getBalance(db, child1), before1, 'die Zuweisung allein bucht nichts mehr');
});

test('Eine benannte Person, die nicht teilnimmt, bucht nichts - auch nicht auf die Zustaendigen (#1205)', () => {
  // Der Rueckfall auf die Zuweisung waere hier die falscheste der drei
  // moeglichen Antworten: die Punkte gingen an jemanden, von dem gerade
  // festgehalten wurde, dass er es NICHT getan hat.
  db.prepare('DELETE FROM reward_participants WHERE user_id = ?').run(child2);
  const before1 = getBalance(db, child1);
  const before2 = getBalance(db, child2);

  const taskId = makeTask(25, [child1]);
  awardForCompletion(db, taskId, admin, child2);

  assert.equal(getBalance(db, child1), before1);
  assert.equal(getBalance(db, child2), before2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reward_ledger WHERE task_id = ? AND type='earn'").get(taskId).n, 0);
});

test('Das Zuruecknehmen holt auch die an die erledigende Person gebuchten Punkte zurueck (#1205)', () => {
  // reverseTaskEarnings filtert bewusst NICHT nach Person - seit die Punkte an
  // eine benannte Person gehen koennen, waere jeder Personenfilter genau die
  // Buchung, die stehen bliebe.
  db.prepare('INSERT OR IGNORE INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(child2);
  const before = getBalance(db, child2);
  const taskId = makeTask(35, [child1]);

  syncTaskRewards(db, taskId, 'open', 'done', admin, child2);
  assert.equal(getBalance(db, child2), before + 35);

  syncTaskRewards(db, taskId, 'done', 'open', admin);
  assert.equal(getBalance(db, child2), before, 'Storno kennt die Person nicht und braucht sie nicht');
  db.prepare('DELETE FROM reward_participants WHERE user_id = ?').run(child2);
});

test('Ohne Benennung gilt die Zuweisungsregel unveraendert (#1205)', () => {
  const before = getBalance(db, child1);
  const taskId = makeTask(10, [child1]);
  awardForCompletion(db, taskId, admin, null);
  assert.equal(getBalance(db, child1), before + 10);
});

test('Aufgabe ohne Punkte bucht nichts', () => {
  const taskId = makeTask(0, [child1]);
  awardForCompletion(db, taskId, admin);
  const n = db.prepare('SELECT COUNT(*) AS n FROM reward_ledger WHERE task_id = ?').get(taskId).n;
  assert.equal(n, 0);
});

// --------------------------------------------------------
// HTTP-Setup
// --------------------------------------------------------
const authCtx = { userId: admin, role: 'admin' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = authCtx.userId;
  req.authRole = authCtx.role;
  req.session = { userId: authCtx.userId };
  next();
});
app.use('/api/v1/rewards', rewardsRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const port = server.address().port;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path, method,
      headers: { 'Content-Type': 'application/json' } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function asAdmin() { authCtx.userId = admin; authCtx.role = 'admin'; }
function asChild(id) { authCtx.userId = id; authCtx.role = 'member'; }

// --------------------------------------------------------
// Routen
// --------------------------------------------------------
test('PUT /participants: Admin aktiviert, Member 403', async () => {
  asAdmin();
  const ok = await request('PUT', `/api/v1/rewards/participants/${child2}`, { enabled: true });
  assert.equal(ok.status, 200);
  assert.equal(isEnrolled(db, child2), true);

  asChild(child1);
  const denied = await request('PUT', `/api/v1/rewards/participants/${child2}`, { enabled: false });
  assert.equal(denied.status, 403);
  assert.equal(isEnrolled(db, child2), true, 'Member darf nichts ändern');
});

let rewardId;
test('POST /catalog (Admin) + GET /catalog', async () => {
  asAdmin();
  const created = await request('POST', '/api/v1/rewards/catalog', { name: 'Kinoabend', cost: 100, icon: '🎬' });
  assert.equal(created.status, 201);
  rewardId = created.body.data.id;

  asChild(child1);
  const denied = await request('POST', '/api/v1/rewards/catalog', { name: 'X', cost: 5 });
  assert.equal(denied.status, 403);

  const list = await request('GET', '/api/v1/rewards/catalog');
  assert.ok(list.body.data.some((r) => r.id === rewardId));
});

test('GET /overview listet teilnehmende Salden mit Rang', async () => {
  asAdmin();
  const res = await request('GET', '/api/v1/rewards/overview');
  assert.equal(res.status, 200);
  const ids = res.body.data.balances.map((b) => b.id);
  assert.ok(ids.includes(child1) && ids.includes(child2));
  for (const b of res.body.data.balances) assert.ok(typeof b.rank === 'number');
});

test('POST /bonus schreibt gut, GET /ledger zeigt Buchung', async () => {
  asAdmin();
  const before = getBalance(db, child1);
  const res = await request('POST', '/api/v1/rewards/bonus', { user_id: child1, delta: 25, reason: 'geholfen' });
  assert.equal(res.status, 201);
  assert.equal(getBalance(db, child1), before + 25);

  const ledger = await request('GET', `/api/v1/rewards/ledger?user_id=${child1}`);
  assert.ok(ledger.body.data.some((l) => l.type === 'bonus' && l.delta === 25));
});

test('Einlösen reserviert Punkte, unzureichend → 400', async () => {
  asChild(child1);
  const bal = getBalance(db, child1);
  // Prämie kostet 100 — child1 hat aktuell < 100? sicherstellen: Saldo prüfen.
  const res = await request('POST', '/api/v1/rewards/redemptions', { catalog_id: rewardId });
  if (bal >= 100) {
    assert.equal(res.status, 201);
    assert.equal(getBalance(db, child1), bal - 100);
  } else {
    assert.equal(res.status, 400);
  }
});

test('Reject bucht reservierte Punkte zurück', async () => {
  // child2 mit genug Punkten ausstatten
  asAdmin();
  await request('POST', '/api/v1/rewards/bonus', { user_id: child2, delta: 200 });
  const balBefore = getBalance(db, child2);

  asChild(child2);
  const redeem = await request('POST', '/api/v1/rewards/redemptions', { catalog_id: rewardId });
  assert.equal(redeem.status, 201);
  assert.equal(getBalance(db, child2), balBefore - 100);
  const redemptionId = redeem.body.data.id;

  // Member darf nicht freigeben
  const denied = await request('PATCH', `/api/v1/rewards/redemptions/${redemptionId}`, { action: 'fulfill' });
  assert.equal(denied.status, 403);

  asAdmin();
  const rejected = await request('PATCH', `/api/v1/rewards/redemptions/${redemptionId}`, { action: 'reject' });
  assert.equal(rejected.status, 200);
  assert.equal(getBalance(db, child2), balBefore, 'Punkte zurückgebucht');
});

test('Fulfill behält Abzug', async () => {
  asAdmin();
  await request('POST', '/api/v1/rewards/bonus', { user_id: child2, delta: 100 });
  const balBefore = getBalance(db, child2);
  asChild(child2);
  const redeem = await request('POST', '/api/v1/rewards/redemptions', { catalog_id: rewardId });
  const id = redeem.body.data.id;
  asAdmin();
  const done = await request('PATCH', `/api/v1/rewards/redemptions/${id}`, { action: 'fulfill' });
  assert.equal(done.status, 200);
  assert.equal(getBalance(db, child2), balBefore - 100);
  // Erneutes Entscheiden abgelehnt
  const again = await request('PATCH', `/api/v1/rewards/redemptions/${id}`, { action: 'reject' });
  assert.equal(again.status, 409);
});

test('Ohne Eltern-Freigabe (rewards_require_approval=0) wird sofort gutgeschrieben', async () => {
  asAdmin();
  await request('POST', '/api/v1/rewards/bonus', { user_id: child2, delta: 100 });
  const balBefore = getBalance(db, child2);
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('rewards_require_approval', '0') ON CONFLICT(key) DO UPDATE SET value = '0'").run();

  asChild(child2);
  const redeem = await request('POST', '/api/v1/rewards/redemptions', { catalog_id: rewardId });
  assert.equal(redeem.status, 201);
  assert.equal(redeem.body.data.status, 'fulfilled', 'sofort erfüllt ohne Freigabe');
  assert.ok(redeem.body.data.decided_at, 'decided_at gesetzt');
  assert.equal(getBalance(db, child2), balBefore - 100, 'Punkte bleiben abgezogen');

  // Bereits erfüllt → erneutes Entscheiden abgelehnt.
  asAdmin();
  const again = await request('PATCH', `/api/v1/rewards/redemptions/${redeem.body.data.id}`, { action: 'reject' });
  assert.equal(again.status, 409);

  // Default (Freigabe nötig) wiederherstellen.
  db.prepare("UPDATE sync_config SET value = '1' WHERE key = 'rewards_require_approval'").run();
});

// --------------------------------------------------------
// Stellvertretung (#655): Eltern erledigen mit jüngeren Kindern, die sich nicht
// selbst anmelden. Beide Hälften des Wunsches trägt der Bestand schon - dieser
// Abschnitt hält sie fest, damit sie nicht als Nebeneffekt verlorengehen.
// --------------------------------------------------------

test('Punkte gehen an die zugewiesene Person, nicht an die abhakende (#655)', () => {
  // Die übrigen Vergabe-Tests belegen das nur zufällig: dort nimmt die handelnde
  // Person gar nicht am Punktesystem teil, kann also ohnehin nichts bekommen.
  // Hier tut sie es - erst dann ist "der Zugewiesene verdient" eine echte Aussage.
  const parent = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('papa', 'Papa', 'x', 'member')").run().lastInsertRowid;
  db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(parent);

  const parentBefore = getBalance(db, parent);
  const childBefore = getBalance(db, child1);

  const taskId = makeTask(25, [child1]);
  awardForCompletion(db, taskId, parent);

  assert.equal(getBalance(db, child1), childBefore + 25, 'das Kind erhält die Punkte');
  assert.equal(getBalance(db, parent), parentBefore, 'der abhakende Elternteil erhält nichts');

  // Aufräumen: ein zusätzlicher Teilnehmer würde spätere Salden-/Rang-Tests
  // verschieben, falls dieser Block je nach vorne wandert.
  db.prepare('DELETE FROM reward_participants WHERE user_id = ?').run(parent);
});

test('Admin löst stellvertretend ein; ein Mitglied nur für sich selbst (#655)', async () => {
  asAdmin();
  await request('POST', '/api/v1/rewards/bonus', { user_id: child1, delta: 500 });
  const child1Before = getBalance(db, child1);

  // Elternteil löst für das Kind ein: der Abzug trifft das Kind, nicht den Admin.
  const proxy = await request('POST', '/api/v1/rewards/redemptions', { catalog_id: rewardId, user_id: child1 });
  assert.equal(proxy.status, 201);
  assert.equal(getBalance(db, child1), child1Before - 100, 'die Punkte des Kindes werden reserviert');

  // Gegenprobe: ein Mitglied, das eine fremde user_id mitschickt, löst für sich
  // selbst ein. Die fremde Angabe wird ignoriert, nicht befolgt - keine
  // Rechteausweitung, aber auch kein Fehler, den der Aufrufer bemerken würde.
  asAdmin();
  await request('POST', '/api/v1/rewards/bonus', { user_id: child2, delta: 500 });
  const c1 = getBalance(db, child1);
  const c2 = getBalance(db, child2);

  asChild(child2);
  const spoofed = await request('POST', '/api/v1/rewards/redemptions', { catalog_id: rewardId, user_id: child1 });
  assert.equal(spoofed.status, 201);
  assert.equal(getBalance(db, child1), c1, 'das fremde Konto bleibt unberührt');
  assert.equal(getBalance(db, child2), c2 - 100, 'abgebucht wird beim Aufrufer selbst');
});

test('Seite: der Kontext-FAB dockt am Desktop an (Aktions-Slot, Nomen je Tab, Nomen bleibt beim Ausblenden), Zeilenaktion nennt die Praemie', async () => {
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../public/pages/rewards.js', import.meta.url), 'utf8');
  // Ohne Slot im Kopf dockt der Router (dockFabIntoToolbar) stumm nicht an.
  assert.match(page, /<h1 class="page-toolbar__title" id="rewards-title">[^\n]*\n\s*<div class="page-toolbar__actions"><\/div>/,
    'der Belohnungen-Kopf braucht den Aktions-Slot fuer die Kopf-Pille');
  assert.match(page, /createPageFab\(\{[^}]*dockLabel: t\('newLabel\.rewards'\)/, 'createPageFab ohne Nomen dockt nie an');
  const fn = page.match(/function updateRewardsFab\(\)[\s\S]*?\n}\n/)?.[0];
  assert.ok(fn, 'updateRewardsFab() nicht gefunden');
  const calls = fn.match(/setPageFabAction\(fab, \{[^\n]*\}\)/g) ?? [];
  assert.ok(calls.length >= 4, `erwartet: Katalog, Buchungen und zwei Ausblend-Zweige, gefunden ${calls.length}`);
  // Auch ausgeblendet: der Router dockt nur beim Seitenaufbau und nur mit Nomen an.
  for (const call of calls) assert.match(call, /dockLabel:/, `ohne Nomen: ${call}`);
  assert.match(page, /rowActionHtml\(\{ icon: 'pencil', label: t\('common\.editNamed', \{ name: item\.name \}\)/,
    'Bearbeiten an der Praemienkarte: .row-action mit dem Namen der Praemie');
});

test.after(() => { server.close(); db.close(); });
