/**
 * Modul: Kalender (Calendar) - Apple-CalDAV-Sync (Legacy Einzelkonto)
 */

import { createLogger } from '../../logger.js';
import { integrationDetailsVisible } from '../../scopes.js';
import express from 'express';
import { validateRequest } from '../../api/validate-request.ts';
import * as appleCalendar from '../../services/apple-calendar.js';
import { requireAdmin } from '../../auth.js';
import { secret } from '../../api/formats.ts';
import { remoteFailure } from '../../utils/http.js';

const log = createLogger('Calendar');
const router = express.Router();

/**
 * The answer once the route's own named cases are handled (Phase 0 section H):
 * a refusal of iCloud or the network as its class (502, `reason` + `detail`
 * such as `HTTP 401`, which the settings page shows the admin). Never the text
 * of iCloud or tsdav. Anything local (a database error, which remoteFailure()
 * does not take for a refusal) goes on to the central error handler (#2810,
 * group 10b).
 */
function sendAppleFailure(res, err) {
  const failure = remoteFailure(err);
  if (!failure) throw err;
  log.error('', err);
  return res.status(502).json({ error: 'iCloud refused the request or could not be reached.', code: 502, ...failure });
}

// --------------------------------------------------------
// Apple Calendar Sync-Routen
// --------------------------------------------------------

/**
 * GET /api/v1/calendar/apple/status
 * Response: { configured, lastSync }
 */
router.get('/apple/status', validateRequest(), (req, res) => {
  const status = appleCalendar.getStatus();
  // DER FEHLERTEXT DES LETZTEN LAUFS IST VERWALTUNGSDATEN. Er kommt vom
  // Gegenueber und traegt regelmaessig dessen Adresse oder eine Kontokennung
  // in sich - `calendar:read` reicht bis hierher, weil der Pfad-Guard am
  // ersten Segment urteilt. Dieselbe Regel wie bei /caldav/status und
  // /outlook/status, an den Scopes gemessen und nicht am Kontotyp.
  const { lastError, lastErrorAt, ...rest } = status;
  res.json(integrationDetailsVisible(req) ? status : rest);
});

/**
 * POST /api/v1/calendar/apple/sync
 * Manueller Sync-Trigger.
 * Response: { ok: true, lastSync: string }
 */
router.post('/apple/sync', requireAdmin, validateRequest(), async (req, res) => {
  try {
    await appleCalendar.sync();
    const { lastSync } = appleCalendar.getStatus();
    res.json({ ok: true, lastSync });
  } catch (err) {
    if (err.code === 'apple_not_configured') {
      log.error('', err);
      return res.status(409).json({ error: 'No Apple calendar is connected.', code: 409, reason: 'apple_not_configured' });
    }
    sendAppleFailure(res, err);
  }
});

/**
 * POST /api/v1/calendar/apple/connect
 * Apple-CalDAV-Credentials speichern und Verbindung testen.
 * Body: { url, username, password }
 * Response: { ok: true, calendarCount: number }
 */
router.post('/apple/connect', requireAdmin, validateRequest(), async (req, res) => {
  const { url, username, password } = req.body;
  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({ error: 'url must be a valid HTTP(S) URL.', code: 400, reason: 'apple_url_invalid' });
  }
  if (!username || typeof username !== 'string' || username.length > 254) {
    return res.status(400).json({ error: 'username is missing or invalid.', code: 400 });
  }
  if (!password || typeof password !== 'string' || password.length < 1) {
    return res.status(400).json({ error: 'password is missing.', code: 400 });
  }
  // Dieselbe Grenze wie CardDAV und CalDAV, ungetrimmt (#2575).
  const vPassword = secret(password, 'password');
  if (vPassword.error) return res.status(400).json({ error: vPassword.error, code: 400 });

  try {
    // Zuerst temporär setzen, damit testConnection() sie findet
    appleCalendar.saveCredentials(url.trim(), username.trim(), password);
    const result = await appleCalendar.testConnection();
    res.json({ ok: true, calendarCount: result.calendarCount });
  } catch (err) {
    // Bei Fehler: gespeicherte Credentials wieder löschen - auch vor dem Weg
    // zum zentralen Fehlerhandler.
    appleCalendar.clearCredentials();
    // Verbunden, aber ohne Kalender, ist der eine Fall, den die App kennt
    // (#1909); sonst ist es eine Absage von iCloud, deren Klasse die Seite dem
    // Admin zeigt.
    if (err.code === 'apple_no_calendars') {
      log.error('', err);
      return res.status(400).json({ error: err.message.replace('[Apple] ', ''), code: 400, reason: 'apple_no_calendars' });
    }
    sendAppleFailure(res, err);
  }
});

/**
 * DELETE /api/v1/calendar/apple/disconnect
 * Apple-CalDAV-Credentials löschen.
 * Query: ?deleteEvents=true nimmt die gespiegelten Termine mit (#820).
 * Response: 204 - bleibt leer, obwohl die Google-Gegenstelle die Zahl der
 * gelöschten Termine meldet: der Statuscode ist seit v2.7.1 zugesagte Oberfläche,
 * und ein 204 → 200 wäre für Bestandsclients ein Bruch ohne Gegenwert. Wer die
 * Zahl braucht, nimmt DELETE /apple/mirrored-events.
 */
router.delete('/apple/disconnect', requireAdmin, validateRequest(), (req, res) => {
  appleCalendar.clearCredentials({
    deleteEvents: req.query.deleteEvents === 'true',
  });
  res.status(204).end();
});

/**
 * DELETE /api/v1/calendar/apple/mirrored-events
 * Admin only. Entfernt die lokal gespiegelten Apple-Termine, ohne die Verbindung
 * anzufassen (#820). Der iCloud-Kalender bleibt unberührt.
 * Response: { data: { removed: number } }
 */
router.delete('/apple/mirrored-events', requireAdmin, validateRequest(), (req, res) => {
  res.json({ data: { removed: appleCalendar.clearMirroredEvents() } });
});

export default router;
