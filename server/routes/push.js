/**
 * Modul: Push (Web Push)
 * Zweck: REST-API für VAPID-Public-Key, Subscribe/Unsubscribe und Test-Push.
 * Abhängigkeiten: express, server/db.js, server/services/push.js
 */
import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { pushService as defaultPushService } from '../services/push.js';

const log = createLogger('PushRoutes');

export function buildRouter({ pushService = defaultPushService, database } = {}) {
  const getDb = () => (database || db.get());
  const router = express.Router();

  router.get('/vapid-public-key', (req, res) => {
    try {
      res.json({ data: { key: pushService.getPublicKey() } });
    } catch (err) {
      log.error('Error reading VAPID public key:', err.message);
      res.status(500).json({ error: 'Internal error.', code: 500 });
    }
  });

  router.post('/subscribe', (req, res) => {
    try {
      const userId = req.authUserId || req.session.userId;
      const { endpoint, keys } = req.body || {};
      if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
        return res.status(400).json({ error: 'endpoint und keys (p256dh, auth) sind erforderlich.', code: 400 });
      }
      const ua = req.get('user-agent') || null;
      getDb().prepare(`
        INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET
          user_id       = excluded.user_id,
          p256dh        = excluded.p256dh,
          auth          = excluded.auth,
          user_agent    = excluded.user_agent,
          wall_paused_at = CASE WHEN excluded.user_id != user_id THEN NULL ELSE wall_paused_at END
      `).run(userId, endpoint, keys.p256dh, keys.auth, ua);
      const row = getDb().prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
      res.status(201).json({ data: { id: row.id } });
    } catch (err) {
      log.error('Error subscribing to push:', err.message);
      res.status(500).json({ error: 'Internal error.', code: 500 });
    }
  });

  router.post('/unsubscribe', (req, res) => {
    try {
      const userId = req.authUserId || req.session.userId;
      const { endpoint } = req.body || {};
      if (!endpoint) {
        return res.status(400).json({ error: 'endpoint ist erforderlich.', code: 400 });
      }
      getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, userId);
      res.status(204).end();
    } catch (err) {
      log.error('Error unsubscribing from push:', err.message);
      res.status(500).json({ error: 'Internal error.', code: 500 });
    }
  });

  router.put('/wall-mode', (req, res) => {
    try {
      const userId = req.authUserId || req.session.userId;
      const { endpoint, active } = req.body || {};
      if (typeof endpoint !== 'string' || typeof active !== 'boolean') {
        return res.status(400).json({ error: 'endpoint (string) und active (boolean) sind erforderlich.', code: 400 });
      }
      // active=true: Pause setzen (jetzt); active=false: Pause loeschen.
      // Der Zeitstempel laeuft nach WALL_PAUSE_MAX_AGE_HOURS ab - eine Erneuerung
      // beim Laden und beim Aufwachen stellt sicher, dass eine lang laufende Wand
      // weiter stumm bleibt (#1904).
      getDb().prepare(
        `UPDATE push_subscriptions SET wall_paused_at = ${active ? "datetime('now')" : 'NULL'} WHERE endpoint = ? AND user_id = ?`,
      ).run(endpoint, userId);
      res.status(204).end();
    } catch (err) {
      log.error('Error updating wall-mode pause:', err.message);
      res.status(500).json({ error: 'Internal error.', code: 500 });
    }
  });

  router.post('/test', async (req, res) => {
    try {
      const userId = req.authUserId || req.session.userId;
      const title = typeof req.body?.title === 'string' ? req.body.title : 'Yuvomi';
      const body  = typeof req.body?.body === 'string' ? req.body.body : '';
      // Vor dem Senden zählen: Wird das Abo beim Senden als "gone" entfernt,
      // bleibt devices > 0 bei sent === 0 und der Client kann "abgelaufen"
      // von "nie registriert" unterscheiden.
      const devices = getDb()
        .prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?')
        .get(userId)?.n ?? 0;
      // Wand-Pause aufheben, damit der Test-Push auf jedem Abo ankommt: ein
      // pausiertes Geraet wuerde `sent: 0, devices: 1` zurueckgeben und den
      // Client zur Reparatur animieren, obwohl das Abo gesund ist (#1904).
      getDb().prepare("UPDATE push_subscriptions SET wall_paused_at = NULL WHERE user_id = ?").run(userId);
      const sent = await pushService.sendPushToUser(userId, { title, body, url: '/reminders', tag: 'push-test' });
      res.json({ data: { sent, devices } });
    } catch (err) {
      log.error('Error sending test push:', err.message);
      res.status(500).json({ error: 'Internal error.', code: 500 });
    }
  });

  return router;
}

export default buildRouter();
