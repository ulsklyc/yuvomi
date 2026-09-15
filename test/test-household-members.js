/**
 * Modul: Haushaltsmitglied - wer in welcher Personenliste steht (#1207)
 * Zweck: Haelt fuer jede Personenliste aus `users` fest, wen sie zeigt, und fuer
 *        jede Route, die Personen annimmt, wen sie annimmt.
 *
 *        Eine `users`-Zeile ist nicht automatisch ein Haushaltsmitglied
 *        (docs/DECISIONS.md, Eintrag 4): Hauspersonal (`housekeeping_workers`)
 *        und Geteilte-Ausgaben-Gaeste (`split_expense_guest_users`) stehen
 *        daneben. Entscheidung vom 15.09.2026 (#1207): beide sind konsequent
 *        aus JEDER Mitgliederliste heraus, und alles oder nichts (#1007) -
 *        was eine Auswahl nicht anbietet, nimmt die Route auch nicht NEU an.
 *        Ein bereits gespeicherter Verweis bleibt dagegen speicherbar: ein
 *        alter Datensatz mit Personal oder Gast darf beim Bearbeiten nicht
 *        scheitern, und keine Zuordnung wird still entfernt.
 *
 *        Was bewusst JEDE Zeile sieht, bleibt so und steht auch hier: die
 *        Benutzerverwaltung (/auth/users), die Rechte-Matrix, die Subjekte
 *        eines API-Tokens (ein Admin stellt ein Token fuer ein KONTO aus) und
 *        access_scope an jeder Stelle, die ihn liefert.
 *
 *        Die Fixtures sind echte Zeilen: ein Admin-Elternteil, ein Kind, eine
 *        Haushaltskraft und zwei Gaeste verschiedener Ausgabengruppen. Gemessen
 *        wird am echten Router ueber HTTP (bzw. an der exportierten Funktion,
 *        wo es keine eigene Route gibt), nie an einer nachgebauten Query.
 *        Jede Ablehnung hat eine Positivkontrolle daneben, damit ein 400 nicht
 *        aus einem anderen Grund kommt als dem, um den es geht.
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
const { default: scheduleExtrasRouter } = await import('../server/routes/schedule-extras.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');
const { default: budgetRouter } = await import('../server/routes/budget.js');
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
// Fixtures: fuenf Personen. Einwortnamen, damit `@Name` als Erwaehnung trifft.
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
const EMIL = addUser('emil', 'Emil', 'member', 'other'); // Gast der zweiten Gruppe
const DORA = addUser('dora', 'Dora', 'member', 'other'); // Gast dieser Gruppe
const CLARA = addUser('clara', 'Clara', 'member', 'other'); // Hauspersonal
const BEN = addUser('ben', 'Ben', 'member', 'child'); // Mitglied, Kind
const ANNA = addUser('anna', 'Anna', 'admin', 'parent'); // Mitglied, Admin

db.prepare('INSERT INTO housekeeping_workers (user_id) VALUES (?)').run(CLARA);

function addGroup(name, guest) {
  const groupId = Number(db.prepare(`
    INSERT INTO expense_groups (name, default_currency, created_by) VALUES (?, 'EUR', ?)
  `).run(name, ANNA).lastInsertRowid);
  db.prepare("INSERT INTO expense_group_members (group_id, user_id, role) VALUES (?, ?, 'owner')").run(groupId, ANNA);
  db.prepare("INSERT INTO expense_group_members (group_id, user_id, role) VALUES (?, ?, 'guest')").run(groupId, guest);
  db.prepare('INSERT INTO split_expense_guest_users (user_id, group_id, created_by) VALUES (?, ?, ?)').run(guest, groupId, ANNA);
  return groupId;
}
const GROUP = addGroup('Urlaub', DORA);
const OTHER = addGroup('WG', EMIL);

// Jede Person hat eine eindeutige Adresse - sonst schloesse eine Liste jemanden
// aus einem anderen Grund aus als dem, um den es hier geht. Eingeschrieben bei
// den Belohnungen sind alle ausser Emil: Doras und Claras Einschreibung stammen
// aus der Zeit, als die Teilnehmerliste sie noch anbot, und bleiben stehen.
for (const [id, name] of [[ANNA, 'anna'], [BEN, 'ben'], [CLARA, 'clara'], [DORA, 'dora'], [EMIL, 'emil']]) {
  db.prepare("INSERT INTO contacts (name, category, email, family_user_id) VALUES (?, 'Familie', ?, ?)")
    .run(name, `${name}@example.org`, id);
}
for (const id of [ANNA, BEN, CLARA, DORA]) {
  db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(id);
}

// Claras Dienstplan besteht schon - sie ist eine bestehende Besitzerin.
const SHIFT = Number(db.prepare(`
  INSERT INTO schedule_shift_types (name, short_code, start_time, end_time, color) VALUES ('Frueh', 'F', '06:00', '14:00', '#123456')
`).run().lastInsertRowid);
db.prepare("INSERT INTO schedule_patterns (user_id, name, anchor_date, cycle_length) VALUES (?, 'Haus', '2030-01-01', 7)").run(CLARA);

// Jede Erwartung in Namensfolge: jede dieser Listen sortiert nach display_name
// (die Belohnungslisten zuerst nach Saldo, der hier fuer alle 0 ist).
const EVERYONE = [ANNA, BEN, CLARA, DORA, EMIL];
const MEMBERS = [ANNA, BEN];
const ACCOUNTS_WITHOUT_GUESTS = [ANNA, BEN, CLARA];
const byId = (ids) => [...ids].sort((a, b) => a - b);

const ROLE = { [ANNA]: 'admin', [BEN]: 'member', [CLARA]: 'member', [DORA]: 'member', [EMIL]: 'member' };

// Vorbedingung: in dieser DB gibt es genau diese fuenf Zeilen. Jede Liste wird
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
app.use('/schedule/extras', requireAuth, scheduleExtrasRouter);
app.use('/schedule', requireAuth, scheduleRouter);
app.use('/tasks', requireAuth, tasksRouter);
app.use('/calendar', requireAuth, calendarRouter);
app.use('/budget', requireAuth, budgetRouter);
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

/** Eine Ablehnung, die wirklich die Mitgliedschaft meint - nicht irgendein 400. */
function assertRejectsNonMember(r, what) {
  assert.equal(r.status, 400, `${what}: expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.match(String(r.body?.error), /household member/i, `${what}: the rejection names the reason`);
}

// --------------------------------------------------------------------------
// Das Praedikat
// --------------------------------------------------------------------------

test('isHouseholdMember() says yes to members only', () => {
  assert.deepEqual(EVERYONE.filter((id) => isHouseholdMember(id, { db })), MEMBERS);
});

test('the predicate has one form: no options, and an alias that is a name', () => {
  // Frueher gab es includeGuests/includeStaff fuer Listen, die Gaeste oder
  // Personal behielten. Seit alle Listen streng sind, waere eine Option nur
  // noch ein Weg zurueck in die uneinheitliche Sichtbarkeit - sie wirft.
  assert.throws(() => householdMemberSql('u', { includeGuests: true }), TypeError);
  assert.throws(() => householdMemberSql('u', {}), TypeError);
  assert.throws(() => householdMemberSql('u.id OR 1'), TypeError);
});

// --------------------------------------------------------------------------
// Jede Mitgliederliste: ohne Personal, ohne Gaeste
// --------------------------------------------------------------------------

test('members only: the shopping list recipient picker', () => {
  assert.deepEqual(idsOf(listEmailableMembers({ db })), MEMBERS);
});

test('members only: GET /schedule/household-members', async () => {
  const r = await call('GET', '/schedule/household-members');
  assert.equal(r.status, 200);
  assert.deepEqual(idsOf(r.body.data), MEMBERS);
});

test('members only: GET /family/members (the source of the pickers)', async () => {
  const r = await call('GET', '/family/members');
  assert.equal(r.status, 200);
  assert.deepEqual(idsOf(r.body.data), MEMBERS);
});

test('members only: the household 2FA overview', async () => {
  assert.deepEqual(idsOf(householdOverview(db), 'user_id'), MEMBERS);
  const r = await call('GET', '/auth/2fa/overview');
  assert.equal(r.status, 200);
  assert.deepEqual(idsOf(r.body.data, 'user_id'), MEMBERS);
});

test('members only: GET /tasks/meta/options', async () => {
  const r = await call('GET', '/tasks/meta/options');
  assert.equal(r.status, 200);
  assert.deepEqual(idsOf(r.body.users), MEMBERS);
});

test('members only: a task comment mention notifies neither staff nor guests', async () => {
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
  assert.deepEqual(byId(pushed), [BEN]);
});

test('members only: the dashboard user list, reward standings and participant count', async () => {
  const r = await call('GET', '/dashboard');
  assert.equal(r.status, 200);
  assert.deepEqual(idsOf(r.body.users), MEMBERS);
  assert.deepEqual(idsOf(r.body.rewards.standings), MEMBERS);
  assert.equal(r.body.rewards.participantCount, MEMBERS.length, 'an old guest or staff enrolment is not counted');
});

test('members only: reward balances, participant count and the participant list', async () => {
  const overview = await call('GET', '/rewards/overview');
  assert.equal(overview.status, 200);
  assert.deepEqual(idsOf(overview.body.data.balances), MEMBERS);
  assert.equal(overview.body.data.setup.participantCount, MEMBERS.length);
  const participants = await call('GET', '/rewards/participants');
  assert.equal(participants.status, 200);
  assert.deepEqual(idsOf(participants.body.data), MEMBERS);
});

test('members only: householdSize at /auth/me counts neither staff nor guests', async () => {
  const r = await call('GET', '/auth/me');
  assert.equal(r.status, 200);
  assert.equal(r.body.householdSize, MEMBERS.length);
});

// --------------------------------------------------------------------------
// Split expenses: Mitglieder plus die Gaeste DIESER Gruppe
// --------------------------------------------------------------------------

test('split member candidates: members plus the guests of this group, not of another', async () => {
  const here = await call('GET', `/split-expenses/groups/${GROUP}/member-candidates`);
  assert.equal(here.status, 200);
  assert.deepEqual(idsOf(here.body.data.filter((row) => row.source === 'user'), 'user_id'), [ANNA, BEN, DORA]);
  const other = await call('GET', `/split-expenses/groups/${OTHER}/member-candidates`);
  assert.equal(other.status, 200);
  assert.deepEqual(idsOf(other.body.data.filter((row) => row.source === 'user'), 'user_id'), [ANNA, BEN, EMIL]);
});

// --------------------------------------------------------------------------
// Konten, nicht Mitglieder: Verwaltung, Rechte-Matrix, Token-Subjekte
// --------------------------------------------------------------------------

test('accounts: API token subjects are every account except guests, as before', async () => {
  const r = await call('GET', '/auth/api-tokens');
  assert.equal(r.status, 200);
  assert.deepEqual(idsOf(r.body.subjects), ACCOUNTS_WITHOUT_GUESTS);
});

const SCOPES = { [ANNA]: 'family', [BEN]: 'family', [CLARA]: 'family', [DORA]: 'split_guest', [EMIL]: 'split_guest' };
const scopesOf = (rows) => Object.fromEntries(rows.map((row) => [row.id, row.access_scope]));

test('accounts: GET /auth/users lists everyone and marks staff and guests', async () => {
  const r = await call('GET', '/auth/users');
  assert.equal(r.status, 200);
  assert.deepEqual(idsOf(r.body.data), EVERYONE);
  assert.deepEqual(scopesOf(r.body.data), SCOPES);
  const asMember = await call('GET', '/auth/users', { as: BEN });
  assert.equal(asMember.status, 200);
  assert.deepEqual(idsOf(asMember.body.data), EVERYONE);
  assert.deepEqual(scopesOf(asMember.body.data), SCOPES);
});

test('accounts: GET /permissions/catalog lists everyone with access_scope', async () => {
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

// --------------------------------------------------------------------------
// Schreibseite: neu nur Mitglieder, Gespeichertes bleibt speicherbar
// --------------------------------------------------------------------------

const assignedIds = (table, key, id) => byId(db.prepare(`SELECT user_id FROM ${table} WHERE ${key} = ?`).all(id).map((r) => r.user_id));

test('tasks: a new assignee must be a household member', async () => {
  const ok = await call('POST', '/tasks', { body: { title: 'Mitglied', assigned_to: [BEN] } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assertRejectsNonMember(await call('POST', '/tasks', { body: { title: 'Personal', assigned_to: [CLARA] } }), 'staff assignee');
  assertRejectsNonMember(await call('POST', '/tasks', { body: { title: 'Gast', assigned_to: [BEN, DORA] } }), 'guest assignee');
});

test('tasks: a stored staff assignee stays saveable, a newly added guest does not', async () => {
  const taskId = Number(db.prepare("INSERT INTO tasks (title, visibility, created_by) VALUES ('Fenster', 'all', ?)").run(ANNA).lastInsertRowid);
  db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(taskId, CLARA);

  const kept = await call('PUT', `/tasks/${taskId}`, { body: { assigned_to: [BEN, CLARA] } });
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.deepEqual(assignedIds('task_assignments', 'task_id', taskId), byId([BEN, CLARA]));

  assertRejectsNonMember(await call('PUT', `/tasks/${taskId}`, { body: { assigned_to: [BEN, CLARA, DORA] } }), 'added guest');
  assert.deepEqual(assignedIds('task_assignments', 'task_id', taskId), byId([BEN, CLARA]), 'a rejected PUT writes nothing');
});

test('calendar: a new attendee must be a household member', async () => {
  const ok = await call('POST', '/calendar', { body: { title: 'Arzt', start_datetime: '2030-03-01T10:00:00', assigned_to: [BEN] } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assertRejectsNonMember(await call('POST', '/calendar', { body: { title: 'Gast', start_datetime: '2030-03-01T11:00:00', assigned_to: [EMIL] } }), 'guest attendee');
});

test('calendar: a stored staff attendee stays saveable, a newly added guest does not', async () => {
  const eventId = Number(db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, visibility, created_by) VALUES ('Besuch', '2030-03-02T10:00:00', 'all', ?)
  `).run(ANNA).lastInsertRowid);
  db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(eventId, CLARA);

  const kept = await call('PUT', `/calendar/${eventId}`, { body: { assigned_to: [BEN, CLARA] } });
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.deepEqual(assignedIds('event_assignments', 'event_id', eventId), byId([BEN, CLARA]));

  assertRejectsNonMember(await call('PUT', `/calendar/${eventId}`, { body: { assigned_to: [BEN, CLARA, DORA] } }), 'added guest');
  assert.deepEqual(assignedIds('event_assignments', 'event_id', eventId), byId([BEN, CLARA]), 'a rejected PUT writes nothing');
});

test('calendar: a single occurrence keeps the series attendees and takes no new non-member', async () => {
  const seriesId = Number(db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, end_datetime, visibility, recurrence_rule, created_by)
    VALUES ('Putzen', '2030-04-01T09:00:00', '2030-04-01T10:00:00', 'all', 'FREQ=DAILY', ?)
  `).run(ANNA).lastInsertRowid);
  db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(seriesId, CLARA);

  const kept = await call('PUT', `/calendar/${seriesId}/occurrences/2030-04-03`, { body: { assigned_to: [BEN, CLARA] } });
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assertRejectsNonMember(
    await call('PUT', `/calendar/${seriesId}/occurrences/2030-04-04`, { body: { assigned_to: [CLARA, DORA] } }),
    'guest added to one occurrence',
  );
});

test('budget: a new responsible person must be a household member', async () => {
  const ok = await call('POST', '/budget', { body: { title: 'Strom', amount: -10, date: '2030-01-05', responsible_user_ids: [BEN] } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assertRejectsNonMember(
    await call('POST', '/budget', { body: { title: 'Putzhilfe', amount: -40, date: '2030-01-06', responsible_user_ids: [CLARA] } }),
    'staff responsible',
  );
});

test('budget: a stored staff responsible stays saveable, a newly added guest does not', async () => {
  const created = await call('POST', '/budget', { body: { title: 'Wasser', amount: -20, date: '2030-01-07', responsible_user_ids: [BEN] } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const entryId = created.body.data.id;
  db.prepare('INSERT INTO budget_entry_responsibles (entry_id, user_id) VALUES (?, ?)').run(entryId, CLARA);

  const kept = await call('PUT', `/budget/${entryId}`, { body: { responsible_user_ids: [BEN, CLARA] } });
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.deepEqual(assignedIds('budget_entry_responsibles', 'entry_id', entryId), byId([BEN, CLARA]));

  assertRejectsNonMember(await call('PUT', `/budget/${entryId}`, { body: { responsible_user_ids: [BEN, CLARA, DORA] } }), 'added guest');
  assert.deepEqual(assignedIds('budget_entry_responsibles', 'entry_id', entryId), byId([BEN, CLARA]), 'a rejected PUT writes nothing');
});

test('budget: a series takes no newly added non-member responsible', async () => {
  const created = await call('POST', '/budget', { body: { title: 'Miete', amount: -500, date: '2030-01-01', is_recurring: 1 } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const entryId = created.body.data.id;

  const ok = await call('PUT', `/budget/${entryId}/series`, { body: { responsible_user_ids: [BEN] } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assertRejectsNonMember(await call('PUT', `/budget/${entryId}/series`, { body: { responsible_user_ids: [BEN, EMIL] } }), 'guest on a series');
  assert.deepEqual(assignedIds('budget_entry_responsibles', 'entry_id', entryId), [BEN], 'a rejected PUT writes nothing');
});

test('schedule: a new schedule owner must be a household member', async () => {
  const pattern = { name: 'Woche', anchor_date: '2030-01-01', cycle_length: 7 };
  const ok = await call('POST', '/schedule/patterns', { body: { ...pattern, user_id: BEN } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assertRejectsNonMember(await call('POST', '/schedule/patterns', { body: { ...pattern, user_id: DORA } }), 'guest pattern');
  assertRejectsNonMember(await call('PUT', '/schedule/overrides/2030-01-02', { body: { user_id: DORA, shift_type_id: null } }), 'guest override');
  assertRejectsNonMember(await call('POST', '/schedule/overrides/fill', { body: { user_id: EMIL, from: '2030-01-02', to: '2030-01-03' } }), 'guest override fill');

  const extra = await call('POST', '/schedule/extras', { body: { user_id: BEN, date_key: '2030-01-04', shift_type_id: SHIFT } });
  assert.equal(extra.status, 201, JSON.stringify(extra.body));
  assertRejectsNonMember(await call('POST', '/schedule/extras', { body: { user_id: DORA, date_key: '2030-01-04', shift_type_id: SHIFT } }), 'guest extra shift');
  assertRejectsNonMember(await call('POST', '/schedule/extras/fill', { body: { user_id: DORA, from: '2030-01-05', to: '2030-01-06', shift_type_id: SHIFT } }), 'guest extra fill');
});

test('schedule: staff who already own a schedule keep it editable', async () => {
  const override = await call('PUT', '/schedule/overrides/2030-01-08', { body: { user_id: CLARA, shift_type_id: null } });
  assert.equal(override.status, 200, JSON.stringify(override.body));
  const extra = await call('POST', '/schedule/extras', { body: { user_id: CLARA, date_key: '2030-01-09', shift_type_id: SHIFT } });
  assert.equal(extra.status, 201, JSON.stringify(extra.body));
});

test('rewards: only a household member can be enrolled, an old enrolment can still be switched', async () => {
  const ok = await call('PUT', `/rewards/participants/${BEN}`, { body: { enabled: true } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assertRejectsNonMember(await call('PUT', `/rewards/participants/${EMIL}`, { body: { enabled: true } }), 'guest enrolment');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reward_participants WHERE user_id = ?').get(EMIL).n, 0, 'a rejected PUT writes nothing');

  // Doras Einschreibung stammt von frueher: sie bleibt stehen, laesst sich
  // bestaetigen und abschalten - nur neu anlegen laesst sie sich nicht mehr.
  const still = await call('PUT', `/rewards/participants/${DORA}`, { body: { enabled: true } });
  assert.equal(still.status, 200, JSON.stringify(still.body));
  const off = await call('PUT', `/rewards/participants/${DORA}`, { body: { enabled: false } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(db.prepare('SELECT enabled FROM reward_participants WHERE user_id = ?').get(DORA).enabled, 0, 'switched off, not deleted');
  assertRejectsNonMember(await call('PUT', `/rewards/participants/${DORA}`, { body: { enabled: true } }), 'switching an old guest enrolment back on');
});

// --------------------------------------------------------------------------
// Die Auswahl im Browser: Mitglieder, dazu wer am Datensatz schon steht
// --------------------------------------------------------------------------

test('picker: members, then whoever is already chosen on the record, once', async () => {
  // Ohne diesen Schritt bekaeme eine gespeicherte Haushaltskraft kein Haekchen,
  // und das naechste Speichern naehme sie still heraus - obwohl der Server den
  // gespeicherten Verweis ausdruecklich weiter annimmt.
  const { withChosenPeople } = await import('../public/utils/people-picker.js');
  const members = [{ id: ANNA, display_name: 'Anna', avatar_color: '#111111' }, { id: BEN, display_name: 'Ben', avatar_color: '#222222' }];
  const chosen = [
    { id: BEN, display_name: 'Ben', color: '#222222' },
    { id: CLARA, display_name: 'Clara', color: '#333333' },
    { id: CLARA, display_name: 'Clara', color: '#333333' },
  ];
  const list = withChosenPeople(members, chosen);
  assert.deepEqual(list.map((person) => person.id), [ANNA, BEN, CLARA]);
  assert.equal(list[2].avatar_color, '#333333', 'the record calls the colour `color`, the picker reads `avatar_color`');
  assert.deepEqual(withChosenPeople(members, null).map((person) => person.id), [ANNA, BEN], 'a new record offers members only');
});
