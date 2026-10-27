/**
 * Modul: Kalender (Calendar) - Sync-Ziele fuer das Event-Modal (Issue #618)
 *
 * Zweck: Liefert die Auswahlliste des "Sync-Ziel"-Dropdowns an ALLE angemeldeten
 *        Nutzer. Vorher hing das Dropdown an den Verwaltungsrouten
 *        (/google/calendars, /caldav/accounts), die requireAdmin tragen - fuer
 *        Familienmitglieder kam 403 zurueck und als einzige Option blieb
 *        "Lokal speichern", obwohl POST/PUT /calendar das Ziel laengst von jedem
 *        Nutzer entgegennimmt.
 *
 * Ausgeliefert wird nur, was das Dropdown braucht: Anzeigename und Zielkennung.
 * Keine Zugangsdaten, keine CalDAV-Server-URLs, keine Benutzernamen - die
 * Kontenverwaltung bleibt unveraendert admin-only.
 *
 * Abhaengigkeiten: express, server/services/google-calendar.js,
 *                  server/services/caldav-sync.js
 */

import express from 'express';
import { mayWriteModule } from '../../permissions.js';
import { refuseWhileRestoring } from '../../middleware/restore-gate.js';

import { createLogger } from '../../logger.js';
import * as googleCalendar from '../../services/google-calendar.js';
import * as caldavSync from '../../services/caldav-sync.js';
import * as outlookCalendar from '../../services/outlook-calendar.js';

const log = createLogger('Calendar');
const router = express.Router();

/** Die eine Standard-Person eines Kalenders, sonst null (Altform, #1897). */
function soleAssignee(ids) {
  return Array.isArray(ids) && ids.length === 1 ? ids[0] : null;
}

/**
 * Google-Ziele: nur aktivierte und beschreibbare Kalender - dieselbe Auswahl,
 * die das Frontend bisher clientseitig aus /google/calendars gefiltert hat.
 * Ohne Verbindung wird gar nicht erst gegen die Google-API gerufen.
 *
 * `defaultAssigneeUserIds` sind die Standard-Personen des Kalenders (#459,
 * #1897). Das Formular liest sie RUECKWAERTS (#1060): ein neuer Termin, der
 * genau diesen Personen zugewiesen ist, bekommt diesen Kalender als Ziel.
 * `defaultAssigneeUserId` traegt fuer Aufrufer der Altform die Person nur, wenn
 * es genau eine ist: ein aelterer Client liest es als "der Kalender genau dieser
 * Person", und ein gemeinsamer Kalender ist das fuer keine von beiden.
 * @returns {Promise<Array<{id: string, summary: string, defaultAssigneeUserIds: number[], defaultAssigneeUserId: number|null}>>}
 */
async function listGoogleTargets() {
  if (!googleCalendar.getStatus().connected) return [];
  const calendars = await googleCalendar.listCalendars();
  return calendars
    .filter((cal) => cal.enabled && cal.writable)
    .map((cal) => ({
      id: cal.id,
      summary: cal.summary || cal.id,
      defaultAssigneeUserIds: cal.default_assignee_user_ids ?? [],
      defaultAssigneeUserId: soleAssignee(cal.default_assignee_user_ids),
    }));
}

/**
 * CalDAV-Ziele: alle aktivierten und beschreibbaren Kalender je Konto, aus der
 * DB (kein Netzzugriff).
 *
 * Die Standard-Zuweisung haengt an der Kalender-URL, nicht am Konto
 * (`external_calendars.external_id`). Fuehren zwei Konten dieselbe URL, tragen
 * beide Ziele dieselben Personen - das Formular waehlt dann keines von selbst.
 * @returns {Promise<Array<{accountId: number, accountName: string, calendarUrl: string, calendarName: string, defaultAssigneeUserIds: number[], defaultAssigneeUserId: number|null}>>}
 */
async function listCaldavTargets() {
  const targets = [];
  for (const account of caldavSync.listAccounts()) {
    // Ein Konto mit defekter Auswahl darf die uebrigen nicht mitreissen.
    try {
      const calendars = await caldavSync.getCalendars(account.id);
      // Nur Kalender, die neue Termine annehmen (#1840): ein nur lesbar
      // geteilter wiese jeden Upload ab. Ohne Angabe des Servers wie bisher.
      for (const cal of calendars.filter((c) => c.enabled && c.writable !== false)) {
        targets.push({
          accountId: account.id,
          accountName: account.name,
          calendarUrl: cal.calendarUrl,
          calendarName: cal.calendarName || cal.calendarUrl,
          defaultAssigneeUserIds: cal.default_assignee_user_ids ?? [],
          defaultAssigneeUserId: soleAssignee(cal.default_assignee_user_ids),
        });
      }
    } catch (err) {
      log.warn(`Sync targets: skipping CalDAV account ${account.id}:`, err);
    }
  }
  return targets;
}

/**
 * Outlook-Ziele: alle aktivierten UND beschreibbaren Kalender je Konto, aus der
 * DB (kein Netzzugriff). Konten im Reauth-Zustand bleiben wählbar - der Push
 * holt nach dem Reconnect nach.
 * @returns {Array<{accountId: number, accountName: string, calendarId: string, calendarName: string}>}
 */
function listOutlookTargets() {
  const targets = [];
  for (const account of outlookCalendar.listAccounts()) {
    for (const cal of outlookCalendar.listCalendarSelection(account.id)) {
      if (!cal.enabled || !cal.canEdit) continue;
      targets.push({
        accountId: account.id,
        accountName: account.name,
        calendarId: cal.calendarId,
        calendarName: cal.calendarName || cal.calendarId,
      });
    }
  }
  return targets;
}

/**
 * GET /api/v1/calendar/sync-targets
 * Fuer alle angemeldeten Nutzer. Response:
 * { data: { google: [{ id, summary, defaultAssigneeUserIds, defaultAssigneeUserId }],
 *           caldav: [{ accountId, accountName, calendarUrl, calendarName, defaultAssigneeUserIds, defaultAssigneeUserId }],
 *           outlook: [{ accountId, accountName, calendarId, calendarName }] } }
 *
 * Jede Quelle faellt einzeln auf eine leere Liste zurueck: ein abgelaufenes
 * Google-Token darf die CalDAV-Ziele nicht verschlucken (und umgekehrt).
 *
 * Die Google-Liste kann das Token erneuern, und der `tokens`-Listener speichert
 * es nach dem Warten auf Google - deshalb `refuseWhileRestoring` (#1551).
 */
router.get('/sync-targets', refuseWhileRestoring, async (req, res) => {
  try {
    // Dieselbe Erwaegung wie bei /tasks/sync-targets: die Liste fuellt das
    // Ziel-Feld des Termindialogs und nennt dabei die angebundenen Konten mit
    // ihren Kalender-URLs. Wer nicht schreiben darf, braucht sie nicht.
    if (!mayWriteModule(req, 'calendar')) {
      return res.status(403).json({ error: 'Write access to the calendar is required.', code: 403, reason: 'cross_module_access' });
    }
    const [google, caldav] = await Promise.all([
      listGoogleTargets().catch((err) => {
        log.warn('Sync targets: Google list failed:', err);
        return [];
      }),
      listCaldavTargets().catch((err) => {
        log.warn('Sync targets: CalDAV list failed:', err);
        return [];
      }),
    ]);
    let outlook = [];
    try {
      outlook = listOutlookTargets();
    } catch (err) {
      log.warn('Sync targets: Outlook list failed:', err);
    }
    res.json({ data: { google, caldav, outlook } });
  } catch (err) {
    log.error('Sync target list failed:', err);
    res.status(500).json({ error: 'Failed to list sync targets.', code: 500 });
  }
});

export default router;
