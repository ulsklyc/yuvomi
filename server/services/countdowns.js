/**
 * Modul: Countdowns (#647)
 * Zweck: Die als Countdown markierten Termine und Aufgaben und die bald
 *        ablaufenden Dokumente zu EINER nach Nähe sortierten Liste
 *        zusammenführen - die Datenseite des Übersichts-Widgets.
 * Abhängigkeiten: server/services/calendar-events.js, server/services/visibility.js,
 *                 server/services/document-access.js
 *
 * WARUM ZWEI QUELLEN UND NICHT EINE TABELLE. Der Thread zu #647 ist genau an
 * dieser Frage entlanggegangen und bei zwei Quellen gelandet: @Kyrodan zählt bis
 * zu Dingen, die er ohnehin als Termin führt (Urlaub, „Disney+ verlängern"),
 * @jamespurnama1 bis zu Dingen, die keine Termine sind (Führerschein,
 * Luftfilter) und deren Rücksetzung auf eine DAUER hängt, nicht auf ein Datum -
 * also auf `recurrence_from_completion` (#658), das die Aufgaben schon können.
 * Ein drittes Objekt hätte für beide eine zweite Schreibweise derselben
 * Fälligkeit bedeutet. Das Zusammenführen kostet dafür diese Datei.
 *
 * WAS VORBEI IST, BLEIBT EINE NACHFRIST LANG STEHEN. Hier stand das Gegenteil:
 * ein Countdown, dessen Tag vorbei war, fiel sofort heraus. Die Begründung war,
 * dass „überfällig" für Aufgaben schon an drei Stellen steht und ein vierter Ort
 * eine zweite Wahrheit wäre.
 *
 * Sie hielt nicht stand (Critique 2026-08-17). Für TERMINE gibt es „überfällig"
 * nirgends, und der Anlassfall des ganzen Threads ist ein Ablaufdatum:
 * Führerschein, Versicherung, Vertrag. Ein Countdown, der genau beim Aufprall
 * aufhört zu zählen, lässt den Nutzer im einen Moment allein, für den er ihn
 * gesetzt hat - am Vortag steht „Morgen", am Tag danach steht nichts mehr, und
 * niemand sagt ihm, dass er es verpasst hat.
 *
 * WARUM DOKUMENTE DIE DRITTE QUELLE SIND UND KEIN MARKER TRAGEN (#1705). Termine
 * und Aufgaben stehen hier, weil jemand sie markiert hat. Ein Dokument hat mit
 * seinem Ablaufdatum schon gesagt, dass es einen Stichtag hat; ein Häkchen wäre
 * eine zweite Angabe derselben Sache. Dafür steht es erst ab seinem Vorlauf hier
 * (`expiryDueSoon()` in public/utils/document-expiry.js), demselben Tag, an dem
 * Erinnerung und Chip kommen (#1036). Sonst stünde jeder Pass zehn Jahre lang in
 * einer Kachel, die eine kurze Liste sein soll.
 *
 * Die Nachfrist gilt für ALLE Quellen, obwohl das Aufgaben-Argument von oben
 * dort weiter gilt. Zwei Regeln in einer Kachel wären teurer als die
 * Wiederholung: diese Liste enthält nur ausdrücklich Markiertes, also eine
 * kleine kuratierte Menge, und dort ist „seit 3 Tagen abgelaufen" keine vierte
 * Überfälligkeits-Liste, sondern das Ende genau dieses einen Countdowns.
 *
 * Heute zählt mit: „heute läuft der Führerschein ab" ist die wichtigste Anzeige,
 * die dieses Widget je hat.
 */

import { localCalendarColorSql, localCalendarIdSql } from './local-calendars.js';

import { expandRecurringEvents, loadEventExceptions, MAX_EXPANSION_ITERATIONS } from './calendar-events.js';
import { modulesLeftOut, notBirthdayEventSql } from './household-modules.js';
import { eventProjectionSql, resolveProjectedEventRows } from './calendar-event-reader.js';
import { icsSubscriptionVisibleWhere, visibilityWhere } from './visibility.js';
import { documentVisibleSql } from './document-access.js';
import { hasExplicitZone, householdTimeZone, storedToWall, utcToWall } from '../utils/timezone.js';
// Dieselbe Rangfolge wie im Kalender und auf der Uebersicht - eine Regel, eine
// Datei. Der Server importiert oefter aus `public/utils/` (date, folder-tree,
// currency-codes, ...), immer fuer abhaengigkeitsfreie geteilte Regeln.
import { resolveEventColorOrNull } from '../../public/utils/event-color.js';
import { expiryDueSoon } from '../../public/utils/document-expiry.js';

// So viele Countdowns liefert der Server. Die Kachel entscheidet wie überall
// selbst, wie viele davon sie zeigt (`listRowCap` in pages/dashboard.js) - der
// Vorrat ist für die größte Fassung bemessen, wie bei den Geburtstagen.
const DEFAULT_LIMIT = 5;

/**
 * So viele Tage bleibt ein abgelaufener Countdown stehen, bevor er still
 * herausfällt - solange der Haushalt nichts anderes einstellt (#969).
 *
 * Sieben, weil die Nachfrist eine Woche Alltag abdecken soll: wer freitags nicht
 * hinsieht, findet den verpassten Stichtag am Montag noch vor. Länger wäre keine
 * Nachfrist mehr, sondern eine zweite Aufgabenliste - und diese Kachel ist
 * ausdrücklich keine.
 */
export const DEFAULT_OVERDUE_GRACE_DAYS = 7;

// Das Ende des Fensters, in dem die Kachel das naechste Vorkommen sucht: keine
// fachliche Grenze, sondern der letzte Tag, der als YYYY-MM-DD noch richtig
// sortiert (die Expansion haengt zwei Tage an). Die Serie endet vorher an ihrer
// Regel oder an der Iterationsgrenze der Expansion (#1998).
const LAST_DAY = '9999-12-29';

/**
 * Ganze Tage zwischen zwei Datumsschlüsseln (YYYY-MM-DD).
 *
 * Über Date.UTC, nicht über lokale Date-Objekte: die Differenz zweier lokaler
 * Mitternachten ist an einer Zeitumstellung 23 bzw. 25 Stunden lang und ergibt
 * geteilt durch 86400000 nicht 1. Dieselbe Rechnung wie in
 * services/birthdays.js und public/utils/countdown.js.
 */
export function daysBetween(fromKey, toKey) {
  const from = parseKey(fromKey);
  const to = parseKey(toKey);
  if (from === null || to === null) return null;
  return Math.round((to - from) / 86400000);
}

function parseKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? '').slice(0, 10));
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** `dateKey` um `days` Tage verschoben, wieder als YYYY-MM-DD. */
function shiftKey(dateKey, days) {
  const ms = parseKey(dateKey);
  if (ms === null) return null;
  return new Date(ms + days * 86400000).toISOString().slice(0, 10);
}

/**
 * Der Kalendertag, an dem ein Termin beginnt - in der Zone, in der auch
 * `todayKey` gebildet wird.
 *
 * DER UNTERSCHIED ZWISCHEN BEIDEN ZWEIGEN IST EIN GANZER TAG. Ein ganztägiger
 * Termin trägt sein Datum ohne Zeitanteil; da gibt es nichts umzurechnen, und
 * wer es trotzdem täte, verschöbe ihn. Ein Termin MIT Uhrzeit steht dagegen als
 * UTC in der Datenbank: „21.09. um 01:00" mitteleuropäischer Sommerzeit ist dort
 * der 20.09. um 23:00Z, und der rohe Datumsanteil hätte den Countdown genau um
 * die Differenz zwischen zwei Zahlen daneben liegen lassen, die beide „das
 * Datum" heissen. Gerechnet wird gegen dieselbe Zone, aus der die Route ihren
 * `todayKey` bildet - ein Vergleich zweier Kalendertage taugt nur, wenn beide
 * aus demselben Kalender stammen.
 *
 * ZONENLOSE ZIFFERN SIND SCHON DER TAG (#1998). Ein lokal angelegter Termin
 * steht als Wanduhr des Haushalts in der Zeile (`2035-10-02T23:30`). Hier lief
 * auch er durch `utcToWall()`, also ueber `new Date()` in der Zone des
 * PROZESSES: im Container mit TZ=UTC und Haushalt Berlin wurde aus 23:30 der
 * Folgetag. `storedToWall()` liest solche Ziffern in der Haushaltszone, nimmt
 * einen Instant wie er ist und rechnet beide auf die Wanduhr derselben Zone.
 */
function eventStartDateKey(event, tz) {
  const raw = String(event.start_datetime ?? '');
  const key = event.all_day || raw.length <= 10
    ? raw.slice(0, 10)
    : (storedToWall(raw, tz, tz)?.date ?? raw.slice(0, 10));
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null;
}

/**
 * Das nächste Vorkommen eines Termins ab (einschliesslich) `todayKey`.
 *
 * Ein einmaliger Termin ist sein eigenes Vorkommen; liegt er hinter uns, bleibt
 * er die Nachfrist lang stehen (`graceDays`) und fällt danach heraus. Eine Serie
 * wird aufgeholt; ausgenommene Instanzen (EXDATE) werden übersprungen, sonst
 * zeigte der Countdown auf einen Tag, an dem nichts stattfindet.
 *
 * DIE NACHFRIST GILT NUR FÜR EINMALIGES, und das ist keine Vereinfachung,
 * sondern der Unterschied selbst: eine jährliche Verlängerung ist nie
 * „abgelaufen", sie hat ein nächstes Mal. Wer ihr die Nachfrist gäbe, zeigte
 * „seit 3 Tagen abgelaufen" für einen Termin, der in 362 Tagen wieder ansteht.
 *
 * @returns {string|null} YYYY-MM-DD oder null
 */
export function nextEventDate(event, todayKey, exceptions = null, { graceDays = 0, tz = householdTimeZone(null) } = {}) {
  const startKey = eventStartDateKey(event, tz);
  if (!startKey) return null;
  if (!event.recurrence_rule) {
    const floor = graceDays > 0 ? shiftKey(todayKey, -graceDays) : todayKey;
    return floor && startKey >= floor ? startKey : null;
  }

  /* DER COUNTDOWN FRAGT DIE EXPANSION DES KALENDERS (#1998).
   *
   * Bis hierher rechnete die Kachel die Serie selbst nach: Startpruefung
   * (`hasAnyOccurrence`, `seriesStartFor`, #960), Aufholen ueber
   * `nextOccurrenceAfter` (#877), Ausnahmen (#489) und seit #2034 die Uhr der
   * Expansion. Jede dieser Stellen war eine zweite Antwort auf eine Frage, die
   * `expandRecurringEvents` schon beantwortet - und an einer zonierten Serie
   * fiel das auseinander: ein UNTIL mit Uhrzeit wurde nur als Tag gelesen, ein
   * monatliches COUNT nach dem 28. lief ueber sein Ende hinaus
   * (`nextOccurrenceAfter` kennt dort keine COUNT-Grenze), und eine
   * Wochentagsregel nannte einen DTSTART, der gar nicht auf ihr liegt. Der
   * Kalender zeigte nichts mehr, die Kachel zaehlte weiter.
   *
   * Jetzt rollt die Kachel die Serie mit derselben Expansion aus wie der
   * Kalender: COUNT, UNTIL, EXDATE, Monatsletzter und Zone gelten dort per
   * Konstruktion. Gesucht wird das erste Vorkommen, dessen Haushaltstag heute
   * oder spaeter ist (`occurrenceFilter`, `maxOccurrencesPerSeries`).
   *
   * DIE ARBEIT BEGINNT NAHE AN HEUTE, nicht an DTSTART (`resumeNear`): ohne
   * COUNT haengt kein Vorkommen an den frueheren, also setzt die Schleife ein
   * paar Schleifentage vor heute ein. Zwei Zonen liegen hoechstens gut zwei
   * Kalendertage auseinander (-12 bis +14); drei Tage Vorlauf decken jedes
   * Vorkommen ab, das im Haushalt heute oder spaeter liegt. Mit COUNT zaehlt
   * die Expansion ab DTSTART und ist durch COUNT selbst begrenzt.
   *
   * KEINE FESTE OBERGRENZE: das Fenster reicht bis ans Ende des Kalenders, die
   * Serie endet an ihrer eigenen Regel oder an der Iterationsgrenze der
   * Expansion. Ein Vorkommen in 40 Jahren ist trotzdem ein Vorkommen. */
  const floor = shiftKey(todayKey, -3) ?? todayKey;
  const householdDayOf = (start) => {
    const raw = String(start ?? '');
    if (event.all_day || raw.length <= 10 || !hasExplicitZone(raw)) return raw.slice(0, 10);
    return utcToWall(raw, tz)?.date ?? raw.slice(0, 10);
  };
  let next;
  try {
    [next] = expandRecurringEvents(
      [event], floor, LAST_DAY, new Map([[event.id, exceptions]]),
      {
        householdZone: tz,
        maxIterations: MAX_EXPANSION_ITERATIONS,
        maxOccurrencesPerSeries: 1,
        resumeNear: floor,
        occurrenceFilter: (instance) => householdDayOf(instance.start_datetime) >= todayKey,
      },
    );
  } catch {
    // Eine Zeile, deren Start sich nicht lesen laesst, hat kein Vorkommen,
    // das diese Kachel nennen koennte - lieber nichts als ein falscher Tag.
    return null;
  }
  return next ? householdDayOf(next.start_datetime) : null;
}

/**
 * Die haushaltweite Nachfrist in Tagen (#969) - `Number.isInteger`, nicht `||`,
 * damit ein bewusst gesetztes `0` ("keine Nachfrist") nicht auf den Standard
 * zurückfällt.
 */
function overdueGraceDays(d) {
  const row = d.prepare("SELECT value FROM sync_config WHERE key = 'countdown_grace_days'").get();
  const parsed = Number(row?.value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_OVERDUE_GRACE_DAYS;
}

/**
 * Die Quellen der Kachel: das Modul, dem ihre Zeilen gehören, und wie sie
 * gelesen werden. `getCountdowns()` fragt Schalter und Rechte einmal vor allen
 * Quellen, eine neue Quelle bringt deshalb nur ihren Leser und ihr Modul mit.
 */
const COUNTDOWN_SOURCES = [
  { module: 'calendar', read: eventCountdowns },
  { module: 'tasks', read: taskCountdowns },
  { module: 'documents', read: documentCountdowns },
];

/**
 * Aus diesen Modulen liest die Kachel. `hiddenModulesFor()` prueft Token-Scopes
 * nur fuer die Module, die man ihm nennt; die Route nennt diese Liste, damit
 * eine neue Quelle die Pruefung nicht verpasst.
 */
export const COUNTDOWN_MODULES = COUNTDOWN_SOURCES.map((source) => source.module);

/**
 * Alle für `userId` sichtbaren Countdowns, nach Nähe sortiert.
 *
 * @param {object} d            Offene DB-Verbindung
 * @param {object} opts
 * @param {number} opts.userId  Betrachter (Sichtbarkeitsfilter)
 * @param {string} opts.todayKey YYYY-MM-DD in der LOKALEN Zeit des Servers
 * @param {Set<string>|null} [opts.hiddenModules] Module, die dem BETRACHTER
 *        entzogen sind (`access_permissions`, #467) - eine andere Achse als die
 *        haushaltweite Abschaltung unten, die dieselbe Antwort verdient.
 * @param {number} [opts.limit]
 * @returns {{items: Array<{source: 'event'|'task'|'document', id: number, title: string,
 *                  date: string, days_until: number, icon: string|null,
 *                  color: string|null, recurring: boolean,
 *                  person_name?: string|null}>, total: number}}
 */
export function getCountdowns(d, {
  userId = null, todayKey, hiddenModules = null, limit = DEFAULT_LIMIT,
} = {}) {
  /* EIN ABGESCHALTETES MODUL LIEFERT HIER GAR NICHTS MEHR (Review zu PR #793).
   *
   * Bis hierher fragte der Server beide Quellen ab, deckelte auf fünf und
   * überliess das Aussortieren dem Browser. Das ging bei jeder anderen Kachel
   * gut, weil dort die KACHEL einem Modul gehört und mit ihm verschwindet -
   * diese gehört mehreren, und ihre blosse Existenz hängt an der gefilterten
   * Menge (`countdownAvailable` in pages/dashboard.js).
   *
   * Der Fall: Kalender abgeschaltet, die fünf nächsten Countdowns sind Termine,
   * eine markierte Aufgabe steht dahinter. Der Server schickte die fünf
   * Termine, der Browser warf alle fünf weg, und die Kachel verschwand samt
   * ihrem Eintrag in der Anpassen-Ablage - wegen Einträgen, die der Haushalt
   * gar nicht sehen darf. Die Aufgabe war nie unterwegs.
   *
   * Deshalb hier und nicht dort: Filter, Sortierung, Schnitt und Gesamtzahl
   * müssen dieselbe Menge meinen. Ein nachgelagerter Filter macht aus `total`
   * wieder die Sorte Zahl, die nur bis zu ihrer Obergrenze stimmt. Der
   * Browser-Filter bleibt trotzdem stehen: er fängt das Umschalten eines
   * Moduls ohne neuen Ladevorgang ab.
   *
   * ZWEI ACHSEN, EIN SCHNITT. `disabled_modules` schaltet ein Modul für den
   * GANZEN Haushalt ab; `access_permissions` entzieht es einem einzelnen
   * Mitglied (#467). Für diese Liste laufen beide auf dieselbe Frage hinaus -
   * darf dieser Betrachter diese Zeile sehen? -, und deshalb landen sie in
   * einem Set und nicht in zwei nacheinander angewandten Filtern. Der
   * Unterschied wäre sonst wieder `total`: zwei Schnitte, zwei Wahrheiten. */
  const hidden = modulesLeftOut(d, hiddenModules);
  const graceDays = overdueGraceDays(d);
  const items = COUNTDOWN_SOURCES
    .filter((source) => !hidden.has(source.module))
    .flatMap((source) => source.read(d, { userId, todayKey, graceDays, hidden }));

  const sorted = items
    // Nächstes zuerst - überfällige also ganz oben, weil ihre Tageszahl negativ
    // ist. Bei gleichem Tag alphabetisch, damit die Reihenfolge zwischen zwei
    // Aufrufen nicht wackelt.
    .sort((a, b) => a.days_until - b.days_until
      || a.title.localeCompare(b.title)
      || a.source.localeCompare(b.source));

  /* DIE GESAMTZAHL WANDERT MIT, damit der Schnitt sich nicht selbst verschweigt.
   * Der Server deckelte bei fünf und sagte es niemandem: bei sechs markierten
   * Einträgen war der sechste unsichtbar UND unauffindbar, und die Kachel sah
   * dabei vollständig aus. Eine Zahl, die genau bis zu ihrer Obergrenze stimmt,
   * ist die gefährlichste Sorte - dieselbe Lehre wie bei `openTaskCount` und
   * `pinnedNotesCount` in routes/dashboard.js.
   *
   * Als Paar zurückgegeben und nicht als Feld am Array: ein Array mit einer
   * angehefteten Eigenschaft überlebt kein `JSON.stringify`. */
  return { items: sorted.slice(0, limit), total: sorted.length };
}

function eventCountdowns(d, { userId, todayKey, graceDays, hidden }) {
  // Ein Geburtstagstermin kann als Countdown markiert sein. Er steht in
  // `calendar_events`, gehoert aber dem Schalter `birthdays` (#1660).
  const withBirthdays = !hidden.has('birthdays');
  // Einmal je Lauf statt je Termin: die Zone steht in sync_config und aendert
  // sich innerhalb eines Requests nicht.
  const tz = householdTimeZone(d);
  const rows = d.prepare(`
    SELECT ${eventProjectionSql(d)},
           -- Die geliehene Farbe braucht dieselben drei Quellen wie im Kalender
           -- (#891). Hier reicht EINE Person statt des ganzen Avatar-Stacks: die
           -- Kachel zeigt eine Kante, keine Personenliste.
           --
           -- Der COALESCE ist der Fall "primaeres Mitglied geloescht": dann
           -- setzt der Fremdschluessel assigned_to auf NULL und nimmt dessen
           -- Zuweisungszeile mit, waehrend die uebrigen Zugewiesenen bleiben.
           -- Der Kalender faellt dort auf den ersten verbliebenen zurueck
           -- (assignees.find(...) ?? assignees[0]); ohne dieselbe Ruecknahme
           -- zeigte die Kachel als einzige Stelle den Modulton.
           COALESCE(u.avatar_color, (
             SELECT u2.avatar_color FROM event_assignments ea
             JOIN users u2 ON u2.id = ea.user_id
             WHERE ea.event_id = e.id
             ORDER BY ea.user_id
             LIMIT 1
           )) AS assigned_color,
           COALESCE(ec.color, isub.color) AS cal_color,
           ${localCalendarColorSql()} AS local_calendar_color
    FROM calendar_events e
    LEFT JOIN users u ON u.id = e.assigned_to
    LEFT JOIN external_calendars ec ON ec.id = e.calendar_ref_id
    LEFT JOIN ics_subscriptions isub ON isub.id = e.subscription_id
    LEFT JOIN local_calendars lc ON lc.id = ${localCalendarIdSql()}
    WHERE e.countdown = 1
      AND ${icsSubscriptionVisibleWhere('e')}
      AND ${visibilityWhere('e', 'event_assignments', 'event_id')}${
        withBirthdays ? '' : ` AND ${notBirthdayEventSql('e')}`}
  `).all(userId, userId, userId);

  const exceptionsByEvent = loadEventExceptions(
    d,
    rows.filter((e) => e.recurrence_rule).map((e) => e.id),
  );
  const resolvedRows = resolveProjectedEventRows(d, rows, { lightweight: true });

  const out = [];
  for (const row of resolvedRows) {
    // A linked replacement is one concrete displayed occurrence. Resolution
    // intentionally inherits the master's RRULE for identity and presentation,
    // but the countdown must not expand that rule again from the moved DTSTART.
    const countdownEvent = row.is_occurrence_override
      ? { ...row, recurrence_rule: null }
      : row;
    const date = nextEventDate(countdownEvent, todayKey, exceptionsByEvent.get(row.id) ?? null, {
      graceDays, tz,
    });
    if (!date) continue;
    const days = daysBetween(todayKey, date);
    // Negativ ist jetzt erlaubt - `nextEventDate` hat die Nachfrist schon
    // durchgesetzt, und ein zweiter Riegel hier hätte sie stillschweigend
    // wieder aufgehoben.
    if (days === null || days < -graceDays) continue;
    out.push({
      source: 'event',
      id: row.id,
      title: row.title,
      date,
      days_until: days,
      icon: row.icon || 'calendar',
      // Nicht `row.color`: ein Termin darf seit #891 ohne eigene Farbe sein und
      // leiht sich dann die der zugewiesenen Person. Ohne diesen Schritt faellt
      // genau so ein Termin auf den Modulton zurueck - er saehe hier farblos
      // aus und im Kalender daneben in der Farbe der Person.
      color: resolveEventColorOrNull({
        color: row.color,
        assigned_to: row.assigned_to,
        assigned_users: row.assigned_color ? [{ id: row.assigned_to, color: row.assigned_color }] : [],
        cal_color: row.cal_color,
        local_calendar_color: row.local_calendar_color,
      }),
      recurring: Boolean(row.recurrence_rule),
      ...(row.is_occurrence_override ? {
        series_id: row.series_id,
        recurrence_id: row.recurrence_id,
        is_occurrence_override: true,
        assignment_owner_id: row.assignment_owner_id,
        attachment_owner_id: row.attachment_owner_id,
        reminder_owner_id: row.reminder_owner_id,
        reminder_anchor_start: row.reminder_anchor_start,
      } : {}),
    });
  }
  return out;
}

function taskCountdowns(d, { userId, todayKey, graceDays }) {
  // Eine erledigte oder abgelegte Aufgabe zählt nicht mehr herunter: bei einer
  // wiederkehrenden hat das Abhaken die NÄCHSTE Instanz schon erzeugt (die dann
  // ihrerseits hier steht), und eine abgelegte ist aus dem Lauf genommen -
  // dieselbe Regel wie in „Heute auf einen Blick" (#688).
  //
  // Die Untergrenze ist die Nachfrist, nicht heute: eine markierte Aufgabe, die
  // gestern fällig war, ist genau der Moment, für den jemand sie markiert hat.
  // Wiederkehrende sind ausgenommen - für sie hat das Abhaken ein nächstes Mal,
  // sie laufen nicht ab.
  const floor = shiftKey(todayKey, -graceDays) ?? todayKey;
  const rows = d.prepare(`
    SELECT t.id, t.title, t.due_date, t.is_recurring, t.recurrence_from_completion
    FROM tasks t
    WHERE t.countdown = 1
      AND t.status != 'done'
      AND t.archived_at IS NULL
      AND t.due_date IS NOT NULL
      AND t.due_date >= CASE WHEN t.is_recurring = 1 THEN @today ELSE @floor END
      AND ${visibilityWhere('t', 'task_assignments', 'task_id', '@me')}
  `).all({ today: todayKey, floor, me: userId });

  const out = [];
  for (const row of rows) {
    const days = daysBetween(todayKey, row.due_date);
    if (days === null || days < -graceDays) continue;
    out.push({
      source: 'task',
      id: row.id,
      title: row.title,
      date: row.due_date,
      days_until: days,
      icon: 'check-square',
      color: null,
      recurring: Boolean(row.is_recurring),
    });
  }
  return out;
}

function documentCountdowns(d, { userId, todayKey, graceDays }) {
  // Dieselbe Untergrenze wie bei den Aufgaben. Die Obergrenze steht unten und
  // nicht in der Abfrage: sie ist je Dokument eine andere, und ihre Regel lebt
  // in `expiryDueSoon()`, die auch der Chip der Dokumentseite fragt.
  const floor = shiftKey(todayKey, -graceDays) ?? todayKey;
  const rows = d.prepare(`
    SELECT x.id, x.name, x.expires_at, x.expiry_reminder_days,
           subject.display_name AS person_name
    FROM family_documents x
    LEFT JOIN users subject ON subject.id = x.subject_user_id
    WHERE x.status = 'active'
      AND x.expires_at IS NOT NULL
      AND x.expires_at >= @floor
      AND ${documentVisibleSql('x', 'me')}
  `).all({ floor, me: userId });

  const out = [];
  for (const row of rows) {
    const days = daysBetween(todayKey, row.expires_at);
    if (days === null || days < -graceDays || !expiryDueSoon(days, row)) continue;
    out.push({
      source: 'document',
      id: row.id,
      title: row.name,
      date: row.expires_at.slice(0, 10),
      days_until: days,
      icon: 'file-text',
      color: null,
      recurring: false,
      person_name: row.person_name,
    });
  }
  return out;
}
