/**
 * Modul: Kalender (Calendar) - Outlook-Push (Microsoft Graph, One-Way)
 * OAuth-Connect, Konten, Kalenderauswahl, manueller Sync, Status.
 *
 * Konten entstehen ausschließlich über den OAuth-Callback (kein POST /accounts).
 * Alle Verwaltungsrouten sind admin-only (Parität caldav_accounts); Familien-
 * mitglieder erhalten die wählbaren Ziele über die gemeinsame Lese-Route
 * GET /calendar/sync-targets (#618).
 */

import { refuseWhileRestoring } from '../../middleware/restore-gate.js';
import { createLogger } from '../../logger.js';
import { integrationDetailsVisible } from '../../scopes.js';
import express from 'express';
import * as outlookCalendar from '../../services/outlook-calendar.js';
import { requireAdmin } from '../../auth.js';
import { remoteFailure } from '../../utils/http.js';

const log = createLogger('Calendar');
const router = express.Router();

/**
 * The answer of a route that may ask Microsoft Graph, once its own named cases
 * are handled (Phase 0 section H): missing configuration and an expired sign-in
 * as own cases, a refusal of Graph as its class (502, `reason` + `detail`),
 * anything local as a fixed 500. Never the text of Graph or of the token
 * endpoint - it names request paths and account details.
 */
function sendOutlookFailure(res, err, sentence) {
  if (err?.code === 'outlook_not_configured') {
    return res.status(503).json({ error: 'Outlook is not configured on this server.', code: 503, reason: 'outlook_not_configured' });
  }
  if (err instanceof outlookCalendar.ReauthRequiredError) {
    return res.status(409).json({ error: 'Outlook sign-in expired - reconnect required.', code: 409, reason: 'outlook_reauth_required' });
  }
  const failure = remoteFailure(err);
  if (failure) return res.status(502).json({ error: 'Microsoft refused the request or could not be reached.', code: 502, ...failure });
  return res.status(500).json({ error: sentence, code: 500 });
}

/**
 * GET /api/v1/calendar/outlook/auth
 * Admin only. Leitet zum Microsoft-Consent-Screen weiter (persönliche Konten).
 */
router.get('/outlook/auth', requireAdmin, refuseWhileRestoring, (req, res) => {
  try {
    const url = outlookCalendar.getAuthUrl(req.session);
    res.redirect(url);
  } catch (err) {
    log.error('', err);
    if (err?.code === 'outlook_not_configured') {
      return res.status(503).json({ error: 'Outlook is not configured on this server.', code: 503, reason: 'outlook_not_configured' });
    }
    res.status(503).json({ error: 'Outlook sign-in could not be started.', code: 503 });
  }
});

/**
 * GET /api/v1/calendar/outlook/callback
 * OAuth-Callback von Microsoft. Tauscht Code gegen Tokens, lädt die Kalender
 * und stößt einen initialen Push an.
 * Query: ?code=...&state=...
 */
router.get('/outlook/callback', refuseWhileRestoring, async (req, res) => {
  try {
    const { code, error, state } = req.query;
    if (error) return res.redirect('/settings?sync_error=outlook');
    if (!code)  return res.status(400).json({ error: 'No authorization code received.', code: 400 });

    // OAuth CSRF-Schutz: state-Parameter validieren
    if (!state || !req.session.outlookOAuthState || state !== req.session.outlookOAuthState) {
      log.error('Outlook OAuth state mismatch');
      return res.redirect('/settings?sync_error=outlook');
    }
    delete req.session.outlookOAuthState;

    await outlookCalendar.handleCallback(code);
    await outlookCalendar.sync();

    res.redirect('/settings?sync_ok=outlook');
  } catch (err) {
    log.error('', err);
    res.redirect('/settings?sync_error=outlook');
  }
});

/**
 * GET /api/v1/calendar/outlook/accounts
 * Admin only (Kontoverwaltung in den Einstellungen; der Termin-Dialog liest
 * über /calendar/sync-targets).
 * Response: { data: [{ id, name, email, needsReauth, lastSync, lastError,
 *                      autoSyncCalendarId, ownerUserId }] }
 */
router.get('/outlook/accounts', requireAdmin, (req, res) => {
  try {
    // Laut wie Google (/google/calendars): fehlende Konfiguration wirft und
    // landet als Error im Log, statt still eine leere Liste zu liefern.
    outlookCalendar.assertConfigured();
    res.json({ data: outlookCalendar.listAccounts() });
  } catch (err) {
    log.error('', err);
    if (err?.code === 'outlook_not_configured') {
      return res.status(503).json({ error: 'Outlook is not configured on this server.', code: 503, reason: 'outlook_not_configured' });
    }
    res.status(500).json({ error: 'Failed to list Outlook accounts.', code: 500 });
  }
});

/**
 * PUT /api/v1/calendar/outlook/accounts/:id
 * Admin only. Partial-Update: Name, Auto-Sync-Zielkalender, Konto-Owner.
 * Body: { name?, autoSyncCalendarId?: string|null, ownerUserId?: number|null }
 * Auto-Sync ist aktiv, sobald Zielkalender UND Owner gesetzt sind; null
 * deaktiviert das jeweilige Feld.
 */
router.put('/outlook/accounts/:id', requireAdmin, (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const { name, autoSyncCalendarId, ownerUserId } = req.body;
    const result = outlookCalendar.updateAccount(accountId, { name, autoSyncCalendarId, ownerUserId });
    res.json({ data: result });
  } catch (err) {
    if (err.code === 'not_household_member') {
      return res.status(400).json({ error: err.message, code: 400, reason: 'calendar_assignee_not_member' });
    }
    log.error('Outlook account update failed:', err);
    if (err.code === 'outlook_auto_sync_overrides') {
      return res.status(409).json({
        error: err.message,
        code: 409,
        conflict: err.code,
        reason: 'outlook_auto_sync_overrides',
        linked_override_count: err.linkedOverrideCount,
      });
    }
    res.status(500).json({ error: 'Failed to update Outlook account.', code: 500 });
  }
});

/**
 * DELETE /api/v1/calendar/outlook/accounts/:id
 * Admin only. Konto trennen und löschen. Bereits gepushte Events bleiben
 * in Outlook stehen; lokale Events verlieren ihr Outlook-Ziel.
 */
router.delete('/outlook/accounts/:id', requireAdmin, (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const result = outlookCalendar.deleteAccount(accountId);
    res.json({ data: result });
  } catch (err) {
    log.error('Outlook account deletion failed:', err);
    res.status(500).json({ error: 'Failed to delete Outlook account.', code: 500 });
  }
});

/**
 * GET /api/v1/calendar/outlook/accounts/:id/calendars
 * Admin only. Kalenderliste eines Kontos (aus der DB; ?refresh=true lädt neu
 * von Graph). Mit `?refresh=true` schreibt sie Token und Auswahl nach dem Warten
 * auf Microsoft - deshalb `refuseWhileRestoring` (#1551).
 */
router.get('/outlook/accounts/:id/calendars', requireAdmin, refuseWhileRestoring, async (req, res) => {
  try {
    outlookCalendar.assertConfigured();
    const accountId = parseInt(req.params.id, 10);
    const refresh = req.query.refresh === 'true';
    const calendars = await outlookCalendar.listCalendars(accountId, { refresh });
    res.json({ data: calendars });
  } catch (err) {
    log.error('', err);
    sendOutlookFailure(res, err, 'Failed to fetch calendars.');
  }
});

/**
 * PATCH /api/v1/calendar/outlook/accounts/:id/calendars
 * Admin only. Kalender als Push-Ziel aktivieren/deaktivieren.
 * Body: { calendarId: string, enabled: boolean }
 */
router.patch('/outlook/accounts/:id/calendars', requireAdmin, (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const { calendarId, enabled } = req.body;
    if (!calendarId || typeof calendarId !== 'string') {
      return res.status(400).json({ error: 'calendarId is missing or invalid.', code: 400 });
    }
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean.', code: 400 });
    }
    const result = outlookCalendar.setCalendarEnabled(accountId, calendarId, enabled);
    res.json({ data: result });
  } catch (err) {
    log.error('Outlook calendar selection update failed:', err);
    if (err.code === 'outlook_auto_sync_overrides') {
      return res.status(409).json({
        error: err.message,
        code: 409,
        conflict: err.code,
        reason: 'outlook_auto_sync_overrides',
        linked_override_count: err.linkedOverrideCount,
      });
    }
    res.status(500).json({ error: 'Failed to update calendar selection.', code: 500 });
  }
});

/**
 * POST /api/v1/calendar/outlook/sync
 * Admin only. Manueller Push-Trigger.
 * Response: { data: { success, syncedAccounts, pushed, updated, deleted } }
 */
router.post('/outlook/sync', requireAdmin, async (req, res) => {
  try {
    outlookCalendar.assertConfigured();
    const result = await outlookCalendar.sync();
    res.json({ data: result });
  } catch (err) {
    log.error('', err);
    sendOutlookFailure(res, err, 'Outlook sync failed.');
  }
});

/**
 * GET /api/v1/calendar/outlook/status
 * Response: { data: { configured, accounts, totalAccounts } }
 */
router.get('/outlook/status', (req, res) => {
  try {
    const status = outlookCalendar.getStatus();
    // Kontomailadresse und letzter Fehlertext sind Verwaltungsdaten - dieselbe
    // Erwaegung wie bei /caldav/status daneben, dieselbe Regel aus scopes.js.
    const data = integrationDetailsVisible(req)
      ? status
      : {
        ...status,
        accounts: (status.accounts || []).map(({ email, lastError, ...rest }) => rest),
      };
    res.json({ data });
  } catch (err) {
    log.error('Outlook status failed:', err);
    res.status(500).json({ error: 'Failed to get Outlook status.', code: 500 });
  }
});

export default router;
