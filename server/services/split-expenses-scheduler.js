/**
 * Module: Split Expenses Scheduler
 * Purpose: Generate due recurring shared expenses idempotently.
 */

import { createLogger } from '../logger.js';
import * as db from '../db.js';
import { buildSplits } from './split-expenses.js';

const log = createLogger('SplitExpenseScheduler');

function addInterval(dateText, frequency) {
  const date = new Date(`${dateText}T00:00:00Z`);
  if (frequency === 'weekly') date.setUTCDate(date.getUTCDate() + 7);
  if (frequency === 'monthly') date.setUTCMonth(date.getUTCMonth() + 1);
  if (frequency === 'yearly') date.setUTCFullYear(date.getUTCFullYear() + 1);
  return date.toISOString().slice(0, 10);
}

function insertActivity(database, groupId, actorId, type, entityType, entityId, metadata = {}) {
  database.prepare(`
    INSERT INTO expense_activity (group_id, actor_id, type, entity_type, entity_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(groupId, actorId, type, entityType, entityId, JSON.stringify(metadata));
}

function generateRecurringExpense(database, recurring) {
  const snapshot = JSON.parse(recurring.split_snapshot || '{}');
  const participants = Array.isArray(snapshot.participants) ? snapshot.participants : [recurring.payer_id];
  const splits = buildSplits({
    method: recurring.split_method,
    amountMinor: recurring.amount_minor,
    currency: recurring.currency,
    participants,
    splits: snapshot.splits || [],
  });
  const expenseId = database.prepare(`
    INSERT INTO expenses
      (group_id, title, description, amount_minor, currency, converted_amount_minor, converted_currency,
       payer_id, category, split_method, expense_date, recurring_rule_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    recurring.group_id,
    recurring.title,
    recurring.description,
    recurring.amount_minor,
    recurring.currency,
    recurring.amount_minor,
    recurring.currency,
    recurring.payer_id,
    recurring.category,
    recurring.split_method,
    recurring.next_run_date,
    recurring.id,
    recurring.created_by,
  ).lastInsertRowid;

  const insertSplit = database.prepare('INSERT INTO expense_splits (expense_id, user_id, amount_minor, currency) VALUES (?, ?, ?, ?)');
  for (const split of splits) insertSplit.run(expenseId, split.user_id, split.amount_minor, split.currency);

  const insertLedger = database.prepare(`
    INSERT INTO expense_ledger_entries
      (group_id, source_type, source_id, user_id, counterparty_id, amount_minor, currency, memo, created_by)
    VALUES (?, 'expense', ?, ?, ?, ?, ?, ?, ?)
  `);
  insertLedger.run(recurring.group_id, expenseId, recurring.payer_id, null, recurring.amount_minor, recurring.currency, recurring.title, recurring.created_by);
  for (const split of splits) {
    insertLedger.run(recurring.group_id, expenseId, split.user_id, recurring.payer_id, -split.amount_minor, split.currency, recurring.title, recurring.created_by);
  }

  insertActivity(database, recurring.group_id, recurring.created_by, 'recurring_generated', 'expense', expenseId, { recurring_expense_id: recurring.id, title: recurring.title });
  database.prepare('UPDATE recurring_expenses SET next_run_date = ? WHERE id = ?')
    .run(addInterval(recurring.next_run_date, recurring.frequency), recurring.id);
  return expenseId;
}

function processDueRecurringExpenses(today = new Date().toISOString().slice(0, 10)) {
  const database = db.get();
  const due = database.prepare(`
    SELECT *
    FROM recurring_expenses
    WHERE paused_at IS NULL AND next_run_date <= ?
    ORDER BY next_run_date ASC, id ASC
    LIMIT 100
  `).all(today);
  if (!due.length) return { generated: 0 };
  const run = database.transaction(() => {
    let generated = 0;
    for (const recurring of due) {
      generateRecurringExpense(database, recurring);
      generated += 1;
    }
    return generated;
  });
  const generated = run();
  log.info(`Generated ${generated} recurring split expense(s).`);
  return { generated };
}

function startScheduler() {
  setInterval(() => {
    try {
      processDueRecurringExpenses();
    } catch (err) {
      log.error('Recurring split expense generation failed:', err);
    }
  }, 60 * 60 * 1000).unref();
}

export { processDueRecurringExpenses, startScheduler };
