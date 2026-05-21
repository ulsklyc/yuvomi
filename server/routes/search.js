/**
 * Modul: Globale Suche (Search)
 * Zweck: Volltext-Suche über Aufgaben, Kalender-Events und Notizen
 * Abhängigkeiten: express, server/db.js
 */

import express from 'express';
import * as db from '../db.js';

const router = express.Router();

const LIMIT = 5;

/**
 * GET /api/v1/search?q=<query>
 * Durchsucht Aufgaben, Kalender-Events, Notizen, Kontakte und Einkaufsartikel.
 * Response: { tasks: Task[], events: Event[], notes: Note[], contacts: Contact[], items: Item[] }
 */
router.get('/', (req, res) => {
  try {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) return res.json({ tasks: [], events: [], notes: [], contacts: [], items: [] });

    const like = `%${q}%`;
    const userId = req.session.userId;

    const tasks = db.get().prepare(`
      SELECT id, title, status, priority, due_date
      FROM tasks
      WHERE parent_task_id IS NULL
        AND (created_by = ? OR assigned_to = ?)
        AND (title LIKE ? OR description LIKE ?)
      ORDER BY CASE status WHEN 'done' THEN 1 ELSE 0 END,
               due_date ASC NULLS LAST
      LIMIT ?
    `).all(userId, userId, like, like, LIMIT);

    const events = db.get().prepare(`
      SELECT id, title, start_datetime, all_day
      FROM calendar_events
      WHERE created_by = ?
        AND (title LIKE ? OR description LIKE ?)
      ORDER BY start_datetime ASC
      LIMIT ?
    `).all(userId, like, like, LIMIT);

    const notes = db.get().prepare(`
      SELECT id, title, content
      FROM notes
      WHERE created_by = ?
        AND (title LIKE ? OR content LIKE ?)
      ORDER BY pinned DESC, updated_at DESC
      LIMIT ?
    `).all(userId, like, like, LIMIT);

    const contacts = db.get().prepare(`
      SELECT id, name AS title
      FROM contacts
      WHERE name LIKE ? OR phone LIKE ? OR email LIKE ?
      ORDER BY name ASC
      LIMIT ?
    `).all(like, like, like, LIMIT);

    const items = db.get().prepare(`
      SELECT id, name AS title, list_id
      FROM shopping_items
      WHERE name LIKE ?
      ORDER BY name ASC
      LIMIT ?
    `).all(like, LIMIT);

    res.json({ tasks, events, notes, contacts, items });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
