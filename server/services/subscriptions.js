const BILLING_CYCLES = ['daily', 'weekly', 'monthly', 'yearly'];
const CURRENCY_RE = /^[A-Z]{3}$/;

function dateKey(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function parseDateKey(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error('Date must be in YYYY-MM-DD format.');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (dateKey(date) !== value) throw new Error('Date is invalid.');
  return date;
}

function addBillingCycle(value, cycle, interval = 1) {
  if (!BILLING_CYCLES.includes(cycle)) throw new Error('Unsupported billing cycle.');
  const count = Number(interval);
  if (!Number.isInteger(count) || count < 1 || count > 365) throw new Error('Cycle interval is invalid.');
  const date = parseDateKey(value);

  if (cycle === 'daily') date.setUTCDate(date.getUTCDate() + count);
  if (cycle === 'weekly') date.setUTCDate(date.getUTCDate() + (count * 7));
  if (cycle === 'monthly') {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + count);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
  }
  if (cycle === 'yearly') {
    const month = date.getUTCMonth();
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCFullYear(date.getUTCFullYear() + count);
    date.setUTCMonth(month);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), month + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
  }
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

function reminderDate(nextPaymentDate, reminderDays) {
  const date = parseDateKey(nextPaymentDate);
  date.setUTCDate(date.getUTCDate() - Math.max(0, Number(reminderDays) || 0));
  return `${dateKey(date)}T09:00`;
}

export {
  BILLING_CYCLES,
  CURRENCY_RE,
  addBillingCycle,
  convertAmount,
  monthlyEquivalent,
  nextRenewalOnOrAfter,
  parseDateKey,
  reminderDate,
};
