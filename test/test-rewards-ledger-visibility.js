/**
 * Modul: Punkte-Verlauf und die Sichtbarkeit der Aufgabe dahinter
 * Zweck: Eine Gutschrift traegt den TITEL der erledigten Aufgabe als `reason`
 *        (services/rewards.js schreibt ihn als Schnappschuss) und ihre
 *        `task_id`. `GET /api/v1/rewards/ledger` lieferte beides ungefiltert an
 *        jeden, der das Modul lesen darf - also auch den Titel einer privaten
 *        Aufgabe, die `GET /tasks/:id` demselben Mitglied mit 404 verweigert.
 *        Diese Suite haelt fest:
 *          1. `reason` und `task_id` gehen nur an die Person, der die Zeile
 *             gehoert, oder an jemanden, der die Aufgabe ueber die
 *             Aufgaben-Regel sieht (`all` / Ersteller:in / Zugewiesene). Sonst
 *             `null`. Zeile, Betrag und damit der Saldo bleiben fuer alle da.
 *          2. Kein Admin-Bypass - die Aufgaben-Sichtbarkeit kennt auch keinen.
 *          3. Die Maske haengt an `task_id`/`reason`, nicht am Typ: eine
 *             Rueckbuchung mit Aufgabenbezug ist genauso gedeckt wie die
 *             Gutschrift.
 *          4. Ist die Aufgabe geloescht (`task_id` NULL, der Titel steht noch
 *             im Schnappschuss), sieht ihn nur die Person, der die Zeile
 *             gehoert. Bonus, Korrektur und Einloesung nennen keine Aufgabe
 *             und bleiben fuer alle lesbar.
 *          5. Gelesen wird die Regel beim LESEN: eine Aufgabe, die spaeter fuer
 *             alle sichtbar wird, nennt ihren Titel dann auch.
 *          6. Das Pfad-Gate: mit Modulrecht `rewards: none` ist der ganze
 *             Router zu. Gemessen durch den ECHTEN Server (test/server-ready.js),
 *             ein nackt eingehaengter Router sieht das Gate nie.
 * Ausfuehren: npm run test:rewards-ledger-visibility
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'rewards-ledger-visibility',
  env: { SESSION_SECRET: 'test-rewards-ledger-visibility-secret-min32' },
});
const dbmod = await import('../server/db.js');
const db = dbmod.get();

await fetch(`${BASE}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});

async function login(username, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login ${username}`);
  const cookie = cookieHeader(res.headers.get('set-cookie'));
  const me = await (await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: cookie } })).json();
  return { cookie, csrfToken: me.csrfToken };
}

function as(session) {
  const headers = { 'Content-Type': 'application/json', Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken };
  return async (method, path, body) => {
    const res = await fetch(`${BASE}/api/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

const admin = as(await login('admin', 'adminpass123'));

async function member(username) {
  const created = await admin('POST', '/auth/users', { username, display_name: username, password: `${username}-pass-123` });
  assert.equal(created.status, 201, `Konto ${username}`);
  return { id: created.body.user.id, call: as(await login(username, `${username}-pass-123`)) };
}

const owner    = await member('owner');
const assignee = await member('assignee');
const outsider = await member('outsider');
const locked   = await member('locked');

// OWNER und ASSIGNEE sammeln Punkte, OUTSIDER nicht: lesen darf den Verlauf
// jeder mit dem Modul, eingeschrieben oder nicht.
for (const m of [owner, assignee]) {
  assert.equal((await admin('PUT', `/rewards/participants/${m.id}`, { enabled: true })).status, 200);
}
assert.equal((await admin('PUT', `/permissions/user/${locked.id}`, { modules: { rewards: 'none' } })).status, 200);

const SECRET = 'GEHEIM';

/** Eine Aufgabe von OWNER mit Punkten, abgehakt von `doneBy` - danach steht eine Gutschrift. */
async function earned(visibility, { assignedTo, doneBy = owner } = {}) {
  const created = await owner.call('POST', '/tasks', {
    title: `${SECRET}-${visibility}-${Math.random().toString(36).slice(2, 8)}`,
    visibility, points: 5, ...(assignedTo ? { assigned_to: [assignedTo.id] } : {}),
  });
  assert.equal(created.status, 201);
  const ticked = await doneBy.call('PATCH', `/tasks/${created.body.data.id}/status`, { status: 'done' });
  assert.equal(ticked.status, 200);
  const row = db.prepare("SELECT * FROM reward_ledger WHERE task_id = ? AND type = 'earn'").get(created.body.data.id);
  assert.ok(row, 'die Probe braucht eine Gutschrift');
  return { taskId: created.body.data.id, title: created.body.data.title, ledgerId: row.id, recipient: row.user_id };
}

/** Die Zeile `ledgerId`, wie `viewer` sie ueber die Route sieht. */
async function seenBy(viewer, ledgerId, query = '') {
  const res = await viewer('GET', `/rewards/ledger${query}`);
  assert.equal(res.status, 200);
  return res.body.data.find((r) => r.id === ledgerId);
}

function assertMasked(row, message) {
  assert.ok(row, `${message}: die Zeile fehlt ganz - Betrag und Saldo sollen sichtbar bleiben`);
  assert.equal(row.delta, 5, `${message}: der Betrag`);
  assert.deepEqual({ reason: row.reason, task_id: row.task_id }, { reason: null, task_id: null }, message);
}

test('private Aufgabe: der Titel geht nur an die Person, der die Gutschrift gehoert', async () => {
  const e = await earned('private');
  assert.equal(e.recipient, owner.id);
  // Die Voraussetzung: fuer den Fremden gibt es die Aufgabe nicht.
  assert.equal((await outsider.call('GET', `/tasks/${e.taskId}`)).status, 404);

  assertMasked(await seenBy(outsider.call, e.ledgerId), 'fremdes Mitglied');
  assertMasked(await seenBy(outsider.call, e.ledgerId, `?user_id=${owner.id}`), 'fremdes Mitglied, nach Person gefiltert');
  // Kein Admin-Bypass, wie bei der Aufgabe selbst (#474).
  assert.equal((await admin('GET', `/tasks/${e.taskId}`)).status, 404);
  assertMasked(await seenBy(admin, e.ledgerId), 'Admin');

  const mine = await seenBy(owner.call, e.ledgerId);
  assert.deepEqual({ reason: mine.reason, task_id: mine.task_id }, { reason: e.title, task_id: e.taskId });
  // Name und Betrag stehen in jeder Fassung - der Saldo bleibt nachvollziehbar.
  assert.equal((await seenBy(outsider.call, e.ledgerId)).user_name, 'owner');
});

test('assignees-Aufgabe: Empfaengerin und Erstellerin lesen den Titel, ein Dritter nicht', async () => {
  const e = await earned('assignees', { assignedTo: assignee, doneBy: assignee });
  assert.equal(e.recipient, assignee.id);

  assertMasked(await seenBy(outsider.call, e.ledgerId), 'fremdes Mitglied');
  assertMasked(await seenBy(admin, e.ledgerId), 'Admin');
  assert.equal((await seenBy(assignee.call, e.ledgerId)).reason, e.title, 'die Empfaengerin');
  // Nicht Empfaengerin, aber sie sieht die Aufgabe - die Aufgaben-Regel traegt.
  const creator = await seenBy(owner.call, e.ledgerId);
  assert.deepEqual({ reason: creator.reason, task_id: creator.task_id }, { reason: e.title, task_id: e.taskId });
});

test('Aufgabe fuer alle: der Verlauf nennt sie jedem, wie bisher', async () => {
  const e = await earned('all');
  for (const [label, viewer] of [['outsider', outsider.call], ['assignee', assignee.call], ['admin', admin]]) {
    const row = await seenBy(viewer, e.ledgerId);
    assert.deepEqual({ reason: row.reason, task_id: row.task_id }, { reason: e.title, task_id: e.taskId }, label);
  }
});

test('die Regel wird beim Lesen gefragt: wird die Aufgabe fuer alle sichtbar, nennt der Verlauf sie', async () => {
  const e = await earned('private');
  assertMasked(await seenBy(outsider.call, e.ledgerId), 'solange privat');
  db.prepare("UPDATE tasks SET visibility = 'all' WHERE id = ?").run(e.taskId);
  assert.equal((await seenBy(outsider.call, e.ledgerId)).reason, e.title);
  db.prepare("UPDATE tasks SET visibility = 'private' WHERE id = ?").run(e.taskId);
  assertMasked(await seenBy(outsider.call, e.ledgerId), 'wieder privat');
});

test('die Maske haengt an task_id und reason, nicht am Typ', async () => {
  // Eine Rueckbuchung mit Aufgabenbezug gibt es als Schreibweg noch nicht; die
  // Spalten erlauben sie, und eine Maske, die nur `earn` kennt, liesse sie durch.
  const e = await earned('private');
  const reversal = db.prepare(`
    INSERT INTO reward_ledger (user_id, delta, type, reason, task_id, created_by)
    VALUES (?, 5, 'reversal', ?, ?, ?)
  `).run(owner.id, e.title, e.taskId, owner.id).lastInsertRowid;

  assertMasked(await seenBy(outsider.call, reversal), 'Rueckbuchung mit Aufgabenbezug');
  assert.equal((await seenBy(owner.call, reversal)).reason, e.title);
});

test('Gegenbuchung beim Wiederoeffnen: sie nennt die Aufgabe genauso wenig wie die Gutschrift', async () => {
  // Seit #1617 loescht das Wiederoeffnen die Gutschrift nicht mehr, sondern
  // bucht gegen: eine zweite Zeile (`reversal`) mit `task_id`, demselben Titel
  // und `reverses_id`. Sie entsteht hier ueber den echten Weg.
  const e = await earned('private');
  assert.equal((await owner.call('PATCH', `/tasks/${e.taskId}/status`, { status: 'open' })).status, 200);
  const reversal = db.prepare("SELECT * FROM reward_ledger WHERE task_id = ? AND type = 'reversal'").get(e.taskId);
  assert.ok(reversal, 'die Probe braucht eine Gegenbuchung');
  assert.equal(reversal.reason, e.title, 'die Probe braucht den Titel in der Gegenbuchung');
  assert.equal(reversal.reverses_id, e.ledgerId);

  for (const [label, viewer] of [['fremdes Mitglied', outsider.call], ['Admin', admin]]) {
    const row = await seenBy(viewer, reversal.id);
    assert.ok(row, `${label}: die Gegenbuchung fehlt - der Saldo liesse sich nicht nachrechnen`);
    assert.equal(row.delta, -5);
    assert.deepEqual({ reason: row.reason, task_id: row.task_id }, { reason: null, task_id: null }, label);
    // Die Antwort traegt weder die Serie noch den Verweis auf die Gutschrift.
    assert.deepEqual(Object.keys(row).filter((k) => /series|reverses/.test(k)), [], `${label}: Verweisspalten in der Antwort`);
    assert.ok(!JSON.stringify(row).includes(SECRET), `${label}: die Zeile nennt den Titel`);
  }
  assert.equal((await seenBy(owner.call, reversal.id)).reason, e.title);

  // Mit der Aufgabe verlieren BEIDE Zeilen ihre task_id - der Schnappschuss
  // bleibt bei der Person, der sie gehoeren.
  assert.equal((await owner.call('DELETE', `/tasks/${e.taskId}`)).status, 200);
  for (const id of [e.ledgerId, reversal.id]) {
    const row = await seenBy(outsider.call, id);
    assert.deepEqual({ reason: row.reason, task_id: row.task_id }, { reason: null, task_id: null });
    assert.equal((await seenBy(owner.call, id)).reason, e.title);
  }
});

test('geloeschte Aufgabe: der Schnappschuss des Titels bleibt bei der Person, der die Zeile gehoert', async () => {
  const e = await earned('private');
  assert.equal((await owner.call('DELETE', `/tasks/${e.taskId}`)).status, 200);
  const stored = db.prepare('SELECT task_id, reason FROM reward_ledger WHERE id = ?').get(e.ledgerId);
  assert.deepEqual(stored, { task_id: null, reason: e.title }, 'die Probe braucht den Schnappschuss ohne Aufgabe');

  assertMasked(await seenBy(outsider.call, e.ledgerId), 'fremdes Mitglied');
  assertMasked(await seenBy(admin, e.ledgerId), 'Admin');
  assert.equal((await seenBy(owner.call, e.ledgerId)).reason, e.title);

  // Auch eine Aufgabe fuer ALLE: ohne Zeile laesst sich nicht mehr fragen, wer
  // sie sah - die engere Antwort ist die einzige, die nichts verraten kann.
  const open = await earned('all');
  assert.equal((await owner.call('DELETE', `/tasks/${open.taskId}`)).status, 200);
  assertMasked(await seenBy(outsider.call, open.ledgerId), 'geloeschte Aufgabe fuer alle');

  // Eine Rueckbuchung ohne Aufgabe und ohne Einloesung ist derselbe Fall.
  const orphan = db.prepare(`
    INSERT INTO reward_ledger (user_id, delta, type, reason) VALUES (?, 5, 'reversal', ?)
  `).run(owner.id, `${SECRET}-verwaist`).lastInsertRowid;
  assertMasked(await seenBy(outsider.call, orphan), 'verwaiste Rueckbuchung');
});

test('Bonus, Korrektur und Einloesung nennen keine Aufgabe und bleiben fuer alle lesbar', async () => {
  const bonus = await admin('POST', '/rewards/bonus', { user_id: owner.id, delta: 5, reason: 'Fuers Helfen' });
  assert.ok(bonus.status === 200 || bonus.status === 201, `Bonus: ${bonus.status}`);
  const bonusRow = db.prepare("SELECT id FROM reward_ledger WHERE type = 'bonus' ORDER BY id DESC LIMIT 1").get();
  assert.equal((await seenBy(outsider.call, bonusRow.id)).reason, 'Fuers Helfen');

  const ids = {};
  for (const type of ['adjust', 'redeem']) {
    ids[type] = db.prepare('INSERT INTO reward_ledger (user_id, delta, type, reason) VALUES (?, 5, ?, ?)')
      .run(owner.id, type, `Grund ${type}`).lastInsertRowid;
    assert.equal((await seenBy(outsider.call, ids[type])).reason, `Grund ${type}`, type);
  }

  // Die Rueckbuchung einer Einloesung traegt deren Kennung und den Namen der Praemie.
  const item = db.prepare("INSERT INTO reward_catalog (name, cost) VALUES ('Kinoabend', 5)").run().lastInsertRowid;
  const redemption = db.prepare(
    "INSERT INTO reward_redemptions (user_id, catalog_id, reward_name, cost, status) VALUES (?, ?, 'Kinoabend', 5, 'rejected')",
  ).run(owner.id, item).lastInsertRowid;
  const refund = db.prepare(`
    INSERT INTO reward_ledger (user_id, delta, type, reason, redemption_id) VALUES (?, 5, 'reversal', 'Kinoabend', ?)
  `).run(owner.id, redemption).lastInsertRowid;
  assert.equal((await seenBy(outsider.call, refund)).reason, 'Kinoabend');
});

test('rewards: none - das Pfad-Gate schliesst den ganzen Router', async () => {
  for (const path of ['/rewards/ledger', `/rewards/ledger?user_id=${owner.id}`, '/rewards/overview', '/Rewards/Ledger']) {
    const r = await locked.call('GET', path);
    assert.equal(r.status, 403, `GET ${path}`);
    assert.ok(!JSON.stringify(r.body).includes(SECRET), `GET ${path} nennt einen Titel`);
  }
});

test('Uebersicht und Dashboard nennen keinen verborgenen Titel', async () => {
  // `/rewards/overview` traegt nur Salden und Katalog. Das Dashboard zeigt
  // "zuletzt verdient" ausschliesslich aus den EIGENEN Zeilen (`user_id = ich`),
  // also aus Buchungen, deren Titel die Person ohnehin lesen darf.
  await earned('private');
  await earned('assignees', { assignedTo: assignee, doneBy: assignee });
  for (const [label, viewer] of [['outsider', outsider.call], ['admin', admin]]) {
    for (const path of ['/rewards/overview', '/dashboard']) {
      const r = await viewer('GET', path);
      assert.equal(r.status, 200, `${label} GET ${path}`);
      const text = JSON.stringify(r.body);
      assert.ok(!text.includes(`${SECRET}-private`) && !text.includes(`${SECRET}-assignees`), `${label} GET ${path} nennt einen verborgenen Titel`);
    }
  }
  // Die eigene Gutschrift steht dagegen im eigenen Dashboard, mit Titel.
  const own = await owner.call('GET', '/dashboard');
  assert.ok(JSON.stringify(own.body.rewards?.recent ?? own.body.data?.rewards?.recent ?? []).includes(`${SECRET}-private`),
    'die eigene Gutschrift fehlt in "zuletzt verdient"');
});
