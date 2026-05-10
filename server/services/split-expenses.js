/**
 * Module: Split Expenses Service
 * Purpose: Money parsing, split allocation, ledger balance derivation, and debt simplification.
 */

const CURRENCY_MINOR_UNITS = {
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, OMR: 3, TND: 3,
  CLP: 0, JPY: 0, KRW: 0, VND: 0,
};

function minorUnit(currency = 'EUR') {
  return CURRENCY_MINOR_UNITS[String(currency).toUpperCase()] ?? 2;
}

function parseMoneyToMinor(value, currency = 'EUR', field = 'amount') {
  if (typeof value === 'number') {
    throw new Error(`${field} must be sent as a decimal string to avoid floating point loss.`);
  }
  const raw = String(value ?? '').trim();
  const scale = minorUnit(currency);
  const re = /^-?\d+(\.\d+)?$/;
  if (!re.test(raw)) throw new Error(`${field} must be a valid decimal string.`);
  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole, fraction = ''] = unsigned.split('.');
  if (fraction.length > scale) throw new Error(`${field} has too many decimal places for ${currency}.`);
  const padded = fraction.padEnd(scale, '0');
  const minor = BigInt(whole) * (10n ** BigInt(scale)) + BigInt(padded || '0');
  if (minor <= 0n && !negative) throw new Error(`${field} must be greater than zero.`);
  const signed = negative ? -minor : minor;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`${field} is too large.`);
  }
  return Number(signed);
}

function minorToDecimal(value, currency = 'EUR') {
  const scale = minorUnit(currency);
  const n = BigInt(value ?? 0);
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const divisor = 10n ** BigInt(scale);
  const whole = abs / divisor;
  const fraction = abs % divisor;
  if (scale === 0) return `${negative ? '-' : ''}${whole}`;
  return `${negative ? '-' : ''}${whole}.${fraction.toString().padStart(scale, '0')}`;
}

function assertIntegerIds(ids, field) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error(`${field} must contain at least one member.`);
  const normalized = [...new Set(ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!normalized.length) throw new Error(`${field} must contain valid user ids.`);
  return normalized;
}

function allocateRemainder(totalMinor, baseRows) {
  const sum = baseRows.reduce((acc, row) => acc + row.amount_minor, 0);
  let remainder = totalMinor - sum;
  const rows = baseRows.map((row) => ({ ...row }));
  for (const row of rows) {
    if (remainder === 0) break;
    row.amount_minor += remainder > 0 ? 1 : -1;
    remainder += remainder > 0 ? -1 : 1;
  }
  return rows;
}

function buildSplits({ method, amountMinor, currency, participants, splits = [] }) {
  const participantIds = assertIntegerIds(participants, 'participants');
  const splitMap = new Map((Array.isArray(splits) ? splits : []).map((s) => [Number(s.user_id), s]));

  if (method === 'equal') {
    const base = Math.trunc(amountMinor / participantIds.length);
    return allocateRemainder(amountMinor, participantIds.map((userId) => ({ user_id: userId, amount_minor: base })));
  }

  if (method === 'exact') {
    const rows = participantIds.map((userId) => {
      const split = splitMap.get(userId);
      if (!split) throw new Error('Each participant needs an exact split amount.');
      return { user_id: userId, amount_minor: parseMoneyToMinor(split.amount, currency, 'split amount') };
    });
    const sum = rows.reduce((acc, row) => acc + row.amount_minor, 0);
    if (sum !== amountMinor) throw new Error('Exact splits must add up to the expense amount.');
    return rows;
  }

  if (method === 'percentage') {
    const rows = participantIds.map((userId) => {
      const split = splitMap.get(userId);
      const percent = String(split?.percentage ?? '').trim();
      if (!/^\d+(\.\d{1,2})?$/.test(percent)) throw new Error('Percentages must be decimal strings with up to two decimals.');
      const [whole, fraction = ''] = percent.split('.');
      const bps = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
      return { user_id: userId, bps };
    });
    const totalBps = rows.reduce((acc, row) => acc + row.bps, 0);
    if (totalBps !== 10000) throw new Error('Percentages must add up to 100.');
    return allocateRemainder(amountMinor, rows.map((row) => ({
      user_id: row.user_id,
      amount_minor: Math.trunc((amountMinor * row.bps) / 10000),
    })));
  }

  if (method === 'shares') {
    const rows = participantIds.map((userId) => {
      const shares = Number(splitMap.get(userId)?.shares);
      if (!Number.isInteger(shares) || shares <= 0) throw new Error('Shares must be positive integers.');
      return { user_id: userId, shares };
    });
    const totalShares = rows.reduce((acc, row) => acc + row.shares, 0);
    return allocateRemainder(amountMinor, rows.map((row) => ({
      user_id: row.user_id,
      amount_minor: Math.trunc((amountMinor * row.shares) / totalShares),
    })));
  }

  throw new Error('Unsupported split method.');
}

function simplifyDebts(balanceRows) {
  const byCurrency = new Map();
  for (const row of balanceRows) {
    const currency = row.currency;
    if (!byCurrency.has(currency)) byCurrency.set(currency, []);
    byCurrency.get(currency).push({ ...row, net_minor: Number(row.net_minor || 0) });
  }

  const debts = [];
  for (const [currency, rows] of byCurrency.entries()) {
    const debtors = rows
      .filter((row) => row.net_minor < 0)
      .map((row) => ({ ...row, remaining: -row.net_minor }))
      .sort((a, b) => a.user_id - b.user_id);
    const creditors = rows
      .filter((row) => row.net_minor > 0)
      .map((row) => ({ ...row, remaining: row.net_minor }))
      .sort((a, b) => a.user_id - b.user_id);
    let d = 0;
    let c = 0;
    while (d < debtors.length && c < creditors.length) {
      const amount = Math.min(debtors[d].remaining, creditors[c].remaining);
      if (amount > 0) {
        debts.push({
          from_user_id: debtors[d].user_id,
          from_name: debtors[d].display_name,
          to_user_id: creditors[c].user_id,
          to_name: creditors[c].display_name,
          currency,
          amount_minor: amount,
          amount: minorToDecimal(amount, currency),
        });
      }
      debtors[d].remaining -= amount;
      creditors[c].remaining -= amount;
      if (debtors[d].remaining === 0) d += 1;
      if (creditors[c].remaining === 0) c += 1;
    }
  }
  return debts;
}

function decorateMoney(row, fields = ['amount_minor']) {
  const out = { ...row };
  for (const field of fields) {
    if (out[field] !== undefined) out[field.replace(/_minor$/, '')] = minorToDecimal(out[field], out.currency);
  }
  return out;
}

export {
  buildSplits,
  decorateMoney,
  minorToDecimal,
  parseMoneyToMinor,
  simplifyDebts,
};
