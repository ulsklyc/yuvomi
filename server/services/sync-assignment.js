import { createHash } from 'node:crypto';
import { setEventAssignments } from '../routes/calendar/helpers.js';
import { visibilityWhere } from './visibility.js';

// Die Standard-Zuweisung eines Kalenders laeuft ohne Person dahinter - ueber
// den Auto-Sync, sobald jemand einen Termin im externen Client zwischen zwei
// Kalendern verschiebt, oder ueber den Backfill. Sie darf ein Anhang-Dokument
// deshalb nicht anfassen (#1358): an einem Termin fuer Zugewiesene bekommt ein
// schon eingeschraenktes Dokument die neue Person als Freigabe dazu, sonst
// aendert sich an den Dokumentrechten nichts - nichts wird `family`, enger
// oder privat, keine Freigabe faellt weg (applyDocumentAccess, `grantAssignees`).
const FOLLOW_ASSIGNMENT = Object.freeze({ grantAssigneesOnly: true });
import { remindAtCompareKey, remindAtUtcSql } from '../utils/reminder-schedule.js';

// --------------------------------------------------------
// Standard-Zuweisung für synchronisierte Termine (#459).
//
// Wenn ein Sync-Ziel (external_calendars-Zeile oder ics_subscriptions-Zeile) eine
// `default_assignee_user_id` gesetzt hat, wird sie neu importierten Terminen dieses
// Ziels zugewiesen. Bewusst nur für NEUE Termine (nicht rückwirkend), damit eine
// manuell entfernte Zuweisung beim nächsten Sync nicht wiederkehrt.
// --------------------------------------------------------

/**
 * Weist einem frisch angelegten Termin die Standard-Person zu.
 * No-op, wenn keine Person konfiguriert ist oder sie nicht (mehr) existiert.
 *
 * @param {object} d       better-sqlite3 Datenbank-Handle
 * @param {number} eventId ID des neu eingefügten Termins
 * @param {number|null} userId  Standard-zugewiesene User-ID des Sync-Ziels
 */
export function assignDefaultToEvent(d, eventId, userId) {
  if (!eventId || !userId) return;
  // Verwaiste Referenz (Nutzer gelöscht) still ignorieren.
  const exists = d.prepare('SELECT 1 FROM users WHERE id = ?').get(userId);
  if (!exists) return;

  d.prepare('UPDATE calendar_events SET assigned_to = ? WHERE id = ? AND assigned_to IS NULL')
    .run(userId, eventId);
  d.prepare('INSERT OR IGNORE INTO event_assignments (event_id, user_id) VALUES (?, ?)')
    .run(eventId, userId);
}

// --------------------------------------------------------
// Nachtragen auf bereits importierte Termine (#1154).
//
// Der Sync bleibt neu-only (Kopfkommentar). Nachgetragen wird nur auf
// ausdrücklichen Wunsch, einmalig und nur dort, wo ein Termin noch
// NIEMANDEM zugewiesen ist: eine Zuweisung von Hand gewinnt immer. Was die
// Aktion nicht unterscheiden kann, ist eine von Hand ENTFERNTE Zuweisung -
// ein solcher Termin sieht aus wie ein nie zugewiesener und wird gefüllt.
// Das sagt die Rückfrage in der Oberfläche.
//
// Geltungsbereich: jeder Kalender aller Konten (external_calendars, also
// Google/Apple/CalDAV), der eine Standard-Zuweisung trägt. ICS-Abos nicht:
// sie gehören ihrem Anleger und werden in dessen Einstellungen gepflegt,
// nicht auf der Admin-Seite, auf der die Aktion steht.
//
// „Keine Zuweisung" heißt beide Spalten leer: `assigned_to` UND keine
// event_assignments-Zeile. Eine verwaiste Standard-Person (Nutzer gelöscht)
// fällt über den JOIN auf users heraus, wie in assignDefaultToEvent.
//
// Nur HEREINGEKOMMENE Termine: die Quelle des Termins muss die des Kalenders
// sein. Ein lokal abgekoppeltes Vorkommen (retireLegacyInstances setzt
// external_source auf 'local') behält seine calendar_ref_id, gehört aber nicht
// mehr dem Kalender.
//
// Und kein HINAUSGEPUSHTER Termin - die Bedingung steht als NOT_PUSHED_OUTBOUND
// unter diesem Block, weil der Umzug (#1270) dieselbe Frage stellt.
//
// Geschrieben wird über setEventAssignments(), die eine Schreibstelle der
// Zuweisung: sie verteilt die Erinnerungen des Anlegers an die neue Person
// (#921) und gleicht die Dokumentrechte eines Anhangs an. Ein direktes INSERT
// zeigte der Person den Termin, aber weder Erinnerung noch Anhang.
// --------------------------------------------------------

// --------------------------------------------------------
// Kein HINAUSGEPUSHTER Termin: der Outbound-Sync stempelt dieselben Spalten
// (external_source, calendar_ref_id) auf einen lokal angelegten Termin, sobald er
// im Kalender liegt. Er hinterlässt aber eine Spur, die kein Import trägt -
// Google und CalDAV behalten ihr gewähltes Ziel (target_*), Apple und CalDAV
// laden unter der UID 'oikos-<id>@oikos.local' hoch. Ein importierter Termin,
// den jemand in Yuvomi in einen anderen Kalender verschoben hat, trägt ebenfalls
// ein Ziel und bleibt damit aussen vor: an ihm hat schon eine Hand gearbeitet.
//
// Die eine Luecke dieser Spur: vor Migration 47 lud der Google-Outbound JEDEN
// lokalen Termin in den einen Google-Kalender, ohne Ziel, und Migration 47 hat
// target_google_calendar_id nicht nachgetragen. Solche Termine sehen aus wie
// Importe. Google-Termine, die vor dem Einspielen von Migration 47 angelegt
// wurden, bleiben deshalb ganz aussen vor - ein alter Import wird dabei
// mitgenommen, aber uebersprungen ist die sichere Richtung. Die Tabellen-
// Umbauten danach tragen created_at unveraendert mit.
//
// EINE Bedingung, ZWEI Fragesteller: das Nachtragen (#1154) und der Umzug
// (#1270) wollen beide wissen, ob an dieser Zeile schon eine Hand war, und
// kennen dieselben Spuren. Als zweite Schreibweise driftete die Regel - der
// Umzug hatte sie erst gar nicht und stellte damit eine von Hand gesetzte
// Zuweisung um, sobald sie zufaellig die Standard-Person des Quellkalenders
// nannte (der eigene Kalender der zugewiesenen Person ist genau dieser Fall).
//
// Der Alias `e` steht im Fragment: jede einsetzende Abfrage muss
// calendar_events als `e` fuehren.
//
// Nicht dabei: Outlook. Der Push dorthin ist einseitig, es gibt keinen Inbound,
// und die Zeile bleibt dauerhaft external_source='local' ohne calendar_ref_id
// (outlook-calendar.js, Kopfkommentar) - sie kommt an keiner der beiden Stellen
// vorbei. Geht derselbe Termin ausserdem zu Google, CalDAV oder Apple, traegt
// er deren Spur und ist damit schon draussen.
// --------------------------------------------------------

const NOT_PUSHED_OUTBOUND = `
  e.target_google_calendar_id IS NULL
    AND e.target_caldav_calendar_url IS NULL
    AND COALESCE(e.external_calendar_id, '') <> ('oikos-' || e.id || '@oikos.local')
    AND NOT (e.external_source = 'google' AND e.created_at < COALESCE(
      (SELECT applied_at FROM schema_migrations WHERE version = 47), ''))
`;

// --------------------------------------------------------
// UNANGETASTET: die Zuweisung ist GENAU eine Person `who` - eine Menge mit einem
// Element in `event_assignments`, und `assigned_to` leer oder dieselbe (so sah
// eine Zeile aus, deren Spalte beim Import schon belegt war; assignDefaultToEvent
// schreibt sie nur, wenn sie NULL ist). Dazu nicht hinausgepusht.
//
// EINE Regel fuer ZWEI Stellen: der Umzug zur Laufzeit (#1270,
// reassignDefaultOnCalendarMove) und das Nachholen alter Umzuege (#1307,
// MOVED_DEFAULT_EVENTS). `who` ist ein SQL-Ausdruck - ein Parameter bei der
// einen, eine Spalte bei der anderen - und steht dreimal im Fragment. Der
// Alias `e` wie bei NOT_PUSHED_OUTBOUND.
// --------------------------------------------------------

const UNTOUCHED_DEFAULT_ASSIGNMENT = (who) => `
  ${NOT_PUSHED_OUTBOUND}
    AND (e.assigned_to IS NULL OR e.assigned_to = ${who})
    AND EXISTS (SELECT 1 FROM event_assignments ua WHERE ua.event_id = e.id AND ua.user_id = ${who})
    AND NOT EXISTS (SELECT 1 FROM event_assignments ub WHERE ub.event_id = e.id AND ub.user_id <> ${who})
`;

const UNASSIGNED_MAPPED_EVENTS = `
  FROM calendar_events e
  JOIN external_calendars ec ON ec.id = e.calendar_ref_id
  JOIN users u ON u.id = ec.default_assignee_user_id
  WHERE e.external_source = ec.source
    AND ${NOT_PUSHED_OUTBOUND}
    AND e.assigned_to IS NULL
    AND NOT EXISTS (SELECT 1 FROM event_assignments ea WHERE ea.event_id = e.id)
`;

// --------------------------------------------------------
// Alte Umzuege nachholen (#1307).
//
// Der Umzug zur Laufzeit (#1270) sieht nur einen Umzug, der WAEHREND eines Syncs
// passiert: `calendar_ref_id` wechselt von A nach B. Ein Termin, der vor diesem
// Fix umgezogen ist, liegt laengst in B und traegt noch die Standard-Person von
// A - der Wechsel kommt nie wieder, und mit ihm auch nicht die Korrektur.
//
// Dieselbe Aktion wie das Nachtragen (#1154) zeigt ihn an, aber EINZELN: die
// Vorschau listet jeden Kandidaten (Titel, Datum, Kalender, Person X -> Y), der
// Admin hakt ab, was umgestellt werden soll, und nur die abgehakten Termine
// gehen mit der Bestaetigung zurueck (listMovedCandidates, Route). Kandidat ist
// ein Termin in B, dessen Zuweisung die UNANGETASTETE Standard-Person eines
// anderen Kalenders A ist - dieselbe Regel wie beim Umzug
// (UNTOUCHED_DEFAULT_ASSIGNMENT). A ist dabei nicht bekannt, nur moeglich; deshalb:
//   - A liegt beim selben Anbieter und, bei CalDAV, im selben Konto (ueber
//     caldav_calendar_selection): nur dort kann ein Termin mit derselben
//     Identitaet umziehen. Google und Apple fuehren je ein Konto.
//   - B hat eine Standard-Person, und sie ist eine andere: wie beim Umzug nimmt
//     ein Kalender ohne Standard-Person nichts weg.
//   - ZUSAETZLICH `user_modified = 0`. Der Umzug zur Laufzeit hat den Wechsel
//     gesehen; hier fehlt dieser Beleg, und "genau die Person von A" kann auch
//     eine Hand sein, die einen Termin in B bewusst dieser Person gegeben hat.
//     Jede Bearbeitung in Yuvomi - auch die Zuweisung - setzt `user_modified`
//     an einem externen Termin (routes/calendar/crud.js, PUT), und der Inbound
//     setzt es nie zurueck. Ein so bearbeiteter Termin bleibt stehen; die
//     sichere Richtung.
//
// WARUM EINZELN: die Regel sieht einen geaenderten Kalender nicht. Stellt ein
// Admin die Standard-Person von B von X auf Y um, und X ist die Standard-Person
// eines anderen Kalenders desselben Kontos, sehen die frueher importierten
// Termine von B genau so aus wie umgezogene. Gemessen am Schema gibt es keine
// Spur, die beides trennt: `event_assignments` hat weder Herkunft noch Zeit,
// `external_calendars` merkt sich nicht, wann eine Standard-Person wechselte,
// CalDAV und iCloud ueberschreiben `external_object_url` bei jedem Inbound, und
// Google behaelt die Event-ID ueber einen Umzug. Jede pauschale Reparatur haette
// solche Termine still umgestellt. Die Unterscheidung kennt nur, wer den Termin
// kennt - deshalb entscheidet der Admin je Termin, und ohne Haken bleibt er.
//
// Ein verknuepftes Vorkommen einer Serie ist eine lokale Zeile ohne
// calendar_ref_id: es erbt die Zuweisung vom Master und zieht mit ihm um; fuehrt
// es sie selbst, war schon eine Hand daran, und es bleibt, wie es ist.
// --------------------------------------------------------

const MOVED_DEFAULT_EVENTS = `
  FROM calendar_events e
  JOIN external_calendars ec ON ec.id = e.calendar_ref_id
  JOIN users u ON u.id = ec.default_assignee_user_id
  JOIN event_assignments cur ON cur.event_id = e.id
  WHERE e.external_source = ec.source
    AND e.user_modified = 0
    AND cur.user_id <> ec.default_assignee_user_id
    AND ${UNTOUCHED_DEFAULT_ASSIGNMENT('cur.user_id')}
    AND EXISTS (
      SELECT 1 FROM external_calendars eca
      WHERE eca.source = ec.source
        AND eca.id <> ec.id
        AND eca.default_assignee_user_id = cur.user_id
        AND (ec.source <> 'caldav' OR EXISTS (
          SELECT 1 FROM caldav_calendar_selection sa
          JOIN caldav_calendar_selection sb ON sb.account_id = sa.account_id
          WHERE sa.calendar_url = eca.external_id AND sb.calendar_url = ec.external_id
        ))
    )
`;

/**
 * Stellt eine unangetastete Standard-Zuweisung auf eine andere Person um - der
 * eine Schreibweg fuer den Umzug zur Laufzeit (#1270) und das Nachholen (#1307).
 * Ueber setEventAssignments() mit FOLLOW_ASSIGNMENT (Erinnerungen; ein
 * eingeschraenkter Anhang bekommt nur die neue Person dazu, #1358); geerbte
 * Erinnerungen, deren Zeit vorbei ist, gelten als verworfen.
 *
 * @param {object} d better-sqlite3 Datenbank-Handle
 * @param {number} eventId
 * @param {number} toUserId
 * @param {string} nowKey remindAtCompareKey(jetzt)
 */
function moveDefaultAssignment(d, eventId, toUserId, nowKey) {
  d.prepare('UPDATE calendar_events SET assigned_to = ? WHERE id = ?').run(toUserId, eventId);
  setEventAssignments(d, eventId, [toUserId], FOLLOW_ASSIGNMENT);
  d.prepare(`
    UPDATE reminders SET dismissed = 1
    WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
      AND assigned_from IS NOT NULL AND ${remindAtUtcSql('remind_at')} <= ?
  `).run(eventId, toUserId, nowKey);
}

const BACKFILL_BATCH_SIZE = 50;

/**
 * Die Kandidaten des Nachtragens, wie sie JETZT sind: Termin ohne Zuweisung und
 * die Person seines Kalenders (#1154). Die Route vergleicht sie mit der
 * bestätigten Menge und reicht genau diese Liste an
 * applyDefaultAssigneesToExisting() weiter. Umgezogene Termine (#1307) stehen
 * NICHT darin, siehe listMovedCandidates().
 *
 * @param {object} d better-sqlite3 Datenbank-Handle
 * @returns {{ eventId: number, userId: number }[]}
 */
export function listBackfillCandidates(d) {
  return d.prepare(
    `SELECT e.id AS eventId, ec.default_assignee_user_id AS userId ${UNASSIGNED_MAPPED_EVENTS} ORDER BY e.id`
  ).all();
}

/**
 * Obergrenze der Einzelliste (#1307): so viele umgezogene Termine zeigt eine
 * Seite der Vorschau hoechstens, und so viele nimmt eine Bestaetigung hoechstens
 * an. EINE Zahl fuer beide Seiten - stand sie nur an der Bestaetigung, hakte die
 * Vorschau ab 5001 Kandidaten alles vor, und die Standard-Bestaetigung scheiterte
 * jedes Mal mit 400. Hinter der Grenze wird geblaettert (`after`). Ein Objekt
 * statt einer Konstante, damit ein Test die Grenze fuer DENSELBEN Aufrufpfad
 * kleiner stellen kann, ohne 5001 Termine anzulegen.
 */
export const movedCandidatesLimit = { max: 5000 };

// --------------------------------------------------------
// SICHTBARKEIT: die Einzelliste nennt Titel, Datum, Kalender und Personen - sie
// ist ein Lesepfad fuer Termine und folgt deshalb derselben Regel wie die
// Kalender-Leseroute (visibilityWhere, #474, KEIN Admin-Bypass). Ein privater
// oder nur fuer Zugewiesene sichtbarer Termin, den der Admin nicht sehen darf,
// wird weder gezeigt noch gezaehlt noch umgestellt. Das Nachtragen (#1154)
// zaehlt dagegen nur und nennt keinen Termin; es bleibt, wie es ist.
// --------------------------------------------------------

const MOVED_VISIBLE_TO_VIEWER = visibilityWhere('e', 'event_assignments', 'event_id', '@viewerId');

// Blaettern: nach (start_datetime, id) des letzten gezeigten Eintrags, in
// derselben Ordnung wie die Liste. Ein Admin, der eine ganze Seite abwaehlt,
// erreicht so trotzdem die naechste - vorher kam jedes Mal dieselbe Seite.
const AFTER_CURSOR = '(e.start_datetime > @afterStart OR (e.start_datetime = @afterStart AND e.id > @afterId))';
const UP_TO_CURSOR = '(e.start_datetime < @afterStart OR (e.start_datetime = @afterStart AND e.id <= @afterId))';

/**
 * Der Blaetter-Zeiger als Text: `<id>:<start_datetime>`. Die ID steht vorn, weil
 * der Beginn selbst Doppelpunkte traegt.
 * @param {{ eventId: number, startDatetime: string }} row
 */
export function movedCursorOf(row) {
  return `${row.eventId}:${row.startDatetime}`;
}

/**
 * @param {string} raw
 * @returns {{ afterId: number, afterStart: string } | null} null = ungueltig
 */
export function parseMovedCursor(raw) {
  if (typeof raw !== 'string') return null;
  const cut = raw.indexOf(':');
  if (cut <= 0) return null;
  const afterId = Number(raw.slice(0, cut));
  const afterStart = raw.slice(cut + 1);
  if (!Number.isInteger(afterId) || afterId <= 0 || !afterStart || afterStart.length > 64) return null;
  return { afterId, afterStart };
}

/**
 * Wie viele umgezogene Termine der betrachtenden Person es JETZT gibt -
 * insgesamt und vor dem Zeiger (fuer "Termine N bis M von X").
 * @param {object} d better-sqlite3 Datenbank-Handle
 * @param {{ viewerId: number, after?: { afterId: number, afterStart: string } | null }} options
 * @returns {{ total: number, before: number }}
 */
export function countMovedCandidates(d, { viewerId, after = null }) {
  return d.prepare(`
    SELECT COUNT(*) AS total,
           ${after ? `COALESCE(SUM(CASE WHEN ${UP_TO_CURSOR} THEN 1 ELSE 0 END), 0)` : '0'} AS before
    ${MOVED_DEFAULT_EVENTS}
      AND ${MOVED_VISIBLE_TO_VIEWER}
  `).get({ viewerId, ...(after ?? {}) });
}

const MOVED_COLUMNS = `
  e.id AS eventId, ec.default_assignee_user_id AS userId, cur.user_id AS fromUserId,
  e.title AS title, e.start_datetime AS startDatetime, e.all_day AS allDay,
  ec.name AS calendarName, u.display_name AS toName,
  (SELECT fu.display_name FROM users fu WHERE fu.id = cur.user_id) AS fromName
`;

/**
 * Die vor #1306 umgezogenen Termine (#1307), wie sie JETZT sind - eine Seite der
 * Vorschau, in der der Admin jeden einzeln abhakt. Kein Teil der pauschalen
 * Menge aus listBackfillCandidates(): umgestellt wird nur, was die Bestaetigung
 * einzeln nennt (siehe MOVED_DEFAULT_EVENTS, "WARUM EINZELN").
 *
 * @param {object} d better-sqlite3 Datenbank-Handle
 * @param {{ viewerId: number, limit: number,
 *   after?: { afterId: number, afterStart: string } | null }} options
 *   nur fuer `viewerId` sichtbare Termine, hoechstens `limit`, nach dem Zeiger
 * @returns {{ eventId: number, userId: number, fromUserId: number, title: string,
 *   startDatetime: string, allDay: number, calendarName: string, fromName: string,
 *   toName: string }[]} nach Beginn sortiert, bei gleichem Beginn nach ID
 */
export function listMovedCandidates(d, { viewerId, limit, after = null }) {
  return d.prepare(`
    SELECT ${MOVED_COLUMNS}
    ${MOVED_DEFAULT_EVENTS}
      AND ${MOVED_VISIBLE_TO_VIEWER}
      ${after ? `AND ${AFTER_CURSOR}` : ''}
    ORDER BY e.start_datetime, e.id
    LIMIT @limit
  `).all({ viewerId, limit, ...(after ?? {}) });
}

/**
 * EIN umgezogener Termin, wie er JETZT ist - die Punktabfrage, mit der die
 * Bestaetigung jeden abgehakten Eintrag prueft, statt die ganze Liste zu laden.
 * Dieselbe Regel und dieselbe Sichtbarkeit wie die Vorschau.
 *
 * @param {object} d better-sqlite3 Datenbank-Handle
 * @param {number} eventId
 * @param {{ viewerId: number }} options
 * @returns {{ eventId: number, userId: number, fromUserId: number } | undefined}
 */
export function getMovedCandidate(d, eventId, { viewerId }) {
  return d.prepare(`
    SELECT e.id AS eventId, ec.default_assignee_user_id AS userId, cur.user_id AS fromUserId
    ${MOVED_DEFAULT_EVENTS}
      AND e.id = @eventId
      AND ${MOVED_VISIBLE_TO_VIEWER}
  `).get({ eventId, viewerId });
}

/**
 * Fingerabdruck der Kandidatenliste: welche Termine an welche Person gehen.
 *
 * Die Anzahl allein bestätigt zu wenig (#1171). Zwischen Zählung und Bestätigung
 * kann sich die Menge bei gleicher Größe ändern - ein Termin wird von Hand
 * zugewiesen, während ein neuer Import seinen Platz einnimmt, oder ein anderer
 * Admin stellt die Standard-Person eines Kalenders um. Die Zahl stimmt dann
 * noch, der Lauf träfe aber andere Termine oder eine andere Person, als die
 * Rückfrage gezählt hat. Die Liste kommt nach Termin-ID sortiert, der
 * Fingerabdruck ist also für dieselbe Menge immer derselbe.
 *
 * @param {{ eventId: number, userId: number }[]} candidates
 * @returns {string} SHA-256, hex
 */
export function backfillCandidatesToken(candidates) {
  const hash = createHash('sha256');
  for (const { eventId, userId } of candidates) hash.update(`${eventId}:${userId};`);
  return hash.digest('hex');
}

/**
 * Weist jedem noch unzugewiesenen Termin aus einem Kalender mit
 * Standard-Zuweisung diese Person zu. Idempotent: ein zweiter Lauf findet
 * nichts mehr.
 *
 * NUR DIE BESTÄTIGTE LISTE. Zwischen den Happen laufen andere Anfragen, auch ein
 * Sync oder eine Zuweisung von Hand. Die Liste ist deshalb die bei der
 * Bestätigung gezählte, und jede Zeile wird beim Schreiben erneut geprüft: ist
 * der Termin inzwischen zugewiesen oder zeigt sein Kalender auf eine andere
 * Person, bleibt er stehen; ein inzwischen neu hinzugekommener Kandidat wird
 * nicht angefasst. Die Rückgabe zählt nur, was tatsächlich zugewiesen wurde.
 *
 * IN HAPPEN, NICHT IN EINER TRANSAKTION. Ein Haushalt mit Jahren an
 * iCloud-Historie hat Tausende Termine; gemessen blockierten 5000 Termine den
 * Event-Loop in einer Transaktion gut zwoelf Sekunden. Jeder Happen ist eine
 * eigene Transaktion (50 Termine, gemessen unter 0,2 s), dazwischen kommen
 * andere Anfragen dran. Jeder Happen nimmt die naechsten Eintraege der
 * bestaetigten Liste; bricht der Lauf ab, bleiben die uebrigen Termine
 * unzugewiesen, und eine neue Zaehlung findet sie wieder.
 *
 * DER TEURE WEG NUR, WO ER ETWAS BEWIRKT. setEventAssignments() verteilt
 * Erinnerungen und gleicht Anhangrechte an; die allermeisten importierten
 * Termine haben keins von beidem, fuer sie reichen zwei Schreibzugriffe.
 *
 * KEINE VERGANGENEN ERINNERUNGEN. Der Scheduler verschickt jede nicht
 * verworfene Erinnerung mit remind_at <= jetzt - eine nachgetragene Zuweisung
 * an einen Termin von 2024 schickte der neuen Person sofort die alte Meldung.
 * Geerbte Erinnerungen, deren Zeit vorbei ist, gelten deshalb als verworfen;
 * kuenftige kommen wie gewohnt. Ein Termin, dessen Anleger nur vergangene
 * Erinnerungen hat, nimmt den teuren Weg gar nicht erst.
 *
 * @param {object} d better-sqlite3 Datenbank-Handle
 * @param {{ eventId: number, userId: number, fromUserId?: number }[]} [candidates]
 *   bestätigte Liste; Standard: die aktuelle des Nachtragens. Ein Eintrag mit
 *   `fromUserId` ist ein einzeln abgehakter umgezogener Termin (#1307): er wird
 *   nur umgestellt, wenn er beim Schreiben noch genau von dieser Person auf
 *   diese Person ginge.
 * @param {{ batchSize?: number, now?: Date, viewerId?: number|null }} [options]
 * @returns {Promise<number>} Anzahl der zugewiesenen Termine
 */
export async function applyDefaultAssigneesToExisting(
  d,
  candidates = listBackfillCandidates(d),
  { batchSize = BACKFILL_BATCH_SIZE, now = new Date(), viewerId = null } = {},
) {
  // Derselbe Vergleich wie beim Zustellen (#1364): `remind_at` als Zeitpunkt.
  const nowKey = remindAtCompareKey(now);
  const stillEligible = d.prepare(`
    SELECT ec.default_assignee_user_id AS userId,
           e.created_by AS authorId, e.attachment_document_id AS documentId
    ${UNASSIGNED_MAPPED_EVENTS}
      AND e.id = ?
  `);
  const setPrimary = d.prepare(
    'UPDATE calendar_events SET assigned_to = ? WHERE id = ? AND assigned_to IS NULL'
  );
  const addAssignment = d.prepare(
    'INSERT OR IGNORE INTO event_assignments (event_id, user_id) VALUES (?, ?)'
  );
  const hasFutureTemplate = d.prepare(`
    SELECT 1 FROM reminders
    WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
      AND ${remindAtUtcSql('remind_at')} > ?
  `);
  const settlePastInherited = d.prepare(`
    UPDATE reminders SET dismissed = 1
    WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
      AND assigned_from IS NOT NULL AND ${remindAtUtcSql('remind_at')} <= ?
  `);

  // Mit `viewerId` (die Route) gilt beim Schreiben auch die Sichtbarkeit wie in
  // der Vorschau; ohne sie nur die Regel.
  const stillMoved = d.prepare(`
    SELECT ec.default_assignee_user_id AS userId, cur.user_id AS fromUserId
    ${MOVED_DEFAULT_EVENTS}
      AND e.id = @eventId
      ${viewerId == null ? '' : `AND ${MOVED_VISIBLE_TO_VIEWER}`}
  `);

  let assigned = 0;
  for (let start = 0; start < candidates.length; start += batchSize) {
    const batch = candidates.slice(start, start + batchSize);
    assigned += d.transaction(() => {
      let written = 0;
      for (const { eventId, userId, fromUserId } of batch) {
        if (fromUserId != null) {
          const moved = stillMoved.get(viewerId == null ? { eventId } : { eventId, viewerId });
          if (!moved || moved.userId !== userId || moved.fromUserId !== fromUserId) continue;
          moveDefaultAssignment(d, eventId, userId, nowKey);
          written += 1;
          continue;
        }
        const row = stillEligible.get(eventId);
        if (!row || row.userId !== userId) continue;
        setPrimary.run(userId, eventId);
        if (row.documentId || (row.authorId !== null && hasFutureTemplate.get(eventId, row.authorId, nowKey))) {
          setEventAssignments(d, eventId, [userId], FOLLOW_ASSIGNMENT);
          settlePastInherited.run(eventId, userId, nowKey);
        } else {
          addAssignment.run(eventId, userId);
        }
        written += 1;
      }
      return written;
    })();
    if (start + batchSize < candidates.length) await new Promise((resolve) => setImmediate(resolve));
  }
  return assigned;
}

// --------------------------------------------------------
// Umzug zwischen zwei Kalendern desselben Kontos (#1270).
//
// Verschiebt jemand einen Termin im fremden Kalender von A nach B, kommt er mit
// UNVERAENDERTER Identitaet zurueck - CalDAV und Apple ueber die iCal-UID,
// Google ueber die Event-ID. Der Inbound findet die Zeile also wieder und
// aktualisiert sie, `calendar_ref_id` wandert mit. Die Zuweisung nicht: sie
// wurde beim Import einmal gesetzt und blieb seither bei der Standard-Person von
// A. Weil die Anzeigefarbe eines Termins ohne eigene Farbe der PRIMAEREN
// zugewiesenen Person gehoert (`resolveEventColor`, #891), stand der Termin
// danach im neuen Kalender und trug die Farbe des alten.
//
// UMGESTELLT WIRD NUR EINE ZUWEISUNG, DIE NIEMAND ANGEFASST HAT. Das ist die
// ganze Bedingung: die Zuweisung muss GENAU die Standard-Person von A sein -
// eine Menge mit einem Element, denn ein Termin kann mehrere Personen tragen
// (`event_assignments`), und `assigned_to` nennt darunter die primaere. Alles
// andere ist eine Aussage eines Menschen und bleibt stehen:
//   - mehrere Personen, oder eine andere als die Standard-Person von A: von Hand
//     gesetzt.
//   - keine Person: von Hand ENTFERNT oder nie zugewiesen. Beides sieht gleich
//     aus, und der Kopfkommentar dieses Moduls entscheidet das seit #459 in
//     dieselbe Richtung - der Sync traegt nicht nach.
//   - A hatte gar keine Standard-Person: dann kann die vorhandene Zuweisung
//     nicht von ihr stammen.
//
// UND NUR, WENN B EINE STANDARD-PERSON HAT. Ein Kalender ohne Standard-Person
// weist nichts zu (`assignDefaultToEvent` ist dann ein No-op); er darf dann auch
// nichts WEGnehmen. Sonst waere der Umzug in einen Kalender ohne Standard-Person
// eine Loeschung der Zuweisung - eine Handlung, die niemand angeordnet hat, und
// mit ihr fielen die geerbten Erinnerungen der Person weg.
//
// UND KEIN HINAUSGEPUSHTER TERMIN. Die Bedingung oben - "GENAU die
// Standard-Person von A" - kann eine vom Sync gesetzte Zuweisung nicht von einer
// HANDGESETZTEN unterscheiden, wenn beide dieselbe Person nennen. Genau das ist
// der eigene Termin, den jemand Anna zuweist und in Annas eigenen Kalender
// pusht: der Push stempelt `calendar_ref_id` darauf (caldav-outbound.js,
// caldav-sync.js, apple-calendar.js, google-calendar.js), und beim naechsten
// Umzug sah der Helfer "Zuweisung == Standard-Person von A" und stellte die
// Handarbeit auf die Person von B um. Gefragt wird deshalb dasselbe wie beim
// Nachtragen (#1154), aus DERSELBEN Quelle: NOT_PUSHED_OUTBOUND.
//
// Eine Altzeile ohne `calendar_ref_id` bleibt aussen vor: woher sie kam, ist
// nicht bekannt, und ohne das Vorher gibt es kein "unangetastet".
//
// GESCHRIEBEN WIRD UEBER setEventAssignments() - die eine Schreibstelle der
// Zuweisung. Sie nimmt der alten Person ihre geerbten Erinnerungen ab, legt sie
// der neuen hin (#921) und gleicht die Dokumentrechte eines Anhangs an. Ein
// eigenes UPDATE auf `event_assignments` zeigte der neuen Person den Termin,
// aber weder Erinnerung noch Anhang - und liesse der alten ihre Erinnerungen.
//
// KEINE VERGANGENEN ERINNERUNGEN, aus demselben Grund wie beim Nachtragen
// (#1154): der Scheduler verschickt jede nicht verworfene Erinnerung mit
// remind_at <= jetzt. Ein Termin von 2024, den jemand heute in einen anderen
// Kalender schiebt, haette der neuen Person sofort die alte Meldung geschickt.
// Geerbte Erinnerungen, deren Zeit vorbei ist, gelten deshalb als verworfen;
// kuenftige kommen wie gewohnt.
// --------------------------------------------------------

/**
 * Stellt die Standard-Zuweisung eines umgezogenen Sync-Termins auf die
 * Standard-Person des neuen Kalenders um. No-op, wenn die Zuweisung nicht
 * genau die unangetastete Standard-Person des alten Kalenders ist oder der
 * Termin hinausgepusht wurde (NOT_PUSHED_OUTBOUND).
 *
 * @param {object} d better-sqlite3 Datenbank-Handle
 * @param {number} eventId ID des umgezogenen Termins
 * @param {object} move
 * @param {number|null} move.fromCalRefId external_calendars.id VOR dem Umzug
 * @param {number|null} move.toCalRefId   external_calendars.id NACH dem Umzug
 * @param {number|null} move.toDefaultUserId Standard-Person des neuen Kalenders
 *        (die Aufrufer loesen sie einmal je Kalender auf, nicht je Termin)
 * @param {Date} [move.now] Bezugszeitpunkt fuer "vergangen"; ersetzbar fuer
 *        Tests, wie bei `applyDefaultAssigneesToExisting()`
 * @returns {boolean} true, wenn die Zuweisung umgestellt wurde
 */
export function reassignDefaultOnCalendarMove(
  d,
  eventId,
  { fromCalRefId = null, toCalRefId = null, toDefaultUserId = null, now = new Date() } = {},
) {
  if (!eventId || fromCalRefId == null || toCalRefId == null) return false;
  if (Number(fromCalRefId) === Number(toCalRefId)) return false;
  if (!toDefaultUserId) return false;

  const fromDefault = d.prepare(
    'SELECT default_assignee_user_id FROM external_calendars WHERE id = ?'
  ).get(fromCalRefId)?.default_assignee_user_id ?? null;
  if (!fromDefault) return false;
  if (Number(fromDefault) === Number(toDefaultUserId)) return false;

  // GENAU die unangetastete Standard-Person von A, und nicht hinausgepusht: an
  // einem hinausgepushten Termin war schon eine Hand, auch wenn er dieselbe
  // Person nennt wie der Kalender, in dem er liegt. Dieselbe Regel wie beim
  // Nachholen alter Umzuege (#1307).
  const untouched = d.prepare(
    `SELECT 1 FROM calendar_events e WHERE e.id = @eventId AND ${UNTOUCHED_DEFAULT_ASSIGNMENT('@fromUser')}`
  ).get({ eventId, fromUser: Number(fromDefault) });
  if (!untouched) return false;

  // Verwaiste Referenz (Nutzer gelöscht) still ignorieren, wie in
  // assignDefaultToEvent.
  if (!d.prepare('SELECT 1 FROM users WHERE id = ?').get(toDefaultUserId)) return false;

  moveDefaultAssignment(d, eventId, toDefaultUserId, remindAtCompareKey(now));
  return true;
}
