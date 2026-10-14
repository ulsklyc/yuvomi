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
 *     eine andere Regel in die Zeile schreibt (`authoredAfterInbound`).
 *
 * Traegt die Zeile die Marke, wird bei JEDEM ausgehenden Weg ausgerichtet;
 * ohne sie geht die Serie Wort fuer Wort zurueck, auch nach einer Bearbeitung,
 * die weder Start noch Regel anfasst.
 *
 * DER ABRUF UND DAS ECHO. Der Abruf uebernimmt, was beim Anbieter liegt. Ist
 * es genau das, was der letzte ausgerichtete Push gesendet hat, und hat sich
 * die Zeile seitdem nicht geaendert, bleibt die Eingabe (der 15.) samt Marke
 * stehen (#1956, services/outbound-echo.js). Sonst wird aus dem 15. in der
 * Zeile der 31., und die Marke faellt (`authoredAfterInbound`). Das schadet
 * dem ausgehenden Weg nicht: die Zeile traegt den ausgerichteten Start dann
 * selbst und geht Wort fuer Wort richtig hinaus.
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
 * nicht), gross geschrieben, die Teile UND ihre Wertlisten sortiert
 * (`BYDAY=TU,MO` ist `BYDAY=MO,TU`, #1957). Sonst nichts: ein anders
 * geschriebenes UNTIL oder ein ausgeschriebener Standardwert bleibt eine
 * andere Regel. Verglichen wird damit nur, gespeichert nie - von
 * `startOrRuleChanged` und von der Echo-Erkennung (services/outbound-echo.js).
 *
 * @param {string|null|undefined} rule
 * @returns {string}
 */
export function ruleKey(rule) {
  return String(rule ?? '').trim().replace(/^RRULE:/i, '')
    .split(';').map((teil) => teil.trim().toUpperCase()).filter(Boolean)
    .map((teil) => {
      const eq = teil.indexOf('=');
      if (eq === -1) return teil;
      const werte = teil.slice(eq + 1).split(',').map((wert) => wert.trim()).sort();
      return `${teil.slice(0, eq)}=${werte.join(',')}`;
    })
    .sort().join(';');
}

/**
 * Bezeichnen zwei gespeicherte Zeitwerte denselben Beginn?
 *
 * In der Spalte liegen zwei Formen (`hasExplicitZone`): die Wanduhrzeit des
 * Haushalts und der Zeitpunkt des Anbieters. Am Text verglichen waere jede
 * Bearbeitung eines eingelesenen Termins eine Startaenderung - das Formular
 * schickt die Wanduhrzeit zurueck, in der Zeile steht der Zeitpunkt.
 * Ganztaegig zaehlt der Tag, sonst der Zeitpunkt AUF DIE MINUTE: Sekunden und
 * Bruchteile fallen weg (abgeschnitten, nicht gerundet - so zeigt sie auch das
 * Formular, der einzige Aufrufer ist die Bearbeitung in Yuvomi).
 */
function sameStart(a, b, zone, allDay) {
  if (a == null || b == null) return a == null && b == null;
  if (allDay) return String(a).slice(0, 10) === String(b).slice(0, 10);
  const links = storedToInstantMsPrecise(a, zone);
  const rechts = storedToInstantMsPrecise(b, zone);
  if (links === null || rechts === null) return false;
  return Math.floor(links / 60000) === Math.floor(rechts / 60000);
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
 * bleibt eine Aenderung.
 *
 * DIE ZONE IST DIE, IN DER DIE ROUTE SPEICHERT. Die zonenlose Eingabe des
 * Formulars landet Ziffer fuer Ziffer in der Spalte, und jeder Leser auf dem
 * Server nimmt sie als Wanduhrzeit von `householdTimeZone()`; die Route gibt
 * hier dieselbe Angabe herein, mit der sie den Wert formt (`zoneOpts`).
 * OFFEN (Review zu #1953, nicht geloest): hat der Haushalt KEINE Zone gewaehlt
 * und laeuft der Browser in einer anderen Zone als der Server, zeigt das
 * Formular einen eingelesenen Zeitpunkt in der Browserzone und schickt diese
 * Ziffern zurueck. Der Server liest sie in seiner Zone: schon die gespeicherte
 * Zeit ist dann eine andere (so auch vor #1935, der Termin wandert beim
 * Anbieter um den Versatz), und der Vergleich hier sieht folgerichtig einen
 * anderen Start und setzt die Marke. Die Browserzone kommt in der Anfrage
 * nicht vor; ohne sie laesst sich das hier nicht unterscheiden.
 *
 * @param {object} before  Zeile vor der Bearbeitung
 * @param {{start_datetime: string, all_day: number|boolean, recurrence_rule: ?string}} after
 * @param {string} zone    Zone des Haushalts (`householdTimeZone`)
 * @returns {boolean}
 */
export function startOrRuleChanged(before, after, zone) {
  if (ruleKey(before?.recurrence_rule) !== ruleKey(after?.recurrence_rule)) return true;
  if (!!before?.all_day !== !!after?.all_day) return true;
  return !sameStart(before?.start_datetime, after?.start_datetime, zone, !!after?.all_day);
}

/**
 * Die Marke einer Zeile, nachdem der Abruf sie geschrieben hat.
 *
 * Sie faellt genau dann, wenn der Abruf einen ANDEREN Start oder eine andere
 * Regel in die Zeile schreibt, als dort stand: ab dann stammen beide vom
 * Anbieter, und die Serie geht Wort fuer Wort zurueck (#756). Verglichen wird
 * der Text, der in die Spalte kommt, mit dem, der dort steht - dieselbe
 * Gleichheit, an der `followInboundStartChange` einen verlegten Start erkennt.
 * HIER KEINE ECHO-ERKENNUNG: die steht vor diesem Aufruf (`isEcho` in
 * services/outbound-echo.js, #1956), und beim Echo fragen die Abrufe diese
 * Funktion gar nicht. Was hier ankommt, ist kein Echo: auch Yuvomis eigener
 * ausgerichteter Start ohne gueltigen Schnappschuss ist ein anderer Start und
 * nimmt die Marke. Die Zeile traegt ihn danach selbst.
 * Dasselbe gilt fuer eine andere Schreibweise desselben Beginns oder
 * derselben Regel: was der Abruf hineinschreibt, ist die Form des Anbieters.
 *
 * Eine Zeile ohne Marke bekommt durch den Abruf nie eine.
 *
 * @param {{start_datetime: ?string, recurrence_rule: ?string, series_authored: ?number}} stored
 *   die Zeile vor dem Abruf
 * @param {{start_datetime: ?string, recurrence_rule: ?string}} written
 *   was der Abruf in die Zeile schreibt
 * @returns {0|1}
 */
export function authoredAfterInbound(stored, written) {
  if (!istEigen(stored)) return 0;
  const gleich = (a, b) => String(a ?? '') === String(b ?? '');
  return gleich(stored.start_datetime, written?.start_datetime)
    && gleich(stored.recurrence_rule, written?.recurrence_rule) ? 1 : 0;
}
