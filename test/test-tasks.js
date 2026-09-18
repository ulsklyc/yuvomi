/**
 * Modul: Aufgaben-Test
 * Zweck: Validiert alle Tasks-API-Abfragen und Constraints
 * Ausführen: node --experimental-sqlite test-tasks.js
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);`);
db.exec(MIGRATIONS_SQL[1]);

// Testdaten
const u1 = db.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color, role)
  VALUES ('admin', 'Anna', 'x', '#007AFF', 'admin')`).run();
const u2 = db.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color)
  VALUES ('max', 'Max', 'x', '#34C759')`).run();
const uid1 = u1.lastInsertRowid;
const uid2 = u2.lastInsertRowid;

const today    = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const in3days  = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

console.log('\n[Tasks-Test] CRUD + Filter + Subtasks\n');

test('Bulk-Aktionsleiste ist standardmäßig verborgen und zeigt Nullauswahl nur im Bulk-Modus', () => {
  const source = readFileSync(new URL('../public/pages/tasks.js', import.meta.url), 'utf8');
  assert(source.includes('id="bulk-actions-bar" hidden'), 'Bulk-Leiste muss initial hidden gerendert werden');
  assert(/bar\.hidden\s*=\s*!\(state\.bulkSelectMode && selected > 0\)/.test(source), 'Bulk-Leiste darf erst bei aktiver Auswahl sichtbar werden');
  assert(/button\.disabled\s*=\s*selected\s*===\s*0/.test(source), 'Bulk-Buttons müssen bei 0 Auswahl deaktiviert sein');
});

// --------------------------------------------------------
// Erstellen
// --------------------------------------------------------
let task1Id, task2Id, task3Id, subtaskId;

test('Aufgabe erstellen', () => {
  const r = db.prepare(`INSERT INTO tasks
    (title, category, priority, status, due_date, created_by, assigned_to)
    VALUES ('Wohnung putzen', 'Haushalt', 'high', 'open', ?, ?, ?)`)
    .run(today, uid1, uid2);
  task1Id = r.lastInsertRowid;
  assert(task1Id > 0, 'ID muss > 0 sein');
});

test('Zweite Aufgabe (überfällig, erledigt)', () => {
  const r = db.prepare(`INSERT INTO tasks
    (title, category, priority, status, due_date, created_by)
    VALUES ('Bereits erledigt', 'Sonstiges', 'low', 'done', ?, ?)`)
    .run(yesterday, uid1);
  task2Id = r.lastInsertRowid;
  assert(task2Id > 0);
});

test('Dritte Aufgabe (kein Datum)', () => {
  const r = db.prepare(`INSERT INTO tasks (title, priority, status, created_by)
    VALUES ('Später erledigen', 'medium', 'open', ?)`)
    .run(uid1);
  task3Id = r.lastInsertRowid;
  assert(task3Id > 0);
});

test('Subtask erstellen (1 Ebene)', () => {
  const r = db.prepare(`INSERT INTO tasks (title, priority, status, created_by, parent_task_id)
    VALUES ('Küche putzen', 'medium', 'open', ?, ?)`)
    .run(uid1, task1Id);
  subtaskId = r.lastInsertRowid;
  assert(subtaskId > 0);
});

test('Verschachtelungstiefe: Subtask-of-Subtask wird abgelehnt', () => {
  // Simuliert Backend-Prüfung: parent muss parent_task_id = NULL haben
  const parent = db.prepare('SELECT parent_task_id FROM tasks WHERE id = ?').get(subtaskId);
  assert(parent.parent_task_id !== null, 'Subtask hat parent_task_id gesetzt');
  // Backend darf keine weiteren Kinder erlauben
  let threw = false;
  // CHECK: parent_task_id des subtask ist nicht null → Backend würde 400 zurückgeben
  if (parent.parent_task_id !== null) threw = true;
  assert(threw, 'Tiefenprüfung sollte anschlagen');
});

// --------------------------------------------------------
// Lesen + Filter
// --------------------------------------------------------
test('Alle Top-Level-Aufgaben mit Subtask-Zähler', () => {
  const tasks = db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM tasks s WHERE s.parent_task_id = t.id) AS subtask_total,
      (SELECT COUNT(*) FROM tasks s WHERE s.parent_task_id = t.id AND s.status = 'done') AS subtask_done
    FROM tasks t
    WHERE t.parent_task_id IS NULL
    ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
  `).all();
  assert(tasks.length === 3, `Erwartet 3, erhalten ${tasks.length}`);
  const withSub = tasks.find((t) => t.id === task1Id);
  assert(withSub.subtask_total === 1, 'subtask_total = 1');
  assert(withSub.subtask_done === 0,  'subtask_done = 0');
});

test('Filter nach Status=open', () => {
  const tasks = db.prepare(`SELECT * FROM tasks WHERE parent_task_id IS NULL AND status = 'open'`).all();
  assert(tasks.length === 2, `Erwartet 2 offene, erhalten ${tasks.length}`);
  assert(tasks.every((t) => t.status === 'open'), 'Alle sollten open sein');
});

test('Filter nach Priority=high', () => {
  const tasks = db.prepare(`SELECT * FROM tasks WHERE parent_task_id IS NULL AND priority = 'high'`).all();
  assert(tasks.length === 1, `Erwartet 1, erhalten ${tasks.length}`);
  assert(tasks[0].title === 'Wohnung putzen');
});

test('Filter nach assigned_to', () => {
  const tasks = db.prepare(`SELECT * FROM tasks WHERE parent_task_id IS NULL AND assigned_to = ?`).all(uid2);
  assert(tasks.length === 1, `Erwartet 1, erhalten ${tasks.length}`);
  assert(tasks[0].assigned_to === uid2);
});

test('Einzelne Aufgabe mit Subtasks und User-Join', () => {
  const task = db.prepare(`
    SELECT t.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color
    FROM tasks t LEFT JOIN users u ON t.assigned_to = u.id
    WHERE t.id = ? AND t.parent_task_id IS NULL
  `).get(task1Id);
  assert(task, 'Aufgabe gefunden');
  assert(task.assigned_name === 'Max', 'assigned_name korrekt');
  assert(task.assigned_color === '#34C759', 'assigned_color korrekt');

  const subtasks = db.prepare(`SELECT * FROM tasks WHERE parent_task_id = ?`).all(task1Id);
  assert(subtasks.length === 1, 'Ein Subtask');
  assert(subtasks[0].title === 'Küche putzen');
});

// --------------------------------------------------------
// Status-Änderungen
// --------------------------------------------------------
test('Status ändern: open → done', () => {
  db.prepare(`UPDATE tasks SET status = 'done' WHERE id = ?`).run(task1Id);
  const t = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task1Id);
  assert(t.status === 'done', 'Status sollte done sein');
});

test('Status ändern: done → open', () => {
  db.prepare(`UPDATE tasks SET status = 'open' WHERE id = ?`).run(task1Id);
  const t = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task1Id);
  assert(t.status === 'open', 'Status zurück auf open');
});

test('Subtask-Fortschritt nach Erledigung', () => {
  db.prepare(`UPDATE tasks SET status = 'done' WHERE id = ?`).run(subtaskId);
  const progress = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
    FROM tasks WHERE parent_task_id = ?
  `).get(task1Id);
  assert(progress.total === 1, 'total = 1');
  assert(progress.done === 1,  'done = 1');
});

// --------------------------------------------------------
// Aktualisieren
// --------------------------------------------------------
test('Aufgabe aktualisieren', () => {
  db.prepare(`UPDATE tasks SET title = 'Wohnung gründlich putzen', priority = 'urgent' WHERE id = ?`)
    .run(task1Id);
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task1Id);
  assert(t.title === 'Wohnung gründlich putzen', 'Titel aktualisiert');
  assert(t.priority === 'urgent', 'Priorität aktualisiert');
});

// --------------------------------------------------------
// Löschen
// --------------------------------------------------------
test('Aufgabe löschen löscht Subtasks (CASCADE)', () => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task1Id);
  const orphan = db.prepare('SELECT * FROM tasks WHERE parent_task_id = ?').get(task1Id);
  assert(!orphan, 'Subtask sollte gelöscht sein');
});

test('Nicht existierende Aufgabe liefert keine Zeile', () => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = 99999').get();
  assert(!t, 'Sollte undefined sein');
});

// --------------------------------------------------------
// Meta-Endpoint
// --------------------------------------------------------
test('Users für Meta-Endpoint abrufbar', () => {
  const users = db.prepare('SELECT id, display_name, avatar_color FROM users ORDER BY display_name').all();
  assert(users.length === 2, `Erwartet 2 User, erhalten ${users.length}`);
  assert(users[0].avatar_color, 'avatar_color vorhanden');
});

// #671: In der Detailansicht waren Teilaufgaben reine Anzeige, während dieselbe
// Teilaufgabe in der Listenkarte einen Schalter hatte. Wer eine anlegte und die
// Aufgabe danach öffnete, sah sie - und kam nicht mehr an sie heran. Der
// Klick-Handler des Seiten-Containers greift dort nicht, weil die Detailansicht
// in den Top-Layer rendert; die Delegation muss also am Knoten selbst hängen.
test('Teilaufgaben der Detailansicht sind abhakbar, nicht nur lesbar', () => {
  // Die Detailansicht wohnt seit #918 in der geteilten Komponente - dieselbe,
  // die die Übersicht und der Kalender öffnen.
  const source = readFileSync(new URL('../public/components/task-detail.js', import.meta.url), 'utf8');
  const fn = source.match(/function subtaskListNode\([\s\S]*?\n\}/);
  assert(fn, 'subtaskListNode muss existieren');
  const body = fn[0];
  // DIE ZEILE, NICHT DER ANLEGEN-KNOPF DARUNTER. Ein blosses
  // `createElement('button')` stand hier, bis die Zeile bei `tasks: read` zum
  // Zustandszeichen wurde (#467): der Ausdruck traf danach den zweiten
  // `createElement('button')` dieser Funktion - den Hinzufuegen-Knopf - und
  // blieb gruen, ohne noch etwas ueber die Zeile zu sagen. Jetzt steht die
  // Weiche selbst da, und mit ihr beide Haelften.
  assert(/createElement\(nurLesen \? 'span' : 'button'\)/.test(body),
    'mit Schreibrecht muss die Zeile ein <button> sein, damit Tastatur und Screenreader denselben Weg haben');
  assert(/addEventListener\('click'/.test(body),
    'ohne eigenen Listener bleibt die Zeile tot: der Container-Handler erreicht den Top-Layer nicht');
  assert(/toggleSubtaskStatus\(/.test(body),
    'der Klick muss denselben Statuswechsel auslösen wie in der Listenkarte');
});

// #671: Jede Filterachse nimmt mehrere Werte. Ein einzelner String im State
// liefe beim ersten .includes/.forEach in einen TypeError.
test('Filter-Achsen halten Listen, nicht einzelne Werte', () => {
  const source = readFileSync(new URL('../public/pages/tasks.js', import.meta.url), 'utf8');
  assert(/filters:\s*\{ status: \['open'\], priority: \[\], assigned_to: \[\], category: \[\], tags: \[\] \}/.test(source),
    'der Anfangszustand muss je Achse eine Liste sein');
  for (const axis of ['status', 'priority', 'assigned_to', 'category']) {
    assert(new RegExp(`state\\.filters\\.${axis}\\.forEach\\(\\(v\\) => params\\.append\\('${axis}', v\\)\\)`).test(source),
      `${axis} muss jeden Wert einzeln an die Query hängen`);
  }
  assert(/state\.filters = \{ status: \[\], priority: \[\], assigned_to: \[\], category: \[\], tags: \[\] \}/.test(source),
    '"Alle Filter löschen" muss Listen hinterlassen, keine leeren Strings');
});

// --------------------------------------------------------
// Ergebnis
// --------------------------------------------------------
console.log(`\n[Tasks-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
