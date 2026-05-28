/**
 * Modul: Kalender (Calendar)
 * Zweck: REST-API-Routen für Kalendereinträge (lokale Termine)
 *        Externe Sync (Google/Apple) folgt in Phase 3, Schritte 14–15.
 * Abhängigkeiten: express, server/db.js, server/auth.js
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import * as googleCalendar from '../services/google-calendar.js';
import * as appleCalendar from '../services/apple-calendar.js';
import * as icsSubscription from '../services/ics-subscription.js';
import * as caldavSync from '../services/caldav-sync.js';
import { requireAdmin } from '../auth.js';
import { str, color, datetime, rrule, collectErrors, MAX_TITLE, MAX_TEXT, DATE_RE, DATETIME_RE } from '../middleware/validate.js';
import { nextOccurrence } from '../services/recurrence.js';

const log = createLogger('Calendar');

const router         = express.Router();

const VALID_SOURCES  = ['local', 'google', 'apple', 'ics'];
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const DEFAULT_ATTACHMENT_FOLDER = 'Calendar items';
const ATTACHMENT_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const ICS_COLOR_RE   = /^#[0-9a-fA-F]{6}$/;
const VALID_EVENT_ICONS = new Set([
  'calendar', 'tooth', 'drill', 'alarm-clock', 'clock', 'bell', 'map-pin', 'home',
  'house', 'building', 'hospital', 'stethoscope', 'syringe', 'pill',
  'tablets', 'bandage', 'ambulance', 'heart-pulse', 'activity', 'cross',
  'scissors', 'shower-head', 'dumbbell', 'trophy', 'car', 'bus', 'train',
  'tram-front', 'plane', 'plane-takeoff', 'fuel', 'parking-meter',
  'traffic-cone', 'navigation', 'bike', 'route', 'briefcase', 'laptop', 'monitor',
  'presentation', 'school', 'graduation-cap', 'book-open', 'library',
  'pencil', 'notebook-pen', 'calculator', 'utensils', 'cooking-pot',
  'coffee', 'cake', 'croissant', 'pizza', 'ice-cream', 'beer', 'wine',
  'popcorn', 'sandwich', 'salad', 'shopping-bag', 'shopping-cart', 'gift',
  'package', 'shirt', 'tag', 'credit-card', 'wallet', 'banknote', 'coins',
  'piggy-bank', 'receipt', 'landmark', 'music', 'guitar', 'film', 'theater',
  'ticket', 'gamepad-2', 'camera', 'party-popper', 'users', 'baby', 'dog',
  'cat', 'paw-print', 'wrench', 'hammer', 'paintbrush', 'lightbulb', 'sofa',
  'bed', 'bath', 'washing-machine', 'refrigerator', 'star', 'flag', 'target',
  'flame', 'leaf', 'tree-pine', 'flower', 'sun', 'moon', 'cloud-sun',
]);

function getUserId(req) {
  const candidates = [req.authUserId, req.user?.id, req.session?.userId];
  for (const value of candidates) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function isAdminUser(req) {
  return req.authRole === 'admin' || req.session?.isAdmin === true || req.session?.role === 'admin';
}

function eventIcon(value) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : 'calendar';
  const icon = raw === 'drill' ? 'tooth' : raw;
  return VALID_EVENT_ICONS.has(icon) ? icon : null;
}

function parseAttachment(dataUrl) {
  const raw = typeof dataUrl === 'string' ? dataUrl.trim() : '';
  if (!raw) return { name: null, mime: null, size: null, data: null };
  const match = raw.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) throw new Error('attachment_data: ungültiges Dateiformat.');
  const mime = match[1].toLowerCase();
  if (!ATTACHMENT_MIME.has(mime)) throw new Error('attachment_data: Dateityp nicht erlaubt.');
  const base64 = match[2].replace(/\s/g, '');
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw new Error('attachment_data: Datei ist leer.');
  if (buffer.length > MAX_ATTACHMENT_BYTES) throw new Error('attachment_data: Datei darf höchstens 5 MB groß sein.');
  return { name: null, mime, size: buffer.length, data: base64 };
}

function ensureDocumentFolder(database, name, actorId) {
  const folderName = typeof name === 'string' ? name.trim() : '';
  if (!folderName) return null;
  const existing = database.prepare('SELECT id FROM family_document_folders WHERE name = ? COLLATE NOCASE').get(folderName);
  if (existing) return existing.id;
  const result = database.prepare('INSERT INTO family_document_folders (name, created_by) VALUES (?, ?)').run(folderName, actorId);
  return result.lastInsertRowid;
}

function createAttachmentDocument(database, attachment, body, actorId) {
  if (!attachment?.data) return null;
  const originalName = String(body.attachment_name || 'Attachment').trim() || 'Attachment';
  const folderId = ensureDocumentFolder(database, body.document_folder_name || DEFAULT_ATTACHMENT_FOLDER, actorId);
  const result = database.prepare(`
    INSERT INTO family_documents
      (name, description, category, visibility, folder_id, original_name, mime_type, file_size, content_data, created_by)
    VALUES (?, ?, 'other', 'family', ?, ?, ?, ?, ?, ?)
  `).run(
    body.document_name || originalName.replace(/\.[^.]+$/, ''),
    body.document_description || null,
    folderId,
    originalName,
    attachment.mime,
    attachment.size,
    attachment.data,
    actorId,
  );
  return result.lastInsertRowid;
}

function attachmentDataUrl(event) {
  if (!event?.attachment_data) return event?.attachment_data ?? null;
  if (String(event.attachment_data).startsWith('data:')) return event.attachment_data;
  if (!event.attachment_mime) return event.attachment_data;
  return `data:${event.attachment_mime};base64,${event.attachment_data}`;
}

const ASSIGNED_USERS_SQL = `(
  SELECT json_group_array(json_object(
    'id', u.id, 'display_name', u.display_name, 'color', u.avatar_color
  ))
  FROM event_assignments ea JOIN users u ON u.id = ea.user_id
  WHERE ea.event_id = e.id
) AS assigned_users_json`;

function parseAssignedTo(val) {
  if (Array.isArray(val)) return val.map(Number).filter(Boolean);
  if (val !== null && val !== undefined && val !== '') return [Number(val)].filter(Boolean);
  return [];
}

function setEventAssignments(d, eventId, userIds) {
  d.prepare('DELETE FROM event_assignments WHERE event_id = ?').run(eventId);
  const ins = d.prepare('INSERT OR IGNORE INTO event_assignments (event_id, user_id) VALUES (?, ?)');
  for (const uid of userIds) ins.run(eventId, uid);
}

function serializeEvent(event) {
  if (!event) return event;
  const assigned_users = event.assigned_users_json ? JSON.parse(event.assigned_users_json) : [];
  const { assigned_users_json, ...rest } = event;
  return {
    ...rest,
    assigned_users,
    attachment_data: attachmentDataUrl(event),
  };
}

// --------------------------------------------------------
// RRULE-Expansion: alle Vorkommen eines wiederkehrenden Events
// innerhalb [from, to] generieren (inklusive beider Grenzen).
// --------------------------------------------------------

/**
 * @param {object[]} events  Rohe DB-Events (können recurrence_rule haben)
 * @param {string}   from    YYYY-MM-DD
 * @param {string}   to      YYYY-MM-DD
 * @returns {object[]}  Expandiertes, sortiertes Array
 */
function expandRecurringEvents(events, from, to) {
  const result = [];

  for (const event of events) {
    if (!event.recurrence_rule) {
      result.push(event);
      continue;
    }

    // Dauer des Events in ms (für End-Zeit-Berechnung der Instanzen)
    const startMs    = new Date(event.start_datetime).getTime();
    const endMs      = event.end_datetime ? new Date(event.end_datetime).getTime() : null;
    const durationMs = endMs !== null ? endMs - startMs : null;
    // Duration in days for all-day events (for date-only end calculation)
    const isAllDay     = !!event.all_day;
    const durationDays = isAllDay && durationMs !== null ? Math.round(durationMs / 86400000) : 0;

    // Original-Zeit-Teil erhalten (z.B. 'T14:30:00' oder '' bei All-Day)
    const timeSuffix = event.start_datetime.slice(10);

    let currentDate = event.start_datetime.slice(0, 10); // YYYY-MM-DD
    let iterations  = 0;
    const MAX_ITER  = 1000; // Sicherheitsgrenze

    while (currentDate <= to && iterations < MAX_ITER) {
      iterations++;

      // For multi-day events, check if the instance end reaches into [from, to]
      let instanceEnd = currentDate;
      if (isAllDay && durationDays > 0) {
        const d = new Date(currentDate + 'T00:00:00');
        d.setDate(d.getDate() + durationDays);
        instanceEnd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }

      if (currentDate >= from || instanceEnd >= from) {
        const newStart = currentDate + timeSuffix;
        let newEnd = event.end_datetime;
        if (durationMs !== null) {
          if (isAllDay) {
            // Keep date-only format for all-day events
            const d = new Date(currentDate + 'T00:00:00');
            d.setDate(d.getDate() + durationDays);
            newEnd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          } else {
            const endDate = new Date(new Date(newStart).getTime() + durationMs);
            if (timeSuffix.includes('Z')) {
              newEnd = endDate.toISOString().replace('.000Z', 'Z');
            } else {
              const p = n => String(n).padStart(2, '0');
              newEnd = `${endDate.getFullYear()}-${p(endDate.getMonth() + 1)}-${p(endDate.getDate())}T${p(endDate.getHours())}:${p(endDate.getMinutes())}`;
            }
          }
        }

        result.push({
          ...event,
          start_datetime:       newStart,
          end_datetime:         newEnd,
          is_recurring_instance: currentDate !== event.start_datetime.slice(0, 10) ? 1 : 0,
        });
      }

      const next = nextOccurrence(currentDate, event.recurrence_rule);
      if (!next || next <= currentDate) break;
      currentDate = next;
    }
  }

  return result.sort((a, b) => a.start_datetime.localeCompare(b.start_datetime));
}

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
    const today = new Date().toISOString().slice(0, 10);
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
             ec.name  AS cal_name,
             ec.color AS cal_color,
             ${ASSIGNED_USERS_SQL}
      FROM calendar_events e
      LEFT JOIN users u_assigned ON u_assigned.id = e.assigned_to
      LEFT JOIN users u_created  ON u_created.id  = e.created_by
      LEFT JOIN external_calendars ec ON ec.id = e.calendar_ref_id
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

    if (req.query.assigned_to) {
      sql += ' AND EXISTS (SELECT 1 FROM event_assignments ea WHERE ea.event_id = e.id AND ea.user_id = ?)';
      params.push(parseInt(req.query.assigned_to, 10));
    }

    if (req.query.source && VALID_SOURCES.includes(req.query.source)) {
      sql += ' AND e.external_source = ?';
      params.push(req.query.source);
    }

    sql += ' ORDER BY e.start_datetime ASC, e.all_day DESC';

    const rawEvents = db.get().prepare(sql).all(...params);
    const events    = expandRecurringEvents(rawEvents, from, to).map(serializeEvent);
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
    const limit   = Math.min(parseInt(req.query.limit, 10) || 5, 20);
    const nowDate = new Date().toISOString().slice(0, 10);
    // Fenster: heute bis 90 Tage voraus (für Wiederholungs-Expansion)
    const future  = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const rawEvents = db.get().prepare(`
      SELECT e.*,
             u_assigned.display_name AS assigned_name,
             u_assigned.avatar_color AS assigned_color,
             ec.name  AS cal_name,
             ec.color AS cal_color,
             ${ASSIGNED_USERS_SQL}
      FROM calendar_events e
      LEFT JOIN users u_assigned ON u_assigned.id = e.assigned_to
      LEFT JOIN external_calendars ec ON ec.id = e.calendar_ref_id
      WHERE (
        (e.recurrence_rule IS NULL AND DATE(e.start_datetime) BETWEEN ? AND ?)
        OR
        (e.recurrence_rule IS NOT NULL AND DATE(e.start_datetime) <= ?)
      )
      AND (
        e.external_source <> 'ics'
        OR e.subscription_id IN (
          SELECT id FROM ics_subscriptions WHERE shared = 1 OR created_by = ?
        )
      )
      ORDER BY e.start_datetime ASC
    `).all(nowDate, future, future, getUserId(req));

    const expanded = expandRecurringEvents(rawEvents, nowDate, future)
      .filter((e) => e.start_datetime >= new Date().toISOString())
      .slice(0, limit)
      .map(serializeEvent);

    res.json({ data: expanded });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// --------------------------------------------------------
// Google Calendar Sync-Routen
// Alle vor /:id registriert, um Konflikte zu vermeiden.
// --------------------------------------------------------

/**
 * GET /api/v1/calendar/google/auth
 * Admin only. Leitet zum Google OAuth-Consent-Screen weiter.
 */
router.get('/google/auth', requireAdmin, (req, res) => {
  try {
    const url = googleCalendar.getAuthUrl(req.session);
    if (!url) return res.status(503).json({ error: 'Google nicht konfiguriert.', code: 503 });
    res.redirect(url);
  } catch (err) {
    log.error('', err);
    res.status(503).json({ error: err.message, code: 503 });
  }
});

/**
 * GET /api/v1/calendar/google/callback
 * OAuth-Callback von Google. Tauscht Code gegen Tokens und startet initialen Sync.
 * Query: ?code=...
 */
router.get('/google/callback', async (req, res) => {
  try {
    const { code, error, state } = req.query;
    if (error) return res.redirect('/settings?sync_error=google');
    if (!code)  return res.status(400).json({ error: 'Kein Code erhalten.', code: 400 });

    // OAuth CSRF-Schutz: state-Parameter validieren
    if (!state || !req.session.googleOAuthState || state !== req.session.googleOAuthState) {
      log.error('OAuth state mismatch');
      return res.redirect('/settings?sync_error=google');
    }
    delete req.session.googleOAuthState;

    await googleCalendar.handleCallback(code);
    await googleCalendar.sync();

    res.redirect('/settings?sync_ok=google');
  } catch (err) {
    log.error('', err);
    res.redirect('/settings?sync_error=google');
  }
});

/**
 * POST /api/v1/calendar/google/sync
 * Manueller Sync-Trigger.
 * Response: { ok: true, lastSync: string }
 */
router.post('/google/sync', requireAdmin, async (req, res) => {
  try {
    await googleCalendar.sync();
    const { lastSync } = googleCalendar.getStatus();
    res.json({ ok: true, lastSync });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: err.message, code: 500 });
  }
});

/**
 * GET /api/v1/calendar/google/status
 * Response: { configured, connected, lastSync }
 */
router.get('/google/status', (req, res) => {
  try {
    res.json(googleCalendar.getStatus());
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * DELETE /api/v1/calendar/google/disconnect
 * Admin only. Tokens löschen und Verbindung trennen.
 * Response: { ok: true }
 */
router.delete('/google/disconnect', requireAdmin, (req, res) => {
  try {
    googleCalendar.disconnect();
    res.json({ ok: true });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// --------------------------------------------------------
// Apple Calendar Sync-Routen
// --------------------------------------------------------

/**
 * GET /api/v1/calendar/apple/status
 * Response: { configured, lastSync }
 */
router.get('/apple/status', (req, res) => {
  try {
    res.json(appleCalendar.getStatus());
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * POST /api/v1/calendar/apple/sync
 * Manueller Sync-Trigger.
 * Response: { ok: true, lastSync: string }
 */
router.post('/apple/sync', requireAdmin, async (req, res) => {
  try {
    await appleCalendar.sync();
    const { lastSync } = appleCalendar.getStatus();
    res.json({ ok: true, lastSync });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: err.message, code: 500 });
  }
});

/**
 * POST /api/v1/calendar/apple/connect
 * Apple-CalDAV-Credentials speichern und Verbindung testen.
 * Body: { url, username, password }
 * Response: { ok: true, calendarCount: number }
 */
router.post('/apple/connect', requireAdmin, async (req, res) => {
  const { url, username, password } = req.body;
  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({ error: 'url muss eine gültige HTTP(S)-URL sein.', code: 400 });
  }
  if (!username || typeof username !== 'string' || username.length > 254) {
    return res.status(400).json({ error: 'username fehlt oder ungültig.', code: 400 });
  }
  if (!password || typeof password !== 'string' || password.length < 1) {
    return res.status(400).json({ error: 'password fehlt.', code: 400 });
  }

  try {
    // Zuerst temporär setzen, damit testConnection() sie findet
    appleCalendar.saveCredentials(url.trim(), username.trim(), password);
    const result = await appleCalendar.testConnection();
    res.json({ ok: true, calendarCount: result.calendarCount });
  } catch (err) {
    // Bei Fehler: gespeicherte Credentials wieder löschen
    appleCalendar.clearCredentials();
    log.error('', err);
    res.status(400).json({ error: err.message.replace('[Apple] ', ''), code: 400 });
  }
});

/**
 * DELETE /api/v1/calendar/apple/disconnect
 * Apple-CalDAV-Credentials löschen.
 * Response: 204
 */
router.delete('/apple/disconnect', requireAdmin, (req, res) => {
  try {
    appleCalendar.clearCredentials();
    res.status(204).end();
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// --------------------------------------------------------
// ICS Subscription-Routen
// Müssen vor /:id registriert werden, um Konflikte zu vermeiden.
// --------------------------------------------------------

router.get('/subscriptions', (req, res) => {
  try {
    const subs = icsSubscription.getAll(getUserId(req));
    res.json({ data: subs });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

router.post('/subscriptions', async (req, res) => {
  try {
    const { name, url, color: colorVal, shared } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length === 0 || name.length > 100)
      return res.status(400).json({ error: 'name: Pflichtfeld, max. 100 Zeichen.', code: 400 });
    if (!url || typeof url !== 'string')
      return res.status(400).json({ error: 'url: Pflichtfeld.', code: 400 });
    try { const u = new URL(url.replace(/^webcal:\/\//i, 'https://')); if (!['https:'].includes(u.protocol)) throw new Error(); }
    catch { return res.status(400).json({ error: 'url: Nur https:// und webcal:// sind erlaubt.', code: 400 }); }
    if (!colorVal || !ICS_COLOR_RE.test(colorVal))
      return res.status(400).json({ error: 'color: Pflichtfeld, muss #RRGGBB sein.', code: 400 });

    const { sub, syncError } = await icsSubscription.create(getUserId(req), {
      name: name.trim(), url, color: colorVal, shared: shared ? 1 : 0,
    });
    res.status(201).json({ data: sub, syncError: syncError || null });
  } catch (err) {
    log.error('', err);
    if (err.message?.includes('Nur https')) return res.status(400).json({ error: err.message, code: 400 });
    if (err.message?.includes('private IP')) return res.status(400).json({ error: err.message, code: 400 });
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

router.patch('/subscriptions/:id', (req, res) => {
  try {
    const subId   = parseInt(req.params.id, 10);
    if (!Number.isFinite(subId)) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });
    const isAdmin = isAdminUser(req);
    const fields  = {};
    if (req.body.name  !== undefined) {
      if (typeof req.body.name !== 'string' || req.body.name.trim().length === 0 || req.body.name.length > 100)
        return res.status(400).json({ error: 'name: max. 100 Zeichen, darf nicht leer sein.', code: 400 });
      fields.name = req.body.name.trim();
    }
    if (req.body.color !== undefined) {
      if (!ICS_COLOR_RE.test(req.body.color))
        return res.status(400).json({ error: 'color: muss #RRGGBB sein.', code: 400 });
      fields.color = req.body.color;
    }
    if (req.body.shared !== undefined) fields.shared = req.body.shared;

    const updated = icsSubscription.update(getUserId(req), subId, fields, isAdmin);
    if (!updated) return res.status(404).json({ error: 'Abonnement nicht gefunden.', code: 404 });
    res.json({ data: updated });
  } catch (err) {
    if (err.message === 'Nicht autorisiert.') return res.status(403).json({ error: err.message, code: 403 });
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

router.delete('/subscriptions/:id', (req, res) => {
  try {
    const subId   = parseInt(req.params.id, 10);
    if (!Number.isFinite(subId)) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });
    const isAdmin = isAdminUser(req);
    const ok      = icsSubscription.remove(getUserId(req), subId, isAdmin);
    if (!ok) return res.status(404).json({ error: 'Abonnement nicht gefunden.', code: 404 });
    res.status(204).end();
  } catch (err) {
    if (err.message === 'Nicht autorisiert.') return res.status(403).json({ error: err.message, code: 403 });
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

router.post('/subscriptions/:id/sync', async (req, res) => {
  try {
    const subId   = parseInt(req.params.id, 10);
    if (!Number.isFinite(subId)) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });
    const isAdmin = isAdminUser(req);
    const sub     = db.get().prepare('SELECT * FROM ics_subscriptions WHERE id = ?').get(subId);
    if (!sub) return res.status(404).json({ error: 'Abonnement nicht gefunden.', code: 404 });
    if (!isAdmin && sub.created_by !== getUserId(req))
      return res.status(403).json({ error: 'Nicht autorisiert.', code: 403 });
    await icsSubscription.sync(subId);
    const updated = db.get().prepare('SELECT * FROM ics_subscriptions WHERE id = ?').get(subId);
    res.json({ data: updated });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/calendar/:id
// Einzelnen Termin abrufen.
// Response: { data: Event }
// --------------------------------------------------------
router.get('/:id', (req, res) => {
  try {
    const id    = parseInt(req.params.id, 10);
    const event = db.get().prepare(`
      SELECT e.*,
             u_assigned.display_name AS assigned_name,
             u_assigned.avatar_color AS assigned_color,
             u_created.display_name  AS creator_name,
             ${ASSIGNED_USERS_SQL}
      FROM calendar_events e
      LEFT JOIN users u_assigned ON u_assigned.id = e.assigned_to
      LEFT JOIN users u_created  ON u_created.id  = e.created_by
      WHERE e.id = ?
    `).get(id);

    if (!event) return res.status(404).json({ error: 'Termin nicht gefunden', code: 404 });
    res.json({ data: serializeEvent(event) });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/calendar
// Neuen Termin anlegen.
// Body: { title, description?, start_datetime, end_datetime?,
//         all_day?, location?, color?, icon?, assigned_to?,
//         recurrence_rule? }
// Response: { data: Event }
// --------------------------------------------------------
router.post('/', (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      log.warn('Rejecting calendar create without resolved authenticated user id', {
        authMethod: req.authMethod || null,
        authUserId: req.authUserId || null,
        reqUserId: req.user?.id || null,
        sessionUserId: req.session?.userId || null,
      });
      return res.status(401).json({ error: 'Not authenticated.', code: 401 });
    }

    const vTitle = str(req.body.title, 'Titel', { max: MAX_TITLE });
    const vDesc  = str(req.body.description, 'Beschreibung', { max: MAX_TEXT, required: false });
    const vStart = datetime(req.body.start_datetime, 'Startdatum', true);
    const vEnd   = datetime(req.body.end_datetime, 'Enddatum');
    const vColor = color(req.body.color || '#007AFF', 'Farbe');
    const vIcon  = eventIcon(req.body.icon);
    const vLoc   = str(req.body.location, 'Ort', { max: MAX_TITLE, required: false });
    const vRrule = rrule(req.body.recurrence_rule, 'Wiederholung');
    const errors = collectErrors([vTitle, vDesc, vStart, vEnd, vColor, vLoc, vRrule]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    if (!vIcon) return res.status(400).json({ error: 'icon: invalid calendar event icon.', code: 400 });

    const { all_day = 0 } = req.body;
    const userIds  = parseAssignedTo(req.body.assigned_to);
    const firstUid = userIds[0] ?? null;

    const attachment = req.body.attachment_data ? parseAttachment(req.body.attachment_data) : { mime: null, size: null, data: null };

    const eventId = db.get().transaction(() => {
      const documentId = createAttachmentDocument(db.get(), attachment, req.body, userId);
      const result = db.get().prepare(`
        INSERT INTO calendar_events
          (title, description, start_datetime, end_datetime, all_day,
           location, color, icon, assigned_to, created_by, recurrence_rule,
           attachment_name, attachment_mime, attachment_size, attachment_data, attachment_document_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        vTitle.value, vDesc.value,
        vStart.value, vEnd.value,
        all_day ? 1 : 0, vLoc.value,
        vColor.value, vIcon, firstUid,
        userId, vRrule.value,
        req.body.attachment_name || null,
        attachment.mime,
        attachment.size,
        attachment.data,
        documentId
      );
      setEventAssignments(db.get(), result.lastInsertRowid, userIds);
      return result.lastInsertRowid;
    })();

    const event = db.get().prepare(`
      SELECT e.*,
             u_assigned.display_name AS assigned_name,
             u_assigned.avatar_color AS assigned_color,
             u_created.display_name  AS creator_name,
             ${ASSIGNED_USERS_SQL}
      FROM calendar_events e
      LEFT JOIN users u_assigned ON u_assigned.id = e.assigned_to
      LEFT JOIN users u_created  ON u_created.id  = e.created_by
      WHERE e.id = ?
    `).get(eventId);

    res.status(201).json({ data: serializeEvent(event) });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// --------------------------------------------------------
// PUT /api/v1/calendar/:id
// Termin vollständig aktualisieren.
// Body: alle Felder optional außer title + start_datetime
// Response: { data: Event }
// --------------------------------------------------------
router.put('/:id', (req, res) => {
  try {
    const id    = parseInt(req.params.id, 10);
    const event = db.get().prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
    if (!event) return res.status(404).json({ error: 'Termin nicht gefunden', code: 404 });

    const checks = [];
    if (req.body.title          !== undefined) checks.push(str(req.body.title, 'Titel', { max: MAX_TITLE, required: false }));
    if (req.body.description    !== undefined) checks.push(str(req.body.description, 'Beschreibung', { max: MAX_TEXT, required: false }));
    if (req.body.start_datetime !== undefined) checks.push(datetime(req.body.start_datetime, 'Startdatum'));
    if (req.body.end_datetime   !== undefined) checks.push(datetime(req.body.end_datetime, 'Enddatum'));
    if (req.body.color          !== undefined) checks.push(color(req.body.color, 'Farbe'));
    if (req.body.location       !== undefined) checks.push(str(req.body.location, 'Ort', { max: MAX_TITLE, required: false }));
    if (req.body.recurrence_rule !== undefined) checks.push(rrule(req.body.recurrence_rule, 'Wiederholung'));
    const errors = collectErrors(checks);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    const vIcon = req.body.icon !== undefined ? eventIcon(req.body.icon) : event.icon;
    if (!vIcon) return res.status(400).json({ error: 'icon: invalid calendar event icon.', code: 400 });
    const attachment = req.body.attachment_data !== undefined
      ? (req.body.attachment_data ? parseAttachment(req.body.attachment_data) : { mime: null, size: null, data: null })
      : {
          mime: event.attachment_mime,
          size: event.attachment_size,
          data: event.attachment_data,
        };

    const {
      title, description, start_datetime, end_datetime,
      all_day, location, color: colorVal, recurrence_rule, attachment_name,
    } = req.body;

    const userIds  = req.body.assigned_to !== undefined
      ? parseAssignedTo(req.body.assigned_to)
      : db.get().prepare('SELECT user_id FROM event_assignments WHERE event_id = ?')
          .all(id).map((r) => r.user_id);
    const firstUid = userIds[0] ?? null;

    const userModified = event.external_source !== 'local' ? 1 : event.user_modified;

    db.get().transaction(() => {
      const documentId = req.body.attachment_data
        ? createAttachmentDocument(db.get(), attachment, req.body, event.created_by)
        : event.attachment_document_id;
      db.get().prepare(`
        UPDATE calendar_events
        SET title           = COALESCE(?, title),
            description     = ?,
            start_datetime  = COALESCE(?, start_datetime),
            end_datetime    = ?,
            all_day         = COALESCE(?, all_day),
            location        = ?,
            color           = COALESCE(?, color),
            icon            = COALESCE(?, icon),
            assigned_to     = ?,
            recurrence_rule = ?,
            attachment_name = ?,
            attachment_mime  = ?,
            attachment_size  = ?,
            attachment_data  = ?,
            attachment_document_id = ?,
            user_modified   = ?
        WHERE id = ?
      `).run(
        title?.trim()  ?? null,
        description !== undefined ? (description || null) : event.description,
        start_datetime ?? null,
        end_datetime !== undefined ? (end_datetime || null) : event.end_datetime,
        all_day !== undefined ? (all_day ? 1 : 0) : null,
        location !== undefined ? (location || null) : event.location,
        colorVal ?? null,
        req.body.icon !== undefined ? vIcon : null,
        firstUid !== undefined ? firstUid : event.assigned_to,
        recurrence_rule !== undefined ? (recurrence_rule || null) : event.recurrence_rule,
        attachment_name !== undefined ? (attachment_name || null) : event.attachment_name,
        attachment.mime,
        attachment.size,
        attachment.data,
        documentId,
        userModified,
        id
      );
      setEventAssignments(db.get(), id, userIds);
    })();

    const updated = db.get().prepare(`
      SELECT e.*,
             u_assigned.display_name AS assigned_name,
             u_assigned.avatar_color AS assigned_color,
             u_created.display_name  AS creator_name,
             ${ASSIGNED_USERS_SQL}
      FROM calendar_events e
      LEFT JOIN users u_assigned ON u_assigned.id = e.assigned_to
      LEFT JOIN users u_created  ON u_created.id  = e.created_by
      WHERE e.id = ?
    `).get(id);

    res.json({ data: serializeEvent(updated) });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/calendar/:id/reset
// ICS-Event auf Original zurücksetzen (user_modified = 0).
// Nur Event-Creator, Subscription-Creator oder Admin.
// Response: { data: { reset: true } }
// --------------------------------------------------------
router.post('/:id/reset', (req, res) => {
  try {
    const id    = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });
    const event = db.get().prepare(`
      SELECT e.*, s.created_by AS sub_created_by
      FROM calendar_events e
      LEFT JOIN ics_subscriptions s ON s.id = e.subscription_id
      WHERE e.id = ?
    `).get(id);
    if (!event) return res.status(404).json({ error: 'Termin nicht gefunden', code: 404 });
    if (event.external_source !== 'ics')
      return res.status(400).json({ error: 'Nur ICS-Events können zurückgesetzt werden.', code: 400 });

    const userId  = getUserId(req);
    const isAdmin = isAdminUser(req);
    if (!isAdmin && event.created_by !== userId && event.sub_created_by !== userId)
      return res.status(403).json({ error: 'Nicht autorisiert.', code: 403 });

    db.get().prepare('UPDATE calendar_events SET user_modified = 0 WHERE id = ?').run(id);
    res.json({ data: { reset: true } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/calendar/:id
// Termin löschen.
// Response: 204 No Content
// --------------------------------------------------------
router.delete('/:id', (req, res) => {
  try {
    const id     = parseInt(req.params.id, 10);
    const result = db.get().prepare('DELETE FROM calendar_events WHERE id = ?').run(id);
    if (result.changes === 0)
      return res.status(404).json({ error: 'Termin nicht gefunden', code: 404 });
    res.status(204).end();
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// --------------------------------------------------------
// CalDAV Multi-Account Sync Routes
// --------------------------------------------------------

// Account Management

router.post('/caldav/accounts', requireAdmin, async (req, res) => {
  try {
    const { name, caldavUrl, username, password } = req.body;

    if (!name || !caldavUrl || !username || !password) {
      return res.status(400).json({ error: 'Missing required fields.', code: 400 });
    }

    const result = await caldavSync.addAccount(name, caldavUrl, username, password);
    res.json({ data: result });
  } catch (err) {
    log.error('CalDAV account creation failed:', err);
    res.status(500).json({ error: err.message || 'Failed to create CalDAV account.', code: 500 });
  }
});

router.get('/caldav/accounts', requireAdmin, (req, res) => {
  try {
    const accounts = caldavSync.listAccounts();
    res.json({ data: accounts });
  } catch (err) {
    log.error('CalDAV accounts list failed:', err);
    res.status(500).json({ error: 'Failed to list CalDAV accounts.', code: 500 });
  }
});

router.put('/caldav/accounts/:id', requireAdmin, async (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const { name, caldavUrl, username, password } = req.body;

    const result = await caldavSync.updateAccount(accountId, { name, caldavUrl, username, password });
    res.json({ data: result });
  } catch (err) {
    log.error('CalDAV account update failed:', err);
    res.status(500).json({ error: err.message || 'Failed to update CalDAV account.', code: 500 });
  }
});

router.delete('/caldav/accounts/:id', requireAdmin, (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const result = caldavSync.deleteAccount(accountId);
    res.json({ data: result });
  } catch (err) {
    log.error('CalDAV account deletion failed:', err);
    res.status(500).json({ error: err.message || 'Failed to delete CalDAV account.', code: 500 });
  }
});

// Calendar Selection

router.get('/caldav/accounts/:id/calendars', requireAdmin, async (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const refresh = req.query.refresh === 'true';

    const calendars = await caldavSync.getCalendars(accountId, { refresh });
    res.json({ data: calendars });
  } catch (err) {
    log.error('CalDAV calendars fetch failed:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch calendars.', code: 500 });
  }
});

router.patch('/caldav/accounts/:id/calendars', requireAdmin, (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const { calendarUrl, enabled } = req.body;

    if (!calendarUrl || enabled === undefined) {
      return res.status(400).json({ error: 'Missing calendarUrl or enabled field.', code: 400 });
    }

    const result = caldavSync.updateCalendarSelection(accountId, calendarUrl, enabled);
    res.json({ data: result });
  } catch (err) {
    log.error('CalDAV calendar selection update failed:', err);
    res.status(500).json({ error: err.message || 'Failed to update calendar selection.', code: 500 });
  }
});

// Sync & Status

router.post('/caldav/sync', requireAdmin, async (req, res) => {
  try {
    const result = await caldavSync.sync();
    res.json({ data: result });
  } catch (err) {
    log.error('CalDAV sync failed:', err);
    res.status(500).json({ error: 'CalDAV sync failed.', code: 500 });
  }
});

router.get('/caldav/status', (req, res) => {
  try {
    const status = caldavSync.getStatus();
    res.json({ data: status });
  } catch (err) {
    log.error('CalDAV status failed:', err);
    res.status(500).json({ error: 'Failed to get CalDAV status.', code: 500 });
  }
});

export default router;
