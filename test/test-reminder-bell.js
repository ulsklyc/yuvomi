/**
 * Test: Die Glocke in den Listen von Kalender und Aufgaben
 *
 * Zweck: Ob ein Termin oder eine Aufgabe eine Erinnerung hat, stand bisher nur
 *        unten im Formular und als Glocken-Zeile in der Leseansicht. Die Listen
 *        tragen jetzt `has_reminder`, und Agenda, Tagesansicht, Aufgabenliste
 *        und Kanban zeichnen daraus eine Glocke.
 *
 *        Deckt ab:
 *          - ownReminderIds() (server/services/reminder-flags.js): eigene,
 *            nicht verworfene Zeilen des einen Typs, eine Abfrage fuer viele IDs
 *          - Aufgabenkarte und Kanban-Karte zeichnen die Glocke mit Namen, auch
 *            an erledigten Aufgaben (wie die Leseansicht), nicht ohne Zugang zu
 *            den Erinnerungen
 *
 *        Wo sonst gemessen wird: `has_reminder` an GET /tasks und GET /calendar
 *        (je Betrachter, Serien) in test-reminders-routes.js, neben GET / und
 *        GET /all, deren Regel es teilt; welche Kalenderansicht die Glocke
 *        zeigt in test-calendar.js, an den fuenf Bausteinen der Icon-Regel.
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
const { ownReminderIds } = await import('../server/services/reminder-flags.js');
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

test('Aufgabenkarte und Kanban: die Glocke bleibt an erledigten und abgelegten Aufgaben - wie in der Leseansicht', () => {
  // In-App-Meldung und Push stellen die Erinnerung einer erledigten Aufgabe
  // weiter zu; nur `/upcoming` laesst sie aus. Die Liste verschweigt sie nicht.
  clearPermissions();
  const done = CARD({ has_reminder: true, status: 'done' });
  const archived = CARD({ has_reminder: true, archived_at: '2035-03-01T10:00:00Z' });
  for (const card of [done, archived]) {
    assert.match(tasksPage.renderTaskCard(card), BELL);
    assert.match(tasksPage.renderKanbanCard(card), BELL);
  }
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
