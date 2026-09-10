/**
 * Modul: ICS-Parser
 * Zweck: Gemeinsamer ICS/iCalendar-Parser für Apple Calendar und ICS-Abonnements.
 *        Enthält RFC-5545-konformes Parsing, Zeitzonenkonvertierung und RRULE-Expansion.
 * Abhängigkeiten: server/services/recurrence.js
 */

import { nextOccurrence, matchesRRuleByday, rruleLine } from './recurrence.js';
import { resolveIcalColor } from '../utils/ical-color.js';
import { localToUTC, utcToWall } from '../utils/timezone.js';

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

// Maximal übernommene Tags je Aufgabe und Zeichen je Tag. Die Werte kommen von
// fremden Servern; ohne Deckel wandert ein absurd getaggtes VTODO ungebremst in
// die Datenbank und in jede Filterleiste. Beide Grenzen gelten identisch in der
// Route (server/routes/tasks.js).
const MAX_CATEGORIES = 32;
const MAX_CATEGORY_LEN = 64;

/**
 * CATEGORIES eines Komponenten-Blocks als Liste (#586).
 *
 * Zwei Eigenheiten, die ein naives `get('CATEGORIES')` verfehlt:
 *
 * 1. Die Property darf mehrfach vorkommen. RFC 5545 erlaubt sowohl
 *    `CATEGORIES:a,b` als auch zwei getrennte CATEGORIES-Zeilen, und Clients
 *    nutzen beides. Deshalb alle Vorkommen einsammeln statt nur des ersten.
 * 2. `\,` ist ein escaptes Komma **im Wert**, kein Trenner. Erst am unescapten
 *    Komma splitten, dann jedes Element einzeln unescapen - andersherum zerfiele
 *    ein Tag wie „Haus\, Garten" in zwei.
 */
/**
 * Eine CATEGORIES-Zeile am Trenner-Komma zerlegen.
 *
 * Ein Lookbehind auf ein einzelnes Zeichen reicht dafür nicht: `\\` ist ein
 * escapter Backslash **im Wert**, und `foo\\,bar` meint die Tags `foo\` und
 * `bar`. Der Blick auf nur ein vorangehendes Zeichen sähe dort einen Escape und
 * verweigerte die Trennung. Also Zeichen für Zeichen: eine Escape-Sequenz wird
 * am Stück übernommen, danach ist das nächste Komma wieder ein Trenner.
 */
function splitCategoryList(value) {
  const out = [];
  let current = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\' && i + 1 < value.length) {
      current += ch + value[i + 1];
      i++;
      continue;
    }
    if (ch === ',') { out.push(current); current = ''; continue; }
    current += ch;
  }
  out.push(current);
  return out;
}

function parseCategories(block) {
  const re  = /^CATEGORIES(?:;[^:\n]*)?:(.*)$/gim;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(block)) !== null) {
    for (const raw of splitCategoryList(m[1])) {
      const tag = unescapeICSText(raw.trim())?.trim().slice(0, MAX_CATEGORY_LEN);
      if (!tag) continue;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;   // Groß-/Kleinschreibung eint, erste Schreibweise gewinnt
      seen.add(key);
      out.push(tag);
      if (out.length >= MAX_CATEGORIES) return out;
    }
  }
  return out;
}

// RELATED-TO (RFC 5545 §3.8.4.5) trägt die Unteraufgaben-Beziehung: Apple
// Reminders, Nextcloud Tasks und Tasks.org hängen sie ans KIND und schreiben
// die UID des Elternteils hinein. Der Parameter RELTYPE ist optional und hat
// laut §3.2.15 den Default PARENT - ein RELATED-TO ohne RELTYPE ist also
// bereits die Elternangabe und darf nicht übersehen werden.
//
// Die Gegenrichtung (RELTYPE=CHILD am Elternteil) kommt seltener vor, kostet
// hier aber nur eine Zeile; wer sie schreibt, verlöre seine Hierarchie sonst
// genauso still. SIBLING ist keine Hierarchie und wird verworfen.
function parseRelations(block) {
  const re = /^RELATED-TO((?:;[^:;\n]*)*):(.*)$/gim;
  const childUids = [];
  let parentUid = null;
  let m;
  while ((m = re.exec(block)) !== null) {
    const relType = (/;RELTYPE=([^;:]+)/i.exec(m[1])?.[1] || 'PARENT').trim().toUpperCase();
    const value = unescapeICSText(m[2].trim())?.trim();
    if (!value) continue;
    if (relType === 'PARENT') { if (!parentUid) parentUid = value; }
    else if (relType === 'CHILD' && !childUids.includes(value)) childUids.push(value);
  }
  return { parentUid, childUids };
}

/**
 * @param {string} ics
 * @param {{onSkip?: (info: {uid: string|null, reason: string, summary: string|null}) => void, allowMissingUid?: boolean}} [opts]
 *   `onSkip` meldet jeden VEVENT, den der Parser verwirft. Ohne den Haken war ein
 *   übersprungener Termin von einem nie gelieferten nicht zu unterscheiden: er
 *   fehlte einfach, und der Sync meldete Erfolg (#883).
 *   `allowMissingUid` (Default false, strikt für alle bestehenden Aufrufer):
 *   manche Anbieter-Feeds - insbesondere die kommunaler Entsorgungskalender,
 *   die Waste importiert (#1063) - liefern VEVENTs ganz ohne UID. Mit dieser
 *   Option wird ein fehlendes UID allein NICHT mehr verworfen (DTSTART bleibt
 *   Pflicht); der Aufrufer erhält `uid: null` und ist dafür verantwortlich,
 *   eine eigene deterministische Ersatz-Identität zu bilden - dieser Parser
 *   tut das bewusst nicht, weil eine sinnvolle Ersatz-Identität vom Label
 *   abhängt, das erst der jeweilige Aufrufer kennt.
 */
function parseICS(ics, { onSkip, allowMissingUid = false } = {}) {
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
    const rrule       = get('RRULE')       ? rruleLine(get('RRULE')) : null;
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
    // RECURRENCE-ID (RFC 5545 §3.8.4.4): markiert diesen VEVENT als geändertes
    // Einzel-Vorkommen der Serie mit gleicher UID (nicht als eigene Serie). Auf
    // das Instanz-Datum (YYYY-MM-DD) reduziert – wie EXDATE, damit die
    // date-basierte Recurrence-Engine matcht (#549).
    const recIdLine = parseDTLine('RECURRENCE-ID');
    let recurrenceId = null;
    if (recIdLine.value) {
      const recIsDate = /^\d{8}$/.test(recIdLine.value);
      const conv = formatICSDate(recIdLine.value, recIsDate, recIdLine.tzid);
      recurrenceId = conv ? conv.slice(0, 10) : null;
    }
    if ((!uid && !allowMissingUid) || !dtstart) {
      onSkip?.({ uid, summary: uid ? summary : null, reason: !uid ? 'missing UID' : 'missing or unparsable DTSTART' });
      continue;
    }
    // TZID des Serien-Starts merken (nur zeitgebunden): erlaubt DST-korrekte
    // Expansion, die die lokale Uhrzeit über die Sommer-/Winterzeit hält (#549).
    const tzid = (!allDay && dtStartLine.tzid) ? dtStartLine.tzid : null;
    // CATEGORIES (#1063 Waste): dient Waste als primäres Label für die
    // Import-Zuordnung, wenn der Feed sie führt; sonst fällt der Aufrufer auf
    // SUMMARY zurück. Bestehende Aufrufer ignorieren dieses Feld einfach.
    const categories = parseCategories(block);
    // STATUS:CANCELLED (RFC 5545 §3.8.1.11): ein abgesagtes Vorkommen. Ohne
    // diese Markierung würde Waste eine Absage wie ein normales Vorkommen
    // importieren; der Aufrufer entscheidet, ob/wie er sie ausschließt.
    const status = (/^STATUS(?:;[^:]*)?:(.*)$/im.exec(block)?.[1] || '').trim().toUpperCase() || null;
    // RDATE (RFC 5545 §3.8.5.2) wird von diesem Parser nicht expandiert - nur
    // erkannt. Ein Feed, der zusätzliche Einzeltermine über RDATE statt über
    // eigene VEVENTs einträgt, würde sonst still unvollständig importiert;
    // der Aufrufer entscheidet, ob das den Import blockiert.
    const hasRDate = /^RDATE(?:;[^:]*)?:/im.test(block);
    events.push({ uid, summary, description, location, dtstart, dtend, rrule, allDay, color, exdates, recurrenceId, tzid, categories, status, hasRDate });
  }
  return events;
}

/**
 * Normalisiert die VEVENTs eines Kalenderobjekts/Feeds nach RFC 5545 §3.8.4.4.
 * Ein VEVENT mit RECURRENCE-ID ist ein geändertes Einzel-Vorkommen der Serie mit
 * gleicher UID – KEINE eigene Serie. Ohne Sonderbehandlung upserten alle VEVENTs
 * derselben UID auf dieselbe DB-Zeile: das (RRULE-lose) Override überschreibt die
 * Serie und macht aus der Wochentags-Wiederholung einen Einzeltermin (#549).
 *
 * Ergebnis:
 *  - Master (VEVENT ohne RECURRENCE-ID) behält seine RRULE; sein `exdates`-Set
 *    wird um die RECURRENCE-IDs seiner Overrides ergänzt, damit das ersetzte
 *    Original-Vorkommen unterdrückt wird (sonst Doppel: Original + verschobenes).
 *  - Jedes Override wird zu einem eigenständigen Termin mit eindeutiger
 *    external-UID (`${uid}::${recurrenceId}`) und ohne RRULE – so kollidiert der
 *    UID-basierte Upsert nicht mehr und die verschobene Instanz bleibt sichtbar.
 *
 * Overrides ohne Master (z. B. losgelöste Einzel-Instanz) bleiben als
 * eigenständige Termine erhalten.
 * @param {object[]} events  Ergebnis von parseICS()
 * @returns {object[]}
 */
function normalizeRecurrenceOverrides(events) {
  const groups = new Map();
  const order  = [];
  for (const ev of events) {
    if (!groups.has(ev.uid)) { groups.set(ev.uid, { master: null, overrides: [] }); order.push(ev.uid); }
    const g = groups.get(ev.uid);
    if (ev.recurrenceId) g.overrides.push(ev);
    else if (!g.master)  g.master = ev;
    else                 g.overrides.push(ev); // zweiter Nicht-Override (unüblich) → wie Override behandeln
  }
  const out = [];
  for (const uid of order) {
    const { master, overrides } = groups.get(uid);
    if (master) {
      const exSet = new Set(master.exdates || []);
      for (const ov of overrides) {
        const key = ov.recurrenceId || ov.dtstart?.slice(0, 10);
        if (key) exSet.add(key);
      }
      out.push({ ...master, exdates: [...exSet] });
    }
    for (const ov of overrides) {
      const key = ov.recurrenceId || ov.dtstart?.slice(0, 10);
      out.push({ ...ov, uid: `${uid}::${key}`, rrule: null, exdates: [] });
    }
  }
  return out;
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
    const tags = parseCategories(block);
    const { parentUid, childUids } = parseRelations(block);
    todos.push({ uid, summary, description, completed, status, due, priority, tags, parentUid, childUids });
  }
  return todos;
}

// Beibehaltener Export: delegiert an den geteilten Zeitzonen-Helfer (utils/timezone.js).
function tzLocalToUTC(localStr, tzid) {
  return localToUTC(localStr, tzid);
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
  // DST-korrekte Expansion: bei bekannter TZID pro Vorkommen die lokale Wanduhrzeit
  // des Masters neu nach UTC rechnen, statt den festen UTC-Suffix zu wiederholen
  // (sonst driftet die Uhrzeit über die Sommer-/Winterzeit, #549). Nur für
  // Tagtermine, deren lokales Datum == UTC-Datum ist (kein Mitternachts-Überlauf).
  const wall = vevent.tzid ? utcToWall(vevent.dtstart, vevent.tzid) : null;
  const tzAware = wall && wall.date === startDate;
  const zonenUnsicher = !!vevent.tzid && !tzAware;
  let current = startDate, iterations = 0;
  const MAX_ITER = 1500;
  let occurrence = 0;
  while (current <= windowEnd && iterations < MAX_ITER) {
    iterations++;

    // BYDAY-FILTER VOR DEM ZAEHLEN, EXDATE DANACH (RFC 5545, #513). Ein Tag
    // ausserhalb des Musters ist gar kein Vorkommen der Serie und darf nicht
    // gegen COUNT zaehlen; ein ausgenommenes ist eines und zaehlt mit. Hier
    // zaehlte bis dahin die SCHLEIFE selbst (`iterations > maxCount`), also
    // jeder Kandidat - `FREQ=MONTHLY;BYDAY=MO;COUNT=2` lieferte einen Termin
    // statt zwei. (Dieselbe Aufteilung wie in services/calendar-events.js.)
    if (!matchesRRuleByday(current, vevent.rrule, { utcDiffersFromLocal: zonenUnsicher })) {
      const skip = nextOccurrence(current, vevent.rrule, { anchor: startDate, utcDiffersFromLocal: zonenUnsicher });
      if (!skip || skip <= current) break;
      current = skip;
      continue;
    }

    if (maxCount !== null && occurrence >= maxCount) break;
    occurrence++;

    if (current >= windowStart && !exdateSet.has(current)) {
      const occStart = tzAware ? localToUTC(`${current}T${wall.time}`, vevent.tzid) : current + timeSuffix;
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
    // startDate ist DTSTART und damit der Anker: ohne ihn schreibt eine
    // Klemmung in einem kurzen Monat den Tag der Serie um (#978).
    const next = nextOccurrence(current, vevent.rrule, { anchor: startDate, utcDiffersFromLocal: zonenUnsicher });
    if (!next || next <= current) break;
    current = next;
  }
  return results;
}

export { unfoldLines, unescapeICSText, parseICS, parseVTODO, parseCategories, MAX_CATEGORIES, MAX_CATEGORY_LEN, formatICSDate, tzLocalToUTC, applyDuration, expandRRULE, normalizeRecurrenceOverrides };
