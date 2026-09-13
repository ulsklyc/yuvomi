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
// Und kein HINAUSGEPUSHTER Termin: der Outbound-Sync stempelt dieselben Spalten
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
// Geschrieben wird über setEventAssignments(), die eine Schreibstelle der
// Zuweisung: sie verteilt die Erinnerungen des Anlegers an die neue Person
// (#921) und gleicht die Dokumentrechte eines Anhangs an. Ein direktes INSERT
// zeigte der Person den Termin, aber weder Erinnerung noch Anhang.
// --------------------------------------------------------

const UNASSIGNED_MAPPED_EVENTS = `
  FROM calendar_events e
  JOIN external_calendars ec ON ec.id = e.calendar_ref_id
  JOIN users u ON u.id = ec.default_assignee_user_id
  WHERE e.external_source = ec.source
    AND e.target_google_calendar_id IS NULL
    AND e.target_caldav_calendar_url IS NULL
    AND COALESCE(e.external_calendar_id, '') <> ('oikos-' || e.id || '@oikos.local')
    AND NOT (e.external_source = 'google' AND e.created_at < COALESCE(
      (SELECT applied_at FROM schema_migrations WHERE version = 47), ''))
    AND e.assigned_to IS NULL
    AND NOT EXISTS (SELECT 1 FROM event_assignments ea WHERE ea.event_id = e.id)
`;

/**
 * Zählt die Termine, die applyDefaultAssigneesToExisting() füllen würde.
 *
 * @param {object} d better-sqlite3 Datenbank-Handle
 * @returns {number}
 */
export function countUnassignedMappedEvents(d) {
  return d.prepare(`SELECT COUNT(*) AS count ${UNASSIGNED_MAPPED_EVENTS}`).get().count;
}

const BACKFILL_BATCH_SIZE = 50;

/**
 * Die Kandidaten, wie sie JETZT sind: Termin und die Person seines Kalenders.
 * Die Route vergleicht ihre Anzahl mit der bestätigten Zahl und reicht genau
 * diese Liste an applyDefaultAssigneesToExisting() weiter.
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
 * andere Anfragen dran. Ein zugewiesener
 * Termin faellt aus der Kandidatenmenge, also holt jeder Happen einfach die
 * naechsten - bricht der Lauf ab, setzt ein zweiter dort fort.
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
