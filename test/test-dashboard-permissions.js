/**
 * Modul: Dashboard-Modulrechte (#467)
 * Zweck: Die Frage, die sich aus dem Code allein nicht beantworten lässt -
 *        bekommt ein Mitglied, dem ein Modul auf `none` steht, über
 *        GET /api/v1/dashboard trotzdem dessen Inhalte geliefert?
 *
 *        Die Route filtert jede Zeile über `visibilityWhere` (Zeilen-
 *        Privatsphäre: all/assignees/private). Das ist eine ANDERE Achse als
 *        die Modulrechte aus `access_permissions`, und die zweite fehlte hier.
 *        Die App fiel nicht auf: der Browser blendet die Kachel über
 *        `canSeeWidget` aus - der Titel stand trotzdem in der Antwort, im
 *        Netzwerk-Tab und im Service-Worker-Cache.
 *
 *        Der Test geht bewusst über den ECHTEN Router und die echte Antwort,
 *        nicht über den Resolver: gemessen wird, was auf der Leitung liegt.
 *
 * Ausführen: npm run test:dashboard-permissions
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'dashboard-permissions-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { resolvePermissions, buildSessionModuleAccess, PERMISSION_MODULES } = await import('../server/permissions.js');
const { moduleForPath } = await import('../server/scopes.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');

const moduleDatabase = get();
const db = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(db);
moduleDatabase.close();

function buildMigratedDatabase(migrations) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) {
    if (typeof migration.up === 'function') migration.up(database);
    else database.exec(migration.up);
    if (typeof migration.afterUp === 'function') migration.afterUp(database);
    database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
      .run(migration.version, migration.description);
  }
  return database;
}

// Lokaler Kalendertag wie in der Route (`todayLocalKey`), nicht der UTC-Tag:
// westlich von UTC sind das zwei verschiedene Tage, und die Route vergleicht
// Fälligkeiten gegen den lokalen.
const now = new Date();
const todayLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const currentMonth = todayLocal.slice(0, 7);
const inThreeDays = new Date(now.getTime() + 72 * 3600000).toISOString().slice(0, 10);

function seedUser(prefix, role, familyRole) {
  return db.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
    VALUES (?, ?, 'hash', '#007AFF', ?, ?)
  `).run(`${prefix}-${randomUUID()}`, prefix, role, familyRole).lastInsertRowid;
}

const PARENT = seedUser('parent', 'admin', 'parent');
const KID = seedUser('kid', 'member', 'child');

// --------------------------------------------------------------------------
// Bestand: von jedem modulgebundenen Teil der Antwort genau ein Datum, alles
// haushaltsweit sichtbar (`visibility = 'all'`). Die Zeilen-Privatsphäre darf
// hier NICHTS wegnehmen - sonst prüfte der Test die falsche Achse und wäre
// grün, ohne je ein Modulrecht angefasst zu haben.
// --------------------------------------------------------------------------
// Beide sind zugleich als Countdown markiert (#647): die Countdown-Kachel ist
// der einzige Teil der Antwort, der aus ZWEI Modulen einsammelt, und sie muss
// getrennt reagieren - sonst nimmt eine Kalendersperre die Aufgaben mit.
const eventId = db.prepare(`
  INSERT INTO calendar_events (title, start_datetime, visibility, countdown, created_by)
  VALUES ('Elterngespräch Schule', ?, 'all', 1, ?)
`).run(`${inThreeDays}T09:00:00`, PARENT).lastInsertRowid;
db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(eventId, PARENT);

db.prepare(`
  INSERT INTO tasks (title, priority, status, due_date, visibility, countdown, created_by)
  VALUES ('Steuerunterlagen sortieren', 'urgent', 'open', ?, 'all', 1, ?)
`).run(todayLocal, PARENT);
db.prepare(`
  INSERT INTO tasks (title, priority, status, due_date, visibility, created_by)
  VALUES ('Gestern fällig', 'high', 'open', '2000-01-01', 'all', ?)
`).run(PARENT);
db.prepare(`
  INSERT INTO tasks (title, priority, status, due_date, visibility, created_by)
  VALUES ('Heute erledigt', 'medium', 'done', ?, 'all', ?)
`).run(todayLocal, PARENT);

db.prepare(`
  INSERT INTO meals (date, meal_type, title, created_by) VALUES (?, 'dinner', 'Lasagne', ?)
`).run(todayLocal, PARENT);

db.prepare(`
  INSERT INTO notes (title, content, pinned, created_by) VALUES ('Zugangsdaten Router', 'geheim', 1, ?)
`).run(PARENT);

const listId = db.prepare(`
  INSERT INTO shopping_lists (name, created_by) VALUES ('Wocheneinkauf', ?)
`).run(PARENT).lastInsertRowid;
db.prepare('INSERT INTO shopping_items (list_id, name, is_checked) VALUES (?, ?, 0)').run(listId, 'Milch');

db.prepare(`
  INSERT INTO birthdays (name, birth_date, created_by) VALUES ('Oma Erna', ?, ?)
`).run(`1950-${todayLocal.slice(5)}`, PARENT);

db.prepare(`
  INSERT INTO budget_entries (title, amount, category, subcategory, date, created_by)
  VALUES ('Gehalt', 3000, 'Erwerbseinkommen', '', ?, ?)
`).run(`${currentMonth}-05`, PARENT);
db.prepare(`
  INSERT INTO budget_entries (title, amount, category, subcategory, date, created_by)
  VALUES ('Miete', -1200, 'housing', 'rent_mortgage', ?, ?)
`).run(`${currentMonth}-06`, PARENT);

db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(KID);
db.prepare("INSERT INTO reward_ledger (user_id, delta, type) VALUES (?, 42, 'earn')").run(KID);

// Gesundheit ist der persönlichste Teil der Antwort: das sind die EIGENEN
// Medikamente des Betrachters, nicht die der Familie.
const medId = db.prepare(`
  INSERT INTO medications (user_id, name, active, visibility, stock_qty, refill_threshold)
  VALUES (?, 'Eisen', 1, 'private', 2, 5)
`).run(KID).lastInsertRowid;
db.prepare(`
  INSERT INTO medication_schedules (medication_id, time_of_day, days_mask, active)
  VALUES (?, '08:00', NULL, 1)
`).run(medId);

const helperUser = seedUser('maria', 'member', 'other');
const workerId = db.prepare('INSERT INTO housekeeping_workers (user_id, daily_rate) VALUES (?, 40)')
  .run(helperUser).lastInsertRowid;
db.prepare(`
  INSERT INTO housekeeping_work_sessions (check_in, check_out, daily_rate, extras, worker_id, created_by)
  VALUES (?, NULL, 40, 0, ?, ?)
`).run(`${todayLocal}T09:00:00`, workerId, PARENT);

// --------------------------------------------------------------------------
// Server: die Auth-Schicht wird nachgestellt wie in server/auth.js
// (`applyRoleModuleAccess`) - Admin bekommt null (Bypass), ein eingeschränktes
// Mitglied die aufgelöste Modul→Access-Map. Genau dieses Feld liest die Route.
// --------------------------------------------------------------------------
let actor = PARENT;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const user = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(actor);
  req.authUserId = user.id;
  req.authRole = user.role;
  req.session = { userId: user.id, role: user.role };
  req.sessionModuleAccess = user.role === 'admin'
    ? null
    : buildSessionModuleAccess(resolvePermissions(db, user));
  // Token-Scopes wie in `requireAuth`: null für Sessions und ungescopte Tokens.
  req.authScopes = tokenScopes;
  next();
});
let tokenScopes = null;
app.use('/api/v1/dashboard', dashboardRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1/dashboard`;

test.after(() => { server.close(); db.close(); });

async function dashboardAs(userId) {
  actor = userId;
  const res = await fetch(base);
  assert.equal(res.status, 200, 'das Dashboard antwortet auch eingeschränkt mit 200 - es wird gefiltert, nicht verweigert');
  return res.json();
}

function denyModules(userId, modules) {
  const ins = db.prepare(`
    INSERT OR REPLACE INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', ?, 'none')
  `);
  // subject_id wird als TEXT gehalten und auch so abgefragt (`loadSubjectRows`).
  for (const key of modules) ins.run(String(userId), key);
}

function clearModuleDenials(userId) {
  db.prepare("DELETE FROM access_permissions WHERE subject_type = 'user' AND subject_id = ?").run(String(userId));
}

// ALLE gateable Module, aus dem Katalog abgeleitet und nicht abgeschrieben:
// kommt ein Modul dazu (zuletzt `inventory`), ist es hier sofort mit gesperrt.
const ALL_DENIED = PERMISSION_MODULES.map((m) => m.key);

// --------------------------------------------------------------------------
// Vorbedingung. OHNE SIE IST JEDE LEERE LISTE WEITER UNTEN WERTLOS: eine
// Zusicherung über eine Liste, die auch beim Nichtstun leer wäre, sichert
// nichts zu. Erst wenn dieselbe Anfrage desselben Mitglieds vorher ALLES
// liefert, sagt ihr Verschwinden etwas aus.
// --------------------------------------------------------------------------
test('Vorbedingung: ohne Einschränkung liefert der Endpoint dem Mitglied jeden Teil', async () => {
  clearModuleDenials(KID);
  const body = await dashboardAs(KID);

  assert.equal(body.upcomingEvents[0]?.title, 'Elterngespräch Schule');
  assert.ok(body.urgentTasks.some((t) => t.title === 'Steuerunterlagen sortieren'));
  assert.equal(body.openTaskCount, 2, 'zwei offene Aufgaben');
  assert.equal(body.overdueTaskCount, 1);
  assert.equal(body.tasksDoneToday, 1);
  assert.equal(body.todayMeals[0]?.title, 'Lasagne');
  assert.equal(body.pinnedNotes[0]?.title, 'Zugangsdaten Router');
  assert.equal(body.pinnedNotesCount, 1);
  assert.equal(body.shoppingLists[0]?.name, 'Wocheneinkauf');
  assert.equal(body.shoppingOpenCount, 1);
  assert.equal(body.birthdays[0]?.name, 'Oma Erna');
  assert.equal(body.birthdayCount, 1);
  assert.equal(body.budget.income, 3000);
  assert.equal(body.budget.expenses, 1200);
  assert.equal(body.rewards.participantCount, 1);
  assert.equal(body.health.hasMeds, true);
  assert.equal(body.health.dosesTotal, 1);
  assert.equal(body.housekeeping.present, true);
  assert.equal(body.countdownTotal, 2, 'ein Termin- und ein Aufgaben-Countdown (#647)');
});

// --------------------------------------------------------------------------
// Der Countdown ist der Sonderfall: eine Kachel, zwei Module.
// --------------------------------------------------------------------------
test('Countdown: eine Kalendersperre nimmt die Termin-Zeilen, nicht die Aufgaben-Zeilen', async () => {
  clearModuleDenials(KID);
  denyModules(KID, ['calendar']);
  const body = await dashboardAs(KID);

  assert.deepEqual(body.countdowns.map((c) => c.source), ['task'], 'nur noch die Aufgabe zählt herunter');
  assert.equal(body.countdownTotal, 1, 'die Gesamtzahl meint dieselbe Menge wie der Schnitt');
  assert.ok(!JSON.stringify(body).includes('Elterngespräch Schule'));

  clearModuleDenials(KID);
  denyModules(KID, ['tasks']);
  const andersherum = await dashboardAs(KID);
  assert.deepEqual(andersherum.countdowns.map((c) => c.source), ['event'], 'und umgekehrt genauso');
  assert.equal(andersherum.countdownTotal, 1);
  assert.ok(!JSON.stringify(andersherum).includes('Steuerunterlagen sortieren'));

  clearModuleDenials(KID);
});

// --------------------------------------------------------------------------
// Der eigentliche Befund.
// --------------------------------------------------------------------------
test('Kalender auf `none`: kein Termintitel und kein Geburtstag mehr in der Antwort', async () => {
  clearModuleDenials(KID);
  denyModules(KID, ['calendar']);

  const kid = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(KID);
  assert.equal(resolvePermissions(db, kid).modules.calendar, 'none', 'Vorbedingung: der Kalender ist gesperrt');

  const body = await dashboardAs(KID);
  const wire = JSON.stringify(body);

  assert.deepEqual(body.upcomingEvents, [], 'gesperrter Kalender liefert keine Termine');
  assert.deepEqual(body.birthdays, [], 'Geburtstage hängen am Kalender-Modul (PERMISSION_MODULES navIds)');
  assert.equal(body.birthdayCount, 0, 'auch die Zahl daneben, sonst verrät sie den Bestand');
  assert.ok(!wire.includes('Elterngespräch Schule'), 'der Titel darf nirgendwo in der Antwort stehen');
  assert.ok(!wire.includes('Oma Erna'), 'auch nicht der Name aus dem Geburtstagswidget');

  // Gegenprobe: die anderen Module bleiben unangetastet. Ein Filter, der zu
  // viel wegnimmt, ist genauso falsch wie einer, der zu wenig nimmt.
  assert.ok(body.urgentTasks.some((t) => t.title === 'Steuerunterlagen sortieren'), 'Aufgaben bleiben');
  assert.equal(body.todayMeals[0]?.title, 'Lasagne', 'Mahlzeiten bleiben');
});

test('Aufgaben auf `none`: weder Liste noch Zählstände noch die Pro-Mitglied-Last', async () => {
  clearModuleDenials(KID);
  denyModules(KID, ['tasks']);

  const body = await dashboardAs(KID);
  assert.deepEqual(body.urgentTasks, []);
  assert.deepEqual(body.memberTodayTasks, [], 'die Pro-Mitglied-Aggregation ist dieselbe Aufgabenmenge, nur gezählt');
  assert.equal(body.openTaskCount, 0);
  assert.equal(body.overdueTaskCount, 0);
  assert.equal(body.tasksDoneToday, 0);
  assert.ok(!JSON.stringify(body).includes('Steuerunterlagen sortieren'));
  assert.equal(body.upcomingEvents[0]?.title, 'Elterngespräch Schule', 'der Kalender bleibt');
});

// Je Modul eine Zahl, die nur dann größer null ist, wenn sein Teil der Antwort
// etwas trägt. Geteilt von der Rollen- und der Token-Achse weiter unten.
const MODULE_PROBES = {
  calendar: (b) => b.upcomingEvents.length + b.birthdays.length + b.birthdayCount,
  tasks: (b) => b.urgentTasks.length + b.openTaskCount + b.overdueTaskCount + b.tasksDoneToday,
  meals: (b) => b.todayMeals.length,
  notes: (b) => b.pinnedNotes.length + b.pinnedNotesCount,
  shopping: (b) => b.shoppingLists.length + b.shoppingOpenCount + b.shoppingOpenLists,
  budget: (b) => b.budget.income + b.budget.expenses + b.budget.entryCount,
  rewards: (b) => b.rewards.standings.length + b.rewards.participantCount,
  health: (b) => (b.health.hasMeds ? 1 : 0) + b.health.dosesTotal + b.health.lowStockCount,
  housekeeping: (b) => (b.housekeeping.configured ? 1 : 0) + (b.housekeeping.present ? 1 : 0),
};

test('Jedes gesperrte Modul verschwindet, und keins nimmt ein anderes mit', async () => {
  // Modul für Modul einzeln: ein Filter, der beim Sperren von A auch B leert,
  // fällt hier auf - eine Sperre auf alles zugleich könnte das nicht zeigen.
  const probes = MODULE_PROBES;

  clearModuleDenials(KID);
  const open = await dashboardAs(KID);
  for (const [key, probe] of Object.entries(probes)) {
    assert.ok(probe(open) > 0, `Vorbedingung: ${key} hat ohne Sperre etwas zu zeigen`);
  }

  for (const key of Object.keys(probes)) {
    clearModuleDenials(KID);
    denyModules(KID, [key]);
    const body = await dashboardAs(KID);
    assert.equal(probes[key](body), 0, `${key} auf 'none' liefert nichts mehr`);
    for (const other of Object.keys(probes)) {
      if (other === key) continue;
      assert.ok(probes[other](body) > 0, `Sperre auf ${key} darf ${other} nicht mit leeren`);
    }
  }
  clearModuleDenials(KID);
});

test('`read` ist keine Sperre: wer nur lesen darf, sieht sein Modul weiterhin', async () => {
  clearModuleDenials(KID);
  db.prepare(`
    INSERT OR REPLACE INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', 'calendar', 'read')
  `).run(String(KID));

  const body = await dashboardAs(KID);
  assert.equal(body.upcomingEvents[0]?.title, 'Elterngespräch Schule', 'nur-lesend heißt lesen dürfen');
  clearModuleDenials(KID);
});

test('Rollenprofil wirkt genauso wie der Mitglied-Override', async () => {
  clearModuleDenials(KID);
  db.prepare(`
    INSERT OR REPLACE INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('role', 'child', 'module', 'budget', 'none')
  `).run();
  try {
    const body = await dashboardAs(KID);
    assert.equal(body.budget.income, 0, 'die Rolle „child" sperrt das Budget');
    assert.equal(body.budget.entryCount, 0);
    assert.ok(!JSON.stringify(body).includes('3000'));
  } finally {
    db.prepare("DELETE FROM access_permissions WHERE subject_type = 'role'").run();
  }
});

test('Admin-Bypass: eine Sperre auf seiner Rolle nimmt dem Admin nichts weg', async () => {
  db.prepare(`
    INSERT OR REPLACE INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('role', 'parent', 'module', 'calendar', 'none')
  `).run();
  db.prepare(`
    INSERT OR REPLACE INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', 'calendar', 'none')
  `).run(String(PARENT));
  try {
    const body = await dashboardAs(PARENT);
    assert.equal(body.upcomingEvents[0]?.title, 'Elterngespräch Schule', 'kein Selbst-Aussperren (#467)');
  } finally {
    db.prepare("DELETE FROM access_permissions WHERE subject_type = 'role'").run();
    clearModuleDenials(PARENT);
  }
});

test('Nicht modulgebundene Teile bleiben auch bei voller Sperre stehen', async () => {
  // Die Mitgliederliste trägt Avatarfarben für Widgets, die keinem Modul
  // gehören (Familie, Uhr). Wer sie mit wegfiltert, macht das Dashboard eines
  // eingeschränkten Mitglieds unbedienbar, ohne etwas zu schützen - die Namen
  // stehen ohnehin in /auth/me und in jeder Zuweisung.
  clearModuleDenials(KID);
  denyModules(KID, ALL_DENIED);
  const body = await dashboardAs(KID);
  assert.ok(body.users.length >= 2, 'die Mitgliederliste bleibt');
  assert.equal(body.budget.month, currentMonth, 'der Monat ist keine Budgetzahl, er bleibt');
  clearModuleDenials(KID);
});

// --------------------------------------------------------------------------
// Der Guard für alles, was noch kommt.
//
// Er zählt NICHT die Felder, die der Fix anfasst - das wäre die Ebene des
// Fixes, nicht die des Schadens, und genau daran sind hier schon Sonden blind
// gewesen. Er misst die Antwort selbst: bei voller Sperre darf kein Feld mehr
// etwas tragen. Wer ein neues modulgebundenes Feld hinzufügt und die Zuordnung
// vergisst, bekommt es hier rot, ohne dass jemand diese Liste pflegen muss.
// --------------------------------------------------------------------------
const NONEMPTY_ERLAUBT = new Set([
  // Trägt Anzeigenamen und Avatarfarben für Widgets ohne Modul (Familie, Uhr).
  'users',
  // Der beschriftete Zeitraum, keine Budgetzahl.
  'budget.month',
]);

/** Trägt dieser Wert etwas? Zahlen, Strings, Listen, verschachtelte Objekte. */
function traegtEtwas(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.values(value).some(traegtEtwas);
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'boolean') return value;
  return String(value).length > 0;
}

/** Alle Pfade der Antwort, die etwas tragen - eine Ebene tief aufgeschlüsselt. */
function belegtePfade(body) {
  const out = [];
  for (const [key, value] of Object.entries(body)) {
    if (value && !Array.isArray(value) && typeof value === 'object') {
      for (const [sub, subValue] of Object.entries(value)) {
        if (traegtEtwas(subValue)) out.push(`${key}.${sub}`);
      }
    } else if (traegtEtwas(value)) {
      out.push(key);
    }
  }
  return out;
}

test('Guard: bei voller Sperre trägt kein Feld der Antwort mehr etwas', async () => {
  clearModuleDenials(KID);
  const offen = belegtePfade(await dashboardAs(KID));

  // DIE GEGENPROBE ZUERST. Eine Zusicherung über eine leere Antwort ist keine
  // Zusicherung, solange nicht feststeht, dass dieselbe Antwort ungesperrt voll
  // war. Die Zahl ist bewusst grob - sie soll einen kaputten Seed fangen, nicht
  // die Feldliste einfrieren.
  assert.ok(offen.length >= 12, `Vorbedingung: ungesperrt trägt die Antwort viel (gemessen: ${offen.length} Pfade)`);

  denyModules(KID, ALL_DENIED);
  const uebrig = belegtePfade(await dashboardAs(KID)).filter((p) => !NONEMPTY_ERLAUBT.has(p));

  assert.deepEqual(uebrig, [], [
    'Diese Felder tragen noch Daten, obwohl JEDES Modul gesperrt ist.',
    'Entweder gehören sie zu einem Modul - dann in DENIED_PAYLOAD',
    '(server/routes/dashboard.js) eintragen - oder sie sind bewusst modulfrei,',
    'dann gehören sie oben in NONEMPTY_ERLAUBT, mit Begründung.',
  ].join(' '));

  clearModuleDenials(KID);
});

// --------------------------------------------------------------------------
// Warum die Route selbst filtern muss - und nicht die Middleware es tut.
// --------------------------------------------------------------------------
test('Die /api/v1-Modulsperre kann diesen Endpoint gar nicht abdecken', async () => {
  // Der Guard in server/index.js schlägt den Pfad in scopes.js nach. Für
  // /dashboard ergibt das den Schlüssel `dashboard` - und der ist KEIN
  // Permissions-Modul (PERMISSION_MODULES), steht also nie in der Access-Map.
  // Der Guard lässt die Anfrage deshalb immer durch, egal was gesperrt ist.
  // Wer diesen Test später löscht, weil „das macht doch die Middleware",
  // findet hier den Grund, warum sie es nicht macht.
  clearModuleDenials(KID);
  denyModules(KID, ALL_DENIED);
  const kid = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(KID);
  const access = buildSessionModuleAccess(resolvePermissions(db, kid));

  assert.equal(moduleForPath('/dashboard'), 'dashboard', 'der Pfad löst auf ein Scope-Modul auf');
  assert.ok(!('dashboard' in access), 'aber `dashboard` ist kein Permissions-Modul → der Guard greift nie');
  assert.equal(access.calendar, 'none', 'gesperrt ist der Kalender, und den fragt niemand für /dashboard ab');
  clearModuleDenials(KID);
});

// --------------------------------------------------------------------------
// Die zweite Achse: Token-Scopes. `dashboard:read` öffnet die Übersicht, nicht
// die Module darin - dieselbe Frage wie oben, nur für ein API-Token, das an einen
// fremden Client geht (Discussion #455). Das Mitglied bleibt dabei ungesperrt,
// damit die Tests die Token-Achse messen und nicht die Rolle.
// --------------------------------------------------------------------------
async function dashboardWithScopes(userId, scopes) {
  tokenScopes = scopes;
  try {
    return await dashboardAs(userId);
  } finally {
    tokenScopes = null;
  }
}

test('Token nur mit `dashboard:read`: kein modulgebundenes Feld trägt etwas', async () => {
  clearModuleDenials(KID);
  const offen = belegtePfade(await dashboardAs(KID));
  assert.ok(offen.length >= 12, `Vorbedingung: ungescopt trägt die Antwort viel (gemessen: ${offen.length} Pfade)`);

  const uebrig = belegtePfade(await dashboardWithScopes(KID, ['dashboard:read']))
    .filter((p) => !NONEMPTY_ERLAUBT.has(p));
  assert.deepEqual(uebrig, [], 'diese Felder kommen ohne passenden Modul-Scope durch');
});

test('Jeder Modul-Scope öffnet genau sein Modul, und keins ein anderes', async () => {
  clearModuleDenials(KID);
  for (const key of Object.keys(MODULE_PROBES)) {
    const body = await dashboardWithScopes(KID, ['dashboard:read', `${key}:read`]);
    assert.ok(MODULE_PROBES[key](body) > 0, `Scope ${key}:read zeigt ${key}`);
    for (const other of Object.keys(MODULE_PROBES)) {
      if (other === key) continue;
      assert.equal(MODULE_PROBES[other](body), 0, `Scope ${key}:read darf ${other} nicht öffnen`);
    }
  }
});

test('Countdown per Token: `tasks:read` allein lässt nur die Aufgabe herunterzählen', async () => {
  clearModuleDenials(KID);
  const body = await dashboardWithScopes(KID, ['dashboard:read', 'tasks:read']);
  assert.deepEqual(body.countdowns.map((c) => c.source), ['task']);
  assert.equal(body.countdownTotal, 1, 'die Gesamtzahl meint dieselbe Menge wie der Schnitt');
  assert.ok(!JSON.stringify(body).includes('Elterngespräch Schule'));
});

test('`write` schließt `read` ein, und ein Scope erweitert keine Rollensperre', async () => {
  clearModuleDenials(KID);
  const schreibend = await dashboardWithScopes(KID, ['dashboard:read', 'calendar:write']);
  assert.equal(schreibend.upcomingEvents[0]?.title, 'Elterngespräch Schule', 'calendar:write liest mit');
  assert.equal(MODULE_PROBES.tasks(schreibend), 0, 'und öffnet nur den Kalender, nicht die Aufgaben');

  denyModules(KID, ['calendar']);
  const gesperrt = await dashboardWithScopes(KID, ['dashboard:read', 'calendar:read', 'tasks:read']);
  assert.deepEqual(gesperrt.upcomingEvents, [], 'die Rolle sperrt den Kalender, der Scope öffnet ihn nicht');
  assert.ok(gesperrt.urgentTasks.length > 0, 'was beide Achsen erlauben, bleibt');
  clearModuleDenials(KID);
});
