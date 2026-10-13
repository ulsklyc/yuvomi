/**
 * Modul: DTSTART fuer ausgehende Kalender
 * Zweck: Das Startdatum, das Yuvomi nach draussen schreibt, mit seiner eigenen
 *        Wiederholungsregel in Einklang bringen (#986).
 * Abhaengigkeiten: services/recurrence.js, utils/timezone.js
 *
 * DAS PROBLEM. Eine Serie "am letzten Tag des Monats", angelegt aus einem Datum
 * in der Monatsmitte, speichert `DTSTART` so, wie es eingegeben wurde - sagen
 * wir den 15. Januar - zusammen mit `RRULE:FREQ=MONTHLY;BYMONTHDAY=-1`. Intern
 * ist das eindeutig: die Expansion liefert den 31. Januar als erstes Vorkommen
 * und zeigt den 15. nie. Nach draussen ist es das nicht. RFC 5545 3.8.5.3 nennt
 * die Wiederholungsmenge bei einem unsynchronisierten DTSTART ausdruecklich
 * "undefined" - ein fremder Client darf daraus den 15. Januar UND jeden
 * Monatsletzten machen, also ein Vorkommen mehr, als Yuvomi zeigt.
 *
 * WARUM NICHT BEIM SCHREIBEN. Genau das wurde in #984 versucht und
 * zurueckgenommen. `start_datetime` beim Speichern zu begradigen heisst, dass
 * jeder Leser der Spalte wissen muss, dass sich der Wert nach seiner Eingabe
 * noch aendert; sechs Reviewrunden fanden drei Stellen, die das nicht wussten
 * (Erinnerungszeitpunkt aus dem eingegebenen Datum, PUT normalisierte bei jeder
 * Bearbeitung, Vorlauf/Folgeinstanz/optimistisches Rendern lasen dieselbe
 * Spalte). Hier, an der Serialisierung, ist die Umformung rein lesend und kann
 * keine Erinnerung verschieben.
 *
 * WAS UNANGETASTET BLEIBT. Eine importierte Serie geht Wort fuer Wort zurueck
 * (#756): fremde Kalender duerfen ein unsynchronisiertes DTSTART absichtlich
 * fuehren, und Yuvomi ist beim Round-Trip nicht der Schiedsrichter darueber.
 * Diese Datei gilt allein fuer das, was Yuvomi SELBST erzeugt.
 *
 * WORAN "SELBST" HAENGT (#1935). An `series_authored`, nicht an
 * `external_source`. Die Quellspalte sagt, WO eine Zeile gespiegelt liegt, und
 * das Buchen eines Uploads schreibt sie um: eine hier angelegte Serie war
 * danach von einer eingelesenen nicht mehr zu unterscheiden und ging nach der
 * ersten Bearbeitung mit dem eingegebenen Start hinaus - der Anbieter hielt
 * erst den 31. und nach einer Titelaenderung den 15. Januar. Die Marke sagt,
 * WER Start und Regel zuletzt geschrieben hat:
 *
 *   - gesetzt beim Anlegen in Yuvomi und bei jeder Aenderung von Start oder
 *     Regel in Yuvomi, auch an einer eingelesenen Serie (`startOrRuleChanged`);
 *   - zurueckgenommen, wenn der Abruf vom Anbieter einen ANDEREN Start oder
 *     eine andere Regel uebernimmt (`inboundSeriesVerdict`).
 *
 * Traegt die Zeile die Marke, wird bei JEDEM ausgehenden Weg ausgerichtet;
 * ohne sie geht die Serie Wort fuer Wort zurueck, auch nach einer Bearbeitung,
 * die weder Start noch Regel anfasst.
 *
 * DER ABRUF SCHREIBT DAS AUSGERICHTETE DATUM NICHT ZURUECK. Liefert der
 * Anbieter genau das, was Yuvomi hinausgegeben hat, bleibt die Zeile bei der
 * Eingabe (dem 15.): sonst kaeme die Normalisierung beim Schreiben, die #984
 * zurueckgenommen hat, ueber den Sync wieder herein und zoege die Erinnerungen
 * vom 15. auf den 31. mit.
 */

import { seriesStartFor } from './recurrence.js';
import {
  hasExplicitZone, isValidTimeZone, localToUTCPrecise, shiftDateKey, storedToInstantMsPrecise, utcToWall,
} from '../utils/timezone.js';

/**
 * Traegt der Termin einen Start und eine Regel, die Yuvomi verfasst hat?
 *
 * Allein `series_authored` (Migration 246). Eine Zeile ohne die Spalte - ein
 * von Hand gebautes Objekt, ein Schema von vor der Migration - gilt als nicht
 * verfasst: unbekannt heisst "wie eingelesen behandeln".
 */
function istEigen(event) {
  return Number(event?.series_authored) === 1;
}

/**
 * Dasselbe `zonenUnsicher` wie in services/countdowns.js - und aus demselben
 * Grund woertlich gleich: die Expansion nimmt die BYDAY-Pruefung fuer Termine
 * zurueck, deren UTC-Tag vom lokalen abweicht, und wenn zwei Stellen diese
 * Frage verschieden beantworten, liefern sie verschiedene erste Vorkommen.
 */
function zonenUnsicher(event) {
  if (!event?.tzid) return false;
  const roh = String(event.start_datetime ?? '');
  const wandUhr = utcToWall(roh, event.tzid);
  return !(wandUhr && wandUhr.date === roh.slice(0, 10));
}

/**
 * Das Startdatum, das nach draussen gehoert.
 *
 * @param {object} event  Zeile aus `calendar_events` (start_datetime,
 *   recurrence_rule, tzid, series_authored)
 * @returns {string} `event.start_datetime`, wenn nichts zu begradigen ist -
 *   sonst derselbe Wert mit dem ersten Tag, den die Regel wirklich trifft.
 *   Uhrzeit und Format bleiben, `seriesStartFor` tauscht nur den Datumsteil.
 */
export function outboundStartDatetime(event) {
  return outboundDateRange(event).start_datetime;
}

/**
 * Ein Zeitpunkt mit eigener Zone (`...Z`, `...+01:00`), dessen Zeile ihre Zone
 * nennt: ausgerichtet wird auf der WANDUHR dieser Zone, nicht am Text.
 *
 * So liegt eine Serie nur dann in der Zeile, wenn sie eingelesen wurde und ihr
 * Start oder ihre Regel danach in Yuvomi geaendert wurde (wer nur die Regel
 * aendert, laesst den Start in der Form des Anbieters stehen). Den Datumsteil
 * im Text zu tauschen waere dort zweimal falsch: der Tag im Text ist der
 * UTC-Tag und kann neben dem Ortstag liegen, und der Versatz des 15. Maerz
 * gilt am 31. nicht mehr, wenn dazwischen die Uhr umgestellt wird - der
 * Termin stuende eine Stunde daneben. Heraus kommt wieder ein Zeitpunkt
 * (`...Z`): dieselbe Wanduhrzeit, am ersten Tag, den die Regel trifft.
 *
 * WELCHE ZONE: die, in der der EMPFAENGER die Serie rechnet. CalDAV, iCloud
 * und der Feed geben eine solche Serie mit `TZID=<tzid der Zeile>` hinaus
 * (`eventDateTimeFields`), dort ist es die Zone der Zeile. Google bekommt
 * neben dem Zeitpunkt eine eigene `timeZone` (Haushalt bzw. Kalender) und
 * rechnet die Vorkommen in IHR: 23:30 in New York ist in Berlin der Folgetag,
 * und ein in New York ausgerichteter Start laege bei Google wieder neben
 * `BYMONTHDAY=-1`. Der Aufrufer nennt sie deshalb, wo sie von der Zeile
 * abweicht.
 *
 * @param {object} event
 * @param {string} zone  IANA-Zone, in der die Vorkommen gerechnet werden
 * @returns {{ start_datetime: string, end_datetime: string|null }|null} null,
 *   wenn nichts zu begradigen ist
 */
function zonedDateRange(event, zone) {
  const wandStart = utcToWall(event.start_datetime, zone);
  if (!wandStart) return null;
  const ziel = seriesStartFor(wandStart.date, event.recurrence_rule);
  if (ziel === wandStart.date) return null;
  const tage = tagesDifferenz(wandStart.date, ziel);
  const verschoben = (wert) => {
    if (!hasExplicitZone(wert)) return verschiebe(wert, tage);
    const wand = utcToWall(wert, zone);
    return wand ? localToUTCPrecise(`${shiftDateKey(wand.date, tage)}T${wand.time}`, zone) : wert;
  };
  const ende = event.end_datetime ?? null;
  return { start_datetime: verschoben(event.start_datetime), end_datetime: ende ? verschoben(ende) : ende };
}

/** Tage zwischen zwei YYYY-MM-DD-Werten (b - a). */
function tagesDifferenz(a, b) {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86400000);
}

/** Denselben Datumsteil um `tage` verschieben, Uhrzeit und Format unberuehrt. */
function verschiebe(wert, tage) {
  const roh = String(wert);
  const tag = roh.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tag) || !tage) return wert;
  const d = new Date(`${tag}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + tage);
  const p = (n) => String(n).padStart(2, '0');
  const neu = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return roh.replace(tag, neu);
}

/**
 * Start UND Ende fuer den ausgehenden Weg (#986).
 *
 * DAS ENDE MUSS MITWANDERN, und das ist keine Feinheit: `end_datetime` ist ein
 * absoluter Zeitstempel, kein Abstand. Rueckt DTSTART vom 15. auf den 31. und
 * bleibt DTEND am 15., steht ein Termin im fremden Kalender, der endet, bevor er
 * beginnt - und wo `end_datetime` fehlt, faellt DTEND ohnehin auf den Start
 * zurueck und wuerde dieselbe Verschiebung brauchen.
 *
 * VERSCHOBEN WIRD UM TAGE, nicht um Millisekunden: `seriesStartFor` tauscht nur
 * den Datumsteil und laesst die Uhrzeit stehen, also tut das Ende dasselbe. So
 * bleibt die Dauer erhalten, auch ueber eine Sommerzeitgrenze hinweg, und das
 * gespeicherte Format (naiv, `Z`, Offset) bleibt, wie es war. Dieselbe Zusage
 * wie in der Expansion: die DAUER gehoert dem Termin, das Datum der Regel.
 *
 * @param {object} event
 * @param {{ zone?: string|null }} [options]  `zone`: die Zone, in der der
 *   Empfaenger die Serie rechnet, wenn es nicht die `tzid` der Zeile ist
 *   (Google). Gelesen wird sie nur fuer einen Start, der ein Zeitpunkt ist;
 *   eine zonenlose Wanduhrzeit meint ihren Tag selbst.
 * @returns {{ start_datetime: string, end_datetime: string|null }}
 */
export function outboundDateRange(event, { zone = null } = {}) {
  const roh = event?.start_datetime;
  const ende = event?.end_datetime ?? null;
  const unveraendert = { start_datetime: roh, end_datetime: ende };
  if (!roh || !event?.recurrence_rule || !istEigen(event)) return unveraendert;
  const rechenZone = zone || event.tzid;
  if (hasExplicitZone(roh) && isValidTimeZone(rechenZone)) return zonedDateRange(event, rechenZone) ?? unveraendert;
  const start = seriesStartFor(roh, event.recurrence_rule, { utcDiffersFromLocal: zonenUnsicher(event) });
  if (!start || start === roh) return unveraendert;
  const tage = tagesDifferenz(String(event.start_datetime).slice(0, 10), String(start).slice(0, 10));
  return { start_datetime: start, end_datetime: ende ? verschiebe(ende, tage) : ende };
}

/**
 * Der Termin, wie er nach draussen geht - Start und Ende schon begradigt.
 *
 * Fuer Aufrufer, die das ganze Objekt weiterreichen (`eventDateTimeFields` und
 * die drei ICS-Bauer darum). ABSICHTLICH HIER UND NICHT IN `utils/ics-datetime.js`:
 * die Umformung ist eine Regel dieses Moduls, und ein `utils`, das ein `services`
 * importiert, dreht die Schichtung um. So sagt jeder ausgehende Pfad an seiner
 * eigenen Zeile, dass er sie anwendet.
 */
export function outboundEvent(event, options) {
  if (!event) return event;
  return { ...event, ...outboundDateRange(event, options) };
}


// --------------------------------------------------------
// Die Marke `series_authored` (#1935): wer sie setzt, wer sie nimmt
// --------------------------------------------------------

/**
 * Eine Regel in der Form, in der zwei Schreibweisen derselben Regel gleich
 * sind: ohne `RRULE:`-Praefix (eingelesene Serien tragen es, hier angelegte
 * nicht), gross geschrieben, die Teile sortiert. Verglichen wird damit nur,
 * gespeichert nie.
 */
function ruleKey(rule) {
  return String(rule ?? '').trim().replace(/^RRULE:/i, '')
    .split(';').map((teil) => teil.trim().toUpperCase()).filter(Boolean).sort().join(';');
}

/**
 * Bezeichnen zwei gespeicherte Zeitwerte denselben Beginn?
 *
 * In der Spalte liegen zwei Formen (`hasExplicitZone`): die Wanduhrzeit des
 * Haushalts und der Zeitpunkt des Anbieters. Am Text verglichen waere jede
 * Bearbeitung eines eingelesenen Termins eine Startaenderung - das Formular
 * schickt die Wanduhrzeit zurueck, in der Zeile steht der Zeitpunkt.
 * Ganztaegig zaehlt der Tag, sonst der Zeitpunkt.
 *
 * `toMinute`: nur die Minute zaehlt, Sekunden und Bruchteile fallen weg
 * (abgeschnitten, nicht gerundet - so zeigt sie auch das Formular).
 */
function sameStart(a, b, zone, allDay, { toMinute = false } = {}) {
  if (a == null || b == null) return a == null && b == null;
  if (allDay) return String(a).slice(0, 10) === String(b).slice(0, 10);
  const links = storedToInstantMsPrecise(a, zone);
  const rechts = storedToInstantMsPrecise(b, zone);
  if (links === null || rechts === null) return false;
  return toMinute ? Math.floor(links / 60000) === Math.floor(rechts / 60000) : links === rechts;
}

/**
 * Hat eine Bearbeitung IN YUVOMI den Start oder die Regel geaendert?
 *
 * Die Antwort setzt die Marke - auch an einer eingelesenen Serie: wer dort den
 * Start verlegt oder die Regel wechselt, hat beides ab dann selbst verfasst.
 * Eine Bearbeitung, die nur Titel, Ort oder Farbe anfasst, aendert nichts
 * daran, wer den Start geschrieben hat, und die eingelesene Serie geht danach
 * weiter Wort fuer Wort zurueck (#756).
 *
 * VERGLICHEN WIRD AUF DIE MINUTE. Der Dialog schickt `YYYY-MM-DDTHH:MM`, mehr
 * kann er nicht halten. Ein eingelesener Start mit Sekunden (`14:00:30`) kommt
 * deshalb bei jeder Bearbeitung als `14:00` zurueck, auch wenn nur der Titel
 * geaendert wurde. Das ist der Verlust des Formulars und keine Entscheidung
 * ueber den Start: auf die Millisekunde verglichen bekaeme die Serie die
 * Marke und ginge mit einem anderen DTSTART zurueck. Eine Minute Unterschied
 * bleibt eine Aenderung. Der Abruf (`inboundSeriesVerdict`) vergleicht
 * dagegen genau: dort stehen sich zwei Zeitpunkte gegenueber, kein Formular.
 *
 * @param {object} before  Zeile vor der Bearbeitung
 * @param {{start_datetime: string, all_day: number|boolean, recurrence_rule: ?string}} after
 * @param {string} zone    Zone des Haushalts (`householdTimeZone`)
 * @returns {boolean}
 */
export function startOrRuleChanged(before, after, zone) {
  if (ruleKey(before?.recurrence_rule) !== ruleKey(after?.recurrence_rule)) return true;
  if (!!before?.all_day !== !!after?.all_day) return true;
  return !sameStart(before?.start_datetime, after?.start_datetime, zone, !!after?.all_day, { toMinute: true });
}

/**
 * Was der Abruf mit Start, Ende und Regel einer bestehenden Zeile tut.
 *
 * DREI AUSGAENGE, und nur der erste ist neu:
 *
 *   - `keep`: die Zeile traegt die Marke, ihr Start liegt neben der eigenen
 *     Regel, und der Anbieter liefert GENAU den Start, den Yuvomi daraus
 *     hinausgibt (`outboundDateRange`: der erste Tag der Regel), mit derselben
 *     Regel. Dann hat der Anbieter weder Start noch Regel angefasst: Start,
 *     Regel und Zone der Zeile bleiben, wie sie eingegeben wurden, und der
 *     Aufrufer ruft `followInboundStartChange` nicht - die Erinnerungen
 *     haengen am eingegebenen Tag. Das ENDE steht in `end_datetime`: beim
 *     Echo des eigenen Uploads das gespeicherte, und wenn der Anbieter nur
 *     die Dauer geaendert hat, sein Ende in der Lage der Eingabe
 *     (`endAtEnteredStart`). Eine andere Dauer nimmt die Marke nicht - sie
 *     sagt nichts darueber, wer Start und Regel verfasst hat.
 *   - Marke bleibt, der Anbieter gilt: derselbe Beginn und dieselbe Regel wie
 *     in der Zeile (hoechstens anders geschrieben). Die Zeile folgt dem
 *     Anbieter wie bisher.
 *   - Marke faellt, der Anbieter gilt: ein anderer Start oder eine andere
 *     Regel. Ab dann ist die Serie die des Anbieters und geht Wort fuer Wort
 *     zurueck (#756).
 *
 * `sentRules`: Schreibweisen der gespeicherten Regel, die der ausgehende Weg
 * dieses Anbieters erzeugt (Google bekommt `UNTIL` umgeformt). Kommt eine
 * davon zurueck, ist das dieselbe Regel.
 *
 * Ohne Marke aendert sich nichts: `{ keep: false, authored: 0 }`.
 *
 * @param {object} stored    Zeile (start_datetime, end_datetime, all_day,
 *   recurrence_rule, tzid, series_authored)
 * @param {{start_datetime: string, end_datetime: ?string, all_day: boolean|number, recurrence_rule: ?string}} incoming
 *   was der Abruf in die Zeile schreiben wuerde
 * @param {{ zone: string, sentRules?: Array<?string>, recurrenceZone?: string|null }} options
 *   `zone`: Zone des Haushalts; `recurrenceZone`: dieselbe Angabe, die der
 *   ausgehende Weg dieses Anbieters an `outboundDateRange` gibt
 * @returns {{ keep: boolean, authored: 0|1, end_datetime?: string|null }}
 *   `end_datetime` nur bei `keep`: das Ende, das in die Zeile gehoert
 */
export function inboundSeriesVerdict(stored, incoming, { zone, sentRules = [], recurrenceZone = null } = {}) {
  const fremd = { keep: false, authored: 0 };
  if (!istEigen(stored)) return fremd;
  const allDay = !!stored.all_day;
  if (allDay !== !!incoming.all_day) return fremd;
  const kommt = ruleKey(incoming.recurrence_rule);
  const gleicheRegel = [stored.recurrence_rule, ...sentRules].some((regel) => ruleKey(regel) === kommt);
  if (!gleicheRegel) return fremd;

  const hinaus = outboundDateRange(stored, { zone: recurrenceZone });
  if (!sameStart(incoming.start_datetime, hinaus.start_datetime, zone, allDay)) return fremd;
  if (hinaus.start_datetime === stored.start_datetime) return { keep: false, authored: 1 };
  // Ohne Ende gibt jeder ausgehende Weg den Start als Ende hinaus.
  const endeHinaus = hinaus.end_datetime ?? hinaus.start_datetime;
  const endeKommt = incoming.end_datetime ?? incoming.start_datetime;
  if (sameStart(endeKommt, endeHinaus, zone, allDay)) {
    return { keep: true, authored: 1, end_datetime: stored.end_datetime ?? null };
  }
  // NUR DAS ENDE IST ANDERS: der Anbieter hat die Dauer geaendert, Start und
  // Regel sind weiter die aus Yuvomi. Das neue Ende gilt, die Eingabe bleibt.
  return {
    keep: true,
    authored: 1,
    end_datetime: endAtEnteredStart(stored, hinaus, incoming.end_datetime, { zone, recurrenceZone }),
  };
}

/**
 * Das Ende des Anbieters, zurueckgerechnet in die Lage der Eingabe.
 *
 * Der Anbieter haelt die Serie am ausgerichteten Tag (dem 31.), die Zeile am
 * eingegebenen (dem 15.). Sein Ende roh zu uebernehmen hiesse, einen Termin
 * vom 15. bis zum 31. zu speichern. Uebernommen wird deshalb seine DAUER: das
 * Ende wandert um dieselben Tage zurueck, um die `outboundDateRange` es beim
 * Hinausgeben vorschiebt - auf der Wanduhr, nicht in Millisekunden, damit die
 * Uhrzeit ueber eine Zeitumstellung dieselbe bleibt. Heraus kommt die Form,
 * in der der Start der Zeile steht (Tag, Wanduhrzeit des Haushalts oder
 * Zeitpunkt), sodass der naechste Push genau das Ende des Anbieters ergibt.
 *
 * @returns {string|null} null, wenn der Anbieter kein Ende fuehrt
 */
function endAtEnteredStart(stored, hinaus, endeKommt, { zone, recurrenceZone }) {
  if (endeKommt == null) return null;
  const start = String(stored.start_datetime);
  if (stored.all_day) {
    const tage = tagesDifferenz(start.slice(0, 10), String(hinaus.start_datetime).slice(0, 10));
    return shiftDateKey(String(endeKommt).slice(0, 10), -tage);
  }
  // Die Zone, in der die Tage gezaehlt wurden: fuer einen Zeitpunkt die des
  // Empfaengers (wie in `outboundDateRange`), fuer eine Wanduhrzeit die des Haushalts.
  const zeitpunkt = hasExplicitZone(start);
  const rechenZone = zeitpunkt ? (recurrenceZone || stored.tzid) : zone;
  const wandVon = (wert) => (hasExplicitZone(wert)
    ? utcToWall(new Date(wert).toISOString(), rechenZone)
    : { date: String(wert).slice(0, 10), time: `${String(wert).slice(11)}:00`.slice(0, 8) });
  const tage = zeitpunkt
    ? tagesDifferenz(wandVon(start).date, wandVon(hinaus.start_datetime).date)
    : tagesDifferenz(start.slice(0, 10), String(hinaus.start_datetime).slice(0, 10));
  const wand = wandVon(endeKommt);
  if (!wand) return endeKommt;
  const tag = shiftDateKey(wand.date, -tage);
  if (zeitpunkt) return localToUTCPrecise(`${tag}T${wand.time}`, rechenZone);
  // Wie die Route speichert: ohne Sekunden, solange der Anbieter keine fuehrt.
  return `${tag}T${wand.time.endsWith(':00') ? wand.time.slice(0, 5) : wand.time}`;
}
