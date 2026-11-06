/**
 * Modul: ICS-Parser
 * Zweck: Gemeinsamer ICS/iCalendar-Parser für Apple Calendar und ICS-Abonnements.
 *        Enthält RFC-5545-konformes Parsing, Zeitzonenkonvertierung und RRULE-Expansion.
 * Abhängigkeiten: server/services/recurrence.js
 */

import {
  nextOccurrence, matchesRRuleByday, rruleLine, parseRRule, untilInstantMs,
} from './recurrence.js';
import { resolveIcalColor } from '../utils/ical-color.js';
import { hasExplicitZone, localToUTC, localToUTCOccurrence, utcToWall } from '../utils/timezone.js';
import { instantKey, rawOccurrenceKey } from './imported-occurrence-key.js';

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

// Wert einer Property im Block. Der Doppelpunkt vor dem Wert ist der erste
// ausserhalb eines gequoteten Parameters: ALTREP="data:text/html,..." enthaelt
// selbst Doppelpunkte und darf den Wert nicht abschneiden (#2189).
function propertyValue(block, prop) {
  const lines  = block.split(/\r?\n/);
  const needle = prop.toUpperCase();
  for (const line of lines) {
    if (!line.toUpperCase().startsWith(needle)) continue;
    const after = line[needle.length];
    if (after !== ':' && after !== ';') continue;
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') inQuotes = !inQuotes;
      if (ch === ':' && !inQuotes) return line.slice(i + 1).trim();
    }
  }
  return null;
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
    const get = (prop) => propertyValue(block, prop);
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
    //
    // Seit #2034 Schritt 5 kommt der ROHWERT mit (`exdateRaws`): der UTC-Tag
    // in `exdates` sagt nicht, welches Vorkommen gemeint ist, sobald Ortstag
    // und UTC-Tag auseinandergehen (#2000). Den Schluessel daraus macht
    // services/imported-occurrence-key.js; `exdates` bleibt die alte Form, an
    // der das Heilen die Zeile von frueher erkennt.
    const exdates = [];
    const exdateRaws = [];
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
        if (conv) {
          exdates.push(conv.slice(0, 10));
          exdateRaws.push({ value: v, tzid: exTz, isDate, legacy: conv.slice(0, 10) });
        }
      }
    }
    // RECURRENCE-ID (RFC 5545 §3.8.4.4): markiert diesen VEVENT als geändertes
    // Einzel-Vorkommen der Serie mit gleicher UID (nicht als eigene Serie). Auf
    // das Instanz-Datum (YYYY-MM-DD) reduziert – wie EXDATE, damit die
    // date-basierte Recurrence-Engine matcht (#549).
    const recIdLine = parseDTLine('RECURRENCE-ID');
    let recurrenceId = null;
    let recurrenceIdRaw = null;
    if (recIdLine.value) {
      const recIsDate = /^\d{8}$/.test(recIdLine.value);
      const conv = formatICSDate(recIdLine.value, recIsDate, recIdLine.tzid);
      recurrenceId = conv ? conv.slice(0, 10) : null;
      // Der Rohwert fuer den Schluessel der Ausnahme am Master (#2034 Schritt
      // 5). Die UID des Einzelvorkommens (`${uid}::${recurrenceId}`) bleibt
      // in der alten Form: an ihr haengen gespiegelte Zeilen und Auftraege.
      if (recurrenceId) {
        recurrenceIdRaw = { value: recIdLine.value, tzid: recIdLine.tzid, isDate: recIsDate, legacy: recurrenceId };
      }
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
    // Ob der VEVENT eine COLOR-Zeile TRAEGT, unabhaengig davon, ob ihr Wert
    // lesbar ist: `color` ist null fuer "keine Zeile" wie fuer "Wert
    // unbekannt" (etwa #RRGGBBAA). Die Farb-Heilung des CalDAV-Syncs (#1270)
    // braucht den Unterschied - eine vorhandene Zeile heisst, der Server
    // spricht ueber DIESEN Termin.
    const hasColor = get('COLOR') !== null;
    events.push({ uid, summary, description, location, dtstart, dtend, rrule, allDay, color, hasColor, exdates, exdateRaws, recurrenceId, recurrenceIdRaw, tzid, categories, status, hasRDate });
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
      // Dieselben Ausnahmen mit Rohwert (#2034 Schritt 5): ein ersetztes
      // Vorkommen traegt seine RECURRENCE-ID; ein zweiter VEVENT ohne sie
      // nur den alten Tag, und der wirkt wie bisher.
      const exRaws = [...(master.exdateRaws
        ?? (master.exdates || []).map((legacy) => ({ value: null, legacy })))];
      for (const ov of overrides) {
        const key = ov.recurrenceId || ov.dtstart?.slice(0, 10);
        if (key) {
          exSet.add(key);
          exRaws.push(ov.recurrenceIdRaw ?? { value: null, legacy: key });
        }
      }
      out.push({ ...master, exdates: [...exSet], exdateRaws: exRaws });
    }
    for (const ov of overrides) {
      const key = ov.recurrenceId || ov.dtstart?.slice(0, 10);
      // `seriesUid`: der Sync findet darüber die Serie, deren Zuweisung eine
      // neu angelegte Ausnahme erbt (#2202). Nur gesetzt, wenn das Objekt die
      // Serie selbst mitliefert - eine losgelöste Instanz hat keine.
      out.push({ ...ov, uid: `${uid}::${key}`, rrule: null, exdates: [], exdateRaws: [], seriesUid: master ? uid : null });
    }
  }
  return out;
}

/**
 * COMPLETED eines VTODO als ISO-Zeitpunkt (`YYYY-MM-DDTHH:MM:SSZ`), oder null.
 *
 * RFC 5545 schreibt für COMPLETED UTC vor (3.8.2.1). Nur diese Form wird
 * übernommen: eine Wanduhrzeit ohne Zone wäre ein geratener Zeitpunkt, und für
 * den Verlauf ist "beim Sync bemerkt" (null, der Aufrufer nimmt jetzt) die
 * ehrlichere Antwort als ein um den Zonenversatz verschobener Haken (#1836).
 */
function completedInstant(raw) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/i.exec(String(raw || '').trim());
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  // Rundreise statt Date.parse allein: der 30. Februar oder Stunde 24 werden
  // dort still zu einem anderen Tag, gespeichert waere aber der Rohtext - und
  // den vergleicht SQL als Text (Verlauf, "heute erledigt").
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z') === iso ? iso : null;
}

function parseVTODO(ics) {
  const unfolded = unfoldLines(ics);
  const todos    = [];
  const vTodoRe  = /BEGIN:VTODO([\s\S]*?)END:VTODO/g;
  let match;
  while ((match = vTodoRe.exec(unfolded)) !== null) {
    const block = match[1];
    const get = (prop) => propertyValue(block, prop);
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
    todos.push({
      uid, summary, description, completed, completedAt: completedInstant(completedAt),
      status, due, priority, tags, parentUid, childUids,
    });
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
  // DST-korrekte Expansion: bei bekannter TZID pro Vorkommen die lokale Wanduhrzeit
  // des Masters neu nach UTC rechnen, statt den festen UTC-Suffix zu wiederholen
  // (sonst driftet die Uhrzeit über die Sommer-/Winterzeit, #549). Nur für
  // Tagtermine, deren lokales Datum == UTC-Datum ist (kein Mitternachts-Überlauf).
  const wall = vevent.tzid ? utcToWall(vevent.dtstart, vevent.tzid) : null;
  const tzAware = wall && wall.date === startDate;
  const zonenUnsicher = !!vevent.tzid && !tzAware;
  // EXDATE zählt für COUNT mit (RFC 5545: COUNT vor Exclusion), erzeugt aber
  // keine Instanz – daher innerhalb der Schleife filtern, nicht die Zählung (#513).
  //
  // WELCHES VORKOMMEN EINE ABSAGE MEINT (#2000, #2034 Schritt 5). Die Schleife
  // laeuft bei `tzAware` auf ORTSTAGEN, der alte Schluessel einer Absage ist
  // ihr UTC-Tag: New York 19:30 im Winter liegt auf dem UTC-Folgetag, Berlin
  // 01:30 nach der Umstellung auf dem UTC-Vortag - die Absage traf nichts oder
  // den Nachbarn. Dort zaehlt deshalb der Originalstart (`exactKeys`). Sonst
  // laeuft die Schleife auf denselben Tagen, die der alte Schluessel nennt
  // (UTC-Tag, Wanduhr ohne Zone, ganztaegig), und es bleibt beim Tag.
  const exactKeys = new Set();
  const exdateSet = new Set();
  const exRaws = Array.isArray(vevent.exdateRaws)
    ? vevent.exdateRaws
    : (vevent.exdates || []).map((legacy) => ({ value: null, legacy }));
  // Ein Originalstart zaehlt nur, wenn die Schleife ihn an seinem Ortstag selbst
  // erzeugt (Review zu #2300): faellt DTSTART in eine Umstellung, liest
  // `formatICSDate` den Start mit der alten Uhr, die Vorkommen stehen dann eine
  // Stunde neben der Absage - dort bleibt es beim alten Tag, wie auf main.
  const loopMakes = (key) => {
    const day = utcToWall(key, vevent.tzid)?.date;
    return !!day && instantKey(localToUTCOccurrence(`${day}T${wall.time}`, vevent.tzid)) === key;
  };
  for (const raw of exRaws) {
    const key = (tzAware && !vevent.allDay && raw.value) ? rawOccurrenceKey(raw, vevent.tzid) : null;
    if (key && key.length > 10 && loopMakes(key)) exactKeys.add(key);
    else if (raw.legacy) exdateSet.add(raw.legacy);
  }
  // UNTIL ALS ZEITPUNKT, WO ES EINER IST (#1269) - dieselbe Unterscheidung wie
  // in services/calendar-events.js und aus demselben Grund: ein Serienende
  // mitten am Schnitttag darf dessen Vorkommen nicht mehr durchlassen. Der
  // Abonnement-Pfad liest dieselben fremden Kalender wie der CalDAV-Sync.
  const untilMs = untilInstantMs(parseRRule(vevent.rrule), { tzid: vevent.tzid, toUTC: localToUTCOccurrence });
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

    // Vorkommen hinter UNTIL sind keine und zaehlen auch nicht gegen COUNT -
    // deshalb vor dem Zaehler. Nur mit eigener Zone ist ein Zeitpunkt zu
    // vergleichen; ganztaegig oder zonenlos bleibt es beim Tag (#1269).
    const occStartAt = untilMs === null
      ? null
      : (tzAware ? localToUTCOccurrence(`${current}T${wall.time}`, vevent.tzid) : current + timeSuffix);
    if (occStartAt !== null && hasExplicitZone(occStartAt) && Date.parse(occStartAt) > untilMs) break;

    if (maxCount !== null && occurrence >= maxCount) break;
    occurrence++;

    const occStart = current >= windowStart && !exdateSet.has(current)
      ? (occStartAt ?? (tzAware ? localToUTCOccurrence(`${current}T${wall.time}`, vevent.tzid) : current + timeSuffix))
      : null;
    if (occStart !== null && !(exactKeys.size && exactKeys.has(instantKey(occStart)))) {
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
