/**
 * Modul: Email-Routen (Admin)
 * Zweck: SMTP-Konfiguration lesen/schreiben (passwortsicher) und Testmail senden.
 * Abhängigkeiten: express, server/db.js, server/services/email.js
 */
import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import { emailService as defaultEmailService } from '../services/email.js';

const log = createLogger('EmailRoutes');

const VALID_SECURE = new Set(['ssl', 'starttls', 'none']);

/**
 * Was die Seite vor dem Speichern prueft, prueft der Server auch
 * (Re-Critique 2026-10-17): Port 99999 und der Absender "keine-mail" wurden mit
 * "gespeichert" quittiert und scheiterten erst beim ersten Versand. Der Port ist
 * eine ganze Zahl von 1 bis 65535, der Absender leer oder eine Adresse mit
 * genau einem @ und Text davor und danach - ohne Punktpflicht, weil ein
 * selbst betriebener Mailserver auch "yuvomi@nas" annimmt. Dieselbe Lesart
 * wie die Seite.
 */
const PORT_MIN = 1;
const PORT_MAX = 65535;
const FROM_ADDRESS_RE = /^[^\s@]+@[^\s@]+$/;

export function emailConfigRefusal(body) {
  if (body.port !== undefined && body.port !== null && body.port !== '') {
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
      return { reason: 'email_port_invalid', error: `Port must be a whole number from ${PORT_MIN} to ${PORT_MAX}.` };
    }
  }
  if (body.fromAddress !== undefined && body.fromAddress !== null) {
    const from = String(body.fromAddress).trim();
    if (from !== '' && !FROM_ADDRESS_RE.test(from)) {
      return { reason: 'email_from_invalid', error: 'Sender address must be an e-mail address.' };
    }
  }
  return null;
}

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
    if (!isAdminRequest(req)) {
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
      const refusal = emailConfigRefusal(body);
      if (refusal) return res.status(400).json({ error: refusal.error, code: 400, reason: refusal.reason });
      // Ein env-gesteuertes Feld wird NICHT in die Datenbank geschrieben. Der
      // Wert wirkte ohnehin nicht (env gewinnt, services/email.js:resolve), und
      // gespeichert wäre er eine Zeitbombe: er würde in dem Moment aktiv, in dem
      // jemand die Umgebungsvariable entfernt.
      const locked = field => emailService.isEnvControlled?.(field) === true;
      for (const [field, key] of Object.entries(FIELD_KEYS)) {
        if (body[field] === undefined || locked(field)) continue;
        cfgSet(key, String(body[field] ?? '').trim());
      }
      // Password is write-only: only change it when explicitly provided.
      if (locked('pass')) {
        // nichts tun: EMAIL_SMTP_PASS kommt aus der Umgebung
      } else if (typeof body.pass === 'string' && body.pass !== '') {
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
        // Die Testmail geht an die eigene Adresse aus Konto -> E-Mail; der
        // Grund laesst die Seite genau dorthin verweisen.
        return res.status(400).json({ error: 'No recipient email available for this account.', code: 400, reason: 'email_no_recipient' });
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
