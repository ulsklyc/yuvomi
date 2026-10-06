/**
 * Modul: Budget-Tracker – Kredite/Darlehen
 * Zweck: Loans CRUD, Raten-Zahlungen (mit gekoppeltem Budget-Eintrag), Status.
 */

import express from 'express';
import { createLogger } from '../../logger.js';
import * as db from '../../db.js';
import { str, num, date as validateDate, month as validateMonth, MAX_TITLE, MAX_SHORT } from '../../middleware/validate.js';
import { normalizeObjectVisibility } from '../../services/budget-visibility.js';
import { computeLoanSchedule, MAX_LOAN_MONTHS } from '../../services/loan-amortization.js';
import { translate, resolveHouseholdLocale } from '../../utils/i18n.js';
import {
  budgetFilter, mayEdit, getBudgetMode, loanSummaryRow, loadLoan, refreshLoanStatus, cents,
  budgetCurrency, toBudgetAmount, CURRENCY_RE, validateAccountRef, addMonths,
  LOAN_DIRECTIONS, bookingFor, refusal, refusals, refuse, dueDateInMonth,
} from './helpers.js';

const log = createLogger('Budget');
const router = express.Router();

// 'variable' = Darlehen ganz ohne Zinsbindung (#569-Nachtrag): rechnet einphasig
// wie 'fixed', der Satz gilt aber nur als aktueller Wert (Prognose).
const INTEREST_MODES = ['none', 'fixed', 'variable', 'fixed_then_variable'];

// Hoechste Ratenanzahl eines Darlehens ohne Zins. Die Absage nennt sie als
// `max`, damit der Dialog die Grenze sagen kann (#1668).
const MAX_LOAN_INSTALLMENTS = 360;

/**
 * Richtung aus dem Request (#638).
 * @param {object} body       Request-Body
 * @param {object|null} loan  Bestehendes Darlehen (PUT) - liefert den Default
 * @returns {{ value: string }|{ error: string }}
 */
function validateDirection(body, loan = null) {
  if (body.direction === undefined) return { value: loan?.direction || 'lent' };
  const raw = String(body.direction || '').trim();
  if (!LOAN_DIRECTIONS.includes(raw)) return refusal('loan_direction_invalid', 'Direction must be either lent or borrowed.');
  return { value: raw };
}

/**
 * Faelligkeitstag aus dem Request (#1631): optional, eine ganze Zahl von 1 bis 31.
 *
 * Fehlt das Feld, bleibt es beim Bestand (PUT) bzw. bei "kein Tag" (POST); `null`
 * oder ein leerer String nimmt den Tag wieder weg. Angenommen wird die Zahl
 * selbst oder ihre Ziffernfolge, wie ein Formularfeld sie schickt - `1.5`,
 * `"x"`, `true` und alles ausserhalb von 1 bis 31 sind eine Absage und werden
 * nicht still gerundet: ein Tag, den der Nutzer nicht gemeint hat, datierte
 * jede kuenftige Rate falsch.
 *
 * @param {object} body       Request-Body
 * @param {object|null} loan  Bestehendes Darlehen (PUT) - liefert den Default
 * @returns {{ value: number|null }|{ error: string, reason: string }}
 */
function validateDueDay(body, loan = null) {
  const raw = body.due_day;
  if (raw === undefined) return { value: loan?.due_day ?? null };
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) return { value: null };
  const day = typeof raw === 'number' ? raw
    : (typeof raw === 'string' && /^\d{1,2}$/.test(raw.trim()) ? Number(raw.trim()) : NaN);
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    return refusal('loan_due_day_invalid', 'Due day must be a whole number between 1 and 31.');
  }
  return { value: day };
}

/**
 * Bucht die bereits erfassten Raten eines Darlehens auf eine neue Richtung um (#638).
 *
 * Ein falsches Vorzeichen ist nie eine legitime Historie, sondern immer ein Fehler -
 * wer die Richtung korrigiert, will auch die schon gebuchten Raten korrigiert haben,
 * ohne jede einzeln zu löschen und neu zu buchen. Genau das ist der Reparaturweg für
 * Bestandsdaten, die die Migration auf den Default 'lent' gesetzt hat.
 *
 * Der Betrag wird nicht neu gerechnet, nur gespiegelt: der zum Buchungszeitpunkt
 * geltende Wechselkurs (#582) bleibt damit erhalten.
 */
function rebookPayments(loanId, direction) {
  const rule = bookingFor(direction);
  db.get().prepare(`
    UPDATE budget_entries
    SET amount = ? * ABS(amount), category = ?, subcategory = ?
    WHERE id IN (SELECT budget_entry_id FROM budget_loan_payments
                 WHERE loan_id = ? AND budget_entry_id IS NOT NULL)
  `).run(rule.sign, rule.category, rule.subcategory, loanId);
}

// Obergrenze für den festen Umrechnungskurs (#582). Großzügig genug für
// Weichwährungen (1 EUR ≈ 10^5 IRR ⇒ Gegenrichtung ≈ 10^-5), aber eine Bremse
// gegen Tippfehler, die die Budget-Summen unbrauchbar machen würden.
const MAX_EXCHANGE_RATE = 1e6;

/**
 * Währung je Darlehen (#582): prüft Währungscode + festen Kurs.
 *
 * Die aktuelle Budget-Währung wird als NULL gespeichert (= "folgt dem Budget"),
 * damit ein Darlehen ohne Fremdwährung nicht durch einen eingefrorenen Kurs 1
 * verfälscht wird, falls der Haushalt später die Währung umstellt.
 *
 * @param {object} body      Request-Body
 * @param {object|null} loan Bestehendes Darlehen (PUT) – liefert die Defaults
 * @returns {{ currency: string|null, exchange_rate: number }|{ error: string }}
 */
function validateCurrencyFields(body, loan = null) {
  const base = budgetCurrency();
  const raw = body.currency === undefined
    ? (loan ? loan.currency : null)
    : String(body.currency || '').trim().toUpperCase();
  const currency = !raw || raw === base ? null : raw;
  if (currency !== null && !CURRENCY_RE.test(currency)) {
    return refusal('loan_currency_invalid', 'Currency must be a three-letter ISO code.');
  }
  // Ohne Fremdwährung ist jeder Kurs bedeutungslos - hart auf 1, damit kein
  // Restwert aus einem früheren Fremdwährungs-Zustand hängen bleibt.
  if (currency === null) return { currency: null, exchange_rate: 1 };

  const rawRate = body.exchange_rate === undefined
    ? (loan ? loan.exchange_rate : 1)
    : body.exchange_rate;
  const rate = Number(rawRate);
  if (!Number.isFinite(rate) || rate <= 0 || rate > MAX_EXCHANGE_RATE) {
    return refusal('loan_exchange_rate_invalid', 'Exchange rate must be greater than zero.');
  }
  return { currency, exchange_rate: rate };
}

// Zins-Darlehen (#569): validiert die Zinseingaben und leitet daraus die vom
// bestehenden Raten-/Status-System erwarteten Felder (total_amount = Gesamtaufwand,
// installment_count = Laufzeit) ab. Gibt { fields } oder { error } zurück.
function deriveInterestTerms(body, mode) {
  const principal = Number(body.principal);
  const fixedRate = Number(body.fixed_rate);
  const initialRepaymentRate = Number(body.initial_repayment_rate);
  // Nur der Zwei-Phasen-Modus hat Zinsbindung + Anschlusszins; 'variable' und
  // 'fixed' speichern beide Felder als NULL.
  const variable = mode === 'fixed_then_variable';
  const fixedPeriodMonths = variable ? parseInt(body.fixed_period_months, 10) : null;
  const followupRate = variable ? Number(body.followup_rate) : null;

  if (!Number.isFinite(principal) || principal <= 0) return refusal('loan_principal_invalid', 'Principal must be greater than zero.');
  if (!Number.isFinite(fixedRate) || fixedRate < 0 || fixedRate > 100) return refusal('loan_rate_invalid', 'Fixed rate must be between 0 and 100.');
  if (!Number.isFinite(initialRepaymentRate) || initialRepaymentRate <= 0 || initialRepaymentRate > 100) {
    return refusal('loan_repayment_invalid', 'Initial repayment rate must be greater than 0 and at most 100.');
  }
  if (variable) {
    if (!Number.isInteger(fixedPeriodMonths) || fixedPeriodMonths < 1 || fixedPeriodMonths > MAX_LOAN_MONTHS) {
      return refusal('loan_fixed_period_invalid', 'Fixed-rate period is invalid.');
    }
    if (!Number.isFinite(followupRate) || followupRate < 0 || followupRate > 100) {
      return refusal('loan_followup_rate_invalid', 'Follow-up rate must be between 0 and 100.');
    }
  }

  const result = computeLoanSchedule({ principal, fixedRate, initialRepaymentRate, interestMode: mode, fixedPeriodMonths, followupRate });
  if (!result.ok) {
    return result.reason === 'not_amortizing'
      ? refusal('loan_not_amortizing', 'The monthly rate does not cover the interest; the loan never amortizes.')
      : refusal('loan_term_too_long', 'The resulting term exceeds the supported maximum.', { max: MAX_LOAN_MONTHS });
  }
  return {
    calc: result,
    fields: {
      interest_mode: mode,
      principal: cents(principal),
      fixed_rate: fixedRate,
      initial_repayment_rate: initialRepaymentRate,
      fixed_period_months: fixedPeriodMonths,
      followup_rate: followupRate,
      total_amount: result.totalRepayment,
      installment_count: result.totalMonths,
    },
  };
}

// Live-Vorschau für den Darlehens-Dialog: berechnet Monatsrate, Laufzeit,
// Gesamtzins und Restschuld ohne zu speichern. Server bleibt einzige Quelle der
// Zins-Mathematik (keine Formel-Dopplung im Client).
router.post('/loans/preview', (req, res) => {
  try {
    const mode = req.body.interest_mode;
    if (!INTEREST_MODES.includes(mode) || mode === 'none') {
      return res.json({ data: { ok: false } });
    }
    const derived = deriveInterestTerms(req.body, mode);
    // Der Grund reist mit (#1668): "tilgt nicht" und "laeuft zu lange" sind zwei
    // Saetze, und die Vorschau soll denselben sagen wie die Absage beim Speichern.
    if (derived.error) {
      return res.json({ data: { ok: false, reason: derived.reason, ...(derived.max !== undefined ? { max: derived.max } : {}) } });
    }
    const c = derived.calc;
    const bindingEnd = mode === 'fixed_then_variable' && req.body.fixed_period_months
      ? c.remainingAfterBinding
      : null;
    res.json({
      data: {
        ok: true,
        monthly_payment: c.monthlyPayment,
        total_months: c.totalMonths,
        total_interest: c.totalInterest,
        total_repayment: c.totalRepayment,
        remaining_after_binding: bindingEnd,
      },
    });
  } catch (err) {
    log.error('POST /loans/preview error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.get('/loans', (req, res) => {
  try {
    // Sichtbarkeit (#476/#505): Loans folgen dem Modus, ohne Mein/Haushalt-Scope.
    const filter = budgetFilter(req, 'l', { scoped: false });
    const base = budgetCurrency();
    const loans = db.get().prepare(`
      SELECT l.*, u.display_name AS creator_name
      FROM budget_loans l
      LEFT JOIN users u ON u.id = l.created_by
      WHERE 1=1${filter.clause}
      ORDER BY CASE l.status WHEN 'active' THEN 0 ELSE 1 END,
               l.start_month ASC,
               l.created_at DESC
    `).all(...filter.params).map((loan) => loanSummaryRow(loan, base));
    const active = loans.filter((loan) => loan.status === 'active');
    // Währung je Darlehen (#582): Die Summenkarte ist die einzige Stelle, die über
    // mehrere Darlehen hinweg addiert - sie muss deshalb in EINER Währung rechnen.
    // Fremdwährungs-Darlehen gehen mit ihrem festen Kurs in die Budget-Währung ein
    // (Bewertung zum hinterlegten Kurs; die bereits gebuchten Raten behalten
    // dagegen den Kurs, der zum Buchungszeitpunkt galt).
    const totals = loans.reduce((acc, loan) => {
      acc.total_amount += toBudgetAmount(loan.total_amount, loan);
      acc.paid_amount += toBudgetAmount(loan.paid_amount, loan);
      acc.remaining_amount += toBudgetAmount(loan.remaining_amount, loan);
      acc.remaining_principal += toBudgetAmount(loan.remaining_principal, loan);
      acc.remaining_installments += loan.remaining_installments;
      return acc;
    }, { total_amount: 0, paid_amount: 0, remaining_amount: 0, remaining_principal: 0, remaining_installments: 0 });

    res.json({
      data: {
        loans,
        summary: {
          active_count: active.length,
          total_count: loans.length,
          currency: base,
          has_foreign_currency: loans.some((loan) => loan.is_foreign_currency),
          // Steuert nur die Beschriftung: Sobald ein verzinstes Darlehen dabei ist,
          // ist die Summe eine Restschuld und darf nicht mehr neutral "offen" heißen.
          has_interest: loans.some((loan) => Boolean(loan.interest)),
          total_amount: cents(totals.total_amount),
          paid_amount: cents(totals.paid_amount),
          remaining_amount: cents(totals.remaining_amount),
          remaining_principal: cents(totals.remaining_principal),
          remaining_installments: totals.remaining_installments,
        },
      },
    });
  } catch (err) {
    log.error('GET /loans error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * Trägt bereits gezahlte Raten eines schon laufenden Darlehens nach (#813).
 *
 * Der Betrag kommt aus loadLoan().installment_amount und ist damit dieselbe Zahl,
 * die die Oberfläche als Monatsrate zeigt - bei verzinsten Darlehen die konstante
 * Annuität, nicht der Durchschnitt (#569). Die letzte Rate wird auf den Restbetrag
 * gekürzt, sonst überzahlt ein vollständig nachgetragenes Darlehen sich selbst.
 *
 * ENTSCHEIDEND: budget_entry_id bleibt NULL. Eine regulär abgehakte Rate bucht ins
 * Budget, weil sie GERADE bezahlt wird. Diese hier wurden vor Yuvomi bezahlt und
 * liefen nie über den Haushalt - sie als Buchungen anzulegen hieße, vergangene
 * Monate mit Ausgaben zu füllen, die dort nie stattgefunden haben, und Kontostände
 * wie Statistik zu verfälschen.
 *
 * Mit Faelligkeitstag (#1631) traegt jede dieser Raten den Tag ihres Monats,
 * ohne ihn wie bisher den Ersten. Das gilt nur hier, beim Anlegen: ein spaeter
 * gesetzter oder geaenderter Tag fasst keine bestehende Rate an.
 */
function seedPaidInstallments(loanId, count, userId) {
  const loan = loadLoan(loanId);
  const perInstallment = loan.installment_amount;
  db.get().transaction(() => {
    let booked = 0;
    for (let n = 1; n <= count; n++) {
      const remaining = cents(loan.total_amount - booked);
      if (remaining <= 0) break;
      const amount = Math.min(perInstallment, remaining);
      if (amount <= 0) break;
      const month = addMonths(loan.start_month, n - 1);
      db.get().prepare(`
        INSERT INTO budget_loan_payments
          (loan_id, installment_number, amount, paid_date, budget_entry_id, created_by)
        VALUES (?, ?, ?, ?, NULL, ?)
      `).run(loanId, n, amount, dueDateInMonth(month, loan.due_day) ?? `${month}-01`, userId);
      booked = cents(booked + amount);
    }
  })();
  refreshLoanStatus(loanId);
}

router.post('/loans', (req, res) => {
  try {
    const vTitle = str(req.body.title || req.body.borrower, 'Title', { max: MAX_TITLE });
    const vBorrower = str(req.body.borrower, 'Borrower', { max: MAX_SHORT });
    const vStartMonth = validateMonth(req.body.start_month, 'Start month');
    const vNotes = str(req.body.notes, 'Notes', { max: 1000, required: false });
    const errors = [
      ...refusals('loan_title_invalid', [vTitle]),
      ...refusals('loan_borrower_invalid', [vBorrower]),
      ...refusals('loan_start_month_invalid', [vStartMonth]),
      ...refusals('loan_notes_invalid', [vNotes]),
    ];
    if (!vStartMonth.value) errors.push(refusal('loan_start_month_invalid', 'Start month is required.'));

    const mode = INTEREST_MODES.includes(req.body.interest_mode) ? req.body.interest_mode : 'none';
    let terms = null;
    if (mode === 'none') {
      // Zinsfreier Pfad (unverändert): Gesamtbetrag + Ratenanzahl manuell.
      const vAmount = num(req.body.total_amount, 'Amount', { required: true });
      const installmentCount = parseInt(req.body.installment_count, 10);
      errors.push(...refusals('loan_amount_invalid', [vAmount]));
      if (!Number.isInteger(installmentCount) || installmentCount < 1 || installmentCount > MAX_LOAN_INSTALLMENTS) {
        errors.push(refusal('loan_installments_invalid', `Installment count must be between 1 and ${MAX_LOAN_INSTALLMENTS}.`, { max: MAX_LOAN_INSTALLMENTS }));
      }
      if (vAmount.value !== null && vAmount.value <= 0) errors.push(refusal('loan_amount_invalid', 'Amount must be greater than zero.'));
      terms = {
        interest_mode: 'none', principal: null, fixed_rate: null, initial_repayment_rate: null,
        fixed_period_months: null, followup_rate: null,
        total_amount: vAmount.value !== null ? cents(vAmount.value) : null, installment_count: installmentCount,
      };
    } else {
      const derived = deriveInterestTerms(req.body, mode);
      if (derived.error) errors.push(derived);
      else terms = derived.fields;
    }
    const money = validateCurrencyFields(req.body);
    if (money.error) errors.push(money);
    const dir = validateDirection(req.body);
    if (dir.error) errors.push(dir);
    const account = validateAccountRef(req.body.account_id);
    if (account.error) errors.push(refusal('loan_account_invalid', account.error));
    const dueDay = validateDueDay(req.body);
    if (dueDay.error) errors.push(dueDay);

    // Altlasten beim Anlegen (#813): Ein Darlehen, das schon läuft, wenn es hier
    // eingetragen wird, startet sonst mit lauter offenen Raten - der Nutzer müsste
    // jede vergangene Rate einzeln abhaken, nur damit Restschuld und Fortschritt
    // stimmen. Die Zahl wird bewusst ANGEGEBEN und nicht aus start_month abgeleitet:
    // ein tilgungsfreier Start, eine Stundung oder ein später eingetragenes Darlehen
    // mit Zahlungslücke hätten sonst still eine falsche Zahl bekommen. Das Formular
    // schlägt den aus dem Startmonat errechneten Wert vor, die Entscheidung bleibt
    // beim Nutzer.
    let paidInstallments = 0;
    if (req.body.paid_installments !== undefined && req.body.paid_installments !== null
        && req.body.paid_installments !== '') {
      paidInstallments = parseInt(req.body.paid_installments, 10);
      if (!Number.isInteger(paidInstallments) || paidInstallments < 0) {
        errors.push(refusal('loan_paid_installments_invalid', 'Paid installments must be zero or a positive number.'));
      } else if (terms && paidInstallments > terms.installment_count) {
        errors.push(refusal('loan_paid_installments_exceed', 'Paid installments cannot exceed the installment count.', { max: terms.installment_count }));
      }
    }
    if (errors.length) return refuse(res, errors);

    const me = req.authUserId || req.session.userId;
    const visibility = normalizeObjectVisibility(
      req.body.visibility,
      getBudgetMode() === 'personal' ? 'private' : 'shared'
    );
    const result = db.get().prepare(`
      INSERT INTO budget_loans
        (title, borrower, total_amount, installment_count, start_month, notes, created_by, owner_id, visibility,
         interest_mode, principal, fixed_rate, initial_repayment_rate, fixed_period_months, followup_rate,
         currency, exchange_rate, direction, account_id, due_day)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      vTitle.value,
      vBorrower.value,
      terms.total_amount,
      terms.installment_count,
      vStartMonth.value,
      vNotes.value,
      me, me, visibility,
      terms.interest_mode, terms.principal, terms.fixed_rate, terms.initial_repayment_rate,
      terms.fixed_period_months, terms.followup_rate,
      money.currency, money.exchange_rate,
      dir.value, account.value, dueDay.value
    );

    const loanId = result.lastInsertRowid;
    if (paidInstallments > 0) seedPaidInstallments(loanId, paidInstallments, me);

    res.status(201).json({ data: loadLoan(loanId) });
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

    // Zins-Darlehen (#569): Wird interest_mode mitgeschickt, werden Terms komplett
    // neu abgeleitet (der Edit-Dialog sendet dann den vollen Feldsatz). Der
    // zinsfreie Legacy-Pfad darunter bleibt für Teil-Updates ohne interest_mode.
    if (req.body.interest_mode !== undefined) {
      const mode = INTEREST_MODES.includes(req.body.interest_mode) ? req.body.interest_mode : null;
      const iErrors = [];
      if (req.body.title !== undefined) iErrors.push(...refusals('loan_title_invalid', [str(req.body.title, 'Title', { max: MAX_TITLE })]));
      if (req.body.borrower !== undefined) iErrors.push(...refusals('loan_borrower_invalid', [str(req.body.borrower, 'Borrower', { max: MAX_SHORT })]));
      if (req.body.start_month !== undefined) iErrors.push(...refusals('loan_start_month_invalid', [validateMonth(req.body.start_month, 'Start month')]));
      if (req.body.notes !== undefined) iErrors.push(...refusals('loan_notes_invalid', [str(req.body.notes, 'Notes', { max: 1000, required: false })]));
      const paidCount = db.get().prepare('SELECT COUNT(*) AS c FROM budget_loan_payments WHERE loan_id = ?').get(id).c;

      let terms = null;
      if (!mode) {
        iErrors.push(refusal('loan_interest_mode_invalid', 'Interest mode is invalid.'));
      } else if (mode === 'none') {
        const vAmount = num(req.body.total_amount, 'Amount', { required: true });
        const installmentCount = parseInt(req.body.installment_count, 10);
        iErrors.push(...refusals('loan_amount_invalid', [vAmount]));
        if (!Number.isInteger(installmentCount) || installmentCount < 1 || installmentCount > MAX_LOAN_INSTALLMENTS) {
          iErrors.push(refusal('loan_installments_invalid', `Installment count must be between 1 and ${MAX_LOAN_INSTALLMENTS}.`, { max: MAX_LOAN_INSTALLMENTS }));
        }
        if (vAmount.value !== null && vAmount.value <= 0) iErrors.push(refusal('loan_amount_invalid', 'Amount must be greater than zero.'));
        terms = {
          interest_mode: 'none', principal: null, fixed_rate: null, initial_repayment_rate: null,
          fixed_period_months: null, followup_rate: null,
          total_amount: vAmount.value !== null ? cents(vAmount.value) : null, installment_count: installmentCount,
        };
      } else {
        const derived = deriveInterestTerms(req.body, mode);
        if (derived.error) iErrors.push(derived);
        else terms = derived.fields;
      }
      if (terms && terms.installment_count !== null && terms.installment_count < paidCount) {
        iErrors.push(refusal('loan_term_below_paid', 'The resulting term is shorter than the already paid installments.'));
      }
      const iMoney = validateCurrencyFields(req.body, loan);
      if (iMoney.error) iErrors.push(iMoney);
      const iDir = validateDirection(req.body, loan);
      if (iDir.error) iErrors.push(iDir);
      const iAccount = req.body.account_id === undefined
        ? { value: loan.account_id }
        : validateAccountRef(req.body.account_id);
      if (iAccount.error) iErrors.push(refusal('loan_account_invalid', iAccount.error));
      const iDueDay = validateDueDay(req.body, loan);
      if (iDueDay.error) iErrors.push(iDueDay);
      if (iErrors.length) return refuse(res, iErrors);

      db.get().prepare(`
        UPDATE budget_loans SET
          title = COALESCE(?, title),
          borrower = COALESCE(?, borrower),
          start_month = COALESCE(?, start_month),
          notes = ?,
          total_amount = ?, installment_count = ?, interest_mode = ?, principal = ?,
          fixed_rate = ?, initial_repayment_rate = ?, fixed_period_months = ?, followup_rate = ?,
          currency = ?, exchange_rate = ?, direction = ?, account_id = ?, due_day = ?
        WHERE id = ?
      `).run(
        req.body.title?.trim() ?? null,
        req.body.borrower?.trim() ?? null,
        req.body.start_month ?? null,
        req.body.notes !== undefined ? (req.body.notes?.trim() || null) : loan.notes,
        terms.total_amount, terms.installment_count, terms.interest_mode, terms.principal,
        terms.fixed_rate, terms.initial_repayment_rate, terms.fixed_period_months, terms.followup_rate,
        iMoney.currency, iMoney.exchange_rate, iDir.value, iAccount.value, iDueDay.value,
        id
      );
      if (iDir.value !== loan.direction) rebookPayments(id, iDir.value);
      return res.json({ data: refreshLoanStatus(id) });
    }

    // Zins-Darlehen (#569): Der zinsfreie Legacy-Pfad (kein interest_mode im Body)
    // darf die aus principal/Zins abgeleiteten Felder nicht direkt verstellen,
    // sonst desynchronisiert total_amount/installment_count von der Zins-Mathematik.
    // Neutrale Partial-Updates (Titel, Notes, Startmonat) bleiben erlaubt.
    if (loan.interest_mode && loan.interest_mode !== 'none'
        && (req.body.total_amount !== undefined || req.body.installment_count !== undefined)) {
      return refuse(res, [refusal('loan_interest_fields_required', 'Interest loans must be edited via the interest fields.')]);
    }

    const errors = [];
    if (req.body.title !== undefined) errors.push(...refusals('loan_title_invalid', [str(req.body.title, 'Title', { max: MAX_TITLE })]));
    if (req.body.borrower !== undefined) errors.push(...refusals('loan_borrower_invalid', [str(req.body.borrower, 'Borrower', { max: MAX_SHORT })]));
    if (req.body.total_amount !== undefined) errors.push(...refusals('loan_amount_invalid', [num(req.body.total_amount, 'Amount')]));
    if (req.body.start_month !== undefined) errors.push(...refusals('loan_start_month_invalid', [validateMonth(req.body.start_month, 'Start month')]));
    if (req.body.notes !== undefined) errors.push(...refusals('loan_notes_invalid', [str(req.body.notes, 'Notes', { max: 1000, required: false })]));
    const installmentCount = req.body.installment_count === undefined ? null : parseInt(req.body.installment_count, 10);
    if (req.body.installment_count !== undefined && (!Number.isInteger(installmentCount) || installmentCount < 1 || installmentCount > MAX_LOAN_INSTALLMENTS)) {
      errors.push(refusal('loan_installments_invalid', `Installment count must be between 1 and ${MAX_LOAN_INSTALLMENTS}.`, { max: MAX_LOAN_INSTALLMENTS }));
    }
    const paidCount = db.get().prepare('SELECT COUNT(*) AS c FROM budget_loan_payments WHERE loan_id = ?').get(id).c;
    if (installmentCount !== null && installmentCount < paidCount) {
      errors.push(refusal('loan_term_below_paid', 'Installment count cannot be lower than paid installments.'));
    }
    if (req.body.total_amount !== undefined && Number(req.body.total_amount) <= 0) errors.push(refusal('loan_amount_invalid', 'Amount must be greater than zero.'));
    const money = validateCurrencyFields(req.body, loan);
    if (money.error) errors.push(money);
    const dir = validateDirection(req.body, loan);
    if (dir.error) errors.push(dir);
    const account = req.body.account_id === undefined
      ? { value: loan.account_id }
      : validateAccountRef(req.body.account_id);
    if (account.error) errors.push(refusal('loan_account_invalid', account.error));
    const dueDay = validateDueDay(req.body, loan);
    if (dueDay.error) errors.push(dueDay);
    if (errors.length) return refuse(res, errors);

    db.get().prepare(`
      UPDATE budget_loans
      SET title = COALESCE(?, title),
          borrower = COALESCE(?, borrower),
          total_amount = COALESCE(?, total_amount),
          installment_count = COALESCE(?, installment_count),
          start_month = COALESCE(?, start_month),
          notes = ?,
          currency = ?,
          exchange_rate = ?,
          direction = ?,
          account_id = ?,
          due_day = ?
      WHERE id = ?
    `).run(
      req.body.title?.trim() ?? null,
      req.body.borrower?.trim() ?? null,
      req.body.total_amount !== undefined ? cents(req.body.total_amount) : null,
      installmentCount,
      req.body.start_month ?? null,
      req.body.notes !== undefined ? (req.body.notes?.trim() || null) : loan.notes,
      money.currency, money.exchange_rate,
      dir.value, account.value, dueDay.value,
      id
    );
    if (dir.value !== loan.direction) rebookPayments(id, dir.value);

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
    const loanRow = db.get().prepare('SELECT owner_id, visibility, created_by, direction, account_id FROM budget_loans WHERE id = ?').get(id);
    if (!mayEdit(req, loanRow)) return res.status(403).json({ error: 'You cannot modify this loan.', code: 403 });
    // is_settled statt remaining_installments: ein frueh volltilgtes Zins-Darlehen
    // hat noch ungebuchte Plan-Raten, aber nichts mehr zu bezahlen (#954).
    if (loan.is_settled) return refuse(res, [refusal('loan_settled', 'Loan is already paid.')], 409);

    const installmentNumber = req.body.installment_number === undefined
      ? loan.next_installment_number
      : parseInt(req.body.installment_number, 10);
    const defaultAmount = installmentNumber === loan.installment_count
      ? loan.remaining_amount
      : Math.min(loan.installment_amount, loan.remaining_amount);
    const vAmount = num(req.body.amount ?? defaultAmount, 'Amount', { required: true });
    const vDate = validateDate(req.body.paid_date, 'Paid date', true);
    // Reihenfolge der Saetze wie bisher: Betrag, Datum, Ratennummer, Grenzen.
    const errors = [
      ...refusals('loan_payment_amount_invalid', [vAmount]),
      ...refusals('loan_payment_date_invalid', [vDate]),
    ];
    if (!Number.isInteger(installmentNumber) || installmentNumber < 1 || installmentNumber > loan.installment_count) {
      errors.push(refusal('loan_payment_installment_invalid', 'Installment number is invalid.'));
    }
    if (vAmount.value !== null && vAmount.value <= 0) errors.push(refusal('loan_payment_amount_invalid', 'Amount must be greater than zero.'));
    if (vAmount.value !== null && vAmount.value - loan.remaining_amount > 0.005) {
      errors.push(refusal('loan_payment_amount_exceeds', 'Amount cannot be greater than the remaining loan amount.'));
    }
    if (errors.length) return refuse(res, errors);

    const existing = db.get().prepare(`
      SELECT 1 FROM budget_loan_payments WHERE loan_id = ? AND installment_number = ?
    `).get(id, installmentNumber);
    if (existing) return refuse(res, [refusal('loan_installment_paid', 'Installment already paid.')], 409);

    const paymentAmount = cents(vAmount.value);
    // Währung je Darlehen (#582): Die Rate wird in Darlehenswährung geführt
    // (budget_loan_payments.amount, gegen total_amount/Restschuld gerechnet), das
    // Budget kennt aber nur eine Währung - der gekoppelte Eintrag wird deshalb mit
    // dem festen Kurs umgerechnet. Der Kurs wird nur hier, zum Buchungszeitpunkt,
    // angewandt: eine spätere Kursänderung lässt gebuchte Raten unberührt.
    const budgetAmount = toBudgetAmount(paymentAmount, loan);
    const foreign = loan.is_foreign_currency ? ` (${loan.currency})` : '';
    // Der Titel wird in der Datensprache des Haushalts gespeichert, wie schon bei
    // Geburtstagsterminen (#524/#631/#632). Grund ist derselbe: die Zeile in
    // budget_entries ist das, was REST-API, CSV-Export, FTS-Suchindex und MCP zu
    // sehen bekommen - keiner dieser Kanäle durchläuft die Client-Übersetzung.
    // Vorher stand hier ein fest englischer Titel; der übersetzte Fallback in
    // public/pages/budget.js kam nie zum Zug, weil er nur bei LEEREM Titel greift.
    // Er bleibt trotzdem, denn nachgetragene Raten (#813) haben gar keinen
    // Budget-Eintrag - genau dort trägt er.
    const title = translate(resolveHouseholdLocale(db.get()), 'budget.loanPaymentTitle', { borrower: loan.borrower }) + foreign;
    // Richtung (#638): Bei einem aufgenommenen Kredit verlässt die Rate den Haushalt -
    // negativer Betrag und eine expense-Kategorie. Beides muss zusammen wechseln,
    // sonst steht eine Ausgabe unter „Geschenke & Transfers" (income).
    const booking = bookingFor(loanRow.direction);
    const tx = db.get().transaction(() => {
      // Repayment-Eintrag erbt Eigentümer + Sichtbarkeit des Loans (#476/#505),
      // damit er im Budget derselben Person/desselben Topfs erscheint.
      // account_id kommt vom Darlehen: erst damit belastet eine Rate ein Konto (#638).
      const budgetResult = db.get().prepare(`
        INSERT INTO budget_entries (title, amount, category, subcategory, date, is_recurring, created_by, owner_id, visibility, account_id)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
      `).run(
        title,
        booking.sign * budgetAmount,
        booking.category,
        booking.subcategory,
        vDate.value,
        req.authUserId || req.session.userId,
        loanRow.owner_id,
        loanRow.visibility || 'shared',
        loanRow.account_id ?? null
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
