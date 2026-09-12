/**
 * Modul: Kalender (Calendar) - Lese-Routen
 * GET / (Bereich), GET /upcoming, GET /search (FTS).
 */

import { createLogger } from '../../logger.js';
import express from 'express';
import * as db from '../../db.js';
import { DATE_RE } from '../../middleware/validate.js';
import {
  expandAndResolveEventRows, getUpcomingEvents, hydrateEventAttachmentBodies,
} from '../../services/calendar-event-reader.js';
import { SOURCE_CALENDAR_COLUMNS, SOURCE_CALENDAR_JOIN } from '../../services/calendar-events.js';
import { buildMatchQuery, resolveEventSearchRows } from '../../services/search.js';
import { visibilityWhere } from '../../services/visibility.js';
import {
  VALID_SOURCES, ASSIGNED_USERS_SQL, getUserId, isAdminUser, serializeEvents,
} from './helpers.js';
import { shiftDateKey, todayKey } from '../../utils/timezone.js';

const log = createLogger('Calendar');
const router = express.Router();

// --------------------------------------------------------
// GET /api/v1/calendar
// Termine in einem Datumsbereich abrufen.
// Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD  (default: aktueller Monat)
//        &assigned_to=<userId>  (optional Filter)
//        &source=local|google|apple  (optional Filter)
// Response: { data: Event[], from, to }
// --------------------------------------------------------
router.get('/', (req, res) => {
  try {
    const today = todayKey(db.get());
    const year  = today.slice(0, 4);
    const month = today.slice(5, 7);

    const from = req.query.from || `${year}-${month}-01`;
    const to   = req.query.to   || `${year}-${month}-31`;

    if (!DATE_RE.test(from) || !DATE_RE.test(to))
      return res.status(400).json({ error: 'from/to müssen YYYY-MM-DD sein', code: 400 });

    let sql = `
      SELECT e.*,
             u_assigned.display_name AS assigned_name,
             u_assigned.avatar_color AS assigned_color,
             u_created.display_name  AS creator_name,
             -- Name UND geerbte Farbe kommen aus zwei Toepfen: CalDAV/Google
             -- ueber calendar_ref_id, ICS-Abos ueber subscription_id (sie haben
             -- keinen external_calendars-Eintrag). Beide sind dasselbe - eine
             -- Eigenschaft, die fuer JEDEN Termin der Quelle gilt (#891).
             --
             -- DER NAME FOLGTE DER FARBE ERST NICHT (#1064): er las allein
             -- ec.name und blieb damit bei jedem Abo-Termin NULL, waehrend die
             -- Zeile darunter dessen Farbe laengst auslieferte. Der Termin trug
             -- sichtbar die Farbe seiner Quelle und konnte sie nirgends nennen.
             COALESCE(ec.name, isub.name)   AS cal_name,
             COALESCE(ec.color, isub.color) AS cal_color,
             ${SOURCE_CALENDAR_COLUMNS},
             COALESCE(bd.name, nd.name) AS birthday_name,
             bd.birth_date AS birthday_date,
             nd.name_day   AS name_day,
             CASE WHEN nd.id IS NOT NULL THEN 'name_day'
                  WHEN bd.id IS NOT NULL THEN 'birthday' END AS birthday_event_kind,
             ${ASSIGNED_USERS_SQL}
      FROM calendar_events e
      LEFT JOIN users u_assigned ON u_assigned.id = e.assigned_to
      LEFT JOIN users u_created  ON u_created.id  = e.created_by
      LEFT JOIN external_calendars ec ON ec.id = e.calendar_ref_id
      ${SOURCE_CALENDAR_JOIN}
      LEFT JOIN ics_subscriptions isub ON isub.id = e.subscription_id
      LEFT JOIN birthdays bd ON bd.calendar_event_id = e.id
      LEFT JOIN birthdays nd ON nd.name_day_calendar_event_id = e.id
      WHERE (
        (e.recurrence_rule IS NULL AND
          DATE(e.start_datetime) <= ? AND
          (e.end_datetime IS NULL OR DATE(e.end_datetime) >= ?))
        OR
        (e.recurrence_rule IS NOT NULL AND DATE(e.start_datetime) <= ?)
      )
      AND (
        e.external_source <> 'ics'
        OR e.subscription_id IN (
          SELECT id FROM ics_subscriptions WHERE shared = 1 OR created_by = ?
        )
      )
    `;
    const params = [to, from, to, getUserId(req)];

    // Sichtbarkeit (#474): eigene + für alle sichtbare + zugewiesene-sichtbare.
    sql += ` AND ${visibilityWhere('e', 'event_assignments', 'event_id')}`;
    params.push(getUserId(req), getUserId(req));

    if (req.query.assigned_to) {
      sql += ' AND EXISTS (SELECT 1 FROM event_assignments ea WHERE ea.event_id = e.id AND ea.user_id = ?)';
      params.push(parseInt(req.query.assigned_to, 10));
    }

    if (req.query.source && VALID_SOURCES.includes(req.query.source)) {
      sql += ' AND e.external_source = ?';
      params.push(req.query.source);
    }

    sql += ' ORDER BY e.start_datetime ASC, e.all_day DESC';

    const database = db.get();
    const rawEvents = database.prepare(sql).all(...params);
    const serialization = {
      database,
      actorId: getUserId(req),
      isAdmin: isAdminUser(req),
    };
    const events = serializeEvents(
      expandAndResolveEventRows(database, rawEvents, from, to),
      serialization,
    );
    res.json({ data: events, from, to });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/calendar/upcoming
// Nächste N Termine ab jetzt (für Dashboard-Widget).
// Query: ?limit=5
// Response: { data: Event[] }
// --------------------------------------------------------
router.get('/upcoming', (req, res) => {
  try {
    const limit    = Math.min(parseInt(req.query.limit, 10) || 5, 20);
    const database = db.get();
    const expanded = serializeEvents(hydrateEventAttachmentBodies(
      database,
      getUpcomingEvents(database, { userId: getUserId(req), limit }),
    ), {
      database,
      actorId: getUserId(req),
      isAdmin: isAdminUser(req),
    });

    res.json({ data: expanded });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/calendar/search?q=<query>
// Termin-Suche über den FTS-Index (Titel, Beschreibung, Ort) — datumsunabhängig,
// über den geladenen Zeitraum hinaus (#471). Liefert dieselbe serialisierte
// Event-Form wie GET / (inkl. cal_name/assigned_users), damit die Agenda-Zeilen
// direkt gerendert werden können. Sichtbarkeit deckt sich mit der Listenansicht:
// alle Familientermine, ICS nur aus geteilten/eigenen Abos. Vor /:id registriert.
// Response: { data: Event[] }
// --------------------------------------------------------
router.get('/search', (req, res) => {
  try {
    const match = buildMatchQuery(req.query.q ?? '');
    if (!match) return res.json({ data: [], total: 0 });

    const userId = getUserId(req);
    const LIMIT  = 100;
    // Sichtbarkeit deckt sich mit GET / (alle Familientermine; ICS nur aus
    // geteilten/eigenen Abos). Als Fragment wiederverwendet für Count + Liste.
    const whereSql = `
      s.entity = 'event' AND s.search_index MATCH @match
      AND (
        e.external_source <> 'ics'
        OR e.subscription_id IN (
          SELECT id FROM ics_subscriptions WHERE shared = 1 OR created_by = @userId
        )
      )
      AND ${visibilityWhere('e', 'event_assignments', 'event_id', '@userId')}`;

    const total = db.get().prepare(`
      SELECT COUNT(*) AS n
      FROM search_index s
      JOIN calendar_events e ON e.id = s.entity_id
      WHERE ${whereSql}
    `).get({ match, userId }).n;

    const rows = db.get().prepare(`
      SELECT e.*,
             u_assigned.display_name AS assigned_name,
             u_assigned.avatar_color AS assigned_color,
             u_created.display_name  AS creator_name,
             -- Name UND geerbte Farbe kommen aus zwei Toepfen: CalDAV/Google
             -- ueber calendar_ref_id, ICS-Abos ueber subscription_id (sie haben
             -- keinen external_calendars-Eintrag). Beide sind dasselbe - eine
             -- Eigenschaft, die fuer JEDEN Termin der Quelle gilt (#891).
             --
             -- DER NAME FOLGTE DER FARBE ERST NICHT (#1064): er las allein
             -- ec.name und blieb damit bei jedem Abo-Termin NULL, waehrend die
             -- Zeile darunter dessen Farbe laengst auslieferte. Der Termin trug
             -- sichtbar die Farbe seiner Quelle und konnte sie nirgends nennen.
             COALESCE(ec.name, isub.name)   AS cal_name,
             COALESCE(ec.color, isub.color) AS cal_color,
             ${SOURCE_CALENDAR_COLUMNS},
             COALESCE(bd.name, nd.name) AS birthday_name,
             bd.birth_date AS birthday_date,
             nd.name_day   AS name_day,
             CASE WHEN nd.id IS NOT NULL THEN 'name_day'
                  WHEN bd.id IS NOT NULL THEN 'birthday' END AS birthday_event_kind,
             ${ASSIGNED_USERS_SQL}
      FROM search_index s
      JOIN calendar_events e ON e.id = s.entity_id
      LEFT JOIN users u_assigned ON u_assigned.id = e.assigned_to
      LEFT JOIN users u_created  ON u_created.id  = e.created_by
      LEFT JOIN external_calendars ec ON ec.id = e.calendar_ref_id
      ${SOURCE_CALENDAR_JOIN}
      LEFT JOIN ics_subscriptions isub ON isub.id = e.subscription_id
      LEFT JOIN birthdays bd ON bd.calendar_event_id = e.id
      LEFT JOIN birthdays nd ON nd.name_day_calendar_event_id = e.id
      WHERE ${whereSql}
      ORDER BY e.start_datetime ASC
      LIMIT @limit
    `).all({ match, userId, limit: LIMIT });

    // Wiederkehrende Treffer auf die nächste Instanz ab heute auflösen (statt des
    // Serienstarts, der Jahre zurückliegen kann). Findet die Serie im 1-Jahres-
    // Fenster keine kommende Instanz, bleibt der Master-Termin unverändert (#471).
    const today  = todayKey(db.get());
    // 2-Jahres-Fenster: fängt auch Serien, deren nächste Instanz mehr als ein Jahr
    // voraus liegt (z. B. mehrjährige Intervalle). Findet sich keine, bleibt der Master.
    const future = shiftDateKey(today, 730);
    const database = db.get();
    const resolved = resolveEventSearchRows(database, rows, today, future);

    res.json({
      data: serializeEvents(resolved, {
        database,
        actorId: userId,
        isAdmin: isAdminUser(req),
      }),
      total,
    });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

export default router;
