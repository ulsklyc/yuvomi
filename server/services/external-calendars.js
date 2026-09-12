// --------------------------------------------------------
// Kalender-Metadaten eines Providers in external_calendars.
//
// Geteilt vom CalDAV-Sync (Inbound und Upload) und vom CalDAV-Outbound: der
// Umzug eines Termins muss dieselbe Zeile finden bzw. anlegen, die der Inbound
// für den Zielkalender schreibt, sonst zeigt calendar_ref_id bis zum nächsten
// Lauf auf eine andere Zeile als die, zu der der Termin danach gehört.
// Der Outbound darf dafür caldav-sync.js nicht importieren - das wäre ein Zyklus.
// --------------------------------------------------------

import * as db from '../db.js';
import { decodeHtmlEntities } from '../utils/html-entities.js';

/**
 * Legt die Kalenderzeile an oder aktualisiert Name und Farbe.
 * @returns {number} external_calendars.id
 */
export function upsertExternalCalendar(source, externalId, name, color) {
  // Provider-Namen können HTML-entity-encoded sein - zu Klartext normalisieren,
  // sonst escaped die UI doppelt (z. B. literales "&amp;").
  const row = db.get().prepare(`
    INSERT INTO external_calendars (source, external_id, name, color)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(source, external_id) DO UPDATE SET
      name  = excluded.name,
      color = excluded.color
    RETURNING id
  `).get(source, externalId, decodeHtmlEntities(name), color);
  return row.id;
}
