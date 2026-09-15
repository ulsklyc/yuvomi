/**
 * Module: Third-party modules API
 * Purpose: Authenticated discovery, admin toggles, and protected module asset delivery.
 * Dependencies: express, server/services/modules.js
 */

import express from 'express';
import path from 'node:path';
import { requireAdmin } from '../auth.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import { createLogger } from '../logger.js';
import { MODULES_DIR, listModules, resolveAssetPath, setModuleEnabled } from '../services/modules.js';

const router = express.Router();
const log = createLogger('Modules');

router.get('/', async (req, res) => {
  try {
    const admin = isAdminRequest(req) && req.query.admin === '1';
    const modules = await listModules({ admin });
    res.json({ data: modules });
  } catch (err) {
    log.error('Module list failed:', err);
    res.status(500).json({ error: 'Module list failed.', code: 500 });
  }
});

router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean.', code: 400 });
    }
    const module = await setModuleEnabled(req.params.id, req.body.enabled);
    res.json({ data: module });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) log.error('Module update failed:', err);
    res.status(status).json({ error: err.message || 'Module update failed.', code: status });
  }
});

router.get('/assets/:id/{*assetPath}', async (req, res) => {
  try {
    const relPath = Array.isArray(req.params.assetPath)
      ? req.params.assetPath.join('/')
      : String(req.params.assetPath || '');
    const assetPath = await resolveAssetPath(req.params.id, relPath);
    const ext = path.extname(assetPath).toLowerCase();
    if (ext === '.js') res.type('text/javascript');
    else if (ext === '.css') res.type('text/css');
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    // root-Option statt absolutem Pfad: sendFile ohne root laesst `send` JEDES
    // Segment des absoluten Pfads auf Dotfiles pruefen - liegt MODULES_DIR unter
    // einem Dot-Verzeichnis (z. B. ~/.claude/...), wuerde jedes Asset 500 liefern.
    // Mit root prueft `send` nur den relativen Teil; resolveAssetPath hat den
    // Pfad bereits validiert (Traversal-Schutz, Existenz, Confinement).
    const moduleRoot = path.join(MODULES_DIR, req.params.id);
    res.sendFile(path.relative(moduleRoot, assetPath), { root: moduleRoot });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) log.error('Module asset failed:', err);
    res.status(status).json({ error: err.message || 'Module asset failed.', code: status });
  }
});

export default router;
