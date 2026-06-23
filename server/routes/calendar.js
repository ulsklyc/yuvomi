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
import * as icsExport from '../services/ics-export.js';
import * as caldavSync from '../services/caldav-sync.js';
import * as caldavReminders from '../services/caldav-reminders-sync.js';
import * as holidays from '../services/holidays.js';
import { requireAdmin } from '../auth.js';
import { str, color, datetime, rrule, collectErrors, MAX_TITLE, MAX_TEXT, DATE_RE, DATETIME_RE } from '../middleware/validate.js';
import { expandRecurringEvents, getUpcomingEvents } from '../services/calendar-events.js';
import {
  StorageError,
  cleanupStagedUpload,
  stageDocumentUpload,
} from '../services/document-storage.js';

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
  if (!raw) return { mime: null, size: null, buffer: null };
  const match = raw.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) throw new Error('attachment_data: ungültiges Dateiformat.');
  const mime = match[1].toLowerCase();
  if (!ATTACHMENT_MIME.has(mime)) throw new Error('attachment_data: Dateityp nicht erlaubt.');
  const base64 = match[2].replace(/\s/g, '');
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw new Error('attachment_data: Datei ist leer.');
  if (buffer.length > MAX_ATTACHMENT_BYTES) throw new Error('attachment_data: Datei darf höchstens 5 MB groß sein.');
  return { mime, size: buffer.length, buffer };
}

// CalDAV-Ziel eines Events validieren (Issue #241). Liefert {value, error}
// im Stil der validate.js-Helfer, damit collectErrors 400 statt 500 erzeugt.
// Leere/fehlende account_id bedeutet "Lokal" (kein Outbound-Sync).
function caldavTarget(body) {
  const rawId  = body.target_caldav_account_id;
  const rawUrl = body.target_caldav_calendar_url;
  if (rawId === null || rawId === undefined || rawId === '') {
    return { value: { accountId: null, calendarUrl: null }, error: null };
  }
  const accountId = typeof rawId === 'number' ? rawId : parseInt(rawId, 10);
  if (!Number.isInteger(accountId) || accountId < 1) {
    return { value: null, error: 'target_caldav_account_id: ungültige Konto-ID.' };
  }
  const calendarUrl = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!calendarUrl) {
    return { value: null, error: 'target_caldav_calendar_url: fehlt für CalDAV-Ziel.' };
  }
  if (calendarUrl.length > 2048) {
    return { value: null, error: 'target_caldav_calendar_url: zu lang.' };
  }
  return { value: { accountId, calendarUrl }, error: null };
}

// Google-Outbound-Ziel eines Events validieren (Issue #237). Leeres/fehlendes
// Feld bedeutet "Lokal" (kein Outbound zu Google).
function googleTarget(body) {
  const raw = body.target_google_calendar_id;
  if (raw === null || raw === undefined || raw === '') {
    return { value: null, error: null };
  }
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id) return { value: null, error: null };
  if (id.length > 2048) {
    return { value: null, error: 'target_google_calendar_id: zu lang.' };
  }
  return { value: id, error: null };
}

function ensureDocumentFolder(database, name, actorId) {
  const folderName = typeof name === 'string' ? name.trim() : '';
  if (!folderName) return null;
  const existing = database.prepare('SELECT id FROM family_document_folders WHERE name = ? COLLATE NOCASE').get(folderName);
  if (existing) return existing.id;
  const result = database.prepare('INSERT INTO family_document_folders (name, created_by) VALUES (?, ?)').run(folderName, actorId);
  return result.lastInsertRowid;
}

function createAttachmentDocument(database, attachment, staged, body, actorId) {
  if (!attachment?.buffer || !staged) return null;
  const originalName = String(body.attachment_name || 'Attachment').trim() || 'Attachment';
  const folderId = ensureDocumentFolder(database, body.document_folder_name || DEFAULT_ATTACHMENT_FOLDER, actorId);
  const result = database.prepare(`
    INSERT INTO family_documents
      (name, description, category, visibility, folder_id, original_name, mime_type,
       file_size, content_data, storage_provider, storage_backend, storage_key, created_by)
    VALUES (?, ?, 'other', 'family', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    body.document_name || originalName.replace(/\.[^.]+$/, ''),
    body.document_description || null,
    folderId,
    originalName,
    attachment.mime,
    attachment.size,
    staged.content_data,
    staged.storage_provider,
    staged.storage_backend,
    staged.storage_key,
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
    'id', u.id, 'display_name', u.display_name, 'color', u.avatar_color,
    'avatar_data', u.avatar_data
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
  const documentId = event.attachment_document_id ?? null;
  return {
    ...rest,
    assigned_users,
    attachment_document_id: documentId,
    attachment_data: documentId ? null : attachmentDataUrl(event),
    attachment_preview_url: documentId
      ? `/api/v1/documents/${documentId}/preview`
      : null,
    attachment_download_url: documentId
      ? `/api/v1/documents/${documentId}/download`
      : null,
    housekeeping_visit_id: event.housekeeping_visit_id ?? null,
  };
}

function sendStorageError(res, error, fallbackMessage) {
  if (!(error instanceof StorageError)) return false;
  res.status(502).json({
    error: fallbackMessage,
    code: 502,
    storage_code: error.storageCode,
  });
  return true;
}

// RRULE-Expansion (expandRecurringEvents) lebt nun in
// server/services/calendar-events.js, damit Kalender und Dashboard exakt
// dieselbe Wiederholungs-Logik nutzen.

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
    const limit    = Math.min(parseInt(req.query.limit, 10) || 5, 20);
    const expanded = getUpcomingEvents(db.get(), { userId: getUserId(req), limit })
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
 * GET /api/v1/calendar/google/calendars
 * Admin only. Listet die verfügbaren Google-Kalender des verbundenen Accounts.
 * Response: { data: [{ id, summary, primary, backgroundColor, selected }] }
 */
router.get('/google/calendars', requireAdmin, async (req, res) => {
  try {
    const data = await googleCalendar.listCalendars();
    res.json({ data });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: err.message, code: 500 });
  }
});

/**
 * PATCH /api/v1/calendar/google/calendars
 * Admin only. Aktiviert/deaktiviert einen Google-Kalender und startet einen Sync.
 * Body: { calendarId: string, enabled: boolean }
 * Response: { ok: true, lastSync: string }
 */
router.patch('/google/calendars', requireAdmin, async (req, res) => {
  const { calendarId, enabled } = req.body;
  if (!calendarId || typeof calendarId !== 'string' || calendarId.trim().length === 0) {
    return res.status(400).json({ error: 'calendarId fehlt oder ist ungültig.', code: 400 });
  }
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled muss ein Boolean sein.', code: 400 });
  }
  try {
    googleCalendar.setCalendarEnabled(calendarId, enabled);
    await googleCalendar.sync();
    const { lastSync } = googleCalendar.getStatus();
    res.json({ ok: true, lastSync });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: err.message, code: 500 });
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

/**
 * PUT /api/v1/calendar/google/readonly
 * Admin only. Aktiviert/deaktiviert den Nur-lesen-Modus.
 * Body: { readonly: boolean }
 * Response: { data: { readonly: boolean } }
 */
router.put('/google/readonly', requireAdmin, (req, res) => {
  const { readonly } = req.body;
  if (typeof readonly !== 'boolean') {
    return res.status(400).json({ error: 'readonly muss ein Boolean sein.', code: 400 });
  }
  try {
    googleCalendar.setReadonly(readonly);
    res.json({ data: { readonly } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: err.message, code: 500 });
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
// Read-only ICS-Export-Feed (Discussion #387)
// --------------------------------------------------------
function feedUrl(req, token) {
  const base = process.env.BASE_URL?.replace(/\/+$/, '')
    || `${req.protocol}://${req.get('host')}`;
  return `${base}/feed/calendar/${token}.ics`;
}

// GET /api/v1/calendar/feed → aktueller Feed-Status
router.get('/feed', (req, res) => {
  try {
    const token = icsExport.getFeedToken(db.get(), getUserId(req));
    if (!token) return res.json({ data: null });
    res.json({ data: { token, url: feedUrl(req, token) } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// POST /api/v1/calendar/feed/regenerate → neuen Token erzeugen
router.post('/feed/regenerate', (req, res) => {
  try {
    const token = icsExport.regenerateFeedToken(db.get(), getUserId(req));
    res.json({ data: { token, url: feedUrl(req, token) } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// DELETE /api/v1/calendar/feed → Feed deaktivieren
router.delete('/feed', (req, res) => {
  try {
    icsExport.clearFeedToken(db.get(), getUserId(req));
    res.json({ data: { token: null } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/calendar/holidays?from=YYYY-MM-DD&to=YYYY-MM-DD
// Muss VOR /:id stehen, damit "holidays" nicht als ID-Parameter interpretiert wird.
// ---------------------------------------------------------------------------
router.get('/holidays', (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: 'Query params from and to (YYYY-MM-DD) required.', code: 400 });
    }
    const data = holidays.getForRange(from, to);
    res.json({ data });
  } catch (err) {
    log.error('GET /holidays', err);
    res.status(500).json({ error: 'Interner Fehler.', code: 500 });
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
             ${ASSIGNED_USERS_SQL},
             (SELECT hws.id FROM housekeeping_work_sessions hws WHERE hws.calendar_event_id = e.id LIMIT 1) AS housekeeping_visit_id
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
router.post('/', async (req, res) => {
  let stagedUpload;
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
    const vCaldav = caldavTarget(req.body);
    const vGoogle = googleTarget(req.body);
    const errors = collectErrors([vTitle, vDesc, vStart, vEnd, vColor, vLoc, vRrule, vCaldav, vGoogle]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    if (!vIcon) return res.status(400).json({ error: 'icon: invalid calendar event icon.', code: 400 });

    const { all_day = 0 } = req.body;
    const userIds  = parseAssignedTo(req.body.assigned_to);
    const firstUid = userIds[0] ?? null;

    const attachment = req.body.attachment_data
      ? parseAttachment(req.body.attachment_data)
      : { mime: null, size: null, buffer: null };
    if (attachment.buffer) {
      stagedUpload = await stageDocumentUpload({
        buffer: attachment.buffer,
        mime: attachment.mime,
        category: 'other',
        originalName: req.body.attachment_name || 'Attachment',
      });
    }

    const eventId = db.get().transaction(() => {
      const documentId = createAttachmentDocument(
        db.get(),
        attachment,
        stagedUpload,
        req.body,
        userId
      );
      const result = db.get().prepare(`
        INSERT INTO calendar_events
          (title, description, start_datetime, end_datetime, all_day,
           location, color, icon, assigned_to, created_by, recurrence_rule,
           attachment_name, attachment_mime, attachment_size, attachment_data, attachment_document_id,
           target_caldav_account_id, target_caldav_calendar_url, target_google_calendar_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        vTitle.value, vDesc.value,
        vStart.value, vEnd.value,
        all_day ? 1 : 0, vLoc.value,
        vColor.value, vIcon, firstUid,
        userId, vRrule.value,
        req.body.attachment_name || null,
        attachment.mime,
        attachment.size,
        null,
        documentId,
        vCaldav.value.accountId,
        vCaldav.value.calendarUrl,
        vGoogle.value
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
    if (err instanceof StorageError && !stagedUpload) {
      log.error('POST / storage error:', err);
      return sendStorageError(res, err, 'Calendar attachment storage upload failed.');
    }
    log.error('', err);
    if (stagedUpload?.storage_backend === 'webdav') {
      try {
        await cleanupStagedUpload(stagedUpload);
      } catch (cleanupError) {
        log.error('POST / cleanup error after database failure:', cleanupError);
        return sendStorageError(
          res,
          cleanupError,
          'Calendar attachment storage cleanup failed.'
        );
      }
    }
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// --------------------------------------------------------
// PUT /api/v1/calendar/:id
// Termin vollständig aktualisieren.
// Body: alle Felder optional außer title + start_datetime
// Response: { data: Event }
// --------------------------------------------------------
router.put('/:id', async (req, res) => {
  let stagedUpload;
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
    // CalDAV-Ziel nur prüfen, wenn der Client es mitschickt; sonst bestehenden Wert behalten.
    const caldavProvided = req.body.target_caldav_account_id !== undefined
      || req.body.target_caldav_calendar_url !== undefined;
    const vCaldav = caldavProvided ? caldavTarget(req.body) : null;
    if (vCaldav) checks.push(vCaldav);
    // Google-Ziel nur prüfen, wenn der Client es mitschickt; sonst bestehenden Wert behalten.
    const googleProvided = req.body.target_google_calendar_id !== undefined;
    const vGoogle = googleProvided ? googleTarget(req.body) : null;
    if (vGoogle) checks.push(vGoogle);
    const errors = collectErrors(checks);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    const vIcon = req.body.icon !== undefined ? eventIcon(req.body.icon) : event.icon;
    if (!vIcon) return res.status(400).json({ error: 'icon: invalid calendar event icon.', code: 400 });
    if (
      req.body.remove_attachment !== undefined
      && typeof req.body.remove_attachment !== 'boolean'
    ) {
      return res.status(400).json({
        error: 'remove_attachment: muss ein Boolean sein.',
        code: 400,
      });
    }
    const attachmentDataProvided = Object.hasOwn(req.body, 'attachment_data');
    const replacementRequested = typeof req.body.attachment_data === 'string'
      && req.body.attachment_data.trim() !== '';
    const removalRequested = req.body.remove_attachment === true
      || (attachmentDataProvided && req.body.attachment_data === null);
    if (replacementRequested && removalRequested) {
      return res.status(400).json({
        error: 'attachment_data und remove_attachment widersprechen sich.',
        code: 400,
      });
    }
    const attachment = replacementRequested
      ? parseAttachment(req.body.attachment_data)
      : null;
    if (attachment?.buffer) {
      stagedUpload = await stageDocumentUpload({
        buffer: attachment.buffer,
        mime: attachment.mime,
        category: 'other',
        originalName: req.body.attachment_name || 'Attachment',
      });
    }

    const {
      title, description, start_datetime, end_datetime,
      all_day, location, color: colorVal, recurrence_rule,
    } = req.body;

    const userIds  = req.body.assigned_to !== undefined
      ? parseAssignedTo(req.body.assigned_to)
      : db.get().prepare('SELECT user_id FROM event_assignments WHERE event_id = ?')
          .all(id).map((r) => r.user_id);
    const firstUid = userIds[0] ?? null;

    const userModified = event.external_source !== 'local' ? 1 : event.user_modified;

    const caldavAccountId = vCaldav ? vCaldav.value.accountId : event.target_caldav_account_id;
    const caldavCalendarUrl = vCaldav ? vCaldav.value.calendarUrl : event.target_caldav_calendar_url;
    const googleTargetId = vGoogle ? vGoogle.value : event.target_google_calendar_id;

    db.get().transaction(() => {
      const documentId = replacementRequested
        ? createAttachmentDocument(
            db.get(),
            attachment,
            stagedUpload,
            req.body,
            event.created_by
          )
        : removalRequested
          ? null
          : event.attachment_document_id;
      const attachmentName = replacementRequested
        ? (req.body.attachment_name || 'Attachment')
        : removalRequested
          ? null
          : event.attachment_name;
      const attachmentMime = replacementRequested
        ? attachment.mime
        : removalRequested
          ? null
          : event.attachment_mime;
      const attachmentSize = replacementRequested
        ? attachment.size
        : removalRequested
          ? null
          : event.attachment_size;
      const attachmentData = replacementRequested || removalRequested
        ? null
        : event.attachment_data;
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
            target_caldav_account_id   = ?,
            target_caldav_calendar_url = ?,
            target_google_calendar_id  = ?,
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
        attachmentName,
        attachmentMime,
        attachmentSize,
        attachmentData,
        documentId,
        caldavAccountId,
        caldavCalendarUrl,
        googleTargetId,
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
    if (err instanceof StorageError && !stagedUpload) {
      log.error('PUT /:id storage error:', err);
      return sendStorageError(res, err, 'Calendar attachment storage upload failed.');
    }
    log.error('', err);
    if (stagedUpload?.storage_backend === 'webdav') {
      try {
        await cleanupStagedUpload(stagedUpload);
      } catch (cleanupError) {
        log.error('PUT /:id cleanup error after database failure:', cleanupError);
        return sendStorageError(
          res,
          cleanupError,
          'Calendar attachment storage cleanup failed.'
        );
      }
    }
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

// --------------------------------------------------------
// CalDAV Reminders (VTODO) Sync Routes — read-only into Tasks & Shopping
// --------------------------------------------------------

// Reminder-list discovery & selection

router.get('/caldav/accounts/:id/reminder-lists', requireAdmin, async (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const refresh = req.query.refresh === 'true';

    const lists = await caldavReminders.getReminderLists(accountId, { refresh });
    res.json({ data: lists });
  } catch (err) {
    log.error('CalDAV reminder lists fetch failed:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch reminder lists.', code: 500 });
  }
});

router.patch('/caldav/accounts/:id/reminder-lists', requireAdmin, (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const { listUrl, enabled, targetModule } = req.body;

    if (!listUrl || (enabled === undefined && targetModule === undefined)) {
      return res.status(400).json({ error: 'Missing listUrl or update fields.', code: 400 });
    }

    const result = caldavReminders.updateReminderSelection(accountId, listUrl, { enabled, targetModule });
    res.json({ data: result });
  } catch (err) {
    log.error('CalDAV reminder selection update failed:', err);
    res.status(500).json({ error: err.message || 'Failed to update reminder selection.', code: 500 });
  }
});

// Sync & Status

router.post('/caldav/reminders/sync', requireAdmin, async (req, res) => {
  try {
    const result = await caldavReminders.sync();
    res.json({ data: result });
  } catch (err) {
    log.error('CalDAV reminders sync failed:', err);
    res.status(500).json({ error: 'CalDAV reminders sync failed.', code: 500 });
  }
});

router.get('/caldav/reminders/status', (req, res) => {
  try {
    const status = caldavReminders.getStatus();
    res.json({ data: status });
  } catch (err) {
    log.error('CalDAV reminders status failed:', err);
    res.status(500).json({ error: 'Failed to get reminders status.', code: 500 });
  }
});

export const __test = { googleTarget };
export default router;
