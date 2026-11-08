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
import { NotificationProviderError } from '../services/notification-providers/provider-error.js';
import { remoteFailure } from '../utils/http.js';

const log = createLogger('NotificationRoutes');

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Diese Routen verwalten nur Haushaltskanaele. Ein Kanal mit `scope = 'user'`
// hoert auch die privaten Erinnerungen seiner Person, und vor dem Admin verbirgt
// `private` sie gerade (DECISIONS 1, services/notifications.js). Deshalb kommt
// aus dem Body nur durch, was ein Haushaltskanal braucht: eine Allowlist, damit
// keine Schreibweise von Besitzer oder Reichweite den Store erreicht. Die
// Zustellung an persoenliche Kanaele bleibt davon unberuehrt.
/**
 * What a failed channel test stores as `last_error`: a provider's own sentence,
 * the code of a network error, or a fixed sentence (Phase 0 section H).
 */
function storedTestError(err) {
  if (err instanceof NotificationProviderError) return err.message;
  const failure = remoteFailure(err);
  if (failure?.reason === 'remote_unreachable') return failure.detail;
  return 'The test notification could not be delivered.';
}

function householdChannelInput(body) {
  const { provider, name, enabled, config, secrets, clearSecrets } = body || {};
  return { provider, name, enabled, config, secrets, clearSecrets };
}

/**
 * Validation and the database used to share one catch that sent every message
 * as a 400 - SQLite's included (Phase 0 section H). The channel checks mark
 * their own sentences (`notification_channel_invalid`); everything else is a
 * fixed 500 and goes into the log.
 */
function sendChannelWriteFailure(res, err) {
  if (err?.code === 'notification_channel_invalid') return res.status(400).json({ error: err.message, code: 400 });
  log.error('Error writing notification channel:', err);
  return res.status(500).json({ error: 'Internal error.', code: 500 });
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
      const channel = store.createChannel(householdChannelInput(req.body));
      res.status(201).json({ data: channel });
    } catch (err) {
      sendChannelWriteFailure(res, err);
    }
  });

  router.put('/channels/:id', (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid channel id.', code: 400 });
      const existing = store.getChannel(id);
      if (!existing) return res.status(404).json({ error: 'Notification channel not found.', code: 404 });
      // Neue Daten fuer einen persoenlichen Kanal hiessen: ein Admin bestimmt, wohin
      // die privaten Erinnerungen dieser Person gehen. Loeschen bleibt moeglich.
      if (existing.scope !== 'household') {
        return res.status(409).json({ error: 'Only household notification channels can be changed here.', code: 409 });
      }
      const channel = store.updateChannel(id, householdChannelInput(req.body));
      res.json({ data: channel });
    } catch (err) {
      sendChannelWriteFailure(res, err);
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
      // Stored as the channel's `last_error` and listed to the admin. The
      // providers' own sentences ("Webhook authentication failed.") stay; a
      // network error is stored as its code, anything else - nodemailer's
      // "Invalid login: 535 ...", a TypeError - as a fixed sentence. Their text
      // names host, port or the server's reply (Phase 0 section H).
      if (id) store.markChannelTestResult(id, { ok: false, error: storedTestError(err) });
      res.status(500).json({ error: 'Internal error.', code: 500 });
    }
  });

  return router;
}

export default buildRouter();
