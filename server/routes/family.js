/**
 * Module: Family
 * Purpose: Family member API - the member list every picker reads, and the one
 *          household member order (#1644).
 * Dependencies: express, server/db.js, server/services/household-members.js
 */

import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import {
  householdMemberSql, memberOrderProblem, memberOrderSql, memberPositionSql, writeMemberOrder,
} from '../services/household-members.js';

const log = createLogger('Family');
const router = express.Router();

/** Die Mitgliederliste, wie `GET /members` sie zeigt - in der Haushaltsreihenfolge. */
function listMembers() {
  return db.get().prepare(`
    SELECT u.id,
           u.display_name,
           u.avatar_color,
           u.avatar_data,
           u.family_role,
           c.phone,
           c.email,
           b.birth_date,
           u.created_at,
           ${memberPositionSql('u')} AS sort_order
    FROM users u
    LEFT JOIN contacts c ON c.family_user_id = u.id
    LEFT JOIN birthdays b ON b.family_user_id = u.id
    WHERE ${householdMemberSql('u')}
    ORDER BY ${memberOrderSql('u')}
  `).all();
}

router.get('/members', (req, res) => {
  try {
    res.json({ data: listMembers() });
  } catch (err) {
    log.error('GET /members error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PATCH /api/v1/family/members/reorder  Body: { order: number[] }
//
// Setzt die EINE Haushaltsreihenfolge (#1644): die vollstaendige Liste der
// Mitglieder in der gewuenschten Folge. Dieselbe Form wie die anderen
// Umsortier-Routen (`PATCH .../reorder`, Body `{ order }`).
//
// NUR ADMINISTRATOREN. Die Reihenfolge gilt fuer alle, die hinsehen - sie ist
// eine Einstellung des Haushalts wie die Familienrollen, keine Vorliebe einer
// Person. Die Absage traegt einen `reason`, weil `requireAdmin` keinen hat und
// die Oberflaeche sonst nur "Permission denied." weiterreichen koennte.
//
// KEIN `await` VOR DER DATENBANK: Pruefen und Schreiben laufen ohne
// Yield-Punkt hintereinander, sonst koennte zwischen beidem ein Mitglied
// deaktiviert werden und bekaeme trotzdem eine Position.
// --------------------------------------------------------
router.patch('/members/reorder', (req, res) => {
  try {
    if (!isAdminRequest(req)) {
      return res.status(403).json({
        error: 'Only administrators can change the member order.', code: 403, reason: 'admin_required',
      });
    }
    const order = req.body?.order;
    const problem = memberOrderProblem(order);
    if (problem) return res.status(400).json({ error: problem.error, code: 400, reason: problem.reason });
    writeMemberOrder(order);
    res.json({ data: listMembers() });
  } catch (err) {
    log.error('PATCH /members/reorder error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
