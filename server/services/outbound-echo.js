/**
 * Modul: Echo des eigenen Pushs erkennen (#1956)
 * Zweck: Der Abruf soll eine Serie, die Yuvomi selbst ausgerichtet hinaufgegeben
 *        hat, nicht mit dem eigenen ausgerichteten Start ueberschreiben.
 * Abhaengigkeiten: services/outbound-dtstart.js, services/ics-parser.js,
 *                  utils/timezone.js
 *
 * DAS PROBLEM. Eine hier verfasste Serie "am letzten Tag des Monats", eingegeben
 * am 15. Januar, geht mit dem 31. Januar als Start hinaus (#986, #1935). Der
 * naechste Abruf liest genau diesen Start zurueck und schrieb ihn bisher in die
 * Zeile: die Eingabe war weg, die Marke `series_authored` fiel, und die
 * Erinnerungen zogen um 16 Tage mit (#1377) - ohne dass beim Anbieter jemand
 * etwas getan hatte.
 *
 * WARUM EIN SCHNAPPSCHUSS UND KEINE NACHRECHNUNG. Der erste Versuch (#1953,
 * Rev. 1) rechnete im Abruf nach, was der Push gesendet HAETTE, mit den
 * Eingaben dieses Moments, und verglich die Antwort des Anbieters damit. Jede
 * Eingabe, die zwischen Push und Abruf anders ist oder anders gelesen wird
 * (Zone der Zeile gegen die an Google gesendete, Regel vor und nach dem
 * UNTIL-Umschreiben, eine Zeile ohne Zone), war ein neuer Fall. Hier haelt der
 * Push fest, was er WIRKLICH gesendet hat, im selben Schreibvorgang, der ihn
 * bucht, und dazu den Zeilenstand, aus dem er entstand.
 *
 * DIE DEFINITION. Ein Abruf ist das Echo eines Pushs, wenn
 *   (a) Start, Ende, ganztaegig, Regel und Zone der Zeile seit diesem Push
 *       unveraendert sind (Text, wie er in der Spalte steht), und
 *   (b) der Anbieter fuer diese fuenf Felder genau das zurueckliefert, was der
 *       Push gesendet hat, in der Lesart des Abrufs gelesen: Start und Ende als
 *       derselbe Zeitpunkt (ganztaegig: derselbe Tag), dieselbe Zone, dieselbe
 *       Regel nach `ruleKey` (Praefix weg, Grossschreibung, Teile und
 *       Wertlisten sortiert, sonst nichts).
 * Beim Echo bleiben die fuenf Felder wie eingegeben, die Marke bleibt, die
 * Erinnerungen wandern nicht; alle anderen Felder nimmt der Abruf wie bisher.
 * Alles andere ist eine Aenderung beim Anbieter und geht den bisherigen Weg.
 *
 * Jede Normalisierung, die ein Anbieter vornimmt und die wir nicht kennen (eine
 * andere UNTIL-Form, ein Zonen-Alias, Umrechnung nach UTC, gekappte Sekunden),
 * macht das Paar ungleich: dann gilt der Weg von vorher, und der ist sicher.
 * Eine echte Aenderung beim Anbieter ginge nur verloren, wenn er GENAU unsere
 * Werte zurueckliefert.
 *
 * ZUSCHNITT. Geschrieben wird der Schnappschuss nur, wenn das Ausrichten den
 * Start verschoben hat; sonst steht NULL in der Spalte, und der Abruf schreibt
 * wie bisher. Sein einziger Leser ist der Abruf (Google, CalDAV, iCloud).
 * Wer die Zeile sonst anfasst (Bearbeitung, Serienschnitt, MCP, ein
 * aufgegebener Push), muss die Spalte nicht kennen: aendert sich eines der
 * fuenf Felder, passt (a) nicht mehr, und der Schnappschuss gilt nicht.
 */

import { outboundDateRange, ruleKey } from './outbound-dtstart.js';
import { normalizeRecurrenceOverrides, parseICS } from './ics-parser.js';
import { hasExplicitZone, localToUTCPrecise } from '../utils/timezone.js';

const VERSION = 1;

/**
 * Hat das Ausrichten den Start dieser Zeile verschoben? Mit denselben Optionen,
 * mit denen der ausgehende Weg sie ausrichtet (`zone` nur bei Google).
 *
 * @param {object} row
 * @param {{ zone?: string|null }} [options]
 */
export function alignmentMoved(row, options) {
  if (!row?.start_datetime) return false;
  return outboundDateRange(row, options).start_datetime !== row.start_datetime;
}

/**
 * Ein Zeitwert in der Lesart des Abrufs.
 *
 * Ganztaegig der Tag; ein Wert mit eigener Zone als Zeitpunkt; eine Wanduhrzeit
 * ohne Zone in der Zone, die neben ihr steht (bei Google die gesendete
 * `timeZone`, bei CalDAV die TZID), sonst als Text. Zeitpunkte auf die
 * Millisekunde: eine Sekunde, die der Anbieter kappt, ist ein anderer Wert.
 */
function whenKey(value, allDay, zone) {
  if (value == null || value === '') return null;
  const raw = String(value);
  if (allDay) return `d:${raw.slice(0, 10)}`;
  if (hasExplicitZone(raw)) {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? `i:${ms}` : `t:${raw}`;
  }
  if (zone) {
    const ms = Date.parse(localToUTCPrecise(raw.length === 16 ? `${raw}:00` : raw, zone));
    if (Number.isFinite(ms)) return `i:${ms}`;
  }
  return `w:${raw}`;
}

/**
 * Die fuenf Felder, wie sie der Abruf liest, als vergleichbares Objekt.
 *
 * @param {{start: ?string, end: ?string, allDay: boolean|number, zone: ?string, rule: ?string}} fields
 */
function echoKey({ start, end, allDay, zone, rule }) {
  const ganztags = !!allDay;
  return {
    start: whenKey(start, ganztags, zone),
    end: whenKey(end, ganztags, zone),
    allDay: ganztags ? 1 : 0,
    zone: ganztags ? null : (zone || null),
    rule: rule ? ruleKey(rule) : null,
  };
}

/** Die fuenf Felder der Zeile, als Text, wie sie in den Spalten stehen. */
function rowState(row) {
  return {
    start: row?.start_datetime ?? null,
    end: row?.end_datetime ?? null,
    allDay: row?.all_day ? 1 : 0,
    rule: row?.recurrence_rule ?? null,
    tzid: row?.tzid ?? null,
  };
}

const sameFields = (a, b, keys) => !!a && !!b && keys.every((key) => a[key] === b[key]);
const ROW_KEYS = ['start', 'end', 'allDay', 'rule', 'tzid'];
const SENT_KEYS = ['start', 'end', 'allDay', 'zone', 'rule'];

/**
 * Der Schnappschuss eines Pushs - oder null, wenn das Ausrichten den Start
 * nicht verschoben hat (dann bleibt es beim Weg von vorher).
 *
 * @param {object} row       die Zeile, aus der die Anfrage gebaut wurde
 * @param {object|null} sent was der Abruf aus der gebauten Anfrage lesen wuerde
 *   (`googleReading` / `icsReading`)
 * @param {{ aligned: boolean }} how
 * @returns {string|null} JSON fuer `calendar_events.outbound_snapshot`
 */
export function sentSnapshot(row, sent, { aligned }) {
  if (!aligned || !row || !sent) return null;
  return JSON.stringify({ v: VERSION, row: rowState(row), sent: echoKey(sent) });
}

/**
 * Ist das, was der Abruf gerade liest, das Echo des letzten Pushs?
 *
 * @param {object} row       die Zeile vor dem Abruf, mit `outbound_snapshot`
 *   und den fuenf Feldern
 * @param {object} incoming  was der Abruf liest (`googleReading` / `icsReading`)
 * @returns {boolean}
 */
export function isEcho(row, incoming) {
  const raw = row?.outbound_snapshot;
  if (!raw || !incoming) return false;
  let snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch {
    return false;
  }
  if (snapshot?.v !== VERSION) return false;
  if (!sameFields(rowState(row), snapshot.row, ROW_KEYS)) return false;
  return sameFields(echoKey(incoming), snapshot.sent, SENT_KEYS);
}

/**
 * Die fuenf Felder aus dem, was der Google-Abruf in die Zeile schreibt
 * (`inboundFields` in google-calendar.js).
 */
export function googleReading({ allDay, startDt, endDt, tzid, rrule }) {
  return { start: startDt, end: endDt, allDay, zone: tzid, rule: rrule };
}

/** Die fuenf Felder eines VEVENT, wie ihn der CalDAV- und der iCloud-Abruf liest. */
export function icsReading(ev) {
  if (!ev) return null;
  return { start: ev.dtstart, end: ev.dtend, allDay: ev.allDay, zone: ev.tzid ?? null, rule: ev.rrule };
}

/**
 * Was der CalDAV- und der iCloud-Abruf aus einem gesendeten Kalenderobjekt
 * lesen wuerden: durch denselben Parser wie der Abruf, der Master der UID.
 *
 * @param {string} ics
 * @param {string} uid
 */
export function icsSentReading(ics, uid) {
  const ev = normalizeRecurrenceOverrides(parseICS(String(ics ?? '')))
    .find((candidate) => candidate.uid === uid && !candidate.recurrenceId);
  return icsReading(ev);
}

/**
 * Der Schnappschuss eines CalDAV- oder iCloud-Pushs aus dem gesendeten Objekt.
 *
 * @param {object} row  die Zeile, aus der das Objekt gebaut wurde
 * @param {string} ics  das gesendete Objekt
 * @param {string} uid
 */
export function icsSnapshot(row, ics, uid) {
  const aligned = alignmentMoved(row);
  if (!aligned) return null;
  return sentSnapshot(row, icsSentReading(ics, uid), { aligned });
}
