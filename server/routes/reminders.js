/**
 * Modul: Erinnerungen (Reminders)
 * Zweck: REST-API für Erinnerungen an Aufgaben und Kalender-Events
 * Abhängigkeiten: express, server/db.js
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import * as v from '../middleware/validate.js';
import { syncAllBirthdayReminders } from '../services/birthdays.js';

const log    = createLogger('Reminders');
const router = express.Router();

const VALID_ENTITY_TYPES = ['task', 'event', 'subscription'];

// --------------------------------------------------------
// GET /api/v1/reminders/pending
// Gibt alle fälligen, nicht-verworfenen Erinnerungen des aktuellen Nutzers zurück.
// "Fällig" = remind_at <= jetzt
// Response: { data: Reminder[] }
// --------------------------------------------------------
router.get('/pending', (req, res) => {
  try {
    const userId = req.authUserId || req.session.userId;
    const now    = new Date().toISOString();
    syncAllBirthdayReminders(db.get(), userId, new Date());

    const rows = db.get().prepare(`
      SELECT
        r.*,
        CASE r.entity_type
          WHEN 'task'  THEN (SELECT title FROM tasks           WHERE id = r.entity_id)
          WHEN 'event' THEN (SELECT title FROM calendar_events WHERE id = r.entity_id)
          WHEN 'subscription' THEN (SELECT name FROM budget_subscriptions WHERE id = r.entity_id)
        END AS entity_title
      FROM reminders r
      WHERE r.created_by  = ?
        AND r.dismissed   = 0
        AND r.remind_at  <= ?
      ORDER BY r.remind_at ASC
    `).all(userId, now);

    res.json({ data: rows });
  } catch (err) {
    log.error('Error loading due reminders:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/reminders?entity_type=task&entity_id=5
// Gibt die Erinnerung für eine spezifische Entität zurück (oder null).
// Response: { data: Reminder | null }
// --------------------------------------------------------
router.get('/', (req, res) => {
  try {
    const userId      = req.authUserId || req.session.userId;
    const entityType  = req.query.entity_type;
    const entityId    = parseInt(req.query.entity_id, 10);

    if (!VALID_ENTITY_TYPES.includes(entityType) || !entityId) {
      return res.status(400).json({ error: 'entity_type und entity_id sind erforderlich.', code: 400 });
    }

    const row = db.get().prepare(`
      SELECT * FROM reminders
      WHERE entity_type = ? AND entity_id = ? AND created_by = ? AND dismissed = 0
      ORDER BY created_at DESC LIMIT 1
    `).get(entityType, entityId, userId);

    res.json({ data: row || null });
  } catch (err) {
    log.error('Error loading reminder:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/reminders
// Erstellt oder ersetzt die Erinnerung für eine Entität.
// Body: { entity_type, entity_id, remind_at }
// Response: { data: Reminder }
// --------------------------------------------------------
router.post('/', (req, res) => {
  try {
    const userId = req.authUserId || req.session.userId;
    const { entity_type, entity_id, remind_at } = req.body;

    const errors = v.collectErrors([
      v.oneOf(entity_type,     VALID_ENTITY_TYPES, 'entity_type'),
      v.id(entity_id,          'entity_id'),
      v.datetime(remind_at,    'remind_at', true),
    ]);

    if (!entity_type || !VALID_ENTITY_TYPES.includes(entity_type)) {
      errors.push('entity_type must be task, event, or subscription.');
    }

    if (errors.length) {
      return res.status(400).json({ error: errors.join(' '), code: 400 });
    }

    const entityId = parseInt(entity_id, 10);

    // Bestehende nicht-verworfene Erinnerungen für diese Entität löschen
    db.get().prepare(`
      DELETE FROM reminders
      WHERE entity_type = ? AND entity_id = ? AND created_by = ?
    `).run(entity_type, entityId, userId);

    const result = db.get().prepare(`
      INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
      VALUES (?, ?, ?, ?)
    `).run(entity_type, entityId, remind_at, userId);

    const row = db.get().prepare('SELECT * FROM reminders WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ data: row });
  } catch (err) {
    log.error('Error creating reminder:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// --------------------------------------------------------
// PATCH /api/v1/reminders/:id/dismiss
// Markiert eine Erinnerung als verworfen.
// Response: { data: { id } }
// --------------------------------------------------------
router.patch('/:id/dismiss', (req, res) => {
  try {
    const userId     = req.authUserId || req.session.userId;
    const reminderId = parseInt(req.params.id, 10);

    if (!reminderId) {
      return res.status(400).json({ error: 'Ungültige Erinnerungs-ID.', code: 400 });
    }

    const reminder = db.get().prepare(
      'SELECT * FROM reminders WHERE id = ? AND created_by = ?'
    ).get(reminderId, userId);

    if (!reminder) {
      return res.status(404).json({ error: 'Erinnerung nicht gefunden.', code: 404 });
    }

    db.get().prepare('UPDATE reminders SET dismissed = 1 WHERE id = ?').run(reminderId);
    res.json({ data: { id: reminderId } });
  } catch (err) {
    log.error('Error dismissing reminder:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/reminders/:id
// Löscht eine Erinnerung dauerhaft.
// Response: 204 No Content
// --------------------------------------------------------
router.delete('/:id', (req, res) => {
  try {
    const userId     = req.authUserId || req.session.userId;
    const reminderId = parseInt(req.params.id, 10);

    if (!reminderId) {
      return res.status(400).json({ error: 'Ungültige Erinnerungs-ID.', code: 400 });
    }

    const reminder = db.get().prepare(
      'SELECT id FROM reminders WHERE id = ? AND created_by = ?'
    ).get(reminderId, userId);

    if (!reminder) {
      return res.status(404).json({ error: 'Erinnerung nicht gefunden.', code: 404 });
    }

    db.get().prepare('DELETE FROM reminders WHERE id = ?').run(reminderId);
    res.status(204).end();
  } catch (err) {
    log.error('Error deleting reminder:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/reminders?entity_type=task&entity_id=5
// Löscht alle Erinnerungen für eine Entität (z.B. bei Task-Löschung).
// Response: 204 No Content
// --------------------------------------------------------
router.delete('/', (req, res) => {
  try {
    const userId     = req.authUserId || req.session.userId;
    const entityType = req.query.entity_type;
    const entityId   = parseInt(req.query.entity_id, 10);

    if (!VALID_ENTITY_TYPES.includes(entityType) || !entityId) {
      return res.status(400).json({ error: 'entity_type und entity_id sind erforderlich.', code: 400 });
    }

    db.get().prepare(`
      DELETE FROM reminders
      WHERE entity_type = ? AND entity_id = ? AND created_by = ?
    `).run(entityType, entityId, userId);

    res.status(204).end();
  } catch (err) {
    log.error('Error deleting reminders:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

export default router;
