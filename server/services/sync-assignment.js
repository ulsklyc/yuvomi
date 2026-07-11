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
