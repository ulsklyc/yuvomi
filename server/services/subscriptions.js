import { reminderDateBefore } from '../utils/reminder-schedule.js';
import { dateKey, parseDateKey, addMonthsClamped, addYearsClamped } from '../utils/interval-date.js';

const BILLING_CYCLES = ['daily', 'weekly', 'monthly', 'yearly'];
const CURRENCY_RE = /^[A-Z]{3}$/;

// monthly/yearly sind duenne Fassaden ueber server/utils/interval-date.js -
// dort steht, warum die Rechnung geteilt ist.
function addBillingCycle(value, cycle, interval = 1) {
  if (!BILLING_CYCLES.includes(cycle)) throw new Error('Unsupported billing cycle.');
  const count = Number(interval);
  if (!Number.isInteger(count) || count < 1 || count > 365) throw new Error('Cycle interval is invalid.');

  if (cycle === 'monthly') return addMonthsClamped(value, count);
  if (cycle === 'yearly') return addYearsClamped(value, count);

  const date = parseDateKey(value);
  if (cycle === 'daily') date.setUTCDate(date.getUTCDate() + count);
  if (cycle === 'weekly') date.setUTCDate(date.getUTCDate() + (count * 7));
  return dateKey(date);
}

function nextRenewalOnOrAfter(startDate, cycle, interval, minimumDate) {
  let result = startDate;
  const minimum = parseDateKey(minimumDate).getTime();
  let guard = 0;
  while (parseDateKey(result).getTime() < minimum && guard < 10000) {
    result = addBillingCycle(result, cycle, interval);
    guard += 1;
  }
  if (guard >= 10000) throw new Error('Could not calculate the next renewal date.');
  return result;
}

const END_TYPES = ['never', 'on_date', 'after_count'];

// Verbleibende Zahlungen bei 'after_count' (inkl. der aktuell anstehenden),
// sonst null.
function occurrencesRemaining(subscription) {
  if (subscription.end_type !== 'after_count') return null;
  return Math.max(0, Number(subscription.occurrence_count) - Number(subscription.occurrences_done || 0));
}

// Entscheidet beim Verlängern, ob das Abo endet oder auf den nächsten Zyklus
// vorrückt. occurrencesDone verbucht die soeben fällige Zahlung.
function resolveRenewal(subscription) {
  const occurrencesDone = Number(subscription.occurrences_done || 0) + 1;
  const nextDate = addBillingCycle(
    subscription.next_payment_date,
    subscription.billing_cycle,
    subscription.cycle_interval,
  );
  let completed = false;
  if (subscription.end_type === 'after_count') {
    completed = occurrencesDone >= Number(subscription.occurrence_count);
  } else if (subscription.end_type === 'on_date') {
    completed = parseDateKey(nextDate).getTime() > parseDateKey(subscription.end_date).getTime();
  }
  return { completed, nextDate, occurrencesDone };
}

function monthlyEquivalent(amount, cycle, interval = 1) {
  const value = Number(amount);
  const count = Number(interval);
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(count) || count < 1) return 0;
  if (cycle === 'daily') return value * (365.2425 / 12) / count;
  if (cycle === 'weekly') return value * (52.1775 / 12) / count;
  if (cycle === 'monthly') return value / count;
  if (cycle === 'yearly') return value / (12 * count);
  return 0;
}

function convertAmount(amount, fromCurrency, toCurrency, rates) {
  const from = String(fromCurrency || '').toUpperCase();
  const to = String(toCurrency || '').toUpperCase();
  if (!CURRENCY_RE.test(from) || !CURRENCY_RE.test(to)) throw new Error('Currency is invalid.');
  if (from === to) return Number(amount);
  const rate = Number(rates?.[from]);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return Number(amount) * rate;
}

/** Sprechende Fassade ueber der geteilten Rechnung in
 *  server/utils/reminder-schedule.js - dort steht, warum sie geteilt ist. */
function reminderDate(nextPaymentDate, reminderDays) {
  return reminderDateBefore(nextPaymentDate, reminderDays);
}

export {
  BILLING_CYCLES,
  CURRENCY_RE,
  END_TYPES,
  addBillingCycle,
  convertAmount,
  monthlyEquivalent,
  nextRenewalOnOrAfter,
  occurrencesRemaining,
  parseDateKey,
  reminderDate,
  resolveRenewal,
};
