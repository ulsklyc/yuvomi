import express from 'express';
import * as db from '../db.js';
import * as feed from '../services/birthday-ics.js';
import { getUserId } from './calendar/helpers.js';
import { validateRequest } from '../api/validate-request.ts';

const router = express.Router();
function feedUrl(req, token) {
  const base = process.env.BASE_URL?.replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;
  return `${base}/feed/birthdays/${token}.ics`;
}
router.get('/', validateRequest(), (req, res) => {
  const token = feed.getFeedToken(db.get(), getUserId(req));
  res.json({ data: token ? { token, url: feedUrl(req, token) } : null });
});
router.post('/regenerate', validateRequest(), (req, res) => {
  const token = feed.regenerateFeedToken(db.get(), getUserId(req));
  res.json({ data: { token, url: feedUrl(req, token) } });
});
router.delete('/', validateRequest(), (req, res) => {
  feed.clearFeedToken(db.get(), getUserId(req));
  res.json({ data: { token: null } });
});
export default router;
