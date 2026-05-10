/**
 * Module: Split Expenses
 * Purpose: Native shared expense, settlement, recurring, and ledger API.
 */

import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { collectErrors, date as validateDate, id as validateId, str, MAX_TEXT, MAX_TITLE } from '../middleware/validate.js';
import { buildSplits, decorateMoney, minorToDecimal, parseMoneyToMinor, simplifyDebts } from '../services/split-expenses.js';

const log = createLogger('SplitExpenses');
const router = express.Router();

const GROUP_TYPES = ['household', 'couple', 'travel', 'event', 'shopping', 'general'];
const GROUP_ROLES = ['owner', 'admin', 'guest'];
const SPLIT_METHODS = ['equal', 'exact', 'percentage', 'shares'];
const CATEGORIES = ['groceries', 'rent', 'utilities', 'baby', 'pets', 'school', 'travel', 'shopping', 'subscriptions', 'health', 'home', 'general'];
const CURRENCIES = ['AED', 'AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HUF', 'INR', 'JPY', 'NOK', 'PLN', 'RUB', 'SAR', 'SEK', 'TRY', 'UAH', 'USD'];
const FREQUENCIES = ['weekly', 'monthly', 'yearly'];

function userId(req) {
  return req.authUserId || req.session.userId;
}

function isSystemAdmin(req) {
  return req.authRole === 'admin' || req.session?.role === 'admin';
}

function defaultCurrency() {
  return db.get().prepare('SELECT value FROM sync_config WHERE key = ?').get('currency')?.value || 'EUR';
}

function memberRole(groupId, uid) {
  return db.get().prepare('SELECT role FROM expense_group_members WHERE group_id = ? AND user_id = ?').get(groupId, uid)?.role || null;
}

function canManageGroup(groupId, req) {
  const role = memberRole(groupId, userId(req));
  return isSystemAdmin(req) || role === 'owner' || role === 'admin';
}

function requireGroupAccess(groupId, req) {
  const group = db.get().prepare(`
    SELECT g.*, m.role AS member_role
    FROM expense_groups g
    LEFT JOIN expense_group_members m ON m.group_id = g.id AND m.user_id = ?
    WHERE g.id = ?
  `).get(userId(req), groupId);
  if (!group || (!group.member_role && !isSystemAdmin(req))) return null;
  return group;
}

function activity(groupId, actorId, type, entityType, entityId, metadata = {}) {
  db.get().prepare(`
    INSERT INTO expense_activity (group_id, actor_id, type, entity_type, entity_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(groupId, actorId, type, entityType, entityId, JSON.stringify(metadata));
}

function groupSelectWhere(where) {
  return `
    SELECT g.*,
           u.display_name AS creator_name,
           COUNT(DISTINCT gm.user_id) AS member_count,
           MAX(CASE WHEN gm.user_id = @userId THEN gm.role END) AS member_role
    FROM expense_groups g
    JOIN expense_group_members visible ON visible.group_id = g.id
    LEFT JOIN expense_group_members gm ON gm.group_id = g.id
    LEFT JOIN users u ON u.id = g.created_by
    WHERE ${where}
    GROUP BY g.id
  `;
}

function normalizeLedgerRow(row) {
  return {
    ...row,
    amount: minorToDecimal(row.amount_minor, row.currency),
  };
}

function loadExpense(expenseId, req) {
  const expense = db.get().prepare(`
    SELECT e.*, u.display_name AS payer_name, g.name AS group_name
    FROM expenses e
    JOIN expense_groups g ON g.id = e.group_id
    JOIN expense_group_members gm ON gm.group_id = e.group_id AND gm.user_id = @userId
    LEFT JOIN users u ON u.id = e.payer_id
    WHERE e.id = @expenseId AND e.status = 'active'
  `).get({ expenseId, userId: userId(req) });
  if (!expense && !isSystemAdmin(req)) return null;
  if (!expense && isSystemAdmin(req)) {
    return db.get().prepare(`
      SELECT e.*, u.display_name AS payer_name, g.name AS group_name
      FROM expenses e
      JOIN expense_groups g ON g.id = e.group_id
      LEFT JOIN users u ON u.id = e.payer_id
      WHERE e.id = ? AND e.status = 'active'
    `).get(expenseId);
  }
  return expense;
}

function serializeExpense(expense) {
  const splits = db.get().prepare(`
    SELECT s.user_id, s.amount_minor, s.currency, u.display_name
    FROM expense_splits s
    LEFT JOIN users u ON u.id = s.user_id
    WHERE s.expense_id = ?
    ORDER BY u.display_name COLLATE NOCASE ASC
  `).all(expense.id).map((row) => ({ ...row, amount: minorToDecimal(row.amount_minor, row.currency) }));
  const attachments = db.get().prepare(`
    SELECT a.id, a.document_id, a.kind, d.name, d.original_name, d.mime_type
    FROM expense_attachments a
    LEFT JOIN family_documents d ON d.id = a.document_id
    WHERE a.expense_id = ?
    ORDER BY a.created_at DESC
  `).all(expense.id);
  return {
    ...decorateMoney(expense, ['amount_minor', 'converted_amount_minor']),
    splits,
    attachments,
  };
}

function insertExpenseLedger(database, expense, splits, actorId, sourceType = 'expense') {
  const insert = database.prepare(`
    INSERT INTO expense_ledger_entries
      (group_id, source_type, source_id, user_id, counterparty_id, amount_minor, currency, memo, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(expense.group_id, sourceType, expense.id, expense.payer_id, null, expense.converted_amount_minor, expense.converted_currency, expense.title, actorId);
  for (const split of splits) {
    insert.run(expense.group_id, sourceType, expense.id, split.user_id, expense.payer_id, -split.amount_minor, split.currency, expense.title, actorId);
  }
}

function replaceExpenseSplits(database, expense, splits, actorId) {
  database.prepare('DELETE FROM expense_splits WHERE expense_id = ?').run(expense.id);
  database.prepare('DELETE FROM expense_ledger_entries WHERE source_type IN (?, ?) AND source_id = ?').run('expense', 'expense_reversal', expense.id);
  const insertSplit = database.prepare('INSERT INTO expense_splits (expense_id, user_id, amount_minor, currency) VALUES (?, ?, ?, ?)');
  for (const split of splits) insertSplit.run(expense.id, split.user_id, split.amount_minor, split.currency);
  insertExpenseLedger(database, expense, splits, actorId);
}

function parseExpenseBody(body, fallbackCurrency) {
  const currency = CURRENCIES.includes(body.currency) ? body.currency : fallbackCurrency;
  const convertedCurrency = CURRENCIES.includes(body.converted_currency) ? body.converted_currency : currency;
  const amountMinor = parseMoneyToMinor(body.amount, currency);
  const convertedAmountMinor = body.converted_amount
    ? parseMoneyToMinor(body.converted_amount, convertedCurrency, 'converted_amount')
    : amountMinor;
  const method = SPLIT_METHODS.includes(body.split_method) ? body.split_method : 'equal';
  const category = CATEGORIES.includes(body.category) ? body.category : 'general';
  const vTitle = str(body.title, 'Title', { max: MAX_TITLE });
  const vDescription = str(body.description, 'Description', { max: MAX_TEXT, required: false });
  const vDate = validateDate(body.expense_date, 'Expense date');
  const errors = collectErrors([vTitle, vDescription, vDate]);
  if (errors.length) throw new Error(errors.join(' '));
  return {
    title: vTitle.value,
    description: vDescription.value,
    amountMinor,
    currency,
    convertedAmountMinor,
    convertedCurrency,
    method,
    category,
    expenseDate: vDate.value || new Date().toISOString().slice(0, 10),
  };
}

router.get('/meta', (_req, res) => {
  res.json({ data: { group_types: GROUP_TYPES, group_roles: GROUP_ROLES, split_methods: SPLIT_METHODS, categories: CATEGORIES, currencies: CURRENCIES, frequencies: FREQUENCIES, default_currency: defaultCurrency() } });
});

router.get('/dashboard', (req, res) => {
  try {
    const uid = userId(req);
    const balances = db.get().prepare(`
      SELECT l.currency, l.user_id, u.display_name, SUM(l.amount_minor) AS net_minor
      FROM expense_ledger_entries l
      JOIN expense_group_members gm ON gm.group_id = l.group_id AND gm.user_id = @uid
      LEFT JOIN users u ON u.id = l.user_id
      GROUP BY l.currency, l.user_id
    `).all({ uid });
    const mine = balances.filter((row) => row.user_id === uid);
    const totalOwed = mine.filter((row) => row.net_minor > 0).map(normalizeLedgerRow);
    const totalOwing = mine.filter((row) => row.net_minor < 0).map((row) => normalizeLedgerRow({ ...row, amount_minor: -row.net_minor }));
    const groups = db.get().prepare(`${groupSelectWhere("visible.user_id = @userId AND g.status = 'active'")} ORDER BY g.updated_at DESC LIMIT 6`).all({ userId: uid });
    const recent = db.get().prepare(`
      SELECT e.*, g.name AS group_name, u.display_name AS payer_name
      FROM expenses e
      JOIN expense_groups g ON g.id = e.group_id
      JOIN expense_group_members gm ON gm.group_id = g.id AND gm.user_id = @uid
      LEFT JOIN users u ON u.id = e.payer_id
      WHERE e.status = 'active'
      ORDER BY e.expense_date DESC, e.created_at DESC
      LIMIT 8
    `).all({ uid }).map(serializeExpense);
    res.json({ data: { total_owed: totalOwed, total_owing: totalOwing, groups, recent_expenses: recent } });
  } catch (err) {
    log.error('GET /dashboard error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/groups', (req, res) => {
  try {
    const status = req.query.status === 'archived' ? 'archived' : 'active';
    const query = String(req.query.q || '').trim();
    const rows = db.get().prepare(`
      ${groupSelectWhere("visible.user_id = @userId AND g.status = @status AND (@query = '' OR g.name LIKE '%' || @query || '%')")}
      ORDER BY g.updated_at DESC
    `).all({ userId: userId(req), status, query });
    res.json({ data: rows });
  } catch (err) {
    log.error('GET /groups error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/groups', (req, res) => {
  try {
    const vName = str(req.body.name, 'Name', { max: MAX_TITLE });
    const vDescription = str(req.body.description, 'Description', { max: MAX_TEXT, required: false });
    const errors = collectErrors([vName, vDescription]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    const type = GROUP_TYPES.includes(req.body.type) ? req.body.type : 'general';
    const currency = CURRENCIES.includes(req.body.default_currency) ? req.body.default_currency : defaultCurrency();
    const result = db.transaction(() => {
      const created = db.get().prepare(`
        INSERT INTO expense_groups (name, description, type, default_currency, created_by)
        VALUES (?, ?, ?, ?, ?)
      `).run(vName.value, vDescription.value, type, currency, userId(req));
      db.get().prepare('INSERT INTO expense_group_members (group_id, user_id, role, invited_by) VALUES (?, ?, ?, ?)')
        .run(created.lastInsertRowid, userId(req), 'owner', userId(req));
      activity(created.lastInsertRowid, userId(req), 'group_created', 'group', created.lastInsertRowid, { name: vName.value });
      return created.lastInsertRowid;
    });
    const row = db.get().prepare(`${groupSelectWhere('g.id = @id AND visible.user_id = @userId')}`).get({ id: result, userId: userId(req) });
    res.status(201).json({ data: row });
  } catch (err) {
    log.error('POST /groups error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.patch('/groups/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!requireGroupAccess(id, req)) return res.status(404).json({ error: 'Group not found.', code: 404 });
    if (!canManageGroup(id, req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    const vName = req.body.name !== undefined ? str(req.body.name, 'Name', { max: MAX_TITLE }) : { value: undefined };
    const vDescription = req.body.description !== undefined ? str(req.body.description, 'Description', { max: MAX_TEXT, required: false }) : { value: undefined };
    const errors = collectErrors([vName, vDescription]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    const current = db.get().prepare('SELECT * FROM expense_groups WHERE id = ?').get(id);
    const type = GROUP_TYPES.includes(req.body.type) ? req.body.type : current.type;
    const currency = CURRENCIES.includes(req.body.default_currency) ? req.body.default_currency : current.default_currency;
    db.get().prepare(`
      UPDATE expense_groups SET name = ?, description = ?, type = ?, default_currency = ? WHERE id = ?
    `).run(vName.value ?? current.name, vDescription.value !== undefined ? vDescription.value : current.description, type, currency, id);
    activity(id, userId(req), 'group_updated', 'group', id);
    const row = db.get().prepare(`${groupSelectWhere('g.id = @id AND visible.user_id = @userId')}`).get({ id, userId: userId(req) });
    res.json({ data: row });
  } catch (err) {
    log.error('PATCH /groups/:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/groups/:id/archive', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!requireGroupAccess(id, req)) return res.status(404).json({ error: 'Group not found.', code: 404 });
    if (!canManageGroup(id, req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    db.get().prepare("UPDATE expense_groups SET status = 'archived', archived_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?").run(id);
    activity(id, userId(req), 'group_archived', 'group', id);
    res.json({ data: { ok: true } });
  } catch (err) {
    log.error('POST /groups/:id/archive error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/groups/:id/members', (req, res) => {
  try {
    const groupId = Number(req.params.id);
    if (!requireGroupAccess(groupId, req)) return res.status(404).json({ error: 'Group not found.', code: 404 });
    const rows = db.get().prepare(`
      SELECT gm.group_id, gm.user_id, gm.role, gm.joined_at, u.display_name, u.username, u.avatar_color, u.avatar_data
      FROM expense_group_members gm
      JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = ?
      ORDER BY CASE gm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.display_name COLLATE NOCASE ASC
    `).all(groupId);
    res.json({ data: rows });
  } catch (err) {
    log.error('GET /groups/:id/members error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/groups/:id/members', (req, res) => {
  try {
    const groupId = Number(req.params.id);
    if (!requireGroupAccess(groupId, req)) return res.status(404).json({ error: 'Group not found.', code: 404 });
    if (!canManageGroup(groupId, req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    const vUserId = validateId(req.body.user_id, 'user_id');
    if (vUserId.error) return res.status(400).json({ error: vUserId.error, code: 400 });
    const role = GROUP_ROLES.includes(req.body.role) && req.body.role !== 'owner' ? req.body.role : 'guest';
    const exists = db.get().prepare('SELECT 1 FROM users WHERE id = ?').get(vUserId.value);
    if (!exists) return res.status(404).json({ error: 'User not found.', code: 404 });
    db.get().prepare(`
      INSERT INTO expense_group_members (group_id, user_id, role, invited_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(group_id, user_id) DO UPDATE SET role = excluded.role
    `).run(groupId, vUserId.value, role, userId(req));
    activity(groupId, userId(req), 'member_added', 'member', vUserId.value, { role });
    res.status(201).json({ data: { group_id: groupId, user_id: vUserId.value, role } });
  } catch (err) {
    log.error('POST /groups/:id/members error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/groups/:id/expenses', (req, res) => {
  try {
    const groupId = Number(req.params.id);
    if (!requireGroupAccess(groupId, req)) return res.status(404).json({ error: 'Group not found.', code: 404 });
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const search = String(req.query.q || '').trim();
    const category = CATEGORIES.includes(req.query.category) ? req.query.category : null;
    const recurringOnly = req.query.recurring === '1';
    const rows = db.get().prepare(`
      SELECT e.*, u.display_name AS payer_name
      FROM expenses e
      LEFT JOIN users u ON u.id = e.payer_id
      WHERE e.group_id = @groupId AND e.status = 'active'
        AND (@search = '' OR e.title LIKE '%' || @search || '%' OR e.description LIKE '%' || @search || '%')
        AND (@category IS NULL OR e.category = @category)
        AND (@recurringOnly = 0 OR e.recurring_rule_id IS NOT NULL)
      ORDER BY e.expense_date DESC, e.created_at DESC
      LIMIT @limit OFFSET @offset
    `).all({ groupId, search, category, recurringOnly: recurringOnly ? 1 : 0, limit, offset }).map(serializeExpense);
    res.json({ data: rows, pagination: { limit, offset, has_more: rows.length === limit } });
  } catch (err) {
    log.error('GET /groups/:id/expenses error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/groups/:id/expenses', (req, res) => {
  try {
    const groupId = Number(req.params.id);
    const group = requireGroupAccess(groupId, req);
    if (!group) return res.status(404).json({ error: 'Group not found.', code: 404 });
    const parsed = parseExpenseBody(req.body, group.default_currency);
    const payerId = Number(req.body.payer_id || userId(req));
    if (!memberRole(groupId, payerId)) return res.status(400).json({ error: 'Payer must be a group member.', code: 400 });
    const participants = Array.isArray(req.body.participants) ? req.body.participants : [payerId];
    for (const participantId of participants) {
      if (!memberRole(groupId, Number(participantId))) return res.status(400).json({ error: 'All participants must be group members.', code: 400 });
    }
    const splits = buildSplits({
      method: parsed.method,
      amountMinor: parsed.convertedAmountMinor,
      currency: parsed.convertedCurrency,
      participants,
      splits: req.body.splits,
    });
    const createdId = db.transaction(() => {
      const result = db.get().prepare(`
        INSERT INTO expenses
          (group_id, title, description, amount_minor, currency, converted_amount_minor, converted_currency, exchange_snapshot, payer_id, category, split_method, expense_date, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(groupId, parsed.title, parsed.description, parsed.amountMinor, parsed.currency, parsed.convertedAmountMinor, parsed.convertedCurrency, JSON.stringify(req.body.exchange_snapshot || null), payerId, parsed.category, parsed.method, parsed.expenseDate, userId(req));
      const expense = db.get().prepare('SELECT * FROM expenses WHERE id = ?').get(result.lastInsertRowid);
      replaceExpenseSplits(db.get(), expense, splits, userId(req));
      if (Array.isArray(req.body.attachment_document_ids)) {
        const insertAttachment = db.get().prepare('INSERT OR IGNORE INTO expense_attachments (expense_id, document_id, kind, created_by) VALUES (?, ?, ?, ?)');
        for (const documentId of req.body.attachment_document_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)) {
          insertAttachment.run(expense.id, documentId, 'receipt', userId(req));
        }
      }
      activity(groupId, userId(req), 'expense_created', 'expense', expense.id, { title: parsed.title });
      return expense.id;
    });
    res.status(201).json({ data: serializeExpense(loadExpense(createdId, req)) });
  } catch (err) {
    const message = err.message || 'Invalid expense.';
    log.error('POST /groups/:id/expenses error:', err);
    res.status(message.includes('Internal') ? 500 : 400).json({ error: message, code: message.includes('Internal') ? 500 : 400 });
  }
});

router.put('/expenses/:id', (req, res) => {
  try {
    const existing = loadExpense(Number(req.params.id), req);
    if (!existing) return res.status(404).json({ error: 'Expense not found.', code: 404 });
    if (!canManageGroup(existing.group_id, req) && existing.created_by !== userId(req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    const parsed = parseExpenseBody(req.body, existing.converted_currency);
    const payerId = Number(req.body.payer_id || existing.payer_id);
    const participants = Array.isArray(req.body.participants) ? req.body.participants : db.get().prepare('SELECT user_id FROM expense_splits WHERE expense_id = ?').all(existing.id).map((r) => r.user_id);
    const splits = buildSplits({ method: parsed.method, amountMinor: parsed.convertedAmountMinor, currency: parsed.convertedCurrency, participants, splits: req.body.splits });
    db.transaction(() => {
      db.get().prepare(`
        UPDATE expenses
        SET title = ?, description = ?, amount_minor = ?, currency = ?, converted_amount_minor = ?, converted_currency = ?,
            exchange_snapshot = ?, payer_id = ?, category = ?, split_method = ?, expense_date = ?
        WHERE id = ?
      `).run(parsed.title, parsed.description, parsed.amountMinor, parsed.currency, parsed.convertedAmountMinor, parsed.convertedCurrency, JSON.stringify(req.body.exchange_snapshot || null), payerId, parsed.category, parsed.method, parsed.expenseDate, existing.id);
      const expense = db.get().prepare('SELECT * FROM expenses WHERE id = ?').get(existing.id);
      replaceExpenseSplits(db.get(), expense, splits, userId(req));
      activity(existing.group_id, userId(req), 'expense_edited', 'expense', existing.id, { title: parsed.title });
    });
    res.json({ data: serializeExpense(loadExpense(existing.id, req)) });
  } catch (err) {
    log.error('PUT /expenses/:id error:', err);
    res.status(400).json({ error: err.message || 'Invalid expense.', code: 400 });
  }
});

router.delete('/expenses/:id', (req, res) => {
  try {
    const existing = loadExpense(Number(req.params.id), req);
    if (!existing) return res.status(404).json({ error: 'Expense not found.', code: 404 });
    if (!canManageGroup(existing.group_id, req) && existing.created_by !== userId(req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    db.transaction(() => {
      db.get().prepare("UPDATE expenses SET status = 'deleted', deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?").run(existing.id);
      db.get().prepare('DELETE FROM expense_ledger_entries WHERE source_type = ? AND source_id = ?').run('expense', existing.id);
      activity(existing.group_id, userId(req), 'expense_deleted', 'expense', existing.id, { title: existing.title });
    });
    res.json({ data: { ok: true } });
  } catch (err) {
    log.error('DELETE /expenses/:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/expenses/:id/comments', (req, res) => {
  try {
    const expense = loadExpense(Number(req.params.id), req);
    if (!expense) return res.status(404).json({ error: 'Expense not found.', code: 404 });
    const vComment = str(req.body.comment, 'Comment', { max: MAX_TEXT });
    if (vComment.error) return res.status(400).json({ error: vComment.error, code: 400 });
    const result = db.get().prepare('INSERT INTO expense_comments (expense_id, user_id, comment) VALUES (?, ?, ?)').run(expense.id, userId(req), vComment.value);
    activity(expense.group_id, userId(req), 'comment_added', 'expense', expense.id);
    res.status(201).json({ data: { id: result.lastInsertRowid, expense_id: expense.id, user_id: userId(req), comment: vComment.value } });
  } catch (err) {
    log.error('POST /expenses/:id/comments error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/groups/:id/balances', (req, res) => {
  try {
    const groupId = Number(req.params.id);
    if (!requireGroupAccess(groupId, req)) return res.status(404).json({ error: 'Group not found.', code: 404 });
    const rows = db.get().prepare(`
      SELECT l.currency, l.user_id, u.display_name, SUM(l.amount_minor) AS net_minor
      FROM expense_ledger_entries l
      LEFT JOIN users u ON u.id = l.user_id
      WHERE l.group_id = ?
      GROUP BY l.currency, l.user_id
      HAVING net_minor != 0
      ORDER BY l.currency ASC, u.display_name COLLATE NOCASE ASC
    `).all(groupId);
    res.json({
      data: {
        balances: rows.map((row) => ({ ...row, net: minorToDecimal(row.net_minor, row.currency) })),
        simplified_debts: simplifyDebts(rows),
      },
    });
  } catch (err) {
    log.error('GET /groups/:id/balances error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/groups/:id/settlements', (req, res) => {
  try {
    const groupId = Number(req.params.id);
    const group = requireGroupAccess(groupId, req);
    if (!group) return res.status(404).json({ error: 'Group not found.', code: 404 });
    const payerId = Number(req.body.payer_id);
    const payeeId = Number(req.body.payee_id);
    if (!memberRole(groupId, payerId) || !memberRole(groupId, payeeId)) return res.status(400).json({ error: 'Settlement users must be group members.', code: 400 });
    if (payerId === payeeId) return res.status(400).json({ error: 'Settlement needs two different users.', code: 400 });
    const currency = CURRENCIES.includes(req.body.currency) ? req.body.currency : group.default_currency;
    const amountMinor = parseMoneyToMinor(req.body.amount, currency);
    const vNotes = str(req.body.notes, 'Notes', { max: MAX_TEXT, required: false });
    if (vNotes.error) return res.status(400).json({ error: vNotes.error, code: 400 });
    const settlementId = db.transaction(() => {
      const result = db.get().prepare(`
        INSERT INTO settlements (group_id, payer_id, payee_id, amount_minor, currency, notes, proof_document_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(groupId, payerId, payeeId, amountMinor, currency, vNotes.value, Number(req.body.proof_document_id) || null, userId(req));
      db.get().prepare('INSERT INTO settlement_entries (settlement_id, from_user_id, to_user_id, amount_minor, currency) VALUES (?, ?, ?, ?, ?)')
        .run(result.lastInsertRowid, payerId, payeeId, amountMinor, currency);
      const insert = db.get().prepare(`
        INSERT INTO expense_ledger_entries (group_id, source_type, source_id, user_id, counterparty_id, amount_minor, currency, memo, created_by)
        VALUES (?, 'settlement', ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run(groupId, result.lastInsertRowid, payerId, payeeId, amountMinor, currency, 'Settlement payment', userId(req));
      insert.run(groupId, result.lastInsertRowid, payeeId, payerId, -amountMinor, currency, 'Settlement payment', userId(req));
      activity(groupId, userId(req), 'payment_registered', 'settlement', result.lastInsertRowid, { amount: minorToDecimal(amountMinor, currency), currency });
      return result.lastInsertRowid;
    });
    const row = db.get().prepare('SELECT * FROM settlements WHERE id = ?').get(settlementId);
    res.status(201).json({ data: decorateMoney(row) });
  } catch (err) {
    log.error('POST /groups/:id/settlements error:', err);
    res.status(400).json({ error: err.message || 'Invalid settlement.', code: 400 });
  }
});

router.get('/groups/:id/activity', (req, res) => {
  try {
    const groupId = Number(req.params.id);
    if (!requireGroupAccess(groupId, req)) return res.status(404).json({ error: 'Group not found.', code: 404 });
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const rows = db.get().prepare(`
      SELECT a.*, u.display_name AS actor_name, u.avatar_color AS actor_color
      FROM expense_activity a
      LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.group_id = ?
      ORDER BY a.created_at DESC
      LIMIT ? OFFSET ?
    `).all(groupId, limit, offset).map((row) => ({ ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null }));
    res.json({ data: rows, pagination: { limit, offset, has_more: rows.length === limit } });
  } catch (err) {
    log.error('GET /groups/:id/activity error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/groups/:id/recurring', (req, res) => {
  try {
    const groupId = Number(req.params.id);
    if (!requireGroupAccess(groupId, req)) return res.status(404).json({ error: 'Group not found.', code: 404 });
    const rows = db.get().prepare('SELECT * FROM recurring_expenses WHERE group_id = ? ORDER BY paused_at IS NOT NULL ASC, next_run_date ASC').all(groupId)
      .map((row) => decorateMoney(row));
    res.json({ data: rows });
  } catch (err) {
    log.error('GET /groups/:id/recurring error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/groups/:id/recurring', (req, res) => {
  try {
    const groupId = Number(req.params.id);
    const group = requireGroupAccess(groupId, req);
    if (!group) return res.status(404).json({ error: 'Group not found.', code: 404 });
    const parsed = parseExpenseBody({ ...req.body, expense_date: req.body.next_run_date }, group.default_currency);
    const frequency = FREQUENCIES.includes(req.body.frequency) ? req.body.frequency : null;
    if (!frequency) return res.status(400).json({ error: 'Invalid frequency.', code: 400 });
    const payerId = Number(req.body.payer_id || userId(req));
    const participants = Array.isArray(req.body.participants) ? req.body.participants : [payerId];
    const snapshot = { participants, splits: req.body.splits || [] };
    const result = db.get().prepare(`
      INSERT INTO recurring_expenses
        (group_id, title, description, amount_minor, currency, payer_id, category, split_method, split_snapshot, frequency, next_run_date, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(groupId, parsed.title, parsed.description, parsed.amountMinor, parsed.currency, payerId, parsed.category, parsed.method, JSON.stringify(snapshot), frequency, parsed.expenseDate, userId(req));
    activity(groupId, userId(req), 'recurring_created', 'recurring_expense', result.lastInsertRowid, { title: parsed.title, frequency });
    const row = db.get().prepare('SELECT * FROM recurring_expenses WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ data: decorateMoney(row) });
  } catch (err) {
    log.error('POST /groups/:id/recurring error:', err);
    res.status(400).json({ error: err.message || 'Invalid recurring expense.', code: 400 });
  }
});

router.post('/recurring/:id/pause', (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = db.get().prepare('SELECT * FROM recurring_expenses WHERE id = ?').get(id);
    if (!row || !requireGroupAccess(row.group_id, req)) return res.status(404).json({ error: 'Recurring expense not found.', code: 404 });
    if (!canManageGroup(row.group_id, req) && row.created_by !== userId(req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    db.get().prepare("UPDATE recurring_expenses SET paused_at = CASE WHEN paused_at IS NULL THEN strftime('%Y-%m-%dT%H:%M:%SZ', 'now') ELSE NULL END WHERE id = ?").run(id);
    activity(row.group_id, userId(req), row.paused_at ? 'recurring_resumed' : 'recurring_paused', 'recurring_expense', id);
    res.json({ data: decorateMoney(db.get().prepare('SELECT * FROM recurring_expenses WHERE id = ?').get(id)) });
  } catch (err) {
    log.error('POST /recurring/:id/pause error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/search', (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const uid = userId(req);
    const groups = db.get().prepare(`
      ${groupSelectWhere("visible.user_id = @userId AND g.status = 'active' AND (@q = '' OR g.name LIKE '%' || @q || '%')")}
      ORDER BY g.updated_at DESC LIMIT 10
    `).all({ userId: uid, q });
    const expenses = db.get().prepare(`
      SELECT e.*, g.name AS group_name, u.display_name AS payer_name
      FROM expenses e
      JOIN expense_groups g ON g.id = e.group_id
      JOIN expense_group_members gm ON gm.group_id = g.id AND gm.user_id = @uid
      LEFT JOIN users u ON u.id = e.payer_id
      WHERE e.status = 'active' AND (@q = '' OR e.title LIKE '%' || @q || '%' OR e.description LIKE '%' || @q || '%')
      ORDER BY e.expense_date DESC LIMIT 10
    `).all({ uid, q }).map(serializeExpense);
    const people = db.get().prepare(`
      SELECT DISTINCT u.id, u.display_name, u.username, u.avatar_color
      FROM users u
      JOIN expense_group_members gm ON gm.user_id = u.id
      JOIN expense_group_members mine ON mine.group_id = gm.group_id AND mine.user_id = @uid
      WHERE @q = '' OR u.display_name LIKE '%' || @q || '%' OR u.username LIKE '%' || @q || '%'
      ORDER BY u.display_name COLLATE NOCASE ASC LIMIT 10
    `).all({ uid, q });
    res.json({ data: { groups, expenses, people } });
  } catch (err) {
    log.error('GET /search error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
