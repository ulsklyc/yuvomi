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

/**
 * Weist jedem noch unzugewiesenen Termin aus einem Kalender mit
 * Standard-Zuweisung diese Person zu. Idempotent: ein zweiter Lauf findet
 * nichts mehr.
 *
 * @param {object} d better-sqlite3 Datenbank-Handle
 * @returns {number} Anzahl der zugewiesenen Termine
 */
export function applyDefaultAssigneesToExisting(d) {
  return d.transaction(() => {
    const rows = d.prepare(
      `SELECT e.id AS eventId, ec.default_assignee_user_id AS userId ${UNASSIGNED_MAPPED_EVENTS}`
    ).all();
    const setPrimary = d.prepare(
      'UPDATE calendar_events SET assigned_to = ? WHERE id = ? AND assigned_to IS NULL'
    );
    for (const { eventId, userId } of rows) {
      setPrimary.run(userId, eventId);
      setEventAssignments(d, eventId, [userId]);
    }
    return rows.length;
  })();
}
