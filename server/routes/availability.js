/**
 * Module: Availability
 * Purpose: Per-user availability status (#1591). Each household member can set
 *          their own state (available / busy / do_not_disturb / away) with an
 *          optional note and an expiry time. The status is visible to all
 *          household members via the family widget on the dashboard.
 * Routes:
 *   GET  /api/v1/availability        → all current statuses for the household
 *   PUT  /api/v1/availability        → set / update own status
 *   DELETE /api/v1/availability      → clear own status
 */

import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { householdMemberSql } from '../services/household-members.js';

const log = createLogger('Availability');
const router = express.Router();

const VALID_STATES = ['available', 'busy', 'do_not_disturb', 'away'];

/** Alle aktuellen (noch nicht abgelaufenen) Verfuegbarkeitsstati im Haushalt. */
function getAllStatuses() {
  return db.get().prepare(`
    SELECT a.user_id,
           a.state,
           a.note,
           a.expires_at,
           a.set_at
    FROM user_availability a
    JOIN users u ON u.id = a.user_id
    WHERE ${householdMemberSql('u')}
      AND a.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    ORDER BY a.set_at DESC
  `).all();
}

/** GET /api/v1/availability — Haushaltsliste aller aktiven Stati. */
router.get('/', (req, res) => {
  try {
    res.json({ data: getAllStatuses() });
  } catch (err) {
    log.error('GET /availability error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/** PUT /api/v1/availability — eigenen Status setzen oder aktualisieren.
 *  Body: { state, note?, expires_at }
 *  - state: 'available' | 'busy' | 'do_not_disturb' | 'away'
 *  - note: optionaler Freitext (max 200 Zeichen)
 *  - expires_at: ISO-8601-UTC-Zeitstempel (muss in der Zukunft liegen)
 */
router.put('/', (req, res) => {
  try {
    const userId = req.authUserId;
    const { state, note, expires_at } = req.body ?? {};

    if (!VALID_STATES.includes(state)) {
      return res.status(400).json({
        error: `state must be one of: ${VALID_STATES.join(', ')}.`,
        code: 400,
      });
    }
    if (note != null && (typeof note !== 'string' || note.length > 200)) {
      return res.status(400).json({ error: 'note must be a string of at most 200 characters.', code: 400 });
    }
    if (!expires_at || typeof expires_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(expires_at)) {
      return res.status(400).json({ error: 'expires_at must be an ISO-8601 UTC timestamp (YYYY-MM-DDTHH:MM:SSZ).', code: 400 });
    }
    const nowCheck = db.get().prepare(
      `SELECT strftime('%Y-%m-%dT%H:%M:%SZ', 'now') < ? AS in_future`
    ).get(expires_at);
    if (!nowCheck.in_future) {
      return res.status(400).json({ error: 'expires_at must be in the future.', code: 400 });
    }

    db.get().prepare(`
      INSERT INTO user_availability (user_id, state, note, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        state      = excluded.state,
        note       = excluded.note,
        expires_at = excluded.expires_at,
        set_at     = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    `).run(userId, state, note ?? null, expires_at);

    const row = db.get().prepare(
      'SELECT state, note, expires_at, set_at FROM user_availability WHERE user_id = ?'
    ).get(userId);
    res.json({ data: row });
  } catch (err) {
    log.error('PUT /availability error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/** DELETE /api/v1/availability — eigenen Status loeschen. */
router.delete('/', (req, res) => {
  try {
    db.get().prepare('DELETE FROM user_availability WHERE user_id = ?').run(req.authUserId);
    res.json({ data: null });
  } catch (err) {
    log.error('DELETE /availability error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export { getAllStatuses };
export default router;
