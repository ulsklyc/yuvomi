/**
 * Modul: Tasks-Rotation-Test
 * Zweck: Rotation fuer wiederkehrende Serien (migration 274, upstream #1763).
 * Nur die feste Reihenfolge: Modus, Pool, und ein Zeiger, der eine POSITION
 * im Pool ist - kein Kopf. Die Zusicherungen:
 * - Der Zeiger ueberlebt Abgaenge. Anna geht nach Kevins Runde; die
 *   sichtbare Reihenfolge bleibt Kevin, Max, Kevin - nie wieder still Anna,
 *   nie ein stiller Neustart vorn (die Acceptance aus #1763). Der alte Test
 *   'letzter Nutzer nicht mehr im Pool -> wieder vorn' hielt genau das
 *   Gegenteil fest und ist durch diesen Fall ersetzt.
 * - Deaktivierte Koepfe (#1381) bekommen nichts ab.
 * - Die erste Abloesung beginnt an der Position der laufenden Instanz: haelt
 *   Kevin die Aufgabe, ist der Naechste nicht Kevin (Kevin, Anna, Max - nicht
 *   Kevin, Kevin), und die mittlere Person bekommt nicht zweimal (Review zur
 *   zweiten Runde: Anna, Kevin, Anna, Max war der alte Verlauf).
 * - Niemand bekommt die naechste Instanz zweimal hintereinander - auch nicht
 *   nach einem Umsortieren, das den letzten Kopf nach vorn stellt (#1763).
 * - Offene Fragen aus #1763, als Test gestellt: Hakt eine ANDERE Person ab,
 *   rueckt der Zeiger trotzdem (Rotation folgt der Serie). Wird die
 *   Reihenfolge mitten in der Serie geaendert, laeuft der Zeiger auf seiner
 *   Position weiter - kein Reset.
 * Integration: Abhaken haengt die Folgeinstanz an das naechste Mitglied -
 * Modus, Pool und Zeiger reisen als Wert mit (#1603-Prinzip); ohne Rotation
 * bleibt das Verhalten exakt das bisherige (Assignment-Kopie).
 * Ausführen: node --test test/test-task-rotation.js
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';

const { MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { pickRotationUser, setRotation, nextRotationEntry } = await import('../server/services/task-rotation.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');

const DAY = 86400000;
const dayKey = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

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
function mkUser(name) {
  return db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, '$2b$12$x', 'member')`).run(name, name).lastInsertRowid;
}
const u2 = mkUser('zwei');
const u3 = mkUser('drei');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = uid;
  req.session = { userId: uid, role: 'admin' };
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
  return db.prepare(
    `INSERT INTO tasks (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  ).run(...cols.map((c) => fields[c])).lastInsertRowid;
}

/** Serie mit fester Reihenfolge; assigned_to traegt pool[0], der Zeiger ist null. */
function insertRecurringSeries(title, pool, { assignedTo = pool[0] } = {}) {
  const id = insertTask({
    title, category: 'Haushalt', priority: 'medium', status: 'open',
    due_date: dayKey(0), assigned_to: assignedTo, created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
    rotation_mode: 'round_robin',
  });
  setRotation(db, id, { mode: 'round_robin', pool });
  db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(id, assignedTo);
  return id;
}

function setPointer(taskId, { user, position }) {
  db.prepare('UPDATE tasks SET rotation_last_user = ?, rotation_last_position = ? WHERE id = ?')
    .run(user ?? null, position ?? null, taskId);
}

function completeTask(id, extra = {}) {
  return call('PATCH', `/${id}/status`, { status: 'done', ...extra });
}

function followupOf(originId, title) {
  return db.prepare(
    `SELECT * FROM tasks WHERE title = ? AND status = 'open' AND recurrence_origin_id = ?`,
  ).get(title, originId);
}

// --------------------------------------------------------
// Unit: nextRotationEntry / pickRotationUser
// --------------------------------------------------------

test('round_robin: der Zeiger ist eine Position - Nachfolger, dann Runde wieder vorn', () => {
  const id = insertRecurringSeries('rr-basis', [u2, u3, uid], { assignedTo: u3 });
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  // Kein Zeiger: die Zahlung beginnt an der Position der laufenden Instanz -
  // die Runde laeuft von u3 (Position 1) weiter, nicht still zurueck nach vorn
  // (die alte "vorn"-Regel gab der mittleren Person die naechste Instanz
  // gleich zweimal im Verlauf: Anna, Kevin, Anna, Max).
  assert.equal(pickRotationUser(db, task), uid);
  // Zeiger auf der zweiten Position: der dritte Kopf ist dran.
  assert.equal(pickRotationUser(db, { ...task, rotation_last_position: 1 }), uid);
  // Am Pool-Ende schliesst die Runde in die erste Position - keine doppelte Runde.
  assert.equal(pickRotationUser(db, { ...task, rotation_last_position: 2 }), u2);
});

test('die erste Abloesung: pool[0] hat schon - die naechste geht an den zweiten Kopf', () => {
  // Kevin, Anna, Max - nicht Kevin, Kevin. Die laufende Instanz gehoert dem
  // ersten Kopf, ein Zeiger fehlt: das Abhaken darf nicht dieselbe Person
  // nochmal antreten lassen.
  const id = insertRecurringSeries('rr-erste', [u2, u3, uid]);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  assert.equal(pickRotationUser(db, task), u3, 'zweiter statt zweiter Erster');
});

test('ein Zeiger ueber dem Pool faellt in die erste Position, nicht in eine zweite Nullrunde', () => {
  // Der Member hinter Position 5 ist laengst raus, der Pool ist auf zwei
  // Koepte geschrumpft: ueberlaufener Zeiger = Runde schliessen wie jeder
  // andere Zeiger am Ende auch.
  const id = insertRecurringSeries('rr-ueberlauf', [u2, u3]);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  assert.equal(pickRotationUser(db, { ...task, rotation_last_position: 5 }), u2);
});

test('rotation_last_user ist Information: die Reihenfolge liest nur die Position', () => {
  // Der Kopf sagt "Anna war zuletzt dran", der Zeiger sagt Position 1 (Kevin).
  // Der alte Bug war genau dieses Lesen des Kopfes - nach Annas Rauswurf gab
  // indexOf(-1) einen Neustart vorn. Der Zeiger gewinnt.
  const id = insertRecurringSeries('rr-info', [u2, u3, uid], { assignedTo: u3 });
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  assert.equal(
    pickRotationUser(db, { ...task, rotation_last_user: u2, rotation_last_position: 1 }),
    uid, 'Position 1 -> Position 2, der Kopf wird ignoriert');
});

test('Abgang aus dem Pool verschiebt den Zeiger nicht: Kevin, Max, Kevin', () => {
  // Die Acceptance aus #1763. Pool Anna, Kevin, Max; Anna geht nach Kevins
  // Runde. Die FKs (CASCADE am Pool) loeschen ihre Zeile - der Positionen-
  // Zeiger bleibt, wo er steht, und die sichtbare Reihenfolge laeuft weiter.
  const anna = mkUser('anna');
  const kevin = mkUser('kevin');
  const max = mkUser('max');
  const id = insertRecurringSeries('rr-abgang', [anna, kevin, max]);
  // Kevins Runde: der Zeiger steht auf Position 1 (Kevins Zeile).
  setPointer(id, { user: kevin, position: 1 });
  db.prepare('DELETE FROM task_rotation_pool WHERE task_id = ? AND user_id = ?').run(id, anna);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  assert.equal(pickRotationUser(db, task), max, 'nach Kevin: Max, nicht wieder vorn');
  assert.equal(
    pickRotationUser(db, { ...task, rotation_last_position: 2, rotation_last_user: max }),
    kevin, 'nach Max: Kevin - nie wieder still Anna');
});

test('deaktivierte Koepfe (#1381) bekommen nichts ab', () => {
  // Das mittlere Mitglied ist deaktiviert: an ihm geht die Runde vorbei, egal
  // wo der Zeiger steht. Die Zeile bleibt (es kann zurueckkommen), nur die
  // Wahl ueberspringt es.
  const a = mkUser('d-a');
  const weg = mkUser('d-weg');
  const b = mkUser('d-b');
  const id = insertRecurringSeries('rr-deaktiv', [a, weg, b]);
  db.prepare("UPDATE users SET deactivated_at = '2026-10-30T10:00:00Z' WHERE id = ?").run(weg);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  assert.equal(pickRotationUser(db, { ...task, rotation_last_position: 0 }), b,
    'hinter a kaeme das deaktivierte mittlere Glied - die Wahl nimmt b');
  assert.equal(pickRotationUser(db, task), b,
    'erste Abloesung: a haelt schon, das naechste AKTIVE Glied ist b');
  assert.equal(pickRotationUser(db, { ...task, rotation_last_position: 2 }), a,
    'am Ende schliesst die Runde in das erste aktive Glied');
});

test('kein Pool unter zwei Zeilen; ein aktiver Restkopf aber bekommt die Instanz', () => {
  const id = insertRecurringSeries('klein', [u2]);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  assert.equal(pickRotationUser(db, task), null, 'unter zwei Zeilen ist Rotation die alte Zuordnung in anderem Kostuem');
  const p1 = mkUser('klein-1');
  const p2 = mkUser('klein-2');
  const id2 = insertRecurringSeries('klein-aktiv', [p1, p2]);
  db.prepare("UPDATE users SET deactivated_at = '2026-10-30T10:00:00Z' WHERE id = ?").run(p2);
  const t2 = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id2);
  // Review should-fix (a): zwei Koepfe im Pool, einer deaktiviert - null
  // hiesse, die naechste Instanz bliebe beim Deaktivierten, den niemand
  // erreichen kann. Der verbleibende Aktive bekommt sie.
  assert.equal(pickRotationUser(db, { ...t2, rotation_last_position: 0, rotation_last_user: p1 }), p1,
    'der einzige aktive Kopf bekommt die naechste Instanz');
  assert.equal(pickRotationUser(db, { ...t2, rotation_last_position: null, assigned_to: p2 }), p1,
    'auch ohne Zeiger: von der laufenden (deaktivierten) Person weg an den Aktiven');
});

test('Modus null: Rotation aus, egal welcher Pool', () => {
  const id = insertTask({
    title: 'aus', category: 'Haushalt', priority: 'medium', status: 'open',
    due_date: dayKey(0), assigned_to: uid, created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
  });
  setRotation(db, id, { mode: null, pool: [uid, u2] });
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  assert.equal(pickRotationUser(db, task), null);
});

test('nextRotationEntry ist die reine Rechnung unter der Liste und dem Detail', () => {
  const rows = [
    { user_id: 7, position: 0, active: 1 },
    { user_id: 8, position: 2, active: 0 },
    { user_id: 9, position: 3, active: 1 },
  ];
  assert.equal(nextRotationEntry(rows, { pointer: 0 }).user_id, 9, 'deaktivierte Zeile 8 wird uebersprungen');
  assert.equal(nextRotationEntry(rows, { pointer: null, assignee: 7 }).user_id, 9,
    'erste Abloesung: 7 haelt schon, der Naechste ist 9');
  assert.equal(nextRotationEntry(rows, { pointer: null, assignee: null }).user_id, 7,
    'ohne laufende Person beginnt die Runde vorn');
});

// --------------------------------------------------------
// Integration: Abhaken mit Rotation
// --------------------------------------------------------

test('round_robin ueber drei Abhak-Runden: Kevin, Anna, Max (erste Abloesung inklusive)', async () => {
  const kevin = u2; const anna = u3; const max = mkUser('max-runde');
  const first = insertRecurringSeries('Muell rotierend', [kevin, anna, max]);
  // Die erste Instanz haelt Kevin schon (pool[0]) - die erste Folgeinstanz
  // darf nicht Kevin bleiben, sie geht an Anna.
  await completeTask(first);
  const f1 = followupOf(first, 'Muell rotierend');
  assert.ok(f1, 'erste Folgeinstanz fehlt');
  assert.equal(f1.assigned_to, anna, 'Kevin, Kevin? Nein: Kevin, Anna');
  assert.equal(f1.rotation_last_position, 1, 'der Zeiger steht auf Annas Position');
  assert.equal(f1.rotation_last_user, anna, 'der Kopf reist als Information mit');
  assert.deepEqual(
    db.prepare('SELECT user_id FROM task_assignments WHERE task_id = ? ORDER BY user_id').all(f1.id)
      .map((r) => r.user_id),
    [anna], 'Rotation setzt genau einen Empfaenger');
  assert.equal(f1.rotation_mode, 'round_robin', 'Modus reist als Wert mit');
  assert.deepEqual(
    db.prepare('SELECT user_id FROM task_rotation_pool WHERE task_id = ? ORDER BY position')
      .all(f1.id).map((r) => r.user_id),
    [kevin, anna, max], 'Pool reist als Wert mit');

  await completeTask(f1.id);
  const f2 = followupOf(f1.id, 'Muell rotierend');
  assert.ok(f2);
  assert.equal(f2.assigned_to, max);
  await completeTask(f2.id);
  const f3 = followupOf(f2.id, 'Muell rotierend');
  assert.equal(f3.assigned_to, kevin, 'nach Max wieder Kevin - die Runde schliesst, der Zeiger folgt');
});

test('hakt eine ANDERE Person ab, rueckt der Zeiger trotzdem weiter (#1763, Frage eins)', async () => {
  // Rotation folgt der Serie, nicht der Person, die abhakt: der Completer
  // kommt in der Rechnung nirgends vor. Admin (nicht im Pool) erledigt mit
  // done_by_user_id - die Folgeinstanz geht trotzdem an das naechste Mitglied.
  const first = insertRecurringSeries('Herkunft zaehlt', [u2, u3], { assignedTo: u2 });
  setPointer(first, { user: u2, position: 0 });
  const res = await completeTask(first, { done_by_user_id: uid });
  assert.equal(res.status, 200);
  const f = followupOf(first, 'Herkunft zaehlt');
  assert.equal(f.assigned_to, u3, 'u2 -> u3, obwohl der Admin abhackte');
  assert.equal(f.rotation_last_position, 1);
});

test('Reihenfolge mitten in der Serie geaendert: der Zeiger laeuft weiter, kein Reset (#1763, Frage zwei)', async () => {
  // Kevin haelt die laufende Instanz (Zeiger auf Position 1). Die Reihenfolge
  // wird auf [Max, Kevin, Anna] umgestellt - die Positionen werden neu
  // zugeteilt, der Zeiger bleibt auf 1 stehen und die naechste Wahl liegt auf
  // Position 2 (Anna). Kein Neustart auf den neuen ersten Kopf (Max).
  const anna = u2; const kevin = u3; const max = mkUser('max-order');
  const first = insertRecurringSeries('Ordnung mitten', [anna, kevin, max], { assignedTo: kevin });
  setPointer(first, { user: kevin, position: 1 });
  const upd = await call('PUT', `/${first}`, { title: 'Ordnung mitten', rotation_pool: [max, kevin, anna] });
  assert.equal(upd.status, 200);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(first);
  assert.equal(task.rotation_last_position, 1, 'der Tausch laesst den Zeiger stehen');
  assert.equal(pickRotationUser(db, task), anna, 'Zeiger 1 -> neu zugeteilte Position 2');
  await completeTask(first);
  const f = followupOf(first, 'Ordnung mitten');
  assert.equal(f.assigned_to, anna, 'die Abhak-Kette nimmt denselben Schritt');
});

// --- Review needed 4: niemand zweimal hintereinander nach einem Umsortieren ---

test('Umsortieren stellt den letzten Kopf nicht erneut an: Kevin, Anna, Max -> Anna, Kevin, Max ergibt Anna', async () => {
  // Reproduktion aus der zweiten Review: Pool Kevin, Anna, Max; Kevin hat die
  // laufende Instanz (Zeiger 0). Neue Ordnung Anna, Kevin, Max - die reine
  // Positionswahl ("erste Position ueber dem Zeiger") tippte auf Kevin zurueck.
  // Die Wahl ueberspringt den Kopf der letzten Runde: Anna bekommt die
  // naechste Instanz - auf dem Unit-Weg wie auf der Abhak-Route.
  const kevin = mkUser('kd-kevin');
  const anna = mkUser('kd-anna');
  const max = mkUser('kd-max');
  const id = insertRecurringSeries('kd-umsortiert', [kevin, anna, max], { assignedTo: kevin });
  setPointer(id, { user: kevin, position: 0 });
  const upd = await call('PUT', `/${id}`, {
    title: 'kd-umsortiert', rotation_mode: 'round_robin', rotation_pool: [anna, kevin, max],
  });
  assert.equal(upd.status, 200);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  assert.equal(task.rotation_last_position, 0, 'das Umsortieren laesst den Zeiger stehen');
  assert.equal(pickRotationUser(db, task), anna, 'Anna, nicht Kevin - die neue Ordnung darf nicht zweimal geben');
  await completeTask(id);
  const f = followupOf(id, 'kd-umsortiert');
  assert.equal(f.assigned_to, anna, 'die Abhak-Kette nimmt denselben Schritt');
});

test('erste Abloesung aus der Pool-Mitte: Anna, Kevin, Anna, Max wird Anna, Max, Kevin', async () => {
  // Reproduktion should-fix (b): die laufende Instanz haelt die mittlere
  // Person. Die alte Regel ("sonst beginnt die Runde vorn") lieferte
  // Anna, Kevin, Anna, Max - die Mittlere zweimal. Startet die Zahlung an
  // ihrer Position, stimmt die Reihe: Anna, Max, Kevin, Anna.
  const kevin = mkUser('mb-kevin');
  const anna = mkUser('mb-anna');
  const max = mkUser('mb-max');
  const first = insertRecurringSeries('mb-mitte', [kevin, anna, max], { assignedTo: anna });
  await completeTask(first);
  const f1 = followupOf(first, 'mb-mitte');
  assert.equal(f1.assigned_to, max, 'nicht zurueck nach vorn zu Kevin - die Reihe laeuft ab Annas Position');
  await completeTask(f1.id);
  const f2 = followupOf(f1.id, 'mb-mitte');
  assert.equal(f2.assigned_to, kevin);
  await completeTask(f2.id);
  const f3 = followupOf(f2.id, 'mb-mitte');
  assert.equal(f3.assigned_to, anna, 'die Runde schliesst in Anna');
});

test('Abgang mitten in der laufenden Kette: die Folgeinstanzen folgen Kevin, Max, Kevin', async () => {
  // Wie der Unit-Fall, aber durch die echten Routen: Abhaken, Rauswurf,
  // Abhaken. Die FKs (CASCADE) treffen die laufende Instanz - der
  // Positionen-Zeiger an ihrem Kopf laesst die Kette trotzdem weiterlaufen.
  const anna = mkUser('anna-kette');
  const kevin = mkUser('kevin-kette');
  const max = mkUser('max-kette');
  const first = insertRecurringSeries('Kette', [anna, kevin, max]);
  await completeTask(first); // Anna haelt pool[0] -> erste Abloesung: Kevin
  const f1 = followupOf(first, 'Kette');
  assert.equal(f1.assigned_to, kevin);
  db.prepare('DELETE FROM task_rotation_pool WHERE task_id = ? AND user_id = ?').run(f1.id, anna);
  await completeTask(f1.id);
  const f2 = followupOf(f1.id, 'Kette');
  assert.equal(f2.assigned_to, max, 'nach Kevins Runde: Max');
  await completeTask(f2.id);
  const f3 = followupOf(f2.id, 'Kette');
  assert.equal(f3.assigned_to, kevin, 'nach Max: Kevin - nicht still wieder vorn');
  assert.notEqual(f3.assigned_to, anna, 'nie wieder still Anna');
});

test('deaktivierter Kopf in der Kette: die Abhak-Runde geht an ihm vorbei', async () => {
  const weg = mkUser('kette-weg');
  const first = insertRecurringSeries('Kette deaktiv', [u2, u3, weg]);
  db.prepare("UPDATE users SET deactivated_at = '2026-10-30T10:00:00Z' WHERE id = ?").run(weg);
  await completeTask(first); // u2 haelt pool[0] -> u3
  const f1 = followupOf(first, 'Kette deaktiv');
  assert.equal(f1.assigned_to, u3);
  await completeTask(f1.id); // ueber das deaktivierte Glied hinweg zurueck an u2
  const f2 = followupOf(f1.id, 'Kette deaktiv');
  assert.equal(f2.assigned_to, u2, 'der Deaktivierte bekommt keine Instanz');
  assert.notEqual(f2.rotation_last_user, weg);
});

test('ohne Rotation: Assignment-Kopie wie bisher (Regression)', async () => {
  const id = insertTask({
    title: 'ohne rotation', category: 'Haushalt', priority: 'medium', status: 'open',
    due_date: dayKey(0), assigned_to: uid, created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
  });
  db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(id, uid);
  await completeTask(id);
  const f = followupOf(id, 'ohne rotation');
  assert.ok(f);
  assert.equal(f.assigned_to, uid);
  assert.equal(f.rotation_mode, null);
  assert.equal(f.rotation_pool ?? null, null, 'kein Pool geschrieben');
  assert.equal(f.rotation_next_user ?? null, null);
});

// --------------------------------------------------------
// API: Validierung
// --------------------------------------------------------

test('POST ohne Regel, aber mit Modus -> 400', async () => {
  const res = await call('POST', '/', {
    title: 'kaputt', rotation_mode: 'round_robin', rotation_pool: [uid, u2],
  });
  assert.equal(res.status, 400);
});

test('POST Modus ohne Pool -> 400; fremde user_id im Pool -> 400', async () => {
  const r1 = await call('POST', '/', {
    title: 'p1', is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY', rotation_mode: 'round_robin',
  });
  assert.equal(r1.status, 400);
  const r2 = await call('POST', '/', {
    title: 'p2', is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
    rotation_mode: 'round_robin', rotation_pool: [uid, 9999],
  });
  assert.equal(r2.status, 400);
});

test('POST Modus ausserhalb des Wortschatzes -> 400 (nur die feste Reihenfolge)', async () => {
  const res = await call('POST', '/', {
    title: 'p3', is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
    rotation_mode: 'least_assigned', rotation_pool: [uid, u2],
  });
  assert.equal(res.status, 400, 'die entfernten Modi sind kein Vokabular mehr (#1763)');
});

// --- Review needed 5: ein normaler Speichervorgang verschiebt die Positionen nicht ---

test('ein Titel-Save laesst Positionen, Zeiger und deaktivierte Pool-Mitglieder in Ruhe', async () => {
  // Reproduktion aus der zweiten Review: der Dialog sendet rotation_pool bei
  // jedem Speichern mit - und zeigt dabei nur die aktiven Koepfe. Das alte
  // setRotation teilte 0..n-1 neu aus: der Zeiger zeigte still auf eine
  // andere Person, und das nicht sichtbare deaktivierte Mitglied flog raus.
  // Der Merge (services/task-rotation.js) macht aus dem Dialog-Rumpf wieder
  // den Bestand: Request = Bestand, Positionen und Zeiger unbewegt.
  const a = mkUser('pt-a');
  const geist = mkUser('pt-geist');
  const b = mkUser('pt-b');
  const id = insertRecurringSeries('pt-titel', [a, geist, b]);
  db.prepare("UPDATE users SET deactivated_at = '2026-10-30T10:00:00Z' WHERE id = ?").run(geist);
  setPointer(id, { user: b, position: 2 });
  const stored = () => db.prepare('SELECT user_id FROM task_rotation_pool WHERE task_id = ? ORDER BY position')
    .all(id).map((r) => r.user_id);
  assert.deepEqual(stored(), [a, geist, b], 'Ausgangslage: Bestand mit deaktiviertem Mittelglied');
  const vorHer = pickRotationUser(db, db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));

  // Der Dialog-Rumpf: Titel editiert, Pool in aktiver Sicht (ohne den Geist),
  // Modus mitgeschickt - dieselbe Member-Menge wie gespeichert.
  const upd = await call('PUT', `/${id}`, {
    title: 'pt-titel neu', rotation_mode: 'round_robin', rotation_pool: [a, b],
  });
  assert.equal(upd.status, 200);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  assert.equal(task.title, 'pt-titel neu', 'der Titel ist natuerlich gespeichert');
  assert.equal(task.rotation_last_position, 2, 'der Titel-Save laesst den Zeiger stehen');
  assert.equal(task.rotation_last_user, b);
  assert.deepEqual(stored(), [a, geist, b], 'der Pool kommt unveraendert zurueck - auch der Geist bleibt an seinem Rang');
  assert.equal(pickRotationUser(db, task), vorHer, 'die naechste Abloesung bleibt dieselbe');

  // Should-fix (c): ein Client, der das volle GET (Pool inklusive Geist)
  // unveraendert zurueckschickt, darf nicht an der Deaktivierung scheitern.
  const rt = await call('PUT', `/${id}`, { title: 'pt-titel neu', rotation_pool: [a, geist, b] });
  assert.equal(rt.status, 200, 'der zurueckgeschickte GET-Pool ist keine Neuwahl');
  assert.deepEqual(stored(), [a, geist, b]);
  assert.equal(db.prepare('SELECT rotation_last_position FROM tasks WHERE id = ?').get(id).rotation_last_position, 2);
});

test('POST gueltig: Modus + Pool erreichbar, PUT-tausch behaelt Modus und Zeiger', async () => {
  const res = await call('POST', '/', {
    title: 'put-tausch', is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
    rotation_mode: 'round_robin', rotation_pool: [uid, u2],
  });
  assert.equal(res.status, 201);
  const task = res.body.data;
  assert.equal(task.rotation_mode, 'round_robin');
  assert.deepEqual(task.rotation_pool, [uid, u2]);
  setPointer(task.id, { user: u2, position: 1 });
  const upd = await call('PUT', `/${task.id}`, {
    title: 'put-tausch', rotation_pool: [u2, u3],
  });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.data.rotation_mode, 'round_robin', 'Pool-Tausch loescht den Modus nicht');
  assert.deepEqual(upd.body.data.rotation_pool, [u2, u3]);
  assert.equal(upd.body.data.rotation_last_position, 1, 'der Tausch laesst den Zeiger stehen');
  const off = await call('PUT', `/${task.id}`, { title: 'put-tausch', rotation_mode: null });
  assert.equal(off.status, 200);
  assert.equal(off.body.data.rotation_mode, null);
  assert.equal(off.body.data.rotation_pool, null, 'Modus null loescht auch den Pool');
  assert.equal(off.body.data.rotation_last_position, null, 'und der Zeiger ist mit geloescht');
});

test('Rotation-Felder in der Liste: t.* + attachRotation (inklusive rotation_next_user)', async () => {
  const res = await call('GET', '/?status=open&limit=100');
  assert.equal(res.status, 200);
  const withRot = res.body.data.find((t) => t.title === 'Herkunft zaehlt');
  assert.ok(withRot, 'Liste liefert rotierende Aufgabe mit Modus');
  assert.ok(Array.isArray(withRot.rotation_pool));
  assert.ok('rotation_next_user' in withRot, 'der Server loest den Nachfolger auf');
  assert.ok(withRot.rotation_pool.includes(withRot.rotation_next_user) || withRot.rotation_next_user === null);
  const plain = res.body.data.find((t) => t.title === 'ohne rotation');
  assert.equal(plain.rotation_next_user ?? null, null);
});
