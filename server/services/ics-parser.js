/**
 * Modul: ICS-Parser
 * Zweck: Gemeinsamer ICS/iCalendar-Parser für Apple Calendar und ICS-Abonnements.
 *        Enthält RFC-5545-konformes Parsing, Zeitzonenkonvertierung und RRULE-Expansion.
 * Abhängigkeiten: server/services/recurrence.js
 */

import { nextOccurrence } from './recurrence.js';
import { resolveIcalColor } from '../utils/ical-color.js';

function unfoldLines(ics) {
  return ics.replace(/\r?\n[ \t]/g, '');
}

function unescapeICSText(str) {
  if (!str) return str;
  return str
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function parseICS(ics) {
  const unfolded = unfoldLines(ics);
  const events   = [];
  const vEventRe = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/g;
  let match;
  while ((match = vEventRe.exec(unfolded)) !== null) {
    const block = match[1];
    const get   = (prop) => {
      const re = new RegExp(`^${prop}(?:;[^:]*)?:(.*)$`, 'im');
      const m  = re.exec(block);
      return m ? m[1].trim() : null;
    };
    const uid         = get('UID');
    const summary     = unescapeICSText(get('SUMMARY') || '(kein Titel)');
    const description = unescapeICSText(get('DESCRIPTION')) || null;
    const location    = unescapeICSText(get('LOCATION'))    || null;
    const rrule       = get('RRULE')       ? `RRULE:${get('RRULE')}` : null;
    // RFC 7986: COLOR trägt einen CSS3-Namen (oder Hex) für die Event-Eigenfarbe.
    const color       = resolveIcalColor(get('COLOR'));
    const parseDTLine = (prop) => {
      const re = new RegExp(`^${prop}((?:;[^:;]*)*):(.*)$`, 'im');
      const m = block.match(re);
      if (!m) return { value: null, tzid: null };
      const params  = m[1];
      const value   = m[2].trim();
      const tzMatch = params.match(/;TZID=([^;:]+)/i);
      return { value, tzid: tzMatch ? tzMatch[1].trim() : null };
    };
    const dtStartLine = parseDTLine('DTSTART');
    const dtEndLine   = parseDTLine('DTEND');
    const dtStartRaw  = dtStartLine.value;
    const dtEndRaw    = dtEndLine.value;
    const allDay  = /^DTSTART;VALUE=DATE:/im.test(block);
    const dtstart = dtStartRaw ? formatICSDate(dtStartRaw, allDay, dtStartLine.tzid) : null;
    let   dtend   = dtEndRaw   ? formatICSDate(dtEndRaw,   allDay, dtEndLine.tzid)   : null;
    if (allDay && dtend) {
      const d = new Date(dtend + 'T00:00:00');
      d.setDate(d.getDate() - 1);
      dtend = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    if (!dtend && dtstart) {
      const durMatch = /^DURATION(?:;[^:]*)?:(.*)$/im.exec(block);
      if (durMatch) dtend = applyDuration(dtstart, durMatch[1].trim(), allDay);
    }
    // EXDATE: ausgenommene Einzel-Vorkommen einer Serie (RFC 5545). Mehrere
    // EXDATE-Zeilen und komma-separierte Werte sind erlaubt; TZID/VALUE=DATE
    // werden wie DTSTART aufgelöst und auf das Instanz-Datum (YYYY-MM-DD)
    // reduziert – so matcht die date-basierte Recurrence-Engine (#513/#489).
    const exdates = [];
    const exRe = /^EXDATE((?:;[^:;]*)*):(.*)$/gim;
    let exMatch;
    while ((exMatch = exRe.exec(block)) !== null) {
      const params  = exMatch[1];
      const tzMatch = params.match(/;TZID=([^;:]+)/i);
      const exTz    = tzMatch ? tzMatch[1].trim() : null;
      const isDate  = /;VALUE=DATE(?=[;:]|$)/i.test(params);
      for (const rawVal of exMatch[2].split(',')) {
        const v = rawVal.trim();
        if (!v) continue;
        const conv = formatICSDate(v, isDate, exTz);
        if (conv) exdates.push(conv.slice(0, 10));
      }
    }
    if (!uid || !dtstart) continue;
    events.push({ uid, summary, description, location, dtstart, dtend, rrule, allDay, color, exdates });
  }
  return events;
}

function parseVTODO(ics) {
  const unfolded = unfoldLines(ics);
  const todos    = [];
  const vTodoRe  = /BEGIN:VTODO([\s\S]*?)END:VTODO/g;
  let match;
  while ((match = vTodoRe.exec(unfolded)) !== null) {
    const block = match[1];
    const get   = (prop) => {
      const re = new RegExp(`^${prop}(?:;[^:]*)?:(.*)$`, 'im');
      const m  = re.exec(block);
      return m ? m[1].trim() : null;
    };
    const uid = get('UID');
    if (!uid) continue;
    const summary     = unescapeICSText(get('SUMMARY') || '(kein Titel)');
    const description = unescapeICSText(get('DESCRIPTION')) || null;
    const statusRaw   = (get('STATUS') || '').toUpperCase();
    const completedAt = get('COMPLETED');
    const completed   = statusRaw === 'COMPLETED' || completedAt !== null;
    const status      = statusRaw ? statusRaw.toLowerCase() : (completed ? 'completed' : 'needs-action');
    // DUE date / datetime (reuse VEVENT date-line parsing semantics)
    const dueRe   = /^DUE((?:;[^:;]*)*):(.*)$/im;
    const dueM    = block.match(dueRe);
    let   due     = null;
    if (dueM) {
      const params  = dueM[1];
      const value   = dueM[2].trim();
      const tzMatch = params.match(/;TZID=([^;:]+)/i);
      // (?![-\w]) verhindert, dass "VALUE=DATE-TIME" fälschlich als reines DATE gilt.
      const dateOnly = /;VALUE=DATE(?![-\w])/i.test(params) || /^\d{8}$/.test(value);
      due = formatICSDate(value, dateOnly, tzMatch ? tzMatch[1].trim() : null);
    }
    const prioRaw = get('PRIORITY');
    let priority  = prioRaw !== null ? parseInt(prioRaw, 10) : null;
    if (priority === 0 || Number.isNaN(priority)) priority = null;
    todos.push({ uid, summary, description, completed, status, due, priority });
  }
  return todos;
}

function tzLocalToUTC(localStr, tzid) {
  try {
    const fakeUTC = new Date(localStr + 'Z');
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid, year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
    }).formatToParts(fakeUTC);
    const get = (type) => {
      const part = parts.find(p => p.type === type);
      const v = part ? part.value : '0';
      return v === '24' ? 0 : parseInt(v, 10);
    };
    const tzDisplayedAsUTC = Date.UTC(
      get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')
    );
    const offsetMs = fakeUTC.getTime() - tzDisplayedAsUTC;
    return new Date(fakeUTC.getTime() + offsetMs).toISOString().replace('.000Z', 'Z');
  } catch { return localStr; }
}

function formatICSDate(val, allDay, tzid) {
  if (allDay || /^\d{8}$/.test(val)) {
    return `${val.slice(0, 4)}-${val.slice(4, 6)}-${val.slice(6, 8)}`;
  }
  const y = val.slice(0, 4), mo = val.slice(4, 6), d = val.slice(6, 8);
  const h = val.slice(9, 11), mi = val.slice(11, 13), s = val.slice(13, 15) || '00';
  if (val.endsWith('Z')) return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
  if (tzid) return tzLocalToUTC(`${y}-${mo}-${d}T${h}:${mi}:${s}`, tzid);
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

function applyDuration(dtstart, dur, allDay) {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(dur);
  if (!m) return null;
  const weeks = parseInt(m[1] || '0', 10), days  = parseInt(m[2] || '0', 10);
  const hours = parseInt(m[3] || '0', 10), mins  = parseInt(m[4] || '0', 10);
  const secs  = parseInt(m[5] || '0', 10);
  const base = new Date(dtstart.includes('T') ? dtstart : dtstart + 'T00:00:00');
  base.setDate(base.getDate() + weeks * 7 + days);
  base.setHours(base.getHours() + hours, base.getMinutes() + mins, base.getSeconds() + secs);
  if (allDay) {
    base.setDate(base.getDate() - 1);
    return `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(base.getDate()).padStart(2, '0')}`;
  }
  return base.toISOString().replace('.000Z', 'Z');
}

function expandRRULE(vevent, windowStart, windowEnd) {
  if (!vevent.rrule) return [];
  const results    = [];
  const startDate  = vevent.dtstart.slice(0, 10);
  const timeSuffix = vevent.allDay ? '' : (vevent.dtstart.slice(10) || '');
  let durationMs = null;
  if (vevent.dtend) {
    const s = new Date(vevent.allDay ? vevent.dtstart + 'T00:00:00Z' : vevent.dtstart);
    const e = new Date(vevent.allDay ? vevent.dtend   + 'T00:00:00Z' : vevent.dtend);
    if (!isNaN(s) && !isNaN(e)) durationMs = e - s;
  }
  const countMatch = /;COUNT=(\d+)/i.exec(vevent.rrule);
  const maxCount   = countMatch ? parseInt(countMatch[1], 10) : null;
  // EXDATE zählt für COUNT mit (RFC 5545: COUNT vor Exclusion), erzeugt aber
  // keine Instanz – daher innerhalb der Schleife filtern, nicht die Zählung (#513).
  const exdateSet  = new Set(vevent.exdates || []);
  let current = startDate, iterations = 0;
  const MAX_ITER = 1500;
  while (current <= windowEnd && iterations < MAX_ITER) {
    iterations++;
    if (maxCount !== null && iterations > maxCount) break;

    if (current >= windowStart && !exdateSet.has(current)) {
      const occStart = current + timeSuffix;
      let occEnd = null;
      if (durationMs !== null) {
        if (vevent.allDay) {
          const d = new Date(current + 'T00:00:00Z');
          d.setUTCMilliseconds(d.getUTCMilliseconds() + durationMs);
          occEnd = d.toISOString().slice(0, 10);
        } else {
          occEnd = new Date(new Date(occStart).getTime() + durationMs)
            .toISOString().replace('.000Z', 'Z');
        }
      }
      results.push({
        uid: `${vevent.uid}__${current}`, summary: vevent.summary,
        description: vevent.description, location: vevent.location,
        dtstart: occStart, dtend: occEnd, rrule: null, allDay: vevent.allDay,
        color: vevent.color,
      });
    }
    const next = nextOccurrence(current, vevent.rrule);
    if (!next || next <= current) break;
    current = next;
  }
  return results;
}

export { unfoldLines, unescapeICSText, parseICS, parseVTODO, formatICSDate, tzLocalToUTC, applyDuration, expandRRULE };
