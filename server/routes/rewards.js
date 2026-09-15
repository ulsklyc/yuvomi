/**
 * Modul: Rewards (Belohnungen)
 * Zweck: REST-API für das Punkte-System — Teilnehmer (opt-in), Prämien-Katalog,
 *        Einlöse-Anfragen mit Eltern-Freigabe, manuelle Bonuspunkte und das
 *        nachvollziehbare Punkte-Ledger.
 * Abhängigkeiten: express, server/db.js, server/services/rewards.js
 */

import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { getBalance, isEnrolled, postLedger } from '../services/rewards.js';
import { householdMemberSql, newNonMembers, nonMemberMessage } from '../services/household-members.js';
import { isAdminRequest } from '../middleware/require-admin.js';

const log = createLogger('Rewards');
const router = express.Router();

const MAX_COST = 1_000_000;
const MAX_BONUS = 1_000_000;

function requireAdmin(req, res, next) {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ error: 'Admin access required.', code: 403 });
  }
  next();
}

function actingUser(req) {
  return req.authUserId || req.session?.userId || null;
}

// Nur Haushaltsmitglieder - kein Hauspersonal, keine Gaeste (#1207). Eine
// alte Einschreibung von Personal oder Gast bleibt in reward_participants
// stehen, erscheint aber in keiner dieser Listen und zaehlt nicht mit.
const MEMBER_FILTER = householdMemberSql('u');

function toInt(val) {
  const n = Math.trunc(Number(val));
  return Number.isFinite(n) ? n : NaN;
}

// Haushaltweiter Freigabe-Schalter (sync_config). Default an: fehlender Wert =>
// Einlösungen müssen bestätigt werden (Verhalten wie bisher). '0' => sofortige
// Gutschrift ohne Eltern-Freigabe.
function requiresApproval(d) {
  const row = d.prepare("SELECT value FROM sync_config WHERE key = 'rewards_require_approval'").get();
  return !row || row.value !== '0';
}

/** Rangfolge mit gleichen Rängen bei Punktegleichstand. */
function withRanks(rows) {
  let rank = 0;
  let prev = null;
  return rows.map((row, i) => {
    if (prev === null || row.balance !== prev) rank = i + 1;
    prev = row.balance;
    return { ...row, rank };
  });
}

function balancesOfEnrolled(d) {
  const rows = d.prepare(`
    SELECT u.id, u.display_name, u.avatar_color, u.avatar_data, u.family_role,
           COALESCE((SELECT SUM(delta) FROM reward_ledger l WHERE l.user_id = u.id), 0) AS balance
    FROM users u
    JOIN reward_participants p ON p.user_id = u.id AND p.enabled = 1
    WHERE ${MEMBER_FILTER}
    ORDER BY balance DESC, u.display_name COLLATE NOCASE ASC
  `).all();
  return withRanks(rows);
}

function activeCatalog(d) {
  return d.prepare(`
    SELECT id, name, cost, icon, description, is_active, sort_order
    FROM reward_catalog
    WHERE is_active = 1
    ORDER BY sort_order ASC, cost ASC, name COLLATE NOCASE ASC
  `).all();
}

// --------------------------------------------------------
// GET /overview — Salden (teilnehmende Mitglieder), aktive Prämien, offene
// Anfragen. Basis für die Übersicht des Moduls.
// --------------------------------------------------------
router.get('/overview', (req, res) => {
  try {
    const d = db.get();
    const balances = balancesOfEnrolled(d);
    const catalog = activeCatalog(d);
    const pending = d.prepare("SELECT COUNT(*) AS n FROM reward_redemptions WHERE status = 'pending'").get().n;
    // Zähler für den Eltern-Ersteinrichtungs-Hinweis (aktivierte Mitglieder,
    // angelegte Prämien, Aufgaben mit Punktewert).
    const participantCount = d.prepare(`SELECT COUNT(*) AS n FROM reward_participants p JOIN users u ON u.id = p.user_id WHERE p.enabled = 1 AND ${MEMBER_FILTER}`).get().n;
    const catalogCount = d.prepare('SELECT COUNT(*) AS n FROM reward_catalog WHERE is_active = 1').get().n;
    const pointedTaskCount = d.prepare('SELECT COUNT(*) AS n FROM tasks WHERE points > 0').get().n;
    res.json({ data: {
      balances, catalog, pendingCount: pending,
      isAdmin: isAdminRequest(req), me: actingUser(req),
      setup: { participantCount, catalogCount, pointedTaskCount },
    } });
  } catch (err) {
    log.error('GET /overview error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /participants — alle Mitglieder mit Teilnahme-Flag und Saldo (Admin).
// --------------------------------------------------------
router.get('/participants', requireAdmin, (req, res) => {
  try {
    const rows = db.get().prepare(`
      SELECT u.id, u.display_name, u.avatar_color, u.avatar_data, u.family_role,
             CASE WHEN p.user_id IS NOT NULL AND p.enabled = 1 THEN 1 ELSE 0 END AS enabled,
             COALESCE((SELECT SUM(delta) FROM reward_ledger l WHERE l.user_id = u.id), 0) AS balance
      FROM users u
      LEFT JOIN reward_participants p ON p.user_id = u.id
      WHERE ${MEMBER_FILTER}
      ORDER BY u.display_name COLLATE NOCASE ASC
    `).all().map((r) => ({ ...r, enabled: r.enabled === 1 }));
    res.json({ data: rows });
  } catch (err) {
    log.error('GET /participants error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PUT /participants/:userId — Teilnahme aktivieren/deaktivieren (Admin).
// --------------------------------------------------------
router.put('/participants/:userId', requireAdmin, (req, res) => {
  try {
    const userId = toInt(req.params.userId);
    const enabled = req.body?.enabled === true || req.body?.enabled === 1 ? 1 : 0;
    const user = db.get().prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'User not found.', code: 404 });
    // Einschreiben nur Haushaltsmitglieder (#1207). Eine eingeschaltete
    // Einschreibung von frueher bleibt gueltig und laesst sich abschalten;
    // abgeschaltet ist sie keine mehr, und neu anlegen geht nicht.
    if (enabled === 1) {
      const current = db.get().prepare('SELECT enabled FROM reward_participants WHERE user_id = ?').get(userId);
      const strangers = newNonMembers([userId], { stored: current?.enabled === 1 ? [userId] : [] });
      if (strangers.length) return res.status(400).json({ error: nonMemberMessage(strangers), code: 400 });
    }

    db.get().prepare(`
      INSERT INTO reward_participants (user_id, enabled) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    `).run(userId, enabled);

    res.json({ data: { user_id: userId, enabled: enabled === 1 } });
  } catch (err) {
    log.error('PUT /participants/:userId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /catalog — Prämien. Admin sieht auch inaktive.
// --------------------------------------------------------
router.get('/catalog', (req, res) => {
  try {
    const all = isAdminRequest(req) && req.query.all === '1';
    const rows = db.get().prepare(`
      SELECT id, name, cost, icon, description, is_active, sort_order
      FROM reward_catalog
      ${all ? '' : 'WHERE is_active = 1'}
      ORDER BY is_active DESC, sort_order ASC, cost ASC, name COLLATE NOCASE ASC
    `).all();
    res.json({ data: rows });
  } catch (err) {
    log.error('GET /catalog error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

function readCatalogInput(body) {
  const name = String(body?.name ?? '').trim();
  const cost = toInt(body?.cost);
  const icon = body?.icon != null ? String(body.icon).trim().slice(0, 8) || null : null;
  const description = body?.description != null ? String(body.description).trim() || null : null;
  const sort_order = Number.isFinite(toInt(body?.sort_order)) ? toInt(body.sort_order) : 0;
  return { name, cost, icon, description, sort_order };
}

// --------------------------------------------------------
// POST /catalog — Prämie anlegen (Admin).
// --------------------------------------------------------
router.post('/catalog', requireAdmin, (req, res) => {
  try {
    const { name, cost, icon, description, sort_order } = readCatalogInput(req.body);
    if (!name) return res.status(400).json({ error: 'name is required.', code: 400 });
    if (!Number.isFinite(cost) || cost < 1 || cost > MAX_COST)
      return res.status(400).json({ error: 'cost must be a positive number.', code: 400 });

    const result = db.get().prepare(`
      INSERT INTO reward_catalog (name, cost, icon, description, sort_order, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name, cost, icon, description, sort_order, actingUser(req));
    const row = db.get().prepare('SELECT id, name, cost, icon, description, is_active, sort_order FROM reward_catalog WHERE id = ?')
      .get(result.lastInsertRowid);
    res.status(201).json({ data: row });
  } catch (err) {
    log.error('POST /catalog error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PATCH /catalog/:id — Prämie bearbeiten / (de)aktivieren (Admin).
// --------------------------------------------------------
router.patch('/catalog/:id', requireAdmin, (req, res) => {
  try {
    const id = toInt(req.params.id);
    const existing = db.get().prepare('SELECT * FROM reward_catalog WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Reward not found.', code: 404 });

    const name = req.body?.name != null ? String(req.body.name).trim() : existing.name;
    if (!name) return res.status(400).json({ error: 'name is required.', code: 400 });
    let cost = existing.cost;
    if (req.body?.cost != null) {
      cost = toInt(req.body.cost);
      if (!Number.isFinite(cost) || cost < 1 || cost > MAX_COST)
        return res.status(400).json({ error: 'cost must be a positive number.', code: 400 });
    }
    // `undefined` (Feld fehlt) heisst "unveraendert lassen", `null` (Feld leer
    // abgeschickt) heisst "leeren". Beides ueber `!= null` zusammenzufassen
    // machte das Leeren unmoeglich, beides ueber `!== undefined` schickte das
    // gesendete `null` durch `String()` - und speicherte den Text "null" als
    // Icon. Deshalb bleiben die drei Faelle hier ausdruecklich getrennt.
    const icon = req.body?.icon === undefined ? existing.icon
      : (req.body.icon === null ? null : String(req.body.icon).trim().slice(0, 8) || null);
    const description = req.body?.description === undefined ? existing.description
      : (req.body.description === null ? null : String(req.body.description).trim() || null);
    const sort_order = req.body?.sort_order !== undefined && Number.isFinite(toInt(req.body.sort_order))
      ? toInt(req.body.sort_order) : existing.sort_order;
    const is_active = req.body?.is_active !== undefined
      ? (req.body.is_active === true || req.body.is_active === 1 ? 1 : 0) : existing.is_active;

    db.get().prepare(`
      UPDATE reward_catalog SET name = ?, cost = ?, icon = ?, description = ?,
        sort_order = ?, is_active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
    `).run(name, cost, icon, description, sort_order, is_active, id);
    const row = db.get().prepare('SELECT id, name, cost, icon, description, is_active, sort_order FROM reward_catalog WHERE id = ?').get(id);
    res.json({ data: row });
  } catch (err) {
    log.error('PATCH /catalog/:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /catalog/:id — Prämie löschen (Admin). Bereits eingelöste Anfragen
// behalten ihren Snapshot (catalog_id wird auf NULL gesetzt).
// --------------------------------------------------------
router.delete('/catalog/:id', requireAdmin, (req, res) => {
  try {
    const result = db.get().prepare('DELETE FROM reward_catalog WHERE id = ?').run(toInt(req.params.id));
    if (result.changes === 0) return res.status(404).json({ error: 'Reward not found.', code: 404 });
    res.json({ ok: true });
  } catch (err) {
    log.error('DELETE /catalog/:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /ledger?user_id=&limit= — Punkte-Historie mit Namen.
// --------------------------------------------------------
router.get('/ledger', (req, res) => {
  try {
    const limit = Math.min(Math.max(toInt(req.query.limit) || 100, 1), 500);
    const userId = req.query.user_id != null && req.query.user_id !== '' ? toInt(req.query.user_id) : null;
    const rows = db.get().prepare(`
      SELECT l.id, l.user_id, l.delta, l.type, l.reason, l.task_id, l.redemption_id, l.created_at,
             u.display_name AS user_name, u.avatar_color AS user_color, u.avatar_data AS user_avatar,
             a.display_name AS actor_name
      FROM reward_ledger l
      JOIN users u ON u.id = l.user_id
      LEFT JOIN users a ON a.id = l.created_by
      ${userId ? 'WHERE l.user_id = @userId' : ''}
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT @limit
    `).all({ userId, limit });
    res.json({ data: rows });
  } catch (err) {
    log.error('GET /ledger error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /redemptions?status= — Einlöse-Anfragen mit Namen.
// --------------------------------------------------------
router.get('/redemptions', (req, res) => {
  try {
    const status = ['pending', 'fulfilled', 'rejected', 'cancelled'].includes(req.query.status)
      ? req.query.status : null;
    const rows = db.get().prepare(`
      SELECT r.id, r.user_id, r.catalog_id, r.reward_name, r.reward_icon, r.cost, r.status,
             r.note, r.decided_at, r.created_at,
             u.display_name AS user_name, u.avatar_color AS user_color, u.avatar_data AS user_avatar,
             dec.display_name AS decided_by_name
      FROM reward_redemptions r
      JOIN users u ON u.id = r.user_id
      LEFT JOIN users dec ON dec.id = r.decided_by
      ${status ? 'WHERE r.status = @status' : ''}
      ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.created_at DESC, r.id DESC
      LIMIT 300
    `).all({ status });
    res.json({ data: rows });
  } catch (err) {
    log.error('GET /redemptions error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /redemptions — Prämie einlösen (anfragen). Punkte werden sofort per
// Ledger-Buchung reserviert; Eltern/Admin bestätigen später. Ein Nicht-Admin
// kann nur für sich selbst einlösen; ein Admin auch stellvertretend.
// --------------------------------------------------------
router.post('/redemptions', (req, res) => {
  try {
    const d = db.get();
    const me = actingUser(req);
    const targetId = req.body?.user_id != null && isAdminRequest(req) ? toInt(req.body.user_id) : me;
    if (!targetId) return res.status(400).json({ error: 'user_id is required.', code: 400 });

    const item = d.prepare('SELECT * FROM reward_catalog WHERE id = ? AND is_active = 1').get(toInt(req.body?.catalog_id));
    if (!item) return res.status(404).json({ error: 'Reward not found.', code: 404 });
    if (!isEnrolled(d, targetId))
      return res.status(400).json({ error: 'User does not participate in the reward system.', code: 400 });

    const balance = getBalance(d, targetId);
    if (balance < item.cost)
      return res.status(400).json({ error: 'Insufficient points.', code: 400 });

    const note = req.body?.note != null ? String(req.body.note).trim().slice(0, 500) || null : null;
    // Ohne Eltern-Freigabe (haushaltweit deaktiviert) wird die Einlösung sofort
    // gutgeschrieben; die reservierten Punkte bleiben abgezogen (keine Rückbuchung).
    const autoFulfill = !requiresApproval(d);

    const redemptionId = d.transaction(() => {
      const r = autoFulfill
        ? d.prepare(`
            INSERT INTO reward_redemptions (user_id, catalog_id, reward_name, reward_icon, cost, note, requested_by, status, decided_by, decided_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'fulfilled', ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
          `).run(targetId, item.id, item.name, item.icon, item.cost, note, me, me)
        : d.prepare(`
            INSERT INTO reward_redemptions (user_id, catalog_id, reward_name, reward_icon, cost, note, requested_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(targetId, item.id, item.name, item.icon, item.cost, note, me);
      // Punkte sofort reservieren, damit sie nicht doppelt ausgegeben werden.
      postLedger(d, {
        userId: targetId, delta: -item.cost, type: 'redeem',
        reason: item.name, redemptionId: r.lastInsertRowid, createdBy: me,
      });
      return r.lastInsertRowid;
    })();

    const row = d.prepare('SELECT * FROM reward_redemptions WHERE id = ?').get(redemptionId);
    res.status(201).json({ data: row });
  } catch (err) {
    log.error('POST /redemptions error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PATCH /redemptions/:id — Anfrage entscheiden.
// action: 'fulfill' | 'reject' (Admin) | 'cancel' (Eigentümer oder Admin).
// Bei reject/cancel werden die reservierten Punkte zurückgebucht.
// --------------------------------------------------------
router.patch('/redemptions/:id', (req, res) => {
  try {
    const d = db.get();
    const me = actingUser(req);
    const action = req.body?.action;
    const row = d.prepare('SELECT * FROM reward_redemptions WHERE id = ?').get(toInt(req.params.id));
    if (!row) return res.status(404).json({ error: 'Redemption not found.', code: 404 });
    if (row.status !== 'pending')
      return res.status(409).json({ error: 'Redemption already decided.', code: 409 });

    const isAdmin = isAdminRequest(req);
    if ((action === 'fulfill' || action === 'reject') && !isAdmin)
      return res.status(403).json({ error: 'Admin access required.', code: 403 });
    if (action === 'cancel' && !isAdmin && row.user_id !== me)
      return res.status(403).json({ error: 'Not allowed.', code: 403 });
    if (!['fulfill', 'reject', 'cancel'].includes(action))
      return res.status(400).json({ error: 'Invalid action.', code: 400 });

    const nextStatus = action === 'fulfill' ? 'fulfilled' : action === 'reject' ? 'rejected' : 'cancelled';

    d.transaction(() => {
      if (action !== 'fulfill') {
        // Reservierte Punkte zurückgeben.
        postLedger(d, {
          userId: row.user_id, delta: row.cost, type: 'reversal',
          reason: row.reward_name, redemptionId: row.id, createdBy: me,
        });
      }
      d.prepare(`
        UPDATE reward_redemptions SET status = ?, decided_by = ?,
          decided_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?
      `).run(nextStatus, me, row.id);
    })();

    const updated = d.prepare('SELECT * FROM reward_redemptions WHERE id = ?').get(row.id);
    res.json({ data: updated });
  } catch (err) {
    log.error('PATCH /redemptions/:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /bonus — manuelle Punkte (Bonus positiv, Korrektur negativ). Admin.
// --------------------------------------------------------
router.post('/bonus', requireAdmin, (req, res) => {
  try {
    const d = db.get();
    const userId = toInt(req.body?.user_id);
    const delta = toInt(req.body?.delta);
    const reason = req.body?.reason != null ? String(req.body.reason).trim().slice(0, 200) || null : null;
    if (!Number.isFinite(userId)) return res.status(400).json({ error: 'user_id is required.', code: 400 });
    if (!Number.isFinite(delta) || delta === 0)
      return res.status(400).json({ error: 'delta must be a non-zero number.', code: 400 });
    if (Math.abs(delta) > MAX_BONUS)
      return res.status(400).json({ error: 'delta out of range.', code: 400 });
    if (!isEnrolled(d, userId))
      return res.status(400).json({ error: 'User does not participate in the reward system.', code: 400 });

    postLedger(d, {
      userId, delta, type: delta > 0 ? 'bonus' : 'adjust', reason, createdBy: actingUser(req),
    });
    res.status(201).json({ data: { user_id: userId, balance: getBalance(d, userId) } });
  } catch (err) {
    log.error('POST /bonus error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
