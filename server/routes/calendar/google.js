/**
 * Modul: Kalender (Calendar) - Google-Sync + Standard-Zuweisung
 * OAuth, Sync, Kalenderauswahl, Nur-lesen, external-calendars (#459).
 */

import { refuseWhileRestoring } from '../../middleware/restore-gate.js';
import { createLogger } from '../../logger.js';
import { integrationDetailsVisible } from '../../scopes.js';
import express from 'express';
import * as db from '../../db.js';
import * as googleCalendar from '../../services/google-calendar.js';
import { requireAdmin } from '../../auth.js';
import {
  assigneeFields, readDefaultAssignees, validateAssigneeIds, writeDefaultAssignees,
} from '../../services/default-assignees.js';
import {
  applyDefaultAssigneesToExisting,
  backfillCandidatesToken,
  listBackfillCandidates,
  listMovedCandidates,
  countMovedCandidates,
  movesStillOffered,
  movedCandidatesLimit,
  movedCursorOf,
  parseMovedCursor,
} from '../../services/sync-assignment.js';
import { getUserId } from './helpers.js';

const log = createLogger('Calendar');

/**
 * EINE Stelle für die Fehlerantwort jeder Google-Route, die Google anspricht
 * oder einen Sync anstößt (#2019): ein abgelehntes Token wird zum 409 mit dem
 * Grund `google_reauth_required`, auf den die Einstellungen die Karte auf
 * "neu verbinden" umstellen; alles andere bleibt ein 500. Welche Routen das
 * sind, zählt test:google-outbound auf - eine neue Google-Route ohne Eintrag
 * dort ist rot.
 */
function sendGoogleError(res, err) {
  if (err?.reauthRequired) {
    return res.status(409).json({
      error: 'Google sign-in expired - reconnect required.', code: 409, reason: 'google_reauth_required',
    });
  }
  log.error('', err);
  return res.status(500).json({ error: err.message, code: 500 });
}
const router = express.Router();

// --------------------------------------------------------
// Google Calendar Sync-Routen
// Alle vor /:id registriert, um Konflikte zu vermeiden.
// --------------------------------------------------------

/**
 * GET /api/v1/calendar/google/auth
 * Admin only. Leitet zum Google OAuth-Consent-Screen weiter.
 */
router.get('/google/auth', requireAdmin, refuseWhileRestoring, (req, res) => {
  try {
    const url = googleCalendar.getAuthUrl(req.session);
    if (!url) return res.status(503).json({ error: 'Google Calendar is not configured.', code: 503 });
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
router.get('/google/callback', refuseWhileRestoring, async (req, res) => {
  try {
    const { code, error, state } = req.query;
    if (error) return res.redirect('/settings?sync_error=google');
    if (!code)  return res.status(400).json({ error: 'No authorization code received.', code: 400 });

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
    sendGoogleError(res, err);
  }
});

/**
 * GET /api/v1/calendar/google/status
 * Response: { configured, connected, lastSync, missingEnv, redirectUri, ... }
 */
router.get('/google/status', (req, res) => {
  try {
    const status = googleCalendar.getStatus();
    // DER FEHLERTEXT DES LETZTEN LAUFS IST VERWALTUNGSDATEN. Er kommt vom
    // Gegenueber und traegt regelmaessig dessen Adresse oder eine Kontokennung
    // in sich - `calendar:read` reicht bis hierher, weil der Pfad-Guard am
    // ersten Segment urteilt. Dieselbe Regel wie bei /caldav/status und
    // /outlook/status, an den Scopes gemessen und nicht am Kontotyp.
    // Fehlende Variablen und Rueckrufadresse sind Einrichtung des Haushalts
    // (#2221) und gehen denselben Weg wie der Fehlertext.
    const { lastError, lastErrorAt, missingEnv, redirectUri, ...rest } = status;
    res.json(integrationDetailsVisible(req) ? status : rest);
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * GET /api/v1/calendar/google/calendars
 * Admin only. Listet die verfügbaren Google-Kalender des verbundenen Accounts.
 * Response: { data: [{ id, summary, primary, backgroundColor, selected }] }
 * Erneuert der Client dabei sein Token, speichert der `tokens`-Listener es nach
 * dem Warten auf Google - deshalb `refuseWhileRestoring` (#1551).
 */
router.get('/google/calendars', requireAdmin, refuseWhileRestoring, async (req, res) => {
  try {
    const data = await googleCalendar.listCalendars();
    // Bei abgelehntem Token liefert der Dienst keine Ziele, ohne Google zu
    // fragen (#2019) - hier ist das kein leerer Kalender, sondern "neu verbinden".
    if (googleCalendar.getStatus().needsReauth) return sendGoogleError(res, { reauthRequired: true });
    res.json({ data });
  } catch (err) {
    sendGoogleError(res, err);
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
    return res.status(400).json({ error: 'calendarId is missing or invalid.', code: 400 });
  }
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean.', code: 400 });
  }
  try {
    // Abgelehntes Token (#2019): nichts an der Auswahl ändern, was der Sync
    // danach doch nicht abholen kann - die Karte stellt auf "neu verbinden" um.
    if (googleCalendar.getStatus().needsReauth) return sendGoogleError(res, { reauthRequired: true });
    googleCalendar.setCalendarEnabled(calendarId, enabled);
    await googleCalendar.sync();
    const { lastSync } = googleCalendar.getStatus();
    res.json({ ok: true, lastSync });
  } catch (err) {
    sendGoogleError(res, err);
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
 * MEHRERE PERSONEN (#1897): `default_assignee_user_ids` ersetzt die Menge des
 * Kalenders (Join-Tabelle, Migration 265), die erste ist die primaere. Die
 * Altform `default_assignee_user_id` (eine Person oder null) bleibt gueltig und
 * setzt die Menge auf diese eine Person. Die Antwort traegt beides.
 *
 * Body: { source: 'google'|'apple'|'caldav', external_id: string,
 *         default_assignee_user_ids?: number[], default_assignee_user_id?: number|null }
 * Response: { data: { source, external_id, default_assignee_user_ids, default_assignee_user_id } }
 */
router.patch('/external-calendars', requireAdmin, (req, res) => {
  try {
    const { source, external_id } = req.body;
    if (!['google', 'apple', 'caldav'].includes(source)) {
      return res.status(400).json({ error: 'source must be google, apple or caldav.', code: 400 });
    }
    if (typeof external_id !== 'string' || external_id.trim().length === 0) {
      return res.status(400).json({ error: 'external_id is missing or invalid.', code: 400 });
    }
    const d = db.get();
    const row = d.prepare('SELECT id FROM external_calendars WHERE source = ? AND external_id = ?').get(source, external_id);
    // Neu nur Haushaltsmitglieder (#1207); wer schon an dem Kalender steht, bleibt gueltig.
    const stored = row ? readDefaultAssignees(d, 'calendar', row.id) : [];
    const checked = validateAssigneeIds(d, req.body, { stored });
    if (checked.error) return res.status(400).json({ error: checked.error, code: 400, reason: checked.reason });
    // Ein Body ohne eines der Felder leert die Menge, wie frueher ein fehlendes Feld.
    const ids = checked.present ? checked.ids : [];

    let calendarId = row?.id;
    if (!calendarId) {
      const name = knownCalendarName(source, external_id);
      if (!name) {
        return res.status(404).json({ error: 'This calendar has not been synced yet.', code: 404 });
      }
      // Farbe bleibt offen: Sie gehört dem Provider, und der nächste Sync trägt
      // sie zusammen mit dem endgültigen Namen nach.
      calendarId = Number(d.prepare(`
        INSERT INTO external_calendars (source, external_id, name, color)
        VALUES (?, ?, ?, NULL)
      `).run(source, external_id, name).lastInsertRowid);
    }
    writeDefaultAssignees(d, 'calendar', calendarId, ids);
    res.json({ data: { source, external_id, ...assigneeFields(readDefaultAssignees(d, 'calendar', calendarId)) } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * Eine Seite der umgezogenen Termine fuer die Vorschau (#1307): je Termin Titel,
 * Beginn, Kalender und "von Person X auf Person Y". Der Admin hakt sie einzeln ab.
 *
 * - Nur Termine, die die anfragende Person nach der Kalender-Sichtbarkeit sehen
 *   darf (#474, kein Admin-Bypass) - gezeigt, gezaehlt und umgestellt.
 * - Hoechstens movedCandidatesLimit.max je Seite, aelteste zuerst - dieselbe
 *   Grenze, die parseMoves() fuer die Bestaetigung zieht.
 * - `moved_total` zaehlt alle, `moved_offset` die vor dieser Seite, und
 *   `moved_next` ist der Zeiger auf die naechste (null auf der letzten). Bestaetigt
 *   wird je Seite; abgewaehlte Termine halten die naechste Seite nicht auf.
 */
function movedPreviewFields(d, viewerId, after = null) {
  const limit = movedCandidatesLimit.max;
  const rows = listMovedCandidates(d, { viewerId, limit, after });
  const { total, before } = countMovedCandidates(d, { viewerId, after });
  const more = before + rows.length < total && rows.length > 0;
  return {
    // Mengen (#1897): `from_user_ids`/`to_user_ids` mit ihren Namen. Die
    // Einzelfelder tragen fuer Aufrufer der Altform die primaere Person und
    // alle Namen in einem Text.
    moved: rows.map((m) => ({
      event_id: m.eventId,
      title: m.title,
      start_datetime: m.startDatetime,
      all_day: m.allDay,
      calendar_name: m.calendarName,
      from_user_ids: m.fromUserIds,
      from_names: m.fromNames,
      to_user_ids: m.userIds,
      to_names: m.toNames,
      from_user_id: m.fromUserIds[0] ?? null,
      from_name: m.fromNames.join(', '),
      to_user_id: m.userIds[0] ?? null,
      to_name: m.toNames.join(', '),
    })),
    moved_total: total,
    moved_offset: before,
    moved_next: more ? movedCursorOf(rows.at(-1)) : null,
  };
}

/** Eine Menge aus einem Umzugseintrag: die Liste oder die Altform (eine Id). */
function moveIds(list, single) {
  const raw = list !== undefined ? list : (single !== undefined ? [single] : null);
  if (!Array.isArray(raw) || !raw.length || raw.length > 100) return null;
  if (!raw.every((v) => Number.isInteger(v) && v > 0)) return null;
  return [...new Set(raw)];
}

/**
 * `moves` aus dem Body: eine Liste { event_id, from_user_ids, to_user_ids }
 * (oder, Altform, { event_id, from_user_id, to_user_id }), je Termin
 * hoechstens einmal und hoechstens movedCandidatesLimit.max Eintraege - so
 * viele, wie die Vorschau zeigt. Fehlt sie, ist nichts abgehakt.
 * @returns {{ eventId: number, fromUserIds: number[], userIds: number[] }[] | { error: string }}
 */
function parseMoves(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return { error: 'moves is invalid.' };
  const max = movedCandidatesLimit.max;
  if (raw.length > max) return { error: `moves takes at most ${max} events per confirmation.` };
  const invalid = { error: 'moves is invalid.' };
  const seen = new Set();
  const moves = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return invalid;
    const { event_id: eventId } = item;
    const fromUserIds = moveIds(item.from_user_ids, item.from_user_id);
    const userIds = moveIds(item.to_user_ids, item.to_user_id);
    if (!Number.isInteger(eventId) || eventId < 1 || !fromUserIds || !userIds) return invalid;
    if (seen.has(eventId)) return invalid;
    seen.add(eventId);
    moves.push({ eventId, fromUserIds, userIds });
  }
  return moves;
}

/**
 * GET /api/v1/calendar/external-calendars/default-assignee-backfill
 * Admin only. Zählt, wie viele bereits importierte Termine das Nachtragen der
 * Standard-Zuweisung füllen würde (#1154) - die Zahl steht in der Rückfrage.
 * Das Token ist der Fingerabdruck genau dieser Menge (#1171) und geht mit der
 * Bestätigung zurück.
 * `moved` listet dazu die vor #1306 umgezogenen Termine, die noch die Person
 * ihres alten Kalenders tragen (#1307) - einzeln, weil sie sich in den Daten
 * nicht von einem Kalender mit später umgestellter Standard-Person trennen
 * lassen. Sie zählen nicht in `count` und gehen nur abgehakt zurück. Die Liste
 * kommt seitenweise (movedPreviewFields); `?moved_after=<moved_next>` holt die
 * nächste Seite.
 * `count` und `token` nennen keinen Termin und bleiben ohne Sichtbarkeitsfilter
 * wie seit #1154.
 * Response: { data: { count, token, moved: [...], moved_total, moved_offset, moved_next } }
 */
router.get('/external-calendars/default-assignee-backfill', requireAdmin, (req, res) => {
  try {
    let after = null;
    if (req.query.moved_after !== undefined) {
      after = parseMovedCursor(req.query.moved_after);
      if (!after) return res.status(400).json({ error: 'moved_after is invalid.', code: 400 });
    }
    const d = db.get();
    const candidates = listBackfillCandidates(d);
    res.json({ data: {
      count: candidates.length,
      token: backfillCandidatesToken(candidates),
      ...movedPreviewFields(d, getUserId(req), after),
    } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * POST /api/v1/calendar/external-calendars/default-assignee-backfill
 * Admin only. Wendet die Standard-Zuweisung jedes Kalenders aller Konten auf
 * seine schon importierten Termine an, die noch niemandem zugewiesen sind
 * (#1154). Eine vorhandene Zuweisung bleibt unangetastet - ausser an den
 * umgezogenen Terminen, die der Admin in der Vorschau einzeln abgehakt hat
 * (`moves`, #1307).
 *
 * Die Rueckfrage hat eine Menge genannt, und nur diese Menge ist bestaetigt:
 * hat sie sich seither geaendert (jemand hat Zuweisungen entfernt, eine
 * Zuordnung umgestellt), antwortet die Route mit 409 statt mehr oder andere
 * Termine zu fuellen. Die Zahl allein faengt nur eine Aenderung der GROESSE;
 * das Token aus der Zaehlung faengt auch den Tausch bei gleicher Groesse
 * (#1171). Ohne Token bleibt es beim Zahlenvergleich, damit ein API-Client, der
 * die Route vor dem Token angebunden hat, nicht bricht. Die Aktion ist nur
 * Termin fuer Termin zuruecknehmbar.
 *
 * Jeder abgehakte Umzug nennt Termin, bisherige und neue Person - genau die
 * Zeile, die die Vorschau gezeigt hat. Geprueft wird jeder EINZELN per
 * Punktabfrage gegen dieselbe Regel und dieselbe Sichtbarkeit wie die Vorschau
 * (movesStillOffered, in Happen mit Pause dazwischen, #1440) - die ganze Liste
 * wird dafuer nicht geladen, und eine Seite braucht die Bestaetigung nicht.
 * Passt einer nicht mehr (inzwischen bearbeitet, Standard-Person umgestellt,
 * nie angeboten, nicht sichtbar), ist die
 * Auswahl veraltet: 409 mit der ersten Seite der Vorschau, und nichts wird
 * geschrieben.
 * Ohne `moves` wird kein Termin umgestellt.
 * Body: { expected_count: number, expected_token?: string,
 *         moves?: { event_id, from_user_ids, to_user_ids }[] } (Altform: from_user_id, to_user_id)
 * Response: { data: { assigned } } | 409 { data: { count, token, moved, moved_total, moved_offset, moved_next } }
 */
router.post('/external-calendars/default-assignee-backfill', requireAdmin, async (req, res) => {
  try {
    const expected = req.body?.expected_count;
    if (!Number.isInteger(expected) || expected < 0) {
      return res.status(400).json({ error: 'expected_count is missing or invalid.', code: 400 });
    }
    const expectedToken = req.body?.expected_token;
    if (expectedToken !== undefined && expectedToken !== null
      && (typeof expectedToken !== 'string' || !/^[0-9a-f]{64}$/.test(expectedToken))) {
      return res.status(400).json({ error: 'expected_token is invalid.', code: 400 });
    }
    const moves = parseMoves(req.body?.moves);
    if (!Array.isArray(moves)) {
      return res.status(400).json({ error: moves.error, code: 400 });
    }
    const d = db.get();
    const viewerId = getUserId(req);
    // Die Umzuege zuerst, in Happen (#1440): dazwischen kommen andere Anfragen dran.
    const movesOffered = await movesStillOffered(d, moves, { viewerId });
    // Gezählt und festgehalten im selben synchronen Schritt wie der erste Happen
    // des Schreibens: genau diese Liste ist bestätigt, und nur sie wird
    // abgearbeitet - auch wenn zwischen den Happen neue Kandidaten dazukommen.
    const candidates = listBackfillCandidates(d);
    const token = backfillCandidatesToken(candidates);
    if (candidates.length !== expected || (expectedToken && expectedToken !== token) || !movesOffered) {
      return res.status(409).json({
        error: 'The events have changed since they were counted.',
        code: 409,
        data: { count: candidates.length, token, ...movedPreviewFields(d, viewerId) },
      });
    }
    res.json({ data: { assigned: await applyDefaultAssigneesToExisting(d, [...candidates, ...moves], { viewerId }) } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
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
    res.status(500).json({ error: 'Internal server error.', code: 500 });
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
    res.status(500).json({ error: 'Internal server error.', code: 500 });
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
    return res.status(400).json({ error: 'readonly must be a boolean.', code: 400 });
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
