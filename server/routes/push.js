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
          user_id    = excluded.user_id,
          p256dh     = excluded.p256dh,
          auth       = excluded.auth,
          user_agent = excluded.user_agent
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

  router.post('/test', async (req, res) => {
    try {
      const userId = req.authUserId || req.session.userId;
      const title = typeof req.body?.title === 'string' ? req.body.title : 'Yuvomi';
      const body  = typeof req.body?.body === 'string' ? req.body.body : '';
      const sent = await pushService.sendPushToUser(userId, { title, body, url: '/reminders', tag: 'push-test' });
      res.json({ data: { sent } });
    } catch (err) {
      log.error('Error sending test push:', err.message);
      res.status(500).json({ error: 'Internal error.', code: 500 });
    }
  });

  return router;
}

export default buildRouter();
