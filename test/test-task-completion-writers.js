/**
 * Modul: Jeder Weg, eine Aufgabe zu erledigen, schreibt den Erledigungseintrag (#1836)
 * Zweck: "Erledigt, wann, von wem" stand bisher nur fuer Aufgaben fest, die in
 *        Yuvomi abgehakt wurden. Der eingehende CalDAV-Sync und die
 *        Zahlungsaufgabe der Haushaltshilfe setzten `status` direkt und liessen
 *        `task_completions` leer: eine auf dem Telefon abgehakte Aufgabe fehlte
 *        im Verlauf und verschwand an der Wand, statt ihren Haken zu bekommen.
 *
 *        Geprueft wird:
 *          - der Parser liefert COMPLETED als Zeitpunkt (nur in UTC-Form);
 *          - der Sync schreibt fuer eine gespiegelte Aufgabe den Eintrag beim
 *            Abhaken (mit dem Zeitpunkt aus COMPLETED, ohne Person, Quelle
 *            'caldav') und raeumt ihn beim Wiedereroeffnen ab;
 *          - der erste Abruf einer schon erledigten Erinnerung erfindet keinen
 *            Eintrag (kein Nachtrag, #1836 "Not part of this");
 *            (die Wand, #1825, liest "heute erledigt" aus genau diesem Eintrag);
 *          - der Verlauf traegt die Quelle aus;
 *          - ein Waechter findet JEDE Anweisung, die `status` an `tasks`
 *            schreibt, und schlaegt fehl, wenn eine davon nicht ueber
 *            syncTaskCompletion laeuft.
 *        Die Zahlungsaufgabe pruefen /pay und /unpay in
 *        test/test-housekeeping-routes.js an der echten Route.
 *
 * Ausfuehren: npm run test:task-completion-writers
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dbmod = await import('../server/db.js');
const db = dbmod.get();
const { upsertTask } = await import('../server/services/caldav-reminders-sync.js');
const { parseVTODO } = await import('../server/services/ics-parser.js');
const { completionFeed } = await import('../server/services/task-completions.js');

const ADMIN = Number(db.prepare(
  "INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')",
).run().lastInsertRowid);
const ACCOUNT = Number(db.prepare(
  "INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES ('Fake', 'https://dav.example/', 'u', 'p')",
).run().lastInsertRowid);

function vtodo(uid, { completed = null, status = 'NEEDS-ACTION', due = null } = {}) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//EN',
    'BEGIN:VTODO', `UID:${uid}`, 'DTSTAMP:20260101T090000Z', `SUMMARY:Aufgabe ${uid}`,
    `STATUS:${status}`,
    ...(completed ? [`COMPLETED:${completed}`] : []),
    ...(due ? [`DUE;VALUE=DATE:${due}`] : []),
    'END:VTODO', 'END:VCALENDAR',
  ].join('\r\n');
}

const todoOf = (uid, opts) => parseVTODO(vtodo(uid, opts))[0];
const completionOf = (taskId) => db.prepare('SELECT * FROM task_completions WHERE task_id = ?').get(taskId);
const taskOf = (taskId) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);

// --------------------------------------------------------
// Parser
// --------------------------------------------------------
test('Parser: COMPLETED in UTC wird zum ISO-Zeitpunkt', () => {
  const todo = todoOf('p1', { status: 'COMPLETED', completed: '20261017T081500Z' });
  assert.equal(todo.completed, true);
  assert.equal(todo.completedAt, '2026-10-17T08:15:00Z');
});

test('Parser: COMPLETED ohne Zone oder ganz ohne Wert ergibt keinen Zeitpunkt', () => {
  assert.equal(todoOf('p2', { status: 'COMPLETED', completed: '20261017T081500' }).completedAt, null,
    'eine Wanduhrzeit ohne Zone waere geraten');
  assert.equal(todoOf('p3', { status: 'COMPLETED' }).completedAt, null);
  assert.equal(todoOf('p4').completedAt, null);
});

// --------------------------------------------------------
// CalDAV-Sync
// --------------------------------------------------------
test('Sync: auf dem Telefon abgehakt -> Erledigungseintrag mit COMPLETED, ohne Person, Quelle caldav', () => {
  const id = Number(upsertTask(todoOf('s1'), ACCOUNT, ADMIN, '/l/s1.ics'));
  assert.equal(taskOf(id).status, 'open');
  assert.equal(completionOf(id), undefined, 'eine offene Aufgabe hat keinen Eintrag');

  upsertTask(todoOf('s1', { status: 'COMPLETED', completed: '20261017T081500Z' }), ACCOUNT, ADMIN, '/l/s1.ics');
  assert.equal(taskOf(id).status, 'done');
  const c = completionOf(id);
  assert.ok(c, 'der Sync schreibt denselben Eintrag wie ein Haken in Yuvomi');
  assert.equal(c.completed_at, '2026-10-17T08:15:00Z', 'Zeitpunkt aus COMPLETED');
  assert.equal(c.user_id, null, 'der Sync kennt keine abhakende Person');
  assert.equal(c.done_by_user_id, null);
  assert.equal(c.source, 'caldav');
});

test('Sync: ein zweiter Lauf mit demselben Stand laesst den Eintrag in Ruhe', () => {
  const id = Number(upsertTask(todoOf('s2'), ACCOUNT, ADMIN));
  upsertTask(todoOf('s2', { status: 'COMPLETED', completed: '20261017T081500Z' }), ACCOUNT, ADMIN);
  const first = completionOf(id);
  upsertTask(todoOf('s2', { status: 'COMPLETED', completed: '20261017T091500Z' }), ACCOUNT, ADMIN);
  const again = completionOf(id);
  assert.equal(again.id, first.id);
  assert.equal(again.completed_at, first.completed_at, 'kein Statuswechsel, kein neuer Zeitpunkt');
});

test('Sync: auf dem Telefon wieder geoeffnet -> der Eintrag geht', () => {
  const id = Number(upsertTask(todoOf('s3'), ACCOUNT, ADMIN));
  upsertTask(todoOf('s3', { status: 'COMPLETED', completed: '20261017T081500Z' }), ACCOUNT, ADMIN);
  assert.ok(completionOf(id));
  upsertTask(todoOf('s3'), ACCOUNT, ADMIN);
  assert.equal(taskOf(id).status, 'open');
  assert.equal(completionOf(id), undefined, 'eine wieder offene Aufgabe sagt nicht weiter, sie sei erledigt');
});

test('Sync: in Yuvomi erledigt, auf dem Telefon geoeffnet -> auch dieser Eintrag geht', () => {
  const id = Number(upsertTask(todoOf('s4'), ACCOUNT, ADMIN));
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id);
  db.prepare('INSERT INTO task_completions (task_id, series_id, user_id) VALUES (?, ?, ?)').run(id, id, ADMIN);
  upsertTask(todoOf('s4'), ACCOUNT, ADMIN);
  assert.equal(completionOf(id), undefined);
});

test('Sync: ohne COMPLETED gilt der Zeitpunkt des Laufs, ein COMPLETED aus der Zukunft ebenso', () => {
  const before = new Date(Date.now() - 2000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const a = Number(upsertTask(todoOf('s5'), ACCOUNT, ADMIN));
  upsertTask(todoOf('s5', { status: 'COMPLETED' }), ACCOUNT, ADMIN);
  assert.ok(completionOf(a).completed_at >= before, 'ohne COMPLETED: jetzt');

  const b = Number(upsertTask(todoOf('s6'), ACCOUNT, ADMIN));
  upsertTask(todoOf('s6', { status: 'COMPLETED', completed: '20991231T235959Z' }), ACCOUNT, ADMIN);
  const at = completionOf(b).completed_at;
  assert.notEqual(at, '2099-12-31T23:59:59Z', 'ein Haken, der erst noch passiert, ist keiner');
  assert.ok(at >= before);
});

test('Sync: der erste Abruf einer schon erledigten Erinnerung erfindet keinen Eintrag', () => {
  const id = Number(upsertTask(todoOf('s7', { status: 'COMPLETED', completed: '20250101T080000Z' }), ACCOUNT, ADMIN));
  assert.equal(taskOf(id).status, 'done');
  assert.equal(completionOf(id), undefined,
    'sonst braechte das Einbinden einer Liste jede je abgehakte Erinnerung auf einmal in den Verlauf');
});

test('Verlauf: ein Eintrag aus dem Sync traegt seine Quelle aus', () => {
  const id = Number(upsertTask(todoOf('s8'), ACCOUNT, ADMIN));
  upsertTask(todoOf('s8', { status: 'COMPLETED', completed: '20261017T081500Z' }), ACCOUNT, ADMIN);
  const { entries } = completionFeed(db, { me: ADMIN, limit: 200 });
  const entry = entries.find((e) => e.task_id === id);
  assert.ok(entry, 'die auf dem Telefon erledigte Aufgabe steht im Verlauf');
  assert.equal(entry.source, 'caldav');
  assert.equal(entry.person_user_id, null);
});

// --------------------------------------------------------
// Waechter: jede Anweisung, die `status` an `tasks` schreibt
// --------------------------------------------------------
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function serverFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...serverFiles(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * Findet SQL-Anweisungen, die `tasks.status` setzen: ein UPDATE mit `status =`
 * vor dem WHERE, oder ein INSERT, dessen Spaltenliste `status` nennt und der
 * nicht fest 'open' einsetzt. Liefert die Zeilennummern.
 */
function statusWriters(source) {
  const hits = [];
  const literal = /`[^`]*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g;
  let m;
  while ((m = literal.exec(source)) !== null) {
    const sql = m[0];
    const line = source.slice(0, m.index).split('\n').length;
    const update = /\bUPDATE\s+tasks\b(?!_)\s+(?:AS\s+\w+\s+)?SET\b([\s\S]*?)(?:\bWHERE\b|$)/i.exec(sql);
    if (update && /\bstatus\s*=/i.test(update[1])) { hits.push({ line, sql }); continue; }
    const insert = /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+tasks\b(?!_)\s*\(([^)]*)\)([\s\S]*)/i.exec(sql);
    if (insert && /\bstatus\b/i.test(insert[1])) {
      // Wer fest 'open' einsetzt, legt nie eine erledigte Aufgabe an.
      const columns = insert[1].split(',').map((c) => c.trim().toLowerCase());
      const values = /VALUES\s*\(([\s\S]*)\)/i.exec(insert[2]);
      const valueList = values ? values[1].split(',').map((v) => v.trim()) : [];
      if (valueList[columns.indexOf('status')] === "'open'") continue;
      hits.push({ line, sql });
    }
  }
  return hits;
}

// Wie weit nach der Anweisung der Aufruf stehen darf. Grosszuegig genug fuer
// die Routen (PUT /:id: 33 Zeilen), eng genug, dass ein Aufruf in einer
// Nachbarfunktion nicht fuer eine fremde Anweisung buergt.
const WINDOW = 50;

test('Waechter: der Detektor erkennt Schreiber und laesst Leser in Ruhe', () => {
  const sample = [
    "db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', id);",
    "db.prepare(\"UPDATE tasks SET title = ? WHERE status = 'done'\").run(t);",
    "db.prepare('UPDATE tasks_new SET status = ?').run(s);",
    'db.prepare(`INSERT INTO tasks (title, status) VALUES (?, ?)`).run(t, s);',
    "db.prepare(`INSERT INTO tasks (title, status) VALUES (?, 'open')`).run(t);",
    "db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(id);",
  ].join('\n');
  assert.deepEqual(statusWriters(sample).map((h) => h.line), [1, 4]);
});

test('Waechter: jede Anweisung, die tasks.status schreibt, laeuft ueber syncTaskCompletion (#1836)', () => {
  // db.js ist ausgenommen: dort stehen nur Migrationen, die eingefroren sind und
  // einmal laufen (eine Migration bucht bewusst keinen Verlauf nach).
  const files = serverFiles(join(ROOT, 'server'))
    .filter((p) => !/server[\\/](db|db-schema-test)\.js$/.test(p));
  const bypass = [];
  let found = 0;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const lines = source.split('\n');
    for (const hit of statusWriters(source)) {
      found++;
      const after = lines.slice(hit.line - 1, hit.line - 1 + WINDOW + hit.sql.split('\n').length).join('\n');
      if (!/\bsyncTaskCompletion\s*\(/.test(after)) bypass.push(`${relative(ROOT, file)}:${hit.line}`);
    }
  }
  // Ein Waechter, der nichts findet, beweist nichts: die bekannten Schreiber
  // (Routen POST/PUT/PATCH, /pay, /unpay, Sync UPDATE + INSERT) muessen da sein.
  assert.ok(found >= 7, `erwartet mindestens 7 Schreiber, gefunden ${found}`);
  assert.deepEqual(bypass, [], `Diese Stellen setzen tasks.status ohne syncTaskCompletion:\n${bypass.join('\n')}`);
});
