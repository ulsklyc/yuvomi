/**
 * Modul: Aufgaben-Verlauf-Test (#791)
 * Zweck: Das Erledigen einer Aufgabe wird als Ereignis festgehalten, das
 *        Zurücknehmen räumt es ab, die Serie einer wiederkehrenden Aufgabe
 *        bleibt als eine Historie lesbar - und keiner der Lesepfade zeigt eine
 *        Aufgabe, die die fragende Person nicht sehen darf.
 * Ausführen: node --experimental-sqlite test/test-task-completions.js
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import { MIGRATIONS, _setTestDatabase } from '../server/db.js';
import {
  completionFeed, recordCompletion, revokeCompletion, seriesHistory, seriesRootOf, syncTaskCompletion,
} from '../server/services/task-completions.js';

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

const mom = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('mom', 'Mama', 'x', 'admin')").run().lastInsertRowid;
const kid = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('lea', 'Lea', 'x', 'member')").run().lastInsertRowid;
const other = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('tim', 'Tim', 'x', 'member')").run().lastInsertRowid;

function makeTask({ title = 'Staubsaugen', createdBy = mom, visibility = 'all', parent = null, origin = null, recurring = 0 } = {}) {
  return db.prepare(`
    INSERT INTO tasks (title, status, created_by, visibility, parent_task_id, recurrence_origin_id, is_recurring)
    VALUES (?, 'open', ?, ?, ?, ?, ?)
  `).run(title, createdBy, visibility, parent, origin, recurring).lastInsertRowid;
}

/** Zeitstempel eines Eintrags setzen - der Feed sortiert danach. */
function stampCompletion(taskId, iso) {
  db.prepare('UPDATE task_completions SET completed_at = ? WHERE task_id = ?').run(iso, taskId);
}

// --------------------------------------------------------
// Schema
// --------------------------------------------------------
test('Schema: task_completions existiert mit dem erwarteten Vertrag', () => {
  const cols = db.prepare('PRAGMA table_info(task_completions)').all();
  const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
  for (const name of ['id', 'task_id', 'series_id', 'user_id', 'completed_at', 'done_by_user_id']) {
    assert.ok(byName[name], `Spalte ${name} fehlt`);
  }
  assert.equal(byName.task_id.notnull, 1);
  assert.equal(byName.series_id.notnull, 1);
  assert.equal(byName.completed_at.notnull, 1);
  // user_id darf leer werden: das Ausscheiden eines Mitglieds loescht nicht den
  // Verlauf des Haushalts.
  assert.equal(byName.user_id.notnull, 0);
  // done_by_user_id ebenso - und OHNE Default (#1205): "nicht benannt" ist ein
  // eigener Zustand, kein stillschweigendes "war die abhakende Person".
  assert.equal(byName.done_by_user_id.notnull, 0);
  assert.equal(byName.done_by_user_id.dflt_value, null);
});

test('Schema: Bestandseintraege bekommen keinen Backfill auf die abhakende Person', () => {
  // Die Migration darf `user_id` NICHT nach `done_by_user_id` kopieren. Taete
  // sie es, behauptete jeder alte Eintrag rueckwirkend, die abhakende Person
  // habe die Aufgabe auch erledigt - eine Aussage, fuer die nie jemand gefragt
  // wurde. Geprueft an einem Eintrag, der ohne Benennung entsteht.
  const id = makeTask({ title: 'Ohne Benennung' });
  recordCompletion(db, id, mom);
  assert.equal(db.prepare('SELECT done_by_user_id FROM task_completions WHERE task_id = ?').get(id).done_by_user_id, null);
});

test('Schema: eine Aufgabe kann nur einen Eintrag tragen', () => {
  const id = makeTask({ title: 'Doppelt' });
  recordCompletion(db, id, mom);
  recordCompletion(db, id, kid);
  const rows = db.prepare('SELECT * FROM task_completions WHERE task_id = ?').all(id);
  assert.equal(rows.length, 1);
  // Der erste Eintrag gewinnt - INSERT OR IGNORE, kein Ueberschreiben.
  assert.equal(rows[0].user_id, mom);
});

// --------------------------------------------------------
// Aufzeichnen und Zuruecknehmen
// --------------------------------------------------------
test('Der Uebergang nach done schreibt einen Eintrag, das Zuruecknehmen loescht ihn', () => {
  const id = makeTask({ title: 'Muell rausbringen' });

  syncTaskCompletion(db, id, 'open', 'done', kid);
  let rows = db.prepare('SELECT * FROM task_completions WHERE task_id = ?').all(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, kid);

  syncTaskCompletion(db, id, 'done', 'open', mom);
  rows = db.prepare('SELECT * FROM task_completions WHERE task_id = ?').all(id);
  assert.equal(rows.length, 0, 'Zuruecknehmen loescht statt gegenzubuchen');
});

test('Ein Wechsel, der done nicht beruehrt, laesst den Verlauf in Ruhe', () => {
  const id = makeTask({ title: 'In Arbeit' });
  syncTaskCompletion(db, id, 'open', 'in_progress', kid);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM task_completions WHERE task_id = ?').get(id).n, 0);

  syncTaskCompletion(db, id, 'in_progress', 'done', kid);
  syncTaskCompletion(db, id, 'done', 'done', mom);
  const rows = db.prepare('SELECT * FROM task_completions WHERE task_id = ?').all(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, kid, 'done -> done ist kein neuer Vorgang');
});

test('Der Eintrag nennt die handelnde Person, nicht die zustaendige', () => {
  // Die Punktevergabe entscheidet das bewusst anders (rewardTargets). Faellt
  // dieser Unterschied weg, zeigt der Verlauf am Kiosk-Tablet die Zustaendigen
  // statt derjenigen, die dort geklickt hat.
  const id = makeTask({ title: 'Spuelmaschine' });
  db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(id, other);
  syncTaskCompletion(db, id, 'open', 'done', kid);
  assert.equal(db.prepare('SELECT user_id FROM task_completions WHERE task_id = ?').get(id).user_id, kid);
});

test('Teilaufgaben schreiben keinen Eintrag', () => {
  const parent = makeTask({ title: 'Urlaub packen' });
  const sub = makeTask({ title: 'Zelt einpacken', parent });
  syncTaskCompletion(db, sub, 'open', 'done', kid);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM task_completions WHERE task_id = ?').get(sub).n, 0);
});

test('Ein geloeschtes Mitglied laesst seinen Eintrag stehen, ohne Namen', () => {
  const leaver = db.prepare("INSERT INTO users (username, display_name, password_hash) VALUES ('ex', 'Ex', 'x')").run().lastInsertRowid;
  const id = makeTask({ title: 'Rasen maehen' });
  syncTaskCompletion(db, id, 'open', 'done', leaver);
  db.prepare('DELETE FROM users WHERE id = ?').run(leaver);
  const row = db.prepare('SELECT * FROM task_completions WHERE task_id = ?').get(id);
  assert.ok(row, 'der Eintrag ueberlebt das Mitglied');
  assert.equal(row.user_id, null);
});

test('Eine geloeschte Aufgabe nimmt ihren Eintrag mit', () => {
  const id = makeTask({ title: 'Verschwindet' });
  syncTaskCompletion(db, id, 'open', 'done', mom);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM task_completions WHERE task_id = ?').get(id).n, 0);
});

// --------------------------------------------------------
// Serien
// --------------------------------------------------------
test('seriesRootOf laeuft die Wiederholungskette bis zur Wurzel hoch', () => {
  const first = makeTask({ title: 'Bad putzen', recurring: 1 });
  const second = makeTask({ title: 'Bad putzen', recurring: 1, origin: first });
  const third = makeTask({ title: 'Bad putzen', recurring: 1, origin: second });

  assert.equal(seriesRootOf(db, first), first);
  assert.equal(seriesRootOf(db, third), first);

  // Eine Aufgabe ohne Kette ist ihre eigene Serie.
  const solo = makeTask({ title: 'Einmalig' });
  assert.equal(seriesRootOf(db, solo), solo);
});

test('Die Historie einer Serie sammelt alle Instanzen ein', () => {
  const first = makeTask({ title: 'Wasche', recurring: 1 });
  const second = makeTask({ title: 'Wasche', recurring: 1, origin: first });
  const third = makeTask({ title: 'Wasche', recurring: 1, origin: second });

  syncTaskCompletion(db, first, 'open', 'done', mom);
  stampCompletion(first, '2026-08-01T09:00:00Z');
  syncTaskCompletion(db, second, 'open', 'done', kid);
  stampCompletion(second, '2026-08-08T09:00:00Z');

  // Gefragt wird ueber die noch OFFENE dritte Instanz: sie hat selbst keinen
  // Eintrag, und genau das ist der Fall aus "wann war das zuletzt dran".
  const history = seriesHistory(db, { me: mom, taskId: third });
  assert.equal(history.length, 2);
  assert.equal(history[0].completed_at, '2026-08-08T09:00:00Z', 'neueste zuerst');
  assert.equal(history[0].user_name, 'Lea');
  assert.equal(history[1].user_name, 'Mama');
});

test('Ein Riss in der Kette trennt die Serie, ohne die alten Eintraege zu verlieren', () => {
  const a = makeTask({ title: 'Filter wechseln', recurring: 1 });
  const b = makeTask({ title: 'Filter wechseln', recurring: 1, origin: a });
  syncTaskCompletion(db, a, 'open', 'done', mom);
  syncTaskCompletion(db, b, 'open', 'done', mom);
  const recordedSeries = db.prepare('SELECT series_id FROM task_completions WHERE task_id = ?').get(b).series_id;
  assert.equal(recordedSeries, a);

  // Wird die Wurzel geloescht, faellt ihr Eintrag mit ihr - der spaetere aber
  // behaelt seine series_id, statt in eine neue Serie abzuwandern. Genau dafuer
  // wird sie beim Schreiben festgehalten und nicht bei jedem Lesen berechnet.
  db.prepare('DELETE FROM tasks WHERE id = ?').run(a);
  const still = db.prepare('SELECT series_id FROM task_completions WHERE task_id = ?').get(b);
  assert.equal(still.series_id, a);
  assert.equal(db.prepare('SELECT recurrence_origin_id FROM tasks WHERE id = ?').get(b).recurrence_origin_id, null);

  // UND DIE ANSICHT MUSS IHN NOCH FINDEN. Die Zeile oben prueft nur die
  // Spalte - eine erste Fassung tat genau das, blieb gruen, und die
  // Serienansicht antwortete trotzdem "noch nie erledigt": sie berechnete die
  // Wurzel beim LESEN neu, kam nach dem Riss auf b statt auf a und fragte nach
  // einer series_id, die in keiner Zeile steht. Eine Zusicherung ueber ein
  // Feld ist keine Zusicherung ueber die Antwort.
  assert.equal(seriesHistory(db, { me: mom, taskId: b }).length, 1,
    'die eigene Erledigung bleibt auffindbar, auch wenn die Wurzel weg ist');
});

test('Nach einem Riss findet die Serienansicht auch die Instanzen DAVOR', () => {
  // Drei Instanzen, das mittlere Glied wird geloescht. Die Kette von c reicht
  // danach nur bis c selbst - a haengt aber ueber die geerbte series_id noch
  // an derselben Serie, und genau dafuer wird sie beim Schreiben festgehalten.
  const a = makeTask({ title: 'Heizung entlueften', recurring: 1 });
  const b = makeTask({ title: 'Heizung entlueften', recurring: 1, origin: a });
  const c = makeTask({ title: 'Heizung entlueften', recurring: 1, origin: b });
  syncTaskCompletion(db, a, 'open', 'done', mom);
  stampCompletion(a, '2026-07-01T09:00:00Z');
  syncTaskCompletion(db, b, 'open', 'done', kid);
  stampCompletion(b, '2026-07-08T09:00:00Z');
  syncTaskCompletion(db, c, 'open', 'done', mom);
  stampCompletion(c, '2026-07-15T09:00:00Z');

  assert.equal(seriesHistory(db, { me: mom, taskId: c }).length, 3);

  db.prepare('DELETE FROM tasks WHERE id = ?').run(b);
  const after = seriesHistory(db, { me: mom, taskId: c });
  assert.equal(after.length, 2, 'die Erledigung von a bleibt in der Serie');
  assert.deepEqual(after.map((e) => e.task_id), [c, a]);
});

test('Eine lange Kette erbt ihre Serie, statt sie neu zu erlaufen', () => {
  // Der Deckel der rekursiven Abfrage liegt bei 1000 Gliedern. Eine taegliche
  // Aufgabe erreicht ihn nach gut zweieinhalb Jahren, und ohne das Erben vom
  // direkten Vorgaenger bekaeme sie ab da eine ANDERE series_id - die Serie
  // zerfiele still in zwei Haelften, und "zuletzt erledigt" zeigte nur die
  // neuere. Geprueft an einer kuerzeren Kette mit demselben Mechanismus.
  const root = makeTask({ title: 'Muell', recurring: 1 });
  let prev = root;
  const ids = [root];
  for (let i = 0; i < 20; i++) {
    prev = makeTask({ title: 'Muell', recurring: 1, origin: prev });
    ids.push(prev);
  }
  for (const id of ids) syncTaskCompletion(db, id, 'open', 'done', mom);

  const series = db.prepare('SELECT DISTINCT series_id FROM task_completions WHERE task_id IN (' + ids.join(',') + ')').all();
  assert.equal(series.length, 1, 'eine Serie, nicht zwei');
  assert.equal(series[0].series_id, root);
  assert.equal(seriesHistory(db, { me: mom, taskId: prev, limit: 100 }).length, ids.length);
});

// --------------------------------------------------------
// Sichtbarkeit
// --------------------------------------------------------
test('Eine private Aufgabe erscheint nur im Verlauf ihrer Urheberin', () => {
  const id = makeTask({ title: 'Geschenk besorgen', createdBy: mom, visibility: 'private' });
  syncTaskCompletion(db, id, 'open', 'done', mom);

  const mine = completionFeed(db, { me: mom }).entries.map((e) => e.task_id);
  const theirs = completionFeed(db, { me: kid }).entries.map((e) => e.task_id);
  assert.ok(mine.includes(id));
  assert.ok(!theirs.includes(id), 'private Aufgabe im fremden Verlauf');
});

test('Nachtraeglich versteckt heisst auch im Verlauf versteckt', () => {
  // Der Kern der Entscheidung, keine Sichtbarkeitskopie in den Eintrag zu
  // legen: sonst zeigte der Verlauf weiter, was gerade weggeschlossen wurde.
  const id = makeTask({ title: 'Arzttermin vorbereiten', createdBy: mom, visibility: 'all' });
  syncTaskCompletion(db, id, 'open', 'done', mom);
  assert.ok(completionFeed(db, { me: kid }).entries.some((e) => e.task_id === id));

  db.prepare("UPDATE tasks SET visibility = 'private' WHERE id = ?").run(id);
  assert.ok(!completionFeed(db, { me: kid }).entries.some((e) => e.task_id === id));
});

test('Stufe assignees zeigt den Eintrag den Zustaendigen', () => {
  const id = makeTask({ title: 'Papierkram', createdBy: mom, visibility: 'assignees' });
  db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(id, kid);
  syncTaskCompletion(db, id, 'open', 'done', kid);

  assert.ok(completionFeed(db, { me: kid }).entries.some((e) => e.task_id === id));
  assert.ok(completionFeed(db, { me: mom }).entries.some((e) => e.task_id === id), 'die Urheberin sieht sie');
  assert.ok(!completionFeed(db, { me: other }).entries.some((e) => e.task_id === id));
});

test('Auch die Serienansicht filtert nach Sichtbarkeit', () => {
  const root = makeTask({ title: 'Tagebuch', createdBy: mom, visibility: 'private', recurring: 1 });
  const next = makeTask({ title: 'Tagebuch', createdBy: mom, visibility: 'private', recurring: 1, origin: root });
  syncTaskCompletion(db, root, 'open', 'done', mom);
  assert.equal(seriesHistory(db, { me: mom, taskId: next }).length, 1);
  assert.equal(seriesHistory(db, { me: kid, taskId: next }).length, 0);
});

// --------------------------------------------------------
// Feed: Filter, Reihenfolge, Blaettern
// --------------------------------------------------------
test('Der Feed laesst sich auf eine Person einschraenken', () => {
  const a = makeTask({ title: 'A' });
  const b = makeTask({ title: 'B' });
  syncTaskCompletion(db, a, 'open', 'done', kid);
  syncTaskCompletion(db, b, 'open', 'done', mom);

  const onlyKid = completionFeed(db, { me: mom, userId: kid }).entries;
  assert.ok(onlyKid.every((e) => e.user_id === kid));
  assert.ok(onlyKid.some((e) => e.task_id === a));
  assert.ok(!onlyKid.some((e) => e.task_id === b));
});

test('Der Cursor blaettert lueckenlos weiter, auch bei gleicher Sekunde', () => {
  // Eine Sammelaktion hakt mehrere Aufgaben in derselben Sekunde ab. Ein Cursor
  // allein auf completed_at wuerde hier entweder Zeilen ueberspringen oder
  // ewig dieselbe wiederholen - deshalb das Paar (completed_at, id).
  db.prepare('DELETE FROM task_completions').run();
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const id = makeTask({ title: `Sammel ${i}` });
    ids.push(id);
    syncTaskCompletion(db, id, 'open', 'done', mom);
    stampCompletion(id, '2026-08-20T12:00:00Z');
  }

  const seen = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const { entries, hasMore } = completionFeed(db, {
      me: mom, limit: 2, beforeAt: cursor?.before_at ?? null, beforeId: cursor?.before_id ?? null,
    });
    seen.push(...entries.map((e) => e.id));
    if (!hasMore) break;
    const last = entries[entries.length - 1];
    cursor = { before_at: last.completed_at, before_id: last.id };
  }

  assert.equal(seen.length, ids.length);
  assert.equal(new Set(seen).size, ids.length, 'keine Zeile doppelt');
});

test('Der Feed liefert Titel und Person aus der Aufgabe, nicht aus einer Kopie', () => {
  db.prepare('DELETE FROM task_completions').run();
  const id = makeTask({ title: 'Alter Name' });
  syncTaskCompletion(db, id, 'open', 'done', kid);
  db.prepare("UPDATE tasks SET title = 'Neuer Name' WHERE id = ?").run(id);

  const entry = completionFeed(db, { me: mom }).entries.find((e) => e.task_id === id);
  assert.equal(entry.title, 'Neuer Name');
  assert.equal(entry.user_name, 'Lea');
});

test('has_more meldet ehrlich, ob noch etwas kommt', () => {
  db.prepare('DELETE FROM task_completions').run();
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const id = makeTask({ title: `Rest ${i}` });
    ids.push(id);
    syncTaskCompletion(db, id, 'open', 'done', mom);
  }
  assert.equal(completionFeed(db, { me: mom, limit: 2 }).hasMore, true);
  assert.equal(completionFeed(db, { me: mom, limit: 3 }).hasMore, false);
  assert.equal(completionFeed(db, { me: mom, limit: 3 }).entries.length, 3);
});

test('limit bleibt in seinen Grenzen', () => {
  assert.equal(completionFeed(db, { me: mom, limit: 0 }).entries.length <= 50, true);
  assert.equal(completionFeed(db, { me: mom, limit: 9999 }).entries.length <= 200, true);
  assert.equal(completionFeed(db, { me: mom, limit: 'abc' }).entries.length <= 50, true);
});

test('revokeCompletion raeumt auch ohne Statuswechsel ab', () => {
  const id = makeTask({ title: 'Manuell' });
  recordCompletion(db, id, mom);
  revokeCompletion(db, id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM task_completions WHERE task_id = ?').get(id).n, 0);
});

// --------------------------------------------------------
// Die Routen (#791)
//
// Der Service ist oben geprüft; hier geht es um das, was nur die Route hat:
// die Reihenfolge der Pfade (sonst matcht "completions" als :id), das Lesen der
// Query, den Cursor in der Antwort und die 404-Regel der Serienansicht.
// --------------------------------------------------------
const express = (await import('express')).default;
const http = await import('node:http');
const { default: tasksRouter } = await import('../server/routes/tasks.js');

let actor = mom;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor;
  req.session = { userId: actor };
  next();
});
app.use('/api/v1/tasks', tasksRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1/tasks`;
test.after(() => { server.close(); db.close(); });

async function call(path, as = mom) {
  actor = as;
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('GET /completions wird nicht von /:id verschluckt', async () => {
  db.prepare('DELETE FROM task_completions').run();
  const id = makeTask({ title: 'Ueber die Route' });
  syncTaskCompletion(db, id, 'open', 'done', kid);

  const r = await call('/completions');
  assert.equal(r.status, 200);
  assert.equal(r.body.data[0].task_id, id);
  assert.equal(r.body.data[0].user_name, 'Lea');
  assert.equal(r.body.has_more, false);
  assert.equal(r.body.next_cursor, null);
});

test('GET /completions liefert den Cursor, solange noch etwas kommt', async () => {
  db.prepare('DELETE FROM task_completions').run();
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const id = makeTask({ title: `Seite ${i}` });
    ids.push(id);
    syncTaskCompletion(db, id, 'open', 'done', mom);
    stampCompletion(id, `2026-08-2${i}T10:00:00Z`);
  }

  const first = await call('/completions?limit=2');
  assert.equal(first.body.data.length, 2);
  assert.equal(first.body.has_more, true);
  assert.ok(first.body.next_cursor.before_at);

  const { before_at: at, before_id: cid } = first.body.next_cursor;
  const second = await call(`/completions?limit=2&before_at=${encodeURIComponent(at)}&before_id=${cid}`);
  assert.equal(second.body.data.length, 1);
  assert.equal(second.body.has_more, false);
  const seen = [...first.body.data, ...second.body.data].map((e) => e.task_id);
  assert.equal(new Set(seen).size, 3);
});

test('GET /completions?user_id filtert auf eine Person', async () => {
  db.prepare('DELETE FROM task_completions').run();
  const a = makeTask({ title: 'Von Lea' });
  const b = makeTask({ title: 'Von Mama' });
  syncTaskCompletion(db, a, 'open', 'done', kid);
  syncTaskCompletion(db, b, 'open', 'done', mom);

  const r = await call(`/completions?user_id=${kid}`);
  assert.deepEqual(r.body.data.map((e) => e.task_id), [a]);
});

test('GET /completions zeigt keine fremde private Aufgabe', async () => {
  db.prepare('DELETE FROM task_completions').run();
  const secret = makeTask({ title: 'Geheim', createdBy: mom, visibility: 'private' });
  syncTaskCompletion(db, secret, 'open', 'done', mom);

  assert.equal((await call('/completions', mom)).body.data.length, 1);
  assert.equal((await call('/completions', kid)).body.data.length, 0);
});

test('GET /:id/completions liefert die Serie, 404 bei fremder privater Aufgabe', async () => {
  const root = makeTask({ title: 'Serie ueber die Route', createdBy: mom, visibility: 'private', recurring: 1 });
  const next = makeTask({ title: 'Serie ueber die Route', createdBy: mom, visibility: 'private', recurring: 1, origin: root });
  syncTaskCompletion(db, root, 'open', 'done', mom);

  const mine = await call(`/${next}/completions`, mom);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.data.length, 1);
  assert.equal(mine.body.data[0].task_id, root);

  // 404 und nicht 403: dass es die Aufgabe gibt, ist selbst schon eine Auskunft.
  const theirs = await call(`/${next}/completions`, kid);
  assert.equal(theirs.status, 404);
  assert.equal((await call('/999999/completions', mom)).status, 404);
});

test('Das Abhaken über PATCH /:id/status schreibt den Verlauf, das Zurücknehmen räumt ihn ab', async () => {
  // Der Weg, den Checkbox, Swipe und Sammelaktion nehmen - hier zählt, dass die
  // Verdrahtung in der Route sitzt und nicht nur der Service stimmt.
  db.prepare('DELETE FROM task_completions').run();
  const id = makeTask({ title: 'Ueber PATCH' });
  const patch = async (status, as) => {
    actor = as;
    const res = await fetch(`${base}/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    return res.status;
  };

  assert.equal(await patch('done', kid), 200);
  let rows = db.prepare('SELECT * FROM task_completions WHERE task_id = ?').all(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, kid);

  assert.equal(await patch('open', kid), 200);
  rows = db.prepare('SELECT * FROM task_completions WHERE task_id = ?').all(id);
  assert.equal(rows.length, 0);
});

test('Auch das Status-Feld im Bearbeiten-Formular schreibt den Verlauf', async () => {
  // Der ZWEITE Schreibweg (PUT /:id), den der Service-Kommentar ausdruecklich
  // nennt. Ohne diesen Test blieben alle uebrigen gruen, wenn jemand die eine
  // Zeile aus der PUT-Transaktion entfernt - genau die Luecke, gegen die die
  // Gegenproben fuer PATCH gefahren wurden.
  db.prepare('DELETE FROM task_completions').run();
  const id = makeTask({ title: 'Ueber PUT' });
  actor = kid;
  const put = async (status) => {
    const res = await fetch(`${base}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Ueber PUT', status }),
    });
    return res.status;
  };

  assert.equal(await put('done'), 200);
  let rows = db.prepare('SELECT * FROM task_completions WHERE task_id = ?').all(id);
  assert.equal(rows.length, 1, 'das Formular hakt genauso ab wie die Checkbox');
  assert.equal(rows[0].user_id, kid);

  assert.equal(await put('open'), 200);
  rows = db.prepare('SELECT * FROM task_completions WHERE task_id = ?').all(id);
  assert.equal(rows.length, 0, 'und nimmt es genauso zurueck');
});

test('Ablegen ist kein Abhaken und schreibt nichts', async () => {
  // #688: Das Archiv überschreibt den Status nicht, also entsteht auch kein
  // Vorgang. Ginge das verloren, füllte jede Aufräumaktion den Verlauf.
  db.prepare('DELETE FROM task_completions').run();
  const id = makeTask({ title: 'Wird abgelegt' });
  actor = mom;
  const res = await fetch(`${base}/${id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'archived' }),
  });
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM task_completions').get().n, 0);
});

// --------------------------------------------------------
// Wer hat es getan, nicht nur wer hat abgehakt (#1205)
// --------------------------------------------------------
test('Die benannte erledigende Person wird neben der abhakenden festgehalten', () => {
  const id = makeTask({ title: 'Spuelmaschine ausraeumen' });
  syncTaskCompletion(db, id, 'open', 'done', mom, kid);
  const row = db.prepare('SELECT * FROM task_completions WHERE task_id = ?').get(id);
  assert.equal(row.user_id, mom, 'wer abgehakt hat, behaelt seine Bedeutung');
  assert.equal(row.done_by_user_id, kid, 'wer es getan hat, steht daneben');
});

test('Ohne Benennung bleibt alles wie vorher', () => {
  const id = makeTask({ title: 'Unbenannt' });
  syncTaskCompletion(db, id, 'open', 'done', mom);
  const row = db.prepare('SELECT * FROM task_completions WHERE task_id = ?').get(id);
  assert.equal(row.user_id, mom);
  assert.equal(row.done_by_user_id, null);
});

test('Die Benennung ist so idempotent wie der Eintrag selbst', () => {
  // INSERT OR IGNORE laesst die vorhandene Zeile ganz in Ruhe - auch die
  // benannte Person. Sonst koennte ein zweiter, unbenannter Statuswechsel die
  // Angabe still loeschen.
  const id = makeTask({ title: 'Zweimal abgehakt' });
  recordCompletion(db, id, mom, kid);
  recordCompletion(db, id, other, null);
  const rows = db.prepare('SELECT * FROM task_completions WHERE task_id = ?').all(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].done_by_user_id, kid);
});

test('Zuruecknehmen loescht den Eintrag samt Benennung', () => {
  const id = makeTask({ title: 'Doch nicht erledigt' });
  syncTaskCompletion(db, id, 'open', 'done', mom, kid);
  syncTaskCompletion(db, id, 'done', 'open', mom);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM task_completions WHERE task_id = ?').get(id).n, 0);
});

test('Der Verlauf zeigt die erledigende Person, und faellt ohne sie auf die abhakende zurueck', () => {
  const named   = makeTask({ title: 'Benannt' });
  const plain   = makeTask({ title: 'Unbenannt zwei' });
  syncTaskCompletion(db, named, 'open', 'done', mom, kid);
  syncTaskCompletion(db, plain, 'open', 'done', other);

  const { entries } = completionFeed(db, { me: mom, limit: 200 });
  const a = entries.find((e) => e.task_id === named);
  const b = entries.find((e) => e.task_id === plain);

  assert.equal(a.person_user_id, kid);
  assert.equal(a.person_name, 'Lea');
  assert.equal(a.user_id, mom, 'wer abgehakt hat, bleibt lesbar');
  assert.equal(a.user_name, 'Mama');

  assert.equal(b.person_user_id, other, 'ohne Benennung ist die abhakende Person die Antwort');
  assert.equal(b.person_name, 'Tim');
  assert.equal(b.done_by_user_id, null);
});

test('Der Personenfilter folgt der angezeigten Person, nicht der abhakenden', () => {
  // Sonst zeigte der Verlauf nach dem Tippen auf Leas Chip Eintraege, die
  // Mamas Namen tragen - und Leas eigene Erledigung fehlte darin.
  const id = makeTask({ title: 'Fuer Lea abgehakt' });
  syncTaskCompletion(db, id, 'open', 'done', mom, kid);

  const forKid = completionFeed(db, { me: mom, limit: 200, userId: kid }).entries.map((e) => e.task_id);
  assert.ok(forKid.includes(id), 'die benannte Person findet ihre Erledigung');

  const forMom = completionFeed(db, { me: mom, limit: 200, userId: mom }).entries.map((e) => e.task_id);
  assert.ok(!forMom.includes(id), 'die abhakende Person bekommt sie nicht zugeschrieben');
});

test('Die Serienansicht nennt dieselbe Person wie der Verlauf', () => {
  const first = makeTask({ title: 'Serie mit Benennung', recurring: 1 });
  syncTaskCompletion(db, first, 'open', 'done', mom, kid);
  const rows = seriesHistory(db, { me: mom, taskId: first });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].person_user_id, kid);
  assert.equal(rows[0].person_name, 'Lea');
});

test('Eine ausgeschiedene erledigende Person loescht den Vorgang nicht', () => {
  // ON DELETE SET NULL wie bei user_id: der Verweis faellt, der Eintrag bleibt,
  // und die Anzeige faellt auf die abhakende Person zurueck.
  const gone = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('weg', 'Weg', 'x', 'member')").run().lastInsertRowid;
  const id = makeTask({ title: 'Von jemandem, der geht' });
  syncTaskCompletion(db, id, 'open', 'done', mom, gone);
  db.prepare('DELETE FROM users WHERE id = ?').run(gone);

  const row = db.prepare('SELECT * FROM task_completions WHERE task_id = ?').get(id);
  assert.ok(row, 'der Vorgang hat stattgefunden');
  assert.equal(row.done_by_user_id, null);
  const entry = completionFeed(db, { me: mom, limit: 200 }).entries.find((e) => e.task_id === id);
  assert.equal(entry.person_user_id, mom);
});
