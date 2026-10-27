/**
 * Modul: Kalender (Calendar) - ICS-Export-Feed + Feiertage
 */

import { createLogger } from '../../logger.js';
import express from 'express';
import * as db from '../../db.js';
import * as icsExport from '../../services/ics-export.js';
import * as holidays from '../../services/holidays.js';
import { getUserId, feedUrl } from './helpers.js';

const log = createLogger('Calendar');
const router = express.Router();

// GET /api/v1/calendar/feed → aktueller Feed-Status
router.get('/feed', (req, res) => {
  try {
    const token = icsExport.getFeedToken(db.get(), getUserId(req));
    if (!token) return res.json({ data: null });
    const showAssignees = icsExport.getFeedShowAssignees(db.get(), getUserId(req));
    const includeBirthdays = icsExport.getFeedIncludeBirthdays(db.get(), getUserId(req));
    res.json({ data: { token, url: feedUrl(req, token), showAssignees, includeBirthdays } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// PUT /api/v1/calendar/feed → personal feed options (#482, D#1965)
router.put('/feed', (req, res) => {
  try {
    const { showAssignees, includeBirthdays } = req.body ?? {};
    if ((showAssignees === undefined && includeBirthdays === undefined)
        || (showAssignees !== undefined && typeof showAssignees !== 'boolean')
        || (includeBirthdays !== undefined && typeof includeBirthdays !== 'boolean')) {
      return res.status(400).json({ error: 'showAssignees or includeBirthdays (boolean) required.', code: 400 });
    }
    const database = db.get();
    const userId = getUserId(req);
    const data = database.transaction(() => {
      if (showAssignees !== undefined) icsExport.setFeedShowAssignees(database, userId, showAssignees);
      if (includeBirthdays !== undefined) icsExport.setFeedIncludeBirthdays(database, userId, includeBirthdays);
      return { showAssignees: icsExport.getFeedShowAssignees(database, userId),
        includeBirthdays: icsExport.getFeedIncludeBirthdays(database, userId) };
    })();
    res.json({ data });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// POST /api/v1/calendar/feed/regenerate → neuen Token erzeugen
router.post('/feed/regenerate', (req, res) => {
  try {
    const token = icsExport.regenerateFeedToken(db.get(), getUserId(req));
    res.json({ data: { token, url: feedUrl(req, token) } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// DELETE /api/v1/calendar/feed → Feed deaktivieren
router.delete('/feed', (req, res) => {
  try {
    icsExport.clearFeedToken(db.get(), getUserId(req));
    res.json({ data: { token: null } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/calendar/holidays?from=YYYY-MM-DD&to=YYYY-MM-DD
// Muss VOR /:id stehen, damit "holidays" nicht als ID-Parameter interpretiert wird.
// ---------------------------------------------------------------------------
router.get('/holidays', (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: 'Query params from and to (YYYY-MM-DD) required.', code: 400 });
    }
    const data = holidays.getForRange(from, to);
    res.json({ data });
  } catch (err) {
    log.error('GET /holidays', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
