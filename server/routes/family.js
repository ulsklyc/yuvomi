/**
 * Module: Family
 * Purpose: Read-only family member API.
 * Dependencies: express, server/db.js
 */

import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';

const log = createLogger('Family');
const router = express.Router();

router.get('/members', (req, res) => {
  try {
    const members = db.get().prepare(`
      SELECT u.id,
             u.display_name,
             u.avatar_color,
             u.avatar_data,
             u.family_role,
             c.phone,
             c.email,
             b.birth_date,
             u.created_at
      FROM users u
      LEFT JOIN contacts c ON c.family_user_id = u.id
      LEFT JOIN birthdays b ON b.family_user_id = u.id
      WHERE NOT EXISTS (
        SELECT 1 FROM housekeeping_workers hw WHERE hw.user_id = u.id
      )
      ORDER BY u.display_name COLLATE NOCASE ASC
    `).all();
    res.json({ data: members });
  } catch (err) {
    log.error('GET /members error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
