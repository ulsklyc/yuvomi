import express from 'express';
import { requireAdmin } from '../auth.js';
import { createLogger } from '../logger.js';
import * as googleDriveStorage from '../services/google-drive-storage.js';

const log = createLogger('GoogleDriveStorageRoutes');
const router = express.Router();
const SETTINGS_URL = '/settings/documents/storage';

function sendStorageError(res, error) {
  const storageCode = error?.storageCode;
  const status = storageCode === 'DOCUMENT_STORAGE_CONFIG_PROTECTED'
    ? 409
    : (
        storageCode === 'DOCUMENT_STORAGE_INVALID_CONFIG'
        || storageCode === 'DOCUMENT_STORAGE_NOT_CONFIGURED'
      )
      ? 400
      : 502;
  return res.status(status).json({
    error: error?.message || 'Google Drive document storage operation failed.',
    code: status,
    storage_code: storageCode || 'DOCUMENT_STORAGE_OPERATION_FAILED',
  });
}

router.get('/auth', requireAdmin, (req, res) => {
  try {
    res.redirect(googleDriveStorage.getAuthUrl(req.session));
  } catch (error) {
    log.error('GET /auth error:', error);
    sendStorageError(res, error);
  }
});

router.get('/callback', requireAdmin, async (req, res) => {
  const { code, error, state } = req.query;
  if (error || !code) {
    delete req.session.googleDriveOAuthState;
    return res.redirect(`${SETTINGS_URL}?drive_error=1`);
  }
  if (
    !state
    || !req.session.googleDriveOAuthState
    || state !== req.session.googleDriveOAuthState
  ) {
    delete req.session.googleDriveOAuthState;
    log.error('OAuth state mismatch');
    return res.redirect(`${SETTINGS_URL}?drive_error=1`);
  }
  delete req.session.googleDriveOAuthState;

  try {
    await googleDriveStorage.handleCallback(code);
    return res.redirect(`${SETTINGS_URL}?drive_ok=1`);
  } catch (callbackError) {
    log.error('GET /callback error:', callbackError);
    return res.redirect(`${SETTINGS_URL}?drive_error=1`);
  }
});

router.post('/test', requireAdmin, async (_req, res) => {
  try {
    const data = await googleDriveStorage.testConnection();
    res.json({ data });
  } catch (error) {
    log.error('POST /test error:', error);
    sendStorageError(res, error);
  }
});

router.delete('/disconnect', requireAdmin, (req, res) => {
  try {
    googleDriveStorage.disconnect();
    res.json({ data: googleDriveStorage.getStatus() });
  } catch (error) {
    log.error('DELETE /disconnect error:', error);
    sendStorageError(res, error);
  }
});

export default router;
