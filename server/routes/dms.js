/**
 * Module: DMS Integration Routes
 * Purpose: Manage DMS connections (admin) and proxy search/link/upload against a DMS.
 * Dependencies: express, server/db.js, server/services/dms/index.js
 */
import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { str, MAX_TITLE } from '../middleware/validate.js';
import { SUPPORTED_PROVIDERS } from '../services/dms/index.js';

const log = createLogger('DMS');
const router = express.Router();

function userId(req) { return req.authUserId || req.session?.userId; }
function isAdmin(req) { return req.authRole === 'admin' || req.session?.role === 'admin'; }

function publicAccount(row) {
  if (!row) return null;
  const { api_token, ...rest } = row;
  return { ...rest, has_token: Boolean(api_token) };
}

function getAccount(id) {
  return db.get().prepare('SELECT * FROM dms_accounts WHERE id = ?').get(id);
}

router.get('/accounts', (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    const rows = db.get().prepare('SELECT * FROM dms_accounts ORDER BY name COLLATE NOCASE').all();
    res.json({ data: rows.map(publicAccount) });
  } catch (err) {
    log.error('GET /accounts error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/accounts', (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    const provider = SUPPORTED_PROVIDERS.includes(req.body.provider) ? req.body.provider : 'paperless';
    const vName = str(req.body.name, 'Name', { max: MAX_TITLE });
    const vUrl = str(req.body.base_url, 'Base URL', { max: 500 });
    const vToken = str(req.body.api_token, 'API token', { max: 500 });
    for (const v of [vName, vUrl, vToken]) if (v.error) return res.status(400).json({ error: v.error, code: 400 });
    if (!/^https?:\/\//i.test(vUrl.value)) return res.status(400).json({ error: 'Base URL must start with http(s)://', code: 400 });

    const result = db.get().prepare(`
      INSERT INTO dms_accounts (provider, name, base_url, api_token) VALUES (?, ?, ?, ?)
    `).run(provider, vName.value, vUrl.value.replace(/\/+$/, ''), vToken.value);
    res.status(201).json({ data: publicAccount(getAccount(result.lastInsertRowid)) });
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'A DMS account with this URL already exists.', code: 409 });
    }
    log.error('POST /accounts error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.delete('/accounts/:id', (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    const id = Number(req.params.id);
    const existing = getAccount(id);
    if (!existing) return res.status(404).json({ error: 'DMS account not found.', code: 404 });
    db.get().prepare('DELETE FROM dms_accounts WHERE id = ?').run(id);
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /accounts/:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
