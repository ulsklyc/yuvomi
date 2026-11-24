/**
 * Modul: Aufgaben-Auswahl, geteilt zwischen Modul und Übersicht (#825)
 * Zweck: Die Frage, die keine der beiden Seiten allein beantworten kann -
 *        zeigen `GET /api/v1/tasks` und `GET /api/v1/dashboard` dieselben
 *        Aufgaben?
 *
 *        Sie taten es nicht. Das Modul schloss Unteraufgaben (`parent_task_id
 *        IS NULL`) und noch nicht begonnene Aufgaben (`start_date`) aus, die
 *        Übersicht kannte beide Regeln nicht: eine Unteraufgabe stand dort als
 *        kontextlose eigene Zeile, eine Aufgabe mit Startdatum nächste Woche
 *        stand heute schon da, und die Kennzahl-Kacheln zählten beides mit.
 *        Beide Seiten waren für sich grün - der Fehler lag im Unterschied.
 *
 *        Der Test misst deshalb BEIDE echten Router gegen DENSELBEN Bestand
 *        und vergleicht ihre Antworten miteinander, statt jede für sich gegen
 *        eine erwartete Liste zu prüfen. Eine Zusicherung über nur eine Seite
 *        hätte die Divergenz nie sehen können.
 *
 * Ausführen: npm run test:task-scope
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'task-scope-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const { createCalendarApp } = await import('./calendar-app.js');
const { taskScopeWhere, taskScopeNeedsToday } = await import('../server/services/task-scope.js');

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

// Lokaler Kalendertag, nicht der UTC-Tag: `start_date` ist ein lokal
// eingegebener Tag, und westlich von UTC sind das am Abend zwei verschiedene.
// Genau diese Sorte Fehler ist in der UTC-CI unsichtbar.
const now = new Date();
const localKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (n) => localKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n));
const TODAY = localKey(now);
const TOMORROW = addDays(1);
const NEXT_WEEK = addDays(7);
const YESTERDAY = addDays(-1);

const ALICE = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, avatar_color, role)
  VALUES (?, 'Alice', 'hash', '#007AFF', 'admin')
`).run(`alice-${randomUUID()}`).lastInsertRowid;

// --------------------------------------------------------------------------
// Bestand. Vier Aufgaben, die genau die strittigen Achsen abdecken - jede mit
// einer Fälligkeit HEUTE, damit sie es an allen Zeitfiltern der Übersicht
// vorbeischafft und wirklich nur die Auswahlregel über sie entscheidet.
// --------------------------------------------------------------------------
const insertTask = db.prepare(`
  INSERT INTO tasks (title, priority, status, due_date, start_date, parent_task_id, visibility, created_by)
  VALUES (?, 'high', 'open', ?, ?, ?, 'all', ?)
`);

const PARENT_ID = insertTask.run('Umzug vorbereiten', TODAY, null, null, ALICE).lastInsertRowid;
const SUBTASK_ID = insertTask.run('Kartons kaufen', TODAY, null, PARENT_ID, ALICE).lastInsertRowid;
const FUTURE_ID = insertTask.run('Erst nächste Woche', TODAY, NEXT_WEEK, null, ALICE).lastInsertRowid;
const STARTED_ID = insertTask.run('Läuft seit gestern', TODAY, YESTERDAY, null, ALICE).lastInsertRowid;

// Eine erledigte Unteraufgabe: `tasksDoneToday` ist die Kennzahl „heute
// geschafft", und eine abgehakte Unteraufgabe darf dort nicht als eigene
// Tagesleistung zählen, wenn sie in keiner Liste steht.
const parentDone = insertTask.run('Küche streichen', TODAY, null, null, ALICE).lastInsertRowid;
const doneSubtask = insertTask.run('Farbe besorgen', TODAY, null, parentDone, ALICE).lastInsertRowid;
db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(doneSubtask);

// --------------------------------------------------------------------------
// Beide echten Router am selben Bestand.
// --------------------------------------------------------------------------
// createCalendarApp (test/calendar-app.js): echter Praefix, defaultEmptyBody und
// der zentrale Fehlerhandler, wie validateRequest() sie braucht (#2810).
const app = await createCalendarApp({
  mount: ['dashboard'],
  auth: (req, _res, next) => {
    req.authUserId = ALICE;
    req.authRole = 'admin';
    req.session = { userId: ALICE, role: 'admin' };
    req.sessionModuleAccess = null;
    next();
  },
  before: [['/api/v1/tasks', tasksRouter]],
});
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;

test.after(() => { server.close(); db.close(); });

const moduleTasks = async (query = '') => (await (await fetch(`${base}/tasks${query}`)).json()).data;
const dashboard = async (query = '') => (await fetch(`${base}/dashboard${query}`)).json();

// --------------------------------------------------------------------------
// Vorbedingung. OHNE SIE IST JEDE ZUSICHERUNG UNTEN WERTLOS: wenn die
// Übersicht ohnehin nichts oder etwas anderes ausliefert, sagt die
// Abwesenheit einer Unteraufgabe nichts über die Auswahlregel aus.
// --------------------------------------------------------------------------
test('Vorbedingung: beide Wege liefern überhaupt Aufgaben, und die normale ist in beiden', async () => {
  const listed = await moduleTasks();
  const body = await dashboard();

  assert.ok(listed.some((t) => t.id === PARENT_ID), 'das Modul listet die gewöhnliche Aufgabe');
  assert.ok(body.urgentTasks.some((t) => t.id === PARENT_ID), 'die Übersicht zeigt die gewöhnliche Aufgabe');
  assert.ok(body.urgentTasks.length > 0, 'die Übersicht ist nicht generell leer');
});

// --------------------------------------------------------------------------
// Die eigentliche Zusicherung: die Auswahl ist DIESELBE. Sie ist bewusst als
// Vergleich formuliert und nicht als zwei Listen von Ids - so deckt sie auch
// jede künftige Auswahlregel ab, die nur eine der beiden Seiten bekommt.
// --------------------------------------------------------------------------
test('Übersicht und Modul treffen dieselbe Auswahl', async () => {
  const listedIds = new Set((await moduleTasks()).map((t) => t.id));
  const body = await dashboard();

  for (const task of body.urgentTasks) {
    assert.ok(
      listedIds.has(task.id),
      `Die Übersicht zeigt "${task.title}" (id ${task.id}), das Aufgabenmodul listet sie nicht - `
      + 'die beiden Auswahlregeln sind auseinandergelaufen (#825).',
    );
  }
});

test('Eine Unteraufgabe ist kein eigener Eintrag der Übersicht', async () => {
  const body = await dashboard();
  assert.ok(
    !body.urgentTasks.some((t) => t.id === SUBTASK_ID),
    'die Unteraufgabe stand ohne die Aufgabe, zu der sie gehört, als eigene Zeile in der Übersicht',
  );
});

test('Was erst später beginnt, steht heute in keiner der beiden Listen', async () => {
  const listed = await moduleTasks();
  const body = await dashboard();

  assert.ok(!listed.some((t) => t.id === FUTURE_ID), 'Vorbedingung: das Modul blendet sie aus');
  assert.ok(
    !body.urgentTasks.some((t) => t.id === FUTURE_ID),
    'die erst nächste Woche beginnende Aufgabe stand schon heute in der Übersicht',
  );
  assert.ok(
    body.urgentTasks.some((t) => t.id === STARTED_ID),
    'eine bereits begonnene Aufgabe muss bleiben - sonst filtert die Regel zu scharf',
  );
});

// --------------------------------------------------------------------------
// Die Kacheln sind der Teil, den ein reiner Listen-Test durchgehen ließe:
// `urgentTasks` deckelt bei 5, die Zahlen zählen unbegrenzt. Liefe der Filter
// nur auf der Liste, stünden zwei Zeilen unter einer Kachel, die vier sagt.
// --------------------------------------------------------------------------
test('Die Kennzahlen zählen dieselbe Grundgesamtheit wie die Liste', async () => {
  const body = await dashboard();
  const listed = await moduleTasks();
  const openInModule = listed.filter((t) => t.status !== 'done').length;

  assert.equal(
    body.openTaskCount, openInModule,
    'die Kachel „offen" zählt andere Aufgaben, als das Modul listet - Unteraufgaben oder '
    + 'noch nicht begonnene laufen in der Zahl mit',
  );
  assert.equal(body.tasksDoneToday, 0, 'eine abgehakte Unteraufgabe ist keine eigene Tagesleistung');
});

// --------------------------------------------------------------------------
// Der Fragmentbauer selbst. Die Zusicherung ist nicht die genaue SQL-Form,
// sondern dass das Fragment an JEDER Aufrufstelle verkettbar bleibt - ein
// leerer String ergäbe beim Aufrufer ein blankes `AND` und damit einen
// Syntaxfehler statt einer falschen Antwort.
// --------------------------------------------------------------------------
test('Das Scope-Fragment bleibt in jeder Kombination verkettbar', () => {
  const combos = [
    {}, { includeFuture: true }, { includeSubtasks: true },
    { includeFuture: true, includeSubtasks: true },
  ];
  for (const opts of combos) {
    const sql = taskScopeWhere('t', opts);
    assert.ok(sql.trim().length > 0, `leeres Fragment für ${JSON.stringify(opts)}`);
    db.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE ${sql}`).get(
      ...(taskScopeNeedsToday(opts) ? [TODAY] : []),
    );
  }
});

test('Der Tagesschlüssel wird gebunden, nicht aus SQLite genommen', () => {
  // `date('now')` wäre der UTC-Tag gegen ein lokal eingegebenes `start_date`.
  // Der Beweis, dass gebunden wird: ein anderer Tag ändert die Antwort.
  const sql = taskScopeWhere('t', { bind: '@today' });
  const count = (today) => db.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE ${sql}`).get({ today }).n;

  assert.ok(count(NEXT_WEEK) > count(TOMORROW), 'ein späterer Stichtag muss mehr Aufgaben einschließen');
  assert.ok(!taskScopeNeedsToday({ includeFuture: true }), 'ohne Startdatum-Filter ist kein Bind fällig');
});

// --------------------------------------------------------------------------
// Widget-Optionen (#814): dieselbe Einschraenkung, dieselbe Antwort.
//
// Die Uebersicht kann ihre Aufgaben auf Kategorien einschraenken und ihre
// Termine auf die eigenen. Beides muss die ABFRAGE einengen und nicht die
// fertige Liste: `urgentTasks` deckelt bei fuenf, die Kennzahlen zaehlen
// unbegrenzt - wer nachtraeglich siebt, stellt zwei Zeilen unter eine Kachel,
// die sieben sagt (dieselbe Lehre wie #647).
// --------------------------------------------------------------------------
const GARDEN = 'garden-scope-test';
const OFFICE = 'office-scope-test';
db.prepare('INSERT INTO task_categories (key, name, sort_order) VALUES (?, ?, ?), (?, ?, ?)')
  .run(GARDEN, 'Garten', 90, OFFICE, 'Buero', 91);
const insertCategorized = db.prepare(`
  INSERT INTO tasks (title, priority, status, due_date, category, visibility, created_by)
  VALUES (?, 'high', 'open', ?, ?, 'all', ?)
`);
insertCategorized.run('Hecke schneiden', TODAY, GARDEN, ALICE);
insertCategorized.run('Rasen maehen', TODAY, GARDEN, ALICE);
insertCategorized.run('Steuer sortieren', TODAY, OFFICE, ALICE);

test('Kategorie-Einschraenkung: Modul und Uebersicht treffen dieselbe Auswahl', async () => {
  const fromModule = (await moduleTasks(`?category=${GARDEN}`)).map((t) => t.title).sort();
  const fromDashboard = (await dashboard(`?tasks_category=${GARDEN}`)).urgentTasks.map((t) => t.title).sort();
  assert.deepEqual(fromDashboard, fromModule);
  assert.ok(fromModule.includes('Hecke schneiden'));
  assert.ok(!fromModule.includes('Steuer sortieren'));
});

test('Mehrere Kategorien verbinden sich ODER, auf beiden Seiten', async () => {
  // Vorher band die Aufgabenroute das Array von Express in EINEN Platzhalter -
  // `?category=a&category=b` kam gar nicht erst durch.
  const fromModule = await moduleTasks(`?category=${GARDEN}&category=${OFFICE}`);
  const titles = fromModule.map((t) => t.title).sort();
  assert.deepEqual(titles, ['Hecke schneiden', 'Rasen maehen', 'Steuer sortieren']);
  const fromDashboard = (await dashboard(`?tasks_category=${GARDEN}&tasks_category=${OFFICE}`))
    .urgentTasks.map((t) => t.title).sort();
  assert.deepEqual(fromDashboard, titles);
});

test('Die Kennzahlen der Uebersicht zaehlen die eingeschraenkte Menge, nicht alles', async () => {
  const all = await dashboard();
  const garden = await dashboard(`?tasks_category=${GARDEN}`);
  assert.equal(garden.openTaskCount, 2, 'die Kachel zaehlt an der Einschraenkung vorbei');
  assert.ok(all.openTaskCount > garden.openTaskCount,
    'ohne Einschraenkung muessen es mehr sein - sonst misst der Test nichts');
  // Die Liste ist die Probe aufs Exempel: Kachel und Zeilen muessen dieselbe
  // Grundgesamtheit meinen.
  assert.equal(garden.urgentTasks.length, garden.openTaskCount);
});

test('Eine leere oder unbekannte Auswahl leert die Uebersicht nicht', async () => {
  // „Ich habe nichts gewaehlt" heisst alles - ein Filter, der ohne Auswahl
  // alles wegschneidet, ist ein leeres Dashboard fuer jemanden, der nur den
  // Dialog geoeffnet hat.
  const empty = await dashboard('?tasks_category=');
  const all = await dashboard();
  assert.equal(empty.openTaskCount, all.openTaskCount);
  // Eine Kategorie, die es nicht gibt, schraenkt dagegen wirklich ein.
  assert.equal((await dashboard('?tasks_category=gibtesnicht')).openTaskCount, 0);
});

// --------------------------------------------------------------------------
// Termine: „nur meine" heisst zugewiesen an mich - dieselbe Auslegung wie im
// Kalendermodul (`belongsToMe` in public/pages/calendar.js).
// --------------------------------------------------------------------------
const BOB = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, avatar_color, role)
  VALUES (?, 'Bob', 'hash', '#34C759', 'member')
`).run(`bob-${randomUUID()}`).lastInsertRowid;

const insertEvent = db.prepare(`
  INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, visibility, created_by)
  VALUES (?, ?, ?, 0, 'all', ?)
`);
const MINE_EVENT = insertEvent.run('Zahnarzt', `${TOMORROW}T09:00`, `${TOMORROW}T10:00`, ALICE).lastInsertRowid;
const HIS_EVENT = insertEvent.run('Bobs Training', `${TOMORROW}T11:00`, `${TOMORROW}T12:00`, ALICE).lastInsertRowid;
const NOBODYS_EVENT = insertEvent.run('Muellabfuhr', `${TOMORROW}T13:00`, `${TOMORROW}T14:00`, ALICE).lastInsertRowid;
db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(MINE_EVENT, ALICE);
db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(HIS_EVENT, BOB);

test('Termine ohne Einschraenkung: alle drei stehen da', async () => {
  const titles = (await dashboard()).upcomingEvents.map((e) => e.title);
  for (const title of ['Zahnarzt', 'Bobs Training', 'Muellabfuhr']) {
    assert.ok(titles.includes(title), `${title} fehlt - der Test misst sonst nichts`);
  }
});

test('events_scope=mine zeigt nur, was mir zugewiesen ist', async () => {
  const titles = (await dashboard('?events_scope=mine')).upcomingEvents.map((e) => e.title);
  assert.deepEqual(titles, ['Zahnarzt']);
  // Unzugewiesen zaehlt NICHT mit, so wie im Kalendermodul auch nicht. Zwei
  // Auslegungen desselben Satzes an zwei Orten waeren schlimmer als der eine
  // Fall, ueber den man streiten kann.
  assert.ok(!titles.includes('Muellabfuhr'));
});

test('Die Termin-Einschraenkung wirkt vor der Deckelung', async () => {
  // Sechs fremde Termine VOR meinem: gefiltert wuerde nachtraeglich innerhalb
  // der fuenf, die die Route ohnehin liefert, bliebe von „nur meine" nichts.
  for (let i = 0; i < 6; i++) {
    insertEvent.run(`Fremdtermin ${i}`, `${TOMORROW}T0${i}:30`, `${TOMORROW}T0${i}:45`, ALICE);
  }
  const titles = (await dashboard('?events_scope=mine')).upcomingEvents.map((e) => e.title);
  assert.deepEqual(titles, ['Zahnarzt'], 'der eigene Termin ist hinter der Deckelung verschwunden');
});

// --------------------------------------------------------------------------
// Geburtstage im Termin-Widget (#927): dieselbe Klasse wie „nur meine" - eine
// Widget-Option, die als Query-Parameter reist und VOR der Deckelung wirkt.
// --------------------------------------------------------------------------
const insertAllDay = db.prepare(`
  INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, visibility, created_by)
  VALUES (?, ?, ?, 1, 'all', ?)
`);
const insertBirthday = db.prepare(`
  INSERT INTO birthdays (name, birth_date, calendar_event_id, created_by) VALUES (?, ?, ?, ?)
`);
test('Vorbedingung: ohne Parameter fuellen die Geburtstage das Termin-Widget', async () => {
  /* ANGELEGT WIRD ERST HIER, NICHT AUF MODULEBENE. Die Tests dieser Datei
   * laufen der Reihe nach gegen EINEN wachsenden Bestand, und fuenf
   * ganztaegige Termine ganz vorn haetten den Terminbestand der Abschnitte
   * darueber aus den gedeckelten fuenf Plaetzen gedraengt - deren Zusicherung
   * waere rot geworden, ohne dass an ihrer Regel etwas falsch ist.
   *
   * Fuenf Stueck und ganztaegig ist Absicht: sie beginnen um Mitternacht,
   * stehen damit vor jedem anderen Termin und fuellen die fuenf Plaetze
   * restlos aus. Genau daran faellt unten auf, ob nach der Deckelung
   * gefiltert wird. */
  for (const name of ['Hartmut', 'Lars', 'Mira', 'Ove', 'Rosa']) {
    const eventId = insertAllDay.run(`Geburtstag: ${name}`, TOMORROW, TOMORROW, ALICE).lastInsertRowid;
    insertBirthday.run(name, '1980-01-01', eventId, ALICE);
  }
  const events = (await dashboard()).upcomingEvents;
  assert.equal(events.length, 5, 'die Route deckelt bei fuenf - sonst misst der Test unten nichts');
  assert.ok(events.every((e) => e.birthday_name),
    `es sollen ausschliesslich Geburtstage sein: ${events.map((e) => e.title).join(', ')}`);
});

test('events_birthdays=hide nimmt die Geburtstage heraus - VOR der Deckelung', async () => {
  const events = (await dashboard('?events_birthdays=hide')).upcomingEvents;
  assert.ok(events.every((e) => !e.birthday_name),
    `Geburtstag durchgerutscht: ${events.map((e) => e.title).join(', ')}`);
  // DIE EIGENTLICHE ZUSICHERUNG. Nachtraeglich gesiebt blieben von den fuenf
  // Plaetzen, die oben komplett mit Geburtstagen belegt sind, null Termine
  // uebrig - die Kachel waere leer statt gefiltert (dieselbe Lehre wie #647).
  assert.equal(events.length, 5, 'die Geburtstage wurden erst nach der Deckelung entfernt');
});

test('Erkannt wird der Geburtstag am Modul-Eintrag, nicht an seinem Titel', async () => {
  // Gegenprobe zur Regel: ein von Hand angelegter Termin, der zufaellig so
  // heisst, gehoert niemandem im Geburtstagsmodul und bleibt deshalb stehen.
  // Ein Vergleich auf den Titel haette ihn mitgenommen - und in einem
  // englischsprachigen Haushalt umgekehrt keinen einzigen echten gefunden,
  // weil der Titel in der Datensprache des Haushalts gespeichert ist (#524).
  insertEvent.run('Geburtstag: Deko kaufen', `${TOMORROW}T00:05`, `${TOMORROW}T00:15`, ALICE);
  const titles = (await dashboard('?events_birthdays=hide')).upcomingEvents.map((e) => e.title);
  assert.ok(titles.includes('Geburtstag: Deko kaufen'),
    `am Titel statt am Eintrag gefiltert: ${titles.join(', ')}`);
});

test('Ohne den Parameter bleibt alles, wie es war', async () => {
  // Ein Filter wirkt nur, wo jemand ihn gesetzt hat: der Auslieferungszustand
  // der Route ist „mit Geburtstagen", und ein unbekannter Wert aendert daran
  // nichts (er koennte sonst als Abwahl durchgehen).
  for (const query of ['', '?events_birthdays=show', '?events_birthdays=']) {
    const events = (await dashboard(query)).upcomingEvents;
    assert.ok(events.some((e) => e.birthday_name), `Geburtstage fehlen bei "${query}"`);
  }
});
