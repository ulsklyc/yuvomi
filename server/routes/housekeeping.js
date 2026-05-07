/**
 * Modul: Housekeeping
 * Zweck: REST-API fuer Ponto/Financeiro, tarefas dinamicas, insumos e ocorrencias
 * Abhängigkeiten: express, server/db.js
 */

import express from 'express';
import { createLogger } from '../logger.js';
import * as db from '../db.js';
import { collectErrors, datetime, month, num, str, id as validateId, MAX_SHORT, MAX_TEXT, MAX_TITLE } from '../middleware/validate.js';

const log = createLogger('Housekeeping');
const router = express.Router();

const MAX_PHOTO_DATA_LENGTH = 6 * 1024 * 1024;
const IMAGE_DATA_RE = /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i;

function userId(req) {
  return req.authUserId || req.session.userId;
}

function nowIso() {
  return new Date().toISOString();
}

function currentMonth() {
  return nowIso().slice(0, 7);
}

function publicSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    check_in: row.check_in,
    check_out: row.check_out,
    daily_rate: Number(row.daily_rate || 0),
    extras: Number(row.extras || 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function taskUrgency(row, now = new Date()) {
  const frequencyDays = Math.max(1, Number(row.frequency_days || 1));
  const completed = row.last_completed ? new Date(row.last_completed) : null;
  if (!completed || Number.isNaN(completed.getTime())) {
    return { urgency: Number.MAX_SAFE_INTEGER, status: 'overdue', due_date: null };
  }

  const due = new Date(completed);
  due.setDate(due.getDate() + frequencyDays);

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const elapsedDays = Math.max(0, (now.getTime() - completed.getTime()) / 86_400_000);
  const urgency = elapsedDays / frequencyDays;

  let status = 'ok';
  if (today.getTime() > dueDay.getTime()) status = 'overdue';
  else if (today.getTime() === dueDay.getTime()) status = 'today';

  return { urgency, status, due_date: due.toISOString() };
}

function publicDecayTask(row) {
  const computed = taskUrgency(row);
  return {
    id: row.id,
    name: row.name,
    area: row.area,
    frequency_days: row.frequency_days,
    last_completed: row.last_completed,
    urgency: computed.urgency === Number.MAX_SAFE_INTEGER ? null : Number(computed.urgency.toFixed(3)),
    urgency_status: computed.status,
    due_date: computed.due_date,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function validatePhotoUrl(value) {
  if (value === undefined || value === null || value === '') return { value: null, error: null };
  if (typeof value !== 'string') return { value: null, error: 'Photo must be a data URL string.' };
  const trimmed = value.trim();
  if (trimmed.length > MAX_PHOTO_DATA_LENGTH) return { value: null, error: 'Photo is too large.' };
  if (!IMAGE_DATA_RE.test(trimmed)) return { value: null, error: 'Photo must be PNG, JPEG, or WebP.' };
  return { value: trimmed, error: null };
}

function loadOpenSession() {
  return db.get().prepare(`
    SELECT * FROM housekeeping_work_sessions
    WHERE check_out IS NULL
    ORDER BY check_in DESC
    LIMIT 1
  `).get();
}

function defaultDailyRate() {
  const row = db.get().prepare(`
    SELECT daily_rate FROM housekeeping_work_sessions
    ORDER BY check_in DESC
    LIMIT 1
  `).get();
  return Number(row?.daily_rate || 0);
}

function monthlySummary(monthValue = currentMonth()) {
  const row = db.get().prepare(`
    SELECT
      COUNT(*) AS session_count,
      COALESCE(SUM(daily_rate), 0) AS daily_total,
      COALESCE(SUM(extras), 0) AS extras_total,
      COALESCE(SUM(daily_rate + extras), 0) AS total_amount
    FROM housekeeping_work_sessions
    WHERE substr(check_in, 1, 7) = ?
  `).get(monthValue);

  return {
    month: monthValue,
    session_count: row.session_count,
    daily_total: Number(row.daily_total || 0),
    extras_total: Number(row.extras_total || 0),
    total_amount: Number(row.total_amount || 0),
  };
}

function defaultShoppingCategory() {
  const preferred = db.get()
    .prepare("SELECT name FROM shopping_categories WHERE name = 'Haushalt' COLLATE NOCASE LIMIT 1")
    .get();
  if (preferred) return preferred.name;
  const fallback = db.get()
    .prepare("SELECT name FROM shopping_categories WHERE name = 'Sonstiges' COLLATE NOCASE LIMIT 1")
    .get();
  return fallback?.name || 'Sonstiges';
}

function defaultShoppingList(actorId) {
  const existing = db.get().prepare(`
    SELECT id FROM shopping_lists
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `).get();
  if (existing) return existing.id;

  const result = db.get()
    .prepare('INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)')
    .run('Housekeeping', actorId);
  return result.lastInsertRowid;
}

router.get('/summary', (req, res) => {
  try {
    const vMonth = month(req.query.month, 'month');
    if (vMonth.error) return res.status(400).json({ error: vMonth.error, code: 400 });
    res.json({
      data: {
        current_session: publicSession(loadOpenSession()),
        default_daily_rate: defaultDailyRate(),
        summary: monthlySummary(vMonth.value || currentMonth()),
      },
    });
  } catch (err) {
    log.error('GET /summary error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/work-sessions', (req, res) => {
  try {
    const vMonth = month(req.query.month, 'month');
    if (vMonth.error) return res.status(400).json({ error: vMonth.error, code: 400 });
    const rows = db.get().prepare(`
      SELECT * FROM housekeeping_work_sessions
      WHERE substr(check_in, 1, 7) = ?
      ORDER BY check_in DESC
    `).all(vMonth.value || currentMonth());
    res.json({ data: rows.map(publicSession) });
  } catch (err) {
    log.error('GET /work-sessions error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/work-sessions/check-in', (req, res) => {
  try {
    if (loadOpenSession()) return res.status(409).json({ error: 'A work session is already open.', code: 409 });

    const vDailyRate = num(req.body.daily_rate, 'daily_rate', { required: true });
    const vExtras = num(req.body.extras, 'extras');
    const errors = collectErrors([vDailyRate, vExtras]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    if (vDailyRate.value < 0 || (vExtras.value ?? 0) < 0) {
      return res.status(400).json({ error: 'Amounts must be greater than or equal to zero.', code: 400 });
    }

    const result = db.get().prepare(`
      INSERT INTO housekeeping_work_sessions (check_in, daily_rate, extras, created_by)
      VALUES (?, ?, ?, ?)
    `).run(nowIso(), vDailyRate.value, vExtras.value ?? 0, userId(req));
    const row = db.get().prepare('SELECT * FROM housekeeping_work_sessions WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ data: publicSession(row), summary: monthlySummary() });
  } catch (err) {
    log.error('POST /work-sessions/check-in error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/work-sessions/check-out', (req, res) => {
  try {
    const session = loadOpenSession();
    if (!session) return res.status(404).json({ error: 'No open work session found.', code: 404 });

    const vExtras = num(req.body.extras, 'extras');
    if (vExtras.error) return res.status(400).json({ error: vExtras.error, code: 400 });
    if ((vExtras.value ?? session.extras) < 0) {
      return res.status(400).json({ error: 'Extras must be greater than or equal to zero.', code: 400 });
    }

    db.get().prepare(`
      UPDATE housekeeping_work_sessions
      SET check_out = ?, extras = ?
      WHERE id = ?
    `).run(nowIso(), vExtras.value ?? session.extras, session.id);
    const row = db.get().prepare('SELECT * FROM housekeeping_work_sessions WHERE id = ?').get(session.id);
    res.json({ data: publicSession(row), summary: monthlySummary(row.check_in.slice(0, 7)) });
  } catch (err) {
    log.error('POST /work-sessions/check-out error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/decay-tasks', (_req, res) => {
  try {
    const rows = db.get().prepare('SELECT * FROM housekeeping_decay_tasks ORDER BY area COLLATE NOCASE, name COLLATE NOCASE').all();
    const tasks = rows
      .map(publicDecayTask)
      .sort((a, b) => {
        const rank = { overdue: 0, today: 1, ok: 2 };
        const rankDiff = rank[a.urgency_status] - rank[b.urgency_status];
        if (rankDiff !== 0) return rankDiff;
        return (b.urgency ?? 9999) - (a.urgency ?? 9999);
      });
    res.json({ data: tasks });
  } catch (err) {
    log.error('GET /decay-tasks error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/decay-tasks', (req, res) => {
  try {
    const vName = str(req.body.name, 'name', { max: MAX_TITLE });
    const vArea = str(req.body.area, 'area', { max: MAX_SHORT });
    const vFrequency = num(req.body.frequency_days, 'frequency_days', { required: true });
    const vCompleted = datetime(req.body.last_completed, 'last_completed');
    const errors = collectErrors([vName, vArea, vFrequency, vCompleted]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    if (!Number.isInteger(vFrequency.value) || vFrequency.value < 1) {
      return res.status(400).json({ error: 'frequency_days must be a positive integer.', code: 400 });
    }

    const result = db.get().prepare(`
      INSERT INTO housekeeping_decay_tasks (name, area, frequency_days, last_completed, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(vName.value, vArea.value, vFrequency.value, vCompleted.value, userId(req));
    const row = db.get().prepare('SELECT * FROM housekeeping_decay_tasks WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ data: publicDecayTask(row) });
  } catch (err) {
    log.error('POST /decay-tasks error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.patch('/decay-tasks/:taskId', (req, res) => {
  try {
    const vId = validateId(req.params.taskId, 'taskId');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const existing = db.get().prepare('SELECT * FROM housekeeping_decay_tasks WHERE id = ?').get(vId.value);
    if (!existing) return res.status(404).json({ error: 'Task not found.', code: 404 });

    const vName = req.body.name !== undefined ? str(req.body.name, 'name', { max: MAX_TITLE }) : { value: existing.name, error: null };
    const vArea = req.body.area !== undefined ? str(req.body.area, 'area', { max: MAX_SHORT }) : { value: existing.area, error: null };
    const vFrequency = req.body.frequency_days !== undefined ? num(req.body.frequency_days, 'frequency_days', { required: true }) : { value: existing.frequency_days, error: null };
    const vCompleted = req.body.last_completed !== undefined ? datetime(req.body.last_completed, 'last_completed') : { value: existing.last_completed, error: null };
    const errors = collectErrors([vName, vArea, vFrequency, vCompleted]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    if (!Number.isInteger(Number(vFrequency.value)) || Number(vFrequency.value) < 1) {
      return res.status(400).json({ error: 'frequency_days must be a positive integer.', code: 400 });
    }

    db.get().prepare(`
      UPDATE housekeeping_decay_tasks
      SET name = ?, area = ?, frequency_days = ?, last_completed = ?
      WHERE id = ?
    `).run(vName.value, vArea.value, Number(vFrequency.value), vCompleted.value, vId.value);
    const row = db.get().prepare('SELECT * FROM housekeeping_decay_tasks WHERE id = ?').get(vId.value);
    res.json({ data: publicDecayTask(row) });
  } catch (err) {
    log.error('PATCH /decay-tasks/:taskId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/decay-tasks/:taskId/complete', (req, res) => {
  try {
    const vId = validateId(req.params.taskId, 'taskId');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const existing = db.get().prepare('SELECT * FROM housekeeping_decay_tasks WHERE id = ?').get(vId.value);
    if (!existing) return res.status(404).json({ error: 'Task not found.', code: 404 });

    db.get().prepare('UPDATE housekeeping_decay_tasks SET last_completed = ? WHERE id = ?').run(nowIso(), vId.value);
    const row = db.get().prepare('SELECT * FROM housekeeping_decay_tasks WHERE id = ?').get(vId.value);
    res.json({ data: publicDecayTask(row) });
  } catch (err) {
    log.error('POST /decay-tasks/:taskId/complete error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.delete('/decay-tasks/:taskId', (req, res) => {
  try {
    const vId = validateId(req.params.taskId, 'taskId');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const result = db.get().prepare('DELETE FROM housekeeping_decay_tasks WHERE id = ?').run(vId.value);
    if (result.changes === 0) return res.status(404).json({ error: 'Task not found.', code: 404 });
    res.json({ ok: true });
  } catch (err) {
    log.error('DELETE /decay-tasks/:taskId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/supply-requests', (req, res) => {
  try {
    const vName = str(req.body.name, 'name', { max: MAX_TITLE });
    const vQuantity = str(req.body.quantity, 'quantity', { max: MAX_SHORT, required: false });
    const errors = collectErrors([vName, vQuantity]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const actorId = userId(req);
    const result = db.get().transaction(() => {
      const listId = defaultShoppingList(actorId);
      const item = db.get().prepare(`
        INSERT INTO shopping_items (list_id, name, quantity, category)
        VALUES (?, ?, ?, ?)
      `).run(listId, vName.value, vQuantity.value, defaultShoppingCategory());
      const request = db.get().prepare(`
        INSERT INTO housekeeping_supply_requests (name, quantity, shopping_item_id, created_by)
        VALUES (?, ?, ?, ?)
      `).run(vName.value, vQuantity.value, item.lastInsertRowid, actorId);
      return {
        requestId: request.lastInsertRowid,
        shoppingItemId: item.lastInsertRowid,
      };
    })();

    const row = db.get().prepare('SELECT * FROM housekeeping_supply_requests WHERE id = ?').get(result.requestId);
    res.status(201).json({ data: row, shopping_item_id: result.shoppingItemId });
  } catch (err) {
    log.error('POST /supply-requests error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/maintenance-log', (_req, res) => {
  try {
    const rows = db.get().prepare('SELECT * FROM housekeeping_maintenance_log ORDER BY created_at DESC, id DESC').all();
    res.json({ data: rows });
  } catch (err) {
    log.error('GET /maintenance-log error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/maintenance-log', (req, res) => {
  try {
    const vDescription = str(req.body.description, 'description', { max: MAX_TEXT });
    const vPhoto = validatePhotoUrl(req.body.photo_url);
    const errors = collectErrors([vDescription, vPhoto]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const result = db.get().prepare(`
      INSERT INTO housekeeping_maintenance_log (description, photo_url, created_by)
      VALUES (?, ?, ?)
    `).run(vDescription.value, vPhoto.value, userId(req));
    const row = db.get().prepare('SELECT * FROM housekeeping_maintenance_log WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ data: row });
  } catch (err) {
    log.error('POST /maintenance-log error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
