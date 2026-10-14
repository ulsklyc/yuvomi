/**
 * Modul: Zeitangaben ausgehender Kalenderobjekte
 * Zweck: Bestimmt fuer ein Event die DTSTART/DTEND-Werte samt Parametern und
 *        sagt, welche Zone dafuer ein VTIMEZONE braucht.
 *
 * WARUM ES DAS GIBT (#938). Ein Termin geht auf drei Wegen aus Yuvomi hinaus:
 * als Neuanlage ueber caldav-sync.js, als Neuanlage ueber apple-calendar.js und
 * als Aenderung ueber caldav-outbound.js/ics-patch.js. Alle drei schrieben ihre
 * Zeiten selbst, und alle drei schrieben sie fuer lokal angelegte Termine ohne
 * jede Zonenangabe hinaus:
 *
 *     DTSTART:20260830T100000
 *
 * Das ist "floating time" und laut RFC 5545 gueltig - es heisst "10 Uhr auf der
 * Uhr dessen, der es liest". Gemeint war aber 10 Uhr auf der Uhr des Haushalts.
 * iOS und eM Client raten richtig, weil sie die Systemzone einsetzen; Synology
 * und DAViCal nehmen das Objekt an, geben es unveraendert zurueck und zeigen es
 * in ihrer eigenen Oberflaeche gar nicht erst an, weil ihr Index einen Zeitpunkt
 * braucht und keinen hat.
 *
 * Der ICS-Feed hat dieselbe Frage schon beantwortet (#818): Ziffern ohne Offset
 * meinen die Uhr des Haushalts, also tragen sie dessen Zone. Hier gilt dieselbe
 * Antwort - und dieselbe Ausnahme fuer Serien (#549), deren Zone am Event haengt.
 *
 * Die zweite Haelfte von #938 ist die unsichtbare: RFC 5545 verlangt zu JEDEM
 * TZID-Parameter ein VTIMEZONE im selben VCALENDAR. Der Serien-Pfad schrieb sein
 * TZID schon vorher, den Block aber nie - strenge Server duerfen so ein Objekt
 * zurueckweisen. Deshalb liefert dieses Modul die Zone mit zurueck, statt sie
 * dem Aufrufer zu ueberlassen.
 *
 * Abhaengigkeiten: server/utils/timezone.js, server/utils/vtimezone.js,
 *                  server/utils/ics-format.js
 */

import { isValidTimeZone, storedToInstantIso } from './timezone.js';
import { formatWall } from './vtimezone.js';
import { toICSDatetime } from './ics-format.js';
import { timedSeriesUntil } from './rrule-until.js';

/** Traegt der gespeicherte Wert selbst ein Z oder ein +hh:mm? */
export function hasExplicitOffset(value) {
  return /Z$|[+-]\d{2}:?\d{2}$/.test(String(value || ''));
}

/**
 * Die Zone, an der naive Werte verankert werden - oder null.
 *
 * null heisst "die Ziffern sind bereits UTC": Fuer eine Zone, die UTC gleicht,
 * ist ein 'Z' eindeutiger als ein VTIMEZONE ueber 'Etc/UTC', das nicht jeder
 * Client als Zone fuehrt. Dasselbe fuer eine Zone, die dieser Node-Build nicht
 * kennt - ein TZID, zu dem wir keinen Block bauen koennen, waere schlechter als
 * gar keins.
 */
export function anchorZone(tz) {
  const zone = String(tz || '').trim();
  if (!zone) return null;
  if (/^(UTC|GMT|Z|Etc\/(UTC|GMT|GMT0|GMT\+0|GMT-0|Zulu|Universal|Greenwich))$/i.test(zone)) return null;
  return isValidTimeZone(zone) ? zone : null;
}

/** Ganztags-Datum 'YYYYMMDD' aus einem gespeicherten Wert. */
function dateOnly(value) {
  return String(value).slice(0, 10).replace(/-/g, '');
}

/** Ganztags-DTEND ist exklusiv: gespeichert ist der letzte sichtbare Tag. */
function dateOnlyExclusive(value) {
  const d = new Date(String(value).slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/**
 * DTSTART/DTEND eines Events fuer den ausgehenden Weg.
 *
 * @param {object} event         Zeile aus calendar_events
 * @param {string|null} householdZone  IANA-Zone des Haushalts (aus householdTimeZone)
 * @returns {{ dtstart: {value:string, params:string},
 *             dtend: {value:string, params:string},
 *             tzid: string|null }}  tzid ist die Zone, fuer die der Aufrufer ein
 *             VTIMEZONE mitschicken muss - null, wenn keins noetig ist.
 */
export function eventDateTimeFields(event, householdZone = null) {
  const endSource = event.end_datetime || event.start_datetime;

  // 1. Ganztaegig: ein Datum hat keine Zone, und VALUE=DATE ist genau das.
  if (event.all_day) {
    return {
      dtstart: { value: dateOnly(event.start_datetime), params: ';VALUE=DATE' },
      dtend:   { value: dateOnlyExclusive(endSource),   params: ';VALUE=DATE' },
      tzid: null,
    };
  }

  const zoneOfEvent = anchorZone(event.tzid);
  const naive = !hasExplicitOffset(event.start_datetime);

  // JEDER ENDPUNKT FUER SICH. Start und Ende koennen unterschiedlich gespeichert
  // sein - die optionale PUT-API laesst eine importierte, zonierte Serie mit
  // einem neuen, naiven `end_datetime` zurueck, waehrend der Start sein `Z`
  // behaelt. Wer beide nach dem Start klassifiziert, schickt den naiven Wert
  // durch `formatWall`, das einen UTC-Instant erwartet: auf einem UTC-Server
  // wird aus einem gemeinten 11:00 in Berlin ein 13:00.
  //
  // Ein Wert mit Offset ist ein Zeitpunkt und wird in die Zone gerechnet.
  //
  // ZONENLOSE ZIFFERN NEBEN EINER TZID SIND WANDUHR DES HAUSHALTS (#1993). So
  // schreibt sie PUT, wenn eine eingelesene Serie aus dem Formular gespeichert
  // wird; die `tzid` bleibt dabei stehen. Bis hierher gingen die Ziffern roh
  // mit `TZID=<tzid>` hinaus - in Berlin eingegebene 08:30 standen beim
  // Empfaenger als 08:30 in Los Angeles. Jetzt werden sie in der
  // Haushaltszone zum Zeitpunkt und von dort zur Wanduhr der Serienzone,
  // dieselbe Lesart wie Expansion und Feed.
  const inEventZone = (value) => {
    if (hasExplicitOffset(value)) return formatWall(value, zoneOfEvent);
    // Ohne Haushaltszone wirft `storedToInstantIso`: kein stiller Rueckfall.
    const instant = storedToInstantIso(value, householdZone);
    return instant ? formatWall(instant, zoneOfEvent) : toICSDatetime(value);
  };

  // Dasselbe fuer den UTC-Pfad: ein naiver Wert neben einem Instant ist als UTC
  // gemeint (das sagt der Zweig, in dem er steht) und braucht sein eigenes Z.
  const utc = (value) => (hasExplicitOffset(value)
    ? toICSDatetime(value)
    : `${toICSDatetime(value)}Z`);

  // 2. Serie mit eigener Zone: lokale Wanduhrzeit + TZID, damit der Empfaenger
  //    jedes Vorkommen selbst DST-korrekt rechnet. Ein fixes UTC-Suffix liesse
  //    eine woechentliche Serie beim Zeitumstellungswochenende um eine Stunde
  //    springen (#549) - der Fehler, den der ICS-Feed schon hinter sich hat.
  if (zoneOfEvent && event.recurrence_rule && !naive) {
    const params = `;TZID=${zoneOfEvent}`;
    return {
      dtstart: { value: inEventZone(event.start_datetime), params },
      dtend:   { value: inEventZone(endSource),            params },
      tzid: zoneOfEvent,
    };
  }

  // 3. Der Wert traegt seinen Offset selbst: als UTC-Instant bereits eindeutig.
  //    Ein Einzeltermin braucht keine Zone, nur einen Zeitpunkt.
  if (!naive) {
    return {
      dtstart: { value: utc(event.start_datetime), params: '' },
      dtend:   { value: utc(endSource),            params: '' },
      tzid: null,
    };
  }

  // 4. Naive Ziffern. Sie meinen die Uhr des Haushalts (#1993). Traegt das
  //    Event eine eigene Zone, gehen sie in diese umgerechnet hinaus, sonst
  //    mit der Zone des Haushalts. Ohne diesen Zweig ging genau hier die
  //    floating time aus #938 hinaus.
  if (zoneOfEvent) {
    const params = `;TZID=${zoneOfEvent}`;
    return {
      dtstart: { value: inEventZone(event.start_datetime), params },
      dtend:   { value: inEventZone(endSource),            params },
      tzid: zoneOfEvent,
    };
  }
  const zone = anchorZone(householdZone);
  const params = zone ? `;TZID=${zone}` : '';
  const suffix = zone ? '' : 'Z';
  return {
    dtstart: { value: toICSDatetime(event.start_datetime) + suffix, params },
    dtend:   { value: toICSDatetime(endSource) + suffix,            params },
    tzid: zone,
  };
}

/**
 * Die Regel, wie sie neben diesem DTSTART hinausgeht (#1974).
 *
 * Ein reines Datum als UNTIL ist Yuvomis kanonische Form (utils/rrule-until.js)
 * und neben einem DTSTART mit Uhrzeit laut RFC 5545 §3.3.10 ungueltig. Es wird
 * zum Ende dieses Ortstags in der Zone des DTSTART, ohne TZID in UTC - dort, wo
 * der Empfaenger die Vorkommen rechnet. Das gilt fuer JEDE Regel mit einem
 * Datums-UNTIL neben getimtem DTSTART, also auch fuer eine eingelesene: sie ist
 * in dieser Form ungueltig, und Yuvomi liest sie als genau diesen Tag. Neben
 * VALUE=DATE bleibt das Datum, und jede andere Regel geht Wort fuer Wort
 * hinaus (#756).
 *
 * @param {string} rule  Regel mit oder ohne `RRULE:`
 * @param {{ dtstart: {params: string}, tzid: string|null }} when  aus eventDateTimeFields
 * @returns {string}
 */
export function rruleForDtstart(rule, when) {
  if (/VALUE=DATE(?!-)/i.test(when?.dtstart?.params ?? '')) return rule;
  return timedSeriesUntil(rule, when?.tzid ?? null);
}
