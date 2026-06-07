/**
 * Modul: Pinnwand / Notizen (Notes)
 * Zweck: REST-API-Routen für Notizen (CRUD, Pin-Toggle)
 * Abhängigkeiten: express, server/db.js, server/auth.js
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { str, color, collectErrors, MAX_TEXT, MAX_TITLE } from '../middleware/validate.js';

const log = createLogger('Notes');

const router  = express.Router();

/**
 * GET /api/v1/notes
 * Alle Notizen, angepinnte zuerst, dann nach updated_at DESC.
 * Response: { data: Note[] }
 */
router.get('/', (req, res) => {
  try {
    const notes = db.get().prepare(`
      SELECT n.*, u.display_name AS creator_name, u.avatar_color AS creator_color, u.avatar_data AS creator_avatar
      FROM notes n
      LEFT JOIN users u ON u.id = n.created_by
      ORDER BY n.pinned DESC, n.updated_at DESC
    `).all();
    res.json({ data: notes });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * POST /api/v1/notes
 * Neue Notiz anlegen.
 * Body: { content, title?, color?, pinned? }
 * Response: { data: Note }
 */
router.post('/', (req, res) => {
  try {
    const { pinned = 0 } = req.body;
    const vContent = str(req.body.content, 'Inhalt', { max: MAX_TEXT });
    const vTitle   = str(req.body.title,   'Titel',  { max: MAX_TITLE, required: false });
    const vColor   = color(req.body.color || '#FFEB3B', 'Farbe');
    const errors   = collectErrors([vContent, vTitle, vColor]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const result = db.get().prepare(`
      INSERT INTO notes (content, title, color, pinned, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(vContent.value, vTitle.value, vColor.value, pinned ? 1 : 0, req.authUserId || req.session.userId);

    const note = db.get().prepare(`
      SELECT n.*, u.display_name AS creator_name, u.avatar_color AS creator_color, u.avatar_data AS creator_avatar
      FROM notes n LEFT JOIN users u ON u.id = n.created_by
      WHERE n.id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json({ data: note });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * PUT /api/v1/notes/:id
 * Notiz bearbeiten.
 * Body: { content?, title?, color?, pinned? }
 * Response: { data: Note }
 */
router.put('/:id', (req, res) => {
  try {
    const id   = parseInt(req.params.id, 10);
    const note = db.get().prepare('SELECT * FROM notes WHERE id = ?').get(id);
    if (!note) return res.status(404).json({ error: 'Notiz nicht gefunden', code: 404 });

    const { pinned } = req.body;
    const checks = [];
    if (req.body.content !== undefined) checks.push(str(req.body.content, 'Inhalt', { max: MAX_TEXT, required: false }));
    if (req.body.title !== undefined)   checks.push(str(req.body.title,   'Titel',  { max: MAX_TITLE, required: false }));
    if (req.body.color !== undefined)   checks.push(color(req.body.color, 'Farbe'));
    const errors = collectErrors(checks);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    db.get().prepare(`
      UPDATE notes
      SET content = COALESCE(?, content),
          title   = ?,
          color   = COALESCE(?, color),
          pinned  = COALESCE(?, pinned)
      WHERE id = ?
    `).run(
      req.body.content?.trim() ?? null,
      req.body.title !== undefined ? (req.body.title?.trim() || null) : note.title,
      req.body.color ?? null,
      pinned !== undefined ? (pinned ? 1 : 0) : null,
      id
    );

    const updated = db.get().prepare(`
      SELECT n.*, u.display_name AS creator_name, u.avatar_color AS creator_color, u.avatar_data AS creator_avatar
      FROM notes n LEFT JOIN users u ON u.id = n.created_by WHERE n.id = ?
    `).get(id);

    res.json({ data: updated });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * PATCH /api/v1/notes/:id/pin
 * Pin-Status toggeln.
 * Response: { data: { id, pinned } }
 */
router.patch('/:id/pin', (req, res) => {
  try {
    const id   = parseInt(req.params.id, 10);
    const note = db.get().prepare('SELECT pinned FROM notes WHERE id = ?').get(id);
    if (!note) return res.status(404).json({ error: 'Notiz nicht gefunden', code: 404 });

    const newPinned = note.pinned ? 0 : 1;
    db.get().prepare('UPDATE notes SET pinned = ? WHERE id = ?').run(newPinned, id);
    res.json({ data: { id, pinned: newPinned } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * DELETE /api/v1/notes/:id
 * Notiz löschen.
 * Response: 204 No Content
 */
router.delete('/:id', (req, res) => {
  try {
    const id     = parseInt(req.params.id, 10);
    const result = db.get().prepare('DELETE FROM notes WHERE id = ?').run(id);
    if (result.changes === 0)
      return res.status(404).json({ error: 'Notiz nicht gefunden', code: 404 });
    res.status(204).end();
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

export default router;
