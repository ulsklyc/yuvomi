import express from 'express';
import { validateRequest } from '../../api/validate-request.ts';
import * as db from '../../db.js';
import { withTx } from '../../db/tx.ts';
import { isAdminRequest, requireAdmin } from '../../middleware/require-admin.js';
import { mayWriteModule, readerVisibleWhere, rowReader } from '../../authorize/index.ts';
import {
  clearCalendarFeedToken,
  defaultCalendarId,
  ensureDefaultCalendar,
  localCalendarById,
  localCalendarIdSql,
  regenerateCalendarFeedToken,
  releaseCopiedCalendarColor,
  restoreInheritedImportColors,
  serializeCalendar,
  validateCalendarColor,
  validateCalendarId,
  validateCalendarName,
} from '../../services/local-calendars.js';
import { uploadsLocalEvents } from '../../services/apple-calendar.js';
import { calendarSources } from '../../services/calendar-selection.js';
import { queueEventDeletion, flushOutbound } from '../../services/calendar-outbound.js';
import { createLogger } from '../../logger.js';
import { sqlInList } from '../../utils/sql-in-list.ts';
import { feedUrl, getUserId } from './helpers.js';

const router = express.Router();
const log = createLogger('Calendar');

// #1909: die Faelle, die ein Nutzer in der Kalender-Verwaltung erreicht, tragen
// einen `reason`; die App sagt dazu ihren Satz (utils/friendly-error.js,
// pages/calendar.js). `error` bleibt englisch fuer API-Clients und Logs.
function sendCalendarGone(res) {
  return res.status(404).json({ error: 'Calendar not found.', code: 404, reason: 'calendar_calendar_not_found' });
}

const CALENDAR_WRITE_REFUSAL = 'Write access to the calendar is required.';

/**
 * Das Schreibrecht auf den Kalender VOR der Pruefung der Anfrage (#2810,
 * Gruppe 10 Entscheidung 3): wer nicht schreiben darf, bekommt 403, auch mit
 * einem Rumpf oder einer Kennung, die nicht zum Schema passt - wie zuvor, als
 * die Pruefung die erste Zeile des Handlers war. Seit Schritt (b) die einzige
 * Stelle: die Zeile im Handler ist weg.
 * @param {any} req
 * @param {any} res
 * @param {() => void} next
 */
function requireCalendarWrite(req, res, next) {
  if (!mayWriteModule(req, 'calendar')) {
    return res.status(403).json({ error: CALENDAR_WRITE_REFUSAL, code: 403, reason: 'cross_module_access' });
  }
  return next();
}

/**
 * Die Kennung im Pfad: das Schema laesst nur Dezimalziffern durch (#2810).
 * @param {any} req
 * @param {string} [name]
 */
function pathId(req, name = 'id') {
  return Number(req.params[name]);
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

/** @param {import('../../authorize/index.ts').RowReader} reader */
function loadCalendars(database, reader) {
  ensureDefaultCalendar(database);
  return database.prepare(`
    SELECT lc.*,
           (SELECT COUNT(*) FROM calendar_events e WHERE ${localCalendarIdSql()} = lc.id AND ${readerVisibleWhere(reader, 'events', 'e', '@viewerId')}) AS event_count
    FROM local_calendars lc
    ORDER BY lc.sort_order ASC, lc.name COLLATE NOCASE ASC, lc.id ASC
  `).all({ viewerId: reader.userId });
}

router.get('/calendars', validateRequest(), (req, res) => {
  // A paired display counts and names only what the whole household sees (rowReader).
  const reader = rowReader(req);
  const rows = loadCalendars(db.get(), reader);
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
      ...serializeCalendar(req, row, feedUrl, { includeFeedToken: isAdminRequest(req) }),
      event_count: row.event_count ?? 0,
      uploads_to_icloud: icloudUpload && !!row.is_default,
    })),
    sources: calendarSources(db.get(), getUserId(req), { reader }),
  });
});

router.post('/calendars', requireCalendarWrite, validateRequest(), (req, res) => {
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
});

router.patch('/calendars/reorder', requireCalendarWrite, validateRequest(), (req, res) => {
  const database = db.get();
  const order = req.body?.order;
  // Eine Liste eindeutiger Kennungen, die nicht die aktuellen Kalender sind,
  // heisst: inzwischen kam einer dazu oder ging (#1909). Alles andere schickt
  // nur ein Aufrufer an der Oberflaeche vorbei.
  const wellFormed = Array.isArray(order) && order.every(id => Number.isSafeInteger(id))
    && new Set(order).size === order.length;
  if (!withTx(database, () => {
    const ids = database.prepare('SELECT id FROM local_calendars').all().map(row => row.id);
    if (!wellFormed || order.length !== ids.length || !order.every(id => ids.includes(id))) return false;
    const update = database.prepare('UPDATE local_calendars SET sort_order = ? WHERE id = ?');
    order.forEach((id, index) => update.run(index, id));
    return true;
  })) {
    return res.status(400).json({
      error: 'Order: list every calendar exactly once.',
      code: 400,
      ...(wellFormed ? { reason: 'calendar_order_changed' } : {}),
    });
  }
  res.json({ data: true });
});

router.put('/calendars/:id', requireCalendarWrite, validateRequest(), (req, res) => {
  const id = pathId(req);
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
    changes.sort_order = req.body.sort_order;
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
  res.json({ data: serializeCalendar(req, localCalendarById(database, id), feedUrl, { includeFeedToken: isAdminRequest(req) }) });
});

/**
 * DELETE /calendars/:id
 * Body (optional): { mode?: 'move' | 'delete', target_calendar_id?: number }
 *
 * `mode: 'delete'` removes every event the calendar owns along with it.
 * Anything else (including no body, for existing callers) moves them - to
 * `target_calendar_id`, or to the default calendar when that is omitted.
 *
 * Moving never pushes outward: `local_calendar_id` is not in MIRRORED_FIELDS
 * (server/services/calendar-outbound.js), by design - a local reshuffle is
 * not a change to what a synced event looks like anywhere else. An event here
 * can in any case never carry an active sync target (DB triggers enforce
 * local and synced calendars as mutually exclusive), so `queueEventDeletion`
 * below is the same defensive no-op the single-event route relies on, not
 * dead code added for this change alone.
 */
router.delete('/calendars/:id', requireCalendarWrite, validateRequest(), (req, res) => {
  const id = pathId(req);
  const database = db.get();
  const row = localCalendarById(database, id);
  if (!row) return sendCalendarGone(res);
  if (row.is_default) {
    return res.status(400).json({ error: 'The default calendar cannot be deleted.', code: 400 });
  }
  // Das Mitglied sieht den Abo-Link nicht (nur Admins bekommen ihn), also
  // auch nicht, warum das Loeschen scheitert: der Grund sagt es (#1909).
  if (row.feed_token && !isAdminRequest(req)) {
    return res.status(403).json({ error: 'Admin access required.', code: 403, reason: 'calendar_feed_admin_only' });
  }
  const deleteEvents = req.body?.mode === 'delete';
  let targetId = null;
  if (!deleteEvents) {
    const vTarget = validateCalendarId(database, req.body?.target_calendar_id);
    if (vTarget.error) return sendValidationErrors(res, [vTarget]);
    targetId = vTarget.value ?? defaultCalendarId(database);
    if (targetId === id) {
      return res.status(400).json({
        error: 'Choose a different calendar to move the events to.', code: 400,
        reason: 'calendar_move_target_same',
      });
    }
  }

  // Dieselbe Zugehoerigkeit, die die Zeile in der Liste zaehlt
  // (loadCalendars/event_count): kein Sync-Ziel, kein Geburtstag, keine
  // Haushaltshilfe - sonst zaehlte und zoege diese Route etwas, das gar
  // nicht diesem Kalender gehoert.
  /** @type {{ id: number }[]} */
  const events = database.prepare(`
    SELECT * FROM calendar_events e WHERE ${localCalendarIdSql('e')} = ?
  `).all(id);

  let queued = false;
  withTx(database, () => {
    if (deleteEvents) {
      if (events.length) {
        for (const event of events) queued = queueEventDeletion(event, database) || queued;
        const idList = sqlInList(events.map((e) => e.id));
        database.prepare(`DELETE FROM reminders WHERE entity_type = 'event' AND entity_id IN (${idList.sql})`).run(idList.param);
        database.prepare(`DELETE FROM calendar_events WHERE id IN (${idList.sql})`).run(idList.param);
      }
    } else if (events.length) {
      // NULL statt der Kennung des Standardkalenders: dieselbe Zeile, die
      // der Lesepfad ohnehin als Standard aufloest (localCalendarIdSql),
      // und bestehende Aufrufer ohne target_calendar_id sehen die exakt
      // gleiche Spalte wie vor dieser Aenderung.
      const value = targetId === defaultCalendarId(database) ? null : targetId;
      const idList = sqlInList(events.map((e) => e.id));
      database.prepare(`UPDATE calendar_events SET local_calendar_id = ? WHERE id IN (${idList.sql})`).run(value, idList.param);
    }
    database.prepare('DELETE FROM local_calendars WHERE id = ?').run(id);
    restoreInheritedImportColors(database);
  });
  res.status(204).end();

  // Bewusst nach der Antwort, wie bei der Einzelloeschung (crud.js):
  // der Provider-Aufruf darf das lokale Loeschen nicht verzoegern. In der
  // Praxis bleibt `queued` fuer Termine dieses Kalenders immer false (siehe
  // Kommentar oben), der Pfad bleibt aber derselbe wie dort.
  if (queued) {
    flushOutbound()
      .catch((err) => log.warn('Loeschung vorgemerkt, Sofortversuch fehlgeschlagen:', err.message));
  }
});

router.post('/calendars/:id/feed/regenerate', requireAdmin, validateRequest(), (req, res) => {
  const id = pathId(req);
  const database = db.get();
  const row = localCalendarById(database, id);
  if (!row) return sendCalendarGone(res);
  const token = regenerateCalendarFeedToken(database, id);
  res.json({ data: { token, url: feedUrl(req, token) } });
});

router.delete('/calendars/:id/feed', requireAdmin, validateRequest(), (req, res) => {
  const id = pathId(req);
  const database = db.get();
  const row = localCalendarById(database, id);
  if (!row) return sendCalendarGone(res);
  clearCalendarFeedToken(database, id);
  res.json({ data: { token: null } });
});

export default router;
