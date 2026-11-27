/** Translate only known Paperless failures; unexpected failures reach the central handler. */
import { RefusedNowError } from './gate-now.js';
import { createLogger } from '../logger.js';
import { PaperlessHttpError } from '../services/dms/paperless-errors.js';
import { PaperlessViewError } from '../services/dms/paperless-views.js';

const log = createLogger('Paperless');
/** @type {import('../utils/http-router.ts').ErrorHandler} */
export function paperlessErrorHandler(err, _req, res, next) {
  if (err instanceof RefusedNowError) return err.respond(res);
  if (err instanceof PaperlessViewError) err = new PaperlessHttpError(422, { reason: 'paperless_view_unsupported' });
  if (!(err instanceof PaperlessHttpError)) return next(err);
  const { httpStatus: status, reason } = err;
  log.warn(`Paperless operation failed (status ${status}).`);
  if (status === 403 && !['paperless_personal_token_required', 'paperless_dms_forbidden'].includes(reason)) {
    return res.status(403).json({ error: 'Permission denied.', code: 403 });
  }
  return res.status(status).json({ error: reason, reason, code: status });
}
