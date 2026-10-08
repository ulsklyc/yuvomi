import { visibilityWhere } from '../../services/visibility.js';
import express from 'express';
import * as db from '../../db.js';
import { requireAdmin } from '../../middleware/require-admin.js';
import { mayWriteModule } from '../../permissions.js';
import {
  clearCalendarFeedToken,
  ensureDefaultCalendar,
  localCalendarById,
  localCalendarIdSql,
  regenerateCalendarFeedToken,
  serializeCalendar,
  validateCalendarColor,
  validateCalendarName,
} from '../../services/local-calendars.js';
import { createLogger } from '../../logger.js';
import { feedUrl, getUserId, isAdminUser } from './helpers.js';

const log = createLogger('CalendarLocalCalendars');
const router = express.Router();

function loadCalendars(database, viewerId) {
  ensureDefaultCalendar(database);
  return database.prepare(`
    SELECT lc.*,
           (SELECT COUNT(*) FROM calendar_events e WHERE ${localCalendarIdSql()} = lc.id AND ${visibilityWhere('e', 'event_assignments', 'event_id', '@viewerId')}) AS event_count
    FROM local_calendars lc
    ORDER BY lc.sort_order ASC, lc.name COLLATE NOCASE ASC, lc.id ASC
  `).all({ viewerId });
}

router.get('/calendars', (req, res) => {
  try {
    const rows = loadCalendars(db.get(), getUserId(req));
    res.json({ data: rows.map((row) => ({
      ...serializeCalendar(req, row, feedUrl, { includeFeedToken: isAdminUser(req) }),
      event_count: row.event_count ?? 0,
    })) });
  } catch (err) {
    log.error('GET /calendars', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

router.post('/calendars', (req, res) => {
  if (!mayWriteModule(req, 'calendar')) {
    return res.status(403).json({ error: 'Write access to the calendar is required.', code: 403, reason: 'cross_module_access' });
  }
  try {
    const vName = validateCalendarName(req.body?.name);
    const vColor = validateCalendarColor(req.body?.color ?? '#007AFF');
    const errors = [vName.error, vColor.error].filter(Boolean);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const database = db.get();
    const sortOrder = database.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM local_calendars').get().next;
    const id = database.prepare(`
      INSERT INTO local_calendars (name, color, is_default, sort_order, created_by)
      VALUES (?, ?, 0, ?, ?)
    `).run(vName.value, vColor.value, sortOrder, getUserId(req)).lastInsertRowid;
    const row = localCalendarById(database, id);
    res.status(201).json({ data: serializeCalendar(req, row, feedUrl) });
  } catch (err) {
    log.error('POST /calendars', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

router.put('/calendars/:id', (req, res) => {
  if (!mayWriteModule(req, 'calendar')) {
    return res.status(403).json({ error: 'Write access to the calendar is required.', code: 403, reason: 'cross_module_access' });
  }
  try {
    const id = Number(req.params.id);
    const database = db.get();
    const row = localCalendarById(database, id);
    if (!row) return res.status(404).json({ error: 'Kalender nicht gefunden', code: 404 });

    const changes = {};
    const errors = [];
    if (Object.hasOwn(req.body ?? {}, 'name')) {
      const vName = validateCalendarName(req.body.name);
      if (vName.error) errors.push(vName.error);
      else changes.name = vName.value;
    }
    if (Object.hasOwn(req.body ?? {}, 'color')) {
      const vColor = validateCalendarColor(req.body.color);
      if (vColor.error) errors.push(vColor.error);
      else changes.color = vColor.value;
    }
    if (Object.hasOwn(req.body ?? {}, 'sort_order')) {
      const order = Number(req.body.sort_order);
      if (!Number.isInteger(order) || order < 0) errors.push('Reihenfolge: Gib eine ganze Zahl ab 0 an.');
      else changes.sort_order = order;
    }
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    if (Object.keys(changes).length) {
      database.prepare(`
        UPDATE local_calendars
        SET name = COALESCE(@name, name),
            color = COALESCE(@color, color),
            sort_order = COALESCE(@sort_order, sort_order)
        WHERE id = @id
      `).run({
        id,
        name: changes.name ?? null,
        color: changes.color ?? null,
        sort_order: changes.sort_order ?? null,
      });
    }
    res.json({ data: serializeCalendar(req, localCalendarById(database, id), feedUrl, { includeFeedToken: isAdminUser(req) }) });
  } catch (err) {
    log.error('PUT /calendars/:id', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

router.delete('/calendars/:id', (req, res) => {
  if (!mayWriteModule(req, 'calendar')) {
    return res.status(403).json({ error: 'Write access to the calendar is required.', code: 403, reason: 'cross_module_access' });
  }
  try {
    const id = Number(req.params.id);
    const database = db.get();
    const row = localCalendarById(database, id);
    if (!row) return res.status(404).json({ error: 'Kalender nicht gefunden', code: 404 });
    if (row.is_default) {
      return res.status(400).json({ error: 'Der Standardkalender kann nicht gelöscht werden.', code: 400 });
    }
    if (row.feed_token && !isAdminUser(req)) {
      return res.status(403).json({ error: 'Admin access is required to delete a calendar with an active feed.', code: 403, reason: 'cross_module_access' });
    }
    database.prepare('DELETE FROM local_calendars WHERE id = ?').run(id);
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /calendars/:id', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

router.post('/calendars/:id/feed/regenerate', requireAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const database = db.get();
    const row = localCalendarById(database, id);
    if (!row) return res.status(404).json({ error: 'Kalender nicht gefunden', code: 404 });
    const token = regenerateCalendarFeedToken(database, id);
    res.json({ data: { token, url: feedUrl(req, token) } });
  } catch (err) {
    log.error('POST /calendars/:id/feed/regenerate', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

router.delete('/calendars/:id/feed', requireAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const database = db.get();
    const row = localCalendarById(database, id);
    if (!row) return res.status(404).json({ error: 'Kalender nicht gefunden', code: 404 });
    clearCalendarFeedToken(database, id);
    res.json({ data: { token: null } });
  } catch (err) {
    log.error('DELETE /calendars/:id/feed', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

export default router;
