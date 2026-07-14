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
import { uniqueKey } from '../utils/category-slug.js';
import * as v from '../middleware/validate.js';

const log = createLogger('Tasks');

const router = express.Router();

// --------------------------------------------------------
// Konstanten
// --------------------------------------------------------

const VALID_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];
const VALID_STATUSES   = ['open', 'in_progress', 'done', 'archived'];
const MAX_POINTS = 10000;
const FALLBACK_CATEGORY = 'misc';

/** Verwaltbare Kategorien aus der DB (nach sort_order). */
function loadTaskCategories() {
  return db.get().prepare(
    'SELECT key, name, label_key, sort_order FROM task_categories ORDER BY sort_order ASC, key ASC'
  ).all();
}

/** Nur die Keys — für die dynamische category-Validierung. */
function validTaskCategoryKeys() {
  return loadTaskCategories().map((c) => c.key);
}

/** Anzahl Aufgaben, die eine Kategorie referenzieren (Guard vor dem Löschen). */
function taskCategoryInUseCount(key) {
  return db.get().prepare('SELECT COUNT(*) AS n FROM tasks WHERE category = ?').get(key).n;
}

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

/**
 * Hängt jedem Task die Anzahl der für die Person sichtbaren, verknüpften
 * Dokumente an (document_count, #503). Eine einzige gruppierte Abfrage statt
 * pro-Task, damit die Listen-Route günstig bleibt.
 */
function attachDocumentCounts(tasks, me) {
  if (!tasks.length) return tasks;
  const counts = db.get().prepare(`
    SELECT td.task_id AS id, COUNT(*) AS n
    FROM task_documents td
    JOIN family_documents d ON d.id = td.document_id
    WHERE d.status != 'archived' AND ${DOC_VISIBLE_SQL}
    GROUP BY td.task_id
  `).all({ me });
  const map = new Map(counts.map((r) => [r.id, r.n]));
  for (const task of tasks) task.document_count = map.get(task.id) ?? 0;
  return tasks;
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
    v.oneOf(body.category,  validTaskCategoryKeys(), 'category'),
    v.date(body.start_date, 'start_date'),
    v.date(body.due_date,   'due_date'),
    v.time(body.due_time,   'due_time'),
    v.rrule(body.recurrence_rule, 'recurrence_rule'),
    v.num(body.points,      'points'),
  ]);
}

// --------------------------------------------------------
// Kategorie-Verwaltung (#494, #357)
// Statische /categories-Pfade MÜSSEN vor den dynamischen /:id-Routen stehen,
// sonst matcht Express „categories" als :id.
// --------------------------------------------------------

// GET /api/v1/tasks/categories → { data: TaskCategory[] }
router.get('/categories', (_req, res) => {
  try {
    res.json({ data: loadTaskCategories() });
  } catch (err) {
    log.error('GET /categories error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// POST /api/v1/tasks/categories  Body: { name } → { data: TaskCategory }
router.post('/categories', (req, res) => {
  try {
    const vName = v.str(req.body.name, 'Name', { max: v.MAX_SHORT });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const conflict = db.get().prepare(`
      SELECT key FROM task_categories WHERE COALESCE(name, key) = ? COLLATE NOCASE
    `).get(vName.value);
    if (conflict) return res.status(409).json({ error: 'Category already exists.', code: 409, reason: 'category_exists' });

    const maxOrder = db.get().prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM task_categories').get().m;
    const key = uniqueKey(db.get(), 'task_categories', vName.value);
    db.get().prepare(
      'INSERT INTO task_categories (key, name, label_key, sort_order) VALUES (?, ?, NULL, ?)'
    ).run(key, vName.value, maxOrder + 1);

    const cat = db.get().prepare('SELECT key, name, label_key, sort_order FROM task_categories WHERE key = ?').get(key);
    res.status(201).json({ data: cat });
  } catch (err) {
    log.error('POST /categories error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// PATCH /api/v1/tasks/categories/reorder  Body: { order: string[] }
router.patch('/categories/reorder', (req, res) => {
  try {
    const order = Array.isArray(req.body.order) ? req.body.order : [];
    const update = db.get().prepare('UPDATE task_categories SET sort_order = ? WHERE key = ?');
    db.get().transaction(() => order.forEach((key, i) => update.run(i, key)))();
    res.json({ data: loadTaskCategories() });
  } catch (err) {
    log.error('PATCH /categories/reorder error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// PUT /api/v1/tasks/categories/:key  Body: { name } → benennt um (Key bleibt stabil,
// label_key wird gelöscht → der Custom-Name gilt fortan).
router.put('/categories/:key', (req, res) => {
  try {
    const cat = db.get().prepare('SELECT * FROM task_categories WHERE key = ?').get(req.params.key);
    if (!cat) return res.status(404).json({ error: 'Category not found.', code: 404 });

    const vName = v.str(req.body.name, 'Name', { max: v.MAX_SHORT });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const conflict = db.get().prepare(`
      SELECT key FROM task_categories WHERE COALESCE(name, key) = ? COLLATE NOCASE AND key != ?
    `).get(vName.value, cat.key);
    if (conflict) return res.status(409).json({ error: 'Category already exists.', code: 409, reason: 'category_exists' });

    db.get().prepare('UPDATE task_categories SET name = ?, label_key = NULL WHERE key = ?').run(vName.value, cat.key);
    const updated = db.get().prepare('SELECT key, name, label_key, sort_order FROM task_categories WHERE key = ?').get(cat.key);
    res.json({ data: updated });
  } catch (err) {
    log.error('PUT /categories/:key error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// DELETE /api/v1/tasks/categories/:key → 409 wenn in Benutzung oder letzte Kategorie.
router.delete('/categories/:key', (req, res) => {
  try {
    const cat = db.get().prepare('SELECT * FROM task_categories WHERE key = ?').get(req.params.key);
    if (!cat) return res.status(404).json({ error: 'Category not found.', code: 404 });

    const inUse = taskCategoryInUseCount(cat.key);
    if (inUse > 0) {
      return res.status(409).json({ error: `Category is in use by ${inUse} task${inUse === 1 ? '' : 's'}.`, code: 409, count: inUse, reason: 'category_in_use' });
    }
    const total = db.get().prepare('SELECT COUNT(*) AS n FROM task_categories').get().n;
    if (total <= 1) return res.status(409).json({ error: 'Cannot delete the last category.', code: 409, reason: 'category_last' });

    db.get().prepare('DELETE FROM task_categories WHERE key = ?').run(cat.key);
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /categories/:key error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

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

    const rows = db.get().prepare(sql).all(...params).map(addAssignedUsers);
    res.json({ data: attachDocumentCounts(rows, me) });
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
    attachDocumentCounts([task], me);
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
      category        = FALLBACK_CATEGORY,
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
// Verknüpfte Dokumente (#503)
// Dokumente aus dem Dokumente-Modul können optional mit einer Aufgabe
// verbunden werden. Die Sichtbarkeit spiegelt documents.js: sichtbar ist ein
// Dokument nur für Ersteller:in, bei visibility='family' oder über einen
// expliziten Freigabe-Eintrag (family_document_access).
// --------------------------------------------------------

// Sichtbarkeits-Fragment für ein Dokument (Alias `d`, benannter Bind @me).
const DOC_VISIBLE_SQL = `(
  d.created_by = @me
  OR d.visibility = 'family'
  OR EXISTS (SELECT 1 FROM family_document_access a WHERE a.document_id = d.id AND a.user_id = @me)
)`;

/** Aufgabe nur zurückgeben, wenn sie für die betrachtende Person sichtbar ist. */
function findVisibleTask(id, me) {
  return db.get().prepare(`
    SELECT t.id FROM tasks t
    WHERE t.id = ? AND ${visibilityWhere('t', 'task_assignments', 'task_id')}
  `).get(id, me, me);
}

/** Für die Person sichtbare, mit der Aufgabe verknüpfte Dokumente. */
function loadTaskDocuments(taskId, me) {
  return db.get().prepare(`
    SELECT d.id, d.name, d.category, d.original_name, d.mime_type, d.file_size,
           d.storage_backend, td.created_at AS linked_at
    FROM task_documents td
    JOIN family_documents d ON d.id = td.document_id
    WHERE td.task_id = @taskId AND d.status != 'archived' AND ${DOC_VISIBLE_SQL}
    ORDER BY d.name COLLATE NOCASE ASC
  `).all({ taskId, me });
}

// GET /api/v1/tasks/:id/documents → { data: LinkedDocument[] }
router.get('/:id/documents', (req, res) => {
  try {
    const me = req.authUserId || req.session.userId;
    const task = findVisibleTask(req.params.id, me);
    if (!task) return res.status(404).json({ error: 'Task not found.', code: 404 });
    res.json({ data: loadTaskDocuments(task.id, me) });
  } catch (err) {
    log.error('GET /:id/documents error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// PUT /api/v1/tasks/:id/documents  Body: { document_ids: number[] }
// Replace-Set: setzt die Verknüpfungen neu. Es werden nur für die Person
// sichtbare Dokumente verknüpft; ebenso werden nur sichtbare Alt-Verknüpfungen
// ersetzt — unsichtbare (z.B. private Dokumente anderer) bleiben unberührt.
router.put('/:id/documents', (req, res) => {
  try {
    const me = req.authUserId || req.session.userId;
    const task = findVisibleTask(req.params.id, me);
    if (!task) return res.status(404).json({ error: 'Task not found.', code: 404 });

    const requested = Array.isArray(req.body.document_ids)
      ? [...new Set(req.body.document_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
      : [];

    const canSee = db.get().prepare(`SELECT 1 FROM family_documents d WHERE d.id = @id AND ${DOC_VISIBLE_SQL}`);
    const visibleIds = requested.filter((id) => canSee.get({ id, me }));

    db.get().transaction(() => {
      // Nur die für diese Person sichtbaren Alt-Verknüpfungen entfernen.
      db.get().prepare(`
        DELETE FROM task_documents
        WHERE task_id = @taskId AND document_id IN (
          SELECT d.id FROM family_documents d WHERE ${DOC_VISIBLE_SQL}
        )
      `).run({ taskId: task.id, me });
      const ins = db.get().prepare(
        'INSERT OR IGNORE INTO task_documents (task_id, document_id, created_by) VALUES (?, ?, ?)'
      );
      for (const id of visibleIds) ins.run(task.id, id, me);
    })();

    res.json({ data: loadTaskDocuments(task.id, me) });
  } catch (err) {
    log.error('PUT /:id/documents error:', err);
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
    res.json({ users, priorities: VALID_PRIORITIES, statuses: VALID_STATUSES, categories: loadTaskCategories() });
  } catch (err) {
    log.error('GET /meta/options error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
