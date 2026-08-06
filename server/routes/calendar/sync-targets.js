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

import { createLogger } from '../../logger.js';
import * as googleCalendar from '../../services/google-calendar.js';
import * as caldavSync from '../../services/caldav-sync.js';
import * as outlookCalendar from '../../services/outlook-calendar.js';

const log = createLogger('Calendar');
const router = express.Router();

/**
 * Google-Ziele: nur aktivierte und beschreibbare Kalender - dieselbe Auswahl,
 * die das Frontend bisher clientseitig aus /google/calendars gefiltert hat.
 * Ohne Verbindung wird gar nicht erst gegen die Google-API gerufen.
 * @returns {Promise<Array<{id: string, summary: string}>>}
 */
async function listGoogleTargets() {
  if (!googleCalendar.getStatus().connected) return [];
  const calendars = await googleCalendar.listCalendars();
  return calendars
    .filter((cal) => cal.enabled && cal.writable)
    .map((cal) => ({ id: cal.id, summary: cal.summary || cal.id }));
}

/**
 * CalDAV-Ziele: alle aktivierten Kalender je Konto, aus der DB (kein Netzzugriff).
 * @returns {Promise<Array<{accountId: number, accountName: string, calendarUrl: string, calendarName: string}>>}
 */
async function listCaldavTargets() {
  const targets = [];
  for (const account of caldavSync.listAccounts()) {
    // Ein Konto mit defekter Auswahl darf die uebrigen nicht mitreissen.
    try {
      const calendars = await caldavSync.getCalendars(account.id);
      for (const cal of calendars.filter((c) => c.enabled)) {
        targets.push({
          accountId: account.id,
          accountName: account.name,
          calendarUrl: cal.calendarUrl,
          calendarName: cal.calendarName || cal.calendarUrl,
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
 * { data: { google: [{ id, summary }],
 *           caldav: [{ accountId, accountName, calendarUrl, calendarName }],
 *           outlook: [{ accountId, accountName, calendarId, calendarName }] } }
 *
 * Jede Quelle faellt einzeln auf eine leere Liste zurueck: ein abgelaufenes
 * Google-Token darf die CalDAV-Ziele nicht verschlucken (und umgekehrt).
 */
router.get('/sync-targets', async (req, res) => {
  try {
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
