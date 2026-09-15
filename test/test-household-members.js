/**
 * Modul: Haushaltsmitglied - wer in welcher Personenliste steht (#1207)
 * Zweck: Haelt fuer jede Personenliste aus `users` fest, wen sie HEUTE zeigt.
 *        Eine `users`-Zeile ist nicht automatisch ein Haushaltsmitglied
 *        (docs/DECISIONS.md, Eintrag 4): Hauspersonal (`housekeeping_workers`)
 *        und Geteilte-Ausgaben-Gaeste (`split_expense_guest_users`) stehen
 *        daneben. Die Listen filtern das heute NICHT einheitlich - drei
 *        Fassungen sind in Gebrauch, und diese Suite nagelt jede Liste auf ihre
 *        fest, damit das eine Praedikat die Listen buendeln kann, ohne eine
 *        davon still umzustellen.
 *
 *        Die Fixtures sind echte Zeilen: ein Admin-Elternteil, ein Kind, eine
 *        Haushaltskraft und ein Gast. Gemessen wird am echten Router ueber HTTP
 *        (bzw. an der exportierten Service-Funktion, wo es keine eigene Route
 *        gibt), nie an einer nachgebauten Query.
 *
 *        Die Frage, ob die Fassungen gleich sein SOLLTEN, beantwortet diese
 *        Suite ausdruecklich nicht - sie steht als offene Frage im PR zu #1207.
 * Ausfuehren: npm run test:household-members
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'household-members-test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

const dbmod = await import('../server/db.js');
const { router: authRouter, sessionMiddleware, requireAuth } = await import('../server/auth.js');
const { default: familyRouter } = await import('../server/routes/family.js');
const { default: scheduleRouter } = await import('../server/routes/schedule.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
const { default: rewardsRouter } = await import('../server/routes/rewards.js');
const { default: splitRouter } = await import('../server/routes/split-expenses.js');
const { default: permissionsRouter } = await import('../server/routes/permissions.js');
const { householdOverview } = await import('../server/services/two-factor.js');
const { listEmailableMembers } = await import('../server/services/member-email.js');
const { householdMemberSql, isHouseholdMember } = await import('../server/services/household-members.js');
const { pushService } = await import('../server/services/push.js');
const { hashPassword } = await import('../server/utils/password.js');

const db = dbmod.get();

// --------------------------------------------------------------------------
// Fixtures: vier Personen, je eine Art. Einwortnamen, damit `@Name` als
// Erwaehnung trifft.
// --------------------------------------------------------------------------

const PASSWORD = 'household-members-pw';
const hash = await hashPassword(PASSWORD);

function addUser(username, displayName, role, familyRole) {
  return Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role, family_role)
    VALUES (?, ?, ?, ?, ?)
  `).run(username, displayName, hash, role, familyRole).lastInsertRowid);
}

// In UMGEKEHRTER Namensfolge angelegt: die ids laufen gegen das Alphabet. Eine
// Liste ohne ORDER BY (Einfuegefolge) oder mit der falschen Richtung liefert
// so nie zufaellig die erwartete Reihenfolge.
const DORA = addUser('dora', 'Dora', 'member', 'other'); // Geteilte-Ausgaben-Gast
const CLARA = addUser('clara', 'Clara', 'member', 'other'); // Hauspersonal
const BEN = addUser('ben', 'Ben', 'member', 'child'); // Mitglied, Kind
const ANNA = addUser('anna', 'Anna', 'admin', 'parent'); // Mitglied, Admin

db.prepare('INSERT INTO housekeeping_workers (user_id) VALUES (?)').run(CLARA);

const GROUP = Number(db.prepare(`
  INSERT INTO expense_groups (name, default_currency, created_by) VALUES ('Urlaub', 'EUR', ?)
`).run(ANNA).lastInsertRowid);
db.prepare("INSERT INTO expense_group_members (group_id, user_id, role) VALUES (?, ?, 'owner')").run(GROUP, ANNA);
db.prepare("INSERT INTO expense_group_members (group_id, user_id, role) VALUES (?, ?, 'guest')").run(GROUP, DORA);
db.prepare('INSERT INTO split_expense_guest_users (user_id, group_id, created_by) VALUES (?, ?, ?)').run(DORA, GROUP, ANNA);

// Jede Person hat eine eindeutige Adresse und nimmt an den Belohnungen teil -
// sonst schloesse eine Liste jemanden aus einem anderen Grund aus als dem, um
// den es hier geht, und der Test waere gruen, ohne das Praedikat zu messen.
for (const [id, name] of [[ANNA, 'anna'], [BEN, 'ben'], [CLARA, 'clara'], [DORA, 'dora']]) {
  db.prepare("INSERT INTO contacts (name, category, email, family_user_id) VALUES (?, 'Familie', ?, ?)")
    .run(name, `${name}@example.org`, id);
  db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(id);
}

// Jede Erwartung in Namensfolge: jede dieser Listen sortiert nach display_name
// (die Belohnungslisten zuerst nach Saldo, der hier fuer alle 0 ist).
const EVERYONE = [ANNA, BEN, CLARA, DORA];
const MEMBERS_ONLY = [ANNA, BEN]; // ohne Personal, ohne Gaeste
const WITHOUT_STAFF = [ANNA, BEN, DORA]; // Gaeste bleiben drin
const WITHOUT_GUESTS = [ANNA, BEN, CLARA]; // Personal bleibt drin
const byId = (ids) => [...ids].sort((a, b) => a - b);

const ROLE = { [ANNA]: 'admin', [BEN]: 'member', [CLARA]: 'member', [DORA]: 'member' };

// Vorbedingung: in dieser DB gibt es genau diese vier Zeilen. Jede Liste wird
// gegen die GANZE Antwort verglichen, nicht gegen einen Ausschnitt.
assert.deepEqual(db.prepare('SELECT id FROM users ORDER BY id').all().map((r) => r.id), byId(EVERYONE));
assert.deepEqual(byId(EVERYONE), [...EVERYONE].reverse(), 'Vorbedingung: ids laufen gegen die Namensfolge');

// --------------------------------------------------------------------------
// App: echte Sitzung, echter requireAuth - so sehen die Router dieselben
// Felder (authUserId, authRole, sessionModuleAccess) wie in server/index.js.
// --------------------------------------------------------------------------

let actor = ANNA;
const app = express();
app.use(express.json());
app.use(sessionMiddleware);
app.use((req, _res, next) => {
  if (actor) {
    req.session.userId = actor;
    req.session.role = ROLE[actor];
  }
  next();
});
app.use('/auth', authRouter);
app.use('/family', requireAuth, familyRouter);
app.use('/schedule', requireAuth, scheduleRouter);
app.use('/tasks', requireAuth, tasksRouter);
app.use('/dashboard', requireAuth, dashboardRouter);
app.use('/rewards', requireAuth, rewardsRouter);
app.use('/split-expenses', requireAuth, splitRouter);
app.use('/permissions', requireAuth, permissionsRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

async function call(method, path, { as = ANNA, body, headers = {} } = {}) {
  actor = as;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, res };
}

// In der Reihenfolge der Antwort - die Reihenfolge gehoert zum Verhalten der Liste.
const idsOf = (rows, key = 'id') => rows.map((row) => row[key]);

// --------------------------------------------------------------------------
// Fassung 1: ohne Personal, ohne Gaeste (das strenge Praedikat)
// --------------------------------------------------------------------------

test('strict: the shopping list recipient picker offers members only', () => {
  assert.deepEqual(idsOf(listEmailableMembers({ db })), MEMBERS_ONLY);
});

test('strict: isHouseholdMember() says yes to members only', () => {
  assert.deepEqual(EVERYONE.filter((id) => isHouseholdMember(id, { db })), MEMBERS_ONLY);
});

test('the predicate refuses a form that excludes no one, and an alias that is not a name', () => {
  // Eine Liste, die Personal UND Gaeste zeigt, sieht jede Zeile - die gehoert
  // mit Grund in die Allowlist des Guards, nicht hinter einen Praedikatsaufruf,
  // der nichts ausschliesst und trotzdem wie ein Filter aussieht.
  assert.throws(() => householdMemberSql('u', { includeStaff: true, includeGuests: true }), TypeError);
  assert.throws(() => householdMemberSql('u.id OR 1'), TypeError);
});

test('strict: GET /schedule/household-members lists members only', async () => {
  const r = await call('GET', '/schedule/household-members');
  assert.equal(r.status, 200);
  assert.deepEqual(idsOf(r.body.data), MEMBERS_ONLY);
});

// --------------------------------------------------------------------------
// Fassung 2: ohne Personal, Gaeste bleiben drin
// --------------------------------------------------------------------------

test('without staff: GET /family/members keeps guests', async () => {
  const r = await call('GET', '/family/members');
  assert.equal(r.status, 200);
  assert.deepEqual(idsOf(r.body.data), WITHOUT_STAFF);
});

test('without staff: the household 2FA overview keeps guests', async () => {
  assert.deepEqual(idsOf(householdOverview(db), 'user_id'), WITHOUT_STAFF);
  const r = await call('GET', '/auth/2fa/overview');
  assert.equal(r.status, 200);
  assert.deepEqual(idsOf(r.body.data, 'user_id'), WITHOUT_STAFF);
});

test('without staff: GET /tasks/meta/options keeps guests', async () => {
  const r = await call('GET', '/tasks/meta/options');
  assert.equal(r.status, 200);
  assert.deepEqual(idsOf(r.body.users), WITHOUT_STAFF);
});

test('without staff: a task comment mention notifies guests but never staff', async () => {
  const task = await call('POST', '/tasks', { body: { title: 'Wer hilft?', visibility: 'all' } });
  assert.equal(task.status, 201);

  const pushed = [];
  const original = pushService.sendPushToUser;
  pushService.sendPushToUser = async (userId) => { pushed.push(userId); };
  try {
    const r = await call('POST', `/tasks/${task.body.data.id}/comments`, {
      body: { comment: '@Ben @Clara @Dora wer uebernimmt das?' },
    });
    assert.equal(r.status, 201);
    // notifyMentions laeuft synchron nach res.json() im selben Handler; die
    // Antwort ist erst da, wenn die Aufrufe schon gezaehlt sind.
  } finally {
    pushService.sendPushToUser = original;
  }
  // Die Reihenfolge der Meldungen ist keine Liste, die jemand sieht.
  assert.deepEqual(byId(pushed), byId([BEN, DORA]));
});

test('without staff: the dashboard user list and reward standings keep guests', async () => {
  const r = await call('GET', '/dashboard');
  assert.equal(r.status, 200);
  assert.deepEqual(idsOf(r.body.users), WITHOUT_STAFF);
  assert.deepEqual(idsOf(r.body.rewards.standings), WITHOUT_STAFF);
});

test('without staff: reward balances and the participant list keep guests', async () => {
  const overview = await call('GET', '/rewards/overview');
  assert.equal(overview.status, 200);
  assert.deepEqual(idsOf(overview.body.data.balances), WITHOUT_STAFF);
  const participants = await call('GET', '/rewards/participants');
  assert.equal(participants.status, 200);
  assert.deepEqual(idsOf(participants.body.data), WITHOUT_STAFF);
});

test('without staff: split expense member candidates keep guests', async () => {
  const r = await call('GET', `/split-expenses/groups/${GROUP}/member-candidates`);
  assert.equal(r.status, 200);
  const users = r.body.data.filter((row) => row.source === 'user');
  assert.deepEqual(idsOf(users, 'user_id'), WITHOUT_STAFF);
});

// --------------------------------------------------------------------------
// Fassung 3: ohne Gaeste, Personal bleibt drin
// --------------------------------------------------------------------------

test('without guests: householdSize at /auth/me counts staff', async () => {
  const r = await call('GET', '/auth/me');
  assert.equal(r.status, 200);
  assert.equal(r.body.householdSize, WITHOUT_GUESTS.length);
});

test('without guests: API token subjects include staff', async () => {
  const r = await call('GET', '/auth/api-tokens');
  assert.equal(r.status, 200);
  assert.deepEqual(idsOf(r.body.subjects), WITHOUT_GUESTS);
});

// --------------------------------------------------------------------------
// Alle Zeilen: Benutzerverwaltung und Rechte-Matrix - mit access_scope
// --------------------------------------------------------------------------

const SCOPES = { [ANNA]: 'family', [BEN]: 'family', [CLARA]: 'family', [DORA]: 'split_guest' };
const scopesOf = (rows) => Object.fromEntries(rows.map((row) => [row.id, row.access_scope]));

test('every row: GET /auth/users lists everyone and marks staff and guests', async () => {
  const r = await call('GET', '/auth/users');
  assert.equal(r.status, 200);
  assert.deepEqual(idsOf(r.body.data), EVERYONE);
  assert.deepEqual(scopesOf(r.body.data), SCOPES);
  const asMember = await call('GET', '/auth/users', { as: BEN });
  assert.equal(asMember.status, 200);
  assert.deepEqual(idsOf(asMember.body.data), EVERYONE);
  assert.deepEqual(scopesOf(asMember.body.data), SCOPES);
});

test('every row: GET /permissions/catalog lists everyone with access_scope', async () => {
  const r = await call('GET', '/permissions/catalog');
  assert.equal(r.status, 200);
  assert.deepEqual(idsOf(r.body.data.members), EVERYONE);
  assert.deepEqual(scopesOf(r.body.data.members), SCOPES);
});

test('access_scope: /auth/me and the login answer name a guest a split_guest', async () => {
  for (const id of [BEN, DORA]) {
    const me = await call('GET', '/auth/me', { as: id });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.access_scope, SCOPES[id]);
  }

  actor = null;
  const anonymous = await fetch(`${base}/auth/me`);
  const cookies = anonymous.headers.getSetCookie().map((raw) => raw.split(';')[0]).join('; ');
  for (const [id, username] of [[BEN, 'ben'], [DORA, 'dora']]) {
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookies },
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    assert.equal(res.status, 200, `login as ${username}`);
    const body = await res.json();
    assert.equal(body.user.id, id);
    assert.equal(body.user.access_scope, SCOPES[id]);
  }
});
