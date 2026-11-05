/**
 * Modul: Kalender (Calendar) - ICS-Abonnements + einmaliger Import
 */

import { createLogger } from '../../logger.js';
import express from 'express';
import * as db from '../../db.js';
import * as icsSubscription from '../../services/ics-subscription.js';
import { color } from '../../middleware/validate.js';
import { ICS_COLOR_RE, getUserId, isAdminUser } from './helpers.js';
import { readDefaultAssignees, validateAssigneeIds } from '../../services/default-assignees.js';
import { validateCalendarId } from '../../services/local-calendars.js';
import { BlockedAddressError } from '../../utils/ssrf.js';

const log = createLogger('Calendar');
const router = express.Router();

const NAME_INVALID = { reason: 'calendar_subscription_name_invalid' };

/**
 * Der Fall eines gescheiterten Feed-Abrufs (#1909), den die Seite in ihrer
 * Sprache sagt - oder null. Der Text des Fehlers bleibt in `error`; ein Status
 * oder eine Grenze reist als Zahl in `params`, nie als Satz.
 */
function icsFetchCase(err) {
  if (err instanceof BlockedAddressError) return { reason: 'calendar_ics_private_address' };
  if (err?.code === 'ERR_INVALID_URL') return { reason: 'calendar_ics_url_invalid' };
  if (err?.code === 'calendar_ics_url_scheme') return { reason: 'calendar_ics_url_scheme' };
  if (err?.code === 'calendar_ics_http_status') return { reason: 'calendar_ics_http_status', params: { status: err.params.status } };
  if (err?.code === 'calendar_ics_too_large') return { reason: 'calendar_ics_too_large', params: { limit_mb: err.params.limit_mb } };
  return null;
}

// --------------------------------------------------------
// ICS Subscription-Routen
// Müssen vor /:id registriert werden, um Konflikte zu vermeiden.
// --------------------------------------------------------

router.get('/subscriptions', (req, res) => {
  try {
    const subs = icsSubscription.getAll(getUserId(req));
    // DIE QUELL-URL IST EIN ZUGANGSDATUM, KEIN ANZEIGEFELD. Private
    // Kalenderfeeds tragen ihr Geheimnis regelmaessig IM Pfad; wer die URL
    // liest, hat den Kalender dauerhaft - auch nachdem sein eigener Zugang
    // entzogen wurde. Sie gehoert deshalb dem, der das Abo VERWALTET, und nicht
    // jedem, der Kalender lesen darf.
    //
    // Gemessen an den Scopes, nicht an der Anmeldeart: das trifft das
    // Wandtablett (#1208) und ebenso ein gescoptes API-Token mit
    // `calendar:read` - dort lag die Luecke schon vor diesem Ticket. Eine
    // Sitzung traegt `authScopes === null` und sieht die URL wie bisher, sonst
    // liesse sich ein Abo nicht mehr bearbeiten.
    const data = req.authScopes == null ? subs : subs.map(({ url, ...rest }) => rest);
    res.json({ data });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/subscriptions', async (req, res) => {
  try {
    const { name, url, color: colorVal, shared } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length === 0 || name.length > 100)
      return res.status(400).json({ error: 'name is required and may be at most 100 characters long.', code: 400, ...NAME_INVALID });
    if (!url || typeof url !== 'string')
      return res.status(400).json({ error: 'url is required.', code: 400 });
    const allowPrivate = icsSubscription.isPrivateNetworkAllowed();
    const allowedProtocols = allowPrivate ? ['https:', 'http:'] : ['https:'];
    // Keine Adresse und eine mit falschem Schema sind zwei Faelle (#1909); der
    // Text bleibt fuer beide derselbe wie vorher.
    const schemeError = allowPrivate ? 'Only http://, https:// and webcal:// URLs are allowed.' : 'Only https:// and webcal:// URLs are allowed.';
    let parsed;
    try { parsed = new URL(url.replace(/^webcal:\/\//i, 'https://')); }
    catch { return res.status(400).json({ error: schemeError, code: 400, reason: 'calendar_ics_url_invalid' }); }
    if (!allowedProtocols.includes(parsed.protocol)) {
      return res.status(400).json({ error: schemeError, code: 400, reason: 'calendar_ics_url_scheme' });
    }
    if (!colorVal || !ICS_COLOR_RE.test(colorVal))
      return res.status(400).json({ error: 'color is required and must be #RRGGBB.', code: 400 });
    // Die Standard-Zuweisung schon beim Anlegen: create() synchronisiert
    // unmittelbar, und bisher ließ sie sich erst danach im Bearbeiten-Dialog
    // setzen - die erste, oft größte Ladung Termine kam also grundsätzlich ohne
    // Zuweisung herein (#730). Optional, damit bestehende Aufrufer unverändert
    // durchgehen.
    //
    // Mehrere Personen (#1897): `default_assignee_user_ids`, oder die Altform
    // `default_assignee_user_id` mit einer. Zugewiesen werden nur
    // Haushaltsmitglieder (#1207); ein neues Abo hat noch keinen Stand.
    const assignees = validateAssigneeIds(db.get(), req.body);
    if (assignees.error) return res.status(400).json({ error: assignees.error, code: 400, reason: assignees.reason });

    const { sub, syncError } = await icsSubscription.create(getUserId(req), {
      name: name.trim(), url, color: colorVal, shared: shared ? 1 : 0,
      default_assignee_user_ids: assignees.present ? assignees.ids : [],
    });
    // Das Abo steht auch dann, wenn der erste Abruf scheitert (#2566):
    // `syncError` bleibt der Text fuer API-Aufrufer, `syncReason` und
    // `syncParams` sind der Fall, den die Seite in ihrer Sprache sagt. Den
    // Rohtext gibt es nur zu einem benannten Fall: ein abgelehnter Verbindungs-
    // aufbau nennt Adresse und Port und waere mit erlaubtem privatem Netz ein
    // Port-Scanner. Er steht im Log (syncOne).
    const syncCase = syncError ? icsFetchCase(syncError) : null;
    res.status(201).json({
      data: sub,
      syncError: syncError ? (syncCase ? syncError.message : 'The feed could not be fetched.') : null,
      syncReason: syncCase?.reason ?? null,
      ...(syncCase?.params ? { syncParams: syncCase.params } : {}),
    });
  } catch (err) {
    log.error('', err);
    const fetchCase = icsFetchCase(err);
    if (fetchCase) return res.status(400).json({ error: err.message, code: 400, ...fetchCase });
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.patch('/subscriptions/:id', (req, res) => {
  try {
    const subId   = parseInt(req.params.id, 10);
    if (!Number.isFinite(subId)) return res.status(400).json({ error: 'Invalid id.', code: 400 });
    const isAdmin = isAdminUser(req);
    const fields  = {};
    if (req.body.name  !== undefined) {
      if (typeof req.body.name !== 'string' || req.body.name.trim().length === 0 || req.body.name.length > 100)
        return res.status(400).json({ error: 'name must not be empty and may be at most 100 characters long.', code: 400, ...NAME_INVALID });
      fields.name = req.body.name.trim();
    }
    if (req.body.color !== undefined) {
      if (!ICS_COLOR_RE.test(req.body.color))
        return res.status(400).json({ error: 'color must be #RRGGBB.', code: 400 });
      fields.color = req.body.color;
    }
    if (req.body.shared !== undefined) fields.shared = req.body.shared;
    // Neu nur Haushaltsmitglieder (#1207); wer schon am Abo steht, bleibt gueltig.
    const assignees = validateAssigneeIds(db.get(), req.body, {
      stored: readDefaultAssignees(db.get(), 'subscription', subId),
    });
    if (assignees.error) return res.status(400).json({ error: assignees.error, code: 400, reason: assignees.reason });
    if (assignees.present) fields.default_assignee_user_ids = assignees.ids;

    const updated = icsSubscription.update(getUserId(req), subId, fields, isAdmin);
    if (!updated) return res.status(404).json({ error: 'Subscription not found.', code: 404, reason: 'calendar_subscription_not_found' });
    res.json({ data: updated });
  } catch (err) {
    // icsSubscription wirft 'Not authorized.' (englisch) — ohne diese Angleichung
    // schlägt der Vergleich fehl und ein Nicht-Owner erhielte 500 statt 403.
    if (err.message === 'Not authorized.') return res.status(403).json({ error: 'You cannot modify this subscription.', code: 403 });
    log.error('', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.delete('/subscriptions/:id', (req, res) => {
  try {
    const subId   = parseInt(req.params.id, 10);
    if (!Number.isFinite(subId)) return res.status(400).json({ error: 'Invalid id.', code: 400 });
    const isAdmin = isAdminUser(req);
    const ok      = icsSubscription.remove(getUserId(req), subId, isAdmin);
    if (!ok) return res.status(404).json({ error: 'Subscription not found.', code: 404, reason: 'calendar_subscription_not_found' });
    res.status(204).end();
  } catch (err) {
    // icsSubscription wirft 'Not authorized.' (englisch) — Angleichung wie oben,
    // sonst 500 statt 403 für Nicht-Owner.
    if (err.message === 'Not authorized.') return res.status(403).json({ error: 'You cannot modify this subscription.', code: 403 });
    log.error('', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/subscriptions/:id/sync', async (req, res) => {
  try {
    const subId   = parseInt(req.params.id, 10);
    if (!Number.isFinite(subId)) return res.status(400).json({ error: 'Invalid id.', code: 400 });
    const isAdmin = isAdminUser(req);
    const sub     = db.get().prepare('SELECT * FROM ics_subscriptions WHERE id = ?').get(subId);
    if (!sub) return res.status(404).json({ error: 'Subscription not found.', code: 404, reason: 'calendar_subscription_not_found' });
    if (!isAdmin && sub.created_by !== getUserId(req))
      return res.status(403).json({ error: 'You cannot modify this subscription.', code: 403 });
    // Ein Feed, der nicht ausliefert, ist kein Erfolg (#2566): der Knopf sagt
    // den Fall, statt "synchronisiert" zu melden.
    await icsSubscription.sync(subId, { rethrowFetch: true });
    res.json({ data: icsSubscription.getOne(subId) });
  } catch (err) {
    const fetchCase = icsFetchCase(err);
    if (fetchCase) return res.status(400).json({ error: err.message, code: 400, ...fetchCase });
    log.error('', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// POST /api/v1/calendar/import → einmaliger Import aus ICS-Datei/Feed als
// echte, bearbeitbare lokale Termine (Discussion #437, Kalender-Migration).
router.post('/import', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated.', code: 401 });

    const ics = typeof req.body.ics === 'string' ? req.body.ics : null;
    const url = typeof req.body.url === 'string' ? req.body.url.trim() : null;
    if (!ics?.trim() && !url) {
      return res.status(400).json({ error: 'Either an ICS file or a URL is required.', code: 400 });
    }

    let vColorValue = null;
    if (req.body.color) {
      const vColor = color(req.body.color, 'Farbe');
      if (vColor.error) return res.status(400).json({ error: vColor.error, code: 400 });
      vColorValue = vColor.value;
    }
    const vLocalCalendar = validateCalendarId(db.get(), req.body.local_calendar_id);
    if (vLocalCalendar.error) {
      // Der gewaehlte Kalender ist inzwischen geloescht (#1909): wie beim Termin.
      return res.status(400).json({
        error: vLocalCalendar.error, code: 400,
        ...(vLocalCalendar.reason === 'calendar_selected_calendar_not_found' ? { reason: 'calendar_selected_calendar_not_found' } : {}),
      });
    }
    // Personen fuer diesen Lauf (#1940): `assignee_user_ids`, oder eine in
    // `assignee_user_id`. Nur Haushaltsmitglieder; gespeichert wird nichts.
    const assignees = validateAssigneeIds(db.get(), req.body, {
      listField: 'assignee_user_ids', singleField: 'assignee_user_id',
    });
    if (assignees.error) return res.status(400).json({ error: assignees.error, code: 400, reason: assignees.reason });

    const result = await icsSubscription.importToLocal(userId, {
      ics, url, color: vColorValue, localCalendarId: vLocalCalendar.value,
      assigneeIds: assignees.present ? assignees.ids : [],
    });
    res.status(201).json({ data: result });
  } catch (err) {
    // Nutzerorientierte Fehler (SSRF-Block, ungültige URL, HTTP-Status,
    // Größenlimit) direkt zurückgeben, mit ihrem Fall (#1909); Rest als
    // generischer Serverfehler.
    const fetchCase = icsFetchCase(err);
    if (fetchCase) return res.status(400).json({ error: err.message, code: 400, ...fetchCase });
    if (err instanceof TypeError || /URL|https?|private IP|ICS file|HTTP \d|required/i.test(err.message || '')) {
      return res.status(400).json({ error: err.message, code: 400 });
    }
    log.error('POST /import:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
