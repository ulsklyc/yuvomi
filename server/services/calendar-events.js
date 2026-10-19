/**
 * Modul: Kalender-Events (geteilte Abfrage-Logik)
 * Zweck: Wiederholungs-Expansion als unabhängige Kalender-Grundlage bereitstellen.
 * Abhängigkeiten: server/services/recurrence.js
 */

import { nextOccurrence, parseRRule, matchesRRuleByday, untilInstantMs } from './recurrence.js';
import {
  hasExplicitZone, householdTimeZone, localToUTCOccurrence, shiftDateKey,
  storedToInstantIso, utcToWall,
} from '../utils/timezone.js';
import { legacyOccurrenceKeyFor } from './legacy-occurrence-key.js';
import { personAvatarUrlSql } from './person-avatar.js';

const DEFAULT_EXPANSION_ITERATIONS = 1000;
export const MAX_EXPANSION_ITERATIONS = 100000;

// Zugewiesene Personen eines Events als JSON-Array (Multi-Assignment).
export const ASSIGNED_USERS_SQL = `(
  SELECT json_group_array(json_object(
    'id', u.id, 'display_name', u.display_name, 'color', u.avatar_color,
    'avatar_data', ${personAvatarUrlSql('u')}
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

/** Ein Schluessel in alter Form oder ganztaegig: nur das Datum. */
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Die drei Formen des Schluessels (#2034, Format A). */
const OCCURRENCE_KEY_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z?)?$/;

/**
 * Ist `value` ein Vorkommens-Schluessel in einer der drei Formen (#2034)?
 * `YYYY-MM-DD` (ganztaegig, oder die alte Form an einer getimten Serie),
 * `YYYY-MM-DDTHH:MM:SSZ` (Originalstart als UTC-Zeitpunkt) oder
 * `YYYY-MM-DDTHH:MM:SS` (schwebende Wanduhr ohne Zone). Das Datum muss es geben.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isOccurrenceKey(value) {
  if (typeof value !== 'string' || !OCCURRENCE_KEY_RE.test(value)) return false;
  const day = value.slice(0, 10);
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) return false;
  if (value.length === 10) return true;
  const [hh, mm, ss] = value.slice(11, 19).split(':').map(Number);
  return hh < 24 && mm < 60 && ss < 60;
}

/**
 * Die Ausnahmen einer Serie, nach Form getrennt (#2034): `exact` traegt die
 * Schluessel in Format A, `legacy` die alte Form `YYYY-MM-DD`. Ein Datum an
 * einer GANZTAEGIGEN Serie ist beides zugleich - dort ist der alte Schluessel
 * schon der exakte, und `exceptionsInclude` fragt beide Mengen.
 *
 * Liest sich nach aussen weiter wie ein `Set` der gespeicherten Werte
 * (`has`, `size`, Iteration): Aufrufer, die nur wissen wollen, ob ein Wert
 * gespeichert ist, brauchen die Trennung nicht.
 */
export class OccurrenceExceptions {
  constructor() {
    this.exact = new Set();
    this.legacy = new Set();
  }

  add(value) {
    (DATE_KEY_RE.test(String(value)) ? this.legacy : this.exact).add(value);
    return this;
  }

  has(value) {
    return this.exact.has(value) || this.legacy.has(value);
  }

  get size() {
    return this.exact.size + this.legacy.size;
  }

  *[Symbol.iterator]() {
    yield* this.legacy;
    yield* this.exact;
  }
}

/** Eine leere Ausnahmenmenge in der Form, die `loadEventExceptions` liefert. */
export function emptyOccurrenceExceptions() {
  return new OccurrenceExceptions();
}

/**
 * Lädt die Instanz-Ausnahmen (EXDATE, #489) für die gegebenen Event-IDs als Map.
 * @param {import('node:sqlite').DatabaseSync} d  Geöffnete DB-Verbindung
 * @param {Array<number>} eventIds  IDs wiederkehrender Events
 * @returns {Map<number, OccurrenceExceptions>}  event.id → Ausnahmen, nach Form
 */
export function loadEventExceptions(d, eventIds) {
  const map = new Map();
  if (!eventIds || eventIds.length === 0) return map;
  const placeholders = eventIds.map(() => '?').join(',');
  const rows = d.prepare(
    `SELECT event_id, exception_date FROM calendar_event_exceptions WHERE event_id IN (${placeholders})`
  ).all(...eventIds);
  for (const row of rows) {
    if (!map.has(row.event_id)) map.set(row.event_id, emptyOccurrenceExceptions());
    map.get(row.event_id).add(row.exception_date);
  }
  return map;
}

/**
 * Trifft eine Ausnahmenmenge das Vorkommen mit diesen beiden Schluesseln?
 *
 * Nimmt beide Formen der Menge: die nach Form getrennte aus
 * `loadEventExceptions` und ein schlichtes `Set` (aeltere Aufrufer und Tests),
 * in dem jeder Eintrag gegen beide Schluessel laeuft. Die beiden Formen koennen
 * sich nicht verwechseln: ein exakter Schluessel einer getimten Serie traegt
 * immer eine Uhrzeit, ein alter nie.
 * @param {OccurrenceExceptions|Set<string>|null|undefined} exceptions
 * @param {string} key        exakter Schluessel des Vorkommens
 * @param {string} legacyKey  alter Schluessel desselben Vorkommens
 * @returns {boolean}
 */
export function exceptionsInclude(exceptions, key, legacyKey) {
  if (!exceptions) return false;
  if (exceptions instanceof Set) return exceptions.has(key) || exceptions.has(legacyKey);
  return !!(exceptions.exact?.has(key) || exceptions.legacy?.has(legacyKey)
    || exceptions.legacy?.has(key));
}

/**
 * Wo ein expandiertes Vorkommen seinen Platz in der Serie mitfuehrt (#2034):
 * `{ day, key, legacyKey }` - Schleifentag, Schluessel in Format A, alter
 * Schluessel. Ein Symbol, damit es Spreads (`{ ...instance }`) uebersteht, aber
 * nie in einer JSON-Antwort landet.
 */
export const OCCURRENCE_SLOT = Symbol('occurrenceSlot');

/** Der mitgefuehrte Platz eines expandierten Vorkommens, oder null. */
export function occurrenceSlotOf(instance) {
  return instance?.[OCCURRENCE_SLOT] ?? null;
}

function shiftKeyDay(dateKey, days) {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Wanduhr-Teil eines schwebenden Werts auf `HH:MM:SS` gebracht, sonst null. */
function floatingKeyOf(value) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(value ?? ''));
  return match ? `${match[1]}T${match[2]}:${match[3]}:${match[4] ?? '00'}` : null;
}

/**
 * Die Uhr einer Serie: wie aus dem Tag eines Vorkommens sein Start und sein
 * Schluessel werden (#2034). EINE Rechnung fuer die Expansion und fuer jeden
 * Leser oder Schreiber, der den Schluessel eines Vorkommens kennen muss, ohne
 * die Serie auszurollen (Countdown, Umschluesseln, Suche nach einem Slot).
 *
 * Der SCHLEIFENTAG (`tag`, `seriesStart`) ist der Tag, auf dem die Expansion
 * laeuft: im lokalen Modus der Tag in der Serienzone, sonst der gespeicherte
 * Tag. Die Engine erzeugt hoechstens EIN Vorkommen je Schleifentag (keine
 * BYHOUR-Regeln) - darauf beruht, dass Tag und Schluessel einander eindeutig
 * zugeordnet sind.
 *
 * Schluessel in Format A (`keyFor`), der RECURRENCE-ID von RFC 5545 nachgebaut:
 *   - ganztaegig: `YYYY-MM-DD`, der Schleifentag
 *   - mit Zone: `YYYY-MM-DDTHH:MM:SSZ`, der Originalstart als UTC-Zeitpunkt
 *   - schwebend (ohne Zone, ohne `tzid`): `YYYY-MM-DDTHH:MM:SS`, die Wanduhr
 * Die alte Form (`legacyKeyFor`) liefert eingefroren server/services/legacy-occurrence-key.js.
 *
 * @param {object} event          Serienzeile
 * @param {string|null} householdZone  wie bei expandRecurringEvents
 */
export function occurrenceClock(event, householdZone = null) {
  const isAllDay     = !!event.all_day;
  /* ZONENLOSE ZIFFERN NEBEN EINER TZID SIND WANDUHR DES HAUSHALTS (#1993).
   *
   * So entsteht die Zeile: eine eingelesene Serie wird aus dem Formular
   * gespeichert, PUT schreibt die Ziffern des Haushalts (`to: 'wall'`), die
   * `tzid` bleibt. Alles darunter las den Start mit `new Date()` und
   * `utcToWall()`, also in der Zone des PROZESSES - dieselbe Zeile ergab
   * unter TZ=UTC als letztes Vorkommen 23:30Z, unter TZ=Europe/Berlin 21:30Z.
   *
   * Hier wird der Start deshalb EINMAL zum Zeitpunkt, in der Haushaltszone
   * gelesen, und der Rest der Funktion rechnet auf diesem Zeitpunkt weiter:
   * Wanduhr der Serienzone, UTC-Tag fuer Identitaet und EXDATE, Dauer. Ohne
   * `tzid` bleibt es beim Bisherigen: dort gibt es keine zweite Uhr, die
   * Ziffern laufen als Wanduhr durch und Start und Ende lesen dieselbe Zone. */
  const zonedNaive = !!event.tzid && !isAllDay && !hasExplicitZone(event.start_datetime);
  const startText = zonedNaive
    ? (storedToInstantIso(event.start_datetime, householdZone) ?? event.start_datetime)
    : event.start_datetime;
  const endText = zonedNaive && event.end_datetime
    ? (storedToInstantIso(event.end_datetime, householdZone) ?? event.end_datetime)
    : event.end_datetime;

  // Original-Zeit-Teil erhalten (z.B. 'T14:30:00' oder '' bei All-Day)
  const timeSuffix = startText.slice(10);

  // DST-korrekte Expansion: bei bekannter TZID (CalDAV/Apple-Serie) pro Vorkommen
  // die lokale Wanduhrzeit des Masters neu nach UTC rechnen, statt den festen
  // UTC-Suffix zu wiederholen (sonst driftet die Uhrzeit über die Sommer-/
  // Winterzeit-Grenze, #549). Nur für Tagtermine, deren lokales Datum == UTC-Datum
  // ist (kein Mitternachts-Überlauf) - sonst alte Fixe-Suffix-Logik.
  const wall = (event.tzid && !isAllDay) ? utcToWall(startText, event.tzid) : null;
  const tzAware = wall && wall.date === startText.slice(0, 10);
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
   * Der Tag, an dem eine ALTE Ausnahme haengt, ist dagegen der UTC-Tag ueber
   * die alte Uhr (`legacyKeyFor`, eingefroren): so legten Import und lokale
   * Schreiber sie bis Schritt 4 von #2034 ab.
   */
  const lokalRechnen = zonenUnsicher && !!wall && !isAllDay;

  // DTSTART ist zugleich Startpunkt und ANKER: ohne ihn leitet nextOccurrence
  // den gemeinten Tag aus dem vorigen Vorkommen ab, und eine Klemmung in einem
  // kurzen Monat wuerde damit festgeschrieben (#978).
  const seriesStartUtc = startText.slice(0, 10);
  const seriesStart = lokalRechnen ? wall.date : seriesStartUtc;
  // Dieselbe Ruecknahme der Monatsletzten-Pruefung an jeder Stelle, die die
  // Regel auf Schleifentagen fortschreibt (Expansion, Countdown).
  const utcDiffersFromLocal = lokalRechnen ? false : zonenUnsicher;

  /** Der Start eines Vorkommens - im lokalen Modus zurueckgerechnet.
   *  EINE Uhr fuer Expansion und Abo-Pfad (#2034): `localToUTCOccurrence`
   *  rechnet am Umstellungstag richtig und legt Luecke und Doppelstunde fest. */
  const instantFor = (tag) => ((lokalRechnen || tzAware)
    ? localToUTCOccurrence(`${tag}T${wall.time}`, event.tzid)
    : tag + timeSuffix);

  /** Der Schluessel eines Vorkommens in Format A (#2034). */
  const keyFor = (tag) => {
    if (isAllDay) return tag;
    const start = String(instantFor(tag));
    if (hasExplicitZone(start)) {
      const ms = Date.parse(start);
      if (!Number.isNaN(ms)) return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
    }
    return floatingKeyOf(start) ?? tag;
  };

  /** Der alte Schluessel eines Vorkommens (eingefroren, Lesart von main). */
  const legacyKeyFor = legacyOccurrenceKeyFor(event, householdZone);

  /** Traegt `key` die alte Form? Nur an einer getimten Serie moeglich. */
  const isLegacyKey = (key) => !isAllDay && DATE_KEY_RE.test(String(key ?? ''));

  /**
   * Die Schleifentage, die `key` treffen kann, aufsteigend - ohne die Regel zu
   * fragen. Ein exakter Schluessel trifft hoechstens einen Tag; ein alter kann
   * zwei treffen (Umstellungsnacht) oder keinen. Der Schleifentag liegt hoechstens
   * einen Kalendertag neben dem Datum im Schluessel (UTC-Tag oder Wanduhrtag).
   */
  const dayCandidatesOfKey = (key) => {
    if (!isOccurrenceKey(key)) return [];
    const base = key.slice(0, 10);
    const legacy = isLegacyKey(key);
    if (isAllDay) return key.length === 10 ? [key] : [];
    const out = [];
    for (const offset of [-1, 0, 1]) {
      const tag = shiftKeyDay(base, offset);
      if ((legacy ? legacyKeyFor(tag) : keyFor(tag)) === key) out.push(tag);
    }
    return out;
  };

  /**
   * Ordnungswert eines Schluessels innerhalb DIESER Serie: sein (erster)
   * Schleifentag. Ersetzt den Textvergleich `recurrence_id >= ?`, der nur bei
   * einer einzigen Schluesselform traegt. Ein Schluessel ohne Tag faellt auf
   * sein Datum zurueck.
   */
  const keyOrder = (key) => dayCandidatesOfKey(key)[0] ?? String(key ?? '').slice(0, 10);

  return {
    isAllDay, startText, endText, timeSuffix, wall, tzAware, zonenUnsicher, lokalRechnen,
    seriesStart, seriesStartUtc, utcDiffersFromLocal,
    instantFor, keyFor, legacyKeyFor, isLegacyKey, dayCandidatesOfKey, keyOrder,
  };
}

/**
 * Die Haushaltszone, wenn die Expansion sie fuer DIESE Zeile braucht - sonst
 * null (#1993). Gebraucht wird sie nur bei einem getimten, zonenlosen Start
 * neben einer `tzid`; Leser, die Zeile fuer Zeile aufloesen, sparen so das
 * `SELECT` auf `sync_config` fuer jede andere.
 * @param {object} database  better-sqlite3-Connection
 * @param {object} event     Zeile aus `calendar_events`
 * @returns {string|null}
 */
export function seriesReadingZone(database, event) {
  if (!event?.tzid || event.all_day || hasExplicitZone(event.start_datetime)) return null;
  return householdTimeZone(database);
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
 *   maxOccurrencesPerSeries?: number, occurrenceFilter?: function,
 *   householdZone?: string, windowZone?: string}} [options]
 *        householdZone: Zone des Haushalts (`householdTimeZone(db)`), in der
 *        zonenlose Start-Ziffern neben einer `tzid` gelesen werden (#1993).
 *        Der Aufrufer reicht sie herein, die Expansion kennt keine Datenbank;
 *        Pflicht fuer eine solche Zeile: fehlt sie, wirft die Expansion
 *        (`storedToInstantIso`), statt still in der Prozesszone zu lesen.
 *        windowZone: die Zone, in der [from, to] gemeint sind - bei jedem
 *        LESER die Haushaltszone (#1999). Dann zaehlt fuer eine Serie mit
 *        eigener Zone der Haushaltstag ihres Vorkommens, nicht ihr eigener.
 *        Ohne sie bleibt das Fenster in Schleifentagen; so fragt die
 *        Identitaetssuche der Einzelvorkommen, deren Fenster in
 *        Schluesseltagen steht.
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
    householdZone = null, windowZone = null,
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

    // EINE Uhr fuer Expansion und jeden Leser, der einen Schluessel braucht
    // (#2034): Lesart des Starts, Schleifentage, Zeitpunkt und Schluessel je
    // Vorkommen stehen in `occurrenceClock()` oben.
    const clock = occurrenceClock(event, householdZone);
    const {
      isAllDay, startText, endText, tzAware, lokalRechnen, seriesStart, seriesStartUtc,
      utcDiffersFromLocal,
    } = clock;
    const instantFuer = clock.instantFor;

    // Dauer des Events in ms (für End-Zeit-Berechnung der Instanzen)
    const startMs    = new Date(startText).getTime();
    const endMs      = endText ? new Date(endText).getTime() : null;
    const durationMs = endMs !== null ? endMs - startMs : null;
    // Duration in days for all-day events (for date-only end calculation)
    const durationDays = isAllDay && durationMs !== null ? Math.round(durationMs / 86400000) : 0;

    /** Der ALTE Schluessel eines Vorkommens - der UTC-Tag ueber die alte Uhr.
     *
     *  Eingefroren (legacy-occurrence-key.js): auf ihm liegen alle Ausnahmen und
     *  verknuepften Einzelvorkommen, die vor Schritt 4 von #2034 geschrieben
     *  wurden, und importierte EXDATEs, die der Parser mit derselben alten Uhr
     *  auf den Tag bringt. Er bleibt der Vergleichswert fuer diese Altdaten; der
     *  Schluessel in Format A (`clock.keyFor`) steht daneben. */
    const utcTagFuer = clock.legacyKeyFor;

    /* DAS FENSTER IST IN HAUSHALTSTAGEN GEMEINT, DIE SCHLEIFE NICHT (#1999).
     *
     * Bei einer Serie mit eigener Zone laeuft `currentDate` auf dem Tag dieser
     * Zone (oben), die Leser bilden [from, to] aber aus der Haushaltszone
     * (`todayKey()`, Anzeigetage). Verglichen wurden die beiden direkt: Haushalt
     * Berlin, Serie Los Angeles 23:30 - das Vorkommen vom LA-11.06. ist in
     * Berlin der 12.06. 08:30, fiel aber aus einem Fenster ab dem 12.06., und
     * die Suche nannte den Termin eine Woche spaeter. Andersherum (Tokio 01:00)
     * stand ein Vorkommen von gestern als naechster Termin da.
     *
     * Nennt der Leser die Zone seines Fensters, fragt das Fenster deshalb nach
     * dem Haushaltstag des Vorkommens - nur dort, wo das Vorkommen einen
     * Zeitpunkt hat (`instantFuer` rechnet ueber die Serienzone). Zonenlose und
     * ganztaegige Serien laufen schon auf dem Tag, den das Fenster meint.
     *
     * Die Schleife laeuft dafuer zwei Tage ueber `to` hinaus: weiter als zwei
     * Kalendertage koennen zwei Zonen nicht auseinanderliegen (-12 bis +14).
     * Das Fenster selbst bleibt exakt. NUR das Fenster: Schluessel, EXDATE und
     * Ausgabe bleiben, wie sie sind (`utcTagFuer`, #2034 Schritt 4). */
    const fensterZone = windowZone && (lokalRechnen || tzAware) ? windowZone : null;
    const schleifenEnde = fensterZone ? shiftDateKey(to, 2) : to;

    let currentDate = seriesStart; // YYYY-MM-DD, lokal oder UTC je nach Modus
    let iterations  = 0;
    const exceptions = exceptionsByEvent?.get(event.id) ?? null; // ausgenommene Instanz-Daten (#489)
    // COUNT=N begrenzt die Serie auf N Vorkommen ab DTSTART. Gezählt wird über
    // die Instanzen der Serie (nicht das Anzeigefenster) und VOR EXDATE-Entfernung
    // (RFC 5545): ausgenommene Vorkommen zählen mit, erzeugen aber keine Instanz (#513).
    const parsedRule = parseRRule(event.recurrence_rule);
    const maxCount   = parsedRule?.count ?? null;
    // UNTIL ALS ZEITPUNKT, WO ES EINER IST (#1269). Null heisst "nur als Tag
    // genannt" - dann bleibt es beim groben Tagesgatter in `nextOccurrence`.
    const untilMs    = untilInstantMs(parsedRule, { tzid: event.tzid, toUTC: localToUTCOccurrence });
    let   occurrence = 0;
    let accepted = 0;

    while (currentDate <= schleifenEnde && iterations < iterationLimit) {
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
      if (!matchesRRuleByday(currentDate, event.recurrence_rule, { utcDiffersFromLocal })) {
        const next = nextOccurrence(currentDate, event.recurrence_rule, { anchor: seriesStart, utcDiffersFromLocal });
        if (!next || next <= currentDate) break;
        currentDate = next;
        continue;
      }

      /* UNTIL IST EIN ZEITPUNKT, KEIN TAG (#1269; die drei Schreibweisen stehen
       * ueber `parseUntilSpec` in recurrence.js).
       *
       * `nextOccurrence` zieht die Grenze auf Tagesschluesseln, und das ist ein
       * Tag zu grosszuegig, sobald das Ende MITTEN in einem Tag liegt. Genau so
       * schneidet Open-Xchange eine Serie: das Ende der alten Serie ist eine
       * Sekunde vor dem Start am Schnitttag, die neue beginnt an ihm - der
       * Termin stand an diesem einen Tag zweimal. Hier, wo der Zeitpunkt des
       * Vorkommens bekannt ist, wird daraus ein Vergleich von Zeitpunkten.
       *
       * VOR DEM ZAEHLEN: was hinter UNTIL liegt, ist kein Vorkommen der Serie
       * und darf auch nicht gegen COUNT zaehlen (dieselbe Unterscheidung wie
       * beim BYDAY-Filter darueber).
       *
       * NUR WO DAS VORKOMMEN SEINE ZONE SELBST TRAEGT. Ein ganztaegiges oder
       * zonenloses Vorkommen HAT keinen Zeitpunkt; ihm hier eine Zone zu
       * unterstellen waere derselbe Fehler noch einmal, nur andersherum. Dort
       * bleibt es beim Tag - und eine Ganztagsserie behaelt ihren letzten Tag.
       */
      let occStart = null;
      if (untilMs !== null) {
        occStart = instantFuer(currentDate);
        if (hasExplicitZone(occStart) && Date.parse(occStart) > untilMs) break;
      }

      if (maxCount !== null && occurrence >= maxCount) break;
      occurrence++;

      // Beide Schluessel des Vorkommens (#2034): eine Ausnahme in Format A
      // trifft genau dieses, eine alte (UTC-Tag ueber die alte Uhr, so legen
      // Import und Altdaten sie ab, #985) das, was sie auf main traf.
      const slotKey = clock.keyFor(currentDate);
      const slotLegacyKey = utcTagFuer(currentDate);
      if (exceptionsInclude(exceptions, slotKey, slotLegacyKey)) {
        const next = nextOccurrence(currentDate, event.recurrence_rule, { anchor: seriesStart, utcDiffersFromLocal });
        if (!next || next <= currentDate) break;
        currentDate = next;
        continue;
      }

      // Der Tag, an dem das Fenster dieses Vorkommen sieht (#1999, oben).
      let fensterTag = currentDate;
      if (fensterZone) {
        occStart = occStart ?? instantFuer(currentDate);
        fensterTag = utcToWall(occStart, fensterZone)?.date ?? currentDate;
        // Die Vorkommen sind aufsteigend: hinter `to` kommt keins mehr hinein.
        if (fensterTag > to) break;
      }

      // For multi-day events, check if the instance end reaches into [from, to]
      let instanceEnd = fensterTag;
      if (isAllDay && durationDays > 0) {
        const d = new Date(currentDate + 'T00:00:00');
        d.setDate(d.getDate() + durationDays);
        instanceEnd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }

      if (fensterTag >= from || instanceEnd >= from) {
        const newStart = occStart ?? instantFuer(currentDate);
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
             * `instantFuer()` den Start ueber `localToUTCOccurrence()`, also mit `Z`,
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
          // (`exceptionsInclude(...)`).
          //
          // SEIT SCHRITT 4 VON #2034 IST DIE IDENTITAET DER SCHLUESSEL IN FORMAT A:
          // der Originalstart nach RFC 5545 (Datum, UTC-Zeitpunkt oder schwebende
          // Wanduhr). Der UTC-Tag oben war nicht eindeutig - in der
          // Umstellungsnacht trugen zwei Vorkommen denselben Tag, und eine
          // Ausnahme blendete beide aus. Den Platz in beiden Formen traegt das
          // Vorkommen als Symbol mit (`OCCURRENCE_SLOT`), damit Leser und
          // Schreiber ihn nicht nachrechnen.
          ...(includeRecurrenceIdentity ? { recurrence_identity: slotKey } : {}),
          [OCCURRENCE_SLOT]: { day: currentDate, key: slotKey, legacyKey: slotLegacyKey },
          is_recurring_instance: slotLegacyKey !== seriesStartUtc ? 1 : 0,
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

      const next = nextOccurrence(currentDate, event.recurrence_rule, { anchor: seriesStart, utcDiffersFromLocal });
      if (!next || next <= currentDate) break;
      currentDate = next;
    }
  }

  return result.sort((a, b) => a.start_datetime.localeCompare(b.start_datetime));
}
