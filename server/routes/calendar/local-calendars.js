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
  releaseCopiedCalendarColor,
  restoreInheritedImportColors,
  serializeCalendar,
  validateCalendarColor,
  validateCalendarName,
} from '../../services/local-calendars.js';
import { uploadsLocalEvents } from '../../services/apple-calendar.js';
import { calendarSources } from '../../services/calendar-selection.js';
import { createLogger } from '../../logger.js';
import { feedUrl, getUserId, isAdminUser } from './helpers.js';

const log = createLogger('CalendarLocalCalendars');
const router = express.Router();

// #1909: die Faelle, die ein Nutzer in der Kalender-Verwaltung erreicht, tragen
// einen `reason`; die App sagt dazu ihren Satz (utils/friendly-error.js,
// pages/calendar.js). `error` bleibt englisch fuer API-Clients und Logs.
function sendCalendarGone(res) {
  return res.status(404).json({ error: 'Calendar not found.', code: 404, reason: 'calendar_calendar_not_found' });
}

// Der erste Fehler einer Pruefung mit Grund gibt der Antwort ihren Fall.
function sendValidationErrors(res, results) {
  const failed = results.filter((result) => result?.error);
  const withReason = failed.find((result) => result.reason);
  return res.status(400).json({
    error: failed.map((result) => result.error).join(' '),
    code: 400,
    ...(withReason ? { reason: withReason.reason, params: withReason.params } : {}),
  });
}

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
    // Nur der Standardkalender geht mit der alten Apple-Verbindung zu iCloud
    // hinauf. Die Rückfrage vor dem Löschen eines anderen Kalenders nennt das,
    // weil dessen Termine dorthin fallen. Ein Ja oder Nein, keine Zugangsdaten.
    const icloudUpload = uploadsLocalEvents();
    // DANEBEN ALLE WAEHLBAREN KALENDER (#2062): eigene, synchronisierte und
    // Abos unter dem Schluessel des Kalendermoduls (`local:N`, `cal:N`,
    // `sub:N`). Der Optionen-Dialog der Kalender-Kachel liest sie; dieselbe
    // Liste prueft die Auswahl in `GET /dashboard`. Wie `area_modules` bei den
    // Displays steht sie neben `data`, damit `data` die eigenen Kalender bleibt.
    res.json({
      data: rows.map((row) => ({
        ...serializeCalendar(req, row, feedUrl, { includeFeedToken: isAdminUser(req) }),
        event_count: row.event_count ?? 0,
        uploads_to_icloud: icloudUpload && !!row.is_default,
      })),
      sources: calendarSources(db.get(), getUserId(req)),
    });
  } catch (err) {
    log.error('GET /calendars', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/calendars', (req, res) => {
  if (!mayWriteModule(req, 'calendar')) {
    return res.status(403).json({ error: 'Write access to the calendar is required.', code: 403, reason: 'cross_module_access' });
  }
  try {
    const vName = validateCalendarName(req.body?.name);
    const vColor = validateCalendarColor(req.body?.color ?? '#007AFF');
    if (vName.error || vColor.error) return sendValidationErrors(res, [vName, vColor]);

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
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.patch('/calendars/reorder', (req, res) => {
  if (!mayWriteModule(req, 'calendar')) {
    return res.status(403).json({ error: 'Write access to the calendar is required.', code: 403, reason: 'cross_module_access' });
  }
  try {
    const database = db.get();
    const order = req.body?.order;
    // Eine Liste eindeutiger Kennungen, die nicht die aktuellen Kalender sind,
    // heisst: inzwischen kam einer dazu oder ging (#1909). Alles andere schickt
    // nur ein Aufrufer an der Oberflaeche vorbei.
    const wellFormed = Array.isArray(order) && order.every(id => Number.isSafeInteger(id))
      && new Set(order).size === order.length;
    const reorder = database.transaction(() => {
      const ids = database.prepare('SELECT id FROM local_calendars').all().map(row => row.id);
      if (!wellFormed || order.length !== ids.length || !order.every(id => ids.includes(id))) return false;
      const update = database.prepare('UPDATE local_calendars SET sort_order = ? WHERE id = ?');
      order.forEach((id, index) => update.run(index, id));
      return true;
    });
    if (!reorder()) {
      return res.status(400).json({
        error: 'Order: list every calendar exactly once.',
        code: 400,
        ...(wellFormed ? { reason: 'calendar_order_changed' } : {}),
      });
    }
    res.json({ data: true });
  } catch (err) {
    log.error('PATCH /calendars/reorder', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
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
    if (!row) return sendCalendarGone(res);

    const changes = {};
    const checks = [];
    if (Object.hasOwn(req.body ?? {}, 'name')) {
      const vName = validateCalendarName(req.body.name);
      checks.push(vName);
      if (!vName.error) changes.name = vName.value;
    }
    if (Object.hasOwn(req.body ?? {}, 'color')) {
      const vColor = validateCalendarColor(req.body.color);
      checks.push(vColor);
      if (!vColor.error) changes.color = vColor.value;
    }
    if (Object.hasOwn(req.body ?? {}, 'sort_order')) {
      const order = Number(req.body.sort_order);
      if (!Number.isInteger(order) || order < 0) checks.push({ error: 'Order: enter a whole number from 0.' });
      else changes.sort_order = order;
    }
    if (checks.some((check) => check.error)) return sendValidationErrors(res, checks);
    if (Object.keys(changes).length) {
      // Importierte Termine trugen bis #2303 eine Kopie der Kalenderfarbe und
      // blieben beim Umfaerben auf der alten stehen. Im selben Schritt wie das
      // Umfaerben, damit keine Antwort dazwischen den halben Stand liest.
      if (changes.color && changes.color !== row.color) releaseCopiedCalendarColor(database, id, row.color);
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
    res.status(500).json({ error: 'Internal server error.', code: 500 });
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
    if (!row) return sendCalendarGone(res);
    if (row.is_default) {
      return res.status(400).json({ error: 'The default calendar cannot be deleted.', code: 400 });
    }
    // Das Mitglied sieht den Abo-Link nicht (nur Admins bekommen ihn), also
    // auch nicht, warum das Loeschen scheitert: der Grund sagt es (#1909).
    if (row.feed_token && !isAdminUser(req)) {
      return res.status(403).json({ error: 'Admin access required.', code: 403, reason: 'calendar_feed_admin_only' });
    }
    database.transaction(() => {
      database.prepare('DELETE FROM local_calendars WHERE id = ?').run(id);
      restoreInheritedImportColors(database);
    })();
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /calendars/:id', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/calendars/:id/feed/regenerate', requireAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const database = db.get();
    const row = localCalendarById(database, id);
    if (!row) return sendCalendarGone(res);
    const token = regenerateCalendarFeedToken(database, id);
    res.json({ data: { token, url: feedUrl(req, token) } });
  } catch (err) {
    log.error('POST /calendars/:id/feed/regenerate', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.delete('/calendars/:id/feed', requireAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const database = db.get();
    const row = localCalendarById(database, id);
    if (!row) return sendCalendarGone(res);
    clearCalendarFeedToken(database, id);
    res.json({ data: { token: null } });
  } catch (err) {
    log.error('DELETE /calendars/:id/feed', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
