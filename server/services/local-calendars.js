import { randomBytes, timingSafeEqual } from 'node:crypto';

const DEFAULT_CALENDAR_NAME = 'Calendar';
const DEFAULT_CALENDAR_COLOR = '#007AFF';
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function firstUserId(conn) {
  return conn.prepare(`
    SELECT id FROM users
    ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, id
    LIMIT 1
  `).get()?.id ?? null;
}

function serializeCalendar(req, row, feedUrl) {
  if (!row) return null;
  const token = row.feed_token ?? null;
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    is_default: !!row.is_default,
    sort_order: row.sort_order ?? 0,
    feed_token: token,
    feed_url: token ? feedUrl(req, token) : null,
  };
}

function ensureDefaultCalendar(conn) {
  let row = conn.prepare(`
    SELECT * FROM local_calendars
    WHERE is_default = 1
    ORDER BY id
    LIMIT 1
  `).get();
  if (row) return row;

  const ownerId = firstUserId(conn);
  const id = conn.prepare(`
    INSERT INTO local_calendars (name, color, is_default, sort_order, created_by)
    VALUES (?, ?, 1, 0, ?)
  `).run(DEFAULT_CALENDAR_NAME, DEFAULT_CALENDAR_COLOR, ownerId).lastInsertRowid;
  conn.prepare(`
    UPDATE calendar_events
    SET local_calendar_id = ?
    WHERE local_calendar_id IS NULL
  `).run(id);
  return conn.prepare('SELECT * FROM local_calendars WHERE id = ?').get(id);
}

function defaultCalendarId(conn) {
  return ensureDefaultCalendar(conn).id;
}

function localCalendarById(conn, id) {
  const numeric = Number(id);
  if (!Number.isInteger(numeric) || numeric < 1) return null;
  return conn.prepare('SELECT * FROM local_calendars WHERE id = ?').get(numeric) ?? null;
}

function validateCalendarId(conn, raw, { required = false, fallbackDefault = false } = {}) {
  if (raw === undefined || raw === null || raw === '') {
    if (fallbackDefault) return { value: defaultCalendarId(conn), error: null };
    return { value: required ? null : undefined, error: required ? 'Kalender: Wähle einen gültigen Kalender aus.' : null };
  }
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) {
    return { value: null, error: 'Kalender: Wähle einen gültigen Kalender aus.' };
  }
  const row = localCalendarById(conn, id);
  if (!row) return { value: null, error: 'Kalender: Dieser Kalender existiert nicht mehr.' };
  return { value: row.id, error: null };
}

function validateCalendarName(value) {
  if (typeof value !== 'string') return { value: null, error: 'Name muss als Text angegeben werden.' };
  const name = value.trim();
  if (!name || name.length > 80) {
    return { value: null, error: 'Name: Gib einen Namen mit höchstens 80 Zeichen ein.' };
  }
  return { value: name, error: null };
}

function validateCalendarColor(value) {
  if (typeof value !== 'string' || !HEX_COLOR_RE.test(value.trim())) {
    return { value: null, error: 'Farbe: Gib eine gültige Hex-Farbe an.' };
  }
  return { value: value.trim().toUpperCase(), error: null };
}

function findCalendarByFeedToken(conn, token) {
  if (!token) return null;
  const candidate = Buffer.from(token, 'utf8');
  for (const row of conn.prepare(`
    SELECT * FROM local_calendars WHERE feed_token IS NOT NULL
  `).all()) {
    const stored = Buffer.from(row.feed_token, 'utf8');
    if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) return row;
  }
  return null;
}

function regenerateCalendarFeedToken(conn, calendarId) {
  const token = randomBytes(32).toString('base64url');
  conn.prepare('UPDATE local_calendars SET feed_token = ? WHERE id = ?').run(token, calendarId);
  return token;
}

function clearCalendarFeedToken(conn, calendarId) {
  conn.prepare('UPDATE local_calendars SET feed_token = NULL WHERE id = ?').run(calendarId);
}

export {
  DEFAULT_CALENDAR_NAME,
  DEFAULT_CALENDAR_COLOR,
  ensureDefaultCalendar,
  defaultCalendarId,
  localCalendarById,
  validateCalendarId,
  validateCalendarName,
  validateCalendarColor,
  serializeCalendar,
  findCalendarByFeedToken,
  regenerateCalendarFeedToken,
  clearCalendarFeedToken,
};
