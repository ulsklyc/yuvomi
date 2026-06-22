/**
 * Modul: ICS-Export
 * Zweck: Erzeugt einen read-only iCalendar-Feed (VCALENDAR) aus den für einen
 *        Nutzer sichtbaren Kalendereinträgen. Gegenstück zum ICS-Import.
 * Abhängigkeiten: keine externen.
 */

import { randomBytes } from 'node:crypto';

function escapeICSText(s) {
  if (s == null) return '';
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function foldLine(line) {
  // RFC 5545: Zeilen auf 75 Oktett falten, Folgezeile mit einem Space.
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Nicht mitten in einem Multibyte-Zeichen schneiden.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push(bytes.slice(start, end).toString('utf8'));
    start = end;
    limit = 74; // Folgezeilen haben ein führendes Space (1 Oktett).
  }
  return parts.join('\r\n ');
}

function pad(n) { return String(n).padStart(2, '0'); }

function hasExplicitOffset(iso) {
  // true, wenn der String ein 'Z' oder ein explizites [+-]HH:MM / [+-]HHMM Offset trägt.
  return /Z$|[+-]\d{2}:?\d{2}$/.test(iso);
}

function formatUTC(iso) {
  // iso: 'YYYY-MM-DDTHH:MM:SSZ', mit explizitem Offset (z.B. '+02:00') oder naiv
  // (→ als UTC interpretiert). Nur naive Werte bekommen ein 'Z' angehängt — bei
  // einem vorhandenen Offset würde das sonst einen ungültigen String erzeugen
  // (z.B. '...+02:00Z' → Date ist invalid → 'NaN...' im Feed).
  const d = new Date(hasExplicitOffset(iso) ? iso : iso + 'Z');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
         `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function formatLocal(iso) {
  // iso (naiv, ohne Offset): 'YYYY-MM-DDTHH:MM' oder 'YYYY-MM-DDTHH:MM:SS'
  // → 'YYYYMMDDTHHMMSS', reines String-Parsing (kein Date-Objekt!), damit die
  // Ziffern unverändert vom Eingabewert übernommen werden (floating local time,
  // RFC 5545 — kein 'Z', kein TZID).
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(iso);
  if (!m) throw new Error(`formatLocal: unerwartetes Format: ${iso}`);
  const [, y, mo, d, h, mi, s] = m;
  return `${y}${mo}${d}T${h}${mi}${s || '00'}`;
}

function isRecurrenceExpired(rrule, windowStart) {
  // Begrenzte Prüfung: nur UNTIL=-Klauseln werden berücksichtigt (RFC 5545: YYYYMMDD
  // oder YYYYMMDDTHHMMSSZ). COUNT-basierte oder offene RRULEs gelten als nicht
  // abgelaufen — eine vollständige Occurrence-Expansion ist hier bewusst out of scope.
  const m = /UNTIL=(\d{8})/.exec(rrule || '');
  if (!m) return false;
  const untilDate = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`;
  return untilDate < windowStart;
}

function formatDate(dateKey) {
  // dateKey: 'YYYY-MM-DD' → 'YYYYMMDD'
  return dateKey.slice(0, 10).replace(/-/g, '');
}

function addDaysDateKey(dateKey, days) {
  const d = new Date(dateKey.slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function buildVEvent(ev, dtstamp) {
  const lines = ['BEGIN:VEVENT'];
  lines.push(`UID:event-${ev.id}@yuvomi`);
  lines.push(`DTSTAMP:${dtstamp}`);
  if (ev.all_day) {
    lines.push(`DTSTART;VALUE=DATE:${formatDate(ev.start_datetime)}`);
    // DTEND ist exklusiv: Yuvomi speichert das letzte sichtbare Datum → +1 Tag.
    const endKey = ev.end_datetime || ev.start_datetime;
    lines.push(`DTEND;VALUE=DATE:${addDaysDateKey(endKey, 1)}`);
  } else {
    // Extern synchronisierte Events tragen ein explizites Z/Offset → echte UTC-Konvertierung.
    // Lokal angelegte Events sind naiv (keine Z/Offset) → floating local time, unverändert
    // übernommen, damit sie beim Abonnenten exakt wie in der App selbst angezeigt werden.
    const startFmt = hasExplicitOffset(ev.start_datetime) ? formatUTC(ev.start_datetime) : formatLocal(ev.start_datetime);
    lines.push(`DTSTART:${startFmt}`);
    if (ev.end_datetime) {
      const endFmt = hasExplicitOffset(ev.end_datetime) ? formatUTC(ev.end_datetime) : formatLocal(ev.end_datetime);
      lines.push(`DTEND:${endFmt}`);
    }
  }
  lines.push(`SUMMARY:${escapeICSText(ev.title)}`);
  if (ev.description) lines.push(`DESCRIPTION:${escapeICSText(ev.description)}`);
  if (ev.location) lines.push(`LOCATION:${escapeICSText(ev.location)}`);
  if (ev.recurrence_rule) lines.push(`RRULE:${ev.recurrence_rule}`);
  lines.push('END:VEVENT');
  return lines.map(foldLine);
}

function buildFeed(conn, userId, now = new Date()) {
  const windowStart = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  // Identische Sichtbarkeitslogik wie GET /api/v1/calendar:
  // alle Events außer fremden, nicht-geteilten ICS-Abos.
  const rows = conn.prepare(`
    SELECT id, title, description, start_datetime, end_datetime, all_day,
           location, recurrence_rule
    FROM calendar_events e
    WHERE (
      e.external_source <> 'ics'
      OR e.subscription_id IN (
        SELECT id FROM ics_subscriptions WHERE shared = 1 OR created_by = ?
      )
    )
    AND (
      e.recurrence_rule IS NOT NULL
      OR DATE(e.start_datetime) >= ?
    )
    ORDER BY e.start_datetime ASC
  `).all(userId, windowStart)
    .filter(ev => !isRecurrenceExpired(ev.recurrence_rule, windowStart));

  const dtstamp = formatUTC(now.toISOString());
  const out = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Yuvomi//Calendar Feed//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Yuvomi',
  ];
  for (const ev of rows) out.push(...buildVEvent(ev, dtstamp));
  out.push('END:VCALENDAR');
  return out.join('\r\n') + '\r\n';
}

function getFeedToken(conn, userId) {
  const row = conn.prepare(`SELECT calendar_feed_token AS t FROM users WHERE id = ?`).get(userId);
  return row?.t ?? null;
}

function regenerateFeedToken(conn, userId) {
  const token = randomBytes(32).toString('base64url');
  conn.prepare(`UPDATE users SET calendar_feed_token = ? WHERE id = ?`).run(token, userId);
  return token;
}

function clearFeedToken(conn, userId) {
  conn.prepare(`UPDATE users SET calendar_feed_token = NULL WHERE id = ?`).run(userId);
}

function findUserIdByFeedToken(conn, token) {
  if (!token) return null;
  const row = conn.prepare(`SELECT id FROM users WHERE calendar_feed_token = ?`).get(token);
  return row?.id ?? null;
}

export {
  escapeICSText, foldLine, buildFeed,
  getFeedToken, regenerateFeedToken, clearFeedToken, findUserIdByFeedToken,
};
