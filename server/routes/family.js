/**
 * Module: Family
 * Purpose: Family member API - the member list every picker reads, and the one
 *          household member order (#1644).
 * Dependencies: express, server/db.js, server/services/household-members.js
 */

import express from 'express';
import * as db from '../db.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { validateRequest } from '../api/validate-request.ts';
import {
  householdMemberSql, memberOrderProblem, memberOrderSql, memberPositionSql, writeMemberOrder,
} from '../services/household-members.js';

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
           -- Nur Tag und Monat bekannt (#2095): birth_date traegt dann 2000.
           COALESCE(b.year_unknown, 0) AS birth_year_unknown,
           u.created_at,
           ${memberPositionSql('u')} AS sort_order
    FROM users u
    LEFT JOIN contacts c ON c.family_user_id = u.id
    LEFT JOIN birthdays b ON b.family_user_id = u.id
    WHERE ${householdMemberSql('u')}
    ORDER BY ${memberOrderSql('u')}
  `).all().map((row) => ({ ...row, birth_year_unknown: row.birth_year_unknown === 1 }));
}

// An unexpected error goes to the central error handler (#2810).
router.get('/members', validateRequest(), (req, res) => {
  res.json({ data: listMembers() });
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
// Person. Die Absage ist die eine Admin-Absage (requireAdmin, Phase 2 C2) mit
// `reason: 'admin_required'`. Sie steht als Routen-Middleware VOR
// validateRequest() (#2810): ein Mitglied bekommt 403, nie ein 400, das Felder
// nennt. Die Form der Liste (`invalid_order`, `duplicate_member`) prueft das
// Schema; ob sie genau die Mitglieder nennt, bleibt Sache des Handlers.
//
// KEIN `await` VOR DER DATENBANK: Pruefen und Schreiben laufen ohne
// Yield-Punkt hintereinander, sonst koennte zwischen beidem ein Mitglied
// deaktiviert werden und bekaeme trotzdem eine Position.
// --------------------------------------------------------
router.patch('/members/reorder', requireAdmin, validateRequest(), (req, res) => {
  const order = req.body?.order;
  const problem = memberOrderProblem(order);
  if (problem) return res.status(400).json({ error: problem.error, code: 400, reason: problem.reason });
  writeMemberOrder(order);
  res.json({ data: listMembers() });
});

export default router;
