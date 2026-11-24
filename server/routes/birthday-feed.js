import express from 'express';
import * as db from '../db.js';
import * as feed from '../services/birthday-ics.js';
import { getUserId } from './calendar/helpers.js';
import { createLogger } from '../logger.js';
import { validateRequest } from '../api/validate-request.ts';

const router = express.Router();
const log = createLogger('BirthdayFeed');
function feedUrl(req, token) {
  const base = process.env.BASE_URL?.replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;
  return `${base}/feed/birthdays/${token}.ics`;
}
router.get('/', validateRequest(), (req, res) => {
  try {
    const token = feed.getFeedToken(db.get(), getUserId(req));
    res.json({ data: token ? { token, url: feedUrl(req, token) } : null });
  } catch (err) {
    log.error('GET /birthdays/feed', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});
router.post('/regenerate', validateRequest(), (req, res) => {
  try {
    const token = feed.regenerateFeedToken(db.get(), getUserId(req));
    res.json({ data: { token, url: feedUrl(req, token) } });
  } catch (err) {
    log.error('POST /birthdays/feed/regenerate', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});
router.delete('/', validateRequest(), (req, res) => {
  try {
    feed.clearFeedToken(db.get(), getUserId(req));
    res.json({ data: { token: null } });
  } catch (err) {
    log.error('DELETE /birthdays/feed', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});
export default router;
