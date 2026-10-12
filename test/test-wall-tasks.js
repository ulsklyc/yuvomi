/**
 * Modul: Wand - die Aufgaben von heute unter jeder Person (#1817)
 * Zweck: Drei Dinge, jedes gegen das echte Stueck Code:
 *
 *        1. SERVER (`wallTasks` in GET /dashboard, echter Router, migrierte
 *           In-Memory-DB, festgenagelte Uhr und Haushaltszone): Titel je
 *           Mitglied ohne den Fuenfer-Deckel von `urgentTasks`; nur
 *           `visibility = 'all'`, auch wenn die betrachtende Person die
 *           Aufgabe selbst angelegt hat und ihr zugewiesen ist; Erledigtes von
 *           heute (faellig heute, oder ueberfaellig und HEUTE abgehakt - der Tag
 *           ist der des Haushalts, mit Los Angeles als Gegenlauf).
 *        2. PLAN (`planWallWhoLines`, `WALL_WHO_LADDER`): offene zuerst, Haken
 *           darunter, die Zaehlzeile kostet eine Zeile, und ueber die Leiter
 *           hinab weichen ALLE Haken, bevor ein offener Titel weicht - ausser
 *           bei der Person, die alles erledigt hat.
 *        3. FLAECHE (`renderWallWho`, `fitWallWho`): Titel escaped, Haken als
 *           eigene Klasse mit Wort fuer Screenreader, die Zahl am Gesicht ist
 *           die der OFFENEN; und der Abstieg laeuft als Programm gegen eine
 *           Attrappe, deren Hoehe an der Zahl der Zeilen haengt.
 *
 *        6. GETEILTE FLAECHE (`audience=household`): die ganze Antwort fuer die
 *           Wand traegt nur, was der ganze Haushalt sehen darf - Aufgaben UND
 *           Termine, beide Sichtbarkeitsachsen der Termine (Stufe der Zeile,
 *           ICS-Abo), in jeder Scheibe, auch aus der Sitzung der Person, der
 *           die Zeile gehoert. Ohne den Parameter bleibt die Antwort
 *           persoenlich. Und die gebaute Wand zeigt davon an keiner Stelle
 *           etwas.
 *        7. PERSOENLICHE BEITRAEGE: was dem Betrachter allein gilt - die eigene
 *           Dosis, die eigene Schicht, die eigene Erinnerung, wartende
 *           Freigaben - steht in der Haushaltsfassung gar nicht, aus keiner
 *           Sitzung; ohne den Parameter bleibt es stehen; und die Wand ist aus
 *           jeder Sitzung dieselbe wie auf einem gekoppelten Display.
 *        8. ALLOWLIST: die Haushaltsfassung traegt nur die Schluessel, die die
 *           Wand zeichnet (`HOUSEHOLD_AUDIENCE_SHOWS`); Notizen, Budget,
 *           geteilte Ausgaben, Schnellzugriffe, Countdowns und der offene Lohn
 *           der Haushaltshilfe kommen leer, als Text wie als Zahl, und werden
 *           nicht gelesen. DRIFT-GUARD: die Schluessel der ECHTEN Antwort
 *           gegen die Allowlist und eine hier gefuehrte Bewusst-leer-Liste -
 *           ein neuer Schluessel der Route ist rot, bis jemand entscheidet.
 *
 * Ausfuehren: npm run test:wall-tasks
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { register } from 'node:module';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

register('./test-browser-loader.mjs', import.meta.url);

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'wall-tasks-test-secret';

const { resolvePermissions, buildSessionModuleAccess } = await import('../server/permissions.js');
const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
const { default: remindersRouter } = await import('../server/routes/reminders.js');
const { DISPLAY_SCOPES } = await import('../server/services/display-accounts.js');

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

const moduleDatabase = get();
const db = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(db);
moduleDatabase.close();

function addUser(name, role = 'member') {
  return Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
    VALUES (?, ?, 'hash', '#7C3AED', ?, 'parent')
  `).run(`wall-${name}-${randomUUID()}`, name, role).lastInsertRowid);
}
const ANNA = addUser('Anna', 'admin');
const BEN = addUser('Ben');
const CLEO = addUser('Cleo');

let viewer = ANNA;
/** Ein gekoppeltes Display: Methode, Scopes und Rechte wie `requireAuth` sie setzt. */
let asDisplay = false;
const app = express();
app.use((req, _res, next) => {
  const user = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(viewer);
  req.authUserId = user.id;
  req.authRole = user.role;
  req.session = { userId: user.id, role: user.role };
  if (asDisplay) { req.authMethod = 'display'; req.authScopes = [...DISPLAY_SCOPES]; }
  req.sessionModuleAccess = buildSessionModuleAccess(resolvePermissions(db, user, { isDisplay: asDisplay }));
  next();
});
app.use('/reminders', remindersRouter);
app.use('/', dashboardRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

async function wallTasksFor(userId = ANNA) {
  viewer = userId;
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.wallTasks), 'Reichweite: die Antwort traegt wallTasks');
  return Object.fromEntries(body.wallTasks.map((entry) => [entry.user_id, entry]));
}

// Nur `Date` wird gemockt; die Zone ist die des HAUSHALTS, nicht die des Rechners.
function withClock(iso, zone, fn) {
  return async () => {
    db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', ?)").run(zone);
    db.prepare('DELETE FROM tasks').run();
    mock.timers.enable({ apis: ['Date'], now: new Date(iso) });
    try {
      await fn();
    } finally {
      mock.timers.reset();
    }
  };
}

function addTask(title, assignees, {
  due = '2026-10-08', status = 'open', visibility = 'all', createdBy = ANNA,
  completedAt = null, parent = null, archived = null, start = null, dueTime = null,
} = {}) {
  const id = Number(db.prepare(`
    INSERT INTO tasks (title, status, due_date, due_time, created_by, visibility, parent_task_id, archived_at, start_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title, status, due, dueTime, createdBy, visibility, parent, archived, start).lastInsertRowid);
  for (const userId of [].concat(assignees)) {
    db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(id, userId);
  }
  if (completedAt) {
    db.prepare('INSERT INTO task_completions (task_id, series_id, user_id, completed_at) VALUES (?, ?, ?, ?)')
      .run(id, id, [].concat(assignees)[0] ?? ANNA, completedAt);
  }
  return id;
}
const titles = (list) => (list ?? []).map((task) => task.title);

// Donnerstag, 08.10.2026, 12:00 in Berlin.
const NOON_BERLIN = '2026-10-08T10:00:00Z';

// --------------------------------------------------------------------------
// 1. Server
// --------------------------------------------------------------------------

test('Server: Titel je Mitglied, ohne den Fuenfer-Deckel des Haushalts', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  for (let i = 1; i <= 6; i++) addTask(`Anna ${i}`, ANNA);
  addTask('Bens siebte', BEN);
  const by = await wallTasksFor();
  assert.equal(by[ANNA].open_count, 6);
  assert.deepEqual(titles(by[ANNA].open), ['Anna 1', 'Anna 2', 'Anna 3', 'Anna 4', 'Anna 5', 'Anna 6']);
  assert.deepEqual(titles(by[BEN].open), ['Bens siebte'], 'die siebte Aufgabe des Haushalts steht unter ihrer Person');
}));

test('Server: die Zahl ist ungekappt, die Titel sind es nicht', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  for (let i = 1; i <= 9; i++) addTask(`Viel ${i}`, BEN);
  const by = await wallTasksFor();
  assert.equal(by[BEN].open_count, 9);
  assert.equal(by[BEN].open.length, 6);
}));

test('Server: nur haushaltssichtbare Aufgaben - auch aus der Sitzung der zugewiesenen Person', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  addTask('Fuer alle', BEN);
  addTask('Nur Zugewiesene', BEN, { visibility: 'assignees', createdBy: BEN });
  addTask('Privat', BEN, { visibility: 'private', createdBy: BEN });
  addTask('Erledigt und privat', BEN, { visibility: 'assignees', createdBy: BEN, status: 'done' });
  for (const who of [ANNA, BEN]) {
    const by = await wallTasksFor(who);
    assert.deepEqual(titles(by[BEN].open), ['Fuer alle'], `Betrachter ${who === BEN ? 'Ben selbst' : 'Anna'}`);
    assert.equal(by[BEN].open_count, 1);
    assert.equal(by[BEN].done_count, 0);
  }
}));

test('Server: ueberfaellig zaehlt zu heute, morgen nicht', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  addTask('Von gestern', CLEO, { due: '2026-10-07' });
  addTask('Heute', CLEO);
  addTask('Morgen', CLEO, { due: '2026-10-09' });
  addTask('Ohne Datum', CLEO, { due: null });
  const by = await wallTasksFor();
  assert.deepEqual(titles(by[CLEO].open), ['Von gestern', 'Heute'], 'das Aeltere zuerst');
}));

test('Server: das Aeltere zuerst - nach Faelligkeit, nicht nach Anlage', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  addTask('Heute, zuerst angelegt', CLEO);
  addTask('Von vorgestern, spaeter angelegt', CLEO, { due: '2026-10-06' });
  addTask('Heute um neun', CLEO, { dueTime: '09:00' });
  const by = await wallTasksFor();
  assert.deepEqual(titles(by[CLEO].open), ['Von vorgestern, spaeter angelegt', 'Heute um neun', 'Heute, zuerst angelegt']);
}));

test('Server: Begonnenes ist offen', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  addTask('Angefangen', BEN, { status: 'in_progress' });
  const by = await wallTasksFor();
  assert.deepEqual(titles(by[BEN].open), ['Angefangen']);
  assert.equal(by[BEN].open_count, 1);
  assert.equal(by[BEN].done_count, 0);
}));

test('Server: die Kategorie-Auswahl der Uebersicht gilt auch fuer die Wand', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  const school = addTask('Schule', BEN);
  const home = addTask('Haushalt', BEN);
  const doneHome = addTask('Haushalt erledigt', BEN, { status: 'done' });
  db.prepare("UPDATE tasks SET category = 'school' WHERE id = ?").run(school);
  db.prepare("UPDATE tasks SET category = 'household' WHERE id IN (?, ?)").run(home, doneHome);
  viewer = ANNA;
  const all = Object.fromEntries((await (await fetch(`${base}/`)).json()).wallTasks.map((e) => [e.user_id, e]));
  assert.equal(all[BEN].open_count, 2, 'Vorbedingung: ohne Auswahl beide');
  const filtered = Object.fromEntries((await (await fetch(`${base}/?tasks_category=school`)).json()).wallTasks.map((e) => [e.user_id, e]));
  assert.deepEqual(titles(filtered[BEN].open), ['Schule']);
  assert.equal(filtered[BEN].done_count, 0, 'auch das Erledigte folgt der Auswahl');
}));

test('Server: heute faellig und erledigt behaelt den Haken auch OHNE Abschlusszeile', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  // Zwei Schreiber setzen `status = 'done'`, ohne `task_completions` zu fuellen
  // (der Abgleich mit CalDAV-Erinnerungen, die Haushaltshilfe). Der Tag der
  // Faelligkeit traegt den Haken dann allein.
  const id = addTask('In Erinnerungen abgehakt', BEN, { status: 'done' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_completions WHERE task_id = ?').get(id).n, 0, 'Vorbedingung: keine Abschlusszeile');
  // Die bekannte Grenze daneben: war sie UEBERFAELLIG, fehlt ohne Abschlusszeile
  // der Tag, an dem sie erledigt wurde - sie steht dann nicht mehr an der Wand.
  addTask('Ueberfaellig, ohne Abschlusszeile abgehakt', BEN, { due: '2026-10-07', status: 'done' });
  const by = await wallTasksFor();
  assert.deepEqual(titles(by[BEN].done), ['In Erinnerungen abgehakt']);
}));

test('Server: mehrere Zugewiesene - die Aufgabe steht unter jeder Person', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  addTask('Zusammen', [BEN, CLEO]);
  const by = await wallTasksFor();
  assert.deepEqual(titles(by[BEN].open), ['Zusammen']);
  assert.deepEqual(titles(by[CLEO].open), ['Zusammen']);
}));

test('Server: Unteraufgaben, Abgelegtes und noch nicht Begonnenes stehen nicht an der Wand', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  const parent = addTask('Eltern', BEN);
  addTask('Kind', BEN, { parent });
  addTask('Abgelegt', BEN, { archived: '2026-10-08T08:00:00Z' });
  addTask('Beginnt morgen', BEN, { start: '2026-10-09' });
  const by = await wallTasksFor();
  assert.deepEqual(titles(by[BEN].open), ['Eltern']);
}));

test('Server: Erledigtes von heute kommt mit - faellig heute, oder ueberfaellig und heute abgehakt', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  addTask('Offen', BEN);
  addTask('Heute faellig, erledigt', BEN, { status: 'done', completedAt: '2026-10-08T07:00:00Z' });
  addTask('Gestern faellig, heute abgehakt', BEN, { due: '2026-10-07', status: 'done', completedAt: '2026-10-08T08:00:00Z' });
  addTask('Gestern faellig, gestern abgehakt', BEN, { due: '2026-10-07', status: 'done', completedAt: '2026-10-07T15:00:00Z' });
  addTask('Morgen faellig, heute abgehakt', BEN, { due: '2026-10-09', status: 'done', completedAt: '2026-10-08T08:00:00Z' });
  const by = await wallTasksFor();
  assert.deepEqual(titles(by[BEN].open), ['Offen']);
  assert.deepEqual(titles(by[BEN].done).sort(), ['Gestern faellig, heute abgehakt', 'Heute faellig, erledigt']);
  assert.equal(by[BEN].done_count, 2);
}));

test('Server: wer alles erledigt hat, bleibt bis zum Tageswechsel stehen - und nicht laenger', async () => {
  const seed = () => addTask('Geschafft', CLEO, { status: 'done', completedAt: '2026-10-08T09:00:00Z' });
  await withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
    seed();
    const by = await wallTasksFor();
    assert.deepEqual(titles(by[CLEO].done), ['Geschafft']);
    assert.equal(by[CLEO].open_count, 0);
  })();
  // 09.10. 00:30 in Berlin.
  await withClock('2026-10-08T22:30:00Z', 'Europe/Berlin', async () => {
    seed();
    const by = await wallTasksFor();
    assert.equal(by[CLEO], undefined, 'mit dem neuen Tag ist die Spalte leer');
  })();
});

test('Server: der Tag einer Erledigung ist der des Haushalts, nicht der UTC-Tag', async () => {
  // Abgehakt am 07.10. um 23:30 UTC: in Berlin der 08.10. 01:30, in Los Angeles der 07.10. 16:30.
  const seed = () => addTask('Spaet abgehakt', BEN, { due: '2026-10-06', status: 'done', completedAt: '2026-10-07T23:30:00Z' });
  await withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
    seed();
    assert.deepEqual(titles((await wallTasksFor())[BEN]?.done), ['Spaet abgehakt'], 'Berlin: das war heute');
  })();
  // 08.10. 09:00 in Los Angeles.
  await withClock('2026-10-08T16:00:00Z', 'America/Los_Angeles', async () => {
    seed();
    assert.equal((await wallTasksFor())[BEN], undefined, 'Los Angeles: das war gestern');
  })();
});

// --------------------------------------------------------------------------
// 2. Plan
// --------------------------------------------------------------------------

const { __test: dash } = await import('../public/pages/dashboard.js');
const { setPermissions, clearPermissions } = await import('../public/permissions.js');
const { setHouseholdSize, clearHouseholdSize } = await import('../public/utils/household.js');

const task = (title) => ({ id: title, title });
const entry = (open, done, extra = {}) => ({
  open: open.map(task), done: done.map(task), open_count: open.length, done_count: done.length, ...extra,
});
const shape = (plan) => ({
  open: plan.open.map((x) => x.title), done: plan.done.map((x) => x.title), moreOpen: plan.moreOpen, moreDone: plan.moreDone,
});

test('Plan: offene zuerst, Haken darunter, alles passt', () => {
  assert.deepEqual(shape(dash.planWallWhoLines(entry(['a', 'b'], ['x']), { rows: 5, doneRows: 4 })),
    { open: ['a', 'b'], done: ['x'], moreOpen: 0, moreDone: 0 });
});

test('Plan: die Zaehlzeile kostet eine Zeile und verdraengt zuerst einen Haken', () => {
  assert.deepEqual(shape(dash.planWallWhoLines(entry(['a', 'b', 'c'], ['x', 'y']), { rows: 4, doneRows: 4 })),
    { open: ['a', 'b', 'c'], done: [], moreOpen: 0, moreDone: 2 },
    'drei offene + ein Haken waeren vier Zeilen, der zweite Haken bliebe ungenannt');
  assert.deepEqual(shape(dash.planWallWhoLines(entry(['a', 'b', 'c', 'd'], ['x']), { rows: 3, doneRows: 0 })),
    { open: ['a', 'b'], done: [], moreOpen: 2, moreDone: 1 });
});

test('Plan: ein offener Titel weicht nie fuer die Zahl der Erledigten', () => {
  assert.deepEqual(shape(dash.planWallWhoLines(entry(['a', 'b', 'c'], ['x', 'y']), { rows: 3, doneRows: 0 })),
    { open: ['a', 'b', 'c'], done: [], moreOpen: 0, moreDone: 0 });
  assert.deepEqual(shape(dash.planWallWhoLines(entry(['a', 'b', 'c'], ['x', 'y']), { rows: 4, doneRows: 0 })),
    { open: ['a', 'b', 'c'], done: [], moreOpen: 0, moreDone: 2 }, 'ist eine Zeile frei, steht die Zahl da');
});

test('Plan: eine Zeile gehoert dem Titel, null Zeilen zeigen nichts', () => {
  assert.deepEqual(shape(dash.planWallWhoLines(entry(['a', 'b'], []), { rows: 1, doneRows: 0 })),
    { open: ['a'], done: [], moreOpen: 0, moreDone: 0 });
  assert.deepEqual(shape(dash.planWallWhoLines(entry(['a', 'b'], ['x']), { rows: 0, doneRows: 0 })),
    { open: [], done: [], moreOpen: 0, moreDone: 0 });
});

test('Plan: die Zahl kommt vom Server, nicht aus der gekappten Titelliste', () => {
  const plan = dash.planWallWhoLines(entry(['a', 'b'], [], { open_count: 9 }), { rows: 3, doneRows: 0 });
  assert.equal(plan.openTotal, 9);
  assert.deepEqual(shape(plan), { open: ['a', 'b'], done: [], moreOpen: 7, moreDone: 0 });
});

test('Plan: wer alles erledigt hat, behaelt einen Haken, solange Titel stehen', () => {
  assert.deepEqual(shape(dash.planWallWhoLines(entry([], ['x', 'y']), { rows: 2, doneRows: 0 })),
    { open: [], done: ['x'], moreOpen: 0, moreDone: 1 });
  assert.deepEqual(shape(dash.planWallWhoLines(entry([], ['x', 'y']), { rows: 1, doneRows: 0 })),
    { open: [], done: ['x'], moreOpen: 0, moreDone: 0 });
});

test('Leiter: sie endet ohne Titel, und alle Haken weichen, bevor ein offener Titel weicht', () => {
  const ladder = dash.WALL_WHO_LADDER;
  assert.deepEqual(ladder.at(-1), { rows: 0, doneRows: 0 }, 'die letzte Stufe ist die Reihe der Gesichter');
  const anna = entry(['a1'], ['x1', 'x2', 'x3']);       // wenig offen, viele Haken
  const ben = entry(['b1', 'b2', 'b3', 'b4'], []);      // nur offene
  let openBefore = Infinity;
  let doneBefore = Infinity;
  for (const budget of ladder) {
    const a = dash.planWallWhoLines(anna, budget);
    const b = dash.planWallWhoLines(ben, budget);
    for (const plan of [a, b]) {
      const lines = plan.open.length + plan.done.length + (plan.moreOpen || plan.moreDone ? 1 : 0);
      assert.ok(lines <= budget.rows, `Stufe ${JSON.stringify(budget)}: ${lines} Zeilen`);
    }
    const open = a.open.length + b.open.length;
    const done = a.done.length + b.done.length;
    assert.ok(open <= openBefore && done <= doneBefore, 'die Leiter zeigt nach unten nie mehr');
    if (open < openBefore && openBefore !== Infinity) {
      assert.equal(doneBefore, 0, `ein offener Titel wich auf Stufe ${JSON.stringify(budget)}, waehrend noch ein Haken stand`);
    }
    openBefore = open;
    doneBefore = done;
  }
});

// --------------------------------------------------------------------------
// 3. Flaeche
// --------------------------------------------------------------------------

function onWall(fn) {
  return async () => {
    const prevWindow = global.window;
    const prevDocument = global.document;
    const prevComputed = global.getComputedStyle;
    global.window = { yuvomi: { isModuleDisabled: () => false }, innerHeight: 800 };
    global.document = { documentElement: { classList: { toggle() {}, add() {}, remove() {} } } };
    global.getComputedStyle = (element) => ({ gridTemplateColumns: element?.__columns ?? '' });
    setPermissions({ admin: true, modules: {}, widgets: {}, capabilities: {} });
    setHouseholdSize(4);
    try {
      await fn();
    } finally {
      clearHouseholdSize();
      clearPermissions();
      global.window = prevWindow;
      global.document = prevDocument;
      global.getComputedStyle = prevComputed;
    }
  };
}

const U = (id, name) => ({ id, display_name: name, avatar_color: '#7C3AED' });
const members = (html) => [...html.matchAll(/<li class="wall-who__member">([\s\S]*?)<\/li>\s*(?=<li class="wall-who__member">|<\/ul>(?:<p|\s*<\/section>))/g)].map((m) => m[1]);
const NO_ROWS = { allRows: [] };

test('Flaeche: Titel unter dem Gesicht, Haken darunter, die Zahl ist die der offenen', onWall(() => {
  const data = {
    users: [U(1, 'Anna Muster'), U(2, 'Ben Muster'), U(3, 'Cleo Muster')],
    wallTasks: [
      { user_id: 2, ...entry(['Klavier <b>ueben</b>', 'Zimmer'], ['Bett machen']) },
      { user_id: 3, ...entry([], ['Tisch decken']) },
    ],
  };
  const html = dash.renderWallWho(data, NO_ROWS);
  assert.match(html, /wall-who__list--tasks/);
  assert.ok(!html.includes('Anna'), 'wer nichts hat und in keinem Programm steht, ist nicht dran');
  const [ben, cleo] = members(html);
  assert.match(ben, /Ben/);
  assert.ok(ben.includes('Klavier &lt;b&gt;ueben&lt;/b&gt;'), 'der Titel ist Nutzereingabe und laeuft durch esc()');
  assert.ok(ben.indexOf('Zimmer') < ben.indexOf('Bett machen'), 'offene zuerst');
  assert.match(ben, /wall-who__task--done[\s\S]*tasks\.statusDone[\s\S]*Bett machen/, 'der Haken traegt Klasse und Wort');
  assert.match(ben, /wall-who__count">\s*<span aria-hidden="true">2</, 'die Zahl ist, was offen ist');
  assert.match(ben, /dashboard\.familyDayTally\{&quot;open&quot;:2,&quot;done&quot;:1\}/);
  assert.match(cleo, /wall-who__count--done/, 'alles erledigt: Haken statt Zahl');
  assert.match(cleo, /wall-who__task--done[\s\S]*Tisch decken/, 'und die Spalte zeigt, was geschafft wurde');
}));

test('Flaeche: die Zahl zaehlt offene Aufgaben und was das Programm sonst fuehrt - nie dessen Aufgabenzeilen', onWall(() => {
  const data = {
    users: [U(1, 'Anna'), U(2, 'Ben'), U(3, 'Cleo')],
    wallTasks: [{ user_id: 2, ...entry(['a', 'b', 'c'], []) }],
  };
  const model = { allRows: [
    { kind: 'event', who: { id: 1 } },                    // Annas Termin
    { kind: 'meal', who: { id: 2 } },                     // Ben kocht
    { kind: 'task', who: { id: 2 } },                     // dieselbe Aufgabe wie in wallTasks
    { kind: 'task', who: { id: 3 } },                     // Cleos Aufgabe ist "nur Zugewiesene"
  ] };
  const html = dash.renderWallWho(data, model);
  const count = (block) => (/wall-who__count">\s*<span aria-hidden="true">(\d+)</.exec(block) ?? [])[1] ?? null;
  const by = Object.fromEntries(members(html).map((block) => [/wall-who__name">([^<]*)/.exec(block)[1], block]));
  assert.equal(count(by.Ben), '4', 'drei offene Aufgaben und das Kochen - die Programmzeile der Aufgabe zaehlt nicht doppelt');
  assert.equal(count(by.Anna), '1', 'ein Termin ist etwas, das heute vor ihr liegt');
  assert.ok(!by.Anna.includes('wall-who__tasks'), 'aber kein Titel: der Termin steht links');
  assert.ok(by.Cleo, 'wer im Programm steht, ist dran');
  assert.equal(count(by.Cleo), null, 'eine Aufgabe, die der Haushalt nicht sehen darf, traegt auch keine Zahl an die Wand');
  assert.deepEqual(Object.keys(by), ['Ben', 'Anna', 'Cleo'], 'wer am meisten vor sich hat, zuerst');
}));

test('Flaeche: ohne Titel bleibt die Reihe der Gesichter', onWall(() => {
  const data = { users: [U(1, 'Anna'), U(2, 'Ben')], wallTasks: [] };
  const html = dash.renderWallWho(data, { allRows: [{ kind: 'event', who: { id: 1 } }] });
  assert.match(html, /Anna/);
  assert.ok(!html.includes('wall-who__list--tasks'));
}));

test('Flaeche: was nicht passt, ist eine Zahl - offene als „weitere", Haken als „erledigt"', onWall(() => {
  const data = {
    users: [U(1, 'Anna'), U(2, 'Ben')],
    wallTasks: [
      { user_id: 1, ...entry(['a', 'b', 'c', 'd'], []) },
      { user_id: 2, ...entry([], ['x', 'y', 'z']) },
    ],
  };
  const html = dash.renderWallWho(data, NO_ROWS, { rows: 2, doneRows: 0 });
  const [anna, ben] = members(html);
  assert.match(anna, /wall-who__task--more">dashboard\.shoppingMore\{&quot;count&quot;:3\}/);
  assert.match(ben, /wall-who__task--more">dashboard\.wallWhoDoneMore\{&quot;count&quot;:2\}/);
}));

// Eine Attrappe der Wand: `base` Pixel Sockel, 40px je Zeile unter den
// Gesichtern. `columns` ist, was das Stylesheet der Buehne gaebe - zwei Spalten
// auf dem Wandtablett, eine auf dem Telefon; `fitWallWho` fragt es ueber
// `getComputedStyle` ab, das `onWall` hier bereitstellt.
function fakeWall(initialHtml, base, { columns = '600px 400px', aside = '400px', floor = 0 } = {}) {
  const state = { html: initialHtml, base, placed: 0 };
  const stage = { __columns: columns };
  const asideEl = { __columns: aside };
  const section = () => ({
    insertAdjacentHTML(_pos, next) { state.html = next; state.placed += 1; },
    remove() {},
  });
  const wall = {
    querySelector: (selector) => (selector === '.wall__who' ? section()
      : selector === '.wall__stage' ? stage
        : selector === '.wall__aside' ? asideEl : null),
    // `floor`: was die Flaeche OHNE Zutun der Liste hoch ist (das Programm
    // links, das Wetter daneben) - darunter kosten Zeilen nichts.
    get scrollHeight() {
      return Math.max(floor, state.base + 40 * (state.html.match(/class="wall-who__task[ "]/g) ?? []).length);
    },
  };
  return { root: { querySelector: () => wall }, html: () => state.html, state, wall };
}
const countTasks = (html, cls) => (html.match(new RegExp(`class="wall-who__task${cls}`, 'g')) ?? []).length;

test('Flaeche: fitWallWho steigt hinab, bis die Wand passt - Haken zuerst', onWall(() => {
  const data = {
    users: [U(1, 'Anna'), U(2, 'Ben')],
    upcomingEvents: [], urgentTasks: [],
    wallTasks: [
      { user_id: 1, ...entry(['a1', 'a2', 'a3'], ['x1', 'x2']) },
      { user_id: 2, ...entry(['b1'], ['y1', 'y2', 'y3']) },
    ],
  };
  // Eine Attrappe der Wand: 600px Sockel, 40px je Zeile unter den Gesichtern.
  const makeWall = (base, opts) => fakeWall(dash.renderWallWho(data, NO_ROWS), base, opts);
  const count = countTasks;

  const roomy = makeWall(300);
  assert.equal(dash.fitWallWho(roomy.root, data), 0, 'passt alles, bleibt die oberste Stufe');

  // 600 + 40 * Zeilen <= 800: fuenf Zeilen passen. Vier sind offen.
  const tight = makeWall(600);
  const step = dash.fitWallWho(tight.root, data);
  assert.ok(step > 0, 'Reichweite: die Attrappe lief ueber');
  const html = tight.html();
  assert.equal(count(html, '"'), 4, 'alle offenen Titel stehen noch');
  assert.ok(count(html, ' wall-who__task--done') <= 1, 'gewichen sind die Haken');
  assert.ok(600 + 40 * (html.match(/class="wall-who__task[ "]/g) ?? []).length <= 800, 'und jetzt passt es');

  // Laeuft eine GESTAPELTE Flaeche auch ohne Titel ueber (Telefon), sind die
  // Titel nicht der Grund - dann bleiben sie stehen.
  const phone = makeWall(900, { columns: '358px' });
  assert.equal(dash.fitWallWho(phone.root, data), 0);
  assert.equal(count(phone.html(), '"'), 4, 'auf einer Flaeche, die ohnehin scrollt, wird nichts gekuerzt');

  // Ein Hochformat-Tablett stapelt nur die Buehne; „Wer" und Wetter stehen
  // nebeneinander. Das ist kein Telefon.
  const portrait = makeWall(820, { columns: '720px', aside: '350px 350px' });
  assert.equal(dash.fitWallWho(portrait.root, data), dash.WALL_WHO_LADDER.length - 1);
  assert.ok(!portrait.html().includes('wall-who__task'), 'jede Zeile kostet Hoehe: die Reihe der Gesichter bleibt');

  // Ein Querformat-Tablett, das ohne Titel um ein paar Pixel zu hoch ist, ist
  // KEIN Telefon: die volle Liste schoebe Fuss und Ausgang weit aus dem Bild.
  const lowTablet = makeWall(820);
  assert.equal(dash.fitWallWho(lowTablet.root, data), dash.WALL_WHO_LADDER.length - 1);
  assert.ok(!lowTablet.html().includes('wall-who__task'), 'zweispaltig und zu hoch: die Reihe der Gesichter bleibt');

  // Ist die Flaeche aus einem ANDEREN Grund zu hoch (das Programm links: 845px),
  // stehen so viele Titel da, wie nichts kosten - hier fuenf Zeilen (600 + 5 * 40
  // = 800 <= 845), nicht null und nicht alle neun.
  const tallProgram = makeWall(600, { floor: 845 });
  dash.fitWallWho(tallProgram.root, data);
  const kept = count(tallProgram.html(), '[ "]');
  assert.ok(kept > 0, 'die Titel, die nichts kosten, bleiben');
  assert.equal(tallProgram.wall.scrollHeight, 845, 'die Flaeche ist nicht hoeher als ohne Titel');
  assert.equal(count(tallProgram.html(), '"'), 4, 'und zwar alle offenen');

  const none = makeWall(790);
  assert.equal(dash.fitWallWho(none.root, data), dash.WALL_WHO_LADDER.length - 1);
  assert.ok(!none.html().includes('wall-who__task'), 'ohne Platz bleibt die Reihe der Gesichter');
}));

// --------------------------------------------------------------------------
// 4. Verdrahtung: wer das Einpassen RUFT
// --------------------------------------------------------------------------

// Ein Fenster, das seine Hoerer wirklich fuehrt: `resize` laesst sich
// ausloesen, das Signal haengt ab, und das naechste Bild laeuft sofort.
function fakeWindow() {
  const listeners = [];
  const frames = [];
  return {
    innerHeight: 800,
    yuvomi: { isModuleDisabled: () => false },
    addEventListener(type, fn, options = {}) {
      const entry = { type, fn, options };
      listeners.push(entry);
      options.signal?.addEventListener('abort', () => listeners.splice(listeners.indexOf(entry), 1), { once: true });
    },
    // Das naechste Bild kommt NACH dem Ereignis, wie im Browser: `resize()`
    // loest erst die Hoerer aus und zeichnet dann.
    requestAnimationFrame(fn) { frames.push(fn); return frames.length; },
    cancelAnimationFrame() { frames.length = 0; },
    resize() {
      for (const entry of listeners.filter((l) => l.type === 'resize')) entry.fn();
      for (const fn of frames.splice(0)) fn();
    },
    count: (type) => listeners.filter((l) => l.type === type).length,
  };
}

const FIT_DATA = {
  users: [U(1, 'Anna'), U(2, 'Ben')],
  upcomingEvents: [], urgentTasks: [],
  wallTasks: [
    { user_id: 1, ...entry(['a1', 'a2', 'a3'], ['x1', 'x2']) },
    { user_id: 2, ...entry(['b1'], ['y1', 'y2', 'y3']) },
  ],
};

test('Verdrahtung: der Aufbau der Wand passt sie ein', onWall(() => {
  const controller = new AbortController();
  const win = fakeWindow();
  global.window = win;
  // Die Schale, in die `rebuildWall` baut: sie gibt die Wand zurueck, sobald
  // die Flaeche darin steht, und deren Hoehe haengt an den Zeilen.
  let wall = null;
  const shell = {
    replaceChildren() { wall = null; },
    insertAdjacentHTML(_pos, html) {
      const who = (/<section class="wall__who"[\s\S]*?<\/section>/.exec(html) || [])[0];
      assert.ok(who, 'Reichweite: die gebaute Flaeche traegt den Abschnitt');
      wall = fakeWall(who, 600);
    },
    querySelector: (selector) => (selector === '.wall' ? wall?.wall ?? null : null),
  };
  const container = { querySelector: () => null };
  const fit = dash.createWallFit(win, controller.signal);
  const step = dash.rebuildWall(container, shell, {
    data: FIT_DATA, weather: null, failed: false, updatedAt: null, rerender() {}, signal: controller.signal, fit,
  });
  assert.ok(step > 0, 'die zu hohe Flaeche wurde beim Aufbau eingepasst');
  assert.ok(wall.wall.scrollHeight <= 800, 'und passt danach ins Bild');
  controller.abort();
}));

test('Verdrahtung: ein Resize schrumpft die Wand UND laesst sie wieder wachsen', onWall(() => {
  const controller = new AbortController();
  const win = fakeWindow();
  global.window = win;
  const fit = dash.createWallFit(win, controller.signal);
  const wall = fakeWall(dash.renderWallWho(FIT_DATA, NO_ROWS), 300);

  assert.equal(fit.show(wall.root, FIT_DATA), 0, 'Vorbedingung: mit Platz steht alles da');
  const full = countTasks(wall.html(), '[ "]');

  wall.state.base = 600;        // das Fenster wird kleiner
  win.resize();
  const shrunk = countTasks(wall.html(), '[ "]');
  assert.ok(shrunk < full, `nach dem Verkleinern stehen weniger Zeilen (${shrunk} < ${full})`);
  assert.ok(wall.wall.scrollHeight <= 800);

  wall.state.base = 300;        // und wieder groesser
  win.resize();
  assert.equal(countTasks(wall.html(), '[ "]'), full, 'nach dem Vergroessern stehen wieder alle da');
  controller.abort();
}));

test('Verdrahtung: nach dem Verlassen der Seite haengt kein Hoerer mehr am Fenster', onWall(() => {
  const controller = new AbortController();
  const win = fakeWindow();
  global.window = win;
  const fit = dash.createWallFit(win, controller.signal);
  const wall = fakeWall(dash.renderWallWho(FIT_DATA, NO_ROWS), 300);
  fit.show(wall.root, FIT_DATA);
  assert.equal(win.count('resize'), 1, 'Vorbedingung: ein Hoerer');

  controller.abort();
  assert.equal(win.count('resize'), 0, 'der Hoerer faellt mit dem Signal der Seite');
  wall.state.base = 600;
  const before = wall.state.placed;
  win.resize();
  assert.equal(wall.state.placed, before, 'und nichts baut mehr an der verlassenen Flaeche');
}));

// --------------------------------------------------------------------------
// 5. Nachtabsenkung: jede Stimme der Liste geht mit
// --------------------------------------------------------------------------

test('Nacht: die Aufgaben unter den Gesichtern senken sich mit, der Haken gibt sein Gruen ab', async () => {
  const { readFileSync } = await import('node:fs');
  const { eachRule } = await import('./css-rules.js');
  const css = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  const rules = [...eachRule(css)];
  // Jede Klasse der Liste, die tags eine Farbe setzt, braucht nachts eine Stufe.
  const coloured = new Set();
  for (const rule of rules) {
    if (/data-wall-night/.test(rule.selector) || !/\bcolor\s*:/.test(rule.body.replace(/background(-color)?\s*:[^;]*;/g, ''))) continue;
    for (const [cls] of rule.selector.matchAll(/\.wall-who__(?:task|count--done)[\w-]*/g)) coloured.add(cls);
  }
  assert.ok(coloured.size >= 4, `nur ${coloured.size} farbtragende Klassen gelesen - misst der Filter noch? ${[...coloured]}`);
  const night = rules.filter((rule) => /data-wall-night/.test(rule.selector) && /\bcolor\s*:/.test(rule.body));
  const nightColour = (cls) => night
    .filter((rule) => rule.selector.split(',').some((part) => new RegExp(`${cls.replace('.', '\\.')}(?![\\w-])`).test(part)))
    .map((rule) => (/\bcolor\s*:\s*([^;]+);/.exec(rule.body) || [])[1]?.trim());
  const missing = [...coloured].filter((cls) => nightColour(cls).length === 0);
  assert.deepEqual(missing, [], `Klassen der Aufgabenliste ohne Nachtstufe: ${missing.join(', ')}`);
  assert.deepEqual(nightColour('.wall-who__task-check'), ['var(--color-text-tertiary)'], 'der Haken am Titel traegt nachts kein Gruen');
  assert.deepEqual(nightColour('.wall-who__count--done'), ['var(--color-text-tertiary)'], 'der Haken am Gesicht auch nicht');
  assert.deepEqual(nightColour('.wall-who__task'), ['var(--color-text-secondary)'], 'der offene Titel geht eine Stufe zurueck');
});

// --------------------------------------------------------------------------
// 6. Die Wand ist eine geteilte Flaeche: `audience=household`
// --------------------------------------------------------------------------

const { dashboardRequest, dashboardQueryFiltersCounts } = await import('../public/utils/dashboard-widgets.js');
const tzClient = await import('/utils/timezone.js');

async function overview(userId, query = '') {
  viewer = userId;
  const res = await fetch(`${base}/${query}`);
  assert.equal(res.status, 200);
  return res.json();
}

function addEvent(title, { start = '2026-10-08T18:00', end = '2026-10-08T19:00', visibility = 'all', createdBy = ANNA, assignees = [], subscription = null } = {}) {
  const id = Number(db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, visibility, created_by, subscription_id, external_source)
    VALUES (?, ?, ?, 0, ?, ?, ?, ?)
  `).run(title, start, end, visibility, createdBy, subscription, subscription ? 'ics' : 'local').lastInsertRowid);
  for (const userId of assignees) db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(id, userId);
  return id;
}
function addSubscription(name, { shared, createdBy }) {
  return Number(db.prepare('INSERT INTO ics_subscriptions (name, url, shared, created_by) VALUES (?, ?, ?, ?)')
    .run(name, `https://example.invalid/${randomUUID()}.ics`, shared ? 1 : 0, createdBy).lastInsertRowid);
}
function seedSharedSurface() {
  db.prepare('DELETE FROM calendar_events').run();
  db.prepare('DELETE FROM ics_subscriptions').run();
  addTask('Aufgabe fuer alle', BEN);
  addTask('Aufgabe nur Zugewiesene', BEN, { visibility: 'assignees', createdBy: BEN });
  addTask('Aufgabe privat', BEN, { visibility: 'private', createdBy: BEN });
  addTask('Erledigt nur Zugewiesene', BEN, { visibility: 'assignees', createdBy: BEN, status: 'done' });
  addEvent('Termin fuer alle', { assignees: [ANNA] });
  addEvent('Termin nur Zugewiesene', { visibility: 'assignees', createdBy: BEN, assignees: [BEN] });
  addEvent('Termin privat', { visibility: 'private', createdBy: BEN });
  addEvent('Aus Bens eigenem Abo', { subscription: addSubscription('Bens Dienstplan', { shared: false, createdBy: BEN }), createdBy: BEN });
  addEvent('Aus dem geteilten Abo', { subscription: addSubscription('Schulferien', { shared: true, createdBy: BEN }), createdBy: BEN });
}
const PRIVATE_TITLES = ['Aufgabe nur Zugewiesene', 'Aufgabe privat', 'Erledigt nur Zugewiesene',
  'Termin nur Zugewiesene', 'Termin privat', 'Aus Bens eigenem Abo'];
const eventTitles = (list) => (list ?? []).map((event) => event.title).sort();

test('Geteilte Flaeche: ohne den Parameter bleibt die Uebersicht persoenlich', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedSharedSurface();
  const mine = await overview(BEN);
  assert.deepEqual(titles(mine.urgentTasks).sort(), ['Aufgabe fuer alle', 'Aufgabe nur Zugewiesene', 'Aufgabe privat']);
  assert.deepEqual(eventTitles(mine.upcomingEvents),
    ['Aus Bens eigenem Abo', 'Aus dem geteilten Abo', 'Termin fuer alle', 'Termin nur Zugewiesene', 'Termin privat']);
  assert.equal(mine.openTaskCount, 3);
  assert.equal(mine.tasksDoneToday, 1);
}));

test('Geteilte Flaeche: die Haushaltsfassung traegt in KEINER Scheibe etwas Eingeschraenktes - auch nicht fuer die Besitzerin', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedSharedSurface();
  for (const who of [BEN, ANNA]) {
    const wall = await overview(who, '?audience=household');
    const label = who === BEN ? 'Sitzung des Besitzers' : 'Sitzung eines anderen Mitglieds';
    assert.deepEqual(titles(wall.urgentTasks), ['Aufgabe fuer alle'], label);
    assert.equal(wall.tasksDoneToday, 0, label);
    assert.deepEqual(wall.wallTasks.map((entry) => [entry.user_id, titles(entry.open)]), [[BEN, ['Aufgabe fuer alle']]], label);
    assert.deepEqual(eventTitles(wall.upcomingEvents), ['Aus dem geteilten Abo', 'Termin fuer alle'], label);
    // Was die Wand nicht zeichnet, kommt seit der Allowlist leer (Abschnitt 8):
    // die Zahlen der Kacheln, der Wochenstreifen, die Familienkarte.
    assert.equal(wall.openTaskCount, 0, label);
    assert.equal(wall.overdueTaskCount, 0, label);
    assert.deepEqual(wall.memberTodayTasks, [], label);
    assert.deepEqual(wall.weekEvents, [], label);
    assert.deepEqual(wall.familyEvents, [], label);
    const text = JSON.stringify([wall.urgentTasks, wall.upcomingEvents, wall.weekEvents, wall.familyEvents, wall.wallTasks]);
    for (const title of PRIVATE_TITLES) assert.ok(!text.includes(title), `${label}: „${title}" reist nicht mit`);
  }
}));

// Ein Parameter, der zweimal in der Adresse steht, kommt als LISTE an. Der
// Vergleich mit dem einen Wort fiel dann durch, und die Antwort war wieder die
// persoenliche - ein Schalter, der nur verengt, darf beim Stolpern nicht weiter
// oeffnen als verlangt.
test('Geteilte Flaeche: der Parameter gilt auch, wenn er doppelt in der Adresse steht', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedSharedSurface();
  const wall = await overview(BEN, '?audience=household&audience=household');
  assert.deepEqual(titles(wall.urgentTasks), ['Aufgabe fuer alle']);
  assert.equal(wall.openTaskCount, 0);
  assert.deepEqual(eventTitles(wall.upcomingEvents), ['Aus dem geteilten Abo', 'Termin fuer alle']);
  // Ein anderes Wort bleibt, was es war: keine Haushaltsfassung.
  assert.equal((await overview(BEN, '?audience=me')).openTaskCount, 3);
}));

test('Geteilte Flaeche: beide Fassungen sagen jedem Mitglied dasselbe', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedSharedSurface();
  const pick = (body) => [titles(body.urgentTasks), eventTitles(body.upcomingEvents), body.tasksDoneToday, body.wallTasks];
  assert.deepEqual(pick(await overview(BEN, '?audience=household')), pick(await overview(CLEO, '?audience=household')));
}));

test('Geteilte Flaeche: „nur meine" gilt an der Wand nicht - sie ist niemandes', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedSharedSurface();
  const personal = await overview(BEN, '?events_scope=mine');
  assert.deepEqual(eventTitles(personal.upcomingEvents), ['Termin nur Zugewiesene'], 'Vorbedingung: persoenlich greift die Auswahl');
  const wall = await overview(BEN, '?events_scope=mine&audience=household');
  assert.deepEqual(eventTitles(wall.upcomingEvents), ['Aus dem geteilten Abo', 'Termin fuer alle']);
}));

test('Geteilte Flaeche: die gebaute Wand zeigt nichts davon, und wer nur darueber dran waere, steht nicht unter den Gesichtern', async () => {
  let wall;
  let personal;
  await withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
    db.prepare('DELETE FROM calendar_events').run();
    db.prepare('DELETE FROM ics_subscriptions').run();
    // Ben ist NUR ueber Eingeschraenktes dran, Cleo ueber etwas fuer alle.
    addTask('Geheime Aufgabe', BEN, { visibility: 'assignees', createdBy: BEN });
    addEvent('Geheimer Termin', { visibility: 'assignees', createdBy: BEN, assignees: [BEN] });
    addTask('Tisch decken', CLEO);
    wall = await overview(BEN, '?audience=household');
    personal = await overview(BEN);
  })();
  await onWall(() => {
    mock.timers.enable({ apis: ['Date'], now: new Date(NOON_BERLIN) });
    tzClient.setDisplayTimeZone('Europe/Berlin');
    try {
      const now = new Date();
      const before = dash.renderWallSurface(personal, null, { now });
      assert.ok(before.includes('Geheime Aufgabe') && before.includes('Geheimer Termin'),
        'Reichweite: aus der persoenlichen Antwort gebaut, stuende beides an der Wand');
      const html = dash.renderWallSurface(wall, null, { now });
      assert.match(html, /Tisch decken/, 'Reichweite: die Wand ist gebaut und zeigt, was alle sehen duerfen');
      assert.ok(!html.includes('Geheime Aufgabe'), 'die eingeschraenkte Aufgabe steht an keiner Stelle der Wand');
      assert.ok(!html.includes('Geheimer Termin'), 'der eingeschraenkte Termin auch nicht');
      const who = (/<section class="wall__who"[\s\S]*?<\/section>/.exec(html) || [''])[0];
      assert.match(who, /Cleo/);
      assert.ok(!who.includes('Ben'), 'wer nur ueber Eingeschraenktes dran waere, erscheint nicht unter den Gesichtern');
    } finally {
      tzClient.setDisplayTimeZone(null);
      mock.timers.reset();
    }
  })();
});

test('Geteilte Flaeche: die Wand fragt die Haushaltsfassung ab, die Uebersicht nicht', async () => {
  assert.equal(dashboardRequest('/dashboard', { wall: true }), '/dashboard?audience=household');
  assert.equal(dashboardRequest('/dashboard?tasks_category=school', { wall: true }), '/dashboard?tasks_category=school&audience=household');
  assert.equal(dashboardRequest('/dashboard?events_scope=mine', { wall: false }), '/dashboard?events_scope=mine');
  assert.equal(dashboardRequest('/dashboard'), '/dashboard');
  // Die Zahlen der Haushaltsfassung sind nicht die der Person: sie gelten dem
  // Speicher der Navigations-Badges als gefiltert und werden dort nie angenommen.
  assert.equal(dashboardQueryFiltersCounts(dashboardRequest('/dashboard', { wall: true })), true);
  assert.equal(dashboardQueryFiltersCounts(dashboardRequest('/dashboard?events_limit=8', { wall: true })), true);
  assert.equal(dashboardQueryFiltersCounts(dashboardRequest('/dashboard', { wall: false })), false);
  // JEDER Abruf der Seite geht durch diese eine Stelle - auch der stille
  // Refresh, sonst stuende nach einer Viertelstunde wieder die persoenliche
  // Fassung an der Wand.
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const calls = [...page.matchAll(/api\.get\(([^\n]*(?:dashboardQuery|layoutHintQuery)[^\n]*)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 4, `nur ${calls.length} Abrufe der Uebersicht gefunden - misst der Leser noch?`);
  const bare = calls.filter((call) => !call.startsWith('overviewRequest('));
  assert.deepEqual(bare, [], 'Abruf der Uebersicht an `overviewRequest` vorbei');
  assert.match(page, /const overviewRequest = \(query\) => dashboardRequest\(query, \{ wall: wallMode \}\);/);
});

// --------------------------------------------------------------------------
// 7. Die Wand laesst persoenliche Beitraege weg - wie das Display
// --------------------------------------------------------------------------
//
// #1838 hat Aufgaben und Termine auf „was jeder sehen darf" gestellt. Uebrig
// blieben die Beitraege zum Tagesprogramm, die keinem Sichtbarkeitsfeld folgen,
// sondern dem BETRACHTER gelten: die eigene Dosis, die eigene Schicht, die
// eigene Erinnerung, die Freigaben, die nur ein Admin entscheidet. Ein
// gekoppeltes Display bekam sie nie, eine Wand aus der Sitzung eines Mitglieds
// schon (gemessen an der Demo-Saat: „2 zu bestaetigen" und „Eisen 20:00").

const DISPLAY = addUser('Wandtablett');

async function reminders(userId, query = '') {
  viewer = userId;
  const res = await fetch(`${base}/reminders/pending${query}`);
  assert.equal(res.status, 200);
  return (await res.json()).data;
}
async function asCoupledDisplay(fn) {
  asDisplay = true;
  try { return await fn(); } finally { asDisplay = false; }
}

function seedPersonal() {
  for (const table of ['reminders', 'medication_schedules', 'medications', 'schedule_extra_shifts',
    'schedule_shift_types', 'reward_redemptions', 'reward_participants', 'calendar_events', 'ics_subscriptions']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  // Der Haushalt dieser Tests nutzt jedes Modul: ab Werk ist der Schichtplan
  // abgeschaltet, und eine Schicht, die gar nicht erst geliefert wird, kann
  // nicht zeigen, dass die Wand sie weglaesst.
  db.prepare(`
    INSERT INTO sync_config (key, value) VALUES ('disabled_modules', '[]')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run();
  // Etwas fuer alle - die Wand ist nie leer, und Cleo ist darueber dran.
  addTask('Tisch decken', CLEO);
  // Bens Dosis heute Abend.
  const med = db.prepare("INSERT INTO medications (user_id, name, active, visibility) VALUES (?, 'Eisen', 1, 'private')").run(BEN).lastInsertRowid;
  db.prepare("INSERT INTO medication_schedules (medication_id, time_of_day, days_mask, active) VALUES (?, '20:00', NULL, 1)").run(med);
  // Bens Schicht heute.
  const shift = db.prepare(`
    INSERT INTO schedule_shift_types (name, short_code, start_time, end_time, color, created_by)
    VALUES ('Fruehdienst', 'F', '06:00', '14:00', '#00668F', ?)
  `).run(ANNA).lastInsertRowid;
  db.prepare('INSERT INTO schedule_extra_shifts (user_id, date_key, shift_type_id, created_by) VALUES (?, ?, ?, ?)')
    .run(BEN, '2026-10-08', shift, ANNA);
  // Bens Erinnerung an eine Aufgabe, die JEDER sehen darf und die heute nicht
  // im Programm steht: die Aufgabe ist Haushaltssache, die Erinnerung ist seine.
  const later = addTask('Steuer abgeben', BEN, { due: '2026-10-20' });
  db.prepare('INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES (?, ?, ?, ?)')
    .run('task', later, '2026-10-08T06:00:00Z', BEN);
  // Cleo sammelt Punkte und wartet auf eine Praemie und eine Auszahlung; Anna (Admin) gibt frei.
  db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(CLEO);
  db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(BEN);
  db.prepare("INSERT INTO reward_redemptions (user_id, reward_name, cost, status) VALUES (?, 'Kinoabend', 10, 'pending')").run(CLEO);
  db.prepare("INSERT INTO reward_redemptions (user_id, reward_name, cost, status, kind, currency) VALUES (?, 'Auszahlung', 5, 'pending', 'withdrawal', 'EUR')").run(CLEO);
}
const PERSONAL_WORDS = ['Eisen', 'Fruehdienst', 'Steuer abgeben', 'Kinoabend'];
/** Der Programmteil der gebauten Wand und die Gesichter - ohne Uhr und Fuss. */
function wallParts(body) {
  const html = dash.renderWallSurface(body, null, { now: new Date() });
  const cut = (name) => (new RegExp(`<section class="wall__${name}"[\\s\\S]*?</section>`).exec(html) || [''])[0];
  return { html, program: cut('program'), who: cut('who') };
}
function onWallAt(iso, fn) {
  return onWall(() => {
    mock.timers.enable({ apis: ['Date'], now: new Date(iso) });
    tzClient.setDisplayTimeZone('Europe/Berlin');
    try { return fn(); } finally { tzClient.setDisplayTimeZone(null); mock.timers.reset(); }
  });
}

test('Persoenliches: ohne den Parameter bleibt die Uebersicht persoenlich', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedPersonal();
  const ben = await overview(BEN);
  assert.equal(ben.health.dosesTotal, 1);
  assert.deepEqual(ben.health.nextDose, { name: 'Eisen', time: '20:00' });
  assert.deepEqual(ben.myShiftsToday.map((entry) => entry.shift_type.name), ['Fruehdienst']);
  assert.deepEqual((await reminders(BEN)).map((row) => row.entity_title), ['Steuer abgeben']);
  const anna = await overview(ANNA);
  assert.equal(anna.rewards.view, 'approver');
  assert.equal(anna.rewards.pending, 1);
  assert.equal(anna.rewards.moneyPending, 1);
  const cleo = await overview(CLEO);
  assert.equal(cleo.rewards.view, 'self');
  assert.equal(cleo.rewards.pending, 1);
  assert.deepEqual(cleo.rewards.standings.map((row) => row.id), [CLEO], 'Vorbedingung: ein Kind bekommt nur die eigene Zeile');
}));

test('Persoenliches: die Haushaltsfassung traegt es gar nicht - auch nicht fuer die Person, der es gilt', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedPersonal();
  const display = await asCoupledDisplay(() => overview(DISPLAY));
  assert.equal(display.health.dosesTotal, 0, 'Massstab: ein Display bekommt keine Dosen');
  assert.deepEqual(display.myShiftsToday, [], 'Massstab: und keine Schicht');
  for (const [who, label] of [[BEN, 'Ben, dem Dosis, Schicht und Erinnerung gelten'], [ANNA, 'Anna, die freigibt'], [CLEO, 'Cleo, die wartet']]) {
    const wall = await overview(who, '?audience=household');
    assert.deepEqual(wall.health, display.health, `${label}: Dosen in der leeren Fassung des Displays`);
    assert.deepEqual(wall.fasting, display.fasting, label);
    assert.deepEqual(wall.nutrition, display.nutrition, label);
    assert.deepEqual(wall.myShiftsToday, [], `${label}: keine Schicht`);
    assert.equal(wall.rewards.view, null, `${label}: keine Sicht auf Belohnungen`);
    assert.equal(wall.rewards.pending, 0, `${label}: keine wartende Praemie`);
    // Als ZAHL, wie in jeder anderen Fassung der Scheibe - die leere Form
    // liess das Feld aus (Codex an #1900).
    assert.equal(wall.rewards.moneyPending, 0, `${label}: keine wartende Auszahlung`);
    // Der Parameter verengt nur: aus der Sitzung eines Kindes oeffnet er nicht
    // die Zeilen der Geschwister, die die Sicht `self` zurueckhaelt.
    assert.deepEqual(wall.rewards.standings, [], `${label}: keine Staende`);
    assert.deepEqual(wall.rewards.recent, [], label);
    assert.deepEqual(await reminders(who, '?audience=household'), [], `${label}: keine Erinnerung`);
    const text = JSON.stringify(wall);
    for (const word of ['Eisen', 'Fruehdienst', 'Kinoabend']) assert.ok(!text.includes(word), `${label}: „${word}" reist nicht mit`);
    assert.ok(titles(wall.urgentTasks).includes('Tisch decken'), `${label}: Reichweite - was alle sehen duerfen, steht da`);
  }
}));

test('Persoenliches: auch die Erinnerungen fallen bei doppeltem Parameter nicht auf die persoenliche Fassung zurueck', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedPersonal();
  assert.deepEqual(await reminders(BEN, '?audience=household&audience=household'), []);
  assert.equal((await overview(BEN, '?audience=household&audience=household')).health.dosesTotal, 0);
  // Ein anderes Wort bleibt, was es war.
  assert.equal((await reminders(BEN, '?audience=me')).length, 1);
  assert.equal((await overview(BEN, '?audience=me')).health.dosesTotal, 1);
}));

test('Persoenliches: das Display bekommt, was es bekam', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedPersonal();
  const display = await asCoupledDisplay(() => overview(DISPLAY));
  // Belohnungen sind eines der Module, die ein Display lesen darf: seine
  // normale Uebersicht behaelt die Sicht `family`, ohne fremde Anfragen.
  assert.equal(display.rewards.view, 'family');
  assert.equal(display.rewards.pending, 0);
  assert.equal(display.rewards.moneyPending, 0);
  assert.deepEqual(display.rewards.standings.map((row) => row.id).sort(), [BEN, CLEO].sort());
  assert.ok(titles(display.urgentTasks).includes('Tisch decken'));
}));

test('Persoenliches: die Wand ist aus jeder Sitzung dieselbe wie auf dem Display, die Uebersicht bleibt persoenlich', async () => {
  const personal = {};
  const wall = {};
  let wallReminders;
  let ownReminders;
  await withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
    seedPersonal();
    for (const [name, id] of [['ben', BEN], ['anna', ANNA], ['cleo', CLEO]]) {
      personal[name] = await overview(id);
      wall[name] = await overview(id, '?audience=household');
    }
    wall.display = await asCoupledDisplay(() => overview(DISPLAY, '?audience=household'));
    ownReminders = await reminders(BEN);
    wallReminders = await reminders(BEN, '?audience=household');
  })();
  await onWallAt(NOON_BERLIN, () => {
    // REICHWEITE: aus der persoenlichen Antwort gebaut, stuende es an der Wand.
    const before = wallParts({ ...personal.ben, pendingReminders: ownReminders });
    for (const word of ['Eisen', 'Fruehdienst', 'Steuer abgeben']) {
      assert.ok(before.program.includes(word), `Reichweite: persoenlich gebaut stuende „${word}" im Programm`);
    }
    assert.match(wallParts(personal.anna).program, /wall-row--rewards/, 'Reichweite: persoenlich gebaut stuende die Freigabe im Programm');

    const shown = wallParts({ ...wall.ben, pendingReminders: wallReminders });
    assert.match(shown.program, /Tisch decken/, 'Reichweite: die Wand ist gebaut');
    for (const word of PERSONAL_WORDS) assert.ok(!shown.html.includes(word), `„${word}" steht an keiner Stelle der Wand`);
    for (const tone of ['health', 'schedule', 'rewards']) {
      assert.ok(!shown.program.includes(`wall-row--${tone}`), `keine Zeile im Ton ${tone}`);
    }
    // EINE WAND: wer sie oeffnet, aendert nichts an ihr.
    for (const name of ['anna', 'cleo', 'display']) {
      const other = wallParts({ ...wall[name], pendingReminders: [] });
      assert.equal(other.program, shown.program, `Programm aus der Sitzung „${name}" ist dasselbe`);
      assert.equal(other.who, shown.who, `„Wer heute dran ist" aus der Sitzung „${name}" ist dasselbe`);
    }
  })();
});

test('Persoenliches: genommene Dosen machen aus einem freien Tag an der Wand kein „Alles erledigt"', async () => {
  let personal;
  let wall;
  await withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
    seedPersonal();
    db.prepare('DELETE FROM tasks').run();
    db.prepare('DELETE FROM reminders').run();
    db.prepare('DELETE FROM schedule_extra_shifts').run();
    const med = db.prepare("SELECT id FROM medications WHERE name = 'Eisen'").get().id;
    db.prepare("INSERT INTO medication_logs (medication_id, scheduled_at, status) VALUES (?, '2026-10-08T20:00', 'taken')").run(med);
    personal = await overview(BEN);
    wall = await overview(BEN, '?audience=household');
    db.prepare('DELETE FROM medication_logs').run();
  })();
  assert.equal(personal.health.dosesTaken, 1, 'Vorbedingung: die Dosis ist genommen');
  await onWallAt(NOON_BERLIN, () => {
    assert.match(wallParts(personal).program, /check-circle/, 'Reichweite: persoenlich gebaut sagte die Wand „Alles erledigt"');
    const program = wallParts(wall).program;
    assert.ok(!program.includes('check-circle'), 'die Wand sagt es nicht ueber die Dosen einer Person');
    assert.match(program, /sparkles/, 'sie sagt „Heute frei"');
  })();
});

test('Persoenliches: die Erinnerungen der Seite gehen durch dieselbe Stelle wie die Uebersicht', async () => {
  const asked = [];
  const get = async (path) => { asked.push(path); return { data: [{ id: 1 }] }; };
  assert.deepEqual(await dash.loadPendingReminders((path) => dashboardRequest(path, { wall: true }), get), [{ id: 1 }]);
  assert.deepEqual(await dash.loadPendingReminders((path) => dashboardRequest(path, { wall: false }), get), [{ id: 1 }]);
  assert.deepEqual(asked, ['/reminders/pending?audience=household', '/reminders/pending']);
  // Und die Seite reicht an BEIDEN Stellen ihre eine Regel herein - der stille
  // Refresh braechte sonst nach einer Viertelstunde die Erinnerungen zurueck.
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const calls = [...page.matchAll(/(?<!function )loadPendingReminders\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 2, `nur ${calls.length} Aufrufe gefunden - misst der Leser noch?`);
  assert.deepEqual(calls.filter((args) => args !== 'overviewRequest'), [], 'Erinnerungen an `overviewRequest` vorbei geladen');
});

// Die Glocke der Shell pollt denselben Endpunkt jede Minute und macht aus einer
// faelligen Erinnerung einen Toast (30 s) und eine Browser-Benachrichtigung -
// ueber der Wand eines Mitglieds stuende damit doch wieder, was nur ihm gilt
// (Codex an #1900). Ein gekoppeltes Display pollt gar nicht. Gemessen gegen die
// ECHTE Route: der Stub reicht die Anfrage der Glocke an den Server durch.
test('Persoenliches: die Glocke der Shell fragt ueber einer Wand die Haushaltsfassung ab - kein Toast, keine Benachrichtigung', async () => {
  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.style = { setProperty() {} }; this.classList = { add() {} }; }
    appendChild(child) { this.children.push(child); return child; }
    setAttribute(name, value) { this[name] = value; }
    addEventListener() {}
    querySelectorAll() { return []; }
    remove() {}
  }
  const surface = new El('div');
  const notifications = [];
  class FakeNotification {
    static permission = 'granted';
    constructor(title, options) { notifications.push({ title, options }); }
  }
  const asked = [];
  const store = new Map();
  const saved = {};
  const realSetTimeout = globalThis.setTimeout;
  const timers = [];
  const globals = {
    document: { createElement: (tag) => new El(tag), createElementNS: (_ns, tag) => new El(tag), getElementById: () => surface, querySelectorAll: () => [], documentElement: { hasAttribute: () => false } },
    window: { Notification: FakeNotification, yuvomi: {} },
    Notification: FakeNotification,
    localStorage: { getItem: (key) => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key) },
    location: { pathname: '/' },
    setInterval: () => 2,
    clearInterval: () => {},
    // Der Toast raeumt sich nach 30 s selbst ab - der Timer hielte den Prozess
    // so lange offen und liefe dann in abgebaute Globals. Er laeuft echt (die
    // Anfragen an die Route brauchen ihre eigenen) und wird am Ende geloescht.
    setTimeout: (...args) => { const handle = realSetTimeout(...args); timers.push(handle); return handle; },
  };
  for (const [name, value] of Object.entries(globals)) {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const bell = await import('../public/reminders.js');
  try {
    await withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
      seedPersonal();
      viewer = BEN;
      globalThis.__apiStub = {
        get: async (path) => { asked.push(path); return (await fetch(`${base}${path}`)).json(); },
      };
      // An der Wand: Schalter an, Route der Uebersicht.
      store.set('yuvomi-wall-mode', '1');
      bell.init();
      await settle();
      assert.deepEqual(asked, ['/reminders/pending?audience=household']);
      assert.equal(surface.children.length, 0, 'kein Toast ueber der Wand');
      assert.equal(notifications.length, 0, 'keine Browser-Benachrichtigung');

      // Dieselbe Sitzung auf einer anderen Seite: der Schalter allein macht keine Wand.
      globalThis.location.pathname = '/tasks';
      bell.refresh();
      await settle();
      assert.equal(asked.at(-1), '/reminders/pending');
      assert.equal(surface.children.length, 1, 'Reichweite: ausserhalb der Wand kommt der Toast - und er war nicht als gezeigt verbucht');
      assert.equal(notifications.at(-1)?.options.body, 'Steuer abgeben');

      // Und ohne den Schalter auf der Uebersicht ebenso persoenlich.
      store.delete('yuvomi-wall-mode');
      globalThis.location.pathname = '/';
      bell.refresh();
      await settle();
      assert.equal(asked.at(-1), '/reminders/pending');

      // EINE PERSOENLICHE ANTWORT, DIE UNTERWEGS WAR, ALS DIE WAND AUFGING
      // (Codex an #1900, zweite Runde): gefragt auf /tasks, angekommen ueber
      // der Wand. Sie wird verworfen und nicht als gezeigt verbucht.
      bell.stop();
      surface.children.length = 0;
      notifications.length = 0;
      store.set('yuvomi-wall-mode', '1');
      globalThis.location.pathname = '/tasks';
      const direct = globalThis.__apiStub.get;
      globalThis.__apiStub.get = async (path) => {
        const answer = await direct(path);
        globalThis.location.pathname = '/';
        return answer;
      };
      bell.refresh();
      await settle();
      assert.equal(asked.at(-1), '/reminders/pending', 'Reichweite: gefragt wurde persoenlich');
      assert.equal(surface.children.length, 0, 'die unterwegs gewesene Antwort wird ueber der Wand kein Toast');
      assert.equal(notifications.length, 0);
      globalThis.__apiStub.get = direct;
      globalThis.location.pathname = '/tasks';
      bell.refresh();
      await settle();
      assert.equal(surface.children.length, 1, 'und sie war nicht verbraucht: zurueck auf der Seite kommt der Toast');
    })();
  } finally {
    bell.stop();
    for (const handle of timers) clearTimeout(handle);
    delete globalThis.__apiStub;
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

// --------------------------------------------------------------------------
// 8. ALLOWLIST: die Haushaltsfassung traegt nur, was die Wand zeichnet
// --------------------------------------------------------------------------
//
// #1838 und #1900 liessen bestimmte Module aus und alles andere durch - eine
// Denylist. Gemessen trug die Haushaltsfassung weiter angepinnte Notizen, das
// Budget, den Stand geteilter Ausgaben, Schnellzugriffe, Countdowns und den
// offenen Lohn der Haushaltshilfe: nichts davon zeichnet die Wand, alles davon
// lag auf dem Geraet. Jetzt gilt die Umkehrung, und diese Tests messen sie an
// der ECHTEN Route.

const visibility = await import('../server/services/visibility.js');

const HELGA = addUser('Helga');
let SHOPPING_LIST = null;

function seedWallSources() {
  seedPersonal();
  for (const table of ['notes', 'budget_entries', 'expense_ledger_entries', 'expense_group_members', 'expense_groups',
    'quick_links', 'housekeeping_work_sessions', 'housekeeping_workers', 'meals', 'shopping_items', 'shopping_lists',
    'waste_one_off_pickups', 'waste_types', 'pantry_items', 'birthdays']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  // WAS DIE WAND NICHT ZEICHNET.
  db.prepare("INSERT INTO notes (title, content, pinned, created_by) VALUES ('Kontonummer Sparbuch', 'DE00 1234', 1, ?)").run(ANNA);
  db.prepare("INSERT INTO budget_entries (title, amount, category, date, created_by) VALUES ('Gehalt', 4321.09, 'salary', '2026-10-05', ?)").run(ANNA);
  const group = db.prepare("INSERT INTO expense_groups (name, type, default_currency, created_by) VALUES ('Zuhause', 'general', 'EUR', ?)").run(ANNA).lastInsertRowid;
  for (const [userId, role] of [[ANNA, 'owner'], [BEN, 'admin']]) {
    db.prepare('INSERT INTO expense_group_members (group_id, user_id, role, invited_by) VALUES (?, ?, ?, ?)').run(group, userId, role, ANNA);
  }
  db.prepare(`
    INSERT INTO expense_ledger_entries (group_id, source_type, source_id, user_id, counterparty_id, amount_minor, currency, memo, created_by)
    VALUES (?, 'expense', 1, ?, ?, 98765, 'EUR', 'Pizzaabend', ?)
  `).run(group, ANNA, BEN, ANNA);
  db.prepare("INSERT INTO quick_links (name, url, visibility, created_by, position) VALUES ('Bankportal', 'https://bank.example/login', 'private', ?, 0)").run(ANNA);
  const countdown = addTask('Urlaub in Sicht', BEN, { due: '2026-10-20' });
  db.prepare('UPDATE tasks SET countdown = 1 WHERE id = ?').run(countdown);
  // Die Haushaltshilfe: ein bezahlbarer Besuch vom Dienstag (Geld), und heute da (Programm).
  const worker = db.prepare('INSERT INTO housekeeping_workers (user_id, daily_rate) VALUES (?, 87.5)').run(HELGA).lastInsertRowid;
  db.prepare("INSERT INTO housekeeping_work_sessions (check_in, check_out, daily_rate, worker_id, created_by) VALUES ('2026-10-06T07:00:00Z', '2026-10-06T11:00:00Z', 87.5, ?, ?)").run(worker, ANNA);
  db.prepare("INSERT INTO housekeeping_work_sessions (check_in, daily_rate, worker_id, created_by) VALUES ('2026-10-08T07:00:00Z', 87.5, ?, ?)").run(worker, ANNA);
  // WAS DIE WAND ZEICHNET.
  db.prepare("INSERT INTO meals (date, meal_type, title, created_by) VALUES ('2026-10-08', 'lunch', 'Linsensuppe', ?)").run(ANNA);
  SHOPPING_LIST = Number(db.prepare("INSERT INTO shopping_lists (name, created_by) VALUES ('Wochenmarkt', ?)").run(ANNA).lastInsertRowid);
  db.prepare("INSERT INTO shopping_items (list_id, name) VALUES (?, 'Tomaten')").run(SHOPPING_LIST);
  const bin = db.prepare("INSERT INTO waste_types (name, color, created_by) VALUES ('Biotonne', '#2E7D32', ?)").run(ANNA).lastInsertRowid;
  db.prepare("INSERT INTO waste_one_off_pickups (type_id, date, created_by) VALUES (?, '2026-10-08', ?)").run(bin, ANNA);
  db.prepare("INSERT INTO pantry_items (name, quantity, unit, expires_on, created_by) VALUES ('Joghurt', 1, 'Becher', '2026-10-08', ?)").run(ANNA);
  db.prepare("INSERT INTO birthdays (name, birth_date, created_by) VALUES ('Oma Erna', '1950-10-08', ?)").run(ANNA);
  addEvent('Elternabend', { assignees: [ANNA] });
}
/** Woerter und Zahlen, die an keiner Wand etwas verloren haben - als Text gesucht. */
const OFF_WALL_WORDS = ['Sparbuch', 'DE00 1234', '4321', '98765', 'Bankportal', 'bank.example', '87.5'];
const householdQuery = () => `?audience=household&shopping_list=${SHOPPING_LIST}`;

test('Allowlist: ohne den Parameter traegt die Antwort all das weiter (Reichweite der Saat)', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedWallSources();
  const anna = await overview(ANNA, `?shopping_list=${SHOPPING_LIST}`);
  assert.deepEqual(titles(anna.pinnedNotes), ['Kontonummer Sparbuch']);
  assert.equal(anna.pinnedNotesCount, 1);
  assert.equal(anna.notesTotal, 1);
  assert.equal(anna.budget.income, 4321.09);
  assert.equal(anna.budget.entryCount, 1);
  assert.ok(anna.splitBalance.net.length > 0, 'ein offener Stand geteilter Ausgaben');
  assert.deepEqual(anna.quicklinks.map((link) => link.name), ['Bankportal']);
  assert.deepEqual(titles(anna.countdowns), ['Urlaub in Sicht']);
  assert.equal(anna.countdownTotal, 1);
  assert.equal(anna.housekeeping.unpaidAmount, 87.5);
  assert.equal(anna.housekeeping.visitsThisMonth, 1);
  assert.ok(anna.housekeeping.lastVisit);
  assert.ok(anna.shoppingTile, 'die Auswahl der Einkaufs-Kachel');
  assert.ok(anna.openTaskCount > 0);
  assert.ok(anna.weekEvents.length > 0);
  assert.ok(anna.familyEvents.length > 0);
  assert.ok(anna.birthdayTotal > 0);
  const text = JSON.stringify(anna);
  for (const word of OFF_WALL_WORDS) assert.ok(text.includes(word), `Reichweite: „${word}" steht in der persoenlichen Antwort`);
}));

test('Allowlist: die Haushaltsfassung traegt nichts, was die Wand nicht zeichnet - nicht als Text, nicht als Zahl', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedWallSources();
  // DER MASSSTAB FUER „LEER": ein gekoppeltes Display hat weder Notizen noch
  // Budget, Haushaltshilfe, Vorrat oder Einkauf - es bekommt von der Route die
  // Fassung eines Kontos ohne das Modulrecht.
  const denied = await asCoupledDisplay(() => overview(DISPLAY));
  for (const who of [ANNA, BEN, CLEO]) {
    const personal = await overview(who, `?shopping_list=${SHOPPING_LIST}`);
    const wall = await overview(who, householdQuery());
    const text = JSON.stringify(wall);
    for (const word of OFF_WALL_WORDS) assert.ok(!text.includes(word), `Sitzung ${who}: „${word}" reist nicht mit`);

    for (const key of ['pinnedNotes', 'pinnedNotesCount', 'notesTotal', 'budget', 'splitBalance', 'shoppingLists',
      'shoppingOpenLists', 'health', 'fasting', 'nutrition', 'myShiftsToday']) {
      assert.deepEqual(wall[key], denied[key], `Sitzung ${who}: „${key}" in der Fassung eines Kontos ohne das Modulrecht`);
    }
    assert.deepEqual(wall.rewards, { view: null, standings: [], participantCount: 0, pending: 0, moneyPending: 0, catalog: [], recent: [] });
    // Was keinem Modul gehoert.
    assert.deepEqual(wall.countdowns, []);
    assert.equal(wall.countdownTotal, 0);
    assert.deepEqual(wall.quicklinks, []);
    assert.ok(!('shoppingTile' in wall), 'die Kachel-Auswahl fehlt, wie bei einem Konto ohne den Einkauf');
    // Scheiben erlaubter Module, die die Wand nicht zeichnet.
    assert.deepEqual(wall.familyEvents, []);
    assert.deepEqual(wall.weekEvents, []);
    assert.deepEqual(wall.memberTodayTasks, []);
    assert.equal(wall.openTaskCount, 0);
    assert.equal(wall.overdueTaskCount, 0);
    assert.equal(wall.birthdayCount, 0);
    assert.equal(wall.birthdayTotal, 0);
    assert.equal(wall.birthdaySoonCount, 0);
    // FELDER in einer erlaubten Scheibe: die Anwesenheit steht im Programm,
    // der offene Lohn nicht.
    assert.deepEqual(wall.housekeeping, {
      ...denied.housekeeping, present: true, presentSince: '2026-10-08T07:00:00Z', workerName: 'Helga',
    });
    assert.deepEqual(wall.pantryExpiring, {
      ...denied.pantryExpiring, todayItems: personal.pantryExpiring.todayItems, todayCount: 1,
    });
    assert.deepEqual(wall.pantryExpiring.todayItems.map((item) => item.name), ['Joghurt']);

    // KEIN FEHLENDER SCHLUESSEL: die Form der Antwort bleibt.
    assert.deepEqual(Object.keys(wall).sort(), Object.keys(personal).filter((key) => key !== 'shoppingTile').sort());
    for (const key of ['housekeeping', 'pantryExpiring', 'budget', 'rewards', 'health']) {
      const own = Object.keys(personal[key]).filter((field) => !(key === 'rewards' && field === 'me')).sort();
      assert.deepEqual(Object.keys(wall[key]).sort(), own, `„${key}" behaelt seine Felder`);
    }
  }
}));

/* DIE ZWEITE HAELFTE DES DRIFT-GUARDS, VON HAND GEFUEHRT: was die Route liefert
 * und die Wand bewusst leer bekommt. Die Schluessel der Antwort kommen unten
 * aus der ECHTEN Route und nicht aus einer Konstante des Servers - ein neues
 * Feld der Uebersicht steht dann in keiner der beiden Listen, und der Test ist
 * rot, bis jemand entschieden hat, ob eine Wand es zeigt. */
const DELIBERATELY_EMPTY_ON_THE_WALL = Object.freeze({
  // Kalender: die Familienkarte, der Wochenstreifen und die Zahlen der Kachel.
  familyEvents: 'calendar', weekEvents: 'calendar',
  birthdayCount: 'calendar', birthdayTotal: 'calendar', birthdaySoonCount: 'calendar',
  // Aufgaben: Kennzahlen der Kacheln und der Navigation.
  openTaskCount: 'tasks', overdueTaskCount: 'tasks', memberTodayTasks: 'tasks',
  // Einkauf: die Wand nennt nur die Zahl der offenen Artikel.
  shoppingLists: 'shopping', shoppingOpenLists: 'shopping', shoppingTile: 'shopping',
  pinnedNotes: 'notes', pinnedNotesCount: 'notes', notesTotal: 'notes',
  // Geld steht an keiner Wand.
  budget: 'budget', splitBalance: 'budget',
  // Was nur dem Betrachter gilt (#1900).
  rewards: 'rewards', health: 'health', fasting: 'health', nutrition: 'health', myShiftsToday: 'schedule',
  // Keinem Modul zugeordnet: nach der anfragenden Person geschnitten.
  countdowns: null, countdownTotal: null, quicklinks: null,
});
const DELIBERATELY_EMPTY_FIELDS = Object.freeze({
  housekeeping: ['configured', 'visitsThisMonth', 'unpaidAmount', 'lastVisit'],
  pantryExpiring: ['items', 'total', 'expiredCount'],
});

test('Drift: jeder Schluessel, den die Route liefert, ist entschieden - gezeichnet oder bewusst leer', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedWallSources();
  const shows = visibility.HOUSEHOLD_AUDIENCE_SHOWS;
  assert.ok(shows && typeof shows === 'object', 'die Allowlist der Wand-Quellen ist benannt und exportiert');
  // Die volle Antwort: Admin, jedes Modul an, jede Quelle belegt, mit der Auswahl
  // der Einkaufs-Kachel (ihr Feld gibt es nur dann).
  const real = await overview(ANNA, `?shopping_list=${SHOPPING_LIST}`);
  const delivered = Object.keys(real).sort();
  assert.ok(delivered.length >= 30, `Reichweite: die Route liefert ihre Schluessel (${delivered.length})`);

  const undecided = delivered.filter((key) => !(key in shows) && !(key in DELIBERATELY_EMPTY_ON_THE_WALL));
  assert.deepEqual(undecided, [], 'neuer Schluessel in GET /dashboard: zeichnet die Wand ihn (HOUSEHOLD_AUDIENCE_SHOWS) oder bleibt er leer (diese Liste)?');
  const both = delivered.filter((key) => key in shows && key in DELIBERATELY_EMPTY_ON_THE_WALL);
  assert.deepEqual(both, [], 'ein Schluessel steht in beiden Listen');
  // Und keine Liste nennt etwas, das die Route nicht (mehr) liefert.
  assert.deepEqual(Object.keys(shows).filter((key) => !(key in real)), [], 'die Allowlist nennt einen Schluessel, den die Route nicht liefert');
  assert.deepEqual(Object.keys(DELIBERATELY_EMPTY_ON_THE_WALL).filter((key) => !(key in real)), []);

  // Dieselbe Frage eine Ebene tiefer, wo die Allowlist nur einzelne Felder nennt.
  const partial = Object.keys(shows).filter((key) => Array.isArray(shows[key])).sort();
  assert.deepEqual(partial, Object.keys(DELIBERATELY_EMPTY_FIELDS).sort());
  for (const key of partial) {
    const fields = Object.keys(real[key]).sort();
    assert.deepEqual([...shows[key], ...DELIBERATELY_EMPTY_FIELDS[key]].sort(), fields, `„${key}": jedes Feld ist entschieden`);
  }
}));

test('Drift: was die Haushaltsfassung traegt, ist genau das Gezeichnete - an der echten Antwort abgelesen', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedWallSources();
  const personal = await overview(ANNA, `?shopping_list=${SHOPPING_LIST}`);
  const wall = await overview(ANNA, householdQuery());
  // OHNE DIE KONSTANTE DES SERVERS: ein Schluessel „traegt", wenn er sich von
  // der Antwort desselben Haushalts ohne jede Zeile unterscheidet.
  for (const table of ['tasks', 'calendar_events', 'notes', 'budget_entries', 'expense_ledger_entries', 'quick_links',
    'housekeeping_work_sessions', 'meals', 'shopping_items', 'shopping_lists', 'waste_one_off_pickups', 'pantry_items',
    'birthdays', 'medication_schedules', 'medications', 'schedule_extra_shifts', 'reward_redemptions', 'reward_participants']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  const blank = await overview(ANNA, householdQuery());
  const differs = (a, b) => { try { assert.deepEqual(a, b); return false; } catch { return true; } };
  const carried = Object.keys(wall).filter((key) => differs(wall[key], blank[key])).sort();
  assert.deepEqual(carried, ['birthdays', 'housekeeping', 'pantryExpiring', 'shoppingOpenCount', 'todayMeals',
    'upcomingEvents', 'urgentTasks', 'wallTasks', 'wastePickups'], 'belegt in der Saat UND an der Wand gezeichnet');
  for (const key of carried.filter((name) => !['housekeeping', 'pantryExpiring'].includes(name))) {
    assert.deepEqual(wall[key], personal[key], `„${key}" kommt unveraendert`);
  }
  assert.deepEqual(wall.users, personal.users, 'die Gesichter kommen unveraendert');
  assert.ok(wall.users.length >= 3);
  // Reichweite der Messung: persoenlich traegt dieselbe Saat weit mehr.
  const blankPersonal = await overview(ANNA);
  const carriedPersonal = Object.keys(personal).filter((key) => differs(personal[key], blankPersonal[key]));
  for (const key of ['budget', 'splitBalance', 'pinnedNotes', 'quicklinks', 'countdowns', 'rewards', 'weekEvents', 'openTaskCount']) {
    assert.ok(carriedPersonal.includes(key), `Reichweite: persoenlich traegt „${key}"`);
  }
}));

test('Allowlist: ein unbekannter Schluessel bekommt NEIN - auch einer, den es heute noch nicht gibt', () => {
  assert.equal(typeof visibility.householdAudienceAnswer, 'function');
  const empty = { users: [], budget: { income: 0 }, housekeeping: { present: false, unpaidAmount: 0 } };
  const answer = visibility.householdAudienceAnswer({
    users: [{ id: 1 }],
    budget: { income: 4321.09 },
    housekeeping: { present: true, unpaidAmount: 87.5, brandNewField: 'Lohnzettel' },
    brandNewModule: { secret: 'Kontostand' },
  }, empty);
  assert.deepEqual(answer, {
    users: [{ id: 1 }],
    budget: { income: 0 },
    housekeeping: { present: true, unpaidAmount: 0 },
  });
});

test('Allowlist: was die Wand nicht zeigt, wird auch nicht gelesen', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedWallSources();
  const OFF_WALL_TABLES = /\b(notes|budget_entries|expense_ledger_entries|quick_links|medications|reward_redemptions|schedule_extra_shifts)\b/;
  const original = db.prepare;
  let seen = [];
  db.prepare = function prepare(sql) { seen.push(String(sql)); return original.call(this, sql); };
  try {
    await overview(ANNA);
    const personalReads = seen.filter((sql) => OFF_WALL_TABLES.test(sql)).length;
    assert.ok(personalReads >= 5, `Reichweite: die persoenliche Fassung liest diese Tabellen (${personalReads})`);
    seen = [];
    await overview(ANNA, householdQuery());
    assert.ok(seen.length > 5, 'Reichweite: die Haushaltsfassung liest');
    assert.deepEqual(seen.filter((sql) => OFF_WALL_TABLES.test(sql)).map((sql) => sql.trim().slice(0, 60)), []);
  } finally {
    db.prepare = original;
  }
}));

test('Allowlist: die gebaute Wand ist dieselbe wie zuvor - nichts, was sie zeichnet, ist weggefallen', async () => {
  let personal;
  let wall;
  await withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
    seedWallSources();
    personal = await overview(ANNA, `?shopping_list=${SHOPPING_LIST}`);
    wall = await overview(ANNA, householdQuery());
  })();
  await onWallAt(NOON_BERLIN, () => {
    // Der Stand vor der Allowlist: die volle Antwort, ohne die drei Module, die
    // #1900 schon ausliess.
    const beforeData = {
      ...personal,
      health: wall.health, fasting: wall.fasting, nutrition: wall.nutrition, rewards: wall.rewards, myShiftsToday: [],
      pendingReminders: [],
    };
    const afterData = { ...wall, pendingReminders: [] };
    // Das Modell des ganzen Tages, nicht nur die vier Zeilen ueber dem Deckel.
    const day = (data) => {
      const model = dash.buildTodayCockpitModel(data, [], { cap: dash.WALL_ROW_CAP, now: new Date(), groupOverdue: false });
      return { rows: model.allRows.map((row) => [row.kind, row.title, row.sub, row.timeLabel]), shopping: model.shopping?.title ?? null, overflow: model.overflow, coda: model.coda };
    };
    const before = day(beforeData);
    const text = JSON.stringify(before.rows);
    for (const word of ['Elternabend', 'Tisch decken', 'Linsensuppe', 'Biotonne', 'Joghurt', 'Helga', 'Oma Erna']) {
      assert.ok(text.includes(word), `Reichweite: „${word}" steht im Programm des Tages`);
    }
    assert.ok(before.shopping, 'Reichweite: die Einkaufszeile steht');
    assert.deepEqual(day(afterData), before, 'das Programm des Tages ist dasselbe');
    const shown = wallParts(afterData);
    const was = wallParts(beforeData);
    assert.equal(shown.who, was.who, '„Wer heute dran ist" ist dasselbe');
    assert.equal(shown.html, was.html, 'die ganze Flaeche ist dieselbe');
    for (const word of OFF_WALL_WORDS) assert.ok(!shown.html.includes(word));
  })();
});

test('Allowlist: das Display ohne den Parameter bekommt, was es bekam', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedWallSources();
  const display = await asCoupledDisplay(() => overview(DISPLAY));
  assert.deepEqual(titles(display.countdowns), ['Urlaub in Sicht'], 'Countdowns bleiben der Uebersicht des Displays');
  assert.ok(display.openTaskCount > 0);
  assert.ok(display.weekEvents.length > 0);
  assert.equal(display.rewards.view, 'family');
  // Und an der Wand folgt auch das Display der Allowlist.
  const wall = await asCoupledDisplay(() => overview(DISPLAY, '?audience=household'));
  assert.deepEqual(wall.countdowns, []);
  assert.equal(wall.openTaskCount, 0);
  assert.deepEqual(wall.weekEvents, []);
  assert.ok(titles(wall.urgentTasks).includes('Tisch decken'), 'Reichweite: das Programm steht');
}));
