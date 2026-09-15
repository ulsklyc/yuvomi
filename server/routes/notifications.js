/**
 * Modul: Notification-Routen (Admin)
 * Zweck: Notification-Channels verwalten und Testbenachrichtigungen senden.
 * Abhaengigkeiten: express, notification-channels.js, notifications.js
 */
import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import { createNotificationChannelStore, NOTIFICATION_PROVIDERS } from '../services/notification-channels.js';
import { notificationService as defaultNotificationService } from '../services/notifications.js';

const log = createLogger('NotificationRoutes');

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function buildRouter({
  database,
  channelStore,
  notificationService = defaultNotificationService,
} = {}) {
  const getDb = () => (database || db.get());
  const store = channelStore || createNotificationChannelStore({ db: getDb() });
  const router = express.Router();

  function requireAdmin(req, res, next) {
    if (!isAdminRequest(req)) {
      return res.status(403).json({ error: 'Admin access required.', code: 403 });
    }
    next();
  }

  router.use(requireAdmin);

  router.get('/providers', (req, res) => {
    try {
      void req;
      // `available` heisst „der Server kennt diesen Adapter", nicht „er kann
      // senden". Ein Provider, der eine Voraussetzung ausserhalb seines Kanals
      // hat - Mail braucht den app-weiten SMTP-Zugang -, sagt das ueber
      // `isAvailable()`. Wer keine hat, gilt unveraendert als bereit.
      const available = NOTIFICATION_PROVIDERS
        .filter((provider) => notificationService.providers?.[provider.id])
        .map((provider) => {
          const adapter = notificationService.providers[provider.id];
          if (typeof adapter.isAvailable !== 'function') return provider;
          let ready = false;
          try {
            ready = adapter.isAvailable() === true;
          } catch (err) {
            log.warn(`Provider ${provider.id} availability check failed:`, err.message);
          }
          return { ...provider, ready };
        });
      res.json({ data: available });
    } catch (err) {
      log.error('Error reading notification providers:', err.message);
      res.status(500).json({ error: 'Internal error.', code: 500 });
    }
  });

  router.get('/channels', (req, res) => {
    try {
      void req;
      res.json({ data: store.listChannels() });
    } catch (err) {
      log.error('Error reading notification channels:', err.message);
      res.status(500).json({ error: 'Internal error.', code: 500 });
    }
  });

  router.post('/channels', (req, res) => {
    try {
      const channel = store.createChannel(req.body || {});
      res.status(201).json({ data: channel });
    } catch (err) {
      res.status(400).json({ error: err.message || 'Invalid notification channel.', code: 400 });
    }
  });

  router.put('/channels/:id', (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid channel id.', code: 400 });
      const channel = store.updateChannel(id, req.body || {});
      if (!channel) return res.status(404).json({ error: 'Notification channel not found.', code: 404 });
      res.json({ data: channel });
    } catch (err) {
      res.status(400).json({ error: err.message || 'Invalid notification channel.', code: 400 });
    }
  });

  router.delete('/channels/:id', (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid channel id.', code: 400 });
      const deleted = store.deleteChannel(id);
      if (!deleted) return res.status(404).json({ error: 'Notification channel not found.', code: 404 });
      res.json({ data: { deleted: true } });
    } catch (err) {
      log.error('Error deleting notification channel:', err.message);
      res.status(500).json({ error: 'Internal error.', code: 500 });
    }
  });

  router.post('/channels/:id/test', async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid channel id.', code: 400 });
      const channel = store.getChannel(id, { includeSecrets: true });
      if (!channel) return res.status(404).json({ error: 'Notification channel not found.', code: 404 });
      const payload = {
        title: 'Yuvomi',
        body: 'Yuvomi notification test',
        url: '/settings/personal/notifications',
        tag: `notification-channel-test-${id}`,
        priority: 'default',
      };
      const result = await notificationService.testChannel({ channel, payload });
      store.markChannelTestResult(id, { ok: true });
      res.json({ data: result });
    } catch (err) {
      log.error('Error testing notification channel:', err.message);
      const id = parseId(req.params.id);
      if (id) store.markChannelTestResult(id, { ok: false, error: err.message });
      res.status(500).json({ error: 'Internal error.', code: 500 });
    }
  });

  return router;
}

export default buildRouter();
