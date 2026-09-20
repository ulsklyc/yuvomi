import { createHash } from 'node:crypto';
import { setEventAssignments } from '../routes/calendar/helpers.js';

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

const UNASSIGNED_MAPPED_EVENTS = `
  FROM calendar_events e
  JOIN external_calendars ec ON ec.id = e.calendar_ref_id
  JOIN users u ON u.id = ec.default_assignee_user_id
  WHERE e.external_source = ec.source
    AND ${NOT_PUSHED_OUTBOUND}
    AND e.assigned_to IS NULL
    AND NOT EXISTS (SELECT 1 FROM event_assignments ea WHERE ea.event_id = e.id)
`;

const BACKFILL_BATCH_SIZE = 50;

/**
 * Die Kandidaten, wie sie JETZT sind: Termin und die Person seines Kalenders.
 * Die Route vergleicht sie mit der bestätigten Menge und reicht genau diese
 * Liste an applyDefaultAssigneesToExisting() weiter.
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
 * @param {{ eventId: number, userId: number }[]} [candidates] bestätigte Liste; Standard: die aktuelle
 * @param {{ batchSize?: number, now?: Date }} [options]
 * @returns {Promise<number>} Anzahl der zugewiesenen Termine
 */
export async function applyDefaultAssigneesToExisting(
  d,
  candidates = listBackfillCandidates(d),
  { batchSize = BACKFILL_BATCH_SIZE, now = new Date() } = {},
) {
  const nowIso = now.toISOString();
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
    WHERE entity_type = 'event' AND entity_id = ? AND created_by = ? AND remind_at > ?
  `);
  const settlePastInherited = d.prepare(`
    UPDATE reminders SET dismissed = 1
    WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
      AND assigned_from IS NOT NULL AND remind_at <= ?
  `);

  let assigned = 0;
  for (let start = 0; start < candidates.length; start += batchSize) {
    const batch = candidates.slice(start, start + batchSize);
    assigned += d.transaction(() => {
      let written = 0;
      for (const { eventId, userId } of batch) {
        const row = stillEligible.get(eventId);
        if (!row || row.userId !== userId) continue;
        setPrimary.run(userId, eventId);
        if (row.documentId || (row.authorId !== null && hasFutureTemplate.get(eventId, row.authorId, nowIso))) {
          setEventAssignments(d, eventId, [userId]);
          settlePastInherited.run(eventId, userId, nowIso);
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
 * @returns {boolean} true, wenn die Zuweisung umgestellt wurde
 */
export function reassignDefaultOnCalendarMove(
  d,
  eventId,
  { fromCalRefId = null, toCalRefId = null, toDefaultUserId = null } = {},
) {
  if (!eventId || fromCalRefId == null || toCalRefId == null) return false;
  if (Number(fromCalRefId) === Number(toCalRefId)) return false;
  if (!toDefaultUserId) return false;

  // An einem hinausgepushten Termin war schon eine Hand: seine Zuweisung ist
  // eine Aussage eines Menschen, auch wenn sie dieselbe Person nennt wie der
  // Kalender, in dem er liegt.
  const notPushedOut = d.prepare(
    `SELECT 1 FROM calendar_events e WHERE e.id = ? AND ${NOT_PUSHED_OUTBOUND}`
  ).get(eventId);
  if (!notPushedOut) return false;

  const fromDefault = d.prepare(
    'SELECT default_assignee_user_id FROM external_calendars WHERE id = ?'
  ).get(fromCalRefId)?.default_assignee_user_id ?? null;
  if (!fromDefault) return false;
  if (Number(fromDefault) === Number(toDefaultUserId)) return false;

  // GENAU die Standard-Person von A - in beiden Spalten, die eine Zuweisung
  // fuehren. `assigned_to` darf leer sein: so sah eine Zeile aus, deren Spalte
  // beim Import schon belegt war (assignDefaultToEvent schreibt sie nur, wenn
  // sie NULL ist).
  const assigned = d.prepare('SELECT user_id FROM event_assignments WHERE event_id = ?')
    .all(eventId).map((r) => Number(r.user_id));
  if (assigned.length !== 1 || assigned[0] !== Number(fromDefault)) return false;
  const primary = d.prepare('SELECT assigned_to FROM calendar_events WHERE id = ?')
    .get(eventId)?.assigned_to ?? null;
  if (primary != null && Number(primary) !== Number(fromDefault)) return false;

  // Verwaiste Referenz (Nutzer gelöscht) still ignorieren, wie in
  // assignDefaultToEvent.
  if (!d.prepare('SELECT 1 FROM users WHERE id = ?').get(toDefaultUserId)) return false;

  d.prepare('UPDATE calendar_events SET assigned_to = ? WHERE id = ?').run(toDefaultUserId, eventId);
  setEventAssignments(d, eventId, [toDefaultUserId]);
  d.prepare(`
    UPDATE reminders SET dismissed = 1
    WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
      AND assigned_from IS NOT NULL AND remind_at <= ?
  `).run(eventId, toDefaultUserId, new Date().toISOString());
  return true;
}
