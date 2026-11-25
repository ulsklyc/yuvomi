/**
 * Modul: Zugriffsrechte-Routen (Rollen & Rechte)
 * Zweck: Admin-API zum Lesen und Setzen der Modul-/Widget-Rechte pro
 *        Familienrolle und pro einzelnem Mitglied (#467). Die verbindliche
 *        Durchsetzung liegt in server/index.js (Session-Gate) — diese Routen
 *        pflegen nur die Konfiguration.
 * Abhängigkeiten: express, server/db.js, server/authorize/, server/auth.js
 */

import express from 'express';
import * as db from '../db.js';
import { withTx } from '../db/tx.ts';
import { requireAdmin } from '../auth.js';
import { validateRequest } from '../api/validate-request.ts';
import { listModules } from '../services/modules.js';
import { accessScopeSql, activeAccountSql, householdMemberSql, memberOrderSql } from '../services/household-members.js';
import {
  permissionCatalog,
  getSubjectPermissions,
  writeSubjectPermissions,
} from '../authorize/index.ts';
import { syncFastingRemindersForUser } from '../services/fasting-reminders.js';
import { revokePaymentTasksForUsers } from '../services/payment-task-audience.js';

const router = express.Router();

// Kein try/catch je Route: ein unerwarteter Fehler (SQLite, Dateisystem) geht
// an den zentralen Fehlerhandler (server/middleware/error-handler.js). Der
// loggt ihn mit Methode und Routenmuster und antwortet 500 mit dem festen Satz.
// Die beiden PUT-Routen fangen nur, um Validator-Fehler in 400 zu übersetzen.
//
// Was das Schema der Operation prueft, prueft keine Route noch einmal (#2810):
// `familyRole` ist eine der Familienrollen (enum), `userId` eine ganze Zahl aus
// Dezimalziffern, und jeder Wert in `modules`, `widgets` und `capabilities` eine
// der Stufen seiner Achse. Ein unbekannter SCHLUESSEL bleibt die Absage des
// Katalogs (`Unknown module: ...`): die Schluesselmenge waechst mit den
// installierten Erweiterungen und steht nicht im Dokument.

function syncFastingForUsers(database, userIds) {
  for (const userId of userIds) {
    syncFastingRemindersForUser(database, userId);
  }
}

function replacePermissionsAndSync(database, subjectType, subjectId, input, userIds) {
  return withTx(database, () => {
    writeSubjectPermissions(database, subjectType, subjectId, input);
    syncFastingForUsers(database, userIds);
    // Wer das Betragsrecht verliert, faellt aus seinen Zahlungsaufgaben. Ein
    // Rollenprofil trifft jedes Konto der Rolle, nicht nur die Haushalts-
    // mitglieder in `userIds`: dort fragt der Dienst selbst jedes Konto, das in
    // einer Zahlungsaufgabe steht.
    revokePaymentTasksForUsers(database, subjectType === 'user' ? userIds : null);
    return getSubjectPermissions(database, subjectType, subjectId);
  });
}

// requireAuth + csrfMiddleware werden global in server/index.js angewandt.
// Der Admin-Riegel steht vor validateRequest() jeder Route: ein Mitglied
// bekommt 403, nie eine 400 mit Feldnamen (#2810).
router.use(requireAdmin);

/**
 * GET /api/v1/permissions/catalog
 * Liefert Module, Widgets, Rollen und die Mitgliederliste für die Rechte-Matrix.
 */
router.get('/catalog', validateRequest(), async (req, res) => {
  await listModules({ admin: true });
  const catalog = permissionCatalog();
  const members = db.get().prepare(`
    SELECT id, display_name, username, avatar_color, avatar_data, role, family_role,
      ${accessScopeSql('users')} AS access_scope
    FROM users
    -- Rechte vergibt man an Konten, die noch hereinkommen (#1381).
    WHERE ${activeAccountSql('users')}
    ORDER BY ${memberOrderSql('users')}
  `).all();
  res.json({ data: { ...catalog, members } });
});

/**
 * GET /api/v1/permissions/role/:familyRole
 * Gespeicherte (abweichende) Rechte eines Rollen-Profils.
 */
router.get('/role/:familyRole', validateRequest(), (req, res) => {
  res.json({ data: getSubjectPermissions(db.get(), 'role', req.params.familyRole) });
});

/**
 * PUT /api/v1/permissions/role/:familyRole
 * Body: { modules, widgets, capabilities }. Modul- und Widget-Achse werden bei
 * jedem Aufruf ersetzt; Capabilities nur, wenn das Feld ausdrücklich vorkommt.
 * So bleiben ältere Clients kompatibel. Standard-Werte werden nicht gespeichert.
 */
router.put('/role/:familyRole', validateRequest(), (req, res) => {
  try {
    const familyRole = req.params.familyRole;
    const database = db.get();
    const userIds = database.prepare(`
      SELECT u.id FROM users u
      WHERE u.family_role = ? AND ${householdMemberSql('u')}
    `).all(familyRole).map((row) => row.id);
    const data = replacePermissionsAndSync(database, 'role', familyRole, req.body || {}, userIds);
    res.json({ data });
  } catch (err) {
    if (/Unknown|Invalid/.test(err.message)) {
      return res.status(400).json({ error: err.message, code: 400 });
    }
    throw err;
  }
});

/**
 * GET /api/v1/permissions/user/:userId
 * Gespeicherte (abweichende) Mitglied-Overrides.
 */
router.get('/user/:userId', validateRequest(), (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  const exists = db.get().prepare('SELECT 1 FROM users WHERE id = ?').get(userId);
  if (!exists) return res.status(404).json({ error: 'User not found.', code: 404 });
  res.json({ data: getSubjectPermissions(db.get(), 'user', userId) });
});

/**
 * PUT /api/v1/permissions/user/:userId
 * Body wie bei role. Leere Maps leeren jeweils ihre eigene Achse. Zum Entfernen
 * aller Overrides müssen modules, widgets und capabilities leer gesendet werden.
 */
router.put('/user/:userId', validateRequest(), (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    const target = db.get().prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
    if (!target) return res.status(404).json({ error: 'User not found.', code: 404 });
    // Overrides auf Admins sind wirkungslos (Admins umgehen das System). Wir
    // speichern sie trotzdem nicht, um kein irreführendes UI zu erzeugen.
    if (target.role === 'admin') {
      return res.status(400).json({ error: 'Administrators always have full access; per-member restrictions do not apply.', code: 400 });
    }
    const data = replacePermissionsAndSync(db.get(), 'user', userId, req.body || {}, [userId]);
    res.json({ data });
  } catch (err) {
    if (/Unknown|Invalid/.test(err.message)) {
      return res.status(400).json({ error: err.message, code: 400 });
    }
    throw err;
  }
});

export default router;
