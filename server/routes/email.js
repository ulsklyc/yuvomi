/**
 * Modul: Email-Routen (Admin)
 * Zweck: SMTP-Konfiguration lesen/schreiben (passwortsicher) und Testmail senden.
 * Abhängigkeiten: express, server/db.js, server/services/email.js
 */
import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { emailService as defaultEmailService } from '../services/email.js';

const log = createLogger('EmailRoutes');

const VALID_SECURE = new Set(['ssl', 'starttls', 'none']);

const FIELD_KEYS = {
  host: 'email_smtp_host',
  port: 'email_smtp_port',
  secure: 'email_smtp_secure',
  user: 'email_smtp_user',
  fromAddress: 'email_from_address',
  fromName: 'email_from_name',
};

// Default email resolver: the requesting user's linked contact email.
function defaultResolveUserEmail(getDb, userId) {
  const row = getDb().prepare(
    'SELECT email FROM contacts WHERE family_user_id = ? AND email IS NOT NULL AND email != \'\' LIMIT 1'
  ).get(userId);
  return row?.email || null;
}

export function buildRouter({ database, emailService = defaultEmailService, resolveUserEmail } = {}) {
  const getDb = () => (database || db.get());
  const router = express.Router();

  function requireAdmin(req, res, next) {
    // requireAuth (server/auth.js) populates req.authRole for both session and API-token auth.
    if (req.authRole !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.', code: 403 });
    }
    next();
  }

  function cfgSet(key, value) {
    getDb().prepare(`INSERT INTO sync_config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  }

  router.get('/config', requireAdmin, (req, res) => {
    try {
      res.json({ data: emailService.getPublicConfig() });
    } catch (err) {
      log.error('Error reading email config:', err.message);
      res.status(500).json({ error: 'Internal error.', code: 500 });
    }
  });

  router.put('/config', requireAdmin, (req, res) => {
    try {
      const body = req.body || {};
      if (body.secure !== undefined && !VALID_SECURE.has(String(body.secure))) {
        return res.status(400).json({ error: 'Invalid secure value.', code: 400 });
      }
      for (const [field, key] of Object.entries(FIELD_KEYS)) {
        if (body[field] === undefined) continue;
        cfgSet(key, String(body[field] ?? '').trim());
      }
      // Password is write-only: only change it when explicitly provided.
      if (typeof body.pass === 'string' && body.pass !== '') {
        cfgSet('email_smtp_pass', body.pass);
      } else if (body.clearPassword === true) {
        cfgSet('email_smtp_pass', '');
      }
      res.json({ data: emailService.getPublicConfig() });
    } catch (err) {
      log.error('Error saving email config:', err.message);
      res.status(500).json({ error: 'Internal error.', code: 500 });
    }
  });

  router.post('/test', requireAdmin, async (req, res) => {
    try {
      const resolver = resolveUserEmail || ((uid) => defaultResolveUserEmail(getDb, uid));
      const to = (typeof req.body?.to === 'string' && req.body.to.trim())
        ? req.body.to.trim()
        : resolver(req.authUserId);
      if (!to) {
        return res.status(400).json({ error: 'No recipient email available for this account.', code: 400 });
      }
      const result = await emailService.sendTest(to);
      res.json({ data: result });
    } catch (err) {
      log.error('Error sending test email:', err.message);
      res.status(500).json({ error: 'Internal error.', code: 500 });
    }
  });

  return router;
}

export default buildRouter();
