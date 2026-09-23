/**
 * Module: Split Expenses Service
 * Purpose: Money parsing, split allocation, ledger balance derivation, and debt simplification.
 */

/**
 * Die ISO-4217-Ausnahmen: Waehrungen, die NICHT mit zwei Nachkommastellen
 * rechnen. Sie steht bewusst VOR der Auswahl - sechs dieser Codes (BHD, IQD,
 * JOD, KWD, OMR, TND) sind heute gar nicht waehlbar. Das ist kein toter Code,
 * sondern der Sinn der Tabelle: wer eine Waehrung zu `CURRENCY_CODES`
 * hinzufuegt, soll ihre Nachkommastellen schon vorfinden statt sie zu vergessen
 * und Betraege stillschweigend um Faktor 100 zu verschieben.
 *
 * NICHT AUF DEN CLDR UMSTELLEN. `Intl` liefert Anzeige-Konventionen, nicht die
 * Rechen-Norm, und die beiden gehen auseinander: IQD steht im CLDR auf 0 und in
 * ISO 4217 auf 3, COP/HUF/IDR/IRR zeigt der CLDR ohne Nachkommastellen,
 * waehrend ISO ihnen zwei gibt. Was hier steht, entscheidet, wie ein Betrag in
 * der Datenbank LIEGT - eine Anzeigekonvention darf das nicht bestimmen.
 * (Geprueft beim Nachtragen von VND, #297.)
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

function withCurrency(rows, currency) {
  return rows.map((row) => ({ ...row, currency }));
}

function buildSplits({ method, amountMinor, currency, participants, splits = [] }) {
  const participantIds = assertIntegerIds(participants, 'participants');
  const splitMap = new Map((Array.isArray(splits) ? splits : []).map((s) => [Number(s.user_id), s]));

  if (method === 'equal') {
    const base = Math.trunc(amountMinor / participantIds.length);
    return withCurrency(allocateRemainder(amountMinor, participantIds.map((userId) => ({ user_id: userId, amount_minor: base }))), currency);
  }

  if (method === 'exact') {
    const rows = participantIds.map((userId) => {
      const split = splitMap.get(userId);
      if (!split) throw new Error('Each participant needs an exact split amount.');
      return { user_id: userId, amount_minor: parseMoneyToMinor(split.amount, currency, 'split amount') };
    });
    const sum = rows.reduce((acc, row) => acc + row.amount_minor, 0);
    if (sum !== amountMinor) throw new Error('Exact splits must add up to the expense amount.');
    return withCurrency(rows, currency);
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
    return withCurrency(allocateRemainder(amountMinor, rows.map((row) => ({
      user_id: row.user_id,
      amount_minor: Math.trunc((amountMinor * row.bps) / 10000),
    }))), currency);
  }

  if (method === 'shares') {
    const rows = participantIds.map((userId) => {
      const shares = Number(splitMap.get(userId)?.shares);
      if (!Number.isInteger(shares) || shares <= 0) throw new Error('Shares must be positive integers.');
      return { user_id: userId, shares };
    });
    const totalShares = rows.reduce((acc, row) => acc + row.shares, 0);
    return withCurrency(allocateRemainder(amountMinor, rows.map((row) => ({
      user_id: row.user_id,
      amount_minor: Math.trunc((amountMinor * row.shares) / totalShares),
    }))), currency);
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

/**
 * Die Salden EINER Gruppe: je Person und Waehrung die Summe ihrer
 * Buchungszeilen. Das ist die EINE Saldenquelle der Ausgleichs-Ansicht
 * (`GET /groups/:id/balances`) und der Kennzahl auf dem Dashboard
 * (`openBalancesForUser()` unten) - beide lesen sie hier, damit sie nie
 * auseinanderlaufen.
 *
 * #1445 (offen): gezaehlt wird das Ledger ohne Blick auf `expenses`. Zeilen
 * einer Ausgabe, die es nicht mehr gibt, verschieben den Saldo deshalb mit.
 * Das Modul und die Kachel zeigen diesen Fehler bis zum Fix GEMEINSAM - wer
 * ihn hier behebt, heilt beide.
 */
function groupBalanceRows(database, groupId) {
  return database.prepare(`
    SELECT l.currency, l.user_id, u.display_name, SUM(l.amount_minor) AS net_minor
    FROM expense_ledger_entries l
    LEFT JOIN users u ON u.id = l.user_id
    WHERE l.group_id = ?
    GROUP BY l.currency, l.user_id
    HAVING net_minor != 0
    ORDER BY l.currency ASC, u.display_name COLLATE NOCASE ASC
  `).all(groupId);
}

/**
 * Was der Betrachter ueber alle aktiven Gruppen, in denen er Mitglied ist,
 * offen hat - fuer die Kennzahl auf dem Dashboard.
 *
 * `positions` sind genau die Zeilen, die die Ausgleichs-Ansicht der jeweiligen
 * Gruppe zeigt (`simplifyDebts()` ueber `groupBalanceRows()`), gefiltert auf
 * die, an denen der Betrachter beteiligt ist. `net` ist sein Saldo je Waehrung
 * - dieselbe Summe, die das Kennzahlband des Moduls zeigt.
 *
 * MITGLIEDSCHAFT, NICHT ADMIN-RECHT: das Modul laesst einen Admin jede Gruppe
 * oeffnen, aber „was schulde ich" hat nur in den eigenen Gruppen eine Antwort.
 * Archivierte Gruppen zaehlen wie im Kennzahlband des Moduls nicht mit.
 *
 * REIHENFOLGE: die Haushaltswaehrung zuerst, darin die groesste Position -
 * Betraege verschiedener Waehrungen lassen sich nicht der Groesse nach
 * vergleichen, und die Kachel nennt die erste.
 */
function openBalancesForUser(database, userId, { householdCurrency = 'EUR' } = {}) {
  const uid = Number(userId);
  const groups = database.prepare(`
    SELECT g.id, g.name
    FROM expense_groups g
    JOIN expense_group_members m ON m.group_id = g.id AND m.user_id = ?
    WHERE g.status = 'active'
    ORDER BY g.id
  `).all(uid);
  const netByCurrency = new Map();
  const positions = [];
  for (const group of groups) {
    const rows = groupBalanceRows(database, group.id);
    for (const row of rows) {
      if (row.user_id !== uid) continue;
      netByCurrency.set(row.currency, (netByCurrency.get(row.currency) ?? 0) + Number(row.net_minor));
    }
    for (const debt of simplifyDebts(rows)) {
      const owe = debt.from_user_id === uid;
      if (!owe && debt.to_user_id !== uid) continue;
      positions.push({
        direction: owe ? 'owe' : 'owed',
        userId: owe ? debt.to_user_id : debt.from_user_id,
        name: (owe ? debt.to_name : debt.from_name) ?? '',
        groupId: group.id,
        groupName: group.name,
        currency: debt.currency,
        amountMinor: debt.amount_minor,
        amount: debt.amount,
      });
    }
  }
  const home = (currency) => (currency === householdCurrency ? 0 : 1);
  positions.sort((a, b) => home(a.currency) - home(b.currency)
    || a.currency.localeCompare(b.currency)
    || b.amountMinor - a.amountMinor
    || a.groupId - b.groupId);
  const net = [...netByCurrency.entries()]
    .filter(([, minor]) => minor !== 0)
    .sort(([a], [b]) => home(a) - home(b) || a.localeCompare(b))
    .map(([currency, netMinor]) => ({ currency, netMinor, amount: minorToDecimal(netMinor, currency) }));
  return { net, positions };
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
  groupBalanceRows,
  minorToDecimal,
  openBalancesForUser,
  parseMoneyToMinor,
  simplifyDebts,
};
