/**
 * Modul: Tasks-Recurrence-Test
 * Zweck: Aufholen übersprungener wiederkehrender Aufgaben (Discussion #405) und
 *        die Wahl des Ankers: ab Fälligkeit oder ab Erledigungstag (#658).
 *        Unit: nextOccurrenceAfter, nextDueAfterCompletion. Integration:
 *        PATCH /:id/status und PUT /:id erzeugen beim Erledigen genau eine
 *        Folgeinstanz, deren Fälligkeit am gewählten Anker hängt - und nehmen
 *        sie beim Zurücknehmen wieder weg.
 * Ausführen: node --test test/test-tasks-recurrence.js
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
// Der Erledigungstag kommt aus der Haushaltszone (serverTimeZone lesend über
// process.env.TZ). Auf UTC festgenagelt, damit `todayKey()` hier und die
// Route dieselbe Vorstellung von "heute" haben - sonst hinge das Ergebnis an
// der Zone der ausführenden Maschine und wackelte über Mitternacht.
process.env.TZ = 'UTC';

const {
  nextOccurrence, nextOccurrenceAfter, nextDueAfterCompletion,
} = await import('../server/services/recurrence.js');
const { MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');

// --------------------------------------------------------
// Helfer
// --------------------------------------------------------
const DAY = 86400000;
const todayKey = () => new Date().toISOString().slice(0, 10);
const dayKey = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

// --------------------------------------------------------
// Unit: nextOccurrenceAfter
// --------------------------------------------------------
test('nextOccurrenceAfter: pünktliches Abhaken springt genau ein Intervall (kein Aufholen)', () => {
  // due in 7 Tagen, Schwelle heute → erstes Vorkommen (due+7) liegt bereits in der Zukunft
  const due = dayKey(7);
  const expected = nextOccurrence(due, 'FREQ=WEEKLY');
  assert.equal(nextOccurrenceAfter(due, 'FREQ=WEEKLY', todayKey()), expected);
});

test('nextOccurrenceAfter: mehrere verpasste Wochen → erstes Vorkommen >= heute', () => {
  const due = dayKey(-21); // 3 Wochen überfällig
  const result = nextOccurrenceAfter(due, 'FREQ=WEEKLY', todayKey());
  assert.ok(result >= todayKey(), `Ergebnis ${result} muss >= heute sein`);
  // Es bleibt auf dem Serien-Raster (Wochentag von due)
  const naive = nextOccurrence(due, 'FREQ=WEEKLY');
  assert.ok(naive < todayKey(), 'naives nextOccurrence wäre noch überfällig');
});

test('nextOccurrenceAfter: DAILY holt auf morgen/heute auf', () => {
  const due = dayKey(-10);
  const result = nextOccurrenceAfter(due, 'FREQ=DAILY', todayKey());
  assert.ok(result >= todayKey());
});

test('nextOccurrenceAfter: MONTHLY holt mehrere Monate auf', () => {
  const due = dayKey(-95); // ~3 Monate überfällig
  const result = nextOccurrenceAfter(due, 'FREQ=MONTHLY', todayKey());
  assert.ok(result >= todayKey());
});

test('nextOccurrenceAfter: UNTIL endet vor heute → null', () => {
  const due = dayKey(-21);
  const untilStr = dayKey(-7).replace(/-/g, ''); // UNTIL=YYYYMMDD vor heute
  assert.equal(nextOccurrenceAfter(due, `FREQ=WEEKLY;UNTIL=${untilStr}`, todayKey()), null);
});

test('nextOccurrenceAfter: ohne Basisdatum → null', () => {
  assert.equal(nextOccurrenceAfter(null, 'FREQ=WEEKLY', todayKey()), null);
});

// --------------------------------------------------------
// Unit: nextDueAfterCompletion - Anker ab Erledigungstag (#658)
// --------------------------------------------------------
test('nextDueAfterCompletion: der Fall aus #658 - Samstag fällig, Montag erledigt, Montag+7', () => {
  // Fester Kalender statt "heute": die Aussage ist ein Datumsverhältnis, kein
  // Verhältnis zur Laufzeit des Tests.
  const next = nextDueAfterCompletion({
    anchorDate: '2026-08-01',   // Samstag
    rule: 'FREQ=WEEKLY',
    completedOn: '2026-08-03',  // Montag
    fromCompletion: true,
  });
  assert.equal(next, '2026-08-10', 'eine Woche ab dem Tag des Abhakens');
});

test('nextDueAfterCompletion: derselbe Fall fälligkeitsverankert bleibt auf dem Samstag', () => {
  const next = nextDueAfterCompletion({
    anchorDate: '2026-08-01',
    rule: 'FREQ=WEEKLY',
    completedOn: '2026-08-03',
    fromCompletion: false,
  });
  assert.equal(next, '2026-08-08', 'Vorgabe: das Raster der Serie verschiebt sich nicht');
});

test('nextDueAfterCompletion: frühes Abhaken zählt ebenfalls ab dem Erledigungstag', () => {
  // Nicht nur überfälliges Abhaken verschiebt: wer zwei Tage früher fertig ist,
  // beginnt das Intervall auch zwei Tage früher.
  const next = nextDueAfterCompletion({
    anchorDate: '2026-08-10',
    rule: 'FREQ=DAILY;INTERVAL=3',
    completedOn: '2026-08-08',
    fromCompletion: true,
  });
  assert.equal(next, '2026-08-11');
});

test('nextDueAfterCompletion: MONTHLY rechnet vom Erledigungstag, nicht vom Fälligkeitstag', () => {
  const next = nextDueAfterCompletion({
    anchorDate: '2026-01-31',
    rule: 'FREQ=MONTHLY',
    completedOn: '2026-02-05',
    fromCompletion: true,
  });
  assert.equal(next, '2026-03-05');
});

test('nextDueAfterCompletion: UNTIL beendet auch die erledigungsverankerte Serie', () => {
  const next = nextDueAfterCompletion({
    anchorDate: '2026-08-01',
    rule: 'FREQ=WEEKLY;UNTIL=20260805',
    completedOn: '2026-08-03',
    fromCompletion: true,
  });
  assert.equal(next, null);
});

test('nextDueAfterCompletion: ohne Erledigungstag → null', () => {
  assert.equal(nextDueAfterCompletion({
    anchorDate: '2026-08-01', rule: 'FREQ=WEEKLY', completedOn: null, fromCompletion: true,
  }), null);
});

test('nextDueAfterCompletion: ohne Fälligkeitsdatum trägt der Erledigungstag die Serie', () => {
  // Fälligkeitsverankert gäbe es hier nichts zu rechnen (und es entsteht keine
  // Folgeinstanz); mit dem Erledigungstag als Anker schon.
  assert.equal(nextDueAfterCompletion({
    anchorDate: null, rule: 'FREQ=WEEKLY', completedOn: '2026-08-03', fromCompletion: false,
  }), null);
  assert.equal(nextDueAfterCompletion({
    anchorDate: null, rule: 'FREQ=WEEKLY', completedOn: '2026-08-03', fromCompletion: true,
  }), '2026-08-10');
});

// --------------------------------------------------------
// Integration: PATCH /:id/status (done) gegen den Router
// --------------------------------------------------------
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
const uid = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('admin', 'Admin', '$2b$12$x', 'admin')`).run().lastInsertRowid;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  // `x-test-user` laesst einen Test als zweite Person fragen.
  const other = Number(req.headers['x-test-user']) || null;
  req.authUserId = other ?? uid;
  req.session = { userId: other ?? uid, role: other ? 'member' : 'admin' };
  next();
});
app.use('/api/v1/tasks', tasksRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1/tasks`;

test.after(() => server.close());

async function call(method, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function insertTask(fields) {
  const cols = Object.keys(fields);
  const r = db.prepare(
    `INSERT INTO tasks (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  ).run(...cols.map((c) => fields[c]));
  return r.lastInsertRowid;
}

test('PATCH done: überfällige Wochen-Serie erzeugt genau eine Folgeinstanz in der Zukunft', async () => {
  const id = insertTask({
    title: 'Bad putzen', category: 'Haushalt', priority: 'medium', status: 'open',
    due_date: dayKey(-21), created_by: uid, is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
  });
  db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(id, uid);

  const res = await call('PATCH', `/${id}/status`, { status: 'done' });
  assert.equal(res.status, 200);

  const followups = db.prepare(
    `SELECT * FROM tasks WHERE title = 'Bad putzen' AND status = 'open' AND parent_task_id IS NULL`,
  ).all();
  assert.equal(followups.length, 1, 'Es darf genau eine offene Folgeinstanz existieren');
  assert.ok(followups[0].due_date >= todayKey(), 'Folgeinstanz muss in der Zukunft fällig sein');
  assert.equal(followups[0].is_recurring, 1);
  // Assignments übernommen
  const assignees = db.prepare('SELECT user_id FROM task_assignments WHERE task_id = ?').all(followups[0].id);
  assert.deepEqual(assignees.map((a) => a.user_id), [uid]);
});

test('PATCH done: nicht-wiederkehrende Aufgabe erzeugt keine Folgeinstanz', async () => {
  const id = insertTask({
    title: 'Einmalig', status: 'open', due_date: dayKey(-3), created_by: uid,
  });
  await call('PATCH', `/${id}/status`, { status: 'done' });
  const rows = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE title = 'Einmalig'`).get();
  assert.equal(rows.n, 1);
});

// --------------------------------------------------------
// Zurückgenommenes Abhaken (#650)
// --------------------------------------------------------
function openInstances(title) {
  return db.prepare(
    `SELECT * FROM tasks WHERE title = ? AND status = 'open' AND parent_task_id IS NULL
     ORDER BY due_date`,
  ).all(title);
}

async function completeRecurring(title, rule = 'FREQ=DAILY') {
  const id = insertTask({
    title, category: 'Haushalt', priority: 'medium', status: 'open',
    due_date: dayKey(0), created_by: uid, is_recurring: 1, recurrence_rule: rule,
  });
  await call('PATCH', `/${id}/status`, { status: 'done' });
  return id;
}

test('PATCH open: zurückgenommenes Abhaken entfernt die erzeugte Folgeinstanz', async () => {
  const first = await completeRecurring('Müll rausbringen');
  const second = openInstances('Müll rausbringen')[0];
  assert.ok(second, 'Abhaken muss eine Folgeinstanz erzeugt haben');

  // Versehentlich auch die Folgeinstanz abgehakt → dritte Instanz entsteht
  await call('PATCH', `/${second.id}/status`, { status: 'done' });
  assert.equal(openInstances('Müll rausbringen').length, 1);

  // Zurücknehmen: die aus DIESEM Abhaken entstandene Instanz verschwindet wieder
  const res = await call('PATCH', `/${second.id}/status`, { status: 'open' });
  assert.equal(res.status, 200);

  const open = openInstances('Müll rausbringen');
  assert.equal(open.length, 1, 'Nach dem Zurücknehmen darf genau eine offene Instanz existieren');
  assert.equal(open[0].id, second.id, 'Und zwar die wieder geöffnete, nicht die Folgeinstanz');
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(first).status, 'done');
});

test('PATCH done: erneutes Abhaken nach dem Zurücknehmen erzeugt wieder genau eine Folgeinstanz', async () => {
  await completeRecurring('Pflanzen gießen');
  const second = openInstances('Pflanzen gießen')[0];

  await call('PATCH', `/${second.id}/status`, { status: 'done' });
  await call('PATCH', `/${second.id}/status`, { status: 'open' });
  await call('PATCH', `/${second.id}/status`, { status: 'done' });

  assert.equal(openInstances('Pflanzen gießen').length, 1);
});

test('PATCH done: doppeltes done ohne Statuswechsel erzeugt keine zweite Folgeinstanz', async () => {
  const id = await completeRecurring('Katzenklo');
  await call('PATCH', `/${id}/status`, { status: 'done' });
  assert.equal(openInstances('Katzenklo').length, 1);
});

test('PATCH open: bearbeitete Folgeinstanz bleibt stehen', async () => {
  await completeRecurring('Wäsche waschen');
  const second = openInstances('Wäsche waschen')[0];
  await call('PATCH', `/${second.id}/status`, { status: 'done' });
  const third = openInstances('Wäsche waschen')[0];
  // Jemand hat der Folgeinstanz Arbeit hinzugefügt - die darf nicht wegfallen
  insertTask({ title: 'Buntwäsche', status: 'open', created_by: uid, parent_task_id: third.id });

  await call('PATCH', `/${second.id}/status`, { status: 'open' });
  const survivor = db.prepare('SELECT * FROM tasks WHERE id = ?').get(third.id);
  assert.ok(survivor, 'Folgeinstanz mit Unteraufgaben bleibt erhalten');
  assert.equal(openInstances('Wäsche waschen').length, 2);
});

test('PUT: Statuswechsel weg von done entfernt die Folgeinstanz ebenfalls', async () => {
  const id = await completeRecurring('Staubsaugen');
  const second = openInstances('Staubsaugen')[0];
  await call('PATCH', `/${second.id}/status`, { status: 'done' });

  const res = await call('PUT', `/${second.id}`, { title: 'Staubsaugen', status: 'open' });
  assert.equal(res.status, 200);
  assert.equal(openInstances('Staubsaugen').length, 1);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(id).status, 'done');
});

test('PUT done: Abhaken im Bearbeiten-Dialog erzeugt die Folgeinstanz genauso', async () => {
  const id = insertTask({
    title: 'Fenster putzen', category: 'Haushalt', priority: 'medium', status: 'open',
    due_date: dayKey(-21), created_by: uid, is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
  });
  db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(id, uid);

  const res = await call('PUT', `/${id}`, { title: 'Fenster putzen', status: 'done' });
  assert.equal(res.status, 200);

  const open = openInstances('Fenster putzen');
  assert.equal(open.length, 1, 'Das Status-Dropdown muss die Serie weiterschreiben');
  assert.ok(open[0].due_date >= todayKey(), 'Folgeinstanz muss in der Zukunft fällig sein');
  assert.equal(open[0].is_recurring, 1);
  assert.equal(open[0].recurrence_origin_id, id);
  const assignees = db.prepare('SELECT user_id FROM task_assignments WHERE task_id = ?').all(open[0].id);
  assert.deepEqual(assignees.map((a) => a.user_id), [uid]);
});

test('PUT done: erneutes Speichern ohne Statuswechsel erzeugt keine zweite Folgeinstanz', async () => {
  const id = insertTask({
    title: 'Handtücher wechseln', status: 'open', due_date: dayKey(0), created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=DAILY',
  });
  await call('PUT', `/${id}`, { title: 'Handtücher wechseln', status: 'done' });
  await call('PUT', `/${id}`, { title: 'Handtücher wechseln', status: 'done' });
  assert.equal(openInstances('Handtücher wechseln').length, 1);
});

test('PUT: Zurücknehmen entfernt die per PUT erzeugte Folgeinstanz wieder', async () => {
  const id = insertTask({
    title: 'Bettwäsche', status: 'open', due_date: dayKey(0), created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=DAILY',
  });
  await call('PUT', `/${id}`, { title: 'Bettwäsche', status: 'done' });
  assert.equal(openInstances('Bettwäsche').length, 1);

  await call('PUT', `/${id}`, { title: 'Bettwäsche', status: 'open' });
  const open = openInstances('Bettwäsche');
  assert.equal(open.length, 1, 'Nach dem Zurücknehmen bleibt nur die wieder geöffnete Aufgabe');
  assert.equal(open[0].id, id);
});

test('PUT done: im selben Speichern geänderte Regel gilt schon für die Folgeinstanz', async () => {
  // Der Aufruf übergibt bewusst die frisch gelesene Zeile, nicht den Stand von
  // vorher. Wer im Bearbeiten-Dialog die Wiederholung umstellt und gleich abhakt,
  // bekommt sonst die nächste Instanz nach der alten Regel.
  const id = insertTask({
    title: 'Filter wechseln', status: 'open', due_date: dayKey(-1), created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
  });
  const newDue = dayKey(-1);
  await call('PUT', `/${id}`, {
    title: 'Filter wechseln', status: 'done',
    recurrence_rule: 'FREQ=MONTHLY', due_date: newDue,
  });

  const open = openInstances('Filter wechseln');
  assert.equal(open.length, 1);
  assert.equal(open[0].recurrence_rule, 'FREQ=MONTHLY', 'Die neue Regel reist mit');
  assert.equal(
    open[0].due_date,
    nextOccurrenceAfter(newDue, 'FREQ=MONTHLY', todayKey()),
    'Fälligkeit liegt auf dem Monats-, nicht auf dem Wochenraster',
  );
});

test('PUT done: im selben Speichern abgeschaltete Wiederholung erzeugt keine Folgeinstanz', async () => {
  const id = insertTask({
    title: 'Filter entkalken', status: 'open', due_date: dayKey(-1), created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
  });
  await call('PUT', `/${id}`, { title: 'Filter entkalken', status: 'done', is_recurring: 0 });

  const rows = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE title = 'Filter entkalken'`).get();
  assert.equal(rows.n, 1, 'Wer die Wiederholung abschaltet, beendet die Serie bewusst');
});

test('PUT done: Subtask einer Serie erzeugt keine Folgeinstanz', async () => {
  const parent = insertTask({
    title: 'Eltern-Serie PUT', status: 'open', due_date: dayKey(-7), created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
  });
  const sub = insertTask({
    title: 'Sub PUT', status: 'open', due_date: dayKey(-7), created_by: uid,
    parent_task_id: parent, is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
  });
  await call('PUT', `/${sub}`, { title: 'Sub PUT', status: 'done' });
  const rows = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE title = 'Sub PUT'`).get();
  assert.equal(rows.n, 1, 'Subtasks dürfen keine Folgeinstanz auslösen');
});

// --------------------------------------------------------
// Erledigen und Folgeinstanz sind eine Einheit
// --------------------------------------------------------

/**
 * Lässt genau den Spawn-INSERT scheitern (nur er setzt recurrence_origin_id)
 * und lässt alles andere in Ruhe.
 */
async function withFailingSpawn(fn) {
  db.exec(`CREATE TRIGGER spawn_boom BEFORE INSERT ON tasks
    WHEN NEW.recurrence_origin_id IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'spawn failed'); END`);
  try {
    await fn();
  } finally {
    db.exec('DROP TRIGGER spawn_boom');
  }
}

test('PATCH: scheitert der Spawn, bleibt die Aufgabe offen', async () => {
  await withFailingSpawn(async () => {
    const id = insertTask({
      title: 'Rauchmelder prüfen', status: 'open', due_date: dayKey(0), created_by: uid,
      is_recurring: 1, recurrence_rule: 'FREQ=MONTHLY',
    });
    const res = await call('PATCH', `/${id}/status`, { status: 'done' });
    assert.equal(res.status, 500);
    assert.equal(
      db.prepare('SELECT status FROM tasks WHERE id = ?').get(id).status, 'open',
      'Ohne Folgeinstanz darf die Aufgabe nicht erledigt zurückbleiben - die Serie endete sonst still',
    );
  });
});

test('PUT: scheitert der Spawn, rollt das ganze Speichern zurück', async () => {
  await withFailingSpawn(async () => {
    const id = insertTask({
      title: 'Sieb reinigen', status: 'open', due_date: dayKey(0), created_by: uid,
      priority: 'low', is_recurring: 1, recurrence_rule: 'FREQ=MONTHLY',
    });
    // Titel und Priorität ändern sich mit: die Transaktion deckt das ganze
    // UPDATE ab, nicht nur die Status-Spalte.
    const res = await call('PUT', `/${id}`, {
      title: 'Sieb reinigen NEU', status: 'done', priority: 'high',
    });
    assert.equal(res.status, 500);

    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    assert.equal(row.status, 'open', 'Auch das Bearbeiten-Formular rollt den Statuswechsel mit zurück');
    assert.equal(row.title, 'Sieb reinigen', 'Und den Rest des Speicherns gleich mit');
    assert.equal(row.priority, 'low');
  });
});

test('Folgeinstanz behält den Vorlauf zwischen Start- und Fälligkeitsdatum', async () => {
  const id = insertTask({
    title: 'Steuer vorbereiten', status: 'open',
    start_date: dayKey(-24), due_date: dayKey(-21), created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
  });
  await call('PATCH', `/${id}/status`, { status: 'done' });

  const next = openInstances('Steuer vorbereiten')[0];
  assert.ok(next.start_date, 'Das Startdatum darf nicht verlorengehen');
  const lead = (Date.parse(`${next.due_date}T00:00:00Z`) - Date.parse(`${next.start_date}T00:00:00Z`)) / DAY;
  assert.equal(lead, 3, 'Drei Tage Vorlauf wie beim Durchlauf davor');
});

test('Folgeinstanz ohne Startdatum bekommt auch keines', async () => {
  const id = insertTask({
    title: 'Backup prüfen', status: 'open', due_date: dayKey(-2), created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
  });
  await call('PATCH', `/${id}/status`, { status: 'done' });
  assert.equal(openInstances('Backup prüfen')[0].start_date, null);
});

// --------------------------------------------------------
// Anker ab Erledigungstag gegen den Router (#658)
// --------------------------------------------------------
test('PATCH done: erledigungsverankerte Serie wird ab heute fällig, nicht ab dem alten Raster', async () => {
  const id = insertTask({
    title: 'Luftfilter reinigen', status: 'open', due_date: dayKey(-3), created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY', recurrence_from_completion: 1,
  });
  await call('PATCH', `/${id}/status`, { status: 'done' });

  const followup = openInstances('Luftfilter reinigen')[0];
  assert.ok(followup, 'Abhaken muss eine Folgeinstanz erzeugt haben');
  assert.equal(followup.due_date, dayKey(7), 'genau eine Woche ab heute');
  // Das fälligkeitsverankerte Ergebnis wäre der 4. Tag ab heute (due-3 + 7).
  assert.notEqual(followup.due_date, dayKey(4));
});

test('PATCH done: die Folgeinstanz erbt den Anker, sonst kippt die Serie ab dem zweiten Lauf', async () => {
  const id = insertTask({
    title: 'Pflanzen düngen', status: 'open', due_date: dayKey(-5), created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY', recurrence_from_completion: 1,
  });
  await call('PATCH', `/${id}/status`, { status: 'done' });
  const second = openInstances('Pflanzen düngen')[0];
  assert.equal(second.recurrence_from_completion, 1);

  // Zweiter Durchlauf: heute abgehakt, obwohl erst in einer Woche fällig →
  // wieder heute + 7 statt fällig + 7.
  await call('PATCH', `/${second.id}/status`, { status: 'done' });
  const third = openInstances('Pflanzen düngen')[0];
  assert.equal(third.due_date, dayKey(7));
});

test('POST/PUT: der Anker reist über die Route und lässt sich wieder abschalten', async () => {
  const created = await call('POST', '/', {
    title: 'Zahnbürstenkopf wechseln', is_recurring: 1,
    recurrence_rule: 'FREQ=MONTHLY', recurrence_from_completion: 1,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.recurrence_from_completion, 1);

  const updated = await call('PUT', `/${created.body.data.id}`, {
    title: 'Zahnbürstenkopf wechseln', recurrence_from_completion: 0,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.recurrence_from_completion, 0);
  // Und ohne das Feld im Body bleibt der gespeicherte Wert stehen.
  const untouched = await call('PUT', `/${created.body.data.id}`, { title: 'Zahnbürstenkopf wechseln' });
  assert.equal(untouched.body.data.recurrence_from_completion, 0);
});

test('PATCH done: ohne Anker bleibt es beim bisherigen Verhalten', async () => {
  const id = insertTask({
    title: 'Müllabfuhr', status: 'open', due_date: dayKey(-3), created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
  });
  await call('PATCH', `/${id}/status`, { status: 'done' });
  assert.equal(openInstances('Müllabfuhr')[0].due_date, dayKey(4));
});

test('PUT done: der Anker gilt auch beim Abhaken über den Bearbeiten-Dialog', async () => {
  // Die Naht zwischen beiden Wegen: der Dialog geht durch dieselbe Funktion,
  // also muss er den Erledigungstag genauso als Anker nehmen - und ihn vererben.
  const id = insertTask({
    title: 'Kaffeemaschine entkalken', status: 'open',
    start_date: dayKey(-5), due_date: dayKey(-3), created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY', recurrence_from_completion: 1,
  });
  const res = await call('PUT', `/${id}`, { title: 'Kaffeemaschine entkalken', status: 'done' });
  assert.equal(res.status, 200);

  const followup = openInstances('Kaffeemaschine entkalken')[0];
  assert.equal(followup.due_date, dayKey(7), 'eine Woche ab heute, nicht ab dem alten Raster');
  assert.equal(followup.recurrence_from_completion, 1, 'und der Anker reist mit');
  // Der Vorlauf hängt am Durchlauf, nicht am Anker: er bleibt derselbe, egal
  // woher das neue Fälligkeitsdatum kommt.
  assert.equal(followup.start_date, dayKey(5), 'zwei Tage vor der neuen Fälligkeit');
});

test('Die Folgeinstanz mit Vorlauf wartet auf ihren Starttag', async () => {
  // Folge des Vorlaufs, bewusst so: die Liste blendet Aufgaben bis zu ihrem
  // Startdatum aus. Wer den Vorlauf setzt, will die nächste Instanz erst dann
  // sehen - sichtbar wird sie über "Zukünftige Aufgaben anzeigen".
  const id = insertTask({
    title: 'Reifen wechseln', status: 'open',
    start_date: dayKey(-2), due_date: dayKey(-1), created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=MONTHLY',
  });
  await call('PATCH', `/${id}/status`, { status: 'done' });

  const hidden = await call('GET', '/?status=open');
  assert.ok(
    !hidden.body.data.some((t) => t.title === 'Reifen wechseln'),
    'Vor ihrem Starttag taucht die Folgeinstanz in der Standardliste nicht auf',
  );
  const shown = await call('GET', '/?status=open&include_future=1');
  assert.ok(
    shown.body.data.some((t) => t.title === 'Reifen wechseln'),
    'Mit "Zukünftige Aufgaben anzeigen" schon',
  );
});

test('PUT done: im selben Speichern gesetzter Anker gilt sofort', async () => {
  // Wer die Verankerung im Dialog umstellt und gleich abhakt, bekommt die
  // Folgeinstanz nach der neuen Wahl - der Spawn liest die frische Zeile.
  const id = insertTask({
    title: 'Kalkfilter tauschen', status: 'open', due_date: dayKey(-3), created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
  });
  await call('PUT', `/${id}`, {
    title: 'Kalkfilter tauschen', status: 'done', recurrence_from_completion: 1,
  });
  assert.equal(openInstances('Kalkfilter tauschen')[0].due_date, dayKey(7));
});

test('PATCH done: Subtask einer Serie erzeugt keine Folgeinstanz', async () => {
  const parent = insertTask({
    title: 'Eltern-Serie', status: 'open', due_date: dayKey(-7), created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
  });
  const sub = insertTask({
    title: 'Sub', status: 'open', due_date: dayKey(-7), created_by: uid,
    parent_task_id: parent, is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
  });
  await call('PATCH', `/${sub}/status`, { status: 'done' });
  const rows = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE title = 'Sub'`).get();
  assert.equal(rows.n, 1, 'Subtasks dürfen keine Folgeinstanz auslösen');
});

test('Subtasks einer Serie werden beim Spawnen der Folgeinstanz kopiert und zurückgesetzt (#742)', async () => {
  const parent = insertTask({
    title: 'Wöchentlicher Putztag', status: 'open', due_date: dayKey(-7), created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
  });
  const sub1 = insertTask({
    title: 'Bad putzen', status: 'done', due_date: dayKey(-7), created_by: uid,
    parent_task_id: parent,
  });
  const sub2 = insertTask({
    title: 'Küche wischen', status: 'open', due_date: dayKey(-7), created_by: uid,
    parent_task_id: parent,
  });

  // Elternaufgabe erledigen
  await call('PATCH', `/${parent}/status`, { status: 'done' });

  const newParents = openInstances('Wöchentlicher Putztag');
  assert.equal(newParents.length, 1, 'Folgeinstanz der Elternaufgabe wurde angelegt');
  const newParent = newParents[0];

  const subtasks = db.prepare('SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY id ASC').all(newParent.id);
  assert.equal(subtasks.length, 2, 'Beide Subtasks wurden in die Folgeinstanz kopiert');
  assert.equal(subtasks[0].title, 'Bad putzen');
  assert.equal(subtasks[0].status, 'open', 'Erledigte Subtask startet in der Folgeinstanz wieder als open');
  assert.equal(subtasks[1].title, 'Küche wischen');
  assert.equal(subtasks[1].status, 'open');
});

test('Rückgängig-Abhaken einer Serie mit unberührten Subtasks löscht die Folgeinstanz samt Subtasks (#742)', async () => {
  const parent = insertTask({
    title: 'Müll rausstellen', status: 'open', due_date: dayKey(-1), created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
  });
  insertTask({
    title: 'Gelbe Tonne', status: 'open', due_date: dayKey(-1), created_by: uid,
    parent_task_id: parent,
  });

  // Elternaufgabe erledigen -> Spawn der Folgeinstanz mit Subtask
  await call('PATCH', `/${parent}/status`, { status: 'done' });
  let newParents = openInstances('Müll rausstellen');
  assert.equal(newParents.length, 1);
  const followupId = newParents[0].id;

  // Erledigung rückgängig machen (ohne die neue Subtask berührt zu haben)
  await call('PATCH', `/${parent}/status`, { status: 'open' });
  newParents = openInstances('Müll rausstellen');

  const followupExists = db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(followupId);
  assert.equal(followupExists, undefined, 'Unberührte Folgeinstanz inklusive Subtasks wird verworfen');
});

test('Rückgängig-Abhaken einer Serie mit erledigter Subtask behält die Folgeinstanz (#742)', async () => {
  const parent = insertTask({
    title: 'Blumen gießen', status: 'open', due_date: dayKey(-1), created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
  });
  insertTask({
    title: 'Balkonpflanzen', status: 'open', due_date: dayKey(-1), created_by: uid,
    parent_task_id: parent,
  });

  // Elternaufgabe erledigen
  await call('PATCH', `/${parent}/status`, { status: 'done' });
  const newParent = openInstances('Blumen gießen')[0];

  // In der neuen Folgeinstanz wird die Subtask abgehakt
  const spawnedSub = db.prepare('SELECT id FROM tasks WHERE parent_task_id = ?').get(newParent.id);
  await call('PATCH', `/${spawnedSub.id}/status`, { status: 'done' });

  // Abhaken der ursprünglichen Elternaufgabe rückgängig machen
  await call('PATCH', `/${parent}/status`, { status: 'open' });

  const followupExists = db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(newParent.id);
  assert.ok(followupExists, 'Folgeinstanz bleibt erhalten, weil darin Arbeit erledigt wurde');
});

test('Eine bearbeitete (nicht erledigte) Subtask schützt die Folgeinstanz (#742)', async () => {
  const parent = insertTask({
    title: 'Review A', status: 'open', due_date: dayKey(-1), created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
  });
  insertTask({ title: 'Schritt', status: 'open', due_date: dayKey(-1), created_by: uid, parent_task_id: parent });

  await call('PATCH', `/${parent}/status`, { status: 'done' });
  const followup = openInstances('Review A')[0];
  const sub = db.prepare('SELECT id FROM tasks WHERE parent_task_id = ?').get(followup.id);

  // Der Benutzer arbeitet an der neuen Instanz: nicht abhaken, sondern verfeinern
  await call('PUT', `/${sub.id}`, { title: 'Schritt: mit Essigreiniger' });
  await call('PATCH', `/${parent}/status`, { status: 'open' });

  assert.ok(
    db.prepare('SELECT title FROM tasks WHERE id = ?').get(sub.id),
    'die eingegebene Arbeit darf nicht verschwinden',
  );
});

test('Erledigungsverankerte Serie ohne Fälligkeitsdatum datiert die Subtask neu (#742)', async () => {
  const parent = insertTask({
    title: 'Review B', status: 'open', created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY', recurrence_from_completion: 1,
  });
  insertTask({
    title: 'Teilschritt', status: 'open', start_date: dayKey(-30), due_date: dayKey(-30),
    created_by: uid, parent_task_id: parent,
  });

  await call('PATCH', `/${parent}/status`, { status: 'done' });
  const followup = openInstances('Review B')[0];
  const sub = db.prepare('SELECT start_date, due_date FROM tasks WHERE parent_task_id = ?').get(followup.id);

  assert.notEqual(sub.start_date, dayKey(-30), `start_date der neuen Subtask: ${sub.start_date}`);
});

// --------------------------------------------------------
// Das Enthaken einer Unteraufgabe ist keine Rücknahme der Serie (#924)
// --------------------------------------------------------
test('Enthaken einer Subtask der erledigten Instanz lässt die Folgeinstanz vollständig (#924)', async () => {
  const parent = insertTask({
    title: 'Wochenroutine', status: 'open', due_date: dayKey(-1), created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
  });
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
  const subs = names.map((title) => insertTask({
    title, status: 'open', due_date: dayKey(-1), created_by: uid, parent_task_id: parent,
  }));

  // Alpha und Charlie erledigen, dann die Elternaufgabe
  await call('PATCH', `/${subs[0]}/status`, { status: 'done' });
  await call('PATCH', `/${subs[2]}/status`, { status: 'done' });
  await call('PATCH', `/${parent}/status`, { status: 'done' });

  const followup = openInstances('Wochenroutine')[0];
  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM tasks WHERE parent_task_id = ?').get(followup.id).c, 4,
    'die Folgeinstanz startet mit allen vier Unteraufgaben',
  );

  // Auf der abgeschlossenen Instanz wird Alpha wieder enthakt
  await call('PATCH', `/${subs[0]}/status`, { status: 'open' });

  const remaining = db.prepare(
    'SELECT title FROM tasks WHERE parent_task_id = ? ORDER BY id',
  ).all(followup.id).map((r) => r.title);
  assert.deepEqual(
    remaining, names,
    'die Unteraufgabe der Folgeinstanz gehört dem neuen Durchlauf, nicht dem alten Haken',
  );
});

test('"ab Erledigung" behaelt sein Intervall, auch mit BYMONTHDAY=-1 (#960)', () => {
  // nextDueAfterCompletion reicht bei diesem Anker den Tag des Abhakens herein -
  // ein beliebiges Datum, das die Serie gar nicht kennt. Die Abkuerzung fuer
  // einen unsynchronisierten Serienstart darf dort nicht greifen, sonst wird
  // aus "alle drei Monate, erledigt am 10. Maerz" der 31. Maerz statt des
  // 30. Juni.
  assert.equal(nextDueAfterCompletion({
    anchorDate: '2026-01-31', rule: 'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=-1',
    completedOn: '2026-03-10', fromCompletion: true,
  }), '2026-06-30');

  assert.equal(nextDueAfterCompletion({
    anchorDate: '2026-01-31', rule: 'FREQ=MONTHLY;BYMONTHDAY=-1',
    completedOn: '2026-01-30', fromCompletion: true,
  }), '2026-02-28', 'ohne Intervall einen Monat weiter, nicht einen Tag');

  // Der andere Anker bleibt unveraendert: dort IST das Basisdatum ein Vorkommen.
  assert.equal(nextDueAfterCompletion({
    anchorDate: '2026-01-31', rule: 'FREQ=MONTHLY;BYMONTHDAY=-1',
    completedOn: '2026-02-02', fromCompletion: false,
  }), '2026-02-28');
});

// --------------------------------------------------------
// Die Antwort nennt, wann es weitergeht (#1603)
// --------------------------------------------------------
// Wer eine Serie abhakt, sah danach eine gleich aussehende offene Zeile und
// hielt den Haken fuer verschluckt. Die Oberflaeche kann nur sagen, wann es
// weitergeht, wenn die Antwort es traegt - die Folgeinstanz entsteht ja erst
// in dieser Anfrage.
test('PATCH done: die Antwort traegt die Faelligkeit der Folgeinstanz', async () => {
  const id = insertTask({
    title: 'Blumen giessen', status: 'open', due_date: dayKey(0), created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
  });
  const res = await call('PATCH', `/${id}/status`, { status: 'done' });
  assert.equal(res.status, 200);
  const followup = openInstances('Blumen giessen')[0];
  assert.ok(followup, 'Abhaken muss eine Folgeinstanz erzeugt haben');
  assert.equal(res.body.data.next_due_date, followup.due_date);
  assert.equal(res.body.data.next_due_date, dayKey(7));
  // Additiv: die zugesagten Felder stehen unveraendert daneben.
  assert.equal(res.body.data.id, Number(id));
  assert.equal(res.body.data.status, 'done');
  assert.ok('archived_at' in res.body.data);
});

test('PATCH done: "ab Erledigung" nennt den Tag ab heute, nicht die alte Faelligkeit', async () => {
  // Der Fall aus dem Ticket: morgen faellig, heute abgehakt. Die Folgeinstanz
  // rechnet ab heute - bei taeglicher Wiederholung also wieder morgen, und die
  // neue Zeile sieht aus wie die alte.
  const id = insertTask({
    title: 'Zimmer aufraeumen', status: 'open', due_date: dayKey(1), created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=DAILY', recurrence_from_completion: 1,
  });
  const res = await call('PATCH', `/${id}/status`, { status: 'done' });
  assert.equal(res.body.data.next_due_date, dayKey(1));
});

test('PATCH: ohne Serie, ohne Uebergang und beim Zuruecknehmen steht next_due_date auf null', async () => {
  const einmalig = insertTask({ title: 'Einmal', status: 'open', due_date: dayKey(0), created_by: uid });
  const einmal = await call('PATCH', `/${einmalig}/status`, { status: 'done' });
  assert.equal(einmal.body.data.next_due_date, null);

  const serie = insertTask({
    title: 'Altpapier', status: 'open', due_date: dayKey(0), created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
  });
  const gestartet = await call('PATCH', `/${serie}/status`, { status: 'in_progress' });
  assert.equal(gestartet.body.data.next_due_date, null, 'Starten ist kein Erledigen');
  const erledigt = await call('PATCH', `/${serie}/status`, { status: 'done' });
  assert.equal(erledigt.body.data.next_due_date, dayKey(7));
  // Kein Uebergang, also auch keine Quittung: sonst kaeme der Hinweis bei jedem
  // doppelten Tipp noch einmal.
  const doppelt = await call('PATCH', `/${serie}/status`, { status: 'done' });
  assert.equal(doppelt.body.data.next_due_date, null);
  const zurueck = await call('PATCH', `/${serie}/status`, { status: 'open' });
  assert.equal(zurueck.body.data.next_due_date, null);
});

test('PATCH done: eine Serie, die zu Ende ist, nennt kein naechstes Mal', async () => {
  const until = dayKey(1).replace(/-/g, '');
  const id = insertTask({
    title: 'Letzte Runde', status: 'open', due_date: dayKey(0), created_by: uid,
    is_recurring: 1, recurrence_rule: `FREQ=WEEKLY;UNTIL=${until}`,
  });
  const res = await call('PATCH', `/${id}/status`, { status: 'done' });
  assert.equal(res.status, 200);
  assert.equal(openInstances('Letzte Runde').length, 0);
  assert.equal(res.body.data.next_due_date, null);
});

test('PATCH done: bleibt eine bearbeitete Folgeinstanz stehen, nennt der zweite Haken sie', async () => {
  // Das Zuruecknehmen laesst eine Folgeinstanz stehen, an der jemand
  // gearbeitet hat. Der naechste Haken legt dann keine neue an - das naechste
  // Mal gibt es trotzdem, und es ist diese.
  const first = await completeRecurring('Regenrinne leeren', 'FREQ=WEEKLY');
  const second = openInstances('Regenrinne leeren')[0];
  insertTask({ title: 'Rahmen', status: 'open', created_by: uid, parent_task_id: second.id });
  await call('PATCH', `/${first}/status`, { status: 'open' });
  assert.ok(db.prepare('SELECT id FROM tasks WHERE id = ?').get(second.id), 'die Folgeinstanz blieb stehen');

  const res = await call('PATCH', `/${first}/status`, { status: 'done' });
  assert.equal(res.body.data.next_due_date, second.due_date);
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE title = 'Regenrinne leeren'`).get().n, 2,
    'und es ist keine zweite entstanden',
  );
});

test('PATCH done: ist die direkte Folgeinstanz schon erledigt, nennt die Antwort das offene Vorkommen dahinter', async () => {
  // `recurrence_origin_id` zeigt auf den DIREKTEN Vorgaenger, die Serie ist
  // eine Kette: A -> B -> C. Wer A wieder oeffnet, nachdem B erledigt wurde,
  // behaelt B (dort steckt Arbeit) - und beim erneuten Abhaken von A ist das
  // naechste Mal nicht B, sondern C. Nur das direkte Kind zu lesen hiess, hier
  // null zu melden, obwohl ein offenes Vorkommen dasteht (Review zu #1615).
  const a = await completeRecurring('Kompost leeren', 'FREQ=WEEKLY');
  const b = openInstances('Kompost leeren')[0];
  await call('PATCH', `/${b.id}/status`, { status: 'done' });
  const c = openInstances('Kompost leeren')[0];
  assert.equal(c.recurrence_origin_id, b.id, 'die Kette haengt am direkten Vorgaenger');
  assert.equal(b.recurrence_origin_id, a);

  await call('PATCH', `/${a}/status`, { status: 'open' });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(b.id).status, 'done', 'B blieb stehen');

  const res = await call('PATCH', `/${a}/status`, { status: 'done' });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.next_due_date, c.due_date);
  assert.equal(openInstances('Kompost leeren').length, 1, 'und es ist kein weiteres entstanden');
});

test('PATCH done: die Suche nach dem naechsten Vorkommen endet auch an einer Kette, die im Kreis laeuft', async () => {
  // Der Server baut keinen Kreis. Eine wiederhergestellte oder von Hand
  // bearbeitete Datenbank kann einen tragen, und ein Haken darf daran nicht
  // haengen bleiben: die Route ist synchron, eine Endlosschleife stuende fuer
  // den ganzen Prozess.
  const a = await completeRecurring('Kreislauf', 'FREQ=WEEKLY');
  const b = openInstances('Kreislauf')[0];
  db.prepare(`UPDATE tasks SET status = 'done' WHERE id = ?`).run(b.id);
  db.prepare('UPDATE tasks SET recurrence_origin_id = ? WHERE id = ?').run(b.id, a);
  await call('PATCH', `/${a}/status`, { status: 'open' });
  const res = await call('PATCH', `/${a}/status`, { status: 'done' });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.next_due_date, null);
});

test('PATCH done: das offene Vorkommen zaehlt auch hinter mehr als 500 erledigten', async () => {
  // Eine taegliche Serie hat nach anderthalb Jahren so viele Glieder. Eine
  // feste Obergrenze der Suche meldete dann null, obwohl das offene dasteht.
  const a = await completeRecurring('Blumen giessen', 'FREQ=DAILY');
  const b = openInstances('Blumen giessen')[0];
  let prev = a;
  for (let i = 0; i < 510; i += 1) {
    prev = insertTask({ title: 'Blumen giessen', status: 'done', created_by: uid, recurrence_origin_id: prev });
  }
  db.prepare('UPDATE tasks SET recurrence_origin_id = ? WHERE id = ?').run(prev, b.id);
  await call('PATCH', `/${a}/status`, { status: 'open' });
  const res = await call('PATCH', `/${a}/status`, { status: 'done' });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.next_due_date, b.due_date);
});

test('PATCH done: ein Vorkommen, das der Aufrufer nicht sieht, wird ihm nicht als naechstes Mal genannt', async () => {
  // Die Folgeinstanz erbt ihre Sichtbarkeit, laesst sich aber einzeln auf
  // privat stellen. Ihr Datum darf dann nicht ueber die Antwort auf das
  // Abhaken des frueheren, sichtbaren Vorkommens hinausgehen.
  const other = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
    VALUES ('kind-sicht', 'Kind', '$2b$12$x', 'member')`).run().lastInsertRowid;
  const a = await completeRecurring('Tagebuch', 'FREQ=WEEKLY');
  const b = openInstances('Tagebuch')[0];
  db.prepare(`UPDATE tasks SET visibility = 'private', created_by = ? WHERE id = ?`).run(uid, b.id);
  // B traegt Arbeit, das Zuruecknehmen laesst sie deshalb stehen.
  insertTask({ title: 'Seite 1', status: 'open', created_by: uid, parent_task_id: b.id });

  await call('PATCH', `/${a}/status`, { status: 'open' });
  const fremd = await call('PATCH', `/${a}/status`, { status: 'done' }, { 'x-test-user': String(other) });
  assert.equal(fremd.status, 200);
  assert.equal(fremd.body.data.next_due_date, null, 'wer B nicht sieht, erfaehrt ihr Datum nicht');

  await call('PATCH', `/${a}/status`, { status: 'open' });
  const eigen = await call('PATCH', `/${a}/status`, { status: 'done' });
  assert.equal(eigen.body.data.next_due_date, b.due_date, 'die Erstellerin sieht es weiter');
});

test('PATCH done: eine begonnene Folgeinstanz ist das naechste Mal, nicht uebersprungen', async () => {
  // „Steht noch an" heisst: nicht erledigt, nicht abgelegt - nicht: Status
  // genau 'open'. Eine Folgeinstanz, die jemand gestartet hat, bleibt beim
  // Zuruecknehmen stehen (verworfen wird nur eine unangetastete offene), der
  // zweite Haken legt deshalb keine neue an, und hinter ihr steht nichts.
  // Sie zu ueberspringen hiess null zu melden, obwohl sie dasteht (Review zu
  // #1615).
  const a = await completeRecurring('Aquarium reinigen', 'FREQ=WEEKLY');
  const b = openInstances('Aquarium reinigen')[0];
  await call('PATCH', `/${b.id}/status`, { status: 'in_progress' });
  await call('PATCH', `/${a}/status`, { status: 'open' });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(b.id).status, 'in_progress', 'B blieb stehen');

  const res = await call('PATCH', `/${a}/status`, { status: 'done' });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.next_due_date, b.due_date);
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE title = 'Aquarium reinigen'`).get().n, 2,
    'und es ist keine zweite entstanden',
  );
});

test('PATCH done: eine abgelegte Folgeinstanz zaehlt nicht, auch wenn ihr Status offen ist', async () => {
  // Die Gegenrichtung derselben Regel: Ablegen laesst den Status stehen (#688),
  // eine abgelegte offene Zeile sieht aber niemand - sie ist kein naechstes Mal.
  const a = await completeRecurring('Dachboden lueften', 'FREQ=WEEKLY');
  const b = openInstances('Dachboden lueften')[0];
  await call('PATCH', `/${b.id}/archive`, { archived: true });
  // B ist offen und unangetastet - das Zuruecknehmen verwuerfe sie. Der Fall,
  // der bleibt: sie traegt Arbeit (eine Unteraufgabe) und ist abgelegt.
  insertTask({ title: 'Leiter holen', status: 'open', created_by: uid, parent_task_id: b.id });
  await call('PATCH', `/${a}/status`, { status: 'open' });
  assert.ok(db.prepare('SELECT id FROM tasks WHERE id = ?').get(b.id), 'B blieb stehen');
  const res = await call('PATCH', `/${a}/status`, { status: 'done' });
  assert.equal(res.body.data.next_due_date, null);
});

// --------------------------------------------------------
// PUT /:id nennt das naechste Mal nach derselben Regel (#1620)
// --------------------------------------------------------
// Das Status-Feld im Bearbeiten-Formular speichert ueber PUT, hakt damit
// genauso ab wie die Checkbox und legt genauso die Folgeinstanz an. Die
// Antwort trug das Datum aber nicht, das Formular konnte also nur „gespeichert"
// sagen. Die Regel ist dieselbe wie bei PATCH und steht nur einmal im Server
// (`nextDueDateAfter`); hier wird gemessen, dass PUT sie auch wirklich fragt.
test('PUT done: die Antwort traegt die Faelligkeit der Folgeinstanz, neben der ganzen Aufgabe', async () => {
  const id = insertTask({
    title: 'Hecke schneiden', status: 'open', due_date: dayKey(0), created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
  });
  const res = await call('PUT', `/${id}`, { title: 'Hecke schneiden', status: 'done' });
  assert.equal(res.status, 200);
  const followup = openInstances('Hecke schneiden')[0];
  assert.ok(followup, 'das Speichern muss eine Folgeinstanz erzeugt haben');
  assert.equal(res.body.data.next_due_date, followup.due_date);
  assert.equal(res.body.data.next_due_date, dayKey(7));
  // Additiv: die Antwort bleibt die ganze Aufgabe.
  assert.equal(res.body.data.id, Number(id));
  assert.equal(res.body.data.status, 'done');
  assert.equal(res.body.data.title, 'Hecke schneiden');
  assert.ok(Array.isArray(res.body.data.subtasks));
});

test('PUT: ohne Statuswechsel, ohne Serie und beim Zuruecknehmen steht next_due_date auf null', async () => {
  const serie = insertTask({
    title: 'Rasen maehen', status: 'open', due_date: dayKey(0), created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
  });
  // Das Feld ist IMMER da, auch wenn es nichts zu sagen gibt - `undefined`
  // hiesse „aelterer Server", null heisst „kein naechstes Mal".
  const titel = await call('PUT', `/${serie}`, { title: 'Rasen maehen' });
  assert.equal(titel.status, 200);
  assert.strictEqual(titel.body.data.next_due_date, null, 'eine Titelkorrektur ist kein Erledigen');
  const gestartet = await call('PUT', `/${serie}`, { title: 'Rasen maehen', status: 'in_progress' });
  assert.strictEqual(gestartet.body.data.next_due_date, null, 'Starten ist kein Erledigen');

  const erledigt = await call('PUT', `/${serie}`, { title: 'Rasen maehen', status: 'done' });
  assert.equal(erledigt.body.data.next_due_date, dayKey(7));
  // Kein Uebergang: wer eine erledigte Serie noch einmal speichert (etwa den
  // Titel korrigiert), bekommt den Hinweis nicht ein zweites Mal - obwohl die
  // Folgeinstanz dasteht.
  const nochmal = await call('PUT', `/${serie}`, { title: 'Rasen maehen (vorn)', status: 'done' });
  assert.equal(openInstances('Rasen maehen').length, 1, 'die Folgeinstanz steht da');
  assert.strictEqual(nochmal.body.data.next_due_date, null);
  const zurueck = await call('PUT', `/${serie}`, { title: 'Rasen maehen', status: 'open' });
  assert.strictEqual(zurueck.body.data.next_due_date, null);

  const einmalig = insertTask({ title: 'Einmal per PUT', status: 'open', due_date: dayKey(0), created_by: uid });
  const einmal = await call('PUT', `/${einmalig}`, { title: 'Einmal per PUT', status: 'done' });
  assert.strictEqual(einmal.body.data.next_due_date, null, 'ohne Serie gibt es kein naechstes Mal');
});

test('PUT done: eine Serie, die zu Ende ist, nennt kein naechstes Mal', async () => {
  const until = dayKey(1).replace(/-/g, '');
  const id = insertTask({
    title: 'Letzte Runde PUT', status: 'open', due_date: dayKey(0), created_by: uid,
    is_recurring: 1, recurrence_rule: `FREQ=WEEKLY;UNTIL=${until}`,
  });
  const res = await call('PUT', `/${id}`, { title: 'Letzte Runde PUT', status: 'done' });
  assert.equal(res.status, 200);
  assert.equal(openInstances('Letzte Runde PUT').length, 0);
  assert.strictEqual(res.body.data.next_due_date, null);
});

test('PUT done: ein Vorkommen, das der Aufrufer nicht sieht, wird ihm nicht als naechstes Mal genannt', async () => {
  // Derselbe Fall wie bei PATCH, ueber den anderen Weg: B ist privat gestellt
  // und traegt Arbeit, bleibt beim Zuruecknehmen also stehen.
  const other = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
    VALUES ('kind-sicht-put', 'Kind', '$2b$12$x', 'member')`).run().lastInsertRowid;
  const a = await completeRecurring('Tagebuch PUT', 'FREQ=WEEKLY');
  const b = openInstances('Tagebuch PUT')[0];
  db.prepare(`UPDATE tasks SET visibility = 'private', created_by = ? WHERE id = ?`).run(uid, b.id);
  insertTask({ title: 'Seite 1 PUT', status: 'open', created_by: uid, parent_task_id: b.id });

  await call('PATCH', `/${a}/status`, { status: 'open' });
  const fremd = await call('PUT', `/${a}`, { title: 'Tagebuch PUT', status: 'done' }, { 'x-test-user': String(other) });
  assert.equal(fremd.status, 200);
  assert.equal(fremd.body.data.status, 'done', 'der Wechsel selbst ging durch');
  assert.strictEqual(fremd.body.data.next_due_date, null, 'wer B nicht sieht, erfaehrt ihr Datum nicht');

  await call('PATCH', `/${a}/status`, { status: 'open' });
  const eigen = await call('PUT', `/${a}`, { title: 'Tagebuch PUT', status: 'done' });
  assert.equal(eigen.body.data.next_due_date, b.due_date, 'die Erstellerin sieht es weiter');
});

test('PUT und PATCH fragen dieselbe Regel: die Route formuliert sie nicht ein zweites Mal aus', async () => {
  // Zwei Ausformulierungen laufen auseinander - #1615 hat die Regel in vier
  // Runden nachgeschaerft (Kette, begonnen, abgelegt, Sichtbarkeit), und jede
  // davon haette eine Kopie verfehlt. Gemessen am Quelltext: die Kettensuche
  // hat genau EINEN Aufrufer, und beide Routen gehen durch ihn.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../server/routes/tasks.js', import.meta.url), 'utf8');
  const walkers = [...src.matchAll(/(?<!function )nextPendingOccurrenceOf\(/g)];
  assert.equal(walkers.length, 1, 'nur der geteilte Helfer liest die Kette');
  const callers = [...src.matchAll(/(?<!function )nextDueDateAfter\(req, /g)];
  assert.equal(callers.length, 2, 'PUT und PATCH rufen den geteilten Helfer');
  const routeOf = (index) => [...src.slice(0, index).matchAll(/^router\.(\w+)\('([^']+)'/gm)].at(-1).slice(1, 3).join(' ');
  assert.deepEqual(callers.map((m) => routeOf(m.index)).sort(), ['patch /:id/status', 'put /:id']);
});
