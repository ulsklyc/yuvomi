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
import { validateRequest } from '../../api/validate-request.ts';
import * as outlookCalendar from '../../services/outlook-calendar.js';
import { requireAdmin } from '../../auth.js';
import { remoteFailure } from '../../utils/http.js';

const log = createLogger('Calendar');
const router = express.Router();

/**
 * An account in the path that does not exist (#2810, group 10b, decision 11):
 * asked before the service, whose plain Error for it answered 500.
 * @param {{ status: (code: number) => { json: (body: unknown) => unknown } }} res
 * @param {number} accountId
 * @returns {boolean} true when the answer is sent
 */
function refuseUnknownAccount(res, accountId) {
  if (outlookCalendar.accountExists(accountId)) return false;
  res.status(404).json({ error: 'Outlook account not found.', code: 404, reason: 'outlook_account_not_found' });
  return true;
}

/**
 * The answer of a route that may ask Microsoft Graph, once its own named cases
 * are handled (Phase 0 section H): missing configuration and an expired sign-in
 * as own cases, a refusal of Graph as its class (502, `reason` + `detail`).
 * Never the text of Graph or of the token endpoint - it names request paths and
 * account details. Anything local (a database error, which remoteFailure()
 * does not take for a refusal) goes on to the central error handler (#2810,
 * group 10b).
 */
function sendOutlookFailure(res, err) {
  if (err?.code === 'outlook_not_configured') {
    log.error('', err);
    return res.status(503).json({ error: 'Outlook is not configured on this server.', code: 503, reason: 'outlook_not_configured' });
  }
  if (err instanceof outlookCalendar.ReauthRequiredError) {
    log.error('', err);
    return res.status(409).json({ error: 'Outlook sign-in expired - reconnect required.', code: 409, reason: 'outlook_reauth_required' });
  }
  const failure = remoteFailure(err);
  if (!failure) throw err;
  log.error('', err);
  return res.status(502).json({ error: 'Microsoft refused the request or could not be reached.', code: 502, ...failure });
}

/**
 * The account id in the path: the schema lets plain decimal digits through only
 * (`idParam()`, #2810).
 * @param {any} req
 * @param {string} [name]
 */
function pathId(req, name = 'id') {
  return Number(req.params[name]);
}

/**
 * GET /api/v1/calendar/outlook/auth
 * Admin only. Leitet zum Microsoft-Consent-Screen weiter (persönliche Konten).
 */
router.get('/outlook/auth', requireAdmin, refuseWhileRestoring, validateRequest(), (req, res) => {
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
router.get('/outlook/callback', refuseWhileRestoring, validateRequest(), async (req, res) => {
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
router.get('/outlook/accounts', requireAdmin, validateRequest(), (req, res) => {
  try {
    // Laut wie Google (/google/calendars): fehlende Konfiguration wirft und
    // landet als Error im Log, statt still eine leere Liste zu liefern.
    outlookCalendar.assertConfigured();
    res.json({ data: outlookCalendar.listAccounts() });
  } catch (err) {
    if (err?.code === 'outlook_not_configured') {
      log.error('', err);
      return res.status(503).json({ error: 'Outlook is not configured on this server.', code: 503, reason: 'outlook_not_configured' });
    }
    throw err;
  }
});

/**
 * PUT /api/v1/calendar/outlook/accounts/:id
 * Admin only. Partial-Update: Name, Auto-Sync-Zielkalender, Konto-Owner.
 * Body: { name?, autoSyncCalendarId?: string|null, ownerUserId?: number|null }
 * Auto-Sync ist aktiv, sobald Zielkalender UND Owner gesetzt sind; null
 * deaktiviert das jeweilige Feld.
 */
router.put('/outlook/accounts/:id', requireAdmin, validateRequest(), (req, res) => {
  try {
    const accountId = pathId(req);
    const { name, autoSyncCalendarId, ownerUserId } = req.body;
    if (refuseUnknownAccount(res, accountId)) return;
    const result = outlookCalendar.updateAccount(accountId, { name, autoSyncCalendarId, ownerUserId });
    res.json({ data: result });
  } catch (err) {
    if (err.code === 'not_household_member') {
      return res.status(400).json({ error: err.message, code: 400, reason: 'calendar_assignee_not_member' });
    }
    if (err.code === 'outlook_auto_sync_overrides') {
      log.error('Outlook account update failed:', err);
      return res.status(409).json({
        error: err.message,
        code: 409,
        conflict: err.code,
        reason: 'outlook_auto_sync_overrides',
        linked_override_count: err.linkedOverrideCount,
      });
    }
    throw err;
  }
});

/**
 * DELETE /api/v1/calendar/outlook/accounts/:id
 * Admin only. Konto trennen und löschen. Bereits gepushte Events bleiben
 * in Outlook stehen; lokale Events verlieren ihr Outlook-Ziel.
 */
router.delete('/outlook/accounts/:id', requireAdmin, validateRequest(), (req, res) => {
  const accountId = pathId(req);
  if (refuseUnknownAccount(res, accountId)) return;
  const result = outlookCalendar.deleteAccount(accountId);
  res.json({ data: result });
});

/**
 * GET /api/v1/calendar/outlook/accounts/:id/calendars
 * Admin only. Kalenderliste eines Kontos (aus der DB; ?refresh=true lädt neu
 * von Graph). Mit `?refresh=true` schreibt sie Token und Auswahl nach dem Warten
 * auf Microsoft - deshalb `refuseWhileRestoring` (#1551).
 */
router.get('/outlook/accounts/:id/calendars', requireAdmin, refuseWhileRestoring, validateRequest(), async (req, res) => {
  try {
    outlookCalendar.assertConfigured();
    const accountId = pathId(req);
    const refresh = req.query.refresh === 'true';
    if (refuseUnknownAccount(res, accountId)) return;
    const calendars = await outlookCalendar.listCalendars(accountId, { refresh });
    res.json({ data: calendars });
  } catch (err) {
    sendOutlookFailure(res, err);
  }
});

/**
 * PATCH /api/v1/calendar/outlook/accounts/:id/calendars
 * Admin only. Kalender als Push-Ziel aktivieren/deaktivieren.
 * Body: { calendarId: string, enabled: boolean }
 */
router.patch('/outlook/accounts/:id/calendars', requireAdmin, validateRequest(), (req, res) => {
  try {
    const accountId = pathId(req);
    const { calendarId, enabled } = req.body;
    // Text (Pflicht) und `enabled` als Boolean prueft das Schema
    // (OutlookCalendarSelectionInput); eine leere Kennung kennt es nicht.
    if (!calendarId) {
      return res.status(400).json({ error: 'calendarId is missing or invalid.', code: 400 });
    }
    if (refuseUnknownAccount(res, accountId)) return;
    const result = outlookCalendar.setCalendarEnabled(accountId, calendarId, enabled);
    res.json({ data: result });
  } catch (err) {
    if (err.code === 'outlook_auto_sync_overrides') {
      log.error('Outlook calendar selection update failed:', err);
      return res.status(409).json({
        error: err.message,
        code: 409,
        conflict: err.code,
        reason: 'outlook_auto_sync_overrides',
        linked_override_count: err.linkedOverrideCount,
      });
    }
    throw err;
  }
});

/**
 * POST /api/v1/calendar/outlook/sync
 * Admin only. Manueller Push-Trigger.
 * Response: { data: { success, syncedAccounts, pushed, updated, deleted } }
 */
router.post('/outlook/sync', requireAdmin, validateRequest(), async (req, res) => {
  try {
    outlookCalendar.assertConfigured();
    const result = await outlookCalendar.sync();
    res.json({ data: result });
  } catch (err) {
    sendOutlookFailure(res, err);
  }
});

/**
 * GET /api/v1/calendar/outlook/status
 * Response: { data: { configured, accounts, totalAccounts } }
 */
router.get('/outlook/status', validateRequest(), (req, res) => {
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
});

export default router;
