/**
 * Modul: Notification-Routen (Admin)
 * Zweck: Notification-Channels verwalten und Testbenachrichtigungen senden.
 * Abhaengigkeiten: express, notification-channels.js, notifications.js
 */
import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { validateRequest } from '../api/validate-request.ts';
import { createNotificationChannelStore, NOTIFICATION_PROVIDERS, PRIVATE_NETWORK_MESSAGE } from '../services/notification-channels.js';
import { notificationService as defaultNotificationService } from '../services/notifications.js';
import { NotificationProviderError } from '../services/notification-providers/provider-error.js';
import { ENV_ALLOW_PRIVATE_NETWORK } from '../services/notification-providers/guarded-fetch.js';
import { remoteFailure } from '../utils/http.js';
import { BlockedAddressError } from '../utils/ssrf.js';

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
  // The deployment's refusal says what to do, like the answer (#2837).
  if (err instanceof BlockedAddressError) return PRIVATE_NETWORK_MESSAGE;
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
 * their own sentences (`notification_channel_invalid`); everything else goes
 * on to the central error handler, which logs it and answers 500 with its fixed
 * sentence (#2810). A URL in a private network carries its case as well, so
 * the page can name the switch in the admin's language (#2837).
 */
function sendChannelWriteFailure(res, err) {
  if (err?.code === 'notification_channel_invalid' && err.reason === 'notifications_private_network') {
    return res.status(400).json({ error: PRIVATE_NETWORK_MESSAGE, code: 400, reason: 'notifications_private_network' });
  }
  if (err?.code === 'notification_channel_invalid') return res.status(400).json({ error: err.message, code: 400 });
  throw err;
}

export function buildRouter({
  database,
  channelStore,
  notificationService = defaultNotificationService,
} = {}) {
  const getDb = () => (database || db.get());
  const store = channelStore || createNotificationChannelStore({ db: getDb() });
  const router = express.Router();

  // The admin gate first: a member gets 403, never a 400 that names fields (#2810).
  router.use(requireAdmin);

  // A route answers only what it expects (a refused input, not found, a
  // personal channel); an unexpected error goes on to the central error
  // handler: 500 with its fixed sentence, logged with method and route (#2810).
  router.get('/providers', validateRequest(), (req, res) => {
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
  });

  router.get('/channels', validateRequest(), (req, res) => {
    void req;
    res.json({ data: store.listChannels() });
  });

  router.post('/channels', validateRequest(), (req, res) => {
    try {
      const channel = store.createChannel(householdChannelInput(req.body));
      res.status(201).json({ data: channel });
    } catch (err) {
      sendChannelWriteFailure(res, err);
    }
  });

  router.put('/channels/:id', validateRequest(), (req, res) => {
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

  router.delete('/channels/:id', validateRequest(), (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid channel id.', code: 400 });
    const deleted = store.deleteChannel(id);
    if (!deleted) return res.status(404).json({ error: 'Notification channel not found.', code: 404 });
    res.json({ data: { deleted: true } });
  });

  router.post('/channels/:id/test', validateRequest(), async (req, res) => {
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
      const id = parseId(req.params.id);
      // Stored as the channel's `last_error` and listed to the admin. The
      // providers' own sentences ("Webhook authentication failed.") stay; a
      // network error is stored as its code, anything else - nodemailer's
      // "Invalid login: 535 ...", a TypeError - as a fixed sentence. Their text
      // names host, port or the server's reply (Phase 0 section H). Except for
      // the case below, the answer and the log line are the central error
      // handler's.
      if (id) store.markChannelTestResult(id, { ok: false, error: storedTestError(err) });
      // A host name that resolves into a private network passes the save (that
      // check needs no DNS) and meets the lookup only here. That is the refusal
      // the save gives for an IP literal, not a failure of this server: until
      // #2837 it went on as a 500 "Internal server error." with an "Unhandled
      // error" in the log, and the switch that allows it was named nowhere.
      if (err instanceof BlockedAddressError) {
        log.warn(`Channel test refused: the URL resolves to a private or local network address and ${ENV_ALLOW_PRIVATE_NETWORK} is not set.`);
        return res.status(400).json({ error: PRIVATE_NETWORK_MESSAGE, code: 400, reason: 'notifications_private_network' });
      }
      throw err;
    }
  });

  return router;
}

export default buildRouter();
