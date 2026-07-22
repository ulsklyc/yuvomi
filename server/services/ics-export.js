/**
 * Modul: ICS-Export
 * Zweck: Erzeugt einen read-only iCalendar-Feed (VCALENDAR) aus den für einen
 *        Nutzer sichtbaren Kalendereinträgen. Gegenstück zum ICS-Import.
 * Abhängigkeiten: keine externen.
 */

import { randomBytes } from 'node:crypto';
import { utcToWall } from '../utils/timezone.js';

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

// --------------------------------------------------------
// TZID-Export für wiederkehrende Serien (#549)
// --------------------------------------------------------
// Synchronisierte Serien speichern start_datetime als UTC-Instant + tzid. Würde
// der Feed sie UTC-verankert (mit RRULE, ohne TZID) exportieren, expandierte die
// App des Abonnenten jede Instanz mit fixer UTC-Zeit → dieselbe Sommer-/Winterzeit-
// Drift wie beim Import. Deshalb: DTSTART;TZID=<zone> mit lokaler Wanduhrzeit + ein
// generiertes VTIMEZONE, damit der Abonnent pro Vorkommen korrekt lokal → UTC rechnet.

// UTC-Instant (…Z) → ICS-Basic-Format der lokalen Wanduhrzeit ('YYYYMMDDTHHMMSS').
function formatWall(iso, tzid) {
  const w = utcToWall(iso, tzid);
  if (!w) return null;
  return w.date.replace(/-/g, '') + 'T' + w.time.replace(/:/g, '');
}

// Offset (Minuten) einer Zone zum gegebenen UTC-Zeitpunkt.
function tzOffsetMinutes(utcMs, tzid) {
  const w = utcToWall(new Date(utcMs).toISOString(), tzid);
  if (!w) return 0;
  const [Y, Mo, D] = w.date.split('-').map(Number);
  const [H, Mi, S] = w.time.split(':').map(Number);
  return Math.round((Date.UTC(Y, Mo - 1, D, H, Mi, S) - utcMs) / 60000);
}

function fmtOffset(min) {
  const a = Math.abs(min);
  return (min < 0 ? '-' : '+') + pad(Math.floor(a / 60)) + pad(a % 60);
}

function tzNameAt(utcMs, tzid) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tzid, timeZoneName: 'short', hour12: false })
      .formatToParts(new Date(utcMs));
    const p = parts.find((x) => x.type === 'timeZoneName');
    // Reine Offset-Namen (z.B. 'GMT+2') sind als TZNAME wenig hilfreich → weglassen.
    return p && !/^GMT|^UTC/.test(p.value) ? p.value : null;
  } catch { return null; }
}

// Alle DST-Übergänge eines Jahres (minutengenau per Binärsuche über den Offset-Sprung).
function findTransitions(year, tzid) {
  const DAY = 86400000;
  const end = Date.UTC(year + 1, 0, 1);
  const out = [];
  let prevMs = Date.UTC(year, 0, 1);
  let prevOff = tzOffsetMinutes(prevMs, tzid);
  for (let t = prevMs + DAY; t <= end; t += DAY) {
    const off = tzOffsetMinutes(t, tzid);
    if (off !== prevOff) {
      let lo = prevMs, hi = t;
      while (hi - lo > 60000) {
        const mid = lo + Math.floor((hi - lo) / 120000) * 60000; // minutengenaue Mitte
        if (tzOffsetMinutes(mid, tzid) === prevOff) lo = mid; else hi = mid;
      }
      out.push({ instant: hi, offsetBefore: prevOff, offsetAfter: off });
    }
    prevMs = t; prevOff = off;
  }
  return out;
}

// n-ter Wochentag im Monat als BYDAY-Wert (letzter → -1SU), aus einem lokalen Datum.
function bydayOf(d) {
  const dow = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][d.getUTCDay()];
  const dom = d.getUTCDate();
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const nth = dom + 7 > daysInMonth ? -1 : Math.ceil(dom / 7);
  return `${nth}${dow}`;
}

// VTIMEZONE-Block für eine IANA-Zone, RRULE-basiert (extrapoliert für offene Serien).
function buildVTimezone(tzid, year) {
  const transitions = findTransitions(year, tzid);
  const lines = ['BEGIN:VTIMEZONE', `TZID:${tzid}`];
  if (transitions.length === 0) {
    // Keine Sommerzeit: einzelne STANDARD-Komponente mit festem Offset.
    const off = tzOffsetMinutes(Date.UTC(year, 0, 1), tzid);
    const name = tzNameAt(Date.UTC(year, 0, 1), tzid);
    lines.push('BEGIN:STANDARD', `TZOFFSETFROM:${fmtOffset(off)}`, `TZOFFSETTO:${fmtOffset(off)}`);
    if (name) lines.push(`TZNAME:${name}`);
    lines.push('DTSTART:19700101T000000', 'END:STANDARD');
  } else {
    for (const tr of transitions) {
      const isDst = tr.offsetAfter > tr.offsetBefore; // Sprung nach vorne → Sommerzeit beginnt
      // DTSTART der Sub-Komponente ist die lokale Wanduhrzeit im FROM-Offset.
      const onset = new Date(tr.instant + tr.offsetBefore * 60000);
      const name = tzNameAt(tr.instant, tzid);
      lines.push(
        isDst ? 'BEGIN:DAYLIGHT' : 'BEGIN:STANDARD',
        `TZOFFSETFROM:${fmtOffset(tr.offsetBefore)}`,
        `TZOFFSETTO:${fmtOffset(tr.offsetAfter)}`,
      );
      if (name) lines.push(`TZNAME:${name}`);
      lines.push(
        `DTSTART:${onset.getUTCFullYear()}${pad(onset.getUTCMonth() + 1)}${pad(onset.getUTCDate())}` +
          `T${pad(onset.getUTCHours())}${pad(onset.getUTCMinutes())}${pad(onset.getUTCSeconds())}`,
        `RRULE:FREQ=YEARLY;BYMONTH=${onset.getUTCMonth() + 1};BYDAY=${bydayOf(onset)}`,
        isDst ? 'END:DAYLIGHT' : 'END:STANDARD',
      );
    }
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

// Nutzt dieses Event den TZID-Export-Pfad? Nur zeitgebundene Serien mit bekannter
// Zone - Einzeltermine sind als UTC-Instant bereits eindeutig (kein DST-Problem).
function usesTzid(ev) {
  return !!(ev.tzid && !ev.all_day && ev.recurrence_rule);
}

function buildVEvent(ev, dtstamp, showAssignees = false) {
  const lines = ['BEGIN:VEVENT'];
  lines.push(`UID:event-${ev.id}@yuvomi`);
  lines.push(`DTSTAMP:${dtstamp}`);
  if (ev.all_day) {
    lines.push(`DTSTART;VALUE=DATE:${formatDate(ev.start_datetime)}`);
    // DTEND ist exklusiv: Yuvomi speichert das letzte sichtbare Datum → +1 Tag.
    const endKey = ev.end_datetime || ev.start_datetime;
    lines.push(`DTEND;VALUE=DATE:${addDaysDateKey(endKey, 1)}`);
  } else if (usesTzid(ev)) {
    // Wiederkehrende Serie mit Zone: lokale Wanduhrzeit + TZID, damit der Abonnent
    // pro Vorkommen DST-korrekt expandiert (statt fixem UTC-Suffix → Winter-Drift, #549).
    lines.push(`DTSTART;TZID=${ev.tzid}:${formatWall(ev.start_datetime, ev.tzid)}`);
    if (ev.end_datetime) lines.push(`DTEND;TZID=${ev.tzid}:${formatWall(ev.end_datetime, ev.tzid)}`);
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
  // Opt-in (#482): zugewiesene Personen als Titel-Suffix "(Name, Name)".
  // Escaping erfolgt über den zusammengesetzten String, damit Kommata/Semikola
  // in Namen wie im Titel RFC-konform maskiert werden.
  let summary = ev.title || '';
  if (showAssignees) {
    const names = ev.assignee_names_json ? JSON.parse(ev.assignee_names_json) : [];
    if (names.length) summary += ` (${names.join(', ')})`;
  }
  lines.push(`SUMMARY:${escapeICSText(summary)}`);
  if (ev.description) lines.push(`DESCRIPTION:${escapeICSText(ev.description)}`);
  if (ev.location) lines.push(`LOCATION:${escapeICSText(ev.location)}`);
  if (ev.recurrence_rule) lines.push(`RRULE:${ev.recurrence_rule}`);
  // Einzeln ausgenommene Vorkommen (EXDATE, #489). Zeit-Teil = Master-Startzeit,
  // damit die EXDATE-Instanz exakt auf ein RRULE-Vorkommen trifft.
  if (ev.recurrence_rule && Array.isArray(ev.exception_dates) && ev.exception_dates.length) {
    // Bei TZID-Serien die lokale Wanduhrzeit des Masters als Zeit-Teil nutzen, damit
    // die EXDATE-Instanz zonengleich auf ein RRULE-Vorkommen trifft (#549).
    const wallSuffix = usesTzid(ev) ? formatWall(ev.start_datetime, ev.tzid).slice(8) : null; // 'T072500'
    const timeSuffix = ev.all_day ? '' : ev.start_datetime.slice(10); // 'T18:00' / 'T18:00:00Z' / ''
    for (const exDate of ev.exception_dates) {
      if (ev.all_day) {
        lines.push(`EXDATE;VALUE=DATE:${formatDate(exDate)}`);
      } else if (usesTzid(ev)) {
        lines.push(`EXDATE;TZID=${ev.tzid}:${formatDate(exDate)}${wallSuffix}`);
      } else {
        const occIso = exDate + timeSuffix;
        const fmt = hasExplicitOffset(occIso) ? formatUTC(occIso) : formatLocal(occIso);
        lines.push(`EXDATE:${fmt}`);
      }
    }
  }
  lines.push('END:VEVENT');
  return lines.map(foldLine);
}

function buildFeed(conn, userId, now = new Date()) {
  const windowStart = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  // Identische Sichtbarkeitslogik wie GET /api/v1/calendar:
  // alle Events außer fremden, nicht-geteilten ICS-Abos.
  const showAssignees = !!conn.prepare(
    `SELECT calendar_feed_show_assignees AS v FROM users WHERE id = ?`
  ).get(userId)?.v;

  // Namen nur laden, wenn der Feed-Eigentümer sie im Titel anzeigen will (#482);
  // im Default-Fall (aus) spart das die korrelierte Subquery je Event.
  const assigneeSelect = showAssignees ? `,
           (SELECT json_group_array(name) FROM (
              SELECT u.display_name AS name
              FROM event_assignments ea JOIN users u ON u.id = ea.user_id
              WHERE ea.event_id = e.id
              ORDER BY u.display_name
           )) AS assignee_names_json` : '';

  const rows = conn.prepare(`
    SELECT id, title, description, start_datetime, end_datetime, all_day,
           location, recurrence_rule, tzid${assigneeSelect}
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

  // Instanz-Ausnahmen (EXDATE, #489) für die wiederkehrenden Events des Feeds laden.
  const recurringIds = rows.filter(ev => ev.recurrence_rule).map(ev => ev.id);
  if (recurringIds.length) {
    const placeholders = recurringIds.map(() => '?').join(',');
    const exRows = conn.prepare(
      `SELECT event_id, exception_date FROM calendar_event_exceptions WHERE event_id IN (${placeholders})`
    ).all(...recurringIds);
    const byEvent = new Map();
    for (const r of exRows) {
      if (!byEvent.has(r.event_id)) byEvent.set(r.event_id, []);
      byEvent.get(r.event_id).push(r.exception_date);
    }
    for (const ev of rows) ev.exception_dates = byEvent.get(ev.id) || [];
  }

  const dtstamp = formatUTC(now.toISOString());
  const out = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Yuvomi//Calendar Feed//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Yuvomi',
  ];
  // Je referenzierter Zone genau ein VTIMEZONE (RFC 5545: vor den VEVENTs), damit
  // Abonnenten die TZID-Serien auflösen können (#549).
  const usedZones = [...new Set(rows.filter(usesTzid).map((ev) => ev.tzid))];
  const tzYear = now.getUTCFullYear();
  for (const tzid of usedZones) out.push(...buildVTimezone(tzid, tzYear).map(foldLine));
  for (const ev of rows) out.push(...buildVEvent(ev, dtstamp, showAssignees));
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

function getFeedShowAssignees(conn, userId) {
  const row = conn.prepare(
    `SELECT calendar_feed_show_assignees AS v FROM users WHERE id = ?`
  ).get(userId);
  return !!row?.v;
}

function setFeedShowAssignees(conn, userId, value) {
  conn.prepare(`UPDATE users SET calendar_feed_show_assignees = ? WHERE id = ?`)
    .run(value ? 1 : 0, userId);
  return !!value;
}

export {
  escapeICSText, foldLine, buildFeed,
  getFeedToken, regenerateFeedToken, clearFeedToken, findUserIdByFeedToken,
  getFeedShowAssignees, setFeedShowAssignees,
};
