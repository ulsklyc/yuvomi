/**
 * Module: Availability
 * Purpose: Per-user availability status (#1591). Each household member can set
 *          their own state (available / busy / do_not_disturb / away) with an
 *          optional note and an expiry time. The status is visible to all
 *          household members via the family widget on the dashboard.
 *          Every route carries validateRequest() (#2810, group 13 b): the
 *          shape of state, note and expires_at is checked against
 *          server/openapi/paths/availability.js. `expires_at` being in the
 *          future and within 30 days is relative to the time of the request,
 *          which the schema cannot express, so the handler checks it by hand.
 * Routes:
 *   GET  /api/v1/availability        → all current statuses for the household
 *   PUT  /api/v1/availability        → set / update own status
 *   DELETE /api/v1/availability      → clear own status
 */

import express from 'express';
import * as db from '../db.js';
import { householdMemberSql } from '../services/household-members.js';
import { validateRequest } from '../api/validate-request.ts';

const router = express.Router();

/** Alle aktuellen (noch nicht abgelaufenen) Verfuegbarkeitsstati im Haushalt. */
function getAllStatuses() {
  return db.get().prepare(`
    SELECT a.user_id,
           a.state,
           a.note,
           a.expires_at,
           a.updated_at
    FROM user_availability a
    JOIN users u ON u.id = a.user_id
    WHERE ${householdMemberSql('u')}
      AND a.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    ORDER BY a.updated_at DESC
  `).all();
}

/** GET /api/v1/availability — Haushaltsliste aller aktiven Stati. */
router.get('/', validateRequest(), (req, res) => {
  res.json({ data: getAllStatuses() });
});

/** PUT /api/v1/availability — eigenen Status setzen oder aktualisieren.
 *  Body: { state, note?, expires_at }, geprueft gegen das OpenAPI-Dokument.
 *  Nur der Handler prueft, ob expires_at in der Zukunft und hoechstens 30
 *  Tage entfernt liegt - relativ zur Anfragezeit, das kann das Schema nicht.
 */
router.put('/', validateRequest(), (req, res) => {
  const userId = req.authUserId;
  const { state, note, expires_at } = req.body;

  const nowMs = Date.now();
  const parsedExpiry = new Date(expires_at);
  if (parsedExpiry.getTime() <= nowMs) {
    return res.status(400).json({ error: 'expires_at must be in the future.', code: 400 });
  }
  const MAX_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
  if (parsedExpiry.getTime() - nowMs > MAX_EXPIRY_MS) {
    return res.status(400).json({ error: 'expires_at must be within 30 days from now.', code: 400 });
  }

  db.get().prepare(`
    INSERT INTO user_availability (user_id, state, note, expires_at, created_at)
    VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    ON CONFLICT(user_id) DO UPDATE SET
      state      = excluded.state,
      note       = excluded.note,
      expires_at = excluded.expires_at,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `).run(userId, state, note ?? null, expires_at);

  const row = db.get().prepare(
    'SELECT state, note, expires_at, updated_at FROM user_availability WHERE user_id = ?'
  ).get(userId);
  res.json({ data: row });
});

/** DELETE /api/v1/availability — eigenen Status loeschen. */
router.delete('/', validateRequest(), (req, res) => {
  db.get().prepare('DELETE FROM user_availability WHERE user_id = ?').run(req.authUserId);
  res.json({ data: null });
});

export default router;
