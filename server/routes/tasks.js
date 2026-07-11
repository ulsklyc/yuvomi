/**
 * Modul: Aufgaben (Tasks)
 * Zweck: REST-API-Routen für Aufgaben und Teilaufgaben (max. 2 Ebenen)
 * Abhängigkeiten: express, server/db.js
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { nextOccurrenceAfter } from '../services/recurrence.js';
import { syncTaskRewards } from '../services/rewards.js';
import { normalizeVisibility, visibilityWhere } from '../services/visibility.js';
import * as v from '../middleware/validate.js';

const log = createLogger('Tasks');

const router = express.Router();

// --------------------------------------------------------
// Konstanten
// --------------------------------------------------------

const VALID_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];
const VALID_STATUSES   = ['open', 'in_progress', 'done', 'archived'];
const VALID_CATEGORIES = ['household', 'school', 'shopping', 'repair',
                          'health', 'finance', 'leisure', 'misc'];
const MAX_POINTS = 10000;

/** Punktewert einer Aufgabe auf eine nichtnegative Ganzzahl normalisieren. */
function clampPoints(val) {
  const n = Math.trunc(Number(val));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_POINTS);
}

// --------------------------------------------------------
// Hilfsfunktionen
// --------------------------------------------------------

const ASSIGNED_USERS_SQL = `(
  SELECT json_group_array(json_object(
    'id', u.id, 'display_name', u.display_name, 'color', u.avatar_color,
    'avatar_data', u.avatar_data
  ))
  FROM task_assignments ta JOIN users u ON u.id = ta.user_id
  WHERE ta.task_id = t.id
) AS assigned_users_json`;

function addAssignedUsers(task) {
  task.assigned_users = task.assigned_users_json ? JSON.parse(task.assigned_users_json) : [];
  delete task.assigned_users_json;
  return task;
}

function parseAssignedTo(val) {
  if (Array.isArray(val)) return val.map(Number).filter(Boolean);
  if (val !== null && val !== undefined && val !== '') return [Number(val)].filter(Boolean);
  return [];
}

function setAssignments(d, taskId, userIds) {
  d.prepare('DELETE FROM task_assignments WHERE task_id = ?').run(taskId);
  const ins = d.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)');
  for (const uid of userIds) ins.run(taskId, uid);
}

function syncHousekeepingPaymentStatus(d, taskId, status) {
  const table = d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'housekeeping_work_sessions'").get();
  if (!table) return;
  d.prepare(`
    UPDATE housekeeping_work_sessions
    SET paid_at = CASE
      WHEN ? = 'done' THEN COALESCE(paid_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      ELSE NULL
    END
    WHERE payment_task_id = ?
  `).run(status, taskId);
}

/** Alle Subtasks einer Aufgabe laden (eine Ebene tief). */
function loadSubtasks(taskId) {
  return db.get().prepare(`
    SELECT t.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color,
      u.avatar_data AS assigned_avatar, ${ASSIGNED_USERS_SQL}
    FROM tasks t
    LEFT JOIN users u ON t.assigned_to = u.id
    WHERE t.parent_task_id = ?
    ORDER BY t.created_at ASC
  `).all(taskId).map(addAssignedUsers);
}

/** Fortschritt der Subtasks berechnen (erledigte / gesamt). */
function subtaskProgress(taskId) {
  const row = db.get().prepare(`
    SELECT
      COUNT(*)                          AS total,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
    FROM tasks
    WHERE parent_task_id = ?
  `).get(taskId);
  return { total: row.total ?? 0, done: row.done ?? 0 };
}

/** Eingabe-Validierung für Task-Felder (zentralisiert über validate.js). */
function validateTaskInput(body, isCreate = true) {
  return v.collectErrors([
    v.str(body.title,       'title',       { required: isCreate }),
    v.str(body.description, 'description', { required: false, max: v.MAX_TEXT }),
    v.oneOf(body.priority,  VALID_PRIORITIES, 'priority'),
    v.oneOf(body.status,    VALID_STATUSES,   'status'),
    v.oneOf(body.category,  VALID_CATEGORIES, 'category'),
    v.date(body.start_date, 'start_date'),
    v.date(body.due_date,   'due_date'),
    v.time(body.due_time,   'due_time'),
    v.rrule(body.recurrence_rule, 'recurrence_rule'),
    v.num(body.points,      'points'),
  ]);
}

// --------------------------------------------------------
// GET /api/v1/tasks
// Listet Top-Level-Aufgaben mit optionalen Filtern.
// Query-Parameter: status, priority, assigned_to, category
// Response: { data: Task[] }  (jede Task enthält subtask_progress)
// --------------------------------------------------------
router.get('/', (req, res) => {
  try {
    const { status, priority, assigned_to, category, include_future } = req.query;

    let sql = `
      SELECT
        t.*,
        u.display_name AS assigned_name,
        u.avatar_color AS assigned_color,
        u.avatar_data AS assigned_avatar,
        ${ASSIGNED_USERS_SQL},
        (SELECT COUNT(*) FROM tasks s WHERE s.parent_task_id = t.id)                           AS subtask_total,
        (SELECT COUNT(*) FROM tasks s WHERE s.parent_task_id = t.id AND s.status = 'done')     AS subtask_done
      FROM tasks t
      LEFT JOIN users u ON t.assigned_to = u.id
      WHERE t.parent_task_id IS NULL
    `;
    const params = [];

    if (!include_future) {
      sql += ` AND (t.start_date IS NULL OR t.start_date <= date('now'))`;
    }

    if (status)      { sql += ' AND t.status = ?';      params.push(status); }
    if (priority)    { sql += ' AND t.priority = ?';    params.push(priority); }
    if (assigned_to) {
      sql += ' AND EXISTS (SELECT 1 FROM task_assignments ta WHERE ta.task_id = t.id AND ta.user_id = ?)';
      params.push(Number(assigned_to));
    }
    if (category)    { sql += ' AND t.category = ?';    params.push(category); }

    // Sichtbarkeit (#474): eigene + für alle sichtbare + zugewiesene-sichtbare.
    const me = req.authUserId || req.session.userId;
    sql += ` AND ${visibilityWhere('t', 'task_assignments', 'task_id')}`;
    params.push(me, me);

    sql += `
      ORDER BY
        CASE t.status WHEN 'done' THEN 1 ELSE 0 END,
        CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                        WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
        t.due_date ASC NULLS LAST,
        t.created_at DESC
    `;

    res.json({ data: db.get().prepare(sql).all(...params).map(addAssignedUsers) });
  } catch (err) {
    log.error('GET / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/tasks/:id
// Einzelne Aufgabe mit Subtasks.
// Response: { data: Task & { subtasks: Task[] } }
// --------------------------------------------------------
router.get('/:id', (req, res) => {
  try {
    const me = req.authUserId || req.session.userId;
    const task = db.get().prepare(`
      SELECT t.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color,
        u.avatar_data AS assigned_avatar, ${ASSIGNED_USERS_SQL}
      FROM tasks t
      LEFT JOIN users u ON t.assigned_to = u.id
      WHERE t.id = ? AND t.parent_task_id IS NULL
        AND ${visibilityWhere('t', 'task_assignments', 'task_id')}
    `).get(req.params.id, me, me);

    if (!task) return res.status(404).json({ error: 'Task not found.', code: 404 });

    addAssignedUsers(task);
    task.subtasks = loadSubtasks(task.id);
    res.json({ data: task });
  } catch (err) {
    log.error('GET /:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/tasks
// Neue Aufgabe erstellen.
// Body: { title, description?, category?, priority?, due_date?, due_time?,
//         assigned_to?, parent_task_id? }
// Response: { data: Task }
// --------------------------------------------------------
router.post('/', (req, res) => {
  try {
    const errors = validateTaskInput(req.body, true);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const {
      title,
      description     = null,
      category        = 'Sonstiges',
      priority        = 'none',
      start_date      = null,
      due_date        = null,
      due_time        = null,
      parent_task_id  = null,
      is_recurring    = 0,
      recurrence_rule = null,
    } = req.body;
    const points = clampPoints(req.body.points);
    const visibility = normalizeVisibility(req.body.visibility);

    const userIds  = parseAssignedTo(req.body.assigned_to);
    const firstUid = userIds[0] ?? null;

    // Tiefe begrenzen: Subtasks dürfen keine eigenen Subtasks haben (max. 2 Ebenen)
    if (parent_task_id) {
      const parent = db.get().prepare('SELECT parent_task_id FROM tasks WHERE id = ?')
        .get(parent_task_id);
      if (!parent) return res.status(404).json({ error: 'Parent task not found.', code: 404 });
      if (parent.parent_task_id)
        return res.status(400).json({ error: 'Maximal 2 Verschachtelungsebenen erlaubt.', code: 400 });
    }

    const taskId = db.get().transaction(() => {
      const result = db.get().prepare(`
        INSERT INTO tasks
          (title, description, category, priority, start_date, due_date, due_time,
           assigned_to, created_by, parent_task_id, is_recurring, recurrence_rule, points, visibility)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        title.trim(), description, category, priority,
        start_date, due_date, due_time, firstUid, req.authUserId || req.session.userId, parent_task_id,
        is_recurring ? 1 : 0, recurrence_rule, points, visibility
      );
      setAssignments(db.get(), result.lastInsertRowid, userIds);
      return result.lastInsertRowid;
    })();

    const task = db.get().prepare(`
      SELECT t.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color,
        u.avatar_data AS assigned_avatar, ${ASSIGNED_USERS_SQL}
      FROM tasks t LEFT JOIN users u ON t.assigned_to = u.id
      WHERE t.id = ?
    `).get(taskId);

    res.status(201).json({ data: addAssignedUsers(task) });
  } catch (err) {
    log.error('POST / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PUT /api/v1/tasks/:id
// Aufgabe vollständig aktualisieren.
// Body: { title, description?, category?, priority?, status?,
//         due_date?, due_time?, assigned_to? }
// Response: { data: Task }
// --------------------------------------------------------
router.put('/:id', (req, res) => {
  try {
    const task = db.get().prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found.', code: 404 });

    const errors = validateTaskInput(req.body, false);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const {
      title           = task.title,
      description     = task.description,
      category        = task.category,
      priority        = task.priority,
      status          = task.status,
      start_date      = task.start_date,
      due_date        = task.due_date,
      due_time        = task.due_time,
      is_recurring    = task.is_recurring,
      recurrence_rule = task.recurrence_rule,
    } = req.body;
    const points = req.body.points !== undefined ? clampPoints(req.body.points) : task.points;
    const visibility = req.body.visibility !== undefined
      ? normalizeVisibility(req.body.visibility, task.visibility)
      : task.visibility;

    const userIds  = req.body.assigned_to !== undefined
      ? parseAssignedTo(req.body.assigned_to)
      : db.get().prepare('SELECT user_id FROM task_assignments WHERE task_id = ?')
          .all(task.id).map((r) => r.user_id);
    const firstUid = userIds[0] ?? null;

    db.get().transaction(() => {
      db.get().prepare(`
        UPDATE tasks SET
          title = ?, description = ?, category = ?, priority = ?,
          status = ?, start_date = ?, due_date = ?, due_time = ?, assigned_to = ?,
          is_recurring = ?, recurrence_rule = ?, points = ?, visibility = ?
        WHERE id = ?
      `).run(title.trim(), description, category, priority,
             status, start_date, due_date, due_time, firstUid,
             is_recurring ? 1 : 0, recurrence_rule, points, visibility, req.params.id);
      setAssignments(db.get(), task.id, userIds);
      syncHousekeepingPaymentStatus(db.get(), req.params.id, status);
      // Punkte erst nach setAssignments: die Zuständigen werden daraus abgeleitet.
      syncTaskRewards(db.get(), task.id, task.status, status, req.authUserId || req.session.userId);
    })();

    const updated = db.get().prepare(`
      SELECT t.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color,
        u.avatar_data AS assigned_avatar, ${ASSIGNED_USERS_SQL}
      FROM tasks t LEFT JOIN users u ON t.assigned_to = u.id
      WHERE t.id = ?
    `).get(req.params.id);
    addAssignedUsers(updated);
    updated.subtasks = loadSubtasks(updated.id);

    res.json({ data: updated });
  } catch (err) {
    log.error('PUT /:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PATCH /api/v1/tasks/:id/status
// Status einer Aufgabe schnell wechseln (z.B. Swipe-Geste / Checkbox).
// Body: { status: 'open' | 'in_progress' | 'done' }
// Response: { data: { id, status } }
// --------------------------------------------------------
router.patch('/:id/status', (req, res) => {
  try {
    const { status } = req.body;
    if (!VALID_STATUSES.includes(status))
      return res.status(400).json({ error: `Invalid status. Allowed: ${VALID_STATUSES.join(', ')}`, code: 400 });

    const prev = db.get().prepare('SELECT status FROM tasks WHERE id = ?').get(req.params.id);
    if (!prev)
      return res.status(404).json({ error: 'Task not found.', code: 404 });

    db.get().prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, req.params.id);

    syncHousekeepingPaymentStatus(db.get(), req.params.id, status);
    // Punkte-Gutschrift/Storno an den Aufgaben-Statuswechsel koppeln.
    syncTaskRewards(db.get(), Number(req.params.id), prev.status, status, req.authUserId || req.session.userId);

    // Wiederkehrende Aufgabe: nächste Instanz erstellen wenn erledigt
    if (status === 'done') {
      const task = db.get().prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
      if (task?.is_recurring && task.recurrence_rule && !task.parent_task_id) {
        // Überfällige Serien aufholen: nächste Instanz liegt immer in der Zukunft,
        // statt blind altes Fälligkeitsdatum + Intervall (das selbst überfällig sein kann).
        // Schwelle "heute" in UTC, konsistent zur Listen-Filterung mit SQL date('now').
        const today = new Date().toISOString().slice(0, 10);
        const nextDate = nextOccurrenceAfter(task.due_date, task.recurrence_rule, today);
        if (nextDate) {
          const existingAssignments = db.get()
            .prepare('SELECT user_id FROM task_assignments WHERE task_id = ?')
            .all(task.id).map((r) => r.user_id);
          db.get().transaction(() => {
            const newTask = db.get().prepare(`
              INSERT INTO tasks (title, description, category, priority, status,
                due_date, due_time, assigned_to, created_by, is_recurring, recurrence_rule, points, visibility)
              VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, 1, ?, ?, ?)
            `).run(
              task.title, task.description, task.category, task.priority,
              nextDate, task.due_time, task.assigned_to, task.created_by,
              task.recurrence_rule, task.points, task.visibility
            );
            setAssignments(db.get(), newTask.lastInsertRowid, existingAssignments);
          })();
        }
      }
    }

    res.json({ data: { id: Number(req.params.id), status } });
  } catch (err) {
    log.error('PATCH /:id/status error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/tasks/:id
// Aufgabe löschen (Subtasks werden per CASCADE mitgelöscht).
// Response: { ok: true }
// --------------------------------------------------------
router.delete('/:id', (req, res) => {
  try {
    const result = db.get().prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
    if (result.changes === 0)
      return res.status(404).json({ error: 'Task not found.', code: 404 });
    res.json({ ok: true });
  } catch (err) {
    log.error('DELETE /:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/tasks/meta/options
// Liefert Filteroptionen: alle User + gültige Werte für Dropdowns.
// Response: { users, priorities, statuses, categories }
// --------------------------------------------------------
router.get('/meta/options', (req, res) => {
  try {
    const users = db.get().prepare(
      `SELECT id, display_name, avatar_color FROM users u
       WHERE NOT EXISTS (SELECT 1 FROM housekeeping_workers hw WHERE hw.user_id = u.id)
       ORDER BY display_name`
    ).all();
    res.json({ users, priorities: VALID_PRIORITIES, statuses: VALID_STATUSES, categories: VALID_CATEGORIES });
  } catch (err) {
    log.error('GET /meta/options error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
