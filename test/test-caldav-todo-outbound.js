/**
 * Test: ausgehender CalDAV-VTODO-Sync (#617)
 * Zweck: Der VTODO-Spiegel war einseitig - eine hier abgehakte, umbenannte oder
 *        gelöschte Aufgabe blieb auf dem Server stehen, und der nächste Inbound
 *        machte die lokale Änderung wieder rückgängig. Diese Suite hält die
 *        Rückrichtung fest, und zwar an den Stellen, an denen sie brechen kann:
 *
 *          - Ein PUT ersetzt das ganze Kalenderobjekt. Der Patcher darf nur die
 *            gespiegelten Properties tauschen, sonst ist jede Bearbeitung ein
 *            Datenverlust auf dem Server (Alarme, Unterlisten, Kategorien).
 *          - Erledigt liest jeder Client woanders ab: STATUS, COMPLETED und
 *            PERCENT-COMPLETE müssen zusammen wandern - und COMPLETED beim
 *            Wiederöffnen verschwinden, sonst bleibt die Aufgabe erledigt.
 *          - Yuvomi kennt vier Prioritätsstufen und vier Status, VTODO drei
 *            Bänder und kein „in Arbeit". Der Inbound darf die feineren lokalen
 *            Angaben nicht bei jedem Lauf plattmachen.
 *          - Der Inbound darf weder eine noch nicht gepushte Bearbeitung
 *            überschreiben noch einen lokal gelöschten Eintrag wieder anlegen.
 *
 *        Netz-frei: der tsdav-Client ist eine Attrappe.
 * Ausführen: node --experimental-sqlite --test test/test-caldav-todo-outbound.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';

const dbmod = await import('../server/db.js');
const db = dbmod.get();
const {
  MODULES, dueField, priorityToVtodo, icsFieldsForTask, icsFieldsForShoppingItem,
  markTodoOutbound, queueTodoDeletion, queueTodoDeletions,
  pendingDeletions, pendingDeletionUids, pendingUpdateUids,
  processPendingDeletions, processPendingUpdates, flushOutbound,
  pendingCreations, processPendingCreations, buildTodoICS, todoUidFor,
} = await import('../server/services/caldav-todo-outbound.js');
const { patchICSTodo } = await import('../server/utils/ics-patch.js');
const { mapVtodoPriority, mapVtodoStatus, splitDue, sync } =
  await import('../server/services/caldav-reminders-sync.js');
const { deleteAccount } = await import('../server/services/caldav-sync.js');
const { parseVTODO } = await import('../server/services/ics-parser.js');
const { loadTags, loadItemTags, setTags, tagsKey } = await import('../server/utils/task-tags.js');
const { MAX_OUTBOUND_ATTEMPTS } = await import('../server/services/calendar-outbound.js');

db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run();

const LIST_URL = 'https://dav.example/dav/u/reminders/';
const OBJ_URL  = `${LIST_URL}todo-1.ics`;

// ── Fixtures ────────────────────────────────────────────────────────────────────

/** Realistisches Serverobjekt: VTODO mit Alarm und Apple-Eigenheiten. */
function serverTodo({ uid = 'todo-1@test', completed = false, extra = [] } = {}) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Apple Inc.//iOS 18.0//EN',
    'BEGIN:VTODO',
    `UID:${uid}`,
    'DTSTAMP:20260701T080000Z',
    'SUMMARY:Milch kaufen',
    'X-APPLE-SORT-ORDER:12',
    'CATEGORIES:Haushalt',
    ...(completed
      ? ['STATUS:COMPLETED', 'COMPLETED:20260701T090000Z', 'PERCENT-COMPLETE:100']
      : ['STATUS:NEEDS-ACTION']),
    ...extra,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'TRIGGER:-PT15M',
    'END:VALARM',
    'END:VTODO',
    'END:VCALENDAR',
  ].join('\r\n');
}

function reset() {
  db.prepare('DELETE FROM caldav_todo_pending_deletions').run();
  db.prepare('DELETE FROM tasks').run();
  db.prepare('DELETE FROM shopping_items').run();
  db.prepare('DELETE FROM shopping_lists').run();
  db.prepare('DELETE FROM caldav_reminder_selection').run();
  db.prepare('DELETE FROM caldav_accounts').run();
  const acc = db.prepare(`INSERT INTO caldav_accounts (name, caldav_url, username, password)
              VALUES ('Radicale', 'https://dav.example/', 'u', 'p')`).run();
  return Number(acc.lastInsertRowid);
}

function enableList(accountId, targetModule = 'tasks', targetListId = null) {
  db.prepare(`
    INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled, target_list_id)
    VALUES (?, ?, 'Erinnerungen', ?, 1, ?)
  `).run(accountId, LIST_URL, targetModule, targetListId);
}

function insertTask({
  accountId, uid = 'todo-1@test', objectUrl = OBJ_URL, source = 'caldav', ...fields
} = {}) {
  const f = {
    title: 'Milch kaufen', description: null, priority: 'none', status: 'open',
    due_date: null, due_time: null, ...fields,
  };
  const r = db.prepare(`
    INSERT INTO tasks (title, description, priority, status, due_date, due_time, created_by,
                       external_uid, external_source, external_account_id, external_object_url)
    VALUES (@title, @description, @priority, @status, @due_date, @due_time, 1,
            @uid, @source, @accountId, @objectUrl)
  `).run({ ...f, uid, source, accountId: accountId ?? null, objectUrl });
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(r.lastInsertRowid);
}

function insertShoppingItem({ accountId, uid = 'todo-1@test', objectUrl = OBJ_URL, ...fields } = {}) {
  const listId = db.prepare(
    "INSERT INTO shopping_lists (name, created_by) VALUES ('Einkauf', 1) RETURNING id"
  ).get().id;
  const f = { name: 'Milch', is_checked: 0, ...fields };
  const r = db.prepare(`
    INSERT INTO shopping_items (list_id, name, is_checked, external_uid, external_source,
                                external_account_id, external_object_url)
    VALUES (@listId, @name, @is_checked, @uid, 'caldav', @accountId, @objectUrl)
  `).run({ ...f, listId, uid, accountId, objectUrl });
  return db.prepare('SELECT * FROM shopping_items WHERE id = ?').get(r.lastInsertRowid);
}

function reloadTask(id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

/** Attrappe: sammelt die Aufrufe und beantwortet sie nach Skript. */
function fakeClient({ objects = [], onUpdate = null, onDelete = null, onCreate = null } = {}) {
  const calls = { updated: [], deleted: [], fetched: [], created: [] };
  return {
    calls,
    fetchCalendars: async () => [{ url: LIST_URL, displayName: 'Erinnerungen', components: ['VTODO'] }],
    fetchCalendarObjects: async (args) => { calls.fetched.push(args); return objects; },
    updateCalendarObject: async (args) => {
      calls.updated.push(args.calendarObject);
      if (onUpdate) return onUpdate(args);
      return {};
    },
    deleteCalendarObject: async (args) => {
      calls.deleted.push(args.calendarObject);
      if (onDelete) return onDelete(args);
      return {};
    },
    createCalendarObject: async (args) => {
      calls.created.push(args);
      if (onCreate) return onCreate(args);
      return {};
    },
  };
}

function indexOf(uid, data = serverTodo(), url = OBJ_URL, etag = 'etag-1') {
  return new Map([[uid, { url, etag, data }]]);
}

// ── Feld-Abbildung ──────────────────────────────────────────────────────────────

test('DUE ohne Uhrzeit ist ein reines Datum, mit Uhrzeit ein UTC-Zeitstempel', () => {
  assert.deepStrictEqual(dueField('2026-08-04', null), { value: '20260804', params: ';VALUE=DATE' });
  // due_time ist Wanduhrzeit im Haushalt (hier Europe/Berlin, Sommerzeit UTC+2).
  assert.deepStrictEqual(dueField('2026-08-04', '14:30'), { value: '20260804T123000Z', params: '' });
  // Im Winter greift derselbe Weg mit einem anderen Offset (UTC+1).
  assert.deepStrictEqual(dueField('2026-01-14', '14:30'), { value: '20260114T133000Z', params: '' });
  assert.strictEqual(dueField(null, '14:30'), null);
});

test('Eine Fälligkeit mit Uhrzeit überlebt den Roundtrip als derselbe Zeitpunkt', () => {
  // Der Weg, den eine Aufgabe wirklich geht: Serverobjekt → Parser → Anzeigefelder
  // → zurück ins Objekt. Vor dem Fix stand hier 12:30 statt 14:30, verschoben um
  // genau den Zonenoffset - und der Rückweg schrieb die Verschiebung fest.
  const [todo] = parseVTODO([
    'BEGIN:VCALENDAR', 'BEGIN:VTODO', 'UID:todo-1@test', 'SUMMARY:Milch kaufen',
    'DUE;TZID=Europe/Berlin:20260804T143000', 'END:VTODO', 'END:VCALENDAR',
  ].join('\r\n'));

  const { date, time } = splitDue(todo.due);
  assert.deepStrictEqual({ date, time }, { date: '2026-08-04', time: '14:30' },
    'Yuvomi zeigt die Uhrzeit, die auch der Server-Client zeigt');
  assert.deepStrictEqual(dueField(date, time), { value: '20260804T123000Z', params: '' });
  assert.strictEqual(
    new Date('20260804T123000Z'.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')).toISOString(),
    new Date(todo.due).toISOString(),
    'derselbe Instant wie im Serverobjekt'
  );
});

test('Eine Fälligkeit ohne Zonenangabe ist bereits Wanduhrzeit', () => {
  // Floating: der Server sagt „14:30", ohne zu sagen wo. Umrechnen wäre geraten.
  const [todo] = parseVTODO([
    'BEGIN:VCALENDAR', 'BEGIN:VTODO', 'UID:todo-1@test', 'SUMMARY:x',
    'DUE:20260804T143000', 'END:VTODO', 'END:VCALENDAR',
  ].join('\r\n'));
  assert.deepStrictEqual(splitDue(todo.due), { date: '2026-08-04', time: '14:30' });

  // Ganztägig bleibt ganztägig - eine Zone hat ein reines Datum nicht.
  assert.deepStrictEqual(splitDue('2026-08-04'), { date: '2026-08-04', time: null });
  assert.deepStrictEqual(splitDue(null), { date: null, time: null });
});

test('Priorität überlebt den Roundtrip bandtreu, urgent bleibt urgent', () => {
  assert.strictEqual(priorityToVtodo('urgent'), '1');
  assert.strictEqual(priorityToVtodo('high'),   '2');
  assert.strictEqual(priorityToVtodo('medium'), '5');
  assert.strictEqual(priorityToVtodo('low'),    '9');
  assert.strictEqual(priorityToVtodo('none'),   null);

  // Rückweg: dasselbe Band lässt die feinere lokale Angabe stehen.
  assert.strictEqual(mapVtodoPriority(1, 'urgent'), 'urgent');
  assert.strictEqual(mapVtodoPriority(2, 'urgent'), 'urgent');
  assert.strictEqual(mapVtodoPriority(1, 'high'),   'high');
  // Ein Bandwechsel auf dem Server gewinnt trotzdem.
  assert.strictEqual(mapVtodoPriority(5, 'urgent'), 'medium');
  assert.strictEqual(mapVtodoPriority(null, 'urgent'), 'none');
  // Ohne lokalen Stand unverändert zur bisherigen Abbildung.
  assert.strictEqual(mapVtodoPriority(1), 'high');
  assert.strictEqual(mapVtodoPriority(9), 'low');
});

test('Status: erledigt gewinnt, in Arbeit überlebt ein NEEDS-ACTION', () => {
  const open = { completed: false, status: 'needs-action' };
  assert.strictEqual(mapVtodoStatus({ completed: true, status: 'completed' }, 'open'), 'done');
  assert.strictEqual(mapVtodoStatus({ completed: false, status: 'in-process' }, 'open'), 'in_progress');
  assert.strictEqual(mapVtodoStatus(open, 'in_progress'), 'in_progress');
  assert.strictEqual(mapVtodoStatus(open, 'done'), 'open', 'Wiederöffnen auf dem Server gewinnt');
  assert.strictEqual(mapVtodoStatus(open), 'open');
  // Die Ablage steht seit #688 nicht mehr im Statusfeld - sie kann hier also
  // weder ankommen noch überschrieben werden. Eine abgelegte Aufgabe trägt ihren
  // echten Status, und der wird wie jeder andere abgeglichen.
  assert.strictEqual(mapVtodoStatus(open, 'archived'), 'open');
});

test('Erledigt-Zustand wandert als STATUS, COMPLETED und PERCENT-COMPLETE', () => {
  const done = icsFieldsForTask({ title: 'x', status: 'done' }, false);
  assert.strictEqual(done.STATUS, 'COMPLETED');
  assert.strictEqual(done['PERCENT-COMPLETE'], '100');
  assert.match(done.COMPLETED, /^\d{8}T\d{6}Z$/);

  // Bereits erledigt: der ursprüngliche Zeitpunkt bleibt stehen.
  assert.ok(!('COMPLETED' in icsFieldsForTask({ title: 'x', status: 'done' }, true)));

  const open = icsFieldsForTask({ title: 'x', status: 'open' }, true);
  assert.strictEqual(open.STATUS, 'NEEDS-ACTION');
  assert.strictEqual(open.COMPLETED, null, 'null entfernt die Property');
  assert.strictEqual(open['PERCENT-COMPLETE'], null);

  assert.strictEqual(icsFieldsForTask({ title: 'x', status: 'in_progress' }).STATUS, 'IN-PROCESS');
  assert.strictEqual(icsFieldsForShoppingItem({ name: 'Milch', is_checked: 1 }).STATUS, 'COMPLETED');
  assert.strictEqual(icsFieldsForShoppingItem({ name: 'Milch', is_checked: 0 }).STATUS, 'NEEDS-ACTION');
});

// ── Patcher ─────────────────────────────────────────────────────────────────────

test('patchICSTodo tauscht nur die verwalteten Properties', () => {
  const out = patchICSTodo(serverTodo(), 'todo-1@test', icsFieldsForTask({
    title: 'Hafermilch kaufen', description: 'ohne Zucker', status: 'done',
    due_date: '2026-08-04', due_time: null, priority: 'urgent',
  }));

  assert.ok(out.includes('SUMMARY:Hafermilch kaufen'));
  assert.ok(out.includes('DESCRIPTION:ohne Zucker'));
  assert.ok(out.includes('DUE;VALUE=DATE:20260804'));
  assert.ok(out.includes('PRIORITY:1'));
  assert.ok(out.includes('STATUS:COMPLETED'));
  assert.ok(out.includes('PERCENT-COMPLETE:100'));
  assert.ok(/COMPLETED:\d{8}T\d{6}Z/.test(out));

  // Alles, was Yuvomi nicht kennt, bleibt Zeichen für Zeichen stehen.
  assert.ok(out.includes('X-APPLE-SORT-ORDER:12'), 'fremde Property bleibt');
  // Ohne geladene Tags gilt CATEGORIES als unbekannt, nicht als leer (#586) -
  // sonst löschte jeder Aufrufer mit einer rohen Zeile die Tags des Servers.
  assert.ok(out.includes('CATEGORIES:Haushalt'), 'Tags ohne Kenntnisstand bleiben');
  assert.ok(out.includes('BEGIN:VALARM') && out.includes('TRIGGER:-PT15M'), 'Alarm bleibt');
  assert.ok(out.includes('SEQUENCE:1'), 'SEQUENCE wird gesetzt, damit Clients die Kopie erneuern');
  assert.strictEqual(out.match(/BEGIN:VTODO/g).length, 1);
});

// ── Tags ⇄ CATEGORIES (#586) ────────────────────────────────────────────────────

test('CATEGORIES kommt als Tag-Liste an: mehrfach, kommasepariert, escapt', () => {
  // Drei Eigenheiten auf einmal, weil jede für sich einen naiven Parser bricht:
  // die Property darf mehrfach vorkommen, das Komma trennt, und `\,` ist ein
  // Komma IM Wert. Der Dedup eint zusätzlich die Schreibweise.
  const todo = parseVTODO(serverTodo({
    extra: ['CATEGORIES:Garten,Haus\\, Hof', 'CATEGORIES:garten'],
  }))[0];
  assert.deepStrictEqual(todo.tags, ['Haushalt', 'Garten', 'Haus, Hof']);
});

test('Ein VTODO ohne CATEGORIES liefert eine leere Liste, nicht undefined', () => {
  const bare = ['BEGIN:VTODO', 'UID:x@test', 'SUMMARY:Ohne', 'END:VTODO'].join('\r\n');
  assert.deepStrictEqual(parseVTODO(bare)[0].tags, []);
});

test('Der Inbound spiegelt CATEGORIES in die Tags der Aufgabe', async () => {
  const accountId = reset();
  enableList(accountId, 'tasks');
  const client = fakeClient({
    objects: [{ url: OBJ_URL, etag: 'e1', data: serverTodo({ extra: ['CATEGORIES:Garten'] }) }],
  });

  await sync({ createClient: async () => client });

  const task = db.prepare("SELECT id FROM tasks WHERE external_uid = 'todo-1@test'").get();
  assert.deepStrictEqual(loadTags(db, task.id), ['Garten', 'Haushalt']);
});

test('Der Server führt die Tags: entfernte CATEGORIES verschwinden auch lokal', async () => {
  const accountId = reset();
  enableList(accountId, 'tasks');

  const withTags = fakeClient({ objects: [{ url: OBJ_URL, etag: 'e1', data: serverTodo() }] });
  await sync({ createClient: async () => withTags });
  const task = db.prepare("SELECT id FROM tasks WHERE external_uid = 'todo-1@test'").get();
  assert.deepStrictEqual(loadTags(db, task.id), ['Haushalt']);

  // Dieselbe Aufgabe, auf dem Server entkategorisiert.
  const stripped = serverTodo().replace('CATEGORIES:Haushalt\r\n', '');
  const without = fakeClient({ objects: [{ url: OBJ_URL, etag: 'e2', data: stripped }] });
  await sync({ createClient: async () => without });
  assert.deepStrictEqual(loadTags(db, task.id), []);
});

test('Eine reine Tag-Änderung löst einen Push aus', () => {
  const accountId = reset();
  const task = insertTask({ accountId });
  // Ohne den mitgereichten Schlüssel bliebe die Änderung unbemerkt: Tags liegen
  // in task_tags, der Feldvergleich sieht nur die Zeile selbst.
  const pending = markTodoOutbound(
    'tasks',
    { ...task, tags_key: tagsKey([]) },
    { ...task, tags_key: tagsKey(['Garten']) },
  );
  assert.strictEqual(pending, true);
  assert.strictEqual(db.prepare('SELECT outbound_dirty FROM tasks WHERE id = ?').get(task.id).outbound_dirty, 1);
});

test('Bloßes Umsortieren derselben Tags ist keine Änderung', () => {
  const accountId = reset();
  const task = insertTask({ accountId });
  const pending = markTodoOutbound(
    'tasks',
    { ...task, tags_key: tagsKey(['Garten', 'Haus']) },
    { ...task, tags_key: tagsKey(['Haus', 'Garten']) },
  );
  assert.strictEqual(pending, false, 'sonst pushte jeder Speichervorgang erneut');
});

test('Eine andere Schreibweise ist sehr wohl eine Änderung', () => {
  // Die Gegenprobe. Würde tagsKey die Schreibweise einebnen, käme ein
  // Umbenennen von "garten" auf "Garten" nie beim Server an: lokal stünde die
  // neue Schreibweise, hier fiele die Entscheidung "nichts zu tun", und der
  // nächste Sync-Lauf holte die alte zurück.
  const accountId = reset();
  const task = insertTask({ accountId });
  const pending = markTodoOutbound(
    'tasks',
    { ...task, tags_key: tagsKey(['garten']) },
    { ...task, tags_key: tagsKey(['Garten']) },
  );
  assert.strictEqual(pending, true);
});

test('Der Push schreibt die vollständige Tag-Liste nach CATEGORIES', async () => {
  const accountId = reset();
  const task = insertTask({ accountId });
  setTags(db, task.id, ['Garten', 'Haus, Hof']);
  db.prepare('UPDATE tasks SET outbound_dirty = 1 WHERE id = ?').run(task.id);

  const client = fakeClient();
  await processPendingUpdates(client, accountId, 'tasks', indexOf('todo-1@test'));

  const sent = client.calls.updated[0].data;
  // Das trennende Komma bleibt roh, das Komma im Wert bleibt escapt - genau
  // andersherum wäre aus einem Tag zwei geworden.
  assert.ok(sent.includes('CATEGORIES:Garten,Haus\\, Hof'), `CATEGORIES fehlt oder ist falsch escapt:\n${sent}`);
  assert.deepStrictEqual(parseVTODO(sent)[0].tags, ['Garten', 'Haus, Hof'], 'Roundtrip muss verlustfrei sein');
});

test('Sind lokal alle Tags weg, verschwindet CATEGORIES auf dem Server', async () => {
  const accountId = reset();
  const task = insertTask({ accountId });
  setTags(db, task.id, []);
  db.prepare('UPDATE tasks SET outbound_dirty = 1 WHERE id = ?').run(task.id);

  const client = fakeClient();
  await processPendingUpdates(client, accountId, 'tasks', indexOf('todo-1@test'));

  const sent = client.calls.updated[0].data;
  assert.ok(!/^CATEGORIES:/m.test(sent), `CATEGORIES hätte entfernt werden müssen:\n${sent}`);
  // Der Rest des fremden Objekts bleibt trotzdem unangetastet.
  assert.ok(sent.includes('X-APPLE-SORT-ORDER:12') && sent.includes('BEGIN:VALARM'));
});

test('Wiederöffnen entfernt COMPLETED, sonst bliebe die Aufgabe erledigt', () => {
  const out = patchICSTodo(
    serverTodo({ completed: true }), 'todo-1@test',
    icsFieldsForTask({ title: 'Milch kaufen', status: 'open' }, true)
  );
  assert.ok(out.includes('STATUS:NEEDS-ACTION'));
  assert.ok(!/^COMPLETED[;:]/m.test(out), 'COMPLETED muss verschwinden');
  assert.ok(!/^PERCENT-COMPLETE[;:]/m.test(out), 'PERCENT-COMPLETE muss verschwinden');
});

test('Fällt die Fälligkeit weg, verschwindet auch DUE', () => {
  const withDue = patchICSTodo(serverTodo(), 'todo-1@test',
    icsFieldsForTask({ title: 'x', status: 'open', due_date: '2026-08-04', due_time: '14:30' }));
  assert.ok(withDue.includes('DUE:20260804T123000Z'));

  const withoutDue = patchICSTodo(withDue, 'todo-1@test',
    icsFieldsForTask({ title: 'x', status: 'open' }));
  assert.ok(!/^DUE[;:]/m.test(withoutDue));
});

test('Ein Objekt ohne passende UID wird nicht angefasst', () => {
  assert.strictEqual(patchICSTodo(serverTodo(), 'fremd@test', { SUMMARY: 'x' }), null);
  // Auch ein VEVENT-Objekt ist kein Ziel: sonst würde ein Termin als Aufgabe gepatcht.
  const vevent = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:todo-1@test\r\nEND:VEVENT\r\nEND:VCALENDAR';
  assert.strictEqual(patchICSTodo(vevent, 'todo-1@test', { SUMMARY: 'x' }), null);
});

// ── Vormerkung ──────────────────────────────────────────────────────────────────

test('Nur gespiegelte Einträge und nur gespiegelte Felder lösen einen Push aus', () => {
  const accountId = reset();
  const task = insertTask({ accountId });

  assert.strictEqual(markTodoOutbound('tasks', task, { ...task, title: 'Neu' }), true);
  assert.strictEqual(reloadTask(task.id).outbound_dirty, 1);

  db.prepare('UPDATE tasks SET outbound_dirty = 0 WHERE id = ?').run(task.id);
  assert.strictEqual(
    markTodoOutbound('tasks', task, { ...task, category: 'misc', points: 5 }), false,
    'Kategorie und Punkte kennt VTODO nicht'
  );
  assert.strictEqual(reloadTask(task.id).outbound_dirty, 0);

  const local = insertTask({ accountId: null, source: 'local', uid: null, objectUrl: null });
  assert.strictEqual(
    markTodoOutbound('tasks', local, { ...local, title: 'Neu' }), false,
    'eine rein lokale Aufgabe geht nirgendwohin'
  );
});

test('Ein Tombstone überlebt den gelöschten Eintrag und ist idempotent', () => {
  const accountId = reset();
  const task = insertTask({ accountId });

  assert.strictEqual(queueTodoDeletion('tasks', task), true);
  assert.strictEqual(queueTodoDeletion('tasks', task), true, 'zweimal vormerken ist erlaubt');
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);

  const rows = pendingDeletions(accountId, 'tasks');
  assert.strictEqual(rows.length, 1, 'genau ein Tombstone');
  assert.strictEqual(rows[0].uid, 'todo-1@test');
  assert.strictEqual(rows[0].object_url, OBJ_URL);

  // Module teilen sich die Tabelle, aber nicht ihre UID-Räume.
  assert.deepStrictEqual([...pendingDeletionUids(accountId, 'shopping')], []);
});

test('Eine lokale Aufgabe hinterlässt keinen Tombstone', () => {
  const accountId = reset();
  const local = insertTask({ accountId: null, source: 'local', uid: null, objectUrl: null });
  assert.strictEqual(queueTodoDeletions('tasks', [local]), 0);
  assert.strictEqual(pendingDeletions(accountId, 'tasks').length, 0);
});

// ── Gelöschtes Konto ────────────────────────────────────────────────────────────
//
// external_account_id trägt keinen Fremdschlüssel (v45), die Tombstone-Tabelle
// sehr wohl: eine Zeile, die auf ein gelöschtes Konto zeigt, ließ sich nicht
// mehr löschen - der Tombstone scheiterte, das lokale DELETE kam nie dazu, und
// die entfernte Kopie blieb ohnehin unerreichbar stehen.

test('Das Löschen eines Kontos entkoppelt seine gespiegelten Zeilen', () => {
  const accountId = reset();
  const task = insertTask({ accountId });
  const item = insertShoppingItem({ accountId, uid: 'todo-2@test' });
  db.prepare('UPDATE tasks SET outbound_dirty = 1, outbound_attempts = 2 WHERE id = ?').run(task.id);

  deleteAccount(accountId);

  for (const [label, row] of [
    ['Aufgabe', reloadTask(task.id)],
    ['Einkaufsposten', db.prepare('SELECT * FROM shopping_items WHERE id = ?').get(item.id)],
  ]) {
    assert.ok(row, `${label}: Nutzerdaten bleiben, nur die Verbindung geht`);
    assert.strictEqual(row.external_source, 'local', `${label}: gehört ab jetzt Yuvomi allein`);
    assert.strictEqual(row.external_account_id, null, `${label}: keine tote Kontokennung`);
    assert.strictEqual(row.external_uid, null, `${label}: die UID bedeutet nichts mehr`);
    assert.strictEqual(row.external_object_url, null);
    assert.strictEqual(row.outbound_dirty, 0, `${label}: es gibt niemanden mehr, der das empfinge`);
    assert.strictEqual(row.outbound_attempts, 0);
  }
});

test('Eine entkoppelte Aufgabe lässt sich löschen, ohne am Fremdschlüssel zu scheitern', () => {
  const accountId = reset();
  const task = insertTask({ accountId });
  deleteAccount(accountId);

  // Der Löschpfad in routes/tasks.js liest die Zeile vor dem DELETE - nach der
  // Entkopplung ist sie lokal, also gibt es nichts vorzumerken.
  const doomed = reloadTask(task.id);
  assert.strictEqual(queueTodoDeletion('tasks', doomed), false);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
  assert.strictEqual(reloadTask(task.id), undefined);
});

test('Eine Zeile mit toter Kontokennung wird still übersprungen statt zu werfen', () => {
  // Gedriftete Datenbank: das Konto ist weg, die Kennung steht noch. Ohne
  // Vorprüfung warf der INSERT in caldav_todo_pending_deletions hier einen
  // Fremdschlüsselfehler - und der Route-Handler daraufhin eine 500, ohne je
  // beim lokalen DELETE anzukommen.
  const accountId = reset();
  const task = insertTask({ accountId });
  const item = insertShoppingItem({ accountId, uid: 'todo-2@test' });
  db.prepare('DELETE FROM caldav_accounts WHERE id = ?').run(accountId);

  assert.strictEqual(queueTodoDeletion('tasks', task), false);
  assert.strictEqual(queueTodoDeletions('shopping', [item]), 0);
  // Auch die Bearbeitung: ohne Konto gibt es niemanden, der den Push abholt.
  assert.strictEqual(
    markTodoOutbound('tasks', task, { ...task, title: 'Milch und Butter kaufen' }), false
  );
  assert.strictEqual(reloadTask(task.id).outbound_dirty, 0);
});

// ── Ausführung ──────────────────────────────────────────────────────────────────

test('Eine vorgemerkte Änderung landet als PUT auf der Objekt-URL', async () => {
  const accountId = reset();
  const task = insertTask({ accountId, title: 'Hafermilch kaufen', status: 'done' });
  db.prepare('UPDATE tasks SET outbound_dirty = 1 WHERE id = ?').run(task.id);

  const client = fakeClient();
  const pushed = await processPendingUpdates(client, accountId, 'tasks', indexOf('todo-1@test'));

  assert.strictEqual(pushed, 1);
  assert.strictEqual(client.calls.updated.length, 1);
  assert.strictEqual(client.calls.updated[0].url, OBJ_URL);
  assert.strictEqual(client.calls.updated[0].etag, 'etag-1', 'etag mitschicken, sonst überschreibt der PUT blind');
  assert.ok(client.calls.updated[0].data.includes('SUMMARY:Hafermilch kaufen'));
  assert.ok(client.calls.updated[0].data.includes('STATUS:COMPLETED'));
  assert.strictEqual(reloadTask(task.id).outbound_dirty, 0, 'erledigt, also nicht mehr vorgemerkt');
});

test('Ohne Originalobjekt wird nichts gepusht - ein Neubau verlöre den Rest', async () => {
  const accountId = reset();
  const task = insertTask({ accountId });
  db.prepare('UPDATE tasks SET outbound_dirty = 1 WHERE id = ?').run(task.id);

  const client = fakeClient();
  const pushed = await processPendingUpdates(client, accountId, 'tasks', new Map());

  assert.strictEqual(pushed, 0);
  assert.strictEqual(client.calls.updated.length, 0);
  assert.strictEqual(reloadTask(task.id).outbound_dirty, 1, 'bleibt für den nächsten Lauf vorgemerkt');
});

test('Ein Serverfehler zählt Versuche hoch und gibt erst am Limit auf', async () => {
  const accountId = reset();
  const task = insertTask({ accountId });
  db.prepare('UPDATE tasks SET outbound_dirty = 1 WHERE id = ?').run(task.id);

  const boom = () => { const e = new Error('kaputt'); e.code = 503; throw e; };
  const client = fakeClient({ onUpdate: boom });

  for (let i = 1; i < MAX_OUTBOUND_ATTEMPTS; i++) {
    await processPendingUpdates(client, accountId, 'tasks', indexOf('todo-1@test'));
    const row = reloadTask(task.id);
    assert.strictEqual(row.outbound_attempts, i);
    assert.strictEqual(row.outbound_dirty, 1, 'noch nicht aufgegeben');
  }

  await processPendingUpdates(client, accountId, 'tasks', indexOf('todo-1@test'));
  assert.strictEqual(reloadTask(task.id).outbound_dirty, 0, 'nach dem letzten Versuch aufgegeben');
});

test('Ein 404 gilt als erledigt: das Objekt ist auf dem Server ohnehin weg', async () => {
  const accountId = reset();
  const task = insertTask({ accountId });
  db.prepare('UPDATE tasks SET outbound_dirty = 1 WHERE id = ?').run(task.id);

  const gone = () => { const e = new Error('not found'); e.code = 404; throw e; };
  await processPendingUpdates(fakeClient({ onUpdate: gone }), accountId, 'tasks', indexOf('todo-1@test'));

  assert.strictEqual(reloadTask(task.id).outbound_dirty, 0);
  assert.strictEqual(reloadTask(task.id).outbound_attempts, 0);
});

test('Eine vorgemerkte Löschung wird als DELETE ausgeführt', async () => {
  const accountId = reset();
  const task = insertTask({ accountId });
  queueTodoDeletion('tasks', task);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);

  const client = fakeClient();
  const removed = await processPendingDeletions(client, accountId, 'tasks', indexOf('todo-1@test'));

  assert.strictEqual(removed, 1);
  assert.strictEqual(client.calls.deleted[0].url, OBJ_URL);
  assert.strictEqual(pendingDeletions(accountId, 'tasks').length, 0);
});

test('Ohne Objekt-URL bleibt der Tombstone liegen, bis ein voller Lauf ihn klärt', async () => {
  const accountId = reset();
  const task = insertTask({ accountId, objectUrl: null });
  queueTodoDeletion('tasks', task);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);

  // Sofortversuch: nur einzelne Objekte geholt, "der Server führt es nicht mehr"
  // ist nicht belegbar.
  const client = fakeClient();
  assert.strictEqual(await processPendingDeletions(client, accountId, 'tasks', new Map(), false), 0);
  assert.strictEqual(pendingDeletions(accountId, 'tasks').length, 1);
  assert.strictEqual(client.calls.deleted.length, 0, 'kein DELETE ins Blaue');

  // Voller Lauf: die Liste wurde abgerufen und enthält das Objekt nicht mehr.
  assert.strictEqual(await processPendingDeletions(client, accountId, 'tasks', new Map(), true), 1);
  assert.strictEqual(pendingDeletions(accountId, 'tasks').length, 0);
});

test('Einkaufsposten laufen über dieselbe Maschinerie', async () => {
  const accountId = reset();
  const item = insertShoppingItem({ accountId, is_checked: 1 });
  db.prepare('UPDATE shopping_items SET outbound_dirty = 1 WHERE id = ?').run(item.id);

  const client = fakeClient();
  const pushed = await processPendingUpdates(client, accountId, 'shopping', indexOf('todo-1@test'));

  assert.strictEqual(pushed, 1);
  assert.ok(client.calls.updated[0].data.includes('STATUS:COMPLETED'));
  assert.strictEqual(
    db.prepare('SELECT outbound_dirty FROM shopping_items WHERE id = ?').get(item.id).outbound_dirty, 0
  );
});

test('Ein unbekanntes Modul kommt nie bis zum SQL-Statement', () => {
  assert.throws(() => queueTodoDeletion('notes', {}), /Unknown VTODO module/);
  assert.deepStrictEqual(Object.keys(MODULES).sort(), ['shopping', 'tasks']);
});

// ── Sofortversuch ───────────────────────────────────────────────────────────────

test('flushOutbound holt die Objekte aus der abgeleiteten Collection', async () => {
  const accountId = reset();
  const task = insertTask({ accountId, title: 'Hafermilch kaufen' });
  db.prepare('UPDATE tasks SET outbound_dirty = 1 WHERE id = ?').run(task.id);

  const client = fakeClient({ objects: [{ url: OBJ_URL, etag: 'e9', data: serverTodo() }] });
  const result = await flushOutbound({ createClient: async () => client });

  assert.strictEqual(result.updated, 1);
  assert.strictEqual(client.calls.fetched[0].calendar.url, LIST_URL,
    'die Collection wird aus der Objekt-URL abgeleitet, denn die Aufgabe kennt nur diese');
  assert.deepStrictEqual(client.calls.fetched[0].objectUrls, [OBJ_URL]);
  assert.strictEqual(reloadTask(task.id).outbound_dirty, 0);
});

test('Zwei Sofortversuche laufen nicht ineinander (#593)', async () => {
  // Aufgaben und Einkauf teilen die Buchhaltung derselben Konten. Hinter jeder
  // Schreibroute steht ein Sofortversuch, und zwei davon gleichzeitig laesen
  // einander den Stand zwischen zwei Netzaufrufen weg - dieselbe Regel wie beim
  // Kalender, mit eigenem Schlüssel: server/utils/sync-lock.js.
  const accountId = reset();
  const first  = insertTask({ accountId, title: 'Erste' });
  db.prepare('UPDATE tasks SET outbound_dirty = 1 WHERE id = ?').run(first.id);

  let gateResolve;
  const gate = new Promise((resolve) => { gateResolve = resolve; });
  let clients = 0;
  const objects = [{ url: OBJ_URL, etag: 'e9', data: serverTodo() }];

  const running = flushOutbound({
    createClient: async () => {
      clients++;
      const client = fakeClient({ objects });
      const update = client.updateCalendarObject;
      client.updateCalendarObject = async (args) => { await gate; return update(args); };
      return client;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const waiting = [
    flushOutbound({ createClient: async () => { clients++; return fakeClient({ objects }); } }),
    flushOutbound({ createClient: async () => { clients++; return fakeClient({ objects }); } }),
  ];

  gateResolve();
  await running;
  await Promise.all(waiting);

  assert.strictEqual(clients, 1,
    'der Nachlauf findet nichts mehr offen und baut gar keine Verbindung auf');
  assert.strictEqual(reloadTask(first.id).outbound_dirty, 0);
});

test('Ein Sofortversuch wartet auf den laufenden VTODO-Sync (#593)', async () => {
  // Der Sync arbeitet dieselbe Rückrichtung ab wie der Sofortversuch. Beide
  // gleichzeitig hiesse: der eine zählt die Fehlversuche des anderen hoch und
  // verwirft am Ende dessen Arbeit.
  const accountId = reset();
  enableList(accountId);
  const task = insertTask({ accountId, title: 'Wartet' });
  db.prepare('UPDATE tasks SET outbound_dirty = 1 WHERE id = ?').run(task.id);

  let gateResolve;
  const gate = new Promise((resolve) => { gateResolve = resolve; });
  const syncClient = { fetchCalendars: async () => { await gate; return []; } };
  let flushed = 0;

  const syncing = sync({ createClient: async () => syncClient });
  await new Promise((resolve) => setImmediate(resolve));
  const flushing = flushOutbound({
    createClient: async () => { flushed++; return fakeClient({ objects: [] }); },
  });
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));

  try {
    assert.strictEqual(flushed, 0, 'solange der Sync läuft, baut der Sofortversuch nichts auf');
  } finally {
    // Auch wenn die Zusicherung fällt: der hängende Abruf muss enden, sonst
    // wartet die Suite auf einen Lauf, der nie zurückkehrt.
    gateResolve();
    await Promise.allSettled([syncing, flushing]);
  }
  assert.strictEqual(flushed, 1, 'danach holt er es nach');
});

test('Ohne offene Arbeit baut flushOutbound keinen Client auf', async () => {
  reset();
  let built = 0;
  const result = await flushOutbound({ createClient: async () => { built++; return fakeClient(); } });
  assert.deepStrictEqual(result, { deleted: 0, updated: 0, created: 0 });
  assert.strictEqual(built, 0);
});

// ── Abruf der Aufgabenliste ─────────────────────────────────────────────────────

test('Der Inbound fragt die Liste nach VTODO ab, nicht nach Terminen (#586)', async () => {
  const accountId = reset();
  enableList(accountId, 'tasks');

  // Attrappe eines regelkonformen Servers: der REPORT liefert nur, wonach der
  // comp-filter fragt. Ohne eigene Angabe filtert tsdav auf VEVENT - auf einer
  // Aufgabenliste blieb die Antwort damit leer, die Liste tauchte in den
  // Einstellungen auf und das Modul blieb trotzdem leer.
  const strict = fakeClient({ objects: [{ url: OBJ_URL, etag: 'e1', data: serverTodo() }] });
  const answer = strict.fetchCalendarObjects;
  strict.fetchCalendarObjects = async (args) => {
    const objects = await answer(args);
    return JSON.stringify(args.filters ?? []).includes('VTODO') ? objects : [];
  };

  await sync({ createClient: async () => strict });

  const task = db.prepare("SELECT * FROM tasks WHERE external_uid = 'todo-1@test'").get();
  assert.ok(task, 'die Aufgabe der Liste muss ankommen');
  assert.strictEqual(task.title, 'Milch kaufen');
});

// ── Zusammenspiel mit dem Inbound ───────────────────────────────────────────────

test('Der Inbound überschreibt keine Bearbeitung, die noch auf ihren Push wartet', async () => {
  const accountId = reset();
  enableList(accountId, 'tasks');
  const task = insertTask({ accountId, title: 'Hafermilch kaufen' });
  db.prepare('UPDATE tasks SET outbound_dirty = 1 WHERE id = ?').run(task.id);

  const client = fakeClient({ objects: [{ url: OBJ_URL, etag: 'e1', data: serverTodo() }] });
  await sync({ createClient: async () => client });

  const after = reloadTask(task.id);
  assert.strictEqual(after.title, 'Hafermilch kaufen', 'der alte Serverstand darf nicht zurückschlagen');
  assert.strictEqual(after.outbound_dirty, 0, 'stattdessen wurde die Änderung im selben Lauf gepusht');
  assert.ok(client.calls.updated[0].data.includes('SUMMARY:Hafermilch kaufen'));
});

test('Der Inbound legt einen lokal gelöschten Eintrag nicht wieder an', async () => {
  const accountId = reset();
  enableList(accountId, 'tasks');
  const task = insertTask({ accountId });
  queueTodoDeletion('tasks', task);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);

  // Der Server liefert die Aufgabe noch aus - das DELETE ist ja noch nicht raus.
  const client = fakeClient({ objects: [{ url: OBJ_URL, etag: 'e1', data: serverTodo() }] });
  await sync({ createClient: async () => client });

  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0, 'kein Wiedergänger');
  assert.strictEqual(client.calls.deleted.length, 1, 'stattdessen geht die Löschung raus');
  assert.strictEqual(pendingDeletions(accountId, 'tasks').length, 0);
});

test('Der Inbound trägt die Objekt-URL nach, ohne sie je zu entwerten', async () => {
  const accountId = reset();
  enableList(accountId, 'tasks');
  const task = insertTask({ accountId, objectUrl: null });

  const client = fakeClient({ objects: [{ url: OBJ_URL, etag: 'e1', data: serverTodo() }] });
  await sync({ createClient: async () => client });
  assert.strictEqual(reloadTask(task.id).external_object_url, OBJ_URL);

  // Ein Abruf ohne URL darf den gespeicherten Wert nicht löschen.
  const blind = fakeClient({ objects: [{ etag: 'e1', data: serverTodo() }] });
  await sync({ createClient: async () => blind });
  assert.strictEqual(reloadTask(task.id).external_object_url, OBJ_URL);
});

test('pendingUpdateUids meldet genau die wartenden Bearbeitungen', () => {
  const accountId = reset();
  const task = insertTask({ accountId });
  assert.strictEqual(pendingUpdateUids(accountId, 'tasks').size, 0);
  db.prepare('UPDATE tasks SET outbound_dirty = 1 WHERE id = ?').run(task.id);
  assert.deepStrictEqual([...pendingUpdateUids(accountId, 'tasks')], ['todo-1@test']);
});

// ── Migration v113 gegen eine befüllte Bestands-DB ──────────────────────────────

test('v113 ist additiv und startet mit neutralen Markern', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { default: Database } = await import('better-sqlite3-multiple-ciphers');
  const { MIGRATIONS } = await import('../server/db.js');

  const apply = (conn, migration) => {
    if (typeof migration.up === 'function') migration.up(conn);
    else conn.exec(migration.up);
    migration.afterUp?.(conn);
  };

  const old = new Database(join(mkdtempSync(join(tmpdir(), 'yuvomi-todomig-')), 'db.sqlite'));
  for (const migration of MIGRATIONS.filter((m) => m.version <= 112)) apply(old, migration);

  // Bestand, wie ihn ein Nutzer mit VTODO-Spiegel mitbringt.
  old.prepare("INSERT INTO users (id, username, display_name, password_hash, role) VALUES (1,'admin','Admin','x','admin')").run();
  old.prepare(`INSERT INTO caldav_accounts (id, name, caldav_url, username, password)
               VALUES (1, 'Radicale', 'https://dav.example/', 'u', 'p')`).run();
  old.prepare(`INSERT INTO tasks (id, title, created_by, external_uid, external_source, external_account_id)
               VALUES (7, 'Milch kaufen', 1, 'todo-1@test', 'caldav', 1)`).run();
  old.prepare("INSERT INTO shopping_lists (id, name, created_by) VALUES (3, 'Einkauf', 1)").run();
  old.prepare(`INSERT INTO shopping_items (id, list_id, name, external_uid, external_source, external_account_id)
               VALUES (5, 3, 'Butter', 'todo-2@test', 'caldav', 1)`).run();

  const before = old.prepare('SELECT * FROM tasks WHERE id = 7').get();
  apply(old, MIGRATIONS.find((m) => m.version === 113));
  const after = old.prepare('SELECT * FROM tasks WHERE id = 7').get();

  for (const [key, value] of Object.entries(before)) {
    assert.deepStrictEqual(after[key], value, `Spalte ${key} darf sich nicht ändern`);
  }
  assert.strictEqual(after.external_object_url, null, 'kein Backfill, die URL trägt der nächste Inbound nach');
  assert.strictEqual(after.outbound_dirty, 0, 'der erste Sync nach dem Update pusht nichts');
  assert.strictEqual(after.outbound_attempts, 0);
  assert.strictEqual(old.prepare('SELECT outbound_dirty FROM shopping_items WHERE id = 5').get().outbound_dirty, 0);

  // Module teilen die Tombstone-Tabelle, aber nicht ihren UID-Raum.
  const insert = old.prepare(
    'INSERT INTO caldav_todo_pending_deletions (account_id, module, uid) VALUES (?, ?, ?)'
  );
  insert.run(1, 'tasks', 'todo-1@test');
  insert.run(1, 'shopping', 'todo-1@test');
  assert.throws(() => insert.run(1, 'tasks', 'todo-1@test'), /UNIQUE/);
  assert.throws(() => insert.run(1, 'notes', 'todo-1@test'), /CHECK/);

  // Fällt das Konto weg, sind seine offenen Löschungen gegenstandslos.
  old.prepare('PRAGMA foreign_keys = ON').run();
  old.prepare('DELETE FROM caldav_accounts WHERE id = 1').run();
  assert.strictEqual(old.prepare('SELECT COUNT(*) AS n FROM caldav_todo_pending_deletions').get().n, 0);

  old.close();
});

test('v123 entkoppelt den Bestand toter Kontokennungen und lässt lebende in Ruhe', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { default: Database } = await import('better-sqlite3-multiple-ciphers');
  const { MIGRATIONS } = await import('../server/db.js');

  const apply = (conn, migration) => {
    if (typeof migration.up === 'function') migration.up(conn);
    else conn.exec(migration.up);
    migration.afterUp?.(conn);
  };

  const old = new Database(join(mkdtempSync(join(tmpdir(), 'yuvomi-detachmig-')), 'db.sqlite'));
  for (const migration of MIGRATIONS.filter((m) => m.version <= 122)) apply(old, migration);

  // Bestand eines Haushalts, der schon einmal ein CalDAV-Konto gelöscht hat:
  // Konto 1 lebt, Konto 2 gab es einmal und die Zeilen wissen nichts davon.
  old.prepare("INSERT INTO users (id, username, display_name, password_hash, role) VALUES (1,'admin','Admin','x','admin')").run();
  old.prepare(`INSERT INTO caldav_accounts (id, name, caldav_url, username, password)
               VALUES (1, 'Radicale', 'https://dav.example/', 'u', 'p')`).run();
  old.prepare("INSERT INTO shopping_lists (id, name, created_by) VALUES (3, 'Einkauf', 1)").run();

  const mkTask = old.prepare(`
    INSERT INTO tasks (id, title, created_by, external_uid, external_source,
                       external_account_id, external_object_url, outbound_dirty, outbound_attempts)
    VALUES (?, ?, 1, ?, 'caldav', ?, 'https://dav.example/o.ics', ?, ?)
  `);
  mkTask.run(7, 'Milch kaufen', 'todo-1@test', 1, 1, 3);   // lebendes Konto
  mkTask.run(8, 'Reifen wechseln', 'todo-2@test', 2, 1, 0); // verwaist
  old.prepare(`INSERT INTO shopping_items (id, list_id, name, external_uid, external_source,
                                           external_account_id, external_object_url)
               VALUES (5, 3, 'Butter', 'todo-3@test', 'caldav', 2, 'https://dav.example/b.ics')`).run();

  apply(old, MIGRATIONS.find((m) => m.version === 123));

  const orphan = old.prepare('SELECT * FROM tasks WHERE id = 8').get();
  assert.strictEqual(orphan.title, 'Reifen wechseln', 'die Aufgabe selbst bleibt - sie ist Nutzerdatum');
  assert.strictEqual(orphan.external_source, 'local');
  assert.strictEqual(orphan.external_account_id, null);
  assert.strictEqual(orphan.external_uid, null);
  assert.strictEqual(orphan.external_object_url, null);
  assert.strictEqual(orphan.outbound_dirty, 0);

  const orphanItem = old.prepare('SELECT * FROM shopping_items WHERE id = 5').get();
  assert.strictEqual(orphanItem.external_source, 'local');
  assert.strictEqual(orphanItem.external_account_id, null);

  // Ein noch verbundenes Konto darf die Migration nicht mit abräumen, sonst
  // stünde nach dem Update ein ganzer Spiegel still.
  const live = old.prepare('SELECT * FROM tasks WHERE id = 7').get();
  assert.strictEqual(live.external_source, 'caldav');
  assert.strictEqual(live.external_account_id, 1);
  assert.strictEqual(live.external_uid, 'todo-1@test');
  assert.strictEqual(live.outbound_dirty, 1, 'eine wartende Bearbeitung bleibt vorgemerkt');
  assert.strictEqual(live.outbound_attempts, 3);

  old.close();
});

test('Der Inbound spiegelt CATEGORIES auch in die Tags eines Einkaufspostens', async () => {
  // Eine Erinnerungsliste kann auf Aufgaben ODER auf den Einkauf zeigen (#617).
  // Bis hierher fielen die CATEGORIES eines Einkaufspostens stillschweigend weg.
  const accountId = reset();
  enableList(accountId, 'shopping');
  const client = fakeClient({
    objects: [{ url: OBJ_URL, etag: 'e1', data: serverTodo({ extra: ['CATEGORIES:Bio'] }) }],
  });

  await sync({ createClient: async () => client });

  const item = db.prepare("SELECT id, category FROM shopping_items WHERE external_uid = 'todo-1@test'").get();
  assert.deepStrictEqual(loadItemTags(db, item.id), ['Bio', 'Haushalt']);
  // Die Kategorie ist hier der Gang im Laden, eine verwaltete Liste: sie darf
  // sich von fremden CATEGORIES nicht befuellen lassen.
  assert.strictEqual(item.category, 'Sonstiges');
});

test('Der Push eines Einkaufspostens fasst CATEGORIES nicht an', () => {
  // Der Einkauf spiegelt CATEGORIES nur herein (#586): er zeigt die Etiketten
  // der Quellliste, verwaltet sie aber nicht. Nähme icsFieldsForShoppingItem
  // CATEGORIES auf, löschte jeder Haken auf einem Posten die Tags, die der
  // Server kennt und Yuvomi nie gesehen hat - genau der Fehler, den die
  // Aufgaben-Seite nur vermeiden darf, weil sie die Liste vollständig führt.
  const fields = icsFieldsForShoppingItem({ id: 1, name: 'Milch', is_checked: 0 });
  assert.ok(!('CATEGORIES' in fields),
    'Ein Feld, das nicht im Patch steht, lässt die Property auf dem Server unberührt');
});

// ── Anlegen: Yuvomi → Server (#695) ─────────────────────────────────────────────

/** Eine hier entstandene Aufgabe mit gewaehltem Ziel. */
function insertLocalTask({ accountId, listUrl = LIST_URL, ...fields } = {}) {
  const f = {
    title: 'Reifen wechseln', description: null, priority: 'none', status: 'open',
    due_date: null, due_time: null, parent: null, ...fields,
  };
  const r = db.prepare(`
    INSERT INTO tasks (title, description, priority, status, due_date, due_time, created_by,
                       parent_task_id, external_source,
                       target_caldav_account_id, target_caldav_list_url)
    VALUES (@title, @description, @priority, @status, @due_date, @due_time, 1,
            @parent, 'local', @accountId, @listUrl)
  `).run({ ...f, accountId: accountId ?? null, listUrl });
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(r.lastInsertRowid);
}

const listsByUrl = () => new Map([[LIST_URL, { url: LIST_URL, displayName: 'Erinnerungen' }]]);

test('Ein neues VTODO traegt die Felder der Aufgabe, gebaut aus demselben Patcher', () => {
  // Der Grund fuer das Geruest-plus-Patch-Verfahren: es darf keine zweite
  // Serialisierung neben icsFieldsForTask geben, sonst laeuft sie beim naechsten
  // Feld auseinander.
  const uid = todoUidFor('tasks', 42);
  const ics = buildTodoICS('tasks', {
    id: 42, title: 'Reifen wechseln', description: 'Sommerreifen',
    priority: 'high', status: 'open', due_date: '2026-09-01', due_time: null, tags: ['Auto'],
  }, uid);

  assert.match(ics, /BEGIN:VTODO/);
  assert.match(ics, new RegExp(`UID:${uid.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
  assert.match(ics, /SUMMARY:Reifen wechseln/);
  assert.match(ics, /DESCRIPTION:Sommerreifen/);
  assert.match(ics, /DUE;VALUE=DATE:20260901/);
  assert.match(ics, /PRIORITY:2/);
  assert.match(ics, /STATUS:NEEDS-ACTION/);
  assert.match(ics, /CATEGORIES:Auto/);
});

test('Die UID einer neuen Aufgabe haengt an ihrer Id, nicht am Zufall', () => {
  // Scheitert der Schritt NACH dem Upload, nimmt der naechste Lauf dieselbe UID
  // und ueberschreibt das Objekt. Mit einer Zufalls-UID staende die Aufgabe
  // danach doppelt auf dem Server.
  assert.strictEqual(todoUidFor('tasks', 7), todoUidFor('tasks', 7));
  assert.notStrictEqual(todoUidFor('tasks', 7), todoUidFor('tasks', 8));
});

test('pendingCreations findet nur lokale Aufgaben mit Ziel - keine Spiegel, keine Unteraufgaben', () => {
  const accountId = reset();
  enableList(accountId);
  const wanted = insertLocalTask({ accountId });
  insertLocalTask({ accountId, listUrl: null });          // ohne Ziel
  insertTask({ accountId });                              // bereits gespiegelt
  const parent = insertLocalTask({ accountId, title: 'Umzug' });
  insertLocalTask({ accountId, title: 'Kartons', parent: parent.id });

  const rows = pendingCreations(accountId, 'tasks');
  assert.deepStrictEqual(rows.map((r) => r.title), [wanted.title, parent.title]);
});

test('Ein Upload macht die Aufgabe zum Spiegel und raeumt ihr Ziel ab', async () => {
  const accountId = reset();
  enableList(accountId);
  const task = insertLocalTask({ accountId, due_date: '2026-09-01' });
  const client = fakeClient();

  const created = await processPendingCreations(client, accountId, 'tasks', listsByUrl());

  assert.strictEqual(created, 1);
  assert.strictEqual(client.calls.created.length, 1);
  assert.match(client.calls.created[0].iCalString, /SUMMARY:Reifen wechseln/);

  const row = reloadTask(task.id);
  assert.strictEqual(row.external_source, 'caldav');
  assert.strictEqual(row.external_uid, todoUidFor('tasks', task.id));
  assert.strictEqual(row.external_account_id, accountId);
  assert.strictEqual(row.external_object_url, `${LIST_URL}${todoUidFor('tasks', task.id)}.ics`);
  // Das Ziel ist erledigt und darf nicht als Dauerauftrag stehen bleiben.
  assert.strictEqual(row.target_caldav_account_id, null);
  assert.strictEqual(row.target_caldav_list_url, null);
  // Und ab hier laeuft sie ueber den normalen Aenderungspfad.
  assert.strictEqual(pendingCreations(accountId, 'tasks').length, 0);
});

test('Eine verschwundene Zielliste laesst die Aufgabe lokal, statt es ewig zu versuchen', async () => {
  const accountId = reset();
  enableList(accountId);
  const task = insertLocalTask({ accountId, listUrl: 'https://dav.example/dav/u/weg/' });
  const client = fakeClient();

  const created = await processPendingCreations(client, accountId, 'tasks', listsByUrl());

  assert.strictEqual(created, 0);
  assert.strictEqual(client.calls.created.length, 0);
  const row = reloadTask(task.id);
  assert.strictEqual(row.external_source, 'local');
  assert.strictEqual(row.target_caldav_list_url, null,
    'Ohne erreichbares Ziel wird die Aufgabe freigegeben - das ist der Zustand vor #695 und kostet nichts');
});

test('Ein gescheiterter Upload bleibt vorgemerkt und gibt nicht auf', async () => {
  // Anders als eine Aenderung hat ein Upload keinen Stand, der veralten koennte.
  // Er darf deshalb nicht nach N Versuchen verworfen werden - sonst waere die
  // Aufgabe still fuer immer lokal.
  const accountId = reset();
  enableList(accountId);
  const task = insertLocalTask({ accountId });
  const client = fakeClient({ onCreate: async () => { throw new Error('503 Service Unavailable'); } });

  const created = await processPendingCreations(client, accountId, 'tasks', listsByUrl());

  assert.strictEqual(created, 0);
  const row = reloadTask(task.id);
  assert.strictEqual(row.external_source, 'local');
  assert.strictEqual(row.target_caldav_account_id, accountId);
  assert.strictEqual(pendingCreations(accountId, 'tasks').length, 1);
});

test('Der Sofortversuch laedt neue Aufgaben hoch', async () => {
  const accountId = reset();
  enableList(accountId);
  const task = insertLocalTask({ accountId });
  const client = fakeClient();

  const result = await flushOutbound({ createClient: async () => client });

  assert.strictEqual(result.created, 1);
  assert.strictEqual(reloadTask(task.id).external_source, 'caldav');
});

test('Der Sync-Lauf laedt hoch, ohne dass der Prune die frische Aufgabe gleich wieder entfernt', async () => {
  // Die Reihenfolge ist der Punkt: der Prune raeumt lokale Spiegel weg, die der
  // Server nicht mehr fuehrt. Liefe der Upload VOR ihm, saehe er eine Aufgabe,
  // die in diesem Lauf noch nicht abgerufen wurde - und loeschte sie sofort.
  const accountId = reset();
  enableList(accountId);
  const task = insertLocalTask({ accountId });
  const client = fakeClient({ objects: [] });

  await sync({ createClient: async () => client });

  const row = reloadTask(task.id);
  assert.ok(row, 'Die Aufgabe hat den Lauf ueberlebt');
  assert.strictEqual(row.external_source, 'caldav');
  assert.strictEqual(client.calls.created.length, 1);
});

test('Eine Liste, die auf den Einkauf zeigt, nimmt keine Aufgaben an', async () => {
  // Sonst kaeme die Aufgabe als Einkaufsposten zurueck. Die Route weist das
  // bereits ab; hier zaehlt der zweite Riegel im Dienst selbst.
  const accountId = reset();
  enableList(accountId, 'shopping');
  const task = insertLocalTask({ accountId });
  const client = fakeClient();

  await sync({ createClient: async () => client });

  assert.strictEqual(client.calls.created.length, 0);
  assert.strictEqual(reloadTask(task.id).external_source, 'local');
});

// ════════════════════════════════════════════════════════════════════════════════
// Neu angelegte Einkaufsartikel hochladen (#831)
//
// Umbenennen, Abhaken und Loeschen liefen laengst zum Server, ein hier
// angelegter Artikel blieb aber fuer immer lokal - die Liste lief nach jedem
// neuen Eintrag auseinander, obwohl die Oberflaeche einen Zwei-Wege-Sync
// verspricht. Anders als eine Aufgabe traegt ein Artikel kein eigenes Ziel:
// die Zuordnung Server-Liste <-> Yuvomi-Liste IST die Zielangabe.
// ════════════════════════════════════════════════════════════════════════════════

function insertShoppingList(name = 'Einkauf') {
  const r = db.prepare('INSERT INTO shopping_lists (name, created_by) VALUES (?, 1)').run(name);
  return Number(r.lastInsertRowid);
}

function insertLocalItem(listId, name = 'Brot') {
  const r = db.prepare(
    "INSERT INTO shopping_items (list_id, name, external_source) VALUES (?, ?, 'local')"
  ).run(listId, name);
  return db.prepare('SELECT * FROM shopping_items WHERE id = ?').get(r.lastInsertRowid);
}

const reloadItem = (id) => db.prepare('SELECT * FROM shopping_items WHERE id = ?').get(id);
const shoppingTargets = (listId) => [{ listUrl: LIST_URL, targetListId: listId }];

test('pendingShoppingCreations findet nur lokale Artikel der zugeordneten Liste', async () => {
  const { pendingShoppingCreations } = await import('../server/services/caldav-todo-outbound.js');
  const accountId = reset();
  const listId    = insertShoppingList();
  const other     = insertShoppingList('Baumarkt');
  enableList(accountId, 'shopping', listId);

  const local = insertLocalItem(listId);
  insertLocalItem(other, 'Schrauben');
  db.prepare(
    "INSERT INTO shopping_items (list_id, name, external_source, external_uid, external_account_id) VALUES (?, 'Milch', 'caldav', 'todo-1@test', ?)"
  ).run(listId, accountId);

  const rows = pendingShoppingCreations(listId);
  assert.deepEqual(rows.map((r) => r.id), [local.id],
    'Ein Spiegel ist kein Kandidat, und eine fremde Liste geht diesen Account nichts an');
});

test('Ein Upload macht den Einkaufsartikel zum Spiegel', async () => {
  const { processPendingShoppingCreations } = await import('../server/services/caldav-todo-outbound.js');
  const accountId = reset();
  const listId    = insertShoppingList();
  enableList(accountId, 'shopping', listId);
  const item   = insertLocalItem(listId);
  const client = fakeClient();

  const created = await processPendingShoppingCreations(client, accountId, shoppingTargets(listId), listsByUrl());

  assert.strictEqual(created, 1);
  assert.strictEqual(client.calls.created.length, 1);
  assert.match(client.calls.created[0].iCalString, /SUMMARY:Brot/);

  const row = reloadItem(item.id);
  assert.strictEqual(row.external_source, 'caldav');
  assert.strictEqual(row.external_uid, todoUidFor('shopping', item.id));
  assert.strictEqual(row.external_account_id, accountId);
  assert.strictEqual(row.external_object_url, `${LIST_URL}${todoUidFor('shopping', item.id)}.ics`);
});

test('Eine verschwundene Zielliste laesst den Artikel lokal', async () => {
  const { processPendingShoppingCreations } = await import('../server/services/caldav-todo-outbound.js');
  const accountId = reset();
  const listId    = insertShoppingList();
  enableList(accountId, 'shopping', listId);
  const item   = insertLocalItem(listId);
  const client = fakeClient();

  const created = await processPendingShoppingCreations(
    client, accountId, [{ listUrl: 'https://dav.example/dav/u/weg/', targetListId: listId }], listsByUrl()
  );

  assert.strictEqual(created, 0);
  assert.strictEqual(client.calls.created.length, 0);
  assert.strictEqual(reloadItem(item.id).external_source, 'local');
});

test('Ein gescheiterter Upload laesst den Artikel als Kandidaten stehen', async () => {
  const { processPendingShoppingCreations, pendingShoppingCreations } =
    await import('../server/services/caldav-todo-outbound.js');
  const accountId = reset();
  const listId    = insertShoppingList();
  enableList(accountId, 'shopping', listId);
  const item   = insertLocalItem(listId);
  const client = fakeClient({ onCreate: () => { throw new Error('507 Insufficient Storage'); } });

  const created = await processPendingShoppingCreations(client, accountId, shoppingTargets(listId), listsByUrl());

  assert.strictEqual(created, 0);
  assert.strictEqual(reloadItem(item.id).external_source, 'local');
  assert.strictEqual(pendingShoppingCreations(listId).length, 1,
    'Ein Upload hat keinen Stand, der veralten koennte - er laeuft im naechsten Lauf wieder mit');
});

test('Der Sync-Lauf laedt neue Einkaufsartikel hoch (#831)', async () => {
  const accountId = reset();
  const listId    = insertShoppingList();
  enableList(accountId, 'shopping', listId);
  const item   = insertLocalItem(listId);
  const client = fakeClient({ objects: [] });

  await sync({ createClient: async () => client });

  const row = reloadItem(item.id);
  assert.ok(row, 'Der Artikel hat den Lauf ueberlebt - der Prune darf den frischen Spiegel nicht gleich wieder raeumen');
  assert.strictEqual(row.external_source, 'caldav');
  assert.strictEqual(client.calls.created.length, 1);
});

test('Der Sofortversuch laedt neue Einkaufsartikel hoch', async () => {
  const accountId = reset();
  const listId    = insertShoppingList();
  enableList(accountId, 'shopping', listId);
  const item   = insertLocalItem(listId);
  const client = fakeClient();

  const result = await flushOutbound({ createClient: async () => client });

  assert.strictEqual(result.created, 1);
  assert.strictEqual(reloadItem(item.id).external_source, 'caldav');
});

test('Eine Liste, die auf Aufgaben zeigt, nimmt keine Einkaufsartikel an', async () => {
  // Spiegelbild des Riegels fuer Aufgaben: sonst kaeme der Artikel als Aufgabe
  // zurueck.
  const accountId = reset();
  const listId    = insertShoppingList();
  enableList(accountId, 'tasks', listId);
  const item   = insertLocalItem(listId);
  const client = fakeClient({ objects: [] });

  await sync({ createClient: async () => client });

  assert.strictEqual(client.calls.created.length, 0);
  assert.strictEqual(reloadItem(item.id).external_source, 'local');
});
