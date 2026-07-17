/**
 * Modul: Budget-Tracker – Konten (#495)
 * Zweck: getrennte Konten mit Startsaldo, laufendem/prognostiziertem Saldo, Nettovermögen.
 */

import express from 'express';
import { createLogger } from '../../logger.js';
import * as db from '../../db.js';
import { str, oneOf, num, color as validateColor, collectErrors, MAX_SHORT } from '../../middleware/validate.js';
import { budgetFilter, listAccounts, ACCOUNT_TYPE_KEYS, nextAccountSortOrder, cents } from './helpers.js';

const log = createLogger('Budget');
const router = express.Router();

/**
 * GET /api/v1/budget/accounts
 * Listet Konten mit Startsaldo und laufendem Saldo; zusätzlich das Gesamt-Nettovermögen.
 * Query: ?include_archived=1  (default: nur aktive Konten)
 * Response: { data: { accounts: [], net_worth } }
 */
router.get('/accounts', (req, res) => {
  try {
    const includeArchived = req.query.include_archived === '1' || req.query.include_archived === 'true';
    const accounts = listAccounts(includeArchived, budgetFilter(req, 'e', { scoped: false }));
    const netWorth = cents(accounts
      .filter((a) => !a.archived)
      .reduce((sum, a) => sum + a.current_balance, 0));
    res.json({ data: { accounts, net_worth: netWorth } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * POST /api/v1/budget/accounts
 * Neues Konto anlegen.
 * Body: { name, type?, starting_balance?, currency?, color? }
 * Response: { data: Account }
 */
router.post('/accounts', (req, res) => {
  try {
    const vName    = str(req.body.name, 'Name', { max: MAX_SHORT });
    const vType    = oneOf(req.body.type || 'checking', ACCOUNT_TYPE_KEYS, 'Kontotyp');
    const vBalance = num(req.body.starting_balance ?? 0, 'Startsaldo', { required: false });
    const vColor   = validateColor(req.body.color, 'Farbe');
    const errors   = collectErrors([vName, vType, vBalance, vColor]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const currency = req.body.currency ? str(req.body.currency, 'Währung', { max: 8 }).value : null;
    const color    = vColor.value;

    const result = db.get().prepare(`
      INSERT INTO budget_accounts (name, type, starting_balance, currency, color, sort_order, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      vName.value, vType.value, cents(vBalance.value ?? 0),
      currency, color, nextAccountSortOrder(),
      req.authUserId || req.session.userId
    );

    const account = listAccounts(true, budgetFilter(req, 'e', { scoped: false })).find((a) => a.id === Number(result.lastInsertRowid));
    res.status(201).json({ data: account });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * PUT /api/v1/budget/accounts/:id
 * Konto aktualisieren (Name, Typ, Startsaldo, Währung, Farbe, Archiv-Status).
 * Response: { data: Account }
 */
router.put('/accounts/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = db.get().prepare('SELECT * FROM budget_accounts WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Account not found', code: 404 });

    const checks = [];
    if (req.body.name !== undefined) checks.push(str(req.body.name, 'Name', { max: MAX_SHORT }));
    if (req.body.type !== undefined) checks.push(oneOf(req.body.type, ACCOUNT_TYPE_KEYS, 'Kontotyp'));
    if (req.body.starting_balance !== undefined) checks.push(num(req.body.starting_balance, 'Startsaldo'));
    if (req.body.color !== undefined) checks.push(validateColor(req.body.color, 'Farbe'));
    const errors = collectErrors(checks);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const currency = req.body.currency !== undefined
      ? (req.body.currency ? str(req.body.currency, 'Währung', { max: 8 }).value : null)
      : existing.currency;
    const color = req.body.color !== undefined
      ? validateColor(req.body.color, 'Farbe').value
      : existing.color;
    const archived = req.body.archived !== undefined ? (req.body.archived ? 1 : 0) : existing.archived;

    db.get().prepare(`
      UPDATE budget_accounts
      SET name             = COALESCE(?, name),
          type             = COALESCE(?, type),
          starting_balance = COALESCE(?, starting_balance),
          currency         = ?,
          color            = ?,
          archived         = ?
      WHERE id = ?
    `).run(
      req.body.name !== undefined ? String(req.body.name).trim() : null,
      req.body.type !== undefined ? req.body.type : null,
      req.body.starting_balance !== undefined ? cents(req.body.starting_balance) : null,
      currency, color, archived, id
    );

    const account = listAccounts(true, budgetFilter(req, 'e', { scoped: false })).find((a) => a.id === id);
    res.json({ data: account });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * DELETE /api/v1/budget/accounts/:id
 * Konto löschen. Zugeordnete Einträge bleiben erhalten (account_id wird geleert).
 * Response: 204 No Content
 */
router.delete('/accounts/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = db.get().prepare('SELECT id FROM budget_accounts WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Account not found', code: 404 });

    const tx = db.get().transaction(() => {
      // Zuordnung explizit leeren (unabhängig vom FK-Pragma), Einträge bleiben bestehen.
      db.get().prepare('UPDATE budget_entries SET account_id = NULL WHERE account_id = ?').run(id);
      db.get().prepare('DELETE FROM budget_accounts WHERE id = ?').run(id);
    });
    tx();

    res.status(204).end();
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

export default router;
