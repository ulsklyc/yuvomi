/** Transfer dialog endpoints; generic entry writes also protect the pair. */
import express from 'express';
import * as db from '../../db.js';
import { str, num, date as validateDate, MAX_TITLE } from '../../middleware/validate.js';
import { normalizeBudgetVisibility } from '../../services/budget-visibility.js';
import { todayKey } from '../../utils/timezone.js';
import { createLogger } from '../../logger.js';
import { createTransfer, transferPair, mirrorTransfer, transferIncomeCategory, TRANSFER_SAVING_CATEGORY, TRANSFER_SAVING_SUBCATEGORY } from '../../services/budget-transfers.js';
import { mayEdit, getBudgetMode, defaultCategory, validExpenseCategoryKeys, validateSubcategory, validateAccountRef, transferCurrenciesMatch, isArchivedBudgetAccount, transferAmountFitsCurrency, budgetAccountCurrency,
  RECURRENCE_INTERVAL_KEYS, MAX_INTERVAL_COUNT, freezeSeriesPast, materializeSeriesStart } from './helpers.js';

const router = express.Router();
const log = createLogger('Budget transfers');
const load = (id) => db.get().prepare('SELECT * FROM budget_entries WHERE id = ?').get(id);
function outgoing(entry) {
  const partner = transferPair(db.get(), entry);
  return entry.amount < 0 ? entry : partner;
}
function transferSeries(entry) {
  const anchor = load(entry.recurrence_parent_id ?? entry.id);
  const partner = transferPair(db.get(), anchor);
  const definition = db.get().prepare('SELECT * FROM budget_series WHERE anchor_id = ?').get(anchor.id);
  const otherDefinition = db.get().prepare('SELECT * FROM budget_series WHERE anchor_id = ?').get(partner.id);
  if (!definition || !otherDefinition) return null;
  return { anchor, partner, definition,
    base: { ...anchor, ...definition, date: definition.start_date },
    other: { ...partner, ...otherDefinition, date: otherDefinition.start_date } };
}
function response(entry) {
  const partner = transferPair(db.get(), entry);
  const current = transferSeries(entry);
  return { ...entry, from_account_id: entry.account_id, to_account_id: partner.account_id,
    ...(current ? { series: { ...current.base, from_account_id: current.base.account_id, to_account_id: current.other.account_id } } : {}) };
}
function values(req, base = null, currentPartner = null) {
  const body = req.body;
  const partner = currentPartner ?? (base ? transferPair(db.get(), base) : null);
  const pick = (key, fallback) => body[key] === undefined ? fallback : body[key];
  const title = str(pick('title', base?.title), 'Title', { max: MAX_TITLE });
  const amount = num(pick('amount', base ? Math.abs(base.amount) : undefined), 'Amount', { required: true });
  const date = validateDate(pick('date', base?.date), 'Date', true);
  const from = validateAccountRef(pick('from_account_id', base?.account_id));
  const to = validateAccountRef(pick('to_account_id', partner?.account_id));
  const defaultOutgoing = validExpenseCategoryKeys().includes(TRANSFER_SAVING_CATEGORY) ? TRANSFER_SAVING_CATEGORY : defaultCategory('expense');
  const category = pick('category', base?.category ?? defaultOutgoing);
  const saving = db.get().prepare(`SELECT key FROM budget_subcategories WHERE category_key = ?
    AND (key = ? OR name = 'Savings') ORDER BY (key = ?) DESC LIMIT 1`)
    .get(category, TRANSFER_SAVING_SUBCATEGORY, TRANSFER_SAVING_SUBCATEGORY)?.key;
  const subcategory = validateSubcategory(category, pick('subcategory', base?.subcategory ?? saving));
  const interval = pick('recurrence_interval', base?.recurrence_interval ?? 'monthly');
  const count = Number(pick('recurrence_interval_count', base?.recurrence_interval_count ?? 1));
  const errors = [title.error, amount.error, date.error, from.error, to.error].filter(Boolean);
  if (!(amount.value > 0) || !Number.isFinite(amount.value)) errors.push('Amount must be greater than zero.');
  if (!from.value || !to.value || from.value === to.value) errors.push('Choose two different accounts.');
  if (!validExpenseCategoryKeys().includes(category) || subcategory === null) errors.push('Invalid outgoing category or subcategory.');
  if (!RECURRENCE_INTERVAL_KEYS.includes(interval) || !Number.isInteger(count) || count < 1 || count > MAX_INTERVAL_COUNT) errors.push('Invalid recurrence interval.');
  if (body.recurrence_virtual || body.recurrence_rule) errors.push('Transfers use actual payments and the interval schedule.');
  if (body.transfer_entry_id !== undefined) errors.push('transfer_entry_id is read-only.');
  if (errors.length) return { errors };
  // Historical bookings stay editable; a new transfer or account assignment needs active accounts.
  if ((from.value !== base?.account_id && isArchivedBudgetAccount(from.value))
      || (to.value !== partner?.account_id && isArchivedBudgetAccount(to.value))) return {
    errors: ['Choose active accounts for a transfer.'], reason: 'transfer_account_archived',
  };
  if ((from.value !== base?.account_id || to.value !== partner?.account_id)
      && !transferCurrenciesMatch(from.value, to.value)) return {
    errors: ['Transfer accounts must use the same currency.'], reason: 'transfer_currency_mismatch',
  };
  const unchangedCurrency = base && budgetAccountCurrency(from.value) === budgetAccountCurrency(base.account_id);
  if ((amount.value !== Math.abs(base?.amount) || !unchangedCurrency) && !transferAmountFitsCurrency(amount.value, from.value)) return {
    errors: ['Amount must match the account currency precision.'], reason: 'entry_amount_invalid',
  };
  const me = req.authUserId || req.session.userId;
  return { title: title.value, amount: amount.value, category, subcategory,
    date: date.value, from_account_id: from.value, to_account_id: to.value,
    is_recurring: pick('is_recurring', base?.is_recurring ?? false) ? 1 : 0,
    recurrence_interval: interval, recurrence_interval_count: count,
    recurrence_confirm: pick('recurrence_confirm', base?.recurrence_confirm ?? false) ? 1 : 0,
    visibility: normalizeBudgetVisibility(pick('visibility', base?.visibility), getBudgetMode() === 'personal' ? 'private' : 'shared'),
    created_by: base?.created_by ?? me, owner_id: base?.owner_id ?? me };
}
function access(req, res) {
  const entry = load(Number(req.params.id));
  if (!entry?.transfer_entry_id) { res.status(404).json({ error: 'Transfer not found', code: 404 }); return null; }
  if (!mayEdit(req, entry) || !mayEdit(req, transferPair(db.get(), entry))) {
    res.status(403).json({ error: 'Permission denied.', code: 403 }); return null;
  }
  return outgoing(entry);
}
function guard(res, v) {
  if (!v.errors) return true;
  res.status(400).json({ error: v.errors.join(' '), reason: v.reason ?? 'transfer_invalid', code: 400 }); return false;
}
function writeBooking(entry, v) {
  const database = db.get();
  const partner = transferPair(database, entry);
  database.prepare(`UPDATE budget_entries SET title = ?, amount = ?, category = ?, subcategory = ?,
    date = ?, account_id = ?, visibility = ? WHERE id = ?`)
    .run(v.title, -v.amount, v.category, v.subcategory, v.date, v.from_account_id, v.visibility, entry.id);
  database.prepare(`UPDATE budget_entries SET account_id = ?, category = ?, subcategory = '' WHERE id = ?`)
    .run(v.to_account_id, transferIncomeCategory(database), partner.id);
  mirrorTransfer(database, entry.id);
}

router.get('/transfers/:id', (req, res) => {
  try { const entry = access(req, res); if (entry) res.json({ data: response(entry) }); }
  catch (err) { log.error('', err); res.status(500).json({ error: 'Internal error', code: 500 }); }
});
router.post('/transfers', (req, res) => {
  try {
    const v = values(req); if (!guard(res, v)) return;
    if (v.amount <= 0) return res.status(400).json({ error: 'Amount must be greater than zero.', code: 400 });
    res.status(201).json({ data: response(createTransfer(db.get(), v)) });
  } catch (err) { log.error('', err); res.status(500).json({ error: 'Internal error', code: 500 }); }
});
router.put('/transfers/:id', (req, res) => {
  try {
    const entry = access(req, res); if (!entry) return;
    const v = values(req, entry); if (!guard(res, v)) return;
    if (['is_recurring', 'recurrence_interval', 'recurrence_interval_count', 'recurrence_confirm'].some((k) => req.body[k] !== undefined
      && (k === 'recurrence_interval' ? v[k] !== entry[k] : Number(v[k]) !== Number(entry[k])))) {
      return res.status(400).json({ error: 'Change the recurrence through the transfer series.', reason: 'transfer_series_required', code: 400 });
    }
    db.get().transaction(() => writeBooking(entry, v))();
    res.json({ data: response(load(entry.id)) });
  } catch (err) { log.error('', err); res.status(500).json({ error: 'Internal error', code: 500 }); }
});
router.put('/transfers/:id/series', (req, res) => {
  try {
    const entry = access(req, res); if (!entry) return;
    const current = transferSeries(entry);
    if (!current) return res.status(400).json({ error: 'Not a recurring transfer.', code: 400 });
    const { anchor, partner, definition } = current;
    const v = values(req, current.base, current.other);
    if (!guard(res, v)) return;
    if (!v.is_recurring) return res.status(400).json({ error: 'Delete the series to end it.', code: 400 });
    const cutoff = todayKey(db.get());
    const gridChanged = v.date !== definition.start_date || v.recurrence_interval !== anchor.recurrence_interval || v.recurrence_interval_count !== anchor.recurrence_interval_count;
    if (gridChanged && anchor.date < cutoff && v.date.slice(0, 7) < anchor.date.slice(0, 7)) return res.status(400).json({ error: 'Series start cannot precede its first booked month.', code: 400 });
    db.get().transaction(() => {
      if (gridChanged) freezeSeriesPast(db.get(), anchor.id, cutoff);
      for (const [row, sign, account, category, subcategory] of [
        [anchor, -1, v.from_account_id, v.category, v.subcategory],
        [partner, 1, v.to_account_id, transferIncomeCategory(db.get()), ''],
      ]) {
        db.get().prepare(`UPDATE budget_entries SET recurrence_interval = ?, recurrence_interval_count = ?, recurrence_confirm = ? WHERE id = ?`)
          .run(v.recurrence_interval, v.recurrence_interval_count, v.recurrence_confirm, row.id);
        db.get().prepare(`UPDATE budget_series SET title = ?, amount = ?, category = ?, subcategory = ?, account_id = ?, visibility = ?, start_date = ? WHERE anchor_id = ?`)
          .run(v.title, sign * v.amount, category, subcategory, account, v.visibility, v.date, row.id);
      }
      if (anchor.date >= cutoff) writeBooking(anchor, v);
      if (gridChanged) {
        db.get().prepare('DELETE FROM budget_entries WHERE recurrence_parent_id IN (?, ?) AND date >= ?').run(anchor.id, partner.id, cutoff);
        db.get().prepare('UPDATE budget_series SET grid_from = ? WHERE anchor_id IN (?, ?)').run(cutoff, anchor.id, partner.id);
        if (anchor.date < cutoff && v.date >= cutoff) materializeSeriesStart(db.get(), anchor.id);
      } else {
        const future = db.get().prepare('SELECT * FROM budget_entries WHERE recurrence_parent_id = ? AND date >= ?').all(anchor.id, cutoff);
        for (const row of future) {
          writeBooking(row, { ...v, date: row.date });
          db.get().prepare('UPDATE budget_entries SET is_pending = ? WHERE id IN (?, ?)').run(v.recurrence_confirm, row.id, row.transfer_entry_id);
        }
      }
      // Visibility is a permission choice for the whole series, including its past.
      db.get().prepare('UPDATE budget_entries SET visibility = ? WHERE id IN (?, ?) OR recurrence_parent_id IN (?, ?)')
        .run(v.visibility, anchor.id, partner.id, anchor.id, partner.id);
    })();
    res.json({ data: response(load(anchor.id)) });
  } catch (err) { log.error('', err); res.status(500).json({ error: 'Internal error', code: 500 }); }
});
export default router;
