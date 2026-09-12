/**
 * Modul: Countdowns (#647)
 * Zweck: Die als Countdown markierten Termine und Aufgaben zu EINER nach
 *        Nähe sortierten Liste zusammenführen - die Datenseite des
 *        Übersichts-Widgets.
 * Abhängigkeiten: server/services/recurrence.js, server/services/visibility.js
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
 * Die Nachfrist gilt für BEIDE Quellen, obwohl das Aufgaben-Argument von oben
 * dort weiter gilt. Zwei Regeln in einer Kachel wären teurer als die
 * Wiederholung: diese Liste enthält nur ausdrücklich Markiertes, also eine
 * kleine kuratierte Menge, und dort ist „seit 3 Tagen abgelaufen" keine vierte
 * Überfälligkeits-Liste, sondern das Ende genau dieses einen Countdowns.
 *
 * Heute zählt mit: „heute läuft der Führerschein ab" ist die wichtigste Anzeige,
 * die dieses Widget je hat.
 */

import { hasAnyOccurrence, nextOccurrenceAfter, seriesStartFor } from './recurrence.js';
import { loadEventExceptions } from './calendar-events.js';
import { eventProjectionSql, resolveProjectedEventRows } from './calendar-event-reader.js';
import { visibilityWhere } from './visibility.js';
import { householdTimeZone, utcToWall } from '../utils/timezone.js';
// Dieselbe Rangfolge wie im Kalender und auf der Uebersicht - eine Regel, eine
// Datei. Der Server importiert oefter aus `public/utils/` (date, folder-tree,
// currency-codes, ...), immer fuer abhaengigkeitsfreie geteilte Regeln.
import { resolveEventColorOrNull } from '../../public/utils/event-color.js';

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

// Sicherheitsgrenze beim Aufholen einer Serie über ausgenommene Vorkommen
// (EXDATE, #489). Eine Serie, die mehr als das an aufeinanderfolgenden
// Ausnahmen trägt, hat kein nächstes Vorkommen, das dieses Widget zeigen müsste.
const MAX_EXCEPTION_SKIPS = 50;

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
 */
function eventStartDateKey(event, tz) {
  const raw = String(event.start_datetime ?? '');
  const key = event.all_day || raw.length <= 10
    ? raw.slice(0, 10)
    : (utcToWall(raw, tz)?.date ?? raw.slice(0, 10));
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

  /* `seriesStart` SETZT COUNT DURCH (#877). Ohne die Angabe zaehlte eine Serie
   * mit "endet nach N Malen" endlos weiter: `nextOccurrence()` ist zustandslos
   * und weiss nicht, das wievielte Vorkommen es liefert. Gemeldet wurde das als
   * "abgelaufene Termine bleiben unbegrenzt stehen" - und es war sogar der
   * schlimmere Fall, weil die Kachel dazu ein Datum in der ZUKUNFT nannte.
   *
   * Die Kalender-Oberflaeche bietet "endet nach N Malen" ausdruecklich an
   * (`allowCount` in pages/calendar.js), das ist also keine Sonderform. */
  // DER START IST NUR DANN DER NAECHSTE TERMIN, WENN ER AUF DER REGEL LIEGT.
  // Ein Termin am 15. mit "am letzten Tag des Monats" hat am 15. kein
  // Vorkommen - der Countdown zeigte es trotzdem an, weil dieser Zweig das
  // Startdatum ungeprueft durchreicht, sobald es in der Zukunft liegt. Das
  // gespeicherte Datum bleibt dabei unangetastet - gefragt wird nur, welcher
  // Tag der erste ist.
  //
  // OHNE TREFFER GIBT `seriesStartFor` DAS DATUM ZURUECK, DAS ES BEKOMMEN HAT.
  // Das ist der richtige Umgang fuer eine Funktion, die nichts erfinden soll -
  // hier waere es aber genau der Fehler von oben: bei
  // `BYMONTHDAY=-1;UNTIL=20260120` ab dem 15. Januar gibt es kein Vorkommen,
  // und der unveraenderte 15. saehe aus wie einer. "Nicht bewegt" und "nichts
  // gefunden" sind vom Rueckgabewert her nicht zu unterscheiden, deshalb wird
  // vorher gefragt.
  // DIESELBE ZONENFRAGE WIE IN DER EXPANSION, SONST WIDERSPRECHEN SIE SICH.
  // Ein Termin mit eigener Zone kann in UTC an einem anderen Kalendertag liegen
  // als vor Ort: 31. Januar 20:00 in New York ist gespeichert als 1. Februar
  // 01:00 UTC. Die Monatsletzten-Pruefung sah dort den Ersten, fand kein
  // Vorkommen und gab `null` zurueck - der Kalender zeigte den Termin, die
  // Kachel verschwieg ihn. `expandRecurringEvents` setzt die Pruefung in genau
  // diesem Fall aus (`zonenUnsicher`); hier gilt dieselbe Ruecknahme, sonst
  // beantworten zwei Stellen dieselbe Frage verschieden.
  const wandUhr = event.tzid ? utcToWall(String(event.start_datetime ?? ''), event.tzid) : null;
  const zonenUnsicher = !!event.tzid
    && !(wandUhr && wandUhr.date === String(event.start_datetime ?? '').slice(0, 10));

  if (!hasAnyOccurrence(startKey, event.recurrence_rule, { utcDiffersFromLocal: zonenUnsicher })) return null;
  const ersterTreffer = seriesStartFor(startKey, event.recurrence_rule, { utcDiffersFromLocal: zonenUnsicher });
  let candidate = ersterTreffer >= todayKey
    ? ersterTreffer
    : nextOccurrenceAfter(ersterTreffer, event.recurrence_rule, todayKey, { seriesStart: startKey });

  let skips = 0;
  while (candidate && exceptions?.has(candidate) && skips++ < MAX_EXCEPTION_SKIPS) {
    candidate = nextOccurrenceAfter(candidate, event.recurrence_rule, candidate, { seriesStart: startKey });
  }
  // Ein Datum in der Vergangenheit ist kein Countdown, sondern ein falscher -
  // lieber nichts zeigen. Der haeufigste Weg hierher war frueher die
  // Schleifengrenze beim Aufholen (eine taegliche Serie ab 2023 gab auf);
  // seit #877 springt das Aufholen, statt zu zaehlen.
  if (!candidate || candidate < todayKey) return null;
  return candidate;
}

/**
 * Ist dieses Modul haushaltweit abgeschaltet?
 *
 * Gelesen wie der Budget-Modus nebenan (`resolveBudgetMode`) - direkt aus
 * `sync_config`, defensiv gegen fehlenden, kaputten oder nicht-Array-Wert:
 * „nichts abgeschaltet" ist die einzige sichere Auslegung eines unlesbaren
 * Werts, denn die andere Richtung würde ein Modul stumm ausblenden.
 */
function disabledModules(d) {
  const row = d.prepare("SELECT value FROM sync_config WHERE key = 'disabled_modules'").get();
  if (!row?.value) return new Set();
  try {
    const parsed = JSON.parse(row.value);
    return new Set(Array.isArray(parsed) ? parsed.filter((m) => typeof m === 'string') : []);
  } catch {
    return new Set();
  }
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
 * @returns {{items: Array<{source: 'event'|'task', id: number, title: string,
 *                  date: string, days_until: number, icon: string|null,
 *                  color: string|null, recurring: boolean}>, total: number}}
 */
export function getCountdowns(d, {
  userId = null, todayKey, hiddenModules = null, limit = DEFAULT_LIMIT,
} = {}) {
  /* EIN ABGESCHALTETES MODUL LIEFERT HIER GAR NICHTS MEHR (Review zu PR #793).
   *
   * Bis hierher fragte der Server beide Quellen ab, deckelte auf fünf und
   * überliess das Aussortieren dem Browser. Das ging bei jeder anderen Kachel
   * gut, weil dort die KACHEL einem Modul gehört und mit ihm verschwindet -
   * diese gehört zweien, und ihre blosse Existenz hängt an der gefilterten
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
  const hidden = new Set([...disabledModules(d), ...(hiddenModules ?? [])]);
  const graceDays = overdueGraceDays(d);
  const items = [
    ...(hidden.has('calendar') ? [] : eventCountdowns(d, userId, todayKey, graceDays)),
    ...(hidden.has('tasks') ? [] : taskCountdowns(d, userId, todayKey, graceDays)),
  ];

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

function eventCountdowns(d, userId, todayKey, graceDays) {
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
           COALESCE(ec.color, isub.color) AS cal_color
    FROM calendar_events e
    LEFT JOIN users u ON u.id = e.assigned_to
    LEFT JOIN external_calendars ec ON ec.id = e.calendar_ref_id
    LEFT JOIN ics_subscriptions isub ON isub.id = e.subscription_id
    WHERE e.countdown = 1
      AND ${visibilityWhere('e', 'event_assignments', 'event_id')}
  `).all(userId, userId);

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

function taskCountdowns(d, userId, todayKey, graceDays) {
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
