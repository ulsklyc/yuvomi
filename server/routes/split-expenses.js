/**
 * Module: Split Expenses
 * Purpose: Native shared expense, settlement, recurring, and ledger API.
 */

import express from 'express';
import crypto from 'node:crypto';
import * as db from '../db.js';
import { hashPassword, normalizePassword } from '../utils/password.js';
import { createLogger } from '../logger.js';
import { collectErrors, date as validateDate, id as validateId, str, MAX_TEXT, MAX_TITLE } from '../middleware/validate.js';
import { documentLinksFor, loadDocumentLinks, replaceDocumentLinks, visibleDocumentRef } from '../services/document-links.js';
import { sendDocumentDeletionConflict } from '../services/document-deletion-lock.js';
import { buildSplits, decorateMoney, minorToDecimal, parseMoneyToMinor, simplifyDebts } from '../services/split-expenses.js';
import { CURRENCY_CODES } from '../../public/utils/currency-codes.js';
import { syncBirthdayArtifacts } from '../services/birthdays.js';
import { todayKey } from '../utils/timezone.js';

const log = createLogger('SplitExpenses');
const router = express.Router();

const avatarColors = ['#007AFF', '#34C759', '#FF9500', '#FF3B30', '#AF52DE', '#FF2D55'];
const randomAvatarColor = () => avatarColors[Math.floor(Math.random() * avatarColors.length)];

// Derselbe Waehrungsvorrat wie in den Einstellungen und in den Abos - eine
// Liste fuer Server und Browser (#841, public/utils/currency-codes.js).
const GROUP_TYPES = ['household', 'couple', 'travel', 'event', 'shopping', 'general'];
const GROUP_ROLES = ['owner', 'admin', 'guest'];
const SPLIT_METHODS = ['equal', 'exact', 'percentage', 'shares'];
const CATEGORIES = ['groceries', 'rent', 'utilities', 'baby', 'pets', 'school', 'travel', 'shopping', 'subscriptions', 'health', 'home', 'general'];
const FREQUENCIES = ['weekly', 'monthly', 'yearly'];
const FAMILY_ROLES = ['dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other'];

function userId(req) {
  return req.authUserId || req.session.userId;
}

/**
 * Gast-Confinement in einer Abfrage. Ergebnis:
 *   null                 - unbeschränktes Konto
 *   { groupId: 7 }       - Gast, sieht ausschließlich Gruppe 7
 *   { groupId: null }    - Gast, dessen Gruppe gelöscht wurde: sieht nichts
 *
 * Die beiden Aussagen "ist beschränkt" (Existenz der Zeile) und "worauf"
 * (group_id) müssen getrennt bleiben. Wer nur die group_id abfragt und ihr
 * Fehlen als "unbeschränkt" liest, hebt das Confinement auf, sobald eine
 * Gruppe gelöscht wird - das war die Rechteausweitung, die Migration 124
 * schließt.
 */
function splitGuestScope(req) {
  const row = db.get().prepare('SELECT group_id FROM split_expense_guest_users WHERE user_id = ?').get(userId(req));
  return row ? { groupId: row.group_id ?? null } : null;
}

function isSplitGuest(req) {
  return Boolean(splitGuestScope(req));
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
  if (isSplitGuest(req)) return false;
  const role = memberRole(groupId, userId(req));
  return isSystemAdmin(req) || role === 'owner' || role === 'admin';
}

function requireGroupAccess(groupId, req) {
  const guest = splitGuestScope(req);
  // Gast ohne Gruppe (gelöschte Gruppe) erreicht keine Gruppe mehr - nicht jede.
  if (guest && (guest.groupId == null || Number(guest.groupId) !== Number(groupId))) return null;
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

function slugifyUsername(value) {
  return String(value || 'guest')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 48) || 'guest';
}

function uniqueUsername(base) {
  const normalized = slugifyUsername(base);
  let username = normalized.length >= 3 ? normalized : `${normalized}.guest`;
  const exists = db.get().prepare('SELECT 1 FROM users WHERE username = ?');
  let i = 2;
  while (exists.get(username)) {
    username = `${normalized}.${i}`.slice(0, 64);
    i += 1;
  }
  return username;
}

async function userFromContact(database, contactId, actorId) {
  const contact = database.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
  if (!contact) throw new Error('Contact not found.');
  if (contact.family_user_id) return contact.family_user_id;
  const username = uniqueUsername(contact.name);
  const passwordHash = await hashPassword(crypto.randomBytes(24).toString('base64url'));
  const created = database.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
    VALUES (?, ?, ?, ?, 'member', 'other')
  `).run(username, contact.name, passwordHash, randomAvatarColor());
  database.prepare('UPDATE contacts SET family_user_id = ? WHERE id = ?').run(created.lastInsertRowid, contact.id);
  if (contact.birthday) {
    syncGuestArtifacts(database, created.lastInsertRowid, {
      displayName: contact.name,
      phone: contact.phone,
      email: contact.email,
      birthDate: contact.birthday,
      actorUserId: actorId,
    });
  }
  return created.lastInsertRowid;
}

function syncGuestArtifacts(database, userId, { displayName, phone, email, birthDate, actorUserId }) {
  const contact = database.prepare('SELECT id, name FROM contacts WHERE family_user_id = ?').get(userId);
  if (contact) {
    database.prepare(`
      UPDATE contacts SET name = ?, category = COALESCE(category, 'misc'), phone = ?, email = ?
      WHERE id = ?
    `).run(displayName, phone || null, email || null, contact.id);

    // Namensteile eines gespiegelten Gast-Kontakts veralten mit dem Anzeigenamen
    // (#535, wie in server/auth.js#syncFamilyMemberArtifacts).
    if (contact.name !== displayName) {
      database.prepare(`
        UPDATE contacts
        SET first_name = NULL, last_name = NULL, middle_name = NULL,
            name_prefix = NULL, name_suffix = NULL
        WHERE id = ?
      `).run(contact.id);
    }
  } else {
    database.prepare(`
      INSERT INTO contacts (name, category, phone, email, family_user_id)
      VALUES (?, 'misc', ?, ?, ?)
    `).run(displayName, phone || null, email || null, userId);
  }

  if (!birthDate) return;
  const existing = database.prepare('SELECT * FROM birthdays WHERE family_user_id = ?').get(userId);
  let birthday;
  if (existing) {
    database.prepare(`
      UPDATE birthdays
      SET name = ?, birth_date = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
    `).run(displayName, birthDate, existing.id);
    birthday = database.prepare('SELECT * FROM birthdays WHERE id = ?').get(existing.id);
  } else {
    const created = database.prepare(`
      INSERT INTO birthdays (name, birth_date, created_by, family_user_id)
      VALUES (?, ?, ?, ?)
    `).run(displayName, birthDate, actorUserId, userId);
    birthday = database.prepare('SELECT * FROM birthdays WHERE id = ?').get(created.lastInsertRowid);
  }
  syncBirthdayArtifacts(database, birthday);
}

function loadExpense(expenseId, req) {
  // Die Mitgliedschaft allein reicht als Zugang nicht: ein Gast kann zusätzlich
  // in fremden Gruppen stehen. Ohne diesen Filter erreicht er deren Ausgaben
  // per ID - lesend, kommentierend und als deren Ersteller auch schreibend.
  const guest = splitGuestScope(req);
  const expense = db.get().prepare(`
    SELECT e.*, u.display_name AS payer_name, g.name AS group_name
    FROM expenses e
    JOIN expense_groups g ON g.id = e.group_id
    JOIN expense_group_members gm ON gm.group_id = e.group_id AND gm.user_id = @userId
    LEFT JOIN users u ON u.id = e.payer_id
    WHERE e.id = @expenseId AND e.status = 'active'
      AND (@isGuest = 0 OR e.group_id = @restrictedGroupId)
  `).get({
    expenseId,
    userId: userId(req),
    restrictedGroupId: guest?.groupId ?? null,
    isGuest: guest ? 1 : 0,
  });
  // Der Admin-Bypass gilt nicht für Gastkonten - sonst hinge das Confinement an
  // der Annahme, dass ein Gast nie die Admin-Rolle trägt.
  if (!expense && (!isSystemAdmin(req) || guest)) return null;
  if (!expense) {
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

// Belege einer Ausgabe: Tabellen-Adresse für den geteilten Verknüpfungs-Service.
const EXPENSE_ATTACHMENTS = { table: 'expense_attachments', ownerColumn: 'expense_id', extraColumns: ['kind'] };

function serializeExpense(expense, prefetched, viewerId) {
  const splits = prefetched
    ? (prefetched.splits.get(expense.id) || [])
    : db.get().prepare(`
        SELECT s.user_id, s.amount_minor, s.currency, u.display_name
        FROM expense_splits s
        LEFT JOIN users u ON u.id = s.user_id
        WHERE s.expense_id = ?
        ORDER BY u.display_name COLLATE NOCASE ASC
      `).all(expense.id).map((row) => ({ ...row, amount: minorToDecimal(row.amount_minor, row.currency) }));
  // Belege laufen über die Sichtbarkeit des Dokumente-Moduls (#583): ein privat
  // abgelegter Beleg bleibt privat, auch wenn die Ausgabe der ganzen Gruppe
  // gehört. Vorher lieferte der Join den Namen an jedes Gruppenmitglied aus.
  const attachments = prefetched
    ? (prefetched.attachments.get(expense.id) || [])
    : documentLinksFor(db.get(), { ...EXPENSE_ATTACHMENTS, ownerId: expense.id, userId: viewerId });
  return {
    ...decorateMoney(expense, ['amount_minor', 'converted_amount_minor']),
    splits,
    attachments,
  };
}

/**
 * Serialize a list of expenses, batch-loading splits and attachments for all
 * rows in 2 queries total (WHERE expense_id IN (...)) instead of 2 per row.
 * Kills the N+1 in the list endpoints (was up to ~201 queries for 100 rows).
 */
function serializeExpenseList(expenses, viewerId) {
  if (!expenses.length) return [];
  const ids = expenses.map((e) => e.id);
  const placeholders = ids.map(() => '?').join(', ');

  const splits = new Map();
  for (const row of db.get().prepare(`
    SELECT s.expense_id, s.user_id, s.amount_minor, s.currency, u.display_name
    FROM expense_splits s
    LEFT JOIN users u ON u.id = s.user_id
    WHERE s.expense_id IN (${placeholders})
    ORDER BY u.display_name COLLATE NOCASE ASC
  `).all(...ids)) {
    const { expense_id, ...rest } = row;
    if (!splits.has(expense_id)) splits.set(expense_id, []);
    splits.get(expense_id).push({ ...rest, amount: minorToDecimal(rest.amount_minor, rest.currency) });
  }

  const attachments = loadDocumentLinks(db.get(), { ...EXPENSE_ATTACHMENTS, ownerIds: ids, userId: viewerId });

  const prefetched = { splits, attachments };
  return expenses.map((expense) => serializeExpense(expense, prefetched, viewerId));
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
  const currency = CURRENCY_CODES.includes(body.currency) ? body.currency : fallbackCurrency;
  const convertedCurrency = CURRENCY_CODES.includes(body.converted_currency) ? body.converted_currency : currency;
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
    expenseDate: vDate.value || todayKey(db.get()),
  };
}

// Standard-Aufteilung einer Gruppe (#517): validiert Methode + optionale
// pro-Mitglied-Werte, mit denen neue Ausgaben vorbelegt werden. Nur
// percentage/shares tragen eine Config; Einträge für Nicht-Mitglieder oder mit
// ungültigem Format werden verworfen. Bewusst KEINE 100%-Pflicht - das ist eine
// Vorbelegung, die finale Validierung passiert pro Ausgabe in buildSplits, und so
// bleibt die Config robust, wenn sich der Mitgliederkreis später ändert.
function normalizeSplitDefaults(body, groupId, fallbackMethod = 'equal') {
  const method = SPLIT_METHODS.includes(body.default_split_method) ? body.default_split_method : fallbackMethod;
  if (method !== 'percentage' && method !== 'shares') return { method, config: null };
  const members = new Set(
    db.get().prepare('SELECT user_id FROM expense_group_members WHERE group_id = ?').all(groupId).map((r) => Number(r.user_id)),
  );
  const raw = Array.isArray(body.default_split_config) ? body.default_split_config : [];
  const entries = [];
  const seen = new Set();
  for (const item of raw) {
    const uid = Number(item?.user_id);
    if (!members.has(uid) || seen.has(uid)) continue;
    if (method === 'percentage') {
      const pct = String(item?.percentage ?? '').trim();
      if (!/^\d+(\.\d{1,2})?$/.test(pct) || Number(pct) < 0 || Number(pct) > 100) continue;
      entries.push({ user_id: uid, percentage: pct });
    } else {
      const shares = Number(item?.shares);
      if (!Number.isInteger(shares) || shares <= 0) continue;
      entries.push({ user_id: uid, shares });
    }
    seen.add(uid);
  }
  return { method, config: entries.length ? JSON.stringify(entries) : null };
}

router.get('/meta', (_req, res) => {
  try {
    res.json({ data: { group_types: GROUP_TYPES, group_roles: GROUP_ROLES, split_methods: SPLIT_METHODS, categories: CATEGORIES, currencies: CURRENCY_CODES, frequencies: FREQUENCIES, default_currency: defaultCurrency() } });
  } catch (err) {
    log.error('GET /meta error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/dashboard', (req, res) => {
  try {
    const uid = userId(req);
    // Alle drei Abfragen tragen dasselbe Confinement: die Mitgliedschaft allein
    // reicht nicht, ein Gast kann zusätzlich in fremden Gruppen stehen. Der
    // Filter hängt am Gast-Status, nicht an der group_id - ein Gast ohne Gruppe
    // sieht nichts, nicht alles.
    const guest = splitGuestScope(req);
    const restrictedGroupId = guest?.groupId ?? null;
    const isGuest = guest ? 1 : 0;
    const balances = db.get().prepare(`
      SELECT l.currency, l.user_id, u.display_name, SUM(l.amount_minor) AS net_minor
      FROM expense_ledger_entries l
      JOIN expense_group_members gm ON gm.group_id = l.group_id AND gm.user_id = @uid
      JOIN expense_groups g ON g.id = l.group_id AND g.status = 'active'
      LEFT JOIN users u ON u.id = l.user_id
      WHERE (@isGuest = 0 OR l.group_id = @restrictedGroupId)
      GROUP BY l.currency, l.user_id
    `).all({ uid, restrictedGroupId, isGuest });
    const mine = balances.filter((row) => row.user_id === uid);
    const totalOwed = mine.filter((row) => row.net_minor > 0).map((row) => normalizeLedgerRow({ ...row, amount_minor: row.net_minor }));
    const totalOwing = mine.filter((row) => row.net_minor < 0).map((row) => normalizeLedgerRow({ ...row, amount_minor: -row.net_minor }));
    const groupWhere = guest
      ? "visible.user_id = @userId AND g.status = 'active' AND g.id = @restrictedGroupId"
      : "visible.user_id = @userId AND g.status = 'active'";
    // groupId === null (gelöschte Gruppe) trifft über `g.id = NULL` keine Zeile.
    const groups = db.get().prepare(`${groupSelectWhere(groupWhere)} ORDER BY g.updated_at DESC LIMIT 6`)
      .all({ userId: uid, restrictedGroupId });
    const recent = db.get().prepare(`
      SELECT e.*, g.name AS group_name, u.display_name AS payer_name
      FROM expenses e
      JOIN expense_groups g ON g.id = e.group_id
      JOIN expense_group_members gm ON gm.group_id = g.id AND gm.user_id = @uid
      LEFT JOIN users u ON u.id = e.payer_id
      WHERE e.status = 'active'
        AND (@isGuest = 0 OR e.group_id = @restrictedGroupId)
      ORDER BY e.expense_date DESC, e.created_at DESC
      LIMIT 8
    `).all({ uid, restrictedGroupId, isGuest });
    const recentSerialized = serializeExpenseList(recent, userId(req));
    res.json({ data: { total_owed: totalOwed, total_owing: totalOwing, groups, recent_expenses: recentSerialized } });
  } catch (err) {
    log.error('GET /dashboard error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/groups', (req, res) => {
  try {
    const status = req.query.status === 'archived' ? 'archived' : 'active';
    const query = String(req.query.q || '').trim();
    const guest = splitGuestScope(req);
    const rows = db.get().prepare(`
      ${groupSelectWhere(`visible.user_id = @userId AND g.status = @status AND (@query = '' OR g.name LIKE '%' || @query || '%')${guest ? ' AND g.id = @restrictedGroupId' : ''}`)}
      ORDER BY g.updated_at DESC
    `).all({ userId: userId(req), status, query, restrictedGroupId: guest?.groupId ?? null });
    res.json({ data: rows });
  } catch (err) {
    log.error('GET /groups error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/groups', (req, res) => {
  try {
    if (isSplitGuest(req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    const vName = str(req.body.name, 'Name', { max: MAX_TITLE });
    const vDescription = str(req.body.description, 'Description', { max: MAX_TEXT, required: false });
    const errors = collectErrors([vName, vDescription]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    const type = GROUP_TYPES.includes(req.body.type) ? req.body.type : 'general';
    const currency = CURRENCY_CODES.includes(req.body.default_currency) ? req.body.default_currency : defaultCurrency();
    // Beim Anlegen existiert nur der Owner als Mitglied - eine pro-Mitglied-Config
    // ist hier noch nicht sinnvoll (das Frontend bietet den Editor erst im
    // Bearbeiten-Dialog). Nur die Methode wird direkt übernommen.
    const defaultMethod = SPLIT_METHODS.includes(req.body.default_split_method) ? req.body.default_split_method : 'equal';
    const result = db.transaction(() => {
      const created = db.get().prepare(`
        INSERT INTO expense_groups (name, description, type, default_currency, default_split_method, created_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(vName.value, vDescription.value, type, currency, defaultMethod, userId(req));
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
    const currency = CURRENCY_CODES.includes(req.body.default_currency) ? req.body.default_currency : current.default_currency;
    // Standard-Aufteilung nur anfassen, wenn der Client sie mitschickt (#517).
    let defaultMethod = current.default_split_method;
    let defaultConfig = current.default_split_config;
    if (req.body.default_split_method !== undefined || req.body.default_split_config !== undefined) {
      const norm = normalizeSplitDefaults(req.body, id, current.default_split_method);
      defaultMethod = norm.method;
      defaultConfig = norm.config;
    }
    db.get().prepare(`
      UPDATE expense_groups SET name = ?, description = ?, type = ?, default_currency = ?, default_split_method = ?, default_split_config = ? WHERE id = ?
    `).run(vName.value ?? current.name, vDescription.value !== undefined ? vDescription.value : current.description, type, currency, defaultMethod, defaultConfig, id);
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

// Gegenstück zu /archive (#574): ohne diese Route wäre Archivieren eine
// Einbahnstraße - archivierte Gruppen sind über ?status=archived sichtbar,
// aber ohne Weg zurück in die aktive Liste.
router.post('/groups/:id/unarchive', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!requireGroupAccess(id, req)) return res.status(404).json({ error: 'Group not found.', code: 404 });
    if (!canManageGroup(id, req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    db.get().prepare("UPDATE expense_groups SET status = 'active', archived_at = NULL WHERE id = ?").run(id);
    activity(id, userId(req), 'group_unarchived', 'group', id);
    res.json({ data: { ok: true } });
  } catch (err) {
    log.error('POST /groups/:id/unarchive error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.delete('/groups/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!requireGroupAccess(id, req)) return res.status(404).json({ error: 'Group not found.', code: 404 });
    if (!canManageGroup(id, req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    const usage = db.get().prepare(`
      SELECT
        (SELECT COUNT(*) FROM expenses WHERE group_id = ?) AS expenses,
        (SELECT COUNT(*) FROM settlements WHERE group_id = ?) AS settlements
    `).get(id, id);
    if ((usage.expenses || 0) > 0 || (usage.settlements || 0) > 0) {
      return res.status(409).json({ error: 'Groups with financial history must be archived instead of deleted.', code: 409 });
    }
    db.get().prepare('DELETE FROM expense_groups WHERE id = ?').run(id);
    res.json({ data: { ok: true } });
  } catch (err) {
    log.error('DELETE /groups/:id error:', err);
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

router.get('/groups/:id/member-candidates', (req, res) => {
  try {
    const groupId = Number(req.params.id);
    if (!requireGroupAccess(groupId, req)) return res.status(404).json({ error: 'Group not found.', code: 404 });
    if (isSplitGuest(req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    const people = db.get().prepare(`
      SELECT 'user' AS source, u.id AS user_id, NULL AS contact_id, u.display_name, u.username,
             u.avatar_color, u.family_role, c.phone, c.email, b.birth_date,
             CASE WHEN gm.user_id IS NULL THEN 0 ELSE 1 END AS in_group,
             gm.role AS group_role
      FROM users u
      LEFT JOIN contacts c ON c.family_user_id = u.id
      LEFT JOIN birthdays b ON b.family_user_id = u.id
      LEFT JOIN expense_group_members gm ON gm.group_id = ? AND gm.user_id = u.id
      WHERE NOT EXISTS (SELECT 1 FROM housekeeping_workers hw WHERE hw.user_id = u.id)
      ORDER BY u.display_name COLLATE NOCASE ASC
    `).all(groupId);
    const contacts = db.get().prepare(`
      SELECT 'contact' AS source, NULL AS user_id, c.id AS contact_id, c.name AS display_name,
             NULL AS username, '#2563EB' AS avatar_color, 'other' AS family_role,
             c.phone, c.email, c.birthday AS birth_date, 0 AS in_group, NULL AS group_role
      FROM contacts c
      WHERE c.family_user_id IS NULL
      ORDER BY c.name COLLATE NOCASE ASC
    `).all();
    res.json({ data: [...people, ...contacts] });
  } catch (err) {
    log.error('GET /groups/:id/member-candidates error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/groups/:id/members', async (req, res) => {
  try {
    const groupId = Number(req.params.id);
    if (!requireGroupAccess(groupId, req)) return res.status(404).json({ error: 'Group not found.', code: 404 });
    if (!canManageGroup(groupId, req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    const vUserId = req.body.user_id ? validateId(req.body.user_id, 'user_id') : { value: null, error: null };
    const vContactId = req.body.contact_id ? validateId(req.body.contact_id, 'contact_id') : { value: null, error: null };
    if (vUserId.error || vContactId.error) return res.status(400).json({ error: vUserId.error || vContactId.error, code: 400 });
    const role = GROUP_ROLES.includes(req.body.role) && req.body.role !== 'owner' ? req.body.role : 'guest';
    const memberUserId = vContactId.value ? await userFromContact(db.get(), vContactId.value, userId(req)) : vUserId.value;
    if (!memberUserId) return res.status(400).json({ error: 'user_id or contact_id is required.', code: 400 });
    const exists = db.get().prepare('SELECT 1 FROM users WHERE id = ?').get(memberUserId);
    if (!exists) return res.status(404).json({ error: 'User not found.', code: 404 });
    db.get().prepare(`
      INSERT INTO expense_group_members (group_id, user_id, role, invited_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(group_id, user_id) DO UPDATE SET role = excluded.role
    `).run(groupId, memberUserId, role, userId(req));
    activity(groupId, userId(req), 'member_added', 'member', memberUserId, { role });
    res.status(201).json({ data: { group_id: groupId, user_id: memberUserId, role } });
  } catch (err) {
    log.error('POST /groups/:id/members error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.delete('/groups/:id/members/:userId', (req, res) => {
  try {
    const groupId = Number(req.params.id);
    const memberUserId = Number(req.params.userId);
    if (!requireGroupAccess(groupId, req)) return res.status(404).json({ error: 'Group not found.', code: 404 });
    if (!canManageGroup(groupId, req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    const target = db.get().prepare('SELECT role FROM expense_group_members WHERE group_id = ? AND user_id = ?').get(groupId, memberUserId);
    if (!target) return res.status(404).json({ error: 'Member not found.', code: 404 });
    if (target.role === 'owner') return res.status(400).json({ error: 'Group owner cannot be removed.', code: 400 });
    db.get().prepare('DELETE FROM expense_group_members WHERE group_id = ? AND user_id = ?').run(groupId, memberUserId);
    activity(groupId, userId(req), 'member_removed', 'member', memberUserId);
    res.json({ data: { ok: true } });
  } catch (err) {
    log.error('DELETE /groups/:id/members/:userId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/groups/:id/guests', async (req, res) => {
  try {
    const groupId = Number(req.params.id);
    if (!requireGroupAccess(groupId, req)) return res.status(404).json({ error: 'Group not found.', code: 404 });
    if (!canManageGroup(groupId, req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });

    const vDisplayName = str(req.body.display_name, 'Display name', { max: 128 });
    const vPhone = str(req.body.phone, 'Phone', { max: 100, required: false });
    const vEmail = str(req.body.email, 'Email', { max: 200, required: false });
    const vBirthDate = validateDate(req.body.birth_date, 'Birth date');
    const errors = collectErrors([vDisplayName, vPhone, vEmail, vBirthDate]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    const password = String(req.body.password || '');
    if (normalizePassword(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters long.', code: 400 });
    const familyRole = FAMILY_ROLES.includes(req.body.family_role) ? req.body.family_role : 'other';
    const username = req.body.username && /^[a-zA-Z0-9._-]{3,64}$/.test(req.body.username)
      ? String(req.body.username)
      : uniqueUsername(vDisplayName.value);
    const exists = db.get().prepare('SELECT 1 FROM users WHERE username = ?').get(username);
    if (exists) return res.status(409).json({ error: 'Username is already taken.', code: 409 });
    const hash = await hashPassword(password);

    const createdUserId = db.transaction(() => {
      const created = db.get().prepare(`
        INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
        VALUES (?, ?, ?, ?, 'member', ?)
      `).run(username, vDisplayName.value, hash, randomAvatarColor(), familyRole);
      syncGuestArtifacts(db.get(), created.lastInsertRowid, {
        displayName: vDisplayName.value,
        phone: vPhone.value,
        email: vEmail.value,
        birthDate: vBirthDate.value,
        actorUserId: userId(req),
      });
      db.get().prepare('INSERT INTO expense_group_members (group_id, user_id, role, invited_by) VALUES (?, ?, ?, ?)')
        .run(groupId, created.lastInsertRowid, 'guest', userId(req));
      db.get().prepare('INSERT OR IGNORE INTO split_expense_guest_users (user_id, group_id, created_by) VALUES (?, ?, ?)')
        .run(created.lastInsertRowid, groupId, userId(req));
      activity(groupId, userId(req), 'guest_created', 'member', created.lastInsertRowid, { display_name: vDisplayName.value });
      return created.lastInsertRowid;
    });

    const user = db.get().prepare(`
      SELECT u.id, u.username, u.display_name, u.avatar_color, u.avatar_data, u.family_role,
             c.phone, c.email, b.birth_date, u.created_at
      FROM users u
      LEFT JOIN contacts c ON c.family_user_id = u.id
      LEFT JOIN birthdays b ON b.family_user_id = u.id
      WHERE u.id = ?
    `).get(createdUserId);
    res.status(201).json({ data: user });
  } catch (err) {
    log.error('POST /groups/:id/guests error:', err);
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
    `).all({ groupId, search, category, recurringOnly: recurringOnly ? 1 : 0, limit, offset });
    const serialized = serializeExpenseList(rows, userId(req));
    res.json({ data: serialized, pagination: { limit, offset, has_more: serialized.length === limit } });
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
      // Belege (#583): nur sichtbare Dokumente, sonst liesse sich über geratene
      // IDs der Name eines fremden Dokuments auslesen.
      replaceDocumentLinks(db.get(), {
        ...EXPENSE_ATTACHMENTS,
        ownerId: expense.id,
        documentIds: req.body.attachment_document_ids,
        userId: userId(req),
        extraValues: { kind: 'receipt' },
      });
      activity(groupId, userId(req), 'expense_created', 'expense', expense.id, { title: parsed.title });
      return expense.id;
    });
    res.status(201).json({ data: serializeExpense(loadExpense(createdId, req), null, userId(req)) });
  } catch (err) {
    if (sendDocumentDeletionConflict(res, err)) return;
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
    // Dieselbe Regel wie beim Anlegen (GHSA-4p5w-5346-8598): Zahler und
    // Beteiligte muessen Mitglieder DIESER Gruppe sein. Der PUT nahm die IDs
    // bisher ungeprueft - ein Mitglied konnte einer Person, die nie in der
    // Gruppe war, eine Schuld zuschreiben, die diese nirgends sieht und nicht
    // bestreiten kann.
    if (!memberRole(existing.group_id, payerId)) return res.status(400).json({ error: 'Payer must be a group member.', code: 400 });
    for (const participantId of participants) {
      if (!memberRole(existing.group_id, Number(participantId))) return res.status(400).json({ error: 'All participants must be group members.', code: 400 });
    }
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
      // Belege nur anfassen, wenn das Feld mitkommt - ein PUT, das nur den
      // Betrag korrigiert, darf sie nicht stillschweigend abräumen.
      if (req.body.attachment_document_ids !== undefined) {
        replaceDocumentLinks(db.get(), {
          ...EXPENSE_ATTACHMENTS,
          ownerId: existing.id,
          documentIds: req.body.attachment_document_ids,
          userId: userId(req),
          extraValues: { kind: 'receipt' },
        });
      }
      activity(existing.group_id, userId(req), 'expense_edited', 'expense', existing.id, { title: parsed.title });
    });
    res.json({ data: serializeExpense(loadExpense(existing.id, req), null, userId(req)) });
  } catch (err) {
    if (sendDocumentDeletionConflict(res, err)) return;
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
    const currency = CURRENCY_CODES.includes(req.body.currency) ? req.body.currency : group.default_currency;
    const amountMinor = parseMoneyToMinor(req.body.amount, currency);
    const vNotes = str(req.body.notes, 'Notes', { max: MAX_TEXT, required: false });
    if (vNotes.error) return res.status(400).json({ error: vNotes.error, code: 400 });
    // Zahlungsnachweis: nur ein Dokument, das diese Person sehen darf (#583).
    // Vorher wurde die rohe ID übernommen - eine geratene fremde ID hätte sich
    // so an die Zahlung heften lassen.
    const proofDocumentId = visibleDocumentRef(db.get(), req.body.proof_document_id, userId(req));
    const settlementId = db.transaction(() => {
      const result = db.get().prepare(`
        INSERT INTO settlements (group_id, payer_id, payee_id, amount_minor, currency, notes, proof_document_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(groupId, payerId, payeeId, amountMinor, currency, vNotes.value, proofDocumentId, userId(req));
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
    if (sendDocumentDeletionConflict(res, err)) return;
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
    const guest = splitGuestScope(req);
    const restrictedGroupId = guest?.groupId ?? null;
    // Der Filter hängt am Gast-Status, nicht an der group_id: ein Gast ohne
    // Gruppe darf keine Treffer bekommen, nicht alle.
    const isGuest = guest ? 1 : 0;
    const groups = db.get().prepare(`
      ${groupSelectWhere(`visible.user_id = @userId AND g.status = 'active' AND (@q = '' OR g.name LIKE '%' || @q || '%')${guest ? ' AND g.id = @restrictedGroupId' : ''}`)}
      ORDER BY g.updated_at DESC LIMIT 10
    `).all({ userId: uid, q, restrictedGroupId });
    const expenses = db.get().prepare(`
      SELECT e.*, g.name AS group_name, u.display_name AS payer_name
      FROM expenses e
      JOIN expense_groups g ON g.id = e.group_id
      JOIN expense_group_members gm ON gm.group_id = g.id AND gm.user_id = @uid
      LEFT JOIN users u ON u.id = e.payer_id
      WHERE e.status = 'active' AND (@q = '' OR e.title LIKE '%' || @q || '%' OR e.description LIKE '%' || @q || '%')
        AND (@isGuest = 0 OR g.id = @restrictedGroupId)
      ORDER BY e.expense_date DESC LIMIT 10
    `).all({ uid, q, restrictedGroupId, isGuest });
    const expensesSerialized = serializeExpenseList(expenses, userId(req));
    const people = db.get().prepare(`
      SELECT DISTINCT u.id, u.display_name, u.username, u.avatar_color
      FROM users u
      JOIN expense_group_members gm ON gm.user_id = u.id
      JOIN expense_group_members mine ON mine.group_id = gm.group_id AND mine.user_id = @uid
      WHERE (@q = '' OR u.display_name LIKE '%' || @q || '%' OR u.username LIKE '%' || @q || '%')
        AND (@isGuest = 0 OR gm.group_id = @restrictedGroupId)
      ORDER BY u.display_name COLLATE NOCASE ASC LIMIT 10
    `).all({ uid, q, restrictedGroupId, isGuest });
    res.json({ data: { groups, expenses: expensesSerialized, people } });
  } catch (err) {
    log.error('GET /search error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
