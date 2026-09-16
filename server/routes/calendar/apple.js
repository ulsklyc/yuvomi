/**
 * Modul: Kalender (Calendar) - Apple-CalDAV-Sync (Legacy Einzelkonto)
 */

import { createLogger } from '../../logger.js';
import { integrationDetailsVisible } from '../../scopes.js';
import express from 'express';
import * as appleCalendar from '../../services/apple-calendar.js';
import { requireAdmin } from '../../auth.js';

const log = createLogger('Calendar');
const router = express.Router();

// --------------------------------------------------------
// Apple Calendar Sync-Routen
// --------------------------------------------------------

/**
 * GET /api/v1/calendar/apple/status
 * Response: { configured, lastSync }
 */
router.get('/apple/status', (req, res) => {
  try {
    const status = appleCalendar.getStatus();
    // DER FEHLERTEXT DES LETZTEN LAUFS IST VERWALTUNGSDATEN. Er kommt vom
    // Gegenueber und traegt regelmaessig dessen Adresse oder eine Kontokennung
    // in sich - `calendar:read` reicht bis hierher, weil der Pfad-Guard am
    // ersten Segment urteilt. Dieselbe Regel wie bei /caldav/status und
    // /outlook/status, an den Scopes gemessen und nicht am Kontotyp.
    const { lastError, lastErrorAt, ...rest } = status;
    res.json(integrationDetailsVisible(req) ? status : rest);
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * POST /api/v1/calendar/apple/sync
 * Manueller Sync-Trigger.
 * Response: { ok: true, lastSync: string }
 */
router.post('/apple/sync', requireAdmin, async (req, res) => {
  try {
    await appleCalendar.sync();
    const { lastSync } = appleCalendar.getStatus();
    res.json({ ok: true, lastSync });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: err.message, code: 500 });
  }
});

/**
 * POST /api/v1/calendar/apple/connect
 * Apple-CalDAV-Credentials speichern und Verbindung testen.
 * Body: { url, username, password }
 * Response: { ok: true, calendarCount: number }
 */
router.post('/apple/connect', requireAdmin, async (req, res) => {
  const { url, username, password } = req.body;
  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({ error: 'url muss eine gültige HTTP(S)-URL sein.', code: 400 });
  }
  if (!username || typeof username !== 'string' || username.length > 254) {
    return res.status(400).json({ error: 'username fehlt oder ungültig.', code: 400 });
  }
  if (!password || typeof password !== 'string' || password.length < 1) {
    return res.status(400).json({ error: 'password fehlt.', code: 400 });
  }

  try {
    // Zuerst temporär setzen, damit testConnection() sie findet
    appleCalendar.saveCredentials(url.trim(), username.trim(), password);
    const result = await appleCalendar.testConnection();
    res.json({ ok: true, calendarCount: result.calendarCount });
  } catch (err) {
    // Bei Fehler: gespeicherte Credentials wieder löschen
    appleCalendar.clearCredentials();
    log.error('', err);
    res.status(400).json({ error: err.message.replace('[Apple] ', ''), code: 400 });
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
router.delete('/apple/disconnect', requireAdmin, (req, res) => {
  try {
    appleCalendar.clearCredentials({
      deleteEvents: req.query.deleteEvents === 'true',
    });
    res.status(204).end();
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * DELETE /api/v1/calendar/apple/mirrored-events
 * Admin only. Entfernt die lokal gespiegelten Apple-Termine, ohne die Verbindung
 * anzufassen (#820). Der iCloud-Kalender bleibt unberührt.
 * Response: { data: { removed: number } }
 */
router.delete('/apple/mirrored-events', requireAdmin, (req, res) => {
  try {
    res.json({ data: { removed: appleCalendar.clearMirroredEvents() } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

export default router;
