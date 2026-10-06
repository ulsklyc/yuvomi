/**
 * Modul: Budget-Tracker – Konten (#495)
 * Zweck: getrennte Konten mit Startsaldo, laufendem/prognostiziertem Saldo, Nettovermögen.
 */

import express from 'express';
import { createLogger } from '../../logger.js';
import * as db from '../../db.js';
import { str, oneOf, num, color as validateColor, MAX_SHORT } from '../../middleware/validate.js';
import {
  budgetFilter, listAccounts, ACCOUNT_TYPE_KEYS, nextAccountSortOrder, cents, refusal, refusals, refuse,
} from './helpers.js';

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
 * Body: { name, type?, starting_balance?, currency?, color?, credit_bank?, credit_limit? }
 * Response: { data: Account }
 */
router.post('/accounts', (req, res) => {
  try {
    const vName    = str(req.body.name, 'Name', { max: MAX_SHORT });
    const vType    = oneOf(req.body.type || 'checking', ACCOUNT_TYPE_KEYS, 'Account type');
    const vBalance = num(req.body.starting_balance ?? 0, 'Starting balance', { required: false });
    const vColor   = validateColor(req.body.color, 'Color', { allowTokens: true });
    const vBank    = req.body.credit_bank === undefined || req.body.credit_bank === null || req.body.credit_bank === ''
      ? { value: null, error: null }
      : str(req.body.credit_bank, 'Bank', { max: MAX_SHORT });
    const vLimit   = num(req.body.credit_limit, 'Credit limit', { required: false });
    const errors   = [
      ...refusals('account_name_invalid', [vName]),
      ...refusals('account_type_invalid', [vType]),
      ...refusals('account_balance_invalid', [vBalance]),
      ...refusals('account_color_invalid', [vColor]),
      ...refusals('account_credit_bank_invalid', [vBank]),
      ...refusals('account_credit_limit_invalid', [vLimit]),
    ];
    if (errors.length) return refuse(res, errors);
    if (vLimit.value !== null && vLimit.value < 0) {
      return refuse(res, [refusal('account_credit_limit_invalid', 'Credit limit must not be negative.')]);
    }

    const currency = req.body.currency ? str(req.body.currency, 'Currency', { max: 8 }).value : null;
    const color    = vColor.value;

    const result = db.get().prepare(`
      INSERT INTO budget_accounts (name, type, starting_balance, currency, color, sort_order, created_by, credit_bank, credit_limit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      vName.value, vType.value, cents(vBalance.value ?? 0),
      currency, color, nextAccountSortOrder(),
      req.authUserId || req.session.userId,
      vBank.value, vLimit.value === null ? null : cents(vLimit.value)
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
 * Konto aktualisieren (Name, Typ, Startsaldo, Währung, Farbe, Archiv-Status,
 * bei Kreditkarten zusätzlich Bank und Kreditlimit).
 * Response: { data: Account }
 */
router.put('/accounts/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = db.get().prepare('SELECT * FROM budget_accounts WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Account not found', code: 404 });

    const checks = [];
    if (req.body.name !== undefined) checks.push(['account_name_invalid', str(req.body.name, 'Name', { max: MAX_SHORT })]);
    if (req.body.type !== undefined) checks.push(['account_type_invalid', oneOf(req.body.type, ACCOUNT_TYPE_KEYS, 'Account type')]);
    if (req.body.starting_balance !== undefined) checks.push(['account_balance_invalid', num(req.body.starting_balance, 'Starting balance')]);
    if (req.body.color !== undefined) checks.push(['account_color_invalid', validateColor(req.body.color, 'Color', { allowTokens: true })]);
    if (req.body.credit_bank) checks.push(['account_credit_bank_invalid', str(req.body.credit_bank, 'Bank', { max: MAX_SHORT })]);
    if (req.body.credit_limit !== undefined) checks.push(['account_credit_limit_invalid', num(req.body.credit_limit, 'Credit limit', { required: false })]);
    const errors = checks.flatMap(([reason, result]) => refusals(reason, [result]));
    if (errors.length) return refuse(res, errors);

    const currency = req.body.currency !== undefined
      ? (req.body.currency ? str(req.body.currency, 'Currency', { max: 8 }).value : null)
      : existing.currency;
    const color = req.body.color !== undefined
      ? validateColor(req.body.color, 'Color', { allowTokens: true }).value
      : existing.color;
    const archived = req.body.archived !== undefined ? (req.body.archived ? 1 : 0) : existing.archived;
    // Leerer String und null löschen das Feld, `undefined` lässt es unangetastet -
    // sonst könnte ein Teil-Update Bank oder Limit unbeabsichtigt verwerfen.
    const creditBank = req.body.credit_bank !== undefined
      ? (req.body.credit_bank === '' || req.body.credit_bank === null ? null : String(req.body.credit_bank).trim())
      : existing.credit_bank;
    const creditLimit = req.body.credit_limit !== undefined
      ? (req.body.credit_limit === '' || req.body.credit_limit === null ? null : cents(req.body.credit_limit))
      : existing.credit_limit;
    if (creditLimit !== null && creditLimit < 0) {
      return refuse(res, [refusal('account_credit_limit_invalid', 'Credit limit must not be negative.')]);
    }

    db.get().prepare(`
      UPDATE budget_accounts
      SET name             = COALESCE(?, name),
          type             = COALESCE(?, type),
          starting_balance = COALESCE(?, starting_balance),
          currency         = ?,
          color            = ?,
          archived         = ?,
          credit_bank      = ?,
          credit_limit     = ?
      WHERE id = ?
    `).run(
      req.body.name !== undefined ? String(req.body.name).trim() : null,
      req.body.type !== undefined ? req.body.type : null,
      req.body.starting_balance !== undefined ? cents(req.body.starting_balance) : null,
      currency, color, archived, creditBank, creditLimit, id
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
      // Dasselbe für das Standardkonto eines Darlehens (#638) - künftige Raten
      // landen dann wieder ohne Kontobezug statt auf einer toten ID.
      db.get().prepare('UPDATE budget_loans SET account_id = NULL WHERE account_id = ?').run(id);
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
