// --------------------------------------------------------
// Gezieltes Ändern einzelner Properties in einem bestehenden iCalendar-Objekt (#593).
//
// CalDAV kennt kein PATCH: eine Änderung ist immer ein PUT des kompletten
// Kalenderobjekts. Würde Yuvomi das Objekt aus seinen eigenen Feldern neu bauen,
// verlöre ein importierter Termin auf dem Server alles, was Yuvomi nicht kennt -
// Teilnehmer, Erinnerungen, Kategorien, Organisator, Anhänge. Deshalb wird das
// Original bearbeitet statt ersetzt: nur die gespiegelten Properties werden
// getauscht, jede andere Zeile bleibt Zeichen für Zeichen stehen.
// --------------------------------------------------------

import { rruleLine } from '../services/recurrence.js';
import { vtimezoneFor } from './vtimezone.js';

// Properties, die Yuvomi verwaltet und daher ersetzen darf - je Komponente.
//
// COLOR (RFC 7986) kam mit #897 dazu. Es reicht nicht, den Wert auszugeben:
// solange die Property hier fehlt, verwirft der Patcher sie wieder, und ein
// Termin, dem seine Eigenfarbe genommen wurde, behielte die alte auf dem Server.
// Verwaltet heisst deshalb beides - ersetzen UND entfernen.
const MANAGED_VEVENT = new Set([
  'SUMMARY', 'DESCRIPTION', 'LOCATION', 'DTSTART', 'DTEND', 'RRULE', 'COLOR',
]);
// VTODO (#617): STATUS, COMPLETED und PERCENT-COMPLETE gehören zusammen - Clients
// lesen den Erledigt-Zustand mal am einen, mal am anderen ab.
//
// CATEGORIES kam mit den Tags dazu (#586). Verwaltet werden darf es erst,
// seit Yuvomi die vollständige Liste hält: solange nur ein einzelner Wert
// gespiegelt worden wäre, hätte jeder Push die übrigen Tags des Servers
// gelöscht.
//
// RRULE, ihr Anker DTSTART und Yuvomis Marke X-YUVOMI-RRULE kamen mit #2350
// dazu: eine wiederkehrende Aufgabe ging ohne ihre Regel hinaus. Ersetzt oder
// entfernt wird jede nur, wenn der Aufrufer das Feld mitgibt - an einer fremden
// Serie laesst icsFieldsForTask sie weg (caldav-todo-outbound.js).
const MANAGED_VTODO = new Set([
  'SUMMARY', 'DESCRIPTION', 'DUE', 'PRIORITY', 'STATUS', 'COMPLETED', 'PERCENT-COMPLETE',
  'CATEGORIES', 'RRULE', 'DTSTART', 'X-YUVOMI-RRULE',
]);

// Properties, deren Wert eine kommaseparierte Liste ist.
const LIST_VALUED = new Set(['CATEGORIES']);

// Properties, deren Parameter sich mit dem Wert ändern (VALUE=DATE, TZID) und die
// ihre Parameter deshalb selbst mitbringen: { value, params }.
const PARAMETRIC = new Set(['DTSTART', 'DTEND', 'DUE']);

/** RFC 5545 §3.1: Fortsetzungszeilen beginnen mit Space oder Tab. */
export function unfoldICS(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

/** Zeilen > 75 Oktette falten, damit strenge Server das Objekt annehmen. */
export function foldICSLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const parts = [];
  let start = 0;
  while (start < bytes.length) {
    // Nie mitten in ein Mehrbyte-Zeichen schneiden: rückwärts bis zum Beginn
    // eines UTF-8-Zeichens gehen (Folgebytes sind 10xxxxxx).
    let end = Math.min(start + (parts.length === 0 ? 75 : 74), bytes.length);
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push((parts.length === 0 ? '' : ' ') + bytes.subarray(start, end).toString('utf8'));
    start = end;
  }
  return parts.join('\r\n');
}

function propertyName(line) {
  const cut = line.search(/[;:]/);
  return (cut === -1 ? line : line.slice(0, cut)).toUpperCase();
}

function escapeText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Baut die Ersatzzeilen für ein Feld. `null`/`undefined` heißt "Property entfernen".
 * DTSTART/DTEND/DUE tragen ihre Parameter selbst (VALUE=DATE bzw. TZID), weil sich
 * Ganztägigkeit und Zone mit dem Wert ändern können.
 */
function buildLines(name, value) {
  if (value === null || value === undefined || value === '') return [];
  if (PARAMETRIC.has(name)) {
    const { value: v, params = '' } = value;
    if (!v) return [];
    return [`${name}${params}:${v}`];
  }
  // Listen-Properties: das Komma trennt hier die Werte, escapeText würde es zum
  // Bestandteil eines einzigen Wertes machen. Also jedes Element für sich
  // escapen (ein Komma **im** Wert bleibt dabei escaped) und dann verbinden.
  if (LIST_VALUED.has(name)) {
    const items = (Array.isArray(value) ? value : [value])
      .map((item) => String(item ?? '').trim())
      .filter(Boolean);
    if (!items.length) return [];   // leere Liste = Property entfernen
    return [`${name}:${items.map(escapeText).join(',')}`];
  }
  if (name === 'RRULE') {
    return [rruleLine(value)];
  }
  return [`${name}:${escapeText(value)}`];
}

/**
 * Ersetzt die verwalteten Properties einer Komponente in einem iCalendar-Objekt.
 *
 * Angefasst wird ausschließlich die Komponente mit der passenden UID **ohne**
 * RECURRENCE-ID, also der Serien-Master bzw. der Einzeleintrag. Ausnahme-Vorkommen
 * derselben UID (RECURRENCE-ID-Overrides) liegen in derselben Datei und bleiben
 * unberührt - sie tragen eigene Werte, die kein Master-Update überschreiben darf.
 *
 * @param {string} icsText    Originales Kalenderobjekt vom Server
 * @param {string} uid        UID der zu ändernden Komponente
 * @param {object} fields     Property-Name → Wert; { value, params } für DTSTART/DTEND/DUE,
 *                            sonst String. null entfernt die Property.
 * @param {string} component  'VEVENT' | 'VTODO'
 * @param {Set}    managed    Properties, die ersetzt werden dürfen
 * @returns {string|null}     Neues Objekt, oder null wenn keine passende Komponente existiert.
 */
function patchICSComponent(icsText, uid, fields, component, managed) {
  const lines = unfoldICS(icsText).split('\n');
  const begin = `BEGIN:${component}`;
  const end   = `END:${component}`;

  // Komponenten-Blöcke abgrenzen
  const blocks = [];
  let current = null;
  lines.forEach((line, index) => {
    const trimmed = line.trim().toUpperCase();
    if (trimmed === begin) {
      current = { start: index, end: -1 };
    } else if (trimmed === end && current) {
      current.end = index;
      blocks.push(current);
      current = null;
    }
  });

  const target = blocks.find((block) => {
    let uidMatch = false;
    let isOverride = false;
    for (let i = block.start + 1; i < block.end; i++) {
      const name = propertyName(lines[i]);
      if (name === 'UID' && lines[i].slice(lines[i].indexOf(':') + 1).trim() === uid) uidMatch = true;
      if (name === 'RECURRENCE-ID') isOverride = true;
    }
    return uidMatch && !isOverride;
  });
  if (!target) return null;

  const replacements = new Map();
  for (const [name, value] of Object.entries(fields)) {
    const upper = name.toUpperCase();
    if (managed.has(upper)) replacements.set(upper, buildLines(upper, value));
  }

  // Neue Properties müssen VOR die erste Subkomponente (typischerweise VALARM):
  // RFC 5545 ordnet einer Komponente erst ihre Properties, dann ihre Alarme zu, und
  // strenge Parser weisen ein DESCRIPTION hinter END:VALARM zurück.
  let insertAt = target.end;
  for (let i = target.start + 1; i < target.end; i++) {
    if (lines[i].trim().toUpperCase().startsWith('BEGIN:')) { insertAt = i; break; }
  }

  const out = [];
  const written = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (i === insertAt) {
      // Was das Original nicht hatte, hier ergänzen.
      for (const [name, replacement] of replacements) {
        if (!written.has(name) && replacement.length) {
          out.push(...replacement);
          written.add(name);
        }
      }
      if (!written.has('SEQUENCE')) {
        out.push('SEQUENCE:1');
        written.add('SEQUENCE');
      }
    }

    const inTarget = i > target.start && i < target.end;
    if (!inTarget) {
      out.push(lines[i]);
      continue;
    }

    const name = propertyName(lines[i]);

    if (name === 'DTSTAMP') {
      out.push(`DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`);
      written.add('DTSTAMP');
      continue;
    }
    // SEQUENCE hochzählen: Clients erkennen daran, dass ihre Kopie veraltet ist.
    if (name === 'SEQUENCE') {
      const n = parseInt(lines[i].slice(lines[i].indexOf(':') + 1), 10);
      out.push(`SEQUENCE:${Number.isFinite(n) ? n + 1 : 1}`);
      written.add('SEQUENCE');
      continue;
    }

    if (replacements.has(name)) {
      // Erste Fundstelle ersetzen, weitere Duplikate fallen weg.
      if (!written.has(name)) {
        out.push(...replacements.get(name));
        written.add(name);
      }
      continue;
    }

    out.push(lines[i]);
  }

  return out.map(foldICSLine).join('\r\n');
}

/**
 * Haengt floating EXDATE- und RECURRENCE-ID-Werten dieselbe Zone an wie dem Master.
 *
 * WARUM DAS ZUSAMMENGEHOERT (#938). Ein Vorkommen wird ueber seinen Zeitwert
 * identifiziert, nicht ueber einen Index: `EXDATE:20260906T100000` streicht das
 * Vorkommen, das genau diesen Wert hat, und ein `RECURRENCE-ID` mit demselben
 * Wert bindet einen Ausnahmetermin an dieses Vorkommen. Beide Werte muessen im
 * selben Bezugssystem stehen wie das DTSTART der Serie.
 *
 * Hebt man nur den Master von floating auf `;TZID=`, zeigen die Bezeichner ins
 * Leere: der gestrichene Termin taucht wieder auf, und der bearbeitete
 * Einzeltermin loest sich von seiner Serie - beides ausgeloest von einer
 * Aenderung, die mit Serien nichts zu tun hatte.
 *
 * Angefasst wird nur, was floating IST. Ein Wert mit eigenem `TZID`, einem `Z`
 * oder `VALUE=DATE` trug seinen Bezug schon vorher und behaelt ihn.
 *
 * @param {string[]} lines Entfaltete Zeilen des ganzen Objekts
 * @param {string} uid     UID, deren Komponenten angefasst werden
 * @param {string} tzid    Zone, die der Master bekommen hat
 * @returns {string[]}
 */
function anchorFloatingOccurrenceIds(lines, uid, tzid) {
  const isFloating = (line) => {
    const head = line.slice(0, line.indexOf(':'));
    if (/TZID=/i.test(head) || /VALUE=DATE/i.test(head)) return false;
    // Ein Z am Ende irgendeines Wertes heisst UTC - dann ist der Wert eindeutig.
    return !/Z(?:,|$)/.test(line.slice(line.indexOf(':') + 1).trim());
  };

  const out = [...lines];
  let start = -1;
  let uidMatch = false;
  lines.forEach((line, i) => {
    const trimmed = line.trim().toUpperCase();
    if (trimmed === 'BEGIN:VEVENT') { start = i; uidMatch = false; return; }
    if (start < 0) return;
    if (propertyName(line) === 'UID') {
      uidMatch = line.slice(line.indexOf(':') + 1).trim() === uid;
      return;
    }
    if (trimmed === 'END:VEVENT') { start = -1; return; }
    const name = propertyName(line);
    if (!uidMatch || (name !== 'EXDATE' && name !== 'RECURRENCE-ID')) return;
    if (!isFloating(line)) return;
    const colon = line.indexOf(':');
    out[i] = `${line.slice(0, colon)};TZID=${tzid}${line.slice(colon)}`;
  });
  return out;
}

/**
 * Sorgt dafuer, dass das VCALENDAR ein VTIMEZONE fuer `tzid` enthaelt.
 *
 * RFC 5545 §3.2.19 laesst einen TZID-Parameter nur zu, wenn im selben VCALENDAR
 * ein VTIMEZONE mit dieser Kennung steht. Yuvomi schrieb sein `;TZID=` fuer
 * wiederkehrende Serien bereits vorher, den Block aber nie (#938) - iOS und eM
 * Client verzeihen das, ein strenger Server darf das Objekt zurueckweisen.
 *
 * Der Block kommt VOR die erste Komponente. Das verlangt der Standard nicht,
 * aber Parser, die einmal von vorn lesen, brauchen die Zone, bevor das erste
 * DTSTART sie benutzt.
 *
 * @param {string} icsText
 * @param {string|null} tzid  IANA-Zone; null/leer laesst den Text unveraendert
 * @returns {string}
 */
export function ensureVTimezone(icsText, tzid, year = null) {
  if (!tzid) return String(icsText);
  const lines = unfoldICS(icsText).split('\n');

  // Schon vorhanden? Ein zweiter Block mit derselben TZID waere ein Fehler,
  // kein Zusatz. Verglichen wird der Wert der TZID-Zeile innerhalb eines
  // VTIMEZONE - ein `TZID=` als Parameter an einem DTSTART zaehlt nicht.
  let inVTimezone = false;
  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper === 'BEGIN:VTIMEZONE') { inVTimezone = true; continue; }
    if (upper === 'END:VTIMEZONE') { inVTimezone = false; continue; }
    if (inVTimezone && upper.startsWith('TZID:')
      && line.trim().slice(5).trim() === tzid) return String(icsText);
  }

  // Das Jahr, fuer das die Uebergaenge gerechnet werden. Die erzeugten Regeln
  // sind RRULE-basiert und gelten damit auch fuer spaetere Jahre; das Jahr des
  // Termins trifft nur die Feinheit, welche historische Regel gilt.
  //
  // Es kommt vom AUFRUFER, aus dem Wert, den er gerade schreibt. Die erste
  // Fassung suchte stattdessen die erste `DTSTART`-Zeile im Text - und traf
  // damit den Onset eines schon vorhandenen VTIMEZONE, wenn eins dastand. Die
  // sind ueblicherweise auf 1970 datiert, und fuer 1970 kennt Europe/Berlin
  // keine Sommerzeit: herausgekommen waere ein fester +0100-Block, unter dem
  // jeder Sommertermin eine Stunde zu spaet gelesen wird. Genau dieser Griff
  // ins falsche DTSTART ist der Testfassung dieses Fixes schon einmal
  // passiert; im Produktivcode blieb er stehen.
  const resolvedYear = Number.isInteger(year) ? year : new Date().getUTCFullYear();

  const block = vtimezoneFor(tzid, resolvedYear).map(foldICSLine);

  // Einfuegepunkt: vor der ersten Komponente im VCALENDAR.
  let at = lines.findIndex((l) => /^BEGIN:(?!VCALENDAR)/i.test(l.trim()));
  if (at < 0) at = Math.max(lines.length - 1, 0); // nur END:VCALENDAR uebrig

  return [...lines.slice(0, at), ...block, ...lines.slice(at)]
    .map(foldICSLine).join('\r\n');
}

/**
 * Ersetzt die verwalteten Properties eines VEVENT (#593).
 *
 * @param {string} icsText
 * @param {string} uid
 * @param {object} fields { SUMMARY, DESCRIPTION, LOCATION, DTSTART, DTEND, RRULE }
 * @param {object} [options]
 * @param {string|null} [options.tzid] Zone, die DTSTART/DTEND per TZID nennen.
 *        Ihr VTIMEZONE wird mitgeschrieben, falls es fehlt - die beiden gehoeren
 *        zusammen, und getrennt vergisst ein Aufrufer frueher oder spaeter das
 *        zweite (#938).
 */
export function patchICSEvent(icsText, uid, fields = {}, { tzid = null } = {}) {
  const patched = patchICSComponent(icsText, uid, fields, 'VEVENT', MANAGED_VEVENT);
  if (patched === null) return null;

  // Ausnahmen und Ueberschreibungen bezeichnen ihr Vorkommen ueber den Zeitwert.
  // Bekommt der Master eine Zone, muessen sie mitgehen, sonst treffen sie nichts
  // mehr (#938).
  const anchored = tzid
    ? anchorFloatingOccurrenceIds(unfoldICS(patched).split('\n'), uid, tzid)
      .map(foldICSLine).join('\r\n')
    : patched;

  // Das Jahr aus dem Wert, den wir gerade geschrieben haben - die einzige
  // eindeutige Quelle. Im Text danach zu suchen trifft fremde VTIMEZONE-Onsets.
  const year = Number.parseInt(String(fields?.DTSTART?.value || '').slice(0, 4), 10);
  return ensureVTimezone(anchored, tzid, Number.isInteger(year) ? year : null);
}

/**
 * Ersetzt die verwalteten Properties eines VTODO (#617).
 *
 * Nennt DUE eine Zone, kommt ihr VTIMEZONE mit (#2374): die Zone steht schon im
 * Feld, und ein TZID ohne Block ist ein ungueltiges Objekt (#938). DTSTART traegt
 * dieselbe Zone wie DUE (`seriesAnchor`).
 *
 * @param {object} fields { SUMMARY, DESCRIPTION, DUE, PRIORITY, STATUS, COMPLETED, PERCENT-COMPLETE }
 */
export function patchICSTodo(icsText, uid, fields = {}) {
  const patched = patchICSComponent(icsText, uid, fields, 'VTODO', MANAGED_VTODO);
  const tzid = /;TZID=([^;:]+)/.exec(fields?.DUE?.params ?? '')?.[1];
  if (patched === null || !tzid) return patched;
  return ensureVTimezone(patched, tzid, Number.parseInt(fields.DUE.value.slice(0, 4), 10));
}

/** Zählt die VEVENT-Blöcke eines Objekts (Master + Overrides). */
export function countVEvents(icsText) {
  const matches = unfoldICS(icsText).match(/^BEGIN:VEVENT\s*$/gim);
  return matches ? matches.length : 0;
}
