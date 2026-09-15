/**
 * Modul: Kalender (Calendar) - ICS-Abonnements + einmaliger Import
 */

import { createLogger } from '../../logger.js';
import express from 'express';
import * as db from '../../db.js';
import * as icsSubscription from '../../services/ics-subscription.js';
import { color } from '../../middleware/validate.js';
import { ICS_COLOR_RE, getUserId, isAdminUser } from './helpers.js';
import { newNonMembers, nonMemberMessage } from '../../services/household-members.js';

const log = createLogger('Calendar');
const router = express.Router();

// --------------------------------------------------------
// ICS Subscription-Routen
// Müssen vor /:id registriert werden, um Konflikte zu vermeiden.
// --------------------------------------------------------

router.get('/subscriptions', (req, res) => {
  try {
    const subs = icsSubscription.getAll(getUserId(req));
    res.json({ data: subs });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

router.post('/subscriptions', async (req, res) => {
  try {
    const { name, url, color: colorVal, shared } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length === 0 || name.length > 100)
      return res.status(400).json({ error: 'name: Pflichtfeld, max. 100 Zeichen.', code: 400 });
    if (!url || typeof url !== 'string')
      return res.status(400).json({ error: 'url: Pflichtfeld.', code: 400 });
    const allowPrivate = icsSubscription.isPrivateNetworkAllowed();
    const allowedProtocols = allowPrivate ? ['https:', 'http:'] : ['https:'];
    try { const u = new URL(url.replace(/^webcal:\/\//i, 'https://')); if (!allowedProtocols.includes(u.protocol)) throw new Error(); }
    catch { return res.status(400).json({ error: allowPrivate ? 'url: Nur http://, https:// und webcal:// sind erlaubt.' : 'url: Nur https:// und webcal:// sind erlaubt.', code: 400 }); }
    if (!colorVal || !ICS_COLOR_RE.test(colorVal))
      return res.status(400).json({ error: 'color: Pflichtfeld, muss #RRGGBB sein.', code: 400 });
    // Die Standard-Zuweisung schon beim Anlegen: create() synchronisiert
    // unmittelbar, und bisher ließ sie sich erst danach im Bearbeiten-Dialog
    // setzen - die erste, oft größte Ladung Termine kam also grundsätzlich ohne
    // Zuweisung herein (#730). Optional, damit bestehende Aufrufer unverändert
    // durchgehen.
    const rawAssignee = req.body.default_assignee_user_id;
    let defaultAssignee = null;
    if (rawAssignee !== undefined && rawAssignee !== null && rawAssignee !== '') {
      defaultAssignee = Number(rawAssignee);
      if (!Number.isInteger(defaultAssignee))
        return res.status(400).json({ error: 'default_assignee_user_id muss eine Zahl oder null sein.', code: 400 });
      if (!db.get().prepare('SELECT 1 FROM users WHERE id = ?').get(defaultAssignee))
        return res.status(400).json({ error: 'Unbekannte Nutzer-ID.', code: 400 });
      // Zugewiesen werden nur Haushaltsmitglieder (#1207); ein neues Abo hat noch keinen Stand.
      const strangers = newNonMembers([defaultAssignee]);
      if (strangers.length) return res.status(400).json({ error: nonMemberMessage(strangers), code: 400 });
    }

    const { sub, syncError } = await icsSubscription.create(getUserId(req), {
      name: name.trim(), url, color: colorVal, shared: shared ? 1 : 0,
      default_assignee_user_id: defaultAssignee,
    });
    res.status(201).json({ data: sub, syncError: syncError || null });
  } catch (err) {
    log.error('', err);
    if (err.message?.includes('Nur https')) return res.status(400).json({ error: err.message, code: 400 });
    if (err.message?.includes('private IP')) return res.status(400).json({ error: err.message, code: 400 });
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

router.patch('/subscriptions/:id', (req, res) => {
  try {
    const subId   = parseInt(req.params.id, 10);
    if (!Number.isFinite(subId)) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });
    const isAdmin = isAdminUser(req);
    const fields  = {};
    if (req.body.name  !== undefined) {
      if (typeof req.body.name !== 'string' || req.body.name.trim().length === 0 || req.body.name.length > 100)
        return res.status(400).json({ error: 'name: max. 100 Zeichen, darf nicht leer sein.', code: 400 });
      fields.name = req.body.name.trim();
    }
    if (req.body.color !== undefined) {
      if (!ICS_COLOR_RE.test(req.body.color))
        return res.status(400).json({ error: 'color: muss #RRGGBB sein.', code: 400 });
      fields.color = req.body.color;
    }
    if (req.body.shared !== undefined) fields.shared = req.body.shared;
    if (req.body.default_assignee_user_id !== undefined) {
      const raw = req.body.default_assignee_user_id;
      fields.default_assignee_user_id = (raw === null || raw === '') ? null : Number(raw);
      // Neu nur Haushaltsmitglieder (#1207); die gespeicherte Zuweisung bleibt gueltig.
      if (fields.default_assignee_user_id !== null) {
        const stored = db.get().prepare('SELECT default_assignee_user_id AS a FROM ics_subscriptions WHERE id = ?').get(subId)?.a;
        const strangers = newNonMembers([fields.default_assignee_user_id], { stored: stored == null ? [] : [stored] });
        if (strangers.length) return res.status(400).json({ error: nonMemberMessage(strangers), code: 400 });
      }
    }

    const updated = icsSubscription.update(getUserId(req), subId, fields, isAdmin);
    if (!updated) return res.status(404).json({ error: 'Abonnement nicht gefunden.', code: 404 });
    res.json({ data: updated });
  } catch (err) {
    // icsSubscription wirft 'Not authorized.' (englisch) — ohne diese Angleichung
    // schlägt der Vergleich fehl und ein Nicht-Owner erhielte 500 statt 403.
    if (err.message === 'Not authorized.') return res.status(403).json({ error: 'Nicht autorisiert.', code: 403 });
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

router.delete('/subscriptions/:id', (req, res) => {
  try {
    const subId   = parseInt(req.params.id, 10);
    if (!Number.isFinite(subId)) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });
    const isAdmin = isAdminUser(req);
    const ok      = icsSubscription.remove(getUserId(req), subId, isAdmin);
    if (!ok) return res.status(404).json({ error: 'Abonnement nicht gefunden.', code: 404 });
    res.status(204).end();
  } catch (err) {
    // icsSubscription wirft 'Not authorized.' (englisch) — Angleichung wie oben,
    // sonst 500 statt 403 für Nicht-Owner.
    if (err.message === 'Not authorized.') return res.status(403).json({ error: 'Nicht autorisiert.', code: 403 });
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

router.post('/subscriptions/:id/sync', async (req, res) => {
  try {
    const subId   = parseInt(req.params.id, 10);
    if (!Number.isFinite(subId)) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });
    const isAdmin = isAdminUser(req);
    const sub     = db.get().prepare('SELECT * FROM ics_subscriptions WHERE id = ?').get(subId);
    if (!sub) return res.status(404).json({ error: 'Abonnement nicht gefunden.', code: 404 });
    if (!isAdmin && sub.created_by !== getUserId(req))
      return res.status(403).json({ error: 'Nicht autorisiert.', code: 403 });
    await icsSubscription.sync(subId);
    const updated = db.get().prepare('SELECT * FROM ics_subscriptions WHERE id = ?').get(subId);
    res.json({ data: updated });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
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

    const result = await icsSubscription.importToLocal(userId, {
      ics, url, color: vColorValue,
    });
    res.status(201).json({ data: result });
  } catch (err) {
    // Nutzerorientierte Fehler (SSRF-Block, ungültige URL, HTTP-Status,
    // Größenlimit) direkt zurückgeben; Rest als generischer Serverfehler.
    if (err instanceof TypeError || /URL|https?|private IP|ICS file|HTTP \d|required/i.test(err.message || '')) {
      return res.status(400).json({ error: err.message, code: 400 });
    }
    log.error('POST /import:', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

export default router;
