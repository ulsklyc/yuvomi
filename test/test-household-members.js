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
const { default: documentsRouter } = await import('../server/routes/documents.js');
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
app.use('/documents', requireAuth, documentsRouter);
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

test('accounts: the 2FA overview lists every account', async () => {
  // Der zweite Faktor schuetzt Konten, nicht Mitgliedschaft (Entscheidung
  // vom 15.09.2026, #1207): die Admin-Uebersicht listet deshalb jedes Konto.
  assert.deepEqual(idsOf(householdOverview(db), 'user_id'), EVERYONE);
  const r = await call('GET', '/auth/2fa/overview');
  assert.equal(r.status, 200);
  assert.deepEqual(idsOf(r.body.data, 'user_id'), EVERYONE);
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

// --------------------------------------------------------------------------
// Weitere Personenwahl: Sync-Ziele, Outlook, Ausgabengruppen (Entscheidung
// vom 15.09.2026 - dasselbe Muster: neu nur Mitglieder, Gespeichertes bleibt)
// --------------------------------------------------------------------------

test('synced calendars: a new ICS subscription default assignee must be a household member', async () => {
  const body = { name: 'Schule', url: 'https://127.0.0.1/stundenplan.ics', color: '#123456' };
  // Kein Netz: 127.0.0.1 weist die SSRF-Pruefung vor jedem Abruf ab. Ein
  // Mitglied kommt an der Personenpruefung vorbei und scheitert erst dort - die
  // Positivkontrolle dafuer, dass die Ablehnung darunter die Mitgliedschaft meint.
  const member = await call('POST', '/calendar/subscriptions', { body: { ...body, default_assignee_user_id: BEN } });
  assert.equal(member.status, 400, JSON.stringify(member.body));
  assert.match(String(member.body?.error), /private IP/i);
  assertRejectsNonMember(
    await call('POST', '/calendar/subscriptions', { body: { ...body, default_assignee_user_id: CLARA } }),
    'staff as default assignee of a new subscription',
  );
});

test('synced calendars: a stored ICS subscription assignee stays saveable, a new guest does not', async () => {
  const subId = Number(db.prepare(`
    INSERT INTO ics_subscriptions (name, url, color, created_by, default_assignee_user_id)
    VALUES ('Verein', 'https://example.org/verein.ics', '#654321', ?, ?)
  `).run(ANNA, CLARA).lastInsertRowid);
  const assignee = () => db.prepare('SELECT default_assignee_user_id AS a FROM ics_subscriptions WHERE id = ?').get(subId).a;

  const kept = await call('PATCH', `/calendar/subscriptions/${subId}`, { body: { name: 'Verein neu', default_assignee_user_id: CLARA } });
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assertRejectsNonMember(await call('PATCH', `/calendar/subscriptions/${subId}`, { body: { default_assignee_user_id: DORA } }), 'guest as default assignee');
  assert.equal(assignee(), CLARA, 'a rejected PATCH writes nothing');
  const member = await call('PATCH', `/calendar/subscriptions/${subId}`, { body: { default_assignee_user_id: BEN } });
  assert.equal(member.status, 200, JSON.stringify(member.body));
  assert.equal(assignee(), BEN);
});

test('synced calendars: an external calendar default assignee (Google, Apple, CalDAV)', async () => {
  const target = { source: 'google', external_id: 'haus@group.calendar.google.com' };
  db.prepare('INSERT INTO external_calendars (source, external_id, name, default_assignee_user_id) VALUES (?, ?, ?, ?)')
    .run(target.source, target.external_id, 'Haus', CLARA);
  const assignee = () => db.prepare('SELECT default_assignee_user_id AS a FROM external_calendars WHERE external_id = ?').get(target.external_id).a;

  const kept = await call('PATCH', '/calendar/external-calendars', { body: { ...target, default_assignee_user_id: CLARA } });
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assertRejectsNonMember(await call('PATCH', '/calendar/external-calendars', { body: { ...target, default_assignee_user_id: EMIL } }), 'guest as default assignee');
  assert.equal(assignee(), CLARA, 'a rejected PATCH writes nothing');
  const member = await call('PATCH', '/calendar/external-calendars', { body: { ...target, default_assignee_user_id: BEN } });
  assert.equal(member.status, 200, JSON.stringify(member.body));
  assertRejectsNonMember(
    await call('PATCH', '/calendar/external-calendars', { body: { ...target, default_assignee_user_id: CLARA } }),
    'staff chosen again after being replaced',
  );
});

test('synced calendars: a stored Outlook account owner stays saveable, a new non-member does not', async () => {
  const accountId = Number(db.prepare(`
    INSERT INTO outlook_accounts (name, access_token, refresh_token, owner_user_id) VALUES ('Arbeit', 'access', 'refresh', ?)
  `).run(CLARA).lastInsertRowid);
  const owner = () => db.prepare('SELECT owner_user_id AS o FROM outlook_accounts WHERE id = ?').get(accountId).o;

  const kept = await call('PUT', `/calendar/outlook/accounts/${accountId}`, { body: { name: 'Arbeit neu', ownerUserId: CLARA } });
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assertRejectsNonMember(await call('PUT', `/calendar/outlook/accounts/${accountId}`, { body: { ownerUserId: DORA } }), 'guest as owner');
  assert.equal(owner(), CLARA, 'a rejected PUT writes nothing');
  const member = await call('PUT', `/calendar/outlook/accounts/${accountId}`, { body: { ownerUserId: BEN } });
  assert.equal(member.status, 200, JSON.stringify(member.body));
  assert.equal(owner(), BEN);
});

test('split expenses: members and guests can join a group, staff cannot, a stored staff membership stays', async () => {
  const membership = (groupId, userId) => db.prepare('SELECT role FROM expense_group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId);

  const member = await call('POST', `/split-expenses/groups/${GROUP}/members`, { body: { user_id: BEN } });
  assert.equal(member.status, 201, JSON.stringify(member.body));
  const guest = await call('POST', `/split-expenses/groups/${GROUP}/members`, { body: { user_id: EMIL } });
  assert.equal(guest.status, 201, `the guest mechanism stays: a guest of another group can still join ${JSON.stringify(guest.body)}`);
  assertRejectsNonMember(await call('POST', `/split-expenses/groups/${GROUP}/members`, { body: { user_id: CLARA } }), 'staff joining a group');
  assert.equal(membership(GROUP, CLARA), undefined, 'a rejected POST writes nothing');

  db.prepare("INSERT INTO expense_group_members (group_id, user_id, role) VALUES (?, ?, 'guest')").run(OTHER, CLARA);
  const kept = await call('POST', `/split-expenses/groups/${OTHER}/members`, { body: { user_id: CLARA, role: 'admin' } });
  assert.equal(kept.status, 201, JSON.stringify(kept.body));
  assert.equal(membership(OTHER, CLARA).role, 'admin', 'a stored staff membership can still be changed');
});

// --------------------------------------------------------------------------
// Kalender: die beiden Wege, die erst nach einem await schreiben
// --------------------------------------------------------------------------

function addSeries(title, start, attendees) {
  const seriesId = Number(db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, end_datetime, visibility, recurrence_rule, created_by)
    VALUES (?, ?, NULL, 'all', 'FREQ=DAILY', ?)
  `).run(title, start, ANNA).lastInsertRowid);
  for (const userId of attendees) {
    db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(seriesId, userId);
  }
  return seriesId;
}
const eventRows = () => db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n;

test('calendar: the series path of PUT keeps a stored staff attendee and takes no new non-member', async () => {
  const seriesId = addSeries('Wochenplan', '2030-05-01T08:00:00', [CLARA]);
  // Ein abgewandeltes Vorkommen zwingt PUT /:id in den Serienpfad
  // (updateSeriesWithOverrides) statt in das einfache Update.
  const occurrence = await call('PUT', `/calendar/${seriesId}/occurrences/2030-05-03`, { body: { title: 'Anders' } });
  assert.equal(occurrence.status, 200, JSON.stringify(occurrence.body));
  assert.ok(db.prepare('SELECT 1 FROM calendar_events WHERE recurrence_parent_id = ?').get(seriesId), 'Vorbedingung: ein verknuepftes Vorkommen existiert');

  const series = () => ({
    attendees: assignedIds('event_assignments', 'event_id', seriesId),
    rule: db.prepare('SELECT recurrence_rule AS r FROM calendar_events WHERE id = ?').get(seriesId).r,
    rows: eventRows(),
  });
  const before = series();
  assertRejectsNonMember(await call('PUT', `/calendar/${seriesId}`, { body: { assigned_to: [CLARA, DORA] } }), 'guest added to a series with an override');
  assert.deepEqual(series(), before, 'a rejected series PUT writes nothing');

  const kept = await call('PUT', `/calendar/${seriesId}`, { body: { assigned_to: [BEN, CLARA] } });
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.deepEqual(assignedIds('event_assignments', 'event_id', seriesId), byId([BEN, CLARA]));
});

test('calendar: this-and-following keeps a stored staff attendee and takes no new non-member', async () => {
  const seriesId = addSeries('Garten', '2030-06-01T07:00:00', [CLARA]);
  const series = () => ({
    attendees: assignedIds('event_assignments', 'event_id', seriesId),
    rule: db.prepare('SELECT recurrence_rule AS r FROM calendar_events WHERE id = ?').get(seriesId).r,
    rows: eventRows(),
  });
  const before = series();
  assertRejectsNonMember(
    await call('PUT', `/calendar/${seriesId}/occurrences/2030-06-05/following`, { body: { assigned_to: [CLARA, EMIL] } }),
    'guest added to this and the following occurrences',
  );
  assert.deepEqual(series(), before, 'a rejected split writes nothing: same series, no following series');

  const kept = await call('PUT', `/calendar/${seriesId}/occurrences/2030-06-05/following`, { body: { assigned_to: [BEN, CLARA] } });
  assert.equal(kept.status, 201, JSON.stringify(kept.body));
  assert.deepEqual(assignedIds('event_assignments', 'event_id', kept.body.data.id), byId([BEN, CLARA]));
});

test('calendar: an occurrence that owns its attendees is the stored state, not the series', async () => {
  // Die Serie nennt Clara, das Vorkommen hat sie mit einer eigenen
  // Zuweisung entfernt. Fuer dieses Vorkommen ist sie damit NICHT mehr
  // gespeichert - sie wieder hinzuzufuegen ist eine neue Wahl. Genau so
  // bestimmt upsertOccurrenceOverride() den geltenden Stand.
  const seriesId = addSeries('Einkauf', '2030-08-01T09:00:00', [CLARA]);
  const removed = await call('PUT', `/calendar/${seriesId}/occurrences/2030-08-03`, { body: { assigned_to: [BEN] } });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  const child = db.prepare('SELECT id, overridden_fields FROM calendar_events WHERE recurrence_parent_id = ? AND recurrence_id = ?').get(seriesId, '2030-08-03');
  assert.match(String(child?.overridden_fields), /assignments/, 'Vorbedingung: das Vorkommen besitzt seine Zuweisungen');
  assert.deepEqual(assignedIds('event_assignments', 'event_id', child.id), [BEN]);

  assertRejectsNonMember(
    await call('PUT', `/calendar/${seriesId}/occurrences/2030-08-03`, { body: { assigned_to: [BEN, CLARA] } }),
    'staff re-added to an occurrence that had removed them',
  );
  assert.deepEqual(assignedIds('event_assignments', 'event_id', child.id), [BEN], 'a rejected PUT writes nothing');

  // Gegenprobe: ein Vorkommen ohne eigene Zuweisung erbt die der Serie, dort
  // bleibt Clara gespeichert.
  const inherited = await call('PUT', `/calendar/${seriesId}/occurrences/2030-08-04`, { body: { assigned_to: [BEN, CLARA] } });
  assert.equal(inherited.status, 200, JSON.stringify(inherited.body));
});

test('calendar: a rejected attendee leaves no staged attachment behind', async () => {
  // Ordner-gestuetzte Ablage, damit eine liegen gebliebene Datei sichtbar wird -
  // der Standardpfad legt Anhaenge als BLOB in die Datenbank.
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuvomi-members-attach-'));
  const before = { enabled: process.env.DOCUMENT_STORAGE_LOCAL_ENABLED, path: process.env.DOCUMENT_STORAGE_LOCAL_PATH };
  process.env.DOCUMENT_STORAGE_LOCAL_ENABLED = 'true';
  process.env.DOCUMENT_STORAGE_LOCAL_PATH = dir;
  const files = async () => (await fs.readdir(dir, { withFileTypes: true, recursive: true })).filter((e) => e.isFile()).length;
  try {
    const eventId = Number(db.prepare(`
      INSERT INTO calendar_events (title, start_datetime, visibility, created_by) VALUES ('Zeugnis', '2030-07-01T10:00:00', 'all', ?)
    `).run(ANNA).lastInsertRowid);
    const dataUrl = `data:text/plain;base64,${Buffer.from('Anhang').toString('base64')}`;

    // Gegenprobe zuerst: legt dieser Aufbau ueberhaupt eine Datei ab?
    const ok = await call('PUT', `/calendar/${eventId}`, { body: { assigned_to: [BEN], attachment_data: dataUrl, attachment_name: 'gut.txt' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(await files(), 1, 'Vorbedingung: ein gelungener Anhang liegt im Ordner');

    assertRejectsNonMember(
      await call('PUT', `/calendar/${eventId}`, { body: { assigned_to: [BEN, DORA], attachment_data: dataUrl, attachment_name: 'waise.txt' } }),
      'guest added together with an attachment',
    );
    assert.equal(await files(), 1, 'the attachment staged for the rejected request was cleaned up');
  } finally {
    if (before.enabled === undefined) delete process.env.DOCUMENT_STORAGE_LOCAL_ENABLED;
    else process.env.DOCUMENT_STORAGE_LOCAL_ENABLED = before.enabled;
    if (before.path === undefined) delete process.env.DOCUMENT_STORAGE_LOCAL_PATH;
    else process.env.DOCUMENT_STORAGE_LOCAL_PATH = before.path;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// Dokumente: Freigaben
// --------------------------------------------------------------------------

test('documents: a new document can only be shared with household members', async () => {
  const contentData = `data:text/plain;base64,${Buffer.from('Vertrag').toString('base64')}`;
  const body = { name: 'Vertrag', original_name: 'vertrag.txt', content_data: contentData, visibility: 'restricted' };
  assertRejectsNonMember(await call('POST', '/documents', { body: { ...body, allowed_member_ids: [BEN, CLARA] } }), 'staff shared on a new document');
  assertRejectsNonMember(await call('POST', '/documents', { body: { ...body, allowed_member_ids: [BEN, DORA] } }), 'guest shared on a new document');
  const ok = await call('POST', '/documents', { body: { ...body, allowed_member_ids: [BEN] } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.data.allowed_member_ids, [BEN]);
});

test('documents: a stored grant stays saveable, a removed one cannot come back', async () => {
  const docId = Number(db.prepare(`
    INSERT INTO family_documents (name, category, visibility, original_name, mime_type, file_size, content_data, created_by)
    VALUES ('Mietvertrag', 'other', 'restricted', 'miete.txt', 'text/plain', 5, ?, ?)
  `).run(Buffer.from('hallo').toString('base64'), ANNA).lastInsertRowid);
  db.prepare('INSERT INTO family_document_access (document_id, user_id) VALUES (?, ?)').run(docId, CLARA);
  const access = () => db.prepare('SELECT user_id FROM family_document_access WHERE document_id = ? ORDER BY user_id')
    .all(docId).map((row) => row.user_id);
  const save = (ids) => call('PUT', `/documents/${docId}`, { body: { name: 'Mietvertrag', visibility: 'restricted', allowed_member_ids: ids } });

  const kept = await save([CLARA, BEN]);
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.deepEqual(access(), byId([BEN, CLARA]), 'the stored staff grant stays next to the new member');

  assert.equal((await save([BEN])).status, 200);
  assert.deepEqual(access(), [BEN]);

  assertRejectsNonMember(await save([BEN, CLARA]), 'staff shared again after the grant was removed');
  assertRejectsNonMember(await save([BEN, DORA]), 'guest shared anew');
  assert.deepEqual(access(), [BEN], 'a rejected save changes nothing');
});

// --------------------------------------------------------------------------
// Geteilte Ausgaben: wer eine Gruppe anlegt, wird ihr Owner
// --------------------------------------------------------------------------

test('split expenses: creating a group follows the same rule as adding a member', async () => {
  // Ein angemeldetes Konto, das weder Mitglied noch Gast ist, wuerde beim
  // Anlegen als Owner eingetragen - genau die Mitgliedschaft, die
  // POST /groups/:id/members ablehnt.
  const groups = () => db.prepare('SELECT COUNT(*) AS n FROM expense_groups').get().n;
  const before = groups();
  assertRejectsNonMember(await call('POST', '/split-expenses/groups', { as: CLARA, body: { name: 'Putzkasse' } }), 'staff creating a group');
  assert.equal(groups(), before, 'a refused request creates no group');

  const ok = await call('POST', '/split-expenses/groups', { as: ANNA, body: { name: 'Haushaltskasse' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(groups(), before + 1);
});

test('split member candidates: a stored member who may not join anew stays listed, so it can be removed', async () => {
  // Clara (Hauspersonal) ist seit dem Test oben Mitglied der zweiten Gruppe.
  // Der Editor baut seine Kaestchen nur aus den Kandidaten - fehlt sie dort,
  // kann niemand ihre Mitgliedschaft sehen oder beenden.
  const other = await call('GET', `/split-expenses/groups/${OTHER}/member-candidates`);
  assert.equal(other.status, 200);
  const users = other.body.data.filter((row) => row.source === 'user');
  assert.deepEqual(idsOf(users, 'user_id'), [ANNA, BEN, CLARA, EMIL]);
  assert.equal(users.find((row) => row.user_id === CLARA).in_group, 1);

  const here = await call('GET', `/split-expenses/groups/${GROUP}/member-candidates`);
  assert.ok(!idsOf(here.body.data.filter((row) => row.source === 'user'), 'user_id').includes(CLARA),
    'not offered for a group she does not belong to');
});

// --------------------------------------------------------------------------
// Belohnungen: eine alte Einschreibung bleibt stehen, aber sie wirkt nicht
// --------------------------------------------------------------------------

test('rewards: an old enrolment of an account that is not a member earns, redeems and receives nothing', async () => {
  // Clara (Hauspersonal) ist seit der Fixture eingeschrieben (enabled = 1).
  const taskId = Number(db.prepare("INSERT INTO tasks (title, status, points, created_by) VALUES ('Fenster', 'open', 5, ?)").run(ANNA).lastInsertRowid);
  for (const id of [BEN, CLARA]) db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(taskId, id);
  const done = await call('PATCH', `/tasks/${taskId}/status`, { body: { status: 'done' } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const earned = db.prepare("SELECT user_id FROM reward_ledger WHERE task_id = ? AND type = 'earn' ORDER BY user_id").all(taskId)
    .map((row) => row.user_id);
  assert.deepEqual(earned, [BEN], 'the member earns the points, the old staff enrolment does not');

  const itemId = Number(db.prepare("INSERT INTO reward_catalog (name, cost, created_by) VALUES ('Eis', 1, ?)").run(ANNA).lastInsertRowid);
  db.prepare("INSERT INTO reward_ledger (user_id, delta, type, reason, created_by) VALUES (?, 10, 'bonus', 'Altbestand', ?)").run(CLARA, ANNA);
  const redeem = await call('POST', '/rewards/redemptions', { body: { catalog_id: itemId, user_id: CLARA } });
  assert.equal(redeem.status, 400, `redeeming for an old staff enrolment: ${JSON.stringify(redeem.body)}`);
  const bonus = await call('POST', '/rewards/bonus', { body: { user_id: CLARA, delta: 3 } });
  assert.equal(bonus.status, 400, `a bonus for an old staff enrolment: ${JSON.stringify(bonus.body)}`);

  const ok = await call('POST', '/rewards/redemptions', { body: { catalog_id: itemId, user_id: BEN } });
  assert.equal(ok.status, 201, `the member redeems as before: ${JSON.stringify(ok.body)}`);
});

// --------------------------------------------------------------------------
// Schutzsteuerungen: wer ausser mir ein Modul lesen kann
// --------------------------------------------------------------------------

test('auth: othersCanRead names the modules another account can read, staff included, guests not', async () => {
  const KEYS = ['calendar', 'documents', 'tasks'];
  const setAccess = (userId, key, access) => db.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', ?, ?)
    ON CONFLICT(subject_type, subject_id, resource_type, resource_key) DO UPDATE SET access = excluded.access
  `).run(String(userId), key, access);
  const readers = async () => {
    const me = await call('GET', '/auth/me', { as: ANNA });
    assert.equal(me.status, 200);
    return me.body.othersCanRead;
  };
  try {
    // Ein Haushalt aus einem Mitglied und Personal: Ben liest nichts mit, die
    // Gaeste Dora und Emil lesen ausserhalb geteilter Ausgaben ohnehin nichts.
    for (const key of KEYS) setAccess(BEN, key, 'none');
    assert.deepEqual(await readers(), KEYS, 'staff with module access can read along');
    for (const key of KEYS) setAccess(CLARA, key, 'none');
    assert.deepEqual(await readers(), [], 'without module access nobody else reads');
    setAccess(CLARA, 'documents', 'read');
    assert.deepEqual(await readers(), ['documents'], 'read access is enough');
  } finally {
    db.prepare(`DELETE FROM access_permissions WHERE subject_type = 'user' AND resource_type = 'module' AND subject_id IN (?, ?)`)
      .run(String(BEN), String(CLARA));
  }
});
