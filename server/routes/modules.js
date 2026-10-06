/**
 * Module: Third-party modules API
 * Purpose: Authenticated discovery, admin toggles, protected module asset delivery,
 *          and admin-only install/delete from Settings (ZIP upload or GitHub URL) -
 *          the latter only where the operator set MODULES_ALLOW_WEB_INSTALL, and
 *          enabling a module only from a browser session (DECISIONS.md, 12).
 * Dependencies: express, express-rate-limit, server/services/modules.js,
 *               server/services/module-install.js, server/services/module-github.js
 */

import express from 'express';
import path from 'node:path';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { requireAdmin } from '../auth.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import { createLogger } from '../logger.js';
import { MODULES_DIR, listModules, resolveAssetPath, setModuleEnabled } from '../services/modules.js';
import {
  InstallError,
  MAX_ZIP_MB,
  WEB_INSTALL_ENV,
  deleteModule,
  installFilesUnlocked,
  installFromZip,
  isPersistent,
  isWebInstallEnabled,
  isWritable,
  unpackArchive,
  withInstallLock,
} from '../services/module-install.js';
import { createGithubInstaller } from '../services/module-github.js';

const router = express.Router();
const log = createLogger('Modules');

// Installing a module downloads or unpacks up to 20 MB and writes it to disk.
// The global API limiter (300/min) is sized for reading lists, not for that;
// ten installs in ten minutes is more than any admin needs by hand and keeps a
// stolen session or a script from turning the server into a download loop.
// Keyed per user (the route sits behind requireAuth), IP only as a fallback.
const installLimiter = rateLimit({
  windowMs: 10 * 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.authUserId ? `user:${req.authUserId}` : ipKeyGenerator(req.ip || '')),
  // The two answers that are a question back to the admin do not count: 409
  // (already installed - replace?) and 422 (several modules - which one?) are
  // half of one install, and an admin answering them should not burn the
  // budget. Everything else counts, failures included: a typo'd URL or a
  // broken ZIP still cost a download or an unpack. In express-rate-limit v8,
  // skipFailedRequests takes the hit back for every request this function
  // calls unsuccessful (and for one the client aborted before the answer).
  skipFailedRequests: true,
  requestWasSuccessful: (_req, res) => ![409, 422].includes(res.statusCode),
  // Its own reason: GitHub's `rate_limited` means "GitHub refuses this server
  // for a while", this one means "you installed a lot" - the UI says different
  // things for the two.
  message: { error: 'Too many module installs. Please wait a few minutes.', code: 429, reason: 'install_rate_limited' },
});

/**
 * The operator's switch (DECISIONS.md, 12): installing and deleting from
 * Settings exist only where MODULES_ALLOW_WEB_INSTALL is set. First in the
 * chain and before the body is read, so a shut installation never takes the
 * 20 MB upload it would then refuse. GET /install/info stays open and reports
 * `webInstall: false`, which is how the page learns to show the manual way.
 */
function requireWebInstall(_req, res, next) {
  if (isWebInstallEnabled()) return next();
  return res.status(403).json({
    error: `Installing modules from Settings is switched off on this server. The operator can turn it on with ${WEB_INSTALL_ENV}=true.`,
    code: 403,
    reason: 'module_web_install_disabled',
  });
}

/**
 * Install, delete and ENABLE only from a signed-in browser session.
 *
 * Installing a module puts same-origin JavaScript in front of every member;
 * enabling one is the step that makes it live, and deleting one is
 * irreversible. An admin API token is a long-lived secret that lives in
 * scripts, CI and MCP clients (the MCP bridge calls this API with the client's
 * token), and a leaked one should not be able to plant code in the household
 * or switch planted code on. The browser path also carries CSRF protection and
 * 2FA at sign-in. Checked before the body is read, so a refused request never
 * uploads 20 MB. Disabling by token stays allowed: taking code away is the
 * safe direction.
 */
function sessionRefusal(res, what) {
  return res.status(403).json({
    error: `${what} is only possible from a signed-in browser session, not with an API token.`,
    code: 403,
    reason: 'module_session_required',
  });
}

function requireBrowserSession(req, res, next) {
  if (req.authMethod === 'session') return next();
  return sessionRefusal(res, 'Installing or deleting modules');
}

const zipBodyParser = express.raw({
  type: ['application/zip', 'application/octet-stream', 'application/x-zip-compressed'],
  limit: `${MAX_ZIP_MB}mb`,
});

// Handled here and not by the global body-error handler: that one names
// MAX_UPLOAD_MB, which is the document limit, not the archive limit.
// Every body-parser failure gets a stable reason here too; passed on, they
// would reach the global handler and come back without one.
function parseZipBody(req, res, next) {
  zipBodyParser(req, res, (err) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') {
      return res.status(413).json({
        error: `The module archive is too large. The limit is ${MAX_ZIP_MB} MB.`,
        code: 413,
        reason: 'too_large',
      });
    }
    if (err.type === 'encoding.unsupported') {
      return res.status(415).json({
        error: 'The upload uses a Content-Encoding the server does not accept. Send the ZIP file as it is.',
        code: 415,
        reason: 'unsupported_encoding',
      });
    }
    if (err.type === 'request.aborted' || err.type === 'request.size.invalid') {
      return res.status(400).json({ error: 'The upload was incomplete.', code: 400, reason: 'corrupt' });
    }
    return next(err);
  });
}

function sendInstallError(res, err, fallback) {
  if (err instanceof InstallError) {
    return res.status(err.status).json({ error: err.message, code: err.status, reason: err.reason, ...err.extra });
  }
  log.error(`${fallback}:`, err);
  return res.status(500).json({ error: `${fallback}.`, code: 500 });
}

function wantsOverwrite(value) {
  return value === true || value === '1' || value === 'true';
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

// For `path` an empty string is a value: it selects the module at the archive
// root (see locateModule). Only a missing or non-string value means "not given".
function pathOption(value) {
  return typeof value === 'string' ? value : undefined;
}

// The module arrives disabled either way (`data.install.approved` is false);
// there is no field for it because there is no case in which it is not so.
function installBody(result) {
  return { data: result.module, replaced: result.replaced, skipped: result.skipped };
}

// Static /install/* paths before any /:id route.
router.get('/install/info', requireAdmin, async (_req, res) => {
  try {
    const [writable, persistent] = await Promise.all([isWritable(), isPersistent()]);
    res.json({ data: { writable, persistent, webInstall: isWebInstallEnabled(), maxZipMb: MAX_ZIP_MB } });
  } catch (err) {
    log.error('Module install info failed:', err);
    res.status(500).json({ error: 'Module install info failed.', code: 500 });
  }
});

router.post('/install/zip', requireAdmin, requireWebInstall, requireBrowserSession, installLimiter, parseZipBody, async (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new InstallError('not_zip', 'Send the module ZIP file as the request body with Content-Type application/zip.');
    }
    const result = await installFromZip(req.body, {
      overwrite: wantsOverwrite(req.query.overwrite),
      path: pathOption(req.query.path),
      userId: req.authUserId,
    });
    res.status(201).json(installBody(result));
  } catch (err) {
    sendInstallError(res, err, 'Module install failed');
  }
});

router.post('/install/github', requireAdmin, requireWebInstall, requireBrowserSession, installLimiter, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (typeof body.url !== 'string' || !body.url.trim()) {
      throw new InstallError('bad_url', 'Enter a GitHub repository URL such as https://github.com/owner/repo.');
    }
    const result = await withInstallLock(async () => {
      const gh = await createGithubInstaller().fetchArchive(body.url, {
        ref: optionalString(body.ref),
        path: pathOption(body.path),
      });
      const { files, comment } = unpackArchive(gh.buffer);
      // GitHub writes the commit SHA as the zipball's archive comment. Optional:
      // a missing or odd comment only means the details view shows no commit.
      const commit = /^[0-9a-f]{40}$/i.test(comment.trim()) ? comment.trim().toLowerCase() : null;
      return installFilesUnlocked(files, {
        source: 'github',
        overwrite: wantsOverwrite(body.overwrite),
        // null = nobody named a folder: let the installer look for the module.
        path: gh.path ?? undefined,
        userId: req.authUserId,
        meta: { url: gh.url, ref: gh.ref, commit },
      });
    });
    res.status(201).json(installBody(result));
  } catch (err) {
    sendInstallError(res, err, 'Module install failed');
  }
});

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
    // Only the ON direction needs the session: it is the approval that makes
    // installed code live (see requireBrowserSession). Not a middleware, because
    // the direction is in the body.
    if (req.body.enabled && req.authMethod !== 'session') {
      return sessionRefusal(res, 'Enabling a module');
    }
    const module = await setModuleEnabled(req.params.id, req.body.enabled);
    res.json({ data: module });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) log.error('Module update failed:', err);
    res.status(status).json({ error: err.message || 'Module update failed.', code: status });
  }
});

router.delete('/:id', requireAdmin, requireWebInstall, requireBrowserSession, async (req, res) => {
  try {
    const result = await deleteModule(req.params.id, { userId: req.authUserId });
    res.json({ data: result });
  } catch (err) {
    sendInstallError(res, err, 'Module delete failed');
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
