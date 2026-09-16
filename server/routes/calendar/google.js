/**
 * Modul: Kalender (Calendar) - Google-Sync + Standard-Zuweisung
 * OAuth, Sync, Kalenderauswahl, Nur-lesen, external-calendars (#459).
 */

import { createLogger } from '../../logger.js';
import { integrationDetailsVisible } from '../../scopes.js';
import express from 'express';
import * as db from '../../db.js';
import * as googleCalendar from '../../services/google-calendar.js';
import { requireAdmin } from '../../auth.js';
import { newNonMembers, nonMemberMessage } from '../../services/household-members.js';
import {
  applyDefaultAssigneesToExisting,
  backfillCandidatesToken,
  listBackfillCandidates,
} from '../../services/sync-assignment.js';

const log = createLogger('Calendar');
const router = express.Router();

// --------------------------------------------------------
// Google Calendar Sync-Routen
// Alle vor /:id registriert, um Konflikte zu vermeiden.
// --------------------------------------------------------

/**
 * GET /api/v1/calendar/google/auth
 * Admin only. Leitet zum Google OAuth-Consent-Screen weiter.
 */
router.get('/google/auth', requireAdmin, (req, res) => {
  try {
    const url = googleCalendar.getAuthUrl(req.session);
    if (!url) return res.status(503).json({ error: 'Google nicht konfiguriert.', code: 503 });
    res.redirect(url);
  } catch (err) {
    log.error('', err);
    res.status(503).json({ error: err.message, code: 503 });
  }
});

/**
 * GET /api/v1/calendar/google/callback
 * OAuth-Callback von Google. Tauscht Code gegen Tokens und startet initialen Sync.
 * Query: ?code=...
 */
router.get('/google/callback', async (req, res) => {
  try {
    const { code, error, state } = req.query;
    if (error) return res.redirect('/settings?sync_error=google');
    if (!code)  return res.status(400).json({ error: 'Kein Code erhalten.', code: 400 });

    // OAuth CSRF-Schutz: state-Parameter validieren
    if (!state || !req.session.googleOAuthState || state !== req.session.googleOAuthState) {
      log.error('OAuth state mismatch');
      return res.redirect('/settings?sync_error=google');
    }
    delete req.session.googleOAuthState;

    await googleCalendar.handleCallback(code);
    await googleCalendar.sync();

    res.redirect('/settings?sync_ok=google');
  } catch (err) {
    log.error('', err);
    res.redirect('/settings?sync_error=google');
  }
});

/**
 * POST /api/v1/calendar/google/sync
 * Manueller Sync-Trigger.
 * Response: { ok: true, lastSync: string }
 */
router.post('/google/sync', requireAdmin, async (req, res) => {
  try {
    await googleCalendar.sync();
    const { lastSync } = googleCalendar.getStatus();
    res.json({ ok: true, lastSync });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: err.message, code: 500 });
  }
});

/**
 * GET /api/v1/calendar/google/status
 * Response: { configured, connected, lastSync }
 */
router.get('/google/status', (req, res) => {
  try {
    const status = googleCalendar.getStatus();
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
 * GET /api/v1/calendar/google/calendars
 * Admin only. Listet die verfügbaren Google-Kalender des verbundenen Accounts.
 * Response: { data: [{ id, summary, primary, backgroundColor, selected }] }
 */
router.get('/google/calendars', requireAdmin, async (req, res) => {
  try {
    const data = await googleCalendar.listCalendars();
    res.json({ data });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: err.message, code: 500 });
  }
});

/**
 * PATCH /api/v1/calendar/google/calendars
 * Admin only. Aktiviert/deaktiviert einen Google-Kalender und startet einen Sync.
 * Body: { calendarId: string, enabled: boolean }
 * Response: { ok: true, lastSync: string }
 */
router.patch('/google/calendars', requireAdmin, async (req, res) => {
  const { calendarId, enabled } = req.body;
  if (!calendarId || typeof calendarId !== 'string' || calendarId.trim().length === 0) {
    return res.status(400).json({ error: 'calendarId fehlt oder ist ungültig.', code: 400 });
  }
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled muss ein Boolean sein.', code: 400 });
  }
  try {
    googleCalendar.setCalendarEnabled(calendarId, enabled);
    await googleCalendar.sync();
    const { lastSync } = googleCalendar.getStatus();
    res.json({ ok: true, lastSync });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: err.message, code: 500 });
  }
});

/**
 * Der Anzeigename eines noch nicht synchronisierten Kalenders aus der
 * Auswahlliste seines Providers - die Vorbedingung dafür, seine
 * external_calendars-Zeile vorab anzulegen (siehe PATCH unten). Gleichzeitig die
 * Schranke: Nur ein Kalender, den der verbundene Account tatsächlich anbietet,
 * kann hier eine Zeile bekommen. Apple hat keine eigene Auswahlliste, dort
 * entsteht die Zeile weiterhin ausschließlich beim Sync.
 */
function knownCalendarName(source, externalId) {
  if (source === 'caldav') {
    return db.get().prepare(
      'SELECT calendar_name AS name FROM caldav_calendar_selection WHERE calendar_url = ? LIMIT 1'
    ).get(externalId)?.name ?? null;
  }
  if (source === 'google') {
    return db.get().prepare(
      'SELECT name FROM google_calendar_selection WHERE calendar_id = ?'
    ).get(externalId)?.name ?? null;
  }
  return null;
}

/**
 * PATCH /api/v1/calendar/external-calendars
 * Admin only. Setzt die Standard-Zuweisung eines Kalenders (#459).
 * Provider-übergreifend (Google/Apple/CalDAV) über die geteilte external_calendars-Tabelle,
 * adressiert per (source, external_id).
 *
 * Die Zeile entsteht nötigenfalls hier, nicht erst beim ersten Sync: Vorher war
 * die Standard-Zuweisung genau so lange nicht setzbar, wie sie etwas bewirkt
 * hätte. Wer einen Kalender aktivierte, bekam den ersten Schwung Termine ohne
 * Zuweisung herein und durfte sie von Hand nachtragen (#730). Der Sync
 * aktualisiert beim Anlegen nur Name und Farbe (ON CONFLICT DO UPDATE), die
 * Zuweisung bleibt also stehen.
 *
 * Body: { source: 'google'|'apple'|'caldav', external_id: string, default_assignee_user_id: number|null }
 * Response: { data: { source, external_id, default_assignee_user_id } }
 */
router.patch('/external-calendars', requireAdmin, (req, res) => {
  try {
    const { source, external_id } = req.body;
    if (!['google', 'apple', 'caldav'].includes(source)) {
      return res.status(400).json({ error: 'source muss google, apple oder caldav sein.', code: 400 });
    }
    if (typeof external_id !== 'string' || external_id.trim().length === 0) {
      return res.status(400).json({ error: 'external_id fehlt oder ist ungültig.', code: 400 });
    }
    const raw = req.body.default_assignee_user_id;
    const assignee = (raw === null || raw === undefined || raw === '') ? null : Number(raw);
    if (assignee !== null && !Number.isInteger(assignee)) {
      return res.status(400).json({ error: 'default_assignee_user_id muss eine Zahl oder null sein.', code: 400 });
    }
    if (assignee !== null && !db.get().prepare('SELECT 1 FROM users WHERE id = ?').get(assignee)) {
      return res.status(400).json({ error: 'Unbekannte Nutzer-ID.', code: 400 });
    }
    // Neu nur Haushaltsmitglieder (#1207); die gespeicherte Zuweisung bleibt gueltig.
    if (assignee !== null) {
      const stored = db.get().prepare('SELECT default_assignee_user_id AS a FROM external_calendars WHERE source = ? AND external_id = ?').get(source, external_id)?.a;
      const strangers = newNonMembers([assignee], { stored: stored == null ? [] : [stored] });
      if (strangers.length) return res.status(400).json({ error: nonMemberMessage(strangers), code: 400 });
    }

    const result = db.get().prepare(
      'UPDATE external_calendars SET default_assignee_user_id = ? WHERE source = ? AND external_id = ?'
    ).run(assignee, source, external_id);

    if (result.changes === 0) {
      const name = knownCalendarName(source, external_id);
      if (!name) {
        return res.status(404).json({ error: 'Kalender noch nicht synchronisiert.', code: 404 });
      }
      // Farbe bleibt offen: Sie gehört dem Provider, und der nächste Sync trägt
      // sie zusammen mit dem endgültigen Namen nach.
      db.get().prepare(`
        INSERT INTO external_calendars (source, external_id, name, color, default_assignee_user_id)
        VALUES (?, ?, ?, NULL, ?)
      `).run(source, external_id, name, assignee);
    }
    res.json({ data: { source, external_id, default_assignee_user_id: assignee } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * GET /api/v1/calendar/external-calendars/default-assignee-backfill
 * Admin only. Zählt, wie viele bereits importierte Termine das Nachtragen der
 * Standard-Zuweisung füllen würde (#1154) - die Zahl steht in der Rückfrage.
 * Das Token ist der Fingerabdruck genau dieser Menge (#1171) und geht mit der
 * Bestätigung zurück.
 * Response: { data: { count, token } }
 */
router.get('/external-calendars/default-assignee-backfill', requireAdmin, (req, res) => {
  try {
    const candidates = listBackfillCandidates(db.get());
    res.json({ data: { count: candidates.length, token: backfillCandidatesToken(candidates) } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * POST /api/v1/calendar/external-calendars/default-assignee-backfill
 * Admin only. Wendet die Standard-Zuweisung jedes Kalenders aller Konten auf
 * seine schon importierten Termine an, die noch niemandem zugewiesen sind
 * (#1154). Eine vorhandene Zuweisung bleibt unangetastet.
 *
 * Die Rueckfrage hat eine Menge genannt, und nur diese Menge ist bestaetigt:
 * hat sie sich seither geaendert (jemand hat Zuweisungen entfernt, eine
 * Zuordnung umgestellt), antwortet die Route mit 409 statt mehr oder andere
 * Termine zu fuellen. Die Zahl allein faengt nur eine Aenderung der GROESSE;
 * das Token aus der Zaehlung faengt auch den Tausch bei gleicher Groesse
 * (#1171). Ohne Token bleibt es beim Zahlenvergleich, damit ein API-Client, der
 * die Route vor dem Token angebunden hat, nicht bricht. Die Aktion ist nur
 * Termin fuer Termin zuruecknehmbar.
 * Body: { expected_count: number, expected_token?: string }
 * Response: { data: { assigned } } | 409 { data: { count, token } }
 */
router.post('/external-calendars/default-assignee-backfill', requireAdmin, async (req, res) => {
  try {
    const expected = req.body?.expected_count;
    if (!Number.isInteger(expected) || expected < 0) {
      return res.status(400).json({ error: 'expected_count fehlt oder ist ungültig.', code: 400 });
    }
    const expectedToken = req.body?.expected_token;
    if (expectedToken !== undefined && expectedToken !== null
      && (typeof expectedToken !== 'string' || !/^[0-9a-f]{64}$/.test(expectedToken))) {
      return res.status(400).json({ error: 'expected_token ist ungültig.', code: 400 });
    }
    // Gezählt und festgehalten im selben synchronen Schritt: genau diese Liste
    // ist bestätigt, und nur sie wird abgearbeitet - auch wenn zwischen den
    // Happen neue Kandidaten dazukommen.
    const candidates = listBackfillCandidates(db.get());
    const token = backfillCandidatesToken(candidates);
    if (candidates.length !== expected || (expectedToken && expectedToken !== token)) {
      return res.status(409).json({
        error: 'Die Termine haben sich seit der Zählung geändert.', code: 409, data: { count: candidates.length, token },
      });
    }
    res.json({ data: { assigned: await applyDefaultAssigneesToExisting(db.get(), candidates) } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * DELETE /api/v1/calendar/google/disconnect
 * Admin only. Tokens löschen und Verbindung trennen.
 * Query: ?deleteEvents=true nimmt die gespiegelten Termine mit (#820).
 * Response: { ok: true, removed: number }
 */
router.delete('/google/disconnect', requireAdmin, (req, res) => {
  try {
    const { removed } = googleCalendar.disconnect({
      deleteEvents: req.query.deleteEvents === 'true',
    });
    res.json({ ok: true, removed });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * DELETE /api/v1/calendar/google/mirrored-events
 * Admin only. Entfernt die lokal gespiegelten Google-Termine, ohne die Verbindung
 * anzufassen (#820). Der Weg für alle, die schon getrennt haben: dort ist der
 * Rückstand sonst nur noch von Hand und Termin für Termin zu räumen.
 *
 * Der Google-Kalender bleibt unberührt - geräumt wird die lokale Kopie.
 * Response: { data: { removed: number } }
 */
router.delete('/google/mirrored-events', requireAdmin, (req, res) => {
  try {
    res.json({ data: { removed: googleCalendar.clearMirroredEvents() } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * PUT /api/v1/calendar/google/readonly
 * Admin only. Aktiviert/deaktiviert den Nur-lesen-Modus.
 * Body: { readonly: boolean }
 * Response: { data: { readonly: boolean } }
 */
router.put('/google/readonly', requireAdmin, (req, res) => {
  const { readonly } = req.body;
  if (typeof readonly !== 'boolean') {
    return res.status(400).json({ error: 'readonly muss ein Boolean sein.', code: 400 });
  }
  try {
    googleCalendar.setReadonly(readonly);
    res.json({ data: { readonly } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: err.message, code: 500 });
  }
});

export default router;
