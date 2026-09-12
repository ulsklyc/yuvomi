/**
 * Modul: ICS-Export
 * Zweck: Erzeugt einen read-only iCalendar-Feed (VCALENDAR) aus den für einen
 *        Nutzer sichtbaren Kalendereinträgen. Gegenstück zum ICS-Import.
 * Abhängigkeiten: keine externen.
 */

import { randomBytes } from 'node:crypto';
import {
  householdTimeZone, isValidTimeZone, localToUTC, shiftDateKey, utcToWall,
} from '../utils/timezone.js';
import { formatWall, vtimezoneFor } from '../utils/vtimezone.js';
import { outboundDateRange } from './outbound-dtstart.js';
import { rruleLine } from './recurrence.js';
import {
  BODY_FREE_EVENT_COLUMNS, eventProjectionSql, resolveProjectedEventRows,
} from './calendar-event-reader.js';
import { baseOccurrenceFor, isLinkedOccurrence } from './calendar-occurrence-overrides.js';

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
// Die Rechnung selbst - Wanduhrzeit und der VTIMEZONE-Block mit den
// DST-Übergängen - steht seit #938 in utils/vtimezone.js: der ausgehende
// CalDAV-Pfad braucht dieselbe und darf sie nicht ein zweites Mal führen.

// Nutzt dieses Event den TZID-Export-Pfad? Nur zeitgebundene Serien mit bekannter
// Zone - Einzeltermine sind als UTC-Instant bereits eindeutig (kein DST-Problem).
function usesTzid(ev) {
  return !!(ev.tzid && !ev.all_day && ev.recurrence_rule);
}

// --------------------------------------------------------
// Verankerung naiver Zeiten an der Haushaltszone (#818)
// --------------------------------------------------------
// Lokal angelegte Termine speichern reine Wanduhrzeit ohne Offset. Als floating
// local time exportiert (RFC 5545: gültig, gemeint ist "die Uhr des Betrachters")
// legen Google, Apple, Thunderbird, Outlook und Home Assistant sie in der Praxis
// auf UTC - ein 16:00-Termin in Madrid erscheint um 18:00. Weil diese Ziffern die
// Uhr des Haushalts meinen, tragen sie im Feed jetzt deren Zone: DTSTART;TZID=…
// plus VTIMEZONE, dazu X-WR-TIMEZONE als Kalenderzone für die Clients, die den
// Header auswerten.

// Die Zone, an der naive Werte verankert werden. null, wenn sie UTC-gleich oder
// nicht auflösbar ist: dann sind die Ziffern bereits UTC und ein 'Z' ist eindeutiger
// als ein VTIMEZONE über eine Zone, die viele Clients nicht als solche führen.
function resolveFeedZone(tz) {
  const zone = (tz || '').trim();
  if (!zone || /^(UTC|GMT|Z|Etc\/(UTC|GMT|GMT0|GMT\+0|GMT-0|Zulu|Universal|Greenwich))$/i.test(zone)) return null;
  return isValidTimeZone(zone) ? zone : null;
}

// Eine Datums-/Zeit-Property. Werte mit eigenem Offset sind als UTC-Instant
// eindeutig; naive Werte bekommen die Feed-Zone (bzw. 'Z', wenn diese UTC ist).
function stampProp(prop, iso, feedZone) {
  if (hasExplicitOffset(iso)) return `${prop}:${formatUTC(iso)}`;
  return feedZone
    ? `${prop};TZID=${feedZone}:${formatLocal(iso)}`
    : `${prop}:${formatLocal(iso)}Z`;
}

// Braucht dieses Event ein VTIMEZONE der Feed-Zone? Nur der naive Pfad; Ganztags-
// Werte sind VALUE=DATE, Serien mit eigener tzid bringen ihre Zone selbst mit.
function usesFeedZone(ev) {
  if (ev.all_day || usesTzid(ev)) return false;
  return !hasExplicitOffset(ev.start_datetime) ||
    !!(ev.end_datetime && !hasExplicitOffset(ev.end_datetime));
}

// EXDATE and RECURRENCE-ID identify the same original recurrence slot. Keeping
// their notation in one formatter prevents a moved replacement from using a
// date-only, floating or TZID form different from the master's RRULE set.
function recurrenceSlotProp(prop, master, dateKey, feedZone) {
  if (master.all_day) return `${prop};VALUE=DATE:${formatDate(dateKey)}`;
  if (usesTzid(master)) {
    const baseOccurrence = baseOccurrenceFor(master, dateKey);
    return `${prop};TZID=${master.tzid}:${formatWall(baseOccurrence.start_datetime, master.tzid)}`;
  }
  const timeSuffix = master.start_datetime.slice(10);
  return stampProp(prop, dateKey + timeSuffix, feedZone);
}

// EXDATEs may outlive a changed/imported rule and therefore cannot require a
// successful occurrence expansion. Reconstruct the instant in constant time,
// retaining the wall clock across DST as the expander does after #985. When
// local and stored days differ, the identity is still a UTC day: find its
// local date among the three adjacent candidates, not by reusing a UTC suffix.
// This does not scan the rule, so retained/unreachable EXDATEs remain harmless.
function exceptionSlotProp(master, dateKey, feedZone) {
  if (master.all_day) return `EXDATE;VALUE=DATE:${formatDate(dateKey)}`;
  if (usesTzid(master)) {
    const wall = utcToWall(master.start_datetime, master.tzid);
    let instant = dateKey + master.start_datetime.slice(10);
    if (wall?.date === master.start_datetime.slice(0, 10)) {
      instant = localToUTC(`${dateKey}T${wall.time}`, master.tzid);
    } else if (wall) {
      for (const offset of [0, -1, 1]) {
        const candidate = localToUTC(`${shiftDateKey(dateKey, offset)}T${wall.time}`, master.tzid);
        if (candidate.slice(0, 10) === dateKey) {
          instant = candidate;
          break;
        }
      }
      // If a historical timezone jump leaves no candidate, preserve a harmless
      // legacy EXDATE rather than making the whole feed unavailable.
    }
    return `EXDATE;TZID=${master.tzid}:${formatWall(instant, master.tzid)}`;
  }
  return recurrenceSlotProp('EXDATE', master, dateKey, feedZone);
}

function buildVEvent(
  ev,
  dtstamp,
  showAssignees = false,
  feedZone = null,
  recurrenceMaster = null,
) {
  const lines = ['BEGIN:VEVENT'];
  lines.push(`UID:event-${recurrenceMaster?.id ?? ev.id}@yuvomi`);
  lines.push(`DTSTAMP:${dtstamp}`);
  // DTSTART mit der eigenen Regel in Einklang (#986) - nur fuer selbst angelegte
  // Serien; ein importiertes DTSTART geht Wort fuer Wort zurueck (#756).
  // Begruendung in services/outbound-dtstart.js. DAS ENDE WANDERT MIT: es ist
  // ein absoluter Zeitstempel, kein Abstand - bliebe es stehen, endete der
  // Termin vor seinem Beginn.
  // A replacement inherits the master's rule for effective reads, but its own
  // DTSTART/DTEND are concrete moves and must never be snapped to that rule.
  const outboundEvent = recurrenceMaster ? { ...ev, recurrence_rule: null } : ev;
  const { start_datetime: dtstart, end_datetime: dtende } = outboundDateRange(outboundEvent);

  if (recurrenceMaster) {
    lines.push(recurrenceSlotProp(
      'RECURRENCE-ID', recurrenceMaster, ev.recurrence_id, feedZone
    ));
  }
  if (ev.all_day) {
    lines.push(`DTSTART;VALUE=DATE:${formatDate(dtstart)}`);
    // DTEND ist exklusiv: Yuvomi speichert das letzte sichtbare Datum → +1 Tag.
    const endKey = dtende || dtstart;
    lines.push(`DTEND;VALUE=DATE:${addDaysDateKey(endKey, 1)}`);
  } else if (usesTzid(ev)) {
    // Wiederkehrende Serie mit Zone: lokale Wanduhrzeit + TZID, damit der Abonnent
    // pro Vorkommen DST-korrekt expandiert (statt fixem UTC-Suffix → Winter-Drift, #549).
    lines.push(`DTSTART;TZID=${ev.tzid}:${formatWall(dtstart, ev.tzid)}`);
    if (dtende) lines.push(`DTEND;TZID=${ev.tzid}:${formatWall(dtende, ev.tzid)}`);
  } else {
    // Extern synchronisierte Events tragen ein explizites Z/Offset → echte UTC-Konvertierung.
    // Lokal angelegte Events sind naiv (keine Z/Offset) → Wanduhrzeit des Haushalts,
    // an dessen Zone verankert statt floating (#818).
    lines.push(stampProp('DTSTART', dtstart, feedZone));
    if (dtende) lines.push(stampProp('DTEND', dtende, feedZone));
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
  // rruleLine statt Handarbeit: eine eingelesene Serie bringt ihr `RRULE:` schon
  // mit, ein blindes Praefix erzeugte `RRULE:RRULE:FREQ=...` und liess strikte
  // Abonnenten das ganze Event verwerfen (#761).
  if (ev.recurrence_rule && !recurrenceMaster) lines.push(rruleLine(ev.recurrence_rule));
  // Einzeln ausgenommene Vorkommen (EXDATE, #489). Zeit-Teil = Master-Startzeit,
  // damit die EXDATE-Instanz exakt auf ein RRULE-Vorkommen trifft.
  if (!recurrenceMaster && ev.recurrence_rule
      && Array.isArray(ev.exception_dates) && ev.exception_dates.length) {
    for (const exDate of ev.exception_dates) {
      lines.push(exceptionSlotProp(ev, exDate, feedZone));
    }
  }
  lines.push('END:VEVENT');
  return lines.map(foldLine);
}

function buildFeed(conn, userId, now = new Date(), tz = householdTimeZone(conn)) {
  const windowStart = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const feedZone = resolveFeedZone(tz);

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

  const queriedRows = conn.prepare(`
    SELECT ${eventProjectionSql(conn, 'e', BODY_FREE_EVENT_COLUMNS)}${assigneeSelect}
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
  `).all(userId, windowStart);
  const referencedMasterIds = new Set(queriedRows
    .filter(isLinkedOccurrence)
    .map((event) => Number(event.recurrence_parent_id)));
  const rows = queriedRows
    .filter((event) => !isRecurrenceExpired(event.recurrence_rule, windowStart)
      || referencedMasterIds.has(Number(event.id)));

  // Instanz-Ausnahmen (EXDATE, #489) für die wiederkehrenden Events des Feeds laden.
  const recurringIds = rows.filter(ev => ev.recurrence_rule).map(ev => ev.id);
  const exceptionsByEvent = new Map();
  if (recurringIds.length) {
    const placeholders = recurringIds.map(() => '?').join(',');
    const exRows = conn.prepare(
      `SELECT event_id, exception_date FROM calendar_event_exceptions WHERE event_id IN (${placeholders})`
    ).all(...recurringIds);
    for (const r of exRows) {
      if (!exceptionsByEvent.has(r.event_id)) exceptionsByEvent.set(r.event_id, []);
      exceptionsByEvent.get(r.event_id).push(r.exception_date);
    }
  }

  const resolvedRows = resolveProjectedEventRows(conn, rows, { lightweight: true });
  // RFC 5545 represents a reachable replacement with RECURRENCE-ID, so its
  // master must not also emit EXDATE. A child that degraded to standalone is
  // deliberately absent here: its original master slot remains excluded.
  const linkedSlotsByMaster = new Map();
  for (const event of resolvedRows.filter((row) => row.is_occurrence_override)) {
    const parentId = Number(event.series_id);
    if (!linkedSlotsByMaster.has(parentId)) linkedSlotsByMaster.set(parentId, new Set());
    linkedSlotsByMaster.get(parentId).add(event.recurrence_id);
  }
  for (const event of resolvedRows) {
    const linkedSlots = linkedSlotsByMaster.get(Number(event.id));
    event.exception_dates = (exceptionsByEvent.get(event.id) || [])
      .filter((dateKey) => !linkedSlots?.has(dateKey));
  }
  // Keep recurrence context even when an old master itself falls outside the
  // rolling feed window but one of its moved replacements is displayed now.
  const mastersById = new Map(queriedRows
    .filter((event) => event.recurrence_rule)
    .map((event) => [Number(event.id), event]));

  // Resolution owns assignment inheritance; the title suffix is an export-only
  // projection, so hydrate it once from the resolved assignment owner IDs.
  if (showAssignees && resolvedRows.length) {
    const ownerIds = [...new Set(resolvedRows
      .map((event) => Number(event.assignment_owner_id ?? event.id))
      .filter((id) => Number.isInteger(id) && id > 0))];
    if (ownerIds.length) {
      const nameRows = conn.prepare(`
        SELECT ea.event_id, u.display_name
        FROM event_assignments ea
        JOIN users u ON u.id = ea.user_id
        WHERE ea.event_id IN (${ownerIds.map(() => '?').join(',')})
        ORDER BY ea.event_id, u.display_name
      `).all(...ownerIds);
      const namesByOwner = new Map();
      for (const row of nameRows) {
        if (!namesByOwner.has(row.event_id)) namesByOwner.set(row.event_id, []);
        namesByOwner.get(row.event_id).push(row.display_name);
      }
      for (const event of resolvedRows) {
        const ownerId = Number(event.assignment_owner_id ?? event.id);
        event.assignee_names_json = JSON.stringify(namesByOwner.get(ownerId) ?? []);
      }
    }
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
  // Kalenderzone für die Clients, die den Header auswerten (Google, Thunderbird).
  // Sie ersetzt die TZID-Parameter nicht, sondern deckt den Rest: Termine ohne
  // eigene Zone und die Zone, in der der Abonnent den Kalender angelegt sieht (#818).
  if (feedZone) out.push(`X-WR-TIMEZONE:${feedZone}`);
  // Je referenzierter Zone genau ein VTIMEZONE (RFC 5545: vor den VEVENTs), damit
  // Abonnenten die TZID-Serien auflösen können (#549) und die an der Haushaltszone
  // verankerten Termine (#818).
  const usedZones = new Set(resolvedRows.filter(usesTzid).map((ev) => ev.tzid));
  if (feedZone && resolvedRows.some(usesFeedZone)) usedZones.add(feedZone);
  const tzYear = now.getUTCFullYear();
  for (const tzid of usedZones) out.push(...vtimezoneFor(tzid, tzYear).map(foldLine));
  for (const ev of resolvedRows) {
    const recurrenceMaster = ev.is_occurrence_override
      ? mastersById.get(Number(ev.series_id))
      : null;
    out.push(...buildVEvent(ev, dtstamp, showAssignees, feedZone, recurrenceMaster));
  }
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
  resolveFeedZone, stampProp,
};
