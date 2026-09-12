/**
 * Modul: Kalender-Events (geteilte Abfrage-Logik)
 * Zweck: Wiederholungs-Expansion als unabhängige Kalender-Grundlage bereitstellen.
 * Abhängigkeiten: server/services/recurrence.js
 */

import { nextOccurrence, parseRRule, matchesRRuleByday } from './recurrence.js';
import { hasExplicitZone, localToUTC, utcToWall } from '../utils/timezone.js';

const DEFAULT_EXPANSION_ITERATIONS = 1000;
export const MAX_EXPANSION_ITERATIONS = 100000;

// Zugewiesene Personen eines Events als JSON-Array (Multi-Assignment).
export const ASSIGNED_USERS_SQL = `(
  SELECT json_group_array(json_object(
    'id', u.id, 'display_name', u.display_name, 'color', u.avatar_color,
    'avatar_data', u.avatar_data
  ))
  FROM event_assignments ea JOIN users u ON u.id = ea.user_id
  WHERE ea.event_id = e.id
) AS assigned_users_json`;

/**
 * Die Quelle eines Termins fuer den Kalenderfilter (#1064), als ID in
 * `external_calendars`. Ein synchronisierter Termin haengt ueber
 * `calendar_ref_id` daran. Ein frisch angelegter mit Google- oder CalDAV-Ziel
 * bekommt diese Spalte erst, wenn der Ausgang ihn hochgeladen hat - bis dahin,
 * und bei scheiterndem Sync auf Dauer, sagt nur das Ziel, wohin er gehoert.
 * Ohne diesen Rueckfall bliebe er stehen, obwohl sein Kalender ausgeblendet ist.
 *
 * Bewusst nicht im Join fuer `cal_name`/`cal_color`: die geerbte Farbe folgt
 * weiter dem, was der Sync bestaetigt hat. Name und Farbe der QUELLE kommen
 * trotzdem mit (`source_calendar_name`/`_color`): ohne sie stand ein Kalender,
 * von dem nur ein neuer Termin im Zeitraum liegt, im Filterblatt als
 * namenloses „Kalender" - zwei davon waren nicht zu unterscheiden (Codex-Review
 * zu #1124). Jeder Lesepfad, der Termine an die Kalenderseite liefert, nimmt
 * den Join und die Spalten mit.
 *
 * Ein vorgemerkter Umzug (`outbound_move_to`, #593) geht vor: er ist der
 * ausdrueckliche Wunsch, und bis der Ausgang ihn ausgefuehrt hat, zeigt
 * `calendar_ref_id` noch auf den alten Kalender (Codex-Review zu #1124). Die
 * blosse Abweichung zwischen Ziel und `calendar_ref_id` zaehlt dagegen nicht:
 * Bestandsdaten tragen sie folgenlos, siehe Migration 105.
 */
export const SOURCE_CALENDAR_JOIN = `LEFT JOIN external_calendars src ON src.id = COALESCE(
  (SELECT tm.id FROM external_calendars tm
    WHERE tm.source = e.external_source AND tm.external_id = e.outbound_move_to),
  e.calendar_ref_id,
  (SELECT tg.id FROM external_calendars tg
    WHERE tg.source = 'google' AND tg.external_id = e.target_google_calendar_id),
  (SELECT tc.id FROM external_calendars tc
    WHERE tc.source = 'caldav' AND tc.external_id = e.target_caldav_calendar_url)
)`;

/** Die Spalten zu SOURCE_CALENDAR_JOIN: ID, Name und Farbe der aufgeloesten Quelle. */
export const SOURCE_CALENDAR_COLUMNS = `src.id    AS source_calendar_ref_id,
  src.name  AS source_calendar_name,
  src.color AS source_calendar_color`;

/**
 * Lädt die Instanz-Ausnahmen (EXDATE, #489) für die gegebenen Event-IDs als Map.
 * @param {import('node:sqlite').DatabaseSync} d  Geöffnete DB-Verbindung
 * @param {Array<number>} eventIds  IDs wiederkehrender Events
 * @returns {Map<number, Set<string>>}  event.id → Set ausgenommener Daten (YYYY-MM-DD)
 */
export function loadEventExceptions(d, eventIds) {
  const map = new Map();
  if (!eventIds || eventIds.length === 0) return map;
  const placeholders = eventIds.map(() => '?').join(',');
  const rows = d.prepare(
    `SELECT event_id, exception_date FROM calendar_event_exceptions WHERE event_id IN (${placeholders})`
  ).all(...eventIds);
  for (const row of rows) {
    if (!map.has(row.event_id)) map.set(row.event_id, new Set());
    map.get(row.event_id).add(row.exception_date);
  }
  return map;
}

// --------------------------------------------------------
// RRULE-Expansion: alle Vorkommen eines wiederkehrenden Events
// innerhalb [from, to] generieren (inklusive beider Grenzen).
// --------------------------------------------------------

/**
 * @param {object[]} events  Rohe DB-Events (können recurrence_rule haben)
 * @param {string}   from    YYYY-MM-DD
 * @param {string}   to      YYYY-MM-DD
 * @param {Map<number, Set<string>>?} exceptionsByEvent  event.id → Set ausgenommener
 *        Instanz-Daten (YYYY-MM-DD); diese Vorkommen werden übersprungen (EXDATE, #489)
 * @param {{includeRecurrenceIdentity?: boolean, maxIterations?: number,
 *   maxOccurrencesPerSeries?: number, occurrenceFilter?: function}} [options]
 * @returns {object[]}  Expandiertes, sortiertes Array
 */
export function expandRecurringEvents(
  events,
  from,
  to,
  exceptionsByEvent = null,
  {
    includeRecurrenceIdentity = false, maxIterations = DEFAULT_EXPANSION_ITERATIONS,
    maxOccurrencesPerSeries = null, occurrenceFilter = null,
  } = {},
) {
  const result = [];
  const iterationLimit = Number.isInteger(maxIterations) && maxIterations > 0
    ? Math.min(maxIterations, MAX_EXPANSION_ITERATIONS)
    : DEFAULT_EXPANSION_ITERATIONS;
  const occurrenceLimit = Number.isInteger(maxOccurrencesPerSeries) && maxOccurrencesPerSeries > 0
    ? Math.min(maxOccurrencesPerSeries, iterationLimit)
    : Infinity;

  for (const event of events) {
    if (!event.recurrence_rule) {
      result.push(event);
      continue;
    }

    // Dauer des Events in ms (für End-Zeit-Berechnung der Instanzen)
    const startMs    = new Date(event.start_datetime).getTime();
    const endMs      = event.end_datetime ? new Date(event.end_datetime).getTime() : null;
    const durationMs = endMs !== null ? endMs - startMs : null;
    // Duration in days for all-day events (for date-only end calculation)
    const isAllDay     = !!event.all_day;
    const durationDays = isAllDay && durationMs !== null ? Math.round(durationMs / 86400000) : 0;

    // Original-Zeit-Teil erhalten (z.B. 'T14:30:00' oder '' bei All-Day)
    const timeSuffix = event.start_datetime.slice(10);

    // DST-korrekte Expansion: bei bekannter TZID (CalDAV/Apple-Serie) pro Vorkommen
    // die lokale Wanduhrzeit des Masters neu nach UTC rechnen, statt den festen
    // UTC-Suffix zu wiederholen (sonst driftet die Uhrzeit über die Sommer-/
    // Winterzeit-Grenze, #549). Nur für Tagtermine, deren lokales Datum == UTC-Datum
    // ist (kein Mitternachts-Überlauf) - sonst alte Fixe-Suffix-Logik.
    const wall = (event.tzid && !isAllDay) ? utcToWall(event.start_datetime, event.tzid) : null;
    const tzAware = wall && wall.date === event.start_datetime.slice(0, 10);
    // Einmal bestimmt, an beide Stellen gereicht: Filter UND Berechnung muessen
    // dieselbe Antwort bekommen, sonst ist der Schutz halb.
    const zonenUnsicher = !!event.tzid && !tzAware;

    /* IN DER EREIGNISZONE RECHNEN, WENN UTC-TAG UND LOKALER TAG AUSEINANDERGEHEN
     * (#985).
     *
     * Bis hierher lief die Schleife auf UTC-Tagen und setzte `BYMONTHDAY` aus,
     * sobald die beiden nicht uebereinstimmten - die Serie lief dann auf ihrem
     * festen UTC-Tag weiter. Dieser feste Versatz trifft den lokalen
     * Monatsletzten nur, solange der UTC-Offset gleich bleibt; ueber eine
     * Sommerzeitumstellung hinweg tut er es nicht mehr. Gemessen an einer New
     * Yorker Serie um 23:30 lokal: nach der Maerz-Umstellung lagen ALLE
     * folgenden Vorkommen auf dem Ersten statt auf dem Monatsletzten.
     *
     * Also wird die REGEL auf dem lokalen Datum fortgeschrieben, und je
     * Vorkommen wird nach UTC zurueckgerechnet. `BYMONTHDAY` gilt dabei wieder,
     * denn jetzt ist das Datum, auf dem gerechnet wird, dasselbe, das die Regel
     * meint.
     *
     * WAS WEITER AM UTC-TAG HAENGT, und das ist der Grund fuer die zwei Daten
     * nebeneinander: EXDATE-Ausnahmen sind beim Import auf das UTC-Datum
     * normalisiert (`formatICSDate(...).slice(0, 10)` in ics-parser.js), und das
     * Anzeigefenster [from, to] wird ebenso in UTC-Tagen gefuehrt. Wer nur die
     * Schleifenvariable umstellt, laesst genau bei diesen Terminen die
     * Ausnahmen ins Leere laufen - dieselben Termine, um die es hier geht.
     */
    const lokalRechnen = zonenUnsicher && !!wall && !isAllDay;

    // DTSTART ist zugleich Startpunkt und ANKER: ohne ihn leitet nextOccurrence
    // den gemeinten Tag aus dem vorigen Vorkommen ab, und eine Klemmung in einem
    // kurzen Monat wuerde damit festgeschrieben (#978).
    const seriesStartUtc = event.start_datetime.slice(0, 10);
    const seriesStart = lokalRechnen ? wall.date : seriesStartUtc;

    /** Der UTC-Zeitpunkt eines Vorkommens - im lokalen Modus zurueckgerechnet. */
    const instantFuer = (tag) => (lokalRechnen
      ? localToUTC(`${tag}T${wall.time}`, event.tzid)
      : (tzAware ? localToUTC(`${tag}T${wall.time}`, event.tzid) : tag + timeSuffix));
    /** Der UTC-TAG eines Vorkommens - fuer Fenster, EXDATE und Ausgabe. */
    const utcTagFuer = (tag) => (lokalRechnen ? String(instantFuer(tag)).slice(0, 10) : tag);

    let currentDate = seriesStart; // YYYY-MM-DD, lokal oder UTC je nach Modus
    let iterations  = 0;
    const exceptions = exceptionsByEvent?.get(event.id) ?? null; // ausgenommene Instanz-Daten (#489)
    // COUNT=N begrenzt die Serie auf N Vorkommen ab DTSTART. Gezählt wird über
    // die Instanzen der Serie (nicht das Anzeigefenster) und VOR EXDATE-Entfernung
    // (RFC 5545): ausgenommene Vorkommen zählen mit, erzeugen aber keine Instanz (#513).
    const maxCount   = parseRRule(event.recurrence_rule)?.count ?? null;
    let   occurrence = 0;
    let accepted = 0;

    while (currentDate <= to && iterations < iterationLimit) {
      iterations++;

      // BYDAY-FILTER VOR DEM ZAEHLEN, EXDATE DANACH - die beiden sehen gleich
      // aus und sind es nicht. Ein Tag ausserhalb des BYDAY-Musters ist GAR KEIN
      // Vorkommen der Serie (#549: DTSTART am Wochenende bei BYDAY=MO..FR), also
      // darf er auch nicht gegen COUNT zaehlen. Ein ausgenommenes Vorkommen
      // dagegen ist eines und zaehlt mit, erzeugt aber keine Instanz (RFC 5545,
      // #513).
      //
      // Beide standen bis hierher in EINER Bedingung nach `occurrence++`, und
      // damit verbrauchte jeder uebersprungene Wochentag ein Vorkommen:
      // `FREQ=MONTHLY;BYDAY=MO;COUNT=2` lieferte genau einen Termin, weil der
      // zweite Zaehler an einen Mittwoch ging, den niemand je zu sehen bekam.
      // Ein Termin mit eigener Zone kann in UTC an einem anderen Kalendertag
      // liegen als vor Ort (#549 nutzt dieselbe Unterscheidung fuer die
      // Uhrzeit). Die Monatsletzten-Pruefung wird dort ausgesetzt, statt ein
      // Vorkommen still zu verlieren.
      if (!matchesRRuleByday(currentDate, event.recurrence_rule, { utcDiffersFromLocal: lokalRechnen ? false : zonenUnsicher })) {
        const next = nextOccurrence(currentDate, event.recurrence_rule, { anchor: seriesStart, utcDiffersFromLocal: lokalRechnen ? false : zonenUnsicher });
        if (!next || next <= currentDate) break;
        currentDate = next;
        continue;
      }

      if (maxCount !== null && occurrence >= maxCount) break;
      occurrence++;

      // Gegen den UTC-TAG, nicht gegen den lokalen: so sind die Ausnahmen beim
      // Import abgelegt worden (#985).
      if (exceptions?.has(utcTagFuer(currentDate))) {
        const next = nextOccurrence(currentDate, event.recurrence_rule, { anchor: seriesStart, utcDiffersFromLocal: lokalRechnen ? false : zonenUnsicher });
        if (!next || next <= currentDate) break;
        currentDate = next;
        continue;
      }

      // For multi-day events, check if the instance end reaches into [from, to]
      let instanceEnd = currentDate;
      if (isAllDay && durationDays > 0) {
        const d = new Date(currentDate + 'T00:00:00');
        d.setDate(d.getDate() + durationDays);
        instanceEnd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }

      if (currentDate >= from || instanceEnd >= from) {
        const newStart = instantFuer(currentDate);
        let newEnd = event.end_datetime;
        if (durationMs !== null) {
          if (isAllDay) {
            // Keep date-only format for all-day events
            const d = new Date(currentDate + 'T00:00:00');
            d.setDate(d.getDate() + durationDays);
            newEnd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          } else {
            const endDate = new Date(new Date(newStart).getTime() + durationMs);
            /* DAS ENDE MUSS DIE SPEICHERFORM DES STARTS TRAGEN, DEN ES BEGLEITET.
             *
             * Gefragt wird `newStart`, nicht `timeSuffix`: der Suffix beschreibt
             * den Start des MASTERS, `newStart` ist der dieses Vorkommens - und
             * die beiden haben nicht dieselbe Form. Bei bekannter TZID baut
             * `instantFuer()` den Start ueber `localToUTC()`, also mit `Z`,
             * waehrend der Master seinen urspruenglichen Offset traegt
             * (`T15:25:00-04:00` aus Google). Die alte Frage traf auf beides
             * nicht zu und schickte das Ende in den Wanduhr-Zweig darunter, der
             * mit `getHours()` in der SERVERZONE formatiert.
             *
             * Ergebnis war eine Zeile mit ZWEI Speicherformen: der Start ein
             * Instant, das Ende zonenlose Wanduhrzeit. Der Browser rechnet nur
             * den Instant um (`hasExplicitZone`, siehe utils/timezone.js) und
             * liess das Ende stehen, also standen dort zwei Uhren nebeneinander.
             * Auf einem UTC-Server sah ein Nutzer in New York aus 15:25-15:30
             * ein 15:25-19:30 (#1089) - der Fehler ist genau der Offset zwischen
             * Server- und Anzeigezone und faellt deshalb nur auf, wo die beiden
             * auseinandergehen.
             *
             * Der Wanduhr-Zweig bleibt fuer zonenlose Starts richtig: dort lesen
             * `new Date()` und `getHours()` DIESELBE Serverzone, die Umrechnung
             * hebt sich auf. Falsch wird es erst, wenn nur eine Seite eine Zone
             * traegt. */
            if (hasExplicitZone(newStart)) {
              newEnd = endDate.toISOString().replace('.000Z', 'Z');
            } else {
              const p = n => String(n).padStart(2, '0');
              newEnd = `${endDate.getFullYear()}-${p(endDate.getMonth() + 1)}-${p(endDate.getDate())}T${p(endDate.getHours())}:${p(endDate.getMinutes())}`;
            }
          }
        }

        const instance = {
          ...event,
          start_datetime:       newStart,
          end_datetime:         newEnd,
          // DIE IDENTITAET EINES VORKOMMENS IST SEIN UTC-TAG - und das ist keine
          // Aenderung an #975, sondern dessen Uebersetzung auf den Stand nach #985.
          //
          // #975 schrieb hier `currentDate`. Auf seinem Zweig WAR das der UTC-Tag: die
          // Schleife lief durchgehend auf UTC-Tagen, `lokalRechnen` gab es noch nicht.
          // Seit #985 laeuft sie bei einer zonenunsicheren Serie auf dem LOKALEN Datum
          // (Begruendung im Kopf dieser Funktion), und derselbe Ausdruck bedeutete
          // dann etwas anderes. `utcTagFuer(currentDate)` haelt die urspruengliche
          // Bedeutung fest.
          //
          // Nachgerechnet an der Tokio-Probe in test-ics-export.js: Master 07.01. 08:00
          // Tokio = 06.01. 23:00 UTC, taeglich. Der Override traegt `2026-01-07` und
          // meint damit das ZWEITE Vorkommen (lokal der 08.01.) - die Probe verlangt
          // `RECURRENCE-ID;TZID=Asia/Tokyo:20260108T080000`. Als lokaler Tag gelesen
          // traefe derselbe Wert das erste Vorkommen.
          //
          // Dazu passt der Rest der Kette: die Ausnahme, die ein Override ablegt, wird
          // oben ebenfalls im UTC-Raum nachgeschlagen
          // (`exceptions?.has(utcTagFuer(currentDate))`).
          ...(includeRecurrenceIdentity ? { recurrence_identity: utcTagFuer(currentDate) } : {}),
          is_recurring_instance: utcTagFuer(currentDate) !== seriesStartUtc ? 1 : 0,
          // "IST DAS DER ERSTE TERMIN DER SERIE?" IST NICHT "WEICHT ER VOM
          // GESPEICHERTEN DATUM AB?" - seit ein Start auf der Regel liegen darf,
          // ohne ihr Raster zu treffen (#960), sind das zwei Fragen. Ein Termin
          // am 15. mit "am Monatsletzten" hat sein erstes Vorkommen am 31.:
          // eine Instanz, die vom Master abweicht, und trotzdem der Anfang.
          //
          // Das Frontend haengt "diesen und alle folgenden" daran: am Anfang
          // der Serie meint das die ganze Serie, sonst einen Schnitt. Ohne diese
          // Unterscheidung kuerzte es die Regel auf den Tag VOR dem ersten
          // Vorkommen - eine leere Serie, die der Server zu Recht abwies. Der
          // Zaehler steht hier ohnehin, weil COUNT ihn braucht.
          is_series_start: occurrence === 1 ? 1 : 0,
        };
        // Upcoming readers count only eligible results. Historical instances,
        // EXDATEs and instances rejected by the reader must not fill the cap.
        if (!occurrenceFilter || occurrenceFilter(instance)) {
          result.push(instance);
          accepted++;
          if (accepted >= occurrenceLimit) break;
        }
      }

      const next = nextOccurrence(currentDate, event.recurrence_rule, { anchor: seriesStart, utcDiffersFromLocal: lokalRechnen ? false : zonenUnsicher });
      if (!next || next <= currentDate) break;
      currentDate = next;
    }
  }

  return result.sort((a, b) => a.start_datetime.localeCompare(b.start_datetime));
}
