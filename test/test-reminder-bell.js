/**
 * Test: Die Glocke in den Listen von Kalender und Aufgaben
 *
 * Zweck: Ob ein Termin oder eine Aufgabe eine Erinnerung hat, stand bisher nur
 *        unten im Formular und als Glocken-Zeile in der Leseansicht. Die Listen
 *        tragen jetzt `has_reminder`, und Agenda, Tagesansicht, Aufgabenliste
 *        und Kanban zeichnen daraus eine Glocke.
 *
 *        Die Glocke heisst "das meldet sich bei dir" (#2687): an einer Serie
 *        steht sie nur an dem Vorkommen, zu dem die Erinnerung gehoert, an
 *        einer erledigten oder abgelegten Aufgabe gar nicht.
 *
 *        Deckt ab:
 *          - ownReminderIds() (server/services/reminder-flags.js): eigene,
 *            nicht verworfene Zeilen des einen Typs, eine Abfrage fuer viele IDs
 *          - ownEventReminderMarks(): ein einzelner Termin, sobald eine Zeile
 *            an ihm haengt; eine Serie nur am ersten Vorkommen, das bei oder
 *            nach der Erinnerung beginnt - auch wenn der Beginn der Serie kein
 *            Vorkommen ist (#960) und bei einem ganztaegigen Termin (09:00)
 *          - Aufgabenkarte und Kanban-Karte zeichnen die Glocke mit Namen,
 *            nicht an erledigten oder abgelegten Aufgaben, nicht ohne Zugang
 *            zu den Erinnerungen
 *
 *        Wo sonst gemessen wird: `has_reminder` an GET /tasks und GET /calendar
 *        (je Betrachter, Serien, verschoben und geloescht, erledigt) in
 *        test-reminders-routes.js, neben GET / und GET /all, deren Zeilen es
 *        liest; welche Kalenderansicht die Glocke zeigt und was die
 *        Leseansicht nennt in test-calendar.js.
 *
 * Ausfuehren: npm run test:reminder-bell
 */
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';

// /pages/tasks.js zieht Web Components mit, die zur Ladezeit von HTMLElement
// ableiten; fuer reine Render-Funktionen reichen Platzhalter (wie in
// test-kanban-columns.js).
globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
/** @type {Map<string, string>} */
const store = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    /** @param {string} k */ getItem: (k) => (store.has(k) ? store.get(k) : null),
    /** @param {string} k @param {string} v */ setItem: (k, v) => { store.set(k, String(v)); },
    /** @param {string} k */ removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
  },
});

const dbmod = await import('../server/db.js');
const { ownReminderIds, ownEventReminderMarks } = await import('../server/services/reminder-flags.js');
const { __test: tasksPage } = await import('../public/pages/tasks.js');
const { setPermissions, clearPermissions } = await import('../public/permissions.js');
const db = dbmod.get();

// ════════════════════════════════════════════════════════════════════════════
// Die Regel: eigene Zeile, nicht verworfen, der richtige Typ
// ════════════════════════════════════════════════════════════════════════════

/** @param {string} name @returns {number} */
function user(name) {
  return Number(db.prepare(
    "INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, 'x', 'member')",
  ).run(name, name).lastInsertRowid);
}

/** @param {string} title @param {number} owner @returns {number} */
function task(title, owner) {
  return Number(db.prepare(
    "INSERT INTO tasks (title, status, created_by, visibility) VALUES (?, 'open', ?, 'all')",
  ).run(title, owner).lastInsertRowid);
}

/** @param {string} type @param {number} id @param {number} owner @param {number} [dismissed] */
function remind(type, id, owner, dismissed = 0) {
  db.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, dismissed, created_by)
    VALUES (?, ?, '2035-03-10T07:45:00', ?, ?)
  `).run(type, id, dismissed, owner);
}

const ANNA = user('anna');
const BEN = user('ben');

test('ownReminderIds: eigene, nicht verworfene Erinnerungen - keine fremden, keine verworfenen', () => {
  const own = task('eigene', ANNA);
  const foreign = task('fremde', ANNA);
  const gone = task('verworfene', ANNA);
  const other = task('andere Art', ANNA);
  remind('task', own, ANNA);
  remind('task', foreign, BEN);
  remind('task', gone, ANNA, 1);
  // Eine Termin-Erinnerung mit derselben Zahl ist keine Aufgaben-Erinnerung.
  remind('event', other, ANNA);

  assert.deepEqual([...ownReminderIds(db, 'task', [own, foreign, gone, other, null, 'x'], ANNA)], [own]);
  assert.deepEqual([...ownReminderIds(db, 'task', [own, foreign], BEN)], [foreign]);
  assert.deepEqual([...ownReminderIds(db, 'event', [other], ANNA)], [other]);
  assert.deepEqual([...ownReminderIds(db, 'task', [String(own), own], ANNA)], [own], 'Text-IDs und Doppelte zaehlen einmal');
  assert.equal(ownReminderIds(db, 'task', [], ANNA).size, 0, 'leere Liste: leere Menge');
  assert.equal(ownReminderIds(db, 'task', [own], null).size, 0, 'ohne Betrachter: nichts');
});

test('ownReminderIds: viele IDs auf einmal (json_each, keine Platzhaltergrenze)', () => {
  const target = task('in der Masse', ANNA);
  remind('task', target, ANNA);
  const ids = Array.from({ length: 40000 }, (_, i) => i + 1_000_000);
  assert.deepEqual([...ownReminderIds(db, 'task', [...ids, target], ANNA)], [target]);
});

// ════════════════════════════════════════════════════════════════════════════
// Termine: an einer Serie nur das Vorkommen, zu dem die Erinnerung gehoert
// ════════════════════════════════════════════════════════════════════════════

db.prepare(`
  INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'UTC')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run();

/** @param {string} start @param {string | null} [rule] @returns {number} */
function event(start, rule = null) {
  return Number(db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, recurrence_rule, created_by)
    VALUES ('Termin', ?, ?, ?, ?, ?)
  `).run(start, start, start.includes('T') ? 0 : 1, rule, ANNA).lastInsertRowid);
}

/** @param {number} id @param {string} at */
function remindAt(id, at) {
  db.prepare("INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('event', ?, ?, ?)").run(id, at, ANNA);
}

test('ownEventReminderMarks: ein einzelner Termin, sobald eine eigene Zeile an ihm haengt', () => {
  const dentist = event('2035-04-02T14:00:00');
  const quiet = event('2035-04-03T14:00:00');
  remindAt(dentist, '2035-04-02T13:45:00');
  const marks = ownEventReminderMarks(db, [dentist, quiet, null], ANNA);
  assert.equal(marks.has(dentist), true);
  assert.equal(marks.has(dentist, null), true);
  assert.equal(marks.has(quiet), false);
  assert.equal(ownEventReminderMarks(db, [dentist], BEN).has(dentist), false, 'Annas Erinnerung meldet sich nicht bei Ben');
  assert.equal(ownEventReminderMarks(db, [dentist], null).has(dentist), false, 'ohne Betrachter: nichts');
  assert.equal(ownEventReminderMarks(db, [], ANNA).has(dentist), false, 'nicht gefragt: nichts');
});

test('ownEventReminderMarks: eine Serie nur am ersten Vorkommen, das bei oder nach der Erinnerung beginnt', () => {
  const piano = event('2035-05-07T16:00:00', 'FREQ=WEEKLY');
  // 15 Minuten vor dem Beginn der Serie (#2468): das erste Vorkommen.
  remindAt(piano, '2035-05-07T15:45:00');
  let marks = ownEventReminderMarks(db, [piano], ANNA);
  assert.equal(marks.has(piano, '2035-05-07T16:00:00'), true);
  assert.equal(marks.has(piano, '2035-05-07'), true, 'die alte Tagesform desselben Vorkommens (#2034)');
  assert.equal(marks.has(piano, '2035-05-14T16:00:00'), false, 'das zweite bleibt still');
  assert.equal(marks.has(piano), false, 'ohne Schluessel ist kein Vorkommen gemeint');

  // Eine Zeile nach dem Beginn des ersten Vorkommens gehoert zu dem, vor dem
  // sie liegt - auch genau zum Beginn, und Jahre nach dem Start der Serie.
  remindAt(piano, '2035-05-21T16:00:00');
  remindAt(piano, '2041-03-10T08:00:00');
  marks = ownEventReminderMarks(db, [piano], ANNA);
  assert.equal(marks.has(piano, '2035-05-07T16:00:00'), true);
  assert.equal(marks.has(piano, '2035-05-14T16:00:00'), false);
  assert.equal(marks.has(piano, '2035-05-21T16:00:00'), true, 'zum Beginn ist nicht danach');
  assert.equal(marks.has(piano, '2035-05-28T16:00:00'), false);
  assert.equal(marks.has(piano, '2041-03-11T16:00:00'), true, 'der Montag nach dem 10.03.2041');
  assert.equal(marks.has(piano, '2041-03-04T16:00:00'), false);
});

test('ownEventReminderMarks: das erste Vorkommen ist das erste der Regel, nicht der Beginn (#960)', () => {
  // Beginn am 15., Regel "am Monatsletzten": das erste Vorkommen ist der 31.
  const rent = event('2035-05-15T09:00:00', 'FREQ=MONTHLY;BYMONTHDAY=-1');
  remindAt(rent, '2035-05-14T09:00:00');
  const marks = ownEventReminderMarks(db, [rent], ANNA);
  assert.equal(marks.has(rent, '2035-05-31T09:00:00'), true);
  assert.equal(marks.has(rent, '2035-05-15T09:00:00'), false, 'am 15. findet nichts statt');
  assert.equal(marks.has(rent, '2035-06-30T09:00:00'), false);
});

test('ownEventReminderMarks: ein ganztaegiger Serientermin beginnt um 09:00, wie beim Rechnen der Vorlaeufe', () => {
  const bins = event('2035-05-07', 'FREQ=WEEKLY');
  // 08:00 am zweiten Montag liegt vor dessen 09:00, 10:00 schon danach.
  remindAt(bins, '2035-05-14T08:00:00');
  assert.equal(ownEventReminderMarks(db, [bins], ANNA).has(bins, '2035-05-14'), true);
  db.prepare("UPDATE reminders SET remind_at = '2035-05-14T10:00:00' WHERE entity_type = 'event' AND entity_id = ?").run(bins);
  const marks = ownEventReminderMarks(db, [bins], ANNA);
  assert.equal(marks.has(bins, '2035-05-14'), false);
  assert.equal(marks.has(bins, '2035-05-21'), true);
});

test('ownEventReminderMarks: eine Serie, die sich nicht ausrollen laesst, bleibt ohne Glocke und nimmt die Liste nicht mit', () => {
  const broken = event('kein Datum', 'FREQ=WEEKLY');
  const fine = event('2035-06-04T10:00:00');
  remindAt(broken, '2035-06-01T10:00:00');
  remindAt(fine, '2035-06-04T09:00:00');
  const marks = ownEventReminderMarks(db, [broken, fine], ANNA);
  assert.equal(marks.has(broken, '2035-06-04T10:00:00'), false);
  assert.equal(marks.has(fine), true);
});

// ════════════════════════════════════════════════════════════════════════════
// Die Karten der Aufgaben
// ════════════════════════════════════════════════════════════════════════════

/** @param {Record<string, unknown>} [over] */
const CARD = (over = {}) => ({
  id: 77, title: 'Muell rausbringen', status: 'open', priority: 'none', category: 'household',
  visibility: 'all', subtasks: [], subtask_total: 0, assigned_users: [], tags: [], ...over,
});
const BELL = /<span class="due-date task-card__reminder" role="img" aria-label="reminders\.sectionTitle"><i data-lucide="bell"/;
const ANY_BELL = /data-lucide="bell"/;

test('Aufgabenkarte und Kanban: Glocke mit Namen, wenn eine Erinnerung gesetzt ist', () => {
  clearPermissions();
  assert.match(tasksPage.renderTaskCard(CARD({ has_reminder: true })), BELL);
  assert.match(tasksPage.renderKanbanCard(CARD({ has_reminder: true })), BELL);
  for (const quiet of [CARD(), CARD({ has_reminder: false }), CARD({ has_reminder: 1 })]) {
    assert.doesNotMatch(tasksPage.renderTaskCard(quiet), ANY_BELL);
    assert.doesNotMatch(tasksPage.renderKanbanCard(quiet), ANY_BELL);
  }
});

test('Aufgabenkarte und Kanban: keine Glocke an erledigten und abgelegten Aufgaben (#2687)', () => {
  // Der Server laesst `has_reminder` dort schon weg. Die Karte fragt selbst
  // noch einmal, damit sie nicht vom Alter ihres Zustands abhaengt.
  clearPermissions();
  const done = CARD({ has_reminder: true, status: 'done' });
  const archived = CARD({ has_reminder: true, archived_at: '2035-03-01T10:00:00Z' });
  for (const card of [done, archived]) {
    assert.doesNotMatch(tasksPage.renderTaskCard(card), ANY_BELL);
    assert.doesNotMatch(tasksPage.renderKanbanCard(card), ANY_BELL);
  }
  assert.match(tasksPage.renderTaskCard(CARD({ has_reminder: true, status: 'in_progress' })), BELL, 'in Arbeit ist nicht erledigt');
});

test('Aufgabenkarte und Kanban: keine Glocke ohne Zugang zu den Erinnerungen', () => {
  setPermissions({ admin: false, modules: { calendar: 'none' }, widgets: {}, capabilities: {} });
  try {
    assert.doesNotMatch(tasksPage.renderTaskCard(CARD({ has_reminder: true })), ANY_BELL);
    assert.doesNotMatch(tasksPage.renderKanbanCard(CARD({ has_reminder: true })), ANY_BELL);
  } finally {
    clearPermissions();
  }
  // Nur lesend reicht: die Leseansicht zeigt die Erinnerung dann auch.
  setPermissions({ admin: false, modules: { calendar: 'read' }, widgets: {}, capabilities: {} });
  try {
    assert.match(tasksPage.renderTaskCard(CARD({ has_reminder: true })), BELL);
  } finally {
    clearPermissions();
  }
});
