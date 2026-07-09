/**
 * Modul: Zugriffsrechte-Routen (Rollen & Rechte)
 * Zweck: Admin-API zum Lesen und Setzen der Modul-/Widget-Rechte pro
 *        Familienrolle und pro einzelnem Mitglied (#467). Die verbindliche
 *        Durchsetzung liegt in server/index.js (Session-Gate) — diese Routen
 *        pflegen nur die Konfiguration.
 * Abhängigkeiten: express, server/db.js, server/permissions.js, server/auth.js
 */

import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { requireAdmin } from '../auth.js';
import {
  permissionCatalog,
  getSubjectPermissions,
  replaceSubjectPermissions,
  isValidFamilyRole,
} from '../permissions.js';

const log = createLogger('Permissions');
const router = express.Router();

// requireAuth + csrfMiddleware werden global in server/index.js angewandt.
router.use(requireAdmin);

/**
 * GET /api/v1/permissions/catalog
 * Liefert Module, Widgets, Rollen und die Mitgliederliste für die Rechte-Matrix.
 */
router.get('/catalog', (req, res) => {
  try {
    const catalog = permissionCatalog();
    const members = db.get().prepare(`
      SELECT id, display_name, username, avatar_color, avatar_data, role, family_role,
        CASE WHEN EXISTS (
          SELECT 1 FROM split_expense_guest_users sg WHERE sg.user_id = users.id
        ) THEN 'split_guest' ELSE 'family' END AS access_scope
      FROM users
      ORDER BY display_name
    `).all();
    res.json({ data: { ...catalog, members } });
  } catch (err) {
    log.error('Catalog error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * GET /api/v1/permissions/role/:familyRole
 * Gespeicherte (abweichende) Rechte eines Rollen-Profils.
 */
router.get('/role/:familyRole', (req, res) => {
  try {
    const familyRole = String(req.params.familyRole || '');
    if (!isValidFamilyRole(familyRole)) {
      return res.status(400).json({ error: 'Invalid family role.', code: 400 });
    }
    res.json({ data: getSubjectPermissions(db.get(), 'role', familyRole) });
  } catch (err) {
    log.error('Role read error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * PUT /api/v1/permissions/role/:familyRole
 * Body: { modules: { <key>: 'none'|'read'|'write' }, widgets: { <id>: 'none'|'allow' } }
 * Ersetzt das komplette Rollen-Profil (Standard-Werte werden nicht gespeichert).
 */
router.put('/role/:familyRole', (req, res) => {
  try {
    const familyRole = String(req.params.familyRole || '');
    if (!isValidFamilyRole(familyRole)) {
      return res.status(400).json({ error: 'Invalid family role.', code: 400 });
    }
    const data = replaceSubjectPermissions(db.get(), 'role', familyRole, req.body || {});
    res.json({ data });
  } catch (err) {
    if (/Unknown|Invalid/.test(err.message)) {
      return res.status(400).json({ error: err.message, code: 400 });
    }
    log.error('Role write error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * GET /api/v1/permissions/user/:userId
 * Gespeicherte (abweichende) Mitglied-Overrides.
 */
router.get('/user/:userId', (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (!Number.isFinite(userId)) return res.status(400).json({ error: 'Invalid user ID.', code: 400 });
    const exists = db.get().prepare('SELECT 1 FROM users WHERE id = ?').get(userId);
    if (!exists) return res.status(404).json({ error: 'User not found.', code: 404 });
    res.json({ data: getSubjectPermissions(db.get(), 'user', userId) });
  } catch (err) {
    log.error('User read error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * PUT /api/v1/permissions/user/:userId
 * Body wie bei role. Leere Maps = „von Rolle erben" (alle Overrides entfernt).
 */
router.put('/user/:userId', (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (!Number.isFinite(userId)) return res.status(400).json({ error: 'Invalid user ID.', code: 400 });
    const target = db.get().prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
    if (!target) return res.status(404).json({ error: 'User not found.', code: 404 });
    // Overrides auf Admins sind wirkungslos (Admins umgehen das System). Wir
    // speichern sie trotzdem nicht, um kein irreführendes UI zu erzeugen.
    if (target.role === 'admin') {
      return res.status(400).json({ error: 'Administrators always have full access; per-member restrictions do not apply.', code: 400 });
    }
    const data = replaceSubjectPermissions(db.get(), 'user', userId, req.body || {});
    res.json({ data });
  } catch (err) {
    if (/Unknown|Invalid/.test(err.message)) {
      return res.status(400).json({ error: err.message, code: 400 });
    }
    log.error('User write error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
