/**
 * Modul: Budget-Tracker – Kredite/Darlehen
 * Zweck: Loans CRUD, Raten-Zahlungen (mit gekoppeltem Budget-Eintrag), Status.
 */

import express from 'express';
import { createLogger } from '../../logger.js';
import * as db from '../../db.js';
import { str, num, date as validateDate, month as validateMonth, collectErrors, MAX_TITLE, MAX_SHORT } from '../../middleware/validate.js';
import { normalizeBudgetVisibility } from '../../services/budget-visibility.js';
import { budgetFilter, mayEdit, getBudgetMode, loanSummaryRow, loadLoan, refreshLoanStatus, cents } from './helpers.js';

const log = createLogger('Budget');
const router = express.Router();

router.get('/loans', (req, res) => {
  try {
    // Sichtbarkeit (#476/#505): Loans folgen dem Modus, ohne Mein/Haushalt-Scope.
    const filter = budgetFilter(req, 'l', { scoped: false });
    const loans = db.get().prepare(`
      SELECT l.*, u.display_name AS creator_name
      FROM budget_loans l
      LEFT JOIN users u ON u.id = l.created_by
      WHERE 1=1${filter.clause}
      ORDER BY CASE l.status WHEN 'active' THEN 0 ELSE 1 END,
               l.start_month ASC,
               l.created_at DESC
    `).all(...filter.params).map(loanSummaryRow);
    const active = loans.filter((loan) => loan.status === 'active');
    const totals = loans.reduce((acc, loan) => {
      acc.total_amount += loan.total_amount;
      acc.paid_amount += loan.paid_amount;
      acc.remaining_amount += loan.remaining_amount;
      acc.remaining_installments += loan.remaining_installments;
      return acc;
    }, { total_amount: 0, paid_amount: 0, remaining_amount: 0, remaining_installments: 0 });

    res.json({
      data: {
        loans,
        summary: {
          active_count: active.length,
          total_count: loans.length,
          total_amount: cents(totals.total_amount),
          paid_amount: cents(totals.paid_amount),
          remaining_amount: cents(totals.remaining_amount),
          remaining_installments: totals.remaining_installments,
        },
      },
    });
  } catch (err) {
    log.error('GET /loans error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.post('/loans', (req, res) => {
  try {
    const vTitle = str(req.body.title || req.body.borrower, 'Title', { max: MAX_TITLE });
    const vBorrower = str(req.body.borrower, 'Borrower', { max: MAX_SHORT });
    const vAmount = num(req.body.total_amount, 'Amount', { required: true });
    const vStartMonth = validateMonth(req.body.start_month, 'Start month');
    const vNotes = str(req.body.notes, 'Notes', { max: 1000, required: false });
    const installmentCount = parseInt(req.body.installment_count, 10);
    const errors = collectErrors([vTitle, vBorrower, vAmount, vStartMonth, vNotes]);
    if (!Number.isInteger(installmentCount) || installmentCount < 1 || installmentCount > 240) {
      errors.push('Installment count must be between 1 and 240.');
    }
    if (vAmount.value !== null && vAmount.value <= 0) errors.push('Amount must be greater than zero.');
    if (!vStartMonth.value) errors.push('Start month is required.');
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const me = req.authUserId || req.session.userId;
    const visibility = normalizeBudgetVisibility(
      req.body.visibility,
      getBudgetMode() === 'personal' ? 'private' : 'shared'
    );
    const result = db.get().prepare(`
      INSERT INTO budget_loans (title, borrower, total_amount, installment_count, start_month, notes, created_by, owner_id, visibility)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      vTitle.value,
      vBorrower.value,
      cents(vAmount.value),
      installmentCount,
      vStartMonth.value,
      vNotes.value,
      me, me, visibility
    );

    res.status(201).json({ data: loadLoan(result.lastInsertRowid) });
  } catch (err) {
    log.error('POST /loans error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.put('/loans/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const loan = db.get().prepare('SELECT * FROM budget_loans WHERE id = ?').get(id);
    if (!loan) return res.status(404).json({ error: 'Loan not found.', code: 404 });
    if (!mayEdit(req, loan)) return res.status(403).json({ error: 'You cannot modify this loan.', code: 403 });

    const checks = [];
    if (req.body.title !== undefined) checks.push(str(req.body.title, 'Title', { max: MAX_TITLE }));
    if (req.body.borrower !== undefined) checks.push(str(req.body.borrower, 'Borrower', { max: MAX_SHORT }));
    if (req.body.total_amount !== undefined) checks.push(num(req.body.total_amount, 'Amount'));
    if (req.body.start_month !== undefined) checks.push(validateMonth(req.body.start_month, 'Start month'));
    if (req.body.notes !== undefined) checks.push(str(req.body.notes, 'Notes', { max: 1000, required: false }));
    const errors = collectErrors(checks);
    const installmentCount = req.body.installment_count === undefined ? null : parseInt(req.body.installment_count, 10);
    if (req.body.installment_count !== undefined && (!Number.isInteger(installmentCount) || installmentCount < 1 || installmentCount > 240)) {
      errors.push('Installment count must be between 1 and 240.');
    }
    const paidCount = db.get().prepare('SELECT COUNT(*) AS c FROM budget_loan_payments WHERE loan_id = ?').get(id).c;
    if (installmentCount !== null && installmentCount < paidCount) {
      errors.push('Installment count cannot be lower than paid installments.');
    }
    if (req.body.total_amount !== undefined && Number(req.body.total_amount) <= 0) errors.push('Amount must be greater than zero.');
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    db.get().prepare(`
      UPDATE budget_loans
      SET title = COALESCE(?, title),
          borrower = COALESCE(?, borrower),
          total_amount = COALESCE(?, total_amount),
          installment_count = COALESCE(?, installment_count),
          start_month = COALESCE(?, start_month),
          notes = ?
      WHERE id = ?
    `).run(
      req.body.title?.trim() ?? null,
      req.body.borrower?.trim() ?? null,
      req.body.total_amount !== undefined ? cents(req.body.total_amount) : null,
      installmentCount,
      req.body.start_month ?? null,
      req.body.notes !== undefined ? (req.body.notes?.trim() || null) : loan.notes,
      id
    );

    res.json({ data: refreshLoanStatus(id) });
  } catch (err) {
    log.error('PUT /loans/:id error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.post('/loans/:id/payments', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const loan = loadLoan(id);
    if (!loan) return res.status(404).json({ error: 'Loan not found.', code: 404 });
    const loanRow = db.get().prepare('SELECT owner_id, visibility, created_by FROM budget_loans WHERE id = ?').get(id);
    if (!mayEdit(req, loanRow)) return res.status(403).json({ error: 'You cannot modify this loan.', code: 403 });
    if (loan.remaining_installments <= 0) return res.status(409).json({ error: 'Loan is already paid.', code: 409 });

    const installmentNumber = req.body.installment_number === undefined
      ? loan.next_installment_number
      : parseInt(req.body.installment_number, 10);
    const defaultAmount = installmentNumber === loan.installment_count
      ? loan.remaining_amount
      : Math.min(loan.installment_amount, loan.remaining_amount);
    const vAmount = num(req.body.amount ?? defaultAmount, 'Amount', { required: true });
    const vDate = validateDate(req.body.paid_date, 'Paid date', true);
    const errors = collectErrors([vAmount, vDate]);
    if (!Number.isInteger(installmentNumber) || installmentNumber < 1 || installmentNumber > loan.installment_count) {
      errors.push('Installment number is invalid.');
    }
    if (vAmount.value !== null && vAmount.value <= 0) errors.push('Amount must be greater than zero.');
    if (vAmount.value !== null && vAmount.value - loan.remaining_amount > 0.005) {
      errors.push('Amount cannot be greater than the remaining loan amount.');
    }
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const existing = db.get().prepare(`
      SELECT 1 FROM budget_loan_payments WHERE loan_id = ? AND installment_number = ?
    `).get(id, installmentNumber);
    if (existing) return res.status(409).json({ error: 'Installment already paid.', code: 409 });

    const paymentAmount = cents(vAmount.value);
    const tx = db.get().transaction(() => {
      // Repayment-Eintrag erbt Eigentümer + Sichtbarkeit des Loans (#476/#505),
      // damit er im Budget derselben Person/desselben Topfs erscheint.
      const budgetResult = db.get().prepare(`
        INSERT INTO budget_entries (title, amount, category, subcategory, date, is_recurring, created_by, owner_id, visibility)
        VALUES (?, ?, ?, '', ?, 0, ?, ?, ?)
      `).run(
        `Loan repayment: ${loan.borrower}`,
        paymentAmount,
        'Geschenke & Transfers',
        vDate.value,
        req.authUserId || req.session.userId,
        loanRow.owner_id,
        loanRow.visibility || 'shared'
      );
      const paymentResult = db.get().prepare(`
        INSERT INTO budget_loan_payments
          (loan_id, installment_number, amount, paid_date, budget_entry_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, installmentNumber, paymentAmount, vDate.value, budgetResult.lastInsertRowid, req.authUserId || req.session.userId);
      return paymentResult.lastInsertRowid;
    });

    const paymentId = tx();
    res.status(201).json({
      data: {
        payment: db.get().prepare('SELECT * FROM budget_loan_payments WHERE id = ?').get(paymentId),
        loan: refreshLoanStatus(id),
      },
    });
  } catch (err) {
    log.error('POST /loans/:id/payments error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.delete('/loans/:id/payments/:paymentId', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const paymentId = parseInt(req.params.paymentId, 10);
    const payment = db.get().prepare(`
      SELECT * FROM budget_loan_payments WHERE id = ? AND loan_id = ?
    `).get(paymentId, id);
    if (!payment) return res.status(404).json({ error: 'Payment not found.', code: 404 });
    const loanRow = db.get().prepare('SELECT owner_id, visibility, created_by FROM budget_loans WHERE id = ?').get(id);
    if (!mayEdit(req, loanRow)) return res.status(403).json({ error: 'You cannot modify this loan.', code: 403 });

    const tx = db.get().transaction(() => {
      db.get().prepare('DELETE FROM budget_loan_payments WHERE id = ?').run(paymentId);
      if (payment.budget_entry_id) {
        db.get().prepare('DELETE FROM budget_entries WHERE id = ?').run(payment.budget_entry_id);
      }
    });
    tx();
    refreshLoanStatus(id);
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /loans/:id/payments/:paymentId error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.delete('/loans/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const loan = db.get().prepare('SELECT * FROM budget_loans WHERE id = ?').get(id);
    if (!loan) return res.status(404).json({ error: 'Loan not found.', code: 404 });
    if (!mayEdit(req, loan)) return res.status(403).json({ error: 'You cannot modify this loan.', code: 403 });

    const payments = db.get().prepare('SELECT budget_entry_id FROM budget_loan_payments WHERE loan_id = ?').all(id);
    const tx = db.get().transaction(() => {
      db.get().prepare('DELETE FROM budget_loans WHERE id = ?').run(id);
      for (const payment of payments) {
        if (payment.budget_entry_id) {
          db.get().prepare('DELETE FROM budget_entries WHERE id = ?').run(payment.budget_entry_id);
        }
      }
    });
    tx();
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /loans/:id error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

export default router;
