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
const app = express();
app.use((req, _res, next) => {
  const user = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(viewer);
  req.authUserId = user.id;
  req.authRole = user.role;
  req.session = { userId: user.id, role: user.role };
  req.sessionModuleAccess = buildSessionModuleAccess(resolvePermissions(db, user));
  next();
});
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
